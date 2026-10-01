import type { Fingerprint } from './ids.ts';

/**
 * Check and evidence results (F20-AC2, F23).
 *
 * The distinction that carries the product's honesty guarantee is between
 * Missing/Waiting/Stale and Passed. A required check that never ran is not a pass,
 * and agent text cannot promote any state to Passed: only a recorded observation
 * from an executed check or a live provider read may do that (F20-AC2, F23-AC1).
 */

export const CHECK_RESULTS = [
  'Passed',
  'Failed',
  'Missing',
  'Waiting',
  'Stale',
  'NotApplicable',
] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

export type CheckOrigin =
  | 'LocalCheck'
  | 'ProviderCi'
  | 'BrowserEvidence'
  | 'ApiEvidence'
  | 'LiveSmoke';

/** A skipped or never-configured required check is Missing, never Passed. */
export function isTerminalSuccess(result: CheckResult): boolean {
  return result === 'Passed';
}

/**
 * Whether a result blocks readiness for delivery.
 *
 * Every result other than `Passed` blocks, with one exception: `NotApplicable`
 * stops blocking once a policy decision approved it. The approval is a separate
 * argument rather than a property of the result string, because only a policy
 * decision can grant it and a bare result cannot prove that (F20-AC5).
 *
 * `Waiting` is deliberately blocking. A required check that is still running has
 * produced no observation, and reporting it as ready would let unreviewed work
 * reach the delivery gate on the strength of a check that has not finished
 * (F20-AC2). This is the exact inverse of `isSatisfied`, so the two cannot drift
 * apart and disagree about the same record.
 */
export function isBlocking(result: CheckResult, approvedByPolicy = false): boolean {
  if (result === 'Passed') return false;
  if (result === 'NotApplicable') return !approvedByPolicy;
  return true;
}

/** Whether a recorded check counts as satisfied for delivery purposes. */
export function isSatisfied(check: Pick<CheckRecord, 'result' | 'notApplicableApprovedByPolicy'>): boolean {
  return check.result === 'Passed' ||
    (check.result === 'NotApplicable' && check.notApplicableApprovedByPolicy);
}

export interface CheckRecord {
  readonly checkId: string;
  readonly name: string;
  readonly origin: CheckOrigin;
  readonly required: boolean;
  readonly result: CheckResult;
  /** Candidate fingerprint this result belongs to. */
  readonly candidateFingerprint: Fingerprint;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  /** Sanitized artifact reference. Raw output may contain credentials. */
  readonly artifactRef: string | null;
  /** Human-readable detail that never contains secret values. */
  readonly detail: string | null;
  /**
   * Set when NotApplicable was chosen deliberately under profile policy. A model
   * cannot set this; only a policy decision can (F20-AC5).
   */
  readonly notApplicableApprovedByPolicy: boolean;
}

/**
 * Records a provider-reported check failure as base-failure or change-introduced.
 *
 * F20-AC4: an existing failure on the base branch must be visible as such, but it
 * does not automatically waive the check for the new candidate.
 */
export type FailureAttribution = 'IntroducedByChange' | 'PresentOnBase' | 'Indeterminate';

export interface FailureClassification {
  readonly attribution: FailureAttribution;
  readonly evidence: string;
}

export function classifyCheckFailure(input: {
  readonly failedOnCandidate: boolean;
  readonly failedOnBaseSha: boolean | null;
  readonly baseShaObserved: boolean;
}): FailureClassification {
  if (!input.failedOnCandidate) {
    return { attribution: 'Indeterminate', evidence: 'Candidate did not report this check as failed.' };
  }
  if (!input.baseShaObserved) {
    return {
      attribution: 'Indeterminate',
      evidence: 'The base commit was not observed, so the failure cannot be attributed.',
    };
  }
  return input.failedOnBaseSha
    ? { attribution: 'PresentOnBase', evidence: 'The same check also failed on the observed base commit.' }
    : { attribution: 'IntroducedByChange', evidence: 'The check passed on the observed base commit and failed on this candidate.' };
}

export type CriterionVerificationMethod =
  | { readonly kind: 'AutomatedCheck'; readonly checkId: string }
  | { readonly kind: 'OwnerTest'; readonly instructions: string }
  | { readonly kind: 'BrowserEvidence'; readonly evidenceId: string }
  | { readonly kind: 'ApiEvidence'; readonly evidenceId: string }
  | { readonly kind: 'Untested'; readonly reason: string };

export type CriterionStatus =
  | 'Verified'
  | 'PendingOwnerTest'
  | 'Failed'
  | 'Missing'
  | 'Untested'
  | 'Stale';

export interface CriterionEvidence {
  readonly criterionId: string;
  readonly method: CriterionVerificationMethod;
  readonly status: CriterionStatus;
  /** Evidence id that produced a Verified result, when applicable. */
  readonly evidenceId: string | null;
  readonly candidateFingerprint: Fingerprint;
  readonly scopeFingerprint: Fingerprint;
  readonly observedAt: string | null;
}

/** Whether every criterion required before acceptance is satisfied. */
export function acceptanceReady(criteria: readonly CriterionEvidence[]): boolean {
  return criteria.every((criterion) =>
    criterion.method.kind === 'OwnerTest'
      ? criterion.status === 'Verified'
      : criterion.status === 'Verified' || criterion.status === 'PendingOwnerTest',
  );
}

/**
 * Whether the review card may offer delivery actions (F24-AC2, F26-AC2).
 *
 * Required checks must be terminal successes and acceptance must be current, but
 * owner-test criteria may still be pending at this gate because acceptance itself
 * is what records the owner test outcome.
 */
export function deliveryEligible(input: {
  readonly checks: readonly CheckRecord[];
  readonly acceptance: 'Accepted';
  readonly acceptanceCandidateFingerprint: Fingerprint;
  readonly currentCandidateFingerprint: Fingerprint;
}): { readonly eligible: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  for (const check of input.checks) {
    if (!check.required) continue;
    if (check.candidateFingerprint !== input.currentCandidateFingerprint) {
      reasons.push(`Required check "${check.name}" belongs to a different candidate.`);
    } else if (!isSatisfied(check)) {
      reasons.push(
        check.result === 'NotApplicable'
          ? `Required check "${check.name}" is NotApplicable without a policy approval.`
          : `Required check "${check.name}" is ${check.result}, not Passed.`,
      );
    }
  }
  if (input.acceptanceCandidateFingerprint !== input.currentCandidateFingerprint) {
    reasons.push('Acceptance was recorded for a different candidate.');
  }
  return { eligible: reasons.length === 0, reasons };
}
