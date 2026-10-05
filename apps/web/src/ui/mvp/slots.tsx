/**
 * The two primary areas whose screens arrive from their own work.
 *
 * ## Why these are honest placeholders and not blank pages
 *
 * Home and Settings are wired in this build. New Request and Review are built as separate pieces
 * of work against this same shell, and until those land a screen here would either be empty —
 * which reads as "you have nothing" — or would fabricate content, which is the one thing this
 * product must never do.
 *
 * So each slot states plainly which area it is, that it is not wired in this build, and what
 * belongs there. Integration replaces the body of each with the real screen; the seam
 * (`ScreenProps`) does not change, so nothing else in the shell moves.
 *
 * ## What these must never do
 *
 * Render a sample request, a fake contract, a mock candidate or a "coming soon" button that does
 * something. A placeholder that looks like content is worse than a missing feature: an owner
 * reading a fabricated contract has been told something untrue about their own work (F23-AC1).
 */

import type { ReactElement } from 'react';

import { NoProjectSelected } from './screen.tsx';
import type { ScreenProps } from './screen.tsx';

function NotWiredInThisBuild({
  title,
  belongs,
}: {
  readonly title: string;
  readonly belongs: readonly string[];
}): ReactElement {
  return (
    <div className="slot">
      <h2 className="page__title">{title}</h2>
      <p className="state-line" data-state="empty">
        This area is not wired in this build.
      </p>
      <p className="slot__belongs">It is where the owner will:</p>
      <ul className="slot__list">
        {belongs.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>
    </div>
  );
}

/** The New Request area: request, Delivery Contract, approval, handoff. */
export function NewRequestSlot({ scope }: ScreenProps): ReactElement {
  if (scope === null) return <NoProjectSelected />;
  return (
    <NotWiredInThisBuild
      title="New Request"
      belongs={[
        'say what should change',
        'write the Delivery Contract: outcome, scope, exclusions, acceptance criteria',
        'approve the exact contract text',
        'prepare the implementation handoff',
      ]}
    />
  );
}

/** The Review area: candidate, verification, owner test, decision. */
export function ReviewSlot({ scope }: ScreenProps): ReactElement {
  if (scope === null) return <NoProjectSelected />;
  return (
    <NotWiredInThisBuild
      title="Review"
      belongs={[
        'link the GitHub pull request that is the candidate',
        'run verification against that exact commit',
        'record owner tests where the contract requires them',
        'Request Changes or Accept the exact commit',
      ]}
    />
  );
}