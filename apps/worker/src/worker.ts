/**
 * The durable worker loop (F13, F15, F17, F18, N01).
 *
 * This process owns the single global coding writer and nothing else. Four properties are the
 * reason the file exists, and each one is a property of the durable store rather than of
 * scheduling discipline:
 *
 *   - **Startup reconciles before it claims.** Opening the database is followed by the real
 *     `migrate`, then a reconciliation pass over every writer whose lease has lapsed. A missed
 *     heartbeat is a reason to look, never permission to take over, so nothing is written blind
 *     and no second writer appears (F17-AC5, N01-AC1).
 *   - **Claiming comes only from the durable queue.** The mode, the captured scope, the project,
 *     the limits and the permitted operations are read back out of the claimed row, and a claim
 *     that finds the coding slot occupied leaves the job `Queued` and starts nothing
 *     (F13-AC1, F13-AC2).
 *   - **The lease is renewed from an injected clock.** The cadence and the silence threshold come
 *     from the domain and the lease module, so a decision about a silent writer is reproducible
 *     rather than dependent on when this code happened to run (F17-AC5).
 *   - **Stopping is graceful first.** The engine is asked to stop, and only an observed stopped
 *     group lets the job be reported `Paused`; a group that may still be writing writes no job
 *     state at all and is recorded for reconciliation instead (F17-AC1).
 *
 * Nothing here reads the inbox, so a provider event can never start a coding session: the only
 * path into an engine is the durable queue, which the recorded owner start wrote (F13-AC5).
 */

import { DEFAULT_HEARTBEAT, err, evaluateHeartbeat, invalid, ok } from '@shiploop/domain';
import type { DomainError, JobId, OwnerWaitInterval, ProjectId, Result, WorkItemId } from '@shiploop/domain';
import type { AdapterClock, AdapterLogger, EngineAdapter } from '@shiploop/adapters';
import {
  closeDatabase,
  migrate,
  openDatabase,
  rejectLeaseTerm,
  type AttentionItemRepository,
  type CheckpointRequest,
  type Database,
  type JobQueue,
  type JobRecord,
  type LeaseManager,
  type WriterLease,
  type WorkItemRepository,
} from '@shiploop/storage';
import { nodeProcessRunner, reuseWorkspace } from '@shiploop/verification';
import {
  ownerWaitBetween,
  runAttempt,
  type AttemptOutcome,
  type CheckpointFactsPort,
  type HeartbeatPort,
  type Milestone,
  type OwnerExtensionPort,
  type RunnerPorts,
  type WorkspaceObservation,
  type WorkspaceObservationRequest,
  type WorkspaceObserver,
  type WorkspacePort,
} from './runner.ts';

/** The holder-liveness question that has to be answered before a second writer (F17-AC5). */
export type HolderLiveness =
  | { readonly kind: 'Stopped'; readonly evidence: string }
  | { readonly kind: 'StillWriting'; readonly evidence: string }
  | { readonly kind: 'Unknown'; readonly evidence: string };

/**
 * How this process establishes whether a previous writer is still writing.
 *
 * A restarted worker holds no handle to the process that held the lease before it, so the only
 * honest answer it can produce alone is `Unknown`. Anything else comes from an operator or from a
 * process supervisor that can actually observe the group, and the evidence is recorded because
 * this question is what frees the single coding writer (F17-AC5).
 */
export interface HolderLivenessPort {
  probe(request: { readonly jobId: JobId; readonly holder: string; readonly lastHeartbeatAt: string }): HolderLiveness;
}

export interface WorkerConfig {
  readonly holder: string;
  readonly projectId: string | null;
  readonly leaseTtlMs: number;
  readonly pollIntervalMs: number;
  readonly engineEventLimit: number;
}

export interface WorkerPorts {
  readonly clock: AdapterClock;
  readonly logger: AdapterLogger;
  readonly redact: (text: string) => string;
  readonly engine: EngineAdapter;
  readonly queue: JobQueue;
  readonly leases: LeaseManager;
  readonly workItems: WorkItemRepository;
  readonly attention: AttentionItemRepository;
  readonly workspaces: WorkspacePort;
  readonly extensions: OwnerExtensionPort;
  readonly facts: CheckpointFactsPort;
  readonly liveness: HolderLivenessPort;
  readonly sleep: (ms: number) => Promise<void>;
}

