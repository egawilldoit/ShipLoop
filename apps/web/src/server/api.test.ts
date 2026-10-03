/**
 * HTTP boundary tests for the owner API.
 *
 * Every request here goes through `app.inject()`, which is a real HTTP round trip
 * through the plugin, hook, guard and error-handling stack the browser will hit;
 * nothing is stubbed below the socket. What *is* substituted is the controller, and
 * that substitution is deliberate: `packages/controller` is developed independently
 * of this server, so these tests bind the `contracts.ts` ports to a small in-memory
 * store and prove the transport against it. The parts that are not substituted are the
 * ones under test — cookie flags, the session gate, CSRF, validation, security
 * headers, cache control and the error-to-status mapping — together with the real
 * domain functions the fake also uses (`hashPassword`, `verifyPassword`,
 * `sessionDeadlines`, `capabilitiesFor`, `fingerprint`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MINIMUM_PASSWORD_LENGTH,
  SESSION_COOKIE_NAME,
  blocked,
  canTransition,
  capabilitiesFor,
  conflict,
  fingerprint,
  hashPassword,
  hashSessionToken,
  invalid,
  ok,
  outcomeUnknown,
  sessionDeadlines,
  verifyPassword,
  type AttentionItemId,
  type CapabilityDeclaration,
  type CapabilityKind,
  type ConnectorId,
  type DomainError,
  type IdeaId,
  type JobId,
  type JobMode,
  type OwnerId,
  type ProfileVersionId,
  type ProjectId,
  type Result,
} from '@shiploop/domain';
import type { JobOperation } from '@shiploop/storage';
import type { FastifyInstance } from 'fastify';
// The real launch-URL rule, so a route test cannot pass against a validation this double
// invented (L02-AC2).
import { validateT3Setting } from '@shiploop/controller';
import { buildApp } from './app.ts';
import { CSRF_HEADER } from './auth-guard.ts';
import { describeConfigErrors, readServerConfig, type ServerConfig } from './config.ts';
import {
  isControllerSurface,
  type ActiveProjectView,
  type AttentionBoardView,
  type AttentionItemView,
  type BriefVersionView,
  type ClarificationRoundView,
  type ClarifyingQuestionView,
  type ConnectorView,
  type ContractCriterionView,
  type ContractStaleReason,
  type ContractView,
  type ControllerSurface,
  type CorrectionView,
  type CreateSessionCommand,
  type DecideExtensionCommand,
  type DispositionCommand,
  type IdeaExportView,
  type IntakeDetailView,
  type IntakeIdeaView,
  type AdoptedEvaluationView,
  type AdoptedIssueView,
  type CaptureIdeaCommand,
  type DraftPlanCommand,
  type EditPlanCommand,
  type LinkedChangeView,
  type OwnerView,
  type OwnerObservationReportView,
  type OwnerObservationTarget,
  type OwnerObservationView,
  type CancelledRunView,
  type DeclinedExtensionView,
  type GrantedExtensionView,
  type HandoffView,
  type PausedRunView,
  type PlanTaskView,
  type PlanView,
  type PublicationReportView,
  type ReadinessAssessmentView,
  type ResumedRunView,
  type ProfileContent,
  type ProfileVersionView,
  type ProjectSettingsView,
  type ProvisionOwnerCommand,
  type ProjectView,
  type RegisterConnectorCommand,
  type RelatednessReportView,
  type RelatedWorkChoiceView,
  type RequestDetailView,
  type RequestView,
  type ReviewCardView,
  type RevokeConnectorCommand,
  type RevokeSessionCommand,
  type AttentionBucket,
  type AcceptanceGateView,
  type AcceptanceReportView,
  type AcceptanceView,
  type ChangeRequestReportView,
  type RunCheckpointView,
  type RunJobView,
  type GenerationRunView,
  type RunStartView,
  type RunView,
  type RunWriterView,
  type SaveProfileVersionCommand,
  type SignInCommand,
  type SignInGrant,
  type StartRunCommand,
  type StoredSessionRecord,
  type T3LaunchSettingView,
  type TouchSessionCommand,
} from './contracts.ts';

/**
 * The permissions each mode holds, as the storage vocabulary names them.
 *
 * The same table the queue enforces, so a route test that starts a Build run and reads the
 * grant back is reading the shape a real Build run carries (F13-AC3).
 */
const MODE_OPERATIONS: Readonly<Record<JobMode, readonly JobOperation[]>> = {
  Plan: ['ReadScope', 'ReadRepository', 'PublishIssue', 'UpdateManagedProgress', 'CreateDraft', 'UpdateDraft'],
  Investigate: ['ReadScope', 'ReadRepository', 'ReadChecks'],
  Build: ['ReadScope', 'ReadRepository', 'ReadChecks', 'PushBranch', 'CreateDraft', 'UpdateDraft', 'RunChecks', 'CollectEvidence'],
  Test: ['ReadScope', 'ReadRepository', 'ReadChecks', 'RunChecks', 'CollectEvidence'],
  Review: ['ReadScope', 'ReadRepository', 'ReadChecks', 'CollectEvidence'],
};

const READINESS_AREAS = ['scope', 'criteria', 'repository', 'target', 'verification', 'access'] as const;

/** The domain's own area names, because a refusal quotes them and a synonym would disagree. */
const READINESS_AREA_NAMES: Readonly<Record<(typeof READINESS_AREAS)[number], string>> = {
  scope: 'Scope',
  criteria: 'Criteria',
  repository: 'Repository',
  target: 'Target',
  verification: 'Verification',
  access: 'Access',
};

/**
 * The states each attempt state can reach, restated from the domain's own table.
 *
 * Named only so a refusal can say what was reachable, and checked against
 * `canTransition` on every use rather than trusted: a table that drifted from the domain
 * would make an illegal move look legal in a message and nothing else (F17-AC1).
 */
const REACHABLE_FROM: Readonly<Record<string, readonly string[]>> = {
  Queued: ['Preparing', 'Cancelled', 'Blocked'],
  Preparing: ['Running', 'Blocked', 'Paused', 'Cancelled', 'Queued'],
  Running: ['Verifying', 'WaitingForOwner', 'Paused', 'Blocked', 'Completed', 'Cancelled'],
  Verifying: ['WaitingForOwner', 'Completed', 'Blocked', 'Paused', 'Cancelled'],
  WaitingForOwner: ['Running', 'Verifying', 'Completed', 'Paused', 'Cancelled', 'Blocked'],
  Paused: ['Running', 'Preparing', 'Cancelled', 'Blocked'],
  Blocked: ['Preparing', 'Queued', 'Cancelled'],
  Completed: ['Verifying', 'WaitingForOwner'],
  Cancelled: [],
};

function unreachableFrom(state: string, to: string): string {
  const reachable = (REACHABLE_FROM[state] ?? []).filter((candidate) => canTransition('attempt', state, candidate));
  const legal = canTransition('attempt', state, to);
  assert.equal(legal, reachable.includes(to), `the transcribed table for ${state} must agree with the domain's own`);
  return reachable.length === 0 ? `From ${state} nothing is reachable; it is terminal.` : `From ${state} the reachable states are: ${reachable.join(', ')}.`;
}

const ATTENTION_BUCKETS: readonly AttentionBucket[] = [
  'Working',
  'NeedsYourInput',
  'ReadyForYourTest',
  'ReadyForRelease',
];

const ATTENTION_BUCKET_OF: Readonly<Record<string, AttentionBucket>> = {
  RunProgress: 'Working',
  ClarificationRequested: 'NeedsYourInput',
  Blocker: 'NeedsYourInput',
  ReadyForYourTest: 'ReadyForYourTest',
  DeliveryDecision: 'ReadyForRelease',
};

/**
 * The status each reported observation produces, and how it failed to be a pass (F23-AC5).
 *
 * A capture failure is `Missing` and a behaviour failure is `Failed`, so the two are different
 * outcomes rather than one failure; `failureKind` is what tells them apart without reading the
 * detail prose.
 */
const STATUS_FOR_OBSERVATION: Readonly<Record<'BehaviorConfirmed' | 'BehaviorFailed' | 'CaptureFailed', string>> = {
  BehaviorConfirmed: 'Verified',
  BehaviorFailed: 'Failed',
  CaptureFailed: 'Missing',
};

const FAILURE_KIND_FOR_OBSERVATION: Readonly<
  Record<'BehaviorConfirmed' | 'BehaviorFailed' | 'CaptureFailed', 'BehaviorFailure' | 'CaptureFailure' | null>
> = {
  BehaviorConfirmed: null,
  BehaviorFailed: 'BehaviorFailure',
  CaptureFailed: 'CaptureFailure',
};

const CSRF_SECRET = ['server', 'secret', 'material', '0123456789abcdef'].join('-');
const START = '2026-03-01T12:00:00.000Z';
const OWNER_ID = 'own_1' as OwnerId;
const OWNER_NAME = 'Octopus Owner';
const OWNER_PASSWORD = 'correct horse battery staple';
const PROJECT_ID = 'octopus-main';
const REPOSITORY = 'github.com/octopus/octopus-web';
const TEAM_KEY = 'OCT';
const CREDENTIAL_REFERENCE = 'credentials/linear/octopus-main';
/** A value that must never appear in any response body (F03-AC3, N02-AC2). */
const SEEDED_SECRET = ['lin', 'api', 'secret', '0123456789abcdef0123'].join('_');

