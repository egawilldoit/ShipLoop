/**
 * Behavioural proof for the review card and the owner decision, against a real database.
 *
 * The stores here are the shipped SQLite repositories over a temporary file, not doubles. The
 * claims under test are about binding and refusal: that a decision names the exact commit it was
 * made against, that an acceptance does not survive a push, and that a candidate from another
 * project is not addressable. A fake store would let all three pass while the product fails at
 * runtime, which is the failure `core.test.ts` documents having already happened.
 *
 * Two facts about the seam are worth stating, because they decide what these tests can prove:
 *
 *   - **Evidence and decisions are written here directly.** No HTTP route records one in the
 *     minimal MVP, so the owner test a fixture needs is written through
 *     `SqliteMvpReviewStore` — the same seam a future evidence producer will use — rather than
 *     through a route this slice does not own.
 *   - **One case uses a store stub, and says so.** `SqliteMvpReviewStore` returns rows for one
 *     candidate identity, and a candidate identity is minted per observation, so the store
 *     cannot currently hand the projection a row bound to a superseded commit. The wire
 *     contract for that state still has to be right, so it is pinned with a stub and the gap is
 *     recorded in the phase report rather than hidden by a weaker assertion.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  approveContract,
  asCommitSha,
  createContractDraft,
  createRequest,
  fingerprint,
  recordMvpEvidence,
  recordMvpOwnerDecision,
} from '@shiploop/domain';
import type {
  CandidateId,
  ContractId,
  DomainError,
  MvpActor,
  MvpOwnerActor,
  OwnerId,
  ProjectId,
  RequestId,
  Result,
} from '@shiploop/domain';
import type { MvpReviewStore } from '@shiploop/storage';
import {
  ContractRepository,
  DeliveryCandidateRepository,
  OwnerRepository,
  ProjectRepository,
  RequestRepository,
  SqliteMvpReviewStore,
  migrate,
  openDatabase,
} from '@shiploop/storage';
import type { Database } from '@shiploop/storage';
import { createMvpReviewCardUseCases } from './mvp-review-card.ts';
import type { MvpReviewCardUseCases } from './mvp-review-card.ts';

const HEAD = asCommitSha('a1b2c3d4'.repeat(5));
const NEXT_HEAD = asCommitSha('f0e1d2c3'.repeat(5));
const BASE_SHA = asCommitSha('0f0f0f0f'.repeat(5));

const OWNER_ID = '2f6a1c40-0000-4000-8000-00000000000c' as OwnerId;
const OWNER: MvpOwnerActor = { role: 'owner', ownerId: OWNER_ID };
const AGENT: MvpActor = { role: 'agent' };

const PROJECT = '4c9b2d51-0000-4000-8000-00000000000a' as ProjectId;
const OTHER_PROJECT = '4c9b2d51-0000-4000-8000-00000000000b' as ProjectId;

const T0 = '2026-10-03T09:00:00Z';
const T1 = '2026-10-03T09:30:00Z';
const T2 = '2026-10-03T10:00:00Z';

const AUTOMATED_CRITERION = {
  id: 'AC1',
  description: 'The unit suite passes.',
  verificationType: 'automated' as const,
};
const OWNER_CRITERION = {
  id: 'AC2',
  description: 'Sign in and land on the dashboard.',
  verificationType: 'owner_test' as const,
};

function expectOk<T>(result: Result<T, DomainError>): T {
  if (!result.ok) assert.fail(`expected success but received ${result.error.code}: ${result.error.reason}`);
  return result.value;
}

function expectErr<T>(result: Result<T, DomainError>): DomainError {
  if (result.ok) assert.fail('expected a refusal');
  return result.error;
}

interface Seed {
  readonly requestId: string;
  readonly contractId: string;
  readonly candidateId: string;
  readonly projectId: ProjectId;
}

/**
 * The commit shape the harness works in.
 *
 * `HEAD`, `NEXT_HEAD` and `BASE_SHA` are all the same 40 hex characters wide, so a fixture
 * cannot drift into an abbreviation and start passing for an identity it no longer is.
 */
type Sha = typeof HEAD;

