/**
 * Route-level tests for the home projection (mvp-spec 3, MVP journey).
 *
 * Every request goes through `app.inject()`, so the plugin tree, the session guard, the
 * project parameter schema and the error-to-status mapping are the real ones. What is
 * substituted is the storage behind the two ports this route composes, and the substitution
 * is deliberate: this file is about which group a *recorded fact* lands in, so the facts are
 * seeded directly and the domain's own review read model — `buildMvpReviewReadModel`, the
 * real function — decides readiness and staleness. The projection under test is never asked
 * to compute them itself.
 *
 * Two things these tests exist to keep unreachable:
 *
 *   - a claim about external execution progress, which ShipLoop has no integration to
 *     support. `assertNoExecutionClaim` walks the whole payload rather than spot-checking
 *     one field, and `assertEntryShape` pins the exact key set so a progress field cannot
 *     be added later without a test failing.
 *   - a fabricated entry. A project with nothing in it answers three empty lists, and the
 *     empty case is asserted as a first-class outcome rather than assumed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

import {
  buildMvpReviewReadModel,
  hashSessionToken,
  ok,
  recordMvpEvidence,
  recordMvpOwnerDecision,
  sessionDeadlines,
  type CommitSha,
  type DeliveryCandidate,
  type DomainError,
  type MvpCandidateView,
  type MvpContractView,
  type MvpOwnerDecision,
  type MvpRecordedEvidence,
  type MvpRequestView,
  type MvpReviewReadModel,
  type MvpVerificationPolicy,
  type OwnerId,
  type ProjectId,
  type Result,
} from '@shiploop/domain';

import { buildApp } from '../app.ts';
import { readServerConfig, type ServerConfig } from '../config.ts';
import { SESSION_COOKIE_NAME } from '@shiploop/domain';
import type {
  ContractUseCases,
  ContractView,
  ControllerSurface,
  ProjectUseCases,
  RequestDetailView,
  RequestView,
  SessionUseCases,
  StoredSessionRecord,
} from '../contracts.ts';

/** The parts of an injected response these tests read; declared here rather than imported. */
interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
}
import type { HomeEvidenceSources, HomeProjection } from './home.ts';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

const CSRF_SECRET = ['server', 'secret', 'material', '0123456789abcdef'].join('-');
const START = '2026-10-03T12:00:00.000Z';
const LATER = '2026-10-03T13:00:00.000Z';
const OWNER_ID = 'owner-0000-4000-8000-00000000000c' as OwnerId;
const PROJECT = 'octopus-main';
const OTHER_PROJECT = 'octopus-docs';
const REPOSITORY = 'acme/web';
const CONTRACT_ID = 'dc_octopus_main_1';
const UNIT_CHECK = 'unit';

/** Two distinct full 40-character SHAs, so a stale binding can be expressed at all. */
const HEAD_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' as CommitSha;
const HEAD_B = 'f0e1d2c3b4a5968778695a4b3c2d1e0f001122334' as CommitSha;

/**
 * The verification policy the seeded projects run under.
 *
 * `unit` is required, and a pending owner test blocks neither the review offer nor the
 * acceptance — the F24-AC3 reading, written as configuration so a test cannot pass by
 * accident against the default's empty required list.
 */
const POLICY: MvpVerificationPolicy = {
  policyId: 'test-policy',
  requiredAutomatedCheckIds: [UNIT_CHECK],
  deliveryRequiredCheckIds: [UNIT_CHECK],
  ownerTestBlocksReview: false,
  ownerTestBlocksDelivery: true,
};

const TOKEN = 'home-route-test-token';
const SESSION_ID = 'sess_home_test';

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

/** One seeded request: its identity and the contract revisions recorded against it. */
interface SeedRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly revisions: readonly {
    readonly contractId: string;
    readonly revision: number;
    readonly status: 'draft' | 'approved' | 'stale';
  }[];
}

function contractView(seed: SeedRequest, revision: SeedRequest['revisions'][number]): ContractView {
  const approved = revision.status === 'approved';
  return {
    contractId: revision.contractId,
    revision: revision.revision,
    projectId: seed.projectId,
    requestId: seed.requestId,
    status: revision.status,
    outcome: 'The described behaviour works.',
    scope: ['The thing that changes'],
    outOfScope: ['Everything else'],
    acceptanceCriteria: [
      { id: 'c-unit', description: 'The automated suite passes.', verificationType: 'automated' },
      { id: 'c-owner', description: 'Sign in and see the dashboard.', verificationType: 'owner_test' },
    ],
    contentFingerprint: `fp_content_${seed.requestId}_${revision.revision}`,
    requestFingerprint: `fp_request_${seed.requestId}`,
    answersCurrentRequest: true,
    approvedAt: approved ? LATER : null,
    approvedBy: approved ? String(OWNER_ID) : null,
    staleReason: null,
    supersededByRevision: null,
    sourceBriefId: null,
    sourceBriefVersion: null,
    createdBy: String(OWNER_ID),
    createdAt: START,
    updatedAt: approved ? LATER : START,
    blockedBecause: null,
  };
}

function requestView(seed: SeedRequest): RequestView {
  return {
    requestId: seed.requestId,
    projectId: seed.projectId,
    title: seed.title,
    description: seed.description,
    sourceIdeaId: null,
    createdAt: START,
    updatedAt: LATER,
  };
}

/* -------------------------------------------------------------------------- */
/* The stored-fact doubles                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The requests and contract revisions this project holds.
 *
 * Deliberately a plain map rather than the real repositories: the projection reads one
 * project's requests and their revisions, and a test that seeds those two things directly
 * states the fact it is asserting about. Cross-project refusal is still enforced here —
 * `getRequest` is keyed by `(projectId, requestId)` exactly as the real repository is, so a
 * request seeded under one project is invisible through another.
 */