const LINEAR_CAPABILITIES: readonly CapabilityDeclaration[] = [
  { kind: 'Ticket:ReadScope', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  { kind: 'Ticket:PublishIssue', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  { kind: 'Git:MergeWithPrecondition', supported: false, limitation: 'Linear cannot merge code.', privileged: true, supportsPrecondition: false },
];

const GIT_CAPABILITIES: readonly CapabilityDeclaration[] = [
  { kind: 'Git:ReadRepository', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  { kind: 'Git:CreateDraft', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  { kind: 'Git:MergeWithPrecondition', supported: true, limitation: null, privileged: true, supportsPrecondition: true },
];

const ADAPTER_CAPABILITIES: CapabilityDeclarationsByProvider = {
  linear: LINEAR_CAPABILITIES,
  github: GIT_CAPABILITIES,
};

/** The capability declarations a fake adapter reports for a provider. */
type CapabilityDeclarationsByProvider = Readonly<Record<string, readonly CapabilityDeclaration[]>>;

interface ErrorPayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly fields?: readonly { readonly path: string; readonly message: string }[];
    readonly prerequisites?: readonly {
      readonly name: string;
      readonly detail: string;
      readonly remedy: string;
    }[];
    readonly expected?: string;
    readonly actual?: string;
    readonly operationId?: string;
    readonly target?: string;
  };
  readonly signInRequired?: boolean;
}

/**
 * What the session and sign-in routes answer with (F01-AC1, F02-AC1).
 *
 * `owner` is the full `OwnerView` rather than the two fields these tests used to read,
 * because the point of the assertions below is that the whole identity travels: the address
 * (read, not re-derived) and the selected project (a real state, not a fabricated id).
 */
interface OwnerPayload {
  readonly owner: OwnerView;
  readonly session: { readonly sessionId: string; readonly issuedAt: string; readonly expiresAt: string };
  readonly csrfToken: string;
}

interface ProfilePayload {
  readonly profile: ProfileVersionView;
}

interface ConnectorPayload {
  readonly connector: ConnectorView;
}

interface PlanPayload {
  readonly plan: PlanView;
}

interface ConnectorListPayload {
  readonly connectors: readonly ConnectorView[];
}

interface ProfileListPayload {
  readonly profiles: readonly ProfileVersionView[];
}

function createClock(start: string): { now: () => Date; advance: (seconds: number) => void } {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance: (seconds: number) => {
      current += seconds * 1000;
    },
  };
}

function testConfig(overrides: Record<string, string> = {}): ServerConfig {
  const result = readServerConfig({
    SHIPLOOP_NODE_ENV: 'test',
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_LOG_LEVEL: 'silent',
    ...overrides,
  });
  if (!result.ok) throw new Error(`Test configuration is invalid: ${JSON.stringify(result.errors)}`);
  return result.value;
}

/**
 * In-memory controller.
 *
 * Real hashing, real deadlines and real capability splitting, in maps instead of
 * SQLite. It refuses the same things the real ports must refuse: a stale profile save
 * conflicts, a revoked connector blocks the operations that depend on it, and a
 * sign-in failure is answered without saying which half of the credential was wrong.
 */
/**
 * A refusal that names the use case this double does not implement.
 *
 * Typed rather than thrown, because the port's contract is a `Result` and a double
 * that broke it would turn a coverage gap into a 500 instead of a stated fact.
 */
function notImplemented<T>(useCase: string): Promise<Result<T, DomainError>> {
  return Promise.resolve({
    ok: false,
    error: { code: 'Unavailable', reason: `The HTTP boundary double does not implement ${useCase}.` },
  });
}

class InMemoryController implements ControllerSurface {
  private readonly sessionsById = new Map<string, StoredSessionRecord>();
  private readonly sessionIdByDigest = new Map<string, string>();
  private readonly profileVersions = new Map<string, ProfileVersionView[]>();
  private readonly connectorRecords = new Map<string, ConnectorView>();
  private readonly intakeIdeas = new Map<string, IntakeIdeaView>();
  private readonly plans = new Map<string, PlanView>();
  private readonly capabilities: CapabilityDeclarationsByProvider;
  private readonly projectRecords = new Map<string, ProjectView>();
  private passwordHash = '';
  /** The address provisioning recorded, read back by `describe` (F01-AC1). */
  private ownerEmail: string | null = null;
  /** The owner's creation instant, recorded by the same write that recorded the address. */
  private ownerCreatedAt = '';
  /** The project this owner has selected, or null when none is selected (F02-AC1). */
  private activeProjectId: string | null = null;
  /** The requests this double holds, keyed by identity (mvp-spec 3). */
  private readonly requestRecords = new Map<string, RequestView>();
  /** The contract revisions this double holds, keyed by `contractId#revision`. */
  private readonly contractRevisions = new Map<string, ContractView>();
  private contractTicks = 0;
  private readonly scripted = new Map<string, DomainError>();
  private readonly recordedRuns = new Map<string, RunJobView>();
  private readonly checkpoints = new Map<string, RunCheckpointView>();
  private readonly writers = new Map<string, RunWriterView>();
  private readonly attentionItems = new Map<string, AttentionItemView>();
  private readonly cards = new Map<string, ReviewCardView>();
  private readonly gates = new Map<string, { readonly candidateId: string; readonly gate: AcceptanceGateView }>();
  private readonly acceptanceStates = new Map<string, AcceptanceView>();
  private readonly feedback: { readonly decisionId: string; readonly feedback: string }[] = [];
  private readonly ownerObservations = new Map<string, OwnerObservationView[]>();
  /** The optional per-project settings, including the T3 launch target (L02-AC2). */
  private readonly projectSettings = new Map<string, { readonly t3: T3LaunchSettingView; readonly updatedAt: string }>();

  constructor(
    _now: () => Date,
    capabilities: CapabilityDeclarationsByProvider,
    provisionOwner: boolean,
  ) {
    this.capabilities = capabilities;
    if (provisionOwner) {
      const hashed = hashPassword(OWNER_PASSWORD);
      if (!hashed.ok) throw new Error('The test owner password must satisfy the domain policy.');
      this.passwordHash = hashed.value;
    }
  }

  /**
   * The project state this owner is in, exactly as the controller reports it (F02-AC1).
   *
   * `NoProjectSelected` carries the count the owner could choose from, so onboarding can
   * distinguish "create a project" from "choose one" rather than rendering a blank field.
   * There is deliberately no fallback: this double must not be able to answer with a project
   * nobody selected, which is the defect the union exists to make unrepresentable (F02-AC4).
   */
  private activeProjectView(): ActiveProjectView {
    if (this.activeProjectId === null) {
      return { state: 'NoProjectSelected', selectableProjectCount: this.projectRecords.size };
    }
    const selected = this.projectRecords.get(this.activeProjectId);
    if (selected === undefined) {
      // A selection naming a project this double does not hold is the state that must be
      // impossible; reporting the onboarding state is the honest answer and keeps a test from
      // passing on an identity nobody chose.
      return { state: 'NoProjectSelected', selectableProjectCount: this.projectRecords.size };
    }
    return { state: 'Selected', activeProjectId: selected.projectId, activeProjectName: selected.name };
  }

  /**
   * The address provisioning recorded, or null when it provisioned none.
   *
   * Read through a method so a route test can assert the session response carries the
   * *stored* value without reaching into the double's fields, and so the assertion fails if
   * the response is carrying something the store never held (F01-AC1).
   */
  provisionedEmail(): string | null {
    return this.ownerEmail;
  }

  /** Arms a one-shot domain error for the next call of a use case. */
  script(useCase: string, error: DomainError): void {
    this.scripted.set(useCase, error);
  }

  private takeScripted(useCase: string): DomainError | null {
    const error = this.scripted.get(useCase);
    if (error !== undefined) this.scripted.delete(useCase);
    return error ?? null;
  }

  /**
   * The intake group of this double.
   *
   * A capture and a read are real, because the file tests that no intake route is
   * registered ahead of the transport's own error handling need a controller that
   * answers the port. Every other member refuses by name: this file proves the
   * authentication boundary, not intake behaviour, and a double that quietly
   * succeeded at a use case nobody implemented would let a broken intake route read
   * as covered here.
   */
  readonly intake = {
    captureIdea: async (command: CaptureIdeaCommand): Promise<Result<IntakeIdeaView, DomainError>> => {
      const rawRequest = command.rawRequest.trim();
      if (rawRequest === '') {
        return { ok: false, error: { code: 'Invalid', reason: 'A request is required.', fields: [{ path: 'rawRequest', message: 'Required.' }] } };
      }
      const view: IntakeIdeaView = {
        ideaId: `idea_${this.intakeIdeas.size + 1}` as IdeaId,
        rawRequest,
        projectId: command.projectId,
        notes: command.notes,
        kind: command.kind,
        bugDetail: command.detail ?? { expected: null, actual: null, reproduction: null },
        attachments: [],
        summary: null,
        disposition: 'Unpublished',
        dispositionDetail: null,
        capturedAt: '2026-03-01T12:00:00.000Z',
      };
      this.intakeIdeas.set(view.ideaId, view);
      return { ok: true, value: view };
    },
    listIdeas: async (): Promise<Result<readonly IntakeIdeaView[], DomainError>> => ({
      ok: true,
      value: [...this.intakeIdeas.values()],
    }),
    getIdea: async (ideaId: IdeaId): Promise<Result<IntakeDetailView, DomainError>> => {
      const idea = this.intakeIdeas.get(ideaId);
      if (idea === undefined) return { ok: false, error: { code: 'NotFound', reason: 'No such idea.' } };
      return {
        ok: true,
        value: {
          idea,
          brief: { briefId: null, currentVersion: null, current: null, versions: [] },
          questions: [],
          rejected: [],
          turns: [{ kind: 'RawRequest', at: idea.capturedAt, text: idea.rawRequest, reference: null }],
        },
      };
    },
    attachFile: async (): Promise<Result<IntakeIdeaView, DomainError>> => notImplemented('attachFile'),
    recordSummary: async (): Promise<Result<IntakeIdeaView, DomainError>> => notImplemented('recordSummary'),
    archiveIdea: async (command: DispositionCommand): Promise<Result<IntakeIdeaView, DomainError>> => {
      const idea = this.intakeIdeas.get(command.ideaId);
      if (idea === undefined) return { ok: false, error: { code: 'NotFound', reason: 'No such idea.' } };
      const archived: IntakeIdeaView = { ...idea, disposition: 'Archived', dispositionDetail: command.reason };
      this.intakeIdeas.set(archived.ideaId, archived);
      return { ok: true, value: archived };
    },
    deferIdea: async (): Promise<Result<IntakeIdeaView, DomainError>> => notImplemented('deferIdea'),
    findRelatedWork: async (): Promise<Result<readonly RelatednessReportView[], DomainError>> => ({ ok: true, value: [] }),
    recordRelatedWorkChoice: async (): Promise<Result<RelatedWorkChoiceView, DomainError>> => notImplemented('recordRelatedWorkChoice'),
    draftBrief: async (): Promise<Result<BriefVersionView, DomainError>> => notImplemented('draftBrief'),
    agreeBrief: async (): Promise<Result<BriefVersionView, DomainError>> => notImplemented('agreeBrief'),
    askClarifyingQuestions: async (): Promise<Result<ClarificationRoundView, DomainError>> => notImplemented('askClarifyingQuestions'),
    answerClarifyingQuestion: async (): Promise<Result<ClarifyingQuestionView, DomainError>> => notImplemented('answerClarifyingQuestion'),
    applyOwnerCorrection: async (): Promise<Result<CorrectionView, DomainError>> => notImplemented('applyOwnerCorrection'),
    exportIdea: async (): Promise<Result<IdeaExportView, DomainError>> => notImplemented('exportIdea'),
  };

  /**
   * The planning group of this double.
   *
   * A draft, an edit and a publication are real, because the F10 tests assert on what
   * the transport reports per ticket and a double that refused would let a route that
   * dropped a field read as covered. The readiness assessment is a fixed record with
   * every area F09-AC1 names, so a route that rendered only the open areas would be
   * visible here; the browser suite drives the real assessment through the shipped
   * entrypoint instead.
   *
   * Adoption members refuse by name. The real adoption path needs a ticket and git
   * provider, which this double has none of, and a double that adopted something would
   * make F11-AC1 look proved when no provider read happened (F11-AC1, F03-AC2).
   */
  readonly planning = {
    draftPlan: async (command: DraftPlanCommand): Promise<Result<PlanView, DomainError>> => {
      const scripted = this.takeScripted('draftPlan');
      if (scripted !== null) return { ok: false, error: scripted };
      const proposal = command.proposal as {
        readonly briefId: string;
        readonly requestedOutcomes: readonly { readonly id: string; readonly statement: string }[];
        readonly tasks: readonly PlanTaskView[];
      };
      const plan: PlanView = {
        planId: command.planId,
        ideaId: command.ideaId,
        briefId: proposal.briefId,
        revision: 1,
        draftedAt: '2026-03-01T12:00:00.000Z',
        lastEditedAt: null,
        lastEditedBy: null,
        requestedOutcomes: proposal.requestedOutcomes.map((outcome) => ({ ...outcome })),
        exclusions: [],
        coverage: proposal.requestedOutcomes.map((outcome) => ({
          outcomeId: outcome.id,
          via: 'Task' as const,
          taskId: proposal.tasks[0]?.taskId ?? '',
        })),
        split: {
          split: true,
          reason: 'Two surfaces carry independently reviewable behaviour (F08-AC2).',
          justifications: ['IndependentlyReviewable'],
          surfacesWithoutOwnBehaviour: [],
        },
        tasks: proposal.tasks.map((task) => ({ ...task, publishable: false })),
        agreedSequence: proposal.tasks.map((task) => task.taskId),
        proposedOrder: proposal.tasks.map((task) => task.taskId),
        taskReadiness: proposal.tasks.map((task) => ({ taskId: task.taskId, ready: true, readyAfter: [], blockedBy: [] })),
        digest: 'sha256:plan',
        workItemIdByTaskId: Object.fromEntries(
          proposal.tasks.map((task) => [task.taskId, `wi_${command.planId}_${task.taskId}`]),
        ),
      };
      this.plans.set(plan.planId, plan);
      return { ok: true, value: plan };
    },
    getPlan: async (planId: string): Promise<Result<PlanView, DomainError>> => {
      const plan = this.plans.get(planId);
      if (plan === undefined) return { ok: false, error: { code: 'NotFound', reason: 'No such plan.' } };
      return { ok: true, value: plan };
    },
    listPlansForIdea: async (ideaId: string): Promise<Result<readonly PlanView[], DomainError>> => ({
      ok: true,
      value: [...this.plans.values()].filter((plan) => plan.ideaId === ideaId),
    }),
    editPlan: async (command: EditPlanCommand): Promise<Result<PlanView, DomainError>> => {
      const scripted = this.takeScripted('editPlan');
      if (scripted !== null) return { ok: false, error: scripted };
      const plan = this.plans.get(command.planId);
      if (plan === undefined) return { ok: false, error: { code: 'NotFound', reason: 'No such plan.' } };
      const edit = command.edit as { readonly kind: string; readonly expectedRevision: number; readonly taskId?: string };
      if (edit.expectedRevision !== plan.revision) {
        return {
          ok: false,
          error: conflict('The plan changed since this edit was prepared.', `revision ${plan.revision}`, `revision ${edit.expectedRevision}`),
        };
      }
      const tasks = plan.tasks.map((task) => {
        if (edit.kind !== 'Accept' || task.taskId !== edit.taskId) return task;
        return { ...task, acceptance: 'Accepted' as const, acceptedBy: OWNER_ID, acceptedAt: '2026-03-01T12:05:00.000Z', publishable: true };
      });
      const edited: PlanView = { ...plan, revision: plan.revision + 1, tasks, lastEditedAt: '2026-03-01T12:05:00.000Z', lastEditedBy: OWNER_ID };
      this.plans.set(edited.planId, edited);
      return { ok: true, value: edited };
    },
    assessPlan: async (): Promise<Result<ReadinessAssessmentView, DomainError>> => ({
      ok: true,
      value: {
        subjectId: 'plan_http',
        assessedAt: '2026-03-01T12:00:00.000Z',
        verdict: 'NeedsInformation',
        mayStartBuild: true,
        mayStartInvestigation: true,
        buildBlockingAreas: [],
        areas: ['Scope', 'Criteria', 'Repository', 'Target', 'Dependencies', 'Verification', 'Access'].map((area) => ({
          area,
          status: area === 'Access' ? ('Unmet' as const) : ('Satisfied' as const),
          reason: area === 'Access' ? 'No connector for this project is configured.' : `The ${area} area was observed.`,
          remedy: area === 'Access' ? 'Register a working ticket connector.' : null,
        })),
        reasons: [{ area: 'Access', status: 'Unmet', reason: 'No connector for this project is configured.' }],
      },
    }),
    publishPlan: async (command: { readonly planId: string; readonly requestId: string }): Promise<Result<PublicationReportView, DomainError>> => {
      /**
       * The work item a task publishes as, and `[]` for a task that is not there.
       *
       * A partial failure is one success and one refusal, so the double needs to name
       * the remainder rather than the whole list, or a test asserting on `unpublished`
       * would pass against a report that published everything (F10-AC2).
       */
      const workItemOf = (plan: PlanView, taskId: string): string[] =>
        taskId === '' ? [] : [plan.workItemIdByTaskId[taskId] ?? ''];
      const scripted = this.takeScripted('publishPlan');
      if (scripted !== null) return { ok: false, error: scripted };
      const plan = this.plans.get(command.planId);
      if (plan === undefined) return { ok: false, error: { code: 'NotFound', reason: 'No such plan.' } };
      const publishable = plan.tasks.filter((task) => task.publishable);
      if (publishable.length === 0) {
        return { ok: false, error: { code: 'Invalid', reason: 'Only an accepted proposal may be published (F08-AC3, F10-AC1).', fields: [] } };
      }
      return {
        ok: true,
        value: {
          requestId: command.requestId,
          planId: plan.planId,
          tickets: publishable.map((task, index) => ({
            workItemId: plan.workItemIdByTaskId[task.taskId] ?? '',
            taskId: task.taskId,
            kind: index === 0 ? ('Published' as const) : ('Failed' as const),
            issueId: index === 0 ? 'issue_http_1' : null,
            identifier: index === 0 ? 'OCT-1' : null,
            url: index === 0 ? 'https://example.invalid/oct-1' : null,
            disposition: index === 0 ? ('CreatedNew' as const) : null,
            unlinked: [],
            detail: index === 0 ? 'Published as OCT-1.' : 'The provider refused this ticket.',
          })),
          published: workItemOf(plan, publishable[0]?.taskId ?? ''),
          unpublished: workItemOf(plan, publishable[1]?.taskId ?? ''),
          reconciled: false,
        },
      };
    },
    reconcilePublication: async (): Promise<Result<{ readonly resolution: string; readonly workItemId: string | null; readonly detail: string }, DomainError>> =>
      notImplemented('reconcilePublication'),
    adoptExistingIssue: async (): Promise<Result<AdoptedIssueView, DomainError>> => notImplemented('adoptExistingIssue'),
    linkExistingChange: async (): Promise<Result<LinkedChangeView, DomainError>> => notImplemented('linkExistingChange'),
    requestAdoptedEvaluation: async (command: { readonly mode: 'Test' | 'Review' | 'Build' }): Promise<Result<AdoptedEvaluationView, DomainError>> => {
      if (command.mode === 'Build') {
        return {
          ok: false,
          error: {
            code: 'Invalid',
            reason: 'An adopted candidate cannot be sent to Build (F11-AC5).',
            fields: [{ path: 'mode', message: 'Request Test or Review for adopted work instead.' }],
          },
        };
      }
      return { ok: true, value: { workItemId: 'wi_http', mode: command.mode, dedupKey: 'k', created: true, jobEnqueued: false } };
    },
  };

  readonly owners = {
    provision: async (command: ProvisionOwnerCommand): Promise<Result<OwnerView, DomainError>> => {
      const scripted = this.takeScripted('provision');
      if (scripted !== null) return { ok: false, error: scripted };
      const hashed = hashPassword(command.password);
      if (!hashed.ok) return { ok: false, error: hashed.error };
      if (this.passwordHash !== '') return { ok: false, error: conflict('An owner is already provisioned.', 'none', 'one') };
      this.passwordHash = hashed.value;
      this.ownerEmail = `${command.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@owners.shiploop.invalid`;
      this.ownerCreatedAt = command.at;
      return ok({
        ownerId: OWNER_ID,
        displayName: command.displayName,
        email: this.ownerEmail,
        createdAt: command.at,
        // A newly provisioned owner has selected nothing, and this double says so the way
        // the controller does: an explicit state, never a fabricated project (F02-AC1).
        activeProject: this.activeProjectView(),
      });
    },

    /**
     * The provisioned owner's stored identity, read rather than re-derived (F01-AC1).
     *
     * The session and sign-in routes read the address and the selected project from here, so
     * a test asserting the session response carries them is asserting the route read stored
     * state rather than recomputing anything — which is the exact substitution that produced
     * the blank header and the `/api/profiles/undefined` requests (F02-AC1, F02-AC4).
     */
    describe: async (command: { readonly ownerId: OwnerId }): Promise<Result<OwnerView, DomainError>> => {
      if (command.ownerId !== OWNER_ID || this.passwordHash === '') {
        return { ok: false, error: { code: 'NotFound', reason: 'No owner matches that identity.' } };
      }
      return ok({
        ownerId: OWNER_ID,
        displayName: OWNER_NAME,
        email: this.ownerEmail,
        createdAt: this.ownerCreatedAt,
        activeProject: this.activeProjectView(),
      });
    },

    /**
     * Records which project this owner's subsequent calls address (F02-AC1).
     *
     * Refuses a project this double does not hold with the same `NotFound` the controller
     * produces, because a route test that let an unknown project be selected would prove the
     * route forwards refusals while testing a controller that invents projects (F02-AC4).
     */
    selectActiveProject: async (command: {
      readonly ownerId: OwnerId;
      readonly projectId: string;
      readonly at: string;
    }): Promise<Result<ActiveProjectView, DomainError>> => {
      if (command.ownerId !== OWNER_ID || this.passwordHash === '') {
        return { ok: false, error: { code: 'NotFound', reason: 'No owner matches that identity.' } };
      }
      const record = this.projectRecords.get(command.projectId);
      if (record === undefined) {
        return { ok: false, error: { code: 'NotFound', reason: `Project ${command.projectId} does not exist.` } };
      }
      this.activeProjectId = record.projectId;
      return ok({ state: 'Selected', activeProjectId: record.projectId, activeProjectName: record.name });
    },

    signIn: async (command: SignInCommand): Promise<Result<SignInGrant, DomainError>> => {
      const scripted = this.takeScripted('signIn');
      if (scripted !== null) return { ok: false, error: scripted };
      const known = this.passwordHash !== '' && command.identifier === OWNER_NAME;
      const authenticated = known && verifyPassword(command.password, this.passwordHash);
      if (!known || !authenticated) {
        verifyPassword(command.password, decoyHash());
        return {
          ok: false,
          error: {
            code: 'Forbidden',
            reason: known ? 'The password did not match the stored credential.' : 'No owner matches that identifier.',
          },
        };
      }
      const deadlines = sessionDeadlines({
        issuedAt: command.issuedAt,
        absoluteTtlSeconds: command.absoluteTtlSeconds,
        idleTimeoutSeconds: command.idleTimeoutSeconds,
      });
      const sessionId = `ses_${this.sessionsById.size + 1}`;
      const record: StoredSessionRecord = {
        sessionId,
        ownerId: OWNER_ID,
        displayName: OWNER_NAME,
        tokenDigest: command.tokenDigest,
        issuedAt: deadlines.issuedAt,
        expiresAt: deadlines.expiresAt,
        revokedAt: null,
        lastActivityAt: null,
      };
      this.sessionsById.set(sessionId, record);
      this.sessionIdByDigest.set(command.tokenDigest, sessionId);
      return ok({ session: record });
    },
  };

  readonly sessions = {
    loadByToken: async (token: string): Promise<Result<StoredSessionRecord, DomainError>> => {
      const sessionId = this.sessionIdByDigest.get(hashToken(token));
      const record = sessionId === undefined ? undefined : this.sessionsById.get(sessionId);
      if (record === undefined) return { ok: false, error: { code: 'NotFound', reason: 'No such session.' } };
      return ok(record);
    },

    create: async (command: CreateSessionCommand): Promise<Result<StoredSessionRecord, DomainError>> => {
      const deadlines = sessionDeadlines({
        issuedAt: command.issuedAt,
        absoluteTtlSeconds: command.absoluteTtlSeconds,
        idleTimeoutSeconds: command.idleTimeoutSeconds,
      });
      const sessionId = `ses_${this.sessionsById.size + 1}`;
      const record: StoredSessionRecord = {
        sessionId,
        ownerId: command.ownerId,
        displayName: command.displayName,
        tokenDigest: command.tokenDigest,
        issuedAt: deadlines.issuedAt,
        expiresAt: deadlines.expiresAt,
        revokedAt: null,
        lastActivityAt: null,
      };
      this.sessionsById.set(sessionId, record);
      this.sessionIdByDigest.set(command.tokenDigest, sessionId);
      return ok(record);
    },

    revoke: async (command: RevokeSessionCommand): Promise<Result<StoredSessionRecord, DomainError>> => {
      const record = this.sessionsById.get(command.sessionId);
      if (record === undefined) return { ok: false, error: { code: 'NotFound', reason: 'No such session.' } };
      const revoked: StoredSessionRecord = { ...record, revokedAt: command.revokedAt };
      this.sessionsById.set(record.sessionId, revoked);
      return ok(revoked);
    },

    touch: async (command: TouchSessionCommand): Promise<Result<null, DomainError>> => {
      const record = this.sessionsById.get(command.sessionId);
      if (record === undefined) return { ok: false, error: { code: 'NotFound', reason: 'No such session.' } };
      this.sessionsById.set(record.sessionId, { ...record, lastActivityAt: command.lastActivityAt });
      return ok(null);
    },
  };

  /**
   * The request and contract group.
   *
   * A real in-memory implementation rather than a refusal: these routes are the MVP's first
   * two steps, and a double that answered "not implemented" would leave every assertion about
   * them vacuous. What is real here is the *boundary* - project-scoped keys, the
   * compare-and-set, the frozen approval and the attributed approver - because those are the
   * properties `routes/contracts.ts` has to forward faithfully. Whether the underlying rules
   * hold is proved in `packages/domain/src/contract.test.ts` and
   * `packages/controller/src/contracts.test.ts`, both against the real store.
   */
  readonly contracts = {
    createRequest: async (command: {
      readonly projectId: string;
      readonly title: string;
      readonly description: string;
      readonly actor: OwnerId;
    }): Promise<Result<RequestView, DomainError>> => {
      const request: RequestView = {
        requestId: `req_${this.requestRecords.size + 1}`,
        projectId: command.projectId,
        title: command.title,
        description: command.description,
        sourceIdeaId: null,
        createdAt: this.contractInstant(),
        updatedAt: this.contractInstant(),
      };
      this.requestRecords.set(request.requestId, request);
      return ok(request);
    },

    getRequest: async (command: {
      readonly projectId: string;
      readonly requestId: string;
      readonly actor: OwnerId;
    }): Promise<Result<RequestDetailView, DomainError>> => {
      const detail = this.detailOf(command.projectId, command.requestId);
      if (!detail.ok) return detail;
      return ok(detail.value);
    },

    listRequests: async (command: {
      readonly projectId: string;
      readonly actor: OwnerId;
    }): Promise<Result<readonly RequestView[], DomainError>> =>
      ok([...this.requestRecords.values()].filter((request) => request.projectId === command.projectId)),

    updateRequest: async (command: {
      readonly projectId: string;
      readonly requestId: string;
      readonly title?: string;
      readonly description?: string;
      readonly expectedUpdatedAt: string;
      readonly actor: OwnerId;
    }): Promise<Result<RequestView, DomainError>> => {
      const stored = this.requestRecords.get(command.requestId);
      // Project-scoped: a request id from another project is not found, not found-and-refused,
      // so the refusal cannot confirm that the identifier exists elsewhere (F02-AC2).
      if (stored === undefined || stored.projectId !== command.projectId) {
        return { ok: false, error: { code: 'NotFound', reason: `Request ${command.requestId} does not exist.` } };
      }
      if (stored.updatedAt !== command.expectedUpdatedAt) {
        return {
          ok: false,
          error: conflict(
            'The request changed after it was loaded. Reload it before saving again.',
            command.expectedUpdatedAt,
            stored.updatedAt,
          ),
        };
      }
      const title = command.title ?? stored.title;
      const description = command.description ?? stored.description;
      if (title === stored.title && description === stored.description) {
        return { ok: false, error: invalid('Nothing changed; edit the title or the description.', [{ path: 'request', message: 'No-op.' }]) };
      }
      const updated: RequestView = { ...stored, title, description, updatedAt: this.contractInstant() };
      this.requestRecords.set(updated.requestId, updated);
      return ok(updated);
    },

    draftContract: async (command: {
      readonly projectId: string;
      readonly requestId: string;
      readonly outcome: string;
      readonly scope: readonly string[];
      readonly outOfScope: readonly string[];
      readonly acceptanceCriteria: readonly ContractCriterionView[];
      readonly actor: OwnerId;
    }): Promise<Result<ContractView, DomainError>> => {
      const request = this.requestRecords.get(command.requestId);
      if (request === undefined || request.projectId !== command.projectId) {
        return { ok: false, error: { code: 'NotFound', reason: `Request ${command.requestId} does not exist.` } };
      }
      const existing = [...this.contractRevisions.values()].filter((contract) => contract.requestId === command.requestId);
      if (existing.length > 0) {
        return {
          ok: false,
          error: conflict(
            `This request already has ${existing.length} contract revision(s).`,
            'no revisions',
            `${existing.length} revision(s)`,
          ),
        };
      }
      if (command.acceptanceCriteria.length === 0) {
        return {
          ok: false,
          error: invalid('A contract needs at least one acceptance criterion.', [
            { path: 'acceptanceCriteria', message: 'At least one.' },
          ]),
        };
      }
      const contract = this.newRevision(command.projectId, command.requestId, 1, {
        outcome: command.outcome,
        scope: command.scope,
        outOfScope: command.outOfScope,
        acceptanceCriteria: command.acceptanceCriteria,
      });
      return ok(contract);
    },

    getContract: async (command: {
      readonly projectId: string;
      readonly contractId: string;
      readonly revision: number;
      readonly actor: OwnerId;
    }): Promise<Result<ContractView, DomainError>> => {
      const contract = this.revisionOf(command.projectId, command.contractId, command.revision);
      if (contract === null) {
        return { ok: false, error: { code: 'NotFound', reason: `Contract revision #${command.revision} does not exist.` } };
      }
      return ok(contract);
    },

    listContractRevisions: async (command: {
      readonly projectId: string;
      readonly requestId: string;
      readonly actor: OwnerId;
    }): Promise<Result<readonly ContractView[], DomainError>> => {
      // The request is read first and refused when it is not here, matching the real
      // surface. A listing that answered `[]` for a request id from another project would
      // make a route test pass on an empty body where production answers 404, and "this
      // request has no revisions" is not what that path means (F02-AC2).
      const request = this.requestRecords.get(command.requestId);
      if (request === undefined || request.projectId !== command.projectId) {
        return { ok: false, error: { code: 'NotFound', reason: `Request ${command.requestId} does not exist.` } };
      }
      return ok(
        [...this.contractRevisions.values()]
          .filter((contract) => contract.requestId === command.requestId)
          .sort((left, right) => left.revision - right.revision)
          .map((contract) => this.projected(contract)),
      );
    },

    listContractCriteria: async (command: {
      readonly projectId: string;
      readonly contractId: string;
      readonly revision: number;
      readonly actor: OwnerId;
    }): Promise<Result<readonly ContractCriterionView[], DomainError>> => {
      const contract = this.revisionOf(command.projectId, command.contractId, command.revision);
      if (contract === null) {
        return { ok: false, error: { code: 'NotFound', reason: `Contract revision #${command.revision} does not exist.` } };
      }
      return ok(contract.acceptanceCriteria.map((criterion) => ({ ...criterion })));
    },

    editContract: async (command: {
      readonly projectId: string;
      readonly contractId: string;
      readonly revision: number;
      readonly outcome: string;
      readonly scope: readonly string[];
      readonly outOfScope: readonly string[];
      readonly acceptanceCriteria: readonly ContractCriterionView[];
      readonly expectedUpdatedAt: string;
      readonly actor: OwnerId;
    }): Promise<Result<ContractView, DomainError>> => {
      const stored = this.revisionOf(command.projectId, command.contractId, command.revision);
      if (stored === null) {
        return { ok: false, error: { code: 'NotFound', reason: `Contract revision #${command.revision} does not exist.` } };
      }
      // The freeze, which is the property the route has to forward: an approved revision's
      // text is not editable, and the only way forward is a new revision (mvp-spec 3).
      if (stored.status !== 'draft') {
        return {
          ok: false,
          error: invalid(
            `Revision ${stored.revision} is ${stored.status}, so it cannot be edited. Draft a new revision instead.`,
            [{ path: 'status', message: 'Only a draft revision may be edited.' }],
          ),
        };
      }
      if (stored.updatedAt !== command.expectedUpdatedAt) {
        return {
          ok: false,
          error: conflict('The contract revision changed after it was loaded.', command.expectedUpdatedAt, stored.updatedAt),
        };
      }
      const edited: ContractView = {
        ...stored,
        outcome: command.outcome,
        scope: [...command.scope],
        outOfScope: [...command.outOfScope],
        acceptanceCriteria: command.acceptanceCriteria.map((criterion) => ({ ...criterion })),
        contentFingerprint: fingerprint({
          outcome: command.outcome,
          scope: [...command.scope],
          outOfScope: [...command.outOfScope],
          acceptanceCriteria: command.acceptanceCriteria.map((criterion) => ({ ...criterion })),
        }),
        updatedAt: this.contractInstant(),
      };
      this.storeRevision(edited);
      return ok(edited);
    },

    /**
     * Approves, attributing the approval to the session.
     *
     * The command carries no approver, which is the whole point: there is no field for a
     * client to fill in, so a route cannot forward one even by accident (mvp-spec 3).
     */
    approveRevision: async (command: {
      readonly projectId: string;
      readonly contractId: string;
      readonly revision: number;
      readonly actor: OwnerId;
    }): Promise<Result<ContractView, DomainError>> => {
      const stored = this.revisionOf(command.projectId, command.contractId, command.revision);
      if (stored === null) {
        return { ok: false, error: { code: 'NotFound', reason: `Contract revision #${command.revision} does not exist.` } };
      }
      if (stored.status !== 'draft') {
        return {
          ok: false,
          error: conflict(`Revision ${stored.revision} is already ${stored.status}.`, 'draft', stored.status),
        };
      }
      const approved: ContractView = {
        ...stored,
        status: 'approved',
        approvedAt: this.contractInstant(),
        approvedBy: String(command.actor),
        updatedAt: this.contractInstant(),
        blockedBecause: null,
      };
      this.storeRevision(approved);
      return ok(approved);
    },

    reviseContract: async (command: {
      readonly projectId: string;
      readonly contractId: string;
      readonly revision: number;
      readonly outcome: string;
      readonly scope: readonly string[];
      readonly outOfScope: readonly string[];
      readonly acceptanceCriteria: readonly ContractCriterionView[];
      readonly actor: OwnerId;
    }): Promise<Result<ContractView, DomainError>> => {
      const stored = this.revisionOf(command.projectId, command.contractId, command.revision);
      if (stored === null) {
        return { ok: false, error: { code: 'NotFound', reason: `Contract revision #${command.revision} does not exist.` } };
      }
      const next = this.newRevision(command.projectId, stored.requestId, stored.revision + 1, {
        outcome: command.outcome,
        scope: command.scope,
        outOfScope: command.outOfScope,
        acceptanceCriteria: command.acceptanceCriteria,
      });
      // One step: the old approval is retired here or the new revision never arrives. This is
      // the property the route has to forward, so it lives in the double too (mvp-spec 3).
      if (stored.status === 'approved') {
        this.storeRevision({
          ...stored,
          status: 'stale',
          staleReason: `Superseded by revision ${next.revision}.`,
          supersededByRevision: next.revision,
          updatedAt: this.contractInstant(),
          blockedBecause: `Contract revision ${stored.revision} is stale; only an approved revision may be measured against.`,
        });
      }
      return ok(next);
    },

    invalidateRevision: async (command: {
      readonly projectId: string;
      readonly contractId: string;
      readonly revision: number;
      readonly reason: ContractStaleReason;
      readonly actor: OwnerId;
    }): Promise<Result<ContractView, DomainError>> => {
      const stored = this.revisionOf(command.projectId, command.contractId, command.revision);
      if (stored === null) {
        return { ok: false, error: { code: 'NotFound', reason: `Contract revision #${command.revision} does not exist.` } };
      }
      if (stored.status !== 'approved') {
        return {
          ok: false,
          error: conflict(`Revision ${stored.revision} is ${stored.status}; there is no approval to retire.`, 'approved', stored.status),
        };
      }
      const stale: ContractView = {
        ...stored,
        status: 'stale',
        staleReason: STALE_REASON_TEXT[command.reason],
        updatedAt: this.contractInstant(),
        blockedBecause: `Contract revision ${stored.revision} is stale; only an approved revision may be measured against.`,
      };
      this.storeRevision(stale);
      return ok(stale);
    },
  };

  /**
   * A strictly increasing instant, so two recorded times in one case stay ordered and a
   * compare-and-set can tell them apart (mvp-spec 7).
   */
  private contractInstant(): string {
    this.contractTicks += 1;
    return `2026-03-01T${String(9 + this.contractTicks).padStart(2, '0')}:00:00.000Z`;
  }

  /**
   * One revision, addressed by project as well as identity and number (F02-AC2).
   *
   * The revision comes back projected, so a read reports `answersCurrentRequest` against
   * the request as it reads *now* rather than as it read when the revision was drafted -
   * which is what the real surface does, and what makes an edit to the request visible
   * against an approved revision instead of leaving it silently current (mvp-spec 3).
   */
  private revisionOf(projectId: string, contractId: string, revision: number): ContractView | null {
    const stored = this.contractRevisions.get(`${contractId}#${revision}`);
    if (stored === undefined || stored.projectId !== projectId) return null;
    return this.projected(stored);
  }

  /** The fingerprint of a request's current text, as the real surface computes it. */
  private requestFingerprintOf(projectId: string, requestId: string): string {
    const request = this.requestRecords.get(requestId);
    return fingerprint({
      projectId,
      title: request?.title ?? '',
      description: request?.description ?? '',
      sourceIdeaId: request?.sourceIdeaId ?? null,
    });
  }

  /** A revision with the one field that is a report about the request, recomputed. */
  private projected(contract: ContractView): ContractView {
    return {
      ...contract,
      answersCurrentRequest:
        contract.requestFingerprint === this.requestFingerprintOf(contract.projectId, contract.requestId),
    };
  }

  private storeRevision(contract: ContractView): void {
    this.contractRevisions.set(`${contract.contractId}#${contract.revision}`, contract);
  }

  /** A new draft revision, with a fresh id: a revision is a different agreement. */
  private newRevision(
    projectId: string,
    requestId: string,
    revision: number,
    content: {
      readonly outcome: string;
      readonly scope: readonly string[];
      readonly outOfScope: readonly string[];
      readonly acceptanceCriteria: readonly ContractCriterionView[];
    },
  ): ContractView {
    const at = this.contractInstant();
    const contract: ContractView = {
      contractId: `dc_${this.contractRevisions.size + 1}`,
      revision,
      projectId,
      requestId,
      status: 'draft',
      outcome: content.outcome,
      scope: [...content.scope],
      outOfScope: [...content.outOfScope],
      acceptanceCriteria: content.acceptanceCriteria.map((criterion) => ({ ...criterion })),
      contentFingerprint: fingerprint(content),
      // The fingerprint of the request text as it stands now, so a later edit is detectable -
      // reported as `answersCurrentRequest: false` rather than acted on (mvp-spec 3).
      requestFingerprint: this.requestFingerprintOf(projectId, requestId),
      answersCurrentRequest: true,
      approvedAt: null,
      approvedBy: null,
      staleReason: null,
      supersededByRevision: null,
      sourceBriefId: null,
      sourceBriefVersion: null,
      createdBy: String(OWNER_ID),
      createdAt: at,
      updatedAt: at,
      blockedBecause: `Contract revision ${revision} is draft; only an approved revision may be measured against.`,
    };
    this.storeRevision(contract);
    return contract;
  }

  private detailOf(
    projectId: string,
    requestId: string,
  ): Result<RequestDetailView, DomainError> {
    const request = this.requestRecords.get(requestId);
    if (request === undefined || request.projectId !== projectId) {
      return { ok: false, error: { code: 'NotFound', reason: `Request ${requestId} does not exist.` } };
    }
    const revisions = [...this.contractRevisions.values()]
      .filter((contract) => contract.requestId === requestId)
      .sort((left, right) => left.revision - right.revision)
      .map((contract) => this.projected(contract));
    return ok({
      request,
      latestRevision: revisions[revisions.length - 1] ?? null,
      approvedRevision: revisions.find((contract) => contract.status === 'approved') ?? null,
      revisions,
    });
  }

  /**
   * The external-execution handoff (mvp-spec L02).
   *
   * This double does not render packets: the text belongs to the controller's generator, and
   * a fixture that assembled its own would make the route-level handoff assertions - that the
   * response is byte-identical to what the generator produces, and that a seeded credential
   * never reaches it - pass against a document this file wrote. `apps/web/src/server/
   * handoff.test.ts` drives the route against the real controller on a real migrated store,
   * which is the only place the packet's bytes can honestly be checked. What this double
   * still has to answer is the refusal, because an unimplemented group would turn a coverage
   * gap into a 503 (F01-AC1).
   */
  readonly handoff = {
    buildHandoff: async (command: {
      readonly projectId: string;
      readonly contractId: string;
      readonly revision: number;
      readonly actor: string;
    }): Promise<Result<HandoffView, DomainError>> => {
      const contract = this.contractRevisions.get(`${command.contractId}#${command.revision}`);
      if (contract === undefined || contract.projectId !== command.projectId) {
        return {
          ok: false,
          error: { code: 'NotFound', reason: `Contract ${command.contractId} revision ${command.revision} does not exist.` },
        };
      }
      if (contract.status !== 'approved') {
        return {
          ok: false,
          error: {
            code: 'Blocked',
            reason: contract.blockedBecause ?? `Contract revision ${contract.revision} is ${contract.status}.`,
            prerequisites: [
              {
                name: 'contractApproval',
                detail: 'Only an approved Delivery Contract revision can be handed off.',
                remedy: `Have the owner approve revision ${contract.revision} in ShipLoop, then read the handoff again.`,
              },
            ],
          },
        };
      }
      return notImplemented<HandoffView>('buildHandoff');
    },
  };

  readonly projects = {
    listProjects: async (): Promise<Result<readonly ProjectView[], DomainError>> =>
      ok([...this.projectRecords.values()].map((record) => ({ ...record }))),

    createProject: async (command: {
      readonly projectId: string;
      readonly name: string;
      readonly at: string;
    }): Promise<Result<ProjectView, DomainError>> => {
      const existing = this.projectRecords.get(command.projectId);
      // Idempotent by identity and it does not overwrite the name, matching the store: a
      // resubmitted creation form must not rename a project a stale tab is looking at.
      const record = existing ?? {
        projectId: command.projectId,
        name: command.name,
        createdAt: command.at,
        updatedAt: command.at,
        archivedAt: null,
      };
      this.projectRecords.set(command.projectId, record);
      return ok({ ...record });
    },
  };

  readonly profiles = {
    saveVersion: async (command: SaveProfileVersionCommand): Promise<Result<ProfileVersionView, DomainError>> => {
      const scripted = this.takeScripted('saveProfile');
      if (scripted !== null) return { ok: false, error: scripted };
      const history = this.profileVersions.get(command.projectId) ?? [];
      const newest = history[history.length - 1];
      const actualVersionNumber = newest?.versionNumber ?? 0;
      if (command.expectedVersionNumber !== null && command.expectedVersionNumber !== actualVersionNumber) {
        return {
          ok: false,
          error: conflict(
            'The profile changed after it was loaded. Reload it before saving again.',
            String(command.expectedVersionNumber),
            String(actualVersionNumber),
          ),
        };
      }
      const revoked = [...this.connectorRecords.values()].find(
        (connector) => connector.projectId === command.projectId && connector.state === 'Revoked',
      );
      if (revoked !== undefined) {
        return {
          ok: false,
          error: blocked('The profile cannot be saved while a required connector is revoked.', [
            {
              name: `connector.${revoked.kind}.credential`,
              detail: `${revoked.provider} access was revoked for ${revoked.resourceScope}.`,
              remedy: 'Register a working credential reference for this connector, then save the profile again.',
            },
          ]),
        };
      }
      const version: ProfileVersionView = {
        profileVersionId: `prv_${history.length + 1}` as ProfileVersionId,
        projectId: command.projectId,
        versionNumber: actualVersionNumber + 1,
        supersedesVersionId: newest?.profileVersionId ?? null,
        content: command.content,
        contentFingerprint: fingerprint(command.content),
        note: command.note,
        createdAt: command.at,
        createdBy: command.actor,
      };
      this.profileVersions.set(command.projectId, [...history, version]);
      return ok(version);
    },

    currentVersion: async (projectId: ProjectId): Promise<Result<ProfileVersionView | null, DomainError>> => {
      const history = this.profileVersions.get(projectId) ?? [];
      return ok(history[history.length - 1] ?? null);
    },

    listVersions: async (projectId: ProjectId): Promise<Result<readonly ProfileVersionView[], DomainError>> =>
      ok(this.profileVersions.get(projectId) ?? []),
  };

  readonly connectors = {
    register: async (command: RegisterConnectorCommand): Promise<Result<ConnectorView, DomainError>> => {
      const scripted = this.takeScripted('registerConnector');
      if (scripted !== null) return { ok: false, error: scripted };
      const connectorId = `con_${this.connectorRecords.size + 1}` as ConnectorId;
      const summary = capabilitiesFor(this.capabilities[command.provider] ?? []);
      const view: ConnectorView = {
        connectorId,
        projectId: command.projectId,
        provider: command.provider,
        kind: command.kind,
        resourceScope: command.resourceScope,
        credentialReference: command.credentialReference,
        credentialReferenceDigest: fingerprint(command.credentialReference),
        state: 'Healthy',
        error: null,
        lastCheckedAt: command.at,
        lastSuccessAt: command.at,
        reads: summary.reads,
        writes: summary.writes,
        unsupported: summary.unsupported,
        createdAt: command.at,
        updatedAt: command.at,
      };
      this.connectorRecords.set(connectorId, view);
      return ok(view);
    },

    listForProject: async (projectId: ProjectId): Promise<Result<readonly ConnectorView[], DomainError>> =>
      ok([...this.connectorRecords.values()].filter((connector) => connector.projectId === projectId)),

    revoke: async (command: RevokeConnectorCommand): Promise<Result<ConnectorView, DomainError>> => {
      const existing = this.connectorRecords.get(command.connectorId);
      if (existing === undefined) return { ok: false, error: { code: 'NotFound', reason: 'No such connector.' } };
      const revoked: ConnectorView = {
        ...existing,
        state: 'Revoked',
        error: `Access was revoked: ${command.reason}. Register a working credential to reconnect.`,
        updatedAt: command.at,
      };
      this.connectorRecords.set(command.connectorId, revoked);
      return ok(revoked);
    },
  };

  /**
   * Settings, in a map rather than SQLite.
   *
   * Two decisions are the real ones, because they are the ones the route has to be able to
   * exercise: a project this double does not hold is a `NotFound` rather than an empty
   * answer that reads as "configured and blank" (F02-AC2), and a provider is projected
   * without its `credentialReference` - only the digest travels, so a settings response
   * cannot be where a credential pointer leaks (F03-AC3). `validateT3Setting` is the real
   * function, not a copy, so a route test cannot pass against a rule this double invented.
   */
  readonly settings = {
    readSettings: async (command: {
      readonly projectId: ProjectId;
      readonly actor: OwnerId;
    }): Promise<Result<ProjectSettingsView, DomainError>> => {
      const scripted = this.takeScripted('readSettings');
      if (scripted !== null) return { ok: false, error: scripted };
      if (!this.projectRecords.has(command.projectId)) {
        return {
          ok: false,
          error: { code: 'NotFound', reason: 'This deployment holds no project with that identity (F02-AC2).' },
        };
      }
      return ok(this.settingsView(command.projectId));
    },

    updateSettings: async (command: {
      readonly projectId: ProjectId;
      readonly t3Url?: string | null;
      readonly at: string;
      readonly actor: OwnerId;
    }): Promise<Result<ProjectSettingsView, DomainError>> => {
      const scripted = this.takeScripted('updateSettings');
      if (scripted !== null) return { ok: false, error: scripted };
      if (!this.projectRecords.has(command.projectId)) {
        return {
          ok: false,
          error: { code: 'NotFound', reason: 'This deployment holds no project with that identity (F02-AC2).' },
        };
      }
      if (command.t3Url !== undefined) {
        const validated = validateT3Setting(command.t3Url);
        if (!validated.ok) return { ok: false, error: validated.error };
        this.projectSettings.set(command.projectId, {
          t3: validated.value,
          updatedAt: command.at,
        });
      }
      return ok(this.settingsView(command.projectId));
    },
  };

  /** The settings of one project, assembled from the rows this double holds. */
  private settingsView(projectId: ProjectId): ProjectSettingsView {
    const stored = this.projectSettings.get(projectId) ?? null;
    const history = this.profileVersions.get(projectId) ?? [];
    const current = history[history.length - 1];
    const connectors = [...this.connectorRecords.values()].filter(
      (connector) => connector.projectId === projectId,
    );
    return {
      projectId,
      t3: stored?.t3 ?? { configured: false, url: null },
      repository:
        current === undefined
          ? {
              configured: false,
              profileVersionId: null,
              versionNumber: null,
              repository: null,
              baseBranch: null,
              targetBranch: null,
              ticketProvider: null,
              deploymentProvider: null,
              engine: null,
            }
          : {
              configured: true,
              profileVersionId: current.profileVersionId,
              versionNumber: current.versionNumber,
              repository: current.content.references.repository,
              baseBranch: current.content.references.baseBranch,
              targetBranch: current.content.references.targetBranch,
              ticketProvider: current.content.references.ticketProvider,
              deploymentProvider: current.content.references.deploymentProvider,
              engine: current.content.references.engine,
            },
      // The credential reference is deliberately absent from this projection (F03-AC3).
      providers: connectors.map((connector) => ({
        connectorId: connector.connectorId,
        kind: connector.kind,
        provider: connector.provider,
        resourceScope: connector.resourceScope,
        credentialReferenceDigest: connector.credentialReferenceDigest,
        state: connector.state,
        lastCheckedAt: connector.lastCheckedAt,
        lastSuccessAt: connector.lastSuccessAt,
      })),
      updatedAt: stored?.updatedAt ?? null,
    };
  }

  /**
   * Runs, in maps rather than SQLite.
   *
   * The decisions this double makes are the ones a transport test needs to be able to
   * exercise, and each one is the decision the real use case makes, so a route that reports
   * the wrong status is caught here rather than at the first owner request: deduplication
   * by operation identity (F13-AC2), the lifecycle transitions validated against the
   * domain's own attempt table (F17-AC1), a pause that reports whether the writer stopped
   * (F17-AC1), and a resume that is refused without a recorded resume point (F17-AC2).
   *
   * `script` still arms the refusals a route has to map: an extension granted to a run that
   * is not waiting is a `Conflict`, and a review card for a run with no candidate is a
   * `NotFound`.
   */
  readonly runs = {
    startRun: async (command: StartRunCommand): Promise<Result<RunStartView, DomainError>> => {
      const scripted = this.takeScripted('startRun');
      if (scripted !== null) return { ok: false, error: scripted };
      const existing = [...this.recordedRuns.values()].find((job) => job.operationId === command.operationId);
      if (existing !== undefined) {
        const checkpoint = this.checkpoints.get(existing.jobId) ?? null;
        void checkpoint;
        return ok(this.startView(existing, true, command.at));
      }
      if (command.workItemId.trim().length === 0) {
        return {
          ok: false,
          error: invalid('The run could not be started as given.', [
            { path: 'workItemId', message: 'Name the work item this run works on.' },
          ]),
        };
      }
      const unconfirmed = READINESS_AREAS.filter((area) => !command.readiness[area].confirmed).map(
        (area) => READINESS_AREA_NAMES[area],
      );
      if (unconfirmed.length > 0) {
        return {
          ok: false,
          error: blocked(
            `Work ${command.workItemId} is NeedsInformation: ${unconfirmed.join(', ')} are not confirmed (F09-AC2).`,
            unconfirmed.map((area) => ({
              name: `readiness-${area.toLowerCase()}`,
              detail: `${area} is not confirmed.`,
              remedy: `Confirm the ${area} prerequisite on the start form, or record what is open about it.`,
            })),
          ),
        };
      }
      const jobId = `job_${String(this.recordedRuns.size + 1)}`;
      const job: RunJobView = {
        jobId,
        operationId: command.operationId,
        mode: command.mode,
        workItemId: command.workItemId,
        scopeSnapshotId: `scope_${String(this.recordedRuns.size + 1)}`,
        projectId: PROJECT_ID,
        profileVersionId: 'prv_1',
        procedureVersionId: 'prc_1',
        state: 'Queued',
        correlationId: command.operationId,
        limits: { activeExecutionMs: 3_600_000, maxAutomatedFixPasses: 2, maxToolRetries: 3, maxAttempts: 2 },
        permittedOperations: MODE_OPERATIONS[command.mode],
        holder: null,
        attemptCount: 0,
        createdAt: command.at,
        updatedAt: command.at,
      };
      this.recordedRuns.set(jobId, job);
      return ok(this.startView(job, false, command.at));
    },

    listRuns: async (): Promise<Result<readonly RunJobView[], DomainError>> => ok([...this.recordedRuns.values()]),

    getRun: async (jobId: JobId): Promise<Result<RunView, DomainError>> => this.viewOf(jobId),

    pauseRun: async (jobId: JobId): Promise<Result<PausedRunView, DomainError>> => {
      const scripted = this.takeScripted('pauseRun');
      if (scripted !== null) return { ok: false, error: scripted };
      const job = this.jobOf(jobId);
      if (job === null) return { ok: false, error: { code: 'NotFound', reason: `No run ${jobId} exists.` } };
      if (!canTransition('attempt', job.state, 'Paused')) {
        return {
          ok: false,
          error: invalid(`Illegal attempt transition ${job.state} -> Paused`, [
            { path: 'state', message: unreachableFrom(job.state, 'Paused') },
          ]),
        };
      }
      const writer = this.writers.get(jobId) ?? { holder: null, disposition: 'Unleased' as const, expiresAt: null, reconciliationReason: null };
      const paused: RunJobView = { ...job, state: 'Paused', updatedAt: START };
      this.recordedRuns.set(jobId, paused);
      return ok({
        job: paused,
        checkpoint: this.checkpoints.get(jobId) ?? null,
        writer,
        writerStopped: writer.disposition === 'Vacant' || writer.disposition === 'Unleased',
      });
    },

    resumeRun: async (jobId: JobId): Promise<Result<ResumedRunView, DomainError>> => {
      const scripted = this.takeScripted('resumeRun');
      if (scripted !== null) return { ok: false, error: scripted };
      const job = this.jobOf(jobId);
      if (job === null) return { ok: false, error: { code: 'NotFound', reason: `No run ${jobId} exists.` } };
      const checkpoint = this.checkpoints.get(jobId);
      if (checkpoint === undefined) {
        return {
          ok: false,
          error: blocked(`Job ${jobId} has no recorded resume point, so there is nothing to resume from (F17-AC2).`, [
            { name: 'resume-point', detail: `Job ${jobId} is ${job.state} and no checkpoint has been written for it.`, remedy: 'Write the resume point while the writer still holds the job, then resume it.' },
          ]),
        };
      }
      const resumed: RunJobView = { ...job, state: 'Running', updatedAt: START };
      this.recordedRuns.set(jobId, resumed);
      return ok({ job: resumed, checkpoint });
    },

    cancelRun: async (jobId: JobId): Promise<Result<CancelledRunView, DomainError>> => {
      const scripted = this.takeScripted('cancelRun');
      if (scripted !== null) return { ok: false, error: scripted };
      const job = this.jobOf(jobId);
      if (job === null) return { ok: false, error: { code: 'NotFound', reason: `No run ${jobId} exists.` } };
      if (!canTransition('attempt', job.state, 'Cancelled')) {
        return {
          ok: false,
          error: invalid(`Illegal attempt transition ${job.state} -> Cancelled`, [
            { path: 'state', message: `From ${job.state} the reachable states are: ${REACHABLE_FROM[job.state]?.join(', ') ?? 'none; it is terminal'}.` },
          ]),
        };
      }
      const cancelled: RunJobView = { ...job, state: 'Cancelled', updatedAt: START };
      this.recordedRuns.set(jobId, cancelled);
      return ok({
        job: cancelled,
        preservedCheckpoint: this.checkpoints.get(jobId) ?? null,
        writer: this.writers.get(jobId) ?? { holder: null, disposition: 'Unleased', expiresAt: null, reconciliationReason: null },
        externalDelivery: 'UnchangedByCancellation',
      });
    },

    grantExtension: async (command: DecideExtensionCommand): Promise<Result<GrantedExtensionView, DomainError>> => {
      const job = this.jobOf(command.jobId);
      if (job === null) return { ok: false, error: { code: 'NotFound', reason: `No run ${command.jobId} exists.` } };
      if (job.state !== 'WaitingForOwner') {
        return {
          ok: false,
          error: conflict(`Job ${command.jobId} is ${job.state}, so there is no reached limit to extend.`, 'WaitingForOwner', job.state),
        };
      }
      const resumed: RunJobView = { ...job, state: 'Running', updatedAt: START };
      this.recordedRuns.set(command.jobId, resumed);
      return ok({
        job: resumed,
        previousLimits: { activeExecutionMs: 3_600_000, automatedFixPasses: 2 },
        extendedLimits: { activeExecutionMs: 7_200_000, automatedFixPasses: 4 },
        extendedBoundRecorded: false,
        decidedBy: command.actor,
        decidedAt: START,
      });
    },

    declineExtension: async (command: DecideExtensionCommand): Promise<Result<DeclinedExtensionView, DomainError>> => {
      const job = this.jobOf(command.jobId);
      if (job === null) return { ok: false, error: { code: 'NotFound', reason: `No run ${command.jobId} exists.` } };
      if (job.state !== 'WaitingForOwner') {
        return {
          ok: false,
          error: conflict(`Job ${command.jobId} is ${job.state}, so there is no pending extension request to decline.`, 'WaitingForOwner', job.state),
        };
      }
      return ok({
        job,
        limitsInForce: { activeExecutionMs: 3_600_000, automatedFixPasses: 2 },
        decidedBy: command.actor,
        decidedAt: START,
      });
    },
  };

  readonly attention = {
    collectAttention: async (command: { projectId: string | null; at: string }): Promise<Result<AttentionBoardView, DomainError>> => {
      const scripted = this.takeScripted('collectAttention');
      if (scripted !== null) return { ok: false, error: scripted };
      const projectId = command.projectId ?? PROJECT_ID;
      const items: AttentionItemView[] = [...this.attentionItems.values()].filter((item) => item.projectId === projectId);
      return ok({
        projectId,
        collectedAt: command.at,
        items,
        groups: ATTENTION_BUCKETS.map((bucket: AttentionBucket) => ({
          bucket,
          items: items.filter((item) => ATTENTION_BUCKET_OF[item.kind] === bucket && item.state !== 'Resolved'),
        })).filter((group) => group.items.length > 0),
        persistedItemIds: [...this.attentionItems.keys()],
      });
    },

    acknowledge: async (command: { attentionItemId: AttentionItemId; actor: OwnerId }): Promise<Result<AttentionItemView, DomainError>> => {
      const existing = this.attentionItems.get(command.attentionItemId);
      if (existing === undefined) return { ok: false, error: { code: 'NotFound', reason: 'No such attention item.' } };
      const acknowledged: AttentionItemView = {
        ...existing,
        state: 'Acknowledged',
        acknowledgedAt: START,
        acknowledgedBy: command.actor,
      };
      this.attentionItems.set(command.attentionItemId, acknowledged);
      return ok(acknowledged);
    },
  };

  readonly reviewCards = {
    buildReviewCard: async (jobId: JobId): Promise<Result<ReviewCardView, DomainError>> => {
      const scripted = this.takeScripted('buildReviewCard');
      if (scripted !== null) return { ok: false, error: scripted };
      const job = this.jobOf(jobId);
      if (job === null) return { ok: false, error: { code: 'NotFound', reason: `No run ${jobId} exists.` } };
      const card = this.cards.get(job.workItemId);
      if (card === undefined) {
        return {
          ok: false,
          error: {
            code: 'NotFound',
            reason: `Work item ${job.workItemId} has recorded no candidate yet, so there is nothing for a review card to describe (F24-AC2).`,
          },
        };
      }
      return ok(card);
    },
  };

  /**
   * The acceptance group of this double.
   *
   * Backed by real stored state rather than canned answers, because the two properties
   * worth proving here are relational: feedback is retained across decisions, and
   * acceptance is refused while a criterion is outstanding. A double that answered both
   * from a fixed map would pass without either (F25-AC1, F25-AC2).
   */
  /**
   * The generation group. The double records a tracked run rather than a result, because a model
   * turn is asynchronous: the owner action returns an identity and a later read returns the
   * outcome. A double that answered inline would not exercise the property this group exists for.
   */
  readonly generation = {
    startBriefGeneration: async (command: { readonly ideaId: string; readonly actor: string }): Promise<Result<GenerationRunView, DomainError>> =>
      ({ ok: true, value: this.recordGeneration(command.ideaId, 'Brief') }),
    startPlanGeneration: async (command: { readonly ideaId: string; readonly actor: string }): Promise<Result<GenerationRunView, DomainError>> =>
      ({ ok: true, value: this.recordGeneration(command.ideaId, 'Plan') }),
    getGeneration: async (generationId: string): Promise<Result<GenerationRunView, DomainError>> => {
      const found = this.generationRuns.get(generationId);
      return found === undefined
        ? { ok: false, error: { code: 'NotFound', reason: `no generation run ${generationId}` } }
        : { ok: true, value: found };
    },
    listGenerations: async (ideaId: string): Promise<Result<readonly GenerationRunView[], DomainError>> =>
      ({ ok: true, value: [...this.generationRuns.values()].filter((run) => run.ideaId === ideaId) }),
  };

  private readonly generationRuns = new Map<string, GenerationRunView>();

  private recordGeneration(ideaId: string, pass: GenerationRunView['pass']): GenerationRunView {
    const run: GenerationRunView = {
      generationId: `gen-${String(this.generationRuns.size + 1)}`,
      pass,
      ideaId,
      state: 'Succeeded',
      startedAt: '2026-10-02T10:00:00.000Z',
      finishedAt: '2026-10-02T10:00:04.000Z',
      connectorId: 'engine_fixture',
      engineVersion: '0.159.1',
      sessionId: 'fixture-session',
      brief: pass === 'Brief'
        ? {
            briefId: `brief-${String(this.generationRuns.size + 1)}`,
            version: 1,
            state: 'Proposed',
            authoredBy: 'ClarificationModel',
            questionCount: 1,
            rejectedCandidateCount: 0,
          }
        : null,
      plan: pass === 'Plan'
        ? {
            planId: `plan-${String(this.generationRuns.size + 1)}`,
            revision: 1,
            taskCount: 2,
            coveredOutcomeIds: ['brief.desiredOutcome', 'AC1'],
            splitJustifications: ['two independently reviewable surfaces'],
          }
        : null,
      failure: null,
      capability: {
        name: 'read-only',
        mayChangeApplicationCode: false,
        mayPublishTickets: false,
        mayDeploy: false,
        mayStartCodingRun: false,
        forbiddenSideEffects: ['publication', 'deployment', 'delivery'],
      },
    };
    this.generationRuns.set(run.generationId, run);
    return run;
  }

  readonly acceptance = {
    requestChanges: async (command: {
      readonly jobId: JobId;
      readonly reason: string;
      readonly actor: string;
      readonly at: string;
    }): Promise<Result<ChangeRequestReportView, DomainError>> => {
      const scripted = this.takeScripted('requestChanges');
      if (scripted !== null) return { ok: false, error: scripted };
      const gate = this.gateOf(command.jobId);
      if (!gate.ok) return gate;
      const decisionId = `decision-change-${this.feedback.length + 1}`;
      this.feedback.push({ decisionId, feedback: command.reason });
      this.acceptanceStates.set(gate.value.candidateId, {
        candidateId: gate.value.candidateId,
        candidateFingerprint: gate.value.gate.candidateFingerprint,
        state: 'ChangesRequested',
        decisionId,
        ownerId: command.actor,
        decidedAt: command.at,
        note: null,
        staleReasons: [],
        retainedFeedback: [...this.feedback],
      });
      return ok({
        candidateId: gate.value.candidateId,
        workItemId: this.jobOf(command.jobId)?.workItemId ?? 'work-item-unknown',
        decisionId,
        state: 'ChangesRequested',
        ownerId: command.actor,
        decidedAt: command.at,
        feedback: command.reason,
        outstandingCriterionIds: [...gate.value.gate.outstandingCriterionIds],
      });
    },

    recordAcceptance: async (command: {
      readonly jobId: JobId;
      readonly note: string | null;
      readonly actor: string;
      readonly at: string;
    }): Promise<Result<AcceptanceReportView, DomainError>> => {
      const scripted = this.takeScripted('recordAcceptance');
      if (scripted !== null) return { ok: false, error: scripted };
      const gate = this.gateOf(command.jobId);
      if (!gate.ok) return gate;
      if (gate.value.gate.outstandingCriterionIds.length > 0) {
        const outstandingIds = new Set(gate.value.gate.outstandingCriterionIds);
        return {
          ok: false,
          error: {
            code: 'Blocked',
            reason: `This candidate cannot be accepted yet: ${outstandingIds.size} of ${gate.value.gate.criteria.length} criteria are not verified (F25-AC1).`,
            prerequisites: gate.value.gate.criteria
              .filter((entry) => outstandingIds.has(entry.criterionId))
              .map((entry) => ({
                name: `Criterion ${entry.criterionId}`,
                detail: entry.observed
                  ? `It is ${entry.status} under the ${entry.methodKind} method.`
                  : 'No observation of it is recorded for this candidate.',
                remedy: 'Record the owner test for this criterion, or request changes with what is wrong.',
              })),
          },
        };
      }
      const decisionId = `decision-accept-${this.acceptanceStates.size + 1}`;
      this.acceptanceStates.set(gate.value.candidateId, {
        candidateId: gate.value.candidateId,
        candidateFingerprint: gate.value.gate.candidateFingerprint,
        state: 'Accepted',
        decisionId,
        ownerId: command.actor,
        decidedAt: command.at,
        note: command.note,
        staleReasons: [],
        retainedFeedback: [...this.feedback],
      });
      return ok({
        candidateId: gate.value.candidateId,
        workItemId: this.jobOf(command.jobId)?.workItemId ?? 'work-item-unknown',
        decisionId,
        state: 'Accepted',
        ownerId: command.actor,
        decidedAt: command.at,
        candidateFingerprint: gate.value.gate.candidateFingerprint,
        headSha: gate.value.gate.headSha,
        scopeFingerprint: gate.value.gate.scopeFingerprint,
        observedDeployments: [],
        feedbackHonoured: [...this.feedback],
      });
    },

    currentAcceptance: async (jobId: JobId): Promise<Result<AcceptanceView, DomainError>> => {
      const gate = this.gateOf(jobId);
      if (!gate.ok) return gate;
      const existing = this.acceptanceStates.get(gate.value.candidateId);
      return ok(
        existing ?? {
          candidateId: gate.value.candidateId,
          candidateFingerprint: gate.value.gate.candidateFingerprint,
          state: 'Undecided',
          decisionId: null,
          ownerId: null,
          decidedAt: null,
          note: null,
          staleReasons: [],
          retainedFeedback: [],
        },
      );
    },

    acceptanceGate: async (jobId: JobId): Promise<Result<AcceptanceGateView, DomainError>> => {
      const gate = this.gateOf(jobId);
      return gate.ok ? ok(gate.value.gate) : gate;
    },
  };

  /**
   * The owner-test group of this double.
   *
   * Real rather than canned, because the two properties worth proving at this boundary are
   * relational and a canned answer would pass without either: the observation is filed under
   * the exact candidate fingerprint the request claimed, and a submission claiming a
   * fingerprint that is no longer current is a `Conflict` naming both identities rather than a
   * write against whatever happens to be current now (F24-AC4, F20-AC3).
   *
   * The deployment binding is not re-derived here. It is the controller's judgement, and
   * `controller/src/owner-tests.test.ts` is where a deployment the candidate does not carry is
   * proved to be refused; a double that copied that rule would be a second copy of it, and a
   * double that ignored it would let a route dropping the field read as covered here.
   */
  readonly ownerTests = {
    recordOwnerObservation: async (command: {
      readonly jobId: JobId;
      readonly criterionId: string;
      readonly expectedCandidateFingerprint: string;
      readonly observation: 'BehaviorConfirmed' | 'BehaviorFailed' | 'CaptureFailed';
      readonly observedAgainst: OwnerObservationTarget;
      readonly evidence: { readonly kind: 'Screenshot' | 'ApiExchange' | 'CheckOutput'; readonly reference: string };
      readonly note: string | null;
      readonly actor: OwnerId;
    }): Promise<Result<OwnerObservationReportView, DomainError>> => {
      const scripted = this.takeScripted('recordOwnerObservation');
      if (scripted !== null) return { ok: false, error: scripted };
      const gate = this.gateOf(command.jobId);
      if (!gate.ok) return gate;
      const currentFingerprint = gate.value.gate.candidateFingerprint;
      if (command.expectedCandidateFingerprint !== currentFingerprint) {
        return {
          ok: false,
          error: conflict(
            'This submission was prepared against a candidate that is no longer the current one; nothing was recorded (F24-AC4).',
            command.expectedCandidateFingerprint,
            currentFingerprint,
          ),
        };
      }
      const deployed = command.observedAgainst.kind === 'Deployment';
      const key = `${gate.value.candidateId}|${currentFingerprint}`;
      const previous = this.ownerObservations.get(key) ?? [];
      const observation: OwnerObservationView = {
        evidenceId: `evid-owner-test-${previous.length + 1}`,
        criterionId: command.criterionId,
        methodKind: 'OwnerTest',
        status: STATUS_FOR_OBSERVATION[command.observation],
        failureKind: FAILURE_KIND_FOR_OBSERVATION[command.observation],
        observedBy: command.actor,
        observedAt: START,
        environment: deployed ? 'Preview' : 'Local',
        component: deployed ? command.observedAgainst.component : null,
        deploymentId: deployed ? command.observedAgainst.deploymentId : null,
        evidenceKind: command.evidence.kind,
        evidenceRef: command.evidence.reference,
        detail: command.note,
        candidateId: gate.value.candidateId,
        candidateFingerprint: currentFingerprint,
        scopeFingerprint: gate.value.gate.scopeFingerprint,
        correlationId: `owner-test:${String(command.jobId)}`,
      };
      this.ownerObservations.set(
        key,
        [...previous.filter((entry) => entry.criterionId !== command.criterionId), observation],
      );
      return ok({
        observation,
        recordedForDelivery: false,
        outstandingCriterionIds: gate.value.gate.criteria
          .filter((entry) => entry.criterionId !== command.criterionId)
          .map((entry) => entry.criterionId),
      });
    },

    listOwnerObservations: async (query: {
      readonly jobId: JobId;
      readonly candidateFingerprint: string;
    }): Promise<Result<readonly OwnerObservationView[], DomainError>> => {
      const gate = this.gateOf(query.jobId);
      if (!gate.ok) return gate;
      return ok([
        ...(this.ownerObservations.get(`${gate.value.candidateId}|${query.candidateFingerprint}`) ?? []),
      ]);
    },
  };

  /** The gate a decision is judged against, resolved from the run's own candidate. */
  private gateOf(jobId: JobId): Result<{ readonly candidateId: string; readonly gate: AcceptanceGateView }, DomainError> {
    const job = this.jobOf(jobId);
    if (job === null) return { ok: false, error: { code: 'NotFound', reason: `No run ${jobId} exists.` } };
    const gate = this.gates.get(job.workItemId);
    if (gate === undefined) {
      return {
        ok: false,
        error: {
          code: 'NotFound',
          reason: `Work item ${job.workItemId} has recorded no candidate yet, so there is nothing to accept or reject (F25-AC1).`,
        },
      };
    }
    return ok(gate);
  }

  /** Seeds the run-side state the lifecycle routes act on, so a test can drive a real move. */
  seedRun(state: RunJobView, checkpoint?: RunCheckpointView, writer?: RunWriterView): void {
    this.recordedRuns.set(state.jobId, state);
    if (checkpoint !== undefined) this.checkpoints.set(state.jobId, checkpoint);
    if (writer !== undefined) this.writers.set(state.jobId, writer);
  }

  seedAttentionItem(item: AttentionItemView): void {
    this.attentionItems.set(item.attentionItemId, item);
  }

  seedReviewCard(workItemId: string, card: ReviewCardView): void {
    this.cards.set(workItemId, card);
  }

  seedAcceptanceGate(workItemId: string, gate: AcceptanceGateView, candidateId: string): void {
    this.gates.set(workItemId, { candidateId, gate });
  }

  private jobOf(jobId: JobId): RunJobView | null {
    return this.recordedRuns.get(jobId) ?? null;
  }

  private viewOf(jobId: JobId): Result<RunView, DomainError> {
    const job = this.jobOf(jobId);
    if (job === null) return { ok: false, error: { code: 'NotFound', reason: `No run ${jobId} exists.` } };
    return ok({
      job,
      checkpoint: this.checkpoints.get(jobId) ?? null,
      writer: this.writers.get(jobId) ?? { holder: null, disposition: 'Unleased', expiresAt: null, reconciliationReason: null },
    });
  }

  private startView(job: RunJobView, deduplicated: boolean, at: string): RunStartView {
    const held = [...this.recordedRuns.values()].filter((other) => other.holder !== null && other.jobId !== job.jobId).map((other) => other.jobId);
    return {
      job,
      deduplicated,
      capturedScope: {
        scopeSnapshotId: job.scopeSnapshotId,
        workItemId: job.workItemId,
        sequenceNumber: 1,
        scopeFingerprint: fingerprint({ scope: job.scopeSnapshotId }),
        capturedAt: at,
      },
      dispatch: {
        state: 'Queued',
        heldByWriter: held,
        reason:
          held.length === 0
            ? 'No other job holds the single global coding writer, so the coding worker can claim this job (F13-AC2).'
            : `The single global coding writer is held for ${held.join(', ')}, so this job stays Queued until that writer finishes (F13-AC2).`,
      },
      grant: {
        mode: job.mode,
        permittedOperations: job.permittedOperations,
        refusedDeliveryOperations: ['Merge', 'Release', 'RecoveryRedeploy'],
        refusalReason: 'Merge: a coding actor may never hold delivery authority (F03-AC5).',
      },
      requestedByOwner: OWNER_ID,
    };
  }
}

let decoyHashCache: string | null = null;

/** A credential digest nobody knows, so an unknown owner still costs the same work. */
function decoyHash(): string {
  if (decoyHashCache === null) {
    const hashed = hashPassword('a-password-nobody-presented');
    if (!hashed.ok) throw new Error('The decoy credential must satisfy the domain policy.');
    decoyHashCache = hashed.value;
  }
  return decoyHashCache;
}

/** The same digest the server stores, so the fake matches on what the wire presents. */
function hashToken(token: string): string {
  return hashSessionToken(token);
}

function profileContent(overrides: Partial<ProfileContent> = {}): ProfileContent {
  const base: ProfileContent = {
    references: {
      repository: REPOSITORY,
      ticketProvider: 'linear',
      ticketTeamKey: TEAM_KEY,
      baseBranch: 'main',
      targetBranch: 'ship/loop-1',
      deploymentProvider: 'vercel',
      engine: 'codex',
      previewComponents: [{ component: 'web', environment: 'preview' }],
    },
    policy: {
      requiredChecks: ['typecheck', 'test'],
      deliveryBehavior: 'ManualAuthorizationOnly',
      maxFixPasses: 2,
      workspaceIsolation: 'WorktreeAndDataDirectory',
      capabilityVersion: 1,
    },
    recipe: 'pnpm install && pnpm check && pnpm test',
    environment: { runtime: 'node24', ports: [4100], secretReferences: ['linear/octopus-main'] },
  };
  return { ...base, ...overrides };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly controller: InMemoryController;
  readonly clock: { now: () => Date; advance: (seconds: number) => void };
  readonly close: () => Promise<void>;
}

async function harness(options: { readonly config?: Partial<ServerConfig>; readonly provisionOwner?: boolean } = {}): Promise<Harness> {
  const clock = createClock(START);
  const controller = new InMemoryController(clock.now, ADAPTER_CAPABILITIES, options.provisionOwner ?? true);
  const config: ServerConfig = { ...testConfig(), ...options.config };
  const app = await buildApp({ config, controller, now: clock.now });
  return { app, controller, clock, close: () => app.close() };
}

function setCookieHeader(response: InjectedResponse): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  assert.equal(typeof header, 'string', 'the response must set exactly one cookie');
  return typeof header === 'string' ? header : '';
}

