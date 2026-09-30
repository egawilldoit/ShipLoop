import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_LIMITS,
  activeExecutionBudget,
  classifyFailure,
  elapsedActiveTime,
  evaluateLimits,
  isRetryableCategory,
  recordOwnerWait,
  retryAllowedWithinLimits,
  usageReporting,
} from './limits.ts';
import type { AttemptLimits, OwnerWaitInterval } from './limits.ts';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const noWaits: readonly OwnerWaitInterval[] = [];

function attemptLimits(overrides: Partial<AttemptLimits> = {}): AttemptLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

test('elapsed active time excludes a recorded owner wait (F18-AC3)', () => {
  const ownerWait = recordOwnerWait(0, 45 * MINUTE, 'Waiting for owner clarification');

  assert.equal(ownerWait.waitedMs, 45 * MINUTE);
  assert.equal(elapsedActiveTime({ wallClockMs: 90 * MINUTE, ownerWaits: [ownerWait] }), 45 * MINUTE);
});

test('owner wait time never extends the execution budget (F18-AC3)', () => {
  const ownerWait = recordOwnerWait(0, 8 * 60 * MINUTE, 'Owner testing');

  const evaluation = evaluateLimits({
    limits: attemptLimits(),
    wallClockMs: 8 * 60 * MINUTE + 30 * MINUTE,
    fixPasses: 0,
    ownerWaits: [ownerWait],
  });

  assert.equal(evaluation.withinLimits, true);
  assert.equal(evaluation.activeMs, 30 * MINUTE);
  assert.equal(evaluation.ownerExtensionRequired, false);
  assert.match(evaluation.reason, /Within the active execution/);
});

test('several owner waits are all excluded and the result is clamped at zero', () => {
  const waits = [
    recordOwnerWait(0, 10 * MINUTE, 'clarification'),
    recordOwnerWait(20 * MINUTE, 50 * MINUTE, 'testing'),
  ];

  assert.equal(elapsedActiveTime({ wallClockMs: 60 * MINUTE, ownerWaits: waits }), 20 * MINUTE);
  assert.equal(elapsedActiveTime({ wallClockMs: 5 * MINUTE, ownerWaits: waits }), 0);
});

test('active execution budget reports the remaining allowance', () => {
  const budget = activeExecutionBudget({
    limits: attemptLimits(),
    wallClockMs: 25 * MINUTE,
    ownerWaits: noWaits,
  });

  assert.equal(budget.consumedMs, 25 * MINUTE);
  assert.equal(budget.remainingMs, 35 * MINUTE);
  assert.equal(budget.exceeded, false);
  assert.equal(budget.limitMs, 60 * MINUTE);
});

test('the 60-minute active execution limit trips and names the limit (F18-AC2)', () => {
  const atLimit = evaluateLimits({
    limits: attemptLimits(),
    wallClockMs: 60 * MINUTE,
    fixPasses: 0,
    ownerWaits: noWaits,
  });

  assert.equal(atLimit.withinLimits, false);
  assert.equal(atLimit.ownerExtensionRequired, true);
  assert.deepEqual(atLimit.reached, ['ActiveExecutionTime']);
  assert.match(atLimit.reason, /Active execution reached 3600000ms excluding owner waits/);

  const underLimit = evaluateLimits({
    limits: attemptLimits(),
    wallClockMs: 60 * MINUTE - 1,
    fixPasses: 0,
    ownerWaits: noWaits,
  });
  assert.equal(underLimit.withinLimits, true);
});

test('the two-fix-pass limit trips independently of elapsed time (F18-AC2)', () => {
  const withinPasses = evaluateLimits({
    limits: attemptLimits(),
    wallClockMs: MINUTE,
    fixPasses: 2,
    ownerWaits: noWaits,
  });
  assert.equal(withinPasses.withinLimits, true);
  assert.deepEqual(withinPasses.reached, []);

  const overPasses = evaluateLimits({
    limits: attemptLimits(),
    wallClockMs: MINUTE,
    fixPasses: 3,
    ownerWaits: noWaits,
  });
  assert.equal(overPasses.withinLimits, false);
  assert.equal(overPasses.ownerExtensionRequired, true);
  assert.deepEqual(overPasses.reached, ['AutomatedFixPasses']);
  assert.match(overPasses.reason, /Automated fix passes exceeded the limit of 2/);
});

test('both limits are named when both are crossed', () => {
  const evaluation = evaluateLimits({
    limits: attemptLimits(),
    wallClockMs: 2 * 60 * MINUTE,
    fixPasses: 5,
    ownerWaits: noWaits,
  });

  assert.deepEqual(evaluation.reached, ['ActiveExecutionTime', 'AutomatedFixPasses']);
});

