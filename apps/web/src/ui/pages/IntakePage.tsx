import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import {
  archiveIntakeIdea,
  attachIntakeFile,
  captureIdea,
  deferIntakeIdea,
  exportIntakeIdea,
  fetchIntakeIdea,
  fetchIntakeIdeas,
  fetchRelatedWork,
  fieldMessages,
  formatRelativeTime,
  formatTimestamp,
  recordIntakeSummary,
  recordRelatedWorkChoice,
  type ApiFailure,
  type IntakeDetail,
  type IntakeIdea,
  type RelatedWorkChoice,
  type RelatednessReport,
} from '../api-client.ts';
import { StatusBadge, type StatusTone } from '../components/StatusBadge.tsx';

export interface IntakePageProps {
  readonly selectedIdeaId: string;
  /**
   * The project a capture is recorded against, or null when none is selected (F02-AC1).
   *
   * This page used to send a hard-coded `projectId: null` on every capture, so every request a
   * real owner made was stored against no project at all and the project-scoped screens had
   * nothing that belonged to them. The owner's explicit selection is what a capture is now
   * recorded against, and a capture with no project is still allowed because the specification
   * does not require one — it is simply recorded honestly as unassigned (F06-AC1, F02-AC1).
   */
  readonly selectedProjectId: string | null;
  readonly onSelectIdea: (ideaId: string) => void;
  readonly onOpenBrief: (ideaId: string) => void;
  readonly epoch: number;
}

type FormState = 'idle' | 'saving' | 'done' | 'refused';

type ViewState = 'loading' | 'empty' | 'ready' | 'error';

/**
 * Dispositions carry meaning an owner must not have to infer from a colour, so each
 * one gets a word, a tone and a drawn mark (N03-AC1).
 */
const DISPOSITION_TONES: Readonly<Record<IntakeIdea['disposition'], StatusTone>> = {
  Unpublished: 'pending',
  Published: 'healthy',
  Deferred: 'degraded',
  Archived: 'revoked',
};

const DISPOSITION_MEANING: Readonly<Record<IntakeIdea['disposition'], string>> = {
  Unpublished: 'Captured and not published. No ticket and no coding run exist for it.',
  Published: 'Published: work already exists behind this request, so it cannot be archived.',
  Deferred: 'Deferred without publishing. No ticket and no coding run exist for it.',
  Archived: 'Archived without publishing. No ticket and no coding run exist for it.',
};

const CHOICE_LABELS: Readonly<Record<RelatedWorkChoice, string>> = {
  LinkToExisting: 'Link to the existing request',
  ExtendExisting: 'Extend the existing request',
  CreateNewIssue: 'Create a new issue instead',
};

interface CaptureForm {
  readonly rawRequest: string;
  readonly kind: 'FeatureRequest' | 'Bug';
  readonly notes: string;
  readonly expected: string;
  readonly actual: string;
  readonly reproduction: string;
}

const EMPTY_CAPTURE: CaptureForm = {
  rawRequest: '',
  kind: 'FeatureRequest',
  notes: '',
  expected: '',
  actual: '',
  reproduction: '',
};

function blank(value: string | null): string {
  return value ?? '';
}

/**
 * A textarea with the same labelling and error wiring as `Field`.
 *
 * `Field` renders an input because that is what most of this application needs; the
 * request, the bug detail and the brief sections are paragraphs, and a control whose
 * content is a paragraph still needs a programmatically associated label and a place
 * for its own error message (N03-AC1, N03-AC3).
 */
