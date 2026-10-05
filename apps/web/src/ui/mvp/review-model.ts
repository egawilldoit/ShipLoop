/**
 * What the review screen says, derived from what the backend said.
 *
 * Every judgement the Review screen makes about wording, tone and what may be pressed lives
 * here, as a pure function of the server's own projection. That is not tidiness: the one rule
 * this file exists to make unreachable is *rendering a stale pass in green*, and a rule that
 * lives inside JSX is a rule nobody can test without a browser (F20-AC3, F24-AC3).
 *
 * The three rules that carry the product:
 *
 *   - **`currentOutcome` is what counts; `recordedOutcome` is history.** `readEvidence` derives
 *     one boolean, `counts`, from *both* `countsForCurrentCandidate` and whether `currentOutcome`
 *     still says so, and then reads the verdict off that. A row that disagrees with itself is
 *     treated as not counting, so the client defends the same line the server enforces: a
 *     `passed` on screen always names an observation of the commit on screen.
 *   - **A pending owner test is the owner's own outstanding step.** It reads as waiting, never
 *     as passed, and the controls for recording it are offered per criterion and only per
 *     criterion (F23-AC1, F25-AC4).
 *   - **A refusal records nothing.** `readDecisionRefusal` has no branch that can produce a
 *     wording claiming success, and a `Conflict` says which fact moved so the owner knows to
 *     re-read the card before deciding again (F24-AC4, F25-AC3).
 *
 * The projection is read, never recomputed. Readiness, staleness and eligibility are the
 * server's judgements; this file decides how to *say* them, and where the server's own
 * `reason` exists it is quoted rather than replaced (F24-AC2, F24-AC3).
 */

import type { StatusTone } from '../components/StatusBadge.tsx';
import type {
  ReviewCheckView,
  ReviewCriterionView,
  ReviewDecisionView,
  ReviewEligibilityView,
  ReviewEvidenceView,
  ReviewOwnerTestView,
  ReviewStaleDecisionView,
} from '../../server/contracts.ts';

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                    */
/* -------------------------------------------------------------------------- */

/** The criterion states the domain enumerates; nothing here adds a sixth (F23-AC1). */
export type CriterionState = ReviewCriterionView['state'];

/** What a check may read, `stale` and `not_run` included as members rather than absences. */
export type CheckResult = ReviewCheckView['result'];

/**
 * What an observation means *now*.
 *
 * The card's own vocabulary is five source outcomes plus `stale`, and this type is the
 * declared union rather than a hand-written list, so a new outcome cannot appear on screen
 * without this file having to be read (F20-AC2).
 */
export type CurrentOutcome = ReviewEvidenceView['currentOutcome'];

/* -------------------------------------------------------------------------- */
/* Evidence: the stale-versus-current split                                       */
/* -------------------------------------------------------------------------- */

/**
 * The wording for each outcome, as the owner should read it.
 *
 * `passed` is `Passed` and nothing more flattering. `stale` is `Stale`, which is a *different
 * word* on purpose: `stale` is not `failed` and it is emphatically not `passed`, and an owner
 * deciding whether to trust a commit needs to tell "a check ran and passed on an earlier
 * commit" from "a check ran and passed on this one" (F20-AC3).
 */
const OUTCOME_LABELS: Readonly<Record<CurrentOutcome, string>> = {
  passed: 'Passed',
  failed: 'Failed',
  waiting: 'Still running',
  missing: 'Never reported',
  capture_failed: 'Capture failed',
  stale: 'Stale',
};

/**
 * Tones, chosen so no two states a decision depends on share one.
 *
 * `stale` takes `degraded`, the same amber a failure-adjacent state takes, and never
 * `healthy`. That is deliberate: greying stale evidence into irrelevance is the specific way
 * this screen could tell a lie, so stale is drawn as an active warning and labelled (N03-AC1).
 */
const OUTCOME_TONES: Readonly<Record<CurrentOutcome, StatusTone>> = {
  passed: 'healthy',
  failed: 'revoked',
  waiting: 'pending',
  missing: 'unconfigured',
  capture_failed: 'degraded',
  stale: 'degraded',
};

