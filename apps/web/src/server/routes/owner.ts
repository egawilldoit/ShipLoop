/**
 * Owner authentication routes (F01-AC1, F01-AC2, F01-AC4).
 *
 * Provision, sign-in and the liveness route in `health.ts` are the only unauthenticated
 * routes this server exposes, and none of them returns anything but the identity that
 * was just proven. The session cookie is built from the domain
 * `sessionCookieAttributes`, so the flags cannot
 * drift from the policy `identity/csrf.ts` documents: HttpOnly keeps the cookie away
 * from client-side scripts, Secure keeps it off a plaintext connection, and SameSite
 * keeps it off a cross-site request.
 *
 * Sign-out revokes the session in the controller *and* expires the cookie. Clearing
 * the cookie alone would leave a copied token usable, so the server-side revocation is
 * the part that satisfies F01-AC2 and the cookie is the part that satisfies the
 * browser.
 *
 * Sign-in carries no CSRF token because there is no session to derive one from yet:
 * the proof it sends is the credential itself, and the `SameSite` cookie means a
 * cross-site form post arrives with no session to abuse. Every request after it is
 * token-protected (F01-AC4).
 */

import {
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  clearedSessionCookieAttributes,
  deriveCsrfToken,
  generateSessionToken,
  hashSessionToken,
  sessionCookieAttributes,
  type OwnerId,
  type SessionCookieSameSite,
} from '@shiploop/domain';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  fieldErrorsOf,
  fieldsProblem,
  parseBody,
  problemFor,
  sendProblem,
  signInFailureProblem,
  signInRequiredProblem,
} from '../http-error.ts';
import type { HttpProblem } from '../http-error.ts';
import type { ControllerSurface, OwnerView } from '../contracts.ts';
import type { ServerConfig } from '../config.ts';
import type { SessionGuard } from '../auth-guard.ts';

/**
 * A project identity, validated the way `routes/projects.ts` validates one.
 *
 * The two spellings of this rule are kept identical deliberately: a project id addresses an
 * artifact root, a workspace and a git checkout, so a value carrying `/` or `..` is a
 * traversal rather than a name (F06-AC1). This route exists so a client never holds the
 * answer, so it inherits the rule rather than inventing a looser one.
 */
const selectProjectBody = z.strictObject({
  projectId: z
    .string()
    .trim()
    .min(1, 'A project id is required.')
    .max(128, 'A project id may be at most 128 characters.')
    .refine(
      (value) => !/[/\\]/.test(value) && !value.includes('..'),
      'A project id may not contain a path separator or "..".',
    ),
});

const provisionBody = z.strictObject({
  displayName: z
    .string()
    .trim()
    .min(1, 'A display name is required.')
    .max(120, 'A display name may be at most 120 characters.'),
  password: z
    .string()
    .min(MINIMUM_PASSWORD_LENGTH, `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`)
    .max(MAXIMUM_PASSWORD_LENGTH, `Password must be at most ${MAXIMUM_PASSWORD_LENGTH} characters.`),
});

const signInBody = z.strictObject({
  identifier: z
    .string()
    .trim()
    .min(1, 'An identifier is required.')
    .max(200, 'An identifier may be at most 200 characters.'),
  password: z.string().min(1, 'A password is required.').max(MAXIMUM_PASSWORD_LENGTH, 'That password is too long.'),
});

export interface OwnerRouteOptions {
  readonly config: ServerConfig;
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
  readonly now: () => Date;
}

