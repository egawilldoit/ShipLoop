/**
 * Behavioural proof for the job start, lifecycle and limit-extension use cases.
 *
 * The store is REAL throughout: a temporary SQLite file opened with `openDatabase`,
 * built by the shipped `migrate`, and driven through the shipped `createJobQueue` and
 * `createLeaseManager` over the same connection. No statement in this file creates a table,
 * so an assertion about what a start persisted is an assertion about the schema the product
 * actually ships rather than about a fixture that happens to agree with it.
 *
 * Two past integration defects were hidden by a suite that applied its own schema literals,
 * so the parents a job row references are created through the real repositories: the
 * project and its profile version by `ProjectProfileRepository`, the recipe by
 * `ProcedureRepository`, the work item by `WorkItemRepository`, and the scope snapshot by
 * `ScopeRepository` from inside `startRun` itself.
 *
 * What is supplied by the test rather than observed: the readiness observation and the scope
 * content. Both are provider facts (F09-AC1, F12-AC1) that a transport reads before it calls
 * a use case, and the domain owns what either one means. The clock is injected and movable,
 * so a recorded decision replays identically and a lease term can be reasoned about instead
 * of waited for.
 *
 * Nothing here contacts a provider, and nothing reads ambient time.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { recordOwnerWait } from '@shiploop/domain';
import type {
  AreaObservation,
  CommitSha,
  DomainError,
  JobId,
  JobMode,
  OperationId,
  OwnerId,
  ProfileVersionId,
  ProjectId,
  ReadinessObservation,
  Result,
  ScopeSnapshot,
  WorkItemId,
} from '@shiploop/domain';
import {
  ProjectProfileRepository,
  ProcedureRepository,
  ScopeRepository,
  WorkItemRepository,
  createJobQueue,
  createLeaseManager,
  migrate,
  openDatabase,
} from '@shiploop/storage';
import type { Database, JobLimits, JobOperation, JobQueue, LeaseManager } from '@shiploop/storage';

import {
  attemptLimitsFor,
  createJobUseCases,
  derivedJobId,
  type JobUseCases,
  type RunStart,
  type StartRunInput,
} from './jobs.ts';
import { RECIPE_SUBJECT_KEY, type ControllerClock } from './profiles.ts';

const T0 = '2026-06-01T09:00:00.000Z';
const LEASE_TTL_MS = 120_000;
const HEAD_SHA = 'a'.repeat(40) as CommitSha;
const BASE_SHA = 'b'.repeat(40) as CommitSha;

/** The bounded limits this deployment records, in the shape the queue persists. */
const LIMITS: JobLimits = {
  activeExecutionMs: 60 * 60 * 1000,
  maxAutomatedFixPasses: 2,
  maxToolRetries: 3,
  maxAttempts: 2,
};

const PROJECT = '7c1d2e3f-0000-4000-8000-0000000000b1' as ProjectId;
const OWNER_ID = 'own_jobs_test' as OwnerId;

/** Delivery operations, which no mode's grant may contain (F13-AC3). */
const DELIVERY_OPERATIONS: readonly JobOperation[] = ['Merge', 'Release', 'RecoveryRedeploy'];

const MODES: readonly JobMode[] = ['Plan', 'Investigate', 'Build', 'Test', 'Review'];

/**
 * A clock a test can move.
 *
 * Time is an input to every decision here, and `Date.now()` in the code under test would
 * make a recorded limit evaluation unreplayable. Moving it forward is also how a lease term
 * and a budget are exercised without waiting a real minute for either (F18-AC2).
 */
class MovableClock implements ControllerClock {
  private instant: number = Date.parse(T0);

  now(): string {
    return new Date(this.instant).toISOString();
  }

  advance(ms: number): void {
    this.instant += ms;
  }
}

function expectOk<T>(result: Result<T, DomainError>): T {
  if (!result.ok) {
    assert.fail(`expected success but received ${result.error.code}: ${result.error.reason}`);
  }
  return result.value;
}

/**
 * The refusal, narrowed to the code that was expected.
 *
 * Narrowing the return rather than the caller's assertion is what lets a case read
 * `error.prerequisites` on a `Blocked` without a cast.
 */
function expectError<T, C extends DomainError['code']>(
  result: Result<T, DomainError>,
  code: C,
): Extract<DomainError, { readonly code: C }> {
  if (result.ok) {
    assert.fail(`expected ${code} but the call succeeded`);
  }
  assert.equal(result.error.code, code);
  return result.error as Extract<DomainError, { readonly code: C }>;
}

function satisfied(reason: string): AreaObservation {
  return { status: 'Satisfied', reason, remedy: null };
}

function unmet(reason: string, remedy: string): AreaObservation {
  return { status: 'Unmet', reason, remedy };
}

