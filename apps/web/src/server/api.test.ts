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
  capabilitiesFor,
  conflict,
  fingerprint,
  hashPassword,
  hashSessionToken,
  ok,
  outcomeUnknown,
  sessionDeadlines,
  verifyPassword,
  type CapabilityDeclaration,
  type CapabilityKind,
  type ConnectorId,
  type DomainError,
  type IdeaId,
  type OwnerId,
  type ProfileVersionId,
  type ProjectId,
  type Result,
} from '@shiploop/domain';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { describeConfigErrors, readServerConfig, type ServerConfig } from './config.ts';
import {
  isControllerSurface,
  type BriefVersionView,
  type ClarificationRoundView,
  type ClarifyingQuestionView,
  type ConnectorView,
  type ControllerSurface,
  type CorrectionView,
  type CreateSessionCommand,
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
  type PlanTaskView,
  type PlanView,
  type PublicationReportView,
  type ReadinessAssessmentView,
  type ProfileContent,
  type ProfileVersionView,
  type ProvisionOwnerCommand,
  type RegisterConnectorCommand,
  type RelatednessReportView,
  type RelatedWorkChoiceView,
  type RevokeConnectorCommand,
  type RevokeSessionCommand,
  type SaveProfileVersionCommand,
  type SignInCommand,
  type SignInGrant,
  type StoredSessionRecord,
  type TouchSessionCommand,
} from './contracts.ts';

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

interface OwnerPayload {
  readonly owner: { readonly ownerId: string; readonly displayName: string };
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
  private passwordHash = '';
  private readonly scripted = new Map<string, DomainError>();

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
      return ok({ ownerId: OWNER_ID, displayName: command.displayName, createdAt: command.at });
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
    owners: { provision() {}, signIn() {} },
    sessions: { loadByToken() {}, create() {}, revoke() {}, touch() {} },
    profiles: { saveVersion() {}, currentVersion() {}, listVersions() {} },
    connectors: { register() {}, listForProject() {}, revoke() {} },
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
  };
  assert.equal(isControllerSurface(complete), true);
  const missingPlanningMethod = {
    ...complete,
    planning: { ...complete.planning, publishPlan: undefined },
  };
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
