/**
 * The seam between the controller and the HTTP layer (F01-AC1, F01-AC2).
 *
 * Every other file in this package is tested against doubles. That is correct for
 * use cases and it is exactly why the web server and this controller had never run
 * in the same process: each half was green, and `main.ts` still refused to start
 * because the module it loaded did not answer the port it declared. A defect that
 * only exists at a boundary cannot be found by testing either side of it, so this
 * file drives the real composition root through the real adapter and checks its
 * shape.
 *
 * The port is transcribed below rather than imported. `apps/web` depends on
 * `@shiploop/controller`, so importing the package the other way is a cycle, and
 * `scripts/lint.mjs` forbids a `packages/**` file importing from `apps/` at all —
 * a policy this repository enforces rather than a limitation to route around.
 * The transcription is the structural half of the port and nothing else: the method
 * names and their arities. Two consequences are stated rather than papered over:
 *
 *   - the compile-time half of the conformance check cannot live here, because the
 *     port's types cannot be named from this package. `ControllerSurface` in
 *     `web-surface.ts` is the local declaration, and it is what the assignment in
 *     the first test proves;
 *   - the run-time half against the web package's OWN `isControllerSurface` is
 *     proven outside this repository, where the import is allowed: booting
 *     `apps/web/src/server/main.ts` with `SHIPLOOP_CONTROLLER_MODULE` pointed at
 *     this package, and driving a real sign-in and a real authorized request
 *     through it. That evidence lives with the boundary, which neither side owns.
 *
 * What this file does prove, on its own: the surface answers the transcribed port,
 * the specifier `main.ts` writes resolves to a surface from inside `apps/web`, and
 * every use case behind that surface reads and writes the real migrated schema.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  DEFAULT_ABSOLUTE_SESSION_TTL_SECONDS,
  authorizeSession,
  generateSessionToken,
  hashSessionToken,
  type CapabilityKind,
  type ConnectorId,
  type OwnerId,
  type ProjectId,
} from '@shiploop/domain';
import { createCompositionRoot } from './composition.ts';
import type { CompositionRoot } from './composition.ts';
import type { AdapterRegistry, ConnectorProbe } from './connectors.ts';
import type { ControllerClock } from './profiles.ts';
import type { ControllerSurface } from './web-surface.ts';
import { bindControllerSurface, createControllerSurface, resolveSurfaceRoot } from './web-surface.ts';

const NOW = '2026-10-01T09:00:00.000Z';
const PASSWORD = 'correct horse battery staple';
const DISPLAY_NAME = 'Solo Owner';
const PROJECT_ID = '0a5f1c22-0000-4000-8000-000000000a1a' as ProjectId;
const IDLE_SECONDS = 900;
const ABSOLUTE_TTL_SECONDS = 28_800;

const clock: ControllerClock = { now: () => NOW };
const FAST_PASSWORD_COST = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16 };

/**
 * `REQUIRED_METHODS` from `apps/web/src/server/contracts.ts`, transcribed.
 *
 * Kept as data rather than inlined into one assertion so a missing method is named
 * the way the web server's own guard names it.
 */
const REQUIRED_METHODS = {
  owners: ['provision', 'signIn'],
  sessions: ['loadByToken', 'create', 'revoke', 'touch'],
  profiles: ['saveVersion', 'currentVersion', 'listVersions'],
  connectors: ['register', 'listForProject', 'revoke'],
} as const satisfies Record<keyof ControllerSurface, readonly string[]>;

/**
 * The web package's own structural guard, transcribed.
 *
 * Deliberately the same shape and the same order as the original: it answers false
 * on the first missing method, so a partial surface reports the group it is
 * incomplete in rather than a generic failure.
 */
function satisfiesTranscribedPort(value: unknown): value is ControllerSurface {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  for (const group of Object.keys(REQUIRED_METHODS) as (keyof typeof REQUIRED_METHODS)[]) {
    const port = candidate[group];
    if (typeof port !== 'object' || port === null) return false;
    const methods = port as Record<string, unknown>;
    for (const method of REQUIRED_METHODS[group]) {
      if (typeof methods[method] !== 'function') return false;
    }
  }
  return true;
}

