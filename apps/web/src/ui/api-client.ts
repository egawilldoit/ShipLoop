/**
 * The single HTTP boundary for the owner UI.
 *
 * Every `fetch` in this application lives in this file. The server API is built by
 * another agent, so the response shapes this client depends on are declared here as
 * local interfaces rather than imported: `@shiploop/domain` re-exports modules that
 * reach for `node:crypto`, which cannot be bundled into a browser build. Integration is
 * therefore a one-file adjustment - either these interfaces are deleted in favour of the
 * server's own types, or the server is adjusted to answer in these shapes.
 *
 * The error shape mirrors the domain's command result so that "you must supply
 * information", "your view is stale" and "we do not know whether the write happened"
 * stay distinguishable in the UI (Blocked / Conflict / OutcomeUnknown). `Unauthorized` is
 * the one addition: a refused session has no domain equivalent and is the signal that the
 * app must return to sign-in (F01-AC2).
 */

/** Header carrying the derived CSRF token on every state-changing call (F01-AC4). */
export const CSRF_HEADER = 'x-shiploop-csrf';

/**
 * Refresh cadence for live data. N04-AC2 requires a persisted milestone to be visible
 * within five seconds, so the poll must be strictly faster than that budget.
 */
export const LIVE_REFRESH_MS = 4000;

export type ApiErrorCode =
  | 'Blocked'
  | 'Conflict'
  | 'OutcomeUnknown'
  | 'Invalid'
  | 'NotFound'
  | 'Forbidden'
  | 'RateLimited'
  | 'Unavailable'
  | 'Unauthorized';

const API_ERROR_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
  'Blocked',
  'Conflict',
  'OutcomeUnknown',
  'Invalid',
  'NotFound',
  'Forbidden',
  'RateLimited',
  'Unavailable',
  'Unauthorized',
]);

/**
 * The prefix every artifact is served under, and the only one this client links to.
 *
 * The server registers that prefix behind the session guard, so an artifact link is a request
 * this browser's session authorizes and nothing else. A recorded artifact is private run
 * detail, and a link that bypassed the guard would make the file public while still looking
 * like every other link on the card (F01-AC1, N02-AC2).
 */
export const ARTIFACT_PREFIX = '/artifacts/';

/**
 * The session-guarded URL for one store-relative artifact reference, or null when it has none.
 *
 * A recorded `artifactRef` is a name inside the artifact store (`logs/exit-zero.log`), never a
 * URL. Turning it into one is a boundary decision, so it is made once here and refuses
 * anything that is not a plain relative path inside the store: an absolute path, a scheme, a
 * backslash, a control character, or any `.`/`..`/empty segment. A null means the reference
 * cannot be addressed, and the caller must say so rather than emit a link to something else —
 * a link to a path the server does not serve would present unavailable content as if it were
 * an artifact (F01-AC1, F24-AC5).
 */
