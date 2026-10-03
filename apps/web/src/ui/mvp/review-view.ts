/**
 * How the Review surface turns server facts into words, tones and enabled controls.
 *
 * Two rules from the product invariants govern this file:
 *
 *   - `verified` is NOT `accepted`, and `agent completed` is NOT `verified`. So nothing here
 *     derives a decision. The only thing that decides whether Accept is available is the server's
 *     own `verification.complete`, and a green set of checks never sets it.
 *   - A disabled control is not an explanation. Every refusal here produces a sentence, so an owner
 *     who cannot press Accept is told what is outstanding instead of being left to guess.
 *
 * Tones are words rather than colours: a failing check, an unrun check and a stale one must be
 * distinguishable without reading colour, so the server's own result word is rendered as the label
 * and the tone only reinforces it.
 */

// A type-only import, so this module stays runnable under `node --test` with no JSX pipeline.
// The tones are the component's union; the pure mapping below cannot invent a seventh one.
import type { StatusTone } from '../components/StatusBadge.tsx';
import type { ReviewCheck, ReviewCriterion, ReviewDetail, ReviewQueueItem } from './wire.ts';

type StatusToneName = StatusTone;

/**
 * The tone each recorded result reads as.
 *
 * `Missing` and `Stale` are deliberately not `Failed`. "Nothing ran" and "a run was recorded
 * against a commit that has since moved" are different facts about a candidate, and an owner
 * deciding whether to trust a candidate needs to tell them apart.
 */
const CHECK_TONES: Readonly<Record<string, StatusToneName>> = {
  Passed: 'healthy',
  Passed_with_skips: 'degraded',
  Failed: 'revoked',
  Missing: 'degraded',
  Stale: 'degraded',
  Waiting: 'pending',
  NotApplicable: 'unconfigured',
};

export function checkTone(result: string): StatusToneName {
  return CHECK_TONES[result] ?? 'neutral';
}

/** The tone each criterion's recorded status reads as. */
const CRITERION_TONES: Readonly<Record<string, StatusToneName>> = {
  Met: 'healthy',
  Verified: 'healthy',
  Unmet: 'revoked',
  Failed: 'revoked',
  Pending: 'pending',
  Outstanding: 'pending',
  WaitingForOwner: 'pending',
  Stale: 'degraded',
};

export function criterionTone(status: string): StatusToneName {
  return CRITERION_TONES[status] ?? 'neutral';
}

/** The tone each owner decision reads as. Acceptance is the only `healthy` one here. */
const DECISION_TONES: Readonly<Record<string, StatusToneName>> = {
  accepted: 'healthy',
  changes_requested: 'degraded',
};

export function decisionTone(kind: string | null): StatusToneName {
  return kind === null ? 'neutral' : (DECISION_TONES[kind] ?? 'neutral');
}

/**
 * What one check line says beyond its name and result.
 *
 * The origin and the timing are included when the server reported them and omitted when it did
 * not: "the provider reported this check passing for this commit" and "the check passed" are
 * different claims, and inventing the missing half of one would be a detail the owner trusts
 * without checking.
 */
export function checkDetail(check: ReviewCheck): string {
  const parts = [check.required ? 'Required by the project settings.' : 'Not required by the project settings.'];
  if (check.observedAt !== null) parts.push(`Observed at ${check.observedAt}.`);
  else parts.push('No observation has been recorded for this check.');
  if (check.detail !== null && check.detail !== '') parts.push(check.detail);
  return parts.join(' ');
}

/** What one criterion has recorded, including which exact commit its evidence describes. */
export function criterionDetail(criterion: ReviewCriterion): string {
  if (criterion.evidence === null) {
    return criterion.pendingOwnerTest
      ? 'Waiting on your own test. ShipLoop does not decide this one, and nothing counts it until you record what you saw.'
      : 'No evidence has been recorded for this criterion against this commit yet.';
  }
  const evidence = criterion.evidence;
  return (
    `Recorded by ${evidence.method}: ${evidence.result}, at ${evidence.observedAt}, ` +
    `against contract revision ${String(evidence.contractRevision)} and commit ${evidence.candidateHeadSha}.`
  );
}

