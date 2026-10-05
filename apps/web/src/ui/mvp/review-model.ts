/**
 * What the candidate and review screens say, derived from what the backend said.
 *
 * Every judgement the two screens make about wording, tone and what may be pressed lives here,
 * as a pure function of the server's own projection. That is not tidiness: the one rule this file
 * exists to make unreachable is *rendering a stale pass in green*, and a rule that lives inside
 * JSX is a rule nobody can test without a browser (F20-AC3, F24-AC3).
 *
 * The rules that carry the product:
 *
 *   - **`currentOutcome` is what counts; `recordedOutcome` is history.** `readEvidence` derives
 *     one boolean, `counts`, from *both* `countsForCurrentCandidate` and whether `currentOutcome`
 *     still says so, and then reads the verdict off that. A row that disagrees with itself is
 *     treated as not counting, so the client defends the same line the server enforces: a
 *     `passed` on screen always names an observation of the commit on screen.
 *   - **The commit decides before the result does.** `readCandidateCheck` asks whether the
 *     provider attributed the run to the commit on screen *first*, and a `Passed` it attributed
 *     elsewhere is not a pass here. This is the same ordering as `readEvidence`, applied to the
 *     candidate card's own check list, which the server reports in the domain's six-state
 *     vocabulary rather than the card's (F20-AC3, F24-AC3).
 *   - **A state this build cannot read is reported as unread.** `readProviderState` never maps
 *     an unrecognised pull request state onto `Open` or `Closed`: presenting withdrawn work as
 *     reviewable, or asserting a conclusion nobody read, are both worse than saying the word is
 *     unfamiliar (mvp-spec F20-AC2).
 *   - **A pending owner test is the owner's own outstanding step.** It reads as waiting, never
 *     as passed, and the controls for recording it are offered per criterion and only per
 *     criterion (F23-AC1, F25-AC4).
 *   - **A refusal records nothing.** `readDecisionOutcome` has no branch that can produce a
 *     wording claiming success, and a `Conflict` says which fact moved so the owner knows to
 *     re-read the card before deciding again (F24-AC4, F25-AC3).
 *
 * The projection is read, never recomputed. Readiness, staleness and eligibility are the
 * server's judgements; this file decides how to *say* them, and where the server's own
 * `reason` exists it is quoted rather than replaced (F24-AC2, F24-AC3).
 */

import type { StatusTone } from '../components/StatusBadge.tsx';
import type {
  CandidateCheckReport,
  RecordedObservationView,
  ReviewCardView,
  ReviewCheckView,
  ReviewCriterionView,
  ReviewDecisionView,
  ReviewEligibilityView,
  ReviewEvidenceView,
  ReviewOwnerTestView,
  ReviewStaleDecisionView,
} from '../mvp-client/index.ts';
import type { DecideCandidateOutcome } from '../mvp-client/index.ts';

/* -------------------------------------------------------------------------- */
/* The candidate card                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How the candidate card's own check vocabulary reads.
 *
 * The six words are the domain's, in the domain's casing, and they are *not* the card's
 * lowercase spelling. The two spellings exist because they are two projections of the same six
 * states, and a screen that translated between them would be the second place the vocabulary is
 * stated — which is how a `Passed` and a `passed` stop meaning the same thing (F20-AC2).
 */
const CANDIDATE_CHECK_LABELS: Readonly<Record<string, string>> = {
  Passed: 'Passed',
  Failed: 'Failed',
  Waiting: 'Still running — nothing concluded',
  Missing: 'Never ran — proves nothing',
  Stale: 'Stale — about another commit',
  NotApplicable: 'Not applicable',
};

/**
 * Tones, with `Passed` as the only healthy one.
 *
 * `Stale` and `NotApplicable` take a non-healthy tone deliberately. `NotApplicable` is a claim
 * about the *check* rather than about the product, and rendering it as anything better than
 * neutral is how a waived gate comes to read as a green one (F20-AC5).
 */
