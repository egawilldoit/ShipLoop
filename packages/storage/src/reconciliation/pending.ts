/**
 * The reconciliation worklist (F30-AC5, F28-AC4, F10-AC2/AC3/AC5, F16-AC4, N01-AC2).
 *
 * `events/operations.ts` owns the intent/outcome bracket around an external write and
 * the `assertWritable` gate in front of it. This module sits on top of that ledger and
 * answers the two questions the ledger alone cannot:
 *
 *   - what is still unresolved, and what exactly is unknown about it. A lost response
 *     and a write that never started look the same in a status column, so the worklist
 *     carries the operation identity, its kind, its target, the refs it expected to
 *     create and a sentence naming what could not be established (F30-AC5).
 *   - whether a retry is safe. It is not a matter of taste: while the outcome of a
 *     write that may already have reached the provider is unknown, issuing the write
 *     again creates a duplicate issue, pull request, deployment or receipt. Only a
 *     recorded resolution settles that, and an operation that was applied is settled as
 *     *done*, so the reconciliation is what a repeated publication request performs
 *     rather than what it skips (F10-AC3, F28-AC4, F29-AC4, N01-AC2).
 *
 * Nothing here retries anything. A worklist entry is a question for the owner or a
 * controller that has read current provider state; the module's only writes are the
 * resolutions a caller has already established.
 */

import { conflict, err, ok } from '@shiploop/domain';
import type { DomainError, Result } from '@shiploop/domain';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db.ts';
import { withTransaction } from '../tx.ts';
import type { ExternalRef, FailureCategory, Instant, OperationStatus } from '../events/types.ts';
import { instantAfterMs } from '../events/types.ts';

/**
 * How long an unresolved operation or a failing sync attempt stays off the worklist.
 *
 * Matches the ledger's own in-flight bound: a write that has not been answered within
 * the provider call timeout is a candidate for reconciliation, not for a retry. The
 * bound is the reason a worklist entry means something - a ten-second-old unknown is
 * still a write in flight.
 */
export const DEFAULT_RECONCILIATION_BOUND_MS = 60_000;

/**
 * One unresolved external effect, with the identity needed to reconcile it.
 *
 * `unknown` is a sentence rather than a status, because "what could not be
 * established" is the thing an owner has to act on: no outcome was recorded, or a
 * response was lost, or the provider refused the write. The refs are what a repeated
 * request must not create a second copy of.
 */
export interface PendingReconciliation {
  readonly operationId: string;
  readonly kind: string;
  readonly target: string;
  readonly expectedRefs: readonly ExternalRef[];
  /** What is not established about this write. */
  readonly unknown: string;
  readonly status: OperationStatus;
  readonly correlationId: string;
  readonly workItemId: string | null;
  /** When the write became unresolved; the bound is measured from here. */
  readonly unresolvedSince: Instant;
  /** Provider identity already recorded for it, if any. */
  readonly operationRef: string | null;
  /** Outbox effects waiting on this operation. */
  readonly effectIds: readonly string[];
}

/**
 * A resolution of an operation whose outcome was not established.
 *
 * `Applied` carries the provider identity that proves it, and the schema refuses the
 * row without one: "it worked" and "I assume it worked" must not be the same record,
 * because a retry on the second reading duplicates the external work (F28-AC4).
 *
 * `StillUnknown` records that reconciliation was attempted and still could not
 * establish the result. It is deliberately not a no-op: the fact that a human or a
 * controller looked and could not tell is itself worth keeping, and it leaves the
 * operation exactly as blocked as it was.
 */
export type ReconciliationResolution =
  | {
      readonly resolution: 'Applied';
      readonly providerIdentity: string;
      readonly detail: string | null;
      readonly resolvedBy: string;
      readonly resolvedAt: Instant;
      readonly correlationId: string | null;
    }
  | {
      readonly resolution: 'NotApplied' | 'StillUnknown';
      readonly detail: string;
      readonly resolvedBy: string;
      readonly resolvedAt: Instant;
      readonly correlationId: string | null;
    };

