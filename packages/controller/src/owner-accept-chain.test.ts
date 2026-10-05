/**
 * The owner's journey, driven end to end against a real database, and the five things that
 * must still be true after the build moves.
 *
 * The other files here prove the parts. This one proves the *chain*, because the properties
 * only exist in the order: a criterion bound to a stable check identity, an automated pass on
 * one exact commit, an owner test the owner has not yet run, an acceptance the owner has not
 * yet made, and then a push that moves all of it at once. A suite that proves each link in
 * isolation proves nothing about the seam between them.
 *
 * Everything is the shipped surface. The project, request, contract revision and approval go
 * through the domain constructors and the real SQLite repositories; the candidate is a real
 * `delivery_candidates` row; the automated verdict comes from `recordVerification` reading the
 * scripted git port below and deriving it with `recordGitHubProjection`; the owner test comes
 * from `recordOwnerTest`; the acceptance comes from `decide`. No case in this file can hand a
 * use case an outcome, and none of them asserts `readyForAcceptance` on a hand-built object —
 * every readiness answer below was computed by `buildMvpReviewReadModel` over rows that were
 * really written (F20-AC2, F23-AC1, F24-AC3).
 *
 * The chain, in the order the cases walk it:
 *
 *   1. an approved revision declares **both** an automated criterion bound to `unit-tests`
 *      and an `owner_test` criterion, so neither can be discharged by the other;
 *   2. candidate SHA A is recorded against that revision;
 *   3. the provider reports `unit-tests` passing, and the derived row is bound to SHA A;
 *   4. the owner test is still pending, so acceptance is refused and both halves of the
 *      refusal are checked separately — a passing automated criterion does not carry an
 *      outstanding owner test, and a passed owner test does not carry an unmet one;
 *   5. the owner records their own test against SHA A, and acceptance opens;
 *   6. `decide` accepts exactly SHA A, and the decision is read back out of SQLite;
 *   7. a push records SHA B, and the five staleness properties are asserted against real rows.
 *
 * One seam is widened deliberately, and it is named at the point of use: `SqliteMvpReviewStore`
 * filters evidence by `candidate_id`, so it cannot hand a projection a row bound to a
 * superseded commit. That filter is a legitimate first line of defence, and it is not the one
 * under test here — the domain's SHA comparison is, so `handedOver` widens only the read and
 * everything downstream of it is still the shipped code. Reads are real; the query is not.
 *
 * Writing this file found a hole the per-link suites had not: the review card's `decide`
 * compared the submitted commit against the named candidate's own row, which always agrees on a
 * superseded candidate, and so accepted SHA A happily after the pull request had moved to SHA B.
 * `staleSubmission` answers "is this the commit I was shown?"; nothing answered "is this still
 * the build under review?". The guard is `supersededCandidate` in `mvp-review-card.ts`, and the
 * case below is what it is for — the same refusal is pinned over HTTP in `review.test.ts`, where
 * the route is the surface that would have carried the false acceptance.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  approveContract,
  asCommitSha,
  contractContentFingerprint,
  createContractDraft,
  createRequest,
  fingerprint,
} from '@shiploop/domain';
import type {
  CandidateId,
  CheckResult,
  CommitSha,
  ContractId,
  DomainError,
  MvpActor,
  MvpOwnerActor,
  OwnerId,
  ProjectId,
  RequestId,
  Result,
} from '@shiploop/domain';
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
import type { Database, DeliveryCandidateRecord, MvpReviewStore } from '@shiploop/storage';
import { createMvpReviewCardUseCases } from './mvp-review-card.ts';
import type {
  MvpLiveCandidateReader,
  MvpReviewCard,
  MvpReviewCardUseCases,
  MvpReviewCardDeps,
  MvpVerificationReport,
} from './mvp-review-card.ts';
import type { CandidateView } from './candidate-linking.ts';

/** SHA A: the build the owner looked at, tested and accepted. */
const HEAD_A = asCommitSha('a1b2c3d4'.repeat(5));
/** SHA B: the same pull request after a push. */
const HEAD_B = asCommitSha('f0e1d2c3'.repeat(5));
/** The merge base both heads sit on, so a push moves only the head. */
const BASE_SHA = asCommitSha('0f0f0f0f'.repeat(5));

const OWNER_ID = '2f6a1c40-0000-4000-8000-00000000000c' as OwnerId;
const OWNER: MvpOwnerActor = { role: 'owner', ownerId: OWNER_ID };
/** A role with no owner identity, so nothing it could record would be attributable (F25-AC4). */
const AGENT: MvpActor = { role: 'agent' };

const PROJECT = '4c9b2d51-0000-4000-8000-00000000000a' as ProjectId;

const T0 = '2026-10-03T09:00:00Z';
const T1 = '2026-10-03T09:30:00Z';
const T2 = '2026-10-03T10:00:00Z';
const T3 = '2026-10-03T11:00:00Z';

/** The check the automated criterion is bound to, named by the contract revision itself. */
const BOUND_CHECK = 'unit-tests';
const AUTOMATED_CRITERION = 'AC1';
const OWNER_CRITERION = 'AC2';

const REQUEST_ID = 'req-chain' as RequestId;
const CONTRACT_ID = 'contract-chain' as ContractId;
const CANDIDATE_A = 'cand-chain-a' as CandidateId;
const CANDIDATE_B = 'cand-chain-b' as CandidateId;

/** Contract revision 1's content, and its two criteria with their own verification types. */
const CONTRACT_CONTENT = {
  outcome: 'Signing in lands the owner on the dashboard.',
  scope: ['The login form and its redirect.'],
  outOfScope: ['Registration.'],
  acceptanceCriteria: [
    {
      id: AUTOMATED_CRITERION,
      description: 'The unit suite passes.',
      verificationType: 'automated' as const,
      // The stable verification identity. A check *run* id would not survive a re-run, so the
      // criterion names the check the project runs and the projection resolves it against the
      // results recorded for this exact commit (F23-AC1).
      verificationCheckId: BOUND_CHECK,
    },
    {
      id: OWNER_CRITERION,
      description: 'Sign in and land on the dashboard.',
      verificationType: 'owner_test' as const,
      verificationCheckId: null,
    },
  ],
};

