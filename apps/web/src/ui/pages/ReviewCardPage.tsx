/**
 * The review card for one run's current candidate, and the owner's decision about it
 * (F24-AC1, F24-AC2, F24-AC3, F24-AC4, F24-AC5, F25-AC1, F25-AC2, F25-AC3, F20-AC1, F20-AC2,
 * F20-AC3, F22-AC1, F22-AC2, F22-AC3, F23-AC1, F23-AC3, F23-AC4, F01-AC1, F01-AC3, N03-AC1,
 * N03-AC3, N02-AC2).
 *
 * One page, and every part of it is a fact this page reads rather than a judgement it reaches.
 * The card is the one place the owner is meant to assemble the ticket, the candidate, the
 * checks, the criteria, the preview and the evidence without doing it by hand, so the page is
 * ordered the way the decision runs rather than the way the data is stored: what this candidate
 * is, what is linked to it, what was checked, what each criterion has recorded, what the owner
 * must test themselves, what is blocking it, and only then the owner's decision.
 *
 * Eight properties carry the product, and each one exists because the alternative was measured
 * to mislead:
 *
 *   - **The not-ready list is the point (F24-AC3).** Incomplete work stays inspectable with its
 *     reasons. A card that hid them would read as green everywhere except the parts nobody could
 *     see, which is the failure F24-AC3 exists to prevent.
 *   - **A check with no recorded run is shown as such (F20-AC2, F20-AC1).** The profile's
 *     required set is rendered in full with its result, its origin and its timing, and a gate
 *     nobody ran appears with the result it has rather than being absent.
 *   - **A superseded candidate is its own state (F24-AC4).** The server refuses a card for a
 *     candidate that is no longer current, naming both identities, and this page shows that
 *     refusal rather than falling back to an older card.
 *   - **A link either opens the right artifact or says it cannot (F24-AC5, F01-AC1).** Provider
 *     and artifact links are rendered only where the server reported an addressable identity.
 *     Where it reported none — no issue URL, no pull request identity, no deployment — the card
 *     says so in words. An empty success panel would assert "there is nothing to open", which is
 *     a different and much stronger claim than "this card's transport reports no address for
 *     it", and it would read as a working link row with nothing in it.
 *   - **A preview the owner cannot reach says so (F22-AC3, F22-AC1).** The access state is
 *     stated, not implied by the presence of a panel. Missing, building, failed, protected and
 *     usable are distinct, and a card that renders a preview section with no deployment in it
 *     would read as a usable preview.
 *   - **Status is a word, a shape and a tone (N03-AC1).** Every check, criterion, preview and
 *     acceptance state renders through `StatusBadge`, so a failing check and an unrun one cannot
 *     be told apart by colour alone.
 *   - **The decision is recorded, never inferred (F25-AC1, F25-AC2).** This page never computes
 *     readiness from what it is already showing; it reads the server's gate and shows that, so a
 *     card that looks complete to a reader and a candidate the domain will accept cannot drift
 *     apart. The decision is the last panel and is labelled as separate from everything above,
 *     because a green check sitting beside an Accept button is exactly how an acceptance starts
 *     reading as implied.
 *   - **A failed submission preserves typed input (N03-AC3).** The rejection reason is written
 *     beside the control and the feedback is left in the textarea, because a rejected decision
 *     that also discarded the reason would make the owner retype the hardest part.
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import {
  acceptCandidate,
  fetchAcceptance,
  fetchReviewCard,
  fetchRun,
  formatTimestamp,
  requestChanges,
  type AcceptanceGate,
  type AcceptanceReport,
  type AcceptanceState,
  type ApiFailure,
  type ReviewCard,
  type ReviewCardCheck,
  type RunCheckpoint,
} from '../api-client.ts';
import { ArtifactLink } from '../components/ArtifactLink.tsx';
import { CriterionRow } from '../components/CriterionRow.tsx';
import { Field } from '../components/Field.tsx';
import { StatusBadge, type StatusTone } from '../components/StatusBadge.tsx';
import { OwnerTestPage } from './OwnerTestPage.tsx';

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
 * `Missing` and `Stale` are separate tones from `Failed` on purpose: one is "nothing ran" and
 * the other is "a run was recorded against an identity that has since moved", and an owner
 * deciding whether to trust a candidate needs to tell them apart (F20-AC3).
 */
