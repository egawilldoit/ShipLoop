import assert from 'node:assert/strict';
import test from 'node:test';

import { asCommitSha } from '../ids.ts';
import type { OwnerId } from '../ids.ts';
import { buildMvpReviewReadModel, recordMvpEvidence, recordMvpOwnerDecision } from './index.ts';
import type {
  MvpCandidateView,
  MvpContractView,
  MvpEvidenceObservation,
  MvpRecordedEvidence,
  MvpRequestView,
  MvpReviewInput,
  MvpReviewReadModel,
  MvpVerificationPolicy,
} from './index.ts';

const HEAD = asCommitSha('a'.repeat(40));
const NEXT_HEAD = asCommitSha('e'.repeat(40));
const OWNER = 'own-1' as OwnerId;

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
  outOfScope: ['Registration', 'Password reset'],
  acceptanceCriteria: [
    { id: 'c-auto', description: 'The existing unit suite passes.', verificationType: 'automated', verificationCheckId: 'unit' },
    { id: 'c-owner', description: 'Sign in and confirm the dashboard appears.', verificationType: 'owner_test', verificationCheckId: null },
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
  observedAt: '2026-10-03T09:00:00Z',
};

const POLICY: MvpVerificationPolicy = {
  policyId: 'test',
  requiredAutomatedCheckIds: ['unit'],
  deliveryRequiredCheckIds: ['unit'],
  ownerTestBlocksReview: false,
  ownerTestBlocksDelivery: true,
};

