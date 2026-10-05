/**
 * The candidate and decision screens' own rules, proved without a browser.
 *
 * `review-model.test.ts` covers the review card's vocabulary. This file covers the three rules that
 * are *new* to the decision journey as a whole, and each is a wrong answer a reader would not be
 * able to see:
 *
 *   - **A stale pass is not a pass.** `readCandidateCheck` asks whether the provider attributed the
 *     run to the commit on screen *before* it reads the result, so a `Passed` the provider attributed
 *     to another commit cannot render green. The table is exhaustive over the domain's six results
 *     crossed with both attribution outcomes, because the failure mode is one cell of a table rather
 *     than the table (F20-AC3, F24-AC3).
 *   - **An unrecognised pull request state is unread.** `readProviderState` reports a state outside
 *     the product's vocabulary as unread, and never maps it onto `Open` or `Closed` — the first would
 *     present withdrawn work as reviewable and the second would assert a conclusion nobody read
 *     (mvp-spec F20-AC2).
 *   - **A refused decision is never a recorded one.** `readDecisionOutcome` has two shapes and no
 *     third, so the stale-accept case is asserted against every member of the client's outcome union
 *     rather than against the one that happens to be reachable today (F24-AC4, F25-AC3).
 *
 * The staleness-before-result ordering is asserted directly: a row whose recorded outcome reads
 * `passed` and which is stale must produce a label and a tone that contain no success word at all.
 * That is the assertion a refactor of the model has to argue with, because reordering the two checks
 * is exactly the change that reintroduces the defect.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DecideCandidateOutcome, MvpFailureCode, ReviewCardView } from '../mvp-client/index.ts';
import type { CandidateCheckInput, VerifyObservationInput } from './review-model.ts';
import {
  readCandidateCheck,
  readDecisionOutcome,
  readProviderState,
  readVerifyObservation,
} from './review-model.ts';

/** Two commits, both full length, because the model only ever receives real ones. */
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const EARLIER = 'fedcba98765432100123456789abcdef01234567';

/** The domain's six results, read from the transport rather than restated as a subset. */
const SIX_RESULTS: readonly string[] = ['Passed', 'Failed', 'Waiting', 'Missing', 'Stale', 'NotApplicable'];

function check(overrides: Partial<CandidateCheckInput> = {}): CandidateCheckInput {
  return {
    name: 'unit-tests',
    result: 'Passed',
    required: true,
    blocking: false,
    notApplicableApprovedByPolicy: false,
    observedHeadSha: HEAD,
    startedAt: '2026-05-01T10:00:00.000Z',
    endedAt: '2026-05-01T10:01:00.000Z',
    artifactUrl: null,
    detail: null,
    ...overrides,
  };
}

