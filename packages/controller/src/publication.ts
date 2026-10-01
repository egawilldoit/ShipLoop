/**
 * Publication use cases (F10, F16-AC2, F16-AC3, F16-AC4, F29-AC4, F30-AC5, N01-AC2).
 *
 * This module decides *whether* a provider write may happen and *what its answer means*.
 * It never decides whether a write is safe: `events/operations.ts` owns the bracket and
 * `reconciliation/pending.ts` owns the retry rule, and both are asked rather than
 * reimplemented. A second copy of either rule here would be a second opinion about the
 * question that creates duplicates, and the one a reviewer reads would be the one that
 * decides.
 *
 * The properties this layer is responsible for:
 *
 * - **Only an accepted, owner-selected proposal is published** (F10-AC1). The input takes
 *   `PublishableTicket`, which `toPublishableTicket` produces only from an
 *   `AcceptedPlanTask`; an unaccepted proposal has no publishable form to pass. The work
 *   item's `publicationIntent` is checked against the store, so a `DoNotPublish` row
 *   cannot be published by a caller that forgot to ask.
 * - **Publication success is reported per proposed ticket** (F10-AC2). One ticket that
 *   fails does not erase the ones that succeeded, and the report names exactly which
 *   remain unpublished. Each ticket owns its own work-item row, its own ledger operation
 *   and its own sync label, so a partial failure is a fact rather than an aggregate.
 * - **A repeat of the same request reconciles rather than writes** (F10-AC3). The
 *   operation identity is derived from the caller's stable `requestId` and the ticket, so
 *   a repeat addresses the same operation; the ledger then refuses the write and the
 *   reconciliation worklist says why. No second write is reachable from this layer.
 * - **An unresolved outcome is never a success** (F30-AC5, N01-AC2). A lost response is
 *   `OutcomeUnknown` in the ledger, in the work item and in the returned result, and it
 *   names the operation a reconciliation must settle.
 * - **Published fields live at the provider** (F10-AC4). This layer writes issue
 *   identity, URL and provider revision and nothing else; no call here can push a local
 *   title, description or criterion back over a human edit.
 * - **Managed progress updates one region and is idempotent per milestone** (F16-AC2,
 *   F16-AC3). The operation identity is derived from the milestone, so a repeat is refused
 *   by the ledger before any provider call, and the adapter's own managed-comment identity
 *   bounds the race the adapter documents as residual.
 * - **A failed update is a labelled pending state, not a lost run** (F16-AC4). The work
 *   item keeps its last success time; the local record of what ShipLoop believed stays
 *   readable while the provider is behind.
 */

import { conflict, err, invalid, ok, redact } from '@shiploop/domain';
import type {
  DomainError,
  OperationId,
  ProjectId,
  PublishableTicket,
  Result,
  WorkItemId,
} from '@shiploop/domain';
import type {
  AdapterContext,
  ManagedProgressOutcome,
  ManagedProgressUpdateRequest,
  ManagedRegionTarget,
  PublishWorkOutcome,
  PublishWorkRequest,
  ProposalRevision,
  TicketAdapter,
  TicketIssueRef,
  TicketScopeRead,
} from '@shiploop/adapters';
import type { FailureCategory, Instant } from '@shiploop/storage';
import { PROGRESS_OPERATION_KIND, PublicationRepository, RECEIPT_OPERATION_KIND } from '@shiploop/storage';
import type { PublicationTarget } from '@shiploop/storage';
import type { ControllerClock, OwnerActor } from './profiles.ts';

/* -------------------------------------------------------------------------- */
/* Inputs and outputs                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One ticket the owner agreed to publish, and the work item it becomes.
 *
 * `revision` is typed `ProposalRevision` because the adapter contract is the authority on
 * what a publication carries. The controller never assembles one from loose strings: a
 * caller projects an accepted `PublishableTicket` through `revisionFor`, so a proposal the
 * owner did not accept cannot reach this type (F10-AC1, F08-AC3).
 */
export interface TicketToPublish {
  readonly workItemId: WorkItemId;
  readonly revision: ProposalRevision;
}

export interface PublishAcceptedWorkInput {
  readonly actor: OwnerActor;
  readonly projectId: ProjectId;
  /**
   * Stable identity of this publication request, reused by every retry of it.
   *
   * Required rather than generated because the caller owns the request boundary: a handler
   * that retries after a timeout must be able to present the same id, and a
   * controller-minted id would be new on every attempt (F10-AC3, mvp-spec 7).
   */
  readonly requestId: string;
  readonly tickets: readonly TicketToPublish[];
  readonly correlationId: string;
}

/** A dependency link the provider did not create, named rather than dropped (F10-AC2). */
export interface FailedLink {
  readonly target: string;
  readonly reason: string;
}

/** One proposed ticket's outcome, exactly as the caller must present it (F10-AC2). */
export type TicketPublication =
  | {
      readonly kind: 'Published';
      readonly workItemId: WorkItemId;
      readonly issue: TicketIssueRef;
      readonly disposition: 'CreatedNew' | 'AlreadyPresent' | 'AdoptedExisting';
      /** Links the provider refused, so the owner can see what is not linked yet. */
      readonly unlinked: readonly FailedLink[];
    }
  | {
      readonly kind: 'OutcomeUnknown';
      readonly workItemId: WorkItemId;
      readonly operationId: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'Failed';
      readonly workItemId: WorkItemId;
      readonly operationId: string;
      readonly error: DomainError;
    };

