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

import { DEFAULT_IDLE_TIMEOUT_SECONDS, capabilitiesFor, err, invalid, ok, orderedAreas, planReadiness, publishableTickets } from '@shiploop/domain';
import type {
  CapabilityDeclaration,
  CapabilityKind,
  CandidateId,
  ChangeShape,
  ChangeSurface,
  ConnectorId,
  DomainError,
  Fingerprint,
  IdeaId,
  OwnerId,
  Plan,
  PlanEdit,
  PlanProposal,
  PlanTaskContentField,
  PlanTaskPatch,
  ProfileVersionId,
  ProjectId,
  PublishableTicket,
  Result,
  WorkItemId,
} from '@shiploop/domain';
import type { ConnectorKind, ConnectorRecord, ConnectorState, IdeaExport } from '@shiploop/storage';
import type { GitRepositoryRef, TicketState } from '@shiploop/adapters';
import type { CompositionRoot } from './composition.ts';
import { createCompositionRoot, taskWorkItemId } from './composition.ts';
import type { IdeaDraft } from '@shiploop/domain';
import type { ControllerClock, OwnerActor } from './profiles.ts';
import type { StoredSessionRecord } from './sessions.ts';
import type { AdapterRegistry, ConnectorProbe } from './connectors.ts';
import { PLAN_TASK_CONTENT_FIELDS } from '@shiploop/domain';
import { blocked } from '@shiploop/domain';
import type { ReconciliationOutcome, TicketPublication, TicketToPublish } from './publication.ts';
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

/** The whole injected surface. One argument, so a missing use case is a type error. */
export interface ControllerSurface {
  readonly owners: SurfaceOwnerUseCases;
  readonly sessions: SurfaceSessionUseCases;
  readonly profiles: SurfaceProfileUseCases;
  readonly connectors: SurfaceConnectorUseCases;
  readonly intake: SurfaceIntakeUseCases;
  readonly planning: SurfacePlanningUseCases;
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

/** The same clock the root records writes with, so one process has one time source. */
function controllerClock(): ControllerClock {
  return SYSTEM_CLOCK;
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
