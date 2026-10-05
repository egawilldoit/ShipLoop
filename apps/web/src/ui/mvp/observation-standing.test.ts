/**
 * What the post-approval flow is allowed to say about a check.
 *
 * These tests exist because the failure mode this product is built to prevent is a *plausible* one: a
 * page that shows the provider's `passed` word next to a candidate that has since been force-pushed
 * is not obviously broken to anyone reading it. It looks correct. So the standing logic is pinned
 * here, in a file `node --test` can reach without a browser, and every branch is asserted against a
 * hand-built observation rather than a fixture the code under test might also have produced
 * (F20-AC2, F20-AC3, F24-AC3, F24-AC4, F23-AC5, N03-AC1).
 *
 * Each test names the wrong answer it is preventing, so a future edit that collapses two standings
 * has to argue with a specific sentence rather than with a diff.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attributedToCandidate,
  standingOf,
  type ObservationStanding,
  type RecordedObservation,
} from './observation-standing.ts';

/** Two commits that are not fixtures the code under test produced. */
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PREVIOUS_HEAD = 'fedcba98765432100123456789abcdef01234567';

/**
 * Builds one observation, defaulting every field except the two the standing turns on.
 *
 * Defaults to an observation that counts for `HEAD` and was attributed to `HEAD`, so a test changing
 * only `currentOutcome` is asserting about the outcome rather than accidentally about the attribution.
 */
function observation(overrides: Partial<RecordedObservation>): RecordedObservation {
  return {
    evidenceId: 'ev-1',
    checkId: 'unit-tests',
    recordedOutcome: 'passed',
    currentOutcome: 'passed',
    countsForCurrentCandidate: true,
    observedHeadSha: HEAD,
    observedAt: '2026-05-01T10:00:00.000Z',
    reason: '',
    ...overrides,
  };
}

/** The standing key alone, which is what a DOM assertion would read. */
function keyOf(overrides: Partial<RecordedObservation>, head = HEAD): ObservationStanding {
  return standingOf(observation(overrides), head).key;
}

/* -------------------------------------------------------------------------- */
/* The five outcomes                                                          */
/* -------------------------------------------------------------------------- */

test('a check that passed, attributed to this commit, is the only standing rendered as a pass', () => {
  const standing = standingOf(observation({ currentOutcome: 'passed' }), HEAD);
  assert.equal(standing.key, 'passed');
  assert.equal(standing.tone, 'healthy');
});

test('a failing check is its own standing and never reads as a pass', () => {
  const standing = standingOf(observation({ recordedOutcome: 'failed', currentOutcome: 'failed' }), HEAD);
  assert.equal(standing.key, 'failed');
  // A failure is a result about the product. It must not read as the absence of one, either.
  assert.notEqual(standing.tone, 'healthy');
  assert.notEqual(standing.tone, 'degraded');
});

test('a check that is still running concludes nothing and is not a pass', () => {
  const standing = standingOf(observation({ recordedOutcome: 'waiting', currentOutcome: 'waiting' }), HEAD);
  assert.equal(standing.key, 'running');
  // Distinct from both "passed" and "failed": nothing is known yet, in either direction.
  assert.notEqual(standing.key, 'passed');
  assert.notEqual(standing.key, 'failed');
  assert.notEqual(standing.tone, 'healthy');
});

test('a check that never ran proves nothing, and missing is not passed', () => {
  for (const outcome of ['missing', 'not_run']) {
    const standing = standingOf(observation({ recordedOutcome: outcome, currentOutcome: outcome }), HEAD);
    assert.equal(standing.key, 'never-ran', `${outcome} must not read as a pass`);
    assert.notEqual(standing.tone, 'healthy');
  }
});

test('a stale pass is not a pass, however confidently the source recorded it', () => {
  // The case the whole rule exists for: the provider said `passed`, the head has since moved, and
  // `recordedOutcome` is still sitting right there looking like a green tick.
  const standing = standingOf(
    observation({
      recordedOutcome: 'passed',
      currentOutcome: 'stale',
      countsForCurrentCandidate: false,
      observedHeadSha: PREVIOUS_HEAD,
    }),
    HEAD,
  );
  assert.equal(standing.key, 'stale');
  assert.notEqual(standing.tone, 'healthy');
});

test('the five outcomes are five distinct standings, and no two share one', () => {
  const keys = new Set<ObservationStanding>([
    keyOf({ currentOutcome: 'passed' }),
    keyOf({ recordedOutcome: 'failed', currentOutcome: 'failed' }),
    keyOf({ recordedOutcome: 'waiting', currentOutcome: 'waiting' }),
    keyOf({ recordedOutcome: 'missing', currentOutcome: 'missing' }),
    keyOf({
      recordedOutcome: 'passed',
      currentOutcome: 'stale',
      countsForCurrentCandidate: false,
      observedHeadSha: PREVIOUS_HEAD,
    }),
  ]);
  assert.equal(keys.size, 5);
});

