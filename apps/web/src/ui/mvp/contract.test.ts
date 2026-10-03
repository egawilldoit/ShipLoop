/**
 * The Delivery Contract's editing and approval rules.
 *
 * These are the tests that matter most in this namespace, because the two rules they protect —
 * an approved contract never silently mutates, and nothing but the owner approves one — are the
 * rules a form cannot enforce by itself.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  approvalRefusals,
  draftFromContract,
  draftProblemsByPath,
  isDraftDirty,
  ownerTestCount,
  saveBody,
  saveIntent,
  validateContractDraft,
  type ContractDraft,
} from './contract.ts';
import type { DeliveryContract } from './wire.ts';

function draft(overrides: Partial<ContractDraft> = {}): ContractDraft {
  return {
    outcome: 'An owner finds one run by name and reaches its detail page.',
    scope: 'A search field above the runs table.',
    outOfScope: ['searching log output'],
    acceptanceCriteria: [{ id: 'criterion-1', description: 'Searching a run name finds that run', verificationType: 'automated' }],
    ...overrides,
  };
}

function contract(overrides: Partial<DeliveryContract> = {}): DeliveryContract {
  return {
    id: 'ctc_1',
    projectId: 'prj_1',
    requestId: 'req_1',
    revision: 2,
    outcome: 'An owner finds one run by name.',
    scope: 'A search field above the runs table.',
    outOfScope: [],
    acceptanceCriteria: [{ id: 'criterion-1', description: 'Searching a run name finds that run', verificationType: 'automated' }],
    status: 'approved',
    approvedAt: '2026-01-02T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

test('a draft with no outcome, no scope and no criterion is refused with one message per field', () => {
  const problems = validateContractDraft({ outcome: '  ', scope: '', outOfScope: [], acceptanceCriteria: [] });
  const paths = problems.map((problem) => problem.path);
  assert.ok(paths.includes('outcome'));
  assert.ok(paths.includes('scope'));
  assert.ok(paths.includes('acceptanceCriteria'));
});

test('a criterion with only whitespace does not satisfy the at-least-one rule', () => {
  const problems = validateContractDraft(
    draft({ acceptanceCriteria: [{ id: null, description: '   ', verificationType: 'automated' }] }),
  );
  assert.ok(problems.some((problem) => problem.path === 'acceptanceCriteria'));
});

// A contract that forbids nothing is a real position. Requiring a "none" row would put a sentence
// in the agreement that the owner never wrote.
test('an empty out-of-scope list is allowed', () => {
  assert.deepEqual(validateContractDraft(draft({ outOfScope: [] })), []);
});

test('a blank exclusion row is refused by name so the message reaches its input', () => {
  const problems = validateContractDraft(draft({ outOfScope: ['searching log output', '  '] }));
  assert.deepEqual(
    problems.map((problem) => problem.path),
    ['outOfScope.1'],
  );
  assert.equal(draftProblemsByPath(problems)['outOfScope.1'], problems[0]?.message);
});

test('a complete draft has no problems, so approval is not blocked by the form', () => {
  assert.deepEqual(validateContractDraft(draft()), []);
});

test('an owner-test criterion is counted, because it changes what the owner must do later', () => {
  assert.equal(ownerTestCount(draft()), 0);
  assert.equal(
    ownerTestCount(
      draft({
        acceptanceCriteria: [
          { id: 'criterion-1', description: 'The owner confirms the result looks right', verificationType: 'owner_test' },
        ],
      }),
    ),
    1,
  );
});

test('whitespace-only edits are not a change, so pressing Save cannot silently bump a revision', () => {
  const saved = draft();
  assert.equal(isDraftDirty(saved, draft({ outcome: `${saved.outcome} ` })), false);
  assert.equal(isDraftDirty(saved, draft({ outOfScope: [...saved.outOfScope, '   '] })), false);
  assert.equal(isDraftDirty(saved, draft({ outcome: 'A different outcome entirely.' })), true);
});

// The invariant: an approved revision's text is the text that was approved.
test('changing an approved revision records a new revision, and says so', () => {
  const intent = saveIntent(draft(), draft({ scope: 'A different scope.' }), 'approved');
  assert.equal(intent.createsNewRevision, true);
  assert.match(intent.explanation, /new revision/i);
});

test('changing a draft edits it in place, because nothing approved is being rewritten', () => {
  const intent = saveIntent(draft(), draft({ scope: 'A different scope.' }), 'draft');
  assert.equal(intent.createsNewRevision, false);
  assert.match(intent.explanation, /edited in place/i);
});

test('changing a stale revision edits it in place: a stale revision holds no approval', () => {
  const intent = saveIntent(draft(), draft({ scope: 'A different scope.' }), 'stale');
  assert.equal(intent.createsNewRevision, false);
  assert.match(intent.explanation, /stale/i);
});

// Approving twice must not invalidate a live approval for no reason.
test('saving unchanged text on an approved revision does not create a revision', () => {
  const intent = saveIntent(draft(), draft(), 'approved');
  assert.equal(intent.createsNewRevision, false);
  assert.match(intent.explanation, /revision number stays/i);
});

test('approval is refused while the draft is incomplete, and every refusal is written out', () => {
  const refusals = approvalRefusals({ outcome: '', scope: '', outOfScope: [], acceptanceCriteria: [] }, 'draft');
  assert.equal(refusals.length, 3);
});

test('an already-approved revision has nothing to approve, and says that', () => {
  const refusals = approvalRefusals(draft(), 'approved');
  assert.deepEqual([...refusals], ['This revision is already approved.']);
});

test('a complete draft at any unapproved state has no refusal left', () => {
  assert.deepEqual([...approvalRefusals(draft(), 'draft')], []);
  assert.deepEqual([...approvalRefusals(draft(), 'stale')], []);
});

test('a saved contract round-trips into the form, keeping criterion identities', () => {
  const round = draftFromContract(contract());
  assert.equal(round.outcome, 'An owner finds one run by name.');
  assert.deepEqual(round.acceptanceCriteria[0], {
    id: 'criterion-1',
    description: 'Searching a run name finds that run',
    verificationType: 'automated',
  });
});

test('the save body trims, drops blank rows and carries criterion ids so the server can match them', () => {
  const body = saveBody(
    draft({
      outcome: '  Outcome.  ',
      outOfScope: ['kept', '   '],
      acceptanceCriteria: [
        { id: 'criterion-1', description: '  Real criterion  ', verificationType: 'owner_test' },
        { id: null, description: '   ', verificationType: 'automated' },
      ],
    }),
  );
  assert.equal(body.outcome, 'Outcome.');
  assert.deepEqual([...body.outOfScope], ['kept']);
  assert.equal(body.acceptanceCriteria.length, 1);
  assert.equal(body.acceptanceCriteria[0]?.id, 'criterion-1');
  assert.equal(body.acceptanceCriteria[0]?.description, 'Real criterion');
});