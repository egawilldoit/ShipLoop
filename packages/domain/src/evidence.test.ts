import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fingerprint } from './fingerprint.ts';
import {
  CHECK_RESULTS,
  acceptanceReady,
  classifyFailure,
  deliveryEligible,
  isBlocking,
  isTerminalSuccess,
  type CheckRecord,
  type CheckResult,
  type CriterionEvidence,
  type CriterionVerificationMethod,
  type CriterionStatus,
} from './evidence.ts';

/**
 * The honesty guarantee lives here: a required check that never ran is not a
 * pass, a base failure does not waive a required gate, and a stale candidate
 * cannot inherit another candidate's evidence or acceptance.
 */

const CANDIDATE = fingerprint({ candidate: 'current' });
const PREVIOUS_CANDIDATE = fingerprint({ candidate: 'previous' });
const SCOPE = fingerprint({ scope: 'v3' });

function checkRecord(overrides: Partial<CheckRecord> = {}): CheckRecord {
  return {
    checkId: 'chk_verify_app',
    name: 'pnpm verify:app',
    origin: 'LocalCheck',
    required: true,
    result: 'Passed',
    candidateFingerprint: CANDIDATE,
    startedAt: '2026-03-04T09:00:00.000Z',
    endedAt: '2026-03-04T09:12:00.000Z',
    exitCode: 0,
    artifactRef: 'artifacts/verify-app.json',
    detail: null,
    notApplicableApprovedByPolicy: false,
    ...overrides,
  };
}

function criterion(method: CriterionVerificationMethod, status: CriterionStatus): CriterionEvidence {
  return {
    criterionId: 'F24-AC2',
    method,
    status,
    evidenceId: status === 'Verified' ? 'ev_42' : null,
    candidateFingerprint: CANDIDATE,
    scopeFingerprint: SCOPE,
    observedAt: status === 'Verified' ? '2026-03-04T10:00:00.000Z' : null,
  };
}

function deliverFor(checks: readonly CheckRecord[], acceptanceCandidateFingerprint = CANDIDATE): ReturnType<
  typeof deliveryEligible
> {
  return deliveryEligible({
    checks,
    acceptance: 'Accepted',
    acceptanceCandidateFingerprint,
    currentCandidateFingerprint: CANDIDATE,
  });
}

const OWNER_TEST: CriterionVerificationMethod = { kind: 'OwnerTest', instructions: 'Open the review card and accept.' };
const AUTOMATED: CriterionVerificationMethod = { kind: 'AutomatedCheck', checkId: 'chk_verify_app' };

describe('F20-AC2 check result classification', () => {
  test('isTerminalSuccess is true only for Passed, never for any other recorded result', () => {
    for (const result of CHECK_RESULTS) {
      assert.equal(isTerminalSuccess(result), result === 'Passed', `${result} must not be a terminal success`);
    }
  });

  test('isBlocking is true for Failed, Missing and Stale and false for Passed and NotApplicable', () => {
    assert.equal(isBlocking('Failed'), true);
    assert.equal(isBlocking('Missing'), true);
    assert.equal(isBlocking('Stale'), true);
    assert.equal(isBlocking('Passed'), false);
    assert.equal(isBlocking('NotApplicable'), false);
  });

  test('F20-AC2 a required check that never ran is Missing, Waiting or Stale and never Passed', () => {
    const neverRan: readonly CheckResult[] = ['Missing', 'Waiting', 'Stale'];

    for (const result of neverRan) {
      assert.equal(isTerminalSuccess(result), false, `${result} is not a pass`);
      const decision = deliverFor([checkRecord({ result, endedAt: null, exitCode: null })]);
      assert.equal(decision.eligible, false, `a required ${result} check must block delivery`);
      assert.deepEqual(decision.reasons, [`Required check "pnpm verify:app" is ${result}, not Passed.`]);
    }
  });

  test('F20-AC2 a skipped required check is not a pass even when nothing failed', () => {
    const skipped = checkRecord({ result: 'Missing', endedAt: null, exitCode: null, detail: 'The job was skipped.' });

    assert.equal(isTerminalSuccess(skipped.result), false);
    assert.equal(deliverFor([skipped]).eligible, false);
  });

  test('F20-AC2 a non-required check that failed does not block delivery', () => {
    const optionalFailure = checkRecord({
      checkId: 'chk_docs_lint',
      name: 'markdown link check',
      required: false,
      result: 'Failed',
      exitCode: 1,
      endedAt: '2026-03-04T09:03:00.000Z',
    });

    assert.deepEqual(deliverFor([checkRecord(), optionalFailure]), { eligible: true, reasons: [] });
  });

  test('F20-AC5 NotApplicable is not a success and a NotApplicable record without policy approval is not a success', () => {
    const unapproved = checkRecord({
      result: 'NotApplicable',
      notApplicableApprovedByPolicy: false,
      endedAt: null,
      exitCode: null,
    });

    assert.equal(isTerminalSuccess('NotApplicable'), false);
    assert.equal(isTerminalSuccess(unapproved.result), false);

    const decision = deliverFor([unapproved]);
    assert.equal(decision.eligible, false);
    assert.deepEqual(decision.reasons, ['Required check "pnpm verify:app" is NotApplicable, not Passed.']);
  });

  test('F20-AC2 a Waiting required check is not treated as a terminal success by deliveryEligible', () => {
    // isBlocking does not cover Waiting; deliveryEligible requires Passed outright,
    // so a required check that is still waiting still blocks delivery.
    const waiting = checkRecord({ result: 'Waiting', endedAt: null, exitCode: null });

    assert.equal(isTerminalSuccess(waiting.result), false);
    assert.equal(isBlocking(waiting.result), false);
    assert.equal(deliverFor([waiting]).eligible, false);
  });
});

