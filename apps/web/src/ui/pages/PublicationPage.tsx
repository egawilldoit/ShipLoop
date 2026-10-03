import { useEffect, useState, type ReactElement } from 'react';
import {
  adoptExistingIssue,
  fetchPlan,
  fetchPlansForIdea,
  fieldMessages,
  linkExistingChange,
  publishPlan,
  requestAdoptedEvaluation,
  type AdoptedEvaluation,
  type AdoptedIssue,
  type LinkedChange,
  type Plan,
  type PlanTask,
  type PublicationReport,
} from '../api-client.ts';
import { StatusBadge, type StatusTone } from '../components/StatusBadge.tsx';

export interface PublicationPageProps {
  /**
   * The plan publication acts on, when one was chosen by navigating from the plan screen.
   *
   * The page fetches the plan itself rather than being handed it, because the accepted
   * proposal count the publish control gates on is a property of the stored plan and not
   * of the caller's memory of it (F10-AC1, F08-AC3).
   */
  readonly planId: string;
  /**
   * The captured request whose plan to fall back on.
   *
   * Without it this screen would be unreachable except as a continuation of the plan
   * screen, and an owner who opened the Publication tab directly would be told there was
   * nothing to publish about a plan they can see on the tab beside it. Publication and
   * the plan are two views of one thing, so either one has to be able to find it
   * (F10-AC1).
   */
  readonly ideaId: string;
  /** The selected project, or null when none is selected (F02-AC1). Adoption needs one. */
  readonly projectId: string | null;
  readonly onBackToPlan: () => void;
  readonly epoch: number;
}

type ActionState = 'idle' | 'working' | 'done' | 'refused';

type ViewState = 'loading' | 'empty' | 'ready' | 'error';

const TICKET_TONES = {
  Published: 'healthy',
  Failed: 'degraded',
  OutcomeUnknown: 'pending',
} as const satisfies Readonly<Record<PublicationReport['tickets'][number]['kind'], StatusTone>>;

/**
 * The publication request id a retry reuses (F10-AC3).
 *
 * Derived from the plan address and the time of the first attempt, and held in state
 * rather than minted per click, because the request boundary is the only place that can
 * present the same identity again: a server-minted id would be new on every attempt,
 * and a new id per attempt is how a retry after a timeout creates a second issue
 * (F10-AC3).
 */
function requestIdFor(planId: string): string {
  return `pub-${planId}-${Date.now().toString(36)}`;
}

/**
 * Publication of an accepted revision, and adoption of work that already exists.
 *
 * Publication is a separate screen reached by an explicit action, because creating an
 * issue at a provider is not a consequence of reviewing a proposal (F10-AC1). The
 * screen offers the publish control only when the plan holds at least one accepted
 * proposal, and the report it renders afterwards is per proposed ticket: a partial
 * failure names what remains unpublished rather than showing a count, because "one
 * ticket is still owed" and "two of three went out" are different facts an owner has to
 * act on differently (F10-AC2). The request id is displayed, because reconciling an
 * unresolved outcome needs it and an owner cannot reconcile an operation they cannot
 * name (F10-AC3, F30-AC5).
 *
 * Adoption is on the same screen because it is the alternative to publication and
 * shares the owner question: this work does not exist yet, or it does. It reads the
 * existing issue and shows its live content with no replacement and no merge control
 * anywhere on the page: a control that could merge would be the wrong affordance for
 * work a person already wrote (F11-AC1, F11-AC3). A wrong-team or ambiguous mapping is
 * refused with the provider's own reason rather than a generic failure, so the owner
 * can tell what to correct (F11-AC3).
 *
 * `Build` is offered on the review request and refused when sent, rather than hidden:
 * an owner who asks for a build must be told that adopted work cannot take one and why
 * that is the safe answer (F11-AC5, F11-AC4).
 */
