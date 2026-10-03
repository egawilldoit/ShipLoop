/**
 * What the Review surface is willing to say and to enable.
 *
 * Every case below is a claim about the `verified` / `accepted` boundary, which is the invariant
 * this product is most likely to erode by accident: a green set of checks sitting next to an
 * enabled Accept button is how an acceptance starts to read as implied.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptRefusals,
  checkTone,
  criterionTone,
  criterionDetail,
  decisionAvailability,
  decisionTone,
  evidenceMatchesCandidate,
  queueItemSummary,
  reviewCounts,
  reviewHeadline,
} from './review-view.ts';
import type { ReviewDetail } from './wire.ts';

const HEAD = 'a'.repeat(40);

function detail(overrides: Partial<ReviewDetail> = {}): ReviewDetail {
  return {
    candidateId: 'cnd_1',
    requestId: 'req_1',
    requestTitle: 'Add a search box',
    contractId: 'ctc_1',
    contractRevision: 2,
    repository: 'owner/name',
    pullRequestNumber: 7,
    pullRequestUrl: null,
    baseBranch: 'main',
    headSha: HEAD,
    observedAt: '2026-01-02T00:00:00.000Z',
    verification: { complete: true, outstanding: [] },
    decision: null,
    staleReasons: [],
    checks: [],
    criteria: [],
    pendingOwnerTestCriterionIds: [],
    ...overrides,
  };
}

test('a fully verified candidate may be accepted', () => {
  const availability = decisionAvailability(detail());
  assert.equal(availability.canAccept, true);
  assert.deepEqual([...availability.acceptRefusals], []);
});

test('Accept is refused while verification is unfinished, and the refusal names what is outstanding', () => {
  const availability = decisionAvailability(
    detail({ verification: { complete: false, outstanding: ['criterion-2'] } }),
  );
  assert.equal(availability.canAccept, false);
  assert.match(availability.acceptRefusals.join(' '), /criterion-2/);
});

test('Accept is refused when the server reported no verification at all', () => {
  const refusals = acceptRefusals(detail({ verification: null }));
  assert.match(refusals.join(' '), /No verification has been recorded/i);
});

test('Accept is refused on a stale review, and the stale reasons are shown', () => {
  const refusals = acceptRefusals(detail({ staleReasons: ['the head commit moved'] }));
  assert.match(refusals.join(' '), /the head commit moved/);
});

test('Accept is refused once a decision exists, and says which kind', () => {
  const accepted = detail({
    decision: { decisionId: 'dec_1', kind: 'accepted', decidedAt: '2026-01-03T00:00:00.000Z', headSha: HEAD, contractRevision: 2, feedback: null },
  });
  assert.match(acceptRefusals(accepted).join(' '), /already accepted/i);
  const changes = detail({
    decision: { decisionId: 'dec_2', kind: 'changes_requested', decidedAt: '2026-01-03T00:00:00.000Z', headSha: HEAD, contractRevision: 2, feedback: 'nope' },
  });
  assert.match(acceptRefusals(changes).join(' '), /already requested/i);
});

// Requesting changes must never be gated by the server's opinion of readiness.
test('changes can always be requested, even on a fully verified candidate', () => {
  assert.equal(decisionAvailability(detail()).canRequestChanges, true);
  assert.equal(decisionAvailability(detail({ staleReasons: ['moved'] })).canRequestChanges, true);
});

test('the headline says verification recorded, not accepted', () => {
  assert.equal(reviewHeadline(detail()), 'Verification recorded — your decision is outstanding');
  assert.equal(reviewHeadline(detail({ staleReasons: ['moved'] })), 'Stale — this review no longer describes the commit below');
  assert.equal(reviewHeadline(detail({ verification: null })), 'Verification is not finished');
});

// `agent completed` is NOT `verified`: an unrun check must not read like a passing one.
test('an unrun check and a failing check are different tones', () => {
  assert.notEqual(checkTone('Missing'), checkTone('Failed'));
  assert.equal(checkTone('Passed'), 'healthy');
  assert.equal(checkTone('NotApplicable'), 'unconfigured');
  assert.equal(checkTone('Something the server invented'), 'neutral');
});

test('a criterion with no evidence reads as pending, not as met', () => {
  assert.notEqual(criterionTone('Pending'), criterionTone('Met'));
  assert.equal(criterionTone('Unmet'), 'revoked');
});

test('only an acceptance reads as healthy among the decisions', () => {
  assert.equal(decisionTone('accepted'), 'healthy');
  assert.equal(decisionTone('changes_requested'), 'degraded');
  assert.equal(decisionTone(null), 'neutral');
});

test('a criterion with no evidence says so, and distinguishes waiting on the owner', () => {
  const automated = criterionDetail({
    id: 'c1',
    description: 'x',
    verificationType: 'automated',
    status: 'Pending',
    detail: null,
    evidence: null,
    pendingOwnerTest: false,
  });
  assert.match(automated, /No evidence has been recorded/i);
  const owner = criterionDetail({
    id: 'c2',
    description: 'x',
    verificationType: 'owner_test',
    status: 'Pending',
    detail: null,
    evidence: null,
    pendingOwnerTest: true,
  });
  assert.match(owner, /Waiting on your own test/i);
});

// Evidence recorded for SHA A can never prove SHA B, and the surface has to be able to say so.
test('evidence is only matched when it names the commit on screen', () => {
  const forThisCommit = {
    id: 'c1',
    description: 'x',
    verificationType: 'automated' as const,
    status: 'Met',
    detail: null,
    evidence: { evidenceId: 'ev_1', method: 'check:build', result: 'passed', observedAt: 'now', contractRevision: 2, candidateHeadSha: HEAD },
    pendingOwnerTest: false,
  };
  assert.equal(evidenceMatchesCandidate(forThisCommit, HEAD), true);
  assert.equal(evidenceMatchesCandidate({ ...forThisCommit, evidence: { ...forThisCommit.evidence!, candidateHeadSha: 'b'.repeat(40) } }, HEAD), false);
  assert.equal(evidenceMatchesCandidate({ ...forThisCommit, evidence: null }, HEAD), false);
});

test('counts separate failing checks, verified criteria and pending owner tests', () => {
  const counts = reviewCounts(
    detail({
      checks: [
        { checkId: 'build', name: 'build', required: true, result: 'Passed', detail: null, observedAt: null },
        { checkId: 'test', name: 'test', required: true, result: 'Failed', detail: null, observedAt: null },
      ],
      criteria: [
        {
          id: 'c1',
          description: 'x',
          verificationType: 'automated',
          status: 'Met',
          detail: null,
          evidence: { evidenceId: 'ev_1', method: 'check:build', result: 'passed', observedAt: 'now', contractRevision: 2, candidateHeadSha: HEAD },
          pendingOwnerTest: false,
        },
        { id: 'c2', description: 'y', verificationType: 'owner_test', status: 'Pending', detail: null, evidence: null, pendingOwnerTest: true },
      ],
      pendingOwnerTestCriterionIds: ['c2'],
    }),
  );
  assert.equal(counts.checksFailing, 1);
  assert.equal(counts.criteriaVerified, 1);
  assert.equal(counts.criteriaTotal, 2);
  assert.equal(counts.pendingOwnerTests, 1);
});

test('a queue row states the revision, the commit and the verification, so a list is readable', () => {
  const summary = queueItemSummary(detail());
  assert.match(summary, /contract revision 2/);
  assert.match(summary, new RegExp(HEAD));
  assert.match(summary, /verification recorded/);
});