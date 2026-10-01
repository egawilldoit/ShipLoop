/**
 * The Codex process transport (F03-AC5, F15-AC1, F15-AC4, F17-AC1, N02-AC3).
 *
 * Every invocation is `spawn(binary, argvArray)`. There is no shell anywhere in this module and
 * no string is ever concatenated into a command line, because the instruction text comes from a
 * work item and a shell would turn an owner-supplied instruction into host command execution.
 * Node's `spawn` without `shell: true` hands `argv` to `execvp` directly, so an instruction
 * containing `; rm -rf /` is one argument rather than three commands.
 *
 * **The sandbox is an allowlist, not a denylist.** `CODEX_SANDBOX_MODES` holds only the two
 * modes a coding stage may have, and `resolveSandboxMode` refuses anything else by identity
 * rather than by comparing against a forbidden name. That is deliberate: the operator profile
 * on this host sets an unrestricted `sandbox_mode` and `approval_policy = "never"` in
 * `~/.codex/config.toml`, so the flag this module puts on the command line is the only thing
 * between a ShipLoop attempt and an unrestricted engine. A denylist that missed a future Codex
 * sandbox name would fail open; an allowlist fails closed, and the refusal names both permitted
 * modes so an owner correcting the profile does not have to read this file (F03-AC5, N02-AC3).
 *
 * **`resume` has no `--sandbox` flag.** Verified against `codex exec resume --help` on
 * 0.159.1: the flag list offers `--dangerously-bypass-approvals-and-sandbox` but no
 * `--sandbox`, and no `--cd` either. A resumed session is therefore constrained with
 * `-c sandbox_mode='<mode>'` instead, and that was **verified live** on this host: a resumed
 * session asked to write a file under `sandbox_mode="read-only"` produced no file and reported
 * the workspace read-only, while the same prompt under `sandbox_mode="workspace-write"` wrote
 * it. `buildArgv` therefore emits a different flag set per invocation, and `README.md` records
 * that difference rather than hiding it behind one shared list.
 *
 * **Shutdown targets one process group, never a name.** The child is spawned `detached`, so it
 * leads a new process group and every descendant it starts inherits that group id.
 * `stopCodexProcess` sends `SIGTERM` to the group, waits a bounded window, then sends `SIGKILL`
 * to the same group, and reports which one ended it. Nothing here matches on a command name, a
 * port or a pattern, so a concurrent Codex run belonging to someone else is unreachable from
 * this adapter (F17-AC1, F17-AC5).
 *
 * **The environment is an allowlist of seven names.** `engineEnvironment` builds the child's
 * environment from scratch: it copies nothing it was not asked for and forwards nothing whose
 * name is not in {@link ENGINE_ENVIRONMENT_VARIABLES}. The earlier version of this file did the
 * opposite — it started from `process.env` and dropped names matching two regexes — which fails
 * open in the one direction that matters, because a credential whose name nobody anticipated is
 * still handed to code the owner is being asked to trust with their repository. A denylist of
 * known credential names cannot be complete; an allowlist is complete by construction, and the
 * test in `codex.test.ts` is written so that reverting to the denylist makes it fail (F03-AC5,
 * N02-AC3).
 *
 * **`CODEX_HOME` is ShipLoop-owned, never the operator's.** Two facts forced this. First,
 * Codex reads its own configuration from `$CODEX_HOME/config.toml`, and on this host that file
 * sets an unrestricted `sandbox_mode` together with `approval_policy = "never"` for every
 * trusted project, this repository included — so inheriting the operator's `CODEX_HOME` would
 * hand the engine a configuration that disables the sandbox the flag above requests. Second, Codex keeps
 * its ChatGPT login in `$CODEX_HOME/auth.json`, so pointing `CODEX_HOME` at an empty directory
 * without seeding anything turns every run into a `401`. {@link prepareEngineState} therefore
 * creates a state root this product owns and copies **only** `auth.json` into it; the operator's
 * `config.toml`, trusted-project list, model preferences, MCP servers and hooks are simply not
 * there to be inherited.
 *
 * The residual exposure is stated rather than hidden: the child runs as the same uid as the
 * worker, so an absolute path to `~/.codex/auth.json` or `~/.ssh/id_ed25519` is still readable.
 * What the allowlist removes is the ambient *channel* — the operator's session cookies, `gh`
 * tokens, `LINEAR_API_KEY`, `DATABASE_URL`, netrc and askpass pointers — and what the ShipLoop
 * `HOME` removes is the ambient *directory*. Same-uid isolation is a separate change, recorded
 * in `docs/evidence/2026-10-01-credential-separation.md`.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { err, ok, type Result } from '@shiploop/domain';
import type { AdapterContext } from '../contracts/index.ts';
import { mapCodexVersionProbeFailure } from './errors.ts';

/**
 * The Codex version this adapter was written against.
 *
 * `CODEX_VERIFIED_VERSION` is the version whose `--json` event schema, flags and thread-id shape
 * were **measured** on this host on 1 October 2026, not the newest version published. It is
 * pinned so a report can name the engine that produced an artefact. `MINIMUM_CODEX_VERSION` is
 * the floor below which the measured schema does not hold: 0.159.1 emits a `thread.started`
 * event carrying `thread_id`, and that event is what this adapter maps a session identity and a
 * terminal result from. `checkCodexVersion` returns a verdict against the floor rather than
 * assuming compatibility (F04-AC2, F15-AC4).
 */
