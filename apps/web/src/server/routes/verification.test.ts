/**
 * The two evidence write paths, over HTTP against the real controller.
 *
 * `api.test.ts` proves the transport's shape against a double, and a double cannot answer the
 * questions these routes exist to answer. Whether a body can hand the server a passing criterion,
 * whether a check reported for an older commit renders green, and whether an owner test can be
 * settled against a criterion it does not belong to are all properties of the real projection and
 * of the boundary in front of it. So this file boots the real composition root over a real
 * migrated SQLite file - the same root `main.ts` composes, bound to the same `ControllerSurface`
 * the web package declares - and drives it with `app.inject()`, with no listener and no port.
 *
 * What each test pins, and the wrong answer it removes:
 *
 *   - **A browser cannot state a result.** Every field through which a client could assert a
 *     verdict is sent and refused *by name*, and the card afterwards is still unverified. A
 *     silently-dropped field would leave a client believing it chose the outcome (F20-AC2).
 *   - **Identity is the full SHA on both paths.** A branch name, an abbreviation and a pull
 *     request number are refused, and a recorded row carries 40 characters (mvp-spec 3, F20-AC3).
 *   - **A stale result cannot be rendered as current.** Every row is walked rather than
 *     spot-checked, because the failure mode is a row a client could render green (F20-AC3).
 *   - **The owner is the session.** A body naming an owner or an instant is refused by name, and
 *     the recorded row is attributed to the session that made it (F01-AC1, F25-AC4).
 *   - **An owner test cannot discharge an automated criterion**, and an automated criterion that
 *     no check is bound to cannot be reached through either route (F23-AC1).
 *   - **The project boundary is server-side**, and an anonymous caller and a request without the
 *     session's forgery token are both refused (F02-AC2, F01-AC1, F01-AC4).
 *
 * The candidate row is written through the delivery candidate store, because linking one needs a
 * GitHub credential the MVP is not allowed to require. The automated cases drive the real
 * `candidateLinkUseCases` through a configured git provider whose transport answers with scripted
 * provider facts, so the verdicts under test are produced by the provider read rather than
 * asserted here.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SESSION_COOKIE_NAME } from '@shiploop/domain';
import type {
  CandidateId,
  CapabilityDeclaration,
  CapabilityKind,
  CheckResult,
  CommitSha,
  DomainError,
  ProjectId,
  Result,
} from '@shiploop/domain';
import type { FastifyInstance } from 'fastify';
import type { ConnectorKind } from '@shiploop/storage';
import { DeliveryCandidateRepository } from '@shiploop/storage';
import {
  bindControllerSurface,
  createCompositionRoot,
  type AdapterRegistry,
  type CompositionRoot,
} from '@shiploop/controller';
/**
 * The registry's own type, read off the composition configuration that accepts it.
 *
 * Reached this way rather than imported because the controller's public entry point deliberately
 * does not export the provider registry: `composition.ts` builds it, and widening a package's
 * published surface so a test can name a type would be a change to what consumers can reach. This
 * keeps the fixture's type honest - it is exactly what the composition config accepts, so a member
 * the production root does not read cannot be faked into existence here.
 */
type ProviderRegistry = NonNullable<Parameters<typeof createCompositionRoot>[0]['providers']>;
import { buildApp } from '../app.ts';
import { CSRF_HEADER } from '../auth-guard.ts';
import { readServerConfig } from '../config.ts';
import type {
  ContractView,
  ControllerSurface,
  MvpOwnerTestReportView,
  MvpReviewCardView,
  MvpVerificationReportView,
  RequestView,
} from '../contracts.ts';

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
/** The commit a push produces. Also a full SHA. */
const NEXT_HEAD = 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5';
const BASE_SHA = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';

/**
 * No provider is configured unless a case asks for one.
 *
 * The MVP journey must work with none (mvp-spec MVP), so the owner path is exercised here with the
 * same empty registry `routes/review.test.ts` uses. The automated path composes the candidate
 * port only when a case configures it, and the "no provider" refusal is itself a case.
 */
const NO_ADAPTERS: AdapterRegistry = {
  declarationsFor(_kind: ConnectorKind): readonly CapabilityDeclaration[] {
    return [];
  },
  probeFor() {
    return null;
  },
};

/** What the scripted provider reports, and the commit it attributes its runs to. */
interface ScriptedChecks {
  checks: readonly {
    readonly name: string;
    readonly result: CheckResult;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
  }[];
  /** The commit the provider claims its runs belong to. */
  attributedHeadSha: string | null;
  /** What the provider refuses with, or null to answer. */
  failure: DomainError | null;
}

const GREEN: ScriptedChecks = {
  checks: [{ name: 'unit', result: 'Passed', startedAt: LATER, endedAt: LATER }],
  attributedHeadSha: HEAD,
  failure: null,
};

