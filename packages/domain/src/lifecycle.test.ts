/**
 * Regression proof for the three independent state dimensions (mvp-spec 3).
 *
 * The tables, not the prose, are the contract: every exported state must have a
 * transition entry, and no attempt outcome may reach an acceptance or delivery
 * state. Assertions are driven from the exported state arrays so a newly added
 * state cannot land without a test failing.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AttemptState, TransitionDimension } from './lifecycle.ts';
import {
  ACCEPTANCE_STATES,
  assertTransition,
  ATTEMPT_STATES,
  canTransition,
  DELIVERY_STATES,
  isActiveAttempt,
  needsHeartbeat,
} from './lifecycle.ts';
import type { InvalidError, Result } from './result.ts';

const DIMENSION_STATES: Readonly<Record<TransitionDimension, readonly string[]>> = {
  attempt: ATTEMPT_STATES,
  acceptance: ACCEPTANCE_STATES,
  delivery: DELIVERY_STATES,
};

/** A state string belonging to none of the three dimensions. */
const UNKNOWN_STATE = 'AwaitingClarity';

/** The only attempt states that consume execution capacity and hold a lease. */
const CAPACITY_STATES = new Set(['Preparing', 'Running', 'Verifying']);

/**
 * States in which work can still be dispatched, and the owner can therefore stop
 * it. Completed is excluded on purpose: nothing is in flight to cancel, and
 * Cancelled is excluded because it is terminal.
 */
const IN_FLIGHT_STATES: readonly AttemptState[] = [
  'Queued',
  'Preparing',
  'Running',
  'Verifying',
  'WaitingForOwner',
  'Paused',
  'Blocked',
];

/** The bounded path a run takes to finish, ending in Completed. */
const RUN_TO_COMPLETED: readonly AttemptState[] = [
  'Queued',
  'Preparing',
  'Running',
  'Verifying',
  'Completed',
];

function expectAllowed(result: Result<unknown>): void {
  if (!result.ok) assert.fail(`expected the transition to be accepted, got: ${result.error.reason}`);
}

function expectInvalid(result: Result<unknown>): InvalidError {
  if (result.ok) assert.fail(`expected a rejection, got ok: ${JSON.stringify(result.value)}`);
  assert.equal(result.error.code, 'Invalid');
  return result.error;
}

/** The states of one dimension reachable in a single step from `from`. */
function reachableStates(dimension: TransitionDimension, from: string): readonly string[] {
  return DIMENSION_STATES[dimension].filter((state) => canTransition(dimension, from, state));
}

describe('lifecycle: coverage of the exported state tables', () => {
  test('§3 - every attempt state is an accepted input and has a transition entry', () => {
    for (const state of ATTEMPT_STATES) {
      const rejected = expectInvalid(assertTransition('attempt', state, UNKNOWN_STATE));
      assert.doesNotMatch(
        rejected.reason,
        /^Unknown attempt state/,
        `${state} has no attempt transition entry, so its meaning is undefined`,
      );
      assert.match(rejected.reason, /^Illegal attempt transition/);
      assert.deepEqual(rejected.fields.map((field) => field.path), ['attempt']);
      assert.equal(isActiveAttempt(state), CAPACITY_STATES.has(state));
      assert.equal(needsHeartbeat(state), CAPACITY_STATES.has(state));
    }
  });

  test('§3 - every acceptance state is an accepted input and has a transition entry', () => {
    for (const state of ACCEPTANCE_STATES) {
      const rejected = expectInvalid(assertTransition('acceptance', state, UNKNOWN_STATE));
      assert.doesNotMatch(rejected.reason, /^Unknown acceptance state/);
      assert.match(rejected.reason, /^Illegal acceptance transition/);
      assert.deepEqual(rejected.fields.map((field) => field.path), ['acceptance']);
    }
  });

  test('§3 - every delivery state is an accepted input and has a transition entry', () => {
    for (const state of DELIVERY_STATES) {
      const rejected = expectInvalid(assertTransition('delivery', state, UNKNOWN_STATE));
      assert.doesNotMatch(rejected.reason, /^Unknown delivery state/);
      assert.match(rejected.reason, /^Illegal delivery transition/);
      assert.deepEqual(rejected.fields.map((field) => field.path), ['delivery']);
    }
  });

  test('§3 - the three state dimensions are pairwise disjoint', () => {
    const dimensions = [
      ['attempt', ATTEMPT_STATES],
      ['acceptance', ACCEPTANCE_STATES],
      ['delivery', DELIVERY_STATES],
    ] as const;
    const seen = new Set<string>();
    for (const [dimension, states] of dimensions) {
      for (const state of states) {
        assert.ok(!seen.has(state), `${state} is used by more than one dimension (${dimension})`);
        seen.add(state);
      }
    }
    assert.equal(seen.size, ATTEMPT_STATES.length + ACCEPTANCE_STATES.length + DELIVERY_STATES.length);
  });
});

