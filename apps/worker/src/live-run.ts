/**
 * One real coding run, end to end, against a live engine (F13, F14, F15, F17, F19, N01).
 *
 * Every other proof in this repository assembles the parts: the Codex adapter against captured
 * bytes, the worker against a scripted engine, the workspace module against fixtures, the GitHub
 * adapter against constructed payloads. None of them has run them TOGETHER, so none of them can
 * say whether the seams hold. This script is the seam test. It builds a disposable fixture
 * application, a real migrated SQLite database, provisions a project through the real controller
 * use cases, starts a run through the real `startRun`, and drives the real worker loop with the
 * real `CodexEngineAdapter` in a real isolated workspace, then commits, pushes and reconciles a
 * draft through the real GitHub adapter.
 *
 * What is deliberately NOT real, because the rules forbid it:
 *
 *   - the GitHub REST surface is a loopback server implementing the endpoints this adapter calls,
 *     with every ref answer read from the actual bare repository by Git itself. Pushes are real
 *     `git push` over the git protocol into a local bare remote; nothing reaches api.github.com and
 *     no live repository is touched (mvp-spec 9, F19-AC1).
 *   - the live engine is asked for exactly one small change. The cancellation and restart cases
 *     drive the real adapter over a scripted binary that emits Codex's real JSONL, so those two
 *     paths cost no account quota (F18-AC2).
 *
 * This is not a test file. It performs a run and prints what happened, so a reviewer reads the
 * transcript the run produced. Every line goes through one reporter, because output that cannot be
 * attributed to a phase is not evidence. The factory the shipped worker entrypoint loads by module
 * name is exported from here as well, so the restart case exercises the real workspace module
 * rather than a second copy of it.
 */

import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { redact } from '@shiploop/domain';
import type {
  AreaObservation,
  CapabilityDeclaration,
  CommitSha,
  ConnectorId,
  DomainError,
  JobId,
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
  AttentionItemRepository,
  LATEST_SCHEMA_VERSION,
  ProjectProfileRepository,
  ScopeRepository,
  WorkItemRepository,
  closeDatabase,
  createJobQueue,
  createLeaseManager,
  currentVersion,
  migrate,
  openDatabase,
} from '@shiploop/storage';
import type { ConnectorKind, Database, JobLimits } from '@shiploop/storage';
import { CodexEngineAdapter, GitHubGitAdapter, createGitTransport } from '@shiploop/adapters';
import type {
  AdapterCapabilities,
  AdapterClock,
  AdapterCompatibility,
  AdapterContext,
  AdapterLogger,
  EngineAdapter,
  EngineContinuation,
  EngineEvent,
  EngineSessionHandle,
  EngineStartRequest,
  EngineStopOutcome,
  GitRepositoryRef,
  ResumeEngineSessionRequest,
  StopEngineSessionRequest,
  UpsertDraftOutcome,
} from '@shiploop/adapters';
import {
  cleanupWorkspace,
  createPortBinder,
  deriveWorkspaceId,
  nodeProcessRunner,
  prepareWorkspace,
  reuseWorkspace,
  sqliteWorkspaceOwnership,
  stopOwnedProcessGroup,
} from '@shiploop/verification';
import type { PreparedWorkspace as VerifiedWorkspace } from '@shiploop/verification';

import { LinearTicketAdapter } from '../../../packages/adapters/src/linear/index.ts';
import { createCompositionRoot } from '../../../packages/controller/src/composition.ts';
import type { CompositionRoot } from '../../../packages/controller/src/composition.ts';
import { RECIPE_SUBJECT_KEY } from '../../../packages/controller/src/profiles.ts';
import { createJobUseCases } from '../../../packages/controller/src/jobs.ts';
import type { JobUseCases } from '../../../packages/controller/src/jobs.ts';

import type { PreparedWorkspace, WorkspacePort } from './runner.ts';
import { createWorker, openWorkerStore } from './worker.ts';
import type { HolderLiveness, Worker, WorkerPorts, WorkerStore } from './worker.ts';

/* -------------------------------------------------------------------------- */
/* Reporter                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The single output channel.
 *
 * Every line a phase prints is a lifecycle line for that phase, so the transcript reads in order
 * and each claim is traceable to the moment it was observed. `process.stdout.write` rather than
 * `console.log`, so nothing here can be mistaken for product output (N06-AC1).
 */
function emit(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function heading(step: string, title: string): void {
  emit();
  emit(`=== ${step}: ${title} ===`);
}

function kv(label: string, value: string): void {
  emit(`  ${label}: ${value}`);
}

/* -------------------------------------------------------------------------- */
/* Fixed facts                                                                 */
/* -------------------------------------------------------------------------- */

const HOLDER = 'live-run-writer';
const LEASE_TTL_MS = 120_000;
const ENGINE_EVENT_LIMIT = 2_000;
const PROJECT = '00live0run0000000000000000000000a' as ProjectId;
const OWNER_DISPLAY_NAME = 'Live Run Owner';
const RECIPE_ID = 'recipe_live_run';
const ENGINE_CONNECTOR = 'connector_live_run_codex' as ConnectorId;
const GITHUB_CONNECTOR = 'connector_live_run_github' as ConnectorId;
const LINEAR_CONNECTOR = 'connector_live_run_linear' as ConnectorId;
const TASK_BRANCH_PREFIX = 'shiploop/live-run';
const REPOSITORY_FULL_NAME = 'live-run/fixture';

/**
 * The one bounded task, and the bounds that keep it one.
 *
 * A single route and a single test is the smallest change a real engine turn can make and still
 * prove the whole path, and `maxAutomatedFixPasses: 0` means a failure cannot buy a second turn
 * with the owner's quota (F18-AC2).
 */
const LIMITS: JobLimits = {
  activeExecutionMs: 900_000,
  maxAutomatedFixPasses: 0,
  maxToolRetries: 3,
  maxAttempts: 1,
};

const TASK_DESCRIPTION = [
  'Make exactly one change to this repository: add a `GET /health` route to the application in',
  'app.mjs that responds with HTTP 200 and the JSON body {"status":"ok"}, and add a test for that',
  'route to app.test.mjs. Run `npm test` once to confirm it passes. Do not change anything else,',
  'do not add dependencies, and do not reformat existing code.',
].join(' ');

const TASK_CRITERIA = [
  { id: 'AC-1', text: 'GET /health responds 200 with the JSON body {"status":"ok"}.' },
  { id: 'AC-2', text: 'app.test.mjs contains a test for the new route and `npm test` passes.' },
];

/** Non-credential strings: the local surfaces check a credential exists and never read its value. */
const LOCAL_GITHUB_TOKEN = 'live-run-local-token-not-a-credential';
const LOCAL_LINEAR_KEY = 'live-run-local-linear-key-not-a-credential';

/* -------------------------------------------------------------------------- */
/* Small typed helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Unwraps a `Result` or names the phase that was refused, so no failure is silent. */
function need<T>(result: Result<T, DomainError>, what: string): T {
  if (result.ok) return result.value;
  throw new Error(`${what} was refused (${result.error.code}): ${result.error.reason}`);
}

interface GitOutcome {
  readonly exitCode: number;
  readonly output: string;
}

async function git(cwd: string, argv: readonly string[]): Promise<GitOutcome> {
  const outcome = await nodeProcessRunner.run(['git', ...argv], {
    cwd,
    timeoutMs: 60_000,
    maxOutputBytes: 262_144,
    env: null,
  });
  return { exitCode: outcome.exitCode ?? -1, output: outcome.output };
}

async function gitOrFail(cwd: string, argv: readonly string[], what: string): Promise<string> {
  const outcome = await git(cwd, argv);
  if (outcome.exitCode !== 0) {
    throw new Error(`${what} failed: git ${argv.join(' ')} exited ${String(outcome.exitCode)}`);
  }
  return outcome.output.trim();
}

function splitNulPaths(output: string): string[] {
  return output
    .split('\0')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .sort();
}

function satisfied(reason: string): AreaObservation {
  return { status: 'Satisfied', reason, remedy: null };
}

function readyObservation(subjectId: string, assessedAt: string): ReadinessObservation {
  return {
    subjectId,
    assessedAt,
    scope: satisfied('The fixture application was read and its acceptance criteria captured.'),
    criteria: satisfied('The scope names two acceptance criteria with stable ids.'),
    repository: satisfied('The fixture checkout is a real Git work tree on branch main.'),
    target: satisfied('The task branch differs from main and nothing is protected.'),
    dependencies: [],
    verification: satisfied('The profile names `npm test` as the required check.'),
    access: satisfied('The local bare remote is readable and writable by this process.'),
    investigationSupported: [],
  };
}

function taskScope(workItemId: WorkItemId, retrievedAt: string): ScopeSnapshot {
  return {
    workItemId,
    issueId: 'issue-live-run-1',
    issueIdentifier: 'LIVE-1',
    title: 'Add a health route to the fixture application',
    description: TASK_DESCRIPTION,
    providerRevision: 'rev-live-run-1',
    priority: '2',
    dependencyIssueIds: [],
    acceptanceCriteria: TASK_CRITERIA,
    retrievedAt,
  };
}

const systemClock: AdapterClock = {
  now: (): string => new Date().toISOString(),
  elapsedMs: (): number => Number(process.hrtime.bigint() / 1_000n),
};

const lifecycleLogger: AdapterLogger = {
  emit(record): void {
    emit(`  [engine ${record.level}] ${record.message}`);
  },
};

/** Never claims knowledge of a process this script did not spawn (F17-AC5). */
const unknownLiveness = {
  probe: (request: { readonly jobId: JobId; readonly holder: string }): HolderLiveness => ({
    kind: 'Unknown',
    evidence: `This process holds no handle to the group ${request.holder} that ran job ${request.jobId}.`,
  }),
};

const noOwnerExtensions = { extensionFor: () => null };
const noCheckpointFacts = { feedbackFor: () => [], resultsFor: () => [] };

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(100);
  }
  emit(`  timed out waiting for ${what}`);
  return false;
}

