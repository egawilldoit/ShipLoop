import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { ATTEMPT_STATES } from '@shiploop/domain';
import type {
  AttemptState,
  CommitSha,
  Fingerprint,
  JobId,
  OperationId,
  ProjectId,
  ScopeSnapshotId,
} from '@shiploop/domain';
import { openDatabase, type Database } from '../db.ts';
import { migrate } from '../migrations.ts';
import { createLeaseManager, type LeaseManager } from './lease.ts';
import { createJobQueue, type JobQueue } from './queue.ts';
import {
  DEFAULT_JOB_LIMITS,
  MODE_PERMITTED_OPERATIONS,
  PRIVILEGED_JOB_OPERATIONS,
  type EnqueueRequest,
  type JobMode,
  type JobOperation,
} from './types.ts';

const T0 = '2026-03-01T10:00:00.000Z';
const HEAD_SHA = 'a'.repeat(40) as CommitSha;
const BASE_SHA = 'b'.repeat(40) as CommitSha;
const FINGERPRINT = `fp_${'c'.repeat(32)}` as Fingerprint;
const SCOPE_FINGERPRINT = FINGERPRINT;

/**
 * Behavioural proof for the durable job queue, against the REAL schema.
 *
 * The suite used to apply its own `JOB_SCHEMA_CONTRACT` literals before each
 * test, so it exercised SQL that `migrations.ts` never created: the queue read
 * and wrote singular tables (`job`, `coding_slot`, `writer_lease`) that the
 * migrated schema does not have. Every assertion here now runs against a
 * database built by the production migration runner, so a statement that no
 * longer matches the schema fails here rather than at the first `claimNext` in
 * an application.
 *
 * The foreign keys are real, because `openDatabase` turns them on. A job records
 * the work item, scope snapshot, profile version and procedure version it is
 * running against (R4, F13-AC1), so the fixture creates exactly those parents
 * and nothing more: creating a project is a separate use case, not a queue
 * responsibility.
 */
const FIXTURE_PROJECT = '0a5f1c22-0000-4000-8000-0000000000f1' as ProjectId;
const OTHER_FIXTURE_PROJECT = '0a5f1c22-0000-4000-8000-0000000000f2' as ProjectId;
const OTHER_PROFILE_VERSION = 'profile-version-other';

/**
 * A legal route from `Queued` to each terminal state.
 *
 * The queue validates transitions against the domain table before it writes, so
 * reaching a state directly would test the lifecycle rather than the column. The
 * route keeps the assertion about what the schema can store.
 */
const STATE_PATH: Readonly<Record<string, readonly AttemptState[]>> = {
  Preparing: ['Preparing'],
  Running: ['Preparing', 'Running'],
  Verifying: ['Preparing', 'Running', 'Verifying'],
  WaitingForOwner: ['Preparing', 'Running', 'WaitingForOwner'],
  Paused: ['Preparing', 'Running', 'Paused'],
  Blocked: ['Preparing', 'Blocked'],
  Completed: ['Preparing', 'Running', 'Completed'],
  Cancelled: ['Cancelled'],
  Queued: [],
};
const FIXTURE_OWNER = '00000000-0000-4000-8000-00000000f001';
const PROFILE_VERSION = 'profile-version-fixture';
const PROCEDURE_VERSION = 'procedure-version-fixture';
const CONTENT_FINGERPRINT = `fp_${'d'.repeat(32)}` as Fingerprint;

