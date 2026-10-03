/**
 * Route-level tests for the Review Card and the owner decision (mvp-spec 3, F24, F25).
 *
 * Every request goes through `app.inject()`, so the plugin tree, the session guard, the CSRF
 * check, the parameter schemas, the security headers and the error-to-status mapping are the
 * real ones. The route handlers themselves are the shipped ones.
 *
 * What is substituted, and why it is still real proof: the controller group is a double,
 * because `packages/controller` is developed independently of this server. But behind that
 * group sits the *actual* `createMvpReviewCardUseCases` over the *actual* SQLite repositories,
 * and behind those the domain's own `buildMvpReviewReadModel`. So the staleness, the
 * eligibility, the binding of a decision to one commit and the refusal codes in these
 * assertions are the ones the product produces — a test cannot make a stale candidate look
 * ready by asserting it is ready, and it cannot pass while the wire rename this route exists to
 * make unambiguous is absent.
 *
 * Two facts about the seam are stated rather than hidden:
 *
 *   - **Evidence and owner tests are seeded through the review store.** No HTTP route records
 *     one in the minimal MVP, so the owner test a fixture needs is written through
 *     `SqliteMvpReviewStore` — the same seam a future evidence producer will use. A test that
 *     reached for a route to satisfy a criterion would be asserting a route exists.
 *   - **The head is moved by appending a candidate observation**, which is what a push is on
 *     this schema: a new candidate identity at a new commit. The old commit's evidence and its
 *     acceptance therefore describe a candidate that is no longer the one under review, which is
 *     exactly the state F25-AC3 is about.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  SESSION_COOKIE_NAME,
  approveContract,
  asCommitSha,
  createContractDraft,
  createRequest,
  deriveCsrfToken,
  fingerprint,
  hashSessionToken,
  ok,
  recordMvpEvidence,
  recordMvpOwnerDecision,
  sessionDeadlines,
  type CommitSha,
  type DomainError,
  type MvpOwnerDecision,
  type MvpRecordedEvidence,
  type OwnerId,
  type ProjectId,
  type RequestId,
  type Result,
} from '@shiploop/domain';
import type { ContractId, CandidateId } from '@shiploop/domain';
import {
  ContractRepository,
  DeliveryCandidateRepository,
  OwnerRepository,
  ProjectRepository,
  RequestRepository,
  SqliteMvpReviewStore,
  migrate,
  openDatabase,
} from '@shiploop/storage';
import type { Database, MvpReviewStore } from '@shiploop/storage';
import { createMvpReviewCardUseCases, type MvpReviewCard } from '@shiploop/controller';

import { buildApp } from '../app.ts';
import { CSRF_HEADER } from '../auth-guard.ts';
import { readServerConfig, type ServerConfig } from '../config.ts';
import type { ControllerSurface, SessionUseCases, StoredSessionRecord } from '../contracts.ts';
import type { ReviewCardRouteSources } from './review.ts';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

const CSRF_SECRET = ['server', 'secret', 'material', '0123456789abcdef'].join('-');
const START = '2026-10-03T12:00:00.000Z';
const LATER = '2026-10-03T13:00:00.000Z';
const LATEST = '2026-10-03T14:00:00.000Z';

const OWNER_ID = 'owner-0000-4000-8000-00000000000c' as OwnerId;
const IMPERSONATED = 'owner-9999-4000-8000-0000000000ff' as OwnerId;

const PROJECT = 'octopus-main';
const OTHER_PROJECT = 'octopus-docs';
const REQUEST_ID = 'req_checkout_totals' as RequestId;
const CONTRACT_ID = 'dc_octopus_main_1' as ContractId;
const BASE_SHA = asCommitSha('0f0f0f0f'.repeat(5));
const HEAD_A = asCommitSha('a1b2c3d4'.repeat(5));
const HEAD_B = asCommitSha('f0e1d2c3'.repeat(5));
const HEAD_C = asCommitSha('11aabbcc'.repeat(5));

const TOKEN = 'review-route-test-token';
const SESSION_ID = 'sess_review_test';

/**
 * An owner-test-only contract.
 *
 * The MVP contract record carries no assignment of a criterion to a check, so an automated
 * criterion would read `unverified` forever — nothing is bound to it — and no candidate would
 * ever reach acceptance. The criterion set here is therefore the owner test alone, which is the
 * one criterion the MVP transport can actually discharge, and it makes the pending → passed
 * transition the thing under test.
 */
const OWNER_CRITERION = {
  id: 'AC-OWNER',
  description: 'Sign in and land on the dashboard.',
  verificationType: 'owner_test' as const,
};

const AUTOMATED_CRITERION = {
  id: 'AC-UNIT',
  description: 'The automated suite passes.',
  verificationType: 'automated' as const,
};

interface Seed {
  readonly candidateId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly projectId: string;
}

function testConfig(): ServerConfig {
  const result = readServerConfig({
    SHIPLOOP_NODE_ENV: 'test',
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_LOG_LEVEL: 'silent',
    // The fixtures' instants span hours, and the idle limit has to exceed that span or the
    // session would be refused for idleness rather than for anything these tests are about.
    SHIPLOOP_SESSION_IDLE_SECONDS: '86400',
  });
  if (!result.ok) throw new Error(`Test configuration is invalid: ${JSON.stringify(result.errors)}`);
  return result.value;
}

function expectOk<T>(result: Result<T, DomainError>): T {
  if (!result.ok) assert.fail(`expected success but received ${result.error.code}: ${result.error.reason}`);
  return result.value;
}

interface Injected {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: NodeJS.Dict<string | string[] | number | undefined>;
}

function parse<T>(response: Injected): T {
  return JSON.parse(response.body) as T;
}

