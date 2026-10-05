/**
 * Review: everything the owner looks at before deciding, and the two decisions v0.1 ends at.
 *
 * This screen has one job beyond rendering: it must not let anything look more settled than it
 * is. Each rule below exists because a specific wrong answer becomes reachable without it.
 *
 *   - **The card is read whole, and the server owns all of it.** One `GET .../review`, never
 *     assembled from several reads. Readiness, staleness, eligibility and the decision arrive
 *     from one projection computed in one pass, so a screen that stitched its own version from
 *     parts could show a state the server would never return (F24-AC2).
 *   - **`currentOutcome` is what counts.** Every evidence row renders through `readEvidence`,
 *     which derives the verdict from the row's own staleness rather than from what the source
 *     recorded at the time. A `passed` for a commit the candidate has left reads `Stale`, in
 *     amber, with a line naming the commit it was recorded for — never green, and never greyed
 *     into irrelevance (F20-AC3, F24-AC3).
 *   - **Stale decisions are shown.** If the owner accepted something and the candidate then
 *     moved, the acceptance is displayed with the reason it no longer applies. Quietly dropping
 *     it would leave them believing they approved a commit nobody reviewed (F25-AC3, F27-AC3).
 *   - **Pending owner tests are the owner's own work.** Each one gets explicit Pass and Fail
 *     controls, per criterion, and nothing else on this screen can settle them. After a record,
 *     the card is **read back from the backend** rather than patched locally: the card is the
 *     authority, the write's own response is not what the next decision may be taken against,
 *     and a re-read is what recomputes eligibility (F23-AC1, F25-AC4).
 *   - **Accept is a request, not a permission.** The control is enabled only when the backend
 *     says `readyForAcceptance`, and the panel says that this display is informational because
 *     the decision endpoint re-checks and can refuse. Nothing here ever flips local state to
 *     accepted; an acceptance is only ever shown after the card has been re-read and carries
 *     one (F24-AC3, F25-AC3).
 *   - **A refused decision says so and reloads.** A `Conflict` names which fact moved and the
 *     card is re-read, because the submission was prepared against a build this screen is no
 *     longer showing. Typed feedback survives every refusal (F24-AC4, N03-AC3).
 *   - **There is no step after this one.** v0.1 ends at Accepted or Changes Requested. There is
 *     no merging, no deployment and no release control here, and the decision panel says where
 *     the product ends so the absence is a statement rather than an omission (mvp-spec 3,
 *     F03-AC5).
 *
 * The states a reader has to be able to tell apart are kept apart: no project, no candidate,
 * loading, refused, unreachable, and a card that is itself stale. A refusal never destroys what
 * the owner typed.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { MvpReviewCardView, ReviewOwnerTestView } from '../../server/contracts.ts';
import { formatTimestamp } from '../api-client.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';
import {
  readProviderChecks,
  readReviewCard,
  recordDecision,
  recordOwnerTest,
  type MvpFailure,
} from './mvp-client.ts';
import {
  canRequestChanges,
  decisionFeedback,
  domId,
  readAcceptanceGate,
  readCheck,
  readDecision,
  readDecisionRefusal,
  readEvidence,
  readOwnerTestRefusal,
  readStaleDecisions,
  type PendingRefusal,
} from './review-model.ts';
import { CriteriaPanel } from './CriteriaPanel.tsx';

export interface ReviewScreenProps {
  /** The session's active project, or null when the owner has chosen none (F02-AC1). */
  readonly projectId: string | null;
  /** The candidate under review, or null when nothing has been opened yet. */
  readonly candidateId: string | null;
  /** Bumped by the shell when the owner asks everything to reload. */
  readonly epoch?: number;
  /** Offers a way back to the board when there is nothing to review. */
  readonly onChooseCandidate?: () => void;
}

/** What the screen is showing, as states a reader must be able to tell apart (N03-AC1). */
type ScreenState =
  | { readonly kind: 'no-project' }
  | { readonly kind: 'no-candidate' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'refused'; readonly failure: MvpFailure };