/**
 * The whole request's outcome.
 *
 * `unpublished` is the answer F10-AC2 asks for: the work items a retry still owes. It lists
 * every ticket that is not `Published`, whatever the reason, so a caller cannot mistake a
 * refused ticket for a delivered one.
 */
export interface PublicationReport {
  readonly requestId: string;
  readonly tickets: readonly TicketPublication[];
  readonly published: readonly WorkItemId[];
  readonly unpublished: readonly WorkItemId[];
}

/**
 * What a reconciler established, in the vocabulary the worklist already checks.
 *
 * `Applied` carries the full provider identity the reconciler read, not just an opaque id:
 * the mapping the publication settles is the id, the human identifier and the URL together
 * (F10-AC2), and a reconciliation that could only supply the id would settle the row with
 * blanks its readers depend on.
 */
export type ReconciliationOutcome =
  | {
      readonly resolution: 'Applied';
      readonly providerIssueId: string;
      readonly providerIssueIdentifier: string;
      readonly providerIssueUrl: string;
      readonly providerRevision: string | null;
      readonly detail: string;
    }
  | { readonly resolution: 'NotApplied'; readonly detail: string }
  | { readonly resolution: 'StillUnknown'; readonly detail: string };

export interface ReconcilePublicationInput {
  readonly actor: OwnerActor;
  readonly operationId: string;
  readonly resolution: ReconciliationOutcome;
  readonly observedAt: string;
  readonly resolvedBy: string;
  readonly correlationId: string;
}

/** The reconciled state of one publication (F10-AC3). */
export type ReconciledPublication =
  | { readonly kind: 'Published'; readonly workItemId: WorkItemId; readonly issueId: string }
  | { readonly kind: 'RetryPermitted'; readonly workItemId: WorkItemId; readonly operationId: string }
  | { readonly kind: 'StillUnknown'; readonly workItemId: WorkItemId; readonly operationId: string };

export interface PublishManagedProgressInput {
  readonly actor: OwnerActor;
  readonly workItemId: WorkItemId;
  /** Deduplication key of the milestone; a repeat of the same key is not delivered again. */
  readonly milestoneKey: string;
  readonly body: string;
  readonly correlationId: string;
}

/** What one managed delivery did (F16-AC2, F16-AC3). */
export type ManagedDelivery =
  | {
      readonly kind: 'Updated';
      readonly workItemId: WorkItemId;
      readonly regionKind: ManagedRegionTarget['kind'];
      readonly deliveredAt: string;
    }
  | { readonly kind: 'Unchanged'; readonly workItemId: WorkItemId; readonly deliveredMilestoneKey: string }
  | {
      readonly kind: 'OutcomeUnknown';
      readonly workItemId: WorkItemId;
      readonly operationId: string;
      readonly detail: string;
    };

export interface PublishReleaseReceiptInput {
  readonly actor: OwnerActor;
  readonly workItemId: WorkItemId;
  /** Identity of the receipt; the publication's idempotency key is derived from it. */
  readonly receiptId: string;
  readonly body: string;
  readonly correlationId: string;
}

/** What a receipt publication did (F29-AC4). */
export type ReceiptPublication =
  | { readonly kind: 'Published'; readonly workItemId: WorkItemId; readonly operationId: string; readonly deliveredAt: string }
  | { readonly kind: 'AlreadyPublished'; readonly workItemId: WorkItemId; readonly operationId: string }
  | { readonly kind: 'OutcomeUnknown'; readonly workItemId: WorkItemId; readonly operationId: string; readonly detail: string };

export interface PublicationUseCaseDeps {
  readonly clock: ControllerClock;
  readonly publications: PublicationRepository;
  /**
   * The ticket provider, injected rather than constructed.
   *
   * The controller holds no SDK client and no endpoint, so a test drives the real adapter
   * through its own injected transport rather than this layer mocking a provider away.
   */
  readonly ticket: TicketAdapter;
  /** Redaction applied to provider text before it reaches a stored row (N02-AC2). */
  readonly redactProviderText?: (text: string) => string;
}