/** A migrated database with the parents every job row references. */
function seed(db: Database): void {
  db.prepare('INSERT INTO owners (owner_id, display_name) VALUES (?, ?)').run(FIXTURE_OWNER, 'Solo owner');
  db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(FIXTURE_PROJECT, 'Fixture project');
  db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(OTHER_FIXTURE_PROJECT, 'Second fixture project');
  db.prepare(
    `INSERT INTO project_profile_versions (profile_version_id, project_id, version, content_json, content_fingerprint, created_by)
     VALUES (?, ?, 1, '{}', ?, ?)`,
  ).run(PROFILE_VERSION, FIXTURE_PROJECT, CONTENT_FINGERPRINT, FIXTURE_OWNER);
  db.prepare(
    `INSERT INTO procedure_versions (procedure_version_id, project_id, version, kind, source, content_json, content_fingerprint, created_by)
     VALUES (?, ?, 1, 'Procedure', 'Owner', '{}', ?, ?)`,
  ).run(PROCEDURE_VERSION, FIXTURE_PROJECT, CONTENT_FINGERPRINT, FIXTURE_OWNER);
  db.prepare(
    `INSERT INTO work_items (work_item_id, project_id, issue_id, publication_intent, origin, profile_version_id)
     VALUES (?, ?, ?, 'PublishWhenAgreed', 'Proposed', ?)`,
  ).run('work-item-fixture', FIXTURE_PROJECT, 'issue-fixture', PROFILE_VERSION);
  db.prepare(
    `INSERT INTO scope_snapshots (scope_snapshot_id, work_item_id, project_id, issue_id, description, scope_fingerprint, retrieved_at, profile_version_id, procedure_version_id)
     VALUES (?, ?, ?, ?, 'Fixture scope', ?, ?, ?, ?)`,
  ).run('snap-1', 'work-item-fixture', FIXTURE_PROJECT, 'issue-fixture', SCOPE_FINGERPRINT, T0, PROFILE_VERSION, PROCEDURE_VERSION);
  // A second project with its own work item and snapshot, so filtering the
  // attention dashboard by project is a real distinction and not a label.
  db.prepare(
    `INSERT INTO project_profile_versions (profile_version_id, project_id, version, content_json, content_fingerprint, created_by)
     VALUES (?, ?, 1, '{}', ?, ?)`,
  ).run(OTHER_PROFILE_VERSION, OTHER_FIXTURE_PROJECT, CONTENT_FINGERPRINT, FIXTURE_OWNER);
  db.prepare(
    `INSERT INTO work_items (work_item_id, project_id, issue_id, publication_intent, origin, profile_version_id)
     VALUES (?, ?, ?, 'PublishWhenAgreed', 'Proposed', ?)`,
  ).run('work-item-other', OTHER_FIXTURE_PROJECT, 'issue-other', OTHER_PROFILE_VERSION);
  db.prepare(
    `INSERT INTO scope_snapshots (scope_snapshot_id, work_item_id, project_id, issue_id, description, scope_fingerprint, retrieved_at, profile_version_id, procedure_version_id)
     VALUES (?, ?, ?, ?, 'Other scope', ?, ?, ?, ?)`,
  ).run('snap-other', 'work-item-other', OTHER_FIXTURE_PROJECT, 'issue-other', SCOPE_FINGERPRINT, T0, OTHER_PROFILE_VERSION, PROCEDURE_VERSION);
}

function enqueueRequest(overrides: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return {
    operationId: 'op-build-1' as OperationId,
    mode: 'Build',
    workItemId: 'work-item-fixture',
    scopeSnapshotId: 'snap-1' as ScopeSnapshotId,
    projectId: FIXTURE_PROJECT,
    profileVersionId: PROFILE_VERSION,
    procedureVersionId: PROCEDURE_VERSION,
    jobId: 'job-1' as JobId,
    now: T0,
    limits: DEFAULT_JOB_LIMITS,
    permittedOperations: null,
    ...overrides,
  };
}

function candidate(holder: string, now = T0, leaseTtlMs = 120_000) {
  return { holder, now, leaseTtlMs, projectId: null };
}

/**
 * A temp SQLite file with the contract schema applied, plus a queue on it.
 *
 * The file is real and separate from every other test's file, so no two tests
 * share a database and none of them can pass because of another's rows. The raw
 * connection is handed over as well because writer ownership is the lease
 * manager's job and the reclaim rules under F17-AC5 have to be exercised
 * against the same file the queue writes.
 */
async function withDatabase(
  run: (
    queue: JobQueue,
    leases: LeaseManager,
    file: string,
    directory: string,
  ) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-queue-'));
  const file = join(directory, 'queue.db');
  try {
    const opened = openDatabase(file);
    assert.ok(opened.ok, `the database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
    const connection = opened.value;
    const migrated = migrate(connection);
    assert.ok(migrated.ok, `the schema could not be migrated: ${migrated.ok ? '' : migrated.error.reason}`);
    seed(connection);
    await run(
      createJobQueue({ connection }),
      createLeaseManager({ connection }),
      file,
      directory,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function expectOk<T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  assert.equal(result.ok, true, result.ok ? '' : `expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function expectConflict<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; reason: string } }): { code: string; reason: string } {
  assert.equal(result.ok, false, result.ok ? `expected a typed rejection, got ${JSON.stringify(result.value)}` : '');
  assert.equal(result.error?.code, 'Conflict', `expected Conflict, got ${result.error?.code}: ${result.error?.reason}`);
  return result.error;
}