/* -------------------------------------------------------------------------- */
/* The harness                                                                 */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly db: Database;
  readonly review: SqliteMvpReviewStore;
  /** Appends what a push is on this schema: a new candidate identity at a new commit. */
  readonly push: (seed: Seed, candidateId: string, headSha: CommitSha) => void;
  /** Discharges the owner-test criterion, the way a future evidence producer would. */
  readonly recordOwnerTest: (input: {
    readonly seed: Seed;
    readonly candidateId: string;
    readonly headSha: CommitSha;
    readonly outcome: 'passed' | 'failed';
    readonly evidenceId: string;
  }) => void;
  /** Records an automated observation against a commit, current or superseded. */
  readonly recordCheck: (input: {
    readonly seed: Seed;
    readonly candidateId: string;
    readonly checkId: string;
    readonly observedHeadSha: CommitSha | null;
    readonly outcome: 'passed' | 'failed' | 'missing';
    readonly evidenceId: string;
  }) => void;
  /**
   * Makes a row bound to a superseded commit visible to the *read* only.
   *
   * The declared seam described above `review`: `SqliteMvpReviewStore` scopes a projection to
   * one `candidate_id`, and a push mints a new one, so the durable store cannot by itself hand
   * the projection a superseded commit's evidence or its owner's acceptance. Those two states
   * are precisely what F20-AC3 and F25-AC3 exist to prevent being rendered as current, so the
   * wire shape for them is pinned here. Nothing is written; only the read is widened.
   */
  readonly attachSuperseded: (input: {
    readonly seed: Seed;
    readonly candidateId: string;
    readonly supersededHeadSha: CommitSha;
    readonly evidence?: { readonly evidenceId: string; readonly checkId: string; readonly outcome: 'passed' | 'failed' };
    readonly decision?: { readonly decisionId: string; readonly kind: 'accepted' | 'changes_requested'; readonly feedback: string | null };
  }) => void;
  readonly cookie: string;
  readonly csrfToken: string;
  readonly close: () => Promise<void>;
}

function seed(
  db: Database,
  options: {
    readonly projectId?: ProjectId;
    readonly requestId: RequestId;
    readonly contractId: ContractId;
    readonly candidateId: CandidateId;
    readonly headSha?: CommitSha;
    readonly criteria?: readonly {
      readonly id: string;
      readonly description: string;
      readonly verificationType: 'automated' | 'owner_test';
    }[];
  },
): Seed {
  const projects = new ProjectRepository(db);
  const projectId = options.projectId ?? (PROJECT as ProjectId);
  expectOk(projects.create({ projectId, name: `Project ${projectId}`, at: START }));
  // The revision records its author and that column is a foreign key into `owners`, so the row
  // has to exist before the fixture means anything.
  expectOk(new OwnerRepository(db).provision(OWNER_ID, 'Octopus Owner', START));

  const request = expectOk(
    createRequest({
      requestId: options.requestId,
      projectId,
      title: 'Checkout totals',
      description: 'The cart shows the right total.',
      at: START,
    }),
  );
  expectOk(new RequestRepository(db).create(request));

  const draft = expectOk(
    createContractDraft({
      contractId: options.contractId,
      projectId,
      requestId: options.requestId,
      revision: 1,
      content: {
        outcome: 'The cart shows the total including tax.',
        scope: ['Sum the line items before tax'],
        outOfScope: ['Changing the tax rate'],
        acceptanceCriteria: options.criteria ?? [OWNER_CRITERION],
      },
      requestFingerprint: fingerprint({
        projectId,
        title: request.title,
        description: request.description,
        sourceIdeaId: request.sourceIdeaId,
      }),
      createdBy: OWNER_ID,
      at: START,
    }),
  );
  const contracts = new ContractRepository(db);
  expectOk(contracts.createDraft(draft));
  const approved = expectOk(approveContract(draft, { approvedBy: OWNER_ID, at: LATER }));
  expectOk(contracts.approve(approved, draft.updatedAt));

  const head = options.headSha ?? HEAD_A;
  expectOk(
    new DeliveryCandidateRepository(db).record({
      candidateId: options.candidateId,
      projectId,
      requestId: options.requestId,
      contractId: options.contractId,
      contractRevision: 1,
      provider: 'github',
      repository: 'acme/web',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.invalid/acme/web/pull/42',
      baseBranch: 'main',
      baseSha: BASE_SHA,
      headBranch: 'feature/checkout',
      headSha: head,
      headRepository: 'acme',
      pullRequestState: 'Open',
      draft: false,
      observedAt: START,
      correlationId: 'seed-correlation',
    }),
  );

  return {
    candidateId: options.candidateId,
    requestId: options.requestId,
    contractId: options.contractId,
    projectId,
  };
}

