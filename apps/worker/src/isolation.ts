/**
 * The execution boundary between ShipLoop and the coding engine (F03-AC5, N02-AC3, F17-AC1).
 *
 * `docs/evidence/2026-10-01-credential-separation.md` measured what the engine subprocess could
 * reach before this module existed: it ran as the operator's own uid with the operator's `HOME`,
 * so `~/.config/gh/hosts.yml`, `~/.ssh/id_ed25519` and `~/.codex/config.toml` were readable and
 * `LINEAR_API_KEY` was inherited. Only the Codex sandbox's lack of network kept those from being
 * usable, and that is a property of one CLI's default rather than a boundary this product owns.
 * Scrubbing the environment (which `packages/adapters/src/codex/client.ts` now does) closes the
 * variable channel and leaves the filesystem channel open, because a file is readable by whoever
 * can read the directory it is in.
 *
 * **The mechanism is a dedicated execution uid.** It was chosen over the alternatives measured on
 * this VM because it is the smallest thing that closes the filesystem channel, needs no daemon, no
 * image and no namespace, and keeps the engine inside the workspace process group the existing
 * shutdown contract already signals:
 *
 *   - a mount namespace (`unshare --mount` plus bind mounts) still runs as the operator's uid, so
 *     anything the bind mounts miss — a new credential file, a socket, a path reached by a symlink
 *     — stays reachable, and hiding `/home/ubuntu` also hides the toolchain installed there;
 *   - a container (LXD is installed on this host) is the right answer for an untrusted third-party
 *     image, and costs a daemon, an image pipeline and a network policy to maintain for one engine
 *     this product already trusts to write only its own workspace;
 *   - a user namespace cannot be used for this at all, because a process in a child user namespace
 *     may not be signalled by the operator that spawned it, so the worker could not stop the group
 *     it is required to stop (F17-AC1).
 *
 * A different uid closes the directory channel by ordinary POSIX permissions, which is exactly the
 * property that has to hold: the engine's uid is not the operator's uid, so the operator's `HOME`
 * and everything under it are governed by modes that name the operator, and a per-attempt
 * `HOME` means the engine's own configuration — including any `sandbox_mode` the operator's
 * profile sets — is never read from the operator's tree.
 *
 * **Isolation is proved by launching, not by assumption.** `planIsolation` does not check that a
 * uid exists and then trust it: it hands the prepared workspace to the principal, creates the
 * per-attempt home, installs the launcher, and then *runs a probe through the real launcher* that
 * reports back which uid it became, which `HOME` it was given, which variable names survived, whether
 * its stdin is a terminal, whether it could write in the workspace, and whether any protected path
 * was readable. A probe that cannot be run, or that reports anything else, is a typed blocker and
 * no coding work is dispatched. There is deliberately no unisolated fallback: an engine that
 * silently ran as the operator would be the exact failure this module exists to prevent (F03-AC5).
 *
 * **The launcher is an executable, not a flag.** `packages/adapters` takes a single engine binary
 * and builds the rest of the argv, and this module may not change that package, so the principal
 * transition is installed as a ShipLoop-owned executable the adapter is pointed at. The script is
 * generated here, from the plan, and never edited by hand: it contains the transition, an
 * `env -i` environment built from nothing, and `exec` of the engine with the adapter's own argv
 * unchanged. `exec` matters — the launcher keeps the process-group leader's pid, so the group the
 * adapter tracks is the group the engine and every descendant of it belong to (F17-AC1).
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { blocked, err, invalid, ok } from '@shiploop/domain';
import type { ConnectorId, DomainError, ProviderId, Result } from '@shiploop/domain';
import type {
  AdapterCapabilities,
  AdapterCompatibility,
  AdapterContext,
  EngineAdapter,
  EngineContinuation,
  EngineSessionHandle,
  EngineStartRequest,
  EngineStopOutcome,
  ResumeEngineSessionRequest,
  StopEngineSessionRequest,
} from '@shiploop/adapters';

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

/** The identity the engine runs as, which is never the identity the worker runs as. */
export interface ExecutionPrincipal {
  readonly user: string;
  readonly uid: number;
  readonly gid: number;
}

/** How this process becomes the execution principal, decided by what it already is. */
export type PrincipalTransition =
  | { readonly kind: 'Setpriv'; readonly argv: readonly string[] }
  | { readonly kind: 'Sudo'; readonly argv: readonly string[] };

/**
 * Everything the launcher needs, parsed and validated once at the environment boundary.
 *
 * `operatorHome` and `databasePath` are the two paths that matter most and are named rather than
 * derived: the operator's home is whatever `$HOME` was when the worker started, and the database
 * is the single authoritative SQLite file, so both are protected paths by configuration and a
 * deployment that moved either gets the protection without a code change (F03-AC5).
 */
export interface IsolationSettings {
  readonly principal: ExecutionPrincipal;
  /** ShipLoop-owned root under which one home directory per attempt is created. */
  readonly engineHomeRoot: string;
  /**
   * ShipLoop-owned root under which one temporary directory per attempt is created.
   *
   * It is separate from the home root and configurable because the engine refuses to create its own
   * helper binaries under a path the operating system considers temporary, and it says so on every
   * start when the temporary directory is under `/tmp`. Naming a root outside `/tmp` keeps that
   * warning out of a session's own output, which is otherwise read as the engine starting degraded.
   */
  readonly engineTempRoot: string;
  /** ShipLoop-owned directory the launcher and probe executables are installed in. */
  readonly launcherRoot: string;
  /** Absolute path of the engine binary, reachable by the execution principal. */
  readonly engineBinary: string;
  readonly envBinary: string;
  readonly shellBinary: string;
  readonly chownBinary: string;
  readonly killBinary: string;
  readonly sudoBinary: string;
  readonly setprivBinary: string;
  /** `PATH` the engine is given. System paths only; nothing under the operator's home. */
  readonly enginePath: string;
  readonly language: string;
  readonly timeZone: string;
  readonly operatorHome: string | null;
  readonly databasePath: string | null;
  /** Further paths the engine must not be able to read, configured by the operator. */
  readonly protectedPaths: readonly string[];
  /** The uid this process runs as; a uid of 0 can transition with `setpriv` and no sudo. */
  readonly workerUid: number;
  readonly commandTimeoutMs: number;
}

const DEFAULT_ENGINE_PATH = '/usr/local/bin:/usr/bin:/bin';
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_LANGUAGE = 'C.UTF-8';
const DEFAULT_TIME_ZONE = 'UTC';
const DEFAULT_PRINCIPAL = 'shiploop-engine';
const ATTEMPT_ID = /^[A-Za-z0-9._-]{1,64}$/;
/**
 * What a configured path may contain, and it is an allowlist because these paths are written into a
 * generated shell script as single-quoted words.
 *
 * A path with a space, a quote or a metacharacter would have to be quoted correctly in two
 * different languages at once, and a launcher is the wrong place to be subtle. Refusing at the
 * configuration boundary names the problem where it can be fixed (F03-AC5).
 */
const SAFE_PATH = /^\/[A-Za-z0-9._+\/-]*$/;
const INTEGER = /^\d+$/;

/** The variable names the engine is given. Anything else is not forwarded from anywhere. */
export const ENGINE_ENVIRONMENT_NAMES: readonly string[] = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'TZ'];