/**
 * Reads a job that the test has already created.
 *
 * A missing row here is a failure of the test's own setup, so it asserts rather
 * than threading `| null` through every assertion.
 */
function expectJob(queue: JobQueue, jobId: JobId) {
  const job = expectOk(queue.readJob(jobId));
  assert.ok(job !== null, `expected job ${jobId} to exist`);
  return job;
}

/**
 * The shape a worker thread posts back after claiming.
 *
 * The queue's own `Result` cannot cross the thread boundary by reference to its
 * domain types, so the worker posts the two fields the assertion needs: whether
 * the claim succeeded, and the typed rejection code when it did not.
 */
type ClaimMessage =
  | { readonly ok: true; readonly value: { readonly job: { readonly holder: string | null; readonly state: string } } }
  | { readonly ok: false; readonly error: { readonly code: string } };

test('enqueue records the job durably before returning success', async () => {
  await withDatabase((queue) => {
    const outcome = expectOk(queue.enqueue(enqueueRequest()));

    assert.equal(outcome.deduplicated, false);
    assert.equal(outcome.job.state, 'Queued');
    assert.equal(outcome.job.mode, 'Build');
    assert.equal(outcome.job.operationId, 'op-build-1');
    assert.equal(outcome.job.scopeSnapshotId, 'snap-1');
    assert.equal(outcome.job.workItemId, 'work-item-fixture');
    assert.equal(outcome.job.profileVersionId, PROFILE_VERSION);
    assert.equal(outcome.job.projectId, FIXTURE_PROJECT);
    assert.deepEqual(outcome.job.limits, DEFAULT_JOB_LIMITS);
    assert.equal(outcome.job.attemptCount, 0);
    assert.equal(outcome.job.holder, null);

    const stored = expectOk(queue.readJob('job-1' as JobId));
    assert.deepEqual(stored, outcome.job);
  });
});

test('a claimed job is returned and exactly one holder becomes the coding writer', async () => {
  await withDatabase((queue) => {
    expectOk(queue.enqueue(enqueueRequest()));

    const claimed = expectOk(queue.claimNext(candidate('writer-a')));

    assert.equal(claimed.job.jobId, 'job-1');
    assert.equal(claimed.job.state, 'Running');
    assert.equal(claimed.job.holder, 'writer-a');
    assert.equal(claimed.job.attemptCount, 1);
    assert.equal(claimed.slot.holder, 'writer-a');
    assert.equal(claimed.slot.jobId, 'job-1');
    assert.equal(claimed.slot.operationId, 'op-build-1');
    assert.equal(claimed.lease.holder, 'writer-a');
    assert.equal(claimed.lease.state, 'Active');

    const holders = expectOk(
      queue.listJobs({ states: ['Running'], projectId: null }),
    ).filter((job) => job.holder !== null);
    assert.equal(holders.length, 1);
    assert.equal(holders[0]?.holder, 'writer-a');
  });
});