class SeededContracts {
  private readonly seeds: SeedRequest[] = [];

  add(seed: SeedRequest): void {
    this.seeds.push(seed);
  }

  listForProject(projectId: string): readonly RequestView[] {
    return this.seeds.filter((seed) => seed.projectId === projectId).map(requestView);
  }

  detail(projectId: string, requestId: string): Result<RequestDetailView, DomainError> {
    const seed = this.seeds.find((entry) => entry.projectId === projectId && entry.requestId === requestId);
    if (seed === undefined) {
      return {
        ok: false,
        error: { code: 'NotFound', reason: `No request "${requestId}" exists in this project (F02-AC2).` },
      };
    }
    const revisions = seed.revisions.map((revision) => contractView(seed, revision));
    const approved = [...revisions].reverse().find((revision) => revision.status === 'approved') ?? null;
    const latest = revisions.length === 0 ? null : revisions[revisions.length - 1] ?? null;
    return ok({ request: requestView(seed), latestRevision: latest, approvedRevision: approved, revisions });
  }
}

/** A use case this file does not implement, refusing by name rather than pretending. */
function notImplemented<T>(useCase: string): Promise<Result<T, DomainError>> {
  return Promise.resolve({
    ok: false,
    error: { code: 'Unavailable', reason: `The home-route double does not implement ${useCase}.` },
  });
}

function contractUseCases(store: SeededContracts): ContractUseCases {
  return {
    createRequest: () => notImplemented('contracts.createRequest'),
    getRequest: async (command) => store.detail(command.projectId, command.requestId),
    listRequests: async (command) => ok(store.listForProject(command.projectId)),
    updateRequest: () => notImplemented('contracts.updateRequest'),
    draftContract: () => notImplemented('contracts.draftContract'),
    getContract: () => notImplemented('contracts.getContract'),
    listContractRevisions: () => notImplemented('contracts.listContractRevisions'),
    listContractCriteria: () => notImplemented('contracts.listContractCriteria'),
    editContract: () => notImplemented('contracts.editContract'),
    approveRevision: () => notImplemented('contracts.approveRevision'),
    reviseContract: () => notImplemented('contracts.reviseContract'),
    invalidateRevision: () => notImplemented('contracts.invalidateRevision'),
  };
}

/**
 * One session, stored the way the store stores it.
 *
 * Only a digest, matching F01-AC2: the plaintext below is what the test puts on the wire and
 * the row holds nothing else about it.
 */
function storedSession(now: () => Date): StoredSessionRecord {
  const deadlines = sessionDeadlines({
    issuedAt: now().toISOString(),
    absoluteTtlSeconds: 8 * 60 * 60,
    idleTimeoutSeconds: 60 * 60,
  });
  return {
    sessionId: SESSION_ID,
    ownerId: OWNER_ID,
    displayName: 'Octopus Owner',
    tokenDigest: hashSessionToken(TOKEN),
    issuedAt: deadlines.issuedAt,
    expiresAt: deadlines.expiresAt,
    revokedAt: null,
    lastActivityAt: null,
  };
}

function sessionUseCases(record: StoredSessionRecord): SessionUseCases {
  return {
    loadByToken: async (token) => (hashSessionToken(token) === record.tokenDigest ? ok(record) : {
      ok: false,
      error: { code: 'NotFound', reason: 'No session matches this token (F01-AC2).' },
    }),
    create: () => notImplemented('sessions.create'),
    revoke: () => notImplemented('sessions.revoke'),
    touch: async () => ok(null),
  };
}

const PROJECTS: ProjectUseCases = {
  listProjects: async () => ok([]),
  createProject: () => notImplemented('projects.createProject'),
};

/**
 * The candidate and review projections, over facts a test seeded.
 *
 * `reviewReadModel` calls the domain's real `buildMvpReviewReadModel` rather than returning
 * a hand-written model, so the staleness and eligibility this route reads are the ones the
 * domain computes from the evidence rows — a test cannot make a stale candidate look ready
 * by asserting it is ready.
 */
class SeededSources implements HomeEvidenceSources {
  private readonly candidates = new Map<string, DeliveryCandidate>();
  private readonly facts = new Map<string, { readonly request: MvpRequestView; readonly contract: MvpContractView; readonly candidate: MvpCandidateView }>();
  private readonly evidence = new Map<string, readonly MvpRecordedEvidence[]>();
  private readonly decisions = new Map<string, readonly MvpOwnerDecision[]>();

  seed(input: {
    readonly candidate: DeliveryCandidate;
    readonly criteria: readonly { readonly id: string; readonly description: string; readonly verificationType: 'automated' | 'owner_test'; readonly verificationCheckId: string | null }[];
  }): void {
    const key = `${input.candidate.projectId}/${input.candidate.requestId}`;
    this.candidates.set(key, input.candidate);
    this.facts.set(key, {
      request: {
        id: input.candidate.requestId,
        projectId: String(input.candidate.projectId),
        title: 'Checkout totals',
        description: 'The cart shows the right total.',
        createdAt: START,
        updatedAt: LATER,
      },
      contract: {
        id: input.candidate.contractId,
        projectId: String(input.candidate.projectId),
        requestId: input.candidate.requestId,
        revision: input.candidate.contractRevision,
        outcome: 'The described behaviour works.',
        scope: 'The thing that changes',
        outOfScope: ['Everything else'],
        acceptanceCriteria: input.criteria.map((criterion) => ({ ...criterion })),
        status: 'approved',
        approvedAt: LATER,
        createdAt: START,
        updatedAt: LATER,
      },
      candidate: {
        id: input.candidate.candidateId,
        projectId: String(input.candidate.projectId),
        requestId: input.candidate.requestId,
        contractId: input.candidate.contractId,
        contractRevision: input.candidate.contractRevision,
        repository: input.candidate.repository,
        pullRequestNumber: input.candidate.pullRequestNumber,
        pullRequestUrl: input.candidate.pullRequestUrl,
        baseBranch: input.candidate.baseBranch,
        headSha: input.candidate.headSha,
        observedAt: input.candidate.observedAt,
      },
    });
    this.evidence.set(key, []);
    this.decisions.set(key, []);
  }