export function ReviewScreen({
  projectId,
  candidateId,
  epoch = 0,
  onChooseCandidate,
}: ReviewScreenProps): ReactElement {
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [card, setCard] = useState<MvpReviewCardView | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [decisionRefusal, setDecisionRefusal] = useState<PendingRefusal | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [providerRefusal, setProviderRefusal] = useState<MvpFailure | null>(null);
  const [feedback, setFeedback] = useState('');

  /**
   * Reads the card, and never leaves a half-state behind.
   *
   * A re-read that fails keeps the card already on screen: the card carries `collectedAt`
   * precisely so its age can be stated, and a screen that blanks the whole review because one
   * request failed is worse than one that shows the last thing the server said and admits it
   * may be out of date (F24-AC2, N03-AC1).
   */
  const load = useCallback(
    async (reason: 'initial' | 'refresh') => {
      if (projectId === null || candidateId === null) {
        setCard(null);
        setState(projectId === null ? { kind: 'no-project' } : { kind: 'no-candidate' });
        return;
      }
      if (reason === 'refresh') setRefreshing(true);
      const result = await readReviewCard(projectId, candidateId);
      setRefreshing(false);
      if (result.ok) {
        setCard(result.value);
        setState({ kind: 'ready' });
        return;
      }
      setState({ kind: 'refused', failure: result.error });
    },
    [candidateId, projectId],
  );

  useEffect(() => {
    setDecisionRefusal(null);
    setProviderRefusal(null);
    setFeedback('');
    void load('initial');
  }, [load, epoch]);

  /** The card is re-read rather than patched after a write. It is the authority (F24-AC2). */
  const afterWrite = useCallback(async () => {
    await load('refresh');
  }, [load]);

  const recordTest = useCallback(
    async (test: ReviewOwnerTestView, result: 'passed' | 'failed', note: string | null): Promise<MvpFailure | null> => {
      if (projectId === null || candidateId === null) return null;
      const outcome = await recordOwnerTest({ projectId, candidateId, criterionId: test.criterionId, result, note });
      if (outcome.ok) {
        // Re-read rather than trusting the write's own response: the card recomputes eligibility,
        // and the state the next decision may be taken against is the one the server reads back.
        await afterWrite();
        return null;
      }
      const reading = readOwnerTestRefusal(outcome.error);
      // A refusal that says the card on screen is not the card a write binds to needs a re-read.
      if (reading.mustReloadCard) await afterWrite();
      return outcome.error;
    },
    [afterWrite, candidateId, projectId],
  );

  const decide = useCallback(
    async (decision: 'accepted' | 'changes_requested'): Promise<void> => {
      if (projectId === null || candidateId === null || card === null) return;
      setDecisionRefusal(null);
      const outcome = await recordDecision({
        projectId,
        candidateId,
        decision,
        // Bound to the card on screen, read at the moment of pressing. This is what turns a
        // decision taken from an outdated card into a Conflict rather than a decision about
        // whatever the candidate has become (F24-AC4, F25-AC3).
        expectedHeadSha: card.candidate.headSha,
        expectedContractRevision: card.contract.revision,
        feedback: decisionFeedback(feedback),
      });
      if (outcome.ok) {
        // Nothing here sets an accepted state of its own. The card comes back from the server and
        // the panel reads it; if the server did not record a decision, nothing claims one did.
        await afterWrite();
        return;
      }
      const reading = readDecisionRefusal(outcome.error);
      setDecisionRefusal({ decision, reading });
      if (reading.mustReloadCard) await afterWrite();
    },
    [afterWrite, candidateId, card, feedback, projectId],
  );

  const unreachable = state.kind === 'refused' && !state.failure.reachable;

  return (
    <div className="page" data-testid="review-screen">
      <header className="page__header">
        <h2 className="page__title">Review</h2>
        <p className="panel__note">
          One candidate, one commit, and the observations that describe it. This is where v0.1 ends: an
          acceptance, or a request for changes.
        </p>
      </header>

      {state.kind === 'no-project' ? (
        <p className="state-line" data-state="empty">
          No project is selected, so there is nothing to review. Choose a project first — every fact on this
          screen belongs to one.
        </p>
      ) : null}

      {state.kind === 'no-candidate' ? (
        <div className="state-line" data-state="empty">
          <p className="panel__note">
            No candidate has been opened. A review card is about one commit of one candidate, so there is
            nothing to show until one is chosen.
          </p>
          {onChooseCandidate === undefined ? null : (
            <p className="form__actions">
              <button className="button button--secondary" type="button" onClick={onChooseCandidate}>
                Choose a candidate to review
              </button>
            </p>
          )}
        </div>
      ) : null}

      {state.kind === 'loading' ? (
        <p className="state-line" role="status" aria-live="polite" data-state="loading">
          Reading the review card…
        </p>
      ) : null}

      {state.kind === 'refused' && card === null ? (
        <div className="state-line state-line--error" role="alert" data-state="error">
          <p className="panel__note">
            <strong>{unreachable ? 'Disconnected.' : 'The server refused to answer.'}</strong> {state.failure.reason}
          </p>
          <p className="form__actions">
            <button className="button button--secondary" type="button" onClick={() => void load('refresh')}>
              Read the card again
            </button>
          </p>
        </div>
      ) : null}

      {card === null ? null : (
        <>
          {refreshing ? (
            <p className="state-line" role="status" aria-live="polite" data-state="refreshing">
              Reading the card again…
            </p>
          ) : null}

          {state.kind === 'refused' ? (
            <p className="state-line state-line--error" role="alert" data-state="error">
              <strong>{unreachable ? 'Disconnected.' : 'The server refused.'}</strong> {state.failure.reason} What is
              on screen was collected at {formatTimestamp(card.collectedAt)} and may no longer be current.
            </p>
          ) : null}

          <StalenessNotice card={card} />

          <SubjectPanel card={card} />

          <ChecksPanel card={card} />

          <CriteriaPanel
            card={card}
            projectId={projectId ?? ''}
            candidateId={candidateId ?? ''}
            onRecord={recordTest}
          />

          <EvidencePanel card={card} />

          <StaleDecisionsPanel card={card} />

          <DecisionPanel
            card={card}
            feedback={feedback}
            onFeedback={setFeedback}
            refusal={decisionRefusal}
            onDecide={decide}
          />

          <ProviderReadPanel
            busy={verifying}
            refusal={providerRefusal}
            onReadChecks={async () => {
              if (projectId === null || candidateId === null) return;
              setVerifying(true);
              setProviderRefusal(null);
              const outcome = await readProviderChecks({ projectId, candidateId });
              setVerifying(false);
              if (!outcome.ok) {
                // A provider failure records nothing. Reporting that as "no failures" is the one
                // reading this control must never allow (F03-AC2, F20-AC2).
                setProviderRefusal(outcome.error);
                return;
              }
              await afterWrite();
            }}
          />
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The card's own staleness summary, in words, when there is any.
 *
 * The summary is derived by the projection from the same rows rendered below, so this panel
 * quotes it rather than recomputing it. It leads the page because it is the one thing that
 * changes how every row under it should be read (F20-AC3, F24-AC2).
 */
function StalenessNotice({ card }: { readonly card: MvpReviewCardView }): ReactElement | null {
  if (!card.staleness.stale) return null;
  const observations = card.staleness.staleEvidenceIds.length;
  const decisions = card.staleness.staleDecisionIds.length;
  return (
    <section className="state-line" aria-labelledby="review-stale-heading" data-state="stale">
      <h3 className="panel__title" id="review-stale-heading">
        This candidate moved after some of what is below was recorded
      </h3>
      <ul>
        {card.staleness.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <p className="panel__note">
        {`${String(observations)} recorded observation${observations === 1 ? '' : 's'} and ${String(decisions)} decision${decisions === 1 ? '' : 's'} no longer describe the commit on screen. They are shown as what they were, and they count for nothing.`}
      </p>
    </section>
  );
}

/** What is under review: the request, the contract revision, the exact candidate, the policy. */
function SubjectPanel({ card }: { readonly card: MvpReviewCardView }): ReactElement {
  return (
    <section className="panel" aria-labelledby="review-subject-heading">
      <h3 className="panel__title" id="review-subject-heading">
        What you are reviewing
      </h3>
      <p>{card.request.title}</p>
      <p className="panel__note">{card.request.description}</p>

      <dl className="detail-list">
        <div className="detail-list__row">
          <dt>Request</dt>
          <dd>
            <code>{card.request.requestId}</code>
          </dd>
        </div>
        <div className="detail-list__row">
          <dt>Contract revision</dt>
          <dd>
            <code>
              {card.contract.contractId} revision {String(card.contract.revision)}
            </code>{' '}
            ({card.contract.status})
            {card.contract.approval.approvedAt === null
              ? ' — not approved'
              : ` — approved ${formatTimestamp(card.contract.approval.approvedAt)}`}
            {card.candidate.contractRevision === card.contract.revision
              ? ''
              : ` — the candidate was built against revision ${String(card.candidate.contractRevision)}`}
          </dd>
        </div>
        <div className="detail-list__row">
          <dt>Candidate</dt>
          <dd>
            <code>{card.candidate.candidateId}</code>
          </dd>
        </div>
        <div className="detail-list__row">
          <dt>Commit under review</dt>
          <dd>
            {/*
              The full 40-character SHA, never abbreviated and never replaced by a branch name.
              This is the only identity a decision binds to, and an abbreviation is not one
              (mvp-spec 3, F24-AC4).
            */}
            <code data-testid="review-head-sha">{card.candidate.headSha}</code>
          </dd>
        </div>
        <div className="detail-list__row">
          <dt>Pull request</dt>
          <dd>{pullRequestSentence(card)}</dd>
        </div>
        <div className="detail-list__row">
          <dt>Provider state observed</dt>
          <dd>{formatTimestamp(card.candidate.observedAt)}</dd>
        </div>
        <div className="detail-list__row">
          <dt>Card collected</dt>
          <dd>{formatTimestamp(card.collectedAt)}</dd>
        </div>
        <div className="detail-list__row">
          <dt>Verification policy</dt>
          <dd>{policySentence(card)}</dd>
        </div>
      </dl>

      {card.contract.scope.length === 0 ? null : (
        <details>
          <summary>{`In scope (${String(card.contract.scope.length)})`}</summary>
          <ul>
            {card.contract.scope.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      )}
      {card.contract.outOfScope.length === 0 ? null : (
        <details>
          <summary>{`Out of scope (${String(card.contract.outOfScope.length)})`}</summary>
          <ul>
            {card.contract.outOfScope.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * The provider's own words about the pull request.
 *
 * `pullRequestState` is passed through rather than interpreted, and a provider that reported no
 * address is said to have reported none — not rendered as a link with nothing behind it, which is
 * the shape a dead link takes (F24-AC5).
 */
function pullRequestSentence(card: MvpReviewCardView): string {
  const parts: string[] = [];
  parts.push(
    card.candidate.pullRequestNumber === 0
      ? 'No pull request number was recorded.'
      : `#${String(card.candidate.pullRequestNumber)} in ${card.candidate.repository}, against ${card.candidate.baseBranch}`,
  );
  parts.push(`Provider state: ${card.candidate.pullRequestState}${card.candidate.draft ? ' (draft)' : ''}.`);
  parts.push(
    card.candidate.pullRequestUrl === ''
      ? 'The provider reported no address for it.'
      : `The provider reports this address: ${card.candidate.pullRequestUrl}`,
  );
  return parts.join(' ');
}

/** The policy as configuration, quoted, with no judgement added about what it means. */
function policySentence(card: MvpReviewCardView): string {
  const parts: string[] = [
    card.policy.requiredAutomatedCheckIds.length === 0
      ? 'No automated check is required.'
      : `Required automated checks: ${card.policy.requiredAutomatedCheckIds.join(', ')}.`,
  ];
  parts.push(
    card.policy.ownerTestBlocksReview
      ? 'An outstanding owner test blocks opening the review.'
      : 'An outstanding owner test does not block opening the review.',
  );
  parts.push(card.policy.ownerTestBlocksDelivery ? 'It blocks delivery.' : 'It does not block delivery.');
  return parts.join(' ');
}

/**
 * The checks the provider reported, each against the observation it rests on.
 *
 * A green check is the provider's statement about a commit. It verifies an acceptance criterion
 * only when the contract bound that criterion to it by name, which is what each criterion below
 * states — so the two lists are deliberately shown together rather than merged (F23-AC1).
 */
function ChecksPanel({ card }: { readonly card: MvpReviewCardView }): ReactElement {
  return (
    <section className="panel" aria-labelledby="review-checks-heading">
      <h3 className="panel__title" id="review-checks-heading">
        Checks
      </h3>
      {card.checks.length === 0 ? (
        <p className="panel__note">This project&rsquo;s profile configures no checks for this candidate.</p>
      ) : (
        <ul className="capability-list">
          {card.checks.map((check) => {
            const reading = readCheck(check, card.policy.requiredAutomatedCheckIds);
            return (
              <li className="capability-list__item" key={check.checkId} data-stale={check.result === 'stale' ? 'true' : 'false'}>
                <p>
                  <strong>{check.checkId}</strong>{' '}
                  {/*
                    The requirement flag is a badge detail only when it applies. A detail of
                    "required by the profile" on every check would say nothing about the checks it
                    does not (N03-AC1).
                  */}
                  <StatusBadge
                    tone={reading.tone}
                    label={reading.label}
                    {...(check.required ? { detail: 'required by the profile' } : {})}
                  />
                  {check.blocking ? <> {<StatusBadge tone="revoked" label="Blocks acceptance" />}</> : null}
                </p>
                <p className="panel__note">{reading.standing}</p>
                <p className="panel__note">
                  {check.source === null
                    ? 'No run has reported where this check would run.'
                    : `Reported by ${check.source}. ${
                        check.evidenceId === null
                          ? 'No observation stands behind this line.'
                          : `Standing on evidence ${check.evidenceId}.`
                      }`}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Every recorded observation: what it means now, and what the source said at the time. */
function EvidencePanel({ card }: { readonly card: MvpReviewCardView }): ReactElement {
  return (
    <section className="panel" aria-labelledby="review-evidence-heading">
      <h3 className="panel__title" id="review-evidence-heading">
        Evidence
      </h3>
      <p className="panel__note">
        Each row keeps two facts apart: what the source said at the time, and what counts for the commit on
        screen now. A row that counts is evidence for the commit named above. A row that does not is history.
      </p>
      {card.evidence.length === 0 ? (
        <p className="panel__note" data-state="empty">
          Nothing has been observed for this candidate yet.
        </p>
      ) : (
        <ul className="capability-list">
          {card.evidence.map((row) => (
            <li
              className="capability-list__item"
              key={row.evidenceId}
              data-stale={row.countsForCurrentCandidate ? 'false' : 'true'}
            >
              <EvidenceRow row={row} candidateHeadSha={card.candidate.headSha} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One evidence row. The badge reads what counts now; the recorded outcome is a second line. */
function EvidenceRow({
  row,
  candidateHeadSha,
}: {
  readonly row: MvpReviewCardView['evidence'][number];
  readonly candidateHeadSha: string;
}): ReactElement {
  const reading = readEvidence(row, candidateHeadSha);
  return (
    <>
      <p>
        <strong>{row.evidenceId}</strong> from {row.source}
        {row.criterionId === null ? '' : ` for criterion ${row.criterionId}`}
        {row.checkId === null ? '' : ` for check ${row.checkId}`} <StatusBadge tone={reading.tone} label={reading.label} />
      </p>
      <p className="panel__note">
        {reading.standing}
        {reading.history === null ? '' : ` ${reading.history}`}
      </p>
      {reading.staleReasons.length === 0 ? null : (
        <ul className="panel__note">
          {reading.staleReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <p className="panel__note">
        {reading.observedCommit === null
          ? 'The source attributed this to no commit.'
          : reading.observedAnotherCommit
            ? `Recorded against ${reading.observedCommit}, which is not the commit on screen.`
            : 'Recorded against the commit on screen.'}
        {row.contractRevision === null ? '' : ` Contract revision ${String(row.contractRevision)}.`}
        {row.observedAt === null ? '' : ` Observed ${formatTimestamp(row.observedAt)}.`}
      </p>
      {row.detail === null || row.detail === '' ? null : <p className="panel__note">{row.detail}</p>}
      {row.artifactRef === null ? null : (
        <p className="panel__note">
          Artifact reference as recorded: <code>{row.artifactRef}</code>
        </p>
      )}
    </>
  );
}

/** Decisions a later push invalidated. Shown, because hiding them would be a lie of omission. */
function StaleDecisionsPanel({ card }: { readonly card: MvpReviewCardView }): ReactElement | null {
  const readings = readStaleDecisions(card.decision.staleDecisions);
  if (readings.length === 0) return null;
  return (
    <section className="panel" aria-labelledby="review-stale-decisions-heading" data-state="stale">
      <h3 className="panel__title" id="review-stale-decisions-heading">
        Earlier decisions that no longer apply
      </h3>
      <p className="panel__note">
        These decisions are real and they are recorded. They name commits this candidate has since left, so
        they authorise nothing today.
      </p>
      <ul className="capability-list">
        {readings.map((reading) => (
          <li className="capability-list__item" key={reading.decisionId}>
            <p>
              <StatusBadge tone={reading.tone} label={reading.label} />
            </p>
            <p className="panel__note">
              It names commit <code>{reading.candidateHeadSha}</code> at contract revision{' '}
              {String(reading.contractRevision)}. {reading.reason}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The decision, and the only two decisions v0.1 has.
 *
 * `Request changes` is always available — that is what makes "not ready" expressible, and it is
 * why a change request is not gated on eligibility (F23-AC1, F25-AC1). `Accept` is enabled only
 * when the backend said the candidate is eligible, and the panel states that this display is
 * informational: the endpoint reads the card again and refuses whatever still refuses. The
 * button is a request, not a permission (F24-AC3, F25-AC3).
 *
 * There is no control here for anything after the decision. The sentence that says so is part of
 * the panel on purpose: an owner looking for the next step should be told there isn't one rather
 * than left to wonder (mvp-spec 3, F03-AC5).
 */
function DecisionPanel({
  card,
  feedback,
  onFeedback,
  refusal,
  onDecide,
}: {
  readonly card: MvpReviewCardView;
  readonly feedback: string;
  readonly onFeedback: (value: string) => void;
  readonly refusal: PendingRefusal | null;
  readonly onDecide: (decision: 'accepted' | 'changes_requested') => Promise<void>;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const gate = readAcceptanceGate(card.eligibility);
  const reading = readDecision(card.decision, card.candidate.headSha);
  const alreadyAuthorises = reading.outcome === 'accepted' && reading.authorizesCurrentCandidate;
  const feedbackId = domId('decision-feedback', card.candidate.candidateId);

  return (
    <section className="panel" aria-labelledby="review-decision-heading">
      <h3 className="panel__title" id="review-decision-heading">
        Your decision
      </h3>

      <p>
        <StatusBadge tone={reading.tone} label={reading.label} />
      </p>
      <p className="panel__note">{reading.summary}</p>
      {reading.feedback === null ? null : <p className="panel__note">{`You wrote: ${reading.feedback}`}</p>}

      <p>
        <StatusBadge tone={gate.tone} label={gate.label} />
      </p>
      <p className="panel__note">{gate.standing}</p>

      {gate.ownerActions.length === 0 ? null : (
        <>
          <h4>Your own steps</h4>
          <ul>
            {gate.ownerActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </>
      )}

      {gate.acceptanceBlockers.length === 0 ? null : (
        <>
          <h4>Outstanding before this candidate can be accepted</h4>
          <ul>
            {gate.acceptanceBlockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </>
      )}

      <div className="field">
        <label className="field__label" htmlFor={feedbackId}>
          What should change (required to request changes)
        </label>
        <textarea
          className="field__input"
          id={feedbackId}
          name={feedbackId}
          rows={3}
          value={feedback}
          aria-describedby={`${feedbackId}-hint`}
          disabled={busy}
          onChange={(event) => onFeedback(event.target.value)}
        />
        <p className="field__hint" id={`${feedbackId}-hint`}>
          A change request with nothing in it has nothing for the fix pass to act on, so it is refused. What
          you type here survives a refusal.
        </p>
      </div>

      {refusal === null ? null : <DecisionRefusalNotice refusal={refusal} />}

      <div className="form__actions">
        <button
          className="button button--secondary"
          type="button"
          disabled={busy || !canRequestChanges(feedback)}
          onClick={() => {
            setBusy(true);
            void onDecide('changes_requested').finally(() => setBusy(false));
          }}
        >
          {busy ? 'Recording…' : 'Request changes'}
        </button>
        <button
          className="button"
          type="button"
          disabled={busy || !gate.readyForAcceptance || alreadyAuthorises}
          onClick={() => {
            setBusy(true);
            void onDecide('accepted').finally(() => setBusy(false));
          }}
        >
          {alreadyAuthorises ? 'Already accepted for this commit' : 'Accept this candidate'}
        </button>
      </div>
      <p className="panel__note">
        {alreadyAuthorises
          ? 'You accepted this exact commit. An acceptance of an earlier commit authorises nothing, so this is the only one that counts.'
          : 'Accept is offered only while the server says this candidate is eligible, and the server checks that again when you decide. Either decision binds the commit named above and nothing else.'}
      </p>
      <p className="panel__note">That is where this version ends. Nothing here does anything further to the candidate.</p>
    </section>
  );
}

/**
 * A refused decision, rendered as what it is.
 *
 * The headline denies that anything was recorded, the server's own words follow, and a conflict
 * adds the two values it moved between — expected and actual, both unabbreviated — so the owner
 * can see which build they decided about and which one the server holds (F24-AC4, F25-AC2).
 */
function DecisionRefusalNotice({ refusal }: { readonly refusal: PendingRefusal }): ReactElement {
  return (
    <div className="state-line state-line--error" role="alert" data-state="error">
      <p className="panel__note">
        <strong>{refusal.reading.headline}</strong> {refusal.reading.detail}
      </p>
      {refusal.reading.moved === null ? null : (
        <p className="panel__note">
          {`${refusal.reading.moved.subject} you decided about: ${refusal.reading.moved.expected}. What the server holds: ${refusal.reading.moved.actual}.`}
        </p>
      )}
      {refusal.reading.fields.length === 0 ? null : (
        <ul>
          {refusal.reading.fields.map((field) => (
            <li key={field.path}>{`${field.path}: ${field.message}`}</li>
          ))}
        </ul>
      )}
      {refusal.reading.prerequisites.length === 0 ? null : (
        <ul>
          {refusal.reading.prerequisites.map((prerequisite) => (
            <li key={`${prerequisite.name}:${prerequisite.detail}`}>
              {`${prerequisite.name}: ${prerequisite.detail} ${prerequisite.remedy}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Re-reading the provider's checks.
 *
 * This is the remedy for stale automated evidence, and it belongs here because the review screen
 * is where a stale pass would mislead. The control asks the server to read the provider; it never
 * states a result, and a provider failure is reported as a provider failure with nothing recorded
 * — never as "no failures" (F20-AC2, F03-AC2).
 */
function ProviderReadPanel({
  busy,
  refusal,
  onReadChecks,
}: {
  readonly busy: boolean;
  readonly refusal: MvpFailure | null;
  readonly onReadChecks: () => Promise<void>;
}): ReactElement {
  return (
    <section className="panel" aria-labelledby="review-provider-heading">
      <h3 className="panel__title" id="review-provider-heading">
        Re-read the provider
      </h3>
      <p className="panel__note">
        Asks GitHub what its checks say about the commit on screen and records what the provider reported. The
        result comes from the provider and from nothing typed here.
      </p>
      {refusal === null ? null : (
        <p className="state-line state-line--error" role="alert" data-state="error">
          <strong>Nothing was recorded.</strong> {refusal.reason}
          {refusal.code === 'Unavailable'
            ? ' This deployment could not read the provider, so no observation was made and nothing about this candidate changed.'
            : ''}
        </p>
      )}
      <div className="form__actions">
        <button className="button button--secondary" type="button" disabled={busy} onClick={() => void onReadChecks()}>
          {busy ? 'Reading…' : 'Read GitHub checks again'}
        </button>
      </div>
    </section>
  );
}
