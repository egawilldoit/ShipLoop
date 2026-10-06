/**
 * The New Request area: request → Delivery Contract → implementation handoff.
 *
 * ## Why this is one area and not three
 *
 * The three steps are one act — deciding what should change — and splitting them across the four
 * primary areas would either add areas the product did not promise or hide the sequence. So the area
 * holds the two screens the owner writes in, and the handoff appears where it can only be truthful:
 * on the contract screen, directly under the revision the server just sealed.
 *
 * ## Why there is no third step here
 *
 * `HandoffPage` is addressed by a contract *and a revision*. This coordinator has no way to learn
 * which revision that should be without either being told by the contract screen or going looking
 * through the project's requests itself — and `listRequests` returns no contract identity, so
 * "looking" would mean a request-by-request guess. A third step that showed a packet for a
 * revision the owner had not just approved would be worse than no third step, so the contract screen
 * renders the handoff for the identity its own approval returned (F24-AC4).
 *
 * ## What it does not do
 *
 * It does not decide whether a contract may be approved, whether a criterion is satisfied, or
 * whether anything is ready. Those are the backend's, and each screen reflects them (F23-AC1).
 */

import { useState, type ReactElement } from 'react';

import { ContractScreen } from './ContractScreen.tsx';
import { RequestScreen } from './RequestScreen.tsx';
import { NoProjectSelected } from './screen.tsx';
import type { ScreenProps } from './screen.tsx';

const STEPS = [
  { id: 'request', label: '1. Request' },
  { id: 'contract', label: '2. Delivery Contract & Handoff' },
] as const;

type StepId = (typeof STEPS)[number]['id'];

export function RequestJourney({ scope, epoch }: ScreenProps): ReactElement {
  const [step, setStep] = useState<StepId>('request');

  if (scope === null) return <NoProjectSelected />;

  return (
    <div className="journey">
      <nav className="journey__steps" aria-label="Request to contract">
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

      {step === 'request' ? <RequestScreen scope={scope} epoch={epoch} /> : null}
      {step === 'contract' ? <ContractScreen scope={scope} epoch={epoch} /> : null}
    </div>
  );
}