import { err, invalid, ok } from '../result.ts';
import { redact } from '../redaction.ts';
import type { DomainError, Result } from '../result.ts';
import { isCommitSha } from '../ids.ts';
import type { CommitSha } from '../ids.ts';
import { requireMvpOwner } from './actor.ts';
import type { MvpActor } from './actor.ts';
import { bindingAppliesTo, isMvpInstant } from './evidence.ts';
import type { MvpBindingMatch, MvpEvidenceBinding } from './evidence.ts';

/**
 * Owner decisions for the minimal MVP (mvp-spec F25).
 *
 * Two decisions exist — `accepted` and `changes_requested` — and neither is reachable
 * from anywhere except this module. The three properties that matter are each structural:
 *
 *   - **Only an owner.** `MvpActor` is a discriminated union whose non-owner variants
 *     carry no owner identity, so an engine completion event or an agent summary has
 *     nothing to fill in (F25-AC4).
 *   - **A decision binds one exact candidate.** Every decision carries the contract
 *     revision and the full commit SHA it was made against. An acceptance is a claim
 *     about SHA A, and it cannot be read as a claim about SHA B because
 *     `decisionAppliesTo` compares both (F25-AC3, F27-AC3).
 *   - **The timestamp is an input, not ambient time.** The caller supplies `decidedAt`,
 *     so a recorded decision replays identically and cannot be backdated by a test or a
 *     misconfigured host clock (F25-AC1).
 *
 * Acceptance is *not* modelled as a boolean anywhere in this module. It is a decision
 * row with a candidate binding, which is what makes "the SHA changed, so the acceptance
 * stopped applying" a comparison rather than a convention.
 */

export type MvpDecisionKind = 'accepted' | 'changes_requested';

export interface MvpOwnerDecision {
  readonly decisionId: string;
  readonly kind: MvpDecisionKind;
  readonly projectId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly candidateId: string;
  /** Full 40/64 character commit SHA. Never an abbreviation or a PR number. */
  readonly candidateHeadSha: CommitSha;
  readonly ownerId: string;
  readonly decidedAt: string;
  /** Retained against this exact candidate so a fix pass can read it (F25-AC2). */
  readonly feedback: string | null;
}

export interface RecordMvpDecisionInput {
  readonly decisionId: string;
  readonly kind: MvpDecisionKind;
  readonly actor: MvpActor;
  readonly projectId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly candidateId: string;
  readonly candidateHeadSha: string;
  readonly decidedAt: string;
  readonly feedback: string | null;
}

/**
 * Records one owner decision against one exact candidate.
 *
 * The validation order is the enforcement order: the actor is checked before anything
 * is inspected, so a non-owner learns nothing about the candidate from the refusal. The
 * full-SHA requirement is checked before the decision exists, so a decision can never be
 * stored against a branch name.
 */
