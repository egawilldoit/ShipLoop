/**
 * The HTTP root: one Fastify instance with the authentication boundary attached.
 *
 * `buildApp` takes its configuration and its controller surface as arguments, so the
 * server can be exercised end to end with `app.inject()` against real fixtures and no
 * listener, port or process. `main.ts` is the only place that opens a socket.
 *
 * Three rules are set once here rather than per route:
 *
 *   - Every response carries the security headers, so a new route cannot ship without
 *     them and nothing has to remember `nosniff` (F01-AC1).
 *   - Every response the owner can read privately is `no-store`, because a cached
 *     profile or connector listing would outlive the session that authorized it
 *     (F01-AC1).
 *   - Nothing is served from a public prefix except the owner shell and its client
 *     code. Artifacts live under `/artifacts/` and are always behind the session
 *     guard, because an artifact is private run detail (F01-AC1).
 *   - `/api/health` is the one unauthenticated API route, and it says only that the
 *     server is up. A harness cannot use a private route to tell "ready" from "refused",
 *     so the answer has to be a route whose 2xx is the signal, and it has to answer an
 *     anonymous caller without disclosing anything (F01-AC1).
 */

import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { SESSION_COOKIE_NAME } from '@shiploop/domain';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createSessionGuard, type SessionGuard } from './auth-guard.ts';
import type { ServerConfig } from './config.ts';
import {
  UnauthorizedError,
  frameworkProblem,
  internalErrorProblem,
  isDomainError,
  notFound,
  problemFor,
  sendProblem,
  signInRequiredProblem,
} from './http-error.ts';
import type { ControllerSurface } from './contracts.ts';
import { registerAttentionRoutes } from './routes/attention.ts';
import { registerCandidateRoutes } from './routes/candidates.ts';
import { registerConnectorRoutes } from './routes/connectors.ts';
import { registerContractRoutes } from './routes/contracts.ts';
import { registerHandoffRoutes } from './routes/handoff.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerIntakeRoutes } from './routes/intake.ts';
import { registerOwnerRoutes } from './routes/owner.ts';
import { registerOwnerTestRoutes } from './routes/owner-tests.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerPlanningRoutes } from './routes/planning.ts';
import { registerProfileRoutes } from './routes/profiles.ts';
import { registerRunRoutes } from './routes/runs.ts';
import { registerSettingsRoutes } from './routes/settings.ts';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
].join('; ');

/** Public: the owner shell and the client code the browser needs to render it. */
const PUBLIC_PREFIX = '/';

/** Private by definition: run artifacts are private data (F01-AC1). */
const ARTIFACT_PREFIX = '/artifacts/';

const API_PREFIX = '/api/';

const SHELL_FILE = 'index.html';

export interface AppDependencies {
  readonly config: ServerConfig;
  readonly controller: ControllerSurface;
  readonly now: () => Date;
}

/**
 * Builds the configured instance.
 *
 * Returns once the plugin and route tree is ready, so tests drive a complete request
 * through the same hooks, guards and error handling the browser will hit.
 */
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { config, controller, now } = deps;
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
  });

  await app.register(fastifyCookie);
  app.decorateRequest('session', null);
  app.addHook('onSend', securityHeaders(config));

  const guard = createSessionGuard({
    sessions: controller.sessions,
    csrfSecret: config.csrfSecret,
    now,
    idleTimeoutSeconds: config.sessionIdleTimeoutSeconds,
  });

  app.setErrorHandler((error, request, reply) => sendFailure(reply, error, request));
  app.setNotFoundHandler((request, reply) => sendNotFound(reply, request, guard, config));

  registerHealthRoutes(app);
  registerOwnerRoutes(app, { config, controller, guard, now });
  registerProjectRoutes(app, { controller, guard, now });
  // Registered after the project routes because these are nested under `/api/projects`:
  // the project identity is part of every path here, so a request cannot be addressed without
  // one (mvp-spec 3, F02-AC2).
  registerContractRoutes(app, { controller, guard, now });
  registerCandidateRoutes(app, { controller, guard, now });
  registerHandoffRoutes(app, { controller, guard });
  registerProfileRoutes(app, { controller, guard, now });
  registerConnectorRoutes(app, { controller, guard, now });
  registerIntakeRoutes(app, { controller, guard, now });
  registerRunRoutes(app, { controller, guard, now });
  registerAttentionRoutes(app, { controller, guard, now });
  registerPlanningRoutes(app, { controller, guard, now });
  registerOwnerTestRoutes(app, { controller, guard });
  // Last of the project-scoped group, and for the same reason as the rest: the project
  // identity is part of the path, so settings cannot be addressed without one (mvp-spec 3).
  registerSettingsRoutes(app, { controller, guard, now });

  const staticRoot = config.staticRoot;
  if (staticRoot !== null) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: PUBLIC_PREFIX,
      index: [SHELL_FILE],
      list: false,
      dotfiles: 'deny',
    });
  }

  const artifactRoot = config.artifactRoot;
  if (artifactRoot === null) {
    app.get(`${ARTIFACT_PREFIX}*`, { preHandler: guard }, async (_request, reply) =>
      sendProblem(reply, problemFor(notFound('No artifact store is configured.'))),
    );
  } else {
    await app.register(async (scope) => {
      scope.addHook('preHandler', guard);
      await scope.register(fastifyStatic, {
        root: artifactRoot,
        prefix: ARTIFACT_PREFIX,
        index: false,
        list: false,
        dotfiles: 'deny',
      });
    });
  }

  await app.ready();
  return app;
}

