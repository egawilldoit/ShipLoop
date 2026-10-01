/**
 * Runs: start one, watch it, and control it (F13-AC1, F13-AC2, F13-AC3, F17-AC1, F17-AC2,
 * F17-AC3, F17-AC4, F18-AC2, F09-AC1, F09-AC2, F12-AC1, N03-AC1, N03-AC3, F01-AC3).
 *
 * The page is the owner's whole view of one run: what state it is in, the resume point it
 * carries, what it is permitted to do, and the three lifecycle controls. Everything it shows
 * is what the store answered; nothing here decides a state or infers one.
 *
 * Five properties are the reason this page is shaped the way it is:
 *
 *   - **`Paused` is shown only when the writer stopped (F17-AC1).** The badge is derived
 *     from the job's state *and* the writer's own disposition, so a run recorded as Paused
 *     while a writer still holds it reads as "the pause is not confirmed" and names the
 *     holder. A detached writer — one whose lease needs reconciliation — is reported the
 *     same way, because an expired lease proves heartbeats stopped, not that the process
 *     stopped writing (F17-AC5).
 *   - **A refusal is shown verbatim (F17-AC1, F18-AC2, N03-AC3).** Every control reports the
 *     server's own message, because "that did not work" and "this run is Queued, and only a
 *     Running attempt may be paused" are different facts and the owner acts on the second one.
 *   - **A failed save keeps what was typed (N03-AC3).** The form state is only reset on a
 *     success, so a refusal costs no retyping and the input that was rejected still shows
 *     what the owner wrote next to the message that rejected it.
 *   - **Status is a word, a shape and a tone, never a colour alone (N03-AC1).** Every state
 *     renders through `StatusBadge`, which draws a different mark and border per tone, so
 *     the page survives greyscale and colour-blindness.
 *   - **The page never scrolls sideways (F01-AC3).** Long commit SHAs, file inventories and
 *     refusal messages all wrap rather than widen the layout, and the run list is a list of
 *     blocks rather than a table.
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import {
  cancelRun,
  decideRunExtension,
  fetchRun,
  fetchRuns,
  fieldMessages,
  formatRelativeTime,
  formatTimestamp,
  pauseRun,
  resumeRun,
  startRun,
  type ApiFailure,
  type CancelledRunView,
  type PausedRunView,
  type ResumedRunView,
  type RunJob,
  type RunMode,
  type RunView,
  type RunWriter,
} from '../api-client.ts';
import { Field } from '../components/Field.tsx';
import { StatusBadge, type StatusTone } from '../components/StatusBadge.tsx';

export interface RunPageProps {
  readonly selectedJobId: string;
  readonly onSelectJob: (jobId: string) => void;
  readonly onOpenReviewCard: (jobId: string) => void;
  readonly epoch: number;
}

type FormState = 'idle' | 'saving' | 'done' | 'refused';

type ViewState = 'loading' | 'empty' | 'ready' | 'error';

/** The modes a run may be started in, with the plain-language reading of each (F13-AC3). */
const MODES: readonly { readonly id: RunMode; readonly label: string; readonly meaning: string }[] = [
  { id: 'Plan', label: 'Plan', meaning: 'Read and write plans. No code is pushed.' },
  { id: 'Investigate', label: 'Investigate', meaning: 'Read-only. Nothing is written.' },
  { id: 'Build', label: 'Build', meaning: 'Writes code, runs checks and collects evidence.' },
  { id: 'Test', label: 'Test', meaning: 'Runs checks and collects evidence. No branch is pushed.' },
  { id: 'Review', label: 'Review', meaning: 'Reads the work and collects evidence.' },
];

/**
 * The six prerequisites a start collects (F09-AC1).
 *
 * The area names are the domain's, because the recorded assessment and the reason a refusal
 * quotes both use them; a client-side synonym would make the two disagree. Dependencies are
 * absent on purpose: this slice references none, and dependency planning is a planning
 * concern rather than something a start form decides (F08-AC4).
 */
const READINESS_AREAS = [
  { key: 'scope', label: 'Scope', question: 'The scope of this work is settled and I have read it.' },
  { key: 'criteria', label: 'Criteria', question: 'The acceptance criteria are settled and testable.' },
  { key: 'repository', label: 'Repository', question: 'The repository this work touches is the right one.' },
  { key: 'target', label: 'Target', question: 'The branch and environment this work targets are correct.' },
  { key: 'verification', label: 'Verification', question: 'I know how each criterion will be verified.' },
  { key: 'access', label: 'Access', question: 'The access this work needs is in place.' },
] as const;

