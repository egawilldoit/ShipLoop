/**
 * One attempt's lifecycle against the coding engine (F13, F15, F17, F18).
 *
 * This module owns one job's pass through the engine and nothing else. It decides no policy:
 * limits come from `@shiploop/domain`, the durable grant from the stored job row, and the
 * process group from `@shiploop/adapters`. What it owns is the order, and the order is where
 * these criteria actually live:
 *
 *   - the mode, the captured scope snapshot, the project, the limits and the permitted
 *     operations are read from the claimed row and from the stored snapshot, never from
 *     anything this process chose (F13-AC1);
 *   - every capability the attempt would use is decided by the domain's `evaluateGrant`, so
 *     a Build job is refused merge and release because it is never granted them (F13-AC3);
 *   - a resume re-reads the actual workspace and live external state before continuing, and a
 *     workspace that no longer matches the recorded checkpoint is reported rather than
 *     written over (F17-AC3, F14-AC4);
 *   - every checkpoint records the workspace re-read after the attempt's work has settled, so the
 *     resume point it leaves describes the work that is actually there (F14-AC4, F17-AC2);
 *   - a reached limit halts the engine before the attempt parks, then checkpoints the work and
 *     waits for an owner extension instead of continuing, and time spent waiting for the owner is
 *     not charged to the execution budget (F17-AC1, F18-AC2, F18-AC3);
 *   - a refusal that cannot improve on a retry reaches a terminal state instead of being reported
 *     once per tick forever (F18-AC1, F18-AC5);
 *   - usage is carried through only when the engine reported it, and is `Unknown` otherwise
 *     (F18-AC4);
 *   - a deterministic scope or authentication failure is never dispatched a second time
 *     (F18-AC5).
 */

import {
  DEFAULT_LIMITS,
  classifyFailure,
  err,
  evaluateGrant,
  evaluateLimits,
  invalid,
  ok,
  recordOwnerWait,
  usageReporting,
  type AttemptLimits,
  type CapabilityKind,
  type CommitSha,
  type DomainError,
  type FailureCategory,
  type FailureRecord,
  type Fingerprint,
  type JobId,
  type LimitsEvaluation,
  type OwnerWaitInterval,
  type ReportedUsage,
  type Result,
} from '@shiploop/domain';
import { deniedCodingCapabilities } from '@shiploop/adapters';
import type {
  AdapterClock,
  AdapterContext,
  AdapterLogger,
  CodingSessionCapability,
  EngineAdapter,
  EngineCheckpoint,
  EngineOutcome,
  EngineReportedUsage,
  EngineSessionHandle,
  EngineStage,
  EngineStartRequest,
  ExecutionWorkspace,
} from '@shiploop/adapters';
import type { CheckpointRequest, CheckpointResult, FeedbackNote, JobCheckpoint, JobOperation, JobRecord } from '@shiploop/storage';

/**
 * Capability a durable job operation corresponds to, where one exists.
 *
 * This is a translation between two vocabularies that already exist: the grant a job carries
 * (`JobOperation`) and the provider capability vocabulary (`CapabilityKind`). It grants
 * nothing. Every entry is still decided by `evaluateGrant`, which refuses a capability the
 * mode does not declare and refuses every privileged delivery capability for a non-owner role
 * (F13-AC3, N02-AC3).
 *
 * `RunChecks` and `CollectEvidence` have no entry on purpose: checks are executed by
 * `@shiploop/verification` and evidence is stored by ShipLoop, so inventing a provider
 * capability for them would put a fictional grant in front of the capability boundary.
 */
const OPERATION_CAPABILITIES: Readonly<Partial<Record<JobOperation, CapabilityKind>>> = {
  ReadScope: 'Ticket:ReadScope',
  PublishIssue: 'Ticket:PublishIssue',
  UpdateManagedProgress: 'Ticket:UpdateManagedProgress',
  ReadRepository: 'Git:ReadRepository',
  ReadChecks: 'Git:ReadChecks',
  PushBranch: 'Git:PushBranch',
  CreateDraft: 'Git:CreateDraft',
  UpdateDraft: 'Git:UpdateDraft',
  Merge: 'Git:MergeWithPrecondition',
  Release: 'Deployment:Execute',
  RecoveryRedeploy: 'Deployment:Execute',
};

/** Delivery capabilities probed on every attempt, so a refusal is recorded rather than assumed. */
const PROBED_DELIVERY_CAPABILITIES: readonly CapabilityKind[] = ['Git:MergeWithPrecondition', 'Deployment:Execute'];

/** Repository facts about one workspace, read fresh rather than remembered (F17-AC3). */
export interface WorkspaceObservation {
  readonly workspace: JobCheckpoint['workspace'];
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  readonly dirtyFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
}

