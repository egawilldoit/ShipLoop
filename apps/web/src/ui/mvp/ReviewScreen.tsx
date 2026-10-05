/**
 * Review: everything the owner looks at before deciding, and the two decisions v0.1 ends at
 * (mvp-spec 3, F24-AC2, F24-AC3, F24-AC4, F25-AC1, F25-AC2, F25-AC3, F27-AC3, F23-AC1, F03-AC5,
 * F01-AC1, F02-AC2, N03-AC1).
 *
 * This screen has one job beyond rendering: it must not let anything look more settled than it
 * is. Each rule below exists because a specific wrong answer becomes reachable without it.
 *
 *   - **The card is read whole, and the server owns all of it.** One
 *     `GET .../review`, never assembled from several reads. Readiness, staleness, eligibility and
 *     the decision arrive from one projection computed in one pass, so a screen that stitched its
 *     own version from parts could show a state the server would never return (F24-AC2).
 *   - **`currentOutcome` is what counts.** Every evidence row renders through `readEvidence`,
 *     which derives the verdict from the row's own staleness rather than from what the source
 *     recorded at the time. A `passed` for a commit the candidate has left reads `Stale`, in amber,
 *     with a line naming the commit it was recorded for — never green, and never greyed into
 *     irrelevance (F20-AC3, F24-AC3).
 *   - **Eligibility is reflected, never recomputed.** `readyForOwnerReview`,
 *     `readyForAcceptance` and `authorizesCurrentCandidate` are read off the card along with their
 *     blocker lists. This screen computes nothing about readiness from criteria or checks, because
 *     a second implementation of that rule is how a candidate becomes acceptable through a surface
 *     nobody consulted (F24-AC3, F25-AC3).
 *   - **Stale decisions are shown.** If the owner accepted something and the candidate then moved,
 *     the acceptance is displayed with the reason it no longer applies. Quietly dropping it would
 *     leave them believing they approved a commit nobody reviewed (F25-AC3, F27-AC3).
 *   - **Pending owner tests are the owner's own work.** Each one gets explicit Pass and Fail
 *     controls, per criterion, and nothing else on this screen can settle them. After a record the
 *     card is **re-read from the backend** rather than patched locally: the card is the authority,
 *     the write's own response is not what the next decision may be taken against, and a re-read is
 *     what recomputes eligibility (F23-AC1, F25-AC4).
 *   - **Accept is a request, not a permission.** The control is enabled only while the backend says
 *     `readyForAcceptance`, and the panel says that this display is informational because the
 *     decision endpoint re-checks and can refuse. Nothing here flips local state to accepted; an
 *     acceptance is only ever shown after the card has been re-read and carries one (F24-AC3,
 *     F25-AC3).
 *   - **A refused decision says so and reloads.** A `Conflict` names which fact moved and the card
 *     is re-read, because the submission was prepared against a build this screen is no longer
 *     showing. Typed feedback survives every refusal (F24-AC4, N03-AC3).
 *   - **There is no step after this one.** v0.1 ends at Accepted or Changes Requested. There is no
 *     merging, no deployment and no release control here, and the decision panel says where the
 *     product ends so the absence is a statement rather than an omission (mvp-spec 3, F03-AC5).
 *
 * The states a reader has to be able to tell apart are kept apart: no project, no candidate,
 * loading, refused, unreachable, and a card that is itself stale. A refusal never destroys what the
 * owner typed.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  decideCandidate,
  fetchHome,
  fetchReview,
  recordOwnerTest,
  type DecideCandidateOutcome,
  type HomeEntry,
  type HomeProjection,
  type MvpFailure,
  type ReviewCardView,
  type ReviewOwnerTestView,
} from '../mvp-client/index.ts';
import { formatTimestamp } from '../api-client.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';
import {
  canRequestChanges,
  decisionFeedback,
  domId,
  readAcceptanceGate,
  readCheck,
  readDecision,
  readDecisionOutcome,
  readEvidence,
  readOwnerTestRefusal,
  readStaleDecisions,
  type PendingRefusal,
} from './review-model.ts';
import { CriteriaPanel } from './CriteriaPanel.tsx';
import { NoProjectSelected, ScreenEmpty, ScreenFailure, ScreenLoading, type ScreenProps } from './screen.tsx';

/** One request's candidate, as the board offers it. */
interface CandidateChoice {
  readonly key: string;
  readonly entry: HomeEntry;
}

