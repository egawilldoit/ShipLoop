/**
 * One acceptance criterion, as the owner authors it.
 *
 * Three facts sit on this row and are deliberately not merged into one "verification"
 * control, because merging them is how a criterion ends up looking covered when nothing
 * will verify it:
 *
 *   - **Who settles it** — an automated check, or the owner acting. This is a scope
 *     decision: it says how the criterion will be checked, and it verifies nothing by
 *     existing (F23-AC1).
 *   - **Which check** — for an automated row only. A named check is the stable identity a
 *     verdict is filed against, so the same binding survives every re-run. It is a dropdown
 *     over the project's *own* configured checks, never a text box: a free-text field would
 *     let a criterion bind to a check nobody runs, which is exactly what the binding
 *     exists to prevent (F23-AC1, F24-AC3).
 *   - **That an owner test carries no check at all.** The control is not rendered disabled
 *     for an owner test; it is absent, because a named check is precisely the automated
 *     verification an owner test exists to replace.
 *
 * The check the owner picks is not a hint. It is the criterion's binding, it travels in
 * `verificationCheckId`, and approval refuses the whole contract if an automated row has
 * none — naming `acceptanceCriteria.<id>.verificationCheckId`, so this row is where that
 * message has to land.
 */

import { useId, type ReactElement } from 'react';
import type { ApiFieldError } from '../api-client.ts';
import type {
  DraftCriterion,
  DraftProblem,
  VerificationChoices,
  VerificationType,
} from '../contract-draft.ts';

/**
 * What each verification type means, in words.
 *
 * Not a label — a sentence, because this is the decision that decides who is allowed to
 * settle the work. An owner who picks "you, by acting" and then sees a green check list
 * has been told something the row will not honour.
 */
const TYPE_EXPLANATIONS: Readonly<Record<VerificationType, string>> = {
  automated:
    'An automated check settles this criterion. Name the check, so the verdict is filed against one known run rather than against whichever check happened to be green.',
  owner_test:
    'You settle this criterion yourself, by acting. No check can discharge it, and it stays yours to run until you record what you saw.',
};

export interface CriterionEditorProps {
  readonly criterion: DraftCriterion;
  /** Position among the criteria, for the visible label. The id carries the identity. */
  readonly index: number;
  /** The project's configured checks, or the reason there are none to offer. */
  readonly choices: VerificationChoices;
  /** This row's own validation problems, keyed as `draftProblems` returns them. */
  readonly ownProblems: readonly DraftProblem[];
  /**
   * Problems the *server* named for this row.
   *
   * Passed in rather than looked up here so the row does not have to know how a refusal
   * path is spelled — and so a message the page could not attribute to a row still reaches
   * the owner somewhere, rather than being dropped for want of a home.
   */
  readonly serverProblems: readonly ApiFieldError[];
  /** True when the revision is agreed and its text must not change under it. */
  readonly disabled: boolean;
  readonly canRemove: boolean;
  readonly onChange: (next: DraftCriterion) => void;
  readonly onRemove: () => void;
}

/**
 * One criterion row.
 *
 * Every control has a real `<label for>`, and the problem list is a live region, because
 * this is a form an owner fills in and then has to be able to correct after a refusal
 * without losing what they typed (F02-AC4, N03-AC3).
 */
