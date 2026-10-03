/**
 * Behavioural proof for the durable worker loop (F13, F15, F17, F18, N01).
 *
 * Every test runs against the real migrated schema and the real durable queue, lease manager and
 * inbox: the database is a temp file created with `mkdtemp` and brought up by `migrate`, so a
 * statement the queue makes and the schema does not have fails here rather than in an
 * application. Nothing here reads the wall clock — a `TestClock` is injected, so the 15s heartbeat
 * cadence and the 60s missed-heartbeat threshold are exercised without waiting.
 *
 * The coding engine is a deterministic `EngineAdapter` double that emits the real `EngineEvent`
 * shapes. No live Codex session runs: a live pass spends account quota and belongs to the
 * adapter's own proof in `packages/adapters/src/codex`, not to the worker. The two places where
 * a real process matters — the bounded kill of the tracked process group, and the shipped
 * entrypoint under a real `SIGTERM` — spawn real processes.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { blocked, err, ok } from '@shiploop/domain';
import type {
  AttemptState,
  CapabilityKind,
  CommitSha,
  ConnectorId,
  DomainError,
  Fingerprint,
  JobId,
  OperationId,
  ProjectId,
  ProviderId,
  Result,
  ScopeSnapshotId,
} from '@shiploop/domain';
import { CODEX_VERIFIED_VERSION, CodexEngineAdapter, PRIVILEGED_CAPABILITY_KINDS } from '@shiploop/adapters';
import type {
  AdapterCapabilities,
  AdapterClock,
  AdapterCompatibility,
  AdapterContext,
  AdapterLogRecord,
  AdapterLogger,
  EngineAdapter,
  EngineContinuation,
  EngineEvent,
  EngineSessionHandle,
  EngineStartRequest,
  EngineStopOutcome,
  ExecutionWorkspace,
  ResumeEngineSessionRequest,
} from '@shiploop/adapters';
import {
  AttentionItemRepository,
  WorkItemRepository,
  createInboxStore,
  createJobQueue,
  createLeaseManager,
  currentVersion,
  LATEST_SCHEMA_VERSION,
} from '@shiploop/storage';
import type { Database, EnqueueRequest, JobCheckpoint, JobLimits, JobQueue, LeaseManager } from '@shiploop/storage';
import { createWorker, openWorkerStore } from './worker.ts';
import type { HolderLiveness, Worker, WorkerPorts, WorkerStore } from './worker.ts';
import { assessResume, resolveGrantForJob } from './runner.ts';
import type {
  CheckpointFactsPort,
  OwnerExtension,
  OwnerExtensionPort,
  PreparedWorkspace,
  WorkspacePort,
} from './runner.ts';

const T0 = '2026-03-01T10:00:00.000Z';
const HEAD_SHA = 'a'.repeat(40) as CommitSha;
const BASE_SHA = 'b'.repeat(40) as CommitSha;
const MOVED_HEAD_SHA = 'c'.repeat(40) as CommitSha;
const SCOPE_FINGERPRINT = `fp_${'1'.repeat(32)}` as Fingerprint;
const PROJECT = '0a5f1c22-0000-4000-8000-0000000000f1' as ProjectId;
const PROFILE_VERSION = 'profile-version-worker';
const PROCEDURE_VERSION = 'procedure-version-worker';
const WORK_ITEM = 'work-item-worker';
const ISSUE = 'issue-worker';
const SNAPSHOT_ID = 'snap-worker' as ScopeSnapshotId;
const HOLDER = 'worker-under-test';
const LEASE_TTL_MS = 60_000;
const WORKSPACE_PATH = '/tmp/shiploop-worker-test';

/* -------------------------------------------------------------------------- */
/* Engine double                                                               */
/* -------------------------------------------------------------------------- */

interface EngineScript {
  readonly events: readonly EngineEvent[];
  /** Applied after each event, so a test can move the injected clock mid-attempt. */
  readonly advance?: (ms: number) => void;
  /** Awaited after the scripted events, so a test can hold a session open and then release it. */
  readonly hold?: () => Promise<void>;
  /** Reported from `stopSession` instead of the default stopped result. */
  readonly stopOutcome?: EngineStopOutcome;
  /** Spawned instead of scripting, so the tracked process group is a real one. */
  readonly spawnGroup?: () => ChildProcess;
}

/**
 * A deterministic engine adapter double.
 *
 * It answers the same three methods the worker calls and records every request, so a test can
 * assert what the worker actually handed the engine — the grant, the bounds and the instruction
 * — rather than inferring it from a durable row. Its capability declarations come from the real
 * Codex adapter, so the worker is exercised against the declarations it would meet in production.
 */
class ScriptedEngine implements EngineAdapter {
  readonly kind = 'Engine' as const;
  readonly connectorId = 'connector_test_engine' as ConnectorId;
  readonly starts: EngineStartRequest[] = [];
  readonly stops: { readonly sessionId: string; readonly reason: string }[] = [];
  readonly declarations: AdapterCapabilities;
  tracked: ChildProcess | null = null;
  /**
   * Resolves once the first session has actually been started.
   *
   * A test waits on this instead of a fixed delay, so a slow machine cannot turn a scheduling
   * detail into a failed assertion.
   */
  readonly firstSession: Promise<void>;
  private readonly script: EngineScript;
  private announceFirstSession: () => void = () => undefined;
  private sessionCounter = 0;

  constructor(script: EngineScript) {
    this.script = script;
    this.declarations = new CodexEngineAdapter({ connectorId: this.connectorId, client: { binary: 'codex' } }).capabilities();
    this.firstSession = new Promise<void>((resolve) => {
      this.announceFirstSession = resolve;
    });
  }

  capabilities(): AdapterCapabilities {
    return this.declarations;
  }

  async checkCompatibility(): Promise<Result<AdapterCompatibility>> {
    return ok({
      kind: 'Engine',
      contractVersion: this.declarations.contractVersion,
      runtimeVersion: CODEX_VERIFIED_VERSION,
      compatible: true,
      detail: 'scripted engine double',
      observedAt: T0,
    });
  }

  async startSession(_context: AdapterContext, request: EngineStartRequest): Promise<Result<EngineSessionHandle>> {
    this.starts.push(request);
    this.announceFirstSession();
    this.sessionCounter += 1;
    const sessionId = `sess_test_${String(this.sessionCounter)}` as ProviderId;
    return ok({
      sessionId,
      engineVersion: CODEX_VERIFIED_VERSION,
      mode: 'Headless',
      workspace: request.workspace,
      grantedCapabilities: request.grantedCapabilities,
      startedAt: T0,
      events: this.stream(sessionId),
    });
  }

  async stopSession(
    _context: AdapterContext,
    request: { readonly sessionId: string; readonly reason: string },
  ): Promise<Result<EngineStopOutcome>> {
    this.stops.push({ sessionId: request.sessionId, reason: request.reason });
    if (this.script.stopOutcome !== undefined) return ok(this.script.stopOutcome);
    if (this.tracked === null) return ok({ kind: 'Stopped', stoppedAt: T0, checkpoint: null });
    const survivors = await signalTrackedGroup(this.tracked);
    return ok(
      survivors
        ? { kind: 'Detached', detail: 'the tracked group survived the bounded kill', reconcileRequired: true }
        : { kind: 'Stopped', stoppedAt: T0, checkpoint: null },
    );
  }

  async resumeSession(
    _context: AdapterContext,
    request: ResumeEngineSessionRequest,
  ): Promise<Result<EngineContinuation>> {
    return ok({
      kind: 'ContinuationUnsupported',
      checkpoint: request.checkpoint,
      limitation: 'the scripted engine double cannot restore its own conversation',
      requiresFreshSessionFromCheckpoint: true,
    });
  }

  private async *stream(sessionId: ProviderId): AsyncIterable<EngineEvent> {
    this.tracked = this.script.spawnGroup?.() ?? null;

    for (const event of this.script.events) {
      yield event.kind === 'SessionStarted' ? { ...event, sessionId, at: T0 } : event;
      this.script.advance?.(0);
    }
    await (this.script.hold?.() ?? Promise.resolve());
    if (!this.script.events.some((event) => event.kind === 'Result')) {
      yield {
        kind: 'Result',
        at: T0,
        outcome: { kind: 'Incomplete', reason: 'Stopped', summary: 'the scripted stream ended without a terminal result' },
      };
    }
  }
}

/**
 * Terminates one tracked group the way the engine adapter documents: `SIGTERM` to the group,
 * a bounded wait, then `SIGKILL` to the same group. The escalation policy itself belongs to the
 * adapter and is proven there; what this test needs is a real group and a real bystander, so the
 * double reproduces the two signals without duplicating the adapter's translation.
 */
async function signalTrackedGroup(child: ChildProcess): Promise<boolean> {
  const groupId = child.pid;
  if (groupId === undefined) return false;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(-groupId, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(25);
      try {
        process.kill(-groupId, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
      }
    }
  }
  return true;
}

function sessionStarted(at: string): EngineEvent {
  return {
    kind: 'SessionStarted',
    at,
    sessionId: 'sess_placeholder' as ProviderId,
    engineVersion: CODEX_VERIFIED_VERSION,
    mode: 'Headless',
    startedFrom: 'Fresh',
  };
}

function progress(at: string, stage: 'Implementing' | 'RunningChecks'): EngineEvent {
  return { kind: 'Progress', at, stage, milestoneKey: `${stage}-1`, summary: `working on ${stage}`, detail: null };
}

function succeeded(at: string, summary: string): EngineEvent {
  return { kind: 'Result', at, outcome: { kind: 'Succeeded', summary } };
}

function usageReported(at: string, inputTokens: number, outputTokens: number): EngineEvent {
  return {
    kind: 'Usage',
    at,
    usage: {
      kind: 'Reported',
      usage: {
        availability: 'Reported',
        windowStart: null,
        windowEnd: null,
        inputTokens,
        outputTokens,
        billedAmount: null,
        currency: null,
        unknownReason: null,
      },
    },
  };
}

