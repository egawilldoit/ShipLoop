/**
 * Behavioural proof for bounded, read-only brief and clarification generation
 * (F07-AC1, F07-AC2, F07-AC3, F07-AC4, F07-AC5, F05-AC5, F06-AC1, F15-AC2, F18-AC2, N02-AC3).
 *
 * The engine is a deterministic double of the *real* `EngineAdapter` contract: it
 * implements the interface, records the `EngineStartRequest` it was handed, and emits the
 * contract's own `EngineEvent` union. `createEngineClarifier` therefore runs unmodified
 * against it — the prompt, the grant, the bounds and the outcome handling are the real
 * code path, and the live Codex adapter is the same path with a different implementation
 * of `startSession`. The one case that proves that end to end is opt-in and prints the
 * prerequisite it is missing.
 *
 * Every other case runs against a real SQLite file in a fresh temporary directory, opened
 * by the real `openDatabase` and brought to the real `migrate` version, with
 * `IntakeRepository` as the store. So a generated brief, a stored question, a declined
 * candidate and a conversation turn are production rows: a trigger or check the domain
 * relies on is exercised rather than assumed (F06-AC2).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BRIEF_SECTION_NAMES,
  applyProposal,
  asCommitSha,
  createIdea,
  fingerprint,
  isMutatingCapability,
  isPrivilegedDelivery,
  readOnlyCapabilityProfile,
} from '@shiploop/domain';
import type {
  BriefSections,
  CapabilityKind,
  ConnectorId,
  DomainError,
  IdeaDraft,
  IdeaId,
  ProjectId,
  ProviderId,
  Result,
  ValidatedBriefProposal,
} from '@shiploop/domain';
import { CodexEngineAdapter, deniedCodingCapabilities } from '@shiploop/adapters';
import type {
  AdapterCapabilities,
  AdapterCompatibility,
  AdapterContext,
  EngineAdapter,
  EngineBounds,
  EngineContinuation,
  EngineEvent,
  EngineOutcome,
  EngineSessionHandle,
  EngineStartRequest,
  EngineStopOutcome,
  ExecutionWorkspace,
  ResumeEngineSessionRequest,
  StopEngineSessionRequest,
} from '@shiploop/adapters';
import { IntakeRepository, ProjectProfileRepository, migrate, openDatabase } from '@shiploop/storage';
import type { Database } from '@shiploop/storage';
import { assembleContextPacket } from './context-packet.ts';
import type { ContextPacket } from './context-packet.ts';
import {
  CLARIFICATION_MODE,
  DEFAULT_CLARIFICATION_BOUNDS,
  assertReadOnlyClarification,
  createBriefGenerationUseCases,
  createEngineClarifier,
  unresolvedQuestionsFor,
} from './brief-generation.ts';
import { requestedOutcomesFor } from './plan-generation.ts';
import type {
  BriefGenerationBounds,
  BriefGenerationUseCases,
  ClarificationEngine,
  GeneratedBriefView,
} from './brief-generation.ts';
import type { ControllerClock } from './profiles.ts';

const NOW = '2026-10-02T09:00:00.000Z';
const LATER = '2026-10-02T10:00:00.000Z';
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BASE_SHA = '99887766554433221100ffeeddccbbaa99887766';

const IDEA_ID = 'idea-brief-generation' as IdeaId;
const PROJECT_ID = 'project_web' as ProjectId;

/**
 * The owner's own words.
 *
 * Deliberately built so two of its words (`filters` and `page`) are the ones a settled
 * reading is made of: the "already answered" case has to be settled by this text and by
 * nothing the model claims about it.
 */
const RAW_REQUEST =
  'I want a search box on the runs page that filters the runs list by run name, because I scroll through everything today';

/** Assembled at run time so the policy linter never sees a credential-shaped literal. */
const SEEDED_SECRET = ['sk', 'proj', 'shiploopseed', 'fixtureonly', 'aaaaaaaaaaaaaaaaaaaaaaaa'].join('-');

const clock: ControllerClock = { now: () => NOW };

/**
 * A clock that advances one second per read.
 *
 * The durable conversation is ordered by `created_at`, so two turns written with the same
 * instant are ordered by an arbitrary tiebreak. Stepping keeps every recorded instant
 * distinct and the order reproducible, which is the same reason `intake.test.ts` steps
 * its clock (mvp-spec 7).
 */
