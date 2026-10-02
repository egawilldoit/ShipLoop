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
 * A JSON Schema, as a value, describing the shape a caller requires of a result.
 *
 * It is an opaque `Record<string, unknown>` rather than a local schema type because the
 * schema is the engine's: `codex exec --output-schema` reads the very same document the
 * adapter writes, so re-typing it here would create a second definition that could drift
 * from the file the engine was actually given. The adapter's own job is the part it *can*
 * check without reimplementing a validator: that every property the schema declares is
 * present, and that a declared `enum` is respected.
 */
export type EngineResultSchema = Readonly<Record<string, unknown>>;

/**
 * A structured result the caller requires from one session.
 *
 * This is a **separate channel**, not a wider summary. `EngineEvent.Progress.summary` is a
 * bounded human-readable line and stays bounded; a plan proposal, a review verdict or any
 * other structured answer is larger than any summary cap and must not be smuggled through
 * one. Asking for a result here is what makes the adapter request the engine's structured
 * output channel and read the whole payload back (F15-AC2).
 */
export interface EngineResultRequest {
  /** The schema the engine's final answer must satisfy. Written into the attempt directory. */
  readonly schema: EngineResultSchema;
}

/**
 * A complete structured result, read whole from the engine's own result channel.
 *
 * `json` is the engine's text exactly as it was read from the result artifact, then passed
 * through the caller's redaction; it is never truncated. `byteLength` is what the artifact
 * held *before* redaction, so a reader can tell how much the engine produced even when
 * redaction shortened it. `sourcePath` is relative to the attempt-owned directory the
 * artifact was confined to, so it identifies the evidence without carrying a host path, and
 * `checkedProperties` is how many schema-declared properties were verified present, which is
 * what makes the completeness claim checkable rather than asserted (F15-AC2, F05-AC5).
 */
export interface EngineResultPayload {
  readonly json: string;
  readonly byteLength: number;
  readonly sourcePath: string;
  readonly checkedProperties: number;
}

/**
 * The terminal outcome of a session.
 *
 * `Succeeded` is the only variant that may complete an attempt, and it is
 * produced solely from a well-formed engine result. Malformed output produces a
 * diagnostic and no `Succeeded` event (F15-AC2). Blocked variants name an
 * actionable remedy and leave the workspace intact (F15-AC3).
 *
 * `Succeeded.result` is present exactly when the caller asked for a structured result on
 * `EngineStartRequest.result` or `ResumeEngineSessionRequest.result`. It is **not** the
 * summary, and a session that asked for one and did not produce a valid payload never reaches
 * this variant at all: it is a `MalformedOutput` diagnostic and no `Result`, which is the same
 * rule F15-AC2 already applies to a malformed event stream.
 */
export type EngineOutcome =
  | { readonly kind: 'Succeeded'; readonly summary: string; readonly result?: EngineResultPayload }
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
  /**
   * A structured result this session must produce, or absent when its text is enough.
   *
   * Absent is the default and is not a narrower `Result`: the adapter then asks for no
   * structured channel at all and the session behaves exactly as it did before this field
   * existed. Present, the session fails closed if the payload does not arrive whole (F15-AC2).
   */
  readonly result?: EngineResultRequest;
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
  /** Carried on a resumed run for the same reason as on {@link EngineStartRequest.result}. */
  readonly result?: EngineResultRequest;
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
