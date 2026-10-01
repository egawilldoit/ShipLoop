/**
 * Scope capture, diffing and owner reconciliation (F12, F10-AC2/AC3/AC5, F16-AC4, F29-AC4).
 *
 * Linear owns published scope, so a run captures the issue content when it starts and
 * compares against live content later. Everything that makes that comparison trustworthy
 * lives here:
 *
 *   - the semantic fingerprint is computed by `@shiploop/domain` from the material
 *     content and is never accepted from a caller, so a cosmetic edit cannot change it
 *     and a hand-written fingerprint cannot be stored (F12-AC1, F12-AC3);
 *   - a material difference is a durable record, not a transient value, because it is
 *     what blocks acceptance until the owner has chosen (F12-AC2);
 *   - the owner's choice is a separate append-only fact with an actor and a time, so
 *     "ShipLoop believes the scope changed" and "a person decided what that means"
 *     cannot be confused or rewritten (F12-AC4);
 *   - a synchronisation that would push content the provider no longer has is refused
 *     and recorded instead, and an external `Done` is never read as release
 *     confirmation (F12-AC5, F29-AC4).
 *
 * No method here performs a remote call. Live content is fetched by the controller and
 * handed in as a `ScopeSnapshot`; this layer decides what it means and records it, so
 * nothing holds the single global write lock across a network round trip
 * (ARCHITECTURE, "Authority and durable state").
 */

import { randomUUID } from 'node:crypto';
import { canonicalize, compareScope, conflict, err, invalid, ok } from '@shiploop/domain';
import type {
  DomainError,
  Fingerprint,
  ProjectId,
  Result,
  ScopeChangeKind,
  ScopeComparison,
  ScopeReconciliation,
  ScopeReconciliationChoice,
  ScopeSnapshot,
  ScopeSnapshotId,
  WorkItemId,
} from '@shiploop/domain';
import type { Database } from '../db.ts';
import type { ExternalRef } from '../events/types.ts';
import { withTransaction } from '../tx.ts';
import { WorkItemRepository } from './core.ts';
import type {
  AppendScopeSnapshotInput,
  ScopeSnapshotCriterion,
  ScopeSnapshotRecord,
  SqlRow,
  WorkItemStore,
} from './types.ts';

/**
 * The reconciliation vocabulary, kept here so the schema CHECK and the value the
 * repository writes are checked against the same list rather than two hand-written
 * copies of the domain's union. The order is the domain's declaration order.
 */
const RECONCILIATION_CHOICES: readonly ScopeReconciliationChoice[] = [
  'AdoptRevisedScope',
  'KeepPendingClarification',
  'ProposeFollowUpIssue',
];

const CHANGE_KINDS: readonly ScopeChangeKind[] = ['Material', 'Cosmetic', 'Unchanged'];

/** A detected difference between what was recorded and what the provider now holds. */
export interface ScopeChangeDetection {
  readonly scopeChangeDetectionId: string;
  readonly workItemId: WorkItemId;
  readonly recordedSnapshotId: ScopeSnapshotId;
  readonly changeKind: ScopeChangeKind;
  readonly materialDifferences: readonly string[];
  readonly cosmeticDifferences: readonly string[];
  readonly recordedFingerprint: Fingerprint;
  readonly currentFingerprint: Fingerprint;
  readonly observedProviderRevision: string | null;
  readonly observedAt: string;
  readonly correlationId: string | null;
}

/** The owner's recorded choice about one detected difference (F12-AC4). */
export interface ScopeReconciliationRecord {
  readonly scopeReconciliationId: string;
  readonly workItemId: WorkItemId;
  readonly scopeChangeDetectionId: string;
  readonly recordedSnapshotId: ScopeSnapshotId;
  readonly choice: ScopeReconciliationChoice;
  readonly followUpNote: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly correlationId: string | null;
}

/** Why a synchronisation was refused, and what it would have published (F12-AC5). */
export interface SyncDiscrepancy {
  readonly discrepancyId: string;
  readonly workItemId: WorkItemId;
  readonly outboxEventId: string | null;
  readonly operationId: string | null;
  readonly kind: SyncDiscrepancyKind;
  readonly observedStatus: string | null;
  readonly refusedAction: string;
  readonly detail: string;
  /** Expected refs with no mapping: what is still unpublished (F10-AC2). */
  readonly unpublishedRefs: readonly ExternalRef[];
  /** Mappings that did succeed, kept so a retry cannot republish them (F10-AC5). */
  readonly succeededRefs: readonly ExternalRef[];
  readonly recordedAt: string;
  readonly correlationId: string | null;
}