export interface PreparedWorkspace {
  readonly execution: ExecutionWorkspace;
  readonly observation: WorkspaceObservation;
  /**
   * True when live external state already shows the delivery this attempt was about to make.
   *
   * A lost response is not an undone delivery, so a resume has to establish the result rather
   * than repeat the write (F17-AC3, N01-AC2).
   */
  readonly deliveryAlreadyObserved: boolean;
}

export interface WorkspacePort {
  prepare(request: {
    readonly job: JobRecord;
    readonly checkpoint: JobCheckpoint | null;
  }): Promise<Result<PreparedWorkspace, DomainError>>;
  /**
   * Re-reads the repository state of a workspace this port already prepared.
   *
   * A checkpoint is written after the attempt's work has settled, so the inventory it stores has to
   * be read at that moment rather than remembered from before the attempt. A checkpoint built from
   * the pre-attempt workspace records a clean worktree that the worktree does not have, which makes
   * the retained resume point refuse the very workspace it describes (F14-AC4, F17-AC2).
   *
   * Optional because a provider that only prepares is still usable: `createWorker` then re-reads
   * with the same verified workspace module the provider itself uses to decide whether a workspace
   * may be reused, so both sides of a resume comparison are read by one implementation. A provider
   * that can re-read its own workspace should say so here, because its read is the authoritative
   * one for anything the workspace module cannot see (F14-AC1).
   */
  observe?(request: WorkspaceObservationRequest): Promise<Result<WorkspaceObservation, DomainError>>;
}

/** What a re-observation is asked about: the workspace being written, and what the last read said. */
export interface WorkspaceObservationRequest {
  readonly job: JobRecord;
  /** The writer this attempt is, which the read reports against when it refuses. */
  readonly holder: string;
  /** The workspace to re-read, as the last read reported its identity. */
  readonly workspace: JobCheckpoint['workspace'];
  /**
   * The last read of that workspace.
   *
   * It is never written to a checkpoint and never treated as current: it names the workspace to
   * re-read and the state a read is compared against, so a difference is reported rather than
   * hidden (F14-AC4).
   */
  readonly lastRead: WorkspaceObservation;
}

/** Re-reads a prepared workspace, which is what a checkpoint's inventory is written from. */
export type WorkspaceObserver = (
  request: WorkspaceObservationRequest,
) => Promise<Result<WorkspaceObservation, DomainError>>;

/** An owner grant that lifts a limit this attempt already reached (F18-AC2). */
export interface OwnerExtension {
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly additionalActiveMs: number;
  readonly additionalFixPasses: number;
}

export interface OwnerExtensionPort {
  extensionFor(request: { readonly jobId: JobId }): OwnerExtension | null;
}

/**
 * The checkpoint facts this process does not itself observe.
 *
 * Owner feedback and already-observed check results belong in the checkpoint (F17-AC2), and
 * neither is produced by an engine session.
 */
export interface CheckpointFactsPort {
  feedbackFor(request: { readonly jobId: JobId }): readonly FeedbackNote[];
  resultsFor(request: { readonly jobId: JobId }): readonly CheckpointResult[];
}

/** A milestone the owner can be shown without reading every tool call (F16-AC1). */
export interface Milestone {
  readonly stage: EngineStage;
  readonly summary: string;
  readonly milestoneKey: string | null;
}

/**
 * Writer liveness, kept behind a port so the cadence is a function of the injected clock.
 *
 * `renew` is the only thing a live attempt may do to its own ownership: it renews when the
 * cadence is due and does nothing otherwise. It never claims, and it never takes over (F17-AC5).
 */
export interface HeartbeatPort {
  renew(): Result<'Renewed' | 'NotDue', DomainError>;
}

export interface RunnerPorts {
  readonly clock: AdapterClock;
  readonly logger: AdapterLogger;
  readonly redact: (text: string) => string;
  readonly engine: EngineAdapter;
  readonly workspaces: WorkspacePort;
  /** Re-reads the workspace the attempt is writing, because a checkpoint records it after the work. */
  readonly observeWorkspace: WorkspaceObserver;
  readonly extensions: OwnerExtensionPort;
  readonly facts: CheckpointFactsPort;
  readonly onMilestone: (job: JobRecord, milestone: Milestone) => void;
  /** Writes one durable resume point, so a limit or a stop is recorded before the state moves. */
  readonly writeCheckpoint: (request: CheckpointRequest) => Result<JobCheckpoint, DomainError>;
  readonly checkpointIdFor: (job: JobRecord) => string;
  readonly engineEventLimit: number;
}

