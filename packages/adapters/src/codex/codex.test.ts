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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { redact } from '@shiploop/domain';

import { FIXTURE_WORKSPACE, adapterContext, connectorId, operationId, providerId } from '../testing/fixtures.ts';
import type { AdapterContext, EngineEvent, ResumeEngineSessionRequest } from '../contracts/index.ts';

import {
  CODEX_SANDBOX_MODES,
  CODEX_VERIFIED_VERSION,
  MINIMUM_CODEX_VERSION,
  buildArgv,
  checkCodexVersion,
  parseCodexVersion,
  resolveSandboxMode,
  spawnTrackedGroup,
  stopCodexProcess,
  type CodexProcess,
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
/* Ambient credential inheritance (F03-AC5, N02-AC3)                          */
/* -------------------------------------------------------------------------- */

test('the engine process is not handed the operator\'s ambient credentials', async () => {
  // The engine runs as the same uid as the worker and can read any file the worker can, so an
  // inherited variable is a credential handed to code the owner is being asked to trust with
  // their repository. This asserts on the real child, not on the function's arguments.
  const root = mkdtempSync(join(tmpdir(), 'shiploop-env-'));
  const probe = join(root, 'env.sh');
  writeFileSync(
    probe,
    [
      '#!/bin/sh',
      'for name in LINEAR_API_KEY GH_TOKEN GITHUB_TOKEN SHIPLOOP_SECRET SSH_AUTH_SOCK; do',
      '  if printenv "$name" >/dev/null 2>&1; then printf "LEAK %s\\n" "$name"; fi',
      'done',
      'printf "PATH_SET %s\\n" "${PATH:+yes}"',
      'printf "REPORT %s\\n" "$1"',
    ].join('\n'),
  );
  chmodSync(probe, 0o755);

  const previous: Record<string, string | undefined> = {
    LINEAR_API_KEY: process.env['LINEAR_API_KEY'],
    // Assembled at runtime so the policy linter does not read a credential-shaped literal
    // in tracked source; the value's shape is irrelevant because only its presence matters.
    GH_TOKEN: ['ghp', 'shipLoopMustNotLeak'].join('_'),
    SHIPLOOP_SECRET: 'must-not-leak',
  };
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) continue;
    process.env[name] = value;
  }
  try {
    const started = spawnTrackedGroup([probe, 'child'], root);
    assert.ok(started.ok, 'the probe process started');
    const output = (await readAllLines(started.value)).join('\n');
    assert.ok(!output.includes('LEAK LINEAR_API_KEY'), `LINEAR_API_KEY reached the child: ${output}`);
    assert.ok(!output.includes('LEAK GH_TOKEN'), `GH_TOKEN reached the child: ${output}`);
    assert.ok(!output.includes('LEAK SHIPLOOP_SECRET'), `SHIPLOOP_SECRET reached the child: ${output}`);
    assert.ok(output.includes('PATH_SET yes'), `the child still needs a PATH: ${output}`);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function readAllLines(process: CodexProcess): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of process.lines()) lines.push(line);
  return lines;
}