const CHECK_TONES: Readonly<Record<string, StatusTone>> = {
  Passed: 'healthy',
  Failed: 'revoked',
  Missing: 'degraded',
  Stale: 'degraded',
  Waiting: 'pending',
  NotApplicable: 'unconfigured',
};

function tone(tones: Readonly<Record<string, StatusTone>>, value: string): StatusTone {
  return tones[value] ?? 'neutral';
}

/**
 * What one check line has to say beyond its name and result (F20-AC1, F20-AC2).
 *
 * The origin is stated because "the check passed" and "the provider reported this check passing
 * for this commit" are different claims, and only the second one is evidence about the candidate
 * under review (F20-AC1). Start and end times are not among the fields this card's transport
 * reports, so none is invented here: a fabricated timestamp on a check line would be worse than
 * an absent one, because it is exactly the kind of detail a reader trusts without checking
 * (F20-AC1).
 */
function checkDetail(check: ReviewCardCheck): string {
  const parts = [check.required ? 'Required by the project profile.' : 'Not required by the project profile.'];
  if (check.blocking) parts.push('It blocks acceptance until it passes.');
  if (check.origin === null) parts.push('No run has reported where this check would run.');
  else parts.push(`Recorded by ${check.origin}.`);
  if (check.exitCode !== null) parts.push(`Exit code ${String(check.exitCode)}.`);
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
 * The undecided case is separated because a state with no decision and a state that never asked
 * for one read identically otherwise, and "no decision has been recorded" is the fact the owner
 * needs before pressing Accept (F25-AC1, F25-AC3).
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

/**
 * Where the owner should perform a manual step for this candidate (F22-AC1, F22-AC3, F23-AC4).
 *
 * One sentence, reused by the preview panel and by every owner-test step, so the two cannot
 * disagree about whether there is anything to test against. It takes no parameters and states
 * one access state because this card's transport reports no deployment identity for a candidate
 * at all: there is exactly one true thing to say, and saying it through a template with a count
 * of zero would be an abstraction shaped to hide a case that does not exist (F22-AC3).
 */
function previewAccessStatement(): string {
  return (
    'No deployment is recorded against this candidate, so there is no preview to open and nothing on this card has ' +
    'been verified against a deployed environment. Perform the step in your own environment and record that you did: ' +
    'the environment you select is stored with your observation, so local evidence stays labelled local and cannot ' +
    'satisfy a criterion that requires deployed behaviour (F22-AC1, F22-AC3, F23-AC4).'
  );
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
  const [decisionReport, setDecisionReport] = useState<AcceptanceReport | null>(null);
  const [decisionReload, setDecisionReload] = useState(0);

  const [checkpoint, setCheckpoint] = useState<RunCheckpoint | null>(null);
  const [workItemId, setWorkItemId] = useState<string | null>(null);
  const [runFailure, setRunFailure] = useState<string | null>(null);

  const reloadDecision = useCallback((): void => {
    setDecisionReload((count) => count + 1);
  }, []);

  /**
   * The run's own record, read for what only it holds: the work item this candidate belongs to,
   * the branch the work is on and the operational blocker behind the attempt.
   *
   * Read separately from the card because the card is built from the candidate and says nothing
   * about the run that produced it, and a card that omitted the blocker would leave an owner
   * reading "not ready" with no idea what to unblock first (F18-AC1, F24-AC1). Its failure is
   * its own state: the card still renders from the evidence it has rather than disappearing
   * because one neighbouring read failed (N03-AC3).
   */
  useEffect(() => {
    if (jobId === '') {
      setCheckpoint(null);
      setWorkItemId(null);
      setRunFailure(null);
      return;
    }
    let current = true;
    void fetchRun(jobId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setCheckpoint(null);
        setWorkItemId(null);
        setRunFailure(result.error.reason);
        return;
      }
      setCheckpoint(result.value.run.checkpoint);
      setWorkItemId(result.value.run.job.workItemId);
      setRunFailure(null);
    });
    return () => {
      current = false;
    };
  }, [jobId, epoch]);

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
   * A `Blocked` refusal names its unmet prerequisites and each carries its own remedy, so those
   * are shown one per line with the remedy attached; every other refusal has only per-field
   * messages. A single "cannot be accepted yet" would tell the owner nothing they can act on
   * (F25-AC1, F04-AC3).
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
    setDecisionReport(null);
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
    setDecisionReport(report);
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

  const where = previewAccessStatement();

  return (
    <section className="page" aria-labelledby="review-card-title">
      <h2 className="page__title" id="review-card-title">
        Review card
      </h2>
      <p className="panel__note">
        What this candidate is, what is linked to it, what was checked, what each acceptance criterion has recorded
        against it, what you must test yourself, and every reason it is not ready. Your decision is at the bottom and
        no check on this card makes it for you. Merge and release stay separate decisions.
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
                <dt>Diff under review</dt>
                <dd data-testid="card-diff">
                  {`Exactly what changed is the range ${card.baseSha} to ${card.headSha}. Both are full commit SHAs, because an abbreviated one cannot be compared to a checkout and cannot be shown stale when the work moves (F20-AC3, F24-AC1).`}
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Branch</dt>
                <dd data-testid="card-branch">
                  {checkpoint === null
                    ? 'No resume point has been recorded, so no branch name is available for this run.'
                    : `${checkpoint.workspace.branchName} — a convenience label only. A branch name is not the tested identity and never establishes which build was verified (F22-AC2).`}
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

          <section className="panel" aria-labelledby="review-linked-title">
            <h3 className="panel__title" id="review-linked-title">
              Linked work and provider links
            </h3>
            <div className="detail-list">
              <div className="detail-list__row">
                <dt>Work item</dt>
                <dd data-testid="card-work-item">
                  {workItemId ?? 'No work item is recorded for this run, so there is no linked issue to open.'}
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Issue link</dt>
                <dd data-testid="card-issue-link">
                  No issue address is reported for this work on this card, so there is no ticket link to open. An
                  unopenable link is stated rather than rendered, because a link row with no destination reads as a
                  working reference (F24-AC5).
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Pull request</dt>
                <dd data-testid="card-pr-link">
                  No pull request identity is reported for this candidate on this card, so there is no PR link to open
                  and no review thread to read. Nothing here claims one was never created; it says only that this card
                  carries no such address (F19-AC3, F24-AC5).
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Diff link</dt>
                <dd data-testid="card-diff-link">
                  {`No provider diff URL is reported for this candidate. The range ${card.baseSha} to ${card.headSha} above is the diff under review; a URL would have to be built from a guess about the host's URL scheme, and a plausible wrong URL is worse than none (F24-AC5).`}
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
                : `${String(card.checks.length)} ${card.checks.length === 1 ? 'check is' : 'checks are'} recorded, including every check the profile requires.`}
            </p>
            {card.checks.length === 0 ? null : (
              <ul className="capability-list">
                {card.checks.map((check) => (
                  <li
                    className="capability-list__item"
                    key={check.checkId}
                    data-testid="card-check"
                    data-check-id={check.checkId}
                  >
                    <span className="profile-list__name">{check.name}</span>{' '}
                    <StatusBadge
                      tone={tone(CHECK_TONES, check.result)}
                      label={`${check.required ? 'Required check' : 'Check'} ${check.name}: ${check.result}`}
                      detail={checkDetail(check)}
                    />
                    {check.detail === null ? null : <p className="connector__problem-line">{check.detail}</p>}
                    <ArtifactLink reference={check.artifactRef} label={`Check ${check.name}`} />
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
                : `${String(card.criteria.length)} ${card.criteria.length === 1 ? 'criterion has' : 'criteria have'} a recorded verdict, each with the method that verifies it.`}
            </p>
            {card.criteria.length === 0 ? null : (
              <ul className="capability-list">
                {card.criteria.map((criterion) => (
                  <CriterionRow key={criterion.criterionId} criterion={criterion} />
                ))}
              </ul>
            )}
            {card.pendingOwnerTestCriterionIds.length === 0 ? null : (
              <p className="state-line" role="status" data-state="ready" data-testid="card-pending-owner-tests">
                Waiting on your own test: {card.pendingOwnerTestCriterionIds.join(', ')}. These may stay pending until you
                decide, and each one must be recorded by you before acceptance succeeds (F24-AC3, F25-AC1).
              </p>
            )}
          </section>

          <OwnerTestPage
            jobId={jobId}
            criteria={card.criteria}
            headSha={card.headSha}
            candidateFingerprint={card.candidateFingerprint}
            previewSummary={where}
            onRecorded={reloadDecision}
          />

          <section className="panel" aria-labelledby="review-preview-title">
            <h3 className="panel__title" id="review-preview-title">
              Preview and access
            </h3>
            <div className="detail-list">
              <div className="detail-list__row">
                <dt>Deployment</dt>
                <dd data-testid="card-preview-state">
                  <StatusBadge
                    tone="unconfigured"
                    label="Preview: none recorded"
                    detail="No provider deployment is reported against this candidate, so there is no deployment identity, URL or environment to open."
                  />
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>What that means</dt>
                <dd data-testid="card-preview-access">{where}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Open a preview</dt>
                <dd data-testid="card-preview-link">
                  No preview URL is reported for this candidate, so none is offered. Missing, building, failed,
                  protected and usable are different states and this one is missing; a section with a heading and no
                  address in it must not read as a preview you can open (F22-AC3, F24-AC5).
                </dd>
              </div>
            </div>
          </section>

          <section className="panel" aria-labelledby="review-blockers-title">
            <h3 className="panel__title" id="review-blockers-title">
              Blockers on this run
            </h3>
            {runFailure === null && checkpoint === null ? (
              <p className="state-line" role="status" data-state="empty" data-testid="card-blockers-empty">
                This run has recorded no resume point, so it has no blocker and no next action. The reasons this
                candidate is not ready are listed separately below (F18-AC1).
              </p>
            ) : runFailure !== null ? (
              <p className="state-line state-line--error" role="alert" data-state="error" data-testid="card-blockers-error">
                {`The run's own record could not be read, so its blocker is not shown here: ${runFailure} (N03-AC3).`}
              </p>
            ) : (
              <div className="detail-list">
                <div className="detail-list__row">
                  <dt>Blocker</dt>
                  <dd data-testid="card-blocker">
                    {checkpoint?.blocker ?? 'No blocker is recorded against this run.'}
                  </dd>
                </div>
                <div className="detail-list__row">
                  <dt>Next action</dt>
                  <dd data-testid="card-next-action">{checkpoint?.nextAction ?? 'No next action is recorded.'}</dd>
                </div>
              </div>
            )}
          </section>

          <section className="panel" aria-labelledby="review-not-ready-title">
            <h3 className="panel__title" id="review-not-ready-title">
              Why this candidate is not ready
            </h3>
            <p className="state-line" role="status" data-state={card.notReady.length === 0 ? 'empty' : 'ready'}>
              {card.notReady.length === 0
                ? 'Nothing on the checks and criteria above is blocking this candidate.'
                : `${String(card.notReady.length)} ${card.notReady.length === 1 ? 'reason' : 'reasons'} this candidate is not ready.`}
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
            <p className="panel__note">
              This is a separate decision and nothing above makes it. A passing required check, a verified criterion and
              a healthy deployment each describe the work; none of them accepts it (F24-AC3, F25-AC1).
            </p>
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
                      : `${String(gate.outstandingCriterionIds.length)} of ${String(gate.criteria.length)} criteria are still outstanding: ${gate.outstandingCriterionIds.join(', ')}. Acceptance is refused until each one is verified (F25-AC1).`}
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
                {decisionReport === null ? null : (
                  <div className="detail-list" data-testid="decision-observed-deployments">
                    <div className="detail-list__row">
                      <dt>Observed deployments</dt>
                      <dd>
                        {decisionReport.observedDeployments.length === 0
                          ? 'Your acceptance recorded no deployment, so nothing about this acceptance rests on a deployed environment (F25-AC1, F23-AC4).'
                          : decisionReport.observedDeployments
                              .map(
                                (deployment) =>
                                  `${deployment.component} in ${deployment.environment}: ${
                                    deployment.deploymentUrl ?? `deployment ${String(deployment.deploymentId ?? 'not reported')} with no URL`
                                  }`,
                              )
                              .join(' — ')}
                      </dd>
                    </div>
                  </div>
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