type AreaKey = (typeof READINESS_AREAS)[number]['key'];

type ReadinessDraft = Readonly<Record<AreaKey, { readonly confirmed: boolean; readonly note: string }>>;

const EMPTY_READINESS: ReadinessDraft = {
  scope: { confirmed: false, note: '' },
  criteria: { confirmed: false, note: '' },
  repository: { confirmed: false, note: '' },
  target: { confirmed: false, note: '' },
  verification: { confirmed: false, note: '' },
  access: { confirmed: false, note: '' },
};

interface CriterionDraft {
  readonly id: string;
  readonly text: string;
}

interface StartDraft {
  readonly workItemId: string;
  readonly mode: RunMode;
  readonly operationId: string;
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly description: string;
  readonly criteria: readonly CriterionDraft[];
}

const EMPTY_START: StartDraft = {
  workItemId: '',
  mode: 'Build',
  operationId: '',
  issueId: '',
  issueIdentifier: '',
  title: '',
  description: '',
  criteria: [{ id: 'AC1', text: '' }],
};

/** A run state, as a word, a tone and the sentence that says what it means (N03-AC1). */
const RUN_STATE_TONES: Readonly<Record<string, StatusTone>> = {
  Queued: 'pending',
  Preparing: 'pending',
  Running: 'healthy',
  Verifying: 'healthy',
  WaitingForOwner: 'degraded',
  Paused: 'neutral',
  Blocked: 'revoked',
  Completed: 'healthy',
  Cancelled: 'unconfigured',
};

const RUN_STATE_MEANING: Readonly<Record<string, string>> = {
  Queued: 'Recorded and waiting for the coding worker to claim it. No writer holds it.',
  Preparing: 'A writer has claimed this run and is preparing a workspace.',
  Running: 'A writer is working on it now.',
  Verifying: 'The work is done and its checks are being collected.',
  WaitingForOwner: 'It reached a limit and is waiting for your decision.',
  Paused: 'Paused, and no writer holds it.',
  Blocked: 'Blocked. The recorded blocker says what has to be resolved.',
  Completed: 'The attempt finished. Acceptance is a separate decision.',
  Cancelled: 'Cancelled. The work that had been done was kept.',
};

function stateTone(state: string): StatusTone {
  return RUN_STATE_TONES[state] ?? 'neutral';
}

function stateMeaning(state: string): string {
  return RUN_STATE_MEANING[state] ?? 'No state is recorded for this run.';
}

/**
 * What the writer's own disposition permits this page to claim (F17-AC1, F17-AC5).
 *
 * `Vacant` and `Unleased` are the two answers that mean no writer is attached.
 * `ReconciliationRequired` is deliberately not one of them: the lease expired, which proves
 * heartbeats stopped, not that the process stopped writing, so a writer in that disposition
 * is reported as one that may still be running.
 */
function writerRead(writer: RunWriter): { readonly stopped: boolean; readonly text: string } {
  const holder = writer.holder === null ? 'a writer' : writer.holder;
  switch (writer.disposition) {
    case 'Vacant':
      return { stopped: true, text: 'No writer holds this run: the lease is released or its holder confirmed stopped.' };
    case 'Unleased':
      return {
        stopped: true,
        text:
          writer.holder === null
            ? 'No writer lease is recorded for this run.'
            : `No writer lease is recorded, although ${holder} is still named on the run.`,
      };
    case 'Held':
      return { stopped: false, text: `${holder} holds this run until ${writer.expiresAt ?? 'its lease ends'}.` };
    case 'ReconciliationRequired':
      return {
        stopped: false,
        text: `${holder} is detached: ${writer.reconciliationReason ?? 'its lease needs reconciliation'}, so that process may still be writing code (F17-AC5).`,
      };
  }
}

/**
 * The lifecycle badge, which may decline to say `Paused` (F17-AC1).
 *
 * A run recorded as Paused while a writer is still attached gets a badge that says so. The
 * alternative — showing the stored state as though the pause were complete — is how an owner
 * reads a paused run as one that is provably not writing code when it may be.
 */
function runBadge(job: RunJob, writer: RunWriter | null, paused: PausedRunView | null): ReactElement {
  const reading = writer === null ? null : writerRead(writer);
  const confirmed = paused !== null ? paused.writerStopped : (reading?.stopped ?? true);
  const state = job.state;
  const uncertainPause = state === 'Paused' && !confirmed;
  const label = uncertainPause ? 'Paused, writer not confirmed stopped' : `Run state: ${state}`;
  const detail = uncertainPause ? (reading?.text ?? stateMeaning(state)) : stateMeaning(state);
  return <StatusBadge tone={stateTone(state)} label={label} detail={detail} />;
}

