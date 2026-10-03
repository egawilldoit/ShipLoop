/**
 * The handoff route, driven against the real controller (mvp-spec L02, L02-AC3; N02-AC2).
 *
 * `api.test.ts` covers the transport against a double, and a double cannot answer the
 * question this route exists to answer. The value of a handoff is that its text is the
 * controller's - byte for byte, redacted, and derived from one approved contract - so a
 * fixture that assembled its own packet would make "the response is exactly what the
 * generator produces" true by construction and prove nothing. This file therefore boots the
 * shipped entry point's real composition root over a real migrated SQLite file and drives it
 * with `app.inject()`, the same way the browser does, with no listener and no port.
 *
 * It is also the only place the two declarations of the port meet. `packages/controller`
 * cannot import `apps/web`'s types without a cycle, so its own test transcribes the port's
 * method names; here the real surface is assigned to the web package's `ControllerSurface`,
 * which is the assignment the compiler actually checks (F01-AC1).
 *
 * What is proved, in order of how much it matters:
 *
 *   - an approved revision answers with the generator's exact bytes, and its fingerprint is
 *     the digest of those bytes;
 *   - a draft revision and a retired approval are both refused with the approval remedy, and
 *     neither produces a document;
 *   - a revision in another project is not found at all, and an anonymous caller is refused
 *     before either fact is considered;
 *   - credentials seeded into project data - the project name, the request, the contract - do
 *     not survive into the response;
 *   - no T3 configured is a normal answer with a complete packet, a configured one is
 *     reported verbatim, and a refused one is reported without reproducing it;
 *   - the response carries nothing else, so it cannot be read as an execution status.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SESSION_COOKIE_NAME, fingerprint } from '@shiploop/domain';
import type { CapabilityDeclaration } from '@shiploop/domain';
import type { FastifyInstance } from 'fastify';
import type { ConnectorKind } from '@shiploop/storage';
import {
  bindControllerSurface,
  createCompositionRoot,
  createControllerSurface,
  generateImplementationPacket,
  resolveSurfaceRoot,
  type AdapterRegistry,
  type CompositionRoot,
} from '@shiploop/controller';
import { buildApp } from '../app.ts';
import { CSRF_HEADER } from '../auth-guard.ts';
import { readServerConfig } from '../config.ts';
import { isControllerSurface } from '../contracts.ts';
import type { ContractView, ControllerSurface, HandoffView, RequestView } from '../contracts.ts';

const NOW = '2026-10-03T09:00:00.000Z';
const DISPLAY_NAME = 'Solo Owner';
const PASSWORD = 'correct horse battery staple';
const PROJECT_ID = 'checkout';
const OTHER_PROJECT_ID = 'checkout-other';
const CSRF_SECRET = ['server', 'secret', 'material', '0123456789abcdef'].join('-');
const IDLE_TIMEOUT_SECONDS = 900;
const FAST_PASSWORD_COST = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16 };

const REQUEST_TITLE = 'Checkout totals';
const REQUEST_DESCRIPTION = 'The order summary shows the pre-tax total.';

/**
 * Credential-shaped values, assembled from parts.
 *
 * `scripts/lint.mjs` refuses a credential-shaped literal in tracked source, and these are the
 * values the redaction rules have to be able to recognise - `url-credentials` for the
 * database URL, `generic-bearer` for the header, `github-token` for the token, and the
 * Linear key shape for the contract text. Spelled as fragments, they are still the real
 * shapes at run time, and the marker assertions below check the exact substrings.
 */
const GITHUB_TOKEN = ['ghp', 'A1b2C3d4E5f6G7h8'].join('_');
const LINEAR_KEY = ['lin', 'api', 'secret0123456789abcdef'].join('_');
const DATABASE_URL = 'postgres://octopus:hunter2@db.internal/octopus';
const BEARER_HEADER = `Bearer ${['a1b2c3d4e5f6', 'g7h8i9j0k1l2'].join('')}`;

/**
 * The contract content a body carries, as the MVP's own example.
 *
 * Typed as a shape rather than as one literal so the redaction case can submit different
 * text through the same journey: the route and the store must treat both the ordinary
 * contract and the credential-laden one identically (N02-AC2).
 */
interface ContractContent {
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly {
    readonly id: string;
    readonly description: string;
    readonly verificationType: 'automated' | 'owner_test';
    /** The check that verifies an automated criterion; absent for an owner test. */
    readonly verificationCheckId?: string | null;
  }[];
}

