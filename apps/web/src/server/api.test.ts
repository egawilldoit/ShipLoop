/**
 * HTTP boundary tests for the owner API.
 *
 * Every request here goes through `app.inject()`, which is a real HTTP round trip
 * through the plugin, hook, guard and error-handling stack the browser will hit;
 * nothing is stubbed below the socket. What *is* substituted is the controller, and
 * that substitution is deliberate: `packages/controller` is developed independently
 * of this server, so these tests bind the `contracts.ts` ports to a small in-memory
 * store and prove the transport against it. The parts that are not substituted are the
 * ones under test — cookie flags, the session gate, CSRF, validation, security
 * headers, cache control and the error-to-status mapping — together with the real
 * domain functions the fake also uses (`hashPassword`, `verifyPassword`,
 * `sessionDeadlines`, `capabilitiesFor`, `fingerprint`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MINIMUM_PASSWORD_LENGTH,
  SESSION_COOKIE_NAME,
  blocked,
  capabilitiesFor,
  conflict,
  fingerprint,
  hashPassword,
  hashSessionToken,
  ok,
  outcomeUnknown,
  sessionDeadlines,
  verifyPassword,
  type CapabilityDeclaration,
  type CapabilityKind,
  type ConnectorId,
  type DomainError,
  type OwnerId,
  type ProfileVersionId,
  type ProjectId,
  type Result,
} from '@shiploop/domain';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { describeConfigErrors, readServerConfig, type ServerConfig } from './config.ts';
import {
  isControllerSurface,
  type ConnectorView,
  type ControllerSurface,
  type CreateSessionCommand,
  type OwnerView,
  type ProfileContent,
  type ProfileVersionView,
  type ProvisionOwnerCommand,
  type RegisterConnectorCommand,
  type RevokeConnectorCommand,
  type RevokeSessionCommand,
  type SaveProfileVersionCommand,
  type SignInCommand,
  type SignInGrant,
  type StoredSessionRecord,
  type TouchSessionCommand,
} from './contracts.ts';

const CSRF_SECRET = ['server', 'secret', 'material', '0123456789abcdef'].join('-');
const START = '2026-03-01T12:00:00.000Z';
const OWNER_ID = 'own_1' as OwnerId;
const OWNER_NAME = 'Octopus Owner';
const OWNER_PASSWORD = 'correct horse battery staple';
const PROJECT_ID = 'octopus-main';
const REPOSITORY = 'github.com/octopus/octopus-web';
const TEAM_KEY = 'OCT';
const CREDENTIAL_REFERENCE = 'credentials/linear/octopus-main';
/** A value that must never appear in any response body (F03-AC3, N02-AC2). */
const SEEDED_SECRET = ['lin', 'api', 'secret', '0123456789abcdef0123'].join('_');