async function harness(options: { readonly sources?: 'real' | null } = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-review-route-'));
  const opened = openDatabase(join(directory, 'review-route.sqlite'));
  assert.ok(opened.ok);
  const db = opened.value;
  expectOk(migrate(db));

  const durable = new SqliteMvpReviewStore(db);

  /**
   * The store the use cases read, delegating to the durable one.
   *
   * `SqliteMvpReviewStore.readProjection` filters rows by `candidate_id`, and a push mints a
   * *new* candidate identity, so on this schema it cannot hand the projection a row bound to a
   * superseded commit. The wire contract for that state is exactly what F20-AC3 and F25-AC3 are
   * about, so it has to be pinned here rather than skipped. `attachSupersededRow` is that seam
   * and it is declared, not hidden: it adds rows to what the *read* returns and writes nothing,
   * so every other case still runs against the durable store alone.
   */
  let attached: { readonly evidence: readonly MvpRecordedEvidence[]; readonly decisions: readonly MvpOwnerDecision[] } = {
    evidence: [],
    decisions: [],
  };
  const review: MvpReviewStore = {
    recordEvidence: (input) => durable.recordEvidence(input),
    recordDecision: (input) => durable.recordDecision(input),
    readProjection: (input) => {
      const read = durable.readProjection(input);
      if (!read.ok) return read;
      return ok({
        evidence: [...read.value.evidence, ...attached.evidence],
        decisions: [...read.value.decisions, ...attached.decisions],
      });
    },
  };

  let instant = LATER;
  let decisions = 0;
  const useCases = createMvpReviewCardUseCases({
    clock: { now: () => instant },
    requests: new RequestRepository(db),
    contracts: new ContractRepository(db),
    candidates: new DeliveryCandidateRepository(db),
    review,
    newDecisionId: () => `dec-${(decisions += 1)}`,
    newCorrelationId: () => `corr-${(decisions += 1)}`,
  });

  // The port the routes consume is the real use-case object, not a hand-written stand-in. If
  // the route's declared port ever drifts from what the composition produces, this assignment
  // stops compiling rather than the drift reaching a client.
  const sources: ReviewCardRouteSources = {
    getReview: (command) => useCases.getReview(command),
    decide: (command) =>
      useCases.decide({
        projectId: command.projectId,
        candidateId: command.candidateId,
        actor: command.actor,
        decision: command.decision,
        expectedHeadSha: command.expectedHeadSha,
        expectedContractRevision: command.expectedContractRevision,
        feedback: command.feedback,
      }),
  };

  const app = await buildApp({
    config: testConfig(),
    controller: surfaceWith(sessions()),
    now: () => new Date(instant),
    reviewSources: options.sources === null ? null : sources,
  });

  const push = (existing: Seed, candidateId: string, headSha: CommitSha): void => {
    expectOk(
      new DeliveryCandidateRepository(db).record({
        candidateId: candidateId as CandidateId,
        projectId: existing.projectId as ProjectId,
        requestId: existing.requestId,
        contractId: existing.contractId,
        contractRevision: 1,
        provider: 'github',
        repository: 'acme/web',
        pullRequestNumber: 42,
        pullRequestUrl: 'https://example.invalid/acme/web/pull/42',
        baseBranch: 'main',
        baseSha: BASE_SHA,
        headBranch: 'feature/checkout',
        headSha,
        headRepository: 'acme',
        pullRequestState: 'Open',
        draft: false,
        observedAt: LATEST,
        correlationId: 'push-correlation',
      }),
    );
  };

  const recordOwnerTest = (input: {
    readonly seed: Seed;
    readonly candidateId: string;
    readonly headSha: CommitSha;
    readonly outcome: 'passed' | 'failed';
    readonly evidenceId: string;
  }): void => {
    const recorded = recordMvpEvidence({
      evidenceId: input.evidenceId,
      contractId: input.seed.contractId,
      candidateId: input.candidateId,
      subject: { kind: 'criterion', criterionId: OWNER_CRITERION.id },
      method: { kind: 'OwnerTest', instructions: OWNER_CRITERION.description },
      observation: { kind: 'owner_test', outcome: input.outcome, actor: { role: 'owner', ownerId: OWNER_ID } },
      observedHeadSha: input.headSha,
      observedContractRevision: 1,
      observedAt: LATEST,
      detail: null,
      artifactRef: null,
    });
    assert.ok(recorded.ok, `the seeded owner test must be recordable: ${recorded.ok ? '' : recorded.error.reason}`);
    const written = review.recordEvidence({
      evidence: recorded.value,
      projectId: input.seed.projectId,
      requestId: input.seed.requestId,
      candidateId: input.candidateId,
      candidateHeadSha: input.headSha,
      contractId: input.seed.contractId,
      contractRevision: 1,
      recordedAt: LATEST,
      correlationId: 'owner-test-correlation',
      owner: { role: 'owner', ownerId: OWNER_ID },
    });
    assert.ok(written.ok, `the owner test must be writable: ${written.ok ? '' : written.error.reason}`);
  };

  const recordCheck = (input: {
    readonly seed: Seed;
    readonly candidateId: string;
    readonly checkId: string;
    readonly observedHeadSha: CommitSha | null;
    readonly outcome: 'passed' | 'failed' | 'missing';
    readonly evidenceId: string;
  }): void => {
    const recorded = recordMvpEvidence({
      evidenceId: input.evidenceId,
      contractId: input.seed.contractId,
      candidateId: input.candidateId,
      subject: { kind: 'check', checkId: input.checkId },
      method: { kind: 'AutomatedCheck', checkId: input.checkId },
      observation: { kind: 'command', outcome: input.outcome },
      observedHeadSha: input.observedHeadSha,
      observedContractRevision: input.observedHeadSha === null ? null : 1,
      observedAt: LATEST,
      detail: null,
      artifactRef: null,
    });
    assert.ok(recorded.ok, `the seeded check must be recordable: ${recorded.ok ? '' : recorded.error.reason}`);
    const written = review.recordEvidence({
      evidence: recorded.value,
      projectId: input.seed.projectId,
      requestId: input.seed.requestId,
      candidateId: input.candidateId,
      candidateHeadSha: input.observedHeadSha ?? HEAD_C,
      contractId: input.seed.contractId,
      contractRevision: 1,
      recordedAt: LATEST,
      correlationId: 'check-correlation',
      owner: null,
    });
    assert.ok(written.ok, `the check must be writable: ${written.ok ? '' : written.error.reason}`);
  };

  const attachSuperseded = (input: {
    readonly seed: Seed;
    readonly candidateId: string;
    readonly supersededHeadSha: CommitSha;
    readonly evidence?: { readonly evidenceId: string; readonly checkId: string; readonly outcome: 'passed' | 'failed' };
    readonly decision?: {
      readonly decisionId: string;
      readonly kind: 'accepted' | 'changes_requested';
      readonly feedback: string | null;
    };
  }): void => {
    const evidence: MvpRecordedEvidence[] = [];
    if (input.evidence !== undefined) {
      const recorded = recordMvpEvidence({
        evidenceId: input.evidence.evidenceId,
        contractId: input.seed.contractId,
        candidateId: input.candidateId,
        subject: { kind: 'check', checkId: input.evidence.checkId },
        method: { kind: 'AutomatedCheck', checkId: input.evidence.checkId },
        observation: { kind: 'command', outcome: input.evidence.outcome },
        observedHeadSha: input.supersededHeadSha,
        observedContractRevision: 1,
        observedAt: LATER,
        detail: null,
        artifactRef: null,
      });
      assert.ok(recorded.ok, `the attached evidence must be recordable: ${recorded.ok ? '' : recorded.error.reason}`);
      evidence.push(recorded.value);
    }
    const decisions: MvpOwnerDecision[] = [];
    if (input.decision !== undefined) {
      const recorded = recordMvpOwnerDecision({
        decisionId: input.decision.decisionId,
        kind: input.decision.kind,
        actor: { role: 'owner', ownerId: OWNER_ID },
        projectId: input.seed.projectId,
        requestId: input.seed.requestId,
        contractId: input.seed.contractId,
        contractRevision: 1,
        candidateId: input.candidateId,
        candidateHeadSha: input.supersededHeadSha,
        decidedAt: LATER,
        feedback: input.decision.feedback,
      });
      assert.ok(recorded.ok, `the attached decision must be recordable: ${recorded.ok ? '' : recorded.error.reason}`);
      decisions.push(recorded.value);
    }
    attached = {
      evidence: [...attached.evidence, ...evidence],
      decisions: [...attached.decisions, ...decisions],
    };
  };

  return {
    app,
    db,
    review: durable,
    push,
    recordOwnerTest,
    recordCheck,
    attachSuperseded,
    cookie: `${SESSION_COOKIE_NAME}=${TOKEN}`,
    csrfToken: deriveCsrfToken(SESSION_ID, CSRF_SECRET),
    close: async () => {
      await app.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The controller double                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The session the guard reads.
 *
 * Only a digest is stored, matching F01-AC2: the plaintext below is what the test puts on the
 * wire and the row holds nothing else about it.
 */
function storedSession(): StoredSessionRecord {
  // Both deadlines are a day out. The fixtures' instants span hours, and `sessionDeadlines`
  // takes the *earlier* of the two as the effective expiry — a session that expires exactly at
  // the clock these tests run on would be refused for its own age rather than for anything
  // under test.
  const deadlines = sessionDeadlines({
    issuedAt: START,
    absoluteTtlSeconds: 24 * 60 * 60,
    idleTimeoutSeconds: 24 * 60 * 60,
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

function sessions(): SessionUseCases {
  const record = storedSession();
  const refuse = <T>(what: string): Promise<Result<T, DomainError>> =>
    Promise.resolve({ ok: false, error: { code: 'Unavailable', reason: `The review-route double does not implement ${what}.` } });
  return {
    loadByToken: async (token) =>
      hashSessionToken(token) === record.tokenDigest
        ? ok(record)
        : { ok: false, error: { code: 'NotFound', reason: 'No session matches this token (F01-AC2).' } },
    create: () => refuse('sessions.create'),
    revoke: () => refuse('sessions.revoke'),
    touch: async () => ok(null),
  };
}

/** A group this route never calls, refusing by name rather than pretending. */
function absent(group: string): Promise<Result<never, DomainError>> {
  return Promise.resolve({
    ok: false,
    error: { code: 'Unavailable', reason: `The review-route double does not implement ${group}.` },
  });
}

/**
 * The controller surface, with only the session group real.
 *
 * Every other group is a `Proxy` that refuses by name, so an accidental call from the review
 * routes surfaces as a named refusal instead of an `undefined is not a function` 500 — and so
 * adding a group to the shared surface does not require touching this file.
 */
function surfaceWith(sessionUseCases: SessionUseCases): ControllerSurface {
  const unused = <T extends object>(group: string): T => new Proxy({} as T, { get: () => () => absent(group) });
  return {
    owners: unused('owners'),
    projects: unused('projects'),
    contracts: unused('contracts'),
    sessions: sessionUseCases,
    profiles: unused('profiles'),
    connectors: unused('connectors'),
    intake: unused('intake'),
    runs: unused('runs'),
    attention: unused('attention'),
    reviewCards: unused('reviewCards'),
    acceptance: unused('acceptance'),
    ownerTests: unused('ownerTests'),
    planning: unused('planning'),
    generation: unused('generation'),
  };
}

/* -------------------------------------------------------------------------- */
/* Request helpers                                                             */
/* -------------------------------------------------------------------------- */

function reviewUrl(projectId: string, candidateId: string, suffix = 'review'): string {
  return `/api/projects/${projectId}/candidates/${candidateId}/${suffix}`;
}

function read(
  h: Harness,
  input: { readonly projectId?: string; readonly candidateId: string; readonly headers?: Record<string, string> } = {
    candidateId: '',
  },
): Promise<Injected> {
  return h.app.inject({
    method: 'GET',
    url: reviewUrl(input.projectId ?? PROJECT, input.candidateId),
    headers: { cookie: h.cookie, ...(input.headers ?? {}) },
  });
}

function decide(
  h: Harness,
  input: {
    readonly candidateId: string;
    readonly payload: unknown;
    readonly projectId?: string;
    readonly headers?: Record<string, string>;
  },
): Promise<Injected> {
  return h.app.inject({
    method: 'POST',
    url: reviewUrl(input.projectId ?? PROJECT, input.candidateId, 'decision'),
    headers: { cookie: h.cookie, [CSRF_HEADER]: h.csrfToken, 'content-type': 'application/json', ...(input.headers ?? {}) },
    payload: input.payload as object,
  });
}

function cardOf(response: Injected): MvpReviewCard {
  const parsed = parse<{ review?: MvpReviewCard }>(response);
  assert.ok(parsed.review !== undefined, `the response must carry the card: ${response.body}`);
  return parsed.review;
}

/** A valid body, so a case only has to state the field it is actually about. */
function decisionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: 'changes_requested',
    expectedHeadSha: HEAD_A,
    expectedContractRevision: 1,
    feedback: 'The total ignores the shipping line.',
    ...overrides,
  };
}

const STANDARD_SEED = {
  requestId: REQUEST_ID,
  contractId: CONTRACT_ID,
  candidateId: 'cand_checkout_a' as CandidateId,
};

/* -------------------------------------------------------------------------- */
/* The card                                                                    */
/* -------------------------------------------------------------------------- */

test('mvp-spec 3: the card carries every element the review screen reads', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);

  const response = await read(h, { candidateId: stored.candidateId });
  assert.equal(response.statusCode, 200, response.body);
  const card = cardOf(response);

  assert.equal(card.request.requestId, REQUEST_ID);
  assert.equal(card.request.title, 'Checkout totals');
  assert.equal(card.contract.contractId, CONTRACT_ID);
  assert.equal(card.contract.revision, 1, 'the contract revision is named, not inferred');
  assert.equal(card.contract.status, 'approved');
  assert.equal(card.candidate.candidateId, stored.candidateId);
  assert.equal(card.candidate.headSha, HEAD_A, 'the card names the full commit');
  assert.equal(card.candidate.pullRequestState, 'Open', "GitHub's own state travels rather than being inferred");
  assert.equal(card.candidate.repository, 'acme/web');
  assert.deepEqual(
    card.criteria.map((criterion) => criterion.criterionId),
    [OWNER_CRITERION.id],
    'every acceptance criterion of the revision is present',
  );
  assert.deepEqual(card.evidence, [], 'no observation has been recorded yet');
  assert.equal(card.ownerTests.length, 1, 'the owner test is the owner\'s own step, listed as such');
  assert.equal(card.staleness.stale, false);
  assert.equal(card.decision.outcome, 'none');
  assert.deepEqual(card.decision.staleDecisions, []);
  assert.equal(card.eligibility.readyForOwnerReview, true);
  assert.equal(card.eligibility.readyForAcceptance, false, 'a pending owner test does not satisfy acceptance');
});

test('F20-AC3: a stale observation is reported as history, and cannot read as a current pass', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, {
    ...STANDARD_SEED,
    criteria: [AUTOMATED_CRITERION, OWNER_CRITERION],
  });

  // A green unit run against the commit that has since been replaced, on the candidate whose
  // head has moved. The read seam attaches it because the durable store scopes a projection to
  // one candidate identity and a push mints a new one.
  h.push(stored, 'cand_checkout_b', HEAD_B);
  h.recordCheck({
    seed: stored,
    candidateId: 'cand_checkout_b',
    checkId: 'unit',
    observedHeadSha: HEAD_A,
    outcome: 'passed',
    evidenceId: 'evid-unit-a',
  });

  const card = cardOf(await read(h, { candidateId: 'cand_checkout_b' }));
  assert.equal(card.candidate.headSha, HEAD_B, 'the card is for the candidate it was asked about');

  const row = card.evidence.find((entry) => entry.evidenceId === 'evid-unit-a');
  assert.ok(row !== undefined, `the superseded observation must still be visible: ${JSON.stringify(card.evidence)}`);

  // The three fields a reader must not confuse, asserted separately because the whole point
  // is that they can be.
  assert.equal(row.recordedOutcome, 'passed', 'what the source said at the time is kept verbatim');
  assert.equal(row.currentOutcome, 'stale', 'and it does not describe this candidate');
  assert.equal(row.countsForCurrentCandidate, false, 'the affirmative flag says so independently of the outcome');
  assert.equal(row.candidateHeadSha, HEAD_A, 'and the row says which commit it was about');
  assert.ok(row.staleReasons.length > 0, 'with the reason it stopped counting');

  // The bare name the domain read model uses is deliberately absent from the wire: a client
  // that reaches for `outcome` must find nothing rather than a value it could render green.
  assert.equal(
    Object.prototype.hasOwnProperty.call(row, 'outcome'),
    false,
    'no evidence row may expose a bare `outcome`: it is the field a UI reads by mistake (F20-AC3, F24-AC3)',
  );

  assert.equal(card.staleness.stale, true);
  assert.deepEqual(card.staleness.staleEvidenceIds, ['evid-unit-a']);

  // The check itself is the row a client renders, and it reads stale — never `passed`.
  const check = card.checks.find((entry) => entry.checkId === 'unit');
  assert.equal(check?.result, 'stale', 'a check bound to a replaced commit is stale, not a pass (F20-AC2)');
  // `blocking` is false only because the default MVP policy names no required check ids, so no
  // observed check is in the gate list. That is the policy speaking, not the result: `result`
  // is the field a client must read, and it says `stale`.
  assert.equal(check?.required, false, 'the default policy requires no automated check');
  assert.notEqual(check?.result, 'passed', 'whatever the gate list says, a stale check is not a pass');

  // The automated criterion reads `unverified` rather than `stale`, and the reason matters: the
  // MVP contract record carries no assignment of a criterion to a check, so nothing is bound to
  // it at all. Inferring a binding from the check that happened to pass is exactly what F23-AC1
  // forbids, so the honest reading is the unassigned one — and it is not a pass either way.
  const criterion = card.criteria.find((entry) => entry.criterionId === AUTOMATED_CRITERION.id);
  assert.equal(
    criterion?.state,
    'unverified',
    'an automated criterion nothing is bound to reads unverified, not passed (F23-AC1)',
  );
  assert.equal(criterion?.verificationCheckId, null, 'and no verifier is invented for it');
  assert.match(criterion?.reason ?? '', /nothing observed|unverified/i);
});

