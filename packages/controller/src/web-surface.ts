/**
 * The controller as the HTTP layer sees it (F01-AC1, F02-AC1, F03-AC1).
 *
 * `apps/web` composes its controller from a module specifier and checks the loaded
 * value against the ports it declares, so something has to actually answer that
 * shape. Before this module existed, `@shiploop/controller` exported its own use
 * cases under their own names and the web server refused to start with a named
 * error. Neither side was wrong on its own and each was tested against its own
 * doubles, which is how a seam that had never been crossed stayed green.
 *
 * This is an adapter and nothing else. Every method below delegates to a use case
 * that already exists in `profiles.ts`, `sessions.ts` or `connectors.ts`; no rule,
 * no validation and no refusal is restated here. Three things happen at this
 * boundary because they belong to it and to no use case:
 *
 *   - renaming. The controller speaks of `tokenHash`, `lastSeenAt` and two-argument
 *     calls; the transport speaks of `tokenDigest`, `lastActivityAt` and one
 *     command object. Two vocabularies for one row are fine as long as exactly one
 *     translation exists, and this file is it.
 *   - promisification. Most use cases are synchronous because their storage is a
 *     single local writer; the port is asynchronous because the port is not
 *     storage, and one of them is asynchronous because it writes an attachment
 *     file. Wrapping rather than rewriting keeps the use cases testable without a
 *     promise in sight.
 *   - the owner actor. `saveProfile` and the connector use cases demand an actor
 *     and judge its role. Writes carry the owner the transport proved; reads carry
 *     no caller at all in the port, so the adapter resolves the single provisioned
 *     owner through `resolveOwnerActor`, which refuses when there is none. No actor
 *     is ever invented.
 *
 * One port field is worth naming rather than hiding. `at` on a write command is the
 * transport's instant, while the controller records writes with its injected clock;
 * in a single process those are the same clock read moments apart, and keeping one
 * time source in the use cases is worth more than millisecond agreement
 * (mvp-spec 7). Sessions are deliberately not left to that: a session's `issuedAt`
 * is the instant its stored deadline is computed from, so there the caller's value
 * is what gets written.
 *
 * The shapes below are declared here rather than imported from the web package,
 * because `apps/web` depends on `@shiploop/controller` and a controller that
 * imports its own consumer's types is a cycle. `web-surface.test.ts` therefore
 * assigns a real surface to the web package's `ControllerSurface`: the port stays
 * the authority, and this file is what has to satisfy it.
 */

import {
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  capabilitiesFor,
  err,
  fingerprint,
  invalid,
  isBlocking,
  isCommitSha,
  ok,
  orderedAreas,
  planReadiness,
  publishableTickets,
  redact,
} from '@shiploop/domain';
import type {
  AttentionBucket,
  AttentionItem,
  AttentionItemId,
  AttentionKind,
  AttentionState,
  AreaObservation,
  AttemptLimits,
  AttemptState,
  CapabilityKind,
  CandidateId,
  ChangeShape,
  ChangeSurface,
  CheckResult,
  CommitSha,
  ConnectorId,
  ContractId,
  DomainError,
  Fingerprint,
  IdeaId,
  JobId,
  OperationId,
  OwnerId,
  Plan,
  PlanEdit,
  PlanProposal,
  PlanTaskContentField,
  PlanTaskPatch,
  ProfileVersionId,
  ProjectId,
  PublishableTicket,
  PullRequestState,
  ReadinessObservation,
  Request,
  RequestId,
  Result,
  ScopeSnapshot,
  WorkItemId,
} from '@shiploop/domain';
import type {
  AttentionItemRecord,
  CandidateRecord,
  ConnectorKind,
  ConnectorRecord,
  ConnectorState,
  ProjectRecord,
  IdeaExport,
  JobCheckpoint,
  JobLimits,
  JobMode,
  JobOperation,
  JobRecord,
  JobQuery,
} from '@shiploop/storage';
import type { GitRepositoryRef, TicketState } from '@shiploop/adapters';
import { createGitTransport } from '@shiploop/adapters';
import { DeliveryCandidateRepository, SqliteMvpReviewStore } from '@shiploop/storage';
import type { CandidateLinkStore } from '@shiploop/storage';
import type {
  CandidateBinding,
  CandidateCheckStatus,
  DeliveryCandidate,
  MvpReviewReadModel,
} from '@shiploop/domain';
import type {
  CandidateLinkUseCases,
  CandidateView,
  LinkedCandidate,
  LiveCandidateFacts,
} from './candidate-linking.ts';
import type { CompositionRoot, GenerationRunView, GenerationWorkspaceReader } from './composition.ts';
import { createCompositionRoot, taskWorkItemId } from './composition.ts';
import type { IdeaDraft } from '@shiploop/domain';
import type { ControllerClock, OwnerActor } from './profiles.ts';
import type { StoredSessionRecord } from './sessions.ts';
import { createProviderRegistry, readProviderConfiguration } from './providers.ts';
import type { ProjectSettingsView } from './settings.ts';
import type { AttentionBoard } from './attention.ts';
import type {
  CancelledRun,
  DeclinedExtension,
  GrantedExtension,
  JobUseCases,
  PausedRun,
  ResumedRun,
  RunView,
  RunWriter,
} from './jobs.ts';
import type { ReviewCard } from './verification.ts';
import type {
  MvpOwnerTestReport,
  MvpRecordedObservationReport,
  MvpReviewCard,
  MvpVerificationReport,
} from './mvp-review-card.ts';
import { readFacts } from './mvp-review-card.ts';
import { toDeliveryCandidate } from './candidate-linking.ts';
import type { MvpReviewCardDeps } from './mvp-review-card.ts';
import type { OwnerObservationRecord, OwnerObservationTarget, OwnerObservationUseCases } from './owner-tests.ts';
import { SqliteOwnerObservationJournal, createOwnerObservationUseCases } from './owner-tests.ts';
import { SqliteObservationJournal } from './verification.ts';
import { PLAN_TASK_CONTENT_FIELDS } from '@shiploop/domain';
import { blocked } from '@shiploop/domain';
import type { ReconciliationOutcome, TicketPublication, TicketToPublish } from './publication.ts';
import type { ContractContentInput, ContractView, RequestDetailView } from './contracts.ts';
import type { ImplementationHandoff } from './handoff/handoff.ts';
import { buildImplementationHandoff } from './handoff/handoff.ts';
import { T3_URL_ENV_VAR } from './handoff/t3-launch.ts';
import type {
  BriefSectionsInput,
  BriefView,
  BriefVersionView,
  CapturedIdeaView,
  ClarificationRoundView,
  ClarifyingQuestionView,
  CorrectionView,
  IntakeDetailView,
  RejectedCandidateView,
  RelatedWorkChoiceView,
  RelatedWorkView,
} from './intake.ts';

/** The connector kinds the transport names. Storage names the same four. */
export type SurfaceConnectorKind = ConnectorKind;

export type SurfaceConnectorState = ConnectorState;

export interface SurfaceStoredSession {
  readonly sessionId: string;
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastActivityAt: string | null;
}

/**
 * The project the owner is acting in, or the state they are in when none is selected
 * (F02-AC1, F02-AC2).
 *
 * A discriminated union rather than a nullable pair of fields, and that is the whole point.
 * The defect this closes is a session response that carried no project identity at all, so
 * the client reached for one it did not have and every project-scoped request went to a path
 * spelled `/api/profiles/undefined`; the server's honest 404 was then reported as "that
 * project has no saved profile yet", which is a different and wrong claim (F02-AC4).
 *
 * Two consequences of the union, both of which a nullable pair could not give:
 *
 *   - **`NoProjectSelected` is a real state with a count in it**, so an owner who has not
 *     chosen yet is told what to do next rather than shown a blank field. No placeholder
 *     project and no fabricated id appears anywhere: the only way to hold an
 *     `activeProjectId` is to hold a `Selected` variant that names a project this store has.
 *   - **The transport cannot pick the wrong variant.** Rendering `activeProjectName` from a
 *     `NoProjectSelected` is unrepresentable rather than a bug someone has to remember to
 *     avoid.
 */
export type SurfaceActiveProject =
  | {
      readonly state: 'Selected';
      readonly activeProjectId: string;
      readonly activeProjectName: string;
    }
  | {
      readonly state: 'NoProjectSelected';
      /** How many projects the owner could choose from, so onboarding can say "choose one". */
      readonly selectableProjectCount: number;
    };

export interface SurfaceOwner {
  readonly ownerId: OwnerId;
  readonly displayName: string;
  /**
   * The sign-in address, or null when the owner row carries none (F01-AC1).
   *
   * Read from the owner row rather than re-derived from the display name. The transport
   * showed a blank address beside the name and its only remedy would have been to
   * reconstruct the same slug rule this module owns, which is how two derivations of one
   * rule drift and an owner is shown an address that is not theirs (F01-AC1).
   */
  readonly email: string | null;
  readonly createdAt: string;
  /**
   * Which project this session is acting in (F02-AC1).
   *
   * Part of the owner read rather than a separate call, because a client that has to make a
   * second request to learn which project it is addressing has a window in which it
   * addresses the previous one - and the previous one is what produced the defect this
   * field exists to close.
   */
  readonly activeProject: SurfaceActiveProject;
}

/**
 * One project as the owner selects it (F02-AC1).
 *
 * The identity and the name travel together: the selector needs both, and rendering the
 * identity where a name belongs would make the owner choose a string (F02-AC1).
 */
