/**
 * HTTP route tests for `GET|PATCH /api/projects/:projectId/settings`
 * (mvp-spec 3, L02-AC2, L02-AC3, F02-AC2, F03-AC3, N02-AC2).
 *
 * These tests deliberately run against the REAL controller over a REAL migrated SQLite
 * database, through the real `buildApp`, the real session guard and real CSRF, with nothing
 * stubbed below the socket. `api.test.ts` proves the transport against an in-memory double
 * because that is the right way to cover seventy-odd routes at once; a double would prove
 * nothing here, because almost every rule this slice owns lives *behind* the route: which
 * URLs are usable, whether a project may be addressed at all, what a stored row is allowed to
 * contain, and whether a credential can reach a response. A route test over a double would
 * pass while the product refused valid URLs or published a credential pointer.
 *
 * What is asserted, and why each case exists:
 *
 *   - the journey works with no T3 configured at all (L02-AC3), so "absent" must be a 200;
 *   - a value that is refused is refused *without being echoed*, because a value bad enough
 *     to be refused may itself be the secret (L02-AC2, N02-AC2);
 *   - no response, on any path, contains a credential reference or value (F03-AC3);
 *   - a project this deployment does not hold is invisible rather than empty (F02-AC2).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SESSION_COOKIE_NAME, type CapabilityKind, type OwnerId, type ProjectId } from '@shiploop/domain';
import { bindControllerSurface, createCompositionRoot } from '@shiploop/controller';
import type { AdapterRegistry, ConnectorProbe } from '@shiploop/controller';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.ts';
import { CSRF_HEADER } from '../auth-guard.ts';
import { readServerConfig } from '../config.ts';
import type { ControllerSurface, ProjectSettingsView } from '../contracts.ts';

const NOW = '2026-03-01T12:00:00.000Z';
const OWNER_NAME = 'Octopus Owner';
const OWNER_PASSWORD = 'correct horse battery staple';
const OWNER_ID = 'own_settings_route_test' as OwnerId;
const PROJECT = 'octopus-main' as ProjectId;
const PROJECT_ID = String(PROJECT);
const OTHER_PROJECT_ID = 'octopus-docs';
const REPOSITORY = 'github.com/octopus/octopus-web';
const T3_URL = 'https://t3.example.test/app';
const CREDENTIAL_REFERENCE = 'credentials/linear/octopus-main';
/** A value that must never appear in any response body (F03-AC3, N02-AC2). */
const SEEDED_SECRET = ['ghp', '0123456789abcdef0123456789abcdef'].join('_');
/** The password a credential in the URL would be, used only to prove it is not echoed. */
const URL_PASSWORD = 'hunter2';
const QUERY_SECRET = 'abcdef0123456789abcdef0123456789';
const CSRF_SECRET = ['server', 'secret', 'material', '0123456789abcdef'].join('-');

/** Cheap scrypt so a real sign-in does not cost production time; every other rule is real. */
const FAST_PASSWORD_COST = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16 };
const IDLE_SECONDS = 900;

/**
 * An adapter registry that declares the capabilities a profile save needs.
 *
 * Settings itself needs no adapter, and the tests below save a profile only to prove the
 * repository configuration is read rather than copied, so this exists to keep that save from
 * being refused for an unrelated reason (F02-AC4).
 */
const DECLARED: Readonly<Record<'Ticket' | 'Git' | 'Deployment' | 'Engine', readonly CapabilityKind[]>> = {
  Ticket: ['Ticket:ReadScope', 'Ticket:UpdateManagedProgress'],
  Git: ['Git:ReadRepository', 'Git:ReadChecks', 'Git:PushBranch'],
  Deployment: ['Deployment:Discover', 'Deployment:ReadIdentity'],
  Engine: ['Engine:VersionCheck', 'Engine:StartScoped'],
};

const adapters: AdapterRegistry = {
  declarationsFor(kind) {
    return DECLARED[kind].map((capability) => ({
      kind: capability,
      supported: true,
      limitation: null,
      privileged: false,
      supportsPrecondition: false,
    }));
  },
  probeFor(): ConnectorProbe | null {
    return null;
  },
};

interface Harness {
  readonly app: FastifyInstance;
  readonly controller: ControllerSurface;
  readonly session: Session;
  readonly close: () => Promise<void>;
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

interface SettingsPayload {
  readonly settings: ProjectSettingsView;
}

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
  };
  readonly signInRequired?: boolean;
}

/**
 * A signed-in server over a real database, with one project.
 *
 * Provisioning, project creation and sign-in all go through the shipped routes or the real
 * use cases, so the session a request carries is one the product actually issued.
 */
