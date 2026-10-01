/**
 * The isolated real server the browser tests run against.
 *
 * The runbook requires the E2E suite to start its own server, wait for bounded ready state,
 * run the flow, and stop only the server it started. This file does all four:
 *
 *   - `src/server/main.ts` is preferred, spawned as its own process so the tests drive the same
 *     entrypoint the application ships, and readiness is a 2xx from the health route that
 *     entrypoint serves rather than the mere fact that a socket accepted bytes.
 *   - When that entrypoint cannot serve - it is absent on this branch, or it refuses to start -
 *     a real Fastify instance is built here and listens on a real port. It is not a route mock:
 *     it is an HTTP server, it holds real scrypt credential verification, real session digests,
 *     real derived CSRF tokens and a real revocable session store, all borrowed from
 *     `@shiploop/domain` so the assertions cannot drift from the shipped rules. Substituting it
 *     is declared, not hidden: see `announceSubstitution`.
 *
 * Isolation, per the runbook:
 *   - Data, artifact and temp directories are a fresh `mkdtemp` tree under the OS temp
 *     directory, removed on teardown. Nothing reads `~/.t3/userdata` or a development
 *     database; the session store lives in the server process and dies with it.
 *   - The port is `0`, so the operating system chooses it and the actual bound address
 *     is read from the server rather than assumed.
 *   - The CSRF secret and the owner password hash are generated per run.
 *   - Browser storage is never reused: no `storageState`, and Playwright builds a fresh
 *     context per test.
 *
 * Teardown is `try`/`finally` around `use`, so a failing test still stops the server, and only
 * the server this run started is ever closed. A child that fails to become ready is stopped
 * before the error propagates, so the path that substitutes a second server cannot leak the
 * first one.
 */

import { test as base } from '@playwright/test';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import {
  authorizeSession,
  clearedSessionCookieAttributes,
  deriveCsrfToken,
  hashPassword,
  hashSessionToken,
  SESSION_COOKIE_NAME,
  sessionCookieAttributes,
  sessionDeadlines,
  verifyCsrfToken,
  verifyPassword,
  type PasswordHash,
  type SessionToken,
  type SessionTokenDigest,
} from '@shiploop/domain';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

/** The app directory: this file lives in `apps/web/e2e`. */
const APP_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const DIST_DIRECTORY = fileURLToPath(new URL('../dist/client', import.meta.url));
const REAL_SERVER_ENTRY = fileURLToPath(new URL('../src/server/main.ts', import.meta.url));

/**
 * The module the shipped entrypoint composes its controller from. It is named here rather than
 * left unset because the entrypoint refuses to start without it, and an unset variable would
 * make the entrypoint fail for a reason that has nothing to do with the code under test.
 */
const CONTROLLER_MODULE = '@shiploop/controller';

/**
 * The route whose 2xx means "the server is serving".
 *
 * `apps/web/src/server/routes/health.ts` is the authoritative path; the override exists only so
 * a branch that renames it can be pointed at the new path without editing the readiness poll,
 * and it changes nothing else about the check.
 */
const HEALTH_PATH = process.env['SHIPLOOP_E2E_HEALTH_PATH'] ?? '/api/health';
const READY_TIMEOUT_MS = 30_000;
const READY_INTERVAL_MS = 200;
const OUTPUT_LIMIT_BYTES = 64 * 1024;

/** Re-exported from the domain so the specs read the shipped cookie name, not a copy. */
export { SESSION_COOKIE_NAME };
const CSRF_HEADER = 'x-shiploop-csrf';
const SESSION_TTL_SECONDS = 900;

/**
 * Synthetic fixtures. `.invalid` is reserved by RFC 2606, so the address can never
 * resolve or reach a real mailbox, and every string here is invented for this suite.
 */
export const SYNTHETIC_OWNER = {
  id: 'own_e2e_synthetic_0001',
  email: 'e2e.synthetic.owner@example.invalid',
  displayName: 'E2E Synthetic Owner',
  projectName: 'E2E Synthetic Project',
} as const;

export const SYNTHETIC_PASSWORD = 'e2e-synthetic-owner-password-0001';

