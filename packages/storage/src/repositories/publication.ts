/**
 * Publication and adoption persistence (F10, F11, F16-AC4, F29-AC4, F30-AC5, N01-AC2).
 *
 * This module is the durable half of publishing an accepted plan to a ticket provider
 * and of adopting work that already exists. Five properties are structural here rather
 * than left to the caller, and each is a reason the file exists at all.
 *
 * 1. **A published row is a snapshot, not a second copy.** `settlePublished` writes the
 *    provider's own issue identity, URL and revision and then stops. Nothing in this file
 *    edits a published title, description, criterion or dependency, because the live issue
 *    is the ticket and a locally editable copy of it would be a second source of truth for
 *    the same fields (F10-AC4). The only route back into the provider is a deliberate
 *    update through the adapter, which this layer cannot express.
 * 2. **Every external write is bracketed by the operation ledger in one transaction.**
 *    `beginPublication` commits the work item's state and the ledger's intent row
 *    together, and each settlement writes the outcome beside the row it describes. A
 *    crash therefore cannot leave a row reading `Published` with no successful operation
 *    behind it, nor a successful operation with a row still reading `Publishing`
 *    (N01-AC3, F30-AC5).
 * 3. **The retry rule is asked of the reconciliation worklist, never restated.**
 *    `retryDecision` and `assertWritable` are delegated to `reconciliation/pending.ts`
 *    and `events/operations.ts`, which between them already encode when a second external
 *    write is safe. A second rule here would be a second opinion about the same question,
 *    and the one a reviewer reads would be the one that decides.
 * 4. **An unresolved outcome is never rounded to a verdict.** `settleUnresolved` writes
 *    `OutcomeUnknown` to both the ledger and the work item, because the issue may exist
 *    at the provider: reporting `Published` would invite the duplicate the operation
 *    identity exists to prevent, and reporting `Unpublished` would hide it (F30-AC5,
 *    N01-AC2).
 * 5. **Issue creation cannot honestly pre-declare its provider identity.**
 *    `external_operations.expected_refs` holds provider-side identities, and a new issue's
 *    identity is derived inside the adapter from the operation id. A caller that cannot
 *    compute it must not fill the column with a local identity, because the outbox's
 *    "expected minus succeeded" arithmetic would then compare two different kinds of
 *    thing. Publication therefore declares no expected refs, and records what remains
 *    unpublished where it can be named: `work_items.publication_state` per proposed
 *    ticket, read back through `listPublicationTargets` (F10-AC2). The ref arithmetic is
 *    used where the identity IS known before the call - a managed comment and a release
 *    receipt both address an issue that already exists (F16-AC4, F29-AC4).
 */

import { canonicalize, conflict, err, invalid, ok } from '@shiploop/domain';
import type { DomainError, ProjectId, Result, WorkItemId } from '@shiploop/domain';

import type { Database } from '../db.ts';
import { withTransaction } from '../tx.ts';
import { createOperationStore } from '../events/operations.ts';
import type { ExternalOperationStore } from '../events/operations.ts';
import { createOutboxStore } from '../events/outbox.ts';
import type { OutboxStore } from '../events/outbox.ts';
import type { ExternalOperation, ExternalRef, FailureCategory, Instant, OutboxEffect } from '../events/types.ts';
import { PendingReconciliationStore } from '../reconciliation/pending.ts';
import type {
  OperationResolutionRecord,
  PendingReconciliation,
  ReconciliationResolution,
  RetryDecision,
  WorkItemSyncView,
} from '../reconciliation/pending.ts';
import { WorkItemRepository } from './core.ts';
import type { AdoptionReference, CreateWorkItemInput, WorkItemRecord } from './types.ts';

/**
 * The ledger kind for creating a provider issue (F10-AC3).
 *
 * A name the schema's CHECK already admits, because the ledger is what reconciliation
 * groups by and a kind no reader recognises would be a row nobody can reconcile.
 */
export const PUBLICATION_OPERATION_KIND = 'PublishIssue';

/** The ledger kind for one managed progress delivery (F16-AC2, F16-AC3). */
export const PROGRESS_OPERATION_KIND = 'ProgressComment';

/** The ledger kind for publishing a release receipt (F29-AC4). */
export const RECEIPT_OPERATION_KIND = 'ReceiptPublish';

