/**
 * The Home route, driven against the real controller surface (F02-AC4, F11-AC1, F24-AC3).
 *
 * ## Why this file exists
 *
 * `home.test.ts` proves the board: classification, the three groups, the refusals, project
 * scoping. It does so by passing `homeSources` explicitly. What it therefore could not see is
 * whether the *shipped* composition supplies those sources at all — and nothing did.
 * `buildApp` read `deps.homeSources ?? null`, `main.ts` never passed a value, and
 * `ControllerSurface` had no group carrying them, so on every real deployment
 *
 *     GET /api/projects/:projectId/home
 *
 * answered
 *
 *     503 This deployment exposes no stored candidate or review projection, so the home
 *         projection cannot be composed.
 *
 * The route's refusal was correct and is preserved: it cannot answer with three empty groups
 * without claiming there is nothing to review, which a server that cannot read a candidate has
 * no basis for. The *composition* was wrong (F11-AC1, F02-AC4).
 *
 * This is the third instance of one shape of defect — a registered route whose use cases exist
 * and whose wiring to production is missing — after the candidate port and, before this, the
 * generation group. The difference here is that it can no longer recur: `home` is declared on
 * `ControllerSurface`, and `buildApp` defaults to the surface's own group, so a deployment cannot
 * end up without these reads by omission (F03-AC2).
 *
 * ## What is real here
 *
 * Real: `createCompositionRoot` over a real migrated SQLite file, `bindControllerSurface`, the
 * shipped `buildApp` **with no `homeSources` passed at all**, the session guard, CSRF,
 * `app.inject()`, and every use case behind them. The project, profile, request, contract,
 * approval and candidate link are all performed over HTTP by the shipped routes.
 *
 * Substituted: the git provider, which is a scripted read-only `CandidateGitPort` handed to the
 * composition root through the same `providers` seam an operator configures. It carries no write
 * method, so nothing here could mutate a provider even by mistake (F03-AC5, N05-AC2).
 *
 * ## The durable-read proof, and why call counts alone are not it
 *
 * The scripted port records every read that actually reached it, and the assertions here are that
 * **zero** of them happened while Home was served. A count on its own would be satisfied by a Home
 * that read the right rows and also quietly refreshed a pull request, so the same test also
 * asserts the board's *content* — that the candidate is placed and that its reason is quoted
 * from the projection rather than invented. The two together are the claim: correct facts, and no
 * provider work to obtain them (F20-AC3).
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ok, SESSION_COOKIE_NAME } from '@shiploop/domain';
import type { CapabilityDeclaration, CapabilityKind, ConnectorId, Result } from '@shiploop/domain';
import type { FastifyInstance } from 'fastify';
import type { ConnectorKind } from '@shiploop/storage';
import type {
  AdapterCapabilities,
  AdapterCompatibility,
  AdapterContext,
  CandidateGitPort,
  LinkedPullRequestFacts,
  ProviderCheckObservation,
  ReadChecksRequest,
  ReadLinkedPullRequestRequest,
} from '@shiploop/adapters';
import { ADAPTER_CONTRACT_VERSION } from '@shiploop/adapters';
import type { ProviderId } from '@shiploop/domain';
import {
  bindControllerSurface,
  createCompositionRoot,
  type AdapterRegistry,
  type CompositionRoot,
} from '@shiploop/controller';

type ProviderRegistry = NonNullable<CompositionRoot['providers']>;
import { buildApp } from '../app.ts';
import { CSRF_HEADER } from '../auth-guard.ts';
import { readServerConfig } from '../config.ts';
import type { ContractView, ControllerSurface, RequestView } from '../contracts.ts';
import type { HomeProjection } from './home.ts';
import { candidateUseCasesOf } from './candidates.ts';

const NOW = '2026-10-05T09:00:00.000Z';
const DISPLAY_NAME = 'Solo Owner';
const PASSWORD = 'correct horse battery staple';
const PROJECT_ID = 'checkout';
const OTHER_PROJECT_ID = 'basket';
const CSRF_SECRET = ['server', 'secret', 'material', '0123456789abcdef'].join('-');
const FAST_PASSWORD_COST = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16 };
const IDLE_TIMEOUT_SECONDS = 900;

const REPOSITORY = 'octopus/shop';
const PULL_REQUEST_NUMBER = 7;
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BASE_SHA = 'fedcba98765432100123456789abcdefabcdef01';
const REQUIRED_CHECK = 'typecheck';
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

/* -------------------------------------------------------------------------- */
/* The scripted provider                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The read-only git port, and nothing else.
 *
 * A fresh object literal naming only the two reads plus the identity surface, so a call to a
 * merge or a close from this file would not compile (F03-AC5). `reads` records every read that
 * reached it, which is what the durable-read assertion below observes.
 */