export function artifactHref(reference: string): string | null {
  const trimmed = reference.trim();
  if (trimmed === '') return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(trimmed)) return null;
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return `${ARTIFACT_PREFIX}${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

/** One rejected field, carrying the form path the message belongs next to (F02-AC4). */
export interface ApiFieldError {
  readonly path: string;
  readonly message: string;
}

/**
 * One prerequisite a `Blocked` refusal names, with what to do about it (F04-AC3).
 *
 * Carried rather than folded into the reason because "blocked" alone tells the owner nothing
 * actionable: an acceptance refusal that said only that a criterion was outstanding would
 * leave the owner to guess which one (F25-AC1).
 */
export interface ApiPrerequisite {
  readonly name: string;
  readonly detail: string;
  readonly remedy: string;
}

/** The failure every call reports instead of throwing, so pages can render it as state. */
export interface ApiFailure {
  readonly code: ApiErrorCode;
  readonly reason: string;
  readonly fields: readonly ApiFieldError[];
  /** The unmet prerequisites of a `Blocked` refusal; empty for every other code (F04-AC3). */
  readonly prerequisites: readonly ApiPrerequisite[];
}

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiFailure };

/**
 * The signed-in owner. Identity only: never a credential or a token (F03-AC3).
 *
 * `email` is the address read back from the owner row. It was `string` here while the
 * server sent no such field at all, so the header rendered an empty pair of parentheses and
 * no type in this file noticed; it is nullable because an owner row can carry no address,
 * and a client must show that fact rather than an empty string (F01-AC1).
 */
export interface OwnerIdentity {
  readonly ownerId: string;
  readonly email: string | null;
  readonly displayName: string;
}

/** Repository and provider identity a profile points at (F02-AC1). */
export interface RepositoryIdentity {
  readonly provider: string;
  readonly repositoryUrl: string;
  readonly fullName: string;
}

export interface ProfileSummary {
  readonly profileId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly name: string;
  readonly repository: RepositoryIdentity;
  readonly targetBranch: string;
  readonly ticketTeamKey: string;
  readonly currentVersionId: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface ProfileListResponse {
  readonly profiles: readonly ProfileSummary[];
}

export type ProfileVerificationState = 'Verified' | 'Pending' | 'Unverified';

export interface ProfileVersion {
  readonly versionId: string;
  readonly profileId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly summary: string;
  readonly verificationState: ProfileVerificationState;
  readonly verificationDetail: string;
}

export interface ProfileVersionListResponse {
  readonly versions: readonly ProfileVersion[];
}

export interface ProfileDraft {
  readonly name: string;
  readonly provider: string;
  readonly repositoryUrl: string;
  readonly repositoryFullName: string;
  readonly ticketTeamKey: string;
  readonly ticketStateMapping: string;
  readonly targetBranch: string;
  readonly engineImage: string;
  readonly engineSandbox: 'Restricted' | 'Standard';
  readonly requiredChecks: readonly string[];
  readonly previewEnvironment: string;
  readonly deliveryStrategy: 'PullRequest' | 'DraftThenMerge';
  readonly deliveryRequiresAcceptance: boolean;
}

export interface CreateProfileRequest extends ProfileDraft {
  readonly projectId: string;
}

export interface CreateProfileResponse {
  readonly profile: ProfileSummary;
  readonly version: ProfileVersion;
}

export type ConnectorState = 'Healthy' | 'Degraded' | 'Revoked' | 'Unconfigured';

export type ConnectorType = 'RepositoryHost' | 'TicketTracker' | 'DeploymentTarget' | 'EngineHost';

/**
 * A connector as the UI is allowed to see it (F03-AC3).
 *
 * There is deliberately no credential field. The server returns a reference label naming
 * where the secret lives ("env:REPO_TOKEN"); the secret itself must never reach a UI
 * response, and a type with no place to put it is harder to violate than a convention.
 */
export interface ConnectorView {
  readonly connectorId: string;
  readonly profileId: string | null;
  readonly provider: string;
  readonly connectorType: ConnectorType;
  readonly state: ConnectorState;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly limitations: readonly { readonly kind: string; readonly limitation: string }[];
  readonly error: string | null;
  readonly remedy: string | null;
  readonly credentialReference: string;
}

export interface ConnectorListResponse {
  readonly connectors: readonly ConnectorView[];
}

export interface CreateConnectorRequest {
  readonly profileId: string | null;
  readonly provider: string;
  readonly connectorType: ConnectorType;
  readonly credentialReference: string;
}

export type IntakeRequestKind = 'FeatureRequest' | 'Bug';

export type IntakeDisposition = 'Unpublished' | 'Published' | 'Deferred' | 'Archived';

export interface BugDetail {
  readonly expected: string | null;
  readonly actual: string | null;
  readonly reproduction: string | null;
}

/** A named attachment row. Never its content: attachments are files (F06-AC1). */
export interface IntakeAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly addedAt: string;
}

/**
 * A generated summary, kept apart from the raw request (F06-AC1).
 *
 * `rawRequestFingerprint` is the fingerprint of the exact request this describes, so
 * the two can always be traced to each other. `null` means no summary has been
 * generated, which is different from an empty summary.
 */
export interface GeneratedSummary {
  readonly text: string;
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly rawRequestFingerprint: string;
}

/** One captured request (F06-AC1, F06-AC3, F06-AC5). */
export interface IntakeIdea {
  readonly ideaId: string;
  readonly rawRequest: string;
  readonly projectId: string | null;
  readonly notes: string | null;
  readonly kind: IntakeRequestKind;
  readonly bugDetail: BugDetail;
  readonly attachments: readonly IntakeAttachment[];
  readonly summary: GeneratedSummary | null;
  readonly disposition: IntakeDisposition;
  readonly dispositionDetail: string | null;
  readonly capturedAt: string;
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly text: string;
  readonly verification: string | null;
}

/** The seven sections F07-AC1 names. Every section is present; a list may be empty. */
export interface BriefSections {
  readonly problem: string;
  readonly desiredOutcome: string;
  readonly includedBehaviour: readonly string[];
  readonly excludedBehaviour: readonly string[];
  readonly assumptions: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly unresolvedQuestions: readonly string[];
}

export interface BriefVersion {
  readonly version: number;
  readonly state: 'Proposed' | 'Agreed';
  readonly authoredBy: string;
  readonly authoredAt: string;
  readonly supersedesVersion: number | null;
  readonly rawRequestFingerprint: string;
  readonly sections: BriefSections;
  readonly agreedBy: string | null;
  readonly agreedAt: string | null;
  readonly withdrawnCriterionIds: readonly string[];
}

export interface Brief {
  readonly briefId: string | null;
  readonly currentVersion: number | null;
  readonly current: BriefVersion | null;
  readonly versions: readonly BriefVersion[];
}

export interface ClarifyingQuestion {
  readonly questionId: string;
  readonly topic: string;
  readonly prompt: string;
  readonly readings: readonly string[];
  readonly whyMaterial: string;
  readonly origin: 'Ambiguity' | 'UnobservableCriterion';
  readonly state: 'Open' | 'Answered';
  readonly answer: string | null;
  readonly askedAt: string;
  readonly answeredAt: string | null;
}

/** A candidate question that was considered and declined (F07-AC2). */
export interface RejectedCandidate {
  readonly topic: string;
  readonly rejection: string;
  readonly explanation: string;
}

export interface IntakeTurn {
  readonly kind: 'RawRequest' | 'Question' | 'Answer' | 'Correction';
  readonly at: string;
  readonly text: string;
  readonly reference: string | null;
}

export interface IntakeDetail {
  readonly idea: IntakeIdea;
  readonly brief: Brief;
  readonly questions: readonly ClarifyingQuestion[];
  readonly rejected: readonly RejectedCandidate[];
  readonly turns: readonly IntakeTurn[];
}

/**
 * A resemblance report and the choices the owner holds (F06-AC4).
 *
 * `mergeable` and `discardable` are literal `false`, so no score can be read as a
 * merge, and `disposition` is one literal: the owner has not decided yet.
 */
export interface RelatednessReport {
  readonly candidateIdeaId: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly mergeable: false;
  readonly discardable: false;
  readonly disposition: 'OwnerChoiceRequired';
  readonly ownerChoices: readonly RelatedWorkChoice[];
}

export type RelatedWorkChoice = 'LinkToExisting' | 'ExtendExisting' | 'CreateNewIssue';

export interface RelatedWorkChoiceOutcome {
  readonly candidateIdeaId: string;
  readonly choice: RelatedWorkChoice;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly merged: false;
  readonly dispositionAfterChoice: {
    readonly idea: IntakeDisposition;
    readonly candidate: IntakeDisposition;
  };
}

export interface IntakeAmbiguity {
  readonly kind:
    | 'UnspecifiedSubject'
    | 'ConflictingStatement'
    | 'MissingAcceptanceThreshold'
    | 'UnstatedScopeBoundary'
    | 'UnresolvedDependency';
  readonly topic: string;
  readonly readings: readonly string[];
  readonly answeredBy: readonly string[];
  readonly impact: 'ChangesBehaviour' | 'ChangesAcceptance' | 'Cosmetic';
  readonly evidence: string;
}

export interface ClarificationRound {
  readonly questions: readonly ClarifyingQuestion[];
  readonly rejected: readonly RejectedCandidate[];
}

export interface CorrectionOutcome {
  readonly currentVersion: BriefVersion;
  readonly priorVersion: BriefVersion;
  readonly withdrawnCriterionIds: readonly string[];
}

export interface IntakeIdeaExport {
  readonly ideaId: string;
  readonly kind: IntakeRequestKind;
  readonly capturedAt: string;
  readonly rawRequest: string;
  readonly notes: string | null;
  readonly projectId: string | null;
  readonly bugDetail: BugDetail;
  readonly summary: GeneratedSummary | null;
  readonly disposition: { readonly state: string; readonly detail: string | null };
  readonly attachments: readonly {
    readonly fileName: string;
    readonly mediaType: string;
    readonly byteSize: number;
    readonly contentDigest: string;
  }[];
}

/**
 * One proposed task, with the acceptance that makes it publishable (F08-AC3).
 *
 * `publishable` is read from the server rather than derived here: it is false for
 * anything the owner has not accepted, and a client that recomputed it from
 * `acceptance` would be a second opinion about which tasks may become tickets
 * (F08-AC3). `implementationLocation.kind` is always `ProposedLocation`, so a
 * suggestion cannot be rendered as an inspected fact (F08-AC5).
 */
export interface PlanTask {
  readonly taskId: string;
  readonly outcome: string;
  readonly scope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly verificationMethod: string;
  readonly dependencies: readonly string[];
  readonly relevantProjectContext: readonly string[];
  readonly implementationLocation: {
    readonly kind: 'ProposedLocation';
    readonly candidates: readonly string[];
    readonly basis: string;
  };
  readonly acceptance: 'Proposed' | 'Accepted' | 'Removed';
  readonly acceptedBy: string | null;
  readonly acceptedAt: string | null;
  readonly removedBy: string | null;
  readonly removedAt: string | null;
  readonly publishable: boolean;
}

/** Why one task cannot be declared ready, which is what F08-AC4 asks to be visible. */
export type PlanTaskReadinessBlocker =
  | { readonly kind: 'Cycle'; readonly cycle: readonly string[] }
  | { readonly kind: 'UnresolvedDependency'; readonly dependsOn: string };

/** A task's readiness within the plan: ready after its prerequisites, or blocked (F08-AC4). */
export interface PlanTaskReadiness {
  readonly taskId: string;
  readonly ready: boolean;
  readonly readyAfter: readonly string[];
  readonly blockedBy: readonly PlanTaskReadinessBlocker[];
}

/** A plan as the owner reviews it, with the reason it has the tasks it has (F08-AC2). */
export interface Plan {
  readonly planId: string;
  readonly ideaId: string;
  readonly briefId: string;
  readonly revision: number;
  readonly draftedAt: string;
  readonly lastEditedAt: string | null;
  readonly lastEditedBy: string | null;
  readonly requestedOutcomes: readonly { readonly id: string; readonly statement: string }[];
  readonly exclusions: readonly { readonly outcomeId: string; readonly excluded: string; readonly reason: string }[];
  readonly coverage: readonly {
    readonly outcomeId: string;
    readonly via: 'Task' | 'Exclusion';
    readonly taskId?: string;
    readonly reason?: string;
  }[];
  readonly split: {
    readonly split: boolean;
    readonly reason: string;
    readonly justifications: readonly ('IndependentlyReviewable' | 'RealDependency')[];
    readonly surfacesWithoutOwnBehaviour: readonly string[];
  };
  readonly tasks: readonly PlanTask[];
  /** The sequence the owner agreed, which a reorder changes (F08-AC3). */
  readonly agreedSequence: readonly string[];
  /** Prerequisites first; what makes a dependency visible rather than implied (F08-AC4). */
  readonly proposedOrder: readonly string[];
  readonly taskReadiness: readonly PlanTaskReadiness[];
  readonly digest: string;
  readonly workItemIdByTaskId: Readonly<Record<string, string>>;
}

/** One readiness area with the reason it stands where it does (F09-AC1). */
export interface ReadinessArea {
  readonly area: string;
  readonly status: 'Satisfied' | 'Unmet' | 'Unknown';
  readonly reason: string;
  readonly remedy: string | null;
}

/**
 * The recorded readiness decision, over every area F09-AC1 names (F09-AC1, F09-AC2).
 *
 * `mayStartBuild` and `buildBlockingAreas` are both carried because they are two
 * readings of one decision; `mayStartInvestigation` is separate because it is
 * precisely when the build is disabled that read-only investigation is still allowed
 * (F09-AC2).
 */
export interface ReadinessAssessment {
  readonly subjectId: string;
  readonly assessedAt: string;
  readonly verdict: 'Ready' | 'NeedsInformation' | 'Blocked';
  readonly mayStartBuild: boolean;
  readonly mayStartInvestigation: boolean;
  readonly buildBlockingAreas: readonly string[];
  readonly areas: readonly ReadinessArea[];
  readonly reasons: readonly { readonly area: string; readonly status: string; readonly reason: string }[];
}

/** One proposed ticket's outcome, as the owner must be shown it (F10-AC2). */
export interface TicketPublication {
  readonly workItemId: string;
  readonly taskId: string | null;
  readonly kind: 'Published' | 'Failed' | 'OutcomeUnknown';
  readonly issueId: string | null;
  readonly identifier: string | null;
  readonly url: string | null;
  readonly disposition: 'CreatedNew' | 'AlreadyPresent' | 'AdoptedExisting' | null;
  readonly unlinked: readonly { readonly target: string; readonly reason: string }[];
  readonly detail: string;
}

/**
 * One publication request's outcome, per ticket (F10-AC2, F10-AC3).
 *
 * `unpublished` is read from the server rather than derived from `published`: a partial
 * failure has to name what remains, and deriving the remainder on the client is exactly
 * the step that goes wrong when it matters (F10-AC2).
 */
export interface PublicationReport {
  readonly requestId: string;
  readonly planId: string;
  readonly tickets: readonly TicketPublication[];
  readonly published: readonly string[];
  readonly unpublished: readonly string[];
  /** True when this request addressed existing external work rather than writing (F10-AC3). */
  readonly reconciled: boolean;
}

/** An adopted issue's live content, read rather than re-created (F11-AC1). */
export interface AdoptedIssue {
  readonly workItemId: string;
  readonly issueId: string;
  readonly identifier: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly priority: string | null;
  readonly acceptanceCriteria: readonly { readonly id: string; readonly text: string }[];
  readonly dependencyIssueIds: readonly string[];
  readonly state: string;
  readonly capturedScopeSnapshotId: string;
  /** Always false: adoption creates no replacement and offers no merge (F11-AC3). */
  readonly mergeable: false;
}

/** An adopted branch or pull request, verified before adoption (F11-AC2). */
export interface LinkedChange {
  readonly workItemId: string;
  readonly repository: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly pullRequestId: string | null;
}

/** A recorded Test or Review request for adopted work (F11-AC5). */
export interface AdoptedEvaluation {
  readonly workItemId: string;
  readonly mode: 'Test' | 'Review';
  readonly dedupKey: string;
  readonly created: boolean;
  /** Always false: no job was launched and no issue was rewritten (F11-AC5). */
  readonly jobEnqueued: false;
}

/** The change a plan proposes, which is what justifies or refuses a split (F08-AC2). */
export interface PlanChangeSurface {
  readonly surfaceId: string;
  readonly description: string;
  readonly observableBehaviour: string;
  readonly independentlyReviewable: boolean;
}

export interface PlanDraftRequest {
  readonly ideaId: string;
  readonly planId: string;
  readonly change: {
    readonly summary: string;
    readonly surfaces: readonly PlanChangeSurface[];
    readonly dependencyEdges: readonly { readonly surface: string; readonly dependsOn: string }[];
  };
  /** The structured proposal as it was produced; the domain validates it (F05-AC5). */
  readonly proposal: unknown;
}

export type PlanEditRequest =
  | { readonly kind: 'Accept'; readonly taskId: string; readonly expectedRevision: number }
  | { readonly kind: 'Remove'; readonly taskId: string; readonly expectedRevision: number }
  | {
      readonly kind: 'Edit';
      readonly taskId: string;
      readonly expectedRevision: number;
      readonly changes: {
        readonly outcome?: string;
        readonly scope?: string;
        readonly acceptanceCriteria?: readonly string[];
        readonly verificationMethod?: string;
        readonly dependencies?: readonly string[];
        readonly relevantProjectContext?: readonly string[];
        readonly implementationLocation?: {
          readonly kind: 'ProposedLocation';
          readonly candidates: readonly string[];
          readonly basis: string;
        };
      };
    }
  | { readonly kind: 'Reorder'; readonly order: readonly string[]; readonly expectedRevision: number }
  | {
      readonly kind: 'Combine';
      readonly intoTaskId: string;
      readonly fromTaskIds: readonly string[];
      readonly expectedRevision: number;
    }
  | {
      readonly kind: 'Exclusion';
      readonly outcomeId: string;
      readonly excluded: string;
      readonly reason: string;
      readonly expectedRevision: number;
    };

export interface SessionResponse {
  readonly owner: OwnerIdentity;
  readonly csrfToken: string;
}

/** One project the owner selects from (F02-AC1). */
export interface ProjectSummary {
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export type SignInResponse = SessionResponse;

export interface SignInRequest {
  readonly email: string;
  readonly password: string;
}

export interface SessionState {
  readonly status: 'signed-out' | 'signed-in';
  readonly owner: OwnerIdentity;
  readonly projectId: string;
  readonly projectName: string;
}

/** The modes a run may be started in (F13-AC3). */
export type RunMode = 'Plan' | 'Investigate' | 'Build' | 'Test' | 'Review';

/**
 * The attempt states a run can be in, as the API names them.
 *
 * A local union rather than an import, for the same reason as every other wire type in this
 * file: `@shiploop/domain` reaches for `node:crypto` and cannot be bundled into a browser
 * build. A state not in this list renders as the raw word the server sent, so an added
 * state is visible rather than silently dropped.
 */
export const RUN_STATES = [
  'Queued',
  'Preparing',
  'Running',
  'Verifying',
  'WaitingForOwner',
  'Paused',
  'Blocked',
  'Completed',
  'Cancelled',
] as const;

export type RunState = (typeof RUN_STATES)[number];

/** One durable job row, with the bounds and the grant it was recorded with (F13-AC1, F18-AC2). */
export interface RunJob {
  readonly jobId: string;
  readonly operationId: string;
  readonly mode: RunMode;
  readonly workItemId: string;
  readonly scopeSnapshotId: string;
  readonly projectId: string;
  readonly profileVersionId: string;
  readonly procedureVersionId: string;
  readonly state: RunState;
  readonly correlationId: string;
  readonly limits: {
    readonly activeExecutionMs: number;
    readonly maxAutomatedFixPasses: number;
    readonly maxToolRetries: number;
    readonly maxAttempts: number;
  };
  readonly permittedOperations: readonly string[];
  readonly holder: string | null;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The resume point a run carries (F17-AC2).
 *
 * The head and base are full commit SHAs and the dirty and untracked inventory travels with
 * them, because a resume compares the workspace against exactly those values and an owner
 * cannot otherwise see what the next attempt will preserve (F17-AC2).
 */
export interface RunCheckpoint {
  readonly checkpointId: string;
  readonly scopeSnapshotId: string;
  readonly scopeFingerprint: string;
  readonly profileVersionId: string;
  readonly procedureVersionId: string;
  readonly engineVersion: string | null;
  readonly workspace: { readonly workspaceId: string; readonly branchName: string; readonly worktreePath: string };
  readonly headSha: string;
  readonly baseSha: string;
  readonly dirtyFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly results: readonly { readonly name: string; readonly result: string; readonly detail: string | null }[];
  readonly feedback: readonly { readonly author: string; readonly at: string; readonly body: string }[];
  readonly blocker: string | null;
  readonly nextAction: string;
  readonly recordedAt: string;
}

/**
 * Who holds the coding writer, and whether that ownership can be trusted (F17-AC5).
 *
 * `ReconciliationRequired` is kept distinct from `Vacant` on purpose: an expired lease proves
 * heartbeats stopped, not that the writer stopped, so a run in this disposition must read as
 * one that may still be writing code (F17-AC1, F17-AC5).
 */
export type RunWriterDisposition = 'Vacant' | 'Held' | 'ReconciliationRequired' | 'Unleased';

export interface RunWriter {
  readonly holder: string | null;
  readonly disposition: RunWriterDisposition;
  readonly expiresAt: string | null;
  readonly reconciliationReason: string | null;
}

export interface RunView {
  readonly job: RunJob;
  readonly checkpoint: RunCheckpoint | null;
  readonly writer: RunWriter;
}

/** A paused run, with the evidence its writer stopped (F17-AC1). */
export interface PausedRunView extends RunView {
  readonly writerStopped: boolean;
}

export interface ResumedRunView {
  readonly job: RunJob;
  readonly checkpoint: RunCheckpoint;
}

/** A cancelled run, whose `externalDelivery` can only ever be `UnchangedByCancellation` (F17-AC4). */
export interface CancelledRunView {
  readonly job: RunJob;
  readonly preservedCheckpoint: RunCheckpoint | null;
  readonly writer: RunWriter;
  readonly externalDelivery: 'UnchangedByCancellation';
}

export interface AttemptLimitView {
  readonly activeExecutionMs: number;
  readonly automatedFixPasses: number;
}

/**
 * A granted or declined limit extension (F18-AC2).
 *
 * `extendedBoundRecorded` is always false, and the field is typed so: nothing in storage
 * writes the extended bound onto the job, so a grant that claimed otherwise would promise
 * the owner a budget a restart would lose (F18-AC2, N01-AC3).
 */
export interface ExtensionOutcome {
  readonly job: RunJob;
  readonly previousLimits?: AttemptLimitView;
  readonly extendedLimits?: AttemptLimitView;
  readonly extendedBoundRecorded?: false;
  readonly limitsInForce?: AttemptLimitView;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

/** Where a started run sits with respect to the single global coding writer (F13-AC2). */
export interface RunDispatch {
  readonly state: 'Queued';
  readonly heldByWriter: readonly string[];
  readonly reason: string;
}

/** The capability grant a started run holds, with the delivery refusals named (F13-AC3). */
export interface RunGrant {
  readonly mode: RunMode;
  readonly permittedOperations: readonly string[];
  readonly refusedDeliveryOperations: readonly string[];
  readonly refusalReason: string;
}

export interface CapturedScope {
  readonly scopeSnapshotId: string;
  readonly workItemId: string;
  readonly sequenceNumber: number;
  readonly scopeFingerprint: string;
  readonly capturedAt: string;
}

export interface RunStart {
  readonly job: RunJob;
  readonly deduplicated: boolean;
  readonly capturedScope: CapturedScope;
  readonly dispatch: RunDispatch;
  readonly grant: RunGrant;
  readonly requestedByOwner: string;
}

/**
 * What a start did, which is what the status code already said.
 *
 * Three values because three different things happened: a run was created, the operation
 * identity had already created it, or the run exists but no worker can claim it yet
 * (F13-AC1, F13-AC2).
 */
export type RunStartDisposition = 'Started' | 'AlreadyStarted' | 'QueuedBehindWriter';

export interface RunStartResponse {
  readonly run: RunStart;
  readonly disposition: RunStartDisposition;
  readonly message: string;
}

/** One prerequisite confirmation as the start form collects it (F09-AC1). */
export interface ReadinessAreaInput {
  readonly confirmed: boolean;
  readonly note: string | null;
}

/** The six areas a start form collects; dependencies are not collected in this slice (F08-AC4). */
export interface ReadinessInput {
  readonly scope: ReadinessAreaInput;
  readonly criteria: ReadinessAreaInput;
  readonly repository: ReadinessAreaInput;
  readonly target: ReadinessAreaInput;
  readonly verification: ReadinessAreaInput;
  readonly access: ReadinessAreaInput;
}

export interface RunScopeInput {
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly description: string;
  readonly providerRevision: string | null;
  readonly priority: string | null;
  readonly dependencyIssueIds: readonly string[];
  readonly acceptanceCriteria: readonly { readonly id: string; readonly text: string }[];
}

export interface StartRunRequest {
  readonly workItemId: string;
  readonly mode: RunMode;
  readonly operationId: string;
  readonly correlationId: string | null;
  readonly scope: RunScopeInput;
  readonly readiness: ReadinessInput;
}

/** The four buckets the dashboard renders, in the order the product states them (F31-AC2). */
export type AttentionBucket = 'Working' | 'NeedsYourInput' | 'ReadyForYourTest' | 'ReadyForRelease';

export type AttentionState = 'Open' | 'Acknowledged' | 'Resolved';

export interface AttentionItem {
  readonly attentionItemId: string;
  readonly kind: string;
  readonly state: AttentionState;
  readonly projectId: string;
  readonly workItemId: string | null;
  readonly issueIdentifier: string | null;
  readonly title: string;
  readonly blocker: string | null;
  readonly nextAction: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  readonly candidateFingerprint: string | null;
}

/**
 * The board, with only the buckets the server reported as occupied (F31-AC1).
 *
 * `projectId` is null when this owner has no recorded work at all, which the dashboard shows
 * as "nothing recorded yet" rather than as an empty project (F31-AC1).
 */
export interface AttentionBoard {
  readonly projectId: string | null;
  readonly collectedAt: string;
  readonly items: readonly AttentionItem[];
  readonly groups: readonly { readonly bucket: AttentionBucket; readonly items: readonly AttentionItem[] }[];
  /** The only identities an acknowledgement can be recorded against (F31-AC3). */
  readonly persistedItemIds: readonly string[];
}

/** One check line on the review card, with the result it was recorded under (F24-AC2). */
export interface ReviewCardCheck {
  readonly checkId: string;
  readonly name: string;
  readonly origin: string | null;
  readonly required: boolean;
  readonly result: string;
  readonly blocking: boolean;
  readonly exitCode: number | null;
  readonly artifactRef: string | null;
  readonly detail: string | null;
}

/**
 * One acceptance criterion, the verdict recorded against it, and the identity of whatever
 * verified it (F23-AC1, F24-AC3).
 *
 * The three `verification*` fields answer the question a status alone cannot: which check
 * actually observed this criterion. `verificationCheckId` is the profile-visible check name —
 * the same value the checks above carry in `checkId`, so a criterion can be compared with them
 * — and it is null when no check is bound to the verdict. That combination (an automated
 * method with no named check) means nothing here can be read as the criterion's verification,
 * and the row says so rather than reading as complete (F23-AC1).
 */
export interface ReviewCardCriterion {
  readonly criterionId: string;
  readonly text: string;
  readonly methodKind: string;
  readonly status: string;
  readonly evidenceId: string | null;
  readonly observedAt: string | null;
  readonly detail: string | null;
  readonly verificationCheckId: string | null;
  readonly verificationEvidenceId: string | null;
  readonly verificationDetail: string | null;
}

/**
 * What the owner is shown for a candidate, and why it is not ready (F24-AC2, F24-AC3).
 *
 * `notReady` is the point of the card: an incomplete candidate stays inspectable with its
 * reasons rather than presenting as green everywhere except the parts nobody could see.
 */
export interface ReviewCard {
  readonly candidateFingerprint: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly scopeFingerprint: string;
  readonly scopeRevision: number;
  readonly collectedAt: string;
  readonly checks: readonly ReviewCardCheck[];
  readonly criteria: readonly ReviewCardCriterion[];
  readonly pendingOwnerTestCriterionIds: readonly string[];
  readonly readyForOwnerTest: boolean;
  readonly notReady: readonly string[];
}

/** One criterion's standing before the owner decides (F25-AC1). */
export interface CriterionStanding {
  readonly criterionId: string;
  readonly text: string;
  readonly methodKind: string;
  readonly status: string;
  /** False when no observation was recorded, which differs from one that failed. */
  readonly observed: boolean;
}

/**
 * What the owner would be accepting, and what is still outstanding (F25-AC1).
 *
 * The gate rather than the review card, because acceptance is judged over criteria and
 * the card is judged over checks: a card that is green can still be unaccepted, and
 * showing only the card would let a green check read as an acceptance (F24-AC3).
 */
export interface AcceptanceGate {
  readonly candidateFingerprint: string;
  readonly headSha: string;
  readonly scopeFingerprint: string;
  readonly criteria: readonly CriterionStanding[];
  readonly outstandingCriterionIds: readonly string[];
  readonly ready: boolean;
}

/** The acceptance state the candidate currently holds, plus feedback a fix pass reads (F25-AC2). */
export interface AcceptanceState {
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly state: string;
  readonly decisionId: string | null;
  readonly ownerId: string | null;
  readonly decidedAt: string | null;
  readonly note: string | null;
  readonly staleReasons: readonly string[];
  readonly retainedFeedback: readonly { readonly decisionId: string; readonly feedback: string }[];
}

export interface AcceptanceReport {
  readonly candidateId: string;
  readonly workItemId: string;
  readonly decisionId: string;
  readonly state: 'Accepted';
  readonly ownerId: string;
  readonly decidedAt: string;
  readonly candidateFingerprint: string;
  readonly headSha: string;
  readonly scopeFingerprint: string;
  readonly observedDeployments: readonly {
    readonly component: string;
    readonly deploymentId: string | null;
    readonly deploymentUrl: string | null;
    readonly environment: string;
  }[];
  readonly feedbackHonoured: readonly { readonly decisionId: string; readonly feedback: string }[];
}

export interface ChangeRequestReport {
  readonly candidateId: string;
  readonly workItemId: string;
  readonly decisionId: string;
  readonly state: 'ChangesRequested';
  readonly ownerId: string;
  readonly decidedAt: string;
  readonly feedback: string;
  readonly outstandingCriterionIds: readonly string[];
}

/**
 * What the owner says they observed, in the verification layer's own vocabulary.
 *
 * `CaptureFailed` is a member of the union rather than a flavour of failure because a capture
 * that never happened observes nothing: it cannot confirm a criterion and it cannot report the
 * behaviour as broken, and collapsing the two would let a broken test run read as a broken
 * product (F23-AC5).
 */
export type OwnerTestObservation = 'BehaviorConfirmed' | 'BehaviorFailed' | 'CaptureFailed';

/**
 * Where the owner performed the step.
 *
 * `Preview` and `LiveSmoke` are distinct from `Local` because a criterion that requires
 * deployed behaviour stays unmet while it is satisfied by local evidence alone (F23-AC4).
 */
export type OwnerTestEnvironment = 'Local' | 'Preview' | 'LiveSmoke';

/**
 * The build or deployment the owner observed, or an explicit statement that none applies
 * (F23-AC3, F23-AC4). A discriminated union rather than optional fields, because "no
 * deployment exists yet" and "the deployment field was left blank" must not read alike.
 */
export type OwnerTestObservationTarget =
  | {
      readonly kind: 'Deployment';
      readonly component: string;
      readonly environment: string;
      readonly deploymentId: string | null;
      readonly deploymentUrl: string | null;
    }
  | { readonly kind: 'NoDeploymentApplicable'; readonly reason: string };

/** The retained thing the claim points at (F23-AC2). */
export interface OwnerTestEvidenceReference {
  readonly kind: 'Screenshot' | 'ApiExchange' | 'CheckOutput';
  readonly reference: string;
}

/** What the owner recorded, and whether acceptance is now possible (F25-AC1). */
export interface OwnerTestReport {
  readonly criterionId: string;
  readonly candidateFingerprint: string;
  readonly criterion: {
    readonly status: string;
    readonly methodKind: string;
    readonly observedAt: string | null;
    readonly evidenceId: string | null;
  };
  readonly acceptance: { readonly ready: boolean; readonly reasons: readonly string[] };
}

/** Transport health, mirrored so the owner is told when the view has stopped being current. */
export interface ConnectionState {
  readonly connected: boolean;
  readonly lastUpdateAt: string | null;
  readonly lastFailureReason: string | null;
}

let csrfToken: string | null = null;
let connection: ConnectionState = { connected: true, lastUpdateAt: null, lastFailureReason: null };
const connectionListeners = new Set<(state: ConnectionState) => void>();

/**
 * Records the session's CSRF token. Cleared on sign-out so no cached token can authorize
 * a later request from a signed-out client (F01-AC2, F01-AC5).
 */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function subscribeToConnection(listener: (state: ConnectionState) => void): () => void {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}

export function getConnectionState(): ConnectionState {
  return connection;
}

function publish(next: ConnectionState): void {
  connection = next;
  for (const listener of connectionListeners) listener(next);
}

function noteReachable(now: string): void {
  publish({ connected: true, lastUpdateAt: now, lastFailureReason: null });
}

function noteFailure(reason: string): void {
  publish({ connected: false, lastUpdateAt: connection.lastUpdateAt, lastFailureReason: reason });
}

interface SendOptions {
  readonly method: 'GET' | 'POST';
  readonly csrf: boolean;
  readonly body?: unknown;
}

type SendOutcome = { readonly kind: 'response'; readonly response: Response } | { readonly kind: 'offline' };

async function send(path: string, options: SendOptions): Promise<SendOutcome> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.csrf) {
    const token = csrfToken;
    if (token === null) {
      noteFailure('This session has no request token. Sign in again.');
      return { kind: 'offline' };
    }
    headers[CSRF_HEADER] = token;
  }
  const init: RequestInit = { method: options.method, headers, credentials: 'same-origin' };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  try {
    return { kind: 'response', response: await fetch(path, init) };
  } catch {
    noteFailure('The server could not be reached.');
    return { kind: 'offline' };
  }
}

async function readBody(response: Response): Promise<ApiResult<unknown>> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return failure('Unavailable', 'The response could not be read.');
  }
  if (text === '') return { ok: true, value: null };
  try {
    const parsed: unknown = JSON.parse(text);
    return { ok: true, value: parsed };
  } catch {
    return failure('Unavailable', 'The server returned a response that was not valid JSON.');
  }
}

function failure(code: ApiErrorCode, reason: string, fields: readonly ApiFieldError[] = []): ApiResult<never> {
  return { ok: false, error: { code, reason, fields, prerequisites: [] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && API_ERROR_CODES.has(value);
}

function readFields(value: unknown): readonly ApiFieldError[] {
  if (!isRecord(value)) return [];
  const raw: unknown = value['fields'];
  if (!Array.isArray(raw)) return [];
  const entries: readonly unknown[] = raw;
  const fields: ApiFieldError[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const path = entry['path'];
    const message = entry['message'];
    if (typeof path === 'string' && typeof message === 'string') fields.push({ path, message });
  }
  return fields;
}

/**
 * The unmet prerequisites of a `Blocked` refusal, read off the envelope (F04-AC3).
 *
 * Parsed with the same defensiveness as `readFields`, and for the same reason: a
 * prerequisite whose `remedy` is missing must still render its name rather than vanish, so
 * an entry is kept whenever the server named one at all.
 */
function readPrerequisites(value: unknown): readonly ApiPrerequisite[] {
  if (!isRecord(value)) return [];
  const raw: unknown = value['prerequisites'];
  if (!Array.isArray(raw)) return [];
  const entries: readonly unknown[] = raw;
  const prerequisites: ApiPrerequisite[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const name = entry['name'];
    if (typeof name !== 'string') continue;
    prerequisites.push({
      name,
      detail: typeof entry['detail'] === 'string' ? entry['detail'] : '',
      remedy: typeof entry['remedy'] === 'string' ? entry['remedy'] : '',
    });
  }
  return prerequisites;
}

/**
 * One cast of untrusted wire data to a declared local shape, made once at the boundary
 * instead of being repeated in every caller. Each endpoint below documents the shape it
 * expects, so a mismatch is a single-file fix.
 */
/**
 * The server's refusal, read out of the envelope it actually sends.
 *
 * `apps/web/src/server/http-error.ts` answers `{ error: { code, message, fields } }`, so
 * reading a bare `code` and `reason` off the top level finds neither and would report
 * every refusal as an unreachable server. Reading the envelope is what lets a rejected
 * field's message reach the input it belongs to, which is the whole reason the server
 * returns one (F02-AC4, N03-AC3). The bare form is still accepted as a fallback so a
 * proxy or a future shape does not turn a refusal into a transport failure.
 */
function readRefusal(body: unknown, status: number): ApiFailure {
  const envelope = isRecord(body) && isRecord(body['error']) ? (body['error'] as Record<string, unknown>) : null;
  const source = envelope ?? (isRecord(body) ? body : null);
  const message = source !== null && typeof source['message'] === 'string'
    ? source['message']
    : typeof source?.['reason'] === 'string'
      ? source['reason']
      : `The server refused the request (${status}).`;
  const rawCode = source === null ? undefined : (source['code'] ?? source['reason']);
  return {
    code: isApiErrorCode(rawCode) ? rawCode : 'Unavailable',
    reason: message,
    fields: readFields(source),
    prerequisites: readPrerequisites(source),
  };
}

/**
 * The single JSON transport: a session-scoped `fetch` that turns the refusal envelope and the
 * connection banner's state into an `ApiResult`.
 *
 * Exported for `src/ui/mvp/client.ts` so the MVP screens use this transport rather than a second
 * one. Two transports in one browser would mean two answers to "is this session signed in" and
 * "is my view current", and the two could disagree; sharing the function is what keeps the CSRF
 * token, the refusal parsing and the connection state single-sourced while the endpoint lists
 * stay separate per surface.
 */
export function request<T>(path: string, options: SendOptions): Promise<ApiResult<T>> {
  return send(path, options).then(async (outcome) => {
    if (outcome.kind === 'offline') return failure('Unavailable', 'The server could not be reached.');
    const { response } = outcome;
    const body = await readBody(response);
    if (!body.ok) {
      noteFailure(body.error.reason);
      return failure(body.error.code, body.error.reason);
    }
    if (response.ok) {
      noteReachable(new Date().toISOString());
      return { ok: true, value: body.value as T };
    }
    // A refusal is an answer, so the transport is not treated as lost. Marking the
    // connection down here would tell the owner their view had stopped being current
    // when in fact the server received the request and declined it, which is the
    // confusion the banner exists to prevent (N03-AC1, N03-AC3).
    return { ok: false, error: readRefusal(body.value, response.status) };
  });
}

function pathFor(prefix: string, id: string, suffix = ''): string {
  return `${prefix}/${encodeURIComponent(id)}${suffix}`;
}

/**
 * Signs in with whatever the owner typed.
 *
 * The submitted body speaks the server's vocabulary rather than the form's: the route
 * accepts an `identifier`, which it matches against both a display name and a derived
 * address, so sending the typed value under a field named `email` is what makes
 * "sign in with the name you provisioned" work against the real entrypoint instead of
 * being refused as an unrecognised key (F01-AC1).
 */
export function signIn(credentials: SignInRequest): Promise<ApiResult<SignInResponse>> {
  return request<SignInResponse>('/api/owner/sign-in', {
    method: 'POST',
    csrf: false,
    body: { identifier: credentials.email, password: credentials.password },
  });
}

/**
 * The projects this deployment holds, oldest first (F02-AC1).
 *
 * Fetched explicitly rather than read off the session, so the selector's contents are a fact
 * about durable state at the moment the owner opened the app. The header's *selected* project
 * is client state and starts as null; nothing here decides which project the owner is in,
 * because a server that picked one would make the choice invisible (F02-AC1).
 */
export function fetchProjects(): Promise<ApiResult<{ readonly projects: readonly ProjectSummary[] }>> {
  return request<{ readonly projects: readonly ProjectSummary[] }>('/api/projects', { method: 'GET', csrf: false });
}

/**
 * Creates a project, or addresses the one that already holds that identity (F02-AC1).
 *
 * Idempotent by identity, so a resubmitted form is not an error the owner has to understand:
 * the server answers 200 for one that existed and 201 for one this call created, and both
 * carry the project (F02-AC3).
 */
export function createProject(input: {
  readonly projectId: string;
  readonly name: string;
}): Promise<ApiResult<{ readonly project: ProjectSummary }>> {
  return request<{ readonly project: ProjectSummary }>('/api/projects', {
    method: 'POST',
    csrf: true,
    body: input,
  });
}

const INTAKE_ROOT = '/api/intake';

export function fetchIntakeIdeas(): Promise<ApiResult<{ readonly ideas: readonly IntakeIdea[] }>> {
  return request<{ readonly ideas: readonly IntakeIdea[] }>(`${INTAKE_ROOT}/ideas`, { method: 'GET', csrf: false });
}

export function captureIdea(draft: {
  readonly rawRequest: string;
  readonly kind: IntakeRequestKind;
  readonly projectId: string | null;
  readonly notes: string | null;
  readonly detail: BugDetail | null;
}): Promise<ApiResult<{ readonly idea: IntakeIdea }>> {
  return request<{ readonly idea: IntakeIdea }>(`${INTAKE_ROOT}/ideas`, {
    method: 'POST',
    csrf: true,
    body: draft,
  });
}

export function fetchIntakeIdea(ideaId: string): Promise<ApiResult<IntakeDetail>> {
  return request<IntakeDetail>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}`, {
    method: 'GET',
    csrf: false,
  });
}