/** The recorded resolution, as it reads back out. */
export interface OperationResolutionRecord {
  readonly reconciliationResolutionId: string;
  readonly operationId: string;
  readonly workItemId: string | null;
  readonly resolution: 'Applied' | 'NotApplied' | 'StillUnknown';
  readonly providerIdentity: string | null;
  readonly detail: string | null;
  readonly resolvedBy: string;
  readonly resolvedAt: Instant;
  readonly correlationId: string | null;
}

/**
 * Why a retry is or is not permitted.
 *
 * The rule is one sentence: a retry is permitted only when the write provably did not
 * reach the provider, or when it is still genuinely in flight. `OutcomeUnknown` and
 * `AlreadyApplied` never permit one, and `AlreadyApplied` additionally says the work
 * is already done - a second write would be a duplicate (F10-AC3, F28-AC4).
 */
export type RetryDecision =
  | { readonly permitted: true; readonly basis: 'StillInFlight' | 'DefiniteNotApplied' }
  | {
      readonly permitted: false;
      readonly basis: 'AlreadyApplied' | 'OutcomeUnknown' | 'StaleIntent' | 'UnresolvedResolution';
      readonly providerIdentity: string | null;
      readonly unresolvedSince: Instant | null;
    };

/** The per-work-item sync label (F16-AC4). */
export interface WorkItemSyncStatus {
  readonly state: 'NeverAttempted' | 'InSync' | 'PendingSync' | 'Failed';
  readonly lastAttemptAt: Instant | null;
  readonly lastSuccessAt: Instant | null;
  readonly attemptCount: number;
  readonly lastError: string | null;
}

/** One external update attached to a work item, and what is still outstanding on it. */
export interface SyncStatusEntry {
  readonly effectId: string;
  readonly operationId: string;
  readonly kind: string;
  readonly target: string;
  /** The label the owner sees for this update. */
  readonly label: 'PendingSync' | 'OutcomeUnknown' | 'InSync';
  readonly lastSuccessAt: Instant | null;
  readonly lastAttemptAt: Instant | null;
  readonly nextAttemptAt: Instant;
  readonly attemptCount: number;
  readonly lastFailureCategory: FailureCategory;
  readonly lastFailureDetail: string | null;
  readonly expectedRefs: readonly ExternalRef[];
  /** Mappings that succeeded and are kept, so a retry cannot republish them (F10-AC5). */
  readonly succeededRefs: readonly ExternalRef[];
  /** Expected mappings with none recorded: what remains unpublished (F10-AC2). */
  readonly unpublishedRefs: readonly ExternalRef[];
}

export interface WorkItemSyncView {
  readonly workItem: WorkItemSyncStatus | null;
  readonly updates: readonly SyncStatusEntry[];
}

export interface PendingStoreOptions {
  /**
   * How long an unresolved effect stays off the worklist. Must exceed the provider
   * call timeout, for the same reason the ledger's in-flight bound must.
   */
  readonly boundMs?: number;
  readonly limit?: number;
}

function refsFrom(stored: string): readonly ExternalRef[] {
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed)) return [];
  const refs: ExternalRef[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { readonly id?: unknown; readonly kind?: unknown; readonly url?: unknown };
    if (typeof candidate.id !== 'string' || typeof candidate.kind !== 'string') continue;
    refs.push({ id: candidate.id, kind: candidate.kind, url: typeof candidate.url === 'string' ? candidate.url : null });
  }
  return refs;
}

function refKey(ref: ExternalRef): string {
  return `${ref.kind}:${ref.id}`;
}

function text(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`column ${column} is missing or not text`);
  return value;
}

function optional(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

function count(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`column ${column} is missing or not an integer`);
}

function notFound(entity: string, identity: string): DomainError {
  return { code: 'NotFound', reason: `${entity} ${identity} does not exist.` };
}

