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
  ContractStatus,
  CriterionState,
  DomainError,
  IdeaId,
  JobId,
  JobMode,
  OwnerId,
  ProfileVersionId,
  ProjectId,
  Result,
} from '@shiploop/domain';
import type { HomeEvidenceSources } from './routes/home.ts';

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

/**
 * The project this session addresses, or the state the owner is in when none is selected
 * (F02-AC1, F02-AC2).
 *
 * A discriminated union rather than a nullable pair of fields, and that is the fix. The
 * historical defect was a session response carrying no project identity at all, so the client
 * reached for one it did not have and every project-scoped request went to a path spelled
 * `/api/profiles/undefined`; the server's honest 404 - "no such project" - was then reported
 * as "that project has no saved profile yet", which is a different and wrong claim about a
 * project's contents (F02-AC4).
 *
 * Two properties follow from the union:
 *
 *   - **no fabricated identity is representable.** The only way to hold an
 *     `activeProjectId` is to hold a `Selected` variant, which the controller produced from a
 *     project row this store holds. There is no placeholder project and no default to fall
 *     back on.
 *   - **"not chosen yet" is a state with a count in it.** `selectableProjectCount` lets the UI
 *     say "choose one of three" rather than showing an empty field, so an owner who has not
 *     selected anything is given the next action instead of a blank.
 */
export type ActiveProjectView =
  | {
      readonly state: 'Selected';
      readonly activeProjectId: string;
      readonly activeProjectName: string;
    }
  | {
      readonly state: 'NoProjectSelected';
      readonly selectableProjectCount: number;
    };

export interface OwnerView {
  readonly ownerId: OwnerId;
  readonly displayName: string;
  /**
   * The sign-in address this owner provisioned with, or null when the owner row carries none.
   *
   * Carried rather than left to the client to reconstruct, because the client displayed a
   * blank address beside the display name and the only way to fill it was to re-derive the
   * same slug rule the controller owns. Two derivations of one rule is how they drift, and a
   * drifted derivation shows the owner someone else's address (F01-AC1).
   */
  readonly email: string | null;
  readonly createdAt: string;
  /**
   * Which project this session addresses (F02-AC1).
   *
   * Part of the owner read rather than a second request, because a client that has to ask
   * separately has a window in which it addresses the previous project - which is what
   * produced the defect this field closes.
   */
  readonly activeProject: ActiveProjectView;
}

/**
 * One project as the owner selects it (F02-AC1).
 *
 * The identity and the display name travel together because the selector needs both and a
 * client that rendered an id where a name belongs would make the owner select a string.
 */