const CONTRACT_CONTENT: ContractContent = {
  outcome: 'The order summary shows the total including tax.',
  scope: ['Sum the line items before tax', 'Apply the configured tax rate'],
  outOfScope: ['Changing the tax rate'],
  acceptanceCriteria: [
    {
      id: 'AC1',
      description: 'The summary returns 200 and displays "Total: 12.00".',
      verificationType: 'automated',
      // A check name, not a check run: the binding has to survive every re-run, or the
      // criterion could never be verified after a push. Approval refuses an automated
      // criterion without one, so the packet journey needs it here too.
      verificationCheckId: 'unit-tests',
    },
    { id: 'AC2', description: 'The owner confirms the total matches the invoice they were sent.', verificationType: 'owner_test' },
  ],
};

/** No provider is configured: the MVP journey must work with none (mvp-spec MVP). */
const NO_ADAPTERS: AdapterRegistry = {
  declarationsFor(_kind: ConnectorKind): readonly CapabilityDeclaration[] {
    return [];
  },
  probeFor() {
    return null;
  },
};

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly close: () => Promise<void>;
  readonly now: () => Date;
}

/**
 * A real app over a real store, with an optional configured T3 deployment.
 *
 * `t3Url` is passed to the composition root rather than set on `process.env`, because the
 * root is what an operator configures and reading the environment from inside a library
 * would make that fact untestable (N02-AC2). `harnessFromEnvironment` below covers the
 * other half: the variable name itself.
 */
async function harness(options: { readonly t3Url?: string | null } = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-handoff-route-'));
  const opened = createCompositionRoot({
    databasePath: join(directory, 'shiploop.db'),
    clock: { now: () => NOW },
    adapters: NO_ADAPTERS,
    passwordParameters: FAST_PASSWORD_COST,
    sessionIdleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    t3Url: options.t3Url ?? null,
  });
  assert.ok(opened.ok, `the store must open: ${opened.ok ? '' : opened.error.reason}`);
  return serve(opened.value, directory);
}

/**
 * The same app, composed the way `main.ts` composes it: from an environment.
 *
 * This is the only place the *variable name* is checked, and that is deliberate. A handoff
 * URL read from one spelling while the operator sets another would report `NotConfigured`
 * to a deployment that did configure T3 - a defect with no symptom anywhere else, because
 * the packet is still returned and nothing in the journey fails (mvp-spec L02-AC3).
 */
async function harnessFromEnvironment(extra: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-handoff-env-'));
  const env: NodeJS.ProcessEnv = { ...extra, SHIPLOOP_DATABASE_PATH: join(directory, 'shiploop.db') };
  // The guard `main.ts` runs before anything serves a request, proved over the real surface
  // rather than over a literal (F01-AC1).
  assert.ok(
    isControllerSurface(createControllerSurface(() => resolveSurfaceRoot(env))),
    'the loaded surface must pass the web server structural guard',
  );
  const resolved = resolveSurfaceRoot(env);
  assert.ok(resolved.ok, `the store must open from the environment: ${resolved.ok ? '' : resolved.error.reason}`);
  return serve(resolved.value, directory);
}

/** Wraps an opened root in the app under test, and closes both ends. */
async function serve(root: CompositionRoot, directory: string): Promise<Harness> {
  // The assignment the compiler checks: the controller's own surface declaration, proved to
  // satisfy the port `apps/web` composes against (F01-AC1).
  const controller: ControllerSurface = bindControllerSurface(root);
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
    now: () => new Date(NOW),
    close: async () => {
      await app.close();
      root.close();
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
  assert.equal(typeof header, 'string', 'sign-in must set exactly one cookie');
  const value = /^[A-Za-z0-9_]+=([^;]*)/.exec(String(header));
  assert.ok(value !== null, `the Set-Cookie header must carry a value: ${String(header)}`);
  return `${SESSION_COOKIE_NAME}=${value?.[1] ?? ''}`;
}

/** Provisions the owner, signs in and returns the cookie and token every later call needs. */
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

async function createProject(
  app: FastifyInstance,
  session: Session,
  projectId: string,
  name: string,
): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { projectId, name },
  });
  assert.ok(response.statusCode === 200 || response.statusCode === 201, `project creation failed: ${response.body}`);
}

interface ApprovedContract {
  readonly requestId: string;
  readonly contractId: string;
  readonly revision: number;
}

/**
 * A project with one approved revision, built entirely over HTTP.
 *
 * The journey is the MVP's own: a request, a contract drafted against it, and the owner's
 * approval. Nothing here reaches a provider, an engine or a T3 deployment, which is the
 * point - the handoff has to exist on a deployment that configured none of them.
 */