/**
 * Headers every response carries.
 *
 * `nosniff` and `no-referrer` stop a response being reinterpreted or leaked to another
 * origin, the content security policy and `X-Frame-Options` forbid framing so a private
 * page cannot be clickjacked into an owner action (F01-AC1), and `no-store` keeps
 * authenticated data out of a shared cache. `Access-Control-Allow-Origin` is
 * deliberately never set: this API is same-origin only, and a wildcard would let any
 * page read it.
 */
function securityHeaders(config: ServerConfig) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
    if (config.cookieSecure) {
      reply.header('strict-transport-security', 'max-age=31536000');
    }
    if (isPrivateRequest(request)) {
      reply.header('cache-control', 'no-store');
    }
  };
}

/**
 * Whether a response holds owner-private data.
 *
 * Every API route is private, as is anything answering a request that carried the
 * session cookie: a shell response to a signed-in browser is still a per-owner
 * response, and an API response must not be cached even when it is refused.
 */
function isPrivateRequest(request: FastifyRequest): boolean {
  const carriesSession = request.cookies[SESSION_COOKIE_NAME] !== undefined;
  return (
    request.url.startsWith(API_PREFIX) ||
    request.url.startsWith(ARTIFACT_PREFIX) ||
    carriesSession
  );
}

/**
 * Renders a thrown value.
 *
 * Only errors this layer recognises keep their detail. A refusal is mapped through the
 * domain codes so a prerequisite stays a 422 and an unknown external write stays a 202;
 * anything else is an internal failure whose message is replaced rather than echoed,
 * because a driver error or stack trace is not the owner's business (N02-AC1).
 */
function sendFailure(reply: FastifyReply, error: unknown, request: FastifyRequest): FastifyReply {
  if (error instanceof UnauthorizedError) return sendProblem(reply, signInRequiredProblem(error.message));
  if (isDomainError(error)) return sendProblem(reply, problemFor(error));
  const status = statusOf(error);
  if (status !== null && status >= 400 && status < 500) {
    request.log.warn({ err: error }, 'request refused before the handler');
    return sendProblem(reply, frameworkProblem(status, clientMessage(error)));
  }
  request.log.error({ err: error }, 'unhandled request failure');
  return sendProblem(reply, internalErrorProblem());
}

/**
 * The response for a path no route matched.
 *
 * An anonymous caller gets the sign-in response whether or not the path exists, and
 * only an authenticated caller is told it does not, so an unknown path cannot be used
 * to discover which private routes exist (F01-AC1). A browser asking for a
 * client-side route gets the owner shell instead, because the shell holds no owner
 * data and a JSON 404 there would strand the app on a deep link.
 */
async function sendNotFound(
  reply: FastifyReply,
  request: FastifyRequest,
  guard: SessionGuard,
  config: ServerConfig,
): Promise<FastifyReply> {
  const shell = config.staticRoot !== null && acceptsHtml(request) && !isPrivateRequest(request);
  if (shell) return reply.type('text/html; charset=utf-8').sendFile(SHELL_FILE);
  try {
    await guard(request, reply);
  } catch (error: unknown) {
    return sendFailure(reply, error, request);
  }
  return sendProblem(reply, problemFor(notFound('No such resource.')));
}

function acceptsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = (error as { readonly statusCode?: unknown }).statusCode;
  return typeof candidate === 'number' ? candidate : null;
}

/**
 * The client-facing text for a framework-level refusal.
 *
 * A framework message is used when it is a short string, because it describes the
 * malformed request itself. An unexpected failure keeps a fixed message rather than
 * leaking an internal detail.
 */
function clientMessage(error: unknown): string {
  const candidate = (error as { readonly message?: unknown }).message;
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 200) {
    return 'The request could not be read.';
  }
  return candidate;
}