import type { ChangeEvent, ReactElement } from 'react';

export interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: 'text' | 'email' | 'password' | 'url';
  readonly autoComplete?: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly required?: boolean;
  readonly disabled?: boolean;
}

/**
 * One labelled input with its own error message.
 *
 * Every form in this app renders controls through here so a control cannot exist without
 * a programmatically associated label, and so a rejected field's message always lands
 * beside its input instead of collapsing into a banner (F02-AC4, N03-AC1).
 *
 * Required state is expressed with `aria-required` rather than the `required` attribute:
 * native validation would suppress submission, and the owner must be able to submit an
 * incomplete form to receive the server's per-field explanation (N03-AC3).
 */
export function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  hint,
  error,
  required = false,
  disabled = false,
}: FieldProps): ReactElement {
  const hintId = hint === undefined ? null : `${id}-hint`;
  const errorId = error === undefined ? null : `${id}-error`;
  const describedBy = [hintId, errorId].filter((part) => part !== null).join(' ');

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        className="field__input"
        id={id}
        name={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        aria-required={required ? 'true' : undefined}
        aria-invalid={error === undefined ? undefined : 'true'}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
      {hintId === null ? null : (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {errorId === null ? null : (
        <p className="field__error" id={errorId}>
          <span className="field__error-mark" aria-hidden="true" />
          Error: {error}
        </p>
      )}
    </div>
  );
}
