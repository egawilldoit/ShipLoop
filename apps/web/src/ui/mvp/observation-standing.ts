/**
 * What one recorded observation means for the candidate on screen
 * (mvp-spec F20-AC2, F20-AC3, F24-AC3, F24-AC4, N03-AC1).
 *
 * This file is pure and separate from `ObservationRow.tsx` because it is the one part of the
 * verification display that has to be checkable without a browser. The standing is the product's core
 * claim about what a check established, and a claim like that belongs in a file `node --test` can
 * reach rather than inside a component a test can only inspect by reading it.
 *
 * ## Five things that must never collapse into one
 *
 * A verification pass reports three outcomes per observation, and all three are read rather than the
 * one that is convenient:
 *
 *   1. **A check that passed** — and passed *against this commit*. `currentOutcome` is `passed` and
 *      `countsForCurrentCandidate` is true and the observation names the candidate's own SHA.
 *   2. **A check that failed** — the check ran, and the thing it checks does not hold. A failure is a
 *      result; it is neither a pass nor the absence of one, and it must not read as either (F20-AC2).
 *   3. **A check that is still running** — `waiting`. Nothing is known about the behaviour yet, and
 *      this is emphatically not a pass. A page that rendered "Waiting" beside "Passed" in the same
 *      green, or that counted a running check toward readiness, would be reporting a conclusion
 *      nobody reached (F20-AC2, F24-AC3).
 *   4. **A check that never ran** — `missing`, `not_run`, or `capture_failed`. A gate nobody
 *      exercised proves nothing, and a skipped required check is never a pass. `capture_failed` is
 *      kept apart from a behaviour failure too: a screenshot that was never taken observed nothing,
 *      so it can neither confirm a criterion nor report the product as broken (F23-AC5).
 *   5. **A result belonging to a different commit** — `currentOutcome` is `stale` and
 *      `countsForCurrentCandidate` is false, with `observedHeadSha` naming the commit the source
 *      actually attributed the run to. This is the one the other four make easy to get wrong:
 *      `recordedOutcome` is still `passed`, and rendering that word as a verdict would show a green
 *      tick for code nobody verified (F20-AC3, F24-AC3, F24-AC4).
 *
 * ## The order of the checks, which is the order of the argument
 *
 * Staleness is decided **first**, before the recorded outcome is consulted. That ordering is the
 * property, not an incidental detail: if `passed` were consulted first, a stale pass would find its
 * green badge before the condition that invalidates it was ever read, and the label would then be
 * correct only by accident. Deciding staleness first means the recorded word is rendered as history
 * and can never become a verdict.
 *
 * ## Two more states, because five is not the number of things that can be true
 *
 * `not_applicable` is a sixth: the provider reported the check as out of scope, which is a claim
 * about the check rather than about the product, and it is not a pass however it was approved
 * (F20-AC5).
 *
 * `unattributed` is a seventh, and it exists because two of the five cannot both be read as
 * verdicts. An observation can arrive marked as counting for this candidate while naming no commit,
 * or naming a different one. The route refuses that combination on the way out, so reaching one
 * means the check was bypassed — and the two fields disagreeing is the exact shape of the defect this
 * exists to stop. Neither is reconciled here and no winner is picked: no verdict is rendered, and the
 * two things that could not be reconciled are named, because picking one would be inventing the fact
 * that decided it (F20-AC3, F24-AC3).
 */

import type { StatusTone } from '../components/StatusBadge.tsx';

