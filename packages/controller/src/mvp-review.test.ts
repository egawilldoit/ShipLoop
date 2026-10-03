/**
 * Behavioural proof for the MVP review use cases, against a real migrated database.
 *
 * The store is `SqliteMvpReviewStore` over a temporary SQLite file, not a fake. The point
 * of these tests is that a SHA binding survives a real round trip, and an in-memory fake
 * would let a column mapping bug pass while the product fails at runtime — the failure
 * `core.test.ts` documents happening before.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { asCommitSha, buildMvpReviewReadModel } from '@shiploop/domain';
import type {
  MvpCandidateView,
  MvpContractView,
  MvpOwnerActor,
  MvpRequestView,
  MvpReviewReadModel,
  MvpVerificationPolicy,
  OwnerId,
  Result,
} from '@shiploop/domain';
import { openDatabase } from '@shiploop/storage';
import { migrate } from '@shiploop/storage';
import { SqliteMvpReviewStore } from '@shiploop/storage';
import type { Database } from '@shiploop/storage';
import { createMvpReviewUseCases } from './mvp-review.ts';
import type { MvpReviewFacts, RecordEvidenceInput } from './mvp-review.ts';

const HEAD = asCommitSha('a1b2c3d4'.repeat(5));
const NEXT_HEAD = asCommitSha('f0e1d2c3'.repeat(5));
const OWNER_ID = 'owner-0000-4000-8000-00000000000c' as OwnerId;
const OWNER: MvpOwnerActor = { role: 'owner', ownerId: OWNER_ID };
const T0 = '2026-10-03T09:00:00Z';
const T1 = '2026-10-03T09:30:00Z';
const T2 = '2026-10-03T10:00:00Z';

const REQUEST: MvpRequestView = {
  id: 'req-1',
  projectId: 'proj-1',
  title: 'Fix the login redirect',
  description: 'After signing in, land on the dashboard.',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

const CONTRACT: MvpContractView = {
  id: 'contract-1',
  projectId: 'proj-1',
  requestId: 'req-1',
  revision: 2,
  outcome: 'Signing in lands the user on the dashboard.',
  scope: 'The login form and its redirect.',
  outOfScope: ['Registration'],
  acceptanceCriteria: [
    { id: 'c-auto', description: 'The unit suite passes.', verificationType: 'automated', verificationCheckId: 'unit' },
    { id: 'c-owner', description: 'Sign in and see the dashboard.', verificationType: 'owner_test', verificationCheckId: null },
  ],
  status: 'approved',
  approvedAt: '2026-10-01T01:00:00Z',
  createdAt: '2026-10-01T00:30:00Z',
  updatedAt: '2026-10-01T01:00:00Z',
};

const CANDIDATE: MvpCandidateView = {
  id: 'cand-1',
  projectId: 'proj-1',
  requestId: 'req-1',
  contractId: 'contract-1',
  contractRevision: 2,
  repository: 'acme/web',
  pullRequestNumber: 42,
  pullRequestUrl: 'https://example.invalid/acme/web/pull/42',
  baseBranch: 'main',
  headSha: HEAD,
  observedAt: T0,
};

const POLICY: MvpVerificationPolicy = {
  policyId: 'test',
  requiredAutomatedCheckIds: ['unit'],
  deliveryRequiredCheckIds: ['unit'],
  ownerTestBlocksReview: false,
  ownerTestBlocksDelivery: true,
};

function facts(overrides: { contract?: MvpContractView; candidate?: MvpCandidateView } = {}): MvpReviewFacts {
  return {
    request: REQUEST,
    contract: overrides.contract ?? CONTRACT,
    candidate: overrides.candidate ?? CANDIDATE,
    policy: POLICY,
  };
}

const BASE = {
  projectId: 'proj-1',
  requestId: 'req-1',
  candidateId: 'cand-1',
  expectedHeadSha: HEAD,
  expectedContractRevision: 2,
};

function expectOk<T>(result: Result<T, import('@shiploop/domain').DomainError>): T {
  if (!result.ok) assert.fail(`expected success but received ${result.error.code}: ${result.error.reason}`);
  return result.value;
}

function expectErr<T>(result: Result<T, import('@shiploop/domain').DomainError>) {
  if (result.ok) assert.fail('expected a refusal');
  return result.error;
}

let decisionCounter = 0;

/** Drives the use cases against a real migrated database. */
async function withUseCases(
  run: (api: {
    readonly useCases: ReturnType<typeof createMvpReviewUseCases>;
    readonly db: Database;
    readonly at: (instant: string) => void;
  }) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-mvp-controller-'));
  try {
    const opened = openDatabase(join(directory, 'review.sqlite'));
    assert.ok(opened.ok);
    const db = opened.value;
    expectOk(migrate(db));
    let instant = T0;
    const useCases = createMvpReviewUseCases({
      store: new SqliteMvpReviewStore(db),
      clock: { now: () => instant },
      newDecisionId: () => `dec-${(decisionCounter += 1)}`,
    });
    await run({ useCases, db, at: (value) => { instant = value; } });
    db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Records a passing automated observation for a criterion's bound check. */
async function recordPassingUnit(api: { useCases: ReturnType<typeof createMvpReviewUseCases> }): Promise<MvpReviewReadModel> {
  const input: RecordEvidenceInput = {
    ...BASE,
    facts: facts(),
    evidenceId: 'evid-unit-1',
    subject: { kind: 'check', checkId: 'unit' },
    method: { kind: 'AutomatedCheck', checkId: 'unit' },
    observation: { kind: 'command', outcome: 'passed' },
    owner: null,
    observedHeadSha: HEAD,
    observedContractRevision: 2,
    observedAt: T1,
    detail: null,
    artifactRef: null,
    correlationId: 'corr-1',
  };
  return expectOk(await api.useCases.recordEvidence(input));
}

test('review returns one read model with the request, contract, candidate, criteria and eligibility', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    const model = expectOk(await api.useCases.review({ ...BASE, facts: facts() }));
    assert.equal(model.request.id, 'req-1');
    assert.equal(model.contract.revision, 2);
    assert.equal(model.candidate.headSha, HEAD);
    assert.equal(model.criteria.length, 2);
    assert.equal(model.criteria.find((c) => c.criterionId === 'c-owner')?.state, 'pending');
    assert.equal(model.decision.outcome, 'none');
    assert.equal(model.eligibility.readyForOwnerReview, false);
  });
});

