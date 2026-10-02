/**
 * Behavioural proof for plan generation: an executable proposal from an agreed brief,
 * the refusals that stand between the engine's answer and a stored plan, and the fact
 * that storing one publishes nothing (F08-AC1, F08-AC2, F08-AC3, F08-AC5, F05-AC2,
 * F05-AC4, F05-AC5, F01-AC1, N02-AC2).
 *
 * Every case runs against a real SQLite file in a fresh temporary directory, opened by
 * `createCompositionRoot`, which runs the real `migrate`. No inline fixture schema
 * appears here: the brief under test is drafted and agreed through the real intake use
 * cases, the plan is stored through the real `SqlitePlanStore`, and the side-effect
 * assertions count rows in the production tables rather than in a list of calls (F06-AC2).
 *
 * The engine is the shipped `FakeEngineAdapter` — the same `EngineAdapter` contract the
 * production `CodexEngineAdapter` implements, driven through
 * `planEngineFromAdapter` rather than a locally declared copy. The one live case at the
 * end builds the real Codex adapter and is skipped unless the operator asks for it with
 * an environment flag (N05-AC2).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexEngineAdapter, FakeConditions, FakeEngineAdapter, SideEffectLedger } from '@shiploop/adapters';
import type { AdapterContext, ExecutionWorkspace } from '@shiploop/adapters';
import { fingerprint } from '@shiploop/domain';
import type {
  Brief,
  CapabilityDeclaration,
  CapabilityKind,
  ChangeShape,
  CommitSha,
  DomainError,
  IdeaId,
  InvalidError,
  ProjectId,
} from '@shiploop/domain';
import type { AdapterRegistry, ConnectorProbe } from './connectors.ts';
import type { BriefSectionsInput } from './intake.ts';
import type { CompositionRoot } from './composition.ts';
import { createCompositionRoot } from './composition.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';
import {
  PLAN_ENGINE_CAPABILITIES,
  PLAN_ENGINE_MODE,
  createPlanContextReader,
  createPlanGenerationUseCases,
  decodePlanProposal,
  engineTextOf,
  planEngineFromAdapter,
  planIdForGeneration,
} from './plan-generation.ts';
import type { PlanContextPacket, PlanContextRequest, PlanEngine } from './plan-generation.ts';

/* -------------------------------------------------------------------------- */
/* Fixture constants                                                            */
/* -------------------------------------------------------------------------- */

const NOW = '2026-10-02T12:00:00.000Z';
const LATER = '2026-10-02T13:00:00.000Z';
const FAST_PASSWORD_COST = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16 };
const SESSION_IDLE_SECONDS = 900;
const CONNECTOR_ID = 'connector_plan_generation' as never;

const OWNER: OwnerActor = {
  actorId: 'owner_plan_generation',
  role: 'Owner',
  ownerId: 'owner_plan_generation' as OwnerActor['ownerId'],
  sessionId: 'session_plan_generation',
};

const NON_OWNER: OwnerActor = {
  actorId: 'coding-agent-plan-generation',
  role: 'CodingAgent',
  ownerId: null,
  sessionId: null,
};

const DESIRED_OUTCOME = 'An owner can see why a build may not start.';
const CRITERION_ONE = 'The readiness assessment shows 7 areas, and each area shows its own status and reason.';
const CRITERION_TWO = 'Publishing a plan with no accepted task creates 0 issues and reports 0 publishable tickets.';
const CRITERION_THREE = 'Each open area of the readiness assessment shows the surface it belongs to.';

const OUTCOME_IDS = ['brief.desiredOutcome', 'AC-1', 'AC-2'] as const;

const adapters: AdapterRegistry = {
  declarationsFor: (): readonly CapabilityDeclaration[] => [],
  probeFor: (): ConnectorProbe | null => null,
};

function steppingClock(): ControllerClock {
  let ticks = 0;
  return {
    now: (): string => {
      ticks += 1;
      return ticks === 1 ? NOW : `${LATER}#${String(ticks)}`;
    },
  };
}

/** The brief sections every case plans from, before any correction. */
const INITIAL_SECTIONS: BriefSectionsInput = {
  problem: 'A build started without knowing whether its prerequisites were met.',
  desiredOutcome: DESIRED_OUTCOME,
  includedBehaviour: ['A readiness assessment the owner can read.'],
  excludedBehaviour: ['Nothing is published by showing readiness.'],
  assumptions: ['The project has a saved profile.'],
  acceptanceCriteria: [
    { id: 'AC-1', text: CRITERION_ONE, verification: 'Read the assessment on the review screen.' },
    { id: 'AC-2', text: CRITERION_TWO, verification: 'Ask the plan for its publishable tickets.' },
  ],
  unresolvedQuestions: [],
};

/** The two-surface change: each surface is reviewable alone and one depends on the other. */
const TWO_SURFACE_CHANGE: ChangeShape = {
  summary: 'Show the readiness assessment and gate publication on acceptance.',
  surfaces: [
    {
      surfaceId: 'readiness_panel',
      description: 'The readiness panel.',
      observableBehaviour: 'Every area and its reason are readable on the panel.',
      independentlyReviewable: true,
    },
    {
      surfaceId: 'publish_gate',
      description: 'The publish control.',
      observableBehaviour: 'Publication is offered only for an accepted proposal.',
      independentlyReviewable: true,
    },
  ],
  dependencyEdges: [{ surface: 'publish_gate', dependsOn: 'readiness_panel' }],
};

/** The one-file change: one surface, nothing to review on its own, no dependency. */
const ONE_FILE_CHANGE: ChangeShape = {
  summary: 'Correct the readiness reason shown for an undecided verification method.',
  surfaces: [
    {
      surfaceId: 'readiness_reason_copy',
      description: 'The wording of one readiness reason.',
      observableBehaviour: 'The undecided verification reason reads the way the specification states it.',
      independentlyReviewable: false,
    },
  ],
  dependencyEdges: [],
};

function location(taskId: string): Record<string, unknown> {
  return {
    kind: 'ProposedLocation',
    candidates: [`packages/controller/src/${taskId}.ts`],
    basis: 'The named module is where the behaviour this task describes is implemented.',
  };
}