describe('lifecycle: legal attempt transitions', () => {
  test('F13/F15 - Queued to Preparing is accepted', () => {
    expectAllowed(assertTransition('attempt', 'Queued', 'Preparing'));
    assert.equal(canTransition('attempt', 'Queued', 'Preparing'), true);
    assert.deepEqual(reachableStates('attempt', 'Queued'), ['Preparing', 'Blocked', 'Cancelled']);
  });

  test('F15 - Running to Verifying is accepted', () => {
    expectAllowed(assertTransition('attempt', 'Running', 'Verifying'));
    assert.equal(canTransition('attempt', 'Running', 'Verifying'), true);
  });

  test('F17-AC3 - resume returns to Running, never back to Queued', () => {
    expectAllowed(assertTransition('attempt', 'Paused', 'Running'));
    assert.deepEqual(reachableStates('attempt', 'Paused'), [
      'Preparing',
      'Running',
      'Blocked',
      'Cancelled',
    ]);
  });

  test('F20 - Verifying to WaitingForOwner is accepted', () => {
    expectAllowed(assertTransition('attempt', 'Verifying', 'WaitingForOwner'));
    assert.equal(canTransition('attempt', 'Verifying', 'WaitingForOwner'), true);
  });

  test('F17 - Completed is reachable again through verification, so it is not final', () => {
    expectAllowed(assertTransition('attempt', 'Completed', 'Verifying'));
    expectAllowed(assertTransition('attempt', 'Completed', 'WaitingForOwner'));
    assert.deepEqual(reachableStates('attempt', 'Completed'), ['Verifying', 'WaitingForOwner']);
  });

  test('F17-AC4 - Cancelled is terminal and nothing leaves it', () => {
    assert.deepEqual(reachableStates('attempt', 'Cancelled'), []);
    for (const state of IN_FLIGHT_STATES) {
      const rejected = expectInvalid(assertTransition('attempt', 'Cancelled', state));
      assert.equal(
        rejected.fields[0]?.message,
        `Cancelled is terminal; ${state} is not reachable.`,
        `Cancelled must not reach ${state}`,
      );
    }
  });

  test('F17-AC4 - the owner can stop work from every state where work is in flight', () => {
    for (const state of IN_FLIGHT_STATES) {
      assert.equal(
        canTransition('attempt', state, 'Cancelled'),
        true,
        `the owner must be able to stop work from ${state}`,
      );
    }
  });

  test('§3 - a transition to the state a run is already in is an accepted no-op', () => {
    // Idempotency matters for a retried command: reporting a state must not be
    // rejected as an illegal transition.
    const firstStates = [
      ['attempt', ATTEMPT_STATES],
      ['acceptance', ACCEPTANCE_STATES],
      ['delivery', DELIVERY_STATES],
    ] as const;
    for (const [dimension, states] of firstStates) {
      const state = states[0];
      assert.ok(state !== undefined);
      assert.deepEqual(assertTransition(dimension, state, state), {
        ok: true,
        value: { from: state, to: state },
      });
    }
  });
});