/** Whether evidence describes the candidate actually on screen. */
export function evidenceMatchesCandidate(criterion: ReviewCriterion, headSha: string): boolean {
  return criterion.evidence !== null && criterion.evidence.candidateHeadSha.trim().toLowerCase() === headSha.trim().toLowerCase();
}

/**
 * Whether Accept may be pressed, and if not, why.
 *
 * Three separate refusals, because they are three different situations an owner must be able to
 * tell apart:
 *
 *   - a decision is already recorded — pressing Accept again would either do nothing or overwrite
 *     a decision, and the first of those reads as a broken button;
 *   - the candidate is stale — the recorded verification no longer describes this commit;
 *   - verification is incomplete — including the case where the server reported none at all.
 */
export interface DecisionAvailability {
  readonly canAccept: boolean;
  readonly canRequestChanges: boolean;
  readonly acceptRefusals: readonly string[];
}

/** The refusals shown above the Accept control, in the order the owner should read them. */
export function acceptRefusals(detail: ReviewDetail): readonly string[] {
  const refusals: string[] = [];
  if (detail.decision !== null) {
    refusals.push(
      detail.decision.kind === 'accepted'
        ? 'This candidate is already accepted. A different commit needs its own decision.'
        : 'Changes were already requested on this candidate. Link the pull request that addresses them.',
    );
  }
  if (detail.staleReasons.length > 0) {
    refusals.push(
      `This review is stale: ${detail.staleReasons.join(', ')}. Verify the commit that is actually proposed before deciding.`,
    );
  }
  if (detail.verification === null) {
    refusals.push('No verification has been recorded for this candidate, so there is nothing to accept on the evidence.');
  } else if (!detail.verification.complete) {
    refusals.push(
      detail.verification.outstanding.length === 0
        ? 'Verification of this candidate has not finished.'
        : `Verification has not finished: ${detail.verification.outstanding.join(', ')}.`,
    );
  }
  return refusals;
}

export function decisionAvailability(detail: ReviewDetail): DecisionAvailability {
  const refusals = acceptRefusals(detail);
  return {
    // Changes are always available. A owner may reject work for any reason at all, including ones
    // no check covers, and a product that only allows a decision when it agrees is not a review.
    canRequestChanges: true,
    canAccept: refusals.length === 0,
    acceptRefusals: refusals,
  };
}

/** The one-line status of the review as a whole, for the heading above the detail. */
export function reviewHeadline(detail: ReviewDetail): string {
  if (detail.decision !== null && detail.decision.kind === 'accepted') return 'Accepted';
  if (detail.decision !== null) return 'Changes requested';
  if (detail.staleReasons.length > 0) return 'Stale — this review no longer describes the commit below';
  if (detail.verification !== null && detail.verification.complete) return 'Verification recorded — your decision is outstanding';
  return 'Verification is not finished';
}

/** Counts rendered beside the checks and criteria headings. */
export interface ReviewCounts {
  readonly checksFailing: number;
  readonly criteriaVerified: number;
  readonly criteriaTotal: number;
  readonly pendingOwnerTests: number;
}

export function reviewCounts(detail: ReviewDetail): ReviewCounts {
  return {
    checksFailing: detail.checks.filter((check) => check.result === 'Failed').length,
    criteriaVerified: detail.criteria.filter((criterion) => criterion.evidence !== null).length,
    criteriaTotal: detail.criteria.length,
    pendingOwnerTests: detail.pendingOwnerTestCriterionIds.length,
  };
}

/** What one sentence of the queue row says, so a list is readable without opening each item. */
export function queueItemSummary(item: ReviewQueueItem): string {
  const parts: string[] = [`contract revision ${String(item.contractRevision)}`, `commit ${item.headSha}`];
  if (item.verification !== null) {
    parts.push(item.verification.complete ? 'verification recorded' : 'verification not finished');
  } else {
    parts.push('no verification recorded');
  }
  if (item.decision !== null) parts.push(item.decision.kind === 'accepted' ? 'accepted' : 'changes requested');
  if (item.staleReasons.length > 0) parts.push('stale');
  return parts.join(' · ');
}