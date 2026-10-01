import {
  assertTransition,
  blocked,
  conflict,
  err,
  invalid,
  isCommitSha,
  isFingerprint,
  ok,
  type AttemptState,
  type CommitSha,
  type DomainError,
  type Fingerprint,
  type JobId,
  type OperationId,
  type ProjectId,
  type Result,
  type ScopeSnapshotId,
} from '@shiploop/domain';
import {
  claimSlotOnConnection,
  leaseDispositionOf,
  mintWriterLease,
  readLeaseOnConnection,
  readSlotOnConnection,
  rejectLeaseTerm,
  releaseSlotOnConnection,
  renewLeaseOnConnection,
  writeLeaseOnConnection,
  type AcquireLeaseRequest,
} from './lease.ts';
import {
  DEFAULT_JOB_LIMITS,
  MODE_PERMITTED_OPERATIONS,
  PRIVILEGED_JOB_OPERATIONS,
  decodeFileList,
  decodeFeedback,
  decodeLimits,
  decodeOperations,
  decodeResults,
  defaultTransactionRunner,
  encodeFeedback,
  encodeFileList,
  encodeLimits,
  encodeOperations,
  encodeResults,
  guard,
  isAttemptState,
  isJobOperation,
  readInteger,
  readOptionalText,
  readText,
  type CheckpointResult,
  type ClaimCandidate,
  type ClaimedJob,
  type CodingSlot,
  type EnqueueRequest,
  type FeedbackNote,
  type JobCheckpoint,
  type JobLimits,
  type JobMode,
  type JobOperation,
  type JobRecord,
  type SqlConnection,
  type SqlRow,
  type TransactionRunner,
  type WorkspaceIdentity,
  type WriterLease,
} from './types.ts';

/**
 * The durable job queue (F13, F14, F17, F18, F31).
 *
 * Three properties are the reason this file exists and each one is a property
 * of the database rather than of caller discipline.
 *
 * A job row is committed before `enqueue` reports success, so an acknowledged
 * start is never absent from the durable store (F13-AC1, N01-AC3). `operationId`
 * is UNIQUE, so a repeated start with the same operation identity returns the
 * job that already exists instead of a second one (F13-AC2).
 *
 * `claimNext` takes the single global coding slot and writes the lease, the
 * operation identity and the job's state in one transaction. Two callers racing
 * on two connections cannot both win, because the second one's `BEGIN IMMEDIATE`
 * is refused by the database while the first holds the write lock, and because
 * the slot update is conditional on the slot still being free (F13-AC2). An
 * occupied slot makes the job stay `Queued`; it is never failed, and it is
 * claimable the moment the slot is released.
 *
 * Nothing here performs a remote side effect. The queue records what a job is
 * permitted to do; an adapter decides whether to do it, and merge and release
 * stay absent from every mode because no mode implies delivery authorization
 * (F13-AC3, N01-AC3).
 */

/**
 * The job tables this slice reads.
 *
 * `migrations.ts` owns the schema and this module creates nothing. The names are
 * exported so a drift between this module and the migration is a visible diff
 * rather than a runtime "no such table" in a test that otherwise looks healthy.
 */
export const JOB_TABLES = {
  jobs: 'jobs',
  jobCheckpoints: 'job_checkpoints',
  writerLeases: 'writer_leases',
  codingSlots: 'coding_slots',
  workspaceLocks: 'workspace_locks',
  workspacePorts: 'workspace_ports',
} as const;

/** What a claim of the single global coding writer produced. */
export interface EnqueueOutcome {
  readonly job: JobRecord;
  /** True when an identical operation identity had already started this job. */
  readonly deduplicated: boolean;
}

/** The lifecycle marker a caller wants the job to carry. */
export interface MarkStateRequest {
  readonly jobId: JobId;
  readonly state: AttemptState;
  readonly now: string;
}

/** Liveness proof from the holder that currently owns the writer. */
export interface HeartbeatRequest {
  readonly jobId: JobId;
  readonly holder: string;
  readonly now: string;
  readonly leaseTtlMs: number;
}

/**
 * A writer that already holds a job and is beginning another attempt on it.
 *
 * A checkpoint is identified by `ckpt:<jobId>:<attemptCount>`, so an attempt that did not advance
 * the count would write the identifier of the attempt it replaced and a resume could not say which
 * attempt produced the workspace it is about to write over (F17-AC2, F18-AC1).
 */
export interface BeginAttemptRequest {
  readonly jobId: JobId;
  readonly holder: string;
  readonly now: string;
}

/** The durable resume point written for a paused or interrupted job (F17-AC2). */
export interface CheckpointRequest {
  readonly jobId: JobId;
  readonly holder: string;
  readonly checkpointId: string;
  readonly scopeSnapshotId: ScopeSnapshotId;
  readonly scopeFingerprint: Fingerprint;
  readonly profileVersionId: string;
  readonly procedureVersionId: string;
  readonly engineVersion: string | null;
  readonly workspace: WorkspaceIdentity;
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  readonly dirtyFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly results: readonly CheckpointResult[];
  readonly feedback: readonly FeedbackNote[];
  readonly blocker: string | null;
  readonly nextAction: string;
  readonly now: string;
}