const CANDIDATE_CHECK_TONES: Readonly<Record<string, StatusTone>> = {
  Passed: 'healthy',
  Failed: 'revoked',
  Waiting: 'pending',
  Missing: 'degraded',
  Stale: 'degraded',
  NotApplicable: 'unconfigured',
};

/** One sentence per state, saying what it means for the commit on screen. */
const CANDIDATE_CHECK_STANDINGS: Readonly<Record<string, string>> = {
  Passed: 'The provider reported this check passing against the commit on screen.',
  Failed: 'The provider ran this check against the commit on screen and it failed.',
  Waiting: 'The provider is still running this. Nothing has concluded, and a running check is not a pass.',
  Missing: 'The provider reported no result for this at all, so nothing is known about what it would find.',
  Stale: 'This result was attributed to a commit that is not the one on screen, so it proves nothing about this candidate.',
  NotApplicable: 'The provider reported this check as not applicable. That is a claim about the check, not a pass.',
};

/** What one candidate-card check reads as, and whether it is about the commit on screen. */
export interface CandidateCheckReading {
  readonly result: string;
  readonly label: string;
  readonly tone: StatusTone;
  readonly standing: string;
  /**
   * Whether this row may be read as the candidate on screen's result.
   *
   * False whenever the provider attributed the run to another commit *or* to none. It is the
   * affirmative answer, and it is what a `Passed` must be gated on (F20-AC3).
   */
  readonly countsForCandidate: boolean;
  /** The commit the provider said it ran against, for display beside the badge. */
  readonly observedCommit: string | null;
  /** True when this build has no word for the result at all (F20-AC2). */
  readonly unread: boolean;
}

/**
 * One candidate-card check, with its result admitted as the word that arrived.
 *
 * `CandidateCheckReport.result` is `ProviderCheckResult`, a six-member union, but the client reads
 * a response body by member name rather than by parsing each field (`envelope` in
 * `mvp-client/transport.ts`), so a server that grows a seventh result would put it on screen while
 * the type still said six. That gap is exactly what the `unread` branch below exists to report, so
 * the parameter admits the wider word rather than leaving a branch no value can ever reach
 * (F20-AC2).
 */
export interface CandidateCheckInput extends Omit<CandidateCheckReport, 'result'> {
  readonly result: string;
}

/**
 * Reads one check from the candidate card.
 *
 * The ordering is the whole argument, and it is the same one `readEvidence` uses: **the commit
 * is consulted before the result.** A provider that reports `Passed` for a commit other than the
 * one on screen has proved something — just not about this candidate — and reading the result
 * first would find `Passed` before the condition that invalidates it was ever looked at. So:
 *
 *   1. attribution first. A row naming another commit, or no commit, does not count;
 *   2. then the result, mapped to a label and a tone;
 *   3. an unrecognised result is reported as unread rather than mapped onto a state.
 *
 * `blocking` is *not* read here. It is the route's own answer, computed with the domain's
 * `isBlocking`, and re-deriving it here would be a second opinion about what gates a candidate
 * (F20-AC2, F24-AC3).
 */
export function readCandidateCheck(check: CandidateCheckInput, candidateHeadSha: string): CandidateCheckReading {
  const observed = check.observedHeadSha;
  const countsForCandidate = observed !== null && observed === candidateHeadSha;
  const unread = !(check.result in CANDIDATE_CHECK_LABELS);

  if (!countsForCandidate) {
    // A row that does not count is described as such, whatever it recorded. The word "Passed" is
    // not shown for it: showing it and then explaining it away is how a stale pass reaches a
    // reader who skims (F20-AC3, F24-AC3).
    const where =
      observed === null
        ? 'The provider attributed this run to no commit, so it is evidence for no candidate (F20-AC3).'
        : `The provider attributed this run to ${observed}, which is not the commit on screen, so it proves nothing about this candidate however its result reads (F20-AC3, F24-AC3).`;
    return {
      result: check.result,
      label: countsForCandidate ? (CANDIDATE_CHECK_LABELS[check.result] ?? '') : 'Not about the commit on screen',
      tone: 'degraded',
      standing: where,
      countsForCandidate,
      observedCommit: observed,
      unread,
    };
  }

  return {
    result: check.result,
    label: unread ? `Unread: ${truncateWord(check.result)}` : CANDIDATE_CHECK_LABELS[check.result] ?? '',
    tone: unread ? 'neutral' : CANDIDATE_CHECK_TONES[check.result] ?? 'neutral',
    standing: unread
      ? 'This check came back as a result this build has no word for, so nothing is claimed about it. An unreadable result is not a pass (F20-AC2).'
      : CANDIDATE_CHECK_STANDINGS[check.result] ?? '',
    countsForCandidate,
    observedCommit: observed,
    unread,
  };
}

