/**
 * Session token and lifetime rules (F01-AC1, F01-AC2, N02-AC1).
 *
 * Only a digest of the session token is ever persisted, so a copied database is
 * not a set of live sessions, and the plaintext token leaves the process exactly
 * once, inside the Set-Cookie response. Every privileged request re-derives
 * validity from the stored record, which is what makes revocation authoritative:
 * once `revokedAt` is set, no amount of token correctness restores access
 * (F01-AC2).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { err, ok, type Result } from '../result.ts';

declare const sessionBrand: unique symbol;

/** A bearer token that exists only in transit, never in storage. */
export type SessionToken = string & { readonly [sessionBrand]: 'SessionToken' };

/** The stored form of a session token: a deterministic digest, not a secret. */
export type SessionTokenDigest = string & { readonly [sessionBrand]: 'SessionTokenDigest' };

/** 256 bits of entropy, which is the whole security argument for the token. */
export const SESSION_TOKEN_BYTES = 32;

const TOKEN_DOMAIN = 'shiploop:session:v1:';
const DIGEST_BYTES = 32;
const DIGEST_HEX = /^[0-9a-f]{64}$/;

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** A session may never outlive this long, however active it is. */
export const DEFAULT_ABSOLUTE_SESSION_TTL_SECONDS = 8 * HOUR_MS / SECOND_MS;

/** Inactivity beyond this closes the session regardless of the absolute limit. */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 1 * HOUR_MS / SECOND_MS;

const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** A point in time accepted from storage, from a caller, or from the clock. */
export type Instant = string | number | Date;

export type SessionRejection =
  | 'Revoked'
  | 'InvalidWindow'
  | 'NotYetValid'
  | 'Expired'
  | 'Malformed';

export type SessionAuthorizationRejection = SessionRejection | 'TokenMismatch' | 'IdleExpired';

export interface SessionWindow {
  readonly issuedAt: Instant;
  readonly expiresAt: Instant;
  /** Null until sign-out; a future value means the revocation is not yet in force. */
  readonly revokedAt: Instant | null;
  readonly now: Instant;
}

export interface SessionEvaluation {
  readonly valid: boolean;
  readonly reason: SessionRejection | null;
}