/* -------------------------------------------------------------------------- */
/* Ordering, which is the property                                             */
/* -------------------------------------------------------------------------- */

test('a non-counting row is stale even when it reports passed and names a commit', () => {
  // All three disagreeing at once is the shape of the defect. Staleness is decided before the recorded
  // word is consulted, so the word cannot find a verdict first.
  const standing = standingOf(
    observation({
      recordedOutcome: 'passed',
      currentOutcome: 'passed',
      countsForCurrentCandidate: false,
      observedHeadSha: HEAD,
    }),
    HEAD,
  );
  assert.equal(standing.key, 'stale');
});

test('a row that counts while naming another commit renders no verdict at all', () => {
  // The route refuses this combination before it answers, so reaching it means the guard did not hold.
  // Reconciling the two fields here would invent the fact that decided which one was right.
  const standing = standingOf(
    observation({ recordedOutcome: 'passed', currentOutcome: 'passed', observedHeadSha: PREVIOUS_HEAD }),
    HEAD,
  );
  assert.equal(standing.key, 'unattributed');
  assert.notEqual(standing.tone, 'healthy');
});

test('a row that counts while naming no commit renders no verdict at all', () => {
  const standing = standingOf(observation({ observedHeadSha: null }), HEAD);
  assert.equal(standing.key, 'unattributed');
});

/* -------------------------------------------------------------------------- */
/* The two extra states                                                        */
/* -------------------------------------------------------------------------- */

test('a not-applicable check is never a pass, approved by policy or not', () => {
  const standing = standingOf(
    observation({
      recordedOutcome: 'not_applicable',
      currentOutcome: 'not_applicable',
      reason: 'Policy approved it.',
    }),
    HEAD,
  );
  assert.equal(standing.key, 'not-applicable');
  assert.notEqual(standing.tone, 'healthy');
});

test('a capture that never happened is not a behaviour failure', () => {
  // F23-AC5: a capture that never occurred observed nothing. Rendering it as `failed` would report the
  // product as broken on the strength of a screenshot that was never taken.
  const standing = standingOf(observation({ recordedOutcome: 'capture_failed', currentOutcome: 'capture_failed' }), HEAD);
  assert.equal(standing.key, 'capture-failed');
  assert.notEqual(standing.key, 'failed');
});

test('a result this build has no word for is reported as unread, not mapped onto a state', () => {
  const standing = standingOf(observation({ recordedOutcome: 'flaky', currentOutcome: 'flaky' }), HEAD);
  assert.equal(standing.key, 'unread');
  assert.notEqual(standing.tone, 'healthy');
});

/* -------------------------------------------------------------------------- */
/* Attribution                                                                 */
/* -------------------------------------------------------------------------- */

test('attribution is exact: a different commit does not attribute, and no commit does not either', () => {
  assert.equal(attributedToCandidate(observation({ observedHeadSha: HEAD }), HEAD), true);
  assert.equal(attributedToCandidate(observation({ observedHeadSha: PREVIOUS_HEAD }), HEAD), false);
  assert.equal(attributedToCandidate(observation({ observedHeadSha: null }), HEAD), false);
});

test('attribution is case-sensitive, so a differently-cased SHA is not silently the same commit', () => {
  // The domain's own rule is `[0-9a-f]`, so an upper-case SHA is not a SHA this product recognises.
  // Deciding the comparison here instead would make the UI accept an identity the server refuses.
  const upper = HEAD.toUpperCase();
  assert.notEqual(upper, HEAD);
  assert.equal(attributedToCandidate(observation({ observedHeadSha: upper }), HEAD), false);
});

/* -------------------------------------------------------------------------- */
/* Wording                                                                     */
/* -------------------------------------------------------------------------- */

test('no standing claims a running check has concluded, in either direction', () => {
  const running = standingOf(observation({ currentOutcome: 'waiting' }), HEAD);
  assert.match(running.standing, /still running/i);
  assert.doesNotMatch(running.standing, /passes|passed|failed/i);
});

test('a stale standing names why the recorded word is not a verdict', () => {
  const stale = standingOf(
    observation({
      recordedOutcome: 'passed',
      currentOutcome: 'stale',
      countsForCurrentCandidate: false,
      observedHeadSha: PREVIOUS_HEAD,
    }),
    HEAD,
  );
  assert.match(stale.standing, /does not count/i);
  assert.match(stale.standing, /no longer the head/i);
});

test('an unread result is bounded rather than echoed whole', () => {
  const long = 'x'.repeat(200);
  const standing = standingOf(observation({ currentOutcome: long }), HEAD);
  assert.equal(standing.key, 'unread');
  assert.ok(
    standing.label.length < long.length,
    'an unread value from the wire must not be rendered whole (N02-AC2)',
  );
});