export function CriterionEditor({
  criterion,
  index,
  choices,
  ownProblems,
  serverProblems,
  disabled,
  canRemove,
  onChange,
  onRemove,
}: CriterionEditorProps): ReactElement {
  const base = useId();
  const descriptionId = `${base}-description`;
  const typeId = `${base}-type`;
  const checkId = `${base}-check`;
  const problemsId = `${base}-problems`;

  // Split so the check control is marked invalid for a binding problem specifically, and the
  // description for everything else. One error flag on the fieldset would mark the whole row
  // wrong for a problem the owner has already fixed on one control.
  const bindingProblems = ownProblems.filter((problem) => problem.key === 'verificationCheckId');
  const rowProblems = ownProblems.filter((problem) => problem.key !== 'verificationCheckId');
  const everyProblem = [...rowProblems, ...serverProblems];
  const hasProblems = everyProblem.length > 0;

  /**
   * Switching type clears the binding, because the type decides it.
   *
   * Keeping a check on a row that just became an owner test would leave it asserting both
   * "only I can judge this" and "check X settles it", which approval refuses. Choosing the
   * type is the owner saying which of the two is true, so the other goes with it.
   */
  const changeType = (verificationType: VerificationType): void => {
    onChange({
      ...criterion,
      verificationType,
      verificationCheckId: verificationType === 'owner_test' ? null : criterion.verificationCheckId,
    });
  };

  return (
    <fieldset className="panel" disabled={disabled} data-testid="criterion-row" data-criterion-id={criterion.id}>
      <legend className="panel__title">
        Criterion {index + 1} <span className="connector__subtitle">({criterion.id})</span>
      </legend>

      <label className="field__label" htmlFor={descriptionId}>
        What must be true
      </label>
      <textarea
        id={descriptionId}
        className="field__input"
        rows={2}
        value={criterion.description}
        aria-invalid={rowProblems.length > 0 || undefined}
        aria-describedby={rowProblems.length > 0 ? problemsId : undefined}
        onChange={(event) => onChange({ ...criterion, description: event.target.value })}
      />

      <label className="field__label" htmlFor={typeId}>
        Who settles it
      </label>
      <select
        id={typeId}
        className="field__input"
        value={criterion.verificationType}
        onChange={(event) => changeType(event.target.value === 'owner_test' ? 'owner_test' : 'automated')}
      >
        <option value="automated">An automated check</option>
        <option value="owner_test">You, by acting (owner test)</option>
      </select>
      <p className="field__hint">{TYPE_EXPLANATIONS[criterion.verificationType]}</p>

      {criterion.verificationType === 'automated' ? (
        <>
          <label className="field__label" htmlFor={checkId}>
            Which check verifies it
          </label>
          <VerificationPicker
            inputId={checkId}
            problemsId={problemsId}
            invalid={bindingProblems.length > 0 || serverProblems.length > 0}
            value={criterion.verificationCheckId}
            choices={choices}
            onChange={(verificationCheckId) => onChange({ ...criterion, verificationCheckId })}
          />
        </>
      ) : null}

      {hasProblems || bindingProblems.length > 0 ? (
        <ul className="field__error" id={problemsId} aria-live="polite">
          {[...bindingProblems, ...everyProblem].map((problem) => (
            <li key={problem.message}>{problem.message}</li>
          ))}
        </ul>
      ) : null}

      <button className="button button--secondary" type="button" disabled={disabled || !canRemove} onClick={onRemove}>
        Remove criterion {criterion.id}
      </button>
      {canRemove ? null : (
        <p className="field__hint">
          A contract needs at least one acceptance criterion, so the last one cannot be removed.
        </p>
      )}
    </fieldset>
  );
}

/**
 * The check dropdown.
 *
 * Split out because what it renders depends on *why* there is nothing to choose, and those
 * are three different messages rather than one empty control:
 *
 *   - the project configured no checks — an actionable state, so the owner is told and
 *     pointed at the remedy instead of being shown a broken-looking dropdown;
 *   - the configuration could not be read — nothing is known, so no check is offered and no
 *     claim is made about what this project runs;
 *   - checks exist but none is chosen — the empty option states what not choosing means.
 */
function VerificationPicker({
  inputId,
  problemsId,
  invalid,
  value,
  choices,
  onChange,
}: {
  readonly inputId: string;
  readonly problemsId: string;
  readonly invalid: boolean;
  readonly value: string | null;
  readonly choices: VerificationChoices;
  readonly onChange: (value: string | null) => void;
}): ReactElement {
  if (choices.kind === 'unreadable') {
    return (
      <>
        <p className="state-line state-line--error" role="alert" data-state="unreadable">
          This project&rsquo;s configured checks could not be read, so no check can be offered here: {choices.reason}{' '}
          Nothing has been chosen for you. An automated criterion that names no check can never be verified, and
          approval is refused until it names one.
        </p>
      </>
    );
  }

  if (choices.kind === 'none-configured') {
    return (
      <>
        <p className="state-line state-line--error" role="alert" data-state="empty">
          This project has no configured checks, so there is nothing for an automated criterion to bind to.
          Configure a required check for this project in Settings, or mark this criterion as a test you run
          yourself.
        </p>
      </>
    );
  }

  return (
    <select
      id={inputId}
      className="field__input"
      value={value ?? ''}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? problemsId : undefined}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
    >
      <option value="">Choose a check — nothing is bound until you do</option>
      {choices.choices.map((choice) => (
        <option key={choice.name} value={choice.name}>
          {choice.name}
          {choice.noLongerConfigured ? ' (no longer configured for this project)' : ''}
        </option>
      ))}
    </select>
  );
}