/**
 * The facts an external write needs that are not the ticket itself.
 *
 * `kind` and `target` are the ledger's own vocabulary: the schema's CHECK admits
 * `ProgressComment` and `ReceiptPublish` beside `PublishIssue` precisely because a managed
 * comment and a receipt are different intents the ledger has to tell apart when reconciling
 * (F16-AC4, F29-AC4).
 */
export interface PublicationContext {
  readonly projectId: ProjectId;
  readonly correlationId: string;
  readonly at: Instant;
  /** Defaults to `PublishIssue`; an update passes its own kind. */
  readonly kind?: string;
  /** Defaults to the work item, which is the identity of a ticket being created. */
  readonly target?: string;
}

/**
 * Which of the two external writes a settlement describes.
 *
 * Creating the issue and updating it afterwards are different facts with different
 * consequences, and conflating them is a real defect rather than a tidy abstraction: a
 * managed comment whose response was lost would otherwise reset a PUBLISHED work item to
 * `Unpublished`, and a receipt publication would try to claim the issue-creation operation
 * identity that already produced the ticket (F10-AC4, F16-AC2, F29-AC4).
 */
export type ExternalWriteScope = 'IssueCreation' | 'ExternalUpdate';

/** One proposed ticket, with the operation identity its publication owns. */
export interface TicketPublicationPlan {
  readonly workItemId: WorkItemId;
  readonly operationId: string;
}

/** What the ledger and the work item hold immediately before a provider call (N01-AC3). */
export interface BegunPublication {
  readonly workItem: WorkItemRecord;
  readonly operation: ExternalOperation;
}

/** The provider identity of the issue a work item is mapped to (F10-AC2). */
export interface PublishedIssueBinding {
  readonly operationId: string;
  readonly providerIssueId: string;
  readonly providerIssueIdentifier: string;
  readonly providerIssueUrl: string;
  /**
   * The provider's own revision, when it reports one.
   *
   * Stored with the mapping rather than recomputed on demand, so the row states what the
   * provider said at the moment of publication rather than what a later read would
   * reconstruct (F10-AC4, F12-AC1).
   */
  readonly providerRevision: string | null;
  readonly publishedAt: Instant;
}

/** The work item columns a publication report reads back (F10-AC2). */
export interface PublicationTarget {
  readonly workItemId: WorkItemId;
  readonly projectId: string;
  readonly title: string;
  readonly publicationIntent: WorkItemRecord['publicationIntent'];
  readonly publicationState: WorkItemRecord['publicationState'];
  readonly publicationOperationId: string | null;
  readonly providerIssueId: string | null;
  readonly providerIssueIdentifier: string | null;
  readonly providerIssueUrl: string | null;
  readonly updatedAt: string;
}

/** The work item currently holding a provider issue (F11-AC3). */
export interface ExistingIssueMapping {
  readonly workItemId: WorkItemId;
  readonly projectId: string;
}

/** An outbound effect whose external identity is known before the call (F16-AC4, F29-AC4). */
export interface EnqueueExternalEffectInput {
  readonly kind: string;
  readonly dedupKey: string;
  readonly target: string;
  readonly operationId: string;
  readonly workItemId: WorkItemId;
  readonly correlationId: string;
  readonly payload: unknown;
  /** Provider identities this effect must create; empty when it creates none. */
  readonly expectedRefs: readonly ExternalRef[];
  readonly at: Instant;
}

/** Binds an already-existing provider issue to an adopted work item (F11-AC1). */
export interface RecordAdoptionInput {
  readonly workItemId: WorkItemId;
  readonly operationId: string | null;
  readonly providerIssueId: string;
  readonly providerIssueIdentifier: string;
  readonly providerIssueUrl: string;
  /**
   * Null when only the issue was adopted and no branch or pull request was linked.
   *
   * The head SHA and target branch are what F11-AC2 verified before this row was written,
   * and they are the evidence that adoption reset nothing (F11-AC4).
   *
   * Encoded through `canonicalize`, which writes the JSON literal `null` rather than SQL
   * NULL for "no branch was linked". `core.ts` reads this column with `requiredText`, so a
   * SQL NULL here would make the whole work item unreadable, and the row that holds an
   * adopted issue would be the one row nobody could load.
   */
  readonly adoption: AdoptionReference | null;
  readonly observedAt: Instant;
  readonly correlationId: string | null;
}

