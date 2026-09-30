/**
 * Writer liveness, reconciliation and reclaim policy (F17-AC3, F17-AC5, F30-AC4).
 *
 * A missed heartbeat is a reason to look, not a reason to take over. Losing the
 * heartbeat does not mean the previous writer stopped, so the decision type
 * returned here makes "reconcile the process" and "reclaim the job" different
 * outcomes with different required records, and a caller cannot read a missed
 * heartbeat as permission to start a second writer.
 *
 * Every timestamp is injected. This module never reads the current time.
 */

export interface HeartbeatDefaults {
  /** How often a live writer reports in. */
  readonly intervalMs: number;
  /** Silence beyond this begins process reconciliation. */
  readonly missedThresholdMs: number;
  /** Provider reconciliation cadence for active or awaiting items. */
  readonly reconciliationIntervalMs: number;
}

/** The v0.1 heartbeat defaults from "Defaults to validate". */
export const DEFAULT_HEARTBEAT: HeartbeatDefaults = Object.freeze({
  intervalMs: 15_000,
  missedThresholdMs: 60_000,
  reconciliationIntervalMs: 60_000,
});

export type HeartbeatStatus = 'Healthy' | 'ReconciliationRequired' | 'ReclaimForbidden';

export type HeartbeatAssessment =
  | {
      readonly status: 'Healthy';
      readonly silenceMs: number;
      readonly nextHeartbeatDueInMs: number;
    }
  | {
      readonly status: 'ReconciliationRequired';
      readonly silenceMs: number;
      /** A missed heartbeat never authorizes a second writer (F17-AC5). */
      readonly launchesSecondWriter: false;
      readonly requiredSteps: readonly string[];
    }
  | {
      readonly status: 'ReclaimForbidden';
      readonly silenceMs: number;
      readonly reason: string;
      readonly requiredSteps: readonly string[];
    };

/**
 * Classifies writer liveness from recorded timestamps.
 *
 * Silence strictly below the threshold is Healthy; at exactly the threshold the
 * writer is already late and reconciliation begins, so the boundary is not
 * dependent on rounding.
 *
 * An expired lease is reported as ReclaimForbidden rather than as an invitation:
 * the lease proves only that the writer stopped renewing it, not that it stopped
 * writing, so the decision a caller receives names the confirmation that is
 * missing instead of a permission it must then interpret.
 */
export function evaluateHeartbeat(input: {
  readonly lastHeartbeatAtMs: number;
  readonly nowMs: number;
  readonly intervalMs?: number;
  readonly missedThresholdMs?: number;
  readonly leaseExpiredAtMs?: number | null;
  readonly holderStoppedConfirmedAtMs?: number | null;
}): HeartbeatAssessment {
  const intervalMs = input.intervalMs ?? DEFAULT_HEARTBEAT.intervalMs;
  const missedThresholdMs = input.missedThresholdMs ?? DEFAULT_HEARTBEAT.missedThresholdMs;
  const silenceMs = Math.max(0, input.nowMs - input.lastHeartbeatAtMs);

  if (silenceMs < missedThresholdMs) {
    return {
      status: 'Healthy',
      silenceMs,
      nextHeartbeatDueInMs: Math.max(0, intervalMs - silenceMs),
    };
  }

  const leaseExpiredAtMs = input.leaseExpiredAtMs ?? null;
  if (leaseExpiredAtMs !== null && input.nowMs >= leaseExpiredAtMs && input.holderStoppedConfirmedAtMs === null) {
    return {
      status: 'ReclaimForbidden',
      silenceMs,
      reason:
        'The lease has expired but the previous holder has not been confirmed stopped. An expired lease is not proof that the old process stopped writing.',
      requiredSteps: ['Establish whether the previous process is still writing'],
    };
  }

  return {
    status: 'ReconciliationRequired',
    silenceMs,
    launchesSecondWriter: false,
    requiredSteps: ['Establish whether the previous process is still writing'],
  };
}

/** A recorded fact about the previous writer, each of which must exist to reclaim. */
export interface ReclaimEvidence {
  readonly leaseExpiredAtMs: number;
  readonly holderConfirmedStoppedAtMs: number | null;
  readonly confirmedBy: string | null;
}

export type ReclaimDecision =
  | {
      readonly permitted: true;
      readonly missing: readonly [];
      readonly conditions: readonly string[];
    }
  | {
      readonly permitted: false;
      readonly missing: readonly ReclaimRequirement[];
      readonly conditions: readonly string[];
    };

export type ReclaimRequirement =
  | 'LeaseExpired'
  | 'HolderConfirmedStopped'
  | 'HolderConfirmationAttributed'
  | 'LeaseExpiryNotFuture';

/**
 * Decides whether a job may be handed to another writer (F17-AC5).
 *
 * Every condition is checked, and the refusal lists what is missing rather than
 * only asserting that something is wrong, because the missing facts are what
 * reconciliation has to produce. An expired lease on its own is never sufficient:
 * the holder's stopped state must be confirmed and that confirmation attributed.
 */
export function evaluateReclaim(
  input: ReclaimEvidence & {
    readonly nowMs: number;
  },
): ReclaimDecision {
  const missing: ReclaimRequirement[] = [];
  if (input.nowMs < input.leaseExpiredAtMs) missing.push('LeaseExpiryNotFuture');
  if (input.holderConfirmedStoppedAtMs === null) missing.push('HolderConfirmedStopped');
  else if (input.holderConfirmedStoppedAtMs > input.nowMs) missing.push('HolderConfirmedStopped');
  if (input.confirmedBy === null) missing.push('HolderConfirmationAttributed');

  const conditions: readonly string[] = [
    'The previous holder was observed to have stopped writing.',
    'The confirmation is attributed to a named observer.',
  ];

  if (missing.length === 0) return { permitted: true, missing: [], conditions };
  return { permitted: false, missing, conditions };
}

/**
 * Bounded, monotonic reconciliation backoff (F30-AC4).
 *
 * Doubling is capped at `maxMs` and never decreases as attempts rise, so a
 * long-failing reconciliation slows down instead of hammering a provider that
 * is already refusing. Zero or negative attempt counts are treated as the first
 * attempt rather than producing a negative delay.
 */
export function reconciliationBackoff(attempts: number, baseMs: number, maxMs: number): number {
  const cappedBase = Math.max(0, Math.min(baseMs, maxMs));
  if (attempts <= 0) return cappedBase;
  const exponent = Math.min(attempts - 1, 31);
  return Math.min(maxMs, cappedBase * 2 ** exponent);
}