/**
 * A registry that publishes a scripted read-only candidate port.
 *
 * Built through the shipped `createProviderRegistry` rather than hand-assembled, so the port the
 * verification path reaches is the one production narrows to - two reads and no write. The fetch
 * transport answers the two calls the candidate read makes and nothing else, so a case is
 * exercising the real adapter's request and response shapes (F03-AC2, N05-AC2).
 */
function providerRegistry(script: ScriptedChecks): ProviderRegistry {
  return {
    adapters: declaringAdapters(),
    ticket: null,
    git: null,
    engine: null,
    candidateGit: {
      kind: 'Git',
      async readLinkedPullRequest(
        _context: unknown,
        request: { readonly pullRequestNumber: number },
      ): Promise<Result<unknown, DomainError>> {
        if (script.failure !== null) return { ok: false, error: script.failure };
        return {
          ok: true,
          value: {
            repository: { provider: 'github', fullName: 'octopus/shop', defaultBranch: 'main' },
            providerPullRequestId: `pr_${request.pullRequestNumber}`,
            number: request.pullRequestNumber,
            url: `https://github.com/octopus/shop/pull/${request.pullRequestNumber}`,
            state: 'Open',
            draft: false,
            headBranch: 'feature/checkout-total',
            headSha: script.attributedHeadSha ?? HEAD,
            baseBranch: 'main',
            baseSha: BASE_SHA,
            headRepository: 'octopus/shop',
            mergedSha: null,
            mergedAt: null,
            observedAt: LATER,
          },
        };
      },
      async readChecks(): Promise<Result<unknown[], DomainError>> {
        if (script.failure !== null) return { ok: false, error: script.failure };
        return {
          ok: true,
          value: script.checks.map((entry) => ({
            checkId: `check_${entry.name}`,
            name: entry.name,
            result: entry.result,
            requirement: 'ProviderExtra',
            startedAt: entry.startedAt,
            endedAt: entry.endedAt,
            exitCode: entry.result === 'Passed' ? 0 : 1,
            detail: `${entry.name} reported ${entry.result}`,
            artifactUrl: null,
          })),
        };
      },
    },
    credentialBlocker: () => null,
  } as unknown as ProviderRegistry;
}

/**
 * An adapter registry that declares every capability a profile requires.
 *
 * Needed because the profile gate refuses a saved profile whose capabilities no configured adapter
 * declares (F03-AC2), and the candidate read needs a saved profile. The declarations say the
 * capability exists; nothing here is contacted except through `candidateGit`, which is scripted
 * separately, so a case that passes is not evidence that GitHub was reachable (N05-AC2).
 */
function declaringAdapters(): AdapterRegistry {
  return {
    declarationsFor(kind: ConnectorKind): readonly CapabilityDeclaration[] {
      return EVERY_CAPABILITY.filter((capability) => capability.startsWith(`${kind}:`)).map((capability) => ({
        kind: capability,
        supported: true,
        limitation: null,
        privileged: false,
        supportsPrecondition: false,
      }));
    },
    probeFor() {
      return null;
    },
  };
}

/**
 * Every capability `requiredCapabilities` in `profiles.ts` asks a profile's providers for.
 *
 * Listed as data so a widening of that requirement fails this fixture loudly rather than silently
 * producing a project whose profile cannot be saved at all (F03-AC2).
 */
const EVERY_CAPABILITY: readonly CapabilityKind[] = [
  'Git:ReadRepository',
  'Git:ReadChecks',
  'Git:PushBranch',
  'Ticket:ReadScope',
  'Ticket:UpdateManagedProgress',
  'Engine:VersionCheck',
  'Engine:StartScoped',
  'Deployment:Discover',
  'Deployment:ReadIdentity',
];

/** A provider registry whose reads always refuse, for the "provider would not answer" case. */
function failingRegistry(reason: string): ProviderRegistry {
  return providerRegistry({ checks: [], attributedHeadSha: null, failure: { code: 'Unavailable', reason } });
}

const AUTOMATED_CRITERION = {
  id: AUTOMATED_CRITERION_ID,
  description: 'The summary returns 200 and displays "Total: 12.00".',
  verificationType: 'automated',
  // Bound, because approval refuses an automated criterion that names no check — and this
  // fixture approves a revision in order to reach the evidence routes. Leaving it unbound would
  // make every test here fail at the approval step for a reason that has nothing to do with
  // what they are proving. The evidence routes read a check by identity against the live head;
  // which identity they use is irrelevant to whether these paths accept a client-stated result.
  verificationCheckId: 'unit-tests',
} as const;

const OWNER_CRITERION = {
  id: OWNER_CRITERION_ID,
  description: 'The owner confirms the total matches the invoice they were sent.',
  verificationType: 'owner_test',
} as const;

const CONTRACT_CONTENT = {
  outcome: 'The order summary shows the total including tax.',
  scope: ['Sum the line items before tax'],
  outOfScope: ['Changing the tax rate'],
  acceptanceCriteria: [AUTOMATED_CRITERION, OWNER_CRITERION],
} as const;

