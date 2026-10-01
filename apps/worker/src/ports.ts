/**
 * The production bindings for the three ports the durable worker needs (F14-AC1, F17-AC2,
 * F18-AC2, F18-AC3, F20-AC3).
 *
 * `apps/worker/src/live-run.ts` proved that the real modules can be assembled, but it supplied
 * them itself, so a normal `node apps/worker/src/index.ts` had nothing to run with: the workspace
 * had to be loaded from a module specifier, and the owner-extension, feedback and check-result
 * bindings answered `null` and `[]`. Every binding here reads the same durable store the worker
 * owns and the same `@shiploop/verification` workspace module the F14 unit wrote, so a prepared
 * workspace is a real linked worktree and a checkpoint carries facts somebody recorded.
 *
 * Three properties are what make these bindings different from the placeholders they replace:
 *
 *   - the workspace port is a translation of `prepareWorkspace`, `reuseWorkspace` and
 *     `cleanupWorkspace` rather than a second implementation of them, and it re-reads a checkout
 *     through `reuseWorkspace`, so an observation is the repository as it is when it is read
 *     (F14-AC1, F14-AC4, F17-AC3);
 *   - the checkpoint facts come from the rows the owner and the check runner actually wrote: a
 *     recorded change request is owner feedback, a recorded check is a check result, and the live
 *     active-execution budget on the job row is the only durable form of an owner extension
 *     (F17-AC2, F18-AC2, F20-AC3);
 *   - the liveness probe answers from what this process can observe and reports `Unknown` for
 *     everything else, because a probe that guessed `Stopped` would free the single global coding
 *     writer on a guess (F17-AC5).
 */

import { readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { err, invalid, ok } from '@shiploop/domain';
import type { CommitSha, DomainError, Fingerprint, JobId, ProfileVersionId, ProcedureVersionId, Result } from '@shiploop/domain';
import type {
  CandidateRepository,
  CheckpointResult,
  Database,
  FeedbackNote,
  JobCheckpoint,
  JobQueue,
  JobRecord,
  LeaseManager,
  OwnerDecisionRepository,
  ProcedureRepository,
  ProcedureVersion,
  ProjectProfileRepository,
  WorkItemRepository,
} from '@shiploop/storage';
import { SqliteObservationJournal } from '@shiploop/controller';
import {
  cleanupWorkspace,
  createPortBinder,
  deriveWorkspaceId,
  nodeProcessRunner,
  prepareWorkspace,
  readOwnedProcesses,
  reuseWorkspace,
  sqliteWorkspaceOwnership,
  stopOwnedProcessGroup,
  validateRecipe,
} from '@shiploop/verification';
import type {
  IsolatedPort,
  OwnedProcess,
  PreparedWorkspace as VerifiedWorkspace,
  RecipeVersion,
  WorkspaceCleanupOutcome,
  WorkspaceLockDocument,
  WorkspaceOwnership,
  WorkspacePaths,
} from '@shiploop/verification';

import type {
  CheckpointFactsPort,
  OwnerExtension,
  OwnerExtensionPort,
  PreparedWorkspace,
  WorkspaceObservation,
  WorkspacePort,
} from './runner.ts';
import type { HolderLiveness, HolderLivenessPort } from './worker.ts';

/* -------------------------------------------------------------------------- */
/* Workspace                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A workspace port that can also re-read a workspace it already prepared.
 *
 * A checkpoint is written after an attempt's work has settled, so its inventory has to be read at
 * that moment rather than remembered from before the attempt. `observe` is that read, and it is
 * the same read `reuseWorkspace` performs, so the two can never disagree about a worktree
 * (F14-AC4, F17-AC2).
 */
export interface ObservableWorkspacePort extends WorkspacePort {
  observe(request: {
    readonly job: JobRecord;
    readonly workspace: JobCheckpoint['workspace'];
  }): Promise<Result<WorkspaceObservation, DomainError>>;
}

/** What a caller needs to know about a real workspace without holding the whole module value. */
export interface WorkspaceFacts {
  readonly workspaceId: string;
  readonly jobId: JobId;
  readonly branchName: string;
  readonly worktreePath: string;
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  readonly ports: readonly IsolatedPort[];
}

export interface WorkspacePortBinding {
  readonly port: ObservableWorkspacePort;
  factsFor(jobId: JobId): WorkspaceFacts | null;
  /** The lock document a prepared workspace wrote, which is where its process registry lives (F14-AC5). */
  registryPathFor(jobId: JobId): string | null;
  release(jobId: JobId, options: { readonly retainWorkspace: boolean }): Promise<Result<WorkspaceCleanupOutcome, DomainError>>;
}

export interface WorkspacePortSettings {
  readonly database: Database;
  readonly jobs: JobQueue;
  readonly workItems: WorkItemRepository;
  readonly profiles: ProjectProfileRepository;
  readonly procedures: ProcedureRepository;
  /** Absolute path of the connected checkout every task worktree links to (F14-AC1). */
  readonly repository: string;
  /** Absolute directory under which every isolated resource of an attempt is created (F14-AC3). */
  readonly attemptRoot: string;
  /** The writer identity that owns a workspace while the attempt runs (F14-AC1). */
  readonly holder: string;
  /** Prefix of the task branch a workspace is created on. */
  readonly branchPrefix: string;
  now(): string;
}

interface HeldWorkspace {
  readonly workspace: VerifiedWorkspace;
  readonly observation: WorkspaceObservation;
}

function portsRecordOf(workspace: VerifiedWorkspace): Readonly<Record<string, number>> {
  return Object.fromEntries(workspace.ports.map((port) => [port.serviceName, port.port]));
}

function endpointsOf(ports: Readonly<Record<string, number>>): readonly { readonly name: string; readonly baseUrl: string }[] {
  return Object.entries(ports).map(([name, port]) => ({ name, baseUrl: `http://127.0.0.1:${String(port)}` }));
}

function identityOf(workspace: VerifiedWorkspace): JobCheckpoint['workspace'] {
  return {
    workspaceId: workspace.workspaceId,
    branchName: workspace.branchName,
    worktreePath: workspace.paths.worktreePath,
  };
}

/**
 * The production isolated-workspace port (F14-AC1, F14-AC3, F14-AC4, F17-AC3).
 *
 * Preparation, reuse, cleanup, port allocation and the durable lock are all
 * `@shiploop/verification`'s own. This module supplies the project facts those functions need,
 * remembers which workspace each job landed in so a resume and a cleanup can find it, and
 * translates the module's reports into what the worker reads.
 */
export function createWorkspacePort(settings: WorkspacePortSettings): WorkspacePortBinding {
  const held = new Map<JobId, HeldWorkspace>();
  const ownership: WorkspaceOwnership = sqliteWorkspaceOwnership(settings.database);
  const binder = createPortBinder();

  /**
   * The checkout as it is now, read through the module that also decides reuse (F14-AC4).
   *
   * The recorded reading is what the comparison is measured against, so a workspace the attempt
   * changed still reads as itself; a workspace that cannot be read at all is refused rather than
   * reported as clean.
   */
  async function readNow(input: {
    readonly jobId: JobId;
    readonly workspace: JobCheckpoint['workspace'];
    readonly expected: {
      readonly headSha: CommitSha;
      readonly baseSha: CommitSha;
      readonly dirtyFiles: readonly string[];
      readonly untrackedFiles: readonly string[];
    };
  }): Promise<
    Result<
      {
        readonly headSha: CommitSha;
        readonly baseSha: CommitSha;
        readonly dirtyFiles: readonly string[];
        readonly untrackedFiles: readonly string[];
      },
      DomainError
    >
  > {
    const read = await reuseWorkspace(
      {
        checkpoint: {
          checkpointId: `observe:${input.jobId}`,
          workspaceId: input.workspace.workspaceId,
          branchName: input.workspace.branchName,
          worktreePath: input.workspace.worktreePath,
          headSha: input.expected.headSha,
          baseSha: input.expected.baseSha,
          dirtyFiles: input.expected.dirtyFiles,
          untrackedFiles: input.expected.untrackedFiles,
          recordedAt: settings.now(),
        },
        holder: settings.holder,
        now: settings.now(),
      },
      { runCommand: nodeProcessRunner },
    );
    const report = read.ok ? read.value : read.error.report;
    if (report.actualHeadSha === null) {
      return err(
        invalid(`The workspace for job ${input.jobId} could not be read as a Git checkout.`, [
          { path: 'workspace', message: report.divergences[0]?.detail ?? 'The worktree reported no HEAD.' },
        ]),
      );
    }
    return ok({
      headSha: report.actualHeadSha,
      baseSha: input.expected.baseSha,
      dirtyFiles: report.observedDirtyFiles,
      untrackedFiles: report.observedUntrackedFiles,
    });
  }

  async function prepare(request: {
    readonly job: JobRecord;
    readonly checkpoint: JobCheckpoint | null;
  }): Promise<Result<PreparedWorkspace, DomainError>> {
    const job = request.job;
    const snapshot = settings.workItems.getScopeSnapshot(job.scopeSnapshotId);
    if (!snapshot.ok) return snapshot;
    const profile = settings.profiles.getVersion(job.profileVersionId as ProfileVersionId);
    if (!profile.ok) return profile;
    const environment = settings.procedures.getVersion(job.procedureVersionId as ProcedureVersionId);
    if (!environment.ok) return environment;
    const recipe = recipeOf(environment.value);
    if (!recipe.ok) return err(recipe.error);

    const baseRef = profile.value.content.references.baseBranch;
    const branchName = `${settings.branchPrefix}/${job.jobId}`;
    const now = settings.now();
    let workspace: VerifiedWorkspace;

    if (request.checkpoint !== null) {
      const reused = await reuseWorkspace(
        {
          checkpoint: {
            checkpointId: request.checkpoint.checkpointId,
            workspaceId: request.checkpoint.workspace.workspaceId,
            branchName: request.checkpoint.workspace.branchName,
            worktreePath: request.checkpoint.workspace.worktreePath,
            headSha: request.checkpoint.headSha,
            baseSha: request.checkpoint.baseSha,
            dirtyFiles: request.checkpoint.dirtyFiles,
            untrackedFiles: request.checkpoint.untrackedFiles,
            recordedAt: request.checkpoint.recordedAt,
          },
          holder: settings.holder,
          now,
        },
        { runCommand: nodeProcessRunner },
      );
      if (!reused.ok) return err(reused.error.error);
      const restored = await readLockDocument(settings.attemptRoot, request.checkpoint.workspace.workspaceId, job.jobId);
      if (!restored.ok) return restored;
      workspace = restored.value;
    } else {
      const prepared = await prepareWorkspace(
        {
          jobId: job.jobId,
          repository: settings.repository,
          baseRef,
          branchName,
          attemptRoot: settings.attemptRoot,
          holder: settings.holder,
          services: recipe.value.ports.map((port) => ({ serviceName: port.serviceId, port: port.port })),
          now,
        },
        { runCommand: nodeProcessRunner, ports: binder, ownership },
      );
      if (!prepared.ok) return prepared;
      workspace = prepared.value;
      const expected = deriveWorkspaceId({ jobId: job.jobId, repository: settings.repository, branchName });
      if (workspace.workspaceId !== expected) {
        return err(
          invalid(
            `The prepared workspace for job ${job.jobId} is ${workspace.workspaceId}, which the recorded job, repository and branch do not derive.`,
            [{ path: 'workspace', message: 'A workspace identity must be reproducible, or a resume cannot find the workspace it left.' }],
          ),
        );
      }
    }

    const current = await readNow({
      jobId: job.jobId,
      workspace: identityOf(workspace),
      expected: { headSha: workspace.headSha, baseSha: workspace.baseSha, dirtyFiles: [], untrackedFiles: [] },
    });
    if (!current.ok) return current;

    const observation: WorkspaceObservation = {
      workspace: identityOf(workspace),
      headSha: current.value.headSha,
      baseSha: current.value.baseSha,
      dirtyFiles: current.value.dirtyFiles,
      untrackedFiles: current.value.untrackedFiles,
    };
    held.set(job.jobId, { workspace, observation });

    const ports = portsRecordOf(workspace);
    return ok({
      execution: {
        workspaceId: workspace.workspaceId,
        absolutePath: workspace.paths.worktreePath,
        headSha: observation.headSha,
        baseSha: observation.baseSha,
        environmentFingerprint: environment.value.contentFingerprint as Fingerprint,
        scopeFingerprint: snapshot.value.scopeFingerprint,
        isolatedPorts: ports,
        serviceEndpoints: endpointsOf(ports),
        testAccess: { kind: 'None' },
      },
      observation,
      deliveryAlreadyObserved: false,
    });
  }

  /**
   * Re-reads a workspace this port prepared, for the moment a checkpoint is written (F17-AC2).
   *
   * The base is the one recorded when the workspace was prepared, because that is the revision the
   * attempt branched from; the head and the inventory are read now, because that is what the
   * checkpoint has to describe.
   */
  async function observe(request: {
    readonly job: JobRecord;
    readonly workspace: JobCheckpoint['workspace'];
  }): Promise<Result<WorkspaceObservation, DomainError>> {
    const entry = held.get(request.job.jobId);
    if (entry === undefined) {
      return err(
        invalid(
          `Job ${request.job.jobId} has no workspace in this process, so its current state cannot be re-read here.`,
          [{ path: 'workspace', message: 'A workspace observation must come from the workspace this attempt prepared (F14-AC5).' }],
        ),
      );
    }
    const current = await readNow({
      jobId: request.job.jobId,
      workspace: request.workspace,
      expected: entry.observation,
    });
    if (!current.ok) return current;
    return ok({
      workspace: request.workspace,
      headSha: current.value.headSha,
      baseSha: current.value.baseSha,
      dirtyFiles: current.value.dirtyFiles,
      untrackedFiles: current.value.untrackedFiles,
    });
  }

  return {
    port: { prepare, observe },
    factsFor: (jobId) => {
      const entry = held.get(jobId);
      if (entry === undefined) return null;
      return {
        workspaceId: entry.workspace.workspaceId,
        jobId,
        branchName: entry.workspace.branchName,
        worktreePath: entry.workspace.paths.worktreePath,
        headSha: entry.observation.headSha,
        baseSha: entry.observation.baseSha,
        ports: entry.workspace.ports,
      };
    },
    registryPathFor: (jobId) => held.get(jobId)?.workspace.paths.processRegistryPath ?? null,
    release: async (jobId, options) => {
      const entry = held.get(jobId);
      if (entry === undefined) {
        return err(
          invalid(`No workspace was prepared for job ${jobId} in this process, so there is nothing to release.`, [
            { path: 'workspace', message: 'Only the process that prepared a workspace may clean it up (F14-AC5).' },
          ]),
        );
      }
      const processes = await readOwnedProcesses(entry.workspace.paths.processRegistryPath);
      const cleaned = await cleanupWorkspace(
        {
          workspace: entry.workspace,
          processes: processes.ok ? processes.value : ([] as readonly OwnedProcess[]),
          retainWorkspace: options.retainWorkspace,
          now: settings.now(),
        },
        {
          runCommand: nodeProcessRunner,
          ownership,
          stopProcessGroup: stopOwnedProcessGroup,
          removePath: async (path: string): Promise<void> => {
            await rm(path, { recursive: true, force: true });
          },
          now: settings.now,
        },
      );
      if (cleaned.ok) held.delete(jobId);
      return cleaned;
    },
  };
}

/**
 * A retained workspace as the lock document recorded it (F14-AC1, F14-AC5).
 *
 * A resumed attempt runs in a workspace a previous process prepared, and cleanup has to reach the
 * same paths and the same port reservations, so the durable document preparation wrote is what a
 * later process reads rather than a guess at the layout.
 */
async function readLockDocument(
  attemptRoot: string,
  workspaceId: string,
  jobId: JobId,
): Promise<Result<VerifiedWorkspace, DomainError>> {
  const path = join(attemptRoot, 'locks', `${workspaceId}.json`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return err(
      invalid(`The lock document for workspace ${workspaceId} could not be read.`, [
        { path: 'workspace', message: `${path}: ${error instanceof Error ? error.message : String(error)}` },
      ]),
    );
  }
  const parsed = parseLockDocument(raw, workspaceId);
  if (!parsed.ok) return parsed;
  return ok({
    workspaceId,
    jobId,
    owner: parsed.value.owner,
    repositoryPath: parsed.value.repositoryPath,
    baseRef: parsed.value.baseRef,
    baseSha: parsed.value.baseSha,
    branchName: parsed.value.branchName,
    headSha: parsed.value.headSha,
    paths: parsed.value.paths,
    ports: parsed.value.ports,
    lock: {
      workspaceId,
      jobId,
      holder: parsed.value.owner,
      branchName: parsed.value.branchName,
      worktreePath: parsed.value.paths.worktreePath,
      acquiredAt: parsed.value.acquiredAt,
    },
    lockDocument: {
      version: 1,
      workspaceId,
      jobId,
      owner: parsed.value.owner,
      repositoryPath: parsed.value.repositoryPath,
      baseRef: parsed.value.baseRef,
      baseSha: parsed.value.baseSha,
      branchName: parsed.value.branchName,
      worktreePath: parsed.value.paths.worktreePath,
      paths: parsed.value.paths,
      ports: parsed.value.ports,
      headSha: parsed.value.headSha,
      acquiredAt: parsed.value.acquiredAt,
    },
  });
}

interface ParsedLockDocument {
  readonly owner: string;
  readonly repositoryPath: string;
  readonly baseRef: string;
  readonly baseSha: CommitSha;
  readonly branchName: string;
  readonly headSha: CommitSha;
  readonly acquiredAt: string;
  readonly paths: WorkspacePaths;
  readonly ports: readonly IsolatedPort[];
}

function parseLockDocument(raw: string, workspaceId: string): Result<ParsedLockDocument, DomainError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err(
      invalid(`The lock document for workspace ${workspaceId} is not readable JSON.`, [
        { path: 'workspace', message: 'A resume cannot tell which owner, base and paths this workspace has.' },
      ]),
    );
  }
  const document = parsed as Partial<WorkspaceLockDocument>;
  const paths = document.paths;
  const ports = document.ports;
  const usable =
    document !== null &&
    typeof document === 'object' &&
    typeof document.owner === 'string' &&
    typeof document.repositoryPath === 'string' &&
    typeof document.baseRef === 'string' &&
    typeof document.baseSha === 'string' &&
    typeof document.branchName === 'string' &&
    typeof document.headSha === 'string' &&
    typeof document.acquiredAt === 'string' &&
    paths !== null &&
    typeof paths === 'object' &&
    typeof paths.worktreePath === 'string' &&
    Array.isArray(ports) &&
    ports.every(
      (port) =>
        typeof port === 'object' &&
        port !== null &&
        typeof (port as IsolatedPort).serviceName === 'string' &&
        typeof (port as IsolatedPort).port === 'number',
    );
  if (!usable) {
    return err(
      invalid(`The lock document for workspace ${workspaceId} does not describe a workspace.`, [
        {
          path: 'workspace',
          message:
            'Preparation wrote this document, so a document without these fields was edited or restored from an older backup.',
        },
      ]),
    );
  }
  return ok({
    owner: document.owner as string,
    repositoryPath: document.repositoryPath as string,
    baseRef: document.baseRef as string,
    baseSha: document.baseSha as CommitSha,
    branchName: document.branchName as string,
    headSha: document.headSha as CommitSha,
    acquiredAt: document.acquiredAt as string,
    paths: paths as WorkspacePaths,
    ports: ports as readonly IsolatedPort[],
  });
}