interface Harness {
  readonly card: MvpReviewCardUseCases;
  readonly db: Database;
  readonly review: SqliteMvpReviewStore;
  /** Appends the observation a push produces: a new candidate identity at a new commit. */
  readonly push: (seed: Seed, headSha: Sha) => CandidateId;
  readonly at: (instant: string) => void;
}

/**
 * One project, one approved revision and one candidate, seeded through the domain constructors
 * the product uses, so the fixtures are the same records the routes would have written.
 */
function seed(
  db: Database,
  options: {
    readonly projectId?: ProjectId;
    readonly requestId: RequestId;
    readonly contractId: ContractId;
    readonly candidateId: CandidateId;
    readonly criteria?: readonly { readonly id: string; readonly description: string; readonly verificationType: 'automated' | 'owner_test' }[];
    readonly headSha?: Sha;
  },
): Seed {
  const projects = new ProjectRepository(db);
  const projectId = options.projectId ?? PROJECT;
  expectOk(projects.create({ projectId, name: `Project ${projectId}`, at: T0 }));
  // The contract revision records its author, and the column is a foreign key into `owners`;
  // without the row the write is refused by the database rather than by a rule under test.
  expectOk(new OwnerRepository(db).provision(OWNER_ID, 'Owner', T0));

  const request = expectOk(
    createRequest({
      requestId: options.requestId,
      projectId,
      title: 'Sign-in lands on the dashboard',
      description: 'After signing in, the owner lands on the dashboard rather than the login form.',
      at: T0,
    }),
  );
  expectOk(new RequestRepository(db).create(request));

  const draft = expectOk(
    createContractDraft({
      contractId: options.contractId,
      projectId,
      requestId: options.requestId,
      revision: 1,
      content: {
        outcome: 'Signing in lands the owner on the dashboard.',
        scope: ['The login form and its redirect.'],
        outOfScope: ['Registration.'],
        acceptanceCriteria: options.criteria ?? [AUTOMATED_CRITERION, OWNER_CRITERION],
      },
      requestFingerprint: fingerprint({
        projectId,
        title: request.title,
        description: request.description,
        sourceIdeaId: request.sourceIdeaId,
      }),
      createdBy: OWNER_ID,
      at: T0,
    }),
  );
  const contracts = new ContractRepository(db);
  expectOk(contracts.createDraft(draft));
  const approved = expectOk(approveContract(draft, { approvedBy: OWNER_ID, at: T0 }));
  expectOk(contracts.approve(approved, draft.updatedAt));

  const head = options.headSha ?? HEAD;
  expectOk(
    new DeliveryCandidateRepository(db).record({
      candidateId: options.candidateId,
      projectId,
      requestId: options.requestId,
      contractId: options.contractId,
      contractRevision: 1,
      provider: 'github',
      repository: 'acme/web',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.invalid/acme/web/pull/42',
      baseBranch: 'main',
      baseSha: BASE_SHA,
      headBranch: 'ship/loop-1',
      headSha: head,
      headRepository: 'acme',
      pullRequestState: 'Open',
      draft: false,
      observedAt: T0,
      correlationId: 'seed-correlation',
    }),
  );

  return { requestId: options.requestId, contractId: options.contractId, candidateId: options.candidateId, projectId };
}

