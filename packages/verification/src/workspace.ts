/**
 * Isolated task workspaces and per-attempt resource ownership
 * (F14-AC1, F14-AC2, F14-AC3, F14-AC4, F14-AC5).
 *
 * A Git worktree on its own is not isolation. It separates files; it does not
 * separate processes, databases, ports or browser profiles, so two attempts that
 * each "have a worktree" can still write one SQLite file, answer on one port and
 * be measured in one browser profile (ARCHITECTURE "Execution and recovery";
 * vm-development runbook, "Isolate work before starting servers"). Every function
 * here therefore allocates or records the whole set and reports what it did not
 * isolate, rather than implying it did:
 *
 *   - a linked worktree on a task branch, with a durable lock naming the active
 *     owner, the recorded base and the workspace identity (F14-AC1);
 *   - only additions to the connected repository, so an unrelated worktree and its
 *     uncommitted changes are provably untouched (F14-AC2);
 *   - a data directory, a port set allocated by binding port 0 and reading what the
 *     kernel assigned, a browser storage directory and a process registry, all
 *     under this attempt's own root, with an occupied requested port refused as a
 *     blocker instead of being attached to whatever already answers there
 *     (F14-AC3);
 *   - a comparison of the actual files and HEAD against a retained checkpoint,
 *     refusing reuse and naming every difference it found (F14-AC4);
 *   - cleanup that signals only process groups this attempt spawned and removes
 *     only eligible temporary paths, while retained work and evidence survive
 *     ordinary cancellation (F14-AC5).
 *
 * Every public function returns `Result` and never throws across its boundary, so
 * a caller can tell a blocked prerequisite from a broken host. Reasons name what
 * to do, because the person reading them is the owner, not a log pipeline.
 *
 * Durable ownership rows are the `workspace_locks` and `workspace_ports` tables
 * `@shiploop/storage` migrates. The ownership port is declared here and
 * implemented over that schema below, for the same reason
 * `SqliteOwnerCredentialStore` lives in the controller: storage does not publish
 * its lease manager, and an ownership record in a private file would be a second
 * source of truth for who owns what. The port is structurally satisfied by a
 * published lease manager once storage exports one.
 */

import { createServer, type Server } from 'node:net';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { BlockedError, CommitSha, DomainError, JobId, Result } from '@shiploop/domain';
import { blocked, conflict, err, fingerprint, invalid, ok, redact } from '@shiploop/domain';
import type { Database, SqlRow } from '@shiploop/storage';
import { withTransaction } from '@shiploop/storage';
import type { CleanupDeps, CleanupReport, CommandOptions, CommandResult, CommandRunner, OwnedProcess, OwnedResource } from './preflight.ts';
import { cleanupOwnedResources } from './preflight.ts';

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_LIMIT = 262_144;
const PORT_ATTEMPT_LIMIT = 8;
const REGISTRY_VERSION = 1;
const REGISTRY_FILE_MODE = 0o600;
const MAX_REPORTED_GIT_OUTPUT = 2_000;

/**
 * Git is given no credential prompts and no host configuration.
 *
 * A worktree operation must be reproducible from the recorded repository and base
 * alone. Inheriting the operator's global config would let a personal hook or
 * default branch change what an attempt built, and a prompt for credentials would
 * hang an unattended run until its deadline.
 */
const GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
});

/** One service this attempt needs a port for (F14-AC3). */
export interface PortRequest {
  readonly serviceName: string;
  /**
   * Null asks for a genuinely free port, allocated by binding port 0 and reading
   * the port the kernel assigned. A number is an explicit request, and it is
   * refused when the host already holds it rather than being reused.
   */
  readonly port: number | null;
}

export type PortOrigin = 'AllocatedFree' | 'Requested';

export interface IsolatedPort {
  readonly serviceName: string;
  readonly port: number;
  readonly origin: PortOrigin;
}

/** The per-attempt paths a worktree alone cannot isolate (F14-AC3). */
export interface WorkspacePaths {
  readonly dataDirectory: string;
  readonly browserProfileDirectory: string;
  readonly processRegistryPath: string;
  readonly lockDocumentPath: string;
  readonly worktreePath: string;
}

/**
 * The durable lock row for one workspace (F14-AC1).
 *
 * Structurally the record `@shiploop/storage`'s lease manager writes, so a
 * published lease manager satisfies the ownership port unchanged. It names the
 * workspace, its job, its active owner, its task branch and where it lives; the
 * recorded base is carried by the lock document because the migrated
 * `workspace_locks` table has no column for it.
 */
export interface WorkspaceLockRecord {
  readonly workspaceId: string;
  readonly jobId: JobId;
  readonly holder: string;
  readonly branchName: string;
  readonly worktreePath: string;
  readonly acquiredAt: string;
}

export interface PortReservationRecord {
  readonly workspaceId: string;
  readonly jobId: JobId;
  readonly holder: string;
  readonly serviceName: string;
  readonly port: number;
}

export interface PortReservationRequest {
  readonly workspaceId: string;
  readonly jobId: JobId;
  readonly holder: string;
  readonly now: string;
  readonly allocations: readonly { readonly serviceName: string; readonly port: number }[];
}

/**
 * Durable ownership of workspaces and ports.
 *
 * The only way a port may be shared is by being reserved for exactly one
 * workspace, so a collision is reported as a blocker here rather than discovered
 * when two runs answer on one socket (F14-AC3).
 */
export interface WorkspaceOwnership {
  acquireLock: (lock: WorkspaceLockRecord) => Result<WorkspaceLockRecord, DomainError>;
  readLock: (workspaceId: string) => WorkspaceLockRecord | null;
  releaseLock: (workspaceId: string, holder: string) => Result<null, DomainError>;
  reservePorts: (request: PortReservationRequest) => Result<readonly PortReservationRecord[], DomainError>;
  releasePorts: (workspaceId: string, holder: string) => Result<null, DomainError>;
  readPortOwner: (port: number) => PortReservationRecord | null;
}

/**
 * The host capability that answers whether a port can be had.
 *
 * A free-port probe does not reserve anything, which is why the durable
 * `workspace_ports` row, with its unique index on the port, is the actual
 * reservation. This port only discovers what is already occupied.
 */
export interface PortBinder {
  allocateFreePort: () => Promise<number | null>;
  isOccupied: (port: number) => Promise<boolean>;
}

/**
 * The lock document ShipLoop keeps for one workspace, outside the connected
 * repository.
 *
 * It records what a resume needs and what ownership means: the active owner, the
 * repository and base the worktree was created from, the task branch, the isolated
 * paths and the port set. It is written next to the worktree rather than inside
 * it, so an attempt never adds a ShipLoop file to the owner's project (ARCHITECTURE
 * "Execution and recovery").
 */
export interface WorkspaceLockDocument {
  readonly version: number;
  readonly workspaceId: string;
  readonly jobId: JobId;
  readonly owner: string;
  readonly repositoryPath: string;
  readonly baseRef: string;
  readonly baseSha: CommitSha;
  readonly branchName: string;
  readonly worktreePath: string;
  readonly paths: WorkspacePaths;
  readonly ports: readonly IsolatedPort[];
  readonly headSha: CommitSha;
  readonly acquiredAt: string;
}

