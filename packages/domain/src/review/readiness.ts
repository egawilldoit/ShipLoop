import { err, invalid, ok } from '../result.ts';
import type { DomainError, Result } from '../result.ts';
import type { CommitSha } from '../ids.ts';
import { deriveCriterionState } from './criterion.ts';
import type { CriterionState, MvpVerificationType } from './criterion.ts';
import { assessMvpEvidence } from './evidence.ts';
import type {
  MvpEvidenceOutcome,
  MvpEvidenceSource,
  MvpEvidenceVerdict,
  MvpRecordedEvidence,
} from './evidence.ts';
import type { CriterionVerificationMethod } from '../evidence.ts';
import { governingMvpDecision } from './decision.ts';
import type { MvpDecisionKind, MvpOwnerDecision } from './decision.ts';

/**
 * The review read model and readiness eligibility (mvp-spec F24, F20-AC3, F23-AC1).
 *
 * One projection, computed once, from facts. Everything the owner sees on the review
 * card is derived here rather than accumulated across routes, which is what makes the
 * card self-consistent: a criterion cannot be green on one panel and stale on another,
 * because there is only one `criterionResults` array and the UI reads it.
 *
 * Readiness is a policy question, and the policy is an explicit input. The default
 * shipped policy (`MvpDefaultVerificationPolicy`) requires every configured automated
 * gate to have passed against the current candidate, and treats a pending owner test as
 * an owner action rather than a blocker. That is the F24-AC3 rule: pending owner-test
 * criteria may be pending when the candidate is offered for review, but they must be
 * discharged before the work is delivered.
 */

export interface MvpRequestView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MvpContractCriterionView {
  readonly id: string;
  readonly description: string;
  readonly verificationType: MvpVerificationType;
  /**
   * For an `automated` criterion, the check whose result verifies it.
   *
   * The criterion names its verifier rather than the projection inferring it from
   * whichever check happened to pass. Inference is how a green suite ends up
   * "verifying" a criterion no one bound to it (F23-AC1), and it would let a caller
   * point a criterion at a check purely because that check is green. Null for an
   * owner test, and null for an automated criterion nobody assigned, which leaves it
   * `unverified`.
   */
  readonly verificationCheckId: string | null;
}

export type MvpContractStatus = 'draft' | 'approved' | 'stale';