export function registerOwnerRoutes(app: FastifyInstance, options: OwnerRouteOptions): void {
  app.post('/api/owner/provision', async (request, reply) => {
    const body = parseBody(provisionBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const provisioned = await options.controller.owners.provision({
      displayName: body.value.displayName,
      password: body.value.password,
      at: options.now().toISOString(),
    });
    if (!provisioned.ok) return sendProblem(reply, problemFor(provisioned.error));
    return reply.status(201).send({ owner: provisioned.value });
  });

  app.post('/api/owner/sign-in', async (request, reply) => {
    const body = parseBody(signInBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const issuedAt = options.now().toISOString();
    const token = generateSessionToken();
    const granted = await options.controller.owners.signIn({
      identifier: body.value.identifier,
      password: body.value.password,
      tokenDigest: hashSessionToken(token),
      issuedAt,
      absoluteTtlSeconds: options.config.sessionAbsoluteTtlSeconds,
      idleTimeoutSeconds: options.config.sessionIdleTimeoutSeconds,
    });
    if (!granted.ok) {
      if (granted.error.code === 'Forbidden') return sendProblem(reply, signInFailureProblem());
      return sendProblem(reply, problemFor(granted.error));
    }
    const session = granted.value.session;
    setSessionCookie(reply, options.config, token, session.expiresAt, issuedAt);
    const csrfToken = deriveCsrfToken(session.sessionId, options.config.csrfSecret);
    const described = await describedOwnerOf(options.controller, session.ownerId);
    if (described === null) {
      // The credential was just verified, so a describe that finds nothing is a controller
      // that cannot describe the identity it just proved. Reporting the real failure beats
      // sending a session block with an invented owner in it (F01-AC1).
      return sendProblem(reply, undescribedOwnerProblem());
    }
    return reply.status(200).send(identityOf(session, csrfToken, described));
  });

  app.post('/api/owner/sign-out', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const revoked = await options.controller.sessions.revoke({
      sessionId: session.sessionId,
      revokedAt: options.now().toISOString(),
    });
    if (!revoked.ok) return sendProblem(reply, problemFor(revoked.error));
    clearSessionCookie(reply, options.config);
    return reply.status(204).send();
  });

  app.get('/api/owner/session', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    // This is the response the client reads to learn *which project it is acting in*. It
    // must be the same on a first load and on every reload afterwards, which is why the
    // selection is durable on the server rather than held by the client: a client-held
    // selection is lost on reload, and the project-scoped request that follows then addresses
    // the previous project, or none (F02-AC1, F02-AC4).
    const described = await describedOwnerOf(options.controller, session.ownerId);
    if (described === null) {
      return sendProblem(reply, undescribedOwnerProblem());
    }
    return reply.status(200).send(identityOf(session, session.csrfToken, described));
  });

  /**
   * Chooses the project every subsequent project-scoped call addresses (F02-AC1).
   *
   * `PUT` rather than `POST` because the resource is the session's current project and
   * re-selecting one is idempotent: a stale tab resubmitting the same choice lands on the
   * same answer rather than creating a second one. A `projectId` this deployment does not
   * hold is the controller's 404, forwarded unchanged, so "no such project" stays a claim
   * about existence rather than becoming "that project has no saved profile yet" (F02-AC4).
   *
   * Null is not accepted. "No project selected" is reached by never selecting one - it is the
   * onboarding state the session response already reports - so a client asking to select
   * nothing is expressing something the write has no meaning for, and is refused rather than
   * quietly clearing the selection the owner made.
   */
  app.put('/api/owner/active-project', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const body = parseBody(selectProjectBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    const selected = await options.controller.owners.selectActiveProject({
      ownerId: session.ownerId,
      projectId: body.value.projectId,
      at: options.now().toISOString(),
    });
    if (!selected.ok) return sendProblem(reply, problemFor(selected.error));
    return reply.status(200).send({ activeProject: selected.value });
  });
}

/**
 * The identity fields a granted session and an authorized request both carry.
 *
 * A named type rather than an inline shape so the sign-in path and the session path
 * cannot drift apart in what they claim to know about a session.
 */