export const CODEX_VERIFIED_VERSION = '0.159.1';
export const MINIMUM_CODEX_VERSION = '0.159.1';

/** The sandbox modes a ShipLoop coding session may be granted. */
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write'] as const;

export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/** Whether this is a first run or a continuation of a recorded Codex thread. */
export type CodexInvocation = 'Fresh' | 'Resume';

export interface CodexClientOptions {
  /** Absolute path to the `codex` executable. Never a shell word. */
  readonly binary: string;
  /** Model passed as `-m`. Null uses whatever the operator profile selects. */
  readonly model?: string | null;
  /**
   * Absolute root of the ShipLoop-owned directory holding engine state.
   *
   * Defaults to `<XDG_STATE_HOME or ~/.local/state>/shiploop/codex`. It must not live under
   * `TMPDIR`: Codex refuses to create its PATH-alias helper binaries beneath a temporary
   * directory and warns on every run when it has to (measured on 0.159.1).
   */
  readonly stateRoot?: string;
  /** Bound on one graceful shutdown before the group is killed. */
  readonly gracefulStopMs?: number;
  /** Bound on waiting for a killed group to disappear. */
  readonly killWaitMs?: number;
  /** Hard bound on one `codex --version` probe. */
  readonly versionProbeTimeoutMs?: number;
  /** Pass `--skip-git-repo-check`. Off by default: the workspace is expected to be a worktree. */
  readonly skipGitRepoCheck?: boolean;
  /** Extra `-c key=value` overrides, already TOML-encoded by the caller. */
  readonly configOverrides?: readonly string[];
}

export interface CodexSpawnRequest {
  readonly cwd: string;
  readonly sandbox: CodexSandboxMode;
  readonly prompt: string;
  readonly invocation: CodexInvocation;
  /** The recorded Codex thread to continue. Required for `Resume`, refused without it. */
  readonly priorSessionId?: string;
  readonly signal: AbortSignal;
}

const DEFAULT_GRACEFUL_STOP_MS = 10_000;
const DEFAULT_KILL_WAIT_MS = 5_000;
const DEFAULT_VERSION_PROBE_MS = 15_000;
const STDERR_TAIL_LIMIT = 8_000;
const STDOUT_CAPTURE_LIMIT = 8_000;
const VERSION_PATTERN = /codex-cli\s+(\d+)\.(\d+)\.(\d+)/;

/**
 * Parses `codex-cli 0.159.1` into `0.159.1`.
 *
 * Returns null for anything else, including a bare `codex 0.159.1`, because a version this
 * adapter cannot read is a version whose event schema it cannot claim to understand. The shape
 * observed on 0.159.1 was exactly `codex-cli 0.159.1` on stdout with exit code 0.
 */
export function parseCodexVersion(stdout: string): string | null {
  const match = VERSION_PATTERN.exec(stdout.trim());
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  return major !== undefined && minor !== undefined && patch !== undefined ? `${major}.${minor}.${patch}` : null;
}

/** A version verdict against the declared floor. */
export interface CodexVersionVerdict {
  readonly runtimeVersion: string;
  readonly compatible: boolean;
  readonly detail: string;
}

/**
 * Compares an observed version against {@link MINIMUM_CODEX_VERSION}.
 *
 * Numeric component comparison rather than string comparison, because `0.159.10` is newer than
 * `0.159.9` and a lexicographic test would call it older.
 */