export interface SurfaceProject {
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/**
 * Project listing and creation (F02-AC1).
 *
 * Creation is the only project write that needs no configured provider. Every other write
 * that creates the row behind the owner's back — a profile save, a connector registration,
 * a procedure append — is refused by name when no adapter declares the capability it needs
 * (F03-AC2), so without this an owner who configured nothing had no project to select and
 * every project-scoped screen addressed nothing at all.
 */
export interface SurfaceProjectUseCases {
  listProjects(): Promise<Result<readonly SurfaceProject[], DomainError>>;
  createProject(command: {
    readonly projectId: string;
    readonly name: string;
    readonly at: string;
  }): Promise<Result<SurfaceProject, DomainError>>;
}

export interface SurfaceSessionGrant {
  readonly session: SurfaceStoredSession;
}

export interface SurfacePreviewComponent {
  readonly component: string;
  readonly environment: string;
}

export interface SurfaceProfileReferences {
  readonly repository: string;
  readonly ticketProvider: string;
  readonly ticketTeamKey: string | null;
  readonly baseBranch: string;
  readonly targetBranch: string;
  readonly deploymentProvider: string;
  readonly engine: string;
  readonly previewComponents: readonly SurfacePreviewComponent[];
}

export interface SurfaceProfilePolicy {
  readonly requiredChecks: readonly string[];
  readonly deliveryBehavior: 'ManualAuthorizationOnly';
  readonly maxFixPasses: number;
  readonly workspaceIsolation: 'WorktreeAndDataDirectory';
  readonly capabilityVersion: number;
}

export interface SurfaceProfileEnvironment {
  readonly runtime: string;
  readonly ports: readonly number[];
  readonly secretReferences: readonly string[];
}

export interface SurfaceProfileContent {
  readonly references: SurfaceProfileReferences;
  readonly policy: SurfaceProfilePolicy;
  readonly recipe: string;
  readonly environment: SurfaceProfileEnvironment;
}

export interface SurfaceProfileVersion {
  readonly profileVersionId: ProfileVersionId;
  readonly projectId: ProjectId;
  readonly versionNumber: number;
  readonly supersedesVersionId: ProfileVersionId | null;
  readonly content: SurfaceProfileContent;
  readonly contentFingerprint: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface SurfaceConnector {
  readonly connectorId: ConnectorId;
  readonly projectId: ProjectId;
  readonly provider: string;
  readonly kind: SurfaceConnectorKind;
  readonly resourceScope: string;
  readonly credentialReference: string;
  readonly credentialReferenceDigest: string;
  readonly state: SurfaceConnectorState;
  readonly error: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly reads: readonly CapabilityKind[];
  readonly writes: readonly CapabilityKind[];
  readonly unsupported: readonly { readonly kind: CapabilityKind; readonly limitation: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SurfaceOwnerUseCases {
  provision(command: {
    readonly displayName: string;
    readonly password: string;
    readonly at: string;
  }): Promise<Result<SurfaceOwner, DomainError>>;
  /**
   * The identity this owner signs in with, read from the owner row (F01-AC1).
   *
   * A read rather than a field on `signIn`, because every request that re-establishes a
   * session needs the address, not only the one that created it, and the transport's only
   * alternative was to reconstruct the address from the display name — a second copy of the
   * rule this module owns, which drifts and then shows the owner an address that is not
   * theirs (F01-AC1).
   */
  describe(command: { readonly ownerId: OwnerId }): Promise<Result<SurfaceOwner, DomainError>>;
  /**
   * Chooses which project every subsequent project-scoped call addresses (F02-AC1).
   *
   * A server-side write rather than a client-side value, for the reason above: a selection
   * the client holds is a selection a re-established session does not have. `projectId: null`
   * is refused rather than accepted, because "no project selected" is reached by never
   * selecting one - the onboarding state - and a client that wanted to express it can simply
   * not select.
   */
  selectActiveProject(command: {
    readonly ownerId: OwnerId;
    readonly projectId: string;
    readonly at: string;
  }): Promise<Result<SurfaceActiveProject, DomainError>>;
  signIn(command: {
    readonly identifier: string;
    readonly password: string;
    readonly tokenDigest: string;
    readonly issuedAt: string;
    readonly absoluteTtlSeconds: number;
    readonly idleTimeoutSeconds: number;
  }): Promise<Result<SurfaceSessionGrant, DomainError>>;
}

export interface SurfaceSessionUseCases {
  loadByToken(token: string): Promise<Result<SurfaceStoredSession, DomainError>>;
  create(command: {
    readonly ownerId: OwnerId;
    readonly displayName: string;
    readonly tokenDigest: string;
    readonly issuedAt: string;
    readonly absoluteTtlSeconds: number;
    readonly idleTimeoutSeconds: number;
  }): Promise<Result<SurfaceStoredSession, DomainError>>;
  revoke(command: {
    readonly sessionId: string;
    readonly revokedAt: string;
  }): Promise<Result<SurfaceStoredSession, DomainError>>;
  touch(command: { readonly sessionId: string; readonly lastActivityAt: string }): Promise<Result<null, DomainError>>;
}

export interface SurfaceProfileUseCases {
  saveVersion(command: {
    readonly projectId: ProjectId;
    readonly content: SurfaceProfileContent;
    readonly note: string | null;
    readonly expectedVersionNumber: number | null;
    readonly at: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceProfileVersion, DomainError>>;
  currentVersion(projectId: ProjectId): Promise<Result<SurfaceProfileVersion | null, DomainError>>;
  listVersions(projectId: ProjectId): Promise<Result<readonly SurfaceProfileVersion[], DomainError>>;
}

export interface SurfaceConnectorUseCases {
  register(command: {
    readonly projectId: ProjectId;
    readonly provider: string;
    readonly kind: SurfaceConnectorKind;
    readonly resourceScope: string;
    readonly credentialReference: string;
    readonly at: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceConnector, DomainError>>;
  listForProject(projectId: ProjectId): Promise<Result<readonly SurfaceConnector[], DomainError>>;
  revoke(command: {
    readonly connectorId: ConnectorId;
    readonly at: string;
    readonly reason: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceConnector, DomainError>>;
}

/**
 * Project settings as this adapter projects them (mvp-spec 3, L02-AC2, L02-AC3).
 *
 * Structurally the controller's own `ProjectSettingsView`, renamed only where the transport
 * speaks in strings. The projection is a copy of an immutable value rather than a second
 * place a rule could live: the launch-URL rules, the ownership gate and the credential
 * omission all happen in `settings.ts`, and this file only translates the result (F03-AC3).
 */
export interface SurfaceT3LaunchSetting {
  readonly configured: boolean;
  readonly url: string | null;
}

export interface SurfaceRepositorySetting {
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
 * One configured provider, without its credential reference (F03-AC3, F32-AC2).
 *
 * The contrast with `SurfaceConnector` is deliberate and load-bearing: that view carries the
 * reference because the connector route is where an owner registered it, and this one cannot,
 * because a settings response is read by a page that has no business holding a pointer into
 * the credential store.
 */
export interface SurfaceProviderSetting {
  readonly connectorId: ConnectorId;
  readonly kind: SurfaceConnectorKind;
  readonly provider: string;
  readonly resourceScope: string;
  readonly credentialReferenceDigest: string;
  readonly state: SurfaceConnectorState;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
}

export interface SurfaceProjectSettings {
  readonly projectId: string;
  readonly t3: SurfaceT3LaunchSetting;
  readonly repository: SurfaceRepositorySetting;
  readonly providers: readonly SurfaceProviderSetting[];
  readonly updatedAt: string | null;
}

export interface SurfaceSettingsUseCases {
  readSettings(command: {
    readonly projectId: ProjectId;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceProjectSettings, DomainError>>;
  updateSettings(command: {
    readonly projectId: ProjectId;
    readonly t3Url?: string | null;
    readonly at: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceProjectSettings, DomainError>>;
}


/**
 * One captured request as the transport names it (F06-AC1, F06-AC3, F06-AC5).
 *
 * The controller's own view nests the request inside an `IdeaDraft` and keeps the bug
 * detail inside a discriminated union. The transport names the same facts flat, with
 * the kind and the three optional bug fields as siblings, so this file is where that
 * one translation lives rather than in each of the fifteen intake routes.
 */
export interface SurfaceIntakeIdea {
  readonly ideaId: IdeaId;
  readonly rawRequest: string;
  readonly projectId: string | null;
  readonly notes: string | null;
  readonly kind: 'FeatureRequest' | 'Bug';
  readonly bugDetail: {
    readonly expected: string | null;
    readonly actual: string | null;
    readonly reproduction: string | null;
  };
  readonly attachments: readonly { readonly name: string; readonly mediaType: string; readonly byteSize: number; readonly addedAt: string }[];
  readonly summary: {
    readonly text: string;
    readonly generatedAt: string;
    readonly generatedBy: string;
    readonly rawRequestFingerprint: string;
  } | null;
  readonly disposition: 'Unpublished' | 'Published' | 'Deferred' | 'Archived';
  readonly dispositionDetail: string | null;
  readonly capturedAt: string;
}

export interface SurfaceRelatednessReport {
  readonly candidateIdeaId: IdeaId;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly mergeable: false;
  readonly discardable: false;
  readonly disposition: 'OwnerChoiceRequired';
  readonly ownerChoices: readonly ('LinkToExisting' | 'ExtendExisting' | 'CreateNewIssue')[];
}

export interface SurfaceIntakeDetail {
  readonly idea: SurfaceIntakeIdea;
  readonly brief: {
    readonly briefId: string | null;
    readonly currentVersion: number | null;
    readonly current: BriefVersionView | null;
    readonly versions: readonly BriefVersionView[];
  };
  readonly questions: readonly ClarifyingQuestionView[];
  readonly rejected: readonly RejectedCandidateView[];
  readonly turns: readonly {
    readonly kind: 'RawRequest' | 'Question' | 'Answer' | 'Correction';
    readonly at: string;
    readonly text: string;
    readonly reference: string | null;
  }[];
}

/**
 * The intake port the transport loads.
 *
 * Every command carries `actor` on a write and nothing on a read, following the same
 * rule as the other groups: the transport has proven who is asking, and reads carry
 * no caller so a read cannot be authorized by a request body (F01-AC1). The view
 * types are the controller's own, because this file's job is translating vocabulary
 * and not restating shapes.
 */
export interface SurfaceIntakeUseCases {
  captureIdea(command: {
    readonly rawRequest: string;
    readonly kind: 'FeatureRequest' | 'Bug';
    readonly projectId: string | null;
    readonly notes: string | null;
    readonly detail: { readonly expected: string | null; readonly actual: string | null; readonly reproduction: string | null } | null;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceIntakeIdea, DomainError>>;
  listIdeas(): Promise<Result<readonly SurfaceIntakeIdea[], DomainError>>;
  getIdea(ideaId: IdeaId): Promise<Result<SurfaceIntakeDetail, DomainError>>;
  attachFile(command: {
    readonly ideaId: IdeaId;
    readonly name: string;
    readonly mediaType: string;
    readonly content: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceIntakeIdea, DomainError>>;
  recordSummary(command: {
    readonly ideaId: IdeaId;
    readonly text: string;
    readonly generatedBy: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceIntakeIdea, DomainError>>;
  archiveIdea(command: {
    readonly ideaId: IdeaId;
    readonly reason: string | null;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceIntakeIdea, DomainError>>;
  deferIdea(command: {
    readonly ideaId: IdeaId;
    readonly reason: string | null;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceIntakeIdea, DomainError>>;
  findRelatedWork(ideaId: IdeaId): Promise<Result<readonly SurfaceRelatednessReport[], DomainError>>;
  recordRelatedWorkChoice(command: {
    readonly ideaId: IdeaId;
    readonly candidateIdeaId: IdeaId;
    readonly choice: string;
    readonly actor: OwnerId;
  }): Promise<Result<RelatedWorkChoiceView, DomainError>>;
  draftBrief(command: {
    readonly ideaId: IdeaId;
    readonly authoredBy: 'Owner' | 'ClarificationModel' | 'OwnerEdit';
    readonly sections: BriefSectionsInput;
    readonly basedOnBriefVersion: number | null;
    readonly actor: OwnerId;
  }): Promise<Result<BriefVersionView, DomainError>>;
  agreeBrief(command: { readonly ideaId: IdeaId; readonly actor: OwnerId }): Promise<Result<BriefVersionView, DomainError>>;
  askClarifyingQuestions(command: {
    readonly ideaId: IdeaId;
    readonly sections: BriefSectionsInput;
    readonly ambiguities: readonly {
      readonly kind: 'UnspecifiedSubject' | 'ConflictingStatement' | 'MissingAcceptanceThreshold' | 'UnstatedScopeBoundary' | 'UnresolvedDependency';
      readonly topic: string;
      readonly readings: readonly string[];
      readonly answeredBy: readonly string[];
      readonly impact: 'ChangesBehaviour' | 'ChangesAcceptance' | 'Cosmetic';
      readonly evidence: string;
    }[];
    readonly actor: OwnerId;
  }): Promise<Result<ClarificationRoundView, DomainError>>;
  answerClarifyingQuestion(command: {
    readonly ideaId: IdeaId;
    readonly questionId: string;
    readonly answer: string;
    readonly actor: OwnerId;
  }): Promise<Result<ClarifyingQuestionView, DomainError>>;
  applyOwnerCorrection(command: {
    readonly ideaId: IdeaId;
    readonly text: string;
    readonly sections: BriefSectionsInput;
    readonly basedOnBriefVersion: number;
    readonly actor: OwnerId;
  }): Promise<Result<CorrectionView, DomainError>>;
  exportIdea(ideaId: IdeaId): Promise<Result<IdeaExport, DomainError>>;
}

/* -------------------------------------------------------------------------- */
/* Runs, the attention dashboard and the review card                            */
/* -------------------------------------------------------------------------- */

/**
 * One area of the recorded readiness assessment, as the transport collects it (F09-AC1).
 *
 * A confirmation rather than a free-form observation, because the only thing this process
 * can know about a prerequisite is whether the owner said they had checked it: the
 * judgement of what that means is the domain's, and it is made from the assembled
 * observation rather than from anything this shape decides (F09-AC4).
 */
export interface SurfaceReadinessAreaInput {
  readonly confirmed: boolean;
  /** What the owner saw. Null means they confirmed it without writing why. */
  readonly note: string | null;
}

/**
 * The scope the run is started against, in the transport's vocabulary (F12-AC1).
 *
 * Linear owns the published scope, so the run records what the provider reported rather
 * than a scope derived from the ticket's own fields. `providerRevision` is the provider's
 * own revision when it supplies one and a content digest otherwise, which is the same
 * distinction the domain's `ScopeSnapshot` draws (F12-AC3).
 */
export interface SurfaceRunScopeInput {
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
 * One durable job row, flattened for the transport (F13-AC1).
 *
 * The limits and the granted operations travel with it because both are facts about this
 * row: an owner reading "running" has no way to ask what the attempt is bounded by, or what
 * it was permitted to do, without the row (F18-AC2, F13-AC3).
 */
export interface SurfaceRunJob {
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
  readonly limits: JobLimits;
  readonly permittedOperations: readonly JobOperation[];
  readonly holder: string | null;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The resume point a paused or interrupted run carries (F17-AC2).
 *
 * Head and base are full commit SHAs and are reported as stored: an abbreviated SHA cannot
 * be compared against a real checkout, so shortening one here would make the comparison
 * the worker performs on resume meaningless (F17-AC2).
 */
export interface SurfaceRunCheckpoint {
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
 * Who holds the coding writer, and whether that ownership can be trusted yet (F17-AC5).
 *
 * `disposition` is the lease's own answer rather than a word this file chose, and
 * `ReconciliationRequired` is deliberately not `Vacant`: an expired lease proves heartbeats
 * stopped, not that the process stopped writing (F17-AC5).
 */
export interface SurfaceRunWriter {
  readonly holder: string | null;
  readonly disposition: 'Vacant' | 'Held' | 'ReconciliationRequired' | 'Unleased';
  readonly expiresAt: string | null;
  readonly reconciliationReason: string | null;
}

export interface SurfaceRunView {
  readonly job: SurfaceRunJob;
  readonly checkpoint: SurfaceRunCheckpoint | null;
  readonly writer: SurfaceRunWriter;
}

/**
 * Where a started run sits with respect to the single global coding writer (F13-AC2).
 *
 * `heldByWriter` names the jobs still holding it, so a client can tell "queued behind a
 * writer" from "waiting for a worker to look" without reading the reason text.
 */
export interface SurfaceRunDispatch {
  readonly state: 'Queued';
  readonly heldByWriter: readonly string[];
  readonly reason: string;
}

/** The capability grant a started run holds, with the delivery refusals named (F13-AC3). */
export interface SurfaceRunGrant {
  readonly mode: JobMode;
  readonly permittedOperations: readonly JobOperation[];
  readonly refusedDeliveryOperations: readonly JobOperation[];
  readonly refusalReason: string;
}

export interface SurfaceCapturedScope {
  readonly scopeSnapshotId: string;
  readonly workItemId: string;
  readonly sequenceNumber: number;
  readonly scopeFingerprint: string;
  readonly capturedAt: string;
}

export interface SurfaceRunStart {
  readonly job: SurfaceRunJob;
  /** True when this operation identity had already started that run (F13-AC2). */
  readonly deduplicated: boolean;
  readonly capturedScope: SurfaceCapturedScope;
  readonly dispatch: SurfaceRunDispatch;
  readonly grant: SurfaceRunGrant;
  readonly requestedByOwner: string;
}

/**
 * A paused run and the evidence its writer stopped (F17-AC1).
 *
 * `writerStopped` is a separate field because a pause is only reported complete once the
 * writer is stopped or safely detached; a run shown as `Paused` while a writer still holds
 * it is a run that may still be writing code.
 */
export interface SurfacePausedRun extends SurfaceRunView {
  readonly writerStopped: boolean;
}

export interface SurfaceResumedRun {
  readonly job: SurfaceRunJob;
  readonly checkpoint: SurfaceRunCheckpoint;
}

export interface SurfaceCancelledRun {
  readonly job: SurfaceRunJob;
  readonly preservedCheckpoint: SurfaceRunCheckpoint | null;
  readonly writer: SurfaceRunWriter;
  /** A one-member value: cancellation cannot reverse a delivery (F17-AC4). */
  readonly externalDelivery: 'UnchangedByCancellation';
}

export interface SurfaceGrantedExtension {
  readonly job: SurfaceRunJob;
  readonly previousLimits: AttemptLimits;
  readonly extendedLimits: AttemptLimits;
  /** False, and typed: no storage port writes an extension onto the job (F18-AC2). */
  readonly extendedBoundRecorded: false;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export interface SurfaceDeclinedExtension {
  readonly job: SurfaceRunJob;
  readonly limitsInForce: AttemptLimits;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

/**
 * Run start, lifecycle and owner limit decisions (F13, F17, F18).
 *
 * Writes carry the owner the transport proved, reads carry no caller, following the same
 * rule as every other group: a read cannot be authorized by a request body (F01-AC1).
 * `listRuns` returns the job rows alone, because a listing has no judgement to add and a
 * per-run checkpoint read would make the list cost grow with the number of runs the owner
 * is least likely to open (F13-AC1, N04-AC2).
 */
export interface SurfaceReadinessInput {
  readonly scope: SurfaceReadinessAreaInput;
  readonly criteria: SurfaceReadinessAreaInput;
  readonly repository: SurfaceReadinessAreaInput;
  readonly target: SurfaceReadinessAreaInput;
  readonly verification: SurfaceReadinessAreaInput;
  readonly access: SurfaceReadinessAreaInput;
}

export interface SurfaceRunUseCases {
  startRun(command: {
    readonly workItemId: string;
    readonly mode: JobMode;
    readonly operationId: string;
    readonly correlationId: string | null;
    readonly scope: SurfaceRunScopeInput;
    readonly readiness: SurfaceReadinessInput;
    readonly at: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceRunStart, DomainError>>;
  listRuns(): Promise<Result<readonly SurfaceRunJob[], DomainError>>;
  getRun(jobId: JobId): Promise<Result<SurfaceRunView, DomainError>>;
  pauseRun(jobId: JobId): Promise<Result<SurfacePausedRun, DomainError>>;
  resumeRun(jobId: JobId): Promise<Result<SurfaceResumedRun, DomainError>>;
  cancelRun(jobId: JobId): Promise<Result<SurfaceCancelledRun, DomainError>>;
  grantExtension(command: {
    readonly jobId: JobId;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceGrantedExtension, DomainError>>;
  declineExtension(command: {
    readonly jobId: JobId;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceDeclinedExtension, DomainError>>;
}

/** One attention item as the transport carries it (F31-AC1, F31-AC4). */
export interface SurfaceAttentionItem {
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
 * The board, with every group the dashboard renders (F31-AC1, F31-AC2).
 *
 * `projectId` is null when this owner has no recorded work at all, which is a different
 * fact from a project whose board is empty and is reported as such rather than as a
 * refusal. `collectedAt` travels with every read so a client can show how stale the view
 * is and notice that it has stopped moving (N04-AC2).
 */
export interface SurfaceAttentionBoard {
  readonly projectId: string | null;
  readonly collectedAt: string;
  readonly items: readonly SurfaceAttentionItem[];
  readonly groups: readonly {
    readonly bucket: AttentionBucket;
    readonly items: readonly SurfaceAttentionItem[];
  }[];
  /** The identities an acknowledgement can be recorded against (F31-AC3). */
  readonly persistedItemIds: readonly string[];
}

export interface SurfaceAttentionUseCases {
  /**
   * Derives the open items and persists them.
   *
   * A null `projectId` means "the project this owner's recorded work belongs to", resolved
   * from the queue's own ordering rather than from a constant, because the transport has no
   * project selector in this slice and a hard-coded project would make the board's scope a
   * guess that looks like a fact. A deployment running several projects names the project
   * explicitly (F31-AC2).
   */
  collectAttention(command: {
    readonly projectId: string | null;
    /** The transport's instant, so an empty board can say when it was collected (N04-AC2). */
    readonly at: string;
  }): Promise<Result<SurfaceAttentionBoard, DomainError>>;
  acknowledge(command: {
    readonly attentionItemId: AttentionItemId;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceAttentionItem, DomainError>>;
}

/** The review card as the owner reads it (F24-AC2, F24-AC3). */
export interface SurfaceReviewCard {
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
     * Both are null when nothing verified the criterion. An automated criterion whose
     * `verificationCheckId` is null has not been verified by anything this card can name, and
     * the card says so in `notReady` rather than letting the checks above it stand in
     * (F23-AC1, F24-AC3).
     */
    readonly verificationCheckId: string | null;
    readonly verificationEvidenceId: string | null;
    /** What verified it, in words; null when nothing has. */
    readonly verificationDetail: string | null;
  }[];
  readonly pendingOwnerTestCriterionIds: readonly string[];
  readonly readyForOwnerTest: boolean;
  /** Why the work cannot be accepted yet, named rather than left to be inferred (F24-AC3). */
  readonly notReady: readonly string[];
}

export interface SurfaceReviewCardUseCases {
  /**
   * The card for the candidate the run's work item currently offers.
   *
   * A run with no candidate yet is `NotFound` rather than an empty card: there is nothing
   * to review, and an empty card would read as a candidate that passed nothing it was
   * asked about (F24-AC3).
   */
  buildReviewCard(jobId: JobId): Promise<Result<SurfaceReviewCard, DomainError>>;
}

/** One criterion's standing as the owner sees it before deciding (F25-AC1). */
export interface SurfaceCriterionStanding {
  readonly criterionId: string;
  readonly text: string;
  readonly methodKind: string;
  readonly status: string;
  /** False when no evidence row exists at all, which differs from a row that failed. */
  readonly observed: boolean;
}

/** The acceptance state the candidate currently holds (F25-AC3). */
export interface SurfaceAcceptanceView {
  readonly candidateId: CandidateId;
  readonly candidateFingerprint: string;
  readonly state: string;
  readonly decisionId: string | null;
  readonly ownerId: OwnerId | null;
  readonly decidedAt: string | null;
  readonly note: string | null;
  /** The identity inputs that differ from the ones the decision was recorded against. */
  readonly staleReasons: readonly string[];
  /** Feedback retained for a fix pass rather than replaced (F25-AC2). */
  readonly retainedFeedback: readonly { readonly decisionId: string; readonly feedback: string }[];
}

/** What an accepted candidate was accepted against (F25-AC1). */
export interface SurfaceAcceptanceReport {
  readonly candidateId: CandidateId;
  readonly workItemId: string;
  readonly decisionId: string;
  readonly state: 'Accepted';
  readonly ownerId: OwnerId;
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

/** What the owner's rejection landed on, so a fix pass can read it (F25-AC2). */
export interface SurfaceChangeRequestReport {
  readonly candidateId: CandidateId;
  readonly workItemId: string;
  readonly decisionId: string;
  readonly state: 'ChangesRequested';
  readonly ownerId: OwnerId;
  readonly decidedAt: string;
  readonly feedback: string;
  readonly outstandingCriterionIds: readonly string[];
}

/** The gate the owner decides against, and what is still outstanding (F25-AC1). */
export interface SurfaceAcceptanceGate {
  readonly candidateFingerprint: string;
  readonly headSha: string;
  readonly scopeFingerprint: string;
  readonly criteria: readonly SurfaceCriterionStanding[];
  readonly outstandingCriterionIds: readonly string[];
  readonly ready: boolean;
}

export interface SurfaceAcceptanceUseCases {
  /** F25-AC2, F25-AC4: records the owner's reason against the tested candidate. */
  requestChanges(command: {
    readonly jobId: JobId;
    readonly reason: string;
    readonly actor: OwnerId;
    /** The transport's instant, so a decision cannot be backdated (F25-AC4). */
    readonly at: string;
  }): Promise<Result<SurfaceChangeRequestReport, DomainError>>;
  /** F25-AC1, F25-AC4: records acceptance, or names the outstanding criteria. */
  recordAcceptance(command: {
    readonly jobId: JobId;
    readonly note: string | null;
    readonly actor: OwnerId;
    readonly at: string;
  }): Promise<Result<SurfaceAcceptanceReport, DomainError>>;
  /** F25-AC3: what the candidate's acceptance state currently is, plus retained feedback. */
  currentAcceptance(jobId: JobId): Promise<Result<SurfaceAcceptanceView, DomainError>>;
  /** F24-AC3, F25-AC1: the criteria and the outstanding ones, for the owner's decision. */
  acceptanceGate(jobId: JobId): Promise<Result<SurfaceAcceptanceGate, DomainError>>;
}

/**
 * The deployment an observation was made against, or the owner's statement that none applies
 * (F23-AC3, F23-AC4).
 *
 * Translated rather than widened: the controller's own union is already the transport's shape,
 * so this port adds no third possibility that the layer below could express.
 */
export type SurfaceOwnerObservationTarget =
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

/** The kinds of retained reference an observation may point at (F23-AC2). */
export type SurfaceOwnerEvidenceKind = 'Screenshot' | 'ApiExchange' | 'CheckOutput';

/**
 * One recorded owner observation, as the transport reads it (F23-AC5, F25-AC1).
 *
 * `failureKind` travels as its own field rather than being left inside the detail prose, so
 * the transport can tell a behaviour failure from a capture failure without parsing a
 * sentence, and a failed owner test can never be rendered as a failed automated check
 * (F23-AC5).
 */
export interface SurfaceOwnerObservation {
  readonly evidenceId: string;
  readonly criterionId: string;
  readonly methodKind: 'OwnerTest';
  readonly status: string;
  readonly failureKind: 'BehaviorFailure' | 'CaptureFailure' | null;
  /** The authenticated owner, which the transport proved and never reads from a body (F25-AC4). */
  readonly observedBy: string;
  readonly observedAt: string;
  readonly environment: string;
  readonly component: string | null;
  readonly deploymentId: string | null;
  readonly evidenceKind: SurfaceOwnerEvidenceKind;
  readonly evidenceRef: string;
  readonly detail: string | null;
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly scopeFingerprint: string;
  readonly correlationId: string;
}

/**
 * Manual owner test recording (F23-AC1, F23-AC5, F24-AC4, F25-AC1, F25-AC4).
 *
 * Keyed by run, like the acceptance group: the transport names what the owner clicked and the
 * candidate is resolved here, so a request cannot record an observation against a candidate the
 * run does not offer (F25-AC3). `expectedCandidateFingerprint` is required and separate, because
 * comparing it against the resolved candidate is what turns an action taken from an outdated
 * card into a typed `Conflict` instead of a write against whatever is current now (F24-AC4).
 *
 * The command carries no instant: the observation is stamped by the controller's clock, so a
 * client cannot backdate a record or re-attribute it (F23-AC3, F25-AC4).
 */
export interface SurfaceOwnerTestUseCases {
  recordOwnerObservation(command: {
    readonly jobId: JobId;
    readonly criterionId: string;
    readonly expectedCandidateFingerprint: string;
    readonly observation: 'BehaviorConfirmed' | 'BehaviorFailed' | 'CaptureFailed';
    readonly observedAgainst: SurfaceOwnerObservationTarget;
    readonly evidence: { readonly kind: SurfaceOwnerEvidenceKind; readonly reference: string };
    readonly note: string | null;
    readonly actor: OwnerId;
  }): Promise<Result<{ readonly observation: SurfaceOwnerObservation; readonly recordedForDelivery: false; readonly outstandingCriterionIds: readonly string[] }, DomainError>>;
  listOwnerObservations(query: {
    readonly jobId: JobId;
    readonly candidateFingerprint: string;
  }): Promise<Result<readonly SurfaceOwnerObservation[], DomainError>>;
}

/* -------------------------------------------------------------------------- */
/* Plans, readiness, publication and adoption                                 */
/* -------------------------------------------------------------------------- */

/** One proposed task's plan content, with the acceptance that makes it publishable (F08-AC3). */
export interface SurfacePlanTask {
  readonly taskId: string;
  readonly outcome: string;
  readonly scope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly verificationMethod: string;
  readonly dependencies: readonly string[];
  readonly relevantProjectContext: readonly string[];
  /**
   * A proposal, never an inspected fact: the transport carries `kind` through
   * unchanged so a client cannot render a suggestion as certainty (F08-AC5).
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
  /**
   * Whether this task has a publishable form.
   *
   * Derived from `publishableTickets` rather than restated, so the flag is true exactly
   * when the domain would hand this task to publication and false otherwise. An
   * unaccepted task reporting true would be a client able to offer to publish work
   * the owner never agreed to (F08-AC3).
   */
  readonly publishable: boolean;
}

/** Why the plan holds the number of tasks it holds (F08-AC2). */
export interface SurfacePlanSplit {
  readonly split: boolean;
  readonly reason: string;
  readonly justifications: readonly ('IndependentlyReviewable' | 'RealDependency')[];
  readonly surfacesWithoutOwnBehaviour: readonly string[];
}

/** One readiness area as the owner reads it, with the reason it stands where it does (F09-AC1). */
export interface SurfaceReadinessArea {
  readonly area: string;
  readonly status: 'Satisfied' | 'Unmet' | 'Unknown';
  readonly reason: string;
  readonly remedy: string | null;
}

/**
 * The recorded readiness assessment (F09-AC1, F09-AC2).
 *
 * `mayStartBuild` and `buildBlockingAreas` travel together because they are two
 * readings of one decision: a client that showed only the boolean would let "you may
 * start" and "nothing is blocking" disagree (F09-AC2). `mayStartInvestigation` is
 * separate, because being unable to build is precisely when read-only investigation is
 * what F09-AC2 says is still allowed.
 */
export interface SurfaceReadinessAssessment {
  readonly subjectId: string;
  readonly assessedAt: string;
  readonly verdict: 'Ready' | 'NeedsInformation' | 'Blocked';
  readonly mayStartBuild: boolean;
  readonly mayStartInvestigation: boolean;
  readonly buildBlockingAreas: readonly string[];
  readonly areas: readonly SurfaceReadinessArea[];
  readonly reasons: readonly { readonly area: string; readonly status: string; readonly reason: string }[];
}

/**
 * A plan as the owner reviews it (F08-AC1, F08-AC2, F08-AC4, F08-AC5).
 *
 * Every field F08-AC1 names is present on each task and none can be invented: the
 * content list is the domain's `PLAN_TASK_CONTENT_FIELDS`, and this type names exactly
 * those. `split` carries the reason the plan has the task count it has, and `coverage`
 * records how every requested outcome is accounted for, so neither is a thing the
 * client has to trust.
 */
export interface SurfacePlan {
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
  readonly split: SurfacePlanSplit;
  readonly tasks: readonly SurfacePlanTask[];
  /**
   * The order the owner agreed, excluding removed proposals (F08-AC3).
   *
   * Separate from `proposedOrder` because they answer different questions: this is the
   * sequence the owner chose, which a reorder changes, and `proposedOrder` is what the
   * dependencies permit, which a reorder cannot change. Conflating them would mean the
   * owner's reorder appeared to be ignored whenever the dependency order disagreed.
   */
  readonly agreedSequence: readonly string[];
  /** Prerequisites first; empty for a plan whose dependencies cannot be ordered (F08-AC4). */
  readonly proposedOrder: readonly string[];
  /** Which tasks cannot be declared ready, and what blocks them (F08-AC4). */
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
  /** The work item an accepted task publishes as (F10-AC3). */
  readonly workItemIdByTaskId: Readonly<Record<string, string>>;
}

/** What one proposed ticket's publication did, reported per ticket (F10-AC2). */
export interface SurfaceTicketPublication {
  readonly workItemId: string;
  readonly taskId: string | null;
  readonly kind: 'Published' | 'Failed' | 'OutcomeUnknown';
  readonly issueId: string | null;
  readonly identifier: string | null;
  readonly url: string | null;
  readonly disposition: 'CreatedNew' | 'AlreadyPresent' | 'AdoptedExisting' | null;
  /** Links the provider refused, so a partial publication does not read as complete (F10-AC2). */
  readonly unlinked: readonly { readonly target: string; readonly reason: string }[];
  readonly detail: string;
}

/**
 * One publication request's whole outcome (F10-AC2, F10-AC3).
 *
 * `unpublished` is the answer F10-AC2 asks for and is carried explicitly: a client
 * that inferred it from `published` would have to re-derive the same partition, and
 * one that forgot to would present a partial failure as a success.
 */
export interface SurfacePublicationReport {
  readonly requestId: string;
  readonly planId: string;
  readonly tickets: readonly SurfaceTicketPublication[];
  readonly published: readonly string[];
  readonly unpublished: readonly string[];
  /** True when this request was reconciled rather than written again (F10-AC3). */
  readonly reconciled: boolean;
}

/** An adopted issue's live content, read rather than re-created (F11-AC1). */
export interface SurfaceAdoptedIssue {
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
export interface SurfaceLinkedChange {
  readonly workItemId: string;
  readonly repository: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly pullRequestId: string | null;
}

/** A recorded request to Test or Review an adopted candidate (F11-AC5). */
export interface SurfaceAdoptedEvaluationRequest {
  readonly workItemId: string;
  readonly mode: 'Test' | 'Review';
  readonly dedupKey: string;
  readonly created: boolean;
  /** Always false: requesting a review launches no job and rewrites no issue (F11-AC5). */
  readonly jobEnqueued: false;
}

export interface SurfacePlanningUseCases {
  draftPlan(command: {
    readonly ideaId: string;
    readonly planId: string;
    readonly change: unknown;
    readonly proposal: unknown;
    /** Carried so the write is attributable to the owner the transport proved (F01-AC1). */
    readonly actor: OwnerId;
  }): Promise<Result<SurfacePlan, DomainError>>;
  getPlan(planId: string): Promise<Result<SurfacePlan, DomainError>>;
  editPlan(command: {
    readonly planId: string;
    readonly edit: unknown;
    readonly actor: OwnerId;
  }): Promise<Result<SurfacePlan, DomainError>>;
  listPlansForIdea(ideaId: string): Promise<Result<readonly SurfacePlan[], DomainError>>;
  assessPlan(planId: string): Promise<Result<SurfaceReadinessAssessment, DomainError>>;
  publishPlan(command: {
    readonly planId: string;
    readonly requestId: string;
    readonly correlationId: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfacePublicationReport, DomainError>>;
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
  }): Promise<Result<SurfaceAdoptedIssue, DomainError>>;
  linkExistingChange(command: {
    readonly workItemId: string;
    readonly repository: unknown;
    readonly branch: string;
    readonly baseBranch: string;
    readonly expectedHeadSha: string | null;
    readonly pullRequestId: string | null;
    readonly correlationId: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceLinkedChange, DomainError>>;
  requestAdoptedEvaluation(command: {
    readonly workItemId: string;
    readonly candidateId: string | null;
    readonly candidateFingerprint: string | null;
    readonly mode: 'Test' | 'Review' | 'Build';
    readonly correlationId: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceAdoptedEvaluationRequest, DomainError>>;
}

/**
 * One generation run as the transport carries it (F07-AC1, F08-AC1, N04-AC3).
 *
 * The whole point of this group is that the answer is a tracked identity rather than a wait:
 * `state` travels with the run so a client can show where it is, and the result and the refusal
 * travel as data so the client never has to infer either from the absence of one. The capability
 * profile is carried whole because "what could this pass do" is part of what the owner is shown
 * (F07-AC5).
 */
export interface SurfaceGenerationRun {
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
 * A start is the only write and it returns the tracked identity immediately: the run itself
 * happens after the request has been answered, so an owner action never holds a connection open
 * for a model turn. Reads carry no caller because a read cannot be authorized by a request body
 * (F01-AC1).
 */
export interface SurfaceGenerationUseCases {
  startBriefGeneration(command: {
    readonly ideaId: IdeaId;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceGenerationRun, DomainError>>;
  startPlanGeneration(command: {
    readonly ideaId: IdeaId;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceGenerationRun, DomainError>>;
  getGeneration(generationId: string): Promise<Result<SurfaceGenerationRun, DomainError>>;
  listGenerations(ideaId: IdeaId): Promise<Result<readonly SurfaceGenerationRun[], DomainError>>;
}

/** One request as the transport reports it (mvp-spec 3). */
export interface SurfaceRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly sourceIdeaId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One acceptance criterion of one contract revision, as the transport reports it. */
export interface SurfaceContractCriterion {
  readonly id: string;
  readonly description: string;
  readonly verificationType: 'automated' | 'owner_test';
  /**
   * The check that verifies an automated criterion, or null when none is bound.
   *
   * Required rather than optional in both directions. A read always carries it; a write is
   * normalised at the transport boundary, which turns an omitted binding into this explicit
   * `null` before it arrives. Nothing downstream then has to ask whether the key was absent,
   * and `null` is reported rather than inferred from whichever check is green (F23-AC1,
   * F24-AC3).
   */
  readonly verificationCheckId: string | null;
}

/**
 * One contract revision as the transport reports it (mvp-spec 3).
 *
 * `approvedBy` and `approvedAt` travel as a nullable pair rather than being nested in a
 * status variant, because a revision's *history* is what a reader needs: an invalidated
 * approval keeps its approver (it is history, not a deletion) while `status` says it is no
 * longer current, and a caller that has to reconstruct that from a variant would have to
 * re-derive the whole lifecycle to answer "who agreed to this".
 *
 * `answersCurrentRequest` is a report rather than a state. The layer refuses to decide that a
 * request edit invalidates an agreement about that request - that is the owner's call about
 * scope - so it publishes the comparison instead (mvp-spec 3).
 */
export interface SurfaceContract {
  readonly contractId: string;
  readonly revision: number;
  readonly projectId: string;
  readonly requestId: string;
  readonly status: 'draft' | 'approved' | 'stale';
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly SurfaceContractCriterion[];
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
export interface SurfaceRequestDetail {
  readonly request: SurfaceRequest;
  readonly latestRevision: SurfaceContract | null;
  readonly approvedRevision: SurfaceContract | null;
  readonly revisions: readonly SurfaceContract[];
}

/** The reasons an approval may be retired, as the transport names them (mvp-spec 3). */
export const SURFACE_CONTRACT_STALE_REASONS = [
  'RequestChanged',
  'SurroundingContextChanged',
  'WithdrawnByOwner',
] as const;
export type SurfaceContractStaleReason = (typeof SURFACE_CONTRACT_STALE_REASONS)[number];

/**
 * The owner's request and the agreement that answers it (mvp-spec 3).
 *
 * Every command carries `actor` and no `ownerId`, following the rule every other write in
 * this file follows: the caller is proved, so the identity it acts as is not something a
 * request body gets to choose. `approveRevision` in particular takes no approver parameter at
 * all - the approver is read from the session - so a body cannot record an approval
 * attributed to somebody else (mvp-spec 3).
 *
 * Project isolation is by command, not by convention: every method takes the project and the
 * controller refuses a row that does not belong to it, so a request id from another project is
 * a `NotFound` rather than a read of this one's data (F02-AC2).
 */
export interface SurfaceContractUseCases {
  createRequest(command: {
    readonly projectId: string;
    readonly title: string;
    readonly description: string;
    readonly actor: string;
  }): Promise<Result<SurfaceRequest, DomainError>>;
  getRequest(command: {
    readonly projectId: string;
    readonly requestId: string;
    readonly actor: string;
  }): Promise<Result<SurfaceRequestDetail, DomainError>>;
  listRequests(command: {
    readonly projectId: string;
    readonly actor: string;
  }): Promise<Result<readonly SurfaceRequest[], DomainError>>;
  updateRequest(command: {
    readonly projectId: string;
    readonly requestId: string;
    readonly title?: string;
    readonly description?: string;
    readonly expectedUpdatedAt: string;
    readonly actor: string;
  }): Promise<Result<SurfaceRequest, DomainError>>;
  draftContract(command: {
    readonly projectId: string;
    readonly requestId: string;
    readonly outcome: string;
    readonly scope: readonly string[];
    readonly outOfScope: readonly string[];
    readonly acceptanceCriteria: readonly SurfaceContractCriterion[];
    readonly actor: string;
  }): Promise<Result<SurfaceContract, DomainError>>;
  getContract(command: {
    readonly projectId: string;
    readonly contractId: string;
    readonly revision: number;
    readonly actor: string;
  }): Promise<Result<SurfaceContract, DomainError>>;
  listContractRevisions(command: {
    readonly projectId: string;
    readonly requestId: string;
    readonly actor: string;
  }): Promise<Result<readonly SurfaceContract[], DomainError>>;
  listContractCriteria(command: {
    readonly projectId: string;
    readonly contractId: string;
    readonly revision: number;
    readonly actor: string;
  }): Promise<Result<readonly SurfaceContractCriterion[], DomainError>>;
  editContract(command: {
    readonly projectId: string;
    readonly contractId: string;
    readonly revision: number;
    readonly outcome: string;
    readonly scope: readonly string[];
    readonly outOfScope: readonly string[];
    readonly acceptanceCriteria: readonly SurfaceContractCriterion[];
    /**
     * The `contentFingerprint` of the revision as the owner read it, sent back by the
     * client, and required. An edit writes over text, so it names that text the way an
     * approval does - the instant cannot, because two writes can share a millisecond
     * (mvp-spec 3, mvp-spec 7).
     */
    readonly expectedContentFingerprint: string;
    readonly actor: string;
  }): Promise<Result<SurfaceContract, DomainError>>;
  approveRevision(command: {
    readonly projectId: string;
    readonly contractId: string;
    readonly revision: number;
    /**
     * The `contentFingerprint` of the revision as the owner read it, sent back by the
     * client. Required, and checked against the stored text rather than trusted: an
     * approval that could not name its text would seal the agreement over whatever a
     * second tab had written since the page was rendered (mvp-spec 3, mvp-spec 7).
     */
    readonly expectedContentFingerprint: string;
    readonly actor: string;
  }): Promise<Result<SurfaceContract, DomainError>>;
  reviseContract(command: {
    readonly projectId: string;
    readonly contractId: string;
    readonly revision: number;
    readonly outcome: string;
    readonly scope: readonly string[];
    readonly outOfScope: readonly string[];
    readonly acceptanceCriteria: readonly SurfaceContractCriterion[];
    readonly actor: string;
  }): Promise<Result<SurfaceContract, DomainError>>;
  invalidateRevision(command: {
    readonly projectId: string;
    readonly contractId: string;
    readonly revision: number;
    readonly reason: SurfaceContractStaleReason;
    readonly actor: string;
  }): Promise<Result<SurfaceContract, DomainError>>;
}

/** The packet, exactly as the generator rendered it (mvp-spec L02-AC3). */
export interface SurfaceHandoffPacket {
  /**
   * The document, byte for byte.
   *
   * The transport neither reformats nor reflows it: the value of a packet is that the same
   * approved contract produces the same bytes in every environment it is pasted into, and a
   * response that tidied the text would make two of them differ for no stated reason.
   */
  readonly markdown: string;
  /** The digest of those bytes, so two packets can be compared without diffing them. */
  readonly fingerprint: string;
}

/**
 * Where the browser may open the external executor, if anywhere (mvp-spec L02).
 *
 * Three states rather than a nullable URL: nothing configured is the normal state of a
 * deployment that does not use T3, and a configured value that is refused is a third thing
 * that is neither. None of them ever reproduces the configured value (N02-AC2).
 */
export type SurfaceHandoffT3 =
  | { readonly state: 'Configured'; readonly url: string }
  | {
      readonly state: 'NotConfigured';
      readonly reason: string;
      readonly prerequisites: readonly SurfaceBlockedPrerequisite[];
    }
  | {
      readonly state: 'Unusable';
      readonly reason: string;
      readonly prerequisites: readonly SurfaceBlockedPrerequisite[];
    };

/** A missing prerequisite, with the remedy the owner can act on (F04-AC3). */
export interface SurfaceBlockedPrerequisite {
  readonly name: string;
  readonly detail: string;
  readonly remedy: string;
}

/**
 * One approved revision, rendered into the text an implementer outside ShipLoop receives.
 *
 * The controller owns this text. A client that assembled packet content itself would own the
 * redaction guarantee instead, and a token pasted into a criterion description would travel
 * from a clipboard to a thread with nothing in between stopping it (N02-AC2).
 */
export interface SurfaceHandoff {
  readonly contractId: string;
  readonly revision: number;
  readonly packet: SurfaceHandoffPacket;
  readonly t3: SurfaceHandoffT3;
}

/**
 * The external-execution handoff (mvp-spec L02).
 *
 * One method, and the command carries the actor because this read is project-scoped: the
 * revision belongs to a project, and the project belongs to an owner who has to be proved
 * before the row is read at all (F01-AC1, F02-AC2).
 */
export interface SurfaceHandoffUseCases {
  buildHandoff(command: {
    readonly projectId: string;
    readonly contractId: string;
    readonly revision: number;
    readonly actor: string;
  }): Promise<Result<SurfaceHandoff, DomainError>>;
}

/**
 * The review card, as the transport receives it.
 *
 * An alias rather than a third transcription: `apps/web/src/server/contracts.ts` declares
 * `MvpReviewCardView` because the web server loads this package as external input and
 * nothing in the compiler ties the two declarations together. Here the type is the
 * controller's own, so the surface cannot answer with a card that differs from the one the
 * use case computed. The wire-shape agreement the transport needs is asserted by
 * `web-surface.test.ts` against both declarations, in the same way as the review-card
 * criterion fields above it (F24-AC2, F24-AC3).
 */
export type SurfaceMvpReviewCard = MvpReviewCard;

/**
 * One automated observation, as the transport receives it.
 *
 * Aliases rather than a third transcription, for the reason `SurfaceMvpReviewCard` is: the card and
 * the report have to agree field for field or a client can be handed a row whose two outcomes
 * disagree about staleness. `web-surface.test.ts` asserts that agreement against both
 * declarations (F20-AC3, F24-AC3).
 */
export type SurfaceMvpRecordedObservation = MvpRecordedObservationReport;
export type SurfaceMvpVerificationReport = MvpVerificationReport;
export type SurfaceMvpOwnerTestReport = MvpOwnerTestReport;

/**
 * The MVP review card and the owner's Accept / Request Changes decision (F24, F25).
 *
 * Two methods, and no `merge`, `deploy` or provider write: the MVP ends at the owner
 * decision, so this group is a read plus one owner-gated write. `actor` is the identity the
 * transport proved, converted to the domain's actor union below, so a caller cannot name
 * the owner a decision is attributed to (F01-AC1, F25-AC4).
 */
export interface SurfaceMvpReviewUseCases {
  getReview(command: {
    readonly projectId: string;
    readonly candidateId: string;
    readonly actor: string;
  }): Promise<Result<SurfaceMvpReviewCard, DomainError>>;
  decide(command: {
    readonly projectId: string;
    readonly candidateId: string;
    readonly actor: string;
    readonly decision: 'accepted' | 'changes_requested';
    readonly expectedHeadSha: string;
    readonly expectedContractRevision: number;
    readonly feedback: string | null;
  }): Promise<Result<SurfaceMvpReviewCard, DomainError>>;
  /**
   * Records the provider's check results for a candidate.
   *
   * `correlationId` is the only member about the call rather than about the candidate, and there is
   * deliberately **no result, no outcome and no check id**: this adapter derives every verdict from
   * the provider read the controller performs. A command member that carried a result would make
   * "the browser says criterion X passed" expressible at the port, which is the one thing this
   * method must never be (F20-AC2, F23-AC1).
   */
  recordVerification(command: {
    readonly projectId: string;
    readonly candidateId: string;
    readonly actor: string;
    readonly correlationId: string;
  }): Promise<Result<SurfaceMvpVerificationReport, DomainError>>;
  /**
   * Records the owner's own test outcome.
   *
   * Two members from the caller and no more: the criterion and the outcome the owner reports. The
   * owner is the identity the transport proved, and the instant is the controller's clock, so a
   * body can neither attribute the observation to somebody else nor backdate it (F01-AC1, F25-AC4).
   */
  recordOwnerTest(command: {
    readonly projectId: string;
    readonly candidateId: string;
    readonly actor: string;
    readonly criterionId: string;
    readonly outcome: 'passed' | 'failed';
    readonly note: string | null;
  }): Promise<Result<SurfaceMvpOwnerTestReport, DomainError>>;
}

/* -------------------------------------------------------------------------- */
/* The candidate port                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The recorded candidate, as `routes/candidates.ts` reports it.
 *
 * Both SHAs travel at full length, and `pullRequestState` is the domain's own
 * `PullRequestState` rather than free text: the transport narrows the value against
 * `PULL_REQUEST_STATES` before it can reach a response, and this declaration is the same
 * union rather than a second spelling of it (mvp-spec 3, F20-AC2).
 */
export interface SurfaceRecordedCandidateReport {
  readonly candidateId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly provider: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headBranch: string;
  /** The candidate's identity. Never an abbreviation, a branch or a pull request number. */
  readonly headSha: string;
  readonly pullRequestState: PullRequestState;
  readonly draft: boolean;
  readonly observedAt: string;
  readonly linkedAt: string;
}

/** What the provider said during this read, beside the row ShipLoop holds. */
export interface SurfaceLiveCandidateReport {
  readonly provider: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly headSha: string;
  /** A fork's name when the provider reports one; null when it reported none. */
  readonly headRepository: string | null;
  readonly pullRequestState: PullRequestState;
  readonly draft: boolean;
  readonly observedAt: string;
}

/** The `(contract revision, head SHA)` pair every piece of evidence must name (F20-AC3). */
export interface SurfaceCandidateBindingReport {
  readonly contractId: string;
  readonly contractRevision: number;
  readonly headSha: string;
}

/** What this read observed about the difference between the record and the provider. */
export interface SurfaceCandidateChangeReport {
  readonly kind: string;
  readonly changed: readonly string[];
  readonly changedAnything: boolean;
  readonly previousHeadSha: string | null;
  readonly currentHeadSha: string;
  readonly priorEvidenceStale: boolean;
  readonly detail: string;
}

/**
 * Whether evidence recorded against an earlier head still describes this one.
 *
 * `priorReadinessPreserved` is the literal `false` on every value this adapter produces:
 * nothing here holds a stored readiness, so a ready status cannot cross a force push
 * (F24-AC4, F25-AC3). `status` follows the same read's `priorEvidenceStale`, which is the
 * only signal a controller can report about it.
 */
export interface SurfaceEvidenceStandingReport {
  readonly status: 'Current' | 'Stale';
  readonly priorReadinessPreserved: false;
  readonly priorCandidateId: string | null;
  readonly priorHeadSha: string | null;
  readonly detail: string;
}

/**
 * One provider check, with `blocking` computed by the domain's own `isBlocking`.
 *
 * The domain's `CandidateCheckStatus` carries no `blocking` member, and the transport's view
 * declares one. It is filled here with `isBlocking(result, notApplicableApprovedByPolicy)` —
 * the same domain function the transport re-derives it with — rather than with a second
 * opinion about what blocks. The transport overwrites the value on the way out regardless, so
 * the honest thing here is to be right rather than to be silent (F20-AC2, F20-AC5).
 */
export interface SurfaceCandidateCheckReport {
  readonly name: string;
  readonly result: CheckResult;
  readonly required: boolean;
  readonly blocking: boolean;
  readonly notApplicableApprovedByPolicy: boolean;
  readonly observedHeadSha: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly artifactUrl: string | null;
  readonly detail: string | null;
}

/** Whether this candidate can be decided on, with every reason when it cannot (F24-AC3). */
export interface SurfaceCandidateReadinessReport {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

/** What a successful link established. Carries no readiness answer at all. */
export interface SurfaceLinkedCandidateReport {
  readonly candidate: SurfaceRecordedCandidateReport;
  readonly live: SurfaceLiveCandidateReport;
  readonly binding: SurfaceCandidateBindingReport;
  readonly bindingFingerprint: string;
  readonly alreadyRecorded: boolean;
  readonly observedAt: string;
  /** Always false: the port this is built on holds no provider write (mvp-spec F03-AC5). */
  readonly providerWritePerformed: false;
}

/** One candidate as the owner reads it, from one live read (F20-AC3, F24-AC4). */
export interface SurfaceCandidateReport {
  readonly candidate: SurfaceRecordedCandidateReport;
  readonly live: SurfaceLiveCandidateReport;
  readonly binding: SurfaceCandidateBindingReport;
  readonly bindingFingerprint: string;
  readonly change: SurfaceCandidateChangeReport;
  readonly evidence: SurfaceEvidenceStandingReport;
  readonly supersededCandidateIds: readonly string[];
  readonly checks: readonly SurfaceCandidateCheckReport[];
  readonly checksReady: boolean;
  readonly blockingChecks: readonly string[];
  readonly reviewReadiness: SurfaceCandidateReadinessReport;
  readonly observedAt: string;
  /** Always false: nothing on this path merges, closes, approves or re-protects (F03-AC5). */
  readonly providerWritePerformed: false;
}

/**
 * Link the pull request the owner named.
 *
 * The body carries no head SHA, no branch and no pull request number, because identity is read
 * from the provider and is not the caller's to assert: a command that could name one would make
 * "PR 7" recordable as the candidate (mvp-spec 3, SHARED.md "Candidate").
 */
export interface SurfaceLinkCandidateCommand {
  readonly projectId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly pullRequestUrl: string;
  /** The transport always sends null: what the project expects is profile configuration. */
  readonly expectedBaseBranch: string | null;
  readonly correlationId: string;
  /** The owner the session proved. Never read from the body (F01-AC1). */
  readonly actor: OwnerId;
}

/**
 * Read one candidate by its own identity, inside one project.
 *
 * The identity is the **candidate**, and the controller's currency read is keyed by the
 * **request** a candidate belongs to. Resolving one from the other is the adapter's job — see
 * `candidates.readCandidate` below — because a transport that invented a request id would be
 * reading whatever candidate that request happens to hold (F02-AC2, F24-AC4).
 */
export interface SurfaceReadCandidateCommand {
  readonly projectId: string;
  readonly candidateId: string;
  readonly correlationId: string;
  readonly actor: OwnerId;
}

/**
 * The whole candidate port: two reads and one durable write, and no provider write at all.
 *
 * `mergePullRequest`, `closePullRequest`, `approve` and `setBranchProtection` are absent from
 * the type because the use cases underneath hold a `CandidateGitPort`, which has two reads and
 * nothing else to call (mvp-spec F03-AC5).
 */
export interface SurfaceCandidateUseCases {
  linkCandidate(
    command: SurfaceLinkCandidateCommand,
  ): Promise<Result<SurfaceLinkedCandidateReport, DomainError>>;
  readCandidate(command: SurfaceReadCandidateCommand): Promise<Result<SurfaceCandidateReport, DomainError>>;
}

/**
 * The two durable reads the Home board composes from.
 *
 * Both answer from rows ShipLoop already holds. Neither contacts a provider: there is no pull
 * request refresh, no check re-read and no execution of any kind behind them, so opening Home
 * cannot turn a page view into network I/O or into work the owner did not ask for (mvp-spec 3,
 * F20-AC3).
 *
 * The shape matches `HomeEvidenceSources` in `apps/web/src/server/routes/home.ts` structurally.
 * It is declared here rather than imported because the controller cannot depend on the transport;
 * the two agreeing is checked by the transport's own type, which is what makes the wiring a
 * compile-time fact instead of a runtime discovery.
 */
export interface SurfaceHomeReads {
  /** The candidate this request currently holds, or null when none is linked. */
  recordedCandidate(input: {
    readonly projectId: string;
    readonly requestId: string;
  }): Promise<Result<DeliveryCandidate | null, DomainError>>;
  /**
   * The review projection for one candidate, from stored evidence and stored decisions under the
   * project's saved required-check policy.
   *
   * This is the M0-certified read model, reached through the same `readFacts` the review card uses.
   * Home therefore cannot hold a different opinion about evidence freshness, required checks,
   * staleness or eligibility than the card the owner is about to act on (F23-AC1, F24-AC3).
   */
  reviewReadModel(input: {
    readonly projectId: string;
    readonly requestId: string;
    readonly candidateId: string;
  }): Promise<Result<MvpReviewReadModel, DomainError>>;
}

/** The whole injected surface. One argument, so a missing use case is a type error. */
export interface ControllerSurface {
  readonly owners: SurfaceOwnerUseCases;
  readonly projects: SurfaceProjectUseCases;
  readonly contracts: SurfaceContractUseCases;
  readonly handoff: SurfaceHandoffUseCases;
  /**
   * The GitHub candidate port (mvp-spec MVP "GitHub Candidate").
   *
   * Declared on the surface rather than left optional, and that is the whole fix: the routes
   * were registered, the use cases existed on the composition root, and nothing connected them,
   * so every candidate request answered `503` on a deployment that had a git provider
   * configured. A group a route has to discover at runtime is the same invisibility that left
   * generation implemented and unreachable (F11-AC1, F02-AC4).
   *
   * A deployment that composed no git provider still gets a stated refusal — from the adapter,
   * at the operation, with the missing wiring named — rather than a port that is quietly absent.
   */
  readonly candidates: SurfaceCandidateUseCases;
  /**
   * Home's durable reads, always present.
   *
   * Declared rather than discovered, and that is the whole point: Home was registered, its use
   * cases existed on the root, and nothing connected them, so `GET .../home` answered `503` on
   * every deployment — the same invisibility the candidate port had (F11-AC1, F02-AC4). A
   * transport that has to look for a group at runtime is a transport that can be missing one.
   */
  readonly home: SurfaceHomeReads;
  readonly mvpReview: SurfaceMvpReviewUseCases;
  readonly sessions: SurfaceSessionUseCases;
  readonly profiles: SurfaceProfileUseCases;
  readonly connectors: SurfaceConnectorUseCases;
  readonly settings: SurfaceSettingsUseCases;
  readonly intake: SurfaceIntakeUseCases;
  readonly runs: SurfaceRunUseCases;
  readonly attention: SurfaceAttentionUseCases;
  readonly reviewCards: SurfaceReviewCardUseCases;
  readonly acceptance: SurfaceAcceptanceUseCases;
  readonly ownerTests: SurfaceOwnerTestUseCases;
  readonly planning: SurfacePlanningUseCases;
  readonly generation: SurfaceGenerationUseCases;
}

/**
 * Where the surface gets its root.
 *
 * A resolver rather than a root so the one adapter serves both callers: a test or
 * a worker that already has a root hands it in directly, and the module default
 * handed to the transport resolves one from the environment on first use. One
 * implementation, so the two cannot drift.
 */
export type SurfaceRootResolver = () => Result<CompositionRoot, DomainError>;

/** The owner actor every capability-checked use case demands. */
function ownerActor(actorId: OwnerId): OwnerActor {
  return { actorId, role: 'Owner', ownerId: actorId, sessionId: null };
}

/**
 * The address one owner row carries, or null when it carries none.
 *
 * Null rather than a refusal: an owner row without an address is a legitimate row, and the
 * sign-in identifier is matched against the display name as well, so an owner with no
 * address can still sign in. Turning that into an error would refuse a working owner (F01-AC1).
 */
function readOwnerEmail(root: CompositionRoot, ownerId: OwnerId): string | null {
  const credential = root.credentials.findByOwnerId(ownerId);
  if (!credential.ok || credential.value === null) return null;
  const email = credential.value.email.trim();
  return email === '' ? null : email;
}

/** One project row, projected for the transport. */
function toSurfaceProject(record: ProjectRecord): SurfaceProject {
  return {
    projectId: String(record.projectId),
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archivedAt: record.archivedAt,
  };
}

/**
 * How many projects the owner could select, for the onboarding state.
 *
 * Counted rather than described, because "no project selected" is only actionable if the
 * client can say whether to invite a choice or to invite a creation. Archived projects are
 * counted: they are in the list the owner sees, and a selector that quietly dropped them
 * would offer fewer choices than the store holds (F02-AC1).
 */
function noProjectSelected(root: CompositionRoot): SurfaceActiveProject {
  const listed = root.projects.list();
  return {
    state: 'NoProjectSelected',
    selectableProjectCount: listed.ok ? listed.value.length : 0,
  };
}

/**
 * The project this owner has selected, or the onboarding state when none is selected.
 *
 * A store that cannot be read reports the onboarding state rather than an invented
 * selection: the alternative is refusing the whole session read because of a storage
 * problem, which would sign the owner out for a fault they cannot see or fix (F02-AC1).
 */
function readActiveProject(root: CompositionRoot, ownerId: OwnerId): SurfaceActiveProject {
  const selected = root.activeProjects.read(ownerId);
  if (!selected.ok || selected.value === null) return noProjectSelected(root);
  return {
    state: 'Selected',
    activeProjectId: String(selected.value.projectId),
    activeProjectName: selected.value.name,
  };
}

function toSurfaceSession(record: StoredSessionRecord): SurfaceStoredSession {
  return { ...record };
}

/**
 * The actor the transport proved, as the use cases want it.
 *
 * `role: 'Owner'` unconditionally, because this layer is only reachable behind a session
 * guard: the guard is what proves the caller, and a second capability decision here would be a
 * second rule that could disagree with the first. `ownerId` is carried, so a use case that
 * refuses an unattributable caller still refuses one (F01-AC1).
 */
function ownerActorFor(ownerId: string): Result<OwnerActor, DomainError> {
  return ok({ actorId: ownerId, role: 'Owner', ownerId: ownerId as OwnerId, sessionId: null });
}

/**
 * One handoff, projected for the transport.
 *
 * Renaming only: `markdown` and `fingerprint` are carried across unchanged and the T3 union
 * keeps its three variants. A projection that trimmed the document or collapsed two T3
 * states into one boolean would make the response disagree with the generator it claims to
 * serve, and the redaction guarantee would then belong to the adapter rather than to the
 * renderer (N02-AC2).
 */
function toSurfaceHandoff(handoff: ImplementationHandoff): SurfaceHandoff {
  return {
    contractId: handoff.contractId,
    revision: handoff.revision,
    packet: { markdown: handoff.packet.markdown, fingerprint: handoff.packet.fingerprint },
    t3: handoff.t3,
  };
}

/* -------------------------------------------------------------------------- */
/* Candidate projection                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The candidate-linking use cases, or the refusal a deployment without them earns.
 *
 * `Unavailable`, mirroring `recordVerification`'s refusal for a null `readLiveCandidate`: the
 * deployment is missing a capability, so the honest answer names it at the operation rather than
 * throwing or reporting a provider read that never happened (F03-AC2, F20-AC2).
 */
function candidateLinkOf(root: CompositionRoot): Result<CandidateLinkUseCases, DomainError> {
  if (root.candidateLinkUseCases === null) {
    return err({
      code: 'Unavailable',
      reason:
        'This deployment composed no GitHub candidate port, so no candidate can be linked, read or refreshed. Nothing was read from GitHub and nothing was recorded (F03-AC2, F02-AC4).',
    });
  }
  return ok(root.candidateLinkUseCases);
}

/**
 * The delivery-candidate rows, over the handle this root already holds.
 *
 * The same store the composition root hands to `candidateLinkUseCases`, reached here only to
 * resolve a candidate identity to the request its own row names. Read-only in use: `get` is the
 * only member called (F02-AC2).
 */
function deliveryCandidates(root: CompositionRoot): Pick<CandidateLinkStore, 'get'> {
  return new DeliveryCandidateRepository(root.database);
}

/** The recorded candidate, field by field, with both SHAs at full length. */
function toSurfaceRecordedCandidate(candidate: DeliveryCandidate): SurfaceRecordedCandidateReport {
  return {
    candidateId: String(candidate.candidateId),
    projectId: String(candidate.projectId),
    requestId: candidate.requestId,
    contractId: candidate.contractId,
    contractRevision: candidate.contractRevision,
    provider: candidate.provider,
    repository: candidate.repository,
    pullRequestNumber: candidate.pullRequestNumber,
    pullRequestUrl: candidate.pullRequestUrl,
    baseBranch: candidate.baseBranch,
    baseSha: String(candidate.baseSha),
    headBranch: candidate.headBranch,
    headSha: String(candidate.headSha),
    pullRequestState: candidate.pullRequestState,
    draft: candidate.draft,
    observedAt: candidate.observedAt,
    linkedAt: candidate.linkedAt,
  };
}

/** What the provider reported during this read, field by field. */
function toSurfaceLiveCandidate(live: LiveCandidateFacts): SurfaceLiveCandidateReport {
  return {
    provider: live.provider,
    repository: live.repository,
    pullRequestNumber: live.pullRequestNumber,
    pullRequestUrl: live.pullRequestUrl,
    baseBranch: live.baseBranch,
    baseSha: String(live.baseSha),
    headBranch: live.headBranch,
    headSha: String(live.headSha),
    headRepository: live.headRepository,
    pullRequestState: live.pullRequestState,
    draft: live.draft,
    observedAt: live.observedAt,
  };
}

/** The `(contract id, revision, head SHA)` triple, which is the controller's own value. */
function toSurfaceCandidateBinding(binding: CandidateBinding): SurfaceCandidateBindingReport {
  return {
    contractId: binding.contractId,
    contractRevision: binding.contractRevision,
    headSha: String(binding.headSha),
  };
}

/**
 * One provider check, with `blocking` from the domain's own `isBlocking`.
 *
 * The controller's `CandidateCheckStatus` deliberately carries no `blocking` member and the
 * transport's view does, so it is computed here with the same domain function the transport
 * re-derives it with. Deriving it any other way would make this file a second opinion about
 * what blocks, which is the one thing the six-state vocabulary exists to prevent (F20-AC2,
 * F20-AC5).
 */
function toSurfaceCandidateCheck(check: CandidateCheckStatus): SurfaceCandidateCheckReport {
  return {
    name: check.name,
    result: check.result,
    required: check.required,
    blocking: isBlocking(check.result, check.notApplicableApprovedByPolicy),
    notApplicableApprovedByPolicy: check.notApplicableApprovedByPolicy,
    observedHeadSha: check.observedHeadSha === null ? null : String(check.observedHeadSha),
    startedAt: check.startedAt,
    endedAt: check.endedAt,
    artifactUrl: check.artifactUrl,
    detail: check.detail,
  };
}

/**
 * A link, projected. Carries no readiness answer, because the controller's answer carries none.
 */
function toSurfaceLinkedCandidate(linked: LinkedCandidate): SurfaceLinkedCandidateReport {
  return {
    candidate: toSurfaceRecordedCandidate(linked.candidate),
    live: toSurfaceLiveCandidate(linked.live),
    binding: toSurfaceCandidateBinding(linked.binding),
    bindingFingerprint: String(linked.bindingFingerprint),
    alreadyRecorded: linked.alreadyRecorded,
    observedAt: linked.observedAt,
    // The literal is a fact about the port rather than a claim about this call: the use cases
    // underneath hold a `CandidateGitPort`, which exposes two reads and no write to call, so
    // there is no path from here to a merge, a close or a protection change (mvp-spec F03-AC5).
    providerWritePerformed: false,
  };
}

/**
 * One live read, projected for the transport.
 *
 * Every member is the controller's own answer carried across: `checksReady`, `blockingChecks`
 * and `reviewReadiness` were computed inside the read from the provider facts it just read, and
 * re-deriving them here would be the second opinion F24-AC3 refuses. The one thing this adds is
 * the shape of the change and evidence pair, which flattens the view's `priorEvidenceStale` and
 * its `previousCandidateId`/`previousHeadSha` into the three fields the transport renders — the
 * same facts, named as that transport names them (F20-AC3, F24-AC4).
 */
function toSurfaceCandidateRead(view: CandidateView): SurfaceCandidateReport {
  const stale = view.priorEvidenceStale;
  return {
    candidate: toSurfaceRecordedCandidate(view.candidate),
    live: toSurfaceLiveCandidate(view.live),
    binding: toSurfaceCandidateBinding(view.binding),
    bindingFingerprint: String(view.bindingFingerprint),
    change: {
      kind: view.change.kind,
      changed: [...view.change.changed],
      changedAnything: view.change.changedAnything,
      previousHeadSha: view.change.previousHeadSha === null ? null : String(view.change.previousHeadSha),
      currentHeadSha: String(view.change.currentHeadSha),
      priorEvidenceStale: view.change.priorEvidenceStale,
      detail: view.change.detail,
    },
    evidence: {
      status: stale ? 'Stale' : 'Current',
      // The literal is a statement about what this layer holds: it holds no stored readiness, so
      // there is none to preserve across a force push (F24-AC4, F25-AC3).
      priorReadinessPreserved: false,
      priorCandidateId: stale && view.previousCandidateId !== null ? String(view.previousCandidateId) : null,
      priorHeadSha: stale && view.previousHeadSha !== null ? String(view.previousHeadSha) : null,
      // The read's own explanation, verbatim. The transport replaces this with its own wording
      // when nothing moved, so this only ever reaches a reader alongside a moved fact — which is
      // exactly the case the change's detail was written for (F24-AC4).
      detail: view.change.detail,
    },
    supersededCandidateIds: view.supersededCandidates.map((candidateId) => String(candidateId)),
    checks: view.checks.map(toSurfaceCandidateCheck),
    checksReady: view.checksReady,
    blockingChecks: [...view.blockingChecks],
    reviewReadiness: {
      ready: view.reviewReadiness.ready,
      reasons: [...view.reviewReadiness.reasons],
    },
    observedAt: view.observedAt,
    providerWritePerformed: false,
  };
}

/** One request, projected for the transport. */
function toSurfaceRequest(request: Request): SurfaceRequest {
  return {
    requestId: String(request.requestId),
    projectId: String(request.projectId),
    title: request.title,
    description: request.description,
    sourceIdeaId: request.sourceIdeaId,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

/** One contract revision, projected for the transport. */
function toSurfaceContract(contract: ContractView): SurfaceContract {
  return {
    contractId: contract.contractId,
    revision: contract.revision,
    projectId: contract.projectId,
    requestId: contract.requestId,
    status: contract.status,
    outcome: contract.outcome,
    scope: [...contract.scope],
    outOfScope: [...contract.outOfScope],
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    contentFingerprint: contract.contentFingerprint,
    requestFingerprint: contract.requestFingerprint,
    answersCurrentRequest: contract.answersCurrentRequest,
    approvedAt: contract.approvedAt,
    approvedBy: contract.approvedBy,
    staleReason: contract.staleReason,
    supersededByRevision: contract.supersededByRevision,
    sourceBriefId: contract.sourceBriefId,
    sourceBriefVersion: contract.sourceBriefVersion,
    createdBy: contract.createdBy,
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
    blockedBecause: contract.blockedBecause,
  };
}

/** The request detail, projected for the transport. */
function toSurfaceRequestDetail(detail: RequestDetailView): SurfaceRequestDetail {
  return {
    request: toSurfaceRequest(detail.request),
    latestRevision: detail.latestRevision === null ? null : toSurfaceContract(detail.latestRevision),
    approvedRevision: detail.approvedRevision === null ? null : toSurfaceContract(detail.approvedRevision),
    revisions: detail.revisions.map(toSurfaceContract),
  };
}

/**
 * The content a command carries, in the domain's shape.
 *
 * A structural narrowing rather than a cast: the fields a command omits become empty lists and
 * an empty outcome, which `createContractDraft` refuses by name. Handing the domain a value
 * whose type merely *claims* to be `ContractContent` would move that refusal into the
 * controller and duplicate the validation (F02-AC4).
 */
function contractContentOf(command: {
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly SurfaceContractCriterion[];
}): ContractContentInput {
  return {
    outcome: command.outcome,
    scope: command.scope,
    outOfScope: command.outOfScope,
    acceptanceCriteria: command.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      verificationType: criterion.verificationType,
      // Absent stays absent here and becomes an explicit unbound criterion below, which is
      // what the domain's approval gate is written against.
      verificationCheckId: criterion.verificationCheckId ?? null,
    })),
  };
}

/**
 * One job row, renamed for the transport (F13-AC1).
 *
 * A projection rather than a translation: the row's own fields travel, with the branded
 * identities widened to text. Nothing is dropped and nothing is added, so a run the owner
 * reads here is the row the worker claims (F13-AC1, N01-AC3).
 */
function toSurfaceJob(job: JobRecord): SurfaceRunJob {
  return { ...job };
}

/**
 * One resume point, renamed for the transport (F17-AC2).
 *
 * Every field of the recorded point travels, including the dirty and untracked inventory
 * and the retained feedback: the inventory is what a resume compares against, so a card
 * that omitted it would leave the owner unable to see what the next attempt will preserve
 * (F17-AC2).
 */
function toSurfaceCheckpoint(checkpoint: JobCheckpoint): SurfaceRunCheckpoint {
  return { ...checkpoint };
}

function toSurfaceWriter(writer: RunWriter): SurfaceRunWriter {
  return { ...writer };
}

function toSurfaceView(view: RunView): SurfaceRunView {
  return {
    job: toSurfaceJob(view.job),
    checkpoint: view.checkpoint === null ? null : toSurfaceCheckpoint(view.checkpoint),
    writer: toSurfaceWriter(view.writer),
  };
}

/**
 * One readiness area as the transport collected it, judged by nothing (F09-AC4).
 *
 * A confirmed area is `Satisfied` with the reason the owner gave, or with a reason that
 * states exactly what was observed: their confirmation, for this work, at this instant. An
 * unconfirmed area is `Unknown` rather than `Unmet`, because this process has not looked
 * and cannot say the prerequisite is absent, and every one of them carries the remedy that
 * turns it into a fact. The verdict is the domain's `assessReadiness`, so nothing here can
 * turn an open area into a startable one (F09-AC1, F09-AC2).
 */
function toSurfaceArea(area: string, input: SurfaceReadinessAreaInput, subjectId: string, at: string): AreaObservation {
  const note = input.note === null ? '' : input.note.trim();
  if (input.confirmed) {
    return {
      status: 'Satisfied',
      reason: note === '' ? `The owner confirmed the ${area} prerequisite for ${subjectId} at ${at}.` : note,
      remedy: null,
    };
  }
  return {
    status: 'Unknown',
    reason: note === '' ? `The owner has not confirmed the ${area} prerequisite for ${subjectId}.` : note,
    remedy: `Confirm the ${area} prerequisite on the start form, or record what is open about it and start a read-only investigation instead.`,
  };
}

/**
 * The collected confirmations as the domain's observation (F09-AC1).
 *
 * `dependencies` is empty and `investigationSupported` names every area, because this
 * process references no dependency and an owner-confirmed uncertainty is one a read-only
 * investigation may resolve. Both are stated rather than left to a default so the recorded
 * assessment says what it did and did not look at (F09-AC1, F09-AC2).
 */
function toSurfaceReadiness(command: {
  readonly readiness: SurfaceReadinessInput;
  readonly workItemId: string;
  readonly at: string;
}): ReadinessObservation {
  const subject = command.workItemId;
  const at = command.at;
  return {
    subjectId: subject,
    assessedAt: at,
    scope: toSurfaceArea('Scope', command.readiness.scope, subject, at),
    criteria: toSurfaceArea('Criteria', command.readiness.criteria, subject, at),
    repository: toSurfaceArea('Repository', command.readiness.repository, subject, at),
    target: toSurfaceArea('Target', command.readiness.target, subject, at),
    verification: toSurfaceArea('Verification', command.readiness.verification, subject, at),
    access: toSurfaceArea('Access', command.readiness.access, subject, at),
    dependencies: [],
    investigationSupported: ['Scope', 'Criteria', 'Repository', 'Target', 'Dependencies', 'Verification', 'Access'],
  };
}

/** The scope the run records, with the instants the transport is the authority for (F12-AC1). */
function toSurfaceScope(command: {
  readonly scope: SurfaceRunScopeInput;
  readonly workItemId: string;
  readonly at: string;
}): ScopeSnapshot {
  return {
    workItemId: command.workItemId,
    issueId: command.scope.issueId,
    issueIdentifier: command.scope.issueIdentifier,
    title: command.scope.title,
    description: command.scope.description,
    providerRevision: command.scope.providerRevision,
    priority: command.scope.priority,
    dependencyIssueIds: [...command.scope.dependencyIssueIds],
    acceptanceCriteria: command.scope.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    retrievedAt: command.at,
  };
}

/** One attention item, renamed for the transport (F31-AC1, N02-AC2). */
function toSurfaceAttentionItem(item: AttentionItem): SurfaceAttentionItem {
  return {
    attentionItemId: item.attentionItemId,
    kind: item.kind,
    state: item.state,
    projectId: item.projectId,
    workItemId: item.workItemId,
    issueIdentifier: item.issueIdentifier,
    title: item.title,
    blocker: item.blocker,
    nextAction: item.nextAction,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    acknowledgedAt: item.acknowledgedAt,
    acknowledgedBy: item.acknowledgedBy,
    candidateFingerprint: item.candidateFingerprint,
  };
}

function toSurfaceBoard(board: AttentionBoard): SurfaceAttentionBoard {
  return {
    projectId: board.projectId,
    collectedAt: board.collectedAt,
    items: board.items.map(toSurfaceAttentionItem),
    groups: board.groups.map((group) => ({
      bucket: group.bucket,
      items: group.items.map(toSurfaceAttentionItem),
    })),
    persistedItemIds: [...board.persistedItemIds],
  };
}

/**
 * The owner-visible connector projection.
 *
 * The read/write split and the unsupported list come from the domain's own
 * `capabilitiesFor` rather than from a rule written here, so what the owner is told
 * cannot drift from what the domain authorizes (F03-AC2). The record arrives whole
 * because this is the owner's own settings path; every other read in the controller
 * withholds the reference (F03-AC3).
 */
function toSurfaceConnector(record: ConnectorRecord): SurfaceConnector {
  const capabilities = capabilitiesFor(record.declarations);
  return {
    connectorId: record.connectorId,
    projectId: record.projectId,
    provider: record.provider,
    kind: record.kind,
    resourceScope: record.resourceScope,
    credentialReference: record.credentialReference,
    credentialReferenceDigest: record.credentialReferenceDigest,
    state: record.state,
    error: record.error,
    lastCheckedAt: record.lastCheckedAt,
    lastSuccessAt: record.lastSuccessAt,
    reads: capabilities.reads,
    writes: capabilities.writes,
    unsupported: capabilities.unsupported,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toSurfaceProfile(version: {
  readonly profileVersionId: ProfileVersionId;
  readonly projectId: ProjectId;
  readonly versionNumber: number;
  readonly supersedesVersionId: ProfileVersionId | null;
  readonly content: SurfaceProfileContent;
  readonly contentFingerprint: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}): SurfaceProfileVersion {
  return { ...version };
}

/**
 * The settings view, projected for the transport (L02-AC2, F03-AC3).
 *
 * A copy of an immutable value: the controller has already validated the URL, dropped the
 * credential references and gated the project, so there is nothing left to decide here. The
 * identifiers keep their branded types rather than being widened to strings, which is what
 * lets this surface satisfy the transport's declared port without a cast - the same reason
 * `SurfaceProfileVersion` carries a `ProfileVersionId`.
 */
function toSurfaceSettings(view: ProjectSettingsView): SurfaceProjectSettings {
  return {
    projectId: view.projectId,
    t3: { ...view.t3 },
    repository: { ...view.repository },
    providers: view.providers.map((provider) => ({ ...provider })),
    updatedAt: view.updatedAt,
  };
}

/**
 * One draft as the transport's flat view of it (F06-AC1, F06-AC3).
 *
 * The kind and the bug detail are read out of the domain's discriminated union here
 * and nowhere else, so the routes never have to know that "a feature request with
 * reproduction steps" is not a shape the product recognises.
 */
function toSurfaceIdea(view: CapturedIdeaView): SurfaceIntakeIdea {
  const idea: IdeaDraft = view.idea;
  const request = idea.request;
  const disposition = idea.disposition;
  return {
    ideaId: idea.ideaId,
    rawRequest: idea.rawRequest,
    projectId: idea.projectId,
    notes: idea.notes,
    kind: request.kind,
    bugDetail:
      request.kind === 'Bug'
        ? {
            expected: request.detail.expected,
            actual: request.detail.actual,
            reproduction: request.detail.reproduction,
          }
        : { expected: null, actual: null, reproduction: null },
    attachments: [...view.attachments],
    summary:
      view.summary === null
        ? null
        : {
            text: view.summary.text,
            generatedAt: view.summary.generatedAt,
            generatedBy: view.summary.generatedBy,
            rawRequestFingerprint: view.summary.rawRequestFingerprint,
          },
    disposition: disposition.state,
    dispositionDetail:
      disposition.state === 'Archived'
        ? (disposition.reason ?? 'archived without a stated reason')
        : disposition.state === 'Deferred'
          ? (disposition.reason ?? 'deferred without a stated reason')
          : disposition.state === 'Published'
            ? `${disposition.workItemIds.length} work item(s), ${disposition.codingRunIds.length} coding run(s)`
            : null,
    capturedAt: idea.capturedAt,
  };
}

/**
 * One resemblance report, keyed by the candidate's identity (F06-AC4).
 *
 * The report is reported whole, including the literal `false` flags and the single
 * `OwnerChoiceRequired` disposition, because dropping them here is exactly how a
 * client would come to read a high score as permission to merge.
 */
function toSurfaceRelatedness(entries: readonly RelatedWorkView[]): SurfaceRelatednessReport[] {
  return entries.map((entry) => ({
    candidateIdeaId: entry.candidate.idea.ideaId,
    score: entry.report.score,
    reasons: [...entry.report.reasons],
    mergeable: entry.report.mergeable,
    discardable: entry.report.discardable,
    disposition: entry.report.disposition,
    ownerChoices: [...entry.report.ownerChoices],
  }));
}

/**
 * Everything one captured request consists of, in the transport's vocabulary.
 *
 * The brief and the questions are carried whole: this file renames vocabularies and
 * flattens the one idea view, and it does not reshape facts the owner reads.
 */
function toSurfaceDetail(detail: IntakeDetailView): SurfaceIntakeDetail {
  const brief: BriefView = detail.brief;
  return {
    idea: toSurfaceIdea({ idea: detail.idea, summary: detail.idea.summary, attachments: detail.idea.attachments, disposition: detail.idea.disposition.state }),
    brief: {
      briefId: brief.briefId,
      currentVersion: brief.currentVersion,
      current: brief.current,
      versions: brief.versions,
    },
    questions: detail.questions,
    rejected: detail.rejected,
    turns: detail.turns,
  };
}

/**
 * Reads the plan into the transport's vocabulary, adding nothing and dropping nothing.
 *
 * `publishable` is the one derived value, and it is derived from `publishableTickets`
 * rather than from `acceptance.state` restated here, so the flag is true exactly when
 * the domain would hand the task to publication (F08-AC3). `workItemIdByTaskId` uses
 * the same derivation the store used when the plan was drafted, which is what makes a
 * repeat of a publication request address the same operation (F10-AC3).
 *
 * The coverage records carry `via` and then either a task or a reason, so a reader
 * cannot be shown a coverage entry that names neither (F08-AC5).
 */
function toSurfacePlan(root: CompositionRoot, plan: Plan): SurfacePlan {
  const publishable = new Set(publishableTickets(plan).map((ticket) => ticket.taskId));
  const readiness = planReadiness(plan);
  const trail = root.plans.read(plan.planId);

  return {
    planId: plan.planId,
    ideaId: trail.ok && trail.value !== null ? trail.value.ideaId : plan.briefId,
    briefId: plan.briefId,
    revision: plan.revision,
    draftedAt: plan.draftedAt,
    lastEditedAt: plan.lastEditedAt,
    lastEditedBy: plan.lastEditedBy,
    requestedOutcomes: plan.requestedOutcomes.map((outcome) => ({ id: outcome.id, statement: outcome.statement })),
    exclusions: plan.exclusions.map((exclusion) => ({
      outcomeId: exclusion.outcomeId,
      excluded: exclusion.excluded,
      reason: exclusion.reason,
    })),
    coverage: plan.coverage.map((entry) =>
      entry.via === 'Task'
        ? { outcomeId: entry.outcomeId, via: 'Task' as const, taskId: entry.taskId }
        : { outcomeId: entry.outcomeId, via: 'Exclusion' as const, reason: entry.reason },
    ),
    split: {
      split: plan.split.split,
      reason: plan.split.reason,
      justifications: plan.split.split ? [...plan.split.justifications] : [],
      surfacesWithoutOwnBehaviour: plan.split.split ? [...plan.split.surfacesWithoutOwnBehaviour] : [],
    },
    tasks: plan.tasks.map((task) => ({
      taskId: task.taskId,
      outcome: task.outcome,
      scope: task.scope,
      acceptanceCriteria: [...task.acceptanceCriteria],
      verificationMethod: task.verificationMethod,
      dependencies: [...task.dependencies],
      relevantProjectContext: [...task.relevantProjectContext],
      implementationLocation: {
        kind: task.implementationLocation.kind,
        candidates: [...task.implementationLocation.candidates],
        basis: task.implementationLocation.basis,
      },
      acceptance: task.acceptance.state,
      acceptedBy: task.acceptance.state === 'Accepted' ? task.acceptance.acceptedBy : null,
      acceptedAt: task.acceptance.state === 'Accepted' ? task.acceptance.acceptedAt : null,
      removedBy: task.acceptance.state === 'Removed' ? task.acceptance.removedBy : null,
      removedAt: task.acceptance.state === 'Removed' ? task.acceptance.removedAt : null,
      publishable: publishable.has(task.taskId),
    })),
    agreedSequence: plan.tasks.filter((task) => task.acceptance.state !== 'Removed').map((task) => task.taskId),
    proposedOrder: [...readiness.order],
    taskReadiness: readiness.tasks.map((entry) =>
      entry.ready
        ? { taskId: entry.taskId, ready: true, readyAfter: [...entry.readyAfter], blockedBy: [] }
        : { taskId: entry.taskId, ready: false, readyAfter: [], blockedBy: [...entry.blockedBy] },
    ),
    digest: plan.digest,
    workItemIdByTaskId: workItemIdsFor(plan),
  };
}

/**
 * The work item each of a plan's tasks publishes as.
 *
 * Recovered from the stored trail when it is readable, and derived from the plan
 * otherwise, because the derivation is the same function the trail was written with
 * and a task the owner removed keeps no position but also no publication identity.
 */
function workItemIdsFor(plan: Plan): Readonly<Record<string, string>> {
  const assigned: Record<string, string> = {};
  for (const task of plan.tasks) {
    assigned[task.taskId] = taskWorkItemId(plan.planId, task.taskId);
  }
  return assigned;
}

/** One accepted ticket paired with the work item it publishes as (F08-AC3, F10-AC3). */
interface PublishableEntry {
  readonly ticket: PublishableTicket;
  readonly workItemId: WorkItemId;
}

/** The plan's accepted proposals, as the pairs publication acts on. */
function publishableTicketsOf(
  root: CompositionRoot,
  planId: string,
): Result<readonly PublishableEntry[], DomainError> {
  const publishable = root.planningUseCases.publishableFor(planId);
  if (!publishable.ok) return err(publishable.error);
  return ok(
    publishable.value.map((ticket) => ({
      ticket,
      workItemId: taskWorkItemId(planId, ticket.taskId) as WorkItemId,
    })),
  );
}

/**
 * Where publication would publish, read from the plan's project profile.
 *
 * Refused by name when there is no profile, because F10-AC1 makes the team part of
 * what an issue must carry and a publication to an unnamed team is not a publication
 * (F02-AC1).
 */
function publicationTarget(
  root: CompositionRoot,
  planId: string,
): Result<{ readonly projectId: ProjectId; readonly teamKey: string }, DomainError> {
  const trail = root.plans.read(planId);
  if (!trail.ok) return err(trail.error);
  if (trail.value === null) return err({ code: 'NotFound', reason: `Plan ${planId} has never been drafted.` });
  const idea = root.ideas.get(trail.value.ideaId as IdeaId);
  if (!idea.ok) return err(idea.error);
  if (idea.value.projectId === null) {
    return err(
      blocked(
        `Plan ${planId} belongs to a request with no project, so there is nowhere to publish it (F10-AC1).`,
        [
          {
            name: 'project',
            detail: 'Publication creates an issue in a named team, which a project profile configures.',
            remedy: 'Capture the request against a project, save a project profile naming its ticket team, then publish (F02-AC1, F10-AC1).',
          },
        ],
      ),
    );
  }
  const profile = root.profiles.currentVersion(idea.value.projectId);
  if (!profile.ok) return err(profile.error);
  const teamKey = profile.value?.content.references.ticketTeamKey ?? null;
  if (teamKey === null || teamKey.trim().length === 0) {
    return err(
      blocked(
        `Project ${idea.value.projectId} has no saved profile naming a ticket team, so there is nowhere to publish (F10-AC1, F02-AC1).`,
        [
          {
            name: 'ticket team',
            detail: 'An accepted proposal is published as an issue in a named team, which the project profile configures.',
            remedy: 'Save a project profile naming the ticket team, then publish again (F02-AC1, F10-AC1).',
          },
        ],
      ),
    );
  }
  return ok({ projectId: idea.value.projectId, teamKey });
}

/** One ticket's outcome, in the shape F10-AC2 asks the caller to present. */
function ticketPublicationOf(
  entry: TicketPublication,
  entries: readonly PublishableEntry[],
): SurfaceTicketPublication {
  const taskId = entries.find((candidate) => candidate.workItemId === entry.workItemId)?.ticket.taskId ?? null;
  if (entry.kind === 'Published') {
    return {
      workItemId: entry.workItemId,
      taskId,
      kind: 'Published',
      issueId: entry.issue.issueId,
      identifier: entry.issue.identifier,
      url: entry.issue.url,
      disposition: entry.disposition,
      unlinked: entry.unlinked.map((link) => ({ target: link.target, reason: link.reason })),
      detail: `Published as ${entry.issue.identifier}${entry.disposition === 'AlreadyPresent' ? ' (already present; no second issue was created)' : ''}.`,
    };
  }
  if (entry.kind === 'OutcomeUnknown') {
    return {
      workItemId: entry.workItemId,
      taskId,
      kind: 'OutcomeUnknown',
      issueId: null,
      identifier: null,
      url: null,
      disposition: null,
      unlinked: [],
      detail: entry.detail,
    };
  }
  return {
    workItemId: entry.workItemId,
    taskId,
    kind: 'Failed',
    issueId: null,
    identifier: null,
    url: null,
    disposition: null,
    unlinked: [],
    detail: entry.error.reason,
  };
}

/**
 * The refusal a provider write gets when no adapter is configured.
 *
 * Named rather than generic because "publication failed" and "no ticket provider is
 * configured in this deployment" call for different next steps, and the second is
 * configuration rather than a fault (F03-AC2, F10-AC5).
 */
function noTicketProvider(action: string): DomainError {
  return blocked(`This deployment has no ticket provider configured, so ShipLoop cannot ${action}.`, [
    {
      name: 'ticket provider',
      detail: 'Publication and adoption read or write a ticket provider, and this process was started without one.',
      remedy: 'Configure a ticket provider for this deployment, then try again (F03-AC2).',
    },
  ]);
}

/** The same refusal for the git provider, which adoption of a branch also needs. */
function noGitProvider(action: string): DomainError {
  return blocked(`This deployment has no git provider configured, so ShipLoop cannot ${action}.`, [
    {
      name: 'git provider',
      detail: 'Adopting a branch or pull request reads a git provider, and this process was started without one.',
      remedy: 'Configure a git provider for this deployment, then try again (F03-AC2, F11-AC2).',
    },
  ]);
}

/** A ticket provider state as one word, so the client is not reading a union (F11-AC1). */
function describeTicketState(state: TicketState): string {
  return state.kind === 'ProviderState' ? `${state.name} (${state.terminal})` : `Unknown: ${state.detail}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value === null || typeof value !== 'object' ? null : (value as Record<string, unknown>);
}

function filledString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function stringList(value: unknown, path: string): Result<readonly string[], DomainError> {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return err(invalid(`The "${path}" field must be a list of statements.`, [{ path, message: 'Must be a list of text.' }]));
  }
  return ok(value as readonly string[]);
}

/** The change shape `draftPlan` needs, read from decoded input rather than trusted. */
function decodeChangeShape(value: unknown): Result<ChangeShape, DomainError> {
  const record = asRecord(value);
  if (record === null) {
    return err(invalid('A plan needs the change it plans.', [{ path: 'change', message: 'Must be an object.' }]));
  }
  const summary = filledString(record['summary']);
  const surfaces = record['surfaces'];
  const edges = record['dependencyEdges'];
  if (summary === null) {
    return err(invalid('A change must state what it changes.', [{ path: 'change.summary', message: 'Must not be blank.' }]));
  }
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    return err(
      invalid('A change must declare the surfaces it touches (F08-AC2).', [
        { path: 'change.surfaces', message: 'Must list at least one surface.' },
      ]),
    );
  }
  if (!Array.isArray(edges)) {
    return err(
      invalid('A change must declare its dependency edges (F08-AC2, F08-AC4).', [
        { path: 'change.dependencyEdges', message: 'Must be a list of edges.' },
      ]),
    );
  }

  const decoded: ChangeSurface[] = [];
  for (const [index, entry] of surfaces.entries()) {
    const surface = asRecord(entry);
    const surfaceId = surface === null ? null : filledString(surface['surfaceId']);
    const description = surface === null ? null : filledString(surface['description']);
    const behaviour = surface === null ? null : surface['observableBehaviour'];
    const independent = surface === null ? null : surface['independentlyReviewable'];
    if (surfaceId === null || description === null || typeof behaviour !== 'string' || typeof independent !== 'boolean') {
      return err(
        invalid('A change surface must carry an id, a description, its observable behaviour and its reviewability.', [
          { path: `change.surfaces[${index}]`, message: 'Must carry surfaceId, description, observableBehaviour and independentlyReviewable.' },
        ]),
      );
    }
    decoded.push({ surfaceId, description, observableBehaviour: behaviour, independentlyReviewable: independent });
  }

  const decodedEdges: { surface: string; dependsOn: string }[] = [];
  for (const [index, entry] of edges.entries()) {
    const edge = asRecord(entry);
    const surface = edge === null ? null : filledString(edge['surface']);
    const dependsOn = edge === null ? null : filledString(edge['dependsOn']);
    if (surface === null || dependsOn === null) {
      return err(
        invalid('A dependency edge names the surface and what it depends on (F08-AC4).', [
          { path: `change.dependencyEdges[${index}]`, message: 'Must carry surface and dependsOn.' },
        ]),
      );
    }
    decodedEdges.push({ surface, dependsOn });
  }

  return ok({ summary, surfaces: decoded, dependencyEdges: decodedEdges });
}

/**
 * The structured proposal, handed to the domain unread.
 *
 * It is passed through as `unknown` on purpose: `applyPlanProposal` is the single
 * validator for a decoded plan proposal, and reading the members here first would
 * mean a second, weaker copy of its rules (F05-AC5).
 */
function decodePlanProposal(value: unknown): Result<PlanProposal, DomainError> {
  if (asRecord(value) === null) {
    return err(
      invalid('The structured output is not a plan proposal.', [{ path: 'proposal', message: 'Must be an object.' }]),
    );
  }
  return ok(value as PlanProposal);
}

/**
 * One owner edit, decoded from the transport's body into the domain's union.
 *
 * The six kinds are named explicitly rather than validated field by field, so an edit
 * that names a kind this version does not have is refused by name rather than reaching
 * `editPlan` with members it will not read (F08-AC3).
 */
function decodePlanEdit(value: unknown, actor: OwnerActor, at: string): Result<PlanEdit, DomainError> {
  const record = asRecord(value);
  const expectedRevision = record === null ? null : record['expectedRevision'];
  if (record === null || typeof expectedRevision !== 'number') {
    return err(
      invalid('A plan edit names the revision it was prepared against (F08-AC3).', [
        { path: 'edit.expectedRevision', message: 'Must be the revision the owner was looking at.' },
      ]),
    );
  }
  const base = { expectedRevision, by: actor.actorId, at };
  const kind = filledString(record['kind']);
  const taskId = filledString(record['taskId']);
  const invalidEdit = (message: string, path: string): Result<PlanEdit, DomainError> =>
    err(invalid(message, [{ path, message }]));

  if (kind === 'Accept') {
    return taskId === null
      ? invalidEdit('Accepting names the task being accepted (F08-AC3).', 'edit.taskId')
      : ok({ ...base, kind: 'Accept', taskId });
  }
  if (kind === 'Remove') {
    return taskId === null
      ? invalidEdit('Removing names the task being removed (F08-AC3).', 'edit.taskId')
      : ok({ ...base, kind: 'Remove', taskId });
  }
  if (kind === 'Reorder') {
    const order = record['order'];
    const listed = stringList(order, 'edit.order');
    if (!listed.ok) return err(listed.error);
    return ok({ ...base, kind: 'Reorder', order: listed.value });
  }
  if (kind === 'Combine') {
    const intoTaskId = filledString(record['intoTaskId']);
    const fromTaskIds = stringList(record['fromTaskIds'], 'edit.fromTaskIds');
    if (!fromTaskIds.ok) return err(fromTaskIds.error);
    return intoTaskId === null
      ? invalidEdit('Combining names the task that absorbs the others (F08-AC3).', 'edit.intoTaskId')
      : ok({ ...base, kind: 'Combine', intoTaskId, fromTaskIds: fromTaskIds.value });
  }
  if (kind === 'Exclusion') {
    const outcomeId = filledString(record['outcomeId']);
    const excluded = filledString(record['excluded']);
    const reason = filledString(record['reason']);
    const problems: { path: string; message: string }[] = [];
    if (outcomeId === null) problems.push({ path: 'edit.outcomeId', message: 'Must name a requested outcome (F08-AC5).' });
    if (excluded === null) problems.push({ path: 'edit.excluded', message: 'Must state what is not delivered (F08-AC5).' });
    if (reason === null) problems.push({ path: 'edit.reason', message: 'Must state why (F08-AC5).' });
    if (outcomeId === null || excluded === null || reason === null || problems.length > 0) {
      return err(
        invalid('An exclusion must state the outcome, what is not delivered and why (F08-AC5).', problems),
      );
    }
    return ok({ ...base, kind: 'Exclusion', outcomeId, excluded, reason });
  }
  if (kind === 'Edit') {
    const changes = decodeTaskPatch(record['changes']);
    if (!changes.ok) return err(changes.error);
    return taskId === null
      ? invalidEdit('Editing names the task being edited (F08-AC1).', 'edit.taskId')
      : ok({ ...base, kind: 'Edit', taskId, changes: changes.value });
  }
  return invalidEdit(`"${kind ?? 'null'}" is not a plan edit (F08-AC3).`, 'edit.kind');
}

/**
 * The content fields an owner edit may change, which is exactly `PLAN_TASK_CONTENT_FIELDS`.
 *
 * Rejecting anything else here means a body cannot smuggle in a lifecycle field such as
 * `acceptance` or `delivery`; the domain refuses those too, and this keeps the refusal
 * at the boundary with a field path the owner can correct (F05-AC5, F08-AC3).
 */
function decodeTaskPatch(value: unknown): Result<PlanTaskPatch, DomainError> {
  const record = asRecord(value);
  if (record === null) {
    return err(invalid('An edit must state what changes.', [{ path: 'edit.changes', message: 'Must be an object.' }]));
  }
  const problems: { path: string; message: string }[] = [];
  const patch: Record<string, unknown> = {};

  for (const key of Object.keys(record)) {
    if (!PLAN_TASK_CONTENT_FIELDS.includes(key as PlanTaskContentField)) {
      problems.push({
        path: `edit.changes.${key}`,
        message: `"${key}" is not a task content field: ${PLAN_TASK_CONTENT_FIELDS.join(', ')} (F08-AC1).`,
      });
    }
  }

  for (const field of ['outcome', 'scope', 'verificationMethod'] as const) {
    const text = record[field];
    if (text === undefined) continue;
    const filled = filledString(text);
    if (filled === null) problems.push({ path: `edit.changes.${field}`, message: 'Must state something.' });
    else patch[field] = filled;
  }
  for (const field of ['acceptanceCriteria', 'dependencies', 'relevantProjectContext'] as const) {
    const list = record[field];
    if (list === undefined) continue;
    const listed = stringList(list, `edit.changes.${field}`);
    if (!listed.ok) {
      problems.push({ path: `edit.changes.${field}`, message: 'Must be a list of statements.' });
      continue;
    }
    patch[field] = listed.value;
  }

  const location = record['implementationLocation'];
  if (location !== undefined) {
    const record2 = asRecord(location);
    const candidates = record2 === null ? null : record2['candidates'];
    const basis = record2 === null ? null : filledString(record2['basis']);
    const listed = stringList(candidates, 'edit.changes.implementationLocation.candidates');
    if (record2 === null || record2['kind'] !== 'ProposedLocation' || !listed.ok || basis === null) {
      problems.push({
        path: 'edit.changes.implementationLocation',
        message:
          'A location is a proposal: it must be tagged ProposedLocation, offer candidates and state its basis (F08-AC5).',
      });
    } else {
      patch.implementationLocation = { kind: 'ProposedLocation', candidates: listed.value, basis };
    }
  }

  if (problems.length > 0) {
    return err(invalid('The edit changes fields a task does not have (F08-AC1).', problems));
  }
  return ok(patch as PlanTaskPatch);
}

/** What reconciliation established about one publication (F10-AC3, F28-AC4). */
function decodeReconciliationOutcome(value: unknown): Result<ReconciliationOutcome, DomainError> {
  const record = asRecord(value);
  const resolution = record === null ? null : filledString(record['resolution']);
  const detail = record === null ? null : filledString(record['detail']);
  if (detail === null) {
    return err(
      invalid('A reconciliation must state what was found (F10-AC3).', [
        { path: 'resolution.detail', message: 'Must say what was established about the operation.' },
      ]),
    );
  }
  if (resolution === 'NotApplied' || resolution === 'StillUnknown') {
    return ok({ resolution, detail });
  }
  if (resolution !== 'Applied') {
    return err(
      invalid('A reconciliation resolves to Applied, NotApplied or StillUnknown (F10-AC3).', [
        { path: 'resolution.resolution', message: 'Must be Applied, NotApplied or StillUnknown.' },
      ]),
    );
  }

  const providerIssueId = filledString(record === null ? null : record['providerIssueId']);
  const providerIssueIdentifier = filledString(record === null ? null : record['providerIssueIdentifier']);
  const providerIssueUrl = filledString(record === null ? null : record['providerIssueUrl']);
  const providerRevision = record === null ? null : record['providerRevision'];
  const problems: { path: string; message: string }[] = [];
  if (providerIssueId === null) problems.push({ path: 'resolution.providerIssueId', message: 'Must name the issue.' });
  if (providerIssueIdentifier === null) {
    problems.push({ path: 'resolution.providerIssueIdentifier', message: 'Must name the human identifier.' });
  }
  if (providerIssueUrl === null) problems.push({ path: 'resolution.providerIssueUrl', message: 'Must carry the URL.' });
  if (providerRevision !== null && providerRevision !== undefined && typeof providerRevision !== 'string') {
    problems.push({ path: 'resolution.providerRevision', message: 'Must be the provider revision or null.' });
  }
  if (problems.length > 0 || providerIssueId === null || providerIssueIdentifier === null || providerIssueUrl === null) {
    return err(
      invalid(
        'An applied reconciliation carries the provider identity the mapping settles on (F10-AC2).',
        problems,
      ),
    );
  }
  return ok({
    resolution: 'Applied',
    providerIssueId,
    providerIssueIdentifier,
    providerIssueUrl,
    providerRevision: typeof providerRevision === 'string' ? providerRevision : null,
    detail,
  });
}

/**
 * A repository identity the adoption can verify against the profile (F11-AC3).
 *
 * `provider` and `fullName` are what the wrong-project refusal matches on, so those
 * two are required and the display fields are optional: an owner selecting a branch
 * names the repository by its identity, and refusing because the profile did not carry
 * a display URL would block a correct selection for a cosmetic reason (F11-AC3).
 */
function decodeGitRepositoryRef(value: unknown): Result<GitRepositoryRef, DomainError> {
  const record = asRecord(value);
  const provider = record === null ? null : filledString(record['provider']);
  const fullName = record === null ? null : filledString(record['fullName']);
  if (provider === null || fullName === null) {
    return err(
      invalid('An adopted repository is named by provider and full path, never by display name (F11-AC3).', [
        { path: 'repository.provider', message: 'Must name the git provider.' },
        { path: 'repository.fullName', message: 'Must name the owner and repository path.' },
      ]),
    );
  }
  return ok({
    provider,
    fullName,
    defaultBranch: filledString(record === null ? null : record['defaultBranch']) ?? '',
    url: filledString(record === null ? null : record['url']) ?? '',
  });
}

/**
 * Builds the surface a transport can inject.
 *
 * Every method is a one-line delegation, so a use case whose shape changes breaks
 * this file's type check here rather than as a 500 on the owner's first request.
 */
export function createControllerSurface(resolve: SurfaceRootResolver): ControllerSurface {
  const use = async <T>(
    body: (root: CompositionRoot) => Result<T, DomainError> | Promise<Result<T, DomainError>>,
  ): Promise<Result<T, DomainError>> => {
    const root = resolve();
    if (!root.ok) return root;
    try {
      return await body(root.value);
    } catch (error) {
      return err({
        code: 'Unavailable',
        reason: `A controller use case failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  return {
    /**
     * Home's reads resolve the root per call, like every other group here. A captured root would
     * pin this surface to whichever deployment it was built from, which is the opposite of what a
     * lazily-resolved surface is for (F02-AC4).
     */
    home: {
      recordedCandidate: (input) => use((root) => homeReadsFor(root).recordedCandidate(input)),
      reviewReadModel: (input) => use((root) => homeReadsFor(root).reviewReadModel(input)),
    },
    owners: {
      /**
       * Provisions the owner, naming it the way the transport names it (F01-AC1).
       *
       * `createdAt` is the row's own creation instant, so it is the instant the
       * provision was recorded with rather than a second reading of the clock.
       */
      provision: async (command) =>
        use((root) => {
          const provisioned = root.useCases.provisionNamedOwner(command);
          if (!provisioned.ok) return err(provisioned.error);
          return ok({
            ownerId: provisioned.value.ownerId,
            displayName: command.displayName,
            // Read back from the row just written rather than re-derived from the name: the
            // row is the authority for what this owner signs in with, so provisioning and a
            // later session read cannot describe two different addresses (F01-AC1).
            email: readOwnerEmail(root, provisioned.value.ownerId),
            createdAt: provisioned.value.provisionedAt,
            // A brand-new owner has selected nothing, and saying so is the honest answer. The
            // alternative - defaulting to the first project in the store - would be handing a
            // session an identity nobody chose (F02-AC1).
            activeProject: noProjectSelected(root),
          });
        }),

      /**
       * Verifies a credential and opens the session in one step (F01-AC2).
       *
       * The token was minted and digested by the caller, so this layer receives a
       * digest and the grant carries no token: the plaintext never enters this
       * module and so cannot be logged from here (F01-AC4).
       */
      signIn: async (command) =>
        use((root) => {
          const granted = root.useCases.openOwnerSession(command, root.sessionUseCases);
          if (!granted.ok) return err(granted.error);
          return ok({ session: toSurfaceSession(granted.value) });
        }),

      /**
       * Reads the owner's stored identity back, so a session the transport re-establishes
       * carries the same address the owner provisioned with (F01-AC1).
       */
      describe: async (command) =>
        use((root) => {
          const record = root.owners.current();
          if (!record.ok) return err(record.error);
          if (record.value === null) {
            return err({ code: 'NotFound', reason: 'No owner has been provisioned on this deployment.' });
          }
          // Read the row the session names rather than the oldest row: with one provisioned
          // owner they agree today, and keying on the request means a future second owner
          // cannot be described by the first one's address (F01-AC1).
          if (String(record.value.ownerId) !== String(command.ownerId)) {
            return err({
              code: 'NotFound',
              reason: `This deployment holds no owner with the identity this session was proved for (F01-AC1).`,
            });
          }
          return ok({
            ownerId: record.value.ownerId,
            displayName: record.value.displayName,
            email: readOwnerEmail(root, record.value.ownerId),
            createdAt: record.value.createdAt,
            // Read from the durable selection, not from anything the caller passed and not
            // from the first project in the store. Both of those would answer "which project
            // is this" with something the owner did not choose, which is the defect that
            // produced `/api/profiles/undefined` in the first place (F02-AC1, F02-AC4).
            activeProject: readActiveProject(root, record.value.ownerId),
          });
        }),

      /**
       * Records which project this owner's subsequent calls address (F02-AC1).
       *
       * The write is durable rather than returned to the caller to hold, because a selection
       * the client keeps is a selection a re-established session does not have. The repository
       * refuses a project this store does not hold, so the only way to hold an
       * `activeProjectId` is to have named a real one.
       */
      selectActiveProject: async (command) =>
        use((root) => {
          const selected = root.activeProjects.select(
            command.ownerId,
            command.projectId as ProjectId,
            command.at,
          );
          if (!selected.ok) return err(selected.error);
          return ok({
            state: 'Selected' as const,
            activeProjectId: selected.value.projectId,
            activeProjectName: selected.value.name,
          });
        }),
    },

    /**
     * The owner's request and the delivery contract that answers it (mvp-spec 3).
     *
     * The actor on every command is the identity the transport proved, converted once here
     * rather than at each use case, and the project on every command is the project the
     * request is filed under. Both are enforcement inputs, not labels: the use cases refuse a
     * non-owner before reading a row, and address a row by `(project, identity)` so an
     * identifier from another project is invisible rather than merely refused (F01-AC1, F02-AC2).
     */
    contracts: {
      createRequest: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const created = root.contractUseCases.createRequest(
            {
              projectId: command.projectId as ProjectId,
              title: command.title,
              description: command.description,
            },
            actor.value,
          );
          if (!created.ok) return err(created.error);
          return ok(toSurfaceRequest(created.value));
        }),

      getRequest: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const detail = root.contractUseCases.getRequest(
            { projectId: command.projectId as ProjectId, requestId: command.requestId as RequestId, expectedUpdatedAt: '' },
            actor.value,
          );
          if (!detail.ok) return err(detail.error);
          return ok(toSurfaceRequestDetail(detail.value));
        }),

      listRequests: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const listed = root.contractUseCases.listRequests(command.projectId as ProjectId, actor.value);
          if (!listed.ok) return err(listed.error);
          return ok(listed.value.map(toSurfaceRequest));
        }),

      updateRequest: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const updated = root.contractUseCases.updateRequest(
            {
              projectId: command.projectId as ProjectId,
              requestId: command.requestId as RequestId,
              ...(command.title === undefined ? {} : { title: command.title }),
              ...(command.description === undefined ? {} : { description: command.description }),
              expectedUpdatedAt: command.expectedUpdatedAt,
            },
            actor.value,
          );
          if (!updated.ok) return err(updated.error);
          return ok(toSurfaceRequest(updated.value));
        }),

      draftContract: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const drafted = root.contractUseCases.draftContract(
            {
              projectId: command.projectId as ProjectId,
              requestId: command.requestId as RequestId,
              content: contractContentOf(command),
            },
            actor.value,
          );
          if (!drafted.ok) return err(drafted.error);
          return ok(toSurfaceContract(drafted.value));
        }),

      getContract: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const contract = root.contractUseCases.getContract(
            {
              projectId: command.projectId as ProjectId,
              contractId: command.contractId as ContractId,
              revision: command.revision,
            },
            actor.value,
          );
          if (!contract.ok) return err(contract.error);
          return ok(toSurfaceContract(contract.value));
        }),

      listContractRevisions: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const revisions = root.contractUseCases.listContractRevisions(
            { projectId: command.projectId as ProjectId, requestId: command.requestId as RequestId },
            actor.value,
          );
          if (!revisions.ok) return err(revisions.error);
          return ok(revisions.value.map(toSurfaceContract));
        }),

      listContractCriteria: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const criteria = root.contractUseCases.listContractCriteria(
            {
              projectId: command.projectId as ProjectId,
              contractId: command.contractId as ContractId,
              revision: command.revision,
            },
            actor.value,
          );
          if (!criteria.ok) return err(criteria.error);
          return ok(criteria.value.map((criterion) => ({ ...criterion })));
        }),

      /**
       * Edits a draft, naming the text it replaces.
       *
       * The fingerprint the client read comes straight through rather than being
       * re-derived here: it is a reference to a value the read returned, and the use case
       * checks it against the fingerprint the domain derives from the stored text. An edit
       * and an approval therefore name their text the same way, which is what stops the two
       * from holding two different opinions about when a draft has moved (mvp-spec 3).
       */
      editContract: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const edited = root.contractUseCases.editContract(
            {
              projectId: command.projectId as ProjectId,
              contractId: command.contractId as ContractId,
              revision: command.revision,
              content: contractContentOf(command),
              expectedContentFingerprint: command.expectedContentFingerprint,
            },
            actor.value,
          );
          if (!edited.ok) return err(edited.error);
          return ok(toSurfaceContract(edited.value));
        }),

      /**
       * Approves a revision, attributing it to the session rather than to the body.
       *
       * There is deliberately no approver parameter on this command: a body that could name
       * one would be a body that could record an approval attributed to somebody else, and
       * that is the one thing an approval may never be (mvp-spec 3).
       *
       * The reviewed text *is* on the command, because refusing an approval that cannot say
       * what it approves matters more than keeping the body free of everything. It is one
       * value the server itself derived on the read, so it is a reference and not an
       * instruction, and the use case refuses it if it no longer describes the draft.
       */
      approveRevision: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const approved = root.contractUseCases.approveContract(
            {
              projectId: command.projectId as ProjectId,
              contractId: command.contractId as ContractId,
              revision: command.revision,
              expectedContentFingerprint: command.expectedContentFingerprint,
            },
            actor.value,
          );
          if (!approved.ok) return err(approved.error);
          return ok(toSurfaceContract(approved.value));
        }),

      reviseContract: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const revised = root.contractUseCases.reviseContract(
            {
              projectId: command.projectId as ProjectId,
              contractId: command.contractId as ContractId,
              revision: command.revision,
              content: contractContentOf(command),
            },
            actor.value,
          );
          if (!revised.ok) return err(revised.error);
          return ok(toSurfaceContract(revised.value));
        }),

      invalidateRevision: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const stale = root.contractUseCases.invalidateContract(
            {
              projectId: command.projectId as ProjectId,
              contractId: command.contractId as ContractId,
              revision: command.revision,
              reason: command.reason,
            },
            actor.value,
          );
          if (!stale.ok) return err(stale.error);
          return ok(toSurfaceContract(stale.value));
        }),
    },

    /**
     * The implementation handoff for one approved revision (mvp-spec L02, L02-AC3).
     *
     * The reads and every refusal live in `handoff.ts`; this adapter supplies the four
     * handles and the owner actor and renames the result, exactly as it does for every other
     * group. The project-scoped, actor-gated contract read is `contractUseCases.getContract`
     * - the same read the `GET .../:revision` route makes - so "which revisions may be handed
     * off" cannot be a second answer to a question the product already answered once
     * (F01-AC1, F02-AC2).
     */
    handoff: {
      buildHandoff: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const handoff = buildImplementationHandoff(
            {
              contracts: root.contractUseCases,
              requests: root.requests,
              projects: root.projects,
              profiles: root.profiles,
            },
            {
              projectId: command.projectId as ProjectId,
              contractId: command.contractId as ContractId,
              revision: command.revision,
              // The operator's configuration, not a client-supplied value: a browser that
              // could name its own T3 target would be an open redirect the owner never
              // configured (N02-AC2).
              t3Url: root.t3Url,
            },
            actor.value,
          );
          if (!handoff.ok) return err(handoff.error);
          return ok(toSurfaceHandoff(handoff.value));
        }),
    },

    /**
     * The GitHub candidate port: link a pull request the owner named, and read the current
     * candidate live from the provider (mvp-spec MVP "GitHub Candidate", F11-AC2, F24-AC1).
     *
     * Both members delegate to `candidateLinkUseCases`, which is the only place the currency
     * read exists. Nothing here re-derives a fact about the provider and nothing here adds a
     * rule: each answer is the controller's own, re-expressed in the narrower vocabulary the
     * transport declares (F02-AC1, F24-AC2).
     *
     * `candidateLinkUseCases` is `null` on a deployment that configured no git provider. Both
     * methods answer that with a stated `Unavailable` naming the missing wiring, the same way
     * `recordVerification` refuses when `readLiveCandidate` is null — never a throw, and never
     * a fabricated report that would read as "nothing failed" (F03-AC2, F20-AC2).
     */
    candidates: {
      linkCandidate: async (command) =>
        use(async (root) => {
          const candidates = candidateLinkOf(root);
          if (!candidates.ok) return err(candidates.error);
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const linked = await candidates.value.linkPullRequest({
            actor: actor.value,
            projectId: command.projectId as ProjectId,
            requestId: command.requestId,
            contractId: command.contractId,
            contractRevision: command.contractRevision,
            pullRequestUrl: command.pullRequestUrl,
            // Carried through rather than re-decided here: the transport always sends null, and
            // an expected base branch is project configuration, not something a request may
            // assert for itself (mvp-spec 3, F02-AC2).
            expectedBaseBranch: command.expectedBaseBranch,
            correlationId: command.correlationId,
          });
          if (!linked.ok) return err(linked.error);
          return ok(toSurfaceLinkedCandidate(linked.value));
        }),

      /**
       * The live read, addressed by the candidate the transport named.
       *
       * The controller's read is keyed by **request**, because it answers "what does the
       * provider say about this request's candidate right now?" and a force push makes that a
       * different candidate. The transport is addressed by **candidate**, because that is the
       * identity a card is rendered against. The two are reconciled by reading the named
       * candidate's own row first: it carries both its request and its project, so a candidate
       * belonging to another project is refused here rather than answered from that project's
       * request.
       *
       * One row and one project comparison, done here because no candidate use case takes a
       * candidate id — `mvp-review-card.ts` resolves the same way, from the same repository,
       * for the same reason (F02-AC2, F24-AC4).
       */
      readCandidate: async (command) =>
        use(async (root) => {
          const candidates = candidateLinkOf(root);
          if (!candidates.ok) return err(candidates.error);
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const stored = deliveryCandidates(root).get(command.candidateId as CandidateId);
          if (!stored.ok) return err(stored.error);
          if (String(stored.value.projectId) !== command.projectId) {
            return err({
              code: 'NotFound',
              reason: `This project holds no candidate ${command.candidateId}. A candidate is addressed inside its own project, so one project's identifier cannot read another's candidate (F02-AC2).`,
            });
          }
          const read = await candidates.value.readCandidate({
            actor: actor.value,
            projectId: command.projectId as ProjectId,
            requestId: stored.value.requestId,
            correlationId: command.correlationId,
          });
          if (!read.ok) return err(read.error);
          return ok(toSurfaceCandidateRead(read.value));
        }),
    },

    /**
     * The whole review card for one candidate, and the owner's decision on it (F24, F25).
     *
     * The card is the controller's own object, passed through with no reshaping: every
     * element on it - the contract revision, the full head SHA, both evidence outcomes,
     * the staleness list and the existing decision - was computed in one pass by the use
     * case, and a second projection here would be the one place the two could disagree
     * (F24-AC2).
     *
     * The actor is built from the identity the transport proved. It is always an owner,
     * because this module is only reachable behind the session guard, and the domain
     * refuses anything else: the non-owner variants carry no owner identity for a
     * decision to borrow (F01-AC1, F25-AC4).
     */
    mvpReview: {
      getReview: async (command) =>
        use(async (root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const card = await root.mvpReviewCardUseCases.getReview({
            projectId: command.projectId,
            candidateId: command.candidateId,
            actor: { role: 'owner', ownerId: command.actor as OwnerId },
          });
          if (!card.ok) return err(card.error);
          return ok(card.value);
        }),

      /**
       * Accept, or Request Changes, bound to the exact commit the page was rendered
       * against (F24-AC4, F25-AC3).
       *
       * The full SHA and the contract revision travel with the command, so a submission
       * from an outdated card is a typed `Conflict` rather than a decision about whatever
       * the candidate has become. The refusal and every outstanding-item name come from
       * the use case unchanged, so what the owner is told cannot drift from what the
       * domain decided (F23-AC1, F25-AC2).
       */
      decide: async (command) =>
        use(async (root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const decided = await root.mvpReviewCardUseCases.decide({
            projectId: command.projectId,
            candidateId: command.candidateId,
            actor: { role: 'owner', ownerId: command.actor as OwnerId },
            decision: command.decision,
            expectedHeadSha: command.expectedHeadSha,
            expectedContractRevision: command.expectedContractRevision,
            feedback: command.feedback,
          });
          if (!decided.ok) return err(decided.error);
          return ok(decided.value);
        }),

      /**
       * Reads the provider and records what it said (F20-AC2, F20-AC3, F23-AC1).
       *
       * The command carries no result and this adapter supplies none: the verdict comes from the
       * controller's own provider read and from `recordGitHubProjection`'s mapping, both of which
       * run inside `recordVerification`. The report is the controller's own object passed through,
       * so the `recordedOutcome` / `currentOutcome` pair a client renders from is the pair the
       * projection computed rather than a second opinion formed here (F24-AC3).
       *
       * The actor is the identity the transport proved, built here so a body cannot name one
       * (F01-AC1).
       */
      recordVerification: async (command) =>
        use(async (root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const recorded = await root.mvpReviewCardUseCases.recordVerification({
            projectId: command.projectId,
            candidateId: command.candidateId,
            actor: { role: 'owner', ownerId: command.actor as OwnerId },
            correlationId: command.correlationId,
          });
          if (!recorded.ok) return err(recorded.error);
          return ok(recorded.value);
        }),

      /**
       * The owner's own test of one criterion (F23-AC1, F25-AC4).
       *
       * `outcome` is the owner's report and reaches the domain unchanged; `observedAt` is the
       * controller's clock, stamped inside the use case, so the record cannot be backdated and no
       * instant from the request survives into the evidence row. Whether the criterion is an owner
       * test at all is the domain's refusal, with its text (F23-AC1).
       */
      recordOwnerTest: async (command) =>
        use(async (root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const recorded = await root.mvpReviewCardUseCases.recordOwnerTest({
            projectId: command.projectId,
            candidateId: command.candidateId,
            actor: { role: 'owner', ownerId: command.actor as OwnerId },
            criterionId: command.criterionId,
            outcome: command.outcome,
            note: command.note,
            correlationId: `http-owner-test-${command.actor}`,
          });
          if (!recorded.ok) return err(recorded.error);
          return ok(recorded.value);
        }),
    },

    projects: {
      /**
       * Every project the store holds, oldest first (F02-AC1).
       *
       * A read carrying no caller, following the rule every other read in this file follows:
       * there is exactly one provisioned owner, so a project list cannot be scoped to one and
       * a request has nothing to authorize it with (F01-AC1).
       */
      listProjects: async () =>
        use((root) => {
          const listed = root.projects.list();
          if (!listed.ok) return err(listed.error);
          return ok(listed.value.map(toSurfaceProject));
        }),

      /**
       * Creates a project the owner can then select (F02-AC1, F03-AC2).
       *
       * Idempotent by identity, so a resubmitted form addresses the one project rather than
       * colliding with it, and the actor is the identity the transport proved even though the
       * write itself is not capability-checked: the write is attributable (F01-AC1).
       */
      createProject: async (command) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const created = root.projects.create({
            // Narrowed here rather than at the transport because this module is also the
            // consumer: the branded type records that a repository checked the identifier,
            // and the transport's own validation is a separate concern from that check.
            projectId: command.projectId as ProjectId,
            name: command.name,
            at: command.at,
          });
          if (!created.ok) return err(created.error);
          return ok(toSurfaceProject(created.value));
        }),
    },

    sessions: {
      /**
       * Resolves a presented cookie token to its stored row.
       *
       * Judges nothing about liveness: the caller's `authorizeSession` is the
       * authority on revocation and needs the row to say so, so a revoked session
       * still loads and is refused there (F01-AC2).
       */
      loadByToken: async (token) =>
        use((root) => {
          const loaded = root.sessionUseCases.loadByToken(token);
          if (!loaded.ok) return err(loaded.error);
          return ok(toSurfaceSession(loaded.value));
        }),

      /**
       * Stores a session under the caller's own limits (F01-AC2).
       *
       * No token parameter and no token in the result: the caller minted it, and
       * this layer only ever sees its digest.
       */
      create: async (command) =>
        use((root) => {
          const opened = root.sessionUseCases.open(command);
          if (!opened.ok) return err(opened.error);
          return ok(toSurfaceSession(opened.value));
        }),

      /** Revokes by stored identity; clearing the cookie is the caller's half (F01-AC2). */
      revoke: async (command) =>
        use((root) => {
          const revoked = root.sessionUseCases.revoke(command);
          if (!revoked.ok) return err(revoked.error);
          return ok(toSurfaceSession(revoked.value));
        }),

      /**
       * Records activity so the configured idle timeout can fire (F01-AC2).
       *
       * `null` on success because the port types this as a side effect with nothing
       * to report, not a read that could return something worth reading.
       */
      touch: async (command) =>
        use((root) => {
          const touched = root.sessionUseCases.touch(command);
          if (!touched.ok) return err(touched.error);
          return ok(null);
        }),
    },

    profiles: {
      saveVersion: async (command) =>
        use((root) => {
          const saved = root.useCases.saveProfile(
            {
              projectId: command.projectId,
              content: command.content,
              note: command.note,
              expectedVersionNumber: command.expectedVersionNumber,
            },
            ownerActor(command.actor),
          );
          if (!saved.ok) return err(saved.error);
          return ok(toSurfaceProfile(saved.value));
        }),

/**
       * The newest version, or null when the project has none.
       *
       * `currentProfile` has exactly one `NotFound` branch and it is this condition,
       * so translating it here is a renaming rather than a suppression, and it is the
       * only error this mapping interprets. The port types the answer as null and the
       * transport turns null into 404; inventing a refusal here as well would give one
       * condition two different answers depending on who asked.
       */
      currentVersion: async (projectId) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const current = root.useCases.currentProfile({ projectId, actor: actor.value });
          if (!current.ok) {
            return current.error.code === 'NotFound' ? ok(null) : err(current.error);
          }
          return ok(current.value === null ? null : toSurfaceProfile(current.value));
        }),

      listVersions: async (projectId) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const versions = root.useCases.listProfileVersions({ projectId, actor: actor.value });
          if (!versions.ok) return err(versions.error);
          return ok(versions.value.map(toSurfaceProfile));
        }),
    },

    connectors: {
      /**
       * Registers a credential reference and probes nothing.
       *
       * The returned reference is the one the caller supplied, which the use case
       * has just persisted, paired with the digest from the stored row, so the two
       * cannot describe different references (F03-AC3).
       */
      register: async (command) =>
        use((root) => {
          const actor = ownerActor(command.actor);
          const registered = root.useCases.registerConnector(
            {
              projectId: command.projectId,
              kind: command.kind,
              provider: command.provider,
              resourceScope: command.resourceScope,
              credentialReference: command.credentialReference,
            },
            actor,
          );
          if (!registered.ok) return err(registered.error);
          const stored = root.useCases.ownerConnector(registered.value.connectorId, actor);
          if (!stored.ok) return err(stored.error);
          return ok(toSurfaceConnector({ ...stored.value, credentialReference: command.credentialReference }));
        }),

      listForProject: async (projectId) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const listed = root.useCases.ownerConnectors({ projectId, actor: actor.value });
          if (!listed.ok) return err(listed.error);
          return ok(listed.value.map(toSurfaceConnector));
        }),

      revoke: async (command) =>
        use((root) => {
          const actor = ownerActor(command.actor);
          const revoked = root.useCases.revokeConnector(
            { connectorId: command.connectorId, reason: command.reason },
            actor,
          );
          if (!revoked.ok) return err(revoked.error);
          const stored = root.useCases.ownerConnector(command.connectorId, actor);
          if (!stored.ok) return err(stored.error);
          return ok(toSurfaceConnector(stored.value));
        }),
    },

    /**
     * Project settings: the optional T3 launch target, and a read of the configuration
     * this project already has (mvp-spec 3, L02-AC2, L02-AC3).
     *
     * Both commands carry the identity the transport proved, converted once here as every
     * other group does, and the project from the path. The rules - what a usable T3 URL is,
     * that a project this deployment does not hold is invisible, that no credential
     * reference travels - live in `settings.ts`; nothing is restated here.
     */
    settings: {
      readSettings: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const read = root.settingsUseCases.readSettings({ projectId: command.projectId, actor: actor.value });
          if (!read.ok) return err(read.error);
          return ok(toSurfaceSettings(read.value));
        }),

      /**
       * `t3Url` is passed through as the caller stated it, including `null` for a clear and
       * absence for "nothing to change". Collapsing those three states here would decide at
       * the transport what a save means, and the distinction is the use case's (L02-AC3).
       *
       * `at` is the transport's instant and is not used for the row: the settings use cases
       * record writes with the controller's own injected clock, which is the same clock in
       * one process and keeps one time source in the use case rather than one per caller
       * (mvp-spec 7).
       */
      updateSettings: async (command) =>
        use((root) => {
          const actor = ownerActorFor(command.actor);
          if (!actor.ok) return err(actor.error);
          const updated = root.settingsUseCases.updateSettings({
            projectId: command.projectId,
            ...(command.t3Url === undefined ? {} : { t3Url: command.t3Url }),
            actor: actor.value,
          });
          if (!updated.ok) return err(updated.error);
          return ok(toSurfaceSettings(updated.value));
        }),
    },

    intake: {
      captureIdea: async (command) =>
        use((root) => {
          const captured = root.intakeUseCases.captureIdea(
            {
              rawRequest: command.rawRequest,
              kind: command.kind,
              projectId: command.projectId,
              notes: command.notes,
              detail: command.detail,
            },
            ownerActor(command.actor),
          );
          if (!captured.ok) return err(captured.error);
          return ok(toSurfaceIdea(captured.value));
        }),

      /**
       * Reads carry no caller, so the owner is resolved rather than assumed, and the
       * same `requireOwner` gate every write passes is what a read passes (F01-AC1).
       */
      listIdeas: async () =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const listed = root.intakeUseCases.listIdeas(actor.value);
          if (!listed.ok) return err(listed.error);
          return ok(listed.value.map(toSurfaceIdea));
        }),

      getIdea: async (ideaId) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const detail = root.intakeUseCases.getIdea(ideaId, actor.value);
          if (!detail.ok) return err(detail.error);
          return ok(toSurfaceDetail(detail.value));
        }),

      attachFile: async (command) =>
        use(async (root) => {
          const attached = await root.intakeUseCases.attachFile(
            {
              ideaId: command.ideaId,
              name: command.name,
              mediaType: command.mediaType,
              content: command.content,
            },
            ownerActor(command.actor),
          );
          if (!attached.ok) return err(attached.error);
          return ok(toSurfaceIdea(attached.value));
        }),

      recordSummary: async (command) =>
        use((root) => {
          const summarized = root.intakeUseCases.recordSummary(
            { ideaId: command.ideaId, text: command.text, generatedBy: command.generatedBy },
            ownerActor(command.actor),
          );
          if (!summarized.ok) return err(summarized.error);
          return ok(toSurfaceIdea(summarized.value));
        }),

      archiveIdea: async (command) =>
        use((root) => {
          const archived = root.intakeUseCases.archiveIdea(
            { ideaId: command.ideaId, reason: command.reason },
            ownerActor(command.actor),
          );
          if (!archived.ok) return err(archived.error);
          return ok(toSurfaceIdea(archived.value));
        }),

      deferIdea: async (command) =>
        use((root) => {
          const deferred = root.intakeUseCases.deferIdea(
            { ideaId: command.ideaId, reason: command.reason },
            ownerActor(command.actor),
          );
          if (!deferred.ok) return err(deferred.error);
          return ok(toSurfaceIdea(deferred.value));
        }),

      findRelatedWork: async (ideaId) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const related = root.intakeUseCases.findRelatedWork({ ideaId }, actor.value);
          if (!related.ok) return err(related.error);
          return ok(toSurfaceRelatedness(related.value));
        }),

      recordRelatedWorkChoice: async (command) =>
        use((root) => root.intakeUseCases.recordRelatedWorkChoice({
          ideaId: command.ideaId,
          candidateIdeaId: command.candidateIdeaId,
          choice: command.choice,
        }, ownerActor(command.actor))),

      draftBrief: async (command) =>
        use((root) =>
          root.intakeUseCases.draftBrief(
            {
              ideaId: command.ideaId,
              authoredBy: command.authoredBy,
              sections: command.sections,
              basedOnBriefVersion: command.basedOnBriefVersion,
            },
            ownerActor(command.actor),
          ),
        ),

      agreeBrief: async (command) =>
        use((root) => root.intakeUseCases.agreeBrief(command.ideaId, ownerActor(command.actor))),

      askClarifyingQuestions: async (command) =>
        use((root) =>
          root.intakeUseCases.askClarifyingQuestions(
            { ideaId: command.ideaId, sections: command.sections, ambiguities: command.ambiguities },
            ownerActor(command.actor),
          ),
        ),

      answerClarifyingQuestion: async (command) =>
        use((root) =>
          root.intakeUseCases.answerClarifyingQuestion(
            { ideaId: command.ideaId, questionId: command.questionId, answer: command.answer },
            ownerActor(command.actor),
          ),
        ),

      applyOwnerCorrection: async (command) =>
        use((root) =>
          root.intakeUseCases.applyOwnerCorrection(
            {
              ideaId: command.ideaId,
              text: command.text,
              sections: command.sections,
              basedOnBriefVersion: command.basedOnBriefVersion,
            },
            ownerActor(command.actor),
          ),
        ),

      exportIdea: async (ideaId) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          return root.intakeUseCases.exportIdea(ideaId, actor.value);
        }),
    },

    /**
     * Runs: start, read, and the three lifecycle moves (F13, F17, F18).
     *
     * Every method is a delegation with a projection, so a run's state, its resume point
     * and its writer all come from the queue's own rows and a client cannot report a
     * lifecycle move the store did not make (F17-AC1, N01-AC3).
     */
    runs: {
      /**
       * Starts work, or answers with the run this operation identity already started
       * (F13-AC1, F13-AC2).
       *
       * The `deduplicated` flag travels rather than being decided here: it is the queue's
       * record of whether this call inserted the row, and re-deriving it from a read would
       * turn a race into an answer (F13-AC2).
       */
      startRun: async (command) =>
        use((root) => {
          const started = startRunWith(root.jobUseCases, command);
          if (!started.ok) return err(started.error);
          return ok({
            job: toSurfaceJob(started.value.job),
            deduplicated: started.value.deduplicated,
            capturedScope: {
              scopeSnapshotId: started.value.capturedScope.scopeSnapshotId,
              workItemId: started.value.capturedScope.workItemId,
              sequenceNumber: started.value.capturedScope.sequenceNumber,
              scopeFingerprint: started.value.capturedScope.scopeFingerprint,
              capturedAt: started.value.capturedScope.capturedAt,
            },
            dispatch: { ...started.value.dispatch },
            grant: { ...started.value.grant },
            requestedByOwner: started.value.requestedByOwner,
          });
        }),

      /**
       * The recorded runs, oldest first.
       *
       * Job rows only: the ordering is the queue's own, and a listing that also read every
       * checkpoint would make the cost of the list grow with the number of runs the owner
       * is least likely to open (N04-AC2).
       */
      listRuns: async () =>
        use((root) => {
          const listed = listRecordedRuns(root);
          if (!listed.ok) return err(listed.error);
          return ok(listed.value.map(toSurfaceJob));
        }),

      /** The run, its resume point and who holds the writer for it (F13-AC1, F17-AC2). */
      getRun: async (jobId) =>
        use((root) => {
          const view = root.jobUseCases.getRun(jobId);
          if (!view.ok) return err(view.error);
          return ok(toSurfaceView(view.value));
        }),

      /**
       * Pauses, and reports whether the writer stopped.
       *
       * The transition is the queue's and the writer's disposition is the lease's; this
       * layer adds no judgement, so a run can only be shown as `Paused` when the store says
       * its writer is gone (F17-AC1).
       */
      pauseRun: async (jobId) =>
        use((root) => {
          const paused: Result<PausedRun, DomainError> = root.jobUseCases.pauseRun(jobId);
          if (!paused.ok) return err(paused.error);
          return ok({ ...toSurfaceView(paused.value), writerStopped: paused.value.writerStopped });
        }),

      /** Resumes from the recorded resume point, which travels with the answer (F17-AC3). */
      resumeRun: async (jobId) =>
        use((root) => {
          const resumed: Result<ResumedRun, DomainError> = root.jobUseCases.resumeRun(jobId);
          if (!resumed.ok) return err(resumed.error);
          return ok({ job: toSurfaceJob(resumed.value.job), checkpoint: toSurfaceCheckpoint(resumed.value.checkpoint) });
        }),

      /**
       * Cancels, reporting the resume point that survived and that no delivery was touched
       * (F17-AC4).
       */
      cancelRun: async (jobId) =>
        use((root) => {
          const cancelled: Result<CancelledRun, DomainError> = root.jobUseCases.cancelRun(jobId);
          if (!cancelled.ok) return err(cancelled.error);
          return ok({
            job: toSurfaceJob(cancelled.value.job),
            preservedCheckpoint:
              cancelled.value.preservedCheckpoint === null ? null : toSurfaceCheckpoint(cancelled.value.preservedCheckpoint),
            writer: toSurfaceWriter(cancelled.value.writer),
            externalDelivery: cancelled.value.externalDelivery,
          });
        }),

      /**
       * Extends a reached limit (F18-AC2).
       *
       * `extendedBoundRecorded: false` travels because it is true: nothing in storage can
       * write the extended bound onto the job, so a client that reported it as recorded
       * would promise an owner a budget a restart would lose (F18-AC2, N01-AC3).
       */
      grantExtension: async (command) =>
        use((root) => {
          const granted: Result<GrantedExtension, DomainError> = root.jobUseCases.grantExtension(
            command.jobId,
            command.actor,
          );
          if (!granted.ok) return err(granted.error);
          return ok({
            job: toSurfaceJob(granted.value.job),
            previousLimits: granted.value.previousLimits,
            extendedLimits: granted.value.extendedLimits,
            extendedBoundRecorded: granted.value.extendedBoundRecorded,
            decidedBy: granted.value.decidedBy,
            decidedAt: granted.value.decidedAt,
          });
        }),

      /** Declines an extension, which leaves the attempt waiting (F18-AC2). */
      declineExtension: async (command) =>
        use((root) => {
          const declined: Result<DeclinedExtension, DomainError> = root.jobUseCases.declineExtension(
            command.jobId,
            command.actor,
          );
          if (!declined.ok) return err(declined.error);
          return ok({
            job: toSurfaceJob(declined.value.job),
            limitsInForce: declined.value.limitsInForce,
            decidedBy: declined.value.decidedBy,
            decidedAt: declined.value.decidedAt,
          });
        }),
    },

    attention: {
      /**
       * The board for one project, or for the project this owner's recorded work belongs
       * to (F31-AC1, F31-AC2).
       *
       * An owner with no recorded work gets an empty board naming no project rather than a
       * refusal: "you have nothing to look at" is the answer, and it is not an error.
       */
      collectAttention: async (command) =>
        use((root) => {
          const resolved = command.projectId === null ? recordedProjectOf(root) : ok(command.projectId);
          if (!resolved.ok) return err(resolved.error);
          if (resolved.value === null) {
            return ok({ projectId: null, collectedAt: command.at, items: [], groups: [], persistedItemIds: [] });
          }
          const board: Result<AttentionBoard, DomainError> = root.attentionUseCases.collectAttention(
            resolved.value as ProjectId,
          );
          if (!board.ok) return err(board.error);
          return ok(toSurfaceBoard(board.value));
        }),

      /**
       * Records that the owner has seen an item, and nothing else (F31-AC4).
       *
       * Only an item with a durable row can be acknowledged, and the returned item is the
       * stored row, so a client cannot show an acknowledgement that was recorded nowhere
       * (F31-AC3, F31-AC4).
       */
      acknowledge: async (command) =>
        use((root) => {
          const acknowledged: Result<AttentionItemRecord, DomainError> = root.attentionUseCases.acknowledge(
            command.attentionItemId,
            command.actor,
          );
          if (!acknowledged.ok) return err(acknowledged.error);
          return ok(toSurfaceAttentionItem(acknowledged.value));
        }),
    },

    reviewCards: {
      /**
       * The card for the candidate the run's work item currently offers (F24-AC2).
       *
       * The candidate is read from the store rather than taken from the request, and the
       * card is built by the verification use case, so a candidate that is no longer the
       * current one is refused by that use case with both identities named instead of being
       * shown as this run's evidence (F24-AC4).
       */
      buildReviewCard: async (jobId) =>
        use(async (root) => {
          const run = await root.jobUseCases.getRun(jobId);
          if (!run.ok) return err(run.error);
          const current = await currentCandidateFor(root, run.value.job.workItemId);
          if (!current.ok) return err(current.error);
          const card: Result<ReviewCard, DomainError> = root.verificationUseCases.buildReviewCard(current.value);
          if (!card.ok) return err(card.error);
          return ok(toSurfaceReviewCard(card.value));
        }),
    },

    acceptance: {
      /**
       * Records the owner's reason against the candidate this run currently offers (F25-AC2).
       *
       * The candidate is resolved from the run rather than taken from the request, and the
       * owner actor is built from the identity the transport proved, so a caller cannot
       * record feedback against a candidate it chose or under a role it was not granted
       * (F25-AC4).
       */
      requestChanges: async (command) =>
        use(async (root) => {
          const candidate = await candidateForRun(root, command.jobId);
          if (!candidate.ok) return err(candidate.error);
          const requested = root.acceptanceUseCases.requestChanges({
            candidateId: candidate.value.candidateId,
            actor: ownerActor(command.actor),
            reason: command.reason,
            correlationId: correlationOf(command.jobId),
          });
          if (!requested.ok) return err(requested.error);
          const report = requested.value;
          return ok({
            candidateId: report.candidateId,
            workItemId: String(report.workItemId),
            decisionId: report.decisionId,
            state: report.state,
            ownerId: report.ownerId,
            decidedAt: report.decidedAt,
            feedback: report.feedback,
            outstandingCriterionIds: [...report.outstandingCriterionIds],
          });
        }),

      /**
       * Records acceptance of the candidate this run currently offers (F25-AC1).
       *
       * The refusal that names the outstanding criteria comes from the use case and is
       * passed through rather than restated here, so what the owner is told cannot drift
       * from what the domain decides is outstanding (F25-AC1).
       */
      recordAcceptance: async (command) =>
        use(async (root) => {
          const candidate = await candidateForRun(root, command.jobId);
          if (!candidate.ok) return err(candidate.error);
          const accepted = root.acceptanceUseCases.recordAcceptance({
            candidateId: candidate.value.candidateId,
            actor: ownerActor(command.actor),
            note: command.note,
            correlationId: correlationOf(command.jobId),
          });
          if (!accepted.ok) return err(accepted.error);
          const report = accepted.value;
          return ok({
            candidateId: report.candidateId,
            workItemId: String(report.workItemId),
            decisionId: report.decisionId,
            state: report.state,
            ownerId: report.ownerId,
            decidedAt: report.decidedAt,
            candidateFingerprint: report.candidateFingerprint,
            headSha: report.headSha,
            scopeFingerprint: report.scopeFingerprint,
            observedDeployments: report.observedDeployments.map((deployment) => ({ ...deployment })),
            feedbackHonoured: report.feedbackHonoured.map((entry) => ({ ...entry })),
          });
        }),

      /**
       * The acceptance state the candidate currently holds (F25-AC3).
       *
       * Retained feedback travels with it because the read is what a fix pass loads, and a
       * read that dropped the feedback would make the recorded reason unreachable from the
       * only screen that shows it (F25-AC2).
       */
      currentAcceptance: async (jobId) =>
        use(async (root) => {
          const candidate = await candidateForRun(root, jobId);
          if (!candidate.ok) return err(candidate.error);
          const view = root.acceptanceUseCases.currentAcceptance(candidate.value.candidateId);
          if (!view.ok) return err(view.error);
          return ok({
            candidateId: view.value.candidateId,
            candidateFingerprint: view.value.candidateFingerprint,
            state: view.value.state,
            decisionId: view.value.decisionId,
            ownerId: view.value.ownerId,
            decidedAt: view.value.decidedAt,
            note: view.value.note,
            staleReasons: [...view.value.staleReasons],
            retainedFeedback: view.value.retainedFeedback.map((entry) => ({ ...entry })),
          });
        }),

      /**
       * The criteria and what is outstanding, read from the same evidence the card reads (F25-AC1).
       */
      acceptanceGate: async (jobId) =>
        use(async (root) => {
          const candidate = await candidateForRun(root, jobId);
          if (!candidate.ok) return err(candidate.error);
          const gate = root.acceptanceUseCases.acceptanceGate(candidate.value.candidateId);
          if (!gate.ok) return err(gate.error);
          return ok({
            candidateFingerprint: gate.value.candidateFingerprint,
            headSha: gate.value.headSha,
            scopeFingerprint: gate.value.scopeFingerprint,
            criteria: gate.value.criteria.map((criterion) => ({
              criterionId: criterion.criterionId,
              text: criterion.text,
              methodKind: String(criterion.methodKind),
              status: String(criterion.status),
              observed: criterion.observed,
            })),
            outstandingCriterionIds: [...gate.value.outstandingCriterionIds],
            ready: gate.value.ready,
          });
        }),
    },

    /**
     * Manual owner test recording (F23-AC1, F24-AC4, F25-AC1, F25-AC4).
     *
     * Delegation plus a projection. The candidate is resolved from the run rather than taken
     * from the request, the fingerprint the owner's page was rendered against is forwarded as
     * the claim it is so the use case can refuse it, and the owner actor is built from the
     * identity the transport proved. Nothing here decides anything, so the refusals an owner
     * reads are the ones the owner-test use case wrote (F23-AC1, F25-AC4).
     */
    ownerTests: {
      recordOwnerObservation: async (command) =>
        use(async (root) => {
          const candidate = await candidateForRun(root, command.jobId);
          if (!candidate.ok) return err(candidate.error);
          const recorded = ownerObservationUseCases(root).recordOwnerObservation({
            candidateId: candidate.value.candidateId,
            expectedCandidateFingerprint: command.expectedCandidateFingerprint as Fingerprint,
            criterionId: command.criterionId,
            actor: ownerActor(command.actor),
            observation: command.observation,
            observedAgainst: command.observedAgainst as OwnerObservationTarget,
            evidence: command.evidence,
            note: command.note,
            correlationId: correlationOf(command.jobId),
          });
          if (!recorded.ok) return err(recorded.error);
          const report = recorded.value;
          return ok({
            observation: toSurfaceOwnerObservation(report.observation),
            recordedForDelivery: report.recordedForDelivery,
            outstandingCriterionIds: [...report.outstandingCriterionIds],
          });
        }),

      /**
       * The observations bound to one exact candidate identity (F20-AC3, F23-AC1).
       *
       * The fingerprint is part of the query, and the candidate is the run's current one, so a
       * replacement candidate reads as having inherited nothing from the build it replaced
       * rather than as showing that build's results (F20-AC3).
       */
      listOwnerObservations: async (query) =>
        use(async (root) => {
          const candidate = await candidateForRun(root, query.jobId);
          if (!candidate.ok) return err(candidate.error);
          const listed = ownerObservationUseCases(root).listOwnerObservations({
            candidateId: candidate.value.candidateId,
            candidateFingerprint: query.candidateFingerprint as Fingerprint,
          });
          if (!listed.ok) return err(listed.error);
          return ok(listed.value.map(toSurfaceOwnerObservation));
        }),
    },

    planning: {
      /**
       * Validates a structured proposal and drafts the plan it describes (F08-AC1).
       *
       * The proposal arrives as `unknown` because it is decoded structured output: the
       * route cannot trust its shape and neither can this file, so the only thing that
       * reads it is `applyPlanProposal`, which refuses a lifecycle field rather than
       * dropping one (F05-AC5). Re-declaring the fields here would be a second
       * validator that could drift from the domain's.
       */
      draftPlan: async (command) =>
        use((root) => {
          const change = decodeChangeShape(command.change);
          if (!change.ok) return err(change.error);
          const proposal = decodePlanProposal(command.proposal);
          if (!proposal.ok) return err(proposal.error);
          const drafted = root.planningUseCases.draftPlan({
            ideaId: command.ideaId,
            planId: command.planId,
            change: change.value,
            proposal: proposal.value,
            actor: command.actor,
          });
          if (!drafted.ok) return err(drafted.error);
          return ok(toSurfacePlan(root, drafted.value));
        }),

      getPlan: async (planId) =>
        use((root) => {
          const found = root.planningUseCases.getPlan(planId);
          if (!found.ok) return err(found.error);
          return ok(toSurfacePlan(root, found.value));
        }),

      listPlansForIdea: async (ideaId) =>
        use((root) => {
          const listed = root.planningUseCases.listPlansForIdea(ideaId);
          if (!listed.ok) return err(listed.error);
          return ok(listed.value.map((plan) => toSurfacePlan(root, plan)));
        }),

      /**
       * Applies one owner edit to a stored plan (F08-AC3).
       *
       * `by` comes from the session the transport proved, so who accepted or removed a
       * task is a fact about the request rather than something the body could assert
       * (F01-AC1).
       */
      editPlan: async (command) =>
        use((root) => {
          const edit = decodePlanEdit(command.edit, ownerActor(command.actor), controllerClock().now());
          if (!edit.ok) return err(edit.error);
          const edited = root.planningUseCases.editPlan({ planId: command.planId, edit: edit.value });
          if (!edited.ok) return err(edited.error);
          return ok(toSurfacePlan(root, edited.value));
        }),

      /**
       * The recorded readiness decision, with every area F09-AC1 names (F09-AC1).
       *
       * `orderedAreas` is the domain's own reader rather than a map iteration here, so
       * the order is the order the specification lists and no area can be dropped by a
       * client reading the object (F09-AC1).
       */
      assessPlan: async (planId) =>
        use((root) => {
          const assessed = root.planningUseCases.assessPlan(planId);
          if (!assessed.ok) return err(assessed.error);
          const { decision } = assessed.value;
          return ok({
            subjectId: decision.subjectId,
            assessedAt: decision.assessedAt,
            verdict: decision.verdict,
            mayStartBuild: decision.mayStartBuild,
            mayStartInvestigation: decision.mayStartInvestigation,
            buildBlockingAreas: [...decision.buildBlockingAreas],
            areas: orderedAreas(decision).map((area) => ({
              area: area.area,
              status: area.status,
              reason: area.reason,
              remedy: area.remedy,
            })),
            reasons: decision.reasons.map((reason) => ({
              area: reason.area,
              status: reason.status,
              reason: reason.reason,
            })),
          });
        }),

      /**
       * Publishes the plan's accepted proposals and reports per ticket (F10-AC2).
       *
       * A plan with no accepted proposal is refused by name rather than published as
       * nothing: "you have nothing accepted to publish" and "publication succeeded with
       * zero tickets" are different answers, and only the first is true (F08-AC3,
       * F10-AC1). The provider refusal is the use case's, not this file's: with no
       * ticket adapter configured this returns `Blocked` naming the missing adapter,
       * which is the honest state rather than a fabricated success (F03-AC2).
       */
      publishPlan: async (command) =>
        use(async (root) => {
          const usable = publishableTicketsOf(root, command.planId);
          if (!usable.ok) return err(usable.error);
          if (usable.value.length === 0) {
            return err(
              invalid(
                `Plan ${command.planId} has no accepted proposal, so there is nothing to publish (F08-AC3, F10-AC1).`,
                [
                  {
                    path: 'planId',
                    message:
                      'Only an accepted proposal may be published. Accept at least one task on the plan first (F08-AC3).',
                  },
                ],
              ),
            );
          }
          const publications = root.publicationUseCases;
          if (publications === null) return err(noTicketProvider('publish this plan'));
          const target = publicationTarget(root, command.planId);
          if (!target.ok) return err(target.error);

          const tickets: TicketToPublish[] = [];
          for (const entry of usable.value) {
            const revision = publications.revisionFor(entry.ticket, entry.workItemId, target.value.teamKey, []);
            if (!revision.ok) return err(revision.error);
            tickets.push({ workItemId: entry.workItemId, revision: revision.value });
          }

          const report = await publications.publishAcceptedWork({
            actor: ownerActor(command.actor),
            projectId: target.value.projectId,
            requestId: command.requestId,
            tickets,
            correlationId: command.correlationId,
          });
          if (!report.ok) return err(report.error);
          return ok({
            requestId: report.value.requestId,
            planId: command.planId,
            tickets: report.value.tickets.map((entry) => ticketPublicationOf(entry, usable.value)),
            published: [...report.value.published],
            unpublished: [...report.value.unpublished],
            reconciled: report.value.tickets.every((entry) => entry.kind === 'Published' && entry.disposition === 'AlreadyPresent'),
          });
        }),

      /**
       * Records what reconciliation established about one publication (F10-AC3).
       *
       * The reconciliation worklist owns whether a resolution may be recorded; this
       * passes the owner's finding through and reports the refusal unchanged, so a
       * client cannot reconcile an operation whose outcome was never in doubt
       * (F10-AC3).
       */
      reconcilePublication: async (command) =>
        use((root) => {
          const publications = root.publicationUseCases;
          if (publications === null) return err(noTicketProvider('reconcile a publication'));
          const resolution = decodeReconciliationOutcome(command.resolution);
          if (!resolution.ok) return err(resolution.error);
          const reconciled = publications.reconcilePublication({
            actor: ownerActor(command.actor),
            operationId: command.operationId,
            resolution: resolution.value,
            observedAt: command.observedAt,
            resolvedBy: command.resolvedBy,
            correlationId: command.correlationId,
          });
          if (!reconciled.ok) return err(reconciled.error);
          return ok({
            resolution: reconciled.value.kind,
            workItemId: reconciled.value.workItemId,
            detail:
              reconciled.value.kind === 'Published'
                ? `Operation ${command.operationId} settled on provider issue ${reconciled.value.issueId}; no second issue was created (F10-AC3).`
                : reconciled.value.kind === 'RetryPermitted'
                  ? `Operation ${command.operationId} did not reach the provider, so a retry is permitted (F10-AC5).`
                  : `Operation ${command.operationId} is still unresolved and must be settled before any retry (F30-AC5).`,
          });
        }),

      /**
       * Binds an existing provider issue to a new work item (F11-AC1).
       *
       * The live read happens inside the use case before any local row exists, so a
       * wrong-team or ambiguous mapping never creates the row it would have corrupted
       * (F11-AC3). Nothing here writes at the provider: there is no write call in this
       * path, and `mergeable` is a literal `false` so no client can offer a merge
       * (F11-AC1, F11-AC3).
       */
      adoptExistingIssue: async (command) =>
        use(async (root) => {
          const adoption = root.adoptionUseCases;
          if (adoption === null) return err(noTicketProvider('adopt an existing issue'));
          const adopted = await adoption.adoptExistingIssue({
            actor: ownerActor(command.actor),
            projectId: command.projectId,
            profileVersionId: command.profileVersionId,
            procedureVersionId: command.procedureVersionId,
            issueId: command.issueId,
            expectedIdentifier: command.expectedIdentifier,
            title: command.title,
            correlationId: command.correlationId,
          });
          if (!adopted.ok) return err(adopted.error);
          return ok({
            workItemId: adopted.value.workItem.workItemId,
            issueId: adopted.value.issue.issueId,
            identifier: adopted.value.issue.identifier,
            url: adopted.value.issue.url,
            title: adopted.value.snapshot.title,
            description: adopted.value.snapshot.description,
            priority: adopted.value.snapshot.priority,
            acceptanceCriteria: adopted.value.snapshot.acceptanceCriteria.map((criterion) => ({
              id: criterion.id,
              text: criterion.text,
            })),
            dependencyIssueIds: [...adopted.value.snapshot.dependencyIssueIds],
            state: describeTicketState(adopted.value.state),
            capturedScopeSnapshotId: adopted.value.capturedScopeSnapshotId,
            mergeable: false,
          });
        }),

      /**
       * Links an existing branch or pull request, verified first (F11-AC2).
       *
       * The recorded head and target are what was *observed*: this path has no push,
       * force or reset capability, so adoption cannot reset a person's branch
       * (F11-AC4, F14-AC2).
       */
      linkExistingChange: async (command) =>
        use(async (root) => {
          const adoption = root.adoptionUseCases;
          if (adoption === null) return err(noGitProvider('link an existing branch or pull request'));
          const repository = decodeGitRepositoryRef(command.repository);
          if (!repository.ok) return err(repository.error);
          const linked = await adoption.linkExistingChange({
            actor: ownerActor(command.actor),
            workItemId: command.workItemId as WorkItemId,
            repository: repository.value,
            branch: command.branch,
            baseBranch: command.baseBranch,
            expectedHeadSha: command.expectedHeadSha,
            pullRequestId: command.pullRequestId,
            correlationId: command.correlationId,
          });
          if (!linked.ok) return err(linked.error);
          return ok({
            workItemId: linked.value.workItem.workItemId,
            repository: linked.value.adoption.repository,
            headSha: linked.value.headSha,
            baseBranch: linked.value.baseBranch,
            pullRequestId: linked.value.pullRequestId,
          });
        }),

      /**
       * Records a Test or Review request for an adopted candidate (F11-AC5).
       *
       * `Build` reaches this port so the refusal is the use case's own and names the
       * reset it prevents, rather than a schema that silently drops a mode the owner
       * selected (F11-AC5, F11-AC4). `jobEnqueued` is a literal `false`: no job store is
       * in this path at all (F11-AC5, F13-AC5).
       */
      requestAdoptedEvaluation: async (command) =>
        use((root) => {
          const adoption = root.adoptionUseCases;
          if (adoption === null) return err(noTicketProvider('request a review of adopted work'));
          const requested = adoption.requestAdoptedEvaluation({
            actor: ownerActor(command.actor),
            workItemId: command.workItemId as WorkItemId,
            candidateId: command.candidateId as CandidateId | null,
            candidateFingerprint: command.candidateFingerprint as Fingerprint | null,
            mode: command.mode,
            correlationId: command.correlationId,
          });
          if (!requested.ok) return err(requested.error);
          return ok({
            workItemId: requested.value.workItemId,
            mode: requested.value.mode,
            dedupKey: requested.value.dedupKey,
            created: requested.value.created,
            jobEnqueued: false,
          });
        }),
    },

    /**
     * Generation: the owner's two "do it for me" actions, and the reads that follow them.
     *
     * A start delegates and returns whatever the composition recorded, including the case where
     * nothing was scheduled because the deployment configured no engine. That refusal is the use
     * case's own and reaches the owner unchanged: a client that answered "started" here and
     * discovered the absence later would report a run that does not exist (F03-AC2, N04-AC3).
     */
    generation: {
      startBriefGeneration: async (command) =>
        use((root) => {
          const started = root.generationUseCases.startBriefGeneration({
            ideaId: command.ideaId,
            actor: ownerActor(command.actor),
          });
          return started.ok ? ok(toSurfaceGeneration(started.value)) : err(started.error);
        }),

      startPlanGeneration: async (command) =>
        use((root) => {
          const started = root.generationUseCases.startPlanGeneration({
            ideaId: command.ideaId,
            actor: ownerActor(command.actor),
          });
          return started.ok ? ok(toSurfaceGeneration(started.value)) : err(started.error);
        }),

      /** Reads carry no caller, so the owner is resolved rather than taken from the request. */
      getGeneration: async (generationId) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const found = root.generationUseCases.getGeneration(generationId);
          return found.ok ? ok(toSurfaceGeneration(found.value)) : err(found.error);
        }),

      listGenerations: async (ideaId) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const listed = root.generationUseCases.listGenerations(ideaId);
          return listed.ok ? ok(listed.value.map(toSurfaceGeneration)) : err(listed.error);
        }),
    },
  };
}

/**
 * One generation run, renamed for the transport (F07-AC5, N04-AC3).
 *
 * A projection: the recorded run's own fields travel, with the capability profile carried
 * whole. The four `may*` flags are typed as literal `false` in the port, so a client that read
 * them as anything else would not compile - which is the point, because "this pass could publish
 * a ticket" is a statement about the run and not something a renderer should decide.
 */
function toSurfaceGeneration(run: GenerationRunView): SurfaceGenerationRun {
  return {
    generationId: run.generationId,
    pass: run.pass,
    ideaId: run.ideaId,
    state: run.state,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    connectorId: run.connectorId,
    engineVersion: run.engineVersion,
    sessionId: run.sessionId,
    brief:
      run.brief === null
        ? null
        : {
            briefId: run.brief.briefId,
            version: run.brief.version,
            state: run.brief.state,
            authoredBy: run.brief.authoredBy,
            questionCount: run.brief.questionCount,
            rejectedCandidateCount: run.brief.rejectedCandidateCount,
          },
    plan:
      run.plan === null
        ? null
        : {
            planId: run.plan.planId,
            revision: run.plan.revision,
            taskCount: run.plan.taskCount,
            coveredOutcomeIds: [...run.plan.coveredOutcomeIds],
            splitJustifications: [...run.plan.splitJustifications],
          },
    failure:
      run.failure === null
        ? null
        : {
            code: run.failure.code,
            reason: run.failure.reason,
            fields: run.failure.fields.map((field) => ({ path: field.path, message: field.message })),
          },
    capability: {
      name: run.capability.name,
      mayChangeApplicationCode: false,
      mayPublishTickets: false,
      mayDeploy: false,
      mayStartCodingRun: false,
      forbiddenSideEffects: [...run.capability.forbiddenSideEffects],
    },
  };
}

/**
 * The candidate the run's work item currently offers, for a decision keyed by run (F25-AC1).
 *
 * The transport names a run because that is what the owner clicked, and the acceptance use
 * cases name a candidate because that is what an acceptance is bound to. Resolving the one
 * from the other here is the single translation, so a decision cannot be recorded against a
 * candidate the run does not offer (F25-AC3).
 */
async function candidateForRun(
  root: CompositionRoot,
  jobId: JobId,
): Promise<Result<CandidateRecord, DomainError>> {
  const run = await root.jobUseCases.getRun(jobId);
  if (!run.ok) return err(run.error);
  return currentCandidateFor(root, run.value.job.workItemId);
}

/**
 * The owner-test use cases over this root (F23-AC1, F25-AC1).
 *
 * Built on demand rather than held on the root, because the journal that files the verdict and
 * its attribution needs the root's own database handle, and the root is what the surface was
 * resolved from. The composition root is not extended here: this is the one writer that needs a
 * transaction spanning two tables, so it is assembled where the handle already exists.
 */
let ownerObservationCache: { readonly root: CompositionRoot; readonly useCases: OwnerObservationUseCases } | null = null;

function ownerObservationUseCases(root: CompositionRoot): OwnerObservationUseCases {
  if (ownerObservationCache?.root === root) return ownerObservationCache.useCases;
  const evidence = new SqliteObservationJournal(root.database);
  const useCases = createOwnerObservationUseCases({
    clock: controllerClock(),
    candidates: root.candidates,
    workItems: { get: (id) => root.workItems.get(id) },
    scope: { latestScopeSnapshot: (id) => root.workItems.latestScopeSnapshot(id) },
    evidence,
    observations: new SqliteOwnerObservationJournal(root.database, evidence),
  });
  ownerObservationCache = { root, useCases };
  return useCases;
}

/** One recorded observation, renamed for the transport and narrowed to text (F23-AC5). */
function toSurfaceOwnerObservation(record: OwnerObservationRecord): SurfaceOwnerObservation {
  return {
    evidenceId: String(record.evidenceId),
    criterionId: record.criterionId,
    methodKind: record.methodKind,
    status: String(record.status),
    failureKind: record.failureKind,
    observedBy: String(record.observedBy),
    observedAt: record.observedAt,
    environment: String(record.environment),
    component: record.component,
    deploymentId: record.deploymentId,
    evidenceKind: record.evidenceKind,
    evidenceRef: record.evidenceRef,
    detail: record.detail,
    candidateId: String(record.candidateId),
    candidateFingerprint: String(record.candidateFingerprint),
    scopeFingerprint: String(record.scopeFingerprint),
    correlationId: record.correlationId,
  };
}

/**
 * The correlation identity a decision is recorded under (F25-AC2).
 *
 * The run's own correlation identity rather than a value from the request body, so a
 * decision can be traced back to the run it was made about and two runs cannot have their
 * feedback attributed to each other.
 */
function correlationOf(jobId: JobId): string {
  return `acceptance:${String(jobId)}`;
}

/**
 * A start, with the transport's validated text narrowed to the identities the use case takes.
 *
 * Both brands record a boundary the store checks rather than one assumed here: the `jobs` row
 * declares both columns, and the queue refuses a start whose work item does not exist
 * (F13-AC1, F13-AC5).
 */
function startRunWith(
  useCases: JobUseCases,
  command: {
    readonly workItemId: string;
    readonly mode: JobMode;
    readonly operationId: string;
    readonly correlationId: string | null;
    readonly scope: SurfaceRunScopeInput;
    readonly readiness: SurfaceReadinessInput;
    readonly at: string;
    readonly actor: OwnerId;
  },
): ReturnType<JobUseCases['startRun']> {
  return useCases.startRun({
    workItemId: command.workItemId as WorkItemId,
    mode: command.mode,
    operationId: command.operationId as OperationId,
    ownerId: command.actor,
    readiness: toSurfaceReadiness({ readiness: command.readiness, workItemId: command.workItemId, at: command.at }),
    scope: toSurfaceScope({ scope: command.scope, workItemId: command.workItemId, at: command.at }),
    correlationId: command.correlationId,
  });
}

/** The recorded runs, in the queue's own order, with the project each belongs to (F13-AC1). */
function listRecordedRuns(root: CompositionRoot): Result<readonly JobRecord[], DomainError> {
  const query: JobQuery = { states: null, projectId: null };
  return root.jobs.listJobs(query);
}

/**
 * The project the most recently recorded run belongs to (F31-AC2).
 *
 * Read from the queue's own ordering rather than from a sort written here, and null when
 * nothing is recorded: a board scoped to a guessed project would show an empty list that
 * reads as "nothing needs you" for a project that was never looked at.
 */
function recordedProjectOf(root: CompositionRoot): Result<string | null, DomainError> {
  const listed = listRecordedRuns(root);
  if (!listed.ok) return err(listed.error);
  const newest = listed.value[listed.value.length - 1];
  return ok(newest === undefined ? null : String(newest.projectId));
}

/**
 * The candidate the work item currently offers (F24-AC4).
 *
 * The last recorded candidate, which is the same rule the verification use case applies
 * internally. A candidate that turns out not to be current is refused by that use case, so
 * choosing it here cannot widen what a card shows: the worst case is a refusal naming both
 * identities, never a card for the wrong candidate.
 */
async function currentCandidateFor(
  root: CompositionRoot,
  workItemId: string,
): Promise<Result<CandidateRecord, DomainError>> {
  const listed = root.candidates.listForWorkItem(workItemId as WorkItemId);
  if (!listed.ok) return err(listed.error);
  const current = listed.value[listed.value.length - 1];
  if (current === undefined) {
    return err({
      code: 'NotFound',
      reason: `Work item ${workItemId} has recorded no candidate yet, so there is nothing for a review card to describe (F24-AC2).`,
    });
  }
  return ok(current);
}

function toSurfaceReviewCard(card: ReviewCard): SurfaceReviewCard {
  return {
    candidateFingerprint: card.candidateFingerprint,
    headSha: card.headSha,
    baseSha: card.baseSha,
    scopeFingerprint: card.scopeFingerprint,
    scopeRevision: card.scopeRevision,
    collectedAt: card.collectedAt,
    checks: card.checks.map((check) => ({ ...check, origin: check.origin === null ? null : String(check.origin) })),
    // The criterion's verification identity travels with the criterion: a card that reports a
    // verdict without naming what produced it would let any check above it read as the
    // verification (F23-AC1).
    criteria: card.criteria.map((criterion) => ({ ...criterion })),
    pendingOwnerTestCriterionIds: [...card.pendingOwnerTestCriterionIds],
    readyForOwnerTest: card.readyForOwnerTest,
    notReady: [...card.notReady],
  };
}
/**
 * A surface bound to a root that already exists.
 *
 * What a test, a worker or any in-process caller uses: the root is the same object
 * the use cases were built from, so there is nothing to resolve and nothing to
 * cache.
 */
export function bindControllerSurface(root: CompositionRoot): ControllerSurface {
  return createControllerSurface(() => ok(root));
}

/** The environment variable naming the durable store this process serves. */
export const DATABASE_PATH_ENV = 'SHIPLOOP_DATABASE_PATH';

/** The environment variable naming the idle session limit this process enforces. */
export const SESSION_IDLE_TIMEOUT_ENV = 'SHIPLOOP_SESSION_IDLE_SECONDS';

/**
 * The environment variable naming the directory intake attachments are written under.
 *
 * The same variable `apps/web` reads for its static artifact mount, because the row
 * an attachment records stores a path relative to that one root; two variables would
 * mean two roots and a pointer that resolves to neither (F06-AC1).
 */
export const ARTIFACT_ROOT_ENV = 'SHIPLOOP_ARTIFACT_ROOT';

/**
 * The environment variable naming the read-only checkout brief and plan generation run in.
 *
 * Required by a generation and absent from a process that does no generation, for the same reason
 * `SHIPLOOP_ARTIFACT_ROOT` is: the directory is a fact about the deployment, and a pass that ran
 * somewhere this configuration did not name would put an uninspected path into the prompt and into
 * the record (F07-AC4).
 */
export const GENERATION_WORKSPACE_ENV = 'SHIPLOOP_GENERATION_WORKSPACE';

/**
 * Reads the head of the configured checkout, through the shipped `git` transport.
 *
 * The SHAs are read rather than assumed, because the two fields this produces are the engine's
 * whole claim about which code it may read, and a generated constant would be a fabricated commit
 * in every generation record (F07-AC4). `base` equals `head` and that is stated rather than
 * hidden: a read-only pass branches from nothing, so the commit it read at is also the base it
 * started from.
 */
async function readCheckoutHead(
  directory: string,
  at: string,
): Promise<Result<{ readonly headSha: string; readonly baseSha: string }, DomainError>> {
  const transport = createGitTransport(directory);
  const outcome = await transport.run(
    {
      correlationId: 'generation-workspace',
      operationId: 'generation-workspace' as OperationId,
      clock: { now: (): string => at, elapsedMs: (): number => 0 },
      logger: { emit: () => undefined },
      signal: new AbortController().signal,
      redact: (text: string): string => redact(text).text,
    },
    ['rev-parse', 'HEAD'],
  );
  if (!outcome.ok) return err(outcome.error);
  const head = outcome.value.stdout.trim();
  if (outcome.value.exitCode !== 0 || !isCommitSha(head)) {
    return err(
      blocked(
        `${GENERATION_WORKSPACE_ENV} does not name a checkout ShipLoop can read: "git rev-parse HEAD" did not report a commit (F07-AC4).`,
        [
          {
            name: 'generation workspace',
            detail: 'A read-only pass records the commit it read at, so the configured directory must be a git checkout at a full commit.',
            remedy: `Point ${GENERATION_WORKSPACE_ENV} at a git checkout with one commit in it, then ask again (F03-AC1).`,
          },
        ],
      ),
    );
  }
  return ok({ headSha: head, baseSha: head });
}

/**
 * The workspace reader this process serves, or null when it configured none.
 *
 * `fingerprint` records what the pass was scoped to, from the run's own identity, so two runs
 * never claim the same scope even when they read the same checkout (F02-AC2).
 */
export function generationWorkspaceReader(directory: string | null): GenerationWorkspaceReader | null {
  if (directory === null) return null;
  return async (input) => {
    const head = await readCheckoutHead(directory, input.at);
    if (!head.ok) return err(head.error);
    return ok({
      workspaceId: `ws_generation_${input.generationId}`,
      absolutePath: directory,
      headSha: head.value.headSha as CommitSha,
      baseSha: head.value.baseSha as CommitSha,
      environmentFingerprint: fingerprint({ generation: input.pass, at: input.at }),
      scopeFingerprint: fingerprint({ generation: input.generationId }),
      isolatedPorts: {},
      serviceEndpoints: [],
      testAccess: { kind: 'None' },
    });
  };
}

const SYSTEM_CLOCK: ControllerClock = { now: () => new Date().toISOString() };

/** The same clock the root records writes with, so one process has one time source. */
function controllerClock(): ControllerClock {
  return SYSTEM_CLOCK;
}

/**
 * Home's two durable reads, over the same stores the review card reads.
 *
 * Both methods are reads of rows that already exist, and neither can reach a provider: the
 * candidate repository and the review store are SQLite handles, and the projection is the
 * M0-certified `buildMvpReviewReadModel` reached through `readFacts` — the same assembly the card
 * performs, so the board and the card cannot disagree about a candidate (F23-AC1, F24-AC3).
 *
 * `readFacts` is reached with only the durable members of `MvpReviewCardDeps`, which is the
 * mechanical reason a provider call is impossible here rather than merely absent: there is no
 * live-candidate reader in the object it is given.
 */
function homeReadsFor(root: CompositionRoot): SurfaceHomeReads {
  const candidateStore = new DeliveryCandidateRepository(root.database);
  const deps: MvpReviewCardDeps = {
    // The card's clock is the controller clock; the root does not carry its own. Home reads no
    // instant of its own, so this is only here because the deps shape requires it.
    clock: controllerClock(),
    requests: root.requests,
    contracts: root.contracts,
    candidates: candidateStore,
    review: new SqliteMvpReviewStore(root.database),
    // Read from the project's own saved profile, which is where the certified policy comes from.
    // Absent rather than defaulted: a project with no profile has declared no required gate, and
    // the read then answers the shipped default rather than inventing a list (F20-AC5).
    requiredCheckIds: (projectId) => {
      const current = root.profiles.currentVersion(projectId);
      return current.ok
        ? ok(current.value?.content.policy.requiredChecks ?? [])
        : err(current.error);
    },
  };

  return {
    recordedCandidate: async ({ projectId, requestId }) => {
      const current = candidateStore.currentForRequest(requestId);
      if (!current.ok) return current;
      // Scoped like every other read: a candidate belonging to another project is invisible
      // through this project's session rather than merely absent (F02-AC2).
      const found = current.value;
      if (found !== null && String(found.projectId) !== projectId) return ok(null);
      // Narrowed through the candidate module's own projection rather than returned as the stored
      // row, so Home's `provider` is the domain literal and not the column's text (F24-AC2).
      return ok(found === null ? null : toDeliveryCandidate(found));
    },

    reviewReadModel: async ({ projectId, candidateId }) => {
      const facts = readFacts(deps, { projectId, candidateId });
      if (!facts.ok) return facts;
      const candidate = facts.value.candidate;
      // The card's own read is addressed by candidate; this one is addressed the same way, and
      // passes the recorded commit because that is the commit the stored evidence was bound to.
      // Nothing here re-judges currency - `buildMvpReviewReadModel` does (F24-AC4).
      const model = await root.mvpReviewUseCases.review({
        projectId,
        requestId: candidate.requestId,
        candidateId,
        expectedHeadSha: candidate.headSha,
        expectedContractRevision: candidate.contractRevision,
        facts: facts.value.facts,
      });
      return model;
    },
  };
}

/**
 * Builds the root this process serves from the environment.
 *
 * The database path is required and has no default: silently opening a file the
 * operator did not name is how a process ends up serving a different store than
 * the one that was backed up (F01-AC1). The idle limit falls back to the domain
 * default, which is a deliberate published value rather than an absence.
 */
export function resolveSurfaceRoot(env: NodeJS.ProcessEnv): Result<CompositionRoot, DomainError> {
  const databasePath = env[DATABASE_PATH_ENV];
  if (databasePath === undefined || databasePath === '') {
    return err({
      code: 'Unavailable',
      reason: `${DATABASE_PATH_ENV} must name the SQLite file this process serves; there is no default store to fall back on (F01-AC1).`,
    });
  }
  const providers = readProviderConfiguration(env);
  if (!providers.ok) return providers;
  const registry = createProviderRegistry(providers.value);
  if (!registry.ok) return registry;
  const workspace = generationWorkspaceReader(
    env[GENERATION_WORKSPACE_ENV] === undefined || env[GENERATION_WORKSPACE_ENV] === ''
      ? null
      : env[GENERATION_WORKSPACE_ENV],
  );
  return createCompositionRoot({
    databasePath,
    clock: SYSTEM_CLOCK,
    adapters: registry.value.adapters,
    // The whole registry, not just its declarations: generation reaches the configured engine
    // through it, and publication and adoption reach the configured providers. Passing only
    // `adapters` would leave a process whose configuration parsed a registry the composition
    // could not see, which is how a configured capability ends up unreachable (F03-AC1).
    providers: registry.value,
    sessionIdleTimeoutSeconds: readPositiveInteger(env[SESSION_IDLE_TIMEOUT_ENV]),
    artifactRoot: env[ARTIFACT_ROOT_ENV] === undefined || env[ARTIFACT_ROOT_ENV] === '' ? null : env[ARTIFACT_ROOT_ENV],
    /**
     * The operator's external deployment, passed through unvalidated.
     *
     * This is where an environment becomes configuration, so `T3_URL_ENV_VAR` is read here
     * and nowhere else, and the value crosses this boundary as a string the handoff use case
     * validates with `parseT3LaunchUrl` - the single implementation of what a usable T3 URL
     * is. It is the `resolveT3Launch(process.env)` fallback the MVP specifies, and it is read
     * at composition rather than inside the request so a test can state the value instead of
     * mutating ambient state.
     *
     * Only "absent" is normalised here. A blank string is passed through, because deciding
     * that a configured-but-blank value is absent rather than unusable is the use case's
     * rule and duplicating it in two places would let the two disagree (mvp-spec L02-AC3).
     *
     * Precedence, unresolved here: another slice stores an optional T3 launch URL per
     * project, and a stored project setting should win over this environment default. That
     * table is not reachable from this branch, so this value is used and the question is
     * recorded rather than guessed at.
     */
    t3Url: env[T3_URL_ENV_VAR] === undefined ? null : env[T3_URL_ENV_VAR],
    ...(workspace === null ? {} : { generationWorkspace: workspace }),
  });
}

function readPositiveInteger(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_IDLE_TIMEOUT_SECONDS;
  if (!/^\d+$/.test(raw)) return DEFAULT_IDLE_TIMEOUT_SECONDS;
  const value = Number(raw);
  return value > 0 ? value : DEFAULT_IDLE_TIMEOUT_SECONDS;
}

/**
 * A surface that opens its store on first use, and keeps it.
 *
 * The transport loads this module and checks the loaded value structurally, so a
 * value has to exist before anything has been asked of it. Reading the environment
 * and opening a database at import time would make importing this module an
 * action, so the root is built on the first call instead and reused afterwards. A
 * refusal is returned to the caller rather than thrown, because the caller's
 * contract is a typed `Result` and a library that exits the process is not
 * honouring it.
 */
function createDeferredSurface(): ControllerSurface {
  let root: Result<CompositionRoot, DomainError> | null = null;
  return createControllerSurface(() => {
    root ??= resolveSurfaceRoot(process.env);
    return root;
  });
}

/**
 * The surface `apps/web` loads as `@shiploop/controller`.
 *
 * A default export because the transport accepts either a default or the module
 * namespace, and the namespace already carries the named exports every other caller
 * uses; adding `owners`, `sessions`, `profiles` and `connectors` to it would put
 * four vague names in the package's front door.
 */
const controllerSurface: ControllerSurface = createDeferredSurface();

export default controllerSurface;