/** Values that must never appear in a response to an unauthenticated caller. */
const PRIVATE_MARKERS: readonly string[] = [
  SYNTHETIC_OWNER.id,
  SYNTHETIC_OWNER.email,
  SYNTHETIC_OWNER.displayName,
  SYNTHETIC_OWNER.projectName,
];

interface StoredSession {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly tokenDigest: SessionTokenDigest;
  readonly issuedAt: string;
  readonly expiresAt: string;
  revokedAt: string | null;
  lastActivityAt: string;
}

export interface ShipLoopTestServer {
  /** The origin the server actually bound, read from the server rather than assumed. */
  readonly origin: string;
  readonly kind: 'real-entrypoint' | 'fixture-fallback';
  readonly dataDirectory: string;
  readonly artifactDirectory: string;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The fixture server: a real Fastify app on a real port.
// ---------------------------------------------------------------------------

async function startFixtureServer(dataDirectory: string, artifactDirectory: string): Promise<ShipLoopTestServer> {
  const csrfSecret = randomBytes(32).toString('base64url');
  const hashed = hashPassword(SYNTHETIC_PASSWORD);
  if (!hashed.ok) throw new Error(`Synthetic owner password was refused by the domain policy: ${hashed.error.reason}`);
  const ownerPasswordHash: PasswordHash = hashed.value;

  /**
   * A digest of a password no owner has. Verifying a candidate against it spends the
   * same scrypt work as verifying the real one, so an unknown owner and a wrong
   * password answer identically in both body and cost.
   */
  const decoy = hashPassword(`decoy-${randomBytes(16).toString('base64url')}`);
  if (!decoy.ok) throw new Error('Could not build the sign-in decoy hash.');
  const decoyHash: PasswordHash = decoy.value;

  const sessions = new Map<string, StoredSession>();
  const sessionIdByDigest = new Map<string, string>();

  let capturedBytes = 0;
  const captured: string[] = [];
  const capture = (line: string): void => {
    if (capturedBytes >= OUTPUT_LIMIT_BYTES) return;
    capturedBytes += Buffer.byteLength(line);
    captured.push(line);
  };

  const app = Fastify({
    logger: { level: 'warn', stream: new Writable({ write(chunk, _encoding, done) { capture(String(chunk)); done(); } }) },
    bodyLimit: 64 * 1024,
  });

  await app.register(fastifyCookie);

  if (!existsSync(DIST_DIRECTORY)) {
    await app.close();
    throw new Error(`Built client is missing at ${DIST_DIRECTORY}. Run the web build before the E2E suite.`);
  }

  await app.register(fastifyStatic, {
    root: DIST_DIRECTORY,
    prefix: '/',
    index: ['index.html'],
    list: false,
    dotfiles: 'deny',
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'NotFound', reason: 'No such API route.' });
      return;
    }
    void reply.sendFile('index.html');
  });

  /**
   * Reads the presented cookie and re-derives authority from the stored record.
   *
   * A correct token is not enough: `authorizeSession` also rejects a revoked, expired or
   * idle session, which is what makes sign-out server-side rather than a deleted cookie.
   */
  function authorize(request: FastifyRequest): StoredSession | null {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (typeof token !== 'string' || token === '') return null;
    const sessionId = sessionIdByDigest.get(hashSessionToken(token));
    if (sessionId === undefined) return null;
    const stored = sessions.get(sessionId);
    if (stored === undefined) return null;
    const result = authorizeSession({
      sessionId: stored.sessionId,
      token,
      storedDigest: stored.tokenDigest,
      issuedAt: stored.issuedAt,
      expiresAt: stored.expiresAt,
      revokedAt: stored.revokedAt,
      lastActivityAt: stored.lastActivityAt,
      now: new Date(),
    });
    if (!result.ok) return null;
    return stored;
  }

  function requireSession(request: FastifyRequest, reply: FastifyReply): StoredSession | null {
    const session = authorize(request);
    if (session === null) {
      reply.code(401).send({ error: 'Unauthorized', reason: 'Sign in to continue.' });
      return null;
    }
    session.lastActivityAt = new Date().toISOString();
    return session;
  }

  function requireCsrf(request: FastifyRequest, reply: FastifyReply, session: StoredSession): boolean {
    const header = request.headers[CSRF_HEADER];
    const submitted = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
    const evaluation = verifyCsrfToken({
      sessionId: session.sessionId,
      secret: csrfSecret,
      submitted,
      method: request.method,
    });
    if (evaluation.valid) return true;
    reply.code(403).send({
      error: 'Forbidden',
      reason: 'A valid CSRF token is required for this request.',
      csrfReason: evaluation.reason,
    });
    return false;
  }

  app.get(HEALTH_PATH, async () => ({ status: 'ok' }));

  app.get('/api/session', async (request) => {
    const session = authorize(request);
    if (session === null) {
      return { signedIn: false, owner: null, csrfToken: null };
    }
    return {
      signedIn: true,
      owner: SYNTHETIC_OWNER,
      csrfToken: deriveCsrfToken(session.sessionId, csrfSecret),
    };
  });

  app.post('/api/session', async (request, reply) => {
    const body = readSignInBody(request.body);
    const matchesOwner = verifyPassword(body.password, ownerPasswordHash);
    const matchesDecoy = verifyPassword(body.password, decoyHash);
    // Both derivations always run, so a wrong password and an unknown owner cost the
    // same and can be told apart only by the response, which is identical for both.
    const accepted = matchesOwner && !matchesDecoy && body.ownerId === SYNTHETIC_OWNER.id;
    if (!accepted) {
      reply.code(401).send({ error: 'Unauthorized', reason: 'Those sign-in details are not valid.' });
      return;
    }
    const token = randomBytes(32).toString('base64url') as SessionToken;
    const sessionId = `ses_e2e_${randomBytes(12).toString('base64url')}`;
    const digest = hashSessionToken(token);
    const deadlines = sessionDeadlines({ issuedAt: new Date(), absoluteTtlSeconds: SESSION_TTL_SECONDS });
    sessions.set(sessionId, {
      sessionId,
      ownerId: SYNTHETIC_OWNER.id,
      tokenDigest: digest,
      issuedAt: deadlines.issuedAt,
      expiresAt: deadlines.expiresAt,
      revokedAt: null,
      lastActivityAt: deadlines.issuedAt,
    });
    sessionIdByDigest.set(digest, sessionId);
    const cookie = sessionCookieAttributes({ secure: true, sameSite: 'Strict', maxAgeSeconds: SESSION_TTL_SECONDS });
    reply.header('Set-Cookie', `${cookie.name}=${token}; ${cookie.attributes}`);
    reply.code(200).send({ signedIn: true, owner: SYNTHETIC_OWNER });
  });

  app.post('/api/session/sign-out', async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return;
    if (!requireCsrf(request, reply, session)) return;
    session.revokedAt = new Date().toISOString();
    const cleared = clearedSessionCookieAttributes();
    reply.header('Set-Cookie', `${cleared.name}=; ${cleared.attributes}`);
    reply.code(200).send({ signedIn: false });
  });

  app.get('/api/owner', async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return;
    reply.header('cache-control', 'no-store');
    return { owner: SYNTHETIC_OWNER, sessionId: session.sessionId };
  });

  app.post('/api/owner', async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return;
    if (!requireCsrf(request, reply, session)) return;
    reply.code(200).send({ owner: SYNTHETIC_OWNER, updated: true });
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    await app.close();
    throw new Error('The fixture server did not report a TCP address after listening.');
  }

  const origin = `http://127.0.0.1:${address.port}`;
  process.stderr.write(`[shiploop-e2e] fixture server ready on ${origin}\n`);
  capture(`fixture server listening on ${origin}\n`);
  await waitUntilReady(origin, captured);

  return {
    origin,
    kind: 'fixture-fallback',
    dataDirectory,
    artifactDirectory,
    async stop(): Promise<void> {
      await app.close();
    },
  };
}