/**
 * Variables a POSIX shell sets for itself, named here so their presence is expected rather than
 * explained away.
 *
 * The launcher runs the engine through `/bin/sh`, which sets `PWD`, `OLDPWD`, `SHLVL`, `IFS` and `_`
 * before it execs anything. None of them carries authority, and a preflight that treated them as a
 * leak would be a preflight an operator learns to ignore; the ones that matter are the credential-
 * shaped names, and any of those still refuses the dispatch.
 */
export const SHELL_INTRODUCED_ENVIRONMENT_NAMES: readonly string[] = ['PWD', 'OLDPWD', 'SHLVL', 'IFS', '_'];

/** Whether a variable name in the engine's environment was placed there on purpose. */
export function environmentNameIsExpected(name: string): boolean {
  return (
    ENGINE_ENVIRONMENT_NAMES.includes(name) ||
    SHELL_INTRODUCED_ENVIRONMENT_NAMES.includes(name) ||
    name.startsWith('SHIPLOOP_')
  );
}

/**
 * Reads the isolation settings from the environment (F03-AC5).
 *
 * The principal, the home root and the launcher root are required rather than defaulted, because
 * every plausible default is the operator's own identity or home: a launcher that guessed would
 * reproduce the exposure this module closes. `SHIPLOOP_ENGINE_PROTECTED_PATHS` is a colon-separated
 * addition to the two paths already protected, so a deployment with a credential store elsewhere
 * names it instead of editing this file.
 */
export function readIsolationSettings(env: NodeJS.ProcessEnv): Result<IsolationSettings, DomainError> {
  const errors: { readonly path: string; readonly message: string }[] = [];
  const workerUid = typeof process.getuid === 'function' ? process.getuid() : null;

  const uid = readInteger(env['SHIPLOOP_ENGINE_UID'], 'SHIPLOOP_ENGINE_UID', errors);
  const gid = readInteger(env['SHIPLOOP_ENGINE_GID'], 'SHIPLOOP_ENGINE_GID', errors);
  const engineHomeRoot = readAbsolute(env['SHIPLOOP_ENGINE_HOME_ROOT'], 'SHIPLOOP_ENGINE_HOME_ROOT', true, errors);
  const engineTempRoot = readAbsolute(
    env['SHIPLOOP_ENGINE_TEMP_ROOT'] ?? (engineHomeRoot === null ? undefined : join(engineHomeRoot, 'tmp')),
    'SHIPLOOP_ENGINE_TEMP_ROOT',
    true,
    errors,
  );
  const launcherRoot = readAbsolute(env['SHIPLOOP_ENGINE_LAUNCHER_ROOT'], 'SHIPLOOP_ENGINE_LAUNCHER_ROOT', true, errors);
  const engineBinary = readAbsolute(env['SHIPLOOP_ENGINE_BINARY'], 'SHIPLOOP_ENGINE_BINARY', true, errors);
  const databasePath = readAbsolute(env['SHIPLOOP_ENGINE_DATABASE_PATH'], 'SHIPLOOP_ENGINE_DATABASE_PATH', false, errors);

  if (uid !== null && uid === workerUid) {
    errors.push({
      path: 'SHIPLOOP_ENGINE_UID',
      message:
        'The execution principal must not be the uid this worker runs as. A worker whose engine shares its uid can read every file the worker can, which is the boundary this configuration exists to establish (F03-AC5).',
    });
  }

  if (
    errors.length > 0 ||
    uid === null ||
    gid === null ||
    engineHomeRoot === null ||
    engineTempRoot === null ||
    launcherRoot === null ||
    engineBinary === null
  ) {
    return err(
      invalid(
        'The execution isolation settings are not usable, so no coding work may be dispatched (F03-AC5).',
        errors,
      ),
    );
  }

  return ok({
    principal: {
      user: text(env['SHIPLOOP_ENGINE_PRINCIPAL']) ?? DEFAULT_PRINCIPAL,
      uid,
      gid,
    },
    engineHomeRoot,
    engineTempRoot,
    launcherRoot,
    engineBinary,
    envBinary: text(env['SHIPLOOP_ENGINE_ENV_BINARY']) ?? '/usr/bin/env',
    shellBinary: text(env['SHIPLOOP_ENGINE_SHELL_BINARY']) ?? '/bin/sh',
    chownBinary: text(env['SHIPLOOP_ENGINE_CHOWN_BINARY']) ?? '/usr/bin/chown',
    killBinary: text(env['SHIPLOOP_ENGINE_KILL_BINARY']) ?? '/bin/kill',
    sudoBinary: text(env['SHIPLOOP_ENGINE_SUDO_BINARY']) ?? '/usr/bin/sudo',
    setprivBinary: text(env['SHIPLOOP_ENGINE_SETPRIV_BINARY']) ?? '/usr/bin/setpriv',
    enginePath: text(env['SHIPLOOP_ENGINE_PATH']) ?? DEFAULT_ENGINE_PATH,
    language: text(env['SHIPLOOP_ENGINE_LANG']) ?? DEFAULT_LANGUAGE,
    timeZone: text(env['SHIPLOOP_ENGINE_TZ']) ?? DEFAULT_TIME_ZONE,
    operatorHome: text(env['SHIPLOOP_ENGINE_OPERATOR_HOME']) ?? text(env['HOME']),
    databasePath,
    protectedPaths: listOf(env['SHIPLOOP_ENGINE_PROTECTED_PATHS']),
    workerUid: workerUid ?? -1,
    commandTimeoutMs: readInteger(env['SHIPLOOP_ENGINE_COMMAND_TIMEOUT_MS'], 'SHIPLOOP_ENGINE_COMMAND_TIMEOUT_MS', errors) ?? DEFAULT_COMMAND_TIMEOUT_MS,
  });
}

