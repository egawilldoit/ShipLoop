/**
 * The owner's own test steps for a candidate, and the control that records their outcome
 * (F23-AC1, F23-AC4, F23-AC5, F24-AC1, F24-AC3, F25-AC1, N03-AC1, N03-AC3, F01-AC3).
 *
 * The rule that shapes everything here is that **an observation appears only once the owner
 * has recorded one through the authenticated API** (F23-AC1, F25-AC1, F25-AC4). Nothing on this
 * panel starts as passing: the outcome select begins on an explicit "Not recorded yet" option,
 * a recorded result is printed only from the server's own report, and a refused save prints the
 * refusal while keeping everything the owner typed (N03-AC3). A prefilled pass would be a
 * fabricated live owner observation, and an owner-test criterion is precisely where the
 * product's honesty guarantee is most load-bearing: no check run, no deployment and no agent
 * output may reach it.
 *
 * The instructions are assembled from facts rather than invented. The scope snapshot captured
 * the criterion text and the verification layer states that the criterion text *is* the owner
 * test's step, so inventing a longer procedure document would be a claim no observation
 * supports (F23-AC1). What this panel adds around it is what an owner cannot infer from the
 * criterion text alone, each from a server-reported value on this candidate:
 *
 *   1. what to check — the captured criterion text;
 *   2. which build — the full head SHA and the candidate fingerprint, so the owner tests the
 *      candidate under review and not the branch tip (F22-AC2, F23-AC3);
 *   3. where — the preview's actual access state, which is frequently "no deployment is
 *      recorded", and which must be said rather than left for the owner to discover
 *      (F22-AC3, F23-AC4);
 *   4. what to record — the outcome vocabulary, in which `CaptureFailed` is deliberately not a
 *      behaviour failure: nothing was observed, so the criterion is recorded as neither
 *      confirmed nor broken (F23-AC5).
 *
 * A criterion whose assigned method is not `OwnerTest` is never offered here. Choosing the
 * weaker method at recording time would let the caller pick its own verification, so the
 * server refuses it and this panel does not pretend the choice exists (F23-AC1).
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  recordOwnerTest,
  type ApiFailure,
  type OwnerTestEnvironment,
  type OwnerTestObservation,
  type OwnerTestObservationTarget,
  type OwnerTestReport,
  type ReviewCardCriterion,
} from '../api-client.ts';
import { StatusBadge, type StatusTone } from '../components/StatusBadge.tsx';

/** The outcome vocabulary, with the capture failure kept distinct from a behaviour failure (F23-AC5). */
const OBSERVATIONS: readonly { readonly value: OwnerTestObservation; readonly label: string }[] = [
  { value: 'BehaviorConfirmed', label: 'Confirmed — it behaved as the criterion says' },
  { value: 'BehaviorFailed', label: 'Failed — it did not behave as the criterion says' },
  { value: 'CaptureFailed', label: 'Could not capture — nothing was observed (this is not a behaviour failure)' },
];

const ENVIRONMENTS: readonly { readonly value: OwnerTestEnvironment; readonly label: string }[] = [
  { value: 'Local', label: 'Local — I ran it on my own machine' },
  { value: 'Preview', label: 'Preview — I used the preview deployment' },
  { value: 'LiveSmoke', label: 'Live smoke — I used a live environment' },
];

const OUTCOME_TONES: Readonly<Record<OwnerTestObservation, StatusTone>> = {
  BehaviorConfirmed: 'healthy',
  BehaviorFailed: 'revoked',
  CaptureFailed: 'degraded',
};

interface CriterionTestState {
  readonly observation: OwnerTestObservation | '';
  readonly environment: OwnerTestEnvironment;
  readonly note: string;
  readonly phase: 'idle' | 'saving' | 'recorded' | 'refused';
  readonly message: string | null;
  readonly report: OwnerTestReport | null;
}

function initialState(): CriterionTestState {
  return { observation: '', environment: 'Local', note: '', phase: 'idle', message: null, report: null };
}

/** Whether the criterion is assigned the owner-test method at all (F23-AC1). */
function isOwnerTest(criterion: ReviewCardCriterion): boolean {
  return criterion.methodKind === 'OwnerTest';
}

/**
 * A refused save, in the server's own words.
 *
 * A refusal keeps the typed outcome, environment and note, because re-performing and
 * re-entering an observation the owner just did is the most expensive thing this screen could
 * ask of them (N03-AC3).
 */
function refusalText(failure: ApiFailure): string {
  return [`Your owner test was not recorded: ${failure.reason}`, ...failure.fields.map((field) => field.message)].join(
    ' ',
  );
}