export function attachIntakeFile(
  ideaId: string,
  attachment: { readonly name: string; readonly mediaType: string; readonly content: string },
): Promise<ApiResult<{ readonly idea: IntakeIdea }>> {
  return request<{ readonly idea: IntakeIdea }>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/attachments`, {
    method: 'POST',
    csrf: true,
    body: attachment,
  });
}

export function recordIntakeSummary(
  ideaId: string,
  summary: { readonly text: string; readonly generatedBy: string },
): Promise<ApiResult<{ readonly idea: IntakeIdea }>> {
  return request<{ readonly idea: IntakeIdea }>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/summary`, {
    method: 'POST',
    csrf: true,
    body: summary,
  });
}

export function archiveIntakeIdea(ideaId: string, reason: string | null): Promise<ApiResult<{ readonly idea: IntakeIdea }>> {
  return request<{ readonly idea: IntakeIdea }>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/archive`, {
    method: 'POST',
    csrf: true,
    body: { reason },
  });
}

export function deferIntakeIdea(ideaId: string, reason: string | null): Promise<ApiResult<{ readonly idea: IntakeIdea }>> {
  return request<{ readonly idea: IntakeIdea }>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/defer`, {
    method: 'POST',
    csrf: true,
    body: { reason },
  });
}

export function fetchRelatedWork(
  ideaId: string,
): Promise<ApiResult<{ readonly related: readonly RelatednessReport[] }>> {
  return request<{ readonly related: readonly RelatednessReport[] }>(
    `${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/related`,
    { method: 'GET', csrf: false },
  );
}