/** Every path the engine must not be able to read, in the order the probe checks them. */
export function protectedPathsOf(settings: IsolationSettings, extra: readonly string[] = []): readonly string[] {
  const candidates = [settings.operatorHome, settings.databasePath, ...settings.protectedPaths, ...extra];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (candidate === null || candidate.trim() === '') continue;
    const path = resolvePathOf(candidate);
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/**
 * Whether the environment configures isolation at all.
 *
 * Absent is one answer and invalid is another, and they are not the same answer: an environment with
 * no `SHIPLOOP_ENGINE_*` variable has not asked for isolation, while an environment with some of them
 * has asked and got it wrong, which is a configuration fault to report rather than a worker that
 * quietly runs the engine as the operator. `ISOLATION_VARIABLES` is the complete list, so a
 * misspelled variable is caught instead of looking like an unconfigured deployment.
 */
export const ISOLATION_VARIABLES: readonly string[] = [
  'SHIPLOOP_ENGINE_PRINCIPAL',
  'SHIPLOOP_ENGINE_UID',
  'SHIPLOOP_ENGINE_GID',
  'SHIPLOOP_ENGINE_HOME_ROOT',
  'SHIPLOOP_ENGINE_TEMP_ROOT',
  'SHIPLOOP_ENGINE_LAUNCHER_ROOT',
  'SHIPLOOP_ENGINE_BINARY',
  'SHIPLOOP_ENGINE_PROTECTED_PATHS',
  'SHIPLOOP_ENGINE_DATABASE_PATH',
  'SHIPLOOP_ENGINE_OPERATOR_HOME',
  'SHIPLOOP_ENGINE_ENV_BINARY',
  'SHIPLOOP_ENGINE_SHELL_BINARY',
  'SHIPLOOP_ENGINE_CHOWN_BINARY',
  'SHIPLOOP_ENGINE_KILL_BINARY',
  'SHIPLOOP_ENGINE_SUDO_BINARY',
  'SHIPLOOP_ENGINE_SETPRIV_BINARY',
  'SHIPLOOP_ENGINE_PATH',
  'SHIPLOOP_ENGINE_LANG',
  'SHIPLOOP_ENGINE_TZ',
  'SHIPLOOP_ENGINE_COMMAND_TIMEOUT_MS',
];

/** The isolation settings, or null when the environment asked for no isolation at all. */
export function readIsolationConfiguration(env: NodeJS.ProcessEnv): Result<IsolationSettings | null, DomainError> {
  const mentioned = ISOLATION_VARIABLES.filter((name) => text(env[name]) !== null);
  if (mentioned.length === 0) return ok(null);
  return readIsolationSettings(env);
}

/* -------------------------------------------------------------------------- */
/* The transition and the argv it produces                                      */
/* -------------------------------------------------------------------------- */

/**
 * The transition this process uses to become the execution principal.
 *
 * A process that is already root uses `setpriv` and needs nothing else; anything else uses
 * `sudo -n`, which fails rather than prompting when no passwordless rule exists — and a launcher
 * that waited for a password would hang an attempt instead of refusing it, so `-n` is not optional.
 */
export function principalTransition(settings: IsolationSettings): PrincipalTransition {
  if (settings.workerUid === 0) {
    return {
      kind: 'Setpriv',
      argv: [
        settings.setprivBinary,
        `--reuid=${String(settings.principal.uid)}`,
        `--regid=${String(settings.principal.gid)}`,
        '--init-groups',
        '--',
      ],
    };
  }
  return { kind: 'Sudo', argv: [settings.sudoBinary, '-n', '-u', settings.principal.user, '--'] };
}

/** One command to run as the execution principal. */
export interface IsolatedLaunch {
  readonly program: string;
  readonly args: readonly string[];
  /** The ShipLoop-owned home this command is given. Never the operator's. */
  readonly home: string;
  /** Additional `NAME=value` pairs the engine legitimately needs, such as its workspace. */
  readonly extraEnvironment?: Readonly<Record<string, string>>;
}

/**
 * The full argv for one isolated command.
 *
 * `env -i` is what makes the environment an allowlist rather than a scrub: the transition runs first
 * — it has to, because only it can change the uid — and everything after it starts from an empty
 * environment, so `LINEAR_API_KEY`, `SSH_AUTH_SOCK` and any variable the operator exports after this
 * was written are absent by construction rather than by name. `HOME` is passed explicitly because
 * changing the uid does not change the environment, so without this the engine would still be told
 * the operator's home (F03-AC5).
 */
export function isolatedArgv(settings: IsolationSettings, launch: IsolatedLaunch): readonly string[] {
  const environment = [
    `HOME=${launch.home}`,
    `PATH=${settings.enginePath}`,
    `TMPDIR=${join(launch.home, 'tmp')}`,
    `LANG=${settings.language}`,
    `TZ=${settings.timeZone}`,
    ...Object.entries(launch.extraEnvironment ?? {}).map(([name, value]) => `${name}=${value}`),
  ];
  return [...principalTransition(settings).argv, settings.envBinary, '-i', ...environment, launch.program, ...launch.args];
}

/* -------------------------------------------------------------------------- */
/* Tracked process groups                                                      */
/* -------------------------------------------------------------------------- */

/** A process this module spawned as the leader of its own group (F17-AC1). */
export interface TrackedChild {
  readonly pid: number;
  /** Equal to the pid, because the child was spawned detached. */
  readonly processGroupId: number;
  /** Everything the child wrote to stdout, bounded. */
  output(): string;
  /** Everything the child wrote to stderr, bounded. */
  errorOutput(): string;
  /** Resolves once the child has exited or the deadline passed. Never rejects. */
  finished(): Promise<TrackedExit>;
}

export interface TrackedExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface GroupStopReport {
  /** Which signal, if any, was needed. `Exited` means the group was already gone. */
  readonly endedBy: 'Exited' | 'SIGTERM' | 'SIGKILL';
  /** Pids still in the group after the stop. A non-empty list is never reported as stopped. */
  readonly survivors: readonly number[];
}

export interface GroupStopOptions {
  readonly gracefulStopMs: number;
  readonly killWaitMs: number;
  /**
   * How to signal a group this process may not signal itself.
   *
   * Measured on this VM: a signal sent by the operator to a group whose members run as the
   * execution principal is skipped for exactly those members, so `SIGTERM` and `SIGKILL` both leave
   * an isolated engine running. Only a privileged transition can signal them, which is why the stop
   * path carries the same transition the launch path used. Without this an isolated attempt could
   * never be stopped, and F17-AC1's contract would be a claim rather than a fact.
   */
  readonly transition?: PrincipalTransition;
  /** `/bin/kill`, used by the escalated path. */
  readonly killBinary?: string;
}

const OUTPUT_LIMIT = 64 * 1024;

/**
 * Spawns one command as the leader of a new process group.
 *
 * `detached` is what makes the group exist, and every descendant the command starts inherits that
 * group id, so one signal reaches the whole tree. Nothing here matches on a command name, a port or
 * a pattern: a group is reached only through the pid this spawn returned (F17-AC1, F17-AC5).
 */
export function launchTrackedGroup(
  argv: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): Result<TrackedChild, DomainError> {
  const leader = argv[0] ?? '';
  let child;
  try {
    child = spawn(leader, [...argv.slice(1)], {
      cwd: options.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  } catch (cause) {
    return err({ code: 'Unavailable', reason: `The isolated command ${leader} could not be spawned: ${describe(cause)}` });
  }
  child.on('error', () => undefined);
  if (typeof child.pid !== 'number') {
    return err({
      code: 'Unavailable',
      reason: `The isolated command ${leader} did not start, so no process group exists to track or stop. It is missing, is not executable, or the transition refused it.`,
    });
  }

  const pid = child.pid;
  let stdout = '';
  let stderr = '';
  let settled: TrackedExit | null = null;
  let resolveExit: (exit: TrackedExit) => void = () => undefined;
  const exited = new Promise<TrackedExit>((resolve) => {
    resolveExit = resolve;
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
  });
  child.on('error', (cause: Error) => {
    if (settled !== null) return;
    settled = { exitCode: null, signal: null };
    resolveExit(settled);
    stderr += `${stderr.length > 0 ? '\n' : ''}${cause.message}`;
  });
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled !== null) return;
    settled = { exitCode: code, signal };
    resolveExit(settled);
  });

  return ok({
    pid,
    processGroupId: pid,
    output: () => stdout,
    errorOutput: () => stderr,
    finished: () => exited,
  });
}

/** Whether any process remains in a group. `EPERM` counts as remaining: it is alive, not ours. */
export function groupIsAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

/**
 * Stops a tracked group: `SIGTERM` to the group, a bounded wait, then `SIGKILL` to the same group.
 *
 * The group is the only handle used. A name or a port is not a handle: it would reach a process
 * belonging to somebody else, and a group id is the one identity this spawn owns. Survivors are
 * reported rather than assumed away, because a group that outlives the kill is a detached writer
 * and the caller must not conclude the attempt stopped (F17-AC1, F17-AC5).
 */