const DECLARED: Readonly<Record<'Ticket' | 'Git' | 'Deployment' | 'Engine', readonly CapabilityKind[]>> = {
  Ticket: ['Ticket:ReadScope', 'Ticket:UpdateManagedProgress'],
  Git: ['Git:ReadRepository', 'Git:ReadChecks', 'Git:PushBranch'],
  Deployment: ['Deployment:Discover', 'Deployment:ReadIdentity'],
  Engine: ['Engine:VersionCheck', 'Engine:StartScoped'],
};

function declaration(kind: CapabilityKind): {
  kind: CapabilityKind;
  supported: boolean;
  limitation: string | null;
  privileged: boolean;
  supportsPrecondition: boolean;
} {
  return { kind, supported: true, limitation: null, privileged: false, supportsPrecondition: false };
}

const adapters: AdapterRegistry = {
  declarationsFor(kind): readonly ReturnType<typeof declaration>[] {
    return DECLARED[kind].map(declaration);
  },
  probeFor(): ConnectorProbe | null {
    return null;
  },
};

/**
 * A real root on a real migrated file, plus a surface bound to it.
 *
 * `migrate` runs inside `createCompositionRoot`, so the rows these tests read and
 * write are the production schema's rows and not a fixture that agrees with it by
 * coincidence (F01-AC1).
 */
async function withSurface(
  body: (surface: ControllerSurface, root: CompositionRoot) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-web-surface-'));
  try {
    const opened = createCompositionRoot({
      databasePath: join(directory, 'shiploop.db'),
      clock,
      adapters,
      passwordParameters: FAST_PASSWORD_COST,
      sessionIdleTimeoutSeconds: IDLE_SECONDS,
    });
    assert.ok(opened.ok, `the root must open: ${opened.ok ? '' : opened.error.reason}`);
    try {
      await body(bindControllerSurface(opened.value), opened.value);
    } finally {
      opened.value.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a real root answers the transcribed port, by type and at run time (F01-AC1)', async () => {
  await withSurface(async (surface) => {
    // The compile-time half: a surface whose methods or fields drifted from
    // `ControllerSurface` would not typecheck here. The run-time half follows.
    const asPort: ControllerSurface = surface;
    assert.ok(satisfiesTranscribedPort(asPort), 'the transcribed port guard must accept the real surface');
  });
});

test('the module the web server loads passes its own structural check (F01-AC1)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-web-surface-load-'));
  const previousDatabasePath = process.env['SHIPLOOP_DATABASE_PATH'];
  process.env['SHIPLOOP_DATABASE_PATH'] = join(directory, 'shiploop.db');
  try {
    // `main.ts` writes the specifier `@shiploop/controller` and lets Node resolve
    // it from inside `apps/web`. Resolving it the same way, from the same parent,
    // is the only faithful reproduction: a relative import of this package's own
    // entry would skip the very step that failed.
    const fromWebServer = createRequire(new URL('../../../apps/web/src/server/main.ts', import.meta.url));
    const specifier = fromWebServer.resolve('@shiploop/controller');

    // The loader in `main.ts`, reproduced: import the specifier, take the default
    // export when there is one, and check the result. `buildApp` is not reproduced,
    // because the assertion is about the shape that reaches it.
    const loaded: unknown = await import(pathToFileURL(specifier).href);
    const candidate =
      typeof loaded === 'object' && loaded !== null && 'default' in loaded
        ? (loaded as { readonly default?: unknown }).default
        : loaded;
    assert.ok(
      satisfiesTranscribedPort(candidate),
      '@shiploop/controller must load as a controller surface, or apps/web cannot start',
    );
    const surface = candidate as ControllerSurface;
    assert.equal(typeof surface.owners.signIn, 'function');
    assert.equal(typeof surface.sessions.loadByToken, 'function');

    const refused = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(refused.ok, `the loaded surface must reach the real store: ${refused.ok ? '' : refused.error.reason}`);
    assert.equal(refused.value.displayName, DISPLAY_NAME);
  } finally {
    if (previousDatabasePath === undefined) delete process.env['SHIPLOOP_DATABASE_PATH'];
    else process.env['SHIPLOOP_DATABASE_PATH'] = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a missing store is refused by name rather than guessed at (F01-AC1)', () => {
  const previous = process.env['SHIPLOOP_DATABASE_PATH'];
  delete process.env['SHIPLOOP_DATABASE_PATH'];
  try {
    const resolved = resolveSurfaceRoot(process.env);
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.match(resolved.error.reason, /SHIPLOOP_DATABASE_PATH/);
  } finally {
    if (previous !== undefined) process.env['SHIPLOOP_DATABASE_PATH'] = previous;
  }
});