test('F25-AC3: a superseded acceptance is reported to the owner, not silently dropped', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);

  // The owner accepted the commit that has since been replaced.
  h.push(stored, 'cand_checkout_b', HEAD_B);
  h.attachSuperseded({
    seed: stored,
    candidateId: 'cand_checkout_b',
    supersededHeadSha: HEAD_A,
    decision: { decisionId: 'dec-superseded', kind: 'accepted', feedback: null },
  });

  const card = cardOf(await read(h, { candidateId: 'cand_checkout_b' }));
  assert.equal(card.candidate.headSha, HEAD_B);
  assert.equal(card.decision.outcome, 'none', 'a superseded acceptance governs nothing');
  assert.equal(card.decision.decision, null);
  assert.equal(
    card.decision.authorizesCurrentCandidate,
    false,
    'and it authorises nothing either: accepted is a claim about one exact commit (F25-AC3, F27-AC3)',
  );
  assert.equal(card.decision.staleDecisions.length, 1, 'the owner still sees that they accepted something');
  const stale = card.decision.staleDecisions[0];
  assert.equal(stale?.decisionId, 'dec-superseded');
  assert.equal(stale?.kind, 'accepted');
  assert.equal(stale?.candidateHeadSha, HEAD_A, 'named with the commit it was about');
  assert.equal(stale?.contractRevision, 1);
  assert.ok(stale !== undefined && stale.reason.length > 0, 'with the reason it stopped applying');
  assert.deepEqual(card.staleness.staleDecisionIds, ['dec-superseded']);
  assert.ok(
    card.eligibility.deliveryBlockers.some((blocker) => blocker.includes('dec-superseded')),
    `delivery is blocked by name rather than by a count: ${JSON.stringify(card.eligibility.deliveryBlockers)}`,
  );
});