test('a passing required check plus an owner test makes the candidate ready and acceptable', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    const withCheck = await recordPassingUnit(api);
    assert.equal(withCheck.criteria.find((c) => c.criterionId === 'c-auto')?.state, 'passed');

    const accepted = expectOk(await api.useCases.recordOwnerTest({
      ...BASE,
      facts: facts(),
      actor: OWNER,
      criterionId: 'c-owner',
      outcome: 'passed',
      evidenceId: 'evid-owner-1',
      observedAt: T2,
      detail: null,
      artifactRef: null,
      correlationId: 'corr-2',
    }));
    assert.equal(accepted.criteria.find((c) => c.criterionId === 'c-owner')?.state, 'passed');
    assert.equal(accepted.eligibility.readyForOwnerReview, true);
    assert.equal(accepted.eligibility.ownerActions.length, 0);

    const decided = expectOk(await api.useCases.decide({
      ...BASE,
      facts: facts(),
      actor: OWNER,
      kind: 'accepted',
      feedback: null,
      correlationId: 'corr-3',
    }));
    assert.equal(decided.decision.outcome, 'accepted');
    assert.equal(decided.decision.authorizesCurrentCandidate, true);
    assert.equal(decided.eligibility.readyForDelivery, true);
  });
});

test('accepting is blocked while the owner test is still pending, and names what is outstanding', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    await recordPassingUnit(api);
    const error = expectErr(await api.useCases.decide({
      ...BASE,
      facts: facts(),
      actor: OWNER,
      kind: 'accepted',
      feedback: null,
      correlationId: 'corr-2',
    }));
    assert.equal(error.code, 'Blocked');
    assert.ok(error.prerequisites.some((item) => item.detail.includes('c-owner')));
  });
});

