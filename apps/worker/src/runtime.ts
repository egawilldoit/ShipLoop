/**
 * The worker's production composition root (F13-AC2, F14-AC1, F15-AC1, F19-AC1, F20-AC1, F24-AC3).
 *
 * `apps/worker/src/live-run.ts` proved the real modules fit together, but it assembled them
 * itself, so the shipped entrypoint had nothing to assemble them from: the workspace came from a
 * module specifier named in the environment, the owner-extension, feedback and check-result ports
 * answered `null` and `[]`, and nothing in the worker committed, pushed or opened a draft. This
 * module is the missing half. It reads the environment once, opens the real migrated store, and
 * binds the real engine, the real workspace module, the real Git adapter, the real check runner
 * and the real controller use cases, so a normal `node apps/worker/src/index.ts` configured by
 * environment alone can run a job from the queue to a linked draft.
 *
 * Three decisions are why this is a composition root rather than wiring inside `worker.ts`:
 *
 *   - **the loop lives here.** Delivery has to happen between an attempt completing and the next
 *     claim, and `Worker.run` offers no seam for that, so the runtime drives `Worker.tick` and
 *     reacts to each attempt's outcome (F19-AC1);
 *   - **delivery is one step in one order.** The workspace is re-read through the provider, a run
 *     with no code change states a no-code outcome and opens nothing, and a run with a change
 *     commits, pushes, opens or reuses exactly one draft, records the candidate against the commit
 *     that was pushed, runs the required checks against that same code, and rewrites the draft with
 *     what they reported (F19-AC1, F19-AC3, F19-AC5, F20-AC1);
 *   - **an engine success is not a delivery success.** A `Succeeded` engine outcome starts delivery
 *     and proves nothing about it. A required check that is not `Passed` leaves the candidate not
 *     ready, records a blocker for the owner, and is written into the draft as the failure it was
 *     (F20-AC2, F20-AC4, F24-AC3).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { candidateFingerprint, err, invalid, ok, redact } from '@shiploop/domain';
import type {
  CandidateIdentity,
  CheckResult,
  CommitSha,
  ConnectorId,
  CriterionStatus,
  DomainError,
  JobId,
  ProfileVersionId,
  ProjectId,
  ProcedureVersionId,
  ProviderId,
  Result,
  WorkItemId,
} from '@shiploop/domain';
import { CodexEngineAdapter, GitHubGitAdapter, createGitTransport } from '@shiploop/adapters';
import type {
  AdapterClock,
  AdapterContext,
  AdapterLogger,
  ArtifactReference,
  DraftBody,
  DraftLinkTarget,
  GitRepositoryRef,
  GitTransport,
  UpsertDraftOutcome,
  VerificationClaim,
} from '@shiploop/adapters';
import {
  AttentionItemRepository,
  CandidateRepository,
  OwnerDecisionRepository,
  ProcedureRepository,
  ProjectProfileRepository,
  WorkItemRepository,
  createJobQueue,
  createLeaseManager,
} from '@shiploop/storage';
import type {
  CandidateRecord,
  Database,
  JobQueue,
  JobRecord,
  LeaseManager,
  WorkItemRecord,
} from '@shiploop/storage';
import { RECIPE_SUBJECT_KEY, SqliteObservationJournal, createVerificationUseCases } from '@shiploop/controller';
import type {
  LocalCheckRequest,
  ObservationJournal,
  ProjectCheckPolicy,
  ProjectChecks,
  ProjectEnvironment,
  ProjectEnvironmentReader,
  ProviderCheckReader,
} from '@shiploop/controller';
import { MAX_CHECK_OUTPUT_BYTES, allowlistedEnv, nodeProcessRunner, runCheck } from '@shiploop/verification';
import type {
  CheckCommand,
  CheckExecutionRecord,
  CommandRunResult,
  CommandRunnerPort,
  RequiredCheckPolicy,
} from '@shiploop/verification';

import { readWorkerConfig } from './config.ts';
import type { ConfigProblem } from './config.ts';
import { createCheckpointFactsPort, createHolderLivenessPort, createOwnerExtensionPort, createWorkspacePort, recipeOf } from './ports.ts';
import type { ObservableWorkspacePort, WorkspaceFacts, WorkspacePortBinding } from './ports.ts';
import { createWorker, openWorkerStore } from './worker.ts';
import type { AttemptOutcome } from './runner.ts';
import type { TickReport, Worker, WorkerConfig, WorkerPorts } from './worker.ts';

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The value that names the built-in isolated-workspace provider.
 *
 * `readWorkerConfig` requires a workspace provider because, when it was written, no module in this
 * repository provided one. The production provider now lives in `ports.ts`, so this is what a start
 * without `SHIPLOOP_WORKER_WORKSPACE_MODULE` is given: a normal start configures no module, and a
 * deployment that names one still replaces the built-in provider with its own (F14-AC1).
 */
export const BUILT_IN_WORKSPACE_PROVIDER = 'shiploop:verification-workspace';

const DEFAULT_BRANCH_PREFIX = 'shiploop/task';
const DEFAULT_COMMIT_NAME = 'ShipLoop Worker';
const DEFAULT_COMMIT_EMAIL = 'shiploop@shiploop.invalid';
const DEFAULT_GIT_REMOTE = 'origin';
const DEFAULT_CHECK_TIMEOUT_MS = 600_000;
const ENGINE_EVENT_LIMIT = 2_000;

export interface CommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface GitSettings {
  /** Read from the environment, never logged and never stored (N02-AC2). */
  readonly token: string;
  /** Null means the provider's own base URL; set only to point the adapter at another surface. */
  readonly apiBaseUrl: string | null;
  readonly remoteName: string;
}