/**
 * What this module needs from one recorded observation.
 *
 * Declared here, structurally, rather than imported from a transport module. Two reasons, and both
 * are about what this file is for:
 *
 *   - it is the file that must be able to read a word it has no name for, so its input cannot be a
 *     closed union of known outcomes. `currentOutcome` and `recordedOutcome` are `string` here for
 *     that reason alone, and narrowing them at the type level would delete the `unread` standing
 *     this module exists to produce (F20-AC2);
 *   - it is a pure model, and a model that reaches into an HTTP layer to name its input is a model
 *     whose tests would need that layer to mean anything (F20-AC3, F24-AC3).
 *
 * The five fields a standing is derived from are listed first, and no standing reads any of the
 * others. The identities and the instant travel because `ObservationRow` presents the same row, and
 * it is better for a presenter and a model to agree on one shape than for the presenter to widen a
 * second copy of it — but they are marked so that a future standing cannot come to depend on one by
 * accident.
 */
export interface RecordedObservation {
  /** Carried for display. No standing reads it. */
  readonly evidenceId: string;
  /** Carried for display. No standing reads it. */
  readonly checkId: string;
  readonly recordedOutcome: string;
  readonly currentOutcome: string;
  readonly countsForCurrentCandidate: boolean;
  /** The full commit the source attributed the run to, or null when it attributed none. */
  readonly observedHeadSha: string | null;
  readonly reason: string;
  /** Carried for display. No standing reads it. */
  readonly observedAt: string | null;
}

/**
 * The standings an observation can be rendered in.
 *
 * A closed union rather than a free string, so a new branch in `standingOf` that forgets to name
 * itself is a type error rather than a badge no test looks for, and so a sixth or seventh standing
 * can never be introduced as an unnoticed variant of one of the five.
 */
export type ObservationStanding =
  | 'stale'
  | 'unattributed'
  | 'not-applicable'
  | 'passed'
  | 'failed'
  | 'running'
  | 'never-ran'
  | 'capture-failed'
  | 'unread';

/**
 * How one standing reads.
 *
 * `key` is carried rather than parsed back out of `label`, so a test or a browser extension can tell
 * the standings apart without matching prose, and so rewording a badge cannot silently change which
 * standing it is (N03-AC1).
 */
export interface StandingPresentation {
  readonly key: ObservationStanding;
  readonly tone: StatusTone;
  /** The word shown in the badge. Short, and never a synonym for another standing. */
  readonly label: string;
  /** The sentence under it. States what counts now, not what the source once said. */
  readonly standing: string;
}

/**
 * Whether this observation is attributed to the commit on screen.
 *
 * Separate from `countsForCurrentCandidate` because the route derives the two differently: one is the
 * server's verdict about whether it counts, and this is the arithmetic underneath it. An observation
 * that names no commit is evidence for no candidate at all, so a null is false rather than "unknown" —
 * there is nothing to attribute, and treating it as matching would let an unattributed result into a
 * verdict (F20-AC3).
 */
export function attributedToCandidate(observation: RecordedObservation, candidateHeadSha: string): boolean {
  if (observation.observedHeadSha === null) return false;
  return observation.observedHeadSha === candidateHeadSha;
}

