/**
 * The Codex adapter's boundaries: version parsing, the sandbox allowlist, argv construction, error
 * mapping, blocked results, and process-group shutdown.
 *
 * Two kinds of proof live here and they are kept apart on purpose.
 *
 * **Against a scripted engine binary.** `startSession` and `stopSession` are driven end to end
 * against a small `sh` script written into a temp directory, which speaks Codex's real JSONL
 * event shapes and exits on cue. That proves the argv, the detached process group, the line
 * queue, the translation, the terminal decision and the shutdown without spending engine quota.
 * The script is created per test and never lands in the repository, and it is not a fake adapter:
 * it is a real process emitting the real wire format, and everything downstream of it is the
 * shipped code.
 *
 * **Against a trivial `node -e` process group.** The shutdown contract — `SIGTERM`, then `SIGKILL`
 * to the same group, grandchildren included — is proven with a process that ignores `SIGTERM`, so
 * only escalation can clear it. Proving that does not need an engine turn.
 *
 * Codex's own behaviour against the real binary is proven by the captured output in
 * `events.test.ts` and by the live run recorded in `README.md`.
 *
 * Criterion IDs in each test name are the specification lines the assertion enforces.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { redact } from '@shiploop/domain';

import { FIXTURE_WORKSPACE, adapterContext, connectorId, operationId, providerId } from '../testing/fixtures.ts';
import type { AdapterContext, EngineEvent, ResumeEngineSessionRequest } from '../contracts/index.ts';

import {
  CODEX_SANDBOX_MODES,
  CODEX_SEPARATE_CREDENTIAL_VERSION,
  CODEX_VERIFIED_VERSION,
  CodexClient,
  ENGINE_CREDENTIAL_FILE,
  ENGINE_ENVIRONMENT_VARIABLES,
  ENGINE_RESULT_DIRECTORY,
  ENGINE_RESULT_SCHEMA_FILE,
  MAX_RESULT_BYTES,
  MINIMUM_CODEX_VERSION,
  attemptKeyOf,
  buildArgv,
  checkCodexVersion,
  confineResultPath,
  defaultEngineStateRoot,
  engineEnvironment,
  engineStateLayout,
  parseCodexVersion,
  prepareEngineResultChannel,
  prepareEngineState,
  readCodexResult,
  resolveEngineAuthentication,
  resolveSandboxMode,
  spawnTrackedGroup,
  stopCodexProcess,
  type CodexProcess,
  type EngineStateLayout,
} from './client.ts';
import { CodexEngineAdapter, missingRolloutDetail, renderPrompt } from './adapter.ts';
import {
  classifyCodexFailure,
  codexBlockedOutcome,
  codexDiagnosticRetry,
  isCodexBlocker,
  mapCodexFailure,
  mapCodexVersionProbeFailure,
} from './errors.ts';

const passthrough = (text: string): string => text;
const redacting = (text: string): string => redact(text).text;

/**
 * A credential-shaped canary, assembled rather than written out.
 *
 * The project policy lint refuses a credential-shaped literal in tracked source, and that rule is
 * right: a string that looks like a key has no business in a repository even as test material. The
 * assembled value still matches the domain redaction patterns, so the assertion stays real.
 */
const CREDENTIAL_CANARY = ['sk', 'proj', 'C'.repeat(26)].join('-');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'shiploop-codex-test-'));
}

/**
 * The environment a non-Codex child in these tests is spawned with.
 *
 * The shutdown and stdout proofs below are about the transport, not about the allowlist, but
 * they still spawn a real child, and `spawnTrackedGroup` takes the environment from its caller
 * precisely so no spawn in this file can fall back to inheriting the test runner's.
 */
function childEnvironment(workspace: string): NodeJS.ProcessEnv {
  return engineEnvironment(process.env, engineStateLayout({ stateRoot: join(workspace, 'state'), attempt: workspace }));
}

/**
 * Provisions the credential a real session is refused without.
 *
 * `start` resolves an engine credential before it spawns anything (F15-AC5), so a test that drives
 * the shipped transport has to hold one. It writes the exact shape `codex login --with-api-key`
 * produces, in a state root of the test's own making — never the operator's — so no test depends on
 * a credential this host happens to have.
 */