export async function stopTrackedGroup(
  child: TrackedChild,
  options: GroupStopOptions,
): Promise<Result<GroupStopReport, DomainError>> {
  const groupId = child.processGroupId;
  if (!groupIsAlive(groupId)) {
    return ok({ endedBy: 'Exited', survivors: [] });
  }

  const escalate = async (signal: NodeJS.Signals): Promise<void> => {
    if (options.transition === undefined) {
      signalGroup(groupId, signal);
      return;
    }
    await runBounded([...options.transition.argv, options.killBinary ?? '/bin/kill', '-s', signal, '--', `-${String(groupId)}`], {
      cwd: '/',
      timeoutMs: 10_000,
    });
  };

  await escalate('SIGTERM');
  await withinMs(child.finished(), options.gracefulStopMs);
  if (!groupIsAlive(groupId)) {
    return ok({ endedBy: 'SIGTERM', survivors: [] });
  }

  await escalate('SIGKILL');
  await withinMs(child.finished(), options.killWaitMs);
  return ok({ endedBy: 'SIGKILL', survivors: groupIsAlive(groupId) ? [groupId] : [] });
}

/** Signals one group directly, for a group this process owns. */
function signalGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch {
    /* already gone, which is the state the caller asked for */
  }
}

/**
 * Stops the group an isolated engine leads, read from the file its launcher wrote.
 *
 * The inner adapter signals the tracked group itself, and after the principal transition that signal
 * does not reach the engine — measured, not assumed — so this escalates through the same transition.
 * A file that names nothing, or names a group that is already gone, is reported rather than invented:
 * the wrapper never claims a group it did not observe (F17-AC1, F17-AC5).
 */
export async function stopIsolatedGroup(
  groupFilePath: string,
  options: GroupStopOptions,
): Promise<Result<{ readonly groupId: number; readonly endedBy: GroupStopReport['endedBy']; readonly survivors: readonly number[] }, DomainError>> {
  const recorded = await readGroupFile(groupFilePath);
  if (recorded === null) {
    return err({
      code: 'NotFound',
      reason: `No engine process group was recorded at ${groupFilePath}, so this process has no group to stop. Nothing is asserted about a group this launcher never reported (F17-AC5).`,
    });
  }
  const report = await stopTrackedGroup(
    {
      pid: recorded,
      processGroupId: recorded,
      output: (): string => '',
      errorOutput: (): string => '',
      finished: (): Promise<TrackedExit> => Promise.resolve({ exitCode: null, signal: null }),
    },
    options,
  );
  if (!report.ok) return err(report.error);
  return ok({ groupId: recorded, endedBy: report.value.endedBy, survivors: report.value.survivors });
}

/** The group id a launcher recorded, or null when it recorded none. */
export async function readGroupFile(groupFilePath: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(groupFilePath, 'utf8');
  } catch {
    return null;
  }
  const value = Number(raw.trim());
  return Number.isInteger(value) && value > 1 ? value : null;
}

