/**
 * The two repeating editors the Delivery Contract needs: a list of short exclusions, and a list
 * of acceptance criteria with a verification method each.
 *
 * Both are built as a fieldset with a legend and per-row labels rather than as a table of inputs,
 * because a screen reader announcing "text field 3" is the same as announcing nothing, and the
 * owner has to be able to hear which requirement they are editing.
 *
 * Row numbering is one-based in every label. That is not decoration: an error message names a
 * row ("Remove this empty row…"), and a message that cannot be matched to an input is a message
 * the owner has to count rows to act on.
 */

import { useId, type ReactElement } from 'react';
import { VERIFICATION_TYPES, type CriterionDraft } from '../contract.ts';
import type { VerificationType } from '../wire.ts';

export interface OutOfScopeEditorProps {
  readonly rows: readonly string[];
  readonly errors: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly onChange: (rows: readonly string[]) => void;
}

export function OutOfScopeEditor({ rows, errors, disabled, onChange }: OutOfScopeEditorProps): ReactElement {
  const legendId = useId();
  return (
    <fieldset className="repeater" aria-describedby={`${legendId}-hint`}>
      <legend className="repeater__legend">Out of scope</legend>
      <p className="field__hint" id={`${legendId}-hint`}>
        What this work will deliberately not do. Each line is one exclusion; an empty list is allowed
        and means nothing is being excluded.
      </p>
      {rows.length === 0 ? (
        <p className="state-line" role="status" data-state="empty" data-testid="out-of-scope-empty">
          Nothing is excluded. A contract that forbids nothing is a real position, so this list can stay empty.
        </p>
      ) : (
        <ul className="repeater__list">
          {rows.map((value, index) => {
            const id = `out-of-scope-${String(index)}`;
            const error = errors[`outOfScope.${String(index)}`];
            return (
              <li className="repeater__row" key={id}>
                <label className="field__label" htmlFor={id}>
                  {`Exclusion ${String(index + 1)}`}
                </label>
                <input
                  className="field__input"
                  id={id}
                  value={value}
                  disabled={disabled}
                  aria-invalid={error === undefined ? undefined : 'true'}
                  aria-describedby={error === undefined ? undefined : `${id}-error`}
                  onChange={(event) => {
                    const next = [...rows];
                    next[index] = event.target.value;
                    onChange(next);
                  }}
                />
                {error === undefined ? null : (
                  <p className="field__error" id={`${id}-error`} data-testid={`out-of-scope-error-${String(index)}`}>
                    <span className="field__error-mark" aria-hidden="true" />
                    Error: {error}
                  </p>
                )}
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={disabled}
                  data-testid={`remove-out-of-scope-${String(index)}`}
                  onClick={() => onChange(rows.filter((_, position) => position !== index))}
                >
                  {`Remove exclusion ${String(index + 1)}`}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="form__actions">
        <button
          className="button button--secondary"
          type="button"
          disabled={disabled}
          data-testid="add-out-of-scope"
          onClick={() => onChange([...rows, ''])}
        >
          Add an exclusion
        </button>
      </div>
    </fieldset>
  );
}

export interface CriteriaEditorProps {
  readonly criteria: readonly CriterionDraft[];
  readonly errors: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly onChange: (criteria: readonly CriterionDraft[]) => void;
}

export function CriteriaEditor({ criteria, errors, disabled, onChange }: CriteriaEditorProps): ReactElement {
  const legendId = useId();
  const replace = (index: number, patch: Partial<CriterionDraft>): void => {
    const next = criteria.map((criterion, position) =>
      position === index ? { ...criterion, ...patch } : criterion,
    );
    onChange(next);
  };
  return (
    <fieldset className="repeater" aria-describedby={`${legendId}-hint`}>
      <legend className="repeater__legend">Acceptance criteria</legend>
      <p className="field__hint" id={`${legendId}-hint`}>
        One row per requirement, each with how it will be verified. A requirement with no method
        cannot be judged later, which is the one state this product must never present as verified.
      </p>
      {criteria.length === 0 ? (
        <p className="state-line" role="status" data-state="empty" data-testid="criteria-empty">
          No acceptance criteria yet. A contract with no criterion cannot be judged, so at least one is required
          before it can be approved.
        </p>
      ) : (
        <ul className="repeater__list">
          {criteria.map((criterion, index) => {
            const id = `criterion-${String(index)}`;
            const descriptionError = errors[`acceptanceCriteria.${String(index)}.description`];
            const methodError = errors[`acceptanceCriteria.${String(index)}.verificationType`];
            return (
              <li className="repeater__row" key={criterion.id ?? id}>
                <label className="field__label" htmlFor={id}>
                  {`Criterion ${String(index + 1)}`}
                </label>
                <input
                  className="field__input"
                  id={id}
                  value={criterion.description}
                  disabled={disabled}
                  aria-required="true"
                  aria-invalid={descriptionError === undefined ? undefined : 'true'}
                  onChange={(event) => replace(index, { description: event.target.value })}
                />
                {descriptionError === undefined ? null : (
                  <p className="field__error" data-testid={`criterion-error-${String(index)}`}>
                    <span className="field__error-mark" aria-hidden="true" />
                    Error: {descriptionError}
                  </p>
                )}
                <label className="field__label" htmlFor={`${id}-method`}>
                  {`How criterion ${String(index + 1)} is verified`}
                </label>
                <select
                  className="field__input"
                  id={`${id}-method`}
                  value={criterion.verificationType}
                  disabled={disabled}
                  aria-invalid={methodError === undefined ? undefined : 'true'}
                  onChange={(event) => replace(index, { verificationType: event.target.value as VerificationType })}
                >
                  {VERIFICATION_TYPES.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.label}
                    </option>
                  ))}
                </select>
                <p className="field__hint">
                  {VERIFICATION_TYPES.find((type) => type.id === criterion.verificationType)?.meaning ?? ''}
                </p>
                {methodError === undefined ? null : (
                  <p className="field__error">
                    <span className="field__error-mark" aria-hidden="true" />
                    Error: {methodError}
                  </p>
                )}
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={disabled}
                  data-testid={`remove-criterion-${String(index)}`}
                  onClick={() => onChange(criteria.filter((_, position) => position !== index))}
                >
                  {`Remove criterion ${String(index + 1)}`}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="form__actions">
        <button
          className="button button--secondary"
          type="button"
          disabled={disabled}
          data-testid="add-criterion"
          onClick={() => onChange([...criteria, { id: null, description: '', verificationType: 'automated' }])}
        >
          Add an acceptance criterion
        </button>
      </div>
    </fieldset>
  );
}