/**
 * The reconciliation worklist and the retry gate (F30-AC5, F28-AC4, F10-AC3, F16-AC4).
 *
 * Every statement is prepared and bound. The two writes - a resolution row and the
 * ledger status it settles - happen in one bounded transaction, so a crash between
 * them cannot leave a resolution recorded against an operation that still looks
 * unresolved, which is the state a retry would have to guess about (N01-AC3).
 */
export class PendingReconciliationStore {
  private readonly database: Database;
  private readonly boundMs: number;
  private readonly limit: number;

  constructor(database: Database, options: PendingStoreOptions = {}) {
    this.database = database;
    this.boundMs = options.boundMs ?? DEFAULT_RECONCILIATION_BOUND_MS;
    this.limit = options.limit ?? 50;
  }

  /**
   * Every external effect whose result is not established, oldest first (F30-AC5).
   *
   * Two sources, because an external write can be in doubt at either layer: an
   * `external_operations` row with a lost or missing outcome, and an `outbox_events`
   * row whose delivery did not complete. An effect whose operation is itself on the
   * list is skipped, because that is the same question asked twice and the operation
   * entry carries the richer identity. An effect whose operation has settled is still
   * listed: the ledger saying the write happened while the delivery says it did not
   * complete is a disagreement, and a disagreement is precisely what a worklist is for.
   */
  pendingReconciliation(now: Instant): readonly PendingReconciliation[] {
    const cutoff = instantAfterMs(now, -this.boundMs);
    const operations = this.database
      .prepare(
        `SELECT operation_id, kind, target_identity, expected_refs, status, state, correlation_id,
                work_item_id, unknown_since, updated_at, operation_ref, outcome_detail
           FROM external_operations
          WHERE (state = 'OutcomeUnknown' OR (status = 'IntentRecorded' AND updated_at <= ?))
            AND updated_at <= ?
          ORDER BY updated_at ASC
          LIMIT ?`,
      )
      .all(cutoff, now, this.limit)
      .map((row) => this.toPending(row));
    const effects = this.database
      .prepare(
        `SELECT e.outbox_event_id, e.operation_id, e.kind, e.target, e.expected_refs, e.status,
                e.last_failure_detail, e.last_attempt_at, e.updated_at, o.correlation_id, o.work_item_id
           FROM outbox_events e
           LEFT JOIN external_operations o ON o.operation_id = e.operation_id
          WHERE (e.status = 'OutcomeUnknown'
                 OR (e.status = 'PendingSync' AND e.last_attempt_at IS NOT NULL AND e.last_attempt_at <= ?))
            AND NOT EXISTS (
              SELECT 1 FROM external_operations already_listed
               WHERE already_listed.operation_id = e.operation_id
                 AND (already_listed.state = 'OutcomeUnknown'
                      OR (already_listed.status = 'IntentRecorded' AND already_listed.updated_at <= ?))
            )
          ORDER BY e.last_attempt_at ASC
          LIMIT ?`,
      )
      .all(cutoff, cutoff, this.limit)
      .map((row) => this.toPendingFromEffect(row));
    return [...operations, ...effects];
  }

  /**
   * Records what reconciliation established about an operation, and settles the ledger
   * to match (F28-AC4, F10-AC3, N01-AC2).
   *
   * The ledger status and the resolution row are written together, so an operation
   * cannot be `Succeeded` with no evidence of why. A settled operation is not re-settled
   * by a contradicting resolution: that is a conflict naming both facts, because
   * silently overwriting a recorded success is how a duplicate gets created.
   */
  recordResolution(operationId: string, resolution: ReconciliationResolution): Result<OperationResolutionRecord> {
    return this.attempt('record reconciliation resolution', () => {
      if (resolution.resolvedBy.trim().length === 0) {
        return err({
          code: 'Invalid',
          reason: 'A recorded resolution must name who established it.',
          fields: [{ path: 'resolvedBy', message: 'Must not be empty (F32-AC1).' }],
        });
      }
      if (resolution.resolution === 'Applied' && resolution.providerIdentity.trim().length === 0) {
        return err({
          code: 'Invalid',
          reason: 'An operation may only be recorded as applied with the provider identity that proves it.',
          fields: [{ path: 'providerIdentity', message: 'Must not be empty when the resolution is Applied.' }],
        });
      }
      return this.writeResolution(operationId, resolution);
    });
  }