/** A deadline that resolves rather than rejecting, so no cleanup path can hang a worker. */
async function withinMs(
  finished: Promise<TrackedExit>,
  timeoutMs: number,
): Promise<{ readonly settled: boolean; readonly exit: TrackedExit | null }> {
  let timer: NodeJS.Timeout | null = null;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const exit = await Promise.race([finished, deadline]);
  if (timer !== null) clearTimeout(timer);
  return { settled: exit !== null, exit };
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                    */
/* -------------------------------------------------------------------------- */

/** What the launched probe reported about itself, parsed from its own output. */
export interface IsolationProbeReport {
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
  readonly groups: string;
  /** Variable names the engine was given. A name that must not be there is the failure. */
  readonly environmentNames: readonly string[];
  /** True when the engine was handed an interactive stdin, which would let a turn block on input. */
  readonly stdinIsTerminal: boolean;
  /** Whether the engine binary itself is reachable by the execution principal. */
  readonly engineExecutable: boolean;
  /**
   * Whether the probe could write in the workspace, and removed what it wrote.
   *
   * A boolean rather than a path because the marker is deleted again: the probe runs inside the
   * attempt's own worktree, and an untracked file left there would appear in the attempt's
   * checkpoint inventory and make a no-code run look like a change (F14-AC4, F19-AC5).
   */
  readonly wroteInWorkspace: boolean;
  /** Protected paths the probe could read. Every one of them is a refusal to dispatch. */
  readonly readable: readonly string[];
}

/** Everything one attempt's launch needs, established by a probe that really ran. */
export interface IsolationPlan {
  readonly principal: ExecutionPrincipal;
  readonly attemptId: string;
  readonly workspacePath: string;
  readonly homePath: string;
  readonly launcherPath: string;
  /** Where the launcher records the process group it leads, one path per attempt (F17-AC1). */
  readonly groupFilePath: string;
  readonly environmentNames: readonly string[];
  readonly report: IsolationProbeReport;
}

export interface IsolationRequest {
  /** A stable, path-safe identifier for the attempt; the workspace id is the natural one. */
  readonly attemptId: string;
  /** The worktree the engine is allowed to write in. */
  readonly workspacePath: string;
  /** Further paths the engine must not read, beyond the configured ones. */
  readonly additionalProtectedPaths?: readonly string[];
}

const PROBE_MARKER = '.shiploop-isolation-probe';

/**
 * Establishes the boundary for one attempt, or refuses to dispatch coding work (F03-AC5).
 *
 * The order is deliberate and each step can refuse:
 *
 *   1. the workspace is handed to the principal, because a workspace the engine cannot write in is
 *      not a workspace it can do its job in;
 *   2. the per-attempt home is created, owned by the principal alone;
 *   3. the launcher and the probe are installed where the principal cannot rewrite them — a
 *      launcher the engine can edit is not a launcher;
 *   4. a probe runs *through the launcher* and reports what it became;
 *   5. the report is checked against what was asked for, and anything else is a blocker.
 *
 * Every refusal is a `Blocked` error carrying the exact remedy, because "the engine could not be
 * isolated" is an operator's problem to fix and a retry would repeat it identically (F18-AC5).
 */
export async function planIsolation(settings: IsolationSettings, request: IsolationRequest): Promise<Result<IsolationPlan, DomainError>> {
  if (!ATTEMPT_ID.test(request.attemptId)) {
    return err(
      invalid('The attempt identity cannot name a per-attempt home directory.', [
        {
          path: 'attemptId',
          message: 'Expected 1 to 64 characters of A-Z, a-z, 0-9, dot, underscore or hyphen, because the name becomes a path.',
        },
      ]),
    );
  }
  if (!isAbsolute(request.workspacePath)) {
    return err(
      invalid('The workspace path is not absolute, so the engine could not be given a bounded place to write.', [
        { path: 'workspacePath', message: 'Expected an absolute path to the prepared worktree (F14-AC1).' },
      ]),
    );
  }

  const homePath = join(settings.engineHomeRoot, request.attemptId, 'home');
  const tempPath = join(settings.engineTempRoot, request.attemptId);
  const prerequisites: { readonly name: string; readonly detail: string; readonly remedy: string }[] = [];

  const workspaceExists = await pathExists(request.workspacePath);
  if (!workspaceExists) {
    return err(
      blocked('The workspace this attempt would run in does not exist, so no engine was dispatched.', [
        {
          name: 'workspace',
          detail: `${request.workspacePath} is not present.`,
          remedy: 'Prepare the workspace before dispatching an attempt; a launcher that creates it would be guessing where work belongs (F14-AC1).',
        },
      ]),
    );
  }

  const owned = await handWorkspaceToPrincipal(settings, request.workspacePath);
  if (!owned.ok) return owned;

  const home = await createPrincipalDirectory(settings, homePath, 'the ShipLoop-owned engine home');
  if (!home.ok) return home;
  const temporary = await createPrincipalDirectory(settings, tempPath, 'the ShipLoop-owned engine temporary directory');
  if (!temporary.ok) return temporary;

  /**
   * The launcher and the probe are named with a token, not only with the attempt id.
   *
   * Two attempts of the same job would otherwise overwrite each other's launcher, and a group file
   * left behind by a finished session could name a pid the kernel has since given to something else
   * — which is precisely the "signal something by a name that might be reused" mistake the process
   * group contract exists to prevent (F17-AC1, F17-AC5).
   */
  const token = randomUUID().replace(/-/g, '').slice(0, 16);
  const launcherPath = join(settings.launcherRoot, `engine-launcher-${request.attemptId}-${token}.sh`);
  const probePath = join(settings.launcherRoot, `isolation-probe-${request.attemptId}-${token}.sh`);
  const groupFilePath = join(settings.launcherRoot, `engine-group-${request.attemptId}-${token}.pid`);
  const installed = await installExecutables(settings, { launcherPath, probePath, groupFilePath, homePath, tempPath, attemptId: request.attemptId });
  if (!installed.ok) return installed;

  const probe = await runProbe(settings, { probePath, launcherPath, homePath, attemptId: request.attemptId, request });
  if (!probe.ok) return probe;
  const report = probe.value;

  if (report.uid !== settings.principal.uid || report.gid !== settings.principal.gid) {
    prerequisites.push({
      name: 'execution-principal',
      detail: `The launched command ran as uid ${String(report.uid)} gid ${String(report.gid)}, not the configured ${settings.principal.user} ${String(settings.principal.uid)}:${String(settings.principal.gid)}.`,
      remedy: 'Check that the principal exists (getent passwd ' + settings.principal.user + ') and that the transition in ' + principalTransition(settings).kind + ' form is permitted for this worker.',
    });
  }
  if (report.home !== homePath) {
    prerequisites.push({
      name: 'engine-home',
      detail: `The launched command was given HOME=${report.home} rather than the ShipLoop-owned ${homePath}.`,
      remedy: 'The engine must not inherit the operator\'s HOME, or it reads the operator\'s Codex configuration and therefore its sandbox settings (F03-AC5).',
    });
  }
  if (!report.engineExecutable) {
    prerequisites.push({
      name: 'engine-binary',
      detail: `${settings.engineBinary} is not readable and executable by ${settings.principal.user}, so the principal could not run the engine at all.`,
      remedy: `Install the engine at a path the execution principal can read and execute, and point SHIPLOOP_ENGINE_BINARY at it. A copy the operator owns inside its own home is not reachable once the engine runs as somebody else (F03-AC5, F04-AC2).`,
    });
  }
  if (report.stdinIsTerminal) {
    prerequisites.push({
      name: 'engine-stdin',
      detail: 'The launched command was handed an interactive terminal on stdin, which would let a turn block waiting for input nobody will send.',
      remedy: 'Remove any `use_pty` sudoers default for this transition; the launcher is spawned with stdin closed.',
    });
  }
  if (!report.wroteInWorkspace) {
    prerequisites.push({
      name: 'workspace-write',
      detail: `The launched command could not write ${join(request.workspacePath, PROBE_MARKER)}.`,
      remedy: `Give ${settings.principal.user} ownership of the attempt root (${request.workspacePath}) so the workspace is writable by the principal that works in it.`,
    });
  }
  for (const path of report.readable) {
    prerequisites.push({
      name: 'protected-path',
      detail: `The launched command could read ${path}, which is an operator credential or the authoritative store.`,
      remedy: `Tighten the permissions on ${path} so only the operator's identity can read it, or set SHIPLOOP_ENGINE_PROTECTED_PATHS to the paths that must be hidden (F03-AC5, N02-AC3).`,
    });
  }
  const unexpected = report.environmentNames.filter((name) => !environmentNameIsExpected(name));
  for (const name of unexpected) {
    prerequisites.push({
      name: 'engine-environment',
      detail: `The launched command was given the variable ${name}, which this launcher does not place in its environment.`,
      remedy: 'A variable reaching the engine has come from somewhere other than the launcher; the transition and the argv it builds must be the only path into that environment (F03-AC5).',
    });
  }

  if (prerequisites.length > 0) {
    return err(
      blocked(
        `The coding engine cannot be isolated as ${settings.principal.user} on this host, so no coding work was dispatched (F03-AC5).`,
        prerequisites,
      ),
    );
  }

  return ok({
    principal: settings.principal,
    attemptId: request.attemptId,
    workspacePath: request.workspacePath,
    homePath,
    tempPath,
    launcherPath,
    groupFilePath,
    environmentNames: report.environmentNames,
    report,
  });
}

/** Hands the prepared workspace to the principal, so writing in it is the engine's own right. */
async function handWorkspaceToPrincipal(settings: IsolationSettings, workspacePath: string): Promise<Result<null, DomainError>> {
  if (settings.workerUid === 0) {
    return runBounded([settings.chownBinary, '-R', `${String(settings.principal.uid)}:${String(settings.principal.gid)}`, workspacePath], {
      cwd: '/',
      timeoutMs: settings.commandTimeoutMs,
    }).then((outcome) =>
      outcome.ok
        ? ok(null)
        : err(
            blocked('The prepared workspace could not be handed to the execution principal.', [
              {
                name: 'workspace-ownership',
                detail: outcome.error.reason,
                remedy: `Run: ${settings.chownBinary} -R ${String(settings.principal.uid)}:${String(settings.principal.gid)} ${workspacePath}`,
              },
            ]),
          ),
    );
  }
  return runBounded(
    [settings.sudoBinary, '-n', settings.chownBinary, '-R', `${String(settings.principal.uid)}:${String(settings.principal.gid)}`, workspacePath],
    { cwd: '/', timeoutMs: settings.commandTimeoutMs },
  ).then((outcome) =>
    outcome.ok
      ? ok(null)
      : err(
          blocked('The prepared workspace could not be handed to the execution principal.', [
            {
              name: 'workspace-ownership',
              detail: outcome.error.reason,
              remedy: `Allow this worker to chown an attempt root to ${settings.principal.user}, or pre-create the attempt root owned by that principal. Without it the engine cannot write in the workspace it was assigned.`,
            },
          ]),
        ),
  );
}

/**
 * Creates one ShipLoop-owned directory for the principal, readable by nobody else.
 *
 * Ownership and mode are verified after the fact rather than assumed from the `mkdir` mode argument:
 * `mkdir` applies the process umask, and a directory that came out group-readable is a directory
 * another identity on this host could read an engine's scratch state out of.
 */
async function createPrincipalDirectory(settings: IsolationSettings, path: string, what: string): Promise<Result<string, DomainError>> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (cause) {
    return err(homeRefusal(`${path} could not be created: ${describe(cause)}`, settings, path, what));
  }

  const chown = await runBounded(
    settings.workerUid === 0
      ? [settings.chownBinary, '-R', `${String(settings.principal.uid)}:${String(settings.principal.gid)}`, path]
      : [settings.sudoBinary, '-n', settings.chownBinary, '-R', `${String(settings.principal.uid)}:${String(settings.principal.gid)}`, path],
    { cwd: '/', timeoutMs: settings.commandTimeoutMs },
  );
  if (!chown.ok) return err(homeRefusal(chown.error.reason, settings, path, what));

  const observed = await describePath(path);
  if (!observed.ok) return err(observed.error);
  if (observed.value.uid !== settings.principal.uid || (observed.value.mode & 0o077) !== 0) {
    return err(
      homeRefusal(
        `${path} is owned by uid ${String(observed.value.uid)} with mode ${modeText(observed.value.mode)}, not exclusively by ${String(settings.principal.uid)} with no group or other access.`,
        settings,
        path,
        what,
      ),
    );
  }
  return ok(path);
}

