/**
 * The authentication gate every private request passes.
 *
 * This is the whole of F01's boundary, so the ordering is deliberate. The session is
 * resolved and authorized first, because the CSRF token is derived from the session
 * identity and a request with no session is refused before anything else is
 * considered (F01-AC1). The CSRF check comes second and applies to every
 * state-changing method, including one this server has never heard of, because the
 * domain's `verifyCsrfToken` fails closed on an unrecognized method (F01-AC4).
 *
 * Authorization runs here rather than inside a use case: revocation is checked on
 * the request path, so once `revokedAt` is set no amount of token correctness
 * restores access, which is what makes sign-out real (F01-AC2).
 */

import {
  SESSION_COOKIE_NAME,
  authorizeSession,
  deriveCsrfToken,
  describeSessionRejection,
  verifyCsrfToken,
  type CsrfRejection,
  type CsrfToken,
} from '@shiploop/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { UnauthorizedError, forbidden } from './http-error.ts';
import type { AuthorizedOwner, SessionUseCases } from './contracts.ts';

/** Header carrying the CSRF token. A header, because the cookie is HttpOnly (F01-AC4). */
export const CSRF_HEADER = 'x-shiploop-csrf';

/** Body field accepted as an alternative to the header, for a plain HTML form post. */
export const CSRF_FIELD = 'csrfToken';

/**
 * The identity a request proved, plus the token it must echo to change state.
 *
 * `csrfToken` is not part of `AuthorizedOwner`: what the request proved and what the
 * client still owes are different things, and a handler that forgot to check the
 * latter would be relying on the guard rather than on its own contract.
 */
export interface AuthenticatedSession extends AuthorizedOwner {
  readonly csrfToken: CsrfToken;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Null until the session guard has authorized this request. */
    session: AuthenticatedSession | null;
  }
}

export interface SessionGuardOptions {
  readonly sessions: SessionUseCases;
  readonly csrfSecret: string;
  readonly now: () => Date;
  /** Must be the limit the session was created under, or idle expiry means something else. */
  readonly idleTimeoutSeconds: number;
}

/** A Fastify `preHandler` that either populates `request.session` or throws. */
export type SessionGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Builds the guard.
 *
 * One guard is shared by every private route rather than re-derived per route, so
 * there is a single place where "who is this request" is decided and no route can
 * accidentally skip a step of it.
 */
export function createSessionGuard(options: SessionGuardOptions): SessionGuard {
  return async (request: FastifyRequest): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (typeof token !== 'string' || token === '') throw new UnauthorizedError();
    const loaded = await options.sessions.loadByToken(token);
    if (!loaded.ok) throw new UnauthorizedError();
    const record = loaded.value;
    const now = options.now().toISOString();
    const authorized = authorizeSession({
      sessionId: record.sessionId,
      token,
      storedDigest: record.tokenDigest,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      revokedAt: record.revokedAt,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutSeconds: options.idleTimeoutSeconds,
      now,
    });
    if (!authorized.ok) throw new UnauthorizedError(describeSessionRejection(authorized.error));
    const sessionId = authorized.value.sessionId;
    const evaluation = verifyCsrfToken({
      sessionId,
      secret: options.csrfSecret,
      submitted: submittedToken(request),
      method: request.method,
    });
    if (!evaluation.valid) {
      throw forbidden(describeCsrfRejection(evaluation.reason));
    }
    request.session = {
      ownerId: record.ownerId,
      displayName: record.displayName,
      sessionId,
      issuedAt: authorized.value.issuedAt,
      expiresAt: authorized.value.expiresAt,
      csrfToken: deriveCsrfToken(sessionId, options.csrfSecret),
    };
    await recordActivity(options.sessions, sessionId, now);
  };
}

/**
 * The token the client presented, from the header or the parsed body.
 *
 * Repeated headers are joined rather than picked, so two tokens cannot be offered
 * side by side and one of them accepted.
 */
function submittedToken(request: FastifyRequest): string {
  const header = request.headers[CSRF_HEADER];
  if (typeof header === 'string') return header;
  if (Array.isArray(header)) return header.join(',');
  const body: unknown = request.body;
  if (typeof body === 'object' && body !== null) {
    const candidate = (body as Record<string, unknown>)[CSRF_FIELD];
    if (typeof candidate === 'string') return candidate;
  }
  return '';
}

/**
 * Owner-facing text for a refused state-changing request.
 *
 * Each reason tells the owner what to do next rather than naming an internal code,
 * because a page that submits without a token almost always means the tab was opened
 * before the session existed (N03-AC3, F01-AC4).
 */
function describeCsrfRejection(reason: CsrfRejection | null): string {
  switch (reason) {
    case 'MissingToken':
      return 'This request was refused because it carried no forgery-protection token. Reload the page and try again.';
    case 'MalformedToken':
      return 'This request was refused because its forgery-protection token was malformed. Reload the page and try again.';
    case 'TokenMismatch':
      return 'This request was refused because its forgery-protection token did not match this session. Reload the page and try again.';
    case null:
      return 'This request was refused because it could not be proven to come from this session.';
  }
}

/**
 * Keeps the idle deadline meaningful by moving activity forward.
 *
 * Best effort on purpose: the stored absolute deadline is what actually closes a
 * session, so a store that refuses to record activity must not lock the owner out
 * of a session that is still inside its window. A store that throws is a real
 * failure and is left to propagate.
 */
async function recordActivity(
  sessions: SessionUseCases,
  sessionId: string,
  lastActivityAt: string,
): Promise<void> {
  await sessions.touch({ sessionId, lastActivityAt });
}