function cookieFrom(response: InjectedResponse): string {
  const header = setCookieHeader(response);
  const value = /^[A-Za-z0-9_]+=([^;]*)/.exec(header);
  assert.ok(value !== null, `the Set-Cookie header must carry a value: ${header}`);
  return `${SESSION_COOKIE_NAME}=${value[1] ?? ''}`;
}

function parse<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

/** The parts of an injected response these tests read. */
interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: NodeJS.Dict<string | string[] | number | undefined>;
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

/** The closure each stale reason stands for, so the stored explanation is actionable. */
const STALE_REASON_TEXT: Readonly<Record<ContractStaleReason, string>> = Object.freeze({
  RequestChanged: 'The request this revision answers has changed.',
  SurroundingContextChanged: 'Something the contract depends on outside the contract has changed.',
  WithdrawnByOwner: 'The owner withdrew this revision without replacing it.',
});

/** The contract content a request body sends, as the MVP's own example. */
const CONTRACT_CONTENT = {
  outcome: 'The order summary shows the total including tax.',
  scope: ['Sum the line items before tax', 'Apply the configured tax rate'],
  outOfScope: ['Changing the tax rate'],
  acceptanceCriteria: [
    { id: 'AC1', description: 'The summary returns 200 and displays "Total: 12.00".', verificationType: 'automated' },
    { id: 'AC2', description: 'The owner confirms the total matches the invoice they were sent.', verificationType: 'owner_test' },
  ],
} as const;

