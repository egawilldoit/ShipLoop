import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveCriterionState, isOutstanding, methodSatisfiedBy } from './criterion.ts';
import type { Observation } from './criterion.ts';
import type { MvpBindingMatch, MvpEvidenceSource } from './evidence.ts';

const CURRENT: MvpBindingMatch = { applies: true, staleReasons: [], reason: 'recorded against the current candidate' };
const STALE: MvpBindingMatch = { applies: false, staleReasons: ['CandidateShaChanged'], reason: 'a different candidate' };

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    outcome: 'passed',
    source: 'project_command',
    method: { kind: 'AutomatedCheck', checkId: 'unit' },
    observedAt: '2026-10-03T09:30:00Z',
    evidenceId: 'evid-1',
    ...overrides,
  };
}

test('an automated criterion with a current passing observation is passed', () => {
  const verdict = deriveCriterionState({
    verificationType: 'automated',
    method: { kind: 'AutomatedCheck', checkId: 'unit' },
    observation: observation(),
    binding: CURRENT,
  });
  assert.equal(verdict.state, 'passed');
});

test('no observation on an automated criterion is unverified', () => {
  const verdict = deriveCriterionState({
    verificationType: 'automated',
    method: { kind: 'AutomatedCheck', checkId: 'unit' },
    observation: null,
    binding: null,
  });
  assert.equal(verdict.state, 'unverified');
  assert.match(verdict.reason, /unverified/);
});

test('no observation on an owner-test criterion is pending', () => {
  const verdict = deriveCriterionState({
    verificationType: 'owner_test',
    method: { kind: 'OwnerTest', instructions: 'sign in' },
    observation: null,
    binding: null,
  });
  assert.equal(verdict.state, 'pending');
  assert.match(verdict.reason, /owner/);
});

test('stale evidence outranks a passing outcome', () => {
  for (const verificationType of ['automated', 'owner_test'] as const) {
    const verdict = deriveCriterionState({
      verificationType,
      method: verificationType === 'automated'
        ? { kind: 'AutomatedCheck', checkId: 'unit' }
        : { kind: 'OwnerTest', instructions: 'sign in' },
      observation: observation(),
      binding: STALE,
    });
    assert.equal(verdict.state, 'stale');
  }
});

test('a green automated check cannot discharge an owner test', () => {
  const verdict = deriveCriterionState({
    verificationType: 'owner_test',
    method: { kind: 'OwnerTest', instructions: 'sign in' },
    observation: observation({ source: 'github_check', method: { kind: 'AutomatedCheck', checkId: 'ci' } }),
    binding: CURRENT,
  });
  assert.equal(verdict.state, 'pending');
  assert.match(verdict.reason, /owner still has to run it/);
});

test('an owner test cannot stand in for the configured automated verification', () => {
  const verdict = deriveCriterionState({
    verificationType: 'automated',
    method: { kind: 'AutomatedCheck', checkId: 'unit' },
    observation: observation({ source: 'owner_test', method: { kind: 'OwnerTest', instructions: 'looks right' } }),
    binding: CURRENT,
  });
  assert.equal(verdict.state, 'unverified');
});

test('a check result recorded under a different method cannot verify the criterion', () => {
  const verdict = deriveCriterionState({
    verificationType: 'automated',
    method: { kind: 'AutomatedCheck', checkId: 'unit' },
    observation: observation({ method: { kind: 'AutomatedCheck', checkId: 'lint' } }),
    binding: CURRENT,
  });
  assert.equal(verdict.state, 'unverified');
  assert.match(verdict.reason, /assigned method/);
});

test('an unassigned criterion can never be satisfied, whatever observed', () => {
  const verdict = deriveCriterionState({
    verificationType: 'automated',
    method: { kind: 'Untested', reason: 'nobody assigned a method' },
    observation: observation(),
    binding: CURRENT,
  });
  assert.equal(verdict.state, 'unverified');
});

test('a check that never ran is unverified rather than passed', () => {
  const verdict = deriveCriterionState({
    verificationType: 'automated',
    method: { kind: 'AutomatedCheck', checkId: 'unit' },
    observation: observation({ outcome: 'missing' }),
    binding: CURRENT,
  });
  assert.equal(verdict.state, 'unverified');
  assert.match(verdict.reason, /did not run/);
});

test('a check still running is pending, not unverified and not passed', () => {
  const verdict = deriveCriterionState({
    verificationType: 'automated',
    method: { kind: 'AutomatedCheck', checkId: 'unit' },
    observation: observation({ outcome: 'waiting' }),
    binding: CURRENT,
  });
  assert.equal(verdict.state, 'pending');
});

test('a failed capture is unverified, distinct from a behaviour failure', () => {
  const captured = deriveCriterionState({
    verificationType: 'owner_test',
    method: { kind: 'OwnerTest', instructions: 'look' },
    observation: observation({ outcome: 'capture_failed', source: 'owner_test', method: { kind: 'OwnerTest', instructions: 'look' } }),
    binding: CURRENT,
  });
  const failed = deriveCriterionState({
    verificationType: 'owner_test',
    method: { kind: 'OwnerTest', instructions: 'look' },
    observation: observation({ outcome: 'failed', source: 'owner_test', method: { kind: 'OwnerTest', instructions: 'look' } }),
    binding: CURRENT,
  });
  assert.equal(captured.state, 'unverified');
  assert.equal(failed.state, 'failed');
  assert.match(captured.reason, /capture/);
});

test('a browser capture satisfies a browser-assigned criterion', () => {
  const verdict = deriveCriterionState({
    verificationType: 'automated',
    method: { kind: 'BrowserEvidence', evidenceId: 'evid-browser-1' },
    observation: observation({ source: 'browser', method: { kind: 'BrowserEvidence', evidenceId: 'evid-browser-1' } }),
    binding: CURRENT,
  });
  assert.equal(verdict.state, 'passed');
});

test('methodSatisfiedBy refuses every source for an unassigned criterion', () => {
  const sources: readonly MvpEvidenceSource[] = ['project_command', 'github_check', 'browser', 'owner_test'];
  for (const source of sources) {
    assert.equal(
      methodSatisfiedBy({ kind: 'Untested', reason: 'none' }, {
        source,
        method: { kind: 'AutomatedCheck', checkId: 'unit' },
      }),
      false,
    );
  }
});

test('methodSatisfiedBy compares the check identity, not just its kind', () => {
  assert.equal(
    methodSatisfiedBy({ kind: 'AutomatedCheck', checkId: 'unit' }, {
      source: 'github_check',
      method: { kind: 'AutomatedCheck', checkId: 'lint' },
    }),
    false,
  );
  assert.equal(
    methodSatisfiedBy({ kind: 'AutomatedCheck', checkId: 'unit' }, {
      source: 'github_check',
      method: { kind: 'AutomatedCheck', checkId: 'unit' },
    }),
    true,
  );
});

test('only pending and unverified are outstanding owner work', () => {
  assert.equal(isOutstanding('pending'), true);
  assert.equal(isOutstanding('unverified'), true);
  for (const state of ['passed', 'failed', 'stale'] as const) {
    assert.equal(isOutstanding(state), false);
  }
});