export interface RuntimeConfig {
  readonly databasePath: string;
  readonly holder: string;
  readonly projectId: ProjectId | null;
  readonly leaseTtlMs: number;
  readonly pollIntervalMs: number;
  readonly gracefulStopMs: number;
  readonly killWaitMs: number;
  readonly engine: { readonly binary: string; readonly sandbox: 'read-only' | 'workspace-write' };
  /** Absolute path of the connected checkout the built-in provider links task worktrees to. */
  readonly repository: string | null;
  /** Absolute root under which every attempt's isolated resources are created (F14-AC3). */
  readonly attemptRoot: string | null;
  /** Absolute directory check output is written under, so a record never carries raw output. */
  readonly artifactRoot: string;
  readonly branchPrefix: string;
  readonly commitAuthor: CommitAuthor;
  readonly git: GitSettings;
  /** Provider specifier replacing the built-in workspace provider, or null for the built-in one. */
  readonly workspaceModule: string | null;
}

export type RuntimeConfigResult =
  | { readonly ok: true; readonly value: RuntimeConfig }
  | { readonly ok: false; readonly errors: readonly ConfigProblem[] };

/**
 * Reads the production configuration from the environment, once (F13-AC2).
 *
 * The settings `readWorkerConfig` already validates are read through it rather than parsed again,
 * so the lease-term rule and the sandbox allowlist stay the single decision points. The delivery
 * settings are added here because they belong to the composition root: a connected repository, an
 * attempt root, an artifact root and a Git credential, none of which the loop needs before a job
 * exists.
 *
 * The repository and the attempt root are required only when the built-in workspace provider is
 * the one in use. A deployment that names its own provider configures that provider itself, and a
 * worker with no provider of its own may not invent a worktree (F14-AC1).
 */
export function readRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfigResult {
  const base = readWorkerConfig({
    ...env,
    SHIPLOOP_WORKER_WORKSPACE_MODULE: env['SHIPLOOP_WORKER_WORKSPACE_MODULE'] ?? BUILT_IN_WORKSPACE_PROVIDER,
  });
  if (!base.ok) return { ok: false, errors: base.errors };

  const builtIn = base.value.workspaceModule === BUILT_IN_WORKSPACE_PROVIDER;
  const errors: ConfigProblem[] = [];
  const repository = readPath(env['SHIPLOOP_WORKER_REPOSITORY'], 'SHIPLOOP_WORKER_REPOSITORY', builtIn, errors);
  const attemptRoot = readPath(
    env['SHIPLOOP_WORKER_ATTEMPT_ROOT'] ?? defaultAttemptRoot(base.value.databasePath),
    'SHIPLOOP_WORKER_ATTEMPT_ROOT',
    builtIn,
    errors,
  );
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      databasePath: base.value.databasePath,
      holder: base.value.holder,
      projectId: base.value.projectId,
      leaseTtlMs: base.value.leaseTtlMs,
      pollIntervalMs: base.value.pollIntervalMs,
      gracefulStopMs: base.value.gracefulStopMs,
      killWaitMs: base.value.killWaitMs,
      engine: base.value.engine,
      repository,
      attemptRoot,
      artifactRoot: resolvePath(env['SHIPLOOP_WORKER_ARTIFACT_ROOT'] ?? join(attemptRoot ?? defaultAttemptRoot(base.value.databasePath), 'artifacts')),
      branchPrefix: text(env['SHIPLOOP_WORKER_BRANCH_PREFIX']) ?? DEFAULT_BRANCH_PREFIX,
      commitAuthor: {
        name: text(env['SHIPLOOP_WORKER_COMMIT_NAME']) ?? DEFAULT_COMMIT_NAME,
        email: text(env['SHIPLOOP_WORKER_COMMIT_EMAIL']) ?? DEFAULT_COMMIT_EMAIL,
      },
      git: {
        token: text(env['SHIPLOOP_WORKER_GITHUB_TOKEN']) ?? '',
        apiBaseUrl: text(env['SHIPLOOP_WORKER_GITHUB_API_BASE_URL']),
        remoteName: text(env['SHIPLOOP_WORKER_GIT_REMOTE']) ?? DEFAULT_GIT_REMOTE,
      },
      workspaceModule: builtIn ? null : base.value.workspaceModule,
    },
  };
}