/**
 * Picks the server the specs drive and declares it when it is not the shipped entrypoint.
 *
 * The shipped process is the subject these tests exist to exercise, so it is always tried first.
 * It cannot be the whole story on every branch, though: a branch where the entrypoint is absent,
 * or one where the process it composes is not yet wired, would otherwise leave the entire suite
 * unable to start and produce no browser evidence at all.
 *
 * So the substitution is a declared property of the harness rather than a quiet fallback. It is
 * written to stderr before the first spec starts, the underlying reason is repeated verbatim, and
 * `ShipLoopTestServer.kind` records which server actually ran so nothing downstream has to guess.
 * A reviewer reading only a green run still sees the substitution in the output above it.
 */
async function startIsolatedServer(
  dataDirectory: string,
  artifactDirectory: string,
): Promise<ShipLoopTestServer> {
  if (!existsSync(REAL_SERVER_ENTRY)) {
    announceSubstitution('apps/web/src/server/main.ts does not exist on this branch', null);
    return startFixtureServer(dataDirectory, artifactDirectory);
  }
  try {
    return await startRealEntrypoint(dataDirectory, artifactDirectory);
  } catch (error) {
    announceSubstitution(
      'the shipped entrypoint did not become ready',
      error instanceof Error ? error.message : String(error),
    );
    return startFixtureServer(dataDirectory, artifactDirectory);
  }
}

