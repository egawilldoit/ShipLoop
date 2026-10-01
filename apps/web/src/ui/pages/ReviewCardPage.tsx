/**
 * The review card for one run's current candidate, and the owner's acceptance decision
 * about it (F24-AC2, F24-AC3, F24-AC4, F25-AC1, F25-AC2, F25-AC3, F20-AC2, F20-AC3, F23-AC1,
 * N03-AC1, N03-AC3, F01-AC3, N02-AC2).
 *
 * One page, four things to read, and every one of them is a fact rather than a verdict this
 * page reaches: the identity the work was built from (both commit SHAs in full, the scope
 * fingerprint and the scope revision), every required check with the result it was recorded
 * under, every acceptance criterion with the verdict recorded against it, and the explicit
 * list of reasons the work is not ready.
 *
 * The decision controls live here rather than on the run screen because acceptance is judged
 * over the evidence the card shows. Putting the buttons beside the run's lifecycle controls
 * would let a green check read as an acceptance, which is precisely the promotion neither
 * check results nor a deployment may perform (F24-AC3, F25-AC1).
 *
 * Five properties are why it is shaped this way:
 *
 *   - **The not-ready list is the point (F24-AC3).** An incomplete candidate has to stay
 *     inspectable with its reasons. A card that hid them would read as green everywhere
 *     except the parts nobody could see, which is the failure F24-AC3 exists to prevent.
 *   - **A check with no recorded run is shown as such (F20-AC2).** The profile's required set
 *     is rendered in full, and a check nothing ran appears with the result it actually has
 *     rather than being absent, because a gate nobody ran has not been passed.
 *   - **A superseded or absent candidate is its own state (F24-AC4).** The server refuses a
 *     card for a candidate that is no longer the current one, naming both identities, and
 *     this page shows that refusal rather than falling back to an older card.
 *   - **Status is a word, a shape and a tone (N03-AC1).** Every check and criterion renders
 *     through `StatusBadge`, so a failing check and an unrun one cannot be told apart by
 *     colour alone.
 *   - **The decision is recorded, never inferred (F25-AC1).** This page never computes
 *     readiness from what it is already showing; it reads the server's gate and shows that,
 *     so a card that looks complete to a reader and a candidate the domain will accept
 *     cannot drift apart.
 *   - **A failed save keeps what the owner typed (N03-AC3).** The rejection reason is
 *     written beside the controls and the feedback is left in the textarea, because a
 *     rejected decision that also discarded the reason would make the owner retype the
 *     hardest part.
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import {
  acceptCandidate,
  fetchAcceptance,
  fetchReviewCard,
  formatTimestamp,
  requestChanges,
  type AcceptanceGate,
  type AcceptanceState,
  type ApiFailure,
  type ReviewCard,
  type ReviewCardCheck,
  type ReviewCardCriterion,
} from '../api-client.ts';
import { Field } from '../components/Field.tsx';
import { StatusBadge, type StatusTone } from '../components/StatusBadge.tsx';

export interface ReviewCardPageProps {
  readonly jobId: string;
  readonly onBackToRuns: () => void;
  readonly epoch: number;
}

type ViewState = 'loading' | 'empty' | 'ready' | 'error';

/**
 * How each check result reads, so a failing gate and an unrun one are never the same word
 * (F20-AC2).
 *
 * `Missing` and `Stale` are separate tones from `Failed` on purpose: one is "nothing ran"
 * and the other is "a run was recorded against an identity that has since moved", and an
 * owner deciding whether to trust a candidate needs to tell them apart.
 */
const CHECK_TONES: Readonly<Record<string, StatusTone>> = {
  Passed: 'healthy',
  Failed: 'revoked',
  Missing: 'degraded',
  Stale: 'degraded',
  Waiting: 'pending',
  Skipped: 'unconfigured',
  NotApplicable: 'unconfigured',
};