test('F20-AC3: a current observation and a stale one are distinguishable on the wire', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, {
    ...STANDARD_SEED,
    criteria: [AUTOMATED_CRITERION, OWNER_CRITERION],
  });

  h.push(stored, 'cand_checkout_b', HEAD_B);
  h.recordCheck({
    seed: stored,
    candidateId: 'cand_checkout_b',
    checkId: 'unit',
    observedHeadSha: HEAD_B,
    outcome: 'passed',
    evidenceId: 'evid-unit-new',
  });
  h.attachSuperseded({
    seed: stored,
    candidateId: 'cand_checkout_b',
    supersededHeadSha: HEAD_A,
    evidence: { evidenceId: 'evid-unit-old', checkId: 'unit', outcome: 'failed' },
  });

  const card = cardOf(await read(h, { candidateId: 'cand_checkout_b' }));
  const current = card.evidence.find((entry) => entry.evidenceId === 'evid-unit-new');
  const superseded = card.evidence.find((entry) => entry.evidenceId === 'evid-unit-old');

  assert.ok(current !== undefined && superseded !== undefined, 'both observations are on the card');
  assert.equal(current.recordedOutcome, 'passed');
  assert.equal(current.currentOutcome, 'passed', 'the observation of this commit stands as this commit\'s result');
  assert.equal(current.countsForCurrentCandidate, true);
  assert.deepEqual([...current.staleReasons], []);

  // Same source, same check, opposite readings — because they are about different commits.
  assert.equal(superseded.recordedOutcome, 'failed');
  assert.equal(superseded.currentOutcome, 'stale');
  assert.equal(superseded.countsForCurrentCandidate, false);

  // The check is where the two readings meet: it has a current pass and a superseded failure,
  // and the projection takes the applicable one. This is F23-AC1: "some check passed" is not a
  // criterion's verification, and the criterion says so rather than inheriting the green.
  const criterion = card.criteria.find((entry) => entry.criterionId === AUTOMATED_CRITERION.id);
  assert.equal(
    criterion?.state,
    'unverified',
    'no check is bound to this criterion, so its green does not verify it (F23-AC1)',
  );
  const check = card.checks.find((entry) => entry.checkId === 'unit');
  assert.equal(check?.result, 'passed', 'the check takes the observation that applies to this commit');
  assert.equal(check?.evidenceId, 'evid-unit-new');
});