async function approvedContract(
  app: FastifyInstance,
  session: Session,
  projectId = PROJECT_ID,
  name = 'Checkout',
  content: ContractContent = CONTRACT_CONTENT,
  requestDescription = REQUEST_DESCRIPTION,
): Promise<ApprovedContract> {
  await createProject(app, session, projectId, name);
  const created = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/requests`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { title: REQUEST_TITLE, description: requestDescription },
  });
  assert.equal(created.statusCode, 201, `request creation failed: ${created.body}`);
  const request = parse<{ request: RequestView }>(created).request;

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
    payload: {},
  });
  assert.equal(approved.statusCode, 200, `approval failed: ${approved.body}`);
  return { requestId: request.requestId, contractId: contract.contractId, revision: contract.revision };
}

/** The URL the owner browser would use, from the path the specification fixes. */
function handoffUrl(projectId: string, contractId: string, revision: number): string {
  return `/api/projects/${projectId}/contracts/${contractId}/${revision}/handoff`;
}

/**
 * The packet the generator produces for the contract this test submitted.
 *
 * Computed here from the values that went over the wire, so the assertion compares the
 * response against the generator rather than against a copy of what the response said. The
 * project is the only input this file cannot read back, so its name is the one the test
 * chose when it created the project.
 */
function expectedPacket(options: {
  readonly projectName: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly requestDescription: string;
  readonly content: ContractContent;
}): string {
  const generated = generateImplementationPacket({
    project: { id: PROJECT_ID, name: options.projectName, repository: null, defaultBranch: null },
    request: { id: options.requestId, title: REQUEST_TITLE, description: options.requestDescription },
    contract: {
      id: options.contractId,
      revision: 1,
      status: 'approved',
      approvedAt: NOW,
      outcome: options.content.outcome,
      scope: options.content.scope.join('\n'),
      outOfScope: options.content.outOfScope,
      acceptanceCriteria: options.content.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    },
    procedureReferences: [],
  });
  assert.ok(generated.ok, `the expected packet must render: ${generated.ok ? '' : generated.error.reason}`);
  return generated.value.markdown;
}

test('an approved revision answers with the generator\'s exact bytes, and no T3 is still a packet (L02-AC3, N02-AC2)', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const contract = await approvedContract(h.app, session);

  const response = await h.app.inject({
    method: 'GET',
    url: handoffUrl(PROJECT_ID, contract.contractId, contract.revision),
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = parse<{ handoff: HandoffView }>(response).handoff;

  assert.equal(body.contractId, contract.contractId);
  assert.equal(body.revision, contract.revision);
  assert.equal(
    body.packet.markdown,
    expectedPacket({
      projectName: 'Checkout',
      requestId: contract.requestId,
      contractId: contract.contractId,
      requestDescription: REQUEST_DESCRIPTION,
      content: CONTRACT_CONTENT,
    }),
    'the response must carry the generator\'s bytes, not a reformatted copy of them',
  );
  assert.equal(body.packet.fingerprint, fingerprint(body.packet.markdown), 'the fingerprint must digest these bytes');

  // Nothing configured is the normal state of a deployment that does not use T3, and the
  // packet is complete without it (mvp-spec MVP).
  assert.equal(body.t3.state, 'NotConfigured');
  assert.equal('url' in body.t3, false, 'an unconfigured T3 has no URL to offer');

  // The response says four things and nothing else. A field naming a session, a run or an
  // execution status would be a claim ShipLoop cannot make: external execution is outside
  // it, and it must never report progress it cannot prove (mvp-spec L02).
  assert.deepEqual(Object.keys(body).sort(), ['contractId', 'packet', 'revision', 't3']);
  assert.deepEqual(Object.keys(body.packet).sort(), ['fingerprint', 'markdown']);

  // The packet describes the work and claims none of it is done, and it never mentions an
  // executor having run (mvp-spec L02-AC3).
  assert.ok(body.packet.markdown.includes(REQUEST_TITLE));
  assert.match(body.packet.markdown, /Contract revision: 1/);
  assert.equal(/session (?:is|has been) (?:created|open)/i.test(body.packet.markdown), false);

  // Two reads of one approved contract are the same document, so a client may compare them
  // rather than trust either.
  const again = await h.app.inject({
    method: 'GET',
    url: handoffUrl(PROJECT_ID, contract.contractId, contract.revision),
    headers: { cookie: session.cookie },
  });
  assert.equal(parse<{ handoff: HandoffView }>(again).handoff.packet.fingerprint, body.packet.fingerprint);
});

test('a draft revision is refused with the approval remedy, and nothing is rendered (mvp-spec 3)', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  await createProject(h.app, session, PROJECT_ID, 'Checkout');
  const created = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/requests`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { title: REQUEST_TITLE, description: REQUEST_DESCRIPTION },
  });
  const request = parse<{ request: RequestView }>(created).request;
  const drafted = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}/contracts`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: CONTRACT_CONTENT,
  });
  const draft = parse<{ contract: ContractView }>(drafted).contract;

  const response = await h.app.inject({
    method: 'GET',
    url: handoffUrl(PROJECT_ID, draft.contractId, draft.revision),
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 422, `a draft must not be handed off: ${response.body}`);
  const problem = parse<{ error: { code: string; prerequisites?: readonly { name: string; remedy: string }[] } }>(response);
  assert.equal(problem.error.code, 'Blocked');
  assert.equal(problem.error.prerequisites?.[0]?.name, 'contractApproval');
  assert.match(problem.error.prerequisites?.[0]?.remedy ?? '', /approve revision 1/i);
  assert.equal(response.body.includes('# ShipLoop implementation handoff'), false, 'a refusal renders no packet');
});

test('a retired approval is refused the same way, so a stale revision cannot be packetized (mvp-spec 3)', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const contract = await approvedContract(h.app, session);

  const retired = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/${contract.revision}/invalidate`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { reason: 'RequestChanged' },
  });
  assert.equal(retired.statusCode, 200, `retiring an approval must succeed first: ${retired.body}`);

  const response = await h.app.inject({
    method: 'GET',
    url: handoffUrl(PROJECT_ID, contract.contractId, contract.revision),
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 422, `a retired approval must not be handed off: ${response.body}`);
  const problem = parse<{ error: { code: string } }>(response);
  assert.equal(problem.error.code, 'Blocked');
  assert.match(response.body, /stale/i, 'the refusal names the revision\'s state');
});