export interface AttemptRequest {
  readonly job: JobRecord;
  readonly holder: string;
  /** Instruction composed from the stored scope snapshot, never from a provider response. */
  readonly instruction: string;
  /** Fingerprint of the captured scope snapshot this attempt is bound to (F12-AC1). */
  readonly scopeFingerprint: Fingerprint;
  readonly checkpoint: JobCheckpoint | null;
  readonly ownerWaits: readonly OwnerWaitInterval[];
  readonly attemptStartedAtMs: number;
  /** Fix passes already spent, so a resumed attempt does not restart its budget. */
  readonly fixPasses: number;
  readonly heartbeat: HeartbeatPort;
  readonly stopRequested: () => boolean;
  /**
   * Fires when the process is asked to stop.
   *
   * The event stream is raced against it, because an engine that has gone quiet emits nothing
   * and a stop request that is only checked between events would wait for the engine rather than
   * stopping it (F17-AC1).
   */
  readonly stopSignal: AbortSignal;
}

export type AttemptOutcome =
  | { readonly kind: 'Completed'; readonly summary: string; readonly usage: ReportedUsage }
  | { readonly kind: 'Blocked'; readonly failure: FailureRecord; readonly usage: ReportedUsage }
  | { readonly kind: 'Failed'; readonly failure: FailureRecord; readonly usage: ReportedUsage }
  | { readonly kind: 'WaitingForOwner'; readonly limits: LimitsEvaluation }
  | { readonly kind: 'Stopped'; readonly detail: string }
  | { readonly kind: 'WriterDetached'; readonly detail: string };

/** What one engine dispatch produced, before the pass loop decides what it means. */
interface DispatchOutcome {
  readonly terminal: EngineOutcome | null;
  readonly failure: FailureRecord | null;
  readonly usage: ReportedUsage;
  readonly engineVersion: string | null;
  /** True when the owner asked to stop and the engine was halted without a terminal result. */
  readonly stopped: boolean;
  /** True when the recorded limits ran out mid-session, so the engine was halted (F18-AC2). */
  readonly budgetExhausted: boolean;
  /** True when a process group may still be writing, so Paused must not be reported (F17-AC1). */
  readonly detached: boolean;
  readonly detachedDetail: string | null;
}

interface CheckpointContent {
  readonly blocker: string | null;
  readonly nextAction: string;
  readonly engineVersion: string | null;
}

/**
 * Runs one claimed job to a terminal outcome or to a stop.
 *
 * Returns `Result` rather than throwing, because the caller is a run loop that has to report a
 * refusal instead of dying: a job that cannot be started is a fact about that job, not a fault
 * of the worker.
 */