  /**
   * Whether the operation may be written again (F28-AC4, F10-AC3).
   *
   * This is the gate a controller asks before issuing a second external write, and the
   * only two permitting answers are a write that is provably absent (`Failed`, or
   * resolved `NotApplied`) and one still in flight. An unresolved outcome, a stale
   * intent, and an operation already applied all refuse - the last because the work is
   * done and a second write is a duplicate.
   */
  retryDecision(operationId: string, now: Instant): Result<RetryDecision> {
    return this.attempt('decide whether a retry is permitted', () => {
      const row = this.database
        .prepare(
          'SELECT operation_id, state, status, updated_at, unknown_since, operation_ref, outcome_detail FROM external_operations WHERE operation_id = ?',
        )
        .get(operationId);
      if (row === undefined) return err(notFound('Operation', operationId));

      const state = text(row, 'state');
      const status = optional(row, 'status');
      const unresolvedSince = optional(row, 'unknown_since');
      const providerIdentity = optional(row, 'operation_ref');
      const refused = (
        basis: 'AlreadyApplied' | 'OutcomeUnknown' | 'StaleIntent' | 'UnresolvedResolution',
      ): Result<RetryDecision> =>
        ok({ permitted: false, basis, providerIdentity, unresolvedSince: unresolvedSince ?? optional(row, 'updated_at') });

      if (state === 'Succeeded') return refused('AlreadyApplied');

      // Checked before the state, because a resolution that learned nothing is the more
      // specific fact: the owner already looked, and a caller retrying on
      // 'OutcomeUnknown' alone would not know that.
      const lastResolution = this.database
        .prepare(
          `SELECT resolution FROM reconciliation_resolutions
             WHERE operation_id = ? ORDER BY resolved_at DESC, created_at DESC LIMIT 1`,
        )
        .get(operationId);
      if (lastResolution !== undefined && text(lastResolution, 'resolution') === 'StillUnknown') {
        return refused('UnresolvedResolution');
      }
      if (state === 'OutcomeUnknown') return refused('OutcomeUnknown');
      if (state === 'Failed') return ok({ permitted: true, basis: 'DefiniteNotApplied' });

      const cutoff = instantAfterMs(now, -this.boundMs);
      if (Date.parse(text(row, 'updated_at')) <= Date.parse(cutoff)) return refused('StaleIntent');
      if (status === 'IntentRecorded' || state === 'InFlight' || state === 'Planned') {
        return ok({ permitted: true, basis: 'StillInFlight' });
      }
      return refused('UnresolvedResolution');
    });
  }

  /** Resolutions recorded for an operation, oldest first. */
  listResolutions(operationId: string): Result<readonly OperationResolutionRecord[]> {
    return this.attempt('list reconciliation resolutions', () => {
      const rows = this.database
        .prepare(
          `SELECT reconciliation_resolution_id, operation_id, work_item_id, resolution, provider_identity,
                  detail, resolved_by, resolved_at, correlation_id
             FROM reconciliation_resolutions WHERE operation_id = ? ORDER BY resolved_at ASC, created_at ASC`,
        )
        .all(operationId);
      return ok(rows.map(toResolutionRecord));
    });
  }

