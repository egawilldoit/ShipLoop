import { err, ok } from '../result.ts';
import type { DomainError, Result } from '../result.ts';
import type { OwnerId } from '../ids.ts';

/**
 * Who is acting on an owner decision or an owner test (mvp-spec F25-AC4).
 *
 * The reason this is a discriminated union rather than an interface with a nullable
 * `ownerId` is that the nullable shape makes the forbidden case *representable*: an
 * agent actor with `ownerId: null` type-checks everywhere and only fails at runtime if a
 * caller remembers to check. Here the non-owner variants have no `ownerId` member at
 * all, so `decision.owner` cannot be filled from an agent, a webhook or an engine
 * completion event, and there is nothing left for a caller to forget.
 */

/** An authenticated owner. The only actor that may accept or report an owner test. */
export interface MvpOwnerActor {
  readonly role: 'owner';
  readonly ownerId: OwnerId;
}

/** Everyone else. Deliberately carries no owner identity to borrow. */
export interface MvpNonOwnerActor {
  readonly role: 'agent' | 'automation' | 'system';
}

export type MvpActor = MvpOwnerActor | MvpNonOwnerActor;

/**
 * Narrows an actor to an owner, or refuses.
 *
 * The refusal names the role rather than hiding it, so an agent that tried is told the
 * boundary exists instead of being handed an empty result it could mistake for a bug.
 */
export function requireMvpOwner(actor: MvpActor, action: string): Result<MvpOwnerActor, DomainError> {
  if (actor.role !== 'owner') {
    return err({
      code: 'Forbidden',
      reason: `${action} is an owner action; the ${actor.role} role may not take it, and no owner identity is carried by that role (F25-AC4).`,
    });
  }
  if (actor.ownerId === '') {
    return err({
      code: 'Forbidden',
      reason: `${action} requires an authenticated owner identity, and this actor carries none (F25-AC4).`,
    });
  }
  return ok(actor);
}