export async function runAttempt(
  ports: RunnerPorts,
  request: AttemptRequest,
): Promise<Result<AttemptOutcome, DomainError>> {
  const prepared = await ports.workspaces.prepare({ job: request.job, checkpoint: request.checkpoint });
  if (!prepared.ok) return refusalOutcome(request.job.jobId, prepared.error);
  const observation = prepared.value.observation;

  if (request.checkpoint !== null) {
    const resume = assessResume(request.checkpoint, prepared.value);
    if (resume.kind !== 'Continue') {
      return ok({
        kind: 'Blocked',
        failure: classifyFailure({
          stage: 'Reconciliation',
          observed: { error: resume.reason, references: [`checkpoint:${request.checkpoint.checkpointId}`] },
          category: 'DeterministicScope',
        }),
        usage: usageReporting(null),
      });
    }
  }

  const grant = resolveGrantForJob(request.job);
  if (grant.denied.length > 0) {
    return ok({
      kind: 'Blocked',
      failure: classifyFailure({
        stage: 'Planning',
        observed: {
          error: grant.denied.map((denial) => denial.explanation).join(' '),
          references: [`job:${request.job.jobId}`, `mode:${request.job.mode}`],
        },
        category: 'DeterministicAuth',
      }),
      usage: usageReporting(null),
    });
  }

  let limits = attemptLimitsOf(request.job);
  let extensionApplied = false;
  let pass = request.fixPasses;

  for (;;) {
    const elapsed = elapsedMs(ports.clock, request.attemptStartedAtMs);
    if (!elapsed.ok) return elapsed;
    const evaluation = evaluateLimits({
      limits,
      wallClockMs: elapsed.value,
      fixPasses: pass,
      ownerWaits: request.ownerWaits,
    });

    if (!evaluation.withinLimits) {
      const extension = extensionApplied ? null : ports.extensions.extensionFor({ jobId: request.job.jobId });
      if (extension === null) {
        const checkpoint = await persistCheckpoint(ports, request, observation, {
          blocker: evaluation.reason,
          nextAction: 'Wait for an owner extension before this attempt continues (F18-AC2).',
          engineVersion: null,
        });
        if (!checkpoint.ok) return checkpoint;
        return ok({ kind: 'WaitingForOwner', limits: evaluation });
      }
      extensionApplied = true;
      limits = extendLimits(limits, extension);
      continue;
    }

    const dispatched = await dispatchOnce(ports, request, prepared.value, grant.granted, {
      limits,
      pass,
      activeMs: evaluation.activeMs,
      withinBudget: () => {
        const current = elapsedMs(ports.clock, request.attemptStartedAtMs);
        if (!current.ok) return current;
        return ok(
          evaluateLimits({
            limits,
            wallClockMs: current.value,
            fixPasses: pass,
            ownerWaits: request.ownerWaits,
          }).withinLimits,
        );
      },
    });
    if (!dispatched.ok) return dispatched;
    const result = dispatched.value;

    if (result.detached) {
      return ok({ kind: 'WriterDetached', detail: result.detachedDetail ?? 'The tracked process group may still be writing.' });
    }

    if (result.budgetExhausted) {
      const exhausted = elapsedMs(ports.clock, request.attemptStartedAtMs);
      if (!exhausted.ok) return exhausted;
      const final = evaluateLimits({
        limits,
        wallClockMs: exhausted.value,
        fixPasses: pass,
        ownerWaits: request.ownerWaits,
      });
      const checkpoint = await persistCheckpoint(ports, request, observation, {
        blocker: final.reason,
        nextAction: 'Wait for an owner extension before this attempt continues (F18-AC2).',
        engineVersion: result.engineVersion,
      });
      if (!checkpoint.ok) return checkpoint;
      return ok({ kind: 'WaitingForOwner', limits: final });
    }

    if (result.stopped) {
      const checkpoint = await persistCheckpoint(ports, request, observation, {
        blocker: 'The owner asked for this attempt to stop before the engine reported a result.',
        nextAction: 'Resume from the recorded checkpoint after inspecting the workspace (F17-AC3).',
        engineVersion: result.engineVersion,
      });
      if (!checkpoint.ok) return checkpoint;
      return ok({ kind: 'Stopped', detail: 'The engine session was stopped and the checkpoint recorded.' });
    }

    if (result.failure === null && result.terminal?.kind === 'Succeeded') {
      return ok({ kind: 'Completed', summary: result.terminal.summary, usage: result.usage });
    }

    const recorded = result.failure ?? failureForTerminal(result.terminal);
    const canSpendAnotherPass = recorded.retryable && pass < limits.automatedFixPasses;
    if (!canSpendAnotherPass) {
      const checkpoint = await persistCheckpoint(ports, request, observation, {
        blocker: recorded.recommendedNextAction,
        nextAction: recorded.retryable
          ? 'Start a further attempt, or have the owner extend the limits recorded with the job (F18-AC2).'
          : recorded.recommendedNextAction,
        engineVersion: result.engineVersion,
      });
      if (!checkpoint.ok) return checkpoint;
      return ok(
        recorded.retryable
          ? { kind: 'Failed', failure: recorded, usage: result.usage }
          : { kind: 'Blocked', failure: recorded, usage: result.usage },
      );
    }

    pass += 1;
    const checkpoint = await persistCheckpoint(ports, request, observation, {
      blocker: recorded.recommendedNextAction,
      nextAction: `Continue the coding work with automated fix pass ${String(pass)} of ${String(limits.automatedFixPasses)} (F18-AC2).`,
      engineVersion: result.engineVersion,
    });
    if (!checkpoint.ok) return checkpoint;
  }
}

/**
 * What a resume is allowed to do, given what the workspace actually looks like now.
 *
 * The checkpoint's recorded workspace identity, code identity and work inventory are compared
 * against a fresh read, and any difference is reported rather than written over, because those
 * differences are a person's uncommitted work (F14-AC4). A delivery already visible in live
 * external state means the attempt must not repeat it, whatever a lost response suggested
 * (F17-AC3).
 */
export function assessResume(
  checkpoint: JobCheckpoint,
  prepared: PreparedWorkspace,
): { readonly kind: 'Continue' } | { readonly kind: 'Reconcile'; readonly reason: string } {
  if (prepared.deliveryAlreadyObserved) {
    return {
      kind: 'Reconcile',
      reason: 'Live external state already shows the delivery this checkpoint was about to make, so continuing would repeat it (F17-AC3).',
    };
  }
  const observed = prepared.observation;
  const differences: string[] = [];
  if (
    observed.workspace.workspaceId !== checkpoint.workspace.workspaceId ||
    observed.workspace.branchName !== checkpoint.workspace.branchName ||
    observed.workspace.worktreePath !== checkpoint.workspace.worktreePath
  ) {
    differences.push(
      `the workspace moved from ${checkpoint.workspace.workspaceId} at ${checkpoint.workspace.worktreePath} to ${observed.workspace.workspaceId} at ${observed.workspace.worktreePath}`,
    );
  }
  if (observed.headSha !== checkpoint.headSha) {
    differences.push(`head moved from ${checkpoint.headSha} to ${observed.headSha}`);
  }
  if (observed.baseSha !== checkpoint.baseSha) {
    differences.push(`base moved from ${checkpoint.baseSha} to ${observed.baseSha}`);
  }
  if (!samePaths(observed.dirtyFiles, checkpoint.dirtyFiles)) {
    differences.push('the set of modified files changed');
  }
  if (!samePaths(observed.untrackedFiles, checkpoint.untrackedFiles)) {
    differences.push('the set of untracked files changed');
  }
  if (differences.length === 0) return { kind: 'Continue' };
  return {
    kind: 'Reconcile',
    reason: `The workspace no longer matches the recorded checkpoint: ${differences.join('; ')}. Unexpected changes are shown for an owner decision rather than overwritten (F14-AC4).`,
  };
}