function text(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function defaultAttemptRoot(databasePath: string): string {
  return join(dirname(databasePath), 'shiploop-attempts');
}

function readPath(raw: string | undefined, name: string, required: boolean, errors: ConfigProblem[]): string | null {
  const value = text(raw);
  if (value !== null) return resolvePath(value);
  if (required) {
    errors.push({
      path: name,
      message: `The built-in workspace provider links task worktrees to a connected checkout and writes every isolated resource under a root, so this worker needs ${name} to name one (F14-AC1, F14-AC3).`,
    });
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The runtime                                                                 */
/* -------------------------------------------------------------------------- */

export type DeliveryOutcome =
  | { readonly kind: 'NoCodeOutcome'; readonly jobId: JobId; readonly reason: string; readonly branchState: string }
  | {
      readonly kind: 'DraftWritten';
      readonly jobId: JobId;
      readonly headSha: CommitSha;
      readonly pullRequestId: ProviderId | null;
      readonly write: UpsertDraftOutcome['kind'];
      readonly notReady: readonly string[];
    }
  | { readonly kind: 'Refused'; readonly jobId: JobId; readonly reason: string };

/** One iteration of the loop and what delivery made of the attempt it drove. */
export interface TickResult {
  readonly tick: TickReport;
  readonly delivery: DeliveryOutcome | null;
}

export interface RuntimeRunReport {
  readonly ticks: number;
  readonly claimed: number;
  readonly completed: number;
  readonly blocked: number;
  readonly waitingForOwner: number;
  readonly paused: number;
  readonly detached: number;
  readonly idle: number;
  readonly deliveries: readonly DeliveryOutcome[];
  readonly errors: readonly string[];
}

export interface WorkerRuntime {
  /** One iteration, followed by delivery for an attempt that completed. */
  tick(): Promise<Result<TickResult, DomainError>>;
  run(signal: AbortSignal): Promise<RuntimeRunReport>;
  /**
   * Delivers one completed attempt.
   *
   * Exposed because a delivery is retried after a lost provider response: the adapter's own
   * reconciliation read is what makes the retry reach the draft that already exists rather than a
   * second one (F19-AC3).
   */
  deliver(jobId: JobId): Promise<Result<DeliveryOutcome, DomainError>>;
  /** What the workspace provider holds for a job, or null when it is not the provider in use. */
  workspaceFor(jobId: JobId): WorkspaceFacts | null;
  /** Asks a live attempt to stop, so a signal stops the engine before the loop ends (F17-AC1). */
  requestStop(): void;
  stopRequested(): boolean;
  close(): Result<true, DomainError>;
}

const systemClock: AdapterClock = {
  now: (): string => new Date().toISOString(),
  elapsedMs: (): number => Number(process.hrtime.bigint() / 1_000n),
};

/** Lifecycle lines only; the delivery transcript travels in the run report (N06-AC1). */
function lifecycleLogger(): AdapterLogger {
  return {
    emit(record): void {
      if (record.level === 'Error') console.error(`${record.level} ${record.message}`);
      else if (record.level === 'Warn') console.warn(`${record.level} ${record.message}`);
    },
  };
}

/**
 * Builds the production runtime (F01-AC1, F13-AC2, F14-AC1).
 *
 * Nothing is returned unless the store opened and migrated, the workspace provider is one this
 * process can use, and the worker was built over the store, so a refused runtime leaves no handle
 * behind rather than handing a caller a queue whose first statement the schema does not have.
 */
export async function createWorkerRuntime(config: RuntimeConfig): Promise<Result<WorkerRuntime, DomainError>> {
  const store = openWorkerStore(config.databasePath);
  if (!store.ok) return store;
  const database: Database = store.value.database;

  const jobs: JobQueue = createJobQueue({ connection: database });
  const leases: LeaseManager = createLeaseManager({ connection: database });
  const workItems = new WorkItemRepository(database);
  const attention = new AttentionItemRepository(database);
  const candidates = new CandidateRepository(database);
  const decisions = new OwnerDecisionRepository(database);
  const profiles = new ProjectProfileRepository(database);
  const procedures = new ProcedureRepository(database);
  const journal: ObservationJournal = new SqliteObservationJournal(database);
  const factsSettings = { database, jobs, candidates, decisions };

  const bound = await bindWorkspaces(config, { database, jobs, workItems, profiles, procedures });
  if (!bound.ok) {
    store.value.close();
    return bound;
  }
  const workspaces = bound.value;

  const workerConfig: WorkerConfig = {
    holder: config.holder,
    projectId: config.projectId,
    leaseTtlMs: config.leaseTtlMs,
    pollIntervalMs: config.pollIntervalMs,
    engineEventLimit: ENGINE_EVENT_LIMIT,
  };
  const ports: WorkerPorts = {
    clock: systemClock,
    logger: lifecycleLogger(),
    redact: (value: string): string => redact(value).text,
    engine: new CodexEngineAdapter({
      connectorId: `engine_${config.holder}` as ConnectorId,
      client: {
        binary: config.engine.binary,
        gracefulStopMs: config.gracefulStopMs,
        killWaitMs: config.killWaitMs,
      },
      sandbox: config.engine.sandbox,
    }),
    queue: jobs,
    leases,
    workItems,
    attention,
    workspaces: workspaces.port,
    extensions: createOwnerExtensionPort(factsSettings),
    facts: createCheckpointFactsPort(factsSettings),
    liveness: createHolderLivenessPort({
      holder: config.holder,
      leases,
      registryPathFor: (jobId) => workspaces.registryPathFor(jobId),
    }),
    sleep: async (ms: number): Promise<void> => {
      await delay(ms);
    },
  };

  const worker: Result<Worker, DomainError> = createWorker(workerConfig, ports);
  if (!worker.ok) {
    store.value.close();
    return worker;
  }

  const deliver = createDelivery({
    config,
    jobs,
    workItems,
    attention,
    candidates,
    profiles,
    procedures,
    journal,
    workspaces,
  });

  let closed = false;
  const close = (): Result<true, DomainError> => {
    if (closed) return ok(true);
    closed = true;
    return store.value.close();
  };

  const tick = async (): Promise<Result<TickResult, DomainError>> => {
    const reported = await worker.value.tick();
    if (!reported.ok) return reported;
    if (reported.value.kind !== 'Claimed' || reported.value.outcome.kind !== 'Completed') {
      return ok({ tick: reported.value, delivery: null });
    }
    const delivered = await deliver(reported.value.jobId);
    if (!delivered.ok) {
      console.error(`Error delivery for job ${reported.value.jobId} was refused: ${delivered.error.reason}`);
      return err(delivered.error);
    }
    return ok({ tick: reported.value, delivery: delivered.value });
  };

  const runtime: WorkerRuntime = {
    tick,
    run: async (signal) => {
      const report = {
        ticks: 0,
        claimed: 0,
        completed: 0,
        blocked: 0,
        waitingForOwner: 0,
        paused: 0,
        detached: 0,
        idle: 0,
        deliveries: [] as DeliveryOutcome[],
        errors: [] as string[],
      };
      while (!signal.aborted) {
        const reported = await tick();
        report.ticks += 1;
        if (!reported.ok) {
          report.errors.push(reported.error.reason);
        } else {
          const observed = reported.value.tick;
          if (observed.kind === 'Claimed') {
            report.claimed += 1;
            countOutcome(report, observed.outcome.kind);
            if (reported.value.delivery !== null) report.deliveries.push(reported.value.delivery);
          } else if (observed.kind === 'Idle') {
            report.idle += 1;
          }
        }
        if (signal.aborted) break;
        await delay(config.pollIntervalMs);
      }
      return report;
    },
    deliver,
    workspaceFor: (jobId) => workspaces.factsFor(jobId),
    requestStop: () => worker.value.requestStop(),
    stopRequested: () => worker.value.stopRequested(),
    close,
  };
  return ok(runtime);
}

interface OutcomeTally {
  completed: number;
  blocked: number;
  waitingForOwner: number;
  paused: number;
  detached: number;
}

function countOutcome(report: OutcomeTally, kind: AttemptOutcome['kind']): void {
  if (kind === 'Completed') report.completed += 1;
  else if (kind === 'Blocked' || kind === 'Failed') report.blocked += 1;
  else if (kind === 'WaitingForOwner') report.waitingForOwner += 1;
  else if (kind === 'Stopped') report.paused += 1;
  else if (kind === 'WriterDetached') report.detached += 1;
}

interface WorkspaceBinding {
  readonly port: ObservableWorkspacePort;
  factsFor(jobId: JobId): WorkspaceFacts | null;
  registryPathFor(jobId: JobId): string | null;
}

/**
 * The workspace provider this process runs with (F14-AC1).
 *
 * The built-in provider is the real `@shiploop/verification` module bound to the configuration; a
 * named provider module replaces it, and is then responsible for reporting the workspace identity
 * it created, because delivery has to know which worktree a pushed branch came from.
 */
async function bindWorkspaces(
  config: RuntimeConfig,
  repositories: {
    readonly database: Database;
    readonly jobs: JobQueue;
    readonly workItems: WorkItemRepository;
    readonly profiles: ProjectProfileRepository;
    readonly procedures: ProcedureRepository;
  },
): Promise<Result<WorkspaceBinding, DomainError>> {
  if (config.workspaceModule === null) {
    if (config.repository === null || config.attemptRoot === null) {
      return err(
        invalid('The built-in workspace provider has no repository or attempt root to work with.', [
          { path: 'repository', message: 'Set SHIPLOOP_WORKER_REPOSITORY and SHIPLOOP_WORKER_ATTEMPT_ROOT, or name a workspace provider module (F14-AC1, F14-AC3).' },
        ]),
      );
    }
    const binding: WorkspacePortBinding = createWorkspacePort({
      ...repositories,
      repository: config.repository,
      attemptRoot: config.attemptRoot,
      holder: config.holder,
      branchPrefix: config.branchPrefix,
      now: systemClock.now,
    });
    return ok({
      port: binding.port,
      factsFor: (jobId) => binding.factsFor(jobId),
      registryPathFor: (jobId) => binding.registryPathFor(jobId),
    });
  }

  const loaded: unknown = await import(config.workspaceModule);
  const candidate =
    typeof loaded === 'object' && loaded !== null
      ? (loaded as { readonly createWorkspacePort?: unknown }).createWorkspacePort
      : undefined;
  if (typeof candidate !== 'function') {
    return err(
      invalid(`${config.workspaceModule} is not an isolated-workspace provider.`, [
        { path: 'workspaceModule', message: 'It must export a createWorkspacePort function returning a WorkspacePort (F14-AC1).' },
      ]),
    );
  }
  const factory = candidate as () => ObservableWorkspacePort | Promise<ObservableWorkspacePort>;
  const port = await factory();
  return ok({
    port,
    factsFor: () => null,
    registryPathFor: () => null,
  });
}

/* -------------------------------------------------------------------------- */
/* Delivery                                                                    */
/* -------------------------------------------------------------------------- */

interface DeliveryDeps {
  readonly config: RuntimeConfig;
  readonly jobs: JobQueue;
  readonly workItems: WorkItemRepository;
  readonly attention: AttentionItemRepository;
  readonly candidates: CandidateRepository;
  readonly profiles: ProjectProfileRepository;
  readonly procedures: ProcedureRepository;
  readonly journal: ObservationJournal;
  readonly workspaces: WorkspaceBinding;
}

type Deliverer = (jobId: JobId) => Promise<Result<DeliveryOutcome, DomainError>>;

interface GitPair {
  readonly transport: GitTransport;
  readonly git: GitHubGitAdapter;
}

/**
 * The delivery step: what happens after an attempt completed (F19-AC1, F19-AC5, F20-AC1, F24-AC3).
 *
 * The order is the design. The workspace is re-read through the provider, so what is committed is
 * what the attempt actually left. A run with no code change states a no-code outcome and opens
 * nothing, because a draft with no change behind it is a fabricated deliverable. Otherwise the work
 * is committed, the branch is pushed, and one draft is created or reused through the adapter's own
 * reconciliation read; the candidate is recorded against the commit that was pushed, so the pull
 * request identity is durable with it; the required checks then run against that same code, and the
 * draft is rewritten with what they reported. A required check that is not `Passed` records a
 * blocker and leaves the candidate not ready, whatever the engine reported.
 */
function createDelivery(deps: DeliveryDeps): Deliverer {
  return async (jobId: JobId): Promise<Result<DeliveryOutcome, DomainError>> => {
    const found = deps.jobs.readJob(jobId);
    if (!found.ok) return err(found.error);
    if (found.value === null) {
      return err({ code: 'NotFound', reason: `Job ${jobId} is not recorded, so there is nothing to deliver.` });
    }
    const job = found.value;
    const facts = deps.workspaces.factsFor(jobId);
    if (facts === null) {
      return refused(job, `The workspace for job ${jobId} is not held by this process, so what the attempt produced cannot be delivered (F19-AC1).`);
    }
    const snapshot = deps.workItems.getScopeSnapshot(job.scopeSnapshotId);
    if (!snapshot.ok) return err(snapshot.error);
    const work = deps.workItems.get(job.workItemId as WorkItemId);
    if (!work.ok) return err(work.error);
    const profile = deps.profiles.getVersion(job.profileVersionId as ProfileVersionId);
    if (!profile.ok) return err(profile.error);
    const procedure = deps.procedures.getVersion(job.procedureVersionId as ProcedureVersionId);
    if (!procedure.ok) return err(procedure.error);
    const recipe = recipeOf(procedure.value);
    if (!recipe.ok) return err(recipe.error);

    const current = await deps.workspaces.port.observe({
      job,
      workspace: { workspaceId: facts.workspaceId, branchName: facts.branchName, worktreePath: facts.worktreePath },
    });
    if (!current.ok) return err(current.error);

    const repository: GitRepositoryRef = {
      provider: 'github',
      fullName: profile.value.content.references.repository,
      defaultBranch: profile.value.content.references.baseBranch,
      url: profile.value.content.references.repository,
    };

    if (current.value.headSha === facts.baseSha && current.value.dirtyFiles.length === 0 && current.value.untrackedFiles.length === 0) {
      return declareNoCode(deps, job, facts, current.value, repository, work.value, snapshot.value.issueIdentifier);
    }

    const pair = gitPairFor(deps.config, facts.worktreePath);
    if (!pair.ok) return refused(job, pair.error.reason);
    const git = pair.value.git;
    const context = adapterContextFor(job);

    const committed = await commitWorkspace(deps.config, pair.value, context, snapshot.value.title);
    if (!committed.ok) return refused(job, `The attempt's work could not be committed, so nothing was delivered: ${committed.error.reason} (F19-AC1).`);

    const pushed = await git.pushBranch(context, {
      operationId: job.operationId,
      repository,
      branch: facts.branchName,
      headSha: committed.value,
      forceStrategy: 'RejectNonFastForward',
    });
    if (!pushed.ok) {
      return refused(job, `The task branch could not be pushed, so nothing was delivered: ${pushed.error.reason} (F19-AC1, F19-AC4).`);
    }

    const link = linkTargetFor(work.value);
    const drafts = await git.findDrafts(context, { repository, headSha: committed.value, link, operationId: job.operationId });
    if (!drafts.ok) return refused(job, `The existing drafts for this branch could not be read: ${drafts.error.reason} (F19-AC3).`);

    const opened = await git.upsertDraft(context, {
      operationId: job.operationId,
      repository,
      baseBranch: profile.value.content.references.baseBranch,
      headSha: committed.value,
      existingDraft: drafts.value[0] ?? null,
      title: snapshot.value.title,
      body: draftBody({
        purpose: `Deliver the work the owner asked for in ${snapshot.value.issueIdentifier}.`,
        scope: snapshot.value.description,
        criteria: snapshot.value.acceptanceCriteria.map((criterion) => ({
          criterionId: criterion.id,
          text: criterion.text,
          claim: { kind: 'NotRun', reason: 'The required checks for this candidate have not run yet.' },
        })),
        link,
      }),
      link,
    });
    if (!opened.ok) {
      return refused(job, `The linked draft could not be written: ${opened.error.reason} (F19-AC1, F19-AC4).`);
    }

    const candidate = recordCandidate(deps, job, {
      headSha: committed.value,
      baseSha: facts.baseSha,
      scopeFingerprint: snapshot.value.scopeFingerprint,
      profileVersionId: profile.value.profileVersionId,
      procedureVersionId: procedure.value.procedureVersionId as ProcedureVersionId,
      environmentFingerprint: procedure.value.contentFingerprint,
      policyFingerprint: profile.value.contentFingerprint,
      components: [],
    }, opened.value.draft.pullRequest.pullRequestId, profile.value.content.references.targetBranch);
    if (!candidate.ok) return err(candidate.error);

    const verification = createVerificationUseCases({
      clock: systemClock,
      git: providerChecksOf(git, context, repository),
      checks: projectChecksOf(deps.config, facts.worktreePath, profile.value),
      evidence: deps.journal,
      candidates: deps.candidates,
      scope: deps.workItems,
      workItems: deps.workItems,
      procedureVersions: environmentReaderOf(deps),
    });

    const required = await verification.runRequiredChecks(candidate.value, job.projectId);
    if (!required.ok) return refused(job, `The required checks could not be collected: ${required.error.reason} (F20-AC1).`);
    const card = verification.buildReviewCard(candidate.value);
    if (!card.ok) return refused(job, `The review card for this candidate could not be built: ${card.error.reason} (F24-AC2).`);

    /**
     * A required check that is not `Passed` is a blocker, whatever the engine reported (F20-AC2).
     *
     * The reasons come from the card's own readiness rules rather than from this layer, and a check
     * that is absent, stale or not applicable is as blocking as one that failed: a gate nobody ran
     * has not been passed (F20-AC2, F20-AC3).
     */
    const blocking = card.value.checks.filter((check) => check.required && check.blocking);
    if (blocking.length > 0) {
      const blocker = deps.attention.upsert({
        dedupKey: `CheckBlocker:${job.jobId}`,
        kind: 'Blocker',
        projectId: job.projectId,
        workItemId: job.workItemId as WorkItemId,
        issueIdentifier: snapshot.value.issueIdentifier,
        title: `The candidate for job ${job.jobId} is not ready for the owner's test`,
        blocker: blocking
          .map((check) => `Required check "${check.name}" is ${check.result}${check.detail === null ? '' : `: ${check.detail.split('\n')[0] ?? ''}`}.`)
          .join(' '),
        nextAction: 'Fix the failing required check, or change the required-check policy through the project profile, then start another attempt (F20-AC5).',
        candidateFingerprint: candidate.value.candidateFingerprint,
        observedAt: systemClock.now(),
        resolved: false,
      });
      if (!blocker.ok) return err(blocker.error);
    }

    const updated = await git.upsertDraft(context, {
      operationId: job.operationId,
      repository,
      baseBranch: profile.value.content.references.baseBranch,
      headSha: committed.value,
      existingDraft: opened.value.draft,
      title: snapshot.value.title,
      body: draftBody({
        purpose: `Deliver the work the owner asked for in ${snapshot.value.issueIdentifier}.`,
        scope: snapshot.value.description,
        criteria: snapshot.value.acceptanceCriteria.map((criterion) => ({
          criterionId: criterion.id,
          text: criterion.text,
          claim: criterionClaim(card.value.criteria, card.value.checks, criterion.id),
        })),
        link,
        checks: card.value.checks
          .filter((check) => check.required)
          .map((check) => ({ name: check.name, claim: checkClaim(check.name, check.result) })),
      }),
      link,
    });
    if (!updated.ok) {
      return refused(job, `The linked draft could not be updated with the check results: ${updated.error.reason} (F19-AC2).`);
    }

    return ok({
      kind: 'DraftWritten',
      jobId: job.jobId,
      headSha: committed.value,
      pullRequestId: opened.value.draft.pullRequest.pullRequestId,
      write: updated.value.kind,
      notReady: card.value.notReady,
    });
  };
}

/**
 * F19-AC5: a run that produced no code states that, and opens nothing.
 *
 * The provider is asked which branch state exists rather than assuming one, because "never pushed"
 * and "pushed without a draft" are different facts and reporting the wrong one would tell the owner
 * a change exists when none does. The attention vocabulary has no no-code kind, so the outcome is
 * recorded as run progress naming the branch state, which is the owner-visible surface a run
 * already uses.
 */
async function declareNoCode(
  deps: DeliveryDeps,
  job: JobRecord,
  facts: WorkspaceFacts,
  observation: { readonly headSha: CommitSha; readonly dirtyFiles: readonly string[]; readonly untrackedFiles: readonly string[] },
  repository: GitRepositoryRef,
  work: WorkItemRecord,
  issueIdentifier: string,
): Promise<Result<DeliveryOutcome, DomainError>> {
  const pair = gitPairFor(deps.config, facts.worktreePath);
  if (!pair.ok) return refused(job, pair.error.reason);
  const declared = await pair.value.git.declareNoCodeOutcome(adapterContextFor(job), {
    operationId: job.operationId,
    repository,
    branch: facts.branchName,
    reason: 'NoChangeRequired',
    evidence: [workspaceEvidence(job, observation)],
    declaredAt: systemClock.now(),
  });
  if (!declared.ok) return refused(job, `The no-code outcome could not be recorded: ${declared.error.reason} (F19-AC5).`);
  const recorded = deps.attention.upsert({
    dedupKey: `NoCodeOutcome:${job.jobId}`,
    kind: 'RunProgress',
    projectId: job.projectId,
    workItemId: work.workItemId,
    issueIdentifier,
    title: `Job ${job.jobId} completed without changing code`,
    blocker: null,
    nextAction: `The branch ${facts.branchName} is ${declared.value.branchState} and no draft was opened, because a draft with no change behind it would be a fabricated deliverable (F19-AC5). Read the recorded outcome, then cancel the job or start one that needs a change.`,
    candidateFingerprint: null,
    observedAt: systemClock.now(),
    resolved: false,
  });
  if (!recorded.ok) return err(recorded.error);
  return ok({
    kind: 'NoCodeOutcome',
    jobId: job.jobId,
    reason: `The attempt left the worktree exactly as it found it: head ${observation.headSha}, ${String(observation.dirtyFiles.length)} modified and ${String(observation.untrackedFiles.length)} untracked file(s).`,
    branchState: declared.value.branchState,
  });
}

/** The real Git adapter and the transport this worker commits through, for one workspace (F19-AC1). */
function gitPairFor(config: RuntimeConfig, worktreePath: string): Result<GitPair, DomainError> {
  if (config.git.token.trim() === '') {
    return err(
      invalid('This worker has no Git credential, so it cannot publish a branch or open a draft.', [
        { path: 'git.token', message: 'Set SHIPLOOP_WORKER_GITHUB_TOKEN; the value is never logged or stored (F19-AC1, N02-AC2).' },
      ]),
    );
  }
  const transport = createGitTransport(worktreePath);
  return ok({
    transport,
    git: new GitHubGitAdapter({
      connectorId: `git_${basename(worktreePath)}` as ConnectorId,
      client: {
        token: config.git.token,
        ...(config.git.apiBaseUrl === null ? {} : { apiBaseUrl: config.git.apiBaseUrl }),
      },
      git: transport,
      gitRemoteName: config.git.remoteName,
    }),
  });
}

/**
 * Commits what the attempt left, through the same transport the push uses (F19-AC1).
 *
 * The commit identity is passed per invocation rather than written into the repository's own
 * configuration, so an attempt never rewrites the owner's Git settings, and a failure to commit is
 * reported rather than treated as a delivered change.
 */
async function commitWorkspace(
  config: RuntimeConfig,
  pair: GitPair,
  context: AdapterContext,
  title: string,
): Promise<Result<CommitSha, DomainError>> {
  const staged = await pair.transport.run(context, ['add', '-A']);
  if (!staged.ok) return err(staged.error);
  if (staged.value.exitCode !== 0) {
    return err({
      code: 'Unavailable',
      reason: `git add exited ${String(staged.value.exitCode)}: ${context.redact(staged.value.stderr.trim().slice(0, 200))}`,
    });
  }

  /**
   * A workspace that is already clean holds the commit an earlier delivery made.
   *
   * A delivery is retried when a provider response was lost, and the retry runs against the
   * workspace the first delivery already committed. Committing again there would fail with
   * "nothing to commit" and report a delivery that did not happen, so the head is read instead:
   * the same commit is published again rather than an error raised over work that is already done
   * (F19-AC3).
   */
  const pending = await pair.transport.run(context, ['status', '--porcelain']);
  if (!pending.ok) return err(pending.error);
  if (pending.value.exitCode !== 0) {
    return err({
      code: 'Unavailable',
      reason: `git status exited ${String(pending.value.exitCode)}: ${context.redact(pending.value.stderr.trim().slice(0, 200))}`,
    });
  }
  if (pending.value.stdout.trim() === '') {
    const held = await pair.transport.run(context, ['rev-parse', 'HEAD']);
    if (!held.ok) return err(held.error);
    if (held.value.exitCode !== 0) {
      return err({ code: 'Unavailable', reason: 'The committed head could not be read, so nothing was pushed.' });
    }
    return ok(held.value.stdout.trim() as CommitSha);
  }

  const committed = await pair.transport.run(context, [
    '-c',
    `user.name=${config.commitAuthor.name}`,
    '-c',
    `user.email=${config.commitAuthor.email}`,
    'commit',
    '-m',
    title,
  ]);
  if (!committed.ok) return err(committed.error);
  if (committed.value.exitCode !== 0) {
    return err({
      code: 'Unavailable',
      reason: `git commit exited ${String(committed.value.exitCode)}: ${context.redact(committed.value.stderr.trim().slice(0, 200))}`,
    });
  }
  const head = await pair.transport.run(context, ['rev-parse', 'HEAD']);
  if (!head.ok) return err(head.error);
  if (head.value.exitCode !== 0) {
    return err({ code: 'Unavailable', reason: 'The committed head could not be read, so nothing was pushed.' });
  }
  return ok(head.value.stdout.trim() as CommitSha);
}

function adapterContextFor(job: JobRecord): AdapterContext {
  return {
    correlationId: job.correlationId,
    operationId: job.operationId,
    clock: systemClock,
    logger: lifecycleLogger(),
    signal: new AbortController().signal,
    redact: (value: string): string => redact(value).text,
  };
}

function linkTargetFor(work: WorkItemRecord): DraftLinkTarget {
  if (work.externalIssueId === null || work.externalIssueIdentifier === null || work.externalIssueUrl === null) {
    return {
      kind: 'None',
      reason: 'The work item is not bound to a provider issue, so the draft links to the work item only (F19-AC4).',
    };
  }
  return {
    kind: 'Ticket',
    issue: { issueId: work.externalIssueId as ProviderId, identifier: work.externalIssueIdentifier, url: work.externalIssueUrl },
  };
}

/**
 * The managed body of the draft (F19-AC2).
 *
 * Every check line names a check that reported a result, and a criterion whose method nobody
 * assigned is `NotRun` with a reason, so the body can never read as a pass that did not happen.
 */
function draftBody(input: {
  readonly purpose: string;
  readonly scope: string;
  readonly criteria: readonly { readonly criterionId: string; readonly text: string; readonly claim: VerificationClaim }[];
  readonly link: DraftLinkTarget;
  readonly checks?: readonly { readonly name: string; readonly claim: VerificationClaim }[];
}): DraftBody {
  return {
    managedMarker: '',
    purpose: input.purpose,
    scope: input.scope,
    criteria: input.criteria,
    knownGaps: [],
    verification:
      input.checks === undefined || input.checks.length === 0
        ? { kind: 'NotRun', reason: 'No required check has reported a result for this candidate yet.' }
        : { kind: 'Observed', checks: input.checks },
    linkedWork: input.link,
    managedProgressRegion: null,
  };
}

function checkClaim(name: string, result: CheckResult): VerificationClaim {
  if (result === 'Passed') return { kind: 'ReportedPassed', checkId: name };
  if (result === 'Failed') return { kind: 'ReportedFailed', checkId: name };
  if (result === 'Waiting') return { kind: 'ReportedPending', checkId: name };
  return { kind: 'NotRun', reason: `The required check "${name}" is ${result}, so no result may be claimed for it (F20-AC2).` };
}

/**
 * What the draft may claim about one acceptance criterion (F19-AC2, F23-AC1).
 *
 * The review card records a criterion's verdict but not which check produced it, so a verified
 * criterion is reported against a required check that actually reported `Passed` rather than
 * against a name this layer invented. Anything else is `NotRun` with the card's own reason, because
 * an unreported check can never be written as a pass.
 */
function criterionClaim(
  criteria: readonly { readonly criterionId: string; readonly status: CriterionStatus; readonly methodKind: string; readonly detail: string | null }[],
  checks: readonly { readonly name: string; readonly required: boolean; readonly result: CheckResult }[],
  criterionId: string,
): VerificationClaim {
  const criterion = criteria.find((entry) => entry.criterionId === criterionId);
  if (criterion === undefined) {
    return { kind: 'NotRun', reason: 'The captured scope names no such criterion, so nothing verifies it (F23-AC1).' };
  }
  if (criterion.methodKind !== 'AutomatedCheck') {
    return { kind: 'NotRun', reason: criterion.detail ?? 'No automated check is assigned to this criterion, so nothing verifies it (F23-AC1).' };
  }
  if (criterion.status === 'Verified') {
    const reported = checks.find((check) => check.required && check.result === 'Passed');
    return reported === undefined
      ? { kind: 'NotRun', reason: 'The card records this criterion as verified but no required check reported a pass for this candidate (F20-AC2).' }
      : { kind: 'ReportedPassed', checkId: reported.name };
  }
  if (criterion.status === 'Failed') {
    const failed = checks.find((check) => check.required && check.result === 'Failed');
    return failed === undefined
      ? { kind: 'NotRun', reason: 'The card records this criterion as failed but no required check reported that failure (F20-AC2).' }
      : { kind: 'ReportedFailed', checkId: failed.name };
  }
  return { kind: 'NotRun', reason: criterion.detail ?? `This criterion is ${criterion.status} for this candidate, so no result may be claimed for it (F23-AC1).` };
}

/**
 * The candidate a pushed commit represents, recorded once per identity (F19-AC3, F20-AC3).
 *
 * The pull request identity is written with the candidate because that is where a later
 * reconciliation reads it from, and an identical identity is reused rather than duplicated, so a
 * repeated delivery records one candidate and one set of check results.
 */
function recordCandidate(
  deps: DeliveryDeps,
  job: JobRecord,
  identity: CandidateIdentity,
  pullRequestId: ProviderId,
  targetBranch: string,
): Result<CandidateRecord, DomainError> {
  const fingerprint = candidateFingerprint(identity);
  const existing = deps.candidates.findByFingerprint(fingerprint);
  if (!existing.ok) return err(existing.error);
  if (existing.value !== null) return ok(existing.value);
  return deps.candidates.record({
    attemptId: null,
    workItemId: job.workItemId as WorkItemId,
    identity,
    pullRequestId,
    targetBranch,
    recordedAt: systemClock.now(),
    correlationId: job.correlationId,
  });
}

function workspaceEvidence(
  job: JobRecord,
  observation: { readonly headSha: CommitSha; readonly dirtyFiles: readonly string[]; readonly untrackedFiles: readonly string[] },
): ArtifactReference {
  return {
    artifactId: `worktree:${job.jobId}:${observation.headSha}`,
    kind: 'Diff',
    uri: `shiploop://jobs/${job.jobId}/worktree`,
    mediaType: 'text/plain',
    byteLength: null,
    producedAt: systemClock.now(),
    sanitized: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Verification bindings                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The required-check policy a project profile states (F20-AC5).
 *
 * The profile version's own content fingerprint is the policy revision, so a profile that adds or
 * removes a required check changes it and every result recorded under the old revision reads as
 * stale. Approved and proposed are the same set: this worker proposes nothing, so a coding pass can
 * neither widen nor narrow the gate that judges it.
 */
function projectChecksOf(config: RuntimeConfig, worktreePath: string, profile: ProjectProfileVersionLike): ProjectChecks {
  const policy: ProjectCheckPolicy = {
    profileVersionId: profile.profileVersionId,
    approved: policyOf(profile),
    proposed: policyOf(profile),
  };
  return {
    policyFor: (): Result<ProjectCheckPolicy, DomainError> => ok(policy),
    run: async (request: LocalCheckRequest): Promise<Result<CheckExecutionRecord, DomainError>> =>
      runCheckFor(config, worktreePath, request),
  };
}

interface ProjectProfileVersionLike {
  readonly profileVersionId: ProfileVersionId;
  readonly contentFingerprint: ReturnType<typeof candidateFingerprint>;
  readonly content: { readonly policy: { readonly requiredChecks: readonly string[] } };
  readonly createdBy: string;
  readonly createdAt: string;
}

function policyOf(profile: ProjectProfileVersionLike): RequiredCheckPolicy {
  return {
    policyFingerprint: profile.contentFingerprint,
    requiredCheckIds: profile.content.policy.requiredChecks,
    approvals: [],
    decidedBy: profile.createdBy,
    decidedAt: profile.createdAt,
  };
}

/**
 * Runs one configured check in the workspace the attempt worked in (F20-AC1, F20-AC2).
 *
 * The result comes back only from the execution `runCheck` observed, so a check that never ran is
 * `Missing` rather than `Passed`, and the command's output is written to the artifact store rather
 * than kept in the record, because a check's output travels into issue comments and exports
 * (N02-AC2).
 */
async function runCheckFor(
  config: RuntimeConfig,
  worktreePath: string,
  request: LocalCheckRequest,
): Promise<Result<CheckExecutionRecord, DomainError>> {
  const check: CheckCommand = request.check;
  const executed = await runCheck(
    {
      checkId: check.id,
      name: check.name,
      origin: 'LocalCheck',
      argv: check.command.argv,
      timeoutMs: check.command.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
      cwd: check.command.cwd === null ? worktreePath : join(worktreePath, check.command.cwd),
      env: allowlistedEnv(),
      identity: request.identity,
      currentCandidateFingerprint: request.currentCandidateFingerprint,
      policy: request.policy,
    },
    {
      run: commandRunnerPort,
      captureOutput: (capture) => captureCheckOutput(config, capture.checkId, capture.output),
      now: systemClock.now,
    },
  );
  return executed.ok ? ok(executed.value) : err(executed.error);
}

/** The shipped process runner behind the check runner's port: no shell, bounded output and deadline. */
const commandRunnerPort: CommandRunnerPort = async (argv, options): Promise<CommandRunResult> => {
  const outcome = await nodeProcessRunner.run([...argv], {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: MAX_CHECK_OUTPUT_BYTES,
    env: options.env,
  });
  const status =
    outcome.spawnError !== null
      ? 'CouldNotStart'
      : outcome.timedOut
        ? 'TimedOut'
        : outcome.exitCode !== null
          ? 'Exited'
          : 'Interrupted';
  return {
    status,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    output: outcome.output,
    outputTruncated: outcome.outputTruncated,
    durationMs: outcome.durationMs,
    detail: outcome.spawnError,
  };
};

async function captureCheckOutput(
  config: RuntimeConfig,
  checkId: string,
  output: string,
): Promise<{ readonly name: string; readonly byteLength: number }> {
  const directory = join(config.artifactRoot, 'checks');
  await mkdir(directory, { recursive: true });
  const name = join(directory, `${sanitizeName(checkId)}.log`);
  await writeFile(name, output, { mode: 0o600 });
  return { name, byteLength: Buffer.byteLength(output, 'utf8') };
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);
}

/**
 * The provider's own check results, through the Git adapter (F20-AC1, F20-AC2).
 *
 * `failureOnBase` answers "not observed": the shipped adapter reads a candidate's runs and whether
 * the base commit reran them, and reports nothing about how a base run ended, so the domain records
 * the attribution as `Indeterminate` rather than this layer guessing in either direction (F20-AC4).
 */
function providerChecksOf(git: GitHubGitAdapter, context: AdapterContext, repository: GitRepositoryRef): ProviderCheckReader {
  return {
    readChecks: (request) => git.readChecks(context, { ...request, repository }),
    failureOnBase: async () => ok(new Map<string, boolean | null>()),
  };
}

/**
 * The current environment recipe of a project (F04-AC1, F20-AC3).
 *
 * The durable environment identity is the accepted procedure version's own content fingerprint,
 * because that is the revision a candidate is compared against after a restart; the check commands
 * come from the same document, re-validated on the way out.
 */
function environmentReaderOf(deps: DeliveryDeps): ProjectEnvironmentReader {
  return {
    currentEnvironment: (projectId: ProjectId): Result<ProjectEnvironment, DomainError> => {
      const procedure = deps.procedures.currentVersion(projectId, RECIPE_SUBJECT_KEY);
      if (!procedure.ok) return err(procedure.error);
      if (procedure.value === null) {
        return err({
          code: 'NotFound',
          reason: `Project ${projectId} has no accepted environment recipe, so its checks cannot be run (F05-AC1).`,
        });
      }
      const recipe = recipeOf(procedure.value);
      if (!recipe.ok) return err(recipe.error);
      return ok({
        procedureVersionId: procedure.value.procedureVersionId as ProcedureVersionId,
        environmentFingerprint: procedure.value.contentFingerprint,
        checks: recipe.value.checks,
      });
    },
  };
}

function refused(job: JobRecord, reason: string): Result<DeliveryOutcome, DomainError> {
  return ok({ kind: 'Refused', jobId: job.jobId, reason });
}
