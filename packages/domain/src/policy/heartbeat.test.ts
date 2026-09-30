import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_HEARTBEAT,
  evaluateHeartbeat,
  evaluateReclaim,
  reconciliationBackoff,
} from './heartbeat.ts';

const SECOND = 1_000;

test('the defaults are a 15 second heartbeat and a 60 second missed threshold', () => {
  assert.equal(DEFAULT_HEARTBEAT.intervalMs, 15 * SECOND);
  assert.equal(DEFAULT_HEARTBEAT.missedThresholdMs, 60 * SECOND);
  assert.equal(DEFAULT_HEARTBEAT.reconciliationIntervalMs, 60 * SECOND);
});

test('a heartbeat inside the threshold is Healthy', () => {
  const assessment = evaluateHeartbeat({ lastHeartbeatAtMs: 0, nowMs: 15 * SECOND });

  assert.equal(assessment.status, 'Healthy');
  if (assessment.status === 'Healthy') {
    assert.equal(assessment.silenceMs, 15 * SECOND);
    assert.equal(assessment.nextHeartbeatDueInMs, 0);
  }
});

test('silence one millisecond below the threshold is still Healthy', () => {
  const assessment = evaluateHeartbeat({ lastHeartbeatAtMs: 0, nowMs: 60 * SECOND - 1 });
  assert.equal(assessment.status, 'Healthy');
});

test('silence at exactly the 60 second threshold begins reconciliation (F17-AC3, F17-AC5)', () => {
  const assessment = evaluateHeartbeat({ lastHeartbeatAtMs: 0, nowMs: 60 * SECOND });

  assert.equal(assessment.status, 'ReconciliationRequired');
  if (assessment.status === 'ReconciliationRequired') {
    assert.equal(assessment.launchesSecondWriter, false);
    assert.deepEqual(assessment.requiredSteps, ['Establish whether the previous process is still writing']);
  }
});

test('an expired lease without a holder-stopped confirmation is ReclaimForbidden (F17-AC5)', () => {
  const assessment = evaluateHeartbeat({
    lastHeartbeatAtMs: 0,
    nowMs: 60 * SECOND,
    leaseExpiredAtMs: 30 * SECOND,
    holderStoppedConfirmedAtMs: null,
  });

  assert.equal(assessment.status, 'ReclaimForbidden');
  if (assessment.status === 'ReclaimForbidden') {
    assert.match(assessment.reason, /An expired lease is not proof that the old process stopped writing/);
    assert.deepEqual(assessment.requiredSteps, ['Establish whether the previous process is still writing']);
  }
});

test('a confirmed stopped holder leaves reconciliation, not a second writer', () => {
  const assessment = evaluateHeartbeat({
    lastHeartbeatAtMs: 0,
    nowMs: 60 * SECOND,
    leaseExpiredAtMs: 30 * SECOND,
    holderStoppedConfirmedAtMs: 45 * SECOND,
  });

  assert.equal(assessment.status, 'ReconciliationRequired');
});

test('a custom interval and threshold are honoured', () => {
  const assessment = evaluateHeartbeat({
    lastHeartbeatAtMs: 1_000,
    nowMs: 11_000,
    intervalMs: 5 * SECOND,
    missedThresholdMs: 30 * SECOND,
  });

  assert.equal(assessment.status, 'Healthy');
  if (assessment.status === 'Healthy') assert.equal(assessment.nextHeartbeatDueInMs, 0);
});

test('reclaim is forbidden when only the lease has timed out (F17-AC5)', () => {
  const decision = evaluateReclaim({
    leaseExpiredAtMs: 30 * SECOND,
    holderConfirmedStoppedAtMs: null,
    confirmedBy: null,
    nowMs: 60 * SECOND,
  });

  assert.equal(decision.permitted, false);
  if (!decision.permitted) {
    assert.deepEqual([...decision.missing].sort(), ['HolderConfirmationAttributed', 'HolderConfirmedStopped']);
  }
});

test('an unattributed stopped confirmation is still not enough (F17-AC5)', () => {
  const decision = evaluateReclaim({
    leaseExpiredAtMs: 30 * SECOND,
    holderConfirmedStoppedAtMs: 45 * SECOND,
    confirmedBy: null,
    nowMs: 60 * SECOND,
  });

  assert.equal(decision.permitted, false);
  if (!decision.permitted) assert.deepEqual(decision.missing, ['HolderConfirmationAttributed']);
});

test('a confirmation dated in the future does not count as a stopped holder', () => {
  const decision = evaluateReclaim({
    leaseExpiredAtMs: 30 * SECOND,
    holderConfirmedStoppedAtMs: 90 * SECOND,
    confirmedBy: 'operator-1',
    nowMs: 60 * SECOND,
  });

  assert.equal(decision.permitted, false);
  if (!decision.permitted) assert.ok(decision.missing.includes('HolderConfirmedStopped'));
});

test('reclaim is permitted only with a recorded and attributed stopped holder (F17-AC5)', () => {
  const decision = evaluateReclaim({
    leaseExpiredAtMs: 30 * SECOND,
    holderConfirmedStoppedAtMs: 45 * SECOND,
    confirmedBy: 'operator-1',
    nowMs: 60 * SECOND,
  });

  assert.equal(decision.permitted, true);
  if (decision.permitted) {
    assert.deepEqual(decision.missing, []);
    assert.deepEqual(decision.conditions, [
      'The previous holder was observed to have stopped writing.',
      'The confirmation is attributed to a named observer.',
    ]);
  }
});

test('a reclaim attempted before the lease expires is refused', () => {
  const decision = evaluateReclaim({
    leaseExpiredAtMs: 90 * SECOND,
    holderConfirmedStoppedAtMs: 45 * SECOND,
    confirmedBy: 'operator-1',
    nowMs: 60 * SECOND,
  });

  assert.equal(decision.permitted, false);
  if (!decision.permitted) assert.deepEqual(decision.missing, ['LeaseExpiryNotFuture']);
});

test('reconciliation backoff doubles, is monotonic and stays capped (F30-AC4)', () => {
  const base = 5 * SECOND;
  const max = 60 * SECOND;

  assert.equal(reconciliationBackoff(0, base, max), 5 * SECOND);
  assert.equal(reconciliationBackoff(1, base, max), 5 * SECOND);
  assert.equal(reconciliationBackoff(2, base, max), 10 * SECOND);
  assert.equal(reconciliationBackoff(3, base, max), 20 * SECOND);
  assert.equal(reconciliationBackoff(4, base, max), 40 * SECOND);
  assert.equal(reconciliationBackoff(5, base, max), 60 * SECOND);
  assert.equal(reconciliationBackoff(50, base, max), 60 * SECOND);
});

test('backoff never decreases as attempts rise (F30-AC4)', () => {
  const max = 90 * SECOND;
  let previous = -1;
  for (let attempts = 0; attempts <= 20; attempts += 1) {
    const delay = reconciliationBackoff(attempts, 1_000, max);
    assert.ok(delay >= previous, `attempt ${attempts} went backwards`);
    assert.ok(delay <= max);
    previous = delay;
  }
});

test('negative attempt counts collapse to the base delay rather than a negative one', () => {
  assert.equal(reconciliationBackoff(-3, 5 * SECOND, 60 * SECOND), 5 * SECOND);
});