const CHANGED_CONTRACT_CONTENT = {
  ...CONTRACT_CONTENT,
  outcome: 'The order summary shows the total including tax and shipping.',
  scope: [...CONTRACT_CONTENT.scope, 'Show the currency code'],
} as const;

/** Creates a request and returns it, so a case can start from a real one. */
async function createRequest(h: Harness, session: Session, projectId = PROJECT_ID): Promise<RequestView> {
  const response = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/requests`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { title: 'Checkout totals', description: 'The order summary shows the pre-tax total.' },
  });
  assert.equal(response.statusCode, 201, `request creation failed: ${response.body}`);
  return parse<{ request: RequestView }>(response).request;
}

/** Drafts revision 1 for a request and returns it. */
async function draftContract(
  h: Harness,
  session: Session,
  requestId: string,
  projectId = PROJECT_ID,
): Promise<ContractView> {
  const response = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/requests/${requestId}/contracts`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: CONTRACT_CONTENT,
  });
  assert.equal(response.statusCode, 201, `contract drafting failed: ${response.body}`);
  return parse<{ contract: ContractView }>(response).contract;
}

/** Approves a revision and returns it. */
async function approveRevision(
  h: Harness,
  session: Session,
  contractId: string,
  revision: number,
  projectId = PROJECT_ID,
): Promise<ContractView> {
  const response = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/contracts/${contractId}/${revision}/approve`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: {},
  });
  assert.equal(response.statusCode, 200, `approval failed: ${response.body}`);
  return parse<{ contract: ContractView }>(response).contract;
}

async function signIn(app: FastifyInstance, identifier = OWNER_NAME, password = OWNER_PASSWORD): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: { identifier, password },
  });
  assert.equal(response.statusCode, 200, `sign-in failed: ${response.body}`);
  const body = parse<OwnerPayload>(response);
  return { cookie: cookieFrom(response), csrfToken: body.csrfToken };
}

/**
 * Creates a project the owner can then select (F02-AC1).
 *
 * The CSRF header is the one the guard reads, named here rather than repeated: a write that
 * looks anonymous fails with a refusal about forgery protection, which reads as an
 * authorization failure and hides the real mistake.
 */
async function createProject(h: Harness, session: Session, projectId: string, name: string): Promise<void> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { projectId, name },
  });
  assert.ok(response.statusCode === 200 || response.statusCode === 201, `project creation failed: ${response.body}`);
}

async function seedProfile(h: Harness, session: Session, projectId = PROJECT_ID): Promise<ProfilePayload> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { projectId, content: profileContent() },
  });
  assert.equal(response.statusCode, 201, `profile save failed: ${response.body}`);
  return parse<ProfilePayload>(response);
}

async function seedConnector(h: Harness, session: Session, projectId = PROJECT_ID): Promise<ConnectorPayload> {
  const response = await h.app.inject({
    method: 'POST',
    url: `/api/profiles/${projectId}/connectors`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: {
      provider: 'linear',
      kind: 'Ticket',
      resourceScope: `${TEAM_KEY} team`,
      credentialReference: CREDENTIAL_REFERENCE,
    },
  });
  assert.equal(response.statusCode, 201, `connector registration failed: ${response.body}`);
  return parse<ConnectorPayload>(response);
}

test('F01-AC1: every private route refuses an anonymous request and leaks nothing', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  await seedProfile(h, session);
  await seedConnector(h, session);

  const anonymous: { readonly method: 'GET' | 'POST'; readonly url: string; readonly payload?: Record<string, unknown> }[] = [
    { method: 'GET', url: '/api/owner/session' },
    { method: 'GET', url: `/api/profiles/${PROJECT_ID}` },
    { method: 'GET', url: `/api/profiles/${PROJECT_ID}/versions` },
    { method: 'GET', url: `/api/profiles/${PROJECT_ID}/connectors` },
    { method: 'POST', url: '/api/profiles', payload: { projectId: PROJECT_ID, content: profileContent() } },
    {
      method: 'POST',
      url: `/api/profiles/${PROJECT_ID}/connectors`,
      payload: { provider: 'linear', kind: 'Ticket', resourceScope: 'OCT', credentialReference: CREDENTIAL_REFERENCE },
    },
    { method: 'POST', url: '/api/connectors/con_1/revoke', payload: { reason: 'no longer needed' } },
    { method: 'POST', url: '/api/owner/sign-out' },
    { method: 'GET', url: '/artifacts/run-1/evidence.txt' },
  ];

  for (const request of anonymous) {
    const response = await h.app.inject({
      method: request.method,
      url: request.url,
      ...(request.payload === undefined ? {} : { payload: request.payload }),
    });
    assert.equal(response.statusCode, 401, `${request.method} ${request.url} must refuse an anonymous request`);
    const body = response.body;
    assert.equal(parse<ErrorPayload>(response).error.code, 'Unauthorized');
    for (const marker of [REPOSITORY, TEAM_KEY, CREDENTIAL_REFERENCE, PROJECT_ID, SEEDED_SECRET, OWNER_NAME, 'profileVersionId', 'credentialReference']) {
      assert.ok(!body.includes(marker), `${request.url} leaked ${marker}: ${body}`);
    }
  }
});

test('F01-AC1: an unknown private path answers identically with and without a session', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const anonymous = await h.app.inject({ method: 'GET', url: '/api/there-is-no-such-route' });
  assert.equal(anonymous.statusCode, 401);
  assert.ok(!anonymous.body.includes('route'), `the refusal must not describe the missing route: ${anonymous.body}`);

  const session = await signIn(h.app);
  const authenticated = await h.app.inject({
    method: 'GET',
    url: '/api/there-is-no-such-route',
    headers: { cookie: session.cookie },
  });
  assert.equal(authenticated.statusCode, 404);
  assert.equal(parse<ErrorPayload>(authenticated).error.code, 'NotFound');
});

test('F01-AC2, F01-AC4: sign-in sets an HttpOnly, Secure, SameSite session cookie', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: { identifier: OWNER_NAME, password: OWNER_PASSWORD },
  });
  assert.equal(response.statusCode, 200);
  const setCookie = setCookieHeader(response);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=\d+/);
  assert.equal(/SameSite=None/.test(setCookie), false);

  const body = parse<OwnerPayload>(response);
  assert.equal(body.owner.displayName, OWNER_NAME);
  assert.ok(!response.body.includes(OWNER_PASSWORD), 'the response must not echo the password');
  assert.ok(!response.body.includes(SEEDED_SECRET));
});

test('F02-AC1, F02-AC4: the session response names the project it addresses, or says none is selected', async (t) => {
  // The defect this closes: the session response carried no project identity, so the client
  // reached for one it did not have and every project-scoped request went out for a project
  // literally named "undefined". The server's honest 404 was then reported as "that project
  // has no saved profile yet" — a different and wrong claim about a project's contents
  // (F02-AC1, F02-AC4).
  await t.test('an owner who has selected nothing is told so, with a count rather than a blank', async () => {
    const h = await harness();
    const session = await signIn(h.app);

    const response = await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: session.cookie } });
    assert.equal(response.statusCode, 200);
    const body = parse<OwnerPayload>(response);

    // A real onboarding state. The narrowing is the assertion: the count is only reachable
    // on the variant that means "nothing is selected", so reading it proves the server said
    // that rather than that a test read past a missing field.
    const project = body.owner.activeProject;
    assert.equal(project.state, 'NoProjectSelected');
    assert.equal(project.state === 'NoProjectSelected' ? project.selectableProjectCount : -1, 0);
    // And no id to interpolate into a path: the field a project-scoped URL is built from is
    // absent rather than present-and-empty, which is what produced `/api/profiles/undefined`.
    assert.equal('activeProjectId' in project, false);
  });

  await t.test('a selected project arrives with its identity and its name', async () => {
    const h = await harness();
    const session = await signIn(h.app);
    await createProject(h, session, 'checkout', 'Checkout');

    const before = parse<OwnerPayload>(
      await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: session.cookie } }),
    );
    // Creating a project does not select it: the owner chooses, and a create that also
    // switched context would silently redirect every other project-scoped page (F02-AC2).
    assert.equal(before.owner.activeProject.state, 'NoProjectSelected');
    assert.equal(
      before.owner.activeProject.state === 'NoProjectSelected' ? before.owner.activeProject.selectableProjectCount : 0,
      1,
      'the one project is offered for selection',
    );

    const selected = await h.app.inject({
      method: 'PUT',
      url: '/api/owner/active-project',
      headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
      payload: { projectId: 'checkout' },
    });
    assert.equal(selected.statusCode, 200, selected.body);
    assert.deepEqual(parse<{ activeProject: ActiveProjectView }>(selected).activeProject, {
      state: 'Selected',
      activeProjectId: 'checkout',
      activeProjectName: 'Checkout',
    });

    const after = parse<OwnerPayload>(
      await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: session.cookie } }),
    );
    assert.deepEqual(after.owner.activeProject, {
      state: 'Selected',
      activeProjectId: 'checkout',
      activeProjectName: 'Checkout',
    });
    // The rest of the identity travels on the same response: the display name and the owner
    // id (F01-AC1). The address is asserted against what this harness actually recorded,
    // because the pre-provisioned harness has no provision call to have derived one.
    assert.equal(after.owner.displayName, OWNER_NAME);
    assert.equal(after.owner.ownerId, OWNER_ID);
    assert.equal(after.owner.email, h.controller.provisionedEmail());
  });

  await t.test('the selection survives a reload, because the server holds it', async () => {
    const h = await harness();
    const session = await signIn(h.app);
    await createProject(h, session, 'checkout', 'Checkout');
    await h.app.inject({
      method: 'PUT',
      url: '/api/owner/active-project',
      headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
      payload: { projectId: 'checkout' },
    });

    // Every reload answers the same. A client-held selection would be gone here, and the
    // project-scoped request that followed would address nothing (F02-AC1). The assertion
    // reads the union rather than narrowing it, so a change to the variant is a change to
    // what these lines prove.
    for (const attempt of [1, 2, 3]) {
      const response = await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: session.cookie } });
      const project = parse<OwnerPayload>(response).owner.activeProject;
      assert.equal(project.state, 'Selected', `load ${attempt} must still name the project`);
      assert.equal(
        project.state === 'Selected' ? project.activeProjectId : null,
        'checkout',
        `load ${attempt} must name the same project`,
      );
    }

    // And it survives a new session: the sign-in response carries it too.
    const fresh = await signIn(h.app);
    const body = parse<OwnerPayload>(
      await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: fresh.cookie } }),
    );
    assert.equal(body.owner.activeProject.state, 'Selected');
  });
});

test('F02-AC4: selecting a project this deployment does not hold is a 404, not a silent success', async () => {
  const h = await harness();
  const session = await signIn(h.app);

  const missing = await h.app.inject({
    method: 'PUT',
    url: '/api/owner/active-project',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { projectId: 'no-such-project' },
  });
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(parse<ErrorPayload>(missing).error.code, 'NotFound');

  // The refusal changed nothing, so the session still reports the onboarding state rather
  // than a project that does not exist (F02-AC1).
  const body = parse<OwnerPayload>(
    await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: session.cookie } }),
  );
  assert.equal(body.owner.activeProject.state, 'NoProjectSelected');
});

test('F02-AC4: a project id that is a path, and a null selection, are both refused', async () => {
  const h = await harness();
  const session = await signIn(h.app);

  for (const projectId of ['../etc', 'a/b', 'a\\b', '  ']) {
    const response = await h.app.inject({
      method: 'PUT',
      url: '/api/owner/active-project',
      headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
      payload: { projectId },
    });
    assert.equal(response.statusCode, 400, `"${projectId}" must be refused: ${response.body}`);
    assert.equal(parse<ErrorPayload>(response).error.code, 'Invalid');
  }

  // Null is refused rather than accepted: "no project selected" is reached by never
  // selecting one, so a client asking to select nothing is expressing something the write
  // has no meaning for (F02-AC1).
  const nulled = await h.app.inject({
    method: 'PUT',
    url: '/api/owner/active-project',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { projectId: null },
  });
  assert.equal(nulled.statusCode, 400, nulled.body);

  // An unknown key is refused rather than dropped, so a body that meant to select something
  // else cannot appear to have succeeded (F02-AC4).
  const extra = await h.app.inject({
    method: 'PUT',
    url: '/api/owner/active-project',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { projectId: 'checkout', activeProjectName: 'A name the client invented' },
  });
  assert.equal(extra.statusCode, 400, extra.body);
});

/* -------------------------------------------------------------------------- */
/* Requests and delivery contracts (mvp-spec 3)                               */
/* -------------------------------------------------------------------------- */

test('mvp-spec 3: a request is created and read without an engine, a provider or a session cookie trick', async () => {
  const h = await harness();
  const session = await signIn(h.app);

  const created = await createRequest(h, session);
  assert.equal(created.projectId, PROJECT_ID);
  assert.equal(created.title, 'Checkout totals');
  assert.equal(created.description, 'The order summary shows the pre-tax total.');
  assert.equal(created.sourceIdeaId, null);

  const detail = parse<RequestDetailView>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/requests/${created.requestId}`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(detail.request.requestId, created.requestId);
  assert.equal(detail.latestRevision, null);
  assert.equal(detail.approvedRevision, null);
  assert.deepEqual(detail.revisions, []);

  const listed = parse<{ requests: readonly RequestView[] }>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/requests`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(listed.requests.length, 1);
});

test('mvp-spec 3: a request draft is edited with a compare-and-set, and a stale editor gets a 409', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);

  const edited = await h.app.inject({
    method: 'PATCH',
    url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { description: 'The order summary shows the total including tax.', expectedUpdatedAt: request.updatedAt },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(parse<{ request: RequestView }>(edited).request.description, 'The order summary shows the total including tax.');

  // The same edit against the instant the editor loaded: refused, and the record is
  // unchanged, so two tabs cannot both believe they saved (F02-AC2, F24-AC4).
  const stale = await h.app.inject({
    method: 'PATCH',
    url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { title: 'Checkout totals v2', expectedUpdatedAt: request.updatedAt },
  });
  assert.equal(stale.statusCode, 409, stale.body);
  const conflict = parse<ErrorPayload>(stale).error;
  assert.equal(conflict.code, 'Conflict');
  assert.equal(conflict.expected, request.updatedAt);
  assert.notEqual(conflict.actual, request.updatedAt);

  const detail = parse<RequestDetailView>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(detail.request.title, 'Checkout totals');
});

test('mvp-spec 3: an edit with no compare-and-set, and a no-op, are both refused', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);

  const withoutInstant = await h.app.inject({
    method: 'PATCH',
    url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { title: 'Renamed' },
  });
  assert.equal(withoutInstant.statusCode, 400, withoutInstant.body);
  assert.equal(
    parse<ErrorPayload>(withoutInstant).error.fields?.some((field) => field.path === 'expectedUpdatedAt') ?? false,
    true,
    'the refusal must name the instant it required',
  );

  const noop = await h.app.inject({
    method: 'PATCH',
    url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { title: 'Checkout totals', expectedUpdatedAt: request.updatedAt },
  });
  assert.equal(noop.statusCode, 400, noop.body);
});

test('mvp-spec 3: a draft revision carries its criteria and no approval', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);

  const contract = await draftContract(h, session, request.requestId);
  assert.equal(contract.revision, 1);
  assert.equal(contract.status, 'draft');
  assert.equal(contract.approvedBy, null);
  assert.equal(contract.approvedAt, null);
  assert.equal(contract.outcome, CONTRACT_CONTENT.outcome);
  assert.deepEqual(contract.scope, [...CONTRACT_CONTENT.scope]);
  assert.deepEqual(contract.outOfScope, [...CONTRACT_CONTENT.outOfScope]);
  assert.deepEqual(contract.acceptanceCriteria, CONTRACT_CONTENT.acceptanceCriteria.map((criterion) => ({ ...criterion })));
  assert.match(contract.blockedBecause ?? '', /only an approved revision/);

  const criteria = parse<{ criteria: readonly ContractCriterionView[] }>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1/criteria`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.deepEqual(
    criteria.criteria.map((criterion) => [criterion.id, criterion.verificationType]),
    [
      ['AC1', 'automated'],
      ['AC2', 'owner_test'],
    ],
    'the criteria are listed with the verification type that decides who may settle each',
  );
});

test('mvp-spec 3: a contract with no criterion, or an unknown verification type, is refused by name', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);

  const empty = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}/contracts`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { ...CONTRACT_CONTENT, acceptanceCriteria: [] },
  });
  assert.equal(empty.statusCode, 400, empty.body);

  const invented = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}/contracts`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: {
      ...CONTRACT_CONTENT,
      acceptanceCriteria: [{ id: 'AC1', description: 'It works.', verificationType: 'vibes' }],
    },
  });
  assert.equal(invented.statusCode, 400, invented.body);
  // Refused rather than defaulted: defaulting a verification type would decide who may
  // settle a criterion on the client's behalf (mvp-spec 3).
  assert.equal(
    parse<ErrorPayload>(invented).error.fields?.some((field) => field.path.includes('verificationType')) ?? false,
    true,
  );
});

test('mvp-spec 3: a draft revision is edited in place and keeps its revision number', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);
  const contract = await draftContract(h, session, request.requestId);

  const edited = await h.app.inject({
    method: 'PATCH',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { ...CHANGED_CONTRACT_CONTENT, expectedUpdatedAt: contract.updatedAt },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  const updated = parse<{ contract: ContractView }>(edited).contract;
  assert.equal(updated.revision, 1);
  assert.equal(updated.outcome, CHANGED_CONTRACT_CONTENT.outcome);
  assert.notEqual(updated.contentFingerprint, contract.contentFingerprint);
  assert.equal(updated.status, 'draft');
});

test('mvp-spec 3: approval attributes itself to the session and carries no approver in the body', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);
  const contract = await draftContract(h, session, request.requestId);

  // A body that tries to name the approver is refused rather than ignored: a client that
  // *believed* it named the approver is the defect this route is shaped to prevent.
  const smuggled = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1/approve`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { approvedBy: 'own_somebody_else', status: 'approved' },
  });
  assert.equal(smuggled.statusCode, 400, smuggled.body);

  const approved = await approveRevision(h, session, contract.contractId, 1);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedBy, OWNER_ID, 'the approver is the session, not the body');
  assert.match(approved.approvedAt ?? '', /^2026-03-01T/);
  assert.equal(approved.blockedBecause, null);

  const detail = parse<RequestDetailView>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(detail.approvedRevision?.revision, 1);
  assert.equal(detail.latestRevision?.status, 'approved');
});

test('mvp-spec 3: an approved revision cannot be edited, and approving twice is a conflict', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);
  const contract = await draftContract(h, session, request.requestId);
  const approved = await approveRevision(h, session, contract.contractId, 1);

  const edit = await h.app.inject({
    method: 'PATCH',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { ...CHANGED_CONTRACT_CONTENT, expectedUpdatedAt: approved.updatedAt },
  });
  assert.equal(edit.statusCode, 400, edit.body);
  assert.match(edit.body, /frozen|Draft a new revision/);

  const again = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1/approve`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: {},
  });
  assert.equal(again.statusCode, 409, again.body);

  const read = parse<{ contract: ContractView }>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(read.contract.status, 'approved');
  assert.equal(read.contract.outcome, CONTRACT_CONTENT.outcome, 'the approved text is unchanged');
});

test('mvp-spec 3: revising writes the next revision and retires the old approval in one call', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);
  const contract = await draftContract(h, session, request.requestId);
  await approveRevision(h, session, contract.contractId, 1);

  const revised = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1/revise`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: CHANGED_CONTRACT_CONTENT,
  });
  assert.equal(revised.statusCode, 201, revised.body);
  const revision2 = parse<{ contract: ContractView }>(revised).contract;
  assert.equal(revision2.revision, 2);
  assert.equal(revision2.status, 'draft');
  assert.equal(revision2.approvedBy, null);
  assert.notEqual(revision2.contractId, contract.contractId, 'a revision is a different agreement');

  // The old approval no longer reads as current. This is the state the single call exists to
  // prevent: a new revision beside a still-current approval would let a candidate measured
  // against revision 1 be described by revision 2's text (mvp-spec 3).
  const detail = parse<RequestDetailView>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(detail.approvedRevision, null);
  assert.deepEqual(
    detail.revisions.map((revision) => [revision.revision, revision.status]),
    [
      [1, 'stale'],
      [2, 'draft'],
    ],
  );
  assert.equal(detail.revisions[0]?.supersededByRevision, 2);
  assert.match(detail.revisions[0]?.staleReason ?? '', /revision 2/);
  // History, not a deletion: the retired revision kept the text and the approver it had.
  assert.equal(detail.revisions[0]?.outcome, CONTRACT_CONTENT.outcome);
  assert.equal(detail.revisions[0]?.approvedBy, OWNER_ID);
});

test('mvp-spec 3: retiring an approval records the reason, and the vocabulary is closed', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);
  const contract = await draftContract(h, session, request.requestId);
  await approveRevision(h, session, contract.contractId, 1);

  const unlisted = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1/invalidate`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { reason: 'because' },
  });
  assert.equal(unlisted.statusCode, 400, unlisted.body);
  assert.equal(
    parse<ErrorPayload>(unlisted).error.fields?.some((field) => field.path === 'reason') ?? false,
    true,
  );

  const stale = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1/invalidate`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { reason: 'RequestChanged' },
  });
  assert.equal(stale.statusCode, 200, stale.body);
  const retired = parse<{ contract: ContractView }>(stale).contract;
  assert.equal(retired.status, 'stale');
  assert.match(retired.staleReason ?? '', /request this revision answers has changed/);
  assert.match(retired.blockedBecause ?? '', /only an approved revision/);

  // A second retirement is refused, so the first explanation survives.
  const again = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1/invalidate`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { reason: 'WithdrawnByOwner' },
  });
  assert.equal(again.statusCode, 409, again.body);
});

