/**
 * The Home grouping rules, which are the only thing separating "waiting on you" from "waiting on
 * evidence" from "ready for a decision".
 *
 * The tests below are written as claims about what the product may assert rather than as coverage
 * of the branches, because the branches are not the risk. The risk is a bucket whose name promises
 * more than its contents can support, and each case below pins one of those promises.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupHomeItems, homeGroupFor, homeGroupReason, HOME_GROUPS } from './home.ts';
import type { HomeItem } from './wire.ts';

function item(overrides: Partial<HomeItem> = {}): HomeItem {
  return {
    requestId: 'req_1',
    title: 'Add a search box to the runs list',
    updatedAt: '2026-01-02T03:04:05.000Z',
    contract: { id: 'ctc_1', revision: 1, status: 'draft' },
    candidate: null,
    verification: null,
    decision: null,
    nextAction: 'Approve the contract.',
    ...overrides,
  };
}

const approved = { id: 'ctc_1', revision: 2, status: 'approved' } as const;
const candidate = { id: 'cnd_1', headSha: 'a'.repeat(40), pullRequestNumber: 7, pullRequestUrl: null } as const;

test('a request with no contract is something only the owner can do next', () => {
  assert.equal(homeGroupFor(item({ contract: null })), 'needs_you');
});

test('an unapproved draft is something only the owner can do next', () => {
  assert.equal(homeGroupFor(item({ contract: { id: 'ctc_1', revision: 1, status: 'draft' } })), 'needs_you');
});

test('a stale revision is something only the owner can do next', () => {
  assert.equal(homeGroupFor(item({ contract: { id: 'ctc_1', revision: 3, status: 'stale' } })), 'needs_you');
});

// The one the whole file exists for. An approved contract with no candidate looks exactly like an
// external agent mid-edit, and ShipLoop observes nothing about the latter. Putting it in a
// progress bucket would report a fact nobody observed.
test('an approved contract with no linked candidate is NOT reported as in progress', () => {
  const handoff = item({ contract: approved, candidate: null, verification: null });
  assert.equal(homeGroupFor(handoff), 'needs_you');
  assert.match(homeGroupReason(handoff), /no pull request implements it yet/i);
});

test('a linked candidate with no verification recorded is not ready for review', () => {
  const unverified = item({ contract: approved, candidate, verification: null });
  assert.equal(homeGroupFor(unverified), 'in_progress');
  assert.match(homeGroupReason(unverified), /No verification has been recorded/i);
});

test('a linked candidate with incomplete verification is in progress and names what is outstanding', () => {
  const partial = item({ contract: approved, candidate, verification: { complete: false, outstanding: ['criterion 1'] } });
  assert.equal(homeGroupFor(partial), 'in_progress');
  assert.match(homeGroupReason(partial), /criterion 1/);
});

// `verified` is not `accepted`: this group is a queue for a decision, never a decision itself.
test('a fully verified candidate is ready for review, which is not a decision', () => {
  const complete = item({ contract: approved, candidate, verification: { complete: true, outstanding: [] } });
  assert.equal(homeGroupFor(complete), 'ready_for_review');
  assert.match(homeGroupReason(complete), /nothing is outstanding/i);
});

test('an accepted candidate is settled and is counted rather than listed', () => {
  const accepted = item({
    contract: approved,
    candidate,
    verification: { complete: true, outstanding: [] },
    decision: {
      decisionId: 'dec_1',
      kind: 'accepted',
      decidedAt: '2026-01-03T00:00:00.000Z',
      headSha: candidate.headSha,
      contractRevision: 2,
      feedback: null,
    },
  });
  const grouped = groupHomeItems([accepted]);
  assert.equal(homeGroupFor(accepted), 'settled');
  assert.equal(grouped.settledCount, 1);
  assert.deepEqual(grouped.groups.map((group) => group.items.length), [0, 0, 0]);
});

test('changes requested puts a candidate back with the owner rather than in progress', () => {
  const changes = item({
    contract: approved,
    candidate,
    verification: { complete: true, outstanding: [] },
    decision: {
      decisionId: 'dec_2',
      kind: 'changes_requested',
      decidedAt: '2026-01-03T00:00:00.000Z',
      headSha: candidate.headSha,
      contractRevision: 2,
      feedback: 'The search ignores the run name.',
    },
  });
  assert.equal(homeGroupFor(changes), 'needs_you');
});

// A bucket with nothing in it is information. Hiding a group would leave the owner unable to tell
// "nothing is waiting on you" from a view that had not loaded.
test('every group is returned even when every item belongs to another group', () => {
  const grouped = groupHomeItems([item({ contract: approved, candidate, verification: { complete: true, outstanding: [] } })]);
  assert.deepEqual(grouped.groups.map((group) => group.id), ['needs_you', 'in_progress', 'ready_for_review']);
  assert.deepEqual(grouped.groups.map((group) => group.items.length), [0, 0, 1]);
  assert.deepEqual(HOME_GROUPS.map((group) => group.id), ['needs_you', 'in_progress', 'ready_for_review']);
});

test('an empty board yields three empty groups and no settled count', () => {
  const grouped = groupHomeItems([]);
  assert.equal(grouped.settledCount, 0);
  assert.deepEqual(grouped.groups.map((group) => group.items.length), [0, 0, 0]);
});

test('every group states why an item can be in it, so progress is never asserted without a fact', () => {
  for (const group of HOME_GROUPS) {
    assert.ok(group.meaning.length > 0, `${group.id} has no meaning`);
  }
  const inProgress = HOME_GROUPS.find((group) => group.id === 'in_progress');
  assert.match(inProgress?.meaning ?? '', /ShipLoop is not running anything/i);
});