/** A refusal the capability boundary produced, recorded rather than assumed. */
export interface GrantDenial {
  readonly capability: CapabilityKind;
  readonly reason: string;
  readonly explanation: string;
}

export interface JobCapabilityGrant {
  /** Capabilities this attempt may actually request from an adapter. */
  readonly granted: readonly CodingSessionCapability[];
  /** Capabilities the job's own durable grant asked for and the boundary refused. */
  readonly denied: readonly GrantDenial[];
  /**
   * The delivery capabilities this attempt probed and was refused, recorded on every attempt.
   *
   * They are reported rather than left unused so "no mode implies merge or release" is a fact a
   * reviewer can read, while a refusal of something nobody asked for does not block the work
   * (F13-AC3).
   */
  readonly deliveryRefusals: readonly GrantDenial[];
}

/**
 * Decides every capability this attempt may hold, through the domain's one decision point.
 *
 * The granted set is the intersection of what the durable row permits and what the mode
 * declares, and the two delivery capabilities are probed on every attempt so the refusal is a
 * recorded fact. `CodingSessionCapability` cannot name a delivery capability at all, which is
 * why a Build job cannot merge or release: it is never handed the capability (F13-AC3, N02-AC3).
 */
export function resolveGrantForJob(job: JobRecord): JobCapabilityGrant {
  const requested: CapabilityKind[] = [];
  for (const operation of job.permittedOperations) {
    const capability = OPERATION_CAPABILITIES[operation];
    if (capability !== undefined) requested.push(capability);
  }

  const granted: CodingSessionCapability[] = [];
  const denied: GrantDenial[] = [];
  const deliveryRefusals: GrantDenial[] = [];
  for (const capability of [...new Set(requested)]) {
    const decision = evaluateGrant({
      mode: job.mode,
      requestedCapability: capability,
      grantedCapabilities: requested,
      actorRole: 'CodingAgent',
    });
    if (decision.allowed) {
      if (isCodingCapability(capability)) granted.push(capability);
      continue;
    }
    denied.push({ capability, reason: decision.reason, explanation: decision.explanation });
  }
  for (const capability of PROBED_DELIVERY_CAPABILITIES) {
    const decision = evaluateGrant({
      mode: job.mode,
      requestedCapability: capability,
      grantedCapabilities: requested,
      actorRole: 'CodingAgent',
    });
    if (!decision.allowed) {
      deliveryRefusals.push({ capability, reason: decision.reason, explanation: decision.explanation });
    }
  }
  return { granted, denied, deliveryRefusals };
}

/** Maps the durable job limits onto the domain's attempt limits (F18-AC2). */
export function attemptLimitsOf(job: JobRecord): AttemptLimits {
  return {
    activeExecutionMs: job.limits.activeExecutionMs,
    automatedFixPasses: job.limits.maxAutomatedFixPasses,
    toolRetry: DEFAULT_LIMITS.toolRetry,
  };
}

/**
 * The sentinel a stop request resolves the event race with.
 *
 * It is a distinct object rather than an iterator result, because a finished stream and a
 * stopped attempt are different facts and must not be confused.
 */
const STOPPED = Symbol('worker-stop-requested');

/** Resolves once the process has been asked to stop, and never rejects. */
function waitForStop(signal: AbortSignal): Promise<typeof STOPPED> {
  if (signal.aborted) return Promise.resolve(STOPPED);
  return new Promise<typeof STOPPED>((resolve) => {
    signal.addEventListener('abort', () => resolve(STOPPED), { once: true });
  });
}

/**
 * An owner wait as the domain records it, so elapsed arithmetic never consults a clock here.
 *
 * The interval is derived from durable timestamps: the instant the attempt recorded its
 * checkpoint before waiting, and the instant the owner's extension was granted (F18-AC3).
 */
export function ownerWaitBetween(waitingFrom: string, waitingUntil: string, reason: string): OwnerWaitInterval {
  return recordOwnerWait(Date.parse(waitingFrom), Date.parse(waitingUntil), reason);
}

/**
 * Narrows a provider capability to the coding vocabulary.
 *
 * The test is the adapter contract's own `deniedCodingCapabilities`, so the privileged set stays
 * defined in one place and this type boundary closes when that set grows (N02-AC3).
 */
function isCodingCapability(kind: CapabilityKind): kind is CodingSessionCapability {
  return deniedCodingCapabilities([kind]).length === 0;
}

