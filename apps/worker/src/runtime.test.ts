/**
 * Behavioural proof for the production runtime (F13-AC2, F14-AC1, F15-AC1, F17-AC3, F18-AC2,
 * F19-AC1, F19-AC3, F19-AC5, F20-AC1, F20-AC2, F24-AC3).
 *
 * Every case starts the shipped composition root from environment configuration alone: no module is
 * injected, no port is replaced and no adapter is passed in. The engine is the shipped
 * `CodexEngineAdapter` driving a real process on PATH that speaks Codex's JSONL protocol, and the
 * provider is a loopback REST surface whose every ref answer Git itself reads out of the bare
 * repository the push really wrote. That is the property these cases exist to defend — a normal
 * start needs no wiring, so a double handed to the runtime would test the harness rather than the
 * product.
 *
 * What is therefore proven, and what is not: the whole coding path, from a durable queued job
 * through a real engine turn, a real commit, a real `git push` into a local bare remote, one draft
 * written through the adapter's own reconciliation read, and the required checks executed against
 * the committed code. Nothing here reaches `api.github.com`, and no live repository or account is
 * touched, which the rules require and which `packages/adapters/src/github/README.md` states as the
 * boundary of what its own tests can claim (mvp-spec 9).
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { redact } from '@shiploop/domain';
import type {
  AreaObservation,
  CapabilityDeclaration,
  ConnectorId,
  DomainError,
  JobId,
  OperationId,
  ProjectId,
  ReadinessObservation,
  Result,
  ScopeSnapshot,
  WorkItemId,
} from '@shiploop/domain';
import {
  AttentionItemRepository,
  CandidateRepository,
  ScopeRepository,
  WorkItemRepository,
  closeDatabase,
  createJobQueue,
  createLeaseManager,
  migrate,
  openDatabase,
} from '@shiploop/storage';
import type { ConnectorKind, Database, JobLimits, JobRecord } from '@shiploop/storage';
import { CodexEngineAdapter, GitHubGitAdapter, createGitTransport } from '@shiploop/adapters';
import type { AdapterClock } from '@shiploop/adapters';
import { nodeProcessRunner } from '@shiploop/verification';
import { createCompositionRoot, createJobUseCases } from '@shiploop/controller';
import type { CompositionRoot } from '@shiploop/controller';
import { RECIPE_SUBJECT_KEY } from '@shiploop/controller';

import { LinearTicketAdapter } from '../../../packages/adapters/src/linear/index.ts';
import { BUILT_IN_WORKSPACE_PROVIDER, createWorkerRuntime, readRuntimeConfig } from './runtime.ts';
import type { WorkerRuntime } from './runtime.ts';
import type { TickReport } from './worker.ts';

/* -------------------------------------------------------------------------- */
/* Fixed facts                                                                 */
/* -------------------------------------------------------------------------- */

const PROJECT = '00runtime0test00000000000000000a' as ProjectId;
const REPOSITORY_FULL_NAME = 'runtime-test/fixture';
const BRANCH_PREFIX = 'shiploop/runtime-test';
const HOLDER = 'runtime-test-writer';
const LEASE_TTL_MS = 120_000;
const REQUIRED_CHECK = 'node --test app.test.mjs';
const OWNER_PASSWORD = 'runtime-test-owner-password';
/** A credential-shaped non-credential: the local surface checks a token exists and never reads it. */
const LOCAL_GITHUB_TOKEN = 'runtime-test-local-token-not-a-credential';
const LOCAL_LINEAR_KEY = 'runtime-test-local-linear-key-not-a-credential';
const RECIPE_ID = 'recipe_runtime_test';

const APP_SOURCE = `export const greeting = 'shiploop-runtime-fixture';
`;

const APP_TEST_SOURCE = `import assert from 'node:assert/strict';
import test from 'node:test';
import { greeting } from './app.mjs';

test('the fixture greets', () => {
  assert.equal(greeting, 'shiploop-runtime-fixture');
});
`;

/**
 * A real engine process: real Codex JSONL on stdout, a real file written into the workspace it was
 * started in, and a real clean exit (F15-AC1).
 */
const ENGINE_SCRIPT = `#!/bin/sh
printf '%s\\n' '{"type":"thread.started","thread_id":"runtime-test-thread"}'
printf '%s\\n' '{"type":"turn.started"}'
printf 'written by the engine under test\\n' > engine-output.txt
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":40,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":12,"reasoning_output_tokens":0}}'
`;

/** The required check that really runs, against the code the attempt committed. */
const PASSING_CHECK = 'node --test app.test.mjs';
/** The required check that really runs and really fails, so a blocker is a fact (F20-AC2). */
const FAILING_CHECK = 'node --test absent.test.mjs';