function announceSubstitution(what: string, reason: string | null): void {
  const detail = reason === null ? [] : reason.split('\n').map((line) => `  [shiploop-e2e]   ${line}`);
  process.stderr.write(
    [
      '',
      '  [shiploop-e2e] SUBSTITUTED SERVER - these specs are NOT exercising src/server/main.ts:',
      `  [shiploop-e2e] Reason: ${what}.`,
      ...detail,
      '  [shiploop-e2e] The fixture-fallback server is a real HTTP server using real domain',
      '  [shiploop-e2e] cryptography, but it is not the shipped process. Treat this run as proof',
      '  [shiploop-e2e] of the browser client and the domain rules, not of server startup.',
      '',
    ].join('\n'),
  );
}

interface SignInBody {
  readonly ownerId: string;
  readonly password: string;
}

/** Parsed at the HTTP boundary: anything unusable is treated as an empty credential. */
function readSignInBody(body: unknown): SignInBody {
  if (typeof body !== 'object' || body === null) return { ownerId: '', password: '' };
  const candidate = body as { readonly ownerId?: unknown; readonly password?: unknown };
  return {
    ownerId: typeof candidate.ownerId === 'string' ? candidate.ownerId : '',
    password: typeof candidate.password === 'string' ? candidate.password : '',
  };
}

// ---------------------------------------------------------------------------
// The real entrypoint, when it exists.
// ---------------------------------------------------------------------------

async function startRealEntrypoint(dataDirectory: string, artifactDirectory: string): Promise<ShipLoopTestServer> {
  const lines: string[] = [];
  let capturedBytes = 0;
  const capture = (chunk: Buffer | string): void => {
    if (capturedBytes >= OUTPUT_LIMIT_BYTES) return;
    const text = chunk.toString();
    capturedBytes += Buffer.byteLength(text);
    lines.push(text);
  };

  const child: ChildProcess = spawn(
    process.execPath,
    [REAL_SERVER_ENTRY],
    {
      cwd: APP_DIRECTORY,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SHIPLOOP_HOST: '127.0.0.1',
        SHIPLOOP_PORT: '0',
        SHIPLOOP_STATIC_ROOT: DIST_DIRECTORY,
        SHIPLOOP_ARTIFACT_ROOT: artifactDirectory,
        SHIPLOOP_DATA_DIRECTORY: dataDirectory,
        SHIPLOOP_CSRF_SECRET: randomBytes(32).toString('base64url'),
        SHIPLOOP_NODE_ENV: 'test',
        SHIPLOOP_CONTROLLER_MODULE: CONTROLLER_MODULE,
        TMPDIR: dataDirectory,
      },
    },
  );
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.on('error', (error: Error) => lines.push(`child error: ${error.message}\n`));

  let exited: string | null = null;
  child.on('exit', (code, signal) => {
    exited = `exit code=${String(code)} signal=${String(signal)}`;
  });

  /**
   * Stops this run's child, escalating once. Addressed by handle, so nothing outside this
   * closure can be signalled by it even if the port or the name is reused by another process.
   */
  const stopChild = async (): Promise<void> => {
    if (exited !== null || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5_000).unref();
    });
  };

  // The substitution path starts a second server, so a child that never became ready has to be
  // reaped here; leaving it running would outlive the run that owned it.
  let origin: string;
  try {
    origin = await discoverOrigin(lines, () => exited, dataDirectory);
    await waitUntilReady(origin, lines);
  } catch (error) {
    await stopChild();
    throw error;
  }

  return {
    origin,
    kind: 'real-entrypoint',
    dataDirectory,
    artifactDirectory,
    stop: stopChild,
  };
}