export interface PreparedWorkspace {
  readonly workspaceId: string;
  readonly jobId: JobId;
  readonly owner: string;
  readonly repositoryPath: string;
  readonly baseRef: string;
  readonly baseSha: CommitSha;
  readonly branchName: string;
  readonly headSha: CommitSha;
  readonly paths: WorkspacePaths;
  readonly ports: readonly IsolatedPort[];
  readonly lock: WorkspaceLockRecord;
  readonly lockDocument: WorkspaceLockDocument;
}

export interface PrepareWorkspaceRequest {
  readonly jobId: JobId;
  /** Absolute path of the connected repository checkout the worktree links to. */
  readonly repository: string;
  readonly baseRef: string;
  readonly branchName: string;
  /** Absolute directory under which this attempt keeps every isolated resource. */
  readonly attemptRoot: string;
  /** The writer identity that owns this workspace while the attempt runs. */
  readonly holder: string;
  readonly services: readonly PortRequest[];
  readonly now: string;
}

export interface PrepareWorkspaceDeps {
  readonly runCommand: CommandRunner;
  readonly ports: PortBinder;
  readonly ownership: WorkspaceOwnership;
}

/**
 * The checkpoint facts a reuse decision compares.
 *
 * Deliberately the subset of the durable `JobCheckpoint` that reuse reads, so the
 * record `@shiploop/storage` already stores satisfies it structurally and this
 * module never has to be told how a checkpoint is persisted.
 */
export interface WorkspaceCheckpoint {
  readonly checkpointId: string;
  readonly workspaceId: string;
  readonly branchName: string;
  readonly worktreePath: string;
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  readonly dirtyFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly recordedAt: string;
}

export interface ReuseWorkspaceRequest {
  readonly checkpoint: WorkspaceCheckpoint;
  readonly holder: string;
  readonly now: string;
}

export interface ReuseWorkspaceDeps {
  readonly runCommand: CommandRunner;
}

export type WorkspaceDivergenceKind =
  | 'WorkspaceUnreadable'
  | 'WorkspaceIdentityChanged'
  | 'HeadMoved'
  | 'UnexpectedModification'
  | 'UnexpectedUntrackedFile'
  | 'CheckpointChangeMissing';

export interface WorkspaceDivergence {
  readonly kind: WorkspaceDivergenceKind;
  /** The file this difference is about, or null when it concerns the workspace. */
  readonly path: string | null;
  readonly detail: string;
}

export interface WorkspaceReuseReport {
  readonly checkpointId: string;
  readonly workspaceId: string;
  readonly observedAt: string;
  readonly expectedHeadSha: CommitSha;
  readonly actualHeadSha: CommitSha | null;
  readonly expectedDirtyFiles: readonly string[];
  readonly observedDirtyFiles: readonly string[];
  readonly expectedUntrackedFiles: readonly string[];
  readonly observedUntrackedFiles: readonly string[];
  readonly divergences: readonly WorkspaceDivergence[];
}

/** A refused reuse keeps the observation, so the owner is shown what changed (F14-AC4). */
export interface WorkspaceReuseRefusal {
  readonly error: BlockedError;
  readonly report: WorkspaceReuseReport;
}

export interface WorkspaceCleanupRequest {
  readonly workspace: PreparedWorkspace;
  /** Exactly the processes this attempt spawned. Anything else is not owned. */
  readonly processes: readonly OwnedProcess[];
  /**
   * Keeps the worktree, its lock document and its process registry, so a
   * cancelled attempt stays recoverable instead of losing its work (F14-AC5).
   */
  readonly retainWorkspace: boolean;
  readonly now: string;
}

export interface WorkspaceCleanupDeps extends CleanupDeps {
  readonly runCommand: CommandRunner;
  readonly ownership: WorkspaceOwnership;
}

export interface WorkspaceCleanupOutcome {
  readonly workspaceId: string;
  readonly retained: boolean;
  readonly report: CleanupReport;
  readonly removedPaths: readonly string[];
  readonly retainedPaths: readonly string[];
  /** Ownership rows given up, with the workspace's lock still held when retained. */
  readonly releasedPortReservations: readonly number[];
}

function sanitizeGitOutput(value: string): string {
  const text = redact(value).text.trim();
  return text.length <= MAX_REPORTED_GIT_OUTPUT ? text : `${text.slice(0, MAX_REPORTED_GIT_OUTPUT)}...`;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one Git argv and returns its trimmed output.
 *
 * Git is always an argument array and never a shell string, so a recorded ref or
 * path cannot become a command. A failed exit is reported with Git's own message,
 * because "the base ref does not exist" and "the repository is locked" need
 * different answers from the owner.
 */
async function runGit(runner: CommandRunner, cwd: string, argv: readonly string[]): Promise<Result<string, DomainError>> {
  const options: CommandOptions = {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: GIT_OUTPUT_LIMIT,
    env: GIT_ENV,
  };
  let result: CommandResult;
  try {
    result = await runner.run(['git', ...argv], options);
  } catch (error) {
    return err({ code: 'Unavailable', reason: `git could not be executed: ${describeFailure(error)}` });
  }
  return readGitOutput(`git ${argv[0] ?? ''}`, result);
}

function readGitOutput(command: string, result: CommandResult): Result<string, DomainError> {
  if (result.spawnError !== null) {
    return err({ code: 'Unavailable', reason: `${command} could not be started: ${sanitizeGitOutput(result.spawnError)}` });
  }
  if (result.timedOut) {
    return err({
      code: 'Unavailable',
      reason: `${command} exceeded its ${GIT_TIMEOUT_MS} ms deadline and its process group was stopped, so the workspace state is unknown.`,
    });
  }
  if (result.outputTruncated) {
    return err({
      code: 'Unavailable',
      reason: `${command} exceeded its ${GIT_OUTPUT_LIMIT} byte output cap, so the excess was discarded rather than reported.`,
    });
  }
  if (result.exitCode !== 0) {
    return err({
      code: 'Unavailable',
      reason: `${command} exited ${result.exitCode ?? 'with no code'}: ${sanitizeGitOutput(result.output) || 'it printed nothing'}`,
    });
  }
  return ok(result.output.trim());
}

/** Splits a NUL-delimited Git path list, which is how Git reports paths safely. */
function splitNulPaths(output: string): string[] {
  return output
    .split('\0')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .sort();
}

function listenOnPort(port: number): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function releaseServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : null;
}

/**
 * The real host port binder, over `node:net`.
 *
 * A free port is discovered the only way that is honest: bind port 0 and read
 * what the kernel assigned, rather than guessing from the ephemeral range and
 * hoping. An occupied port is proven by a refused bind, so the refusal names a
 * fact about this host rather than a guess.
 */
