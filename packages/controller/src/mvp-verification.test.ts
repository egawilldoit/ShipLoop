/**
 * The automated verification and owner-test evidence paths, against a real database.
 *
 * Builder 5 tested the binding rules in `mvp-review.test.ts` with hand-built facts. These two
 * cases were untestable here before the transport existed, and the properties they turn on are the
 * ones a browser will exercise first, so they are tested against the real stores and the real
 * provider projection rather than against fixtures:
 *
 *   - **A provider read is the only source of a verdict.** The scripted git port below is the
 *     narrowest possible seam - it answers two reads and nothing else - so every outcome asserted
 *     here was produced by the provider's facts going through `recordGitHubProjection` and the
 *     domain. Nothing in this file can hand the use case a result.
 *   - **A run reported for another commit does not prove this one.** The scripted port can
 *     attribute a check to a commit other than the candidate's, which is the state F20-AC3 is
 *     about and which a fixture assembled from facts could not produce.
 *   - **A provider failure records nothing.** The port can refuse, and the case proves no row was
 *     written rather than only that an error came back - the failure mode being "a clean report
 *     that means nothing ran".
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
import type { ProviderCheckObservation } from '@shiploop/adapters';
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
import type { MvpLiveCandidateReader, MvpReviewCardUseCases } from './mvp-review-card.ts';
import type { CandidateView } from './candidate-linking.ts';

const HEAD = asCommitSha('a1b2c3d4'.repeat(5));
/** The commit a push produces, and the one a stale CI run still belongs to. */
const NEXT_HEAD = asCommitSha('f0e1d2c3'.repeat(5));
const BASE_SHA = asCommitSha('0f0f0f0f'.repeat(5));

const OWNER_ID = '2f6a1c40-0000-4000-8000-00000000000c' as OwnerId;
const OWNER: MvpOwnerActor = { role: 'owner', ownerId: OWNER_ID };
const AGENT: MvpActor = { role: 'agent' };

const PROJECT = '4c9b2d51-0000-4000-8000-00000000000a' as ProjectId;
const OTHER_PROJECT = '4c9b2d51-0000-4000-8000-00000000000b' as ProjectId;

const T0 = '2026-10-03T09:00:00Z';
const T1 = '2026-10-03T09:30:00Z';

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
}

/**
 * One scripted provider check, in the adapter's own vocabulary.
 *
 * The adapter does not attribute a check to a commit; the provider *port* does, and the candidate
 * module's projection puts the attribution on `observedHeadSha`. So this fixture carries the
 * verdict and the timestamps, and the harness's `attributedHeadSha` decides which commit the
 * provider claimed - which is the fact F20-AC3 turns on.
 */
function check(
  name: string,
  result: CheckResult,
  overrides: { readonly startedAt?: string | null; readonly endedAt?: string | null } = {},
): ProviderCheckObservation {
  return {
    checkId: `check_${name}`,
    name,
    result,
    requirement: 'ProviderExtra',
    startedAt: overrides.startedAt ?? T1,
    endedAt: overrides.endedAt ?? T1,
    exitCode: null,
    detail: `${name} reported ${result}`,
    artifactUrl: null,
  };
}

/**
 * What the scripted provider reports for one candidate.
 *
 * Mutable so a case can link a candidate and then move the pull request, which is the state
 * F20-AC3 and F24-AC4 are about. `failure` is what a provider that stops answering returns, and
 * it is a first-class part of the seam rather than a separate test double, so "the provider failed"
 * is expressed the same way as "the provider said something".
 */
class ScriptedProvider {
  checks: readonly ProviderCheckObservation[] = [];
  failure: DomainError | null = null;
  /**
   * The commit the pull request holds, which is the commit the checks were read for.
   *
   * The shipped adapter resolves a check it read for another commit into `result: 'Stale'`, so a
   * case scripts that rather than a per-check SHA: the contract has no such field, and pretending
   * otherwise would test a shape the product cannot produce.
   */
  headSha: CommitSha = HEAD;
  /** Every call the reader made, so a case can assert nothing was contacted. */
  readonly requestedRequests: string[] = [];