export interface PublicationUseCases {
  readonly publishAcceptedWork: (
    input: PublishAcceptedWorkInput,
  ) => Promise<Result<PublicationReport, DomainError>>;
  readonly reconcilePublication: (
    input: ReconcilePublicationInput,
  ) => Result<ReconciledPublication, DomainError>;
  readonly publishManagedProgress: (
    input: PublishManagedProgressInput,
  ) => Promise<Result<ManagedDelivery, DomainError>>;
  readonly publishReleaseReceipt: (
    input: PublishReleaseReceiptInput,
  ) => Promise<Result<ReceiptPublication, DomainError>>;
  readonly publicationTargets: (projectId: ProjectId) => Result<readonly PublicationTarget[], DomainError>;
  /** Projects an accepted proposal into the form publication carries (F10-AC1). */
  readonly revisionFor: RevisionFor;
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The operation identity one ticket's publication owns.
 *
 * Derived from the request identity and the work item, never from a clock or a counter, so
 * the same request presented twice addresses the same operation (F10-AC3). This is the
 * value the adapter turns into the provider's own issue identity, which is what makes a
 * second attempt address one issue rather than two.
 */
export function publicationOperationId(requestId: string, workItemId: string): OperationId {
  return `pub:${requestId}:${workItemId}` as OperationId;
}

/**
 * The operation identity one managed delivery owns.
 *
 * Derived from the milestone so a repeat of the *same* milestone is refused by the ledger
 * before any provider call, while two different milestones get two different identities
 * and are both delivered (F16-AC3).
 */
export function managedDeliveryOperationId(workItemId: string, milestoneKey: string): OperationId {
  return `progress:${workItemId}:${milestoneKey}` as OperationId;
}

/** The operation identity one release-receipt publication owns (F29-AC4). */
export function receiptPublicationOperationId(workItemId: string, receiptId: string): OperationId {
  return `receipt:${workItemId}:${receiptId}` as OperationId;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Projects an accepted proposal into the adapter's publication revision (F10-AC1).
 *
 * The parameter is `PublishableTicket`, which the domain produces only from an
 * `AcceptedPlanTask`, so the refusal to publish an unaccepted proposal is in the type
 * rather than in a check a later refactor could drop. The title, scope and criteria are
 * checked because F10-AC1 names them as what an issue must carry, and a ticket published
 * without them would reach the provider as a title and a hope.
 */
export type RevisionFor = (
  ticket: PublishableTicket,
  workItemId: WorkItemId,
  targetTeamKey: string,
  dependencyIssueIds: readonly string[],
) => Result<ProposalRevision, DomainError>;

export function revisionFor(
  ticket: PublishableTicket,
  workItemId: WorkItemId,
  targetTeamKey: string,
  dependencyIssueIds: readonly string[],
): Result<ProposalRevision, DomainError> {
  const problems: { path: string; message: string }[] = [];
  if (ticket.title.trim().length === 0) {
    problems.push({ path: 'ticket.title', message: 'An accepted proposal must state a title to publish (F10-AC1).' });
  }
  if (ticket.scope.trim().length === 0) {
    problems.push({ path: 'ticket.scope', message: 'An accepted proposal must state the scope to publish (F10-AC1).' });
  }
  if (ticket.acceptanceCriteria.length === 0) {
    problems.push({
      path: 'ticket.acceptanceCriteria',
      message:
        'An accepted proposal with no acceptance criterion cannot be published: the issue would carry no way to say whether the work is done (F10-AC1).',
    });
  }
  if (targetTeamKey.trim().length === 0) {
    problems.push({
      path: 'targetTeamKey',
      message: 'The project profile names no ticket team, so there is nowhere to publish (F10-AC1, F02-AC1).',
    });
  }
  if (problems.length > 0) return err(invalid('This accepted proposal cannot be published as it stands.', problems));
  return ok({
    workItemId,
    revision: 1,
    title: ticket.title,
    description: ticket.scope,
    criteria: ticket.acceptanceCriteria.map((text, index) => ({ id: `${ticket.taskId}-ac-${index + 1}`, text })),
    dependencyIssueIds: [...dependencyIssueIds],
    targetTeamKey,
    acceptedByOwnerAt: ticket.acceptedAt,
  });
}

/**
 * Builds the publication use cases.
 *
 * `clock` and `ticket` are injected, so a decision recorded in a test replays identically
 * and no use case constructs a provider client or reads ambient time.
 */
export function createPublicationUseCases(deps: PublicationUseCaseDeps): PublicationUseCases {
  const providerText = deps.redactProviderText ?? ((text: string): string => redact(text).text);
  const publications = deps.publications;

  /**
   * The ambient context every provider call receives.
   *
   * The operation identity is the one derived for the write, because the client puts it in
   * a lost-response error and a reconciliation has to find it there (F30-AC5).
   */
  const contextFor = (operationId: OperationId, correlationId: string): AdapterContext => ({
    correlationId,
    operationId,
    clock: { now: () => deps.clock.now(), elapsedMs: () => 0 },
    logger: { emit: () => undefined },
    signal: new AbortController().signal,
    redact: providerText,
  });

  const requireOwner = (actor: OwnerActor): Result<true, DomainError> =>
    actor.role === 'Owner'
      ? ok(true)
      : err({
          code: 'Forbidden',
          reason: `Only the owner may publish agreed work; the ${actor.role} role may not (F10-AC1).`,
        });

  /**
   * F10-AC1, F10-AC2, F10-AC5: publishes the owner's accepted tickets.
   *
   * One ticket at a time, and one ledger operation per ticket, because partial failure is
   * a first-class outcome rather than an exception (F10-AC2). The order per ticket is
   * fixed and is the whole safety story:
   *
   *   1. ask the worklist whether this operation may be written again;
   *   2. if it may not, do not write - reconcile, or report that the outcome is unknown;
   *   3. otherwise record the intent and let the ledger's own gate answer once more;
   *   4. call the provider;
   *   5. settle the ledger, the row and the sync label in one write.
   *
   * A refusal or a lost response never aborts the remaining tickets: the caller needs to
   * know which of them published and which still owe a write (F10-AC2).
   */
  const publishAcceptedWork = async (
    input: PublishAcceptedWorkInput,
  ): Promise<Result<PublicationReport, DomainError>> => {
    const permitted = requireOwner(input.actor);
    if (!permitted.ok) return err(permitted.error);
    if (input.requestId.trim().length === 0) {
      return err(
        invalid('A publication request needs an identity.', [
          { path: 'requestId', message: 'Must not be empty; a retry presents the same one (F10-AC3).' },
        ]),
      );
    }
    if (input.tickets.length === 0) {
      return err(
        invalid('A publication request named no tickets.', [
          { path: 'tickets', message: 'Only accepted proposals may be published, and there were none (F10-AC1).' },
        ]),
      );
    }

    const now = deps.clock.now();
    const tickets: TicketPublication[] = [];
    for (const ticket of input.tickets) {
      const attempt = await publishOne(input, ticket, now);
      if (!attempt.ok) return err(attempt.error);
      tickets.push(attempt.value);
    }
    return ok({
      requestId: input.requestId,
      tickets,
      published: tickets.filter(isPublished).map((entry) => entry.workItemId),
      unpublished: tickets.filter((entry) => entry.kind !== 'Published').map((entry) => entry.workItemId),
    });
  };

  const publishOne = async (
    input: PublishAcceptedWorkInput,
    ticket: TicketToPublish,
    now: Instant,
  ): Promise<Result<TicketPublication, DomainError>> => {
    const operationId = publicationOperationId(input.requestId, ticket.workItemId);

    const decided = retryDecisionOrFirstAttempt(publications, operationId, now);
    if (!decided.ok) return decided;
    const permission = decided.value;
    if (permission.permitted) return writeAttempt(input, ticket, operationId, now);
    if (permission.basis === 'AlreadyApplied') {
      return confirmAlreadyApplied(input.correlationId, ticket, operationId, permission.providerIdentity);
    }

    // `OutcomeUnknown`, `StaleIntent` and `UnresolvedResolution` all mean the write may
    // already be at the provider. Repeating it is the duplicate this design exists to
    // prevent, so the ticket is reported unresolved and the operation is named so a
    // reconciliation can settle it (F30-AC5, N01-AC2).
    return ok({
      kind: 'OutcomeUnknown',
      workItemId: ticket.workItemId,
      operationId,
      detail:
        permission.basis === 'OutcomeUnknown'
          ? 'A previous attempt recorded an unresolved outcome, so whether the issue reached the provider is not established. Reconcile it against the provider before any retry (F30-AC5).'
          : `A previous attempt left this publication unresolved (${permission.basis}), so the provider may already hold the issue. Reconcile before any retry (F30-AC5, N01-AC2).`,
    });
  };

  /**
   * The one branch that actually issues a provider write.
   *
   * Split out because it is the only place in this module that does, and a reader looking
   * for the second write should find one function rather than a condition inside a loop.
   */
  const writeAttempt = async (
    input: PublishAcceptedWorkInput,
    ticket: TicketToPublish,
    operationId: OperationId,
    now: Instant,
  ): Promise<Result<TicketPublication, DomainError>> => {
    const begun = publications.beginPublication(
      { workItemId: ticket.workItemId, operationId },
      { projectId: input.projectId, correlationId: input.correlationId, at: now },
    );
    if (!begun.ok) return begun;

    const writable = publications.assertWritable(operationId, now);
    if (!writable.ok) return writable;

    const request: PublishWorkRequest = { operationId, revision: ticket.revision, adoptExistingIssueId: null };
    const published = await deps.ticket.publishWork(contextFor(operationId, input.correlationId), request);
    if (!published.ok) return settleRefusal(ticket, operationId, published.error, now);
    return settlePublished(ticket, operationId, published.value, now);
  };

  /**
   * The refusal and lost-response branches, which are different facts (F10-AC5, F30-AC5).
   *
   * `OutcomeUnknown` from the provider means the write may have landed, so both the ledger
   * and the row say so. Any other refusal means the provider declined, so the ledger holds
   * `Failed`, the row returns to `Unpublished` with the owner's selection intact, and a
   * retry is permitted without losing the mappings that already succeeded (F10-AC5).
   */
  const settleRefusal = (
    ticket: TicketToPublish,
    operationId: OperationId,
    error: DomainError,
    now: Instant,
  ): Result<TicketPublication, DomainError> => {
    if (error.code === 'OutcomeUnknown') {
      const unresolved = publications.settleUnresolved({
        workItemId: ticket.workItemId,
        operationId,
        detail: error.reason,
        observedAt: now,
      });
      if (!unresolved.ok) return unresolved;
      return ok({ kind: 'OutcomeUnknown', workItemId: ticket.workItemId, operationId, detail: error.reason });
    }
    const refused = publications.settleRefused({
      workItemId: ticket.workItemId,
      operationId,
      detail: error.reason,
      category: failureCategoryFor(error),
      observedAt: now,
    });
    if (!refused.ok) return refused;
    return ok({ kind: 'Failed', workItemId: ticket.workItemId, operationId, error });
  };

  const settlePublished = (
    ticket: TicketToPublish,
    operationId: OperationId,
    outcome: PublishWorkOutcome,
    now: Instant,
  ): Result<TicketPublication, DomainError> => {
    const issue = outcome.published[0];
    if (issue === undefined) {
      return err({
        code: 'Unavailable',
        reason:
          'The provider reported a publication with no issue in it, so nothing can be mapped. Read the operation in the reconciliation worklist rather than creating another issue (F10-AC2).',
      });
    }
    const settled = publications.settlePublished(
      {
        operationId,
        providerIssueId: issue.issue.issueId,
        providerIssueIdentifier: issue.issue.identifier,
        providerIssueUrl: issue.issue.url,
        providerRevision: issue.snapshot.providerRevision,
        publishedAt: now,
      },
      ticket.workItemId,
    );
    if (!settled.ok) return settled;
    return ok({
      kind: 'Published',
      workItemId: ticket.workItemId,
      issue: issue.issue,
      disposition: outcome.kind === 'AdoptedExisting' ? 'AdoptedExisting' : issue.disposition,
      unlinked: unlinkedFrom(outcome),
    });
  };

  /**
   * Reads back what a repeat of an already-applied publication reports (F10-AC3).
   *
   * The recorded mapping is the authority here, and the provider read is a refresh on top of
   * it. Reading the provider first and failing when it cannot be read would report an
   * already-completed publication as broken, which is the wrong answer: the write happened,
   * the row records where it went, and a provider that is briefly unreadable has not undone
   * any of it. So the recorded identity is returned, upgraded to the provider's live
   * reference when a read succeeds.
   *
   * An applied operation with neither a recorded identity nor a provider identity is a
   * disagreement between two stores, and it is reported rather than papered over: inventing
   * an identity here is how a duplicate gets created on the next retry.
   */
  const confirmAlreadyApplied = async (
    correlationId: string,
    ticket: TicketToPublish,
    operationId: OperationId,
    providerIdentity: string | null,
  ): Promise<Result<TicketPublication, DomainError>> => {
    const recorded = publications.requirePublishable(ticket.workItemId);
    if (!recorded.ok) return recorded;
    const stored = recorded.value.externalIssueId;
    const identity = stored ?? providerIdentity;
    if (identity === null) {
      return err({
        code: 'Unavailable',
        reason: `Operation ${operationId} is recorded as applied but neither the work item nor the ledger names the provider issue it created. Settle it in the reconciliation worklist rather than republishing (F10-AC3).`,
      });
    }

    const read = await deps.ticket.readScope(contextFor(operationId, correlationId), {
      workItemId: ticket.workItemId,
      issueId: identity as Parameters<TicketAdapter['readScope']>[1]['issueId'],
    });
    if (!read.ok) {
      return ok({
        kind: 'Published',
        workItemId: ticket.workItemId,
        issue: {
          issueId: identity as Parameters<TicketAdapter['readScope']>[1]['issueId'],
          identifier: recorded.value.externalIssueIdentifier ?? identity,
          url: recorded.value.externalIssueUrl ?? '',
        },
        disposition: 'AlreadyPresent',
        unlinked: [],
      });
    }
    return ok({
      kind: 'Published',
      workItemId: ticket.workItemId,
      issue: read.value.issue,
      disposition: 'AlreadyPresent',
      unlinked: [],
    });
  };

  /**
   * F10-AC3, F28-AC4, N01-AC2: records what reconciliation established about a publication
   * whose outcome was never recorded.
   *
   * The resolution row and the ledger status are written by the worklist in one
   * transaction, so a settled operation never still looks unresolved. Reconciling an
   * operation that is still in flight is refused: nothing was lost, so there is nothing to
   * establish, and recording a resolution would invent the doubt it claims to settle.
   */
  const reconcilePublication = (input: ReconcilePublicationInput): Result<ReconciledPublication, DomainError> => {
    const permitted = requireOwner(input.actor);
    if (!permitted.ok) return err(permitted.error);

    const decision = publications.retryDecision(input.operationId, input.observedAt);
    if (!decision.ok) return decision;
    if (decision.value.permitted) {
      return err(
        conflict(
          `Operation ${input.operationId} is ${decision.value.basis}, so its outcome is not in doubt`,
          'an operation whose outcome is not established',
          decision.value.basis,
        ),
      );
    }
    if (decision.value.basis === 'AlreadyApplied') {
      // Already settled. Reported rather than re-recorded, because writing a second
      // resolution would overwrite the identity that proved the first one, and a mapping
      // that changed without a write is exactly the drift F10-AC2 exists to prevent.
      const applied = publications.findOperation(input.operationId);
      if (applied === null) {
        return err({ code: 'NotFound', reason: `Operation ${input.operationId} is not recorded.` });
      }
      if (applied.operationRef === null) {
        return err({
          code: 'Unavailable',
          reason: `Operation ${input.operationId} is recorded as applied but carries no provider identity, so there is nothing to report (F10-AC3).`,
        });
      }
      return ok({ kind: 'Published', workItemId: applied.target as WorkItemId, issueId: applied.operationRef });
    }

    const applied =
      input.resolution.resolution === 'Applied'
        ? {
            resolution: 'Applied' as const,
            providerIdentity: input.resolution.providerIssueId,
            detail: input.resolution.detail,
            resolvedBy: input.resolvedBy,
            resolvedAt: input.observedAt,
            correlationId: input.correlationId,
          }
        : {
            resolution: input.resolution.resolution,
            detail: input.resolution.detail,
            resolvedBy: input.resolvedBy,
            resolvedAt: input.observedAt,
            correlationId: input.correlationId,
          };
    const resolved = publications.recordResolution(input.operationId, applied);
    if (!resolved.ok) return resolved;

    const operation = publications.findOperation(input.operationId);
    if (operation === null) {
      return err({ code: 'NotFound', reason: `Operation ${input.operationId} is not recorded.` });
    }
    const workItemId = operation.target as WorkItemId;

    if (input.resolution.resolution === 'Applied') {
      const settled = publications.settlePublished(
        {
          operationId: input.operationId,
          providerIssueId: input.resolution.providerIssueId,
          providerIssueIdentifier: input.resolution.providerIssueIdentifier,
          providerIssueUrl: input.resolution.providerIssueUrl,
          providerRevision: input.resolution.providerRevision,
          publishedAt: input.observedAt,
        },
        workItemId,
      );
      if (!settled.ok) return settled;
      return ok({ kind: 'Published', workItemId, issueId: input.resolution.providerIssueId });
    }

    if (input.resolution.resolution === 'NotApplied') {
      const reopened = publications.settleRefused({
        workItemId,
        operationId: input.operationId,
        detail: input.resolution.detail,
        category: 'TransientProvider',
        observedAt: input.observedAt,
      });
      if (!reopened.ok) return reopened;
      return ok({ kind: 'RetryPermitted', workItemId, operationId: input.operationId });
    }

    return ok({ kind: 'StillUnknown', workItemId, operationId: input.operationId });
  };

  /**
   * F16-AC2, F16-AC3, F16-AC4: publishes one meaningful milestone into one managed region.
   *
   * The operation identity is derived from the milestone, so a repeated milestone is
   * refused by the ledger before any provider call happens. That is the first of two
   * defences; the second is the adapter's own managed-comment identity, which bounds the
   * race the adapter documents as residual. Neither is reimplemented here.
   *
   * The managed region is read from the provider rather than chosen locally, because the
   * contract distinguishes an updatable comment from a delimited body block from an
   * append-only thread, and writing into the wrong one would rewrite a human's issue
   * (F16-AC2).
   */
  const publishManagedProgress = async (
    input: PublishManagedProgressInput,
  ): Promise<Result<ManagedDelivery, DomainError>> => {
    const permitted = requireOwner(input.actor);
    if (!permitted.ok) return err(permitted.error);
    if (input.milestoneKey.trim().length === 0) {
      return err(
        invalid('A managed delivery needs a milestone key.', [
          { path: 'milestoneKey', message: 'Must not be empty; it is the deduplication key (F16-AC3).' },
        ]),
      );
    }

    const issue = await publishedIssueFor(input, input.correlationId, 'managed progress');
    if (!issue.ok) return issue;
    const ready = issue.value;

    const operationId = managedDeliveryOperationId(input.workItemId, input.milestoneKey);
    const gate = await gateForDelivery(operationId);
    if (!gate.ok) return gate;
    if (gate.value === 'AlreadyDelivered') {
      return ok({ kind: 'Unchanged', workItemId: input.workItemId, deliveredMilestoneKey: input.milestoneKey });
    }
    if (gate.value === 'Unresolved') {
      return ok({
        kind: 'OutcomeUnknown',
        workItemId: input.workItemId,
        operationId,
        detail:
          'A previous delivery of this milestone is unresolved, so the provider may already hold it. Reconcile before any retry (F16-AC3, F30-AC5).',
      });
    }

    const delivered = await deliverToManagedRegion(
      {
        workItemId: input.workItemId,
        operationId,
        correlationId: input.correlationId,
        kind: PROGRESS_OPERATION_KIND,
      },
      ready,
      { milestoneKey: input.milestoneKey, body: providerText(input.body) },
    );
    if (!delivered.ok) return delivered;
    return settleDelivery(input.workItemId, operationId, delivered.value);
  };

  /**
   * F29-AC4: publishes a release receipt to the linked issue.
   *
   * The idempotency key is derived from the receipt identity, so a retry of the same
   * receipt is refused by the ledger and reported as already published without reaching
   * the provider. That is the publication half of F29-AC4 in full: no second comment is
   * written, because nothing is written at all on the retry.
   */
  const publishReleaseReceipt = async (
    input: PublishReleaseReceiptInput,
  ): Promise<Result<ReceiptPublication, DomainError>> => {
    const permitted = requireOwner(input.actor);
    if (!permitted.ok) return err(permitted.error);
    if (input.receiptId.trim().length === 0) {
      return err(
        invalid('A receipt publication needs a receipt identity.', [
          { path: 'receiptId', message: 'Must not be empty; it is the deduplication key (F29-AC4).' },
        ]),
      );
    }

    const issue = await publishedIssueFor(input, input.correlationId, 'a receipt');
    if (!issue.ok) return issue;
    const ready = issue.value;

    const operationId = receiptPublicationOperationId(input.workItemId, input.receiptId);
    const gate = await gateForDelivery(operationId);
    if (!gate.ok) return gate;
    if (gate.value === 'AlreadyDelivered') {
      return ok({ kind: 'AlreadyPublished', workItemId: input.workItemId, operationId });
    }
    if (gate.value === 'Unresolved') {
      return ok({
        kind: 'OutcomeUnknown',
        workItemId: input.workItemId,
        operationId,
        detail:
          'A previous receipt publication is unresolved, so the provider may already hold it. Reconcile before any retry (F29-AC4, F30-AC5).',
      });
    }

    const delivered = await deliverToManagedRegion(
      {
        workItemId: input.workItemId,
        operationId,
        correlationId: input.correlationId,
        kind: RECEIPT_OPERATION_KIND,
      },
      ready,
      { milestoneKey: `receipt:${input.receiptId}`, body: providerText(input.body) },
    );
    if (!delivered.ok) return delivered;
    const settled = settleDelivery(input.workItemId, operationId, delivered.value);
    if (!settled.ok) return settled;
    if (delivered.value.kind === 'Unchanged') {
      return ok({ kind: 'AlreadyPublished', workItemId: input.workItemId, operationId });
    }
    return ok({ kind: 'Published', workItemId: input.workItemId, operationId, deliveredAt: delivered.value.deliveredAt });
  };

  /**
   * A published work item's live issue and its managed region.
   *
   * Read from the provider rather than assembled locally, because the region shape decides
   * what a write would touch and only the provider knows which region ShipLoop owns
   * (F16-AC2). No region means no managed write: writing into unmanaged content would
   * overwrite a human's own note.
   */
  const publishedIssueFor = async (
    input: { readonly actor: OwnerActor; readonly workItemId: WorkItemId; readonly correlationId: string },
    correlationId: string,
    subject: string,
  ): Promise<Result<TicketScopeRead, DomainError>> => {
    const workItem = publications.requirePublishable(input.workItemId);
    if (!workItem.ok) return workItem;
    const issueId = workItem.value.externalIssueId;
    if (issueId === null) {
      return err(
        invalid(`This work item is not published, so ${subject} has no issue to reach.`, [
          {
            path: 'externalIssueId',
            message: `Publish the work item before sending ${subject} to its issue (F16-AC2).`,
          },
        ]),
      );
    }
    const operationId = `read:${input.workItemId}:${subject}` as OperationId;
    const read = await deps.ticket.readScope(contextFor(operationId, correlationId), {
      workItemId: input.workItemId,
      issueId: issueId as Parameters<TicketAdapter['readScope']>[1]['issueId'],
    });
    if (!read.ok) return read;
    if (read.value.managedRegions.length === 0) {
      return err({
        code: 'Unavailable',
        reason: `Issue ${read.value.issue.identifier} reports no managed region, so ${subject} would have nowhere managed to go. ShipLoop will not write into unmanaged content (F16-AC2).`,
      });
    }
    return ok(read.value);
  };

  /**
   * What the ledger says about a delivery that targets an already-published issue.
   *
   * `AlreadyDelivered` is the F16-AC3 answer for a repeated milestone: the write is done,
   * so reporting it is not a call. `Unresolved` means the provider may already hold it.
   */
  const gateForDelivery = async (operationId: string): Promise<Result<'Writable' | 'AlreadyDelivered' | 'Unresolved', DomainError>> => {
    const decided = retryDecisionOrFirstAttempt(publications, operationId, deps.clock.now());
    if (!decided.ok) return decided;
    if (decided.value.permitted) return ok('Writable');
    return ok(decided.value.basis === 'AlreadyApplied' ? 'AlreadyDelivered' : 'Unresolved');
  };

  const deliverToManagedRegion = async (
    request: {
      readonly workItemId: WorkItemId;
      readonly operationId: OperationId;
      readonly correlationId: string;
      /** The ledger kind, so reconciliation can tell a milestone from a receipt (F29-AC4). */
      readonly kind: string;
    },
    issue: TicketScopeRead,
    content: { readonly milestoneKey: string; readonly body: string },
  ): Promise<Result<ManagedProgressOutcome, DomainError>> => {
    const region = issue.managedRegions[0];
    if (region === undefined) {
      return err({
        code: 'Unavailable',
        reason: `Issue ${issue.issue.identifier} reports no managed region (F16-AC2).`,
      });
    }
    const now = deps.clock.now();
    const workItem = publications.requirePublishable(request.workItemId);
    if (!workItem.ok) return workItem;

    const begun = publications.beginExternalUpdate(request.operationId, {
      projectId: workItem.value.projectId,
      correlationId: request.correlationId,
      at: now,
      kind: request.kind,
      target: issue.issue.identifier,
    });
    if (!begun.ok) return begun;

    const writable = publications.assertWritable(request.operationId, now);
    if (!writable.ok) return writable;

    const managed: ManagedProgressUpdateRequest = {
      operationId: request.operationId,
      issueId: issue.issue.issueId,
      region: region.target,
      milestoneKey: content.milestoneKey,
      body: content.body,
      observedAt: now,
    };
    const delivered = await deps.ticket.updateManagedProgress(
      contextFor(request.operationId, request.correlationId),
      managed,
    );
    if (delivered.ok) return delivered;

    const settled =
      delivered.error.code === 'OutcomeUnknown'
        ? publications.settleUnresolved({
            workItemId: request.workItemId,
            operationId: request.operationId,
            detail: delivered.error.reason,
            observedAt: now,
            scope: 'ExternalUpdate',
          })
        : publications.settleRefused({
            workItemId: request.workItemId,
            operationId: request.operationId,
            detail: delivered.error.reason,
            category: failureCategoryFor(delivered.error),
            observedAt: now,
            scope: 'ExternalUpdate',
          });
    if (!settled.ok) return settled;
    return delivered;
  };

  /**
   * F16-AC4: a delivered milestone moves the work item's sync label and nothing else.
   *
   * An `Unchanged` answer is a delivery too: the provider confirmed the milestone is
   * already there, which is exactly the fact that makes a repeat safe.
   */
  const settleDelivery = (
    workItemId: WorkItemId,
    operationId: OperationId,
    outcome: ManagedProgressOutcome,
  ): Result<ManagedDelivery, DomainError> => {
    const recorded = publications.settleExternalUpdateDelivered({
      workItemId,
      operationId,
      providerRef: outcome.region.kind === 'UpdatableComment' ? outcome.region.commentId : null,
      deliveredAt: deps.clock.now(),
    });
    if (!recorded.ok) return recorded;
    if (outcome.kind === 'Unchanged') {
      return ok({ kind: 'Unchanged', workItemId, deliveredMilestoneKey: outcome.deliveredMilestoneKey });
    }
    return ok({ kind: 'Updated', workItemId, regionKind: outcome.region.kind, deliveredAt: outcome.deliveredAt });
  };

  const publicationTargets = (projectId: ProjectId): Result<readonly PublicationTarget[], DomainError> =>
    publications.listPublicationTargets(projectId);

  return {
    publishAcceptedWork,
    reconcilePublication,
    publishManagedProgress,
    publishReleaseReceipt,
    publicationTargets,
    revisionFor,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */


/**
 * Whether an operation may be written again, treating "never recorded" as a first attempt.
 *
 * `retryDecision` answers `NotFound` for an operation with no ledger row, which is the
 * normal state of a first attempt rather than a failure. Asking it anyway is what keeps
 * this module free of its own rule: there is exactly one place that knows when a second
 * write is safe, and it is the worklist (F10-AC3).
 */
export type WritePermission =
  | { readonly permitted: true }
  | {
      readonly permitted: false;
      readonly basis: 'AlreadyApplied' | 'OutcomeUnknown' | 'StaleIntent' | 'UnresolvedResolution';
      readonly providerIdentity: string | null;
    };

export function retryDecisionOrFirstAttempt(
  publications: PublicationRepository,
  operationId: string,
  now: Instant,
): Result<WritePermission, DomainError> {
  const decided = publications.retryDecision(operationId, now);
  if (decided.ok) {
    return ok(
      decided.value.permitted
        ? { permitted: true }
        : { permitted: false, basis: decided.value.basis, providerIdentity: decided.value.providerIdentity },
    );
  }
  return decided.error.code === 'NotFound' ? ok({ permitted: true }) : decided;
}

/**
 * Which ledger failure category a refusal belongs to.
 *
 * The category is what decides whether a retry may back off and how long, so it is derived
 * from the error's own code rather than from a message (F30-AC4).
 */
export function failureCategoryFor(error: DomainError): FailureCategory {
  switch (error.code) {
    case 'RateLimited':
      return 'RateLimited';
    case 'Forbidden':
      return 'PermissionDenied';
    case 'NotFound':
      return 'NotFound';
    case 'Conflict':
      return 'Conflict';
    case 'OutcomeUnknown':
      return 'OutcomeUnknown';
    case 'Invalid':
    case 'Blocked':
      return 'Validation';
    case 'Unavailable':
      return 'TransientProvider';
  }
}

function isPublished(entry: TicketPublication): entry is Extract<TicketPublication, { kind: 'Published' }> {
  return entry.kind === 'Published';
}

/**
 * The links a partial publication did not create, named rather than dropped (F10-AC2).
 *
 * The adapter reports each failed relation with its own target and error; this converts
 * that into the shape a caller renders, because a partial publication that silently
 * omitted its missing links would present as complete.
 */
function unlinkedFrom(outcome: PublishWorkOutcome): readonly FailedLink[] {
  if (outcome.kind !== 'PartiallyPublished') return [];
  return outcome.failed.map((failure) => ({ target: failure.target, reason: failure.error.reason }));
}