function TextArea({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  disabled,
  rows = 4,
  required = false,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly disabled: boolean;
  readonly rows?: number;
  readonly required?: boolean;
}): ReactElement {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy = [hintId, errorId].filter((part) => part !== undefined).join(' ');
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <textarea
        className="field__input"
        id={id}
        name={id}
        rows={rows}
        value={value}
        aria-required={required ? 'true' : undefined}
        aria-invalid={error === undefined ? undefined : 'true'}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {hintId === undefined ? null : (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {errorId === undefined ? null : (
        <p className="field__error" id={errorId}>
          <span className="field__error-mark" aria-hidden="true" />
          Error: {error}
        </p>
      )}
    </div>
  );
}

/**
 * Capture: a rough request first, everything else afterwards (F06-AC1, F06-AC3).
 *
 * The form asks for one thing: the owner's own words. A project, notes and bug detail
 * are all optional because a request that insists on completeness is a request an
 * owner gives up on, and a bug is still a real bug when the owner can only describe
 * the symptom (F06-AC3). Choosing "bug" reveals expected, actual and reproduction,
 * each still optional, because which of the three the owner knows varies.
 *
 * Every other intake action acts on a request already captured, so the page is one
 * capture form and then the captured requests. Archiving is two-step and says what it
 * does not do, because "archive" reads like "discard the work" and what it actually
 * does is set a request aside without creating a ticket or consuming a coding run
 * (F06-AC5).
 *
 * The raw request and any generated summary are shown in separate, separately titled
 * blocks and never rendered as one string, because the generated sentence is derived
 * data and an owner who cannot tell which is which will eventually act on a summary
 * as if it were what they asked for (F06-AC1).
 */
export function IntakePage({
  selectedIdeaId,
  selectedProjectId,
  onSelectIdea,
  onOpenBrief,
  epoch,
}: IntakePageProps): ReactElement {
  const [ideas, setIdeas] = useState<readonly IntakeIdea[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [form, setForm] = useState<CaptureForm>(EMPTY_CAPTURE);
  const [formErrors, setFormErrors] = useState<Readonly<Record<string, string>>>({});
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [formState, setFormState] = useState<FormState>('idle');

  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<ViewState>('loading');

  const [attachment, setAttachment] = useState({ name: '', mediaType: 'text/plain', content: '' });
  const [attachmentErrors, setAttachmentErrors] = useState<Readonly<Record<string, string>>>({});
  const [attachmentMessage, setAttachmentMessage] = useState<string | null>(null);
  const [attachmentState, setAttachmentState] = useState<FormState>('idle');

  const [summary, setSummary] = useState({ text: '', generatedBy: '' });
  const [summaryErrors, setSummaryErrors] = useState<Readonly<Record<string, string>>>({});
  const [summaryMessage, setSummaryMessage] = useState<string | null>(null);
  const [summaryState, setSummaryState] = useState<FormState>('idle');

  const [related, setRelated] = useState<readonly RelatednessReport[] | null>(null);
  const [relatedError, setRelatedError] = useState<string | null>(null);
  const [relatedMessage, setRelatedMessage] = useState<string | null>(null);
  const [relatedState, setRelatedState] = useState<ViewState>('loading');
  const [choiceOutcomes, setChoiceOutcomes] = useState<Readonly<Record<string, string>>>({});

  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [dispositionMessage, setDispositionMessage] = useState<string | null>(null);
  const [dispositionState, setDispositionState] = useState<FormState>('idle');

  const [exportText, setExportText] = useState<string | null>(null);
  const [exportState, setExportState] = useState<FormState>('idle');

  const refresh = useCallback((): void => {
    setReload((count) => count + 1);
  }, []);

  useEffect(() => {
    let current = true;
    void fetchIntakeIdeas().then((result) => {
      if (!current) return;
      if (result.ok) {
        setIdeas(result.value.ideas);
        setListError(null);
        return;
      }
      setIdeas(null);
      setListError(result.error.reason);
    });
    return () => {
      current = false;
    };
  }, [epoch, reload]);

  useEffect(() => {
    if (selectedIdeaId === '') {
      setDetail(null);
      setDetailState('empty');
      return;
    }
    let current = true;
    setDetailState('loading');
    void fetchIntakeIdea(selectedIdeaId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setDetail(null);
        setDetailError(result.error.reason);
        setDetailState('error');
        return;
      }
      setDetail(result.value);
      setDetailError(null);
      setDetailState('ready');
    });
    return () => {
      current = false;
    };
  }, [selectedIdeaId, reload]);

  const submitCapture = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (formState === 'saving') return;

    const local: Record<string, string> = {};
    if (form.rawRequest.trim() === '') {
      local['rawRequest'] = 'Write the request in your own words. That text is what gets captured.';
    }
    if (form.kind === 'FeatureRequest' && (form.expected.trim() !== '' || form.actual.trim() !== '')) {
      local['detail'] = 'Expected and actual behaviour describe a bug. Choose Bug, or clear these fields.';
    }
    if (Object.keys(local).length > 0) {
      setFormErrors(local);
      setFormMessage('The request was not captured because some fields need attention.');
      setFormState('refused');
      return;
    }

    setFormState('saving');
    setFormMessage(null);
    const result = await captureIdea({
      rawRequest: form.rawRequest.trim(),
      kind: form.kind,
      // The owner's explicit selection, or null when they selected none. Recorded either way:
      // a capture against no project is a legitimate capture, and recording the real value is
      // what lets the project-scoped screens find this request afterwards (F06-AC1, F02-AC1).
      projectId: selectedProjectId,
      notes: form.notes.trim() === '' ? null : form.notes.trim(),
      detail:
        form.kind === 'Bug'
          ? {
              expected: blankOrNull(form.expected),
              actual: blankOrNull(form.actual),
              reproduction: blankOrNull(form.reproduction),
            }
          : null,
    });
    if (!result.ok) {
      const failure: ApiFailure = result.error;
      setFormErrors(fieldMessages(failure));
      setFormMessage(failure.reason);
      setFormState('refused');
      return;
    }
    setFormErrors({});
    setFormMessage('Captured. The request is stored exactly as written and nothing was published.');
    setFormState('done');
    setForm(EMPTY_CAPTURE);
    onSelectIdea(result.value.idea.ideaId);
    refresh();
  };

  const submitAttachment = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (attachmentState === 'saving' || selectedIdeaId === '') return;

    const local: Record<string, string> = {};
    if (attachment.name.trim() === '') local['name'] = 'Name the file. It is stored under the artifact root by name.';
    if (attachment.content.trim() === '') local['content'] = 'An attachment carries the content it names.';
    if (Object.keys(local).length > 0) {
      setAttachmentErrors(local);
      setAttachmentMessage('The attachment was not added because some fields need attention.');
      setAttachmentState('refused');
      return;
    }

    setAttachmentState('saving');
    setAttachmentMessage(null);
    const result = await attachIntakeFile(selectedIdeaId, {
      name: attachment.name.trim(),
      mediaType: attachment.mediaType,
      content: attachment.content,
    });
    if (!result.ok) {
      setAttachmentErrors(fieldMessages(result.error));
      setAttachmentMessage(result.error.reason);
      setAttachmentState('refused');
      return;
    }
    setAttachmentErrors({});
    setAttachmentMessage(`Attached ${attachment.name.trim()} as a named file. Its content is not stored in the request.`);
    setAttachmentState('done');
    setAttachment({ name: '', mediaType: 'text/plain', content: '' });
    refresh();
  };

  const submitSummary = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (summaryState === 'saving' || selectedIdeaId === '') return;

    const local: Record<string, string> = {};
    if (summary.text.trim() === '') local['text'] = 'A generated summary cannot be blank.';
    if (summary.generatedBy.trim() === '') local['generatedBy'] = 'Record what generated this summary.';
    if (Object.keys(local).length > 0) {
      setSummaryErrors(local);
      setSummaryMessage('The summary was not recorded because some fields need attention.');
      setSummaryState('refused');
      return;
    }

    setSummaryState('saving');
    setSummaryMessage(null);
    const result = await recordIntakeSummary(selectedIdeaId, {
      text: summary.text.trim(),
      generatedBy: summary.generatedBy.trim(),
    });
    if (!result.ok) {
      setSummaryErrors(fieldMessages(result.error));
      setSummaryMessage(result.error.reason);
      setSummaryState('refused');
      return;
    }
    setSummaryErrors({});
    setSummaryMessage('Summary recorded beside the request. The request text is unchanged.');
    setSummaryState('done');
    setSummary({ text: '', generatedBy: '' });
    refresh();
  };

  const searchRelated = async (): Promise<void> => {
    if (selectedIdeaId === '') return;
    setRelatedState('loading');
    setRelatedError(null);
    setChoiceOutcomes({});
    const result = await fetchRelatedWork(selectedIdeaId);
    if (!result.ok) {
      setRelated(null);
      setRelatedError(result.error.reason);
      setRelatedState('error');
      return;
    }
    setRelated(result.value.related);
    setRelatedState(result.value.related.length === 0 ? 'empty' : 'ready');
  };

  const choose = async (candidateIdeaId: string, choice: RelatedWorkChoice): Promise<void> => {
    setRelatedMessage(`Recording your choice: ${CHOICE_LABELS[choice]}.`);
    const result = await recordRelatedWorkChoice(selectedIdeaId, candidateIdeaId, choice);
    if (!result.ok) {
      setRelatedMessage(`Your choice was not recorded: ${result.error.reason}`);
      return;
    }
    const outcome = result.value.choice;
    setChoiceOutcomes((previous) => ({
      ...previous,
      [candidateIdeaId]: `You chose "${CHOICE_LABELS[outcome.choice]}". Nothing was merged: both requests are still ${
        outcome.dispositionAfterChoice.idea === outcome.dispositionAfterChoice.candidate
          ? outcome.dispositionAfterChoice.idea
          : `${outcome.dispositionAfterChoice.idea} and ${outcome.dispositionAfterChoice.candidate}`
      }, and no ticket was created.`,
    }));
    setRelatedMessage('Your choice was recorded. Nothing was merged automatically.');
  };

  const archive = async (): Promise<void> => {
    if (selectedIdeaId === '') return;
    setConfirmingArchive(false);
    setDispositionState('saving');
    setDispositionMessage(null);
    const result = await archiveIntakeIdea(selectedIdeaId, 'archived from intake');
    if (!result.ok) {
      setDispositionMessage(`This request was not archived: ${result.error.reason}`);
      setDispositionState('refused');
      return;
    }
    setDispositionMessage('Archived. No ticket was created and no coding run was consumed.');
    setDispositionState('done');
    refresh();
  };

  const defer = async (): Promise<void> => {
    if (selectedIdeaId === '') return;
    setDispositionState('saving');
    setDispositionMessage(null);
    const result = await deferIntakeIdea(selectedIdeaId, 'deferred from intake');
    if (!result.ok) {
      setDispositionMessage(`This request was not deferred: ${result.error.reason}`);
      setDispositionState('refused');
      return;
    }
    setDispositionMessage('Deferred without publishing. No ticket was created and no coding run was consumed.');
    setDispositionState('done');
    refresh();
  };

  const runExport = async (): Promise<void> => {
    if (selectedIdeaId === '') return;
    setExportState('saving');
    const result = await exportIntakeIdea(selectedIdeaId);
    if (!result.ok) {
      setExportText(`The export could not be produced: ${result.error.reason}`);
      setExportState('refused');
      return;
    }
    const record = result.value.export;
    setExportText(
      [
        `Idea ${record.ideaId} (${record.kind}), captured ${record.capturedAt}.`,
        `Disposition: ${record.disposition.state} - ${record.disposition.detail ?? 'no detail'}.`,
        `Generated summary: ${record.summary === null ? 'none' : record.summary.text}`,
        `Attachments: ${record.attachments.length === 0 ? 'none' : record.attachments.map((entry) => `${entry.fileName} (${entry.byteSize} bytes, ${entry.contentDigest})`).join(', ')}`,
      ].join(' '),
    );
    setExportState('done');
  };

  const known = ideas ?? [];
  const nowMs = Date.now();

  const listView: ViewState =
    listError !== null ? 'error' : ideas === null ? 'loading' : known.length === 0 ? 'empty' : 'ready';
  const listText =
    listView === 'error'
      ? `The captured requests could not be loaded: ${listError ?? 'unknown reason'}`
      : listView === 'loading'
        ? 'Loading captured requests…'
        : listView === 'empty'
          ? 'No request has been captured yet.'
          : `${known.length} ${known.length === 1 ? 'request has' : 'requests have'} been captured.`;

  const detailView: ViewState =
    detailError !== null ? 'error' : selectedIdeaId === '' ? 'empty' : detailState;
  const detailText =
    detailView === 'error'
      ? `This request could not be loaded: ${detailError ?? 'unknown reason'}`
      : detailView === 'empty'
        ? 'Choose a captured request to work on.'
        : detailView === 'loading'
          ? 'Loading this request…'
          : 'This request is loaded.';

  const relatedView: ViewState =
    relatedError !== null ? 'error' : relatedState === 'ready' && (related ?? []).length === 0 ? 'empty' : relatedState;
  const relatedText =
    relatedView === 'error'
      ? `Related work could not be checked: ${relatedError ?? 'unknown reason'}`
      : relatedView === 'loading'
        ? 'Checking for possibly-related work…'
        : relatedView === 'empty'
          ? 'No possibly-related work was found among the captured requests.'
          : `${(related ?? []).length} possibly-related ${(related ?? []).length === 1 ? 'request was' : 'requests were'} found. Nothing has been merged.`;

  return (
    <section className="page" aria-labelledby="intake-title">
      <h2 className="page__title" id="intake-title">
        Intake
      </h2>
      <p className="panel__note">
        Capture a rough request before it is work. Only the request itself is required; nothing here creates a ticket or
        starts a coding run.
      </p>

      <section className="panel" aria-labelledby="capture-title">
        <h3 className="panel__title" id="capture-title">
          Capture a request
        </h3>
        <p className="panel__note">
          The request is stored exactly as written. A generated summary is a separate fact and never replaces this text.
        </p>
        <p
          className={formState === 'refused' ? 'state-line state-line--error' : 'state-line'}
          role={formState === 'refused' ? 'alert' : 'status'}
          aria-live={formState === 'refused' ? 'assertive' : 'polite'}
          data-state={formState}
        >
          {formState === 'saving' ? 'Capturing the request…' : (formMessage ?? 'Nothing has been captured from this form.')}
        </p>

        <form className="form form--grid" noValidate onSubmit={(event) => void submitCapture(event)}>
          <TextArea
            id="intake-raw-request"
            label="The request, in your own words"
            value={form.rawRequest}
            onChange={(value) => setForm((previous) => ({ ...previous, rawRequest: value }))}
            hint="Captured verbatim. Required."
            error={formErrors['rawRequest']}
            disabled={formState === 'saving'}
            required
            rows={5}
          />

          <div className="field" role="radiogroup" aria-labelledby="intake-kind-label">
            <span className="field__label" id="intake-kind-label">
              What kind of request is this?
            </span>
            <div className="field field--check">
              <input
                className="field__input"
                id="intake-kind-feature"
                name="intake-kind"
                type="radio"
                value="FeatureRequest"
                checked={form.kind === 'FeatureRequest'}
                disabled={formState === 'saving'}
                onChange={() => setForm((previous) => ({ ...previous, kind: 'FeatureRequest' }))}
              />
              <label className="field__label" htmlFor="intake-kind-feature">
                A feature request
              </label>
              <input
                className="field__input"
                id="intake-kind-bug"
                name="intake-kind"
                type="radio"
                value="Bug"
                checked={form.kind === 'Bug'}
                disabled={formState === 'saving'}
                onChange={() => setForm((previous) => ({ ...previous, kind: 'Bug' }))}
              />
              <label className="field__label" htmlFor="intake-kind-bug">
                A bug
              </label>
            </div>
            {formErrors['detail'] === undefined ? null : (
              <p className="field__error" id="intake-kind-error">
                <span className="field__error-mark" aria-hidden="true" />
                Error: {formErrors['detail']}
              </p>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="intake-notes">
              Notes (optional)
            </label>
            <textarea
              className="field__input"
              id="intake-notes"
              name="intake-notes"
              rows={3}
              value={form.notes}
              aria-describedby="intake-notes-hint"
              disabled={formState === 'saving'}
              onChange={(event) => setForm((previous) => ({ ...previous, notes: event.target.value }))}
            />
            <p className="field__hint" id="intake-notes-hint">
              Anything else you already know. Never required.
            </p>
          </div>

          {form.kind === 'Bug' ? (
            <>
              <TextArea
                id="intake-expected"
                label="Expected behaviour (optional)"
                value={form.expected}
                onChange={(value) => setForm((previous) => ({ ...previous, expected: value }))}
                disabled={formState === 'saving'}
                rows={3}
              />
              <TextArea
                id="intake-actual"
                label="Actual behaviour (optional)"
                value={form.actual}
                onChange={(value) => setForm((previous) => ({ ...previous, actual: value }))}
                disabled={formState === 'saving'}
                rows={3}
              />
              <TextArea
                id="intake-reproduction"
                label="Steps to reproduce (optional)"
                value={form.reproduction}
                onChange={(value) => setForm((previous) => ({ ...previous, reproduction: value }))}
                hint="A bug is still capturable from its symptom alone."
                disabled={formState === 'saving'}
                rows={3}
              />
            </>
          ) : null}

          <div className="form__actions">
            <button className="button" type="submit" disabled={formState === 'saving'}>
              {formState === 'saving' ? 'Capturing…' : 'Capture this request'}
            </button>
          </div>
        </form>
      </section>

      <section className="panel" aria-labelledby="intake-list-title">
        <h3 className="panel__title" id="intake-list-title">
          Captured requests
        </h3>
        <p
          className={listView === 'error' ? 'state-line state-line--error' : 'state-line'}
          role={listView === 'error' ? 'alert' : 'status'}
          aria-live={listView === 'error' ? 'assertive' : 'polite'}
          data-state={listView}
        >
          {listText}
        </p>

        {known.length === 0 ? null : (
          <ul className="profile-list">
            {known.map((idea) => (
              <li className="profile-list__item" key={idea.ideaId}>
                <span className="profile-list__name">{idea.rawRequest}</span>
                <span className="profile-list__detail">
                  {idea.kind === 'Bug' ? 'Bug' : 'Feature request'}, captured{' '}
                  <time dateTime={idea.capturedAt}>{formatRelativeTime(idea.capturedAt, nowMs)}</time>
                  {` (${formatTimestamp(idea.capturedAt)})`}
                </span>
                <StatusBadge
                  tone={DISPOSITION_TONES[idea.disposition]}
                  label={`Disposition: ${idea.disposition}`}
                  detail={DISPOSITION_MEANING[idea.disposition]}
                />
                <div className="form__actions">
                  <button
                    className="button button--secondary"
                    type="button"
                    aria-pressed={idea.ideaId === selectedIdeaId}
                    onClick={() => onSelectIdea(idea.ideaId)}
                  >
                    {idea.ideaId === selectedIdeaId ? 'Selected request' : `Work on this request (${idea.kind})`}
                  </button>
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() => onOpenBrief(idea.ideaId)}
                  >
                    Open brief and questions
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="intake-detail-title">
        <h3 className="panel__title" id="intake-detail-title">
          The selected request
        </h3>
        <p
          className={detailView === 'error' ? 'state-line state-line--error' : 'state-line'}
          role={detailView === 'error' ? 'alert' : 'status'}
          aria-live={detailView === 'error' ? 'assertive' : 'polite'}
          data-state={detailView}
        >
          {detailText}
        </p>

        {detail === null ? null : (
          <>
            <h4 className="connector__subtitle" id="intake-raw-heading">
              Your request, as you wrote it
            </h4>
            <div className="detail-list">
              <div className="detail-list__row">
                <dt>Raw request</dt>
                <dd data-testid="raw-request">{detail.idea.rawRequest}</dd>
              </div>
              {detail.idea.notes === null ? null : (
                <div className="detail-list__row">
                  <dt>Notes</dt>
                  <dd>{detail.idea.notes}</dd>
                </div>
              )}
              {detail.idea.kind === 'Bug' ? (
                <>
                  <div className="detail-list__row">
                    <dt>Expected</dt>
                    <dd>{blank(detail.idea.bugDetail.expected) || 'Not stated.'}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Actual</dt>
                    <dd>{blank(detail.idea.bugDetail.actual) || 'Not stated.'}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Reproduction</dt>
                    <dd>{blank(detail.idea.bugDetail.reproduction) || 'Not stated.'}</dd>
                  </div>
                </>
              ) : null}
            </div>

            <h4 className="connector__subtitle" id="intake-summary-heading">
              Generated summary
            </h4>
            {detail.idea.summary === null ? (
              <p className="state-line" role="status" data-state="empty">
                No summary has been generated. The request above is the only description of what you asked for.
              </p>
            ) : (
              <div className="detail-list">
                <div className="detail-list__row">
                  <dt>Summary</dt>
                  <dd data-testid="generated-summary">{detail.idea.summary.text}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Generated by</dt>
                  <dd>
                    {detail.idea.summary.generatedBy} at {formatTimestamp(detail.idea.summary.generatedAt)}
                  </dd>
                </div>
                <div className="detail-list__row">
                  <dt>Derived from request</dt>
                  <dd>{detail.idea.summary.rawRequestFingerprint}</dd>
                </div>
              </div>
            )}

            <h4 className="connector__subtitle" id="intake-attachments-heading">
              Attachments
            </h4>
            {detail.idea.attachments.length === 0 ? (
              <p className="state-line" role="status" data-state="empty">
                No file is attached to this request.
              </p>
            ) : (
              <ul className="capability-list">
                {detail.idea.attachments.map((entry) => (
                  <li className="capability-list__item" key={entry.name}>
                    {entry.name} ({entry.mediaType}, {entry.byteSize} bytes, added{' '}
                    {formatTimestamp(entry.addedAt)})
                  </li>
                ))}
              </ul>
            )}

            <h4 className="connector__subtitle" id="intake-record-summary-title">
              Record a generated summary
            </h4>
            <p className="panel__note">
              A summary is recorded beside the request and never in place of it, so both stay readable.
            </p>
            <p
              className={summaryState === 'refused' ? 'state-line state-line--error' : 'state-line'}
              role={summaryState === 'refused' ? 'alert' : 'status'}
              aria-live={summaryState === 'refused' ? 'assertive' : 'polite'}
              data-state={summaryState}
            >
              {summaryState === 'saving'
                ? 'Recording the summary…'
                : (summaryMessage ?? 'No summary has been recorded from this form.')}
            </p>
            <form className="form form--grid" noValidate onSubmit={(event) => void submitSummary(event)}>
              <TextArea
                id="intake-summary-text"
                label="Generated summary"
                value={summary.text}
                onChange={(value) => setSummary((previous) => ({ ...previous, text: value }))}
                error={summaryErrors['text']}
                disabled={summaryState === 'saving'}
                required
                rows={3}
              />
              <div className="field">
                <label className="field__label" htmlFor="intake-summary-by">
                  Generated by
                </label>
                <input
                  className="field__input"
                  id="intake-summary-by"
                  name="intake-summary-by"
                  type="text"
                  value={summary.generatedBy}
                  aria-required="true"
                  aria-invalid={summaryErrors['generatedBy'] === undefined ? undefined : 'true'}
                  aria-describedby={
                    summaryErrors['generatedBy'] === undefined ? undefined : 'intake-summary-by-error'
                  }
                  disabled={summaryState === 'saving'}
                  onChange={(event) => setSummary((previous) => ({ ...previous, generatedBy: event.target.value }))}
                />
                {summaryErrors['generatedBy'] === undefined ? null : (
                  <p className="field__error" id="intake-summary-by-error">
                    <span className="field__error-mark" aria-hidden="true" />
                    Error: {summaryErrors['generatedBy']}
                  </p>
                )}
              </div>
              <div className="form__actions">
                <button className="button button--secondary" type="submit" disabled={summaryState === 'saving'}>
                  {summaryState === 'saving' ? 'Recording…' : 'Record summary'}
                </button>
              </div>
            </form>

            <h4 className="connector__subtitle" id="intake-attach-title">
              Attach a named file
            </h4>
            <p className="panel__note">
              Attachments are named files under the artifact root. A name that could escape it is refused.
            </p>
            <p
              className={attachmentState === 'refused' ? 'state-line state-line--error' : 'state-line'}
              role={attachmentState === 'refused' ? 'alert' : 'status'}
              aria-live={attachmentState === 'refused' ? 'assertive' : 'polite'}
              data-state={attachmentState}
            >
              {attachmentState === 'saving'
                ? 'Writing the attachment…'
                : (attachmentMessage ?? 'No attachment has been added from this form.')}
            </p>
            <form className="form form--grid" noValidate onSubmit={(event) => void submitAttachment(event)}>
              <div className="field">
                <label className="field__label" htmlFor="intake-attachment-name">
                  File name
                </label>
                <input
                  className="field__input"
                  id="intake-attachment-name"
                  name="intake-attachment-name"
                  type="text"
                  value={attachment.name}
                  aria-required="true"
                  aria-invalid={attachmentErrors['name'] === undefined ? undefined : 'true'}
                  aria-describedby={
                    attachmentErrors['name'] === undefined ? 'intake-attachment-name-hint' : 'intake-attachment-name-error'
                  }
                  disabled={attachmentState === 'saving'}
                  onChange={(event) => setAttachment((previous) => ({ ...previous, name: event.target.value }))}
                />
                <p className="field__hint" id="intake-attachment-name-hint">
                  A plain file name, with no path separator.
                </p>
                {attachmentErrors['name'] === undefined ? null : (
                  <p className="field__error" id="intake-attachment-name-error">
                    <span className="field__error-mark" aria-hidden="true" />
                    Error: {attachmentErrors['name']}
                  </p>
                )}
              </div>
              <div className="field">
                <label className="field__label" htmlFor="intake-attachment-type">
                  Media type
                </label>
                <select
                  className="field__input"
                  id="intake-attachment-type"
                  name="intake-attachment-type"
                  value={attachment.mediaType}
                  disabled={attachmentState === 'saving'}
                  onChange={(event) => setAttachment((previous) => ({ ...previous, mediaType: event.target.value }))}
                >
                  <option value="text/plain">text/plain</option>
                  <option value="image/png">image/png</option>
                  <option value="image/jpeg">image/jpeg</option>
                </select>
              </div>
              <TextArea
                id="intake-attachment-content"
                label="File content"
                value={attachment.content}
                onChange={(value) => setAttachment((previous) => ({ ...previous, content: value }))}
                hint="Written to the file as given. It is not stored inside the request."
                error={attachmentErrors['content']}
                disabled={attachmentState === 'saving'}
                required
                rows={3}
              />
              <div className="form__actions">
                <button className="button button--secondary" type="submit" disabled={attachmentState === 'saving'}>
                  {attachmentState === 'saving' ? 'Attaching…' : 'Attach file'}
                </button>
              </div>
            </form>

            <h4 className="connector__subtitle" id="intake-related-title">
              Possibly-related work
            </h4>
            <p className="panel__note">
              Resemblance is shown before anything is published. Nothing is merged automatically: link, extend or create a
              new issue is your decision to make explicitly.
            </p>
            <p
              className={relatedView === 'error' ? 'state-line state-line--error' : 'state-line'}
              role={relatedView === 'error' ? 'alert' : 'status'}
              aria-live={relatedView === 'error' ? 'assertive' : 'polite'}
              data-state={relatedView}
            >
              {relatedText}
            </p>
            {relatedMessage === null ? null : (
              <p className="state-line" role="status" data-state="done">
                {relatedMessage}
              </p>
            )}
            <div className="form__actions">
              <button className="button button--secondary" type="button" onClick={() => void searchRelated()}>
                Check for related work
              </button>
            </div>

            {(related ?? []).length === 0 ? null : (
              <ul className="connector-list">
                {(related ?? []).map((report) => (
                  <li className="panel connector" key={report.candidateIdeaId}>
                    <div className="connector__header">
                      <h5 className="panel__title">Possibly related: {report.candidateIdeaId}</h5>
                      <StatusBadge
                        tone="neutral"
                        label={`Score ${report.score.toFixed(2)}`}
                        detail={`Reasons: ${report.reasons.join(', ')}`}
                      />
                    </div>
                    <p className="panel__note">
                      Merging is not offered and cannot happen from this screen. Choose what should happen, or do
                      nothing.
                    </p>
                    <div className="form__actions">
                      {report.ownerChoices.map((choice) => (
                        <button
                          className="button button--secondary"
                          type="button"
                          key={choice}
                          onClick={() => void choose(report.candidateIdeaId, choice)}
                        >
                          {CHOICE_LABELS[choice]}
                        </button>
                      ))}
                    </div>
                    {choiceOutcomes[report.candidateIdeaId] === undefined ? null : (
                      <p className="state-line" role="status" data-state="done">
                        {choiceOutcomes[report.candidateIdeaId]}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <h4 className="connector__subtitle" id="intake-disposition-title">
              Archive or defer
            </h4>
            <p className="panel__note">
              Archiving sets this request aside. It creates no ticket and consumes no coding run, and it is refused once a
              request has produced work.
            </p>
            <p
              className={dispositionState === 'refused' ? 'state-line state-line--error' : 'state-line'}
              role={dispositionState === 'refused' ? 'alert' : 'status'}
              aria-live={dispositionState === 'refused' ? 'assertive' : 'polite'}
              data-state={dispositionState}
            >
              {dispositionState === 'saving'
                ? 'Recording the disposition…'
                : (dispositionMessage ?? 'This request has not been archived or deferred from this form.')}
            </p>
            <div className="form__actions">
              {confirmingArchive ? (
                <>
                  <button
                    className="button button--danger"
                    type="button"
                    disabled={dispositionState === 'saving'}
                    onClick={() => void archive()}
                  >
                    Confirm archiving this request
                  </button>
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={dispositionState === 'saving'}
                    onClick={() => setConfirmingArchive(false)}
                  >
                    Keep this request open
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="button button--danger"
                    type="button"
                    disabled={detail.idea.disposition === 'Archived' || dispositionState === 'saving'}
                    onClick={() => setConfirmingArchive(true)}
                  >
                    {detail.idea.disposition === 'Archived' ? 'Already archived' : 'Archive this request'}
                  </button>
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={detail.idea.disposition === 'Archived' || dispositionState === 'saving'}
                    onClick={() => void defer()}
                  >
                    Defer without publishing
                  </button>
                </>
              )}
            </div>

            <h4 className="connector__subtitle" id="intake-export-title">
              Export
            </h4>
            <p
              className={exportState === 'refused' ? 'state-line state-line--error' : 'state-line'}
              role={exportState === 'refused' ? 'alert' : 'status'}
              aria-live={exportState === 'refused' ? 'assertive' : 'polite'}
              data-state={exportState}
            >
              {exportState === 'saving'
                ? 'Producing the export…'
                : (exportText ?? 'No export has been produced from this form.')}
            </p>
            <div className="form__actions">
              <button className="button button--secondary" type="button" disabled={exportState === 'saving'} onClick={() => void runExport()}>
                {exportState === 'saving' ? 'Exporting…' : 'Export this request'}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="intake-questions-title">
        <h3 className="panel__title" id="intake-questions-title">
          Questions and conversation
        </h3>
        <p className="panel__note">
          Clarification happens on the brief screen. The conversation recorded here is the owner&apos;s own words, in order.
        </p>
        {detail === null ? (
          <p className="state-line" role="status" data-state="empty">
            Choose a captured request to see its conversation.
          </p>
        ) : (
          <>
            <p className="state-line" role="status" data-state={detail.turns.length === 0 ? 'empty' : 'ready'}>
              {detail.turns.length === 0
                ? 'No conversation has been recorded for this request.'
                : `${detail.turns.length} conversation ${detail.turns.length === 1 ? 'turn' : 'turns'}, in order.`}
            </p>
            {detail.turns.length === 0 ? null : (
              <ol className="capability-list">
                {detail.turns.map((turn, index) => (
                  <li className="capability-list__item" key={`${turn.at}-${index}`}>
                    <strong>{turn.kind}</strong> at {formatTimestamp(turn.at)}: {turn.text}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </section>
    </section>
  );
}

function blankOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