export function PublicationPage({ planId, ideaId, projectId, onBackToPlan, epoch }: PublicationPageProps): ReactElement {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [resolvedPlanId, setResolvedPlanId] = useState(planId);
  const [planState, setPlanState] = useState<ViewState>('loading');
  const [planError, setPlanError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => requestIdFor(planId));
  const [report, setReport] = useState<PublicationReport | null>(null);
  const [publishState, setPublishState] = useState<ActionState>('idle');
  const [publishMessage, setPublishMessage] = useState<string | null>(null);

  const [issueId, setIssueId] = useState('');
  const [expectedIdentifier, setExpectedIdentifier] = useState('');
  const [adopted, setAdopted] = useState<AdoptedIssue | null>(null);
  const [adoptState, setAdoptState] = useState<ActionState>('idle');
  const [adoptMessage, setAdoptMessage] = useState<string | null>(null);
  const [adoptErrors, setAdoptErrors] = useState<Readonly<Record<string, string>>>({});

  const [repositoryProvider, setRepositoryProvider] = useState('');
  const [repositoryName, setRepositoryName] = useState('');
  const [branch, setBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [linked, setLinked] = useState<LinkedChange | null>(null);
  const [linkState, setLinkState] = useState<ActionState>('idle');
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  const [linkErrors, setLinkErrors] = useState<Readonly<Record<string, string>>>({});

  const [evaluation, setEvaluation] = useState<AdoptedEvaluation | null>(null);
  const [evaluationState, setEvaluationState] = useState<ActionState>('idle');
  const [evaluationMessage, setEvaluationMessage] = useState<string | null>(null);

  /**
   * Resolves which plan this screen is about, then reads it.
   *
   * The given address wins; otherwise the newest plan for the selected request is used.
   * Resolving first and reading second keeps the request id bound to the plan it was
   * minted for, because a request id that changed under a report would reconcile against
   * the wrong operation (F10-AC3).
   */
  useEffect(() => {
    let current = true;
    if (planId !== '') {
      setResolvedPlanId(planId);
      return () => {
        current = false;
      };
    }
    if (ideaId === '') {
      setPlan(null);
      setResolvedPlanId('');
      setPlanState('empty');
      return () => {
        current = false;
      };
    }
    setPlanState('loading');
    void fetchPlansForIdea(ideaId).then((listed) => {
      if (!current) return;
      if (!listed.ok) {
        setPlan(null);
        setPlanError(listed.error.reason);
        setPlanState('error');
        return;
      }
      const newest = listed.value.plans[0] ?? null;
      setResolvedPlanId(newest === null ? '' : newest.planId);
      if (newest !== null) setRequestId(requestIdFor(newest.planId));
      if (newest === null) setPlanState('empty');
    });
    return () => {
      current = false;
    };
  }, [planId, ideaId, epoch]);

  useEffect(() => {
    // A report belongs to the plan it was published from, so it is cleared when that
    // plan changes: a report left on screen after navigating to another plan would
    // attribute one plan's tickets to another (F10-AC2).
    setReport(null);
    setPublishState('idle');
    setPublishMessage(null);
    if (resolvedPlanId === '') return;
    let current = true;
    setPlanState('loading');
    void fetchPlan(resolvedPlanId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setPlan(null);
        setPlanError(result.error.reason);
        setPlanState('error');
        return;
      }
      setPlan(result.value.plan);
      setPlanError(null);
      setPlanState('ready');
    });
    return () => {
      current = false;
    };
  }, [resolvedPlanId, epoch]);

  const publishable = (plan?.tasks ?? []).filter((task: PlanTask) => task.publishable);
  const publishableCount = publishable.length;

  const publish = async (): Promise<void> => {
    if (resolvedPlanId === '' || publishState === 'working') return;
    setPublishState('working');
    setPublishMessage(null);
    const result = await publishPlan(resolvedPlanId, requestId);
    if (!result.ok) {
      setReport(null);
      setPublishMessage(`Nothing was published: ${result.error.reason}`);
      setPublishState('refused');
      return;
    }
    setReport(result.value.report);
    const { published, unpublished } = result.value.report;
    setPublishMessage(
      published.length === 0
        ? `No proposed ticket was published. ${unpublished.length} ${unpublished.length === 1 ? 'ticket remains' : 'tickets remain'} unpublished (F10-AC2).`
        : unpublished.length === 0
          ? `All ${published.length} proposed ${published.length === 1 ? 'ticket was' : 'tickets were'} published (F10-AC2).`
          : `${published.length} ${published.length === 1 ? 'ticket was' : 'tickets were'} published and ${unpublished.length} remain unpublished: ${unpublished.join(', ')} (F10-AC2).`,
    );
    setPublishState('done');
  };

  const adopt = async (): Promise<void> => {
    if (adoptState === 'working') return;
    // Field-level first, then the broader precondition.
    //
    // An unnamed issue is the more specific thing the owner can fix in this form, and a refusal has to
    // name the field it is about (F02-AC4, N03-AC3). Reporting the missing project first would answer
    // a different question than the one the owner just acted on, and would hide the per-field error
    // behind a message about somewhere else entirely.
    if (issueId.trim() === '') {
      setAdoptErrors({ issueId: 'Name the issue by its provider identity, never by a title (F11-AC3).' });
      setAdoptMessage('Nothing was adopted because no issue was named (F11-AC1).');
      setAdoptState('refused');
      return;
    }
    if (projectId === null) {
      // Adoption binds a work item to a project, so with none selected there is no identity to
      // address. Refusing here names the fix; sending the empty string would have asked the
      // provider to adopt an issue into a project named "" (F11-AC1, F02-AC1).
      setAdoptErrors({});
      setAdoptMessage('Nothing was adopted: choose a project in the header first. Adoption binds an issue to one project.');
      setAdoptState('refused');
      return;
    }
    setAdoptState('working');
    setAdoptMessage(null);
    setAdoptErrors({});
    const result = await adoptExistingIssue({
      projectId,
      // The profile and recipe versions the captured scope is bound to. Both are
      // required by F12-AC1 and neither is invented here: a scope snapshot is only
      // meaningful against the profile version and recipe version it was read under.
      profileVersionId: 'current',
      procedureVersionId: 'current',
      issueId: issueId.trim(),
      expectedIdentifier: expectedIdentifier.trim() === '' ? null : expectedIdentifier.trim(),
      title: '',
    });
    if (!result.ok) {
      setAdopted(null);
      setAdoptErrors(fieldMessages(result.error));
      setAdoptMessage(`Nothing was adopted: ${result.error.reason}`);
      setAdoptState('refused');
      return;
    }
    setAdopted(result.value.adopted);
    setAdoptMessage(
      `${result.value.adopted.identifier} was adopted as work item ${result.value.adopted.workItemId}. Its live content is shown below; no replacement issue was created (F11-AC1).`,
    );
    setAdoptState('done');
  };

  const link = async (): Promise<void> => {
    if (linkState === 'working') return;
    const local: Record<string, string> = {};
    if (repositoryProvider.trim() === '') local['repository.provider'] = 'Name the git provider.';
    if (repositoryName.trim() === '') local['repository.fullName'] = 'Name the owner and repository path, not a display name (F11-AC3).';
    if (branch.trim() === '') local['branch'] = 'Name the branch being linked.';
    if (baseBranch.trim() === '') local['baseBranch'] = 'Name the branch this work targets.';
    if (Object.keys(local).length > 0) {
      setLinkErrors(local);
      setLinkMessage('Nothing was linked because the repository or branch is incomplete (F11-AC2).');
      setLinkState('refused');
      return;
    }
    const target = adopted?.workItemId ?? plan?.workItemIdByTaskId[publishable[0]?.taskId ?? ''] ?? '';
    if (target === '') {
      setLinkErrors({ workItemId: 'Adopt an issue first; a branch is linked to adopted work (F11-AC1, F11-AC2).' });
      setLinkMessage('Nothing was linked because there is no adopted work item to link it to (F11-AC2).');
      setLinkState('refused');
      return;
    }

    setLinkState('working');
    setLinkMessage(null);
    setLinkErrors({});
    const result = await linkExistingChange({
      workItemId: target,
      repository: { provider: repositoryProvider.trim(), fullName: repositoryName.trim() },
      branch: branch.trim(),
      baseBranch: baseBranch.trim(),
      expectedHeadSha: null,
      pullRequestId: null,
    });
    if (!result.ok) {
      setLinked(null);
      setLinkErrors(fieldMessages(result.error));
      setLinkMessage(`Nothing was linked: ${result.error.reason}`);
      setLinkState('refused');
      return;
    }
    setLinked(result.value.change);
    setLinkMessage(
      `${branch.trim()} is linked at ${result.value.change.headSha}, targeting ${result.value.change.baseBranch}. The head that was observed is recorded; nothing was pushed or reset (F11-AC4).`,
    );
    setLinkState('done');
  };

  const evaluate = async (mode: 'Test' | 'Review' | 'Build'): Promise<void> => {
    if (evaluationState === 'working') return;
    const target = adopted?.workItemId ?? plan?.workItemIdByTaskId[publishable[0]?.taskId ?? ''] ?? '';
    if (target === '') {
      setEvaluationMessage('There is no adopted work item to review yet (F11-AC5).');
      setEvaluationState('refused');
      return;
    }
    setEvaluationState('working');
    setEvaluationMessage(null);
    const result = await requestAdoptedEvaluation({ workItemId: target, mode, candidateId: null });
    if (!result.ok) {
      setEvaluation(null);
      setEvaluationMessage(`No review was requested: ${result.error.reason}`);
      setEvaluationState('refused');
      return;
    }
    setEvaluation(result.value.evaluation);
    setEvaluationMessage(
      result.value.evaluation.created
        ? `${result.value.evaluation.mode} was recorded for ${result.value.evaluation.workItemId}. No coding job was started and the original issue was not rewritten (F11-AC5).`
        : `The same ${result.value.evaluation.mode} request was already recorded, so nothing was duplicated (F30-AC2).`,
    );
    setEvaluationState('done');
  };

  const backDisabled = resolvedPlanId === '';

  return (
    <section className="page" aria-labelledby="publication-title">
      <h2 className="page__title" id="publication-title">
        Publication and adoption
      </h2>
      <div className="form__actions">
        <button className="button button--secondary" type="button" onClick={onBackToPlan}>
          Back to the plan
        </button>
      </div>

      <section className="panel" aria-labelledby="publication-publish-title">
        <h3 className="panel__title" id="publication-publish-title">
          Publish the accepted proposals
        </h3>
        <p className="panel__note">
          Publishing creates issues at the provider. Only a proposal you accepted has one to create (F10-AC1, F08-AC3).
        </p>
        <p
          className={planState === 'error' ? 'state-line state-line--error' : 'state-line'}
          role={planState === 'error' ? 'alert' : 'status'}
          aria-live={planState === 'error' ? 'assertive' : 'polite'}
          data-state={planState === 'ready' && publishableCount > 0 ? 'ready' : planState === 'error' ? 'error' : publishableCount === 0 ? 'empty' : 'ready'}
          data-testid="publishable-count"
        >
          {planState === 'error'
            ? `This plan could not be loaded: ${planError ?? 'unknown reason'}`
            : planState === 'loading'
              ? 'Loading the plan…'
              : planState === 'empty'
                ? 'No plan is selected.'
                : publishableCount === 0
              ? 'No proposal on this plan is accepted, so there is nothing to publish. Accept a task on the plan first (F08-AC3).'
              : `${publishableCount} accepted ${publishableCount === 1 ? 'proposal is' : 'proposals are'} ready to publish.`}
        </p>
        <div className="detail-list">
          <div className="detail-list__row">
            <dt>Publication request id</dt>
            <dd data-testid="publication-request-id">{requestId}</dd>
          </div>
        </div>
        <p className="panel__note">
          Repeating this request with the same id reconciles against the provider instead of creating a second issue
          (F10-AC3). Keep it: an unresolved publication is reconciled by this id.
        </p>
        <div className="form__actions">
          <button
            className="button"
            type="button"
            data-testid="publish-plan"
            disabled={publishableCount === 0 || publishState === 'working' || resolvedPlanId === ''}
            onClick={() => void publish()}
          >
            {publishState === 'working' ? 'Publishing…' : 'Publish the accepted proposals'}
          </button>
          {publishableCount > 0 && report !== null ? (
            <button className="button button--secondary" type="button" disabled={publishState === 'working'} onClick={() => void publish()}>
              Repeat this request to reconcile
            </button>
          ) : null}
        </div>
        <p
          className={publishState === 'refused' ? 'state-line state-line--error' : 'state-line'}
          role={publishState === 'refused' ? 'alert' : 'status'}
          aria-live={publishState === 'refused' ? 'assertive' : 'polite'}
          data-state={publishState}
          data-testid="publish-message"
        >
          {publishState === 'working' ? 'Publishing the accepted proposals…' : (publishMessage ?? 'Nothing has been published from this screen yet.')}
        </p>
      </section>

      {report === null ? null : (
        <section className="panel" aria-labelledby="publication-report-title">
          <h3 className="panel__title" id="publication-report-title">
            What each proposed ticket did
          </h3>
          <p className="panel__note">
            One entry per proposed ticket, and the remainder named rather than counted (F10-AC2).
          </p>
          {report.tickets.map((ticket) => (
            <article className="panel connector" key={ticket.workItemId} data-testid={`ticket-${ticket.workItemId}`}>
              <div className="connector__header">
                <h4 className="connector__subtitle">
                  {ticket.identifier ?? ticket.taskId ?? ticket.workItemId}
                </h4>
                <StatusBadge
                  tone={TICKET_TONES[ticket.kind]}
                  label={`Ticket ${ticket.kind}`}
                  {...(ticket.disposition === null
                    ? {}
                    : {
                        detail:
                          ticket.disposition === 'AlreadyPresent'
                            ? 'Already present at the provider; no second issue was created (F10-AC3).'
                            : `Disposition: ${ticket.disposition}`,
                      })}
                />
              </div>
              <div className="detail-list">
                <div className="detail-list__row">
                  <dt>Proposed task</dt>
                  <dd>{ticket.taskId ?? 'not tied to a task'}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Issue URL</dt>
                  <dd>{ticket.url === null || ticket.url === '' ? 'No issue URL was recorded.' : ticket.url}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>What happened</dt>
                  <dd>{ticket.detail}</dd>
                </div>
                {ticket.unlinked.length === 0 ? null : (
                  <div className="detail-list__row">
                    <dt>Links the provider did not create</dt>
                    <dd>
                      <ul className="capability-list">
                        {ticket.unlinked.map((link) => (
                          <li className="capability-list__item" key={link.target}>
                            {link.target}: {link.reason}
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                )}
              </div>
            </article>
          ))}
          <p className="state-line" role="status" data-testid="publication-unpublished" data-state={report.unpublished.length === 0 ? 'ready' : 'error'}>
            {report.unpublished.length === 0
              ? 'Every proposed ticket published; nothing remains unpublished.'
              : `Still unpublished: ${report.unpublished.join(', ')}.`}
          </p>
        </section>
      )}

      <section className="panel" aria-labelledby="adoption-issue-title">
        <h3 className="panel__title" id="adoption-issue-title">
          Adopt an issue that already exists
        </h3>
        <p className="panel__note">
          Adoption reads the live issue and binds it to a work item. It creates nothing at the provider and there is no
          merge control anywhere on this page (F11-AC1, F11-AC3).
        </p>
        <form
          className="form form--grid"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void adopt();
          }}
        >
          <div className="field">
            <label className="field__label" htmlFor="adoption-issue-id">
              Issue identity
            </label>
            <input
              className="field__input"
              id="adoption-issue-id"
              name="adoption-issue-id"
              type="text"
              value={issueId}
              aria-required="true"
              aria-invalid={adoptErrors['issueId'] === undefined ? undefined : 'true'}
              aria-describedby={adoptErrors['issueId'] === undefined ? 'adoption-issue-id-hint' : 'adoption-issue-id-hint adoption-issue-id-error'}
              disabled={adoptState === 'working'}
              onChange={(event) => setIssueId(event.target.value)}
            />
            <p className="field__hint" id="adoption-issue-id-hint">
              The provider's own id for the issue. A title is not an identity and is never searched for (F11-AC3).
            </p>
            {adoptErrors['issueId'] === undefined ? null : (
              <p className="field__error" id="adoption-issue-id-error">
                <span className="field__error-mark" aria-hidden="true" />
                Error: {adoptErrors['issueId']}
              </p>
            )}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="adoption-expected-identifier">
              Identifier you expect it to be (optional)
            </label>
            <input
              className="field__input"
              id="adoption-expected-identifier"
              name="adoption-expected-identifier"
              type="text"
              value={expectedIdentifier}
              aria-describedby="adoption-expected-identifier-hint"
              disabled={adoptState === 'working'}
              onChange={(event) => setExpectedIdentifier(event.target.value)}
            />
            <p className="field__hint" id="adoption-expected-identifier-hint">
              If the provider answers with a different one, the adoption is refused naming both (F11-AC3).
            </p>
          </div>
          <div className="form__actions">
            <button className="button" type="submit" disabled={adoptState === 'working'} data-testid="adopt-issue">
              {adoptState === 'working' ? 'Adopting…' : 'Adopt this existing issue'}
            </button>
          </div>
        </form>
        <p
          className={adoptState === 'refused' ? 'state-line state-line--error' : 'state-line'}
          role={adoptState === 'refused' ? 'alert' : 'status'}
          aria-live={adoptState === 'refused' ? 'assertive' : 'polite'}
          data-state={adoptState}
          data-testid="adopt-message"
        >
          {adoptState === 'working' ? 'Reading the live issue…' : (adoptMessage ?? 'No issue has been adopted from this screen yet.')}
        </p>
      </section>

      {adopted === null ? null : (
        <section className="panel" aria-labelledby="adopted-issue-title">
          <h3 className="panel__title" id="adopted-issue-title">
            The adopted issue, as the provider holds it
          </h3>
          <div className="detail-list">
            <div className="detail-list__row">
              <dt>Identifier</dt>
              <dd data-testid="adopted-identifier">{adopted.identifier}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Title</dt>
              <dd data-testid="adopted-title">{adopted.title}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Description</dt>
              <dd data-testid="adopted-description">{adopted.description}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Priority</dt>
              <dd>{adopted.priority ?? 'No priority is set at the provider.'}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Acceptance criteria</dt>
              <dd data-testid="adopted-criteria">
                {adopted.acceptanceCriteria.length === 0
                  ? 'The issue states no acceptance criteria.'
                  : adopted.acceptanceCriteria.map((criterion) => (
                      <span key={criterion.id}>
                        <strong>{criterion.id}</strong>: {criterion.text}
                        <br />
                      </span>
                    ))}
              </dd>
            </div>
            <div className="detail-list__row">
              <dt>Dependencies</dt>
              <dd>
                {adopted.dependencyIssueIds.length === 0 ? 'It depends on nothing.' : adopted.dependencyIssueIds.join(', ')}
              </dd>
            </div>
            <div className="detail-list__row">
              <dt>Provider state</dt>
              <dd>{adopted.state}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Captured scope</dt>
              <dd>
                Snapshot {adopted.capturedScopeSnapshotId}. The content lives at the provider; ShipLoop keeps a snapshot of
                what it read (F12-AC1).
              </dd>
            </div>
          </div>
          <p className="panel__note">
            Nothing here was written back. This issue is edited through the provider, and ShipLoop does not keep a second
            editable copy of it (F10-AC4, F11-AC1).
          </p>
        </section>
      )}

      <section className="panel" aria-labelledby="adoption-change-title">
        <h3 className="panel__title" id="adoption-change-title">
          Link an existing branch or pull request
        </h3>
        <p className="panel__note">
          The repository, the head and the target are verified before anything is recorded, and what is recorded is what
          was observed. ShipLoop will not push, force or reset a person's branch (F11-AC2, F11-AC4).
        </p>
        <form
          className="form form--grid"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void link();
          }}
        >
          <div className="field">
            <label className="field__label" htmlFor="adoption-repository-provider">
              Git provider
            </label>
            <input
              className="field__input"
              id="adoption-repository-provider"
              name="adoption-repository-provider"
              type="text"
              value={repositoryProvider}
              aria-required="true"
              aria-invalid={linkErrors['repository.provider'] === undefined ? undefined : 'true'}
              disabled={linkState === 'working'}
              onChange={(event) => setRepositoryProvider(event.target.value)}
            />
            {linkErrors['repository.provider'] === undefined ? null : (
              <p className="field__error">
                <span className="field__error-mark" aria-hidden="true" />
                Error: {linkErrors['repository.provider']}
              </p>
            )}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="adoption-repository-name">
              Repository owner and path
            </label>
            <input
              className="field__input"
              id="adoption-repository-name"
              name="adoption-repository-name"
              type="text"
              value={repositoryName}
              aria-required="true"
              aria-invalid={linkErrors['repository.fullName'] === undefined ? undefined : 'true'}
              aria-describedby="adoption-repository-name-hint"
              disabled={linkState === 'working'}
              onChange={(event) => setRepositoryName(event.target.value)}
            />
            <p className="field__hint" id="adoption-repository-name-hint">
              The full path, never a display name: a similarly named repository is never picked silently (F11-AC3).
            </p>
            {linkErrors['repository.fullName'] === undefined ? null : (
              <p className="field__error">
                <span className="field__error-mark" aria-hidden="true" />
                Error: {linkErrors['repository.fullName']}
              </p>
            )}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="adoption-branch">
              Branch
            </label>
            <input
              className="field__input"
              id="adoption-branch"
              name="adoption-branch"
              type="text"
              value={branch}
              aria-required="true"
              aria-invalid={linkErrors['branch'] === undefined ? undefined : 'true'}
              disabled={linkState === 'working'}
              onChange={(event) => setBranch(event.target.value)}
            />
            {linkErrors['branch'] === undefined ? null : (
              <p className="field__error">
                <span className="field__error-mark" aria-hidden="true" />
                Error: {linkErrors['branch']}
              </p>
            )}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="adoption-base-branch">
              Target branch
            </label>
            <input
              className="field__input"
              id="adoption-base-branch"
              name="adoption-base-branch"
              type="text"
              value={baseBranch}
              aria-required="true"
              aria-invalid={linkErrors['baseBranch'] === undefined ? undefined : 'true'}
              disabled={linkState === 'working'}
              onChange={(event) => setBaseBranch(event.target.value)}
            />
            {linkErrors['baseBranch'] === undefined ? null : (
              <p className="field__error">
                <span className="field__error-mark" aria-hidden="true" />
                Error: {linkErrors['baseBranch']}
              </p>
            )}
          </div>
          <div className="form__actions">
            <button className="button" type="submit" disabled={linkState === 'working'} data-testid="link-change">
              {linkState === 'working' ? 'Verifying…' : 'Link this existing change'}
            </button>
          </div>
        </form>
        <p
          className={linkState === 'refused' ? 'state-line state-line--error' : 'state-line'}
          role={linkState === 'refused' ? 'alert' : 'status'}
          aria-live={linkState === 'refused' ? 'assertive' : 'polite'}
          data-state={linkState}
          data-testid="link-message"
        >
          {linkState === 'working' ? 'Verifying the repository, the head and the target…' : (linkMessage ?? 'No branch or pull request has been linked yet.')}
        </p>
        {linked === null ? null : (
          <div className="detail-list" data-testid="linked-change">
            <div className="detail-list__row">
              <dt>Repository</dt>
              <dd>{linked.repository}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Head observed</dt>
              <dd>{linked.headSha}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Target</dt>
              <dd>{linked.baseBranch}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Pull request</dt>
              <dd>{linked.pullRequestId ?? 'The provider reported no pull request for this branch.'}</dd>
            </div>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="adoption-evaluate-title">
        <h3 className="panel__title" id="adoption-evaluate-title">
          Request a review of adopted work
        </h3>
        <p className="panel__note">
          Test and Review are available for adopted work. Build is not: it would start from a generated working point
          and reset what the person already wrote, so it is refused with that reason rather than hidden (F11-AC5,
          F11-AC4).
        </p>
        <div className="form__actions">
          <button className="button" type="button" disabled={evaluationState === 'working'} onClick={() => void evaluate('Test')} data-testid="evaluate-test">
            Request a Test
          </button>
          <button className="button button--secondary" type="button" disabled={evaluationState === 'working'} onClick={() => void evaluate('Review')} data-testid="evaluate-review">
            Request a Review
          </button>
          <button className="button button--danger" type="button" disabled={evaluationState === 'working'} onClick={() => void evaluate('Build')} data-testid="evaluate-build">
            Request a Build
          </button>
        </div>
        <p
          className={evaluationState === 'refused' ? 'state-line state-line--error' : 'state-line'}
          role={evaluationState === 'refused' ? 'alert' : 'status'}
          aria-live={evaluationState === 'refused' ? 'assertive' : 'polite'}
          data-state={evaluationState}
          data-testid="evaluation-message"
        >
          {evaluationState === 'working' ? 'Recording the request…' : (evaluationMessage ?? 'No review has been requested from this screen yet.')}
        </p>
        {evaluation === null ? null : (
          <p className="state-line" role="status" data-testid="evaluation-recorded" data-state="ready">
            A {evaluation.mode} request is recorded for {evaluation.workItemId} under the key {evaluation.dedupKey}. No
            coding job was launched and the original issue was not rewritten (F11-AC5).
          </p>
        )}
      </section>

      <p className="panel__note" data-testid="publication-scope">
        {backDisabled
          ? 'No plan is selected, so publication has nothing to act on.'
          : 'Publication acts on the plan you came from, and only on its accepted proposals.'}
      </p>
    </section>
  );
}
