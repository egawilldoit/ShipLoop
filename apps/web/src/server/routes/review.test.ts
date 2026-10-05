/**
 * The review card and the owner decision, over HTTP against the real controller
 * (mvp-spec 3, F20-AC3, F23-AC1, F24-AC2, F24-AC3, F24-AC4, F25-AC1, F25-AC2, F25-AC3, F25-AC4).
 *
 * `api.test.ts` proves the transport's general shape against a double, and a double cannot
 * answer the questions these two routes exist to answer. Whether a stale pass renders as a
 * current one, whether a decision survives a push, and whether an owner test can be settled
 * by anything other than the owner are all properties of the *projection*, and a fixture
 * that assembled its own card would agree with the route while disagreeing with the product.
 * So this file boots the real composition root over a real migrated SQLite file - the same
 * root `main.ts` composes, bound to the same `ControllerSurface` the web package declares -
 * and drives it with `app.inject()`, with no listener and no port.
 *
 * What each test pins, and the wrong answer it removes:
 *
 *   - **every element of the card is present, with the full SHA verbatim.** A card that
 *     omitted the revision, the checks or the eligibility would leave a client to invent
 *     them; an abbreviated SHA would let a branch stand in for a build (mvp-spec 3, F24-AC2).
 *   - **a stale result cannot be read as a current one.** The evidence rows carry
 *     `recordedOutcome`, `currentOutcome` and `countsForCurrentCandidate`, and there is no
 *     bare `outcome` to reach for. The assertion walks every row rather than spot-checking
 *     one, because the failure mode is a row a client could render green (F20-AC3, F24-AC3).
 *   - **a decision is bound to one commit.** Submitting the previous commit is a 409, and
 *     nothing is recorded; a decision that succeeded there would authorise a build its
 *     author never saw (F24-AC4, F25-AC3).
 *   - **the owner is the session.** A body naming an owner is refused by name, and the
 *     recorded decision is attributed to the session that made it (F01-AC1, F25-AC4).
 *   - **an owner test is pending until the owner acts**, and is the only thing that blocks
 *     acceptance. Nothing on this card can settle it (F23-AC1, F24-AC3).
 *   - **Accept is gated, Request Changes is not.** With the same card, one is refused with
 *     the outstanding requirements named and the other is recorded (F23-AC1, F25-AC2).
 *   - **the project boundary is server-side, in both directions.** The other project is a
 *     real one with its own request, revision and candidate, so the only thing that can
 *     refuse is the candidate's own project; the reason is asserted, not just the status,
 *     because a project-keyed lookup would answer 404 for a different reason. An anonymous
 *     caller is refused before any fact is considered, and a state-changing request without
 *     the session's forgery token is refused too (F02-AC2, F01-AC1, F01-AC4).
 *
 * The two staleness checks are deliberately split across files. This one drives the real
 * projection, so it proves the domain is right. `review.invariants.test.ts` answers the port
 * with cards built to contradict themselves, so it proves the transport notices when a card is
 * wrong. Neither file can establish the other's half, and a check that has only ever seen
 * honest input has not been shown to work.
 *
 * The seed is the MVP's own journey over HTTP - a request, a contract drafted against it and
 * the owner's approval - and then one candidate row written directly through the delivery
 * candidate store, because linking a candidate needs a GitHub credential the MVP is not
 * allowed to require. Evidence is seeded the same way, through the store's own constructor:
 * no route in this phase records one, so a test that wanted one had to write it itself.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SESSION_COOKIE_NAME, recordMvpEvidence, recordMvpOwnerDecision } from '@shiploop/domain';
import type { CandidateId, CapabilityDeclaration, CommitSha, OwnerId, ProjectId } from '@shiploop/domain';
import type { FastifyInstance } from 'fastify';
import { DeliveryCandidateRepository, SqliteMvpReviewStore } from '@shiploop/storage';
import type { ConnectorKind } from '@shiploop/storage';
import {
  bindControllerSurface,
  createCompositionRoot,
  type AdapterRegistry,
  type CompositionRoot,
} from '@shiploop/controller';
import { buildApp } from '../app.ts';
import { CSRF_HEADER } from '../auth-guard.ts';
import { readServerConfig } from '../config.ts';
import type { ContractView, ControllerSurface, MvpReviewCardView, RequestView } from '../contracts.ts';

const NOW = '2026-10-03T09:00:00.000Z';
const LATER = '2026-10-03T10:00:00.000Z';
const DISPLAY_NAME = 'Solo Owner';
const PASSWORD = 'correct horse battery staple';
const PROJECT_ID = 'checkout';
const OTHER_PROJECT_ID = 'checkout-other';
const CSRF_SECRET = ['server', 'secret', 'material', '0123456789abcdef'].join('-');
const IDLE_TIMEOUT_SECONDS = 900;
const FAST_PASSWORD_COST = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16 };

const REQUEST_TITLE = 'Checkout totals';
const REQUEST_DESCRIPTION = 'The order summary shows the pre-tax total.';
const OWNER_CRITERION_ID = 'AC2';
const AUTOMATED_CRITERION_ID = 'AC1';

const CANDIDATE_ID = 'cand-checkout';
/** The commit on screen. 40 characters, because an abbreviation is not an identity. */
const HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
/** The commit before the push, used for the stale cases. Also a full SHA. */
const OLD_HEAD = 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5';
/** The commit a push moves the candidate to. A third full SHA, distinct from both above. */
const PUSHED_HEAD = '0f1e2d3c4b5a0f1e2d3c4b5a0f1e2d3c4b5a0f1e';

/** No provider is configured: the MVP journey must work with none (mvp-spec MVP). */
const NO_ADAPTERS: AdapterRegistry = {
  declarationsFor(_kind: ConnectorKind): readonly CapabilityDeclaration[] {
    return [];
  },
  probeFor() {
    return null;
  },
};

/**
 * The check AC1 is verified by.
 *
 * A check name, not a check run: the same string for every run, which is what lets a re-run on
 * a new commit re-verify the criterion instead of invalidating the binding. It is the same
 * vocabulary a project profile's `policy.requiredChecks` uses.
 */
const UNIT_CHECK = 'unit-tests';

const AUTOMATED_CRITERION = {
  id: AUTOMATED_CRITERION_ID,
  description: 'The summary returns 200 and displays "Total: 12.00".',
  verificationType: 'automated',
  verificationCheckId: UNIT_CHECK,
} as const;

const OWNER_CRITERION = {
  id: OWNER_CRITERION_ID,
  description: 'The owner confirms the total matches the invoice they were sent.',
  verificationType: 'owner_test',
  verificationCheckId: null,
} as const;

const CONTRACT_CONTENT = {
  outcome: 'The order summary shows the total including tax.',
  scope: ['Sum the line items before tax'],
  outOfScope: ['Changing the tax rate'],
  acceptanceCriteria: [AUTOMATED_CRITERION, OWNER_CRITERION],
} as const;

/**
 * A contract whose only criterion is the owner's own.
 *
 * Used by the cases about the owner-test gate, so that what they observe is the owner test and
 * not an automated criterion nobody ran. It is not a workaround for anything: an automated
 * criterion is settled by its bound check now, and a case that wants an automated criterion
 * satisfied records a result for that check.
 */
const OWNER_ONLY_CONTENT = {
  ...CONTRACT_CONTENT,
  acceptanceCriteria: [OWNER_CRITERION],
} as const;

type ContractContent = {
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly {
    readonly id: string;
    readonly description: string;
    readonly verificationType: 'automated' | 'owner_test';
    /** Omitted on purpose in the cases that draft an unbound criterion. */
    readonly verificationCheckId?: string | null;
  }[];
};

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

interface Seed {
  readonly projectId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly revision: number;
  readonly candidateId: string;
}

/** The same shape, for a project the first one has never heard of. */
interface ProjectSeed extends Seed {}

interface Harness {
  readonly app: FastifyInstance;
  readonly root: CompositionRoot;
  readonly session: Session;
  readonly seed: Seed;
  /** Records an owner test against one exact commit, the way no route in this phase does. */
  readonly recordOwnerTest: (input: { evidenceId: string; headSha: string }) => void;
  /**
   * Records an owner acceptance bound to a commit the candidate is no longer on.
   *
   * Written through the store rather than over HTTP because that is the only way to reach
   * the state, and it is a real one: a decision is append-only and binds the commit it was
   * made against, so a row whose commit is no longer the candidate's head describes a
   * superseded acceptance. The route still has to render it as history rather than drop it
   * (F25-AC3), and the HTTP producer for that row - a push, recorded by the candidate
   * module - is not part of this phase's transport.
   */
  readonly recordAcceptanceFor: (input: { decisionId: string; headSha: string; decidedAt?: string }) => void;
  /**
   * Records the candidate row a push produces: the same pull request at a new commit.
   *
   * The store mints a candidate identity per observation, so a push is a new row rather
   * than a rewritten one - which is why it needs its own id, and why the card and decision
   * helpers take one. Written directly because the GitHub adapter is not part of this
   * phase's transport (F20-AC3).
   */
  readonly push: (input: { candidateId: string; headSha: string }) => void;
  /** A second project with its own approved revision, built the same way over HTTP. */
  readonly seedProject: (projectId: string) => Promise<ProjectSeed>;
  /** Writes one candidate row, so a test can give a second project a candidate of its own. */
  readonly recordCandidate: (input: {
    readonly candidateId: string;
    readonly projectId: string;
    readonly seed: ProjectSeed;
  }) => void;
  /** Re-reads the card, so a test can prove a refused submission left nothing behind. */
  readonly review: () => Promise<{ readonly status: number; readonly card: MvpReviewCardView | null; readonly raw: string }>;
  readonly reviewFor: (candidateId: string) => Promise<{ readonly status: number; readonly card: MvpReviewCardView | null; readonly raw: string }>;
  readonly decide: (payload: Record<string, unknown>) => Promise<{ readonly status: number; readonly body: string }>;
  readonly decideIn: (projectId: string, payload: Record<string, unknown>) => Promise<{ readonly status: number; readonly body: string }>;
  readonly decideOn: (candidateId: string, payload: Record<string, unknown>) => Promise<{ readonly status: number; readonly body: string }>;
  readonly decideWithoutCsrf: (payload: Record<string, unknown>) => Promise<{ readonly status: number; readonly body: string }>;
  /** Moves the injected clock forward, so a later decision really is later. */
  readonly advance: (seconds: number) => void;
  readonly readReview: (projectId: string) => Promise<{ readonly status: number; readonly body: string }>;
  readonly readReviewAs: (projectId: string, candidateId: string) => Promise<{ readonly status: number; readonly body: string }>;
  readonly readReviewAnonymously: () => Promise<{ readonly status: number; readonly body: string }>;
  readonly close: () => Promise<void>;
}