export function recordRelatedWorkChoice(
  ideaId: string,
  candidateIdeaId: string,
  choice: RelatedWorkChoice,
): Promise<ApiResult<{ readonly choice: RelatedWorkChoiceOutcome }>> {
  return request<{ readonly choice: RelatedWorkChoiceOutcome }>(
    `${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/related/choice/${encodeURIComponent(candidateIdeaId)}`,
    { method: 'POST', csrf: true, body: { choice } },
  );
}

export function draftIntakeBrief(
  ideaId: string,
  draft: {
    readonly authoredBy: 'Owner' | 'ClarificationModel' | 'OwnerEdit';
    readonly sections: BriefSections;
    readonly basedOnBriefVersion: number | null;
  },
): Promise<ApiResult<{ readonly brief: BriefVersion }>> {
  return request<{ readonly brief: BriefVersion }>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/brief`, {
    method: 'POST',
    csrf: true,
    body: draft,
  });
}

export function agreeIntakeBrief(ideaId: string): Promise<ApiResult<{ readonly brief: BriefVersion }>> {
  return request<{ readonly brief: BriefVersion }>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/brief/agree`, {
    method: 'POST',
    csrf: true,
    body: {},
  });
}

export function askIntakeQuestions(
  ideaId: string,
  round: { readonly sections: BriefSections; readonly ambiguities: readonly IntakeAmbiguity[] },
): Promise<ApiResult<ClarificationRound>> {
  return request<ClarificationRound>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/questions`, {
    method: 'POST',
    csrf: true,
    body: round,
  });
}

export function answerIntakeQuestion(
  ideaId: string,
  questionId: string,
  answer: string,
): Promise<ApiResult<{ readonly question: ClarifyingQuestion }>> {
  return request<{ readonly question: ClarifyingQuestion }>(
    `${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/questions/${encodeURIComponent(questionId)}/answer`,
    { method: 'POST', csrf: true, body: { answer } },
  );
}

export function applyIntakeCorrection(
  ideaId: string,
  correction: { readonly text: string; readonly sections: BriefSections; readonly basedOnBriefVersion: number },
): Promise<ApiResult<CorrectionOutcome>> {
  return request<CorrectionOutcome>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/corrections`, {
    method: 'POST',
    csrf: true,
    body: correction,
  });
}