const LINEAR_CAPABILITIES: readonly CapabilityDeclaration[] = [
  { kind: 'Ticket:ReadScope', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  { kind: 'Ticket:PublishIssue', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  { kind: 'Git:MergeWithPrecondition', supported: false, limitation: 'Linear cannot merge code.', privileged: true, supportsPrecondition: false },
];

const GIT_CAPABILITIES: readonly CapabilityDeclaration[] = [
  { kind: 'Git:ReadRepository', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  { kind: 'Git:CreateDraft', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  { kind: 'Git:MergeWithPrecondition', supported: true, limitation: null, privileged: true, supportsPrecondition: true },
];

const ADAPTER_CAPABILITIES: CapabilityDeclarationsByProvider = {
  linear: LINEAR_CAPABILITIES,
  github: GIT_CAPABILITIES,
};

/** The capability declarations a fake adapter reports for a provider. */
type CapabilityDeclarationsByProvider = Readonly<Record<string, readonly CapabilityDeclaration[]>>;

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
    readonly expected?: string;
    readonly actual?: string;
    readonly operationId?: string;
    readonly target?: string;
  };
  readonly signInRequired?: boolean;
}

interface OwnerPayload {
  readonly owner: { readonly ownerId: string; readonly displayName: string };
  readonly session: { readonly sessionId: string; readonly issuedAt: string; readonly expiresAt: string };
  readonly csrfToken: string;
}

interface ProfilePayload {
  readonly profile: ProfileVersionView;
}

interface ConnectorPayload {
  readonly connector: ConnectorView;
}

interface ConnectorListPayload {
  readonly connectors: readonly ConnectorView[];
}

interface ProfileListPayload {
  readonly profiles: readonly ProfileVersionView[];
}

function createClock(start: string): { now: () => Date; advance: (seconds: number) => void } {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance: (seconds: number) => {
      current += seconds * 1000;
    },
  };
}

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

/**
 * In-memory controller.
 *
 * Real hashing, real deadlines and real capability splitting, in maps instead of
 * SQLite. It refuses the same things the real ports must refuse: a stale profile save
 * conflicts, a revoked connector blocks the operations that depend on it, and a
 * sign-in failure is answered without saying which half of the credential was wrong.
 */
class InMemoryController implements ControllerSurface {
  private readonly sessionsById = new Map<string, StoredSessionRecord>();
  private readonly sessionIdByDigest = new Map<string, string>();
  private readonly profileVersions = new Map<string, ProfileVersionView[]>();
  private readonly connectorRecords = new Map<string, ConnectorView>();
  private readonly capabilities: CapabilityDeclarationsByProvider;
  private passwordHash = '';
  private readonly scripted = new Map<string, DomainError>();

  constructor(
    _now: () => Date,
    capabilities: CapabilityDeclarationsByProvider,
    provisionOwner: boolean,
  ) {
    this.capabilities = capabilities;
    if (provisionOwner) {
      const hashed = hashPassword(OWNER_PASSWORD);
      if (!hashed.ok) throw new Error('The test owner password must satisfy the domain policy.');
      this.passwordHash = hashed.value;
    }
  }

  /** Arms a one-shot domain error for the next call of a use case. */
  script(useCase: string, error: DomainError): void {
    this.scripted.set(useCase, error);
  }

  private takeScripted(useCase: string): DomainError | null {
    const error = this.scripted.get(useCase);
    if (error !== undefined) this.scripted.delete(useCase);
    return error ?? null;
  }

  readonly owners = {
    provision: async (command: ProvisionOwnerCommand): Promise<Result<OwnerView, DomainError>> => {
      const scripted = this.takeScripted('provision');
      if (scripted !== null) return { ok: false, error: scripted };
      const hashed = hashPassword(command.password);
      if (!hashed.ok) return { ok: false, error: hashed.error };
      if (this.passwordHash !== '') return { ok: false, error: conflict('An owner is already provisioned.', 'none', 'one') };
      this.passwordHash = hashed.value;
      return ok({ ownerId: OWNER_ID, displayName: command.displayName, createdAt: command.at });
    },

    signIn: async (command: SignInCommand): Promise<Result<SignInGrant, DomainError>> => {
      const scripted = this.takeScripted('signIn');
      if (scripted !== null) return { ok: false, error: scripted };
      const known = this.passwordHash !== '' && command.identifier === OWNER_NAME;
      const authenticated = known && verifyPassword(command.password, this.passwordHash);
      if (!known || !authenticated) {
        verifyPassword(command.password, decoyHash());
        return {
          ok: false,
          error: {
            code: 'Forbidden',
            reason: known ? 'The password did not match the stored credential.' : 'No owner matches that identifier.',
          },
        };
      }
      const deadlines = sessionDeadlines({
        issuedAt: command.issuedAt,
        absoluteTtlSeconds: command.absoluteTtlSeconds,
        idleTimeoutSeconds: command.idleTimeoutSeconds,
      });
      const sessionId = `ses_${this.sessionsById.size + 1}`;
      const record: StoredSessionRecord = {
        sessionId,
        ownerId: OWNER_ID,
        displayName: OWNER_NAME,
        tokenDigest: command.tokenDigest,
        issuedAt: deadlines.issuedAt,
        expiresAt: deadlines.expiresAt,
        revokedAt: null,
        lastActivityAt: null,
      };
      this.sessionsById.set(sessionId, record);
      this.sessionIdByDigest.set(command.tokenDigest, sessionId);
      return ok({ session: record });
    },
  };

  readonly sessions = {
    loadByToken: async (token: string): Promise<Result<StoredSessionRecord, DomainError>> => {
      const sessionId = this.sessionIdByDigest.get(hashToken(token));
      const record = sessionId === undefined ? undefined : this.sessionsById.get(sessionId);
      if (record === undefined) return { ok: false, error: { code: 'NotFound', reason: 'No such session.' } };
      return ok(record);
    },

    create: async (command: CreateSessionCommand): Promise<Result<StoredSessionRecord, DomainError>> => {
      const deadlines = sessionDeadlines({
        issuedAt: command.issuedAt,
        absoluteTtlSeconds: command.absoluteTtlSeconds,
        idleTimeoutSeconds: command.idleTimeoutSeconds,
      });
      const sessionId = `ses_${this.sessionsById.size + 1}`;
      const record: StoredSessionRecord = {
        sessionId,
        ownerId: command.ownerId,
        displayName: command.displayName,
        tokenDigest: command.tokenDigest,
        issuedAt: deadlines.issuedAt,
        expiresAt: deadlines.expiresAt,
        revokedAt: null,
        lastActivityAt: null,
      };
      this.sessionsById.set(sessionId, record);
      this.sessionIdByDigest.set(command.tokenDigest, sessionId);
      return ok(record);
    },

    revoke: async (command: RevokeSessionCommand): Promise<Result<StoredSessionRecord, DomainError>> => {
      const record = this.sessionsById.get(command.sessionId);
      if (record === undefined) return { ok: false, error: { code: 'NotFound', reason: 'No such session.' } };
      const revoked: StoredSessionRecord = { ...record, revokedAt: command.revokedAt };
      this.sessionsById.set(record.sessionId, revoked);
      return ok(revoked);
    },

    touch: async (command: TouchSessionCommand): Promise<Result<null, DomainError>> => {
      const record = this.sessionsById.get(command.sessionId);
      if (record === undefined) return { ok: false, error: { code: 'NotFound', reason: 'No such session.' } };
      this.sessionsById.set(record.sessionId, { ...record, lastActivityAt: command.lastActivityAt });
      return ok(null);
    },
  };

  readonly profiles = {
    saveVersion: async (command: SaveProfileVersionCommand): Promise<Result<ProfileVersionView, DomainError>> => {
      const scripted = this.takeScripted('saveProfile');
      if (scripted !== null) return { ok: false, error: scripted };
      const history = this.profileVersions.get(command.projectId) ?? [];
      const newest = history[history.length - 1];
      const actualVersionNumber = newest?.versionNumber ?? 0;
      if (command.expectedVersionNumber !== null && command.expectedVersionNumber !== actualVersionNumber) {
        return {
          ok: false,
          error: conflict(
            'The profile changed after it was loaded. Reload it before saving again.',
            String(command.expectedVersionNumber),
            String(actualVersionNumber),
          ),
        };
      }
      const revoked = [...this.connectorRecords.values()].find(
        (connector) => connector.projectId === command.projectId && connector.state === 'Revoked',
      );
      if (revoked !== undefined) {
        return {
          ok: false,
          error: blocked('The profile cannot be saved while a required connector is revoked.', [
            {
              name: `connector.${revoked.kind}.credential`,
              detail: `${revoked.provider} access was revoked for ${revoked.resourceScope}.`,
              remedy: 'Register a working credential reference for this connector, then save the profile again.',
            },
          ]),
        };
      }
      const version: ProfileVersionView = {
        profileVersionId: `prv_${history.length + 1}` as ProfileVersionId,
        projectId: command.projectId,
        versionNumber: actualVersionNumber + 1,
        supersedesVersionId: newest?.profileVersionId ?? null,
        content: command.content,
        contentFingerprint: fingerprint(command.content),
        note: command.note,
        createdAt: command.at,
        createdBy: command.actor,
      };
      this.profileVersions.set(command.projectId, [...history, version]);
      return ok(version);
    },

    currentVersion: async (projectId: ProjectId): Promise<Result<ProfileVersionView | null, DomainError>> => {
      const history = this.profileVersions.get(projectId) ?? [];
      return ok(history[history.length - 1] ?? null);
    },

    listVersions: async (projectId: ProjectId): Promise<Result<readonly ProfileVersionView[], DomainError>> =>
      ok(this.profileVersions.get(projectId) ?? []),
  };

  readonly connectors = {
    register: async (command: RegisterConnectorCommand): Promise<Result<ConnectorView, DomainError>> => {
      const scripted = this.takeScripted('registerConnector');
      if (scripted !== null) return { ok: false, error: scripted };
      const connectorId = `con_${this.connectorRecords.size + 1}` as ConnectorId;
      const summary = capabilitiesFor(this.capabilities[command.provider] ?? []);
      const view: ConnectorView = {
        connectorId,
        projectId: command.projectId,
        provider: command.provider,
        kind: command.kind,
        resourceScope: command.resourceScope,
        credentialReference: command.credentialReference,
        credentialReferenceDigest: fingerprint(command.credentialReference),
        state: 'Healthy',
        error: null,
        lastCheckedAt: command.at,
        lastSuccessAt: command.at,
        reads: summary.reads,
        writes: summary.writes,
        unsupported: summary.unsupported,
        createdAt: command.at,
        updatedAt: command.at,
      };
      this.connectorRecords.set(connectorId, view);
      return ok(view);
    },

    listForProject: async (projectId: ProjectId): Promise<Result<readonly ConnectorView[], DomainError>> =>
      ok([...this.connectorRecords.values()].filter((connector) => connector.projectId === projectId)),

    revoke: async (command: RevokeConnectorCommand): Promise<Result<ConnectorView, DomainError>> => {
      const existing = this.connectorRecords.get(command.connectorId);
      if (existing === undefined) return { ok: false, error: { code: 'NotFound', reason: 'No such connector.' } };
      const revoked: ConnectorView = {
        ...existing,
        state: 'Revoked',
        error: `Access was revoked: ${command.reason}. Register a working credential to reconnect.`,
        updatedAt: command.at,
      };
      this.connectorRecords.set(command.connectorId, revoked);
      return ok(revoked);
    },
  };
}

let decoyHashCache: string | null = null;

/** A credential digest nobody knows, so an unknown owner still costs the same work. */
function decoyHash(): string {
  if (decoyHashCache === null) {
    const hashed = hashPassword('a-password-nobody-presented');
    if (!hashed.ok) throw new Error('The decoy credential must satisfy the domain policy.');
    decoyHashCache = hashed.value;
  }
  return decoyHashCache;
}

/** The same digest the server stores, so the fake matches on what the wire presents. */
function hashToken(token: string): string {
  return hashSessionToken(token);
}

function profileContent(overrides: Partial<ProfileContent> = {}): ProfileContent {
  const base: ProfileContent = {
    references: {
      repository: REPOSITORY,
      ticketProvider: 'linear',
      ticketTeamKey: TEAM_KEY,
      baseBranch: 'main',
      targetBranch: 'ship/loop-1',
      deploymentProvider: 'vercel',
      engine: 'codex',
      previewComponents: [{ component: 'web', environment: 'preview' }],
    },
    policy: {
      requiredChecks: ['typecheck', 'test'],
      deliveryBehavior: 'ManualAuthorizationOnly',
      maxFixPasses: 2,
      workspaceIsolation: 'WorktreeAndDataDirectory',
      capabilityVersion: 1,
    },
    recipe: 'pnpm install && pnpm check && pnpm test',
    environment: { runtime: 'node24', ports: [4100], secretReferences: ['linear/octopus-main'] },
  };
  return { ...base, ...overrides };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly controller: InMemoryController;
  readonly clock: { now: () => Date; advance: (seconds: number) => void };
  readonly close: () => Promise<void>;
}

async function harness(options: { readonly config?: Partial<ServerConfig>; readonly provisionOwner?: boolean } = {}): Promise<Harness> {
  const clock = createClock(START);
  const controller = new InMemoryController(clock.now, ADAPTER_CAPABILITIES, options.provisionOwner ?? true);
  const config: ServerConfig = { ...testConfig(), ...options.config };
  const app = await buildApp({ config, controller, now: clock.now });
  return { app, controller, clock, close: () => app.close() };
}

function setCookieHeader(response: InjectedResponse): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  assert.equal(typeof header, 'string', 'the response must set exactly one cookie');
  return typeof header === 'string' ? header : '';
}