test('an agent cannot accept, request changes, or record an owner test', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    await recordPassingUnit(api);
    for (const role of ['agent', 'automation', 'system'] as const) {
      const accepted = await api.useCases.decide({
        ...BASE,
        facts: facts(),
        actor: { role },
        kind: 'accepted',
        feedback: null,
        correlationId: 'corr-x',
      });
      assert.equal(expectErr(accepted).code, 'Forbidden');

      const ownerTest = await api.useCases.recordOwnerTest({
        ...BASE,
        facts: facts(),
        actor: { role },
        criterionId: 'c-owner',
        outcome: 'passed',
        evidenceId: 'evid-owner-x',
        observedAt: T2,
        detail: null,
        artifactRef: null,
        correlationId: 'corr-x',
      });
      assert.equal(expectErr(ownerTest).code, 'Forbidden');
    }
    const model = expectOk(await api.useCases.review({ ...BASE, facts: facts() }));
    assert.equal(model.decision.outcome, 'none');
    assert.equal(model.criteria.find((c) => c.criterionId === 'c-owner')?.state, 'pending');
  });
});

test('request changes stores feedback and leaves the candidate unaccepted', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    const model = expectOk(await api.useCases.decide({
      ...BASE,
      facts: facts(),
      actor: OWNER,
      kind: 'changes_requested',
      feedback: 'the redirect still lands on /login',
      correlationId: 'corr-2',
    }));
    assert.equal(model.decision.outcome, 'changes_requested');
    assert.equal(model.decision.authorizesCurrentCandidate, false);
    assert.equal(model.decision.decision?.feedback, 'the redirect still lands on /login');
    assert.equal(model.eligibility.readyForDelivery, false);
  });
});

test('a change request without feedback is refused', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    const error = expectErr(await api.useCases.decide({
      ...BASE,
      facts: facts(),
      actor: OWNER,
      kind: 'changes_requested',
      feedback: '   ',
      correlationId: 'corr-2',
    }));
    assert.equal(error.code, 'Invalid');
  });
});

test('an acceptance recorded for the old SHA does not survive the push', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    await recordPassingUnit(api);
    expectOk(await api.useCases.recordOwnerTest({
      ...BASE, facts: facts(), actor: OWNER, criterionId: 'c-owner', outcome: 'passed',
      evidenceId: 'evid-owner-1', observedAt: T2, detail: null, artifactRef: null, correlationId: 'corr-2',
    }));
    const accepted = expectOk(await api.useCases.decide({
      ...BASE, facts: facts(), actor: OWNER, kind: 'accepted', feedback: null, correlationId: 'corr-3',
    }));
    assert.equal(accepted.decision.authorizesCurrentCandidate, true);

    // The push: the same request and contract, a new candidate, and the old evidence and
    // decision still in the store under the previous commit. A submission from the old
    // card conflicts rather than being re-pointed at the new one (F24-AC4).
    const pushed = facts({ candidate: { ...CANDIDATE, id: 'cand-2', headSha: NEXT_HEAD } });
    const staleCard = expectErr(await api.useCases.decide({
      ...BASE, facts: pushed, actor: OWNER, kind: 'accepted', feedback: null, correlationId: 'corr-4',
    }));
    assert.equal(staleCard.code, 'Conflict');

    // A decision submitted against the old SHA of the *same* candidate also conflicts,
    // because the SHA is the identity that makes the acceptance mean anything.
    const staleSha = expectErr(await api.useCases.decide({
      ...BASE, expectedHeadSha: NEXT_HEAD, facts: facts(), actor: OWNER, kind: 'accepted',
      feedback: null, correlationId: 'corr-5',
    }));
    assert.equal(staleSha.code, 'Conflict');
    assert.equal(staleSha.expected, NEXT_HEAD);
    assert.equal(staleSha.actual, HEAD);
  });
});