test('mvp-spec 3, F02-AC2: nothing here crosses a project boundary', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session, PROJECT_ID);
  const contract = await draftContract(h, session, request.requestId, PROJECT_ID);
  const elsewhere = `${PROJECT_ID}-other`;

  const elsewhereRequests = parse<{ requests: readonly RequestView[] }>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${elsewhere}/requests`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.deepEqual(elsewhereRequests.requests, [], 'a request is not in another project\'s list');

  const writes: readonly { readonly label: string; readonly response: InjectedResponse }[] = [
    {
      label: 'read request',
      response: await h.app.inject({
        method: 'GET',
        url: `/api/projects/${elsewhere}/requests/${request.requestId}`,
        headers: { cookie: session.cookie },
      }),
    },
    {
      label: 'edit request',
      response: await h.app.inject({
        method: 'PATCH',
        url: `/api/projects/${elsewhere}/requests/${request.requestId}`,
        headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
        payload: { title: 'Stolen', expectedUpdatedAt: request.updatedAt },
      }),
    },
    {
      label: 'read revision',
      response: await h.app.inject({
        method: 'GET',
        url: `/api/projects/${elsewhere}/contracts/${contract.contractId}/1`,
        headers: { cookie: session.cookie },
      }),
    },
    {
      label: 'approve',
      response: await h.app.inject({
        method: 'POST',
        url: `/api/projects/${elsewhere}/contracts/${contract.contractId}/1/approve`,
        headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
        payload: {},
      }),
    },
    {
      label: 'draft against a request in another project',
      response: await h.app.inject({
        method: 'POST',
        url: `/api/projects/${elsewhere}/requests/${request.requestId}/contracts`,
        headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
        payload: CONTRACT_CONTENT,
      }),
    },
    {
      label: 'list the revisions of a request in another project',
      response: await h.app.inject({
        method: 'GET',
        url: `/api/projects/${elsewhere}/requests/${request.requestId}/contracts`,
        headers: { cookie: session.cookie },
      }),
    },
    {
      label: 'read the criteria of a revision in another project',
      response: await h.app.inject({
        method: 'GET',
        url: `/api/projects/${elsewhere}/contracts/${contract.contractId}/1/criteria`,
        headers: { cookie: session.cookie },
      }),
    },
    {
      label: 'edit a revision in another project',
      response: await h.app.inject({
        method: 'PATCH',
        url: `/api/projects/${elsewhere}/contracts/${contract.contractId}/1`,
        headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
        payload: { ...CHANGED_CONTRACT_CONTENT, expectedUpdatedAt: contract.updatedAt },
      }),
    },
    {
      label: 'revise a revision in another project',
      response: await h.app.inject({
        method: 'POST',
        url: `/api/projects/${elsewhere}/contracts/${contract.contractId}/1/revise`,
        headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
        payload: CHANGED_CONTRACT_CONTENT,
      }),
    },
    {
      label: 'retire an approval in another project',
      response: await h.app.inject({
        method: 'POST',
        url: `/api/projects/${elsewhere}/contracts/${contract.contractId}/1/invalidate`,
        headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
        payload: { reason: 'WithdrawnByOwner' },
      }),
    },
  ];

  for (const { label, response } of writes) {
    assert.equal(response.statusCode, 404, `${label} must be a 404: ${response.body}`);
    assert.equal(parse<ErrorPayload>(response).error.code, 'NotFound', label);
    // Never an empty success: an empty list would tell the caller "that project has no
    // requests / no revisions", which is a claim about another project's contents and is
    // the answer that made a cross-project read look like a read that succeeded (F02-AC2).
    assert.doesNotMatch(response.body, /"(contracts|criteria)":\s*\[\]/, label);
  }

  // None of the refused writes changed anything.
  const read = parse<RequestDetailView>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(read.request.title, 'Checkout totals');
  assert.equal(read.latestRevision?.status, 'draft');
  assert.equal(read.approvedRevision, null);
});

test('mvp-spec 3, F02-AC2: an id that addresses nothing is a 404 on every route, never an empty success', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);
  const contract = await draftContract(h, session, request.requestId);

  const probes: readonly {
    readonly label: string;
    readonly method: 'GET' | 'POST' | 'PATCH';
    readonly url: string;
    readonly payload: Record<string, unknown> | null;
  }[] = [
    { label: 'read an unknown request', method: 'GET', url: `/api/projects/${PROJECT_ID}/requests/req_nope`, payload: null },
    {
      label: 'edit an unknown request',
      method: 'PATCH',
      url: `/api/projects/${PROJECT_ID}/requests/req_nope`,
      payload: { title: 'Renamed', expectedUpdatedAt: request.updatedAt },
    },
    {
      label: 'list the revisions of an unknown request',
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/requests/req_nope/contracts`,
      payload: null,
    },
    {
      label: 'draft against an unknown request',
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/requests/req_nope/contracts`,
      payload: CONTRACT_CONTENT,
    },
    {
      label: 'read an unknown contract',
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/contracts/dc_nope/1`,
      payload: null,
    },
    {
      label: 'read the criteria of an unknown contract',
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/contracts/dc_nope/1/criteria`,
      payload: null,
    },
    {
      label: 'edit an unknown contract',
      method: 'PATCH',
      url: `/api/projects/${PROJECT_ID}/contracts/dc_nope/1`,
      payload: { ...CONTRACT_CONTENT, expectedUpdatedAt: contract.updatedAt },
    },
    {
      label: 'approve an unknown contract',
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/contracts/dc_nope/1/approve`,
      payload: {},
    },
    {
      label: 'revise an unknown contract',
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/contracts/dc_nope/1/revise`,
      payload: CONTRACT_CONTENT,
    },
    {
      label: 'retire an unknown approval',
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/contracts/dc_nope/1/invalidate`,
      payload: { reason: 'WithdrawnByOwner' },
    },
    // A contract that exists with a revision number it does not hold: the pair is the
    // identity, so an absent member of it is absent, not "revision 0" and not the newest.
    {
      label: 'read a revision number that does not exist',
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/7`,
      payload: null,
    },
    {
      label: 'edit a revision number that does not exist',
      method: 'PATCH',
      url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/7`,
      payload: { ...CHANGED_CONTRACT_CONTENT, expectedUpdatedAt: contract.updatedAt },
    },
    {
      label: 'approve a revision number that does not exist',
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/7/approve`,
      payload: {},
    },
  ];

  for (const probe of probes) {
    const response = await h.app.inject({
      method: probe.method,
      url: probe.url,
      headers: { cookie: session.cookie, ...(probe.method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }) },
      ...(probe.payload === null ? {} : { payload: probe.payload }),
    });
    assert.equal(response.statusCode, 404, `${probe.label} must be a 404: ${response.body}`);
    assert.equal(parse<ErrorPayload>(response).error.code, 'NotFound', probe.label);
    assert.doesNotMatch(response.body, /"(contracts|criteria)":\s*\[\]/, probe.label);
  }

  // The real revision is still exactly where it was: a refusal that had written something
  // would be a worse answer than a refusal that did not (F02-AC2).
  const stillThere = parse<{ contract: ContractView }>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(stillThere.contract.status, 'draft');
  assert.equal(stillThere.contract.outcome, CONTRACT_CONTENT.outcome);
  assert.equal(stillThere.contract.contentFingerprint, contract.contentFingerprint);
});

test('mvp-spec 3: every revision is readable by its own number, and the listing agrees with them', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);
  const first = await draftContract(h, session, request.requestId);
  await approveRevision(h, session, first.contractId, 1);

  const revised = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${first.contractId}/1/revise`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: CHANGED_CONTRACT_CONTENT,
  });
  assert.equal(revised.statusCode, 201, revised.body);
  const second = parse<{ contract: ContractView }>(revised).contract;

  // Each revision answers under its own identity and its own number. A revision is a
  // different agreement with a fresh identity, so reading revision 2 is not "revision 2 of
  // contract X" with the number acting as decoration (mvp-spec 3).
  const readSecond = parse<{ contract: ContractView }>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/contracts/${second.contractId}/2`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(readSecond.contract.revision, 2);
  assert.equal(readSecond.contract.outcome, CHANGED_CONTRACT_CONTENT.outcome);

  // The superseded revision keeps answering at revision 1 with the text it was approved
  // under: a candidate measured against it must still be able to say what it was measured
  // against (mvp-spec 3).
  const readFirst = parse<{ contract: ContractView }>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/contracts/${first.contractId}/1`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(readFirst.contract.revision, 1);
  assert.equal(readFirst.contract.status, 'stale');
  assert.equal(readFirst.contract.outcome, CONTRACT_CONTENT.outcome);

  // The listing names exactly those two, oldest first, and carries the same identities the
  // per-revision reads did (mvp-spec 3).
  const listed = parse<{ contracts: readonly ContractView[] }>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}/contracts`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.deepEqual(
    listed.contracts.map((contract) => [contract.contractId, contract.revision, contract.status]),
    [
      [first.contractId, 1, 'stale'],
      [second.contractId, 2, 'draft'],
    ],
  );
});

test('mvp-spec 3: approval binds one exact revision and leaves every other revision as it was', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);
  const first = await draftContract(h, session, request.requestId);
  const approvedFirst = await approveRevision(h, session, first.contractId, 1);

  const revised = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${first.contractId}/1/revise`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: CHANGED_CONTRACT_CONTENT,
  });
  assert.equal(revised.statusCode, 201, revised.body);
  const second = parse<{ contract: ContractView }>(revised).contract;

  // Before the second approval nothing about the second revision is approved, and the
  // approval that exists names revision 1.
  const midway = parse<RequestDetailView>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(midway.approvedRevision, null);
  assert.equal(midway.latestRevision?.status, 'draft');

  const approvedSecond = await approveRevision(h, session, second.contractId, 2);
  assert.equal(approvedSecond.revision, 2);
  assert.equal(approvedSecond.status, 'approved');
  assert.equal(approvedSecond.approvedBy, OWNER_ID, 'the approver is the session, never the body');
  assert.match(approvedSecond.approvedAt ?? '', /^2026-03-01T/);
  assert.equal(approvedSecond.blockedBecause, null);

  // The approval is bound to the revision it was asked for: revision 1 is untouched by the
  // fact that revision 2 exists and is approved.
  const detail = parse<RequestDetailView>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(detail.approvedRevision?.contractId, second.contractId);
  assert.equal(detail.approvedRevision?.revision, 2);
  assert.deepEqual(
    detail.revisions.map((revision) => [revision.revision, revision.status]),
    [
      [1, 'stale'],
      [2, 'approved'],
    ],
  );
  assert.equal(detail.revisions[0]?.outcome, CONTRACT_CONTENT.outcome, 'revision 1 kept its own text');
  assert.equal(detail.revisions[0]?.approvedBy, OWNER_ID, 'revision 1 kept its own approver');
  assert.equal(detail.revisions[0]?.approvedAt, approvedFirst.approvedAt);
});

test('mvp-spec 3: a refused approval records nothing, so the revision is still a draft to approve', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);
  const contract = await draftContract(h, session, request.requestId);

  // No session: the guard refuses before the handler, so nothing is attributed and nothing
  // is written. This is the shape of "the executor cannot approve": there is no request
  // this server answers that approves anything without an authenticated owner's session
  // (mvp-spec 3, F01-AC1).
  const anonymous = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1/approve`,
    payload: {},
  });
  assert.equal(anonymous.statusCode, 401, anonymous.body);

  // Every attempt to name the approver, the status or the actor in the body is refused by
  // name, so a client cannot believe it chose who approved (mvp-spec 3).
  for (const payload of [
    { approvedBy: 'own_somebody_else' },
    { status: 'approved' },
    { actor: 'own_somebody_else' },
    { role: 'Owner' },
    { owner: 'own_somebody_else' },
  ]) {
    const refused = await h.app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1/approve`,
      headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
      payload,
    });
    assert.equal(refused.statusCode, 400, `${JSON.stringify(payload)} must be refused: ${refused.body}`);
  }

  // After every refusal the revision is still the draft it was, addressed by its own
  // number. A refusal that had half-approved would leave the owner unable to tell whether
  // the agreement they read is the agreement that was approved.
  const read = parse<{ contract: ContractView }>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(read.contract.status, 'draft');
  assert.equal(read.contract.approvedBy, null);
  assert.equal(read.contract.approvedAt, null);
  assert.equal(read.contract.contentFingerprint, contract.contentFingerprint);
});

test('mvp-spec 3: a retired revision is history, so it is not editable either', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);
  const contract = await draftContract(h, session, request.requestId);
  const approved = await approveRevision(h, session, contract.contractId, 1);

  const retired = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1/invalidate`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { reason: 'WithdrawnByOwner' },
  });
  assert.equal(retired.statusCode, 200, retired.body);

  // A retired revision is kept for history, which means its text still says what it said -
  // and editing it would rewrite the thing a past candidate was measured against (mvp-spec 3).
  const edit = await h.app.inject({
    method: 'PATCH',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { ...CHANGED_CONTRACT_CONTENT, expectedUpdatedAt: approved.updatedAt },
  });
  assert.equal(edit.statusCode, 400, edit.body);
  assert.match(edit.body, /stale/i);

  const read = parse<{ contract: ContractView }>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(read.contract.status, 'stale');
  assert.equal(read.contract.outcome, CONTRACT_CONTENT.outcome, 'the retired text is unchanged');
  assert.equal(read.contract.contentFingerprint, contract.contentFingerprint);
  assert.equal(read.contract.approvedBy, OWNER_ID, 'history keeps the approver it had');
});

test('mvp-spec 3: a request edit under an approved revision is reported, never absorbed', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  const request = await createRequest(h, session);
  const contract = await draftContract(h, session, request.requestId);
  const approved = await approveRevision(h, session, contract.contractId, 1);

  const edited = await h.app.inject({
    method: 'PATCH',
    url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { description: 'The order summary must also show the shipping total.', expectedUpdatedAt: request.updatedAt },
  });
  assert.equal(edited.statusCode, 200, edited.body);

  // The revision is frozen and the frozen text is what it was. What changed is whether it
  // still answers the request, and the API says so rather than letting an approval read as
  // though it covered a request nobody wrote (mvp-spec 3).
  const read = parse<{ contract: ContractView }>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/1`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(read.contract.status, 'approved', 'the approval is not silently dropped');
  assert.equal(read.contract.approvedBy, OWNER_ID);
  assert.equal(read.contract.approvedAt, approved.approvedAt);
  assert.equal(read.contract.outcome, CONTRACT_CONTENT.outcome, 'the approved text is unchanged');
  assert.equal(read.contract.contentFingerprint, contract.contentFingerprint);
  assert.equal(
    read.contract.answersCurrentRequest,
    false,
    'an approval that no longer answers the request must be reported as such, not presented as current',
  );

  // The request read carries the same report in its contract context, so a client does not
  // have to ask twice and get two different moments (mvp-spec 3).
  const detail = parse<RequestDetailView>(
    await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}`,
      headers: { cookie: session.cookie },
    }),
  );
  assert.equal(detail.approvedRevision?.answersCurrentRequest, false);
  assert.equal(detail.approvedRevision?.status, 'approved');
  assert.equal(detail.request.description, 'The order summary must also show the shipping total.');
});

test('F01-AC1: every request and contract route refuses an anonymous caller', async () => {
  const h = await harness();
  const probes: readonly {
    readonly method: 'GET' | 'POST' | 'PATCH';
    readonly url: string;
    readonly payload: Record<string, unknown> | null;
  }[] = [
    { method: 'GET', url: `/api/projects/${PROJECT_ID}/requests`, payload: null },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/requests`, payload: { title: 'x', description: 'y' } },
    { method: 'GET', url: `/api/projects/${PROJECT_ID}/requests/req_1`, payload: null },
    { method: 'PATCH', url: `/api/projects/${PROJECT_ID}/requests/req_1`, payload: { title: 'x', expectedUpdatedAt: 'y' } },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/requests/req_1/contracts`, payload: CONTRACT_CONTENT },
    { method: 'GET', url: `/api/projects/${PROJECT_ID}/requests/req_1/contracts`, payload: null },
    { method: 'GET', url: `/api/projects/${PROJECT_ID}/contracts/dc_1/1`, payload: null },
    { method: 'GET', url: `/api/projects/${PROJECT_ID}/contracts/dc_1/1/criteria`, payload: null },
    { method: 'PATCH', url: `/api/projects/${PROJECT_ID}/contracts/dc_1/1`, payload: { ...CONTRACT_CONTENT, expectedUpdatedAt: 'y' } },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/contracts/dc_1/1/approve`, payload: {} },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/contracts/dc_1/1/revise`, payload: CONTRACT_CONTENT },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/contracts/dc_1/1/invalidate`, payload: { reason: 'RequestChanged' } },
  ];

  for (const probe of probes) {
    const response = await h.app.inject({
      method: probe.method,
      url: probe.url,
      ...(probe.payload === null ? {} : { payload: probe.payload }),
    });
    assert.equal(response.statusCode, 401, `${probe.method} ${probe.url} must refuse an anonymous caller: ${response.body}`);
  }
});

test('F02-AC4: an unknown route parameter is refused, not coerced', async () => {
  const h = await harness();
  const session = await signIn(h.app);

  // A revision number is a positive integer in the path, so "zero" and "abc" cannot parse as
  // revision 0 and be silently accepted (mvp-spec 3).
  for (const revision of ['0', '-1', 'abc', '1.5']) {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/contracts/dc_1/${revision}`,
      headers: { cookie: session.cookie },
    });
    assert.equal(response.statusCode, 400, `revision "${revision}" must be refused: ${response.body}`);
  }

  // A traversal in the project segment is refused here too, because it addresses an artifact
  // root, a workspace and a git checkout (F06-AC1).
  const traversal = await h.app.inject({
    method: 'GET',
    url: `/api/projects/..%2F..%2Fetc/requests`,
    headers: { cookie: session.cookie },
  });
  assert.equal(traversal.statusCode, 400, traversal.body);
});

test('F02-AC1: the session and sign-in responses agree about the project, because both read the controller', async () => {
  const h = await harness();
  const session = await signIn(h.app);
  await createProject(h, session, 'checkout', 'Checkout');
  await h.app.inject({
    method: 'PUT',
    url: '/api/owner/active-project',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { projectId: 'checkout' },
  });

  const onLoad = parse<OwnerPayload>(
    await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: session.cookie } }),
  ).owner.activeProject;
  const onSignIn = parse<OwnerPayload>(
    await h.app.inject({
      method: 'POST',
      url: '/api/owner/sign-in',
      payload: { identifier: OWNER_NAME, password: OWNER_PASSWORD },
    }),
  ).owner.activeProject;

  // Two routes, one answer. If sign-in re-derived the project or omitted it, a client that
  // cached the sign-in response would address the wrong project until the next reload - which
  // is the class of defect this set out to close (F02-AC1, F02-AC4).
  assert.deepEqual(onLoad, onSignIn);
  assert.deepEqual(onLoad, { state: 'Selected', activeProjectId: 'checkout', activeProjectName: 'Checkout' });
});

test('F01-AC1: selecting a project needs a session and a CSRF token like any other write', async () => {
  const h = await harness();
  const anonymous = await h.app.inject({
    method: 'PUT',
    url: '/api/owner/active-project',
    payload: { projectId: 'checkout' },
  });
  assert.equal(anonymous.statusCode, 401, anonymous.body);

  const session = await signIn(h.app);
  const withoutToken = await h.app.inject({
    method: 'PUT',
    url: '/api/owner/active-project',
    headers: { cookie: session.cookie },
    payload: { projectId: 'checkout' },
  });
  assert.equal(withoutToken.statusCode, 403, withoutToken.body);

  const body = parse<OwnerPayload>(
    await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: session.cookie } }),
  );
  assert.equal(body.owner.activeProject.state, 'NoProjectSelected', 'neither refused write changed the selection');
});

test('F01-AC2: signing out revokes the session, so the old cookie stops working', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const before = await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: session.cookie } });
  assert.equal(before.statusCode, 200);

  const signedOut = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-out',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
  });
  assert.equal(signedOut.statusCode, 204);
  assert.match(setCookieHeader(signedOut), /Max-Age=0/);

  const after = await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: session.cookie } });
  assert.equal(after.statusCode, 401, 'the revoked cookie must be refused even though it is still presented');
  assert.equal(parse<ErrorPayload>(after).signInRequired, true);

  const profile = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}`,
    headers: { cookie: session.cookie },
  });
  assert.equal(profile.statusCode, 401);

  const fresh = await signIn(h.app);
  const recovered = await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: fresh.cookie } });
  assert.equal(recovered.statusCode, 200, 'signing in again must work');
  assert.notEqual(fresh.cookie, session.cookie, 'a new sign-in must mint a new token');
});

test('F01-AC2: a session past its deadline is refused', async (t) => {
  const h = await harness({ config: { sessionAbsoluteTtlSeconds: 60 } });
  t.after(() => h.close());
  const session = await signIn(h.app);
  h.clock.advance(120);
  const response = await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: session.cookie } });
  assert.equal(response.statusCode, 401);
});

test('F01-AC4: a state-changing request with no CSRF token is refused and changes nothing', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie },
    payload: { projectId: PROJECT_ID, content: profileContent() },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(parse<ErrorPayload>(response).error.code, 'Forbidden');

  const listed = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}/versions`,
    headers: { cookie: session.cookie },
  });
  assert.equal(parse<ProfileListPayload>(listed).profiles.length, 0, 'the refused save must not have stored a version');
});

test('F01-AC4: a state-changing request with the derived token succeeds', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const saved = await seedProfile(h, session);
  assert.equal(saved.profile.versionNumber, 1);
  assert.equal(saved.profile.projectId, PROJECT_ID);
  assert.equal(saved.profile.content.references.repository, REPOSITORY);
  assert.equal(saved.profile.supersedesVersionId, null);
});

test('F01-AC4: a tampered or whitespace-mutated CSRF token is refused', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const mutations: { readonly name: string; readonly token: string }[] = [
    { name: 'a different token', token: 'A'.repeat(43) },
    { name: 'one character changed', token: `${session.csrfToken.slice(0, -1)}${session.csrfToken.endsWith('A') ? 'B' : 'A'}` },
    { name: 'a trailing newline', token: `${session.csrfToken}\n` },
    { name: 'a leading space', token: ` ${session.csrfToken}` },
    { name: 'double submitted', token: `${session.csrfToken},${session.csrfToken}` },
  ];
  for (const mutation of mutations) {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: { cookie: session.cookie, 'x-shiploop-csrf': mutation.token },
      payload: { projectId: PROJECT_ID, content: profileContent() },
    });
    assert.equal(response.statusCode, 403, `${mutation.name} must be refused`);
    assert.ok(!response.body.includes('versionNumber'), `${mutation.name} must not have saved a profile`);
  }
  const safe = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}`,
    headers: { cookie: session.cookie },
  });
  assert.equal(safe.statusCode, 404, 'no version may exist after only refused saves');
});

test('F01-AC4: a CSRF token issued for one session does not work for another', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const first = await signIn(h.app);
  const second = await signIn(h.app);
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: first.cookie, 'x-shiploop-csrf': second.csrfToken },
    payload: { projectId: PROJECT_ID, content: profileContent() },
  });
  assert.equal(response.statusCode, 403);
});

test('N02-AC1: a wrong password and an unknown owner are answered identically', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const wrongPassword = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: { identifier: OWNER_NAME, password: 'not the password at all' },
  });
  const unknownOwner = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: { identifier: 'nobody-with-this-name', password: 'not the password at all' },
  });
  assert.equal(wrongPassword.statusCode, 401);
  assert.equal(unknownOwner.statusCode, 401);
  assert.equal(wrongPassword.headers['set-cookie'], undefined, 'a failed sign-in must not set a cookie');
  assert.equal(unknownOwner.headers['set-cookie'], undefined);
  assert.equal(wrongPassword.body, unknownOwner.body);
  assert.equal(parse<ErrorPayload>(unknownOwner).signInRequired, true);
});

test('F01-AC1: private responses carry the security headers and no wildcard CORS', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  await seedProfile(h, session);
  const response = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}`,
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['access-control-allow-origin'] === '*', false);
});

test('F01-AC1: a private response is never cacheable', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  await seedProfile(h, session);
  const read = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}`,
    headers: { cookie: session.cookie },
  });
  assert.equal(read.headers['cache-control'], 'no-store');

  const refused = await h.app.inject({ method: 'GET', url: `/api/profiles/${PROJECT_ID}` });
  assert.equal(refused.statusCode, 401);
  assert.equal(refused.headers['cache-control'], 'no-store', 'even a refusal must not be cached');

  const refusedSignIn = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: { identifier: OWNER_NAME, password: 'not the password at all' },
  });
  assert.equal(refusedSignIn.headers['cache-control'], 'no-store');
});

test('F02-AC3: saving appends a version and history keeps both', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const first = await seedProfile(h, session);
  const second = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { projectId: PROJECT_ID, content: profileContent({ recipe: 'pnpm install && pnpm verify' }) },
  });
  assert.equal(second.statusCode, 201);
  const secondBody = parse<ProfilePayload>(second);
  assert.equal(secondBody.profile.versionNumber, 2);
  assert.equal(secondBody.profile.supersedesVersionId, first.profile.profileVersionId);

  const history = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}/versions`,
    headers: { cookie: session.cookie },
  });
  assert.equal(history.statusCode, 200);
  const versions = parse<ProfileListPayload>(history).profiles;
  assert.deepEqual(versions.map((version) => version.versionNumber), [1, 2]);
  assert.notEqual(versions[0]?.contentFingerprint, versions[1]?.contentFingerprint);

  const current = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}`,
    headers: { cookie: session.cookie },
  });
  assert.equal(parse<ProfilePayload>(current).profile.content.recipe, 'pnpm install && pnpm verify');
});

test('F02-AC4: a save with missing or blank fields names every offending field', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: {
      projectId: PROJECT_ID,
      content: {
        references: {
          repository: '   ',
          ticketProvider: '',
          ticketTeamKey: null,
          baseBranch: '',
          targetBranch: '',
          deploymentProvider: '',
          engine: '',
          previewComponents: [],
        },
        policy: {
          requiredChecks: [],
          deliveryBehavior: 'Automatic',
          maxFixPasses: -1,
          workspaceIsolation: 'SharedDirectory',
          capabilityVersion: 0,
        },
        recipe: '',
        environment: { runtime: '', ports: [], secretReferences: [] },
      },
    },
  });
  assert.equal(response.statusCode, 400);
  const payload = parse<ErrorPayload>(response);
  assert.equal(payload.error.code, 'Invalid');
  const fields = payload.error.fields ?? [];
  const paths = fields.map((field) => field.path);
  for (const expected of [
    'content.references.repository',
    'content.references.ticketProvider',
    'content.references.baseBranch',
    'content.references.targetBranch',
    'content.references.deploymentProvider',
    'content.references.engine',
    'content.references.previewComponents',
    'content.policy.requiredChecks',
    'content.policy.deliveryBehavior',
    'content.policy.maxFixPasses',
    'content.policy.workspaceIsolation',
    'content.policy.capabilityVersion',
    'content.recipe',
    'content.environment.runtime',
  ]) {
    assert.ok(paths.includes(expected), `${expected} must be reported, got ${JSON.stringify(paths)}`);
  }
  assert.equal(new Set(paths).size, paths.length, 'each field must be reported once');
  for (const field of fields) {
    assert.ok(field.message.length > 0, `${field.path} must carry a message a form can show`);
  }
});

test('F02-AC4: an unknown key in a save is refused rather than ignored', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { projectId: PROJECT_ID, content: { ...profileContent(), installationDirectory: '/etc' } },
  });
  assert.equal(response.statusCode, 400);
  assert.ok(parse<ErrorPayload>(response).error.fields?.some((field) => field.path === 'content.installationDirectory'));
});

test('F03-AC3: a secret cannot be submitted to a connector and never appears in a response', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const rejected = await h.app.inject({
    method: 'POST',
    url: `/api/profiles/${PROJECT_ID}/connectors`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: {
      provider: 'linear',
      kind: 'Ticket',
      resourceScope: `${TEAM_KEY} team`,
      credentialReference: CREDENTIAL_REFERENCE,
      secret: SEEDED_SECRET,
    },
  });
  assert.equal(rejected.statusCode, 400, 'a secret must not be accepted through this route');
  assert.ok(!rejected.body.includes(SEEDED_SECRET));

  const registered = await seedConnector(h, session);
  assert.equal(registered.connector.credentialReference, CREDENTIAL_REFERENCE);
  assert.notEqual(registered.connector.credentialReferenceDigest, CREDENTIAL_REFERENCE);

  const listed = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}/connectors`,
    headers: { cookie: session.cookie },
  });
  assert.equal(listed.statusCode, 200);
  const connectors = parse<ConnectorListPayload>(listed).connectors;
  const serialized = JSON.stringify(connectors);
  assert.ok(!serialized.includes(SEEDED_SECRET), 'no response may carry a secret value');
  for (const forbiddenKey of ['"secret"', '"token"', '"apiKey"', '"password"']) {
    assert.ok(!serialized.includes(forbiddenKey), `${forbiddenKey} must not be part of a connector response`);
  }
});

test('F03-AC2: a connector reports status, last check, capabilities and an actionable error', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const registered = await seedConnector(h, session);
  assert.equal(registered.connector.state, 'Healthy');
  assert.equal(registered.connector.lastCheckedAt, START);
  const reads: readonly CapabilityKind[] = registered.connector.reads;
  assert.deepEqual(reads, ['Ticket:ReadScope', 'Ticket:PublishIssue']);
  assert.deepEqual(registered.connector.writes, []);
  assert.deepEqual(registered.connector.unsupported, [
    { kind: 'Git:MergeWithPrecondition', limitation: 'Linear cannot merge code.' },
  ]);

  const revoked = await h.app.inject({
    method: 'POST',
    url: `/api/connectors/${registered.connector.connectorId}/revoke`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { reason: 'the credential expired at the provider' },
  });
  assert.equal(revoked.statusCode, 200);
  const revokedBody = parse<ConnectorPayload>(revoked);
  assert.equal(revokedBody.connector.state, 'Revoked');
  assert.match(String(revokedBody.connector.error), /revoked/i);
  assert.match(String(revokedBody.connector.error), /Register a working credential/i);

  const listed = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}/connectors`,
    headers: { cookie: session.cookie },
  });
  const connectors = parse<ConnectorListPayload>(listed).connectors;
  assert.equal(connectors.length, 1);
  assert.equal(connectors[0]?.state, 'Revoked');
  assert.ok((connectors[0]?.error ?? '').length > 0);
  assert.equal(connectors[0]?.lastCheckedAt, START);
});

