import type {
  CapabilityKind,
  DomainError,
  OperationId,
  ProviderId,
  Result,
  ScopeCriterion,
  ScopeSnapshot,
  WorkItemId,
} from '@shiploop/domain';
import type { AdapterContext, AdapterIdentity } from './index.ts';

export type TicketCapability = Extract<CapabilityKind, `Ticket:${string}`>;

/**
 * Provider state of an issue, kept as the provider's own state plus how it was
 * mapped.
 *
 * The nested `terminal` value is what stops a provider state named "Done" from
 * being read as release confirmation: closure is requested only after a confirmed
 * delivery, never inferred from a workflow name (F29-AC3, F29-AC5).
 */
export type TicketState =
  | {
      readonly kind: 'ProviderState';
      readonly name: string;
      readonly terminal: 'Done' | 'Cancelled' | 'None';
    }
  | { readonly kind: 'Unknown'; readonly detail: string };

export interface TicketIssueRef {
  readonly issueId: ProviderId;
  readonly identifier: string;
  readonly url: string;
}

export type TicketRelationKind = 'Blocks' | 'BlockedBy' | 'Related' | 'Duplicate';

export interface TicketRelation {
  readonly kind: TicketRelationKind;
  readonly issue: TicketIssueRef;
}

/**
 * Where ShipLoop's own progress text lives in the provider.
 *
 * The three variants are deliberately not flattened into one shape: a provider
 * with an updatable comment, a provider with a delimited managed block in the
 * body, and a provider that can only append are genuinely different capabilities
 * (F16-AC3, and L03-AC1 on not assuming parity between providers).
 */
export type ManagedRegionTarget =
  | { readonly kind: 'UpdatableComment'; readonly commentId: ProviderId }
  | { readonly kind: 'ManagedBodyBlock'; readonly blockId: string }
  | { readonly kind: 'AppendOnlyCommentThread'; readonly lastCommentId: ProviderId | null };

export interface ManagedRegion {
  readonly target: ManagedRegionTarget;
  /** Deduplication key of the last milestone actually delivered (F16-AC3). */
  readonly lastMilestoneKey: string | null;
  readonly lastDeliveredAt: string | null;
  /** Digest of the last delivered content, so an unchanged republish is skipped. */
  readonly lastDeliveredContentDigest: string | null;
}

export interface ReadTicketScopeRequest {
  readonly workItemId: WorkItemId;
  readonly issueId: ProviderId;
}

/** Live provider facts about one issue plus the immutable snapshot derived from them. */
export interface TicketScopeRead {
  readonly issue: TicketIssueRef;
  readonly snapshot: ScopeSnapshot;
  readonly state: TicketState;
  readonly relations: readonly TicketRelation[];
  /** Regions ShipLoop owns. Anything else in the issue belongs to a human. */
  readonly managedRegions: readonly ManagedRegion[];
  readonly observedAt: string;
}

export interface RelatedIssueSearchRequest {
  readonly workItemId: WorkItemId;
  readonly scope: ScopeSnapshot;
  readonly limit: number;
}

export type RelatedIssueRelation = 'PotentialDuplicate' | 'Related' | 'DependentWork' | 'ExplicitLink';

export type RelatedIssueSignal =
  | 'TitleOverlap'
  | 'DescriptionOverlap'
  | 'SharedLabel'
  | 'SharedComponent'
  | 'ExplicitLink'
  | 'RecentActivity';

/**
 * Whether a related issue was adopted.
 *
 * There is no auto-adopt variant: resemblance is surfaced for the owner to
 * decide, never merged by the adapter (F06-AC4).
 */
export type RelatedIssueAdoption =
  | { readonly kind: 'RequiresOwnerDecision'; readonly reason: string }
  | { readonly kind: 'OwnerSelected'; readonly decidedAt: string }
  | { readonly kind: 'NotAdoptable'; readonly reason: string };

export interface RelatedIssue {
  readonly issue: TicketIssueRef;
  readonly relation: RelatedIssueRelation;
  readonly state: TicketState;
  readonly matchedOn: readonly RelatedIssueSignal[];
  /** Provider-reported similarity in [0, 1]. Presentation only; never a decision input. */
  readonly similarity: number;
  readonly adoption: RelatedIssueAdoption;
}

/** The owner-accepted proposal revision that publication publishes, keyed by revision number. */
export interface ProposalRevision {
  readonly workItemId: WorkItemId;
  readonly revision: number;
  readonly title: string;
  readonly description: string;
  readonly criteria: readonly ScopeCriterion[];
  readonly dependencyIssueIds: readonly string[];
  readonly targetTeamKey: string;
  readonly acceptedByOwnerAt: string;
}

