import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  editPlan,
  fetchPlanReadiness,
  fieldMessages,
  fetchPlansForIdea,
  formatTimestamp,
  type Plan,
  type PlanEditRequest,
  type PlanTask,
  type PlanTaskReadiness,
  type ReadinessAssessment,
} from '../api-client.ts';
import { StatusBadge, type StatusTone } from '../components/StatusBadge.tsx';

export interface PlanPageProps {
  readonly ideaId: string;
  readonly onOpenPublication: (planId: string) => void;
  readonly epoch: number;
}

type ViewState = 'loading' | 'empty' | 'ready' | 'error';

type EditState = 'idle' | 'saving' | 'done' | 'refused';

const ACCEPTANCE_TONES: Readonly<Record<PlanTask['acceptance'], StatusTone>> = {
  Proposed: 'pending',
  Accepted: 'healthy',
  Removed: 'neutral',
};

const READINESS_TONES: Readonly<Record<ReadinessAssessment['verdict'], StatusTone>> = {
  Ready: 'healthy',
  NeedsInformation: 'pending',
  Blocked: 'degraded',
};

const AREA_TONES = {
  Satisfied: 'healthy',
  Unmet: 'degraded',
  Unknown: 'pending',
} as const satisfies Readonly<Record<'Satisfied' | 'Unmet' | 'Unknown', StatusTone>>;

function firstStatement(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return text.trim();
}

/**
 * What blocks a task from being declared ready (F08-AC4).
 *
 * Written out rather than shown as a status word, because "not ready" with no reason
 * is a problem report rather than a diagnosis, and a cycle and an unresolved reference
 * need different corrections.
 */
function blockedByText(blockedBy: PlanTaskReadiness['blockedBy']): string {
  return blockedBy
    .map((blocker) =>
      blocker.kind === 'Cycle'
        ? `it is inside the dependency cycle ${blocker.cycle.join(' -> ')}`
        : `it depends on "${blocker.dependsOn}", which this plan no longer has`,
    )
    .join('; ');
}

/**
 * The edit kinds without the revision, which `applyEdit` fills from the plan on screen.
 *
 * Distributed over the union rather than `Omit<PlanEditRequest, 'expectedRevision'>`,
 * because `Omit` over a union collapses it to the members the shared keys leave and
 * `taskId` or `order` would not exist on the result (F08-AC3).
 */
type RevisionlessEdit = PlanEditRequest extends infer Edit
  ? Edit extends PlanEditRequest
    ? Omit<Edit, 'expectedRevision'>
    : never
  : never;

/**
 * The plan, the owner's five edits, and the recorded readiness assessment.
 *
 * Every field F08-AC1 names is on screen per task, and the implementation location is
 * labelled a proposal beside its basis rather than stated as where the change will go:
 * a suggestion rendered as a location is how a reviewer reads an uninspected guess as
 * an inspected fact (F08-AC1, F08-AC5).
 *
 * The five owner edits are the product's, not a convenience (F08-AC3). Accept, remove
 * and reorder are here because publication depends on them; combine and exclude are
 * here because a combine changes what the remaining tasks are and an exclusion is the
 * only way an owner can take an outcome out of scope once its task is gone (F08-AC3,
 * F08-AC5). An unaccepted task's publish control is absent rather than disabled-and-
 * hidden, because the transport reports `publishable` as a fact and a control that
 * looks available but refuses is worse than one that is not offered (F08-AC3).
 *
 * Readiness is rendered as the record it is: every area with its reason, the verdict,
 * and the two permissions as separate sentences. The build control is disabled while a
 * required area is unmet and says which area blocks it, and the investigation control
 * stays available, because being unable to build is exactly when read-only
 * investigation is what the product permits (F09-AC1, F09-AC2).
 */
