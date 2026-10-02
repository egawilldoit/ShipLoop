/**
 * The controller surface this HTTP layer depends on.
 *
 * `packages/controller` owns the use cases and is written independently of the web
 * server, so the boundary is declared here as ports rather than imported (F01,
 * F02, F03: apps/web owns the authentication boundary and thin HTTP handlers,
 * packages/controller owns API use cases). Declaring the shape locally keeps both
 * sides honest: a use case that cannot be expressed here is a use case the
 * transport cannot answer, and nothing in this file reaches around the use case to
 * touch storage.
 *
 * Every port returns a typed `Result`. Expected refusals are values, never thrown
 * exceptions, because each one maps to a different status code and a different next
 * step for the owner (`http-error.ts`). No port returns a credential value: the
 * connector view carries a credential *reference* and its digest (F03-AC3).
 */

import type { JobOperation } from '@shiploop/storage';
import type {
  AttemptState,
  AttentionItemId,
  AttentionKind,
  AttentionState,
  CapabilityKind,
  ConnectorId,
  DomainError,
  IdeaId,
  JobId,
  JobMode,
  OwnerId,
  ProfileVersionId,
  ProjectId,
  Result,
} from '@shiploop/domain';

/**
 * Narrows an identifier that arrived as validated HTTP text.
 *
 * The route schema has already proved the shape before this is called, so the
 * assertion records a boundary that was actually checked rather than papering
 * over an unvalidated value.
 */
export function asProjectId(value: string): ProjectId {
  return value as ProjectId;
}

/** Narrows validated HTTP text to a connector identifier. See `asProjectId`. */
export function asConnectorId(value: string): ConnectorId {
  return value as ConnectorId;
}

/** Narrows validated HTTP text to an idea identifier. See `asProjectId`. */
export function asIdeaId(value: string): IdeaId {
  return value as IdeaId;
}

/** Narrows validated HTTP text to a job identifier. See `asProjectId`. */
export function asJobId(value: string): JobId {
  return value as JobId;
}

/** Narrows validated HTTP text to an attention item identifier. See `asProjectId`. */
export function asAttentionItemId(value: string): AttentionItemId {
  return value as AttentionItemId;
}

/**
 * The identity a request is allowed to act as, derived from a valid session.
 *
 * Carries no owner data beyond identity: anything a handler needs that is not "who is
 * asking" has to come from a use case, which is what keeps an unauthorized request
 * from being answered out of session state (F01-AC1).
 */