  /** Records one automated observation against whatever the candidate's head is now. */
  recordCheckResult(input: {
    readonly projectId: string;
    readonly requestId: string;
    readonly candidateId: string;
    readonly observedHeadSha: CommitSha;
    readonly outcome: 'passed' | 'failed' | 'missing';
    readonly evidenceId: string;
  }): void {
    const key = `${input.projectId}/${input.requestId}`;
    const facts = this.facts.get(key);
    if (facts === undefined) throw new Error(`No candidate is seeded for ${key}.`);
    const recorded = recordMvpEvidence({
      evidenceId: input.evidenceId,
      contractId: facts.contract.id,
      candidateId: input.candidateId,
      subject: { kind: 'check', checkId: UNIT_CHECK },
      method: { kind: 'AutomatedCheck', checkId: UNIT_CHECK },
      observation: { kind: 'command', outcome: input.outcome },
      observedHeadSha: input.observedHeadSha,
      observedContractRevision: facts.contract.revision,
      observedAt: LATER,
      detail: null,
      artifactRef: null,
    });
    if (!recorded.ok) throw new Error(`The seeded evidence must be recordable: ${recorded.error.reason}`);
    this.evidence.set(key, [...(this.evidence.get(key) ?? []), recorded.value]);
  }

  /** Records the owner's own test outcome for the owner-test criterion. */
  recordOwnerTest(input: {
    readonly projectId: string;
    readonly requestId: string;
    readonly candidateId: string;
    readonly criterionId: string;
    readonly observedHeadSha: CommitSha;
    readonly outcome: 'passed' | 'failed';
    readonly evidenceId: string;
  }): void {
    const key = `${input.projectId}/${input.requestId}`;
    const facts = this.facts.get(key);
    if (facts === undefined) throw new Error(`No candidate is seeded for ${key}.`);
    const criterion = facts.contract.acceptanceCriteria.find((entry) => entry.id === input.criterionId);
    if (criterion === undefined) throw new Error(`The seeded contract declares no criterion "${input.criterionId}".`);
    const recorded = recordMvpEvidence({
      evidenceId: input.evidenceId,
      contractId: facts.contract.id,
      candidateId: input.candidateId,
      subject: { kind: 'criterion', criterionId: input.criterionId },
      method: { kind: 'OwnerTest', instructions: criterion.description },
      observation: { kind: 'owner_test', outcome: input.outcome, actor: { role: 'owner', ownerId: OWNER_ID } },
      observedHeadSha: input.observedHeadSha,
      observedContractRevision: facts.contract.revision,
      observedAt: LATER,
      detail: null,
      artifactRef: null,
    });
    if (!recorded.ok) throw new Error(`The seeded owner test must be recordable: ${recorded.error.reason}`);
    this.evidence.set(key, [...(this.evidence.get(key) ?? []), recorded.value]);
  }

  /** Records an owner decision against the candidate's current commit. */
  recordDecision(input: {
    readonly projectId: string;
    readonly requestId: string;
    readonly candidateId: string;
    readonly kind: 'accepted' | 'changes_requested';
    readonly headSha: CommitSha;
    readonly decisionId: string;
  }): void {
    const key = `${input.projectId}/${input.requestId}`;
    const facts = this.facts.get(key);
    if (facts === undefined) throw new Error(`No candidate is seeded for ${key}.`);
    const recorded = recordMvpOwnerDecision({
      decisionId: input.decisionId,
      kind: input.kind,
      actor: { role: 'owner', ownerId: OWNER_ID },
      projectId: input.projectId,
      requestId: input.requestId,
      contractId: facts.contract.id,
      contractRevision: facts.contract.revision,
      candidateId: input.candidateId,
      candidateHeadSha: input.headSha,
      decidedAt: LATER,
      feedback: null,
    });
    if (!recorded.ok) throw new Error(`The seeded decision must be recordable: ${recorded.error.reason}`);
    this.decisions.set(key, [...(this.decisions.get(key) ?? []), recorded.value]);
  }

  async recordedCandidate(query: {
    readonly projectId: string;
    readonly requestId: string;
  }): Promise<Result<DeliveryCandidate | null, DomainError>> {
    const candidate = this.candidates.get(`${query.projectId}/${query.requestId}`);
    // A candidate belonging to another project is invisible through this project's session,
    // not merely refused (F02-AC2) — which is the read this double has to model, because the
    // projection addresses candidates by request id alone.
    if (candidate !== undefined && String(candidate.projectId) !== query.projectId) return ok(null);
    return ok(candidate ?? null);
  }

  async reviewReadModel(query: {
    readonly projectId: string;
    readonly requestId: string;
    readonly candidateId: string;
  }): Promise<Result<MvpReviewReadModel, DomainError>> {
    const key = `${query.projectId}/${query.requestId}`;
    const facts = this.facts.get(key);
    if (facts === undefined || facts.candidate.id !== query.candidateId) {
      return { ok: false, error: { code: 'NotFound', reason: `No candidate "${query.candidateId}" for this request (F24-AC3).` } };
    }
    return buildMvpReviewReadModel({
      request: facts.request,
      contract: facts.contract,
      candidate: facts.candidate,
      policy: POLICY,
      evidence: this.evidence.get(key) ?? [],
      decisions: this.decisions.get(key) ?? [],
      evaluatedAt: LATER,
    });
  }
}

