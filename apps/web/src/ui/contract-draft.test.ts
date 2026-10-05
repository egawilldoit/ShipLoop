/**
 * The approval rules, tested against the same terms the server uses.
 *
 * Each case below is a refusal `routes/contracts.ts` or `packages/domain/src/contract.ts`
 * actually makes, and the assertion is that the client reaches the same conclusion
 * *before* the owner presses Approve. That is the whole purpose of `contract-draft.ts`: an
 * owner must never be told their contract is approvable and then refused it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  boundCheckNames,
  criterionIdsInRefusal,
  draftContent,
  draftFromContract,
  draftFromRequest,
  draftProblems,
  emptyDraft,
  nextCriterionId,
  verificationChoices,
  type ContractDraft,
} from './contract-draft.ts';
import type { ContractView, VerificationCheckChoices } from './contract-client.ts';

function criterion(
  overrides: Partial<ContractDraft['acceptanceCriteria'][number]> = {},
): ContractDraft['acceptanceCriteria'][number] {
  return {
    key: 'criterion-1',
    id: 'AC1',
    description: 'The build passes.',
    verificationType: 'automated',
    verificationCheckId: 'build',
    ...overrides,
  };
}

function draftWith(acceptanceCriteria: readonly ContractDraft['acceptanceCriteria'][number][]): ContractDraft {
  return { outcome: 'The page loads.', scope: [], outOfScope: [], acceptanceCriteria };
}

function storedContract(overrides: Partial<ContractView> = {}): ContractView {
  return {
    contractId: 'ctr_1',
    revision: 1,
    projectId: 'shop',
    requestId: 'req_1',
    status: 'draft',
    outcome: 'The page loads.',
    scope: [],
    outOfScope: [],
    acceptanceCriteria: [{ id: 'AC1', description: 'The build passes.', verificationType: 'automated', verificationCheckId: 'build' }],
    contentFingerprint: 'fp_0123456789abcdef0123456789abcdef',
    requestFingerprint: 'fp_0123456789abcdef0123456789abcdee',
    answersCurrentRequest: true,
    approvedAt: null,
    approvedBy: null,
    staleReason: null,
    supersededByRevision: null,
    sourceBriefId: null,
    sourceBriefVersion: null,
    createdBy: 'own_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    blockedBecause: null,
    ...overrides,
  };
}

const CONFIGURED: VerificationCheckChoices = { kind: 'configured', checks: ['build', 'unit-tests', 'browser-e2e'] };

describe('criterion identity', () => {
  it('generates ids the owner never has to invent', () => {
    assert.equal(nextCriterionId([]), 'AC1');
    assert.equal(nextCriterionId(['AC1']), 'AC2');
    assert.equal(nextCriterionId(['AC1', 'AC3']), 'AC4');
  });

  it('never hands a removed row id to a new row', () => {
    // Two criteria sharing an id would make an approval refusal name one of them
    // ambiguously, so the id is stepped past rather than reused.
    assert.equal(nextCriterionId(['AC1', 'AC2', 'AC1']), 'AC3');
  });

  it('leaves ids it does not recognise alone', () => {
    assert.equal(nextCriterionId(['manual-one', 'AC2']), 'AC3');
  });
});

describe('approval rules, matching the server', () => {
  it('refuses an automated criterion with nothing bound, because it could only read unverified', () => {
    const problems = draftProblems(draftWith([criterion({ verificationCheckId: null })]));
    assert.equal(problems.approvable, false);
    assert.match(problems.bindings['criterion-1']?.[0]?.message ?? '', /must name the check/);
  });

  it('refuses an owner test that names a check, because a green check would discharge the owner\'s own step', () => {
    const problems = draftProblems(
      draftWith([criterion({ verificationType: 'owner_test', verificationCheckId: 'build' })]),
    );
    assert.equal(problems.approvable, false);
    assert.match(problems.bindings['criterion-1']?.[0]?.message ?? '', /owner test is the owner/);
  });

  it('accepts an owner test with no binding, which is the honest shape', () => {
    const problems = draftProblems(
      draftWith([criterion({ verificationType: 'owner_test', verificationCheckId: null })]),
    );
    assert.equal(problems.approvable, true);
  });

  it('accepts an automated criterion bound to a configured check', () => {
    assert.equal(draftProblems(draftWith([criterion()])).approvable, true);
  });

  it('requires an outcome, and at least one criterion', () => {
    const empty = draftProblems({ outcome: '   ', scope: [], outOfScope: [], acceptanceCriteria: [] });
    assert.equal(empty.approvable, false);
    assert.equal(empty.outcome.length, 1);
    assert.match(empty.criteria['criteria-region']?.[0]?.message ?? '', /at least one acceptance criterion/);
  });

  it('reports a blank list entry rather than dropping it quietly', () => {
    // The save drops it so a half-typed line is not sent, but it must be visible, or the
    // owner would not know the contract says less than they typed.
    const problems = draftProblems({ ...draftWith([criterion()]), scope: ['a', '   '] });
    assert.equal(problems.approvable, false);
    assert.equal(problems.scope.length, 1);
    assert.equal(problems.scope[0]?.key, 'scope-1');
  });

  it('requires every criterion to say something', () => {
    const problems = draftProblems(draftWith([criterion({ description: '  ' })]));
    assert.equal(problems.approvable, false);
    assert.match(problems.criteria['criterion-1']?.[0]?.message ?? '', /needs a description/);
  });
});

describe('the body a save sends', () => {
  it('forces an owner test binding to null, so switching type does not send a contradiction', () => {
    const content = draftContent(
      draftWith([criterion({ verificationType: 'owner_test', verificationCheckId: 'build' })]),
    );
    assert.equal(content.acceptanceCriteria[0]?.verificationCheckId, null);
  });

  it('normalises a blank binding to null rather than sending an empty name', () => {
    // The route refuses an empty check name, and an empty string is not the same as
    // "unbound" — only null is.
    const content = draftContent(draftWith([criterion({ verificationCheckId: '   ' })]));
    assert.equal(content.acceptanceCriteria[0]?.verificationCheckId, null);
  });

  it('trims text so a saved contract does not carry the trailing space of a textarea', () => {
    const content = draftContent({
      outcome: '  The page loads.  ',
      scope: ['  one  '],
      outOfScope: ['   '],
      acceptanceCriteria: [criterion({ description: ' The build passes. ' })],
    });
    assert.equal(content.outcome, 'The page loads.');
    assert.deepEqual(content.scope, ['one']);
    assert.deepEqual(content.outOfScope, []);
    assert.equal(content.acceptanceCriteria[0]?.description, 'The build passes.');
  });
});

describe('choosing a verification method', () => {
  it('offers the checks this project actually configures, not an invented list', () => {
    const choices = verificationChoices(CONFIGURED, draftWith([criterion()]));
    assert.equal(choices.kind, 'available');
    if (choices.kind !== 'available') return;
    assert.deepEqual(
      choices.choices.map((choice) => choice.name),
      ['build', 'unit-tests', 'browser-e2e'],
    );
  });

  it('keeps an already-bound check selectable after a profile edit drops it, marked out of date', () => {
    // Dropping it would silently unbind the criterion on the next save: a material change
    // to an agreement made without the owner choosing it.
    const choices = verificationChoices(
      { kind: 'configured', checks: ['browser-e2e'] },
      draftWith([criterion({ verificationCheckId: 'typecheck' })]),
    );
    assert.equal(choices.kind, 'available');
    if (choices.kind !== 'available') return;
    assert.deepEqual(choices.choices, [
      { name: 'browser-e2e', noLongerConfigured: false },
      { name: 'typecheck', noLongerConfigured: true },
    ]);
  });

  it('says the project configured none, which is a state the owner can act on', () => {
    const choices = verificationChoices({ kind: 'none-configured' }, draftWith([criterion({ verificationCheckId: null })]));
    assert.equal(choices.kind, 'none-configured');
  });

  it('does not offer an empty picker when the configuration could not be read', () => {
    // Presenting ignorance as a fact about the project would tell the owner their project
    // runs no checks when the list is simply unknown.
    const choices = verificationChoices(
      { kind: 'unreadable', reason: 'The profile could not be read.' },
      draftWith([criterion({ verificationCheckId: null })]),
    );
    assert.equal(choices.kind, 'unreadable');
  });

  it('lists only automated bindings, since an owner test never carries one', () => {
    assert.deepEqual(
      boundCheckNames([
        criterion({ key: 'a', id: 'AC1', verificationType: 'automated', verificationCheckId: 'build' }),
        criterion({ key: 'b', id: 'AC2', verificationType: 'owner_test', verificationCheckId: 'browser-e2e' }),
      ]),
      ['build'],
    );
  });
});

describe('reading a refusal the server named', () => {
  it('finds the criterion a binding refusal was about, by id rather than by position', () => {
    // The domain builds `acceptanceCriteria.<criterionId>.verificationCheckId`. Reading it
    // by index would point at whichever row is there after a reorder.
    const named = criterionIdsInRefusal(['acceptanceCriteria.AC2.verificationCheckId']);
    assert.deepEqual(named, [{ criterionId: 'AC2', binding: true }]);
  });

  it('returns nothing for a path it cannot attribute, so the message is not pinned to a wrong row', () => {
    assert.deepEqual(criterionIdsInRefusal(['outcome', 'body', 'acceptanceCriteria[0].description']), []);
  });
});

describe('drafts from stored records', () => {
  it('seeds a new contract with the outcome the owner already wrote', () => {
    // The owner described the change on the New Request step; making them paste it again
    // into the outcome is the retyping this flow is supposed to avoid.
    assert.equal(draftFromRequest({ title: 'Fix the cart', description: 'The cart totals correctly.' }).outcome, 'The cart totals correctly.');
  });

  it('keeps every stored criterion identity when editing a revision', () => {
    const draft = draftFromContract(
      storedContract({
        acceptanceCriteria: [
          { id: 'AC1', description: 'One.', verificationType: 'automated', verificationCheckId: 'build' },
          { id: 'AC7', description: 'Two.', verificationType: 'owner_test', verificationCheckId: null },
        ],
      }),
    );
    assert.deepEqual(draft.acceptanceCriteria.map((entry) => entry.id), ['AC1', 'AC7']);
    assert.deepEqual(draft.acceptanceCriteria.map((entry) => entry.verificationCheckId), ['build', null]);
  });

  it('starts a brand new draft with one unbound automated criterion rather than nothing', () => {
    // A draft with no criteria cannot be saved at all, so an empty one would be a dead end.
    const draft = emptyDraft();
    assert.equal(draft.acceptanceCriteria.length, 1);
    assert.equal(draft.acceptanceCriteria[0]?.verificationType, 'automated');
    assert.equal(draftProblems(draft).approvable, false);
  });
});