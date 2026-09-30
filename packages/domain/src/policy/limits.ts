import type { Result } from '../result.ts';
import { err, invalid, ok } from '../result.ts';

/**
 * Bounded attempt limits and failure diagnosis (F18, N06-AC2, N07-AC2).
 *
 * An attempt is bounded by declared, inspectable limits rather than by judgement
 * at the moment it gets expensive. Reaching a limit must checkpoint the work and
 * wait for an owner extension, never silently continue (F18-AC2).
 *
 * The clock is always injected. This module never reads the current time, so a
 * decision is reproducible from recorded timestamps and a recorded failure is the
 * same value on every replay.
 */

/** One interval during which the owner, not the agent, controlled progress. */
export interface OwnerWaitInterval {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  /** Pre-computed so elapsed-time arithmetic never has to consult a clock. */
  readonly waitedMs: number;
  readonly reason: string;
}

/**
 * Records a required owner wait (F18-AC3).
 *
 * An owner wait is an input to the elapsed-time calculation, not a special case
 * inside it, so time the owner spends cannot be charged to the execution budget
 * by an omitted field.
 */
export function recordOwnerWait(startedAtMs: number, endedAtMs: number, reason: string): OwnerWaitInterval {
  return {
    startedAtMs,
    endedAtMs,
    waitedMs: Math.max(0, endedAtMs - startedAtMs),
    reason,
  };
}

/**
 * Wall-clock milliseconds an attempt has been open, minus recorded owner waits.
 *
 * Clamped at zero so an overlapping or mis-recorded wait cannot manufacture
 * negative active time and thereby extend the budget.
 */
export function elapsedActiveTime(input: {
  readonly wallClockMs: number;
  readonly ownerWaits: readonly OwnerWaitInterval[];
}): number {
  const waited = input.ownerWaits.reduce((total, wait) => total + wait.waitedMs, 0);
  return Math.max(0, input.wallClockMs - waited);
}

/** Separate bounded retry allowance for tool and network calls (F18-AC3). */
export interface ToolRetryLimits {
  readonly attemptsPerOperation: number;
  readonly totalRetriesPerAttempt: number;
  readonly maxRetryIntervalMs: number;
}

export interface AttemptLimits {
  /** Wall-clock active execution permitted per attempt, excluding owner waits. */
  readonly activeExecutionMs: number;
  /** Automated code-fix passes permitted per attempt. */
  readonly automatedFixPasses: number;
  readonly toolRetry: ToolRetryLimits;
}

/**
 * The v0.1 defaults from "Defaults to validate": 60 minutes of active execution
 * and two automated fix passes, plus the separate tool/network retry allowance
 * F18-AC3 requires.
 *
 * Frozen and exported so a profile can be inspected, reported and diffed rather
 * than re-deriving these numbers inside execution code.
 */
export const DEFAULT_LIMITS: AttemptLimits = Object.freeze({
  activeExecutionMs: 3_600_000,
  automatedFixPasses: 2,
  toolRetry: Object.freeze({
    attemptsPerOperation: 3,
    totalRetriesPerAttempt: 20,
    maxRetryIntervalMs: 60_000,
  }),
});

export interface ActiveExecutionBudget {
  readonly consumedMs: number;
  readonly remainingMs: number;
  readonly exceeded: boolean;
  readonly limitMs: number;
}

/** Remaining active execution, derived from injected timestamps only. */
export function activeExecutionBudget(input: {
  readonly limits: AttemptLimits;
  readonly wallClockMs: number;
  readonly ownerWaits: readonly OwnerWaitInterval[];
}): ActiveExecutionBudget {
  const consumedMs = elapsedActiveTime(input);
  return {
    consumedMs,
    remainingMs: Math.max(0, input.limits.activeExecutionMs - consumedMs),
    exceeded: consumedMs >= input.limits.activeExecutionMs,
    limitMs: input.limits.activeExecutionMs,
  };
}

export type ExceededLimit = 'ActiveExecutionTime' | 'AutomatedFixPasses';

export interface LimitsEvaluation {
  readonly withinLimits: boolean;
  /** Every limit crossed, in evaluation order. Empty while within limits. */
  readonly reached: readonly ExceededLimit[];
  readonly activeMs: number;
  readonly fixPasses: number;
  readonly reason: string;
  /** True only when the attempt must checkpoint and wait for an owner extension. */
  readonly ownerExtensionRequired: boolean;
}