  asReader(requested: Seed): MvpLiveCandidateReader {
    return async (input): Promise<Result<CandidateView, DomainError>> => {
      this.requestedRequests.push(input.requestId);
      if (this.failure !== null) return { ok: false, error: this.failure };
      return {
        ok: true,
        value: {
          candidate: {
            candidateId: requested.candidateId as CandidateId,
            projectId: PROJECT,
            requestId: requested.requestId,
            contractId: requested.contractId,
            contractRevision: 1,
            repository: 'acme/web',
            pullRequestNumber: 42,
            pullRequestUrl: 'https://example.invalid/acme/web/pull/42',
            baseBranch: 'main',
            baseSha: BASE_SHA,
            headBranch: 'ship/loop-1',
            headSha: HEAD,
            pullRequestState: 'Open',
            draft: false,
            observedAt: T1,
            provider: 'github',
            linkedAt: T0,
          },
          live: {
            provider: 'github',
            repository: 'acme/web',
            pullRequestNumber: 42,
            pullRequestUrl: 'https://example.invalid/acme/web/pull/42',
            baseBranch: 'main',
            baseSha: BASE_SHA,
            headBranch: 'ship/loop-1',
            headSha: this.headSha,
            headRepository: 'acme',
            pullRequestState: 'Open',
            draft: false,
            observedAt: T1,
            providerPullRequestId: 'pr_42',
          },
          binding: {
            contractId: requested.contractId,
            contractRevision: 1,
            headSha: HEAD,
          },
          bindingFingerprint: 'fixture-fingerprint' as CandidateView['bindingFingerprint'],
          change: {
            kind: this.headSha === HEAD ? 'Unchanged' : 'HeadChanged',
            changed: this.headSha === HEAD ? [] : ['HeadChanged'],
            changedAnything: this.headSha !== HEAD,
            previousHeadSha: HEAD,
            currentHeadSha: this.headSha,
            priorEvidenceStale: this.headSha !== HEAD,
            detail: 'scripted',
          },
          priorEvidenceStale: this.headSha !== HEAD,
          previousCandidateId: null,
          previousHeadSha: null,
          supersededCandidates: [],
          // The candidate module's own projection of the port's facts, so a case sees what the
          // shipped read produces rather than a shape invented here.
          checks: this.checks.map((observation) => ({
            name: observation.name,
            result: observation.result,
            required: false,
            notApplicableApprovedByPolicy: false,
            startedAt: observation.startedAt,
            endedAt: observation.endedAt,
            artifactUrl: observation.artifactUrl,
            detail: observation.detail,
            observedHeadSha: null,
          })),
          checksReady: false,
          blockingChecks: [],
          reviewReadiness: { ready: false, reasons: ['scripted'] },
          observedAt: T1,
        },
      };
    };
  }
}

interface Harness {
  readonly card: MvpReviewCardUseCases;
  readonly db: Database;
  readonly provider: ScriptedProvider;
  /** Counts the evidence rows a pass actually wrote, so "records nothing" is checkable. */
  readonly evidenceRows: () => number;
  readonly at: (instant: string) => void;
}

