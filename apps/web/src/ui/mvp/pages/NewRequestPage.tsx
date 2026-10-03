/**
 * New Request: the one place the MVP asks the owner to describe what they want changed.
 *
 * A single input, labelled `What do you want changed?`, and nothing else. The MVP journey has
 * exactly one capture step before the Delivery Contract, and every extra field here is a decision
 * the owner would have to make before knowing what the contract needs.
 *
 * The title is derived from the first line of that text, and the derivation is **shown** rather
 * than performed. A request that ends up called "Add a search box to the runs list" because the
 * owner wrote that first is a useful title; a request silently truncated to forty characters is
 * not, and the owner can only correct what they can see. The first line is used whole, up to a
 * bounded length, and a longer first line says so here rather than quietly losing its tail.
 *
 * After creation the page goes straight to the Delivery Contract. That is the whole point of the
 * capture step: the request is the input to the agreement, not an artefact to be reviewed on its
 * own, so stopping here would ask the owner to navigate to the next thing themselves.
 */

import { useState, type FormEvent, type ReactElement } from 'react';
import { createRequest } from '../client.ts';
import { deriveTitle, TITLE_LIMIT } from '../request.ts';
import { Panel, StateLine } from '../components/StateLine.tsx';

export interface NewRequestPageProps {
  readonly projectId: string | null;
  readonly onCreated: (contractId: string) => void;
}

export function NewRequestPage({ projectId, onCreated }: NewRequestPageProps): ReactElement {
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const derived = deriveTitle(description);
  const canSubmit = description.trim() !== '' && !saving;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    if (derived.title === '') {
      setFieldError('Say what you want changed. An empty request cannot become a contract.');
      return;
    }
    setFieldError(undefined);
    setSaving(true);
    setError(null);
    const result = await createRequest({
      projectId,
      title: derived.title,
      description: description.trim(),
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error.reason);
      return;
    }
    onCreated(result.value.contract.id);
  };

  return (
    <section className="page" aria-labelledby="new-request-title">
      <h2 className="page__title" id="new-request-title">
        New request
      </h2>
      <p className="panel__note">
        Write it the way you would explain it to someone. The next screen turns this into a Delivery Contract
        you can approve, and nothing is agreed until you approve it.
      </p>

      {projectId === null ? (
        <StateLine
          view="stale"
          message="No project is selected, so this request will be recorded against none. Choose a project in Settings first if you want it grouped with the rest of your work."
          testId="new-request-project-warning"
        />
      ) : null}

      <form className="form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="field">
          <label className="field__label" htmlFor="request-description">
            What do you want changed?
          </label>
          <textarea
            className="field__input field__input--area"
            id="request-description"
            name="request-description"
            rows={8}
            value={description}
            disabled={saving}
            aria-required="true"
            aria-invalid={fieldError === undefined ? undefined : 'true'}
            aria-describedby="request-description-hint request-description-preview"
            onChange={(event) => setDescription(event.target.value)}
          />
          <p className="field__hint" id="request-description-hint">
            The first line becomes the request&rsquo;s title. Everything you write here is the input to the
            Delivery Contract, so describe the change rather than the steps.
          </p>
          {fieldError === undefined ? null : (
            <p className="field__error" data-testid="new-request-field-error">
              <span className="field__error-mark" aria-hidden="true" />
              Error: {fieldError}
            </p>
          )}
        </div>

        <p className="field__hint" id="request-description-preview" data-testid="new-request-title-preview">
          {derived.title === ''
            ? 'The title will be taken from your first line.'
            : `Title: ${derived.title}${derived.shortened ? ` (first ${String(TITLE_LIMIT)} characters of a longer first line)` : ''}`}
        </p>

        {error === null ? null : (
          <p className="state-line state-line--error" role="alert" data-state="error" data-testid="new-request-error">
            {`Your request was not recorded: ${error}`}
          </p>
        )}

        <div className="form__actions">
          <button className="button" type="submit" disabled={!canSubmit} data-testid="create-request">
            {saving ? 'Recording…' : 'Record this request'}
          </button>
        </div>
      </form>

      <Panel
        id="new-request-what-happens"
        title="What happens next"
        note="Recording a request opens a Delivery Contract at revision 1 in draft. You write the outcome, the scope and at least one acceptance criterion, then you approve it. Approval is the only thing that makes it a contract."
      />
    </section>
  );
}