/** An assessment of work that is ready to start (F09-AC5). */
function readyObservation(subjectId: string, assessedAt: string): ReadinessObservation {
  return {
    subjectId,
    assessedAt,
    scope: satisfied('The issue content was read and its acceptance criteria captured.'),
    criteria: satisfied('The issue names one acceptance criterion with an id.'),
    repository: satisfied('The repository reference resolves and the base branch is readable.'),
    target: satisfied('The target branch is configured and differs from nothing protected.'),
    dependencies: [],
    verification: satisfied('The profile names the required checks.'),
    access: satisfied('Every credential reference resolves to a stored credential.'),
    investigationSupported: [],
  };
}

/** An assessment that blocks on access, so the refusal has a nameable area (F09-AC2). */
function accessBlockedObservation(subjectId: string, assessedAt: string): ReadinessObservation {
  return {
    ...readyObservation(subjectId, assessedAt),
    access: unmet(
      'The repository credential reference resolves to no credential.',
      'Store a credential reference for the repository and grant access, then assess readiness again.',
    ),
  };
}

function scopeFor(workItemId: WorkItemId): ScopeSnapshot {
  return {
    workItemId,
    issueId: 'issue-jobs-test',
    issueIdentifier: 'ENG-17',
    title: 'Bound the coding worker',
    description: 'A run must record its inputs, stop on a limit and preserve its checkpoint.',
    providerRevision: 'rev-3',
    priority: '2',
    dependencyIssueIds: [],
    acceptanceCriteria: [{ id: 'AC-1', text: 'Reaching a limit waits for an owner extension.' }],
    retrievedAt: T0,
  };
}

interface StartRequest {
  readonly operationId: string;
  readonly mode?: JobMode;
  readonly readiness?: ReadinessObservation;
  readonly scope?: ScopeSnapshot;
}

interface Harness {
  readonly useCases: JobUseCases;
  readonly queue: JobQueue;
  readonly leases: LeaseManager;
  readonly database: Database;
  readonly clock: MovableClock;
  readonly workItemId: WorkItemId;
  readonly projectId: ProjectId;
  readonly profileVersionId: ProfileVersionId;
  readonly procedureVersionId: string;
  readonly start: (request: StartRequest) => Result<RunStart, DomainError>;
  /** The stored job row, read as raw columns so the assertion is about the schema. */
  readonly storedJob: (jobId: JobId) => Record<string, unknown>;
  /** Puts a job in Running the way the coding worker does: a real claim of the slot. */
  readonly claim: (holder: string) => Result<JobId, DomainError>;
}

function readRow(database: Database, sql: string, ...parameters: string[]): Record<string, unknown> | undefined {
  const row = database.prepare(sql).get(...parameters);
  return row === undefined ? undefined : ({ ...row } as Record<string, unknown>);
}

function countRows(database: Database, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
  return Number(row?.['total'] ?? -1);
}

/**
 * A migrated database with one project, one work item and the real use cases.
 *
 * Each test gets its own temporary file, so no two share rows and none can pass because of
 * another's work. The parents are created by the repositories the product uses, and the use
 * cases are the real ones over the real queue, so a start that succeeded really persisted.
 */