test('defaults are the specified 60 minutes and two fix passes and are frozen', () => {
  assert.equal(DEFAULT_LIMITS.activeExecutionMs, 60 * MINUTE);
  assert.equal(DEFAULT_LIMITS.automatedFixPasses, 2);
  assert.equal(Object.isFrozen(DEFAULT_LIMITS), true);
});

test('tool retries use a separate allowance rather than the fix passes (F18-AC3)', () => {
  const limits = attemptLimits();

  const allowed = retryAllowedWithinLimits({ limits, operationRetries: 1, totalRetries: 5 });
  assert.equal(allowed.ok, true);

  const perOperation = retryAllowedWithinLimits({ limits, operationRetries: 3, totalRetries: 5 });
  assert.equal(perOperation.ok, false);
  if (!perOperation.ok) assert.match(perOperation.error.reason, /exhausted/);

  const perAttempt = retryAllowedWithinLimits({ limits, operationRetries: 0, totalRetries: 20 });
  assert.equal(perAttempt.ok, false);
  if (!perAttempt.ok) assert.match(perAttempt.error.reason, /attempt is exhausted/);
});

test('a deterministic authentication failure records every required field and is not retryable (F18-AC1, F18-AC5)', () => {
  const record = classifyFailure({
    stage: 'WorkspacePreparation',
    observed: { error: 'Git push rejected: credential rejected', references: ['artifacts/push.log'] },
    category: 'DeterministicAuth',
    attemptedRemedy: 'Re-ran push once with the same credential',
  });

  assert.equal(record.stage, 'WorkspacePreparation');
  assert.equal(record.category, 'DeterministicAuth');
  assert.deepEqual(record.observed.references, ['artifacts/push.log']);
  assert.equal(record.attemptedRemedy, 'Re-ran push once with the same credential');
  assert.equal(record.retryable, false);
  assert.equal(record.requiresOwnerAction, true);
  assert.match(record.recommendedNextAction, /valid credentials/);
  assert.deepEqual(record.prohibitedRemedies, ['RetryIdentically']);
});

test('a deterministic scope failure is not retryable', () => {
  const record = classifyFailure({
    stage: 'Clarification',
    observed: { error: 'Repository is not configured for this project profile', references: [] },
    category: 'DeterministicScope',
  });

  assert.equal(record.retryable, false);
  assert.equal(record.attemptedRemedy, null);
  assert.match(record.recommendedNextAction, /scope or configuration/);
  assert.equal(isRetryableCategory('DeterministicScope'), false);
  assert.equal(isRetryableCategory('Timeout'), true);
});

test('transient and capacity categories keep the recorded distinction', () => {
  const rateLimit = classifyFailure({
    stage: 'ProviderSync',
    observed: { error: '429 from provider', references: [] },
    category: 'ProviderRateLimit',
  });
  assert.equal(rateLimit.retryable, true);
  assert.equal(rateLimit.requiresOwnerAction, false);

  const quota = classifyFailure({
    stage: 'EngineExecution',
    observed: { error: 'monthly quota exhausted', references: [] },
    category: 'ProviderQuota',
  });
  assert.equal(quota.retryable, false);
  assert.equal(quota.requiresOwnerAction, true);
  assert.deepEqual(quota.prohibitedRemedies, [
    'SilentPlanUpgrade',
    'PaidModelFallback',
    'AccountRotation',
    'RetryIdentically',
  ]);
});

test('absent provider usage stays Unknown and no figure is invented (F18-AC4, N06-AC2)', () => {
  const usage = usageReporting(null);

  assert.equal(usage.availability, 'Unknown');
  assert.equal(usage.source, 'Absent');
  assert.equal(usage.inputTokens, 'Unknown');
  assert.equal(usage.outputTokens, 'Unknown');
  assert.equal(usage.totalTokens, 'Unknown');
  assert.equal(usage.remainingQuota, 'Unknown');
  assert.equal(usage.cost, 'Unknown');
});

test('reported provider usage is carried through and totals stay Unknown when partial', () => {
  const partial = usageReporting({ inputTokens: 1_000 });
  assert.equal(partial.availability, 'Reported');
  assert.equal(partial.inputTokens, 1_000);
  assert.equal(partial.outputTokens, 'Unknown');
  assert.equal(partial.totalTokens, 'Unknown');
  assert.equal(partial.cost, 'Unknown');

  const complete = usageReporting({ inputTokens: 1_000, outputTokens: 250 });
  assert.equal(complete.totalTokens, 1_250);
  assert.equal(complete.remainingQuota, 'Unknown');
});