test('a surface built from an unusable resolver refuses every call and throws none (F01-AC1)', async () => {
  const refusal = createControllerSurface(() => ({
    ok: false,
    error: { code: 'Unavailable', reason: 'the store is not open' },
  }));
  const loaded = await refusal.sessions.loadByToken(generateSessionToken());
  assert.equal(loaded.ok, false);
  assert.equal(await refusal.profiles.listVersions(PROJECT_ID).then((value) => value.ok), false);
});

test('a token minted by the web layer authorizes through the real stored row (F01-AC2)', async () => {
  await withSurface(async (surface) => {
    const provisioned = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(provisioned.ok);

    // Exactly what `routes/owner.ts` does: mint here, digest with the domain
    // function, and hand the controller a digest.
    const token = generateSessionToken();
    const granted = await surface.owners.signIn({
      identifier: DISPLAY_NAME,
      password: PASSWORD,
      tokenDigest: hashSessionToken(token),
      issuedAt: NOW,
      absoluteTtlSeconds: ABSOLUTE_TTL_SECONDS,
      idleTimeoutSeconds: IDLE_SECONDS,
    });
    assert.ok(granted.ok, `sign-in must succeed: ${granted.ok ? '' : granted.error.reason}`);
    assert.equal(granted.value.session.tokenDigest, hashSessionToken(token));
    assert.equal(granted.value.session.lastActivityAt, NOW, 'a new session must carry an activity instant');

    const loaded = await surface.sessions.loadByToken(token);
    assert.ok(loaded.ok, 'the minted token must resolve to its row');
    assert.equal(loaded.value.sessionId, granted.value.session.sessionId);

    const authorized = authorizeSession({
      sessionId: loaded.value.sessionId,
      token,
      storedDigest: loaded.value.tokenDigest,
      issuedAt: loaded.value.issuedAt,
      expiresAt: loaded.value.expiresAt,
      revokedAt: loaded.value.revokedAt,
      lastActivityAt: loaded.value.lastActivityAt,
      idleTimeoutSeconds: IDLE_SECONDS,
      now: '2026-10-01T09:00:30.000Z',
    });
    assert.ok(authorized.ok, `the stored row must authorize the real token: ${authorized.ok ? '' : authorized.error}`);

    const wrongToken = authorizeSession({
      sessionId: loaded.value.sessionId,
      token: generateSessionToken(),
      storedDigest: loaded.value.tokenDigest,
      issuedAt: loaded.value.issuedAt,
      expiresAt: loaded.value.expiresAt,
      revokedAt: loaded.value.revokedAt,
      lastActivityAt: loaded.value.lastActivityAt,
      idleTimeoutSeconds: IDLE_SECONDS,
      now: NOW,
    });
    assert.equal(wrongToken.ok, false, 'a digest must not authorize a token that did not produce it (F01-AC2)');
  });
});