export interface AuthorizedOwner {
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly sessionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/**
 * The stored form of a session.
 *
 * Only `tokenDigest` is durable, matching the domain rule that the plaintext token
 * leaves the process exactly once inside `Set-Cookie` (F01-AC2). `revokedAt` is
 * what makes sign-out authoritative: the web layer calls `authorizeSession` on
 * every request, so a revoked row refuses access no matter how correct the token is.
 */
export interface StoredSessionRecord {
  readonly sessionId: string;
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  /** Null until the first authorized request; the idle deadline measures from it. */
  readonly lastActivityAt: string | null;
}

export interface CreateSessionCommand {
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  /**
   * Absolute and idle limits are the controller's policy: it must apply the domain
   * `sessionDeadlines` so a stored row states the limits it was created under.
   */
  readonly absoluteTtlSeconds: number;
  readonly idleTimeoutSeconds: number;
}

export interface RevokeSessionCommand {
  readonly sessionId: string;
  readonly revokedAt: string;
}

export interface TouchSessionCommand {
  readonly sessionId: string;
  readonly lastActivityAt: string;
}

/**
 * Session lifecycle.
 *
 * The controller stores and revokes; the web layer decides. Authorization itself
 * runs in the web layer through the domain `authorizeSession`, because the cookie
 * is a transport fact and the revocation check must sit on the request path
 * (F01-AC1, F01-AC2).
 */
export interface SessionUseCases {
  /** Resolves a presented token to its stored row. Refuses an unknown digest. */
  loadByToken(token: string): Promise<Result<StoredSessionRecord, DomainError>>;
  /** Persists a new session. The plaintext token is never passed in or stored. */
  create(command: CreateSessionCommand): Promise<Result<StoredSessionRecord, DomainError>>;
  /** Server-side revocation. Clearing the cookie is not a substitute (F01-AC2). */
  revoke(command: RevokeSessionCommand): Promise<Result<StoredSessionRecord, DomainError>>;
  /** Records activity so the idle deadline stays meaningful. */
  touch(command: TouchSessionCommand): Promise<Result<null, DomainError>>;
}

export interface ProvisionOwnerCommand {
  readonly displayName: string;
  readonly password: string;
  readonly at: string;
}

export interface OwnerView {
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly createdAt: string;
}

export interface SignInCommand {
  /** Display name or another owner identifier; never assumed to exist. */
  readonly identifier: string;
  readonly password: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  readonly absoluteTtlSeconds: number;
  readonly idleTimeoutSeconds: number;
}

/**
 * What a successful sign-in yields.
 *
 * Only the session comes back: the web layer minted the token, so it is the only
 * holder of the plaintext and the only component that may place it on the wire
 * (F01-AC4).
 */
export interface SignInGrant {
  readonly session: StoredSessionRecord;
}

export interface OwnerUseCases {
  provision(command: ProvisionOwnerCommand): Promise<Result<OwnerView, DomainError>>;
  /**
   * Verifies a credential and opens a session in one step.
   *
   * A wrong password and an unknown owner must produce indistinguishable results
   * here, otherwise this port is an owner-existence oracle (N02-AC1). The web layer
   * also collapses both refusals into one response, so neither side can leak.
   */
  signIn(command: SignInCommand): Promise<Result<SignInGrant, DomainError>>;
}

export type ProfileConnectorKind = 'Ticket' | 'Git' | 'Deployment' | 'Engine';

export type ProfileConnectorState = 'Unconfigured' | 'Healthy' | 'Degraded' | 'Revoked' | 'Unreachable';

export interface PreviewComponentReference {
  readonly component: string;
  readonly environment: string;
}

export interface ProfileReferences {
  readonly repository: string;
  readonly ticketProvider: string;
  readonly ticketTeamKey: string | null;
  readonly baseBranch: string;
  readonly targetBranch: string;
  readonly deploymentProvider: string;
  readonly engine: string;
  readonly previewComponents: readonly PreviewComponentReference[];
}

export interface ProfilePolicy {
  readonly requiredChecks: readonly string[];
  /** Delivery is always owner-authorized; a profile may not grant it (F03-AC5). */
  readonly deliveryBehavior: 'ManualAuthorizationOnly';
  readonly maxFixPasses: number;
  readonly workspaceIsolation: 'WorktreeAndDataDirectory';
  readonly capabilityVersion: number;
}

export interface ProfileEnvironmentReference {
  readonly runtime: string;
  readonly ports: readonly number[];
  /** Names of credentials the recipe needs. Never values (F03-AC3). */
  readonly secretReferences: readonly string[];
}

/**
 * The profile body as the transport carries it.
 *
 * `secretReferences` holds names only; a profile is project configuration and is
 * never a place a credential is stored (F02-AC1, F03-AC3).
 */
export interface ProfileContent {
  readonly references: ProfileReferences;
  readonly policy: ProfilePolicy;
  readonly recipe: string;
  readonly environment: ProfileEnvironmentReference;
}

/**
 * One immutable profile version.
 *
 * Saving always appends: a run names the version it used, so history has to stay
 * addressable rather than being overwritten (F02-AC3, F02-AC2).
 */
export interface ProfileVersionView {
  readonly profileVersionId: ProfileVersionId;
  readonly projectId: ProjectId;
  readonly versionNumber: number;
  readonly supersedesVersionId: ProfileVersionId | null;
  readonly content: ProfileContent;
  readonly contentFingerprint: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface SaveProfileVersionCommand {
  readonly projectId: ProjectId;
  readonly content: ProfileContent;
  readonly note: string | null;
  /**
   * Compare-and-set against the newest version. A stale editor must be refused
   * with a `Conflict`, never silently merged (F02-AC2, F24-AC4).
   */
  readonly expectedVersionNumber: number | null;
  readonly at: string;
  readonly actor: OwnerId;
}

export interface ProfileUseCases {
  saveVersion(command: SaveProfileVersionCommand): Promise<Result<ProfileVersionView, DomainError>>;
  /** Null when the project has no saved profile yet; the route answers 404 then. */
  currentVersion(projectId: ProjectId): Promise<Result<ProfileVersionView | null, DomainError>>;
  listVersions(projectId: ProjectId): Promise<Result<readonly ProfileVersionView[], DomainError>>;
}

export interface RegisterConnectorCommand {
  readonly projectId: ProjectId;
  readonly provider: string;
  readonly kind: ProfileConnectorKind;
  readonly resourceScope: string;
  /** A pointer into the credential store. A secret value must never arrive here (F03-AC3). */
  readonly credentialReference: string;
  readonly at: string;
  readonly actor: OwnerId;
}

export interface RevokeConnectorCommand {
  readonly connectorId: ConnectorId;
  readonly at: string;
  readonly reason: string;
  readonly actor: OwnerId;
}

/**
 * The owner-visible connector projection.
 *
 * Carries status, last-checked time, the read/write capability split and an
 * actionable error, because "is it connected" is not a question the owner can
 * answer from a boolean (F03-AC2). `credentialReference` is a pointer and
 * `credentialReferenceDigest` proves which pointer was used without repeating it
 * in an export (F03-AC3, F32-AC2).
 */
export interface ConnectorView {
  readonly connectorId: ConnectorId;
  readonly projectId: ProjectId;
  readonly provider: string;
  readonly kind: ProfileConnectorKind;
  readonly resourceScope: string;
  readonly credentialReference: string;
  readonly credentialReferenceDigest: string;
  readonly state: ProfileConnectorState;
  readonly error: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly reads: readonly CapabilityKind[];
  readonly writes: readonly CapabilityKind[];
  readonly unsupported: readonly { readonly kind: CapabilityKind; readonly limitation: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConnectorUseCases {
  /**
   * Registers a credential reference and probes the provider.
   *
   * Capabilities come from the adapter, never from the request body: a client that
   * could declare its own capabilities would be able to claim a merge authority it
   * does not hold (F03-AC2, F03-AC5).
   */
  register(command: RegisterConnectorCommand): Promise<Result<ConnectorView, DomainError>>;
  listForProject(projectId: ProjectId): Promise<Result<readonly ConnectorView[], DomainError>>;
  /**
   * Revocation must block later operations that depend on this connector; an
   * in-flight attempt keeps its work and reports the blocker (F03-AC4).
   */
  revoke(command: RevokeConnectorCommand): Promise<Result<ConnectorView, DomainError>>;
}


/** How a request was captured (F06-AC1, F06-AC3). */
export type IntakeRequestKind = 'FeatureRequest' | 'Bug';

/**
 * Expected, actual and reproduction detail, each independently optional (F06-AC3).
 *
 * A bug is still a valid capture when the owner can only describe the symptom, so
 * every member is nullable and none of them is required.
 */
export interface BugDetailInput {
  readonly expected: string | null;
  readonly actual: string | null;
  readonly reproduction: string | null;
}

/**
 * An attachment as a row records it: a named file, never its content (F06-AC1).
 *
 * The bytes live under the artifact root. A view with no content field is a type
 * that cannot be asked for an inline attachment at all.
 */
export interface IntakeAttachmentView {
  readonly name: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly addedAt: string;
}

/**
 * A generated summary, held apart from the raw request (F06-AC1).
 *
 * `rawRequestFingerprint` is the fingerprint of the exact request text this summary
 * describes, so the two can always be traced to each other. The type is separate
 * from the request because one owner action produces both and conflating them is
 * how a generated sentence starts being read as the owner's own words.
 */
export interface GeneratedSummaryView {
  readonly text: string;
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly rawRequestFingerprint: string;
}

/**
 * One captured request (F06-AC1, F06-AC3, F06-AC5).
 *
 * `disposition` is the terminal state the owner reached without producing work.
 * There is no publication field on this view because nothing in intake publishes:
 * an archived request has no ticket and no coding run behind it (F06-AC5).
 */
export interface IntakeIdeaView {
  readonly ideaId: IdeaId;
  readonly rawRequest: string;
  readonly projectId: string | null;
  readonly notes: string | null;
  readonly kind: IntakeRequestKind;
  readonly bugDetail: BugDetailInput;
  readonly attachments: readonly IntakeAttachmentView[];
  readonly summary: GeneratedSummaryView | null;
  readonly disposition: 'Unpublished' | 'Published' | 'Deferred' | 'Archived';
  readonly dispositionDetail: string | null;
  readonly capturedAt: string;
}

export interface AcceptanceCriterionView {
  readonly id: string;
  readonly text: string;
  readonly verification: string | null;
}

/**
 * The seven sections F07-AC1 names, as the owner reads them.
 *
 * Every section is required in the type, so a brief that omitted one could not be
 * typed as one. A list may be empty, which says "present and nothing yet" rather
 * than "absent".
 */
export interface BriefSectionsView {
  readonly problem: string;
  readonly desiredOutcome: string;
  readonly includedBehaviour: readonly string[];
  readonly excludedBehaviour: readonly string[];
  readonly assumptions: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionView[];
  readonly unresolvedQuestions: readonly string[];
}

/** One brief version, with the criteria a correction withdrew from the one before (F07-AC3). */
export interface BriefVersionView {
  readonly version: number;
  readonly state: 'Proposed' | 'Agreed';
  readonly authoredBy: string;
  readonly authoredAt: string;
  readonly supersedesVersion: number | null;
  readonly rawRequestFingerprint: string;
  readonly sections: BriefSectionsView;
  readonly agreedBy: string | null;
  readonly agreedAt: string | null;
  readonly withdrawnCriterionIds: readonly string[];
}

/**
 * The current brief and every earlier version (F07-AC3).
 *
 * `versions` is oldest first so an owner can read what they agreed to before a
 * correction as readily as what the correction produced.
 */
export interface BriefView {
  readonly briefId: string | null;
  readonly currentVersion: number | null;
  readonly current: BriefVersionView | null;
  readonly versions: readonly BriefVersionView[];
}

/** A clarifying question and why it was worth asking (F07-AC2). */
export interface ClarifyingQuestionView {
  readonly questionId: string;
  readonly topic: string;
  readonly prompt: string;
  readonly readings: readonly string[];
  readonly whyMaterial: string;
  readonly state: 'Open' | 'Answered';
  readonly answer: string | null;
  readonly askedAt: string;
  readonly answeredAt: string | null;
}

/** A candidate question that was considered and declined (F07-AC2). */
export interface RejectedCandidateView {
  readonly topic: string;
  readonly rejection: string;
  readonly explanation: string;
}

/** One turn of the owner conversation, in the order it happened (F07-AC3). */
export interface IntakeTurnView {
  readonly kind: 'RawRequest' | 'Question' | 'Answer' | 'Correction';
  readonly at: string;
  readonly text: string;
  readonly reference: string | null;
}

/** Everything one captured request currently consists of. */
export interface IntakeDetailView {
  readonly idea: IntakeIdeaView;
  readonly brief: BriefView;
  readonly questions: readonly ClarifyingQuestionView[];
  readonly rejected: readonly RejectedCandidateView[];
  readonly turns: readonly IntakeTurnView[];
}

/** An enumerated ambiguity the caller believes a request leaves open (F07-AC2). */
export interface AmbiguityInput {
  readonly kind: 'UnspecifiedSubject' | 'ConflictingStatement' | 'MissingAcceptanceThreshold' | 'UnstatedScopeBoundary' | 'UnresolvedDependency';
  readonly topic: string;
  readonly readings: readonly string[];
  readonly answeredBy: readonly string[];
  readonly impact: 'ChangesBehaviour' | 'ChangesAcceptance' | 'Cosmetic';
  readonly evidence: string;
}

/**
 * How similar another request is, and what the owner may choose about it (F06-AC4).
 *
 * `mergeable` and `discardable` are literal `false` and `disposition` is a single
 * literal, so no client can read a merge or a discard out of a perfect score. The
 * resemblance is shown before publication and the choice stays with the owner.
 */
export interface RelatednessReportView {
  readonly candidateIdeaId: IdeaId;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly mergeable: false;
  readonly discardable: false;
  readonly disposition: 'OwnerChoiceRequired';
  readonly ownerChoices: readonly ('LinkToExisting' | 'ExtendExisting' | 'CreateNewIssue')[];
}

/** What the owner's explicit choice did, which is never a merge (F06-AC4). */
export interface RelatedWorkChoiceView {
  readonly candidateIdeaId: IdeaId;
  readonly choice: 'LinkToExisting' | 'ExtendExisting' | 'CreateNewIssue';
  readonly score: number;
  readonly reasons: readonly string[];
  readonly merged: false;
  readonly dispositionAfterChoice: {
    readonly idea: 'Unpublished' | 'Published' | 'Deferred' | 'Archived';
    readonly candidate: 'Unpublished' | 'Published' | 'Deferred' | 'Archived';
  };
}

/** One round of generated questions and the candidates that were declined (F07-AC2). */
export interface ClarificationRoundView {
  readonly questions: readonly ClarifyingQuestionView[];
  readonly rejected: readonly RejectedCandidateView[];
}

/** What a correction changed, with the version it superseded (F07-AC3). */
export interface CorrectionView {
  readonly currentVersion: BriefVersionView;
  readonly priorVersion: BriefVersionView;
  readonly withdrawnCriterionIds: readonly string[];
}

/** A sanitized export of one request: the owner's text, facts and an attachment index (F32-AC2). */
export interface IdeaExportView {
  readonly ideaId: IdeaId;
  readonly kind: IntakeRequestKind;
  readonly capturedAt: string;
  readonly rawRequest: string;
  readonly notes: string | null;
  readonly projectId: string | null;
  readonly bugDetail: BugDetailInput;
  readonly summary: GeneratedSummaryView | null;
  readonly disposition: { readonly state: string; readonly detail: string | null };
  readonly attachments: readonly {
    readonly fileName: string;
    readonly mediaType: string;
    readonly byteSize: number;
    readonly contentDigest: string;
  }[];
}

export interface CaptureIdeaCommand {
  readonly rawRequest: string;
  readonly kind: IntakeRequestKind;
  readonly projectId: string | null;
  readonly notes: string | null;
  readonly detail: BugDetailInput | null;
  readonly actor: OwnerId;
}

export interface AttachFileCommand {
  readonly ideaId: IdeaId;
  readonly name: string;
  readonly mediaType: string;
  readonly content: string;
  readonly actor: OwnerId;
}

export interface RecordSummaryCommand {
  readonly ideaId: IdeaId;
  readonly text: string;
  readonly generatedBy: string;
  readonly actor: OwnerId;
}

export interface DispositionCommand {
  readonly ideaId: IdeaId;
  readonly reason: string | null;
  readonly actor: OwnerId;
}

export interface RecordRelatedWorkChoiceCommand {
  readonly ideaId: IdeaId;
  readonly candidateIdeaId: IdeaId;
  readonly choice: 'LinkToExisting' | 'ExtendExisting' | 'CreateNewIssue';
  readonly actor: OwnerId;
}

export interface DraftBriefCommand {
  readonly ideaId: IdeaId;
  readonly authoredBy: 'Owner' | 'ClarificationModel' | 'OwnerEdit';
  readonly sections: BriefSectionsView;
  readonly basedOnBriefVersion: number | null;
  readonly actor: OwnerId;
}

export interface AnswerClarifyingQuestionCommand {
  readonly ideaId: IdeaId;
  readonly questionId: string;
  readonly answer: string;
  readonly actor: OwnerId;
}

export interface AskClarifyingQuestionsCommand {
  readonly ideaId: IdeaId;
  readonly sections: BriefSectionsView;
  readonly ambiguities: readonly AmbiguityInput[];
  readonly actor: OwnerId;
}

export interface ApplyCorrectionCommand {
  readonly ideaId: IdeaId;
  readonly text: string;
  readonly sections: BriefSectionsView;
  readonly basedOnBriefVersion: number;
  readonly actor: OwnerId;
}

/**
 * Intake: capture, brief, clarification and the owner's disposition (F06, F07).
 *
 * Every method returns a typed `Result` and none of them publishes or schedules:
 * there is no member that creates a ticket or consumes a coding run, which is what
 * makes archiving safe (F06-AC5). Reads carry no caller, matching the other groups;
 * writes carry the owner the transport proved (F01-AC1).
 */
export interface IntakeUseCases {
  captureIdea(command: CaptureIdeaCommand): Promise<Result<IntakeIdeaView, DomainError>>;
  listIdeas(): Promise<Result<readonly IntakeIdeaView[], DomainError>>;
  getIdea(ideaId: IdeaId): Promise<Result<IntakeDetailView, DomainError>>;
  attachFile(command: AttachFileCommand): Promise<Result<IntakeIdeaView, DomainError>>;
  recordSummary(command: RecordSummaryCommand): Promise<Result<IntakeIdeaView, DomainError>>;
  archiveIdea(command: DispositionCommand): Promise<Result<IntakeIdeaView, DomainError>>;
  deferIdea(command: DispositionCommand): Promise<Result<IntakeIdeaView, DomainError>>;
  findRelatedWork(ideaId: IdeaId): Promise<Result<readonly RelatednessReportView[], DomainError>>;
  recordRelatedWorkChoice(
    command: RecordRelatedWorkChoiceCommand,
  ): Promise<Result<RelatedWorkChoiceView, DomainError>>;
  draftBrief(command: DraftBriefCommand): Promise<Result<BriefVersionView, DomainError>>;
  agreeBrief(command: { readonly ideaId: IdeaId; readonly actor: OwnerId }): Promise<Result<BriefVersionView, DomainError>>;
  askClarifyingQuestions(command: AskClarifyingQuestionsCommand): Promise<Result<ClarificationRoundView, DomainError>>;
  answerClarifyingQuestion(
    command: AnswerClarifyingQuestionCommand,
  ): Promise<Result<ClarifyingQuestionView, DomainError>>;
  applyOwnerCorrection(command: ApplyCorrectionCommand): Promise<Result<CorrectionView, DomainError>>;
  exportIdea(ideaId: IdeaId): Promise<Result<IdeaExportView, DomainError>>;
}

/* -------------------------------------------------------------------------- */
/* Runs, attention and the review card                                         */
/* -------------------------------------------------------------------------- */

/** The buckets the dashboard groups into, as the domain's own grouping names them (F31-AC1). */
export type AttentionBucket = 'Working' | 'NeedsYourInput' | 'ReadyForYourTest' | 'ReadyForRelease';

/** The bounded limits a run is recorded with, as the transport reports them (F18-AC2). */
export interface AttemptLimitView {
  readonly activeExecutionMs: number;
  readonly automatedFixPasses: number;
}

/**
 * One area of the recorded readiness assessment (F09-AC1).
 *
 * A confirmation with an optional note, because the only thing this server can know about
 * a prerequisite is what the owner said about it. The verdict is the domain's, and the
 * reason travels either way so the assessment says what it looked at (F09-AC4).
 */
export interface ReadinessAreaInput {
  readonly confirmed: boolean;
  readonly note: string | null;
}

export interface ReadinessInput {
  readonly scope: ReadinessAreaInput;
  readonly criteria: ReadinessAreaInput;
  readonly repository: ReadinessAreaInput;
  readonly target: ReadinessAreaInput;
  readonly verification: ReadinessAreaInput;
  readonly access: ReadinessAreaInput;
}

/** The scope a run records, as the provider reported it (F12-AC1). */
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

/**
 * One durable job row (F13-AC1).
 *
 * The limits and the granted operations travel with it because both are facts about the
 * row: an owner reading "running" cannot otherwise ask what the attempt is bounded by or
 * what it may do (F18-AC2, F13-AC3).
 */
export interface RunJobView {
  readonly jobId: string;
  readonly operationId: string;
  readonly mode: JobMode;
  readonly workItemId: string;
  readonly scopeSnapshotId: string;
  readonly projectId: string;
  readonly profileVersionId: string;
  readonly procedureVersionId: string;
  readonly state: AttemptState;
  readonly correlationId: string;
  readonly limits: {
    readonly activeExecutionMs: number;
    readonly maxAutomatedFixPasses: number;
    readonly maxToolRetries: number;
    readonly maxAttempts: number;
  };
  readonly permittedOperations: readonly JobOperation[];
  readonly holder: string | null;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The resume point a run carries (F17-AC2).
 *
 * Head and base are full commit SHAs and are never abbreviated here, because the comparison
 * a resume performs is against a real checkout (F17-AC2). The dirty and untracked inventory
 * travels with them: it is what a resume preserves, so an owner cannot otherwise see what
 * the next attempt will keep.
 */
export interface RunCheckpointView {
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
 * `ReconciliationRequired` is a distinct value from `Vacant` because an expired lease proves
 * heartbeats stopped, not that the writer stopped: a reader that collapsed the two would
 * report a run as safely paused while a process may still be writing code (F17-AC5).
 */
export interface RunWriterView {
  readonly holder: string | null;
  readonly disposition: 'Vacant' | 'Held' | 'ReconciliationRequired' | 'Unleased';
  readonly expiresAt: string | null;
  readonly reconciliationReason: string | null;
}

export interface RunView {
  readonly job: RunJobView;
  readonly checkpoint: RunCheckpointView | null;
  readonly writer: RunWriterView;
}

/**
 * A paused run and whether its writer actually stopped (F17-AC1).
 *
 * A separate field rather than an implication of the state, because a run may only be shown
 * as `Paused` once the writer is stopped or safely detached.
 */
export interface PausedRunView extends RunView {
  readonly writerStopped: boolean;
}

export interface ResumedRunView {
  readonly job: RunJobView;
  readonly checkpoint: RunCheckpointView;
}

export interface CancelledRunView {
  readonly job: RunJobView;
  readonly preservedCheckpoint: RunCheckpointView | null;
  readonly writer: RunWriterView;
  /** A single value: a cancellation cannot reverse an external delivery (F17-AC4). */
  readonly externalDelivery: 'UnchangedByCancellation';
}

export interface GrantedExtensionView {
  readonly job: RunJobView;
  readonly previousLimits: AttemptLimitView;
  readonly extendedLimits: AttemptLimitView;
  /** Literal false: nothing in storage writes the extended bound onto the job (F18-AC2). */
  readonly extendedBoundRecorded: false;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export interface DeclinedExtensionView {
  readonly job: RunJobView;
  readonly limitsInForce: AttemptLimitView;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

/** Where a started run sits with respect to the single global coding writer (F13-AC2). */
export interface RunDispatchView {
  readonly state: 'Queued';
  readonly heldByWriter: readonly string[];
  readonly reason: string;
}

/** The capability grant a started run holds, with the delivery refusals named (F13-AC3). */
export interface RunGrantView {
  readonly mode: JobMode;
  readonly permittedOperations: readonly JobOperation[];
  readonly refusedDeliveryOperations: readonly JobOperation[];
  readonly refusalReason: string;
}

export interface CapturedScopeView {
  readonly scopeSnapshotId: string;
  readonly workItemId: string;
  readonly sequenceNumber: number;
  readonly scopeFingerprint: string;
  readonly capturedAt: string;
}

export interface RunStartView {
  readonly job: RunJobView;
  /** True when this operation identity had already started that run (F13-AC2). */
  readonly deduplicated: boolean;
  readonly capturedScope: CapturedScopeView;
  readonly dispatch: RunDispatchView;
  readonly grant: RunGrantView;
  readonly requestedByOwner: string;
}

export interface StartRunCommand {
  readonly workItemId: string;
  readonly mode: JobMode;
  readonly operationId: string;
  readonly correlationId: string | null;
  readonly scope: RunScopeInput;
  readonly readiness: ReadinessInput;
  readonly at: string;
  readonly actor: OwnerId;
}

export interface DecideExtensionCommand {
  readonly jobId: JobId;
  readonly actor: OwnerId;
}

/**
 * Run start, lifecycle moves and owner limit decisions (F13, F17, F18).
 *
 * Writes carry the owner the transport proved; reads carry no caller, so a read cannot be
 * authorized by a request body (F01-AC1). `listRuns` answers with the job rows alone: a
 * listing has no judgement to add, and reading every checkpoint here would make its cost
 * grow with the number of runs an owner is least likely to open (N04-AC2).
 */
export interface RunUseCases {
  startRun(command: StartRunCommand): Promise<Result<RunStartView, DomainError>>;
  listRuns(): Promise<Result<readonly RunJobView[], DomainError>>;
  getRun(jobId: JobId): Promise<Result<RunView, DomainError>>;
  pauseRun(jobId: JobId): Promise<Result<PausedRunView, DomainError>>;
  resumeRun(jobId: JobId): Promise<Result<ResumedRunView, DomainError>>;
  cancelRun(jobId: JobId): Promise<Result<CancelledRunView, DomainError>>;
  grantExtension(command: DecideExtensionCommand): Promise<Result<GrantedExtensionView, DomainError>>;
  declineExtension(command: DecideExtensionCommand): Promise<Result<DeclinedExtensionView, DomainError>>;
}

/** One attention item, with the blocker and the one next action it names (F31-AC1, F31-AC2). */
export interface AttentionItemView {
  readonly attentionItemId: string;
  readonly kind: AttentionKind;
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
 * The board, with the instant it was collected (F31-AC1, N04-AC2).
 *
 * `projectId` is null when this owner has no recorded work at all, which is a different fact
 * from a project with an empty board. Only the identities in `persistedItemIds` can be
 * acknowledged: a derived run-progress item has a stable identity but no row, and
 * acknowledging it would record attention nowhere (F31-AC3, F31-AC4).
 */
export interface AttentionBoardView {
  readonly projectId: string | null;
  readonly collectedAt: string;
  readonly items: readonly AttentionItemView[];
  readonly groups: readonly {
    readonly bucket: AttentionBucket;
    readonly items: readonly AttentionItemView[];
  }[];
  readonly persistedItemIds: readonly string[];
}

export interface AttentionUseCases {
  collectAttention(command: {
    readonly projectId: string | null;
    readonly at: string;
  }): Promise<Result<AttentionBoardView, DomainError>>;
  acknowledge(command: {
    readonly attentionItemId: AttentionItemId;
    readonly actor: OwnerId;
  }): Promise<Result<AttentionItemView, DomainError>>;
}

/** The review card as the owner reads it, including why it is not ready (F24-AC2, F24-AC3). */
export interface ReviewCardView {
  readonly candidateFingerprint: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly scopeFingerprint: string;
  readonly scopeRevision: number;
  readonly collectedAt: string;
  readonly checks: readonly {
    readonly checkId: string;
    readonly name: string;
    readonly origin: string | null;
    readonly required: boolean;
    readonly result: string;
    readonly blocking: boolean;
    readonly exitCode: number | null;
    readonly artifactRef: string | null;
    readonly detail: string | null;
  }[];
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly text: string;
    readonly methodKind: string;
    readonly status: string;
    readonly evidenceId: string | null;
    readonly observedAt: string | null;
    readonly detail: string | null;
  }[];
  readonly pendingOwnerTestCriterionIds: readonly string[];
  readonly readyForOwnerTest: boolean;
  /** Named reasons the work cannot be accepted, never an omission (F24-AC3). */
  readonly notReady: readonly string[];
}

export interface ReviewCardUseCases {
  /**
   * The card for the candidate the run's work item currently offers.
   *
   * A run with no candidate yet is `NotFound`: an empty card would read as a candidate that
   * passed nothing it was asked about (F24-AC3).
   */
  buildReviewCard(jobId: JobId): Promise<Result<ReviewCardView, DomainError>>;
}

/** One criterion's standing as the owner sees it before deciding (F25-AC1). */
export interface CriterionStandingView {
  readonly criterionId: string;
  readonly text: string;
  readonly methodKind: string;
  readonly status: string;
  /** False when no evidence row exists at all, which differs from one that failed. */
  readonly observed: boolean;
}

/** The acceptance state the candidate currently holds, plus retained feedback (F25-AC2). */
export interface AcceptanceView {
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

export interface AcceptanceReportView {
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

export interface ChangeRequestReportView {
  readonly candidateId: string;
  readonly workItemId: string;
  readonly decisionId: string;
  readonly state: 'ChangesRequested';
  readonly ownerId: string;
  readonly decidedAt: string;
  readonly feedback: string;
  /** The criteria the candidate had not satisfied, so the reason lands somewhere (F25-AC2). */
  readonly outstandingCriterionIds: readonly string[];
}

export interface AcceptanceGateView {
  readonly candidateFingerprint: string;
  readonly headSha: string;
  readonly scopeFingerprint: string;
  readonly criteria: readonly CriterionStandingView[];
  readonly outstandingCriterionIds: readonly string[];
  readonly ready: boolean;
}

export interface AcceptanceUseCases {
  /**
   * Records the owner's reason against the candidate this run currently offers (F25-AC2).
   *
   * Keyed by run because that is what the owner acted on, and resolved to a candidate by
   * the controller so a request cannot name a candidate the run does not offer (F25-AC3).
   */
  requestChanges(command: {
    readonly jobId: JobId;
    readonly reason: string;
    readonly actor: string;
    readonly at: string;
  }): Promise<Result<ChangeRequestReportView, DomainError>>;
  /** Records acceptance, or refuses with the outstanding criteria named (F25-AC1). */
  recordAcceptance(command: {
    readonly jobId: JobId;
    readonly note: string | null;
    readonly actor: string;
    readonly at: string;
  }): Promise<Result<AcceptanceReportView, DomainError>>;
  currentAcceptance(jobId: JobId): Promise<Result<AcceptanceView, DomainError>>;
  acceptanceGate(jobId: JobId): Promise<Result<AcceptanceGateView, DomainError>>;
}

/* -------------------------------------------------------------------------- */
/* Plans, readiness, publication and adoption                                 */
/* -------------------------------------------------------------------------- */

/** One proposed task's plan content, with the acceptance that makes it publishable (F08-AC3). */
export interface PlanTaskView {
  readonly taskId: string;
  readonly outcome: string;
  readonly scope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly verificationMethod: string;
  readonly dependencies: readonly string[];
  readonly relevantProjectContext: readonly string[];
  /**
   * Always tagged `ProposedLocation` (F08-AC5).
   *
   * The tag is carried rather than assumed by the client so a suggestion cannot be
   * rendered as an inspected fact: the transport states what kind of thing this is
   * instead of leaving the reader to infer it from the word "location".
   */
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
  /** False for anything but an accepted proposal, so an unaccepted task offers no ticket (F08-AC3). */
  readonly publishable: boolean;
}

/** Why the plan holds the number of tasks it holds (F08-AC2). */
export interface PlanSplitView {
  readonly split: boolean;
  readonly reason: string;
  readonly justifications: readonly ('IndependentlyReviewable' | 'RealDependency')[];
  readonly surfacesWithoutOwnBehaviour: readonly string[];
}

/**
 * A plan as the owner reviews it (F08-AC1, F08-AC2, F08-AC4, F08-AC5).
 *
 * `split.reason` is the justification for the task count and `coverage` records how
 * every requested outcome is accounted for, so neither is a thing the client has to
 * recompute and trust. `proposedOrder` is prerequisites first and `taskReadiness`
 * names what blocks each task, which is what makes a cyclic or unresolved dependency
 * visible rather than inferred from the dependency list (F08-AC4).
 */
export interface PlanView {
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
  readonly split: PlanSplitView;
  readonly tasks: readonly PlanTaskView[];
  /** The sequence the owner agreed, which a reorder changes (F08-AC3). */
  readonly agreedSequence: readonly string[];
  /** What the dependencies permit, which a reorder cannot change (F08-AC4). */
  readonly proposedOrder: readonly string[];
  readonly taskReadiness: readonly {
    readonly taskId: string;
    readonly ready: boolean;
    readonly readyAfter: readonly string[];
    readonly blockedBy: readonly (
      | { readonly kind: 'Cycle'; readonly cycle: readonly string[] }
      | { readonly kind: 'UnresolvedDependency'; readonly dependsOn: string }
    )[];
  }[];
  readonly digest: string;
  readonly workItemIdByTaskId: Readonly<Record<string, string>>;
}

/** One readiness area with the reason it stands where it does (F09-AC1). */
export interface ReadinessAreaView {
  readonly area: string;
  readonly status: 'Satisfied' | 'Unmet' | 'Unknown';
  readonly reason: string;
  readonly remedy: string | null;
}

/**
 * The recorded readiness decision over every area F09-AC1 names (F09-AC1, F09-AC2).
 *
 * Every area is present, whether satisfied or not, so an assessment that never looked
 * at access cannot be presented as one that found access fine. `buildBlockingAreas`
 * travels with `mayStartBuild` because they are two readings of one decision (F09-AC2),
 * and `mayStartInvestigation` is separate because it is precisely when the build is
 * disabled that read-only investigation is still permitted.
 */
export interface ReadinessAssessmentView {
  readonly subjectId: string;
  readonly assessedAt: string;
  readonly verdict: 'Ready' | 'NeedsInformation' | 'Blocked';
  readonly mayStartBuild: boolean;
  readonly mayStartInvestigation: boolean;
  readonly buildBlockingAreas: readonly string[];
  readonly areas: readonly ReadinessAreaView[];
  readonly reasons: readonly { readonly area: string; readonly status: string; readonly reason: string }[];
}

/** One proposed ticket's outcome, as the owner must be shown it (F10-AC2). */
export interface TicketPublicationView {
  readonly workItemId: string;
  readonly taskId: string | null;
  readonly kind: 'Published' | 'Failed' | 'OutcomeUnknown';
  readonly issueId: string | null;
  readonly identifier: string | null;
  readonly url: string | null;
  readonly disposition: 'CreatedNew' | 'AlreadyPresent' | 'AdoptedExisting' | null;
  /** Links the provider refused, so a partial publication does not present as complete (F10-AC2). */
  readonly unlinked: readonly { readonly target: string; readonly reason: string }[];
  readonly detail: string;
}

/**
 * One publication request's whole outcome (F10-AC2, F10-AC3).
 *
 * `unpublished` is carried explicitly rather than left to be derived from `published`:
 * a partial failure has to name what remains, and a client that derived the remainder
 * could get it wrong exactly when it matters most. `reconciled` distinguishes a repeat
 * that addressed existing external work from one that wrote a new issue (F10-AC3).
 */
export interface PublicationReportView {
  readonly requestId: string;
  readonly planId: string;
  readonly tickets: readonly TicketPublicationView[];
  readonly published: readonly string[];
  readonly unpublished: readonly string[];
  readonly reconciled: boolean;
}

/** An adopted issue's live content, read rather than re-created (F11-AC1). */
export interface AdoptedIssueView {
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
  /** Always false: adoption creates no replacement and offers no merge (F11-AC1, F11-AC3). */
  readonly mergeable: false;
}

/** An adopted branch or pull request, verified before adoption (F11-AC2). */
export interface LinkedChangeView {
  readonly workItemId: string;
  readonly repository: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly pullRequestId: string | null;
}

/** A recorded Test or Review request for an adopted candidate (F11-AC5). */
export interface AdoptedEvaluationView {
  readonly workItemId: string;
  readonly mode: 'Test' | 'Review';
  readonly dedupKey: string;
  readonly created: boolean;
  /** Always false: requesting a review launches no job and rewrites no issue (F11-AC5). */
  readonly jobEnqueued: false;
}

export interface DraftPlanCommand {
  readonly ideaId: string;
  readonly planId: string;
  /** Decoded structured output. Validated by the domain, never by the route (F05-AC5). */
  readonly change: unknown;
  readonly proposal: unknown;
  readonly actor: OwnerId;
}

export interface EditPlanCommand {
  readonly planId: string;
  /** The edit, decoded by the controller into the domain's union (F08-AC3). */
  readonly edit: unknown;
  readonly actor: OwnerId;
}

/**
 * Planning, readiness, publication and adoption (F08, F09, F10, F11).
 *
 * Writes carry the owner the transport proved and reads carry no caller, following the
 * same rule as the other groups (F01-AC1). `publishPlan` and `adoptExistingIssue` are
 * separate from the plan reads because both are explicit owner actions on an accepted
 * revision, never a consequence of drafting or editing one (F10-AC1, F11-AC1).
 */
export interface PlanningUseCases {
  draftPlan(command: DraftPlanCommand): Promise<Result<PlanView, DomainError>>;
  getPlan(planId: string): Promise<Result<PlanView, DomainError>>;
  listPlansForIdea(ideaId: string): Promise<Result<readonly PlanView[], DomainError>>;
  editPlan(command: EditPlanCommand): Promise<Result<PlanView, DomainError>>;
  assessPlan(planId: string): Promise<Result<ReadinessAssessmentView, DomainError>>;
  publishPlan(command: {
    readonly planId: string;
    /** Stable across a retry, so a repeat reconciles rather than duplicating (F10-AC3). */
    readonly requestId: string;
    readonly correlationId: string;
    readonly actor: OwnerId;
  }): Promise<Result<PublicationReportView, DomainError>>;
  reconcilePublication(command: {
    readonly operationId: string;
    readonly resolution: unknown;
    readonly observedAt: string;
    readonly resolvedBy: string;
    readonly correlationId: string;
    readonly actor: OwnerId;
  }): Promise<Result<{ readonly resolution: string; readonly workItemId: string | null; readonly detail: string }, DomainError>>;
  adoptExistingIssue(command: {
    readonly projectId: ProjectId;
    readonly profileVersionId: ProfileVersionId;
    readonly procedureVersionId: string;
    readonly issueId: string;
    readonly expectedIdentifier: string | null;
    readonly title: string;
    readonly correlationId: string;
    readonly actor: OwnerId;
  }): Promise<Result<AdoptedIssueView, DomainError>>;
  linkExistingChange(command: {
    readonly workItemId: string;
    readonly repository: unknown;
    readonly branch: string;
    readonly baseBranch: string;
    readonly expectedHeadSha: string | null;
    readonly pullRequestId: string | null;
    readonly correlationId: string;
    readonly actor: OwnerId;
  }): Promise<Result<LinkedChangeView, DomainError>>;
  requestAdoptedEvaluation(command: {
    readonly workItemId: string;
    readonly candidateId: string | null;
    readonly candidateFingerprint: string | null;
    /** `Build` is expressible so the use case's own refusal is what the owner reads (F11-AC5). */
    readonly mode: 'Test' | 'Review' | 'Build';
    readonly correlationId: string;
    readonly actor: OwnerId;
  }): Promise<Result<AdoptedEvaluationView, DomainError>>;
}

/**
 * One generation run, as this HTTP layer carries it (F07-AC1, F08-AC1, N04-AC3).
 *
 * Declared with the four `may*` flags as literal `false`, because the capability profile is what
 * the run was granted and a renderer that could read one of them as `true` would be offering to
 * publish or deploy work that generation has no path to (F07-AC5).
 */
export interface GenerationRunView {
  readonly generationId: string;
  readonly pass: 'Brief' | 'Plan';
  readonly ideaId: string;
  readonly state: 'Queued' | 'Running' | 'Succeeded' | 'Failed';
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly connectorId: string | null;
  readonly engineVersion: string | null;
  readonly sessionId: string | null;
  readonly brief: {
    readonly briefId: string;
    readonly version: number;
    readonly state: string;
    readonly authoredBy: string;
    readonly questionCount: number;
    readonly rejectedCandidateCount: number;
  } | null;
  readonly plan: {
    readonly planId: string;
    readonly revision: number;
    readonly taskCount: number;
    readonly coveredOutcomeIds: readonly string[];
    readonly splitJustifications: readonly string[];
  } | null;
  readonly failure: {
    readonly code: string;
    readonly reason: string;
    readonly fields: readonly { readonly path: string; readonly message: string }[];
  } | null;
  readonly capability: {
    readonly name: string;
    readonly mayChangeApplicationCode: false;
    readonly mayPublishTickets: false;
    readonly mayDeploy: false;
    readonly mayStartCodingRun: false;
    readonly forbiddenSideEffects: readonly string[];
  };
}

/**
 * Starting and reading a generation run (N04-AC3).
 *
 * The start methods return the tracked identity rather than the answer, which is the whole point:
 * a model turn is asynchronous, so an owner action records an intent and the owner reads the
 * outcome from a later read. A write carries the owner the guard proved; reads carry none, because
 * a read cannot be authorized by a request body (F01-AC1).
 */
export interface GenerationUseCases {
  startBriefGeneration(command: { readonly ideaId: IdeaId; readonly actor: OwnerId }): Promise<Result<GenerationRunView, DomainError>>;
  startPlanGeneration(command: { readonly ideaId: IdeaId; readonly actor: OwnerId }): Promise<Result<GenerationRunView, DomainError>>;
  getGeneration(generationId: string): Promise<Result<GenerationRunView, DomainError>>;
  listGenerations(ideaId: IdeaId): Promise<Result<readonly GenerationRunView[], DomainError>>;
}

/** The whole injected surface. One argument, so a missing use case is a type error. */
export interface ControllerSurface {
  readonly owners: OwnerUseCases;
  readonly sessions: SessionUseCases;
  readonly profiles: ProfileUseCases;
  readonly connectors: ConnectorUseCases;
  readonly intake: IntakeUseCases;
  readonly runs: RunUseCases;
  readonly attention: AttentionUseCases;
  readonly reviewCards: ReviewCardUseCases;
  readonly acceptance: AcceptanceUseCases;
  readonly planning: PlanningUseCases;
  readonly generation: GenerationUseCases;
}

const REQUIRED_METHODS = {
  owners: ['provision', 'signIn'],
  sessions: ['loadByToken', 'create', 'revoke', 'touch'],
  profiles: ['saveVersion', 'currentVersion', 'listVersions'],
  connectors: ['register', 'listForProject', 'revoke'],
  intake: [
    'captureIdea',
    'listIdeas',
    'getIdea',
    'attachFile',
    'recordSummary',
    'archiveIdea',
    'deferIdea',
    'findRelatedWork',
    'recordRelatedWorkChoice',
    'draftBrief',
    'agreeBrief',
    'askClarifyingQuestions',
    'answerClarifyingQuestion',
    'applyOwnerCorrection',
    'exportIdea',
  ],
  runs: [
    'startRun',
    'listRuns',
    'getRun',
    'pauseRun',
    'resumeRun',
    'cancelRun',
    'grantExtension',
    'declineExtension',
  ],
  attention: ['collectAttention', 'acknowledge'],
  reviewCards: ['buildReviewCard'],
  acceptance: ['requestChanges', 'recordAcceptance', 'currentAcceptance', 'acceptanceGate'],
  planning: [
    'draftPlan',
    'getPlan',
    'listPlansForIdea',
    'editPlan',
    'assessPlan',
    'publishPlan',
    'reconcilePublication',
    'adoptExistingIssue',
    'linkExistingChange',
    'requestAdoptedEvaluation',
  ],
  generation: ['startBriefGeneration', 'startPlanGeneration', 'getGeneration', 'listGenerations'],
} as const satisfies Record<keyof ControllerSurface, readonly string[]>;

export type ControllerGroup = keyof typeof REQUIRED_METHODS;

/**
 * Structural check for a controller implementation loaded at runtime.
 *
 * The web server composes its controller from a module specifier, so the value
 * crossing this boundary is untrusted like any other external input. Checking the
 * shape here turns a wiring mistake into a startup failure with a named method
 * instead of a 500 on the owner's first request.
 */
export function isControllerSurface(value: unknown): value is ControllerSurface {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  for (const group of Object.keys(REQUIRED_METHODS) as ControllerGroup[]) {
    const port = candidate[group];
    if (typeof port !== 'object' || port === null) return false;
    const methods = port as Record<string, unknown>;
    for (const method of REQUIRED_METHODS[group]) {
      if (typeof methods[method] !== 'function') return false;
    }
  }
  return true;
}