describe('lifecycle: rejected attempt transitions', () => {
  test('§3 - Completed cannot be reopened as Running', () => {
    assert.equal(canTransition('attempt', 'Completed', 'Running'), false);
    const rejected = expectInvalid(assertTransition('attempt', 'Completed', 'Running'));
    assert.equal(rejected.reason, 'Illegal attempt transition Completed -> Running');
    assert.equal(rejected.fields[0]?.message, 'From Completed the reachable states are: Verifying, WaitingForOwner.');
  });

  test('F17-AC4 - Cancelled cannot be resumed', () => {
    assert.equal(canTransition('attempt', 'Cancelled', 'Running'), false);
    expectInvalid(assertTransition('attempt', 'Cancelled', 'Running'));
  });

  test('F26 - Released cannot be merged after the fact', () => {
    assert.equal(canTransition('delivery', 'Released', 'Merged'), false);
    const rejected = expectInvalid(assertTransition('delivery', 'Released', 'Merged'));
    assert.equal(rejected.reason, 'Illegal delivery transition Released -> Merged');
    assert.equal(rejected.fields[0]?.path, 'delivery');
  });

  test('F26-AC2 - delivery cannot jump from unauthorised straight to merged', () => {
    assert.equal(canTransition('delivery', 'NotAuthorized', 'Merged'), false);
    const rejected = expectInvalid(assertTransition('delivery', 'NotAuthorized', 'Merged'));
    assert.equal(rejected.fields[0]?.message, 'From NotAuthorized the reachable states are: Authorized.');
  });

  test('F25-AC4 - acceptance cannot be pushed back to Pending from Accepted', () => {
    assert.equal(canTransition('acceptance', 'Accepted', 'Pending'), false);
    const rejected = expectInvalid(assertTransition('acceptance', 'Accepted', 'Pending'));
    assert.equal(rejected.fields[0]?.message, 'From Accepted the reachable states are: Stale.');
  });

  test('§3 - a rejection is a typed Invalid error, never a thrown exception', () => {
    const illegal: readonly [TransitionDimension, string, string][] = [
      ['attempt', 'Completed', 'Running'],
      ['attempt', 'Cancelled', 'Running'],
      ['delivery', 'Released', 'Merged'],
      ['delivery', 'NotAuthorized', 'Merged'],
      ['acceptance', 'Accepted', 'Pending'],
    ];
    for (const [dimension, from, to] of illegal) {
      const rejected = expectInvalid(assertTransition(dimension, from, to));
      assert.equal(rejected.reason, `Illegal ${dimension} transition ${from} -> ${to}`);
      assert.equal(rejected.fields.length, 1);
      assert.equal(rejected.fields[0]?.path, dimension);
      assert.ok((rejected.fields[0]?.message.length ?? 0) > 0, 'a rejection must explain itself');
      assert.equal(canTransition(dimension, from, to), false);
    }
  });
});