test('a revoked session is refused on the same real path, and revocation is durable (F01-AC2)', async () => {
  await withSurface(async (surface, root) => {
    const provisioned = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(provisioned.ok);

    const token = generateSessionToken();
    const granted = await surface.owners.signIn({
      identifier: DISPLAY_NAME,
      password: PASSWORD,
      tokenDigest: hashSessionToken(token),
      issuedAt: NOW,
      absoluteTtlSeconds: ABSOLUTE_TTL_SECONDS,
      idleTimeoutSeconds: IDLE_SECONDS,
    });
    assert.ok(granted.ok);

    const revoked = await surface.sessions.revoke({
      sessionId: granted.value.session.sessionId,
      revokedAt: '2026-10-01T09:00:15.000Z',
    });
    assert.ok(revoked.ok, 'revoking an established session must succeed');
    assert.equal(revoked.value.revokedAt, '2026-10-01T09:00:15.000Z');

    const afterRevocation = await surface.sessions.loadByToken(token);
    assert.ok(afterRevocation.ok, 'a revoked session must still resolve, so the domain can refuse it');
    const refused = authorizeSession({
      sessionId: afterRevocation.value.sessionId,
      token,
      storedDigest: afterRevocation.value.tokenDigest,
      issuedAt: afterRevocation.value.issuedAt,
      expiresAt: afterRevocation.value.expiresAt,
      revokedAt: afterRevocation.value.revokedAt,
      lastActivityAt: afterRevocation.value.lastActivityAt,
      idleTimeoutSeconds: IDLE_SECONDS,
      now: '2026-10-01T09:00:20.000Z',
    });
    assert.equal(refused.ok, false, 'a correct token must not restore a revoked session (F01-AC2)');
    if (!refused.ok) assert.equal(refused.error, 'Revoked');

    const stored = root.owners.findSessionByToken(token);
    assert.ok(stored.ok);
    assert.equal(stored.value?.revokedAt, '2026-10-01T09:00:15.000Z', 'the row itself must carry the revocation');
  });
});

test('a configured idle timeout reaches the stored row and can close the session (F01-AC2)', async () => {
  await withSurface(async (surface, root) => {
    const provisioned = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(provisioned.ok);

    const token = generateSessionToken();
    const granted = await surface.owners.signIn({
      identifier: DISPLAY_NAME,
      password: PASSWORD,
      tokenDigest: hashSessionToken(token),
      issuedAt: NOW,
      absoluteTtlSeconds: ABSOLUTE_TTL_SECONDS,
      idleTimeoutSeconds: IDLE_SECONDS,
    });
    assert.ok(granted.ok);
    const session = granted.value.session;

    // The deadline is the earlier of the two limits, so a caller that configures a
    // short idle limit gets that limit in the row rather than the domain's default.
    assert.equal(
      session.expiresAt,
      new Date(Date.parse(NOW) + IDLE_SECONDS * 1000).toISOString(),
      'the caller\'s idle limit must be what the stored deadline says, not the domain default',
    );
    assert.notEqual(
      session.expiresAt,
      new Date(Date.parse(NOW) + DEFAULT_ABSOLUTE_SESSION_TTL_SECONDS * 1000).toISOString(),
      'a deadline equal to the domain default would mean the configured limit was ignored (F01-AC2)',
    );

    const authorize = (now: string, lastActivityAt: string | null): ReturnType<typeof authorizeSession> =>
      authorizeSession({
        sessionId: session.sessionId,
        token,
        storedDigest: session.tokenDigest,
        issuedAt: session.issuedAt,
        expiresAt: session.expiresAt,
        revokedAt: null,
        lastActivityAt,
        idleTimeoutSeconds: IDLE_SECONDS,
        now,
      });

    assert.equal(
      authorize('2026-10-01T09:14:59.000Z', session.lastActivityAt).ok,
      true,
      'a session inside its configured limit must stay usable',
    );
    assert.equal(
      authorize('2026-10-01T09:15:00.000Z', session.lastActivityAt).ok,
      false,
      'the configured limit must actually close the session (F01-AC2)',
    );

    // The write the request guard makes on every authorized request.
    const touched = await surface.sessions.touch({
      sessionId: session.sessionId,
      lastActivityAt: '2026-10-01T09:14:30.000Z',
    });
    assert.deepEqual(touched, { ok: true, value: null });
    const moved = root.owners.findSessionByToken(token);
    assert.ok(moved.ok);
    assert.equal(moved.value?.lastSeenAt, '2026-10-01T09:14:30.000Z', 'the column must move, or the limit is inert');
  });
});

