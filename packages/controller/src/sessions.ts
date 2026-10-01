/**
 * The session use cases (F01-AC1, F01-AC2, N02-AC1).
 *
 * Sessions exist so a privileged request can be attributed to an owner, and the
 * stored row is the only evidence of that. This module is the whole of it: it
 * opens a session, resolves a presented token to its row, moves the activity
 * clock, and revokes. It applies no policy of its own — the lifetime rules come
 * from the domain's `sessionDeadlines` and the token digest from the domain's
 * `hashSessionToken` — so a session means the same thing here, in storage and in
 * the request guard that authorizes it.
 *
 * Three decisions are load-bearing and are the reason this is not a thin wrapper
 * over the repository:
 *
 *   - `open` is given the caller's absolute TTL and idle timeout and applies
 *     them, rather than falling back to the domain defaults. The stored deadline
 *     then states the limits the row was created under, so a later authorization
 *     needs nothing but the record itself.
 *   - `loadByToken` refuses to hand out a row with no activity instant. A null
 *     there is not an absent limit: it is a row this controller cannot judge, and
 *     returning it would leave a configured idle timeout sitting in the
 *     configuration doing nothing, which is how an unexercised limit always fails
 *     (F01-AC2).
 *   - the plaintext token never crosses this boundary. The caller mints it and
 *     digests it with the domain function, because the web layer is the only
 *     holder of the plaintext and the only component that may put it on the wire
 *     (F01-AC4). A digest is not reversible, so the repository is asked to store
 *     this caller's digest rather than to re-derive one from a token it is never
 *     given. Both write paths land in the same column with the same function, so
 *     there is still only one digest format.
 */

import { err, invalid, ok, sessionDeadlines } from '@shiploop/domain';
import type { DomainError, OwnerId, Result } from '@shiploop/domain';
import type { OwnerRepository, OwnerSession } from '@shiploop/storage';
import type { ControllerClock } from './profiles.ts';

/**
 * A stored session, as an authorization path needs to see it.
 *
 * `tokenDigest` is the domain digest and `lastActivityAt` is the idle deadline's
 * origin, so a caller can hand both straight to `authorizeSession` without
 * knowing how the row is stored.
 */
export interface StoredSessionRecord {
  readonly sessionId: string;
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastActivityAt: string | null;
}

/** What a caller supplies to open a session. It, and only it, holds the plaintext. */
export interface OpenSessionCommand {
  readonly ownerId: OwnerId;
  readonly displayName: string;
  /** The domain digest of a token this process minted; never the token itself. */
  readonly tokenDigest: string;
  readonly issuedAt: string;
  readonly absoluteTtlSeconds: number;
  readonly idleTimeoutSeconds: number;
}

export interface CloseSessionCommand {
  readonly sessionId: string;
  readonly revokedAt: string;
}

export interface RecordActivityCommand {
  readonly sessionId: string;
  readonly lastActivityAt: string;
}

export interface SessionUseCaseDeps {
  readonly clock: ControllerClock;
  readonly owners: OwnerRepository;
}

export interface SessionUseCases {
  readonly loadByToken: (token: string) => Result<StoredSessionRecord, DomainError>;
  readonly open: (command: OpenSessionCommand) => Result<StoredSessionRecord, DomainError>;
  readonly revoke: (command: CloseSessionCommand) => Result<StoredSessionRecord, DomainError>;
  readonly touch: (command: RecordActivityCommand) => Result<true, DomainError>;
}

/**
 * Builds the session use cases.
 *
 * The clock is injected, so an activity instant recorded in a test replays
 * identically and no use case reads ambient time.
 */