export function checkCodexVersion(observed: string): CodexVersionVerdict {
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(observed);
  if (parsed === null) {
    return {
      runtimeVersion: observed,
      compatible: false,
      detail: `Codex reported the unrecognised version "${observed}", so its event schema cannot be claimed compatible with the ${MINIMUM_CODEX_VERSION} floor this adapter was measured against.`,
    };
  }
  const observedTriplet: readonly [number, number, number] = [
    Number(parsed[1]),
    Number(parsed[2]),
    Number(parsed[3]),
  ];
  const floorTriplet = MINIMUM_CODEX_VERSION.split('.').map((part) => Number.parseInt(part, 10));
  const floor: readonly [number, number, number] = [
    floorTriplet[0] ?? 0,
    floorTriplet[1] ?? 0,
    floorTriplet[2] ?? 0,
  ];
  if (compareTriples(observedTriplet, floor) < 0) {
    return {
      runtimeVersion: observed,
      compatible: false,
      detail: `Codex ${observed} is older than the ${MINIMUM_CODEX_VERSION} floor. Its --json stream predates the thread.started event this adapter maps a session identity and a terminal result from, so it is refused rather than run on an assumed schema.`,
    };
  }
  return {
    runtimeVersion: observed,
    compatible: true,
    detail: `Codex ${observed} satisfies the ${MINIMUM_CODEX_VERSION} floor this adapter was measured against.`,
  };
}

