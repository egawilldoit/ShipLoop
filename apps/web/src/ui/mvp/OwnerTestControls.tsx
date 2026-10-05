/**
 * The owner's own controls for one owner-test criterion.
 *
 * An owner test is an observation, not a measurement: there is no provider to read it from and
 * nobody else may record it. So this is the only place on the Review screen where the owner states
 * a result, and it is deliberately explicit — two named controls, Pass and Fail, rather than a
 * dropdown with a third option that would mean nothing (F23-AC1, F25-AC4).
 *
 * Four properties, each preventing a specific wrong outcome:
 *
 *   - **Only where recording is meaningful.** `readOwnerTestControls` decides, from the card's own
 *     state, whether the controls appear: for a pending owner test and for a stale one, and for
 *     nothing else. A settled owner test shows what the owner recorded, with its instant, and
 *     offers no way to change it by clicking again (F25-AC2).
 *   - **A pending owner test is never rendered as passed.** No state here reads as verification
 *     while nobody has acted, and no wording implies a check, an agent or a provider did anything.
 *     The group is labelled with that fact wherever it appears (F23-AC1).
 *   - **A refusal keeps the note.** A rejected write renders beside the controls with the server's
 *     own words and leaves the typed note exactly where it was, so a rejected result costs a click
 *     rather than a retype (N03-AC3, F25-AC2).
 *   - **The note is optional and sent as null when blank.** The endpoint accepts a note or no
 *     note; an empty string is not a note, and sending one is a refusal with no remedy (F25-AC4).
 */

import { useState, type ReactElement } from 'react';
import type { ReviewOwnerTestView } from '../../server/contracts.ts';
import { formatTimestamp } from '../api-client.ts';
import type { MvpFailure } from './mvp-client.ts';
import { domId, ownerTestNote, readOwnerTestControls, readOwnerTestRefusal } from './review-model.ts';

export interface OwnerTestControlsProps {
  readonly test: ReviewOwnerTestView;
  /** True while this criterion's write is in flight. Per criterion, never global. */
  readonly busy: boolean;
  /**
   * Records the result and resolves with the refusal, if the server refused.
   *
   * The caller re-reads the review card afterwards rather than patching it: the card is the
   * authority, it recomputes eligibility, and nothing here is entitled to say what this criterion
   * reads after the write (F24-AC2).
   */
  readonly onRecord: (result: 'passed' | 'failed', note: string | null) => Promise<MvpFailure | null>;
}

export function OwnerTestControls({ test, busy, onRecord }: OwnerTestControlsProps): ReactElement {
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<MvpFailure | null>(null);
  const control = readOwnerTestControls(test);
  const noteId = domId('owner-test-note', test.criterionId);
  const groupId = domId('owner-test-group', test.criterionId);

  const record = async (result: 'passed' | 'failed'): Promise<void> => {
    setRefusal(null);
    const failure = await onRecord(result, ownerTestNote(note));
    if (failure === null) {
      // The card has been re-read with the new state, so this control is either gone (settled) or
      // asking again (the candidate moved). Either way a note that has served its purpose is not
      // left sitting in the box, and nothing local has claimed a result before the server did.
      setNote('');
      return;
    }
    // The note is deliberately left in the box: a refusal must not destroy what the owner typed.
    setRefusal(failure);
  };

  return (
    <div role="group" aria-labelledby={groupId} data-testid="owner-test-controls" data-recordable={control.recordable ? 'true' : 'false'}>
      <p className="panel__note" id={groupId}>
        <strong>{control.heading}</strong> {control.note}
      </p>
      {test.instructions === null || test.instructions === '' ? null : (
        <p className="panel__note">{`How to test it: ${test.instructions}`}</p>
      )}
      {control.recordable ? null : test.observedAt === null ? null : (
        <p className="panel__note">{`You recorded this on ${formatTimestamp(test.observedAt)}.`}</p>
      )}

      {refusal === null ? null : <OwnerTestRefusalNotice failure={refusal} />}

      {control.recordable ? (
        <>
          <div className="field">
            <label className="field__label" htmlFor={noteId}>
              {`Note for ${test.criterionId} (optional)`}
            </label>
            <textarea
              className="field__input"
              id={noteId}
              name={noteId}
              rows={2}
              value={note}
              aria-describedby={`${noteId}-hint`}
              disabled={busy}
              onChange={(event) => setNote(event.target.value)}
            />
            <p className="field__hint" id={`${noteId}-hint`}>
              Anything you want recorded beside your result. Left blank, no note is recorded.
            </p>
          </div>

          <div className="form__actions">
            {/*
              Two controls rather than a choice plus a submit. Each names what it records, so there
              is no intermediate state in which the intended result is ambiguous, and each
              accessible name carries the criterion — a screen full of identically labelled buttons
              is unusable with a screen reader (N03-AC1, F23-AC1).
            */}
            <button
              className="button"
              type="button"
              disabled={busy}
              aria-label={`Pass — ${test.criterionId}`}
              onClick={() => void record('passed')}
            >
              {busy ? 'Recording…' : 'Pass'}
            </button>
            <button
              className="button button--secondary"
              type="button"
              disabled={busy}
              aria-label={`Fail — ${test.criterionId}`}
              onClick={() => void record('failed')}
            >
              {busy ? 'Recording…' : 'Fail'}
            </button>
          </div>
          <p className="panel__note">
            Your result is bound to the commit on screen and to this contract revision. If the candidate moves
            afterwards it reads stale rather than passing, and these controls come back.
          </p>
        </>
      ) : null}
    </div>
  );
}

/**
 * A refused owner-test write, rendered as what it is.
 *
 * The headline denies that anything was recorded, because the criterion on screen still says
 * `pending` or `stale` and a reader who saw a success message would have no way to know the server
 * refused (F25-AC2).
 */
function OwnerTestRefusalNotice({ failure }: { readonly failure: MvpFailure }): ReactElement {
  const reading = readOwnerTestRefusal(failure);
  return (
    <div className="state-line state-line--error" role="alert" data-state="error">
      <p className="panel__note">
        <strong>{reading.headline}</strong> {reading.detail}
      </p>
      {reading.fields.length === 0 ? null : (
        <ul>
          {reading.fields.map((field) => (
            <li key={field.path}>{`${field.path}: ${field.message}`}</li>
          ))}
        </ul>
      )}
      {reading.prerequisites.length === 0 ? null : (
        <ul>
          {reading.prerequisites.map((prerequisite) => (
            <li key={`${prerequisite.name}:${prerequisite.detail}`}>
              {`${prerequisite.name}: ${prerequisite.detail} ${prerequisite.remedy}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
