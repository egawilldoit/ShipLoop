/**
 * The client's read boundary, tested without a server standing in for it.
 *
 * Every assertion here is about a claim the board must not be able to make. `mvp-client.ts`
 * is the only place an HTTP response becomes a typed value, so this file is where a payload
 * that would put a false statement in front of the owner is refused:
 *
 *   - a project identity that is neither a real `Selected` nor the stated
 *     `NoProjectSelected` (the historical `undefined` project, F02-AC1, F02-AC4);
 *   - a candidate commit that is not the full 40 characters, because an abbreviated SHA
 *     displayed as the identity of the code under review is the wrong answer this boundary
 *     exists to make unreachable (F17-AC2, F25-AC3);
 *   - a group that is missing rather than empty, which the route never sends and which must
 *     never be rendered as "nothing needs you" (F20-AC1);
 *   - a request that appears in two groups at once, which F24-AC3 makes a true statement
 *     rather than a duplicate to remove (F24-AC3).
 *
 * The refusal is asserted as a refusal: no test accepts a half-populated projection, because
 * that is the only shape of this failure the owner cannot see.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOME_ENTRY_KINDS,
  parseActiveProject,
  parseHomeEntry,
  parseHomeProjection,
  parseSessionOwner,
} from './mvp-client.ts';

const HEAD = 'a'.repeat(40);

/** One entry as `routes/home.ts` sends it, with the named fields overridden. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'DecisionAwaiting',
    requestId: 'req-1',
    title: 'Add a dark mode',
    contractId: 'con-1',
    contractRevision: 2,
    candidateId: 'cand-1',
    headSha: HEAD,
    reason: 'Every criterion is satisfied and no decision applies to it.',
    nextAction: 'Accept this candidate, or request changes with what is wrong.',
    outstandingCriterionIds: [],
    ...overrides,
  };
}

function board(groups: Record<string, unknown>): unknown {
  return { home: { projectId: 'proj-1', collectedAt: '2026-02-01T09:00:00.000Z', ...groups } };
}

test('a selected project is read as the server named it', () => {
  const result = parseActiveProject({
    state: 'Selected',
    activeProjectId: 'shiploop',
    activeProjectName: 'ShipLoop',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, {
    state: 'Selected',
    activeProjectId: 'shiploop',
    activeProjectName: 'ShipLoop',
  });
});

test('no project selected is a state with a count, not a blank field', () => {
  const result = parseActiveProject({ state: 'NoProjectSelected', selectableProjectCount: 3 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, { state: 'NoProjectSelected', selectableProjectCount: 3 });
});

test('a project state this client does not know is refused rather than treated as none selected', () => {
  const result = parseActiveProject({ state: 'Guessed', activeProjectId: 'shiploop' });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error.code, 'MalformedResponse');
});

test('a Selected project with no id is refused, because a blank id becomes /api/projects//', () => {
  const result = parseActiveProject({ state: 'Selected', activeProjectName: 'ShipLoop' });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error.code, 'MalformedResponse');
});

test('an owner with no sign-in address is read with a null address rather than an empty one', () => {
  const result = parseSessionOwner({
    ownerId: 'own-1',
    displayName: 'Ada',
    email: null,
    activeProject: { state: 'NoProjectSelected', selectableProjectCount: 0 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.email : 'unread', null);
});

test('an owner block with no project state is refused', () => {
  const result = parseSessionOwner({ ownerId: 'own-1', displayName: 'Ada', email: 'ada@example.test' });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error.code, 'MalformedResponse');
});

test('the full 40-character commit is the identity, and it is kept whole', () => {
  const result = parseHomeEntry(entry());
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.headSha : null, HEAD);
});

test('an abbreviated commit is refused rather than displayed as the code under review', () => {
  const result = parseHomeEntry(entry({ headSha: HEAD.slice(0, 7) }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error.reason, /40-character/);
});

test('a branch name in the commit field is refused', () => {
  const result = parseHomeEntry(entry({ headSha: 'feature/dark-mode' }));
  assert.equal(result.ok, false);
});

test('an entry with no candidate names no commit, which is a true statement', () => {
  const result = parseHomeEntry(
    entry({ kind: 'ContractNotWritten', candidateId: null, contractId: null, contractRevision: null, headSha: null }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.headSha : 'unread', null);
});

test('a reason outside the closed vocabulary is refused rather than rendered under a guess', () => {
  for (const kind of HOME_ENTRY_KINDS) {
    assert.equal(parseHomeEntry(entry({ kind })).ok, true, `${kind} is a documented kind`);
  }
  const result = parseHomeEntry(entry({ kind: 'AgentRunning' }));
  assert.equal(result.ok, false);
});

test('three empty groups are a valid answer and stay empty', () => {
  const result = parseHomeProjection(board({ needsYou: [], inProgress: [], readyForReview: [] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value.needsYou : null, []);
  assert.deepEqual(result.ok ? result.value.inProgress : null, []);
  assert.deepEqual(result.ok ? result.value.readyForReview : null, []);
});

test('a missing group is refused, because rendering it empty would claim nothing needs you', () => {
  const result = parseHomeProjection(board({ inProgress: [], readyForReview: [] }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error.reason, /left out/);
});

test('a request in both Needs You and Ready For Review is kept in both', () => {
  const ownerTest = entry({ kind: 'OwnerTestOutstanding', outstandingCriterionIds: ['c-owner'] });
  const review = entry({ kind: 'CandidateReadyForReview', outstandingCriterionIds: ['c-owner'] });
  const result = parseHomeProjection(board({ needsYou: [ownerTest], inProgress: [], readyForReview: [review] }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.needsYou.length, 1);
  assert.equal(result.value.readyForReview.length, 1);
  assert.equal(result.value.needsYou[0]?.requestId, result.value.readyForReview[0]?.requestId);
  assert.deepEqual(result.value.readyForReview[0]?.outstandingCriterionIds, ['c-owner']);
});

test('a group is not silently reordered or deduplicated by this client', () => {
  const first = entry({ requestId: 'req-1' });
  const second = entry({ requestId: 'req-2', kind: 'ContractNotWritten', candidateId: null, headSha: null });
  const result = parseHomeProjection(board({ needsYou: [first, second], inProgress: [], readyForReview: [] }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.value.needsYou.map((item) => item.requestId),
    ['req-1', 'req-2'],
  );
});

test('outstanding criteria that are not strings are refused rather than shortened', () => {
  const result = parseHomeEntry(entry({ outstandingCriterionIds: ['c-unit', 7] }));
  assert.equal(result.ok, false);
});

test('a response that is not the documented envelope is refused', () => {
  assert.equal(parseHomeProjection({ home: 'nothing here' }).ok, false);
  assert.equal(parseHomeProjection({ board: {} }).ok, false);
  assert.equal(parseHomeProjection(null).ok, false);
});