export type SyncDiscrepancyKind =
  | 'StaleContentRefused'
  | 'ExternalStatusWithoutReleaseEvidence'
  | 'PartialPublication';

export interface RecordSyncAttemptInput {
  readonly workItemId: WorkItemId;
  /**
   * The content the provider held when the attempt read it, or null when the attempt
   * published without re-reading scope. It is the comparison that decides staleness.
   */
  readonly liveScope: ScopeSnapshot | null;
  /** The provider's own status word. Never a ShipLoop fact (F12-AC5, F29-AC5). */
  readonly providerStatus: string | null;
  readonly outboxEventId: string | null;
  readonly operationId: string | null;
  readonly expectedRefs: readonly ExternalRef[];
  readonly succeededRefs: readonly ExternalRef[];
  readonly attemptedAt: string;
  readonly correlationId: string | null;
}

/**
 * What a synchronisation attempt turned out to be.
 *
 * `Accepted` means there was nothing to flag. Every other outcome carries the durable
 * discrepancy that records it, so a refusal is always inspectable afterwards and never
 * only a log line that a retry has already overwritten.
 */
export type SyncAttemptVerdict =
  | { readonly outcome: 'Accepted'; readonly discrepancy: null }
  | {
      readonly outcome: 'RefusedStaleContent' | 'ExternalStatusWithoutReleaseEvidence' | 'PartialPublication';
      readonly discrepancy: SyncDiscrepancy;
    };

export interface RecordComparisonInput {
  readonly workItemId: WorkItemId;
  readonly comparison: ScopeComparison;
  readonly observedAt: string;
  readonly providerRevision: string | null;
  readonly correlationId: string | null;
}

const SNAPSHOT_COLUMNS =
  'scope_snapshot_id, work_item_id, sequence_number, attempt_id, issue_id, issue_identifier, title, description, provider_revision, priority, dependency_issue_ids, acceptance_criteria, retrieved_at, scope_fingerprint, profile_version_id, procedure_version_id, captured_at, correlation_id';

const DETECTION_COLUMNS =
  'scope_change_detection_id, work_item_id, recorded_snapshot_id, change_kind, material_differences, cosmetic_differences, recorded_fingerprint, current_fingerprint, observed_provider_revision, observed_at, correlation_id';

const RECONCILIATION_COLUMNS =
  'scope_reconciliation_id, work_item_id, scope_change_detection_id, recorded_snapshot_id, choice, follow_up_note, decided_by, decided_at, correlation_id';

const DISCREPANCY_COLUMNS =
  'discrepancy_id, work_item_id, outbox_event_id, operation_id, kind, observed_status, refused_action, detail, unpublished_refs, succeeded_refs, recorded_at, correlation_id';

function newId(): string {
  return randomUUID();
}

function notFound(entity: string, identity: string): DomainError {
  return { code: 'NotFound', reason: `${entity} ${identity} does not exist.` };
}

function requiredText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`column ${column} is missing or not text`);
  return value;
}

function optionalText(row: SqlRow, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

function requiredInteger(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`column ${column} is missing or not an integer`);
}

function parseJson<T>(row: SqlRow, column: string): T {
  return JSON.parse(requiredText(row, column)) as T;
}

function stringList(row: SqlRow, column: string): readonly string[] {
  const stored = parseJson<unknown>(row, column);
  if (!Array.isArray(stored)) throw new Error(`column ${column} is not a JSON array`);
  for (const entry of stored) {
    if (typeof entry !== 'string') throw new Error(`column ${column} holds a non-text entry`);
  }
  return stored as readonly string[];
}

function refList(row: SqlRow, column: string): readonly ExternalRef[] {
  const stored = parseJson<unknown>(row, column);
  if (!Array.isArray(stored)) throw new Error(`column ${column} is not a JSON array`);
  const refs: ExternalRef[] = [];
  for (const entry of stored) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`column ${column} holds a non-object entry`);
    }
    const candidate = entry as { readonly id?: unknown; readonly kind?: unknown; readonly url?: unknown };
    if (typeof candidate.id !== 'string' || typeof candidate.kind !== 'string') {
      throw new Error(`column ${column} holds an entry without an id and a kind`);
    }
    refs.push({ id: candidate.id, kind: candidate.kind, url: typeof candidate.url === 'string' ? candidate.url : null });
  }
  return refs;
}