describe('F20-AC4 failure attribution', () => {
  test('classifies a failure reproduced on the observed base commit as PresentOnBase', () => {
    const classification = classifyFailure({ failedOnCandidate: true, failedOnBaseSha: true, baseShaObserved: true });

    assert.equal(classification.attribution, 'PresentOnBase');
    assert.match(classification.evidence, /also failed on the observed base commit/);
  });

  test('classifies a failure absent from the observed base commit as IntroducedByChange', () => {
    const classification = classifyFailure({ failedOnCandidate: true, failedOnBaseSha: false, baseShaObserved: true });

    assert.equal(classification.attribution, 'IntroducedByChange');
    assert.match(classification.evidence, /passed on the observed base commit/);
  });

  test('classifies an unobserved base commit as Indeterminate whatever the base result says', () => {
    const unobservedTrue = classifyFailure({ failedOnCandidate: true, failedOnBaseSha: true, baseShaObserved: false });
    const unobservedNull = classifyFailure({ failedOnCandidate: true, failedOnBaseSha: null, baseShaObserved: false });

    assert.equal(unobservedTrue.attribution, 'Indeterminate');
    assert.equal(unobservedNull.attribution, 'Indeterminate');
    assert.match(unobservedTrue.evidence, /base commit was not observed/);
  });

  test('classifies a check the candidate did not report as failed as Indeterminate', () => {
    const classification = classifyFailure({ failedOnCandidate: false, failedOnBaseSha: true, baseShaObserved: true });

    assert.equal(classification.attribution, 'Indeterminate');
    assert.match(classification.evidence, /did not report this check as failed/);
  });

  test('F20-AC4 an existing base failure does not automatically waive the required check', () => {
    const failedOnCandidateToo = checkRecord({ result: 'Failed', exitCode: 1, endedAt: '2026-03-04T09:14:00.000Z' });
    const attribution = classifyFailure({ failedOnCandidate: true, failedOnBaseSha: true, baseShaObserved: true });
    const decision = deliverFor([failedOnCandidateToo]);

    assert.equal(attribution.attribution, 'PresentOnBase');
    assert.equal(decision.eligible, false, 'a PresentOnBase failure still fails the required gate');
    assert.deepEqual(decision.reasons, ['Required check "pnpm verify:app" is Failed, not Passed.']);
  });
});