/**
 * The pull request states this build has words for, and what each one means.
 *
 * A closed vocabulary rather than a string switch at the call site, because a state outside it
 * has to be reported rather than guessed at. `Unknown` is a member of the domain's vocabulary and
 * is deliberately *not* `Open`: it means the provider reported something this product cannot
 * classify, and reading it as reviewable would present withdrawn work as open (mvp-spec F20-AC2).
 */
const PROVIDER_STATES: Readonly<Record<string, { readonly label: string; readonly tone: StatusTone; readonly standing: string }>> = {
  Open: {
    label: 'Open',
    tone: 'healthy',
    standing: 'The provider reports this pull request as open, so there is a change proposed.',
  },
  Closed: {
    label: 'Closed',
    tone: 'unconfigured',
    standing: 'The provider reports this pull request as closed. It is readable, and there is no open change to decide on.',
  },
  Merged: {
    label: 'Merged',
    tone: 'unconfigured',
    standing: 'The provider reports this pull request as merged, so the change has already landed.',
  },
  Unknown: {
    label: 'Unknown',
    tone: 'degraded',
    standing:
      'The provider reported a state this product does not classify, so it is reported as unknown rather than read as open or closed (mvp-spec F20-AC2).',
  },
};

/** What the pull request's state reads as, and whether this build could read it at all. */
export interface ProviderStateReading {
  readonly state: string;
  readonly label: string;
  readonly tone: StatusTone;
  readonly standing: string;
  /**
   * False for a state outside the product's vocabulary.
   *
   * False means *unread*, not closed and not open: the client says so rather than picking one of
   * the states it does have words for (mvp-spec F20-AC2).
   */
  readonly recognised: boolean;
}

/**
 * Reads a pull request state for display.
 *
 * An unrecognised value is reported as unread and never mapped onto `Open` or `Closed`. Both of
 * those would be a claim: `Open` would present withdrawn work as reviewable, and `Closed` would
 * assert a conclusion the provider never stated. The route refuses such a value before it can
 * reach a response, so this branch is the client's own defence of the same line rather than a
 * case the browser is expected to see (mvp-spec F20-AC2).
 */
export function readProviderState(state: string): ProviderStateReading {
  const known = PROVIDER_STATES[state];
  if (known !== undefined) {
    return { state, label: known.label, tone: known.tone, standing: known.standing, recognised: true };
  }
  return {
    state,
    label: `Unread: ${truncateWord(state)}`,
    tone: 'neutral',
    standing:
      'The provider reported a pull request state this build has no word for, so nothing is claimed about it. It is reported as unread rather than read as open or closed (mvp-spec F20-AC2).',
    recognised: false,
  };
}

