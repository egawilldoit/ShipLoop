/**
 * Durable provider event ingest (F30-AC1, F30-AC2, F30-AC3, F13-AC5).
 *
 * Signature verification belongs to the transport adapter and runs over the ORIGINAL
 * request bytes, never over a re-serialized body. recordEvent receives that verdict
 * together with those exact bytes and stores both, so a recorded delivery can be
 * re-verified later without trusting a second report of what was signed (F30-AC1).
 *
 * recordEvent writes a fact and nothing else. It dispatches no coding work, because
 * an ordinary Linear update must not launch a job on its own; the recorded owner
 * start action is the only thing that may (F13-AC5). Its result tells the caller
 * whether the fact was new, a replay, or superseded, which is what stops a replayed
 * delivery id from producing a second job, comment, publication, merge or release
 * (F30-AC2) and stops an out-of-order event from reverting a newer fact (F30-AC3).
 */

import { createHash } from 'node:crypto';
import { err, ok } from '@shiploop/domain';
import type {
  InboxEvent,
  Instant,
  SqlConnection,
  SqlRow,
  StorageResult,
  TransactionRunner,
} from './types.ts';
import { blob, optionalText, requiredNumber, requiredText, runInTransaction } from './types.ts';

/**
 * DDL for the inbox, published so the migration owner composes it rather than
 * re-deriving a different column set.
 */