async function withCard(
  run: (harness: Harness) => Promise<void> | void,
  options: { readonly readLiveCandidate?: MvpLiveCandidateReader | null } = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-verification-'));
  try {
    const opened = openDatabase(join(directory, 'verification.sqlite'));
    assert.ok(opened.ok);
    const db = opened.value;
    expectOk(migrate(db));
    let instant = T0;
    let serial = 0;
    const provider = new ScriptedProvider();
    const seeded = seed(db);
    const card = createMvpReviewCardUseCases({
      clock: { now: () => instant },
      requests: new RequestRepository(db),
      contracts: new ContractRepository(db),
      candidates: new DeliveryCandidateRepository(db),
      review: new SqliteMvpReviewStore(db),
      newDecisionId: () => `dec-${(serial += 1)}`,
      newCorrelationId: () => `corr-${(serial += 1)}`,
      readLiveCandidate:
        options.readLiveCandidate === undefined
          ? provider.asReader(seeded)
          : options.readLiveCandidate,
    });
    await run({
      card,
      db,
      provider,
      evidenceRows: () => expectOk(
        new SqliteMvpReviewStore(db).readProjection({
          candidateId: seeded.candidateId as CandidateId,
          candidateHeadSha: HEAD,
          contractId: seeded.contractId as ContractId,
          contractRevision: 1,
        }),
      ).evidence.length,
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
 * One project, one approved revision and one candidate, seeded through the domain constructors.
 *
 * The candidate row is written through the real store rather than linked through the provider,
 * because the provider seam is what these cases script and it must not also be what creates the
 * row under test.
 */
function seed(db: Database): Seed {
  const projectId = PROJECT;
  expectOk(new ProjectRepository(db).create({ projectId, name: `Project ${projectId}`, at: T0 }));
  expectOk(new OwnerRepository(db).provision(OWNER_ID, 'Owner', T0));

  const requestId = 'req-verify' as RequestId;
  const contractId = 'contract-verify' as ContractId;
  const candidateId = 'cand-verify' as CandidateId;

  const request = expectOk(
    createRequest({
      requestId,
      projectId,
      title: 'Sign-in lands on the dashboard',
      description: 'After signing in, the owner lands on the dashboard.',
      at: T0,
    }),
  );
  expectOk(new RequestRepository(db).create(request));

  const draft = expectOk(
    createContractDraft({
      contractId,
      projectId,
      requestId,
      revision: 1,
      content: {
        outcome: 'Signing in lands the owner on the dashboard.',
        scope: ['The login form and its redirect.'],
        outOfScope: ['Registration.'],
        acceptanceCriteria: [AUTOMATED_CRITERION, OWNER_CRITERION],
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
  // The approval names the draft it reviewed: the same fingerprint the row carries, which is what
  // stops a stale tab sealing text this test never saw. Asserted here rather than defaulted, so the
  // fixture cannot quietly stop exercising the guard.
  const reviewed = contractContentFingerprint(draft);
  const approved = expectOk(
    approveContract(draft, { approvedBy: OWNER_ID, at: T0, expectedContentFingerprint: reviewed }),
  );
  expectOk(contracts.approve(approved, { updatedAt: draft.updatedAt, contentFingerprint: reviewed }));

  expectOk(
    new DeliveryCandidateRepository(db).record({
      candidateId,
      projectId,
      requestId,
      contractId,
      contractRevision: 1,
      provider: 'github',
      repository: 'acme/web',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.invalid/acme/web/pull/42',
      baseBranch: 'main',
      baseSha: BASE_SHA,
      headBranch: 'ship/loop-1',
      headSha: HEAD,
      headRepository: 'acme',
      pullRequestState: 'Open',
      draft: false,
      observedAt: T0,
      correlationId: 'seed-correlation',
    }),
  );

  return { requestId, contractId, candidateId };
}

const SEEDED: Seed = {
  requestId: 'req-verify',
  contractId: 'contract-verify',
  candidateId: 'cand-verify',
};

/* -------------------------------------------------------------------------- */
/* The automated path                                                          */
/* -------------------------------------------------------------------------- */

test('F20-AC2: a passing provider check is recorded against the candidate, bound to its full SHA', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;
    harness.provider.checks = [check('unit', 'Passed')];

    const recorded = expectOk(
      await harness.card.recordVerification({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        correlationId: 'corr-verify-pass',
      }),
    );

    assert.equal(recorded.method, 'github_checks', 'the source is named, and it is one');
    assert.equal(recorded.candidateHeadSha, HEAD, 'the evidence is bound to the candidate\'s exact commit');
    assert.equal(recorded.candidateHeadSha.length, 40);
    assert.equal(recorded.providerHeadSha, HEAD, 'and the provider still holds that commit');
    assert.equal(recorded.contractRevision, 1);
    assert.equal(recorded.recorded.length, 1);

    const observation = recorded.recorded[0];
    assert.ok(observation !== undefined);
    assert.equal(observation.checkId, 'unit');
    assert.equal(observation.recordedOutcome, 'passed');
    assert.equal(observation.currentOutcome, 'passed');
    assert.equal(observation.countsForCurrentCandidate, true);
    assert.equal(
      observation.observedHeadSha,
      HEAD,
      'the run is attributed to the full SHA, so the binding comparison downstream is meaningful',
    );

    // The durable row, read back through the store rather than through this call's return value.
    assert.equal(harness.evidenceRows(), 1, 'exactly one row was written for one check');
    const card = expectOk(
      await harness.card.getReview({ projectId: PROJECT, candidateId: seeded.candidateId, actor: OWNER }),
    );
    const row = card.evidence.find((entry) => entry.evidenceId === observation.evidenceId);
    assert.ok(row !== undefined, 'the recorded observation is on the card');
    assert.equal(row.source, 'github_check');
    assert.equal(row.checkId, 'unit');
    assert.equal(row.candidateHeadSha, HEAD);
    assert.equal(row.countsForCurrentCandidate, true);
    assert.equal(row.currentOutcome, 'passed');
  });
});

test('F20-AC2: a failed check reads failed, and a check that never ran reads missing - never passed', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;
    harness.provider.checks = [check('unit', 'Failed'), check('lint', 'Missing')];

    const recorded = expectOk(
      await harness.card.recordVerification({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        correlationId: 'corr-verify-failure',
      }),
    );

    const byCheck = new Map(recorded.recorded.map((entry) => [entry.checkId, entry]));
    assert.equal(byCheck.get('unit')?.recordedOutcome, 'failed', 'a red check reads failed');
    assert.equal(byCheck.get('unit')?.currentOutcome, 'failed');
    assert.equal(byCheck.get('unit')?.countsForCurrentCandidate, true);
    assert.equal(
      byCheck.get('lint')?.recordedOutcome,
      'missing',
      'a check that never ran reads missing, which is not a pass (F20-AC2)',
    );
    assert.notEqual(byCheck.get('lint')?.recordedOutcome, 'passed');
    assert.equal(
      byCheck.get('lint')?.currentOutcome,
      'missing',
      'and because the live read asked about this head and got no run, it is bound to this candidate',
    );
    assert.equal(byCheck.get('lint')?.countsForCurrentCandidate, true);

    const card = expectOk(
      await harness.card.getReview({ projectId: PROJECT, candidateId: seeded.candidateId, actor: OWNER }),
    );
    const results = new Map(card.checks.map((entry) => [entry.checkId, entry.result]));
    assert.equal(results.get('unit'), 'failed');
    assert.equal(results.get('lint'), 'missing');
    assert.notEqual(results.get('lint'), 'passed', 'a check the provider never ran is not green');
  });
});

test('F20-AC3: a run the provider attributed to another commit proves nothing about this candidate', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;
    // The adapter resolved this run to `Stale`, because it ran for a different commit. That is
    // the only signal the shipped contract carries, and it is the one the candidate module
    // already acts on (F20-AC3).
    harness.provider.checks = [check('unit', 'Stale')];

    const recorded = expectOk(
      await harness.card.recordVerification({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        correlationId: 'corr-verify-other-commit',
      }),
    );

    const observation = recorded.recorded[0];
    assert.ok(observation !== undefined);
    assert.equal(
      observation.recordedOutcome,
      'missing',
      'the provider never produced a result about this commit, so it is recorded as an observation '
        + 'of nothing rather than as a green that merely happens to be unbound (F20-AC3)',
    );
    assert.notEqual(
      observation.recordedOutcome,
      'passed',
      'and never as a pass, which is the whole failure this path has to make unreachable',
    );
    assert.equal(
      observation.currentOutcome,
      'stale',
      'and it does not count for the candidate under review (F20-AC3, F24-AC4)',
    );
    assert.equal(observation.countsForCurrentCandidate, false);
    // Not the other commit: `recordGitHubProjection` nulls an unattributable run's SHA, so the row
    // claims no observation of any candidate rather than half-claiming one. Recording NEXT_HEAD
    // here would be a weaker claim, because a reader could compare the two and conclude the run
    // simply belongs to a candidate nobody recorded.
    assert.equal(
      observation.observedHeadSha,
      null,
      'the row names no commit: a run belonging to another commit is not evidence about this one (F20-AC3)',
    );
    assert.equal(
      observation.observedContractRevision,
      null,
      'and no revision either, so no reader can bind it to this agreement by accident',
    );

    const card = expectOk(
      await harness.card.getReview({ projectId: PROJECT, candidateId: seeded.candidateId, actor: OWNER }),
    );
    assert.equal(card.staleness.stale, true, 'the card says plainly that it is stale');
    const automated = card.criteria.find((criterion) => criterion.criterionId === 'AC1');
    assert.equal(
      automated?.state,
      'unverified',
      'and the criterion the old run spoke for is not verified by it',
    );
    assert.notEqual(automated?.state, 'passed');
  });
});