const LIMITS: JobLimits = {
  activeExecutionMs: 600_000,
  maxAutomatedFixPasses: 1,
  maxToolRetries: 3,
  maxAttempts: 1,
};

/** One millisecond of budget: any real engine turn crosses it, so the limit is reached honestly. */
const IMPOSSIBLE_LIMITS: JobLimits = { ...LIMITS, activeExecutionMs: 1 };

const TASK_DESCRIPTION = [
  'Make exactly one change to this repository: write a file named engine-output.txt whose single',
  'line reads "written by the engine under test", and change nothing else.',
].join(' ');

const TASK_CRITERIA = [
  { id: 'AC-1', text: 'engine-output.txt exists in the delivered branch and holds the requested line.' },
  { id: 'AC-2', text: 'The project’s required check passes against the delivered code.' },
];

const systemClock: AdapterClock = {
  now: (): string => new Date().toISOString(),
  elapsedMs: (): number => Number(process.hrtime.bigint() / 1_000n),
};

/* -------------------------------------------------------------------------- */
/* Small typed helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Unwraps a `Result` or names what was refused, so no failure is silent. */
/** The content revision the adapter records in its managed marker. */
function digestOf(body: string): string {
  return /digest=([0-9a-f]+)/.exec(body)?.[1] ?? 'no digest';
}

/** A managed body without the marker line, whose only volatile part is the write timestamp. */
function withoutMarker(body: string): string {
  return body.replace(/<!--shiploop:managed:v1[^]*?-->\n/, '');
}

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
    throw new Error(`${what} failed: git ${argv.join(' ')} exited ${String(outcome.exitCode)}: ${outcome.output}`);
  }
  return outcome.output.trim();
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
    verification: satisfied(`The project profile requires \`${REQUIRED_CHECK}\`.`),
    access: satisfied('The local bare remote is readable and writable by this process.'),
    investigationSupported: [],
  };
}

function taskScope(workItemId: WorkItemId, retrievedAt: string): ScopeSnapshot {
  return {
    workItemId,
    issueId: 'issue-runtime-test-1',
    issueIdentifier: 'RT-1',
    title: 'Record that the engine ran',
    description: TASK_DESCRIPTION,
    providerRevision: 'rev-runtime-test-1',
    priority: '2',
    dependencyIssueIds: [],
    acceptanceCriteria: TASK_CRITERIA,
    retrievedAt,
  };
}

/**
 * The capability registry the real adapters describe.
 *
 * The profile this fixture saves is validated against these declarations, so it is checked against
 * what the shipped GitHub, Codex and Linear adapters declare rather than against a hand-written
 * list; naming a capability no adapter declares is a refusal the fixture has to satisfy too
 * (F03-AC2). None of these adapters is called: a registry here answers declarations, and the run
 * itself uses the runtime's own adapters.
 */