/* -------------------------------------------------------------------------- */
/* Checkpoint facts                                                             */
/* -------------------------------------------------------------------------- */

export interface CheckpointFactsSettings {
  readonly database: Database;
  readonly jobs: JobQueue;
  readonly candidates: CandidateRepository;
  readonly decisions: OwnerDecisionRepository;
}

/**
 * The production checkpoint facts (F17-AC2, F18-AC2, F20-AC3).
 *
 * Every answer is read from durable rows. A change request the owner recorded is feedback a
 * resumed attempt should see; a check the run recorded is a result the checkpoint should carry; and
 * an owner extension is read from the job row, because the live active-execution budget beside the
 * limits the job was enqueued with is the only place such a grant can be recorded at all.
 */
export function createCheckpointFactsPort(settings: CheckpointFactsSettings): CheckpointFactsPort {
  const journal = new SqliteObservationJournal(settings.database);
  return {
    feedbackFor: (request) => readFeedback(settings, request.jobId),
    resultsFor: (request) => readResults(settings, journal, request.jobId),
  };
}

/**
 * The production owner-extension port (F18-AC2).
 *
 * The worker asks this separately from the checkpoint facts because the answer decides whether a
 * parked attempt continues, and only a durable record may answer it: a limit the owner has not
 * acted on must leave the job waiting rather than silently lifting the bound.
 */