function compareTriples(left: readonly [number, number, number], right: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Refuses a sandbox mode this adapter will not grant.
 *
 * The refusal names the two permitted modes because the profile an owner is most likely editing
 * is the operator's own `~/.codex/config.toml`, where the value has to be spelled exactly as it
 * appears on the command line.
 */
export function resolveSandboxMode(requested: string, redact: (text: string) => string): Result<CodexSandboxMode> {
  const allowed = CODEX_SANDBOX_MODES.find((mode) => mode === requested);
  if (allowed !== undefined) return ok(allowed);
  return err({
    code: 'Forbidden',
    reason: redact(
      `"${requested}" is not a sandbox mode a ShipLoop coding session may hold. The permitted modes are ${CODEX_SANDBOX_MODES.join(' and ')}. A coding stage never runs the engine unrestricted, whatever the operator profile on the host asks for (F03-AC5, N02-AC3).`,
    ),
  });
}

/**
 * Builds the argv for one invocation.
 *
 * The prompt is the final positional argument and never a flag, so an instruction beginning with
 * `-` cannot be read as an option. Nothing here is shell-quoted because nothing here is ever
 * handed to a shell. `--` ends flag parsing so a prompt starting with a dash is still a prompt.
 */
export function buildArgv(request: {
  readonly sandbox: CodexSandboxMode;
  readonly invocation: CodexInvocation;
  readonly prompt: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly skipGitRepoCheck: boolean;
  readonly configOverrides: readonly string[];
  readonly priorSessionId?: string;
}): readonly string[] {
  const argv: string[] = ['exec'];

  if (request.invocation === 'Resume') {
    // `codex exec resume` on 0.159.1 accepts --json, --output-last-message and -c, but no
    // --sandbox and no --cd. The working directory is therefore carried by the child's own cwd
    // and the sandbox by a config override, both verified live on this host.
    argv.push('resume', '-c', `sandbox_mode='${request.sandbox}'`);
  } else {
    argv.push('--sandbox', request.sandbox);
    argv.push('--cd', request.cwd);
  }

  argv.push('--json');
  if (request.model !== null) argv.push('-m', request.model);
  if (request.skipGitRepoCheck) argv.push('--skip-git-repo-check');
  for (const override of request.configOverrides) argv.push('-c', override);
  argv.push('--');
  if (request.priorSessionId !== undefined) argv.push(request.priorSessionId);
  argv.push(request.prompt);
  return argv;
}

/** A Codex process this adapter spawned, with the facts needed to stop it honestly. */
export interface CodexProcess {
  readonly pid: number;
  /** The process-group id, equal to the child's pid because the child was spawned detached. */
  readonly processGroupId: number;
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Lines from stdout, in order. Ends when the process closes its stdout. */
  lines(): AsyncIterable<string>;
  /** Bounded tail of stderr. Codex writes its startup banner and warnings there. */
  stderrTail(): string;
  /** Resolves with the exit code, or null when the process was signalled. */
  waited(): Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
  /** `SIGTERM` to the tracked group. Never matches by name. */
  requestGracefulStop(): void;
  /** `SIGKILL` to the tracked group. Never matches by name. */
  killProcessGroup(): void;
  /** Whether any process remains in the tracked group. */
  groupHasSurvivors(): boolean;
  /** Releases listeners so a finished session does not hold the event loop open. */
  dispose(): void;
}

/**
 * The child shape this module handles.
 *
 * stdin is `null` rather than a pipe because the prompt travels in argv: an engine that is
 * handed an open stdin will read it, and a caller that never closes it would hang the session.
 */
type CodexChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export class CodexClient {
  private readonly options: CodexClientOptions;

  constructor(options: CodexClientOptions) {
    this.options = options;
  }

  /**
   * Runs `codex --version` and returns a verdict against the declared floor.
   *
   * This is the `Engine:VersionCheck` capability, and it observes rather than assumes (F04-AC2):
   * the version comes from the engine's own stdout, and a probe that cannot run at all is a
   * `Blocked` prerequisite naming the missing runtime rather than a compatibility answer.
   */
  async checkVersion(context: AdapterContext): Promise<Result<CodexVersionVerdict>> {
    const outcome = await this.probe(['--version'], this.options.versionProbeTimeoutMs ?? DEFAULT_VERSION_PROBE_MS, context.redact);
    if (!outcome.ok) return outcome;
    const version = parseCodexVersion(outcome.value.stdout);
    if (version === null) {
      return err(
        mapCodexVersionProbeFailure(
          `expected a line of the form "codex-cli <major>.<minor>.<patch>" and received: ${outcome.value.stdout.slice(0, 200)}`,
          outcome.value.exitCode,
          context.redact,
        ),
      );
    }
    return ok(checkCodexVersion(version));
  }

  /**
   * Spawns a Codex session as the leader of its own process group.
   *
   * The ShipLoop-owned state is created first, because the engine's environment cannot be
   * assembled without it and because a failure to create it must be a refusal rather than a
   * fallback onto the operator's `~/.codex`.
   */
  start(request: CodexSpawnRequest): Result<CodexProcess> {
    if (request.invocation === 'Resume' && request.priorSessionId === undefined) {
      return err(
        mapCodexVersionProbeFailure(
          'a Codex resume must name the recorded thread it continues; `codex exec resume --last` would pick an arbitrary session and silently continue the wrong conversation (F15-AC4).',
          null,
          (text: string): string => text,
        ),
      );
    }
    const state = prepareEngineState({
      stateRoot: this.options.stateRoot,
      attempt: request.cwd,
    });
    if (!state.ok) return err(state.error);
    const argv = buildArgv({
      sandbox: request.sandbox,
      invocation: request.invocation,
      prompt: request.prompt,
      cwd: request.cwd,
      model: this.options.model ?? null,
      skipGitRepoCheck: this.options.skipGitRepoCheck ?? false,
      configOverrides: this.options.configOverrides ?? [],
      ...(request.priorSessionId === undefined ? {} : { priorSessionId: request.priorSessionId }),
    });

    const tracked = spawnTrackedGroup(
      [this.options.binary, ...argv],
      request.cwd,
      engineEnvironment(process.env, state.value),
    );
    if (tracked.ok) return tracked;
    return err(
      mapCodexVersionProbeFailure(
        `the Codex process could not be spawned (${tracked.error.reason})`,
        null,
        (text: string): string => text,
      ),
    );
  }

  /**
   * Bounded one-shot execution, used only for the version probe.
   *
   * The probe is not spawned detached: it is a single short-lived `codex --version` with no
   * descendants, and the caller only needs its exit status and stdout. If it overruns, the child
   * itself is killed and the call fails rather than waiting.
   *
   * It runs with the same allowlist as a session. A probe inherits an environment exactly like
   * any other child, so leaving it on `process.env` would keep the whole exposure in place for
   * the one call an operator most often runs by hand. The login is deliberately **not** seeded
   * for a version probe: `--version` never authenticates, and copying a credential for a call
   * that cannot use it would be a credential on disk for nothing.
   */
  private probe(
    argv: readonly string[],
    timeoutMs: number,
    redact: (text: string) => string,
  ): Promise<Result<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }>> {
    const state = prepareEngineState({
      stateRoot: this.options.stateRoot,
      attempt: `codex-version-probe:${this.options.binary}`,
      seedAuthFrom: null,
    });
    if (!state.ok) return Promise.resolve(err(state.error));
    const environment = engineEnvironment(process.env, state.value);
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let child: CodexChildProcess;
      try {
        child = spawn(this.options.binary, [...argv], {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          env: environment,
        });
      } catch (cause) {
        resolve(err(mapCodexVersionProbeFailure(describe(cause), null, redact)));
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        resolve(
          err(
            mapCodexVersionProbeFailure(`\`codex ${argv.join(' ')}\` did not answer within ${String(timeoutMs)}ms`, null, redact),
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < STDOUT_CAPTURE_LIMIT) stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < STDERR_TAIL_LIMIT) stderr += chunk;
      });
      child.on('error', (cause: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(err(mapCodexVersionProbeFailure(cause.message, null, redact)));
      });
      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok({ stdout, stderr, exitCode: code }));
      });
    });
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function signalGroup(child: CodexChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone, which is the state the caller asked for */
    }
  }
}

