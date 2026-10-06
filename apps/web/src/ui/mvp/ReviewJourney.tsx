/**
 * The Review area: candidate → verify → owner test → decision.
 *
 * ## Why two steps and not one screen
 *
 * They answer different questions and are reached at different moments. `CandidatePage` answers
 * "what does the provider say about this pull request right now" — repository, PR number, full head
 * SHA, provider state, check facts, and a refresh that re-reads the provider. `ReviewScreen`
 * answers "what has ShipLoop proven for that exact commit, and may I accept it" — criteria,
 * evidence, owner tests, staleness, eligibility, and the decision itself.
 *
 * Collapsing them into one screen would mean either showing provider facts where the owner came to
 * decide, or hiding the exact commit identity from the decision — and the full head SHA is the only
 * value that identifies the code under review (F24-AC2, mvp-spec 3).
 *
 * Both list the project's candidates themselves from the Home projection and let the owner pick, so
 * neither depends on the other having been visited. Stepping between them therefore never loses the
 * selection: each reads its own choice from the same projection rather than from a prop this
 * coordinator would have to thread and could get wrong (F02-AC2).
 *
 * ## What it does not do
 *
 * It does not gate a step on a client-side opinion. The candidate step is not hidden until a
 * candidate exists, and the review step is not hidden until verification has run — a step that
 * refuses to open is a step whose absence tells the owner nothing, and the screens behind it
 * already render the server's own answer when there is nothing to show (F23-AC1, F24-AC3).
 */

import { useState, type ReactElement } from 'react';

import { CandidatePage } from './CandidatePage.tsx';
import { ReviewScreen } from './ReviewScreen.tsx';
import { NoProjectSelected } from './screen.tsx';
import type { ScreenProps } from './screen.tsx';

const STEPS = [
  { id: 'candidate', label: 'Candidate & Verify' },
  { id: 'decision', label: 'Review & Decide' },
] as const;

type StepId = (typeof STEPS)[number]['id'];

export function ReviewJourney({ scope, epoch }: ScreenProps): ReactElement {
  const [step, setStep] = useState<StepId>('candidate');

  if (scope === null) return <NoProjectSelected />;

  return (
    <div className="journey">
      <nav className="journey__steps" aria-label="Candidate to decision">
        <ul className="journey__step-list">
          {STEPS.map((entry) => (
            <li key={entry.id}>
              <button
                className="button button--tab"
                type="button"
                aria-current={step === entry.id ? 'page' : undefined}
                onClick={() => setStep(entry.id)}
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {step === 'candidate' ? <CandidatePage scope={scope} epoch={epoch} /> : null}
      {step === 'decision' ? <ReviewScreen scope={scope} epoch={epoch} /> : null}
    </div>
  );
}