class ScriptedCandidateGit implements CandidateGitPort {
  readonly kind = 'Git' as const;
  readonly connectorId = 'connector_scripted_github' as ConnectorId;
  readonly reads: string[] = [];

  capabilities(): AdapterCapabilities {
    return { kind: 'Git', contractVersion: ADAPTER_CONTRACT_VERSION, declarations: [] };
  }

  async checkCompatibility(context: AdapterContext): Promise<Result<AdapterCompatibility>> {
    return ok({
      kind: 'Git',
      contractVersion: ADAPTER_CONTRACT_VERSION,
      runtimeVersion: null,
      compatible: true,
      detail: 'A scripted provider; it contacts no provider.',
      observedAt: context.clock.now(),
    });
  }

  async readLinkedPullRequest(
    _context: AdapterContext,
    request: ReadLinkedPullRequestRequest,
  ): Promise<Result<LinkedPullRequestFacts>> {
    this.reads.push(`pull-request ${request.pullRequestNumber}`);
    return ok({
      repository: { ...request.repository },
      providerPullRequestId: String(PULL_REQUEST_NUMBER) as ProviderId,
      number: request.pullRequestNumber,
      url: `https://github.com/${REPOSITORY}/pull/${request.pullRequestNumber}`,
      state: 'Open',
      draft: false,
      headBranch: 'feature/checkout-total',
      headSha: HEAD_SHA as LinkedPullRequestFacts['headSha'],
      baseBranch: 'main',
      baseSha: BASE_SHA as LinkedPullRequestFacts['baseSha'],
      headRepository: REPOSITORY,
      mergedSha: null,
      mergedAt: null,
      observedAt: NOW,
    });
  }

  async readChecks(_context: AdapterContext, _request: ReadChecksRequest): Promise<Result<ProviderCheckObservation[]>> {
    this.reads.push('checks');
    return ok([
      {
        checkId: `check_${REQUIRED_CHECK}`,
        name: REQUIRED_CHECK,
        result: 'Passed',
        requirement: 'ProfileRequired',
        startedAt: NOW,
        endedAt: NOW,
        exitCode: 0,
        detail: null,
        artifactUrl: null,
      },
    ]);
  }
}