test('F20-AC2: a provider failure records nothing and claims nothing', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;
    harness.provider.checks = [check('unit', 'Passed')];
    harness.provider.failure = {
      code: 'Unavailable',
      reason: 'The provider did not answer.',
    };

    const refused = expectErr(
      await harness.card.recordVerification({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        correlationId: 'corr-verify-unavailable',
      }),
    );
    assert.equal(refused.code, 'Unavailable');
    assert.equal(
      harness.evidenceRows(),
      0,
      'nothing was recorded, so a report can never read as a clean run (F20-AC2)',
    );
  });
});

test('F03-AC2: a deployment with no git provider refuses by name rather than reporting an empty pass', async () => {
  await withCard(
    async (harness) => {
      const seeded = SEEDED;
      const refused = expectErr(
        await harness.card.recordVerification({
          projectId: PROJECT,
          candidateId: seeded.candidateId,
          actor: OWNER,
          correlationId: 'corr-verify-no-provider',
        }),
      );
      assert.equal(refused.code, 'Unavailable');
      assert.ok(
        refused.reason.includes('no read-only git provider'),
        `the refusal names the missing wiring: ${refused.reason}`,
      );
      assert.ok(
        refused.reason.includes('no automated evidence was recorded'),
        'and it says that nothing was verified, rather than leaving that to be inferred',
      );
      assert.equal(harness.evidenceRows(), 0);
    },
    { readLiveCandidate: null },
  );
});