/**
 * The whole journey, over HTTP, on a real store.
 *
 * The session, the project, the request and the approved revision are all produced by the
 * shipped routes rather than written into the database directly, so what the card reads is
 * what the product would have recorded for an owner who walked the journey. Only the
 * candidate row and the evidence rows are written through the store, and each says why in the
 * test header above.
 */
async function harness(options: { readonly content?: ContractContent } = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-review-route-'));
  // A movable clock, because "a later acceptance supersedes an earlier change request" is a
  // claim about order and two decisions stamped with one frozen instant are a tie the domain
  // resolves in the change request's favour. A test that froze the clock would be testing the
  // tie, not the rule.
  let instant = Date.parse(NOW);
  const at = (): string => new Date(instant).toISOString();
  const opened = createCompositionRoot({
    databasePath: join(directory, 'shiploop.db'),
    clock: { now: at },
    adapters: NO_ADAPTERS,
    passwordParameters: FAST_PASSWORD_COST,
    sessionIdleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
  });
  assert.ok(opened.ok, `the store must open: ${opened.ok ? '' : opened.error.reason}`);
  const root = opened.value;

  const controller: ControllerSurface = bindControllerSurface(root);
  const config = readServerConfig({
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_NODE_ENV: 'test',
    SHIPLOOP_COOKIE_SECURE: 'false',
    SHIPLOOP_LOG_LEVEL: 'silent',
  });
  assert.ok(config.ok, `the configuration must be accepted: ${config.ok ? '' : JSON.stringify(config.errors)}`);
  const app = await buildApp({ config: config.value, controller, now: () => new Date(instant) });

  const session = await signIn(app);
  const seed = await approvedContract(app, session, options.content ?? CONTRACT_CONTENT);

  expectOk(
    new DeliveryCandidateRepository(root.database).record({
      candidateId: CANDIDATE_ID as CandidateId,
      projectId: PROJECT_ID as ProjectId,
      requestId: seed.requestId,
      contractId: seed.contractId,
      contractRevision: seed.revision,
      provider: 'github',
      repository: 'octopus/shop',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.invalid/octopus/shop/pull/42',
      baseBranch: 'main',
      baseSha: OLD_HEAD as CommitSha,
      headBranch: 'feature/checkout-total',
      headSha: HEAD as CommitSha,
      headRepository: 'octopus/shop',
      pullRequestState: 'Open',
      draft: false,
      observedAt: NOW,
      correlationId: 'seed-candidate',
    }),
    'the candidate row the card is read against',
  );

  const recordCandidate = (input: { candidateId: string; projectId: string; seed: ProjectSeed }): void => {
    expectOk(
      new DeliveryCandidateRepository(root.database).record({
        candidateId: input.candidateId as CandidateId,
        projectId: input.projectId as ProjectId,
        requestId: input.seed.requestId,
        contractId: input.seed.contractId,
        contractRevision: input.seed.revision,
        provider: 'github',
        repository: 'octopus/shop',
        pullRequestNumber: 42,
        pullRequestUrl: 'https://example.invalid/octopus/shop/pull/42',
        baseBranch: 'main',
        baseSha: OLD_HEAD as CommitSha,
        headBranch: 'feature/checkout-total',
        headSha: HEAD as CommitSha,
        headRepository: 'octopus/shop',
        pullRequestState: 'Open',
        draft: false,
        observedAt: NOW,
        correlationId: `seed-${input.candidateId}`,
      }),
      `the candidate row for ${input.projectId}`,
    );
  };

  const reviewUrl = (projectId: string, candidateId = CANDIDATE_ID): string =>
    `/api/projects/${projectId}/candidates/${candidateId}/review`;
  const decisionUrl = (projectId: string, candidateId = CANDIDATE_ID): string =>
    `/api/projects/${projectId}/candidates/${candidateId}/decision`;

  const readReview = async (projectId: string, candidateId = CANDIDATE_ID) => {
    const response = await app.inject({
      method: 'GET',
      url: reviewUrl(projectId, candidateId),
      headers: { cookie: session.cookie },
    });
    return { status: response.statusCode, body: response.body };
  };

  const decideIn = async (projectId: string, payload: Record<string, unknown>, candidateId = CANDIDATE_ID) => {
    const response = await app.inject({
      method: 'POST',
      url: decisionUrl(projectId, candidateId),
      headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
      payload,
    });
    return { status: response.statusCode, body: response.body };
  };

  const decideWithoutCsrf = async (payload: Record<string, unknown>) => {
    const response = await app.inject({
      method: 'POST',
      url: decisionUrl(PROJECT_ID),
      headers: { cookie: session.cookie },
      payload,
    });
    return { status: response.statusCode, body: response.body };
  };

  const owner = root.owners.current();
  assert.ok(owner.ok && owner.value !== null, 'the provisioned owner must be readable');
  const ownerId = String(owner.value.ownerId) as OwnerId;

  return {
    app,
    root,
    session,
    seed,
    recordOwnerTest: (input) => {
      // The store's own constructor, because no HTTP route records an owner test in this
      // phase. The row is bound to the commit and the revision, exactly as `recordOwnerTest`
      // binds it, so the read model treats it as an observation and not as a fixture.
      const evidence = expectOk(
        recordMvpEvidence({
          evidenceId: input.evidenceId,
          contractId: seed.contractId,
          candidateId: CANDIDATE_ID,
          subject: { kind: 'criterion', criterionId: OWNER_CRITERION_ID },
          method: { kind: 'OwnerTest', instructions: 'Compare the total with the invoice.' },
          observation: { kind: 'owner_test', outcome: 'passed', actor: { role: 'owner', ownerId } },
          observedHeadSha: input.headSha as CommitSha,
          observedContractRevision: seed.revision,
          observedAt: LATER,
          detail: null,
          artifactRef: null,
        }),
        'the owner-test evidence the card will read',
      );
      expectOk(
        new SqliteMvpReviewStore(root.database).recordEvidence({
          evidence,
          owner: { role: 'owner', ownerId },
          projectId: PROJECT_ID,
          requestId: seed.requestId,
          candidateId: CANDIDATE_ID,
          candidateHeadSha: input.headSha as CommitSha,
          contractId: seed.contractId,
          contractRevision: seed.revision,
          recordedAt: LATER,
          correlationId: `corr-${input.evidenceId}`,
        }),
        'the owner-test row',
      );
    },
    recordAcceptanceFor: (input) => {
      const decision = expectOk(
        recordMvpOwnerDecision({
          decisionId: input.decisionId,
          kind: 'accepted',
          actor: { role: 'owner', ownerId },
          projectId: PROJECT_ID,
          requestId: seed.requestId,
          contractId: seed.contractId,
          contractRevision: seed.revision,
          candidateId: CANDIDATE_ID,
          candidateHeadSha: input.headSha as CommitSha,
          decidedAt: LATER,
          feedback: null,
        }),
        'the superseded acceptance the card will read',
      );
      expectOk(
        new SqliteMvpReviewStore(root.database).recordDecision({
          decision,
          correlationId: `corr-${input.decisionId}`,
        }),
        'the superseded acceptance row',
      );
    },
    review: async () => {
      const response = await readReview(PROJECT_ID);
      return {
        status: response.status,
        card: parse<{ review?: MvpReviewCardView }>({ body: response.body }).review ?? null,
        raw: response.body,
      };
    },
    reviewFor: async (candidateId) => {
      const response = await readReview(PROJECT_ID, candidateId);
      return {
        status: response.status,
        card: parse<{ review?: MvpReviewCardView }>({ body: response.body }).review ?? null,
        raw: response.body,
      };
    },
    decide: (payload) => decideIn(PROJECT_ID, payload),
    decideIn,
    decideOn: (candidateId, payload) => decideIn(PROJECT_ID, payload, candidateId),
    push: (input) => {
      expectOk(
        new DeliveryCandidateRepository(root.database).record({
          candidateId: input.candidateId as CandidateId,
          projectId: PROJECT_ID as ProjectId,
          requestId: seed.requestId,
          contractId: seed.contractId,
          contractRevision: seed.revision,
          provider: 'github',
          repository: 'octopus/shop',
          pullRequestNumber: 42,
          pullRequestUrl: 'https://example.invalid/octopus/shop/pull/42',
          baseBranch: 'main',
          baseSha: OLD_HEAD as CommitSha,
          headBranch: 'feature/checkout-total',
          headSha: input.headSha as CommitSha,
          headRepository: 'octopus/shop',
          pullRequestState: 'Open',
          draft: false,
          observedAt: LATER,
          correlationId: `push-${input.candidateId}`,
        }),
        'the candidate row a push leaves behind',
      );
    },
    seedProject: async (projectId) => {
      const other = await approvedContract(app, session, options.content ?? CONTRACT_CONTENT, projectId);
      return { ...other, candidateId: `${projectId}-candidate` };
    },
    recordCandidate,
    decideWithoutCsrf,
    advance: (seconds) => {
      instant += seconds * 1000;
    },
    readReview,
    readReviewAs: async (projectId, candidateId) => {
      const response = await readReview(projectId, candidateId);
      return { status: response.status, body: response.body };
    },
    readReviewAnonymously: async () => {
      const response = await app.inject({ method: 'GET', url: reviewUrl(PROJECT_ID) });
      return { status: response.statusCode, body: response.body };
    },
    close: async () => {
      await app.close();
      root.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Unwraps an expected success, or fails the test naming what the store refused. */
function expectOk<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly reason: string } }, what: string): T {
  assert.ok(result.ok, `${what} must be accepted: ${result.ok ? '' : result.error.reason}`);
  return result.value;
}

function parse<T>(response: { readonly body: string }): T {
  return JSON.parse(response.body) as T;
}

interface ProblemBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly fields?: readonly { readonly path: string; readonly message: string }[];
    readonly prerequisites?: readonly { readonly name: string; readonly detail: string }[];
    readonly expected?: string;
    readonly actual?: string;
  };
  readonly signInRequired?: boolean;
}

function problemOf(body: string): ProblemBody {
  return parse<ProblemBody>({ body });
}

