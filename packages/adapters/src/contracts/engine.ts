import type { CapabilityKind, CommitSha, Fingerprint, OperationId, ProviderId, Result } from '@shiploop/domain';
import type {
  AdapterContext,
  AdapterIdentity,
  ArtifactReference,
  CodingSessionCapability,
  ExecutionWorkspace,
} from './index.ts';

export type EngineCapability = Extract<CapabilityKind, `Engine:${string}`>;

export type EngineMode = 'Headless' | 'Interactive';

/**
 * Active budgets for one engine session.
 *
 * `activeWallClockMs` excludes any time the owner is being asked something, and
 * `retryBudget` is separate so a network retry cannot restart the whole coding
 * budget (F18-AC2, F18-AC3).
 */
export interface EngineBounds {
  readonly activeWallClockMs: number;
  readonly retryBudget: number;
  readonly eventCountLimit: number;
}

/** Everything needed to continue an attempt without the engine's own conversation. */
export interface EngineCheckpoint {
  readonly checkpointId: string;
  readonly capturedAt: string;
  readonly scopeFingerprint: Fingerprint;
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  readonly dirtyPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
  readonly blocker: string | null;
  readonly nextAction: string;
  readonly resumeInstructions: string;
}

export type EngineStage =
  | 'Preparing'
  | 'ReadingInstructions'
  | 'Planning'
  | 'Implementing'
  | 'RunningChecks'
  | 'PreparingDraft'
  | 'SummingUp';

/** Deterministic failures are not retried blindly (F18-AC5). */
export type EngineDiagnosticRetry = 'Retryable' | 'Terminal';

export type EngineDiagnosticCategory =
  | 'MalformedOutput'
  | 'MissingAuthentication'
  | 'UnavailableModel'
  | 'QuotaExhausted'
  | 'UnsupportedRuntime'
  | 'ToolError'
  | 'NetworkError'
  | 'SandboxDenial';

export interface EngineUsage {
  readonly availability: 'Reported' | 'Unknown';
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly billedAmount: string | null;
  readonly currency: string | null;
  /** Why usage is Unknown. Required whenever availability is 'Unknown'. */
  readonly unknownReason: string | null;
}

/**
 * What the engine reported about its own consumption.
 *
 * Missing numbers stay `null` and `Unknown` is an explicit state; no adapter may
 * synthesize a token count, remaining quota or cost (F18-AC4, N06-AC2).
 */
export type EngineReportedUsage =
  | { readonly kind: 'Reported'; readonly usage: EngineUsage }
  | { readonly kind: 'Unknown'; readonly reason: string };

/**
 * The terminal outcome of a session.
 *
 * `Succeeded` is the only variant that may complete an attempt, and it is
 * produced solely from a well-formed engine result. Malformed output produces a
 * diagnostic and no `Succeeded` event (F15-AC2). Blocked variants name an
 * actionable remedy and leave the workspace intact (F15-AC3).
 */
export type EngineOutcome =
  | { readonly kind: 'Succeeded'; readonly summary: string }
  | {
      readonly kind: 'Failed';
      readonly category: EngineDiagnosticCategory;
      readonly summary: string;
      readonly remedy: string | null;
    }
  | {
      readonly kind: 'Blocked';
      readonly category:
        | 'MissingAuthentication'
        | 'UnavailableModel'
        | 'QuotaExhausted'
        | 'UnsupportedRuntime';
      readonly remedy: string;
      readonly summary: string;
    }
  | {
      readonly kind: 'Incomplete';
      readonly reason: 'Stopped' | 'BudgetExhausted' | 'OutputTruncated';
      readonly summary: string;
    };

/**
 * Structured events translated from native engine output.
 *
 * The union is closed on purpose: the controller may only advance on a `Result`
 * event, and the engine's own text never becomes state (mvp-spec 7 "Engine",
 * ARCHITECTURE "Interfaces to establish with each slice").
 */
export type EngineEvent =
  | {
      readonly kind: 'SessionStarted';
      readonly at: string;
      readonly sessionId: ProviderId;
      readonly engineVersion: string;
      readonly mode: EngineMode;
      readonly startedFrom: EngineSessionStart['kind'];
    }
  | {
      readonly kind: 'Progress';
      readonly at: string;
      readonly stage: EngineStage;
      /** Deduplication key for the managed progress update (F16-AC3). */
      readonly milestoneKey: string | null;
      readonly summary: string;
      readonly detail: ArtifactReference | null;
    }
  | { readonly kind: 'Checkpoint'; readonly at: string; readonly checkpoint: EngineCheckpoint }
  | { readonly kind: 'Result'; readonly at: string; readonly outcome: EngineOutcome }
  | {
      readonly kind: 'Diagnostic';
      readonly at: string;
      readonly category: EngineDiagnosticCategory;
      readonly detail: string;
      readonly retry: EngineDiagnosticRetry;
      readonly evidence: ArtifactReference | null;
    }
  | { readonly kind: 'Usage'; readonly at: string; readonly usage: EngineReportedUsage }
  | { readonly kind: 'Stopped'; readonly at: string; readonly reason: EngineStopReason };