function extendLimits(limits: AttemptLimits, extension: OwnerExtension): AttemptLimits {
  return {
    activeExecutionMs: limits.activeExecutionMs + extension.additionalActiveMs,
    automatedFixPasses: limits.automatedFixPasses + extension.additionalFixPasses,
    toolRetry: limits.toolRetry,
  };
}

interface DispatchBudget {
  readonly limits: AttemptLimits;
  readonly pass: number;
  /** Active execution already charged to this attempt (F18-AC3). */
  readonly activeMs: number;
  /**
   * Re-reads the limits between engine events.
   *
   * A bound checked only before a dispatch would let a single long turn run past the recorded
   * active execution limit and then report success, so the budget is enforced while the engine is
   * working and the session is halted instead (F18-AC2).
   */
  readonly withinBudget: () => Result<boolean, DomainError>;
}

async function dispatchOnce(
  ports: RunnerPorts,
  request: AttemptRequest,
  prepared: PreparedWorkspace,
  granted: readonly CodingSessionCapability[],
  budget: DispatchBudget,
): Promise<Result<DispatchOutcome, DomainError>> {
  const controller = new AbortController();
  const startRequest: EngineStartRequest = {
    operationId: request.job.operationId,
    workspace: prepared.execution,
    start:
      request.checkpoint === null
        ? { kind: 'Fresh', instruction: request.instruction }
        : {
            kind: 'FromCheckpoint',
            checkpoint: engineCheckpointOf(request.checkpoint, request.instruction),
            instruction: request.instruction,
          },
    mode: 'Headless',
    grantedCapabilities: granted,
    bounds: {
      activeWallClockMs: Math.max(1, budget.limits.activeExecutionMs - budget.activeMs),
      retryBudget: budget.limits.toolRetry.totalRetriesPerAttempt,
      eventCountLimit: ports.engineEventLimit,
    },
  };

  const context = {
    correlationId: request.job.correlationId,
    operationId: request.job.operationId,
    clock: ports.clock,
    logger: ports.logger,
    signal: controller.signal,
    redact: ports.redact,
  };

  const started = await ports.engine.startSession(context, startRequest);
  if (!started.ok) return ok(failedDispatch(started.error));

  return ok(await consumeSession(ports, request, started.value, controller, context, budget));
}

/**
 * Reads the engine's own event stream and turns it into an outcome.
 *
 * Only a `Result` event carrying `Succeeded` completes an attempt, and even that is refused
 * once a diagnostic was observed: a stream that could not be parsed cannot be trusted to have
 * completed the work it appears to describe (F15-AC2).
 */
async function consumeSession(
  ports: RunnerPorts,
  request: AttemptRequest,
  session: EngineSessionHandle,
  controller: AbortController,
  context: AdapterContext,
  budget: DispatchBudget,
): Promise<DispatchOutcome> {
  let terminal: EngineOutcome | null = null;
  let failure: FailureRecord | null = null;
  let usage = usageReporting(null);
  let engineVersion: string | null = null;
  let budgetExhausted = false;

  const iterator = session.events[Symbol.asyncIterator]();
  const stopped = waitForStop(request.stopSignal);
  let isStopped = false;
  let observedStoppedEvent = false;

  for (;;) {
    const next = await Promise.race([iterator.next(), stopped]);
    if (next === STOPPED) {
      isStopped = true;
      break;
    }
    if (next.done === true) break;
    const event = next.value;

    const renewed = request.heartbeat.renew();
    if (!renewed.ok) {
      controller.abort();
      return {
        terminal: null,
        failure: classifyFailure({
          stage: 'EngineExecution',
          observed: { error: renewed.error.reason, references: [] },
          category: 'Unknown',
        }),
        usage,
        engineVersion,
        stopped: false,
        budgetExhausted: false,
        detached: false,
        detachedDetail: null,
      };
    }

    const withinBudget = budget.withinBudget();
    if (!withinBudget.ok) {
      controller.abort();
      failure = classifyFailure({
        stage: 'EngineExecution',
        observed: { error: withinBudget.error.reason, references: [] },
        category: 'Unknown',
      });
      break;
    }
    if (!withinBudget.value) {
      budgetExhausted = true;
      /**
       * The session is halted before the attempt parks, exactly as a stop is.
       *
       * A reached limit ends this attempt and releases the coding slot, so an engine process left
       * running here would be writing into a workspace another job has been given. Treating the
       * budget as a stop routes it through the same observed stop, so a group that survives the
       * bounded kill is reported as detached and no job state moves (F17-AC1, F18-AC2, F17-AC5).
       */
      isStopped = true;
      break;
    }

    if (event.kind === 'SessionStarted') engineVersion = event.engineVersion;
    if (event.kind === 'Progress') {
      ports.onMilestone(request.job, { stage: event.stage, summary: event.summary, milestoneKey: event.milestoneKey });
    }
    if (event.kind === 'Usage') usage = usageOf(event.usage);
    if (event.kind === 'Diagnostic' && failure === null) {
      failure = classifyFailure({
        stage: 'EngineExecution',
        observed: { error: event.detail, references: event.evidence === null ? [] : [event.evidence.uri] },
        category: failureCategoryOf(event.category),
        attemptedRemedy: event.retry === 'Retryable' ? 'The engine reported this operation as retryable.' : null,
      });
    }
    if (event.kind === 'Result') terminal = event.outcome;
    if (event.kind === 'Stopped') observedStoppedEvent = true;

    if (request.stopRequested() || event.kind === 'Stopped') {
      isStopped = true;
      break;
    }
  }

  if (isStopped) {
    /**
     * Asks the adapter to stop the process group it spawned.
     *
     * `StopRefused` for a session this same run started means the adapter no longer tracks a
     * process for it, which is the state its own contract reaches once that process has exited.
     * Reporting `Detached` instead would leave every recoverably paused job permanently
     * unreconcilable, so the refusal is recorded and the attempt is treated as stopped.
     */
    if (observedStoppedEvent) {
      return { terminal, failure, usage, engineVersion, stopped: true, budgetExhausted, detached: false, detachedDetail: null };
    }
    const halted = await ports.engine.stopSession(context, {
      operationId: request.job.operationId,
      sessionId: session.sessionId,
      reason: budgetExhausted ? 'BudgetExhausted' : 'PauseRequested',
    });
    if (halted.ok && halted.value.kind === 'Detached') {
      return {
        terminal: null,
        failure: null,
        usage,
        engineVersion,
        stopped: true,
        budgetExhausted,
        detached: true,
        detachedDetail: halted.value.detail,
      };
    }
    if (!halted.ok && halted.error.code !== 'Unavailable') {
      failure = classifyFailure({
        stage: 'EngineExecution',
        observed: { error: halted.error.reason, references: [] },
        category: failureCategoryOfError(halted.error.code),
      });
    }
    return {
      terminal,
      failure,
      usage,
      engineVersion,
      stopped: true,
      budgetExhausted,
      detached: false,
      detachedDetail: null,
    };
  }

  return { terminal, failure, usage, engineVersion, stopped: false, budgetExhausted, detached: false, detachedDetail: null };
}