function blockedByAuthentication(at: string): EngineEvent {
  return {
    kind: 'Result',
    at,
    outcome: {
      kind: 'Blocked',
      category: 'MissingAuthentication',
      remedy: 'Sign the coding engine in on this host, then resume.',
      summary: 'codex exec reported 401 Unauthorized: missing bearer authentication',
    },
  };
}

function diagnosticToolError(at: string): EngineEvent {
  return { kind: 'Diagnostic', at, category: 'ToolError', detail: 'the check command exited 2', retry: 'Retryable', evidence: null };
}

function failedOutcome(at: string): EngineEvent {
  return {
    kind: 'Result',
    at,
    outcome: { kind: 'Failed', category: 'ToolError', summary: 'the checks failed', remedy: 'fix the failing check' },
  };
}

/* -------------------------------------------------------------------------- */
/* Ports and workspace facts                                                   */
/* -------------------------------------------------------------------------- */

function observation(overrides: Partial<PreparedWorkspace['observation']> = {}): PreparedWorkspace['observation'] {
  return {
    workspace: { workspaceId: 'ws-worker', branchName: 'shiploop/worker-test', worktreePath: WORKSPACE_PATH },
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    dirtyFiles: ['src/worker.ts'],
    untrackedFiles: ['src/worker.test.ts'],
    ...overrides,
  };
}

function executionWorkspace(observed: PreparedWorkspace['observation']): ExecutionWorkspace {
  return {
    workspaceId: observed.workspace.workspaceId,
    absolutePath: observed.workspace.worktreePath,
    headSha: observed.headSha,
    baseSha: observed.baseSha,
    environmentFingerprint: SCOPE_FINGERPRINT,
    scopeFingerprint: SCOPE_FINGERPRINT,
    isolatedPorts: { application: 41_000 },
    serviceEndpoints: [],
    testAccess: { kind: 'None' },
  };
}

function prepared(
  observed: PreparedWorkspace['observation'] = observation(),
  deliveryAlreadyObserved = false,
): PreparedWorkspace {
  return { execution: executionWorkspace(observed), observation: observed, deliveryAlreadyObserved };
}

class ScriptedWorkspacePort implements WorkspacePort {
  current: PreparedWorkspace;
  /** What the workspace looks like once the attempt has written to it. */
  afterAttempt: PreparedWorkspace['observation'];
  observeCalls = 0;

  constructor(current: PreparedWorkspace = prepared(), afterAttempt?: PreparedWorkspace['observation']) {
    this.current = current;
    this.afterAttempt = afterAttempt ?? current.observation;
  }

  async prepare(): Promise<Result<PreparedWorkspace, DomainError>> {
    return ok(this.current);
  }

  /**
   * Answers with the post-attempt reading, which is what a checkpoint's inventory must be
   * written from. A checkpoint taken from the pre-attempt reading describes a worktree the
   * attempt had not yet written to, so the worker could never authorise resuming its own
   * workspace (F14-AC4, F17-AC2).
   */
  async observe(): Promise<Result<PreparedWorkspace['observation'], DomainError>> {
    this.observeCalls += 1;
    return ok(this.afterAttempt);
  }
}

class ScriptedExtensions implements OwnerExtensionPort {
  granted: OwnerExtension | null = null;

  extensionFor(): OwnerExtension | null {
    return this.granted;
  }
}

const FIXED_FACTS: CheckpointFactsPort = {
  feedbackFor: () => [{ author: 'owner', at: T0, body: 'Prefer the existing queue API over a new table.' }],
  resultsFor: () => [{ name: 'pnpm test', result: 'Passed', detail: 'ok' }],
};

function livenessPort(answer: (request: { readonly jobId: JobId; readonly holder: string; readonly lastHeartbeatAt: string }) => HolderLiveness): WorkerPorts['liveness'] {
  return { probe: (request) => answer(request) };
}

function recordingLogger(): AdapterLogger {
  return { emit: (_record: AdapterLogRecord): void => undefined };
}

/* -------------------------------------------------------------------------- */
/* Database fixture                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Creates exactly the parents a job row references.
 *
 * The schema's foreign keys are real, so a fixture that skipped one would fail on insert rather
 * than at the claim it is meant to prove.
 */
function seedParents(database: Database): void {
  database.exec('BEGIN');
  database
    .prepare('INSERT INTO owners (owner_id, display_name) VALUES (?, ?)')
    .run('00000000-0000-4000-8000-00000000f001', 'Solo owner');
  database.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(PROJECT, 'Worker fixture project');
  database
    .prepare(
      `INSERT INTO project_profile_versions (profile_version_id, project_id, version, content_json, content_fingerprint, created_by)
       VALUES (?, ?, 1, '{}', ?, ?)`,
    )
    .run(PROFILE_VERSION, PROJECT, SCOPE_FINGERPRINT, '00000000-0000-4000-8000-00000000f001');
  database
    .prepare(
      `INSERT INTO procedure_versions (procedure_version_id, project_id, version, kind, source, content_json, content_fingerprint, created_by)
       VALUES (?, ?, 1, 'Procedure', 'Owner', '{}', ?, ?)`,
    )
    .run(PROCEDURE_VERSION, PROJECT, SCOPE_FINGERPRINT, '00000000-0000-4000-8000-00000000f001');
  database
    .prepare(
      `INSERT INTO work_items (work_item_id, project_id, issue_id, publication_intent, origin, profile_version_id)
       VALUES (?, ?, ?, 'PublishWhenAgreed', 'Proposed', ?)`,
    )
    .run(WORK_ITEM, PROJECT, ISSUE, PROFILE_VERSION);
  database
    .prepare(
      `INSERT INTO scope_snapshots (scope_snapshot_id, work_item_id, project_id, issue_id, issue_identifier, title, description, acceptance_criteria, dependency_issue_ids, scope_fingerprint, retrieved_at, profile_version_id, procedure_version_id, sequence_number, captured_at, correlation_id)
       VALUES (?, ?, ?, ?, 'SHIP-1', 'Claim one job at a time', 'The worker loop must claim one job at a time.', ?, '[]', ?, ?, ?, ?, 1, ?, 'corr-worker')`,
    )
    .run(
      SNAPSHOT_ID,
      WORK_ITEM,
      PROJECT,
      ISSUE,
      JSON.stringify([{ id: 'AC1', text: 'The single coding slot is never held twice.' }]),
      SCOPE_FINGERPRINT,
      T0,
      PROFILE_VERSION,
      PROCEDURE_VERSION,
      T0,
    );
  database.exec('COMMIT');
}

/** A clock the tests move by hand, so cadence and thresholds are arithmetic rather than waiting. */
class TestClock implements AdapterClock {
  private currentMs: number;

  constructor(start: string = T0) {
    this.currentMs = Date.parse(start);
  }

  now(): string {
    return new Date(this.currentMs).toISOString();
  }

  elapsedMs(): number {
    return this.currentMs - Date.parse(T0);
  }

  advance(deltaMs: number): void {
    this.currentMs += deltaMs;
  }
}

interface Harness {
  readonly store: WorkerStore;
  readonly database: Database;
  readonly queue: JobQueue;
  readonly leases: LeaseManager;
  readonly clock: TestClock;
  readonly directory: string;
  readonly attention: AttentionItemRepository;
  readonly hold: Promise<void>;
  holding: boolean;
  release(): void;
  enqueue(overrides?: Partial<EnqueueRequest>): JobId;
  buildWorker(engine: EngineAdapter, ports?: Partial<WorkerPorts>): Worker;
}

