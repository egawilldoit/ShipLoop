/**
 * Every acceptance criterion, its state, and — for an owner test — the owner's own controls.
 *
 * One list, not two. The contract's criteria are one set of agreements, and splitting the owner
 * tests into their own panel would let a reader see a complete criteria list while the owner's
 * outstanding steps sat somewhere else on the page (F23-AC1).
 *
 * Two facts stay visibly separate for each criterion, because collapsing them is how a card starts
 * claiming more than was observed:
 *
 *   - **How it is verified** — a scope decision, from the contract. An automated criterion is bound
 *     to a check *by name*, and a criterion with no binding says so rather than borrowing a green
 *     check that happened to pass (F23-AC1).
 *   - **What stands behind it** — the server's own state and reason, quoted. A pending owner test
 *     reads as the owner's outstanding step and as nothing else (F23-AC1, N03-AC1).
 */

import { useState, type ReactElement } from 'react';
import type { MvpReviewCardView, ReviewOwnerTestView } from '../../server/contracts.ts';
import { formatTimestamp } from '../api-client.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';
import type { MvpFailure } from './mvp-client.ts';
import { readCriterion } from './review-model.ts';
import { OwnerTestControls } from './OwnerTestControls.tsx';

export interface CriteriaPanelProps {
  readonly card: MvpReviewCardView;
  readonly projectId: string;
  readonly candidateId: string;
  /**
   * Records one owner test and returns the refusal, if the server refused.
   *
   * The caller re-reads the card rather than patching it, so this returns a failure for the
   * control to render beside itself and resolves with null once the card is current again
   * (F24-AC2).
   */
  readonly onRecord: (
    test: ReviewOwnerTestView,
    result: 'passed' | 'failed',
    note: string | null,
  ) => Promise<MvpFailure | null>;
}

export function CriteriaPanel({
  card,
  projectId,
  candidateId,
  onRecord,
}: CriteriaPanelProps): ReactElement {
  const [busyCriterionId, setBusyCriterionId] = useState<string | null>(null);
  // Keyed rather than filtered out: an owner test is a criterion, and dropping the ones the owner
  // has to act on from the criteria list would show a complete-looking list that is not complete.
  const ownerTests = new Map<string, ReviewOwnerTestView>(card.ownerTests.map((test) => [test.criterionId, test]));

  return (
    <section className="panel" aria-labelledby="review-criteria-heading">
      <h3 className="panel__title" id="review-criteria-heading">
        Acceptance criteria
      </h3>
      {card.criteria.length === 0 ? (
        <p className="panel__note">This contract revision declares no acceptance criteria.</p>
      ) : (
        <ul className="capability-list">
          {card.criteria.map((criterion) => {
            const reading = readCriterion(criterion);
            const ownerTest = ownerTests.get(criterion.criterionId) ?? null;
            return (
              <li className="capability-list__item" key={criterion.criterionId} data-state={criterion.state}>
                <p>
                  <strong>{criterion.criterionId}</strong> — {criterion.description}{' '}
                  <StatusBadge tone={reading.tone} label={reading.label} />
                </p>
                <p className="panel__note">
                  {verificationSentence(criterion.verificationType, criterion.verificationCheckId)} {reading.standing}
                </p>
                {criterion.observedAt === null ? null : (
                  <p className="panel__note">
                    {`Observed ${formatTimestamp(criterion.observedAt)}${
                      criterion.evidenceId === null ? '' : ` on evidence ${criterion.evidenceId}`
                    }.`}
                  </p>
                )}
                {ownerTest === null || projectId === '' || candidateId === '' ? null : (
                  <OwnerTestControls
                    test={ownerTest}
                    busy={busyCriterionId === ownerTest.criterionId}
                    onRecord={async (result, note) => {
                      setBusyCriterionId(ownerTest.criterionId);
                      const failure = await onRecord(ownerTest, result, note);
                      setBusyCriterionId(null);
                      return failure;
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * How this criterion is to be verified, in words, with the absence stated.
 *
 * An automated criterion with no bound check gets no substitute. The sentence says nothing can
 * verify it, because a criterion bound to no check reads `unverified` for the life of the product
 * and an acceptance of a contract containing one is refused with nothing the owner can act on
 * (F23-AC1, mvp-review.md).
 */
function verificationSentence(
  verificationType: 'automated' | 'owner_test',
  verificationCheckId: string | null,
): string {
  if (verificationType === 'owner_test') {
    return 'Verified by you. No automated check, provider result or agent output can satisfy it.';
  }
  if (verificationCheckId === null) {
    return 'The contract bound no check to this criterion, so nothing can verify it.';
  }
  return `Verified by the check named ${verificationCheckId}.`;
}