/** A contract whose only criterion is the owner's own. See `routes/review.test.ts` for why. */
const OWNER_ONLY_CONTENT = {
  ...CONTRACT_CONTENT,
  acceptanceCriteria: [OWNER_CRITERION],
} as const;

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

interface Harness {
  readonly app: FastifyInstance;
  readonly root: CompositionRoot;
  readonly session: Session;
  readonly seed: Seed;
  readonly verify: (payload?: Record<string, unknown>) => Promise<{ readonly status: number; readonly body: string }>;
  readonly verifyIn: (
    projectId: string,
    payload?: Record<string, unknown>,
  ) => Promise<{ readonly status: number; readonly body: string }>;
  readonly verifyAnonymously: () => Promise<{ readonly status: number; readonly body: string }>;
  readonly verifyWithoutCsrf: (payload?: Record<string, unknown>) => Promise<{ readonly status: number; readonly body: string }>;
  readonly ownerTest: (
    criterionId: string,
    payload: Record<string, unknown>,
  ) => Promise<{ readonly status: number; readonly body: string }>;
  readonly ownerTestIn: (
    projectId: string,
    criterionId: string,
    payload: Record<string, unknown>,
  ) => Promise<{ readonly status: number; readonly body: string }>;
  readonly ownerTestAnonymously: (
    criterionId: string,
    payload: Record<string, unknown>,
  ) => Promise<{ readonly status: number; readonly body: string }>;
  readonly ownerTestWithoutCsrf: (
    criterionId: string,
    payload: Record<string, unknown>,
  ) => Promise<{ readonly status: number; readonly body: string }>;
  /**
   * Moves the injected clock forward.
   *
   * Needed because "a later observation supersedes an earlier one" is a claim about order, and two
   * rows stamped with one frozen instant are a tie the projection resolves by identity rather than
   * by time. A test that froze the clock would be testing the tie.
   */
  readonly advance: (seconds: number) => void;
  /** Re-reads the card, so a test can prove a refused write left nothing behind. */
  readonly review: () => Promise<{ readonly status: number; readonly card: MvpReviewCardView | null; readonly raw: string }>;
  readonly close: () => Promise<void>;
}

/**
 * The journey up to a reviewable candidate, over HTTP, on a real store.
 *
 * The session, the project, the request and the approved revision are produced by the shipped
 * routes, so what the card reads is what the product records for an owner who walked the journey.
 * The candidate row is written through the store and says why above.
 */