/** What one observation means for the candidate on screen, as a badge and a sentence. */
export function standingOf(observation: RecordedObservation, candidateHeadSha: string): StandingPresentation {
  // 1. Staleness first, always. A result recorded for one commit cannot prove another, whatever it
  //    said at the time, so no recorded outcome is consulted before this has been decided.
  if (!observation.countsForCurrentCandidate || observation.currentOutcome === 'stale') {
    return {
      key: 'stale',
      tone: 'degraded',
      label: 'Stale — about another commit',
      standing:
        'This observation does not count for the candidate on screen. It was recorded against a commit that is ' +
        'no longer the head, so it proves nothing about the code now under review, and no readiness carried forward ' +
        'from it survives (F20-AC3, F24-AC4).',
    };
  }

  // 1b. The flag is re-checked against the commit rather than trusted on its own. See the module
  //     comment: reaching here means the route's own guard did not hold, and the two fields
  //     disagreeing is the shape of the defect where a stale pass renders green.
  if (!attributedToCandidate(observation, candidateHeadSha)) {
    return {
      key: 'unattributed',
      tone: 'degraded',
      label: 'Counts, but names no matching commit',
      standing:
        'This observation is marked as counting for the candidate while naming no commit, or naming a commit other ' +
        'than the one on screen. A result recorded for one commit cannot prove another, and an observation that ' +
        'attributes itself to nothing is evidence for no candidate, so neither reading is rendered as a verdict ' +
        '(F20-AC3, F24-AC3).',
    };
  }

  // 2. Not applicable, with the policy approval read rather than assumed. A bare "not applicable"
  //    would itself be a claim that a gate was waived; the route only stops a not-applicable check
  //    blocking once a policy decision approved it, and that decision is not this page's to make.
  if (observation.currentOutcome === 'not_applicable') {
    return {
      key: 'not-applicable',
      tone: 'unconfigured',
      label: observation.reason === '' ? 'Not applicable' : 'Not applicable by policy',
      standing:
        'The provider reported this check as not applicable. ' +
        (observation.reason === ''
          ? 'No approval of that exemption is named here, so nothing is claimed about it (F20-AC5).'
          : observation.reason) +
        ' It is not counted as a pass.',
    };
  }

  // 3. Passed. Reachable only for an observation that names this candidate's own commit.
  if (observation.currentOutcome === 'passed') {
    return {
      key: 'passed',
      tone: 'healthy',
      label: 'Passed on this commit',
      standing:
        'The provider reported this check passing, and this observation counts for the candidate on screen, so it ' +
        'is evidence about the code under review (F20-AC2, F24-AC3).',
    };
  }

  // 4. Failed. A result, kept apart from both a pass and an absence.
  if (observation.currentOutcome === 'failed') {
    return {
      key: 'failed',
      tone: 'revoked',
      label: 'Failed on this commit',
      standing:
        'The provider reported this check failing, and it counts for the candidate on screen. A failure is a result ' +
        'about the product, not the absence of one (F20-AC2).',
    };
  }

  // 5. Still running. Explicitly not a pass, and explicitly not a failure of the product either.
  if (observation.currentOutcome === 'waiting') {
    return {
      key: 'running',
      tone: 'pending',
      label: 'Still running — nothing concluded',
      standing:
        'The provider reports this check as still running. Nothing is known about what it will conclude, and nothing ' +
        'here is treated as a pass while it runs (F20-AC2, F24-AC3).',
    };
  }

  // 6. Never ran. A skipped or unrun required check is Missing, never Passed.
  if (observation.currentOutcome === 'missing' || observation.currentOutcome === 'not_run') {
    return {
      key: 'never-ran',
      tone: 'degraded',
      label: 'Never ran — proves nothing',
      standing:
        'No run of this check was observed, so nothing is known about what it would have found. A required check ' +
        'that never ran is not a pass, and it blocks until it runs (F20-AC2, F20-AC5).',
    };
  }

  // 7. A capture that never happened. Distinct from a behaviour failure: it observed nothing, so it
  //    can neither confirm a criterion nor report the product as broken (F23-AC5).
  if (observation.currentOutcome === 'capture_failed') {
    return {
      key: 'capture-failed',
      tone: 'degraded',
      label: 'Evidence was never captured',
      standing:
        'The evidence for this check was never captured. That is not a statement about the product: it can neither ' +
        'confirm a criterion nor report the behaviour as broken, and the criterion stays unverified (F23-AC5).',
    };
  }

  // 8. A word this build has no name for. Reported as unread rather than mapped onto a pass or a
  //    failure, because inventing the name is how an unknown becomes a known one (F20-AC2).
  return {
    key: 'unread',
    tone: 'neutral',
    label: `Unread: ${truncate(observation.currentOutcome)}`,
    standing:
      'This observation came back as a result this build has no word for, so nothing is claimed about it. An ' +
      'unreadable result is not a pass (F20-AC2).',
  };
}

/** Bounds a value quoted from an unrecognised result, so an unreadable word is not echoed whole. */
export function truncate(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}