function expectOk<T>(result: Result<T, DomainError>, what = 'the call'): T {
  if (!result.ok) assert.fail(`${what} failed with ${result.error.code}: ${result.error.reason}`);
  return result.value;
}

function expectErr<T>(result: Result<T, DomainError>): DomainError {
  if (result.ok) assert.fail('expected a refusal');
  return result.error;
}

/**
 * The blockers a `Blocked` refusal names, as `criterion id -> state`.
 *
 * Read as a map rather than compared as prose so the assertion pins the two facts that carry
 * the rule - which criterion is outstanding, and what it currently reads - while leaving the
 * sentence the domain writes around them free to improve. A refusal that named no criterion
 * would fail this, which is the property that matters (F24-AC3).
 */
function blockersOf(error: DomainError): Readonly<Record<string, string>> {
  assert.equal(error.code, 'Blocked', `expected a readiness refusal but received ${error.code}: ${error.reason}`);
  const blockers: Record<string, string> = {};
  for (const entry of error.code === 'Blocked' ? error.prerequisites : []) {
    const match = /^Criterion "([^"]+)" is ([a-z_]+):/.exec(entry.detail);
    assert.ok(match !== null, `a blocker names its criterion and its state: ${entry.detail}`);
    blockers[match[1] as string] = match[2] as string;
  }
  return blockers;
}

/* -------------------------------------------------------------------------- */
/* The scripted git port                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The provider, scripted at the narrowest seam available.
 *
 * It answers exactly two reads and can do nothing else, so a verdict can only exist because
 * the provider said something and `recordGitHubProjection` derived it. `headSha` is mutable so
 * a case can move the pull request and observe what the product does about it, and `checks`
 * is mutable so a case can report a verdict for a commit other than the candidate's — which is
 * the state F20-AC3 turns on and which a fixture could not otherwise reach (F20-AC2).
 */
class ScriptedProvider {
  /** The commit the pull request holds, and the commit every check below was read for. */
  headSha: CommitSha = HEAD_A;
  /** What the provider reports, by name. Empty is "nothing ran". */
  checks: readonly { readonly name: string; readonly result: CheckResult }[] = [];
  /**
   * When this read happened, which is the timestamp the derived rows are dated with.
   *
   * Mutable because "the observation that counts is the newest one" is a comparison on this
   * value: two reads at the same instant are ordered by row identity instead, and a case that
   * wanted to show a correction superseding an earlier verdict would be testing that tie-break
   * rather than the rule it means to (F23-AC5).
   */
  observedAt: string = T1;
  /** Set to make the provider stop answering, which must record nothing (F03-AC2). */
  failure: DomainError | null = null;