/** How a session begins, so a restart cannot be mistaken for a resume. */
export type EngineSessionStart =
  | { readonly kind: 'Fresh'; readonly instruction: string }
  | { readonly kind: 'FromCheckpoint'; readonly checkpoint: EngineCheckpoint; readonly instruction: string };

export interface EngineStartRequest {
  readonly operationId: OperationId;
  readonly workspace: ExecutionWorkspace;
  readonly start: EngineSessionStart;
  readonly mode: EngineMode;
  /** Explicit grant. Delivery capability kinds are not assignable here (F03-AC5, N02-AC3). */
  readonly grantedCapabilities: readonly CodingSessionCapability[];
  readonly bounds: EngineBounds;
}

export interface EngineSessionHandle {
  readonly sessionId: ProviderId;
  readonly engineVersion: string;
  readonly mode: EngineMode;
  readonly workspace: ExecutionWorkspace;
  readonly grantedCapabilities: readonly CodingSessionCapability[];
  readonly startedAt: string;
  readonly events: AsyncIterable<EngineEvent>;
}

export interface PriorEngineSession {
  readonly sessionId: ProviderId;
  readonly engineVersion: string;
  readonly lastEventAt: string;
}

export interface ResumeEngineSessionRequest {
  readonly operationId: OperationId;
  readonly workspace: ExecutionWorkspace;
  readonly priorSession: PriorEngineSession;
  readonly checkpoint: EngineCheckpoint;
  readonly instruction: string;
  readonly grantedCapabilities: readonly CodingSessionCapability[];
  readonly bounds: EngineBounds;
}

/**
 * Continuation strategy actually used.
 *
 * `ContinuationUnsupported` is a real outcome, not a failure to hide: an engine
 * that cannot restore its own conversation continues as a fresh session seeded
 * from the checkpoint (F15-AC4).
 */
export type EngineContinuation =
  | {
      readonly kind: 'ResumedInPlace';
      readonly session: EngineSessionHandle;
      readonly resumedFromEventAt: string | null;
    }
  | {
      readonly kind: 'RestartedFromCheckpoint';
      readonly session: EngineSessionHandle;
      readonly checkpoint: EngineCheckpoint;
      readonly limitation: string;
    }
  | {
      readonly kind: 'ContinuationUnsupported';
      readonly checkpoint: EngineCheckpoint;
      readonly limitation: string;
      readonly requiresFreshSessionFromCheckpoint: true;
    };

export type EngineStopReason = 'PauseRequested' | 'CancelRequested' | 'BudgetExhausted' | 'Shutdown';

export interface StopEngineSessionRequest {
  readonly operationId: OperationId;
  readonly sessionId: ProviderId;
  readonly reason: EngineStopReason;
}

/**
 * Graceful stop result.
 *
 * `Detached` and `StopRefused` keep Paused honest: the caller may only report the
 * writer as stopped on `Stopped`, and a detach requires reconciliation before
 * another writer touches the workspace (F17-AC1, F17-AC5).
 */
export type EngineStopOutcome =
  | { readonly kind: 'Stopped'; readonly stoppedAt: string; readonly checkpoint: EngineCheckpoint | null }
  | { readonly kind: 'Detached'; readonly detail: string; readonly reconcileRequired: true }
  | { readonly kind: 'StopRefused'; readonly detail: string };

/**
 * Coding engine contract.
 *
 * The adapter owns only translation: it reports the engine version and
 * capabilities, starts a scoped session in the workspace it was given, emits
 * structured progress/checkpoint/result events, stops gracefully, and falls back
 * to a fresh session seeded from the checkpoint when restoration is unsupported
 * (F15, ARCHITECTURE "Execution and recovery").
 */
export interface EngineAdapter extends AdapterIdentity {
  readonly kind: 'Engine';
  startSession(
    context: AdapterContext,
    request: EngineStartRequest,
  ): Promise<Result<EngineSessionHandle>>;
  resumeSession(
    context: AdapterContext,
    request: ResumeEngineSessionRequest,
  ): Promise<Result<EngineContinuation>>;
  stopSession(
    context: AdapterContext,
    request: StopEngineSessionRequest,
  ): Promise<Result<EngineStopOutcome>>;
}