function cookieFrom(response: InjectedResponse): string {
  const header = setCookieHeader(response);
  const value = /^[A-Za-z0-9_]+=([^;]*)/.exec(header);
  assert.ok(value !== null, `the Set-Cookie header must carry a value: ${header}`);
  return `${SESSION_COOKIE_NAME}=${value[1] ?? ''}`;
}

function parse<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

/** The parts of an injected response these tests read. */
interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: NodeJS.Dict<string | string[] | number | undefined>;
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

async function signIn(app: FastifyInstance, identifier = OWNER_NAME, password = OWNER_PASSWORD): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: { identifier, password },
  });
  assert.equal(response.statusCode, 200, `sign-in failed: ${response.body}`);
  const body = parse<OwnerPayload>(response);
  return { cookie: cookieFrom(response), csrfToken: body.csrfToken };
}

async function seedProfile(h: Harness, session: Session, projectId = PROJECT_ID): Promise<ProfilePayload> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { projectId, content: profileContent() },
  });
  assert.equal(response.statusCode, 201, `profile save failed: ${response.body}`);
  return parse<ProfilePayload>(response);
}

async function seedConnector(h: Harness, session: Session, projectId = PROJECT_ID): Promise<ConnectorPayload> {
  const response = await h.app.inject({
    method: 'POST',
    url: `/api/profiles/${projectId}/connectors`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: {
      provider: 'linear',
      kind: 'Ticket',
      resourceScope: `${TEAM_KEY} team`,
      credentialReference: CREDENTIAL_REFERENCE,
    },
  });
  assert.equal(response.statusCode, 201, `connector registration failed: ${response.body}`);
  return parse<ConnectorPayload>(response);
}