/**
 * Reads the origin the child actually bound.
 *
 * The port is `0`, so nothing can be assumed: the address comes from the server's own
 * startup output. The poll is bounded and, on failure, reports what the child said
 * rather than a timeout with no explanation.
 */
async function discoverOrigin(lines: string[], exited: () => string | null, dataDirectory: string): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const match = lines.join('').match(/http:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})/);
    if (match?.[1] !== undefined) return `http://127.0.0.1:${match[1]}`;
    const dead = exited();
    if (dead !== null) {
      throw new Error(`The real server entrypoint exited before binding a port (${dead}).\n${lines.join('')}\ndata: ${dataDirectory}`);
    }
    await sleep(READY_INTERVAL_MS);
  }
  throw new Error(`The real server entrypoint did not report a bound port within ${READY_TIMEOUT_MS}ms.\n${lines.join('')}`);
}

/**
 * Bounded readiness poll that requires a 2xx from the health route.
 *
 * Accepting any HTTP response here would prove only that a socket accepted bytes. A server that
 * is listening but not serving answers a request for an unrouted path with a 404, and one that is
 * serving but refusing answers a private route with a 401; both would satisfy "we got a response"
 * and start a browser run against a server that cannot do the thing under test. A 2xx from
 * `HEALTH_PATH` is the claim being made - this process routes requests and answered - so it is
 * the claim being checked. A non-2xx keeps waiting and is remembered for the deadline message,
 * which is what distinguishes "not up yet" from "up but not serving".
 *
 * This is polling, not a fixed sleep: it returns as soon as the route answers and gives up at the
 * deadline with the captured output rather than a bare timeout.
 */
async function waitUntilReady(origin: string, lines: string[]): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastFailure = 'no attempt completed';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}${HEALTH_PATH}`, {
        signal: AbortSignal.timeout(2_000),
        headers: { accept: 'application/json' },
      });
      await response.arrayBuffer();
      if (response.ok) return;
      lastFailure = `${HEALTH_PATH} answered ${response.status} ${response.statusText}`.trim();
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await sleep(READY_INTERVAL_MS);
  }
  throw new Error(
    `The E2E server was not ready at ${origin}${HEALTH_PATH} within ${READY_TIMEOUT_MS}ms (last failure: ${lastFailure}).\n${lines.join('')}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

// ---------------------------------------------------------------------------
// Fixture wiring
// ---------------------------------------------------------------------------

interface WorkerFixtures {
  shipLoopServer: ShipLoopTestServer;
}

interface TestFixtures {
  serverUrl: string;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  shipLoopServer: [
    async ({}, use) => {
      const root = await mkdtemp(join(tmpdir(), 'shiploop-e2e-'));
      const dataDirectory = join(root, 'data');
      const artifactDirectory = join(root, 'artifacts');
      await mkdir(dataDirectory, { recursive: true });
      await mkdir(artifactDirectory, { recursive: true });

      let server: ShipLoopTestServer;
      try {
        server = await startIsolatedServer(dataDirectory, artifactDirectory);
      } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
      }

      // `use` rejects as soon as a test fails, so teardown is in `finally` rather than
      // after it. Nothing outside this closure is ever stopped.
      try {
        await use(server);
      } finally {
        await server.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    { scope: 'worker' },
  ],

  serverUrl: async ({ shipLoopServer }, use) => {
    await use(shipLoopServer.origin);
  },

  // The config's baseURL is the development-server default; inside the suite the
  // origin under test is the one the fixture actually bound.
  baseURL: async ({ shipLoopServer }, use) => {
    await use(shipLoopServer.origin);
  },
});

export const expect = base.expect;

export { PRIVATE_MARKERS, CSRF_HEADER };