describe('lifecycle: unknown states', () => {
  test('§3 - an unknown attempt state is rejected and names the attempt dimension', () => {
    const rejected = expectInvalid(assertTransition('attempt', UNKNOWN_STATE, 'Running'));
    assert.equal(rejected.reason, `Unknown attempt state: ${UNKNOWN_STATE}`);
    assert.deepEqual(rejected.fields, [
      { path: 'attempt', message: 'Not a valid attempt state.' },
    ]);
    assert.equal(canTransition('attempt', UNKNOWN_STATE, 'Running'), false);
  });

  test('§3 - an unknown acceptance state is rejected and names the acceptance dimension', () => {
    const rejected = expectInvalid(assertTransition('acceptance', UNKNOWN_STATE, 'Pending'));
    assert.equal(rejected.reason, `Unknown acceptance state: ${UNKNOWN_STATE}`);
    assert.deepEqual(rejected.fields, [
      { path: 'acceptance', message: 'Not a valid acceptance state.' },
    ]);
  });

  test('§3 - an unknown delivery state is rejected and names the delivery dimension', () => {
    const rejected = expectInvalid(assertTransition('delivery', UNKNOWN_STATE, 'Authorized'));
    assert.equal(rejected.reason, `Unknown delivery state: ${UNKNOWN_STATE}`);
    assert.deepEqual(rejected.fields, [
      { path: 'delivery', message: 'Not a valid delivery state.' },
    ]);
  });

  test('§3 - from equal to an unknown state is rejected instead of being taken as a no-op', () => {
    // The from === to check ran before the state was known to exist, so two equal
    // nonsense strings were accepted as an idempotent no-op.
    const rejected = expectInvalid(assertTransition('attempt', 'Bogus', 'Bogus'));

    assert.equal(rejected.reason, 'Unknown attempt state: Bogus');
    assert.deepEqual(rejected.fields, [{ path: 'attempt', message: 'Not a valid attempt state.' }]);
  });

  test('§3 - every dimension refuses an equal pair of unknown states and names itself', () => {
    const cases: readonly [TransitionDimension, string][] = [
      ['attempt', 'Bogus'],
      ['acceptance', 'Bogus'],
      ['delivery', 'Bogus'],
    ];
    for (const [dimension, state] of cases) {
      const rejected = expectInvalid(assertTransition(dimension, state, state));
      assert.equal(rejected.reason, `Unknown ${dimension} state: ${state}`, dimension);
      assert.equal(rejected.fields[0]?.path, dimension, dimension);
      assert.equal(canTransition(dimension, state, state), false, dimension);
    }
  });
});

describe('lifecycle: capacity and lease state', () => {
  test('F13 - only Preparing, Running and Verifying are active attempts', () => {
    for (const state of ATTEMPT_STATES) {
      const expected = CAPACITY_STATES.has(state);
      assert.equal(isActiveAttempt(state), expected, `isActiveAttempt(${state})`);
      assert.equal(needsHeartbeat(state), expected, `needsHeartbeat(${state})`);
    }
  });

  test('F17 - Paused, Queued, Completed and Cancelled hold no lease', () => {
    for (const state of ['Paused', 'Queued', 'Completed', 'Cancelled'] as const) {
      assert.equal(isActiveAttempt(state), false, `${state} must not consume capacity`);
      assert.equal(needsHeartbeat(state), false, `${state} must not need a heartbeat`);
    }
  });

  test('F13 - WaitingForOwner and Blocked release capacity back to the owner', () => {
    for (const state of ['WaitingForOwner', 'Blocked'] as const) {
      assert.equal(isActiveAttempt(state), false);
      assert.equal(needsHeartbeat(state), false);
    }
  });
});

describe('lifecycle: the dimensions do not imply each other', () => {
  test('§3 - no attempt transition reaches an acceptance or delivery state', () => {
    const foreign = [...ACCEPTANCE_STATES, ...DELIVERY_STATES];
    for (const from of ATTEMPT_STATES) {
      for (const to of foreign) {
        assert.equal(
          canTransition('attempt', from, to),
          false,
          `attempt ${from} -> ${to} would fuse two dimensions`,
        );
      }
    }
  });

  test('§3/F25-AC4 - a Completed attempt leaves acceptance NotRequested and cannot self-accept', () => {
    for (let index = 1; index < RUN_TO_COMPLETED.length; index += 1) {
      const from = RUN_TO_COMPLETED[index - 1];
      const to = RUN_TO_COMPLETED[index];
      assert.ok(from !== undefined && to !== undefined);
      expectAllowed(assertTransition('attempt', from, to));
    }
    assert.equal(RUN_TO_COMPLETED.at(-1), 'Completed');
    assert.equal(isActiveAttempt('Completed'), false);

    // Acceptance is still NotRequested: the only one-step moves are an owner
    // request or a staleness marking. Nothing reaches Accepted without the owner.
    assert.deepEqual(reachableStates('acceptance', 'NotRequested'), ['Pending', 'Stale']);
    assert.equal(canTransition('acceptance', 'NotRequested', 'Accepted'), false);
    assert.equal(canTransition('acceptance', 'Pending', 'Accepted'), true);
  });

  test('§3/F26-AC1 - a Completed attempt leaves delivery NotAuthorized', () => {
    // Delivery is still NotAuthorized. Authorisation is a separate owner act;
    // completing the run performs none of the delivery steps on its own.
    assert.deepEqual(reachableStates('delivery', 'NotAuthorized'), ['Authorized']);
    for (const state of ['Merging', 'Merged', 'Releasing', 'Released'] as const) {
      assert.equal(
        canTransition('delivery', 'NotAuthorized', state),
        false,
        `delivery must not reach ${state} without an explicit authorisation`,
      );
    }
  });
});