function checkEvidence(overrides: {
  checkId?: string;
  outcome?: 'passed' | 'failed' | 'waiting' | 'missing';
  headSha?: string | null;
  revision?: number | null;
  evidenceId?: string;
} = {}): MvpRecordedEvidence {
  const observation: MvpEvidenceObservation = {
    kind: 'command',
    outcome: overrides.outcome ?? 'passed',
  };
  const recorded = recordMvpEvidence({
    evidenceId: overrides.evidenceId ?? `evid-${overrides.checkId ?? 'unit'}`,
    contractId: 'contract-1',
    candidateId: 'cand-1',
    subject: { kind: 'check', checkId: overrides.checkId ?? 'unit' },
    method: { kind: 'AutomatedCheck', checkId: overrides.checkId ?? 'unit' },
    observation,
    observedHeadSha: overrides.headSha === undefined ? HEAD : overrides.headSha,
    observedContractRevision: overrides.revision === undefined ? 2 : overrides.revision,
    observedAt: '2026-10-03T09:30:00Z',
    detail: null,
    artifactRef: null,
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) throw new Error('fixture must be valid evidence');
  return recorded.value;
}

function ownerEvidence(outcome: 'passed' | 'failed' | 'capture_failed' = 'passed'): MvpRecordedEvidence {
  const recorded = recordMvpEvidence({
    evidenceId: 'evid-owner',
    contractId: 'contract-1',
    candidateId: 'cand-1',
    subject: { kind: 'criterion', criterionId: 'c-owner' },
    method: { kind: 'OwnerTest', instructions: 'Sign in and look at the dashboard.' },
    observation: { kind: 'owner_test', outcome, actor: { role: 'owner', ownerId: OWNER } },
    observedHeadSha: HEAD,
    observedContractRevision: 2,
    observedAt: '2026-10-03T09:45:00Z',
    detail: null,
    artifactRef: null,
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) throw new Error('fixture must be valid evidence');
  return recorded.value;
}

function decision(kind: 'accepted' | 'changes_requested', overrides: { headSha?: string; revision?: number; decidedAt?: string; id?: string } = {}) {
  const recorded = recordMvpOwnerDecision({
    decisionId: overrides.id ?? `dec-${kind}`,
    kind,
    actor: { role: 'owner', ownerId: OWNER },
    projectId: 'proj-1',
    requestId: 'req-1',
    contractId: 'contract-1',
    contractRevision: overrides.revision ?? 2,
    candidateId: 'cand-1',
    candidateHeadSha: overrides.headSha ?? HEAD,
    decidedAt: overrides.decidedAt ?? '2026-10-03T10:00:00Z',
    feedback: kind === 'changes_requested' ? 'the label is wrong' : null,
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) throw new Error('fixture must be a valid decision');
  return recorded.value;
}

function input(overrides: Partial<MvpReviewInput> = {}): MvpReviewInput {
  return {
    request: REQUEST,
    contract: CONTRACT,
    candidate: CANDIDATE,
    policy: POLICY,
    evidence: [],
    decisions: [],
    evaluatedAt: '2026-10-03T10:00:00Z',
    ...overrides,
  };
}

function stateOf(model: { criteria: readonly { criterionId: string; state: string }[] }, criterionId: string): string {
  const found = model.criteria.find((criterion) => criterion.criterionId === criterionId);
  assert.ok(found !== undefined, `expected a criterion result for ${criterionId}`);
  return found?.state ?? '';
}

test('the read model carries request, contract, candidate, checks, criteria, evidence, staleness, decision and eligibility', () => {
  const model = buildModel(input({ evidence: [checkEvidence(), ownerEvidence()], decisions: [decision('accepted')] }));
  assert.equal(model.request.id, 'req-1');
  assert.equal(model.contract.revision, 2);
  assert.equal(model.candidate.headSha, HEAD);
  assert.equal(model.checks.length, 1);
  assert.equal(model.criteria.length, 2);
  assert.equal(model.evidence.length, 2);
  assert.equal(model.staleness.stale, false);
  assert.equal(model.decision.outcome, 'accepted');
  assert.equal(model.eligibility.readyForOwnerReview, true);
  assert.equal(model.eligibility.readyForDelivery, true);
});

/** Asserts the projection succeeded, so the error branch never needs narrowing. */
function buildModel(request: MvpReviewInput): MvpReviewReadModel {
  const built = buildMvpReviewReadModel(request);
  if (!built.ok) throw new Error(`expected a review projection, got ${built.error.code}: ${built.error.reason}`);
  return built.value;
}

test('an unverified automated criterion keeps the candidate out of owner review', () => {
  const model = buildModel(input({ evidence: [checkEvidence(), ownerEvidence('passed')] }));
  assert.equal(stateOf(model, 'c-owner'), 'passed');
  assert.equal(model.eligibility.readyForOwnerReview, true);
});

test('an owner-test criterion with no recorded test is pending, never passed or unverified', () => {
  const model = buildModel(input({ evidence: [checkEvidence()] }));
  assert.equal(stateOf(model, 'c-owner'), 'pending');
  assert.equal(model.criteria.find((c) => c.criterionId === 'c-owner')?.verificationType, 'owner_test');
  assert.ok(model.eligibility.ownerActions.some((action) => action.includes('c-owner')));
});

test('a pending owner test does not block the review offer but does block delivery', () => {
  const model = buildModel(input({ evidence: [checkEvidence()], decisions: [decision('accepted')] }));
  assert.equal(model.eligibility.readyForOwnerReview, true);
  assert.equal(model.eligibility.readyForDelivery, false);
  assert.ok(model.eligibility.ownerActions.length === 1);
});

test('an automated result cannot discharge an owner test', () => {
  const model = buildModel(input({ evidence: [checkEvidence(), checkEvidence({ evidenceId: 'evid-extra', checkId: 'unit-again' })] }));
  assert.equal(stateOf(model, 'c-owner'), 'pending');
});

test('a failed required check blocks the review offer and names the check', () => {
  const model = buildModel(input({ evidence: [checkEvidence({ outcome: 'failed' }), ownerEvidence()] }));
  assert.equal(model.eligibility.readyForOwnerReview, false);
  assert.ok(model.eligibility.blockingReasons.some((reason) => reason.includes('unit') && reason.includes('failed')));
});

test('a missing required check blocks: a check that did not run is not a pass', () => {
  const model = buildModel(input({ evidence: [ownerEvidence()] }));
  const unit = model.checks.find((check) => check.checkId === 'unit');
  assert.equal(unit?.result, 'not_run');
  assert.equal(model.eligibility.readyForOwnerReview, false);
});

test('evidence recorded for an older commit makes the criterion stale and blocks review', () => {
  const model = buildModel(input({
    evidence: [checkEvidence({ headSha: NEXT_HEAD }), ownerEvidence()],
  }));
  assert.equal(stateOf(model, 'c-owner'), 'passed');
  assert.equal(model.staleness.stale, true);
  assert.equal(model.staleness.staleEvidenceIds.length, 1);
  assert.equal(model.eligibility.readyForOwnerReview, false);
  const unit = model.checks.find((check) => check.checkId === 'unit');
  assert.equal(unit?.result, 'stale');
  assert.equal(unit?.blocking, true);
});

test('evidence recorded against an earlier contract revision is stale too', () => {
  const model = buildModel(input({ evidence: [checkEvidence({ revision: 1 }), ownerEvidence()] }));
  assert.equal(model.staleness.stale, true);
  assert.equal(model.eligibility.readyForOwnerReview, false);
});

test('unattributed evidence is stale rather than a pass', () => {
  const model = buildModel(input({
    evidence: [checkEvidence({ headSha: null, revision: null }), ownerEvidence()],
  }));
  assert.equal(model.staleness.stale, true);
  assert.equal(model.eligibility.readyForOwnerReview, false);
});

test('an acceptance for a previous SHA does not authorize the candidate on screen', () => {
  const staleAcceptance = decision('accepted', { headSha: NEXT_HEAD });
  const model = buildModel(input({
    evidence: [checkEvidence(), ownerEvidence()],
    decisions: [staleAcceptance],
  }));
  assert.equal(model.decision.outcome, 'none');
  assert.equal(model.decision.authorizesCurrentCandidate, false);
  assert.equal(model.decision.staleDecisions[0]?.decisionId, staleAcceptance.decisionId);
  assert.equal(model.eligibility.readyForDelivery, false);
  assert.ok(model.eligibility.blockingReasons.every((reason) => !reason.includes('Accept')));
});

test('an acceptance for the current SHA authorizes it', () => {
  const model = buildModel(input({
    evidence: [checkEvidence(), ownerEvidence()],
    decisions: [decision('accepted')],
  }));
  assert.equal(model.decision.authorizesCurrentCandidate, true);
  assert.equal(model.eligibility.readyForDelivery, true);
});

test('a change request against the current SHA shows the feedback and is not an acceptance', () => {
  const model = buildModel(input({
    evidence: [checkEvidence(), ownerEvidence()],
    decisions: [decision('changes_requested')],
  }));
  assert.equal(model.decision.outcome, 'changes_requested');
  assert.equal(model.decision.authorizesCurrentCandidate, false);
  assert.equal(model.decision.decision?.feedback, 'the label is wrong');
  assert.equal(model.eligibility.readyForDelivery, false);
});

test('a contract that is not approved is refused: there is nothing to review against', () => {
  const draft: MvpContractView = { ...CONTRACT, status: 'draft', approvedAt: null };
  const built = buildMvpReviewReadModel(input({ contract: draft }));
  assert.equal(built.ok, false);
  if (built.ok || built.error.code !== 'Invalid') return;
  assert.equal(built.error.code, 'Invalid');
});

test('a candidate bound to a different contract revision is a conflict, not a projection', () => {
  const moved: MvpContractView = { ...CONTRACT, revision: 3 };
  const built = buildMvpReviewReadModel(input({ contract: moved }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.equal(built.error.code, 'Conflict');
});

test('a failed owner test reports failed rather than pending or unverified', () => {
  const model = buildModel(input({ evidence: [checkEvidence(), ownerEvidence('failed')] }));
  assert.equal(stateOf(model, 'c-owner'), 'failed');
  assert.equal(model.eligibility.readyForOwnerReview, false);
});

test('a failed capture leaves the criterion unverified, not failed', () => {
  const model = buildModel(input({ evidence: [checkEvidence(), ownerEvidence('capture_failed')] }));
  assert.equal(stateOf(model, 'c-owner'), 'unverified');
  assert.ok(model.criteria.find((c) => c.criterionId === 'c-owner')?.reason.includes('capture'));
});

test('criterion results carry the evidence identity and time that produced them', () => {
  const model = buildModel(input({ evidence: [checkEvidence(), ownerEvidence()] }));
  const automated = model.criteria.find((c) => c.criterionId === 'c-auto');
  assert.equal(automated?.evidenceId, 'evid-unit');
  assert.equal(automated?.observedAt, '2026-10-03T09:30:00Z');
  const ownerCriterion = model.criteria.find((c) => c.criterionId === 'c-owner');
  assert.equal(ownerCriterion?.evidenceId, 'evid-owner');
  assert.equal(ownerCriterion?.observedAt, '2026-10-03T09:45:00Z');
});

test('a stricter policy can make an outstanding owner test block the review offer', () => {
  const strict: MvpVerificationPolicy = { ...POLICY, ownerTestBlocksReview: true };
  const model = buildModel(input({ policy: strict, evidence: [checkEvidence()] }));
  assert.equal(model.eligibility.readyForOwnerReview, false);
  assert.ok(model.eligibility.blockingReasons.some((reason) => reason.includes('Owner test')));
});