async function withHarness(run: (harness: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-worker-'));
  const store = openWorkerStore(join(directory, 'worker.db'));
  assert.ok(store.ok, `the worker store could not be opened: ${store.ok ? '' : store.error.reason}`);
  const database = store.value.database;
  seedParents(database);

  const clock = new TestClock();
  const queue = createJobQueue({ connection: database });
  const leases = createLeaseManager({ connection: database });
  let release = (): void => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let jobCounter = 0;

  const harness: Harness = {
    store: store.value,
    database,
    queue,
    leases,
    clock,
    directory,
    attention: new AttentionItemRepository(database),
    hold,
    holding: true,
    release: (): void => {
      release();
    },
    enqueue(overrides = {}): JobId {
      jobCounter += 1;
      const jobId = `job-${String(jobCounter)}` as JobId;
      const enqueued = queue.enqueue({
        operationId: `op-${jobId}` as OperationId,
        mode: 'Build',
        workItemId: WORK_ITEM,
        scopeSnapshotId: SNAPSHOT_ID,
        projectId: PROJECT,
        profileVersionId: PROFILE_VERSION,
        procedureVersionId: PROCEDURE_VERSION,
        jobId,
        now: clock.now(),
        limits: null,
        permittedOperations: null,
        ...overrides,
      });
      assert.ok(enqueued.ok, `the job could not be enqueued: ${enqueued.ok ? '' : enqueued.error.reason}`);
      return jobId;
    },
    buildWorker(engine, ports = {}): Worker {
      const built = createWorker(
        { holder: HOLDER, projectId: null, leaseTtlMs: LEASE_TTL_MS, pollIntervalMs: 1, engineEventLimit: 64 },
        {
          clock,
          logger: recordingLogger(),
          redact: (text) => text,
          engine,
          queue: ports.queue ?? queue,
          leases,
          workItems: new WorkItemRepository(database),
          attention: new AttentionItemRepository(database),
          workspaces: ports.workspaces ?? new ScriptedWorkspacePort(),
          extensions: ports.extensions ?? new ScriptedExtensions(),
          facts: ports.facts ?? FIXED_FACTS,
          liveness: ports.liveness ?? livenessPort(() => ({ kind: 'Unknown', evidence: 'no observation available' })),
          sleep: async (): Promise<void> => {
            await Promise.resolve();
          },
        },
      );
      assert.ok(built.ok, `the worker could not be built: ${built.ok ? '' : built.error.reason}`);
      return built.value;
    },
  };

  try {
    await run(harness);
  } finally {
    harness.store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function expectOk<T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  assert.equal(result.ok, true, result.ok ? '' : `expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function limits(overrides: Partial<JobLimits> = {}): JobLimits {
  return { activeExecutionMs: 3_600_000, maxAutomatedFixPasses: 2, maxToolRetries: 3, maxAttempts: 2, ...overrides };
}

function stateOf(queue: JobQueue, jobId: JobId): AttemptState {
  const job = expectOk(queue.readJob(jobId));
  assert.ok(job !== null, `expected job ${jobId} to exist`);
  return job.state;
}

function checkpointOf(queue: JobQueue, jobId: JobId): JobCheckpoint | null {
  return expectOk(queue.readCheckpoint(jobId));
}

/** The holder recorded in the single coding slot row, read from the durable row itself. */
function slotHolder(database: Database): string | null {
  const holder = database.prepare('SELECT holder FROM coding_slots WHERE slot_id = 1').get()?.['holder'];
  return typeof holder === 'string' ? holder : null;
}

/** Writes a checkpoint as a previous holder, for the recovery cases. */
function writeCheckpointAs(queue: JobQueue, jobId: JobId, holder: string, at: string): JobCheckpoint {
  return expectOk(
    queue.checkpoint({
      jobId,
      holder,
      checkpointId: `ckpt:${jobId}:1`,
      scopeSnapshotId: SNAPSHOT_ID,
      scopeFingerprint: SCOPE_FINGERPRINT,
      profileVersionId: PROFILE_VERSION,
      procedureVersionId: PROCEDURE_VERSION,
      engineVersion: CODEX_VERIFIED_VERSION,
      workspace: observation().workspace,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      dirtyFiles: ['src/worker.ts'],
      untrackedFiles: ['src/worker.test.ts'],
      results: [{ name: 'pnpm test', result: 'Passed', detail: 'ok' }],
      feedback: [{ author: 'owner', at, body: 'keep the durable grant' }],
      blocker: null,
      nextAction: 'continue from the recorded head',
      now: at,
    }),
  );
}

/** Claims a job as a different holder, which is how the recovery cases are arranged. */
function claimAsForeignWriter(queue: JobQueue, holder: string, now: string): JobId {
  const claimed = queue.claimNext({ holder, now, leaseTtlMs: LEASE_TTL_MS, projectId: null });
  assert.ok(claimed.ok, `the job could not be claimed as ${holder}: ${claimed.ok ? '' : claimed.error.reason}`);
  return claimed.value.job.jobId;
}

/* -------------------------------------------------------------------------- */
/* Startup, reconciliation and claiming                                        */
/* -------------------------------------------------------------------------- */

test('startup: the worker opens the real migrated store, reconciles a lapsed writer and writes no job state', async () => {
  await withHarness(async (h) => {
    assert.equal(
      expectOk(currentVersion(h.database)),
      LATEST_SCHEMA_VERSION,
      'the worker store must be brought to the schema this build defines',
    );
    assert.notEqual(
      h.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get(),
      undefined,
      'the real migration creates the jobs table the queue claims from',
    );

    const jobId = h.enqueue();
    assert.equal(claimAsForeignWriter(h.queue, 'writer-that-vanished', h.clock.now()), jobId);
    const beforeState = expectOk(h.queue.readJob(jobId));
    const beforeLease = expectOk(h.leases.leaseStatus(jobId));
    assert.ok(beforeLease !== null);

    h.clock.advance(61_000);
    const engine = new ScriptedEngine({ events: [sessionStarted(T0), succeeded(T0, 'never reached')] });
    const worker = h.buildWorker(engine, {
      liveness: livenessPort(() => ({ kind: 'Unknown', evidence: 'this process holds no handle to that group' })),
    });

    const report = expectOk(await worker.reconcile());
    const finding = report.findings.find((entry) => entry.jobId === jobId);
    assert.ok(finding !== undefined, 'the lapsed holder must be reported');
    assert.equal(finding.status, 'ReclaimForbidden', 'an expired lease is not permission to take over');
    assert.equal(finding.takeoverPrepared, false);
    assert.equal(report.recoverable.length, 0, 'nothing may be taken over from a lapsed lease alone');

    const afterState = expectOk(h.queue.readJob(jobId));
    assert.equal(afterState?.state, 'Running', 'reconciliation must not move the job');
    assert.equal(afterState?.holder, 'writer-that-vanished');
    assert.equal(afterState?.updatedAt, beforeState?.updatedAt, 'reconciliation must not write a blind update');
    const afterLease = expectOk(h.leases.leaseStatus(jobId));
    assert.equal(afterLease?.state, 'Active', 'the lease keeps its state until a holder is confirmed stopped');
    assert.equal(afterLease?.confirmedStoppedBy, null);
    assert.equal(checkpointOf(h.queue, jobId), null, 'reconciliation writes no checkpoint');
    assert.equal(engine.starts.length, 0, 'reconciliation starts no coding session');
  });
});

test('F13-AC1: mode, captured scope, project, limits and permitted operations come from the stored job row', async () => {
  await withHarness(async (h) => {
    const jobId = h.enqueue({
      limits: limits({ activeExecutionMs: 900_000, maxAutomatedFixPasses: 1 }),
      permittedOperations: ['ReadScope', 'ReadRepository'],
    });
    const engine = new ScriptedEngine({ events: [sessionStarted(T0), succeeded(T0, 'done')] });

    const tick = expectOk(await h.buildWorker(engine).tick());
    assert.equal(tick.kind, 'Claimed');
    assert.equal(engine.starts.length, 1);

    const job = expectOk(h.queue.readJob(jobId));
    assert.ok(job !== null);
    assert.equal(job.state, 'Completed');
    assert.equal(job.projectId, PROJECT);
    assert.equal(job.scopeSnapshotId, SNAPSHOT_ID);
    assert.equal(job.mode, 'Build');

    const request = engine.starts[0];
    assert.ok(request !== undefined);
    assert.equal(request.operationId, job.operationId, 'the engine call carries the stored operation identity');
    assert.deepEqual(
      [...request.grantedCapabilities].sort(),
      ['Git:ReadRepository', 'Ticket:ReadScope'],
      'the engine grant is exactly the narrowed durable grant, not the whole Build mode',
    );
    assert.equal(
      request.bounds.activeWallClockMs,
      900_000,
      'the engine bound comes from the limits recorded on the row, not from the domain default',
    );
    const instruction = request.start.kind === 'Fresh' ? request.start.instruction : '';
    assert.match(instruction, /must claim one job at a time/, 'the instruction is composed from the captured scope');
    assert.match(instruction, /Acceptance criteria:/);
    assert.equal(request.mode, 'Headless');
  });
});

test('F13-AC2: while the coding slot is occupied a second job stays Queued and no second writer starts', async () => {
  await withHarness(async (h) => {
    const first = h.enqueue();
    const second = h.enqueue();
    const engine = new ScriptedEngine({
      events: [sessionStarted(T0), succeeded(T0, 'the first job finished')],
      hold: () => (h.holding ? h.hold : Promise.resolve()),
    });
    const worker = h.buildWorker(engine);

    const running = worker.tick();
    await engine.firstSession;
    assert.equal(engine.starts.length, 1, 'the first claim starts the single coding writer');

    const contended = expectOk(await worker.tick());
    assert.equal(contended.kind, 'SlotOccupied', 'an occupied coding slot must refuse a second claim');
    assert.equal(stateOf(h.queue, second), 'Queued', 'the second job stays Queued while the slot is occupied');
    assert.equal(stateOf(h.queue, first), 'Running');
    assert.equal(engine.starts.length, 1, 'no second engine session may start while the slot is held');

    h.holding = false;
    h.release();
    const finished = expectOk(await running);
    assert.equal(finished.kind, 'Claimed');
    assert.equal(stateOf(h.queue, first), 'Completed');
    assert.equal(expectOk(h.leases.leaseStatus(first))?.state, 'Released', 'finishing releases the writer lease');

    const next = expectOk(await worker.tick());
    assert.equal(next.kind, 'Claimed', 'the queued job is claimable the moment the slot is released');
    assert.equal(stateOf(h.queue, second), 'Completed');
  });
});

test('F13-AC3: every capability is decided by the domain grant, so a Build job is never given merge or release', async () => {
  await withHarness(async (h) => {
    const jobId = h.enqueue();
    const engine = new ScriptedEngine({ events: [sessionStarted(T0), succeeded(T0, 'done')] });
    expectOk(await h.buildWorker(engine).tick());

    const job = expectOk(h.queue.readJob(jobId));
    assert.ok(job !== null);
    const grant = resolveGrantForJob(job);

    for (const kind of PRIVILEGED_CAPABILITY_KINDS) {
      assert.ok(
          (grant.granted as readonly CapabilityKind[]).every((capability) => capability !== kind),
        `${kind} must never reach a coding session`,
      );
      const denial = grant.deliveryRefusals.find((entry) => entry.capability === kind);
      assert.ok(denial !== undefined, `${kind} must be refused rather than left unused`);
      assert.equal(denial.reason, 'DeliveryRequiresOwnerAuthorization');
    }

    const request = engine.starts[0];
    assert.ok(request !== undefined);
    for (const kind of PRIVILEGED_CAPABILITY_KINDS) {
      assert.ok(
        !(request.grantedCapabilities as readonly CapabilityKind[]).includes(kind),
        'the engine request carries no delivery capability at all',
      );
    }

    const refused = h.queue.permittedOperation(job, 'Merge');
    assert.equal(refused.ok, false, 'the durable grant itself refuses merge for a coding job');
    assert.equal(refused.ok ? '' : refused.error.code, 'Forbidden');
  });
});

test('F13-AC5: a recorded provider event never starts coding; only a recorded owner start does', async () => {
  await withHarness(async (h) => {
    const inbox = createInboxStore({ connection: h.database, now: () => h.clock.now() });
    const recorded = inbox.recordEvent({
      deliveryId: 'delivery-worker-1',
      signatureValid: true,
      rawPayloadBytes: new TextEncoder().encode(JSON.stringify({ type: 'IssueUpdated', data: { id: ISSUE } })),
      provider: 'linear',
      type: 'IssueUpdated',
      occurredAt: T0,
      correlationId: ISSUE,
    });
    assert.ok(recorded.ok, 'the provider event is durably recorded');

    const engine = new ScriptedEngine({ events: [sessionStarted(T0), succeeded(T0, 'done')] });
    const worker = h.buildWorker(engine);

    const afterEvent = expectOk(await worker.tick());
    assert.equal(afterEvent.kind, 'Idle', 'a provider event must leave the queue empty');
    assert.equal(engine.starts.length, 0, 'no coding session may start from an inbox event');
    assert.equal(expectOk(h.queue.listJobs({ states: null, projectId: null })).length, 0);

    h.enqueue();
    const afterOwnerStart = expectOk(await worker.tick());
    assert.equal(afterOwnerStart.kind, 'Claimed', 'the recorded owner start is what dispatches work');
    assert.equal(engine.starts.length, 1);
  });
});

test('F17-AC5, F15: the heartbeat renews on the 15s cadence, and silence past 60s begins reconciliation instead of a second writer', async () => {
  await withHarness(async (h) => {
    const renewals: string[] = [];
    const realQueue = h.queue;
    const counted: JobQueue = {
      ...realQueue,
      heartbeat: (request) => {
        renewals.push(request.now);
        return realQueue.heartbeat(request);
      },
    };
    const jobId = h.enqueue();

    const stepping = new ScriptedEngine({
      events: [
        sessionStarted(T0),
        progress(T0, 'Implementing'),
        progress(T0, 'Implementing'),
        progress(T0, 'RunningChecks'),
        progress(T0, 'RunningChecks'),
        progress(T0, 'RunningChecks'),
        progress(T0, 'RunningChecks'),
        succeeded(T0, 'done'),
      ],
      advance: (): void => {
        h.clock.advance(5_000);
      },
    });
    const worker = h.buildWorker(stepping, { queue: counted });
    expectOk(await worker.tick());
    assert.equal(renewals.length, 2, `two renewals are due across 40s of silence, got ${String(renewals.length)}`);
    assert.deepEqual(
      renewals,
      [new Date(Date.parse(T0) + 15_000).toISOString(), new Date(Date.parse(T0) + 30_000).toISOString()],
      'renewal happens on the 15s cadence, not on every event',
    );
    assert.equal(expectOk(h.queue.readJob(jobId))?.state, 'Completed');

    const second = h.enqueue();
    assert.equal(claimAsForeignWriter(h.queue, 'silent-writer', h.clock.now()), second);
    const observer = h.buildWorker(new ScriptedEngine({ events: [] }));
    h.clock.advance(61_000);

    const report = expectOk(await observer.reconcile());
    const finding = report.findings.find((entry) => entry.jobId === second);
    assert.ok(finding !== undefined, 'the silent holder must be reported');
    assert.equal(finding.status, 'ReclaimForbidden', 'an expired lease is not permission to take over');
    assert.equal(finding.takeoverPrepared, false);
    assert.equal(stateOf(h.queue, second), 'Running', 'the silent writer keeps the job it holds');
  });
});

test('F17-AC5: an expired lease alone does not authorise a second writer, and the worker refuses to claim until the holder is confirmed stopped', async () => {
  await withHarness(async (h) => {
    const jobId = h.enqueue();
    assert.equal(claimAsForeignWriter(h.queue, 'writer-that-vanished', h.clock.now()), jobId);
    h.clock.advance(61_000);

    const engine = new ScriptedEngine({ events: [sessionStarted(T0), succeeded(T0, 'should not run')] });
    const refusing = h.buildWorker(engine, {
      liveness: livenessPort(() => ({ kind: 'Unknown', evidence: 'this process holds no handle to that group' })),
    });

    const firstTick = expectOk(await refusing.tick());
    assert.equal(firstTick.kind, 'SlotOccupied', 'the worker must not claim while the coding slot is unreconciled');
    assert.equal(engine.starts.length, 0, 'no second coding writer may start');
    assert.equal(stateOf(h.queue, jobId), 'Running');
    const unconfirmed = expectOk(h.leases.leaseStatus(jobId));
    assert.equal(unconfirmed?.state, 'Active');
    assert.equal(unconfirmed?.confirmedStoppedBy, null, 'an expired lease is never evidence of a stopped process');

    const confirming = h.buildWorker(new ScriptedEngine({ events: [sessionStarted(T0), succeeded(T0, 'recovered')] }), {
      liveness: livenessPort(() => ({ kind: 'Stopped', evidence: 'an operator reported process group 4242 is gone' })),
    });
    const secondTick = expectOk(await confirming.tick());
    assert.equal(secondTick.kind, 'Claimed', 'the job may be driven once the holder is confirmed stopped');
    const confirmed = expectOk(h.leases.leaseStatus(jobId));
    assert.equal(confirmed?.state, 'Released');
    assert.equal(confirmed?.confirmedStoppedBy, HOLDER, 'the confirmation is attributed to a named observer');
    assert.match(confirmed?.confirmedStoppedEvidence ?? '', /process group 4242 is gone/);
    assert.equal(stateOf(h.queue, jobId), 'Completed');
  });
});

/* -------------------------------------------------------------------------- */
/* Stop and checkpoint                                                         */
/* -------------------------------------------------------------------------- */

test('F17-AC1: a stop is graceful first, and the bounded kill reaches only the tracked process group', async () => {
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore', detached: true });
  const spawned: { engine: ScriptedEngine | null } = { engine: null };
  try {
    await withHarness(async (h) => {
      const engine = new ScriptedEngine({
        events: [sessionStarted(T0)],
        hold: () => h.hold,
        spawnGroup: () =>
        spawn(process.execPath, ['-e', "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)"], {
          cwd: h.directory,
          detached: true,
          stdio: 'ignore',
        }),
      });
      spawned.engine = engine;
      const worker = h.buildWorker(engine);
      const jobId = h.enqueue();

      const running = worker.tick();
      await engine.firstSession;
      await waitFor(() => engine.tracked !== null, 10_000);
      const trackedGroupId = engine.tracked?.pid;
      assert.ok(trackedGroupId !== undefined, 'the session spawned a real tracked process group');
      worker.requestStop();
      h.release();
      const tick = expectOk(await running);

      assert.equal(tick.kind, 'Claimed');
      assert.equal(tick.outcome.kind, 'Stopped', `the attempt must stop, got ${JSON.stringify(tick.outcome)}`);
      assert.deepEqual(
        engine.stops.map((stop) => stop.reason),
        ['PauseRequested'],
        'the stop is requested gracefully, with a reason',
      );

      const groupId = trackedGroupId;
      assert.ok(groupId !== undefined, 'a tracked group must have a process id');
      assert.throws(() => process.kill(-groupId, 0), /ESRCH/, 'the tracked group must be gone');
      assert.doesNotThrow(
        () => {
          if (bystander.pid === undefined) throw new Error('the bystander was never started');
          process.kill(bystander.pid, 0);
        },
        'a process this worker did not spawn must survive the bounded kill',
      );

      assert.equal(stateOf(h.queue, jobId), 'Paused', 'Paused is reported only after the writer stopped');
      assert.equal(expectOk(h.leases.leaseStatus(jobId))?.state, 'Released', 'a paused writer gives the coding slot up');
    });
  } finally {
    for (const pid of [bystander.pid, spawned.engine?.tracked?.pid ?? null]) {
      if (pid === undefined || pid === null) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* the process is already gone */
      }
    }
  }
});

test('F17-AC1: a writer that may still be writing is never reported Paused, and is recorded for reconciliation', async () => {
  await withHarness(async (h) => {
    const engine = new ScriptedEngine({
      events: [sessionStarted(T0)],
      hold: () => h.hold,
      stopOutcome: { kind: 'Detached', detail: 'the group survived the bounded kill', reconcileRequired: true },
    });
    const worker = h.buildWorker(engine);
    const jobId = h.enqueue();

    const running = worker.tick();
    await engine.firstSession;
    worker.requestStop();
    h.release();
    const tick = expectOk(await running);

    assert.equal(tick.kind, 'Claimed');
    assert.equal(tick.outcome.kind, 'WriterDetached');
    assert.equal(stateOf(h.queue, jobId), 'Running', 'a detached writer keeps the job, so no second writer can take it');
    assert.equal(expectOk(h.leases.leaseStatus(jobId))?.state, 'Active', 'the coding slot stays with the writer');
    assert.ok(
      expectOk(h.attention.list('Open')).some((item) => item.dedupKey === `WorkerStopped:${jobId}`),
      'the detached writer must be visible to the owner',
    );
  });
});

test('F17-AC2: a stop persists scope, versions, workspace, full code identity, inventory, results, feedback, blocker and next action', async () => {
  await withHarness(async (h) => {
    const engine = new ScriptedEngine({ events: [sessionStarted(T0)], hold: () => h.hold });
    const worker = h.buildWorker(engine);
    const jobId = h.enqueue();

    const running = worker.tick();
    await engine.firstSession;
    worker.requestStop();
    h.release();
    expectOk(await running);

    const checkpoint = checkpointOf(h.queue, jobId);
    assert.ok(checkpoint !== null, 'a stop must leave a durable resume point');
    const job = expectOk(h.queue.readJob(jobId));
    assert.ok(job !== null);

    assert.equal(checkpoint.scopeSnapshotId, SNAPSHOT_ID);
    assert.equal(checkpoint.profileVersionId, PROFILE_VERSION);
    assert.equal(checkpoint.procedureVersionId, PROCEDURE_VERSION);
    assert.equal(checkpoint.scopeFingerprint, SCOPE_FINGERPRINT);
    assert.equal(checkpoint.workspace.workspaceId, 'ws-worker');
    assert.equal(checkpoint.workspace.branchName, 'shiploop/worker-test');
    assert.equal(checkpoint.workspace.worktreePath, WORKSPACE_PATH);
    assert.match(checkpoint.headSha, /^[0-9a-f]{40}$/, 'code identity is stored as a full SHA, never an abbreviation');
    assert.match(checkpoint.baseSha, /^[0-9a-f]{40}$/);
    assert.equal(checkpoint.headSha, HEAD_SHA);
    assert.deepEqual([...checkpoint.dirtyFiles], ['src/worker.ts']);
    assert.deepEqual([...checkpoint.untrackedFiles], ['src/worker.test.ts'], 'untracked work must survive the stop');
    assert.deepEqual(
      checkpoint.results.map((entry) => `${entry.name}=${entry.result}`),
      ['pnpm test=Passed'],
    );
    assert.equal(checkpoint.feedback[0]?.author, 'owner');
    assert.match(checkpoint.blocker ?? '', /owner asked for this attempt to stop/);
    assert.match(checkpoint.nextAction, /Resume from the recorded checkpoint/);
    assert.equal(checkpoint.recordedAt, h.clock.now());
  });
});

test('F17-AC3: a resume checks the actual workspace and live external state before continuing', async () => {
  await withHarness(async (h) => {
    const movedJob = h.enqueue();
    assert.equal(claimAsForeignWriter(h.queue, 'interrupted-writer', h.clock.now()), movedJob);
    writeCheckpointAs(h.queue, movedJob, 'interrupted-writer', T0);
    h.clock.advance(61_000);

    const diverged = new ScriptedEngine({ events: [sessionStarted(T0), succeeded(T0, 'should not run')] });
    const movedWorker = h.buildWorker(diverged, {
      workspaces: new ScriptedWorkspacePort(prepared(observation({ headSha: MOVED_HEAD_SHA }))),
      liveness: livenessPort(() => ({ kind: 'Stopped', evidence: 'the previous group is gone' })),
    });
    const movedTick = expectOk(await movedWorker.tick());
    assert.equal(movedTick.kind, 'Claimed');
    assert.equal(movedTick.outcome.kind, 'Blocked', 'a workspace that no longer matches the checkpoint must not be written over');
    assert.equal(diverged.starts.length, 0, 'no engine session may start before the workspace is reconciled');
    assert.match(
      movedTick.outcome.kind === 'Blocked' ? movedTick.outcome.failure.observed.error : '',
      /head moved from/,
    );
    assert.equal(stateOf(h.queue, movedJob), 'Blocked');

    assert.equal(
      assessResume(checkpointOf(h.queue, movedJob) ?? recoveredCheckpoint(), prepared(observation())).kind,
      'Continue',
      'an unchanged workspace lets a recovered attempt continue',
    );
    assert.equal(
      assessResume(recoveredCheckpoint(), prepared(observation({ headSha: MOVED_HEAD_SHA }))).kind,
      'Reconcile',
      'a workspace whose head moved is reported rather than written over',
    );
    const lostUntracked = assessResume(recoveredCheckpoint(), prepared(observation({ untrackedFiles: [] })));
    assert.equal(lostUntracked.kind, 'Reconcile', 'a lost untracked file is a difference, not a rounding detail');
    assert.match(
      lostUntracked.kind === 'Reconcile' ? lostUntracked.reason : '',
      /the set of untracked files changed/,
    );
    const otherWorkspace = assessResume(
      recoveredCheckpoint(),
      prepared(
        observation({
          workspace: { workspaceId: 'ws-elsewhere', branchName: 'shiploop/elsewhere', worktreePath: '/tmp/shiploop-elsewhere' },
        }),
      ),
    );
    assert.equal(
      otherWorkspace.kind,
      'Reconcile',
      'a resume must run in the workspace its checkpoint names, whatever else matches',
    );
    assert.match(otherWorkspace.kind === 'Reconcile' ? otherWorkspace.reason : '', /the workspace moved from/);
  });

  await withHarness(async (h) => {
    const deliveredJob = h.enqueue();
    assert.equal(claimAsForeignWriter(h.queue, 'interrupted-writer', h.clock.now()), deliveredJob);
    writeCheckpointAs(h.queue, deliveredJob, 'interrupted-writer', h.clock.now());
    h.clock.advance(61_000);

    const delivered = new ScriptedEngine({ events: [sessionStarted(T0), succeeded(T0, 'should not run')] });
    const deliveredWorker = h.buildWorker(delivered, {
      workspaces: new ScriptedWorkspacePort(prepared(observation(), true)),
      liveness: livenessPort(() => ({ kind: 'Stopped', evidence: 'the previous group is gone' })),
    });
    const deliveredTick = expectOk(await deliveredWorker.tick());
    assert.equal(deliveredTick.kind, 'Claimed');
    assert.equal(deliveredTick.outcome.kind, 'Blocked');
    assert.equal(delivered.starts.length, 0, 'a delivery already visible externally must not be repeated');
    assert.match(
      deliveredTick.outcome.kind === 'Blocked' ? deliveredTick.outcome.failure.observed.error : '',
      /already shows the delivery/,
    );
    assert.equal(
      assessResume(checkpointOf(h.queue, deliveredJob) ?? recoveredCheckpoint(), prepared(observation())).kind,
      'Continue',
      'an unchanged workspace whose delivery was already observed is a different finding',
    );
  });
});

/** A checkpoint matching the fixture workspace, for the pure resume rule. */
function recoveredCheckpoint(): JobCheckpoint {
  return {
    jobId: 'job-fixture' as JobId,
    checkpointId: 'ckpt:job-fixture:1',
    scopeSnapshotId: SNAPSHOT_ID,
    scopeFingerprint: SCOPE_FINGERPRINT,
    profileVersionId: PROFILE_VERSION,
    procedureVersionId: PROCEDURE_VERSION,
    engineVersion: CODEX_VERIFIED_VERSION,
    workspace: observation().workspace,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    dirtyFiles: ['src/worker.ts'],
    untrackedFiles: ['src/worker.test.ts'],
    results: [],
    feedback: [],
    blocker: null,
    nextAction: 'continue',
    recordedAt: T0,
  };
}

/* -------------------------------------------------------------------------- */
/* Bounded attempts and failure diagnosis                                      */
/* -------------------------------------------------------------------------- */

test('F18-AC1: a failure records stage, observed error, category, attempted remedy and a recommended next action', async () => {
  await withHarness(async (h) => {
    const jobId = h.enqueue({ limits: limits({ maxAutomatedFixPasses: 0 }) });
    const engine = new ScriptedEngine({ events: [sessionStarted(T0), diagnosticToolError(T0), failedOutcome(T0)] });

    const tick = expectOk(await h.buildWorker(engine).tick());
    assert.equal(tick.kind, 'Claimed');
    assert.equal(tick.outcome.kind, 'Failed');
    const failure = tick.outcome.kind === 'Failed' ? tick.outcome.failure : null;
    assert.ok(failure !== null);
    assert.equal(failure.stage, 'EngineExecution');
    assert.equal(failure.category, 'EngineUnavailable');
    assert.equal(failure.observed.error, 'the check command exited 2');
    assert.match(failure.attemptedRemedy ?? '', /reported this operation as retryable/);
    assert.match(failure.recommendedNextAction, /Confirm the execution engine is reachable/);

    assert.equal(stateOf(h.queue, jobId), 'Blocked');
    const checkpoint = checkpointOf(h.queue, jobId);
    assert.ok(checkpoint !== null, 'the failure leaves a durable resume point');
    assert.equal(checkpoint.blocker, failure.recommendedNextAction);
    const blocker = expectOk(h.attention.list('Open')).find((item) => item.dedupKey === `Blocker:${jobId}`);
    assert.ok(blocker !== undefined, 'the failure is visible to the owner');
    assert.match(blocker.title, /blocked at EngineExecution/);
    assert.match(blocker.blocker ?? '', /EngineUnavailable/);
    assert.equal(blocker.nextAction, failure.recommendedNextAction);
  });
});

test('F18-AC2: reaching a limit checkpoints the work and waits for an owner extension', async () => {
  await withHarness(async (h) => {
    const jobId = h.enqueue({ limits: limits({ activeExecutionMs: 60_000, maxAutomatedFixPasses: 2 }) });
    const engine = new ScriptedEngine({
      events: [sessionStarted(T0), succeeded(T0, 'the engine kept going')],
      advance: (): void => {
        h.clock.advance(90_000);
      },
    });

    const tick = expectOk(await h.buildWorker(engine).tick());
    assert.equal(tick.kind, 'Claimed');
    assert.equal(tick.outcome.kind, 'WaitingForOwner');
    const evaluation = tick.outcome.kind === 'WaitingForOwner' ? tick.outcome.limits : null;
    assert.ok(evaluation !== null);
    assert.deepEqual([...evaluation.reached], ['ActiveExecutionTime']);
    assert.equal(evaluation.ownerExtensionRequired, true);
    assert.equal(evaluation.activeMs, 90_000, 'active execution is measured from the injected clock');
    assert.equal(evaluation.fixPasses, 0);

    assert.equal(stateOf(h.queue, jobId), 'WaitingForOwner', 'a reached limit waits instead of continuing');
    const checkpoint = checkpointOf(h.queue, jobId);
    assert.ok(checkpoint !== null, 'the work is checkpointed before the attempt waits');
    assert.match(checkpoint.blocker ?? '', /Active execution reached 60000ms excluding owner waits/);
    assert.match(checkpoint.nextAction, /Wait for an owner extension/);
    assert.ok(
      expectOk(h.attention.list('Open')).some((item) => item.dedupKey === `owner-extension:${jobId}`),
      'the owner is told the attempt is waiting for an extension',
    );
  });
});

test('F18-AC3: a required owner wait consumes no active execution time', async () => {
  await withHarness(async (h) => {
    const jobId = h.enqueue({ limits: limits({ activeExecutionMs: 60_000, maxAutomatedFixPasses: 2 }) });
    const slow = new ScriptedEngine({
      events: [sessionStarted(T0), succeeded(T0, 'the first pass')],
      advance: (): void => {
        h.clock.advance(90_000);
      },
    });
    const first = expectOk(await h.buildWorker(slow).tick());
    assert.equal(first.kind, 'Claimed');
    assert.equal(first.outcome.kind, 'WaitingForOwner');

    const OWNER_THINK_MS = 30 * 60 * 1000;
    h.clock.advance(OWNER_THINK_MS);
    const extensions = new ScriptedExtensions();
    extensions.granted = {
      grantedBy: 'owner',
      grantedAt: h.clock.now(),
      additionalActiveMs: OWNER_THINK_MS,
      additionalFixPasses: 1,
    };
    const continued = new ScriptedEngine({
      events: [sessionStarted(h.clock.now()), succeeded(h.clock.now(), 'after the extension')],
    });

    const second = expectOk(await h.buildWorker(continued, { extensions }).tick());
    assert.equal(second.kind, 'Claimed');
    assert.equal(
      second.outcome.kind,
      'Completed',
      `the owner's think time must not be charged to the execution budget, got ${JSON.stringify(second.outcome)}`,
    );
    assert.equal(stateOf(h.queue, jobId), 'Completed');
    assert.equal(continued.starts.length, 1, 'the extension continues the same attempt rather than re-running it');
    assert.equal(
      continued.starts[0]?.start.kind,
      'FromCheckpoint',
      'the continued attempt is seeded from the recorded checkpoint',
    );
  });
});