/** The field messages a refusal attached to one path, joined for a readable assertion. */
function fieldMessages(problem: ProblemBody, path: string): string {
  return (problem.error.fields ?? [])
    .filter((entry) => entry.path === path)
    .map((entry) => entry.message)
    .join(' ');
}

function cookieFrom(response: { readonly headers: Record<string, string | string[] | number | undefined> }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  assert.equal(typeof header, 'string', 'sign-in must set exactly one cookie');
  const value = /^[A-Za-z0-9_]+=([^;]*)/.exec(String(header));
  assert.ok(value !== null, `the Set-Cookie header must carry a value: ${String(header)}`);
  return `${SESSION_COOKIE_NAME}=${value?.[1] ?? ''}`;
}

async function signIn(app: FastifyInstance): Promise<Session> {
  const provisioned = await app.inject({
    method: 'POST',
    url: '/api/owner/provision',
    payload: { displayName: DISPLAY_NAME, password: PASSWORD },
  });
  assert.equal(provisioned.statusCode, 201, `provisioning failed: ${provisioned.body}`);
  const response = await app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: { identifier: DISPLAY_NAME, password: PASSWORD },
  });
  assert.equal(response.statusCode, 200, `sign-in failed: ${response.body}`);
  return { cookie: cookieFrom(response), csrfToken: parse<{ csrfToken: string }>(response).csrfToken };
}

/**
 * A project with one approved revision, built entirely over HTTP.
 *
 * The same journey `handoff.test.ts` walks, and for the same reason: the card reads a request
 * and a contract revision, and a card built from rows a test inserted by hand would prove the
 * projection and not the product.
 */