export function createOwnerExtensionPort(settings: CheckpointFactsSettings): OwnerExtensionPort {
  return { extensionFor: (request) => readExtension(settings, request.jobId) };
}

/**
 * The owner extension recorded for a job, or null when none is (F18-AC2).
 *
 * `jobs.limits` is the bound the job was enqueued with and `jobs.active_budget_ms` is the live
 * active-execution budget, so the difference between them is the extension the owner granted. No
 * column carries the fix-pass allowance or the actor that raised the budget, so this reports no
 * additional passes and attributes the grant to the owner role, the only actor that may raise it;
 * a schema recording either would name it here.
 */
function readExtension(settings: CheckpointFactsSettings, jobId: JobId): OwnerExtension | null {
  const job = settings.jobs.readJob(jobId);
  if (!job.ok || job.value === null) return null;
  const row = settings.database.prepare('SELECT active_budget_ms FROM jobs WHERE job_id = ?').get(jobId);
  const live = row?.['active_budget_ms'];
  if (typeof live !== 'number' || live <= job.value.limits.activeExecutionMs) return null;
  return {
    grantedBy: 'owner',
    grantedAt: job.value.updatedAt,
    additionalActiveMs: live - job.value.limits.activeExecutionMs,
    additionalFixPasses: 0,
  };
}

