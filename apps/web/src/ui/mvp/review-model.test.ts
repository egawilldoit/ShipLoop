/**
 * The review screen's own rules, proved without a browser.
 *
 * Every case here is a wrong answer this screen must not be able to give, and each one is
 * written as the question the rule answers rather than as a restatement of the implementation:
 *
 *   - **A stale pass is never rendered as a current pass** (F20-AC3, F24-AC3). The table is
 *     exhaustive over the five source outcomes crossed with both counting flags, because the
 *     failure mode is *one combination* in a table of ten — a rule proved against three
 *     hand-picked rows has not been shown to hold for the other seven.
 *   - **A row that disagrees with itself is treated as not counting** (F20-AC3). The server
 *     refuses such a card, so this asserts the client defends the same line rather than
 *     relying on a refusal it may never see.
 *   - **A pending owner test is the owner's own outstanding step** and nothing else (F23-AC1):
 *     no label may read as a pass, and the recording controls are offered for exactly the two
 *     states where recording is both permitted and meaningful.
 *   - **A refusal records nothing** (F25-AC2, F24-AC4). The headline is asserted for every
 *     refusal code, and a `Conflict` is asserted to name what moved and to require a re-read.
 *   - **An empty feedback box submits `null`, never `''`** (F25-AC2), because the domain
 *     refuses an empty string for a reason no owner can act on.
 *   - **No merge, deploy or release control exists on either screen** (mvp-spec 3, F03-AC5).
 *     The last case reads the two screen sources: a rule expressed only in prose is a rule the
 *     next change can drop, and this is the invariant the MVP most needs to keep.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import type {
  ReviewCheckView,
  ReviewCriterionView,
  ReviewDecisionView,
  ReviewEvidenceOutcome,
  ReviewEvidenceView,
  ReviewOwnerTestView,
} from '../../server/contracts.ts';
import {
  canRequestChanges,
  decisionFeedback,
  domId,
  ownerTestNote,
  readAcceptanceGate,
  readCheck,
  readCriterion,
  readDecision,
  readDecisionRefusal,
  readEvidence,
  readEvidenceTable,
  readOwnerTestControls,
  readOwnerTestRefusal,
  readStaleDecisions,
} from './review-model.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A full SHA, because the model only ever receives real ones from a checked card. */
const HEAD = 'a'.repeat(40);
const EARLIER = 'b'.repeat(40);

const OUTCOMES: readonly ReviewEvidenceOutcome[] = ['passed', 'failed', 'waiting', 'missing', 'capture_failed'];

/**
 * The tone each outcome must take, written out here rather than imported.
 *
 * Deliberately duplicated: a test that asserted the implementation against itself would pass
 * unchanged if a tone were swapped, and the whole point of the stale case is that `stale` and
 * `passed` cannot end up looking alike (F20-AC3, N03-AC1).
 */