export function createPortBinder(): PortBinder {
  return {
    async allocateFreePort() {
      let server: Server;
      try {
        server = await listenOnPort(0);
      } catch {
        return null;
      }
      const address = server.address();
      try {
        await releaseServer(server);
      } catch {
        return null;
      }
      if (address === null || typeof address === 'string') return null;
      return address.port;
    },
    async isOccupied(port) {
      let server: Server;
      try {
        server = await listenOnPort(port);
      } catch (error) {
        const code = errorCode(error);
        return code === 'EADDRINUSE' || code === 'EACCES' || code === 'EADDRNOTAVAIL';
      }
      await releaseServer(server);
      return false;
    },
  };
}

/**
 * The workspace identity derived from the recorded job, repository and branch.
 *
 * Stable for the same work item and branch so a resume finds the workspace it
 * left, and different for every other combination so two workspaces of one
 * repository cannot collide (F14-AC1).
 */
export function deriveWorkspaceId(input: {
  readonly jobId: string;
  readonly repository: string;
  readonly branchName: string;
}): string {
  const digest = fingerprint({ jobId: input.jobId, repository: input.repository, branchName: input.branchName });
  return `ws_${digest.slice(3)}`;
}

function layoutOf(attemptRoot: string, workspaceId: string): WorkspacePaths {
  return {
    dataDirectory: join(attemptRoot, 'data', workspaceId),
    browserProfileDirectory: join(attemptRoot, 'browser', workspaceId),
    processRegistryPath: join(attemptRoot, 'processes', workspaceId, 'registry.json'),
    lockDocumentPath: join(attemptRoot, 'locks', `${workspaceId}.json`),
    worktreePath: join(attemptRoot, 'worktrees', workspaceId),
  };
}

function validatePrepareRequest(request: PrepareWorkspaceRequest): Result<null, DomainError> {
  const fields: { path: string; message: string }[] = [];
  if (request.jobId.trim().length === 0) {
    fields.push({ path: 'jobId', message: 'Name the job this workspace belongs to; an unowned workspace cannot be released.' });
  }
  if (request.holder.trim().length === 0) {
    fields.push({ path: 'holder', message: 'Name the writer that owns this workspace, so the lock records an active owner (F14-AC1).' });
  }
  if (!isAbsolute(request.repository)) {
    fields.push({ path: 'repository', message: 'Record an absolute path to the connected repository checkout.' });
  }
  if (!isAbsolute(request.attemptRoot)) {
    fields.push({ path: 'attemptRoot', message: 'Record an absolute attempt root; isolated resources are resolved beneath it (F14-AC3).' });
  }
  if (request.baseRef.trim().length === 0) {
    fields.push({ path: 'baseRef', message: 'Record the base ref the task branch starts from, so the workspace is reproducible.' });
  }
  if (request.branchName.trim().length === 0) {
    fields.push({ path: 'branchName', message: 'Name the task branch the worktree is created on.' });
  }
  if (request.branchName.startsWith('-')) {
    fields.push({ path: 'branchName', message: 'A branch name starting with "-" would be read as a Git option, not a name.' });
  }
  if (Number.isNaN(Date.parse(request.now))) {
    fields.push({ path: 'now', message: 'Record when the workspace was prepared as an ISO-8601 timestamp.' });
  }
  const names = new Set<string>();
  request.services.forEach((service, index) => {
    if (service.serviceName.trim().length === 0) {
      fields.push({ path: `services[${index}].serviceName`, message: 'Name the service this port belongs to, so a blocker can name it (F14-AC3).' });
    }
    if (names.has(service.serviceName)) {
      fields.push({ path: `services[${index}].serviceName`, message: 'Two services in one workspace cannot share a name.' });
    }
    names.add(service.serviceName);
    if (service.port !== null && (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535)) {
      fields.push({ path: `services[${index}].port`, message: 'A port must be an integer between 1 and 65535, or null to allocate one.' });
    }
  });
  if (fields.length === 0) return ok(null);
  return err(invalid('The task workspace cannot be prepared from these inputs (F14-AC1).', fields));
}

async function verifyRepositoryCheckout(runner: CommandRunner, repository: string): Promise<Result<string, DomainError>> {
  const inside = await runGit(runner, repository, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) return inside;
  if (inside.value !== 'true') {
    return err(
      blocked(`The recorded repository path ${repository} is not a Git work tree.`, [
        {
          name: 'repository-checkout',
          detail: `git rev-parse --is-inside-work-tree reported "${inside.value || 'nothing'}" at ${repository}.`,
          remedy:
            'Save a project profile whose repository points at a real Git checkout. A task workspace is a linked worktree, so there is nothing to link it to otherwise (F14-AC1).',
        },
      ]),
    );
  }
  const top = await runGit(runner, repository, ['rev-parse', '--show-toplevel']);
  return top.ok ? ok(top.value) : top;
}