/* -------------------------------------------------------------------------- */
/* The decision                                                                */
/* -------------------------------------------------------------------------- */

test('F25-AC1: a decision binds the exact 40-character commit it was made against', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);
  h.recordOwnerTest({ seed: stored, candidateId: stored.candidateId, headSha: HEAD_A, outcome: 'passed', evidenceId: 'evid-owner-pass' });

  const response = await decide(h, { candidateId: stored.candidateId, payload: decisionBody({ decision: 'accepted' }) });
  assert.equal(response.statusCode, 200, response.body);
  const card = cardOf(response);

  assert.equal(card.decision.outcome, 'accepted');
  const decision = card.decision.decision;
  assert.ok(decision !== null, 'the decision travels with the card it took effect on');
  assert.equal(decision.kind, 'accepted');
  assert.equal(decision.candidateHeadSha, HEAD_A, 'bound to the full commit, not a branch or a PR');
  assert.equal(decision.candidateHeadSha.length, 40);
  assert.equal(decision.contractRevision, 1, 'and to the contract revision it was reviewed against');
  assert.equal(decision.contractId, CONTRACT_ID);
  assert.equal(decision.requestId, REQUEST_ID);
  assert.equal(card.request.projectId, PROJECT, 'the card states the project it was read under');
  assert.equal(decision.ownerId, OWNER_ID, 'the owner is the session, never the body');
  assert.equal(decision.decidedAt, LATER, 'the instant is the server clock, not a caller-supplied one');
  assert.equal(card.decision.authorizesCurrentCandidate, true);
  assert.deepEqual([...card.decision.staleDecisions], []);
});

test('F24-AC4: a decision prepared against a superseded head is refused, not re-pointed', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);
  h.recordOwnerTest({ seed: stored, candidateId: stored.candidateId, headSha: HEAD_A, outcome: 'passed', evidenceId: 'evid-owner-pass' });
  assert.equal(
    (await decide(h, { candidateId: stored.candidateId, payload: decisionBody({ decision: 'accepted' }) })).statusCode,
    200,
  );

  // The head moves. The owner's page was rendered against HEAD_A.
  h.push(stored, 'cand_checkout_b', HEAD_B);

  const refused = await decide(h, {
    candidateId: 'cand_checkout_b',
    payload: decisionBody({ decision: 'accepted', expectedHeadSha: HEAD_A }),
  });
  assert.equal(refused.statusCode, 409, `a stale head must conflict, never be applied: ${refused.body}`);
  const problem = parse<{ error: { code: string; expected?: string; actual?: string } }>(refused);
  assert.equal(problem.error.code, 'Conflict');
  assert.equal(problem.error.expected, HEAD_A, 'the conflict names both identities so the client can re-render');
  assert.equal(problem.error.actual, HEAD_B);

  // Nothing was written: the new commit carries no decision of its own.
  const card = cardOf(await read(h, { candidateId: 'cand_checkout_b' }));
  assert.equal(card.decision.outcome, 'none', 'the refusal applied nothing to the new head');
  assert.equal(card.decision.authorizesCurrentCandidate, false);
  assert.equal(card.decision.decision, null);
});

