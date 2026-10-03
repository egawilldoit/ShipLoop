/**
 * One acceptance criterion on the review card: what it says, how it is to be verified, and
 * what has been recorded against it (F23-AC1, F23-AC3, F23-AC4, F24-AC1, F24-AC3, N03-AC1).
 *
 * Four facts are kept visibly apart, because collapsing any two of them is how a card starts
 * claiming more than was observed:
 *
 *   - **The method, from the scope decision.** A criterion's verification method is a scope
 *     decision, not evidence: it says how the criterion will be checked and verifies nothing
 *     by existing (F23-AC1).
 *   - **The status, from the journal.** Only a recorded observation produces `Verified`, and
 *     the row shows the evidence identity and the instant when there is one, so a reader can
 *     tell a verdict from an absence (F23-AC1, F23-AC3).
 *   - **The check, named by the journal rather than guessed here.** `verificationCheckId` is
 *     the profile-visible name of the check the verdict is bound to, read from the durable row
 *     through the check it names. It is the same value the checks above carry in `checkId`, so
 *     a criterion can be held against them: a check on this card that a criterion does not name
 *     verified nothing, however green it is (F23-AC1).
 *   - **The absence of that name, stated rather than left blank.** An automated criterion with
 *     no named check cannot claim any verification, and the row says so in words. A null is not
 *     an omission to be rendered as tidiness: it is the one thing the row must not paper over,
 *     because a blank line next to a green check list reads as "covered" (F23-AC1, F24-AC3).
 *
 * A check that is named but did not verify the criterion is stated as such. The binding says
 * the verdict was filed against that check's run; it does not say the check passed, and a
 * criterion bound to a failing check reads `Failed`, not `Passed` (F23-AC1).
 *
 * `Untested` is rendered as its own state rather than as a pending one, because it means no
 * verification method has been assigned at all — a scope gap, not work in progress (F23-AC1).
 */

import type { ReactElement } from 'react';
import { formatTimestamp, type ReviewCardCriterion } from '../api-client.ts';
import { StatusBadge, type StatusTone } from './StatusBadge.tsx';

/**
 * How each criterion status reads, with `PendingOwnerTest` deliberately distinct from
 * `Untested`: one is the owner's step outstanding, the other is no assigned method at all
 * (F23-AC1, N03-AC1).
 */
const CRITERION_TONES: Readonly<Record<string, StatusTone>> = {
  Verified: 'healthy',
  PendingOwnerTest: 'pending',
  Missing: 'degraded',
  Untested: 'unconfigured',
  Failed: 'revoked',
  Stale: 'degraded',
};

/** The vocabulary the domain defines, so an unexpected word is neutral rather than flattering. */
const METHOD_KINDS: readonly string[] = [
  'AutomatedCheck',
  'OwnerTest',
  'BrowserEvidence',
  'ApiEvidence',
  'Untested',
];

/**
 * Why a method is what it is, and what that says about attribution.
 *
 * The automated branch names the bound check when there is one and never fills the gap with a
 * check that merely passed. Both the named and the unnamed case end on the same claim, which is
 * the one F23-AC1 rests on: no check is being offered as this criterion's verification unless
 * the journal says that check produced its verdict (F23-AC1).
 */
function methodLine(criterion: ReviewCardCriterion): string {
  const kind = METHOD_KINDS.includes(criterion.methodKind) ? criterion.methodKind : 'Untested';
  switch (kind) {
    case 'AutomatedCheck':
      return criterion.verificationCheckId === null
        ? `Verification method: ${kind}. No check is named against this criterion's verdict, so no check on this ` +
            `card is being offered as its verification — a passing required check is not evidence for a criterion it ` +
            `was never linked to (F23-AC1).`
        : `Verification method: ${kind}, bound to check "${criterion.verificationCheckId}". That is the check this ` +
            `criterion's verdict was filed against; no other check on this card is being offered as its verification ` +
            `(F23-AC1).`;
    case 'OwnerTest':
      return (
        `Verification method: ${kind}. Only an observation you record yourself can satisfy this criterion; ` +
        `no check result and no deployment can (F23-AC1).`
      );
    case 'BrowserEvidence':
    case 'ApiEvidence':
      return `Verification method: ${kind}. The observation is a captured record rather than a check run.`;
    default:
      return (
        `Verification method: ${criterion.methodKind}. No verification method is assigned, so nothing can ` +
        `verify this criterion yet (F23-AC1).`
      );
  }
}

/** What the journal has recorded, stated as an identity and an instant or as an absence (F23-AC3). */
function evidenceLine(criterion: ReviewCardCriterion): string {
  if (criterion.evidenceId === null) {
    return 'No evidence record has been written against this criterion for this candidate (F23-AC1).';
  }
  const observedAt =
    criterion.observedAt === null
      ? 'with no recorded observation time, so it cannot be read as a fresh verdict'
      : `observed at ${formatTimestamp(criterion.observedAt)}`;
  return `Evidence ${criterion.evidenceId}, ${observedAt}.`;
}

/**
 * What verified this criterion, in the journal's own words.
 *
 * The controller's `verificationDetail` already names the check or the recorded step, or says
 * why no check can be named; the row falls back to stating the absence itself rather than
 * rendering nothing, because a criterion row with no line about verification is exactly the row
 * that lets a reader assume the checks above covered it (F23-AC1, F24-AC3).
 */
function verificationLine(criterion: ReviewCardCriterion): string {
  if (criterion.verificationDetail !== null) return criterion.verificationDetail;
  return 'Nothing has verified this criterion yet, and this row names no check that could (F23-AC1).';
}

export interface CriterionRowProps {
  readonly criterion: ReviewCardCriterion;
}

/**
 * One criterion line on the card.
 *
 * `data-testid="card-criterion"` is the one element per criterion the existing run spec counts,
 * so the whole criterion is inside it: the identity, the status word, the method, the evidence
 * and the verification identity. `data-criterion-id` is there because a criterion's own row
 * mentions other criterion ids — in its evidence and method text — so a reader or a test
 * addressing a criterion by substring would resolve more than one row and get whichever the DOM
 * answered first (N03-AC1, F24-AC3).
 */
export function CriterionRow({ criterion }: CriterionRowProps): ReactElement {
  return (
    <li
      className="capability-list__item"
      data-testid="card-criterion"
      data-criterion-id={criterion.criterionId}
      data-verification-check={criterion.verificationCheckId ?? ''}
    >
      <span className="profile-list__name">{criterion.criterionId}</span>
      <span className="profile-list__detail">{criterion.text}</span>{' '}
      <StatusBadge
        tone={CRITERION_TONES[criterion.status] ?? 'neutral'}
        label={`Criterion ${criterion.criterionId}: ${criterion.status}`}
        detail="The status is the journal's own verdict for this candidate. Acceptance is refused while any criterion is outstanding (F24-AC3)."
      />
      <p className="connector__problem-line" data-testid="criterion-method">
        {methodLine(criterion)}
      </p>
      <p className="connector__problem-line" data-testid="criterion-verification">
        {verificationLine(criterion)}
      </p>
      <p className="connector__problem-line" data-testid="criterion-evidence">
        {evidenceLine(criterion)}
      </p>
      {criterion.detail === null ? null : (
        <p className="connector__problem-line">{criterion.detail}</p>
      )}
    </li>
  );
}