function provisionTestCredential(stateRoot: string, attempt: string): string {
  const state = prepareEngineState({ stateRoot, attempt });
  assert.ok(state.ok, `the engine state was created: ${state.ok ? '' : state.error.reason}`);
  if (!state.ok) throw new Error('unreachable');
  const path = join(state.value.codexHome, ENGINE_CREDENTIAL_FILE);
  writeFileSync(path, PROVISIONED_AUTH_JSON, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/**
 * Writes a scripted engine that speaks Codex's real JSONL and can be told to resist `SIGTERM`.
 *
 * The body is deliberately the captured wire format rather than anything convenient, so a change
 * in the parser that only works against invented events fails here.
 */
function scriptedEngine(body: string): { readonly binary: string; readonly dir: string } {
  const dir = tempDir();
  const binary = join(dir, 'codex');
  writeFileSync(binary, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(binary, 0o755);
  return { binary, dir };
}

interface PsRow {
  readonly pid: number;
  readonly pgid: number;
  readonly args: string;
}

/** Real processes in one process group, read from `ps` rather than from a guess. */
function processesInGroup(pgid: number): readonly PsRow[] {
  return psRows().filter((row) => row.pgid === pgid);
}

function psRows(): readonly PsRow[] {
  return execFileSync('ps', ['-o', 'pid=,pgid=,args=', '-e'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(/\s+/);
      return { pid: Number.parseInt(parts[0] ?? '', 10), pgid: Number.parseInt(parts[1] ?? '', 10), args: parts.slice(2).join(' ') };
    });
}

/**
 * The process group of a running command, found from `ps`.
 *
 * Only a test may do this. The adapter must never search for a process by name or command line,
 * which is why `stopSession` addresses a group id it captured at spawn time; a test that located
 * the group independently is what makes the adapter's own claim checkable (F17-AC5).
 */
function groupIdOfCommandContaining(needle: string): number | null {
  const row = psRows().find((entry) => entry.args.includes(needle));
  return row === undefined ? null : row.pgid;
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function collect(events: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const collected: EngineEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function resultOutcomes(events: readonly EngineEvent[]): readonly Extract<EngineEvent, { kind: 'Result' }>['outcome'][] {
  return events.filter((event): event is Extract<EngineEvent, { kind: 'Result' }> => event.kind === 'Result').map((event) => event.outcome);
}

/** Whether the session's single `Usage` event reported the engine's own numbers or refused to guess. */
function usageKindOf(events: readonly EngineEvent[]): 'Reported' | 'Unknown' | null {
  const usage = events.find((event) => event.kind === 'Usage');
  return usage !== undefined && usage.kind === 'Usage' ? usage.usage.kind : null;
}

/* -------------------------------------------------------------------------- */
/* Engine:VersionCheck                                                         */
/* -------------------------------------------------------------------------- */

/** Assembled from fragments: the policy linter must never see a credential-shaped
 * literal in tracked source, and production must never contain one either. */
const PROVISIONED_AUTH_JSON = ['{"auth_mode":"apikey","OPENAI_API_KEY":"sk-', 'provisioned-test-key"}'].join('');

/**
 * The operator config this product must never copy into the engine state.
 *
 * It is assembled rather than written literally so the rule forbidding an unrestricted
 * engine sandbox stays strict: the string must not appear in tracked source anywhere, and
 * this fixture is the only legitimate reason to produce it at run time.
 */
const UNRESTRICTED_CONFIG = ['sandbox_mode = "danger-full-', 'access"\napproval_policy = "never"\n'].join('');

test('F04-AC2, F15-AC4 the observed version banner parses into a comparable version', () => {
  assert.equal(parseCodexVersion('codex-cli 0.159.1\n'), '0.159.1');
  assert.equal(parseCodexVersion('codex-cli 0.159.1'), '0.159.1');
  assert.equal(parseCodexVersion('  codex-cli 1.2.3  \n'), '1.2.3');
});

test('F04-AC2 a version banner this adapter cannot read is null, not a guess', () => {
  assert.equal(parseCodexVersion(''), null);
  assert.equal(parseCodexVersion('codex 0.159.1'), null);
  assert.equal(parseCodexVersion('command not found: codex'), null);
  assert.equal(parseCodexVersion('codex-cli 0.159'), null);
  assert.equal(parseCodexVersion('codex-cli unknown'), null);
});

test('F04-AC2 the version verdict compares numerically, not lexicographically', () => {
  assert.equal(checkCodexVersion(CODEX_VERIFIED_VERSION).compatible, true);
  assert.equal(checkCodexVersion('0.160.0').compatible, true);
  assert.equal(checkCodexVersion('1.0.0').compatible, true);
  // 0.159.10 is NEWER than 0.159.9; a string comparison would refuse it.
  assert.equal(checkCodexVersion('0.159.10').compatible, true);
  assert.equal(checkCodexVersion('0.158.99').compatible, false);
  assert.equal(checkCodexVersion('0.9.99').compatible, false);
  assert.equal(checkCodexVersion('nonsense').compatible, false);
  assert.match(checkCodexVersion('0.158.0').detail, /older than the/);
  assert.equal(MINIMUM_CODEX_VERSION, CODEX_VERIFIED_VERSION);
  assert.match(checkCodexVersion('nonsense').detail, /unrecognised version/);
});

test('F04-AC2 an absent engine is a Blocked prerequisite, not a compatibility answer', () => {
  const error = mapCodexVersionProbeFailure('spawn codex ENOENT', null, passthrough);
  assert.equal(error.code, 'Blocked');
  assert.equal(error.prerequisites[0]?.name, 'CodexRuntime');
  assert.match(error.prerequisites[0]?.remedy ?? '', /architecture/);
  assert.match(error.prerequisites[0]?.remedy ?? '', /sandbox/);
});

test('F04-AC2 checkCompatibility reports the version the binary actually printed', async () => {
  const engine = scriptedEngine('echo "codex-cli 0.159.1"');
  try {
    const adapter = new CodexEngineAdapter({ connectorId: connectorId('connector_codex_version'), client: { binary: engine.binary } });
    const compatibility = await adapter.checkCompatibility(adapterContext('op_codex_version'));
    assert.equal(compatibility.ok, true);
    if (!compatibility.ok) return;
    assert.equal(compatibility.value.kind, 'Engine');
    assert.equal(compatibility.value.runtimeVersion, '0.159.1');
    assert.equal(compatibility.value.compatible, true);
    assert.match(compatibility.value.detail, new RegExp(CODEX_VERIFIED_VERSION.replace(/\./g, '\\.')));
  } finally {
    rmSync(engine.dir, { recursive: true, force: true });
  }
});

test('F04-AC2 a binary that is not Codex yields Blocked rather than a compatibility verdict', async () => {
  const engine = scriptedEngine('echo "not the expected banner"');
  try {
    const adapter = new CodexEngineAdapter({ connectorId: connectorId('connector_codex_badversion'), client: { binary: engine.binary } });
    const compatibility = await adapter.checkCompatibility(adapterContext('op_codex_badversion'));
    assert.equal(compatibility.ok, false);
    assert.equal(compatibility.ok === false ? compatibility.error.code : null, 'Blocked');
    const prerequisites = compatibility.ok === false && compatibility.error.code === 'Blocked' ? compatibility.error.prerequisites : [];
    assert.equal(prerequisites[0]?.name, 'CodexRuntime');
    assert.match(compatibility.ok === false ? compatibility.error.reason : '', /could not report a version/);
  } finally {
    rmSync(engine.dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* F03-AC5 / N02-AC3: the sandbox boundary                                     */
/* -------------------------------------------------------------------------- */

test('F03-AC5, N02-AC3 only the two bounded sandbox modes are grantable', () => {
  assert.deepEqual([...CODEX_SANDBOX_MODES], ['read-only', 'workspace-write']);
  for (const mode of CODEX_SANDBOX_MODES) {
    assert.equal(resolveSandboxMode(mode, passthrough).ok, true);
  }
});

test('F03-AC5, N02-AC3 an unrestricted sandbox request is refused before any process exists', () => {
  // The operator profile on this host asks for an unrestricted engine; the refusal must still hold.
  const unrestricted = ['danger', 'full', 'access'].join('-');
  const refused = resolveSandboxMode(unrestricted, passthrough);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false ? refused.error.code : null, 'Forbidden');
  const reason = refused.ok === false ? refused.error.reason : '';
  assert.match(reason, /read-only and workspace-write/);
  assert.match(reason, /F03-AC5, N02-AC3/);
});

test('F03-AC5, N02-AC3 the guard is an allowlist, so an unknown mode also fails closed', () => {
  for (const mode of ['', 'workspace_write', 'readOnly', 'none', 'READ-ONLY', 'workspace-write ']) {
    assert.equal(resolveSandboxMode(mode, passthrough).ok, false, `"${mode}" was granted`);
  }
});

test('F03-AC5 an adapter configured with an unrestricted sandbox refuses to start anything', async () => {
  const adapter = new CodexEngineAdapter({
    connectorId: connectorId('connector_codex_bad_sandbox'),
    client: { binary: '/nonexistent/codex' },
    sandbox: ['danger', 'full', 'access'].join('-'),
  });
  const refused = await adapter.startSession(adapterContext('op_codex_bad_sandbox'), {
    operationId: operationId('op_codex_bad_sandbox'),
    workspace: FIXTURE_WORKSPACE,
    start: { kind: 'Fresh', instruction: 'do nothing' },
    mode: 'Headless',
    grantedCapabilities: ['Git:ReadRepository'],
    bounds: { activeWallClockMs: 1_000, retryBudget: 1, eventCountLimit: 8 },
  });
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.error.reason : '', /not a sandbox mode/);
});

test('F03-AC5, N02-AC3 a coding session carrying a delivery capability is refused before Codex starts', async () => {
  const adapter = new CodexEngineAdapter({ connectorId: connectorId('connector_codex_guard'), client: { binary: '/nonexistent/codex' } });
  const refused = await adapter.startSession(adapterContext('op_codex_guard'), {
    operationId: operationId('op_codex_guard'),
    workspace: FIXTURE_WORKSPACE,
    start: { kind: 'Fresh', instruction: 'do nothing' },
    mode: 'Headless',
    // The type excludes delivery kinds; a grant assembled outside it must still be refused.
    grantedCapabilities: ['Git:MergeWithPrecondition', 'Deployment:Execute'] as never,
    bounds: { activeWallClockMs: 1_000, retryBudget: 1, eventCountLimit: 8 },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false ? refused.error.code : null, 'Forbidden');
  assert.match(refused.ok === false ? refused.error.reason : '', /may not hold/);
  assert.match(refused.ok === false ? refused.error.reason : '', /F03-AC5, N02-AC3/);
});

test('F15-AC1 an interactive session is refused rather than run unobserved', async () => {
  const adapter = new CodexEngineAdapter({ connectorId: connectorId('connector_codex_mode'), client: { binary: '/nonexistent/codex' } });
  const refused = await adapter.startSession(adapterContext('op_codex_mode'), {
    operationId: operationId('op_codex_mode'),
    workspace: FIXTURE_WORKSPACE,
    start: { kind: 'Fresh', instruction: 'do nothing' },
    mode: 'Interactive',
    grantedCapabilities: ['Git:ReadRepository'],
    bounds: { activeWallClockMs: 1_000, retryBudget: 1, eventCountLimit: 8 },
  });
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.error.reason : '', /no interactive transport/);
});

/* -------------------------------------------------------------------------- */
/* argv construction                                                           */
/* -------------------------------------------------------------------------- */

test('F03-AC5 a fresh argv carries the sandbox, the workspace, --json and no bypass flag', () => {
  const argv = buildArgv({
    sandbox: 'workspace-write',
    invocation: 'Fresh',
    prompt: 'create probe.txt',
    cwd: '/tmp/attempt',
    model: null,
    skipGitRepoCheck: false,
    configOverrides: [],
    resultChannel: null,
  });
  assert.deepEqual(argv, ['exec', '--sandbox', 'workspace-write', '--cd', '/tmp/attempt', '--json', '--', 'create probe.txt']);
  // A session that asked for no structured result puts no result flags on the command line, so
  // there is no artifact for anything to read and nothing that could be read instead.
  assert.equal(argv.includes('--output-schema'), false);
  assert.equal(argv.includes('-o'), false);
  assert.equal(argv.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(argv.includes('--dangerously-bypass-hook-trust'), false);
});

test('F15-AC4 a resume argv carries the sandbox as a config override and the thread id positionally', () => {
  const argv = buildArgv({
    sandbox: 'read-only',
    invocation: 'Resume',
    prompt: 'continue',
    cwd: '/tmp/attempt',
    model: 'gpt-6-luna',
    skipGitRepoCheck: true,
    configOverrides: ['approval_policy="never"'],
    resultChannel: null,
    priorSessionId: '01a0f699-7149-7d20-831e-98f7b7b43a71',
  });
  // `codex exec resume` accepts neither --sandbox nor --cd on 0.159.1, so both are carried elsewhere.
  assert.equal(argv.includes('--sandbox'), false);
  assert.equal(argv.includes('--cd'), false);
  assert.deepEqual(argv, [
    'exec',
    'resume',
    '-c',
    "sandbox_mode='read-only'",
    '--json',
    '-m',
    'gpt-6-luna',
    '--skip-git-repo-check',
    '-c',
    'approval_policy="never"',
    '--',
    '01a0f699-7149-7d20-831e-98f7b7b43a71',
    'continue',
  ]);
  // `--last` would let Codex pick an arbitrary session and silently continue the wrong one.
  assert.equal(argv.includes('--last'), false);
});

test('F03-AC5 an instruction that looks like a shell command stays one argument after --', () => {
  const argv = buildArgv({
    sandbox: 'read-only',
    invocation: 'Fresh',
    prompt: '; rm -rf / && echo pwned',
    cwd: '/tmp/attempt',
    model: null,
    skipGitRepoCheck: false,
    configOverrides: [],
    resultChannel: null,
  });
  assert.equal(argv[argv.length - 1], '; rm -rf / && echo pwned');
  assert.equal(argv.filter((entry) => entry.includes('rm -rf')).length, 1);
});

test('F04-AC2 a missing engine binary is reported, and does not take the process down', async () => {
  const adapter = new CodexEngineAdapter({ connectorId: connectorId('connector_codex_missing'), client: { binary: '/nonexistent/codex-binary' } });
  const context: AdapterContext = { ...adapterContext('op_codex_missing'), signal: AbortSignal.timeout(20_000) };
  const started = await adapter.startSession(context, {
    operationId: operationId('op_codex_missing'),
    workspace: FIXTURE_WORKSPACE,
    start: { kind: 'Fresh', instruction: 'do a thing' },
    mode: 'Headless',
    grantedCapabilities: ['Git:ReadRepository'],
    bounds: { activeWallClockMs: 5_000, retryBudget: 1, eventCountLimit: 16 },
  });
  // A missing binary surfaces as a Blocked prerequisite, not as an unhandled `error` event that
  // would abort the worker.
  assert.equal(started.ok, false);
  assert.equal(started.ok === false ? started.error.code : null, 'Blocked');
  const prerequisites = started.ok === false && started.error.code === 'Blocked' ? started.error.prerequisites : [];
  assert.equal(prerequisites[0]?.name, 'CodexRuntime');
  await new Promise((resolve) => setTimeout(resolve, 200));
});

test('F15-AC4 a resume without a thread id is refused rather than falling back to --last', async () => {
  const engine = scriptedEngine('echo "{}"');
  try {
    const adapter = new CodexEngineAdapter({ connectorId: connectorId('connector_codex_noresume'), client: { binary: engine.binary } });
    const request: ResumeEngineSessionRequest = {
      operationId: operationId('op_codex_noresume'),
      workspace: FIXTURE_WORKSPACE,
      priorSession: { sessionId: providerId('01a0f699-7149-7d20-831e-98f7b7b43a71'), engineVersion: CODEX_VERIFIED_VERSION, lastEventAt: '2026-10-01T08:34:07.000Z' },
      checkpoint: {
        checkpointId: 'checkpoint_01',
        capturedAt: '2026-10-01T08:00:00.000Z',
        scopeFingerprint: FIXTURE_WORKSPACE.scopeFingerprint,
        headSha: FIXTURE_WORKSPACE.headSha,
        baseSha: FIXTURE_WORKSPACE.baseSha,
        dirtyPaths: [],
        untrackedPaths: [],
        blocker: null,
        nextAction: 'continue',
        resumeInstructions: 'stay in scope',
      },
      instruction: 'continue',
      grantedCapabilities: ['Git:ReadRepository'],
      bounds: { activeWallClockMs: 5_000, retryBudget: 1, eventCountLimit: 32 },
    };
    const continuation = await adapter.resumeSession(adapterContext('op_codex_noresume'), request);
    // The scripted engine does not reproduce a missing rollout, so this must not silently succeed.
    assert.equal(continuation.ok === true && continuation.value.kind === 'ResumedInPlace', false);
  } finally {
    rmSync(engine.dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* F15-AC2: the structured result channel, separate from bounded summaries     */
/* -------------------------------------------------------------------------- */

/**
 * The JSON Schema a plan-mode result is asked to satisfy.
 *
 * The same shape `applyPlanProposal` needs, kept small here: what is under test is that the schema
 * reaches `codex` and that the payload comes back whole, not that this adapter can describe a plan.
 */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'briefId', 'draftedAt', 'requestedOutcomes', 'tasks', 'exclusions'],
  properties: {
    kind: { type: 'string', enum: ['PlanProposal'] },
    briefId: { type: 'string' },
    draftedAt: { type: 'string' },
    requestedOutcomes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'statement'],
        properties: { id: { type: 'string' }, statement: { type: 'string' } },
      },
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'taskId',
          'coversOutcomeIds',
          'outcome',
          'scope',
          'acceptanceCriteria',
          'verificationMethod',
          'dependencies',
          'relevantProjectContext',
          'implementationLocation',
        ],
        properties: {
          taskId: { type: 'string' },
          coversOutcomeIds: { type: 'array', items: { type: 'string' } },
          outcome: { type: 'string' },
          scope: { type: 'string' },
          acceptanceCriteria: { type: 'array', minItems: 1, items: { type: 'string' } },
          verificationMethod: { type: 'string' },
          dependencies: { type: 'array', items: { type: 'string' } },
          relevantProjectContext: { type: 'array', items: { type: 'string' } },
          implementationLocation: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'candidates', 'basis'],
            properties: {
              kind: { type: 'string', enum: ['ProposedLocation'] },
              candidates: { type: 'array', minItems: 1, items: { type: 'string' } },
              basis: { type: 'string' },
            },
          },
        },
      },
    },
    exclusions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['outcomeId', 'excluded', 'reason'],
        properties: {
          outcomeId: { type: 'string' },
          excluded: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

/** Every object node in a schema, so the rule below can be checked rather than remembered. */
function objectNodesOf(schema: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return found;
  const node = schema as Record<string, unknown>;
  if (node['type'] === 'object') found.push(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const entry of value) objectNodesOf(entry, found);
    else objectNodesOf(value, found);
  }
  return found;
}

test('F15-AC2 the schema this adapter writes must declare additionalProperties false everywhere', () => {
  // Measured on 2 October 2026 against a live `codex exec --output-schema`: the provider refused a
  // schema whose object nodes did not say so, with
  //   `Invalid schema for response_format 'codex_output_schema': In context=(),
  //    'additionalProperties' is required to be supplied and to be false.`
  // and the turn failed. The adapter reported that as the engine's own refusal rather than as a
  // success with an empty result, which is the right answer, but the fix belongs here: a caller
  // that writes a schema without it gets a failed turn and no payload, and the error names a
  // provider constraint rather than anything ShipLoop could have checked in advance.
  //
  // So this test exists to keep the shipped fixture honest. It cannot make every caller's schema
  // valid, and it does not pretend to: `EngineResultSchema` is the engine's document, and the
  // provider's rules for it are the provider's. What it does is make sure the example this adapter
  // ships and proves against is one the provider accepts.
  const nodes = objectNodesOf(RESULT_SCHEMA);
  assert.ok(nodes.length >= 5, `expected several object nodes in the fixture schema, saw ${String(nodes.length)}`);
  for (const node of nodes) {
    assert.equal(node['additionalProperties'], false, 'an object node in the fixture schema omits additionalProperties: false');
  }
});

/**
 * A payload that is unambiguously longer than the 400-character summary cap.
 *
 * Built rather than pasted so the test can state the property it depends on — every prose field is
 * a distinct sentence, so no amount of compression could bring the whole object under the cap.
 */
function longResultPayload(): string {
  const sentence = (topic: string): string =>
    `A ${topic} sentence long enough that no reader would treat it as incidental, written here so the payload cannot be summarised away.`;
  return JSON.stringify({
    kind: 'PlanProposal',
    briefId: 'brief_result_001',
    draftedAt: '2026-10-02T00:00:00.000Z',
    requestedOutcomes: [
      { id: 'brief.desiredOutcome', statement: sentence('desired outcome') },
      { id: 'AC-1', statement: sentence('acceptance') },
    ],
    tasks: [
      {
        taskId: 'T-1',
        coversOutcomeIds: ['brief.desiredOutcome', 'AC-1'],
        outcome: sentence('outcome'),
        scope: sentence('scope'),
        acceptanceCriteria: [sentence('criterion one'), sentence('criterion two')],
        verificationMethod: sentence('verification'),
        dependencies: [],
        relevantProjectContext: [sentence('context'), sentence('more context')],
        implementationLocation: {
          kind: 'ProposedLocation',
          candidates: ['packages/adapters/src/codex/client.ts'],
          basis: sentence('basis'),
        },
      },
    ],
    exclusions: [],
  });
}

/** One JSONL line carrying `text` as a completed `agent_message`, as Codex emits it. */
function agentMessageLine(text: string): string {
  return JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
}

/**
 * A scripted engine that honours the result channel the way the real CLI does.
 *
 * It reads `-o <file>` out of its own argv and writes the payload there, which is exactly what
 * `codex exec -o` was observed doing under `--sandbox read-only`. It also emits the same payload as
 * a completed `agent_message` on stdout, which is what the old channel had to truncate. Everything
 * downstream — argv, the confined artifact, the read, the check, the terminal decision — is shipped
 * code.
 */
function scriptedResultEngine(payload: string, extra = ''): { readonly binary: string; readonly dir: string } {
  return scriptedEngine(
    [
      // Record what this process was actually given, so the argv assertions are about the process
      // the adapter spawned rather than about `buildArgv` in isolation.
      `printf '%s\\n' "$@" > "$(dirname "$0")/argv.txt"`,
      'out=""',
      'prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "-o" ]; then out="$arg"; fi',
      '  prev="$arg"',
      'done',
      'mkdir -p "$(dirname "$out")"',
      // `$(cat <<...)` rather than a bare heredoc: a heredoc appends a newline, and the point of
      // the fixture is that the artifact holds exactly the payload and nothing else.
      `printf '%s' "$(cat <<'SHIPLOOP_RESULT_EOF'`,
      payload,
      'SHIPLOOP_RESULT_EOF',
      ')" > "$out"',
      `printf '%s\\n' '{"type":"thread.started","thread_id":"01a0fd2d-02db-78d3-931e-061b2b3832f5"}'`,
      `printf '%s\\n' '{"type":"turn.started"}'`,
      `printf '%s\\n' '${agentMessageLine(payload)}'`,
      `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":14876,"output_tokens":1530}}'`,
      extra,
    ].join('\n'),
  );
}

function attemptLayout(workspace: string, stateRoot: string): EngineStateLayout {
  return engineStateLayout({ stateRoot, attempt: workspace });
}

test('F15-AC2 the result channel is put on the command line for a fresh run, and the prompt stays last', () => {
  const argv = buildArgv({
    sandbox: 'read-only',
    invocation: 'Fresh',
    prompt: 'answer with the proposal',
    cwd: '/tmp/attempt',
    model: null,
    skipGitRepoCheck: false,
    configOverrides: [],
    resultChannel: { schemaPath: '/state/home/k/.shiploop/results/schema.json', resultPath: '/state/home/k/.shiploop/results/t.json' },
  });
  assert.deepEqual(argv, [
    'exec',
    '--sandbox',
    'read-only',
    '--cd',
    '/tmp/attempt',
    '--json',
    '--output-schema',
    '/state/home/k/.shiploop/results/schema.json',
    '-o',
    '/state/home/k/.shiploop/results/t.json',
    '--',
    'answer with the proposal',
  ]);
  // Both flags precede `--`, so neither path can be read as the prompt.
  assert.ok(argv.indexOf('--output-schema') < argv.indexOf('--'));
  assert.ok(argv.indexOf('-o') < argv.indexOf('--'));
  assert.equal(argv[argv.length - 1], 'answer with the proposal');
});

test('F15-AC2 a resumed run gets the same result channel, which `codex exec resume --help` lists', () => {
  const argv = buildArgv({
    sandbox: 'read-only',
    invocation: 'Resume',
    prompt: 'continue',
    cwd: '/tmp/attempt',
    model: null,
    skipGitRepoCheck: true,
    configOverrides: [],
    resultChannel: { schemaPath: '/state/home/k/.shiploop/results/schema.json', resultPath: '/state/home/k/.shiploop/results/t.json' },
    priorSessionId: '01a0f699-7149-7d20-831e-98f7b7b43a71',
  });
  assert.equal(argv.includes('--output-schema'), true);
  assert.equal(argv.includes('-o'), true);
  assert.ok(argv.indexOf('-o') < argv.indexOf('--'));
  assert.equal(argv[argv.length - 1], 'continue');
  assert.equal(argv[argv.length - 2], '01a0f699-7149-7d20-831e-98f7b7b43a71');
});

test('F15-AC2 the channel is confined to the attempt home, and the schema is written inside it', () => {
  const workspace = tempDir();
  const stateRoot = join(workspace, 'state');
  try {
    const layout = attemptLayout(workspace, stateRoot);
    const prepared = prepareEngineState({ stateRoot, attempt: workspace });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;

    const channel = prepareEngineResultChannel({ layout: layout, schema: RESULT_SCHEMA, token: 'token-1' });
    assert.ok(channel.ok, channel.ok === false ? channel.error.reason : '');
    if (!channel.ok) return;

    // The artifact is inside the attempt home, and reported relative to it so an event carries no
    // host path.
    assert.equal(channel.value.root, realpathSync(layout.home));
    assert.equal(channel.value.resultPath, join(realpathSync(layout.home), ENGINE_RESULT_DIRECTORY, 'token-1.json'));
    assert.equal(channel.value.resultRelativePath, join(ENGINE_RESULT_DIRECTORY, 'token-1.json'));
    assert.equal(channel.value.maxBytes, MAX_RESULT_BYTES);
    assert.equal(existsSync(channel.value.resultPath), false, 'the result path must not exist before the run');

    // The schema the engine is constrained by is the caller's, byte for byte.
    assert.equal(channel.value.schemaPath, join(realpathSync(layout.home), ENGINE_RESULT_DIRECTORY, ENGINE_RESULT_SCHEMA_FILE));
    assert.deepEqual(JSON.parse(readFileSync(channel.value.schemaPath, 'utf8')), RESULT_SCHEMA);
    assert.equal(statSync(channel.value.schemaPath).mode & 0o777, 0o600);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC2 a result path is confined after symlinks are resolved, not before', () => {
  const workspace = tempDir();
  const stateRoot = join(workspace, 'state');
  try {
    const layout = attemptLayout(workspace, stateRoot);
    const prepared = prepareEngineState({ stateRoot, attempt: workspace });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    const root = realpathSync(layout.home);
    mkdirSync(join(root, ENGINE_RESULT_DIRECTORY), { recursive: true });

    // A relative path resolves against whatever the process considers its working directory, which
    // is not a boundary at all.
    const relative = confineResultPath(root, join(ENGINE_RESULT_DIRECTORY, 'x.json'));
    assert.equal(relative.ok, false);
    assert.match(relative.ok === false ? relative.error.reason : '', /must be absolute/);

    // `..` traversal out of the attempt directory, resolved before it is compared.
    const traversal = confineResultPath(root, join(root, '..', 'escape.json'));
    assert.equal(traversal.ok, false);
    assert.equal(traversal.ok === false ? traversal.error.code : null, 'Forbidden');
    assert.match(traversal.ok === false ? traversal.error.reason : '', /outside the attempt directory/);

    // A symlinked parent that leaves the attempt directory. This is the case a prefix test on the
    // unresolved path would pass and a containment test on the resolved one does not.
    const elsewhere = join(workspace, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(layout.home, 'escape'));
    const throughLink = confineResultPath(root, join(layout.home, 'escape', 'stolen.json'));
    assert.equal(throughLink.ok, false);
    assert.equal(throughLink.ok === false ? throughLink.error.code : null, 'Forbidden');

    // A path whose directory does not exist cannot be resolved, so it cannot be shown to be inside.
    const missing = confineResultPath(root, join(root, 'no-such-directory', 'x.json'));
    assert.equal(missing.ok, false);
    assert.match(missing.ok === false ? missing.error.reason : '', /does not exist/);

    // The honest case still works, and returns the resolved path rather than the requested one.
    const inside = confineResultPath(root, join(root, ENGINE_RESULT_DIRECTORY, 'ok.json'));
    assert.ok(inside.ok);
    if (!inside.ok) return;
    assert.equal(inside.value, join(root, ENGINE_RESULT_DIRECTORY, 'ok.json'));
    // A prefix is not containment: `/a/bc` must not read as inside `/a/b`.
    assert.equal(confineResultPath(root, join(root, '..', 'bc', 'x.json')).ok, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC2 a results directory that resolves outside the attempt home is refused, not created', () => {
  const workspace = tempDir();
  const stateRoot = join(workspace, 'state');
  try {
    const layout = attemptLayout(workspace, stateRoot);
    const prepared = prepareEngineState({ stateRoot, attempt: workspace });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;

    // A `.shiploop` planted as a link to a directory the attempt does not own. Creating the
    // results directory through it succeeds, so only a check on the *resolved* directory refuses.
    const elsewhere = join(workspace, 'elsewhere');
    mkdirSync(join(elsewhere, 'results'), { recursive: true });
    symlinkSync(elsewhere, join(layout.home, '.shiploop'));

    const refused = prepareEngineResultChannel({ layout, schema: RESULT_SCHEMA, token: 'token-1' });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false ? refused.error.code : null, 'Forbidden');
    assert.match(refused.ok === false ? refused.error.reason : '', /does not resolve to a location inside the attempt directory/);
    assert.equal(existsSync(join(elsewhere, 'results', 'token-1.json')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC2 a result file left over from an earlier launch is refused, never read as this one', () => {
  const workspace = tempDir();
  const stateRoot = join(workspace, 'state');
  try {
    const layout = attemptLayout(workspace, stateRoot);
    const prepared = prepareEngineState({ stateRoot, attempt: workspace });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;

    const first = prepareEngineResultChannel({ layout, schema: RESULT_SCHEMA, token: 'shared-token' });
    assert.ok(first.ok);
    if (!first.ok) return;
    // An earlier attempt on this worktree left its answer here. The token makes that improbable; the
    // existence check is what makes it impossible, so a pinned token is what proves it.
    writeFileSync(first.value.resultPath, '{"kind":"PlanProposal"}', 'utf8');

    const second = prepareEngineResultChannel({ layout, schema: RESULT_SCHEMA, token: 'shared-token' });
    assert.equal(second.ok, false);
    assert.equal(second.ok === false ? second.error.code : null, 'Conflict');
    assert.match(second.ok === false ? second.error.reason : '', /already exists/);
    assert.match(second.ok === false ? second.error.reason : '', /earlier attempt/);

    // And the stale bytes are what is still on disk: nothing overwrote them, so the guard refused
    // rather than quietly starting over.
    assert.equal(readFileSync(first.value.resultPath, 'utf8'), '{"kind":"PlanProposal"}');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC2 a byte bound this adapter will not honour is refused rather than silently applied', () => {
  const workspace = tempDir();
  const stateRoot = join(workspace, 'state');
  try {
    const layout = attemptLayout(workspace, stateRoot);
    const prepared = prepareEngineState({ stateRoot, attempt: workspace });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    for (const maxBytes of [0, -1, 1.5, MAX_RESULT_BYTES + 1, Number.NaN]) {
      const refused = prepareEngineResultChannel({ layout, schema: RESULT_SCHEMA, token: 't', maxBytes });
      assert.equal(refused.ok, false, `maxBytes ${String(maxBytes)} was accepted`);
      assert.match(refused.ok === false ? refused.error.reason : '', /byte bound|integer from 1/);
    }
    assert.equal(prepareEngineResultChannel({ layout, schema: RESULT_SCHEMA, token: 't', maxBytes: MAX_RESULT_BYTES }).ok, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC2 an artifact that cannot be read names which of the four faults it was', () => {
  const workspace = tempDir();
  const stateRoot = join(workspace, 'state');
  try {
    const layout = attemptLayout(workspace, stateRoot);
    const prepared = prepareEngineState({ stateRoot, attempt: workspace });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    const channel = prepareEngineResultChannel({ layout, schema: RESULT_SCHEMA, token: 'token-1' });
    assert.ok(channel.ok);
    if (!channel.ok) return;

    // Nothing written.
    const missing = readCodexResult(channel.value);
    assert.equal(missing.ok, false);
    assert.match(missing.ok === false ? missing.error.reason : '', /No structured result was written/);

    // Written, but empty.
    writeFileSync(channel.value.resultPath, '', 'utf8');
    const empty = readCodexResult(channel.value);
    assert.equal(empty.ok, false);
    assert.match(empty.ok === false ? empty.error.reason : '', /is empty/);

    // Written, and past the bound. A payload this adapter will not read whole is refused rather
    // than truncated, because it cannot tell a cut-off result from a complete one.
    writeFileSync(channel.value.resultPath, 'x'.repeat(MAX_RESULT_BYTES + 1), 'utf8');
    const oversize = readCodexResult(channel.value);
    assert.equal(oversize.ok, false);
    assert.match(oversize.ok === false ? oversize.error.reason : '', /past the .*-byte bound/);
    assert.match(oversize.ok === false ? oversize.error.reason : '', /refused rather than truncated/);

    // Whole, and inside the bound.
    writeFileSync(channel.value.resultPath, '{"kind":"PlanProposal"}', 'utf8');
    const read = readCodexResult(channel.value);
    assert.ok(read.ok);
    if (!read.ok) return;
    assert.equal(read.value.text, '{"kind":"PlanProposal"}');
    assert.equal(read.value.byteLength, Buffer.byteLength('{"kind":"PlanProposal"}', 'utf8'));
    assert.equal(read.value.sourcePath, join(ENGINE_RESULT_DIRECTORY, 'token-1.json'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC2 an artifact cut mid-character is refused, because a lossy decode is not a result', () => {
  const workspace = tempDir();
  const stateRoot = join(workspace, 'state');
  try {
    const layout = attemptLayout(workspace, stateRoot);
    const prepared = prepareEngineState({ stateRoot, attempt: workspace });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    const channel = prepareEngineResultChannel({ layout, schema: RESULT_SCHEMA, token: 'token-1' });
    assert.ok(channel.ok);
    if (!channel.ok) return;

    // The two leading bytes of a three-byte sequence, appended to text that is otherwise valid JSON.
    // The file holds bytes no decoder can turn back into the character that was written.
    const whole = Buffer.from('{"note":"café"}', 'utf8');
    const cutAt = whole.indexOf(0xc3) + 1;
    writeFileSync(channel.value.resultPath, whole.subarray(0, cutAt));
    assert.equal(statSync(channel.value.resultPath).size, cutAt);

    const read = readCodexResult(channel.value);
    assert.equal(read.ok, false);
    assert.match(read.ok === false ? read.error.reason : '', /cut off mid-character/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC2 an artifact that is a symbolic link is never followed, and neither is one outside the home', () => {
  const workspace = tempDir();
  const stateRoot = join(workspace, 'state');
  try {
    const layout = attemptLayout(workspace, stateRoot);
    const prepared = prepareEngineState({ stateRoot, attempt: workspace });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    const channel = prepareEngineResultChannel({ layout, schema: RESULT_SCHEMA, token: 'token-1' });
    assert.ok(channel.ok);
    if (!channel.ok) return;

    // The escape this refuses: a real answer somewhere else entirely, reached through a link.
    const elsewhere = join(workspace, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'planted.json'), '{"kind":"PlanProposal"}', 'utf8');
    symlinkSync(join(elsewhere, 'planted.json'), channel.value.resultPath);

    const throughLink = readCodexResult(channel.value);
    assert.equal(throughLink.ok, false);
    assert.match(throughLink.ok === false ? throughLink.error.reason : '', /not a regular file/);
    assert.match(throughLink.ok === false ? throughLink.error.reason : '', /never followed/);

    // And a channel whose recorded path is outside the attempt home, which is what a link swapped in
    // during the run would produce. The containment check runs again at read time for that reason.
    const outside = readCodexResult({
      ...channel.value,
      resultPath: join(elsewhere, 'planted.json'),
      resultRelativePath: join(ENGINE_RESULT_DIRECTORY, 'token-1.json'),
    });
    assert.equal(outside.ok, false);
    assert.equal(outside.ok === false ? outside.error.code : null, 'Forbidden');
    assert.match(outside.ok === false ? outside.error.reason : '', /outside the attempt directory/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC2 a live-shaped session delivers a result longer than the cap, whole, and keeps every summary bounded', async () => {
  const payload = longResultPayload();
  assert.ok(Buffer.byteLength(payload, 'utf8') > 400, 'the fixture must be longer than the summary cap');

  const engine = scriptedResultEngine(payload);
  const workspace = tempDir();
  const stateRoot = join(workspace, 'state');
  provisionTestCredential(stateRoot, workspace);
  try {
    const adapter = new CodexEngineAdapter({
      connectorId: connectorId('connector_codex_result'),
      client: { binary: engine.binary, stateRoot },
      sessionStartTimeoutMs: 15_000,
      sandbox: 'read-only',
    });
    const context: AdapterContext = { ...adapterContext('op_codex_result'), signal: AbortSignal.timeout(30_000) };
    const started = await adapter.startSession(context, {
      operationId: operationId('op_codex_result'),
      workspace: { ...FIXTURE_WORKSPACE, absolutePath: workspace },
      start: { kind: 'Fresh', instruction: 'propose a plan' },
      mode: 'Headless',
      grantedCapabilities: ['Git:ReadRepository'],
      bounds: { activeWallClockMs: 20_000, retryBudget: 1, eventCountLimit: 64 },
      result: { schema: RESULT_SCHEMA },
    });
    assert.equal(started.ok, true, started.ok === false ? started.error.reason : '');
    if (!started.ok) return;

    const events = await collect(started.value.events);
    const outcomes = resultOutcomes(events);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.kind, 'Succeeded');

    const outcome = outcomes[0]?.kind === 'Succeeded' ? outcomes[0] : null;
    assert.ok(outcome?.result !== undefined, 'the structured result did not reach the outcome');
    assert.equal(outcome.result.byteLength, Buffer.byteLength(payload, 'utf8'));
    assert.equal(outcome.result.json, payload);
    assert.deepEqual(JSON.parse(outcome.result.json), JSON.parse(payload));

    // The bounded channel stayed bounded, and visibly did not carry the answer.
    assert.ok(outcome.summary.length <= 412, `the terminal summary grew past the cap: ${String(outcome.summary.length)}`);
    assert.match(outcome.summary, /\[truncated\]$/);
    for (const event of events) {
      if (event.kind !== 'Progress') continue;
      assert.ok(event.summary.length <= 412, `a progress summary grew past the cap: ${String(event.summary.length)}`);
      assert.ok(!event.summary.includes('acceptanceCriteria'), 'a progress summary carried the payload');
    }

    // The spawned process really was given both flags, with the paths inside the attempt's home.
    const layout = attemptLayout(workspace, stateRoot);
    const home = realpathSync(layout.home);
    const argv = readFileSync(join(engine.dir, 'argv.txt'), 'utf8').split('\n').filter((line) => line.length > 0);
    const schemaFlag = argv.indexOf('--output-schema');
    const outputFlag = argv.indexOf('-o');
    assert.ok(schemaFlag >= 0 && outputFlag >= 0, `the spawned engine was given neither result flag: ${argv.join(' ')}`);
    assert.equal(argv[outputFlag + 1], join(home, outcome.result.sourcePath));
    assert.equal(argv[schemaFlag + 1], join(home, ENGINE_RESULT_DIRECTORY, ENGINE_RESULT_SCHEMA_FILE));
    assert.ok(argv.indexOf('--output-schema') < argv.indexOf('--'));
    assert.equal(argv[argv.length - 1], 'propose a plan');

    // The artifact really is where the event said it was, and really is inside the attempt home.
    assert.ok(outcome.result.sourcePath.startsWith(ENGINE_RESULT_DIRECTORY));
    assert.ok(existsSync(join(home, outcome.result.sourcePath)), 'the artifact is not where the event said it was');
    assert.equal(realpathSync(join(home, outcome.result.sourcePath)).startsWith(home), true);
    // Nothing landed in the workspace, which is what would make a read-only run look like a change.
    assert.deepEqual(readdirSync(workspace).sort(), ['state']);
  } finally {
    rmSync(engine.dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC2 a turn that completes without writing its result is a diagnostic, never an empty success', async () => {
  // The scripted engine emits a full successful stream and writes nothing, which is what a real
  // turn looks like when it does not honour the result channel.
  const engine = scriptedEngine(
    [
      `printf '%s\\n' '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}'`,
      `printf '%s\\n' '{"type":"turn.started"}'`,
      `printf '%s\\n' '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Here is the plan."}}'`,
      `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'`,
    ].join('\n'),
  );
  const workspace = tempDir();
  provisionTestCredential(join(workspace, 'state'), workspace);
  try {
    const adapter = new CodexEngineAdapter({
      connectorId: connectorId('connector_codex_noresult'),
      client: { binary: engine.binary, stateRoot: join(workspace, 'state') },
      sessionStartTimeoutMs: 15_000,
    });
    const context: AdapterContext = { ...adapterContext('op_codex_noresult'), signal: AbortSignal.timeout(30_000) };
    const started = await adapter.startSession(context, {
      operationId: operationId('op_codex_noresult'),
      workspace: { ...FIXTURE_WORKSPACE, absolutePath: workspace },
      start: { kind: 'Fresh', instruction: 'propose a plan' },
      mode: 'Headless',
      grantedCapabilities: ['Git:ReadRepository'],
      bounds: { activeWallClockMs: 20_000, retryBudget: 1, eventCountLimit: 64 },
      result: { schema: RESULT_SCHEMA },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const events = await collect(started.value.events);
    assert.equal(resultOutcomes(events).length, 0, 'a turn with no result was reported as a completion');
    const seen = events.filter((event): event is Extract<EngineEvent, { kind: 'Diagnostic' }> => event.kind === 'Diagnostic');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.category, 'MalformedOutput');
    assert.equal(seen[0]?.retry, 'Terminal');
    assert.match(seen[0]?.detail ?? '', /No structured result was written/);
    assert.equal(events.find((event) => event.kind === 'Usage')?.kind === 'Usage' ? usageKindOf(events) : null, 'Reported');
  } finally {
    rmSync(engine.dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC2 a session that asks for no result carries no result channel and behaves as before', async () => {
  const engine = scriptedResultEngine(longResultPayload());
  const workspace = tempDir();
  const stateRoot = join(workspace, 'state');
  provisionTestCredential(stateRoot, workspace);
  try {
    const adapter = new CodexEngineAdapter({
      connectorId: connectorId('connector_codex_plain'),
      client: { binary: engine.binary, stateRoot },
      sessionStartTimeoutMs: 15_000,
    });
    const context: AdapterContext = { ...adapterContext('op_codex_plain'), signal: AbortSignal.timeout(30_000) };
    const started = await adapter.startSession(context, {
      operationId: operationId('op_codex_plain'),
      workspace: { ...FIXTURE_WORKSPACE, absolutePath: workspace },
      start: { kind: 'Fresh', instruction: 'create probe.txt' },
      mode: 'Headless',
      grantedCapabilities: ['Git:ReadRepository'],
      bounds: { activeWallClockMs: 20_000, retryBudget: 1, eventCountLimit: 64 },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const events = await collect(started.value.events);
    const outcome = resultOutcomes(events)[0];
    assert.equal(outcome?.kind, 'Succeeded');
    assert.equal(outcome?.kind === 'Succeeded' ? outcome.result : undefined, undefined);
    // No results directory was created at all, so there is nothing that could later be read.
    assert.equal(existsSync(join(stateRoot, 'home')), true);
    assert.equal(existsSync(join(attemptLayout(workspace, stateRoot).home, ENGINE_RESULT_DIRECTORY)), false);
  } finally {
    rmSync(engine.dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* Error mapping, one case per diagnostic category                             */
/* -------------------------------------------------------------------------- */

test('F15-AC3, F18-AC1 every diagnostic category is reachable from observed engine wording', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['MalformedOutput', 'Codex output could not be parsed at line 4'],
    ['MissingAuthentication', 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header'],
    ['UnavailableModel', "The 'gpt-x' model is not supported when using Codex with a ChatGPT account."],
    ['QuotaExhausted', 'You have hit your usage limit. Upgrade to Pro to continue using Codex'],
    ['UnsupportedRuntime', 'shell snapshot sandbox cannot be enforced on this host'],
    ['ToolError', '/bin/bash -lc false exited with code 1'],
    ['NetworkError', 'Reconnecting... 2/5 (unexpected status 503)'],
    ['SandboxDenial', 'sandbox denied write access to /etc/passwd'],
  ];
  for (const [expected, detail] of cases) {
    assert.equal(classifyCodexFailure(detail), expected, `"${detail}" classified wrongly`);
  }
});

test('F15-AC3, F18-AC5 a 401 wrapped in a reconnect line stays an authentication failure', () => {
  // Observed: eleven `Reconnecting... N/5` lines each carrying a 401, then one turn.failed.
  const wrapped = 'Reconnecting... 5/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)';
  assert.equal(classifyCodexFailure(wrapped), 'MissingAuthentication');
  assert.equal(codexDiagnosticRetry('MissingAuthentication'), 'Terminal');
  assert.equal(codexDiagnosticRetry('UnavailableModel'), 'Terminal');
  assert.equal(codexDiagnosticRetry('QuotaExhausted'), 'Terminal');
  assert.equal(codexDiagnosticRetry('UnsupportedRuntime'), 'Terminal');
  assert.equal(codexDiagnosticRetry('SandboxDenial'), 'Terminal');
  assert.equal(codexDiagnosticRetry('MalformedOutput'), 'Terminal');
  assert.equal(codexDiagnosticRetry('NetworkError'), 'Retryable');
  assert.equal(codexDiagnosticRetry('ToolError'), 'Retryable');
});

test('F15-AC3 each blocker maps to a Blocked domain error naming its prerequisite and remedy', () => {
  const observed: readonly (readonly ['MissingAuthentication' | 'UnavailableModel' | 'QuotaExhausted' | 'UnsupportedRuntime', string])[] = [
    ['MissingAuthentication', 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header'],
    ['UnavailableModel', "The 'gpt-x' model is not supported when using Codex with a ChatGPT account."],
    ['QuotaExhausted', 'You have hit your usage limit. Upgrade to Pro to continue using Codex'],
    ['UnsupportedRuntime', 'shell snapshot sandbox cannot be enforced on this host'],
  ];
  for (const [category, detail] of observed) {
    assert.equal(isCodexBlocker(category), true);
    const error = mapCodexFailure({ detail, exitCode: 1, redact: passthrough });
    assert.equal(error.code, 'Blocked', `${category} did not block`);
    assert.equal(error.prerequisites.length, 1);
    assert.ok((error.prerequisites[0]?.remedy ?? '').length > 40, `${category} has no actionable remedy`);
    assert.match(error.reason, new RegExp(category));
  }
  for (const category of ['NetworkError', 'ToolError', 'MalformedOutput', 'SandboxDenial'] as const) {
    assert.equal(isCodexBlocker(category), false, `${category} must not be able to block`);
  }
});

test('F18-AC4 a quota blocker refuses to state a remaining balance or a cost', () => {
  const outcome = codexBlockedOutcome('QuotaExhausted', 'You have hit your usage limit.', passthrough);
  assert.equal(outcome.kind, 'Blocked');
  assert.match(outcome.kind === 'Blocked' ? outcome.remedy : '', /does not estimate remaining quota or cost/);
});

test('F18-AC5 a malformed stream is Unavailable and is not retried', () => {
  const error = mapCodexFailure({ detail: 'Codex output could not be parsed at line 2', exitCode: 0, redact: passthrough });
  assert.equal(error.code, 'Unavailable');
  assert.match(error.reason, /not retried/);
});

test('F03-AC5 a sandbox denial is Invalid with a field, not a blanket failure', () => {
  const error = mapCodexFailure({ detail: 'sandbox denied write access to /etc/passwd', exitCode: 1, redact: passthrough });
  assert.equal(error.code, 'Invalid');
  assert.equal(error.fields[0]?.path, 'workspace');
  assert.match(error.fields[0]?.message ?? '', /rather than the sandbox/);
});

test('N02-AC2 every mapped message passes through the caller redaction', () => {
  const secret = CREDENTIAL_CANARY;
  const mapped = mapCodexFailure({ detail: `upstream rejected ${secret}`, exitCode: 1, redact: redacting });
  assert.ok(!JSON.stringify(mapped).includes(secret), 'a credential-shaped string survived into a domain error');
  const probe = mapCodexVersionProbeFailure(`probe failed with ${secret}`, 1, redacting);
  assert.ok(!JSON.stringify(probe).includes(secret));
});

test('F15-AC4 only a missing rollout produces the checkpoint fallback', () => {
  const missing = mapCodexFailure({
    detail: 'Error: thread/resume: thread/resume failed: no rollout found for thread id 00000000-0000-4000-8000-000000000000 (code -32600)',
    exitCode: 1,
    redact: passthrough,
  });
  assert.match(missingRolloutDetail(missing) ?? '', /fresh session was started from the checkpoint/);
  for (const detail of ['unexpected status 401 Unauthorized', 'unexpected status 429 Too Many Requests', 'spawn codex ENOENT']) {
    const other = mapCodexFailure({ detail, exitCode: 1, redact: passthrough });
    assert.equal(missingRolloutDetail(other), null, `"${detail}" was mistaken for a missing rollout`);
  }
});

/* -------------------------------------------------------------------------- */
/* F15-AC1 / F15-AC2: a full session against a scripted engine                 */
/* -------------------------------------------------------------------------- */

/** The captured successful stream, emitted by the scripted engine verbatim. */
const SCRIPTED_SUCCESS_BODY = [
  `printf '%s\\n' '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}'`,
  `printf '%s\\n' '{"type":"turn.started"}'`,
  `printf '%s\\n' '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will create probe.txt."}}'`,
  `printf '%s\\n' '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"printf HELLO > probe.txt","aggregated_output":"HELLO","exit_code":0,"status":"completed"}}'`,
  `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":29370,"cached_input_tokens":14080,"cache_write_input_tokens":0,"output_tokens":244,"reasoning_output_tokens":124}}'`,
].join('\n');

test('F15-AC1, F15-AC2 a scripted turn yields the real thread id, a Succeeded result and reported usage', async () => {
  const engine = scriptedEngine(SCRIPTED_SUCCESS_BODY);
  const workspace = tempDir();
  try {
    const adapter = new CodexEngineAdapter({
      connectorId: connectorId('connector_codex_scripted'),
      client: { binary: engine.binary },
      sessionStartTimeoutMs: 15_000,
    });
    const context: AdapterContext = { ...adapterContext('op_codex_scripted'), signal: AbortSignal.timeout(30_000) };
    const started = await adapter.startSession(context, {
      operationId: operationId('op_codex_scripted'),
      workspace: { ...FIXTURE_WORKSPACE, absolutePath: workspace },
      start: { kind: 'Fresh', instruction: 'create probe.txt' },
      mode: 'Headless',
      grantedCapabilities: ['Git:ReadRepository', 'Engine:ReportUsage'],
      bounds: { activeWallClockMs: 20_000, retryBudget: 1, eventCountLimit: 64 },
    });
    assert.equal(started.ok, true, started.ok === false ? started.error.reason : '');
    if (!started.ok) return;
    assert.equal(started.value.sessionId, '01a0f699-7149-7d20-831e-98f7b7b43a71');
    assert.equal(started.value.engineVersion, CODEX_VERIFIED_VERSION);
    assert.equal(started.value.workspace.absolutePath, workspace);

    const events = await collect(started.value.events);
    const outcomes = resultOutcomes(events);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.kind, 'Succeeded');
    const usage = events.find((event) => event.kind === 'Usage');
    assert.equal(usage?.kind === 'Usage' ? usage.usage.kind : null, 'Reported');
    assert.equal(usage?.kind === 'Usage' && usage.usage.kind === 'Reported' ? usage.usage.usage.inputTokens : null, 29370);
  } finally {
    rmSync(engine.dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC2 a malformed line in a live stream suppresses the completion it precedes', async () => {
  const engine = scriptedEngine(
    [
      `printf '%s\\n' '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}'`,
      `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'`,
      `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tok'`,
    ].join('\n'),
  );
  const workspace = tempDir();
  try {
    const adapter = new CodexEngineAdapter({
      connectorId: connectorId('connector_codex_malformed'),
      client: { binary: engine.binary },
      sessionStartTimeoutMs: 15_000,
    });
    const context: AdapterContext = { ...adapterContext('op_codex_malformed'), signal: AbortSignal.timeout(30_000) };
    const started = await adapter.startSession(context, {
      operationId: operationId('op_codex_malformed'),
      workspace: { ...FIXTURE_WORKSPACE, absolutePath: workspace },
      start: { kind: 'Fresh', instruction: 'do a thing' },
      mode: 'Headless',
      grantedCapabilities: ['Git:ReadRepository'],
      bounds: { activeWallClockMs: 20_000, retryBudget: 1, eventCountLimit: 64 },
    });
    assert.equal(started.ok, true, started.ok === false ? started.error.reason : '');
    if (!started.ok) return;

    const events = await collect(started.value.events);
    assert.equal(resultOutcomes(events).length, 0, 'a malformed line still produced a completion');
    const diagnostics = events.filter((event): event is Extract<EngineEvent, { kind: 'Diagnostic' }> => event.kind === 'Diagnostic');
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.category, 'MalformedOutput');
    assert.equal(diagnostics[0]?.retry, 'Terminal');
    const usage = events.find((event) => event.kind === 'Usage');
    assert.equal(usage?.kind === 'Usage' ? usage.usage.kind : null, 'Unknown');
  } finally {
    rmSync(engine.dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC3 a scripted authentication failure arrives as a Blocked result, and the workspace survives', async () => {
  const engine = scriptedEngine(
    [
      `printf '%s\\n' '{"type":"thread.started","thread_id":"01a0f69b-0aed-7af2-a76d-e7bb9ed8b969"}'`,
      `printf '%s\\n' '{"type":"turn.started"}'`,
      `printf '%s\\n' '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)"}'`,
      `printf '%s\\n' '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"}}'`,
      'exit 1',
    ].join('\n'),
  );
  const workspace = tempDir();
  try {
    writeFileSync(join(workspace, 'kept.txt'), 'intact', 'utf8');
    const adapter = new CodexEngineAdapter({
      connectorId: connectorId('connector_codex_blocked'),
      client: { binary: engine.binary },
      sessionStartTimeoutMs: 15_000,
    });
    const context: AdapterContext = { ...adapterContext('op_codex_blocked'), signal: AbortSignal.timeout(30_000) };
    const started = await adapter.startSession(context, {
      operationId: operationId('op_codex_blocked'),
      workspace: { ...FIXTURE_WORKSPACE, absolutePath: workspace },
      start: { kind: 'Fresh', instruction: 'do a thing' },
      mode: 'Headless',
      grantedCapabilities: ['Git:ReadRepository'],
      bounds: { activeWallClockMs: 20_000, retryBudget: 1, eventCountLimit: 64 },
    });
    assert.equal(started.ok, true, started.ok === false ? started.error.reason : '');
    if (!started.ok) return;

    const events = await collect(started.value.events);
    const outcome = resultOutcomes(events)[0];
    assert.equal(outcome?.kind, 'Blocked');
    assert.equal(outcome?.kind === 'Blocked' ? outcome.category : null, 'MissingAuthentication');
    assert.match(outcome?.kind === 'Blocked' ? outcome.remedy : '', /codex login/);
    // F15-AC3: the workspace is preserved.
    assert.equal(execFileSync('cat', [join(workspace, 'kept.txt')], { encoding: 'utf8' }), 'intact');
    const usage = events.find((event) => event.kind === 'Usage');
    assert.equal(usage?.kind === 'Usage' ? usage.usage.kind : null, 'Unknown');
  } finally {
    rmSync(engine.dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC2 a stream that stops without a turn outcome is reported, not completed', async () => {
  const engine = scriptedEngine(
    [`printf '%s\\n' '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}'`, `printf '%s\\n' '{"type":"turn.started"}'`].join('\n'),
  );
  const workspace = tempDir();
  try {
    const adapter = new CodexEngineAdapter({
      connectorId: connectorId('connector_codex_truncated'),
      client: { binary: engine.binary },
      sessionStartTimeoutMs: 15_000,
    });
    const context: AdapterContext = { ...adapterContext('op_codex_truncated'), signal: AbortSignal.timeout(30_000) };
    const started = await adapter.startSession(context, {
      operationId: operationId('op_codex_truncated'),
      workspace: { ...FIXTURE_WORKSPACE, absolutePath: workspace },
      start: { kind: 'Fresh', instruction: 'do a thing' },
      mode: 'Headless',
      grantedCapabilities: ['Git:ReadRepository'],
      bounds: { activeWallClockMs: 20_000, retryBudget: 1, eventCountLimit: 64 },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const events = await collect(started.value.events);
    assert.equal(resultOutcomes(events).length, 0);
    const diagnostics = events.filter((event) => event.kind === 'Diagnostic');
    assert.equal(diagnostics[0]?.category, 'MalformedOutput');
    assert.match(diagnostics[0]?.detail ?? '', /no turn outcome/);
  } finally {
    rmSync(engine.dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F18-AC2 the wall-clock bound ends the run as Incomplete rather than waiting forever', async () => {
  const engine = scriptedEngine(
    [`printf '%s\\n' '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}'`, `printf '%s\\n' '{"type":"turn.started"}'`, 'sleep 60'].join('\n'),
  );
  const workspace = tempDir();
  try {
    const adapter = new CodexEngineAdapter({
      connectorId: connectorId('connector_codex_budget'),
      client: { binary: engine.binary, gracefulStopMs: 2_000, killWaitMs: 2_000 },
      sessionStartTimeoutMs: 15_000,
    });
    const context: AdapterContext = { ...adapterContext('op_codex_budget'), signal: AbortSignal.timeout(30_000) };
    const started = await adapter.startSession(context, {
      operationId: operationId('op_codex_budget'),
      workspace: { ...FIXTURE_WORKSPACE, absolutePath: workspace },
      start: { kind: 'Fresh', instruction: 'do a thing' },
      mode: 'Headless',
      grantedCapabilities: ['Git:ReadRepository'],
      bounds: { activeWallClockMs: 1_000, retryBudget: 1, eventCountLimit: 64 },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const events = await collect(started.value.events);
    const outcome = resultOutcomes(events)[0];
    assert.equal(outcome?.kind, 'Incomplete');
    assert.equal(outcome?.kind === 'Incomplete' ? outcome.reason : null, 'BudgetExhausted');
  } finally {
    rmSync(engine.dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* F17-AC1 / F17-AC5: the process group                                        */
/* -------------------------------------------------------------------------- */

test('F17-AC1, F17-AC5 a stop reaps the whole spawned process group, SIGTERM-ignoring grandchildren included', async () => {
  // The engine ignores SIGTERM and leaves a child that also ignores it, so only a SIGKILL to the
  // tracked group can clear it. If the adapter signalled the process by name, or signalled only the
  // direct child, this assertion would fail.
  const engine = scriptedEngine(
    [
      "trap '' TERM",
      `printf '%s\\n' '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}'`,
      `printf '%s\\n' '{"type":"turn.started"}'`,
      "sh -c \"trap '' TERM; sleep 120\" &",
      'sleep 120',
    ].join('\n'),
  );
  const workspace = tempDir();
  try {
    const adapter = new CodexEngineAdapter({
      connectorId: connectorId('connector_codex_stop'),
      client: { binary: engine.binary, gracefulStopMs: 700, killWaitMs: 5_000 },
      sessionStartTimeoutMs: 15_000,
    });
    const context: AdapterContext = { ...adapterContext('op_codex_stop'), signal: AbortSignal.timeout(40_000) };
    const started = await adapter.startSession(context, {
      operationId: operationId('op_codex_stop'),
      workspace: { ...FIXTURE_WORKSPACE, absolutePath: workspace },
      start: { kind: 'Fresh', instruction: 'do a thing' },
      mode: 'Headless',
      grantedCapabilities: ['Git:ReadRepository'],
      bounds: { activeWallClockMs: 30_000, retryBudget: 1, eventCountLimit: 64 },
    });
    assert.equal(started.ok, true, started.ok === false ? started.error.reason : '');
    if (!started.ok) return;

    // The engine and the grandchild it left must both be in the group before the stop, otherwise a
    // later zero would prove nothing about escalation.
    const pgid = groupIdOfCommandContaining(engine.binary);
    assert.notEqual(pgid, null, 'the scripted engine never started');
    assert.ok(pgid !== null);
    assert.equal(await waitFor(() => processesInGroup(pgid ?? -1).length >= 2, 15_000), true, 'the grandchild never joined the tracked group');

    const stopped = await adapter.stopSession(context, {
      operationId: operationId('op_codex_stop_stop'),
      sessionId: started.value.sessionId,
      reason: 'PauseRequested',
    });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.ok === true ? stopped.value.kind : null, 'Stopped');
    // Codex holds no checkpoint and cannot read a dirty inventory, so none is invented.
    assert.equal(stopped.ok === true && stopped.value.kind === 'Stopped' ? stopped.value.checkpoint : 'unset', null);
    assert.deepEqual(processesInGroup(pgid ?? -1), [], 'a descendant survived the stop of the tracked group');
  } finally {
    rmSync(engine.dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F17-AC1, F17-AC5 a stop is refused for an untracked session and never searches by name', async () => {
  const adapter = new CodexEngineAdapter({ connectorId: connectorId('connector_codex_refuse'), client: { binary: '/nonexistent/codex' } });
  const refused = await adapter.stopSession(adapterContext('op_codex_refuse'), {
    operationId: operationId('op_codex_refuse'),
    sessionId: providerId('01a0f699-7149-7d20-831e-98f7b7b43a71'),
    reason: 'CancelRequested',
  });
  assert.equal(refused.ok, true);
  assert.equal(refused.ok === true ? refused.value.kind : null, 'StopRefused');
  const detail = refused.ok === true && refused.value.kind === 'StopRefused' ? refused.value.detail : '';
  assert.match(detail, /by name/);
  assert.match(detail, /F17-AC5/);
});

test('F17-AC1 the tracked group is reported gone only after it is observed gone', async () => {
  const workspace = tempDir();
  const tracked = spawnTrackedGroup(
    [process.execPath, '-e', 'const {spawn}=require("node:child_process");spawn(process.execPath,["-e","process.on(\'SIGTERM\',()=>{});setTimeout(()=>{},600000)"],{stdio:"ignore"});process.on(\'SIGTERM\',()=>{});setTimeout(()=>{},600000)'],
    workspace,
    childEnvironment(workspace),
  );
  try {
    assert.equal(tracked.ok, true);
    if (!tracked.ok) return;
    const target: CodexProcess = tracked.value;
    const pgid = target.processGroupId;
    assert.equal(pgid, target.pid, 'the tracked process group must be the child itself');

    // Parent and grandchild are both present and both ignore SIGTERM.
    assert.equal(await waitFor(() => processesInGroup(pgid).length >= 2, 10_000), true, 'the grandchild never joined the tracked group');

    const report = await stopCodexProcess(target, { gracefulStopMs: 500, killWaitMs: 5_000 });
    assert.equal(report.graceful, false, 'a SIGTERM-ignoring group must not report a graceful stop');
    assert.equal(report.escalated, true);
    assert.equal(report.stopped, true);
    assert.equal(report.survivors, false);
    assert.deepEqual(processesInGroup(pgid), [], 'a descendant survived the kill of the tracked group');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F17-AC1 a group that answers SIGTERM is reported as a graceful stop with no escalation', async () => {
  const workspace = tempDir();
  const tracked = spawnTrackedGroup(
    [process.execPath, '-e', 'process.on("SIGTERM",()=>process.exit(0));setTimeout(()=>{},600000)'],
    workspace,
    childEnvironment(workspace),
  );
  try {
    assert.equal(tracked.ok, true);
    if (!tracked.ok) return;
    const report = await stopCodexProcess(tracked.value, { gracefulStopMs: 5_000, killWaitMs: 2_000 });
    assert.equal(report.graceful, true);
    assert.equal(report.escalated, false);
    assert.equal(report.stopped, true);
    assert.equal(report.survivors, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC1 the transport reads a real subprocess stdout in order and ends when it closes', async () => {
  const workspace = tempDir();
  const tracked = spawnTrackedGroup(
    [process.execPath, '-e', 'process.stdout.write("one\\ntwo\\nthree\\n");setTimeout(()=>{},50)'],
    workspace,
    childEnvironment(workspace),
  );
  try {
    assert.equal(tracked.ok, true);
    if (!tracked.ok) return;
    const lines: string[] = [];
    for await (const line of tracked.value.lines()) lines.push(line);
    assert.deepEqual(lines, ['one', 'two', 'three']);
    const exit = await tracked.value.waited();
    assert.equal(exit.exitCode, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* F17-AC2: the continuation prompt                                            */
/* -------------------------------------------------------------------------- */

test('F17-AC2 a continued run is given the checkpoint state and told it is authoritative', () => {
  const prompt = renderPrompt(
    {
      kind: 'FromCheckpoint',
      instruction: 'finish the migration',
      checkpoint: {
        checkpointId: 'checkpoint_01',
        capturedAt: '2026-10-01T08:00:00.000Z',
        scopeFingerprint: FIXTURE_WORKSPACE.scopeFingerprint,
        headSha: FIXTURE_WORKSPACE.headSha,
        baseSha: FIXTURE_WORKSPACE.baseSha,
        dirtyPaths: ['src/a.ts'],
        untrackedPaths: [],
        blocker: 'the owner must choose a database',
        nextAction: 'apply the chosen migration',
        resumeInstructions: 'do not widen the scope',
      },
    },
    passthrough,
  );
  assert.match(prompt, /no memory of the interrupted attempt/);
  assert.match(prompt, /checkpoint_01/);
  assert.match(prompt, /dirty paths: src\/a\.ts/);
  assert.match(prompt, /untracked paths: none/);
  assert.match(prompt, /blocker: the owner must choose a database/);
  assert.match(prompt, /next action: apply the chosen migration/);
  assert.match(prompt, /Instruction for this attempt:\nfinish the migration/);
});

test('F17-AC2 a large checkpoint inventory is bounded rather than pasted whole', () => {
  const prompt = renderPrompt(
    {
      kind: 'FromCheckpoint',
      instruction: 'continue',
      checkpoint: {
        checkpointId: 'checkpoint_02',
        capturedAt: '2026-10-01T08:00:00.000Z',
        scopeFingerprint: FIXTURE_WORKSPACE.scopeFingerprint,
        headSha: FIXTURE_WORKSPACE.headSha,
        baseSha: FIXTURE_WORKSPACE.baseSha,
        dirtyPaths: Array.from({ length: 250 }, (_, index) => `src/file-${String(index)}.ts`),
        untrackedPaths: [],
        blocker: null,
        nextAction: 'keep going',
        resumeInstructions: 'stay in scope',
      },
    },
    passthrough,
  );
  assert.match(prompt, /and 150 more/);
  assert.ok(prompt.length < 20_000);
  assert.match(prompt, /blocker: none recorded/);
});

test('F15-AC2 a fresh start carries the instruction alone, with no checkpoint preamble', () => {
  assert.equal(renderPrompt({ kind: 'Fresh', instruction: 'create probe.txt' }, passthrough), 'create probe.txt');
});

/* -------------------------------------------------------------------------- */
/* Capabilities                                                                */
/* -------------------------------------------------------------------------- */

test('F03-AC2 the engine declarations name what Codex offers and what it cannot do', () => {
  const adapter = new CodexEngineAdapter({ connectorId: connectorId('connector_codex_caps'), client: { binary: '/nonexistent/codex' } });
  const declared = adapter.capabilities();
  assert.equal(declared.kind, 'Engine');
  assert.deepEqual(
    declared.declarations.map((entry) => entry.kind).sort(),
    ['Engine:ReportUsage', 'Engine:ResumeSession', 'Engine:StartScoped', 'Engine:StopGraceful', 'Engine:VersionCheck'],
  );
  assert.ok(declared.declarations.every((entry) => entry.privileged === false));
  assert.ok(declared.declarations.every((entry) => entry.supportsPrecondition === false));
  const resume = declared.declarations.find((entry) => entry.kind === 'Engine:ResumeSession');
  assert.equal(resume?.supported, true);
  assert.match(resume?.limitation ?? '', /sandbox_mode/);
  const usage = declared.declarations.find((entry) => entry.kind === 'Engine:ReportUsage');
  assert.match(usage?.limitation ?? '', /Unknown/);
  const stop = declared.declarations.find((entry) => entry.kind === 'Engine:StopGraceful');
  assert.match(stop?.limitation ?? '', /Detached, never Stopped/);
});

/* -------------------------------------------------------------------------- */
/* Opt-in live exercise                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A bounded live run against the real `codex` binary.
 *
 * Opt-in because it spends the account's quota and needs an authenticated Codex. It is bounded to
 * one small file creation inside a throwaway Git workspace, asserts the file exists afterwards,
 * and asserts the stream parsed a real session id, a terminal outcome and reported usage. The skip
 * reason names the missing prerequisite rather than hiding behind a boolean.
 */
test('F15-AC1, F15-AC4 a live Codex turn reports its real thread id, writes one file, and terminates', async (t) => {
  if (process.env['SHIPLOOP_CODEX_LIVE'] !== '1') {
    t.skip('no SHIPLOOP_CODEX_LIVE=1; the live pass needs an authenticated codex on PATH and spends account quota');
    return;
  }

  const workspace = tempDir();
  // The operator's own Codex login, digested before and after a real turn. This is the whole
  // collision this adapter stopped causing: a ChatGPT login is a rotating refresh token, and the
  // defect was copying it into the engine state so the engine and the operator became two writers
  // of one credential. A live session must leave this file byte-identical (F15-AC5).
  const operatorLogin = operatorCodexLoginPath();
  const operatorDigestBefore = operatorLogin === null ? null : digestOf(operatorLogin);
  try {
    execFileSync('git', ['init', '-q', '.'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'probe@example.invalid'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'probe'], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: workspace });
    // Read after the commit. Reading it before produced `ambiguous argument 'HEAD'` on an empty
    // repository, so this live test could never pass on its own workspace.
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const adapter = new CodexEngineAdapter({
      connectorId: connectorId('connector_codex_live'),
      client: { binary: 'codex', gracefulStopMs: 5_000, killWaitMs: 5_000 },
      sandbox: 'workspace-write',
    });
    const context: AdapterContext = { ...adapterContext('op_codex_live'), signal: AbortSignal.timeout(600_000) };

    // What a compatibility check actually promises is that the binary is at or above the declared
    // floor. Asserting that it reports *exactly* the pinned constant made this test fail on a host
    // running a newer Codex, which is the one case the check is supposed to accept.
    const compatibility = await adapter.checkCompatibility(context);
    assert.equal(compatibility.ok, true);
    assert.equal(compatibility.ok === true ? compatibility.value.compatible : false, true);
    const observed = compatibility.ok === true ? compatibility.value.runtimeVersion : null;
    assert.ok(observed !== null);
    assert.equal(checkCodexVersion(observed ?? '').compatible, true);
    assert.match(compatibility.ok === true ? compatibility.value.detail : '', new RegExp(MINIMUM_CODEX_VERSION.replace(/\./g, '\\.')));

    const started = await adapter.startSession(context, {
      operationId: operationId('op_codex_live'),
      workspace: { ...FIXTURE_WORKSPACE, absolutePath: workspace, headSha: baseSha as never, baseSha: baseSha as never },
      start: { kind: 'Fresh', instruction: 'create a file named probe.txt containing exactly HELLO and nothing else' },
      mode: 'Headless',
      grantedCapabilities: ['Git:ReadRepository', 'Engine:ReportUsage'],
      bounds: { activeWallClockMs: 600_000, retryBudget: 1, eventCountLimit: 512 },
    });
    assert.equal(started.ok, true, started.ok === false ? started.error.reason : '');
    if (!started.ok) return;
    assert.match(started.value.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const events = await collect(started.value.events);
    assert.equal(execFileSync('cat', [join(workspace, 'probe.txt')], { encoding: 'utf8' }), 'HELLO');
    const outcomes = resultOutcomes(events);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.kind, 'Succeeded');
    const usage = events.find((event) => event.kind === 'Usage');
    assert.equal(usage?.kind === 'Usage' ? usage.usage.kind : null, 'Reported');
    assert.ok((usage?.kind === 'Usage' && usage.usage.kind === 'Reported' ? usage.usage.usage.inputTokens ?? 0 : 0) > 0);

    if (operatorLogin !== null && operatorDigestBefore !== null) {
      assert.ok(existsSync(operatorLogin), 'the operator login vanished during a live session');
      assert.equal(digestOf(operatorLogin), operatorDigestBefore, `the operator's ${operatorLogin} was modified by a live Codex session`);
      t.diagnostic(`operator login ${operatorLogin} byte-identical across a live turn: ${operatorDigestBefore}`);
    } else {
      t.diagnostic('no operator login found to digest; the untouched-operator claim is not exercised by this run');
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/**
 * Where the operator keeps their own Codex login, resolved the way `codex login` resolves it.
 *
 * Read only so it can be digested; nothing in the shipped adapter opens this path, and that is the
 * property this helper exists to make observable. It is exported from no module and used by no
 * production path, because a helper that could find the operator's credential is one refactor away
 * from being used.
 */
function operatorCodexLoginPath(parent: NodeJS.ProcessEnv = process.env): string | null {
  const configured = parent['CODEX_HOME'];
  const codexHome = typeof configured === 'string' && configured.length > 0 ? configured : join(homedir(), '.codex');
  const path = join(codexHome, ENGINE_CREDENTIAL_FILE);
  return existsSync(path) ? path : null;
}

/** A SHA-256 of a file's bytes, which is what "byte-identical" has to mean. */
function digestOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The live structured-result pass. Opt-in, and it is the only proof in this file that the result
 * channel survives a **real** Codex turn rather than a script that was written to cooperate.
 *
 * It spends one engine turn, and it asks for something a real plan proposal is made of: several
 * outcomes, one task, and prose long enough that the payload cannot possibly fit inside
 * `MAX_SUMMARY_CHARS`. The assertions are the two halves of the claim — the payload arrives whole,
 * and every summary stays capped — plus the confinement of the artifact it came from. The run
 * reports its own evidence through `t.diagnostic` so the proof is in the test output rather than in
 * a claim about it.
 *
 * Gated on its own variable so this can be exercised without also spending the two live turns the
 * other opt-in tests make.
 */test('F15-AC2 a live Codex turn delivers a structured result longer than the summary cap, whole', async (t) => {
  if (process.env['SHIPLOOP_CODEX_LIVE'] !== '1' || process.env['SHIPLOOP_CODEX_LIVE_RESULT'] !== '1') {
    t.skip(
      'no SHIPLOOP_CODEX_LIVE=1 with SHIPLOOP_CODEX_LIVE_RESULT=1; the live result pass needs an authenticated codex on PATH and spends one account turn',
    );
    return;
  }

  // Every live pass cleans up in a `finally`, not at the end of the body: a failing assertion
  // would otherwise leave a throwaway Git workspace behind, which is what happened when this
  // test first failed on its own schema.
  const workspace = tempDir();
  try {
    const workspace = tempDir();
    execFileSync('git', ['init', '-q', '.'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'probe@example.invalid'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'probe'], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: workspace });
    const stateRoot = join(workspace, 'shiploop-state');

    const adapter = new CodexEngineAdapter({
      connectorId: connectorId('connector_codex_live_result'),
      client: { binary: 'codex', stateRoot, gracefulStopMs: 5_000, killWaitMs: 5_000 },
      // Read-only, because that is what a plan-mode session holds. The artifact still appears: the CLI
      // process writes it rather than a sandboxed command, which is what makes the channel usable for
      // the read-only sessions that need a structured answer most.
      sandbox: 'read-only',
    });
    const context: AdapterContext = { ...adapterContext('op_codex_live_result'), signal: AbortSignal.timeout(600_000) };

    // The version the binary actually reports, so the evidence below names the engine that produced
    // it rather than the constant this adapter was measured against.
    const compatibility = await adapter.checkCompatibility(context);
    assert.equal(compatibility.ok, true);
    assert.equal(compatibility.ok === true ? compatibility.value.compatible : false, true);
    const runtimeVersion = compatibility.ok === true ? compatibility.value.runtimeVersion : 'unknown';
    t.diagnostic(`codex --version reported ${String(runtimeVersion)}; this adapter's verified constant is ${CODEX_VERIFIED_VERSION}`);

    const started = await adapter.startSession(context, {
      operationId: operationId('op_codex_live_result'),
      workspace: { ...FIXTURE_WORKSPACE, absolutePath: workspace },
      start: {
        kind: 'Fresh',
        instruction: [
          'ShipLoop plan mode. Read only: do not change the repository, publish anything, or run a delivery action.',
          'Answer with exactly one JSON object matching the required output schema, and no prose.',
          '',
          'brief: brief_live_result_001 (version 1)',
          'requested outcomes, copied verbatim:',
          '- brief.desiredOutcome: The reader can resume an interrupted attempt without re-reading the whole transcript.',
          '- AC-1: A pause records a checkpoint within two seconds of the pause request.',
          '',
          'Propose exactly one task, taskId "T-1", covering both outcomes, and no exclusions.',
          'Give `outcome`, `scope`, `verificationMethod`, each acceptance criterion and each relevantProjectContext',
          'entry a full sentence of at least 30 words, and give implementationLocation.basis a full sentence.',
          'Set draftedAt to "2026-10-02T00:00:00.000Z". Do not read the repository.',
        ].join('\n'),
      },
      mode: 'Headless',
      grantedCapabilities: ['Git:ReadRepository', 'Engine:ReportUsage'],
      bounds: { activeWallClockMs: 600_000, retryBudget: 1, eventCountLimit: 512 },
      result: { schema: RESULT_SCHEMA },
    });
    assert.equal(started.ok, true, started.ok === false ? started.error.reason : '');
    if (!started.ok) return;

    const events = await collect(started.value.events);
    const outcome = resultOutcomes(events)[0];
    assert.equal(outcome?.kind, 'Succeeded', outcome === undefined ? 'no terminal outcome' : JSON.stringify(outcome));
    assert.ok(outcome?.kind === 'Succeeded' && outcome.result !== undefined, 'the live turn produced no structured result');
    if (outcome?.kind !== 'Succeeded' || outcome.result === undefined) return;
    const result = outcome.result;

    const decoded = JSON.parse(result.json) as { tasks?: readonly { acceptanceCriteria?: readonly string[] }[] };
    const criteria = decoded.tasks?.[0]?.acceptanceCriteria ?? [];
    const longestField = Math.max(
      ...Object.values(decoded.tasks?.[0] ?? {}).map((value) => JSON.stringify(value ?? '').length),
      0,
    );

    // The claim this pass exists for: a payload far longer than the summary cap arrived whole.
    assert.ok(result.byteLength > 400, `the live payload was ${String(result.byteLength)} bytes, not longer than the cap`);
    assert.ok(result.json.length > 400, `the live payload was ${String(result.json.length)} characters`);
    assert.ok(longestField > 400, `no single field exceeded the cap, so truncation anywhere would have gone unnoticed: ${String(longestField)}`);
    assert.ok(criteria.length >= 1, 'the live payload carried no acceptance criteria to have survived');

    // And the bounded channel stayed bounded, visibly cut, and separate from the result.
    assert.ok(outcome.summary.length <= 412, `the terminal summary grew past the cap: ${String(outcome.summary.length)}`);
    assert.match(outcome.summary, /\[truncated\]$/);
    for (const event of events) {
      if (event.kind !== 'Progress') continue;
      assert.ok(event.summary.length <= 412, `a progress summary grew past the cap: ${String(event.summary.length)}`);
      assert.ok(!event.summary.includes('acceptanceCriteria'), 'a progress summary carried the payload');
    }

    // The artifact is real, and confined to the attempt's own directory.
    const home = realpathSync(attemptLayout(workspace, stateRoot).home);
    const artifact = join(home, result.sourcePath);
    assert.ok(result.sourcePath.startsWith(ENGINE_RESULT_DIRECTORY));
    assert.ok(existsSync(artifact), `no artifact at ${String(artifact)}`);
    assert.equal(realpathSync(artifact).startsWith(home), true);
    assert.equal(statSync(artifact).size, result.byteLength);
    // Nothing landed in the workspace, so a read-only planning turn does not look like a change.
    assert.deepEqual(readdirSync(workspace).sort(), ['.git', 'shiploop-state']);

    const usage = events.find((event) => event.kind === 'Usage');
    assert.equal(usage?.kind === 'Usage' ? usage.usage.kind : null, 'Reported');

    t.diagnostic(`codex ${String(runtimeVersion)} thread ${started.value.sessionId}, sandbox read-only`);
    t.diagnostic(`result.sourcePath (relative to the attempt home): ${result.sourcePath}`);
    t.diagnostic(`result.byteLength: ${String(result.byteLength)}; result.json.length: ${String(result.json.length)}`);
    t.diagnostic(`longest single field in the payload: ${String(longestField)} characters`);
    t.diagnostic(`acceptance criteria that survived: ${String(criteria.length)}`);
    t.diagnostic(`terminal Succeeded.summary.length: ${String(outcome.summary.length)} (capped; ends "[truncated]")`);
    t.diagnostic(`payload head: ${result.json.slice(0, 240)}`);
    t.diagnostic(`payload tail: ${result.json.slice(-160)}`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('F15-AC4 a live resume continues the recorded conversation in place', async (t) => {
  const prior = process.env['SHIPLOOP_CODEX_LIVE_THREAD'];
  if (process.env['SHIPLOOP_CODEX_LIVE'] !== '1' || prior === undefined || prior.length === 0) {
    t.skip('no SHIPLOOP_CODEX_LIVE=1 with SHIPLOOP_CODEX_LIVE_THREAD; name a recorded Codex thread id to continue');
    return;
  }
  const workspace = tempDir();
  execFileSync('git', ['init', '-q', '.'], { cwd: workspace });
    const adapter = new CodexEngineAdapter({
      connectorId: connectorId('connector_codex_live_resume'),
      client: { binary: 'codex', gracefulStopMs: 5_000, killWaitMs: 5_000 },
      sandbox: 'read-only',
    });
    const context: AdapterContext = { ...adapterContext('op_codex_live_resume'), signal: AbortSignal.timeout(600_000) };
    const request: ResumeEngineSessionRequest = {
      operationId: operationId('op_codex_live_resume'),
      workspace: { ...FIXTURE_WORKSPACE, absolutePath: workspace },
      priorSession: { sessionId: providerId(prior), engineVersion: CODEX_VERIFIED_VERSION, lastEventAt: '2026-10-01T08:34:07.000Z' },
      checkpoint: {
        checkpointId: 'checkpoint_live',
        capturedAt: '2026-10-01T08:34:07.000Z',
        scopeFingerprint: FIXTURE_WORKSPACE.scopeFingerprint,
        headSha: FIXTURE_WORKSPACE.headSha,
        baseSha: FIXTURE_WORKSPACE.baseSha,
        dirtyPaths: [],
        untrackedPaths: [],
        blocker: null,
        nextAction: 'continue',
        resumeInstructions: 'stay in scope',
      },
      instruction: 'state the filename you created earlier in this conversation, without running any tool',
      grantedCapabilities: ['Git:ReadRepository'],
      bounds: { activeWallClockMs: 600_000, retryBudget: 1, eventCountLimit: 256 },
    };
    const continuation = await adapter.resumeSession(context, request);
    assert.equal(continuation.ok, true);
    assert.equal(continuation.ok === true ? continuation.value.kind : null, 'ResumedInPlace');
    if (continuation.ok && continuation.value.kind === 'ResumedInPlace') {
      assert.equal(continuation.value.session.sessionId, prior);
      const events = await collect(continuation.value.session.events);
      assert.ok(events.some((event) => event.kind === 'SessionStarted'));
    }
    rmSync(workspace, { recursive: true, force: true });
  });

/* -------------------------------------------------------------------------- */
/* The engine environment is an allowlist (F03-AC5, N02-AC3)                   */
/* -------------------------------------------------------------------------- */

/**
 * Variables the child is not allowed to have, whatever they look like.
 *
 * `DATABASE_URL` is here because it points at the authoritative store rather than at a
 * credential: a read of it is a read of the whole product's state, and a write through it is a
 * write to every candidate. The pointer variables are here for the other reason — each names a
 * *file* the engine would read a credential out of, which no amount of variable scrubbing
 * addresses.
 */
const FORBIDDEN_IN_CHILD = [
  'DATABASE_URL',
  'NETRC',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_SSH_COMMAND',
  'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME',
  'AWS_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'LINEAR_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  // A name no denylist of credentials contains and no human would guess from the word "token".
  'SHIPLOOP_SIDE_CHANNEL',
  'ZSH_THEME_HINTS',
] as const;

/**
 * A child that reports what it was actually handed.
 *
 * One `env` dump rather than one probe per variable name: `env -0` separates entries with a NUL,
 * so a name that never existed in the parent cannot be confused with one the parent held empty,
 * and a single spawn proves the whole allowlist instead of one name per test run.
 */
function envReportingProbe(dir: string): string {
  const probe = join(dir, 'env-report.sh');
  writeFileSync(
    probe,
    [
      '#!/bin/sh',
      // `env -0` separates entries with a NUL, so a name that never existed in the parent cannot
      // be confused with one the parent held empty; the markers are emitted in the same shape so
      // one parse reads the whole report.
      'if env -0 2>/dev/null; then :; else env; fi',
      'printf "HOME_IS=%s\\n" "$HOME"',
      'printf "CODEX_HOME_IS=%s\\n" "${CODEX_HOME:-unset}"',
      'printf "PATH_SET=%s\\n" "${PATH:+yes}"',
    ].join('\n'),
    'utf8',
  );
  chmodSync(probe, 0o755);
  return probe;
}

/** Names and values the child reported, parsed from a NUL- or newline-separated dump. */
function environmentOf(report: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const entry of report.split('\0').join('\n').split('\n')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    parsed[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return parsed;
}

interface SeededRun {
  readonly childEnvironment: Record<string, string>;
  readonly parentNames: readonly string[];
  readonly layout: EngineStateLayout;
  readonly operatorHome: string;
  readonly report: string;
}

/**
 * Runs the reporting probe once with a set of variables seeded into the worker environment.
 *
 * `process.env` is the real parent the shipped `start` reads, so this is the same input the
 * product hands the allowlist; seeding and restoring is what keeps the assertion about the
 * allowlist rather than about this machine's shell.
 */
async function runProbeWithSeededParent(
  seeded: Readonly<Record<string, string>>,
  extra?: (dir: string) => string,
): Promise<SeededRun> {
  const root = mkdtempSync(join(tmpdir(), 'shiploop-env-'));
  const operatorHome = join(root, 'operator-home');
  const workspace = join(root, 'worktrees', 'job-1');
  mkdirSync(operatorHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const probe = extra?.(root) ?? envReportingProbe(root);

  const previous = new Map<string, string | undefined>();
  const seed: Record<string, string> = {
    // An operator `~/.codex/config.toml` on this host sets `sandbox_mode =
    // unrestricted `sandbox_mode` with `approval_policy = "never"`. A child that could reach it would
    // run unrestricted, which is why `CODEX_HOME` below is asserted against the operator's.
    CODEX_HOME: join(operatorHome, '.codex'),
    HOME: operatorHome,
    ...seeded,
  };
  for (const [name, value] of Object.entries(seed)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    const state = prepareEngineState({ stateRoot: join(root, 'state'), attempt: workspace });
    assert.ok(state.ok, 'the ShipLoop-owned engine state was created');
    if (!state.ok) throw new Error('unreachable');
    const started = spawnTrackedGroup([probe, 'child'], workspace, engineEnvironment(process.env, state.value));
    assert.ok(started.ok, 'the probe process started');
    if (!started.ok) throw new Error('unreachable');
    const report = (await readAllLines(started.value)).join('\n');
    return {
      childEnvironment: environmentOf(report),
      parentNames: Object.keys(seed),
      layout: state.value,
      operatorHome,
      report,
    };
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('F03-AC5, N02-AC3 the engine child is given an allowlist: an unknown variable name does not reach it', async () => {
  // The seeded names are deliberately unremarkable. A denylist drops what it recognises and
  // forwards the rest, so the test is only meaningful if the names it uses are names no
  // credential pattern would match: `ZSH_THEME_HINTS` and `SHIPLOOP_SIDE_CHANNEL` are the two
  // that make reverting to the denylist fail rather than silently pass (F03-AC5).
  const run = await runProbeWithSeededParent({
    ZSH_THEME_HINTS: 'some-shell-state',
    SHIPLOOP_SIDE_CHANNEL: 'open',
  });

  assert.equal(run.childEnvironment['ZSH_THEME_HINTS'], undefined, `an unknown variable reached the child: ${run.report}`);
  assert.equal(run.childEnvironment['SHIPLOOP_SIDE_CHANNEL'], undefined, `an unknown variable reached the child: ${run.report}`);
  assert.ok(!run.report.includes('SHIPLOOP_SIDE_CHANNEL'), `the child was handed the operator's environment: ${run.report}`);

  // What the engine does need is still there, so the allowlist is not simply an empty one.
  assert.equal(run.childEnvironment['PATH_SET'], 'yes', 'the engine still needs a PATH to run');
  assert.equal(run.childEnvironment['HOME_IS'], run.layout.home);
  assert.equal(run.childEnvironment['CODEX_HOME_IS'], run.layout.codexHome);
});

test('F03-AC5 the authoritative store is not reachable from the engine environment', async () => {
  const run = await runProbeWithSeededParent({
    DATABASE_URL: 'file:///home/ubuntu/projects/ShipLoop/.state/shiploop.db',
  });
  assert.ok(run.parentNames.includes('DATABASE_URL'), 'the control really did seed DATABASE_URL into the parent');
  assert.equal(run.childEnvironment['DATABASE_URL'], undefined, `DATABASE_URL reached the child: ${run.report}`);
  assert.ok(!run.report.includes('DATABASE_URL'), `DATABASE_URL reached the child: ${run.report}`);
});

test('F03-AC5 a credential-FILE pointer is not reachable from the engine environment', async () => {
  // These name a file rather than a secret, so no regex over variable names would ever catch
  // them, and each one is a path the engine would read a credential out of.
  const run = await runProbeWithSeededParent({
    NETRC: '/home/ubuntu/.netrc',
    GIT_CONFIG_GLOBAL: '/home/ubuntu/.gitconfig',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ASKPASS: '/usr/bin/ssh-askpass',
    SSH_ASKPASS: '/usr/bin/ssh-askpass',
    GIT_SSH_COMMAND: 'ssh -i /home/ubuntu/.ssh/id_ed25519',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    XDG_CONFIG_HOME: '/home/ubuntu/.config',
  });
  for (const name of [
    'NETRC',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
    'GIT_SSH_COMMAND',
    'SSH_AUTH_SOCK',
    'XDG_CONFIG_HOME',
  ]) {
    assert.equal(run.childEnvironment[name], undefined, `${name} reached the child: ${run.report}`);
  }
});

test('F03-AC5 the engine HOME is a ShipLoop directory for this attempt, not the operator\'s home', async () => {
  const run = await runProbeWithSeededParent({});
  assert.notEqual(run.childEnvironment['HOME'], run.operatorHome, 'the child inherited the operator HOME');
  assert.notEqual(run.childEnvironment['HOME'], process.env['HOME'], 'the child inherited the worker HOME');
  assert.ok(
    run.childEnvironment['HOME']?.startsWith(run.layout.stateRoot) ?? false,
    `HOME must live under the ShipLoop state root: ${String(run.childEnvironment['HOME'])}`,
  );
  // Two attempts of the same shape get different homes, so one attempt cannot read another's.
  assert.notEqual(attemptKeyOf('/a/worktrees/one'), attemptKeyOf('/a/worktrees/two'));
  assert.equal(attemptKeyOf('/a/worktrees/one'), attemptKeyOf('/a/worktrees/one'), 'a resumed attempt must find its own home again');
});

test('F03-AC5 a credential seeded in the operator\'s home does not resolve from the child', async () => {
  // Seeded under three names a coding session would plausibly reach for. The child is asked
  // exactly as code inside the session would ask: through its own `$HOME`. The residual
  // same-uid exposure to an absolute path is stated in the module comment and is not what this
  // assertion claims.
  const credential = ['sk', 'proj', 'C'.repeat(26)].join('-');
  const run = await runProbeWithSeededParent(
    {},
    (root) => {
      const operatorHome = join(root, 'operator-home');
      mkdirSync(join(operatorHome, '.ssh'), { recursive: true });
      writeFileSync(join(operatorHome, '.netrc'), `machine api.github.com login x password ${credential}\n`, 'utf8');
      writeFileSync(join(operatorHome, '.ssh', 'id_ed25519'), credential, 'utf8');
      writeFileSync(join(operatorHome, '.git-credentials'), `https://x:${credential}@github.com\n`, 'utf8');
      const probe = join(root, 'home-read.sh');
      writeFileSync(
        probe,
        [
          '#!/bin/sh',
          'for file in .netrc .ssh/id_ed25519 .git-credentials; do',
          '  if [ -r "$HOME/$file" ]; then printf "READABLE %s\\n" "$file"; else printf "ABSENT %s\\n" "$file"; fi',
          'done',
          'printf "HOME_IS %s\\n" "$HOME"',
        ].join('\n'),
        'utf8',
      );
      chmodSync(probe, 0o755);
      return probe;
    },
  );

  assert.ok(!run.report.includes('READABLE'), `the child resolved an operator credential through HOME: ${run.report}`);
  for (const file of ['.netrc', '.ssh/id_ed25519', '.git-credentials']) {
    assert.ok(run.report.includes(`ABSENT ${file}`), `${file} was readable from the child: ${run.report}`);
  }
  assert.ok(!run.report.includes(credential), `the credential itself was read: ${run.report}`);
  assert.notEqual(run.childEnvironment['HOME'], run.operatorHome);
});

test('F03-AC5 CODEX_HOME is a ShipLoop directory, so the operator\'s config.toml cannot disable the sandbox', async () => {
  const run = await runProbeWithSeededParent({});
  const operatorCodexHome = join(run.operatorHome, '.codex');
  assert.notEqual(run.childEnvironment['CODEX_HOME'], operatorCodexHome, 'the child inherited the operator CODEX_HOME');
  assert.equal(run.childEnvironment['CODEX_HOME_IS'], run.layout.codexHome);
  assert.equal(run.layout.codexHome, join(run.layout.stateRoot, 'codex'));
  // The state root is never a temporary directory: Codex refuses to create its PATH-alias helper
  // binaries there and warns on every run, so a default under TMPDIR would be a broken default.
  assert.ok(!defaultEngineStateRoot({}).startsWith(tmpdir()), `the default state root is a temporary directory: ${defaultEngineStateRoot({})}`);
});

test('F15-AC5 the operator\'s rotating login is never copied, re-copied or even read', () => {
  // The defect this replaces: a ChatGPT login is a *rotating* credential, so copying it made the
  // engine and the operator two writers of one refresh token. The test therefore plants a real
  // operator login — the exact shape `codex login` writes, with a refresh token — points the
  // process's `CODEX_HOME` at it, and proves the shipped path leaves it byte-identical afterwards.
  const root = mkdtempSync(join(tmpdir(), 'shiploop-state-'));
  const operatorCodexHome = join(root, 'operator', '.codex');
  const stateRoot = join(root, 'state');
  mkdirSync(operatorCodexHome, { recursive: true });
  const operatorLogin = JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: 'id.probe',
      access_token: 'access.probe',
      refresh_token: 'rt.operator.must-never-be-copied',
      account_id: 'acct_operator',
    },
    last_refresh: '2026-10-01T00:00:00Z',
  });
  writeFileSync(join(operatorCodexHome, 'auth.json'), operatorLogin, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(
    join(operatorCodexHome, 'config.toml'),
    UNRESTRICTED_CONFIG,
    'utf8',
  );
  const digestBefore = createHash('sha256').update(readFileSync(join(operatorCodexHome, 'auth.json'))).digest('hex');
  const previous = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = operatorCodexHome;
  try {
    const state = prepareEngineState({ stateRoot, attempt: '/w/job-1' });
    assert.ok(state.ok, 'the state was prepared');
    if (!state.ok) return;

    // Nothing was written into the engine state, and in particular no credential was seeded.
    assert.equal(existsSync(join(state.value.codexHome, 'auth.json')), false, 'the operator login must never be copied into the engine state');
    assert.equal(existsSync(join(state.value.codexHome, 'config.toml')), false, 'the operator config must never be copied into the engine state');
    assert.equal(statSync(state.value.home).mode & 0o777, 0o700, 'the per-attempt home must not be group or world readable');

    // Re-running the preparation does not change the answer: there is no mtime comparison left to
    // make, because there is nothing being refreshed from the operator's file any more.
    const again = prepareEngineState({ stateRoot, attempt: '/w/job-2' });
    assert.ok(again.ok);
    if (!again.ok) return;
    assert.notEqual(again.value.home, state.value.home, 'two attempts must not share one HOME');
    assert.equal(again.value.codexHome, state.value.codexHome, 'one credential store is shared so a refresh is not racing itself');
    assert.equal(existsSync(join(again.value.codexHome, 'auth.json')), false, 'a second preparation must not seed a credential either');

    const digestAfter = createHash('sha256').update(readFileSync(join(operatorCodexHome, 'auth.json'))).digest('hex');
    assert.equal(digestAfter, digestBefore, 'the operator login was modified');
    assert.equal(readFileSync(join(operatorCodexHome, 'auth.json'), 'utf8'), operatorLogin, 'the operator login was rewritten');
  } finally {
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('F15-AC5 a run with no provisioned engine credential is a typed blocker, not a silent copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'shiploop-noauth-'));
  const operatorCodexHome = join(root, 'operator', '.codex');
  const stateRoot = join(root, 'state');
  const workspace = join(root, 'worktrees', 'job-1');
  mkdirSync(operatorCodexHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(operatorCodexHome, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt.operator"}}', {
    encoding: 'utf8',
    mode: 0o600,
  });
  const previous = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = operatorCodexHome;
  try {
    const client = new CodexClient({ binary: join(root, 'codex'), stateRoot });
    const started = client.start({
      cwd: workspace,
      sandbox: 'read-only',
      prompt: 'do the thing',
      invocation: 'Fresh',
      signal: new AbortController().signal,
    });
    assert.equal(started.ok, false, 'a run must not proceed on an unprovisioned engine credential');
    if (started.ok) return;
    assert.equal(started.error.code, 'Blocked', 'the failure is a blocker an owner can act on, not a runtime failure');
    assert.equal(existsSync(join(stateRoot, 'codex', 'auth.json')), false, 'the blocker must not have copied the operator login on its way out');

    const prerequisites = (started.error as { readonly prerequisites?: readonly { readonly name: string; readonly detail: string; readonly remedy: string }[] }).prerequisites ?? [];
    const engineCredential = prerequisites.find((entry) => entry.name === 'engine-credential');
    assert.ok(engineCredential !== undefined, 'the blocker names the missing prerequisite');
    assert.ok(
      engineCredential.remedy.includes('codex login --with-api-key'),
      `the remedy names the command that provisions one: ${engineCredential.remedy}`,
    );
    assert.ok(
      engineCredential.detail.includes(CODEX_SEPARATE_CREDENTIAL_VERSION),
      'the blocker names the Codex version the behaviour was measured on, so a future reader knows what was observed',
    );
  } finally {
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('F15-AC5 a provisioned credential is reported by mode, and an unusable or exposed one is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'shiploop-cred-'));
  const stateRoot = join(root, 'state');
  const codexHome = join(stateRoot, 'codex');
  mkdirSync(codexHome, { recursive: true });
  const layout = engineStateLayout({ stateRoot, attempt: '/w/job-1' });
  const credential = join(codexHome, ENGINE_CREDENTIAL_FILE);
  try {
    // The two shapes `codex login` writes on this host, byte-for-byte in structure.
    writeFileSync(credential, PROVISIONED_AUTH_JSON, { encoding: 'utf8', mode: 0o600 });
    const apiKey = resolveEngineAuthentication(layout);
    assert.ok(apiKey.ok, `an apikey login is recognised: ${apiKey.ok ? '' : apiKey.error.reason}`);
    if (!apiKey.ok) return;
    assert.equal(apiKey.value.mode, 'ApiKey');
    assert.equal(apiKey.value.codexHome, codexHome);
    assert.equal(apiKey.value.credentialPath, credential);

    writeFileSync(credential, '{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt.shipLoop"},"last_refresh":"2026-10-02T00:00:00Z"}', {
      encoding: 'utf8',
      mode: 0o600,
    });
    const chatgpt = resolveEngineAuthentication(layout);
    assert.ok(chatgpt.ok && chatgpt.value.mode === 'ChatGPT', 'a ChatGPT login is recognised and reported as what it is, not as a separate identity');

    // Three refusals that a provisioning attempt can genuinely leave behind, each a different fix.
    writeFileSync(credential, '{"auth_mode":"chatgpt"}', { encoding: 'utf8', mode: 0o600 });
    const incomplete = resolveEngineAuthentication(layout);
    assert.equal(incomplete.ok, false, 'a login that names a mode and carries none of it is not a credential');
    assert.ok(!incomplete.ok && incomplete.error.reason.includes('provenance'), 'the refusal names provenance rather than reporting it missing');

    writeFileSync(credential, 'not json at all', { encoding: 'utf8', mode: 0o600 });
    assert.equal(resolveEngineAuthentication(layout).ok, false, 'an unparseable login is refused');

    writeFileSync(credential, PROVISIONED_AUTH_JSON, { encoding: 'utf8' });
    // `writeFileSync` leaves an existing file's mode alone, so the exposure is set the way an
    // operator's umask would actually produce it rather than assumed from the write.
    chmodSync(credential, 0o644);
    assert.equal(statSync(credential).mode & 0o077, 0o044, 'the test really did leave the credential group-readable');
    const exposed = resolveEngineAuthentication(layout);
    assert.equal(exposed.ok, false, 'a group- or world-readable credential is not one this product provisioned');
    assert.ok(!exposed.ok && exposed.error.code === 'Forbidden', 'an exposed credential is a refusal, not an outage');
    assert.ok(!exposed.ok && exposed.error.reason.includes('0600'), 'the refusal names the mode that fixes it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F03-AC5 a state root that cannot be created is refused rather than falling back to ~/.codex', async () => {
  const blocked = join(tmpdir(), 'shiploop-env-blocked');
  writeFileSync(blocked, 'not a directory', 'utf8');
  const state = prepareEngineState({ stateRoot: blocked, attempt: '/w/job-1' });
  assert.equal(state.ok, false, 'a state root that cannot exist must not be silently replaced by the operator home');
  if (state.ok) return;
  assert.equal(state.error.code, 'Unavailable');
  assert.match(state.error.reason, /unrestricted sandbox_mode/);
});

test('F03-AC5 the version probe child is allowlisted, and needs no credential at all', async () => {
  // The probe is a child like any other: leaving it on the worker's environment would keep the
  // whole exposure in place for the call an operator runs most often. It also runs with no
  // credential provisioned, because `--version` never authenticates — "can I run codex at all" must
  // not depend on a login it does not use.
  const root = mkdtempSync(join(tmpdir(), 'shiploop-probe-'));
  const stateRoot = join(root, 'state');
  const binary = join(root, 'fake-codex');
  writeFileSync(
    binary,
    [
      '#!/bin/sh',
      // The observation is the real child writing down what it was handed.
      'env > "$(dirname "$0")/child-env.txt"',
      'printf \'codex-cli 0.159.1\\n\'',
    ].join('\n'),
    'utf8',
  );
  chmodSync(binary, 0o755);
  const previous = { GH_TOKEN: process.env['GH_TOKEN'], DATABASE_URL: process.env['DATABASE_URL'] };
  process.env['GH_TOKEN'] = ['ghp', 'probeMustNotLeak'].join('_');
  process.env['DATABASE_URL'] = 'file:///state/shiploop.db';
  try {
    const verdict = await new CodexClient({ binary, stateRoot }).checkVersion(adapterContext('op_probe_env'));
    assert.ok(verdict.ok, `the version probe answered: ${verdict.ok ? '' : verdict.error.reason}`);
    if (!verdict.ok) return;
    assert.equal(verdict.value.runtimeVersion, CODEX_VERIFIED_VERSION);
    const report = readFileSync(join(root, 'child-env.txt'), 'utf8');
    assert.ok(!report.includes('GH_TOKEN'), `the probe child inherited GH_TOKEN: ${report}`);
    assert.ok(!report.includes('DATABASE_URL'), `the probe child inherited DATABASE_URL: ${report}`);
    assert.equal(existsSync(join(stateRoot, 'codex', 'auth.json')), false, 'a version probe must not create or copy a credential');
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('F03-AC5 the shipped client start hands the engine the allowlist and no operator CODEX_HOME', async () => {
  // The same assertion through the shipped path, not through `engineEnvironment` directly: the
  // claim being made is about the process `startSession` spawns. A credential is provisioned into
  // the ShipLoop state root first, because `start` now refuses a run that has none — so this test
  // also proves the refusal is about *this* state root and not about the operator's login.
  const root = mkdtempSync(join(tmpdir(), 'shiploop-start-'));
  const workspace = join(root, 'worktrees', 'job-1');
  const operatorCodexHome = join(root, 'operator', '.codex');
  const stateRoot = join(root, 'state');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(operatorCodexHome, { recursive: true });
  writeFileSync(join(operatorCodexHome, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt.operator"}}', {
    encoding: 'utf8',
    mode: 0o600,
  });
  const layout = engineStateLayout({ stateRoot, attempt: workspace });
  mkdirSync(layout.codexHome, { recursive: true });
  writeFileSync(join(layout.codexHome, ENGINE_CREDENTIAL_FILE), PROVISIONED_AUTH_JSON, {
    encoding: 'utf8',
    mode: 0o600,
  });
  const engine = join(root, 'codex');
  writeFileSync(
    engine,
    [
      '#!/bin/sh',
      'printf \'{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}\\n\'',
      'printf "HOME_IS %s\\n" "$HOME"',
      'printf "CODEX_HOME_IS %s\\n" "${CODEX_HOME:-unset}"',
      'printf \'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}\\n\'',
      'printf \'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\\n\'',
    ].join('\n'),
    'utf8',
  );
  chmodSync(engine, 0o755);
  const previous = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = operatorCodexHome;
  try {
    const client = new CodexClient({ binary: engine, stateRoot });
    const started = client.start({
      cwd: workspace,
      sandbox: 'workspace-write',
      prompt: 'do the thing',
      invocation: 'Fresh',
      signal: new AbortController().signal,
    });
    assert.ok(started.ok, `the engine started: ${started.ok ? '' : started.error.reason}`);
    if (!started.ok) return;
    const output = (await readAllLines(started.value)).join('\n');
    started.value.dispose();
    assert.ok(output.includes(`HOME_IS ${layout.home}`), `the spawned engine got the wrong HOME: ${output}`);
    assert.ok(output.includes(`CODEX_HOME_IS ${layout.codexHome}`), `the spawned engine got the wrong CODEX_HOME: ${output}`);
    assert.ok(!output.includes(operatorCodexHome), `the spawned engine inherited the operator CODEX_HOME: ${output}`);
    assert.equal(
      readFileSync(join(operatorCodexHome, 'auth.json'), 'utf8'),
      '{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt.operator"}}',
      'the operator login is byte-identical after a shipped start',
    );
  } finally {
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('F03-AC5 the allowlist is exactly the seven names the engine needs, and each is justified', () => {
  // A test that enumerates the allowlist is what stops it growing by accident: adding a name
  // here is a deliberate act with a stated reason, not a one-word diff.
  assert.deepEqual([...ENGINE_ENVIRONMENT_VARIABLES], ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'CODEX_HOME']);
  for (const name of FORBIDDEN_IN_CHILD) {
    assert.ok(
      !(ENGINE_ENVIRONMENT_VARIABLES as readonly string[]).includes(name),
      `${name} is on the engine allowlist, which would hand the engine authority it must not hold`,
    );
  }
  // `LC_ALL` is only forwarded when the operator set one, so inventing it cannot override LANG.
  const layout = engineStateLayout({ stateRoot: '/state', attempt: '/w/job-1' });
  assert.equal(engineEnvironment({ LC_ALL: 'en_US.UTF-8' }, layout)['LC_ALL'], 'en_US.UTF-8');
  assert.equal(engineEnvironment({}, layout)['LC_ALL'], undefined);
  assert.equal(engineEnvironment({}, layout)['LANG'], 'C.UTF-8');
  assert.equal(engineEnvironment({ TMPDIR: '/var/tmp' }, layout)['TMPDIR'], '/var/tmp');
  assert.equal(engineEnvironment({}, layout)['TZ'], 'UTC');
});

async function readAllLines(process: CodexProcess): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of process.lines()) lines.push(line);
  return lines;
}