function refKey(ref: ExternalRef): string {
  return `${ref.kind}:${ref.id}`;
}

function toSnapshotRecord(row: SqlRow): ScopeSnapshotRecord {
  return {
    scopeSnapshotId: requiredText(row, 'scope_snapshot_id') as ScopeSnapshotId,
    workItemId: requiredText(row, 'work_item_id') as WorkItemId,
    sequenceNumber: requiredInteger(row, 'sequence_number'),
    attemptId: optionalText(row, 'attempt_id') as ScopeSnapshotRecord['attemptId'],
    issueId: requiredText(row, 'issue_id'),
    issueIdentifier: requiredText(row, 'issue_identifier'),
    title: requiredText(row, 'title'),
    description: requiredText(row, 'description'),
    providerRevision: optionalText(row, 'provider_revision'),
    priority: optionalText(row, 'priority'),
    dependencyIssueIds: stringList(row, 'dependency_issue_ids'),
    acceptanceCriteria: parseJson<readonly ScopeSnapshotCriterion[]>(row, 'acceptance_criteria'),
    retrievedAt: requiredText(row, 'retrieved_at'),
    scopeFingerprint: requiredText(row, 'scope_fingerprint') as Fingerprint,
    profileVersionId: requiredText(row, 'profile_version_id') as ScopeSnapshotRecord['profileVersionId'],
    procedureVersionId: requiredText(row, 'procedure_version_id'),
    capturedAt: requiredText(row, 'captured_at'),
    correlationId: optionalText(row, 'correlation_id'),
  };
}

/**
 * Rebuilds the domain snapshot a stored record represents.
 *
 * This is the only path from a row to a comparison, so a stored snapshot and a live
 * one are compared through identical shapes. `providerRevision` is the provider's own
 * revision when it supplied one; when it did not, the fingerprint of the recorded
 * content stands in, because the comparison needs a stable identity for the belief and
 * an absent provider revision is not one.
 */
function toDomainSnapshot(record: ScopeSnapshotRecord): ScopeSnapshot {
  return {
    workItemId: record.workItemId,
    issueId: record.issueId,
    issueIdentifier: record.issueIdentifier,
    title: record.title,
    description: record.description,
    providerRevision: record.providerRevision,
    priority: record.priority,
    dependencyIssueIds: record.dependencyIssueIds,
    acceptanceCriteria: record.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
    })),
    retrievedAt: record.retrievedAt,
  };
}

function toDetection(row: SqlRow): ScopeChangeDetection {
  const kind = requiredText(row, 'change_kind');
  if (!CHANGE_KINDS.includes(kind as ScopeChangeKind)) {
    throw new Error(`change_kind ${kind} is not a value the domain recognises`);
  }
  return {
    scopeChangeDetectionId: requiredText(row, 'scope_change_detection_id'),
    workItemId: requiredText(row, 'work_item_id') as WorkItemId,
    recordedSnapshotId: requiredText(row, 'recorded_snapshot_id') as ScopeSnapshotId,
    changeKind: kind as ScopeChangeKind,
    materialDifferences: stringList(row, 'material_differences'),
    cosmeticDifferences: stringList(row, 'cosmetic_differences'),
    recordedFingerprint: requiredText(row, 'recorded_fingerprint') as Fingerprint,
    currentFingerprint: requiredText(row, 'current_fingerprint') as Fingerprint,
    observedProviderRevision: optionalText(row, 'observed_provider_revision'),
    observedAt: requiredText(row, 'observed_at'),
    correlationId: optionalText(row, 'correlation_id'),
  };
}

function toReconciliation(row: SqlRow): ScopeReconciliationRecord {
  const choice = requiredText(row, 'choice');
  if (!RECONCILIATION_CHOICES.includes(choice as ScopeReconciliationChoice)) {
    throw new Error(`choice ${choice} is not a value the domain recognises`);
  }
  return {
    scopeReconciliationId: requiredText(row, 'scope_reconciliation_id'),
    workItemId: requiredText(row, 'work_item_id') as WorkItemId,
    scopeChangeDetectionId: requiredText(row, 'scope_change_detection_id'),
    recordedSnapshotId: requiredText(row, 'recorded_snapshot_id') as ScopeSnapshotId,
    choice: choice as ScopeReconciliationChoice,
    followUpNote: optionalText(row, 'follow_up_note'),
    decidedBy: requiredText(row, 'decided_by'),
    decidedAt: requiredText(row, 'decided_at'),
    correlationId: optionalText(row, 'correlation_id'),
  };
}