/**
 * Plans, readiness, publication and adoption (F08, F09, F10, F11).
 *
 * Every address is percent-encoded because a plan address may be a work item id rather
 * than the plan's own, and both forms reach the same plan (F10-AC2). Publication and
 * adoption carry the caller's own request or work item identity rather than one minted
 * here, because a retry after a timeout must present the same request id (F10-AC3).
 */
export function draftPlan(draft: PlanDraftRequest): Promise<ApiResult<{ readonly plan: Plan }>> {
  return request<{ readonly plan: Plan }>('/api/plans', { method: 'POST', csrf: true, body: draft });
}

export function fetchPlan(planId: string): Promise<ApiResult<{ readonly plan: Plan }>> {
  return request<{ readonly plan: Plan }>(`/api/plans/${encodeURIComponent(planId)}`, { method: 'GET', csrf: false });
}

export function fetchPlansForIdea(ideaId: string): Promise<ApiResult<{ readonly plans: readonly Plan[] }>> {
  return request<{ readonly plans: readonly Plan[] }>(`/api/ideas/${encodeURIComponent(ideaId)}/plans`, {
    method: 'GET',
    csrf: false,
  });
}

export function editPlan(planId: string, edit: PlanEditRequest): Promise<ApiResult<{ readonly plan: Plan }>> {
  return request<{ readonly plan: Plan }>(`/api/plans/${encodeURIComponent(planId)}/edit`, {
    method: 'POST',
    csrf: true,
    body: edit,
  });
}