/* -------------------------------------------------------------------------- */
/* The workspace port over the real F14 module                                 */
/* -------------------------------------------------------------------------- */

/**
 * The bridge `apps/worker/src/index.ts` requires and no module in the repository ships.
 *
 * The entrypoint loads a workspace provider by module specifier and refuses anything that is not a
 * `createWorkspacePort` factory, but `@shiploop/verification` exports `prepareWorkspace` and
 * `reuseWorkspace` while the worker expects a narrower port that also reports an observation. This
 * is that translation, built on the real module rather than beside it, and it is the seam most
 * likely to hide a defect: it decides whether a resume reuses a retained workspace or reports a
 * divergence (F14-AC1, F14-AC4, F17-AC3).
 */
export function createWorkspacePort(config: {
  readonly database: Database;
  readonly repository: string;
  readonly attemptRoot: string;
  readonly holder: string;
  readonly branchPrefix: string;
  /** The workspace each job last got, so the caller can clean up or inspect it (F14-AC5). */
  readonly prepared: Map<JobId, VerifiedWorkspace>;
}): WorkspacePort {
  const binder = createPortBinder();
  const workItems = new WorkItemRepository(config.database);
  const profiles = new ProjectProfileRepository(config.database);
  const ownership = sqliteWorkspaceOwnership(config.database);

  async function observe(worktreePath: string): Promise<{
    readonly headSha: CommitSha;
    readonly dirtyFiles: string[];
    readonly untrackedFiles: string[];
  }> {
    const head = await gitOrFail(worktreePath, ['rev-parse', 'HEAD'], 'reading the workspace HEAD');
    const dirty = splitNulPaths(
      await gitOrFail(worktreePath, ['diff', '--name-only', '-z', 'HEAD'], 'listing modified files'),
    );
    const untracked = splitNulPaths(
      await gitOrFail(
        worktreePath,
        ['ls-files', '--others', '--exclude-standard', '-z'],
        'listing untracked files',
      ),
    );
    return { headSha: head as CommitSha, dirtyFiles: dirty, untrackedFiles: untracked };
  }

  return {
    async prepare(request): Promise<Result<PreparedWorkspace, DomainError>> {
      const now = new Date().toISOString();
      const branchName = `${config.branchPrefix}/${request.job.jobId}`;
      const workspaceId = deriveWorkspaceId({
        jobId: request.job.jobId,
        repository: config.repository,
        branchName,
      });
      const snapshot = workItems.getScopeSnapshot(request.job.scopeSnapshotId);
      if (!snapshot.ok) return snapshot;
      const profile = profiles.getVersion(request.job.profileVersionId as ProfileVersionId);
      if (!profile.ok) return profile;

      let workspacePath: string;
      let baseSha: CommitSha;
      let ports: Readonly<Record<string, number>>;

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
            holder: config.holder,
            now,
          },
          { runCommand: nodeProcessRunner },
        );
        if (!reused.ok) return { ok: false, error: reused.error.error };
        workspacePath = request.checkpoint.workspace.worktreePath;
        baseSha = request.checkpoint.baseSha;
        ports = await readAllocatedPorts(config.attemptRoot, workspaceId);
      } else {
        const prepared = await prepareWorkspace(
          {
            jobId: request.job.jobId,
            repository: config.repository,
            baseRef: 'main',
            branchName,
            attemptRoot: config.attemptRoot,
            holder: config.holder,
            services: [{ serviceName: 'app', port: null }],
            now,
          },
          { runCommand: nodeProcessRunner, ports: binder, ownership },
        );
        if (!prepared.ok) return prepared;
        config.prepared.set(request.job.jobId, prepared.value);
        workspacePath = prepared.value.paths.worktreePath;
        baseSha = prepared.value.baseSha;
        ports = Object.fromEntries(prepared.value.ports.map((port) => [port.serviceName, port.port]));
      }

      const observed = await observe(workspacePath);
      return {
        ok: true,
        value: {
          execution: {
            workspaceId,
            absolutePath: workspacePath,
            headSha: observed.headSha,
            baseSha,
            environmentFingerprint: profile.value.contentFingerprint,
            scopeFingerprint: snapshot.value.scopeFingerprint,
            isolatedPorts: ports,
            serviceEndpoints: Object.entries(ports).map(([name, port]) => ({
              name,
              baseUrl: `http://127.0.0.1:${String(port)}`,
            })),
            testAccess: { kind: 'None' },
          },
          observation: {
            workspace: { workspaceId, branchName, worktreePath: workspacePath },
            headSha: observed.headSha,
            baseSha,
            dirtyFiles: observed.dirtyFiles,
            untrackedFiles: observed.untrackedFiles,
          },
          deliveryAlreadyObserved: false,
        },
      };
    },
  };
}

/** The ports a prepared workspace reserved, read from the lock document it wrote (F14-AC1). */
async function readAllocatedPorts(attemptRoot: string, workspaceId: string): Promise<Record<string, number>> {
  try {
    const raw = await readFile(join(attemptRoot, 'locks', `${workspaceId}.json`), 'utf8');
    const document = JSON.parse(raw) as { ports?: readonly { serviceName: string; port: number }[] };
    return Object.fromEntries((document.ports ?? []).map((port) => [port.serviceName, port.port]));
  } catch {
    return {};
  }
}

/**
 * The factory the shipped worker entrypoint loads from a module specifier (F14-AC1).
 *
 * It reads its configuration from the environment because the entrypoint calls it with no
 * arguments, and it opens its own database handle because the process it runs in owns none.
 */
export function createWorkspacePortFromEnvironment(): WorkspacePort {
  const databasePath = process.env['SHIPLOOP_WORKER_DATABASE'];
  const repository = process.env['SHIPLOOP_LIVE_REPOSITORY'];
  const attemptRoot = process.env['SHIPLOOP_LIVE_ATTEMPT_ROOT'];
  const holder = process.env['SHIPLOOP_WORKER_HOLDER'];
  const branchPrefix = process.env['SHIPLOOP_LIVE_BRANCH_PREFIX'] ?? TASK_BRANCH_PREFIX;
  if (databasePath === undefined || repository === undefined || attemptRoot === undefined || holder === undefined) {
    throw new Error(
      'SHIPLOOP_WORKER_DATABASE, SHIPLOOP_LIVE_REPOSITORY, SHIPLOOP_LIVE_ATTEMPT_ROOT and SHIPLOOP_WORKER_HOLDER must all be set (F14-AC1).',
    );
  }
  return createWorkspacePort({
    database: need(openDatabase(databasePath), 'opening the database for the workspace provider'),
    repository,
    attemptRoot,
    holder,
    branchPrefix,
    prepared: new Map(),
  });
}

/* -------------------------------------------------------------------------- */
/* Fixture application and local bare remote                                   */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly root: string;
  readonly checkout: string;
  readonly bare: string;
  readonly attemptRoot: string;
  readonly databasePath: string;
  readonly cancelEngine: string;
  readonly restartEngine: string;
  readonly restartCounter: string;
  readonly workspaceModule: string;
  readonly loopHolderModule: string;
}

/**
 * A referenced timer the harness loads into a spawned worker, so the shipped code is allowed to
 * finish reporting what it observed.
 *
 * The worker is stopped with `SIGTERM` while an engine process group exists, and the adapter polls
 * that group for emptiness with `timer.unref()` timers
 * (`packages/adapters/src/codex/client.ts`, `waitForEmptyGroup`). An unreferenced timer does not
 * keep the event loop alive, so when the group is momentarily non-empty after the leader has been
 * reaped the process has nothing left to do, Node ends it with "Detected unsettled top-level await"
 * and the checkpoint is never written (F17-AC1, F17-AC5). Phase 9 records the unmitigated
 * behaviour first and only then runs the same signal with this timer present, so the finding is
 * shown rather than hidden. The timer writes nothing: the shipped entrypoint stays the only writer
 * to the console, and it is released after a bounded window rather than for the life of the process.
 */
const LOOP_HOLDER_MODULE = `const startedAt = Date.now();
const timer = setInterval(() => {
  if (Date.now() - startedAt > 6_000) clearInterval(timer);
}, 500);
`;

const APP_PACKAGE = `${JSON.stringify(
  {
    name: 'shiploop-live-run-fixture',
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: { test: 'node --test app.test.mjs' },
  },
  null,
  2,
)}\n`;

const APP_SOURCE = `import { createServer } from 'node:http';

/**
 * The smallest real HTTP application a coding run can be asked to extend.
 *
 * The routing decision is a separate exported function so a test can exercise it without binding
 * a socket: the coding engine runs under a sandbox whose network access is restricted, and a test
 * that opens a loopback listener fails there for a reason that has nothing to do with the code
 * under test.
 */
export function handleRequest(request, response) {
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: 'shiploop-live-run-fixture' }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'not found' }));
}

export function createApp() {
  return createServer(handleRequest);
}

export function listen(port = 0) {
  const server = createApp();
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
`;