function homeRefusal(detail: string, settings: IsolationSettings, path: string, what: string): DomainError {
  return blocked(`${capitalise(what)} for this attempt could not be established.`, [
    {
      name: 'engine-directory',
      detail,
      remedy: `Pre-create ${path} owned by uid ${String(settings.principal.uid)} with mode 0700, or create its parent owned by ${settings.principal.user}. The engine must have directories of its own and must not have the operator's (F03-AC5).`,
    },
  ]);
}

function capitalise(text: string): string {
  return text === '' ? text : `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}

/**
 * Writes the launcher and the probe, and proves the principal cannot rewrite either.
 *
 * A launcher the engine principal can modify is not a boundary at all: the next attempt would read
 * whatever the previous one wrote there. Both files are therefore created with no group or other
 * write bit and owned by somebody other than the principal, and that is checked rather than assumed.
 */
async function installExecutables(
  settings: IsolationSettings,
  plan: {
    readonly launcherPath: string;
    readonly probePath: string;
    readonly groupFilePath: string;
    readonly homePath: string;
    readonly tempPath: string;
    readonly attemptId: string;
  },
): Promise<Result<null, DomainError>> {
  try {
    await mkdir(settings.launcherRoot, { recursive: true, mode: 0o755 });
    await chmod(settings.launcherRoot, 0o755);
  } catch (cause) {
    return err({ code: 'Unavailable', reason: `The ShipLoop-owned launcher root ${settings.launcherRoot} could not be created: ${describe(cause)}` });
  }

  const files: readonly { readonly path: string; readonly contents: string }[] = [
    {
      path: plan.launcherPath,
      contents: launcherScript(settings, {
        homePath: plan.homePath,
        tempPath: plan.tempPath,
        attemptId: plan.attemptId,
        probePath: plan.probePath,
        groupFilePath: plan.groupFilePath,
      }),
    },
    { path: plan.probePath, contents: probeScript() },
  ];
  for (const file of files) {
    try {
      await writeFile(file.path, file.contents, { mode: 0o755 });
      await chmod(file.path, 0o755);
    } catch (cause) {
      return err({ code: 'Unavailable', reason: `The launcher could not be installed at ${file.path}: ${describe(cause)}` });
    }
  }

  for (const path of [settings.launcherRoot, plan.launcherPath, plan.probePath]) {
    const described = await describePath(path);
    if (!described.ok) return err(described.error);
    const { uid, mode } = described.value;
    if (uid === settings.principal.uid || (mode & 0o022) !== 0) {
      return err(
        blocked(`The execution principal can rewrite ${path}, so the launcher is not a boundary.`, [
          {
            name: 'launcher-integrity',
            detail: `${path} is owned by uid ${String(uid)} with mode ${modeText(mode)}.`,
            remedy: `Install ${settings.launcherRoot} owned by the worker, mode 0755, so ${settings.principal.user} can read the launcher but never write it (F03-AC5).`,
          },
        ]),
      );
    }
  }
  return ok(null);
}

/**
 * The launcher executable the engine adapter is pointed at.
 *
 * It is a shell script because it has to be a single executable path: `packages/adapters` builds
 * the engine argv and takes one binary, and it is not this module's to change. Everything the
 * script decides is decided here — the transition, the empty environment, the home, the engine
 * binary — and `"$@"` is the adapter's own argv, passed through unchanged and never interpreted.
 * `exec` keeps the process-group leader's pid, so the group the adapter signals is the engine's.
 */
function launcherScript(
  settings: IsolationSettings,
  plan: {
    readonly homePath: string;
    readonly tempPath: string;
    readonly attemptId: string;
    readonly probePath: string;
    readonly groupFilePath: string;
  },
): string {
  const transition = principalTransition(settings).argv
    .map((word) => `'${word.replace(/'/g, `'\\''`)}'`)
    .join(' ');
  const environment = [
    "'HOME=" + plan.homePath + "'",
    "'PATH=" + settings.enginePath + "'",
    "'TMPDIR=" + plan.tempPath + "'",
    "'LANG=" + settings.language + "'",
    "'TZ=" + settings.timeZone + "'",
    "'SHIPLOOP_ATTEMPT_ID=" + plan.attemptId + "'",
  ].join(' \\\n  ');
  const enter = transition + " '" + settings.envBinary + "' -i \\\n  " + environment;
  return [
    '#!/bin/sh',
    '# ShipLoop engine launcher. Generated by apps/worker/src/isolation.ts; do not edit by hand.',
    '# The engine runs as ' + settings.principal.user + ' (' + String(settings.principal.uid) + ':' + String(settings.principal.gid) + ')',
    '# with HOME=' + plan.homePath + ' and an environment built from nothing by `env -i`.',
    'set -e',
    '# The preflight proves the boundary by running itself through this launcher, so what is verified',
    '# is the executable the engine adapter is pointed at rather than a separate code path.',
    'if [ "${1:-}" = \'--shiploop-isolation-probe\' ]; then',
    '  shift',
    '  exec ' + enter + " \\\n  '" + settings.shellBinary + "' '" + plan.probePath + "' \"$@\"",
    'fi',
    '# The process group this engine leads, recorded before the transition because after it this',
    '# process cannot signal the group it started. $$ is the launcher\'s own pid, and the launcher',
    '# leads the group, so this is the group id and not a name or a port (F17-AC1).',
    "printf '%s\\n' \"$$\" > '" + plan.groupFilePath + "'",
    'exec ' + enter + " \\\n  '" + settings.engineBinary + "' \"$@\"",
    '',
  ].join('\n');
}

/**
 * The probe the preflight runs through the launcher.
 *
 * It reports identity, home, variable names, whether stdin is a terminal, whether the workspace is
 * writable and which protected paths were readable — and it never prints what it read. A probe that
 * leaked the content of a file it should not have been able to open would turn a diagnostic into a
 * disclosure, so every read here is discarded to `/dev/null` and only the verdict is emitted.
 */