/** An open, migrated database this worker owns. */
export interface WorkerStore {
  readonly database: Database;
  close(): Result<true, DomainError>;
}

/**
 * Opens the store and brings it to the schema the queue reads.
 *
 * The migration is the real one rather than a fixture, so a statement the queue makes and the
 * schema does not have fails here instead of at the first claim (N01-AC3).
 */
export function openWorkerStore(databasePath: string): Result<WorkerStore, DomainError> {
  const opened = openDatabase(databasePath);
  if (!opened.ok) return opened;
  const database = opened.value;

  const migrated = migrate(database);
  if (!migrated.ok) {
    closeDatabase(database);
    return migrated;
  }

  let closed = false;
  return ok({
    database,
    close(): Result<true, DomainError> {
      if (closed) return ok(true);
      closed = true;
      return closeDatabase(database);
    },
  });
}

/** One reconciliation finding, reported rather than acted on by guessing. */
export interface ReconciliationFinding {
  readonly jobId: JobId;
  readonly holder: string;
  readonly status: 'Vacant' | 'ReconciliationRequired' | 'ReclaimForbidden';
  readonly detail: string;
  /** True when a holder-stopped confirmation was recorded, so a takeover may be prepared. */
  readonly takeoverPrepared: boolean;
}

export interface ReconciliationReport {
  readonly findings: readonly ReconciliationFinding[];
  /** Jobs this process may continue because the owner extended them and it holds the writer. */
  readonly continuable: readonly JobId[];
  /**
   * Jobs this process may restart, with the instant they were left in that state. Only state
   * recorded before this process started is considered, so a job that pauses again waits for a
   * fresh owner dispatch rather than spinning this loop (N01-AC1).
   */
  readonly recoverable: readonly { readonly jobId: JobId; readonly updatedAt: string }[];
  /** Jobs parked for an owner extension, with the durable instant that wait started. */
  readonly ownerWaits: readonly { readonly jobId: JobId; readonly since: string }[];
}

export type TickReport =
  | { readonly kind: 'Idle' }
  | { readonly kind: 'SlotOccupied'; readonly detail: string }
  | { readonly kind: 'Claimed'; readonly jobId: JobId; readonly outcome: AttemptOutcome }
  | { readonly kind: 'Refused'; readonly detail: string };

export interface WorkerRunReport {
  readonly ticks: number;
  readonly claimed: number;
  readonly resumed: number;
  readonly completed: number;
  readonly blocked: number;
  readonly waitingForOwner: number;
  readonly paused: number;
  readonly detached: number;
  readonly findingsRequiringReconciliation: number;
  readonly takeoversPrepared: number;
  readonly errors: readonly string[];
}

export interface Worker {
  /** Reconciliation only. Safe to call repeatedly; it never starts a writer by itself. */
  reconcile(): Promise<Result<ReconciliationReport, DomainError>>;
  /** One iteration: reconcile, then recover a confirmed job or claim and drive at most one. */
  tick(): Promise<Result<TickReport, DomainError>>;
  /** Loop until the abort signal fires. */
  run(signal: AbortSignal): Promise<WorkerRunReport>;
  /** Asks the live attempt to stop; it then checkpoints and the job is reported `Paused`. */
  requestStop(): void;
  readonly stopRequested: () => boolean;
}

/** Job states that mean work was in flight when this process last looked. */
const RECOVERABLE_STATES = ['Running', 'Verifying', 'Paused', 'WaitingForOwner'] as const;

/**
 * Builds the loop over an open store.
 *
 * The lease term is checked against the storage rule here so a caller cannot assemble a worker
 * whose cadence could hide a wedged writer, and the coding slot is seeded idempotently so two
 * processes starting together do not race (F17-AC5).
 */