/** A task carrying all seven fields F08-AC1 names. */
function planTask(taskId: string, covers: readonly string[], dependsOn: readonly string[] = []): Record<string, unknown> {
  return {
    taskId,
    coversOutcomeIds: [...covers],
    outcome: `Deliver ${taskId}.`,
    scope: `The change ${taskId} makes.`,
    acceptanceCriteria: [`${taskId} is observed through the surface it changes.`],
    verificationMethod: 'Run the controller suite and read the affected surface.',
    dependencies: [...dependsOn],
    relevantProjectContext: ['The project profile names the repository and target branch.'],
    implementationLocation: location(taskId),
  };
}

interface ProposalOverrides {
  readonly tasks?: readonly Record<string, unknown>[];
  readonly exclusions?: readonly Record<string, unknown>[];
  readonly requestedOutcomes?: readonly Record<string, unknown>[];
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly omitTasks?: boolean;
}

/**
 * The plan proposal text a plan-mode engine returns.
 *
 * Serialised into one JSONL milestone line by `engineLines`, because that is the only
 * shape a `FakeEngineAdapter` reads structured output from — the same position a real
 * engine's own message occupies in its stream (N05-AC2).
 */
function proposalText(overrides: ProposalOverrides = {}): string {
  const proposal: Record<string, unknown> = {
    kind: 'PlanProposal',
    // `briefId`, `draftedAt` and `basedOnRevision` are deliberately absent: the controller
    // stamps all three from the brief under test and the injected clock (F08-AC1).
    basedOnRevision: null,
    requestedOutcomes:
      overrides.requestedOutcomes ??
      OUTCOME_IDS.map((id) => ({ id, statement: statementOf(id) })),
    ...(overrides.omitTasks === true ? {} : { tasks: overrides.tasks ?? defaultTasks() }),
    exclusions: overrides.exclusions ?? [],
    ...(overrides.extra ?? {}),
  };
  return JSON.stringify(proposal);
}

function statementOf(id: string): string {
  if (id === 'brief.desiredOutcome') return DESIRED_OUTCOME;
  if (id === 'AC-1') return CRITERION_ONE;
  return CRITERION_TWO;
}

/** Two tasks covering all three requested outcomes, the second depending on the first. */
function defaultTasks(): readonly Record<string, unknown>[] {
  return [
    planTask('task_readiness_panel', ['brief.desiredOutcome', 'AC-1']),
    planTask('task_publish_gate', ['AC-2'], ['task_readiness_panel']),
  ];
}

function declaration(kind: CapabilityKind): CapabilityDeclaration {
  return { kind, supported: true, limitation: null, privileged: false, supportsPrecondition: false };
}

const ENGINE_DECLARATIONS: readonly CapabilityDeclaration[] = [
  declaration('Engine:VersionCheck'),
  declaration('Engine:StartScoped'),
  declaration('Engine:StopGraceful'),
];

/** The JSONL a plan-mode session answers with: one message, then a successful turn. */
function engineLines(text: string, sessionId: string): readonly string[] {
  return [
    JSON.stringify({ type: 'session.started', session_id: sessionId }),
    JSON.stringify({ type: 'milestone', stage: 'SummingUp', message: text }),
    JSON.stringify({ type: 'completion', status: 'success' }),
  ];
}

function fakeEngine(text: string, sessionId = 'sess_plan_generation'): FakeEngineAdapter {
  return new FakeEngineAdapter(
    {
      connectorId: CONNECTOR_ID,
      provider: 'codex',
      kind: 'Engine',
      runtimeVersion: 'fixture-engine/1.0.0',
      declarations: ENGINE_DECLARATIONS,
      ledger: new SideEffectLedger(),
      conditions: new FakeConditions(),
    },
    engineLines(text, sessionId),
  );
}

/** Records what generation asked the engine for, so a case can assert the read-only grant. */
function recordingEngine(inner: PlanEngine): PlanEngine & { readonly requests: readonly unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    async propose(context: AdapterContext, request) {
      requests.push(request);
      return inner.propose(context, request);
    },
  };
}