describe('F23-AC1 and F24-AC3 acceptance readiness', () => {
  test('F24-AC3 an owner-test criterion must be Verified before acceptance; PendingOwnerTest is not enough', () => {
    assert.equal(acceptanceReady([criterion(OWNER_TEST, 'Verified')]), true);
    assert.equal(acceptanceReady([criterion(OWNER_TEST, 'PendingOwnerTest')]), false);
    assert.equal(acceptanceReady([criterion(OWNER_TEST, 'Failed')]), false);
    assert.equal(acceptanceReady([criterion(OWNER_TEST, 'Stale')]), false);
  });

  test('F24-AC3 an automated criterion may be PendingOwnerTest at the readiness stage', () => {
    assert.equal(acceptanceReady([criterion(AUTOMATED, 'PendingOwnerTest')]), true);
    assert.equal(acceptanceReady([criterion(AUTOMATED, 'Verified')]), true);
  });

  test('F23-AC1 an explicitly untested criterion is not acceptance ready', () => {
    const untested: CriterionVerificationMethod = { kind: 'Untested', reason: 'No observable criterion was recorded.' };

    assert.equal(acceptanceReady([criterion(untested, 'Untested')]), false);
    assert.equal(acceptanceReady([criterion(untested, 'Missing')]), false);
  });

  test('F24-AC3 one pending owner test blocks the whole set even when other criteria are verified', () => {
    const criteria = [criterion(AUTOMATED, 'Verified'), criterion(OWNER_TEST, 'PendingOwnerTest')];

    assert.equal(acceptanceReady(criteria), false);
    assert.equal(
      acceptanceReady([criterion(AUTOMATED, 'Verified'), criterion(OWNER_TEST, 'Verified')]),
      true,
    );
  });
});

describe('F20-AC3, F24-AC2, F25-AC3 delivery eligibility', () => {
  test('is eligible only when every required check passed for the current candidate and acceptance matches', () => {
    const decision = deliverFor([
      checkRecord(),
      checkRecord({ checkId: 'chk_lint', name: 'pnpm lint', result: 'Passed', endedAt: '2026-03-04T09:04:00.000Z' }),
    ]);

    assert.deepEqual(decision, { eligible: true, reasons: [] });
  });

  test('F20-AC3 a required check belonging to a different candidate blocks delivery and names the check', () => {
    const stale = checkRecord({ candidateFingerprint: PREVIOUS_CANDIDATE });
    const decision = deliverFor([stale]);

    assert.equal(decision.eligible, false);
    assert.deepEqual(decision.reasons, ['Required check "pnpm verify:app" belongs to a different candidate.']);
  });

  test('F20-AC3 a required check that did not pass blocks delivery and names the observed result', () => {
    const decision = deliverFor([checkRecord({ result: 'Stale' })]);

    assert.equal(decision.eligible, false);
    assert.deepEqual(decision.reasons, ['Required check "pnpm verify:app" is Stale, not Passed.']);
  });

  test('F25-AC3 acceptance recorded for a different candidate blocks delivery', () => {
    const decision = deliverFor([checkRecord()], PREVIOUS_CANDIDATE);

    assert.equal(decision.eligible, false);
    assert.deepEqual(decision.reasons, ['Acceptance was recorded for a different candidate.']);
  });

  test('F25-AC3 a replaced candidate reports both the stale check and the stale acceptance', () => {
    const decision = deliverFor([checkRecord({ candidateFingerprint: PREVIOUS_CANDIDATE })], PREVIOUS_CANDIDATE);

    assert.equal(decision.eligible, false);
    assert.deepEqual(decision.reasons, [
      'Required check "pnpm verify:app" belongs to a different candidate.',
      'Acceptance was recorded for a different candidate.',
    ]);
  });

  test('F20-AC2 several non-passing required checks each produce their own reason', () => {
    const decision = deliverFor([
      checkRecord(),
      checkRecord({ checkId: 'chk_lint', name: 'pnpm lint', result: 'Failed', exitCode: 1 }),
      checkRecord({ checkId: 'chk_browser', name: 'browser acceptance flow', origin: 'BrowserEvidence', result: 'Missing', endedAt: null, exitCode: null }),
    ]);

    assert.equal(decision.eligible, false);
    assert.deepEqual(decision.reasons, [
      'Required check "pnpm lint" is Failed, not Passed.',
      'Required check "browser acceptance flow" is Missing, not Passed.',
    ]);
  });
});