/**
 * The card invariants the transport refuses to serve, and the attempts to defeat them
 * (mvp-spec 3, F20-AC3, F23-AC1, F24-AC3, F25-AC3, F27-AC3).
 *
 * `review.test.ts` drives the real composition root, so everything it asserts is what the
 * product produces. That is exactly why it cannot answer one question: the domain projects
 * the card correctly, so the runtime check in `checkedCard` is never asked to catch anything.
 * A check that has only ever run against an honest port has not been shown to work.
 *
 * So this file supplies the dishonest port. `mvpReview.getReview` and `mvpReview.decide`
 * answer with a card assembled here, and the question is never "does the card look right" -
 * it is "does the route notice that this card says two things that cannot both be true, and
 * refuse rather than render it". Every case is built by taking one internally consistent
 * card and breaking exactly one thing about it, so each refusal is specific: the same card
 * un-broken is served, in the control at the end.
 *
 * The property under test is the one this product exists to keep:
 *
 *   **nothing on the card may assert a current pass without an observation that counts for
 *   this candidate.** "What the source said at the time" (`recordedOutcome`) and "what that
 *   means now" (`currentOutcome`, `countsForCurrentCandidate`) are separate fields precisely
 *   so a stale pass cannot render green. A card that reads `passed` on evidence that does not
 *   count - a stale row, a row for another commit, or no row at all - is the one wrong answer
 *   the whole projection exists to make unreachable, so the transport re-derives it and
 *   answers 503 rather than shipping it (F20-AC3, F24-AC3).
 *
 * The stub is a `ControllerSurface` double built the way `home.test.ts` builds one: every
 * group this file does not exercise refuses by name through a Proxy, so the double still has
 * to satisfy the whole surface and cannot quietly grow a method that answers something.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { SESSION_COOKIE_NAME, deriveCsrfToken, hashSessionToken, ok, sessionDeadlines } from '@shiploop/domain';
import type { DomainError, OwnerId, Result } from '@shiploop/domain';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../app.ts';
import { CSRF_HEADER } from '../auth-guard.ts';
import { readServerConfig } from '../config.ts';
import type {
  ControllerSurface,
  MvpReviewCardView,
  ReviewEvidenceView,
  ReviewOwnerDecisionView,
  SessionUseCases,
  StoredSessionRecord,
} from '../contracts.ts';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

const CSRF_SECRET = ['server', 'secret', 'material', '0123456789abcdef'].join('-');
const START = '2026-10-03T09:00:00.000Z';
const LATER = '2026-10-03T10:00:00.000Z';
const OWNER_ID = 'owner-0000-4000-8000-00000000000c' as OwnerId;
const TOKEN = 'review-invariants-test-token';
const SESSION_ID = 'sess_review_invariants';

const PROJECT_ID = 'checkout';
const CANDIDATE_ID = 'cand-checkout';
const REQUEST_ID = 'req-checkout';
const CONTRACT_ID = 'dc_checkout_1';
const UNIT_CHECK = 'unit';
const UNIT_EVIDENCE = 'evid-unit';
const OWNER_EVIDENCE = 'evid-owner';

const HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const OLD_HEAD = 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5';

const AUTOMATED_CRITERION_ID = 'AC1';
const OWNER_CRITERION_ID = 'AC2';

/** A use case this double does not implement, refusing by name rather than pretending. */
function notImplemented<T>(useCase: string): Promise<Result<T, DomainError>> {
  return Promise.resolve({
    ok: false,
    error: { code: 'Unavailable', reason: `The review-invariants double does not implement ${useCase}.` },
  });
}

/** One session, stored the way the store stores it: a digest and nothing about the token. */
function storedSession(now: () => Date): StoredSessionRecord {
  const deadlines = sessionDeadlines({
    issuedAt: now().toISOString(),
    absoluteTtlSeconds: 8 * 60 * 60,
    idleTimeoutSeconds: 60 * 60,
  });
  return {
    sessionId: SESSION_ID,
    ownerId: OWNER_ID,
    displayName: 'Solo Owner',
    tokenDigest: hashSessionToken(TOKEN),
    issuedAt: deadlines.issuedAt,
    expiresAt: deadlines.expiresAt,
    revokedAt: null,
    lastActivityAt: null,
  };
}