test('F01-AC1: every private route refuses an anonymous request and leaks nothing', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  await seedProfile(h, session);
  await seedConnector(h, session);

  const anonymous: { readonly method: 'GET' | 'POST'; readonly url: string; readonly payload?: Record<string, unknown> }[] = [
    { method: 'GET', url: '/api/owner/session' },
    { method: 'GET', url: `/api/profiles/${PROJECT_ID}` },
    { method: 'GET', url: `/api/profiles/${PROJECT_ID}/versions` },
    { method: 'GET', url: `/api/profiles/${PROJECT_ID}/connectors` },
    { method: 'POST', url: '/api/profiles', payload: { projectId: PROJECT_ID, content: profileContent() } },
    {
      method: 'POST',
      url: `/api/profiles/${PROJECT_ID}/connectors`,
      payload: { provider: 'linear', kind: 'Ticket', resourceScope: 'OCT', credentialReference: CREDENTIAL_REFERENCE },
    },
    { method: 'POST', url: '/api/connectors/con_1/revoke', payload: { reason: 'no longer needed' } },
    { method: 'POST', url: '/api/owner/sign-out' },
    { method: 'GET', url: '/artifacts/run-1/evidence.txt' },
  ];

  for (const request of anonymous) {
    const response = await h.app.inject({
      method: request.method,
      url: request.url,
      ...(request.payload === undefined ? {} : { payload: request.payload }),
    });
    assert.equal(response.statusCode, 401, `${request.method} ${request.url} must refuse an anonymous request`);
    const body = response.body;
    assert.equal(parse<ErrorPayload>(response).error.code, 'Unauthorized');
    for (const marker of [REPOSITORY, TEAM_KEY, CREDENTIAL_REFERENCE, PROJECT_ID, SEEDED_SECRET, OWNER_NAME, 'profileVersionId', 'credentialReference']) {
      assert.ok(!body.includes(marker), `${request.url} leaked ${marker}: ${body}`);
    }
  }
});

test('F01-AC1: an unknown private path answers identically with and without a session', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const anonymous = await h.app.inject({ method: 'GET', url: '/api/there-is-no-such-route' });
  assert.equal(anonymous.statusCode, 401);
  assert.ok(!anonymous.body.includes('route'), `the refusal must not describe the missing route: ${anonymous.body}`);

  const session = await signIn(h.app);
  const authenticated = await h.app.inject({
    method: 'GET',
    url: '/api/there-is-no-such-route',
    headers: { cookie: session.cookie },
  });
  assert.equal(authenticated.statusCode, 404);
  assert.equal(parse<ErrorPayload>(authenticated).error.code, 'NotFound');
});

test('F01-AC2, F01-AC4: sign-in sets an HttpOnly, Secure, SameSite session cookie', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: { identifier: OWNER_NAME, password: OWNER_PASSWORD },
  });
  assert.equal(response.statusCode, 200);
  const setCookie = setCookieHeader(response);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=\d+/);
  assert.equal(/SameSite=None/.test(setCookie), false);

  const body = parse<OwnerPayload>(response);
  assert.equal(body.owner.displayName, OWNER_NAME);
  assert.ok(!response.body.includes(OWNER_PASSWORD), 'the response must not echo the password');
  assert.ok(!response.body.includes(SEEDED_SECRET));
});

test('F01-AC2: signing out revokes the session, so the old cookie stops working', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const before = await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: session.cookie } });
  assert.equal(before.statusCode, 200);

  const signedOut = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-out',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
  });
  assert.equal(signedOut.statusCode, 204);
  assert.match(setCookieHeader(signedOut), /Max-Age=0/);

  const after = await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: session.cookie } });
  assert.equal(after.statusCode, 401, 'the revoked cookie must be refused even though it is still presented');
  assert.equal(parse<ErrorPayload>(after).signInRequired, true);

  const profile = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}`,
    headers: { cookie: session.cookie },
  });
  assert.equal(profile.statusCode, 401);

  const fresh = await signIn(h.app);
  const recovered = await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: fresh.cookie } });
  assert.equal(recovered.statusCode, 200, 'signing in again must work');
  assert.notEqual(fresh.cookie, session.cookie, 'a new sign-in must mint a new token');
});

test('F01-AC2: a session past its deadline is refused', async (t) => {
  const h = await harness({ config: { sessionAbsoluteTtlSeconds: 60 } });
  t.after(() => h.close());
  const session = await signIn(h.app);
  h.clock.advance(120);
  const response = await h.app.inject({ method: 'GET', url: '/api/owner/session', headers: { cookie: session.cookie } });
  assert.equal(response.statusCode, 401);
});

test('F01-AC4: a state-changing request with no CSRF token is refused and changes nothing', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie },
    payload: { projectId: PROJECT_ID, content: profileContent() },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(parse<ErrorPayload>(response).error.code, 'Forbidden');

  const listed = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}/versions`,
    headers: { cookie: session.cookie },
  });
  assert.equal(parse<ProfileListPayload>(listed).profiles.length, 0, 'the refused save must not have stored a version');
});

test('F01-AC4: a state-changing request with the derived token succeeds', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const saved = await seedProfile(h, session);
  assert.equal(saved.profile.versionNumber, 1);
  assert.equal(saved.profile.projectId, PROJECT_ID);
  assert.equal(saved.profile.content.references.repository, REPOSITORY);
  assert.equal(saved.profile.supersedesVersionId, null);
});