test('a stale acceptance is reported as stale rather than silently dropped', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    await recordPassingUnit(api);
    expectOk(await api.useCases.recordOwnerTest({
      ...BASE, facts: facts(), actor: OWNER, criterionId: 'c-owner', outcome: 'passed',
      evidenceId: 'evid-owner-1', observedAt: T2, detail: null, artifactRef: null, correlationId: 'corr-2',
    }));
    expectOk(await api.useCases.decide({
      ...BASE, facts: facts(), actor: OWNER, kind: 'accepted', feedback: null, correlationId: 'corr-3',
    }));

    // Read the stored rows directly and ask the domain projection, bypassing the use
    // case's conflict guard, to prove the staleness is a property of the data.
    const stored = expectOk(new SqliteMvpReviewStore(api.db).readProjection({
      candidateId: 'cand-1',
      candidateHeadSha: NEXT_HEAD,
      contractId: 'contract-1',
      contractRevision: 2,
    }));
    const model = expectOk(buildMvpReviewReadModel({
      request: REQUEST,
      contract: CONTRACT,
      candidate: { ...CANDIDATE, headSha: NEXT_HEAD },
      policy: POLICY,
      evidence: stored.evidence,
      decisions: stored.decisions,
      evaluatedAt: T2,
    }));
    assert.equal(model.decision.outcome, 'none');
    assert.equal(model.decision.authorizesCurrentCandidate, false);
    assert.equal(model.decision.staleDecisions.length, 1);
    assert.equal(model.decision.staleDecisions[0]?.candidateHeadSha, HEAD);
    assert.ok(model.staleness.stale);
    assert.equal(model.eligibility.readyForDelivery, false);
  });
});

test('old evidence against the new SHA makes the criterion stale and blocks the review offer', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    await recordPassingUnit(api);
    const stored = expectOk(new SqliteMvpReviewStore(api.db).readProjection({
      candidateId: 'cand-1',
      candidateHeadSha: NEXT_HEAD,
      contractId: 'contract-1',
      contractRevision: 2,
    }));
    const model = expectOk(buildMvpReviewReadModel({
      request: REQUEST,
      contract: CONTRACT,
      candidate: { ...CANDIDATE, headSha: NEXT_HEAD },
      policy: POLICY,
      evidence: stored.evidence,
      decisions: stored.decisions,
      evaluatedAt: T2,
    }));
    assert.equal(model.criteria.find((c) => c.criterionId === 'c-auto')?.state, 'stale');
    assert.equal(model.checks.find((check) => check.checkId === 'unit')?.result, 'stale');
    assert.equal(model.eligibility.readyForOwnerReview, false);
  });
});

test('a submission prepared against an older contract revision conflicts', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    const error = expectErr(await api.useCases.review({
      ...BASE,
      expectedContractRevision: 1,
      facts: facts(),
    }));
    assert.equal(error.code, 'Conflict');
    assert.equal(error.expected, '1');
    assert.equal(error.actual, '2');
  });
});

test('a submission naming a branch name instead of a SHA is refused', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    const error = expectErr(await api.useCases.review({ ...BASE, expectedHeadSha: 'main', facts: facts() }));
    assert.equal(error.code, 'Invalid');
  });
});

