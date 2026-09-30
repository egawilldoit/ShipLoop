/**
 * Typed command results.
 *
 * Every mutating command returns one of these instead of throwing, so the
 * controller can distinguish "the owner must supply information" (Blocked),
 * "your view of the world is out of date" (Conflict), and "we do not know
 * whether the external write happened" (OutcomeUnknown). Those three must never
 * be collapsed into a generic failure, because each needs a different next step.
 */

export type Result<T, E = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

export type DomainErrorCode =
  | 'Blocked'
  | 'Conflict'
  | 'OutcomeUnknown'
  | 'Invalid'
  | 'NotFound'
  | 'Forbidden'
  | 'RateLimited'
  | 'Unavailable';

/**
 * A prerequisite is absent, so the requested action was refused before any work
 * started. Carries the specific failed prerequisite so the owner is told what to fix.
 */
export interface BlockedError {
  readonly code: 'Blocked';
  readonly reason: string;
  readonly prerequisites: readonly BlockedPrerequisite[];
}

export interface BlockedPrerequisite {
  readonly name: string;
  readonly detail: string;
  /** Remediation the owner or operator can actually perform. */
  readonly remedy: string;
}

/** The caller's expected revision or candidate identity no longer matches reality. */
export interface ConflictError {
  readonly code: 'Conflict';
  readonly reason: string;
  readonly expected: string;
  readonly actual: string;
}

/**
 * An external write was issued and its outcome is not known: the response may have
 * been lost. The operation identity is retained so reconciliation can establish
 * the real result without repeating the write.
 */
export interface OutcomeUnknownError {
  readonly code: 'OutcomeUnknown';
  readonly reason: string;
  readonly operationId: string;
  readonly target: string;
}

export interface InvalidError {
  readonly code: 'Invalid';
  readonly reason: string;
  /** Field paths that failed validation, for form-level display. */
  readonly fields: readonly { readonly path: string; readonly message: string }[];
}

export interface NotFoundError {
  readonly code: 'NotFound';
  readonly reason: string;
}

export interface ForbiddenError {
  readonly code: 'Forbidden';
  readonly reason: string;
}

export interface RateLimitedError {
  readonly code: 'RateLimited';
  readonly reason: string;
  readonly retryAfterMs: number | null;
}

export interface UnavailableError {
  readonly code: 'Unavailable';
  readonly reason: string;
}

export type DomainError =
  | BlockedError
  | ConflictError
  | OutcomeUnknownError
  | InvalidError
  | NotFoundError
  | ForbiddenError
  | RateLimitedError
  | UnavailableError;

export function blocked(reason: string, prerequisites: readonly BlockedPrerequisite[] = []): BlockedError {
  return { code: 'Blocked', reason, prerequisites };
}

export function conflict(reason: string, expected: string, actual: string): ConflictError {
  return { code: 'Conflict', reason, expected, actual };
}

export function outcomeUnknown(
  reason: string,
  operationId: string,
  target: string,
): OutcomeUnknownError {
  return { code: 'OutcomeUnknown', reason, operationId, target };
}

export function invalid(
  reason: string,
  fields: readonly { path: string; message: string }[] = [],
): InvalidError {
  return { code: 'Invalid', reason, fields };
}