test('F18-AC4: usage is reported when the engine reported it, and Unknown when it did not', async () => {
  await withHarness(async (h) => {
    const reportedJob = h.enqueue();
    const reporting = new ScriptedEngine({
      events: [sessionStarted(T0), usageReported(T0, 1_200, 300), succeeded(T0, 'done')],
    });
    const first = expectOk(await h.buildWorker(reporting).tick());
    assert.equal(first.kind, 'Claimed');
    assert.equal(first.outcome.kind, 'Completed');
    const usage = first.outcome.kind === 'Completed' ? first.outcome.usage : null;
    assert.ok(usage !== null);
    assert.equal(usage.availability, 'Reported');
    assert.equal(usage.source, 'EngineReported');
    assert.equal(usage.totalTokens, 1_500);
    assert.equal(usage.remainingQuota, 'Unknown', 'remaining quota has no verified source and stays Unknown');
    assert.equal(usage.cost, 'Unknown', 'a cost is never invented from a token count');
    assert.equal(stateOf(h.queue, reportedJob), 'Completed');

    const silentJob = h.enqueue();
    const silent = new ScriptedEngine({ events: [sessionStarted(T0), succeeded(T0, 'done')] });
    const second = expectOk(await h.buildWorker(silent).tick());
    assert.equal(second.kind, 'Claimed');
    assert.equal(second.outcome.kind, 'Completed');
    const unknown = second.outcome.kind === 'Completed' ? second.outcome.usage : null;
    assert.ok(unknown !== null);
    assert.equal(unknown.availability, 'Unknown');
    assert.equal(unknown.source, 'Absent');
    assert.equal(unknown.totalTokens, 'Unknown');
    assert.equal(stateOf(h.queue, silentJob), 'Completed');
  });
});

