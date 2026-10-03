import assert from 'node:assert/strict';
import test from 'node:test';

import { recordMvpEvidence, bindingAppliesTo, assessMvpEvidence } from './evidence.ts';
import type { RecordMvpEvidenceInput } from './evidence.ts';
import { deriveCriterionState } from './criterion.ts';

const HEAD = 'a'.repeat(40);
const HEAD_2 = 'b'.repeat(40);

function input(overrides: Partial<RecordMvpEvidenceInput> = {}): RecordMvpEvidenceInput {
  return {
    evidenceId: 'evid-1',
    contractId: 'contract-1',
    candidateId: 'cand-1',
    subject: { kind: 'check', checkId: 'lint' },
    method: { kind: 'AutomatedCheck', checkId: 'lint' },
    observation: { kind: 'command', outcome: 'passed' },
    observedHeadSha: HEAD,
    observedContractRevision: 3,
    observedAt: '2026-10-03T10:00:00Z',
    detail: null,
    artifactRef: null,
    ...overrides,
  };
}

test('a passing check binds the contract revision, full SHA, subject, method and time', () => {
  const recorded = recordMvpEvidence(input());
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  const binding = recorded.value.binding;
  assert.notEqual(binding, null);
  assert.equal(binding?.contractRevision, 3);
  assert.equal(binding?.candidateHeadSha, HEAD);
  assert.equal(binding?.method.kind, 'AutomatedCheck');
  assert.equal(binding?.observedAt, '2026-10-03T10:00:00Z');
});

test('an abbreviated SHA is refused: a branch name is not candidate identity', () => {
  const recorded = recordMvpEvidence(input({ observedHeadSha: 'abc1234' }));
  assert.equal(recorded.ok, false);
  if (recorded.ok) return;
  assert.equal(recorded.error.code, 'Invalid');
  assert.ok(recorded.error.fields.some((field) => field.path === 'observedHeadSha'));
});

test('evidence recorded against one SHA proves nothing about another', () => {
  const recorded = recordMvpEvidence(input());
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;

  const verdict = assessMvpEvidence(recorded.value, {
    contractId: 'contract-1',
    contractRevision: 3,
    candidateHeadSha: HEAD_2,
  });
  assert.equal(verdict.match.applies, false);
  assert.deepEqual(verdict.match.staleReasons, ['CandidateShaChanged']);
  assert.equal(verdict.currentOutcome, 'stale');
  assert.match(verdict.match.reason, /different candidate/);
});

test('a changed contract revision makes otherwise-matching evidence stale', () => {
  const recorded = recordMvpEvidence(input());
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  const verdict = assessMvpEvidence(recorded.value, {
    contractId: 'contract-1',
    contractRevision: 4,
    candidateHeadSha: HEAD,
  });
  assert.equal(verdict.match.applies, false);
  assert.deepEqual(verdict.match.staleReasons, ['ContractRevisionChanged']);
});

test('an unattributed observation is recordable but never applies', () => {
  const recorded = recordMvpEvidence(
    input({ observedHeadSha: null, observedContractRevision: null, observedAt: '2026-10-03T10:00:00Z' }),
  );
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.value.binding, null);
  const verdict = assessMvpEvidence(recorded.value, {
    contractId: 'contract-1',
    contractRevision: 3,
    candidateHeadSha: HEAD,
  });
  assert.equal(verdict.currentOutcome, 'stale');
  assert.deepEqual(verdict.match.staleReasons, ['Unattributed']);
});

test('a candidate-bound result must say when it was observed', () => {
  const recorded = recordMvpEvidence(input({ observedAt: null }));
  assert.equal(recorded.ok, false);
  if (recorded.ok) return;
  assert.ok(recorded.error.fields.some((field) => field.path === 'observedAt'));
});

test('a command result must be bound to a check, not to a criterion directly', () => {
  const recorded = recordMvpEvidence(
    input({ subject: { kind: 'criterion', criterionId: 'c1' } }),
  );
  assert.equal(recorded.ok, false);
  if (recorded.ok) return;
  assert.ok(recorded.error.fields.some((field) => field.path === 'subject.kind'));
});

test('an owner test cannot be filed against a check', () => {
  const recorded = recordMvpEvidence(
    input({
      subject: { kind: 'check', checkId: 'lint' },
      observation: { kind: 'owner_test', outcome: 'passed', actor: { role: 'owner', ownerId: 'own-1' } },
    }),
  );
  assert.equal(recorded.ok, false);
});

test('owner feedback is redacted before it can reach a stored row', () => {
  const recorded = recordMvpEvidence(
    input({ detail: 'token ghp_abcdefghijklmnopqrstuvwxyz012345 leaked into the output' }),
  );
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.ok(!(recorded.value.detail ?? '').includes('ghp_abcdefghijklmnopqrstuvwxyz012345'));
});

test('bindingAppliesTo names every differing dimension rather than stopping at the first', () => {
  const match = bindingAppliesTo(
    {
      contractId: 'contract-1',
      contractRevision: 1,
      candidateId: 'cand-1',
      candidateHeadSha: HEAD,
      subject: { kind: 'check', checkId: 'lint' },
      method: { kind: 'AutomatedCheck', checkId: 'lint' },
      observedAt: '2026-10-03T10:00:00Z',
    },
    { contractId: 'contract-1', contractRevision: 2, candidateHeadSha: HEAD_2 },
  );
  assert.deepEqual(match.staleReasons, ['CandidateShaChanged', 'ContractRevisionChanged']);
});

test('stale evidence yields the stale criterion state even when it says passed', () => {
  const verdict = deriveCriterionState({
    verificationType: 'automated',
    method: { kind: 'AutomatedCheck', checkId: 'lint' },
    observation: {
      outcome: 'passed',
      source: 'project_command',
      method: { kind: 'AutomatedCheck', checkId: 'lint' },
      observedAt: '2026-10-03T10:00:00Z',
      evidenceId: 'evid-1',
    },
    binding: { applies: false, staleReasons: ['CandidateShaChanged'], reason: 'different candidate' },
  });
  assert.equal(verdict.state, 'stale');
});