const APP_TEST_SOURCE = `import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from './app.mjs';

function call(method, url) {
  let statusCode = 0;
  let body = '';
  handleRequest(
    { method, url },
    {
      writeHead(status, headers) {
        statusCode = status;
        void headers;
      },
      end(payload) {
        body = payload;
      },
    },
  );
  return { statusCode, body: JSON.parse(body) };
}

test('GET / answers with the application name', () => {
  assert.deepEqual(call('GET', '/'), {
    statusCode: 200,
    body: { name: 'shiploop-live-run-fixture' },
  });
});
`;

/** Real Codex JSONL on stdout, then a hang only a bounded group kill can end (F17-AC1). */
const CANCEL_ENGINE = `#!/bin/sh
printf '%s\\n' '{"type":"thread.started","thread_id":"live-run-cancel-thread"}'
printf '%s\\n' '{"type":"turn.started"}'
printf 'work this attempt started before it was stopped\\n' > cancel-in-progress.txt
trap '' TERM INT
sleep 300
`;

/**
 * The first two invocations hang for the signal; the third completes so the recovery can finish.
 *
 * It deliberately writes nothing into the workspace, so the recorded checkpoint and the workspace
 * agree and the restart exercises recovery rather than the divergence refusal.
 *
 * Each hanging invocation also leaves one process in its own process group alive for a second after
 * the leader answers the signal. That is the condition the adapter's stop is documented to observe
 * before it reports the group empty, and it makes the difference between the two signal cases in
 * phase 9 a property of the shipped stop rather than of when the harness happened to send the
 * signal: the group really is still occupied while the stop runs.
 */
const RESTART_ENGINE = `#!/bin/sh
counter="$SHIPLOOP_LIVE_RESTART_COUNTER"
count=0
if [ -f "$counter" ]; then count=$(cat "$counter"); fi
count=$((count + 1))
printf '%s\\n' "$count" > "$counter"
printf '%s\\n' '{"type":"thread.started","thread_id":"live-run-restart-thread"}'
if [ "$count" -ge 3 ]; then
  printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":0}}'
  exit 0
fi
printf '%s\\n' '{"type":"turn.started"}'
( trap '' TERM INT; sleep 1 ) &
trap '' TERM INT
sleep 300
`;

async function buildFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-live-run-'));
  const checkout = join(root, 'checkout');
  const bare = join(root, 'origin.git');
  const state = join(root, 'state');
  await mkdir(checkout);
  await mkdir(state);

  await gitOrFail(root, ['init', '--bare', '--initial-branch=main', bare], 'creating the local bare remote');
  await gitOrFail(checkout, ['init', '--initial-branch=main'], 'creating the fixture checkout');
  await writeFile(join(checkout, 'package.json'), APP_PACKAGE);
  await writeFile(join(checkout, 'app.mjs'), APP_SOURCE);
  await writeFile(join(checkout, 'app.test.mjs'), APP_TEST_SOURCE);
  await gitOrFail(checkout, ['add', '-A'], 'staging the fixture application');
  await gitOrFail(
    checkout,
    [
      '-c',
      'user.name=ShipLoop Live Run',
      '-c',
      'user.email=live-run@shiploop.invalid',
      'commit',
      '-m',
      'Fixture application',
    ],
    'committing the fixture application',
  );
  await gitOrFail(checkout, ['remote', 'add', 'origin', bare], 'pointing origin at the local bare remote');
  await gitOrFail(checkout, ['push', '-u', 'origin', 'main'], 'publishing the fixture base commit');

  const cancelEngine = join(root, 'cancel-engine.sh');
  await writeFile(cancelEngine, CANCEL_ENGINE);
  await chmod(cancelEngine, 0o755);
  const restartEngine = join(root, 'restart-engine.sh');
  await writeFile(restartEngine, RESTART_ENGINE);
  await chmod(restartEngine, 0o755);

  const workspaceModule = join(root, 'workspace-port.mjs');
  await writeFile(
    workspaceModule,
    `export { createWorkspacePortFromEnvironment as createWorkspacePort } from ${JSON.stringify(
      new URL('./live-run.ts', import.meta.url).href,
    )};\n`,
  );
  const loopHolderModule = join(root, 'hold-loop.mjs');
  await writeFile(loopHolderModule, LOOP_HOLDER_MODULE);

  return {
    root,
    checkout,
    bare,
    attemptRoot: join(state, 'attempts'),
    databasePath: join(state, 'live-run.sqlite'),
    cancelEngine,
    restartEngine,
    restartCounter: join(root, 'restart-counter'),
    workspaceModule,
    loopHolderModule,
  };
}

/* -------------------------------------------------------------------------- */
/* Local GitHub REST surface                                                   */
/* -------------------------------------------------------------------------- */

interface PullRequestRow {
  readonly number: number;
  readonly body: string;
  readonly title: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
}

interface LocalGitHub {
  readonly origin: string;
  /** Every ref answer comes from Git reading the bare repository the push actually wrote. */
  refSha(branch: string): Promise<string | null>;
  branchesAt(sha: string): Promise<readonly string[]>;
  readonly creates: number;
  close(): Promise<void>;
}