function sessionUseCases(record: StoredSessionRecord): SessionUseCases {
  return {
    loadByToken: async (token) =>
      hashSessionToken(token) === record.tokenDigest
        ? ok(record)
        : { ok: false, error: { code: 'NotFound', reason: 'No session matches this token (F01-AC2).' } },
    create: () => notImplemented('sessions.create'),
    revoke: () => notImplemented('sessions.revoke'),
    touch: async () => ok(null),
  };
}

/** The observation as it reads when it was recorded against this candidate. */
function countingEvidence(): ReviewEvidenceView {
  return {
    evidenceId: UNIT_EVIDENCE,
    source: 'github_check',
    criterionId: null,
    checkId: UNIT_CHECK,
    recordedOutcome: 'passed',
    currentOutcome: 'passed',
    countsForCurrentCandidate: true,
    staleReasons: [],
    reason: 'Recorded against the current candidate.',
    observedAt: LATER,
    candidateHeadSha: HEAD,
    contractRevision: 1,
    detail: null,
    artifactRef: null,
  };
}

/** The same observation as a later push makes it: recorded `passed`, and no longer counting. */
function staleEvidence(): ReviewEvidenceView {
  return {
    ...countingEvidence(),
    currentOutcome: 'stale',
    countsForCurrentCandidate: false,
    staleReasons: [`It observed ${OLD_HEAD}, and the candidate is now ${HEAD}.`],
    reason: 'It observed an earlier commit, so it describes history rather than this candidate.',
    candidateHeadSha: OLD_HEAD,
  };
}

/** An owner test recorded against the commit before the push. */
function staleOwnerEvidence(): ReviewEvidenceView {
  return {
    ...staleEvidence(),
    evidenceId: OWNER_EVIDENCE,
    source: 'owner_test',
    criterionId: OWNER_CRITERION_ID,
    checkId: null,
  };
}

/**
 * A card that is internally consistent, so every refusal below is caused by the one thing a
 * case changes rather than by a fixture that was never right to begin with.
 *
 * `AC1` is verified by the `unit` check, which passed against this candidate; `AC2` is an
 * owner test nobody has run. That is a real, reviewable state - not an empty card - so a
 * defect that only shows up when the card has content is exercised here.
 */
function consistentCard(): MvpReviewCardView {
  return {
    collectedAt: LATER,
    request: {
      requestId: REQUEST_ID,
      projectId: PROJECT_ID,
      title: 'Checkout totals',
      description: 'The order summary shows the total including tax.',
      createdAt: START,
      updatedAt: START,
    },
    contract: {
      contractId: CONTRACT_ID,
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
      revision: 1,
      status: 'approved',
      outcome: 'The order summary shows the total including tax.',
      scope: ['Sum the line items before tax'],
      outOfScope: ['Changing the tax rate'],
      approval: { approvedAt: LATER, approvedBy: OWNER_ID },
      acceptanceCriteria: [
        // The automated criterion is bound, as an approved revision's must be; the owner test is
        // explicitly null, as an owner test's must be. Neither value is what these cases are about —
        // they are here so the facts are a legal card at all.
        { id: AUTOMATED_CRITERION_ID, verificationType: 'automated', verificationCheckId: 'unit-tests' },
        { id: OWNER_CRITERION_ID, verificationType: 'owner_test', verificationCheckId: null },
      ],
      createdAt: START,
      updatedAt: LATER,
    },
    candidate: {
      candidateId: CANDIDATE_ID,
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
      contractId: CONTRACT_ID,
      contractRevision: 1,
      repository: 'octopus/shop',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.invalid/octopus/shop/pull/42',
      pullRequestState: 'Open',
      draft: false,
      baseBranch: 'main',
      headSha: HEAD,
      observedAt: LATER,
    },
    policy: {
      policyId: 'mvp-default',
      requiredAutomatedCheckIds: [],
      ownerTestBlocksReview: false,
      ownerTestBlocksDelivery: true,
    },
    checks: [
      {
        checkId: UNIT_CHECK,
        required: false,
        blocking: false,
        result: 'passed',
        evidenceId: UNIT_EVIDENCE,
        source: 'github_check',
        reason: 'Recorded passed against the current candidate.',
      },
    ],
    criteria: [
      {
        criterionId: AUTOMATED_CRITERION_ID,
        description: 'The unit suite passes.',
        verificationType: 'automated',
        verificationCheckId: UNIT_CHECK,
        state: 'passed',
        methodKind: 'AutomatedCheck',
        methodDetail: UNIT_CHECK,
        evidenceId: UNIT_EVIDENCE,
        observedAt: LATER,
        reason: 'Verified by github_check against the current candidate.',
      },
      {
        criterionId: OWNER_CRITERION_ID,
        description: 'The owner confirms the total matches the invoice.',
        verificationType: 'owner_test',
        verificationCheckId: null,
        state: 'pending',
        methodKind: 'OwnerTest',
        methodDetail: 'Compare the total with the invoice.',
        evidenceId: null,
        observedAt: null,
        reason: 'The owner test has not been recorded.',
      },
    ],
    ownerTests: [
      {
        criterionId: OWNER_CRITERION_ID,
        description: 'The owner confirms the total matches the invoice.',
        instructions: 'Compare the total with the invoice.',
        state: 'pending',
        evidenceId: null,
        observedAt: null,
        reason: 'The owner test has not been recorded.',
      },
    ],
    evidence: [countingEvidence()],
    staleness: { stale: false, reasons: [], staleEvidenceIds: [], staleDecisionIds: [] },
    decision: { outcome: 'none', decision: null, staleDecisions: [], authorizesCurrentCandidate: false },
    eligibility: {
      readyForOwnerReview: true,
      readyForAcceptance: false,
      readyForDelivery: false,
      blockingReasons: [],
      ownerActions: ['Run the owner test for "AC2".'],
      acceptanceBlockers: ['Criterion "AC2" is pending.'],
      deliveryBlockers: ['Criterion "AC2" is pending.'],
    },
  };
}