export interface MvpContractView {
  readonly id: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly revision: number;
  readonly outcome: string;
  readonly scope: string;
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly MvpContractCriterionView[];
  readonly status: MvpContractStatus;
  readonly approvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MvpCandidateView {
  readonly id: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly repository: string;
  readonly pullRequestNumber: number | null;
  readonly pullRequestUrl: string;
  readonly baseBranch: string;
  readonly headSha: CommitSha;
  readonly observedAt: string;
}

/** The policy a project selected, expressed as what it refuses to let through. */
export interface MvpVerificationPolicy {
  readonly policyId: string;
  /**
   * Automated gates that must read `passed` against the current candidate before the
   * candidate is offered for owner review (F24-AC3).
   */
  readonly requiredAutomatedCheckIds: readonly string[];
  /** Automated gates that must additionally pass before delivery is authorised. */
  readonly deliveryRequiredCheckIds: readonly string[];
  /** Whether a pending owner test blocks the owner-review offer. Default policy: false. */
  readonly ownerTestBlocksReview: boolean;
  /** Whether a pending owner test blocks delivery authorisation. Default policy: true. */
  readonly ownerTestBlocksDelivery: boolean;
}

/**
 * The MVP policy shipped with the product.
 *
 * `ownerTestBlocksReview: false` is the F24-AC3 reading stated as configuration rather
 * than as a special case in the code: the candidate is offered, and the owner test is
 * shown as an action they own. `ownerTestBlocksDelivery: true` is the other half — an
 * unrun owner test does not stop the review, but it does stop delivery.
 */
export const MvpDefaultVerificationPolicy: MvpVerificationPolicy = Object.freeze({
  policyId: 'mvp-default',
  requiredAutomatedCheckIds: Object.freeze([]),
  deliveryRequiredCheckIds: Object.freeze([]),
  ownerTestBlocksReview: false,
  ownerTestBlocksDelivery: true,
});

export interface MvpEvidenceView {
  readonly evidenceId: string;
  readonly source: MvpEvidenceSource;
  readonly criterionId: string | null;
  readonly checkId: string | null;
  readonly method: CriterionVerificationMethod;
  /** The outcome as recorded. Read it together with `applies` — an old pass is still `passed` here. */
  readonly outcome: MvpEvidenceOutcome;
  /** The outcome only when the evidence describes the current candidate; `stale` otherwise. */
  readonly currentOutcome: MvpEvidenceOutcome | 'stale';
  readonly appliesToCurrentCandidate: boolean;
  readonly staleReasons: readonly string[];
  readonly reason: string;
  readonly observedAt: string | null;
  readonly candidateHeadSha: string | null;
  readonly contractRevision: number | null;
  readonly detail: string | null;
  readonly artifactRef: string | null;
}

export interface MvpCheckView {
  readonly checkId: string;
  readonly required: boolean;
  readonly result: MvpEvidenceOutcome | 'stale' | 'not_run';
  readonly blocking: boolean;
  readonly evidenceId: string | null;
  readonly source: MvpEvidenceSource | null;
  readonly reason: string;
}

export interface MvpCriterionResultView {
  readonly criterionId: string;
  readonly description: string;
  readonly verificationType: MvpVerificationType;
  readonly state: CriterionState;
  readonly method: CriterionVerificationMethod;
  readonly evidenceId: string | null;
  readonly observedAt: string | null;
  readonly reason: string;
}

export interface MvpStaleView {
  readonly stale: boolean;
  readonly reasons: readonly string[];
  /** Evidence that no longer describes the current candidate. */
  readonly staleEvidenceIds: readonly string[];
  /** Decisions that no longer authorise the current candidate (F25-AC3, F27-AC3). */
  readonly staleDecisionIds: readonly string[];
}

export type MvpDecisionOutcome = 'none' | 'accepted' | 'changes_requested';

/** One decision that no longer describes the candidate under review. */
export interface MvpStaleDecisionView {
  readonly decisionId: string;
  readonly kind: MvpDecisionKind;
  readonly candidateHeadSha: string;
  readonly contractRevision: number;
  readonly reason: string;
}

export interface MvpDecisionView {
  readonly outcome: MvpDecisionOutcome;
  readonly decision: MvpOwnerDecision | null;
  readonly staleDecisions: readonly MvpStaleDecisionView[];
  /**
   * Whether the current decision authorises the candidate that is actually on screen.
   *
   * False after a push, which is the read a delivery gate must consult rather than
   * `outcome`: an acceptance for SHA A does not authorise SHA B (F27-AC3).
   */
  readonly authorizesCurrentCandidate: boolean;
}

export interface MvpEligibility {
  readonly readyForOwnerReview: boolean;
  readonly readyForDelivery: boolean;
  readonly blockingReasons: readonly string[];
  readonly ownerActions: readonly string[];
}

export interface MvpReviewReadModel {
  readonly request: MvpRequestView;
  readonly contract: MvpContractView;
  readonly candidate: MvpCandidateView;
  readonly policy: MvpVerificationPolicy;
  readonly checks: readonly MvpCheckView[];
  readonly criteria: readonly MvpCriterionResultView[];
  readonly evidence: readonly MvpEvidenceView[];
  readonly staleness: MvpStaleView;
  readonly decision: MvpDecisionView;
  readonly eligibility: MvpEligibility;
}

export interface MvpReviewInput {
  readonly request: MvpRequestView;
  readonly contract: MvpContractView;
  readonly candidate: MvpCandidateView;
  readonly policy?: MvpVerificationPolicy;
  readonly evidence: readonly MvpRecordedEvidence[];
  readonly decisions?: readonly MvpOwnerDecision[];
  readonly evaluatedAt: string;
}

interface CurrentCandidate {
  readonly contractId: string;
  readonly contractRevision: number;
  readonly candidateHeadSha: CommitSha;
}

/**
 * Orders verdicts newest first, so "the observation that counts" is the latest one
 * recorded rather than whichever entry a caller listed first. An observation with no time
 * sorts oldest, which is the honest place for it: a result nobody can date cannot displace
 * a dated one.
 */
function byNewest(left: MvpEvidenceVerdict, right: MvpEvidenceVerdict): number {
  const leftAt = left.evidence.observedAt ?? '';
  const rightAt = right.evidence.observedAt ?? '';
  if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
  return right.evidence.evidenceId.localeCompare(left.evidence.evidenceId);
}

/**
 * The projection every review surface reads.
 *
 * Pure, and total: given the same facts it returns the same model, and it never throws.
 * The two refusals are about inconsistent input rather than about a verdict — a
 * contract that is not approved cannot be reviewed, and a candidate bound to a
 * different contract than the one supplied cannot be projected against it (F24-AC4).
 */
export function buildMvpReviewReadModel(input: MvpReviewInput): Result<MvpReviewReadModel, DomainError> {
  const { request, contract, candidate, evidence } = input;
  const policy = input.policy ?? MvpDefaultVerificationPolicy;

  if (contract.status !== 'approved') {
    return err(
      invalid(`Contract ${contract.id} is ${contract.status}, so there is nothing to review against.`, [
        { path: 'contract.status', message: 'A candidate is only reviewable against an approved contract revision (F25-AC1).' },
      ]),
    );
  }
  if (candidate.contractId !== contract.id || candidate.contractRevision !== contract.revision) {
    return err({
      code: 'Conflict',
      reason: `Candidate ${candidate.headSha} is bound to contract ${candidate.contractId} revision ${candidate.contractRevision}, but contract ${contract.id} revision ${contract.revision} was supplied. Review the candidate against the contract it was built for (F24-AC4).`,
      expected: `${contract.id}@${contract.revision}`,
      actual: `${candidate.contractId}@${candidate.contractRevision}`,
    });
  }

  const current: CurrentCandidate = {
    contractId: contract.id,
    contractRevision: contract.revision,
    candidateHeadSha: candidate.headSha,
  };

  // Newest first, ordered by the time the observation happened and then by identity so a
  // same-instant pair is still deterministic. The projection sorts rather than trusting
  // the caller's array order, because "which observation counts" must be a property of the
  // recorded facts and not of how a repository happened to list them (F23-AC1).
  const verdicts = [...evidence]
    .map((record) => assessMvpEvidence(record, current))
    .sort(byNewest);

  const evidenceViews: MvpEvidenceView[] = verdicts.map((verdict) => ({
    evidenceId: verdict.evidence.evidenceId,
    source: verdict.evidence.source,
    criterionId: verdict.evidence.subject.kind === 'criterion' ? verdict.evidence.subject.criterionId : null,
    checkId: verdict.evidence.subject.kind === 'check' ? verdict.evidence.subject.checkId : null,
    method: verdict.evidence.method,
    outcome: verdict.evidence.outcome,
    currentOutcome: verdict.currentOutcome,
    appliesToCurrentCandidate: verdict.match.applies,
    staleReasons: verdict.match.staleReasons,
    reason: verdict.match.applies
      ? `Recorded against the current candidate at ${verdict.evidence.observedAt ?? 'an unknown time'}.`
      : verdict.match.reason,
    observedAt: verdict.evidence.observedAt,
    candidateHeadSha: verdict.evidence.observedHeadSha,
    contractRevision: verdict.evidence.observedContractRevision,
    detail: verdict.evidence.detail,
    artifactRef: verdict.evidence.artifactRef,
  }));

  const criteria = contract.acceptanceCriteria.map((criterion) => {
    // An automated criterion reads the check it names; an owner test reads the
    // observation recorded against the criterion itself. Neither falls back to "some
    // check that passed", so an unassigned criterion stays unverified.
    const related = verdicts.filter((verdict) => {
      if (criterion.verificationType === 'automated') {
        return (
          criterion.verificationCheckId !== null &&
          verdict.evidence.subject.kind === 'check' &&
          verdict.evidence.subject.checkId === criterion.verificationCheckId
        );
      }
      return verdict.evidence.subject.kind === 'criterion' && verdict.evidence.subject.criterionId === criterion.id;
    });
    // Newest applicable observation wins, so a re-run replaces rather than races. An
    // observation bound elsewhere is only consulted when nothing current exists, which is
    // what makes it read `stale` on the card instead of silently vanishing (F20-AC3).
    const chosen = related.find((verdict) => verdict.match.applies) ?? related[0] ?? null;
    const method = methodFor(criterion, chosen);
    const state = deriveCriterionState({
      verificationType: criterion.verificationType,
      method,
      observation: chosen === null ? null : {
        outcome: chosen.evidence.outcome,
        source: chosen.evidence.source,
        method: chosen.evidence.method,
        observedAt: chosen.evidence.observedAt,
        evidenceId: chosen.evidence.evidenceId,
      },
      binding: chosen === null ? null : chosen.match,
    });
    return {
      criterionId: criterion.id,
      description: criterion.description,
      verificationType: criterion.verificationType,
      state: state.state,
      method,
      evidenceId: chosen?.evidence.evidenceId ?? null,
      observedAt: chosen?.evidence.observedAt ?? null,
      reason: state.reason,
    } satisfies MvpCriterionResultView;
  });

  const checks = policyView(policy, verdicts);

  const governing = governingMvpDecision(input.decisions ?? [], current);
  const decision = decisionView(governing.decision, governing.staleDecisions);

  const staleness = staleView(verdicts, governing.staleDecisions);
  const eligibility = eligibilityView(policy, checks, criteria, decision, staleness);

  return ok({ request, contract, candidate, policy, checks, criteria, evidence: evidenceViews, staleness, decision, eligibility });
}

/**
 * The method a criterion's evidence was recorded under.
 *
 * The contract's own assignment is the answer whenever there is one; the recorded
 * method is only consulted when the contract is silent, so a caller cannot retag a
 * criterion's verification by writing evidence under a different method (F23-AC1).
 */
function methodFor(
  criterion: MvpContractCriterionView,
  chosen: MvpEvidenceVerdict | null,
): CriterionVerificationMethod {
  if (criterion.verificationType === 'owner_test') {
    return { kind: 'OwnerTest', instructions: criterion.description };
  }
  if (criterion.verificationCheckId !== null) {
    return { kind: 'AutomatedCheck', checkId: criterion.verificationCheckId };
  }
  if (chosen !== null && chosen.evidence.method.kind !== 'Untested') return chosen.evidence.method;
  return { kind: 'Untested', reason: `No verification method is assigned to "${criterion.id}", so nothing can verify it (F23-AC1).` };
}

function policyView(
  policy: MvpVerificationPolicy,
  verdicts: readonly MvpEvidenceVerdict[],
): MvpCheckView[] {
  const byCheck = new Map<string, MvpEvidenceVerdict[]>();
  for (const verdict of verdicts) {
    if (verdict.evidence.subject.kind !== 'check') continue;
    const bucket = byCheck.get(verdict.evidence.subject.checkId) ?? [];
    bucket.push(verdict);
    byCheck.set(verdict.evidence.subject.checkId, bucket);
  }

  const required = [...new Set([...policy.requiredAutomatedCheckIds, ...policy.deliveryRequiredCheckIds])];
  const ids = [...new Set([...required, ...byCheck.keys()])].sort();

  return ids.map((checkId) => {
    const bucket = byCheck.get(checkId) ?? [];
    const chosen = bucket.find((verdict) => verdict.match.applies) ?? bucket[0] ?? null;
    const isRequired = policy.requiredAutomatedCheckIds.includes(checkId) ||
      policy.deliveryRequiredCheckIds.includes(checkId);
    if (chosen === null) {
      return {
        checkId,
        required: isRequired,
        result: 'not_run' as const,
        blocking: isRequired,
        evidenceId: null,
        source: null,
        reason: 'No result is recorded for this check. A check that did not run is not a pass (F20-AC2).',
      };
    }
    return {
      checkId,
      required: isRequired,
      result: chosen.currentOutcome,
      blocking: isRequired && chosen.currentOutcome !== 'passed',
      evidenceId: chosen.evidence.evidenceId,
      source: chosen.evidence.source,
      reason: chosen.match.applies
        ? `Recorded ${chosen.evidence.outcome} against the current candidate.`
        : chosen.match.reason,
    } satisfies MvpCheckView;
  });
}

function decisionView(
  decision: MvpOwnerDecision | null,
  staleDecisions: readonly { decision: MvpOwnerDecision; reason: string }[],
): MvpDecisionView {
  return {
    outcome: decision === null ? 'none' : decision.kind,
    decision,
    staleDecisions: staleDecisions.map((entry) => ({
      decisionId: entry.decision.decisionId,
      kind: entry.decision.kind,
      candidateHeadSha: entry.decision.candidateHeadSha,
      contractRevision: entry.decision.contractRevision,
      reason: entry.reason,
    })),
    // Only an acceptance authorises anything, and only while it still describes the
    // candidate on screen (F27-AC3).
    authorizesCurrentCandidate: decision !== null && decision.kind === 'accepted',
  };
}

function staleView(
  verdicts: readonly MvpEvidenceVerdict[],
  staleDecisions: readonly { decision: MvpOwnerDecision; reason: string }[],
): MvpStaleView {
  const staleEvidence = verdicts.filter((verdict) => !verdict.match.applies);
  const reasons = [
    ...staleEvidence.map((verdict) => verdict.match.reason),
    ...staleDecisions.map((entry) => `Decision ${entry.decision.decisionId}: ${entry.reason}`),
  ];
  return {
    stale: staleEvidence.length > 0 || staleDecisions.length > 0,
    reasons: [...new Set(reasons)],
    staleEvidenceIds: staleEvidence.map((verdict) => verdict.evidence.evidenceId),
    staleDecisionIds: staleDecisions.map((entry) => entry.decision.decisionId),
  };
}

function eligibilityView(
  policy: MvpVerificationPolicy,
  checks: readonly MvpCheckView[],
  criteria: readonly MvpCriterionResultView[],
  decision: MvpDecisionView,
  staleness: MvpStaleView,
): MvpEligibility {
  const blockingReasons: string[] = [];
  const ownerActions: string[] = [];

  for (const check of checks) {
    if (!policy.requiredAutomatedCheckIds.includes(check.checkId)) continue;
    if (check.result !== 'passed') {
      blockingReasons.push(`Required check "${check.checkId}" is ${check.result}, not passed. ${check.reason}`);
    }
  }

  for (const criterion of criteria) {
    if (criterion.state === 'passed') continue;
    if (criterion.verificationType === 'owner_test' && criterion.state === 'pending') {
      // F24-AC3: an outstanding owner test is the owner's own action, not a failure
      // ShipLoop reports and not a fabricated automated success.
      ownerActions.push(`Run the owner test for "${criterion.criterionId}": ${criterion.reason}`);
      if (policy.ownerTestBlocksReview) {
        blockingReasons.push(`Owner test "${criterion.criterionId}" is outstanding (${criterion.reason})`);
      }
      continue;
    }
    blockingReasons.push(`Criterion "${criterion.criterionId}" is ${criterion.state}: ${criterion.reason}`);
  }

  const readyForOwnerReview = blockingReasons.length === 0;
  const deliveryReasons: string[] = [];
  for (const check of checks) {
    if (!policy.deliveryRequiredCheckIds.includes(check.checkId)) continue;
    if (check.result !== 'passed') {
      deliveryReasons.push(`Delivery check "${check.checkId}" is ${check.result}, not passed. ${check.reason}`);
    }
  }
  if (policy.ownerTestBlocksDelivery) {
    for (const criterion of criteria) {
      if (criterion.verificationType !== 'owner_test') continue;
      if (criterion.state !== 'passed') {
        deliveryReasons.push(`Owner test "${criterion.criterionId}" is ${criterion.state} (${criterion.reason})`);
      }
    }
  }
  for (const stale of decision.staleDecisions) {
    if (stale.kind !== 'accepted') continue;
    // An acceptance for a superseded candidate does not authorise this one. It is
    // reported by id and reason rather than dropped, so the owner can see that their
    // earlier acceptance exists and no longer applies (F25-AC3, F27-AC3).
    deliveryReasons.push(
      `Acceptance ${stale.decisionId} does not describe this candidate: ${stale.reason}`,
    );
  }
  // `verified is not accepted` and `accepted is not merged`: delivery needs an owner
  // decision that applies to this candidate, whatever else is true. A change request is
  // an explicit refusal, not an absence of permission, so it is named rather than
  // reported as "no decision yet" (F25-AC2).
  if (decision.outcome === 'none') {
    deliveryReasons.push('No owner decision applies to this candidate, so nothing authorises delivery (F25-AC1).');
  } else if (decision.outcome === 'changes_requested') {
    deliveryReasons.push('The owner requested changes on this candidate, so it has not been accepted (F25-AC2).');
  }
  if (staleness.stale) {
    deliveryReasons.push('Some evidence or decisions no longer describe this candidate and must be re-established (F20-AC3).');
  }

  return {
    readyForOwnerReview,
    readyForDelivery: readyForOwnerReview && deliveryReasons.length === 0,
    blockingReasons,
    ownerActions,
  };
}