/**
 * Shared contracts for durable event storage.
 *
 * This slice must not own a competing connection abstraction. The modules here
 * declare the narrowest structural surface they use, so they run against
 * `node:sqlite`'s DatabaseSync, a test double, or a future driver without importing
 * the connection factory or migration runner another branch owns
 * (ARCHITECTURE.md: packages/storage owns SQLite schema and atomic operations, and
 * must not own remote side effects inside transactions).
 */

import type { DomainError, Result } from '@shiploop/domain';

/** A value SQLite accepts as a bound parameter. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** One result row. Values stay untyped here because SQLite is a dynamic boundary. */
export type SqlRow = Readonly<Record<string, SqlValue>>;

export interface SqlStatement {
  all(...params: readonly SqlValue[]): readonly SqlRow[];
  get(...params: readonly SqlValue[]): SqlRow | undefined;
  run(...params: readonly SqlValue[]): { readonly changes: number | bigint };
}

export interface SqlConnection {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /**
   * Present on node:sqlite's DatabaseSync. Optional so a narrow double still
   * satisfies the type; the outbox uses it to refuse an enqueue that is not part
   * of a transaction, because an uncommitted effect is the N01-AC3 failure mode.
   */
  readonly isTransaction?: boolean;
}

/**
 * Runs work inside one transaction.
 *
 * Injectable because the owner of tx.ts decides how transactions are opened and
 * nested. The local default is deliberately minimal and exists so these modules are
 * usable before that runner lands.
 */
export type TransactionRunner = <T>(work: (tx: SqlConnection) => T) => T;

/**
 * Runs work in BEGIN IMMEDIATE / COMMIT, rolling back on any throw, unless the
 * caller already owns an open transaction.
 *
 * IMMEDIATE takes the write lock up front, so a caller that decides to write and
 * then writes inside one transaction cannot lose a race in between. Joining an
 * existing transaction instead of opening a nested one is what lets these stores
 * compose inside a caller's unit of work.
 */
export function runInTransaction<T>(connection: SqlConnection, work: (tx: SqlConnection) => T): T {
  if (connection.isTransaction === true) return work(connection);
  connection.exec('BEGIN IMMEDIATE');
  try {
    const value = work(connection);
    connection.exec('COMMIT');
    return value;
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

/** ISO-8601 instant. Provider timestamps are parsed at the boundary that accepts them. */
export type Instant = string;

export interface ExternalRef {
  /** Opaque provider-side identity, never a title or branch name. */
  readonly id: string;
  readonly kind: string;
  readonly url: string | null;
}

export interface InboxEvent {
  readonly eventId: string;
  readonly deliveryId: string;
  readonly provider: string;
  readonly type: string;
  /**
   * Identity of the subject the event is about (issue, candidate, delivery). Events
   * for one correlation id are compared against each other to keep the newest fact.
   */
  readonly correlationId: string;
  /** Provider-reported occurrence time; an older event can never revert a newer fact. */
  readonly occurredAt: Instant;
  /** When ShipLoop recorded the event, which is not the provider's clock. */
  readonly recordedAt: Instant;
  /** Monotonic ingest order, so a tie on occurredAt still has one defined winner. */
  readonly sequence: number;
  /** SHA-256 of the exact original bytes the signature was verified over (F30-AC1). */
  readonly payloadDigest: string;
  readonly payloadBytes: Uint8Array;
  readonly processedAt: Instant | null;
  /** Correlation id of the processing run, which is not the ingest correlation id. */
  readonly processedBy: string | null;
}

/** Provider error categories that change whether and when a retry is safe. */
export type FailureCategory =
  | 'None'
  | 'RateLimited'
  | 'Authentication'
  | 'PermissionDenied'
  | 'NotFound'
  | 'Conflict'
  | 'TransientProvider'
  | 'Validation'
  | 'OutcomeUnknown';

export type OutboxStatus = 'PendingSync' | 'Succeeded' | 'Failed' | 'OutcomeUnknown';

export interface OutboxEffect {
  readonly effectId: string;
  /** Deduplication key: enqueueing the same intent twice yields one effect (F29-AC4). */
  readonly dedupKey: string;
  readonly kind: string;
  readonly target: string;
  readonly payload: string;
  readonly correlationId: string;
  /** Links the effect to its ExternalOperation row so a retry reconciles by identity. */
  readonly operationId: string;
  readonly status: OutboxStatus;
  readonly attemptCount: number;
  /** When the target last reached the provider, never cleared by a later failure (F16-AC4). */
  readonly lastSuccessAt: Instant | null;
  readonly nextAttemptAt: Instant;
  readonly lastFailureCategory: FailureCategory;
  readonly lastFailureDetail: string | null;
  readonly lastAttemptAt: Instant | null;
  readonly expectedRefs: readonly ExternalRef[];
  /** Refs with a recorded external mapping; a partial publication keeps these (F10-AC2). */
  readonly succeededRefs: readonly ExternalRef[];
  readonly createdAt: Instant;
}

/**
 * Operation lifecycle.
 *
 * `IntentRecorded` means the intent is durable but no outcome is known, which is
 * indistinguishable from a lost response: the process may have died after the write
 * reached the provider. It is therefore treated as unresolved, not as permission to
 * write again (N01-AC2).
 */
export type OperationStatus = 'IntentRecorded' | 'Succeeded' | 'Failed' | 'OutcomeUnknown';

export interface ExternalOperation {
  readonly operationId: string;
  readonly kind: string;
  readonly target: string;
  readonly expectedRefs: readonly ExternalRef[];
  readonly correlationId: string;
  readonly status: OperationStatus;
  readonly recordedAt: Instant;
  readonly updatedAt: Instant;
  readonly outcomeAt: Instant | null;
  readonly outcomeDetail: string | null;
  readonly operationRef: string | null;
}

export type StorageResult<T> = Result<T, DomainError>;

/** Milliseconds to add to an instant, returned as an ISO-8601 instant. */
export function instantAfterMs(instant: Instant, delayMs: number): Instant {
  const base = Date.parse(instant);
  if (Number.isNaN(base)) {
    throw new Error(`Expected a parseable instant but received ${instant}`);
  }
  return new Date(base + delayMs).toISOString();
}

/** Reads one nullable text column, treating NULL and absent columns alike. */
export function optionalText(row: SqlRow, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

/**
 * Reads one text column the schema guarantees non-null.
 *
 * Throws because a schema/reader mismatch is a programming error, not an external
 * condition; letting it become null would write a corrupt fact.
 */
export function requiredText(row: SqlRow, column: string): string {
  const value = optionalText(row, column);
  if (value === null) throw new Error(`Expected text column ${column} to be present`);
  return value;
}

export function requiredNumber(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`Expected numeric column ${column} to be present`);
}

/** Reads a BLOB column as the exact bytes that were stored. */
export function blob(row: SqlRow, column: string): Uint8Array {
  const value = row[column];
  if (value instanceof Uint8Array) return value;
  throw new Error(`Expected blob column ${column} to be present`);
}

/** Parses a stored ref list, dropping entries that no longer match the ref shape. */
export function jsonArray(value: string): readonly ExternalRef[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is ExternalRef =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === 'string' &&
      typeof (entry as { kind?: unknown }).kind === 'string',
  );
}