/** A candidate row as the recorded read holds it. */
function candidate(input: {
  readonly candidateId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly headSha: CommitSha;
}): DeliveryCandidate {
  return {
    candidateId: input.candidateId as DeliveryCandidate['candidateId'],
    projectId: input.projectId as ProjectId,
    requestId: input.requestId,
    contractId: CONTRACT_ID,
    contractRevision: 1,
    provider: 'github',
    repository: REPOSITORY,
    pullRequestNumber: 42,
    pullRequestUrl: 'https://example.invalid/acme/web/pull/42',
    baseBranch: 'main',
    baseSha: HEAD_B,
    headBranch: 'feature/checkout',
    headSha: input.headSha,
    pullRequestState: 'Open',
    draft: false,
    observedAt: LATER,
    linkedAt: START,
  };
}

/** The two criteria every seeded contract declares. */
const CRITERIA = [
  { id: 'c-unit', description: 'The automated suite passes.', verificationType: 'automated', verificationCheckId: UNIT_CHECK },
  { id: 'c-owner', description: 'Sign in and see the dashboard.', verificationType: 'owner_test', verificationCheckId: null },
] as const;

/* -------------------------------------------------------------------------- */
/* The harness                                                                 */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly app: FastifyInstance;
  readonly contracts: SeededContracts;
  readonly sources: SeededSources;
  readonly cookie: string;
  readonly close: () => Promise<void>;
}

async function harness(options: { readonly sources?: HomeEvidenceSources | null } = {}): Promise<Harness> {
  const now = (): Date => new Date(START);
  const contracts = new SeededContracts();
  const record = storedSession(now);
  const controller: ControllerSurface = {
    owners: {
      provision: () => notImplemented('owners.provision'),
      signIn: () => notImplemented('owners.signIn'),
      describe: () => notImplemented('owners.describe'),
      selectActiveProject: () => notImplemented('owners.selectActiveProject'),
    },
    projects: PROJECTS,
    contracts: contractUseCases(contracts),
    sessions: sessionUseCases(record),
    profiles: {
      saveVersion: () => notImplemented('profiles.saveVersion'),
      currentVersion: () => notImplemented('profiles.currentVersion'),
      listVersions: () => notImplemented('profiles.listVersions'),
    },
    connectors: {
      register: () => notImplemented('connectors.register'),
      listForProject: () => notImplemented('connectors.listForProject'),
      revoke: () => notImplemented('connectors.revoke'),
    },
    intake: new Proxy({} as ControllerSurface['intake'], {
      get: () => () => notImplemented('intake'),
    }),
    runs: new Proxy({} as ControllerSurface['runs'], { get: () => () => notImplemented('runs') }),
    attention: new Proxy({} as ControllerSurface['attention'], { get: () => () => notImplemented('attention') }),
    reviewCards: new Proxy({} as ControllerSurface['reviewCards'], { get: () => () => notImplemented('reviewCards') }),
    acceptance: new Proxy({} as ControllerSurface['acceptance'], { get: () => () => notImplemented('acceptance') }),
    ownerTests: new Proxy({} as ControllerSurface['ownerTests'], { get: () => () => notImplemented('ownerTests') }),
    handoff: new Proxy({} as ControllerSurface['handoff'], { get: () => () => notImplemented('handoff') }),
    // The home projection reads none of these; it derives its board from the contract, candidate
    // and review groups. They are stubbed through the same Proxy the neighbouring groups use, rather
    // than omitted, so this double still has to satisfy the whole surface. `mvpReview` is here for
    // that reason alone: the board composes its own projection through `sources`, and the review
    // card routes are not exercised here at all.
    mvpReview: new Proxy({} as ControllerSurface['mvpReview'], { get: () => () => notImplemented('mvpReview') }),
    settings: new Proxy({} as ControllerSurface['settings'], { get: () => () => notImplemented('settings') }),
    planning: new Proxy({} as ControllerSurface['planning'], { get: () => () => notImplemented('planning') }),
    generation: new Proxy({} as ControllerSurface['generation'], { get: () => () => notImplemented('generation') }),
  };

  const sources = 'sources' in options ? (options.sources ?? null) : new SeededSources();
  const app = await buildApp({
    config: testConfig(),
    controller,
    now,
    homeSources: sources,
  });
  return {
    app,
    contracts,
    sources: sources instanceof SeededSources ? sources : new SeededSources(),
    cookie: `${SESSION_COOKIE_NAME}=${TOKEN}`,
    close: () => app.close(),
  };
}

async function readHome(h: Harness, projectId: string): Promise<{ readonly status: number; readonly home: HomeProjection | null; readonly raw: string }> {
  const response = await h.app.inject({
    method: 'GET',
    url: `/api/projects/${projectId}/home`,
    headers: { cookie: h.cookie },
  });
  return {
    status: response.statusCode,
    home: parse<{ home?: HomeProjection }>(response).home ?? null,
    raw: response.body,
  };
}

function parse<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

/** The kinds present in one group, in order, for a readable assertion. */
function kindsOf(entries: readonly { readonly kind: string }[] | undefined): readonly string[] {
  return (entries ?? []).map((entry) => entry.kind);
}

/* -------------------------------------------------------------------------- */
/* The honesty assertions                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Nothing the board reports may claim an executor is running, or report a percentage.
 *
 * A walk rather than a spot check, because the failure mode is a *new* value rather than a
 * wrong one in an existing value. The vocabulary is the one the product cut removed: agent
 * and executor words, progress and timing words, and the providers this MVP must work
 * without any credential for.
 *
 * Applied to the entries' values, not to the whole payload: the group name `inProgress` is
 * required vocabulary and would trip the word `progress` on a key name alone. The key names
 * are covered instead by `assertEntryShape` and by the empty-project test, both of which
 * pin them exactly — so a key that reported progress would fail there rather than here.
 */
