import type {
  CapabilityKind,
  CheckResult,
  CommitSha,
  Fingerprint,
  OperationId,
  ProviderId,
  Result,
} from '@shiploop/domain';
import type { AdapterContext, AdapterIdentity, ArtifactReference, ManagedRegionTarget, TicketIssueRef } from './index.ts';

export type GitCapability = Extract<CapabilityKind, `Git:${string}`>;

/**
 * Repository identity as the provider reports it.
 *
 * `provider` stays a free string on purpose: GitHub and GitLab expose different
 * primitives (merge queues, approvals, preconditions) and collapsing them into
 * one shape here is exactly the assumed parity mvp-spec 7 forbids (L03-AC1).
 */
export interface GitRepositoryRef {
  readonly provider: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly url: string;
}

export type GitRefState =
  | { readonly kind: 'Branch'; readonly name: string; readonly sha: CommitSha }
  | { readonly kind: 'Commit'; readonly sha: CommitSha }
  | { readonly kind: 'Missing'; readonly name: string; readonly detail: string };

export interface PullRequestRef {
  readonly pullRequestId: ProviderId;
  /** Provider display number; null for providers that do not expose one. */
  readonly number: number | null;
  readonly url: string;
  readonly draft: boolean;
  readonly state: 'Open' | 'Closed' | 'Merged';
}

export type GitReviewState =
  | { readonly kind: 'Review'; readonly decision: 'Approved' | 'ChangesRequested' | 'Commented'; readonly reviewer: string; readonly submittedAt: string | null }
  | { readonly kind: 'ApprovalRulePending'; readonly rule: string; readonly detail: string }
  | { readonly kind: 'Unknown'; readonly detail: string };

export interface ReadGitStateRequest {
  readonly repository: GitRepositoryRef;
  readonly branch: string;
  readonly baseBranch: string;
}

/** Live repository, head, base, review and draft facts read together so they are consistent. */
export interface GitStateRead {
  readonly repository: GitRepositoryRef;
  readonly head: GitRefState;
  readonly base: GitRefState;
  readonly pullRequest: PullRequestRef | null;
  readonly reviews: readonly GitReviewState[];
  readonly observedAt: string;
}

export interface ReadChecksRequest {
  readonly repository: GitRepositoryRef;
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  /** Supplied by the controller, because only it knows the candidate being checked. */
  readonly candidateFingerprint: Fingerprint;
  /**
   * Supplied by the controller because only the project profile knows what is
   * required. A required name the provider did not report is returned as
   * `Missing`, never `Passed` (F20-AC2, F20-AC5).
   */
  readonly requiredCheckNames: readonly string[];
}

/** Where an obligation to run this check comes from, so a profile gate cannot be quietly dropped. */
export type CheckRequirement = 'ProfileRequired' | 'ProviderExtra';

export interface ProviderCheckObservation {
  readonly checkId: string;
  readonly name: string;
  readonly result: CheckResult;
  readonly requirement: CheckRequirement;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  /** Sanitized detail. Raw provider output may contain credentials (N02-AC2). */
  readonly detail: string | null;
  readonly artifactUrl: string | null;
}

export type ForceStrategy = 'RejectNonFastForward' | 'ForceWithLease';

export interface PushBranchRequest {
  readonly operationId: OperationId;
  readonly repository: GitRepositoryRef;
  readonly branch: string;
  readonly headSha: CommitSha;
  readonly forceStrategy: ForceStrategy;
}

export type PushBranchOutcome =
  | { readonly kind: 'Pushed'; readonly branch: string; readonly sha: CommitSha; readonly remoteUrl: string }
  | { readonly kind: 'AlreadyPresent'; readonly branch: string; readonly sha: CommitSha };

export type DraftLinkTarget =
  | { readonly kind: 'Ticket'; readonly issue: TicketIssueRef }
  | { readonly kind: 'None'; readonly reason: string };

/**
 * What the adapter claims about a check inside a draft body.
 *
 * A claim can only name a check that actually reported a result, so "not run"
 * cannot be phrased as "passed" (F19-AC2). Agent text does not reach this type.
 */
export type VerificationClaim =
  | { readonly kind: 'NotRun'; readonly reason: string }
  | { readonly kind: 'ReportedPassed'; readonly checkId: string }
  | { readonly kind: 'ReportedFailed'; readonly checkId: string }
  | { readonly kind: 'ReportedPending'; readonly checkId: string };

export interface DraftCriterionLine {
  readonly criterionId: string;
  readonly text: string;
  readonly claim: VerificationClaim;
}

export interface DraftCheckLine {
  readonly name: string;
  readonly claim: VerificationClaim;
}

export type DraftVerificationSummary =
  | { readonly kind: 'NotRun'; readonly reason: string }
  | { readonly kind: 'Observed'; readonly checks: readonly DraftCheckLine[] };

export interface DraftBody {
  /**
   * Machine-readable identity of the ShipLoop managed region, including the
   * operation that created it. A retry reads this marker before writing, so a
   * lost create response is recovered instead of producing a second draft
   * (F19-AC3, F16-AC3).
   */
  readonly managedMarker: string;
  readonly purpose: string;
  readonly scope: string;
  readonly criteria: readonly DraftCriterionLine[];
  readonly knownGaps: readonly string[];
  readonly verification: DraftVerificationSummary;
  readonly linkedWork: DraftLinkTarget;
  /** Managed progress region on the draft itself, when the provider supports one (F16-AC2). */
  readonly managedProgressRegion: ManagedRegionTarget | null;
}

