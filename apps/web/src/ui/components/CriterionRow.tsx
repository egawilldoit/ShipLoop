/**
 * One acceptance criterion on the review card: what it says, how it is to be verified, and
 * what has been recorded against it (F23-AC1, F23-AC3, F23-AC4, F24-AC1, F24-AC3, N03-AC1).
 *
 * Three facts are kept visibly apart, because collapsing any two of them is how a card starts
 * claiming more than was observed:
 *
 *   - **The method, from the scope decision.** A criterion's verification method is a scope
 *     decision, not evidence: it says how the criterion will be checked and verifies nothing
 *     by existing (F23-AC1).
 *   - **The status, from the journal.** Only a recorded observation produces `Verified`, and
 *     the row shows the evidence identity and the instant when there is one, so a reader can
 *     tell a verdict from an absence (F23-AC1, F23-AC3).
 *   - **Which check, if any, this row may attribute.** A `Verified` automated criterion is
 *     the only case where a check could be named, and this card's transport does not report
 *     which recorded check produced a criterion's observation: `ReviewCardCriterion` carries
 *     the method *kind* and nothing else. So for an automated criterion the row states that
 *     no check is named here and that **no check result on this card is being offered as the
 *     verification of this criterion** (F23-AC1). That is the whole point of the line: a green
 *     required check must not read as having satisfied a criterion it was never linked to, and
 *     guessing a check by name would be worse than saying the link is absent, because a
 *     plausible wrong name is indistinguishable from a right one to the reader.
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

/** The reason an observation is or is not attributable to a named check (F23-AC1). */
function methodLine(criterion: ReviewCardCriterion): string {
  const kind = METHOD_KINDS.includes(criterion.methodKind) ? criterion.methodKind : 'Untested';
  switch (kind) {
    case 'AutomatedCheck':
      return (
        `Verification method: ${kind}. This card's transport does not report which recorded check produced this ` +
        `criterion's observation, so no check on this card is being offered as its verification — a passing ` +
        `required check is not evidence for a criterion it was never linked to (F23-AC1).`
      );
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

export interface CriterionRowProps {
  readonly criterion: ReviewCardCriterion;
}

/**
 * One criterion line on the card.
 *
 * `data-testid="card-criterion"` is the one element per criterion the existing run spec counts,
 * so the whole criterion is inside it: the identity, the status word, the method and the
 * evidence. `data-criterion-id` is there because a criterion's own row mentions other criterion
 * ids — in its evidence and method text — so a reader or a test addressing a criterion by
 * substring would resolve more than one row and get whichever the DOM answered first
 * (N03-AC1, F24-AC3).
 */
export function CriterionRow({ criterion }: CriterionRowProps): ReactElement {
  return (
    <li
      className="capability-list__item"
      data-testid="card-criterion"
      data-criterion-id={criterion.criterionId}
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
      <p className="connector__problem-line" data-testid="criterion-evidence">
        {evidenceLine(criterion)}
      </p>
      {criterion.detail === null ? null : (
        <p className="connector__problem-line">{criterion.detail}</p>
      )}
    </li>
  );
}