test('F24-AC4: a decision against a contract revision that has moved is refused', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);

  const refused = await decide(h, {
    candidateId: stored.candidateId,
    payload: decisionBody({ expectedContractRevision: 2 }),
  });
  assert.equal(refused.statusCode, 409, refused.body);
  const problem = parse<{ error: { expected?: string; actual?: string } }>(refused);
  assert.equal(problem.error.expected, '2');
  assert.equal(problem.error.actual, '1');
});

test('F25-AC1: an abbreviated or malformed commit SHA is refused as a field, before the domain', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);

  for (const attempted of ['a1b2c3d', 'main', 'feature/checkout', '42', '']) {
    const refused = await decide(h, {
      candidateId: stored.candidateId,
      payload: decisionBody({ expectedHeadSha: attempted }),
    });
    assert.equal(refused.statusCode, 400, `"${attempted}" is not an identity: ${refused.body}`);
    const problem = parse<{ error: { code: string; fields: { path: string }[] } }>(refused);
    assert.equal(problem.error.code, 'Invalid');
    assert.ok(
      problem.error.fields.some((field) => field.path === 'expectedHeadSha'),
      `the offending field is named: ${refused.body}`,
    );
  }
});

test('F25-AC4: a decision cannot be attributed to another owner through the body', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);
  h.recordOwnerTest({ seed: stored, candidateId: stored.candidateId, headSha: HEAD_A, outcome: 'passed', evidenceId: 'evid-owner-pass' });

  // Every name a caller might use to name somebody else, or to move the instant.
  for (const field of ['owner', 'ownerId', 'actor', 'approvedBy', 'approver', 'decidedBy', 'decidedAt', 'decisionId']) {
    const refused = await decide(h, {
      candidateId: stored.candidateId,
      payload: decisionBody({ decision: 'accepted', [field]: field === 'decidedAt' ? '2020-01-01T00:00:00.000Z' : IMPERSONATED }),
    });
    assert.equal(refused.statusCode, 400, `a body carrying "${field}" must be refused: ${refused.body}`);
    const problem = parse<{ error: { fields: { path: string; message: string }[] } }>(refused);
    const named = problem.error.fields.find((entry) => entry.path === field);
    assert.ok(named !== undefined, `"${field}" is refused by name rather than ignored: ${refused.body}`);
    assert.match(named.message, /not accepted here/);
  }

  // And nothing was recorded by any of them.
  const card = cardOf(await read(h, { candidateId: stored.candidateId }));
  assert.equal(card.decision.outcome, 'none', 'a refused body records nothing');
  assert.equal(card.decision.decision, null);
});

test('F24-AC3: an owner test nobody ran stays pending and is offered as the owner\'s own action', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);

  const card = cardOf(await read(h, { candidateId: stored.candidateId }));
  assert.equal(card.ownerTests[0]?.state, 'pending', 'nothing on this route can satisfy an owner test (F23-AC1)');
  assert.equal(card.ownerTests[0]?.evidenceId, null);
  assert.equal(card.criteria[0]?.state, 'pending');
  assert.equal(
    card.eligibility.readyForAcceptance,
    false,
    'a pending owner test is offered, not treated as verified and not treated as a failure',
  );
  assert.ok(
    card.eligibility.ownerActions.some((action) => action.includes(OWNER_CRITERION.id)),
    `the outstanding owner step is named: ${JSON.stringify(card.eligibility.ownerActions)}`,
  );
  assert.ok(
    card.eligibility.acceptanceBlockers.some((blocker) => blocker.includes(OWNER_CRITERION.id)),
    'and acceptance says what stands in the way rather than only counting it',
  );
});

test('F23-AC1 / F24-AC3: Accept is refused while eligibility says no, and every outstanding item is named', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);

  const refused = await decide(h, { candidateId: stored.candidateId, payload: decisionBody({ decision: 'accepted' }) });
  assert.equal(refused.statusCode, 422, `Accept over an outstanding criterion is a 422, never a 200: ${refused.body}`);
  const problem = parse<{ error: { code: string; prerequisites: { detail: string }[] } }>(refused);
  assert.equal(problem.error.code, 'Blocked');
  assert.ok(
    problem.error.prerequisites.some((prerequisite) => prerequisite.detail.includes(OWNER_CRITERION.id)),
    `the outstanding criterion is named rather than counted: ${refused.body}`,
  );

  // Nothing was applied.
  const card = cardOf(await read(h, { candidateId: stored.candidateId }));
  assert.equal(card.decision.outcome, 'none', 'a refused acceptance records nothing');
  assert.equal(card.eligibility.readyForAcceptance, false);
});

test('F25-AC2: Request Changes is available while acceptance is refused', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);

  const response = await decide(h, {
    candidateId: stored.candidateId,
    payload: decisionBody({ decision: 'changes_requested', feedback: 'The total ignores the shipping line.' }),
  });
  assert.equal(response.statusCode, 200, `Request Changes is not gated on eligibility: ${response.body}`);
  const card = cardOf(response);
  assert.equal(card.decision.outcome, 'changes_requested');
  assert.equal(card.decision.decision?.feedback, 'The total ignores the shipping line.');
  assert.equal(
    card.decision.authorizesCurrentCandidate,
    false,
    'a change request is an explicit refusal, not an acceptance of something (F25-AC2)',
  );
  assert.equal(card.eligibility.readyForAcceptance, false);
});

test('F25-AC2: a change request with no feedback is refused, because there is nothing to act on', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);

  for (const feedback of [undefined, null, '', '   ']) {
    const refused = await decide(h, {
      candidateId: stored.candidateId,
      payload: decisionBody({ feedback }),
    });
    assert.equal(refused.statusCode, 400, `feedback ${JSON.stringify(feedback)} is not actionable: ${refused.body}`);
    const problem = parse<{ error: { fields: { path: string }[] } }>(refused);
    assert.ok(problem.error.fields.some((field) => field.path === 'feedback'));
  }
});