/**
 * Decides whether an attempt must checkpoint and wait (F18-AC2).
 *
 * Both limits are evaluated so the recorded reason names every limit actually
 * reached rather than the first one the code happened to test. Owner waits are
 * excluded here too, so a long owner think-time cannot trip the execution limit.
 */
export function evaluateLimits(input: {
  readonly limits: AttemptLimits;
  readonly wallClockMs: number;
  readonly fixPasses: number;
  readonly ownerWaits: readonly OwnerWaitInterval[];
}): LimitsEvaluation {
  const budget = activeExecutionBudget(input);
  const reached: ExceededLimit[] = [];
  if (budget.exceeded) reached.push('ActiveExecutionTime');
  if (input.fixPasses > input.limits.automatedFixPasses) reached.push('AutomatedFixPasses');

  return {
    withinLimits: reached.length === 0,
    reached,
    activeMs: budget.consumedMs,
    fixPasses: input.fixPasses,
    reason: describeLimitDecision(reached, budget.limitMs, input.limits.automatedFixPasses),
    ownerExtensionRequired: reached.length > 0,
  };
}

/**
 * Whether a tool or network retry is still inside its separate allowance.
 *
 * Tool retries must not restart coding work, so exhausting this allowance is a
 * failure of that operation only, not of the attempt's fix-pass budget.
 */
export function retryAllowedWithinLimits(input: {
  readonly limits: AttemptLimits;
  readonly operationRetries: number;
  readonly totalRetries: number;
}): Result<{ readonly retry: true }> {
  const { toolRetry } = input.limits;
  if (input.operationRetries >= toolRetry.attemptsPerOperation) {
    return err(
      invalid('Tool retry allowance for this operation is exhausted', [
        { path: 'operationRetries', message: `At most ${toolRetry.attemptsPerOperation} attempts per operation.` },
      ]),
    );
  }
  if (input.totalRetries >= toolRetry.totalRetriesPerAttempt) {
    return err(
      invalid('Tool retry allowance for this attempt is exhausted', [
        { path: 'totalRetries', message: `At most ${toolRetry.totalRetriesPerAttempt} retries per attempt.` },
      ]),
    );
  }
  return ok({ retry: true });
}

export type FailureStage =
  | 'Clarification'
  | 'Planning'
  | 'WorkspacePreparation'
  | 'EngineExecution'
  | 'CodeFix'
  | 'CheckExecution'
  | 'Review'
  | 'PullRequest'
  | 'Delivery'
  | 'Release'
  | 'ProviderSync'
  | 'Reconciliation';

export type FailureCategory =
  | 'DeterministicAuth'
  | 'DeterministicScope'
  | 'ProviderRateLimit'
  | 'ProviderQuota'
  | 'EngineUnavailable'
  | 'Environment'
  | 'Timeout'
  | 'Unknown';

export interface ObservedFailureEvidence {
  readonly error: string;
  /** Sanitized artifact, log or provider-response references seen at the stage. */
  readonly references: readonly string[];
}

/** Remedies the product must never take in response to a category (N07-AC2). */
export type ProhibitedRemedy =
  | 'RetryIdentically'
  | 'SilentPlanUpgrade'
  | 'PaidModelFallback'
  | 'AccountRotation';

/**
 * A failure as recorded (F18-AC1).
 *
 * Stage, observed evidence, category, attempted remedy and recommended next
 * action are all present on every record, so no consumer has to infer them from
 * a message string.
 */
export interface FailureRecord {
  readonly stage: FailureStage;
  readonly observed: ObservedFailureEvidence;
  readonly category: FailureCategory;
  readonly attemptedRemedy: string | null;
  readonly recommendedNextAction: string;
  /** False for deterministic scope/authentication failures (F18-AC5). */
  readonly retryable: boolean;
  readonly requiresOwnerAction: boolean;
  readonly prohibitedRemedies: readonly ProhibitedRemedy[];
}

/**
 * Categories an identical retry cannot improve on.
 *
 * A missing credential or an absent capability fails identically on every pass,
 * so retrying spends the fix-pass budget to reach the same conclusion (F18-AC5).
 * An exhausted quota is included because the work is preserved and the operation
 * is blocked until capacity is restored, which is an owner-side change rather
 * than something another attempt can resolve (N07-AC2).
 */
const NON_RETRYABLE_CATEGORIES: ReadonlySet<FailureCategory> = new Set<FailureCategory>([
  'DeterministicAuth',
  'DeterministicScope',
  'ProviderQuota',
]);

