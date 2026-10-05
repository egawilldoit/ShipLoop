/**
 * New Request: one field, one real request.
 *
 * This is the first step of the MVP journey (`Request → Contract → Handoff`) and the whole of it is a
 * sentence. The route behind it accepts exactly `title` and `description`, so there is no scope, no
 * acceptance criterion, no verification type, no category and no priority to fill in — a request is
 * *capture*, and the agreement about what a successful change looks like is the next screen, where the
 * server has a place to put it (mvp-spec 3, F06-AC1).
 *
 * Three properties this screen holds:
 *
 *   - **One required field.** "What do you want changed?" is the request. The optional short label
 *     exists because the server's schema requires a title; leaving it blank derives one from the
 *     owner's own first sentence rather than asking for a second piece of the same thought.
 *   - **A refusal never costs the sentence.** Every rejected submit keeps the text on screen, because
 *     a form that clears itself on a refusal makes the owner retype the thing they just wrote
 *     (N03-AC3).
 *   - **The created request is read back.** After a `POST` the screen calls `readRequestDetail` and
 *     renders *that*, so which revision is approved and which is being edited is an answer from the
 *     server rather than an assumption that a request starts with no contract (F24-AC2).
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import {
  createRequestFromWords,
  readProjectRequests,
  readRequestDetail,
  requestProgress,
  type RequestForm,
} from './request-intake.ts';
import { NoProjectSelected, ScreenEmpty, ScreenFailure, ScreenLoading } from './screen.tsx';
import type { ScreenProps } from './screen.tsx';
import type { MvpFailure, RequestDetailView, RequestView } from '../mvp-client/index.ts';

/** What the request list is showing, as states a reader must be able to tell apart (N03-AC1). */
type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly requests: readonly RequestView[] }
  | { readonly kind: 'refused'; readonly failure: MvpFailure };

/** What the last submit did. `created` is only ever set from a read-back. */
type SubmitState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'created'; readonly detail: RequestDetailView }
  | { readonly kind: 'refused'; readonly failure: MvpFailure };

export function RequestScreen({ scope, epoch }: ScreenProps): ReactElement {
  const [form, setForm] = useState<RequestForm>({ description: '', title: '' });
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });

  const load = useCallback((): void => {
    if (scope === null) return;
    setList({ kind: 'loading' });
    void readProjectRequests(scope).then((result) => {
      setList(result.ok ? { kind: 'ready', requests: result.value } : { kind: 'refused', failure: result.failure });
    });
  }, [scope]);

  useEffect(load, [load, epoch]);

  const submitForm = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (submit.kind === 'saving' || scope === null) return;
    setSubmit({ kind: 'saving' });
    void createRequestFromWords(scope, form).then((result) => {
      if (!result.ok) {
        // The form keeps its text: the owner is one correction away from a request, not one retype.
        setSubmit({ kind: 'refused', failure: result.failure });
        return;
      }
      const created = result.value;
      void readRequestDetail(scope, created.requestId).then((detail) => {
        if (!detail.ok) {
          setSubmit({ kind: 'refused', failure: detail.failure });
          return;
        }
        // Read back, then cleared: the request exists and the server has been asked what it holds.
        setForm({ description: '', title: '' });
        setSubmit({ kind: 'created', detail: detail.value });
        load();
      });
    });
  };

  if (scope === null) {
    return (
      <section className="page page--narrow" aria-labelledby="request-heading" data-testid="request-screen">
        <h2 className="page__title" id="request-heading">
          New request
        </h2>
        <NoProjectSelected />
      </section>
    );
  }

  return (
    <section className="page" aria-labelledby="request-heading" data-testid="request-screen">
      <header className="page__header">
        <h2 className="page__title" id="request-heading">
          New request
        </h2>
        <p className="panel__note">
          Say what you want changed. A request is a capture, not a ticket form: the outcome, the scope and
          the acceptance criteria are written on the delivery contract screen afterwards, where the server
          keeps them as a versioned agreement.
        </p>
      </header>

      <form className="form" onSubmit={submitForm} noValidate data-testid="request-form">
        <label className="field__label" htmlFor="request-description">
          What do you want changed?
        </label>
        <textarea
          id="request-description"
          className="field__input"
          rows={6}
          value={form.description}
          disabled={submit.kind === 'saving'}
          aria-describedby="request-description-hint"
          data-testid="request-description"
          onChange={(event) => setForm({ ...form, description: event.target.value })}
        />
        <p className="field__hint" id="request-description-hint">
          In your own words. Nothing else is required, and nothing here is interpreted for you — what you
          write is what the request says.
        </p>

        <label className="field__label" htmlFor="request-title">
          Short label (optional)
        </label>
        <input
          id="request-title"
          className="field__input"
          value={form.title}
          maxLength={200}
          disabled={submit.kind === 'saving'}
          aria-describedby="request-title-hint"
          data-testid="request-title"
          onChange={(event) => setForm({ ...form, title: event.target.value })}
        />
        <p className="field__hint" id="request-title-hint">
          Leave this empty and the first line of your description becomes the label. Type one and it is
          used as written.
        </p>

        {submit.kind === 'refused' ? <ScreenFailure failure={submit.failure} /> : null}

        <div className="form__actions">
          <button
            className="button"
            type="submit"
            disabled={submit.kind === 'saving'}
            data-testid="request-create"
          >
            {submit.kind === 'saving' ? 'Creating the request…' : 'Create request'}
          </button>
        </div>
      </form>

      {submit.kind === 'created' ? <CreatedRequest detail={submit.detail} /> : null}

      <ExistingRequests list={list} />
    </section>
  );
}