function toDiscrepancy(row: SqlRow): SyncDiscrepancy {
  return {
    discrepancyId: requiredText(row, 'discrepancy_id'),
    workItemId: requiredText(row, 'work_item_id') as WorkItemId,
    outboxEventId: optionalText(row, 'outbox_event_id'),
    operationId: optionalText(row, 'operation_id'),
    kind: requiredText(row, 'kind') as SyncDiscrepancyKind,
    observedStatus: optionalText(row, 'observed_status'),
    refusedAction: requiredText(row, 'refused_action'),
    detail: requiredText(row, 'detail'),
    unpublishedRefs: refList(row, 'unpublished_refs'),
    succeededRefs: refList(row, 'succeeded_refs'),
    recordedAt: requiredText(row, 'recorded_at'),
    correlationId: optionalText(row, 'correlation_id'),
  };
}

/**
 * Durable scope capture, diffing and reconciliation.
 *
 * Constructed over a real `Database` because the bounded transactions come from
 * `tx.ts`, which owns BEGIN/COMMIT, savepoint nesting and the busy answer. The
 * `WorkItemRepository` it composes with is built here, against the same connection and
 * the same transaction runner, because a capture and its criteria index have to land in
 * one transaction: a repository opening its own `BEGIN IMMEDIATE` inside the open one
 * would fail, so the two must share the transaction this class starts. That is not a
 * parameter, because injecting a store with a different runner would break the property
 * the class exists to provide.
 */
export class ScopeRepository {
  private readonly database: Database;
  private readonly workItems: WorkItemStore;

  constructor(database: Database) {
    this.database = database;
    this.workItems = new WorkItemRepository(database, {
      transaction: (body) => withTransaction(database, body),
    });
  }

  /**
   * Records the scope a run is starting from (F12-AC1).
   *
   * The parent row is written by `WorkItemRepository.appendScopeSnapshot`, which owns
   * the fingerprint computation, and the per-criterion and per-dependency rows are
   * written here in the same transaction. Both representations hold the same facts: the
   * JSON columns are what the reader in `core.ts` returns, and the child tables are
   * what gives each criterion a stable, individually addressable id. Duplicate ids
   * inside one snapshot are refused rather than silently collapsed, because a snapshot
   * whose two representations disagree is exactly the defect a duplicated table
   * invites.
   */
  capture(input: AppendScopeSnapshotInput): Result<ScopeSnapshotRecord> {
    return this.attempt('capture scope snapshot', () => {
      const criteria = input.scope.acceptanceCriteria;
      const seenCriteria = new Set<string>();
      for (const criterion of criteria) {
        if (seenCriteria.has(criterion.id)) {
          return err(
            invalid('A scope snapshot cannot hold the same acceptance criterion twice.', [
              { path: 'scope.acceptanceCriteria', message: `Criterion ${criterion.id} appears more than once.` },
            ]),
          );
        }
        seenCriteria.add(criterion.id);
      }
      const seenDependencies = new Set<string>();
      for (const dependency of input.scope.dependencyIssueIds) {
        if (seenDependencies.has(dependency)) {
          return err(
            invalid('A scope snapshot cannot depend on the same issue twice.', [
              {
                path: 'scope.dependencyIssueIds',
                message: `Dependency ${dependency} appears more than once.`,
              },
            ]),
          );
        }
        seenDependencies.add(dependency);
      }

      return withTransaction(this.database, () => {
        const appended = this.workItems.appendScopeSnapshot(input);
        if (!appended.ok) return appended;
        const stored = appended.value;
        for (const criterion of criteria) {
          this.database
            .prepare(
              'INSERT INTO scope_snapshot_criteria (scope_snapshot_id, criterion_id, text) VALUES (?, ?, ?)',
            )
            .run(stored.scopeSnapshotId, criterion.id, criterion.text);
        }
        for (const dependency of input.scope.dependencyIssueIds) {
          this.database
            .prepare(
              'INSERT INTO scope_snapshot_dependencies (scope_snapshot_id, dependency_issue_id) VALUES (?, ?)',
            )
            .run(stored.scopeSnapshotId, dependency);
        }
        const reloaded = this.readSnapshot(stored.scopeSnapshotId);
        if (!reloaded.ok) return reloaded;
        return ok(reloaded.value);
      });
    });
  }