async function harness(
  options: {
    readonly content?: typeof CONTRACT_CONTENT | typeof OWNER_ONLY_CONTENT;
    readonly providers?: ProviderRegistry;
  } = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-verification-route-'));
  let instant = Date.parse(NOW);
  const at = (): string => new Date(instant).toISOString();
  const opened = createCompositionRoot({
    databasePath: join(directory, 'shiploop.db'),
    clock: { now: at },
    // The adapter registry and the provider registry are separate arguments, and the profile gate
    // reads the *registry of declarations* rather than the adapters themselves. A project whose
    // profile is to be saved therefore needs declarations, which is what the provider option
    // supplies here; a harness with no provider keeps the empty registry the MVP journey runs with.
    adapters: options.providers === undefined ? NO_ADAPTERS : declaringAdapters(),
    ...(options.providers === undefined ? {} : { providers: options.providers }),
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

  // The candidate read resolves the repository from the project's *saved profile*, never from the
  // request - which is the reason a client cannot name the repository its own pull request is
  // compared against. So a project that is to be verified against needs one saved, and it is
  // saved over HTTP here for the same reason the request and contract are: a profile written
  // straight into the store would prove the transport while disagreeing with the product about
  // what a real owner's project holds.
  if (options.providers !== undefined) {
    await saveProfile(app, session);
  }

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
      baseSha: BASE_SHA as CommitSha,
      headBranch: 'feature/checkout-total',
      headSha: HEAD as CommitSha,
      headRepository: 'octopus/shop',
      pullRequestState: 'Open',
      draft: false,
      observedAt: NOW,
      correlationId: 'seed-candidate',
    }),
    'the candidate row the evidence is recorded against',
  );

  const reviewUrl = (projectId: string): string =>
    `/api/projects/${projectId}/candidates/${CANDIDATE_ID}/review`;
  const verifyUrl = (projectId: string): string =>
    `/api/projects/${projectId}/candidates/${CANDIDATE_ID}/verify`;
  const ownerTestUrl = (projectId: string, criterionId: string): string =>
    `/api/projects/${projectId}/candidates/${CANDIDATE_ID}/criteria/${criterionId}/owner-test`;

  const postVerify = async (
    projectId: string,
    payload: Record<string, unknown> | undefined,
    headers: Record<string, string>,
  ) => {
    const response = await app.inject({
      method: 'POST',
      url: verifyUrl(projectId),
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: response.statusCode, body: response.body };
  };
  const authenticated = { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken };

  const postOwnerTest = async (
    projectId: string,
    criterionId: string,
    payload: Record<string, unknown>,
    headers: Record<string, string>,
  ) => {
    const response = await app.inject({
      method: 'POST',
      url: ownerTestUrl(projectId, criterionId),
      headers,
      payload,
    });
    return { status: response.statusCode, body: response.body };
  };

  const readReview = async (projectId: string) => {
    const response = await app.inject({ method: 'GET', url: reviewUrl(projectId), headers: { cookie: session.cookie } });
    return { status: response.statusCode, body: response.body };
  };

  return {
    app,
    root,
    session,
    seed,
    verify: (payload) => postVerify(PROJECT_ID, payload, authenticated),
    verifyIn: (projectId, payload) => postVerify(projectId, payload, authenticated),
    verifyAnonymously: () => postVerify(PROJECT_ID, undefined, {}),
    verifyWithoutCsrf: (payload) => postVerify(PROJECT_ID, payload, { cookie: session.cookie }),
    ownerTest: (criterionId, payload) => postOwnerTest(PROJECT_ID, criterionId, payload, authenticated),
    ownerTestIn: (projectId, criterionId, payload) => postOwnerTest(projectId, criterionId, payload, authenticated),
    ownerTestAnonymously: (criterionId, payload) => postOwnerTest(PROJECT_ID, criterionId, payload, {}),
    ownerTestWithoutCsrf: (criterionId, payload) =>
      postOwnerTest(PROJECT_ID, criterionId, payload, { cookie: session.cookie }),
    advance: (seconds) => {
      instant += seconds * 1000;
    },
    review: async () => {
      const response = await readReview(PROJECT_ID);
      return {
        status: response.status,
        card: parse<{ review?: MvpReviewCardView }>({ body: response.body }).review ?? null,
        raw: response.body,
      };
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
 * The same journey `routes/review.test.ts` walks: the evidence paths read a contract revision and a
 * candidate, and rows a test inserted by hand would prove the transport rather than the product.
 */
async function approvedContract(
  app: FastifyInstance,
  session: Session,
  content: typeof CONTRACT_CONTENT | typeof OWNER_ONLY_CONTENT,
): Promise<Seed> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { projectId: PROJECT_ID, name: 'Checkout' },
  });
  assert.ok(created.statusCode === 200 || created.statusCode === 201, `project creation failed: ${created.body}`);

  const requested = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/requests`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { title: REQUEST_TITLE, description: REQUEST_DESCRIPTION },
  });
  assert.equal(requested.statusCode, 201, `request creation failed: ${requested.body}`);
  const request = parse<{ request: RequestView }>(requested).request;

  const drafted = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}/contracts`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: content,
  });
  assert.equal(drafted.statusCode, 201, `contract drafting failed: ${drafted.body}`);
  const contract = parse<{ contract: ContractView }>(drafted).contract;

  // An approval names the draft it reviewed. Posting an empty body is the pre-CAS wire shape and
  // is now refused by name, so the fixture sends the fingerprint the read actually carried rather
  // than inventing one — this is the same token a real owner's page holds.
  const approved = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/${contract.revision}/approve`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { expectedContentFingerprint: contract.contentFingerprint },
  });
  assert.equal(approved.statusCode, 200, `approval failed: ${approved.body}`);
  return {
    projectId: PROJECT_ID,
    requestId: request.requestId,
    contractId: contract.contractId,
    revision: contract.revision,
    candidateId: CANDIDATE_ID,
  };
}

/**
 * The saved profile a project needs before a candidate can be compared to a repository.
 *
 * Saved through the shipped route, so the repository the verification path reads is one the
 * product recorded rather than one a fixture chose. Only the references are load-bearing here; the
 * rest of a profile exists to be a complete row.
 */
async function saveProfile(app: FastifyInstance, session: Session): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: {
      projectId: PROJECT_ID,
      content: {
        references: {
          repository: 'octopus/shop',
          ticketProvider: 'linear',
          ticketTeamKey: null,
          baseBranch: 'main',
          targetBranch: 'main',
          deploymentProvider: 'none',
          engine: 'none',
          previewComponents: [{ component: 'web', environment: 'preview' }],
        },
        policy: {
          requiredChecks: ['unit'],
          deliveryBehavior: 'ManualAuthorizationOnly',
          maxFixPasses: 2,
          workspaceIsolation: 'WorktreeAndDataDirectory',
          capabilityVersion: 1,
        },
        recipe: 'pnpm test',
        environment: { runtime: 'node24', ports: [4100], secretReferences: [] },
      },
      note: null,
      expectedVersionNumber: null,
    },
  });
  assert.equal(response.statusCode, 201, `the profile must save: ${response.body}`);
}

/** An owner-test body a case overrides one field at a time. */
function ownerTestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { result: 'passed', note: 'The total matches the invoice.', ...overrides };
}

/* -------------------------------------------------------------------------- */
/* The automated path                                                          */
/* -------------------------------------------------------------------------- */

test('F20-AC2: the server derives the result, and a body cannot state one', async (t) => {
  const h = await harness({ providers: providerRegistry(GREEN) });
  t.after(() => h.close());

  const verified = await h.verify();
  assert.equal(verified.status, 200, verified.body);
  const report = parse<{ verification: MvpVerificationReportView }>({ body: verified.body }).verification;

  assert.equal(report.method, 'github_checks', 'the report names the source that produced it');
  assert.equal(report.recorded.length, 1, 'one provider check produced one observation');
  const observation = report.recorded[0];
  assert.ok(observation !== undefined);
  assert.equal(observation.checkId, 'unit');
  assert.equal(observation.recordedOutcome, 'passed');
  assert.equal(observation.countsForCurrentCandidate, true);
  assert.equal(report.candidateHeadSha, HEAD, 'the evidence is bound to the candidate on screen');

  // Every field through which a client could assert a verdict. Refused *by name*, not dropped:
  // a silently-ignored field would leave the client believing it chose the outcome.
  for (const field of [
    'result',
    'outcome',
    'passed',
    'checkId',
    'criterionId',
    'headSha',
    'candidateHeadSha',
    'evidenceId',
    'observations',
    'ownerId',
    'observedAt',
  ]) {
    const attempted = await h.verify({ [field]: field === 'passed' ? true : HEAD });
    assert.equal(attempted.status, 400, `${field} must be refused: ${attempted.body}`);
    assert.equal(
      fieldMessages(problemOf(attempted.body), field),
      `"${field}" is not accepted here. Remove it or check the spelling.`,
      `the refusal must name ${field}: ${attempted.body}`,
    );
  }

  // And nothing those bodies tried to assert was recorded.
  const card = (await h.review()).card;
  assert.equal(card?.evidence.length, 1, 'one row exists: the one the provider read produced');
  assert.equal(
    card?.criteria.find((criterion) => criterion.criterionId === AUTOMATED_CRITERION_ID)?.state,
    'unverified',
    'and the automated criterion is still unverified, because the MVP contract binds it to no check '
      + 'and no client can supply that binding',
  );
  assert.notEqual(
    card?.criteria.find((criterion) => criterion.criterionId === AUTOMATED_CRITERION_ID)?.state,
    'passed',
  );
});

test('mvp-spec 3: the automated request schema carries an optional method and nothing else', async (t) => {
  const h = await harness({ providers: providerRegistry(GREEN) });
  t.after(() => h.close());

  // An absent body is accepted, because there is nothing to submit and refusing a POST that sent
  // nothing would be an obstacle rather than a protection.
  const bare = await h.verify();
  assert.equal(bare.status, 200, bare.body);

  // The one member it does carry names the server's method, and nothing else is a valid value.
  const named = await h.verify({ method: 'github_checks' });
  assert.equal(named.status, 200, named.body);
  for (const method of ['local_command', 'browser', 'owner_test', '', 1, null]) {
    const refused = await h.verify({ method });
    assert.equal(refused.status, 400, `${JSON.stringify(method)} must not be a method: ${refused.body}`);
    assert.notEqual(fieldMessages(problemOf(refused.body), 'method'), '');
  }
});

test('F20-AC2: a failing check and a check that never ran are reported truthfully, never as a pass', async (t) => {
  const h = await harness({
    providers: providerRegistry(
      {
        checks: [
          { name: 'unit', result: 'Failed', startedAt: LATER, endedAt: LATER },
          { name: 'lint', result: 'Missing', startedAt: null, endedAt: null },
        ],
        attributedHeadSha: HEAD,
        failure: null,
      },
    ),
  });
  t.after(() => h.close());

  const verified = await h.verify();
  assert.equal(verified.status, 200, verified.body);
  const report = parse<{ verification: MvpVerificationReportView }>({ body: verified.body }).verification;

  const byCheck = new Map(report.recorded.map((entry) => [entry.checkId, entry]));
  assert.equal(byCheck.get('unit')?.recordedOutcome, 'failed', 'a red check reads failed');
  assert.equal(
    byCheck.get('lint')?.recordedOutcome,
    'missing',
    'a check the provider never ran reads missing, which is not a pass (F20-AC2)',
  );
  assert.notEqual(byCheck.get('lint')?.recordedOutcome, 'passed');

  // Walk every row on the card rather than spot-checking, because the failure mode is a row a
  // client could render green.
  const card = (await h.review()).card;
  assert.ok(card !== null);
  for (const row of card.evidence) {
    assert.equal('outcome' in row, false, `evidence ${row.evidenceId} carries a bare outcome`);
    if (row.countsForCurrentCandidate) {
      assert.notEqual(row.currentOutcome, 'stale', 'a row cannot both count and read stale');
      assert.equal(row.candidateHeadSha, HEAD, 'a counting row names the candidate head');
    } else {
      assert.equal(row.currentOutcome, 'stale');
      assert.ok(row.staleReasons.length > 0, 'and names why it no longer counts');
    }
  }
  const results = new Map(card.checks.map((entry) => [entry.checkId, entry.result]));
  assert.equal(results.get('unit'), 'failed');
  assert.equal(results.get('lint'), 'missing');
  assert.equal(card.eligibility.readyForAcceptance, false, 'and the gate stays shut');
});

test('F20-AC3: evidence for an older commit cannot prove the candidate on screen', async (t) => {
  // The provider's runs belong to the commit a push produced, while the candidate under review is
  // still the row the store recorded. This is the state F20-AC3 exists for.
  const h = await harness({ providers: providerRegistry({ ...GREEN, attributedHeadSha: NEXT_HEAD }) });
  t.after(() => h.close());

  const verified = await h.verify();
  assert.equal(verified.status, 200, verified.body);
  const report = parse<{ verification: MvpVerificationReportView }>({ body: verified.body }).verification;

  assert.equal(report.candidateHeadSha, HEAD, 'the evidence is bound to the candidate the path named');
  assert.equal(
    report.providerHeadSha,
    NEXT_HEAD,
    'and the report names the commit the provider holds, so the difference is visible rather than hidden',
  );
  const observation = report.recorded[0];
  assert.ok(observation !== undefined);
  assert.equal(observation.recordedOutcome, 'passed', 'what the provider said is history');
  assert.equal(observation.currentOutcome, 'stale', 'and it is not this candidate\'s result');
  assert.equal(observation.countsForCurrentCandidate, false);
  assert.equal(observation.observedHeadSha, null, 'the row names no commit, so it is bound to nothing');

  const card = (await h.review()).card;
  assert.equal(card?.staleness.stale, true);
  assert.equal(
    card?.criteria.find((criterion) => criterion.criterionId === AUTOMATED_CRITERION_ID)?.state,
    'unverified',
    "the older run's green does not verify the criterion now on screen",
  );
  assert.equal(card?.eligibility.readyForAcceptance, false);
});

test('F20-AC2: a provider that will not answer is a refusal, and nothing is recorded', async (t) => {
  const h = await harness({ providers: failingRegistry('The provider did not answer the request.') });
  t.after(() => h.close());

  const refused = await h.verify();
  assert.equal(refused.status, 503, refused.body);
  assert.equal(problemOf(refused.body).error.code, 'Unavailable');

  const card = (await h.review()).card;
  assert.deepEqual(card?.evidence, [], 'and no evidence row was written, so no later read can claim one');
});

test('F03-AC2: a deployment with no git provider refuses by name rather than reporting an empty pass', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const refused = await h.verify();
  assert.equal(refused.status, 503, refused.body);
  assert.ok(
    problemOf(refused.body).error.message.includes('no read-only git provider'),
    `the refusal names the missing wiring rather than reporting nothing failed: ${refused.body}`,
  );
  const card = (await h.review()).card;
  assert.deepEqual(card?.evidence, []);
  assert.equal(card?.checks.length, 0, 'and no check is listed as passing');
});

test('F02-AC2: the automated path is addressed by its own project, never by id alone', async (t) => {
  const h = await harness({ providers: providerRegistry(GREEN) });
  t.after(() => h.close());

  const elsewhere = await h.verifyIn(OTHER_PROJECT_ID);
  assert.equal(elsewhere.status, 404, `another project's path must find nothing: ${elsewhere.body}`);
  assert.equal(problemOf(elsewhere.body).error.code, 'NotFound');

  const card = (await h.review()).card;
  assert.deepEqual(card?.evidence, [], 'and nothing was recorded from across the boundary');
});