  /**
   * The Pending sync view for one work item (F16-AC4, F10-AC2, F10-AC5).
   *
   * Two levels on purpose. The `work_item_syncs` row is the single label the owner
   * reads, with the last time anything succeeded. Each entry below it is one external
   * update with its own retry state, and it separates the mappings that succeeded from
   * the ones that did not, so a partial publication names exactly what is still
   * outstanding and a retry republishes only that (F10-AC2) without discarding the
   * mappings that already exist (F10-AC5).
   *
   * An update is found two ways, because the product has two links and uses them
   * differently: an effect that names its work item directly, and an effect belonging
   * to the operation a work item was published through. `createOutboxStore` and
   * `createOperationStore` do not bind a work item, so today only the publication
   * operation is reachable through them - recorded here rather than papered over, and
   * the query is written so the work-item link works the moment something binds it.
   */
  pendingSyncStatus(workItemId: string): Result<WorkItemSyncView> {
    return this.attempt('read pending sync status', () => {
      const syncRow = this.database
        .prepare(
          'SELECT work_item_id, state, last_attempt_at, last_success_at, attempt_count, last_error FROM work_item_syncs WHERE work_item_id = ?',
        )
        .get(workItemId);
      const workItem =
        syncRow === undefined
          ? null
          : {
              state: text(syncRow, 'state') as WorkItemSyncStatus['state'],
              lastAttemptAt: optional(syncRow, 'last_attempt_at'),
              lastSuccessAt: optional(syncRow, 'last_success_at'),
              attemptCount: count(syncRow, 'attempt_count'),
              lastError: optional(syncRow, 'last_error'),
            };
      const rows = this.database
        .prepare(
          `SELECT outbox_event_id, operation_id, kind, target, expected_refs, succeeded_refs, status,
                  last_success_at, last_attempt_at, next_attempt_at, attempt_count,
                  last_failure_category, last_failure_detail
             FROM outbox_events
            WHERE work_item_id = ?
               OR operation_id IN (
                    SELECT publication_operation_id FROM work_items
                     WHERE work_item_id = ? AND publication_operation_id IS NOT NULL
                 )
            ORDER BY next_attempt_at ASC, created_at ASC`,
        )
        .all(workItemId, workItemId);
      return ok({ workItem, updates: rows.map(toSyncStatusEntry) });
    });
  }