/** One sentence per outcome, saying what it means for the candidate on screen. */
const OUTCOME_STANDING: Readonly<Record<CurrentOutcome, string>> = {
  passed: 'This observation was made about the commit on screen and counts for it.',
  failed: 'A current observation says this does not hold.',
  waiting: 'The source is still running this. Nothing has concluded yet.',
  missing: 'The source reported no result for this at all.',
  capture_failed: 'The capture itself failed, so nothing was observed.',
  stale: 'This does not count for the commit on screen. It was recorded for something else.',
};

/** What one evidence row reads as, and what it means now. */
export interface EvidenceReading {
  /** The outcome that counts *now*. Never `recordedOutcome` (F20-AC3). */
  readonly verdict: CurrentOutcome;
  /** The affirmative "may this be shown as this candidate's result?". */
  readonly counts: boolean;
  readonly label: string;
  readonly tone: StatusTone;
  /** The line under the badge: what this means for the commit on screen. */
  readonly standing: string;
  /** What the source said at the time, when that is not what counts. History, never a verdict. */
  readonly history: string | null;
  readonly staleReasons: readonly string[];
  /** True when the source attributed the run to a commit other than the one on screen. */
  readonly observedAnotherCommit: boolean;
  /** The commit the source said it observed, for display beside the badge. */
  readonly observedCommit: string | null;
}

/**
 * Reads one evidence row for display, and refuses to let it lie.
 *
 * The single load-bearing line is `counts`. The server enforces that
 * `countsForCurrentCandidate` and `currentOutcome === 'stale'` cannot both hold, and this
 * function enforces it again on the way to the screen:
 *
 *     a row counts only when it says it counts **and** its current outcome is not `stale`
 *
 * Either signal alone can be wrong in a card the backend should already have refused, and the
 * consequence of getting this wrong is the exact defect this split exists to prevent — a
 * `passed` rendered green over a commit nobody observed. So `verdict` is derived from `counts`
 * and never from `recordedOutcome`: a row that does not count reads `stale`, whatever it
 * recorded (F20-AC3, F24-AC3).
 *
 * `recordedOutcome` is still shown, but only as history — the line "the source recorded
 * Passed for commit …" — and only when it differs from what counts. It is never the badge.
 */
export function readEvidence(row: ReviewEvidenceView, candidateHeadSha: string): EvidenceReading {
  const counts = row.countsForCurrentCandidate && row.currentOutcome !== 'stale';
  const verdict: CurrentOutcome = counts ? row.currentOutcome : 'stale';

  const observedCommit = row.candidateHeadSha;
  const observedAnotherCommit =
    observedCommit !== null && candidateHeadSha !== '' && observedCommit !== candidateHeadSha;

  const binding = describeBinding(row, candidateHeadSha);
  const history =
    counts && row.recordedOutcome === verdict
      ? null
      : `The source recorded "${OUTCOME_LABELS[row.recordedOutcome]}" for ${binding} at the time. That is history; it is not a result for the commit on screen.`;

  return {
    verdict,
    counts,
    label: OUTCOME_LABELS[verdict],
    tone: OUTCOME_TONES[verdict],
    standing: OUTCOME_STANDING[verdict],
    history,
    staleReasons: counts ? [] : [...row.staleReasons],
    observedAnotherCommit,
    observedCommit,
  };
}

/** Where an observation was recorded against, in words, including a missing attribution. */
function describeBinding(row: ReviewEvidenceView, candidateHeadSha: string): string {
  const revision = row.contractRevision === null ? '' : ` at contract revision ${String(row.contractRevision)}`;
  if (row.candidateHeadSha === null) return 'a commit the source did not attribute';
  if (candidateHeadSha !== '' && row.candidateHeadSha !== candidateHeadSha) return `commit ${row.candidateHeadSha}${revision}`;
  return `the commit on screen${revision}`;
}

/** The full set of evidence rows, in the order the card gives them, read for display. */
export function readEvidenceTable(
  rows: readonly ReviewEvidenceView[],
  candidateHeadSha: string,
): readonly (EvidenceReading & { readonly evidenceId: string })[] {
  return rows.map((row) => ({ evidenceId: row.evidenceId, ...readEvidence(row, candidateHeadSha) }));
}