test('F01-AC4: a tampered or whitespace-mutated CSRF token is refused', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const mutations: { readonly name: string; readonly token: string }[] = [
    { name: 'a different token', token: 'A'.repeat(43) },
    { name: 'one character changed', token: `${session.csrfToken.slice(0, -1)}${session.csrfToken.endsWith('A') ? 'B' : 'A'}` },
    { name: 'a trailing newline', token: `${session.csrfToken}\n` },
    { name: 'a leading space', token: ` ${session.csrfToken}` },
    { name: 'double submitted', token: `${session.csrfToken},${session.csrfToken}` },
  ];
  for (const mutation of mutations) {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: { cookie: session.cookie, 'x-shiploop-csrf': mutation.token },
      payload: { projectId: PROJECT_ID, content: profileContent() },
    });
    assert.equal(response.statusCode, 403, `${mutation.name} must be refused`);
    assert.ok(!response.body.includes('versionNumber'), `${mutation.name} must not have saved a profile`);
  }
  const safe = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}`,
    headers: { cookie: session.cookie },
  });
  assert.equal(safe.statusCode, 404, 'no version may exist after only refused saves');
});

test('F01-AC4: a CSRF token issued for one session does not work for another', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const first = await signIn(h.app);
  const second = await signIn(h.app);
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: first.cookie, 'x-shiploop-csrf': second.csrfToken },
    payload: { projectId: PROJECT_ID, content: profileContent() },
  });
  assert.equal(response.statusCode, 403);
});

test('N02-AC1: a wrong password and an unknown owner are answered identically', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const wrongPassword = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: { identifier: OWNER_NAME, password: 'not the password at all' },
  });
  const unknownOwner = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: { identifier: 'nobody-with-this-name', password: 'not the password at all' },
  });
  assert.equal(wrongPassword.statusCode, 401);
  assert.equal(unknownOwner.statusCode, 401);
  assert.equal(wrongPassword.headers['set-cookie'], undefined, 'a failed sign-in must not set a cookie');
  assert.equal(unknownOwner.headers['set-cookie'], undefined);
  assert.equal(wrongPassword.body, unknownOwner.body);
  assert.equal(parse<ErrorPayload>(unknownOwner).signInRequired, true);
});

test('F01-AC1: private responses carry the security headers and no wildcard CORS', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  await seedProfile(h, session);
  const response = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}`,
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['access-control-allow-origin'] === '*', false);
});

test('F01-AC1: a private response is never cacheable', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  await seedProfile(h, session);
  const read = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}`,
    headers: { cookie: session.cookie },
  });
  assert.equal(read.headers['cache-control'], 'no-store');

  const refused = await h.app.inject({ method: 'GET', url: `/api/profiles/${PROJECT_ID}` });
  assert.equal(refused.statusCode, 401);
  assert.equal(refused.headers['cache-control'], 'no-store', 'even a refusal must not be cached');

  const refusedSignIn = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: { identifier: OWNER_NAME, password: 'not the password at all' },
  });
  assert.equal(refusedSignIn.headers['cache-control'], 'no-store');
});

test('F02-AC3: saving appends a version and history keeps both', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const first = await seedProfile(h, session);
  const second = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { projectId: PROJECT_ID, content: profileContent({ recipe: 'pnpm install && pnpm verify' }) },
  });
  assert.equal(second.statusCode, 201);
  const secondBody = parse<ProfilePayload>(second);
  assert.equal(secondBody.profile.versionNumber, 2);
  assert.equal(secondBody.profile.supersedesVersionId, first.profile.profileVersionId);

  const history = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}/versions`,
    headers: { cookie: session.cookie },
  });
  assert.equal(history.statusCode, 200);
  const versions = parse<ProfileListPayload>(history).profiles;
  assert.deepEqual(versions.map((version) => version.versionNumber), [1, 2]);
  assert.notEqual(versions[0]?.contentFingerprint, versions[1]?.contentFingerprint);

  const current = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}`,
    headers: { cookie: session.cookie },
  });
  assert.equal(parse<ProfilePayload>(current).profile.content.recipe, 'pnpm install && pnpm verify');
});

test('F02-AC4: a save with missing or blank fields names every offending field', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: {
      projectId: PROJECT_ID,
      content: {
        references: {
          repository: '   ',
          ticketProvider: '',
          ticketTeamKey: null,
          baseBranch: '',
          targetBranch: '',
          deploymentProvider: '',
          engine: '',
          previewComponents: [],
        },
        policy: {
          requiredChecks: [],
          deliveryBehavior: 'Automatic',
          maxFixPasses: -1,
          workspaceIsolation: 'SharedDirectory',
          capabilityVersion: 0,
        },
        recipe: '',
        environment: { runtime: '', ports: [], secretReferences: [] },
      },
    },
  });
  assert.equal(response.statusCode, 400);
  const payload = parse<ErrorPayload>(response);
  assert.equal(payload.error.code, 'Invalid');
  const fields = payload.error.fields ?? [];
  const paths = fields.map((field) => field.path);
  for (const expected of [
    'content.references.repository',
    'content.references.ticketProvider',
    'content.references.baseBranch',
    'content.references.targetBranch',
    'content.references.deploymentProvider',
    'content.references.engine',
    'content.references.previewComponents',
    'content.policy.requiredChecks',
    'content.policy.deliveryBehavior',
    'content.policy.maxFixPasses',
    'content.policy.workspaceIsolation',
    'content.policy.capabilityVersion',
    'content.recipe',
    'content.environment.runtime',
  ]) {
    assert.ok(paths.includes(expected), `${expected} must be reported, got ${JSON.stringify(paths)}`);
  }
  assert.equal(new Set(paths).size, paths.length, 'each field must be reported once');
  for (const field of fields) {
    assert.ok(field.message.length > 0, `${field.path} must carry a message a form can show`);
  }
});

test('F02-AC4: an unknown key in a save is refused rather than ignored', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { projectId: PROJECT_ID, content: { ...profileContent(), installationDirectory: '/etc' } },
  });
  assert.equal(response.statusCode, 400);
  assert.ok(parse<ErrorPayload>(response).error.fields?.some((field) => field.path === 'content.installationDirectory'));
});

test('F03-AC3: a secret cannot be submitted to a connector and never appears in a response', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const rejected = await h.app.inject({
    method: 'POST',
    url: `/api/profiles/${PROJECT_ID}/connectors`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: {
      provider: 'linear',
      kind: 'Ticket',
      resourceScope: `${TEAM_KEY} team`,
      credentialReference: CREDENTIAL_REFERENCE,
      secret: SEEDED_SECRET,
    },
  });
  assert.equal(rejected.statusCode, 400, 'a secret must not be accepted through this route');
  assert.ok(!rejected.body.includes(SEEDED_SECRET));

  const registered = await seedConnector(h, session);
  assert.equal(registered.connector.credentialReference, CREDENTIAL_REFERENCE);
  assert.notEqual(registered.connector.credentialReferenceDigest, CREDENTIAL_REFERENCE);

  const listed = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}/connectors`,
    headers: { cookie: session.cookie },
  });
  assert.equal(listed.statusCode, 200);
  const connectors = parse<ConnectorListPayload>(listed).connectors;
  const serialized = JSON.stringify(connectors);
  assert.ok(!serialized.includes(SEEDED_SECRET), 'no response may carry a secret value');
  for (const forbiddenKey of ['"secret"', '"token"', '"apiKey"', '"password"']) {
    assert.ok(!serialized.includes(forbiddenKey), `${forbiddenKey} must not be part of a connector response`);
  }
});