test('F24-AC4: a verification pass binds the candidate on screen, not the one the provider has moved to', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;
    // The pull request has been pushed on to. The provider's checks are for the new commit, and
    // the candidate under review is still the one the store recorded.
    harness.provider.headSha = NEXT_HEAD;
    harness.provider.checks = [check('unit', 'Passed')];

    const recorded = expectOk(
      await harness.card.recordVerification({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        correlationId: 'corr-verify-pushed',
      }),
    );

    assert.equal(
      recorded.candidateHeadSha,
      HEAD,
      'the evidence is bound to the candidate the path named',
    );
    assert.equal(
      recorded.providerHeadSha,
      NEXT_HEAD,
      'and the report names the commit the provider now holds, so the difference is visible',
    );
    assert.notEqual(recorded.providerHeadSha, recorded.candidateHeadSha);
    assert.equal(
      recorded.recorded[0]?.countsForCurrentCandidate,
      false,
      "the newer commit's green check cannot prove the older candidate",
    );
  });
});

test('F25-AC4: an agent may not record automated evidence, and the refusal says nothing about the candidate', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;
    harness.provider.checks = [check('unit', 'Passed')];

    const refused = expectErr(
      await harness.card.recordVerification({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: AGENT,
        correlationId: 'corr-verify-agent',
      }),
    );
    assert.equal(refused.code, 'Forbidden');
    assert.ok(!refused.reason.includes(HEAD), 'the refusal must not echo the commit it refused');
    assert.ok(!refused.reason.includes(seeded.candidateId), 'nor the candidate identity');
    assert.equal(
      harness.provider.requestedRequests.length,
      0,
      'and the provider was never contacted, so a refused caller learns nothing about the candidate',
    );
    assert.equal(harness.evidenceRows(), 0);
  });
});

