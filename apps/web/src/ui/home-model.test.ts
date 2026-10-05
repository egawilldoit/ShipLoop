/**
 * The wording and the mapping Home renders, tested directly.
 *
 * `home-model.ts` holds no React, so these tests can state the properties that matter
 * without a DOM: what a kind is called, where its next action goes, which facts are shown,
 * and - the one this file exists for - that nothing on the board describes an external
 * executor doing something, because ShipLoop has no integration that would prove it.
 *
 * The executor test is written as a list of words rather than as a judgement about tone,
 * so a future label that says "build running" or "62% done" fails here instead of shipping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { HOME_GROUPS, groupEntries, presentEntry, presentFailure } from './home-model.ts';
import { HOME_ENTRY_KINDS, type HomeEntry, type HomeEntryKind, type HomeProjection } from './mvp-client.ts';

const HEAD = '0123456789abcdef0123456789abcdef01234567';

function entry(overrides: Partial<HomeEntry> = {}): HomeEntry {
  return {
    kind: 'DecisionAwaiting',
    requestId: 'req-1',
    title: 'Add a dark mode',
    contractId: 'con-1',
    contractRevision: 2,
    candidateId: 'cand-1',
    headSha: HEAD,
    reason: 'Every criterion is satisfied and no owner decision applies to it.',
    nextAction: 'Accept this candidate, or request changes with what is wrong.',
    outstandingCriterionIds: [],
    ...overrides,
  };
}

function projection(groups: Partial<Record<'needsYou' | 'inProgress' | 'readyForReview', readonly HomeEntry[]>>): HomeProjection {
  return {
    projectId: 'proj-1',
    collectedAt: '2026-02-01T09:00:00.000Z',
    needsYou: groups.needsYou ?? [],
    inProgress: groups.inProgress ?? [],
    readyForReview: groups.readyForReview ?? [],
  };
}

/**
 * Words that would make the board claim ShipLoop can see an external system working.
 *
 * "In progress" is deliberately absent: it is the route's own name for the group of recorded
 * unfinished steps, and the group's explanation states what it does and does not mean. The
 * group title is asserted separately; these are the words that would introduce a claim.
 */
const EXECUTOR_CLAIMS = [
  'running',
  'started',
  'starting',
  'executing',
  'building',
  'working on',
  'in flight',
  'percent',
  '%',
  'eta',
  'agent',
];

test('every documented kind has a label, a tone and a destination', () => {
  for (const kind of HOME_ENTRY_KINDS) {
    const shown = presentEntry(entry({ kind }));
    assert.notEqual(shown.kindLabel, '', `${kind} is labelled`);
    assert.notEqual(shown.tone, undefined, `${kind} has a tone`);
    assert.equal(shown.target, kind.startsWith('Contract') || kind === 'CandidateNotLinked' ? 'new-request' : 'review');
  }
});

test('no label claims an external executor is doing something', () => {
  for (const kind of HOME_ENTRY_KINDS) {
    const shown = presentEntry(entry({ kind }));
    const words = `${shown.kindLabel} ${shown.actionLabel ?? ''}`.toLowerCase();
    for (const claim of EXECUTOR_CLAIMS) {
      assert.equal(words.includes(claim), false, `${kind} label must not claim "${claim}"`);
    }
  }
  for (const group of HOME_GROUPS) {
    const words = `${group.title} ${group.empty}`.toLowerCase();
    for (const claim of EXECUTOR_CLAIMS) {
      assert.equal(words.includes(claim), false, `group ${group.id} must not claim "${claim}"`);
    }
  }
});

test('no result against the current commit is never painted as a pass', () => {
  assert.notEqual(presentEntry(entry({ kind: 'VerificationOutstanding' })).tone, 'healthy');
  assert.notEqual(presentEntry(entry({ kind: 'OwnerTestOutstanding' })).tone, 'healthy');
  assert.notEqual(presentEntry(entry({ kind: 'CandidateNotLinked' })).tone, 'healthy');
});

test('a recorded failure reads as a failure', () => {
  assert.equal(presentEntry(entry({ kind: 'VerificationFailed' })).tone, 'revoked');
  assert.match(presentEntry(entry({ kind: 'VerificationFailed' })).kindLabel, /not a pass/);
});

test('an entry with nothing recorded against it shows only what it has', () => {
  const shown = presentEntry(
    entry({
      kind: 'ContractNotWritten',
      contractId: null,
      contractRevision: null,
      candidateId: null,
      headSha: null,
      outstandingCriterionIds: [],
    }),
  );
  assert.deepEqual(shown.facts, [{ label: 'Request', value: 'req-1', mono: true }]);
});

test('the commit is rendered whole, and the contract revision with it', () => {
  const shown = presentEntry(entry());
  assert.deepEqual(shown.facts, [
    { label: 'Request', value: 'req-1', mono: true },
    { label: 'Contract', value: 'con-1 revision 2', mono: false },
    { label: 'Candidate', value: 'cand-1', mono: true },
    { label: 'Commit', value: HEAD, mono: true },
  ]);
});

test('outstanding criteria are named, not counted', () => {
  const shown = presentEntry(entry({ outstandingCriterionIds: ['c-unit', 'c-owner'] }));
  const fact = shown.facts.find((item) => item.label === 'Outstanding criteria');
  assert.equal(fact?.value, 'c-unit, c-owner');
});

test('a group with nothing in it stays empty', () => {
  const board = projection({});
  for (const group of HOME_GROUPS) {
    assert.deepEqual(groupEntries(board, group.id), []);
    assert.notEqual(group.empty, '', `${group.id} says what empty means`);
  }
});

test('a request in two groups is returned by both, in the order they were sent', () => {
  const ownerTest = entry({ kind: 'OwnerTestOutstanding', outstandingCriterionIds: ['c-owner'] });
  const review = entry({ kind: 'CandidateReadyForReview' });
  const board = projection({ needsYou: [ownerTest], readyForReview: [review] });
  assert.equal(groupEntries(board, 'needsYou').length, 1);
  assert.equal(groupEntries(board, 'readyForReview').length, 1);
  assert.equal(groupEntries(board, 'inProgress').length, 0);
});

test('the three groups are distinct, and their order is the journey', () => {
  assert.deepEqual(
    HOME_GROUPS.map((group) => group.id),
    ['needsYou', 'inProgress', 'readyForReview'],
  );
});

test('a disconnected client, a refusing server and an unreadable response read differently', () => {
  const lost = presentFailure({ code: 'Disconnected', reason: 'The server could not be reached.', serverCode: null });
  const refused = presentFailure({ code: 'Refused', reason: 'No such project.', serverCode: 'NotFound' });
  const odd = presentFailure({ code: 'MalformedResponse', reason: 'A group was missing.', serverCode: null });

  assert.equal(lost.retryable, true);
  assert.equal(refused.retryable, false);
  assert.equal(odd.retryable, false);
  assert.notEqual(lost.heading, refused.heading);
  assert.notEqual(refused.heading, odd.heading);
  assert.equal(refused.detail, 'No such project.');
});

test('an ended session is named as such rather than as a refusal to fix', () => {
  const expired = presentFailure({ code: 'Refused', reason: 'Sign in required.', serverCode: 'Unauthorized' });
  assert.match(expired.heading, /session/i);
  assert.match(expired.detail, /Sign in again/);
});

test('every kind name in the vocabulary is one the layout knows', () => {
  for (const kind of HOME_ENTRY_KINDS) {
    assert.equal(typeof presentEntry(entry({ kind: kind as HomeEntryKind })).kindLabel, 'string');
  }
});