const EXECUTION_CLAIM_WORDS = [
  'progress',
  'percent',
  'running',
  'agent',
  'elapsed',
  'duration',
  'remaining',
  'eta',
  'stage',
  'queue',
  'in flight',
  't3',
  'codex',
  'claude',
  'terminal',
] as const;

function assertNoExecutionClaim(home: HomeProjection): void {
  const values = JSON.stringify([home.needsYou, home.inProgress, home.readyForReview]).toLowerCase();
  for (const word of EXECUTION_CLAIM_WORDS) {
    assert.equal(
      values.includes(word),
      false,
      `no home entry may mention "${word}": ShipLoop has no supported way to know it`,
    );
  }
}

/**
 * The exact key set of one entry.
 *
 * Pinned so a future field — a percentage, a phase, an executor name — fails here rather
 * than shipping as a new claim nobody asserted against.
 */
const ENTRY_KEYS = [
  'candidateId',
  'contractId',
  'contractRevision',
  'headSha',
  'kind',
  'nextAction',
  'outstandingCriterionIds',
  'reason',
  'requestId',
  'title',
] as const;

function assertEntryShape(home: HomeProjection): void {
  for (const group of [home.needsYou, home.inProgress, home.readyForReview]) {
    for (const entry of group) {
      assert.deepEqual(Object.keys(entry).sort(), [...ENTRY_KEYS], 'an entry carries exactly the declared facts');
      assert.equal(String(entry.kind).length > 0, true);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

test('mvp-spec 3: a project with nothing in it answers three empty groups', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { status, home } = await readHome(h, PROJECT);
  assert.equal(status, 200);
  assert.ok(home !== null);
  assert.deepEqual(home.needsYou, [], 'an empty project needs nothing from the owner');
  assert.deepEqual(home.inProgress, [], 'and has nothing recorded as moving');
  assert.deepEqual(home.readyForReview, [], 'and nothing to review');
  assert.deepEqual(
    Object.keys(home).sort(),
    ['collectedAt', 'inProgress', 'needsYou', 'projectId', 'readyForReview'],
  );
});

test('mvp-spec 3: a draft contract and a request with no contract both need the owner', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  h.contracts.add({ requestId: 'req_draft', projectId: PROJECT, title: 'Checkout totals', description: 'x', revisions: [{ contractId: CONTRACT_ID, revision: 1, status: 'draft' }] });
  h.contracts.add({ requestId: 'req_bare', projectId: PROJECT, title: 'Dark mode', description: 'y', revisions: [] });

  const { status, home } = await readHome(h, PROJECT);
  assert.equal(status, 200);
  assert.ok(home !== null);
  assert.deepEqual(kindsOf(home.needsYou), ['ContractAwaitingApproval', 'ContractNotWritten']);
  assert.deepEqual(home.inProgress, [], 'a request without an approved contract is not moving');
  assert.deepEqual(home.readyForReview, [], 'and there is nothing to review');
  const draft = home.needsYou[0];
  assert.equal(draft?.contractId, CONTRACT_ID);
  assert.equal(draft?.contractRevision, 1);
  assert.equal(draft?.candidateId, null, 'no candidate is linked to a draft');
  assertEntryShape(home);
});

test('mvp-spec 3, MVP journey: an approved contract with no candidate is in progress and not ready for review', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  h.contracts.add({ requestId: 'req_linked', projectId: PROJECT, title: 'Checkout totals', description: 'x', revisions: [{ contractId: CONTRACT_ID, revision: 1, status: 'approved' }] });

  const { status, home } = await readHome(h, PROJECT);
  assert.equal(status, 200);
  assert.ok(home !== null);
  assert.deepEqual(home.needsYou, [], 'no owner action is outstanding yet');
  assert.deepEqual(kindsOf(home.inProgress), ['CandidateNotLinked']);
  assert.deepEqual(home.readyForReview, [], 'an approved contract with no candidate is nothing to review');
  assert.equal(home.inProgress[0]?.headSha, null, 'no candidate means no commit to name');
});

test('mvp-spec 3: a candidate with a current passing result and no decision is ready for review', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  h.contracts.add({ requestId: 'req_ok', projectId: PROJECT, title: 'Checkout totals', description: 'x', revisions: [{ contractId: CONTRACT_ID, revision: 1, status: 'approved' }] });
  h.sources.seed({ candidate: candidate({ candidateId: 'cand_ok', projectId: PROJECT, requestId: 'req_ok', headSha: HEAD_A }), criteria: CRITERIA });
  h.sources.recordCheckResult({ projectId: PROJECT, requestId: 'req_ok', candidateId: 'cand_ok', observedHeadSha: HEAD_A, outcome: 'passed', evidenceId: 'evid_unit_ok' });
  h.sources.recordOwnerTest({ projectId: PROJECT, requestId: 'req_ok', candidateId: 'cand_ok', criterionId: 'c-owner', observedHeadSha: HEAD_A, outcome: 'passed', evidenceId: 'evid_owner_ok' });

  const { status, home } = await readHome(h, PROJECT);
  assert.equal(status, 200);
  assert.ok(home !== null);
  assert.deepEqual(kindsOf(home.needsYou), ['DecisionAwaiting'], 'accept or request changes is outstanding');
  assert.deepEqual(home.inProgress, []);
  assert.deepEqual(kindsOf(home.readyForReview), ['CandidateReadyForReview']);
  const review = home.readyForReview[0];
  assert.equal(review?.headSha, HEAD_A, 'the full commit identifies the candidate');
  assert.equal(review?.candidateId, 'cand_ok');
  assert.deepEqual(review?.outstandingCriterionIds, [], 'every criterion has a current pass');
  assertEntryShape(home);
});