/**
 * The only variables the engine process receives.
 *
 * Every entry is here because the engine demonstrably needs it on 0.159.1, measured on this
 * host, and nothing else is here because nothing else was needed to run `codex --version` and
 * one bounded `codex exec` to completion under exactly this set:
 *
 * - `PATH` — Codex resolves its own Linux sandbox helper and the `git` and shell tools the
 *   session runs from it. Removing it makes the engine unable to start its sandbox.
 * - `HOME` — required by `git`, by every tool the session may run, and by Node itself. It is
 *   **not** the operator's home: {@link engineStateLayout} points it at a ShipLoop-owned
 *   directory created for that attempt, so no operator credential resolves through `$HOME`.
 * - `TMPDIR` — where Codex and its sandbox stage files. Defaults to the OS temporary directory.
 * - `LANG` and `LC_ALL` — Codex refuses to assume a UTF-8 locale and prints
 *   `locale is not UTF-8 - unicode glyphs may render incorrectly` when neither is usable, so
 *   the operator's locale is forwarded rather than invented.
 * - `TZ` — timestamps in the engine's own output are rendered through it.
 * - `CODEX_HOME` — where Codex reads `auth.json` and writes rollouts. It points at a directory
 *   this product created, never at the operator's `~/.codex`; see the module comment for why
 *   inheriting that one would disable the sandbox.
 *
 * Deliberately absent, each because inheriting it hands the engine authority or a pointer to
 * authority: every other provider credential (`GH_TOKEN`, `LINEAR_API_KEY`, …), `DATABASE_URL`
 * (the authoritative store), the credential-FILE pointers (`NETRC`, `GIT_CONFIG_GLOBAL`,
 * `GIT_CONFIG_NOSYSTEM`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_SSH_COMMAND`, `SSH_AUTH_SOCK`,
 * `XDG_CONFIG_HOME`), the AWS profile selectors, the proxy variables (a proxy URL is a
 * credential and it redirects the engine's traffic), and any operator Codex override such as
 * `CODEX_MANAGED_BY_NPM` or `CONFIG_PROFILE`.
 */
export const ENGINE_ENVIRONMENT_VARIABLES = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'CODEX_HOME'] as const;

/** The engine's own state directory: its login, its rollouts, and nothing the operator wrote. */
export const ENGINE_CODEX_HOME_DIRECTORY = 'codex';

/** Per-attempt home directories live under here, one per workspace, never the operator's. */
export const ENGINE_HOME_DIRECTORY = 'home';

export interface EngineStateLayout {
  /** Absolute, ShipLoop-owned root. Created with mode 0700. */
  readonly stateRoot: string;
  /** `CODEX_HOME` for every attempt: one login, one rollout store, no operator config. */
  readonly codexHome: string;
  /** `HOME` for this attempt alone. */
  readonly home: string;
  /** The directory name the attempt key produced, for diagnostics. */
  readonly attemptKey: string;
}

/** The default state root: XDG state, never a temporary directory. */
export function defaultEngineStateRoot(parent: NodeJS.ProcessEnv = process.env): string {
  const xdg = parent['XDG_STATE_HOME'];
  const base = typeof xdg === 'string' && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'shiploop', 'codex');
}