function blank(value: string | null): string {
  return value ?? '';
}

function orNone(values: readonly string[]): string {
  return values.length === 0 ? 'none recorded' : values.join(', ');
}

/**
 * A paragraph control with the same labelling and error wiring as `Field` (N03-AC1, N03-AC3).
 *
 * `Field` renders an input because that is what most controls need; a scope description and
 * a criterion are paragraphs, and a control whose content is a paragraph still needs a
 * programmatically associated label and a place for its own message.
 */
function TextArea({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  disabled,
  rows = 3,
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
        aria-required={required === true ? 'true' : undefined}
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

export function RunPage({ selectedJobId, onSelectJob, onOpenReviewCard, epoch }: RunPageProps): ReactElement {
  const [runs, setRuns] = useState<readonly RunJob[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [draft, setDraft] = useState<StartDraft>(EMPTY_START);
  const [readiness, setReadiness] = useState<ReadinessDraft>(EMPTY_READINESS);
  const [formErrors, setFormErrors] = useState<Readonly<Record<string, string>>>({});
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [formState, setFormState] = useState<FormState>('idle');

  const [run, setRun] = useState<RunView | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runState, setRunState] = useState<ViewState>('loading');
  const [paused, setPaused] = useState<PausedRunView | null>(null);
  const [controlMessage, setControlMessage] = useState<string | null>(null);
  const [controlDetail, setControlDetail] = useState<readonly string[]>([]);
  const [controlState, setControlState] = useState<FormState>('idle');

  const refresh = useCallback((): void => {
    setReload((count) => count + 1);
  }, []);

  useEffect(() => {
    let current = true;
    void fetchRuns().then((result) => {
      if (!current) return;
      if (result.ok) {
        setRuns(result.value.runs);
        setListError(null);
        return;
      }
      setRuns(null);
      setListError(result.error.reason);
    });
    return () => {
      current = false;
    };
  }, [epoch, reload]);

  useEffect(() => {
    if (selectedJobId === '') {
      setRun(null);
      setPaused(null);
      setRunState('empty');
      return;
    }
    let current = true;
    setRunState('loading');
    setPaused(null);
    void fetchRun(selectedJobId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setRun(null);
        setRunError(result.error.reason);
        setRunState('error');
        return;
      }
      setRun(result.value.run);
      setRunError(null);
      setRunState('ready');
    });
    return () => {
      current = false;
    };
  }, [selectedJobId, reload]);

  const patch = <K extends keyof StartDraft>(key: K, value: StartDraft[K]): void => {
    setDraft((previous) => ({ ...previous, [key]: value }));
  };

  const patchCriterion = (index: number, key: keyof CriterionDraft, value: string): void => {
    setDraft((previous) => ({
      ...previous,
      criteria: previous.criteria.map((criterion, position) =>
        position === index ? { ...criterion, [key]: value } : criterion,
      ),
    }));
  };

  const submitStart = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (formState === 'saving') return;

    const local: Record<string, string> = {};
    if (draft.workItemId.trim() === '') local['workItemId'] = 'Name the work item this run works on.';
    if (draft.operationId.trim() === '') {
      local['operationId'] =
        'Give this Start a stable identity. Pressing Start again with the same identity returns the one run instead of starting a second.';
    }
    if (draft.issueId.trim() === '') local['scope.issueId'] = 'Name the issue this run works on.';
    if (draft.issueIdentifier.trim() === '') local['scope.issueIdentifier'] = 'Name the issue as its provider labels it.';
    if (draft.title.trim() === '') local['scope.title'] = 'The run needs a title.';
    if (draft.description.trim() === '') local['scope.description'] = 'The run needs the scope text.';
    if (draft.criteria.length === 0) {
      local['scope.acceptanceCriteria'] = 'A run records at least one acceptance criterion.';
    } else {
      draft.criteria.forEach((criterion, index) => {
        if (criterion.id.trim() === '') local[`scope.acceptanceCriteria.${index}.id`] = 'A criterion needs a stable id.';
        if (criterion.text.trim() === '') local[`scope.acceptanceCriteria.${index}.text`] = 'A criterion needs text.';
      });
    }
    if (Object.keys(local).length > 0) {
      setFormErrors(local);
      setFormMessage('The run was not started because some fields need attention.');
      setFormState('refused');
      return;
    }

    setFormState('saving');
    setFormMessage(null);
    const result = await startRun({
      workItemId: draft.workItemId.trim(),
      mode: draft.mode,
      operationId: draft.operationId.trim(),
      correlationId: null,
      scope: {
        issueId: draft.issueId.trim(),
        issueIdentifier: draft.issueIdentifier.trim(),
        title: draft.title.trim(),
        description: draft.description.trim(),
        providerRevision: null,
        priority: null,
        dependencyIssueIds: [],
        acceptanceCriteria: draft.criteria.map((criterion) => ({ id: criterion.id.trim(), text: criterion.text.trim() })),
      },
      readiness: {
        scope: toArea(readiness.scope),
        criteria: toArea(readiness.criteria),
        repository: toArea(readiness.repository),
        target: toArea(readiness.target),
        verification: toArea(readiness.verification),
        access: toArea(readiness.access),
      },
    });
    if (!result.ok) {
      const failure: ApiFailure = result.error;
      setFormErrors(fieldMessages(failure));
      setFormMessage(failure.reason);
      setFormState('refused');
      return;
    }
    setFormErrors({});
    setFormMessage(result.value.message);
    setFormState('done');
    onSelectJob(result.value.run.job.jobId);
    refresh();
  };

  /**
   * A refused control, with everything the server said.
   *
   * The reason and the per-field messages are both kept because they answer different
   * questions: the reason says which move was refused, and an `Invalid` refusal's field
   * message carries what the run may do instead ("From Queued the reachable states are:
   * Preparing, Cancelled, Blocked"). Dropping the second would leave the owner with a refusal
   * and no next step (N03-AC3, F17-AC1).
   */
  const refuseControl = (action: string, failure: ApiFailure): void => {
    setControlMessage(`This run was not ${action}: ${failure.reason}`);
    setControlDetail(failure.fields.map((field) => field.message));
    setControlState('refused');
  };

  /**
   * One control, one answer.
   *
   * Each branch keeps its own typed result rather than merging three different response
   * shapes into one union, because what each says is different: a pause reports whether the
   * writer stopped, a resume reports the resume point it continued from, and a cancellation
   * reports what survived (F17-AC1, F17-AC3, F17-AC4).
   */
  const control = async (action: 'pause' | 'resume' | 'cancel', jobId: string): Promise<void> => {
    if (controlState === 'saving') return;
    setControlState('saving');
    setControlMessage(null);

    setControlDetail([]);

    if (action === 'pause') {
      const result = await pauseRun(jobId);
      if (!result.ok) {
        refuseControl('paused', result.error);
        return;
      }
      setPaused(result.value.run);
      setControlMessage(pausedMessage(result.value.run));
      setControlState('done');
      refresh();
      return;
    }

    if (action === 'resume') {
      const result = await resumeRun(jobId);
      if (!result.ok) {
        refuseControl('resumed', result.error);
        return;
      }
      setControlMessage(resumedMessage(result.value.run));
      setControlState('done');
      refresh();
      return;
    }

    const result = await cancelRun(jobId);
    if (!result.ok) {
      refuseControl('cancelled', result.error);
      return;
    }
    setControlMessage(cancelledMessage(result.value.run));
    setControlState('done');
    refresh();
  };

  const decide = async (decision: 'Grant' | 'Decline', jobId: string): Promise<void> => {
    if (controlState === 'saving') return;
    setControlState('saving');
    setControlMessage(null);
    setControlDetail([]);
    const result = await decideRunExtension(jobId, decision);
    if (!result.ok) {
      refuseControl('recorded', {
        ...result.error,
        reason: `Your decision was not recorded: ${result.error.reason}`,
      });
      return;
    }
    const outcome = result.value.extension;
    setControlMessage(
      decision === 'Grant'
        ? `Extension granted. The active budget went from ${formatMs(outcome.previousLimits?.activeExecutionMs ?? 0)} to ${formatMs(outcome.extendedLimits?.activeExecutionMs ?? 0)}, and the extended bound is not recorded on the run, so it is lost if this process restarts (F18-AC2).`
        : `Extension declined. The run stays ${outcome.job.state} and its bound is unchanged at ${formatMs(outcome.limitsInForce?.activeExecutionMs ?? 0)} (F18-AC2).`,
    );
    setControlState('done');
    refresh();
  };

  const known = runs ?? [];
  const nowMs = Date.now();

  const listView: ViewState =
    listError !== null ? 'error' : runs === null ? 'loading' : known.length === 0 ? 'empty' : 'ready';
  const listText =
    listView === 'error'
      ? `The runs could not be loaded: ${listError ?? 'unknown reason'}`
      : listView === 'loading'
        ? 'Loading runs…'
        : listView === 'empty'
          ? 'No run has been started yet.'
          : `${known.length} ${known.length === 1 ? 'run has' : 'runs have'} been started.`;

  const detailView: ViewState = runError !== null ? 'error' : selectedJobId === '' ? 'empty' : runState;
  const detailText =
    detailView === 'error'
      ? `This run could not be loaded: ${runError ?? 'unknown reason'}`
      : detailView === 'empty'
        ? 'Choose a run to see its progress and its controls.'
        : detailView === 'loading'
          ? 'Loading this run…'
          : 'This run is loaded.';

  return (
    <section className="page" aria-labelledby="runs-title">
      <h2 className="page__title" id="runs-title">
        Runs
      </h2>
      <p className="panel__note">
        Starting a run records a durable job the coding worker can claim. It grants no merge or release authority, and a
        pause is only reported complete once no writer holds the run.
      </p>

      <section className="panel" aria-labelledby="run-start-title">
        <h3 className="panel__title" id="run-start-title">
          Start a run
        </h3>
        <p className="panel__note">
          The scope is recorded as written, together with the profile and recipe versions this run is bound to. Pressing
          Start again with the same operation identity returns the run that identity already started.
        </p>
        <p
          className={formState === 'refused' ? 'state-line state-line--error' : 'state-line'}
          role={formState === 'refused' ? 'alert' : 'status'}
          aria-live={formState === 'refused' ? 'assertive' : 'polite'}
          data-state={formState}
          data-testid="run-start-state"
        >
          {formState === 'saving' ? 'Starting the run…' : (formMessage ?? 'Nothing has been started from this form.')}
        </p>
        <form className="form form--grid" noValidate onSubmit={(event) => void submitStart(event)}>
          <Field
            id="run-work-item"
            label="Work item"
            value={draft.workItemId}
            onChange={(value) => patch('workItemId', value)}
            hint="The published work this run works on. Required."
            error={formErrors['workItemId']}
            disabled={formState === 'saving'}
            required
          />
          <Field
            id="run-operation-id"
            label="Operation identity"
            value={draft.operationId}
            onChange={(value) => patch('operationId', value)}
            hint="Stable for this intent. The same identity never starts a second run (F13-AC2)."
            error={formErrors['operationId']}
            disabled={formState === 'saving'}
            required
          />

          <div className="field">
            <label className="field__label" htmlFor="run-mode">
              Mode
            </label>
            <select
              className="field__input"
              id="run-mode"
              name="run-mode"
              value={draft.mode}
              aria-describedby="run-mode-hint"
              disabled={formState === 'saving'}
              onChange={(event) => patch('mode', event.target.value as RunMode)}
            >
              {MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
            <p className="field__hint" id="run-mode-hint">
              {MODES.find((mode) => mode.id === draft.mode)?.meaning ?? ''}
            </p>
            {formErrors['mode'] === undefined ? null : (
              <p className="field__error" id="run-mode-error">
                <span className="field__error-mark" aria-hidden="true" />
                Error: {formErrors['mode']}
              </p>
            )}
          </div>

          <Field
            id="run-issue-id"
            label="Issue id"
            value={draft.issueId}
            onChange={(value) => patch('issueId', value)}
            hint="The provider's own id for the issue. Required."
            error={formErrors['scope.issueId']}
            disabled={formState === 'saving'}
            required
          />
          <Field
            id="run-issue-identifier"
            label="Issue identifier"
            value={draft.issueIdentifier}
            onChange={(value) => patch('issueIdentifier', value)}
            hint="The human label, such as a ticket key. Required."
            error={formErrors['scope.issueIdentifier']}
            disabled={formState === 'saving'}
            required
          />

          <div className="field">
            <label className="field__label" htmlFor="run-title">
              Run title
            </label>
            <input
              className="field__input"
              id="run-title"
              name="run-title"
              type="text"
              value={draft.title}
              aria-required="true"
              aria-invalid={formErrors['scope.title'] === undefined ? undefined : 'true'}
              aria-describedby={formErrors['scope.title'] === undefined ? undefined : 'run-title-error'}
              disabled={formState === 'saving'}
              onChange={(event) => patch('title', event.target.value)}
            />
            {formErrors['scope.title'] === undefined ? null : (
              <p className="field__error" id="run-title-error">
                <span className="field__error-mark" aria-hidden="true" />
                Error: {formErrors['scope.title']}
              </p>
            )}
          </div>

          <TextArea
            id="run-description"
            label="Scope text"
            value={draft.description}
            onChange={(value) => patch('description', value)}
            hint="What this run is being asked to do. Recorded as written. Required."
            error={formErrors['scope.description']}
            disabled={formState === 'saving'}
            rows={4}
            required
          />

          <fieldset className="field" aria-describedby="run-criteria-hint">
            <legend className="field__label">Acceptance criteria</legend>
            <p className="field__hint" id="run-criteria-hint">
              At least one. These become the criteria the review card reports on, so a run with none cannot be reviewed
              (F12-AC1).
            </p>
            {draft.criteria.map((criterion, index) => (
              <div className="form--grid" key={`criterion-${String(index)}`}>
                <Field
                  id={`run-criterion-id-${String(index)}`}
                  label={`Criterion ${String(index + 1)} id`}
                  value={criterion.id}
                  onChange={(value) => patchCriterion(index, 'id', value)}
                  error={formErrors[`scope.acceptanceCriteria.${String(index)}.id`]}
                  disabled={formState === 'saving'}
                  required
                />
                <TextArea
                  id={`run-criterion-text-${String(index)}`}
                  label={`Criterion ${String(index + 1)} text`}
                  value={criterion.text}
                  onChange={(value) => patchCriterion(index, 'text', value)}
                  error={formErrors[`scope.acceptanceCriteria.${String(index)}.text`]}
                  disabled={formState === 'saving'}
                  rows={2}
                  required
                />
              </div>
            ))}
            {formErrors['scope.acceptanceCriteria'] === undefined ? null : (
              <p className="field__error" id="run-criteria-error">
                <span className="field__error-mark" aria-hidden="true" />
                Error: {formErrors['scope.acceptanceCriteria']}
              </p>
            )}
            <div className="form__actions">
              <button
                className="button button--secondary"
                type="button"
                disabled={formState === 'saving'}
                onClick={() =>
                  setDraft((previous) => ({
                    ...previous,
                    criteria: [...previous.criteria, { id: `AC${String(previous.criteria.length + 1)}`, text: '' }],
                  }))
                }
              >
                Add a criterion
              </button>
              {draft.criteria.length > 1 ? (
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={formState === 'saving'}
                  onClick={() =>
                    setDraft((previous) => ({ ...previous, criteria: previous.criteria.slice(0, -1) }))
                  }
                >
                  Remove the last criterion
                </button>
              ) : null}
            </div>
          </fieldset>

          <fieldset className="field" aria-describedby="run-readiness-hint">
            <legend className="field__label">Prerequisites</legend>
            <p className="field__hint" id="run-readiness-hint">
              Each one is recorded as your confirmation, with the reason you give. A prerequisite you have not confirmed
              refuses the start and names itself with what to do about it (F09-AC2).
            </p>
            {READINESS_AREAS.map((area) => {
              const entry = readiness[area.key];
              const noteId = `run-readiness-${area.key}-note`;
              return (
                <div className="field field--check" key={area.key}>
                  <input
                    className="field__input"
                    id={`run-readiness-${area.key}`}
                    name={`run-readiness-${area.key}`}
                    type="checkbox"
                    checked={entry.confirmed}
                    disabled={formState === 'saving'}
                    onChange={(event) =>
                      setReadiness((previous) => ({
                        ...previous,
                        [area.key]: { ...previous[area.key], confirmed: event.target.checked },
                      }))
                    }
                  />
                  <label className="field__label" htmlFor={`run-readiness-${area.key}`}>
                    {area.label}: {area.question}
                  </label>
                  <div className="field">
                    <label className="field__label" htmlFor={noteId}>
                      {area.label} note (optional)
                    </label>
                    <input
                      className="field__input"
                      id={noteId}
                      name={noteId}
                      type="text"
                      value={entry.note}
                      aria-describedby={`${noteId}-hint`}
                      disabled={formState === 'saving'}
                      onChange={(event) =>
                        setReadiness((previous) => ({
                          ...previous,
                          [area.key]: { ...previous[area.key], note: event.target.value },
                        }))
                      }
                    />
                    <p className="field__hint" id={`${noteId}-hint`}>
                      What you checked. Recorded as the reason for this area.
                    </p>
                    {formErrors[`readiness.${area.key}.note`] === undefined ? null : (
                      <p className="field__error" id={`${noteId}-error`}>
                        <span className="field__error-mark" aria-hidden="true" />
                        Error: {formErrors[`readiness.${area.key}.note`]}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </fieldset>

          <div className="form__actions">
            <button className="button" type="submit" disabled={formState === 'saving'}>
              {formState === 'saving' ? 'Starting…' : 'Start this run'}
            </button>
          </div>
        </form>
      </section>

      <section className="panel" aria-labelledby="run-list-title">
        <h3 className="panel__title" id="run-list-title">
          Runs
        </h3>
        <p
          className={listView === 'error' ? 'state-line state-line--error' : 'state-line'}
          role={listView === 'error' ? 'alert' : 'status'}
          aria-live={listView === 'error' ? 'assertive' : 'polite'}
          data-state={listView}
          data-testid="run-list-state"
        >
          {listText}
        </p>

        {known.length === 0 ? null : (
          <ul className="profile-list">
            {known.map((job) => (
              <li className="profile-list__item" key={job.jobId}>
                <span className="profile-list__name">{job.mode} on {job.workItemId}</span>
                <span className="profile-list__detail">
                  Run <code>{job.jobId}</code>, queued{' '}
                  <time dateTime={job.createdAt}>{formatRelativeTime(job.createdAt, nowMs)}</time>
                  {` (${formatTimestamp(job.createdAt)})`}
                </span>
                <StatusBadge tone={stateTone(job.state)} label={`Run state: ${job.state}`} detail={stateMeaning(job.state)} />
                <div className="form__actions">
                  <button
                    className="button button--secondary"
                    type="button"
                    aria-pressed={job.jobId === selectedJobId}
                    onClick={() => onSelectJob(job.jobId)}
                  >
                    {job.jobId === selectedJobId ? 'Selected run' : `Work on this run (${job.state})`}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="run-detail-title">
        <h3 className="panel__title" id="run-detail-title">
          The selected run
        </h3>
        <p
          className={detailView === 'error' ? 'state-line state-line--error' : 'state-line'}
          role={detailView === 'error' ? 'alert' : 'status'}
          aria-live={detailView === 'error' ? 'assertive' : 'polite'}
          data-state={detailView}
        >
          {detailText}
        </p>

        {run === null ? null : (
          <>
            <div className="detail-list">
              <div className="detail-list__row">
                <dt>Run</dt>
                <dd>
                  <code data-testid="run-job-id">{run.job.jobId}</code>
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>State</dt>
                <dd>{runBadge(run.job, run.writer, paused)}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Writer</dt>
                <dd data-testid="run-writer">{writerRead(run.writer).text}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Mode</dt>
                <dd>{run.job.mode}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Work item</dt>
                <dd>{run.job.workItemId}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Operation identity</dt>
                <dd>{run.job.operationId}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Scope snapshot</dt>
                <dd>
                  {run.job.scopeSnapshotId} (sequence is on the review card)
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Profile version</dt>
                <dd>{run.job.profileVersionId}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Recipe version</dt>
                <dd>{run.job.procedureVersionId}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Permitted operations</dt>
                <dd>{orNone(run.job.permittedOperations)}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Refused delivery operations</dt>
                <dd>Merge, Release and RecoveryRedeploy are never granted to a coding run (F13-AC3).</dd>
              </div>
              <div className="detail-list__row">
                <dt>Active execution bound</dt>
                <dd>{formatMs(run.job.limits.activeExecutionMs)}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Automated fix passes</dt>
                <dd>{run.job.limits.maxAutomatedFixPasses}</dd>
              </div>
            </div>

            <p
              className={controlState === 'refused' ? 'state-line state-line--error' : 'state-line'}
              role={controlState === 'refused' ? 'alert' : 'status'}
              aria-live={controlState === 'refused' ? 'assertive' : 'polite'}
              data-state={controlState}
              data-testid="run-control-state"
            >
              {controlState === 'saving'
                ? 'Recording your decision…'
                : (controlMessage ?? 'No control has been used on this run yet.')}
            </p>
            {controlDetail.length === 0 ? null : (
              <ul className="connector__problem" data-testid="run-control-detail">
                {controlDetail.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            )}

            <div className="form__actions">
              <button
                className="button button--secondary"
                type="button"
                disabled={controlState === 'saving'}
                onClick={() => void control('pause', run.job.jobId)}
              >
                Pause this run
              </button>
              <button
                className="button button--secondary"
                type="button"
                disabled={controlState === 'saving'}
                onClick={() => void control('resume', run.job.jobId)}
              >
                Resume this run
              </button>
              <button
                className="button button--danger"
                type="button"
                disabled={controlState === 'saving'}
                onClick={() => void control('cancel', run.job.jobId)}
              >
                Cancel this run
              </button>
              <button
                className="button button--secondary"
                type="button"
                disabled={controlState === 'saving'}
                onClick={() => void decide('Grant', run.job.jobId)}
              >
                Grant an extension
              </button>
              <button
                className="button button--secondary"
                type="button"
                disabled={controlState === 'saving'}
                onClick={() => void decide('Decline', run.job.jobId)}
              >
                Decline an extension
              </button>
              <button
                className="button button--secondary"
                type="button"
                onClick={() => onOpenReviewCard(run.job.jobId)}
              >
                Open the review card
              </button>
            </div>

            <h4 className="connector__subtitle" id="run-checkpoint-title">
              Latest resume point
            </h4>
            {run.checkpoint === null ? (
              <p className="state-line" role="status" data-state="empty">
                No resume point has been recorded for this run. There is nothing to resume from until a writer writes
                one (F17-AC2).
              </p>
            ) : (
              <div className="detail-list" aria-labelledby="run-checkpoint-title">
                <div className="detail-list__row">
                  <dt>Recorded at</dt>
                  <dd>{formatTimestamp(run.checkpoint.recordedAt)}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Scope fingerprint</dt>
                  <dd>{run.checkpoint.scopeFingerprint}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Scope snapshot</dt>
                  <dd>{run.checkpoint.scopeSnapshotId}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Profile version</dt>
                  <dd>{run.checkpoint.profileVersionId}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Recipe version</dt>
                  <dd>{run.checkpoint.procedureVersionId}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Engine version</dt>
                  <dd>{blank(run.checkpoint.engineVersion) || 'No engine version was recorded.'}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Workspace</dt>
                  <dd>
                    {run.checkpoint.workspace.workspaceId} on branch {run.checkpoint.workspace.branchName} at{' '}
                    {run.checkpoint.workspace.worktreePath}
                  </dd>
                </div>
                <div className="detail-list__row">
                  <dt>Head commit</dt>
                  <dd>
                    <code data-testid="run-head-sha">{run.checkpoint.headSha}</code>
                  </dd>
                </div>
                <div className="detail-list__row">
                  <dt>Base commit</dt>
                  <dd>
                    <code data-testid="run-base-sha">{run.checkpoint.baseSha}</code>
                  </dd>
                </div>
                <div className="detail-list__row">
                  <dt>Dirty files</dt>
                  <dd data-testid="run-dirty-files">{orNone(run.checkpoint.dirtyFiles)}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Untracked files</dt>
                  <dd data-testid="run-untracked-files">{orNone(run.checkpoint.untrackedFiles)}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Results at the checkpoint</dt>
                  <dd data-testid="run-results">
                    {run.checkpoint.results.length === 0
                      ? 'No check result was recorded at this checkpoint.'
                      : run.checkpoint.results
                          .map((entry) => `${entry.name}: ${entry.result}${entry.detail === null ? '' : ` (${entry.detail})`}`)
                          .join('; ')}
                  </dd>
                </div>
                <div className="detail-list__row">
                  <dt>Feedback retained</dt>
                  <dd data-testid="run-feedback">
                    {run.checkpoint.feedback.length === 0
                      ? 'No feedback is retained with this checkpoint.'
                      : run.checkpoint.feedback.map((entry) => `${entry.author} at ${formatTimestamp(entry.at)}: ${entry.body}`).join('; ')}
                  </dd>
                </div>
                <div className="detail-list__row">
                  <dt>Blocker</dt>
                  <dd data-testid="run-blocker">{blank(run.checkpoint.blocker) || 'No blocker is recorded.'}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Next action</dt>
                  <dd data-testid="run-next-action">{run.checkpoint.nextAction}</dd>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </section>
  );
}

function toArea(entry: { readonly confirmed: boolean; readonly note: string }): { readonly confirmed: boolean; readonly note: string | null } {
  const note = entry.note.trim();
  return { confirmed: entry.confirmed, note: note === '' ? null : note };
}

/**
 * What each lifecycle control did, in the words the owner needs.
 *
 * Each sentence names the fact that decides whether the move took effect: the writer for a
 * pause (F17-AC1), the resume point a resume continued from (F17-AC3), and the untouched
 * delivery for a cancellation (F17-AC4).
 */
function pausedMessage(run: PausedRunView): string {
  return run.writerStopped
    ? `Paused. No writer holds run ${run.job.jobId}, and its resume point was kept (F17-AC1).`
    : `Pause recorded for run ${run.job.jobId}, but a writer still holds it, so the pause is not confirmed (F17-AC1).`;
}

function resumedMessage(run: ResumedRunView): string {
  return `Resumed from the recorded resume point: head ${run.checkpoint.headSha}, base ${run.checkpoint.baseSha} (F17-AC3).`;
}

function cancelledMessage(run: CancelledRunView): string {
  return `Cancelled. The resume point was ${
    run.preservedCheckpoint === null ? 'not ' : ''
  }kept, and no external delivery was changed by this cancellation (F17-AC4).`;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'no active execution time';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}