function probeScript(): string {
  return [
    '#!/bin/sh',
    '# ShipLoop isolation probe. Generated by apps/worker/src/isolation.ts; do not edit by hand.',
    'engine=$1',
    'workspace=$2',
    'shift 2',
    'if [ -x "$engine" ] && [ -r "$engine" ]; then printf \'engine=executable\\n\'; else printf \'engine=missing\\n\'; fi',
    'printf \'uid=%s\\n\' "$(id -u)"',
    'printf \'gid=%s\\n\' "$(id -g)"',
    'printf \'groups=%s\\n\' "$(id -G | tr \' \' \',\')"',
    'printf \'home=%s\\n\' "${HOME:-}"',
    'printf \'envnames=%s\\n\' "$(printenv | cut -d= -f1 | sort | tr \'\\n\' \',\')"',
    'if [ -t 0 ]; then printf \'stdin=tty\\n\'; else printf \'stdin=notty\\n\'; fi',
    'probe="$workspace/' + PROBE_MARKER + '"',
    '# Write, read back, then delete: the marker must not survive in the attempt\'s worktree.',
    'if printf \'shiploop isolation probe\\n\' > "$probe" 2>/dev/null && [ -s "$probe" ]; then',
    '  rm -f "$probe" 2>/dev/null',
    '  if [ ! -e "$probe" ]; then printf \'wrote=ok\\n\'; else printf \'wrote=\\n\'; fi',
    'else',
    '  printf \'wrote=\\n\'',
    'fi',
    'for path in "$@"; do',
    '  if [ -d "$path" ]; then',
    '    if ls "$path" >/dev/null 2>&1; then printf \'readable=%s\\n\' "$path"; else printf \'denied=%s\\n\' "$path"; fi',
    '  elif cat "$path" >/dev/null 2>&1; then printf \'readable=%s\\n\' "$path"; else printf \'denied=%s\\n\' "$path"; fi',
    'done',
    '',
  ].join('\n');
}

/** Runs the probe as the execution principal and parses exactly what it reported. */
async function runProbe(
  settings: IsolationSettings,
  plan: {
    readonly probePath: string;
    readonly launcherPath: string;
    readonly homePath: string;
    readonly attemptId: string;
    readonly request: IsolationRequest;
  },
): Promise<Result<IsolationProbeReport, DomainError>> {
  const protectedPaths = protectedPathsOf(settings, plan.request.additionalProtectedPaths ?? []);
  /**
   * The probe is launched through the installed launcher, not through {@link isolatedArgv}.
   *
   * That is deliberate: what the preflight verifies has to be the executable the engine adapter is
   * pointed at, so the same file, the same transition and the same `env -i` construction confine the
   * probe and will confine the engine. A probe run by a helper would prove the helper (F03-AC5).
   */
  const spawned = launchTrackedGroup(
    [plan.launcherPath, '--shiploop-isolation-probe', settings.engineBinary, plan.request.workspacePath, ...protectedPaths],
    { cwd: plan.request.workspacePath },
  );
  if (!spawned.ok) return spawned;

  const graceMs = settings.commandTimeoutMs;
  const child = spawned.value;
  const exited = await withinMs(child.finished(), graceMs);
  if (!exited.settled) {
    const stopped = await stopTrackedGroup(child, {
      gracefulStopMs: 1_000,
      killWaitMs: 2_000,
      transition: principalTransition(settings),
      killBinary: settings.killBinary,
    });
    if (stopped.ok && stopped.value.survivors.length > 0) {
      return err({
        code: 'Unavailable',
        reason: `The isolation probe did not finish within ${String(graceMs)}ms and its process group ${String(child.processGroupId)} is still running, so no engine was dispatched.`,
      });
    }
    return err({
      code: 'Unavailable',
      reason: `The isolation probe did not finish within ${String(graceMs)}ms: ${child.errorOutput().slice(0, 400)}`,
    });
  }

  const report = parseProbeReport(child.output());
  if (!report.ok) {
    return err(
      blocked(`The isolation probe for attempt ${plan.attemptId} did not report a usable answer, so no coding work was dispatched.`, [
        {
          name: 'isolation-probe',
          detail: report.error.reason,
          remedy: `Run the installed launcher by hand to see what happens: ${plan.launcherPath} --version (F03-AC5).`,
        },
      ]),
    );
  }
  return ok(report.value);
}

/**
 * Parses the probe's own report.
 *
 * Strictly: a line this does not understand, or a field that is missing, is a refusal rather than a
 * default. A probe that only half-ran must never be read as "the boundary held".
 */
export function parseProbeReport(output: string): Result<IsolationProbeReport, DomainError> {
  const fields = new Map<string, string[]>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      return err({ code: 'Unavailable', reason: `The isolation probe printed a line this worker cannot read: ${trimmed.slice(0, 120)}` });
    }
    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }

  const uid = Number(fields.get('uid')?.[0]);
  const gid = Number(fields.get('gid')?.[0]);
  const home = fields.get('home')?.[0];
  const wrote = fields.get('wrote')?.[0];
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || home === undefined || home === '' || wrote === undefined) {
    return err({ code: 'Unavailable', reason: 'The isolation probe did not report a uid, a gid, a home directory and a write result, so its answer cannot be trusted.' });
  }

  return ok({
    uid,
    gid,
    home,
    groups: fields.get('groups')?.[0] ?? '',
    environmentNames: splitList(fields.get('envnames')?.[0] ?? ''),
    stdinIsTerminal: fields.get('stdin')?.[0] === 'tty',
    engineExecutable: fields.get('engine')?.[0] === 'executable',
    wroteInWorkspace: wrote === 'ok',
    readable: fields.get('readable') ?? [],
  });
}

/* -------------------------------------------------------------------------- */
/* The isolated engine port                                                    */
/* -------------------------------------------------------------------------- */

export interface IsolatedEngineSettings {
  readonly isolation: IsolationSettings;
  /** Builds the real engine adapter for one launcher path. */
  readonly buildEngine: (launcherPath: string) => EngineAdapter;
  /** Names the holder in the connector identity, so a session is traceable to a worker. */
  readonly connectorId: ConnectorId;
  /** Bound on one graceful stop before the tracked group is killed. */
  readonly gracefulStopMs: number;
  /** Bound on waiting for a killed group to disappear. */
  readonly killWaitMs: number;
  /** Called with the blocker whenever an attempt cannot be dispatched. */
  readonly onRefusal: (error: DomainError) => void;
}

/**
 * The engine port every attempt goes through, and the only place isolation can fail closed.
 *
 * Each session is planned and launched separately, because isolation is per attempt: the home
 * belongs to the attempt, and the workspace is handed to the principal at the moment the engine is
 * about to write in it. `stopSession` and `resumeSession` are routed to the adapter that started the
 * session they name, because that adapter holds the tracked process group — routing a stop to a
 * different adapter would signal nothing and report a stop that never happened (F17-AC1).
 *
 * A refusal from `planIsolation` is returned to the runner, which classifies it as a deterministic
 * refusal and parks the job with the operator's remedy attached. It is never swallowed and never
 * downgraded to an unisolated spawn (F03-AC5, F18-AC1).
 */