test('a failed automated observation blocks acceptance', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    expectOk(await api.useCases.recordEvidence({
      ...BASE,
      facts: facts(),
      evidenceId: 'evid-unit-1',
      subject: { kind: 'check', checkId: 'unit' },
      method: { kind: 'AutomatedCheck', checkId: 'unit' },
      observation: { kind: 'command', outcome: 'failed' },
      owner: null,
      observedHeadSha: HEAD,
      observedContractRevision: 2,
      observedAt: T1,
      detail: null,
      artifactRef: null,
      correlationId: 'corr-1',
    }));
    const model = expectOk(await api.useCases.review({ ...BASE, facts: facts() }));
    assert.equal(model.criteria.find((c) => c.criterionId === 'c-auto')?.state, 'failed');
    assert.equal(model.eligibility.readyForOwnerReview, false);
    const error = expectErr(await api.useCases.decide({
      ...BASE, facts: facts(), actor: OWNER, kind: 'accepted', feedback: null, correlationId: 'corr-2',
    }));
    assert.equal(error.code, 'Blocked');
  });
});

test('an automated criterion cannot be discharged by recording an owner test against it', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    const error = expectErr(await api.useCases.recordOwnerTest({
      ...BASE, facts: facts(), actor: OWNER, criterionId: 'c-auto', outcome: 'passed',
      evidenceId: 'evid-owner-x', observedAt: T2, detail: null, artifactRef: null, correlationId: 'corr-2',
    }));
    assert.equal(error.code, 'Invalid');
    assert.match(error.reason, /verified automatically/);
  });
});

test('an owner test for a criterion the contract does not declare is not found', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    const error = expectErr(await api.useCases.recordOwnerTest({
      ...BASE, facts: facts(), actor: OWNER, criterionId: 'nope', outcome: 'passed',
      evidenceId: 'evid-owner-x', observedAt: T2, detail: null, artifactRef: null, correlationId: 'corr-2',
    }));
    assert.equal(error.code, 'NotFound');
  });
});

test('a draft contract is not reviewable', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    const draft = facts({ contract: { ...CONTRACT, status: 'draft', approvedAt: null } });
    const error = expectErr(await api.useCases.review({ ...BASE, facts: draft }));
    assert.equal(error.code, 'Invalid');
  });
});

test('a failed owner test keeps the criterion failed and blocks acceptance', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    await recordPassingUnit(api);
    const model = expectOk(await api.useCases.recordOwnerTest({
      ...BASE, facts: facts(), actor: OWNER, criterionId: 'c-owner', outcome: 'failed',
      evidenceId: 'evid-owner-1', observedAt: T2, detail: 'nothing happens on click',
      artifactRef: null, correlationId: 'corr-2',
    }));
    assert.equal(model.criteria.find((c) => c.criterionId === 'c-owner')?.state, 'failed');
    assert.equal(model.eligibility.readyForOwnerReview, false);
  });
});

test('a failed capture leaves the criterion unverified rather than failed', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    await recordPassingUnit(api);
    const model = expectOk(await api.useCases.recordOwnerTest({
      ...BASE, facts: facts(), actor: OWNER, criterionId: 'c-owner', outcome: 'capture_failed',
      evidenceId: 'evid-owner-1', observedAt: T2, detail: null, artifactRef: null, correlationId: 'corr-2',
    }));
    assert.equal(model.criteria.find((c) => c.criterionId === 'c-owner')?.state, 'unverified');
  });
});

test('a later owner test supersedes an earlier one for the same candidate', async () => {
  await withUseCases(async (api) => {
    api.at(T1);
    await recordPassingUnit(api);
    expectOk(await api.useCases.recordOwnerTest({
      ...BASE, facts: facts(), actor: OWNER, criterionId: 'c-owner', outcome: 'failed',
      evidenceId: 'evid-owner-1', observedAt: T2, detail: null, artifactRef: null, correlationId: 'corr-2',
    }));
    const corrected = expectOk(await api.useCases.recordOwnerTest({
      ...BASE, facts: facts(), actor: OWNER, criterionId: 'c-owner', outcome: 'passed',
      evidenceId: 'evid-owner-2', observedAt: '2026-10-03T11:00:00Z', detail: null, artifactRef: null,
      correlationId: 'corr-3',
    }));
    assert.equal(corrected.criteria.find((c) => c.criterionId === 'c-owner')?.state, 'passed');
    assert.equal(corrected.evidence.length, 3);
  });
});