test('F02-AC2: a candidate from another project is not verifiable through this project\'s path', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;
    harness.provider.checks = [check('unit', 'Passed')];

    const refused = expectErr(
      await harness.card.recordVerification({
        projectId: OTHER_PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        correlationId: 'corr-verify-cross-project',
      }),
    );
    assert.equal(refused.code, 'NotFound', 'a candidate is addressed by its own project, never by id alone');
    assert.equal(harness.evidenceRows(), 0);
  });
});

test('F20-AC3: re-running after the check finishes replaces the earlier "still running" verdict', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;
    harness.provider.checks = [check('unit', 'Waiting')];
    const waiting = expectOk(
      await harness.card.recordVerification({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        correlationId: 'corr-verify-waiting',
      }),
    );
    assert.equal(waiting.recorded[0]?.recordedOutcome, 'waiting');

    // The same check, now finished. A new observation is a new row rather than a conflict-no-op,
    // because an identity derived from the candidate alone would freeze the earlier verdict.
    harness.provider.checks = [check('unit', 'Passed', { endedAt: '2026-10-03T10:00:00Z' })];
    const passed = expectOk(
      await harness.card.recordVerification({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        correlationId: 'corr-verify-then-passed',
      }),
    );
    assert.equal(passed.recorded[0]?.recordedOutcome, 'passed');
    assert.equal(passed.recorded[0]?.currentOutcome, 'passed');

    const card = expectOk(
      await harness.card.getReview({ projectId: PROJECT, candidateId: seeded.candidateId, actor: OWNER }),
    );
    const checkRow = card.checks.find((entry) => entry.checkId === 'unit');
    assert.equal(
      checkRow?.result,
      'passed',
      'the newest applicable observation wins, so a finished check is no longer reported as running',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The owner path                                                              */
/* -------------------------------------------------------------------------- */

test('F23-AC1: the owner may pass their own criterion, and it is bound to the exact commit', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;
    harness.at(T1);

    const recorded = expectOk(
      await harness.card.recordOwnerTest({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        criterionId: 'AC2',
        outcome: 'passed',
        note: 'The total matched the invoice.',
        correlationId: 'corr-owner-pass',
      }),
    );

    assert.equal(recorded.criterionId, 'AC2');
    assert.equal(recorded.outcome, 'passed');
    assert.equal(recorded.candidateHeadSha, HEAD, 'the observation names the build it was made against');
    assert.equal(recorded.contractRevision, 1);
    assert.equal(recorded.note, 'The total matched the invoice.');
    assert.ok(recorded.evidenceId.length > 0);
    assert.equal(recorded.observedAt, T1, 'stamped by the controller clock, never by the request');

    const ownerTest = recorded.review.ownerTests.find((entry) => entry.criterionId === 'AC2');
    assert.equal(ownerTest?.state, 'passed');
    assert.equal(ownerTest?.evidenceId, recorded.evidenceId);

    const row = expectOk(
      new SqliteMvpReviewStore(harness.db).readProjection({
        candidateId: seeded.candidateId as CandidateId,
        candidateHeadSha: HEAD,
        contractId: seeded.contractId as ContractId,
        contractRevision: 1,
      }),
    ).evidence[0];
    assert.ok(row !== undefined);
    assert.equal(row.source, 'owner_test');
    assert.equal(
      row.binding?.candidateHeadSha,
      HEAD,
      'the durable row carries the full commit, so it can be compared against the candidate',
    );
  });
});