export interface ProjectView {
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/**
 * Project listing and creation, which the owner selects from (F02-AC1).
 *
 * `create` is the one project write that needs no configured provider. Every other write
 * that brings a `projects` row into existence — a profile save, a connector registration, a
 * procedure append — is refused by name when no adapter declares the capability it needs,
 * so without this an owner with no configured provider had no project to select and every
 * project-scoped screen had nothing to address (F03-AC2).
 */
export interface ProjectUseCases {
  listProjects(): Promise<Result<readonly ProjectView[], DomainError>>;
  createProject(command: {
    readonly projectId: string;
    readonly name: string;
    readonly at: string;
  }): Promise<Result<ProjectView, DomainError>>;
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
   * The identity this owner signs in with, read from the owner row (F01-AC1).
   *
   * A separate read rather than a field on `signIn` because the session route needs the
   * address on every request that re-establishes a session, not only at the moment one was
   * created, and a client that had to re-derive the address from the display name would own
   * a second copy of the controller's slug rule.
   */
  describe(command: { readonly ownerId: OwnerId }): Promise<Result<OwnerView, DomainError>>;
  /**
   * Chooses which project every subsequent project-scoped call addresses (F02-AC1).
   *
   * A server-side write rather than a value the client keeps, because a selection the client
   * holds is a selection the next session load does not have. A `projectId` this store does
   * not hold is refused by the controller with a 404, so the only way to hold an
   * `activeProjectId` is to have named a real one (F02-AC4).
   */
  selectActiveProject(command: {
    readonly ownerId: OwnerId;
    readonly projectId: string;
    readonly at: string;
  }): Promise<Result<ActiveProjectView, DomainError>>;
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

/**
 * The optional external-execution target, as the settings screen reads it
 * (L02-AC2, L02-AC3).
 *
 * `configured` is carried rather than inferred from `url`, so "this project has
 * no T3 deployment" is a state the transport can render rather than something a
 * client has to deduce from a null - and so an absent value is never mistaken for
 * a failed read (L02-AC3).
 */
export interface T3LaunchSettingView {
  readonly configured: boolean;
  /**
   * The configured base URL, or null when none is configured.
   *
   * Never a credential: a URL carrying a username, password or token is refused
   * before it is stored, so nothing returned here can be one (L02-AC2).
   */
  readonly url: string | null;
}

/**
 * The repository configuration this project already has, read from its current
 * profile version (F02-AC1, F02-AC2).
 *
 * A projection with the version identity attached rather than a second writable
 * copy: `profileVersionId` and `versionNumber` tell the client which version it
 * is looking at, and the profile route remains the only place one is saved.
 */
export interface RepositorySettingView {
  readonly configured: boolean;
  readonly profileVersionId: ProfileVersionId | null;
  readonly versionNumber: number | null;
  readonly repository: string | null;
  readonly baseBranch: string | null;
  readonly targetBranch: string | null;
  readonly ticketProvider: string | null;
  readonly deploymentProvider: string | null;
  readonly engine: string | null;
}

/**
 * One configured provider, as settings reports it (F03-AC3).
 *
 * There is no `credentialReference` field here and the connector's own view has
 * one, so a settings response cannot be where a credential pointer leaks. What
 * travels is the stored digest, which identifies the reference without carrying
 * it (F32-AC2).
 */
export interface ProviderSettingView {
  readonly connectorId: ConnectorId;
  readonly kind: ProfileConnectorKind;
  readonly provider: string;
  readonly resourceScope: string;
  readonly credentialReferenceDigest: string;
  readonly state: ProfileConnectorState;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
}

/** Everything one project's settings currently hold (mvp-spec 3). */
export interface ProjectSettingsView {
  readonly projectId: string;
  readonly t3: T3LaunchSettingView;
  readonly repository: RepositorySettingView;
  readonly providers: readonly ProviderSettingView[];
  /** When these settings were last written, or null when they never were. */
  readonly updatedAt: string | null;
}

/**
 * Project settings (mvp-spec 3, L02-AC2, L02-AC3).
 *
 * Both commands carry the owner the transport proved, and `projectId`, because
 * neither alone addresses a row: a project this deployment does not hold is a
 * `NotFound` here rather than an empty answer that reads as "configured and blank"
 * (F02-AC2). `readSettings` answers a project that has configured nothing with
 * `configured: false` and a 200, because that is the state a fresh MVP deployment
 * is in and the journey must work there (L02-AC3).
 */
export interface SettingsUseCases {
  readSettings(command: {
    readonly projectId: ProjectId;
    readonly actor: OwnerId;
  }): Promise<Result<ProjectSettingsView, DomainError>>;
  /**
   * Saves or clears the T3 deployment URL.
   *
   * `t3Url` absent means "nothing to change" and reads back rather than writing,
   * so a read-then-save round trip is idempotent. A malformed, credential-bearing
   * or non-http(s) value is refused with a remedy and never echoed (L02-AC2).
   */
  updateSettings(command: {
    readonly projectId: ProjectId;
    readonly t3Url?: string | null;
    readonly at: string;
    readonly actor: OwnerId;
  }): Promise<Result<ProjectSettingsView, DomainError>>;
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
    /**
     * The check this criterion's verdict is bound to, and the evidence row carrying it.
     *
     * Null means nothing verified the criterion. An automated criterion with a null
     * `verificationCheckId` is not ready, and the card names that rather than letting the
     * passing checks above it read as its verification (F23-AC1, F24-AC3).
     */
    readonly verificationCheckId: string | null;
    readonly verificationEvidenceId: string | null;
    /** What verified it, in words; null when nothing has. */
    readonly verificationDetail: string | null;
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

/**
 * Manual owner test recording (F23-AC1, F23-AC5, F24-AC4, F25-AC1, F25-AC4).
 */

/**
 * What the owner reports they observed, as the transport names it.
 *
 * `CaptureFailed` travels as its own member rather than as a failed behaviour, because a
 * screenshot that was never taken observed nothing and recording it as a behaviour failure
 * misleads in one direction, while recording it as a pass misleads in the other (F23-AC5).
 */
export type OwnerObservationKind = 'BehaviorConfirmed' | 'BehaviorFailed' | 'CaptureFailed';

/** The kinds of retained reference an observation may point at (F23-AC2). */
export type OwnerEvidenceKind = 'Screenshot' | 'ApiExchange' | 'CheckOutput';

/**
 * The deployment an observation was made against, or the owner's statement that none applies.
 *
 * Two shapes and no third, because "somewhere" is the one that lets a local check or a stale
 * preview stand in for the eligible deployment (F23-AC4). The controller resolves the named
 * deployment against the candidate, so this port cannot express an observation of a
 * deployment the candidate does not carry (F22-AC1).
 */
export type OwnerObservationTarget =
  | {
      readonly kind: 'Deployment';
      readonly component: string;
      readonly deploymentId: string;
      readonly environment: string;
    }
  | {
      readonly kind: 'NoDeployment';
      readonly reason: string;
    };

/**
 * One recorded owner observation, as the owner reads it back.
 *
 * `failureKind` is carried so the transport does not have to read the detail prose to tell a
 * behaviour failure from a capture failure, and `methodKind` is a single literal so a failed
 * owner test can never be rendered as a failed automated check (F23-AC5).
 */
export interface OwnerObservationView {
  readonly evidenceId: string;
  readonly criterionId: string;
  readonly methodKind: 'OwnerTest';
  readonly status: string;
  readonly failureKind: 'BehaviorFailure' | 'CaptureFailure' | null;
  /** The authenticated owner, which is never read from the request (F25-AC1, F25-AC4). */
  readonly observedBy: string;
  readonly observedAt: string;
  readonly environment: string;
  readonly component: string | null;
  readonly deploymentId: string | null;
  readonly evidenceKind: OwnerEvidenceKind;
  readonly evidenceRef: string;
  readonly detail: string | null;
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly scopeFingerprint: string;
  readonly correlationId: string;
}

export interface OwnerObservationReportView {
  readonly observation: OwnerObservationView;
  /** Always false and typed: recording an observation is not accepting the work (F25-AC1). */
  readonly recordedForDelivery: false;
  readonly outstandingCriterionIds: readonly string[];
}

/**
 * Manual owner test recording (F23-AC1, F23-AC5, F24-AC4, F25-AC1, F25-AC4).
 *
 * Keyed by run, like the acceptance group, because the run is what the owner acted on and the
 * controller resolves the candidate from it; a request therefore cannot name a candidate the
 * run does not offer. `expectedCandidateFingerprint` is separate and required: it is the
 * identity the owner's page was rendered against, and comparing it against the resolved
 * candidate is what turns an action taken from an outdated card into a `Conflict` rather than
 * a write against whatever is current now (F24-AC4). Writes carry the owner the transport
 * proved and no caller-supplied instant, so an observation cannot be attributed to a session
 * that did not make it or backdated (F25-AC4, F01-AC1).
 */
export interface OwnerTestUseCases {
  recordOwnerObservation(command: {
    readonly jobId: JobId;
    readonly criterionId: string;
    readonly expectedCandidateFingerprint: string;
    readonly observation: OwnerObservationKind;
    readonly observedAgainst: OwnerObservationTarget;
    readonly evidence: { readonly kind: OwnerEvidenceKind; readonly reference: string };
    readonly note: string | null;
    readonly actor: OwnerId;
  }): Promise<Result<OwnerObservationReportView, DomainError>>;
  /** The observations bound to one exact candidate identity (F20-AC3, F23-AC1). */
  listOwnerObservations(query: {
    readonly jobId: JobId;
    readonly candidateFingerprint: string;
  }): Promise<Result<readonly OwnerObservationView[], DomainError>>;
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

/**
 * One acceptance criterion of one contract revision (mvp-spec 3).
 *
 * `verificationType` decides who may settle it: `automated` by a check run, `owner_test` only
 * by the owner acting. It is a closed vocabulary rather than free text, because a text field
 * here is how "verified" comes to mean "someone read it".
 */
export interface ContractCriterionView {
  readonly id: string;
  readonly description: string;
  readonly verificationType: 'automated' | 'owner_test';
  /**
   * The check that verifies an automated criterion, or null when none is bound.
   *
   * Travels in both directions, and is always explicit rather than optional here: the route
   * turns an omitted binding on an incoming body into `null` before it reaches the
   * controller, so no caller downstream has to know whether the key was absent. A read
   * reports it so a client can tell which check settles which criterion, and omitting it on
   * an automated criterion is refused at approval rather than accepted as "any green check
   * will do" (F23-AC1).
   */
  readonly verificationCheckId: string | null;
}

/** One request as the transport reports it (mvp-spec 3). */
export interface RequestView {
  readonly requestId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly sourceIdeaId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One contract revision as the transport reports it (mvp-spec 3).
 *
 * `approvedAt` and `approvedBy` are nullable rather than nested in a status variant, because a
 * revision's history is what a reader needs: an invalidated approval keeps its approver while
 * `status` says it is no longer current. `answersCurrentRequest` is the layer's *report* that
 * an approved revision no longer matches the request it answers - it does not demote it, since
 * whether a request edit invalidates an agreement is the owner's call about scope.
 *
 * `contentFingerprint` is load-bearing rather than descriptive: it is the value a client sends
 * back as `expectedContentFingerprint` to edit this revision again or to approve it, and it is
 * the only concurrency token that holds over a draft's text, because a write and the write it
 * raced can share an `updatedAt`. A response that omitted it, or reported the fingerprint of
 * the text *before* the change it just made, would leave the next call unable to say what it
 * is writing over (mvp-spec 3, mvp-spec 7 "Reject stale requests").
 */
export interface ContractView {
  readonly contractId: string;
  readonly revision: number;
  readonly projectId: string;
  readonly requestId: string;
  readonly status: 'draft' | 'approved' | 'stale';
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly ContractCriterionView[];
  readonly contentFingerprint: string;
  readonly requestFingerprint: string;
  readonly answersCurrentRequest: boolean;
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
  readonly staleReason: string | null;
  readonly supersededByRevision: number | null;
  readonly sourceBriefId: string | null;
  readonly sourceBriefVersion: number | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Why this revision may not be measured against a candidate, or null when it may. */
  readonly blockedBecause: string | null;
}

/** One request and the contract state that answers it (mvp-spec 3). */
export interface RequestDetailView {
  readonly request: RequestView;
  readonly latestRevision: ContractView | null;
  readonly approvedRevision: ContractView | null;
  readonly revisions: readonly ContractView[];
}

/** The reasons an approval may be retired, as this transport names them (mvp-spec 3). */
export const CONTRACT_STALE_REASONS = ['RequestChanged', 'SurroundingContextChanged', 'WithdrawnByOwner'] as const;
export type ContractStaleReason = (typeof CONTRACT_STALE_REASONS)[number];

/**
 * The owner's request and the delivery contract that answers it (mvp-spec 3).
 *
 * `approveRevision` takes no approver parameter at all. The approver is read from the session,
 * so a body cannot record an approval attributed to somebody else - the one thing an approval
 * may never be (mvp-spec 3). It does take the fingerprint of the revision the owner read,
 * because refusing an approval that cannot name its text matters more than keeping the body
 * free of everything, and that value is one this server issued.
 *
 * Every command carries both a project and an identity, because neither alone addresses a row:
 * a request id from another project is a `NotFound` here, not a read of this one's data
 * (F02-AC2).
 */
export interface ContractUseCases {
  createRequest(command: {
    readonly projectId: string;
    readonly title: string;
    readonly description: string;
    readonly actor: OwnerId;
  }): Promise<Result<RequestView, DomainError>>;
  getRequest(command: {
    readonly projectId: string;
    readonly requestId: string;
    readonly actor: OwnerId;
  }): Promise<Result<RequestDetailView, DomainError>>;
  listRequests(command: {
    readonly projectId: string;
    readonly actor: OwnerId;
  }): Promise<Result<readonly RequestView[], DomainError>>;
  updateRequest(command: {
    readonly projectId: string;
    readonly requestId: string;
    readonly title?: string;
    readonly description?: string;
    readonly expectedUpdatedAt: string;
    readonly actor: OwnerId;
  }): Promise<Result<RequestView, DomainError>>;
  draftContract(command: {
    readonly projectId: string;
    readonly requestId: string;
    readonly outcome: string;
    readonly scope: readonly string[];
    readonly outOfScope: readonly string[];
    readonly acceptanceCriteria: readonly ContractCriterionView[];
    readonly actor: OwnerId;
  }): Promise<Result<ContractView, DomainError>>;
  getContract(command: {
    readonly projectId: string;
    readonly contractId: string;
    readonly revision: number;
    readonly actor: OwnerId;
  }): Promise<Result<ContractView, DomainError>>;
  listContractRevisions(command: {
    readonly projectId: string;
    readonly requestId: string;
    readonly actor: OwnerId;
  }): Promise<Result<readonly ContractView[], DomainError>>;
  listContractCriteria(command: {
    readonly projectId: string;
    readonly contractId: string;
    readonly revision: number;
    readonly actor: OwnerId;
  }): Promise<Result<readonly ContractCriterionView[], DomainError>>;
  editContract(command: {
    readonly projectId: string;
    readonly contractId: string;
    readonly revision: number;
    readonly outcome: string;
    readonly scope: readonly string[];
    readonly outOfScope: readonly string[];
    readonly acceptanceCriteria: readonly ContractCriterionView[];
    /**
     * The `contentFingerprint` the revision carried when it was read, sent back by the
     * client, and required.
     *
     * An edit is a write over text, and the revision number alone does not name which text:
     * two tabs on one draft both name revision 1. `updatedAt` cannot stand in for it either,
     * because two writes can share a millisecond and leave the instant unchanged either side
     * of the first - which would let the second tab's write land over the first while both
     * reported success. So an edit and an approval carry the same value, and the server
     * checks it against the fingerprint it derives rather than trusting it (mvp-spec 3,
     * mvp-spec 7 "Reject stale requests").
     */
    readonly expectedContentFingerprint: string;
    readonly actor: OwnerId;
  }): Promise<Result<ContractView, DomainError>>;
  approveRevision(command: {
    readonly projectId: string;
    readonly contractId: string;
    readonly revision: number;
    /**
     * The `contentFingerprint` the revision carried when it was read, sent back by the
     * client, and required.
     *
     * An approval is an owner's agreement to text. Without this value the route could only
     * name a *revision*, and two tabs on one draft both name revision 1 - so the call would
     * succeed against whatever the second tab had written since the first tab's page was
     * rendered, and the sealed agreement would describe a scope its owner never read. The
     * fingerprint is a reference to a value this server derived, not an instruction, and the
     * controller refuses a mismatch with the fingerprint now stored (mvp-spec 3, F24-AC4).
     *
     * There is still no owner field: the approver is read from the session (F01-AC1).
     */
    readonly expectedContentFingerprint: string;
    readonly actor: OwnerId;
  }): Promise<Result<ContractView, DomainError>>;
  reviseContract(command: {
    readonly projectId: string;
    readonly contractId: string;
    readonly revision: number;
    readonly outcome: string;
    readonly scope: readonly string[];
    readonly outOfScope: readonly string[];
    readonly acceptanceCriteria: readonly ContractCriterionView[];
    readonly actor: OwnerId;
  }): Promise<Result<ContractView, DomainError>>;
  invalidateRevision(command: {
    readonly projectId: string;
    readonly contractId: string;
    readonly revision: number;
    readonly reason: ContractStaleReason;
    readonly actor: OwnerId;
  }): Promise<Result<ContractView, DomainError>>;
}

/**
 * The implementation handoff packet, as this transport carries it (mvp-spec L02-AC3).
 *
 * `markdown` is the controller's bytes, untouched. Nothing in this layer may reformat it,
 * trim it or re-escape it: the property that makes a handoff trustworthy is that one
 * approved contract produces one document, and a transport that tidied the text would make
 * two packets differ for a reason nobody chose. `fingerprint` is the digest of those bytes,
 * so a client can prove they are the same without diffing them (N02-AC2).
 */
export interface HandoffPacketView {
  readonly markdown: string;
  readonly fingerprint: string;
}

/** A missing prerequisite with the remedy the operator can act on (F04-AC3). */
export interface HandoffPrerequisiteView {
  readonly name: string;
  readonly detail: string;
  readonly remedy: string;
}

/**
 * Where the browser may be sent to open the external executor, if anywhere (mvp-spec L02).
 *
 * Three states, because a nullable URL cannot tell them apart and the difference changes
 * what the owner is told: nothing configured is normal and the packet works anyway, while a
 * configured value that is refused is an operator error with a different remedy. No state
 * reproduces the configured value, which may itself be the secret (N02-AC2).
 */
export type HandoffT3View =
  | { readonly state: 'Configured'; readonly url: string }
  | {
      readonly state: 'NotConfigured';
      readonly reason: string;
      readonly prerequisites: readonly HandoffPrerequisiteView[];
    }
  | {
      readonly state: 'Unusable';
      readonly reason: string;
      readonly prerequisites: readonly HandoffPrerequisiteView[];
    };

/**
 * One approved revision, rendered into the text an implementer outside ShipLoop is handed
 * (mvp-spec L02-AC3).
 *
 * The controller owns this text. A client that assembled packet content itself would own the
 * redaction guarantee instead, and a credential pasted into a criterion description would
 * travel from a response to a clipboard to an external tool with nothing in between stopping
 * it. The route that serves it is a read: it renders, it decides nothing, and it contacts
 * nothing (N02-AC2).
 */
export interface HandoffView {
  readonly contractId: string;
  readonly revision: number;
  readonly packet: HandoffPacketView;
  readonly t3: HandoffT3View;
}

/**
 * The external-execution handoff (mvp-spec L02).
 *
 * The command carries the actor because the read is project-scoped and ownership is proved
 * server-side before the revision is read; a client that supplied a project id it merely
 * knows would otherwise be addressing another owner's work (F01-AC1, F02-AC2).
 */
export interface HandoffUseCases {
  buildHandoff(command: {
    readonly projectId: string;
    readonly contractId: string;
    readonly revision: number;
    readonly actor: OwnerId;
  }): Promise<Result<HandoffView, DomainError>>;
}

/* -------------------------------------------------------------------------- */
/* The review card and the owner decision                                       */
/* -------------------------------------------------------------------------- */

/** The criterion states the domain already enumerates; nothing here adds one. */
type ReviewCriterionState = CriterionState;

/** What a check may read. `not_run` and `stale` are members, not absences. */
export type ReviewCheckResult =
  | 'passed'
  | 'failed'
  | 'waiting'
  | 'missing'
  | 'capture_failed'
  | 'stale'
  | 'not_run';

/** The two decisions the MVP ends at, and nothing else (mvp-spec 3, F25). */
export type ReviewDecisionKind = 'accepted' | 'changes_requested';

export interface ReviewRequestView {
  readonly requestId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewContractView {
  readonly contractId: string;
  readonly projectId: string;
  readonly requestId: string;
  /** The revision every criterion, every evidence row and every decision binds to. */
  readonly revision: number;
  readonly status: ContractStatus;
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly approval: { readonly approvedAt: string | null; readonly approvedBy: string | null };
  readonly acceptanceCriteria: readonly {
    readonly id: string;
    readonly verificationType: 'automated' | 'owner_test';
    /** The check that verifies an automated criterion, or null when none is bound. */
    readonly verificationCheckId: string | null;
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewCandidateView {
  readonly candidateId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  /** The provider's own spelling, passed through and never inferred (mvp-spec 3). */
  readonly pullRequestState: string;
  readonly draft: boolean;
  readonly baseBranch: string;
  /** The full commit SHA. Never an abbreviation, a branch name or a pull request number. */
  readonly headSha: string;
  readonly observedAt: string;
}

export interface ReviewPolicyView {
  readonly policyId: string;
  readonly requiredAutomatedCheckIds: readonly string[];
  readonly ownerTestBlocksReview: boolean;
  readonly ownerTestBlocksDelivery: boolean;
}

export interface ReviewCheckView {
  readonly checkId: string;
  readonly required: boolean;
  readonly blocking: boolean;
  readonly result: ReviewCheckResult;
  readonly evidenceId: string | null;
  readonly source: string | null;
  readonly reason: string;
}

export interface ReviewCriterionView {
  readonly criterionId: string;
  readonly description: string;
  readonly verificationType: 'automated' | 'owner_test';
  /** Null when the contract assigned no verifier; a criterion with none is `unverified`. */
  readonly verificationCheckId: string | null;
  readonly state: ReviewCriterionState;
  readonly methodKind: string;
  readonly methodDetail: string | null;
  readonly evidenceId: string | null;
  readonly observedAt: string | null;
  readonly reason: string;
}

export interface ReviewOwnerTestView {
  readonly criterionId: string;
  readonly description: string;
  readonly instructions: string | null;
  /** `pending` until the owner records a result; nothing on this card may move it. */
  readonly state: ReviewCriterionState;
  readonly evidenceId: string | null;
  readonly observedAt: string | null;
  readonly reason: string;
}

/**
 * One recorded observation, with its staleness stated rather than implied (F20-AC3, F24-AC3).
 *
 * The three fields are named so that none of them can be reached for by mistake:
 *
 *   - `recordedOutcome` is what the source said at the time. It stays `passed` after a
 *     later push, so it is history and never a verdict on the candidate on screen.
 *   - `currentOutcome` is what that observation means *now*; it is `stale` whenever
 *     `countsForCurrentCandidate` is false.
 *   - `countsForCurrentCandidate` is the affirmative answer to "may this be shown as this
 *     candidate's result?".
 *
 * There is deliberately no `outcome` member: a client that reached for it would find
 * nothing, which is the only way this boundary can refuse to hand out the field that
 * makes a stale pass render green (mvp-review.md, "The read model").
 */
/**
 * The five outcomes an observation can carry, and the sixth a reader must not mistake for one.
 *
 * Named here so the card's evidence rows and the verification report's observations cannot drift
 * into two spellings of "what the source observed" (F20-AC2, F23-AC5).
 */
export type ReviewEvidenceOutcome = 'passed' | 'failed' | 'waiting' | 'missing' | 'capture_failed';

export interface ReviewEvidenceView {
  readonly evidenceId: string;
  readonly source: 'project_command' | 'github_check' | 'browser' | 'owner_test';
  readonly criterionId: string | null;
  readonly checkId: string | null;
  readonly recordedOutcome: ReviewEvidenceOutcome;
  readonly currentOutcome: ReviewEvidenceOutcome | 'stale';
  readonly countsForCurrentCandidate: boolean;
  readonly staleReasons: readonly string[];
  readonly reason: string;
  readonly observedAt: string | null;
  /** The full commit the source said it observed, or null when it could not attribute one. */
  readonly candidateHeadSha: string | null;
  readonly contractRevision: number | null;
  readonly detail: string | null;
  readonly artifactRef: string | null;
}

export interface ReviewStalenessView {
  readonly stale: boolean;
  readonly reasons: readonly string[];
  readonly staleEvidenceIds: readonly string[];
  readonly staleDecisionIds: readonly string[];
}

/** One owner decision that no longer describes the candidate on screen (F25-AC3). */
export interface ReviewStaleDecisionView {
  readonly decisionId: string;
  readonly kind: ReviewDecisionKind;
  readonly candidateHeadSha: string;
  readonly contractRevision: number;
  readonly reason: string;
}

export interface ReviewOwnerDecisionView {
  readonly decisionId: string;
  readonly kind: ReviewDecisionKind;
  /** The authenticated owner. Never read from a request body (F01-AC1, F25-AC4). */
  readonly ownerId: string;
  readonly decidedAt: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly candidateId: string;
  readonly candidateHeadSha: string;
  readonly feedback: string | null;
}

export interface ReviewDecisionView {
  readonly outcome: 'none' | ReviewDecisionKind;
  readonly decision: ReviewOwnerDecisionView | null;
  readonly staleDecisions: readonly ReviewStaleDecisionView[];
  /** False after a push: an acceptance for SHA A does not authorise SHA B (F27-AC3). */
  readonly authorizesCurrentCandidate: boolean;
}

/** The three gates, kept apart because the product keeps them apart (F24-AC3, F25-AC1). */
export interface ReviewEligibilityView {
  readonly readyForOwnerReview: boolean;
  readonly readyForAcceptance: boolean;
  readonly readyForDelivery: boolean;
  readonly blockingReasons: readonly string[];
  readonly ownerActions: readonly string[];
  readonly acceptanceBlockers: readonly string[];
  readonly deliveryBlockers: readonly string[];
}

/**
 * The whole review card, computed once (F24-AC2).
 *
 * `MvpReviewCardView` is a transcription of the controller's `MvpReviewCard`, and the two
 * are kept in step by `web-surface.test.ts`, which fails if either side gains or loses a
 * field. The card arrives by one read and is answered by one write; nothing accumulates it
 * across requests, which is what makes the criterion states, the evidence rows and the
 * decision on one card mutually consistent.
 */
export interface MvpReviewCardView {
  readonly collectedAt: string;
  readonly request: ReviewRequestView;
  readonly contract: ReviewContractView;
  readonly candidate: ReviewCandidateView;
  readonly policy: ReviewPolicyView;
  readonly checks: readonly ReviewCheckView[];
  readonly criteria: readonly ReviewCriterionView[];
  readonly ownerTests: readonly ReviewOwnerTestView[];
  readonly evidence: readonly ReviewEvidenceView[];
  readonly staleness: ReviewStalenessView;
  readonly decision: ReviewDecisionView;
  readonly eligibility: ReviewEligibilityView;
}

export interface ReadMvpReviewCommand {
  readonly projectId: string;
  readonly candidateId: string;
  /** The owner the session proved. Never read from the body (F01-AC1). */
  readonly actor: string;
}

/**
 * Accept, or Request Changes.
 *
 * `expectedHeadSha` and `expectedContractRevision` are required: they are the identity the
 * owner's page was rendered against, and comparing them against the live candidate is what
 * turns an action taken from an outdated card into a `Conflict` rather than a decision
 * about whatever the candidate has become (F24-AC4, F25-AC3). There is no owner field
 * here, so a decision cannot be attributed to anybody but the session that made it.
 */
export interface RecordMvpOwnerDecisionCommand extends ReadMvpReviewCommand {
  readonly decision: ReviewDecisionKind;
  readonly expectedHeadSha: string;
  readonly expectedContractRevision: number;
  readonly feedback: string | null;
}

/**
 * One automated observation, as the transport reads it back (F20-AC3, F24-AC3).
 *
 * The same three-outcome shape the card's evidence rows use, and for the same reason: a client
 * handed only `recordedOutcome` would render a stale pass in green. `recordedOutcome` is what the
 * provider said at the time; `currentOutcome` and `countsForCurrentCandidate` are the answer to
 * "may this be shown as this candidate's result" (F20-AC3).
 */
export interface MvpRecordedObservationView {
  readonly evidenceId: string;
  readonly checkId: string;
  readonly recordedOutcome: ReviewEvidenceOutcome;
  readonly currentOutcome: ReviewEvidenceOutcome | 'stale';
  readonly countsForCurrentCandidate: boolean;
  /** The commit the provider attributed the run to, or null when it attributed nothing. */
  readonly observedHeadSha: string | null;
  readonly observedContractRevision: number | null;
  readonly observedAt: string | null;
  readonly reason: string;
}

/**
 * What one automated verification pass observed, and the card it produced (F20-AC2, F24-AC2).
 *
 * `candidateHeadSha` and `providerHeadSha` are both carried and are allowed to differ, because
 * that difference is the finding: when the pull request has moved on, every check the provider
 * attributed to the newer commit lands unbound and proves nothing about the candidate under
 * review (F20-AC3, F24-AC4).
 *
 * `method` is the single literal `github_checks`, so a client cannot be handed a report whose
 * source it cannot name (F20-AC2).
 */
export interface MvpVerificationReportView {
  readonly projectId: string;
  readonly candidateId: string;
  readonly candidateHeadSha: string;
  readonly providerHeadSha: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly method: 'github_checks';
  readonly observedAt: string;
  readonly recorded: readonly MvpRecordedObservationView[];
  readonly review: MvpReviewCardView;
}

/**
 * What the owner recorded, and the card it produced (F23-AC1, F25-AC4).
 *
 * `candidateHeadSha` is the commit the observation is bound to, reported so a client can see which
 * build the owner's "passed" applies to rather than inferring it (F24-AC4, F25-AC3).
 */
export interface MvpOwnerTestReportView {
  readonly projectId: string;
  readonly candidateId: string;
  readonly candidateHeadSha: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly criterionId: string;
  readonly outcome: 'passed' | 'failed';
  readonly evidenceId: string;
  readonly observedAt: string;
  readonly note: string | null;
  readonly review: MvpReviewCardView;
}

/**
 * Record the provider's check results for a candidate.
 *
 * `correlationId` is the only member about the call rather than about the candidate. There is
 * deliberately **no result, no outcome, no check id and no commit SHA**: the server derives every
 * one of them, so this port cannot be expressed as "the browser reports that criterion X passed"
 * even by accident. A method added with such a member is the defect this shape prevents (F20-AC2,
 * F23-AC1).
 */
export interface RecordMvpVerificationCommand {
  readonly projectId: string;
  readonly candidateId: string;
  /** The owner the session proved. Never read from the body (F01-AC1). */
  readonly actor: string;
  readonly correlationId: string;
}

/**
 * Record the owner's own test of one criterion (F23-AC1, F25-AC4).
 *
 * `outcome` is the one member a caller supplies a verdict through, and it is present because the
 * owner's test is an observation rather than a measurement: there is no provider to read it from.
 * The owner is the proved session rather than a body field, the instant is the controller's clock,
 * and there is no commit SHA or verification type here - so a request cannot attribute the
 * observation to somebody else, backdate it, or discharge an automated criterion (F01-AC1, F25-AC4).
 */
export interface RecordMvpOwnerTestCommand {
  readonly projectId: string;
  readonly candidateId: string;
  readonly actor: string;
  readonly criterionId: string;
  readonly outcome: 'passed' | 'failed';
  readonly note: string | null;
}

/**
 * The MVP review card, the owner's decision, and the two evidence paths (F20, F23, F24, F25).
 *
 * Four methods and nothing else: this group has no `merge`, no `deploy` and no provider write, so
 * "ShipLoop v0.1 ends at Accepted or Changes Requested" is a property of the type rather than of a
 * reviewer's memory. All four answer the whole card, so a write returns the state it produced
 * rather than leaving the client to re-read and disagree with itself (F24-AC2).
 *
 * The two evidence methods are separate rather than one `recordEvidence` with a flag, because
 * automated evidence and owner evidence are separate facts with separate rules: one is derived by
 * the server from a provider read, the other is the owner's own report and only the owner may file
 * it (F20-AC2, F23-AC1, F25-AC4).
 */
export interface MvpReviewUseCases {
  getReview(command: ReadMvpReviewCommand): Promise<Result<MvpReviewCardView, DomainError>>;
  decide(command: RecordMvpOwnerDecisionCommand): Promise<Result<MvpReviewCardView, DomainError>>;
  recordVerification(command: RecordMvpVerificationCommand): Promise<Result<MvpVerificationReportView, DomainError>>;
  recordOwnerTest(command: RecordMvpOwnerTestCommand): Promise<Result<MvpOwnerTestReportView, DomainError>>;
}

/** The whole injected surface. One argument, so a missing use case is a type error. */
export interface ControllerSurface {
  readonly owners: OwnerUseCases;
  readonly projects: ProjectUseCases;
  readonly contracts: ContractUseCases;
  readonly handoff: HandoffUseCases;
  /**
   * The two durable reads the Home board composes from.
   *
   * Typed here as the Home route's own `HomeEvidenceSources` rather than a second declaration, so
   * the transport and the controller must agree on the shape or this file will not compile. The
   * member is declared rather than discovered for the reason the candidate port now is: a group a
   * transport looks for at runtime is a group that can be missing, and this one was — Home
   * answered 503 on every deployment until it was carried (F11-AC1, F02-AC4).
   */
  readonly home: HomeEvidenceSources;
  /**
   * The review card and the owner's decision (F24, F25).
   *
   * Declared on the surface rather than resolved optionally: a review card and a decision
   * are the last step of the MVP journey, and a group a route has to discover at runtime
   * is the same invisibility that left generation implemented and unreachable (L02-AC2).
   */
  readonly mvpReview: MvpReviewUseCases;
  readonly sessions: SessionUseCases;
  readonly profiles: ProfileUseCases;
  readonly connectors: ConnectorUseCases;
  readonly settings: SettingsUseCases;
  readonly intake: IntakeUseCases;
  readonly runs: RunUseCases;
  readonly attention: AttentionUseCases;
  readonly reviewCards: ReviewCardUseCases;
  readonly acceptance: AcceptanceUseCases;
  readonly ownerTests: OwnerTestUseCases;
  readonly planning: PlanningUseCases;
  readonly generation: GenerationUseCases;
}

const REQUIRED_METHODS = {
  owners: ['provision', 'signIn', 'describe', 'selectActiveProject'],
  projects: ['listProjects', 'createProject'],
  contracts: [
    'createRequest',
    'getRequest',
    'listRequests',
    'updateRequest',
    'draftContract',
    'getContract',
    'listContractRevisions',
    'listContractCriteria',
    'editContract',
    'approveRevision',
    'reviseContract',
    'invalidateRevision',
  ],
  handoff: ['buildHandoff'],
  // The review card and the owner decision, for the same reason `settings` is declared:
  // an MVP whose journey ends at Accept or Request Changes needs both methods reachable
  // from a shipped path (F24, F25).
  // The review card, the owner decision, and the two evidence paths. All four are declared for
  // the same reason: a criterion that can never leave `unverified` or `pending` because no shipped
  // path records an observation is the exact failure this guard exists to prevent (F20-AC2,
  // F23-AC1, F25-AC2).
  mvpReview: ['getReview', 'decide', 'recordVerification', 'recordOwnerTest'],
  sessions: ['loadByToken', 'create', 'revoke', 'touch'],
  profiles: ['saveVersion', 'currentVersion', 'listVersions'],
  connectors: ['register', 'listForProject', 'revoke'],
  // The settings group is declared on the surface rather than left optional: without it the
  // optional T3 launch target would be unreachable from any shipped path, which is the state
  // generation was in when it was implemented and never wired (L02-AC2).
  settings: ['readSettings', 'updateSettings'],
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
  ownerTests: ['recordOwnerObservation', 'listOwnerObservations'],
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
  home: ['recordedCandidate', 'reviewReadModel'],
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