test('F03-AC2: a connector reports status, last check, capabilities and an actionable error', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const registered = await seedConnector(h, session);
  assert.equal(registered.connector.state, 'Healthy');
  assert.equal(registered.connector.lastCheckedAt, START);
  const reads: readonly CapabilityKind[] = registered.connector.reads;
  assert.deepEqual(reads, ['Ticket:ReadScope', 'Ticket:PublishIssue']);
  assert.deepEqual(registered.connector.writes, []);
  assert.deepEqual(registered.connector.unsupported, [
    { kind: 'Git:MergeWithPrecondition', limitation: 'Linear cannot merge code.' },
  ]);

  const revoked = await h.app.inject({
    method: 'POST',
    url: `/api/connectors/${registered.connector.connectorId}/revoke`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { reason: 'the credential expired at the provider' },
  });
  assert.equal(revoked.statusCode, 200);
  const revokedBody = parse<ConnectorPayload>(revoked);
  assert.equal(revokedBody.connector.state, 'Revoked');
  assert.match(String(revokedBody.connector.error), /revoked/i);
  assert.match(String(revokedBody.connector.error), /Register a working credential/i);

  const listed = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}/connectors`,
    headers: { cookie: session.cookie },
  });
  const connectors = parse<ConnectorListPayload>(listed).connectors;
  assert.equal(connectors.length, 1);
  assert.equal(connectors[0]?.state, 'Revoked');
  assert.ok((connectors[0]?.error ?? '').length > 0);
  assert.equal(connectors[0]?.lastCheckedAt, START);
});

test('F03-AC4, F04-AC3: a revoked connector blocks the next profile save with the named prerequisite', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const connector = await seedConnector(h, session);
  const revoked = await h.app.inject({
    method: 'POST',
    url: `/api/connectors/${connector.connector.connectorId}/revoke`,
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { reason: 'revoked for the test' },
  });
  assert.equal(revoked.statusCode, 200);

  const blocked = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { projectId: PROJECT_ID, content: profileContent() },
  });
  assert.equal(blocked.statusCode, 422, 'a blocked operation must not be reported as started');
  assert.notEqual(blocked.statusCode, 200);
  assert.notEqual(blocked.statusCode, 201);
  const payload = parse<ErrorPayload>(blocked);
  assert.equal(payload.error.code, 'Blocked');
  const prerequisite = payload.error.prerequisites?.[0];
  assert.ok(prerequisite !== undefined, 'the failed prerequisite must be named');
  assert.equal(prerequisite.name, 'connector.Ticket.credential');
  assert.ok(prerequisite.detail.includes('linear'));
  assert.ok(prerequisite.remedy.length > 0, 'the owner must be told what to do');
});

test('F02-AC2, F24-AC4: a stale profile save is a conflict carrying the current facts', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  await seedProfile(h, session);
  const stale = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { projectId: PROJECT_ID, content: profileContent(), expectedVersionNumber: 7 },
  });
  assert.equal(stale.statusCode, 409);
  const payload = parse<ErrorPayload>(stale);
  assert.equal(payload.error.code, 'Conflict');
  assert.equal(payload.error.expected, '7');
  assert.equal(payload.error.actual, '1');

  const history = await h.app.inject({
    method: 'GET',
    url: `/api/profiles/${PROJECT_ID}/versions`,
    headers: { cookie: session.cookie },
  });
  assert.equal(parse<ProfileListPayload>(history).profiles.length, 1, 'a refused save must not append a version');
});

test('F04-AC3: an unknown external write is a 202 with its operation id and never a success status', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  h.controller.script(
    'saveProfile',
    outcomeUnknown('The provider did not confirm the write.', 'op_2f9c', 'linear/octopus-main'),
  );
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
    payload: { projectId: PROJECT_ID, content: profileContent() },
  });
  assert.equal(response.statusCode, 202);
  assert.notEqual(response.statusCode, 200);
  assert.notEqual(response.statusCode, 201);
  const payload = parse<ErrorPayload>(response);
  assert.equal(payload.error.code, 'OutcomeUnknown');
  assert.equal(payload.error.operationId, 'op_2f9c');
  assert.equal(payload.error.target, 'linear/octopus-main');
});

test('N02-AC1: every domain error maps to its own honest status', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const session = await signIn(h.app);
  const cases: { readonly name: string; readonly useCase: string; readonly error: DomainError; readonly status: number; readonly retryAfter?: string }[] = [
    { name: 'invalid', useCase: 'saveProfile', error: { code: 'Invalid', reason: 'A field is wrong.', fields: [{ path: 'content.recipe', message: 'A recipe is required.' }] }, status: 400 },
    { name: 'not found', useCase: 'registerConnector', error: { code: 'NotFound', reason: 'No such project.' }, status: 404 },
    { name: 'forbidden', useCase: 'registerConnector', error: { code: 'Forbidden', reason: 'Not this project.' }, status: 403 },
    { name: 'rate limited', useCase: 'registerConnector', error: { code: 'RateLimited', reason: 'Too many checks.', retryAfterMs: 1500 }, status: 429, retryAfter: '2' },
    { name: 'unavailable', useCase: 'registerConnector', error: { code: 'Unavailable', reason: 'The provider is unreachable.' }, status: 503 },
  ];
  for (const testCase of cases) {
    h.controller.script(testCase.useCase, testCase.error);
    const response = await h.app.inject({
      method: 'POST',
      url: testCase.useCase === 'saveProfile' ? '/api/profiles' : `/api/profiles/${PROJECT_ID}/connectors`,
      headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
      payload:
        testCase.useCase === 'saveProfile'
          ? { projectId: PROJECT_ID, content: profileContent() }
          : { provider: 'linear', kind: 'Ticket', resourceScope: 'OCT', credentialReference: CREDENTIAL_REFERENCE },
    });
    assert.equal(response.statusCode, testCase.status, `${testCase.name} must map to ${testCase.status}`);
    assert.equal(parse<ErrorPayload>(response).error.code, testCase.error.code);
    if (testCase.retryAfter !== undefined) {
      assert.equal(response.headers['retry-after'], testCase.retryAfter);
    }
  }
});

test('F01-AC1: artifacts are served only to a signed-in owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-web-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>ShipLoop</title>');
  await writeFile(join(root, 'evidence.txt'), 'screenshot bytes');

  const h = await harness({ config: { staticRoot: root } });
  t.after(() => h.close());

  const anonymousArtifact = await h.app.inject({ method: 'GET', url: '/artifacts/evidence.txt' });
  assert.equal(anonymousArtifact.statusCode, 401, 'an artifact must not be readable without a session');
  assert.ok(!anonymousArtifact.body.includes('screenshot bytes'));

  const session = await signIn(h.app);
  const ownedArtifact = await h.app.inject({
    method: 'GET',
    url: '/artifacts/evidence.txt',
    headers: { cookie: session.cookie },
  });
  assert.equal(ownedArtifact.statusCode, 404, 'the file is outside the artifact root, so it is not served');

  const shell = await h.app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
  assert.equal(shell.statusCode, 200, 'the sign-in shell is public');
  assert.ok(!shell.body.includes('csrfToken'));
});

test('F01-AC1: an unconfigured artifact store still refuses an anonymous request', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const anonymous = await h.app.inject({ method: 'GET', url: '/artifacts/run-1/evidence.txt' });
  assert.equal(anonymous.statusCode, 401);
  const session = await signIn(h.app);
  const authenticated = await h.app.inject({
    method: 'GET',
    url: '/artifacts/run-1/evidence.txt',
    headers: { cookie: session.cookie },
  });
  assert.equal(authenticated.statusCode, 404);
  assert.equal(parse<ErrorPayload>(authenticated).error.code, 'NotFound');
});

test('F01-AC1, F03-AC3: provisioning an owner refuses a password below the domain minimum', async (t) => {
  const h = await harness({ provisionOwner: false });
  t.after(() => h.close());
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/owner/provision',
    payload: { displayName: OWNER_NAME, password: 'short' },
  });
  assert.equal(response.statusCode, 400);
  const fields = parse<ErrorPayload>(response).error.fields ?? [];
  assert.deepEqual(fields.map((field) => field.path), ['password']);
  assert.match(String(fields[0]?.message), new RegExp(String(MINIMUM_PASSWORD_LENGTH)));
  assert.ok(!response.body.includes('short'));

  const created = await h.app.inject({
    method: 'POST',
    url: '/api/owner/provision',
    payload: { displayName: OWNER_NAME, password: OWNER_PASSWORD },
  });
  assert.equal(created.statusCode, 201);
  const session = await signIn(h.app);
  assert.ok(session.cookie.length > 0);
});

test('the loaded controller module is validated before it can serve a request', () => {
  assert.equal(isControllerSurface(null), false);
  assert.equal(isControllerSurface({ owners: {} }), false);
  assert.equal(
    isControllerSurface({ owners: { provision() {}, signIn() {} }, sessions: { loadByToken() {} } }),
    false,
  );
  const complete = {
    owners: { provision() {}, signIn() {} },
    sessions: { loadByToken() {}, create() {}, revoke() {}, touch() {} },
    profiles: { saveVersion() {}, currentVersion() {}, listVersions() {} },
    connectors: { register() {}, listForProject() {}, revoke() {} },
  };
  assert.equal(isControllerSurface(complete), true);
});
test('F01-AC1: a request over the body limit is refused with its own status', async (t) => {
  const h = await harness({ config: { bodyLimitBytes: 1024 } });
  t.after(() => h.close());
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: { identifier: OWNER_NAME, password: 'x'.repeat(4096) },
  });
  assert.equal(response.statusCode, 413);
  const payload = parse<ErrorPayload>(response);
  assert.equal(payload.error.code, 'PayloadTooLarge');
  assert.ok(!response.body.includes('xxxx'), 'the refusal must not echo the body');
});

test('F01-AC1: a state-changing request to an unknown path is refused, not reported as missing', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const anonymous = await h.app.inject({ method: 'POST', url: '/api/there-is-no-such-route' });
  assert.equal(anonymous.statusCode, 401);

  const session = await signIn(h.app);
  const withoutToken = await h.app.inject({
    method: 'POST',
    url: '/api/there-is-no-such-route',
    headers: { cookie: session.cookie },
  });
  assert.equal(withoutToken.statusCode, 403, 'a signed-in caller without a token is told the token is the problem');
  assert.equal(parse<ErrorPayload>(withoutToken).signInRequired, undefined);

  const withToken = await h.app.inject({
    method: 'POST',
    url: '/api/there-is-no-such-route',
    headers: { cookie: session.cookie, 'x-shiploop-csrf': session.csrfToken },
  });
  assert.equal(withToken.statusCode, 404);
  assert.equal(parse<ErrorPayload>(withToken).error.code, 'NotFound');
});

test('F03-AC2: a body the server cannot read is refused with a nameable field and no echo', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const notAnObject = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: [OWNER_NAME],
  });
  assert.equal(notAnObject.statusCode, 400);
  const fields = parse<ErrorPayload>(notAnObject).error.fields ?? [];
  assert.deepEqual(fields.map((field) => field.path), ['body']);

  const wrongMediaType = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: `identifier=${OWNER_NAME}&password=${OWNER_PASSWORD}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(wrongMediaType.statusCode, 415);
  assert.equal(parse<ErrorPayload>(wrongMediaType).error.code, 'UnsupportedMediaType');

  const malformed = await h.app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    headers: { 'content-type': 'application/json' },
    payload: `{"identifier": "${SEEDED_SECRET}", `,
  });
  assert.equal(malformed.statusCode, 400);
  assert.ok(!malformed.body.includes(SEEDED_SECRET), 'a parse failure must not echo the submitted body');
  assert.equal(parse<ErrorPayload>(malformed).error.code, 'BadRequest');
});

