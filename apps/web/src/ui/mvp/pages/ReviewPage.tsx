/**
 * Review: one candidate, everything known about it, and the owner's decision.
 *
 * The surface shows Request, Contract revision, PR, full SHA, checks, criteria, evidence, pending
 * owner tests and stale warnings, and it offers exactly two actions: **Request changes** and
 * **Accept**. Merge, release and deploy are not here and are not implied: ShipLoop v0.1 ends at an
 * owner decision, and a page that offered a green "Ship it" beside a green check is how `accepted`
 * quietly becomes `merged`.
 *
 * What the page will not do:
 *
 *   - **Decide anything.** Accept is offered on the server's own statement that verification is
 *     complete. The page never computes readiness from the checks it is already showing, so a card
 *     that reads as complete to a person and a candidate the domain will accept cannot drift apart.
 *   - **Abbreviate an identity.** The full 40-character SHA is on screen, and evidence that
 *     describes a different commit is labelled as such rather than presented beside this one.
 *   - **Read as accepted because checks passed.** The decision panel is the last one on the page and
 *     is labelled as a separate decision, because a passing check sitting beside an Accept button is
 *     exactly how an acceptance starts to look implied.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { formatTimestamp } from '../../api-client.ts';
import { StatusBadge } from '../../components/StatusBadge.tsx';
import { fetchReview, fetchReviewQueue, recordDecision, recordOwnerObservation } from '../client.ts';
import { Panel, Sha, StateLine, type ViewState } from '../components/StateLine.tsx';
import { SHA_IDENTITY_NOTE } from '../sha.ts';
import {
  acceptRefusals,
  checkDetail,
  checkTone,
  criterionDetail,
  criterionTone,
  decisionTone,
  evidenceMatchesCandidate,
  queueItemSummary,
  reviewCounts,
  reviewHeadline,
} from '../review-view.ts';
import type { ReviewDetail, ReviewQueueItem } from '../wire.ts';

export interface ReviewPageProps {
  readonly projectId: string | null;
  readonly candidateId: string | null;
  readonly epoch: number;
  readonly onOpenCandidate: (candidateId: string) => void;
  readonly onBackToQueue: () => void;
}

type DecisionState = 'idle' | 'saving' | 'done' | 'refused';

function Queue({ items, onOpen }: { readonly items: readonly ReviewQueueItem[]; readonly onOpen: (id: string) => void }): ReactElement {
  return (
    <ul className="profile-list" data-testid="review-queue">
      {items.map((item) => (
        <li className="profile-list__item" key={item.candidateId} data-testid="review-queue-item">
          <span className="profile-list__name">{item.requestTitle}</span>
          <span className="profile-list__detail" data-testid="review-queue-summary">
            {queueItemSummary(item)}
          </span>
          <Sha value={item.headSha} testId="review-queue-sha" />
          <StatusBadge
            tone={decisionTone(item.decision?.kind ?? null)}
            label={item.decision === null ? 'No decision recorded' : `Decision: ${item.decision.kind.replace('_', ' ')}`}
            detail={
              item.decision === null
                ? 'Waiting on you. Verification is evidence; the decision is not made yet.'
                : `Recorded at ${formatTimestamp(item.decision.decidedAt)} against commit ${item.decision.headSha}.`
            }
          />
          <div className="form__actions">
            <button
              className="button"
              type="button"
              data-testid={`open-review-${item.candidateId}`}
              onClick={() => onOpen(item.candidateId)}
            >
              Open review
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function DetailView({ detail, onRecorded }: { readonly detail: ReviewDetail; readonly onRecorded: () => void }): ReactElement {
  const counts = reviewCounts(detail);
  const refusals = acceptRefusals(detail);
  const canAccept = refusals.length === 0;

  return (
    <>
      <Panel id="review-identity" title="What you are deciding about">
        <dl className="detail-list">
          <div className="detail-list__row">
            <dt>Request</dt>
            <dd data-testid="review-request">{detail.requestTitle}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Contract revision</dt>
            <dd data-testid="review-revision">{String(detail.contractRevision)}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Pull request</dt>
            <dd data-testid="review-pr">
              {detail.pullRequestUrl === null
                ? detail.pullRequestNumber === null
                  ? 'No pull request has been linked for this request.'
                  : `#${String(detail.pullRequestNumber)}, with no address to open.`
                : detail.pullRequestUrl}
            </dd>
          </div>
          <div className="detail-list__row">
            <dt>Commit</dt>
            <dd>
              <Sha value={detail.headSha} testId="review-head-sha" />
            </dd>
          </div>
          <div className="detail-list__row">
            <dt>Base branch</dt>
            <dd>{detail.baseBranch}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Repository</dt>
            <dd>{detail.repository}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Observed at</dt>
            <dd>{formatTimestamp(detail.observedAt)}</dd>
          </div>
        </dl>
        <p className="panel__note">{SHA_IDENTITY_NOTE}</p>
        <StatusBadge
          tone={detail.staleReasons.length > 0 ? 'degraded' : detail.verification?.complete === true ? 'healthy' : 'pending'}
          label={reviewHeadline(detail)}
          detail={
            detail.verification === null
              ? 'No verification has been recorded for this candidate yet.'
              : detail.verification.complete
                ? 'Verification is recorded for the commit above. Acceptance is still your separate decision.'
                : `Verification has not finished. Outstanding: ${
                    detail.verification.outstanding.join(', ') === ''
                      ? 'the server reported no breakdown'
                      : detail.verification.outstanding.join(', ')
                }.`
          }
        />
        {detail.staleReasons.length === 0 ? null : (
          <StateLine
            view="stale"
            message={`This review is stale: ${detail.staleReasons.join(', ')}. What is shown was recorded against this commit, and the commit or the revision has moved since.`}
            testId="review-stale"
          />
        )}
      </Panel>

      <Panel
        id="review-checks"
        title="Checks"
        note={
          counts.checksFailing === 0
            ? `No check is recorded as failing. ${String(detail.checks.length)} ${detail.checks.length === 1 ? 'check is' : 'checks are'} reported, including every check the project settings require.`
            : `${String(counts.checksFailing)} of ${String(detail.checks.length)} ${detail.checks.length === 1 ? 'check is' : 'checks are'} recorded as failing. A failing check is evidence about this commit, not an outcome.`
        }
      >
        {detail.checks.length === 0 ? (
          <StateLine view="empty" message="No checks have reported for this commit." testId="review-checks-empty" />
        ) : (
          <ul className="capability-list">
            {detail.checks.map((check) => (
              <li className="capability-list__item" key={check.checkId} data-testid="review-check">
                <span className="profile-list__name">{check.name}</span>{' '}
                <StatusBadge
                  tone={checkTone(check.result)}
                  label={`${check.required ? 'Required check' : 'Check'} ${check.name}: ${check.result}`}
                  detail={checkDetail(check)}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        id="review-criteria"
        title="Acceptance criteria and evidence"
        note={`${String(counts.criteriaVerified)} of ${String(counts.criteriaTotal)} ${counts.criteriaTotal === 1 ? 'criterion has' : 'criteria have'} recorded evidence against this exact commit. Evidence recorded against a different commit is labelled and never counted here.`}
      >
        {detail.criteria.length === 0 ? (
          <StateLine view="empty" message="This contract records no acceptance criteria, so there is nothing to judge." testId="review-criteria-empty" />
        ) : (
          <ul className="capability-list">
            {detail.criteria.map((criterion) => {
              const matches = evidenceMatchesCandidate(criterion, detail.headSha);
              return (
                <li className="capability-list__item" key={criterion.id} data-testid="review-criterion" data-criterion-id={criterion.id}>
                  <span className="profile-list__name">{criterion.description}</span>{' '}
                  <StatusBadge
                    tone={criterionTone(criterion.status)}
                    label={`${criterion.verificationType === 'owner_test' ? 'Owner test' : 'Automated criterion'}: ${criterion.status}`}
                    detail={criterionDetail(criterion)}
                  />
                  {matches ? null : criterion.evidence === null ? null : (
                    <p className="connector__problem-line" data-testid="review-evidence-mismatch">
                      {`This evidence was recorded against commit ${criterion.evidence.candidateHeadSha}, which is not the commit on this page, so it says nothing about it.`}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        id="review-owner-tests"
        title="Waiting on your own test"
        note="A criterion you marked as your own test is judged by you and by nothing else. ShipLoop records what you observed; it never decides whether you were right."
      >
        {counts.pendingOwnerTests === 0 ? (
          <StateLine
            view="empty"
            message="No criterion is waiting on you. If you wrote one that needs your judgement, it will be listed here until you record what you saw."
            testId="review-owner-tests-empty"
          />
        ) : (
          <ul className="connector-list" data-testid="review-pending-owner-tests">
            {detail.pendingOwnerTestCriterionIds.map((id) => (
              <li className="connector__problem" key={id}>
                {`${id} — you test this one. Nothing counts it until you record what you observed.`}
              </li>
            ))}
          </ul>
        )}
        {/* Kept mounted even once nothing is pending, so the confirmation of a recording the owner
            has just made is not removed by the very re-read that recorded it. A control that
            disappears with its own success message tells the owner nothing about what landed. */}
        <OwnerObservation detail={detail} onRecorded={onRecorded} />
      </Panel>

      <DecisionPanel detail={detail} canAccept={canAccept} refusals={refusals} onRecorded={onRecorded} />
    </>
  );
}