/** Replaces the card with one the port chose, keeping every other group refusing by name. */
function surfaceWith(card: MvpReviewCardView, now: () => Date): ControllerSurface {
  const unused = (name: string) => new Proxy({} as never, { get: () => () => notImplemented(name) });
  return {
    mvpReview: {
      getReview: async () => ok(card),
      decide: async () => ok(card),
    },
    sessions: sessionUseCases(storedSession(now)),
    owners: unused('owners'),
    projects: unused('projects'),
    contracts: unused('contracts'),
    handoff: unused('handoff'),
    profiles: unused('profiles'),
    connectors: unused('connectors'),
    settings: unused('settings'),
    intake: unused('intake'),
    runs: unused('runs'),
    attention: unused('attention'),
    reviewCards: unused('reviewCards'),
    acceptance: unused('acceptance'),
    ownerTests: unused('ownerTests'),
    planning: unused('planning'),
    generation: unused('generation'),
  } as unknown as ControllerSurface;
}

async function withCard(
  card: MvpReviewCardView,
  run: (h: {
    readonly read: () => Promise<{ readonly status: number; readonly body: string }>;
    readonly decide: () => Promise<{ readonly status: number; readonly body: string }>;
  }) => Promise<void>,
): Promise<void> {
  const now = (): Date => new Date(START);
  const parsed = readServerConfig({
    SHIPLOOP_NODE_ENV: 'test',
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_COOKIE_SECURE: 'false',
    SHIPLOOP_LOG_LEVEL: 'silent',
  });
  assert.ok(parsed.ok, 'the test configuration must be accepted');
  const app: FastifyInstance = await buildApp({
    config: parsed.value,
    controller: surfaceWith(card, now),
    now,
  });
  const headers = { cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` };
  try {
    await run({
      read: async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/review`,
          headers,
        });
        return { status: response.statusCode, body: response.body };
      },
      decide: async () => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/decision`,
          headers: { ...headers, [CSRF_HEADER]: deriveCsrfToken(SESSION_ID, CSRF_SECRET) },
          payload: { decision: 'changes_requested', expectedHeadSha: HEAD, expectedContractRevision: 1, feedback: 'The total is wrong.' },
        });
        return { status: response.statusCode, body: response.body };
      },
    });
  } finally {
    await app.close();
  }
}

interface Problem {
  readonly error: { readonly code: string; readonly message: string };
}

/**
 * Asserts the card was refused rather than served, and returns the message.
 *
 * A 503 is the refusal: the transport could not verify what the card claims, which is
 * different in kind from a 409 (a conflict the owner can resolve by re-rendering) or a 422
 * (an answer about the product). It must never be a 200, because a 200 is a claim that the
 * card on the wire describes this candidate.
 */
async function refuses(h: { readonly read: () => Promise<{ readonly status: number; readonly body: string }> }, what: string): Promise<string> {
  const response = await h.read();
  assert.notEqual(response.status, 200, `${what} must not be served as a review card: ${response.body}`);
  assert.equal(response.status, 503, `${what} must be refused as unverifiable: ${response.body}`);
  const problem = JSON.parse(response.body) as Problem;
  assert.equal(problem.error.code, 'Unavailable');
  return problem.error.message;
}

/* -------------------------------------------------------------------------- */
/* Defeating the staleness check                                                */
/* -------------------------------------------------------------------------- */

test('F20-AC3, F24-AC3: a criterion that reads passed on evidence which does not count is refused, not rendered green', async () => {
  const base = consistentCard();
  // The only change: the observation the criterion rests on no longer describes this commit.
  // The row itself is honest - stale, with a reason - so it passes the per-row check, and
  // the card-level staleness summary is honest too. What makes the card unservable is that a
  // criterion reads `passed` on top of it.
  const card: MvpReviewCardView = {
    ...base,
    evidence: [staleEvidence()],
    checks: [{ ...base.checks[0]!, result: 'stale', reason: 'It observed an earlier commit.' }],
    staleness: { stale: true, reasons: ['evidence no longer applies'], staleEvidenceIds: [UNIT_EVIDENCE], staleDecisionIds: [] },
  };
  await withCard(card, async (h) => {
    const message = await refuses(h, `a ${AUTOMATED_CRITERION_ID} reading passed on stale evidence`);
    assert.match(message, new RegExp(UNIT_EVIDENCE), `the refusal names the observation: ${message}`);
  });
});

test('F23-AC1, F20-AC3: an owner test reading passed on evidence for another commit is refused', async () => {
  const base = consistentCard();
  const card: MvpReviewCardView = {
    ...base,
    ownerTests: [{ ...base.ownerTests[0]!, state: 'passed', evidenceId: OWNER_EVIDENCE, observedAt: LATER }],
    evidence: [countingEvidence(), staleOwnerEvidence()],
    staleness: {
      stale: true,
      reasons: ['evidence no longer applies'],
      staleEvidenceIds: [OWNER_EVIDENCE],
      staleDecisionIds: [],
    },
  };
  await withCard(card, async (h) => {
    // The row is an owner observation, so the existing "only an owner observation can settle
    // an owner test" rule is satisfied. What it must not be able to do is settle an owner
    // test for a commit the owner did not look at.
    const message = await refuses(h, `an ${OWNER_CRITERION_ID} reading passed on evidence for another commit`);
    assert.match(message, new RegExp(OWNER_EVIDENCE), `the refusal names the observation: ${message}`);
  });
});

test('F20-AC3: a check that reads passed with no observation behind it is refused', async () => {
  const base = consistentCard();
  const card: MvpReviewCardView = {
    ...base,
    checks: [{ ...base.checks[0]!, evidenceId: null, source: null, reason: 'The check passed.' }],
    criteria: [{ ...base.criteria[0]!, evidenceId: null }, base.criteria[1]!],
    evidence: [],
  };
  await withCard(card, async (h) => {
    // Nothing was observed, so a green result here is a fabricated pass: the exact reading
    // the whole recorded/current split exists to prevent.
    await refuses(h, `a ${UNIT_CHECK} reading passed with no observation`);
  });
});

test('F20-AC3: a check that reads passed on an observation for another commit is refused', async () => {
  const base = consistentCard();
  const card: MvpReviewCardView = {
    ...base,
    evidence: [staleEvidence()],
    staleness: { stale: true, reasons: ['evidence no longer applies'], staleEvidenceIds: [UNIT_EVIDENCE], staleDecisionIds: [] },
  };
  await withCard(card, async (h) => {
    await refuses(h, `a ${UNIT_CHECK} reading passed on an observation for another commit`);
  });
});

test('F20-AC3, F25-AC3: a card whose staleness summary hides a stale row is refused', async () => {
  const base = consistentCard();
  // The rows are honest and the summary is not: the evidence reads stale while
  // `staleness` says nothing is stale. A client that renders the headline banner rather than
  // every row would be told this candidate is current.
  const card: MvpReviewCardView = {
    ...base,
    criteria: [{ ...base.criteria[0]!, state: 'stale' }, base.criteria[1]!],
    evidence: [staleEvidence()],
  };
  await withCard(card, async (h) => {
    const message = await refuses(h, 'a card whose staleness summary omits a stale row');
    assert.match(message, new RegExp(UNIT_EVIDENCE), `the refusal names the hidden observation: ${message}`);
  });
});

test('F20-AC3, F24-AC3: every offending verdict is named, not only the first one found', async () => {
  const base = consistentCard();
  // Three verdicts resting on one stale observation: the check, the criterion and the owner
  // test all reading `passed` on a row that no longer describes this commit. A transport that
  // refused on the first disagreement would name one of them and leave a reader unable to tell
  // whether the other two were fine.
  const card: MvpReviewCardView = {
    ...base,
    ownerTests: [{ ...base.ownerTests[0]!, state: 'passed', evidenceId: UNIT_EVIDENCE, observedAt: LATER }],
    evidence: [staleEvidence()],
    staleness: { stale: true, reasons: ['evidence no longer applies'], staleEvidenceIds: [UNIT_EVIDENCE], staleDecisionIds: [] },
  };
  await withCard(card, async (h) => {
    const message = await refuses(h, 'three verdicts resting on stale evidence');
    assert.match(message, new RegExp(`Check "${UNIT_CHECK}"`), `the check is named: ${message}`);
    assert.match(message, new RegExp(`Criterion ${AUTOMATED_CRITERION_ID}`), `the criterion is named: ${message}`);
    assert.match(message, new RegExp(`Owner test ${OWNER_CRITERION_ID}`), `the owner test is named: ${message}`);
  });
});

test('F20-AC3: a row claiming to count while naming an older commit is refused', async () => {
  const base = consistentCard();
  const card: MvpReviewCardView = {
    ...base,
    evidence: [{ ...countingEvidence(), candidateHeadSha: OLD_HEAD }],
  };
  await withCard(card, async (h) => {
    await refuses(h, 'a row that counts for this candidate while naming another commit');
  });
});

test('F20-AC3: a row that reads stale with no reason is refused', async () => {
  const base = consistentCard();
  const card: MvpReviewCardView = {
    ...base,
    evidence: [{ ...countingEvidence(), currentOutcome: 'stale', countsForCurrentCandidate: false, staleReasons: [] }],
    staleness: { stale: true, reasons: ['something moved'], staleEvidenceIds: [UNIT_EVIDENCE], staleDecisionIds: [] },
  };
  await withCard(card, async (h) => {
    await refuses(h, 'a stale row that says nothing about why');
  });
});

/* -------------------------------------------------------------------------- */
/* Defeating the decision check                                                 */
/* -------------------------------------------------------------------------- */

test('F27-AC3: a card claiming the candidate is authorised by a change request is refused', async () => {
  const base = consistentCard();
  const card: MvpReviewCardView = {
    ...base,
    decision: {
      outcome: 'changes_requested',
      decision: {
        decisionId: 'dec-1',
        kind: 'changes_requested',
        ownerId: OWNER_ID,
        decidedAt: LATER,
        requestId: REQUEST_ID,
        contractId: CONTRACT_ID,
        contractRevision: 1,
        candidateId: CANDIDATE_ID,
        candidateHeadSha: HEAD,
        feedback: 'The total is wrong.',
      },
      staleDecisions: [],
      // Only an acceptance authorises anything. This flag is what a delivery gate reads.
      authorizesCurrentCandidate: true,
    },
  };
  await withCard(card, async (h) => {
    await refuses(h, 'a change request reported as authorising the candidate');
  });
});

test('F25-AC3: an acceptance that authorises the candidate while naming another commit is refused', async () => {
  const base = consistentCard();
  const card: MvpReviewCardView = {
    ...base,
    decision: {
      outcome: 'accepted',
      decision: {
        decisionId: 'dec-1',
        kind: 'accepted',
        ownerId: OWNER_ID,
        decidedAt: LATER,
        requestId: REQUEST_ID,
        contractId: CONTRACT_ID,
        contractRevision: 1,
        candidateId: CANDIDATE_ID,
        candidateHeadSha: OLD_HEAD,
        feedback: null,
      },
      staleDecisions: [],
      authorizesCurrentCandidate: true,
    },
  };
  await withCard(card, async (h) => {
    await refuses(h, 'an acceptance of another commit reported as authorising this one');
  });
});

test('F02-AC2, F25-AC2: a decision naming another request, contract or candidate is refused rather than returned', async () => {
  const base = consistentCard();
  const recorded: ReviewOwnerDecisionView = {
    decisionId: 'dec-1',
    kind: 'changes_requested',
    ownerId: OWNER_ID,
    decidedAt: LATER,
    requestId: REQUEST_ID,
    contractId: CONTRACT_ID,
    contractRevision: 1,
    candidateId: CANDIDATE_ID,
    candidateHeadSha: HEAD,
    feedback: 'The total is wrong.',
  };

  // Each case changes exactly one identity, and leaves every other fact correct - including
  // the commit, which still names the candidate on screen. So the only thing a refusal can be
  // about is the identity that was changed, which is what makes each refusal specific.
  for (const [what, identity] of [
    ['request', { requestId: 'req-somewhere-else' }],
    ['contract', { contractId: 'dc_somewhere_else' }],
    ['candidate', { candidateId: 'cand-somewhere-else' }],
  ] as const) {
    const card: MvpReviewCardView = {
      ...base,
      decision: {
        outcome: 'changes_requested',
        decision: { ...recorded, ...identity },
        staleDecisions: [],
        authorizesCurrentCandidate: false,
      },
    };
    await withCard(card, async (h) => {
      const response = await h.decide();
      assert.notEqual(
        response.status,
        200,
        `a decision about another ${what} must not be answered as this request's decision: ${response.body}`,
      );
      assert.equal(
        response.status,
        503,
        `a decision naming another ${what} must be refused as unverifiable: ${response.body}`,
      );
      const problem = JSON.parse(response.body) as Problem;
      assert.equal(problem.error.code, 'Unavailable');
      assert.ok(
        problem.error.message.includes(`names ${what} `),
        `the refusal must name the ${what} that does not belong: ${problem.error.message}`,
      );
    });
  }

  // The same decision with every identity correct is recorded, so the three refusals above are
  // about the identity and not about a decision being impossible to return.
  const honest: MvpReviewCardView = {
    ...base,
    decision: {
      outcome: 'changes_requested',
      decision: recorded,
      staleDecisions: [],
      authorizesCurrentCandidate: false,
    },
  };
  await withCard(honest, async (h) => {
    const response = await h.decide();
    assert.equal(response.status, 200, `a decision bound to this candidate must be returned: ${response.body}`);
  });
});

