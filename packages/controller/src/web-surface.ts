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

import { DEFAULT_IDLE_TIMEOUT_SECONDS, capabilitiesFor, err, ok } from '@shiploop/domain';
import type {
  AttentionBucket,
  AttentionItem,
  AttentionItemId,
  AttentionKind,
  AttentionState,
  AreaObservation,
  AttemptLimits,
  AttemptState,
  CapabilityDeclaration,
  CapabilityKind,
  CandidateId,
  ConnectorId,
  DomainError,
  IdeaId,
  JobId,
  OperationId,
  OwnerId,
  ProfileVersionId,
  ProjectId,
  ReadinessObservation,
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
  IdeaExport,
  JobCheckpoint,
  JobLimits,
  JobMode,
  JobOperation,
  JobRecord,
  JobQuery,
} from '@shiploop/storage';
import type { CompositionRoot } from './composition.ts';
import { createCompositionRoot } from './composition.ts';
import type { IdeaDraft } from '@shiploop/domain';
import type { ControllerClock, OwnerActor } from './profiles.ts';
import type { StoredSessionRecord } from './sessions.ts';
import type { AdapterRegistry, ConnectorProbe } from './connectors.ts';
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

export interface SurfaceOwner {
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly createdAt: string;
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

/** The whole injected surface. One argument, so a missing use case is a type error. */
export interface ControllerSurface {
  readonly owners: SurfaceOwnerUseCases;
  readonly sessions: SurfaceSessionUseCases;
  readonly profiles: SurfaceProfileUseCases;
  readonly connectors: SurfaceConnectorUseCases;
  readonly intake: SurfaceIntakeUseCases;
  readonly runs: SurfaceRunUseCases;
  readonly attention: SurfaceAttentionUseCases;
  readonly reviewCards: SurfaceReviewCardUseCases;
  readonly acceptance: SurfaceAcceptanceUseCases;
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

function toSurfaceSession(record: StoredSessionRecord): SurfaceStoredSession {
  return { ...record };
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
            createdAt: provisioned.value.provisionedAt,
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
 * No provider adapter is configured in this slice.
 *
 * Declaring no capabilities is the honest state: `saveProfile` then refuses any
 * profile needing one, naming the missing adapter, instead of accepting a profile
 * whose delivery would later fail against a provider nobody has implemented
 * (F03-AC2, N05-AC1). Wiring a test double here would make the product claim a
 * capability it does not have.
 */
const NO_ADAPTERS: AdapterRegistry = {
  declarationsFor(): readonly CapabilityDeclaration[] {
    return [];
  },
  probeFor(): ConnectorProbe | null {
    return null;
  },
};

const SYSTEM_CLOCK: ControllerClock = { now: () => new Date().toISOString() };

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
  return createCompositionRoot({
    databasePath,
    clock: SYSTEM_CLOCK,
    adapters: NO_ADAPTERS,
    sessionIdleTimeoutSeconds: readPositiveInteger(env[SESSION_IDLE_TIMEOUT_ENV]),
    artifactRoot: env[ARTIFACT_ROOT_ENV] === undefined || env[ARTIFACT_ROOT_ENV] === '' ? null : env[ARTIFACT_ROOT_ENV],
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