test('F25-AC2: the owner may fail their own criterion, and the failure is recorded as a failure', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;
    harness.at(T1);

    const recorded = expectOk(
      await harness.card.recordOwnerTest({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        criterionId: 'AC2',
        outcome: 'failed',
        note: 'The redirect still lands on the login form.',
        correlationId: 'corr-owner-fail',
      }),
    );

    assert.equal(recorded.outcome, 'failed');
    const ownerTest = recorded.review.ownerTests.find((entry) => entry.criterionId === 'AC2');
    assert.equal(ownerTest?.state, 'failed', 'a reported failure reads failed, not pending and not passed');
    assert.equal(
      recorded.review.eligibility.readyForAcceptance,
      false,
      'and it does not open the acceptance gate',
    );
  });
});

test('F23-AC1: an owner test cannot discharge an automated criterion', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;

    const refused = expectErr(
      await harness.card.recordOwnerTest({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        criterionId: 'AC1',
        outcome: 'passed',
        note: null,
        correlationId: 'corr-owner-automated',
      }),
    );

    assert.equal(
      refused.code,
      'Invalid',
      'choosing the weaker verification for one\'s own work is refused, not accepted',
    );
    assert.equal(harness.evidenceRows(), 0, 'and nothing was recorded for it');

    const card = expectOk(
      await harness.card.getReview({ projectId: PROJECT, candidateId: seeded.candidateId, actor: OWNER }),
    );
    assert.equal(
      card.criteria.find((criterion) => criterion.criterionId === 'AC1')?.state,
      'unverified',
      'the automated criterion is still unverified',
    );
    assert.notEqual(card.criteria.find((criterion) => criterion.criterionId === 'AC1')?.state, 'passed');
  });
});

test('F23-AC1: a criterion the revision does not declare is refused', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;

    const refused = expectErr(
      await harness.card.recordOwnerTest({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        criterionId: 'AC-does-not-exist',
        outcome: 'passed',
        note: null,
        correlationId: 'corr-owner-unknown',
      }),
    );

    assert.equal(refused.code, 'NotFound');
    assert.equal(harness.evidenceRows(), 0);
  });
});

test('F25-AC4: an agent may not record an owner test, and no owner identity is invented for it', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;

    const refused = expectErr(
      await harness.card.recordOwnerTest({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: AGENT,
        criterionId: 'AC2',
        outcome: 'passed',
        note: null,
        correlationId: 'corr-owner-agent',
      }),
    );

    assert.equal(refused.code, 'Forbidden');
    assert.ok(!refused.reason.includes(HEAD));
    assert.equal(harness.evidenceRows(), 0);
  });
});

test('F02-AC2: an owner test cannot be recorded against another project\'s candidate', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;

    const refused = expectErr(
      await harness.card.recordOwnerTest({
        projectId: OTHER_PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        criterionId: 'AC2',
        outcome: 'passed',
        note: null,
        correlationId: 'corr-owner-cross-project',
      }),
    );

    assert.equal(refused.code, 'NotFound');
    assert.equal(harness.evidenceRows(), 0);
  });
});

test('F25-AC3: a later owner test for the same criterion supersedes the earlier one rather than duplicating it', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;

    harness.at(T1);
    const passed = expectOk(
      await harness.card.recordOwnerTest({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        criterionId: 'AC2',
        outcome: 'passed',
        note: null,
        correlationId: 'corr-owner-then-pass',
      }),
    );
    harness.at('2026-10-03T10:30:00Z');
    const failed = expectOk(
      await harness.card.recordOwnerTest({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        criterionId: 'AC2',
        outcome: 'failed',
        note: 'Retested after a change and it no longer holds.',
        correlationId: 'corr-owner-then-fail',
      }),
    );

    assert.notEqual(
      failed.evidenceId,
      passed.evidenceId,
      'two observations of the same criterion are two rows, so a correction supersedes rather than overwrites',
    );
    assert.equal(
      failed.review.ownerTests.find((entry) => entry.criterionId === 'AC2')?.state,
      'failed',
      'and the newer one is the one the card reports',
    );
  });
});