test('reducing the configured idle limit closes a session that was created under a longer one (F01-AC2)', async () => {
  await withSurface(async (surface) => {
    const provisioned = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(provisioned.ok);

    // The session is opened under a long limit, so its stored deadline is long too.
    const token = generateSessionToken();
    const granted = await surface.owners.signIn({
      identifier: DISPLAY_NAME,
      password: PASSWORD,
      tokenDigest: hashSessionToken(token),
      issuedAt: NOW,
      absoluteTtlSeconds: ABSOLUTE_TTL_SECONDS,
      idleTimeoutSeconds: ABSOLUTE_TTL_SECONDS,
    });
    assert.ok(granted.ok);
    const session = granted.value.session;

    // The guard reads the currently configured limit on every request, so an
    // operator who shortens it reaches a point where the stored deadline is still
    // open and the activity comparison is the thing that refuses. That is the one
    // situation the activity column decides, and before it was written the column
    // was never consulted at all.
    const tightened = (now: string, lastActivityAt: string): ReturnType<typeof authorizeSession> =>
      authorizeSession({
        sessionId: session.sessionId,
        token,
        storedDigest: session.tokenDigest,
        issuedAt: session.issuedAt,
        expiresAt: session.expiresAt,
        revokedAt: null,
        lastActivityAt,
        idleTimeoutSeconds: 60,
        now,
      });

    assert.equal(tightened('2026-10-01T09:00:30.000Z', NOW).ok, true);
    assert.equal(tightened('2026-10-01T09:01:00.000Z', NOW).ok, false);
    const expired = tightened('2026-10-01T09:01:00.000Z', NOW);
    if (!expired.ok) assert.equal(expired.error, 'IdleExpired');

    // Recording activity is what lets the same session continue under the new limit.
    const touched = await surface.sessions.touch({
      sessionId: session.sessionId,
      lastActivityAt: '2026-10-01T09:01:00.000Z',
    });
    assert.deepEqual(touched, { ok: true, value: null });
    assert.equal(tightened('2026-10-01T09:01:30.000Z', '2026-10-01T09:01:00.000Z').ok, true);
  });
});

test('an unknown identifier and a wrong password are one answer (N02-AC1)', async () => {
  await withSurface(async (surface) => {
    const provisioned = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(provisioned.ok);

    const attempt = async (identifier: string, password: string) =>
      surface.owners.signIn({
        identifier,
        password,
        tokenDigest: hashSessionToken(generateSessionToken()),
        issuedAt: NOW,
        absoluteTtlSeconds: ABSOLUTE_TTL_SECONDS,
        idleTimeoutSeconds: IDLE_SECONDS,
      });

    const unknown = await attempt('nobody-with-this-name', PASSWORD);
    const wrongPassword = await attempt(DISPLAY_NAME, 'a different long password value');
    assert.equal(unknown.ok, false);
    assert.equal(wrongPassword.ok, false);
    if (!unknown.ok && !wrongPassword.ok) {
      assert.equal(unknown.error.code, 'Forbidden');
      assert.equal(unknown.error.reason, wrongPassword.error.reason, 'sign-in must not be an existence oracle');
    }
  });
});

test('an owner row with no activity instant is refused rather than read as no limit (F01-AC2)', async () => {
  await withSurface(async (surface, root) => {
    const provisioned = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(provisioned.ok);
    const token = generateSessionToken();
    const granted = await surface.owners.signIn({
      identifier: DISPLAY_NAME,
      password: PASSWORD,
      tokenDigest: hashSessionToken(token),
      issuedAt: NOW,
      absoluteTtlSeconds: ABSOLUTE_TTL_SECONDS,
      idleTimeoutSeconds: IDLE_SECONDS,
    });
    assert.ok(granted.ok);

    root.database
      .prepare('UPDATE sessions SET last_seen_at = NULL WHERE session_id = ?')
      .run(granted.value.session.sessionId);

    const loaded = await surface.sessions.loadByToken(token);
    assert.equal(loaded.ok, false, 'a row the idle rule cannot be applied to must not authorize (F01-AC2)');
    if (!loaded.ok) assert.match(loaded.error.reason, /Malformed/);
  });
});