test('F18-AC5: a deterministic authentication failure is not dispatched a second time', async () => {
  await withHarness(async (h) => {
    const jobId = h.enqueue({ limits: limits({ maxAutomatedFixPasses: 2 }) });
    const engine = new ScriptedEngine({ events: [sessionStarted(T0), blockedByAuthentication(T0)] });

    const tick = expectOk(await h.buildWorker(engine).tick());
    assert.equal(tick.kind, 'Claimed');
    assert.equal(tick.outcome.kind, 'Blocked');
    const failure = tick.outcome.kind === 'Blocked' ? tick.outcome.failure : null;
    assert.ok(failure !== null);
    assert.equal(failure.category, 'DeterministicAuth');
    assert.equal(failure.retryable, false, 'a missing credential fails identically on every pass');
    assert.equal(failure.requiresOwnerAction, true);
    assert.deepEqual([...failure.prohibitedRemedies], ['RetryIdentically']);
    assert.match(failure.recommendedNextAction, /Supply valid credentials/);

    assert.equal(engine.starts.length, 1, 'a deterministic failure must not spend another fix pass');
    assert.equal(stateOf(h.queue, jobId), 'Blocked');
    assert.equal(
      checkpointOf(h.queue, jobId)?.blocker,
      failure.recommendedNextAction,
      'the work is preserved with the action the owner has to take',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The five defects the first real coding run found                             */
/* -------------------------------------------------------------------------- */

/** The untracked file an attempt is taken to have written into the fixture worktree. */
const ATTEMPT_FILE = 'src/worker/attempt-notes.ts';

test('defect 1: the checkpoint lists the file the attempt created, read after the work settled', async () => {
  await withHarness(async (h) => {
    const port = new ScriptedWorkspacePort(prepared(), observation({ untrackedFiles: [ATTEMPT_FILE] }));
    const engine = new ScriptedEngine({ events: [sessionStarted(T0)], hold: () => h.hold });
    const worker = h.buildWorker(engine, { workspaces: port });
    const jobId = h.enqueue();

    const running = worker.tick();
    await engine.firstSession;
    worker.requestStop();
    h.release();
    expectOk(await running);

    assert.equal(
      port.observeCalls,
      1,
      'the checkpoint is written from a re-read of the workspace, not from the reading taken before the attempt',
    );
    const checkpoint = checkpointOf(h.queue, jobId);
    assert.ok(checkpoint !== null, 'a stop leaves a durable resume point');
    assert.deepEqual(
      [...checkpoint.untrackedFiles],
      [ATTEMPT_FILE],
      'the resume point describes the worktree the engine actually left behind',
    );
    assert.deepEqual([...checkpoint.dirtyFiles], ['src/worker.ts']);
    assert.equal(
      prepared().observation.untrackedFiles.includes(ATTEMPT_FILE),
      false,
      'the pre-attempt reading is not what the checkpoint may be built from, or this assertion proves nothing',
    );
  });
});

test('defect 2: a deterministic reconciliation refusal reaches a terminal state instead of repeating every tick', async () => {
  await withHarness(async (h) => {
    const jobId = h.enqueue();
    assert.equal(claimAsForeignWriter(h.queue, 'writer-that-vanished', h.clock.now()), jobId);
    writeCheckpointAs(h.queue, jobId, 'writer-that-vanished', h.clock.now());
    h.clock.advance(61_000);

    // The workspace provider refuses the same thing on every tick, as a stale worktree lock does.
    const refusing: WorkspacePort = {
      prepare: async () =>
        err(
          blocked(`Workspace ws-worker cannot be reused by ${HOLDER}: the workspace lock names another owner.`, [
            { name: 'WorkspaceLocked', detail: 'The workspace lock names a different owner.', remedy: 'Release it or reconcile it.' },
          ]),
        ),
    };
    const engine = new ScriptedEngine({ events: [sessionStarted(T0), succeeded(T0, 'must not run')] });
    const worker = h.buildWorker(engine, {
      workspaces: refusing,
      liveness: livenessPort(() => ({ kind: 'Stopped', evidence: 'the previous group is gone' })),
    });

    const first = expectOk(await worker.tick());
    assert.equal(first.kind, 'Claimed');
    assert.equal(first.outcome.kind, 'Blocked', `the refusal must reach a terminal state, got ${JSON.stringify(first.outcome)}`);
    const failure = first.outcome.kind === 'Blocked' ? first.outcome.failure : null;
    assert.ok(failure !== null);
    assert.equal(failure.stage, 'Reconciliation');
    assert.equal(failure.category, 'DeterministicAuth', 'a scope or authentication refusal repeats identically');
    assert.equal(failure.retryable, false);
    assert.equal(engine.starts.length, 0, 'a refused reconciliation starts no coding session');
    assert.equal(stateOf(h.queue, jobId), 'Blocked', 'Blocked is not a state the loop tries again');
    const blocker = expectOk(h.attention.list('Open')).find((item) => item.dedupKey === `Blocker:${jobId}`);
    assert.ok(blocker !== undefined, 'the owner is told the refusal rather than finding it in a log');
    assert.match(blocker.blocker ?? '', /DeterministicAuth/);
    assert.match(blocker.nextAction, /Supply valid credentials|workspace|credential/i);

    const second = expectOk(await worker.tick());
    assert.equal(second.kind, 'Idle', `a terminal refusal must not be claimed again, got ${JSON.stringify(second)}`);
    assert.equal(engine.starts.length, 0);
    assert.equal(stateOf(h.queue, jobId), 'Blocked');
  });
});

test('defect 3: Blocked and WaitingForOwner both give up the coding slot, so the next job is claimable', async () => {
  await withHarness(async (h) => {
    const waiting = h.enqueue({ limits: limits({ activeExecutionMs: 60_000 }) });
    const queued = h.enqueue();
    const reaching = new ScriptedEngine({
      events: [sessionStarted(T0), succeeded(T0, 'the engine kept going')],
      advance: (): void => {
        h.clock.advance(90_000);
      },
    });

    const tick = expectOk(await h.buildWorker(reaching).tick());
    assert.equal(tick.kind, 'Claimed');
    assert.equal(tick.kind === 'Claimed' ? tick.outcome.kind : null, 'WaitingForOwner');
    assert.equal(stateOf(h.queue, waiting), 'WaitingForOwner');
    assert.equal(expectOk(h.leases.leaseStatus(waiting))?.state, 'Released', 'a waiting attempt is not writing');
    assert.equal(slotHolder(h.database), null, 'the coding slot is given up while the owner decides');
    assert.equal(
      expectOk(h.queue.claimNext({ holder: 'next-writer', now: h.clock.now(), leaseTtlMs: LEASE_TTL_MS, projectId: null })).job
        .jobId,
      queued,
      'the job queued behind it is claimable the moment the slot is released',
    );
  });

  await withHarness(async (h) => {
    const blocked = h.enqueue();
    const queued = h.enqueue();
    const engine = new ScriptedEngine({ events: [sessionStarted(T0), blockedByAuthentication(T0)] });

    const tick = expectOk(await h.buildWorker(engine).tick());
    assert.equal(tick.kind, 'Claimed');
    assert.equal(tick.kind === 'Claimed' ? tick.outcome.kind : null, 'Blocked');
    assert.equal(stateOf(h.queue, blocked), 'Blocked');
    assert.equal(expectOk(h.leases.leaseStatus(blocked))?.state, 'Released', 'a blocked attempt is not writing');
    assert.equal(slotHolder(h.database), null, 'one blocked job must not hold every later job in the project');
    assert.equal(
      expectOk(h.queue.claimNext({ holder: 'next-writer', now: h.clock.now(), leaseTtlMs: LEASE_TTL_MS, projectId: null })).job
        .jobId,
      queued,
      'the next job is claimable while the blocked one waits for an owner',
    );
  });
});

test('defect 4: an expired lease whose holder is still writing authorises no takeover until it is confirmed stopped', async () => {
  await withHarness(async (h) => {
    const jobId = h.enqueue();
    assert.equal(claimAsForeignWriter(h.queue, 'writer-that-vanished', h.clock.now()), jobId);
    h.clock.advance(61_000);

    let liveness: HolderLiveness = {
      kind: 'StillWriting',
      evidence: 'process group 4242 is still running and its worktree is still changing',
    };
    const engine = new ScriptedEngine({ events: [sessionStarted(T0), succeeded(T0, 'must not run')] });
    const refusing = h.buildWorker(engine, { liveness: livenessPort(() => liveness) });

    const refused = expectOk(await refusing.tick());
    assert.equal(refused.kind, 'SlotOccupied', 'an expired lease is not evidence that the writer is gone');
    assert.equal(engine.starts.length, 0, 'no second coding writer may start while the first may still be writing');
    assert.equal(stateOf(h.queue, jobId), 'Running', 'the live writer keeps its job');
    assert.equal(slotHolder(h.database), 'writer-that-vanished', 'the coding slot stays with the writer that may be alive');
    const unconfirmed = expectOk(h.leases.leaseStatus(jobId));
    assert.equal(unconfirmed?.state, 'Active');
    assert.equal(unconfirmed?.confirmedStoppedBy, null);
    const reconciled = expectOk(await refusing.reconcile());
    assert.ok(
      reconciled.findings.some((finding) => finding.status !== 'Vacant'),
      'the silence is reported for reconciliation rather than resolved',
    );

    liveness = { kind: 'Stopped', evidence: 'process group 4242 was observed gone' };
    const recovered = expectOk(await refusing.tick());
    assert.equal(recovered.kind, 'Claimed', 'only a recorded stop hands the job over');
    const confirmed = expectOk(h.leases.leaseStatus(jobId));
    assert.equal(confirmed?.confirmedStoppedBy, HOLDER);
    assert.equal(stateOf(h.queue, jobId), 'Completed');
    assert.equal(slotHolder(h.database), null, 'the completed job gave the slot back');
  });

  await withHarness(async (h) => {
    // The storage rule behind the fix: re-taking a lease is only ever the same holder taking back
    // one it gave up. An `Active` term that merely lapsed is not reissued, because a fresh term
    // would be a second writer on the strength of evidence that proved only silence (F17-AC5).
    const jobId = h.enqueue();
    assert.equal(claimAsForeignWriter(h.queue, 'writer-that-vanished', h.clock.now()), jobId);
    const lapsed = expectOk(h.leases.leaseStatus(jobId));
    const held = expectOk(h.queue.readJob(jobId));
    assert.ok(lapsed !== null && held !== null);
    h.clock.advance(61_000);

    const sameHolder = expectOk(
      h.leases.reclaimLease({
        leaseId: `lease:${jobId}`,
        jobId,
        holder: 'writer-that-vanished',
        operationId: held.operationId,
        now: h.clock.now(),
        leaseTtlMs: LEASE_TTL_MS,
      }),
    );
    assert.equal(sameHolder.granted, true, 'a holder may continue its own job');
    assert.equal(sameHolder.lease.leaseId, lapsed.leaseId, 'on the term it already held, not a second one');
    assert.equal(sameHolder.lease.acquiredAt, lapsed.acquiredAt);

    const otherHolder = expectOk(
      h.leases.reclaimLease({
        leaseId: `lease:${jobId}`,
        jobId,
        holder: 'second-writer',
        operationId: ('op-second' as OperationId),
        now: h.clock.now(),
        leaseTtlMs: LEASE_TTL_MS,
      }),
    );
    assert.equal(otherHolder.granted, false, 'an expired lease authorises no other holder');
    assert.equal(otherHolder.reconciliationRequired, true);
    assert.equal(slotHolder(h.database), 'writer-that-vanished', 'the coding slot is still the lapsed holder\u2019s to give up');
  });
});

test('defect 5: a SIGTERM-ignoring engine child still produces a bounded stop and a written checkpoint', async () => {
  await withHarness(async (h) => {
    /*
     * The stop poll has to hold the event loop while it decides, and the only way to see that is a
     * process in which nothing else does: this probe holds nothing but the adapter's own timer. A
     * group that never reports itself empty keeps the poll running to its deadline, so an
     * unreferenced sleep ends the probe with `Detected unsettled top-level await` and exit 13
     * instead of reporting what it observed (F17-AC1, F17-AC2).
     */
    const probe = join(h.directory, 'stop-probe.mjs');
    await writeFile(
      probe,
      [
        `import { stopCodexProcess } from ${JSON.stringify(
          new URL('../../../packages/adapters/src/codex/index.ts', import.meta.url).pathname,
        )};`,
        'const target = {',
        '  pid: process.pid,',
        '  processGroupId: process.pid,',
        '  argv: [],',
        '  cwd: process.cwd(),',
        '  async *lines() {},',
        "  stderrTail: () => '',",
        '  waited: () => new Promise(() => {}),',
        '  requestGracefulStop: () => {},',
        '  killProcessGroup: () => {},',
        '  groupHasSurvivors: () => true,',
        '  dispose: () => {},',
        '};',
        'const startedAt = Date.now();',
        'const report = await stopCodexProcess(target, { gracefulStopMs: 50, killWaitMs: 400 });',
        "process.stdout.write(JSON.stringify({ ...report, elapsedMs: Date.now() - startedAt }) + '\\n');",
      ].join('\n'),
    );
    const probed = await new Promise<{ readonly code: number | null; readonly output: string }>((resolve) => {
      const child = spawn(process.execPath, [probe], { cwd: h.directory, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.on('close', (code) => resolve({ code, output }));
    });
    assert.equal(
      probed.code,
      0,
      `the stop poll must hold the event loop rather than end the process (exit 13 is Node reporting an unsettled top-level await): ${probed.output}`,
    );
    assert.doesNotMatch(probed.output, /unsettled top-level await/);
    const report: { stopped: boolean; survivors: boolean; elapsedMs: number } = JSON.parse(probed.output.trim()) as {
      stopped: boolean;
      survivors: boolean;
      elapsedMs: number;
    };
    assert.equal(report.stopped, false, 'a group that never empties is not reported stopped');
    assert.equal(report.survivors, true, 'and it is reported as surviving, which is what makes a second writer unsafe');
    assert.ok(report.elapsedMs >= 400, `the poll must run to its deadline, took ${String(report.elapsedMs)}ms`);

    // The same stop inside the worker: a real child that ignores SIGTERM, then a checkpoint.
    const port = new ScriptedWorkspacePort(prepared(), observation({ untrackedFiles: [ATTEMPT_FILE] }));
    const engine = new ScriptedEngine({
      events: [sessionStarted(T0)],
      hold: () => h.hold,
      spawnGroup: () =>
        spawn(process.execPath, ['-e', "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)"], {
          cwd: h.directory,
          detached: true,
          stdio: 'ignore',
        }),
    });
    const worker = h.buildWorker(engine, { workspaces: port });
    const jobId = h.enqueue();

    try {
      const running = worker.tick();
      await engine.firstSession;
      assert.equal(
        await waitFor(() => engine.tracked !== null, 10_000),
        true,
        'the session spawned a real tracked process group',
      );
      worker.requestStop();
      h.release();
      const tick = expectOk(await running);

      assert.equal(tick.kind, 'Claimed');
      assert.equal(tick.outcome.kind, 'Stopped', `the SIGTERM-ignoring child must still produce a stop: ${JSON.stringify(tick.outcome)}`);
      const trackedGroup = engine.tracked?.pid;
      assert.ok(trackedGroup !== undefined);
      assert.throws(() => process.kill(-trackedGroup, 0), /ESRCH/, 'the bounded kill reached the tracked group');

      const checkpoint = checkpointOf(h.queue, jobId);
      assert.ok(checkpoint !== null, 'the checkpoint is written before the process may end: its absence is the exit-13 failure');
      assert.deepEqual([...checkpoint.untrackedFiles], [ATTEMPT_FILE]);
      assert.equal(stateOf(h.queue, jobId), 'Paused');
      assert.equal(expectOk(h.leases.leaseStatus(jobId))?.state, 'Released');
    } finally {
      const trackedGroup = engine.tracked?.pid;
      if (trackedGroup !== undefined) {
        try {
          process.kill(-trackedGroup, 'SIGKILL');
        } catch {
          /* the tracked group is already gone */
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Interruption safety                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The shipped process entrypoint, resolved from this file rather than from the working directory.
 *
 * The interruption case drives `index.ts` in a child process because the only way to prove that a
 * real `SIGTERM` leaves durable state consistent is to send one (N01-AC1).
 */
const WORKER_ENTRYPOINT = new URL('./index.ts', import.meta.url).pathname;

/**
 * The credential the fixture provisions for its own engine, in the shape `codex login --with-api-key`
 * writes.
 *
 * An `apikey` login, deliberately: it carries no refresh token, so there is nothing for the engine and
 * an operator to rotate between them. Only its presence and its 0600 mode are load-bearing —
 * `resolveEngineAuthentication` stats the file and refuses anything another account could read.
 */
const PROVISIONED_ENGINE_CREDENTIAL = ['{"auth_mode":"apikey","OPENAI_API_KEY":"sk-', 'provisioned-worker-test-key"}'].join('');

/**
 * The workspace the interrupted child worker prepared, as it is left behind.
 *
 * The recovery port has to present this and not the fixture's default: a checkpoint written after
 * the attempt settles records the workspace as it is then, so a recovery that read a different
 * workspace identity, or one without the file the attempt had written, would be refused as
 * unaccounted work. That refusal is the rule working (F14-AC4), not a defect to work around.
 */
function signalWorkspace(worktreePath: string, untrackedFiles: readonly string[]): PreparedWorkspace['observation'] {
  return {
    workspace: { workspaceId: 'ws-signal', branchName: 'shiploop/signal', worktreePath },
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    dirtyFiles: ['src/worker.ts'],
    untrackedFiles,
  };
}

test('N01-AC1: a SIGTERM mid-run leaves durable state consistent, and a restart recovers it without a second writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-worker-signal-'));
  const worktree = join(directory, 'worktree');
  const database = join(directory, 'worker.db');
  const engineBinary = join(directory, 'engine-under-test.sh');
  const workspaceModule = join(directory, 'workspace-port.mjs');
  /**
   * A hermetic engine state root for the child, carrying one credential this test provisioned.
   *
   * The shipped entrypoint refuses a run with no engine credential (F15-AC5), and it resolved its
   * state root from the environment it inherited. Left alone it read the operator's real
   * `~/.local/state`, so this proof passed only on a host that happened to have a Codex login
   * provisioned — and the verification harness, which runs every command against an empty temporary
   * home so no operator credential leaks into a check, refused the child before it claimed anything.
   * A credential is not what this test is about, so it belongs to the fixture. `auth.json` sits under
   * `shiploop/codex/codex` because the state root resolves to `<XDG_STATE_HOME>/shiploop/codex` and
   * `codexHome` is that root's own `codex` child.
   */
  const engineStateRoot = join(directory, 'engine-state');
  const engineCodexHome = join(engineStateRoot, 'shiploop', 'codex', 'codex');
  await mkdir(engineCodexHome, { recursive: true, mode: 0o700 });
  await writeFile(join(engineCodexHome, 'auth.json'), PROVISIONED_ENGINE_CREDENTIAL, { mode: 0o600 });
  await mkdir(worktree);
  await writeFile(
    engineBinary,
    [
      '#!/bin/sh',
      `printf '%s\\n' '{"type":"thread.started","thread_id":"thread-worker-sigterm"}'`,
      `printf '%s\\n' '{"type":"turn.started"}'`,
      'trap "" TERM INT',
      'sleep 120',
    ].join('\n'),
  );
  await chmod(engineBinary, 0o755);
  const beforeAttempt = signalWorkspace(worktree, ['src/worker.test.ts']);
  const afterAttempt = signalWorkspace(worktree, ['src/worker.test.ts', 'in-progress.txt']);
  await writeFile(
    workspaceModule,
    [
      'export const createWorkspacePort = () => ({',
      '  async prepare() {',
      `    const observation = ${JSON.stringify(beforeAttempt)};`,
      '    return {',
      '      ok: true,',
      '      value: {',
      '        execution: {',
      '          workspaceId: observation.workspace.workspaceId,',
      '          absolutePath: observation.workspace.worktreePath,',
      '          headSha: observation.headSha,',
      '          baseSha: observation.baseSha,',
      `          environmentFingerprint: ${JSON.stringify(SCOPE_FINGERPRINT)},`,
      `          scopeFingerprint: ${JSON.stringify(SCOPE_FINGERPRINT)},`,
      '          isolatedPorts: {},',
      '          serviceEndpoints: [],',
      "          testAccess: { kind: 'None' },",
      '        },',
      '        observation,',
      '        deliveryAlreadyObserved: false,',
      '      },',
      '    };',
      '  },',
      '  async observe() {',
      `    return { ok: true, value: ${JSON.stringify(afterAttempt)} };`,
      '  },',
      '});',
    ].join('\n'),
  );

  const seeding = openWorkerStore(database);
  assert.ok(seeding.ok, `the store could not be seeded: ${seeding.ok ? '' : seeding.error.reason}`);
  seedParents(seeding.value.database);
  const queue = createJobQueue({ connection: seeding.value.database });
  const jobId = `job-signal` as JobId;
  const enqueued = queue.enqueue({
    operationId: 'op-signal' as OperationId,
    mode: 'Build',
    workItemId: WORK_ITEM,
    scopeSnapshotId: SNAPSHOT_ID,
    projectId: PROJECT,
    profileVersionId: PROFILE_VERSION,
    procedureVersionId: PROCEDURE_VERSION,
    jobId,
    now: T0,
    limits: null,
    permittedOperations: null,
  });
  assert.ok(enqueued.ok, 'the job could not be enqueued');
  seeding.value.close();

  const child = spawn(process.execPath, [WORKER_ENTRYPOINT], {
    cwd: directory,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      XDG_STATE_HOME: engineStateRoot,
      SHIPLOOP_WORKER_DATABASE: database,
      SHIPLOOP_WORKER_HOLDER: 'worker-signal-test',
      SHIPLOOP_WORKER_WORKSPACE_MODULE: workspaceModule,
      SHIPLOOP_WORKER_CODEX_BINARY: engineBinary,
      SHIPLOOP_WORKER_SANDBOX: 'read-only',
      SHIPLOOP_WORKER_LEASE_TTL_MS: String(LEASE_TTL_MS),
      SHIPLOOP_WORKER_POLL_INTERVAL_MS: '50',
      SHIPLOOP_WORKER_GRACEFUL_STOP_MS: '200',
      SHIPLOOP_WORKER_KILL_WAIT_MS: '1000',
    },
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  try {
    assert.ok(child.pid !== undefined, 'the worker child was started');
    const claimed = await waitFor(
      async () => {
        const store = openWorkerStore(database);
        if (!store.ok) return false;
        const reader = createJobQueue({ connection: store.value.database });
        const state = reader.readJob(jobId);
        store.value.close();
        return state.ok && state.value?.state === 'Running';
      },
      20_000,
    );
    assert.equal(claimed, true, `the shipped entrypoint must claim the job; child output: ${output.join('')}`);

    const runningGroup = await ownedProcessGroupsOf('engine-under-test.sh', directory);
    assert.equal(runningGroup.length, 1, `the real adapter spawned exactly one engine group: ${output.join('')}`);

    child.kill('SIGTERM');
    const code = await Promise.race([exited, delay(20_000).then(() => 'timeout' as const)]);
    assert.equal(code, 0, `the worker must exit cleanly on SIGTERM; child output: ${output.join('')}`);

    const afterSignal = openWorkerStore(database);
    assert.ok(afterSignal.ok);
    const reader = createJobQueue({ connection: afterSignal.value.database });
    const leases = createLeaseManager({ connection: afterSignal.value.database });
    const paused = expectOk(reader.readJob(jobId));
    assert.ok(paused !== null);
    assert.equal(paused.state, 'Paused', 'a SIGTERM mid-run leaves the job durably paused, not half written');
    assert.equal(expectOk(leases.leaseStatus(jobId))?.state, 'Released', 'the coding slot is given up on a clean stop');
    const checkpoint = expectOk(reader.readCheckpoint(jobId));
    assert.ok(checkpoint !== null, 'the interrupted run is not lost: it leaves a resume point');
    assert.equal(checkpoint.nextAction.length > 0, true);

    const clock = new TestClock(new Date(Date.parse(paused.updatedAt) + 1_000).toISOString());
    const recoveredEngine = new ScriptedEngine({
      events: [sessionStarted(clock.now()), succeeded(clock.now(), 'recovered after the restart')],
    });
    const recovery = createWorker(
      { holder: 'worker-after-restart', projectId: null, leaseTtlMs: LEASE_TTL_MS, pollIntervalMs: 1, engineEventLimit: 64 },
      {
        clock,
        logger: recordingLogger(),
        redact: (text) => text,
        engine: recoveredEngine,
        queue: reader,
        leases,
        workItems: new WorkItemRepository(afterSignal.value.database),
        attention: new AttentionItemRepository(afterSignal.value.database),
        workspaces: new ScriptedWorkspacePort(prepared(afterAttempt)),
        extensions: new ScriptedExtensions(),
        facts: FIXED_FACTS,
        liveness: livenessPort(() => ({ kind: 'Stopped', evidence: 'the interrupted worker process is gone' })),
        sleep: async (): Promise<void> => {
          await Promise.resolve();
        },
      },
    );
    assert.ok(recovery.ok, `the worker could not restart: ${recovery.ok ? '' : recovery.error.reason}`);

    const tick = expectOk(await recovery.value.tick());
    assert.equal(tick.kind, 'Claimed', 'the restart recovers the interrupted job');
    assert.equal(recoveredEngine.starts.length, 1, 'the interrupted run is resumed once, not duplicated');
    assert.equal(
      recoveredEngine.starts[0]?.start.kind,
      'FromCheckpoint',
      'the recovered attempt continues from the retained checkpoint',
    );
    assert.equal(expectOk(reader.readJob(jobId))?.state, 'Completed');
    assert.equal(
      expectOk(reader.listJobs({ states: null, projectId: null })).length,
      1,
      'recovery must not create a second job for the same work',
    );
    afterSignal.value.close();

    const leftOver = await ownedProcessGroupsOf('engine-under-test.sh', directory);
    assert.deepEqual(leftOver, [], 'the engine process group this worker spawned must be gone');
  } finally {
    if (child.pid !== undefined) {
      try {
        process.kill(-(child.pid as number), 'SIGKILL');
      } catch {
        /* the child already exited */
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

/** Process-group ids whose command line mentions `marker`, used to prove nothing is left running. */
/**
 * The process groups this TEST spawned, matched by marker and confined to this run's temp root.
 *
 * The previous version counted every process on the host whose arguments contained the marker.
 * That made the assertion hostage to unrelated processes: an orphan left by an earlier failed
 * run of this same test made it report extra groups and fail a candidate that was correct. The
 * property under test is that THIS run's worker launched exactly one engine group and cleaned it
 * up, so the scan is scoped to the run's own directory (F17-AC1, F17-AC5).
 */
async function ownedProcessGroupsOf(marker: string, root: string): Promise<readonly number[]> {
  const listing = await new Promise<string>((resolve, reject) => {
    const ps = spawn('ps', ['-eo', 'pid=,pgid=,args='], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    ps.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    ps.on('error', reject);
    ps.on('close', () => resolve(output));
  });
  const groups: number[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const args = match[3] ?? '';
    if (!args.includes(marker) || !args.includes(root)) continue;
    const pgid = Number(match[2]);
    if (!groups.includes(pgid)) groups.push(pgid);
  }
  return groups;
}

/** Polls a condition with a deadline, so an unmet expectation fails instead of hanging. */
async function waitFor(probe: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) return false;
    await delay(25);
  }
}