  /**
   * Classifies live provider content against the newest recorded snapshot (F12-AC2).
   *
   * The recorded side is read from storage and never recomputed, so the comparison
   * reports the belief ShipLoop actually held rather than one reconstructed from
   * current content. A title or priority edit is `Cosmetic` and changes no
   * fingerprint, so it cannot restart coding or invalidate a decision keyed on the
   * fingerprint (F12-AC3).
   */
  compareStoredToLive(workItemId: WorkItemId, live: ScopeSnapshot): Result<ScopeComparison> {
    return this.attempt('compare recorded scope to live scope', () => {
      if (live.workItemId !== workItemId) {
        return err(
          invalid('The live scope names a different work item than the one being compared.', [
            { path: 'live.workItemId', message: `Expected ${workItemId}, received ${live.workItemId}.` },
          ]),
        );
      }
      const recorded = this.latestSnapshotRow(workItemId);
      if (recorded === undefined) {
        return err(notFound('Scope snapshot for work item', workItemId));
      }
      return ok(compareScope(toDomainSnapshot(toSnapshotRecord(recorded)), live));
    });
  }

  /**
   * Records a detected difference so it outlives the request that found it (F12-AC2).
   *
   * A repeated check of the same live content against the same recorded snapshot is
   * the same difference, so the unique index returns the existing row rather than a
   * growing list of identical claims.
   */
  recordComparison(input: RecordComparisonInput): Result<ScopeChangeDetection> {
    return this.attempt('record scope comparison', () => {
      if (!CHANGE_KINDS.includes(input.comparison.kind)) {
        return err(
          invalid('A scope comparison must carry a change kind the domain recognises.', [
            { path: 'comparison.kind', message: `Received ${input.comparison.kind}.` },
          ]),
        );
      }
      const project = this.projectForWorkItem(input.workItemId);
      if (project === undefined) return err(notFound('Work item', input.workItemId));
      const recorded = this.latestSnapshotRow(input.workItemId);
      if (recorded === undefined) return err(notFound('Scope snapshot for work item', input.workItemId));
      const snapshotId = requiredText(recorded, 'scope_snapshot_id');
      if (requiredText(recorded, 'scope_fingerprint') !== input.comparison.recordedFingerprint) {
        return err(
          conflict(
            `The comparison was made against fingerprint ${input.comparison.recordedFingerprint}, which is not what work item ${input.workItemId} recorded`,
            requiredText(recorded, 'scope_fingerprint'),
            input.comparison.recordedFingerprint,
          ),
        );
      }
      return withTransaction(this.database, () => {
        const existing = this.database
          .prepare(
            `SELECT ${DETECTION_COLUMNS} FROM scope_change_detections
               WHERE recorded_snapshot_id = ? AND current_fingerprint = ?`,
          )
          .get(snapshotId, input.comparison.currentFingerprint);
        if (existing !== undefined) return ok(toDetection(existing));

        const detectionId = newId();
        this.database
          .prepare(
            `INSERT INTO scope_change_detections (
               scope_change_detection_id, work_item_id, project_id, recorded_snapshot_id, change_kind,
               material_differences, cosmetic_differences, recorded_fingerprint, current_fingerprint,
               observed_provider_revision, observed_at, correlation_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            detectionId,
            input.workItemId,
            project,
            snapshotId,
            input.comparison.kind,
            canonicalize(input.comparison.materialDifferences),
            canonicalize(input.comparison.cosmeticDifferences),
            input.comparison.recordedFingerprint,
            input.comparison.currentFingerprint,
            input.providerRevision,
            input.observedAt,
            input.correlationId,
          );
        const created = this.database
          .prepare(`SELECT ${DETECTION_COLUMNS} FROM scope_change_detections WHERE scope_change_detection_id = ?`)
          .get(detectionId);
        if (created === undefined) return err(notFound('Scope change detection', detectionId));
        return ok(toDetection(created));
      });
    });
  }

  /**
   * Records the owner's choice about a detected difference (F12-AC4).
   *
   * A cosmetic or unchanged comparison is refused outright: there is nothing to
   * reconcile, and a record saying an owner decided something about a priority edit
   * would imply work was stopped for it (F12-AC3). The difference being decided must
   * already have been recorded, so the blocking state and the decision refer to the
   * same row rather than two things that happen to agree. The same difference may only
   * be decided once; a change of mind is recorded by comparing again, which produces a
   * new difference row.
   */
  recordReconciliation(
    workItemId: WorkItemId,
    reconciliation: ScopeReconciliation,
    correlationId: string | null = null,
  ): Result<ScopeReconciliationRecord> {
    return this.attempt('record scope reconciliation', () => {
      if (reconciliation.comparison.kind !== 'Material') {
        return err(
          invalid('Only a material scope change can be reconciled; a cosmetic change has nothing to decide.', [
            {
              path: 'reconciliation.comparison.kind',
              message: `Received ${reconciliation.comparison.kind}.`,
            },
          ]),
        );
      }
      if (reconciliation.decidedBy.trim().length === 0) {
        return err(
          invalid('A recorded reconciliation must name the owner who decided it.', [
            { path: 'reconciliation.decidedBy', message: 'Must not be empty.' },
          ]),
        );
      }
      if (!RECONCILIATION_CHOICES.includes(reconciliation.choice)) {
        return err(
          invalid('A recorded reconciliation must carry a choice the domain recognises.', [
            { path: 'reconciliation.choice', message: `Received ${String(reconciliation.choice)}.` },
          ]),
        );
      }
      const project = this.projectForWorkItem(workItemId);
      if (project === undefined) return err(notFound('Work item', workItemId));
      const recorded = this.snapshotByFingerprint(workItemId, reconciliation.comparison.recordedFingerprint);
      if (recorded === undefined) {
        return err(
          conflict(
            `Work item ${workItemId} recorded no scope with fingerprint ${reconciliation.comparison.recordedFingerprint}`,
            'a recorded scope snapshot',
            reconciliation.comparison.recordedFingerprint,
          ),
        );
      }
      const snapshotId = requiredText(recorded, 'scope_snapshot_id');
      const detection = this.database
        .prepare(
          `SELECT ${DETECTION_COLUMNS} FROM scope_change_detections
             WHERE recorded_snapshot_id = ? AND current_fingerprint = ?`,
        )
        .get(snapshotId, reconciliation.comparison.currentFingerprint);
      if (detection === undefined) {
        return err(
          conflict(
            `The change to ${reconciliation.comparison.currentFingerprint} was never recorded as a difference`,
            'a recorded scope change detection',
            reconciliation.comparison.currentFingerprint,
          ),
        );
      }
      const detectionId = requiredText(detection, 'scope_change_detection_id');
      const decided = this.database
        .prepare(`SELECT ${RECONCILIATION_COLUMNS} FROM scope_reconciliations WHERE scope_change_detection_id = ?`)
        .get(detectionId);
      if (decided !== undefined) {
        return err(
          conflict(
            `Difference ${detectionId} was already reconciled as ${requiredText(decided, 'choice')}`,
            'an unreconciled difference',
            requiredText(decided, 'choice'),
          ),
        );
      }
      return withTransaction(this.database, () => {
        const reconciliationId = newId();
        this.database
          .prepare(
            `INSERT INTO scope_reconciliations (
               scope_reconciliation_id, work_item_id, project_id, scope_change_detection_id,
               recorded_snapshot_id, choice, follow_up_note, decided_by, decided_at, correlation_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            reconciliationId,
            workItemId,
            project,
            detectionId,
            snapshotId,
            reconciliation.choice,
            reconciliation.followUpNote,
            reconciliation.decidedBy,
            reconciliation.decidedAt,
            correlationId,
          );
        const created = this.database
          .prepare(`SELECT ${RECONCILIATION_COLUMNS} FROM scope_reconciliations WHERE scope_reconciliation_id = ?`)
          .get(reconciliationId);
        if (created === undefined) return err(notFound('Scope reconciliation', reconciliationId));
        return ok(toReconciliation(created));
      });
    });
  }

  /**
   * The material difference that still blocks acceptance and delivery, if any
   * (F12-AC2).
   *
   * The newest recorded difference for the work item is the one that matters: a
   * difference the owner has already reconciled is not a block, and an older
   * unreconciled difference is superseded by whatever they looked at since. A cosmetic
   * difference never appears here, which is what keeps a priority edit from stalling
   * bounded work (F12-AC3).
   */
  unreconciledMaterialChange(workItemId: WorkItemId): Result<ScopeChangeDetection | null> {
    return this.attempt('read the unreconciled material change', () => {
      const row = this.database
        .prepare(
          `SELECT ${DETECTION_COLUMNS} FROM scope_change_detections
             WHERE work_item_id = ? AND change_kind = 'Material'
               AND NOT EXISTS (
                 SELECT 1 FROM scope_reconciliations r
                  WHERE r.scope_change_detection_id = scope_change_detections.scope_change_detection_id
               )
             ORDER BY observed_at DESC, created_at DESC LIMIT 1`,
        )
        .get(workItemId);
      return ok(row === undefined ? null : toDetection(row));
    });
  }

  listReconciliations(workItemId: WorkItemId): Result<readonly ScopeReconciliationRecord[]> {
    return this.attempt('list scope reconciliations', () => {
      const rows = this.database
        .prepare(
          `SELECT ${RECONCILIATION_COLUMNS} FROM scope_reconciliations
             WHERE work_item_id = ? ORDER BY decided_at ASC, created_at ASC`,
        )
        .all(workItemId);
      return ok(rows.map(toReconciliation));
    });
  }

  /**
   * Decides what a synchronisation attempt was, and records a discrepancy when it was
   * not a clean one (F12-AC5, F29-AC4, F10-AC2, F10-AC5).
   *
   * Three things are refused, in this order:
   *
   *   1. Stale content. If the content the provider holds no longer matches what was
   *      recorded, the attempt is computed from a belief that is out of date, and
   *      publishing it would restore an older description over a manual edit. The
   *      difference is recorded instead of pushed.
   *   2. An external `Done` with no local release evidence. The provider's status word
   *      is preserved as observed, and nothing is confirmed: ShipLoop neither claims
   *      the work shipped nor touches the human's issue.
   *   3. A partial publication. What is still unpublished is named beside the
   *      mappings that did succeed, so the retry republishes only the missing ones.
   *
   * The unresolved ref lists are carried on every discrepancy row, including the
   * refusals, so one row answers "what did this attempt do not achieve" regardless of
   * why it stopped.
   */
  recordSyncAttempt(input: RecordSyncAttemptInput): Result<SyncAttemptVerdict> {
    return this.attempt('record synchronisation attempt', () => {
      const project = this.projectForWorkItem(input.workItemId);
      if (project === undefined) return err(notFound('Work item', input.workItemId));
      const recorded = this.latestSnapshotRow(input.workItemId);
      if (recorded === undefined) return err(notFound('Scope snapshot for work item', input.workItemId));

      const succeeded = new Set(input.succeededRefs.map(refKey));
      const unpublished = input.expectedRefs.filter((ref) => !succeeded.has(refKey(ref)));
      const comparison =
        input.liveScope === null
          ? null
          : compareScope(toDomainSnapshot(toSnapshotRecord(recorded)), input.liveScope);

      if (comparison !== null && comparison.kind === 'Material') {
        return this.writeDiscrepancy(project, input, 'StaleContentRefused', 'push-observed-content', {
          detail: `The recorded scope is out of date (${comparison.materialDifferences.join(', ')}), so this attempt's content was not published.`,
          unpublished,
          succeeded: input.succeededRefs,
          outcome: 'RefusedStaleContent',
        });
      }

      if (input.providerStatus === 'Done' && !this.hasReleaseEvidence(input.workItemId)) {
        return this.writeDiscrepancy(project, input, 'ExternalStatusWithoutReleaseEvidence', 'confirm-release', {
          detail:
            'The issue was closed externally while no delivery was confirmed, so the external Done was preserved and recorded as a flag rather than as release confirmation.',
          unpublished,
          succeeded: input.succeededRefs,
          outcome: 'ExternalStatusWithoutReleaseEvidence',
        });
      }

      if (unpublished.length > 0) {
        return this.writeDiscrepancy(project, input, 'PartialPublication', 'publish-remaining-refs', {
          detail: `${unpublished.length} of ${input.expectedRefs.length} expected mappings are still unpublished.`,
          unpublished,
          succeeded: input.succeededRefs,
          outcome: 'PartialPublication',
        });
      }

      return ok({ outcome: 'Accepted', discrepancy: null });
    });
  }

  listDiscrepancies(workItemId: WorkItemId): Result<readonly SyncDiscrepancy[]> {
    return this.attempt('list synchronisation discrepancies', () => {
      const rows = this.database
        .prepare(
          `SELECT ${DISCREPANCY_COLUMNS} FROM sync_discrepancies
             WHERE work_item_id = ? ORDER BY recorded_at ASC, created_at ASC`,
        )
        .all(workItemId);
      return ok(rows.map(toDiscrepancy));
    });
  }

  private writeDiscrepancy(
    project: ProjectId,
    input: RecordSyncAttemptInput,
    kind: SyncDiscrepancyKind,
    refusedAction: string,
    parts: {
      readonly detail: string;
      readonly unpublished: readonly ExternalRef[];
      readonly succeeded: readonly ExternalRef[];
      readonly outcome: 'RefusedStaleContent' | 'ExternalStatusWithoutReleaseEvidence' | 'PartialPublication';
    },
  ): Result<SyncAttemptVerdict> {
    return withTransaction(this.database, () => {
      const discrepancyId = newId();
      this.database
        .prepare(
          `INSERT INTO sync_discrepancies (
             discrepancy_id, work_item_id, project_id, outbox_event_id, operation_id, kind,
             observed_status, refused_action, detail, unpublished_refs, succeeded_refs,
             recorded_at, correlation_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          discrepancyId,
          input.workItemId,
          project,
          input.outboxEventId,
          input.operationId,
          kind,
          input.providerStatus,
          refusedAction,
          parts.detail,
          canonicalize(parts.unpublished),
          canonicalize(parts.succeeded),
          input.attemptedAt,
          input.correlationId,
        );
      const created = this.database
        .prepare(`SELECT ${DISCREPANCY_COLUMNS} FROM sync_discrepancies WHERE discrepancy_id = ?`)
        .get(discrepancyId);
      if (created === undefined) return err(notFound('Sync discrepancy', discrepancyId));
      return ok({ outcome: parts.outcome, discrepancy: toDiscrepancy(created) });
    });
  }

  /**
   * True when ShipLoop has a confirmed delivery for this work item.
   *
   * Read from `deliveries` rather than inferred from the provider's status: a release
   * is confirmed only by a delivery that reached `Released`, and an external `Done` is
   * the human closing their own issue (F29-AC3, F29-AC5).
   */
  private hasReleaseEvidence(workItemId: WorkItemId): boolean {
    const row = this.database
      .prepare("SELECT delivery_id FROM deliveries WHERE work_item_id = ? AND state = 'Released' LIMIT 1")
      .get(workItemId);
    return row !== undefined;
  }

  private projectForWorkItem(workItemId: WorkItemId): ProjectId | undefined {
    const row = this.database
      .prepare('SELECT project_id FROM work_items WHERE work_item_id = ?')
      .get(workItemId);
    if (row === undefined) return undefined;
    return requiredText(row, 'project_id') as ProjectId;
  }

  private latestSnapshotRow(workItemId: WorkItemId): SqlRow | undefined {
    return this.database
      .prepare(
        `SELECT ${SNAPSHOT_COLUMNS} FROM scope_snapshots
           WHERE work_item_id = ? ORDER BY sequence_number DESC LIMIT 1`,
      )
      .get(workItemId);
  }

  /**
   * The newest recorded snapshot carrying a fingerprint.
   *
   * Two captures of identical content share a fingerprint, so the newest is the one
   * that matches the belief being reconciled. The `scope_snapshots_by_fingerprint`
   * index exists for this lookup; without it every reconciliation would scan.
   */
  private snapshotByFingerprint(workItemId: WorkItemId, fingerprint: Fingerprint): SqlRow | undefined {
    return this.database
      .prepare(
        `SELECT ${SNAPSHOT_COLUMNS} FROM scope_snapshots
           WHERE work_item_id = ? AND scope_fingerprint = ?
           ORDER BY sequence_number DESC LIMIT 1`,
      )
      .get(workItemId, fingerprint);
  }

  private readSnapshot(scopeSnapshotId: ScopeSnapshotId): Result<ScopeSnapshotRecord> {
    const row = this.database
      .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM scope_snapshots WHERE scope_snapshot_id = ?`)
      .get(scopeSnapshotId);
    if (row === undefined) return err(notFound('Scope snapshot', scopeSnapshotId));
    return ok(toSnapshotRecord(row));
  }

  /**
   * Converts an unexpected driver failure into a typed `Unavailable`.
   *
   * No method here throws across the boundary: a caller has to be able to tell a
   * refusal (NotFound, Conflict, Invalid) from storage being broken, and the
   * transaction that wrote the snapshot either committed in full or not at all.
   */
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