/**
 * The directory key one attempt's `HOME` is derived from.
 *
 * The workspace path, not the operation id: an attempt that is interrupted and later resumed
 * reconnects to the same worktree (`<attemptRoot>/worktrees/<workspaceId>`), so the same attempt
 * finds the same `HOME`, while two concurrent attempts get two. A short digest is used because
 * a workspace path is a path, and a directory named after a path is a path traversal waiting to
 * happen.
 */
export function attemptKeyOf(attempt: string): string {
  return createHash('sha256').update(attempt).digest('hex').slice(0, 32);
}

/** Resolves the three directories one attempt runs against, without creating anything. */
export function engineStateLayout(options: {
  readonly stateRoot?: string | undefined;
  readonly attempt: string;
}): EngineStateLayout {
  const stateRoot = options.stateRoot ?? defaultEngineStateRoot();
  const attemptKey = attemptKeyOf(options.attempt);
  return {
    stateRoot,
    codexHome: join(stateRoot, ENGINE_CODEX_HOME_DIRECTORY),
    home: join(stateRoot, ENGINE_HOME_DIRECTORY, attemptKey),
    attemptKey,
  };
}

/**
 * Creates the directories the engine runs against and returns them.
 *
 * Mode 0700 because the state root holds the engine's login: a directory the operator's other
 * accounts can list is a directory they can read a credential out of. Idempotent, and it copies
 * the operator's `auth.json` when there is one and the destination has none or an older copy —
 * a token the operator re-authenticated in place would otherwise leave the engine holding a
 * refresh token that has already been consumed.
 *
 * A failure here is a refusal, not a warning: a run whose `CODEX_HOME` could not be created
 * would otherwise fall back to `~/.codex` and inherit that file's unrestricted sandbox mode.
 */