test('F01-AC4: configuration refuses to start without a usable CSRF secret', () => {
  const missing = readServerConfig({ SHIPLOOP_NODE_ENV: 'production' });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.ok(missing.errors.some((problem) => problem.path === 'SHIPLOOP_CSRF_SECRET'));

  const short = readServerConfig({ SHIPLOOP_CSRF_SECRET: 'too short', SHIPLOOP_NODE_ENV: 'production' });
  assert.equal(short.ok, false);

  const insecureProduction = readServerConfig({
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_NODE_ENV: 'production',
    SHIPLOOP_COOKIE_SECURE: 'false',
  });
  assert.equal(insecureProduction.ok, false, 'a production cookie must not be allowed to be insecure (F01-AC4)');

  const badNumbers = readServerConfig({
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_PORT: 'eighty',
    SHIPLOOP_SESSION_TTL_SECONDS: '-1',
  });
  assert.equal(badNumbers.ok, false);

  const valid = readServerConfig({ SHIPLOOP_CSRF_SECRET: CSRF_SECRET, SHIPLOOP_NODE_ENV: 'production' });
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(valid.value.cookieSecure, true);
  assert.equal(valid.value.cookieSameSite, 'Strict');
  assert.equal(describeConfigErrors([{ path: 'A', message: 'b' }]), 'A: b');
});