export const INBOX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS inbox_event (
  event_id        TEXT PRIMARY KEY,
  delivery_id     TEXT NOT NULL,
  provider        TEXT NOT NULL,
  type            TEXT NOT NULL,
  correlation_id  TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  occurred_at_ms  INTEGER NOT NULL,
  recorded_at     TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  payload_digest  TEXT NOT NULL,
  payload_bytes   BLOB NOT NULL,
  processed_at    TEXT,
  processed_by    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_event_delivery
  ON inbox_event (provider, delivery_id);
CREATE INDEX IF NOT EXISTS inbox_event_current
  ON inbox_event (provider, correlation_id, occurred_at_ms, sequence);
CREATE INDEX IF NOT EXISTS inbox_event_unprocessed
  ON inbox_event (processed_at, sequence);
`;

export interface RecordEventInput {
  readonly deliveryId: string;
  /** Verdict computed over `rawPayloadBytes`, never over a re-serialized body. */
  readonly signatureValid: boolean;
  readonly rawPayloadBytes: Uint8Array;
  readonly provider: string;
  readonly type: string;
  readonly occurredAt: Instant;
  /** Identity of the subject this event is about, used to keep the newest fact. */
  readonly correlationId: string;
}

export type RecordEventResult =
  /** New fact, and it is the newest one recorded for its correlation id. */
  | { readonly kind: 'Recorded'; readonly event: InboxEvent }
  /** This delivery id was already recorded; the stored row is returned unchanged. */
  | { readonly kind: 'Duplicate'; readonly event: InboxEvent }
  /**
   * Stored as evidence, but older than a fact already recorded for the same subject,
   * so no caller may apply it to current state (F30-AC3).
   */
  | { readonly kind: 'Superseded'; readonly event: InboxEvent; readonly currentEventId: string };

export interface InboxStore {
  /** Verifies nothing itself: it stores the caller's verdict and the bytes it covers. */
  recordEvent(input: RecordEventInput): StorageResult<RecordEventResult>;
  listUnprocessed(limit?: number): readonly InboxEvent[];
  markProcessed(eventId: string, correlationId: string, at: Instant): StorageResult<InboxEvent>;
  findByEvent(eventId: string): InboxEvent | null;
  /** The row a replayed delivery id already produced, if any. */
  findByDelivery(provider: string, deliveryId: string): InboxEvent | null;
  /** Newest recorded fact for one subject, which is the only one that may be applied. */
  currentFact(provider: string, correlationId: string): InboxEvent | null;
}

export interface InboxOptions {
  readonly connection: SqlConnection;
  readonly runInTransaction?: TransactionRunner;
  /** Wall clock used only for recorded_at; injectable so recorded time is testable. */
  readonly now?: () => Instant;
}

export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Stable event identity, so a replay of the same delivery maps to the same row. */
export function eventIdFor(provider: string, deliveryId: string): string {
  const material = `${provider}\n${deliveryId}`;
  return `evt_${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

function rowToEvent(row: SqlRow): InboxEvent {
  return {
    eventId: requiredText(row, 'event_id'),
    deliveryId: requiredText(row, 'delivery_id'),
    provider: requiredText(row, 'provider'),
    type: requiredText(row, 'type'),
    correlationId: requiredText(row, 'correlation_id'),
    occurredAt: requiredText(row, 'occurred_at'),
    recordedAt: requiredText(row, 'recorded_at'),
    sequence: requiredNumber(row, 'sequence'),
    payloadDigest: requiredText(row, 'payload_digest'),
    payloadBytes: blob(row, 'payload_bytes'),
    processedAt: optionalText(row, 'processed_at'),
    processedBy: optionalText(row, 'processed_by'),
  };
}

export function createInboxStore(options: InboxOptions): InboxStore {
  const { connection } = options;
  const inTransaction = options.runInTransaction ?? ((work) => runInTransaction(connection, work));
  const now = options.now ?? ((): Instant => new Date().toISOString());

  const selectByEventId = connection.prepare('SELECT * FROM inbox_event WHERE event_id = ?');
  const selectByDelivery = connection.prepare(
    'SELECT * FROM inbox_event WHERE provider = ? AND delivery_id = ?',
  );
  const selectCurrentFact = connection.prepare(
    `SELECT * FROM inbox_event
      WHERE provider = ? AND correlation_id = ?
      ORDER BY occurred_at_ms DESC, sequence DESC
      LIMIT 1`,
  );
  const selectNextSequence = connection.prepare(
    'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM inbox_event',
  );
  const insert = connection.prepare(
    `INSERT INTO inbox_event
       (event_id, delivery_id, provider, type, correlation_id, occurred_at, occurred_at_ms,
        recorded_at, sequence, payload_digest, payload_bytes, processed_at, processed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  );

  const recordEvent = (input: RecordEventInput): StorageResult<RecordEventResult> => {
    if (!input.signatureValid) {
      return err({
        code: 'Invalid',
        reason: `Delivery ${input.deliveryId} failed signature verification and was not recorded`,
        fields: [
          {
            path: 'signatureValid',
            message: 'Signature must be verified over the original payload bytes before ingest.',
          },
        ],
      });
    }
    const occurredAtMs = Date.parse(input.occurredAt);
    if (Number.isNaN(occurredAtMs)) {
      return err({
        code: 'Invalid',
        reason: `Delivery ${input.deliveryId} carries an unparseable occurredAt`,
        fields: [{ path: 'occurredAt', message: 'Must be an ISO-8601 instant.' }],
      });
    }
    if (input.deliveryId.length === 0) {
      return err({
        code: 'Invalid',
        reason: 'A provider delivery without a delivery id cannot be deduplicated',
        fields: [{ path: 'deliveryId', message: 'Must not be empty (F30-AC2).' }],
      });
    }
    return inTransaction(() => {
      const seen = selectByDelivery.get(input.provider, input.deliveryId);
      if (seen !== undefined) {
        return ok({ kind: 'Duplicate', event: rowToEvent(seen) });
      }
      const recordedAt = now();
      const eventId = eventIdFor(input.provider, input.deliveryId);
      const sequenceRow = selectNextSequence.get();
      if (sequenceRow === undefined) throw new Error('Inbox ingest sequence could not be read');
      const sequence = requiredNumber(sequenceRow, 'next_sequence');
      insert.run(
        eventId,
        input.deliveryId,
        input.provider,
        input.type,
        input.correlationId,
        input.occurredAt,
        occurredAtMs,
        recordedAt,
        sequence,
        digestOf(input.rawPayloadBytes),
        input.rawPayloadBytes,
      );
      const recorded = selectByEventId.get(eventId);
      if (recorded === undefined) throw new Error(`Inbox event ${eventId} was not readable after insert`);
      const event = rowToEvent(recorded);
      const current = selectCurrentFact.get(input.provider, input.correlationId);
      if (current !== undefined && current['event_id'] !== eventId) {
        return ok({ kind: 'Superseded', event, currentEventId: requiredText(current, 'event_id') });
      }
      return ok({ kind: 'Recorded', event });
    });
  };

  const listUnprocessed = (limit = 100): readonly InboxEvent[] =>
    connection
      .prepare('SELECT * FROM inbox_event WHERE processed_at IS NULL ORDER BY sequence ASC LIMIT ?')
      .all(limit)
      .map(rowToEvent);

  /**
   * Records that an event was processed, together with the correlation id of that
   * processing run.
   *
   * Idempotent and separate from the ingest correlation id: a replay of the same event
   * is not re-applied, and the id that explains who handled it survives the update.
   */
  const markProcessed = (eventId: string, correlationId: string, at: Instant): StorageResult<InboxEvent> =>
    inTransaction(() => {
      const existing = selectByEventId.get(eventId);
      if (existing === undefined) {
        return err({ code: 'NotFound', reason: `Inbox event ${eventId} is not recorded` });
      }
      if (optionalText(existing, 'processed_at') === null) {
        connection
          .prepare('UPDATE inbox_event SET processed_at = ?, processed_by = ? WHERE event_id = ?')
          .run(at, correlationId, eventId);
      }
      const updated = selectByEventId.get(eventId);
      if (updated === undefined) throw new Error(`Inbox event ${eventId} disappeared while marking processed`);
      return ok(rowToEvent(updated));
    });

  const findByEvent = (eventId: string): InboxEvent | null => {
    const row = selectByEventId.get(eventId);
    return row === undefined ? null : rowToEvent(row);
  };

  const findByDelivery = (provider: string, deliveryId: string): InboxEvent | null => {
    const row = selectByDelivery.get(provider, deliveryId);
    return row === undefined ? null : rowToEvent(row);
  };

  const currentFact = (provider: string, correlationId: string): InboxEvent | null => {
    const row = selectCurrentFact.get(provider, correlationId);
    return row === undefined ? null : rowToEvent(row);
  };

  return {
    recordEvent,
    listUnprocessed,
    markProcessed,
    findByEvent,
    findByDelivery,
    currentFact,
  };
}

/**
 * Whether an event may be applied to current state for its subject (F30-AC3).
 *
 * Providers deliver out of order, so an event that occurred earlier than one already
 * recorded must never revert the newer fact. Ingest order breaks ties on identical
 * timestamps so exactly one event wins deterministically.
 */
export function isSuperseded(candidate: InboxEvent, current: InboxEvent | null): boolean {
  if (current === null) return false;
  if (current.eventId === candidate.eventId) return false;
  const candidateMs = Date.parse(candidate.occurredAt);
  const currentMs = Date.parse(current.occurredAt);
  if (candidateMs !== currentMs) return candidateMs < currentMs;
  return candidate.sequence < current.sequence;
}