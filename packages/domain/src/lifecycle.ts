import type { Result } from './result.ts';
import { err, invalid, ok } from './result.ts';

/**
 * The three independent state dimensions (mvp-spec 3).
 *
 * Keeping them separate is the core product rule: a Completed attempt is not an
 * Accepted candidate, and an Accepted candidate is not Released. A single fused
 * status field would make "the agent finished, so it shipped" expressible, which
 * is exactly the failure mode this product exists to prevent.
 */

export const ATTEMPT_STATES = [
  'Queued',
  'Preparing',
  'Running',
  'Verifying',
  'WaitingForOwner',
  'Paused',
  'Blocked',
  'Completed',
  'Cancelled',
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export const ACCEPTANCE_STATES = [
  'NotRequested',
  'Pending',
  'ChangesRequested',
  'Accepted',
  'Stale',
] as const;
export type AcceptanceState = (typeof ACCEPTANCE_STATES)[number];

export const DELIVERY_STATES = [
  'NotAuthorized',
  'Authorized',
  'Merging',
  'Merged',
  'Releasing',
  'Released',
  'Failed',
  'OutcomeUnknown',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/**
 * Allowed attempt transitions.
 *
 * Cancellation is reachable from every non-terminal state because the owner must
 * always be able to stop work. Resuming a Paused job returns to Running rather
 * than Queued: the workspace and checkpoint already exist, so the job does not
 * need to re-enter the queue (F17-AC3).
 */
const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptState, readonly AttemptState[]>> = {
  Queued: ['Preparing', 'Cancelled', 'Blocked'],
  Preparing: ['Running', 'Blocked', 'Paused', 'Cancelled', 'Queued'],
  Running: ['Verifying', 'WaitingForOwner', 'Paused', 'Blocked', 'Completed', 'Cancelled'],
  Verifying: ['WaitingForOwner', 'Completed', 'Blocked', 'Paused', 'Cancelled'],
  WaitingForOwner: ['Running', 'Verifying', 'Completed', 'Paused', 'Cancelled', 'Blocked'],
  Paused: ['Running', 'Preparing', 'Cancelled', 'Blocked'],
  Blocked: ['Preparing', 'Queued', 'Cancelled'],
  Completed: ['Verifying', 'WaitingForOwner'],
  Cancelled: [],
};

/**
 * Acceptance transitions. Only an owner decision moves acceptance, and only
 * staleness or a further owner decision can move it afterwards. There is no
 * engine, adapter or webhook path into Accepted (F25-AC4).
 */
const ACCEPTANCE_TRANSITIONS: Readonly<Record<AcceptanceState, readonly AcceptanceState[]>> = {
  NotRequested: ['Pending', 'Stale'],
  Pending: ['Accepted', 'ChangesRequested', 'Stale'],
  ChangesRequested: ['Pending', 'Stale'],
  Accepted: ['Stale'],
  Stale: ['Pending', 'ChangesRequested'],
};

const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
  NotAuthorized: ['Authorized'],
  Authorized: ['Merging', 'NotAuthorized', 'Failed'],
  Merging: ['Merged', 'Failed', 'OutcomeUnknown'],
  Merged: ['Releasing', 'Failed', 'OutcomeUnknown'],
  Releasing: ['Released', 'Failed', 'OutcomeUnknown'],
  Released: [],
  Failed: ['Authorized', 'NotAuthorized', 'Releasing'],
  /**
   * Reconciliation is the only way out. Moving straight to Released would be the
   * blind repetition the specification forbids (F28-AC4, F30-AC5).
   */
  OutcomeUnknown: ['Merged', 'Releasing', 'Released', 'Failed', 'Authorized'],
};

export type TransitionDimension = 'attempt' | 'acceptance' | 'delivery';

function tableFor(dimension: TransitionDimension): Readonly<Record<string, readonly string[]>> {
  switch (dimension) {
    case 'attempt':
      return ATTEMPT_TRANSITIONS;
    case 'acceptance':
      return ACCEPTANCE_TRANSITIONS;
    case 'delivery':
      return DELIVERY_TRANSITIONS;
  }
}

export function canTransition(
  dimension: TransitionDimension,
  from: string,
  to: string,
): boolean {
  return tableFor(dimension)[from]?.includes(to) ?? false;
}

/**
 * Validates a transition and returns a typed rejection instead of throwing.
 *
 * A rejected transition carries the illegal request in `fields` so the API layer
 * can render it, and names the dimension so a caller cannot confuse "you may not
 * cancel a completed job" with a permission failure.
 */
export function assertTransition(
  dimension: TransitionDimension,
  from: string,
  to: string,
): Result<{ readonly from: string; readonly to: string }> {
  if (from === to) {
    return ok({ from, to });
  }
  const allowed = tableFor(dimension)[from];
  if (allowed === undefined) {
    return err(invalid(`Unknown ${dimension} state: ${from}`, [
      { path: dimension, message: `Not a valid ${dimension} state.` },
    ]));
  }
  if (!allowed.includes(to)) {
    return err(
      invalid(`Illegal ${dimension} transition ${from} -> ${to}`, [
        {
          path: dimension,
          message:
            allowed.length === 0
              ? `${from} is terminal; ${to} is not reachable.`
              : `From ${from} the reachable states are: ${allowed.join(', ')}.`,
        },
      ]),
    );
  }
  return ok({ from, to });
}

/** States in which an attempt is consuming execution capacity. */
export function isActiveAttempt(state: AttemptState): boolean {
  return state === 'Preparing' || state === 'Running' || state === 'Verifying';
}

/** States in which the worker must still keep a lease alive. */
export function needsHeartbeat(state: AttemptState): boolean {
  return isActiveAttempt(state);
}