test('F01-AC4: a development server may drop Secure deliberately and says so in the configuration', () => {
  const result = readServerConfig({
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_NODE_ENV: 'development',
    SHIPLOOP_COOKIE_SECURE: 'false',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.cookieSecure, false);
});

test('F01-AC1: the health route answers an anonymous caller and discloses nothing', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await h.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200, 'liveness is what the browser harness polls before it drives a flow');
  assert.deepEqual(JSON.parse(response.body), { status: 'ok' });

  // The body is the whole disclosure surface, so the key set is pinned as well as the value: a
  // field added here later is a new unauthenticated disclosure, and this fails when that happens
  // rather than after someone reads a release note.
  assert.deepEqual(Object.keys(JSON.parse(response.body) as object), ['status']);

  // Nothing that would fingerprint the deployment. The version, the clock, the host and the store
  // are all facts a caller with no session must not learn, and each is a plausible thing to add
  // while making a liveness route more useful.
  for (const disclosure of ['version', 'commit', 'uptime', 'hostname', 'host', 'database', 'startedAt', START]) {
    assert.ok(!response.body.includes(disclosure), `the health body must not mention ${disclosure}`);
  }

  // No owner detail, and no cookie: the route is unauthenticated by design, so anything it returned
  // would be returned to anyone who asked.
  assert.ok(!response.body.includes(OWNER_NAME));
  assert.ok(!response.body.includes(OWNER_ID));
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store', 'a cached liveness answer outlives the process that gave it');
});

test('F01-AC1: the health route stays a 200 with a session cookie it did not need', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  // A caller presenting a cookie gets the same answer as one that does not, so the route is not
  // quietly branching on the session and the response is not decorated for a signed-in reader.
  const session = await signIn(h.app);
  const withCookie = await h.app.inject({
    method: 'GET',
    url: '/api/health',
    headers: { cookie: session.cookie },
  });
  assert.equal(withCookie.statusCode, 200);
  assert.equal(withCookie.body, (await h.app.inject({ method: 'GET', url: '/api/health' })).body);
});

test('F01-AC1: SHIPLOOP_PORT 0 is the OS-assigned port, and only the port may be zero', () => {
  // Zero has one defined meaning for the port and it is a useful one: the harness cannot know which
  // port is free, so it asks for any and reads the bound address back. Rejecting it would make the
  // browser suite unable to start a server at all.
  const osChosen = readServerConfig({ SHIPLOOP_CSRF_SECRET: CSRF_SECRET, SHIPLOOP_PORT: '0' });
  assert.equal(osChosen.ok, true, 'port 0 must be accepted');
  if (!osChosen.ok) return;
  assert.equal(osChosen.value.port, 0, 'zero must be passed through, not replaced by the default');

  const explicit = readServerConfig({ SHIPLOOP_CSRF_SECRET: CSRF_SECRET, SHIPLOOP_PORT: '8080' });
  assert.equal(explicit.ok, true);
  if (!explicit.ok) return;
  assert.equal(explicit.value.port, 8080);

  // A negative port is not a request for an arbitrary one, and a non-number is not a number.
  // The upper end of the range is deliberately absent from this list: nothing above 65535 is
  // refused by `readServerConfig` today, so asserting it would be asserting a rule that does not
  // exist. `listen` rejects such a port later, with a Node error rather than a named one.
  for (const bad of ['-1', 'eighty', '80.5', ' ']) {
    const refused = readServerConfig({ SHIPLOOP_CSRF_SECRET: CSRF_SECRET, SHIPLOOP_PORT: bad });
    assert.equal(refused.ok, false, `port ${JSON.stringify(bad)} must be refused`);
  }

  // Zero stays refused everywhere else. It means "unset" for every other integer here, and a
  // session lifetime or a byte limit of zero is a broken setting rather than a request.
  for (const [path, value] of [
    ['SHIPLOOP_SESSION_TTL_SECONDS', '0'],
    ['SHIPLOOP_SESSION_IDLE_SECONDS', '0'],
    ['SHIPLOOP_BODY_LIMIT_BYTES', '0'],
  ] as const) {
    const refused = readServerConfig({ SHIPLOOP_CSRF_SECRET: CSRF_SECRET, [path]: value });
    assert.equal(refused.ok, false, `${path}=0 must be refused`);
    if (refused.ok) continue;
    const problem = refused.errors.find((candidate) => candidate.path === path);
    assert.ok(problem !== undefined, `the refusal must name ${path}`);
    assert.equal(problem.message, 'Expected a positive number.');
  }
});