/* -------------------------------------------------------------------------- */
/* Criteria                                                                     */
/* -------------------------------------------------------------------------- */

/** How one criterion reads, with the wording split by who is meant to settle it. */
export interface CriterionReading {
  readonly state: CriterionState;
  readonly label: string;
  readonly tone: StatusTone;
  /** The server's own reason when it gave one, and a plain sentence when it did not. */
  readonly standing: string;
}

/**
 * The five states, labelled once.
 *
 * `pending` and `unverified` are the two that must never collapse. `pending` means a step is
 * still outstanding — for an owner test that is *the owner's own* step — and `unverified` means
 * nobody has observed it and nobody is scheduled to. Reporting a pending owner test as
 * unverified hides the owner's work; reporting it as passed fabricates it (F23-AC1).
 */
const CRITERION_TONES: Readonly<Record<CriterionState, StatusTone>> = {
  passed: 'healthy',
  failed: 'revoked',
  pending: 'pending',
  stale: 'degraded',
  unverified: 'unconfigured',
};

/** Labels for an automated criterion: the observation, not a person. */
const AUTOMATED_LABELS: Readonly<Record<CriterionState, string>> = {
  passed: 'Passed',
  failed: 'Failed',
  pending: 'Verification running',
  stale: 'Stale',
  unverified: 'Not verified',
};

/**
 * Labels for an owner-test criterion.
 *
 * `pending` reads **Waiting for you** and nothing else. There is no state of an owner test
 * that any automated result, agent output or provider can move, so a label that said
 * "verifying", "in progress" or "pending verification" would be describing work nobody is
 * doing (F23-AC1, F25-AC4).
 */
const OWNER_TEST_LABELS: Readonly<Record<CriterionState, string>> = {
  passed: 'You recorded this as passed',
  failed: 'You recorded this as failed',
  pending: 'Waiting for you',
  stale: 'Your earlier result no longer counts',
  unverified: 'Nothing has verified this',
};

/**
 * Reads one criterion for display.
 *
 * The server's `reason` is quoted when it has one. A client that replaced the projection's
 * explanation with its own phrasing would be the second opinion this whole architecture
 * refuses (F24-AC2, F24-AC3).
 */
export function readCriterion(criterion: ReviewCriterionView): CriterionReading {
  const ownerTest = criterion.verificationType === 'owner_test';
  return {
    state: criterion.state,
    label: ownerTest ? OWNER_TEST_LABELS[criterion.state] : AUTOMATED_LABELS[criterion.state],
    tone: CRITERION_TONES[criterion.state],
    standing: criterion.reason !== '' ? criterion.reason : (ownerTest ? 'Only an observation you record can satisfy this.' : 'No observation of this candidate satisfies this criterion yet.'),
  };
}

/** How a required check reads. `stale`, `not_run` and `missing` are separate words. */
const CHECK_LABELS: Readonly<Record<CheckResult, string>> = {
  passed: 'Passed',
  failed: 'Failed',
  waiting: 'Still running',
  missing: 'Never reported',
  capture_failed: 'Capture failed',
  stale: 'Stale',
  not_run: 'Not run',
};

const CHECK_TONES: Readonly<Record<CheckResult, StatusTone>> = {
  passed: 'healthy',
  failed: 'revoked',
  waiting: 'pending',
  missing: 'unconfigured',
  capture_failed: 'degraded',
  stale: 'degraded',
  not_run: 'unconfigured',
};

/** One check row: its result, plus the requirement flags the owner has to see separately. */
export interface CheckReading {
  readonly label: string;
  readonly tone: StatusTone;
  readonly standing: string;
  /** Set when this check is one the project policy requires for acceptance. */
  readonly requiredByPolicy: boolean;
}

/**
 * Reads one check for display.
 *
 * A check reading `passed` stands on an observation that counts — the backend refuses a card
 * where it does not — so nothing here re-tests that. What the row must add is *which* check
 * the criterion is bound to, which is why the caller passes the policy's required ids: a green
 * required check that no criterion names verified nothing, however green it is (F23-AC1).
 */