test('F02-AC2, mvp-spec 3: a card about another candidate is refused on the read path', async () => {
  const base = consistentCard();
  await withCard({ ...base, candidate: { ...base.candidate, candidateId: 'cand-somewhere-else' } }, async (h) => {
    await refuses(h, 'a card about a candidate other than the one the path named');
  });
});

test('mvp-spec 3: a head that is not a full commit SHA is refused rather than served', async () => {
  const base = consistentCard();
  for (const head of ['main', HEAD.slice(0, 7), '42']) {
    await withCard({ ...base, candidate: { ...base.candidate, headSha: head } }, async (h) => {
      await refuses(h, `a card whose head is "${head}"`);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* The decision path runs the same checks, and the control proves they are specific */
/* -------------------------------------------------------------------------- */

test('F24-AC4: a decision response carrying a card that contradicts itself is refused too', async () => {
  const base = consistentCard();
  const card: MvpReviewCardView = {
    ...base,
    evidence: [staleEvidence()],
    staleness: { stale: true, reasons: ['evidence no longer applies'], staleEvidenceIds: [UNIT_EVIDENCE], staleDecisionIds: [] },
  };
  await withCard(card, async (h) => {
    const response = await h.decide();
    assert.equal(
      response.status,
      503,
      `a decision must not be answered with a card rendering a stale pass: ${response.body}`,
    );
  });
});

test('F24-AC3: the consistent card this file starts from is served, so each refusal above is specific', async () => {
  await withCard(consistentCard(), async (h) => {
    const response = await h.read();
    assert.equal(response.status, 200, `an honest card must be served: ${response.body}`);
    const body = JSON.parse(response.body) as { readonly review: MvpReviewCardView };
    assert.equal(body.review.candidate.headSha, HEAD);
    assert.equal(body.review.criteria[0]?.state, 'passed');
    assert.equal(body.review.evidence[0]?.countsForCurrentCandidate, true);
  });
});