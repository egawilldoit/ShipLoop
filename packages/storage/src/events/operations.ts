/**
 * The external side-effect ledger (F30-AC5, F10-AC3, F19-AC3, F26-AC3, F28-AC4, F29-AC4, N01-AC2).
 *
 * Every external write is bracketed by an intent row written BEFORE the call and an
 * outcome row written after it. That bracket is the whole anti-duplication story: when
 * a response is lost the outcome becomes OutcomeUnknown, and the next attempt with the
 * same operation identity finds that row instead of issuing a second write. Retries
 * therefore reconcile existing external work (F10-AC3, F19-AC3, F26-AC3, F28-AC4) rather
 * than creating duplicate issues, PRs, merges, deployments or receipts (F29-AC4).
 *
 * Two outcomes block a repeat write for good: Succeeded (the work is already done) and
 * OutcomeUnknown (a lost response only reconciliation can resolve). A bare IntentRecorded
 * is the write currently in flight, so it permits its own attempt and blocks a LATER one
 * once it is older than the in-flight bound: past that point the process may have died
 * between issuing the write and recording its response, which N01-AC2 injects on purpose.
 * Only a definite Failed outcome means the provider refused the write, so a retry of it
 * cannot duplicate anything.
 *
 * The bound must exceed the provider call timeout. A caller whose HTTP client times out
 * records OutcomeUnknown, which is unambiguous at any age.
 */

import { conflict, err, ok, outcomeUnknown } from '@shiploop/domain';
import type { DomainError } from '@shiploop/domain';
import type {
  ExternalOperation,
  ExternalRef,
  Instant,
  OperationStatus,
  SqlConnection,
  SqlRow,
  StorageResult,
  TransactionRunner,
} from './types.ts';
import { instantAfterMs, jsonArray, optionalText, requiredText, runInTransaction } from './types.ts';

/**
 * DDL for the operation ledger, published so the migration owner composes it rather
 * than re-deriving a different column set.
 */
export const OPERATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS external_operation (
  operation_id   TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  target         TEXT NOT NULL,
  expected_refs  TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  status         TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  outcome_at     TEXT,
  outcome_detail TEXT,
  operation_ref  TEXT
);
CREATE INDEX IF NOT EXISTS external_operation_pending
  ON external_operation (status, updated_at);
CREATE INDEX IF NOT EXISTS external_operation_target
  ON external_operation (kind, target);