/** Owner feedback recorded against the job's work item, in the order it was recorded (F17-AC2). */
function readFeedback(settings: CheckpointFactsSettings, jobId: JobId): readonly FeedbackNote[] {
  const workItemId = workItemOf(settings, jobId);
  if (workItemId === null) return [];
  const decisions = settings.decisions.listForWorkItem(workItemId as Parameters<OwnerDecisionRepository['listForWorkItem']>[0]);
  if (!decisions.ok) return [];
  return decisions.value
    .filter((decision) => decision.decisionType === 'RequestChanges' && decision.note !== null)
    .map((decision) => ({ author: decision.actorOwnerId, at: decision.createdAt, body: decision.note ?? '' }));
}

/** Check results recorded against the current candidate of the job's work item (F20-AC3). */
function readResults(
  settings: CheckpointFactsSettings,
  journal: SqliteObservationJournal,
  jobId: JobId,
): readonly CheckpointResult[] {
  const workItemId = workItemOf(settings, jobId);
  if (workItemId === null) return [];
  const candidates = settings.candidates.listForWorkItem(workItemId as Parameters<CandidateRepository['listForWorkItem']>[0]);
  if (!candidates.ok) return [];
  const current = candidates.value[candidates.value.length - 1];
  if (current === undefined) return [];
  const recorded = journal.listChecks(current);
  if (!recorded.ok) return [];
  return recorded.value.map((entry) => ({
    name: entry.record.name,
    result: entry.record.result,
    detail: entry.record.detail,
  }));
}