export function fetchPlanReadiness(
  planId: string,
): Promise<ApiResult<{ readonly assessment: ReadinessAssessment }>> {
  return request<{ readonly assessment: ReadinessAssessment }>(`/api/plans/${encodeURIComponent(planId)}/readiness`, {
    method: 'GET',
    csrf: false,
  });
}

export function publishPlan(
  planId: string,
  requestId: string,
): Promise<ApiResult<{ readonly report: PublicationReport }>> {
  return request<{ readonly report: PublicationReport }>(`/api/plans/${encodeURIComponent(planId)}/publish`, {
    method: 'POST',
    csrf: true,
    body: { requestId },
  });
}

export function reconcilePlanPublication(
  planId: string,
  input: {
    readonly operationId: string;
    readonly resolution: unknown;
    readonly observedAt: string;
    readonly resolvedBy: string;
  },
): Promise<ApiResult<{ readonly reconciliation: { readonly resolution: string; readonly workItemId: string | null; readonly detail: string } }>> {
  return request(`/api/plans/${encodeURIComponent(planId)}/reconcile-publication`, {
    method: 'POST',
    csrf: true,
    body: input,
  });
}

export function adoptExistingIssue(input: {
  readonly projectId: string;
  readonly profileVersionId: string;
  readonly procedureVersionId: string;
  readonly issueId: string;
  readonly expectedIdentifier: string | null;
  readonly title: string;
}): Promise<ApiResult<{ readonly adopted: AdoptedIssue }>> {
  return request<{ readonly adopted: AdoptedIssue }>('/api/adoption/issue', { method: 'POST', csrf: true, body: input });
}