function workspace(directory: string): ExecutionWorkspace {
  return {
    workspaceId: 'ws_plan_generation',
    absolutePath: directory,
    headSha: 'a'.repeat(40) as CommitSha,
    baseSha: 'a'.repeat(40) as CommitSha,
    environmentFingerprint: fingerprint({ environment: 'fixture' }),
    scopeFingerprint: fingerprint({ scope: 'plan-generation' }),
    isolatedPorts: {},
    serviceEndpoints: [],
    testAccess: { kind: 'None' },
  };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                      */
/* -------------------------------------------------------------------------- */

interface GenerationInput {
  readonly engine: PlanEngine;
  readonly brief: Brief;
  readonly change: ChangeShape;
  readonly packet?: PlanContextPacket;
  readonly planId?: string;
  readonly actor?: OwnerActor;
  readonly basedOnRevision?: number | null;
}

type GenerationResult = Awaited<
  ReturnType<ReturnType<typeof createPlanGenerationUseCases>['generateAndStorePlanProposal']>
>;

interface Harness {
  readonly root: CompositionRoot;
  readonly directory: string;
  readonly clock: ControllerClock;
  readonly ideaId: IdeaId;
  readonly projectId: ProjectId;
  /** The agreed brief drafted at setup, read back from the store. */
  readonly brief: Brief;
  /** Agreed brief at its current version, read back from the store. */
  currentBrief(): Brief;
  packetFor(brief: Brief, subjectKeys?: readonly string[], unrelated?: readonly string[]): PlanContextPacket;
  /** Generate, validate and store one plan proposal through the real use case. */
  generate(input: GenerationInput): Promise<GenerationResult>;
  /** A second root on the same file, standing in for a restarted process (F05-AC4). */
  restart(): CompositionRoot;
  /** The rows of one production table, counted through the real connection. */
  countRows(table: string): number;
  close(): void;
}

/**
 * A real composition root, a real captured idea and a real agreed brief.
 *
 * The brief is drafted and agreed through `IntakeRepository`, so the plan under test names
 * a brief that exists as a row with an agreement recorded against it rather than a value
 * assembled for the case (F07-AC1).
 */
async function withHarness(body: (harness: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-plan-generation-'));
  const clock = steppingClock();
  const opened = createCompositionRoot({
    databasePath: join(directory, 'shiploop.sqlite'),
    clock,
    adapters,
    passwordParameters: FAST_PASSWORD_COST,
    sessionIdleTimeoutSeconds: SESSION_IDLE_SECONDS,
  });
  assert.ok(opened.ok, `the real root must open: ${opened.ok ? '' : opened.error.reason}`);
  const root = opened.value;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    root.close();
  };

  try {
    const projectId = '3f5a1c2e-0000-4000-8000-00000000p1an' as ProjectId;
    // No project on the request: a `projects` row exists only once something is recorded
    // against it, and the case that needs one records a procedure, which creates it.
    const captured = root.ideas.capture({
      projectId: null,
      kind: 'FeatureRequest',
      rawRequest: 'Tell me why a build may not start, and never publish work I did not accept.',
      notes: null,
      bugExpected: null,
      bugActual: null,
      bugReproduction: null,
      capturedAt: NOW,
    });
    assert.ok(captured.ok, `the idea must be captured: ${captured.ok ? '' : captured.error.reason}`);
    const ideaId = captured.value.ideaId;

    // `captureIdea` records the raw request as the first conversation turn, and a
    // correction binds to it (F06-AC1, F07-AC3), so the harness records it too.
    const rawTurn = root.intake.recordTurn(ideaId, {
      kind: 'RawRequest',
      at: NOW,
      text: 'Tell me why a build may not start, and never publish work I did not accept.',
    });
    assert.ok(rawTurn.ok, `the raw request turn must be recorded: ${rawTurn.ok ? '' : rawTurn.error.reason}`);

    const drafted = root.intakeUseCases.draftBrief(
      { ideaId, authoredBy: 'ClarificationModel', sections: INITIAL_SECTIONS, basedOnBriefVersion: null },
      OWNER,
    );
    assert.ok(
      drafted.ok,
      `the brief must be drafted: ${drafted.ok ? '' : `${drafted.error.reason} :: ${fieldsOf(drafted.error).map((entry) => `${entry.path}=${entry.message}`).join(' | ')}`}`,
    );
    const agreed = root.intakeUseCases.agreeBrief(ideaId, OWNER);
    assert.ok(agreed.ok, `the brief must be agreed: ${agreed.ok ? '' : agreed.error.reason}`);

    const currentBrief = (): Brief => {
      const listed = root.intake.listBriefs(ideaId);
      assert.ok(listed.ok, 'the stored brief must be readable');
      const latest = listed.value[listed.value.length - 1];
      assert.ok(latest !== undefined, 'the agreed brief must exist');
      return latest;
    };

    const briefAt = (version: number): Brief => {
      const listed = root.intake.listBriefs(ideaId);
      assert.ok(listed.ok, 'the stored brief must be readable');
      const found = listed.value.find((candidate) => candidate.version === version);
      assert.ok(found !== undefined, `brief version ${String(version)} must exist`);
      return found;
    };

    const contextReader = createPlanContextReader({ clock, procedures: root.procedures, profiles: root.profiles });
    const packetFor = (
      brief: Brief,
      subjectKeys: readonly string[] = [],
      unrelated: readonly string[] = [],
    ): PlanContextPacket => {
      const request: PlanContextRequest = {
        packetId: `packet_${brief.briefId}_v${String(brief.version)}`,
        briefId: brief.briefId,
        projectId,
        subjectKeys,
        unrelatedSubjectKeys: unrelated,
        ticketSnapshot: ['SHIP-1 Ready: the readiness panel is agreed.'],
        priorFeedback: ['Reviewer feedback: state the reason for every open area.'],
      };
      const packet = contextReader.read(request);
      assert.ok(packet.ok, `the context packet must be readable: ${packet.ok ? '' : packet.error.reason}`);
      return packet.value;
    };

    const generate = async (input: GenerationInput): Promise<GenerationResult> => {
      const useCases = createPlanGenerationUseCases({
        clock,
        planning: root.planningUseCases,
        engine: input.engine,
      });
      return useCases.generateAndStorePlanProposal({
        brief: input.brief,
        contextPacket: input.packet ?? packetFor(input.brief),
        ideaId,
        change: input.change,
        workspace: workspace(directory),
        actor: input.actor ?? OWNER,
        ...(input.planId === undefined ? {} : { planId: input.planId }),
        ...(input.basedOnRevision === undefined ? {} : { basedOnRevision: input.basedOnRevision }),
      });
    };

    await body({
      root,
      directory,
      clock,
      ideaId,
      projectId,
      brief: briefAt(agreed.value.version),
      currentBrief,
      packetFor,
      generate,
      restart: (): CompositionRoot => {
        const second = createCompositionRoot({
          databasePath: join(directory, 'shiploop.sqlite'),
          clock,
          adapters,
          passwordParameters: FAST_PASSWORD_COST,
          sessionIdleTimeoutSeconds: SESSION_IDLE_SECONDS,
        });
        assert.ok(second.ok, `a second root must open the same file: ${second.ok ? '' : second.error.reason}`);
        return second.value;
      },
      countRows: (table: string): number => {
        const row = root.database.prepare(`SELECT count(*) AS total FROM ${table}`).get();
        assert.ok(row !== undefined, `counting ${table} must return a row`);
        const total = row['total'];
        return typeof total === 'number' ? total : Number(total);
      },
      close,
    });
  } finally {
    close();
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A synthetic credential shape, present only so redaction has something to remove.
 *
 * It encodes nothing and authenticates nothing: the point of the cases that use it is that
 * a credential-shaped string coming out of an engine or a suggestion never reaches a stored
 * row or a refusal (N02-AC2).
 */
const SEEDED_CREDENTIAL = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzaGlwbG9vcCJ9.eyJzaWduYXR1cmUiOiJzeW50aGV0aWMifQ';

function fieldsOf(error: DomainError): readonly { readonly path: string; readonly message: string }[] {
  return error.code === 'Invalid' ? (error as InvalidError).fields : [];
}

/* -------------------------------------------------------------------------- */
/* F08-AC1: every field, and the location as a proposal                        */
/* -------------------------------------------------------------------------- */

test('every proposed task carries every F08-AC1 field and its location is a proposal (F08-AC1, F08-AC5)', async () => {
  await withHarness(async (harness) => {
    const brief = harness.brief;
    const generated = await harness.generate({ engine: planEngineFromAdapter(fakeEngine(proposalText())), brief, change: TWO_SURFACE_CHANGE });
    assert.ok(generated.ok, `generation must succeed: ${generated.ok ? '' : `${generated.error.reason} :: ${fieldsOf(generated.error).map((entry) => `${entry.path}=${entry.message}`).join(' | ')}`}`);
    const stored = generated.value;

    assert.equal(stored.plan.briefId, brief.briefId, 'the plan names the agreed brief it was generated from');
    assert.equal(stored.plan.revision, 1);
    assert.deepEqual(
      stored.requestedOutcomes.map((outcome) => outcome.id),
      [...OUTCOME_IDS],
      'the requested outcomes come from the agreed brief, not from the engine',
    );

    assert.equal(stored.plan.tasks.length, 2);
    for (const task of stored.plan.tasks) {
      assert.notEqual(task.outcome.trim(), '');
      assert.notEqual(task.scope.trim(), '');
      assert.ok(task.acceptanceCriteria.length > 0, `${task.taskId} must state acceptance criteria`);
      assert.notEqual(task.verificationMethod.trim(), '');
      assert.ok(Array.isArray(task.dependencies));
      assert.ok(task.relevantProjectContext.length > 0, `${task.taskId} must state the project context it relies on`);
      assert.equal(task.implementationLocation.kind, 'ProposedLocation', 'F08-AC5: a location is a proposal');
      assert.ok(task.implementationLocation.candidates.length > 0);
      assert.notEqual(task.implementationLocation.basis.trim(), '');
    }

    // F08-AC5: the stored coverage accounts for every requested outcome by name.
    assert.deepEqual(
      stored.coverage.map((entry) => entry.outcomeId).sort(),
      [...OUTCOME_IDS].sort(),
    );

    // The plan's identity is the brief under test, not whatever the engine called it: a
    // proposal written for another brief is refused rather than quietly restamped (F08-AC1).
    const elsewhere = await harness.generate({
      engine: planEngineFromAdapter(fakeEngine(proposalText({ extra: { briefId: 'brief_somewhere_else' } }))),
      brief: harness.brief,
      change: ONE_FILE_CHANGE,
    });
    assert.equal(elsewhere.ok, false, 'a proposal for another brief must be refused (F08-AC1)');
    if (!elsewhere.ok) assert.equal(elsewhere.error.code, 'Conflict');
    assert.equal(harness.countRows('plans'), 1, 'the refused proposal stored nothing');
  });
});

/* -------------------------------------------------------------------------- */
/* F08-AC2: a small change stays one task; a real split is justified           */
/* -------------------------------------------------------------------------- */

test('a one-file fix stays one task and is not decomposed into three tickets (F08-AC2)', async () => {
  await withHarness(async (harness) => {
    const brief = harness.brief;
    const singleTaskProposal = proposalText({
      tasks: [planTask('task_reason_copy', [...OUTCOME_IDS])],
      requestedOutcomes: OUTCOME_IDS.map((id) => ({ id, statement: statementOf(id) })),
    });

    const kept = await harness.generate({ engine: planEngineFromAdapter(fakeEngine(singleTaskProposal)), brief, change: ONE_FILE_CHANGE });
    assert.ok(kept.ok, `one task for one surface must be accepted: ${kept.ok ? '' : kept.error.reason}`);
    assert.equal(kept.value.plan.tasks.length, 1, 'the change stays one task (F08-AC2)');
    assert.equal(kept.value.split.split, false);
    assert.match(kept.value.split.reason, /stays one task/);
    assert.match(kept.value.split.reason, /F08-AC2/);

    // The other half of the rule: a one-surface change asked for several tasks is refused
    // with the reason, rather than accepted because the engine asked for it (F08-AC2).
    const overSplit = await harness.generate({ engine: planEngineFromAdapter(fakeEngine(proposalText())), brief, change: ONE_FILE_CHANGE });
    assert.equal(overSplit.ok, false, 'decomposing one reviewable unit must be refused (F08-AC2)');
    if (!overSplit.ok) {
      assert.equal(overSplit.error.code, 'Invalid');
      assert.match(overSplit.error.reason, /F08-AC2/);
      assert.match(fieldsOf(overSplit.error)[0]?.message ?? '', /asks for 2 tasks/);
    }
  });
});

test('a two-surface change splits into two tasks and states why (F08-AC2, F08-AC4)', async () => {
  await withHarness(async (harness) => {
    const generated = await harness.generate({
      engine: planEngineFromAdapter(fakeEngine(proposalText())),
      brief: harness.brief,
      change: TWO_SURFACE_CHANGE,
    });
    assert.ok(generated.ok, `a justified split must be accepted: ${generated.ok ? '' : generated.error.reason}`);

    assert.equal(generated.value.split.split, true);
    assert.deepEqual(generated.value.split.justifications, ['IndependentlyReviewable', 'RealDependency']);
    assert.match(generated.value.split.reason, /splits into 2 proposed task/);
    assert.equal(generated.value.split.order.length, 2);
    assert.equal(generated.value.split.order[0], 'readiness_panel', 'the prerequisite surface is proposed first (F08-AC4)');

    // The stored plan carries the same reason, so it is inspectable rather than inferred.
    assert.equal(generated.value.plan.split.split, true);
    assert.match(generated.value.plan.split.reason, /F08-AC2/);
  });
});

/* -------------------------------------------------------------------------- */
/* F08-AC5: coverage refused by name                                          */
/* -------------------------------------------------------------------------- */

test('a requested outcome covered by neither a task nor an exclusion is refused by name (F08-AC5)', async () => {
  await withHarness(async (harness) => {
    // The proposal delivers the desired outcome and AC-1, and says nothing about AC-2.
    const partial = proposalText({ tasks: [planTask('task_readiness_panel', ['brief.desiredOutcome', 'AC-1'])] });

    const refused = await harness.generate({ engine: planEngineFromAdapter(fakeEngine(partial)), brief: harness.brief, change: ONE_FILE_CHANGE });
    assert.equal(refused.ok, false, 'an uncovered outcome must be refused (F08-AC5)');
    if (!refused.ok) {
      assert.equal(refused.error.code, 'Invalid');
      assert.match(refused.error.reason, /F08-AC5/);
      const named = fieldsOf(refused.error).map((field) => `${field.path} ${field.message}`);
      assert.ok(
        named.some((text) => text.includes('AC-2') && text.includes(CRITERION_TWO)),
        `the refusal must name the uncovered outcome: ${named.join(' | ')}`,
      );
    }
    assert.equal(harness.countRows('plans'), 0, 'a refused proposal stores no plan');

    // The same outcomes are accepted once the plan declares an explicit exclusion for the
    // one it does not deliver, which is what "a task or an explicit exclusion" means.
    const excluded = proposalText({
      tasks: [planTask('task_readiness_panel', ['brief.desiredOutcome', 'AC-1'])],
      exclusions: [
        {
          outcomeId: 'AC-2',
          excluded: 'The publish control is not changed by this plan.',
          reason: 'The owner scoped this outcome to the readiness panel only.',
        },
      ],
    });
    const accepted = await harness.generate({ engine: planEngineFromAdapter(fakeEngine(excluded)), brief: harness.brief, change: ONE_FILE_CHANGE });
    assert.ok(accepted.ok, `an explicit exclusion covers the outcome: ${accepted.ok ? '' : accepted.error.reason}`);
    const exclusion = accepted.value.coverage.find((entry) => entry.outcomeId === 'AC-2');
    assert.ok(exclusion !== undefined && exclusion.via === 'Exclusion', 'the exclusion is recorded as the reason it exists (F08-AC5)');
  });
});

/* -------------------------------------------------------------------------- */
/* F05-AC5: invalid structured output, refused, and recoverable                */
/* -------------------------------------------------------------------------- */

test('invalid structured output is refused per field and a corrected resubmission succeeds (F05-AC5)', async () => {
  await withHarness(async (harness) => {
    const brief = harness.brief;
    const broken = proposalText({ tasks: [{ ...defaultTasks()[0], acceptanceCriteria: 'not a list' }] });

    const refused = await harness.generate({ engine: planEngineFromAdapter(fakeEngine(broken)), brief, change: ONE_FILE_CHANGE });
    assert.equal(refused.ok, false, 'a task whose acceptance criteria are not a list must be refused (F05-AC5)');
    if (!refused.ok) {
      assert.equal(refused.error.code, 'Invalid');
      const paths = fieldsOf(refused.error).map((field) => field.path);
      assert.ok(paths.includes('tasks[0].acceptanceCriteria'), `the failing field must be named: ${paths.join(', ')}`);
      assert.ok(
        fieldsOf(refused.error).some((field) => field.message.includes('list of statements')),
        'the message must say what the field has to be, so the caller can correct it',
      );
    }
    assert.equal(harness.countRows('plans'), 0, 'nothing invalid enters the plan store (F05-AC5)');

    // Recoverable: the same request with the field corrected is accepted, which is what
    // makes the refusal a per-field error rather than a dead end.
    const corrected = await harness.generate({
      engine: planEngineFromAdapter(fakeEngine(proposalText({ tasks: [planTask('task_readiness_panel', [...OUTCOME_IDS])] }))),
      brief,
      change: ONE_FILE_CHANGE,
    });
    assert.ok(corrected.ok, `a corrected proposal must be accepted: ${corrected.ok ? '' : corrected.error.reason}`);
    assert.equal(harness.countRows('plans'), 1);
  });
});

test('a proposal carrying an acceptance, delivery or release field is refused rather than dropped (F05-AC5, F08-AC3)', async () => {
  await withHarness(async (harness) => {
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ['release', { release: 'v1.2.3' }],
      ['delivery', { delivery: 'delivered to production on Friday' }],
      ['acceptedAt', { acceptedAt: NOW }],
    ];

    for (const [field, extra] of cases) {
      const attempt = await harness.generate({
        engine: planEngineFromAdapter(fakeEngine(proposalText({ extra }))),
        brief: harness.brief,
        change: ONE_FILE_CHANGE,
      });
      assert.equal(attempt.ok, false, `"${field}" is an owner decision and must be refused (F05-AC5)`);
      if (!attempt.ok) {
        assert.equal(attempt.error.code, 'Invalid');
        const named = fieldsOf(attempt.error);
        assert.ok(
          named.some((entry) => entry.path === field && entry.message.includes('F05-AC5')),
          `"${field}" must be refused by name: ${named.map((entry) => entry.path).join(', ')}`,
        );
      }
    }

    // Refused, not stripped: a plan that quietly dropped the field would be indistinguishable
    // from one the engine never wrote (F05-AC5).
    assert.equal(harness.countRows('plans'), 0);
    assert.equal(harness.countRows('work_items'), 0);
    assert.equal(harness.countRows('external_operations'), 0);
  });
});

/* -------------------------------------------------------------------------- */
/* F08-AC3: nothing generated is publishable, and generation has no side effects */
/* -------------------------------------------------------------------------- */

test('an unaccepted generated task has no publishable form (F08-AC3)', async () => {
  await withHarness(async (harness) => {
    const generated = await harness.generate({
      engine: planEngineFromAdapter(fakeEngine(proposalText())),
      brief: harness.brief,
      change: TWO_SURFACE_CHANGE,
    });
    assert.ok(generated.ok, `generation must succeed: ${generated.ok ? '' : `${generated.error.reason} :: ${fieldsOf(generated.error).map((entry) => `${entry.path}=${entry.message}`).join(' | ')}`}`);
    const planId = generated.value.planId;

    for (const task of generated.value.plan.tasks) {
      assert.equal(task.acceptance.state, 'Proposed', 'generation records no owner acceptance (F08-AC3)');
    }

    // The one question that matters: what would publication be handed? `publishableTickets`
    // is the domain's own projection, and it is empty.
    const publishable = harness.root.planningUseCases.publishableFor(planId);
    assert.ok(publishable.ok);
    assert.deepEqual(publishable.value, [], 'an unaccepted proposal has no publishable representation (F08-AC3)');

    // Accepting one task through the existing owner edit is what publishes it, and that
    // edit is not something generation did.
    const accepted = harness.root.planningUseCases.editPlan({
      planId,
      edit: { kind: 'Accept', taskId: 'task_readiness_panel', expectedRevision: generated.value.plan.revision, by: OWNER.actorId, at: LATER },
    });
    assert.ok(accepted.ok, `an owner acceptance must succeed: ${accepted.ok ? '' : accepted.error.reason}`);
    const afterAcceptance = harness.root.planningUseCases.publishableFor(planId);
    assert.ok(afterAcceptance.ok);
    assert.deepEqual(
      afterAcceptance.value.map((ticket) => ticket.taskId),
      ['task_readiness_panel'],
      'only the accepted task becomes publishable (F08-AC3)',
    );
  });
});

test('generation writes one plan row and touches no delivery, publication or work-item state (F08-AC1, F03-AC5)', async () => {
  await withHarness(async (harness) => {
    const engine = recordingEngine(planEngineFromAdapter(fakeEngine(proposalText())));
    const generated = await harness.generate({ engine, brief: harness.brief, change: TWO_SURFACE_CHANGE });
    assert.ok(generated.ok, `generation must succeed: ${generated.ok ? '' : `${generated.error.reason} :: ${fieldsOf(generated.error).map((entry) => `${entry.path}=${entry.message}`).join(' | ')}`}`);

    // The request the engine received: read-only, with no grant to act on anything.
    const request = engine.requests[0] as { readonly mode: string; readonly grantedCapabilities: readonly string[]; readonly instruction: string };
    assert.equal(request.mode, PLAN_ENGINE_MODE);
    assert.deepEqual(request.grantedCapabilities, [...PLAN_ENGINE_CAPABILITIES], 'a plan session holds no capability (F03-AC5)');
    assert.match(request.instruction, /Read only: do not change the repository/);
    assert.match(request.instruction, /no field for acceptance, delivery or release/);

    // The rows. Every table a publication, an adoption or a delivery would write is empty,
    // and the only row written is the plan (F08-AC3).
    assert.equal(harness.countRows('plans'), 1);
    for (const table of ['work_items', 'external_operations', 'deliveries', 'release_receipts', 'jobs', 'candidates']) {
      assert.equal(harness.countRows(table), 0, `generation must leave ${table} empty`);
    }
  });
});

test('a non-owner may not generate a plan, and the engine is never started for one (F01-AC1)', async () => {
  await withHarness(async (harness) => {
    const engine = recordingEngine(planEngineFromAdapter(fakeEngine(proposalText())));
    const refused = await harness.generate({ engine, brief: harness.brief, change: TWO_SURFACE_CHANGE, actor: NON_OWNER });
    assert.equal(refused.ok, false, 'only the owner may generate a plan (F01-AC1)');
    if (!refused.ok) assert.equal(refused.error.code, 'Forbidden');
    assert.equal(engine.requests.length, 0, 'the refusal happens before any engine session (F01-AC1)');
    assert.equal(harness.countRows('plans'), 0);
  });
});

/* -------------------------------------------------------------------------- */
/* F07-AC3: re-runnable after a correction, prior proposal still readable      */
/* -------------------------------------------------------------------------- */

test('regeneration after a correction leaves the prior proposal readable and publishes nothing unaccepted (F07-AC3, F08-AC3)', async () => {
  await withHarness(async (harness) => {
    const first = await harness.generate({ engine: planEngineFromAdapter(fakeEngine(proposalText())), brief: harness.brief, change: TWO_SURFACE_CHANGE });
    assert.ok(first.ok, `the first generation must succeed: ${first.ok ? '' : `${first.error.reason} :: ${fieldsOf(first.error).map((entry) => `${entry.path}=${entry.message}`).join(' | ')}`}`);
    const firstPlanId = first.value.planId;
    assert.equal(firstPlanId, planIdForGeneration(first.value.proposal.briefId, 1));
    const firstTasks = first.value.plan.tasks.map((task) => task.taskId);
    const firstDigest = first.value.plan.digest;

    // The owner corrects the brief and agrees the correction: a second brief version.
    const correctedSections: BriefSectionsInput = {
      ...INITIAL_SECTIONS,
      desiredOutcome: `${DESIRED_OUTCOME} And say which surface each open area belongs to.`,
      acceptanceCriteria: [
        ...INITIAL_SECTIONS.acceptanceCriteria,
        { id: 'AC-3', text: CRITERION_THREE, verification: 'Read the assessment.' },
      ],
    };
    const correction = harness.root.intakeUseCases.applyOwnerCorrection(
      { ideaId: harness.ideaId, text: 'Name the surface for each open area.', sections: correctedSections, basedOnBriefVersion: 1 },
      OWNER,
    );
    assert.ok(correction.ok, `the correction must be recorded: ${correction.ok ? '' : correction.error.reason}`);
    const agreed = harness.root.intakeUseCases.agreeBrief(harness.ideaId, OWNER);
    assert.ok(agreed.ok, 'the corrected brief must be agreed before it is planned');
    assert.equal(agreed.value.version, 2);

    // A proposal for the corrected brief, covering the new criterion too.
    const secondProposal = JSON.stringify({
      kind: 'PlanProposal',
      basedOnRevision: 1,
      requestedOutcomes: [
        { id: 'brief.desiredOutcome', statement: correctedSections.desiredOutcome },
        { id: 'AC-1', statement: CRITERION_ONE },
        { id: 'AC-2', statement: CRITERION_TWO },
        { id: 'AC-3', statement: CRITERION_THREE },
      ],
      tasks: [
        planTask('task_readiness_panel', ['brief.desiredOutcome', 'AC-1', 'AC-3']),
        planTask('task_publish_gate', ['AC-2'], ['task_readiness_panel']),
      ],
      exclusions: [],
    });
    const correctedBrief = harness.currentBrief();
    const second = await harness.generate({ engine: planEngineFromAdapter(fakeEngine(secondProposal)), brief: correctedBrief, change: TWO_SURFACE_CHANGE });
    assert.ok(second.ok, `regeneration must succeed: ${second.ok ? '' : second.error.reason}`);
    assert.equal(second.value.planId, planIdForGeneration(correctedBrief.briefId, 2), 'a correction produces a new plan identity (F07-AC3)');
    assert.notEqual(second.value.planId, firstPlanId);

    // Both proposals are readable, and the earlier one is unchanged rather than replaced.
    const listed = harness.root.planningUseCases.listPlansForIdea(harness.ideaId);
    assert.ok(listed.ok, `both plans must be readable: ${listed.ok ? '' : listed.error.reason}`);
    assert.equal(listed.value.length, 2, 'the prior proposal is still stored (F07-AC3)');
    const rereadFirst = harness.root.planningUseCases.getPlan(firstPlanId);
    assert.ok(rereadFirst.ok);
    assert.deepEqual(rereadFirst.value.tasks.map((task) => task.taskId), firstTasks, 'the prior proposal is byte-for-byte the same plan');
    assert.equal(rereadFirst.value.digest, firstDigest);

    // Neither plan publishes anything: acceptance is still the owner's to give (F08-AC3).
    for (const planId of [firstPlanId, second.value.planId]) {
      const publishable = harness.root.planningUseCases.publishableFor(planId);
      assert.ok(publishable.ok);
      assert.deepEqual(publishable.value, [], `plan ${planId} publishes nothing unaccepted (F08-AC3)`);
    }
    assert.equal(harness.countRows('work_items'), 0, 'regeneration creates no external work (F08-AC3)');
  });
});

/* -------------------------------------------------------------------------- */
/* F05-AC2 and F05-AC4: the context packet                                     */
/* -------------------------------------------------------------------------- */

test('the context packet carries the accepted procedure, hides a proposed one and names what it excluded (F05-AC2, F05-AC4)', async () => {
  await withHarness(async (harness) => {
    const subject = 'run.checklist';
    const accepted = harness.root.procedures.appendVersion({
      projectId: harness.projectId,
      subjectKey: subject,
      kind: 'Procedure',
      scope: 'Verification',
      source: 'Owner',
      sourceRevision: null,
      content: 'Run the controller suite before proposing a plan.',
      status: 'Accepted',
      createdAt: NOW,
      createdBy: OWNER.actorId,
      note: null,
      expectedVersionNumber: null,
    });
    assert.ok(accepted.ok, `an accepted procedure must be stored: ${accepted.ok ? '' : accepted.error.reason}`);

    const proposed = harness.root.procedures.appendVersion({
      projectId: harness.projectId,
      subjectKey: subject,
      kind: 'Procedure',
      scope: 'Verification',
      source: 'Owner',
      sourceRevision: null,
      content: 'The model suggests running only the browser suite.',
      status: 'Proposed',
      createdAt: NOW,
      createdBy: OWNER.actorId,
      note: 'A suggestion nobody has saved.',
      expectedVersionNumber: null,
    });
    assert.ok(proposed.ok, `a proposed procedure must be stored: ${proposed.ok ? '' : proposed.error.reason}`);

    const brief = harness.brief;
    const packet = harness.packetFor(brief, [subject], ['run.deploy']);
    assert.deepEqual(
      packet.procedures.map((procedure) => procedure.procedureVersionId),
      [accepted.value.procedureVersionId],
      'F05-AC4: a proposed version is not what a run reads, so it is not in the packet',
    );
    assert.equal(packet.procedures[0]?.versionNumber, 1);
    assert.equal(packet.procedures[0]?.status, 'Accepted');
    assert.ok(
      !JSON.stringify(packet).includes('browser suite'),
      'the suggested content must not reach the engine in any form (F05-AC4)',
    );
    assert.deepEqual(packet.excluded, ['run.deploy'], 'F05-AC2: unrelated context is named, not silently dropped');
    assert.ok(packet.ticketSnapshot.length > 0);
    assert.ok(packet.repositoryGuidance.length > 0);
    assert.ok(packet.priorFeedback.length > 0);
    assert.match(packet.fingerprint, /^fp_/, 'the packet is fingerprinted so a stored plan names the context it read');

    // A subject with no accepted version is refused rather than described as known.
    const reader = createPlanContextReader({ clock: harness.clock, procedures: harness.root.procedures, profiles: harness.root.profiles });
    const unknown = reader.read({
      packetId: 'packet_unknown',
      briefId: brief.briefId,
      projectId: harness.projectId,
      subjectKeys: ['run.nonexistent'],
      unrelatedSubjectKeys: [],
      ticketSnapshot: [],
      priorFeedback: [],
    });
    assert.equal(unknown.ok, false, 'a subject a run would read nothing about must be refused (F05-AC2)');
    if (!unknown.ok) assert.equal(unknown.error.code, 'NotFound');
  });
});

/* -------------------------------------------------------------------------- */
/* The engine text boundary                                                     */
/* -------------------------------------------------------------------------- */

test('engine text is redacted before it is decoded, and a proposal wrapped in prose is still found (N02-AC2, F05-AC5)', () => {
  const withSecret = `Here is the plan. ${JSON.stringify({ kind: 'PlanProposal', note: `token ${SEEDED_CREDENTIAL}` })} Done.`;
  const decoded = decodePlanProposal(withSecret);
  assert.ok(decoded.ok, `prose around the object must not defeat the boundary: ${decoded.ok ? '' : decoded.error.reason}`);
  assert.ok(
    !JSON.stringify(decoded.value).includes(SEEDED_CREDENTIAL),
    'a credential echoed by the engine must not survive into anything downstream (N02-AC2)',
  );
  assert.match(JSON.stringify(decoded.value), /redacted:jwt/, 'the credential was replaced by the redaction placeholder (N02-AC2)');

  const none = decodePlanProposal('I am afraid I cannot help with that.');
  assert.equal(none.ok, false, 'text with no object is a recoverable refusal (F05-AC5)');
  if (!none.ok) {
    assert.equal(none.error.code, 'Invalid');
    assert.equal(fieldsOf(none.error)[0]?.path, 'engineText');
  }

  const broken = decodePlanProposal('{ "kind": "PlanProposal", "tasks": }');
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.match(broken.error.reason, /not readable JSON/);
});

test('the answer is read from unattached progress text and from the terminal summary, and nowhere else (F15-AC2)', () => {
  const text = engineTextOf({
    connectorId: CONNECTOR_ID,
    sessionId: 'sess_plan_generation' as never,
    engineVersion: 'fixture-engine/1.0.0',
    instruction: 'plan it',
    events: [
      { kind: 'Progress', at: NOW, stage: 'ReadingInstructions', milestoneKey: 'codex:command_execution:1', summary: '{"the":"unattached answer"}', detail: null },
      { kind: 'Progress', at: NOW, stage: 'SummingUp', milestoneKey: 'no-code-change', summary: 'The engine changed nothing.', detail: null },
      {
        kind: 'Progress',
        at: NOW,
        stage: 'Implementing',
        milestoneKey: 'codex:agent_message:2',
        summary: '{"the":"artifact attachment"}',
        detail: { artifactId: 'a1', kind: 'Log', uri: 'file:///tmp/run.log', mediaType: 'text/plain', byteLength: 1, producedAt: NOW, sanitized: true },
      },
      { kind: 'Result', at: NOW, outcome: { kind: 'Succeeded', summary: 'the terminal answer' } },
    ],
  });
  assert.deepEqual(
    text.split('\n'),
    ['{"the":"unattached answer"}', 'the terminal answer'],
    'an artifact attachment and a no-code-change report are not the answer, and the terminal one is (F15-AC2)',
  );
});

test('an answer cut off mid-object is refused as incomplete structured output (F05-AC5)', () => {
  // What a shipped adapter produces for a plan longer than the summary cap it applies.
  const truncated = `{"kind":"PlanProposal","requestedOutcomes":[{"id":"brief.desiredOutcome","statement":"${'a'.repeat(500)}`;
  const cut = decodePlanProposal(truncated);
  assert.equal(cut.ok, false, 'half an object is not a plan (F05-AC5)');
  if (!cut.ok) {
    assert.equal(cut.error.code, 'Invalid');
    assert.match(cut.error.reason, /cut off/);
    assert.equal(fieldsOf(cut.error)[0]?.path, 'engineText');
    assert.ok(
      !(fieldsOf(cut.error)[0]?.message ?? '').includes('a'.repeat(500)),
      'the refusal quotes a bounded excerpt, not the whole answer (N02-AC2)',
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Live run, opt-in                                                             */
/* -------------------------------------------------------------------------- */

const LIVE_FLAG = 'SHIPLOOP_LIVE_PLAN_ENGINE';
const LIVE_BINARY_ENV = 'SHIPLOOP_PLAN_ENGINE_BINARY';

/**
 * One live plan-mode session against the configured engine binary.
 *
 * Opt-in through the environment, because it spawns the real engine and spends real
 * budget. It asserts the three things a live run can prove here: the session reached a
 * terminal `Result` from the real binary, it ran with no granted capability, and whatever
 * the engine answered never reached the store unless the domain accepted it. The shipped
 * Codex adapter caps an event summary at 400 characters, so a plan larger than one engine
 * message arrives truncated and is refused as incomplete structured output — which is the
 * F05-AC5 behaviour, not a workaround, and the reason this case asserts either a complete
 * proposal or a named refusal rather than success.
 */
test('a live plan-mode session runs read-only against the configured engine (F08-AC1, F15-AC2, F05-AC5)', {
  skip:
    process.env[LIVE_FLAG] === '1'
      ? false
      : `set ${LIVE_FLAG}=1 and ${LIVE_BINARY_ENV} to an absolute codex path to run this case`,
}, async () => {
  const binary = process.env[LIVE_BINARY_ENV];
  assert.ok(binary !== undefined && binary.length > 0, `${LIVE_BINARY_ENV} must name the engine binary`);
  const adapter = new CodexEngineAdapter({
    connectorId: CONNECTOR_ID,
    client: { binary, skipGitRepoCheck: true },
  });

  await withHarness(async (harness) => {
    const engine = planEngineFromAdapter(adapter);
    const generated = await harness.generate({ engine, brief: harness.brief, change: ONE_FILE_CHANGE });

    if (generated.ok) {
      const terminal = generated.value.run.events.findLast((event) => event.kind === 'Result');
      assert.ok(terminal !== undefined && terminal.kind === 'Result', 'a live run must report a terminal outcome');
      assert.equal(generated.value.plan.tasks.length, 1);
      for (const task of generated.value.plan.tasks) {
        assert.equal(task.implementationLocation.kind, 'ProposedLocation');
        assert.ok(task.acceptanceCriteria.length > 0);
      }
      const publishable = harness.root.planningUseCases.publishableFor(generated.value.planId);
      assert.ok(publishable.ok);
      assert.deepEqual(publishable.value, [], 'a live proposal is still unaccepted (F08-AC3)');
    } else {
      assert.equal(generated.error.code, 'Invalid', `a live refusal must be a recoverable field error: ${generated.error.reason}`);
      assert.ok(fieldsOf(generated.error).length > 0, 'the refusal must name the field to correct (F05-AC5)');
    }
    assert.equal(harness.countRows('work_items'), 0, 'a live plan session creates no external work (F03-AC5)');
  });
});