/**
 * The transactional outbox (N01-AC3, F16-AC4, F30-AC4, F10-AC2, F10-AC5, F29-AC4).
 *
 * A managed external update is enqueued in the SAME transaction as the local state
 * change that justified it. Either both commit or neither does, so a crash cannot leave
 * an acknowledged job missing from the durable store, and a rolled back transaction can
 * never leave an effect nobody asked for (N01-AC3). enqueue therefore refuses to write
 * outside a transaction instead of trusting the caller to remember.
 *
 * Outbox rows never contain provider credentials and never perform remote calls.
 * Delivery is the controller's job; this module only decides what is due, what the last
 * observed failure category was, and which external mappings are still missing
 * (ARCHITECTURE.md: storage must not own remote side effects inside transactions).
 */

import { err, ok } from '@shiploop/domain';
import type {
  ExternalRef,
  FailureCategory,
  Instant,
  OutboxEffect,
  OutboxStatus,
  SqlConnection,
  SqlRow,
  StorageResult,
  TransactionRunner,
} from './types.ts';
import { instantAfterMs, jsonArray, optionalText, requiredNumber, requiredText, runInTransaction } from './types.ts';

/**
 * DDL for the outbox, published so the migration owner composes it rather than
 * re-deriving a different column set.
 */
/**
 * The columns this store depends on are owned by `migrations.ts`; this module
 * creates nothing, so a drift between the store and the schema is a failing
 * statement rather than a test that passed against a table the product does
 * not have.
 */
export interface EnqueueEffect {
  readonly effectId: string;
  /** Stable intent identity. Re-enqueueing the same key returns the existing effect. */
  readonly dedupKey: string;
  readonly kind: string;
  readonly target: string;
  /** Opaque JSON payload for the adapter; never a credential or a live connection. */
  readonly payload: string;
  readonly correlationId: string;
  /** Links the effect to its ExternalOperation row so a retry reconciles by identity. */
  readonly operationId: string;
  /** External identities this effect is responsible for creating (F10-AC2). */
  readonly expectedRefs: readonly ExternalRef[];
  readonly at: Instant;
  /** Earliest attempt time; defaults to `at`, so an effect is due immediately. */
  readonly nextAttemptAt?: Instant;
}

export interface FailureReason {
  readonly category: FailureCategory;
  readonly detail: string;
  /** Provider-supplied backoff, honoured over the computed one (F30-AC4). */
  readonly retryAfterMs?: number;
}

export interface SuccessResult {
  readonly at: Instant;
  /** External mappings obtained this time; earlier mappings are kept (F10-AC5). */
  readonly refs: readonly ExternalRef[];
}

/** Bounded exponential backoff: 5s, 15s, 45s, 135s, then held at 5 minutes. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CEILING_MS = 300_000;

export function backoffForAttempt(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(BACKOFF_BASE_MS * 3 ** exponent, BACKOFF_CEILING_MS);
}

export interface OutboxStore {
  /**
   * Must run inside the caller's transaction, because the local state change that
   * justified the effect commits or rolls back with it. A repeated dedup key returns
   * the existing effect rather than a second one.
   */
  enqueue(effect: EnqueueEffect): StorageResult<{ readonly effect: OutboxEffect; readonly created: boolean }>;
  /** Effects that are due, oldest first. OutcomeUnknown is never due: it awaits reconciliation. */
  due(now: Instant, limit?: number): readonly OutboxEffect[];
  markAttempt(effectId: string, at: Instant): StorageResult<OutboxEffect>;
  /**
   * Records the external mappings obtained. The effect becomes Succeeded only once
   * every expected ref is mapped, so a partial publication stays Pending sync and
   * names exactly what remains (F10-AC2).
   */
  markSucceeded(effectId: string, result: SuccessResult): StorageResult<OutboxEffect>;
  /** Keeps the effect Pending sync with its last success time and next retry (F16-AC4). */
  markFailed(effectId: string, reason: FailureReason, at: Instant): StorageResult<OutboxEffect>;
  /**
   * Records that a response was lost. The effect leaves the due set and can only leave
   * this state through an operation-ledger reconciliation (F28-AC4, F30-AC5).
   */
  markOutcomeUnknown(effectId: string, detail: string, at: Instant): StorageResult<OutboxEffect>;
  /** Pending sync view: what failed, when it last succeeded, and the next retry (F16-AC4). */
  pendingSync(limit?: number): readonly OutboxEffect[];
  findByDedupKey(dedupKey: string): OutboxEffect | null;
  findByOperation(operationId: string): readonly OutboxEffect[];
  /** Expected refs with no recorded external mapping yet (F10-AC2). */
  unpublishedRefs(effectId: string): readonly ExternalRef[];
}

export interface OutboxOptions {
  readonly connection: SqlConnection;
  readonly runInTransaction?: TransactionRunner;
}

/**
 * The schema's own effect state, which is the publication half of the story.
 *
 * The store's `status` is what the delivery loop reasons about; the schema's
 * `state` is what the durable index reads, and a succeeded effect must carry its
 * publish time so a half-written publication is distinguishable from a
 * published one (N01-AC3).
 */