test('a profile and a connector round-trip through the surface (F02-AC3, F03-AC2)', async () => {
  await withSurface(async (surface) => {
    const provisioned = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(provisioned.ok);
    const actor = provisioned.value.ownerId as OwnerId;

    const empty = await surface.profiles.currentVersion(PROJECT_ID);
    assert.ok(empty.ok);
    assert.equal(empty.value, null, 'a project with no profile must read as null, not as a refusal');

    const saved = await surface.profiles.saveVersion({
      projectId: PROJECT_ID,
      content: profileContent(),
      note: 'first version',
      expectedVersionNumber: null,
      at: NOW,
      actor,
    });
    assert.ok(saved.ok, `a valid profile must save: ${saved.ok ? '' : saved.error.reason}`);
    assert.equal(saved.value.versionNumber, 1);
    assert.equal(saved.value.note, 'first version');
    assert.equal(saved.value.supersedesVersionId, null);

    const stale = await surface.profiles.saveVersion({
      projectId: PROJECT_ID,
      content: { ...profileContent(), recipe: 'a different recipe' },
      note: 'from a stale editor',
      expectedVersionNumber: 99,
      at: NOW,
      actor,
    });
    assert.equal(stale.ok, false, 'a stale expected version must be refused (F02-AC2)');
    if (!stale.ok) assert.equal(stale.error.code, 'Conflict');

    const versions = await surface.profiles.listVersions(PROJECT_ID);
    assert.ok(versions.ok);
    assert.equal(versions.value.length, 1);

    const registered = await surface.connectors.register({
      projectId: PROJECT_ID,
      provider: 'linear',
      kind: 'Ticket',
      resourceScope: 'team ENG',
      credentialReference: 'shiploop://credentials/linear-team-eng',
      at: NOW,
      actor,
    });
    assert.ok(registered.ok, `a valid connector must register: ${registered.ok ? '' : registered.error.reason}`);
    assert.equal(registered.value.credentialReference, 'shiploop://credentials/linear-team-eng');
    assert.equal(registered.value.state, 'Unconfigured');
    assert.deepEqual(registered.value.reads, ['Ticket:ReadScope', 'Ticket:UpdateManagedProgress']);
    assert.deepEqual(registered.value.writes, [], 'nothing privileged is declared, so nothing is writable');
    assert.ok(registered.value.credentialReferenceDigest.length > 0);

    const listed = await surface.connectors.listForProject(PROJECT_ID);
    assert.ok(listed.ok);
    assert.equal(listed.value.length, 1);
    assert.equal(listed.value[0]?.connectorId, registered.value.connectorId);

    const revoked = await surface.connectors.revoke({
      connectorId: registered.value.connectorId as ConnectorId,
      at: NOW,
      reason: 'the owner withdrew access',
      actor,
    });
    assert.ok(revoked.ok);
    assert.equal(revoked.value.state, 'Revoked');
  });
});

test('reads are refused when no owner is provisioned (F01-AC1)', async () => {
  await withSurface(async (surface) => {
    const versions = await surface.profiles.listVersions(PROJECT_ID);
    assert.equal(versions.ok, false, 'a database with no owner must not answer a read anonymously (F01-AC1)');
    const connectors = await surface.connectors.listForProject(PROJECT_ID);
    assert.equal(connectors.ok, false);
  });
});

function profileContent(): {
  references: {
    repository: string;
    ticketProvider: string;
    ticketTeamKey: string | null;
    baseBranch: string;
    targetBranch: string;
    deploymentProvider: string;
    engine: string;
    previewComponents: readonly { component: string; environment: string }[];
  };
  policy: {
    requiredChecks: readonly string[];
    deliveryBehavior: 'ManualAuthorizationOnly';
    maxFixPasses: number;
    workspaceIsolation: 'WorktreeAndDataDirectory';
    capabilityVersion: number;
  };
  recipe: string;
  environment: { runtime: string; ports: readonly number[]; secretReferences: readonly string[] };
} {
  return {
    references: {
      repository: 'github.com/example/project',
      ticketProvider: 'linear',
      ticketTeamKey: 'ENG',
      baseBranch: 'main',
      targetBranch: 'main',
      deploymentProvider: 'vercel',
      engine: 'node-24',
      previewComponents: [{ component: 'web', environment: 'preview' }],
    },
    policy: {
      requiredChecks: ['pnpm check', 'pnpm test'],
      deliveryBehavior: 'ManualAuthorizationOnly',
      maxFixPasses: 2,
      workspaceIsolation: 'WorktreeAndDataDirectory',
      capabilityVersion: 1,
    },
    recipe: 'corepack enable && pnpm install --frozen-lockfile',
    environment: { runtime: 'node-24', ports: [4100], secretReferences: ['shiploop://credentials/linear-team-eng'] },
  };
}