test('mvp-spec 3, F23-AC1: a pending owner test is the owner action, and the review offer still stands', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  h.contracts.add({ requestId: 'req_test', projectId: PROJECT, title: 'Checkout totals', description: 'x', revisions: [{ contractId: CONTRACT_ID, revision: 1, status: 'approved' }] });
  h.sources.seed({ candidate: candidate({ candidateId: 'cand_test', projectId: PROJECT, requestId: 'req_test', headSha: HEAD_A }), criteria: CRITERIA });
  h.sources.recordCheckResult({ projectId: PROJECT, requestId: 'req_test', candidateId: 'cand_test', observedHeadSha: HEAD_A, outcome: 'passed', evidenceId: 'evid_unit_test' });

  const { status, home } = await readHome(h, PROJECT);
  assert.equal(status, 200);
  assert.ok(home !== null);
  assert.deepEqual(kindsOf(home.needsYou), ['OwnerTestOutstanding']);
  assert.deepEqual(home.needsYou[0]?.outstandingCriterionIds, ['c-owner'], 'only the owner test is outstanding');
  assert.deepEqual(home.inProgress, [], 'an outstanding owner test is not ShipLoop-side work');
  assert.deepEqual(
    kindsOf(home.readyForReview),
    ['CandidateReadyForReview'],
    'F24-AC3: the automated evidence is current, so the candidate is offered',
  );
});

test('mvp-spec 3, F20-AC3: evidence bound to a superseded commit is not presented as ready', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  h.contracts.add({ requestId: 'req_push', projectId: PROJECT, title: 'Checkout totals', description: 'x', revisions: [{ contractId: CONTRACT_ID, revision: 1, status: 'approved' }] });
  // The candidate moved to HEAD_B, but the only recorded result names HEAD_A.
  h.sources.seed({ candidate: candidate({ candidateId: 'cand_push', projectId: PROJECT, requestId: 'req_push', headSha: HEAD_B }), criteria: CRITERIA });
  h.sources.recordCheckResult({ projectId: PROJECT, requestId: 'req_push', candidateId: 'cand_push', observedHeadSha: HEAD_A, outcome: 'passed', evidenceId: 'evid_unit_old' });

  const { status, home } = await readHome(h, PROJECT);
  assert.equal(status, 200);
  assert.ok(home !== null);
  assert.deepEqual(home.readyForReview, [], 'a green result for SHA A does not review SHA B');
  assert.deepEqual(home.needsYou, [], 'stale evidence is not an owner action yet');
  assert.deepEqual(kindsOf(home.inProgress), ['VerificationOutstanding']);
  assert.equal(home.inProgress[0]?.headSha, HEAD_B, 'the entry names the commit that still needs a result');
  assert.deepEqual(home.inProgress[0]?.outstandingCriterionIds, ['c-unit', 'c-owner']);
  assert.match(
    home.inProgress[0]?.reason ?? '',
    /different candidate/i,
    'the reason says why the recorded result no longer describes this candidate',
  );
});

test('mvp-spec 3: a failed result needs an owner decision rather than another look', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  h.contracts.add({ requestId: 'req_fail', projectId: PROJECT, title: 'Checkout totals', description: 'x', revisions: [{ contractId: CONTRACT_ID, revision: 1, status: 'approved' }] });
  h.sources.seed({ candidate: candidate({ candidateId: 'cand_fail', projectId: PROJECT, requestId: 'req_fail', headSha: HEAD_A }), criteria: CRITERIA });
  h.sources.recordCheckResult({ projectId: PROJECT, requestId: 'req_fail', candidateId: 'cand_fail', observedHeadSha: HEAD_A, outcome: 'failed', evidenceId: 'evid_unit_fail' });

  const { status, home } = await readHome(h, PROJECT);
  assert.equal(status, 200);
  assert.ok(home !== null);
  assert.deepEqual(kindsOf(home.needsYou), ['VerificationFailed']);
  assert.deepEqual(home.inProgress, [], 'a recorded failure is not work in flight');
  assert.deepEqual(home.readyForReview, [], 'and it is not offered for review');
  assert.match(home.needsYou[0]?.reason ?? '', /recorded failed/i, 'the reason quotes the recorded result, not a paraphrase');
});

test('mvp-spec 3: a check that never ran is outstanding, never a pass', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  h.contracts.add({ requestId: 'req_none', projectId: PROJECT, title: 'Checkout totals', description: 'x', revisions: [{ contractId: CONTRACT_ID, revision: 1, status: 'approved' }] });
  h.sources.seed({ candidate: candidate({ candidateId: 'cand_none', projectId: PROJECT, requestId: 'req_none', headSha: HEAD_A }), criteria: CRITERIA });
  h.sources.recordCheckResult({ projectId: PROJECT, requestId: 'req_none', candidateId: 'cand_none', observedHeadSha: HEAD_A, outcome: 'missing', evidenceId: 'evid_unit_missing' });

  const { status, home } = await readHome(h, PROJECT);
  assert.equal(status, 200);
  assert.ok(home !== null);
  assert.deepEqual(home.readyForReview, [], 'a check that did not run is not a pass');
  assert.deepEqual(kindsOf(home.needsYou), [], 'nothing here asks the owner to decide');
  assert.deepEqual(kindsOf(home.inProgress), ['VerificationOutstanding']);
});