function failedDispatch(error: DomainError): DispatchOutcome {
  return {
    terminal: null,
    failure: classifyFailure({
      stage: 'EngineExecution',
      observed: { error: error.reason, references: [] },
      category: failureCategoryOfError(error.code),
    }),
    usage: usageReporting(null),
    engineVersion: null,
    stopped: false,
    budgetExhausted: false,
    detached: false,
    detachedDetail: null,
  };
}

/** Usage is carried through only when the engine reported it, and is `Unknown` otherwise (F18-AC4). */
function usageOf(reported: EngineReportedUsage): ReportedUsage {
  if (reported.kind === 'Unknown') return usageReporting(null);
  const inputTokens = reported.usage.inputTokens;
  const outputTokens = reported.usage.outputTokens;
  return usageReporting({
    ...(inputTokens === null ? {} : { inputTokens }),
    ...(outputTokens === null ? {} : { outputTokens }),
  });
}

function failureForTerminal(terminal: EngineOutcome | null): FailureRecord {
  if (terminal === null) {
    return classifyFailure({
      stage: 'EngineExecution',
      observed: { error: 'The engine stream ended without a terminal result.', references: [] },
      category: 'Unknown',
    });
  }
  if (terminal.kind === 'Succeeded') {
    return classifyFailure({
      stage: 'EngineExecution',
      observed: { error: terminal.summary, references: [] },
      category: 'Unknown',
    });
  }
  if (terminal.kind === 'Failed') {
    return classifyFailure({
      stage: 'EngineExecution',
      observed: { error: terminal.summary, references: [] },
      category: failureCategoryOf(terminal.category),
      attemptedRemedy: terminal.remedy,
    });
  }
  if (terminal.kind === 'Blocked') {
    return classifyFailure({
      stage: 'EngineExecution',
      observed: { error: terminal.summary, references: [] },
      category: failureCategoryOf(terminal.category),
      attemptedRemedy: terminal.remedy,
    });
  }
  return classifyFailure({
    stage: 'EngineExecution',
    observed: { error: `${terminal.reason}: ${terminal.summary}`, references: [] },
    category: 'Timeout',
  });
}

/** Engine diagnostics map onto the domain's failure categories, never onto a new vocabulary. */
function failureCategoryOf(category: string): FailureCategory {
  switch (category) {
    case 'MissingAuthentication':
    case 'UnavailableModel':
      return 'DeterministicAuth';
    case 'QuotaExhausted':
      return 'ProviderQuota';
    case 'UnsupportedRuntime':
    case 'SandboxDenial':
      return 'Environment';
    case 'ToolError':
      return 'EngineUnavailable';
    case 'NetworkError':
      return 'ProviderRateLimit';
    default:
      return 'Unknown';
  }
}