async function resolveBaseSha(runner: CommandRunner, repository: string, baseRef: string): Promise<Result<CommitSha, DomainError>> {
  const resolved = await runGit(runner, repository, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  if (!resolved.ok) {
    return err(
      blocked(`The recorded base ref "${baseRef}" does not name a commit in ${repository}.`, [
        {
          name: 'base-ref',
          detail: `git rev-parse --verify ${baseRef}^{commit} produced no commit: ${resolved.error.reason}`,
          remedy:
            'Fetch the repository and record a base ref that exists, such as the default branch. A workspace prepared from an unknown base would silently branch from the wrong code (F14-AC1).',
        },
      ]),
    );
  }
  const sha = resolved.value.trim();
  if (!/^[0-9a-f]{40}$/.test(sha) && !/^[0-9a-f]{64}$/.test(sha)) {
    return err({
      code: 'Unavailable',
      reason: `git resolved base ref "${baseRef}" to "${sanitizeGitOutput(sha)}", which is not a full commit SHA and cannot identify a base.`,
    });
  }
  return ok(sha as CommitSha);
}

async function verifyBranchName(runner: CommandRunner, repository: string, branchName: string): Promise<Result<null, DomainError>> {
  const checked = await runGit(runner, repository, ['check-ref-format', '--branch', branchName]);
  if (checked.ok) return ok(null);
  return err(
    invalid('The task branch name cannot be used for a worktree (F14-AC1).', [
      {
        path: 'branchName',
        message: `"${branchName}" is not a valid Git branch name: ${sanitizeGitOutput(checked.error.reason)}`,
      },
    ]),
  );
}

function occupiedPortBlocker(workspaceId: string, service: PortRequest): BlockedError {
  const port = service.port ?? 0;
  return blocked(`Workspace ${workspaceId} cannot start ${service.serviceName} on port ${port}: this host already holds that port.`, [
    {
      name: `isolated-port-${service.serviceName}`,
      detail: `Binding port ${port} on 127.0.0.1 failed, so another process is using it.`,
      remedy: `Stop the process that holds port ${port}, or give this workspace a different port. Starting here would report an unrelated service's behaviour as this job's result (F14-AC3).`,
    },
  ]);
}

function unusablePortAllocation(workspaceId: string, serviceName: string): BlockedError {
  return blocked(`Workspace ${workspaceId} could not be given a free port for ${serviceName}.`, [
    {
      name: `isolated-port-${serviceName}`,
      detail: `Binding port 0 succeeded but the host assigned no usable port in ${PORT_ATTEMPT_LIMIT} attempts.`,
      remedy:
        'Check the ephemeral port range and any port already reserved by another workspace, then start the attempt again. A workspace without its own port would share a service with an unrelated run (F14-AC3).',
    },
  ]);
}

/**
 * Chooses the port for one service.
 *
 * An allocation that returns a port another service in this attempt already holds
 * is retried rather than accepted, because two services of one workspace sharing a
 * socket would be the same collision as two workspaces sharing one (F14-AC3).
 */
async function choosePort(
  binder: PortBinder,
  ownership: WorkspaceOwnership,
  workspaceId: string,
  service: PortRequest,
  taken: ReadonlySet<number>,
): Promise<Result<IsolatedPort, DomainError>> {
  if (service.port !== null) {
    if (await binder.isOccupied(service.port)) return err(occupiedPortBlocker(workspaceId, service));
    return ok({ serviceName: service.serviceName, port: service.port, origin: 'Requested' });
  }
  for (let attempt = 0; attempt < PORT_ATTEMPT_LIMIT; attempt += 1) {
    const candidate = await binder.allocateFreePort();
    if (candidate === null || taken.has(candidate)) continue;
    if (ownership.readPortOwner(candidate) !== null) continue;
    return ok({ serviceName: service.serviceName, port: candidate, origin: 'AllocatedFree' });
  }
  return err(unusablePortAllocation(workspaceId, service.serviceName));
}

async function createIsolatedDirectories(paths: WorkspacePaths): Promise<Result<null, DomainError>> {
  try {
    await mkdir(paths.dataDirectory, { recursive: true });
    await mkdir(paths.browserProfileDirectory, { recursive: true });
    await mkdir(dirname(paths.processRegistryPath), { recursive: true });
    await mkdir(dirname(paths.lockDocumentPath), { recursive: true });
  } catch (error) {
    return err({
      code: 'Unavailable',
      reason: `The attempt's isolated directories could not be created under the recorded attempt root: ${describeFailure(error)}. A shared directory would let this attempt read another run's data (F14-AC3).`,
    });
  }
  return ok(null);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes a linked worktree through Git rather than by deleting its directory.
 *
 * `git worktree add` recorded metadata in the connected repository, so removing
 * the directory alone would leave the repository believing a worktree exists. The
 * directory removal and `worktree prune` are the fallback for the case where Git
 * already forgot the worktree, and a failure to do either is reported rather than
 * reported as removed (F14-AC2).
 */
async function removeWorkspaceWorktree(
  runner: CommandRunner,
  removePath: (path: string) => Promise<void>,
  repository: string,
  worktreePath: string,
): Promise<void> {
  const removed = await runGit(runner, repository, ['worktree', 'remove', '--force', worktreePath]);
  if (removed.ok) return;
  let directoryFailure: string | null = null;
  try {
    await removePath(worktreePath);
  } catch (error) {
    directoryFailure = describeFailure(error);
  }
  const pruned = await runGit(runner, repository, ['worktree', 'prune']);
  if (directoryFailure === null && pruned.ok) return;
  throw new Error(
    `The worktree at ${worktreePath} could not be removed. git worktree remove: ${removed.error.reason}${
      directoryFailure === null ? '' : `; removing the directory: ${directoryFailure}`
    }${pruned.ok ? '' : `; git worktree prune: ${pruned.error.reason}`}`,
  );
}

async function writeLockDocument(path: string, document: WorkspaceLockDocument): Promise<Result<null, DomainError>> {
  try {
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { mode: REGISTRY_FILE_MODE });
  } catch (error) {
    return err({
      code: 'Unavailable',
      reason: `The workspace lock document could not be written to ${path}: ${describeFailure(error)}. Without it a resume cannot tell which owner and base this workspace belongs to (F14-AC1).`,
    });
  }
  return ok(null);
}

/**
 * Discards what a failed preparation created.
 *
 * Every step of `prepareWorkspace` after ownership is taken can fail, and a
 * half-prepared workspace is worse than none: an orphan worktree holds a branch
 * and a directory, and a workspace with a lock but no lock document blocks the
 * next attempt on a workspace identity nobody can explain.
 */
async function discardPreparedWorkspace(
  deps: PrepareWorkspaceDeps,
  lock: WorkspaceLockRecord,
  repositoryPath: string,
  paths: WorkspacePaths,
  worktreeCreated: boolean,
  removePath: (path: string) => Promise<void>,
): Promise<readonly string[]> {
  const problems: string[] = [];
  if (worktreeCreated) {
    try {
      await removeWorkspaceWorktree(deps.runCommand, removePath, repositoryPath, paths.worktreePath);
    } catch (error) {
      problems.push(describeFailure(error));
    }
  }
  for (const path of [paths.dataDirectory, paths.browserProfileDirectory, dirname(paths.processRegistryPath), paths.lockDocumentPath]) {
    try {
      await removePath(path);
    } catch (error) {
      problems.push(`${path}: ${describeFailure(error)}`);
    }
  }
  const releasedPorts = deps.ownership.releasePorts(lock.workspaceId, lock.holder);
  if (!releasedPorts.ok) problems.push(releasedPorts.error.reason);
  const unlocked = deps.ownership.releaseLock(lock.workspaceId, lock.holder);
  if (!unlocked.ok) problems.push(unlocked.error.reason);
  return problems;
}

/**
 * Prepares an isolated task workspace for one attempt (F14-AC1, F14-AC3).
 *
 * The order is deliberate. The base is resolved and the ports are chosen before
 * anything is created, because both are read-only with respect to the connected
 * repository and either can fail with nothing to undo. Durable ownership is then
 * taken before any file or worktree exists, so two processes preparing the same
 * workspace cannot both get as far as creating one. Only then is the worktree
 * linked, which only ever adds a worktree and a branch: an unrelated worktree and
 * its uncommitted changes are not read, written or cleaned (F14-AC2).
 *
 * Nothing about isolation is assumed. A worktree is created alongside this
 * attempt's own data directory, browser storage directory and process registry, and
 * every service port is either allocated by binding port 0 or explicitly requested
 * and then proven unheld.
 */
export async function prepareWorkspace(
  request: PrepareWorkspaceRequest,
  deps: PrepareWorkspaceDeps,
): Promise<Result<PreparedWorkspace, DomainError>> {
  const validated = validatePrepareRequest(request);
  if (!validated.ok) return validated;

  const checkout = await verifyRepositoryCheckout(deps.runCommand, request.repository);
  if (!checkout.ok) return checkout;

  const branchChecked = await verifyBranchName(deps.runCommand, checkout.value, request.branchName);
  if (!branchChecked.ok) return branchChecked;

  const baseSha = await resolveBaseSha(deps.runCommand, checkout.value, request.baseRef);
  if (!baseSha.ok) return baseSha;

  const workspaceId = deriveWorkspaceId({
    jobId: request.jobId,
    repository: checkout.value,
    branchName: request.branchName,
  });
  const paths = layoutOf(request.attemptRoot, workspaceId);

  const taken = new Set<number>();
  const ports: IsolatedPort[] = [];
  for (const service of request.services) {
    const chosen = await choosePort(deps.ports, deps.ownership, workspaceId, service, taken);
    if (!chosen.ok) return chosen;
    taken.add(chosen.value.port);
    ports.push(chosen.value);
  }

  const lock: WorkspaceLockRecord = {
    workspaceId,
    jobId: request.jobId,
    holder: request.holder,
    branchName: request.branchName,
    worktreePath: paths.worktreePath,
    acquiredAt: request.now,
  };
  const acquired = deps.ownership.acquireLock(lock);
  if (!acquired.ok) return acquired;
  const reserved = deps.ownership.reservePorts({
    workspaceId,
    jobId: request.jobId,
    holder: request.holder,
    now: request.now,
    allocations: ports.map((port) => ({ serviceName: port.serviceName, port: port.port })),
  });
  if (!reserved.ok) {
    deps.ownership.releaseLock(workspaceId, request.holder);
    return reserved;
  }

  const removePath = async (path: string): Promise<void> => {
    await rm(path, { recursive: true, force: true });
  };

  const directories = await createIsolatedDirectories(paths);
  if (!directories.ok) {
    const problems = await discardPreparedWorkspace(deps, lock, checkout.value, paths, false, removePath);
    return err(withCleanupDetail(directories.error, problems));
  }

  const registry = await writeProcessRegistry(paths.processRegistryPath, workspaceId, []);
  if (!registry.ok) {
    const problems = await discardPreparedWorkspace(deps, lock, checkout.value, paths, false, removePath);
    return err(withCleanupDetail(registry.error, problems));
  }

  const added = await runGit(deps.runCommand, checkout.value, ['worktree', 'add', '-b', request.branchName, paths.worktreePath, baseSha.value]);
  if (!added.ok) {
    const problems = await discardPreparedWorkspace(deps, lock, checkout.value, paths, false, removePath);
    return err(withCleanupDetail(added.error, problems));
  }

  const head = await runGit(deps.runCommand, paths.worktreePath, ['rev-parse', 'HEAD']);
  if (!head.ok || !isFullSha(head.value)) {
    const problems = await discardPreparedWorkspace(deps, lock, checkout.value, paths, true, removePath);
    const failure: DomainError = head.ok
      ? { code: 'Unavailable', reason: `The new worktree reported HEAD "${sanitizeGitOutput(head.value)}", which is not a full commit SHA.` }
      : head.error;
    return err(withCleanupDetail(failure, problems));
  }

  const lockDocument: WorkspaceLockDocument = {
    version: REGISTRY_VERSION,
    workspaceId,
    jobId: request.jobId,
    owner: request.holder,
    repositoryPath: checkout.value,
    baseRef: request.baseRef,
    baseSha: baseSha.value,
    branchName: request.branchName,
    worktreePath: paths.worktreePath,
    paths,
    ports,
    headSha: head.value as CommitSha,
    acquiredAt: request.now,
  };
  const documentWritten = await writeLockDocument(paths.lockDocumentPath, lockDocument);
  if (!documentWritten.ok) {
    const problems = await discardPreparedWorkspace(deps, lock, checkout.value, paths, true, removePath);
    return err(withCleanupDetail(documentWritten.error, problems));
  }

  return ok({
    workspaceId,
    jobId: request.jobId,
    owner: request.holder,
    repositoryPath: checkout.value,
    baseRef: request.baseRef,
    baseSha: baseSha.value,
    branchName: request.branchName,
    headSha: head.value as CommitSha,
    paths,
    ports,
    lock: acquired.value,
    lockDocument,
  });
}

function isFullSha(value: string): boolean {
  const trimmed = value.trim();
  return /^[0-9a-f]{40}$/.test(trimmed) || /^[0-9a-f]{64}$/.test(trimmed);
}

/**
 * Keeps the original refusal and appends what could not be undone.
 *
 * A preparation that failed and left an orphan behind is a different incident from
 * one that failed cleanly, and hiding the leftovers would invite the next attempt
 * to trust a workspace identity that already exists.
 */
function withCleanupDetail(error: DomainError, problems: readonly string[]): DomainError {
  if (problems.length === 0) return error;
  return { ...error, reason: `${error.reason} Undo was incomplete: ${problems.join('; ')}` };
}

async function observeWorkspace(runner: CommandRunner, checkpoint: WorkspaceCheckpoint): Promise<WorkspaceReuseReport> {
  const empty: WorkspaceReuseReport = {
    checkpointId: checkpoint.checkpointId,
    workspaceId: checkpoint.workspaceId,
    observedAt: '',
    expectedHeadSha: checkpoint.headSha,
    actualHeadSha: null,
    expectedDirtyFiles: [...checkpoint.dirtyFiles].sort(),
    observedDirtyFiles: [],
    expectedUntrackedFiles: [...checkpoint.untrackedFiles].sort(),
    observedUntrackedFiles: [],
    divergences: [],
  };

  if (!(await pathExists(checkpoint.worktreePath))) {
    const report: WorkspaceReuseReport = {
      ...empty,
      divergences: [
        {
          kind: 'WorkspaceUnreadable',
          path: checkpoint.worktreePath,
          detail: `The worktree recorded for checkpoint ${checkpoint.checkpointId} is not on this host at ${checkpoint.worktreePath}.`,
        },
      ],
    };
    return report;
  }

  const head = await runGit(runner, checkpoint.worktreePath, ['rev-parse', 'HEAD']);
  if (!head.ok || !isFullSha(head.value)) {
    return {
      ...empty,
      divergences: [
        {
          kind: 'WorkspaceUnreadable',
          path: checkpoint.worktreePath,
          detail: `The recorded worktree could not be read as a Git checkout: ${head.ok ? sanitizeGitOutput(head.value) : head.error.reason}`,
        },
      ],
    };
  }
  const branch = await runGit(runner, checkpoint.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const observedDirty = await runGit(runner, checkpoint.worktreePath, ['diff', '--name-only', '-z', 'HEAD']);
  const observedUntracked = await runGit(runner, checkpoint.worktreePath, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  if (!observedDirty.ok) {
    return {
      ...empty,
      actualHeadSha: head.value as CommitSha,
      divergences: [
        {
          kind: 'WorkspaceUnreadable',
          path: checkpoint.worktreePath,
          detail: `The workspace's changed files could not be listed, so no comparison is possible: ${observedDirty.error.reason}`,
        },
      ],
    };
  }
  if (!observedUntracked.ok) {
    return {
      ...empty,
      actualHeadSha: head.value as CommitSha,
      divergences: [
        {
          kind: 'WorkspaceUnreadable',
          path: checkpoint.worktreePath,
          detail: `The workspace's untracked files could not be listed, so no comparison is possible: ${observedUntracked.error.reason}`,
        },
      ],
    };
  }

  const actualHead = head.value as CommitSha;
  const observedDirtyFiles = splitNulPaths(observedDirty.value);
  const observedUntrackedFiles = splitNulPaths(observedUntracked.value);
  const expectedDirty = new Set(checkpoint.dirtyFiles);
  const expectedUntracked = new Set(checkpoint.untrackedFiles);
  const divergences: WorkspaceDivergence[] = [];

  const observedBranch = branch.ok ? branch.value : '';
  if (observedBranch !== checkpoint.branchName) {
    divergences.push({
      kind: 'WorkspaceIdentityChanged',
      path: null,
      detail: `Checkpoint ${checkpoint.checkpointId} records branch "${checkpoint.branchName}", but the worktree is on "${observedBranch || 'an unnamed detached head'}".`,
    });
  }
  if (actualHead !== checkpoint.headSha) {
    divergences.push({
      kind: 'HeadMoved',
      path: null,
      detail: `Checkpoint ${checkpoint.checkpointId} recorded HEAD ${checkpoint.headSha}, but the worktree is at ${actualHead}.`,
    });
  }
  for (const path of observedDirtyFiles) {
    if (expectedDirty.has(path)) continue;
    divergences.push({
      kind: 'UnexpectedModification',
      path,
      detail: `"${path}" is modified in the workspace but the retained checkpoint ${checkpoint.checkpointId} recorded it as unchanged.`,
    });
  }
  for (const path of observedUntrackedFiles) {
    if (expectedUntracked.has(path)) continue;
    divergences.push({
      kind: 'UnexpectedUntrackedFile',
      path,
      detail: `"${path}" is a new untracked file in the workspace that the retained checkpoint ${checkpoint.checkpointId} does not record.`,
    });
  }
  for (const path of expectedDirty) {
    if (observedDirtyFiles.includes(path)) continue;
    divergences.push({
      kind: 'CheckpointChangeMissing',
      path,
      detail: `"${path}" was an unfinished change recorded by checkpoint ${checkpoint.checkpointId}, but the workspace no longer shows it as changed.`,
    });
  }
  for (const path of expectedUntracked) {
    if (observedUntrackedFiles.includes(path)) continue;
    divergences.push({
      kind: 'CheckpointChangeMissing',
      path,
      detail: `"${path}" was an untracked file recorded by checkpoint ${checkpoint.checkpointId}, but the workspace no longer contains it.`,
    });
  }

  return {
    checkpointId: checkpoint.checkpointId,
    workspaceId: checkpoint.workspaceId,
    observedAt: '',
    expectedHeadSha: checkpoint.headSha,
    actualHeadSha: actualHead,
    expectedDirtyFiles: [...checkpoint.dirtyFiles].sort(),
    observedDirtyFiles,
    expectedUntrackedFiles: [...checkpoint.untrackedFiles].sort(),
    observedUntrackedFiles,
    divergences,
  };
}

function reuseBlocker(report: WorkspaceReuseReport, holder: string): BlockedError {
  const named = report.divergences[0];
  return blocked(
    `Workspace ${report.workspaceId} cannot be reused by ${holder}: ${report.divergences.length} difference(s) from checkpoint ${report.checkpointId} are not accounted for${named === undefined ? '' : `, starting with ${named.detail}`}.`,
    report.divergences.map((divergence) => ({
      name: divergence.kind,
      detail: divergence.detail,
      remedy:
        'Look at the workspace yourself, then keep or discard each difference deliberately. Resuming without deciding would either overwrite your edits or silently discard them (F14-AC4).',
    })),
  );
}

/**
 * Decides whether a retained workspace may be reused, by comparing what is on disk
 * with what the checkpoint recorded (F14-AC4).
 *
 * The comparison is against the actual checkout, not against what the last run
 * believed it had done: HEAD, the changed files against HEAD, and the untracked
 * files. Any difference is refused and named individually, because a resume that
 * overwrote an edit the owner made by hand, or that silently discarded one, both
 * look exactly like a successful resume afterwards.
 */
export async function reuseWorkspace(
  request: ReuseWorkspaceRequest,
  deps: ReuseWorkspaceDeps,
): Promise<Result<WorkspaceReuseReport, WorkspaceReuseRefusal>> {
  const report: WorkspaceReuseReport = { ...(await observeWorkspace(deps.runCommand, request.checkpoint)), observedAt: request.now };
  if (report.divergences.length === 0) return ok(report);
  const error = reuseBlocker(report, request.holder);
  return { ok: false, error: { error, report } };
}

function assertOwnedProcess(value: unknown, index: number): Result<OwnedProcess, DomainError> {
  if (typeof value !== 'object' || value === null) {
    return err({ code: 'Unavailable', reason: `Process registry entry ${index} is not an object, so what this attempt owned is unknown.` });
  }
  const entry = value as Record<string, unknown>;
  const pid = entry['pid'];
  const groupId = entry['groupId'];
  const ownsGroup = entry['ownsGroup'];
  const command = entry['command'];
  const startedAt = entry['startedAt'];
  if (!Number.isInteger(pid) || (pid as number) < 1) {
    return err({ code: 'Unavailable', reason: `Process registry entry ${index} has no usable pid, so it cannot be owned.` });
  }
  if (!Number.isInteger(groupId) || (groupId as number) < 1) {
    return err({
      code: 'Unavailable',
      reason: `Process registry entry ${index} has no usable process group, so signalling it could reach a process this attempt did not spawn (F14-AC5).`,
    });
  }
  if (typeof ownsGroup !== 'boolean') {
    return err({ code: 'Unavailable', reason: `Process registry entry ${index} does not record whether this attempt created its process group.` });
  }
  if (!Array.isArray(command) || command.some((argument) => typeof argument !== 'string')) {
    return err({ code: 'Unavailable', reason: `Process registry entry ${index} does not record its command as a string array.` });
  }
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) {
    return err({ code: 'Unavailable', reason: `Process registry entry ${index} does not record when it was started.` });
  }
  return ok({
    pid: pid as number,
    groupId: groupId as number,
    ownsGroup,
    command: command as string[],
    startedAt,
  });
}

async function readProcessRegistryDocument(registryPath: string): Promise<Result<{ workspaceId: string; processes: OwnedProcess[] }, DomainError>> {
  let raw: string;
  try {
    raw = await readFile(registryPath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return ok({ workspaceId: '', processes: [] });
    return err({ code: 'Unavailable', reason: `The process registry at ${registryPath} could not be read: ${describeFailure(error)}` });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err({
      code: 'Unavailable',
      reason: `The process registry at ${registryPath} is not readable JSON, so which processes this attempt owns cannot be established (F14-AC5).`,
    });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return err({ code: 'Unavailable', reason: `The process registry at ${registryPath} is not a registry document.` });
  }
  const document = parsed as Record<string, unknown>;
  const workspaceId = document['workspaceId'];
  const entries = document['processes'];
  if (typeof workspaceId !== 'string' || !Array.isArray(entries)) {
    return err({ code: 'Unavailable', reason: `The process registry at ${registryPath} does not name its workspace or its process list.` });
  }
  const processes: OwnedProcess[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = assertOwnedProcess(entries[index], index);
    if (!entry.ok) return entry;
    processes.push(entry.value);
  }
  return ok({ workspaceId, processes });
}

async function writeProcessRegistry(
  registryPath: string,
  workspaceId: string,
  processes: readonly OwnedProcess[],
): Promise<Result<null, DomainError>> {
  const document = { version: REGISTRY_VERSION, workspaceId, processes } as const;
  const temporaryPath = `${registryPath}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: REGISTRY_FILE_MODE });
    await rename(temporaryPath, registryPath);
  } catch (error) {
    return err({
      code: 'Unavailable',
      reason: `The process registry for ${workspaceId} could not be written to ${registryPath}: ${describeFailure(error)}. A process that cannot be recorded is a process cleanup must not signal (F14-AC5).`,
    });
  }
  return ok(null);
}

/**
 * Records one process this attempt spawned, so cleanup can stop exactly it.
 *
 * A process that is not recorded here is not owned, and cleanup must never reach
 * it: the pid alone cannot prove the attempt created it, so the registry records
 * the process group together with an explicit statement of whether the spawn was
 * this attempt's (F14-AC5).
 */
export async function registerOwnedProcess(
  registryPath: string,
  workspaceId: string,
  process: OwnedProcess,
): Promise<Result<OwnedProcess, DomainError>> {
  const validated = assertOwnedProcess(process, 0);
  if (!validated.ok) return validated;
  const current = await readProcessRegistryDocument(registryPath);
  if (!current.ok) return current;
  const processes = current.value.processes.filter((entry) => entry.pid !== validated.value.pid);
  processes.push(validated.value);
  const written = await writeProcessRegistry(registryPath, workspaceId, processes);
  if (!written.ok) return written;
  return ok(validated.value);
}

/** Reads what this attempt recorded as its own processes; an absent registry owns nothing. */
export async function readOwnedProcesses(registryPath: string): Promise<Result<readonly OwnedProcess[], DomainError>> {
  const document = await readProcessRegistryDocument(registryPath);
  return document.ok ? ok(document.value.processes) : document;
}

interface WorkspaceResourcePlan {
  readonly resources: readonly OwnedResource[];
  readonly byId: ReadonlyMap<string, OwnedResource>;
}

function planWorkspaceResources(request: WorkspaceCleanupRequest, now: string): WorkspaceResourcePlan {
  const workspace = request.workspace;
  const retained = request.retainWorkspace;
  const resources: OwnedResource[] = [
    {
      id: `data:${workspace.workspaceId}`,
      kind: 'TemporaryDirectory',
      path: workspace.paths.dataDirectory,
      port: null,
      retainForRecovery: false,
      sharedProjectData: false,
      createdAt: now,
    },
    {
      id: `browser-profile:${workspace.workspaceId}`,
      kind: 'BrowserProfile',
      path: workspace.paths.browserProfileDirectory,
      port: null,
      retainForRecovery: false,
      sharedProjectData: false,
      createdAt: now,
    },
    {
      id: `worktree:${workspace.workspaceId}`,
      kind: 'TemporaryDirectory',
      path: workspace.paths.worktreePath,
      port: null,
      retainForRecovery: retained,
      sharedProjectData: false,
      createdAt: now,
    },
    {
      id: `lock:${workspace.workspaceId}`,
      kind: 'ServiceData',
      path: workspace.paths.lockDocumentPath,
      port: null,
      retainForRecovery: retained,
      sharedProjectData: false,
      createdAt: now,
    },
    {
      id: `processes:${workspace.workspaceId}`,
      kind: 'ServiceData',
      path: workspace.paths.processRegistryPath,
      port: null,
      retainForRecovery: retained,
      sharedProjectData: false,
      createdAt: now,
    },
    ...workspace.ports.map((port) => ({
      id: `port:${workspace.workspaceId}:${port.serviceName}`,
      kind: 'PortAllocation' as const,
      path: null,
      port: port.port,
      retainForRecovery: false,
      sharedProjectData: false,
      createdAt: now,
    })),
  ];
  return { resources, byId: new Map(resources.map((resource) => [resource.id, resource])) };
}

/**
 * Cleans up one attempt's workspace (F14-AC5).
 *
 * Three refusals are the contract, and they are enforced here rather than left to
 * the caller:
 *
 *   - only a process group this attempt spawned is signalled, and only by its
 *     group id, so a command that spawned children cannot leave them behind and a
 *     pid this attempt did not create cannot be reached;
 *   - work and evidence marked for recovery, and the worktree with them, survive an
 *     ordinary cancellation, because a cancelled attempt still has to be
 *     recoverable;
 *   - the connected repository itself is never a resource here, so no cleanup can
 *     reach the owner's checkout or any worktree it already had.
 *
 * The worktree is removed through Git, which also updates the connected
 * repository's own record of it, and ports are released because the processes
 * holding them have just been stopped.
 */
export async function cleanupWorkspace(
  request: WorkspaceCleanupRequest,
  deps: WorkspaceCleanupDeps,
): Promise<Result<WorkspaceCleanupOutcome, DomainError>> {
  const workspace = request.workspace;
  const plan = planWorkspaceResources(request, request.now);
  const registry = {
    attemptId: workspace.workspaceId,
    processes: request.processes,
    resources: plan.resources,
  } as const;

  const removePath = async (path: string): Promise<void> => {
    if (path === workspace.paths.worktreePath) {
      await removeWorkspaceWorktree(deps.runCommand, deps.removePath, workspace.repositoryPath, path);
      return;
    }
    await deps.removePath(path);
  };

  const report = await cleanupOwnedResources(registry, { ...deps, removePath });
  const releasedPorts = deps.ownership.releasePorts(workspace.workspaceId, workspace.owner);
  const releasedLock = request.retainWorkspace
    ? ok(null)
    : deps.ownership.releaseLock(workspace.workspaceId, workspace.owner);
  const ownershipProblems = [
    ...(releasedPorts.ok ? [] : [releasedPorts.error.reason]),
    ...(releasedLock.ok ? [] : [releasedLock.error.reason]),
  ];
  const failures = [
    ...report.failures,
    ...ownershipProblems.map((message) => ({ resourceId: `ownership:${workspace.workspaceId}`, message })),
  ];
  if (failures.length > 0) {
    return err({
      code: 'Unavailable',
      reason: `Cleanup of workspace ${workspace.workspaceId} could not remove or release everything it owned: ${failures
        .map((failure) => `${failure.resourceId}: ${failure.message}`)
        .join('; ')}. Those resources were left in place rather than reported as released (F14-AC5).`,
    });
  }

  const removedPaths = report.removedResourceIds
    .map((id) => plan.byId.get(id)?.path)
    .filter((path): path is string => path !== null && path !== undefined);
  const retainedPaths = report.retainedResourceIds
    .map((id) => plan.byId.get(id)?.path)
    .filter((path): path is string => path !== null && path !== undefined);

  return ok({
    workspaceId: workspace.workspaceId,
    retained: request.retainWorkspace,
    report,
    removedPaths,
    retainedPaths,
    releasedPortReservations: workspace.ports.map((port) => port.port),
  });
}

function requiredText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`column ${column} is missing or not text`);
  return value;
}

function requiredInteger(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`column ${column} is missing or not an integer`);
}

function lockFromRow(row: SqlRow): WorkspaceLockRecord {
  return {
    workspaceId: requiredText(row, 'workspace_id'),
    jobId: requiredText(row, 'job_id') as JobId,
    holder: requiredText(row, 'holder'),
    branchName: requiredText(row, 'branch_name'),
    worktreePath: requiredText(row, 'worktree_path'),
    acquiredAt: requiredText(row, 'acquired_at'),
  };
}

function portFromRow(row: SqlRow): PortReservationRecord {
  return {
    workspaceId: requiredText(row, 'workspace_id'),
    jobId: requiredText(row, 'job_id') as JobId,
    holder: requiredText(row, 'holder'),
    serviceName: requiredText(row, 'service_name'),
    port: requiredInteger(row, 'port'),
  };
}

/**
 * Durable workspace ownership over the migrated `workspace_locks` and
 * `workspace_ports` tables.
 *
 * Ownership is taken and given up inside one immediate transaction, so two writers
 * cannot both believe they hold a workspace, and the port collision is reported
 * with the workspace that already holds the port rather than as a bare constraint
 * failure. The unique index on `workspace_ports.port` remains the authority: the
 * pre-check exists so the owner is told who holds it, not so the database can be
 * talked out of it.
 */
export function sqliteWorkspaceOwnership(database: Database): WorkspaceOwnership {
  return {
    acquireLock(lock) {
      try {
        return withTransaction(database, () => {
          const existing = database.prepare('SELECT * FROM workspace_locks WHERE workspace_id = ?').get(lock.workspaceId);
          if (existing !== undefined) {
            const held = lockFromRow(existing);
            if (held.holder !== lock.holder || held.jobId !== lock.jobId) {
              return err(
                conflict(
                  `Workspace ${lock.workspaceId} is already owned by ${held.holder} for job ${held.jobId}, so this attempt cannot take it (F14-AC1).`,
                  `${lock.holder}/${lock.jobId}`,
                  `${held.holder}/${held.jobId}`,
                ),
              );
            }
            return ok(held);
          }
          database
            .prepare(
              'INSERT INTO workspace_locks (workspace_id, job_id, holder, branch_name, worktree_path, acquired_at) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(lock.workspaceId, lock.jobId, lock.holder, lock.branchName, lock.worktreePath, lock.acquiredAt);
          const stored = database.prepare('SELECT * FROM workspace_locks WHERE workspace_id = ?').get(lock.workspaceId);
          if (stored === undefined) throw new Error('The workspace lock row was unreadable immediately after insert.');
          return ok(lockFromRow(stored));
        });
      } catch (error) {
        return err({ code: 'Unavailable', reason: `The workspace lock for ${lock.workspaceId} could not be recorded: ${describeFailure(error)}` });
      }
    },
    readLock(workspaceId) {
      const row = database.prepare('SELECT * FROM workspace_locks WHERE workspace_id = ?').get(workspaceId);
      return row === undefined ? null : lockFromRow(row);
    },
    releaseLock(workspaceId, holder) {
      try {
        return withTransaction(database, () => {
          const outcome = database
            .prepare('DELETE FROM workspace_locks WHERE workspace_id = ? AND holder = ?')
            .run(workspaceId, holder);
          if (Number(outcome.changes) === 0) {
            return err(
              conflict(
                `Workspace ${workspaceId} is not held by ${holder}, so this attempt cannot release it (F14-AC1).`,
                `held by ${holder}`,
                'held by another holder, or not held at all',
              ),
            );
          }
          return ok(null);
        });
      } catch (error) {
        return err({ code: 'Unavailable', reason: `The lock on workspace ${workspaceId} could not be released: ${describeFailure(error)}` });
      }
    },
    reservePorts(request) {
      try {
        return withTransaction(database, (): Result<readonly PortReservationRecord[], DomainError> => {
          const collisions: string[] = [];
          for (const allocation of request.allocations) {
            const occupant = database.prepare('SELECT * FROM workspace_ports WHERE port = ?').get(allocation.port);
            if (occupant === undefined) continue;
            const held = portFromRow(occupant);
            if (held.workspaceId === request.workspaceId) continue;
            collisions.push(
              `port ${allocation.port} for ${allocation.serviceName} belongs to workspace ${held.workspaceId} (job ${held.jobId}, holder ${held.holder})`,
            );
          }
          if (collisions.length > 0) {
            return err(
              blocked(`Workspace ${request.workspaceId} cannot start its services: ${collisions.join('; ')}.`, [
                {
                  name: 'isolated-port-allocation',
                  detail: collisions.join('; '),
                  remedy:
                    'Stop the other workspace or move one workspace to different ports, then start again. Reusing the reserved port would report another run\'s behaviour as this job\'s result (F14-AC3).',
                },
              ]),
            );
          }
          const reservations: PortReservationRecord[] = [];
          for (const allocation of request.allocations) {
            database
              .prepare(
                `INSERT INTO workspace_ports (workspace_id, service_name, port, job_id, holder, reserved_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(workspace_id, service_name) DO UPDATE SET
                   port = excluded.port, job_id = excluded.job_id, holder = excluded.holder, reserved_at = excluded.reserved_at`,
              )
              .run(
                request.workspaceId,
                allocation.serviceName,
                allocation.port,
                request.jobId,
                request.holder,
                request.now,
              );
            reservations.push({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              holder: request.holder,
              serviceName: allocation.serviceName,
              port: allocation.port,
            });
          }
          return ok(reservations);
        });
      } catch (error) {
        return err(
          blocked(`Workspace ${request.workspaceId} could not reserve its ports: ${sanitizeGitOutput(describeFailure(error))}.`, [
            {
              name: 'isolated-port-allocation',
              detail: describeFailure(error),
              remedy:
                'Treat the database as authoritative about which ports exist, and reconcile before starting services. A port that cannot be reserved cannot be started on (F14-AC3).',
            },
          ]),
        );
      }
    },
    releasePorts(workspaceId, holder) {
      try {
        return withTransaction(database, () => {
          database.prepare('DELETE FROM workspace_ports WHERE workspace_id = ? AND holder = ?').run(workspaceId, holder);
          return ok(null);
        });
      } catch (error) {
        return err({ code: 'Unavailable', reason: `The ports of workspace ${workspaceId} could not be released: ${describeFailure(error)}` });
      }
    },
    readPortOwner(port) {
      const row = database.prepare('SELECT * FROM workspace_ports WHERE port = ?').get(port);
      return row === undefined ? null : portFromRow(row);
    },
  };
}