const TARGET_COLUMNS =
  'work_item_id, project_id, title, publication_intent, publication_state, publication_operation_id, external_issue_id, external_issue_identifier, external_issue_url, updated_at';

/** The columns `recordPublished` writes, and nothing else. */
const PUBLISHED_COLUMNS = 'work_item_id, publication_state, publication_intent, publication_operation_id, external_issue_id, external_issue_identifier, external_issue_url, provider_revision, updated_at';

function text(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`column ${column} is missing or not text`);
  return value;
}

function optional(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

function notFound(entity: string, identity: string): DomainError {
  return { code: 'NotFound', reason: `${entity} ${identity} does not exist.` };
}

/**
 * The durable publication, adoption and external-effect rows.
 *
 * Constructed over a real `Database` because every method here is multi-statement and the
 * bounded transaction comes from `tx.ts`, which owns BEGIN/COMMIT, savepoint nesting and
 * the busy answer. The `WorkItemRepository`, operation store, outbox and worklist it
 * composes with are built against the same connection, which is what lets a publication's
 * work-item state, its ledger intent and its outbound effect land as one indivisible
 * step. A repository composed with a different runner would open a second write
 * transaction and fail, and that is the N01-AC3 shape this module exists to prevent.
 */
export class PublicationRepository {
  private readonly database: Database;
  private readonly workItems: WorkItemRepository;
  private readonly operations: ExternalOperationStore;
  private readonly outbox: OutboxStore;
  private readonly pending: PendingReconciliationStore;

  constructor(database: Database) {
    this.database = database;
    this.workItems = new WorkItemRepository(database, { transaction: (body) => withTransaction(database, body) });
    this.operations = createOperationStore({ connection: database });
    this.outbox = createOutboxStore({ connection: database });
    this.pending = new PendingReconciliationStore(database);
  }

  /**
   * The work item a publication may act on, or a refusal naming what is wrong with it.
   *
   * Publication may only act on a work item the owner selected (`PublishWhenAgreed`) or
   * one already published. A `DoNotPublish` row is refused here rather than published on
   * the caller's word, because the intent column is the durable record of that selection
   * and ignoring it would make the column decorative (F10-AC1).
   */
  requirePublishable(workItemId: WorkItemId): Result<WorkItemRecord> {
    return this.attempt('read the work item being published', () => {
      const found = this.workItems.get(workItemId);
      if (!found.ok) return found;
      const record = found.value;
      if (record.publicationIntent === 'DoNotPublish') {
        return err(
          invalid('This work item is not selected for publication.', [
            {
              path: 'publicationIntent',
              message:
                'The owner recorded DoNotPublish for this work item. Select publication for it before any issue is created (F10-AC1).',
            },
          ]),
        );
      }
      return ok(record);
    });
  }

  /**
   * Records the intent to publish, and the work item's publishing state, atomically.
   *
   * Both rows are one fact: "this operation is about to create this ticket for this work
   * item". Splitting them would allow a crash to leave an operation with no visible work
   * item, or a work item stuck at `Publishing` for an operation nobody recorded - and the
   * second is precisely the state a retry would have to guess about (N01-AC3, F30-AC5).
   *
   * A repeat of the same operation returns the existing intent rather than inserting a
   * second one, so re-requesting a publication is not an error (F10-AC3). A work item
   * already published by a *different* operation is a conflict: two operations writing
   * one ticket is the duplication this whole design prevents.
   */
  beginPublication(plan: TicketPublicationPlan, context: PublicationContext): Result<BegunPublication> {
    return this.attempt('begin the publication', () =>
      withTransaction(this.database, () => {
        const publishable = this.requirePublishable(plan.workItemId);
        if (!publishable.ok) return publishable;
        const workItem = publishable.value;
        const held = workItem.publicationOperationId;
        if (held !== null && held !== plan.operationId) {
          return err(
            conflict(
              `Work item ${plan.workItemId} is already being published by operation ${held}`,
              plan.operationId,
              held,
            ),
          );
        }
        const intent = this.operations.recordIntent({
          operationId: plan.operationId,
          projectId: context.projectId,
          kind: PUBLICATION_OPERATION_KIND,
          target: plan.workItemId,
          expectedRefs: [],
          correlationId: context.correlationId,
          at: context.at,
        });
        if (!intent.ok) return intent;
        const marked = this.workItems.recordPublication(plan.workItemId, 'Publishing', plan.operationId, context.at);
        if (!marked.ok) return marked;
        return ok({ workItem: marked.value, operation: intent.value });
      }),
    );
  }

  /**
   * Records the intent for an update to an issue that already exists.
   *
   * No work-item state changes, because the issue is already published and a managed
   * comment does not alter that. Writing `publication_operation_id` here would overwrite the
   * identity that created the ticket, and the next publication request would then read as
   * belonging to a comment (F10-AC2, F16-AC2).
   */
  beginExternalUpdate(operationId: string, context: PublicationContext): Result<ExternalOperation> {
    return this.attempt('begin the external update', () =>
      withTransaction(this.database, () => {
        const intent = this.operations.recordIntent({
          operationId,
          projectId: context.projectId,
          kind: context.kind ?? PROGRESS_OPERATION_KIND,
          target: context.target ?? context.projectId,
          expectedRefs: [],
          correlationId: context.correlationId,
          at: context.at,
        });
        return intent;
      }),
    );
  }

  /**
   * The last gate before the provider call (F10-AC3, F30-AC5).
   *
   * Delegated rather than reimplemented: `assertWritable` already refuses a settled
   * success and an unresolved outcome, and it refuses a stale intent because the process
   * may have died between issuing the write and recording its response.
   */
  assertWritable(operationId: string, now: Instant): Result<ExternalOperation> {
    return this.attempt('assert the publication is writable', () => this.operations.assertWritable(operationId, now));
  }

  /**
   * Whether this operation may be written again, answered by the reconciliation worklist
   * (F10-AC3, F28-AC4, F30-AC5).
   *
   * `AlreadyApplied` is the answer that makes a repeated publication request a
   * reconciliation rather than a second write, and `OutcomeUnknown` is the answer that
   * makes it wait. Both come from `reconciliation/pending.ts`, which owns the rule.
   */
  retryDecision(operationId: string, now: Instant): Result<RetryDecision> {
    return this.attempt('decide whether the publication may be retried', () => this.pending.retryDecision(operationId, now));
  }

  /** The operation row itself, or null when none was ever recorded. */
  findOperation(operationId: string): ExternalOperation | null {
    return this.operations.findByOperation(operationId);
  }

  /** Every unresolved external write, oldest first (F30-AC5). */
  pendingReconciliation(now: Instant): readonly PendingReconciliation[] {
    return this.pending.pendingReconciliation(now);
  }

  /**
   * Records the provider's answer to a publication and settles the ledger with it.
   *
   * The provider columns, the publication state, the ledger outcome, the outbound effect
   * and the work item's sync label are written in one transaction. A `Published` row with
   * a `Failed` operation, or the reverse, is the disagreement a reconciliation worklist
   * exists to find (N01-AC3, F30-AC5).
   */
  settlePublished(binding: PublishedIssueBinding, workItemId: WorkItemId): Result<WorkItemRecord> {
    return this.attempt('settle the publication as published', () =>
      withTransaction(this.database, () => {
        const publishable = this.requirePublishable(workItemId);
        if (!publishable.ok) return publishable;
        const written = this.database
          .prepare(
            `UPDATE work_items
                SET external_issue_id = ?, external_issue_identifier = ?, external_issue_url = ?,
                    provider_revision = ?, publication_state = 'Published',
                    publication_intent = 'Published', publication_operation_id = ?, updated_at = ?
              WHERE work_item_id = ?`,
          )
          .run(
            binding.providerIssueId,
            binding.providerIssueIdentifier,
            binding.providerIssueUrl,
            binding.providerRevision,
            binding.operationId,
            binding.publishedAt,
            workItemId,
          );
        if (Number(written.changes) !== 1) return err(notFound('Work item', workItemId));
        const outcome = this.operations.recordOutcome(binding.operationId, {
          status: 'Succeeded',
          at: binding.publishedAt,
          detail: `Published ${binding.providerIssueIdentifier} at revision ${binding.providerRevision ?? 'the provider reported none'}.`,
          operationRef: binding.providerIssueId,
        });
        if (!outcome.ok) return outcome;
        const synced = this.workItems.recordSyncResult({
          workItemId,
          attemptedAt: binding.publishedAt,
          succeeded: true,
          error: null,
        });
        if (!synced.ok) return synced;
        return this.readSettled(workItemId);
      }),
    );
  }

  /**
   * Records that the provider refused the write, and keeps the proposal (F10-AC5).
   *
   * The state returns to `Unpublished` rather than staying at `Publishing`: nothing is in
   * flight, the ledger holds a `Failed` outcome that permits a retry, and the owner's
   * selection survives untouched, so a retry after a corrected permission or capacity
   * problem needs nothing but the correction. The mappings of the other proposed tickets
   * are unaffected because each ticket owns its own row (F10-AC5).
   */
  settleRefused(input: {
    readonly workItemId: WorkItemId;
    readonly operationId: string;
    readonly detail: string;
    readonly category: FailureCategory;
    readonly observedAt: Instant;
    /** `ExternalUpdate` leaves the publication state alone; see `ExternalWriteScope`. */
    readonly scope?: ExternalWriteScope;
  }): Result<WorkItemRecord> {
    const scope = input.scope ?? 'IssueCreation';
    return this.attempt('record the refused write', () =>
      withTransaction(this.database, () => {
        const publishable = this.requirePublishable(input.workItemId);
        if (!publishable.ok) return publishable;
        const outcome = this.operations.recordOutcome(input.operationId, {
          status: 'Failed',
          at: input.observedAt,
          detail: input.detail,
        });
        if (!outcome.ok) return outcome;
        if (scope === 'IssueCreation') {
          const reopened = this.workItems.recordPublication(
            input.workItemId,
            'Unpublished',
            input.operationId,
            input.observedAt,
          );
          if (!reopened.ok) return reopened;
        }
        const synced = this.workItems.recordSyncResult({
          workItemId: input.workItemId,
          attemptedAt: input.observedAt,
          succeeded: false,
          error: input.detail,
        });
        if (!synced.ok) return synced;
        return this.readSettled(input.workItemId);
      }),
    );
  }

  /**
   * Records that the outcome was never established (F30-AC5, N01-AC2).
   *
   * `OutcomeUnknown` on both sides is the only honest state: the issue may exist at the
   * provider, so neither `Published` nor `Unpublished` would be true, and the ledger row
   * plus the work item row are what the reconciliation worklist later reads to settle it.
   */
  settleUnresolved(input: {
    readonly workItemId: WorkItemId;
    readonly operationId: string;
    readonly detail: string;
    readonly observedAt: Instant;
    /** `ExternalUpdate` leaves the publication state alone; see `ExternalWriteScope`. */
    readonly scope?: ExternalWriteScope;
  }): Result<WorkItemRecord> {
    const scope = input.scope ?? 'IssueCreation';
    return this.attempt('record the unresolved write', () =>
      withTransaction(this.database, () => {
        const publishable = this.requirePublishable(input.workItemId);
        if (!publishable.ok) return publishable;
        const outcome = this.operations.recordOutcome(input.operationId, {
          status: 'OutcomeUnknown',
          at: input.observedAt,
          detail: input.detail,
        });
        if (!outcome.ok) return outcome;
        if (scope === 'IssueCreation') {
          const unresolved = this.workItems.recordPublication(
            input.workItemId,
            'OutcomeUnknown',
            input.operationId,
            input.observedAt,
          );
          if (!unresolved.ok) return unresolved;
        }
        const synced = this.workItems.recordSyncResult({
          workItemId: input.workItemId,
          attemptedAt: input.observedAt,
          succeeded: false,
          error: input.detail,
        });
        if (!synced.ok) return synced;
        return this.readSettled(input.workItemId);
      }),
    );
  }

  /**
   * Reads the settled row back, refusing a write that produced no readable row.
   *
   * `recordSyncResult` returns the sync label rather than the work item, so the reader is
   * explicit here rather than a caller assuming the two are the same shape.
   */
  private readSettled(workItemId: WorkItemId): Result<WorkItemRecord> {
    const row = this.database
      .prepare(`SELECT ${PUBLISHED_COLUMNS} FROM work_items WHERE work_item_id = ?`)
      .get(workItemId);
    if (row === undefined) return err(notFound('Work item', workItemId));
    return this.workItems.get(workItemId);
  }

  /**
   * Moves the work item's Pending sync label and returns the work item itself.
   *
   * The label and the row are read together so a settlement returns one shape whatever it
   * did: the caller asks what happened to a ticket, not which of two tables it landed in
   * (F16-AC4).
   */
  private markSync(
    workItemId: WorkItemId,
    attemptedAt: Instant,
    succeeded: boolean,
    error: string | null,
  ): Result<WorkItemRecord> {
    const synced = this.workItems.recordSyncResult({ workItemId, attemptedAt, succeeded, error });
    if (!synced.ok) return synced;
    return this.workItems.get(workItemId);
  }

  /**
   * Enqueues an outbound effect whose external identity is known in advance.
   *
   * For a managed progress comment and a release receipt, unlike issue creation, the
   * identity is known before the call: the comment is the one the issue's managed region
   * already names, and the receipt's target is the issue already published. So
   * `expected_refs` is populated honestly and the outbox's "complete when every expected
   * ref is mapped" rule is meaningful (F16-AC4, F29-AC4).
   *
   * The dedup key is the storage half of "a receipt retry must not republish a duplicate
   * receipt": the UNIQUE index returns the existing effect instead of a second row, and the
   * effect is bound to the work item so the pending-sync view can find it (F29-AC4, F16-AC4).
   */
  enqueueExternalEffect(input: EnqueueExternalEffectInput): Result<{ readonly effect: OutboxEffect; readonly created: boolean }> {
    return this.attempt('enqueue the external effect', () =>
      withTransaction(this.database, () => {
        const publishable = this.requirePublishable(input.workItemId);
        if (!publishable.ok) return publishable;
        const enqueued = this.outbox.enqueue({
          effectId: effectIdentity(input.dedupKey),
          dedupKey: input.dedupKey,
          kind: input.kind,
          target: input.target,
          payload: canonicalize(input.payload),
          correlationId: input.correlationId,
          operationId: input.operationId,
          expectedRefs: input.expectedRefs,
          at: input.at,
        });
        if (!enqueued.ok) return enqueued;
        this.database
          .prepare('UPDATE outbox_events SET work_item_id = ? WHERE outbox_event_id = ? AND work_item_id IS NULL')
          .run(input.workItemId, enqueued.value.effect.effectId);
        return ok({
          effect: { ...enqueued.value.effect, ...(enqueued.value.created ? { } : {}) },
          created: enqueued.value.created,
        });
      }),
    );
  }

  /**
   * Marks an effect's delivery as complete, keeping every ref mapped so far (F16-AC4).
   *
   * `markSucceeded` only settles the effect once every expected ref is mapped, so a
   * partial delivery stays `PendingSync` and names exactly what is still missing.
   */
  markEffectSucceeded(effectId: string, at: Instant, refs: readonly ExternalRef[]): Result<OutboxEffect> {
    return this.attempt('mark the external effect delivered', () => this.outbox.markSucceeded(effectId, { at, refs }));
  }

  /** Expected refs with no recorded mapping: what this effect still owes (F10-AC2). */
  unpublishedRefs(effectId: string): readonly ExternalRef[] {
    return this.outbox.unpublishedRefs(effectId);
  }

  /** The effect an operation owns, for a caller deciding what a retry would re-attempt. */
  findEffectByOperation(operationId: string): readonly OutboxEffect[] {
    return this.outbox.findByOperation(operationId);
  }

  /**
   * Records a delivered update to an already-published issue (F16-AC2, F29-AC4).
   *
   * The ledger outcome is what makes a repeat of the same milestone a refusal rather than
   * a second delivery, so it is written here rather than left to the caller's sync label:
   * without it the operation would stay `IntentRecorded`, which the worklist reads as still
   * in flight and therefore still writable (F16-AC3).
   *
   * No publication state changes: the issue was already published and a managed comment does
   * not alter that. `providerRef` is the comment identity the update returned, so a
   * reconciliation of a later lost response has something to read.
   */
  settleExternalUpdateDelivered(input: {
    readonly workItemId: WorkItemId;
    readonly operationId: string;
    readonly providerRef: string | null;
    readonly deliveredAt: Instant;
  }): Result<WorkItemRecord> {
    return this.attempt('record the delivered external update', () =>
      withTransaction(this.database, () => {
        const publishable = this.requirePublishable(input.workItemId);
        if (!publishable.ok) return publishable;
        const outcome = this.operations.recordOutcome(input.operationId, {
          status: 'Succeeded',
          at: input.deliveredAt,
          detail: 'The managed update reached the provider.',
          ...(input.providerRef === null ? {} : { operationRef: input.providerRef }),
        });
        if (!outcome.ok) return outcome;
        const synced = this.markSync(input.workItemId, input.deliveredAt, true, null);
        if (!synced.ok) return synced;
        return this.readSettled(input.workItemId);
      }),
    );
  }

  /**
   * Records the sync outcome an external update produced (F16-AC4).
   *
   * A failure is a labelled pending state with the last success time preserved, never a
   * lost local record: the run's own progress stays available while the provider is behind.
   */
  recordSyncResult(input: {
    readonly workItemId: WorkItemId;
    readonly attemptedAt: Instant;
    readonly succeeded: boolean;
    readonly error: string | null;
  }): Result<WorkItemRecord> {
    return this.attempt('record the external sync result', () =>
      this.markSync(input.workItemId, input.attemptedAt, input.succeeded, input.error),
    );
  }

  /**
   * Creates the work item an adopted issue becomes.
   *
   * `source: 'AdoptedIssue'` rather than `ProposedNewIssue`, because the schema derives
   * the durable `origin` from it and an adopted issue already exists at the provider:
   * recording it as proposed would claim ShipLoop wrote something it did not write (F11).
   *
   * The provider identity is deliberately not bound here. It is bound by `recordAdoption`
   * after the live read has been verified, so a work item can never exist holding an issue
   * identity nobody read from the provider (F11-AC2, F11-AC3).
   */
  createAdoptedWorkItem(
    input: Omit<CreateWorkItemInput, 'externalIssueId' | 'source'>,
  ): Result<WorkItemRecord> {
    return this.attempt('create the adopted work item', () =>
      this.workItems.create({ ...input, source: 'AdoptedIssue', externalIssueId: null }),
    );
  }

  /**
   * Binds a verified provider issue to an adopted work item (F11-AC1, F11-AC4).
   *
   * The unique index on `external_issue_id` is the last line of the wrong-project refusal:
   * an issue already mapped anywhere is refused rather than adopted twice, and the refusal
   * names the project and work item that hold it, so the owner is told which mapping is
   * wrong rather than only that one exists (F11-AC3).
   */
  recordAdoption(input: RecordAdoptionInput): Result<WorkItemRecord> {
    return this.attempt('record the adopted issue', () =>
      withTransaction(this.database, () => {
        const found = this.workItems.get(input.workItemId);
        if (!found.ok) return found;
        const held = this.findByProviderIssue(input.providerIssueId);
        if (held !== null && held.workItemId !== input.workItemId) {
          return err(
            conflict(
              `Issue ${input.providerIssueIdentifier} is already mapped to work item ${held.workItemId} in project ${held.projectId}`,
              'an issue no work item holds',
              `an issue already mapped to work item ${held.workItemId} in project ${held.projectId}`,
            ),
          );
        }
        const written = this.database
          .prepare(
            `UPDATE work_items
                SET external_issue_id = ?, external_issue_identifier = ?, external_issue_url = ?,
                    publication_state = 'Published', publication_operation_id = ?, adoption_json = ?,
                    updated_at = ?
              WHERE work_item_id = ?`,
          )
          .run(
            input.providerIssueId,
            input.providerIssueIdentifier,
            input.providerIssueUrl,
            input.operationId,
            canonicalize(input.adoption),
            input.observedAt,
            input.workItemId,
          );
        if (Number(written.changes) !== 1) return err(notFound('Work item', input.workItemId));
        return this.workItems.get(input.workItemId);
      }),
    );
  }

  /**
   * Records the branch or pull request an adoption verified, leaving the issue binding alone.
   *
   * Separate from `recordAdoption` because the two facts are different: one is "this
   * provider issue is this work item", the other is "this work item continues the work on
   * that branch". Writing the issue columns again to record the second would overwrite the
   * first with values a read never re-checked, which is how a binding drifts from the issue
   * it names (F11-AC2, F11-AC4).
   */
  recordAdoptionReference(input: {
    readonly workItemId: WorkItemId;
    readonly adoption: AdoptionReference;
    readonly observedAt: Instant;
    readonly correlationId: string | null;
  }): Result<WorkItemRecord> {
    return this.attempt('record the adopted change reference', () =>
      withTransaction(this.database, () => {
        const found = this.workItems.get(input.workItemId);
        if (!found.ok) return found;
        const written = this.database
          .prepare('UPDATE work_items SET adoption_json = ?, updated_at = ? WHERE work_item_id = ?')
          .run(canonicalize(input.adoption), input.observedAt, input.workItemId);
        if (Number(written.changes) !== 1) return err(notFound('Work item', input.workItemId));
        return this.workItems.get(input.workItemId);
      }),
    );
  }

  /** The work item currently holding a provider issue, or null (F11-AC3). */
  findByProviderIssue(providerIssueId: string): ExistingIssueMapping | null {
    const row = this.database
      .prepare('SELECT work_item_id, project_id FROM work_items WHERE external_issue_id = ?')
      .get(providerIssueId);
    if (row === undefined) return null;
    return { workItemId: text(row, 'work_item_id') as WorkItemId, projectId: text(row, 'project_id') };
  }

  /**
   * Records what reconciliation established about an unresolved publication, and settles
   * the ledger to match (F10-AC3, F28-AC4, N01-AC2).
   *
   * Delegated because the resolution row and the ledger status must be written together:
   * a settled operation that still looks unresolved is exactly the state a retry would
   * have to guess about (N01-AC3).
   */
  recordResolution(operationId: string, resolution: ReconciliationResolution): Result<OperationResolutionRecord> {
    return this.attempt('record the reconciliation resolution', () => this.pending.recordResolution(operationId, resolution));
  }

  /** Every resolution recorded for an operation, oldest first (F28-AC4). */
  listResolutions(operationId: string): Result<readonly OperationResolutionRecord[]> {
    return this.attempt('list reconciliation resolutions', () => this.pending.listResolutions(operationId));
  }

  /** The Pending sync view for one work item, including unpublished refs (F16-AC4, F10-AC2). */
  pendingSyncStatus(workItemId: WorkItemId): Result<WorkItemSyncView> {
    return this.attempt('read the pending sync status', () => this.pending.pendingSyncStatus(workItemId));
  }

  /**
   * Every work item's publication state for a project, oldest first (F10-AC2).
   *
   * The read side of a partial publication. A caller holding the proposed tickets joins
   * this against its own ticket-to-work-item mapping and learns, per ticket, whether it is
   * published and where; the tickets not in `Published` are exactly what a retry still
   * owes (F10-AC2), and the published ones keep their mappings (F10-AC5).
   */
  listPublicationTargets(projectId: string): Result<readonly PublicationTarget[]> {
    return this.attempt('list publication targets', () => {
      const rows = this.database
        .prepare(
          `SELECT ${TARGET_COLUMNS} FROM work_items
             WHERE project_id = ? ORDER BY created_at ASC, work_item_id ASC`,
        )
        .all(projectId);
      return ok(
        rows.map((row) => ({
          workItemId: text(row, 'work_item_id') as WorkItemId,
          projectId: text(row, 'project_id'),
          title: text(row, 'title'),
          publicationIntent: text(row, 'publication_intent') as PublicationTarget['publicationIntent'],
          publicationState: text(row, 'publication_state') as PublicationTarget['publicationState'],
          publicationOperationId: optional(row, 'publication_operation_id'),
          providerIssueId: optional(row, 'external_issue_id'),
          providerIssueIdentifier: optional(row, 'external_issue_identifier'),
          providerIssueUrl: optional(row, 'external_issue_url'),
          updatedAt: text(row, 'updated_at'),
        })),
      );
    });
  }

  /**
   * Converts an unexpected driver failure into a typed `Unavailable`.
   *
   * No method here throws across the boundary: a caller must be able to tell a refusal
   * (NotFound, Conflict, Invalid) from storage being broken, and the transaction that
   * wrote the rows either committed in full or not at all (N01-AC3).
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

/**
 * A stable outbox effect identity derived from the dedup key.
 *
 * Derived rather than random so a repeated enqueue of the same intent addresses the same
 * row even without the UNIQUE index, which means the dedup property does not rest on one
 * constraint happening to be present (F29-AC4, N01-AC3).
 */
function effectIdentity(dedupKey: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < dedupKey.length; index += 1) {
    hash ^= dedupKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const readable = dedupKey.replace(/[^A-Za-z0-9]+/g, '-').slice(-32);
  return `eff-${hash.toString(16).padStart(8, '0')}-${readable}`;
}