test('F25-AC3: a push reopens the owner test for the new commit', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);
  h.recordOwnerTest({ seed: stored, candidateId: stored.candidateId, headSha: HEAD_A, outcome: 'passed', evidenceId: 'evid-owner-pass' });
  assert.equal(
    (await decide(h, { candidateId: stored.candidateId, payload: decisionBody({ decision: 'accepted' }) })).statusCode,
    200,
  );

  h.push(stored, 'cand_checkout_b', HEAD_B);

  const card = cardOf(await read(h, { candidateId: 'cand_checkout_b' }));
  assert.equal(
    card.ownerTests[0]?.state,
    'pending',
    'evidence for SHA A cannot prove SHA B, so the owner test is outstanding again (F20-AC3)',
  );
  assert.equal(card.eligibility.readyForAcceptance, false);

  const refused = await decide(h, {
    candidateId: 'cand_checkout_b',
    payload: decisionBody({ decision: 'accepted', expectedHeadSha: HEAD_B }),
  });
  assert.equal(refused.statusCode, 422, 'the new commit needs its own owner test before acceptance');
});

/* -------------------------------------------------------------------------- */
/* Authorization                                                               */
/* -------------------------------------------------------------------------- */

test('F02-AC2: a candidate recorded against another project is not found here', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, { ...STANDARD_SEED, projectId: OTHER_PROJECT as ProjectId });

  const refused = await read(h, { candidateId: stored.candidateId });
  assert.equal(refused.statusCode, 404, `a candidate is addressed by its own project, never by id alone: ${refused.body}`);
  const problem = parse<{ error: { code: string } }>(refused);
  assert.equal(problem.error.code, 'NotFound');

  // And no decision can be recorded through the wrong project either.
  const decided = await decide(h, { candidateId: stored.candidateId, payload: decisionBody() });
  assert.equal(decided.statusCode, 404);
});

test('mvp-spec 3: the unscoped paths do not exist', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);

  for (const url of ['/api/review', '/api/candidates', `/api/candidates/${stored.candidateId}/review`]) {
    const response = await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
    assert.equal(response.statusCode, 404, `${url} must not exist: everything is project-scoped`);
  }
});

test('F01-AC1: an anonymous caller is refused, and told nothing about the candidate', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);

  const anonymous = await h.app.inject({ method: 'GET', url: reviewUrl(PROJECT, stored.candidateId) });
  assert.equal(anonymous.statusCode, 401);
  const problem = parse<{ error: { message: string }; signInRequired?: boolean }>(anonymous);
  assert.equal(problem.signInRequired, true);
  assert.ok(!anonymous.body.includes(HEAD_A), 'the refusal does not echo the commit it refused');
  assert.ok(!anonymous.body.includes(stored.candidateId));

  const anonymousDecision = await h.app.inject({
    method: 'POST',
    url: reviewUrl(PROJECT, stored.candidateId, 'decision'),
    headers: { 'content-type': 'application/json' },
    payload: decisionBody(),
  });
  assert.equal(anonymousDecision.statusCode, 401);
  assert.ok(!anonymousDecision.body.includes(HEAD_A));
});

test('F01-AC4: a state-changing decision without a forgery-protection token is refused', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);

  const withoutToken = await h.app.inject({
    method: 'POST',
    url: reviewUrl(PROJECT, stored.candidateId, 'decision'),
    headers: { cookie: h.cookie, 'content-type': 'application/json' },
    payload: decisionBody(),
  });
  assert.equal(withoutToken.statusCode, 403, `a token is required on every state-changing method: ${withoutToken.body}`);

  const wrongToken = await decide(h, {
    candidateId: stored.candidateId,
    payload: decisionBody(),
    headers: { [CSRF_HEADER]: 'not-the-derived-token' },
  });
  assert.equal(wrongToken.statusCode, 403);

  const card = cardOf(await read(h, { candidateId: stored.candidateId }));
  assert.equal(card.decision.outcome, 'none', 'neither attempt recorded anything');
});

test('F01-AC1: a private response is never cached, and the security headers are set', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);

  const response = await read(h, { candidateId: stored.candidateId });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.match(String(response.headers['content-security-policy'] ?? ''), /frame-ancestors 'none'/);
});

test('mvp-spec 3: a decision value outside the two the MVP ends at is refused', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);

  for (const attempted of ['merged', 'deployed', 'released', 'Open', '']) {
    const refused = await decide(h, { candidateId: stored.candidateId, payload: decisionBody({ decision: attempted }) });
    assert.equal(refused.statusCode, 400, `"${attempted}" is not a decision this product takes: ${refused.body}`);
    const problem = parse<{ error: { fields: { path: string }[] } }>(refused);
    assert.ok(problem.error.fields.some((field) => field.path === 'decision'));
  }
});

test('F24-AC2: a server that composed no review path says so, rather than serving an empty card', async (t) => {
  const h = await harness({ sources: null });
  t.after(() => h.close());
  seed(h.db, STANDARD_SEED);

  const response = await read(h, { candidateId: STANDARD_SEED.candidateId });
  assert.equal(response.statusCode, 503, 'a server that cannot read a candidate has no basis for a card');
  const problem = parse<{ error: { code: string; message: string } }>(response);
  assert.equal(problem.error.code, 'Unavailable');
  assert.match(problem.error.message, /has not been assessed|not composed/i);
  assert.ok(!response.body.includes('"review"'), 'no card-shaped body is invented for a missing dependency');

  const decided = await decide(h, { candidateId: STANDARD_SEED.candidateId, payload: decisionBody() });
  assert.equal(decided.statusCode, 503, 'and no decision is recorded against a path that cannot read the candidate');
});

test('F02-AC4: a project id that tries to traverse is refused at the boundary', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const stored = seed(h.db, STANDARD_SEED);

  for (const projectId of ['../secrets', 'a/b', '..']) {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${encodeURIComponent(projectId)}/candidates/${stored.candidateId}/review`,
      headers: { cookie: h.cookie },
    });
    assert.ok(response.statusCode >= 400, `"${projectId}" is refused: ${response.statusCode}`);
  }
});