export function createSessionUseCases(deps: SessionUseCaseDeps): SessionUseCases {
  /**
   * Resolves a presented token to its stored row.
   *
   * The lookup is by the domain digest, which storage computes from the presented
   * token with the same function that wrote it; that is the only reason a stored
   * session can be found at all. Liveness is deliberately not judged here: a
   * revoked row is returned, because the caller's `authorizeSession` must be the
   * authority that refuses one, and it can only do that if it is handed
   * `revokedAt` (F01-AC2).
   */
  const loadByToken = (token: string): Result<StoredSessionRecord, DomainError> => {
    if (token === '') return err({ code: 'NotFound', reason: 'No session token was presented.' });
    const found = deps.owners.findSessionByToken(token);
    if (!found.ok) return found;
    if (found.value === null) return err({ code: 'NotFound', reason: 'No session matches that token.' });
    return toRecord(deps, found.value);
  };

  /**
   * Stores a new session under the caller's limits (F01-AC2).
   *
   * The stored expiry is the earlier of the absolute and idle deadlines, and the
   * stored activity instant is the issue instant, so the idle limit starts at
   * sign-in rather than at the first request that happens to arrive.
   */
  const open = (command: OpenSessionCommand): Result<StoredSessionRecord, DomainError> => {
    let deadlines: ReturnType<typeof sessionDeadlines>;
    try {
      deadlines = sessionDeadlines({
        issuedAt: command.issuedAt,
        absoluteTtlSeconds: command.absoluteTtlSeconds,
        idleTimeoutSeconds: command.idleTimeoutSeconds,
      });
    } catch (error) {
      return err(
        invalid('The session limits are not usable.', [
          { path: 'absoluteTtlSeconds', message: error instanceof Error ? error.message : 'Unusable limit.' },
        ]),
      );
    }

    const created = deps.owners.createSessionByDigest({
      ownerId: command.ownerId,
      tokenDigest: command.tokenDigest,
      issuedAt: deadlines.issuedAt,
      expiresAt: deadlines.expiresAt,
    });
    if (!created.ok) return created;
    return toRecord(deps, created.value);
  };

  /**
   * Revokes a session by its stored identity (F01-AC2).
   *
   * Keyed on the session id rather than on a token because the caller resolved
   * the row already, to authorize the very request that asks for this. Revoking
   * twice is idempotent, so a retried sign-out is not an error.
   */
  const revoke = (command: CloseSessionCommand): Result<StoredSessionRecord, DomainError> => {
    const revoked = deps.owners.revokeSessionById(command.sessionId, command.revokedAt);
    if (!revoked.ok) return revoked;
    return toRecord(deps, revoked.value);
  };

  /**
   * Moves the idle deadline forward on an authorized request (F01-AC2).
   *
   * This write is the whole reason a configured idle timeout can fire; without
   * it the stored instant never moves and a quiet session never closes. A session
   * that no longer exists is refused rather than silently ignored, so a caller
   * cannot believe it refreshed something.
   */
  const touch = (command: RecordActivityCommand): Result<true, DomainError> => {
    const touched = deps.owners.touchSession(command.sessionId, command.lastActivityAt);
    if (!touched.ok) return touched;
    return ok(true);
  };

  return { loadByToken, open, revoke, touch };
}

/**
 * Projects a stored row onto the record an authorization path consumes.
 *
 * A row with no activity instant is refused rather than returned with a null:
 * this controller writes that column on every open, rotate and touch, so its
 * absence means the row was written by something that does not honour the idle
 * rule, and answering "no limit" for it would silently disable the limit the
 * owner was configured with (F01-AC2). `Malformed` is the domain's own name for
 * that condition; it is carried in the reason because a `DomainError` code set
 * has no member for a corrupt row.
 */
function toRecord(deps: SessionUseCaseDeps, session: OwnerSession): Result<StoredSessionRecord, DomainError> {
  if (session.lastSeenAt === null) {
    return err({
      code: 'Unavailable',
      reason:
        'Malformed: this session row records no activity, so the configured idle timeout cannot be applied to it (F01-AC2).',
    });
  }
  const owner = deps.owners.current();
  if (!owner.ok) return owner;
  if (owner.value === null || owner.value.ownerId !== session.ownerId) {
    return err({ code: 'NotFound', reason: 'That session has no owner any more.' });
  }
  return ok({
    sessionId: session.sessionId,
    ownerId: session.ownerId,
    displayName: owner.value.displayName,
    tokenDigest: session.tokenHash,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    lastActivityAt: session.lastSeenAt,
  });
}