/** Which jobs the attention dashboard is asking about (F31). */
export interface JobQuery {
  readonly states: readonly AttemptState[] | null;
  readonly projectId: ProjectId | null;
}

/** A lease the queue has decided needs reconciliation before any second writer. */
export interface StaleWriter {
  readonly jobId: JobId;
  readonly holder: string;
  readonly lastHeartbeatAt: string;
  readonly overdueByMs: number;
}

/** Connections and the transaction runner the queue is built on. */
export interface JobQueueStore {
  readonly connection: SqlConnection;
  readonly transaction?: TransactionRunner | null;
}

export interface JobQueue {
  enqueue: (request: EnqueueRequest) => Result<EnqueueOutcome, DomainError>;
  claimNext: (candidate: ClaimCandidate) => Result<ClaimedJob, DomainError>;
  heartbeat: (request: HeartbeatRequest) => Result<WriterLease, DomainError>;
  beginAttempt: (request: BeginAttemptRequest) => Result<JobRecord, DomainError>;
  checkpoint: (request: CheckpointRequest) => Result<JobCheckpoint, DomainError>;
  markState: (request: MarkStateRequest) => Result<JobRecord, DomainError>;
  permittedOperation: (job: JobRecord, operation: JobOperation) => Result<JobOperation, DomainError>;
  listJobs: (query: JobQuery) => Result<readonly JobRecord[], DomainError>;
  readJob: (jobId: JobId) => Result<JobRecord | null, DomainError>;
  readCheckpoint: (jobId: JobId) => Result<JobCheckpoint | null, DomainError>;
  staleWriters: (now: string) => Result<readonly StaleWriter[], DomainError>;
}

function jobFromRow(row: SqlRow): JobRecord {
  const state = readText(row, 'state');
  if (!isAttemptState(state)) {
    throw new Error(`Job state "${state}" is not a domain attempt state, so the row is not trusted.`);
  }
  const mode = readText(row, 'mode');
  const limits: JobLimits = decodeLimits(readOptionalText(row, 'limits'));
  return {
    jobId: readText(row, 'job_id') as JobId,
    operationId: readText(row, 'operation_id') as OperationId,
    mode: mode as JobMode,
    workItemId: readText(row, 'work_item_id'),
    scopeSnapshotId: readText(row, 'scope_snapshot_id') as ScopeSnapshotId,
    projectId: readText(row, 'project_id') as ProjectId,
    profileVersionId: readText(row, 'profile_version_id'),
    procedureVersionId: readText(row, 'procedure_version_id'),
    state,
    correlationId: readText(row, 'correlation_id'),
    limits,
    permittedOperations: decodeOperations(readOptionalText(row, 'permitted_operations')),
    holder: readOptionalText(row, 'holder'),
    attemptCount: readInteger(row, 'attempt_count'),
    createdAt: readText(row, 'queued_at'),
    updatedAt: readText(row, 'updated_at'),
  };
}

function readJobRow(connection: SqlConnection, jobId: JobId): SqlRow | undefined {
  return connection.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId);
}

function readJobByOperation(connection: SqlConnection, operationId: OperationId): SqlRow | undefined {
  return connection.prepare('SELECT * FROM jobs WHERE operation_id = ?').get(operationId);
}