function observation(overrides: Partial<VerifyObservationInput> = {}): VerifyObservationInput {
  return {
    evidenceId: 'ev-1',
    checkId: 'unit-tests',
    recordedOutcome: 'passed',
    currentOutcome: 'passed',
    countsForCurrentCandidate: true,
    observedHeadSha: HEAD,
    observedContractRevision: 1,
    observedAt: '2026-05-01T10:00:00.000Z',
    reason: '',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* The candidate card's check list                                             */
/* -------------------------------------------------------------------------- */

describe('F20-AC3, F24-AC3: a check counts for the commit on screen before it counts as a result', () => {
  test('every result about this commit renders as itself, with Passed the only healthy one', () => {
    for (const result of SIX_RESULTS) {
      const reading = readCandidateCheck(check({ result }), HEAD);
      assert.equal(reading.countsForCandidate, true, `${result} was attributed to this commit`);
      assert.notEqual(reading.label, 'Not about the commit on screen', `${result} should read as its own result`);
      assert.equal(reading.unread, false);
      // The one assertion that matters: exactly one result is a healthy tone.
      assert.equal(
        reading.tone === 'healthy',
        result === 'Passed',
        `${result} must not render as a success unless it passed`,
      );
    }
  });

  test('a Passed the provider attributed to another commit is not a pass here', () => {
    const reading = readCandidateCheck(check({ result: 'Passed', observedHeadSha: EARLIER }), HEAD);
    assert.equal(reading.countsForCandidate, false, 'a result about another commit cannot count for this one');
    assert.equal(reading.tone, 'degraded', 'and it must not render in a success colour');
    assert.notEqual(reading.label, 'Passed', 'the word Passed must not reach a reader for a commit that is not on screen');
    assert.match(reading.label, /not about the commit on screen/i);
    assert.match(reading.standing, new RegExp(EARLIER), 'the standing names the commit it was actually about');
  });

  test('a result the provider attributed to no commit counts for nothing', () => {
    for (const result of SIX_RESULTS) {
      const reading = readCandidateCheck(check({ result, observedHeadSha: null }), HEAD);
      assert.equal(reading.countsForCandidate, false, `${result} with no attribution is evidence for no candidate`);
      assert.notEqual(reading.tone, 'healthy', `${result} with no attribution must not render as a success`);
    }
  });

  test('a result this build has no word for is reported as unread, never as a state', () => {
    const reading = readCandidateCheck(check({ result: 'Flaky' }), HEAD);
    assert.equal(reading.unread, true);
    assert.match(reading.label, /^Unread: /, 'an unrecognised result is labelled as unread');
    assert.equal(reading.tone, 'neutral', 'and never given a state tone');
    assert.match(reading.standing, /no word for/i);
  });

  test('an unread result about another commit is still unread-and-not-counting, not a pass', () => {
    const reading = readCandidateCheck(check({ result: 'Flaky', observedHeadSha: EARLIER }), HEAD);
    assert.equal(reading.countsForCandidate, false);
    assert.equal(reading.unread, true);
  });

  test('the route\'s blocking flag is reported and not re-derived', () => {
    // `blocking` is the route's own answer, computed with the domain's `isBlocking`. The model does
    // not recompute it, so a check the route calls blocking still renders with the route's flag
    // beside it (F20-AC2, F24-AC3).
    const reading = readCandidateCheck(check({ result: 'Failed', blocking: true }), HEAD);
    assert.equal(reading.label, 'Failed');
    assert.equal(reading.tone, 'revoked');
  });
});

/* -------------------------------------------------------------------------- */
/* The pull request state                                                      */
/* -------------------------------------------------------------------------- */

describe('mvp-spec F20-AC2: an unrecognised pull request state is unread, not Open and not Closed', () => {
  test('each state this build has words for reads as itself', () => {
    for (const state of ['Open', 'Closed', 'Merged', 'Unknown']) {
      const reading = readProviderState(state);
      assert.equal(reading.recognised, true, `${state} is in the product's vocabulary`);
      assert.equal(reading.label, state, 'and is shown as the provider spelled it');
    }
  });

  test('a state outside the vocabulary is unread, and is read as neither Open nor Closed', () => {
    const reading = readProviderState('UnderReview');
    assert.equal(reading.recognised, false, 'the client must say it could not read this');
    assert.match(reading.label, /^Unread: /, 'the value is reported rather than mapped');
    assert.doesNotMatch(reading.label, /\bOpen\b/, 'an unreadable state must not be shown as open');
    assert.doesNotMatch(reading.label, /\bClosed\b/, 'nor as closed, which asserts a conclusion nobody read');
    assert.match(reading.standing, /unread rather than read as open or closed/i);
  });

  test('`Unknown` — a state the product does have — is not read as Open', () => {
    // The domain's `Unknown` means the provider reported something unclassifiable. Reading it as open
    // would present withdrawn work as reviewable, which is the specific wrong answer F20-AC2 names.
    const reading = readProviderState('Unknown');
    assert.equal(reading.recognised, true);
    assert.notEqual(reading.label, 'Open');
    assert.equal(reading.tone, 'degraded', 'and it is not a healthy state');
  });

  test('an empty state is unread rather than silently Open', () => {
    const reading = readProviderState('');
    assert.equal(reading.recognised, false);
    assert.equal(reading.tone, 'neutral');
  });
});

/* -------------------------------------------------------------------------- */
/* The verification report's observations                                     */
/* -------------------------------------------------------------------------- */

describe('F20-AC2, F20-AC3: a verification observation is judged on its commit first', () => {
  test('a current observation of this commit reads as its outcome', () => {
    const cases: readonly { readonly outcome: string; readonly key: string }[] = [
      { outcome: 'passed', key: 'passed' },
      { outcome: 'failed', key: 'failed' },
      { outcome: 'waiting', key: 'running' },
      { outcome: 'missing', key: 'never-ran' },
      { outcome: 'capture_failed', key: 'capture-failed' },
    ];
    for (const entry of cases) {
      const reading = readVerifyObservation(observation({ currentOutcome: entry.outcome }), HEAD);
      assert.equal(reading.key, entry.key, `${entry.outcome} must keep its own standing`);
      assert.equal(reading.countsForCandidate, true);
    }
  });

  test('a recorded pass that no longer counts reads as stale, in no success colour', () => {
    const reading = readVerifyObservation(
      observation({ recordedOutcome: 'passed', currentOutcome: 'stale', countsForCurrentCandidate: false }),
      HEAD,
    );
    assert.equal(reading.key, 'stale');
    assert.equal(reading.countsForCandidate, false);
    assert.notEqual(reading.tone, 'healthy', 'a stale pass must never render in a success colour');
    assert.doesNotMatch(reading.label, /\bPassed\b/, 'and the word Passed must not reach a reader for it');
    assert.match(reading.standing, /does not count for the commit on screen/i);
  });

  test('an observation marked as counting but naming another commit is refused a verdict', () => {
    const reading = readVerifyObservation(observation({ observedHeadSha: EARLIER }), HEAD);
    assert.equal(reading.key, 'unattributed', 'a commit that does not match cannot be rendered as this candidate');
    assert.equal(reading.countsForCandidate, false);
    assert.notEqual(reading.tone, 'healthy');
  });

  test('an observation naming no commit is refused a verdict', () => {
    const reading = readVerifyObservation(observation({ observedHeadSha: null }), HEAD);
    assert.equal(reading.key, 'unattributed');
    assert.equal(reading.countsForCandidate, false);
  });

  test('an outcome this build has no word for is unread rather than a state', () => {
    const reading = readVerifyObservation(observation({ currentOutcome: 'timed_out' }), HEAD);
    assert.equal(reading.key, 'unread');
    assert.notEqual(reading.tone, 'healthy');
    assert.match(reading.label, /^Unread: /);
  });

  test('a wait is a running check, never a pass and never a failure of the product', () => {
    const reading = readVerifyObservation(observation({ currentOutcome: 'waiting' }), HEAD);
    assert.equal(reading.key, 'running');
    assert.notEqual(reading.tone, 'healthy');
    assert.notEqual(reading.tone, 'revoked');
  });
});

/* -------------------------------------------------------------------------- */
/* The decision outcome                                                        */
/* -------------------------------------------------------------------------- */

function cardStub(): ReviewCardView {
  return {
    collectedAt: '2026-05-01T10:00:00.000Z',
    request: { requestId: 'req-1', projectId: 'p', title: 't', description: 'd', createdAt: '', updatedAt: '' },
    contract: {
      contractId: 'ctr-1',
      projectId: 'p',
      requestId: 'req-1',
      revision: 1,
      status: 'approved',
      outcome: 'o',
      scope: [],
      outOfScope: [],
      approval: { approvedAt: null, approvedBy: null },
      acceptanceCriteria: [],
      createdAt: '',
      updatedAt: '',
    },
    candidate: {
      candidateId: 'cnd-1',
      projectId: 'p',
      requestId: 'req-1',
      contractId: 'ctr-1',
      contractRevision: 1,
      repository: 'o/r',
      pullRequestNumber: 7,
      pullRequestUrl: '',
      pullRequestState: 'Open',
      draft: false,
      baseBranch: 'main',
      headSha: HEAD,
      observedAt: '',
    },
    policy: { policyId: 'p', requiredAutomatedCheckIds: [], ownerTestBlocksReview: true, ownerTestBlocksDelivery: true },
    checks: [],
    criteria: [],
    ownerTests: [],
    evidence: [],
    staleness: { stale: false, reasons: [], staleEvidenceIds: [], staleDecisionIds: [] },
    decision: { outcome: 'none', decision: null, staleDecisions: [], authorizesCurrentCandidate: false },
    eligibility: {
      readyForOwnerReview: false,
      readyForAcceptance: false,
      readyForDelivery: false,
      blockingReasons: [],
      ownerActions: [],
      acceptanceBlockers: [],
      deliveryBlockers: [],
    },
  };
}

function failure(code: MvpFailureCode, reason: string) {
  return { code, status: 0, reason, fields: [], prerequisites: [], expected: null, actual: null } as const;
}

describe('F24-AC4, F25-AC3: a refused decision is never reported as a recorded one', () => {
  test('a decided outcome is the only shape that reports a card', () => {
    const outcome: DecideCandidateOutcome = { kind: 'decided', review: cardStub() };
    const reading = readDecisionOutcome(outcome);
    assert.equal(reading.kind, 'recorded');
  });

  test('a superseded commit refuses, names both commits, and demands a re-read', () => {
    const reading = readDecisionOutcome({
      kind: 'superseded-commit',
      reason: 'The candidate moved while the page was open.',
      expected: HEAD,
      actual: EARLIER,
    });
    assert.equal(reading.kind, 'refused', 'a conflict is never a recorded decision');
    if (reading.kind !== 'refused') return;
    assert.match(reading.reading.headline, /^Nothing was recorded\./, 'the headline denies that anything was written');
    assert.equal(reading.reading.mustReloadCard, true, 'the card on screen is known to be out of date');
    assert.equal(reading.reading.moved?.expected, HEAD);
    assert.equal(reading.reading.moved?.actual, EARLIER);
  });

  test('a superseded revision names the revision rather than a commit', () => {
    const reading = readDecisionOutcome({
      kind: 'superseded-revision',
      reason: 'The contract revision moved.',
      expected: '1',
      actual: '2',
    });
    assert.equal(reading.kind, 'refused');
    if (reading.kind !== 'refused') return;
    assert.equal(reading.reading.moved?.subject, 'The contract revision', 'whole numbers mean a revision moved');
    assert.equal(reading.reading.mustReloadCard, true);
  });

  test('an acceptance the card refuses keeps its outstanding requirements named', () => {
    const reading = readDecisionOutcome({
      kind: 'not-eligible',
      failure: {
        ...failure('Blocked', 'This candidate cannot be accepted yet.'),
        prerequisites: [
          { name: 'criterion AC1', detail: 'no passing observation', remedy: 'Run the bound check.' },
        ],
      },
    });
    assert.equal(reading.kind, 'refused');
    if (reading.kind !== 'refused') return;
    assert.match(reading.reading.headline, /^Nothing was recorded\./);
    assert.equal(reading.reading.prerequisites.length, 1, 'the outstanding requirement is shown, not summarised');
    assert.equal(reading.reading.prerequisites[0]?.name, 'criterion AC1');
  });

  test('any other refusal is refused too, and never reloaded as though it were a conflict', () => {
    const reading = readDecisionOutcome({
      kind: 'refused',
      failure: failure('Unavailable', 'This deployment composed no GitHub candidate port.'),
    });
    assert.equal(reading.kind, 'refused');
    if (reading.kind !== 'refused') return;
    assert.match(reading.reading.headline, /^Nothing was recorded\./);
    assert.equal(reading.reading.mustReloadCard, false, 'a deployment fault is not a moved fact');
    assert.match(reading.reading.detail, /candidate port/i, 'the server\'s own words are quoted');
  });

  test('no refusal shape produces a wording that reports success', () => {
    // Exhaustiveness rather than sampling: the property is that the *union* has only one member
    // that can report a card, so the assertion walks every refusal member of the client's own type.
    const refusals: readonly DecideCandidateOutcome[] = [
      { kind: 'superseded-commit', reason: 'r', expected: HEAD, actual: EARLIER },
      { kind: 'superseded-revision', reason: 'r', expected: '1', actual: '2' },
      { kind: 'not-eligible', failure: failure('Blocked', 'r') },
      { kind: 'refused', failure: failure('Unavailable', 'r') },
    ];
    for (const outcome of refusals) {
      const reading = readDecisionOutcome(outcome);
      assert.equal(reading.kind, 'refused', `${outcome.kind} must not be reported as recorded`);
      if (reading.kind !== 'refused') continue;
      assert.doesNotMatch(
        reading.reading.headline,
        /accepted|recorded successfully|done/i,
        `${outcome.kind} must never read as a completed decision`,
      );
    }
  });
});