export function linkExistingChange(input: {
  readonly workItemId: string;
  readonly repository: {
    readonly provider: string;
    readonly fullName: string;
    readonly defaultBranch?: string;
    readonly url?: string;
  };
  readonly branch: string;
  readonly baseBranch: string;
  readonly expectedHeadSha: string | null;
  readonly pullRequestId: string | null;
}): Promise<ApiResult<{ readonly change: LinkedChange }>> {
  return request<{ readonly change: LinkedChange }>('/api/adoption/change', { method: 'POST', csrf: true, body: input });
}

export function requestAdoptedEvaluation(input: {
  readonly workItemId: string;
  readonly mode: 'Test' | 'Review' | 'Build';
  readonly candidateId: string | null;
}): Promise<ApiResult<{ readonly evaluation: AdoptedEvaluation }>> {
  return request<{ readonly evaluation: AdoptedEvaluation }>('/api/adoption/evaluate', {
    method: 'POST',
    csrf: true,
    body: input,
  });
}

export function exportIntakeIdea(ideaId: string): Promise<ApiResult<{ readonly export: IntakeIdeaExport }>> {
  return request<{ readonly export: IntakeIdeaExport }>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/export`, {
    method: 'GET',
    csrf: false,
  });
}

const RUNS_ROOT = '/api/runs';

/**
 * Starts a run (F13-AC1).
 *
 * The response says which of three things happened — created, already started, or queued
 * behind the single global coding writer — because the status code alone would not say
 * whether a second run now exists, and a retried Start that quietly made one is the failure
 * F13-AC2 exists to prevent (F13-AC2).
 */
export function startRun(draft: StartRunRequest): Promise<ApiResult<RunStartResponse>> {
  return request<RunStartResponse>(RUNS_ROOT, { method: 'POST', csrf: true, body: draft });
}

export function fetchRuns(): Promise<ApiResult<{ readonly runs: readonly RunJob[] }>> {
  return request<{ readonly runs: readonly RunJob[] }>(RUNS_ROOT, { method: 'GET', csrf: false });
}

export function fetchRun(jobId: string): Promise<ApiResult<{ readonly run: RunView }>> {
  return request<{ readonly run: RunView }>(pathFor(RUNS_ROOT, jobId), { method: 'GET', csrf: false });
}

/**
 * The resume point on its own (F17-AC2).
 *
 * A run with none is a `NotFound` the page renders as its own state; asking for it
 * separately is what lets a page say "no resume point has been written" instead of showing
 * an empty object that reads like a recorded one.
 */
export function fetchRunCheckpoint(jobId: string): Promise<ApiResult<{ readonly checkpoint: RunCheckpoint }>> {
  return request<{ readonly checkpoint: RunCheckpoint }>(pathFor(RUNS_ROOT, jobId, '/checkpoint'), {
    method: 'GET',
    csrf: false,
  });
}

export function pauseRun(jobId: string): Promise<ApiResult<{ readonly run: PausedRunView }>> {
  return request<{ readonly run: PausedRunView }>(pathFor(RUNS_ROOT, jobId, '/pause'), { method: 'POST', csrf: true });
}

export function resumeRun(jobId: string): Promise<ApiResult<{ readonly run: ResumedRunView }>> {
  return request<{ readonly run: ResumedRunView }>(pathFor(RUNS_ROOT, jobId, '/resume'), { method: 'POST', csrf: true });
}

export function cancelRun(jobId: string): Promise<ApiResult<{ readonly run: CancelledRunView }>> {
  return request<{ readonly run: CancelledRunView }>(pathFor(RUNS_ROOT, jobId, '/cancel'), { method: 'POST', csrf: true });
}

/** Grants or declines a reached limit (F18-AC2). */
export function decideRunExtension(
  jobId: string,
  decision: 'Grant' | 'Decline',
): Promise<ApiResult<{ readonly extension: ExtensionOutcome }>> {
  return request<{ readonly extension: ExtensionOutcome }>(pathFor(RUNS_ROOT, jobId, '/extension'), {
    method: 'POST',
    csrf: true,
    body: { decision },
  });
}

/**
 * The review card for a run (F24-AC2).
 *
 * A run with no candidate yet is refused by name, which the page renders as its own state
 * rather than as a card with nothing on it (F24-AC3).
 */
export function fetchReviewCard(jobId: string): Promise<ApiResult<{ readonly card: ReviewCard }>> {
  return request<{ readonly card: ReviewCard }>(pathFor(RUNS_ROOT, jobId, '/review-card'), {
    method: 'GET',
    csrf: false,
  });
}

/**
 * The acceptance gate and the state the candidate currently holds (F25-AC1, F25-AC3).
 *
 * One read rather than two, because the owner needs both to decide and asking twice would
 * let the two answers come from different instants (F25-AC3).
 */
export function fetchAcceptance(
  jobId: string,
): Promise<ApiResult<{ readonly gate: AcceptanceGate; readonly acceptance: AcceptanceState }>> {
  return request<{ readonly gate: AcceptanceGate; readonly acceptance: AcceptanceState }>(
    pathFor(RUNS_ROOT, jobId, '/acceptance'),
    { method: 'GET', csrf: false },
  );
}

/**
 * Requests changes, retaining the reason against the tested candidate (F25-AC2).
 *
 * The reason is required by the client rather than only by the server, so the button
 * cannot be pressed with nothing to send and the owner learns that before the round trip.
 */
export function requestChanges(
  jobId: string,
  reason: string,
): Promise<ApiResult<{ readonly changeRequest: ChangeRequestReport }>> {
  return request<{ readonly changeRequest: ChangeRequestReport }>(
    pathFor(RUNS_ROOT, jobId, '/acceptance'),
    { method: 'POST', csrf: true, body: { decision: 'RequestChanges', reason } },
  );
}

/**
 * Accepts the candidate (F25-AC1).
 *
 * A refusal arrives as a problem naming the outstanding criteria, and this returns it
 * rather than throwing, so the page can show what is left instead of a generic failure.
 */
export function acceptCandidate(
  jobId: string,
  note: string | null,
): Promise<ApiResult<{ readonly acceptance: AcceptanceReport }>> {
  return request<{ readonly acceptance: AcceptanceReport }>(pathFor(RUNS_ROOT, jobId, '/acceptance'), {
    method: 'POST',
    csrf: true,
    body: note === null ? { decision: 'Accept' } : { decision: 'Accept', note },
  });
}

/**
 * Records the owner's own observation for one criterion (F23-AC1, F23-AC5, F25-AC1, F25-AC4).
 *
 * The only write in this client that creates evidence about a criterion, and it is the owner's
 * alone: the session is the authority, no body field names an actor, and no result is asserted
 * by the caller — the caller states an *observation* and the server decides what that makes the
 * criterion. The client therefore has no way to send "this criterion passed" (F25-AC4).
 *
 * The outcome vocabulary is sent as the domain spells it rather than as a friendly label, so a
 * client-side rename cannot quietly change what gets recorded (F23-AC5).
 */
export function recordOwnerTest(
  jobId: string,
  input: {
    readonly criterionId: string;
    readonly expectedCandidateFingerprint: string;
    readonly observation: OwnerTestObservation;
    readonly observedAgainst: OwnerTestObservationTarget;
    readonly evidence: OwnerTestEvidenceReference;
    readonly note: string | null;
  },
): Promise<ApiResult<{ readonly report: OwnerTestReport }>> {
  return request<{ readonly report: OwnerTestReport }>(pathFor(RUNS_ROOT, jobId, '/owner-observations'), {
    method: 'POST',
    csrf: true,
    body: {
      criterionId: input.criterionId,
      expectedCandidateFingerprint: input.expectedCandidateFingerprint,
      observation: input.observation,
      observedAgainst: input.observedAgainst,
      evidence: input.evidence,
      note: input.note,
    },
  });
}

/**
 * The attention board (F31-AC1).
 *
 * `projectId` is optional because this server has no project selector; with none named, the
 * server collects the board for the project this owner's recorded work belongs to and says
 * so by answering with a null `projectId` when there is none (F31-AC2).
 */
export function fetchAttentionBoard(projectId?: string): Promise<ApiResult<{ readonly board: AttentionBoard }>> {
  const query = projectId === undefined ? '' : `?projectId=${encodeURIComponent(projectId)}`;
  return request<{ readonly board: AttentionBoard }>(`/api/attention${query}`, { method: 'GET', csrf: false });
}

/** Records that the owner has seen an item, and nothing else (F31-AC4). */
export function acknowledgeAttentionItem(
  itemId: string,
): Promise<ApiResult<{ readonly item: AttentionItem }>> {
  return request<{ readonly item: AttentionItem }>(pathFor('/api/attention', itemId, '/acknowledge'), {
    method: 'POST',
    csrf: true,
  });
}

export function fetchSession(): Promise<ApiResult<SessionResponse>> {
  return request<SessionResponse>('/api/owner/session', { method: 'GET', csrf: false });
}
export function signOut(): Promise<ApiResult<void>> {
  return request<void>('/api/owner/sign-out', { method: 'POST', csrf: true });
}

export function fetchProfiles(projectId: string): Promise<ApiResult<ProfileListResponse>> {
  return request<ProfileListResponse>(pathFor('/api/profiles', projectId), { method: 'GET', csrf: false });
}

export function fetchProfileVersions(projectId: string): Promise<ApiResult<ProfileVersionListResponse>> {
  return request<ProfileVersionListResponse>(pathFor('/api/profiles', projectId, '/versions'), {
    method: 'GET',
    csrf: false,
  });
}

export function createProfile(draft: CreateProfileRequest): Promise<ApiResult<CreateProfileResponse>> {
  return request<CreateProfileResponse>('/api/profiles', { method: 'POST', csrf: true, body: draft });
}

export function fetchConnectors(projectId: string): Promise<ApiResult<ConnectorListResponse>> {
  return request<ConnectorListResponse>(pathFor('/api/profiles', projectId, '/connectors'), {
    method: 'GET',
    csrf: false,
  });
}

export function createConnector(
  projectId: string,
  draft: CreateConnectorRequest,
): Promise<ApiResult<ConnectorView>> {
  return request<ConnectorView>(pathFor('/api/profiles', projectId, '/connectors'), {
    method: 'POST',
    csrf: true,
    body: draft,
  });
}

export function revokeConnector(connectorId: string): Promise<ApiResult<ConnectorView>> {
  return request<ConnectorView>(pathFor('/api/connectors', connectorId, '/revoke'), { method: 'POST', csrf: true });
}

/** Groups a failure's field messages by form path so each can render beside its input. */
export function fieldMessages(failureValue: ApiFailure): Readonly<Record<string, string>> {
  const grouped: Record<string, string> = {};
  for (const field of failureValue.fields) {
    if (grouped[field.path] === undefined) grouped[field.path] = field.message;
  }
  return grouped;
}

/**
 * A relative timestamp for every surface that shows one. Kept beside the wire types
 * because every instant the UI renders arrives as an ISO string from these endpoints.
 */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'an unknown time';
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** An unambiguous absolute rendering to sit beside the relative one, since that drifts. */
export function formatTimestamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return `${new Date(parsed).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