const COUNTING_TONES: Readonly<Record<ReviewEvidenceOutcome, string>> = {
  passed: 'healthy',
  failed: 'revoked',
  waiting: 'pending',
  missing: 'unconfigured',
  capture_failed: 'degraded',
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

function evidenceRow(overrides: Partial<ReviewEvidenceView> = {}): ReviewEvidenceView {
  return {
    evidenceId: 'ev-1',
    source: 'github_check',
    criterionId: null,
    checkId: 'unit-tests',
    recordedOutcome: 'passed',
    currentOutcome: 'passed',
    countsForCurrentCandidate: true,
    staleReasons: [],
    reason: 'Recorded from the provider check read.',
    observedAt: '2026-10-03T11:00:00.000Z',
    candidateHeadSha: HEAD,
    contractRevision: 2,
    detail: null,
    artifactRef: null,
    ...overrides,
  };
}

function criterion(overrides: Partial<ReviewCriterionView> = {}): ReviewCriterionView {
  return {
    criterionId: 'AC-1',
    description: 'The candidate header renders the full commit SHA.',
    verificationType: 'automated',
    verificationCheckId: 'unit-tests',
    state: 'passed',
    methodKind: 'AutomatedCheck',
    methodDetail: 'unit-tests',
    evidenceId: 'ev-1',
    observedAt: '2026-10-03T11:00:00.000Z',
    reason: 'A current observation of this candidate satisfies it.',
    ...overrides,
  };
}

function ownerTest(overrides: Partial<ReviewOwnerTestView> = {}): ReviewOwnerTestView {
  return {
    criterionId: 'AC-2',
    description: 'The start script launches the app and it serves the home page.',
    instructions: 'Run the start script and open the home page.',
    state: 'pending',
    evidenceId: null,
    observedAt: null,
    reason: 'Only an owner observation can satisfy an owner test.',
    ...overrides,
  };
}

function check(overrides: Partial<ReviewCheckView> = {}): ReviewCheckView {
  return {
    checkId: 'unit-tests',
    required: true,
    blocking: true,
    result: 'passed',
    evidenceId: 'ev-1',
    source: 'github_check',
    reason: 'The provider reported this check passing for the candidate on screen.',
    ...overrides,
  };
}

function ownerDecision(overrides: Partial<ReviewDecisionView['decision']> = {}): NonNullable<ReviewDecisionView['decision']> {
  return {
    decisionId: 'dec-1',
    kind: 'accepted',
    ownerId: 'owner-1',
    decidedAt: '2026-10-03T12:00:00.000Z',
    requestId: 'req-1',
    contractId: 'contract-1',
    contractRevision: 2,
    candidateId: 'cand-1',
    candidateHeadSha: HEAD,
    feedback: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Evidence: recorded is history, current is the verdict                         */
/* -------------------------------------------------------------------------- */

describe('F20-AC3: evidence is read by currentOutcome, and recordedOutcome is never the verdict', () => {
  test('every source outcome crossed with both counting flags lands on the right side', () => {
    for (const recordedOutcome of OUTCOMES) {
      // Counting: the recorded outcome is also the verdict, and no history line is shown
      // because the two agree — there is nothing to disambiguate.
      const counting = readEvidence(
        evidenceRow({ recordedOutcome, currentOutcome: recordedOutcome, countsForCurrentCandidate: true }),
        HEAD,
      );
      assert.equal(counting.verdict, recordedOutcome, `a counting row must read its own outcome (${recordedOutcome})`);
      assert.equal(counting.counts, true);
      assert.equal(counting.history, null, `agreeing outcomes need no history line (${recordedOutcome})`);
      assert.equal(counting.tone, COUNTING_TONES[recordedOutcome], `tone for a counting ${recordedOutcome}`);

      // Not counting: whatever it recorded, it reads stale and never counts.
      const notCounting = readEvidence(
        evidenceRow({
          recordedOutcome,
          currentOutcome: 'stale',
          countsForCurrentCandidate: false,
          candidateHeadSha: EARLIER,
          staleReasons: ['The candidate head moved after this was recorded.'],
        }),
        HEAD,
      );
      assert.equal(
        notCounting.verdict,
        'stale',
        `a row that does not count must read stale whatever it recorded (recorded ${recordedOutcome})`,
      );
      assert.equal(notCounting.counts, false);
      assert.notEqual(notCounting.tone, 'healthy', `a stale ${recordedOutcome} must never render green`);
      assert.notEqual(notCounting.label, 'Passed', `a stale ${recordedOutcome} must not be labelled Passed`);
      assert.ok(notCounting.history !== null, 'a stale row must say what the source recorded at the time');
      assert.match(notCounting.history ?? '', /history/i);
      assert.deepEqual(notCounting.staleReasons, ['The candidate head moved after this was recorded.']);
      assert.equal(notCounting.observedAnotherCommit, true);
    }
  });

  test('a recorded pass for an earlier commit reads stale, names the commit, and is never healthy', () => {
    const reading = readEvidence(
      evidenceRow({
        recordedOutcome: 'passed',
        currentOutcome: 'stale',
        countsForCurrentCandidate: false,
        candidateHeadSha: EARLIER,
        staleReasons: ['Evidence was recorded for a different commit.'],
      }),
      HEAD,
    );

    assert.equal(reading.verdict, 'stale');
    assert.equal(reading.label, 'Stale');
    assert.notEqual(reading.tone, 'healthy');
    assert.match(reading.history ?? '', /Passed/);
    assert.match(reading.history ?? '', new RegExp(EARLIER), 'the commit it was recorded for must be named in full');
    assert.match(reading.standing, /does not count/i);
  });

  test('a row that counts must name the commit on screen', () => {
    const counting = readEvidence(evidenceRow({ candidateHeadSha: HEAD }), HEAD);
    assert.equal(counting.observedAnotherCommit, false);
    assert.equal(counting.observedCommit, HEAD);
  });

  test('a row that disagrees with itself counts for nothing, even though it claims to count', () => {
    // The server refuses such a card. If it ever answered anyway, the client must not render
    // the pass: countsForCurrentCandidate and a stale currentOutcome cannot both be true, and
    // the safe reading of that disagreement is that the observation does not count.
    const contradictory = readEvidence(
      evidenceRow({ countsForCurrentCandidate: true, currentOutcome: 'stale' }),
      HEAD,
    );
    assert.equal(contradictory.counts, false);
    assert.equal(contradictory.verdict, 'stale');
    assert.notEqual(contradictory.tone, 'healthy');
  });

  test('the table keeps every row the card carries, keyed by its evidence identity', () => {
    const table = readEvidenceTable(
      [
        evidenceRow({ evidenceId: 'ev-current' }),
        evidenceRow({
          evidenceId: 'ev-old',
          currentOutcome: 'stale',
          countsForCurrentCandidate: false,
          recordedOutcome: 'passed',
          candidateHeadSha: EARLIER,
          staleReasons: ['stale'],
        }),
      ],
      HEAD,
    );
    assert.deepEqual(
      table.map((row) => [row.evidenceId, row.verdict]),
      [
        ['ev-current', 'passed'],
        ['ev-old', 'stale'],
      ],
    );
  });

  test('an observation the source could not attribute to any commit reads stale and says so', () => {
    const unattributed = readEvidence(
      evidenceRow({
        recordedOutcome: 'failed',
        currentOutcome: 'stale',
        countsForCurrentCandidate: false,
        candidateHeadSha: null,
        contractRevision: null,
        staleReasons: ['The source could not attribute this run to a commit.'],
      }),
      HEAD,
    );
    assert.equal(unattributed.verdict, 'stale');
    assert.match(unattributed.history ?? '', /did not attribute/);
  });
});

/* -------------------------------------------------------------------------- */
/* Criteria and owner tests                                                      */
/* -------------------------------------------------------------------------- */

describe('F23-AC1: a pending owner test is the owner’s own step, and nothing else settles it', () => {
  test('a pending owner test reads as waiting, never as passed', () => {
    const reading = readCriterion(
      criterion({ verificationType: 'owner_test', state: 'pending', verificationCheckId: null, evidenceId: null }),
    );
    assert.equal(reading.state, 'pending');
    assert.equal(reading.label, 'Waiting for you');
    assert.notEqual(reading.label, 'Passed');
    assert.notEqual(reading.tone, 'healthy');
  });

  test('the recorded controls are offered for exactly the states where recording means something', () => {
    assert.equal(readOwnerTestControls(ownerTest({ state: 'pending' })).recordable, true);
    assert.equal(readOwnerTestControls(ownerTest({ state: 'stale', evidenceId: 'ev-old' })).recordable, true);
    assert.equal(readOwnerTestControls(ownerTest({ state: 'passed', evidenceId: 'ev-mine' })).recordable, false);
    assert.equal(readOwnerTestControls(ownerTest({ state: 'failed', evidenceId: 'ev-mine' })).recordable, false);
    assert.equal(readOwnerTestControls(ownerTest({ state: 'unverified' })).recordable, false);
  });

  test('a settled owner test says what the owner recorded and offers nothing to change it', () => {
    const passed = readOwnerTestControls(ownerTest({ state: 'passed', evidenceId: 'ev-mine' }));
    assert.equal(passed.recordable, false);
    assert.match(passed.heading, /recorded this as passed/i);
    assert.notEqual(passed.heading, 'Record your result');
  });

  test('a stale owner test says the earlier result no longer counts, and still offers a way to settle it', () => {
    const stale = readOwnerTestControls(ownerTest({ state: 'stale', evidenceId: 'ev-old' }));
    assert.equal(stale.recordable, true);
    assert.match(stale.heading, /again/i);
    assert.match(stale.note, /no longer counts|does not count/i);
    assert.match(stale.note, /only you can/i);
  });

  test('an owner test with no assigned verification method offers no controls at all', () => {
    const unbound = readOwnerTestControls(ownerTest({ state: 'unverified' }));
    assert.equal(unbound.recordable, false);
    assert.match(unbound.heading, /no verification method/i);
  });

  test('every owner-test note says what it is about, so no note is blank', () => {
    for (const state of ['passed', 'failed', 'pending', 'stale', 'unverified'] as const) {
      assert.notEqual(readOwnerTestControls(ownerTest({ state })).note.trim(), '', `${state} needs a note`);
    }
  });
});

describe('F23-AC1: a check and a criterion are different claims, and the screen says which', () => {
  test('a required check that passes is labelled from the policy list, not assumed', () => {
    assert.equal(readCheck(check(), ['unit-tests']).requiredByPolicy, true);
    assert.equal(readCheck(check({ checkId: 'lint' }), ['unit-tests']).requiredByPolicy, false);
    assert.equal(readCheck(check(), ['unit-tests']).label, 'Passed');
  });

  test('stale, not_run and missing are three different words and three different tones', () => {
    const stale = readCheck(check({ result: 'stale' }), []);
    const notRun = readCheck(check({ result: 'not_run' }), []);
    const missing = readCheck(check({ result: 'missing' }), []);
    assert.deepEqual(
      [stale.label, notRun.label, missing.label],
      ['Stale', 'Not run', 'Never reported'],
    );
    assert.notEqual(stale.tone, notRun.tone, 'a stale check and an unrun check must not read alike');
    assert.equal(stale.tone, 'degraded');
    assert.equal(notRun.tone, 'unconfigured');
  });

  test('an automated criterion states the check it is bound to through the server’s reason', () => {
    const reading = readCriterion(criterion({ reason: 'Bound to unit-tests, which passed for this candidate.' }));
    assert.match(reading.standing, /unit-tests/);
  });
});

/* -------------------------------------------------------------------------- */
/* Decisions                                                                    */
/* -------------------------------------------------------------------------- */

describe('F25-AC3: a decision that no longer applies is shown, and says so', () => {
  test('an acceptance of the commit on screen authorises it', () => {
    const reading = readDecision(
      {
        outcome: 'accepted',
        decision: ownerDecision(),
        staleDecisions: [],
        authorizesCurrentCandidate: true,
      },
      HEAD,
    );
    assert.equal(reading.authorizesCurrentCandidate, true);
    assert.equal(reading.label, 'Accepted — for this commit');
    assert.equal(reading.tone, 'healthy');
    assert.match(reading.summary, new RegExp(HEAD));
  });

  test('an acceptance of an earlier commit is shown, and says it authorises nothing', () => {
    const reading = readDecision(
      {
        outcome: 'accepted',
        decision: ownerDecision({ candidateHeadSha: EARLIER }),
        staleDecisions: [],
        authorizesCurrentCandidate: false,
      },
      HEAD,
    );
    assert.equal(reading.authorizesCurrentCandidate, false);
    assert.equal(reading.tone, 'degraded');
    assert.match(reading.summary, new RegExp(EARLIER));
    assert.match(reading.summary, new RegExp(HEAD), 'the commit on screen must be named too');
    assert.match(reading.summary, /authorises nothing/i);
  });

  test('no decision yet reads as no decision', () => {
    const reading = readDecision({ outcome: 'none', decision: null, staleDecisions: [], authorizesCurrentCandidate: false }, HEAD);
    assert.equal(reading.label, 'No decision yet');
    assert.equal(reading.outcome, 'none');
  });

  test('stale decisions are surfaced with the reason the server gave', () => {
    const readings = readStaleDecisions([
      {
        decisionId: 'dec-9',
        kind: 'accepted',
        candidateHeadSha: EARLIER,
        contractRevision: 1,
        reason: 'The candidate head moved after this acceptance was recorded (F27-AC3).',
      },
    ]);
    assert.equal(readings.length, 1);
    const [reading] = readings;
    assert.equal(reading?.decisionId, 'dec-9');
    assert.match(reading?.label ?? '', /accepted an earlier commit/i);
    assert.equal(reading?.candidateHeadSha, EARLIER);
    assert.match(reading?.reason ?? '', /candidate head moved/i);
  });
});

describe('F24-AC3: the accept gate is the server’s answer, quoted and not re-derived', () => {
  const base = {
    readyForOwnerReview: true,
    readyForAcceptance: false,
    readyForDelivery: false,
    blockingReasons: ['unit-tests is stale.'],
    ownerActions: ['Run the owner test for AC-2.'],
    acceptanceBlockers: ['The owner test for AC-2 has not been recorded.'],
    deliveryBlockers: ['Nothing has been accepted.'],
  };

  test('a refused gate names what stands in the way', () => {
    const reading = readAcceptanceGate(base);
    assert.equal(reading.readyForAcceptance, false);
    assert.deepEqual(reading.acceptanceBlockers, ['The owner test for AC-2 has not been recorded.']);
    assert.deepEqual(reading.ownerActions, ['Run the owner test for AC-2.']);
    assert.match(reading.label, /not eligible/i);
    assert.match(reading.standing, /again when you decide/i);
  });

  test('an open gate is still stated as the server’s answer, not as a promise', () => {
    const reading = readAcceptanceGate({ ...base, readyForAcceptance: true, acceptanceBlockers: [] });
    assert.equal(reading.readyForAcceptance, true);
    assert.match(reading.standing, /can still refuse/i);
  });
});

describe('F24-AC4, F25-AC2: a refused decision records nothing and says what moved', () => {
  test('every refusal code states that nothing was recorded', () => {
    for (const code of ['Invalid', 'Blocked', 'Conflict', 'NotFound', 'Forbidden', 'Unavailable']) {
      const reading = readDecisionRefusal({
        code,
        reason: 'the server said no',
        fields: [],
        prerequisites: [],
        expected: null,
        actual: null,
      });
      assert.match(reading.headline, /Nothing was recorded/i, `${code} must deny that anything was written`);
      assert.doesNotMatch(reading.headline, /\baccepted\b/i, `${code} must never read as an acceptance`);
      assert.doesNotMatch(reading.headline, /recorded the decision|has been accepted/i);
    }
  });

  test('a moved commit is named, in full, and requires the card to be read again', () => {
    const reading = readDecisionRefusal({
      code: 'Conflict',
      reason: `This submission was prepared against candidate ${EARLIER}, but the candidate on screen is ${HEAD}.`,
      fields: [],
      prerequisites: [],
      expected: EARLIER,
      actual: HEAD,
    });
    assert.equal(reading.mustReloadCard, true);
    assert.equal(reading.moved?.subject, 'The candidate');
    assert.equal(reading.moved?.expected, EARLIER);
    assert.equal(reading.moved?.actual, HEAD);
    assert.match(reading.headline, /Nothing was recorded/i);
    assert.match(reading.headline, /read again/i);
    assert.equal(reading.detail.includes(HEAD), true, 'the server’s own words are quoted');
  });

  test('a moved contract revision is a different fact from a moved commit, and says so', () => {
    const reading = readDecisionRefusal({
      code: 'Conflict',
      reason: 'The contract has a newer revision.',
      fields: [],
      prerequisites: [],
      expected: '1',
      actual: '2',
    });
    assert.equal(reading.moved?.subject, 'The contract revision');
    assert.match(reading.headline, /revision moved/i);
  });

  test('a Blocked acceptance keeps the outstanding requirements the server named', () => {
    const reading = readDecisionRefusal({
      code: 'Blocked',
      reason: 'This candidate cannot be accepted yet: 1 outstanding requirements (F23-AC1).',
      fields: [],
      prerequisites: [{ name: 'Outstanding requirement', detail: 'AC-2 has not been recorded.', remedy: 'Record the missing observation.' }],
      expected: null,
      actual: null,
    });
    assert.equal(reading.mustReloadCard, false, 'a blocked acceptance is not a stale card');
    assert.equal(reading.prerequisites.length, 1);
    assert.match(reading.prerequisites[0]?.detail ?? '', /AC-2/);
  });

  test('an Invalid refusal carries the field message beside the field it belongs to', () => {
    const reading = readDecisionRefusal({
      code: 'Invalid',
      reason: 'The submitted values were not accepted.',
      fields: [{ path: 'feedback', message: 'State what should change.' }],
      prerequisites: [],
      expected: null,
      actual: null,
    });
    assert.deepEqual(reading.fields, [{ path: 'feedback', message: 'State what should change.' }]);
  });

  test('a refused owner test also records nothing, and reloads on a conflict or a vanished candidate', () => {
    const conflict = readOwnerTestRefusal({
      code: 'Conflict',
      reason: 'moved',
      fields: [],
      prerequisites: [],
      expected: EARLIER,
      actual: HEAD,
    });
    assert.match(conflict.headline, /Nothing was recorded/i);
    assert.equal(conflict.mustReloadCard, true);

    const refused = readOwnerTestRefusal({
      code: 'Invalid',
      reason: 'An automated criterion cannot be discharged by an owner test.',
      fields: [],
      prerequisites: [],
      expected: null,
      actual: null,
    });
    assert.equal(refused.mustReloadCard, false);
    assert.match(refused.detail, /automated criterion/i);
  });
});

describe('F25-AC2: the body a decision is submitted with', () => {
  test('an empty or blank feedback box submits null, never an empty string', () => {
    assert.equal(decisionFeedback(''), null);
    assert.equal(decisionFeedback('   \n\t '), null);
    assert.equal(decisionFeedback('the label is wrong'), 'the label is wrong');
  });

  test('a change request needs something to act on, and says so before the round trip', () => {
    assert.equal(canRequestChanges(''), false);
    assert.equal(canRequestChanges('   '), false);
    assert.equal(canRequestChanges('the empty state is wrong'), true);
  });

  test('an empty owner-test note is submitted as no note', () => {
    assert.equal(ownerTestNote(''), null);
    assert.equal(ownerTestNote('  '), null);
    assert.equal(ownerTestNote('checked on a phone'), 'checked on a phone');
  });
});

describe('F02-AC4: server-supplied identities never break a label association', () => {
  test('an awkward identity becomes a usable DOM id', () => {
    assert.equal(domId('owner-test-note', 'AC-2'), 'owner-test-note-AC-2');
    assert.equal(domId('owner-test-note', 'AC 2/odd"id'), 'owner-test-note-AC-2-odd-id');
    assert.equal(domId('owner-test-note', '///'), 'owner-test-note');
  });
});

describe('mvp-spec 3: v0.1 ends at Accepted or Changes Requested', () => {
  /**
   * The labels of every control on the two screens, read out of the source.
   *
   * Scoped to control elements rather than the whole file on purpose. A screen that *says* there
   * is no deployment step must not fail a rule that bans the word — so this collects what a reader
   * could press or follow, which is the thing that must not exist. Reading it back out of the
   * source keeps the rule independent of the implementation: renaming the component, restructuring
   * the JSX or moving the panel cannot quietly add the control this forbids.
   */
  function controlLabels(source: string): readonly string[] {
    const labels: string[] = [];
    const elements = /<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g;
    let match: RegExpExecArray | null = elements.exec(source);
    while (match !== null) {
      const attributes = match[2] ?? '';
      const body = match[3] ?? '';
      const aria = /\baria-label=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/.exec(attributes);
      labels.push(attributes.replace(/\s+/g, ' ').trim());
      if (aria !== null) labels.push(aria[1] ?? aria[2] ?? aria[3] ?? '');
      labels.push(body.replace(/\s+/g, ' ').trim());
      match = elements.exec(source);
    }
    return labels;
  }

  test('no control anywhere in the MVP surfaces offers a merge, deploy or release action', () => {
    const forbidden = /\b(merge|deploy|release|publish|ship)\b/i;
    // The whole directory rather than a hand-listed set of files, so a panel added later cannot
    // escape the rule by not being named here. A file with no controls simply contributes none.
    const files = readdirSync(HERE).filter((file) => file.endsWith('.tsx')).sort();
    assert.ok(files.length > 0, 'there are MVP screens to check');

    let controlsFound = 0;
    for (const file of files) {
      for (const label of controlLabels(readFileSync(join(HERE, file), 'utf8'))) {
        controlsFound += 1;
        assert.equal(
          forbidden.test(label),
          false,
          `${file} offers a control whose label mentions a step past the decision: ${label}`,
        );
      }
    }
    assert.ok(controlsFound > 0, 'the scan must actually be reading controls, or it proves nothing');
  });

  test('the review screen still tells the owner where the product ends, rather than going quiet', () => {
    // The absence of a control is only honest if something says the journey stops here. Asserted
    // as words rather than as a component, because the sentence is what a reader needs.
    const source = readFileSync(join(HERE, 'ReviewScreen.tsx'), 'utf8');
    assert.match(source, /where this version ends/i);
    assert.match(source, /Nothing here does anything further to the candidate/i);
  });
});