export function createWorker(
  config: WorkerConfig,
  ports: WorkerPorts,
): Result<Worker, DomainError> {
  const term = rejectLeaseTerm(config.leaseTtlMs);
  if (!term.ok) return term;
  if (!Number.isInteger(config.engineEventLimit) || config.engineEventLimit < 1) {
    return err(
      invalid('The engine event bound must be a positive whole number.', [
        { path: 'engineEventLimit', message: 'Expected a whole number greater than zero.' },
      ]),
    );
  }
  if (config.holder.trim().length === 0) {
    return err(
      invalid('The writer holder identity must be named.', [
        {
          path: 'holder',
          message: 'The lease row names this identity, so an unnamed holder could never be reconciled.',
        },
      ]),
    );
  }
  const observeWorkspace = workspaceObserverOf(ports.workspaces);
  ports.leases.ensureCodingSlot();

  const clockAtStartup = readInstant(ports.clock.now());
  if (clockAtStartup === null) {
    return err(
      invalid('The injected clock returned a timestamp this worker cannot read.', [
        { path: 'clock.now', message: 'Expected an ISO-8601 instant.' },
      ]),
    );
  }
  /** Recovery only considers state this process did not create, so the loop cannot spin (N01-AC1). */
  const startedAtMs: number = clockAtStartup;
  const stop = { requested: false, controller: new AbortController() };
  const counters = {
    ticks: 0,
    claimed: 0,
    resumed: 0,
    completed: 0,
    blocked: 0,
    waitingForOwner: 0,
    paused: 0,
    detached: 0,
    findingsRequiringReconciliation: 0,
    takeoversPrepared: 0,
    errors: [] as string[],
  };

  const runnerPorts: RunnerPorts = {
    clock: ports.clock,
    logger: ports.logger,
    redact: ports.redact,
    engine: ports.engine,
    workspaces: ports.workspaces,
    observeWorkspace,
    extensions: ports.extensions,
    facts: ports.facts,
    onMilestone: (job, milestone: Milestone) => {
      ports.logger.emit({
        level: 'Info',
        message: `engine milestone ${milestone.stage}`,
        correlationId: job.correlationId,
        operationId: job.operationId,
        fields: { summary: milestone.summary, milestoneKey: milestone.milestoneKey },
      });
    },
    writeCheckpoint: (request: CheckpointRequest) => ports.queue.checkpoint(request),
    checkpointIdFor: (job) => `ckpt:${job.jobId}:${String(job.attemptCount)}`,
    engineEventLimit: config.engineEventLimit,
  };

  /**
   * Decides what a job whose previous writer went quiet may do.
   *
   * The order is the whole of F17-AC5: classify the silence with the domain's heartbeat policy,
   * ask the liveness port, and let only a recorded `Stopped` answer become a
   * `confirmHolderStopped`. A holder that may still be writing keeps the coding slot, and no job
   * row is written here at all.
   */
  async function reconcileWriter(
    jobId: JobId,
    holder: string,
    lastHeartbeatAt: string,
  ): Promise<Result<ReconciliationFinding, DomainError>> {
    const nowMs = readInstant(ports.clock.now());
    const lastMs = readInstant(lastHeartbeatAt);
    if (nowMs === null || lastMs === null) {
      return ok({
        jobId,
        holder,
        status: 'ReconciliationRequired',
        detail:
          'The recorded heartbeat time cannot be read, so the silence cannot be assessed and nothing was taken over.',
        takeoverPrepared: false,
      });
    }

    const status = ports.leases.leaseStatus(jobId);
    if (!status.ok) return status;
    const lease = status.value;

    const assessment = evaluateHeartbeat({
      lastHeartbeatAtMs: lastMs,
      nowMs,
      intervalMs: DEFAULT_HEARTBEAT.intervalMs,
      missedThresholdMs: DEFAULT_HEARTBEAT.missedThresholdMs,
      leaseExpiredAtMs: lease === null ? null : readInstant(lease.expiresAt),
      holderStoppedConfirmedAtMs: lease === null ? null : lease.confirmedStoppedAt === null ? null : readInstant(lease.confirmedStoppedAt),
    });

    if (assessment.status === 'Healthy') {
      return ok({
        jobId,
        holder,
        status: 'Vacant',
        detail: 'The previous writer is inside its lease and heartbeating, so there is nothing to reconcile.',
        takeoverPrepared: false,
      });
    }

    const liveness = ports.liveness.probe({ jobId, holder, lastHeartbeatAt });
    if (liveness.kind !== 'Stopped') {
      return ok({
        jobId,
        holder,
        status: assessment.status === 'ReclaimForbidden' ? 'ReclaimForbidden' : 'ReconciliationRequired',
        detail: `${assessment.status}: ${liveness.evidence} Nothing was taken over, because a missed heartbeat proves only that heartbeats stopped (F17-AC5).`,
        takeoverPrepared: false,
      });
    }

    const confirmed = ports.leases.confirmHolderStopped({
      jobId,
      holder,
      confirmedBy: config.holder,
      confirmedAt: ports.clock.now(),
      evidence: liveness.evidence,
    });
    if (!confirmed.ok) return confirmed;
    return ok({
      jobId,
      holder,
      status: 'Vacant',
      detail: `The previous writer was observed stopped (${liveness.evidence}), so the job may be taken over.`,
      takeoverPrepared: true,
    });
  }

  async function reconcile(): Promise<Result<ReconciliationReport, DomainError>> {
    const findings: ReconciliationFinding[] = [];
    const now = ports.clock.now();

    const examined = new Set<JobId>();
    const stale = ports.queue.staleWriters(now);
    if (!stale.ok) return stale;
    for (const writer of stale.value) {
      examined.add(writer.jobId);
      const finding = await reconcileWriter(writer.jobId, writer.holder, writer.lastHeartbeatAt);
      if (!finding.ok) return finding;
      findings.push(finding.value);
    }

    const inFlight = ports.queue.listJobs({
      states: [...RECOVERABLE_STATES],
      projectId: asProjectId(config.projectId),
    });
    if (!inFlight.ok) return inFlight;

    const ownerWaits: { readonly jobId: JobId; readonly since: string }[] = [];
    const leases = new Map<JobId, WriterLease | null>();
    for (const job of inFlight.value) {
      if (job.state === 'WaitingForOwner') ownerWaits.push({ jobId: job.jobId, since: job.updatedAt });

      const lease = ports.leases.leaseStatus(job.jobId);
      if (!lease.ok) return lease;
      leases.set(job.jobId, lease.value);
      if (examined.has(job.jobId)) continue;
      if (lease.value !== null && lease.value.holder === config.holder) continue;

      const record = lease.value;
      const vacant = record === null || record.state === 'Released' || record.state === 'HolderStoppedConfirmed';
      if (vacant) continue;

      const finding = await reconcileWriter(
        job.jobId,
        record?.holder ?? config.holder,
        record?.renewedAt ?? job.updatedAt,
      );
      if (!finding.ok) return finding;
      findings.push(finding.value);
    }

    /**
     * Continues the jobs this process already holds and the jobs it may restart.
     *
     * A lapsed lease authorises nothing on its own: only a recorded holder-stopped confirmation
     * does. A released lease does authorise a restart, because the writer that held it gave the
     * coding slot up itself (F17-AC1, N01-AC1). An owner extension authorises a continuation for
     * the holder that is already the writer (F18-AC2).
     */
    const continuable: JobId[] = [];
    const recoverable: { readonly jobId: JobId; readonly updatedAt: string }[] = [];
    for (const job of inFlight.value) {
      const lease = leases.get(job.jobId) ?? null;
      const vacant = lease === null || lease.state === 'Released' || lease.state === 'HolderStoppedConfirmed';
      const confirmed = findings.some((finding) => finding.jobId === job.jobId && finding.takeoverPrepared);
      const extendedByOwner =
        job.state === 'WaitingForOwner' &&
        lease !== null &&
        lease.holder === config.holder &&
        ports.extensions.extensionFor({ jobId: job.jobId }) !== null;

      if (!extendedByOwner && !vacant && !confirmed) continue;

      /**
       * A continuation reclaims as well.
       *
       * `WaitingForOwner` gives the coding slot up, so continuing it means taking the single writer
       * again. Reclaiming is what mints that term and puts this holder back on the job row, so a
       * continued attempt owns the writer and can heartbeat and checkpoint like any other
       * (F13-AC2, F18-AC2).
       */
      const reclaimed = ports.leases.reclaimLease({
        leaseId: `lease:${job.jobId}`,
        jobId: job.jobId,
        holder: config.holder,
        operationId: job.operationId,
        now,
        leaseTtlMs: config.leaseTtlMs,
      });
      if (!reclaimed.ok) return reclaimed;
      if (!reclaimed.value.granted) continue;
      if (extendedByOwner) {
        continuable.push(job.jobId);
        continue;
      }
      recoverable.push({ jobId: job.jobId, updatedAt: job.updatedAt });
    }

    counters.findingsRequiringReconciliation += findings.filter((finding) => finding.status !== 'Vacant').length;
    counters.takeoversPrepared += recoverable.length;

    return ok({ findings, continuable, ownerWaits, recoverable });
  }

  /**
   * Owner waiting time this attempt is entitled to have excluded.
   *
   * The start is the durable instant the job was recorded as waiting, read during reconciliation
   * rather than remembered in this process, so a restart does not lose the exclusion (F18-AC3).
   */
  function ownerWaitsFor(jobId: JobId, report: ReconciliationReport): readonly OwnerWaitInterval[] {
    return report.ownerWaits
      .filter((wait) => wait.jobId === jobId)
      .map((wait) => ownerWaitBetween(wait.since, ports.clock.now(), 'The owner decided whether to extend this attempt.'));
  }

  /**
   * The lease renewal for one job, driven by the injected clock.
   *
   * Renewal happens only when the domain's cadence is due, and a refusal is returned so the
   * attempt stops dispatching rather than continuing on ownership it no longer holds (F17-AC5).
   */
  function heartbeatFor(job: JobRecord): HeartbeatPort {
    let lastMs = readInstant(ports.clock.now()) ?? 0;
    return {
      renew(): Result<'Renewed' | 'NotDue', DomainError> {
        const now = ports.clock.now();
        const nowMs = readInstant(now);
        if (nowMs === null) {
          return err(
            invalid('The injected clock returned a timestamp this worker cannot read.', [
              { path: 'clock.now', message: 'Expected an ISO-8601 instant.' },
            ]),
          );
        }
        if (nowMs - lastMs < DEFAULT_HEARTBEAT.intervalMs) return ok('NotDue');
        const renewed = ports.queue.heartbeat({
          jobId: job.jobId,
          holder: config.holder,
          now,
          leaseTtlMs: config.leaseTtlMs,
        });
        if (!renewed.ok) return renewed;
        lastMs = nowMs;
        return ok('Renewed');
      },
    };
  }

  /** Drives one attempt and records only the state transition the outcome actually reached. */
  async function driveAttempt(job: JobRecord, report: ReconciliationReport): Promise<Result<AttemptOutcome, DomainError>> {
    const snapshot = ports.workItems.getScopeSnapshot(job.scopeSnapshotId);
    if (!snapshot.ok) return snapshot;

    const checkpoint = ports.queue.readCheckpoint(job.jobId);
    if (!checkpoint.ok) return checkpoint;

    /**
     * Active execution is charged from the earlier of this attempt's claim and its last recorded
     * checkpoint, so an interrupted attempt does not silently receive a fresh budget when it is
     * recovered. `JobRecord` does not expose the schema's `started_at`, so the earliest durable
     * instant available is used and the gap is reported as a needed storage change (F18-AC2).
     */
    const lease = ports.leases.leaseStatus(job.jobId);
    if (!lease.ok) return lease;
    const claimedAtMs = lease.value === null ? null : readInstant(lease.value.acquiredAt);
    const checkpointAtMs = checkpoint.value === null ? null : readInstant(checkpoint.value.recordedAt);
    const attemptStartedAtMs = earliestInstant(claimedAtMs, checkpointAtMs, ports.clock.now());
    if (attemptStartedAtMs === null) {
      return err(
        invalid('The durable instants for this attempt cannot be read.', [
          { path: 'clock.now', message: 'Expected an ISO-8601 instant.' },
        ]),
      );
    }

    const outcome = await runAttempt(runnerPorts, {
      job,
      holder: config.holder,
      instruction: instructionFor(snapshot.value.description, snapshot.value.acceptanceCriteria),
      scopeFingerprint: snapshot.value.scopeFingerprint,
      checkpoint: checkpoint.value,
      ownerWaits: ownerWaitsFor(job.jobId, report),
      attemptStartedAtMs,
      fixPasses: 0,
      heartbeat: heartbeatFor(job),
      stopRequested: () => stop.requested,
      stopSignal: stop.controller.signal,
    });
    if (!outcome.ok) return outcome;

    const recorded = await recordOutcome(job, outcome.value);
    if (!recorded.ok) return recorded;
    return outcome;
  }

  /**
   * Records the transition the outcome actually reached.
   *
   * `Paused` is written only for an observed stopped writer, `WaitingForOwner` only when the
   * domain said a limit was reached, and a detached group writes no job state at all because the
   * previous writer may still be running (F17-AC1, F18-AC2).
   */
  async function recordOutcome(job: JobRecord, outcome: AttemptOutcome): Promise<Result<null, DomainError>> {
    const now = ports.clock.now();
    if (outcome.kind === 'Completed') {
      counters.completed += 1;
      return mark(job.jobId, 'Completed', now);
    }
    if (outcome.kind === 'WaitingForOwner') {
      counters.waitingForOwner += 1;
      const moved = await mark(job.jobId, 'WaitingForOwner', now);
      if (!moved.ok) return moved;
      return attention(
        job,
        'Blocker',
        `owner-extension:${job.jobId}`,
        `Job ${job.jobId} reached the work limits recorded with it`,
        outcome.limits.reason,
        'Extend the limits recorded with the job, or cancel it.',
      );
    }
    if (outcome.kind === 'Stopped') {
      counters.paused += 1;
      return mark(job.jobId, 'Paused', now);
    }
    if (outcome.kind === 'WriterDetached') {
      counters.detached += 1;
      return attention(
        job,
        'WorkerStopped',
        `WorkerStopped:${job.jobId}`,
        `Job ${job.jobId} stopped, but a process may still be writing in its workspace`,
        outcome.detail,
        'Confirm the previous writer stopped, then resume the job from its checkpoint (F17-AC5).',
      );
    }
    counters.blocked += 1;
    const moved = await mark(job.jobId, 'Blocked', now);
    if (!moved.ok) return moved;
    return attention(
      job,
      'Blocker',
      `Blocker:${job.jobId}`,
      `Job ${job.jobId} is blocked at ${outcome.failure.stage}`,
      `${outcome.failure.category}: ${outcome.failure.observed.error}`,
      outcome.failure.recommendedNextAction,
    );
  }

  async function mark(jobId: JobId, state: Parameters<JobQueue['markState']>[0]['state'], now: string): Promise<Result<null, DomainError>> {
    const moved = ports.queue.markState({ jobId, state, now });
    return moved.ok ? ok(null) : moved;
  }

  async function attention(
    job: JobRecord,
    kind: 'Blocker' | 'WorkerStopped',
    dedupKey: string,
    title: string,
    blocker: string,
    nextAction: string,
  ): Promise<Result<null, DomainError>> {
    const recorded = ports.attention.upsert({
      dedupKey,
      kind,
      projectId: job.projectId,
      workItemId: job.workItemId as WorkItemId,
      issueIdentifier: null,
      title,
      blocker,
      nextAction,
      candidateFingerprint: null,
      observedAt: ports.clock.now(),
      resolved: false,
    });
    return recorded.ok ? ok(null) : recorded;
  }

  async function tick(): Promise<Result<TickReport, DomainError>> {
    counters.ticks += 1;
    const reconciled = await reconcile();
    if (!reconciled.ok) return reconciled;

    const continuedId = reconciled.value.continuable[0];
    const restartedId = reconciled.value.recoverable.find((candidate) => {
      const leftAt = readInstant(candidate.updatedAt);
      return leftAt !== null && leftAt < startedAtMs;
    })?.jobId;
    const resumedId = continuedId ?? restartedId;
    if (resumedId !== undefined) {
      counters.resumed += 1;
      const prepared = await prepareResume(resumedId);
      if (!prepared.ok) return prepared;
      const driven = await driveAttempt(prepared.value, reconciled.value);
      if (!driven.ok) return driven;
      return ok({ kind: 'Claimed', jobId: resumedId, outcome: driven.value });
    }

    const claimed = ports.queue.claimNext({
      holder: config.holder,
      now: ports.clock.now(),
      leaseTtlMs: config.leaseTtlMs,
      projectId: asProjectId(config.projectId),
    });
    if (!claimed.ok) {
      if (claimed.error.code === 'NotFound') return ok({ kind: 'Idle' });
      if (claimed.error.code === 'Conflict') return ok({ kind: 'SlotOccupied', detail: claimed.error.reason });
      return ok({ kind: 'Refused', detail: claimed.error.reason });
    }
    counters.claimed += 1;

    const driven = await driveAttempt(claimed.value.job, reconciled.value);
    if (!driven.ok) return driven;
    return ok({ kind: 'Claimed', jobId: claimed.value.job.jobId, outcome: driven.value });
  }

  /**
   * Moves a confirmed-stale job into a driven state and counts this as another attempt.
   *
   * The writer lease is already this process's, so this is a lifecycle move rather than a claim.
   * `WaitingForOwner` returns to `Running` because the owner has now had the decision the state
   * was waiting for (F17-AC3).
   *
   * The attempt counter advances because a recovery dispatches a second engine session, and the
   * checkpoint it writes is named by that counter. Left alone it reused the first attempt's
   * identifier, so two attempts of one job produced the same `ckpt:<jobId>:<attemptCount>` and the
   * retained resume point could not say which attempt produced the workspace (F17-AC2, F18-AC1).
   */
  async function prepareResume(jobId: JobId): Promise<Result<JobRecord, DomainError>> {
    const job = ports.queue.readJob(jobId);
    if (!job.ok) return job;
    if (job.value === null) {
      return err({ code: 'NotFound', reason: `Job ${jobId} disappeared between reconciliation and resume.` });
    }
    const now = ports.clock.now();
    if (job.value.state !== 'Running' && job.value.state !== 'Verifying') {
      const moved = ports.queue.markState({ jobId, state: 'Running', now });
      if (!moved.ok) return moved;
    }
    return ports.queue.beginAttempt({ jobId, holder: config.holder, now });
  }

  async function run(signal: AbortSignal): Promise<WorkerRunReport> {
    while (!signal.aborted) {
      const outcome = await tick();
      if (!outcome.ok) counters.errors.push(outcome.error.reason);
      if (signal.aborted) break;
      await ports.sleep(config.pollIntervalMs);
    }
    return {
      ticks: counters.ticks,
      claimed: counters.claimed,
      resumed: counters.resumed,
      completed: counters.completed,
      blocked: counters.blocked,
      waitingForOwner: counters.waitingForOwner,
      paused: counters.paused,
      detached: counters.detached,
      findingsRequiringReconciliation: counters.findingsRequiringReconciliation,
      takeoversPrepared: counters.takeoversPrepared,
      errors: [...counters.errors],
    };
  }

  return ok({
    reconcile,
    tick,
    run,
    requestStop(): void {
      stop.requested = true;
      stop.controller.abort();
    },
    stopRequested: () => stop.requested,
  });
}