async function approvedContract(
  app: FastifyInstance,
  session: Session,
  content: ContractContent,
  projectId: string = PROJECT_ID,
): Promise<Seed> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { projectId, name: 'Checkout' },
  });
  assert.ok(created.statusCode === 200 || created.statusCode === 201, `project creation failed: ${created.body}`);

  const requested = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/requests`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { title: REQUEST_TITLE, description: REQUEST_DESCRIPTION },
  });
  assert.equal(requested.statusCode, 201, `request creation failed: ${requested.body}`);
  const request = parse<{ request: RequestView }>(requested).request;

  const drafted = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/requests/${request.requestId}/contracts`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: content,
  });
  assert.equal(drafted.statusCode, 201, `contract drafting failed: ${drafted.body}`);
  const contract = parse<{ contract: ContractView }>(drafted).contract;

  const approved = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/contracts/${contract.contractId}/${contract.revision}/approve`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    // The fingerprint the draft read returned: an approval names the text it seals.
    payload: { expectedContentFingerprint: contract.contentFingerprint },
  });
  assert.equal(approved.statusCode, 200, `approval failed: ${approved.body}`);
  return {
    projectId,
    requestId: request.requestId,
    contractId: contract.contractId,
    revision: contract.revision,
    candidateId: CANDIDATE_ID,
  };
}

/** A decision body naming the commit on screen, so a test overrides one field at a time. */
function decisionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: 'changes_requested',
    expectedHeadSha: HEAD,
    expectedContractRevision: 1,
    feedback: 'The total is missing the tax line.',
    ...overrides,
  };
}

/**
 * F23-AC1, F24-AC3: the approval gate over real HTTP, against the shipped composition.
 *
 * An automated criterion that names no check reaches the draft and stops at approval. This is
 * the case that would otherwise block the journey forever: nothing could verify the criterion,
 * so it would read `unverified` for the life of the product and every acceptance of that
 * contract would be refused with nothing the owner could do about it.
 *
 * Driven through the same routes the product serves rather than through a surface double,
 * because a double would approve whatever it was handed and prove nothing.
 */
test('F23-AC1, F24-AC3: an automated criterion that names no check is refused at approval, by name', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-review-binding-'));
  let instant = Date.parse(NOW);
  const at = (): string => new Date(instant).toISOString();
  const opened = createCompositionRoot({
    databasePath: join(directory, 'shiploop.db'),
    clock: { now: at },
    adapters: NO_ADAPTERS,
    passwordParameters: FAST_PASSWORD_COST,
    sessionIdleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
  });
  assert.ok(opened.ok);
  const root = opened.value;
  const config = readServerConfig({
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_NODE_ENV: 'test',
    SHIPLOOP_COOKIE_SECURE: 'false',
    SHIPLOOP_LOG_LEVEL: 'silent',
  });
  assert.ok(config.ok);
  const app = await buildApp({
    config: config.value,
    controller: bindControllerSurface(root),
    now: () => new Date(instant),
  });
  t.after(async () => {
    await app.close();
    root.close();
    await rm(directory, { recursive: true, force: true });
  });

  const session = await signIn(app);
  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { projectId: PROJECT_ID, name: 'Checkout' },
  });
  assert.ok(project.statusCode === 200 || project.statusCode === 201, project.body);
  const requested = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/requests`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { title: REQUEST_TITLE, description: REQUEST_DESCRIPTION },
  });
  assert.equal(requested.statusCode, 201, requested.body);
  const requestId = parse<{ request: RequestView }>(requested).request.requestId;

  // The body omits `verificationCheckId` on the automated criterion: the wire shape allows an
  // omission, and the route states it as unbound rather than dropping it.
  const drafted = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/requests/${requestId}/contracts`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: {
      ...CONTRACT_CONTENT,
      acceptanceCriteria: [
        { id: AUTOMATED_CRITERION_ID, description: AUTOMATED_CRITERION.description, verificationType: 'automated' },
        { ...OWNER_CRITERION },
      ],
    },
  });
  assert.equal(drafted.statusCode, 201, drafted.body);
  const contract = parse<{ contract: ContractView }>(drafted).contract;
  assert.deepEqual(
    contract.acceptanceCriteria.map((criterion) => criterion.verificationCheckId),
    [null, null],
    'the draft reads back as unbound, which is the state the gate refuses',
  );

  const refused = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/${contract.revision}/approve`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    // Sends the fingerprint this read carried, so the approval reaches the binding gate. An empty
    // body is refused earlier, by the compare-and-set guard, and this test is about the refusal
    // that follows it — proving the wrong refusal would leave the gate untested.
    payload: { expectedContentFingerprint: contract.contentFingerprint },
  });
  assert.equal(refused.statusCode, 400, refused.body);
  assert.match(refused.body, /verificationCheckId/, 'the refusal names the field the owner has to fill');
  assert.match(refused.body, /name the check that verifies it/);

  const readBack = await app.inject({
    method: 'GET',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/${contract.revision}`,
    headers: { cookie: session.cookie },
  });
  assert.equal(parse<{ contract: ContractView }>(readBack).contract.status, 'draft');

  // Binding it makes the same revision approvable, which is what tells the owner the refusal
  // was about the missing statement rather than about the contract itself.
  const bound = await app.inject({
    method: 'PATCH',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/${contract.revision}`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { ...CONTRACT_CONTENT, expectedUpdatedAt: contract.updatedAt },
  });
  assert.equal(bound.statusCode, 200, bound.body);
  // The binding edit changed the text, so the approval names the fingerprint of the *bound* draft.
  // The fingerprint read before the edit is stale by exactly the change the owner just made, and
  // the compare-and-set guard refusing it is the whole reason that guard exists.
  const boundContract = parse<{ contract: ContractView }>(bound).contract;
  const approved = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/${contract.revision}/approve`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { expectedContentFingerprint: boundContract.contentFingerprint },
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.deepEqual(
    parse<{ contract: ContractView }>(approved).contract.acceptanceCriteria.map(
      (criterion) => criterion.verificationCheckId,
    ),
    [UNIT_CHECK, null],
    'the approved revision names the check that settles each criterion',
  );
});

/* -------------------------------------------------------------------------- */
/* The card                                                                   */
/* -------------------------------------------------------------------------- */

test('F24-AC2: the card carries every element, with the full commit SHA verbatim', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { status, card, raw } = await h.review();
  assert.equal(status, 200, raw);
  assert.ok(card !== null);

  assert.equal(card.request.requestId, h.seed.requestId);
  assert.equal(card.request.projectId, PROJECT_ID);
  assert.equal(card.request.title, REQUEST_TITLE);

  assert.equal(card.contract.contractId, h.seed.contractId);
  assert.equal(card.contract.revision, 1, 'the revision every criterion and decision binds to');
  assert.equal(card.contract.status, 'approved');
  assert.deepEqual(
    card.contract.acceptanceCriteria.map((criterion) => criterion.id).sort(),
    [AUTOMATED_CRITERION_ID, OWNER_CRITERION_ID],
    'every criterion the contract declares is on the card',
  );
  assert.ok(card.contract.approval.approvedAt !== null, 'the approval is what the candidate was handed');

  // Provider facts are carried, not inferred, and an unrecognised provider state keeps its
  // own name rather than being folded into Open or Closed (mvp-spec 3).
  assert.equal(card.candidate.pullRequestState, 'Open', "the provider's own state, verbatim");
  assert.equal(card.candidate.pullRequestNumber, 42);
  assert.equal(card.candidate.pullRequestUrl, 'https://example.invalid/octopus/shop/pull/42');
  assert.equal(card.candidate.repository, 'octopus/shop');
  assert.equal(card.candidate.baseBranch, 'main');
  assert.equal(card.candidate.draft, false);
  assert.equal(card.candidate.requestId, h.seed.requestId);
  assert.equal(card.candidate.contractId, h.seed.contractId);

  // The policy the eligibility was computed under travels with it, so a client can tell an
  // empty required-check list from a missing policy.
  assert.equal(card.policy.policyId, 'mvp-default');
  assert.deepEqual(card.policy.requiredAutomatedCheckIds, [], 'the shipped policy requires no check');
  assert.equal(card.policy.ownerTestBlocksReview, false);
  assert.equal(card.policy.ownerTestBlocksDelivery, true);

  assert.equal(card.candidate.candidateId, CANDIDATE_ID);
  assert.equal(card.candidate.headSha, HEAD, 'the head is the full SHA the store recorded, verbatim');
  assert.equal(card.candidate.headSha.length, 40);
  assert.match(card.candidate.headSha, /^[0-9a-f]{40}$/);
  assert.equal(card.candidate.contractRevision, 1);

  // Checks, criteria, evidence, owner tests, staleness, eligibility and the decision are all
  // present as elements rather than omitted, so a client never has to distinguish "absent"
  // from "not run" by guessing.
  assert.ok(Array.isArray(card.checks), 'the check list is present even when nothing ran');
  assert.equal(card.checks.length, 0, 'no result is recorded for any check, so none is listed');
  const automated = card.criteria.find((criterion) => criterion.criterionId === AUTOMATED_CRITERION_ID);
  assert.ok(automated !== undefined);
  assert.equal(
    automated.verificationCheckId,
    UNIT_CHECK,
    'the criterion names the check its contract bound to it, not one inferred from a green result',
  );
  assert.equal(automated.state, 'unverified', 'nothing ran that check, so it is not a pass');
  assert.deepEqual(card.evidence, [], 'nothing observed this candidate yet, and that is said');
  assert.equal(card.ownerTests.length, 1);
  assert.deepEqual(card.staleness.staleEvidenceIds, []);
  assert.deepEqual(card.staleness.staleDecisionIds, []);
  assert.equal(card.decision.outcome, 'none');
  assert.equal(card.decision.decision, null);
  assert.equal(card.eligibility.readyForOwnerReview, false, 'an unverified criterion blocks the offer');
  assert.equal(card.eligibility.readyForAcceptance, false, 'and acceptance is gated too');
  assert.ok(
    card.eligibility.acceptanceBlockers.some((reason) => reason.includes(AUTOMATED_CRITERION_ID)),
    'the outstanding criterion is named, not merely counted',
  );
  assert.ok(card.collectedAt.length > 0);

  // The card is one object, so a client cannot assemble it from two reads that disagree about
  // whether the work is ready.
  assert.deepEqual(
    Object.keys(card).sort(),
    [
      'candidate',
      'checks',
      'collectedAt',
      'contract',
      'criteria',
      'decision',
      'eligibility',
      'evidence',
      'ownerTests',
      'policy',
      'request',
      'staleness',
    ],
    'the card carries these elements and nothing that would claim a merge, a deploy or a release',
  );

  // Every criterion the contract declares appears exactly once in `criteria`, once in
  // `ownerTests` if the owner owns it, and never in both lists under two names - a client
  // counting requirements must not find the same criterion twice or none at all.
  assert.deepEqual(
    card.criteria.map((criterion) => criterion.criterionId).sort(),
    [AUTOMATED_CRITERION_ID, OWNER_CRITERION_ID],
    'every declared criterion is on the card, once',
  );
  assert.deepEqual(
    card.ownerTests.map((criterion) => criterion.criterionId),
    [OWNER_CRITERION_ID],
    'the owner tests are the owner-owned criteria and no others',
  );
  for (const criterion of card.criteria) {
    assert.ok(criterion.description.length > 0, `${criterion.criterionId} carries the text it was declared with`);
    assert.ok(criterion.reason.length > 0, `${criterion.criterionId} says why it reads ${criterion.state}`);
  }

  // The three gates are separate answers rather than one flag, and the MVP reaches the first
  // two: `verified != accepted` and `accepted != merged` are only visible if they are distinct
  // (F24-AC3, F25-AC1).
  assert.equal(card.eligibility.readyForOwnerReview, false);
  assert.equal(card.eligibility.readyForAcceptance, false);
  assert.equal(card.eligibility.readyForDelivery, false);
  assert.ok(card.eligibility.deliveryBlockers.length > 0, 'delivery names what stands between this and delivered');
  for (const reason of [...card.eligibility.blockingReasons, ...card.eligibility.acceptanceBlockers]) {
    assert.ok(reason.length > 0, 'a blocker a client cannot read is not a blocker');
  }

  // Staleness is reported as a plain `false` rather than as an empty list a client has to
  // interpret, and no reason is invented for a candidate that is current.
  assert.equal(card.staleness.stale, false);
  assert.deepEqual(card.staleness.reasons, []);
});

/**
 * F24-AC2: every element the review card is required to carry, on a card that has them.
 *
 * The test above proves the elements exist on an *empty* candidate, which is the easy half:
 * an absent list and a list with nothing in it are the same shape, so a projection that
 * dropped a populated collection would still pass it. This one records an observation and an
 * owner test and a decision first, then asserts each required element is present *with its
 * content*, so a projection that returned the key and dropped the facts cannot pass.
 *
 * It asserts against the card the shipped entrypoint served, not against a fixture this file
 * assembled: the eleven elements are the transport's contract, and a mock that agreed with
 * itself would prove nothing about whether the real route serves them (mvp-spec 3, F24-AC2).
 */
test('F24-AC2: the review response carries all eleven required elements, with content', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  // Give the card something to carry: an owner observation bound to this exact commit, and a
  // recorded decision. Without these, `evidence` and `decision` are legitimately empty and
  // "present" would mean only "the key exists".
  h.recordOwnerTest({ evidenceId: 'evid-owner-pass', headSha: HEAD });
  const decided = await h.decide(decisionBody());
  assert.equal(decided.status, 200, decided.body);

  const { status, card, raw } = await h.review();
  assert.equal(status, 200, raw);
  assert.ok(card !== null, raw);

  // 1. The request the work answers.
  assert.equal(card.request.requestId, h.seed.requestId);
  assert.equal(card.request.projectId, PROJECT_ID);
  assert.equal(card.request.title, REQUEST_TITLE);

  // 2. The contract, and 3. the revision every criterion and decision binds to.
  assert.equal(card.contract.contractId, h.seed.contractId);
  assert.equal(card.contract.revision, 1);
  assert.equal(card.contract.status, 'approved');
  assert.deepEqual(
    card.contract.acceptanceCriteria.map((criterion) => criterion.id).sort(),
    [AUTOMATED_CRITERION_ID, OWNER_CRITERION_ID],
  );

  // 4. The criteria, each with a state rather than as a bare list of ids.
  assert.deepEqual(card.criteria.map((criterion) => criterion.criterionId).sort(), [AUTOMATED_CRITERION_ID, OWNER_CRITERION_ID]);
  for (const criterion of card.criteria) {
    assert.ok(criterion.state.length > 0, `${criterion.criterionId} carries a state`);
    assert.ok(criterion.reason.length > 0, `${criterion.criterionId} says why`);
  }

  // 5. The candidate, and 6. its full 40-character commit SHA - never abbreviated, never null.
  assert.equal(card.candidate.candidateId, CANDIDATE_ID);
  assert.equal(card.candidate.headSha, HEAD, 'the full SHA reaches the wire verbatim');
  assert.equal(card.candidate.headSha.length, 40, 'an abbreviation is not an identity (mvp-spec 3)');
  assert.match(card.candidate.headSha, /^[0-9a-f]{40}$/);

  // 7. The GitHub/check facts, passed through and never inferred (mvp-spec 3).
  assert.equal(card.candidate.pullRequestState, 'Open');
  assert.equal(card.candidate.pullRequestNumber, 42);
  assert.equal(card.candidate.repository, 'octopus/shop');
  assert.ok(Array.isArray(card.checks), 'the check list is an element, not an absence');
  assert.ok(Array.isArray(card.policy.requiredAutomatedCheckIds));

  // 8. The verification evidence, with content and with the three outcomes kept distinct.
  const ownerRow = card.evidence.find((row) => row.source === 'owner_test');
  assert.ok(ownerRow !== undefined, `the recorded observation must be on the card: ${raw}`);
  assert.equal(ownerRow.evidenceId, 'evid-owner-pass');
  assert.equal(ownerRow.recordedOutcome, 'passed');
  assert.equal(ownerRow.currentOutcome, 'passed');
  assert.equal(ownerRow.countsForCurrentCandidate, true, 'bound to this commit, so it counts');
  assert.equal(ownerRow.candidateHeadSha, HEAD, 'the row names the full commit it observed');
  assert.ok(
    !('outcome' in ownerRow),
    'there is no bare `outcome` to reach for by mistake, which is how a stale pass renders green (F20-AC3)',
  );

  // 9. The owner-test evidence, as its own list, carrying the owner's own step.
  const ownerTest = card.ownerTests.find((criterion) => criterion.criterionId === OWNER_CRITERION_ID);
  assert.ok(ownerTest !== undefined);
  assert.equal(ownerTest.state, 'passed', 'the owner recorded this test against this commit');
  assert.equal(ownerTest.evidenceId, 'evid-owner-pass', 'the owner test points at the owner observation');

  // 10. The stale states, as a stated answer rather than an empty list to interpret.
  assert.equal(card.staleness.stale, false);
  assert.ok(Array.isArray(card.staleness.staleEvidenceIds));
  assert.ok(Array.isArray(card.staleness.staleDecisionIds));

  // 11. Eligibility, as separate gates.
  assert.equal(typeof card.eligibility.readyForOwnerReview, 'boolean');
  assert.equal(typeof card.eligibility.readyForAcceptance, 'boolean');
  assert.equal(typeof card.eligibility.readyForDelivery, 'boolean');

  // 12. The current owner decision, with its full binding rather than a bare outcome string.
  assert.equal(card.decision.outcome, 'changes_requested');
  const decision = card.decision.decision;
  assert.ok(decision !== null);
  assert.equal(decision.kind, 'changes_requested');
  assert.equal(decision.candidateHeadSha, HEAD, 'the decision names the exact commit it was made against');
  assert.equal(decision.candidateHeadSha.length, 40);
  assert.equal(decision.candidateId, CANDIDATE_ID);
  assert.equal(decision.requestId, h.seed.requestId);
  assert.equal(decision.contractId, h.seed.contractId);
  assert.equal(decision.contractRevision, 1);
  assert.ok(decision.ownerId.length > 0, 'the decision names the owner who made it (F01-AC1)');
  assert.ok(decision.decidedAt.length > 0);

  // Every required element is a real top-level member of the served object, so a client cannot
  // be handed a card that satisfies this test only by reaching through another one.
  for (const element of [
    'request',
    'contract',
    'candidate',
    'checks',
    'criteria',
    'evidence',
    'ownerTests',
    'staleness',
    'decision',
    'eligibility',
  ]) {
    assert.ok(Object.hasOwn(card, element), `the served card must carry ${element}: ${Object.keys(card).join(', ')}`);
  }
});

test('mvp-spec 3: the provider state reaches the card verbatim, never normalised into open or closed', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  // A second candidate at the same commit but a different provider state. GitHub owns this
  // fact: a merged pull request is not a closed one and neither is an open one, and the card
  // has to say which rather than collapsing the difference (mvp-spec 3).
  expectOk(
    new DeliveryCandidateRepository(h.root.database).record({
      candidateId: 'cand-checkout-merged' as CandidateId,
      projectId: PROJECT_ID as ProjectId,
      requestId: h.seed.requestId,
      contractId: h.seed.contractId,
      contractRevision: h.seed.revision,
      provider: 'github',
      repository: 'octopus/shop',
      pullRequestNumber: 43,
      pullRequestUrl: 'https://example.invalid/octopus/shop/pull/43',
      baseBranch: 'main',
      baseSha: OLD_HEAD as CommitSha,
      headBranch: 'feature/checkout-total',
      headSha: HEAD as CommitSha,
      headRepository: 'octopus/shop',
      pullRequestState: 'Merged',
      draft: false,
      observedAt: NOW,
      correlationId: 'seed-candidate-merged',
    }),
    'a candidate whose pull request is merged',
  );

  const response = await h.reviewFor('cand-checkout-merged');
  assert.equal(response.status, 200, response.raw);
  assert.equal(
    response.card?.candidate.pullRequestState,
    'Merged',
    "the provider's own state, verbatim",
  );
  assert.notEqual(response.card?.candidate.pullRequestState, 'Open', 'a merged pull request is not open');
  assert.notEqual(response.card?.candidate.pullRequestState, 'Closed', 'and not closed either');

  // The card's state type is a plain string rather than the domain's closed vocabulary,
  // which is what makes pass-through possible at all: a projection typed to the enum could
  // only re-state a state it already knew. This is the type that allows the honest answer
  // when the adapter reports something the product has no name for (mvp-spec 3).
  const open = await h.review();
  assert.equal(open.card?.candidate.pullRequestState, 'Open');
  assert.equal(open.card?.candidate.headSha, HEAD, 'the two candidates are distinguished by their state alone');
});

test('F23-AC1, F24-AC3: an owner test is pending until the owner acts, and only the owner can settle it', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const before = await h.review();
  const ownerTest = before.card?.ownerTests[0];
  assert.ok(ownerTest !== undefined);
  assert.equal(ownerTest.criterionId, OWNER_CRITERION_ID);
  assert.equal(ownerTest.state, 'pending', 'nobody but the owner may discharge an owner test');
  assert.equal(ownerTest.evidenceId, null);
  assert.equal(ownerTest.observedAt, null);

  const criterion = before.card?.criteria.find((entry) => entry.criterionId === OWNER_CRITERION_ID);
  assert.ok(criterion !== undefined);
  assert.equal(criterion.state, 'pending', 'the criterion reads pending, never passed');
  assert.notEqual(criterion.state, 'passed');
  assert.equal(criterion.verificationType, 'owner_test');

  assert.equal(before.card?.eligibility.readyForAcceptance, false, 'acceptance is gated');
  assert.equal(
    before.card?.eligibility.ownerActions.length,
    1,
    'the owner is told what is theirs to do, and it is the owner test',
  );

  // An automated result cannot stand in for the owner's own step either.
  h.recordOwnerTest({ evidenceId: 'evid-owner-pass', headSha: HEAD });
  const after = await h.review();
  assert.equal(after.card?.ownerTests[0]?.state, 'passed');
  assert.equal(after.card?.ownerTests[0]?.evidenceId, 'evid-owner-pass');
  assert.equal(
    after.card?.criteria.find((entry) => entry.criterionId === OWNER_CRITERION_ID)?.state,
    'passed',
    'the owner observation discharges the owner test and nothing else',
  );
  assert.equal(
    after.card?.criteria.find((entry) => entry.criterionId === AUTOMATED_CRITERION_ID)?.state,
    'unverified',
    'the automated criterion is still unverified, because its bound check has not run',
  );
});

test('F24-AC3: a pending owner test is offered as the owner\'s action, not as a blocker of the review', async (t) => {
  const h = await harness({ content: OWNER_ONLY_CONTENT });
  t.after(() => h.close());

  const { status, card, raw } = await h.review();
  assert.equal(status, 200, raw);
  assert.ok(card !== null);

  assert.equal(card.ownerTests[0]?.state, 'pending');
  assert.equal(card.ownerTests.length, 1);
  assert.equal(
    card.eligibility.readyForOwnerReview,
    true,
    'an owner test nobody has run does not withhold the review offer',
  );
  assert.equal(
    card.eligibility.readyForAcceptance,
    false,
    'and it does withhold acceptance, which is the stricter gate (F24-AC3)',
  );
  assert.equal(card.eligibility.ownerActions.length, 1, 'the owner is told what is theirs to do');
  assert.equal(card.eligibility.acceptanceBlockers.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Staleness                                                                  */
/* -------------------------------------------------------------------------- */

test('F20-AC3, F24-AC3: a result recorded against another commit is history, never a current pass', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  // The owner's test ran against the commit before the push. The row is bound to that commit,
  // which is what makes it history rather than a verdict on what is on screen.
  h.recordOwnerTest({ evidenceId: 'evid-old-commit', headSha: OLD_HEAD });

  const { status, card, raw } = await h.review();
  assert.equal(status, 200, raw);
  assert.ok(card !== null);

  const evidence = card.evidence.find((row) => row.evidenceId === 'evid-old-commit');
  assert.ok(evidence !== undefined, 'the older observation is shown rather than dropped');
  assert.equal(evidence.recordedOutcome, 'passed', 'what the source said at the time is history');
  assert.equal(evidence.currentOutcome, 'stale', 'and it is stale for the candidate on screen');
  assert.equal(evidence.countsForCurrentCandidate, false);
  assert.ok(evidence.staleReasons.length > 0, 'why it no longer counts is named, not implied');
  assert.equal(evidence.candidateHeadSha, OLD_HEAD, 'the commit it observed travels with it');

  // No row anywhere on the card may expose a bare `outcome` for a client to render as current.
  for (const row of card.evidence) {
    assert.equal(
      'outcome' in row,
      false,
      `evidence ${row.evidenceId} carries a bare outcome, which is the field a stale pass renders from`,
    );
    if (row.countsForCurrentCandidate) {
      assert.notEqual(row.currentOutcome, 'stale', 'a row cannot both count and read stale');
      assert.equal(row.candidateHeadSha, card.candidate.headSha, 'a counting row names the candidate head');
    } else {
      assert.equal(row.currentOutcome, 'stale');
      assert.ok(row.staleReasons.length > 0);
    }
  }

  assert.equal(card.staleness.stale, true, 'the card says plainly that it is stale');
  assert.deepEqual(card.staleness.staleEvidenceIds, ['evid-old-commit']);
  assert.equal(
    card.ownerTests[0]?.state,
    'stale',
    'and the owner test it spoke for does not read as passed',
  );
  assert.notEqual(card.ownerTests[0]?.state, 'passed');
  assert.equal(card.eligibility.readyForAcceptance, false, 'a stale pass does not open the gate');
});

test('F25-AC3, F27-AC3: an acceptance of an earlier commit governs nothing, and the owner still sees it happened', async (t) => {
  const h = await harness({ content: OWNER_ONLY_CONTENT });
  t.after(() => h.close());

  h.recordOwnerTest({ evidenceId: 'evid-owner-pass', headSha: HEAD });
  // The owner accepted the commit before the one now on screen. That is the state a push
  // leaves behind: the decision row binds a commit the candidate is no longer on.
  h.recordAcceptanceFor({ decisionId: 'dec-superseded', headSha: OLD_HEAD });

  const { status, card, raw } = await h.review();
  assert.equal(status, 200, raw);
  assert.ok(card !== null);

  assert.equal(card.decision.outcome, 'none', 'an acceptance of another commit governs nothing');
  assert.equal(card.decision.decision, null);
  assert.equal(
    card.decision.authorizesCurrentCandidate,
    false,
    'and it authorises nothing either (F27-AC3)',
  );
  const stale = card.decision.staleDecisions;
  assert.equal(stale.length, 1, 'the owner still sees that they accepted something');
  assert.equal(stale[0]?.kind, 'accepted');
  assert.equal(stale[0]?.candidateHeadSha, OLD_HEAD, 'the superseded commit is named');
  assert.equal(stale[0]?.contractRevision, 1);
  assert.ok((stale[0]?.reason ?? '').length > 0, 'and the reason it no longer applies is stated');
  assert.deepEqual(card.staleness.staleDecisionIds, [stale[0]?.decisionId]);

  // Every criterion is satisfied for the commit on screen, so the gate a client acts on is the
  // card's `readyForAcceptance` - and the delivery gate says why this candidate is not yet
  // authorised, naming the superseded acceptance rather than dropping it.
  assert.equal(card.eligibility.readyForAcceptance, true);
  assert.equal(card.eligibility.readyForDelivery, false, 'accepted is not merged, and nothing deploys');
  assert.ok(
    card.eligibility.deliveryBlockers.some((reason) => reason.includes('dec-superseded')),
    `the superseded acceptance is named as a delivery blocker: ${JSON.stringify(card.eligibility.deliveryBlockers)}`,
  );
});

test('F25-AC1, F25-AC2: an acceptance binds the commit it was made against and authorises nothing else', async (t) => {
  const h = await harness({ content: OWNER_ONLY_CONTENT });
  t.after(() => h.close());

  h.recordOwnerTest({ evidenceId: 'evid-owner-pass', headSha: HEAD });
  const accepted = await h.decide(decisionBody({ decision: 'accepted', feedback: null }));
  assert.equal(accepted.status, 200, accepted.body);
  const current = parse<{ review: MvpReviewCardView }>({ body: accepted.body }).review;
  assert.equal(current.decision.outcome, 'accepted');
  assert.equal(current.decision.authorizesCurrentCandidate, true);
  assert.deepEqual(current.decision.staleDecisions, [], 'nothing superseded it');

  // The same decision read back through the card: it names the exact commit, and the owner is
  // shown it rather than having a client infer it.
  const read = await h.review();
  assert.equal(read.card?.decision.outcome, 'accepted');
  assert.equal(read.card?.decision.decision?.candidateHeadSha, HEAD);
  assert.equal(read.card?.decision.decision?.contractRevision, 1);
  assert.ok((read.card?.decision.decision?.ownerId ?? '').length > 0, 'the decision names its owner');
});

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

test('F24-AC4, F25-AC3: a decision prepared against an earlier commit is refused, not applied to the head on screen', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const refused = await h.decide(
    decisionBody({ expectedHeadSha: OLD_HEAD, feedback: 'Reviewed against a commit this candidate is no longer on.' }),
  );
  assert.equal(refused.status, 409, refused.body);
  const problem = problemOf(refused.body);
  assert.equal(problem.error.code, 'Conflict');
  assert.equal(problem.error.expected, OLD_HEAD, 'the refusal names both identities');
  assert.equal(problem.error.actual, HEAD);

  const unchanged = await h.review();
  assert.equal(unchanged.card?.decision.outcome, 'none', 'a refused submission leaves no decision behind');
  assert.deepEqual(unchanged.card?.decision.staleDecisions, []);

  // A revision that is not the current one is the same refusal.
  const movedRevision = await h.decide(decisionBody({ expectedContractRevision: 2 }));
  assert.equal(movedRevision.status, 409, movedRevision.body);

  // And a submission naming something that is not a commit at all never reaches the use case.
  for (const value of ['main', OLD_HEAD.slice(0, 7), '42', '']) {
    const response = await h.decide(decisionBody({ expectedHeadSha: value }));
    assert.equal(response.status, 400, `"${value}" must not be accepted as a commit: ${response.body}`);
    assert.notEqual(fieldMessages(problemOf(response.body), 'expectedHeadSha'), '');
  }
});

test('F24-AC4, F25-AC3: a changed SHA rejects an acceptance, and the rejection is the conflict rather than a report about the new head', async (t) => {
  const h = await harness({ content: OWNER_ONLY_CONTENT });
  t.after(() => h.close());

  // The card the owner rendered and accepted was eligible: the owner test ran against HEAD.
  h.recordOwnerTest({ evidenceId: 'evid-owner-pass', headSha: HEAD });
  const ready = await h.review();
  assert.equal(ready.card?.eligibility.readyForAcceptance, true, 'the card the owner looked at was eligible');

  // Submitting that acceptance a second time, still naming HEAD, is recorded: this is the
  // baseline, so what follows can only be about staleness.
  const accepted = await h.decide(decisionBody({ decision: 'accepted', feedback: null }));
  assert.equal(accepted.status, 200, accepted.body);

  // An acceptance naming the commit before it is a conflict, and it names both identities.
  const staleSha = await h.decide(
    decisionBody({ decision: 'accepted', expectedHeadSha: OLD_HEAD, feedback: null }),
  );
  assert.equal(staleSha.status, 409, `an acceptance of another commit must conflict: ${staleSha.body}`);
  const problem = problemOf(staleSha.body);
  assert.equal(problem.error.code, 'Conflict');
  assert.equal(problem.error.expected, OLD_HEAD, 'the refusal names the commit that was submitted');
  assert.equal(problem.error.actual, HEAD, 'and the commit the candidate is actually on');

  // The refusal must not have become a decision about the head on screen. The acceptance
  // already recorded for HEAD is the governing one, and nothing was added to it.
  const afterStale = await h.review();
  assert.equal(afterStale.card?.decision.outcome, 'accepted');
  assert.equal(afterStale.card?.decision.decision?.candidateHeadSha, HEAD);
  assert.deepEqual(afterStale.card?.decision.staleDecisions, [], 'no decision was made for another commit');

  // A revision that is not the current one is the same refusal, so a moved revision cannot
  // ride through the accept gate either.
  const staleRevision = await h.decide(
    decisionBody({ decision: 'accepted', expectedContractRevision: 2, feedback: null }),
  );
  assert.equal(staleRevision.status, 409, staleRevision.body);
  assert.equal(problemOf(staleRevision.body).error.code, 'Conflict');
});

test('F24-AC4: a push moves the ground under an acceptance, and the owner must look again', async (t) => {
  const h = await harness({ content: OWNER_ONLY_CONTENT });
  t.after(() => h.close());

  // The owner runs their test and accepts, against HEAD.
  h.recordOwnerTest({ evidenceId: 'evid-owner-pass', headSha: HEAD });
  const accepted = await h.decide(decisionBody({ decision: 'accepted', feedback: null }));
  assert.equal(accepted.status, 200, accepted.body);
  assert.equal(
    parse<{ review: MvpReviewCardView }>({ body: accepted.body }).review.decision.authorizesCurrentCandidate,
    true,
    'the acceptance authorises the commit it was made against',
  );

  // A push lands: the same pull request at a new commit, which the store records as a new
  // candidate identity.
  h.push({ candidateId: 'cand-checkout-pushed', headSha: PUSHED_HEAD });

  const pushed = await h.reviewFor('cand-checkout-pushed');
  assert.equal(pushed.status, 200, pushed.raw);
  assert.equal(pushed.card?.candidate.headSha, PUSHED_HEAD);
  assert.equal(
    pushed.card?.decision.outcome,
    'none',
    'the acceptance of the earlier commit governs nothing here (F25-AC3)',
  );
  assert.equal(
    pushed.card?.decision.authorizesCurrentCandidate,
    false,
    'and it authorises nothing, so no delivery gate may read it as permission (F27-AC3)',
  );
  assert.equal(
    pushed.card?.ownerTests[0]?.state,
    'pending',
    'the owner test run against the earlier commit does not settle this one (F25-AC1)',
  );
  assert.equal(
    pushed.card?.eligibility.readyForAcceptance,
    false,
    'and the new commit has nothing verified against it yet',
  );

  // The old page's acceptance is refused against the new commit, and the refusal names both.
  const stale = await h.decideOn(
    'cand-checkout-pushed',
    decisionBody({ decision: 'accepted', expectedHeadSha: HEAD, feedback: null }),
  );
  assert.equal(stale.status, 409, `an acceptance of the earlier commit must conflict: ${stale.body}`);
  const conflict = problemOf(stale.body);
  assert.equal(conflict.error.code, 'Conflict');
  assert.equal(conflict.error.expected, HEAD);
  assert.equal(conflict.error.actual, PUSHED_HEAD, 'the refusal names the commit now on screen');

  // Nothing was recorded against the new commit, and an acceptance naming the new commit
  // is still refused on its own merits rather than quietly accepted off the old evidence.
  const stillNone = await h.reviewFor('cand-checkout-pushed');
  assert.equal(stillNone.card?.decision.outcome, 'none');
  assert.equal(stillNone.card?.decision.decision, null);
  const onTheNewCommit = await h.decideOn(
    'cand-checkout-pushed',
    decisionBody({ decision: 'accepted', expectedHeadSha: PUSHED_HEAD, feedback: null }),
  );
  assert.equal(
    onTheNewCommit.status,
    422,
    `the new commit still needs its own owner test: ${onTheNewCommit.body}`,
  );
  assert.equal(problemOf(onTheNewCommit.body).error.code, 'Blocked');

  // And the earlier acceptance is still visible on its own commit, rather than retracted by
  // the push: history is history, and the owner can see both facts.
  const original = await h.review();
  assert.equal(original.card?.candidate.headSha, HEAD);
  assert.equal(original.card?.decision.outcome, 'accepted');
  assert.equal(original.card?.decision.authorizesCurrentCandidate, true);
});

test('F25-AC2: the recorded decision binds the exact commit, revision and kind that were submitted', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const requested = await h.decide(decisionBody());
  assert.equal(requested.status, 200, requested.body);
  const card = parse<{ review: MvpReviewCardView }>({ body: requested.body }).review;

  assert.equal(card.decision.outcome, 'changes_requested');
  const decision = card.decision.decision;
  assert.ok(decision !== null);
  assert.equal(decision.kind, 'changes_requested');
  assert.equal(decision.candidateHeadSha, HEAD, 'the decision names the commit it was made against');
  assert.equal(decision.candidateId, CANDIDATE_ID);
  assert.equal(decision.requestId, h.seed.requestId);
  assert.equal(decision.contractId, h.seed.contractId);
  assert.equal(decision.contractRevision, 1);
  assert.equal(decision.feedback, 'The total is missing the tax line.');
  assert.ok(decision.decidedAt.length > 0, 'and the instant it was recorded');
  assert.equal(card.decision.authorizesCurrentCandidate, false, 'a change request authorises nothing');
});

test('F01-AC1, F25-AC4: the owner is the session, and a body that names one is refused by name', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  for (const field of ['ownerId', 'approver', 'decidedBy', 'actor', 'at', 'decidedAt']) {
    const response = await h.decide(decisionBody({ [field]: 'someone-else' }));
    assert.equal(response.status, 400, `${field} must be refused: ${response.body}`);
    const problem = problemOf(response.body);
    assert.equal(
      fieldMessages(problem, field),
      `"${field}" is not accepted here. Remove it or check the spelling.`,
      `the refusal must name ${field}: ${response.body}`,
    );
  }

  const unchanged = await h.review();
  assert.equal(unchanged.card?.decision.outcome, 'none', 'no refused body reached a decision');

  // The decision that does go through is attributed to the session, read back from the store.
  const recorded = await h.decide(decisionBody());
  assert.equal(recorded.status, 200, recorded.body);
  const card = parse<{ review: MvpReviewCardView }>({ body: recorded.body }).review;
  const owner = h.root.owners.current();
  assert.ok(owner.ok && owner.value !== null);
  assert.equal(card.decision.decision?.ownerId, String(owner.value.ownerId));
});

test('mvp-spec 3: only accepted and changes_requested are decidable', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  for (const value of ['merged', 'deployed', 'released', 'APPROVED', '', null, 1]) {
    const response = await h.decide(decisionBody({ decision: value }));
    assert.equal(response.status, 400, `${JSON.stringify(value)} must not be a decision: ${response.body}`);
    assert.notEqual(fieldMessages(problemOf(response.body), 'decision'), '');
  }

  const unchanged = await h.review();
  assert.equal(unchanged.card?.decision.outcome, 'none');
});

/**
 * F24-AC4: a conflict names the fact that actually moved.
 *
 * The status alone is not enough to pin this, because both failures answer 409 and the two
 * differ only in what the owner is told to go and look at. The interesting case is the one
 * where the commit did *not* move: naming the commit then reports `expected` and `actual` as
 * the same 40-character SHA, which is a conflict describing nothing, and sends the owner to
 * investigate a push that never happened while the revision that did move goes unmentioned.
 *
 * Both decisions are exercised, because the acceptance path reads the card before it reaches
 * the use case and the change-request path does not, so the two refusals are produced by
 * different code and either one could name the wrong fact alone.
 */
test('F24-AC4: a conflict names the fact that moved, not the one that stayed', async (t) => {
  const h = await harness({ content: OWNER_ONLY_CONTENT });
  t.after(() => h.close());

  // The commit on screen is current; only the revision named is not. The refusal must say so.
  const revisionOnly = await h.decide(
    decisionBody({ decision: 'accepted', expectedContractRevision: 2, feedback: null }),
  );
  assert.equal(revisionOnly.status, 409, revisionOnly.body);
  const revisionProblem = problemOf(revisionOnly.body);
  assert.equal(revisionProblem.error.code, 'Conflict');
  assert.equal(revisionProblem.error.expected, '2', 'the revision submitted is named as expected');
  assert.equal(revisionProblem.error.actual, '1', 'and the revision that is current as actual');
  assert.ok(
    /contract revision 2/.test(revisionProblem.error.message),
    `a moved revision must be named as such: ${revisionProblem.error.message}`,
  );
  assert.ok(
    !revisionProblem.error.message.includes(HEAD),
    `a refusal about the revision must not also claim the commit moved, which it did not: ${revisionProblem.error.message}`,
  );

  // The same submission as Request Changes, which reaches no card read and so is refused by
  // the use case instead. Both paths must agree on what the conflict says.
  const changesRevisionOnly = await h.decide(decisionBody({ expectedContractRevision: 2 }));
  assert.equal(changesRevisionOnly.status, 409, changesRevisionOnly.body);
  const changesProblem = problemOf(changesRevisionOnly.body);
  assert.equal(changesProblem.error.expected, '2');
  assert.equal(changesProblem.error.actual, '1');

  // And the commit case still names the commit, with the two identities actually differing -
  // the property the revision case above would have broken.
  const commitOnly = await h.decide(decisionBody({ decision: 'accepted', expectedHeadSha: OLD_HEAD, feedback: null }));
  assert.equal(commitOnly.status, 409, commitOnly.body);
  const commitProblem = problemOf(commitOnly.body);
  assert.equal(commitProblem.error.expected, OLD_HEAD);
  assert.equal(commitProblem.error.actual, HEAD);
  assert.notEqual(commitProblem.error.expected, commitProblem.error.actual);

  // Nothing above was recorded: a conflict is a refusal, not a decision.
  const unchanged = await h.review();
  assert.equal(unchanged.card?.decision.outcome, 'none');
  assert.deepEqual(unchanged.card?.decision.staleDecisions, []);
});

/**
 * F24-AC4: a decision bound to one commit is refused after the candidate moves to another.
 *
 * Asserted as the *sequence* rather than as one submission, because the two halves fail
 * differently and a test that only submits the stale SHA never reaches the state the first
 * half creates. A decision is a claim about one exact build, so an owner who accepted SHA A
 * cannot have that acceptance read as an acceptance of SHA B (F24-AC4, F25-AC3, F27-AC3).
 */
test('F24-AC4, F25-AC3: a decision bound to SHA A is refused once the candidate is at SHA B', async (t) => {
  const h = await harness({ content: OWNER_ONLY_CONTENT });
  t.after(() => h.close());

  // The owner renders an eligible card and accepts the build on screen.
  h.recordOwnerTest({ evidenceId: 'evid-owner-pass', headSha: HEAD });
  const rendered = await h.review();
  assert.equal(rendered.card?.candidate.headSha, HEAD, 'the card names the build it was rendered against');
  assert.equal(rendered.card?.eligibility.readyForAcceptance, true);

  const accepted = await h.decide(decisionBody({ decision: 'accepted', expectedHeadSha: HEAD, feedback: null }));
  assert.equal(accepted.status, 200, accepted.body);
  const bound = parse<{ review: MvpReviewCardView }>({ body: accepted.body }).review;
  assert.equal(bound.decision.decision?.candidateHeadSha, HEAD);
  assert.equal(bound.decision.authorizesCurrentCandidate, true);

  // The push lands. The same pull request, a new candidate identity, a new commit.
  h.push({ candidateId: 'cand-checkout-pushed', headSha: PUSHED_HEAD });

  // The decision the owner would now be submitting is the one bound to SHA A, and it is
  // refused against SHA B rather than applied to it.
  const stale = await h.decideOn(
    'cand-checkout-pushed',
    decisionBody({ decision: 'accepted', expectedHeadSha: HEAD, feedback: null }),
  );
  assert.equal(stale.status, 409, `an acceptance of SHA A must not become an acceptance of SHA B: ${stale.body}`);
  const problem = problemOf(stale.body);
  assert.equal(problem.error.code, 'Conflict');
  assert.equal(problem.error.expected, HEAD, 'the refusal names the commit the submission was prepared against');
  assert.equal(problem.error.actual, PUSHED_HEAD, 'and the commit the candidate is actually on');
  assert.deepEqual(
    problem.error.prerequisites ?? [],
    [],
    'a conflict carries no eligibility report, so it cannot be mistaken for a readiness answer',
  );

  // Nothing was decided on the new commit, and the acceptance of SHA A did not migrate to it.
  const moved = await h.reviewFor('cand-checkout-pushed');
  assert.equal(moved.card?.decision.outcome, 'none', 'a refused decision records nothing against SHA B');
  assert.equal(moved.card?.decision.decision, null);
  assert.equal(moved.card?.decision.authorizesCurrentCandidate, false, 'and SHA B is authorised by nothing');

  // SHA A still carries its own acceptance, on its own card: the push moved the ground under
  // the decision rather than retracting it (F25-AC3).
  const original = await h.review();
  assert.equal(original.card?.decision.decision?.candidateHeadSha, HEAD);
  assert.equal(original.card?.decision.authorizesCurrentCandidate, true);
});

test('F23-AC1, F25-AC2: Accept is gated on the card\'s own eligibility, and Request Changes is always permitted', async (t) => {
  const h = await harness({ content: OWNER_ONLY_CONTENT });
  t.after(() => h.close());

  const blocked = await h.decide(decisionBody({ decision: 'accepted', feedback: null }));
  assert.equal(blocked.status, 422, blocked.body);
  const problem = problemOf(blocked.body);
  assert.equal(problem.error.code, 'Blocked');
  assert.ok(
    (problem.error.prerequisites ?? []).length > 0,
    'the outstanding requirements are named, so the owner learns what to do',
  );
  assert.ok(
    (problem.error.prerequisites ?? []).some((entry) => entry.detail.includes(OWNER_CRITERION_ID)),
    `the outstanding owner test is named: ${blocked.body}`,
  );

  // A stale submission is a conflict even while the card is ineligible. Answering it with
  // this head's outstanding requirements would tell the owner to discharge them on a commit
  // their submission is not about, and would never mention that the ground moved (F24-AC4).
  const stale = await h.decide(
    decisionBody({ decision: 'accepted', expectedHeadSha: OLD_HEAD, feedback: null }),
  );
  assert.equal(stale.status, 409, `a stale acceptance must conflict, not report eligibility: ${stale.body}`);
  const staleProblem = problemOf(stale.body);
  assert.equal(staleProblem.error.code, 'Conflict');
  assert.equal(staleProblem.error.expected, OLD_HEAD);
  assert.equal(staleProblem.error.actual, HEAD);
  assert.deepEqual(
    staleProblem.error.prerequisites ?? [],
    [],
    'and it carries no eligibility report, because eligibility is a question about the current head',
  );

  const afterBlocked = await h.review();
  assert.equal(afterBlocked.card?.decision.outcome, 'none', 'a refused acceptance records nothing');

  const requested = await h.decide(decisionBody());
  assert.equal(requested.status, 200, 'request changes is available while acceptance is refused');
  assert.equal(parse<{ review: MvpReviewCardView }>({ body: requested.body }).review.decision.outcome, 'changes_requested');

  // Once the owner has run the test, acceptance is permitted and supersedes the change request
  // they made before it, because it is the later decision.
  h.recordOwnerTest({ evidenceId: 'evid-owner-pass', headSha: HEAD });
  h.advance(60);
  const ready = await h.review();
  assert.equal(ready.card?.eligibility.readyForAcceptance, true, 'the card now says it is eligible');

  const accepted = await h.decide(decisionBody({ decision: 'accepted', feedback: null }));
  assert.equal(accepted.status, 200, accepted.body);
  const card = parse<{ review: MvpReviewCardView }>({ body: accepted.body }).review;
  assert.equal(card.decision.outcome, 'accepted');
  assert.equal(card.decision.decision?.candidateHeadSha, HEAD);
  assert.equal(card.decision.authorizesCurrentCandidate, true);

  // Nothing here merges or deploys: there is no route for it and no field on the card (mvp-spec 3).
  const merged = await h.decide(decisionBody({ decision: 'merged', feedback: null }));
  assert.equal(merged.status, 400);
});

/* -------------------------------------------------------------------------- */
/* Authorization                                                              */
/* -------------------------------------------------------------------------- */

/**
 * F23-AC1, F24-AC3: readiness cannot be bypassed, and the refusal is the product's answer.
 *
 * The transport gate and the use-case gate are two refusals for one rule, and the risk is
 * that one of them is not there: an acceptance that reached the store on an ineligible card
 * would be a recorded acceptance of work nobody verified, which no later check can undo. So
 * this asserts both — that the HTTP answer is 422 with the outstanding requirements named, and
 * that nothing was written — and then asserts the eligibility *itself* says the card is not
 * ready, so a client cannot read `readyForAcceptance` as a hint the 422 contradicts.
 *
 * Every path that could plausibly carry an acceptance around the gate is driven: the direct
 * accept, the accept of a candidate whose commit never had an observation, and the accept of a
 * card whose criteria are unmet in the other direction (F25-AC2).
 */
test('F23-AC1, F24-AC3: an acceptance on unmet criteria is refused, and readiness is not bypassed', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  // The card says so itself, before anything is submitted. A 422 that contradicted the card's
  // own `readyForAcceptance` would leave the client unable to know which one to believe.
  const card = await h.review();
  assert.equal(card.card?.eligibility.readyForAcceptance, false, 'the card declares itself not eligible');
  assert.ok(
    card.card?.eligibility.acceptanceBlockers.some((reason) => reason.includes(AUTOMATED_CRITERION_ID)),
    `the unmet criterion is named on the card: ${JSON.stringify(card.card?.eligibility.acceptanceBlockers)}`,
  );

  const refused = await h.decide(decisionBody({ decision: 'accepted', feedback: null }));
  assert.equal(refused.status, 422, `an acceptance on unmet criteria must be refused: ${refused.body}`);
  const problem = problemOf(refused.body);
  assert.equal(problem.error.code, 'Blocked');
  assert.ok(
    (problem.error.prerequisites ?? []).some((entry) => entry.detail.includes(AUTOMATED_CRITERION_ID)),
    `the 422 names what to discharge, so readiness is a direction and not a wall: ${refused.body}`,
  );

  // Nothing was written: a refused acceptance must not leave a decision the owner did not make.
  const unchanged = await h.review();
  assert.equal(unchanged.card?.decision.outcome, 'none', 'the refused acceptance recorded nothing');
  assert.equal(unchanged.card?.decision.decision, null);
  assert.deepEqual(unchanged.card?.decision.staleDecisions, []);
  assert.equal(unchanged.card?.decision.authorizesCurrentCandidate, false, 'and nothing was authorised');

  // The same card accepts once the criterion it names is satisfied, which is what makes the
  // refusal above about readiness rather than about acceptance being unavailable (F25-AC1).
  h.recordOwnerTest({ evidenceId: 'evid-owner-pass', headSha: HEAD });
  const stillBlocked = await h.review();
  assert.equal(
    stillBlocked.card?.eligibility.readyForAcceptance,
    false,
    'the automated criterion is still unmet: satisfying only the owner test does not open acceptance',
  );
  const stillRefused = await h.decide(decisionBody({ decision: 'accepted', feedback: null }));
  assert.equal(stillRefused.status, 422, stillRefused.body);
});

/**
 * F24-AC4, F25-AC3: a change request against a stale commit is refused.
 *
 * Request Changes is always permitted, which is exactly why its staleness handling has to be
 * asserted separately: a change request that was allowed to ride a moved ground would record
 * feedback against a build the owner was no longer looking at, and the next fix pass would be
 * working from an instruction about the wrong commit (F25-AC2).
 *
 * Both facts are exercised — the commit and the revision — because they are two comparisons,
 * and "stale" being refused in general does not show either one is checked.
 */
test('F24-AC4, F25-AC3: a change request against a stale commit or revision is refused', async (t) => {
  const h = await harness({ content: OWNER_ONLY_CONTENT });
  t.after(() => h.close());

  const staleCommit = await h.decide(decisionBody({ expectedHeadSha: OLD_HEAD }));
  assert.equal(staleCommit.status, 409, `a change request for an earlier commit must conflict: ${staleCommit.body}`);
  const commitProblem = problemOf(staleCommit.body);
  assert.equal(commitProblem.error.code, 'Conflict');
  assert.equal(commitProblem.error.expected, OLD_HEAD);
  assert.equal(commitProblem.error.actual, HEAD);
  assert.notEqual(commitProblem.error.expected, commitProblem.error.actual);

  const staleRevision = await h.decide(decisionBody({ expectedContractRevision: 3 }));
  assert.equal(staleRevision.status, 409, staleRevision.body);
  const revisionProblem = problemOf(staleRevision.body);
  assert.equal(revisionProblem.error.code, 'Conflict');
  assert.equal(revisionProblem.error.expected, '3');
  assert.equal(revisionProblem.error.actual, '1');

  // Neither recorded anything, so the refusals above did not decide on the way out.
  const unchanged = await h.review();
  assert.equal(unchanged.card?.decision.outcome, 'none', 'a stale change request records nothing');
  assert.deepEqual(unchanged.card?.decision.staleDecisions, []);

  // And the current submission of the same kind is recorded, so the refusals are about
  // staleness rather than about Request Changes being unavailable (F25-AC2).
  const current = await h.decide(decisionBody());
  assert.equal(current.status, 200, current.body);
  const card = parse<{ review: MvpReviewCardView }>({ body: current.body }).review;
  assert.equal(card.decision.outcome, 'changes_requested');
  assert.equal(card.decision.decision?.candidateHeadSha, HEAD);
  assert.equal(card.decision.authorizesCurrentCandidate, false, 'a change request authorises nothing (F27-AC3)');
});

test('F02-AC2: a candidate is addressed by its own project, never by id alone', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  // The other project is not merely a string this one does not recognise: it is a project
  // that genuinely exists, with its own request, its own approved revision and its own
  // candidate. That is what makes this the isolation case rather than a 404-on-typo case -
  // the id resolves, the facts are all there, and the candidate under review belongs to a
  // different project than the path named (F02-AC2).
  const other = await h.seedProject(OTHER_PROJECT_ID);
  h.recordCandidate({ candidateId: other.candidateId, projectId: OTHER_PROJECT_ID, seed: other });

  const read = await h.readReview(OTHER_PROJECT_ID);
  assert.equal(read.status, 404, `another project's path must find nothing: ${read.body}`);
  const readProblem = problemOf(read.body);
  assert.equal(readProblem.error.code, 'NotFound');
  // The refusal is checked for the specific reason as well as the status: a project-keyed
  // lookup answered by the request store also returns 404, so a status assertion alone would
  // pass even if the candidate boundary were removed and the request read happened to fail
  // first. Naming the candidate is what distinguishes the two.
  assert.match(
    readProblem.error.message,
    /holds no candidate cand-checkout/,
    `the refusal must come from the candidate's own project, not from a later read: ${readProblem.error.message}`,
  );
  assert.ok(
    !readProblem.error.message.includes(HEAD),
    `the refusal must not describe the candidate it hid: ${readProblem.error.message}`,
  );

  // Request Changes reaches no eligibility gate, so this case proves the project scoping is in
  // the decision path and not only on the read.
  const decided = await h.decideIn(OTHER_PROJECT_ID, decisionBody());
  assert.equal(decided.status, 404, decided.body);
  assert.equal(problemOf(decided.body).error.code, 'NotFound');

  const accepted = await h.decideIn(OTHER_PROJECT_ID, decisionBody({ decision: 'accepted', feedback: null }));
  assert.equal(accepted.status, 404, accepted.body);

  // And a candidate id that exists under the *other* project is refused when reached through
  // this project's path: the reverse direction of the same boundary, and the one a lookup by
  // id alone would get wrong.
  const across = await h.reviewFor(other.candidateId);
  assert.equal(across.status, 404, `another project's candidate must not be read here: ${across.raw}`);
  assert.equal(across.card, null, 'and no card comes back');
  assert.match(
    across.raw,
    /holds no candidate checkout-other-candidate/,
    `the same boundary, in the other direction: ${across.raw}`,
  );

  const decidedAcross = await h.decideOn(other.candidateId, decisionBody());
  assert.equal(decidedAcross.status, 404, decidedAcross.body);

  // Nothing was reached from across the boundary, in either direction.
  const unchanged = await h.review();
  assert.equal(unchanged.card?.decision.outcome, 'none', 'nothing was decided from across the boundary');
  assert.deepEqual(unchanged.card?.decision.staleDecisions, []);
  // Read through the other project's own path, which is the only way to see its card: the
  // refusal above is what makes this the honest place to check that nothing was decided.
  const otherCard = await h.readReviewAs(OTHER_PROJECT_ID, other.candidateId);
  assert.equal(otherCard.status, 200, `the other project's own card must still read: ${otherCard.body}`);
  assert.equal(
    parse<{ review: MvpReviewCardView }>({ body: otherCard.body }).review.decision.outcome,
    'none',
    'and the other project was not decided from across the boundary',
  );
});

