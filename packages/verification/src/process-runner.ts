/**
 * The real `node:child_process` implementation of the preflight command port.
 *
 * It exists as a separate module so `./preflight.ts` stays free of I/O and can be
 * exercised with a deterministic fake, while production runs against real
 * processes. The behaviour follows the repository's existing runner precedent in
 * `scripts/lib/command.mjs`: spawn an argv array without a shell, create a process
 * group per command, bound the deadline and the captured output, and signal only
 * the group this runner created.
 *
 * This is not a security sandbox. A program that escapes its process group needs
 * stronger container or cgroup ownership before it is run for real.
 */

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import type { CommandOptions, CommandResult, CommandRunner } from './preflight.ts';

const MAX_TIMEOUT_MS = 3_600_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const GRACE_MS = 750;
const PIPE_CLOSE_WAIT_MS = 200;

/** Only these environment names reach a probe; nothing else is inherited. */
const ALLOWED_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'CI',
  'NO_COLOR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
] as const;

const BASELINE_ENV: Readonly<Record<string, string>> = { TZ: 'UTC', LANG: 'C.UTF-8', CI: '1', NO_COLOR: '1' };

/**
 * Builds the child environment from an allowlist plus the caller's explicit extras.
 *
 * Forwarding `process.env` wholesale would hand every provider credential on the
 * VM to every probe, including a repository probe whose output is persisted as
 * evidence (N02-AC2).
 */
export function allowlistedEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
  extra: Readonly<Record<string, string>> | null = null,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = { ...BASELINE_ENV };
  for (const key of ALLOWED_ENV_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  if (extra !== null) {
    for (const [key, value] of Object.entries(extra)) env[key] = value;
  }
  return env;
}