/** Bounds a value quoted from something this build could not read (N02-AC2). */
function truncateWord(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

/* -------------------------------------------------------------------------- */
/* The verification report's observations                                      */
/* -------------------------------------------------------------------------- */

/** How one observation from a verification pass reads, as a badge and a sentence. */
export interface VerifyObservationReading {
  /** A closed key, so a reader or a test can tell the standings apart without parsing prose. */
  readonly key: 'stale' | 'unattributed' | 'passed' | 'failed' | 'running' | 'never-ran' | 'capture-failed' | 'unread';
  readonly tone: StatusTone;
  readonly label: string;
  readonly standing: string;
  /**
   * Whether this observation may be read as a result for the commit on screen.
   *
   * This is the affirmative answer the display gates on, and it is the answer that keeps a
   * `recordedOutcome: 'passed'` for an earlier commit out of a success colour (F20-AC3, F24-AC3).
   */
  readonly countsForCandidate: boolean;
}

/** What each outcome in the verification report's vocabulary reads as. */
const VERIFY_OUTCOMES: Readonly<
  Record<
    string,
    { readonly key: VerifyObservationReading['key']; readonly tone: StatusTone; readonly label: string; readonly standing: string }
  >
> = {
  passed: {
    key: 'passed',
    tone: 'healthy',
    label: 'Passed on this commit',
    standing:
      'The provider reported this check passing, and this observation counts for the commit on screen, so it is evidence about the code under review (F20-AC2, F24-AC3).',
  },
  failed: {
    key: 'failed',
    tone: 'revoked',
    label: 'Failed on this commit',
    standing:
      'The provider reported this check failing, and it counts for the commit on screen. A failure is a result about the product, not the absence of one (F20-AC2).',
  },
  waiting: {
    key: 'running',
    tone: 'pending',
    label: 'Still running — nothing concluded',
    standing:
      'The provider reports this check as still running. Nothing is known about what it will conclude, and nothing here is treated as a pass while it runs (F20-AC2, F24-AC3).',
  },
  missing: {
    key: 'never-ran',
    tone: 'degraded',
    label: 'Never ran — proves nothing',
    standing:
      'No run of this check was observed, so nothing is known about what it would have found. A required check that never ran is not a pass, and it blocks until it runs (F20-AC2, F20-AC5).',
  },
  capture_failed: {
    key: 'capture-failed',
    tone: 'degraded',
    label: 'Evidence was never captured',
    standing:
      'The evidence for this check was never captured. That is not a statement about the product: it can neither confirm a criterion nor report the behaviour as broken, and the criterion stays unverified (F23-AC5).',
  },
};

/**
 * Reads one observation from a verification pass.
 *
 * Staleness is decided **before** the recorded outcome is consulted, and that ordering is the
 * property rather than an incidental detail: if `recordedOutcome` were consulted first, a stale
 * pass would find its green badge before the condition that invalidates it was ever read, and the
 * label would then be correct only by accident. So:
 *
 *   1. `countsForCurrentCandidate` and `currentOutcome: 'stale'` are checked first, and a stale
 *      observation is never shown as a pass whatever it recorded;
 *   2. then the attribution is re-checked against the commit on screen, because an observation
 *      that names another commit — or none — is evidence for no candidate (F20-AC3, F24-AC3);
 *   3. then the current outcome is mapped, with an unrecognised one reported as unread rather
 *      than coerced onto a state (F20-AC2).
 */

/**
 * One verification observation, with its outcomes admitted as the words that arrived.
 *
 * Widened for the same reason as `CandidateCheckInput`, and the `unread` branch above is where the
 * extra width is spent: `RecordedObservationView` declares five outcomes plus `stale`, and a body
 * read by member name rather than by parsing each field is not proof that only those six will ever
 * arrive (F20-AC2).
 */
export interface VerifyObservationInput extends Omit<RecordedObservationView, 'recordedOutcome' | 'currentOutcome'> {
  readonly recordedOutcome: string;
  readonly currentOutcome: string;
}
export function readVerifyObservation(
  observation: VerifyObservationInput,
  candidateHeadSha: string,
): VerifyObservationReading {
  const stale = !observation.countsForCurrentCandidate || observation.currentOutcome === 'stale';
  if (stale) {
    return {
      key: 'stale',
      tone: 'degraded',
      label: 'Stale — about another commit',
      standing:
        'This observation does not count for the commit on screen. It was recorded for something else, so it proves nothing about the code now under review, and no readiness carried forward from it survives (F20-AC3, F24-AC4).',
      countsForCandidate: false,
    };
  }

  if (observation.observedHeadSha === null || observation.observedHeadSha !== candidateHeadSha) {
    return {
      key: 'unattributed',
      tone: 'degraded',
      label: 'Counts, but names no matching commit',
      standing:
        'This observation is marked as counting for the candidate while naming no commit, or naming a commit other than the one on screen. A result recorded for one commit cannot prove another, and an observation that attributes itself to nothing is evidence for no candidate, so neither reading is rendered as a verdict (F20-AC3, F24-AC3).',
      countsForCandidate: false,
    };
  }

  const known = VERIFY_OUTCOMES[observation.currentOutcome];
  if (known === undefined) {
    return {
      key: 'unread',
      tone: 'neutral',
      label: `Unread: ${truncateWord(observation.currentOutcome)}`,
      standing:
        'This observation came back as a result this build has no word for, so nothing is claimed about it. An unreadable result is not a pass (F20-AC2).',
      countsForCandidate: false,
    };
  }

  return { ...known, countsForCandidate: true };
}

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
 *
 * A result outside the vocabulary is reported as unread rather than mapped onto a state. The card's
 * `result` is transcribed as a `string` on the wire, so the closed union above is the *product's*
 * vocabulary rather than a guarantee about the bytes, and a client that indexed the maps directly
 * would render `undefined` for a word it does not know (F20-AC2).
 */
export function readCheck(check: ReviewCheckView, requiredCheckIds: readonly string[]): CheckReading {
  const known = CHECK_LABELS[check.result] !== undefined;
  return {
    label: known ? CHECK_LABELS[check.result] ?? '' : `Unread: ${truncateWord(check.result)}`,
    tone: known ? CHECK_TONES[check.result] ?? 'neutral' : 'neutral',
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

/**
 * What the client's decision call came back with, as the screen reads it.
 *
 * The typed client answers a decision with a discriminated union rather than a boolean, because
 * the four refusals need different remedies and a single "it failed" would tell the owner none of
 * them. This function is the one place that union becomes wording, and it has exactly two shapes:
 *
 *   - `recorded`, which happens only for `decided`. It carries no wording at all: the card is
 *     re-read afterwards and the server's own card is what says what was recorded, so this
 *     cannot claim an acceptance the server did not make (F24-AC2, F25-AC3).
 *   - `refused`, which carries a reading whose headline denies that anything was recorded, plus
 *     whether the card on screen is known to be out of date.
 */
export type DecisionOutcomeReading =
  | { readonly kind: 'recorded'; readonly review: ReviewCardView }
  | { readonly kind: 'refused'; readonly reading: RefusalReading };

/**
 * Reads a decision outcome.
 *
 * There is no third shape, and that is the property worth stating: this function cannot produce
 * a wording that reports success for anything other than a `decided` answer. `superseded-commit`
 * and `superseded-revision` both become a `Conflict`-shaped reading naming the two values, so
 * the owner learns which build they decided about and which one the server holds — and both set
 * `mustReloadCard`, because a submission prepared against facts that have moved cannot be
 * applied to the card on screen (F24-AC4, F25-AC3).
 *
 * `not-eligible` keeps the server's prerequisites, so the outstanding requirements are shown
 * rather than summarised as "not eligible" (F23-AC1, F24-AC3).
 */
export function readDecisionOutcome(outcome: DecideCandidateOutcome): DecisionOutcomeReading {
  if (outcome.kind === 'decided') return { kind: 'recorded', review: outcome.review };
  if (outcome.kind === 'superseded-commit' || outcome.kind === 'superseded-revision') {
    return {
      kind: 'refused',
      reading: readDecisionRefusal({
        code: 'Conflict',
        reason: outcome.reason,
        fields: [],
        prerequisites: [],
        expected: outcome.expected,
        actual: outcome.actual,
      }),
    };
  }
  return {
    kind: 'refused',
    reading: readDecisionRefusal({
      code: outcome.kind === 'not-eligible' ? 'Blocked' : 'Unavailable',
      reason: outcome.failure.reason,
      fields: outcome.failure.fields,
      prerequisites: outcome.failure.prerequisites,
      expected: outcome.failure.expected,
      actual: outcome.failure.actual,
    }),
  };
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
 * Reads a refused decision from a refusal-shaped value.
 *
 * `readDecisionOutcome` is what a screen calls; this is the rule underneath it, exported for the
 * owner-test write and for the tests that assert the headline directly.
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