test('mvp-spec 3: a candidate bound to a retired revision is outstanding, not an error', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  h.contracts.add({
    requestId: 'req_revised',
    projectId: PROJECT,
    title: 'Checkout totals',
    description: 'x',
    revisions: [
      { contractId: CONTRACT_ID, revision: 1, status: 'stale' },
      { contractId: CONTRACT_ID, revision: 2, status: 'approved' },
    ],
  });
  const bound = { ...candidate({ candidateId: 'cand_old', projectId: PROJECT, requestId: 'req_revised', headSha: HEAD_A }), contractRevision: 1 };
  h.sources.seed({ candidate: bound, criteria: CRITERIA });

  const { status, home } = await readHome(h, PROJECT);
  assert.equal(status, 200, 'a retired binding is a state to report, not a failure to raise');
  assert.ok(home !== null);
  assert.deepEqual(kindsOf(home.inProgress), ['VerificationOutstanding']);
  assert.deepEqual(home.readyForReview, [], 'a candidate on a retired revision is never offered');
  assert.match(home.inProgress[0]?.reason ?? '', /revision 1/, 'the reason names the revision the candidate is bound to');
});

test('mvp-spec 3: a candidate the owner already decided is on no group', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  h.contracts.add({ requestId: 'req_done', projectId: PROJECT, title: 'Checkout totals', description: 'x', revisions: [{ contractId: CONTRACT_ID, revision: 1, status: 'approved' }] });
  h.sources.seed({ candidate: candidate({ candidateId: 'cand_done', projectId: PROJECT, requestId: 'req_done', headSha: HEAD_A }), criteria: CRITERIA });
  h.sources.recordCheckResult({ projectId: PROJECT, requestId: 'req_done', candidateId: 'cand_done', observedHeadSha: HEAD_A, outcome: 'passed', evidenceId: 'evid_unit_done' });
  h.sources.recordOwnerTest({ projectId: PROJECT, requestId: 'req_done', candidateId: 'cand_done', criterionId: 'c-owner', observedHeadSha: HEAD_A, outcome: 'passed', evidenceId: 'evid_owner_done' });
  h.sources.recordDecision({ projectId: PROJECT, requestId: 'req_done', candidateId: 'cand_done', kind: 'accepted', headSha: HEAD_A, decisionId: 'dec_done' });

  const { status, home } = await readHome(h, PROJECT);
  assert.equal(status, 200);
  assert.ok(home !== null);
  assert.deepEqual(home.needsYou, [], 'an accepted candidate owes the owner nothing');
  assert.deepEqual(home.inProgress, []);
  assert.deepEqual(home.readyForReview, [], 'and it is not offered a second time');
});

test('mvp-spec 3: no entry the board can produce claims an executor is working', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  // One request per placement, so the walk covers every reason text a caller can receive
  // rather than the three this file happened to reach first.
  const approved = [{ contractId: CONTRACT_ID, revision: 1, status: 'approved' as const }];
  h.contracts.add({ requestId: 'req_bare', projectId: PROJECT, title: 'Dark mode', description: 'y', revisions: [] });
  h.contracts.add({ requestId: 'req_draft', projectId: PROJECT, title: 'Checkout totals', description: 'x', revisions: [{ contractId: CONTRACT_ID, revision: 1, status: 'draft' }] });
  h.contracts.add({ requestId: 'req_none', projectId: PROJECT, title: 'Sidebar', description: 'z', revisions: approved });
  h.contracts.add({ requestId: 'req_missing', projectId: PROJECT, title: 'Totals', description: 'x', revisions: approved });
  h.contracts.add({ requestId: 'req_failed', projectId: PROJECT, title: 'Receipts', description: 'x', revisions: approved });
  h.contracts.add({ requestId: 'req_test', projectId: PROJECT, title: 'Search', description: 'x', revisions: approved });
  h.contracts.add({ requestId: 'req_ready', projectId: PROJECT, title: 'Export', description: 'x', revisions: approved });

  const seeded: readonly { readonly requestId: string; readonly outcome: 'passed' | 'failed' | 'missing'; readonly ownerTest?: 'passed' }[] = [
    { requestId: 'req_missing', outcome: 'missing' },
    { requestId: 'req_failed', outcome: 'failed' },
    { requestId: 'req_test', outcome: 'passed' },
    { requestId: 'req_ready', outcome: 'passed', ownerTest: 'passed' },
  ];
  for (const entry of seeded) {
    h.sources.seed({
      candidate: candidate({ candidateId: `cand_${entry.requestId}`, projectId: PROJECT, requestId: entry.requestId, headSha: HEAD_A }),
      criteria: CRITERIA,
    });
    h.sources.recordCheckResult({
      projectId: PROJECT,
      requestId: entry.requestId,
      candidateId: `cand_${entry.requestId}`,
      observedHeadSha: HEAD_A,
      outcome: entry.outcome,
      evidenceId: `evid_unit_${entry.requestId}`,
    });
    if (entry.ownerTest !== undefined) {
      h.sources.recordOwnerTest({
        projectId: PROJECT,
        requestId: entry.requestId,
        candidateId: `cand_${entry.requestId}`,
        criterionId: 'c-owner',
        observedHeadSha: HEAD_A,
        outcome: entry.ownerTest,
        evidenceId: `evid_owner_${entry.requestId}`,
      });
    }
  }

  const { status, home } = await readHome(h, PROJECT);
  assert.equal(status, 200);
  assert.ok(home !== null);
  // Every kind the projection can produce appears exactly once below, so the walk is total.
  assert.deepEqual(kindsOf(home.needsYou), [
    'ContractNotWritten',
    'ContractAwaitingApproval',
    'VerificationFailed',
    'OwnerTestOutstanding',
    'DecisionAwaiting',
  ]);
  assert.deepEqual(kindsOf(home.inProgress), ['CandidateNotLinked', 'VerificationOutstanding']);
  assert.deepEqual(kindsOf(home.readyForReview), ['CandidateReadyForReview', 'CandidateReadyForReview']);
  assertNoExecutionClaim(home);
  assertEntryShape(home);
});