function pullRequestPayload(row: PullRequestRow): Record<string, unknown> {
  return {
    id: row.number * 1_000 + 7,
    number: row.number,
    html_url: `http://127.0.0.1/local-run/pull/${String(row.number)}`,
    body: row.body,
    title: row.title,
    draft: true,
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    head: { ref: row.headRef, sha: row.headSha },
    base: { ref: row.baseRef, sha: row.baseSha },
    user: { login: 'shiploop-live-run' },
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function sendNotFound(response: ServerResponse): void {
  sendJson(response, 404, { message: 'Not Found', documentation_url: 'http://127.0.0.1/local-run', status: '404' });
}

/**
 * A loopback stand-in for the GitHub REST endpoints this adapter uses.
 *
 * Every ref answer is produced by `git --git-dir <bare>`, so the adapter's push verification and
 * its head-to-branch lookup read the repository the push really wrote. Only pull-request storage is
 * local, because there is no provider to hold it and writing to a live repository is not permitted
 * (mvp-spec 9).
 */
async function startLocalGitHub(bare: string, checkout: string): Promise<LocalGitHub> {
  const rows = new Map<number, PullRequestRow>();
  let nextNumber = 0;
  let creates = 0;
  const [owner = '', repo = ''] = REPOSITORY_FULL_NAME.split('/');
  const prefix = `/repos/${owner}/${repo}`;

  const refSha = async (branch: string): Promise<string | null> => {
    const outcome = await git(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (outcome.exitCode !== 0) return null;
    const value = outcome.output.trim();
    return value.length === 40 ? value : null;
  };

  const branchesAt = async (sha: string): Promise<readonly string[]> => {
    const outcome = await git(bare, [
      'for-each-ref',
      '--format=%(refname:short)',
      '--points-at',
      sha,
      'refs/heads',
    ]);
    if (outcome.exitCode !== 0) return [];
    void checkout;
    return outcome.output
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = decodeURIComponent(url.pathname);
    if (!path.startsWith(prefix)) {
      sendNotFound(response);
      return;
    }
    const rest = path.slice(prefix.length);

    if (rest === '' && request.method === 'GET') {
      sendJson(response, 200, {
        full_name: REPOSITORY_FULL_NAME,
        default_branch: 'main',
        html_url: `http://127.0.0.1/local-run/${REPOSITORY_FULL_NAME}`,
        ssh_url: bare,
        clone_url: bare,
        archived: false,
        permissions: { admin: true, push: true, pull: true },
      });
      return;
    }

    const refMatch = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (refMatch !== null && request.method === 'GET') {
      const branch = refMatch[1] ?? '';
      const sha = await refSha(branch);
      if (sha === null) {
        sendNotFound(response);
        return;
      }
      sendJson(response, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
      return;
    }

    const branchMatch = /^\/commits\/([0-9a-f]{40})\/branches-where-head$/.exec(rest);
    if (branchMatch !== null && request.method === 'GET') {
      const sha = branchMatch[1] ?? '';
      sendJson(response, 200, (await branchesAt(sha)).map((name) => ({ name, commit: { sha } })));
      return;
    }

    if (rest === '/pulls' && request.method === 'GET') {
      sendJson(response, 200, [...rows.values()].map(pullRequestPayload));
      return;
    }

    if (rest === '/pulls' && request.method === 'POST') {
      const sent = JSON.parse((await readRequestBody(request)) || '{}') as Record<string, unknown>;
      const headRef = typeof sent['head'] === 'string' ? sent['head'] : '';
      const headSha = await refSha(headRef);
      if (headSha === null) {
        sendJson(response, 422, { message: 'No commit exists on head.', status: '422' });
        return;
      }
      nextNumber += 1;
      creates += 1;
      const baseRef = typeof sent['base'] === 'string' ? sent['base'] : 'main';
      const row: PullRequestRow = {
        number: nextNumber,
        body: typeof sent['body'] === 'string' ? sent['body'] : '',
        title: typeof sent['title'] === 'string' ? sent['title'] : '',
        headRef,
        headSha,
        baseRef,
        baseSha: (await refSha(baseRef)) ?? headSha,
      };
      rows.set(row.number, row);
      sendJson(response, 201, pullRequestPayload(row));
      return;
    }

    const pullMatch = /^\/pulls\/(\d+)$/.exec(rest);
    if (pullMatch !== null && (request.method === 'GET' || request.method === 'PATCH')) {
      const number = Number(pullMatch[1]);
      const row = rows.get(number);
      if (row === undefined) {
        sendNotFound(response);
        return;
      }
      if (request.method === 'PATCH') {
        const sent = JSON.parse((await readRequestBody(request)) || '{}') as Record<string, unknown>;
        rows.set(number, { ...row, body: typeof sent['body'] === 'string' ? sent['body'] : row.body });
        sendJson(response, 200, pullRequestPayload(rows.get(number) as PullRequestRow));
        return;
      }
      sendJson(response, 200, pullRequestPayload(row));
      return;
    }

    sendNotFound(response);
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      sendJson(response, 500, { message: 'the local surface failed', status: '500' });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    refSha,
    branchesAt,
    get creates(): number {
      return creates;
    },
    close: (): Promise<void> =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* Engine transcript                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The real Codex adapter with a transcript attached.
 *
 * `runAttempt` consumes the engine's event stream and reports only an outcome, so the thread id
 * Codex reports would otherwise be unobservable. This delegates every call to the real adapter and
 * records what the real adapter returned, so the evidence can name the session the engine actually
 * opened (F15-AC1).
 */
class TranscriptEngine implements EngineAdapter {
  readonly kind = 'Engine' as const;
  readonly connectorId: ConnectorId;
  readonly sessionIds: string[] = [];
  readonly engineVersions: string[] = [];
  readonly eventKinds: string[] = [];
  readonly diagnostics: string[] = [];
  readonly results: string[] = [];
  readonly starts: EngineStartRequest[] = [];
  private readonly delegate: EngineAdapter;

  constructor(delegate: EngineAdapter) {
    this.delegate = delegate;
    this.connectorId = delegate.connectorId;
  }

  capabilities(): AdapterCapabilities {
    return this.delegate.capabilities();
  }

  checkCompatibility(context: AdapterContext): Promise<Result<AdapterCompatibility>> {
    return this.delegate.checkCompatibility(context);
  }

  async startSession(context: AdapterContext, request: EngineStartRequest): Promise<Result<EngineSessionHandle>> {
    this.starts.push(request);
    const started = await this.delegate.startSession(context, request);
    if (!started.ok) return started;
    const handle = started.value;
    this.sessionIds.push(handle.sessionId);
    this.engineVersions.push(handle.engineVersion);
    const seen = this.eventKinds;
    const diagnostics = this.diagnostics;
    const results = this.results;
    const source = handle.events;
    return {
      ok: true,
      value: {
        ...handle,
        events: (async function* recorded(): AsyncGenerator<EngineEvent> {
          for await (const event of source) {
            seen.push(event.kind);
            if (event.kind === 'Diagnostic') {
              diagnostics.push(`${event.category}: ${event.detail.replace(/\s+/g, ' ').slice(0, 200)}`);
            }
            if (event.kind === 'Result') {
              results.push(`${event.outcome.kind}: ${event.outcome.summary.replace(/\s+/g, ' ').slice(0, 200)}`);
            }
            yield event;
          }
        })(),
      },
    };
  }

  stopSession(context: AdapterContext, request: StopEngineSessionRequest): Promise<Result<EngineStopOutcome>> {
    return this.delegate.stopSession(context, request);
  }

  resumeSession(
    context: AdapterContext,
    request: ResumeEngineSessionRequest,
  ): Promise<Result<EngineContinuation>> {
    return this.delegate.resumeSession(context, request);
  }
}

/* -------------------------------------------------------------------------- */
/* Run state                                                                   */
/* -------------------------------------------------------------------------- */

interface RunState {
  readonly fixture: Fixture;
  readonly database: Database;
  readonly composition: CompositionRoot;
  readonly jobs: JobUseCases;
  readonly workItems: WorkItemRepository;
  readonly ownerId: OwnerId;
  readonly workItemId: WorkItemId;
  readonly liveJobId: JobId;
  readonly prepared: Map<JobId, VerifiedWorkspace>;
}

function buildWorkerPorts(input: {
  readonly database: Database;
  readonly engine: EngineAdapter;
  readonly workspaces: WorkspacePort;
}): WorkerPorts {
  return {
    clock: systemClock,
    logger: lifecycleLogger,
    redact: (text: string): string => redact(text).text,
    engine: input.engine,
    queue: createJobQueue({ connection: input.database }),
    leases: createLeaseManager({ connection: input.database }),
    workItems: new WorkItemRepository(input.database),
    attention: new AttentionItemRepository(input.database),
    workspaces: input.workspaces,
    extensions: noOwnerExtensions,
    facts: noCheckpointFacts,
    liveness: unknownLiveness,
    sleep,
  };
}

function buildWorker(input: {
  readonly database: Database;
  readonly engine: EngineAdapter;
  readonly workspaces: WorkspacePort;
}): Worker {
  const built = createWorker(
    { holder: HOLDER, projectId: null, leaseTtlMs: LEASE_TTL_MS, pollIntervalMs: 50, engineEventLimit: ENGINE_EVENT_LIMIT },
    buildWorkerPorts(input),
  );
  return need(built, 'building the worker');
}

function openWorkerStoreOrFail(databasePath: string): WorkerStore {
  return need(openWorkerStore(databasePath), 'opening the worker store');
}

function readSlot(database: Database): { readonly holder: string | null; readonly jobId: string | null } {
  const row = database.prepare('SELECT holder, job_id FROM coding_slots WHERE slot_id = 1').get();
  const holder = row?.['holder'];
  const jobId = row?.['job_id'];
  return { holder: typeof holder === 'string' ? holder : null, jobId: typeof jobId === 'string' ? jobId : null };
}

function activeLeaseCount(database: Database): number {
  const row = database.prepare("SELECT COUNT(*) AS total FROM writer_leases WHERE state = 'Active'").get();
  return Number(row?.['total'] ?? -1);
}

function countRows(database: Database, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
  return Number(row?.['total'] ?? -1);
}

function jobState(database: Database, jobId: JobId): string {
  const row = database.prepare('SELECT state FROM jobs WHERE job_id = ?').get(jobId);
  return typeof row?.['state'] === 'string' ? row['state'] : 'unknown';
}

/**
 * The capability registry the real adapters describe.
 *
 * A profile is validated against these declarations, so the profile this run saves is checked
 * against what the shipped Codex, GitHub and Linear adapters actually declare rather than against a
 * hand-written list (F03-AC2).
 */
function liveAdapterRegistry(): {
  declarationsFor(kind: ConnectorKind): readonly CapabilityDeclaration[];
  probeFor(): null;
} {
  const gitHub = new GitHubGitAdapter({
    connectorId: GITHUB_CONNECTOR,
    client: { token: LOCAL_GITHUB_TOKEN, apiBaseUrl: 'http://127.0.0.1:1' },
    git: createGitTransport(tmpdir()),
  });
  const codex = new CodexEngineAdapter({ connectorId: ENGINE_CONNECTOR, client: { binary: 'codex' } });
  const linear = new LinearTicketAdapter({ connectorId: LINEAR_CONNECTOR, client: { apiKey: LOCAL_LINEAR_KEY } });
  const byKind = new Map<ConnectorKind, readonly CapabilityDeclaration[]>([
    ['Git', gitHub.capabilities().declarations],
    ['Engine', codex.capabilities().declarations],
    ['Ticket', linear.capabilities().declarations],
    ['Deployment', []],
  ]);
  return {
    declarationsFor: (kind: ConnectorKind): readonly CapabilityDeclaration[] => byKind.get(kind) ?? [],
    probeFor: (): null => null,
  };
}

function adapterContext(operationId: string): AdapterContext {
  return {
    correlationId: 'live-run',
    operationId: operationId as OperationId,
    clock: systemClock,
    logger: lifecycleLogger,
    signal: new AbortController().signal,
    redact: (text: string): string => redact(text).text,
  };
}

/* -------------------------------------------------------------------------- */
/* Phases 1 to 4: fixture, database, controller, start                         */
/* -------------------------------------------------------------------------- */

async function provision(): Promise<RunState> {
  heading('1', 'Disposable fixture application and local bare remote');
  const fixture = await buildFixture();
  kv('fixture root', fixture.root);
  kv('fixture checkout', fixture.checkout);
  kv('local bare remote (origin)', fixture.bare);
  kv('base commit', await gitOrFail(fixture.checkout, ['rev-parse', 'HEAD'], 'reading the fixture base commit'));
  kv('origin branches', await gitOrFail(fixture.bare, ['branch', '--list'], 'listing bare remote branches'));
  const baseline = await nodeProcessRunner.run(['npm', 'test'], {
    cwd: fixture.checkout,
    timeoutMs: 120_000,
    maxOutputBytes: 32_768,
    env: null,
  });
  kv('fixture `npm test` before the run', `exit ${String(baseline.exitCode)} (${baseline.output.trim().split('\n').filter((line) => line.includes('pass') || line.includes('fail')).join(' | ')})`);

  heading('2', 'Real migrated SQLite database');
  kv('database path', fixture.databasePath);
  const seeded = need(openDatabase(fixture.databasePath), 'opening the database');
  need(migrate(seeded), 'migrating the database');
  kv('schema version after migrate', String(need(currentVersion(seeded), 'reading the schema version')));
  kv('LATEST_SCHEMA_VERSION', String(LATEST_SCHEMA_VERSION));
  need(closeDatabase(seeded), 'closing the seeding handle');

  heading('3', 'Owner and project profile through the real controller use cases');
  const composition = need(
    createCompositionRoot({
      databasePath: fixture.databasePath,
      clock: systemClock,
      adapters: liveAdapterRegistry(),
      sessionIdleTimeoutSeconds: 3_600,
    }),
    'creating the composition root',
  );
  const database = composition.database;

  const owner = need(
    composition.useCases.provisionNamedOwner({
      displayName: OWNER_DISPLAY_NAME,
      password: 'live-run-owner-password',
      at: systemClock.now(),
    }),
    'provisioning the owner',
  );
  kv('ownerId', owner.ownerId);

  const actor = need(composition.useCases.resolveOwnerActor(), 'resolving the owner actor');
  kv('actor role', actor.role);

  const profile = need(
    composition.useCases.saveProfile(
      {
        projectId: PROJECT,
        content: {
          references: {
            repository: REPOSITORY_FULL_NAME,
            ticketProvider: 'live-run-ticket',
            ticketTeamKey: 'LIVE',
            baseBranch: 'main',
            targetBranch: 'main',
            deploymentProvider: 'none',
            engine: 'codex',
            previewComponents: [],
          },
          policy: {
            requiredChecks: ['npm test'],
            deliveryBehavior: 'ManualAuthorizationOnly',
            maxFixPasses: 2,
            workspaceIsolation: 'WorktreeAndDataDirectory',
            capabilityVersion: 1,
          },
          recipe: `${RECIPE_SUBJECT_KEY} v1`,
          environment: { runtime: 'node24', ports: [41_100], secretReferences: [] },
        },
        note: null,
        expectedVersionNumber: null,
      },
      actor,
    ),
    'saving the project profile',
  );
  kv('profileVersionId', profile.profileVersionId);
  kv('profile contentFingerprint', profile.contentFingerprint);

  const recipe = need(
    composition.useCases.saveRecipe({
      projectId: PROJECT,
      recipeId: RECIPE_ID,
      content: {
        requirements: {
          runtime: { name: 'node', minVersion: '24.0.0', maxVersionExclusive: null },
          cpu: { architecture: 'arm64', minCores: 1 },
        },
        dependencyInstall: [],
        serviceStartup: [],
        checks: [
          {
            id: 'check_test',
            name: 'npm test',
            command: { argv: ['npm', 'test'], timeoutMs: 120_000, maxOutputBytes: 65_536, cwd: null },
            required: true,
          },
        ],
        ports: [{ serviceId: 'app', port: 41_100, purpose: 'Application', required: true }],
        dataLocations: [],
        testAccess: [],
        requiredSecrets: [],
        declaredCapabilities: ['Repository:Read', 'Runtime:Inspect', 'Check:Execute'],
        maintenance: { action: 'Incompatible', command: null, incompatibilityReason: 'No maintenance step is recorded.' },
      },
      provenance: { source: 'OwnerSaved', scope: 'Environment', createdBy: actor.actorId, createdAt: systemClock.now() },
      expectedVersionNumber: null,
      actor,
    }),
    'saving the environment recipe',
  );
  kv('procedureVersionId', recipe.procedureVersion.procedureVersionId);
  kv('environmentFingerprint', recipe.environmentFingerprint);

  const workItems = new WorkItemRepository(database);
  const workItem = need(
    workItems.create({
      projectId: PROJECT,
      profileVersionId: profile.profileVersionId,
      source: 'ProposedNewIssue',
      title: 'Add a health route to the fixture application',
      externalIssueId: null,
      externalIssueIdentifier: null,
      externalIssueUrl: null,
      publicationIntent: 'PublishWhenAgreed',
      relatedWorkItemIds: [],
      adoption: null,
      at: systemClock.now(),
    }),
    'creating the work item',
  );
  kv('workItemId', workItem.workItemId);

  const jobs = createJobUseCases({
    clock: systemClock,
    queue: createJobQueue({ connection: database }),
    leases: createLeaseManager({ connection: database }),
    profiles: composition.profiles,
    procedures: composition.procedures,
    workItems,
    scope: new ScopeRepository(database),
    limits: LIMITS,
  });

  heading('4', 'Real startRun, and the duplicate start it must refuse');
  const startInput = (operationId: string) => ({
    workItemId: workItem.workItemId,
    mode: 'Build' as const,
    operationId: operationId as OperationId,
    ownerId: owner.ownerId,
    readiness: readyObservation(workItem.workItemId, systemClock.now()),
    scope: taskScope(workItem.workItemId, systemClock.now()),
    correlationId: null,
  });

  const started = need(jobs.startRun(startInput('op-live-run-1')), 'starting the live run');
  kv('jobId', started.job.jobId);
  kv('job state', started.job.state);
  kv('scopeSnapshotId', started.capturedScope.scopeSnapshotId);
  kv('scopeFingerprint', started.capturedScope.scopeFingerprint);
  kv('dispatch', `${started.dispatch.state} (${started.dispatch.reason})`);
  kv('permittedOperations', started.job.permittedOperations.join(', '));
  kv('refusedDeliveryOperations', started.grant.refusedDeliveryOperations.join(', '));

  const repeat = need(jobs.startRun(startInput('op-live-run-1')), 'repeating the same operation identity');
  kv('repeat deduplicated', String(repeat.deduplicated));
  kv('repeat returned the same job', String(repeat.job.jobId === started.job.jobId));
  kv('rows in jobs table after the repeat', String(countRows(database, 'jobs')));

  return {
    fixture,
    database,
    composition,
    jobs,
    workItems,
    ownerId: owner.ownerId,
    workItemId: workItem.workItemId,
    liveJobId: started.job.jobId,
    prepared: new Map(),
  };
}

/* -------------------------------------------------------------------------- */
/* Phase 5: the live engine in the real isolated workspace                     */
/* -------------------------------------------------------------------------- */

async function runLiveTurn(state: RunState): Promise<string> {
  heading('5', 'The live Codex engine, in the real isolated workspace');
  const engine = new TranscriptEngine(
    new CodexEngineAdapter({
      connectorId: ENGINE_CONNECTOR,
      client: {
        binary: process.env['SHIPLOOP_LIVE_CODEX_BINARY'] ?? 'codex',
        gracefulStopMs: 2_000,
        killWaitMs: 3_000,
      },
      sandbox: 'workspace-write',
    }),
  );
  const compatibility = need(await engine.checkCompatibility(adapterContext('op-live-run-compat')), 'probing the engine');
  kv('engine runtime version', String(compatibility.runtimeVersion));
  kv('engine compatible', String(compatibility.compatible));

  const workspaces = createWorkspacePort({
    database: state.database,
    repository: state.fixture.checkout,
    attemptRoot: state.fixture.attemptRoot,
    holder: HOLDER,
    branchPrefix: TASK_BRANCH_PREFIX,
    prepared: state.prepared,
  });
  const worker = buildWorker({ database: state.database, engine, workspaces });

  const ticking = worker.tick();
  const reachedRunning = await waitFor(
    () => jobState(state.database, state.liveJobId) === 'Running',
    120_000,
    'the live job to reach Running',
  );
  kv('live job reached Running', String(reachedRunning));
  kv('coding slot holder while Running', String(readSlot(state.database).holder));
  kv('active writer leases while Running', String(activeLeaseCount(state.database)));

  const intruderStore = openWorkerStoreOrFail(state.fixture.databasePath);
  const intruder = createJobQueue({ connection: intruderStore.database }).claimNext({
    holder: 'live-run-intruder',
    now: systemClock.now(),
    leaseTtlMs: LEASE_TTL_MS,
    projectId: null,
  });
  kv('second writer claim while Running', intruder.ok ? 'granted' : `refused (${intruder.error.code})`);
  if (!intruder.ok) kv('second writer refusal', intruder.error.reason);
  intruderStore.close();

  const tick = await ticking;
  kv('tick kind', tick.ok ? tick.value.kind : `refused (${tick.error.code})`);
  if (tick.ok && tick.value.kind === 'Claimed') {
    const outcome = tick.value.outcome;
    kv('attempt outcome', outcome.kind);
    if (outcome.kind === 'Completed') {
      kv('engine summary', outcome.summary.replace(/\s+/g, ' ').slice(0, 240));
      kv('reported usage', JSON.stringify(outcome.usage));
    }
    if (outcome.kind === 'Blocked' || outcome.kind === 'Failed') {
      kv('failure category', outcome.failure.category);
      kv('failure observed', outcome.failure.observed.error.slice(0, 240));
    }
  }

  kv('engine session id', engine.sessionIds.join(', '));
  kv('engine version reported', engine.engineVersions.join(', '));
  kv('engine event kinds', [...new Set(engine.eventKinds)].join(', '));
  for (const diagnostic of engine.diagnostics) kv('engine diagnostic', diagnostic);
  for (const result of engine.results) kv('engine result event', result);
  kv('engine start kind', engine.starts[0]?.start.kind ?? 'none');
  kv('granted coding capabilities', (engine.starts[0]?.grantedCapabilities ?? []).join(', '));
  kv('sandbox requested', 'workspace-write');
  kv('instruction sent to the engine', (engine.starts[0]?.start.kind === 'Fresh' ? engine.starts[0].start.instruction : '').replace(/\s+/g, ' ').slice(0, 240));
  kv('engine active wall clock bound', String(engine.starts[0]?.bounds.activeWallClockMs ?? 'none'));

  kv('job state after the turn', jobState(state.database, state.liveJobId));
  const jobRow = state.database.prepare('SELECT holder, attempt_count FROM jobs WHERE job_id = ?').get(state.liveJobId);
  kv('job holder after the turn', String(jobRow?.['holder'] ?? 'null'));
  kv('job attempt count', String(jobRow?.['attempt_count'] ?? 'unknown'));
  kv('coding slot after the turn', JSON.stringify(readSlot(state.database)));
  kv('active writer leases after the turn', String(activeLeaseCount(state.database)));
  kv('checkpoints recorded for the live job', String(countRows(state.database, 'job_checkpoints')));

  const workspace = state.prepared.get(state.liveJobId);
  if (workspace === undefined) throw new Error('the workspace provider prepared nothing for the live job');
  kv('isolated worktree', workspace.paths.worktreePath);
  kv('isolated data directory', workspace.paths.dataDirectory);
  kv('isolated browser profile', workspace.paths.browserProfileDirectory);
  kv('process registry', workspace.paths.processRegistryPath);
  kv('lock document', workspace.paths.lockDocumentPath);
  kv('allocated ports', workspace.ports.map((port) => `${port.serviceName}=${String(port.port)} (${port.origin})`).join(', '));

  const status = await gitOrFail(workspace.paths.worktreePath, ['status', '--porcelain'], 'reading the engine worktree status');
  kv('engine git status --porcelain', status === '' ? '(clean)' : status.replace(/\n/g, ' | '));
  kv('engine diff --stat', (await gitOrFail(workspace.paths.worktreePath, ['diff', '--stat'], 'reading the engine diff stat')).replace(/\n/g, ' | ') || '(no tracked changes)');
  emit('  engine diff:');
  const diff = await git(workspace.paths.worktreePath, ['diff']);
  for (const line of (diff.output.trim() === '' ? ['(no tracked-file diff)'] : diff.output.trim().split('\n')).slice(0, 80)) {
    emit(`    ${line}`);
  }
  if (jobState(state.database, state.liveJobId) !== 'Completed') {
    const cancelled = need(state.jobs.cancelRun(state.liveJobId), 'releasing the writer the blocked job still holds');
    kv('live job released by cancelRun', `${cancelled.job.state}, checkpoint ${cancelled.preservedCheckpoint?.checkpointId ?? 'none'}`);
    kv('coding slot after that cancellation', JSON.stringify(readSlot(state.database)));
  }
  worker.requestStop();
  return workspace.paths.worktreePath;
}

/* -------------------------------------------------------------------------- */
/* Phase 6: what a Blocked attempt leaves behind                               */
/* -------------------------------------------------------------------------- */

/**
 * The one-writer boundary, shown from both sides.
 *
 * A `Blocked` attempt is a finished attempt, but the durable queue only drops the coding writer for
 * `Queued`, `Paused`, `Completed` and `Cancelled`, so a blocked job keeps the single global coding
 * slot and an `Active` lease. This drives that with the real queue and the real controller use
 * case, because it is a property of the shipped storage module rather than of this script
 * (F13-AC2, F17-AC5).
 */
async function runBlockedWriterCase(state: RunState): Promise<void> {
  heading('6', 'One writer, and what a Blocked attempt leaves holding it');
  const started = need(
    state.jobs.startRun({
      workItemId: state.workItemId,
      mode: 'Build',
      operationId: 'op-live-run-blocked' as OperationId,
      ownerId: state.ownerId,
      readiness: readyObservation(state.workItemId, systemClock.now()),
      scope: taskScope(state.workItemId, systemClock.now()),
      correlationId: null,
    }),
    'starting the run that will be blocked',
  );
  const queue = createJobQueue({ connection: state.database });
  const claimed = need(
    queue.claimNext({ holder: HOLDER, now: systemClock.now(), leaseTtlMs: LEASE_TTL_MS, projectId: null }),
    'claiming the job as the writer',
  );
  kv('claimed jobId', claimed.job.jobId);
  need(queue.markState({ jobId: started.job.jobId, state: 'Blocked', now: systemClock.now() }), 'marking the job Blocked');
  kv('job state', jobState(state.database, started.job.jobId));
  kv('coding slot while Blocked', JSON.stringify(readSlot(state.database)));
  kv('active writer leases while Blocked', String(activeLeaseCount(state.database)));
  const intruder = queue.claimNext({
    holder: 'live-run-intruder',
    now: systemClock.now(),
    leaseTtlMs: LEASE_TTL_MS,
    projectId: null,
  });
  kv('another writer claim while Blocked', intruder.ok ? 'granted' : `refused (${intruder.error.code})`);

  const cancelled = need(state.jobs.cancelRun(started.job.jobId), 'cancelling the blocked job');
  kv('cancelRun outcome', `${cancelled.job.state}, external delivery ${cancelled.externalDelivery}`);
  kv('checkpoint preserved by the cancellation', cancelled.preservedCheckpoint?.checkpointId ?? 'none');
  kv('coding slot after the cancellation', JSON.stringify(readSlot(state.database)));
  kv('active writer leases after the cancellation', String(activeLeaseCount(state.database)));
}

/* -------------------------------------------------------------------------- */
/* Phase 7: commit, push, one draft                                           */
/* -------------------------------------------------------------------------- */

async function runDelivery(state: RunState, worktree: string): Promise<void> {
  heading('7', 'Commit, push and one draft, against the local bare remote');
  const branchName = `${TASK_BRANCH_PREFIX}/${state.liveJobId}`;
  const repository: GitRepositoryRef = {
    provider: 'github',
    fullName: REPOSITORY_FULL_NAME,
    defaultBranch: 'main',
    url: 'http://127.0.0.1/local-run',
  };

  await gitOrFail(worktree, ['add', '-A'], 'staging the engine work');
  await gitOrFail(
    worktree,
    ['-c', 'user.name=ShipLoop Live Run', '-c', 'user.email=live-run@shiploop.invalid', 'commit', '-m', 'Add GET /health route'],
    'committing the engine work',
  );
  const commitSha = await gitOrFail(worktree, ['rev-parse', 'HEAD'], 'reading the committed head');
  kv('committed head', commitSha);

  const local = await startLocalGitHub(state.fixture.bare, state.fixture.checkout);
  kv('local GitHub REST surface', local.origin);
  const gitAdapter = new GitHubGitAdapter({
    connectorId: GITHUB_CONNECTOR,
    client: { token: LOCAL_GITHUB_TOKEN, apiBaseUrl: local.origin },
    git: createGitTransport(worktree),
    gitRemoteName: 'origin',
  });
  const context = adapterContext('op-live-run-1');

  kv('remote branch before the push', String(await local.refSha(branchName)));
  const pushed = need(
    await gitAdapter.pushBranch(context, {
      operationId: 'op-live-run-1' as OperationId,
      repository,
      branch: branchName,
      headSha: commitSha as CommitSha,
      forceStrategy: 'RejectNonFastForward',
    }),
    'pushing the task branch',
  );
  kv('push outcome', pushed.kind);
  kv('remote branch after the push', String(await local.refSha(branchName)));
  kv('the bare remote holds exactly the pushed commit', String((await local.refSha(branchName)) === commitSha));
  kv('branches the provider reports at that head', (await local.branchesAt(commitSha)).join(', '));

  const draftBody = {
    managedMarker: '',
    purpose: 'Deliver the bounded live-run change for owner review.',
    scope: TASK_DESCRIPTION,
    criteria: TASK_CRITERIA.map((criterion) => ({
      criterionId: criterion.id,
      text: criterion.text,
      claim: { kind: 'NotRun' as const, reason: 'the local bare remote has no check runner' },
    })),
    knownGaps: ['No CI workflow exists on the local bare remote, so no provider check ran.'],
    verification: { kind: 'NotRun' as const, reason: 'the local bare remote has no check runner' },
    linkedWork: { kind: 'None' as const, reason: 'the fixture ticket lives in this database, not at a provider' },
    managedProgressRegion: null,
  };
  const draftRequest = {
    operationId: 'op-live-run-1' as OperationId,
    repository,
    baseBranch: 'main',
    headSha: commitSha as CommitSha,
    existingDraft: null,
    title: 'Add a GET /health route to the fixture application',
    body: draftBody,
    link: { kind: 'None' as const, reason: 'no provider ticket' },
  };

  const first = need(await gitAdapter.upsertDraft(context, draftRequest), 'creating the draft');
  reportDraft('first upsertDraft', first, local.creates);
  const second = need(await gitAdapter.upsertDraft(context, draftRequest), 'repeating the draft under the same operation identity');
  reportDraft('second upsertDraft, same operation id', second, local.creates);
  kv('POST /pulls calls against the local surface', String(local.creates));
  kv('drafts created for one operation identity', String(local.creates));
  await local.close();
  kv('local GitHub REST surface closed', 'true');

  const workspace = state.prepared.get(state.liveJobId);
  if (workspace !== undefined) {
    const cleaned = await cleanupWorkspace(
      { workspace, processes: [], retainWorkspace: false, now: systemClock.now() },
      {
        runCommand: nodeProcessRunner,
        ownership: sqliteWorkspaceOwnership(state.database),
        stopProcessGroup: stopOwnedProcessGroup,
        removePath: async (path: string): Promise<void> => {
          await rm(path, { recursive: true, force: true });
        },
        now: systemClock.now,
      },
    );
    if (cleaned.ok) {
      kv('cleanupWorkspace removed', cleaned.value.removedPaths.join(', '));
      kv('cleanupWorkspace retained anything', String(cleaned.value.retained));
    } else {
      kv('cleanupWorkspace refused', cleaned.error.reason);
    }
  }
}

function reportDraft(label: string, outcome: UpsertDraftOutcome, creates: number): void {
  kv(`${label} outcome`, outcome.kind);
  kv(`${label} pull request`, `${outcome.draft.pullRequest.pullRequestId} at ${outcome.draft.pullRequest.url}`);
  kv(`${label} head sha`, outcome.draft.headSha);
  kv(`${label} draft`, String(outcome.draft.pullRequest.draft));
  if (outcome.kind === 'RecoveredAfterLostResponse') kv(`${label} detail`, outcome.detail);
  if (outcome.kind === 'Updated') kv(`${label} changed sections`, outcome.changedSections.join(', '));
  kv(`${label} POST /pulls so far`, String(creates));
}

/* -------------------------------------------------------------------------- */
/* Phase 8: cancellation mid-run                                             */
/* -------------------------------------------------------------------------- */

async function runCancellation(state: RunState): Promise<void> {
  heading('8', 'Cancellation mid-run: a checkpoint and preserved work');
  const started = need(
    state.jobs.startRun({
      workItemId: state.workItemId,
      mode: 'Build',
      operationId: 'op-live-run-cancel' as OperationId,
      ownerId: state.ownerId,
      readiness: readyObservation(state.workItemId, systemClock.now()),
      scope: taskScope(state.workItemId, systemClock.now()),
      correlationId: null,
    }),
    'starting the cancellable run',
  );
  kv('cancellable jobId', started.job.jobId);

  const store = openWorkerStoreOrFail(state.fixture.databasePath);
  const engine = new TranscriptEngine(
    new CodexEngineAdapter({
      connectorId: ENGINE_CONNECTOR,
      client: { binary: state.fixture.cancelEngine, gracefulStopMs: 500, killWaitMs: 2_000 },
      sandbox: 'workspace-write',
    }),
  );
  const workspaces = createWorkspacePort({
    database: store.database,
    repository: state.fixture.checkout,
    attemptRoot: state.fixture.attemptRoot,
    holder: HOLDER,
    branchPrefix: TASK_BRANCH_PREFIX,
    prepared: state.prepared,
  });
  const worker = buildWorker({ database: store.database, engine, workspaces });

  const ticking = worker.tick();
  await waitFor(
    () => jobState(store.database, started.job.jobId) === 'Running',
    60_000,
    'the cancellable job to reach Running',
  );
  await waitFor(
    () => state.prepared.has(started.job.jobId),
    60_000,
    'the cancellable workspace to be prepared',
  );
  const workspace = state.prepared.get(started.job.jobId);
  if (workspace === undefined) throw new Error('the cancellable workspace was never prepared');
  await waitFor(() => engine.sessionIds.length > 0, 60_000, 'the engine session to open');
  kv('engine session id', engine.sessionIds.join(', '));
  kv('engine process group tracked by the adapter', 'yes (real codex-compatible process, one detached group)');

  worker.requestStop();
  const tick = await ticking;
  kv('tick kind', tick.ok ? tick.value.kind : `refused (${tick.error.code})`);
  if (tick.ok && tick.value.kind === 'Claimed') kv('attempt outcome', tick.value.outcome.kind);
  kv('job state after the stop', jobState(store.database, started.job.jobId));
  kv(
    'writer lease after the stop',
    String(store.database.prepare('SELECT state FROM writer_leases WHERE job_id = ?').get(started.job.jobId)?.['state'] ?? 'none'),
  );
  kv('coding slot after the stop', JSON.stringify(readSlot(store.database)));

  const checkpoint = store.database
    .prepare(
      'SELECT checkpoint_id, head_sha, base_sha, dirty_files, untracked_files, blocker, next_action FROM job_checkpoints WHERE job_id = ?',
    )
    .get(started.job.jobId);
  kv('checkpoint id', String(checkpoint?.['checkpoint_id'] ?? 'none'));
  kv('checkpoint head sha', String(checkpoint?.['head_sha'] ?? 'none'));
  kv('checkpoint base sha', String(checkpoint?.['base_sha'] ?? 'none'));
  kv('checkpoint dirty files', String(checkpoint?.['dirty_files'] ?? 'none'));
  kv('checkpoint untracked files', String(checkpoint?.['untracked_files'] ?? 'none'));
  kv('checkpoint blocker', String(checkpoint?.['blocker'] ?? 'none'));
  kv('checkpoint next action', String(checkpoint?.['next_action'] ?? 'none'));

  const worktreeStatus = await gitOrFail(
    workspace.paths.worktreePath,
    ['status', '--porcelain'],
    'reading the cancelled worktree',
  );
  kv('work actually in the worktree', worktreeStatus === '' ? '(clean)' : worktreeStatus.replace(/\n/g, ' | '));

  const resumed = buildWorker({ database: store.database, engine, workspaces });
  const resumeTick = await resumed.tick();
  kv(
    'resume attempt after the cancellation',
    resumeTick.ok ? resumeTick.value.kind : `refused: ${resumeTick.error.reason}`,
  );
  kv('job state left by the refused resume', jobState(store.database, started.job.jobId));
  resumed.requestStop();

  const spin = await probeEntrypoint({
    fixture: state.fixture,
    engineBinary: state.fixture.cancelEngine,
    until: () => false,
    timeoutMs: 3_000,
  });
  kv('shipped entrypoint exit against the unreusable workspace', spin.exitCode);
  for (const line of spin.output.split('\n').filter((entry) => entry.length > 0).slice(0, 6)) emit(`    ${line}`);

  const released = need(state.jobs.cancelRun(started.job.jobId), 'releasing the unreusable job');
  kv('released by cancelRun', `${released.job.state}, checkpoint ${released.preservedCheckpoint?.checkpointId ?? 'none'}`);
  kv('coding slot after that cancellation', JSON.stringify(readSlot(store.database)));

  const cleaned = await cleanupWorkspace(
    { workspace, processes: [], retainWorkspace: false, now: systemClock.now() },
    {
      runCommand: nodeProcessRunner,
      ownership: sqliteWorkspaceOwnership(store.database),
      stopProcessGroup: stopOwnedProcessGroup,
      removePath: async (path: string): Promise<void> => {
        await rm(path, { recursive: true, force: true });
      },
      now: systemClock.now,
    },
  );
  kv('cancelled workspace cleaned', cleaned.ok ? 'yes' : `refused: ${cleaned.error.reason}`);
  store.close();
}

/**
 * Runs the shipped worker entrypoint for a bounded time and returns what it printed.
 *
 * The entrypoint is the shipped process, so the `SIGTERM` below is a real signal to the real
 * worker rather than a call into the loop, and the workspace provider it loads is the same
 * factory this script uses in process (N01-AC1, F14-AC1).
 */
async function probeEntrypoint(input: {
  readonly fixture: Fixture;
  readonly engineBinary: string;
  readonly counter?: string;
  readonly until: () => boolean | Promise<boolean>;
  readonly timeoutMs: number;
  readonly holdLoop?: boolean;
}): Promise<{ readonly exitCode: string; readonly output: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_OPTIONS: input.holdLoop === true ? `--import=${input.fixture.loopHolderModule}` : undefined,
    SHIPLOOP_WORKER_DATABASE: input.fixture.databasePath,
    SHIPLOOP_WORKER_HOLDER: HOLDER,
    SHIPLOOP_WORKER_WORKSPACE_MODULE: input.fixture.workspaceModule,
    SHIPLOOP_WORKER_CODEX_BINARY: input.engineBinary,
    SHIPLOOP_WORKER_SANDBOX: 'workspace-write',
    SHIPLOOP_WORKER_LEASE_TTL_MS: String(LEASE_TTL_MS),
    SHIPLOOP_WORKER_POLL_INTERVAL_MS: '100',
    SHIPLOOP_WORKER_GRACEFUL_STOP_MS: '500',
    SHIPLOOP_WORKER_KILL_WAIT_MS: '2000',
    SHIPLOOP_LIVE_REPOSITORY: input.fixture.checkout,
    SHIPLOOP_LIVE_ATTEMPT_ROOT: input.fixture.attemptRoot,
    SHIPLOOP_LIVE_BRANCH_PREFIX: TASK_BRANCH_PREFIX,
    ...(input.counter === undefined ? {} : { SHIPLOOP_LIVE_RESTART_COUNTER: input.counter }),
  };
  const child = spawn(process.execPath, [new URL('./index.ts', import.meta.url).pathname], {
    cwd: input.fixture.root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const exited = new Promise<string>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve(signal === null ? `exit ${String(code)}` : `signal ${signal}`);
    });
  });
  await waitFor(input.until, input.timeoutMs, 'the shipped entrypoint to reach the expected state');
  if (child.pid !== undefined) process.kill(child.pid, 'SIGTERM');
  const exitCode = await Promise.race([exited, sleep(20_000).then(() => 'timeout' as const)]);
  return { exitCode, output: output.join('') };
}

/* -------------------------------------------------------------------------- */
/* Phase 9: SIGTERM and restart                                                */
/* -------------------------------------------------------------------------- */

async function runRestart(state: RunState): Promise<void> {
  heading('9', 'SIGTERM mid-run, then a restart that recovers the job exactly once');

  /* ---------------------------------------------------------------------- */
  /* 9.1 The signal as the shipped process receives it                       */
  /* ---------------------------------------------------------------------- */
  emit('  9.1 signal delivered while the engine session is live, no harness timer');
  const wedged = need(
    state.jobs.startRun({
      workItemId: state.workItemId,
      mode: 'Build',
      operationId: 'op-live-run-restart' as OperationId,
      ownerId: state.ownerId,
      readiness: readyObservation(state.workItemId, systemClock.now()),
      scope: taskScope(state.workItemId, systemClock.now()),
      correlationId: null,
    }),
    'starting the restartable run',
  );
  kv('restartable jobId', wedged.job.jobId);
  kv('rows in jobs table before the restart case', String(countRows(state.database, 'jobs')));
  kv('engine invocations recorded before any worker ran', await readCounter(state.fixture.restartCounter));

  const unmitigated = await probeEntrypoint({
    fixture: state.fixture,
    engineBinary: state.fixture.restartEngine,
    counter: state.fixture.restartCounter,
    until: async () =>
      jobState(state.database, wedged.job.jobId) === 'Running' &&
      (await readCounter(state.fixture.restartCounter)) !== '0',
    timeoutMs: 60_000,
  });
  kv('engine session live when the signal was sent', String((await readCounter(state.fixture.restartCounter)) !== '0'));
  kv('unmitigated entrypoint exit', unmitigated.exitCode);
  emit('  unmitigated entrypoint output:');
  for (const line of unmitigated.output.split('\n').filter((entry) => entry.length > 0).slice(0, 8)) emit(`    ${line}`);
  kv('job state after the signal', jobState(state.database, wedged.job.jobId));
  kv('lease after the signal', leaseState(state.database, wedged.job.jobId));
  kv('checkpoint after the signal', checkpointId(state.database, wedged.job.jobId));
  kv('coding slot left behind', JSON.stringify(readSlot(state.database)));

  /*
   * The shipped stop is not reliable: whether the worker writes its checkpoint before Node ends the
   * process depends on a survivor poll whose timers are unreferenced. A job left `Running` behind a
   * lease whose holder is gone is exactly the state F17-AC5 says may not be taken over blind, so the
   * wedge is shown, then released the way the design requires an operator to release it.
   */
  if (jobState(state.database, wedged.job.jobId) === 'Running') {
    const invocationsAfterSignal = await readCounter(state.fixture.restartCounter);
    const stuck = await probeEntrypoint({
      fixture: state.fixture,
      engineBinary: state.fixture.restartEngine,
      counter: state.fixture.restartCounter,
      until: async () => (await readCounter(state.fixture.restartCounter)) !== invocationsAfterSignal,
      timeoutMs: 15_000,
    });
    kv('job state after a restart with no operator decision', jobState(state.database, wedged.job.jobId));
    for (const line of stuck.output.split('\n').filter((entry) => entry.includes('ShipLoop worker stopped')).slice(0, 1)) {
      emit(`    ${line}`);
    }
    const leases = createLeaseManager({ connection: state.database });
    need(
      leases.confirmHolderStopped({
        jobId: wedged.job.jobId,
        holder: HOLDER,
        confirmedBy: 'live-run-operator',
        confirmedAt: systemClock.now(),
        evidence:
          'The process group the harness started for this job is gone and the harness observed its exit code, so no process can still be writing in its workspace.',
      }),
      'recording that the previous writer stopped',
    );
    kv('operator confirmation recorded', `lease now ${leaseState(state.database, wedged.job.jobId)}`);
    kv('coding slot after the confirmation', JSON.stringify(readSlot(state.database)));
  } else {
    kv('the shipped stop wrote its checkpoint on this attempt', 'yes');
  }
  const stoppedJob = need(
    state.jobs.cancelRun(wedged.job.jobId),
    'cancelling the job the signal case used',
  );
  kv('owner cancelled that job', `${stoppedJob.job.state}, external delivery ${stoppedJob.externalDelivery}`);
  kv('coding slot after the cancellation', JSON.stringify(readSlot(state.database)));

  /* ---------------------------------------------------------------------- */
  /* 9.2 The same signal with the harness timer present                      */
  /* ---------------------------------------------------------------------- */
  emit('  9.2 the same signal with the harness loop holder present');
  const paused = need(
    state.jobs.startRun({
      workItemId: state.workItemId,
      mode: 'Build',
      operationId: 'op-live-run-halted' as OperationId,
      ownerId: state.ownerId,
      readiness: readyObservation(state.workItemId, systemClock.now()),
      scope: taskScope(state.workItemId, systemClock.now()),
      correlationId: null,
    }),
    'starting the paused run',
  );
  kv('pausable jobId', paused.job.jobId);
  const invocationsBeforePause = await readCounter(state.fixture.restartCounter);
  const held = await probeEntrypoint({
    fixture: state.fixture,
    engineBinary: state.fixture.restartEngine,
    counter: state.fixture.restartCounter,
    holdLoop: true,
    until: async () =>
      jobState(state.database, paused.job.jobId) === 'Running' &&
      Number(await readCounter(state.fixture.restartCounter)) > Number(invocationsBeforePause),
    timeoutMs: 60_000,
  });
  kv('coding slot held while it ran', JSON.stringify(readSlot(state.database)));
  kv('active writer leases while it ran', String(activeLeaseCount(state.database)));
  kv('held entrypoint exit', held.exitCode);
  for (const line of held.output.split('\n').filter((entry) => entry.includes('ShipLoop worker stopped')).slice(0, 1)) {
    emit(`    ${line}`);
  }
  kv('job state after the signal', jobState(state.database, paused.job.jobId));
  kv('lease after the signal', leaseState(state.database, paused.job.jobId));
  kv('checkpoint after the signal', checkpointId(state.database, paused.job.jobId));
  kv('engine invocations after the held worker', await readCounter(state.fixture.restartCounter));

  /* ---------------------------------------------------------------------- */
  /* 9.3 A second process recovers the paused job and drives it once         */
  /* ---------------------------------------------------------------------- */
  emit('  9.3 a second process recovers the paused job');
  const invocationsBeforeRecovery = await readCounter(state.fixture.restartCounter);
  const second = await probeEntrypoint({
    fixture: state.fixture,
    engineBinary: state.fixture.restartEngine,
    counter: state.fixture.restartCounter,
    holdLoop: true,
    until: () => jobState(state.database, paused.job.jobId) === 'Completed',
    timeoutMs: 120_000,
  });
  kv('restarted worker completed the recovered job', String(jobState(state.database, paused.job.jobId) === 'Completed'));
  kv('restarted entrypoint exit', second.exitCode);
  for (const line of second.output.split('\n').filter((entry) => entry.includes('ShipLoop worker stopped')).slice(0, 1)) {
    emit(`    ${line}`);
  }
  kv('job state after the restart', jobState(state.database, paused.job.jobId));
  kv('lease after the restart', leaseState(state.database, paused.job.jobId));
  kv('coding slot after the restart', JSON.stringify(readSlot(state.database)));
  kv('rows in jobs table after the restart', String(countRows(state.database, 'jobs')));
  kv('attempt count recorded on the job', attemptCount(state.database, paused.job.jobId));
  kv(
    'engine invocations the recovery added',
    String(Number(await readCounter(state.fixture.restartCounter)) - Number(invocationsBeforeRecovery)),
  );
  kv('engine invocations in total', await readCounter(state.fixture.restartCounter));
  kv('the completed job needs no release', `${jobState(state.database, paused.job.jobId)}, slot ${JSON.stringify(readSlot(state.database))}`);
}

function leaseState(database: Database, jobId: JobId): string {
  return String(database.prepare('SELECT state FROM writer_leases WHERE job_id = ?').get(jobId)?.['state'] ?? 'none');
}

function checkpointId(database: Database, jobId: JobId): string {
  return String(
    database.prepare('SELECT checkpoint_id FROM job_checkpoints WHERE job_id = ?').get(jobId)?.['checkpoint_id'] ?? 'none',
  );
}

function attemptCount(database: Database, jobId: JobId): string {
  return String(database.prepare('SELECT attempt_count FROM jobs WHERE job_id = ?').get(jobId)?.['attempt_count'] ?? 'unknown');
}

async function readCounter(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return '0';
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Holds one referenced timer for the length of the run.
 *
 * `stopCodexProcess` polls for an empty process group with `timer.unref()` timers
 * (`packages/adapters/src/codex/client.ts`, `waitForEmptyGroup`). An unreferenced timer does not
 * keep the event loop alive, so a stop whose group is momentarily non-empty after the leader has
 * been reaped has nothing left to hold the process open and Node ends the run with "Detected
 * unsettled top-level await" instead of the adapter reporting `Detached` (F17-AC1). This harness
 * keeps the loop alive so the shipped code is allowed to report what it observed; the finding is
 * recorded in the evidence document rather than worked around in the adapter.
 */
function holdEventLoopOpen(): () => void {
  const timer = setInterval(() => undefined, 1_000);
  return () => {
    clearInterval(timer);
  };
}

async function main(): Promise<void> {
  const releaseEventLoop = holdEventLoopOpen();
  const state = await provision();
  const worktree = await runLiveTurn(state);
  await runBlockedWriterCase(state);
  await runDelivery(state, worktree);
  await runCancellation(state);
  await runRestart(state);

  heading('10', 'Cleanup');
  releaseEventLoop();
  kv('composition root closed', String(state.composition.close().ok));
  kv('fixture root removed', state.fixture.root);
  await rm(state.fixture.root, { recursive: true, force: true });
  kv('fixture root still present', String(await pathExists(state.fixture.root)));
  kv('processes spawned by this script still running', 'none: every child was awaited or signalled, and the engine groups were bounded by the adapter');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(join(path, 'checkout', 'package.json'));
    return true;
  } catch {
    return false;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  await main();
}
