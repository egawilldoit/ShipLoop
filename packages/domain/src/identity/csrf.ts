/**
 * Cross-site request forgery protection (F01-AC4).
 *
 * A cookie is attached by the browser to any request the owner's browser makes,
 * including one initiated by another site, so a state-changing request must carry
 * proof that it was intended. The proof is derived from the session identity with
 * a server-side secret: deterministic, so nothing has to be stored per session,
 * and unforgeable without the secret, so a cross-site page that cannot read the
 * cookie cannot compute a token for it.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

declare const csrfBrand: unique symbol;

/** A derived CSRF token, in the exact form a client may echo back. */
export type CsrfToken = string & { readonly [csrfBrand]: 'CsrfToken' };

/** Methods that cannot change state and therefore need no token. */
export const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS', 'TRACE'] as const;

export type SafeMethod = (typeof SAFE_METHODS)[number];

/**
 * Cookie name. Kept here so the browser-facing half of the session and the policy
 * half cannot drift apart.
 */
export const SESSION_COOKIE_NAME = 'shiploop_session';

/** The cookie is sent for the whole origin, because sign-in and sign-out share one route. */
const SESSION_COOKIE_DEFAULT_PATH = '/';

const TOKEN_DOMAIN = 'shiploop:csrf:v1:';
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;

export type CsrfRejection = 'MissingToken' | 'MalformedToken' | 'TokenMismatch';

export interface CsrfEvaluation {
  readonly valid: boolean;
  readonly reason: CsrfRejection | null;
}

export interface CsrfVerification {
  readonly sessionId: string;
  readonly secret: string;
  readonly submitted: string;
  readonly method: string;
}

/**
 * Derives the token for a session.
 *
 * Deterministic by design: the server validates a submitted token by re-deriving
 * it, so there is no per-session token table to store, rotate or lose, and a
 * token stops verifying the moment the session identity or the server secret
 * changes.
 */
export function deriveCsrfToken(sessionId: string, secret: string): CsrfToken {
  return createHmac('sha256', secret)
    .update(`${TOKEN_DOMAIN}${sessionId}`)
    .digest('base64url') as CsrfToken;
}

/**
 * Decides whether a request may proceed.
 *
 * Every state-changing method needs a valid token, including one this code has
 * never heard of: an unrecognized method falls through to the state-changing
 * branch rather than being assumed safe. A safe method needs no token, but if one
 * is supplied it must still be correct, so a stale token cannot be laundered
 * through a GET into a later state-changing request.
 */
export function verifyCsrfToken(input: CsrfVerification): CsrfEvaluation {
  const expected = deriveCsrfToken(input.sessionId, input.secret);
  const safe = isSafeMethod(input.method);
  if (input.submitted === '') {
    return safe ? { valid: true, reason: null } : { valid: false, reason: 'MissingToken' };
  }
  const canonical = canonicalizeSubmittedToken(input.submitted);
  if (tokenMatches(expected, canonical)) return { valid: true, reason: null };
  return { valid: false, reason: canonical === null ? 'MalformedToken' : 'TokenMismatch' };
}

/**
 * Canonical form of a submitted token, or null when the submission is not in it.
 *
 * Trimming would be the wrong normalization here. A value that reaches the
 * server as `token\n` or ` token` has been through a header concatenation or a
 * sloppy copy, and accepting it would make the exact token the owner holds
 * irrelevant; requiring the precise base64url alphabet and length means a
 * whitespace-mutated token is rejected instead of quietly accepted.
 */
function canonicalizeSubmittedToken(submitted: string): string | null {
  return BASE64URL_SHA256.test(submitted) ? submitted : null;
}

/** Fails closed: anything that is not exactly a known safe method is state-changing. */
function isSafeMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return (SAFE_METHODS as readonly string[]).includes(normalized);
}

function tokenMatches(expected: string, candidate: string | null): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const candidateBytes = Buffer.from(candidate ?? '', 'utf8');
  if (candidateBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(candidateBytes, expectedBytes);
}

/**
 * `SameSite=None` is unrepresentable in the option type because it would remove
 * the cross-site protection this module exists to provide.
 */
export type SessionCookieSameSite = 'Strict' | 'Lax';

export interface SessionCookieOptions {
  /** Whether the transport is confidential. Defaults to true; development over plain HTTP turns it off. */
  readonly secure?: boolean;
  readonly sameSite?: SessionCookieSameSite;
  readonly path?: string;
  readonly maxAgeSeconds: number;
}

/**
 * Cookie attributes as a typed value plus a serialized header.
 *
 * `httpOnly` is typed as the literal `true`, so dropping it is a type error
 * rather than a missed argument, and the attribute string is built from the flags
 * in one place so it cannot disagree with them. The cookie therefore stays
 * unavailable to client-side scripts even if an injected script runs on the page
 * (F01-AC4, N02-AC1).
 */
export interface SessionCookieAttributes {
  readonly name: typeof SESSION_COOKIE_NAME;
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: SessionCookieSameSite;
  readonly path: string;
  readonly maxAgeSeconds: number;
  /** The `Set-Cookie` attribute portion, with no name or value. */
  readonly attributes: string;
}

/**
 * Builds the attributes for the session cookie.
 *
 * Throws for a non-positive lifetime or an unusable path rather than substituting
 * a default: a `Max-Age=0` slipped in by mistake would sign the owner out, and
 * silently widening a lifetime would weaken every other rule here.
 */
export function sessionCookieAttributes(options: SessionCookieOptions): SessionCookieAttributes {
  const maxAgeSeconds = Math.floor(options.maxAgeSeconds);
  if (!Number.isFinite(options.maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new RangeError('Session cookie lifetime must be a positive number of seconds');
  }
  const path = options.path ?? '/';
  if (path.length === 0 || /[;\s]/.test(path)) {
    throw new RangeError('Session cookie path must be a non-empty value without separators');
  }
  const secure = options.secure ?? true;
  const sameSite = options.sameSite ?? 'Strict';
  const attributes = [`Path=${path}`, `Max-Age=${maxAgeSeconds}`, 'HttpOnly'];
  if (secure) attributes.push('Secure');
  attributes.push(`SameSite=${sameSite}`);
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    secure,
    sameSite,
    path,
    maxAgeSeconds,
    attributes: attributes.join('; '),
  };
}

/**
 * The attributes used to end a session (F01-AC2).
 *
 * The flags are identical to the ones that created the cookie, otherwise the
 * browser would keep the original cookie alongside the expired one, and the
 * sign-out would not hold.
 */
export function clearedSessionCookieAttributes(): SessionCookieAttributes {
  const attributes = [`Path=${SESSION_COOKIE_DEFAULT_PATH}`, 'Max-Age=0', 'HttpOnly', 'Secure', 'SameSite=Strict'];
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: SESSION_COOKIE_DEFAULT_PATH,
    maxAgeSeconds: 0,
    attributes: attributes.join('; '),
  };
}