export interface DraftRef {
  readonly pullRequest: PullRequestRef;
  readonly headSha: CommitSha;
  readonly baseBranch: string;
  readonly link: DraftLinkTarget;
  readonly managedMarker: string;
  readonly bodyDigest: string;
}

export interface FindDraftsRequest {
  readonly repository: GitRepositoryRef;
  readonly headSha: CommitSha;
  readonly link: DraftLinkTarget;
  readonly operationId: OperationId;
}

export interface UpsertDraftRequest {
  readonly operationId: OperationId;
  readonly repository: GitRepositoryRef;
  readonly baseBranch: string;
  readonly headSha: CommitSha;
  /** Result of a preceding `findDrafts` reconciliation, or null when none exists. */
  readonly existingDraft: DraftRef | null;
  readonly title: string;
  readonly body: DraftBody;
  readonly link: DraftLinkTarget;
}

export type UpsertDraftOutcome =
  | { readonly kind: 'Created'; readonly draft: DraftRef }
  | { readonly kind: 'Updated'; readonly draft: DraftRef; readonly changedSections: readonly string[] }
  | { readonly kind: 'Unchanged'; readonly draft: DraftRef }
  | {
      readonly kind: 'RecoveredAfterLostResponse';
      readonly draft: DraftRef;
      readonly detail: string;
    };

export type NoCodeReason =
  | 'ReadOnlyJob'
  | 'NoChangeRequired'
  | 'ScopeSatisfiedWithoutEdit'
  | 'OwnerReducedScope';

export interface DeclareNoCodeOutcomeRequest {
  readonly operationId: OperationId;
  readonly repository: GitRepositoryRef;
  readonly branch: string;
  readonly reason: NoCodeReason;
  readonly evidence: readonly ArtifactReference[];
  readonly declaredAt: string;
}

/**
 * The stated outcome of a job that produced no code change.
 *
 * `pullRequest` is pinned to `null`, so "open an empty change to have something
 * to link" is not expressible (F19-AC5).
 */
export interface NoCodeOutcomeRecord {
  readonly reason: NoCodeReason;
  readonly branchState: 'NeverPushed' | 'PushedWithoutDraft';
  readonly pullRequest: null;
  readonly evidence: readonly ArtifactReference[];
  readonly declaredAt: string;
}

export type MergeMethod = 'Squash' | 'Merge' | 'Rebase';

/**
 * The protection a merge carries.
 *
 * A provider with a compare-and-set head is required to use it. A provider
 * without one may only proceed with a stated race limitation the owner
 * accepted, which is the honest alternative to claiming atomicity (F26-AC3,
 * F30-AC5).
 */
export type MergePrecondition =
  | { readonly kind: 'ProviderExpectedHead'; readonly expectedHeadSha: CommitSha }
  | {
      readonly kind: 'NoProviderPrecondition';
      readonly recheckedAt: string;
      readonly raceLimitation: string;
      readonly ownerAcceptedRace: true;
    };

export interface MergePullRequestRequest {
  readonly operationId: OperationId;
  readonly authorizationId: string;
  readonly repository: GitRepositoryRef;
  readonly pullRequestId: ProviderId;
  readonly expectedHeadSha: CommitSha;
  readonly targetBranch: string;
  readonly method: MergeMethod;
  readonly precondition: MergePrecondition;
}

/** Whether the merged content is the content the owner authorized (F26-AC4). */
export type ContentRelation =
  | { readonly kind: 'MatchesAuthorizedHead' }
  | { readonly kind: 'DiffersFromAuthorizedHead'; readonly detail: string };

export type MergeOutcome =
  | {
      readonly kind: 'Merged';
      readonly mergeCommitSha: CommitSha;
      readonly headSha: CommitSha;
      readonly targetBranch: string;
      readonly mergedAt: string;
      readonly contentRelation: ContentRelation;
    }
  | { readonly kind: 'AlreadyMerged'; readonly mergeCommitSha: CommitSha; readonly mergedAt: string };

/**
 * Git provider contract.
 *
 * A failed head precondition is `Conflict`, a lost merge response is
 * `OutcomeUnknown`, and an operation the provider cannot perform is
 * `Unavailable`. Only the first two may be retried after reconciling live state;
 * the third must be shown as unavailable (F26-AC3, F30-AC2, L03-AC3).
 */
export interface GitAdapter extends AdapterIdentity {
  readonly kind: 'Git';
  readState(
    context: AdapterContext,
    request: ReadGitStateRequest,
  ): Promise<Result<GitStateRead>>;
  readChecks(
    context: AdapterContext,
    request: ReadChecksRequest,
  ): Promise<Result<readonly ProviderCheckObservation[]>>;
  pushBranch(
    context: AdapterContext,
    request: PushBranchRequest,
  ): Promise<Result<PushBranchOutcome>>;
  findDrafts(
    context: AdapterContext,
    request: FindDraftsRequest,
  ): Promise<Result<readonly DraftRef[]>>;
  upsertDraft(
    context: AdapterContext,
    request: UpsertDraftRequest,
  ): Promise<Result<UpsertDraftOutcome>>;
  declareNoCodeOutcome(
    context: AdapterContext,
    request: DeclareNoCodeOutcomeRequest,
  ): Promise<Result<NoCodeOutcomeRecord>>;
  mergePullRequest(
    context: AdapterContext,
    request: MergePullRequestRequest,
  ): Promise<Result<MergeOutcome>>;
}