/** The instruction is composed from the stored scope snapshot, never from a provider response. */
function instructionFor(
  description: string,
  acceptanceCriteria: readonly { readonly id: string; readonly text: string }[],
): string {
  const criteria = acceptanceCriteria.map((criterion) => `- ${criterion.id}: ${criterion.text}`).join('\n');
  return [
    'Work against this captured scope. It is authoritative and does not change during the attempt.',
    '',
    description,
    '',
    'Acceptance criteria:',
    criteria,
  ].join('\n');
}

/**
 * Narrows the configured project filter to the domain's branded identity.
 *
 * The value came from configuration rather than from a provider response, and the queue's own
 * filter is typed for the brand; this is the one place the conversion is visible.
 */
function asProjectId(value: string | null): ProjectId | null {
  return value === null ? null : (value as ProjectId);
}

/**
 * Builds the read a checkpoint's inventory is written from.
 *
 * A checkpoint is written after the attempt's work has settled, so it has to describe the workspace
 * as it is then rather than as it was before the attempt; the pre-attempt reading stored an empty
 * untracked set for a worktree the engine had just written into, and the retained checkpoint then
 * refused the very workspace it described (F14-AC4, F17-AC2).
 *
 * A provider that exposes `observe` reads its own workspace. One that does not is read with
 * `@shiploop/verification`, the same module that provider uses to decide whether a workspace may be
 * reused, applied to the identity the provider reported. Both sides of a resume comparison are then
 * read by one implementation, so a difference means the workspace changed rather than that two
 * readers disagree. Preparing the workspace still belongs to the provider alone: this reads a
 * workspace the attempt already owns and creates nothing, takes no lock and reserves no port
 * (F14-AC1).
 */