function adapterRegistry(): AdapterRegistry {
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

function providerRegistry(git: ScriptedCandidateGit): ProviderRegistry {
  return {
    adapters: adapterRegistry(),
    ticket: null,
    git: null,
    engine: null,
    candidateGit: git,
    credentialBlocker: () => null,
  } as unknown as ProviderRegistry;
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly app: FastifyInstance;
  readonly git: ScriptedCandidateGit;
  readonly close: () => Promise<void>;
}

/**
 * A real app over a real store.
 *
 * **`buildApp` is called without a `homeSources` member.** That omission is the defect: before
 * the fix, `buildApp` defaulted it to `null` and Home refused, so this harness reproduced the
 * production behaviour exactly rather than a test's idea of it (F11-AC1).
 */
async function harness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-home-surface-'));
  const git = new ScriptedCandidateGit();
  const opened = createCompositionRoot({
    databasePath: join(directory, 'shiploop.db'),
    clock: { now: () => NOW },
    adapters: adapterRegistry(),
    passwordParameters: FAST_PASSWORD_COST,
    sessionIdleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    providers: providerRegistry(git),
  });
  assert.ok(opened.ok, `the store must open: ${opened.ok ? '' : opened.error.reason}`);

  const controller: ControllerSurface = bindControllerSurface(opened.value);
  const config = readServerConfig({
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_NODE_ENV: 'test',
    SHIPLOOP_COOKIE_SECURE: 'false',
    SHIPLOOP_LOG_LEVEL: 'silent',
  });
  assert.ok(config.ok, `the configuration must be accepted: ${config.ok ? '' : JSON.stringify(config.errors)}`);
  const app = await buildApp({ config: config.value, controller, now: () => new Date(NOW) });

  return {
    app,
    git,
    close: async () => {
      await app.close();
      opened.value.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function parse<T>(response: { readonly body: string }): T {
  return JSON.parse(response.body) as T;
}

function cookieFrom(response: { readonly headers: Record<string, string | string[] | number | undefined> }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(typeof header === 'string', 'sign-in must set exactly one cookie');
  const value = /^[A-Za-z0-9_]+=([^;]*)/.exec(header);
  assert.ok(value !== null, `the Set-Cookie header must carry a value: ${String(header)}`);
  return `${SESSION_COOKIE_NAME}=${value?.[1] ?? ''}`;
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
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

/** A project, a saved profile, a request, an approved contract, and a linked candidate. */
async function seededJourney(app: FastifyInstance, session: Session): Promise<void> {
  const headers = { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken };

  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers,
    payload: { projectId: PROJECT_ID, name: 'Checkout' },
  });
  assert.ok(created.statusCode === 200 || created.statusCode === 201, `project creation failed: ${created.body}`);

  const profile = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers,
    payload: {
      projectId: PROJECT_ID,
      note: 'the repository candidates are linked from',
      expectedVersionNumber: null,
      content: {
        references: {
          repository: REPOSITORY,
          ticketProvider: 'linear',
          ticketTeamKey: 'OCTO',
          baseBranch: 'main',
          targetBranch: 'main',
          deploymentProvider: 't3',
          engine: 'codex',
          previewComponents: [{ component: 'web', environment: 'preview' }],
        },
        policy: {
          requiredChecks: [REQUIRED_CHECK],
          deliveryBehavior: 'ManualAuthorizationOnly',
          maxFixPasses: 2,
          workspaceIsolation: 'WorktreeAndDataDirectory',
          capabilityVersion: 1,
        },
        recipe: 'npm ci && npm test',
        environment: { runtime: 'node', ports: [3000], secretReferences: [] },
      },
    },
  });
  assert.equal(profile.statusCode, 201, `the profile must save: ${profile.body}`);

  const request = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/requests`,
    headers,
    payload: { title: 'Checkout totals', description: 'The order summary shows the pre-tax total.' },
  });
  assert.equal(request.statusCode, 201, `request creation failed: ${request.body}`);
  const requestView = parse<{ request: RequestView }>(request).request;

  const drafted = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/requests/${requestView.requestId}/contracts`,
    headers,
    payload: {
      outcome: 'The order summary shows the total including tax.',
      scope: ['Sum the line items before tax'],
      outOfScope: ['Changing the tax rate'],
      acceptanceCriteria: [
        {
          id: 'AC1',
          description: 'The summary returns 200.',
          verificationType: 'automated',
          verificationCheckId: REQUIRED_CHECK,
        },
      ],
    },
  });
  assert.equal(drafted.statusCode, 201, `contract drafting failed: ${drafted.body}`);
  const contract = parse<{ contract: ContractView }>(drafted).contract;

  const approved = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/${contract.revision}/approve`,
    headers,
    payload: { expectedContentFingerprint: contract.contentFingerprint },
  });
  assert.equal(approved.statusCode, 200, `approval failed: ${approved.body}`);

  const linked = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/candidates`,
    headers,
    payload: {
      requestId: requestView.requestId,
      contractId: contract.contractId,
      contractRevision: contract.revision,
      pullRequestUrl: `https://github.com/${REPOSITORY}/pull/${PULL_REQUEST_NUMBER}`,
    },
  });
  assert.equal(linked.statusCode, 201, `candidate linking failed: ${linked.body}`);
}