function schemaStateFor(status: OutboxStatus): string {
  switch (status) {
    case 'Succeeded':
      return 'Published';
    case 'OutcomeUnknown':
      return 'OutcomeUnknown';
    default:
      return 'Pending';
  }
}

/** Reads the store's status back out of the schema's state column. */
function statusFrom(state: string | null): OutboxStatus {
  switch (state) {
    case 'Published':
      return 'Succeeded';
    case 'OutcomeUnknown':
      return 'OutcomeUnknown';
    default:
      return 'PendingSync';
  }
}

function rowToEffect(row: SqlRow): OutboxEffect {
  return {
    effectId: requiredText(row, 'outbox_event_id'),
    dedupKey: requiredText(row, 'dedup_key'),
    kind: requiredText(row, 'event_kind'),
    target: requiredText(row, 'target'),
    payload: requiredText(row, 'payload_json'),
    correlationId: requiredText(row, 'correlation_id'),
    operationId: requiredText(row, 'operation_id'),
    status: statusFrom(optionalText(row, 'state')),
    attemptCount: requiredNumber(row, 'attempt_count'),
    lastSuccessAt: optionalText(row, 'last_success_at'),
    nextAttemptAt: requiredText(row, 'next_attempt_at'),
    lastFailureCategory: requiredText(row, 'last_failure_category') as FailureCategory,
    lastFailureDetail: optionalText(row, 'last_error_redacted'),
    lastAttemptAt: optionalText(row, 'last_attempt_at'),
    expectedRefs: jsonArray(requiredText(row, 'expected_refs')),
    succeededRefs: jsonArray(requiredText(row, 'succeeded_refs')),
    createdAt: requiredText(row, 'created_at'),
  };
}

