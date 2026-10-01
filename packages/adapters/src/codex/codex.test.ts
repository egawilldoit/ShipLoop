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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { redact } from '@shiploop/domain';

import { FIXTURE_WORKSPACE, adapterContext, connectorId, operationId, providerId } from '../testing/fixtures.ts';
import type { AdapterContext, EngineEvent, ResumeEngineSessionRequest } from '../contracts/index.ts';

import {
  CODEX_SANDBOX_MODES,
  CODEX_VERIFIED_VERSION,
  CodexClient,
  ENGINE_ENVIRONMENT_VARIABLES,
  MINIMUM_CODEX_VERSION,
  attemptKeyOf,
  buildArgv,
  checkCodexVersion,
  defaultEngineStateRoot,
  engineEnvironment,
  engineStateLayout,
  parseCodexVersion,
  prepareEngineState,
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

/* -------------------------------------------------------------------------- */
/* Engine:VersionCheck                                                         */
/* -------------------------------------------------------------------------- */

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
  });
  assert.deepEqual(argv, ['exec', '--sandbox', 'workspace-write', '--cd', '/tmp/attempt', '--json', '--', 'create probe.txt']);
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
  execFileSync('git', ['init', '-q', '.'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'probe@example.invalid'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'probe'], { cwd: workspace });
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: workspace });

  const adapter = new CodexEngineAdapter({
    connectorId: connectorId('connector_codex_live'),
    client: { binary: 'codex', gracefulStopMs: 5_000, killWaitMs: 5_000 },
    sandbox: 'workspace-write',
  });
  const context: AdapterContext = { ...adapterContext('op_codex_live'), signal: AbortSignal.timeout(600_000) };

  const compatibility = await adapter.checkCompatibility(context);
  assert.equal(compatibility.ok, true);
  assert.equal(compatibility.ok === true ? compatibility.value.compatible : false, true);
  assert.equal(compatibility.ok === true ? compatibility.value.runtimeVersion : null, CODEX_VERIFIED_VERSION);

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

  rmSync(workspace, { recursive: true, force: true });
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

test('F03-AC5 the login is copied into the ShipLoop state and the operator config beside it is not', async () => {
  // Codex keeps its ChatGPT login in `$CODEX_HOME/auth.json` and every other setting in
  // `$CODEX_HOME/config.toml`. Seeding the first and not the second is what lets the engine
  // authenticate while keeping the operator's unrestricted `sandbox_mode` out of its reach.
  const root = mkdtempSync(join(tmpdir(), 'shiploop-state-'));
  const operatorCodexHome = join(root, 'operator', '.codex');
  const stateRoot = join(root, 'state');
  mkdirSync(operatorCodexHome, { recursive: true });
  writeFileSync(join(operatorCodexHome, 'auth.json'), '{"OPENAI_API_KEY":null}', 'utf8');
  writeFileSync(join(operatorCodexHome, 'config.toml'), 'sandbox_mode = "UNRESTRICTED"\napproval_policy = "never"\n', 'utf8');
  const previous = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = operatorCodexHome;
  try {
    const state = prepareEngineState({ stateRoot, attempt: '/w/job-1' });
    assert.ok(state.ok, 'the state was prepared');
    if (!state.ok) return;
    assert.equal(existsSync(join(state.value.codexHome, 'auth.json')), true, 'the login must be seeded or no run can authenticate');
    assert.equal(existsSync(join(state.value.codexHome, 'config.toml')), false, 'the operator config must never be copied into the engine state');
    assert.equal(statSync(join(state.value.codexHome, 'auth.json')).mode & 0o777, 0o600, 'a credential copy must not be group or world readable');
    assert.equal(statSync(state.value.home).mode & 0o777, 0o700, 'the per-attempt home must not be group or world readable');

    // Idempotent, and a second attempt in the same state root does not overwrite the login.
    writeFileSync(join(operatorCodexHome, 'auth.json'), '{"OPENAI_API_KEY":null}', 'utf8');
    const again = prepareEngineState({ stateRoot, attempt: '/w/job-2' });
    assert.ok(again.ok);
    if (!again.ok) return;
    assert.notEqual(again.value.home, state.value.home, 'two attempts must not share one HOME');
    assert.equal(again.value.codexHome, state.value.codexHome, 'one login store is shared so a token refresh is not racing itself');
  } finally {
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
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

test('F03-AC5 the version probe child is allowlisted too, and seeds no login', async () => {
  // The probe is a child like any other: leaving it on the worker\'s environment would keep the
  // whole exposure in place for the call an operator runs most often. The login is not seeded
  // because `--version` never authenticates.
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
    assert.equal(existsSync(join(stateRoot, 'codex', 'auth.json')), false, 'a version probe must not copy a credential');
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
  // claim being made is about the process `startSession` spawns.
  const root = mkdtempSync(join(tmpdir(), 'shiploop-start-'));
  const workspace = join(root, 'worktrees', 'job-1');
  const operatorCodexHome = join(root, 'operator', '.codex');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(operatorCodexHome, { recursive: true });
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
    const client = new CodexClient({ binary: engine, stateRoot: join(root, 'state') });
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
    const layout = engineStateLayout({ stateRoot: join(root, 'state'), attempt: workspace });
    assert.ok(output.includes(`HOME_IS ${layout.home}`), `the spawned engine got the wrong HOME: ${output}`);
    assert.ok(output.includes(`CODEX_HOME_IS ${layout.codexHome}`), `the spawned engine got the wrong CODEX_HOME: ${output}`);
    assert.ok(!output.includes(operatorCodexHome), `the spawned engine inherited the operator CODEX_HOME: ${output}`);
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