function assertBounded(argv: readonly string[], options: CommandOptions): void {
  if (argv.length === 0 || argv.some((argument) => argument.length === 0 || argument.includes('\0'))) {
    throw new Error('Command argv must be a non-empty string array without NUL bytes.');
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Command timeout must be an integer between 1 and ${MAX_TIMEOUT_MS} ms.`);
  }
  if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 1 || options.maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new Error(`Command output limit must be an integer between 1 and ${MAX_OUTPUT_BYTES} bytes.`);
  }
}

/**
 * The real command runner.
 *
 * Every command is spawned detached, so the child's pid is also its process group
 * id and the whole group can be signalled with a single negative pid. The runner
 * records that group id on the result so the caller can register it in its owned
 * process registry (F14-AC5).
 */
export const nodeProcessRunner: CommandRunner = {
  run(argv, options) {
    assertBounded(argv, options);
    const startedAt = Date.now();
    const env = allowlistedEnv(process.env, options.env);

    return new Promise<CommandResult>((resolve) => {
      let child: ReturnType<typeof spawn> | null = null;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let timedOut = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let bytes = 0;
      let truncated = false;
      let spawnError: string | null = null;
      let signalError: string | null = null;
      const chunks: Buffer[] = [];

      const signalOwnedGroup = (signal: NodeJS.Signals): boolean => {
        if (child === null || child.pid === undefined) return false;
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ESRCH') return false;
          throw error;
        }
      };

      /**
       * Signalling must never be able to strand the promise. A group that cannot
       * be signalled is a cleanup problem the caller needs to see in a detail
       * string, not a reason for the run to hang past its deadline.
       */
      const trySignalOwnedGroup = (signal: NodeJS.Signals): boolean => {
        try {
          return signalOwnedGroup(signal);
        } catch (error) {
          signalError = error instanceof Error ? error.message : String(error);
          return false;
        }
      };

      const settle = (timedOutAtSettle: boolean, error: string | null): void => {
        if (settled) return;
        settled = true;
        if (deadline !== undefined) clearTimeout(deadline);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        trySignalOwnedGroup('SIGKILL');
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
        resolve({
          exitCode,
          signal: exitSignal,
          output: Buffer.concat(chunks).toString('utf8'),
          outputTruncated: truncated,
          timedOut: timedOutAtSettle,
          durationMs: Date.now() - startedAt,
          spawnError: error === null && signalError !== null ? signalError : error,
          groupId: child?.pid ?? null,
        });
      };

      const capture = (chunk: unknown): void => {
        const buffer = Buffer.from(chunk as Buffer);
        const remaining = options.maxOutputBytes - bytes;
        if (remaining > 0) {
          chunks.push(buffer.subarray(0, remaining));
          bytes += Math.min(buffer.length, remaining);
        }
        if (buffer.length > remaining) truncated = true;
      };

      const stop = (): void => {
        trySignalOwnedGroup('SIGTERM');
        graceTimer = setTimeout(() => settle(timedOut, null), GRACE_MS);
      };

      try {
        child = spawn(argv[0] === 'node' ? process.execPath : (argv[0] as string), argv.slice(1), {
          cwd: options.cwd ?? process.cwd(),
          env,
          detached: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({
          exitCode: null,
          signal: null,
          output: '',
          outputTruncated: false,
          timedOut: false,
          durationMs: Date.now() - startedAt,
          spawnError: error instanceof Error ? error.message : String(error),
          groupId: null,
        });
        return;
      }

      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      child.once('error', (error: NodeJS.ErrnoException) => {
        spawnError = `${error.code ?? 'spawn-error'}: ${error.message}`;
        settle(false, spawnError);
      });

      /**
       * A descendant can keep the pipes open after the leader exits, so the exit
       * event is not awaited on its own: the group is killed for ownership and a
       * short pipe-close wait settles the result, independently of the deadline.
       */
      child.once('exit', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        trySignalOwnedGroup('SIGKILL');
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        graceTimer = setTimeout(() => settle(timedOut, spawnError), PIPE_CLOSE_WAIT_MS);
      });

      child.once('close', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        settle(timedOut, spawnError);
      });

      deadline = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs);
    });
  },
};

export interface OwnedProcessHandle {
  readonly pid: number;
  /** Identical to the pid here because the spawn is detached, which creates the group. */
  readonly groupId: number;
  readonly command: readonly string[];
  readonly startedAt: string;
}

/**
 * Starts a long-lived owned process and returns immediately.
 *
 * A service runs for the whole attempt, so waiting for its exit would stall the
 * caller. The returned handle is what goes into the attempt's owned process
 * registry, and its group id is the only pid later cleanup may signal. Anything
 * not obtained from here is not owned and must never be signalled (F14-AC5).
 */
export function spawnOwnedProcess(
  argv: readonly string[],
  options: { readonly cwd: string | null; readonly env?: Readonly<Record<string, string>> | null },
): OwnedProcessHandle {
  const [executable, ...rest] = argv;
  if (executable === undefined || argv.some((argument) => argument.length === 0 || argument.includes('\0'))) {
    throw new Error('Command argv must be a non-empty string array without NUL bytes.');
  }
  const child = spawn(executable === 'node' ? process.execPath : executable, rest, {
    cwd: options.cwd ?? process.cwd(),
    env: allowlistedEnv(process.env, options.env ?? null),
    detached: true,
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (child.pid === undefined) {
    throw new Error('The spawned process has no pid, so its group cannot be owned.');
  }
  const pid: number = child.pid;
  child.unref();
  return { pid, groupId: pid, command: [...argv], startedAt: new Date().toISOString() };
}

/**
 * Signals a process group this attempt created.
 *
 * A negative pid targets the group rather than one process, so a command that
 * spawned its own children does not leave them behind. An already-gone group
 * returns false rather than throwing, because a process that exited on its own is
 * a successful cleanup, not an error (F14-AC5).
 */
export function stopOwnedProcessGroup(groupId: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

/** Removes a temporary path this attempt created. Failures propagate to the caller. */
export async function removeOwnedPath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