/** The recorded outcome as a badge, or the sentence explaining what is and is not recorded (N03-AC3). */
function outcomeLine(
  criterion: ReviewCardCriterion,
  state: CriterionTestState,
): ReactElement | string {
  if (state.phase !== 'recorded' || state.report === null) {
    return (
      state.message ??
      `Nothing has been recorded for ${criterion.criterionId} on this card. Its status is ${criterion.status}${
        criterion.observedAt === null ? '' : `, observed at ${criterion.observedAt}`
      }.`
    );
  }
  const tone = state.observation === '' ? OUTCOME_TONES['CaptureFailed'] : OUTCOME_TONES[state.observation];
  return (
    <StatusBadge
      tone={tone}
      label={`${criterion.criterionId}: you recorded this criterion as ${state.report.criterion.status}`}
      detail={`Recorded against candidate ${state.report.candidateFingerprint}. ${
        state.report.acceptance.ready
          ? 'Every criterion is now verified, so the acceptance decision is yours to make.'
          : `Acceptance is still refused: ${state.report.acceptance.reasons.join(' ')}`
      }`}
    />
  );
}

export interface OwnerTestPageProps {
  readonly jobId: string;
  /** The project component a preview observation would name; absent when none is deployed. */
  readonly previewComponent?: string;
  readonly criteria: readonly ReviewCardCriterion[];
  readonly headSha: string;
  readonly candidateFingerprint: string;
  /** The preview's access state, stated in words so a missing preview cannot read as usable (F22-AC3). */
  readonly previewSummary: string;
  /** Re-reads the card and the gate, because a recorded observation changes both (F23-AC1). */
  readonly onRecorded: () => void;
}

/**
 * The manual test steps for one candidate, and the recording control for each.
 *
 * Rendered inside the review card rather than as its own owner section, because a step belongs
 * to the candidate it tests: a separate screen would let the owner record an observation while
 * reading a card for a different candidate (F24-AC1, F25-AC1).
 */