export function isRetryableCategory(category: FailureCategory): boolean {
  return !NON_RETRYABLE_CATEGORIES.has(category);
}

/**
 * Builds the failure record (F18-AC1).
 *
 * `category` is an input rather than a guess from the message: the caller holds
 * the provider response and the workspace evidence, and this function holds only
 * the policy of what each category permits.
 */
export function classifyFailure(input: {
  readonly stage: FailureStage;
  readonly observed: ObservedFailureEvidence;
  readonly category: FailureCategory;
  readonly attemptedRemedy?: string | null;
}): FailureRecord {
  const retryable = isRetryableCategory(input.category);
  const quota = input.category === 'ProviderQuota';
  return {
    stage: input.stage,
    observed: input.observed,
    category: input.category,
    attemptedRemedy: input.attemptedRemedy ?? null,
    recommendedNextAction: nextActionFor(input.stage, input.category),
    retryable,
    requiresOwnerAction: !retryable || quota,
    prohibitedRemedies: quota
      ? ['SilentPlanUpgrade', 'PaidModelFallback', 'AccountRotation', 'RetryIdentically']
      : retryable
        ? []
        : ['RetryIdentically'],
  };
}

function nextActionFor(stage: FailureStage, category: FailureCategory): string {
  if (category === 'DeterministicAuth') {
    return `Supply valid credentials for ${stage} in the project profile, then start a new attempt.`;
  }
  if (category === 'DeterministicScope') {
    return 'Correct the scope or configuration that is missing, then start a new attempt.';
  }
  if (category === 'ProviderRateLimit') {
    return 'Wait for the provider window to reset and resume; no fix pass is needed.';
  }
  if (category === 'ProviderQuota') {
    return 'Wait for quota to be restored or have the owner adjust the plan. Preserve the current work.';
  }
  if (category === 'EngineUnavailable') {
    return 'Confirm the execution engine is reachable, then resume the checkpointed attempt.';
  }
  if (category === 'Environment') {
    return 'Repair the environment before resuming; do not retry inside the same environment.';
  }
  if (category === 'Timeout') {
    return 'Resume from the last checkpoint, or reduce the remaining work before continuing.';
  }
  return 'Record more evidence at this stage before deciding whether to retry.';
}

export type UsageFact = number | 'Unknown';

export interface ProviderUsageObservation {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * Provider usage as displayed (F18-AC4, N06-AC2).
 *
 * Only figures the engine actually reported are carried through. Remaining quota
 * and cost are typed as permanently Unknown because ShipLoop has no verified
 * source for either, which makes inventing them a type error rather than a
 * display bug.
 */
export interface ReportedUsage {
  readonly availability: 'Reported' | 'Unknown';
  readonly inputTokens: UsageFact;
  readonly outputTokens: UsageFact;
  readonly totalTokens: UsageFact;
  readonly remainingQuota: 'Unknown';
  readonly cost: 'Unknown';
  readonly source: 'EngineReported' | 'Absent';
}

export function usageReporting(usage: ProviderUsageObservation | null): ReportedUsage {
  if (usage === null) {
    return {
      availability: 'Unknown',
      inputTokens: 'Unknown',
      outputTokens: 'Unknown',
      totalTokens: 'Unknown',
      remainingQuota: 'Unknown',
      cost: 'Unknown',
      source: 'Absent',
    };
  }
  const inputTokens = usage.inputTokens ?? 'Unknown';
  const outputTokens = usage.outputTokens ?? 'Unknown';
  const totalTokens =
    typeof inputTokens === 'number' && typeof outputTokens === 'number' ? inputTokens + outputTokens : 'Unknown';
  return {
    availability: 'Reported',
    inputTokens,
    outputTokens,
    totalTokens,
    remainingQuota: 'Unknown',
    cost: 'Unknown',
    source: 'EngineReported',
  };
}

function describeLimitDecision(
  reached: readonly ExceededLimit[],
  activeLimitMs: number,
  fixLimit: number,
): string {
  if (reached.length === 0) return 'Within the active execution and automated fix pass limits.';
  return reached
    .map((limit) =>
      limit === 'ActiveExecutionTime'
        ? `Active execution reached ${activeLimitMs}ms excluding owner waits.`
        : `Automated fix passes exceeded the limit of ${fixLimit}.`,
    )
    .join(' ');
}