function workspaceObserverOf(port: WorkspacePort): WorkspaceObserver {
  const observe = port.observe;
  if (typeof observe === 'function') return (request) => observe.call(port, request);
  return rereadWorkspaceWithVerification;
}

/**
 * Re-reads one workspace with the verified workspace module.
 *
 * The read is the observation `reuseWorkspace` performs, and it is taken from the report rather than
 * from the verdict: a workspace that has moved on since the last read is exactly the case a
 * checkpoint has to describe, so refusing the read here would reinstate the defect. What is not
 * negotiable is an unreadable workspace, which has no honest inventory and is reported as an error
 * rather than written down (F14-AC4).
 */
async function rereadWorkspaceWithVerification(
  request: WorkspaceObservationRequest,
): Promise<Result<WorkspaceObservation, DomainError>> {
  const observedAt = new Date().toISOString();
  const read = await reuseWorkspace(
    {
      checkpoint: {
        checkpointId: `reread:${request.job.jobId}`,
        workspaceId: request.workspace.workspaceId,
        branchName: request.workspace.branchName,
        worktreePath: request.workspace.worktreePath,
        headSha: request.lastRead.headSha,
        baseSha: request.lastRead.baseSha,
        dirtyFiles: request.lastRead.dirtyFiles,
        untrackedFiles: request.lastRead.untrackedFiles,
        recordedAt: observedAt,
      },
      holder: request.holder,
      now: observedAt,
    },
    { runCommand: nodeProcessRunner },
  );
  // A refused reuse still carries the observation, which is the whole of what a checkpoint needs.
  const report = read.ok ? read.value : read.error.report;
  const headSha = report.actualHeadSha;
  if (headSha === null) {
    const unreadable = report.divergences.find((divergence) => divergence.kind === 'WorkspaceUnreadable');
    return err({
      code: 'Unavailable',
      reason: `The workspace ${request.workspace.workspaceId} at ${request.workspace.worktreePath} could not be re-read, so no checkpoint can describe it: ${unreadable?.detail ?? 'its head could not be read as a commit.'}`,
    });
  }
  return ok({
    workspace: request.workspace,
    headSha,
    // The base is the fork point the provider recorded, not something a checkout can re-derive.
    baseSha: request.lastRead.baseSha,
    dirtyFiles: report.observedDirtyFiles,
    untrackedFiles: report.observedUntrackedFiles,
  });
}

/**
 * The earliest readable instant, falling back to the clock when neither record can be read.
 */
function earliestInstant(left: number | null, right: number | null, fallback: string): number | null {
  const candidates = [left, right].filter((value): value is number => value !== null);
  if (candidates.length > 0) return Math.min(...candidates);
  return readInstant(fallback);
}

/**
 * Reads an injected-clock instant.
 *
 * An unreadable timestamp becomes null rather than zero, because a silent fall back would make
 * elapsed time and lease expiry arithmetic meaningless (F17-AC5, F18-AC2).
 */
function readInstant(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