interface SessionIdentity {
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly sessionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/**
 * What the owner is told about the session in force.
 *
 * The CSRF token is derived rather than stored, so a page that reloads can read it
 * back from this response without a second sign-in. The browser cannot reach it any
 * other way, because the cookie it belongs to is `HttpOnly` (F01-AC4).
 *
 * `activeProject` travels here rather than being fetched separately, and that is the fix for
 * the historical defect rather than a convenience: the session response used to carry no
 * project identity at all, so the client reached for one it did not have and every
 * project-scoped request went out for a project literally named `undefined`. The server's
 * honest 404 was then reported as "that project has no saved profile yet", which is a
 * different and wrong claim (F02-AC1, F02-AC4).
 *
 * The client's only remaining job is to read `activeProjectId` when `state` is `Selected`.
 * There is no derivation left for it to get wrong, and no value to fall back on when the
 * owner has not chosen yet.
 */
function identityOf(session: SessionIdentity, csrfToken: string, described: OwnerView): {
  readonly owner: OwnerView;
  readonly session: { readonly sessionId: string; readonly issuedAt: string; readonly expiresAt: string };
  readonly csrfToken: string;
} {
  return {
    owner: described,
    session: { sessionId: session.sessionId, issuedAt: session.issuedAt, expiresAt: session.expiresAt },
    csrfToken,
  };
}

/**
 * The owner's stored identity, including which project this session addresses.
 *
 * A refusal is reported as an empty owner rather than swallowed: the session path either has
 * a proved owner or it has nothing to describe, and returning `null` here would leave the
 * caller with an owner block it has to invent. The controller is the sole authority for the
 * address and the project - this layer re-derives neither (F01-AC1, F02-AC1).
 */
async function describedOwnerOf(controller: ControllerSurface, ownerId: OwnerId): Promise<OwnerView | null> {
  const described = await controller.owners.describe({ ownerId });
  if (!described.ok) return null;
  return described.value;
}

/**
 * The session response when the owner cannot be described.
 *
 * 503 rather than a session block with a blank owner in it. A credential was just verified,
 * so the identity exists and something in the read failed; answering with a partial identity
 * would have the client cache a session that names nobody and address nothing, which is the
 * same defect this response set out to close (F01-AC1, F02-AC1).
 */
function undescribedOwnerProblem(): HttpProblem {
  // Built through the shared mapper rather than hand-written, so the status and code are the
  // ones every other `Unavailable` in this server already produces and the error-to-status
  // test cannot pass while this one disagrees (N02-AC1).
  return problemFor({
    code: 'Unavailable',
    reason: 'The signed-in owner could not be described, so no session identity is returned (F01-AC1).',
  });
}

/**
 * Writes the session cookie.
 *
 * Every flag comes from the domain helper rather than from a literal here, so the
 * cookie this server sets is the cookie `csrf.ts` says is safe (F01-AC4). `Max-Age`
 * follows the stored session deadline, so the browser can never hold a cookie for a
 * session the server would already refuse.
 */
function setSessionCookie(
  reply: FastifyReply,
  config: ServerConfig,
  token: string,
  expiresAt: string,
  now: string,
): void {
  const attributes = sessionCookieAttributes({
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    path: config.cookiePath,
    maxAgeSeconds: secondsUntil(expiresAt, now),
  });
  reply.setCookie(attributes.name, token, {
    path: attributes.path,
    httpOnly: attributes.httpOnly,
    secure: attributes.secure,
    sameSite: toWireSameSite(attributes.sameSite),
    maxAge: attributes.maxAgeSeconds,
  });
}

/**
 * Expires the session cookie with the flags it was created with (F01-AC2).
 *
 * The browser removes a cookie by name and path alone, so `Path`, `Secure` and
 * `SameSite` are taken from the configuration that set it: a different path here
 * would leave the original cookie in the jar and make the sign-out look effective
 * while the token is still there. `HttpOnly` and `Max-Age=0` come from the domain's
 * cleared attributes, because clearing without `HttpOnly` would leave a script-readable
 * cookie behind and a non-zero lifetime would not clear anything.
 */
function clearSessionCookie(reply: FastifyReply, config: ServerConfig): void {
  const attributes = clearedSessionCookieAttributes();
  reply.clearCookie(attributes.name, {
    path: config.cookiePath,
    httpOnly: attributes.httpOnly,
    secure: config.cookieSecure,
    sameSite: toWireSameSite(attributes.sameSite),
    maxAge: 0,
  });
}

/**
 * The cookie library's spelling of the domain's `sameSite` policy.
 *
 * The domain types the policy as `Strict` | `Lax` and the plugin wants the lowercase
 * wire form. Translating in one function is what keeps a hand-written literal from
 * deciding how much cross-site protection the session cookie actually gets, and it is
 * why `SameSite=None` cannot appear here even though the plugin would accept it.
 */
function toWireSameSite(sameSite: SessionCookieSameSite): 'strict' | 'lax' {
  return sameSite === 'Lax' ? 'lax' : 'strict';
}

/** Whole seconds from `now` to `expiresAt`, never zero or negative. */
function secondsUntil(expiresAt: string, now: string): number {
  const remainingMs = Date.parse(expiresAt) - Date.parse(now);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 1;
  return Math.ceil(remainingMs / 1000);
}