test('F01-AC1: the home projection refuses an anonymous caller and discloses nothing', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await h.app.inject({ method: 'GET', url: `/api/projects/${PROJECT}/home` });
  assert.equal(response.statusCode, 401);
  const body = parse<{ readonly signInRequired?: boolean }>(response);
  assert.equal(body.signInRequired, true);
  assert.equal(response.body.includes('home'), false, 'the refusal names no projection content');
});

test('F02-AC2: one project home never answers with another project facts', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  h.contracts.add({ requestId: 'req_other', projectId: OTHER_PROJECT, title: 'Docs site', description: 'x', revisions: [{ contractId: 'dc_other_1', revision: 1, status: 'draft' }] });

  const mine = await readHome(h, PROJECT);
  assert.equal(mine.status, 200);
  assert.ok(mine.home !== null);
  assert.deepEqual(mine.home.needsYou, [], "another project's draft is not mine");
  assert.equal(mine.raw.includes('req_other'), false);
  assert.equal(mine.raw.includes('Docs site'), false);

  const theirs = await readHome(h, OTHER_PROJECT);
  assert.equal(theirs.status, 200);
  assert.ok(theirs.home !== null);
  assert.deepEqual(kindsOf(theirs.home.needsYou), ['ContractAwaitingApproval']);
  assert.equal(theirs.home.needsYou[0]?.requestId, 'req_other');
});

test('F02-AC4: a project id that is a path is refused rather than addressed', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await h.app.inject({
    method: 'GET',
    url: `/api/projects/${encodeURIComponent('../other')}/home`,
    headers: { cookie: h.cookie },
  });
  assert.equal(response.statusCode, 400);
  const body = parse<{ readonly error: { readonly code: string; readonly fields?: readonly { readonly path: string }[] } }>(response);
  assert.equal(body.error.code, 'Invalid');
  assert.deepEqual(body.error.fields?.map((field) => field.path), ['projectId']);
});

test('F01-AC1: a deployment with no candidate or review projection refuses rather than answering empty', async (t) => {
  const h = await harness({ sources: null });
  t.after(() => h.close());

  const response = await h.app.inject({
    method: 'GET',
    url: `/api/projects/${PROJECT}/home`,
    headers: { cookie: h.cookie },
  });
  assert.equal(response.statusCode, 503);
  const body = parse<{ readonly error: { readonly code: string; readonly message: string } }>(response);
  assert.equal(body.error.code, 'Unavailable');
  assert.match(body.error.message, /cannot be composed/i);
});

test('N02-AC1: a refusal from the candidate read is not hidden behind a shorter board', async (t) => {
  const contracts = new SeededContracts();
  contracts.add({ requestId: 'req_x', projectId: PROJECT, title: 'Checkout totals', description: 'x', revisions: [{ contractId: CONTRACT_ID, revision: 1, status: 'approved' }] });

  const now = (): Date => new Date(START);
  const record = storedSession(now);
  const controller: ControllerSurface = {
    owners: { provision: () => notImplemented('owners.provision'), signIn: () => notImplemented('owners.signIn'), describe: () => notImplemented('owners.describe'), selectActiveProject: () => notImplemented('owners.selectActiveProject') },
    projects: PROJECTS,
    contracts: contractUseCases(contracts),
    sessions: sessionUseCases(record),
    profiles: { saveVersion: () => notImplemented('p'), currentVersion: () => notImplemented('p'), listVersions: () => notImplemented('p') },
    connectors: { register: () => notImplemented('c'), listForProject: () => notImplemented('c'), revoke: () => notImplemented('c') },
    intake: new Proxy({} as ControllerSurface['intake'], { get: () => () => notImplemented('intake') }),
    runs: new Proxy({} as ControllerSurface['runs'], { get: () => () => notImplemented('runs') }),
    attention: new Proxy({} as ControllerSurface['attention'], { get: () => () => notImplemented('attention') }),
    reviewCards: new Proxy({} as ControllerSurface['reviewCards'], { get: () => () => notImplemented('reviewCards') }),
    acceptance: new Proxy({} as ControllerSurface['acceptance'], { get: () => () => notImplemented('acceptance') }),
    ownerTests: new Proxy({} as ControllerSurface['ownerTests'], { get: () => () => notImplemented('ownerTests') }),
    handoff: new Proxy({} as ControllerSurface['handoff'], { get: () => () => notImplemented('handoff') }),
    // The home projection reads none of these; it derives its board from the contract, candidate
    // and review groups. They are stubbed through the same Proxy the neighbouring groups use, rather
    // than omitted, so this double still has to satisfy the whole surface. `mvpReview` is here for
    // that reason alone: the board composes its own projection through `sources`, and the review
    // card routes are not exercised here at all.
    mvpReview: new Proxy({} as ControllerSurface['mvpReview'], { get: () => () => notImplemented('mvpReview') }),
    settings: new Proxy({} as ControllerSurface['settings'], { get: () => () => notImplemented('settings') }),
    planning: new Proxy({} as ControllerSurface['planning'], { get: () => () => notImplemented('planning') }),
    generation: new Proxy({} as ControllerSurface['generation'], { get: () => () => notImplemented('generation') }),
  };

  const app = await buildApp({
    config: testConfig(),
    controller,
    now,
    homeSources: {
      recordedCandidate: async () => ({ ok: false, error: { code: 'Unavailable', reason: 'The candidate store is unavailable.' } }),
      reviewReadModel: async () => notImplemented('reviewReadModel'),
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: `/api/projects/${PROJECT}/home`,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` },
  });
  assert.equal(response.statusCode, 503, 'a board that dropped the unreadable request would be a lie about it');
  const body = parse<{ readonly error: { readonly code: string } }>(response);
  assert.equal(body.error.code, 'Unavailable');
});