export function OwnerTestPage({
  jobId,
  criteria,
  headSha,
  candidateFingerprint,
  previewComponent,
  previewSummary,
  onRecorded,
}: OwnerTestPageProps): ReactElement {
  /**
   * Memoized on the criteria array the card holds, so the reset effect below runs when the
   * card is re-read and not on every keystroke. Without this the effect would re-enter on
   * each render and the panel would never settle.
   */
  const ownerTests = useMemo(() => criteria.filter(isOwnerTest), [criteria]);
  const [states, setStates] = useState<Readonly<Record<string, CriterionTestState>>>({});

  useEffect(() => {
    setStates((previous) => {
      const next: Record<string, CriterionTestState> = {};
      for (const criterion of ownerTests) {
        next[criterion.criterionId] = previous[criterion.criterionId] ?? initialState();
      }
      return next;
    });
  }, [ownerTests]);

  const update = useCallback((criterionId: string, patch: Partial<CriterionTestState>): void => {
    setStates((previous) => {
      const current = previous[criterionId] ?? initialState();
      return { ...previous, [criterionId]: { ...current, ...patch } };
    });
  }, []);

  const record = useCallback(
    async (criterion: ReviewCardCriterion): Promise<void> => {
      const state = states[criterion.criterionId] ?? initialState();
      if (state.phase === 'saving') return;
      if (state.observation === '') {
        update(criterion.criterionId, {
          message:
            'Choose the outcome you observed. Nothing is recorded until you do, and no criterion is ever recorded as passing by default (F23-AC1).',
        });
        return;
      }
      update(criterion.criterionId, { phase: 'saving', message: null });
      // The observation is bound to the candidate the card is showing, so the server can
      // refuse a submission that names a superseded candidate rather than quietly recording
      // it against whatever is current (F24-AC4). Where no preview applies the owner states
      // so explicitly instead of leaving the field blank (F23-AC3, F23-AC4).
      const observedAgainst: OwnerTestObservationTarget =
        state.environment === 'Preview' || state.environment === 'LiveSmoke'
          ? {
              kind: 'Deployment',
              component: previewComponent ?? 'application',
              environment: state.environment,
              deploymentId: null,
              deploymentUrl: null,
            }
          : {
              kind: 'NoDeploymentApplicable',
              reason: `The owner tested this criterion on their ${state.environment} environment, where no preview deployment applies.`,
            };
      const result = await recordOwnerTest(jobId, {
        criterionId: criterion.criterionId,
        expectedCandidateFingerprint: candidateFingerprint,
        observation: state.observation,
        observedAgainst,
        evidence: { kind: 'CheckOutput', reference: `owner-test/${jobId}/${criterion.criterionId}` },
        note: state.note.trim() === '' ? null : state.note.trim(),
      });
      if (!result.ok) {
        update(criterion.criterionId, { phase: 'refused', message: refusalText(result.error), report: null });
        return;
      }
      update(criterion.criterionId, { phase: 'recorded', message: null, report: result.value.report });
      onRecorded();
    },
    [jobId, onRecorded, states, update],
  );

  return (
    <section className="panel" aria-labelledby="owner-test-title">
      <h3 className="panel__title" id="owner-test-title">
        Your own test steps
      </h3>
      <p className="panel__note">
        These steps are yours to perform and yours alone to record. No check run, no deployment and no agent message can
        stand in for what you observed here, and nothing on this panel starts out recorded as passing (F23-AC1,
        F25-AC4).
      </p>

      {ownerTests.length === 0 ? (
        <p className="state-line" role="status" data-state="empty" data-testid="owner-test-empty">
          No criterion on this candidate is assigned the OwnerTest method, so there is no step of yours to perform
          here. Assigning that method is a scope decision, and it is deliberately not offered at recording time
          (F23-AC1).
        </p>
      ) : (
        <p className="state-line" role="status" data-state="ready" data-testid="owner-test-summary">
          {`${String(ownerTests.length)} ${ownerTests.length === 1 ? 'criterion is' : 'criteria are'} assigned to your own test. Perform each step below and record what you observed.`}
        </p>
      )}

      {ownerTests.map((criterion) => {
        const state = states[criterion.criterionId] ?? initialState();
        const selectId = `owner-test-observation-${criterion.criterionId}`;
        const environmentId = `owner-test-environment-${criterion.criterionId}`;
        const noteId = `owner-test-note-${criterion.criterionId}`;
        const statusId = `${criterion.criterionId}-owner-test-status`;
        const describedBy = [statusId, `${noteId}-hint`].join(' ');

        return (
          <div className="version-list__item" key={criterion.criterionId} data-testid="owner-test-criterion">
            <p className="version-list__id">{`${criterion.criterionId} — ${criterion.text}`}</p>

            <dl className="detail-list">
              <div className="detail-list__row">
                <dt>Step 1: what to check</dt>
                <dd>{criterion.text}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Step 2: which build</dt>
                <dd data-testid="owner-test-build">
                  {`Head ${headSha}, candidate ${candidateFingerprint}. Test that exact commit: a branch name or a newer ` +
                    'deployment does not establish which build you tested (F22-AC2, F23-AC3).'}
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Step 3: where</dt>
                <dd data-testid="owner-test-where">{previewSummary}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Step 4: what to record</dt>
                <dd>
                  Choose the outcome you actually observed. &ldquo;Could not capture&rdquo; records that nothing was
                  observed; it is not a report that the behaviour is broken (F23-AC5).
                </dd>
              </div>
            </dl>

            <div className="field">
              <label className="field__label" htmlFor={selectId}>
                {`Observation for ${criterion.criterionId}`}
              </label>
              <select
                className="field__input"
                id={selectId}
                name={selectId}
                value={state.observation}
                aria-required="true"
                aria-describedby={describedBy}
                disabled={state.phase === 'saving'}
                data-testid="owner-test-observation"
                onChange={(event) =>
                  update(criterion.criterionId, {
                    observation: event.target.value === '' ? '' : (event.target.value as OwnerTestObservation),
                  })
                }
              >
                <option value="">Not recorded yet</option>
                {OBSERVATIONS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor={environmentId}>
                {`Environment for ${criterion.criterionId}`}
              </label>
              <select
                className="field__input"
                id={environmentId}
                name={environmentId}
                value={state.environment}
                aria-describedby={describedBy}
                disabled={state.phase === 'saving'}
                data-testid="owner-test-environment"
                onChange={(event) =>
                  update(criterion.criterionId, { environment: event.target.value as OwnerTestEnvironment })
                }
              >
                {ENVIRONMENTS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor={noteId}>
                {`What you saw for ${criterion.criterionId} (optional)`}
              </label>
              <textarea
                className="field__input"
                id={noteId}
                name={noteId}
                rows={3}
                value={state.note}
                aria-describedby={describedBy}
                disabled={state.phase === 'saving'}
                data-testid="owner-test-note"
                onChange={(event) => update(criterion.criterionId, { note: event.target.value })}
              />
              <p className="field__hint" id={`${noteId}-hint`}>
                Recorded with your observation and kept against this candidate, so the note travels with the evidence
                rather than being lost when you move on (F23-AC3).
              </p>
            </div>

            <p className="connector__problem-line" id={statusId} data-testid="owner-test-status" data-phase={state.phase}>
              {outcomeLine(criterion, state)}
            </p>

            <div className="form__actions">
              <button
                className="button"
                type="button"
                data-testid="owner-test-record"
                disabled={state.phase === 'saving'}
                onClick={() => void record(criterion)}
              >
                {state.phase === 'saving'
                  ? 'Recording…'
                  : `Record my owner test for ${criterion.criterionId}`}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}