export function PlanPage({ ideaId, onOpenPublication, epoch }: PlanPageProps): ReactElement {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planId, setPlanId] = useState('');
  const [viewState, setViewState] = useState<ViewState>('loading');
  const [viewError, setViewError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [assessment, setAssessment] = useState<ReadinessAssessment | null>(null);
  const [assessmentState, setAssessmentState] = useState<ViewState>('loading');
  const [assessmentError, setAssessmentError] = useState<string | null>(null);

  const [editState, setEditState] = useState<EditState>('idle');
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const [editErrors, setEditErrors] = useState<Readonly<Record<string, string>>>({});

  const [combineInto, setCombineInto] = useState('');
  const [combineFrom, setCombineFrom] = useState('');
  const [excludeOutcome, setExcludeOutcome] = useState('');
  const [excluded, setExcluded] = useState('');
  const [exclusionReason, setExclusionReason] = useState('');

  const refresh = useCallback((): void => {
    setReload((count) => count + 1);
  }, []);

  /**
   * The newest plan for this request, chosen once.
   *
   * A request can carry several plans and the browser opened one, so the newest
   * revision is the one an owner reviewing the request is looking at; older ones stay
   * reachable by asking for their own address (F08-AC3).
   */
  useEffect(() => {
    if (ideaId === '') {
      setPlan(null);
      setViewState('empty');
      return;
    }
    let current = true;
    setViewState('loading');
    void fetchPlansForIdea(ideaId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setPlan(null);
        setViewError(result.error.reason);
        setViewState('error');
        return;
      }
      const newest = result.value.plans[0] ?? null;
      setPlan(newest);
      setPlanId(newest === null ? '' : newest.planId);
      setViewError(null);
      setViewState(newest === null ? 'empty' : 'ready');
    });
    return () => {
      current = false;
    };
  }, [ideaId, epoch, reload]);

  useEffect(() => {
    if (planId === '') {
      setAssessment(null);
      setAssessmentState('empty');
      return;
    }
    let current = true;
    setAssessmentState('loading');
    void fetchPlanReadiness(planId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setAssessment(null);
        setAssessmentError(result.error.reason);
        setAssessmentState('error');
        return;
      }
      setAssessment(result.value.assessment);
      setAssessmentError(null);
      setAssessmentState('ready');
    });
    return () => {
      current = false;
    };
  }, [planId, epoch, reload]);

  /**
   * Applies one owner edit and shows what it did.
   *
   * The revision travels with the edit because the domain refuses an edit made against
   * a plan the owner no longer sees, and a refusal here says so rather than retrying
   * against the newer revision (F08-AC3).
   */
  const applyEdit = async (edit: RevisionlessEdit, describe: (next: Plan) => string): Promise<void> => {
    if (plan === null || editState === 'saving') return;
    setEditState('saving');
    setEditMessage(null);
    const result = await editPlan(plan.planId, { ...edit, expectedRevision: plan.revision } as PlanEditRequest);
    if (!result.ok) {
      setEditErrors(fieldMessages(result.error));
      setEditMessage(result.error.reason);
      setEditState('refused');
      return;
    }
    setEditErrors({});
    setEditMessage(describe(result.value.plan));
    setEditState('done');
    refresh();
  };

  const accept = (task: PlanTask): Promise<void> =>
    applyEdit({ kind: 'Accept', taskId: task.taskId }, (next) =>
      `"${firstStatement(task.outcome)}" is accepted on revision ${next.revision}. Only accepted proposals can be published (F08-AC3).`,
    );

  const remove = (task: PlanTask): Promise<void> =>
    applyEdit({ kind: 'Remove', taskId: task.taskId }, (next) =>
      `"${firstStatement(task.outcome)}" was removed on revision ${next.revision}. It is kept as a record and has no publishable form (F08-AC3).`,
    );

  /**
   * Moves a task one place earlier or later in the sequence the owner agreed.
   *
   * The order sent is the agreed sequence rather than the dependency order, because a
   * reorder is the owner choosing a sequence and `editPlan` refuses an order that is not
   * a permutation of the active tasks: showing the dependency order here would make the
   * control a no-op whenever the two disagreed (F08-AC3).
   */
  const move = (taskId: string, offset: -1 | 1): Promise<void> => {
    if (plan === null) return Promise.resolve();
    const order = [...plan.agreedSequence];
    const at = order.indexOf(taskId);
    const to = at + offset;
    if (at < 0 || to < 0 || to >= order.length) return Promise.resolve();
    const displaced = order[to];
    if (displaced === undefined) return Promise.resolve();
    order[to] = taskId;
    order[at] = displaced;
    return applyEdit({ kind: 'Reorder', order }, (next) =>
      `The agreed order is now ${next.agreedSequence.join(' then ')} on revision ${next.revision} (F08-AC3). The dependencies still require ${next.proposedOrder.join(' then ')} (F08-AC4).`,
    );
  };

  const submitCombine = async (): Promise<void> => {
    const from = combineFrom
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (combineInto.trim() === '' || from.length === 0) {
      setEditErrors({
        'edit.intoTaskId':
          combineInto.trim() === '' ? 'Name the task that absorbs the others.' : 'Name at least one task to absorb.',
      });
      setEditMessage('Nothing was combined because the task selection is incomplete (F08-AC3).');
      setEditState('refused');
      return;
    }
    await applyEdit({ kind: 'Combine', intoTaskId: combineInto.trim(), fromTaskIds: from }, (next) =>
      `The tasks were combined on revision ${next.revision}. A combined task returns to proposed unless every task in it was already accepted, because the owner has not seen the merged text (F08-AC3).`,
    );
    setCombineInto('');
    setCombineFrom('');
  };

  const submitExclusion = async (): Promise<void> => {
    const outcome = plan?.requestedOutcomes.find((candidate) => candidate.id === excludeOutcome) ?? null;
    if (outcome === null || excluded.trim() === '' || exclusionReason.trim() === '') {
      const local: Record<string, string> = {};
      if (outcome === null) local['edit.outcomeId'] = 'Choose a requested outcome to exclude.';
      if (excluded.trim() === '') local['edit.excluded'] = 'State what is not delivered.';
      if (exclusionReason.trim() === '') local['edit.reason'] = 'State why it is not delivered.';
      setEditErrors(local);
      setEditMessage('No exclusion was recorded because it is incomplete (F08-AC5).');
      setEditState('refused');
      return;
    }
    await applyEdit(
      {
        kind: 'Exclusion',
        outcomeId: outcome.id,
        excluded: excluded.trim(),
        reason: exclusionReason.trim(),
      },
      (next) =>
        `"${outcome.statement}" is recorded as not delivered on revision ${next.revision}, with the reason you gave (F08-AC5).`,
    );
    setExcluded('');
    setExclusionReason('');
  };

  const view: ViewState = viewError !== null ? 'error' : viewState;
  const viewText =
    view === 'error'
      ? `This plan could not be loaded: ${viewError ?? 'unknown reason'}`
      : view === 'empty'
        ? 'No plan has been proposed for this request yet.'
        : view === 'loading'
          ? 'Loading the plan…'
          : 'The proposed plan is loaded. Nothing has been published.';

  const tasks = plan?.tasks ?? [];
  const activeTasks = tasks.filter((task) => task.acceptance !== 'Removed');
  const acceptedCount = tasks.filter((task) => task.acceptance === 'Accepted').length;
  /**
   * The list as the owner agreed it, with anything removed held at the end.
   *
   * A removed proposal keeps no position in the agreed sequence but is not deleted: it
   * is kept so the plan can show that a task depending on removed work has an unresolved
   * dependency (F08-AC3, F08-AC4).
   */
  const agreed = plan?.agreedSequence ?? [];
  const ordered = agreed
    .map((taskId) => tasks.find((task) => task.taskId === taskId))
    .filter((task): task is PlanTask => task !== undefined);
  const heldAtEnd = tasks.filter((task) => task.acceptance === 'Removed' && !agreed.includes(task.taskId));
  const readinessFor = (taskId: string) => plan?.taskReadiness.find((entry) => entry.taskId === taskId) ?? null;

  return (
    <section className="page" aria-labelledby="plan-title">
      <h2 className="page__title" id="plan-title">
        Plan and readiness
      </h2>
      <p
        className={view === 'error' ? 'state-line state-line--error' : 'state-line'}
        role={view === 'error' ? 'alert' : 'status'}
        aria-live={view === 'error' ? 'assertive' : 'polite'}
        data-state={view}
      >
        {viewText}
      </p>

      {plan === null ? null : (
        <>
          <section className="panel" aria-labelledby="plan-summary-title">
            <h3 className="panel__title" id="plan-summary-title">
              The plan
            </h3>
            <div className="detail-list">
              <div className="detail-list__row">
                <dt>Revision</dt>
                <dd data-testid="plan-revision">
                  {plan.revision}
                  {plan.lastEditedAt === null
                    ? ', never edited'
                    : `, last edited by ${plan.lastEditedBy ?? 'an unknown owner'} at ${formatTimestamp(plan.lastEditedAt)}`}
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Tasks</dt>
                <dd data-testid="plan-task-count">
                  {activeTasks.length} proposed, {acceptedCount} accepted, {tasks.length - activeTasks.length} removed
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Why this many tasks</dt>
                <dd data-testid="plan-split-reason">{plan.split.reason}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Agreed order</dt>
                <dd data-testid="plan-order">
                  {agreed.length === 0 ? 'No order: the plan has no active task.' : agreed.join(' then ')}
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Order the dependencies permit</dt>
                <dd data-testid="plan-dependency-order">
                  {(plan?.proposedOrder ?? []).length === 0
                    ? 'No order: the plan has no active task.'
                    : (plan?.proposedOrder ?? []).join(' then ')}
                </dd>
              </div>
            </div>
            <p className="panel__note">
              Accepting a proposal records that you agree to it. It is not delivery and it is not release.
            </p>
          </section>

          <section className="panel" aria-labelledby="plan-outcomes-title">
            <h3 className="panel__title" id="plan-outcomes-title">
              Requested outcomes and how each is covered
            </h3>
            <p className="state-line" role="status" data-state={plan.requestedOutcomes.length === 0 ? 'empty' : 'ready'}>
              {plan.requestedOutcomes.length === 0
                ? 'This plan records no requested outcome.'
                : `${plan.requestedOutcomes.length} requested ${plan.requestedOutcomes.length === 1 ? 'outcome is' : 'outcomes are'} accounted for.`}
            </p>
            <div className="detail-list">
              {plan.requestedOutcomes.map((outcome) => {
                const coverage = plan.coverage.find((entry) => entry.outcomeId === outcome.id) ?? null;
                return (
                  <div className="detail-list__row" key={outcome.id}>
                    <dt>{outcome.statement}</dt>
                    <dd>
                      {coverage === null
                        ? 'No task or exclusion covers this outcome.'
                        : coverage.via === 'Task'
                          ? `Delivered by task ${coverage.taskId ?? ''}.`
                          : `Not delivered: ${coverage.reason ?? 'no reason recorded'}.`}
                    </dd>
                  </div>
                );
              })}
            </div>
            {plan.exclusions.length === 0 ? null : (
              <>
                <h4 className="connector__subtitle">Excluded on purpose</h4>
                <ul className="capability-list">
                  {plan.exclusions.map((exclusion) => (
                    <li className="capability-list__item" key={exclusion.outcomeId}>
                      <strong>{exclusion.excluded}</strong>: not delivered. {exclusion.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="panel" aria-labelledby="plan-tasks-title">
            <h3 className="panel__title" id="plan-tasks-title">
              Proposed tasks
            </h3>
            <p className="state-line" role="status" data-state={ordered.length === 0 ? 'empty' : 'ready'}>
              {ordered.length === 0
                ? 'No task is proposed for this plan.'
                : `${ordered.length} ${ordered.length === 1 ? 'task is' : 'tasks are'} listed in the order you agreed. The order the dependencies permit is stated separately, because a reorder cannot change it (F08-AC3, F08-AC4).`}
            </p>
            {[...ordered, ...heldAtEnd].map((task, position) => {
              const readiness = readinessFor(task.taskId);
              const isRemoved = task.acceptance === 'Removed';
              return (
                <article className="panel connector" key={task.taskId} data-testid={`plan-task-${task.taskId}`}>
                  <div className="connector__header">
                    <h4 className="connector__subtitle">{firstStatement(task.outcome)}</h4>
                    <StatusBadge
                      tone={ACCEPTANCE_TONES[task.acceptance]}
                      label={`Task ${task.acceptance}`}
                      detail={
                        task.acceptance === 'Accepted'
                          ? `Accepted by ${task.acceptedBy ?? 'an unknown owner'} at ${formatTimestamp(task.acceptedAt ?? '')}.`
                          : task.acceptance === 'Removed'
                            ? `Removed by ${task.removedBy ?? 'an unknown owner'} at ${formatTimestamp(task.removedAt ?? '')}.`
                            : 'Proposed, not yet accepted. This task has no publishable form (F08-AC3).'
                      }
                    />
                  </div>
                  <div className="detail-list">
                    <div className="detail-list__row">
                      <dt>Scope</dt>
                      <dd>{task.scope}</dd>
                    </div>
                    <div className="detail-list__row">
                      <dt>Acceptance criteria</dt>
                      <dd>
                        {task.acceptanceCriteria.length === 0
                          ? 'None recorded.'
                          : task.acceptanceCriteria.map((criterion) => (
                              <span key={criterion}>
                                {criterion}
                                <br />
                              </span>
                            ))}
                      </dd>
                    </div>
                    <div className="detail-list__row">
                      <dt>How it will be verified</dt>
                      <dd data-testid={`plan-task-verification-${task.taskId}`}>{task.verificationMethod}</dd>
                    </div>
                    <div className="detail-list__row">
                      <dt>Depends on</dt>
                      <dd data-testid={`plan-task-dependencies-${task.taskId}`}>
                        {task.dependencies.length === 0 ? 'Nothing; this task can go first.' : task.dependencies.join(', ')}
                      </dd>
                    </div>
                    <div className="detail-list__row">
                      <dt>Relevant project context</dt>
                      <dd>
                        {task.relevantProjectContext.length === 0
                          ? 'None recorded.'
                          : task.relevantProjectContext.join('; ')}
                      </dd>
                    </div>
                    <div className="detail-list__row">
                      <dt>Proposed implementation location</dt>
                      <dd data-testid={`plan-task-location-${task.taskId}`}>
                        <StatusBadge
                          tone="pending"
                          label={`${task.implementationLocation.kind} - a proposal, not an inspected location`}
                          detail={`Based on: ${task.implementationLocation.basis}`}
                        />
                        <ul className="capability-list">
                          {task.implementationLocation.candidates.map((candidate) => (
                            <li className="capability-list__item" key={candidate}>
                              {candidate}
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                    {readiness === null ? null : (
                      <div className="detail-list__row">
                        <dt>Can it be declared ready</dt>
                        <dd data-testid={`plan-task-ready-${task.taskId}`}>
                          {readiness.ready ? (
                            <>
                              Ready{readiness.readyAfter.length === 0 ? ' with nothing before it.' : ` after ${readiness.readyAfter.join(', ')}.`}
                            </>
                          ) : (
                            <>Not ready: {blockedByText(readiness.blockedBy)}. (F08-AC4)</>
                          )}
                        </dd>
                      </div>
                    )}
                  </div>
                  <div className="connector__actions">
                    {/*
                      Removing is offered on a Proposed and on an Accepted proposal alike,
                      because acceptance is the owner's decision and the owner is entitled to
                      withdraw it before anything is published. Offering it only before
                      acceptance would mean a wrong acceptance could only be corrected by
                      publishing nothing at all (F08-AC3).
                    */}
                    {task.acceptance === 'Proposed' ? (
                      <button
                        className="button"
                        type="button"
                        disabled={editState === 'saving'}
                        onClick={() => void accept(task)}
                      >
                        {`Accept "${firstStatement(task.outcome)}"`}
                      </button>
                    ) : (
                      <p className="panel__note">
                        {task.acceptance === 'Accepted'
                          ? 'Accepted. This task can be published.'
                          : 'Removed. A removed proposal is kept as a record and is never published (F08-AC3).'}
                      </p>
                    )}
                    {isRemoved ? null : (
                      <button
                        className="button button--secondary"
                        type="button"
                        disabled={editState === 'saving'}
                        onClick={() => void remove(task)}
                      >
                        {`Remove "${firstStatement(task.outcome)}"`}
                      </button>
                    )}
                    {!isRemoved && position > 0 ? (
                      <button
                        className="button button--secondary"
                        type="button"
                        disabled={editState === 'saving'}
                        onClick={() => void move(task.taskId, -1)}
                      >
                        {`Move "${firstStatement(task.outcome)}" earlier`}
                      </button>
                    ) : null}
                    {!isRemoved && position < ordered.length - 1 ? (
                      <button
                        className="button button--secondary"
                        type="button"
                        disabled={editState === 'saving'}
                        onClick={() => void move(task.taskId, 1)}
                      >
                        {`Move "${firstStatement(task.outcome)}" later`}
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
            <p
              className={editState === 'refused' ? 'state-line state-line--error' : 'state-line'}
              role={editState === 'refused' ? 'alert' : 'status'}
              aria-live={editState === 'refused' ? 'assertive' : 'polite'}
              data-state={editState}
            >
              {editState === 'saving' ? 'Recording your edit…' : (editMessage ?? 'No edit has been made from these controls yet.')}
            </p>
          </section>

          <section className="panel" aria-labelledby="plan-combine-title">
            <h3 className="panel__title" id="plan-combine-title">
              Combine two proposals into one
            </h3>
            <p className="panel__note">
              Combining joins the scope and criteria. The merged task returns to proposed unless every task in it was already
              accepted, because you have not seen the merged text yet (F08-AC3).
            </p>
            <form className="form form--grid" noValidate onSubmit={(event) => {
              event.preventDefault();
              void submitCombine();
            }}>
              <div className="field">
                <label className="field__label" htmlFor="plan-combine-into">
                  Task that absorbs the others
                </label>
                <input
                  className="field__input"
                  id="plan-combine-into"
                  name="plan-combine-into"
                  type="text"
                  list="plan-task-ids"
                  value={combineInto}
                  aria-required="true"
                  aria-invalid={editErrors['edit.intoTaskId'] === undefined ? undefined : 'true'}
                  aria-describedby="plan-combine-into-error"
                  disabled={editState === 'saving'}
                  onChange={(event) => setCombineInto(event.target.value)}
                />
                <datalist id="plan-task-ids">
                  {activeTasks.map((task) => (
                    <option key={task.taskId} value={task.taskId} />
                  ))}
                </datalist>
                {editErrors['edit.intoTaskId'] === undefined ? null : (
                  <p className="field__error" id="plan-combine-into-error">
                    <span className="field__error-mark" aria-hidden="true" />
                    Error: {editErrors['edit.intoTaskId']}
                  </p>
                )}
              </div>
              <div className="field">
                <label className="field__label" htmlFor="plan-combine-from">
                  Tasks it absorbs
                </label>
                <input
                  className="field__input"
                  id="plan-combine-from"
                  name="plan-combine-from"
                  type="text"
                  value={combineFrom}
                  aria-required="true"
                  aria-invalid={editErrors['edit.intoTaskId'] === undefined ? undefined : 'true'}
                  aria-describedby="plan-combine-from-hint"
                  disabled={editState === 'saving'}
                  onChange={(event) => setCombineFrom(event.target.value)}
                />
                <p className="field__hint" id="plan-combine-from-hint">
                  Task ids, separated by commas.
                </p>
              </div>
              <div className="form__actions">
                <button className="button" type="submit" disabled={editState === 'saving'}>
                  {editState === 'saving' ? 'Combining…' : 'Combine these proposals'}
                </button>
              </div>
            </form>
          </section>

          <section className="panel" aria-labelledby="plan-exclude-title">
            <h3 className="panel__title" id="plan-exclude-title">
              Take an outcome out of scope
            </h3>
            <p className="panel__note">
              Removing the task that delivered an outcome leaves it covered by nothing. Recording an exclusion says
              explicitly that it is not delivered and why, which is what keeps every requested outcome accounted for
              (F08-AC5).
            </p>
            <form className="form form--grid" noValidate onSubmit={(event) => {
              event.preventDefault();
              void submitExclusion();
            }}>
              <div className="field">
                <label className="field__label" htmlFor="plan-exclude-outcome">
                  Requested outcome
                </label>
                <select
                  className="field__input"
                  id="plan-exclude-outcome"
                  name="plan-exclude-outcome"
                  value={excludeOutcome}
                  aria-required="true"
                  aria-invalid={editErrors['edit.outcomeId'] === undefined ? undefined : 'true'}
                  disabled={editState === 'saving'}
                  onChange={(event) => setExcludeOutcome(event.target.value)}
                >
                  <option value="">Choose an outcome</option>
                  {plan.requestedOutcomes.map((outcome) => (
                    <option key={outcome.id} value={outcome.id}>
                      {outcome.statement}
                    </option>
                  ))}
                </select>
                {editErrors['edit.outcomeId'] === undefined ? null : (
                  <p className="field__error">
                    <span className="field__error-mark" aria-hidden="true" />
                    Error: {editErrors['edit.outcomeId']}
                  </p>
                )}
              </div>
              <div className="field">
                <label className="field__label" htmlFor="plan-excluded">
                  What is not delivered
                </label>
                <input
                  className="field__input"
                  id="plan-excluded"
                  name="plan-excluded"
                  type="text"
                  value={excluded}
                  aria-required="true"
                  aria-invalid={editErrors['edit.excluded'] === undefined ? undefined : 'true'}
                  disabled={editState === 'saving'}
                  onChange={(event) => setExcluded(event.target.value)}
                />
                {editErrors['edit.excluded'] === undefined ? null : (
                  <p className="field__error">
                    <span className="field__error-mark" aria-hidden="true" />
                    Error: {editErrors['edit.excluded']}
                  </p>
                )}
              </div>
              <div className="field">
                <label className="field__label" htmlFor="plan-exclusion-reason">
                  Why it is not delivered
                </label>
                <input
                  className="field__input"
                  id="plan-exclusion-reason"
                  name="plan-exclusion-reason"
                  type="text"
                  value={exclusionReason}
                  aria-required="true"
                  aria-invalid={editErrors['edit.reason'] === undefined ? undefined : 'true'}
                  disabled={editState === 'saving'}
                  onChange={(event) => setExclusionReason(event.target.value)}
                />
                {editErrors['edit.reason'] === undefined ? null : (
                  <p className="field__error">
                    <span className="field__error-mark" aria-hidden="true" />
                    Error: {editErrors['edit.reason']}
                  </p>
                )}
              </div>
              <div className="form__actions">
                <button className="button" type="submit" disabled={editState === 'saving'}>
                  {editState === 'saving' ? 'Recording…' : 'Record this exclusion'}
                </button>
              </div>
            </form>
          </section>

          <section className="panel" aria-labelledby="plan-readiness-title">
            <h3 className="panel__title" id="plan-readiness-title">
              Readiness assessment
            </h3>
            <p
              className={assessmentState === 'error' ? 'state-line state-line--error' : 'state-line'}
              role={assessmentState === 'error' ? 'alert' : 'status'}
              aria-live={assessmentState === 'error' ? 'assertive' : 'polite'}
              data-state={assessmentState}
            >
              {assessmentState === 'error'
                ? `The readiness assessment could not be read: ${assessmentError ?? 'unknown reason'}`
                : assessmentState === 'loading'
                  ? 'Reading the recorded assessment…'
                  : assessmentState === 'empty'
                    ? 'There is no plan to assess yet.'
                    : 'Every area was assessed, whether it is satisfied or not.'}
            </p>
            {assessment === null ? null : (
              <>
                <div className="connector__header">
                  <h4 className="connector__subtitle" data-testid="readiness-verdict">
                    Readiness: {assessment.verdict}
                  </h4>
                  <StatusBadge
                    tone={READINESS_TONES[assessment.verdict]}
                    label={`Assessment ${assessment.verdict}`}
                    detail={`Assessed at ${formatTimestamp(assessment.assessedAt)}`}
                  />
                </div>
                <p className="panel__note">
                  This is a recorded assessment against named prerequisites, not a percentage or a standing flag
                  (F09-AC4).
                </p>
                <div className="detail-list" data-testid="readiness-areas">
                  {assessment.areas.map((area) => (
                    <div className="detail-list__row" key={area.area} data-testid={`readiness-area-${area.area}`}>
                      <dt>{area.area}</dt>
                      <dd>
                        <StatusBadge
                          tone={AREA_TONES[area.status]}
                          label={`${area.area}: ${area.status}`}
                          detail={area.reason}
                        />
                        {area.remedy === null ? null : <p className="panel__note">What you can do: {area.remedy}</p>}
                      </dd>
                    </div>
                  ))}
                </div>
                <div className="connector__actions">
                  <button
                    className="button"
                    type="button"
                    data-testid="readiness-start-build"
                    disabled={!assessment.mayStartBuild}
                    aria-describedby="readiness-build-detail"
                  >
                    {assessment.mayStartBuild ? 'Build may start' : 'Build is disabled'}
                  </button>
                  <button
                    className="button button--secondary"
                    type="button"
                    data-testid="readiness-start-investigation"
                    disabled={!assessment.mayStartInvestigation}
                    aria-describedby="readiness-build-detail"
                  >
                    {assessment.mayStartInvestigation
                      ? 'Read-only investigation may still start'
                      : 'Read-only investigation is not supported for what is open'}
                  </button>
                </div>
                <p className="panel__note" id="readiness-build-detail" data-testid="readiness-build-detail">
                  {assessment.mayStartBuild
                    ? 'Nothing required is missing, so a build may start.'
                    : `A build is disabled because ${assessment.buildBlockingAreas.join(', ')} ${assessment.buildBlockingAreas.length === 1 ? 'is' : 'are'} not satisfied (F09-AC2). ${
                        assessment.mayStartInvestigation
                          ? 'Read-only investigation can still be started to resolve the uncertainty (F09-AC2).'
                          : 'What is open cannot be resolved by investigation, so an operator has to act.'
                      }`}
                </p>
              </>
            )}
            <div className="form__actions">
              <button className="button button--secondary" type="button" onClick={() => onOpenPublication(plan.planId)}>
                Go to publication
              </button>
            </div>
          </section>
        </>
      )}
    </section>
  );
}