test('two concurrent claims against one file yield exactly one writer', async (t) => {
  await withDatabase(async (queue, _leases, file) => {
    expectOk(queue.enqueue(enqueueRequest()));

    /**
     * Both claimers open their own connection and run at the same time in
     * separate threads. Two connections on one file in one thread would only
     * prove that the second call sees the first one's committed row, which is
     * sequential correctness. Threads are what make the write lock and the
     * conditional slot update contend for real.
     */
    // The worker imports the two real modules by absolute URL so it opens a
    // genuine second connection to the same file, which is what makes the write
    // lock and the conditional slot update contend rather than interleave.
    const workerSource = `
      import { parentPort, workerData } from 'node:worker_threads';
      const { openDatabase } = await import(workerData.dbModule);
      const { createJobQueue } = await import(workerData.queueModule);
      const connection = openDatabase(workerData.file).value;
      const queue = createJobQueue({ connection });
      const result = queue.claimNext({
        holder: workerData.holder, now: workerData.now, leaseTtlMs: 120000, projectId: null,
      });
      connection.close();
      parentPort.postMessage(result);
    `;
    const queueModule = new URL('./queue.ts', import.meta.url).href;
    const dbModule = new URL('../db.ts', import.meta.url).href;

    const claimInThread = (holder: string) =>
      new Promise<ClaimMessage>(
        (resolve, reject) => {
          const worker = new Worker(
            new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`),
            { workerData: { file, queueModule, dbModule, holder, now: T0 } },
          );
          worker.once('message', (message: ClaimMessage) => {
            void worker.terminate();
            resolve(message);
          });
          worker.once('error', reject);
        },
      );

    t.diagnostic('Two worker threads each opening their own connection to one database file');
    const [first, second] = await Promise.all([claimInThread('writer-a'), claimInThread('writer-b')]);
    const outcomes = [first, second];

    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    assert.equal(winners.length, 1, `expected exactly one successful claim, got ${JSON.stringify(outcomes)}`);
    assert.equal(losers.length, 1, `expected exactly one rejected claim, got ${JSON.stringify(outcomes)}`);

    for (const loser of losers) {
      if (loser.ok) continue;
      assert.equal(loser.error.code, 'Conflict');
    }

    const winnersJob = winners[0]?.ok === true ? winners[0].value.job : null;
    assert.equal(winnersJob?.state, 'Running');

    const running = expectOk(queue.listJobs({ states: ['Running'], projectId: null }));
    assert.equal(running.length, 1);
    const holder = running[0]?.holder;
    assert.ok(holder === 'writer-a' || holder === 'writer-b');
    assert.equal(running.filter((job) => job.holder !== null).length, 1);

    const all = expectOk(queue.listJobs({ states: null, projectId: null }));
    assert.equal(all.length, 1);
    assert.equal(all[0]?.attemptCount, 1, 'a losing claim must not increment the attempt count');
  });
});

test('a repeated start with the same operation identity returns the same job', async () => {
  await withDatabase((queue) => {
    const first = expectOk(queue.enqueue(enqueueRequest()));
    const second = expectOk(queue.enqueue(enqueueRequest()));

    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(second.job.jobId, first.job.jobId);
    assert.deepEqual(second.job, first.job);
    assert.equal(expectOk(queue.listJobs({ states: null, projectId: null })).length, 1);

    const reused = queue.enqueue(
      enqueueRequest({ jobId: 'job-other' as JobId, mode: 'Review' as JobMode }),
    );
    expectConflict(reused);
    assert.equal(expectOk(queue.listJobs({ states: null, projectId: null })).length, 1);
  });
});

test('a queued job waits while the coding slot is occupied and is claimable after release', async () => {
  await withDatabase((queue, leases) => {
    expectOk(queue.enqueue(enqueueRequest()));
    expectOk(
      queue.enqueue(
        enqueueRequest({
          operationId: 'op-build-2' as OperationId,
          jobId: 'job-2' as JobId,
          now: '2026-03-01T10:00:01.000Z',
        }),
      ),
    );

    expectOk(queue.claimNext(candidate('writer-a')));

    const blocked = queue.claimNext(candidate('writer-b', '2026-03-01T10:00:05.000Z'));
    expectConflict(blocked);
    assert.match(
      blocked.ok ? '' : blocked.error.reason,
      /coding slot is held by writer-a/,
      'the rejection must name the holder occupying the slot',
    );

    const queued = expectJob(queue, 'job-2' as JobId);
    assert.equal(queued.state, 'Queued', 'a job must stay queued rather than fail when the slot is busy');
    assert.equal(queued.holder, null);

    const lease = expectOk(queue.heartbeat({
      jobId: 'job-1' as JobId,
      holder: 'writer-a',
      now: '2026-03-01T10:00:10.000Z',
      leaseTtlMs: 120_000,
    }));
    assert.equal(lease.state, 'Active');
    assert.equal(lease.holder, 'writer-a');

    expectOk(
      leases.releaseLease({
        leaseId: 'lease:job-1',
        jobId: 'job-1' as JobId,
        holder: 'writer-a',
        now: '2026-03-01T10:00:11.000Z',
        jobState: 'Completed',
      }),
    );
    expectOk(queue.claimNext(candidate('writer-b', '2026-03-01T10:00:12.000Z')));

    const completed = expectJob(queue, 'job-1' as JobId);
    assert.equal(completed.state, 'Completed');
    assert.equal(completed.holder, null, 'a completed job must not keep the holder that wrote it');

    const reclaimed = expectJob(queue, 'job-2' as JobId);
    assert.equal(reclaimed.state, 'Running');
    assert.equal(reclaimed.holder, 'writer-b');
  });
});

test('an expired lease cannot be reclaimed until the holder is confirmed stopped', async () => {
  await withDatabase((queue, leases) => {
    expectOk(queue.enqueue(enqueueRequest()));
    const claim = expectOk(queue.claimNext(candidate('writer-a')));
    const leaseId = claim.lease.leaseId;
    assert.equal(leaseId, 'lease:job-1');

    const afterExpiry = '2026-03-01T10:10:00.000Z';
    expectOk(
      queue.heartbeat({ jobId: 'job-1' as JobId, holder: 'writer-a', now: T0, leaseTtlMs: 120_000 }),
    );

    const expired = expectOk(
      queue.listJobs({ states: ['Running'], projectId: null }),
    );
    assert.equal(expired.length, 1);

    const stale = expectOk(queue.staleWriters(afterExpiry));
    assert.equal(stale.length, 1);
    assert.equal(stale[0]?.holder, 'writer-a');

    const fresh = expectOk(queue.staleWriters(T0));
    assert.equal(fresh.length, 0, 'a holder inside its lease term must not be reported as stale');

    const reclaimAttempt = {
      leaseId: 'lease:job-2',
      jobId: 'job-1' as JobId,
      holder: 'writer-b',
      operationId: 'op-build-1' as OperationId,
      now: afterExpiry,
      leaseTtlMs: 120_000,
    };
    const refused = expectOk(leases.reclaimLease(reclaimAttempt));

    assert.equal(refused.granted, false);
    if (refused.granted) return;
    assert.equal(refused.reconciliationRequired, true);
    assert.match(refused.reason, /Establish that the previous holder is no longer writing/);
    assert.equal(refused.lease?.state, 'ReconciliationRequired');

    const confirmed = expectOk(
      leases.confirmHolderStopped({
        jobId: 'job-1' as JobId,
        holder: 'writer-a',
        confirmedBy: 'operator@example',
        confirmedAt: '2026-03-01T10:11:00.000Z',
        evidence: 'pid 4711 absent from the process table and the worktree lock released',
      }),
    );
    assert.equal(confirmed.state, 'HolderStoppedConfirmed');
    assert.equal(confirmed.confirmedStoppedBy, 'operator@example');
    assert.equal(confirmed.confirmedStoppedAt, '2026-03-01T10:11:00.000Z');
    assert.equal(confirmed.confirmedStoppedEvidence, 'pid 4711 absent from the process table and the worktree lock released');
    assert.equal(confirmed.reconciliationRequired, false);

    const reread = expectOk(leases.leaseStatus('job-1' as JobId));
    assert.equal(reread?.confirmedStoppedBy, 'operator@example');

    const granted = expectOk(leases.reclaimLease({ ...reclaimAttempt, now: '2026-03-01T10:12:00.000Z' }));
    assert.equal(granted.granted, true, 'a confirmed-stopped holder is the only path that frees the single writer');
    if (!granted.granted) return;
    assert.equal(granted.lease.holder, 'writer-b');
    assert.equal(granted.previousHolder, 'writer-a');
  });
});

test('a checkpoint round-trips every field needed to resume', async () => {
  await withDatabase((queue) => {
    expectOk(queue.enqueue(enqueueRequest()));
    expectOk(queue.claimNext(candidate('writer-a')));

    const written = expectOk(
      queue.checkpoint({
        jobId: 'job-1' as JobId,
        holder: 'writer-a',
        checkpointId: 'cp-1',
        scopeSnapshotId: 'snap-1' as ScopeSnapshotId,
        scopeFingerprint: FINGERPRINT,
        profileVersionId: 'profile-3',
        procedureVersionId: 'procedure-7',
        engineVersion: 'codex-2026-03',
        workspace: { workspaceId: 'ws-1', branchName: 'shiploop/job-1', worktreePath: '/tmp/ws-1' },
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        dirtyFiles: ['src/app.ts', 'package.json'],
        untrackedFiles: ['src/only-here.ts'],
        results: [
          { name: 'typecheck', result: 'Passed', detail: null },
          { name: 'browser-flow', result: 'Missing', detail: 'no run recorded' },
        ],
        feedback: [{ author: 'owner', at: '2026-03-01T10:06:00.000Z', body: 'keep the retry bounded' }],
        blocker: 'browser check has no recorded run',
        nextAction: 'Run the browser flow and record the evidence',
        now: '2026-03-01T10:07:00.000Z',
      }),
    );

    const read = expectOk(queue.readCheckpoint('job-1' as JobId));
    assert.deepEqual(read, written);
    assert.equal(read?.scopeSnapshotId, 'snap-1');
    assert.equal(read?.scopeFingerprint, FINGERPRINT);
    assert.equal(read?.profileVersionId, 'profile-3');
    assert.equal(read?.procedureVersionId, 'procedure-7');
    assert.equal(read?.engineVersion, 'codex-2026-03');
    assert.deepEqual(read?.workspace, { workspaceId: 'ws-1', branchName: 'shiploop/job-1', worktreePath: '/tmp/ws-1' });
    assert.equal(read?.headSha, HEAD_SHA);
    assert.equal(read?.baseSha, BASE_SHA);
    assert.deepEqual(read?.dirtyFiles, ['src/app.ts', 'package.json']);
    assert.deepEqual(read?.untrackedFiles, ['src/only-here.ts'], 'untracked work is part of the resume inventory');
    assert.equal(read?.results.length, 2);
    assert.equal(read?.results[0]?.result, 'Passed');
    assert.equal(read?.results[1]?.result, 'Missing');
    assert.deepEqual(read?.feedback, [{ author: 'owner', at: '2026-03-01T10:06:00.000Z', body: 'keep the retry bounded' }]);
    assert.equal(read?.blocker, 'browser check has no recorded run');
    assert.equal(read?.nextAction, 'Run the browser flow and record the evidence');

    const foreign = queue.checkpoint({
      jobId: 'job-1' as JobId,
      holder: 'writer-z',
      checkpointId: 'cp-2',
      scopeSnapshotId: 'snap-1' as ScopeSnapshotId,
      scopeFingerprint: FINGERPRINT,
      profileVersionId: 'profile-3',
      procedureVersionId: 'procedure-7',
      engineVersion: null,
      workspace: { workspaceId: 'ws-1', branchName: 'b', worktreePath: '/tmp/ws-1' },
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      dirtyFiles: [],
      untrackedFiles: [],
      results: [],
      feedback: [],
      blocker: null,
      nextAction: 'x',
      now: T0,
    });
    expectConflict(foreign);
    assert.equal(expectOk(queue.readCheckpoint('job-1' as JobId))?.checkpointId, 'cp-1');
  });
});

test('no mode implies merge or release authorization', async () => {
  await withDatabase((queue) => {
    const requested = queue.enqueue(
      enqueueRequest({ permittedOperations: ['ReadScope', 'ReadRepository', 'PushBranch', 'Merge', 'Release'] }),
    );
    assert.equal(
      requested.ok,
      false,
      'a job must not be enqueued with delivery authority attached',
    );
    assert.equal(requested.ok ? '' : requested.error.code, 'Blocked');
    assert.equal(
      expectOk(queue.listJobs({ states: null, projectId: null })).length,
      0,
      'the refused request must not leave a durable job behind',
    );

    expectOk(queue.enqueue(enqueueRequest({ permittedOperations: ['ReadScope', 'ReadRepository', 'PushBranch'] })));
    const job = expectJob(queue, 'job-1' as JobId);

    expectOk(queue.permittedOperation(job, 'PushBranch'));
    for (const privileged of ['Merge', 'Release', 'RecoveryRedeploy'] as readonly JobOperation[]) {
      const refused = queue.permittedOperation(job, privileged);
      assert.equal(refused.ok, false, `${privileged} must not be permitted for a Build job`);
      assert.equal(refused.ok ? '' : refused.error.code, 'Forbidden');
    }

    for (const mode of ['Plan', 'Investigate', 'Test', 'Review'] as readonly JobMode[]) {
      const other = expectOk(
        queue.enqueue(
          enqueueRequest({
            operationId: `op-${mode}` as OperationId,
            jobId: `job-${mode}` as JobId,
            mode,
            permittedOperations: null,
          }),
        ),
      );
      for (const privileged of ['Merge', 'Release'] as const) {
        const refused = queue.permittedOperation(other.job, privileged);
        assert.equal(refused.ok, false, `${mode} must not imply ${privileged}`);
      }
    }
  });
});

test('jobs, their state and their checkpoints survive close and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-durable-'));
  const file = join(directory, 'queue.db');
  try {
    const opened = openDatabase(file);
    assert.ok(opened.ok, `the database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
    const first = opened.value;
    const migrated = migrate(first);
    assert.ok(migrated.ok, `the schema could not be migrated: ${migrated.ok ? '' : migrated.error.reason}`);
    seed(first);

    const before = createJobQueue({ connection: first });
    expectOk(before.enqueue(enqueueRequest()));
    expectOk(before.enqueue(
      enqueueRequest({ operationId: 'op-2' as OperationId, jobId: 'job-2' as JobId, now: '2026-03-01T10:00:02.000Z' }),
    ));
    expectOk(before.claimNext(candidate('writer-a')));
    expectOk(
      before.checkpoint({
        jobId: 'job-1' as JobId,
        holder: 'writer-a',
        checkpointId: 'cp-durable',
        scopeSnapshotId: 'snap-1' as ScopeSnapshotId,
        scopeFingerprint: FINGERPRINT,
        profileVersionId: 'profile-3',
        procedureVersionId: 'procedure-7',
        engineVersion: null,
        workspace: { workspaceId: 'ws-1', branchName: 'shiploop/job-1', worktreePath: '/tmp/ws-1' },
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        dirtyFiles: ['src/app.ts'],
        untrackedFiles: ['notes.md'],
        results: [{ name: 'typecheck', result: 'Failed', detail: 'tsc exit 2' }],
        feedback: [],
        blocker: null,
        nextAction: 'Fix the type error',
        now: '2026-03-01T10:08:00.000Z',
      }),
    );
    first.close();

    const reopened = openDatabase(file);
    assert.ok(reopened.ok, `the database could not be reopened: ${reopened.ok ? '' : reopened.error.reason}`);
    const second = reopened.value;
    const after = createJobQueue({ connection: second });

    const running = expectJob(after, 'job-1' as JobId);
    assert.equal(running.state, 'Running');
    assert.equal(running.holder, 'writer-a');
    assert.equal(running.attemptCount, 1);

    assert.equal(expectJob(after, 'job-2' as JobId).state, 'Queued');

    const checkpoint = expectOk(after.readCheckpoint('job-1' as JobId));
    assert.equal(checkpoint?.checkpointId, 'cp-durable');
    assert.deepEqual(checkpoint?.dirtyFiles, ['src/app.ts']);
    assert.deepEqual(checkpoint?.untrackedFiles, ['notes.md']);

    const lost = after.claimNext(candidate('writer-b', '2026-03-01T10:09:00.000Z'));
    expectConflict(lost);
    assert.equal(
      expectJob(after, 'job-2' as JobId).state,
      'Queued',
      'a reopened database must still refuse a second writer',
    );
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a mode narrows its declared capabilities but cannot widen them', async () => {
  await withDatabase((queue) => {
    const widened = queue.enqueue(
      enqueueRequest({ mode: 'Plan' as JobMode, permittedOperations: ['ReadScope', 'PushBranch'] }),
    );
    assert.equal(widened.ok, false, 'a Plan job must not be grantable PushBranch');
    assert.equal(widened.ok ? '' : widened.error.code, 'Blocked');
    assert.equal(expectOk(queue.listJobs({ states: null, projectId: null })).length, 0);

    const narrowed = expectOk(
      queue.enqueue(enqueueRequest({ permittedOperations: ['ReadScope', 'ReadRepository'] })),
    );
    assert.deepEqual(narrowed.job.permittedOperations, ['ReadScope', 'ReadRepository']);
    const refused = queue.permittedOperation(narrowed.job, 'PushBranch');
    assert.equal(refused.ok, false, 'a narrowed job must not hold the capability it dropped');
    assert.equal(refused.ok ? '' : refused.error.code, 'Forbidden');

    const defaulted = expectOk(
      queue.enqueue(
        enqueueRequest({ operationId: 'op-default' as OperationId, jobId: 'job-default' as JobId, permittedOperations: null }),
      ),
    );
    assert.deepEqual(defaulted.job.permittedOperations, MODE_PERMITTED_OPERATIONS.Build);
    assert.ok(
      !defaulted.job.permittedOperations.some((operation) => PRIVILEGED_JOB_OPERATIONS.includes(operation)),
      'the default grant for a mode must contain no delivery authority',
    );
  });
});

test('listJobs filters the attention dashboard view by state and project', async () => {
  await withDatabase((queue) => {
    expectOk(queue.enqueue(enqueueRequest()));
    expectOk(
      queue.enqueue(
        enqueueRequest({
          operationId: 'op-other' as OperationId,
          jobId: 'job-2' as JobId,
          projectId: OTHER_FIXTURE_PROJECT,
          workItemId: 'work-item-other',
          scopeSnapshotId: 'snap-other' as ScopeSnapshotId,
          profileVersionId: OTHER_PROFILE_VERSION,
          now: '2026-03-01T10:00:02.000Z',
        }),
      ),
    );
    expectOk(queue.claimNext(candidate('writer-a')));

    assert.equal(expectOk(queue.listJobs({ states: ['Queued'], projectId: null })).length, 1);
    assert.equal(expectOk(queue.listJobs({ states: ['Running'], projectId: null })).length, 1);
    assert.equal(expectOk(queue.listJobs({ states: ['Running'], projectId: OTHER_FIXTURE_PROJECT })).length, 0);
    assert.equal(expectOk(queue.listJobs({ states: null, projectId: OTHER_FIXTURE_PROJECT })).length, 1);

    const rejected = queue.listJobs({ states: ['NotAState' as never], projectId: null });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.ok ? '' : rejected.error.code, 'Invalid');

    const marked = expectOk(queue.markState({ jobId: 'job-1' as JobId, state: 'Cancelled', now: T0 }));
    assert.equal(marked.state, 'Cancelled');
    assert.equal(marked.holder, null);

    const illegal = queue.markState({ jobId: 'job-2' as JobId, state: 'Running', now: T0 });
    assert.equal(illegal.ok, false);
    assert.equal(illegal.ok ? '' : illegal.error.code, 'Invalid');
  });
});

/**
 * The schema's job state vocabulary is the domain's, exactly (R5, ADR 0003).
 *
 * A hand-written second list is how "the queue says Claimed and the domain says
 * Preparing" happens: both tables look right, the two disagree, and a resumed run
 * is written to a state the lifecycle forbids. This asserts the sets are EQUAL in
 * both directions, so a state added to the domain cannot be silently accepted by
 * a fresh database and rejected by a migrated one, and a state left behind in the
 * schema cannot claim to be a lifecycle state at all.
 */
test("the schema's accepted job states are exactly the domain attempt states (R5)", async () => {
  await withDatabase(async (queue) => {
    expectOk(queue.enqueue(enqueueRequest()));

    const accepted = new Set<string>();
    for (const state of ATTEMPT_STATES) {
      // Each state needs its own work item, because a job row is bound to one.
      const outcome = expectOk(
        queue.enqueue(
          enqueueRequest({
            operationId: `op-state-${state}` as OperationId,
            jobId: `job-state-${state}` as JobId,
          }),
        ),
      );
      // The queue validates a transition against the domain lifecycle before it
      // writes, so reaching a state directly would test that table rather than
      // the column. Following a legal route keeps the assertion about what the
      // schema is able to store.
      let moved = { ok: true, value: outcome.job } as ReturnType<typeof queue.markState>;
      for (const next of STATE_PATH[state] ?? []) {
        if (!moved.ok) break;
        moved = queue.markState({ jobId: outcome.job.jobId, state: next, now: T0 });
      }
      if (moved.ok && moved.value.state === state) accepted.add(state);
    }

    assert.deepEqual(
      [...accepted].sort(),
      [...ATTEMPT_STATES].sort(),
      'every domain attempt state must be storable, and no others',
    );

    // The two states the schema used to allow and the domain does not define:
    // 'Claimed' is a lease fact and 'Failed' is an attempt outcome, not a job state.
    for (const state of ['Claimed', 'Failed']) {
      const rejected = queue.markState({
        jobId: 'job-1' as JobId,
        state: state as never,
        now: T0,
      });
      assert.equal(rejected.ok, false, `${state} must not be a domain attempt state`);
    }
  });
});