async function home(
  app: FastifyInstance,
  session: Session,
  projectId = PROJECT_ID,
): Promise<{ readonly status: number; readonly body: string }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/projects/${projectId}/home`,
    headers: { cookie: session.cookie },
  });
  return { status: response.statusCode, body: response.body };
}

/* -------------------------------------------------------------------------- */
/* The defect                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * F11-AC1, F02-AC4: Home composes on a real deployment with no injected sources.
 *
 * This is the whole point of the file. Before the fix it answered `503 This deployment exposes no
 * stored candidate or review projection`, because `buildApp` defaulted the sources to `null` and
 * nothing anywhere supplied them — on a database with a project, a profile, an approved contract
 * and a linked candidate in it.
 */
test('F11-AC1, F02-AC4: Home composes from the shipped surface with no homeSources passed', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);

  // Readable durable state, so the refusal cannot be mistaken for an empty project.
  await seededJourney(h.app, session);

  const response = await home(h.app, session);
  assert.equal(response.status, 200, `Home must compose on the shipped composition: ${response.body}`);

  const board = parse<{ home: HomeProjection }>(response).home;
  assert.equal(board.projectId, PROJECT_ID);
  const entries = [...board.needsYou, ...board.inProgress, ...board.readyForReview];
  assert.ok(entries.length > 0, 'a project with a linked candidate must contribute at least one entry');
});

/**
 * F20-AC3: reading Home performs no provider work at all.
 *
 * Asserted as *zero reads reached the provider* alongside the board's real content. The content is
 * what makes this more than a call count: a Home that refreshed the pull request and then answered
 * correctly would pass a count of "one refresh" and fail this, while a Home that answered from
 * cached values without reading its own database would pass a count of zero and fail the content
 * assertion above (F20-AC3, F24-AC4).
 */
test('F20-AC3: reading Home reads stored state and contacts no provider', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  await seededJourney(h.app, session);

  // Every read that happened while *linking* — which legitimately reads the provider — is discarded
  // so what follows observes Home alone.
  h.git.reads.length = 0;

  const response = await home(h.app, session);
  assert.equal(response.status, 200, response.body);
  const board = parse<{ home: HomeProjection }>(response).home;

  assert.deepEqual(
    h.git.reads,
    [],
    'Home must not read the provider: a page view is not a reason to refresh a pull request (mvp-spec 3)',
  );

  // The board's content comes from the stored candidate and the certified review projection.
  const placed = [...board.needsYou, ...board.inProgress, ...board.readyForReview];
  for (const entry of placed) {
    assert.ok(entry.candidateId !== null, 'a linked candidate is placed, so an entry names it');
    assert.notEqual(entry.reason, '', 'and every entry quotes why it is here rather than asserting a reason');
  }
  assert.ok(
    placed.some((entry) => entry.headSha === HEAD_SHA),
    'and the stored commit is the one shown, read from the row rather than fetched (F20-AC3)',
  );
});

/**
 * F02-AC2: the board is scoped by the project in the path.
 *
 * A candidate recorded under `checkout` must not appear on `basket`'s board, and the read must not
 * succeed by asking the provider about the other project either (F02-AC2, F02-AC4).
 */
test('F02-AC2: another project\'s board does not show this project\'s candidate', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  await seededJourney(h.app, session);

  const created = await h.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { projectId: OTHER_PROJECT_ID, name: 'Basket' },
  });
  assert.ok(created.statusCode === 200 || created.statusCode === 201, created.body);

  h.git.reads.length = 0;
  const response = await home(h.app, session, OTHER_PROJECT_ID);
  assert.equal(response.status, 200, response.body);

  const board = parse<{ home: HomeProjection }>(response).home;
  assert.equal(board.projectId, OTHER_PROJECT_ID);
  assert.deepEqual(
    [...board.needsYou, ...board.inProgress, ...board.readyForReview],
    [],
    'the other project holds no requests, so its board is empty — and empty here is a fact, because this project was read',
  );
  assert.deepEqual(h.git.reads, [], 'and reaching that answer cost no provider work either');
});

/**
 * The refusal is still reachable, and still honest.
 *
 * Preserved deliberately. `buildApp` distinguishes an omitted `homeSources` (use the surface's)
 * from an explicit `null` (a caller supplying none), so the route's stated refusal remains
 * testable — and a deployment with a controller that cannot read candidates is better served by
 * the refusal than by three empty groups claiming there is nothing to review (F03-AC2, N03-AC3).
 */
test('F03-AC2: a caller that explicitly supplies no sources still gets the stated refusal', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-home-nosources-'));
  const git = new ScriptedCandidateGit();
  const opened = createCompositionRoot({
    databasePath: join(directory, 'shiploop.db'),
    clock: { now: () => NOW },
    adapters: adapterRegistry(),
    passwordParameters: FAST_PASSWORD_COST,
    sessionIdleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    providers: providerRegistry(git),
  });
  assert.ok(opened.ok, opened.ok ? '' : opened.error.reason);
  const config = readServerConfig({
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_NODE_ENV: 'test',
    SHIPLOOP_COOKIE_SECURE: 'false',
    SHIPLOOP_LOG_LEVEL: 'silent',
  });
  assert.ok(config.ok, config.ok ? '' : JSON.stringify(config.errors));
  const app = await buildApp({
    config: config.value,
    controller: bindControllerSurface(opened.value),
    now: () => new Date(NOW),
    homeSources: null,
  });
  t.after(async () => {
    await app.close();
    opened.value.close();
    await rm(directory, { recursive: true, force: true });
  });

  const session = await signIn(app);
  const response = await home(app, session);
  assert.equal(response.status, 503, 'an explicit null still refuses, and says why');
  assert.match(response.body, /no stored candidate or review projection/);
});

/* -------------------------------------------------------------------------- */
/* The seam, so this is the second time and not the first                      */
/* -------------------------------------------------------------------------- */

/**
 * F11-AC1: the Personal Alpha route groups are present on the surface, not discovered at runtime.
 *
 * Narrow on purpose. This is not a matrix of every group; it asserts the two that were once
 * missing — `candidates` and `home` — because those are the two whose absence a green suite did
 * not catch, and each cost a deployment that answered 503 for a route it had registered. A third
 * would be caught here rather than in a preview (F03-AC2, F02-AC4).
 */
test('F11-AC1: the transport can reach both candidate groups the routes need', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const controller: ControllerSurface = bindControllerSurface(
    (() => {
      const directory = mkdtempSync(join(tmpdir(), 'shiploop-home-groups-'));
      const opened = createCompositionRoot({
        databasePath: join(directory, 'shiploop.db'),
        clock: { now: () => NOW },
        adapters: adapterRegistry(),
        passwordParameters: FAST_PASSWORD_COST,
        sessionIdleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
        providers: providerRegistry(h.git),
      });
      assert.ok(opened.ok, opened.ok ? '' : opened.error.reason);
      return opened.value;
    })(),
  );

  // `home` is a declared member, so this is a compile-time fact as well as a runtime one.
  assert.equal(typeof controller.home, 'object', 'ControllerSurface.home must exist');
  assert.deepEqual(
    Object.keys(controller.home).sort(),
    ['recordedCandidate', 'reviewReadModel'],
    "and it is exactly the two durable reads the Home route calls",
  );

  // `candidates` is reached by discovery in `routes/candidates.ts`, so it is asserted the way the
  // transport reaches it: through the same resolver. Being present here and absent there is the
  // defect that shipped once, and a bare `in` check would not have caught it (F02-AC4).
  assert.notEqual(
    candidateUseCasesOf(controller),
    null,
    'the candidate port must resolve, or every candidate route answers 503 on a real deployment',
  );
});