/** The record a privileged request is authorized against. */
export interface SessionAuthorization {
  readonly sessionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

/** Generates an opaque, URL-safe 256-bit bearer token. */
export function generateSessionToken(): SessionToken {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url') as SessionToken;
}

/**
 * Digest of a session token, which is the only form allowed to be stored
 * (F01-AC2). Deterministic so a presented token can be matched against the row
 * without keeping the token itself, and domain-separated so a digest of a session
 * token can never be confused with a digest of any other ShipLoop value.
 */
export function hashSessionToken(token: string): SessionTokenDigest {
  return createHash('sha256').update(TOKEN_DOMAIN).update(token).digest('hex') as SessionTokenDigest;
}

/**
 * Constant-time comparison of a presented token with a stored digest. A digest
 * that is not a well-formed hex SHA-256 compares against a zero digest of the
 * same length, so a corrupt row costs the same work and still answers false.
 */
export function verifySessionToken(token: string, storedDigest: string): boolean {
  const computed = Buffer.from(hashSessionToken(token), 'hex');
  const stored = DIGEST_HEX.test(storedDigest) ? Buffer.from(storedDigest, 'hex') : Buffer.alloc(DIGEST_BYTES);
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}

/**
 * Decides whether a stored session may be used at `now`.
 *
 * Revocation is evaluated first so a revoked session cannot be reported as merely
 * expired: the owner-visible reason must never imply that signing back in is
 * enough. An expiry that is not strictly after issue is a corrupt row rather than
 * a usable window, and a session is not valid before it was issued.
 */
export function evaluateSession(window: SessionWindow): SessionEvaluation {
  const issuedAt = toEpochMs(window.issuedAt);
  const expiresAt = toEpochMs(window.expiresAt);
  const now = toEpochMs(window.now);
  const revokedAt = window.revokedAt === null ? null : toEpochMs(window.revokedAt);
  if (issuedAt === null || expiresAt === null || now === null) return { valid: false, reason: 'Malformed' };
  if (window.revokedAt !== null && revokedAt === null) return { valid: false, reason: 'Malformed' };
  if (revokedAt !== null && revokedAt <= now) return { valid: false, reason: 'Revoked' };
  if (expiresAt <= issuedAt) return { valid: false, reason: 'InvalidWindow' };
  if (now < issuedAt) return { valid: false, reason: 'NotYetValid' };
  if (now >= expiresAt) return { valid: false, reason: 'Expired' };
  return { valid: true, reason: null };
}

/** Owner-facing explanation of a refusal, kept beside the codes it explains. */
export function describeSessionRejection(reason: SessionAuthorizationRejection): string {
  switch (reason) {
    case 'Revoked':
      return 'This session was signed out. Sign in again to continue.';
    case 'TokenMismatch':
      return 'The session token did not match the stored session.';
    case 'IdleExpired':
      return 'This session was closed after a period of inactivity. Sign in again to continue.';
    case 'Expired':
      return 'This session has expired. Sign in again to continue.';
    case 'NotYetValid':
      return 'This session is not usable yet.';
    case 'InvalidWindow':
      return 'This session record is inconsistent and cannot be used.';
    case 'Malformed':
      return 'This session record could not be read.';
  }
}

export interface IdleWindow {
  readonly lastActivityAt: Instant;
  readonly now: Instant;
  readonly idleTimeoutSeconds: number;
}

export interface IdleEvaluation {
  readonly valid: boolean;
  readonly reason: 'IdleExpired' | 'Malformed' | null;
}

/**
 * Closes a session that has gone quiet. Idle expiry is separate from the absolute
 * limit because a stolen token is usually used soon after it is taken, which is
 * the window idle expiry exists to shrink.
 */
export function evaluateIdleWindow(window: IdleWindow): IdleEvaluation {
  const lastActivityAt = toEpochMs(window.lastActivityAt);
  const now = toEpochMs(window.now);
  if (lastActivityAt === null || now === null) return { valid: false, reason: 'Malformed' };
  if (!isPositiveSeconds(window.idleTimeoutSeconds)) return { valid: false, reason: 'Malformed' };
  if (now - lastActivityAt >= window.idleTimeoutSeconds * SECOND_MS) return { valid: false, reason: 'IdleExpired' };
  return { valid: true, reason: null };
}

/**
 * The single gate a privileged request must pass.
 *
 * Token, revocation and lifetime are checked together so there is no ordering in
 * which a correct token bypasses a revocation (F01-AC2). Activity is refreshed by
 * the caller on each authorized request, which is what makes the idle limit
 * meaningful.
 */
export function authorizeSession(input: {
  readonly sessionId: string;
  readonly token: string;
  readonly storedDigest: string;
  readonly issuedAt: Instant;
  readonly expiresAt: Instant;
  readonly revokedAt: Instant | null;
  readonly lastActivityAt: Instant | null;
  readonly idleTimeoutSeconds?: number;
  readonly now: Instant;
}): Result<SessionAuthorization, SessionAuthorizationRejection> {
  const idleTimeoutSeconds = input.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
  const window: SessionWindow = {
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    revokedAt: input.revokedAt,
    now: input.now,
  };
  const evaluated = evaluateSession(window);
  if (!evaluated.valid) return err(evaluated.reason ?? 'Malformed');
  if (input.lastActivityAt !== null) {
    const idle = evaluateIdleWindow({
      lastActivityAt: input.lastActivityAt,
      now: input.now,
      idleTimeoutSeconds,
    });
    if (!idle.valid) return err(idle.reason ?? 'IdleExpired');
  }
  if (!verifySessionToken(input.token, input.storedDigest)) return err('TokenMismatch');
  return ok({
    sessionId: input.sessionId,
    issuedAt: toIso(input.issuedAt),
    expiresAt: toIso(input.expiresAt),
    revokedAt: input.revokedAt === null ? null : toIso(input.revokedAt),
  });
}

/**
 * Absolute and idle deadlines for a new session.
 *
 * Both are persisted at sign-in so a later decision needs only the stored record.
 * The effective expiry is the earlier of the two, which is why idle expiry can
 * only ever shorten a session's life.
 *
 * Throws for an unusable instant or a non-positive TTL. Those are caller bugs
 * rather than attacker input, and substituting a default would hand out either an
 * unbounded session or one that expires immediately.
 */
export function sessionDeadlines(input: {
  readonly issuedAt: Instant;
  readonly absoluteTtlSeconds?: number;
  readonly idleTimeoutSeconds?: number;
}): {
  readonly issuedAt: string;
  readonly absoluteExpiresAt: string;
  readonly idleExpiresAt: string;
  readonly expiresAt: string;
} {
  const issuedAtMs = requireEpochMs(input.issuedAt, 'issuedAt');
  const absoluteTtlSeconds = input.absoluteTtlSeconds ?? DEFAULT_ABSOLUTE_SESSION_TTL_SECONDS;
  const idleTimeoutSeconds = input.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
  if (!isPositiveSeconds(absoluteTtlSeconds)) {
    throw new RangeError('Absolute session TTL must be a positive number of seconds');
  }
  if (!isPositiveSeconds(idleTimeoutSeconds)) {
    throw new RangeError('Idle session timeout must be a positive number of seconds');
  }
  const absoluteExpiresAt = new Date(issuedAtMs + absoluteTtlSeconds * SECOND_MS).toISOString();
  const idleExpiresAt = new Date(issuedAtMs + idleTimeoutSeconds * SECOND_MS).toISOString();
  return {
    issuedAt: new Date(issuedAtMs).toISOString(),
    absoluteExpiresAt,
    idleExpiresAt,
    expiresAt: absoluteExpiresAt < idleExpiresAt ? absoluteExpiresAt : idleExpiresAt,
  };
}

/** The deadline a session's activity is measured from. */
export function lastActivityDeadline(lastActivityAt: Instant, idleTimeoutSeconds = DEFAULT_IDLE_TIMEOUT_SECONDS): string {
  if (!isPositiveSeconds(idleTimeoutSeconds)) {
    throw new RangeError('Idle session timeout must be a positive number of seconds');
  }
  return new Date(requireEpochMs(lastActivityAt, 'lastActivityAt') + idleTimeoutSeconds * SECOND_MS).toISOString();
}

/**
 * Accepts only the single instant format ShipLoop persists. A permissive parser
 * would let a corrupt row resolve to a plausible date instead of being reported
 * as malformed.
 */
function toEpochMs(value: Instant): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function requireEpochMs(value: Instant, field: string): number {
  const ms = toEpochMs(value);
  if (ms === null) throw new RangeError(`${field} is not a usable instant`);
  return ms;
}

function toIso(value: Instant): string {
  return new Date(requireEpochMs(value, 'session instant')).toISOString();
}

function isPositiveSeconds(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