function adapterRegistry(): {
  declarationsFor(kind: ConnectorKind): readonly CapabilityDeclaration[];
  probeFor(): null;
} {
  const gitHub = new GitHubGitAdapter({
    connectorId: 'connector_runtime_test_github' as ConnectorId,
    client: { token: LOCAL_GITHUB_TOKEN, apiBaseUrl: 'http://127.0.0.1:1' },
    git: createGitTransport(tmpdir()),
  });
  const codex = new CodexEngineAdapter({
    connectorId: 'connector_runtime_test_codex' as ConnectorId,
    client: { binary: 'codex' },
  });
  const linear = new LinearTicketAdapter({
    connectorId: 'connector_runtime_test_linear' as ConnectorId,
    client: { apiKey: LOCAL_LINEAR_KEY },
  });
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

/* -------------------------------------------------------------------------- */
/* Local provider surface                                                      */
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

interface LocalProvider {
  readonly origin: string;
  /** Every ref answer comes from Git reading the bare repository the push actually wrote. */
  refSha(branch: string): Promise<string | null>;
  readonly creates: () => number;
  readonly drafts: () => readonly PullRequestRow[];
  close(): Promise<void>;
}

function pullRequestPayload(row: PullRequestRow, origin: string): Record<string, unknown> {
  return {
    id: row.number * 1_000 + 7,
    number: row.number,
    html_url: `${origin}/pull/${String(row.number)}`,
    body: row.body,
    title: row.title,
    draft: true,
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    head: { ref: row.headRef, sha: row.headSha },
    base: { ref: row.baseRef, sha: row.baseSha },
    user: { login: 'shiploop-runtime-test' },
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
  sendJson(response, 404, { message: 'Not Found', status: '404' });
}

/**
 * The endpoints the GitHub adapter calls, on loopback.
 *
 * The ref endpoints are answered by Git out of the bare repository, so the push verification, the
 * head-to-branch lookup and the no-code declaration all read the repository the push really wrote.
 * Only pull-request storage is local, because there is no provider to hold it here and writing to a
 * live repository is not permitted (mvp-spec 9).
 */
async function startLocalProvider(bare: string): Promise<LocalProvider> {
  const rows = new Map<number, PullRequestRow>();
  let nextNumber = 0;
  let creates = 0;
  const [owner = '', repo = ''] = REPOSITORY_FULL_NAME.split('/');
  const prefix = `/repos/${owner}/${repo}`;

  const refSha = async (branch: string): Promise<string | null> => {
    const outcome = await git(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (outcome.exitCode !== 0) return null;
    const value = outcome.output.trim();
    return /^[0-9a-f]{40}$/.test(value) ? value : null;
  };

  const server: Server = createServer();
  const origin = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
    });
  });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', origin);
    const rest = decodeURIComponent(url.pathname).slice(prefix.length);
    if (!url.pathname.startsWith(prefix)) {
      sendNotFound(response);
      return;
    }

    if (rest === '' && request.method === 'GET') {
      sendJson(response, 200, {
        full_name: REPOSITORY_FULL_NAME,
        default_branch: 'main',
        html_url: `${origin}/${REPOSITORY_FULL_NAME}`,
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

    const branchesMatch = /^\/commits\/([0-9a-f]{40})\/branches-where-head$/.exec(rest);
    if (branchesMatch !== null && request.method === 'GET') {
      const sha = branchesMatch[1] ?? '';
      const listed = await git(bare, ['for-each-ref', '--format=%(refname:short)', '--points-at', sha, 'refs/heads']);
      const names = listed.exitCode === 0 ? listed.output.split('\n').map((line) => line.trim()).filter((line) => line !== '') : [];
      sendJson(response, 200, names.map((name) => ({ name, commit: { sha } })));
      return;
    }

    if (/^\/commits\/[0-9a-f]{40}\/check-runs$/.test(rest) && request.method === 'GET') {
      sendJson(response, 200, { total_count: 0, check_runs: [] });
      return;
    }
    if (/^\/commits\/[0-9a-f]{40}\/status$/.test(rest) && request.method === 'GET') {
      sendJson(response, 200, { state: 'pending', statuses: [] });
      return;
    }

    if (rest === '/pulls' && request.method === 'GET') {
      sendJson(response, 200, [...rows.values()].map((row) => pullRequestPayload(row, origin)));
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
      sendJson(response, 201, pullRequestPayload(row, origin));
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
        const updated: PullRequestRow = { ...row, body: typeof sent['body'] === 'string' ? sent['body'] : row.body };
        rows.set(number, updated);
        sendJson(response, 200, pullRequestPayload(updated, origin));
        return;
      }
      sendJson(response, 200, pullRequestPayload(row, origin));
      return;
    }

    sendNotFound(response);
  };

  server.on('request', (request, response) => {
    handle(request, response).catch(() => {
      sendJson(response, 500, { message: 'the local surface failed', status: '500' });
    });
  });

  return {
    origin,
    refSha,
    creates: (): number => creates,
    drafts: (): readonly PullRequestRow[] => [...rows.values()],
    /**
     * Closing the surface ends it, sockets and all.
     *
     * The adapter keeps HTTP connections alive between calls, and `close` alone waits for them, so
     * a case that finished would leave the runner waiting on a server nobody will talk to again.
     */
    close: (): Promise<void> =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly root: string;
  readonly checkout: string;
  readonly bare: string;
  readonly databasePath: string;
  readonly attemptRoot: string;
  readonly artifactRoot: string;
  readonly engineBinary: string;
  readonly provider: LocalProvider;
}

/**
 * A disposable application, a local bare remote, a real migrated database, and a real seeded run.
 *
 * The owner, project profile, environment recipe, work item and job are created through the
 * controller's own use cases, so the rows the runtime later reads are rows the product writes rather
 * than rows a test invented.
 */
async function withHarness(
  options: { readonly checkCommand: string; readonly limits?: JobLimits },
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-runtime-test-'));
  const checkout = join(root, 'checkout');
  const bare = join(root, 'origin.git');
  const state = join(root, 'state');
  await mkdir(checkout);
  await mkdir(state);
  await writeFile(join(checkout, 'app.mjs'), APP_SOURCE);
  await writeFile(join(checkout, 'app.test.mjs'), APP_TEST_SOURCE);
  await gitOrFail(root, ['init', '--bare', '--initial-branch=main', bare], 'creating the local bare remote');
  await gitOrFail(checkout, ['init', '--initial-branch=main'], 'creating the fixture checkout');
  await gitOrFail(checkout, ['add', '-A'], 'staging the fixture application');
  await gitOrFail(
    checkout,
    ['-c', 'user.name=ShipLoop Runtime Test', '-c', 'user.email=runtime-test@shiploop.invalid', 'commit', '-m', 'Fixture application'],
    'committing the fixture application',
  );
  await gitOrFail(checkout, ['remote', 'add', 'origin', bare], 'pointing origin at the local bare remote');
  await gitOrFail(checkout, ['push', '-u', 'origin', 'main'], 'publishing the fixture base commit');
  const baseSha = await gitOrFail(checkout, ['rev-parse', 'HEAD'], 'reading the fixture base commit');

  const engineBinary = join(root, 'fixture-engine.sh');
  await writeFile(engineBinary, ENGINE_SCRIPT);
  await chmod(engineBinary, 0o755);

  const provider = await startLocalProvider(bare);
  const databasePath = join(state, 'runtime.sqlite');
  const fixture: Fixture = {
    root,
    checkout,
    bare,
    databasePath,
    attemptRoot: join(state, 'attempts'),
    artifactRoot: join(state, 'artifacts'),
    engineBinary,
    provider,
  };

  const seeded = openDatabase(databasePath);
  assert.ok(seeded.ok, 'the store could not be opened for seeding');
  assert.ok(migrate(seeded.value).ok, 'the store could not be migrated');
  assert.ok(closeDatabase(seeded.value).ok, 'the seeding handle could not be closed');

  const seededRun = seedThroughController(fixture, options.checkCommand, options.limits ?? LIMITS);
  try {
    const reader = openDatabase(databasePath);
    assert.ok(reader.ok, 'the store could not be opened for the assertions');
    const database: Database = reader.value;

    const env = harnessEnv(fixture);
    const config = readRuntimeConfig(env);
    assert.ok(config.ok, `the runtime configuration was refused: ${JSON.stringify(config.ok ? [] : config.errors)}`);
    const runtime = await createWorkerRuntime(config.value);
    assert.ok(runtime.ok, `the runtime could not start: ${runtime.ok ? '' : runtime.error.reason}`);

    const harness: Harness = {
      fixture,
      baseSha,
      env,
      database,
      runtime: runtime.value,
      jobId: seededRun.jobId,
      branchName: `${BRANCH_PREFIX}/${seededRun.jobId}`,
      attention: new AttentionItemRepository(database),
      candidates: new CandidateRepository(database),
      queue: createJobQueue({ connection: database }),
      close: (): void => {
        assert.ok(runtime.value.close().ok, 'the runtime could not be closed');
        assert.ok(closeDatabase(database).ok, 'the assertion handle could not be closed');
      },
    };
    try {
      await run(harness);
    } finally {
      harness.close();
    }
  } finally {
    seededRun.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}

interface Harness {
  readonly fixture: Fixture;
  readonly baseSha: string;
  readonly env: NodeJS.ProcessEnv;
  readonly database: Database;
  readonly runtime: WorkerRuntime;
  readonly jobId: JobId;
  readonly branchName: string;
  readonly attention: AttentionItemRepository;
  readonly candidates: CandidateRepository;
  readonly queue: ReturnType<typeof createJobQueue>;
  close(): void;
}

/**
 * The environment a deployment configures, and nothing else.
 *
 * There is no `SHIPLOOP_WORKER_WORKSPACE_MODULE` here, so a start must reach the built-in provider
 * without being told which module provides it (F14-AC1).
 */
function harnessEnv(fixture: Fixture): NodeJS.ProcessEnv {
  return {
    SHIPLOOP_WORKER_DATABASE: fixture.databasePath,
    SHIPLOOP_WORKER_HOLDER: HOLDER,
    SHIPLOOP_WORKER_REPOSITORY: fixture.checkout,
    SHIPLOOP_WORKER_ATTEMPT_ROOT: fixture.attemptRoot,
    SHIPLOOP_WORKER_ARTIFACT_ROOT: fixture.artifactRoot,
    SHIPLOOP_WORKER_BRANCH_PREFIX: BRANCH_PREFIX,
    SHIPLOOP_WORKER_GITHUB_TOKEN: LOCAL_GITHUB_TOKEN,
    SHIPLOOP_WORKER_GITHUB_API_BASE_URL: fixture.provider.origin,
    SHIPLOOP_WORKER_CODEX_BINARY: fixture.engineBinary,
    SHIPLOOP_WORKER_SANDBOX: 'workspace-write',
    SHIPLOOP_WORKER_LEASE_TTL_MS: String(LEASE_TTL_MS),
    SHIPLOOP_WORKER_POLL_INTERVAL_MS: '10',
    SHIPLOOP_WORKER_GRACEFUL_STOP_MS: '500',
    SHIPLOOP_WORKER_KILL_WAIT_MS: '2000',
  };
}

interface SeededRun {
  readonly jobId: JobId;
  close(): void;
}

/** Seeds one owner, profile, recipe, work item and queued job through the real use cases. */
function seedThroughController(fixture: Fixture, checkCommand: string, limits: JobLimits): SeededRun {
  const root = createCompositionRoot({
    databasePath: fixture.databasePath,
    clock: systemClock,
    adapters: adapterRegistry(),
    sessionIdleTimeoutSeconds: 3_600,
  });
  assert.ok(root.ok, `the composition root could not be opened: ${root.ok ? '' : root.error.reason}`);
  const composition: CompositionRoot = root.value;
  try {
    const owner = composition.useCases.provisionNamedOwner({
      displayName: 'Runtime Test Owner',
      password: OWNER_PASSWORD,
      at: systemClock.now(),
    });
    assert.ok(owner.ok, 'the fixture owner could not be provisioned');
    const actor = composition.useCases.resolveOwnerActor();
    assert.ok(actor.ok, 'the fixture owner actor could not be resolved');

    const profile = composition.useCases.saveProfile(
      {
        projectId: PROJECT,
        content: {
          references: {
            repository: REPOSITORY_FULL_NAME,
            ticketProvider: 'runtime-test',
            ticketTeamKey: 'RT',
            baseBranch: 'main',
            targetBranch: 'main',
            deploymentProvider: 'none',
            engine: 'codex',
            previewComponents: [],
          },
          policy: {
            requiredChecks: [REQUIRED_CHECK],
            deliveryBehavior: 'ManualAuthorizationOnly',
            maxFixPasses: 1,
            workspaceIsolation: 'WorktreeAndDataDirectory',
            capabilityVersion: 1,
          },
          recipe: `${RECIPE_SUBJECT_KEY} v1`,
          environment: { runtime: 'node24', ports: [], secretReferences: [] },
        },
        note: null,
        expectedVersionNumber: null,
      },
      actor.value,
    );
    assert.ok(profile.ok, `the fixture profile could not be saved: ${profile.ok ? '' : profile.error.reason}`);

    const recipe = composition.useCases.saveRecipe(
      {
        projectId: PROJECT,
        recipeId: RECIPE_ID,
        content: {
          requirements: { runtime: { name: 'node', minVersion: '24.0.0', maxVersionExclusive: null }, cpu: { architecture: 'x64', minCores: 1 } },
          dependencyInstall: [],
          serviceStartup: [],
          checks: [
            {
              id: 'check_runtime_test',
              name: REQUIRED_CHECK,
              command: { argv: [...checkCommand.split(' ')], timeoutMs: 120_000, maxOutputBytes: 65_536, cwd: null },
              required: true,
            },
          ],
          ports: [],
          dataLocations: [],
          testAccess: [],
          requiredSecrets: [],
          declaredCapabilities: ['Repository:Read', 'Check:Execute'],
          maintenance: { action: 'Incompatible', command: null, incompatibilityReason: 'The fixture recipe has no maintenance step.' },
        },
        provenance: { source: 'OwnerSaved', scope: 'Environment', createdBy: actor.value.actorId, createdAt: systemClock.now() },
        expectedVersionNumber: null,
        actor: actor.value,
      },
    );
    assert.ok(recipe.ok, `the fixture recipe could not be saved: ${recipe.ok ? '' : recipe.error.reason}`);

    const workItems = new WorkItemRepository(composition.database);
    const workItem = workItems.create({
      projectId: PROJECT,
      profileVersionId: profile.value.profileVersionId,
      source: 'ProposedNewIssue',
      title: 'Record that the engine ran',
      externalIssueId: null,
      externalIssueIdentifier: null,
      externalIssueUrl: null,
      publicationIntent: 'PublishWhenAgreed',
      relatedWorkItemIds: [],
      adoption: null,
      at: systemClock.now(),
    });
    assert.ok(workItem.ok, `the fixture work item could not be created: ${workItem.ok ? '' : workItem.error.reason}`);

    const jobs = createJobUseCases({
      clock: systemClock,
      queue: createJobQueue({ connection: composition.database }),
      leases: createLeaseManager({ connection: composition.database }),
      profiles: composition.profiles,
      procedures: composition.procedures,
      workItems,
      scope: new ScopeRepository(composition.database),
      limits,
    });
    const started = jobs.startRun({
      workItemId: workItem.value.workItemId,
      mode: 'Build',
      operationId: 'op-runtime-test-1' as OperationId,
      ownerId: owner.value.ownerId,
      readiness: readyObservation(workItem.value.workItemId, systemClock.now()),
      scope: taskScope(workItem.value.workItemId, systemClock.now()),
      correlationId: null,
    });
    assert.ok(started.ok, `the fixture run could not be started: ${started.ok ? '' : started.error.reason}`);

    return {
      jobId: started.value.job.jobId,
      close: (): void => {
        assert.ok(composition.close().ok, 'the composition root could not be closed');
      },
    };
  } catch (error) {
    assert.ok(composition.close().ok, 'the composition root could not be closed');
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Shared assertions                                                           */
/* -------------------------------------------------------------------------- */

function jobOf(harness: Harness): JobRecord {
  const job = need(harness.queue.readJob(harness.jobId), 'reading the job back');
  assert.ok(job !== null, `the job ${harness.jobId} must still be recorded`);
  return job;
}

function jobState(harness: Harness): string {
  return jobOf(harness).state;
}

/** The claim a tick made, so a case can name the job and the outcome without restating the union. */
function claimedOf(tick: TickReport): { readonly jobId: JobId; readonly outcomeKind: string } | null {
  return tick.kind === 'Claimed' ? { jobId: tick.jobId, outcomeKind: tick.outcome.kind } : null;
}

function openAttention(harness: Harness): readonly { readonly dedupKey: string; readonly kind: string; readonly blocker: string | null; readonly nextAction: string }[] {
  return need(harness.attention.list('Open'), 'listing open attention items');
}

/* -------------------------------------------------------------------------- */
/* The cases                                                                   */
/* -------------------------------------------------------------------------- */

test('F14-AC1, F19-AC1: a start configured only by environment claims a queued job and delivers one linked draft', async () => {
  await withHarness({ checkCommand: PASSING_CHECK }, async (harness) => {
    const config = readRuntimeConfig(harness.env);
    assert.ok(config.ok);
    assert.equal(config.value.workspaceModule, null, 'a normal start names no workspace provider module');
    assert.equal(BUILT_IN_WORKSPACE_PROVIDER, 'shiploop:verification-workspace');
    assert.equal(config.value.repository, harness.fixture.checkout);
    assert.equal(config.value.git.apiBaseUrl, harness.fixture.provider.origin);

    const tick = await harness.runtime.tick();
    assert.ok(tick.ok, `the first tick was refused: ${tick.ok ? '' : tick.error.reason}`);
    const claimed = claimedOf(tick.value.tick);
    assert.ok(claimed !== null, `the queued job was not claimed: ${tick.value.tick.kind}`);
    assert.equal(claimed?.jobId, harness.jobId);
    assert.equal(claimed?.outcomeKind, 'Completed');

    const delivery = tick.value.delivery;
    assert.ok(delivery !== null, 'a completed attempt must be delivered');
    assert.equal(delivery?.kind, 'DraftWritten');

    const facts = harness.runtime.workspaceFor(harness.jobId);
    assert.ok(facts !== null, 'the built-in provider must hold the workspace it prepared');
    assert.equal(facts?.branchName, harness.branchName);
    assert.equal(facts?.baseSha, harness.baseSha, 'the workspace was linked to the connected checkout’s published base');
    assert.equal(facts?.headSha, harness.baseSha, 'the workspace held the base until the attempt changed something');

    const status = await git(facts?.worktreePath ?? '', ['status', '--porcelain']);
    assert.equal(status.exitCode, 0, `the worktree could not be read: ${status.output}`);
    assert.equal(status.output.trim(), '', 'the delivered worktree is clean after the commit');
    const ahead = await gitOrFail(facts?.worktreePath ?? '', ['rev-list', '--count', 'main..HEAD'], 'counting the delivered commits');
    assert.equal(ahead, '1', 'the task branch holds exactly the commit the attempt produced');
    assert.equal(
      (await gitOrFail(facts?.worktreePath ?? '', ['show', 'HEAD:engine-output.txt'], 'reading the delivered file')).trim(),
      'written by the engine under test',
      'what the engine really wrote is what was committed',
    );

    const draft = harness.fixture.provider.drafts()[0];
    assert.ok(draft !== undefined, 'the provider must hold a draft');
    assert.equal(draft?.headRef, harness.branchName, 'the draft is linked to the task branch');
    assert.equal(await harness.fixture.provider.refSha(harness.branchName), draft?.headSha, 'the draft head is the pushed commit');
    assert.equal(harness.fixture.provider.creates(), 1, 'one attempt opens one draft');
    assert.equal(jobState(harness), 'Completed');
  });
});

test('F19-AC1, F19-AC2: the first delivery claims nothing that has not been observed, and the required check is a real run', async () => {
  await withHarness({ checkCommand: PASSING_CHECK }, async (harness) => {
    const tick = await harness.runtime.tick();
    assert.ok(tick.ok, `the tick was refused: ${tick.ok ? '' : tick.error.reason}`);
    const delivery = tick.value.delivery;
    assert.equal(delivery?.kind, 'DraftWritten');
    assert.ok(
      delivery?.kind === 'DraftWritten' && !delivery.notReady.some((reason) => reason.includes(REQUIRED_CHECK)),
      `a passing required check must not be reported as a reason the owner cannot proceed: ${JSON.stringify(delivery)}`,
    );

    const body = harness.fixture.provider.drafts()[0]?.body ?? '';
    assert.ok(
      body.includes(`- [x] ${REQUIRED_CHECK} — reported passed by check ${REQUIRED_CHECK}`),
      `the required check ran and passed, so the delivered body may say so: ${body}`,
    );
    assert.equal(
      body.includes('The required checks for this candidate have not run yet'),
      false,
      'the delivered body must not still say no check has run (F19-AC2)',
    );
    assert.ok(
      body.includes('**AC-1**') && body.includes('not run (No verification method is assigned to this criterion'),
      'a criterion nobody assigned a method to stays unrun rather than reading as verified (F23-AC1)',
    );

    const artifact = join(harness.fixture.artifactRoot, 'checks', 'check_runtime_test.log');
    const output = await readFile(artifact, 'utf8');
    assert.match(output, /pass 1/, 'the check really ran the fixture test, so the pass is an observation');
    assert.equal(output.includes(redact(LOCAL_GITHUB_TOKEN).text), false, 'a credential never reaches a check artifact (N02-AC2)');
  });
});

test('F19-AC3, F17-AC3: a repeated delivery of the same commit updates the one draft instead of opening a second', async () => {
  await withHarness({ checkCommand: PASSING_CHECK }, async (harness) => {
    const first = await harness.runtime.tick();
    assert.ok(first.ok);
    assert.equal(first.value.delivery?.kind, 'DraftWritten');
    const created = harness.fixture.provider.creates();
    assert.equal(created, 1);

    const facts = harness.runtime.workspaceFor(harness.jobId);
    const worktree = facts?.worktreePath ?? '';
    const firstHead = first.value.delivery?.kind === 'DraftWritten' ? first.value.delivery.headSha : '';
    const firstBody = harness.fixture.provider.drafts()[0]?.body ?? '';

    const again = await harness.runtime.deliver(harness.jobId);
    assert.ok(again.ok, `the repeated delivery was refused: ${again.ok ? '' : again.error.reason}`);
    assert.equal(again.value.kind, 'DraftWritten', 'a delivery retried on a clean workspace delivers the same commit again');
    assert.equal(harness.fixture.provider.creates(), created, 'a lost create response must not become a second draft (F19-AC3)');
    assert.equal(harness.fixture.provider.drafts().length, 1);
    assert.equal(again.value.kind === 'DraftWritten' ? again.value.headSha : '', firstHead, 'the retry published the commit the first delivery published');
    assert.equal(
      await gitOrFail(worktree, ['rev-parse', 'HEAD'], 'reading the worktree head after the retry'),
      firstHead,
      'the retry did not add a second commit to the delivered branch',
    );
    /**
     * The retry changes no claim, only the write timestamp the managed marker carries.
     *
     * The digest in that marker is the adapter's own content revision, so comparing it is what says
     * the retry did not restate the evidence rather than this case reading two bodies and deciding.
     */
    const reconciled = harness.fixture.provider.drafts()[0]?.body ?? '';
    assert.equal(digestOf(reconciled), digestOf(firstBody), 'the retry wrote the same content revision');
    assert.equal(withoutMarker(reconciled), withoutMarker(firstBody), 'no claim in the delivered body changed on the retry');
    assert.equal((await git(worktree, ['status', '--porcelain'])).output.trim(), '', 'the retry left the worktree clean');
  });
});

test('F20-AC2, F24-AC3: a failing required check leaves the candidate unready and records a blocker naming it', async () => {
  await withHarness({ checkCommand: FAILING_CHECK }, async (harness) => {
    const tick = await harness.runtime.tick();
    assert.ok(tick.ok, `the tick was refused: ${tick.ok ? '' : tick.error.reason}`);
    assert.equal(claimedOf(tick.value.tick)?.outcomeKind, 'Completed', 'a failed check is a delivery fact, not an engine failure');

    const delivery = tick.value.delivery;
    assert.equal(delivery?.kind, 'DraftWritten', 'the change is still delivered, with the failure visible on it');
    assert.ok(
      delivery?.kind === 'DraftWritten' && delivery.notReady.some((reason) => reason.includes(REQUIRED_CHECK) && reason.includes('Failed')),
      `the card must name the failing required check: ${JSON.stringify(delivery)}`,
    );

    const blocker = openAttention(harness).find((item) => item.dedupKey === `CheckBlocker:${harness.jobId}`);
    assert.ok(blocker !== undefined, 'a failed required check must leave a blocker the owner can find');
    assert.equal(blocker?.kind, 'Blocker');
    assert.match(blocker?.blocker ?? '', /Required check/);
    assert.match(blocker?.blocker ?? '', /Failed/);
    assert.match(blocker?.nextAction ?? '', /another attempt/);

    const body = harness.fixture.provider.drafts()[0]?.body ?? '';
    assert.ok(
      body.includes(`- [ ] ${REQUIRED_CHECK} — reported failed by check ${REQUIRED_CHECK}`),
      `the delivered body reports the failure rather than hiding it (F19-AC2): ${body}`,
    );
    assert.equal(body.includes('reported passed'), false, 'nothing in the delivered body may claim a pass that did not happen');

    const candidates = need(harness.candidates.listForWorkItem(jobOf(harness).workItemId as WorkItemId), 'listing candidates');
    assert.equal(candidates.length, 1, 'one delivery records one candidate');
  });
});

test('F18-AC2: a reached limit waits for the owner, and the extension recorded in storage is what lets it continue', async () => {
  await withHarness({ checkCommand: PASSING_CHECK, limits: IMPOSSIBLE_LIMITS }, async (harness) => {
    const first = await harness.runtime.tick();
    assert.ok(first.ok, `the first tick was refused: ${first.ok ? '' : first.error.reason}`);
    const parked = claimedOf(first.value.tick);
    assert.equal(parked?.outcomeKind, 'WaitingForOwner', 'a one-millisecond budget is crossed by any real turn');
    assert.equal(jobState(harness), 'WaitingForOwner');
    assert.equal(first.value.delivery, null, 'an attempt that is still waiting is not delivered');
    assert.ok(
      openAttention(harness).some((item) => item.dedupKey === `owner-extension:${harness.jobId}`),
      'the attempt asks its owner for an extension rather than lifting its own limit',
    );

    const worktreeBefore = harness.runtime.workspaceFor(harness.jobId)?.worktreePath ?? '';
    const checkpoint = harness.database
      .prepare('SELECT head_sha, blocker FROM job_checkpoints WHERE job_id = ?')
      .get(harness.jobId);
    assert.ok(checkpoint !== undefined, 'the work is checkpointed before the attempt waits (F17-AC2)');
    assert.equal(checkpoint?.['head_sha'], harness.baseSha, 'the checkpoint records what the attempt had actually left');

    /**
     * The owner's decision, written to the durable column the extension port reads.
     *
     * `grantExtension` in the controller says in its own contract that the extended bound is not
     * written, because nothing in `@shiploop/storage` can write it (`jobs.limits` is written once,
     * by `enqueue`). This case therefore performs the write that writer is missing, so the loop the
     * port implements is proved end to end rather than half: the waiting attempt reads the raised
     * budget and continues. The missing writer is reported as a gap, not worked around in the port.
     */
    const raised = harness.database
      .prepare('UPDATE jobs SET active_budget_ms = ?, updated_at = ? WHERE job_id = ?')
      .run(600_000, systemClock.now(), harness.jobId);
    assert.equal(Number(raised.changes), 1, 'the live active-execution budget must be raisable for the port to observe an extension');

    const second = await harness.runtime.tick();
    assert.ok(second.ok, `the continued attempt was refused: ${second.ok ? '' : second.error.reason}`);
    const continued = claimedOf(second.value.tick);
    assert.equal(continued?.jobId, harness.jobId, 'the waiting attempt is the job that continued');
    assert.equal(continued?.outcomeKind, 'Completed');
    assert.equal(jobState(harness), 'Completed');
    assert.equal(harness.runtime.workspaceFor(harness.jobId)?.worktreePath, worktreeBefore, 'the continued attempt reused the workspace it was checkpointed in (F17-AC3)');
    assert.equal(second.value.delivery?.kind, 'DraftWritten', 'work that continued is delivered like any other work');
  });
});