test('mvp-spec 3, F03-AC5: this file registers the two review routes and nothing that merges or deploys', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  // Both paths the contract names exist, at the exact method each one is read or written by.
  // `hasRoute` rather than this file's own constants, so a route registered anywhere in the
  // app is visible here.
  for (const route of [
    { method: 'GET', url: '/api/projects/:projectId/candidates/:candidateId/review' },
    { method: 'POST', url: '/api/projects/:projectId/candidates/:candidateId/decision' },
  ]) {
    assert.ok(
      h.app.hasRoute({ method: route.method as 'GET', url: route.url }),
      `${route.method} ${route.url} must be registered`,
    );
  }

  // And no candidate-scoped route anywhere in the app merges, deploys, publishes or releases.
  // Scoped to the candidate subtree on purpose: this file owns the review step of the MVP
  // journey, and the journey ends at Accepted or Changes Requested (mvp-spec 3, F03-AC5).
  const candidateTree = h.app
    .printRoutes({ commonPrefix: false })
    .split('\n')
    .filter((line) => line.includes('candidates'))
    .join('\n');
  assert.ok(candidateTree.length > 0, 'the candidate subtree must exist for this assertion to mean anything');
  for (const forbidden of ['/merge', '/deploy', '/release', '/publish', '/revert', '/accept']) {
    assert.equal(
      candidateTree.includes(forbidden),
      false,
      `a candidate route named ${forbidden} exists, and the MVP journey ends at the owner decision`,
    );
  }

  // No verb on either path writes to a provider, and none exists at all for merge, deploy,
  // release or anything past the owner decision. The MVP ends at Accepted or Changes
  // Requested (mvp-spec 3).
  const attempts: readonly { readonly method: string; readonly url: string }[] = [
    { method: 'PUT', url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/review` },
    { method: 'DELETE', url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/decision` },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/merge` },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/deploy` },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/release` },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/review` },
    { method: 'GET', url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/decision` },
  ];
  for (const attempt of attempts) {
    const response = await h.app.inject({
      method: attempt.method as 'PUT',
      url: attempt.url,
      headers: { cookie: h.session.cookie, [CSRF_HEADER]: h.session.csrfToken },
      payload: {},
    });
    assert.equal(response.statusCode, 404, `${attempt.method} ${attempt.url} must not exist: ${response.body}`);
  }

  // The unscoped spellings the previous wave invented must not exist either.
  for (const url of ['/api/review', '/api/candidates/review', '/api/projects/review', `/api/review/${CANDIDATE_ID}`]) {
    const response = await h.app.inject({ method: 'GET', url, headers: { cookie: h.session.cookie } });
    assert.equal(response.statusCode, 404, `${url} must not exist: ${response.body}`);
  }

  // Nothing above recorded a decision.
  const unchanged = await h.review();
  assert.equal(unchanged.card?.decision.outcome, 'none');
});

test('F01-AC1, F01-AC4: an anonymous caller and a request without the session token are both refused', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const anonymous = await h.readReviewAnonymously();
  assert.equal(anonymous.status, 401, anonymous.body);
  assert.equal(problemOf(anonymous.body).signInRequired, true);

  const withoutToken = await h.decideWithoutCsrf(decisionBody());
  assert.equal(withoutToken.status, 403, withoutToken.body);
  assert.equal(problemOf(withoutToken.body).error.code, 'Forbidden');

  const unchanged = await h.review();
  assert.equal(unchanged.card?.decision.outcome, 'none');
});