export function readCheck(check: ReviewCheckView, requiredCheckIds: readonly string[]): CheckReading {
  return {
    label: CHECK_LABELS[check.result],
    tone: CHECK_TONES[check.result],
    standing: check.reason,
    requiredByPolicy: requiredCheckIds.includes(check.checkId),
  };
}

/* -------------------------------------------------------------------------- */
/* Owner tests                                                                  */
/* -------------------------------------------------------------------------- */

/** Whether this screen offers Pass and Fail on an owner test, and what it calls them. */
export interface OwnerTestControlReading {
  /** True only where recording is both permitted and meaningful. */
  readonly recordable: boolean;
  readonly heading: string;
  /** Says why the controls are or are not there. Never blank. */
  readonly note: string;
}

/**
 * Decides whether one owner test may be recorded from here.
 *
 * Offered for `pending` and for `stale`, and for no other state:
 *
 *   - `pending` is the normal pre-review state. The owner has not acted yet, and that is a
 *     step of theirs outstanding, not a defect and not something automation will do (F23-AC1).
 *   - `stale` means the owner *did* act and the candidate has since moved, so their earlier
 *     result no longer describes this commit. Only the owner can produce a new one, so hiding
 *     the controls there would leave a stale owner test with no way to be discharged from this
 *     screen (F20-AC3, F23-AC1).
 *
 * `passed` and `failed` show what the owner recorded and offer nothing: the observation stands
 * or it does not, and re-recording a settled result with a second click would be a decision
 * made without a new act (F25-AC2).
 *
 * `unverified` is refused. A criterion with no assigned verification method cannot be settled
 * by an owner-test write, and offering Pass/Fail on it would be offering a control that the
 * endpoint would reject with 400 (F23-AC1).
 */