  asReader(): MvpLiveCandidateReader {
    return async (input): Promise<Result<CandidateView, DomainError>> => {
      if (this.failure !== null) return { ok: false, error: this.failure };
      const moved = this.headSha !== HEAD_A;
      const facts = {
        provider: 'github' as const,
        repository: 'acme/web',
        pullRequestNumber: 42,
        pullRequestUrl: 'https://example.invalid/acme/web/pull/42',
        baseBranch: 'main',
        baseSha: BASE_SHA,
        headBranch: 'ship/loop-1',
        headRepository: 'acme',
        pullRequestState: 'Open' as const,
        draft: false,
      };
      return {
        ok: true,
        value: {
          candidate: {
            ...facts,
            candidateId: input.requestId === REQUEST_ID ? CANDIDATE_B : CANDIDATE_A,
            projectId: PROJECT,
            requestId: input.requestId,
            contractId: CONTRACT_ID,
            contractRevision: 1,
            headSha: HEAD_A,
            observedAt: T0,
            linkedAt: T0,
          },
          live: { ...facts, headSha: this.headSha, providerPullRequestId: 'pr_42', observedAt: this.observedAt },
          binding: { contractId: CONTRACT_ID, contractRevision: 1, headSha: HEAD_A },
          bindingFingerprint: fingerprint({ contractId: CONTRACT_ID, revision: 1, head: HEAD_A }),
          change: {
            kind: moved ? 'HeadChanged' : 'Unchanged',
            changed: moved ? ['HeadChanged'] : [],
            changedAnything: moved,
            previousHeadSha: HEAD_A,
            currentHeadSha: this.headSha,
            priorEvidenceStale: moved,
            detail: 'scripted',
          },
          priorEvidenceStale: moved,
          previousCandidateId: moved ? CANDIDATE_A : null,
          previousHeadSha: moved ? HEAD_A : null,
          supersededCandidates: moved ? [CANDIDATE_A] : [],
          checks: this.checks.map((entry) => ({
            name: entry.name,
            result: entry.result,
            required: true,
            notApplicableApprovedByPolicy: false,
            startedAt: this.observedAt,
            endedAt: this.observedAt,
            artifactUrl: null,
            detail: `${entry.name} reported ${entry.result}`,
            observedHeadSha: null,
          })),
          checksReady: false,
          blockingChecks: [],
          reviewReadiness: { ready: false, reasons: ['scripted'] },
          observedAt: this.observedAt,
        },
      };
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Chain {
  readonly card: MvpReviewCardUseCases;
  readonly db: Database;
  readonly provider: ScriptedProvider;
  /** Records a replacement candidate for the same request, which is what a push produces. */
  readonly push: (candidateId: CandidateId, headSha: CommitSha) => DeliveryCandidateRecord;
  /** The candidate the request currently offers, read from the store rather than remembered. */
  readonly currentCandidateFor: () => DeliveryCandidateRecord;
  /** One card, for one candidate, as the owner sees it. */
  readonly cardFor: (candidateId: CandidateId) => Promise<MvpReviewCard>;
  /** How many evidence rows the real store holds for one candidate. */
  readonly evidenceRowsFor: (candidateId: CandidateId) => number;
  /** Every decision row the real store holds for one candidate, oldest first. */
  readonly decisionRowsFor: (candidateId: CandidateId) => readonly {
    readonly decisionId: string;
    readonly kind: string;
    readonly ownerId: string;
    readonly candidateHeadSha: string;
    readonly contractRevision: number;
    readonly decidedAt: string;
  }[];
  /** Accept, naming exactly the commit and revision the card was rendered against. */
  readonly accept: (candidateId: CandidateId, headSha: string, revision?: number) => Promise<Result<MvpReviewCard, DomainError>>;
  /** Scripts the provider's next read and drives it, so every row is really written. */
  readonly reportChecks: (
    checks: readonly { readonly name: string; readonly result: CheckResult }[],
    at: string,
    candidateId?: CandidateId,
  ) => Promise<MvpVerificationReport>;
  at: (instant: string) => void;
}

/** A store whose *read* is widened to also return an earlier candidate's rows. Writes delegate. */
function handedOver(real: SqliteMvpReviewStore, earlier: CandidateId): MvpReviewStore {
  return {
    recordEvidence: (input) => real.recordEvidence(input),
    recordDecision: (input) => real.recordDecision(input),
    readProjection: (input) => {
      const own = real.readProjection(input);
      if (!own.ok) return own;
      const previous = real.readProjection({ ...input, candidateId: earlier });
      if (!previous.ok) return previous;
      return { ok: true, value: { evidence: [...own.value.evidence, ...previous.value.evidence], decisions: own.value.decisions } };
    },
  };
}

async function withChain(run: (chain: Chain) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-accept-chain-'));
  const opened = openDatabase(join(directory, 'chain.sqlite'));
  assert.ok(opened.ok, `the real database opened: ${opened.ok ? '' : opened.error.reason}`);
  const db = opened.value;
  try {
    expectOk(migrate(db));

    expectOk(new ProjectRepository(db).create({ projectId: PROJECT, name: 'Chain', at: T0 }));
    expectOk(new OwnerRepository(db).provision(OWNER_ID, 'Owner', T0));

    const request = expectOk(
      createRequest({
        requestId: REQUEST_ID,
        projectId: PROJECT,
        title: 'Sign-in lands on the dashboard',
        description: 'After signing in, the owner lands on the dashboard.',
        at: T0,
      }),
    );
    expectOk(new RequestRepository(db).create(request));

    const draft = expectOk(
      createContractDraft({
        contractId: CONTRACT_ID,
        projectId: PROJECT,
        requestId: REQUEST_ID,
        revision: 1,
        content: CONTRACT_CONTENT,
        requestFingerprint: fingerprint({
          projectId: PROJECT,
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
    // The approval names the fingerprint the owner reviewed, so the revision is sealed at an
    // exact content identity rather than "whatever is in the row now" (F24-AC4).
    const reviewed = contractContentFingerprint(draft);
    const approved = expectOk(
      approveContract(draft, {
        approvedBy: OWNER_ID,
        at: T0,
        expectedContentFingerprint: reviewed,
        newestRevisionForRequest: draft.revision,
      }),
    );
    expectOk(contracts.approve(approved, { updatedAt: draft.updatedAt, contentFingerprint: reviewed }));

    const candidates = new DeliveryCandidateRepository(db);
    const recordCandidate = (candidateId: CandidateId, headSha: CommitSha, observedAt: string): DeliveryCandidateRecord =>
      expectOk(
        candidates.record({
          candidateId,
          projectId: PROJECT,
          requestId: REQUEST_ID,
          contractId: CONTRACT_ID,
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
          observedAt,
          correlationId: 'corr-chain',
        }),
      ).candidate;
    recordCandidate(CANDIDATE_A, HEAD_A, T0);

    const provider = new ScriptedProvider();
    const store = new SqliteMvpReviewStore(db);
    let instant = T0;
    let serial = 0;
    const base: MvpReviewCardDeps = {
      clock: { now: () => instant },
      requests: new RequestRepository(db),
      contracts,
      candidates,
      review: store,
      newDecisionId: () => `dec-chain-${(serial += 1)}`,
      newCorrelationId: () => `corr-chain-${(serial += 1)}`,
      readLiveCandidate: provider.asReader(),
    };

    await run({
      card: createMvpReviewCardUseCases(base),
      db,
      provider,
      push: (candidateId, headSha) => {
        // The provider moves first, so the new row is what the provider reported rather than
        // what the fixture wished for. `record` is idempotent on the whole fact set, so a
        // repeated read of the same state cannot present itself as a new candidate.
        provider.headSha = headSha;
        return recordCandidate(candidateId, headSha, T2);
      },
      currentCandidateFor: () => {
        const current = expectOk(candidates.currentForRequest(REQUEST_ID), 'read the request\'s current candidate');
        assert.ok(current !== null, 'the request has a current candidate: one was recorded when it was seeded');
        return current;
      },
      cardFor: async (candidateId) =>
        expectOk(await createMvpReviewCardUseCases(base).getReview({ projectId: PROJECT, candidateId, actor: OWNER })),
      evidenceRowsFor: (candidateId) =>
        expectOk(
          store.readProjection({
            candidateId,
            candidateHeadSha: HEAD_A,
            contractId: CONTRACT_ID,
            contractRevision: 1,
          }),
          'read the stored projection',
        ).evidence.length,
      decisionRowsFor: (candidateId) => {
        const rows = db
          .prepare(
            `SELECT decision_id, kind, owner_id, candidate_head_sha, contract_revision, decided_at
               FROM mvp_owner_decisions WHERE candidate_id = ? ORDER BY decided_at ASC, decision_id ASC`,
          )
          .all(candidateId);
        return rows.map((row) => ({
          decisionId: String(row['decision_id']),
          kind: String(row['kind']),
          ownerId: String(row['owner_id']),
          candidateHeadSha: String(row['candidate_head_sha']),
          contractRevision: Number(row['contract_revision']),
          decidedAt: String(row['decided_at']),
        }));
      },
      accept: async (candidateId, headSha, revision = 1) =>
        createMvpReviewCardUseCases(base).decide({
          projectId: PROJECT,
          candidateId,
          actor: OWNER,
          decision: 'accepted',
          expectedHeadSha: headSha,
          expectedContractRevision: revision,
          feedback: null,
        }),
      reportChecks: async (checks, at, candidateId = CANDIDATE_A) => {
        instant = at;
        provider.checks = checks;
        provider.observedAt = at;
        return expectOk(
          await createMvpReviewCardUseCases(base).recordVerification({
            projectId: PROJECT,
            candidateId,
            actor: OWNER,
            correlationId: `corr-provider-${candidateId}-${at}`,
          }),
          'record the provider read',
        );
      },
      at: (value) => {
        instant = value;
      },
    });
    db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Drives the chain up to an acceptance of SHA A.
 *
 * The same steps, in the same order, in every case that needs the owner looking at an accepted
 * build: the provider reports the bound check passing for SHA A, and then the owner records
 * their own test. Returns the card the acceptance produced so a case can assert on the state it
 * inherited rather than re-deriving it.
 */
async function acceptShaA(chain: Chain): Promise<MvpReviewCard> {
  await chain.reportChecks([{ name: BOUND_CHECK, result: 'Passed' }], T1);
  chain.at(T2);
  expectOk(
    await chain.card.recordOwnerTest({
      projectId: PROJECT,
      candidateId: CANDIDATE_A,
      actor: OWNER,
      criterionId: OWNER_CRITERION,
      outcome: 'passed',
      note: 'Signed in and landed on the dashboard.',
      correlationId: 'corr-b',
    }),
  );
  chain.at(T3);
  return expectOk(await chain.accept(CANDIDATE_A, HEAD_A));
}

/* -------------------------------------------------------------------------- */
/* The chain                                                                  */
/* -------------------------------------------------------------------------- */

test('the owner journey: an approved revision, an automated pass, an owner test, then one acceptance of SHA A', async () => {
  await withChain(async (chain) => {
    /* --- 1 and 2: the revision declares both criteria, and SHA A answers it -------- */
    const opened = await chain.cardFor(CANDIDATE_A);
    assert.equal(opened.contract.status, 'approved', 'a candidate is only reviewable against an approved revision');
    assert.equal(opened.contract.revision, 1);
    assert.equal(opened.candidate.headSha, HEAD_A, 'the card names the exact commit under review');
    assert.deepEqual(
      opened.contract.acceptanceCriteria.map((criterion) => [criterion.id, criterion.verificationType, criterion.verificationCheckId]),
      [
        [AUTOMATED_CRITERION, 'automated', BOUND_CHECK],
        [OWNER_CRITERION, 'owner_test', null],
      ],
      'both criteria are declared with their own verification type and binding (F23-AC1)',
    );
    assert.equal(
      opened.criteria.find((criterion) => criterion.criterionId === AUTOMATED_CRITERION)?.state,
      'unverified',
      'a bound criterion nothing has run yet is unverified, not passed (F23-AC1)',
    );
    assert.equal(opened.ownerTests[0]?.state, 'pending', 'nobody but the owner may settle an owner test (F25-AC1)');

    /* --- 3: the provider reports the bound check passing, bound to SHA A ------------ */
    const verified = await chain.reportChecks([{ name: BOUND_CHECK, result: 'Passed' }], T1);
    assert.equal(verified.method, 'github_checks', 'the source is named, and there is only one');
    assert.equal(verified.candidateHeadSha, HEAD_A, 'the derived row is bound to the candidate\'s stored commit, not the caller\'s (F20-AC3)');
    assert.equal(verified.providerHeadSha, HEAD_A);
    const automatedEvidence = verified.recorded.find((row) => row.checkId === BOUND_CHECK);
    assert.ok(automatedEvidence !== undefined, 'the bound check produced one observation');
    assert.equal(automatedEvidence.recordedOutcome, 'passed');
    assert.equal(automatedEvidence.countsForCurrentCandidate, true, 'and it counts, because it observed this commit');
    assert.equal(automatedEvidence.observedHeadSha, HEAD_A);

    const afterAutomated = verified.review;
    assert.equal(
      afterAutomated.criteria.find((criterion) => criterion.criterionId === AUTOMATED_CRITERION)?.state,
      'passed',
      'the criterion is verified by the check its own revision named',
    );
    assert.equal(
      afterAutomated.checks.find((check) => check.checkId === BOUND_CHECK)?.result,
      'passed',
      'and the check is listed on the card under the same identity',
    );

    /* --- 4: the owner test is still pending, so acceptance is refused -------------- */
    assert.equal(afterAutomated.ownerTests[0]?.state, 'pending');
    assert.equal(
      afterAutomated.eligibility.readyForAcceptance,
      false,
      'a green automated criterion does not carry an outstanding owner test (F24-AC3)',
    );
    assert.equal(afterAutomated.eligibility.readyForOwnerReview, true, 'it is offered for review anyway, with the owner test as their action');
    assert.equal(afterAutomated.eligibility.ownerActions.length, 1, 'and the owner is told exactly what is theirs to do');
    const blockedOnOwnerTest = expectErr(await chain.accept(CANDIDATE_A, HEAD_A));
    assert.deepEqual(
      blockersOf(blockedOnOwnerTest),
      { [OWNER_CRITERION]: 'pending' },
      'the outstanding owner test is named, and nothing else is, so the owner learns what to discharge (F24-AC3)',
    );
    assert.match(
      blockedOnOwnerTest.reason,
      /1 outstanding requirements/,
      'and the refusal says there is exactly one',
    );
    assert.equal(chain.decisionRowsFor(CANDIDATE_A).length, 0, 'a refused acceptance writes no decision');

    /* --- 5: the owner records their own test against SHA A ------------------------- */
    chain.at(T2);
    const ownerTest = expectOk(
      await chain.card.recordOwnerTest({
        projectId: PROJECT,
        candidateId: CANDIDATE_A,
        actor: OWNER,
        criterionId: OWNER_CRITERION,
        outcome: 'passed',
        note: 'Signed in and landed on the dashboard.',
        correlationId: 'corr-b',
      }),
    );
    assert.equal(ownerTest.candidateHeadSha, HEAD_A, 'the observation is bound to the commit the stored candidate holds (F20-AC3)');
    assert.equal(ownerTest.contractRevision, 1);
    assert.equal(ownerTest.review.ownerTests[0]?.state, 'passed');
    assert.equal(ownerTest.review.ownerTests[0]?.evidenceId, ownerTest.evidenceId);
    const ownerEvidence = ownerTest.review.evidence.find((row) => row.evidenceId === ownerTest.evidenceId);
    assert.equal(ownerEvidence?.source, 'owner_test', 'only an owner observation can discharge an owner test (F23-AC1, F25-AC4)');
    assert.equal(ownerEvidence?.candidateHeadSha, HEAD_A);
    assert.equal(ownerEvidence?.countsForCurrentCandidate, true);

    /* --- 6: acceptance opens, and the owner accepts exactly SHA A ------------------ */
    assert.equal(
      ownerTest.review.eligibility.readyForAcceptance,
      true,
      'every criterion is now current-SHA-passed, so acceptance opens (F24-AC3)',
    );
    chain.at(T3);
    const accepted = expectOk(await chain.accept(CANDIDATE_A, HEAD_A));
    assert.equal(accepted.decision.outcome, 'accepted');
    assert.equal(accepted.decision.authorizesCurrentCandidate, true, 'and it authorises the commit it was made against (F27-AC3)');
    assert.equal(accepted.decision.decision?.candidateHeadSha, HEAD_A);
    assert.equal(accepted.decision.decision?.contractRevision, 1);
    assert.equal(accepted.decision.decision?.ownerId, OWNER_ID, 'the owner is the authenticated one, not a body field (F01-AC1)');
    assert.equal(accepted.decision.staleDecisions.length, 0);

    const rows = chain.decisionRowsFor(CANDIDATE_A);
    assert.equal(rows.length, 1, 'one decision row, and it is the acceptance');
    assert.equal(rows[0]?.kind, 'accepted');
    assert.equal(rows[0]?.ownerId, OWNER_ID);
    assert.equal(rows[0]?.candidateHeadSha, HEAD_A, 'the durable row names the exact commit (F25-AC1)');
    assert.equal(rows[0]?.decidedAt, T3, 'and the instant from the controller clock, which no caller supplied (F23-AC3)');
  });
});

test('the accept gate re-verifies every criterion rather than trusting the owner test alone', async () => {
  await withChain(async (chain) => {
    await chain.reportChecks([{ name: BOUND_CHECK, result: 'Passed' }], T1);

    // The owner runs their test and nothing else is wrong, so the card is eligible.
    chain.at(T2);
    const ownerTest = expectOk(
      await chain.card.recordOwnerTest({
        projectId: PROJECT,
        candidateId: CANDIDATE_A,
        actor: OWNER,
        criterionId: OWNER_CRITERION,
        outcome: 'passed',
        note: null,
        correlationId: 'corr-b',
      }),
    );
    assert.equal(ownerTest.review.eligibility.readyForAcceptance, true);

    // Now the *automated* half stops holding. The provider re-reports the bound check and this
    // time it failed; the owner test is untouched and still `passed`. Acceptance must still be
    // refused — which is the whole question this case asks, because a gate keyed on an "owner
    // test passed" flag would let exactly this through (F23-AC1, F24-AC3).
    const reRecorded = await chain.reportChecks([{ name: BOUND_CHECK, result: 'Failed' }], T3);
    assert.equal(
      reRecorded.review.criteria.find((criterion) => criterion.criterionId === AUTOMATED_CRITERION)?.state,
      'failed',
      'the automated criterion follows the newest observation of it, not the best one (F23-AC5)',
    );
    assert.equal(reRecorded.review.ownerTests[0]?.state, 'passed', 'the owner test is untouched by the automated half');
    assert.equal(reRecorded.review.eligibility.readyForAcceptance, false, 'so acceptance closes again');
    assert.deepEqual(
      reRecorded.review.eligibility.acceptanceBlockers.map((blocker) => `${blocker.split(':')[0] ?? ''}`),
      [`Criterion "${AUTOMATED_CRITERION}" is failed`],
      'and the blocker names the automated criterion, not the owner test that passed (F24-AC3)',
    );

    const refused = expectErr(await chain.accept(CANDIDATE_A, HEAD_A));
    assert.deepEqual(
      blockersOf(refused),
      { [AUTOMATED_CRITERION]: 'failed' },
      'a passed owner test does not carry a failing automated criterion, and the reason is named (F24-AC3)',
    );
    assert.equal(chain.decisionRowsFor(CANDIDATE_A).length, 0, 'and no decision was written');
  });
});

test('an owner test the owner fails stays failed, and acceptance stays shut until they say otherwise', async () => {
  await withChain(async (chain) => {
    // Everything ShipLoop can verify on its own is satisfied, so the owner test is the only
    // thing between this candidate and acceptance.
    await chain.reportChecks([{ name: BOUND_CHECK, result: 'Passed' }], T1);
    assert.equal(
      (await chain.cardFor(CANDIDATE_A)).eligibility.readyForAcceptance,
      false,
      'the owner test is outstanding, so acceptance is shut (F24-AC3)',
    );

    // The owner runs it and it does not work. This is the case a "recorded" check would pass
    // and a "truthful" one must not: a row exists for the criterion, and the answer it carries
    // is no (F25-AC2, F23-AC1).
    chain.at(T2);
    const failed = expectOk(
      await chain.card.recordOwnerTest({
        projectId: PROJECT,
        candidateId: CANDIDATE_A,
        actor: OWNER,
        criterionId: OWNER_CRITERION,
        outcome: 'failed',
        note: 'Signing in lands on the marketing site.',
        correlationId: 'corr-fail',
      }),
    );

    assert.equal(
      failed.review.ownerTests[0]?.state,
      'failed',
      "the owner's own report stands as given; nothing upgrades a failure to a pass (F25-AC2)",
    );
    assert.equal(failed.review.ownerTests[0]?.evidenceId, failed.evidenceId, 'and it names the observation that said so');
    assert.equal(
      failed.review.criteria.find((criterion) => criterion.criterionId === OWNER_CRITERION)?.state,
      'failed',
      'the criterion reads the same, because the criterion is what the owner judged',
    );
    assert.equal(
      failed.review.eligibility.readyForAcceptance,
      false,
      'a recorded owner failure is not an outstanding action, it is a failed requirement (F24-AC3)',
    );
    assert.deepEqual(
      failed.review.eligibility.acceptanceBlockers.map((blocker) => `${blocker.split(':')[0] ?? ''}`),
      [`Criterion "${OWNER_CRITERION}" is failed`],
      'and the blocker names the owner test as failed rather than pending (F24-AC3)',
    );

    // The owner's own gate refuses, naming the same criterion and the same state.
    const refused = expectErr(await chain.accept(CANDIDATE_A, HEAD_A));
    assert.deepEqual(
      blockersOf(refused),
      { [OWNER_CRITERION]: 'failed' },
      'and the acceptance gate agrees with the card about what is wrong (F23-AC1)',
    );
    assert.equal(chain.decisionRowsFor(CANDIDATE_A).length, 0, 'a refused acceptance records nothing');
    assert.equal(ownerRows(chain, CANDIDATE_A), 1, 'and the failure itself is kept, because it is the observation the owner made');

    // Re-running it and passing opens the gate. The correction is a second observation rather
    // than a rewrite of the first, so the owner can see they changed their mind (F25-AC2).
    chain.at(T3);
    const corrected = expectOk(
      await chain.card.recordOwnerTest({
        projectId: PROJECT,
        candidateId: CANDIDATE_A,
        actor: OWNER,
        criterionId: OWNER_CRITERION,
        outcome: 'passed',
        note: 'Fixed the redirect; it lands on the dashboard.',
        correlationId: 'corr-pass',
      }),
    );
    assert.equal(
      corrected.review.ownerTests[0]?.state,
      'passed',
      'the newest owner observation governs the criterion',
    );
    assert.equal(corrected.review.eligibility.readyForAcceptance, true, 'so acceptance opens');
    assert.equal(ownerRows(chain, CANDIDATE_A), 2, 'and both observations remain on record');

    const accepted = expectOk(await chain.accept(CANDIDATE_A, HEAD_A));
    assert.equal(accepted.decision.outcome, 'accepted');
    assert.equal(accepted.decision.decision?.candidateHeadSha, HEAD_A, 'bound to the exact commit it was made against');
  });
});

test('a decision is appended, never overwritten, and the newest one governs', async () => {
  await withChain(async (chain) => {
    const accepted = await acceptShaA(chain);
    assert.equal(accepted.decision.outcome, 'accepted');
    const first = chain.decisionRowsFor(CANDIDATE_A);
    assert.equal(first.length, 1);

    // A second acceptance of the same commit is allowed and appends. It neither replaces nor
    // erases the first: the table is append-only, and the owner re-reading history must find
    // both, because "the acceptance I made is gone" is not a state this product may produce.
    chain.at('2026-10-03T11:30:00Z');
    const again = expectOk(await chain.accept(CANDIDATE_A, HEAD_A));
    assert.equal(again.decision.outcome, 'accepted');
    const both = chain.decisionRowsFor(CANDIDATE_A);
    assert.equal(both.length, 2, 'a repeated decision appends rather than overwriting (F25-AC2)');
    assert.deepEqual(
      both.map((row) => row.decisionId),
      [first[0]?.decisionId, both[1]?.decisionId],
      'the earlier decision is still on record',
    );
    assert.equal(both[0]?.kind, 'accepted');
    assert.equal(again.decision.decision?.decidedAt, '2026-10-03T11:30:00Z', 'the newest decision governs the card');

    // And a later change request on the same commit supersedes the acceptance, because the
    // lifecycle treats a rejection after an acceptance as the owner's latest word (F25-AC2).
    chain.at('2026-10-03T12:00:00Z');
    const rejected = expectOk(
      await chain.card.decide({
        projectId: PROJECT,
        candidateId: CANDIDATE_A,
        actor: OWNER,
        decision: 'changes_requested',
        expectedHeadSha: HEAD_A,
        expectedContractRevision: 1,
        feedback: 'The dashboard took a second to settle; do not ship that.',
      }),
    );
    assert.equal(rejected.decision.outcome, 'changes_requested');
    assert.equal(rejected.decision.authorizesCurrentCandidate, false, 'a change request authorises nothing (F27-AC3)');
    assert.equal(rejected.eligibility.readyForDelivery, false);
    assert.equal(chain.decisionRowsFor(CANDIDATE_A).length, 3, 'nothing was rewritten: three decisions, oldest first');
    assert.deepEqual(
      chain.decisionRowsFor(CANDIDATE_A).map((row) => row.kind),
      ['accepted', 'accepted', 'changes_requested'],
    );
  });
});

test('only the owner may discharge an owner test, and a refusal discloses nothing about the candidate', async () => {
  await withChain(async (chain) => {
    await chain.reportChecks([{ name: BOUND_CHECK, result: 'Passed' }], T1);

    const byAgent = await chain.card.recordOwnerTest({
      projectId: PROJECT,
      candidateId: CANDIDATE_A,
      actor: AGENT,
      criterionId: OWNER_CRITERION,
      outcome: 'passed',
      note: null,
      correlationId: 'corr-x',
    });
    const refusedAgent = expectErr(byAgent);
    assert.equal(refusedAgent.code, 'Forbidden', 'no role but the owner may settle an owner test (F25-AC4)');
    assert.ok(
      !refusedAgent.reason.includes(HEAD_A) && !refusedAgent.reason.includes(CANDIDATE_A),
      'the refusal does not echo the candidate it hid',
    );

    // An owner test cannot be filed against the automated criterion either: choosing the weaker
    // verification for one's own work is refused rather than accepted (F23-AC1).
    const wrongCriterion = expectErr(
      await chain.card.recordOwnerTest({
        projectId: PROJECT,
        candidateId: CANDIDATE_A,
        actor: OWNER,
        criterionId: AUTOMATED_CRITERION,
        outcome: 'passed',
        note: null,
        correlationId: 'corr-y',
      }),
    );
    assert.equal(wrongCriterion.code, 'Invalid');
    assert.match(
      wrongCriterion.reason,
      /is verified automatically/,
      'the refusal names why, so the owner knows the check is what verifies it (F23-AC1)',
    );
    assert.deepEqual(
      wrongCriterion.code === 'Invalid' ? wrongCriterion.fields.map((field) => field.message) : [],
      ['Only an owner_test criterion accepts a recorded owner test.'],
      'and the field report is about the criterion, not something the owner has to guess at',
    );

    const unchanged = await chain.cardFor(CANDIDATE_A);
    assert.equal(unchanged.ownerTests[0]?.state, 'pending', 'neither refusal settled the owner test');
    assert.equal(
      ownerRows(chain, CANDIDATE_A),
      0,
      'and neither filed an owner observation, so nothing was recorded on their behalf (F25-AC4)',
    );
    assert.equal(chain.decisionRowsFor(CANDIDATE_A).length, 0, 'nor a decision');
  });
});

/** How many owner-test rows the real store holds for one candidate. */
function ownerRows(chain: Chain, candidateId: CandidateId): number {
  return expectOk(
    new SqliteMvpReviewStore(chain.db).readProjection({
      candidateId,
      candidateHeadSha: HEAD_A,
      contractId: CONTRACT_ID,
      contractRevision: 1,
    }),
    'read the stored projection',
  ).evidence.filter((row) => row.source === 'owner_test').length;
}

/* -------------------------------------------------------------------------- */
/* The push                                                                   */
/* -------------------------------------------------------------------------- */

test('a push to SHA B invalidates SHA A\'s evidence, its decision, and any acceptance of it', async () => {
  await withChain(async (chain) => {
    const accepted = await acceptShaA(chain);
    assert.equal(accepted.decision.authorizesCurrentCandidate, true);

    const before = chain.evidenceRowsFor(CANDIDATE_A);
    assert.equal(before, 2, 'one automated observation and one owner observation, both on SHA A');

    /* --- the push ---------------------------------------------------------------- */
    chain.at(T2);
    const pushed = chain.push(CANDIDATE_B, HEAD_B);
    assert.equal(pushed.headSha, HEAD_B);
    assert.equal(
      chain.currentCandidateFor().candidateId,
      CANDIDATE_B,
      'the request now offers SHA B, read from the store rather than remembered',
    );

    /* --- 1: SHA A's automated evidence cannot prove B ----------------------------- */
    const onB = await chain.cardFor(CANDIDATE_B);
    assert.equal(
      onB.criteria.find((criterion) => criterion.criterionId === AUTOMATED_CRITERION)?.state,
      'unverified',
      'the automated criterion has nothing verified against SHA B (F20-AC3)',
    );
    assert.ok(
      onB.eligibility.acceptanceBlockers.some((reason) => reason.includes(AUTOMATED_CRITERION)),
      'and it is named as a blocker of acceptance',
    );

    /* --- 2: SHA A's owner-test evidence cannot prove B ---------------------------- */
    assert.equal(
      onB.ownerTests.length,
      1,
      'the owner test is still the owner\'s own action on SHA B',
    );
    assert.equal(onB.ownerTests[0]?.criterionId, OWNER_CRITERION);
    assert.equal(onB.ownerTests[0]?.state, 'pending', 'the owner test run on SHA A does not settle SHA B (F25-AC1)');
    assert.equal(onB.ownerTests[0]?.evidenceId, null);

    /* --- 3: SHA A's acceptance is not the acceptance for B ------------------------ */
    assert.equal(onB.decision.outcome, 'none', 'SHA B carries no decision of its own');
    assert.equal(onB.decision.decision, null);
    assert.equal(onB.decision.authorizesCurrentCandidate, false, 'so nothing authorises SHA B (F27-AC3)');
    assert.equal(onB.eligibility.readyForDelivery, false, 'and a delivery gate reading this card sees no permission');
    assert.deepEqual(chain.decisionRowsFor(CANDIDATE_B), [], 'no decision row was written for SHA B');

    // The acceptance is history rather than retracted: it is still on SHA A, still naming SHA A.
    const onA = await chain.cardFor(CANDIDATE_A);
    assert.equal(onA.decision.outcome, 'accepted');
    assert.equal(onA.decision.decision?.candidateHeadSha, HEAD_A);
    assert.equal(chain.decisionRowsFor(CANDIDATE_A).length, 1, 'the push moved the ground; it did not rewrite history');

    /* --- 4: a stale Accept is refused as a conflict, not as a readiness report ---- */
    const staleOnB = expectErr(await chain.accept(CANDIDATE_B, HEAD_A));
    assert.equal(staleOnB.code, 'Conflict', 'a submission prepared against SHA A is a conflict on SHA B, not a readiness answer (F24-AC4)');
    assert.equal(staleOnB.code === 'Conflict' ? staleOnB.expected : null, HEAD_A, 'the refusal names the commit it was prepared against');
    assert.equal(staleOnB.code === 'Conflict' ? staleOnB.actual : null, HEAD_B, 'and the commit the candidate is actually on');
    assert.equal(
      'prerequisites' in staleOnB,
      false,
      'a conflict carries no eligibility report, so it cannot be read as "go and discharge these" (F24-AC4)',
    );

    // The same is true for the stale card itself: the owner's old page still names SHA A, and
    // accepting it must be refused rather than recording an acceptance of a build the pull
    // request no longer holds (F25-AC3, F24-AC4).
    const staleOnA = expectErr(await chain.accept(CANDIDATE_A, HEAD_A));
    assert.equal(
      staleOnA.code,
      'Conflict',
      `an acceptance of a superseded candidate is refused: ${staleOnA.code === 'Conflict' ? staleOnA.reason : staleOnA.reason}`,
    );
    assert.deepEqual(
      chain.decisionRowsFor(CANDIDATE_A).map((row) => row.kind),
      ['accepted'],
      'neither stale submission recorded a second decision',
    );
    assert.deepEqual(chain.decisionRowsFor(CANDIDATE_B), [], 'and neither recorded one against SHA B');

    /* --- 5: SHA B needs its own current evidence before it can be accepted -------- */
    const blocked = expectErr(await chain.accept(CANDIDATE_B, HEAD_B));
    assert.deepEqual(
      blockersOf(blocked),
      { [AUTOMATED_CRITERION]: 'unverified', [OWNER_CRITERION]: 'pending' },
      'SHA B has nothing verified against it, and both outstanding requirements are named (F24-AC3)',
    );

    // Recording new evidence for SHA B is what opens acceptance — and it is SHA B's own rows
    // that do it, not SHA A's, which are still bound to the commit they observed.
    const verifiedB = await chain.reportChecks([{ name: BOUND_CHECK, result: 'Passed' }], '2026-10-03T12:00:00Z', CANDIDATE_B);
    assert.equal(
      verifiedB.recorded[0]?.observedHeadSha,
      HEAD_B,
      'the new observation is bound to the new commit, so the criteria it settles are SHA B\'s (F20-AC3)',
    );
    chain.at('2026-10-03T12:30:00Z');
    const ownerTestB = expectOk(
      await chain.card.recordOwnerTest({
        projectId: PROJECT,
        candidateId: CANDIDATE_B,
        actor: OWNER,
        criterionId: OWNER_CRITERION,
        outcome: 'passed',
        note: 'Re-ran it against the pushed build.',
        correlationId: 'corr-b2',
      }),
    );
    assert.equal(
      ownerTestB.candidateHeadSha,
      HEAD_B,
      'and the owner re-ran their own test against the pushed build rather than inheriting the old one',
    );
    const acceptedB = expectOk(await chain.accept(CANDIDATE_B, HEAD_B));
    assert.equal(acceptedB.decision.outcome, 'accepted');
    assert.equal(acceptedB.decision.decision?.candidateHeadSha, HEAD_B, 'and it names SHA B, not the build it replaced');
    assert.equal(acceptedB.decision.authorizesCurrentCandidate, true);
    assert.deepEqual(
      chain.decisionRowsFor(CANDIDATE_B).map((row) => [row.kind, row.candidateHeadSha]),
      [['accepted', HEAD_B]],
      'exactly one decision row, and it is SHA B\'s',
    );
    assert.deepEqual(
      chain.decisionRowsFor(CANDIDATE_A).map((row) => [row.kind, row.candidateHeadSha]),
      [['accepted', HEAD_A]],
      'and SHA A keeps its own single acceptance, neither replaced nor added to',
    );
  });
});

test('SHA A\'s own rows still cannot prove SHA B even when the projection is handed them', async () => {
  await withChain(async (chain) => {
    await acceptShaA(chain);
    chain.at(T2);
    chain.push(CANDIDATE_B, HEAD_B);

    // The real store filters by `candidate_id`, so on its own it cannot put SHA A's rows in
    // front of SHA B's projection and the domain comparison never runs. That filter is one
    // defence; this case widens only the read so the *other* one is exercised on the real rows
    // the real use cases wrote. Everything downstream — `buildMvpReviewReadModel`, the card
    // projection, every readiness flag — is the shipped code (F20-AC3).
    const real = new SqliteMvpReviewStore(chain.db);
    const widened: MvpReviewCardDeps = {
      clock: { now: () => '2026-10-03T12:00:00Z' },
      requests: new RequestRepository(chain.db),
      contracts: new ContractRepository(chain.db),
      candidates: new DeliveryCandidateRepository(chain.db),
      review: handedOver(real, CANDIDATE_A),
      newDecisionId: () => 'dec-widened',
      newCorrelationId: () => 'corr-widened',
    };
    const card = expectOk(
      await createMvpReviewCardUseCases(widened).getReview({ projectId: PROJECT, candidateId: CANDIDATE_B, actor: OWNER }),
    );

    // Both of SHA A's rows are now in front of the projection, and both read `stale`.
    const automated = card.evidence.find((row) => row.checkId === BOUND_CHECK);
    assert.ok(automated !== undefined, 'the automated row for SHA A reached the projection');
    assert.equal(automated.recordedOutcome, 'passed', 'what the source said at the time is history');
    assert.equal(automated.currentOutcome, 'stale', 'and it no longer counts for this candidate');
    assert.equal(automated.countsForCurrentCandidate, false);
    assert.ok(automated.staleReasons.length > 0, 'the reason it stopped counting is named (F20-AC3)');
    assert.equal(automated.candidateHeadSha, HEAD_A, 'and the commit it was about is still visible');

    const ownerRow = card.evidence.find((row) => row.source === 'owner_test');
    assert.ok(ownerRow !== undefined, 'the owner row for SHA A reached the projection too');
    assert.equal(ownerRow.recordedOutcome, 'passed', 'the owner did pass it — on SHA A');
    assert.equal(ownerRow.countsForCurrentCandidate, false, 'which proves nothing about SHA B (F25-AC1)');
    assert.equal(ownerRow.candidateHeadSha, HEAD_A);

    // And therefore no verdict on the card is standing on them.
    assert.equal(card.criteria.find((criterion) => criterion.criterionId === AUTOMATED_CRITERION)?.state, 'stale');
    assert.equal(card.ownerTests[0]?.state, 'stale', 'the owner test reads stale rather than passed (F20-AC3)');
    assert.equal(card.eligibility.readyForAcceptance, false, 'so SHA B is still not acceptable on SHA A\'s evidence');
    assert.equal(card.staleness.stale, true);
    assert.equal(card.staleness.staleEvidenceIds.length, 2, 'and the summary counts exactly the two rows that no longer count');
  });
});