test('F03-AC4, F04-AC3: a revoked connector blocks the next profile save with the named prerequisite', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const connector = await seedConnector(h, session);
  const revoked = await h.app.inject({
    method: 'POST',
    url: `/api/connectors/${connector.connector.connectorId}/revoke`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { reason: 'revoked for the test' },
  });
  assert.equal(revoked.statusCode, 200);

  const blocked = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { projectId: PROJECT_ID, content: profileContent() },
  });
  assert.equal(blocked.statusCode, 422, 'a blocked operation must not be reported as started');
  assert.notEqual(blocked.statusCode, 200);
  assert.notEqual(blocked.statusCode, 201);
  const payload = parse<ErrorPayload>(blocked);
  assert.equal(payload.error.code, 'Blocked');
  const prerequisite = payload.error.prerequisites?.[0];
  assert.ok(prerequisite !== undefined, 'the failed prerequisite must be named');
  assert.equal(prerequisite.name, 'connector.Ticket.credential');
  assert.ok(prerequisite.detail.includes('linear'));
  assert.ok(prerequisite.remedy.length > 0, 'the owner must be told what to do');
});

test('F02-AC2, F24-AC4: a stale profile save is a conflict carrying the current facts', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  await seedProfile(h, session);
  const stale = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { projectId: PROJECT_ID, content: profileContent(), expectedVersionNumber: 7 },
  });
  assert.equal(stale.statusCode, 409);
  const payload = parse<ErrorPayload>(stale);
  assert.equal(payload.error.code, 'Conflict');
  assert.equal(payload.error.expected, '7');
  assert.equal(payload.error.actual, '1');

  const history = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}/versions`,
    headers: { cookie: session.cookie },
  });
  assert.equal(parse<ProfileListPayload>(history).profiles.length, 1, 'a refused save must not append a version');
});

test('F04-AC3: an unknown external write is a 202 with its operation id and never a success status', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  h.controller.script(
    'saveProfile',
    outcomeUnknown('The provider did not confirm the write.', 'op_2f9c', 'linear/octopus-main'),
  );
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { projectId: PROJECT_ID, content: profileContent() },
  });
  assert.equal(response.statusCode, 202);
  assert.notEqual(response.statusCode, 200);
  assert.notEqual(response.statusCode, 201);
  const payload = parse<ErrorPayload>(response);
  assert.equal(payload.error.code, 'OutcomeUnknown');
  assert.equal(payload.error.operationId, 'op_2f9c');
  assert.equal(payload.error.target, 'linear/octopus-main');
});

test('N02-AC1: every domain error maps to its own honest status', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const cases: { readonly name: string; readonly useCase: string; readonly error: DomainError; readonly status: number; readonly retryAfter?: string }[] = [
    { name: 'invalid', useCase: 'saveProfile', error: { code: 'Invalid', reason: 'A field is wrong.', fields: [{ path: 'content.recipe', message: 'A recipe is required.' }] }, status: 400 },
    { name: 'not found', useCase: 'registerConnector', error: { code: 'NotFound', reason: 'No such project.' }, status: 404 },
    { name: 'forbidden', useCase: 'registerConnector', error: { code: 'Forbidden', reason: 'Not this project.' }, status: 403 },
    { name: 'rate limited', useCase: 'registerConnector', error: { code: 'RateLimited', reason: 'Too many checks.', retryAfterMs: 1500 }, status: 429, retryAfter: '2' },
    { name: 'unavailable', useCase: 'registerConnector', error: { code: 'Unavailable', reason: 'The provider is unreachable.' }, status: 503 },
  ];
  for (const testCase of cases) {
    h.controller.script(testCase.useCase, testCase.error);
    const response = await h.app.inject({
      method: 'POST',
      url: testCase.useCase === 'saveProfile' ? '/api/profiles' : `/api/profiles/${PROJECT_ID}/connectors`,
      headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
      payload:
        testCase.useCase === 'saveProfile'
          ? { projectId: PROJECT_ID, content: profileContent() }
          : { provider: 'linear', kind: 'Ticket', resourceScope: 'OCT', credentialReference: CREDENTIAL_REFERENCE },
    });
    assert.equal(response.statusCode, testCase.status, `${testCase.name} must map to ${testCase.status}`);
    assert.equal(parse<ErrorPayload>(response).error.code, testCase.error.code);
    if (testCase.retryAfter !== undefined) {
      assert.equal(response.headers['retry-after'], testCase.retryAfter);
    }
  }
});

test('F01-AC1: artifacts are served only to a signed-in owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-web-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>ShipLoop</title>');
  await writeFile(join(root, 'evidence.txt'), 'screenshot bytes');

  const h = await harness({ config: { staticRoot: root } });
  t.after(() => h.close());

  const anonymousArtifact = await h.app.inject({ method: 'GET', url: '/artifacts/evidence.txt' });
  assert.equal(anonymousArtifact.statusCode, 401, 'an artifact must not be readable without a session');
  assert.ok(!anonymousArtifact.body.includes('screenshot bytes'));

  const session = await signIn(h.app);
  const ownedArtifact = await h.app.inject({
    method: 'GET',
    url: '/artifacts/evidence.txt',
    headers: { cookie: session.cookie },
  });
  assert.equal(ownedArtifact.statusCode, 404, 'the file is outside the artifact root, so it is not served');

  const shell = await h.app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
  assert.equal(shell.statusCode, 200, 'the sign-in shell is public');
  assert.ok(!shell.body.includes('csrfToken'));
});

test('F01-AC1: an unconfigured artifact store still refuses an anonymous request', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const anonymous = await h.app.inject({ method: 'GET', url: '/artifacts/run-1/evidence.txt' });
  assert.equal(anonymous.statusCode, 401);
  const session = await signIn(h.app);
  const authenticated = await h.app.inject({
    method: 'GET',
    url: '/artifacts/run-1/evidence.txt',
    headers: { cookie: session.cookie },
  });
  assert.equal(authenticated.statusCode, 404);
  assert.equal(parse<ErrorPayload>(authenticated).error.code, 'NotFound');
});

test('F01-AC1, F03-AC3: provisioning an owner refuses a password below the domain minimum', async (t) => {
  const h = await harness({ provisionOwner: false });
  t.after(() => h.close());
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/owner/provision',
    payload: { displayName: OWNER_NAME, password: 'short' },
  });
  assert.equal(response.statusCode, 400);
  const fields = parse<ErrorPayload>(response).error.fields ?? [];
  assert.deepEqual(fields.map((field) => field.path), ['password']);
  assert.match(String(fields[0]?.message), new RegExp(String(MINIMUM_PASSWORD_LENGTH)));
  assert.ok(!response.body.includes('short'));

  const created = await h.app.inject({
    method: 'POST',
    url: '/api/owner/provision',
    payload: { displayName: OWNER_NAME, password: OWNER_PASSWORD },
  });
  assert.equal(created.statusCode, 201);
  const session = await signIn(h.app);
  assert.ok(session.cookie.length > 0);
});

/**
 * The structural guard, over a literal that carries every group.
 *
 * The intake group is spelled out method by method rather than as one placeholder,
 * because a guard that accepts a partial group is not a guard: naming all of them here
 * is what makes an intake method disappearing from `contracts.ts` fail this test rather
 * than being noticed by whoever next calls it (F01-AC1).
 */
test('the loaded controller module is validated before it can serve a request', () => {
  assert.equal(isControllerSurface(null), false);
  assert.equal(isControllerSurface({ owners: {} }), false);
  assert.equal(
    isControllerSurface({ owners: { provision() {}, signIn() {} }, sessions: { loadByToken() {} } }),
    false,
  );
  const complete = {
    // `describe` and the whole `projects` group are declared for the same reason the
    // generation group is below: the session response once omitted the owner's address and
    // nothing named a project, so every project-scoped request addressed
    // `/api/profiles/undefined` and the client reported the 404 as "no saved profile yet"
    // (F01-AC1, F02-AC1).
    owners: { provision() {}, signIn() {}, describe() {}, selectActiveProject() {} },
    projects: { listProjects() {}, createProject() {} },
    contracts: {
      createRequest() {},
      getRequest() {},
      listRequests() {},
      updateRequest() {},
      draftContract() {},
      getContract() {},
      listContractRevisions() {},
      listContractCriteria() {},
      editContract() {},
      approveRevision() {},
      reviseContract() {},
      invalidateRevision() {},
    },
    handoff: { buildHandoff() {} },
    sessions: { loadByToken() {}, create() {}, revoke() {}, touch() {} },
    profiles: { saveVersion() {}, currentVersion() {}, listVersions() {} },
    connectors: { register() {}, listForProject() {}, revoke() {} },
    // The settings group must be declared too: without it the T3 launch target is
    // unreachable from any shipped path, which is how a use case ends up implemented and
    // invisible (L02-AC2).
    settings: { readSettings() {}, updateSettings() {} },
    intake: {
      captureIdea() {},
      listIdeas() {},
      getIdea() {},
      attachFile() {},
      recordSummary() {},
      archiveIdea() {},
      deferIdea() {},
      findRelatedWork() {},
      recordRelatedWorkChoice() {},
      draftBrief() {},
      agreeBrief() {},
      askClarifyingQuestions() {},
      answerClarifyingQuestion() {},
      applyOwnerCorrection() {},
      exportIdea() {},
    },
    runs: {
      startRun() {},
      listRuns() {},
      getRun() {},
      pauseRun() {},
      resumeRun() {},
      cancelRun() {},
      grantExtension() {},
      declineExtension() {},
    },
    attention: { collectAttention() {}, acknowledge() {} },
    reviewCards: { buildReviewCard() {} },
    acceptance: { requestChanges() {}, recordAcceptance() {}, currentAcceptance() {}, acceptanceGate() {} },
    ownerTests: { recordOwnerObservation() {}, listOwnerObservations() {} },
    planning: {
      draftPlan() {},
      getPlan() {},
      listPlansForIdea() {},
      editPlan() {},
      assessPlan() {},
      publishPlan() {},
      reconcilePublication() {},
      adoptExistingIssue() {},
      linkExistingChange() {},
      requestAdoptedEvaluation() {},
    },
    // The generation group must be declared on the surface, not merely present at runtime.
    // Its absence is exactly the state this product was in: generation implemented and
    // unreachable from any shipped path (F07-AC1, F08-AC1).
    generation: new InMemoryController(() => new Date("2026-10-02T10:00:00.000Z"), ADAPTER_CAPABILITIES, true).generation,
  };
  assert.equal(isControllerSurface(complete), true);
  const missingOwnerTestMethod = {
    ...complete,
    ownerTests: { ...complete.ownerTests, recordOwnerObservation: undefined },
  };
  assert.equal(
    isControllerSurface(missingOwnerTestMethod),
    false,
    'a surface without the owner-test recording path must not pass the guard: recording an observation has to be a declared method (F25-AC4)',
  );
  const missingPlanningMethod = {
    ...complete,
    planning: { ...complete.planning, publishPlan: undefined },
  };
  const missingGeneration = { ...complete, generation: undefined };
  assert.equal(
    isControllerSurface(missingGeneration),
    false,
    'a surface without generation must not pass the guard: the use cases would be unreachable',
  );
  const missingProjects = { ...complete, projects: undefined };
  assert.equal(
    isControllerSurface(missingProjects),
    false,
    'a surface without the projects group must not pass the guard: with nothing to select, every project-scoped request would address an undefined identity (F02-AC1)',
  );
  const missingSettings = { ...complete, settings: undefined };
  assert.equal(
    isControllerSurface(missingSettings),
    false,
    'a surface without the settings group must not pass the guard: the T3 launch target would be unreachable, and a server that boots without it would 404 every settings request (L02-AC2)',
  );
  const missingDescribe = { ...complete, owners: { ...complete.owners, describe: undefined } };
  assert.equal(
    isControllerSurface(missingDescribe),
    false,
    'a surface whose owners cannot be described must not pass the guard: the session response would omit the address the header renders (F01-AC1)',
  );
  assert.equal(
    isControllerSurface(missingPlanningMethod),
    false,
    'a planning group without publication must not pass the guard: reaching the provider has to be a declared method',
  );
});
test('F01-AC1: a request over the body limit is refused with its own status', async (t) => {
  const h = await harness({ config: { bodyLimitBytes: 1024 } });
  t.after(() => h.close());
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: { identifier: OWNER_NAME, password: 'x'.repeat(4096) },
  });
  assert.equal(response.statusCode, 413);
  const payload = parse<ErrorPayload>(response);
  assert.equal(payload.error.code, 'PayloadTooLarge');
  assert.ok(!response.body.includes('xxxx'), 'the refusal must not echo the body');
});

test('F01-AC1: a state-changing request to an unknown path is refused, not reported as missing', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const anonymous = await h.app.inject({ method: 'POST', url: '/api/there-is-no-such-route' });
  assert.equal(anonymous.statusCode, 401);

  const session = await signIn(h.app);
  const withoutToken = await h.app.inject({
    method: 'POST',
    url: '/api/there-is-no-such-route',
    headers: { cookie: session.cookie },
  });
  assert.equal(withoutToken.statusCode, 403, 'a signed-in caller without a token is told the token is the problem');
  assert.equal(parse<ErrorPayload>(withoutToken).signInRequired, undefined);

  const withToken = await h.app.inject({
    method: 'POST',
    url: '/api/there-is-no-such-route',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
  });
  assert.equal(withToken.statusCode, 404);
  assert.equal(parse<ErrorPayload>(withToken).error.code, 'NotFound');
});

test('F03-AC2: a body the server cannot read is refused with a nameable field and no echo', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const notAnObject = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: [OWNER_NAME],
  });
  assert.equal(notAnObject.statusCode, 400);
  const fields = parse<ErrorPayload>(notAnObject).error.fields ?? [];
  assert.deepEqual(fields.map((field) => field.path), ['body']);

  const wrongMediaType = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: `identifier=${OWNER_NAME}&password=${OWNER_PASSWORD}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(wrongMediaType.statusCode, 415);
  assert.equal(parse<ErrorPayload>(wrongMediaType).error.code, 'UnsupportedMediaType');

  const malformed = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    headers: { 'content-type': 'application/json' },
    payload: `{"identifier": "${SEEDED_SECRET}", `,
  });
  assert.equal(malformed.statusCode, 400);
  assert.ok(!malformed.body.includes(SEEDED_SECRET), 'a parse failure must not echo the submitted body');
  assert.equal(parse<ErrorPayload>(malformed).error.code, 'BadRequest');
});

test('F01-AC4: configuration refuses to start without a usable CSRF secret', () => {
  const missing = readServerConfig({ SHIPLOOP_NODE_ENV: 'production' });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.ok(missing.errors.some((problem) => problem.path === 'SHIPLOOP_CSRF_SECRET'));

  const short = readServerConfig({ SHIPLOOP_CSRF_SECRET: 'too short', SHIPLOOP_NODE_ENV: 'production' });
  assert.equal(short.ok, false);

  const insecureProduction = readServerConfig({
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_NODE_ENV: 'production',
    SHIPLOOP_COOKIE_SECURE: 'false',
  });
  assert.equal(insecureProduction.ok, false, 'a production cookie must not be allowed to be insecure (F01-AC4)');

  const badNumbers = readServerConfig({
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_PORT: 'eighty',
    SHIPLOOP_SESSION_TTL_SECONDS: '-1',
  });
  assert.equal(badNumbers.ok, false);

  const valid = readServerConfig({ SHIPLOOP_CSRF_SECRET: CSRF_SECRET, SHIPLOOP_NODE_ENV: 'production' });
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(valid.value.cookieSecure, true);
  assert.equal(valid.value.cookieSameSite, 'Strict');
  assert.equal(describeConfigErrors([{ path: 'A', message: 'b' }]), 'A: b');
});

test('F01-AC4: a development server may drop Secure deliberately and says so in the configuration', () => {
  const result = readServerConfig({
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_NODE_ENV: 'development',
    SHIPLOOP_COOKIE_SECURE: 'false',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.cookieSecure, false);
});

test('F01-AC1: the health route answers an anonymous caller and discloses nothing', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await h.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200, 'liveness is what the browser harness polls before it drives a flow');
  assert.deepEqual(JSON.parse(response.body), { status: 'ok' });

  // The body is the whole disclosure surface, so the key set is pinned as well as the value: a
  // field added here later is a new unauthenticated disclosure, and this fails when that happens
  // rather than after someone reads a release note.
  assert.deepEqual(Object.keys(JSON.parse(response.body) as object), ['status']);

  // Nothing that would fingerprint the deployment. The version, the clock, the host and the store
  // are all facts a caller with no session must not learn, and each is a plausible thing to add
  // while making a liveness route more useful.
  for (const disclosure of ['version', 'commit', 'uptime', 'hostname', 'host', 'database', 'startedAt', START]) {
    assert.ok(!response.body.includes(disclosure), `the health body must not mention ${disclosure}`);
  }

  // No owner detail, and no cookie: the route is unauthenticated by design, so anything it returned
  // would be returned to anyone who asked.
  assert.ok(!response.body.includes(OWNER_NAME));
  assert.ok(!response.body.includes(OWNER_ID));
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store', 'a cached liveness answer outlives the process that gave it');
});

test('F01-AC1: the health route stays a 200 with a session cookie it did not need', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  // A caller presenting a cookie gets the same answer as one that does not, so the route is not
  // quietly branching on the session and the response is not decorated for a signed-in reader.
  const session = await signIn(h.app);
  const withCookie = await h.app.inject({
    method: 'GET',
    url: '/api/health',
    headers: { cookie: session.cookie },
  });
  assert.equal(withCookie.statusCode, 200);
  assert.equal(withCookie.body, (await h.app.inject({ method: 'GET', url: '/api/health' })).body);
});

test('F01-AC1: SHIPLOOP_PORT 0 is the OS-assigned port, and only the port may be zero', () => {
  // Zero has one defined meaning for the port and it is a useful one: the harness cannot know which
  // port is free, so it asks for any and reads the bound address back. Rejecting it would make the
  // browser suite unable to start a server at all.
  const osChosen = readServerConfig({ SHIPLOOP_CSRF_SECRET: CSRF_SECRET, SHIPLOOP_PORT: '0' });
  assert.equal(osChosen.ok, true, 'port 0 must be accepted');
  if (!osChosen.ok) return;
  assert.equal(osChosen.value.port, 0, 'zero must be passed through, not replaced by the default');

  const explicit = readServerConfig({ SHIPLOOP_CSRF_SECRET: CSRF_SECRET, SHIPLOOP_PORT: '8080' });
  assert.equal(explicit.ok, true);
  if (!explicit.ok) return;
  assert.equal(explicit.value.port, 8080);

  // A negative port is not a request for an arbitrary one, and a non-number is not a number.
  // The upper end of the range is deliberately absent from this list: nothing above 65535 is
  // refused by `readServerConfig` today, so asserting it would be asserting a rule that does not
  // exist. `listen` rejects such a port later, with a Node error rather than a named one.
  for (const bad of ['-1', 'eighty', '80.5', ' ']) {
    const refused = readServerConfig({ SHIPLOOP_CSRF_SECRET: CSRF_SECRET, SHIPLOOP_PORT: bad });
    assert.equal(refused.ok, false, `port ${JSON.stringify(bad)} must be refused`);
  }

  // Zero stays refused everywhere else. It means "unset" for every other integer here, and a
  // session lifetime or a byte limit of zero is a broken setting rather than a request.
  for (const [path, value] of [
    ['SHIPLOOP_SESSION_TTL_SECONDS', '0'],
    ['SHIPLOOP_SESSION_IDLE_SECONDS', '0'],
    ['SHIPLOOP_BODY_LIMIT_BYTES', '0'],
  ] as const) {
    const refused = readServerConfig({ SHIPLOOP_CSRF_SECRET: CSRF_SECRET, [path]: value });
    assert.equal(refused.ok, false, `${path}=0 must be refused`);
    if (refused.ok) continue;
    const problem = refused.errors.find((candidate) => candidate.path === path);
    assert.ok(problem !== undefined, `the refusal must name ${path}`);
    assert.equal(problem.message, 'Expected a positive number.');
  }
});

/* -------------------------------------------------------------------------- */
/* Runs, attention and the review card                                         */
/* -------------------------------------------------------------------------- */

const WORK_ITEM = 'wrk_octopus_1';
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BASE_SHA = '0f1e2d3c4b5a69788796a5b4c3d2e1f001122334';
const SCOPE_FINGERPRINT = 'fp_1a2b3c4d5e6f7081';

/** A start body the route's own schema accepts, so a 400 here can only be about a named field. */
function startPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const readiness: Record<string, { confirmed: boolean; note: string | null }> = {};
  for (const area of READINESS_AREAS) readiness[area] = { confirmed: true, note: `Confirmed ${area} for this run.` };
  return {
    workItemId: WORK_ITEM,
    mode: 'Build',
    operationId: 'op_octopus_1',
    scope: {
      issueId: 'issue_octopus_1',
      issueIdentifier: 'OCT-1',
      title: 'Record that the run happened',
      description: 'The run must leave a durable record a worker can claim.',
      acceptanceCriteria: [{ id: 'AC1', text: 'A durable job row exists for the run.' }],
    },
    readiness,
    ...overrides,
  };
}

async function startRun(h: Harness, session: Session, overrides: Record<string, unknown> = {}): Promise<InjectedResponse> {
  return h.app.inject({
    method: 'POST',
    url: '/api/runs',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: startPayload(overrides),
  });
}

interface RunStartPayload {
  readonly run: RunStartView;
  readonly disposition: string;
  readonly message: string;
}

function runCheckpoint(overrides: Partial<RunCheckpointView> = {}): RunCheckpointView {
  return {
    checkpointId: 'ckpt_1',
    scopeSnapshotId: 'scope_1',
    scopeFingerprint: SCOPE_FINGERPRINT,
    profileVersionId: 'prv_1',
    procedureVersionId: 'prc_1',
    engineVersion: 'codex-1',
    workspace: { workspaceId: 'ws_1', branchName: 'ship/octopus-1', worktreePath: '/tmp/wt/octopus-1' },
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    dirtyFiles: ['src/server/routes/runs.ts'],
    untrackedFiles: ['apps/web/e2e/runs.spec.ts'],
    results: [{ name: 'typecheck', result: 'Passed', detail: null }],
    feedback: [{ author: OWNER_ID, at: START, body: 'Keep the refusal verbatim.' }],
    blocker: 'The engine binary is not installed.',
    nextAction: 'Install the engine, then resume this run.',
    recordedAt: START,
    ...overrides,
  };
}

function queuedRun(overrides: Partial<RunJobView> = {}): RunJobView {
  return {
    jobId: 'job_seeded_1',
    operationId: 'op_seeded_1',
    mode: 'Build',
    workItemId: WORK_ITEM,
    scopeSnapshotId: 'scope_seeded_1',
    projectId: PROJECT_ID,
    profileVersionId: 'prv_1',
    procedureVersionId: 'prc_1',
    state: 'Queued',
    correlationId: 'op_seeded_1',
    limits: { activeExecutionMs: 3_600_000, maxAutomatedFixPasses: 2, maxToolRetries: 3, maxAttempts: 2 },
    permittedOperations: MODE_OPERATIONS.Build,
    holder: null,
    attemptCount: 0,
    createdAt: START,
    updatedAt: START,
    ...overrides,
  };
}

// F13-AC1, F13-AC2, F13-AC3: a start answers 201 with the durable job, the scope it captured and the
// grant it holds, and the grant names the delivery operations it refused. A 201 here is the claim
// that a run exists, so the response has to carry the run rather than a bare acknowledgement.
test('F13-AC1: a start answers 201 with the job, the captured scope and the refused delivery operations', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);

  const response = await startRun(h, session);
  assert.equal(response.statusCode, 201, `start failed: ${response.body}`);
  const body = parse<RunStartPayload>(response);

  assert.equal(body.run.job.state, 'Queued', 'a started run is Queued until a worker claims it');
  assert.equal(body.run.job.workItemId, WORK_ITEM);
  assert.equal(body.run.job.mode, 'Build');
  assert.equal(body.run.deduplicated, false);
  assert.equal(body.run.capturedScope.workItemId, WORK_ITEM);
  assert.equal(body.run.capturedScope.sequenceNumber, 1);

  // The grant is the mode's own set, read back rather than restated, and delivery is named as
  // refused rather than omitted: a grant that silently lacked Merge reads as an oversight.
  assert.deepEqual(body.run.grant.permittedOperations, MODE_OPERATIONS.Build);
  assert.deepEqual(body.run.grant.refusedDeliveryOperations, ['Merge', 'Release', 'RecoveryRedeploy']);
  assert.match(body.run.grant.refusalReason, /Merge/);
  assert.equal(body.run.requestedByOwner, OWNER_ID);
  assert.equal(response.headers['cache-control'], 'no-store');
});

// F13-AC2: the same operation identity twice is one run. This is the property the whole identity
// exists for, and the second answer has to say it was a repeat rather than a second creation.
test('F13-AC2: the same operation identity answers 200 and starts no second run', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);

  const first = await startRun(h, session);
  assert.equal(first.statusCode, 201, `first start failed: ${first.body}`);
  const firstJobId = parse<RunStartPayload>(first).run.job.jobId;

  const second = await startRun(h, session);
  assert.equal(second.statusCode, 200, `the repeat must not answer 201: ${second.body}`);
  const body = parse<RunStartPayload>(second);
  assert.equal(body.disposition, 'AlreadyStarted');
  assert.equal(body.run.deduplicated, true);
  assert.equal(body.run.job.jobId, firstJobId, 'the repeat returns the run the identity already started');
  assert.match(body.message, /already started run/);

  // One run exists, which is the claim the status code makes and the store has to agree with.
  const listed = await h.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: session.cookie } });
  assert.equal(listed.statusCode, 200);
  assert.equal(parse<{ runs: readonly RunJobView[] }>(listed).runs.length, 1);
});

// F13-AC2, F13-AC3: a run queued behind the single global coding writer answers 202 and names the
// holder, because a 201 there would report a writer claim no worker has made.
test('F13-AC2: a start behind the single coding writer answers 202 and names the holder', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  h.controller.seedRun(queuedRun({ jobId: 'job_holder', operationId: 'op_holder', holder: 'worker-a' }), undefined, {
    holder: 'worker-a',
    disposition: 'Held',
    expiresAt: '2026-03-01T13:00:00.000Z',
    reconciliationReason: null,
  });

  const response = await startRun(h, session);
  assert.equal(response.statusCode, 202, `a queued-behind-writer start must not answer 201: ${response.body}`);
  const body = parse<RunStartPayload>(response);
  assert.equal(body.disposition, 'QueuedBehindWriter');
  assert.deepEqual(body.run.dispatch.heldByWriter, ['job_holder']);
  assert.match(body.message, /job_holder/);
  assert.equal(body.run.job.state, 'Queued');
});

// F09-AC2, N03-AC3: an unconfirmed prerequisite refuses the start and names every open area with
// its remedy, and the refusal is per field so a form can mark the input that caused it.
test('F09-AC2: an unconfirmed prerequisite refuses the start by name and starts nothing', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);

  const response = await startRun(h, session, {
    readiness: {
      scope: { confirmed: true, note: null },
      criteria: { confirmed: false, note: null },
      repository: { confirmed: false, note: null },
      target: { confirmed: true, note: null },
      verification: { confirmed: true, note: null },
      access: { confirmed: true, note: null },
    },
  });
  assert.equal(response.statusCode, 422, `an unconfirmed prerequisite must be a Blocked 422: ${response.body}`);
  const problem = parse<ErrorPayload>(response);
  assert.equal(problem.error.code, 'Blocked');
  const names = (problem.error.prerequisites ?? []).map((entry) => entry.name);
  assert.deepEqual(names, ['readiness-criteria', 'readiness-repository']);
  for (const prerequisite of problem.error.prerequisites ?? []) {
    assert.ok(prerequisite.remedy.length > 0, 'every open area must carry a remedy (F09-AC2)');
  }
  assert.match(problem.error.message, /NeedsInformation/);

  const listed = await h.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: session.cookie } });
  assert.equal(parse<{ runs: readonly RunJobView[] }>(listed).runs.length, 0, 'a refused start leaves no run behind');
});