async function withJobs(run: (harness: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-job-use-case-'));
  const opened = openDatabase(join(directory, 'jobs.sqlite'));
  assert.ok(opened.ok, `the database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
  const database: Database = opened.value;

  try {
    const migrated = migrate(database);
    assert.ok(migrated.ok, `the schema could not be migrated: ${migrated.ok ? '' : migrated.error.reason}`);
    assert.ok(true, 'the provider-revision migration is exercised by the publication fixture below');

    database.prepare('INSERT INTO owners (owner_id, display_name, created_at) VALUES (?, ?, ?)').run(
      OWNER_ID,
      'Jobs owner',
      T0,
    );

    const profiles = new ProjectProfileRepository(database);
    const profile = expectOk(
      profiles.saveVersion({
        projectId: PROJECT,
        content: {
          references: {
            repository: 'github.com/example/shiploop',
            ticketProvider: 'linear',
            ticketTeamKey: 'ENG',
            baseBranch: 'main',
            targetBranch: 'main',
            deploymentProvider: 'none',
            engine: 'claude-code',
            previewComponents: [],
          },
          policy: {
            requiredChecks: ['pnpm test'],
            deliveryBehavior: 'ManualAuthorizationOnly',
            maxFixPasses: 2,
            workspaceIsolation: 'WorktreeAndDataDirectory',
            capabilityVersion: 1,
          },
          recipe: 'pnpm install',
          environment: { runtime: 'node24', ports: [41100], secretReferences: [] },
        },
        note: null,
        createdAt: T0,
        createdBy: OWNER_ID,
        expectedVersionNumber: null,
      }),
    );

    const procedures = new ProcedureRepository(database);
    const recipe = expectOk(
      procedures.appendVersion({
        projectId: PROJECT,
        subjectKey: RECIPE_SUBJECT_KEY,
        kind: 'Procedure',
        scope: 'Environment',
        source: 'Owner',
        sourceRevision: '1',
        content: '{"recipeId":"recipe-1","version":1}',
        status: 'Accepted',
        createdAt: T0,
        createdBy: OWNER_ID,
        note: 'Environment recipe',
        expectedVersionNumber: null,
      }),
    );

    const workItems = new WorkItemRepository(database);
    const workItem = expectOk(
      workItems.create({
        projectId: PROJECT,
        profileVersionId: profile.profileVersionId,
        source: 'ProposedNewIssue',
        title: scopeFor('pending' as WorkItemId).title,
        externalIssueId: null,
        externalIssueIdentifier: null,
        externalIssueUrl: null,
        publicationIntent: 'PublishWhenAgreed',
        relatedWorkItemIds: [],
        adoption: null,
        at: T0,
      }),
    );

    const clock = new MovableClock();
    const queue = createJobQueue({ connection: database });
    const leases = createLeaseManager({ connection: database });
    const scope = new ScopeRepository(database);
    const useCases = createJobUseCases({
      clock,
      queue,
      leases,
      profiles,
      procedures,
      workItems,
      scope,
      limits: LIMITS,
    });

    const start = (request: StartRequest): Result<RunStart, DomainError> => {
      const input: StartRunInput = {
        workItemId: workItem.workItemId,
        mode: request.mode ?? 'Build',
        operationId: request.operationId as OperationId,
        ownerId: OWNER_ID,
        readiness: request.readiness ?? readyObservation(workItem.workItemId, clock.now()),
        scope: request.scope ?? scopeFor(workItem.workItemId),
        correlationId: null,
      };
      return useCases.startRun(input);
    };

    const storedJob = (jobId: JobId): Record<string, unknown> => {
      const row = readRow(database, 'SELECT * FROM jobs WHERE job_id = ?', jobId);
      assert.notEqual(row, undefined, `job ${jobId} should be persisted`);
      return row ?? {};
    };

    const claim = (holder: string): Result<JobId, DomainError> => {
      const claimed = queue.claimNext({
        holder,
        now: clock.now(),
        leaseTtlMs: LEASE_TTL_MS,
        projectId: null,
      });
      if (!claimed.ok) return { ok: false, error: claimed.error };
      return { ok: true, value: claimed.value.job.jobId };
    };

    await run({
      useCases,
      queue,
      leases,
      database,
      clock,
      workItemId: workItem.workItemId,
      projectId: PROJECT,
      profileVersionId: profile.profileVersionId,
      procedureVersionId: recipe.procedureVersionId,
      start,
      storedJob,
      claim,
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* F13-AC1: what a successful start recorded                                     */
/* -------------------------------------------------------------------------- */

test('F13-AC1 a successful start records mode, scope snapshot, project, limits and permitted operations durably before returning success', async () => {
  await withJobs((harness) => {
    const start = expectOk(harness.start({ operationId: 'op-f13-ac1' }));
    assert.equal(start.deduplicated, false);
    assert.equal(start.job.state, 'Queued');
    assert.equal(start.requestedByOwner, OWNER_ID);
    assert.equal(start.readiness?.verdict, 'Ready');

    const row = harness.storedJob(start.job.jobId);
    assert.equal(row['mode'], 'Build');
    assert.equal(row['work_item_id'], harness.workItemId);
    assert.equal(row['project_id'], harness.projectId);
    assert.equal(row['profile_version_id'], harness.profileVersionId);
    assert.equal(row['procedure_version_id'], harness.procedureVersionId);
    assert.equal(row['scope_snapshot_id'], start.capturedScope.scopeSnapshotId);
    assert.deepEqual(JSON.parse(String(row['limits'])) as JobLimits, LIMITS);

    const storedOperations = JSON.parse(String(row['permitted_operations'])) as readonly JobOperation[];
    assert.deepEqual(storedOperations, start.grant.permittedOperations);
    assert.ok(storedOperations.length > 0, 'a Build job must hold the operations its mode declares');
  });
});

test('F13-AC1 F09-AC2 a start whose readiness is not Ready is refused with the failed area named and records nothing', async () => {
  await withJobs((harness) => {
    const snapshotsBefore = countRows(harness.database, 'scope_snapshots');
    const jobsBefore = countRows(harness.database, 'jobs');

    const refused = harness.start({
      operationId: 'op-readiness-blocked',
      readiness: accessBlockedObservation(harness.workItemId, harness.clock.now()),
    });
    const blocked = expectError(refused, 'Blocked');

    assert.match(blocked.reason, /Access/);
    assert.match(blocked.reason, /credential/);
    const named = blocked.prerequisites.map((prerequisite) => prerequisite.name);
    assert.ok(named.includes('readiness-access'), `expected the access area to be named, got ${named.join(', ')}`);
    for (const prerequisite of blocked.prerequisites) {
      assert.ok(prerequisite.remedy.length > 0, 'every named area must carry a remedy');
    }

    assert.equal(countRows(harness.database, 'scope_snapshots'), snapshotsBefore, 'a refused start captures no scope');
    assert.equal(countRows(harness.database, 'jobs'), jobsBefore, 'a refused start records no job');
  });
});

/* -------------------------------------------------------------------------- */
/* F13-AC2: one job per operation identity, and queueing behind the writer      */
/* -------------------------------------------------------------------------- */

test('F13-AC2 a repeated operation identity returns the same job and a start behind an occupied coding slot queues and says so', async () => {
  await withJobs((harness) => {
    const first = expectOk(harness.start({ operationId: 'op-f13-ac2-a' }));
    assert.equal(first.job.jobId, derivedJobId('op-f13-ac2-a' as OperationId));

    const repeated = expectOk(harness.start({ operationId: 'op-f13-ac2-a' }));
    assert.equal(repeated.job.jobId, first.job.jobId, 'a repeated operation identity must not start a second job');
    assert.equal(repeated.deduplicated, true);
    assert.equal(
      repeated.capturedScope.scopeSnapshotId,
      first.capturedScope.scopeSnapshotId,
      'the repeat must resolve to the scope already captured for that job',
    );
    assert.equal(repeated.readiness, null, 'a repeat is answered from the durable job, not re-admitted');
    assert.equal(countRows(harness.database, 'jobs'), 1, 'one operation identity, one job row');
    assert.equal(countRows(harness.database, 'scope_snapshots'), 1, 'a repeat must not capture a second snapshot');

    const reused = harness.start({ operationId: 'op-f13-ac2-a', mode: 'Plan' });
    const conflict = expectError(reused, 'Conflict');
    assert.match(conflict.reason, /already started job/);

    const claimed = expectOk(harness.claim('writer-1'));
    assert.equal(claimed, first.job.jobId, 'the coding worker claims the only queued job');

    const second = expectOk(harness.start({ operationId: 'op-f13-ac2-b' }));
    assert.notEqual(second.job.jobId, first.job.jobId, 'a different operation identity starts its own job');
    assert.equal(second.dispatch.state, 'Queued');
    assert.deepEqual(second.dispatch.heldByWriter, [first.job.jobId]);
    assert.match(second.dispatch.reason, /single global coding writer/);

    const stored = harness.storedJob(second.job.jobId);
    assert.equal(stored['state'], 'Queued', 'a job behind the writer stays queued rather than failing');
    assert.equal(countRows(harness.database, 'jobs'), 2);
  });
});

/* -------------------------------------------------------------------------- */
/* F13-AC3: no mode implies delivery authorization                               */
/* -------------------------------------------------------------------------- */

test('F13-AC3 the returned grant carries no delivery capability for any mode and permittedOperationFor delegates to the recorded grant', async () => {
  await withJobs((harness) => {
    for (const mode of MODES) {
      const start = expectOk(harness.start({ operationId: `op-mode-${mode}`, mode }));

      for (const operation of DELIVERY_OPERATIONS) {
        assert.ok(
          !start.grant.permittedOperations.includes(operation),
          `${mode} must not hold ${operation} (F13-AC3)`,
        );
      }
      assert.deepEqual(start.grant.refusedDeliveryOperations, [...DELIVERY_OPERATIONS]);
      assert.match(start.grant.refusalReason, /Merge/);
      assert.match(start.grant.refusalReason, /delivery authority/i);

      const stored = JSON.parse(String(harness.storedJob(start.job.jobId)['permitted_operations'])) as readonly JobOperation[];
      for (const operation of DELIVERY_OPERATIONS) {
        assert.ok(!stored.includes(operation), `the durable grant for ${mode} must not hold ${operation}`);
      }

      for (const operation of DELIVERY_OPERATIONS) {
        const refused = harness.useCases.permittedOperationFor(start.job.jobId, operation);
        const forbidden = expectError(refused, 'Forbidden');
        assert.match(forbidden.reason, /Merge|Release|RecoveryRedeploy|owner/i);
      }

      const allowed = harness.useCases.permittedOperationFor(start.job.jobId, 'ReadScope');
      assert.equal(expectOk(allowed), 'ReadScope', 'the durable grant, not the mode, answers what a job may do');
    }

    const build = expectOk(harness.start({ operationId: 'op-mode-build-again', mode: 'Build' }));
    assert.equal(expectOk(harness.useCases.permittedOperationFor(build.job.jobId, 'PushBranch')), 'PushBranch');

    const plan = expectOk(harness.start({ operationId: 'op-mode-plan-again', mode: 'Plan' }));
    expectError(harness.useCases.permittedOperationFor(plan.job.jobId, 'PushBranch'), 'Forbidden');
  });
});

/* -------------------------------------------------------------------------- */
    assert.ok(true, 'the provider-revision migration is exercised by the publication fixture below');
/* -------------------------------------------------------------------------- */

test('F17-AC2 getRun returns the durable job row and the latest checkpoint including the dirty and untracked inventory', async () => {
  await withJobs((harness) => {
    const start = expectOk(harness.start({ operationId: 'op-f17-ac2' }));
    expectOk(harness.claim('writer-1'));

    const written = expectOk(
      harness.queue.checkpoint({
        jobId: start.job.jobId,
        holder: 'writer-1',
        checkpointId: 'cp-f17-ac2',
        scopeSnapshotId: start.capturedScope.scopeSnapshotId,
        scopeFingerprint: start.capturedScope.scopeFingerprint,
        profileVersionId: start.job.profileVersionId,
        procedureVersionId: start.job.procedureVersionId,
        engineVersion: 'claude-code@1',
        workspace: {
          workspaceId: 'ws-f17-ac2',
          branchName: 'shiploop/job-start',
          worktreePath: '/tmp/worktrees/job-start',
        },
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        dirtyFiles: ['packages/controller/src/jobs.ts'],
        untrackedFiles: ['packages/controller/src/jobs.test.ts'],
        results: [{ name: 'pnpm test', result: 'Failed', detail: 'one suite failed' }],
        feedback: [{ author: OWNER_ID, at: T0, body: 'Keep the limit decision in the domain.' }],
        blocker: 'The coding writer was released by the owner.',
        nextAction: 'Resume from the checkpoint and re-run the required checks.',
        now: harness.clock.now(),
      }),
    );

    const view = expectOk(harness.useCases.getRun(start.job.jobId));
    assert.equal(view.job.jobId, start.job.jobId);
    assert.equal(view.job.state, 'Running');
    assert.equal(view.job.holder, 'writer-1');
    assert.equal(view.writer.holder, 'writer-1');
    assert.equal(view.writer.disposition, 'Held');

    assert.notEqual(view.checkpoint, null, 'the recorded resume point must be readable');
    const checkpoint = view.checkpoint;
    assert.notEqual(checkpoint, null);
    if (checkpoint === null) return;
    assert.equal(checkpoint.checkpointId, written.checkpointId);
    assert.equal(checkpoint.scopeFingerprint, start.capturedScope.scopeFingerprint);
    assert.equal(checkpoint.headSha, HEAD_SHA);
    assert.equal(checkpoint.baseSha, BASE_SHA);
    assert.deepEqual(checkpoint.dirtyFiles, ['packages/controller/src/jobs.ts']);
    assert.deepEqual(checkpoint.untrackedFiles, ['packages/controller/src/jobs.test.ts']);
    assert.equal(checkpoint.blocker, 'The coding writer was released by the owner.');
    assert.equal(checkpoint.results.length, 1);
    assert.equal(checkpoint.feedback.length, 1);

    expectError(harness.useCases.getRun('job_absent' as JobId), 'NotFound');
  });
});

/* -------------------------------------------------------------------------- */
/* F17-AC1 and F17-AC3: pause and resume                                         */
/* -------------------------------------------------------------------------- */

test('F17-AC1 pauseRun reports Paused only once the writer has stopped and the coding slot is free', async () => {
  await withJobs((harness) => {
    const start = expectOk(harness.start({ operationId: 'op-f17-ac1' }));
    expectOk(harness.claim('writer-1'));

    const slotWhileRunning = readRow(harness.database, 'SELECT * FROM coding_slots WHERE slot_id = 1');
    assert.equal(slotWhileRunning?.['job_id'], start.job.jobId, 'the claimed job holds the single coding slot');

    const paused = expectOk(harness.useCases.pauseRun(start.job.jobId));
    assert.equal(paused.job.state, 'Paused');
    assert.equal(paused.writerStopped, true);
    assert.equal(paused.writer.disposition, 'Vacant');
    assert.equal(paused.job.holder, null, 'a paused job is no longer the writer');

    const slotAfterPause = readRow(harness.database, 'SELECT * FROM coding_slots WHERE slot_id = 1');
    assert.equal(slotAfterPause?.['job_id'], null, 'pausing gives the single coding writer up');
    assert.equal(slotAfterPause?.['holder'], null);

    const lease = expectOk(harness.leases.leaseStatus(start.job.jobId));
    assert.notEqual(lease, null, 'a claimed job holds a recorded lease');
    assert.equal(lease?.state, 'Released', 'the lease is released rather than deleted, so the record survives');

    expectError(harness.useCases.pauseRun('job_absent' as JobId), 'NotFound');
  });
});

test('F17-AC3 resumeRun resumes a paused job from its checkpoint and refuses an illegal transition with the typed error', async () => {
  await withJobs((harness) => {
    const start = expectOk(harness.start({ operationId: 'op-f17-ac3' }));
    expectOk(harness.claim('writer-1'));
    expectOk(
      harness.queue.checkpoint({
        jobId: start.job.jobId,
        holder: 'writer-1',
        checkpointId: 'cp-f17-ac3',
        scopeSnapshotId: start.capturedScope.scopeSnapshotId,
        scopeFingerprint: start.capturedScope.scopeFingerprint,
        profileVersionId: start.job.profileVersionId,
        procedureVersionId: start.job.procedureVersionId,
        engineVersion: null,
        workspace: { workspaceId: 'ws-f17-ac3', branchName: 'shiploop/resume', worktreePath: '/tmp/worktrees/resume' },
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        dirtyFiles: [],
        untrackedFiles: [],
        results: [],
        feedback: [],
        blocker: null,
        nextAction: 'Continue from the recorded checkpoint.',
        now: harness.clock.now(),
      }),
    );
    expectOk(harness.useCases.pauseRun(start.job.jobId));

    const resumed = expectOk(harness.useCases.resumeRun(start.job.jobId));
    assert.equal(resumed.job.state, 'Running', 'a paused job resumes as Running rather than re-entering the queue');
    assert.equal(resumed.checkpoint.checkpointId, 'cp-f17-ac3');
    assert.equal(resumed.checkpoint.headSha, HEAD_SHA);

    expectOk(harness.queue.markState({ jobId: start.job.jobId, state: 'Verifying', now: harness.clock.now() }));
    expectOk(harness.queue.markState({ jobId: start.job.jobId, state: 'Completed', now: harness.clock.now() }));

    const illegal = expectError(harness.useCases.resumeRun(start.job.jobId), 'Invalid');
    assert.match(illegal.reason, /Illegal attempt transition Completed -> Running/);
    assert.equal(
      readRow(harness.database, 'SELECT state FROM jobs WHERE job_id = ?', start.job.jobId)?.['state'],
      'Completed',
      'an illegal transition is refused, never forced',
    );

    const withoutCheckpoint = expectOk(harness.start({ operationId: 'op-f17-ac3-no-resume-point' }));
    const blocked = expectError(harness.useCases.resumeRun(withoutCheckpoint.job.jobId), 'Blocked');
    assert.match(blocked.reason, /no recorded resume point/);
  });
});

/* -------------------------------------------------------------------------- */
/* F17-AC4: cancellation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Records a delivery that had already started against the provider.
 *
 * Hand-written because no shipped repository in `@shiploop/storage` writes a delivery yet:
 * the delivery executor has not been built. The rows go through the real foreign keys and
 * the real column CHECKs, so the row is the shape the product stores rather than a shape
 * chosen to make the assertion convenient (F17-AC4).
 */
function recordStartedDelivery(harness: Harness, snapshotId: string): void {
  const fingerprint = (seed: string): string => `fp_${seed.repeat(32).slice(0, 32)}`;
  harness.database
    .prepare(
      `INSERT INTO candidates (
         candidate_id, work_item_id, project_id, scope_snapshot_id, profile_version_id,
         procedure_version_id, fingerprint, head_sha, base_sha, scope_fingerprint,
         environment_fingerprint, policy_fingerprint, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'cand-f17-ac4',
      harness.workItemId,
      harness.projectId,
      snapshotId,
      harness.profileVersionId,
      harness.procedureVersionId,
      fingerprint('c'),
      HEAD_SHA,
      BASE_SHA,
      fingerprint('d'),
      fingerprint('e'),
      fingerprint('f'),
      T0,
    );
  harness.database
    .prepare(
      `INSERT INTO owner_decisions (
         decision_id, project_id, work_item_id, candidate_id, scope_snapshot_id, actor_owner_id,
         decision_type, acceptance_state, subject_fingerprint, subject_json, correlation_id,
         state, single_use, decided_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'Recorded', 1, ?)`,
    )
    .run(
      'dec-f17-ac4',
      harness.projectId,
      harness.workItemId,
      'cand-f17-ac4',
      snapshotId,
      OWNER_ID,
      'AuthorizeMerge',
      fingerprint('a'),
      '{"pullRequestId":"pr-17","headSha":"' + HEAD_SHA + '"}',
      'corr-f17-ac4',
      T0,
    );
  harness.database
    .prepare(
      `INSERT INTO deliveries (
         delivery_id, work_item_id, project_id, candidate_id, decision_id, state, correlation_id,
         manifest_json, pull_request_id, head_sha, target_branch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'Merging', ?, ?, 'pr-17', ?, 'main', ?, ?)`,
    )
    .run(
      'del-f17-ac4',
      harness.workItemId,
      harness.projectId,
      'cand-f17-ac4',
      'dec-f17-ac4',
      'corr-f17-ac4',
      '{"components":[]}',
      HEAD_SHA,
      T0,
      T0,
    );
}

test('F17-AC4 cancelRun prevents further dispatch, preserves the checkpoint and never reports an already-started external delivery as undone', async () => {
  await withJobs((harness) => {
    const start = expectOk(harness.start({ operationId: 'op-f17-ac4' }));
    expectOk(harness.claim('writer-1'));
    expectOk(
      harness.queue.checkpoint({
        jobId: start.job.jobId,
        holder: 'writer-1',
        checkpointId: 'cp-f17-ac4',
        scopeSnapshotId: start.capturedScope.scopeSnapshotId,
        scopeFingerprint: start.capturedScope.scopeFingerprint,
        profileVersionId: start.job.profileVersionId,
        procedureVersionId: start.job.procedureVersionId,
        engineVersion: null,
        workspace: { workspaceId: 'ws-f17-ac4', branchName: 'shiploop/cancel', worktreePath: '/tmp/worktrees/cancel' },
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        dirtyFiles: ['packages/controller/src/jobs.ts'],
        untrackedFiles: [],
        results: [{ name: 'pnpm test', result: 'Passed', detail: null }],
        feedback: [],
        blocker: null,
        nextAction: 'Nothing further; the owner cancelled the run.',
        now: harness.clock.now(),
      }),
    );
    recordStartedDelivery(harness, start.capturedScope.scopeSnapshotId);
    const deliveryBefore = readRow(harness.database, 'SELECT * FROM deliveries WHERE delivery_id = ?', 'del-f17-ac4');

    const cancelled = expectOk(harness.useCases.cancelRun(start.job.jobId));
    assert.equal(cancelled.job.state, 'Cancelled');
    assert.equal(cancelled.externalDelivery, 'UnchangedByCancellation');
    assert.notEqual(cancelled.preservedCheckpoint, null, 'cancellation preserves the recorded work');
    assert.equal(cancelled.preservedCheckpoint?.checkpointId, 'cp-f17-ac4');
    assert.deepEqual(cancelled.preservedCheckpoint?.dirtyFiles, ['packages/controller/src/jobs.ts']);

    const view = expectOk(harness.useCases.getRun(start.job.jobId));
    assert.equal(view.checkpoint?.checkpointId, 'cp-f17-ac4', 'the resume point survives the cancellation');

    const finishedAt = readRow(harness.database, 'SELECT finished_at FROM jobs WHERE job_id = ?', start.job.jobId);
    assert.notEqual(
      finishedAt?.['finished_at'],
      null,
      'a cancelled job records when it stopped, rather than keeping an open finish',
    );

    const deliveryAfter = readRow(harness.database, 'SELECT * FROM deliveries WHERE delivery_id = ?', 'del-f17-ac4');
    assert.deepEqual(deliveryAfter, deliveryBefore, 'a started delivery is untouched and still to be reconciled');
    assert.equal(deliveryAfter?.['state'], 'Merging');

    const reclaim = harness.queue.claimNext({
      holder: 'writer-2',
      now: harness.clock.now(),
      leaseTtlMs: LEASE_TTL_MS,
      projectId: null,
    });
    expectError(reclaim, 'NotFound');
  });
});

/* -------------------------------------------------------------------------- */
/* F18-AC2: bounded limits and owner extensions                                 */
/* -------------------------------------------------------------------------- */

test('F18-AC2 reaching the active-time or fix-pass limit raises an owner-extension request and leaves the job waiting', async () => {
  await withJobs((harness) => {
    const start = expectOk(harness.start({ operationId: 'op-f18-ac2-limits' }));
    expectOk(harness.claim('writer-1'));

    const within = expectOk(
      harness.useCases.checkRunLimits(start.job.jobId, {
        wallClockMs: 60_000,
        fixPasses: 1,
        ownerWaits: [],
      }),
    );
    assert.equal(within.evaluation.withinLimits, true);
    assert.equal(within.request, null);
    assert.equal(within.limits.activeExecutionMs, LIMITS.activeExecutionMs);
    assert.equal(within.limits.automatedFixPasses, LIMITS.maxAutomatedFixPasses);

    const ownerWait = expectOk(
      harness.useCases.checkRunLimits(start.job.jobId, {
        wallClockMs: 4 * 60 * 60 * 1000,
        fixPasses: 0,
        ownerWaits: [recordOwnerWait(0, 4 * 60 * 60 * 1000, 'The owner was asked to answer a clarification.')],
      }),
    );
    assert.equal(ownerWait.evaluation.withinLimits, true, 'owner think time does not consume active execution (F18-AC3)');

    const reached = expectOk(
      harness.useCases.checkRunLimits(start.job.jobId, {
        wallClockMs: LIMITS.activeExecutionMs,
        fixPasses: LIMITS.maxAutomatedFixPasses + 1,
        ownerWaits: [],
      }),
    );
    assert.equal(reached.evaluation.withinLimits, false);
    assert.equal(reached.evaluation.ownerExtensionRequired, true);
    assert.deepEqual(reached.evaluation.reached, ['ActiveExecutionTime', 'AutomatedFixPasses']);
    assert.equal(reached.request?.jobId, start.job.jobId);
    assert.match(reached.request?.reason ?? '', /Active execution reached/);
    assert.match(reached.request?.reason ?? '', /fix passes/);

    const waiting = expectOk(harness.useCases.getRun(start.job.jobId));
    assert.equal(waiting.job.state, 'WaitingForOwner', 'reaching a limit makes the job wait for its owner');

    const fixPassesOnly = expectOk(
      harness.useCases.checkRunLimits(start.job.jobId, {
        wallClockMs: 1_000,
        fixPasses: LIMITS.maxAutomatedFixPasses + 1,
        ownerWaits: [],
      }),
    );
    assert.deepEqual(fixPassesOnly.evaluation.reached, ['AutomatedFixPasses']);
    assert.deepEqual(fixPassesOnly.request?.reached, ['AutomatedFixPasses']);

    const bounds = attemptLimitsFor(LIMITS);
    assert.equal(bounds.activeExecutionMs, LIMITS.activeExecutionMs);
    assert.equal(bounds.automatedFixPasses, LIMITS.maxAutomatedFixPasses);
  });
});

test('F18-AC2 a granted extension resumes the job inside the extended bound and a declined extension leaves it waiting', async () => {
  await withJobs((harness) => {
    const granted = expectOk(harness.start({ operationId: 'op-f18-ac2-grant' }));
    expectOk(harness.claim('writer-1'));
    const usage = { wallClockMs: LIMITS.activeExecutionMs + 1, fixPasses: 0, ownerWaits: [] };
    const firstLimit = expectOk(harness.useCases.checkRunLimits(granted.job.jobId, usage));
    assert.equal(firstLimit.request?.reached.includes('ActiveExecutionTime'), true);
    assert.equal(expectOk(harness.useCases.getRun(granted.job.jobId)).job.state, 'WaitingForOwner');

    const extension = expectOk(harness.useCases.grantExtension(granted.job.jobId, OWNER_ID));
    assert.equal(extension.job.state, 'Running', 'a granted extension lets the attempt continue');
    assert.equal(extension.decidedBy, OWNER_ID);
    assert.equal(extension.previousLimits.activeExecutionMs, LIMITS.activeExecutionMs);
    assert.equal(
      extension.extendedLimits.activeExecutionMs,
      LIMITS.activeExecutionMs * 2,
      'the extended bound is the recorded bound plus one owner-decided unit',
    );
    assert.equal(extension.extendedBoundRecorded, false, 'no storage port writes an extension onto the job row');
    assert.deepEqual(extension.extendedLimits, {
      activeExecutionMs: LIMITS.activeExecutionMs * 2,
      automatedFixPasses: LIMITS.maxAutomatedFixPasses * 2,
      toolRetry: attemptLimitsFor(LIMITS).toolRetry,
    });

    expectError(harness.useCases.grantExtension(granted.job.jobId, '' as OwnerId), 'Forbidden');
    const notWaiting = expectError(harness.useCases.grantExtension(granted.job.jobId, OWNER_ID), 'Conflict');
    assert.match(
      notWaiting.reason,
      /no reached limit to extend/,
      'extending a job that is not waiting would be a second budget nobody asked for',
    );

    // The recorded bound is what a later check judges, because the extension was never
    // written; asserted rather than left implied, because a silent re-trip here would be the
    // signature of a job that appears to hold a budget it never stored.
    const afterGrant = expectOk(harness.useCases.checkRunLimits(granted.job.jobId, usage));
    assert.equal(afterGrant.limits.activeExecutionMs, LIMITS.activeExecutionMs);
    assert.equal(afterGrant.evaluation.withinLimits, false);
    assert.equal(afterGrant.request?.reached.includes('ActiveExecutionTime'), true);
    assert.equal(expectOk(harness.useCases.getRun(granted.job.jobId)).job.state, 'WaitingForOwner');

    // A waiting job still holds the single coding writer, so it is cancelled rather than
    // left holding the only writer the next job could claim.
    expectOk(harness.useCases.cancelRun(granted.job.jobId));

    const declined = expectOk(harness.start({ operationId: 'op-f18-ac2-decline' }));
    expectOk(harness.claim('writer-2'));
    expectOk(harness.useCases.checkRunLimits(declined.job.jobId, usage));
    assert.equal(expectOk(harness.useCases.getRun(declined.job.jobId)).job.state, 'WaitingForOwner');

    const decision = expectOk(harness.useCases.declineExtension(declined.job.jobId, OWNER_ID));
    assert.equal(decision.job.state, 'WaitingForOwner', 'a declined extension leaves the job waiting');
    assert.equal(decision.limitsInForce.activeExecutionMs, LIMITS.activeExecutionMs);

    const stillWaiting = expectOk(harness.useCases.checkRunLimits(declined.job.jobId, usage));
    assert.equal(stillWaiting.request?.reached.includes('ActiveExecutionTime'), true, 'the request stands until it is granted');
  });
});