/**
 * What the server holds about the request that was just created.
 *
 * Read back from the server rather than assembled from the create response, and the contract state is
 * rendered as lines of facts — a revision number, its content fingerprint — instead of a summary the
 * screen composed. `requestProgress` says what came back, and this renders it (F24-AC2).
 */
function CreatedRequest({ detail }: { readonly detail: RequestDetailView }): ReactElement {
  return (
    <section className="panel" aria-labelledby="created-request-heading" data-testid="request-created">
      <h3 className="panel__title" id="created-request-heading">
        {`Request created: ${detail.request.title}`}
      </h3>
      <p className="panel__note" data-testid="request-created-id">
        {`Id ${detail.request.requestId}. This is what the server holds, read back after the create rather than ` +
          'taken from the create response.'}
      </p>
      <p className="panel__note">{detail.request.description}</p>
      <h4 className="panel__title">Where it stands</h4>
      <ul className="capability-list">
        {requestProgress(detail).map((line) => (
          <li className="capability-list__item" key={line.fact} data-testid="request-progress">
            <span className="profile-list__name">{line.fact}</span>
            <span className="profile-list__detail">{line.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ExistingRequests({ list }: { readonly list: ListState }): ReactElement {
  return (
    <section className="panel" aria-labelledby="requests-heading" data-testid="request-list">
      <h3 className="panel__title" id="requests-heading">
        Requests in this project
      </h3>
      {list.kind === 'loading' ? <ScreenLoading what="Reading this project's requests…" /> : null}
      {list.kind === 'refused' ? <ScreenFailure failure={list.failure} /> : null}
      {list.kind === 'ready' && list.requests.length === 0 ? (
        <ScreenEmpty>This project has no requests yet. The one above is the first.</ScreenEmpty>
      ) : null}
      {list.kind === 'ready' && list.requests.length > 0 ? (
        <ul className="profile-list">
          {list.requests.map((request) => (
            <li className="profile-list__item" key={request.requestId}>
              <span className="profile-list__name">{request.title}</span>
              <span className="profile-list__detail">{request.description}</span>
              <p className="profile-list__detail">{`Id ${request.requestId}`}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