const CRITERION_TONES: Readonly<Record<string, StatusTone>> = {
  Verified: 'healthy',
  PendingOwnerTest: 'pending',
  Missing: 'degraded',
  Untested: 'degraded',
  Failed: 'revoked',
  Stale: 'degraded',
};

function tone(tones: Readonly<Record<string, StatusTone>>, value: string): StatusTone {
  return tones[value] ?? 'neutral';
}

function checkDetail(check: ReviewCardCheck): string {
  const parts = [check.required ? 'Required by the project profile.' : 'Not required by the project profile.'];
  if (check.blocking) parts.push('It blocks acceptance until it passes.');
  if (check.origin === null) parts.push('No run has reported where this check would run.');
  if (check.exitCode !== null) parts.push(`Exit code ${String(check.exitCode)}.`);
  return parts.join(' ');
}

function criterionDetail(criterion: ReviewCardCriterion): string {
  const parts = [`Verification method: ${criterion.methodKind}.`];
  if (criterion.observedAt === null) parts.push('Nothing has been observed against this criterion yet.');
  else parts.push(`Observed at ${formatTimestamp(criterion.observedAt)}.`);
  return parts.join(' ');
}

/** The tone each recorded acceptance state reads as (F25-AC3). */
const ACCEPTANCE_TONES: Readonly<Record<string, StatusTone>> = {
  Accepted: 'healthy',
  ChangesRequested: 'degraded',
  NotRequested: 'pending',
  Pending: 'pending',
  Stale: 'degraded',
};

/**
 * What the recorded acceptance state means, in words.
 *
 * The undecided case is separated because a state with no decision and a state that never
 * asked for one read identically otherwise, and "no decision has been recorded" is the fact
 * the owner needs before pressing Accept (F25-AC1, F25-AC3).
 */
function acceptanceStateText(state: AcceptanceState): string {
  if (state.decisionId === null) {
    return 'No acceptance decision has been recorded for this candidate yet.';
  }
  const parts = [`Decided at ${formatTimestamp(state.decidedAt ?? '')}.`];
  if (state.note !== null && state.note !== '') parts.push(`Owner note: ${state.note}`);
  if (state.staleReasons.length > 0) {
    parts.push(`This decision no longer describes the current work: ${state.staleReasons.join(', ')}.`);
  }
  return parts.join(' ');
}

