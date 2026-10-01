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

import type {
  CapabilityKind,
  ConnectorId,
  DomainError,
  IdeaId,
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

/** The whole injected surface. One argument, so a missing use case is a type error. */
export interface ControllerSurface {
  readonly owners: OwnerUseCases;
  readonly sessions: SessionUseCases;
  readonly profiles: ProfileUseCases;
  readonly connectors: ConnectorUseCases;
  readonly intake: IntakeUseCases;
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
