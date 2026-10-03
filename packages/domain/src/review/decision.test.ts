import assert from 'node:assert/strict';
import test from 'node:test';

import { asCommitSha } from '../ids.ts';
import type { OwnerId } from '../ids.ts';
import { decisionAppliesTo, governingMvpDecision, recordMvpOwnerDecision } from './decision.ts';
import type { RecordMvpDecisionInput } from './decision.ts';

const HEAD = asCommitSha('a'.repeat(40));
const NEXT_HEAD = asCommitSha('d'.repeat(40));
const OWNER = 'own-1' as OwnerId;

function input(overrides: Partial<RecordMvpDecisionInput> = {}): RecordMvpDecisionInput {
  return {
    decisionId: 'dec-1',
    kind: 'accepted',
    actor: { role: 'owner', ownerId: OWNER },
    projectId: 'proj-1',
    requestId: 'req-1',
    contractId: 'contract-1',
    contractRevision: 3,
    candidateId: 'cand-1',
    candidateHeadSha: HEAD,
    decidedAt: '2026-10-03T10:00:00Z',
    feedback: null,
    ...overrides,
  };
}

const CURRENT = { contractId: 'contract-1', contractRevision: 3, candidateHeadSha: HEAD };

test('an acceptance binds revision, full SHA, owner and timestamp', () => {
  const recorded = recordMvpOwnerDecision(input());
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.value.contractRevision, 3);
  assert.equal(recorded.value.candidateHeadSha, HEAD);
  assert.equal(recorded.value.ownerId, OWNER);
  assert.equal(recorded.value.decidedAt, '2026-10-03T10:00:00Z');
});

test('an agent cannot accept: the role carries no owner identity to record', () => {
  const recorded = recordMvpOwnerDecision(input({ actor: { role: 'agent' } }));
  assert.equal(recorded.ok, false);
  if (recorded.ok) return;
  assert.equal(recorded.error.code, 'Forbidden');
  assert.match(recorded.error.reason, /agent/);
});

test('an automation or system role cannot request changes either', () => {
  for (const role of ['automation', 'system'] as const) {
    const recorded = recordMvpOwnerDecision(input({ kind: 'changes_requested', actor: { role } }));
    assert.equal(recorded.ok, false);
  }
});

test('a decision against a branch name or abbreviated SHA is refused', () => {
  for (const candidateHeadSha of ['main', 'a1b2c3d', 'feature/login']) {
    const recorded = recordMvpOwnerDecision(input({ candidateHeadSha }));
    assert.equal(recorded.ok, false, `${candidateHeadSha} must not identify a candidate`);
  }
});

test('feedback is optional but an empty string is not feedback', () => {
  const withNull = recordMvpOwnerDecision(input({ kind: 'changes_requested', feedback: null }));
  assert.equal(withNull.ok, true);
  const withEmpty = recordMvpOwnerDecision(input({ kind: 'changes_requested', feedback: '  ' }));
  assert.equal(withEmpty.ok, false);
  if (withEmpty.ok || withEmpty.error.code !== 'Invalid') return;
  assert.ok(withEmpty.error.fields.some((field) => field.path === 'feedback'));
});

test('owner feedback is redacted before it is recorded', () => {
  const credential = ['gh', 'p_', '0123456789abcdefghijklmnop'].join('');
  const recorded = recordMvpOwnerDecision(
    input({ kind: 'changes_requested', feedback: `the token ${credential} is printed on the page` }),
  );
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.ok(!(recorded.value.feedback ?? '').includes(credential));
});

test('an acceptance applies to the candidate it was made against', () => {
  const recorded = recordMvpOwnerDecision(input());
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(decisionAppliesTo(recorded.value, CURRENT).applies, true);
});

test('a new commit makes an acceptance inapplicable, not merely old', () => {
  const recorded = recordMvpOwnerDecision(input());
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  const match = decisionAppliesTo(recorded.value, {
    contractId: 'contract-1',
    contractRevision: 3,
    candidateHeadSha: NEXT_HEAD,
  });
  assert.equal(match.applies, false);
  assert.deepEqual(match.staleReasons, ['CandidateShaChanged']);
});

test('a contract revision bump makes an acceptance inapplicable', () => {
  const recorded = recordMvpOwnerDecision(input());
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  const match = decisionAppliesTo(recorded.value, {
    contractId: 'contract-1',
    contractRevision: 4,
    candidateHeadSha: HEAD,
  });
  assert.equal(match.applies, false);
  assert.deepEqual(match.staleReasons, ['ContractRevisionChanged']);
});

test('the governing decision ignores an acceptance a push invalidated', () => {
  const accepted = recordMvpOwnerDecision(input({ decisionId: 'dec-accept' }));
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;

  const governing = governingMvpDecision([accepted.value], {
    contractId: 'contract-1',
    contractRevision: 3,
    candidateHeadSha: NEXT_HEAD,
  });
  assert.equal(governing.decision, null);
  assert.equal(governing.staleDecisions.length, 1);
  assert.equal(governing.staleDecisions[0]?.decision.decisionId, 'dec-accept');
});

test('the newest change request outranks an earlier acceptance', () => {
  const accepted = recordMvpOwnerDecision(input({ decisionId: 'dec-accept', decidedAt: '2026-10-03T10:00:00Z' }));
  const changes = recordMvpOwnerDecision(
    input({ decisionId: 'dec-changes', kind: 'changes_requested', decidedAt: '2026-10-03T11:00:00Z', feedback: 'the label is wrong' }),
  );
  assert.equal(accepted.ok, true);
  assert.equal(changes.ok, true);
  if (!accepted.ok || !changes.ok) return;

  const governing = governingMvpDecision([accepted.value, changes.value], CURRENT);
  assert.equal(governing.decision?.kind, 'changes_requested');
  assert.equal(governing.decision?.decisionId, 'dec-changes');
});

test('a later acceptance supersedes an earlier change request', () => {
  const changes = recordMvpOwnerDecision(
    input({ decisionId: 'dec-changes', kind: 'changes_requested', decidedAt: '2026-10-03T10:00:00Z', feedback: 'the label is wrong' }),
  );
  const accepted = recordMvpOwnerDecision(input({ decisionId: 'dec-accept', decidedAt: '2026-10-03T12:00:00Z' }));
  assert.equal(changes.ok, true);
  assert.equal(accepted.ok, true);
  if (!changes.ok || !accepted.ok) return;

  const governing = governingMvpDecision([changes.value, accepted.value], CURRENT);
  assert.equal(governing.decision?.kind, 'accepted');
});

test('an undated decision is refused: a decision must say when it was made', () => {
  const recorded = recordMvpOwnerDecision(input({ decidedAt: 'yesterday' }));
  assert.equal(recorded.ok, false);
  if (recorded.ok || recorded.error.code !== 'Invalid') return;
  assert.ok(recorded.error.fields.some((field) => field.path === 'decidedAt'));
});

test('a non-positive contract revision is refused', () => {
  const recorded = recordMvpOwnerDecision(input({ contractRevision: 0 }));
  assert.equal(recorded.ok, false);
});