export function recordMvpOwnerDecision(input: RecordMvpDecisionInput): Result<MvpOwnerDecision, DomainError> {
  const owner = requireMvpOwner(input.actor, input.kind === 'accepted' ? 'Accepting a candidate' : 'Requesting changes');
  if (!owner.ok) return err(owner.error);

  const fields: { path: string; message: string }[] = [];
  if (input.decisionId.trim() === '') fields.push({ path: 'decisionId', message: 'A decision needs an identity.' });
  if (input.projectId.trim() === '') fields.push({ path: 'projectId', message: 'A decision names the project it belongs to.' });
  if (input.requestId.trim() === '') fields.push({ path: 'requestId', message: 'A decision names the request it belongs to.' });
  if (input.contractId.trim() === '') fields.push({ path: 'contractId', message: 'A decision names the contract revision it accepts.' });
  if (input.candidateId.trim() === '') fields.push({ path: 'candidateId', message: 'A decision names the candidate it accepts.' });
  if (!isCommitSha(input.candidateHeadSha)) {
    fields.push({
      path: 'candidateHeadSha',
      message: 'A decision binds the full 40-character commit SHA. A branch name, an abbreviation or a PR number cannot identify what was accepted (F25-AC1, F27-AC3).',
    });
  }
  if (!Number.isInteger(input.contractRevision) || input.contractRevision < 1) {
    fields.push({ path: 'contractRevision', message: 'A decision binds a positive contract revision (F25-AC1).' });
  }
  if (!isMvpInstant(input.decidedAt)) {
    fields.push({ path: 'decidedAt', message: 'A decision needs the instant it was made, as an ISO-8601 value (F25-AC1).' });
  }
  if (input.feedback !== null && input.feedback.trim() === '') {
    fields.push({
      path: 'feedback',
      message: 'Feedback is optional, but an empty string is not feedback. Send null instead (F25-AC2).',
    });
  }

  if (fields.length > 0) {
    return err(invalid('This owner decision cannot be recorded.', fields));
  }

  return ok({
    decisionId: input.decisionId,
    kind: input.kind,
    projectId: input.projectId,
    requestId: input.requestId,
    contractId: input.contractId,
    contractRevision: input.contractRevision,
    candidateId: input.candidateId,
    candidateHeadSha: input.candidateHeadSha as CommitSha,
    ownerId: owner.value.ownerId,
    decidedAt: input.decidedAt,
    feedback: input.feedback === null ? null : redact(input.feedback).text,
  });
}

/**
 * Whether a decision still describes the candidate under review.
 *
 * Reuses the evidence binding comparison deliberately. Acceptance and a passing check
 * are the same kind of claim — "this exact build is good" — so they go stale under the
 * same rule, and there is one place in the codebase that decides what "the same build"
 * means rather than two that can drift (F25-AC3, F20-AC3).
 */
export function decisionAppliesTo(
  decision: MvpOwnerDecision,
  current: { readonly contractId: string; readonly contractRevision: number; readonly candidateHeadSha: CommitSha },
): MvpBindingMatch {
  const binding: MvpEvidenceBinding = {
    contractId: decision.contractId,
    contractRevision: decision.contractRevision,
    candidateId: decision.candidateId,
    candidateHeadSha: decision.candidateHeadSha,
    subject: { kind: 'check', checkId: `decision:${decision.decisionId}` },
    method: { kind: 'Untested', reason: 'An owner decision is not a check result.' },
    observedAt: decision.decidedAt,
  };
  return bindingAppliesTo(binding, current);
}

/**
 * Picks the decision that governs the current candidate.
 *
 * Returns the newest applicable decision and separately reports the ones that stopped
 * applying. An acceptance that has gone stale is never silently dropped: it comes back
 * in `staleDecisions` with the reason, because "your acceptance quietly vanished" is
 * exactly the state that tempts an owner to click Accept again without looking (F25-AC3).
 *
 * A change request that still applies outranks an older acceptance, which is the
 * ordering the lifecycle uses: a fix pass after a rejection has to be re-accepted.
 */
export function governingMvpDecision(
  decisions: readonly MvpOwnerDecision[],
  current: { readonly contractId: string; readonly contractRevision: number; readonly candidateHeadSha: CommitSha },
): {
  readonly decision: MvpOwnerDecision | null;
  readonly staleDecisions: readonly { readonly decision: MvpOwnerDecision; readonly reason: string }[];
} {
  const applicable: MvpOwnerDecision[] = [];
  const staleDecisions: { decision: MvpOwnerDecision; reason: string }[] = [];

  for (const decision of decisions) {
    const match = decisionAppliesTo(decision, current);
    if (match.applies) applicable.push(decision);
    else staleDecisions.push({ decision, reason: match.reason });
  }

  applicable.sort((left, right) => left.decidedAt.localeCompare(right.decidedAt));
  const newest = applicable.at(-1) ?? null;
  const changeRequest =
    newest === null ? null : applicable.filter((decision) => decision.decidedAt === newest.decidedAt).at(-1) ?? null;

  return { decision: changeRequest ?? newest, staleDecisions };
}