type ScreenState =
  | { readonly kind: 'no-project' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'refused'; readonly failure: MvpFailure }
  | { readonly kind: 'ready' };

export function ReviewScreen(props: ScreenProps): ReactElement {
  const { scope, epoch } = props;
  const [choices, setChoices] = useState<readonly CandidateChoice[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [card, setCard] = useState<ReviewCardView | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [decisionRefusal, setDecisionRefusal] = useState<PendingRefusal | null>(null);
  const [providerRefusal, setProviderRefusal] = useState<MvpFailure | null>(null);
  const [feedback, setFeedback] = useState('');

  const projectScope = scope !== null && scope.kind === 'project' ? scope : null;

  /**
   * The candidates this project has, discovered from the board.
   *
   * The board is the server's own projection of which requests have a candidate, so a review
   * screen cannot be pointed at a candidate belonging to another project: there is no prop through
   * which one could arrive (F02-AC2).
   */
  const loadChoices = useCallback(async (): Promise<void> => {
    if (projectScope === null) return;
    const result = await fetchHome(projectScope);
    if (!result.ok) {
      setState({ kind: 'refused', failure: result.failure });
      return;
    }
    setChoices(candidateChoicesOf(result.value));
  }, [projectScope]);

  useEffect(() => {
    void loadChoices();
  }, [loadChoices, epoch]);

  useEffect(() => {
    if (choices.length === 0) {
      setSelectedKey(null);
      return;
    }
    setSelectedKey((current) => {
      if (current !== null && choices.some((choice) => choice.key === current)) return current;
      // A decision awaiting the owner wins a default, because that is the state this screen exists
      // to serve and an owner arriving here is most often about to decide (F25-AC1).
      const awaiting = choices.find((choice) => choice.entry.kind === 'DecisionAwaiting');
      return awaiting?.key ?? choices[0]?.key ?? null;
    });
  }, [choices]);

  const candidateId = choices.find((choice) => choice.key === selectedKey)?.entry.candidateId ?? null;

  /**
   * Reads the card.
   *
   * On mount, on a change of candidate, and on an epoch bump: a reload preserves durable state
   * because the card is re-read from the backend rather than restored from anything this component
   * held (F24-AC2, N04-AC2).
   *
   * A re-read that fails keeps the card already on screen: the card carries `collectedAt` precisely
   * so its age can be stated, and a screen that blanks the whole review because one request failed
   * is worse than one that shows the last thing the server said and admits it may be out of date
   * (N03-AC1).
   */
  const load = useCallback(
    async (reason: 'initial' | 'refresh'): Promise<MvpFailure | null> => {
      if (projectScope === null) {
        setState({ kind: 'no-project' });
        return null;
      }
      if (candidateId === null) {
        setCard(null);
        setState({ kind: 'ready' });
        return null;
      }
      if (reason === 'refresh') setRefreshing(true);
      else setState({ kind: 'loading' });
      const result = await fetchReview(projectScope, candidateId);
      setRefreshing(false);
      if (result.ok) {
        setCard(result.value);
        setState({ kind: 'ready' });
        return null;
      }
      setState({ kind: 'refused', failure: result.failure });
      return result.failure;
    },
    [candidateId, projectScope],
  );

  useEffect(() => {
    setDecisionRefusal(null);
    setProviderRefusal(null);
    setFeedback('');
    void load('initial');
  }, [load]);

  /** The card is re-read rather than patched after a write. It is the authority (F24-AC2). */
  const afterWrite = useCallback(async (): Promise<void> => {
    await load('refresh');
  }, [load]);

  const recordTest = useCallback(
    async (test: ReviewOwnerTestView, result: 'passed' | 'failed', note: string | null): Promise<MvpFailure | null> => {
      if (projectScope === null || candidateId === null) return null;
      const outcome = await recordOwnerTest(projectScope, candidateId, test.criterionId, { result, note });
      if (outcome.ok) {
        // Re-read rather than trusting the write's own response: the card recomputes eligibility,
        // and the state the next decision may be taken against is the one the server reads back.
        await afterWrite();
        return null;
      }
      const reading = readOwnerTestRefusal(outcome.failure);
      // A refused write renders as failed. Nothing here optimistically marks the criterion
      // settled, because the only state that settles it is the server's (F23-AC1, F25-AC4).
      if (reading.mustReloadCard || outcome.failure.code === 'Conflict') await afterWrite();
      return outcome.failure;
    },
    [afterWrite, candidateId, projectScope],
  );

  const decide = useCallback(
    async (decision: 'accepted' | 'changes_requested'): Promise<void> => {
      if (projectScope === null || candidateId === null || card === null) return;
      setDecisionRefusal(null);
      const outcome: DecideCandidateOutcome = await decideCandidate(projectScope, candidateId, {
        decision,
        // Bound to the card on screen, read at the moment of pressing. This is what turns a
        // decision taken from an outdated card into a Conflict rather than a decision about
        // whatever the candidate has become (F24-AC4, F25-AC3).
        expectedHeadSha: card.candidate.headSha,
        expectedContractRevision: card.contract.revision,
        feedback: decisionFeedback(feedback),
      });
      const reading = readDecisionOutcome(outcome);
      if (reading.kind === 'recorded') {
        // Nothing here sets an accepted state of its own. The card comes back from the server and
        // the panel reads it; if the server did not record a decision, nothing claims one did.
        await afterWrite();
        return;
      }
      // A refused write is never reported as success, and the refusal is held beside the control
      // rather than replacing the card the owner is reading (F25-AC2, N03-AC3).
      setDecisionRefusal({ decision, reading: reading.reading });
      if (reading.reading.mustReloadCard) await afterWrite();
    },
    [afterWrite, candidateId, card, feedback, projectScope],
  );

  const disconnected = state.kind === 'refused' && state.failure.code === 'Disconnected';

  return (
    <div className="page" data-testid="review-screen">
      <header className="page__header">
        <h2 className="page__title">Review</h2>
        <p className="panel__note">
          One candidate, one commit, and the observations that describe it. This is where v0.1 ends:
          an acceptance, or a request for changes.
        </p>
      </header>

      {state.kind === 'no-project' ? <NoProjectSelected /> : null}

      {choices.length === 0 && state.kind === 'ready' ? (
        <ScreenEmpty>
          This project has no candidate to review. A review card is about one commit of one
          candidate, so there is nothing to show until one is linked.
        </ScreenEmpty>
      ) : null}

      {choices.length > 1 ? (
        <CandidatePicker choices={choices} selectedKey={selectedKey} onSelect={setSelectedKey} />
      ) : null}

      {state.kind === 'loading' ? <ScreenLoading what="Reading the review card…" /> : null}

      {state.kind === 'refused' && card === null ? (
        <div data-testid="review-read-refusal">
          <ScreenFailure failure={state.failure} />
          <p className="state-line" role="status" data-state="empty">
            {disconnected
              ? 'The server could not be reached, so no card is shown. Nothing here is a claim about the candidate.'
              : 'Nothing was shown, because the server declined to answer rather than answering with an incomplete card.'}
          </p>
          <div className="form__actions">
            <button className="button button--secondary" type="button" onClick={() => void load('refresh')}>
              Read the card again
            </button>
          </div>
        </div>
      ) : null}

      {card === null ? null : (
        <>
          {refreshing ? (
            <p className="state-line" role="status" aria-live="polite" data-state="refreshing" data-testid="review-refreshing">
              Reading the card again…
            </p>
          ) : null}

          {state.kind === 'refused' ? (
            <p className="state-line state-line--error" role="alert" data-state="error" data-testid="review-stale-refusal">
              <strong>{disconnected ? 'Disconnected.' : 'The server refused.'}</strong> {state.failure.reason}{' '}
              What is on screen was collected at {formatTimestamp(card.collectedAt)} and may no longer be current.
            </p>
          ) : null}

          <StalenessNotice card={card} />

          <SubjectPanel card={card} />

          <ChecksPanel card={card} />

          <CriteriaPanel
            card={card}
            projectId={projectScope?.projectId ?? ''}
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
            busy={refreshing}
            refusal={providerRefusal}
            onRefresh={async () => {
              // A re-read that fails is reported as a failed read with nothing claimed about the
              // checks — never as "no failures" (F20-AC2, F03-AC2). The refusal travels with the
              // button so the owner can tell a stale card from a current one.
              setProviderRefusal(null);
              const failure = await load('refresh');
              if (failure !== null) setProviderRefusal(failure);
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
 * The board's candidates, deduplicated by request.
 *
 * The three lists are independent, so one request can appear in two; showing it twice would read
 * as two pieces of work. `readyForReview` wins a tie (F24-AC3).
 */
function candidateChoicesOf(home: HomeProjection): readonly CandidateChoice[] {
  const byRequest = new Map<string, HomeEntry>();
  for (const entry of [...home.readyForReview, ...home.needsYou, ...home.inProgress]) {
    if (entry.candidateId === null) continue;
    if (!byRequest.has(entry.requestId)) byRequest.set(entry.requestId, entry);
  }
  return [...byRequest.entries()].map(([requestId, entry]) => ({ key: requestId, entry }));
}

/** Which candidate this screen is about, when the project has more than one. */
function CandidatePicker({
  choices,
  selectedKey,
  onSelect,
}: {
  readonly choices: readonly CandidateChoice[];
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
}): ReactElement {
  return (
    <section className="panel" aria-labelledby="review-picker-heading">
      <h3 className="panel__title" id="review-picker-heading">
        Which candidate
      </h3>
      <ul className="capability-list">
        {choices.map((choice) => {
          const chosen = choice.key === selectedKey;
          return (
            <li className="capability-list__item" key={choice.key}>
              <button
                className={chosen ? 'button' : 'button button--secondary'}
                type="button"
                aria-pressed={chosen}
                onClick={() => onSelect(choice.key)}
                data-testid="review-candidate-choice"
                data-request-id={choice.entry.requestId}
              >
                {`${choice.entry.title} — ${choice.entry.requestId}`}
              </button>
              <p className="panel__note">{choice.entry.nextAction}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The card's own staleness summary, in words, when there is any.
 *
 * The summary is derived by the projection from the same rows rendered below, so this panel quotes
 * it rather than recomputing it. It leads the page because it is the one thing that changes how
 * every row under it should be read (F20-AC3, F24-AC2).
 */
function StalenessNotice({ card }: { readonly card: ReviewCardView }): ReactElement | null {
  if (!card.staleness.stale) return null;
  const observations = card.staleness.staleEvidenceIds.length;
  const decisions = card.staleness.staleDecisionIds.length;
  return (
    <section className="state-line" aria-labelledby="review-stale-heading" data-state="stale" data-testid="review-staleness">
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

/** What is under review: the requested outcome, the contract revision, the exact candidate. */
function SubjectPanel({ card }: { readonly card: ReviewCardView }): ReactElement {
  return (
    <section className="panel" aria-labelledby="review-subject-heading">
      <h3 className="panel__title" id="review-subject-heading">
        What you are reviewing
      </h3>
      <p>{card.request.title}</p>
      <p className="panel__note">{card.request.description}</p>
      <p className="panel__note" data-testid="requested-outcome">
        {`Requested outcome: ${card.contract.outcome}`}
      </p>

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
          <dt>Required automated checks</dt>
          <dd data-testid="required-checks">{requiredChecksSentence(card)}</dd>
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
function pullRequestSentence(card: ReviewCardView): string {
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

/**
 * The project's required checks, quoted.
 *
 * Quoted rather than judged, and the sentence says which of them the candidate is judged against.
 * A card whose policy requires nothing is a fact about the project, so it is stated rather than
 * turned into a claim that nothing is required (F20-AC5, F24-AC3).
 */
function requiredChecksSentence(card: ReviewCardView): string {
  if (card.policy.requiredAutomatedCheckIds.length === 0) {
    return 'This project requires no automated check, so the gate is the criteria alone.';
  }
  return `Required: ${card.policy.requiredAutomatedCheckIds.join(', ')}.`;
}

/**
 * The checks the provider reported, each against the observation it rests on.
 *
 * A green check is the provider's statement about a commit. It verifies an acceptance criterion
 * only when the contract bound that criterion to it by name, which is what each criterion below
 * states — so the two lists are deliberately shown together rather than merged (F23-AC1).
 */
function ChecksPanel({ card }: { readonly card: ReviewCardView }): ReactElement {
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
              <li
                className="capability-list__item"
                key={check.checkId}
                data-stale={check.result === 'stale' ? 'true' : 'false'}
                data-testid="review-check"
                data-result={check.result}
              >
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
                    {...(reading.requiredByPolicy ? { detail: 'required by the profile' } : {})}
                  />
                  {check.blocking ? <StatusBadge tone="revoked" label="Blocks acceptance" /> : null}
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
function EvidencePanel({ card }: { readonly card: ReviewCardView }): ReactElement {
  const ownerTests = new Map(card.ownerTests.map((test) => [test.criterionId, test]));
  return (
    <section className="panel" aria-labelledby="review-evidence-heading">
      <h3 className="panel__title" id="review-evidence-heading">
        Evidence
      </h3>
      <p className="panel__note">
        Each row keeps two facts apart: what the source said at the time, and what counts for the
        commit on screen now. A row that counts is evidence for the commit named above. A row that
        does not is history.
      </p>
      {card.evidence.length === 0 ? (
        <ScreenEmpty>Nothing has been observed for this candidate yet.</ScreenEmpty>
      ) : (
        <ul className="capability-list">
          {card.evidence.map((row) => (
            <li
              className="capability-list__item"
              key={row.evidenceId}
              data-stale={readEvidence(row, card.candidate.headSha).counts ? 'false' : 'true'}
              data-testid="review-evidence"
              data-source={row.source}
              data-counts={String(readEvidence(row, card.candidate.headSha).counts)}
              data-current-outcome={row.currentOutcome}
            >
              <EvidenceRow row={row} candidateHeadSha={card.candidate.headSha} />
              {row.source === 'owner_test' ? (
                <OwnerTestEvidence test={ownerTests.get(row.criterionId ?? '') ?? null} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One owner's own recorded result, read as evidence.
 *
 * Separate from the automated rows because a failed owner test can never be read as a failed
 * automated check, and because the owner test is the owner's own observation rather than a
 * measurement something ran (F23-AC5).
 */
function OwnerTestEvidence({ test }: { readonly test: ReviewOwnerTestView | null }): ReactElement | null {
  if (test === null) return null;
  return (
    <p className="panel__note" data-testid="owner-test-evidence">
      {`Your own test of ${test.criterionId} reads ${test.state}` +
        (test.observedAt === null ? ', with no recorded instant.' : `, recorded ${formatTimestamp(test.observedAt)}.`) +
        ` ${test.reason}`}
    </p>
  );
}

/**
 * One evidence row. The badge reads what counts now; the recorded outcome is a second line.
 *
 * `readEvidence` decides the badge, and its verdict is derived from `counts` rather than from
 * `recordedOutcome`, so a stale pass cannot reach this component as green (F20-AC3, F24-AC3).
 */
function EvidenceRow({
  row,
  candidateHeadSha,
}: {
  readonly row: ReviewCardView['evidence'][number];
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
function StaleDecisionsPanel({ card }: { readonly card: ReviewCardView }): ReactElement | null {
  const readings = readStaleDecisions(card.decision.staleDecisions);
  if (readings.length === 0) return null;
  return (
    <section className="panel" aria-labelledby="review-stale-decisions-heading" data-state="stale">
      <h3 className="panel__title" id="review-stale-decisions-heading">
        Earlier decisions that no longer apply
      </h3>
      <p className="panel__note">
        These decisions are real and they are recorded. They name commits this candidate has since
        left, so they authorise nothing today.
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
 * while the backend said the candidate is eligible, and the panel states that this display is
 * informational: the endpoint reads the card again and refuses whatever still refuses. The button
 * is a request, not a permission (F24-AC3, F25-AC3).
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
  readonly card: ReviewCardView;
  readonly feedback: string;
  readonly onFeedback: (value: string) => void;
  readonly refusal: PendingRefusal | null;
  readonly onDecide: (decision: 'accepted' | 'changes_requested') => Promise<void>;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  // Reflected, never recomputed: the gate below is the server's answer read verbatim, including
  // its blocker lists. Nothing on this screen derives eligibility from criteria or checks
  // (F24-AC3, F25-AC3).
  const gate = readAcceptanceGate(card.eligibility);
  const reading = readDecision(card.decision, card.candidate.headSha);
  const alreadyAuthorises = reading.outcome === 'accepted' && reading.authorizesCurrentCandidate;
  const feedbackId = domId('decision-feedback', card.candidate.candidateId);

  return (
    <section className="panel" aria-labelledby="review-decision-heading">
      <h3 className="panel__title" id="review-decision-heading">
        Your decision
      </h3>

      <p data-testid="review-eligibility" data-ready-for-review={String(gate.readyForOwnerReview)} data-ready-for-acceptance={String(gate.readyForAcceptance)}>
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
          <ul data-testid="acceptance-blockers">
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
          A change request with nothing in it has nothing for the fix pass to act on, so it is
          refused. What you type here survives a refusal.
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
          data-testid="request-changes"
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
          data-testid="accept-candidate"
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
    <div className="state-line state-line--error" role="alert" data-state="error" data-testid="decision-refusal">
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
        <ul data-testid="decision-prerequisites">
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
 * Reading the card again.
 *
 * The remedy for stale automated evidence, and it belongs here because the review screen is where a
 * stale pass would mislead. A failed re-read is reported as a failed read with nothing claimed
 * about the checks (F20-AC2, F03-AC2).
 */
function ProviderReadPanel({
  busy,
  refusal,
  onRefresh,
}: {
  readonly busy: boolean;
  readonly refusal: MvpFailure | null;
  readonly onRefresh: () => Promise<void>;
}): ReactElement {
  return (
    <section className="panel" aria-labelledby="review-provider-heading">
      <h3 className="panel__title" id="review-provider-heading">
        Read the card again
      </h3>
      <p className="panel__note">
        Asks the server for a fresh projection of the facts it holds: the criteria, the evidence,
        the staleness and the eligibility. Every verdict on this screen comes from that projection
        and from nothing typed here, so a reload can only ever make the card newer or say that it
        could not be read (F24-AC2, F20-AC2).
      </p>
      {refusal === null ? null : (
        <p className="state-line state-line--error" role="alert" data-state="error" data-testid="review-provider-refusal">
          <strong>Nothing was recorded.</strong> {refusal.reason}
          {refusal.code === 'Unavailable'
            ? ' This deployment could not read the provider, so no observation was made and nothing about this candidate changed.'
            : ''}
        </p>
      )}
      <div className="form__actions">
        <button
          className="button button--secondary"
          type="button"
          disabled={busy}
          onClick={() => void onRefresh()}
          data-testid="refresh-review"
        >
          {busy ? 'Reading…' : 'Read the card again'}
        </button>
      </div>
    </section>
  );
}