export function ReviewCardPage({ jobId, onBackToRuns, epoch }: ReviewCardPageProps): ReactElement {
  const [card, setCard] = useState<ReviewCard | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>('loading');

  const [gate, setGate] = useState<AcceptanceGate | null>(null);
  const [acceptance, setAcceptance] = useState<AcceptanceState | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionDetail, setDecisionDetail] = useState<readonly string[]>([]);
  const [feedback, setFeedback] = useState('');
  const [feedbackError, setFeedbackError] = useState<string | undefined>(undefined);
  const [decisionState, setDecisionState] = useState<'idle' | 'saving' | 'done' | 'refused'>('idle');
  const [decisionMessage, setDecisionMessage] = useState<string | null>(null);
  const [decisionReload, setDecisionReload] = useState(0);

  const reloadDecision = useCallback((): void => {
    setDecisionReload((count) => count + 1);
  }, []);

  useEffect(() => {
    if (jobId === '') {
      setGate(null);
      setAcceptance(null);
      return;
    }
    let current = true;
    void fetchAcceptance(jobId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setGate(null);
        setAcceptance(null);
        setDecisionError(result.error.reason);
        return;
      }
      setGate(result.value.gate);
      setAcceptance(result.value.acceptance);
    });
    return () => {
      current = false;
    };
  }, [jobId, epoch, decisionReload]);

  /**
   * A refused decision, with everything the server named.
   *
   * A `Blocked` refusal names its unmet prerequisites and each carries its own remedy, so
   * those are shown one per line with the remedy attached; every other refusal has only
   * per-field messages. A single "cannot be accepted yet" would tell the owner nothing they
   * can act on (F25-AC1, F04-AC3).
   */
  const refuseDecision = (failure: ApiFailure): void => {
    setDecisionMessage(`Your decision was not recorded: ${failure.reason}`);
    const named = failure.prerequisites.map((prerequisite) =>
      prerequisite.remedy === ''
        ? `${prerequisite.name}: ${prerequisite.detail}`
        : `${prerequisite.name}: ${prerequisite.detail} ${prerequisite.remedy}`,
    );
    setDecisionDetail(named.length > 0 ? named : failure.fields.map((field) => field.message));
    setDecisionState('refused');
  };

  const submitChanges = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (decisionState === 'saving') return;
    if (feedback.trim() === '') {
      setFeedbackError('Say what is wrong, so the fix pass can act on it (F25-AC2).');
      return;
    }
    setFeedbackError(undefined);
    setDecisionState('saving');
    setDecisionMessage(null);
    setDecisionDetail([]);
    const result = await requestChanges(jobId, feedback.trim());
    if (!result.ok) {
      refuseDecision(result.error);
      return;
    }
    const report = result.value.changeRequest;
    setDecisionMessage(
      `Changes requested and retained as decision ${report.decisionId}. The feedback is kept against the candidate you tested, so a fix pass reads it (F25-AC2).`,
    );
    setDecisionState('done');
    setFeedback('');
    reloadDecision();
  };

  const submitAcceptance = async (): Promise<void> => {
    if (decisionState === 'saving') return;
    setDecisionState('saving');
    setDecisionMessage(null);
    setDecisionDetail([]);
    const result = await acceptCandidate(jobId, null);
    if (!result.ok) {
      refuseDecision(result.error);
      return;
    }
    const report = result.value.acceptance;
    setDecisionMessage(
      `Accepted as decision ${report.decisionId}, against head ${report.headSha}. A later change to that work shows up as stale rather than silently carrying this acceptance forward (F25-AC3).`,
    );
    setDecisionState('done');
    reloadDecision();
  };

  useEffect(() => {
    if (jobId === '') {
      setCard(null);
      setView('empty');
      return;
    }
    let current = true;
    setView('loading');
    void fetchReviewCard(jobId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setCard(null);
        setCardError(result.error.reason);
        setView('error');
        return;
      }
      setCard(result.value.card);
      setCardError(null);
      setView('ready');
    });
    return () => {
      current = false;
    };
  }, [jobId, epoch]);

  const viewText =
    view === 'error'
      ? `The review card could not be built: ${cardError ?? 'unknown reason'}`
      : view === 'empty'
        ? 'Choose a run to read its review card.'
        : view === 'loading'
          ? 'Building the review card…'
          : `Card for candidate ${card?.candidateFingerprint ?? ''}, collected ${formatTimestamp(card?.collectedAt ?? '')}.`;

  return (
    <section className="page" aria-labelledby="review-card-title">
      <h2 className="page__title" id="review-card-title">
        Review card
      </h2>
      <p className="panel__note">
        What this candidate is, what was checked, what each acceptance criterion has recorded against it, and every
        reason it is not ready. Merge and release stay your separate decisions.
      </p>
      <p
        className={view === 'error' ? 'state-line state-line--error' : 'state-line'}
        role={view === 'error' ? 'alert' : 'status'}
        aria-live={view === 'error' ? 'assertive' : 'polite'}
        data-state={view}
      >
        {viewText}
      </p>
      <div className="form__actions">
        <button className="button button--secondary" type="button" onClick={onBackToRuns}>
          Back to runs
        </button>
      </div>

      {card === null ? null : (
        <>
          <section className="panel" aria-labelledby="review-identity-title">
            <h3 className="panel__title" id="review-identity-title">
              What this candidate is
            </h3>
            <div className="detail-list">
              <div className="detail-list__row">
                <dt>Candidate</dt>
                <dd>
                  <code data-testid="card-fingerprint">{card.candidateFingerprint}</code>
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Head commit</dt>
                <dd>
                  <code data-testid="card-head-sha">{card.headSha}</code>
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Base commit</dt>
                <dd>
                  <code data-testid="card-base-sha">{card.baseSha}</code>
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Scope fingerprint</dt>
                <dd data-testid="card-scope-fingerprint">{card.scopeFingerprint}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Scope revision</dt>
                <dd data-testid="card-scope-revision">{card.scopeRevision}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Ready for your test</dt>
                <dd>
                  <StatusBadge
                    tone={card.readyForOwnerTest ? 'healthy' : 'degraded'}
                    label={card.readyForOwnerTest ? 'Ready for your test' : 'Not ready for your test'}
                    detail={
                      card.readyForOwnerTest
                        ? 'No required check is blocking. Acceptance is still your decision.'
                        : 'At least one required check is blocking. The reasons are listed below.'
                    }
                  />
                </dd>
              </div>
            </div>
          </section>

          <section className="panel" aria-labelledby="review-checks-title">
            <h3 className="panel__title" id="review-checks-title">
              Checks
            </h3>
            <p className="state-line" role="status" data-state={card.checks.length === 0 ? 'empty' : 'ready'}>
              {card.checks.length === 0
                ? 'The project profile names no checks, so nothing on this card is gated.'
                : `${card.checks.length} ${card.checks.length === 1 ? 'check is' : 'checks are'} recorded, including every check the profile requires.`}
            </p>
            {card.checks.length === 0 ? null : (
              <ul className="capability-list">
                {card.checks.map((check) => (
                  <li className="capability-list__item" key={check.checkId} data-testid="card-check">
                    <span className="profile-list__name">{check.name}</span>{' '}
                    <StatusBadge
                      tone={tone(CHECK_TONES, check.result)}
                      label={`${check.required ? 'Required check' : 'Check'} ${check.name}: ${check.result}`}
                      detail={checkDetail(check)}
                    />
                    {check.detail === null ? null : <p className="connector__problem-line">{check.detail}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="review-criteria-title">
            <h3 className="panel__title" id="review-criteria-title">
              Acceptance criteria
            </h3>
            <p className="state-line" role="status" data-state={card.criteria.length === 0 ? 'empty' : 'ready'}>
              {card.criteria.length === 0
                ? 'This candidate recorded no acceptance criteria, so nothing on it can be judged against one.'
                : `${card.criteria.length} ${card.criteria.length === 1 ? 'criterion has' : 'criteria have'} a recorded verdict.`}
            </p>
            {card.criteria.length === 0 ? null : (
              <ul className="capability-list">
                {card.criteria.map((criterion) => (
                  <li className="capability-list__item" key={criterion.criterionId} data-testid="card-criterion">
                    <span className="profile-list__name">{criterion.text}</span>{' '}
                    <StatusBadge
                      tone={tone(CRITERION_TONES, criterion.status)}
                      label={`Criterion ${criterion.criterionId}: ${criterion.status}`}
                      detail={criterionDetail(criterion)}
                    />
                    {criterion.detail === null ? null : <p className="connector__problem-line">{criterion.detail}</p>}
                  </li>
                ))}
              </ul>
            )}
            {card.pendingOwnerTestCriterionIds.length === 0 ? null : (
              <p className="state-line" role="status" data-state="ready">
                Waiting on your own test: {card.pendingOwnerTestCriterionIds.join(', ')}.
              </p>
            )}
          </section>

          <section className="panel" aria-labelledby="review-not-ready-title">
            <h3 className="panel__title" id="review-not-ready-title">
              Why this is not ready
            </h3>
            <p className="state-line" role="status" data-state={card.notReady.length === 0 ? 'empty' : 'ready'}>
              {card.notReady.length === 0
                ? 'Nothing is blocking this candidate on the checks and criteria above.'
                : `${card.notReady.length} ${card.notReady.length === 1 ? 'reason' : 'reasons'} this candidate is not ready.`}
            </p>
            {card.notReady.length === 0 ? null : (
              <ul className="connector-list" data-testid="card-not-ready">
                {card.notReady.map((reason) => (
                  <li className="connector__problem" key={reason}>
                    {reason}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="review-acceptance-title">
            <h3 className="panel__title" id="review-acceptance-title">
              Your acceptance decision
            </h3>
            {acceptance === null ? (
              <p className="state-line" role="status" data-state="empty">
                {decisionError === null
                  ? 'There is nothing to accept or reject yet: this work item has recorded no candidate.'
                  : `The acceptance state could not be read: ${decisionError}`}
              </p>
            ) : (
              <>
                <div className="detail-list">
                  <div className="detail-list__row">
                    <dt>Acceptance state</dt>
                    <dd data-testid="acceptance-state">
                      <StatusBadge
                        tone={ACCEPTANCE_TONES[acceptance.state] ?? 'neutral'}
                        label={`Acceptance: ${acceptance.state}`}
                        detail={acceptanceStateText(acceptance)}
                      />
                    </dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Candidate decided</dt>
                    <dd>
                      <code data-testid="acceptance-candidate">{acceptance.candidateId}</code>
                    </dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Retained feedback</dt>
                    <dd data-testid="acceptance-retained">
                      {acceptance.retainedFeedback.length === 0
                        ? 'No change feedback has been retained against this candidate.'
                        : acceptance.retainedFeedback.map((entry) => entry.feedback).join(' — ')}
                    </dd>
                  </div>
                </div>

                {gate === null ? null : (
                  <p className="state-line" role="status" data-state={gate.ready ? 'ready' : 'blocked'}>
                    {gate.ready
                      ? 'Every acceptance criterion is verified, so this candidate can be accepted.'
                      : `${gate.outstandingCriterionIds.length} of ${gate.criteria.length} criteria are still outstanding: ${gate.outstandingCriterionIds.join(', ')}. Acceptance is refused until each one is verified (F25-AC1).`}
                  </p>
                )}

                <p
                  className={decisionState === 'refused' ? 'state-line state-line--error' : 'state-line'}
                  role={decisionState === 'refused' ? 'alert' : 'status'}
                  aria-live={decisionState === 'refused' ? 'assertive' : 'polite'}
                  data-testid="decision-outcome"
                  data-decision-state={decisionState}
                >
                  {decisionMessage ?? 'No acceptance decision has been made from this screen.'}
                </p>
                {decisionDetail.length === 0 ? null : (
                  <ul className="connector-list" data-testid="decision-outstanding">
                    {decisionDetail.map((line) => (
                      <li className="connector__problem" key={line}>
                        {line}
                      </li>
                    ))}
                  </ul>
                )}

                <form className="field" onSubmit={(event) => void submitChanges(event)}>
                  <Field
                    id="acceptance-reason"
                    label="What is wrong with this work"
                    value={feedback}
                    onChange={setFeedback}
                    hint="Kept against the candidate you tested, and shown to a fix pass rather than discarded (F25-AC2)."
                    error={feedbackError}
                    disabled={decisionState === 'saving'}
                    required
                  />
                  <div className="form__actions">
                    <button
                      className="button button--secondary"
                      type="submit"
                      data-testid="request-changes"
                      disabled={decisionState === 'saving'}
                    >
                      Request changes
                    </button>
                    <button
                      className="button"
                      type="button"
                      data-testid="accept-candidate"
                      disabled={decisionState === 'saving'}
                      onClick={() => void submitAcceptance()}
                    >
                      Accept this work
                    </button>
                  </div>
                </form>
                <p className="panel__note">
                  Accepting is refused while any criterion is outstanding, and the refusal names which. A green check run
                  and a healthy deployment cannot verify a criterion, so neither moves this decision (F25-AC1).
                </p>
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