export function prepareEngineState(
  options: { readonly stateRoot?: string | undefined; readonly attempt: string; readonly seedAuthFrom?: string | null | undefined },
): Result<EngineStateLayout> {
  const layout = engineStateLayout(options);
  try {
    mkdirSync(layout.stateRoot, { recursive: true, mode: 0o700 });
    mkdirSync(layout.codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(layout.home, { recursive: true, mode: 0o700 });
    chmodSync(layout.home, 0o700);
  } catch (cause) {
    return err({
      code: 'Unavailable',
      reason: `the ShipLoop-owned engine state directory ${layout.stateRoot} could not be created (${describe(cause)}). Running without it would make the engine fall back to the operator's ~/.codex, whose config.toml sets an unrestricted sandbox_mode and approval_policy = "never" on this host, so the attempt is refused rather than started (F03-AC5).`,
    });
  }

  const source = options.seedAuthFrom === undefined ? operatorCodexAuthPath() : options.seedAuthFrom;
  if (source === null) return ok(layout);
  try {
    if (!existsSync(source)) return ok(layout);
    const sourceStat = statSync(source);
    const destination = join(layout.codexHome, 'auth.json');
    const destinationStat = existsSync(destination) ? statSync(destination) : null;
    if (destinationStat !== null && destinationStat.size === sourceStat.size && destinationStat.mtimeMs >= sourceStat.mtimeMs) {
      return ok(layout);
    }
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
  } catch (cause) {
    return err({
      code: 'Unavailable',
      reason: `the Codex login at ${source} could not be copied into ${layout.codexHome} (${describe(cause)}). Without it every run would be refused by the provider as unauthenticated, so this is reported rather than left to fail as a 401 (F03-AC5).`,
    });
  }
  return ok(layout);
}

/**
 * Where the operator keeps their Codex login, when they have one.
 *
 * Read from `CODEX_HOME` when the worker was started with it and from `~/.codex` otherwise,
 * because that is where `codex login` puts `auth.json`. Only the file name is used; the
 * operator's `config.toml` next to it is deliberately never copied.
 */
function operatorCodexAuthPath(parent: NodeJS.ProcessEnv = process.env): string | null {
  const configured = parent['CODEX_HOME'];
  const codexHome = typeof configured === 'string' && configured.length > 0 ? configured : join(homedir(), '.codex');
  return join(codexHome, 'auth.json');
}

/**
 * The child's entire environment: seven names, and the value of each is named here.
 *
 * `HOME` and `CODEX_HOME` are *computed*, never copied — copying the operator's `HOME` is
 * precisely the failure this function exists to prevent, and copying the operator's `CODEX_HOME`
 * would carry that unrestricted `sandbox_mode` with it.
 */
export function engineEnvironment(
  parent: NodeJS.ProcessEnv,
  layout: EngineStateLayout,
): NodeJS.ProcessEnv {
  const lang = parent['LANG'] ?? parent['LC_ALL'] ?? 'C.UTF-8';
  const environment: NodeJS.ProcessEnv = {
    PATH: parent['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: layout.home,
    TMPDIR: parent['TMPDIR'] ?? tmpdir(),
    LANG: lang,
    TZ: parent['TZ'] ?? 'UTC',
    CODEX_HOME: layout.codexHome,
  };
  // `LC_ALL` only when the operator set one: inventing it would override `LANG` and change the
  // engine's rendering, which is a configuration decision this adapter does not get to make.
  if (typeof parent['LC_ALL'] === 'string' && parent['LC_ALL'].length > 0) {
    environment['LC_ALL'] = parent['LC_ALL'];
  }
  return environment;
}

/**
 * Spawns any argv as the leader of its own process group, with an environment the caller chose.
 *
 * Exported separately from {@link CodexClient.start} so the shutdown contract can be proven
 * against a trivial `node -e` process group rather than by spending engine quota on every test
 * run. The Codex-specific argv and environment construction stay inside `start`, and this
 * function is the only place a process is ever created, so there is one implementation of
 * "detached, stdin closed, no shell, one tracked group" rather than two that could drift.
 *
 * `environment` is required rather than defaulted. A default of `process.env` here would put
 * the inheritance this module exists to remove back in one line, and it would be invisible.
 */
export function spawnTrackedGroup(
  argv: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Result<CodexProcess> {
  let child: CodexChildProcess;
  try {
    child = spawn(argv[0] ?? '', [...argv.slice(1)], {
      cwd,
      // A new process group led by this child, so every descendant is reachable through one group
      // signal and nothing outside the group is (F17-AC1).
      detached: true,
      // stdin is closed rather than piped: an engine handed an open stdin reads it, and a caller
      // that never writes would leave the session waiting on input it will never send.
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      // An explicit environment, never an inherited one. The engine runs as the same uid and can
      // read any file the worker can, so an inherited `GH_TOKEN`, `LINEAR_API_KEY`,
      // `DATABASE_URL` or `SSH_AUTH_SOCK` is authority handed to code the owner is being asked to
      // trust with their repository. The map is the allowlist in `engineEnvironment` and nothing
      // else reaches this child (F03-AC5, N02-AC3).
      env: environment,
    });
  } catch (cause) {
    return err({ code: 'Unavailable', reason: `the process could not be spawned (${describe(cause)})` });
  }
  // A binary that does not exist, or is not executable, emits `error` asynchronously and carries no
  // pid. The listener is attached before that can fire because an `error` event with no listener is
  // an unhandled exception, which would take the whole worker down instead of reporting one
  // unrunnable attempt.
  child.on('error', () => undefined);
  if (typeof child.pid !== 'number') {
    return err({
      code: 'Unavailable',
      reason: `the binary ${argv[0] ?? ''} was not started, so no process id exists to track or stop. It is missing, is not executable, or is not on PATH.`,
    });
  }
  return ok(wrapProcess(child, argv, cwd));
}

/**
 * Wraps a spawned child as a tracked process group.
 *
 * `lines()` is an async queue rather than a polling loop, so a long silent turn costs nothing
 * and a closed stdout ends the iteration deterministically instead of after a fixed delay.
 */
function wrapProcess(child: CodexChildProcess, argv: readonly string[], cwd: string): CodexProcess {
  const pid = child.pid as number;
  const queue: string[] = [];
  let buffer = '';
  let stderr = '';
  let closed = false;
  let waiter: (() => void) | null = null;
  let exitResult: { readonly exitCode: number | null; readonly signal: string | null } | null = null;
  let settleExit: (() => void) | null = null;

  const exited = new Promise<{ readonly exitCode: number | null; readonly signal: string | null }>((resolve) => {
    settleExit = () => resolve(exitResult ?? { exitCode: null, signal: null });
  });

  const wake = (): void => {
    const resume = waiter;
    waiter = null;
    resume?.();
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      queue.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
    wake();
  });
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < STDERR_TAIL_LIMIT) stderr += chunk;
  });
  child.on('error', (cause: Error) => {
    if (stderr.length < STDERR_TAIL_LIMIT) stderr += `${stderr.length > 0 ? '\n' : ''}${cause.message}`;
  });
  child.on('close', (code: number | null, signalName: NodeJS.Signals | null) => {
    if (buffer.length > 0) {
      queue.push(buffer);
      buffer = '';
    }
    closed = true;
    exitResult = { exitCode: code, signal: signalName };
    settleExit?.();
    wake();
  });

  return {
    pid,
    processGroupId: pid,
    argv,
    cwd,
    async *lines(): AsyncIterable<string> {
      let index = 0;
      for (;;) {
        while (index < queue.length) {
          const line = queue[index];
          index += 1;
          if (line !== undefined) yield line;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
    },
    stderrTail: (): string => stderr,
    waited: (): Promise<{ readonly exitCode: number | null; readonly signal: string | null }> => exited,
    requestGracefulStop: (): void => signalGroup(child, 'SIGTERM'),
    killProcessGroup: (): void => signalGroup(child, 'SIGKILL'),
    groupHasSurvivors: (): boolean => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    dispose: (): void => {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
    },
  };
}

/** What a stop attempt actually achieved, which is what F17-AC1 must be told. */
export interface CodexStopReport {
  /** The engine answered `SIGTERM` inside the graceful window. */
  readonly graceful: boolean;
  /** `SIGKILL` was needed to end the group. */
  readonly escalated: boolean;
  /** The process is confirmed gone. */
  readonly stopped: boolean;
  /** Whether a process still remains in the tracked group. */
  readonly survivors: boolean;
}

/**
 * Stops a session and reports which signal actually ended it.
 *
 * F17-AC1 permits a `Paused` report only once the writer is stopped or safely detached, so this
 * function never claims a stop it did not observe. A group that still has a member after
 * `SIGKILL` yields `stopped: false`, and the caller must report `Detached` with reconciliation
 * required rather than `Stopped` (F17-AC5).
 */
export async function stopCodexProcess(
  target: CodexProcess,
  options: { readonly gracefulStopMs?: number; readonly killWaitMs?: number } = {},
): Promise<CodexStopReport> {
  const gracefulMs = options.gracefulStopMs ?? DEFAULT_GRACEFUL_STOP_MS;
  const killMs = options.killWaitMs ?? DEFAULT_KILL_WAIT_MS;

  target.requestGracefulStop();
  if (await waitForExit(target.waited(), gracefulMs)) {
    return { graceful: true, escalated: false, stopped: true, survivors: !(await waitForEmptyGroup(target, killMs)) };
  }

  target.killProcessGroup();
  if (await waitForExit(target.waited(), killMs)) {
    return { graceful: false, escalated: true, stopped: true, survivors: !(await waitForEmptyGroup(target, killMs)) };
  }

  return { graceful: false, escalated: true, stopped: false, survivors: true };
}

/**
 * Waits, for a bounded window, until the tracked group holds no process.
 *
 * A single `kill(-pgid, 0)` immediately after the leader exits is a race, not an observation: a
 * descendant this adapter did not spawn is reaped by init, so the group can still hold a zombie
 * for a few milliseconds after the kill. Sampling once would report `Detached` for a group that
 * is in fact clean, which is the wrong answer in the direction that blocks an attempt. Polling to
 * a deadline is what makes `survivors: false` mean the group was **observed** empty.
 *
 * The sleep between samples is a referenced timer. This poll runs at the one moment nothing else
 * holds the event loop: the leader has been reaped, so the only handle left is this timer, and an
 * unreferenced one lets Node end the worker with `Detected unsettled top-level await` and exit 13
 * before the checkpoint is written. The bound is the deadline, not the timer's reference
 * (F17-AC1, F17-AC2).
 */
async function waitForEmptyGroup(target: CodexProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!target.groupHasSurvivors()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

/**
 * Waits, for a bounded window, until the child exits.
 *
 * The timeout is referenced for the same reason the group poll's sleep is: after the last process
 * handle is released, an unreferenced timeout is the only thing left, and Node would end the worker
 * before it could report whether the group actually stopped (F17-AC1, F17-AC2).
 */
async function waitForExit(
  waited: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const outcome = await Promise.race([waited.then(() => 'exited' as const), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome === 'exited';
}