export function createIsolatedEngine(settings: IsolatedEngineSettings): EngineAdapter {
  /**
   * The adapter and the plan each session was launched with.
   *
   * Both are needed to stop a session honestly: the adapter holds the tracked process group and the
   * plan holds the group file its launcher recorded, and a stop routed to the wrong one either
   * signals nothing or signals a group belonging to another attempt (F17-AC1).
   */
  const bySession = new Map<ProviderId, { readonly engine: EngineAdapter; readonly plan: IsolationPlan }>();
  /**
   * The identity adapter, built with the configured engine binary.
   *
   * A capability or version probe runs no session and touches no workspace, and it needs a real
   * binary path to answer; every session is built with a launcher instead, which is the only path
   * that starts work.
   */
  const identity = settings.buildEngine('');
  let latest: EngineAdapter = identity;

  const plan = async (workspacePath: string, workspaceId: string): Promise<Result<{ readonly engine: EngineAdapter; readonly plan: IsolationPlan }, DomainError>> => {
    const planned = await planIsolation(settings.isolation, { attemptId: workspaceId, workspacePath });
    if (!planned.ok) {
      settings.onRefusal(planned.error);
      return err(planned.error);
    }
    const engine = settings.buildEngine(planned.value.launcherPath);
    latest = engine;
    return ok({ engine, plan: planned.value });
  };

  /**
   * Stops a session, and escalates the stop when the principal transition made the group unsignalable.
   *
   * The adapter's own stop is attempted first, so its contract and its reporting are unchanged; the
   * escalation exists because a signal from the worker does not reach a process running as the
   * execution principal. A group that survives both is reported `Detached`, never `Stopped`, because
   * a session that is still running must not release the single coding writer (F17-AC1, F17-AC5).
   */
  const stop = async (context: AdapterContext, request: StopEngineSessionRequest): Promise<Result<EngineStopOutcome>> => {
    const entry = bySession.get(request.sessionId) ?? null;
    const owner = entry?.engine ?? latest;
    const outcome = await owner.stopSession(context, request);

    if (entry === null) {
      return outcome.ok
        ? outcome
        : { ok: false, error: { code: 'Unavailable', reason: `No isolated engine is recorded for session ${request.sessionId}, so nothing can be asserted about its process group (F17-AC5).` } };
    }

    const escalated = await stopIsolatedGroup(entry.plan.groupFilePath, {
      gracefulStopMs: settings.gracefulStopMs,
      killWaitMs: settings.killWaitMs,
      transition: principalTransition(settings.isolation),
      killBinary: settings.isolation.killBinary,
    });

    if (!escalated.ok || escalated.value.survivors.length > 0) {
      return ok({
        kind: 'Detached',
        detail: `The engine process group ${escalated.ok ? escalated.value.groupId : 'the launcher recorded'} survived a graceful stop and an escalated kill of that group, so the attempt is detached rather than stopped and the coding slot stays held (F17-AC1, F17-AC5).`,
        reconcileRequired: true,
      });
    }
    bySession.delete(request.sessionId);
    return outcome;
  };

  return {
    kind: 'Engine',
    connectorId: settings.connectorId,
    capabilities: (): AdapterCapabilities => identity.capabilities(),
    checkCompatibility: (context: AdapterContext): Promise<Result<AdapterCompatibility>> => identity.checkCompatibility(context),
    startSession: async (context: AdapterContext, request: EngineStartRequest): Promise<Result<EngineSessionHandle>> => {
      const chosen = await plan(request.workspace.absolutePath, request.workspace.workspaceId);
      if (!chosen.ok) return chosen;
      const started = await chosen.value.engine.startSession(context, request);
      if (!started.ok) return started;
      bySession.set(started.value.sessionId, chosen.value);
      return started;
    },
    resumeSession: async (
      context: AdapterContext,
      request: ResumeEngineSessionRequest,
    ): Promise<Result<EngineContinuation>> => {
      const chosen = await plan(request.workspace.absolutePath, request.workspace.workspaceId);
      if (!chosen.ok) return chosen;
      const resumed = await chosen.value.engine.resumeSession(context, request);
      if (!resumed.ok) return resumed;
      if (resumed.value.kind !== 'ContinuationUnsupported') {
        bySession.set(resumed.value.session.sessionId, chosen.value);
      }
      return resumed;
    },
    stopSession: stop,
  };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

interface PathFacts {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

/** `ls -l` for one path, as numbers. Everything this module asserts about ownership comes from here. */
async function describePath(path: string): Promise<Result<PathFacts, DomainError>> {
  try {
    const observed = await stat(path);
    return ok({ uid: observed.uid, gid: observed.gid, mode: observed.mode & 0o7777 });
  } catch (cause) {
    return err({ code: 'Unavailable', reason: `${path} could not be inspected: ${describe(cause)}` });
  }
}

async function pathExists(path: string): Promise<boolean> {
  const described = await describePath(path);
  return described.ok;
}

function modeText(mode: number): string {
  return `0${(mode & 0o7777).toString(8)}`;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function splitList(value: string): readonly string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function resolvePathOf(value: string): string {
  return value.startsWith('/') ? value : join(process.cwd(), value);
}

function text(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function readInteger(value: string | undefined, path: string, errors: { readonly path: string; readonly message: string }[]): number | null {
  if (value === undefined || value.trim() === '') return null;
  if (!INTEGER.test(value.trim())) {
    errors.push({ path, message: 'Expected a whole number.' });
    return null;
  }
  return Number(value.trim());
}

function readAbsolute(
  value: string | undefined,
  path: string,
  required: boolean,
  errors: { readonly path: string; readonly message: string }[],
): string | null {
  const trimmed = text(value);
  if (trimmed === null) {
    if (required) {
      errors.push({
        path,
        message:
          'An absolute path is required, because the launcher, the engine home and the engine binary all have to be outside anything the operator\u2019s identity owns privately (F03-AC5).',
      });
    }
    return null;
  }
  if (!isAbsolute(trimmed)) {
    errors.push({ path, message: `Expected an absolute path, received ${trimmed}.` });
    return null;
  }
  if (!SAFE_PATH.test(trimmed)) {
    errors.push({
      path,
      message: `Expected a path of letters, digits and . _ + / - only, received ${trimmed}. These paths are written into the generated launcher as single-quoted words, and a path that needs escaping in two languages is refused rather than escaped (F03-AC5).`,
    });
    return null;
  }
  return trimmed;
}

function listOf(value: string | undefined): readonly string[] {
  const trimmed = text(value);
  if (trimmed === null) return [];
  return trimmed
    .split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Runs one bounded command and waits for it.
 *
 * No shell, a deadline, and a byte bound: the commands here are `chown` and the probe, and a
 * launcher that could block forever on a hung filesystem would stop the worker rather than refuse an
 * attempt. Output is reported back rather than logged, because a `chown` failure names a path and a
 * probe failure names a verdict — neither is a secret.
 */
async function runBounded(
  argv: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
): Promise<Result<null, DomainError>> {
  const spawned = launchTrackedGroup(argv, { cwd: options.cwd, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } });
  if (!spawned.ok) return spawned;
  const child = spawned.value;
  const exited = await withinMs(child.finished(), options.timeoutMs);
  if (!exited.settled) {
    await stopTrackedGroup(child, { gracefulStopMs: 1_000, killWaitMs: 2_000 });
    return err({ code: 'Unavailable', reason: `${argv[0] ?? ''} did not finish within ${String(options.timeoutMs)}ms.` });
  }
  if (exited.exit?.exitCode !== 0) {
    const detail = child.errorOutput().trim().slice(0, 300);
    return err({
      code: 'Unavailable',
      reason: `${argv.join(' ')} exited ${String(exited.exit?.exitCode ?? 'null')}${detail === '' ? '' : `: ${detail}`}`,
    });
  }
  return ok(null);
}

/** Exposed for the adapter's shutdown contract, which needs the same bound this module uses. */
export const DEFAULT_STOP_WINDOWS = { gracefulStopMs: 10_000, killWaitMs: 5_000 } as const;