// F02-AC4, N03-AC3: every rejected field is reported, and an unrecognised key is refused rather
// than dropped. A form can only mark the inputs it knows about, so one combined message would leave
// the owner guessing which input to fix.
test('F02-AC4: a start body is validated per field and refuses keys it does not accept', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);

  const response = await startRun(h, session, {
    mode: 'Deploy',
    workItemId: '   ',
    operationId: '',
    surprise: 'accepted by nobody',
    scope: {
      issueId: 'issue_octopus_1',
      issueIdentifier: 'OCT-1',
      title: 'A title',
      description: 'A description',
      acceptanceCriteria: [],
    },
  });
  assert.equal(response.statusCode, 400, response.body);
  const problem = parse<ErrorPayload>(response);
  assert.equal(problem.error.code, 'Invalid');
  const paths = (problem.error.fields ?? []).map((field) => field.path);
  assert.ok(paths.includes('mode'), `the mode must be reported: ${paths.join(', ')}`);
  assert.ok(paths.includes('workItemId'), `the work item must be reported: ${paths.join(', ')}`);
  assert.ok(paths.includes('operationId'), `the operation identity must be reported: ${paths.join(', ')}`);
  assert.ok(paths.includes('surprise'), `an unrecognised key must be reported: ${paths.join(', ')}`);
  assert.ok(paths.includes('scope.acceptanceCriteria'), `the criteria list must be reported: ${paths.join(', ')}`);
});

// F17-AC2: the resume point is readable on its own, in full. An abbreviated SHA or a dropped
// untracked inventory would make the comparison a resume performs meaningless.
test('F17-AC2: the checkpoint route returns the whole resume point, SHAs unabbreviated', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ state: 'Running' });
  h.controller.seedRun(job, runCheckpoint());

  const response = await h.app.inject({
    method: 'GET',
    url: `/api/runs/${job.jobId}/checkpoint`,
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const checkpoint = parse<{ checkpoint: RunCheckpointView }>(response).checkpoint;

  assert.equal(checkpoint.headSha, HEAD_SHA);
  assert.equal(checkpoint.baseSha, BASE_SHA);
  assert.equal(checkpoint.headSha.length, 40, 'a head SHA must be full, because a resume compares it to a checkout');
  assert.equal(checkpoint.baseSha.length, 40);
  assert.equal(checkpoint.scopeFingerprint, SCOPE_FINGERPRINT);
  assert.equal(checkpoint.profileVersionId, 'prv_1');
  assert.equal(checkpoint.procedureVersionId, 'prc_1');
  assert.equal(checkpoint.engineVersion, 'codex-1');
  assert.equal(checkpoint.workspace.branchName, 'ship/octopus-1');
  assert.deepEqual(checkpoint.dirtyFiles, ['src/server/routes/runs.ts']);
  assert.deepEqual(checkpoint.untrackedFiles, ['apps/web/e2e/runs.spec.ts']);
  assert.deepEqual(checkpoint.results, [{ name: 'typecheck', result: 'Passed', detail: null }]);
  assert.equal(checkpoint.feedback.length, 1);
  assert.equal(checkpoint.blocker, 'The engine binary is not installed.');
  assert.equal(checkpoint.nextAction, 'Install the engine, then resume this run.');
});

// F17-AC2: a run with no resume point is a 404 by name, not a null body. A null would be
// indistinguishable from a recorded point that happens to be empty.
test('F17-AC2: a run with no recorded resume point answers 404 rather than an empty one', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun();
  h.controller.seedRun(job);

  const response = await h.app.inject({
    method: 'GET',
    url: `/api/runs/${job.jobId}/checkpoint`,
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 404, response.body);
  const problem = parse<ErrorPayload>(response);
  assert.equal(problem.error.code, 'NotFound');
  assert.match(problem.error.message, /recorded no resume point/);
});

// F17-AC1: a pause reports whether the writer stopped, and the two answers are different facts. A
// pause that left a writer recorded is a pause that may still be writing code.
test('F17-AC1: a pause reports the writer disposition, and a held writer is not a stopped writer', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);

  const free = queuedRun({ jobId: 'job_free', state: 'Running' });
  h.controller.seedRun(free, runCheckpoint(), { holder: null, disposition: 'Vacant', expiresAt: null, reconciliationReason: null });
  const stopped = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${free.jobId}/pause`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
  });
  assert.equal(stopped.statusCode, 200, stopped.body);
  const stoppedRun = parse<{ run: PausedRunView }>(stopped).run;
  assert.equal(stoppedRun.writerStopped, true);
  assert.equal(stoppedRun.writer.disposition, 'Vacant');
  assert.equal(stoppedRun.job.state, 'Paused');
  assert.ok(stoppedRun.checkpoint !== null, 'a pause keeps the resume point (F17-AC2)');

  const held = queuedRun({ jobId: 'job_held', state: 'Running', holder: 'worker-a' });
  h.controller.seedRun(held, runCheckpoint(), {
    holder: 'worker-a',
    disposition: 'Held',
    expiresAt: '2026-03-01T13:00:00.000Z',
    reconciliationReason: null,
  });
  const stillHeld = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${held.jobId}/pause`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
  });
  assert.equal(stillHeld.statusCode, 200, stillHeld.body);
  const heldRun = parse<{ run: PausedRunView }>(stillHeld).run;
  assert.equal(heldRun.writerStopped, false, 'a held writer has not stopped (F17-AC1)');
  assert.equal(heldRun.writer.holder, 'worker-a');
});

// F17-AC5: a detached writer is reported as one that may still be writing, never as stopped. An
// expired lease proves heartbeats stopped, not that the process did.
test('F17-AC5: a detached writer reads as still running, not as stopped', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_detached', state: 'Paused', holder: 'worker-b' });
  h.controller.seedRun(job, runCheckpoint(), {
    holder: 'worker-b',
    disposition: 'ReconciliationRequired',
    expiresAt: '2026-03-01T11:30:00.000Z',
    reconciliationReason: 'No heartbeat from worker-b since 2026-03-01T11:29:00.000Z',
  });

  const response = await h.app.inject({
    method: 'GET',
    url: `/api/runs/${job.jobId}`,
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const run = parse<{ run: RunView }>(response).run;
  assert.equal(run.writer.disposition, 'ReconciliationRequired');
  assert.equal(run.writer.holder, 'worker-b');
  assert.match(String(run.writer.reconciliationReason), /heartbeat/);
  assert.equal(run.job.state, 'Paused');
});

// F17-AC1: an illegal lifecycle move is refused by name with the reachable states, so the owner is
// told what the run may do next rather than that the request failed.
test('F17-AC1: pausing a Queued run is refused with the states it can reach', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun();
  h.controller.seedRun(job);

  const paused = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/pause`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
  });
  assert.equal(paused.statusCode, 400, paused.body);
  const problem = parse<ErrorPayload>(paused);
  assert.equal(problem.error.code, 'Invalid');
  assert.match(problem.error.message, /Queued -> Paused/);
  assert.match(String(problem.error.fields?.[0]?.message), /Preparing, Cancelled, Blocked/);

  const resumed = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/resume`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
  });
  assert.equal(resumed.statusCode, 422, `a resume with no resume point must be Blocked: ${resumed.body}`);
  assert.match(parse<ErrorPayload>(resumed).error.message, /no recorded resume point/);
});

// F17-AC3: a resume continues from the recorded point and says which, and F17-AC4: a cancellation
// preserves that point and reports that no external delivery was touched.
test('F17-AC3, F17-AC4: resume continues from the resume point and cancel preserves it', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_resume_1', state: 'Paused' });
  h.controller.seedRun(job, runCheckpoint());

  const resumed = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/resume`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
  });
  assert.equal(resumed.statusCode, 200, resumed.body);
  const resumedRun = parse<{ run: { job: RunJobView; checkpoint: RunCheckpointView } }>(resumed).run;
  assert.equal(resumedRun.job.state, 'Running', 'a resume returns to Running, not to the queue (F17-AC3)');
  assert.equal(resumedRun.checkpoint.headSha, HEAD_SHA);

  const cancelled = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/cancel`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  const cancelledRun = parse<{ run: { job: RunJobView; preservedCheckpoint: RunCheckpointView | null; externalDelivery: string } }>(cancelled).run;
  assert.equal(cancelledRun.job.state, 'Cancelled');
  assert.equal(cancelledRun.preservedCheckpoint?.headSha, HEAD_SHA, 'a cancellation preserves the resume point (F17-AC4)');
  assert.equal(cancelledRun.externalDelivery, 'UnchangedByCancellation', 'a cancellation cannot reverse a delivery (F17-AC4)');
});

// F18-AC2, N01-AC3: a grant states that the extended bound is not recorded, and a decline changes
// no state. A client told the bound was persisted would promise the owner a budget a restart loses.
test('F18-AC2: a granted extension reports the bounds and says the extended one is not recorded', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_waiting', state: 'WaitingForOwner' });
  h.controller.seedRun(job, runCheckpoint());

  const granted = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/extension`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { decision: 'Grant' },
  });
  assert.equal(granted.statusCode, 200, granted.body);
  const extension = parse<{ extension: GrantedExtensionView }>(granted).extension;
  assert.equal(extension.previousLimits.activeExecutionMs, 3_600_000);
  assert.equal(extension.extendedLimits.activeExecutionMs, 7_200_000);
  assert.equal(extension.extendedBoundRecorded, false, 'nothing in storage writes the bound, so this must be false (F18-AC2)');
  assert.equal(extension.job.state, 'Running', 'a grant lets the attempt continue (F18-AC2)');
  assert.equal(extension.decidedBy, OWNER_ID);

  const declined = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/extension`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { decision: 'Decline' },
  });
  assert.equal(declined.statusCode, 409, `a decline of a run that is no longer waiting is a Conflict: ${declined.body}`);
  const problem = parse<ErrorPayload>(declined);
  assert.equal(problem.error.code, 'Conflict');
  assert.equal(problem.error.expected, 'WaitingForOwner');
  assert.equal(problem.error.actual, 'Running');

  const refused = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/extension`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { decision: 'Maybe' },
  });
  assert.equal(refused.statusCode, 400, refused.body);
  assert.deepEqual((parse<ErrorPayload>(refused).error.fields ?? []).map((field) => field.path), ['decision']);
});

// F24-AC2, F24-AC3: the card carries both SHAs, the scope revision, every check with its result and
// an explicit not-ready list, and a run with no candidate is a 404 rather than an empty card.
test('F24-AC3: the review card names every check result and every reason it is not ready', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_card', state: 'Completed' });
  h.controller.seedRun(job);
  h.controller.seedReviewCard(WORK_ITEM, {
    candidateFingerprint: 'fp_candidate_1',
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    scopeFingerprint: SCOPE_FINGERPRINT,
    scopeRevision: 3,
    collectedAt: START,
    checks: [
      { checkId: 'chk_1', name: 'typecheck', origin: 'LocalCheck', required: true, result: 'Passed', blocking: false, exitCode: 0, artifactRef: null, detail: null },
      { checkId: 'chk_2', name: 'test', origin: 'LocalCheck', required: true, result: 'Failed', blocking: true, exitCode: 1, artifactRef: 'run-1/test.log', detail: 'one assertion failed' },
    ],
    criteria: [
      { criterionId: 'AC1', text: 'A durable job row exists for the run.', methodKind: 'AutomatedCheck', status: 'Verified', evidenceId: 'ev_1', observedAt: START, detail: null, verificationCheckId: 'typecheck', verificationEvidenceId: 'ev_1', verificationDetail: 'Verified by check "typecheck".' },
      { criterionId: 'AC2', text: 'The owner can pause the run.', methodKind: 'OwnerTest', status: 'PendingOwnerTest', evidenceId: null, observedAt: null, detail: null, verificationCheckId: null, verificationEvidenceId: null, verificationDetail: null },
    ],
    pendingOwnerTestCriterionIds: ['AC2'],
    readyForOwnerTest: false,
    notReady: ['Required check "test" is Failed, not Passed.', 'Criterion "AC2" is PendingOwnerTest, with no verified observation.'],
  });

  const response = await h.app.inject({
    method: 'GET',
    url: `/api/runs/${job.jobId}/review-card`,
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const card = parse<{ card: ReviewCardView }>(response).card;

  assert.equal(card.headSha, HEAD_SHA);
  assert.equal(card.baseSha, BASE_SHA);
  assert.equal(card.scopeFingerprint, SCOPE_FINGERPRINT);
  assert.equal(card.scopeRevision, 3);
  assert.equal(card.checks.length, 2);
  assert.deepEqual(card.checks.map((check) => `${check.name}:${check.result}`), ['typecheck:Passed', 'test:Failed']);
  assert.equal(card.checks[1]?.blocking, true, 'a failing required check blocks, and the card says so (F20-AC2)');
  assert.equal(card.criteria.length, 2);
  assert.deepEqual(card.criteria.map((criterion) => criterion.status), ['Verified', 'PendingOwnerTest']);
  // The verification identity travels with the criterion, so the browser can hold a criterion
  // against the checks above it instead of assuming any green check covers it (F23-AC1).
  assert.deepEqual(
    card.criteria.map((criterion) => criterion.verificationCheckId),
    ['typecheck', null],
    'an automated criterion names its check and an owner-test criterion names none',
  );
  assert.deepEqual(
    card.criteria.map((criterion) => criterion.verificationEvidenceId),
    ['ev_1', null],
    'the evidence row carrying the verdict travels with it',
  );
  assert.equal(
    card.criteria[0]?.verificationDetail,
    'Verified by check "typecheck".',
    'the card states what verified the criterion rather than leaving it to be inferred',
  );
  assert.equal(card.criteria[1]?.verificationDetail, null, 'nothing has verified a pending owner test yet');
  assert.deepEqual(card.pendingOwnerTestCriterionIds, ['AC2']);
  assert.equal(card.readyForOwnerTest, false);
  assert.deepEqual(card.notReady, [
    'Required check "test" is Failed, not Passed.',
    'Criterion "AC2" is PendingOwnerTest, with no verified observation.',
  ]);

  const empty = queuedRun({ jobId: 'job_no_candidate', workItemId: 'wrk_without_candidate', state: 'Queued' });
  h.controller.seedRun(empty);
  const refused = await h.app.inject({
    method: 'GET',
    url: `/api/runs/${empty.jobId}/review-card`,
    headers: { cookie: session.cookie },
  });
  assert.equal(refused.statusCode, 404, refused.body);
  assert.match(parse<ErrorPayload>(refused).error.message, /recorded no candidate/);
});

// F31-AC1, F31-AC2: the board groups into the four buckets and carries the instant it was collected,
// because a view that has stopped moving looks exactly like one with nothing to report.
test('F31-AC2: the board groups into the four buckets and names when it was collected', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  h.controller.seedAttentionItem({
    attentionItemId: 'attn_working',
    kind: 'RunProgress',
    state: 'Open',
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM,
    issueIdentifier: 'OCT-1',
    title: 'Job job_1 is Running',
    blocker: null,
    nextAction: 'Wait for job job_1 to leave Running.',
    createdAt: START,
    updatedAt: START,
    acknowledgedAt: null,
    acknowledgedBy: null,
    candidateFingerprint: null,
  });
  h.controller.seedAttentionItem({
    attentionItemId: 'attn_blocked',
    kind: 'Blocker',
    state: 'Open',
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM,
    issueIdentifier: 'OCT-1',
    title: 'Job job_1 is blocked',
    blocker: 'the engine binary is not installed',
    nextAction: 'Resolve what is blocking job job_1, then resume it.',
    createdAt: START,
    updatedAt: START,
    acknowledgedAt: null,
    acknowledgedBy: null,
    candidateFingerprint: null,
  });
  h.controller.seedAttentionItem({
    attentionItemId: 'attn_release',
    kind: 'DeliveryDecision',
    state: 'Open',
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM,
    issueIdentifier: 'OCT-1',
    title: 'Candidate fp_1 is accepted and ready for release',
    blocker: null,
    nextAction: 'Authorize merge and release for candidate fp_1.',
    createdAt: START,
    updatedAt: START,
    acknowledgedAt: null,
    acknowledgedBy: null,
    candidateFingerprint: 'fp_1',
  });

  const response = await h.app.inject({ method: 'GET', url: '/api/attention', headers: { cookie: session.cookie } });
  assert.equal(response.statusCode, 200, response.body);
  const board = parse<{ board: AttentionBoardView }>(response).board;
  assert.equal(board.projectId, PROJECT_ID);
  assert.equal(board.collectedAt, START, 'every read carries the instant it was collected (N04-AC2)');
  assert.deepEqual(board.groups.map((group) => group.bucket), ['Working', 'NeedsYourInput', 'ReadyForRelease']);
  assert.equal(board.groups.find((group) => group.bucket === 'Working')?.items[0]?.attentionItemId, 'attn_working');
  assert.equal(
    board.groups.find((group) => group.bucket === 'NeedsYourInput')?.items[0]?.blocker,
    'the engine binary is not installed',
    'an item carries the blocker it names (F31-AC2)',
  );
  assert.deepEqual(board.persistedItemIds, ['attn_working', 'attn_blocked', 'attn_release']);
});

// F31-AC4: acknowledgement records owner attention and nothing else. The run's own state is
// unchanged, which is what makes an acknowledgement safe to click without thinking.
test('F31-AC4: acknowledging an item changes the item and nothing else', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_unchanged', state: 'Running' });
  h.controller.seedRun(job);
  h.controller.seedAttentionItem({
    attentionItemId: 'attn_one',
    kind: 'Blocker',
    state: 'Open',
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM,
    issueIdentifier: 'OCT-1',
    title: 'Job job_unchanged is blocked',
    blocker: 'the engine binary is not installed',
    nextAction: 'Resolve what is blocking the run, then resume it.',
    createdAt: START,
    updatedAt: START,
    acknowledgedAt: null,
    acknowledgedBy: null,
    candidateFingerprint: null,
  });

  const acknowledged = await h.app.inject({
    method: 'POST',
    url: '/api/attention/attn_one/acknowledge',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
  });
  assert.equal(acknowledged.statusCode, 200, acknowledged.body);
  const item = parse<{ item: AttentionItemView }>(acknowledged).item;
  assert.equal(item.state, 'Acknowledged');
  assert.equal(item.acknowledgedBy, OWNER_ID);
  assert.equal(item.acknowledgedAt, START);
  assert.equal(item.blocker, 'the engine binary is not installed', 'the blocker is unchanged by looking at it');

  // The run's own state is untouched: an acknowledgement is not a decision about the work.
  const run = await h.app.inject({
    method: 'GET',
    url: `/api/runs/${job.jobId}`,
    headers: { cookie: session.cookie },
  });
  assert.equal(parse<{ run: RunView }>(run).run.job.state, 'Running');

  const board = await h.app.inject({ method: 'GET', url: '/api/attention', headers: { cookie: session.cookie } });
  const reread = parse<{ board: AttentionBoardView }>(board).board;
  assert.equal(reread.items.find((entry) => entry.attentionItemId === 'attn_one')?.state, 'Acknowledged');

  const unknown = await h.app.inject({
    method: 'POST',
    url: '/api/attention/attn_absent/acknowledge',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
  });
  assert.equal(unknown.statusCode, 404, unknown.body);
});

// F01-AC1, F01-AC4: every run and attention route is behind the session guard and the forgery check,
// because a run start is the most consequential write this server has and a job identity is private
// run detail. An anonymous caller learns that a sign-in is required and nothing else.
test('F01-AC1, F01-AC4: the run and attention routes refuse an anonymous caller and a missing token', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  await startRun(h, session);
  const jobId = parse<RunStartPayload>(await startRun(h, session, { operationId: 'op_octopus_2' })).run.job.jobId;

  const anonymousReads = [
    '/api/runs',
    `/api/runs/${jobId}`,
    `/api/runs/${jobId}/checkpoint`,
    `/api/runs/${jobId}/review-card`,
    '/api/attention',
  ];
  for (const url of anonymousReads) {
    const response = await h.app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 401, `${url} must refuse an anonymous caller: ${response.body}`);
    assert.equal(parse<ErrorPayload>(response).signInRequired, true);
    assert.ok(!response.body.includes(OWNER_NAME), `${url} must not disclose the owner`);
    assert.ok(!response.body.includes(OWNER_ID), `${url} must not disclose the owner id`);
    assert.ok(!response.body.includes(jobId), `${url} must not disclose a run`);
  }

  const anonymousWrite = await h.app.inject({ method: 'POST', url: '/api/runs', payload: startPayload() });
  assert.equal(anonymousWrite.statusCode, 401, anonymousWrite.body);

  const sessionlessStart = await h.app.inject({
    method: 'POST',
    url: '/api/attention/attn_one/acknowledge',
    headers: { cookie: session.cookie },
  });
  assert.equal(sessionlessStart.statusCode, 403, 'a write without the forgery token is refused (F01-AC4)');
  assert.equal(parse<ErrorPayload>(sessionlessStart).error.code, 'Forbidden');

  const sessionlessPause = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${jobId}/pause`,
    headers: { cookie: session.cookie },
  });
  assert.equal(sessionlessPause.statusCode, 403, sessionlessPause.body);
  assert.equal(parse<ErrorPayload>(sessionlessPause).error.code, 'Forbidden');
});

/**
 * Seeds a candidate gate for a work item.
 *
 * One helper rather than a literal per test, because a criterion id that drifts between
 * the seed and the assertion would make a passing test prove nothing (F25-AC1).
 */
function acceptanceGate(outstanding: readonly string[]): AcceptanceGateView {
  return {
    candidateFingerprint: 'fp_candidate_1',
    headSha: HEAD_SHA,
    scopeFingerprint: SCOPE_FINGERPRINT,
    criteria: [
      {
        criterionId: 'AC1',
        text: 'A durable job row exists for the run.',
        methodKind: 'AutomatedCheck',
        status: outstanding.includes('AC1') ? 'Failed' : 'Verified',
        observed: outstanding.includes('AC1'),
      },
      {
        criterionId: 'AC2',
        text: 'The owner can pause the run.',
        methodKind: 'OwnerTest',
        status: outstanding.includes('AC2') ? 'PendingOwnerTest' : 'Verified',
        observed: outstanding.includes('AC2'),
      },
    ],
    outstandingCriterionIds: [...outstanding],
    ready: outstanding.length === 0,
  };
}

// F25-AC2: requesting changes retains the reason against the tested candidate, and the read-back carries it.
test('F25-AC2: requested changes are retained with the criteria they land on', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_changes', state: 'Completed' });
  h.controller.seedRun(job);
  h.controller.seedAcceptanceGate(WORK_ITEM, acceptanceGate(['AC2']), 'cand_octopus_1');

  const response = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/acceptance`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { decision: 'RequestChanges', reason: 'Pausing still reports the run as running.' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const requested = parse<{ changeRequest: ChangeRequestReportView }>(response).changeRequest;
  assert.equal(requested.state, 'ChangesRequested');
  assert.equal(requested.feedback, 'Pausing still reports the run as running.');
  assert.deepEqual(requested.outstandingCriterionIds, ['AC2'], 'the reason lands on the criterion that failed (F25-AC2)');
  assert.equal(requested.decisionId !== null, true);

  const readBack = await h.app.inject({
    method: 'GET',
    url: `/api/runs/${job.jobId}/acceptance`,
    headers: { cookie: session.cookie },
  });
  assert.equal(readBack.statusCode, 200, readBack.body);
  const body = parse<{ gate: AcceptanceGateView; acceptance: AcceptanceView }>(readBack);
  assert.equal(body.acceptance.state, 'ChangesRequested');
  assert.deepEqual(
    body.acceptance.retainedFeedback.map((entry) => entry.feedback),
    ['Pausing still reports the run as running.'],
    'the feedback survives the decision that recorded it (F25-AC2)',
  );
});

// F25-AC1: acceptance is refused while a criterion is outstanding, and the refusal names it.
test('F25-AC1: acceptance is refused with the outstanding criteria named, not summarised', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_notready', state: 'Completed' });
  h.controller.seedRun(job);
  h.controller.seedAcceptanceGate(WORK_ITEM, acceptanceGate(['AC1', 'AC2']), 'cand_octopus_2');

  const response = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/acceptance`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { decision: 'Accept' },
  });
  assert.equal(response.statusCode, 422, `a blocked acceptance is not a success: ${response.body}`);
  const error = parse<ErrorPayload>(response).error;
  assert.equal(error.code, 'Blocked');
  assert.deepEqual(
    (error.prerequisites ?? []).map((entry) => entry.name),
    ['Criterion AC1', 'Criterion AC2'],
    'each outstanding criterion is named, so the owner knows what to fix (F25-AC1)',
  );
});

// F25-AC1: once every criterion is verified the same request records acceptance.
test('F25-AC1: a fully verified candidate is accepted and records what it was accepted against', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_accept', state: 'Completed' });
  h.controller.seedRun(job);
  h.controller.seedAcceptanceGate(WORK_ITEM, acceptanceGate([]), 'cand_octopus_3');

  const response = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/acceptance`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { decision: 'Accept', note: 'Verified against the preview deployment.' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const accepted = parse<{ acceptance: AcceptanceReportView }>(response).acceptance;
  assert.equal(accepted.state, 'Accepted');
  assert.equal(accepted.headSha, HEAD_SHA, 'the accepted head is named, so a later change is detectable (F25-AC3)');
  assert.equal(accepted.candidateFingerprint, 'fp_candidate_1');

  const readBack = await h.app.inject({
    method: 'GET',
    url: `/api/runs/${job.jobId}/acceptance`,
    headers: { cookie: session.cookie },
  });
  const state = parse<{ acceptance: AcceptanceView }>(readBack).acceptance;
  assert.equal(state.state, 'Accepted');
  assert.equal(state.note, 'Verified against the preview deployment.');
});

// F25-AC2, F02-AC4: the request boundary refuses a rejection with no reason, per field.
test('F25-AC2: requesting changes without a reason is refused beside its field', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_noreason', state: 'Completed' });
  h.controller.seedRun(job);
  h.controller.seedAcceptanceGate(WORK_ITEM, acceptanceGate(['AC2']), 'cand_octopus_4');

  const response = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/acceptance`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { decision: 'RequestChanges' },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(
    (parse<ErrorPayload>(response).error.fields ?? []).map((field) => field.path),
    ['reason'],
    'the refusal names the field to fix (F02-AC4)',
  );

  const unknownDecision = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/acceptance`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { decision: 'AcceptLater' },
  });
  assert.equal(unknownDecision.statusCode, 400, unknownDecision.body);
  assert.deepEqual(
    (parse<ErrorPayload>(unknownDecision).error.fields ?? []).map((field) => field.path),
    ['decision'],
  );

  const extraKey = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/acceptance`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { decision: 'Accept', candidateId: 'cand_somewhere_else' },
  });
  assert.equal(extraKey.statusCode, 400, `an unrecognised key is refused, not dropped (F02-AC4): ${extraKey.body}`);
});