describe('lifecycle: outcome unknown and reconciliation', () => {
  /**
   * F28-AC4/F30-AC5 want OutcomeUnknown to be left only through reconciliation.
   *
   * Released used to be directly reachable from OutcomeUnknown, which let a lost
   * response be resolved by assuming success and repeating the release blind. It is
   * now rejected, so the reachable set is compared in full.
   */
  test('F28-AC4/F30-AC5 OutcomeUnknown cannot reach Released directly', () => {
    assert.equal(canTransition('delivery', 'OutcomeUnknown', 'Released'), false);

    const rejected = expectInvalid(assertTransition('delivery', 'OutcomeUnknown', 'Released'));
    assert.equal(rejected.reason, 'Illegal delivery transition OutcomeUnknown -> Released');
    assert.equal(rejected.fields[0]?.path, 'delivery');
    assert.equal(
      rejected.fields[0]?.message,
      'From OutcomeUnknown the reachable states are: Merged, Releasing, Failed, Authorized.',
    );
  });

  test('F28-AC4/F30-AC5 the whole reachable set of OutcomeUnknown is reconciliation, never a release', () => {
    // Listed in the exported DELIVERY_STATES order, not the table order, so this
    // pins the complete set rather than one particular listing of it.
    const reachable = reachableStates('delivery', 'OutcomeUnknown');
    assert.deepEqual(reachable, ['Authorized', 'Merged', 'Releasing', 'Failed']);

    // The complement is asserted separately, so a state newly added to the table
    // fails here instead of quietly widening the set.
    for (const state of DELIVERY_STATES.filter((candidate) => !reachable.includes(candidate))) {
      assert.equal(
        canTransition('delivery', 'OutcomeUnknown', state),
        false,
        `${state} must not be reachable from an unresolved delivery`,
      );
    }
  });

  test('F28-AC4/F30-AC5 OutcomeUnknown can be resolved by reconciliation', () => {
    for (const state of ['Merged', 'Releasing', 'Failed', 'Authorized'] as const) {
      assert.equal(
        canTransition('delivery', 'OutcomeUnknown', state),
        true,
        `reconciliation must be able to establish ${state}`,
      );
      expectAllowed(assertTransition('delivery', 'OutcomeUnknown', state));
    }
  });

  test('F28-AC4 the three reconciliation destinations that resolve what actually happened stay accepted', () => {
    for (const state of ['Merged', 'Releasing', 'Failed'] as const) {
      expectAllowed(assertTransition('delivery', 'OutcomeUnknown', state));
    }
  });

  test('F28-AC4 a lost result is not a licence to repeat the delivery attempt', () => {
    // Repeating a deployment or merge is reachable from a known Failed outcome,
    // not from an unresolved one.
    assert.equal(canTransition('delivery', 'Failed', 'Authorized'), true);
    assert.equal(canTransition('delivery', 'Authorized', 'Merging'), true);
    assert.equal(canTransition('delivery', 'Merging', 'OutcomeUnknown'), true);
  });
});