export interface PublishWorkRequest {
  /** Stable identity of this publication; a retry with the same id must not create a second issue (F10-AC3). */
  readonly operationId: OperationId;
  readonly revision: ProposalRevision;
  readonly adoptExistingIssueId: ProviderId | null;
}

/**
 * Why a single issue in a partial publication failed, so the remaining issues
 * stay recoverable instead of being republished wholesale (F10-AC3).
 */
export interface FailedTicketPublish {
  readonly target: string;
  readonly operationId: OperationId;
  readonly error: DomainError;
}

export type PublishedIssueDisposition = 'CreatedNew' | 'AlreadyPresent';

export interface PublishedIssue {
  readonly issue: TicketIssueRef;
  readonly disposition: PublishedIssueDisposition;
  readonly snapshot: ScopeSnapshot;
}

export type PublishWorkOutcome =
  | { readonly kind: 'Published'; readonly published: readonly PublishedIssue[] }
  | { readonly kind: 'AdoptedExisting'; readonly published: readonly PublishedIssue[] }
  | {
      readonly kind: 'PartiallyPublished';
      readonly published: readonly PublishedIssue[];
      readonly failed: readonly FailedTicketPublish[];
      /** True when re-running the same operationId can finish the remaining work. */
      readonly recoverable: true;
    };

export interface ManagedProgressUpdateRequest {
  readonly operationId: OperationId;
  readonly issueId: ProviderId;
  readonly region: ManagedRegionTarget;
  /** Deduplication key for this milestone, so repeated delivery is not a new comment (F16-AC3). */
  readonly milestoneKey: string;
  /** Rendered managed content, already redacted. Human discussion is never part of it (F16-AC2). */
  readonly body: string;
  readonly observedAt: string;
}

export type ManagedProgressOutcome =
  | {
      readonly kind: 'Updated';
      readonly region: ManagedRegionTarget;
      readonly previousMilestoneKey: string | null;
      readonly deliveredAt: string;
    }
  | {
      readonly kind: 'Unchanged';
      readonly region: ManagedRegionTarget;
      readonly deliveredMilestoneKey: string;
      readonly deliveredAt: string;
    };

export interface TicketTransitionDescriptor {
  readonly transitionId: string;
  readonly fromStates: readonly string[];
  readonly toState: string;
  readonly terminal: 'Done' | 'Cancelled' | 'None';
}

export interface DescribeTransitionsRequest {
  readonly issueId: ProviderId;
}

export interface TicketTransitionRequest {
  readonly operationId: OperationId;
  readonly issueId: ProviderId;
  /** Identifier of a transition the project profile configured, never free-form state text (F29-AC3). */
  readonly transitionId: string;
  readonly expectedState: TicketState | null;
  readonly reason: string;
}

export type TicketTransitionOutcome =
  | {
      readonly kind: 'Applied';
      readonly from: TicketState;
      readonly to: TicketState;
      readonly appliedAt: string;
    }
  | { readonly kind: 'AlreadyInState'; readonly state: TicketState };

/**
 * Linear-first ticket provider contract.
 *
 * Reads produce `ScopeSnapshot` values the controller compares against the
 * recorded one (F12); writes are keyed by `OperationId` so a lost response is
 * reconciled instead of duplicated (F10-AC3, F30-AC5). An operation this provider
 * cannot perform returns `Unsupported` as `Unavailable`, which is a different
 * outcome from a `Failed` call and must never be shown as progress.
 */
export interface TicketAdapter extends AdapterIdentity {
  readonly kind: 'Ticket';
  readScope(
    context: AdapterContext,
    request: ReadTicketScopeRequest,
  ): Promise<Result<TicketScopeRead>>;
  findRelatedIssues(
    context: AdapterContext,
    request: RelatedIssueSearchRequest,
  ): Promise<Result<readonly RelatedIssue[]>>;
  publishWork(
    context: AdapterContext,
    request: PublishWorkRequest,
  ): Promise<Result<PublishWorkOutcome>>;
  updateManagedProgress(
    context: AdapterContext,
    request: ManagedProgressUpdateRequest,
  ): Promise<Result<ManagedProgressOutcome>>;
  describeTransitions(
    context: AdapterContext,
    request: DescribeTransitionsRequest,
  ): Promise<Result<readonly TicketTransitionDescriptor[]>>;
  requestTransition(
    context: AdapterContext,
    request: TicketTransitionRequest,
  ): Promise<Result<TicketTransitionOutcome>>;
}