/**
 * The control that lets the owner record what they observed for a criterion only they can judge.
 *
 * It sends an *observation*, never a verdict. There is deliberately no "this passed" button: the
 * vocabulary is "I saw this work" and "I saw this not work", and the server decides what either
 * one makes the criterion. A client able to assert that a criterion passed would be a client able
 * to manufacture verification evidence, which is the one thing this product must not permit.
 *
 * Every observation carries the environment it was made in, because "it worked locally" and "it
 * worked on the deployed environment" are different claims about the same criterion.
 */
function OwnerObservation({ detail, onRecorded }: { readonly detail: ReviewDetail; readonly onRecorded: () => void }): ReactElement {
  const [criterionId, setCriterionId] = useState(detail.pendingOwnerTestCriterionIds[0] ?? '');
  const [observation, setObservation] = useState<'BehaviorConfirmed' | 'BehaviorFailed'>('BehaviorConfirmed');
  const [environment, setEnvironment] = useState<'Local' | 'Preview' | 'LiveSmoke'>('Local');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const pending = detail.pendingOwnerTestCriterionIds;
  const selected = criterionId === '' || !pending.includes(criterionId) ? (pending[0] ?? '') : criterionId;
  const nothingPending = pending.length === 0;

  const submit = async (): Promise<void> => {
    if (busy || selected === '') return;
    setBusy(true);
    setMessage(null);
    setFailure(null);
    const result = await recordOwnerObservation(detail.candidateId, {
      criterionId: selected,
      expectedHeadSha: detail.headSha,
      observation,
      environment,
      note: note.trim() === '' ? null : note.trim(),
    });
    setBusy(false);
    if (!result.ok) {
      setFailure(`Your observation was not recorded: ${result.error.reason}`);
      return;
    }
    setNote('');
    setMessage(
      `Recorded "${observation === 'BehaviorConfirmed' ? 'behaviour confirmed' : 'behaviour not confirmed'}" against ${selected} on ${environment}, for commit ${detail.headSha}. The review has been re-read; the server decides what this makes the criterion.`,
    );
    // Last, so the confirmation above is already set when the re-read lands. Re-reading first would
    // briefly unmount nothing but would leave the panel showing a state one read behind the write.
    onRecorded();
  };

  return (
    <div className="form" data-testid="owner-observation">
      <div className="field">
        <label className="field__label" htmlFor="owner-observation-criterion">
          Which criterion you tested
        </label>
        <select
          className="field__input"
          id="owner-observation-criterion"
          value={selected}
          disabled={busy}
          onChange={(event) => setCriterionId(event.target.value)}
        >
          {pending.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="owner-observation-result">
          What you saw
        </label>
        <select
          className="field__input"
          id="owner-observation-result"
          value={observation}
          disabled={busy}
          onChange={(event) => setObservation(event.target.value as 'BehaviorConfirmed' | 'BehaviorFailed')}
        >
          <option value="BehaviorConfirmed">It behaved as this criterion says</option>
          <option value="BehaviorFailed">It did not behave as this criterion says</option>
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="owner-observation-environment">
          Where you tested it
        </label>
        <select
          className="field__input"
          id="owner-observation-environment"
          value={environment}
          disabled={busy}
          aria-describedby="owner-observation-environment-hint"
          onChange={(event) => setEnvironment(event.target.value as 'Local' | 'Preview' | 'LiveSmoke')}
        >
          <option value="Local">Locally</option>
          <option value="Preview">On a preview</option>
          <option value="LiveSmoke">On the live deployment</option>
        </select>
        <p className="field__hint" id="owner-observation-environment-hint">
          Stored with the observation, so evidence gathered locally stays labelled local and cannot
          satisfy a criterion that required deployed behaviour.
        </p>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="owner-observation-note">
          Anything to note (optional)
        </label>
        <textarea
          className="field__input field__input--area"
          id="owner-observation-note"
          value={note}
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      {failure === null ? null : <StateLine view="error" message={failure} testId="owner-observation-failure" />}
      {message === null ? null : <StateLine view="ready" message={message} testId="owner-observation-message" />}
      {nothingPending ? (
        <StateLine
          view="empty"
          message="Nothing is waiting on your own test for this candidate, so there is nothing to record."
          testId="owner-observation-empty"
        />
      ) : null}
      <div className="form__actions">
        <button
          className="button"
          type="button"
          disabled={busy || nothingPending}
          data-testid="record-observation"
          onClick={() => void submit()}
        >
          {busy ? 'Recording…' : 'Record what I observed'}
        </button>
      </div>
    </div>
  );
}

function DecisionPanel({
  detail,
  canAccept,
  refusals,
  onRecorded,
}: {
  readonly detail: ReviewDetail;
  readonly canAccept: boolean;
  readonly refusals: readonly string[];
  /**
   * Re-read the review once a decision is recorded.
   *
   * Not an optimistic local edit: the recorded state includes what the decision was made against,
   * and a panel that showed a decision the server had not yet written back would be claiming an
   * acceptance that nothing durable holds.
   */
  readonly onRecorded: () => void;
}): ReactElement {
  const [feedback, setFeedback] = useState('');
  const [feedbackError, setFeedbackError] = useState<string | undefined>(undefined);
  const [state, setState] = useState<DecisionState>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const decide = async (kind: 'accepted' | 'changes_requested'): Promise<void> => {
    if (state === 'saving') return;
    if (kind === 'changes_requested' && feedback.trim() === '') {
      setFeedbackError('Say what is wrong. Feedback with nothing in it is not feedback.');
      return;
    }
    setFeedbackError(undefined);
    setState('saving');
    setMessage(null);
    const result = await recordDecision(detail.candidateId, kind, kind === 'changes_requested' ? feedback.trim() : null);
    if (!result.ok) {
      setState('refused');
      setMessage(
        `Your decision was not recorded: ${result.error.reason}${
          result.error.prerequisites.length === 0
            ? ''
            : ` ${result.error.prerequisites.map((entry) => `${entry.name}: ${entry.detail} ${entry.remedy}`).join(' ')}`
        }`,
      );
      return;
    }
    setState('done');
    setFeedback('');
    setMessage(
      result.value.decision.kind === 'accepted'
        ? `Accepted as ${result.value.decision.decisionId}, against commit ${result.value.decision.headSha} and contract revision ${String(result.value.decision.contractRevision)}. Nothing is merged or deployed: this product ends at your decision.`
        : `Changes requested as ${result.value.decision.decisionId}. The feedback is kept against the commit you tested, and ShipLoop will not accept this commit again on the same evidence.`,
    );
    // Last, so the confirmation is already rendered when the re-read lands. The recorded decision
    // itself is never shown from this local state: it comes from the re-read, because a panel
    // reporting an acceptance the server has not written back would be claiming evidence.
    onRecorded();
  };

  return (
    <Panel
      id="review-decision"
      title="Your decision"
      note="A separate decision, and nothing above makes it. A passing check and a recorded verdict describe the work; neither accepts it."
    >
      <dl className="detail-list">
        <div className="detail-list__row">
          <dt>Recorded decision</dt>
          <dd data-testid="review-decision-state">
            <StatusBadge
              tone={decisionTone(detail.decision?.kind ?? null)}
              label={detail.decision === null ? 'No decision recorded' : `Decision: ${detail.decision.kind.replace('_', ' ')}`}
              detail={
                detail.decision === null
                  ? 'Nothing has been decided about this candidate yet.'
                  : `Recorded at ${formatTimestamp(detail.decision.decidedAt)} by the owner, against commit ${detail.decision.headSha}.`
              }
            />
          </dd>
        </div>
      </dl>

      <StateLine
        view={state === 'refused' ? 'error' : 'ready'}
        message={message ?? 'No decision has been made from this screen.'}
        testId="review-decision-outcome"
      />
      {canAccept ? null : (
        <ul className="connector-list" data-testid="review-accept-refusals">
          {refusals.map((reason) => (
            <li className="connector__problem" key={reason}>
              {reason}
            </li>
          ))}
        </ul>
      )}

      <div className="field">
        <label className="field__label" htmlFor="review-feedback">
          What is wrong with this work
        </label>
        <textarea
          className="field__input field__input--area"
          id="review-feedback"
          value={feedback}
          disabled={state === 'saving'}
          aria-invalid={feedbackError === undefined ? undefined : 'true'}
          onChange={(event) => setFeedback(event.target.value)}
        />
        <p className="field__hint">
          Required to request changes, optional when accepting. Kept against the commit you tested.
        </p>
        {feedbackError === undefined ? null : (
          <p className="field__error" data-testid="review-feedback-error">
            <span className="field__error-mark" aria-hidden="true" />
            Error: {feedbackError}
          </p>
        )}
      </div>

      <div className="form__actions">
        <button
          className="button button--secondary"
          type="button"
          disabled={state === 'saving' || detail.decision?.kind === 'changes_requested'}
          data-testid="request-changes"
          onClick={() => void decide('changes_requested')}
        >
          {state === 'saving' ? 'Recording…' : 'Request changes'}
        </button>
        <button
          className="button"
          type="button"
          disabled={state === 'saving' || !canAccept}
          data-testid="accept-candidate"
          onClick={() => void decide('accepted')}
        >
          Accept
        </button>
      </div>
      <p className="panel__note">
        Accept is refused while verification is unfinished, while this review is stale, or while a decision is
        already recorded. Each refusal is written above with what is outstanding.
      </p>
    </Panel>
  );
}

export function ReviewPage({
  projectId,
  candidateId,
  epoch,
  onOpenCandidate,
  onBackToQueue,
}: ReviewPageProps): ReactElement {
  const [queue, setQueue] = useState<readonly ReviewQueueItem[]>([]);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [view, setView] = useState<ViewState>('loading');
  const [message, setMessage] = useState('Reading what is waiting for your decision…');
  const [reload, setReload] = useState(0);

  const refresh = useCallback((): void => {
    setReload((count) => count + 1);
  }, []);

  useEffect(() => {
    let current = true;
    // Loading is entered only when there is nothing to show yet. A re-read after the owner's own
    // action — recording an observation, making a decision — must not blank the panel the action
    // was made from: the panel holds the outcome being reported, and unmounting it would discard
    // the confirmation and leave the owner unable to tell whether the write landed.
    if (candidateId !== null) {
      if (detail === null) setView('loading');
      void fetchReview(candidateId).then((result) => {
        if (!current) return;
        if (!result.ok) {
          setDetail(null);
          setMessage(`This review could not be read: ${result.error.reason}`);
          setView(result.error.code === 'NotFound' ? 'empty' : 'error');
          return;
        }
        setDetail(result.value.review);
        setMessage(reviewHeadline(result.value.review));
        setView('ready');
      });
      return () => {
        current = false;
      };
    }
    setDetail(null);
    if (queue.length === 0) setView('loading');
    void fetchReviewQueue(projectId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setQueue([]);
        setMessage(`The review queue could not be read: ${result.error.reason}`);
        setView('error');
        return;
      }
      setQueue(result.value.queue.items);
      setMessage(
        result.value.queue.items.length === 0
          ? 'Nothing is waiting on your decision.'
          : `${String(result.value.queue.items.length)} ${result.value.queue.items.length === 1 ? 'candidate is' : 'candidates are'} waiting on your decision.`,
      );
      setView(result.value.queue.projectId === null ? 'empty' : 'ready');
    });
    return () => {
      current = false;
    };
    // `detail` and `queue` are read to decide whether to show loading, and are deliberately not
    // dependencies: adding them would make every re-read set the state this read is deciding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId, projectId, epoch, reload]);

  return (
    <section className="page" aria-labelledby="review-title">
      <div className="page__header">
        <h2 className="page__title" id="review-title">
          Review
        </h2>
        {candidateId === null ? null : (
          <button
            className="button button--secondary"
            type="button"
            data-testid="back-to-review-queue"
            onClick={onBackToQueue}
          >
            All candidates
          </button>
        )}
      </div>
      <p className="panel__note">
        What ShipLoop checked about one exact commit, and what you decide about it. Verification is evidence and
        your decision is separate: this product ends here, at Accept or Request changes.
      </p>
      <StateLine view={view} message={message} testId="review-state" />
      {view === 'error' ? (
        <div className="form__actions">
          <button className="button button--secondary" type="button" data-testid="review-retry" onClick={refresh}>
            Try again
          </button>
        </div>
      ) : null}

      {view !== 'ready' ? null : detail !== null ? (
        <DetailView detail={detail} onRecorded={refresh} />
      ) : queue.length === 0 ? (
        <Panel
          id="review-nothing"
          title="Nothing to decide"
          note="No candidate is waiting on you for this project. A candidate appears here once a pull request is linked against an approved Delivery Contract."
        />
      ) : (
        <Panel id="review-queue-panel" title="Candidates waiting on you">
          <Queue items={queue} onOpen={onOpenCandidate} />
        </Panel>
      )}
    </section>
  );
}