/** Drives the use cases against a real migrated database. */
async function withCard(run: (harness: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-review-card-'));
  try {
    const opened = openDatabase(join(directory, 'review-card.sqlite'));
    assert.ok(opened.ok);
    const db = opened.value;
    expectOk(migrate(db));
    let instant = T0;
    let decisions = 0;
    const review = new SqliteMvpReviewStore(db);
    const card = createMvpReviewCardUseCases({
      clock: { now: () => instant },
      requests: new RequestRepository(db),
      contracts: new ContractRepository(db),
      candidates: new DeliveryCandidateRepository(db),
      review,
      newDecisionId: () => `dec-${(decisions += 1)}`,
      newCorrelationId: () => `corr-${(decisions += 1)}`,
    });
    await run({
      card,
      db,
      review,
      at: (value) => {
        instant = value;
      },
      push: (existing, headSha) => {
        const candidateId = `${existing.candidateId}-pushed` as CandidateId;
        expectOk(
          new DeliveryCandidateRepository(db).record({
            candidateId,
            projectId: PROJECT,
            requestId: existing.requestId,
            contractId: existing.contractId,
            contractRevision: 1,
            provider: 'github',
            repository: 'acme/web',
            pullRequestNumber: 42,
            pullRequestUrl: 'https://example.invalid/acme/web/pull/42',
            baseBranch: 'main',
            baseSha: BASE_SHA,
            headBranch: 'ship/loop-1',
            headSha,
            headRepository: 'acme',
            pullRequestState: 'Open',
            draft: false,
            observedAt: T2,
            correlationId: 'push-correlation',
          }),
        );
        return candidateId;
      },
    });
    db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Records the owner's own test outcome for a criterion, bound to one exact commit.
 *
 * Written through the store rather than through the review use case because no route in this
 * phase records one; the shape is the one `recordOwnerTest` would build (F23-AC1).
 */
function recordOwnerTest(
  harness: Harness,
  input: {
    readonly seed: Seed;
    readonly evidenceId: string;
    readonly criterionId: string;
    readonly headSha: string;
    readonly at: string;
  },
): void {
  const evidence = expectOk(
    recordMvpEvidence({
      evidenceId: input.evidenceId,
      contractId: input.seed.contractId,
      candidateId: input.seed.candidateId,
      subject: { kind: 'criterion', criterionId: input.criterionId },
      method: { kind: 'OwnerTest', instructions: OWNER_CRITERION.description },
      observation: { kind: 'owner_test', outcome: 'passed', actor: OWNER },
      observedHeadSha: input.headSha as typeof HEAD,
      observedContractRevision: 1,
      observedAt: input.at,
      detail: null,
      artifactRef: null,
    }),
  );
  expectOk(
    harness.review.recordEvidence({
      evidence,
      projectId: PROJECT,
      requestId: input.seed.requestId,
      candidateId: input.seed.candidateId,
      candidateHeadSha: input.headSha as typeof HEAD,
      contractId: input.seed.contractId,
      contractRevision: 1,
      recordedAt: input.at,
      correlationId: `corr-${input.evidenceId}`,
      owner: OWNER,
    }),
  );
}

const OWNER_ONLY_SEED = {
  requestId: 'req-review-owner-only' as RequestId,
  contractId: 'contract-review-owner-only' as ContractId,
  candidateId: 'cand-review-owner-only' as CandidateId,
  criteria: [OWNER_CRITERION],
};

test('F24-AC2: the card carries the request, the contract revision, the candidate and its full SHA', async () => {
  await withCard(async (harness) => {
    const stored = seed(harness.db, {
      requestId: 'req-card' as RequestId,
      contractId: 'contract-card' as ContractId,
      candidateId: 'cand-card' as CandidateId,
    });

    const card = expectOk(
      await harness.card.getReview({ projectId: PROJECT, candidateId: stored.candidateId, actor: OWNER }),
    );

    assert.equal(card.request.requestId, stored.requestId);
    assert.equal(card.contract.contractId, stored.contractId);
    assert.equal(card.contract.revision, 1);
    assert.equal(card.contract.status, 'approved');
    assert.equal(card.candidate.candidateId, stored.candidateId);
    assert.equal(card.candidate.headSha, HEAD);
    assert.match(card.candidate.headSha, /^[0-9a-f]{40}$/, 'the head must be a full SHA, not an abbreviation');
    assert.equal(card.candidate.pullRequestState, 'Open');
    assert.equal(card.candidate.pullRequestNumber, 42);
    assert.deepEqual(
      card.contract.acceptanceCriteria.map((criterion) => criterion.id),
      ['AC1', 'AC2'],
      'every criterion the contract declares appears on the card',
    );
    assert.equal(card.contract.approval.approvedAt, T0);
    assert.equal(card.decision.outcome, 'none');
    assert.ok(card.collectedAt.length > 0, 'the card says when it was collected');
  });
});

test('F23-AC1: an automated criterion with no assigned verifier reads unverified, not passed', async () => {
  await withCard(async (harness) => {
    const stored = seed(harness.db, {
      requestId: 'req-verifier' as RequestId,
      contractId: 'contract-verifier' as ContractId,
      candidateId: 'cand-verifier' as CandidateId,
    });

    const card = expectOk(
      await harness.card.getReview({ projectId: PROJECT, candidateId: stored.candidateId, actor: OWNER }),
    );

    const automated = card.criteria.find((criterion) => criterion.criterionId === 'AC1');
    assert.ok(automated !== undefined);
    assert.equal(automated.verificationCheckId, null, 'no criterion is bound to a check by inference');
    assert.equal(automated.state, 'unverified');
    assert.notEqual(automated.state, 'passed');
    assert.ok(
      card.eligibility.acceptanceBlockers.some((reason) => reason.includes('AC1')),
      'the outstanding criterion is named, not merely counted',
    );
  });
});

test('F24-AC3: an owner test nobody ran stays pending and is offered as the owner\'s own action', async () => {
  await withCard(async (harness) => {
    const stored = seed(harness.db, OWNER_ONLY_SEED);

    const card = expectOk(
      await harness.card.getReview({ projectId: PROJECT, candidateId: stored.candidateId, actor: OWNER }),
    );

    assert.equal(card.ownerTests.length, 1, 'the owner test is surfaced as its own list');
    const ownerTest = card.ownerTests[0];
    assert.ok(ownerTest !== undefined);
    assert.equal(ownerTest.criterionId, 'AC2');
    assert.equal(ownerTest.state, 'pending', 'nobody but the owner may settle an owner test');
    assert.equal(ownerTest.evidenceId, null);
    assert.equal(
      card.eligibility.readyForOwnerReview,
      true,
      'a pending owner test does not block the review offer',
    );
    assert.equal(
      card.eligibility.readyForAcceptance,
      false,
      'and it does block acceptance',
    );
    assert.equal(card.eligibility.ownerActions.length, 1, 'the owner is told what is theirs to do');
  });
});

test('F25-AC2: request changes is available while acceptance is refused, and it binds the commit', async () => {
  await withCard(async (harness) => {
    const stored = seed(harness.db, OWNER_ONLY_SEED);

    const refused = expectErr(
      await harness.card.decide({
        projectId: PROJECT,
        candidateId: stored.candidateId,
        actor: OWNER,
        decision: 'accepted',
        expectedHeadSha: HEAD,
        expectedContractRevision: 1,
        feedback: null,
      }),
    );
    assert.equal(refused.code, 'Blocked', 'accepting is refused while a criterion is outstanding');
    assert.ok(refused.code === 'Blocked' && refused.prerequisites.length > 0, 'every outstanding item is named');

    const requested = expectOk(
      await harness.card.decide({
        projectId: PROJECT,
        candidateId: stored.candidateId,
        actor: OWNER,
        decision: 'changes_requested',
        expectedHeadSha: HEAD,
        expectedContractRevision: 1,
        feedback: 'The redirect still lands on the login form.',
      }),
    );

    assert.equal(requested.decision.outcome, 'changes_requested');
    const decision = requested.decision.decision;
    assert.ok(decision !== null);
    assert.equal(decision.candidateHeadSha, HEAD, 'the decision names the exact commit it was made against');
    assert.equal(decision.contractRevision, 1);
    assert.equal(decision.contractId, stored.contractId);
    assert.equal(decision.requestId, stored.requestId);
    assert.equal(decision.candidateId, stored.candidateId);
    assert.equal(decision.ownerId, OWNER_ID, 'the decision is attributed to the authenticated owner');
    assert.equal(decision.decidedAt, T0, 'and to the instant it was recorded');
    assert.equal(decision.feedback, 'The redirect still lands on the login form.');
  });
});

test('F24-AC4: a decision prepared against an earlier commit is refused, not applied to the new head', async () => {
  await withCard(async (harness) => {
    const stored = seed(harness.db, OWNER_ONLY_SEED);

    const refusal = expectErr(
      await harness.card.decide({
        projectId: PROJECT,
        candidateId: stored.candidateId,
        actor: OWNER,
        decision: 'changes_requested',
        expectedHeadSha: BASE_SHA,
        expectedContractRevision: 1,
        feedback: 'Reviewed against a commit this candidate is no longer on.',
      }),
    );

    assert.equal(refusal.code, 'Conflict');
    assert.equal(refusal.code === 'Conflict' ? refusal.expected : null, BASE_SHA);
    assert.equal(refusal.code === 'Conflict' ? refusal.actual : null, HEAD);

    const unchanged = expectOk(
      await harness.card.getReview({ projectId: PROJECT, candidateId: stored.candidateId, actor: OWNER }),
    );
    assert.equal(
      unchanged.decision.outcome,
      'none',
      'a refused submission leaves no decision behind',
    );
  });
});

test('F25-AC1: once the owner test is recorded, the acceptance binds that exact commit', async () => {
  await withCard(async (harness) => {
    const stored = seed(harness.db, OWNER_ONLY_SEED);
    harness.at(T1);
    recordOwnerTest(harness, {
      seed: stored,
      evidenceId: 'evid-owner-pass',
      criterionId: 'AC2',
      headSha: HEAD,
      at: T1,
    });

    const accepted = expectOk(
      await harness.card.decide({
        projectId: PROJECT,
        candidateId: stored.candidateId,
        actor: OWNER,
        decision: 'accepted',
        expectedHeadSha: HEAD,
        expectedContractRevision: 1,
        feedback: null,
      }),
    );

    assert.equal(accepted.decision.outcome, 'accepted');
    assert.equal(
      accepted.decision.authorizesCurrentCandidate,
      true,
      'an acceptance authorises the candidate it was made against',
    );
    assert.equal(accepted.eligibility.readyForAcceptance, true);
    assert.equal(accepted.eligibility.readyForDelivery, true, 'accepted is the last gate the MVP reaches');
  });
});

test('F25-AC3: a push refuses a second acceptance of the same commit and reopens the owner test', async () => {
  await withCard(async (harness) => {
    const stored = seed(harness.db, OWNER_ONLY_SEED);
    recordOwnerTest(harness, {
      seed: stored,
      evidenceId: 'evid-owner-pass',
      criterionId: 'AC2',
      headSha: HEAD,
      at: T1,
    });
    expectOk(
      await harness.card.decide({
        projectId: PROJECT,
        candidateId: stored.candidateId,
        actor: OWNER,
        decision: 'accepted',
        expectedHeadSha: HEAD,
        expectedContractRevision: 1,
        feedback: null,
      }),
    );

    harness.at(T2);
    const pushed = harness.push(stored, NEXT_HEAD);

    const refused = expectErr(
      await harness.card.decide({
        projectId: PROJECT,
        candidateId: pushed,
        actor: OWNER,
        decision: 'accepted',
        expectedHeadSha: HEAD,
        expectedContractRevision: 1,
        feedback: null,
      }),
    );
    assert.equal(refused.code, 'Conflict', 'the acceptance of SHA A cannot be re-applied to SHA B');
    assert.equal(refused.code === 'Conflict' ? refused.expected : null, HEAD);
    assert.equal(refused.code === 'Conflict' ? refused.actual : null, NEXT_HEAD);

    const afterPush = expectOk(
      await harness.card.getReview({ projectId: PROJECT, candidateId: pushed, actor: OWNER }),
    );
    assert.equal(afterPush.candidate.headSha, NEXT_HEAD);
    assert.equal(
      afterPush.decision.outcome,
      'none',
      'the new commit carries no decision of its own',
    );
    assert.equal(
      afterPush.ownerTests[0]?.state,
      'pending',
      'the owner test for the old commit does not settle the new one',
    );

    const blocked = expectErr(
      await harness.card.decide({
        projectId: PROJECT,
        candidateId: pushed,
        actor: OWNER,
        decision: 'accepted',
        expectedHeadSha: NEXT_HEAD,
        expectedContractRevision: 1,
        feedback: null,
      }),
    );
    assert.equal(blocked.code, 'Blocked', 'the new commit needs its own owner test before acceptance');
  });
});

test('F25-AC4: an owner actor carrying no identity decides nothing, on either method', async () => {
  await withCard(async (harness) => {
    const stored = seed(harness.db, OWNER_ONLY_SEED);

    // `role: 'owner'` with an empty identity is the shape a forged body would produce if the
    // transport ever read the deciding owner from the request instead of the session. The role
    // claims owner and the identity says nobody, and the identity is what the decision is
    // attributed to - so it is refused rather than narrowed or defaulted (F01-AC1, F25-AC4).
    //
    // A *well-formed* id nobody provisioned is a different case and is not asserted here: it
    // is unreachable over HTTP, because the only owner id this transport can carry is the one
    // on a stored session row and that column is a foreign key into `owners`. Asserting it
    // here would pin a rule the use case does not and should not own.
    const anonymous: MvpOwnerActor = { role: 'owner', ownerId: '' as OwnerId };
    const calls: readonly {
      readonly name: string;
      readonly call: () => Promise<Result<unknown, DomainError>>;
    }[] = [
      {
        name: 'decide',
        call: () =>
          harness.card.decide({
            projectId: PROJECT,
            candidateId: stored.candidateId,
            actor: anonymous,
            decision: 'changes_requested',
            expectedHeadSha: HEAD,
            expectedContractRevision: 1,
            feedback: 'Decided by nobody.',
          }),
      },
      {
        name: 'getReview',
        call: () => harness.card.getReview({ projectId: PROJECT, candidateId: stored.candidateId, actor: anonymous }),
      },
    ];
    for (const entry of calls) {
      const refused = expectErr(await entry.call());
      assert.equal(refused.code, 'Forbidden', `${entry.name} must refuse an owner carrying no identity`);
      assert.ok(
        !refused.reason.includes(stored.candidateId),
        `the ${entry.name} refusal must not name the candidate it hid: ${refused.reason}`,
      );
    }

    // And the owner that does exist is unaffected: refusing an unattributed actor must not
    // have narrowed what a real owner may do.
    const changed = expectOk(
      await harness.card.decide({
        projectId: PROJECT,
        candidateId: stored.candidateId,
        actor: OWNER,
        decision: 'changes_requested',
        expectedHeadSha: HEAD,
        expectedContractRevision: 1,
        feedback: 'Decided as the owner the session proved.',
      }),
    );
    assert.equal(changed.decision.outcome, 'changes_requested');
    assert.equal(
      changed.decision.decision?.ownerId,
      OWNER_ID,
      'and it is attributed to the actor that made it, not to a refused one',
    );
  });
});

test('F25-AC4: an agent may not decide, and the refusal says nothing about the candidate', async () => {
  await withCard(async (harness) => {
    const stored = seed(harness.db, OWNER_ONLY_SEED);

    const refused = expectErr(
      await harness.card.decide({
        projectId: PROJECT,
        candidateId: stored.candidateId,
        actor: AGENT,
        decision: 'accepted',
        expectedHeadSha: HEAD,
        expectedContractRevision: 1,
        feedback: null,
      }),
    );
    assert.equal(refused.code, 'Forbidden');
    assert.ok(!refused.reason.includes(HEAD), 'the refusal must not echo the commit it refused');
    assert.ok(!refused.reason.includes(stored.candidateId), 'nor the candidate identity');

    const alsoRefused = expectErr(
      await harness.card.getReview({ projectId: PROJECT, candidateId: stored.candidateId, actor: AGENT }),
    );
    assert.equal(alsoRefused.code, 'Forbidden', 'only the owner reads a review card');

    const unchanged = expectOk(
      await harness.card.getReview({ projectId: PROJECT, candidateId: stored.candidateId, actor: OWNER }),
    );
    assert.equal(unchanged.decision.outcome, 'none', 'no decision was created by the refused actor');
  });
});

test('F02-AC2: a candidate recorded against another project is not found here', async () => {
  await withCard(async (harness) => {
    const stored = seed(harness.db, {
      requestId: 'req-owned' as RequestId,
      contractId: 'contract-owned' as ContractId,
      candidateId: 'cand-owned' as CandidateId,
    });

    const refused = expectErr(
      await harness.card.getReview({ projectId: OTHER_PROJECT, candidateId: stored.candidateId, actor: OWNER }),
    );
    assert.equal(refused.code, 'NotFound', 'a candidate is addressed by its own project, never by id alone');

    const decided = expectErr(
      await harness.card.decide({
        projectId: OTHER_PROJECT,
        candidateId: stored.candidateId,
        actor: OWNER,
        decision: 'changes_requested',
        expectedHeadSha: HEAD,
        expectedContractRevision: 1,
        feedback: 'Reached for across a project boundary.',
      }),
    );
    assert.equal(decided.code, 'NotFound');

    const unknown = expectErr(
      await harness.card.getReview({ projectId: PROJECT, candidateId: 'cand-nobody-recorded' as CandidateId, actor: OWNER }),
    );
    assert.equal(unknown.code, 'NotFound');
  });
});

test('F20-AC3: an observation bound to another commit is reported as history, never as a current pass', async () => {
  // The store returns rows for one candidate identity, so a row bound to a superseded commit
  // cannot be produced through it today. The wire contract for that state still has to hold, so
  // it is pinned here against a store that returns one, and the gap is in the phase report.
  const staleEvidence = expectOk(
    recordMvpEvidence({
      evidenceId: 'evid-stale',
      contractId: 'contract-stale',
      candidateId: 'cand-stale',
      subject: { kind: 'criterion', criterionId: 'AC2' },
      method: { kind: 'OwnerTest', instructions: OWNER_CRITERION.description },
      observation: { kind: 'owner_test', outcome: 'passed', actor: OWNER },
      observedHeadSha: BASE_SHA,
      observedContractRevision: 1,
      observedAt: T1,
      detail: null,
      artifactRef: null,
    }),
  );
  const store = {
    recordEvidence: () => ({ ok: true, value: { evidenceId: 'unused' } }),
    recordDecision: () => ({ ok: true, value: { decisionId: 'unused' } }),
    readProjection: () => ({ ok: true, value: { evidence: [staleEvidence], decisions: [] } }),
  } satisfies MvpReviewStore;

  await withCard(async (harness) => {
    const stored = seed(harness.db, OWNER_ONLY_SEED);
    const card = createMvpReviewCardUseCases({
      clock: { now: () => T2 },
      requests: new RequestRepository(harness.db),
      contracts: new ContractRepository(harness.db),
      candidates: new DeliveryCandidateRepository(harness.db),
      review: store,
      newDecisionId: () => 'dec-stale',
      newCorrelationId: () => 'corr-stale',
    });

    const projected = expectOk(
      await card.getReview({ projectId: PROJECT, candidateId: stored.candidateId, actor: OWNER }),
    );

    const evidence = projected.evidence[0];
    assert.ok(evidence !== undefined);
    assert.equal(
      evidence.recordedOutcome,
      'passed',
      'what the source said at the time is history and keeps its value',
    );
    assert.equal(evidence.currentOutcome, 'stale', 'and it no longer counts for this candidate');
    assert.equal(evidence.countsForCurrentCandidate, false);
    assert.ok(evidence.staleReasons.length > 0, 'the reason it no longer counts is named');
    assert.ok(
      !('outcome' in evidence),
      'the wire carries no bare `outcome` a client could render as a current pass',
    );
    assert.equal(
      projected.ownerTests[0]?.state,
      'stale',
      'and the criterion it spoke for does not read as passed',
    );
    assert.equal(projected.staleness.stale, true);
    assert.deepEqual(projected.staleness.staleEvidenceIds, ['evid-stale']);
  });
});

test('F02-AC2, F20-AC3: the card is proved to belong to the project that asked for it, at every level', async () => {
  await withCard(async (harness) => {
    const stored = seed(harness.db, OWNER_ONLY_SEED);
    const card = expectOk(
      await harness.card.getReview({ projectId: PROJECT, candidateId: stored.candidateId, actor: OWNER }),
    );

    // The candidate is the one thing `readFacts` refuses on project identity, and it is the
    // only element whose project membership the other facts are derived from. So the other
    // three are asserted here to pin the shape a client relies on: each names its own
    // project, so "which project is this card about" has one answer rather than four that
    // could be read independently (F02-AC2).
    assert.equal(card.candidate.projectId, PROJECT, 'the candidate names the project it was read under');
    assert.equal(card.request.projectId, PROJECT, 'and the request it belongs to agrees');
    assert.equal(card.contract.projectId, PROJECT, 'and so does the contract revision');
    assert.equal(card.candidate.requestId, stored.requestId, 'the candidate points at the request on the card');
    assert.equal(card.candidate.contractId, stored.contractId);
    assert.equal(card.candidate.contractRevision, card.contract.revision, 'the candidate and the card agree on the revision');
    assert.equal(card.request.requestId, card.contract.requestId, 'the contract belongs to the request on the card');
  });
});

test('F20-AC3, F24-AC3: a card carrying evidence from two projects cannot be read through one path', async () => {
  // The transport re-checks project membership on every element of a card before returning
  // it, because a projection assembled from several reads could otherwise mix a project in.
  // The shape that makes that check meaningful is pinned here: every element carries its own
  // project id rather than sharing one derived from the request (F02-AC2).
  await withCard(async (harness) => {
    const stored = seed(harness.db, OWNER_ONLY_SEED);
    const card = expectOk(
      await harness.card.getReview({ projectId: PROJECT, candidateId: stored.candidateId, actor: OWNER }),
    );
    const projects = new Set([
      card.request.projectId,
      card.contract.projectId,
      card.candidate.projectId,
    ]);
    assert.equal(projects.size, 1, `a card must not mix projects; it carries ${[...projects].join(', ')}`);
  });
});

test('F25-AC3: a decision that no longer describes the candidate is surfaced, not dropped', async () => {
  // Same seam and same reason as the case above: the projection must render a stale decision,
  // and its `staleDecisions` list must be present on every card even when it is empty.
  const decision = expectOk(
    recordMvpOwnerDecision({
      decisionId: 'dec-superseded',
      kind: 'accepted',
      actor: OWNER,
      projectId: PROJECT,
      requestId: OWNER_ONLY_SEED.requestId,
      contractId: OWNER_ONLY_SEED.contractId,
      contractRevision: 1,
      candidateId: OWNER_ONLY_SEED.candidateId,
      candidateHeadSha: BASE_SHA,
      decidedAt: T1,
      feedback: null,
    }),
  );
  const store = {
    recordEvidence: () => ({ ok: true, value: { evidenceId: 'unused' } }),
    recordDecision: () => ({ ok: true, value: { decisionId: 'unused' } }),
    readProjection: () => ({ ok: true, value: { evidence: [], decisions: [decision] } }),
  } satisfies MvpReviewStore;

  await withCard(async (harness) => {
    const stored = seed(harness.db, OWNER_ONLY_SEED);
    const card = createMvpReviewCardUseCases({
      clock: { now: () => T2 },
      requests: new RequestRepository(harness.db),
      contracts: new ContractRepository(harness.db),
      candidates: new DeliveryCandidateRepository(harness.db),
      review: store,
      newDecisionId: () => 'dec-stale',
      newCorrelationId: () => 'corr-stale',
    });

    const projected = expectOk(
      await card.getReview({ projectId: PROJECT, candidateId: stored.candidateId, actor: OWNER }),
    );

    assert.deepEqual(projected.decision.decision, null, 'a superseded acceptance governs nothing');
    assert.equal(projected.decision.outcome, 'none');
    assert.equal(
      projected.decision.authorizesCurrentCandidate,
      false,
      'and it authorises nothing either',
    );
    assert.equal(projected.decision.staleDecisions.length, 1, 'the owner still sees that they accepted something');
    const stale = projected.decision.staleDecisions[0];
    assert.ok(stale !== undefined);
    assert.equal(stale.decisionId, 'dec-superseded');
    assert.equal(stale.kind, 'accepted');
    assert.equal(stale.candidateHeadSha, BASE_SHA);
    assert.ok(stale.reason.length > 0);
    assert.deepEqual(projected.staleness.staleDecisionIds, ['dec-superseded']);
    assert.equal(projected.eligibility.readyForDelivery, false);
  });
});