`;

export interface RecordIntentInput {
  /** Stable identity of this external write; reused by every retry of it. */
  readonly operationId: string;
  readonly kind: string;
  /** Opaque provider-side identity of what is being written. */
  readonly target: string;
  /** Refs the write expects to observe, used to detect that the world moved (F26-AC2). */
  readonly expectedRefs: readonly ExternalRef[];
  readonly correlationId: string;
  readonly at: Instant;
}

export type OperationOutcome =
  | {
      readonly status: 'Succeeded';
      readonly at: Instant;
      readonly detail?: string;
      /** Provider identity of what was created, for a later retry to reconcile against. */
      readonly operationRef?: string;
    }
  | { readonly status: 'Failed'; readonly at: Instant; readonly detail: string }
  | { readonly status: 'OutcomeUnknown'; readonly at: Instant; readonly detail: string };

export interface ExternalOperationStore {
  /**
   * Writes the intent before the provider call. A repeat intent for an unresolved
   * operation is refused, so the caller reconciles instead of writing again.
   */
  recordIntent(input: RecordIntentInput): StorageResult<ExternalOperation>;
  /**
   * The last gate before the provider call. Returns OutcomeUnknown for an operation
   * whose result is not established, which is what makes zero second writes testable.
   * `now` decides whether an unrecorded intent is still in flight.
   */
  assertWritable(operationId: string, now: Instant): StorageResult<ExternalOperation>;
  recordOutcome(operationId: string, outcome: OperationOutcome): StorageResult<ExternalOperation>;
  findByOperation(operationId: string): ExternalOperation | null;
  findByTarget(kind: string, target: string): readonly ExternalOperation[];
  /**
   * Operations whose result is unresolved at or before `now`, oldest first. These are
   * the reconciler's worklist; nothing retries them automatically.
   */
  pendingReconciliation(now: Instant, limit?: number): readonly ExternalOperation[];
  /** True when an unrecorded intent has sat longer than the in-flight bound. */
  isStaleIntent(operation: ExternalOperation, now: Instant): boolean;
}

export interface OperationStoreOptions {
  readonly connection: SqlConnection;
  readonly runInTransaction?: TransactionRunner;
  /**
   * How long an intent without an outcome is still considered in flight. Must exceed
   * the provider call timeout; default 60s.
   */
  readonly inFlightBoundMs?: number;
}

export const DEFAULT_IN_FLIGHT_BOUND_MS = 60_000;

function rowToOperation(row: SqlRow): ExternalOperation {
  return {
    operationId: requiredText(row, 'operation_id'),
    kind: requiredText(row, 'kind'),
    target: requiredText(row, 'target'),
    expectedRefs: jsonArray(requiredText(row, 'expected_refs')),
    correlationId: requiredText(row, 'correlation_id'),
    status: requiredText(row, 'status') as OperationStatus,
    recordedAt: requiredText(row, 'recorded_at'),
    updatedAt: requiredText(row, 'updated_at'),
    outcomeAt: optionalText(row, 'outcome_at'),
    outcomeDetail: optionalText(row, 'outcome_detail'),
    operationRef: optionalText(row, 'operation_ref'),
  };
}

function missingIntent(operationId: string): DomainError {
  return { code: 'NotFound', reason: `Operation ${operationId} has no recorded intent` };
}

export function createOperationStore(options: OperationStoreOptions): ExternalOperationStore {
  const { connection } = options;
  const inTransaction = options.runInTransaction ?? ((work) => runInTransaction(connection, work));
  const inFlightBoundMs = options.inFlightBoundMs ?? DEFAULT_IN_FLIGHT_BOUND_MS;

  const selectById = connection.prepare('SELECT * FROM external_operation WHERE operation_id = ?');
  const insert = connection.prepare(
    `INSERT INTO external_operation
       (operation_id, kind, target, expected_refs, correlation_id, status, recorded_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'IntentRecorded', ?, ?)`,
  );

  const select = (operationId: string): ExternalOperation | null => {
    const row = selectById.get(operationId);
    return row === undefined ? null : rowToOperation(row);
  };

  const isStaleIntent = (operation: ExternalOperation, now: Instant): boolean => {
    if (operation.status !== 'IntentRecorded') return false;
    const cutoff = Date.parse(instantAfterMs(now, -inFlightBoundMs));
    return Date.parse(operation.updatedAt) <= cutoff;
  };

  const completedOperation = (operation: ExternalOperation): DomainError =>
    conflict(
      `Operation ${operation.operationId} already succeeded and must not be written again`,
      'an external write with no established result',
      'Succeeded',
    );

  const unresolvedOperation = (operation: ExternalOperation, detail: string): DomainError =>
    outcomeUnknown(
      `Operation ${operation.operationId} ${detail}`,
      operation.operationId,
      operation.target,
    );

  /** Outcomes that are settled for good: the write is done, or its result is unknown. */
  const terminalRefusal = (operation: ExternalOperation): DomainError | null => {
    if (operation.status === 'Succeeded') return completedOperation(operation);
    if (operation.status === 'OutcomeUnknown') {
      return unresolvedOperation(
        operation,
        'has an unresolved outcome; reconcile it against provider state before writing again',
      );
    }
    return null;
  };

  /**
   * Everything a caller must satisfy before a provider call.
   *
   * Reaching the provider twice creates a duplicate external fact, so a stale intent is
   * treated exactly like a lost response: the write stops and reconciliation takes over.
   */
  const refusalFor = (operation: ExternalOperation, now: Instant): DomainError | null => {
    const terminal = terminalRefusal(operation);
    if (terminal !== null) return terminal;
    if (isStaleIntent(operation, now)) {
      return unresolvedOperation(
        operation,
        `recorded an intent with no outcome for over ${inFlightBoundMs}ms, so the write may already have reached the provider; reconcile it`,
      );
    }
    return null;
  };

  const recordIntent = (input: RecordIntentInput): StorageResult<ExternalOperation> =>
    inTransaction(() => {
      if (input.operationId.length === 0) {
        return err({
          code: 'Invalid',
          reason: 'An external write without an operation identity cannot be deduplicated',
          fields: [{ path: 'operationId', message: 'Must not be empty (F30-AC5).' }],
        });
      }
      const existing = select(input.operationId);
      if (existing !== null) {
        if (existing.kind !== input.kind || existing.target !== input.target) {
          return err(
            conflict(
              `Operation id ${input.operationId} already describes a different action`,
              `${input.kind} ${input.target}`,
              `${existing.kind} ${existing.target}`,
            ),
          );
        }
        const terminal = terminalRefusal(existing);
        return terminal === null ? ok(existing) : err(terminal);
      }
      insert.run(
        input.operationId,
        input.kind,
        input.target,
        JSON.stringify(input.expectedRefs),
        input.correlationId,
        input.at,
        input.at,
      );
      const recorded = select(input.operationId);
      if (recorded === null) throw new Error(`Operation ${input.operationId} was not readable after insert`);
      return ok(recorded);
    });

  const assertWritable = (operationId: string, now: Instant): StorageResult<ExternalOperation> => {
    const existing = select(operationId);
    if (existing === null) {
      return err(missingIntent(operationId));
    }
    const refusal = refusalFor(existing, now);
    return refusal === null ? ok(existing) : err(refusal);
  };

  const recordOutcome = (operationId: string, outcome: OperationOutcome): StorageResult<ExternalOperation> =>
    inTransaction(() => {
      const existing = select(operationId);
      if (existing === null) {
        return err(missingIntent(operationId));
      }
      if (existing.status === 'Succeeded' && outcome.status !== 'Succeeded') {
        return err(
          conflict(
            `Operation ${operationId} already succeeded and cannot become ${outcome.status}`,
            'Succeeded',
            outcome.status,
          ),
        );
      }
      const operationRef =
        outcome.status === 'Succeeded' ? (outcome.operationRef ?? existing.operationRef) : existing.operationRef;
      connection
        .prepare(
          `UPDATE external_operation
              SET status = ?, updated_at = ?, outcome_at = ?, outcome_detail = ?, operation_ref = ?
            WHERE operation_id = ?`,
        )
        .run(outcome.status, outcome.at, outcome.at, outcome.detail ?? null, operationRef, operationId);
      const updated = select(operationId);
      if (updated === null) throw new Error(`Operation ${operationId} disappeared during the outcome update`);
      return ok(updated);
    });

  const findByOperation = (operationId: string): ExternalOperation | null => select(operationId);

  const findByTarget = (kind: string, target: string): readonly ExternalOperation[] =>
    connection
      .prepare('SELECT * FROM external_operation WHERE kind = ? AND target = ? ORDER BY recorded_at ASC')
      .all(kind, target)
      .map(rowToOperation);

  const unresolvedBefore = (now: Instant): Instant => instantAfterMs(now, -inFlightBoundMs);

  const pendingReconciliation = (now: Instant, limit = 50): readonly ExternalOperation[] =>
    connection
      .prepare(
        `SELECT * FROM external_operation
          WHERE (status = 'OutcomeUnknown' OR (status = 'IntentRecorded' AND updated_at <= ?))
            AND updated_at <= ?
          ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(unresolvedBefore(now), now, limit)
      .map(rowToOperation);

  return {
    recordIntent,
    assertWritable,
    recordOutcome,
    findByOperation,
    findByTarget,
    pendingReconciliation,
    isStaleIntent,
  };
}