function failureCategoryOfError(code: DomainError['code']): FailureCategory {
  switch (code) {
    case 'Blocked':
    case 'Forbidden':
      return 'DeterministicAuth';
    case 'Invalid':
    case 'NotFound':
      return 'DeterministicScope';
    case 'RateLimited':
      return 'ProviderRateLimit';
    default:
      return 'EngineUnavailable';
  }
}

/** The engine-side checkpoint the adapter needs, composed from the durable one. */
function engineCheckpointOf(checkpoint: JobCheckpoint, instruction: string): EngineCheckpoint {
  return {
    checkpointId: checkpoint.checkpointId,
    capturedAt: checkpoint.recordedAt,
    scopeFingerprint: checkpoint.scopeFingerprint,
    headSha: checkpoint.headSha,
    baseSha: checkpoint.baseSha,
    dirtyPaths: checkpoint.dirtyFiles,
    untrackedPaths: checkpoint.untrackedFiles,
    blocker: checkpoint.blocker,
    nextAction: checkpoint.nextAction,
    resumeInstructions: instruction,
  };
}

/**
 * Writes one resume point from the workspace as it is at the moment of writing.
 *
 * The inventory is re-read through the observer rather than reused from `prepare`, because the whole
 * point of a checkpoint is that it describes the work an attempt left behind: reusing the
 * pre-attempt observation stored `untracked files: []` for a worktree the engine had just written
 * into, and the retained checkpoint then refused to authorise resuming its own workspace
 * (F14-AC4, F17-AC2).
 *
 * A re-read that is refused is returned as an error rather than papered over with the earlier
 * observation, because the alternative is a resume point that states something about the workspace
 * nobody read.
 */
async function persistCheckpoint(
  ports: RunnerPorts,
  request: AttemptRequest,
  lastRead: WorkspaceObservation,
  content: CheckpointContent,
): Promise<Result<null, DomainError>> {
  const observed = await ports.observeWorkspace({
    job: request.job,
    holder: request.holder,
    workspace: lastRead.workspace,
    lastRead,
  });
  if (!observed.ok) return observed;
  const written = ports.writeCheckpoint({
    jobId: request.job.jobId,
    holder: request.holder,
    checkpointId: ports.checkpointIdFor(request.job),
    scopeSnapshotId: request.job.scopeSnapshotId,
    scopeFingerprint: request.scopeFingerprint,
    profileVersionId: request.job.profileVersionId,
    procedureVersionId: request.job.procedureVersionId,
    engineVersion: content.engineVersion,
    workspace: observed.value.workspace,
    headSha: observed.value.headSha,
    baseSha: observed.value.baseSha,
    dirtyFiles: observed.value.dirtyFiles,
    untrackedFiles: observed.value.untrackedFiles,
    results: ports.facts.resultsFor({ jobId: request.job.jobId }),
    feedback: ports.facts.feedbackFor({ jobId: request.job.jobId }),
    blocker: content.blocker,
    nextAction: content.nextAction,
    now: ports.clock.now(),
  });
  return written.ok ? ok(null) : written;
}

/**
 * Turns a refusal to start the attempt into a terminal outcome or a reported error.
 *
 * Whether a refusal is retried is the domain's decision, taken from the failure category the same
 * way every other failure in this file is classified, rather than a local rule about workspace
 * errors. A deterministic scope or authentication refusal repeats identically on every tick, so it
 * becomes a `Blocked` attempt: the job reaches a terminal state, the owner is given the blocker,
 * and the run loop stops retrying it (F18-AC1, F18-AC5, N01-AC1).
 */
function refusalOutcome(jobId: JobId, error: DomainError): Result<AttemptOutcome, DomainError> {
  const failure = classifyFailure({
    stage: 'Reconciliation',
    observed: { error: error.reason, references: [`job:${jobId}`] },
    category: failureCategoryOfError(error.code),
  });
  if (failure.retryable) return err(error);
  return ok({ kind: 'Blocked', failure, usage: usageReporting(null) });
}

/**
 * Active wall-clock elapsed since the attempt started, from the injected clock only.
 *
 * A clock that cannot be read is a refusal rather than a guess, because falling back to zero
 * would leave the execution limit permanently unreached (F18-AC2).
 */
function elapsedMs(clock: AdapterClock, startedAtMs: number): Result<number, DomainError> {
  const now = Date.parse(clock.now());
  if (Number.isNaN(now)) {
    return err(
      invalid('The injected clock returned a timestamp this worker cannot read.', [
        { path: 'clock.now', message: 'Expected an ISO-8601 instant.' },
      ]),
    );
  }
  return ok(Math.max(0, now - startedAtMs));
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sorted = [...left].sort();
  const other = [...right].sort();
  return sorted.every((entry, index) => entry === other[index]);
}