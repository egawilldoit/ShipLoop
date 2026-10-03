import type { CriterionVerificationMethod } from '../evidence.ts';
import type { MvpBindingMatch, MvpEvidenceOutcome, MvpEvidenceSource } from './evidence.ts';

/**
 * The contract's declared verification type for a criterion (mvp-spec 3).
 *
 * Two values only. `automated` means a configured command, a provider check or a
 * configured browser flow decides it; `owner_test` means only the owner can. Nothing
 * else is expressible, so no assignment can quietly create a third weaker option.
 */
export type MvpVerificationType = 'automated' | 'owner_test';

/** The five states an MVP criterion can be in. */
export const CRITERION_STATES = ['passed', 'failed', 'pending', 'stale', 'unverified'] as const;
export type CriterionState = (typeof CRITERION_STATES)[number];

/**
 * Criterion states for the minimal MVP.
 *
 * Five states, and they are not the same five the older check vocabulary uses, because
 * the owner-facing question is different: not "what did the check report" but "what is
 * standing behind this criterion right now". `pending` and `unverified` are the two that
 * must never collapse — `pending` means the owner still owns a step, `unverified` means
 * nobody has observed it and nobody is scheduled to. Reporting a `pending` owner test
 * as `unverified` hides the owner's own work; reporting it as `passed` fabricates it.
 *
 * The one structural guarantee this module makes: `passed` is reachable only from an
 * `Observation`, never from a status string. There is no branch that turns free text,
 * an agent message or a missing row into a pass.
 */

/**
 * Whether a state leaves work outstanding that only an owner can discharge.
 *
 * Used to decide what the review card offers next. `stale` is deliberately not here:
 * stale evidence is a reason to re-verify, which ShipLoop owns, not a reason to ask the
 * owner to do something (F24-AC3).
 */
export function isOutstanding(state: CriterionState): boolean {
  return state === 'pending' || state === 'unverified';
}

/** Whether a state may be offered to the owner as ready for their test. */
export function satisfiesCriterionForReview(state: CriterionState): boolean {
  return state === 'passed';
}

export interface Observation {
  readonly outcome: MvpEvidenceOutcome;
  readonly source: MvpEvidenceSource;
  readonly method: CriterionVerificationMethod;
  readonly observedAt: string | null;
  readonly evidenceId: string;
}

export interface CriterionStateInput {
  readonly verificationType: MvpVerificationType;
  readonly method: CriterionVerificationMethod;
  /** Evidence judged against the current candidate, or null when none was. */
  readonly observation: Observation | null;
  /** Whether that evidence still describes the current candidate. */
  readonly binding: MvpBindingMatch | null;
}

export interface CriterionStateVerdict {
  readonly state: CriterionState;
  readonly reason: string;
}

/**
 * Derives one criterion's state.
 *
 * Precedence is deliberate and is the whole of the honesty guarantee:
 *
 *   1. **Stale first.** Evidence bound to another SHA or another contract revision is
 *      `stale` even when it says `passed`. This is why a pushed commit immediately
 *      drops a candidate out of review rather than quietly keeping its green checks
 *      (F20-AC3, F24-AC4).
 *   2. **A missing observation is never a pass.** With no observation the state is
 *      `pending` for an owner test and `unverified` for everything else (F23-AC1).
 *   3. **A method may only be satisfied by its own kind of evidence.** An automated
 *      check result on an owner-test criterion leaves it `pending`, because the owner
 *      has not done the thing (F23-AC1). A browser capture on an automated criterion is
 *      honoured, because a configured browser flow *is* the automated method.
 *   4. **Only then does the outcome speak.** `failed` and `capture_failed` are kept
 *      apart: a capture that never happened is `unverified`, because nothing was
 *      observed and calling it a failure would send a fix pass after a camera (F23-AC5).
 */
export function deriveCriterionState(input: CriterionStateInput): CriterionStateVerdict {
  const { verificationType, method, observation, binding } = input;

  if (observation === null) {
    return verificationType === 'owner_test'
      ? { state: 'pending', reason: 'This criterion is verified by the owner, and the owner test has not been recorded (F23-AC1).' }
      : { state: 'unverified', reason: 'Nothing observed this criterion for the current candidate, so it is unverified (F23-AC1).' };
  }

  if (binding !== null && !binding.applies) {
    return {
      state: 'stale',
      reason: binding.reason,
    };
  }

  if (verificationType === 'owner_test' && observation.source !== 'owner_test') {
    return {
      state: 'pending',
      reason: 'An automated result cannot discharge an owner test. The owner still has to run it (F23-AC1).',
    };
  }

  if (verificationType === 'automated' && observation.source === 'owner_test') {
    return {
      state: 'unverified',
      reason: 'An owner test does not stand in for the configured automated verification of this criterion (F23-AC1).',
    };
  }

  if (!methodSatisfiedBy(method, observation.source)) {
    return {
      state: 'unverified',
      reason: `The recorded ${observation.source} result does not use this criterion's assigned method, so it cannot verify it (F23-AC1).`,
    };
  }

  switch (observation.outcome) {
    case 'passed':
      return { state: 'passed', reason: `Verified by ${observation.source} against the current candidate.` };
    case 'failed':
      return { state: 'failed', reason: `The ${observation.source} verification of this criterion reported a failure against the current candidate.` };
    case 'waiting':
      return { state: 'pending', reason: `The ${observation.source} verification of this criterion has not finished, so there is nothing to judge yet.` };
    case 'capture_failed':
      return {
        state: 'unverified',
        reason: 'The capture itself failed, so no behaviour was observed. That is a capture failure, not a behaviour failure (F23-AC5).',
      };
    case 'missing':
      return {
        state: 'unverified',
        reason: `The ${observation.source} verification of this criterion never ran. A check that did not run is not a pass (F20-AC2).`,
      };
  }
}

/**
 * Whether an observation source can discharge a method.
 *
 * `Untested` cannot be satisfied by anything, which is what makes a criterion left
 * without an assignment permanently unverified rather than quietly passing on the first
 * green check (F23-AC1).
 */
export function methodSatisfiedBy(method: CriterionVerificationMethod, source: MvpEvidenceSource): boolean {
  switch (method.kind) {
    case 'AutomatedCheck':
      return source === 'project_command' || source === 'github_check';
    case 'BrowserEvidence':
    case 'ApiEvidence':
      return source === 'browser';
    case 'OwnerTest':
      return source === 'owner_test';
    case 'Untested':
      return false;
  }
}