  private writeResolution(
    operationId: string,
    resolution: ReconciliationResolution,
  ): Result<OperationResolutionRecord> {
    return withTransaction(this.database, () => {
      const row = this.database
        .prepare(
          'SELECT state, settled_at, unknown_since, work_item_id FROM external_operations WHERE operation_id = ?',
        )
        .get(operationId);
      if (row === undefined) return err(notFound('Operation', operationId));
      const state = text(row, 'state');
      if (state === 'Succeeded' && resolution.resolution !== 'Applied') {
        return err(
          conflict(
            `Operation ${operationId} is already recorded as applied and cannot become ${resolution.resolution}`,
            'Applied',
            resolution.resolution,
          ),
        );
      }
      if (state === 'Failed' && resolution.resolution === 'Applied') {
        return err(
          conflict(
            `Operation ${operationId} is recorded as refused by the provider and cannot become applied`,
            'Failed',
            'Applied',
          ),
        );
      }

      const id = randomUUID();
      const providerIdentity =
        resolution.resolution === 'Applied'
          ? resolution.providerIdentity
          : this.database
              .prepare('SELECT operation_ref FROM external_operations WHERE operation_id = ?')
              .get(operationId)?.['operation_ref'] ?? null;
      this.database
        .prepare(
          `INSERT INTO reconciliation_resolutions (
             reconciliation_resolution_id, operation_id, work_item_id, resolution, provider_identity,
             detail, resolved_by, resolved_at, correlation_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          operationId,
          optional(row, 'work_item_id'),
          resolution.resolution,
          providerIdentity,
          resolution.detail,
          resolution.resolvedBy,
          resolution.resolvedAt,
          resolution.correlationId,
        );

      const settled = this.database
        .prepare(
          `UPDATE external_operations
              SET state = ?, status = ?, updated_at = ?, settled_at = ?, outcome_at = ?,
                  outcome_detail = ?, operation_ref = ?, unknown_since = ?
            WHERE operation_id = ?`,
        )
        .run(
          schemaStateFor(resolution.resolution),
          resolution.resolution === 'StillUnknown' ? 'OutcomeUnknown' : resolution.resolution,
          resolution.resolvedAt,
          resolution.resolution === 'StillUnknown' ? null : resolution.resolvedAt,
          resolution.resolvedAt,
          resolution.detail,
          providerIdentity,
          resolution.resolution === 'StillUnknown' ? resolution.resolvedAt : null,
          operationId,
        );
      if (Number(settled.changes) !== 1) {
        return err(notFound('Operation', operationId));
      }
      const created = this.database
        .prepare(
          `SELECT reconciliation_resolution_id, operation_id, work_item_id, resolution, provider_identity,
                  detail, resolved_by, resolved_at, correlation_id
             FROM reconciliation_resolutions WHERE reconciliation_resolution_id = ?`,
        )
        .get(id);
      if (created === undefined) return err(notFound('Reconciliation resolution', id));
      return ok(toResolutionRecord(created));
    });
  }

  /**
   * One unresolved `external_operations` row, read into a worklist entry.
   *
   * `unknown` distinguishes the two states a caller must act on differently: a lost
   * response (the provider may already have the write) and an intent with no outcome
   * yet (the same, plus the process may have died before answering). Neither is
   * permission to write again.
   */
  private toPending(row: Record<string, unknown>): PendingReconciliation {
    const state = text(row, 'state');
    const status = optional(row, 'status');
    const detail = optional(row, 'outcome_detail');
    const unknown =
      state === 'OutcomeUnknown'
        ? (detail ?? 'The response to this external write was never recorded, so whether it reached the provider is not established.')
        : 'An intent was recorded with no outcome, so this write may already have reached the provider.';
    const operationId = text(row, 'operation_id');
    return {
      operationId,
      kind: text(row, 'kind'),
      target: text(row, 'target_identity'),
      expectedRefs: refsFrom(optional(row, 'expected_refs') ?? '[]'),
      unknown,
      status: statusFor(state, status),
      correlationId: text(row, 'correlation_id'),
      workItemId: optional(row, 'work_item_id'),
      unresolvedSince: optional(row, 'unknown_since') ?? text(row, 'updated_at'),
      operationRef: optional(row, 'operation_ref'),
      effectIds: this.effectIdsFor(operationId),
    };
  }

  /**
   * One unresolved `outbox_events` row, read into a worklist entry.
   *
   * An effect carries its own identity and its own expected refs, so an update that
   * never reached the ledger at all is still reconcilable: the effect id is the
   * identity a caller reads the provider with.
   */
  private toPendingFromEffect(row: Record<string, unknown>): PendingReconciliation {
    const status = optional(row, 'status');
    const detail = optional(row, 'last_failure_detail');
    const operationId = text(row, 'operation_id');
    const effectId = text(row, 'outbox_event_id');
    return {
      operationId,
      kind: text(row, 'kind'),
      target: text(row, 'target'),
      expectedRefs: refsFrom(optional(row, 'expected_refs') ?? '[]'),
      unknown:
        status === 'OutcomeUnknown'
          ? (detail ?? 'The provider response for this update was lost, so the mapping is not established.')
          : (detail ?? 'This update has not completed, and the last attempt failed.'),
      status: status === 'OutcomeUnknown' ? 'OutcomeUnknown' : 'IntentRecorded',
      correlationId: optional(row, 'correlation_id') ?? effectId,
      workItemId: optional(row, 'work_item_id'),
      unresolvedSince: optional(row, 'last_attempt_at') ?? text(row, 'updated_at'),
      operationRef: null,
      effectIds: [effectId],
    };
  }

  /**
   * The outbox effects waiting on one operation, in the order they were enqueued.
   *
   * Read per entry rather than joined, because the worklist is bounded and a join would
   * multiply its rows. The worklist is for deciding what to reconcile, not for a report
   * over the whole ledger.
   */
  private effectIdsFor(operationId: string): readonly string[] {
    return this.database
      .prepare('SELECT outbox_event_id FROM outbox_events WHERE operation_id = ? ORDER BY created_at ASC')
      .all(operationId)
      .map((row) => text(row, 'outbox_event_id'));
  }

  private attempt<T>(description: string, body: () => Result<T, DomainError>): Result<T, DomainError> {
    try {
      return body();
    } catch (error) {
      return err({
        code: 'Unavailable',
        reason: `${description} failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

/**
 * The ledger state a resolution settles an operation to.
 *
 * `NotApplied` is `Failed` rather than a new state: a write established to have
 * reached nobody is a write the provider did not do, which is exactly what the ledger
 * already means by `Failed`, and a retry of it cannot duplicate anything. Introducing a
 * fourth settled state would make "the provider refused" and "reconciliation proved it
 * never landed" two things only one of which permits a retry.
 */
function schemaStateFor(resolution: 'Applied' | 'NotApplied' | 'StillUnknown'): string {
  if (resolution === 'Applied') return 'Succeeded';
  if (resolution === 'NotApplied') return 'Failed';
  return 'OutcomeUnknown';
}

/**
 * Reads the store's status back out of the schema's state column.
 * The worklist only ever holds unresolved rows, so every branch that reaches here is
 * either in flight or unknown; the function exists so the mapping from the schema's
 * five states to the ledger's four statuses is written once rather than at each call
 * site. `Planned` and `InFlight` are the same thing to a caller: an intent with no
 * outcome yet.
 */
function statusFor(state: string, status: string | null): OperationStatus {
  switch (state) {
    case 'Succeeded':
      return 'Succeeded';
    case 'Failed':
      return 'Failed';
    case 'OutcomeUnknown':
      return 'OutcomeUnknown';
    default:
      return status === 'IntentRecorded' || status === null ? 'IntentRecorded' : 'IntentRecorded';
  }
}

function toResolutionRecord(row: Record<string, unknown>): OperationResolutionRecord {
  const resolution = text(row, 'resolution');
  if (resolution !== 'Applied' && resolution !== 'NotApplied' && resolution !== 'StillUnknown') {
    throw new Error(`resolution ${resolution} is not a value this module records`);
  }
  return {
    reconciliationResolutionId: text(row, 'reconciliation_resolution_id'),
    operationId: text(row, 'operation_id'),
    workItemId: optional(row, 'work_item_id'),
    resolution,
    providerIdentity: optional(row, 'provider_identity'),
    detail: optional(row, 'detail'),
    resolvedBy: text(row, 'resolved_by'),
    resolvedAt: text(row, 'resolved_at'),
    correlationId: optional(row, 'correlation_id'),
  };
}

function toSyncStatusEntry(row: Record<string, unknown>): SyncStatusEntry {
  const status = optional(row, 'status');
  const expectedRefs = refsFrom(text(row, 'expected_refs'));
  const succeededRefs = refsFrom(text(row, 'succeeded_refs'));
  const mapped = new Set(succeededRefs.map(refKey));
  const label: SyncStatusEntry['label'] =
    status === 'OutcomeUnknown' ? 'OutcomeUnknown' : status === 'Succeeded' ? 'InSync' : 'PendingSync';
  return {
    effectId: text(row, 'outbox_event_id'),
    operationId: text(row, 'operation_id'),
    kind: text(row, 'kind'),
    target: text(row, 'target'),
    label,
    lastSuccessAt: optional(row, 'last_success_at'),
    lastAttemptAt: optional(row, 'last_attempt_at'),
    nextAttemptAt: text(row, 'next_attempt_at'),
    attemptCount: count(row, 'attempt_count'),
    lastFailureCategory: text(row, 'last_failure_category') as FailureCategory,
    lastFailureDetail: optional(row, 'last_failure_detail'),
    expectedRefs,
    succeededRefs,
    unpublishedRefs: expectedRefs.filter((ref) => !mapped.has(refKey(ref))),
  };
}