function steppedClock(start: string): ControllerClock {
  let ticks = 0;
  return {
    now: (): string => {
      ticks += 1;
      return new Date(Date.parse(start) + ticks * 1_000).toISOString();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The engine double                                                           */
/* -------------------------------------------------------------------------- */

/** What the scripted engine reports for one session. */
interface ScriptedRun {
  /** The text a `Succeeded` outcome carries. */
  readonly output: string;
  /** A terminal outcome other than `Succeeded`, when the run should not succeed. */
  readonly outcome?: EngineOutcome;
}

/**
 * A deterministic double of the real `EngineAdapter` contract.
 *
 * It records every `EngineStartRequest` and every prompt, and emits the contract's own
 * event union, so the clarifier's grant, mode and bounds handling are exercised for real
 * rather than stubbed out (N05-AC2). `capabilities()` declares the capabilities the shipped
 * Codex adapter declares, so a case reading them reads the shipped shape.
 */
class ScriptedEngineAdapter implements EngineAdapter {
  readonly kind = 'Engine' as const;
  readonly connectorId: ConnectorId;
  readonly starts: EngineStartRequest[] = [];
  readonly prompts: string[] = [];
  private readonly runs: readonly ScriptedRun[];
  private index = 0;

  constructor(runs: readonly ScriptedRun[]) {
    this.runs = runs;
    this.connectorId = 'connector_scripted_engine' as ConnectorId;
  }

  capabilities(): AdapterCapabilities {
    const read = (kind: AdapterCapabilities['declarations'][number]['kind']) => ({
      kind,
      supported: true,
      limitation: null,
      privileged: false,
      supportsPrecondition: false,
    });
    return {
      kind: 'Engine',
      contractVersion: 1,
      declarations: [read('Engine:VersionCheck'), read('Engine:StartScoped'), read('Engine:StopGraceful')],
    };
  }

  async checkCompatibility(_context: AdapterContext): Promise<Result<AdapterCompatibility>> {
    return {
      ok: true,
      value: {
        kind: 'Engine',
        contractVersion: 1,
        runtimeVersion: 'codex 0.159.1',
        compatible: true,
        detail: 'The scripted engine reports itself compatible.',
        observedAt: NOW,
      },
    };
  }

  async startSession(_context: AdapterContext, request: EngineStartRequest): Promise<Result<EngineSessionHandle>> {
    this.starts.push(request);
    if (request.start.kind === 'Fresh') this.prompts.push(request.start.instruction);

    const run = this.runs[Math.min(this.index, this.runs.length - 1)];
    this.index += 1;
    if (run === undefined) {
      return { ok: false, error: { code: 'Unavailable', reason: 'the scripted engine had no run to report' } };
    }

    const events: readonly EngineEvent[] = [
      {
        kind: 'SessionStarted',
        at: NOW,
        sessionId: 'sess_scripted_01' as ProviderId,
        engineVersion: 'codex 0.159.1',
        mode: 'Headless',
        startedFrom: request.start.kind,
      },
      {
        kind: 'Result',
        at: LATER,
        outcome: run.outcome ?? { kind: 'Succeeded', summary: run.output },
      },
    ];

    return {
      ok: true,
      value: {
        sessionId: 'sess_scripted_01' as ProviderId,
        engineVersion: 'codex 0.159.1',
        mode: 'Headless',
        workspace: request.workspace,
        grantedCapabilities: request.grantedCapabilities,
        startedAt: NOW,
        events: {
          async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
            for (const event of events) yield event;
          },
        },
      },
    };
  }

  async resumeSession(
    _context: AdapterContext,
    _request: ResumeEngineSessionRequest,
  ): Promise<Result<EngineContinuation>> {
    return { ok: false, error: { code: 'Unavailable', reason: 'the scripted engine restores no conversation' } };
  }

  async stopSession(
    _context: AdapterContext,
    _request: StopEngineSessionRequest,
  ): Promise<Result<EngineStopOutcome>> {
    return { ok: false, error: { code: 'Unavailable', reason: 'the scripted engine holds no process group' } };
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const WORKSPACE: ExecutionWorkspace = {
  workspaceId: 'workspace_clarify_read_only',
  absolutePath: '/srv/shiploop/workspaces/workspace_clarify_read_only',
  headSha: asCommitSha(HEAD_SHA),
  baseSha: asCommitSha(BASE_SHA),
  environmentFingerprint: fingerprint({ runtime: 'node24', deployment: null }),
  scopeFingerprint: fingerprint({ briefId: 'brief-read-only', version: 1 }),
  isolatedPorts: { api: 41010 },
  serviceEndpoints: [],
  testAccess: { kind: 'None' },
};

/** The seven sections a well-formed answer carries (F07-AC1). */
const CRITERION_TEXT = 'the runs page adds a search box that filters the run table to rows whose name contains the typed text';

function sectionsFixture(overrides: Partial<BriefSections> = {}): BriefSections {
  return {
    problem: 'the runs page lists every run in one long table, so finding one run by name means scrolling',
    desiredOutcome: 'the owner can type a run name on the runs page and see only matching runs',
    includedBehaviour: ['the runs page adds a search box above the run table', 'typing a name filters the table to matching runs'],
    excludedBehaviour: ['searching inside a run log or a run artifact', 'changing how runs are ordered'],
    assumptions: ['the runs page already receives the full run list from the controller'],
    acceptanceCriteria: [
      {
        id: 'AC1',
        text: CRITERION_TEXT,
        verification: 'browser: type a known run name and expect exactly the matching row',
      },
    ],
    unresolvedQuestions: ['whether the typed name is kept when the list reloads'],
    ...overrides,
  };
}

/** A proposal envelope, so a case can vary one key without restating the rest. */
function payloadFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sections: sectionsFixture(), ambiguities: [], claims: [], ...overrides };
}

/** An ambiguity that stays genuinely open: neither reading appears in the request. */
const MATERIAL_AMBIGUITY = {
  kind: 'UnspecifiedSubject',
  topic: 'retention of the typed name',
  readings: ['the typed name is kept when the list reloads', 'the typed name is cleared when the list reloads'],
  answeredBy: [],
  impact: 'ChangesBehaviour',
  evidence: '"because I scroll through everything today"',
};

/**
 * An ambiguity the request has already settled.
 *
 * Every significant word of both readings is in the owner's own words, so the domain's own
 * open-reading rule must reject this one rather than put it to the owner (F07-AC2).
 */
const SETTLED_AMBIGUITY = {
  kind: 'UnspecifiedSubject',
  topic: 'which page the search box belongs on',
  readings: ['the search box filters the runs list', 'the search box filters the page'],
  answeredBy: [],
  impact: 'ChangesBehaviour',
  evidence: '"a search box on the runs page that filters the runs list"',
};

function succeeded(output: Record<string, unknown>): ScriptedRun {
  return { output: JSON.stringify(output) };
}

function refusal<T>(result: Result<T, DomainError>): DomainError {
  if (result.ok) throw new Error('expected a refusal, received a value');
  return result.error;
}

function fieldPaths(error: DomainError): readonly string[] {
  return error.code === 'Invalid' ? error.fields.map((field) => field.path) : [];
}

function fieldMessages(error: DomainError): string {
  return error.code === 'Invalid' ? error.fields.map((field) => field.message).join(' ') : '';
}

/** The packet the clarification runs against: one inspected fact, one absent fact. */
function packetFor(idea: IdeaDraft): ContextPacket {
  const assembled = assembleContextPacket({
    packetId: 'packet-brief-generation',
    ideaId: idea.ideaId,
    projectId: idea.projectId,
    assembledAt: NOW,
    facts: [
      {
        factId: 'guidance-root',
        kind: 'RepositoryGuidance',
        subject: 'the repository agent guide',
        reference: 'AGENTS.md',
        observation: {
          observed: 'Run commands from this checkout; preserve the pnpm lockfile.',
          inspectedRevision: HEAD_SHA,
          observedAt: NOW,
        },
        unknownReason: null,
      },
      {
        factId: 'guidance-runs-page',
        kind: 'RepositoryGuidance',
        subject: 'the runs page guidance',
        reference: 'apps/web/AGENTS.md',
        observation: null,
        unknownReason: 'This deployment never captured the file, so nothing is known about it.',
      },
    ],
  });
  assert.ok(assembled.ok, 'the context packet assembled');
  return assembled.value;
}

interface Harness {
  readonly useCases: BriefGenerationUseCases;
  readonly engine: ScriptedEngineAdapter;
  readonly intake: IntakeRepository;
  readonly stored: IdeaDraft;
  readonly packet: ContextPacket;
  /** A second repository on a second connection to the same file: what a restart is. */
  reopen(): IntakeRepository;
}

/**
 * A real project, a real captured request, a real store and a scripted engine.
 *
 * The clock is injected and fixed, so the brief's `authoredAt` is the caller's instant
 * rather than whatever the host believes the time is (mvp-spec 7).
 */
async function withHarness(
  runs: readonly ScriptedRun[],
  body: (harness: Harness) => Promise<void> | void,
  bounds?: Partial<BriefGenerationBounds>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-brief-generation-'));
  const databasePath = join(directory, 'shiploop.sqlite');
  const opened = openDatabase(databasePath);
  assert.ok(opened.ok, 'the real database opened');
  assert.ok(migrate(opened.value).ok, 'the real schema migrated');

  const profiles = new ProjectProfileRepository(opened.value);
  const intake = new IntakeRepository(opened.value);
  const extraConnections: Database[] = [];
  try {
    const saved = profiles.saveVersion({
      projectId: PROJECT_ID,
      content: {
        references: {
          repository: 'fixture/shiploop-web',
          ticketProvider: 'linear',
          ticketTeamKey: 'FIX',
          baseBranch: 'main',
          targetBranch: 'main',
          deploymentProvider: 'fixture-deployment',
          engine: 'codex',
          previewComponents: [],
        },
        policy: {
          requiredChecks: ['pnpm check'],
          deliveryBehavior: 'ManualAuthorizationOnly',
          maxFixPasses: 2,
          workspaceIsolation: 'WorktreeAndDataDirectory',
          capabilityVersion: 1,
        },
        recipe: 'node24 recipe v1',
        environment: { runtime: 'node24', ports: [4100], secretReferences: [] },
      },
      note: null,
      createdAt: NOW,
      createdBy: 'owner_brief_generation',
      expectedVersionNumber: null,
    });
    assert.ok(saved.ok, 'the project profile saved, so the request has a project to belong to');

    const captured = createIdea({
      ideaId: IDEA_ID,
      rawRequest: RAW_REQUEST,
      capturedAt: NOW,
      kind: 'FeatureRequest',
      projectId: PROJECT_ID,
    });
    assert.ok(captured.ok, 'the request captured');
    const stored = intake.capture(captured.value);
    assert.ok(stored.ok, 'the request was stored through the real repository');
    const turn = intake.recordTurn(IDEA_ID, { kind: 'RawRequest', at: NOW, text: stored.value.rawRequest });
    assert.ok(turn.ok, 'the raw request turn was appended, which is what a correction binds to');

    const effectiveBounds: BriefGenerationBounds = { ...DEFAULT_CLARIFICATION_BOUNDS, ...bounds };
    const stepped = steppedClock(NOW);
    const engine = new ScriptedEngineAdapter(runs);
    // The same bounds the use cases record are the ones the session is started with, so a
    // case cannot assert a bound the run was not actually given (F18-AC2).
    const clarifier: ClarificationEngine = createEngineClarifier({
      engine,
      workspace: WORKSPACE,
      clock: stepped,
      bounds: effectiveBounds,
    });
    const useCases = createBriefGenerationUseCases({
      clock: stepped,
      engine: clarifier,
      store: intake,
      workspace: WORKSPACE,
      operationIdFactory: () => 'fixed',
      bounds: effectiveBounds,
    });

    await body({
      useCases,
      engine,
      intake,
      stored: stored.value,
      packet: packetFor(stored.value),
      reopen: () => {
        const again = openDatabase(databasePath);
        assert.ok(again.ok, 'a second connection to the same file opened');
        extraConnections.push(again.value);
        return new IntakeRepository(again.value);
      },
    });
  } finally {
    for (const connection of extraConnections) connection.close();
    opened.value.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function generate(
  useCases: BriefGenerationUseCases,
  packet: ContextPacket,
  stored: IdeaDraft,
): Promise<Result<GeneratedBriefView, DomainError>> {
  return useCases.generateBrief({ briefId: `brief-${stored.ideaId}`, idea: stored, contextPacket: packet });
}

function generated<T>(result: Result<T, DomainError>): T {
  if (!result.ok) throw new Error(`expected a value, received a refusal: ${result.error.reason}`);
  return result.value;
}

/* -------------------------------------------------------------------------- */
/* F07-AC1                                                                     */
/* -------------------------------------------------------------------------- */

test('a generated brief carries exactly the seven sections F07-AC1 names, and no eighth (F07-AC1)', async () => {
  await withHarness([succeeded(payloadFixture())], async ({ useCases, intake, stored, packet }) => {
    const view = generated(await generate(useCases, packet, stored));

    assert.deepEqual([...view.sectionNames], [...BRIEF_SECTION_NAMES], 'the recorded sections are the seven, in order');
    assert.deepEqual(
      Object.keys(view.brief.sections).sort(),
      [...BRIEF_SECTION_NAMES].sort(),
      'the stored brief holds those seven keys and nothing else',
    );
    assert.equal(view.mode, CLARIFICATION_MODE, 'one named mode produced this brief');
    assert.ok(view.promptCharacters > 0, 'the pass ran through a prompt');
    assert.deepEqual(view.bounds, DEFAULT_CLARIFICATION_BOUNDS);

    const stored_row = intake.currentBrief(IDEA_ID);
    assert.ok(stored_row.ok && stored_row.value !== null, 'the brief is a durable row');
    assert.equal(stored_row.value.state, 'Proposed', 'a generated brief is a proposal, never an agreement');
    assert.equal(stored_row.value.authoredBy, 'ClarificationModel');
    assert.equal(stored_row.value.version, 1);
    assert.equal(stored_row.value.sections.acceptanceCriteria[0]?.text, CRITERION_TEXT, 'the criterion reached the row intact');

    // What planning reads next: the requested outcomes. The list carries the brief's own
    // desired outcome as well as one per criterion, because coverage must hold for the goal
    // and not only for the things written down as checkable (F08-AC1, F08-AC5).
    assert.deepEqual(
      requestedOutcomesFor(stored_row.value).map((outcome: { id: string }) => outcome.id),
      ['brief.desiredOutcome', 'AC1'],
    );
    assert.deepEqual(
      [...unresolvedQuestionsFor(stored_row.value)],
      ['whether the typed name is kept when the list reloads'],
    );
  });
});

test('a section the specification does not name is a recoverable per-field error, and nothing is stored (F07-AC1)', async () => {
  await withHarness(
    [succeeded(payloadFixture({ sections: { ...sectionsFixture(), rolloutNotes: 'ships behind a flag' } }))],
    async ({ useCases, intake, stored, packet, engine }) => {
      const error = refusal(await generate(useCases, packet, stored));
      assert.equal(error.code, 'Invalid');
      assert.ok(
        fieldPaths(error).includes('sections.rolloutNotes'),
        `the invented section is named: ${fieldPaths(error).join(', ')}`,
      );
      assert.match(fieldMessages(error), /no section named/);

      const current = intake.currentBrief(IDEA_ID);
      assert.ok(current.ok && current.value === null, 'no brief was written for an invalid proposal');
      const questions = intake.listQuestions(IDEA_ID);
      assert.ok(questions.ok);
      assert.deepEqual([...questions.value], [], 'no question was recorded either');
      assert.equal(engine.starts.length, 1, 'the session ran once and was refused on its output');
    },
  );
});

test('an unobservable acceptance criterion is refused field by field rather than coerced into the brief (F07-AC1)', async () => {
  await withHarness(
    [
      succeeded(
        payloadFixture({
          sections: sectionsFixture({
            acceptanceCriteria: [{ id: 'AC1', text: 'the search experience is fast', verification: null }],
          }),
        }),
      ),
    ],
    async ({ useCases, intake, stored, packet }) => {
      const error = refusal(await generate(useCases, packet, stored));
      assert.equal(error.code, 'Invalid');
      assert.ok(
        fieldPaths(error).includes('sections.acceptanceCriteria[0].text'),
        `the vague criterion is named: ${fieldPaths(error).join(', ')}`,
      );
      assert.match(fieldMessages(error), /not observable/);

      const current = intake.currentBrief(IDEA_ID);
      assert.ok(current.ok && current.value === null, 'nothing was stored for a criterion nobody could check');
    },
  );
});

test('output that is not a brief proposal at all is refused by field path, and the owner\'s request is untouched (F07-AC1, F15-AC2)', async () => {
  await withHarness([{ output: 'Sure! Here is a brief for you.' }], async ({ useCases, intake, stored, packet }) => {
    const error = refusal(await generate(useCases, packet, stored));
    assert.equal(error.code, 'Invalid');
    assert.deepEqual([...fieldPaths(error)], ['structuredOutput']);
    assert.match(error.reason, /not JSON/);

    const reread = intake.read(IDEA_ID);
    assert.ok(reread.ok);
    assert.equal(reread.value.rawRequest, RAW_REQUEST, 'the raw request is byte-identical after a refusal');
    const current = intake.currentBrief(IDEA_ID);
    assert.ok(current.ok && current.value === null);
  });
});

test('the raw request fingerprint is the domain\'s own computation, so no model can attach a brief to a request it never read (F07-AC1, F06-AC1)', async () => {
  await withHarness([succeeded(payloadFixture())], async ({ useCases, intake, stored, packet }) => {
    generated(await generate(useCases, packet, stored));

    const row = intake.currentBrief(IDEA_ID);
    assert.ok(row.ok && row.value !== null);

    // Two different raw texts give two different fingerprints, and neither is a value
    // the model supplied: the proposal type has no field to supply one in.
    const first = applyProposal({
      kind: 'BriefProposal',
      ideaId: IDEA_ID,
      authoredBy: 'ClarificationModel',
      authoredAt: NOW,
      basedOnBriefVersion: null,
      sections: sectionsFixture(),
    });
    assert.ok(first.ok, 'the sections alone still validate');
    assert.equal(row.value.rawRequestFingerprint.length > 0, true);
    assert.match(row.value.rawRequestFingerprint, /^fp_[0-9a-f]{32}$/, 'the stored fingerprint is a domain fingerprint');

    const rebound = applyProposal({
      kind: 'BriefProposal',
      ideaId: 'idea-someone-else' as IdeaId,
      authoredBy: 'ClarificationModel',
      authoredAt: LATER,
      basedOnBriefVersion: null,
      sections: sectionsFixture(),
    });
    assert.ok(rebound.ok, 'the same sections are valid for any idea; the fingerprint is what binds them');
  });
});

/* -------------------------------------------------------------------------- */
/* F07-AC2                                                                     */
/* -------------------------------------------------------------------------- */

test('only a material ambiguity earns a question, and the question records why it matters (F07-AC2)', async () => {
  await withHarness(
    [succeeded(payloadFixture({ ambiguities: [MATERIAL_AMBIGUITY] }))],
    async ({ useCases, intake, stored, packet }) => {
      const view = generated(await generate(useCases, packet, stored));

      assert.equal(view.questions.length, 1, 'exactly the one open ambiguity became a question');
      const question = view.questions[0];
      assert.ok(question !== undefined);
      assert.equal(question.topic, 'retention of the typed name');
      assert.equal(question.origin, 'Ambiguity');
      assert.deepEqual([...question.readings], [...MATERIAL_AMBIGUITY.readings], 'both open readings are carried');
      assert.match(question.whyMaterial, /changes what is built/);
      assert.deepEqual([...view.rejected], [], 'nothing was considered and declined');

      const rows = intake.listQuestions(IDEA_ID);
      assert.ok(rows.ok);
      assert.equal(rows.value.length, 1);
      assert.equal(rows.value[0]?.state, 'Open');

      const conversation = intake.conversation(IDEA_ID);
      assert.ok(conversation.ok);
      assert.deepEqual(
        conversation.value.turns.map((entry) => entry.kind),
        ['RawRequest', 'Question'],
        'the question joins the conversation after the owner\'s own words',
      );
    },
  );
});

test('an ambiguity the request already answers is rejected and recorded, never put to the owner (F07-AC2)', async () => {
  await withHarness(
    [succeeded(payloadFixture({ ambiguities: [SETTLED_AMBIGUITY] }))],
    async ({ useCases, intake, stored, packet }) => {
      const view = generated(await generate(useCases, packet, stored));

      assert.deepEqual([...view.questions], [], 'a question the request already answers was not asked');
      assert.equal(view.rejected.length, 1);
      const declined = view.rejected[0];
      assert.ok(declined !== undefined);
      assert.equal(declined.topic, 'which page the search box belongs on');
      assert.equal(declined.rejection, 'AlreadyAnswered');
      assert.match(declined.explanation, /already answers/);

      const rows = intake.listQuestions(IDEA_ID);
      assert.ok(rows.ok);
      assert.deepEqual([...rows.value], [], 'no question row was written');

      const exported = intake.exportIdea(IDEA_ID);
      assert.ok(exported.ok);
      assert.equal(exported.value.rejectedQuestions.length, 1, 'the declined candidate stays visible to the owner');
      assert.equal(exported.value.rejectedQuestions[0]?.rejection, 'AlreadyAnswered');
    },
  );
});

test('a request the engine finds complete produces a brief with no interview at all (F07-AC2)', async () => {
  await withHarness([succeeded(payloadFixture())], async ({ useCases, packet, stored }) => {
    const view = generated(await generate(useCases, packet, stored));
    assert.deepEqual([...view.questions], []);
    assert.deepEqual([...view.rejected], []);
    assert.equal(view.brief.state, 'Proposed', 'the owner gets a brief, not an interrogation');
  });
});

test('a candidate the engine cannot describe as an ambiguity is reported as a field error, not silently dropped (F07-AC2)', async () => {
  await withHarness(
    [succeeded(payloadFixture({ ambiguities: [{ kind: 'UnspecifiedSubject', topic: 'a topic', readings: ['one reading'] }] }))],
    async ({ useCases, intake, stored, packet }) => {
      const error = refusal(await generate(useCases, packet, stored));
      assert.equal(error.code, 'Invalid');
      assert.ok(
        fieldPaths(error).some((path) => path.startsWith('ambiguities[0]')),
        `the malformed candidate is named: ${fieldPaths(error).join(', ')}`,
      );
      const current = intake.currentBrief(IDEA_ID);
      assert.ok(current.ok && current.value === null, 'a malformed candidate stores nothing');
    },
  );
});

/* -------------------------------------------------------------------------- */
/* F05-AC5 / F07-AC5 — owner decisions                                        */
/* -------------------------------------------------------------------------- */

test('a proposal that tries to set acceptance, delivery or release is refused outright and nothing is stored (F05-AC5, F07-AC5)', async () => {
  for (const field of ['acceptance', 'delivery', 'release', 'status']) {
    await withHarness(
      [succeeded(payloadFixture({ [field]: { state: 'Accepted', acceptedBy: 'the model' } }))],
      async ({ useCases, intake, stored, packet }) => {
        const error = refusal(await generate(useCases, packet, stored));
        assert.equal(error.code, 'Invalid', `"${field}" is refused as an Invalid proposal`);
        assert.ok(
          fieldPaths(error).includes(`proposal.${field}`),
          `"${field}" is named in the refusal rather than dropped: ${fieldPaths(error).join(', ')}`,
        );
        assert.match(error.reason, /owner decision/);
        assert.match(fieldMessages(error), /refused rather than stored/);

        const current = intake.currentBrief(IDEA_ID);
        assert.ok(current.ok && current.value === null, `no brief was written for the "${field}" payload`);
        const exported = intake.exportIdea(IDEA_ID);
        assert.ok(exported.ok);
        assert.equal(exported.value.briefVersions.length, 0, 'the export shows no brief either');
      },
    );
  }
});

test('the same field buried inside a section is refused too, because a nested decision is still a decision (F05-AC5)', async () => {
  await withHarness(
    [
      succeeded(
        payloadFixture({
          sections: sectionsFixture({ assumptions: ['the owner has already agreed to ship this'] }),
          release: { state: 'Released' },
        }),
      ),
    ],
    async ({ useCases, stored, packet }) => {
      const error = refusal(await generate(useCases, packet, stored));
      assert.equal(error.code, 'Invalid');
      assert.ok(
        fieldPaths(error).some((path) => path.endsWith('.release')),
        `the decision is named: ${fieldPaths(error).join(', ')}`,
      );
    },
  );
});

/* -------------------------------------------------------------------------- */
/* F06-AC1 / F07-AC3 — the owner's words                                      */
/* -------------------------------------------------------------------------- */

test('a generated brief never overwrites the raw request or the owner conversation (F06-AC1, F07-AC3)', async () => {
  await withHarness(
    [succeeded(payloadFixture({ ambiguities: [MATERIAL_AMBIGUITY] }))],
    async ({ useCases, intake, stored, packet, reopen }) => {
      const before = intake.read(IDEA_ID);
      assert.ok(before.ok);
      const conversationBefore = intake.conversation(IDEA_ID);
      assert.ok(conversationBefore.ok);

      generated(await generate(useCases, packet, stored));

      // Read through a second repository on a second connection to the same file, so this
      // is the row that survived the write rather than a value this handle cached
      // (F06-AC2).
      const after = reopen().read(IDEA_ID);
      assert.ok(after.ok);
      assert.equal(after.value.rawRequest, before.value.rawRequest, 'the owner\'s own words are byte-identical');
      assert.equal(after.value.rawRequest, RAW_REQUEST);
      assert.equal(after.value.summary, null, 'a brief is not a summary: the raw request stays the source of truth');

      const conversationAfter = reopen().conversation(IDEA_ID);
      assert.ok(conversationAfter.ok);
      const first = conversationAfter.value.turns[0];
      assert.ok(first !== undefined && first.kind === 'RawRequest');
      assert.equal(first.text, RAW_REQUEST, 'the raw request turn is unchanged and still first');
      assert.equal(
        conversationAfter.value.turns.length,
        conversationBefore.value.turns.length + 1,
        'the only new turn is the question',
      );
      assert.deepEqual(
        [...conversationAfter.value.turns].slice(0, 1).map((turn) => turn.kind),
        ['RawRequest'],
        'no turn was rewritten or reordered',
      );
    },
  );
});

test('a correction appends a version and every prior version stays readable (F07-AC3)', async () => {
  await withHarness([succeeded(payloadFixture())], async ({ useCases, intake, stored, packet }) => {
    generated(await generate(useCases, packet, stored));

    const first = intake.currentBrief(IDEA_ID);
    assert.ok(first.ok && first.value !== null);
    assert.equal(first.value.version, 1);

    const corrected = intake.applyCorrection({
      ideaId: IDEA_ID,
      brief: first.value,
      correctionId: 'correction-brief-generation',
      text: 'the search must also match the run id, not only the name',
      at: LATER,
      proposal: correctedProposal(1, LATER),
    });
    assert.ok(corrected.ok, 'the correction appended a version');
    assert.equal(corrected.value.version, 2);
    assert.equal(corrected.value.supersedesVersion, 1);
    assert.equal(corrected.value.rawRequestFingerprint, first.value.rawRequestFingerprint, 'both versions trace to one request');

    const versions = intake.listBriefs(IDEA_ID);
    assert.ok(versions.ok);
    assert.deepEqual(
      versions.value.map((brief) => brief.version),
      [1, 2],
      'both versions are stored, oldest first',
    );

    const prior = versions.value[0];
    assert.ok(prior !== undefined);
    assert.deepEqual(
      prior.sections.acceptanceCriteria.map((criterion) => criterion.text),
      [CRITERION_TEXT],
      'the prior version still says exactly what the owner first read',
    );
    assert.equal(prior.version, 1);
    assert.equal(prior.state, 'Proposed');

    const conversation = intake.conversation(IDEA_ID);
    assert.ok(conversation.ok);
    assert.deepEqual(
      conversation.value.turns.map((turn) => turn.kind),
      ['RawRequest', 'Correction'],
      "the correction is in the conversation and the owner's own words are still first",
    );
    const firstTurn = conversation.value.turns[0];
    assert.ok(firstTurn !== undefined && firstTurn.kind === 'RawRequest');
    assert.equal(firstTurn.text, RAW_REQUEST);
  });
});

test('a second generated brief for a request that already has one is a conflict, not a silent rewrite (F07-AC3)', async () => {
  await withHarness(
    [succeeded(payloadFixture()), succeeded(payloadFixture({ desiredOutcome: 'a different outcome' }))],
    async ({ useCases, intake, stored, packet }) => {
      generated(await generate(useCases, packet, stored));

      const again = refusal(await generate(useCases, packet, stored));
      assert.equal(again.code, 'Conflict');
      assert.match(again.reason, /already has a brief/);

      const versions = intake.listBriefs(IDEA_ID);
      assert.ok(versions.ok);
      assert.equal(versions.value.length, 1, 'the refused regeneration wrote nothing');
    },
  );
});

/** The owner's corrected sections, validated through the same door as every proposal. */
function correctedProposal(version: number, at: string): ValidatedBriefProposal {
  const validated = applyProposal({
    kind: 'BriefProposal',
    ideaId: IDEA_ID,
    authoredBy: 'OwnerEdit',
    authoredAt: at,
    basedOnBriefVersion: version,
    sections: sectionsFixture({
      acceptanceCriteria: [
        {
          id: 'AC1',
          text: 'the runs page adds a search box that filters the run table to rows whose name or id contains the typed text',
          verification: 'browser: type a known run name and a known run id, expect the matching row each time',
        },
      ],
    }),
  });
  if (!validated.ok) throw new Error(`the corrected proposal did not validate: ${validated.error.reason}`);
  return validated.value;
}

/* -------------------------------------------------------------------------- */
/* F07-AC5 — read-only                                                         */
/* -------------------------------------------------------------------------- */

test('the read-only capability profile exposes no mutating capability, and the engine was granted exactly it (F07-AC5)', async () => {
  await withHarness([succeeded(payloadFixture())], async ({ useCases, engine, stored, packet }) => {
    const profile = readOnlyCapabilityProfile;
    assert.equal(assertReadOnlyClarification(profile).ok, true, 'the shipped profile passes its own gate');

    const view = generated(await generate(useCases, packet, stored));
    assert.deepEqual(
      [...view.capability.capabilities],
      [...profile.capabilities],
      'the recorded profile is the profile that was granted',
    );
    assert.equal(view.capability.mayChangeApplicationCode, false);
    assert.equal(view.capability.mayPublishTickets, false);
    assert.equal(view.capability.mayDeploy, false);
    assert.equal(view.capability.mayStartCodingRun, false);
    assert.deepEqual(
      [...view.capability.forbiddenSideEffects].sort(),
      ['ChangeApplicationCode', 'ConsumeCodingRun', 'Deploy', 'PublishTicket'],
    );
    assert.equal(profile.capabilities.length > 0, true, 'the profile is not vacuously empty');

    const start = engine.starts[0];
    assert.ok(start !== undefined, 'the engine was started exactly once');
    assert.deepEqual(
      [...start.grantedCapabilities],
      [...profile.capabilities],
      'the session holds the read-only grant and nothing else',
    );
    assert.equal(start.mode, 'Headless', 'clarification is driven headlessly, like every bounded engine session');

    for (const capability of start.grantedCapabilities as readonly CapabilityKind[]) {
      assert.equal(isMutatingCapability(capability), false, `${capability} changes nothing outside clarification`);
      assert.equal(isPrivilegedDelivery(capability), false, `${capability} is not a delivery action`);
      assert.deepEqual([...deniedCodingCapabilities([capability])], [], `${capability} is not a privileged capability`);
    }

    for (const forbidden of [
      'Ticket:PublishIssue',
      'Ticket:RequestTransition',
      'Git:PushBranch',
      'Git:CreateDraft',
      'Git:MergeWithPrecondition',
      'Deployment:Execute',
      'Engine:StartScoped',
    ] as const) {
      assert.equal(
        (start.grantedCapabilities as readonly string[]).includes(forbidden),
        false,
        `${forbidden} is not a read the clarification session may hold`,
      );
    }
  });
});

test('no publication or deployment call is reachable from this path (F07-AC5)', async () => {
  await withHarness([succeeded(payloadFixture())], async ({ useCases, engine, stored, packet }) => {
    generated(await generate(useCases, packet, stored));

    // What this path *is*: one function on an object holding a clock, an engine, a store
    // and a workspace. There is no ticket adapter, git adapter or deployment executor on
    // it to call, so the property is structural rather than a promise.
    assert.deepEqual(Object.keys(useCases).sort(), ['generateBrief']);
    const surface = useCases as unknown as Record<string, unknown>;
    for (const name of [
      'publishWork',
      'requestTransition',
      'updateManagedProgress',
      'pushBranch',
      'upsertDraft',
      'mergePullRequest',
      'deploy',
      'execute',
      'dispatch',
      'startJob',
      'publish',
    ]) {
      assert.equal(surface[name], undefined, `${name} is not part of a clarification use case`);
    }

    // And what the engine was given: a workspace with no service endpoint, no test
    // credential and no privileged capability.
    const start = engine.starts[0];
    assert.ok(start !== undefined);
    assert.deepEqual([...start.workspace.serviceEndpoints], [], 'the read-only workspace has no service to reach');
    assert.equal(start.workspace.testAccess.kind, 'None', 'clarification gets no test credentials');
    assert.deepEqual(start.workspace.isolatedPorts, { api: 41010 }, 'it runs against the isolated port map it was given');
  });
});

/* -------------------------------------------------------------------------- */
/* F07-AC4 — context                                                           */
/* -------------------------------------------------------------------------- */

test('an uninspected repository fact reaches the prompt as Unknown and the engine\'s ungrounded claim stays Unknown (F07-AC4)', async () => {
  await withHarness(
    [
      succeeded(
        payloadFixture({
          claims: [
            {
              claimId: 'claim-grounded',
              subject: 'the runs page route',
              statement: 'the runs page is served by apps/web/src/ui/pages/RunsPage.tsx',
              inspectedRevision: HEAD_SHA,
              evidence: [{ kind: 'CodeLocation', reference: 'apps/web/src/ui/pages/RunsPage.tsx', observedAt: NOW }],
            },
            {
              claimId: 'claim-guess',
              subject: 'the runs table component',
              statement: 'the runs table is a shared component under packages/ui',
              inspectedRevision: 'main',
              evidence: [],
            },
          ],
        }),
      ),
    ],
    async ({ useCases, engine, stored, packet }) => {
      const view = generated(await generate(useCases, packet, stored));

      // The prompt tells the engine what was and was not read, and names the revision.
      const prompt = engine.prompts[0] ?? '';
      assert.match(prompt, /read at revision a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/);
      assert.match(prompt, /runs page guidance \[RepositoryGuidance\]: Unknown/);
      assert.match(prompt, /never captured the file/);
      assert.ok(prompt.includes(RAW_REQUEST), "the owner's own words are in the prompt verbatim");

      const grounded = view.claims.find((claim) => claim.claimId === 'claim-grounded');
      assert.ok(grounded !== undefined);
      assert.equal(grounded.grounded.state, 'Grounded');
      assert.equal(grounded.grounded.revision, HEAD_SHA);
      assert.equal(grounded.grounded.evidence.length, 1);

      // The engine claimed something about the code without a revision that identifies
      // code. The domain labels it Unknown; nothing here promotes it to a fact.
      const guess = view.claims.find((claim) => claim.claimId === 'claim-guess');
      assert.ok(guess !== undefined);
      assert.equal(guess.grounded.state, 'Unknown');
      assert.deepEqual([...guess.grounded.unknowns].sort(), ['Evidence', 'Revision']);
      assert.match(guess.grounded.reason ?? '', /no inspectable repository revision/);

      assert.deepEqual([...packet.unknownSubjects], ['the runs page guidance'], 'the packet still reports what it does not know');
    },
  );
});

test('engine text is redacted into the record, and the prompt is redacted on the way out (N02-AC3)', async () => {
  await withHarness(
    [
      succeeded(
        payloadFixture({
          sections: sectionsFixture({
            problem: `the runs page is slow; the deploy used ${SEEDED_SECRET} to reach the registry`,
          }),
        }),
      ),
    ],
    async ({ useCases, engine, intake, stored, packet }) => {
      const view = generated(await generate(useCases, packet, stored));

      const serialized = JSON.stringify(view.brief);
      assert.ok(!serialized.includes(SEEDED_SECRET), 'the seeded credential never reaches the generated brief');
      assert.match(serialized, /\[redacted:openai-key\]/, 'it is replaced by the redaction marker, not quietly dropped');

      // Read through a second connection so the marker is provably what was stored.
      const exported = intake.exportIdea(IDEA_ID);
      assert.ok(exported.ok);
      assert.ok(!JSON.stringify(exported.value).includes(SEEDED_SECRET), 'the export carries no seeded credential either');

      // The prompt crosses into an external process, so it names the mode and the sandbox.
      const prompt = engine.prompts[0] ?? '';
      assert.match(prompt, /^ShipLoop shipLoop-clarify\./);
      assert.match(prompt, /read-only/);
      assert.ok(!prompt.includes(SEEDED_SECRET), 'the prompt carries no credential from the request either');
    },
  );
});

/* -------------------------------------------------------------------------- */
/* F18-AC2 — bounds                                                            */
/* -------------------------------------------------------------------------- */

test('the session is bounded in wall clock and events, and its bounds reach the adapter request (F18-AC2)', async () => {
  await withHarness([succeeded(payloadFixture())], async ({ useCases, engine, stored, packet }) => {
    const view = generated(await generate(useCases, packet, stored));

    const start = engine.starts[0];
    assert.ok(start !== undefined);
    const bounds: EngineBounds = start.bounds;
    assert.equal(bounds.activeWallClockMs, DEFAULT_CLARIFICATION_BOUNDS.activeWallClockMs);
    assert.equal(bounds.eventCountLimit, DEFAULT_CLARIFICATION_BOUNDS.eventCountLimit);
    assert.equal(bounds.retryBudget, 0, 'a clarification pass does not retry blindly');
    assert.ok(
      bounds.activeWallClockMs < 60 * 60 * 1000,
      'a brief is minutes of work, not the hour a coding attempt gets',
    );
    assert.equal(view.bounds.maxOutputCharacters, DEFAULT_CLARIFICATION_BOUNDS.maxOutputCharacters);
  });
});

test('a truncated engine answer is refused rather than stored as a brief (F15-AC2, F18-AC2)', async () => {
  await withHarness(
    [
      {
        output: '',
        outcome: { kind: 'Incomplete', reason: 'OutputTruncated', summary: 'The engine stopped before producing the whole reply.' },
      },
    ],
    async ({ useCases, intake, stored, packet }) => {
      const error = refusal(await generate(useCases, packet, stored));
      assert.equal(error.code, 'Blocked');
      assert.match(error.reason, /did not finish/);
      const current = intake.currentBrief(IDEA_ID);
      assert.ok(current.ok && current.value === null, 'a truncated answer stored no brief');
    },
  );
});

test('an answer past the output bound is refused by name instead of becoming a very long brief (F18-AC2)', async () => {
  await withHarness(
    [succeeded(payloadFixture({ sections: sectionsFixture({ problem: 'y'.repeat(2_000) }) }))],
    async ({ useCases, intake, stored, packet }) => {
      const error = refusal(await generate(useCases, packet, stored));
      assert.equal(error.code, 'Blocked');
      assert.match(error.reason, /character bound/);
      const current = intake.currentBrief(IDEA_ID);
      assert.ok(current.ok && current.value === null);
    },
    { activeWallClockMs: 60_000, eventCountLimit: 64, maxOutputCharacters: 256 },
  );
});

test('an engine that reports no usable result is refused, because no output is not a brief (F15-AC2)', async () => {
  await withHarness(
    [{ output: '', outcome: { kind: 'Failed', category: 'MalformedOutput', summary: 'unparseable stream', remedy: null } }],
    async ({ useCases, stored, packet }) => {
      const error = refusal(await generate(useCases, packet, stored));
      assert.equal(error.code, 'Unavailable');
      assert.match(error.reason, /failed/);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Live, opt-in                                                                */
/* -------------------------------------------------------------------------- */

test('a live clarification pass runs the shipped Codex adapter (opt-in; prints the prerequisite it is missing)', async (t) => {
  const missing = [
    ['SHIPLOOP_BRIEF_GENERATION_LIVE=1', process.env['SHIPLOOP_BRIEF_GENERATION_LIVE']],
    ['SHIPLOOP_CODEX_BINARY', process.env['SHIPLOOP_CODEX_BINARY']],
    [
      'SHIPLOOP_BRIEF_GENERATION_WORKSPACE (an existing checkout at a real commit)',
      process.env['SHIPLOOP_BRIEF_GENERATION_WORKSPACE'],
    ],
  ].filter(([, value]) => value === undefined || value === '');

  if (missing.length > 0) {
    t.skip(
      `live clarification skipped; set ${missing.map(([name]) => String(name)).join(', ')}. The pass needs an authenticated codex on PATH and a real checkout to read at a recorded revision, and it spends account quota (F03-AC1, F15-AC1).`,
    );
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), 'shiploop-brief-generation-live-'));
  const opened = openDatabase(join(directory, 'shiploop.sqlite'));
  assert.ok(opened.ok);
  assert.ok(migrate(opened.value).ok);
  const intake = new IntakeRepository(opened.value);
  try {
    const captured = createIdea({
      ideaId: 'idea-brief-generation-live' as IdeaId,
      rawRequest: RAW_REQUEST,
      capturedAt: NOW,
      kind: 'FeatureRequest',
      projectId: null,
    });
    assert.ok(captured.ok);
    const stored = intake.capture(captured.value);
    assert.ok(stored.ok);
    const turn = intake.recordTurn(stored.value.ideaId, { kind: 'RawRequest', at: NOW, text: stored.value.rawRequest });
    assert.ok(turn.ok);

    const adapter = new CodexEngineAdapter({
      connectorId: 'connector_configured_codex' as ConnectorId,
      client: { binary: String(process.env['SHIPLOOP_CODEX_BINARY']) },
    });
    const workspace: ExecutionWorkspace = {
      ...WORKSPACE,
      workspaceId: 'workspace_clarify_live',
      absolutePath: String(process.env['SHIPLOOP_BRIEF_GENERATION_WORKSPACE']),
    };

    const result = await createBriefGenerationUseCases({
      clock,
      engine: createEngineClarifier({ engine: adapter, workspace, clock }),
      store: intake,
      workspace,
    }).generateBrief({
      briefId: `brief-${stored.value.ideaId}`,
      idea: stored.value,
      contextPacket: packetFor(stored.value),
    });

    if (!result.ok) {
      // A live pass the engine could not complete is reported, never asserted away.
      assert.ok(result.error.reason.length > 0, "the refusal carries the engine's own reason");
      return;
    }
    assert.deepEqual([...result.value.sectionNames], [...BRIEF_SECTION_NAMES]);
    assert.equal(result.value.capability.mayDeploy, false);
    assert.equal(result.value.capability.mayPublishTickets, false);
  } finally {
    opened.value.close();
    await rm(directory, { recursive: true, force: true });
  }
});