test('nothing crosses a project boundary, and an anonymous caller is refused first (F02-AC2, F01-AC1)', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const contract = await approvedContract(h.app, session);

  const anonymous = await h.app.inject({
    method: 'GET',
    url: handoffUrl(PROJECT_ID, contract.contractId, contract.revision),
  });
  assert.equal(anonymous.statusCode, 401, 'a private read needs a session');
  assert.equal(
    anonymous.body.includes('# ShipLoop implementation handoff'),
    false,
    'an anonymous caller learns nothing, not even that the revision exists',
  );

  const elsewhere = await h.app.inject({
    method: 'GET',
    url: handoffUrl(OTHER_PROJECT_ID, contract.contractId, contract.revision),
    headers: { cookie: session.cookie },
  });
  assert.equal(elsewhere.statusCode, 404, `another project's address must not find this revision: ${elsewhere.body}`);
  assert.equal(elsewhere.body.includes('# ShipLoop implementation handoff'), false);

  // A forged token is refused on a read too. `GET` needs no token to be *absent*, but a
  // token that is offered and is wrong must not pass, or a stale token from another page
  // would be laundered through this route into a later state-changing one (F01-AC4).
  const forged = await h.app.inject({
    method: 'GET',
    url: handoffUrl(PROJECT_ID, contract.contractId, contract.revision),
    headers: { cookie: session.cookie, [CSRF_HEADER]: 'x'.repeat(43) },
  });
  assert.equal(forged.statusCode, 403, `a forged token must be refused: ${forged.body}`);
  assert.equal(forged.body.includes('# ShipLoop implementation handoff'), false);

  // And the unscoped spellings do not exist. A handoff addressed without its project could
  // be read by anything that knew the contract id (mvp-spec 3).
  for (const url of [
    `/api/contracts/${contract.contractId}/${contract.revision}/handoff`,
    `/api/handoff?projectId=${PROJECT_ID}`,
    `/api/projects/${PROJECT_ID}/handoff`,
  ]) {
    const response = await h.app.inject({ method: 'GET', url, headers: { cookie: session.cookie } });
    assert.equal(response.statusCode, 404, `${url} must not exist: ${response.body}`);
  }
});