// F25-AC1: a run whose work item has no candidate has nothing to decide about.
test('F25-AC1: a run with no candidate yet cannot be accepted', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_nocandidate', state: 'Queued' });
  h.controller.seedRun(job);

  const response = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/acceptance`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { decision: 'Accept' },
  });
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(parse<ErrorPayload>(response).error.code, 'NotFound');
});

// F01-AC1, F01-AC4: the decision is a write and sits behind the session and forgery gates.
test('F01-AC1: an acceptance decision needs a session and a forgery token', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_guard', state: 'Completed' });
  h.controller.seedRun(job);
  h.controller.seedAcceptanceGate(WORK_ITEM, acceptanceGate([]), 'cand_octopus_5');

  const anonymous = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/acceptance`,
    payload: { decision: 'Accept' },
  });
  assert.equal(anonymous.statusCode, 401, anonymous.body);

  const sessionless = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/acceptance`,
    headers: { cookie: session.cookie },
    payload: { decision: 'Accept' },
  });
  assert.equal(sessionless.statusCode, 403, sessionless.body);
  assert.equal(parse<ErrorPayload>(sessionless).error.code, 'Forbidden');

  const anonymousRead = await h.app.inject({ method: 'GET', url: `/api/runs/${job.jobId}/acceptance` });
  assert.equal(anonymousRead.statusCode, 401, anonymousRead.body);
});

/* Manual owner test recording (F23, F24-AC4, F25-AC1, F25-AC4, F01)             */
/* -------------------------------------------------------------------------- */

/**
 * A manual criterion observation the transport accepts.
 *
 * One deployment target, one evidence reference and one note, so a case can vary exactly one
 * of them. Every field here is something the owner chose; the observer, the instant and the
 * candidate are not in this object and cannot be added to it (F25-AC4).
 */
function ownerObservationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    criterionId: 'AC2',
    expectedCandidateFingerprint: 'fp_candidate_1',
    observation: 'BehaviorConfirmed',
    observedAgainst: {
      kind: 'Deployment',
      component: 'web',
      deploymentId: 'dep_octopus_1',
      environment: 'preview',
    },
    evidence: { kind: 'Screenshot', reference: 'screenshots/review-card.png' },
    note: 'The wording reads as the owner expects.',
    ...overrides,
  };
}

// F23-AC1, F23-AC3, F25-AC1: the write records the criterion, the exact fingerprint, the deployment
// it was made against, the authenticated owner, the instant and the retained evidence reference.
test('F23-AC3: a recorded observation names the fingerprint, the deployment, the owner and the evidence', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_owner_test', state: 'Completed' });
  h.controller.seedRun(job);
  h.controller.seedAcceptanceGate(WORK_ITEM, acceptanceGate(['AC2']), 'cand_octopus_owner_test');

  const response = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/owner-observations`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: ownerObservationBody(),
  });
  assert.equal(response.statusCode, 200, response.body);
  const report = parse<{ report: OwnerObservationReportView }>(response).report;
  const observation = report.observation;
  assert.equal(observation.criterionId, 'AC2');
  assert.equal(observation.candidateFingerprint, 'fp_candidate_1', 'bound to the exact fingerprint the owner acted on (F23-AC3)');
  assert.equal(observation.methodKind, 'OwnerTest', 'it is never read as an automated check (F23-AC5)');
  assert.equal(observation.status, 'Verified');
  assert.equal(observation.failureKind, null);
  assert.equal(observation.deploymentId, 'dep_octopus_1', 'the deployment it was made against travels with it (F23-AC3)');
  assert.equal(observation.component, 'web');
  assert.equal(observation.environment, 'Preview');
  assert.equal(observation.evidenceRef, 'screenshots/review-card.png', 'the retained evidence reference is reported (F23-AC2)');
  assert.equal(observation.evidenceKind, 'Screenshot');
  assert.equal(observation.observedBy, OWNER_ID, 'the observer is the session this request proved, never the body (F25-AC4)');
  assert.equal(observation.observedAt, START, 'the instant is this process\'s, so it cannot be backdated (F23-AC3)');
  assert.equal(
    report.recordedForDelivery,
    false,
    'recording one observation is not accepting the work (F25-AC1, F24-AC3)',
  );

  const read = await h.app.inject({
    method: 'GET',
    url: `/api/runs/${job.jobId}/owner-observations?candidateFingerprint=fp_candidate_1`,
    headers: { cookie: session.cookie },
  });
  assert.equal(read.statusCode, 200, read.body);
  const listed = parse<{ observations: readonly OwnerObservationView[] }>(read).observations;
  assert.equal(listed.length, 1, 'what was recorded reads back under the same identity (F20-AC3)');
  assert.equal(listed[0]?.evidenceRef, 'screenshots/review-card.png');
});

// F24-AC4, F20-AC3: a submission prepared against a candidate that is no longer current is refused
// with both identities, and nothing is recorded against the candidate that replaced it.
test('F24-AC4: a submission against a superseded candidate is refused with a Conflict and records nothing', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_stale_owner_test', state: 'Completed' });
  h.controller.seedRun(job);
  h.controller.seedAcceptanceGate(WORK_ITEM, acceptanceGate(['AC2']), 'cand_octopus_stale');

  const stale = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/owner-observations`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: ownerObservationBody({ expectedCandidateFingerprint: 'fp_the_previous_build' }),
  });
  assert.equal(stale.statusCode, 409, stale.body);
  const problem = parse<ErrorPayload>(stale);
  assert.equal(problem.error.code, 'Conflict');
  assert.equal(problem.error.expected, 'fp_the_previous_build', 'the conflict names what the owner acted on (F24-AC4)');
  assert.equal(problem.error.actual, 'fp_candidate_1', 'and the candidate that is current, so the owner can re-read (F24-AC4)');

  const recorded = await h.app.inject({
    method: 'GET',
    url: `/api/runs/${job.jobId}/owner-observations?candidateFingerprint=fp_candidate_1`,
    headers: { cookie: session.cookie },
  });
  assert.deepEqual(
    parse<{ observations: readonly OwnerObservationView[] }>(recorded).observations,
    [],
    'the refusal recorded nothing against the candidate that replaced it (F24-AC4, F20-AC3)',
  );
});

// F23-AC5: a capture failure, a behaviour failure and a confirmation are three distinguishable
// answers, and the failed one is still not an automated check result.
test('F23-AC5: a capture failure and a behaviour failure are reported as different outcomes', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_capture_failure', state: 'Completed' });
  h.controller.seedRun(job);
  h.controller.seedAcceptanceGate(WORK_ITEM, acceptanceGate(['AC2']), 'cand_octopus_capture');

  const post = (payload: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: `/api/runs/${job.jobId}/owner-observations`,
      headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
      payload,
    });

  const captured = await post(
    ownerObservationBody({ observation: 'CaptureFailed', note: 'The recording tool never started.' }),
  );
  assert.equal(captured.statusCode, 200, captured.body);
  const captureFailure = parse<{ report: OwnerObservationReportView }>(captured).report.observation;
  assert.equal(captureFailure.status, 'Missing', 'a capture failure observed no behaviour (F23-AC5)');
  assert.equal(captureFailure.failureKind, 'CaptureFailure');

  const failed = await post(
    ownerObservationBody({ observation: 'BehaviorFailed', note: 'The card omitted the failing check.' }),
  );
  assert.equal(failed.statusCode, 200, failed.body);
  const behaviourFailure = parse<{ report: OwnerObservationReportView }>(failed).report.observation;
  assert.equal(behaviourFailure.status, 'Failed');
  assert.equal(behaviourFailure.failureKind, 'BehaviorFailure');
  assert.equal(behaviourFailure.methodKind, 'OwnerTest', 'a failed owner test is not a failed automated check (F23-AC5)');
  assert.notEqual(behaviourFailure.status, captureFailure.status, 'the two stay distinguishable (F23-AC5)');
});

// F25-AC4, F01-AC1, F02-AC4: the body cannot name the observer, the instant or the candidate, and
// each attempt is refused by field name rather than silently ignored.
test('F25-AC4: a body cannot claim the observer, the instant or the candidate', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_no_actor', state: 'Completed' });
  h.controller.seedRun(job);
  h.controller.seedAcceptanceGate(WORK_ITEM, acceptanceGate(['AC2']), 'cand_octopus_actor');

  const forged = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/owner-observations`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: ownerObservationBody({ actor: 'own_somebody_else', observedBy: 'own_somebody_else' }),
  });
  assert.equal(forged.statusCode, 400, forged.body);
  const fields = (parse<ErrorPayload>(forged).error.fields ?? []).map((field) => field.path);
  assert.deepEqual(fields, ['actor', 'observedBy'], 'a request naming its own observer is refused by field name (F25-AC4)');

  const backdated = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/owner-observations`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: ownerObservationBody({ observedAt: '2020-01-01T00:00:00.000Z' }),
  });
  assert.equal(backdated.statusCode, 400, backdated.body);
  assert.deepEqual(
    (parse<ErrorPayload>(backdated).error.fields ?? []).map((field) => field.path),
    ['observedAt'],
    'an observation cannot be backdated (F23-AC3)',
  );

  const named = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/owner-observations`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: ownerObservationBody({ candidateId: 'cand_somewhere_else' }),
  });
  assert.equal(named.statusCode, 400, named.body);
  assert.deepEqual(
    (parse<ErrorPayload>(named).error.fields ?? []).map((field) => field.path),
    ['candidateId'],
    'a request cannot choose the candidate; the run and the fingerprint decide it (F24-AC4)',
  );
});

// F23-AC3, F23-AC4: the deployment is a required union, so neither "which deployment did you
// observe" nor "which candidate" can be left blank for the server to guess.
test('F23-AC4: the deployment must be named or explicitly ruled out', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_target', state: 'Completed' });
  h.controller.seedRun(job);
  h.controller.seedAcceptanceGate(WORK_ITEM, acceptanceGate(['AC2']), 'cand_octopus_target');

  const post = (payload: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: `/api/runs/${job.jobId}/owner-observations`,
      headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
      payload,
    });

  const blank = await post(ownerObservationBody({ observedAgainst: null }));
  assert.equal(blank.statusCode, 400, blank.body);
  assert.deepEqual(
    (parse<ErrorPayload>(blank).error.fields ?? []).map((field) => field.path),
    ['observedAgainst'],
    'leaving the deployment blank is refused rather than guessed (F23-AC4)',
  );

  const unexplained = await post(ownerObservationBody({ observedAgainst: { kind: 'NoDeployment', reason: '  ' } }));
  assert.equal(unexplained.statusCode, 400, unexplained.body);
  assert.deepEqual(
    (parse<ErrorPayload>(unexplained).error.fields ?? []).map((field) => field.path),
    ['observedAgainst.reason'],
    'ruling out every deployment needs a reason, so the record is not an unexplained absence (F23-AC3)',
  );

  const noDeployment = await post(
    ownerObservationBody({ observedAgainst: { kind: 'NoDeployment', reason: 'This project deploys nothing.' } }),
  );
  assert.equal(noDeployment.statusCode, 200, noDeployment.body);
  assert.equal(
    parse<{ report: OwnerObservationReportView }>(noDeployment).report.observation.environment,
    'Local',
    'the environment label follows the target the owner stated (F23-AC4)',
  );

  const noEvidence = await post(ownerObservationBody({ evidence: { kind: 'Screenshot', reference: '' } }));
  assert.equal(noEvidence.statusCode, 400, noEvidence.body);
  assert.deepEqual(
    (parse<ErrorPayload>(noEvidence).error.fields ?? []).map((field) => field.path),
    ['evidence.reference'],
    'an observation without a retained reference is refused (F23-AC2)',
  );

  const unknownObservation = await post(ownerObservationBody({ observation: 'ProbablyFine' }));
  assert.equal(unknownObservation.statusCode, 400, unknownObservation.body);
  assert.deepEqual(
    (parse<ErrorPayload>(unknownObservation).error.fields ?? []).map((field) => field.path),
    ['observation'],
    'the three reportable outcomes are named rather than accepting a claim of confidence (F23-AC5)',
  );
});

// F01-AC1, F01-AC4: recording is a write, so it needs a session and a forgery token, and the read
// refuses an anonymous caller.
test('F01-AC4: recording an observation needs a session and a forgery token', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const job = queuedRun({ jobId: 'job_owner_guard', state: 'Completed' });
  h.controller.seedRun(job);
  h.controller.seedAcceptanceGate(WORK_ITEM, acceptanceGate(['AC2']), 'cand_octopus_guard');

  const anonymous = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/owner-observations`,
    payload: ownerObservationBody(),
  });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  assert.equal(parse<ErrorPayload>(anonymous).signInRequired, true);
  assert.ok(!anonymous.body.includes(OWNER_ID), 'the refusal discloses no owner (F01-AC1)');

  const sessionless = await h.app.inject({
    method: 'POST',
    url: `/api/runs/${job.jobId}/owner-observations`,
    headers: { cookie: session.cookie },
    payload: ownerObservationBody(),
  });
  assert.equal(sessionless.statusCode, 403, sessionless.body);
  assert.equal(parse<ErrorPayload>(sessionless).error.code, 'Forbidden');

  const anonymousRead = await h.app.inject({
    method: 'GET',
    url: `/api/runs/${job.jobId}/owner-observations?candidateFingerprint=fp_candidate_1`,
  });
  assert.equal(anonymousRead.statusCode, 401, anonymousRead.body);

  const unsignedRead = await h.app.inject({
    method: 'GET',
    url: `/api/runs/${job.jobId}/owner-observations`,
    headers: { cookie: session.cookie },
  });
  assert.equal(unsignedRead.statusCode, 400, unsignedRead.body);
  assert.deepEqual(
    (parse<ErrorPayload>(unsignedRead).error.fields ?? []).map((field) => field.path),
    ['candidateFingerprint'],
    'a read names the identity it is asking about, because an answer spanning every identity would read as one build inheriting another\'s (F20-AC3)',
  );
});

/* Planning, readiness, publication and adoption (F08, F09, F10, F11)          */
/* -------------------------------------------------------------------------- */

/**
 * A plan body the transport accepts, and the double turns into a plan.
 *
 * Two independently reviewable surfaces, so the plan is a split and the split carries
 * a reason; a single surface would be refused by the domain for over-decomposition and
 * this file would then be testing the wrong thing (F08-AC2).
 */
function planProposalBody(): Record<string, unknown> {
  return {
    kind: 'PlanProposal',
    briefId: 'brief_http_1',
    draftedAt: '2026-03-01T12:00:00.000Z',
    basedOnRevision: null,
    requestedOutcomes: [{ id: 'out_1', statement: 'The owner can see why a build was refused.' }],
    tasks: [
      {
        taskId: 'task_1',
        outcome: 'The readiness screen names every area it assessed.',
        scope: 'Add the readiness assessment to the plan screen.',
        acceptanceCriteria: ['Every area F09-AC1 names is on screen with a reason.'],
        verificationMethod: 'The browser suite reads each area.',
        dependencies: [],
        relevantProjectContext: ['apps/web/src/ui'],
        implementationLocation: {
          kind: 'ProposedLocation',
          candidates: ['apps/web/src/ui/pages/PlanPage.tsx'],
          basis: 'The plan screen renders readiness.',
        },
        coversOutcomeIds: ['out_1'],
      },
      {
        taskId: 'task_2',
        outcome: 'A refused build still allows read-only investigation.',
        scope: 'Disable the build control and keep the investigation control.',
        acceptanceCriteria: ['The build control is disabled and says which area blocks it.'],
        verificationMethod: 'The browser suite reads the two controls.',
        dependencies: ['task_1'],
        relevantProjectContext: ['apps/web/src/ui'],
        implementationLocation: {
          kind: 'ProposedLocation',
          candidates: ['apps/web/src/ui/pages/PlanPage.tsx'],
          basis: 'The same screen owns both controls.',
        },
        coversOutcomeIds: ['out_1'],
      },
    ],
    exclusions: [],
  };
}

async function draftPlan(h: Harness, session: Session): Promise<PlanPayload> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/plans',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: {
      ideaId: 'idea_1',
      planId: 'plan_http_1',
      change: {
        summary: 'Show readiness on the plan screen.',
        surfaces: [
          {
            surfaceId: 'readiness_panel',
            description: 'The readiness assessment panel.',
            observableBehaviour: 'Every area and its reason are readable.',
            independentlyReviewable: true,
          },
          {
            surfaceId: 'build_control',
            description: 'The build and investigation controls.',
            observableBehaviour: 'Build is disabled with a named blocker; investigation is not.',
            independentlyReviewable: true,
          },
        ],
        dependencyEdges: [{ surface: 'build_control', dependsOn: 'readiness_panel' }],
      },
      proposal: planProposalBody(),
    },
  });
  assert.equal(response.statusCode, 201, `plan draft failed: ${response.body}`);
  return parse<PlanPayload>(response);
}

test('F08-AC1, F08-AC2, F08-AC5: a drafted plan carries every field F08-AC1 names and the reason for its split', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const { plan } = await draftPlan(h, session);

  assert.equal(plan.revision, 1);
  assert.equal(plan.split.split, true, 'two independently reviewable surfaces justify a split (F08-AC2)');
  assert.ok(plan.split.reason.length > 0, 'the split reason must be inspectable (F08-AC2)');

  for (const outcome of plan.requestedOutcomes) {
    assert.ok(
      plan.coverage.some((entry) => entry.outcomeId === outcome.id),
      `requested outcome ${outcome.id} must be accounted for (F08-AC5)`,
    );
  }

  for (const task of plan.tasks) {
    assert.ok(task.outcome.length > 0, 'F08-AC1: outcome');
    assert.ok(task.scope.length > 0, 'F08-AC1: scope');
    assert.ok(task.acceptanceCriteria.length > 0, 'F08-AC1: acceptance criteria');
    assert.ok(task.verificationMethod.length > 0, 'F08-AC1: verification method');
    assert.ok(Array.isArray(task.dependencies), 'F08-AC1: dependencies');
    assert.ok(task.relevantProjectContext.length > 0, 'F08-AC1: relevant project context');
    assert.equal(task.implementationLocation.kind, 'ProposedLocation', 'F08-AC5: a location is a proposal');
    assert.ok(task.implementationLocation.candidates.length > 0, 'F08-AC5: a proposal offers candidates');
    assert.ok(task.implementationLocation.basis.length > 0, 'F08-AC5: a proposal states its basis');
  }

  // F08-AC4: the proposed order puts the prerequisite first, which is what makes the
  // dependency visible rather than implied by the dependency list.
  assert.deepEqual(plan.proposedOrder, ['task_1', 'task_2']);
});

test('F08-AC3: an unaccepted proposal is not publishable, and accepting is what makes it so', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const { plan } = await draftPlan(h, session);
  assert.equal(
    plan.tasks.every((task) => !task.publishable),
    true,
    'a freshly drafted plan has no publishable task (F08-AC3)',
  );

  const publishAttempt = await h.app.inject({
    method: 'POST',
    url: `/api/plans/${plan.planId}/publish`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { requestId: 'req_no_acceptances' },
  });
  assert.equal(publishAttempt.statusCode, 400, 'publishing nothing accepted must be refused (F08-AC3)');
  assert.ok(!publishAttempt.body.includes('"published"'), 'the refusal must not carry a publication report');

  const accepted = await h.app.inject({
    method: 'POST',
    url: `/api/plans/${plan.planId}/edit`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { kind: 'Accept', taskId: 'task_1', expectedRevision: plan.revision },
  });
  assert.equal(accepted.statusCode, 200, `accept failed: ${accepted.body}`);
  const afterAccept = parse<PlanPayload>(accepted).plan;
  assert.equal(afterAccept.revision, 2, 'an edit appends the next revision (F08-AC3)');
  assert.equal(afterAccept.lastEditedBy, OWNER_ID, 'the edit records the owner the session proved (F01-AC1)');
  assert.equal(afterAccept.tasks.find((task) => task.taskId === 'task_1')?.acceptance, 'Accepted');
  assert.equal(afterAccept.tasks.find((task) => task.taskId === 'task_1')?.publishable, true);
  assert.equal(
    afterAccept.tasks.find((task) => task.taskId === 'task_2')?.publishable,
    false,
    'accepting one task must not publish the other (F08-AC3)',
  );
});

test('F08-AC3: a stale edit is a conflict rather than a merge into a newer revision', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const { plan } = await draftPlan(h, session);

  const first = await h.app.inject({
    method: 'POST',
    url: `/api/plans/${plan.planId}/edit`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { kind: 'Accept', taskId: 'task_1', expectedRevision: plan.revision },
  });
  assert.equal(first.statusCode, 200);

  const stale = await h.app.inject({
    method: 'POST',
    url: `/api/plans/${plan.planId}/edit`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { kind: 'Accept', taskId: 'task_2', expectedRevision: plan.revision },
  });
  assert.equal(stale.statusCode, 409, 'an edit against a revision the owner no longer sees is a conflict (F08-AC3)');
  const refusal = parse<ErrorPayload>(stale).error;
  assert.equal(refusal.code, 'Conflict');
  assert.equal(refusal.expected, 'revision 2');
  assert.equal(refusal.actual, 'revision 1');
});

test('F08-AC3: an edit naming a lifecycle field is refused at the boundary', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const { plan } = await draftPlan(h, session);

  const refusal = await h.app.inject({
    method: 'POST',
    url: `/api/plans/${plan.planId}/edit`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: {
      kind: 'Edit',
      taskId: 'task_1',
      expectedRevision: plan.revision,
      changes: { scope: 'A wider scope.', acceptance: 'Accepted' },
    },
  });
  assert.equal(refusal.statusCode, 400);
  const fields = parse<ErrorPayload>(refusal).error.fields ?? [];
  assert.ok(
    fields.some((field) => field.path.includes('acceptance')),
    `the refusal must name the lifecycle field: ${JSON.stringify(fields)}`,
  );
});

test('F09-AC1, F09-AC2: readiness is a recorded assessment over every area, with build and build-blocking areas together', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const { plan } = await draftPlan(h, session);

  const response = await h.app.inject({
    method: 'GET',
    url: `/api/plans/${plan.planId}/readiness`,
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const { assessment } = parse<{ assessment: ReadinessAssessmentView }>(response);

  assert.equal(assessment.areas.length, 7, 'every area F09-AC1 names is present, satisfied or not (F09-AC1)');
  assert.deepEqual(
    assessment.areas.map((area) => area.area),
    ['Scope', 'Criteria', 'Repository', 'Target', 'Dependencies', 'Verification', 'Access'],
    'the areas are in the order the specification lists them (F09-AC1)',
  );
  for (const area of assessment.areas) {
    assert.ok(area.reason.length > 0, `the ${area.area} area must carry a reason (F09-AC1)`);
    if (area.status !== 'Satisfied') {
      assert.ok(area.remedy !== null, `an open ${area.area} area must name a remedy (F09-AC1)`);
    }
  }
  // F09-AC2: the boolean and the blocking areas are two readings of one decision, and
  // the transport must not let them disagree.
  if (assessment.mayStartBuild) {
    assert.deepEqual(assessment.buildBlockingAreas, [], 'nothing is blocking while the build may start (F09-AC2)');
  } else {
    assert.ok(assessment.buildBlockingAreas.length > 0, 'a disabled build names the areas blocking it (F09-AC2)');
  }
  assert.equal(typeof assessment.mayStartInvestigation, 'boolean', 'investigation permission is stated separately (F09-AC2)');
});

test('F10-AC2: publication reports per proposed ticket and names what remains unpublished', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const { plan } = await draftPlan(h, session);

  let revision = plan.revision;
  for (const taskId of ['task_1', 'task_2']) {
    const accepted = await h.app.inject({
      method: 'POST',
      url: `/api/plans/${plan.planId}/edit`,
      headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
      payload: { kind: 'Accept', taskId, expectedRevision: revision },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    revision = parse<PlanPayload>(accepted).plan.revision;
  }

  const published = await h.app.inject({
    method: 'POST',
    url: `/api/plans/${plan.planId}/publish`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { requestId: 'req_partial_1' },
  });
  assert.equal(published.statusCode, 200, published.body);
  const { report } = parse<{ report: PublicationReportView }>(published);

  assert.equal(report.requestId, 'req_partial_1', 'the report echoes the caller\'s request id (F10-AC3)');
  assert.equal(report.tickets.length, 2, 'every proposed ticket is reported on (F10-AC2)');
  assert.equal(report.published.length, 1, 'one ticket succeeded (F10-AC2)');
  assert.equal(report.unpublished.length, 1, 'the remainder is named rather than inferred (F10-AC2)');
  assert.equal(report.reconciled, false, 'this request wrote, so it did not reconcile (F10-AC3)');

  const succeeded = report.tickets.find((ticket) => ticket.kind === 'Published');
  assert.ok(succeeded !== undefined, 'the successful ticket is present (F10-AC2)');
  assert.equal(succeeded?.identifier, 'OCT-1');
  assert.ok((succeeded?.url ?? '').length > 0, 'a published ticket saves its URL (F10-AC2)');

  const failed = report.tickets.find((ticket) => ticket.kind === 'Failed');
  assert.ok(failed !== undefined, 'the failed ticket is present (F10-AC2)');
  assert.ok((failed?.detail ?? '').length > 0, 'a refused ticket carries a useful explanation (F10-AC5)');
  assert.ok(report.unpublished.includes(failed?.workItemId ?? 'absent'), 'the failure appears in what remains (F10-AC2)');
});

test('F10-AC3: a publication without a request id is refused, because a retry must be able to present the same one', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const { plan } = await draftPlan(h, session);

  const refused = await h.app.inject({
    method: 'POST',
    url: `/api/plans/${plan.planId}/publish`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: {},
  });
  assert.equal(refused.statusCode, 400);
  assert.ok(
    (parse<ErrorPayload>(refused).error.fields ?? []).some((field) => field.path === 'requestId'),
    'the refusal names the request id (F10-AC3)',
  );
});

test('F11-AC3, F11-AC5: adoption refusals arrive intact and a Build request for adopted work is refused', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);

  const wrongTeam = await h.app.inject({
    method: 'POST',
    url: '/api/adoption/issue',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: {
      projectId: PROJECT_ID,
      profileVersionId: 'pv_1',
      procedureVersionId: 'proc_1',
      issueId: 'issue_foreign',
      expectedIdentifier: 'OCT-664',
      title: 'Existing work',
    },
  });
  assert.equal(wrongTeam.statusCode, 503, 'the double refuses adoption by name (F03-AC2)');
  assert.ok(wrongTeam.body.includes('adoptExistingIssue'), `the refusal names the use case: ${wrongTeam.body}`);

  const buildRequest = await h.app.inject({
    method: 'POST',
    url: '/api/adoption/evaluate',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { workItemId: 'wi_http', mode: 'Build' },
  });
  assert.equal(buildRequest.statusCode, 400);
  const fields = parse<ErrorPayload>(buildRequest).error.fields ?? [];
  assert.ok(
    fields.some((field) => field.path === 'mode'),
    `a Build request must be refused by name: ${JSON.stringify(fields)}`,
  );
  assert.ok(
    parse<ErrorPayload>(buildRequest).error.message.includes('F11-AC5'),
    `the refusal must cite the criterion it enforces: ${buildRequest.body}`,
  );
});

test('F01-AC1: every planning and adoption route refuses an anonymous request', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const anonymous: { readonly method: 'GET' | 'POST'; readonly url: string; readonly payload?: Record<string, unknown> }[] = [
    { method: 'POST', url: '/api/plans', payload: { ideaId: 'idea_1', planId: 'plan_1', change: {}, proposal: {} } },
    { method: 'GET', url: '/api/plans/plan_1' },
    { method: 'GET', url: '/api/plans/plan_1/readiness' },
    { method: 'POST', url: '/api/plans/plan_1/edit', payload: { kind: 'Accept', taskId: 'task_1', expectedRevision: 1 } },
    { method: 'POST', url: '/api/plans/plan_1/publish', payload: { requestId: 'req_1' } },
    { method: 'POST', url: '/api/plans/plan_1/reconcile-publication', payload: { operationId: 'pub:req_1:wi_1' } },
    { method: 'POST', url: '/api/adoption/issue', payload: { projectId: PROJECT_ID } },
    { method: 'POST', url: '/api/adoption/change', payload: { workItemId: 'wi_1', branch: 'main' } },
    { method: 'POST', url: '/api/adoption/evaluate', payload: { workItemId: 'wi_1', mode: 'Review' } },
  ];

  for (const request of anonymous) {
    const response = await h.app.inject({
      method: request.method,
      url: request.url,
      ...(request.payload === undefined ? {} : { payload: request.payload }),
    });
    assert.equal(response.statusCode, 401, `${request.method} ${request.url} must refuse an anonymous request`);
    assert.ok(
      !response.body.includes(PROJECT_ID) && !response.body.includes('plan_1'),
      `${request.url} leaked plan content: ${response.body}`,
    );
  }
});

test('F02-AC4: an unknown key in a plan proposal is refused rather than dropped', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);

  const response = await h.app.inject({
    method: 'POST',
    url: '/api/plans',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: {
      ideaId: 'idea_1',
      planId: 'plan_unknown_key',
      change: {
        summary: 'A change.',
        surfaces: [{ surfaceId: 's1', description: 'd', observableBehaviour: 'b', independentlyReviewable: true }],
        dependencyEdges: [],
      },
      proposal: { ...planProposalBody(), status: 'Ready' },
    },
  });
  assert.equal(response.statusCode, 400);
  assert.ok(
    (parse<ErrorPayload>(response).error.fields ?? []).some((field) => field.path.includes('status')),
    `a lifecycle key must be refused by name: ${response.body}`,
  );
});