function workItemOf(settings: CheckpointFactsSettings, jobId: JobId): string | null {
  const job = settings.jobs.readJob(jobId);
  return job.ok && job.value !== null ? job.value.workItemId : null;
}

/* -------------------------------------------------------------------------- */
/* Holder liveness                                                              */
/* -------------------------------------------------------------------------- */

export interface HolderLivenessSettings {
  /** The identity this process writes as the holder of the coding writer (F17-AC5). */
  readonly holder: string;
  readonly leases: LeaseManager;
  /** Where the process registry of a job's workspace is, or null when it has none (F14-AC5). */
  readonly registryPathFor: (jobId: JobId) => string | null;
}

/**
 * The production liveness probe (F17-AC5).
 *
 * It answers from what this process can actually observe: the process groups the recorded attempt
 * registered as its own, and the writer lease. A registered group that no longer exists is the one
 * answer that proves the previous writer stopped, so it is reported as `Stopped` naming the groups
 * that were probed; a group that still answers is `StillWriting`; every other case is `Unknown`,
 * because a missed heartbeat proves only that heartbeats stopped.
 */
export function createHolderLivenessPort(settings: HolderLivenessSettings): HolderLivenessPort {
  return {
    probe: (request) => {
      const lease = settings.leases.leaseStatus(request.jobId);
      if (!lease.ok) {
        return undetermined(request, `the writer lease could not be read (${lease.error.reason})`);
      }
      if (lease.value !== null && lease.value.confirmedStoppedAt !== null) {
        return {
          kind: 'Stopped',
          evidence: `${lease.value.confirmedStoppedBy ?? 'an operator'} recorded at ${lease.value.confirmedStoppedAt} that this holder stopped: ${lease.value.confirmedStoppedEvidence ?? 'no evidence text was recorded with it'} (F17-AC5).`,
        };
      }
      if (lease.value !== null && lease.value.holder === settings.holder && lease.value.state === 'Active') {
        return {
          kind: 'StillWriting',
          evidence: `This process holds the active writer lease for job ${request.jobId}, so it is the writer and nothing may take the job from it (F17-AC5).`,
        };
      }
      const registered = registeredGroupsOf(settings.registryPathFor(request.jobId));
      if (registered.length > 0) {
        const alive = registered.filter((groupId) => isGroupAlive(groupId));
        if (alive.length > 0) {
          return {
            kind: 'StillWriting',
            evidence: `Process group(s) ${alive.join(', ')} registered by the attempt for job ${request.jobId} still answer, so that writer may still be writing (F17-AC5).`,
          };
        }
        return {
          kind: 'Stopped',
          evidence: `Every process group the attempt for job ${request.jobId} registered (${registered.join(', ')}) no longer answers a group existence probe, so no writer that attempt registered is still running (F17-AC5).`,
        };
      }
      return undetermined(
        request,
        lease.value === null
          ? 'no writer lease is recorded for this job'
          : `the recorded holder ${lease.value.holder} is not this process and registered no process group this process may signal`,
      );
    },
  };
}