test('credentials seeded into project data do not survive into the response (N02-AC2, F03-AC3)', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);

  // Every one of these is a place the packet renders stored text: the project's name, the
  // request's description, the contract's outcome, its scope, an out-of-scope line and a
  // criterion. A credential pasted into any of them used to travel wherever that text did.
  const secretContent: ContractContent = {
    outcome: `The order summary shows the total, using the key ${LINEAR_KEY}.`,
    scope: [`Read the database at ${DATABASE_URL}`, `Present the header "${BEARER_HEADER}"`],
    outOfScope: [`Rotating ${GITHUB_TOKEN}`],
    acceptanceCriteria: [
      {
        id: 'AC1',
        description: `The summary works with the token ${GITHUB_TOKEN}.`,
        verificationType: 'automated',
        verificationCheckId: 'unit-tests',
      },
    ],
  };

  const contract = await approvedContract(
    h.app,
    session,
    PROJECT_ID,
    `Checkout ${GITHUB_TOKEN}`,
    secretContent,
    `The summary reads ${DATABASE_URL} with "${BEARER_HEADER}".`,
  );

  const response = await h.app.inject({
    method: 'GET',
    url: handoffUrl(PROJECT_ID, contract.contractId, contract.revision),
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);

  // The credential *portions* are what must not survive. The host and path of a database URL
  // do survive, and that is the domain redaction rule's decision rather than an accident: a
  // URL loses its `user:pass@` and keeps what identifies the database, so the packet still
  // tells an implementer where the data lives while the password cannot be read out of it
  // (N02-AC2).
  for (const marker of [GITHUB_TOKEN, LINEAR_KEY, 'hunter2', 'octopus:hunter2', BEARER_HEADER]) {
    assert.equal(response.body.includes(marker), false, `the response leaked ${marker}: ${response.body}`);
  }
  // The packet is still a packet: redaction replaces the value with a labelled placeholder
  // rather than dropping the sentence the owner wrote.
  assert.match(response.body, /\[redacted:url-credentials\]/);
  assert.match(response.body, /\[redacted:github-token\]/);
  assert.match(response.body, /\[redacted:linear-api-key\]/);
  assert.equal(
    response.body.includes('# ShipLoop implementation handoff'),
    true,
    'the document survives redaction',
  );
});

test('the environment variable an operator sets is the one the response reports (mvp-spec L02-AC3)', async (t) => {
  const h = await harnessFromEnvironment({ SHIPLOOP_T3_URL: 'https://t3.example.test/from-env' });
  t.after(() => h.close());
  const session = await signIn(h.app);
  const contract = await approvedContract(h.app, session);

  const response = await h.app.inject({
    method: 'GET',
    url: handoffUrl(PROJECT_ID, contract.contractId, contract.revision),
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const state = parse<{ handoff: HandoffView }>(response).handoff.t3;
  assert.equal(state.state, 'Configured');
  assert.equal(state.state === 'Configured' ? state.url : '', 'https://t3.example.test/from-env');
});

test('the configured T3 deployment is reported verbatim, and a refused one is reported without its value (N02-AC2)', async (t) => {
  const configured = await harness({ t3Url: 'https://t3.example.test' });
  t.after(() => configured.close());
  const session = await signIn(configured.app);
  const contract = await approvedContract(configured.app, session);

  const response = await configured.app.inject({
    method: 'GET',
    url: handoffUrl(PROJECT_ID, contract.contractId, contract.revision),
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = parse<{ handoff: HandoffView }>(response).handoff;
  assert.equal(body.t3.state, 'Configured');
  assert.equal(body.t3.state === 'Configured' ? body.t3.url : '', 'https://t3.example.test');
  assert.ok(body.packet.markdown.length > 0, 'a configured T3 does not change the packet');

  // A credential-bearing value is refused as configuration, and the refusal never reproduces
  // what the operator typed - a value bad enough to be refused may be the secret itself.
  const unusable = await harness({ t3Url: 'https://user:hunter2@t3.example.test' });
  t.after(() => unusable.close());
  const other = await signIn(unusable.app);
  const refusedContract = await approvedContract(unusable.app, other, PROJECT_ID, 'Checkout');
  const refused = await unusable.app.inject({
    method: 'GET',
    url: handoffUrl(PROJECT_ID, refusedContract.contractId, refusedContract.revision),
    headers: { cookie: other.cookie },
  });
  assert.equal(refused.statusCode, 200, 'an unusable T3 URL is an operator problem, not a broken handoff');
  const state = parse<{ handoff: HandoffView }>(refused).handoff.t3;
  assert.equal(state.state, 'Unusable');
  assert.equal('url' in state, false, 'a refused configuration offers no URL to open');
  assert.equal(refused.body.includes('hunter2'), false, `the response reproduced the refused value: ${refused.body}`);
  assert.ok(
    state.state === 'Unusable' && state.prerequisites.length > 0,
    'an operator error has to arrive with its remedy',
  );
});