function writeJobOnConnection(connection: SqlConnection, job: JobRecord): void {
  connection
    .prepare(
      `INSERT INTO jobs (
         job_id, operation_id, mode, work_item_id, scope_snapshot_id, project_id,
         profile_version_id, procedure_version_id, state, correlation_id, queued_at,
         limits, permitted_operations, holder, attempt_count, active_budget_ms,
         max_attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.jobId,
      job.operationId,
      job.mode,
      job.workItemId,
      job.scopeSnapshotId,
      job.projectId,
      job.profileVersionId,
      job.procedureVersionId,
      job.state,
      job.correlationId,
      job.createdAt,
      encodeLimits(job.limits),
      encodeOperations(job.permittedOperations),
      job.holder,
      job.attemptCount,
      job.limits.activeExecutionMs,
      job.limits.maxAttempts,
      job.createdAt,
      job.updatedAt,
    );
}

/**
 * Refuses an operation the job was never granted.
 *
 * The grant is recorded at enqueue and re-read from the durable row, so this is
 * not a policy computed from the mode at call time. Merge, release and recovery
 * redeploy are absent from every mode's grant, which is what makes "no mode
 * implies merge/release authorization" a checkable property instead of a
 * convention (F13-AC3).
 */
export function permittedOperationOf(
  job: JobRecord,
  operation: JobOperation,
): Result<JobOperation, DomainError> {
  if (!isJobOperation(operation)) {
    return err(
      invalid(`"${operation}" is not an operation any job may hold.`, [
        { path: 'operation', message: 'Use an operation from the recorded capability vocabulary.' },
      ]),
    );
  }
  if (!job.permittedOperations.includes(operation)) {
    return err(
      {
        code: 'Forbidden',
        reason: `Job ${job.jobId} running in ${job.mode} mode was not granted ${operation}. Only the owner can authorize merge or release (F13-AC3).`,
      },
    );
  }
  return ok(operation);
}

function checkpointFromRow(row: SqlRow): JobCheckpoint {
  const head = readText(row, 'head_sha');
  const base = readText(row, 'base_sha');
  const fingerprint = readText(row, 'scope_fingerprint');
  if (!isCommitSha(head) || !isCommitSha(base)) {
    throw new Error(`Checkpoint ${readText(row, 'checkpoint_id')} stores an abbreviated commit SHA, so resume could not compare it to a checkout.`);
  }
  if (!isFingerprint(fingerprint)) {
    throw new Error(`Checkpoint ${readText(row, 'checkpoint_id')} stores a malformed scope fingerprint.`);
  }
  return {
    jobId: readText(row, 'job_id') as JobId,
    checkpointId: readText(row, 'checkpoint_id'),
    scopeSnapshotId: readText(row, 'scope_snapshot_id') as ScopeSnapshotId,
    scopeFingerprint: fingerprint as Fingerprint,
    profileVersionId: readText(row, 'profile_version_id'),
    procedureVersionId: readText(row, 'procedure_version_id'),
    engineVersion: readOptionalText(row, 'engine_version'),
    workspace: {
      workspaceId: readText(row, 'workspace_id'),
      branchName: readText(row, 'branch_name'),
      worktreePath: readText(row, 'worktree_path'),
    },
    headSha: head as CommitSha,
    baseSha: base as CommitSha,
    dirtyFiles: decodeFileList(readOptionalText(row, 'dirty_files'), 'dirty_files'),
    untrackedFiles: decodeFileList(readOptionalText(row, 'untracked_files'), 'untracked_files'),
    results: decodeResults(readOptionalText(row, 'results')),
    feedback: decodeFeedback(readOptionalText(row, 'feedback')),
    blocker: readOptionalText(row, 'blocker'),
    nextAction: readText(row, 'next_action'),
    recordedAt: readText(row, 'recorded_at'),
  };
}

function writeCheckpointOnConnection(connection: SqlConnection, checkpoint: JobCheckpoint): void {
  connection
    .prepare(
      `INSERT INTO job_checkpoints (
         job_id, checkpoint_id, scope_snapshot_id, scope_fingerprint,
         profile_version_id, procedure_version_id, engine_version,
         workspace_id, branch_name, worktree_path, head_sha, base_sha,
         dirty_files, untracked_files, results, feedback, blocker, next_action, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         checkpoint_id = excluded.checkpoint_id,
         scope_snapshot_id = excluded.scope_snapshot_id,
         scope_fingerprint = excluded.scope_fingerprint,
         profile_version_id = excluded.profile_version_id,
         procedure_version_id = excluded.procedure_version_id,
         engine_version = excluded.engine_version,
         workspace_id = excluded.workspace_id,
         branch_name = excluded.branch_name,
         worktree_path = excluded.worktree_path,
         head_sha = excluded.head_sha,
         base_sha = excluded.base_sha,
         dirty_files = excluded.dirty_files,
         untracked_files = excluded.untracked_files,
         results = excluded.results,
         feedback = excluded.feedback,
         blocker = excluded.blocker,
         next_action = excluded.next_action,
         recorded_at = excluded.recorded_at`,
    )
    .run(
      checkpoint.jobId,
      checkpoint.checkpointId,
      checkpoint.scopeSnapshotId,
      checkpoint.scopeFingerprint,
      checkpoint.profileVersionId,
      checkpoint.procedureVersionId,
      checkpoint.engineVersion,
      checkpoint.workspace.workspaceId,
      checkpoint.workspace.branchName,
      checkpoint.workspace.worktreePath,
      checkpoint.headSha,
      checkpoint.baseSha,
      encodeFileList(checkpoint.dirtyFiles),
      encodeFileList(checkpoint.untrackedFiles),
      encodeResults(checkpoint.results),
      encodeFeedback(checkpoint.feedback),
      checkpoint.blocker,
      checkpoint.nextAction,
      checkpoint.recordedAt,
    );
}

/** Builds a job queue bound to one connection and one transaction runner. */
export function createJobQueue(store: JobQueueStore): JobQueue {
  const connection = store.connection;
  const transaction: TransactionRunner = store.transaction ?? defaultTransactionRunner;

  /**
   * Records the durable job before reporting success.
   *
   * The identity check and the insert are one transaction, so two concurrent
   * starts with the same `operationId` cannot both insert: the UNIQUE index
   * rejects the loser and the loser is handed the winner's row. That is the
   * deduplication F13-AC2 asks for, and it holds without a read-then-write race.
   */
  function enqueue(request: EnqueueRequest): Result<EnqueueOutcome, DomainError> {
    return guard(() =>
      transaction(connection, (): Result<EnqueueOutcome, DomainError> => {
        const existing = readJobByOperation(connection, request.operationId);
        if (existing !== undefined) {
          const job = jobFromRow(existing);
          if (job.jobId === request.jobId && job.mode === request.mode && job.scopeSnapshotId === request.scopeSnapshotId) {
            return ok({ job, deduplicated: true });
          }
          return err(
            conflict(
              `Operation identity ${request.operationId} already started job ${job.jobId} as ${job.mode} on ${job.scopeSnapshotId}; a different request cannot reuse it (F13-AC2).`,
              `${job.jobId}/${job.mode}/${job.scopeSnapshotId}`,
              `${request.jobId}/${request.mode}/${request.scopeSnapshotId}`,
            ),
          );
        }

        const limits = request.limits ?? DEFAULT_JOB_LIMITS;
        const rejectedLimits = invalidLimits(limits);
        if (!rejectedLimits.ok) return rejectedLimits;
        const grant = resolveGrant(request);
        if (!grant.ok) return grant;

        const job: JobRecord = {
          jobId: request.jobId,
          operationId: request.operationId,
          mode: request.mode,
          workItemId: request.workItemId,
          scopeSnapshotId: request.scopeSnapshotId,
          projectId: request.projectId,
          profileVersionId: request.profileVersionId,
          procedureVersionId: request.procedureVersionId,
          state: 'Queued',
          correlationId: request.correlationId ?? request.operationId,
          limits,
          permittedOperations: grant.value,
          holder: null,
          attemptCount: 0,
          createdAt: request.now,
          updatedAt: request.now,
        };
        writeJobOnConnection(connection, job);
        return ok({ job, deduplicated: false });
      }),
    );
  }

  /**
   * Claims the next queued job for the single global coding writer.
   *
   * Ordering inside the transaction is load bearing. The slot is taken before
   * the job is touched, so a claim that loses the slot has already failed and
   * cannot have half-claimed a job. The job row is re-read inside the
   * transaction rather than trusted from a prior read, because a queued job may
   * have been cancelled by the owner while the lock was contended.
   */
  function claimNext(candidate: ClaimCandidate): Result<ClaimedJob, DomainError> {
    return guard(() =>
      transaction(connection, (): Result<ClaimedJob, DomainError> => {
        const rejectedTerm = rejectLeaseTerm(candidate.leaseTtlMs);
        if (!rejectedTerm.ok) return rejectedTerm;

        const slot: CodingSlot = readSlotOnConnection(connection);
        const refusal = refuseOccupiedSlot(connection, slot, candidate);
        if (refusal !== null) return err(refusal);

        const row = connection
          .prepare(
            `SELECT * FROM jobs
              WHERE state = 'Queued' AND (? IS NULL OR project_id = ?)
              ORDER BY created_at ASC, job_id ASC
              LIMIT 1`,
          )
          .get(candidate.projectId, candidate.projectId);
        if (row === undefined) {
          return err({
            code: 'NotFound',
            reason: 'No queued job is waiting for the coding writer.',
          });
        }
        const job = jobFromRow(row);

        const existing = readLeaseOnConnection(connection, job.jobId);
        if (existing !== null && leaseDispositionOf(existing, candidate.now) !== 'Vacant') {
          return err(
            conflict(
              `Job ${job.jobId} still has writer ownership recorded for ${existing.holder} (${leaseDispositionOf(existing, candidate.now)}); claimNext does not take over a writer, so it stays queued (F17-AC5).`,
              'no writer on this job',
              `${existing.holder} ${leaseDispositionOf(existing, candidate.now)}`,
            ),
          );
        }

        const leaseRequest: AcquireLeaseRequest = {
          leaseId: `lease:${job.jobId}`,
          jobId: job.jobId,
          holder: candidate.holder,
          operationId: job.operationId,
          now: candidate.now,
          leaseTtlMs: candidate.leaseTtlMs,
        };
        const lease = mintWriterLease(leaseRequest);
        const claimed = claimSlotOnConnection(connection, leaseRequest, lease);
        if (!claimed.ok) return claimed;
        writeLeaseOnConnection(connection, lease);

        const running = moveToRunningOnConnection(connection, job, candidate);
        if (!running.ok) return running;

        return ok({ job: running.value, lease, slot: claimed.value });
      }),
    );
  }

  /**
   * Records liveness from the holder that owns the writer.
   *
   * Renewal is refused once the lease is no longer Active, so a process that was
   * reclaimed while suspended cannot keep renewing ownership it has lost.
   */
  function heartbeat(request: HeartbeatRequest): Result<WriterLease, DomainError> {
    return guard(() =>
      transaction(connection, () => {
        const renewed = renewLeaseOnConnection(connection, {
          leaseId: `lease:${request.jobId}`,
          jobId: request.jobId,
          holder: request.holder,
          now: request.now,
          leaseTtlMs: request.leaseTtlMs,
        });
        if (!renewed.ok) return renewed;
        connection
          .prepare('UPDATE jobs SET last_heartbeat_at = ?, updated_at = ? WHERE job_id = ?')
          .run(request.now, request.now, request.jobId);
        return renewed;
      }),
    );
  }

  /**
   * Records that the holder which owns this job is beginning another attempt on it.
   *
   * `claimNext` advances the counter for a first claim; a recovery has no claim, so without this
   * the second engine session of a job would be recorded under the first one's attempt count and
   * `ckpt:<jobId>:<attemptCount>` could not tell the two apart (F17-AC2).
   *
   * The holder is checked because the counter is part of the ownership record: a process that lost
   * the job must not be able to advance the count of an attempt it is not performing (F17-AC5).
   */
  function beginAttempt(request: BeginAttemptRequest): Result<JobRecord, DomainError> {
    return guard(() =>
      transaction(connection, (): Result<JobRecord, DomainError> => {
        const row = readJobRow(connection, request.jobId);
        if (row === undefined) {
          return err({ code: 'NotFound', reason: `No job ${request.jobId} exists to attempt.` });
        }
        const job = jobFromRow(row);
        if (job.holder !== request.holder) {
          return err(
            conflict(
              `Job ${request.jobId} is held by ${job.holder ?? 'nobody'}, so ${request.holder} cannot begin an attempt on it (F17-AC5).`,
              job.holder ?? 'nobody',
              request.holder,
            ),
          );
        }
        connection
          .prepare('UPDATE jobs SET attempt_count = attempt_count + 1, updated_at = ? WHERE job_id = ?')
          .run(request.now, request.jobId);
        const stored = readJobRow(connection, request.jobId);
        if (stored === undefined) {
          return err({ code: 'Unavailable', reason: 'The job row vanished inside its own transaction.' });
        }
        return ok(jobFromRow(stored));
      }),
    );
  }

  /**
   * Writes the durable resume point.
   *
   * Every field the specification lists is stored, including the dirty and
   * untracked inventory: a checkpoint that omitted untracked files would resume
   * into a workspace that looks clean and silently lose work (F17-AC2).
   */
  function checkpoint(request: CheckpointRequest): Result<JobCheckpoint, DomainError> {
    return guard(() =>
      transaction(connection, (): Result<JobCheckpoint, DomainError> => {
        const invalidCheckpoint = validateCheckpoint(request);
        if (!invalidCheckpoint.ok) return invalidCheckpoint;

        const row = readJobRow(connection, request.jobId);
        if (row === undefined) {
          return err({ code: 'NotFound', reason: `No job ${request.jobId} exists to checkpoint.` });
        }
        const job = jobFromRow(row);
        if (job.holder !== request.holder) {
          return err(
            conflict(
              `Job ${request.jobId} is held by ${job.holder ?? 'nobody'}, so ${request.holder} cannot write its checkpoint.`,
              job.holder ?? 'nobody',
              request.holder,
            ),
          );
        }

        const stored: JobCheckpoint = {
          jobId: request.jobId,
          checkpointId: request.checkpointId,
          scopeSnapshotId: request.scopeSnapshotId,
          scopeFingerprint: request.scopeFingerprint,
          profileVersionId: request.profileVersionId,
          procedureVersionId: request.procedureVersionId,
          engineVersion: request.engineVersion,
          workspace: request.workspace,
          headSha: request.headSha,
          baseSha: request.baseSha,
          dirtyFiles: request.dirtyFiles,
          untrackedFiles: request.untrackedFiles,
          results: request.results,
          feedback: request.feedback,
          blocker: request.blocker,
          nextAction: request.nextAction,
          recordedAt: request.now,
        };
        writeCheckpointOnConnection(connection, stored);
        return ok(stored);
      }),
    );
  }

  /**
   * Moves a job to another lifecycle state.
   *
   * The target is validated against the domain attempt states and the domain
   * transition table, so the queue cannot invent a state or take a shortcut the
   * lifecycle forbids.
   *
   * Reaching a state where the job is no longer the active writer also gives up
   * the coding slot. Clearing the job's holder while the slot still names it
   * would leave a queue whose only claimable job is invisible to the next
   * claimer, which reads as a permanently stuck writer rather than a finished
   * one (F13-AC2, N01-AC1). A transition is a statement that the job is no longer
   * writing, so a caller must not record one while a process may still be writing
   * (F17-AC5).
   */
  function markState(request: MarkStateRequest): Result<JobRecord, DomainError> {
    return guard(() =>
      transaction(connection, (): Result<JobRecord, DomainError> => {
        const row = readJobRow(connection, request.jobId);
        if (row === undefined) {
          return err({ code: 'NotFound', reason: `No job ${request.jobId} exists.` });
        }
        const job = jobFromRow(row);
        const transition = assertTransition('attempt', job.state, request.state);
        if (!transition.ok) return transition;
        const moved = updateJobStateOnConnection(connection, job.jobId, request.state, request.now);
        if (!moved.ok) return moved;
        relinquishWriterOnConnection(connection, job, request.state, request.now);
        const stored = readJobRow(connection, request.jobId);
        if (stored === undefined) {
          return err({ code: 'Unavailable', reason: 'The job row vanished inside its own transaction.' });
        }
        return ok(jobFromRow(stored));
      }),
    );
  }

  /** Reads the jobs the attention dashboard groups, filtered by state and project (F31). */
  function listJobs(query: JobQuery): Result<readonly JobRecord[], DomainError> {
    return guard(() => {
      const states = query.states ?? [];
      for (const state of states) {
        if (!isAttemptState(state)) {
          return err(
            invalid(`"${state}" is not a domain attempt state.`, [
              { path: 'states', message: 'Filter with values from ATTEMPT_STATES.' },
            ]),
          );
        }
      }
      const placeholders = states.map(() => '?').join(', ');
      const clauses: string[] = [];
      const parameters: (string | null)[] = [];
      if (states.length > 0) {
        clauses.push(`state IN (${placeholders})`);
        parameters.push(...states);
      }
      if (query.projectId !== null) {
        clauses.push('project_id = ?');
        parameters.push(query.projectId);
      }
      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
      const rows = connection
        .prepare(`SELECT * FROM jobs${where} ORDER BY created_at ASC, job_id ASC`)
        .all(...parameters);
      return ok(rows.map(jobFromRow));
    });
  }

  function readJob(jobId: JobId): Result<JobRecord | null, DomainError> {
    return guard(() => {
      const row = readJobRow(connection, jobId);
      return ok(row === undefined ? null : jobFromRow(row));
    });
  }

  function readCheckpoint(jobId: JobId): Result<JobCheckpoint | null, DomainError> {
    return guard(() => {
      const row = connection.prepare('SELECT * FROM job_checkpoints WHERE job_id = ?').get(jobId);
      return ok(row === undefined ? null : checkpointFromRow(row));
    });
  }

  /**
   * Lists holders that have missed heartbeats past the reconciliation threshold.
   *
   * This reports, it does not act. Turning a missed heartbeat into a new writer
   * is exactly what F17-AC5 forbids, so the queue surfaces the condition and
   * leaves the decision to `reclaimLease` plus `confirmHolderStopped`.
   */
  function staleWriters(now: string): Result<readonly StaleWriter[], DomainError> {
    return guard(() => {
      const rows = connection
        .prepare(
          `SELECT job_id, holder, renewed_at, expires_at FROM writer_leases
            WHERE state = 'Active' AND expires_at <= ?
            ORDER BY job_id ASC`,
        )
        .all(now);
      const stale: StaleWriter[] = [];
      for (const row of rows) {
        const expiresAt = readText(row, 'expires_at');
        const overdue = Date.parse(expiresAt) - Date.parse(now);
        if (!Number.isFinite(overdue)) continue;
        stale.push({
          jobId: readText(row, 'job_id') as JobId,
          holder: readText(row, 'holder'),
          lastHeartbeatAt: readText(row, 'renewed_at'),
          overdueByMs: overdue,
        });
      }
      return ok(stale);
    });
  }

  return {
    enqueue,
    claimNext,
    heartbeat,
    beginAttempt,
    checkpoint,
    markState,
    permittedOperation: permittedOperationOf,
    listJobs,
    readJob,
    readCheckpoint,
    staleWriters,
  };
}

function invalidLimits(limits: JobLimits): Result<null, DomainError> {
  const fields = (['activeExecutionMs', 'maxAutomatedFixPasses', 'maxToolRetries', 'maxAttempts'] as const)
    .filter((field) => !Number.isFinite(limits[field]) || limits[field] < 0)
    .map((field) => ({ path: `limits.${field}`, message: 'A work limit must be a finite, non-negative number.' }));
  if (fields.length === 0) return ok(null);
  return err(invalid('The recorded work limits are not usable.', fields));
}

/**
 * Resolves the grant a job is recorded with.
 *
 * A request may narrow a mode's capabilities but never widen them. Allowing a
 * caller to grant a `Plan` job `PushBranch` would make the mode a label rather
 * than a capability boundary, which is the property F13-AC3 asks for.
 *
 * A privileged operation is refused here rather than merely left unused: the
 * durable grant is what `permittedOperation` checks later, so a grant that
 * contained one would make delivery authorization a property of an enqueue
 * request (F13-AC3, N01-AC3).
 */
function resolveGrant(request: EnqueueRequest): Result<readonly JobOperation[], DomainError> {
  const declaredForMode = MODE_PERMITTED_OPERATIONS[request.mode];
  if (declaredForMode === undefined) {
    return err(
      invalid(`"${request.mode}" is not a job mode.`, [{ path: 'mode', message: 'Use Plan, Investigate, Build, Test or Review.' }]),
    );
  }

  const requested = request.permittedOperations ?? declaredForMode;
  const unknown = requested.filter((operation) => !isJobOperation(operation));
  if (unknown.length > 0) {
    return err(
      invalid(`Unknown permitted operations requested: ${unknown.join(', ')}.`, unknown.map((operation) => ({
        path: 'permittedOperations',
        message: `${operation} is not an operation any job may hold.`,
      }))),
    );
  }
  const privileged = requested.filter((operation) => PRIVILEGED_JOB_OPERATIONS.includes(operation));
  if (privileged.length > 0) {
    return err(
      blocked(
        `${privileged.join(', ')} cannot be granted to a coding job: only the owner authorizes merge, release or recovery redeploy (F13-AC3).`,
        [
          {
            name: 'owner-delivery-authorization',
            detail: `Job mode ${request.mode} requested ${privileged.join(', ')}.`,
            remedy:
              'Run the work in a mode that needs no delivery authority, then accept the candidate and authorize merge or release as a separate owner decision.',
          },
        ],
      ),
    );
  }
  const beyondMode = requested.filter((operation) => !declaredForMode.includes(operation));
  if (beyondMode.length > 0) {
    return err(
      blocked(
        `${request.mode} mode does not declare ${beyondMode.join(', ')}; a job cannot be granted a capability its mode does not have (F13-AC3).`,
        [
          {
            name: 'mode-capability-boundary',
            detail: `${request.mode} declares ${declaredForMode.join(', ')}.`,
            remedy: `Run this work in a mode that declares ${beyondMode[0]}, or drop it from the requested capabilities.`,
          },
        ],
      ),
    );
  }
  return ok([...new Set(requested)]);
}

/**
 * Refuses a claim while another holder owns the coding writer.
 *
 * An expired lease does not make the slot claimable. It is refused here for the
 * same reason `reclaimLease` refuses: expiry proves only that heartbeats
 * stopped, so the previous process may still be writing, and granting a second
 * writer on that evidence is the failure F17-AC5 exists to prevent. The slot is
 * freed by `releaseLease`, or by `confirmHolderStopped` followed by
 * `reclaimLease` (N01-AC1).
 */
function refuseOccupiedSlot(
  connection: SqlConnection,
  slot: CodingSlot,
  candidate: ClaimCandidate,
): DomainError | null {
  if (slot.jobId === null || slot.holder === null) return null;
  if (slot.holder === candidate.holder) {
    return conflict(
      `Holder ${slot.holder} already holds the coding writer for job ${slot.jobId}; a second claim would make one holder the writer twice.`,
      `no coding writer for ${candidate.holder}`,
      `${slot.holder} writing job ${slot.jobId}`,
    );
  }

  const lease = readLeaseOnConnection(connection, slot.jobId);
  const unreconciled =
    lease !== null && lease.state === 'ReconciliationRequired'
      ? lease.reconciliationReason ?? 'the previous holder stopped heartbeating'
      : lease === null
        ? 'no lease is recorded for the job holding the slot'
        : null;

  return conflict(
    unreconciled === null
      ? `The single global coding slot is held by ${slot.holder} for job ${slot.jobId}, so job stays queued until that writer finishes (F13-AC2).`
      : `The coding slot is held by ${slot.holder} for job ${slot.jobId} and cannot be reclaimed: ${unreconciled}. Establish that the previous writer stopped, then reclaim (F17-AC5).`,
    'an unheld coding slot',
    `held by ${slot.holder} for job ${slot.jobId}`,
  );
}

/**
 * Moves a claimed job to Running and records the attempt.
 *
 * The domain allows `Queued -> Preparing -> Running` and not `Queued -> Running`,
 * so both steps are validated. Claiming is a single act, and a claim that
 * stopped at Preparing would leave the holder holding the coding writer without
 * the queue recording that it is the one writing (F13-AC2, N01-AC1).
 */
function moveToRunningOnConnection(
  connection: SqlConnection,
  job: JobRecord,
  candidate: ClaimCandidate,
): Result<JobRecord, DomainError> {
  const queued = assertTransition('attempt', job.state, 'Preparing');
  if (!queued.ok) return queued;
  const running = assertTransition('attempt', 'Preparing', 'Running');
  if (!running.ok) return running;
  connection
    .prepare(
      `UPDATE jobs
          SET state = ?, holder = ?, attempt_count = attempt_count + 1,
              last_heartbeat_at = ?, updated_at = ?,
              started_at = COALESCE(started_at, ?)
        WHERE job_id = ?`,
    )
    .run('Running', candidate.holder, candidate.now, candidate.now, candidate.now, job.jobId);
  return ok({
    ...job,
    state: 'Running',
    holder: candidate.holder,
    attemptCount: job.attemptCount + 1,
    updatedAt: candidate.now,
  });
}

/** States in which a job is consuming execution capacity, so it has a start time. */
const ACTIVE_STATES: ReadonlySet<AttemptState> = new Set<AttemptState>([
  'Preparing',
  'Running',
  'Verifying',
]);

/** States in which a job is no longer in flight, so it has a finish time. */
const FINISHED_STATES: ReadonlySet<AttemptState> = new Set<AttemptState>(['Completed', 'Cancelled']);

/**
 * States in which the job is no longer the active writer, so the holder is dropped.
 *
 * `Blocked` and `WaitingForOwner` belong here because both mean the attempt has stopped writing:
 * a blocked attempt has nothing left it may do without an owner decision, and a job waiting for an
 * owner extension has already checkpointed and stopped. Keeping the single global coding slot for
 * either state made one job that needed an owner block every later job in the project until an
 * owner intervened, which is the opposite of what `WaitingForOwner` exists to do (F13-AC2, F18-AC2).
 *
 * The states that could still have a writing process are deliberately absent. `Running` and
 * `Verifying` are the states a live attempt holds, and a writer that may still be writing is
 * reported as detached and moves no job state at all, so no transition in this set can hand the
 * slot to a second writer while the first one is alive (F17-AC1, F17-AC5).
 */
const STATES_WITHOUT_WRITER: ReadonlySet<AttemptState> = new Set<AttemptState>([
  'Queued',
  'Paused',
  'Blocked',
  'WaitingForOwner',
  'Completed',
  'Cancelled',
]);

/**
 * Gives up the coding slot when a job stops being the writer.
 *
 * The lease is released rather than deleted, so the record of who held the slot
 * and when survives for reconciliation. A slot already held by a different job
 * is left alone: it belongs to that job, not to this transition.
 */
function relinquishWriterOnConnection(
  connection: SqlConnection,
  job: JobRecord,
  state: AttemptState,
  now: string,
): void {
  if (!STATES_WITHOUT_WRITER.has(state) || job.holder === null) return;
  const slot = readSlotOnConnection(connection);
  if (slot.jobId !== job.jobId || slot.holder !== job.holder) return;

  const lease = readLeaseOnConnection(connection, job.jobId);
  if (lease !== null && lease.state === 'Active') {
    writeLeaseOnConnection(connection, {
      ...lease,
      state: 'Released',
      renewedAt: lease.renewedAt > now ? lease.renewedAt : now,
    });
  }
  releaseSlotOnConnection(connection, job.jobId, job.holder);
}

function updateJobStateOnConnection(
  connection: SqlConnection,
  jobId: JobId,
  state: AttemptState,
  now: string,
): Result<null, DomainError> {
  // A job that is actually doing work records when it started, and a job that
  // has finished records when it stopped. The schema CHECKs both, which is what
  // makes "running" mean "running since" rather than just a label (F13-AC1).
  connection
    .prepare(
      `UPDATE jobs
          SET state = ?, holder = CASE WHEN ? THEN NULL ELSE holder END, updated_at = ?,
              started_at = CASE WHEN ? THEN COALESCE(started_at, ?) ELSE started_at END,
              finished_at = CASE WHEN ? THEN ? ELSE finished_at END
        WHERE job_id = ?`,
    )
    .run(
      state,
      STATES_WITHOUT_WRITER.has(state) ? 1 : 0,
      now,
      ACTIVE_STATES.has(state) ? 1 : 0,
      now,
      FINISHED_STATES.has(state) ? 1 : 0,
      now,
      jobId,
    );
  return ok(null);
}

function validateCheckpoint(request: CheckpointRequest): Result<null, DomainError> {
  const fields: { path: string; message: string }[] = [];
  if (!isCommitSha(request.headSha)) {
    fields.push({ path: 'headSha', message: 'A checkpoint stores a full commit SHA; an abbreviation cannot be compared to a checkout.' });
  }
  if (!isCommitSha(request.baseSha)) {
    fields.push({ path: 'baseSha', message: 'A checkpoint stores a full commit SHA; an abbreviation cannot be compared to a checkout.' });
  }
  if (!isFingerprint(request.scopeFingerprint)) {
    fields.push({ path: 'scopeFingerprint', message: 'A checkpoint must name the scope fingerprint it was produced against.' });
  }
  if (request.nextAction.trim().length === 0) {
    fields.push({ path: 'nextAction', message: 'A resume point with no next action cannot be resumed.' });
  }
  if (request.checkpointId.trim().length === 0) {
    fields.push({ path: 'checkpointId', message: 'A checkpoint must be identifiable so a resume can name it.' });
  }
  if (fields.length === 0) return ok(null);
  return err(invalid('The checkpoint cannot be stored as given (F17-AC2).', fields));
}