function undetermined(
  request: { readonly jobId: JobId; readonly holder: string; readonly lastHeartbeatAt: string },
  why: string,
): HolderLiveness {
  return {
    kind: 'Unknown',
    evidence: `This process holds no handle to whatever ran job ${request.jobId} as ${request.holder}, whose last heartbeat was at ${request.lastHeartbeatAt}, and ${why}, so whether it is still writing cannot be established from here (F17-AC5).`,
  };
}

/**
 * The process groups an attempt's registry records as its own.
 *
 * `readOwnedProcesses` is the reader that validates a registry entry, and it is asynchronous,
 * while the worker's reconciliation asks this question synchronously. Only the two fields that
 * make a group this attempt's own are read here, and a registry that cannot be read contributes
 * nothing, so an absent or unreadable registry can never be reported as a stopped writer.
 */
function registeredGroupsOf(registryPath: string | null): readonly number[] {
  if (registryPath === null) return [];
  let raw: string;
  try {
    raw = readFileSync(registryPath, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const processes = (parsed as { processes?: unknown }).processes;
  if (!Array.isArray(processes)) return [];
  const groups: number[] = [];
  for (const entry of processes) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { groupId?: unknown; ownsGroup?: unknown };
    if (candidate.ownsGroup === true && typeof candidate.groupId === 'number' && Number.isInteger(candidate.groupId) && candidate.groupId > 0) {
      groups.push(candidate.groupId);
    }
  }
  return groups;
}

function isGroupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Recipe                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The environment recipe a stored procedure version holds (F04-AC1, F20-AC1).
 *
 * The document is parsed and re-validated through the verification package's own
 * `validateRecipe` rather than cast, because a row can be edited or restored from an older backup
 * and a check command or a port read from a malformed document is something this process would run.
 */
export function recipeOf(procedure: ProcedureVersion): Result<RecipeVersion, DomainError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(procedure.content);
  } catch {
    return err(
      invalid('The stored environment recipe could not be read.', [
        { path: procedure.subjectKey, message: 'The stored recipe document is not valid JSON.' },
      ]),
    );
  }
  const validated = validateRecipe(parsed as Parameters<typeof validateRecipe>[0]);
  if (!validated.ok) return err(validated.error);
  return ok(validated.value);
}