async function withServer(body: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-settings-route-'));
  try {
    const config = readServerConfig({
      SHIPLOOP_NODE_ENV: 'test',
      SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
      SHIPLOOP_COOKIE_SECURE: 'false',
      SHIPLOOP_LOG_LEVEL: 'silent',
      SHIPLOOP_SESSION_IDLE_SECONDS: String(IDLE_SECONDS),
    });
    assert.ok(config.ok, `the test configuration must be valid: ${JSON.stringify(config.ok ? '' : config.errors)}`);
    const now = () => new Date(NOW);

    const opened = createCompositionRoot({
      databasePath: join(directory, 'shiploop.db'),
      clock: { now: () => NOW },
      adapters,
      passwordParameters: FAST_PASSWORD_COST,
      sessionIdleTimeoutSeconds: IDLE_SECONDS,
    });
    assert.ok(opened.ok, `the composition root must open: ${opened.ok ? '' : opened.error.reason}`);
    const root = opened.value;
    const controller = bindControllerSurface(root);
    const app = await buildApp({ config: config.value, controller, now });

    const provisioned = await controller.owners.provision({ displayName: OWNER_NAME, password: OWNER_PASSWORD, at: NOW });
    assert.ok(provisioned.ok, `the owner must provision: ${provisioned.ok ? '' : provisioned.error.reason}`);
    for (const projectId of [PROJECT_ID, OTHER_PROJECT_ID]) {
      const created = await controller.projects.createProject({ projectId, name: projectId, at: NOW });
      assert.ok(created.ok, `the project must be created: ${created.ok ? '' : created.error.reason}`);
    }

    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/owner/sign-in',
      payload: { identifier: OWNER_NAME, password: OWNER_PASSWORD },
    });
    assert.equal(signedIn.statusCode, 200, `sign-in must succeed: ${signedIn.body}`);
    const raw = signedIn.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    assert.equal(typeof header, 'string', 'sign-in must set the session cookie');
    const value = /^[A-Za-z0-9_]+=([^;]*)/.exec(String(header));
    assert.ok(value !== null, 'the session cookie must carry a value');
    const identity = JSON.parse(signedIn.body) as { readonly csrfToken: string };

    await body({
      app,
      controller,
      session: { cookie: `${SESSION_COOKIE_NAME}=${value[1] ?? ''}`, csrfToken: identity.csrfToken },
      close: async () => {
        await app.close();
        root.close();
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function read(harness: Harness, projectId = PROJECT_ID): Promise<{ readonly status: number; readonly body: string }> {
  const response = await harness.app.inject({
    method: 'GET',
    url: `/api/projects/${projectId}/settings`,
    headers: { cookie: harness.session.cookie },
  });
  return { status: response.statusCode, body: response.body };
}

/** A body this suite submits; deliberately typed, because the point of some cases is its shape. */
type SubmittedBody = Record<string, unknown>;

async function save(
  harness: Harness,
  payload: SubmittedBody,
  projectId = PROJECT_ID,
): Promise<{ readonly status: number; readonly body: string }> {
  const response = await harness.app.inject({
    method: 'PATCH',
    url: `/api/projects/${projectId}/settings`,
    headers: { cookie: harness.session.cookie, [CSRF_HEADER]: harness.session.csrfToken },
    payload,
  });
  return { status: response.statusCode, body: response.body };
}

function settingsOf(body: string): ProjectSettingsView {
  return (JSON.parse(body) as SettingsPayload).settings;
}

function errorOf(body: string): ErrorPayload['error'] {
  return (JSON.parse(body) as ErrorPayload).error;
}

/* --------------------------------------------------------------- the happy path */

test('mvp-spec 3: a project that configured nothing reads as not configured, with a 200', async () => {
  await withServer(async (harness) => {
    const response = await read(harness);

    assert.equal(response.status, 200, `an unconfigured project is a state, not a failure: ${response.body}`);
    const settings = settingsOf(response.body);
    assert.equal(settings.projectId, PROJECT_ID);
    assert.deepEqual(settings.t3, { configured: false, url: null });
    assert.equal(settings.updatedAt, null);
    assert.equal(settings.repository.configured, false);
    assert.deepEqual(settings.providers, []);
    assert.equal(response.body.includes(SEEDED_SECRET), false);
  });
});

test('L02-AC2: a valid T3 URL is stored, returned, and still there on the next read', async () => {
  await withServer(async (harness) => {
    const saved = await save(harness, { t3Url: T3_URL });
    assert.equal(saved.status, 200, `the save must succeed: ${saved.body}`);
    assert.deepEqual(settingsOf(saved.body).t3, { configured: true, url: T3_URL });

    const reread = await read(harness);
    assert.equal(reread.status, 200);
    assert.deepEqual(settingsOf(reread.body).t3, { configured: true, url: T3_URL });
    assert.notEqual(settingsOf(reread.body).updatedAt, null, 'a configured project records when it was written');
  });
});

test('L02-AC3: clearing the URL works, and leaves the project not configured rather than broken', async () => {
  await withServer(async (harness) => {
    await save(harness, { t3Url: T3_URL });

    const cleared = await save(harness, { t3Url: null });
    assert.equal(cleared.status, 200, `clearing must be a success: ${cleared.body}`);
    assert.deepEqual(settingsOf(cleared.body).t3, { configured: false, url: null });

    const reread = await read(harness);
    assert.equal(reread.status, 200);
    assert.deepEqual(settingsOf(reread.body).t3, { configured: false, url: null });
  });
});

test('a save naming nothing reads back, so a read-then-save round trip is idempotent', async () => {
  await withServer(async (harness) => {
    await save(harness, { t3Url: T3_URL });

    const unchanged = await save(harness, {});
    assert.equal(unchanged.status, 200);
    assert.deepEqual(settingsOf(unchanged.body).t3, { configured: true, url: T3_URL });
  });
});

/* --------------------------------------------------------------- the refusals */

test('L02-AC2: a malformed, non-http(s) or credential-bearing URL is refused, and never echoed', async () => {
  await withServer(async (harness) => {
    const refusals: readonly string[] = [
      't3.example.test',
      '://missing-scheme',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://t3.example.test',
      `https://operator:${URL_PASSWORD}@t3.example.test`,
      `https://t3.example.test/app?token=${QUERY_SECRET}`,
      `https://t3.example.test/${SEEDED_SECRET}`,
    ];

    for (const value of refusals) {
      const response = await save(harness, { t3Url: value });

      assert.equal(response.status, 422, `expected ${value.split('?')[0]}… to be refused: ${response.body}`);
      const error = errorOf(response.body);
      assert.equal(error.code, 'Blocked');
      assert.ok(
        (error.prerequisites ?? []).length > 0,
        'the refusal must name the prerequisite and its remedy, not just fail (F04-AC3)',
      );
      for (const secret of [URL_PASSWORD, QUERY_SECRET, SEEDED_SECRET]) {
        assert.equal(
          response.body.includes(secret),
          false,
          `the refusal for ${value.split('?')[0]}… must not reproduce any part of the value`,
        );
      }
    }

    const after = await read(harness);
    assert.equal(settingsOf(after.body).t3.configured, false, 'no refused value may have been stored');
  });
});

test('a refused save does not disturb the value that was already configured', async () => {
  await withServer(async (harness) => {
    await save(harness, { t3Url: T3_URL });

    const refused = await save(harness, { t3Url: 'javascript:alert(1)' });
    assert.equal(refused.status, 422);

    const after = await read(harness);
    assert.deepEqual(settingsOf(after.body).t3, { configured: true, url: T3_URL });
  });
});

test('F02-AC4: a field that is not a project setting is refused by name rather than dropped', async () => {
  await withServer(async (harness) => {
    const response = await save(harness, { t3Url: T3_URL, credentialReference: CREDENTIAL_REFERENCE });

    assert.equal(response.status, 400, `an unknown field is a client error: ${response.body}`);
    const error = errorOf(response.body);
    assert.deepEqual(
      (error.fields ?? []).map((field) => field.path),
      ['credentialReference'],
      'the refused field is named, so a client cannot believe it stored something',
    );
  });
});

/* ------------------------------------------------------------------- the refusals */

test('F03-AC3: a settings response never carries a credential reference or value', async () => {
  await withServer(async (harness) => {
    const registered = await harness.controller.connectors.register({
      projectId: PROJECT,
      provider: 'linear',
      kind: 'Ticket',
      resourceScope: 'team/OCT',
      credentialReference: CREDENTIAL_REFERENCE,
      at: NOW,
      actor: OWNER_ID,
    });
    assert.ok(registered.ok, `the connector must register: ${registered.ok ? '' : registered.error.reason}`);
    assert.equal(
      registered.value.credentialReference,
      CREDENTIAL_REFERENCE,
      'the connector route is where a reference is registered and returned (F03-AC1)',
    );

    const response = await read(harness);

    assert.equal(response.status, 200);
    const settings = settingsOf(response.body);
    assert.equal(settings.providers.length, 1, 'the configured provider is visible in settings');
    assert.equal(
      response.body.includes(CREDENTIAL_REFERENCE),
      false,
      'the pointer into the credential store must not travel in a settings response (F03-AC3)',
    );
    assert.ok(settings.providers[0]?.credentialReferenceDigest, 'the digest identifies the reference without it (F32-AC2)');
    assert.equal(
      Object.keys(settings.providers[0] ?? {}).includes('credentialReference'),
      false,
      'the settings projection has no field a reference could be read out of',
    );
  });
});

test('F02-AC1: repository configuration is read from the saved profile version, and is not written here', async () => {
  await withServer(async (harness) => {
    const saved = await harness.controller.profiles.saveVersion({
      projectId: PROJECT,
      content: {
        references: {
          repository: REPOSITORY,
          ticketProvider: 'linear',
          ticketTeamKey: 'OCT',
          baseBranch: 'main',
          targetBranch: 'ship/loop-1',
          deploymentProvider: 'vercel',
          engine: 'codex',
          previewComponents: [{ component: 'web', environment: 'preview' }],
        },
        policy: {
          requiredChecks: ['typecheck'],
          deliveryBehavior: 'ManualAuthorizationOnly',
          maxFixPasses: 2,
          workspaceIsolation: 'WorktreeAndDataDirectory',
          capabilityVersion: 1,
        },
        recipe: 'pnpm test',
        environment: { runtime: 'node24', ports: [4100], secretReferences: [CREDENTIAL_REFERENCE] },
      },
      note: null,
      expectedVersionNumber: null,
      at: NOW,
      actor: OWNER_ID,
    });
    assert.ok(saved.ok, `the profile must save: ${saved.ok ? '' : saved.error.reason}`);

    const response = await read(harness);

    assert.equal(response.status, 200);
    const settings = settingsOf(response.body);
    assert.equal(settings.repository.configured, true);
    assert.equal(settings.repository.repository, REPOSITORY);
    assert.equal(settings.repository.baseBranch, 'main');
    assert.equal(settings.repository.versionNumber, saved.value.versionNumber, 'the version identity travels with it (F02-AC3)');
    assert.equal(
      response.body.includes(CREDENTIAL_REFERENCE),
      false,
      "a profile's secret *references* are not credentials, and settings must not become a place they are listed (F03-AC3)",
    );
  });
});

test('F02-AC2: one project\'s settings are never another project\'s, and an unknown project is a 404', async () => {
  await withServer(async (harness) => {
    await save(harness, { t3Url: T3_URL });

    const other = await read(harness, OTHER_PROJECT_ID);
    assert.equal(other.status, 200);
    assert.deepEqual(settingsOf(other.body).t3, { configured: false, url: null }, 'a sibling project is its own blank slate');

    const unknown = await read(harness, 'no-such-project');
    assert.equal(unknown.status, 404, `a project this deployment does not hold must not read as configured: ${unknown.body}`);
    assert.equal(errorOf(unknown.body).code, 'NotFound');
    assert.equal(unknown.body.includes(T3_URL), false, 'the refusal must not describe another configuration');

    const written = await save(harness, { t3Url: 'https://t3.example.test/other' }, 'no-such-project');
    assert.equal(written.status, 404, 'a write to an unknown project is refused, not silently dropped (F02-AC2)');
  });
});

/* ------------------------------------------------------------ the session boundary */

test('F01-AC1: settings are behind the session guard, and a save needs the forgery token', async () => {
  await withServer(async (harness) => {
    const anonymous = await harness.app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/settings` });
    assert.equal(anonymous.statusCode, 401, 'an anonymous read must be refused before any row is read (F01-AC1)');

    const anonymousSave = await harness.app.inject({
      method: 'PATCH',
      url: `/api/projects/${PROJECT_ID}/settings`,
      payload: { t3Url: T3_URL },
    });
    assert.equal(anonymousSave.statusCode, 401);

    const withoutToken = await harness.app.inject({
      method: 'PATCH',
      url: `/api/projects/${PROJECT_ID}/settings`,
      headers: { cookie: harness.session.cookie },
      payload: { t3Url: T3_URL },
    });
    assert.equal(withoutToken.statusCode, 403, 'a state-changing request without the forgery token is refused (F01-AC4)');
    assert.equal(withoutToken.body.includes(T3_URL), false, 'and the refusal does not echo the value');
  });
});

test('N03-AC3: a project id that is a traversal is refused by the route schema', async () => {
  await withServer(async (harness) => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/projects/${encodeURIComponent('../other')}/settings`,
      headers: { cookie: harness.session.cookie },
    });

    assert.equal(response.statusCode, 400, `a traversing project id is a client error: ${response.body}`);
    assert.equal(errorOf(response.body).code, 'Invalid');
  });
});
