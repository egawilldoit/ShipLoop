/**
 * One recorded observation, rendered as what it means for the candidate on screen.
 *
 * The standing is computed by `observation-standing.ts` and the argument for how it is computed lives
 * there; this file is the presentation of it. It is split out because the standing is the product's
 * claim about what a check established, and a claim like that has to be checkable by `node --test`
 * without a browser in the way.
 *
 * Three facts are rendered in three separately-labelled elements, because they answer three different
 * questions and a row that renders them as one phrase makes "the check passed" and "the check
 * passed, about a commit that has since moved" the same sentence (F20-AC3, N03-AC1):
 *
 *   - **what counts now** — the standing, which is the only one of the three that is a verdict;
 *   - **what the source said at the time** — `recordedOutcome`, in the past tense, always shown.
 *     Deleting it would be the tempting simplification and it is the wrong one: an owner watching a
 *     check go stale needs to know what the source *did* say, or "stale" reads as "we lost the
 *     result" rather than "that result is about a commit that is no longer on screen" (F24-AC4);
 *   - **which commit it is about** — the full SHA the source attributed the run to, rendered by the
 *     component that refuses an abbreviation (F24-AC4).
 *
 * Nothing here decides whether the candidate is ready, safe, or accepted. Those are the server's
 * answers, and a component that inferred them would be the second opinion this product exists to
 * avoid (F24-AC3, F25-AC1).
 */

import type { ReactElement } from 'react';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { CommitSha } from './CommitSha.tsx';
import { attributedToCandidate, standingOf, truncate } from './observation-standing.ts';
import type { RecordedObservation } from './transport.ts';

export interface ObservationRowProps {
  readonly observation: RecordedObservation;
  /** The full SHA of the candidate on screen, which every observation is judged against. */
  readonly candidateHeadSha: string;
}

/**
 * One observation row.
 *
 * `data-standing` carries the standing's key and `data-counts` the server's own flag, so a test can
 * assert the five outcomes stayed distinct without matching prose, and so a standing that ever
 * collapses into another is visible in the DOM rather than only in a rendering (N03-AC1).
 */
export function ObservationRow({ observation, candidateHeadSha }: ObservationRowProps): ReactElement {
  const presentation = standingOf(observation, candidateHeadSha);
  const attributed = attributedToCandidate(observation, candidateHeadSha);
  return (
    <li
      className="capability-list__item"
      data-testid="observation"
      data-check-id={observation.checkId}
      data-standing={presentation.key}
      data-counts={String(observation.countsForCurrentCandidate)}
      data-recorded-outcome={observation.recordedOutcome}
      data-current-outcome={observation.currentOutcome}
    >
      <span className="profile-list__name">{observation.checkId}</span>
      <StatusBadge tone={presentation.tone} label={presentation.label} detail={presentation.standing} />
      <p className="connector__problem-line" data-testid="observation-standing">
        {presentation.standing}
      </p>
      <p className="connector__problem-line" data-testid="observation-recorded">
        {`What the source said at the time: ${readable(observation.recordedOutcome)}` +
          (observation.observedAt === null
            ? ', with no recorded observation time.'
            : `, observed ${observation.observedAt}.`) +
          ' That is history. It is not a verdict on the candidate on screen, and it is never counted as one (F20-AC3).'}
      </p>
      <p className="connector__problem-line" data-testid="observation-current">
        {`What counts now: ${readable(observation.currentOutcome)}.` +
          (attributed
            ? ' This observation names the commit on screen, so it is about that code.'
            : observation.observedHeadSha === null
              ? ' This observation named no commit, so it is evidence for no candidate at all (F20-AC3).'
              : ' This observation names a different commit, so it is not about the code on screen (F20-AC3, F24-AC4).')}
      </p>
      {observation.observedHeadSha === null ? null : (
        <CommitSha
          sha={observation.observedHeadSha}
          label="Commit the source attributed this run to"
          current={attributed}
        />
      )}
      {observation.reason === '' ? null : <p className="connector__problem-line">{observation.reason}</p>}
    </li>
  );
}

/**
 * Renders a result word in a sentence.
 *
 * Underscores become spaces and the word is quoted, so a value this build has no name for is visibly
 * a value rather than a claim: `“passed”` inside a sentence is a fact being reported, whereas
 * `passed` on its own reads as this page's own conclusion (N03-AC1).
 */
function readable(outcome: string): string {
  const words = outcome.replace(/_/g, ' ');
  return words === '' ? 'nothing at all' : `“${truncate(words)}”`;
}