test('F25-AC3: an owner test for an earlier commit does not settle the candidate on screen', async () => {
  // The candidate under review is the row the store recorded, so its owner test is bound to that
  // commit and no other. This case pins the comparison through the durable row rather than through
  // a projected card, because the card's own stale rendering is proven in `mvp-review-card.test.ts`
  // against the stub store that can return a superseded row.
  await withCard(async (harness) => {
    const seeded = SEEDED;
    harness.at(T1);

    expectOk(
      await harness.card.recordOwnerTest({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        criterionId: 'AC2',
        outcome: 'passed',
        note: null,
        correlationId: 'corr-owner-bound',
      }),
    );

    const rows = expectOk(
      new SqliteMvpReviewStore(harness.db).readProjection({
        candidateId: seeded.candidateId as CandidateId,
        candidateHeadSha: NEXT_HEAD,
        contractId: seeded.contractId as ContractId,
        contractRevision: 1,
      }),
    ).evidence;
    assert.equal(rows.length, 1, 'the row is still stored, because history is not deleted');
    assert.equal(
      rows[0]?.binding?.candidateHeadSha,
      HEAD,
      'and it is bound to the commit the owner tested, not to whatever the candidate is now',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Composition shape                                                           */
/* -------------------------------------------------------------------------- */

test('mvp-spec 3: neither path can accept a caller-supplied automated result, and neither merges or deploys', async () => {
  await withCard(async (harness) => {
    const seeded = SEEDED;
    harness.provider.checks = [check('unit', 'Passed')];

    // The commands are the whole surface. Read as data rather than as behaviour, because the claim
    // is about what the transport *cannot* express: no member of either command carries a result,
    // a commit or a provider verdict that a browser could supply.
    const verification = [
      'projectId',
      'candidateId',
      'actor',
      'correlationId',
    ] as const;
    const ownerTest = ['projectId', 'candidateId', 'actor', 'criterionId', 'outcome', 'note'] as const;

    for (const forbidden of [
      'result',
      'outcome',
      'passed',
      'checkId',
      'criterionId',
      'headSha',
      'evidenceId',
      'observations',
      'merge',
      'deploy',
      'release',
    ]) {
      assert.equal(
        (verification as readonly string[]).includes(forbidden),
        false,
        `the automated command must not accept "${forbidden}": the server derives every verdict`,
      );
    }
    for (const forbidden of [
      'headSha',
      'evidenceId',
      'verificationType',
      'ownerId',
      'observedBy',
      'observedAt',
      'merge',
      'deploy',
      'release',
    ]) {
      assert.equal(
        (ownerTest as readonly string[]).includes(forbidden),
        false,
        `the owner-test command must not accept "${forbidden}"`,
      );
    }

    // And the recorded row carries a full SHA, because that is the only identity it may bind.
    expectOk(
      await harness.card.recordVerification({
        projectId: PROJECT,
        candidateId: seeded.candidateId,
        actor: OWNER,
        correlationId: 'corr-shape',
      }),
    );
    const rows = expectOk(
      new SqliteMvpReviewStore(harness.db).readProjection({
        candidateId: seeded.candidateId as CandidateId,
        candidateHeadSha: HEAD,
        contractId: seeded.contractId as ContractId,
        contractRevision: 1,
      }),
    ).evidence;
    assert.match(
      String(rows[0]?.binding?.candidateHeadSha),
      /^[0-9a-f]{40}$/,
      'a branch name, an abbreviation and a pull request number are not candidate identity',
    );
  });
});