/** Appends newly mapped refs without dropping earlier ones, so retry loses nothing (F10-AC5). */
function mergeRefs(existing: readonly ExternalRef[], added: readonly ExternalRef[]): readonly ExternalRef[] {
  const seen = new Set(existing.map((ref) => `${ref.kind}:${ref.id}`));
  const merged = [...existing];
  for (const ref of added) {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return merged;
}

function refKey(ref: ExternalRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function createOutboxStore(options: OutboxOptions): OutboxStore {
  const { connection } = options;
  const inTransaction = options.runInTransaction ?? ((work) => runInTransaction(connection, work));

  const selectById = connection.prepare('SELECT * FROM outbox_events WHERE outbox_event_id = ?');
  const selectByDedup = connection.prepare('SELECT * FROM outbox_events WHERE dedup_key = ?');
  const insert = connection.prepare(
    `INSERT INTO outbox_events
       (outbox_event_id, dedup_key, event_kind, kind, target, payload_json, payload, correlation_id,
        operation_id, state, status, attempt_count, last_success_at, next_attempt_at,
        last_failure_category, last_failure_detail, last_attempt_at, expected_refs, succeeded_refs, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'PendingSync', 0, NULL, ?, 'None', NULL, NULL, ?, '[]', ?)`,
  );
  const updateStatus = connection.prepare(
    `UPDATE outbox_events
        SET state = ?, status = ?, last_success_at = ?, next_attempt_at = ?, last_failure_category = ?,
            last_failure_detail = ?, succeeded_refs = ?, published_at = ?, last_error_redacted = ?
      WHERE outbox_event_id = ?`,
  );

  const enqueue = (
    effect: EnqueueEffect,
  ): StorageResult<{ readonly effect: OutboxEffect; readonly created: boolean }> => {
    if (connection.isTransaction !== true) {
      return err({
        code: 'Conflict',
        reason: `Outbox effect ${effect.effectId} was enqueued outside a transaction`,
        expected: 'enqueue inside the transaction that writes the justifying local state',
        actual: 'no open transaction',
      });
    }
    const existing = selectByDedup.get(effect.dedupKey);
    if (existing !== undefined) {
      return ok({ effect: rowToEffect(existing), created: false });
    }
    insert.run(
      effect.effectId,
      effect.dedupKey,
      effect.kind,
      effect.kind,
      effect.target,
      effect.payload,
      effect.payload,
      effect.correlationId,
      effect.operationId,
      effect.nextAttemptAt ?? effect.at,
      JSON.stringify(effect.expectedRefs),
      effect.at,
    );
    const stored = selectById.get(effect.effectId);
    if (stored === undefined) throw new Error(`Outbox effect ${effect.effectId} was not readable after insert`);
    return ok({ effect: rowToEffect(stored), created: true });
  };

  const due = (now: Instant, limit = 25): readonly OutboxEffect[] =>
    connection
      .prepare(
        `SELECT * FROM outbox_events
          WHERE status = 'PendingSync' AND next_attempt_at <= ?
          ORDER BY next_attempt_at ASC, created_at ASC LIMIT ?`,
      )
      .all(now, limit)
      .map(rowToEffect);

  /**
   * Loads one effect for a state change and refuses the two states another write must
   * not resume from: Succeeded (the external work is done and completed) and
   * OutcomeUnknown (a lost response only reconciliation can resolve, F28-AC4/F30-AC5).
   */
  const loadForChange = (
    effectId: string,
  ): StorageResult<{ readonly effect: OutboxEffect }> => {
    const row = selectById.get(effectId);
    if (row === undefined) {
      return err({ code: 'NotFound', reason: `Outbox effect ${effectId} is not recorded` });
    }
    const effect = rowToEffect(row);
    if (effect.status === 'OutcomeUnknown') {
      return err({
        code: 'OutcomeUnknown',
        reason: `Outbox effect ${effectId} has an unresolved outcome; reconcile it before another attempt`,
        operationId: effect.operationId,
        target: effect.target,
      });
    }
    if (effect.status === 'Succeeded') {
      return err({
        code: 'Conflict',
        reason: `Outbox effect ${effectId} already completed and cannot be attempted again`,
        expected: 'an effect that has not completed',
        actual: 'Succeeded',
      });
    }
    return ok({ effect });
  };

  const readBack = (effectId: string): OutboxEffect => {
    const row = selectById.get(effectId);
    if (row === undefined) throw new Error(`Outbox effect ${effectId} disappeared while updating`);
    return rowToEffect(row);
  };

  const update = (effectId: string, apply: (effect: OutboxEffect) => OutboxEffect): StorageResult<OutboxEffect> =>
    inTransaction(() => {
      const loaded = loadForChange(effectId);
      if (!loaded.ok) return loaded;
      const next = apply(loaded.value.effect);
      updateStatus.run(
        schemaStateFor(next.status),
        next.status,
        next.lastSuccessAt,
        next.nextAttemptAt,
        next.lastFailureCategory,
        next.lastFailureDetail,
        JSON.stringify(next.succeededRefs),
        next.status === 'Succeeded' ? next.lastSuccessAt : null,
        next.lastFailureDetail,
        effectId,
      );
      return ok(readBack(effectId));
    });

  const markAttempt = (effectId: string, at: Instant): StorageResult<OutboxEffect> =>
    inTransaction(() => {
      const loaded = loadForChange(effectId);
      if (!loaded.ok) return loaded;
      const { effect } = loaded.value;
      connection
        .prepare('UPDATE outbox_events SET attempt_count = ?, last_attempt_at = ? WHERE outbox_event_id = ?')
        .run(effect.attemptCount + 1, at, effectId);
      return ok(readBack(effectId));
    });

  const markSucceeded = (effectId: string, result: SuccessResult): StorageResult<OutboxEffect> =>
    update(effectId, (effect) => {
      const succeededRefs = mergeRefs(effect.succeededRefs, result.refs);
      const complete = effect.expectedRefs.every((ref) =>
        succeededRefs.some((mapped) => refKey(mapped) === refKey(ref)),
      );
      return {
        ...effect,
        status: complete ? 'Succeeded' : 'PendingSync',
        lastSuccessAt: result.at,
        nextAttemptAt: result.at,
        lastFailureCategory: complete ? 'None' : effect.lastFailureCategory,
        lastFailureDetail: complete ? null : effect.lastFailureDetail,
        succeededRefs,
      };
    });

  const markFailed = (effectId: string, reason: FailureReason, at: Instant): StorageResult<OutboxEffect> =>
    update(effectId, (effect) => ({
      ...effect,
      status: 'PendingSync',
      nextAttemptAt: instantAfterMs(at, reason.retryAfterMs ?? backoffForAttempt(Math.max(1, effect.attemptCount))),
      lastFailureCategory: reason.category,
      lastFailureDetail: reason.detail,
    }));

  const markOutcomeUnknown = (effectId: string, detail: string, at: Instant): StorageResult<OutboxEffect> =>
    update(effectId, (effect) => ({
      ...effect,
      status: 'OutcomeUnknown',
      lastFailureCategory: 'OutcomeUnknown',
      lastFailureDetail: detail,
      lastAttemptAt: at,
    }));

  const pendingSync = (limit = 100): readonly OutboxEffect[] =>
    connection
      .prepare(`SELECT * FROM outbox_events WHERE status <> 'Succeeded' ORDER BY next_attempt_at ASC LIMIT ?`)
      .all(limit)
      .map(rowToEffect);

  const findByDedupKey = (dedupKey: string): OutboxEffect | null => {
    const row = selectByDedup.get(dedupKey);
    return row === undefined ? null : rowToEffect(row);
  };

  const findByOperation = (operationId: string): readonly OutboxEffect[] =>
    connection
      .prepare('SELECT * FROM outbox_events WHERE operation_id = ? ORDER BY created_at ASC')
      .all(operationId)
      .map(rowToEffect);

  const unpublishedRefs = (effectId: string): readonly ExternalRef[] => {
    const row = selectById.get(effectId);
    if (row === undefined) return [];
    const effect = rowToEffect(row);
    const mapped = new Set(effect.succeededRefs.map(refKey));
    return effect.expectedRefs.filter((ref) => !mapped.has(refKey(ref)));
  };

  return {
    enqueue,
    due,
    markAttempt,
    markSucceeded,
    markFailed,
    markOutcomeUnknown,
    pendingSync,
    findByDedupKey,
    findByOperation,
    unpublishedRefs,
  };
}