test('F01-AC1, F01-AC4: an anonymous caller and a request without the session token are both refused', async (t) => {
  const h = await harness({ providers: providerRegistry(GREEN) });
  t.after(() => h.close());

  const anonymous = await h.verifyAnonymously();
  assert.equal(anonymous.status, 401, anonymous.body);
  assert.equal(problemOf(anonymous.body).signInRequired, true);

  const withoutToken = await h.verifyWithoutCsrf();
  assert.equal(withoutToken.status, 403, withoutToken.body);
  assert.equal(problemOf(withoutToken.body).error.code, 'Forbidden');

  const card = (await h.review()).card;
  assert.deepEqual(card?.evidence, []);
});

test('mvp-spec 3, F03-AC5: both evidence routes are registered, and nothing merges, deploys or releases', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  for (const route of [
    { method: 'POST', url: '/api/projects/:projectId/candidates/:candidateId/verify' },
    {
      method: 'POST',
      url: '/api/projects/:projectId/candidates/:candidateId/criteria/:criterionId/owner-test',
    },
  ]) {
    assert.ok(
      h.app.hasRoute({ method: route.method as 'POST', url: route.url }),
      `${route.method} ${route.url} must be registered`,
    );
  }

  // The unscoped spellings a previous wave invented must not exist.
  for (const url of [
    '/api/verify',
    '/api/evidence',
    '/api/owner-test',
    '/api/projects/verify',
    `/api/candidates/${CANDIDATE_ID}/verify`,
  ]) {
    const response = await h.app.inject({
      method: 'POST',
      url,
      headers: { cookie: h.session.cookie, [CSRF_HEADER]: h.session.csrfToken },
      payload: {},
    });
    assert.equal(response.statusCode, 404, `${url} must not exist: ${response.body}`);
  }

  // No other verb on either path exists, so there is no read of one and no alternate write.
  for (const attempt of [
    { method: 'GET', url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/verify` },
    {
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/criteria/${OWNER_CRITERION_ID}/owner-test`,
    },
    { method: 'PUT', url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/verify` },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/merge` },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/deploy` },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/release` },
  ]) {
    const response = await h.app.inject({
      method: attempt.method as 'GET',
      url: attempt.url,
      headers: { cookie: h.session.cookie, [CSRF_HEADER]: h.session.csrfToken },
      payload: {},
    });
    assert.equal(
      response.statusCode,
      404,
      `${attempt.method} ${attempt.url} must not exist: ${response.body}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* The owner path                                                              */
/* -------------------------------------------------------------------------- */

test('F23-AC1, F25-AC1: an owner_test criterion can pass, and the card says so', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const before = await h.review();
  assert.equal(before.card?.ownerTests[0]?.state, 'pending', 'nobody but the owner may settle it');

  const recorded = await h.ownerTest(OWNER_CRITERION_ID, ownerTestBody());
  assert.equal(recorded.status, 200, recorded.body);
  const report = parse<{ ownerTest: MvpOwnerTestReportView }>({ body: recorded.body }).ownerTest;

  assert.equal(report.criterionId, OWNER_CRITERION_ID);
  assert.equal(report.outcome, 'passed');
  assert.equal(report.candidateHeadSha, HEAD, 'the record names the exact commit the owner tested');
  assert.equal(report.contractRevision, 1);
  assert.ok(report.evidenceId.length > 0);
  assert.ok(report.observedAt.length > 0, 'and the instant, which the controller stamped');

  // The report carries the card it produced, and the card agrees with it.
  assert.equal(report.review.ownerTests[0]?.state, 'passed');
  assert.equal(report.review.ownerTests[0]?.evidenceId, report.evidenceId);
  assert.equal(report.review.criteria.find((entry) => entry.criterionId === OWNER_CRITERION_ID)?.state, 'passed');

  // And the durable read agrees too, so this is not a response-only claim.
  const after = await h.review();
  assert.equal(after.card?.ownerTests[0]?.state, 'passed');
  const row = after.card?.evidence.find((entry) => entry.evidenceId === report.evidenceId);
  assert.equal(row?.source, 'owner_test', 'an owner observation is attributed to the owner test source');
  assert.equal(row?.criterionId, OWNER_CRITERION_ID);
  assert.equal(row?.candidateHeadSha, HEAD);
});

test('F25-AC2: an owner_test criterion can fail, and the failure is recorded as a failure', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const recorded = await h.ownerTest(
    OWNER_CRITERION_ID,
    ownerTestBody({ result: 'failed', note: 'The total is missing the tax line.' }),
  );
  assert.equal(recorded.status, 200, recorded.body);
  const report = parse<{ ownerTest: MvpOwnerTestReportView }>({ body: recorded.body }).ownerTest;

  assert.equal(report.outcome, 'failed');
  assert.equal(report.note, 'The total is missing the tax line.');
  assert.equal(
    report.review.ownerTests[0]?.state,
    'failed',
    'a reported failure reads failed, not pending and not passed (F25-AC2)',
  );
  assert.equal(
    report.review.eligibility.readyForAcceptance,
    false,
    'and it does not open the acceptance gate',
  );

  const after = await h.review();
  assert.equal(after.card?.ownerTests[0]?.state, 'failed');
  assert.notEqual(after.card?.ownerTests[0]?.state, 'passed');
});

test('mvp-spec 3: an owner test reports passed or failed and nothing else', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  for (const value of ['capture_failed', 'PASSED', 'pending', 'stale', '', null, 1, true]) {
    const refused = await h.ownerTest(OWNER_CRITERION_ID, ownerTestBody({ result: value }));
    assert.equal(refused.status, 400, `${JSON.stringify(value)} must not be a result: ${refused.body}`);
    assert.notEqual(fieldMessages(problemOf(refused.body), 'result'), '');
  }

  // `capture_failed` is refused rather than mapped onto something: a screenshot that was never
  // taken is not a statement about the product, and this transport does not file it as one
  // (F23-AC5).
  const after = await h.review();
  assert.equal(after.card?.ownerTests[0]?.state, 'pending', 'no refused body reached the criterion');
  assert.deepEqual(after.card?.evidence, []);
});

test('F01-AC1, F25-AC4: the owner is the session, and a body that names one is refused by name', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  for (const field of ['ownerId', 'observedBy', 'actor', 'recordedBy', 'observedAt', 'at', 'evidenceId', 'headSha']) {
    const refused = await h.ownerTest(OWNER_CRITERION_ID, ownerTestBody({ [field]: 'someone-else' }));
    assert.equal(refused.status, 400, `${field} must be refused: ${refused.body}`);
    assert.equal(
      fieldMessages(problemOf(refused.body), field),
      `"${field}" is not accepted here. Remove it or check the spelling.`,
      `the refusal must name ${field}: ${refused.body}`,
    );
  }

  const unchanged = await h.review();
  assert.equal(unchanged.card?.ownerTests[0]?.state, 'pending', 'no refused body reached a criterion');
  assert.deepEqual(unchanged.card?.evidence, []);

  // The observation that does go through is attributed to the session, read back from the store.
  const recorded = await h.ownerTest(OWNER_CRITERION_ID, ownerTestBody());
  assert.equal(recorded.status, 200, recorded.body);
  const owner = h.root.owners.current();
  assert.ok(owner.ok && owner.value !== null);
  const row = (await h.review()).card?.evidence.find((entry) => entry.source === 'owner_test');
  assert.ok(row !== undefined);
  assert.equal(
    row.detail,
    'The total matches the invoice.',
    'and the note travels as the detail of that row',
  );
  assert.ok(owner.value.ownerId.length > 0);
});

test('F23-AC1: an automated criterion refuses an owner-test write', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const refused = await h.ownerTest(AUTOMATED_CRITERION_ID, ownerTestBody());
  assert.equal(refused.status, 400, refused.body);
  assert.equal(problemOf(refused.body).error.code, 'Invalid');
  assert.ok(
    problemOf(refused.body).error.message.includes('verified automatically'),
    `the refusal says why: ${refused.body}`,
  );

  const after = await h.review();
  assert.equal(
    after.card?.criteria.find((entry) => entry.criterionId === AUTOMATED_CRITERION_ID)?.state,
    'unverified',
    'and the automated criterion is untouched',
  );
  assert.deepEqual(after.card?.evidence, [], 'with nothing recorded for it');
  assert.equal(
    after.card?.ownerTests.length,
    1,
    'and it is still only the declared owner test the owner has to run',
  );
});

test('F23-AC1: a criterion the revision does not declare is refused', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const refused = await h.ownerTest('AC-does-not-exist', ownerTestBody());
  assert.equal(refused.status, 404, refused.body);
  assert.equal(problemOf(refused.body).error.code, 'NotFound');

  const after = await h.review();
  assert.deepEqual(after.card?.evidence, []);
  assert.equal(after.card?.ownerTests[0]?.state, 'pending');
});

test('F02-AC2: an owner test cannot be recorded against another project\'s candidate', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const refused = await h.ownerTestIn(OTHER_PROJECT_ID, OWNER_CRITERION_ID, ownerTestBody());
  assert.equal(refused.status, 404, refused.body);
  assert.equal(problemOf(refused.body).error.code, 'NotFound');

  const after = await h.review();
  assert.deepEqual(after.card?.evidence, [], 'nothing was recorded from across the boundary');
  assert.equal(after.card?.ownerTests[0]?.state, 'pending');
});

test('F25-AC3: a later owner test supersedes the earlier one, and the card reports the newer', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const passed = await h.ownerTest(OWNER_CRITERION_ID, ownerTestBody());
  assert.equal(passed.status, 200, passed.body);
  const first = parse<{ ownerTest: MvpOwnerTestReportView }>({ body: passed.body }).ownerTest;

  h.advance(60);
  const failed = await h.ownerTest(
    OWNER_CRITERION_ID,
    ownerTestBody({ result: 'failed', note: 'Retested after a change and it no longer holds.' }),
  );
  assert.equal(failed.status, 200, failed.body);
  const second = parse<{ ownerTest: MvpOwnerTestReportView }>({ body: failed.body }).ownerTest;

  assert.notEqual(
    second.evidenceId,
    first.evidenceId,
    'two observations of one criterion are two rows, so a correction supersedes rather than overwrites',
  );
  const after = await h.review();
  assert.equal(after.card?.ownerTests[0]?.state, 'failed', 'and the newer one is what the card reports');
  assert.equal(after.card?.ownerTests[0]?.evidenceId, second.evidenceId);
});

test('F01-AC1, F01-AC4: an anonymous caller and a request without the session token are both refused', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const anonymous = await h.ownerTestAnonymously(OWNER_CRITERION_ID, ownerTestBody());
  assert.equal(anonymous.status, 401, anonymous.body);
  assert.equal(problemOf(anonymous.body).signInRequired, true);

  const withoutToken = await h.ownerTestWithoutCsrf(OWNER_CRITERION_ID, ownerTestBody());
  assert.equal(withoutToken.status, 403, withoutToken.body);
  assert.equal(problemOf(withoutToken.body).error.code, 'Forbidden');

  const after = await h.review();
  assert.deepEqual(after.card?.evidence, [], 'neither attempt recorded anything');
  assert.equal(after.card?.ownerTests[0]?.state, 'pending');
});