export function readOwnerTestControls(test: ReviewOwnerTestView): OwnerTestControlReading {
  switch (test.state) {
    case 'pending':
      return {
        recordable: true,
        heading: 'Record your result',
        note: 'This is your own test. Nothing automated can satisfy it — no check, no agent and no provider result moves this off "waiting for you".',
      };
    case 'stale':
      return {
        recordable: true,
        heading: 'Record your result again',
        note: 'What you recorded before was against a commit this candidate has since left, so it does not count for the one on screen. Running it again is the only way to settle it, because only you can.',
      };
    case 'passed':
      return {
        recordable: false,
        heading: 'You recorded this as passed',
        note: 'Your observation stands for the commit on screen. Recording something else is a new act of testing, not an edit of this one.',
      };
    case 'failed':
      return {
        recordable: false,
        heading: 'You recorded this as failed',
        note: 'Your observation stands for the commit on screen.',
      };
    case 'unverified':
      return {
        recordable: false,
        heading: 'No verification method is assigned',
        note: 'The contract gives this criterion no verification method, so there is nothing here to record a result against. Changing that is a contract decision, not an owner test.',
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Eligibility and the decision                                                  */
/* -------------------------------------------------------------------------- */

/** How the accept gate reads. It is the server's gate, quoted (F24-AC3). */
export interface GateReading {
  readonly readyForAcceptance: boolean;
  readonly readyForOwnerReview: boolean;
  readonly label: string;
  readonly tone: StatusTone;
  readonly acceptanceBlockers: readonly string[];
  readonly blockingReasons: readonly string[];
  readonly ownerActions: readonly string[];
  /** The line that stops the owner reading a green panel as an authorisation. */
  readonly standing: string;
}

/**
 * Reads the acceptance gate.
 *
 * `readyForAcceptance` is rendered as the server's answer and nothing more. The button it
 * enables is a *request*, not an outcome: the decision endpoint reads the card again and
 * refuses anything the projection still refuses, so a client that treated this boolean as
 * permission would be promising a decision the server has not agreed to (F24-AC3, F25-AC3).
 *
 * `readyForDelivery` is deliberately not read here. The MVP ends at Accepted or Changes
 * Requested: there is no merge and no deployment, so rendering a delivery gate would advertise
 * a step this product does not have (mvp-spec 3, F03-AC5).
 */
export function readAcceptanceGate(eligibility: ReviewEligibilityView): GateReading {
  const ready = eligibility.readyForAcceptance;
  return {
    readyForAcceptance: ready,
    readyForOwnerReview: eligibility.readyForOwnerReview,
    label: ready ? 'The server reports this candidate is eligible for acceptance' : 'The server reports this candidate is not eligible for acceptance yet',
    tone: ready ? 'healthy' : 'degraded',
    acceptanceBlockers: [...eligibility.acceptanceBlockers],
    blockingReasons: [...eligibility.blockingReasons],
    ownerActions: [...eligibility.ownerActions],
    standing: ready
      ? 'This is the server’s own answer at the moment this card was collected. The server checks it again when you decide, and can still refuse.'
      : 'Every outstanding item below has to be discharged first. The server checks all of this again when you decide, and can still refuse — a change request is always available.',
  };
}

/** Whether the decision on the card speaks for the commit on screen. */
export interface DecisionReading {
  readonly outcome: ReviewDecisionView['outcome'];
  readonly label: string;
  readonly tone: StatusTone;
  /** The backend's own "an acceptance for SHA A does not authorise SHA B" answer. */
  readonly authorizesCurrentCandidate: boolean;
  /** One sentence naming the commit and revision the decision binds. */
  readonly summary: string;
  readonly feedback: string | null;
  readonly decidedAt: string | null;
}

/**
 * Reads the decision already on the card, and refuses to imply authority it does not have.
 *
 * The two fields that matter are kept apart: `decision.outcome` is what the owner did at some
 * point, and `authorizesCurrentCandidate` is what that still means for the commit on screen.
 * An acceptance for SHA A after a push is a real, recorded decision — so it is shown, with
 * its SHA and its instant, rather than hidden — and it authorises nothing (F25-AC3, F27-AC3).
 */
export function readDecision(decision: ReviewDecisionView, candidateHeadSha: string): DecisionReading {
  const recorded = decision.decision;
  const base = {
    authorizesCurrentCandidate: decision.authorizesCurrentCandidate,
    feedback: recorded?.feedback ?? null,
    decidedAt: recorded?.decidedAt ?? null,
  };

  if (decision.outcome === 'none' || recorded === null) {
    return {
      ...base,
      outcome: 'none',
      label: 'No decision yet',
      tone: 'neutral',
      summary: 'You have neither accepted this candidate nor asked for changes.',
    };
  }

  if (decision.outcome === 'accepted') {
    return decision.authorizesCurrentCandidate
      ? {
          ...base,
          outcome: 'accepted',
          label: 'Accepted — for this commit',
          tone: 'healthy',
          summary: `You accepted ${recorded.candidateHeadSha} at contract revision ${String(recorded.contractRevision)} on ${recorded.decidedAt}. That is the commit on screen.`,
        }
      : {
          ...base,
          outcome: 'accepted',
          label: 'Accepted an earlier commit',
          tone: 'degraded',
          summary: `You accepted ${recorded.candidateHeadSha} at contract revision ${String(recorded.contractRevision)}, which is not the candidate on screen (${candidateHeadSha}). It authorises nothing today, and this screen says so rather than showing a green acceptance.`,
        };
  }

  const stillThisCandidate = recorded.candidateHeadSha === candidateHeadSha;
  return {
    ...base,
    outcome: 'changes_requested',
    label: stillThisCandidate ? 'Changes requested' : 'Changes requested on an earlier commit',
    tone: 'degraded',
    summary: stillThisCandidate
      ? `You asked for changes on ${recorded.candidateHeadSha} at contract revision ${String(recorded.contractRevision)} on ${recorded.decidedAt}.`
      : `You asked for changes on ${recorded.candidateHeadSha}, which is not the candidate on screen (${candidateHeadSha}).`,
  };
}

/** One decision a push has invalidated, in words, with the reason the server gave. */
export interface StaleDecisionReading {
  readonly decisionId: string;
  readonly label: string;
  readonly candidateHeadSha: string;
  readonly contractRevision: number;
  readonly reason: string;
  readonly tone: StatusTone;
}

/**
 * Reads the decisions that no longer describe the candidate on screen.
 *
 * These are shown, never hidden. An owner who accepted something and then saw the candidate
 * move needs to know their acceptance went with it, and a screen that quietly dropped the
 * decision would leave them believing they had approved a commit that was never reviewed
 * (F25-AC3, F27-AC3).
 */
export function readStaleDecisions(decisions: readonly ReviewStaleDecisionView[]): readonly StaleDecisionReading[] {
  return decisions.map((decision) => ({
    decisionId: decision.decisionId,
    label: decision.kind === 'accepted' ? 'You accepted an earlier commit' : 'You asked for changes on an earlier commit',
    candidateHeadSha: decision.candidateHeadSha,
    contractRevision: decision.contractRevision,
    reason: decision.reason,
    tone: 'degraded' as StatusTone,
  }));
}

/* -------------------------------------------------------------------------- */
/* Refusals                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a client can learn about a refusal — the structural minimum this module needs.
 *
 * Declared here rather than imported from the transport so the wording of a refusal is
 * testable without a browser or a `fetch`, and so the screen and the client cannot disagree
 * about what a refusal is (F24-AC4, N03-AC3).
 */
export interface RefusalLike {
  readonly code: string;
  readonly reason: string;
  readonly fields: readonly { readonly path: string; readonly message: string }[];
  readonly prerequisites: readonly { readonly name: string; readonly detail: string; readonly remedy: string }[];
  readonly expected: string | null;
  readonly actual: string | null;
}

/** What a refused decision says. It can never say it was recorded. */
export interface RefusalReading {
  /** Always begins by denying that anything was written. */
  readonly headline: string;
  /** The server's own words, quoted. */
  readonly detail: string;
  /** True only when the card on screen is known to be out of date. */
  readonly mustReloadCard: boolean;
  /** Which fact moved, for a conflict. */
  readonly moved: { readonly subject: string; readonly expected: string; readonly actual: string } | null;
  /** Field-level messages, when the server attributed any. */
  readonly fields: readonly { readonly path: string; readonly message: string }[];
  /** Prerequisites with their remedies, for a `Blocked` refusal. */
  readonly prerequisites: readonly { readonly name: string; readonly detail: string; readonly remedy: string }[];
}

/**
 * A refused decision, held so it renders beside the control that caused it.
 *
 * Kept rather than folded into the card's state: a refusal must not disturb the card on screen,
 * and the card is what the owner is reading when the refusal appears (F24-AC4, N03-AC3).
 */
export interface PendingRefusal {
  readonly decision: 'accepted' | 'changes_requested';
  readonly reading: RefusalReading;
}

/** A full 40-character commit SHA, matched the way the domain's own rule matches. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/** A whole number, which is how a contract revision travels. */
const REVISION = /^\d+$/;

/**
 * Reads a refused decision.
 *
 * Two properties hold for every code, and the first is the one that matters:
 *
 *   - **Nothing was recorded.** `headline` says so before anything else, and there is no
 *     branch that can produce a wording claiming the decision was made. A screen that reported
 *     a refused acceptance as accepted would be the worst defect this screen could ship, and
 *     the check is cheap enough to keep in a pure function (F25-AC2).
 *   - **A conflict says which fact moved.** `expected` and `actual` are named by the server;
 *     reading their shape tells the owner whether the commit moved or the contract revision
 *     did, which are different instructions (F24-AC4).
 *
 * A `Conflict` also sets `mustReloadCard`. The submission named one build and the server holds
 * another, so the card on screen is not the card the decision would bind to, and the only
 * honest next step is to read it again (F24-AC4, F25-AC3).
 */
export function readDecisionRefusal(refusal: RefusalLike): RefusalReading {
  const reading = refusalHeadline(refusal, 'Nothing was recorded.');
  return { ...reading, detail: refusal.reason };
}

/**
 * The first line of any refusal: what was not written, then what moved if anything did.
 *
 * Written once and used for both writes on this screen. Two callers each assembling their own
 * headline is how one of them ends up saying "recorded" — the one thing a refusal must never
 * be rendered as (F25-AC2).
 */
function refusalHeadline(refusal: RefusalLike, nothingRecorded: string): RefusalReading {
  const conflict = refusal.code === 'Conflict';
  const moved = conflict ? movedFact(refusal.expected, refusal.actual) : null;
  const headline = conflict
    ? moved === null
      ? `${nothingRecorded} The facts this was prepared against have moved, so the card must be read again.`
      : `${nothingRecorded} ${moved.subject} moved while this page was open, so the card must be read again.`
    : nothingRecorded;

  return {
    headline,
    detail: refusal.reason,
    mustReloadCard: conflict,
    moved,
    fields: [...refusal.fields],
    prerequisites: [...refusal.prerequisites],
  };
}

/**
 * Which fact a conflict is about, read off the two values the server named.
 *
 * Full SHAs mean the candidate moved; whole numbers mean the contract revision moved. Both
 * are shown unabbreviated, because a commit identity is never abbreviated on this screen —
 * the whole point of the comparison is that the two are distinguishable (mvp-spec 3).
 */
function movedFact(
  expected: string | null,
  actual: string | null,
): { readonly subject: string; readonly expected: string; readonly actual: string } | null {
  if (expected === null || actual === null) return null;
  if (FULL_SHA.test(expected) && FULL_SHA.test(actual)) {
    return { subject: 'The candidate', expected, actual };
  }
  if (REVISION.test(expected) && REVISION.test(actual)) {
    return {
      subject: 'The contract revision',
      expected: `revision ${expected}`,
      actual: `revision ${actual}`,
    };
  }
  return { subject: 'The facts this decision named', expected, actual };
}

/** What a refused owner-test write says. Same two properties, no decision to misreport. */
export function readOwnerTestRefusal(refusal: RefusalLike): RefusalReading {
  const reading = refusalHeadline(refusal, 'Nothing was recorded for this test.');
  // A candidate this project no longer holds is also a reason the card on screen is not the
  // card a further write would bind to, so it reloads for the same reason a conflict does.
  return reading.mustReloadCard || refusal.code === 'NotFound'
    ? { ...reading, mustReloadCard: true }
    : reading;
}

/* -------------------------------------------------------------------------- */
/* Submissions and DOM identities                                                */
/* -------------------------------------------------------------------------- */

/**
 * The body a decision is submitted with.
 *
 * One rule lives here: an empty feedback box sends `null`, never `''`. The domain refuses an
 * empty string as feedback outright, so a form that sends `''` would be refused for a reason
 * the owner cannot act on, while a change request with genuinely nothing in it is refused by
 * the use case with a message that says exactly that (F25-AC2).
 */
export function decisionFeedback(typed: string): string | null {
  const trimmed = typed.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Whether a change request may be sent at all.
 *
 * A change request with no feedback is refused by the use case, because a fix pass with
 * nothing to follow has nothing to act on. The screen says so before the round trip rather
 * than after it — and still renders the server's refusal if one arrives (F25-AC2, N03-AC3).
 */
export function canRequestChanges(feedback: string): boolean {
  return feedback.trim() !== '';
}

/**
 * A DOM id built from a server-supplied value.
 *
 * Criterion and evidence identities are the server's strings and may contain characters that
 * are not valid in an id or are meaningful to a selector. Every id this screen composes goes
 * through here, so a hostile or merely awkward identity cannot break the association between
 * a label, its input and its error message (F02-AC4, N03-AC1).
 */
export function domId(prefix: string, value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe === '' ? prefix : `${prefix}-${safe}`;
}

/**
 * The owner test's note, as submitted.
 *
 * Trimmed, and an empty note becomes `null` rather than `''` for the same reason feedback
 * does: the endpoint accepts a note or no note, and a blank string is not one (F25-AC4).
 */
export function ownerTestNote(typed: string): string | null {
  const trimmed = typed.trim();
  return trimmed === '' ? null : trimmed;
}
