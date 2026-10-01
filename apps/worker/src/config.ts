/**
 * Worker process configuration, read once from the environment.
 *
 * This is a boundary, so it is parsed once, validated once and returned as a typed result
 * rather than read ad hoc inside the run loop. Nothing here decides policy: the heartbeat
 * cadence, the missed-heartbeat threshold and the attempt limits all come from
 * `@shiploop/domain` and `@shiploop/storage`, because a worker that kept its own copy of
 * those numbers would drift from the queue that enforces them (F17-AC5, F18-AC2).
 *
 * Two settings are required rather than defaulted, because the only honest default is none:
 *
 *   - the database path, since a worker pointed at the wrong file would claim the wrong job;
 *   - the workspace provider module, since preparing an isolated worktree, a data directory,
 *     ports and a lock is the F14 unit's work and this process must not invent a worktree
 *     (ARCHITECTURE "Execution and recovery", F14-AC1).
 *
 * The lease term is validated by `rejectLeaseTerm`, the storage function `claimNext` uses, so
 * a term that could hide a wedged writer for too long, or could not outlast the
 * missed-heartbeat threshold at all, is refused here with the same reason the queue would
 * give (F17-AC5).
 */

import { resolve } from 'node:path';
import { resolveSandboxMode } from '@shiploop/adapters';
import type { CodexSandboxMode } from '@shiploop/adapters';
import { rejectLeaseTerm } from '@shiploop/storage';
import type { ProjectId } from '@shiploop/domain';

/** One configuration problem, reported by path so an operator can fix it in one pass. */
export interface ConfigProblem {
  readonly path: string;
  readonly message: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly value: WorkerConfig }
  | { readonly ok: false; readonly errors: readonly ConfigProblem[] };

export interface WorkerEngineConfig {
  /** Absolute or PATH-resolvable Codex executable. Never a shell word. */
  readonly binary: string;
  readonly sandbox: CodexSandboxMode;
}

export interface WorkerConfig {
  readonly databasePath: string;
  /**
   * Identity this process writes as the holder of the single global coding writer.
   *
   * It must be stable across restarts of the same installation, because it is what the lease
   * row names and what a later worker compares against before reclaiming (F17-AC5).
   */
  readonly holder: string;
  /** Restricts claims to one project; null claims any queued job. */
  readonly projectId: ProjectId | null;
  readonly leaseTtlMs: number;
  /** Idle wait between claim attempts, so an empty queue does not spin. */
  readonly pollIntervalMs: number;
  /** Bound on one graceful engine shutdown before the tracked group is killed. */
  readonly gracefulStopMs: number;
  /** Bound on waiting for a killed group to disappear. */
  readonly killWaitMs: number;
  readonly engine: WorkerEngineConfig;
  /** Module specifier exporting the isolated-workspace provider (F14-AC1). */
  readonly workspaceModule: string;
}

const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_GRACEFUL_STOP_MS = 10_000;
const DEFAULT_KILL_WAIT_MS = 5_000;
const DEFAULT_CODEX_BINARY = 'codex';
const DEFAULT_SANDBOX = 'workspace-write';
const INTEGER = /^\d+$/;

const passthrough = (text: string): string => text;

export function readWorkerConfig(env: NodeJS.ProcessEnv): ConfigResult {
  const errors: ConfigProblem[] = [];

  const databasePath = readRequiredPath(env['SHIPLOOP_WORKER_DATABASE'], 'SHIPLOOP_WORKER_DATABASE', errors);
  const holder = readRequiredText(env['SHIPLOOP_WORKER_HOLDER'], 'SHIPLOOP_WORKER_HOLDER', errors);
  const workspaceModule = readRequiredText(
    env['SHIPLOOP_WORKER_WORKSPACE_MODULE'],
    'SHIPLOOP_WORKER_WORKSPACE_MODULE',
    errors,
  );
  const leaseTtlMs = readInteger(env['SHIPLOOP_WORKER_LEASE_TTL_MS'], 'SHIPLOOP_WORKER_LEASE_TTL_MS', DEFAULT_LEASE_TTL_MS, errors);
  const pollIntervalMs = readInteger(env['SHIPLOOP_WORKER_POLL_INTERVAL_MS'], 'SHIPLOOP_WORKER_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS, errors);
  const gracefulStopMs = readInteger(env['SHIPLOOP_WORKER_GRACEFUL_STOP_MS'], 'SHIPLOOP_WORKER_GRACEFUL_STOP_MS', DEFAULT_GRACEFUL_STOP_MS, errors);
  const killWaitMs = readInteger(env['SHIPLOOP_WORKER_KILL_WAIT_MS'], 'SHIPLOOP_WORKER_KILL_WAIT_MS', DEFAULT_KILL_WAIT_MS, errors);

  if (errors.length === 0) {
    const term = rejectLeaseTerm(leaseTtlMs);
    if (!term.ok) {
      errors.push({
        path: 'SHIPLOOP_WORKER_LEASE_TTL_MS',
        message: term.error.reason,
      });
    }
  }

  const sandbox = resolveSandboxMode(env['SHIPLOOP_WORKER_SANDBOX'] ?? DEFAULT_SANDBOX, passthrough);
  if (!sandbox.ok) {
    errors.push({ path: 'SHIPLOOP_WORKER_SANDBOX', message: sandbox.error.reason });
  }

  if (errors.length > 0) return { ok: false, errors };

  const projectId = env['SHIPLOOP_WORKER_PROJECT'];
  const binary = env['SHIPLOOP_WORKER_CODEX_BINARY'];

  return {
    ok: true,
    value: {
      databasePath: databasePath as string,
      holder: holder as string,
      projectId: projectId === undefined || projectId === '' ? null : (projectId as ProjectId),
      leaseTtlMs,
      pollIntervalMs,
      gracefulStopMs,
      killWaitMs,
      engine: {
        binary: binary === undefined || binary === '' ? DEFAULT_CODEX_BINARY : binary,
        sandbox: (sandbox as { ok: true; value: CodexSandboxMode }).value,
      },
      workspaceModule: workspaceModule as string,
    },
  };
}

/** One line naming every configuration problem, for the process to print on exit. */
export function describeConfigErrors(errors: readonly ConfigProblem[]): string {
  return errors.map((problem) => `${problem.path}: ${problem.message}`).join('; ');
}

function readRequiredPath(raw: string | undefined, path: string, errors: ConfigProblem[]): string | null {
  const value = raw?.trim() ?? '';
  if (value === '') {
    errors.push({
      path,
      message: 'The SQLite file this worker owns is required; a worker with no path would claim nothing it can reconcile.',
    });
    return null;
  }
  return resolve(value);
}

function readRequiredText(raw: string | undefined, path: string, errors: ConfigProblem[]): string | null {
  const value = raw?.trim() ?? '';
  if (value === '') {
    errors.push({
      path,
      message: 'A non-empty value is required. The holder identity and the workspace provider name what this process is allowed to claim and where it is allowed to write (F13-AC2, F14-AC1).',
    });
    return null;
  }
  return value;
}

function readInteger(raw: string | undefined, path: string, fallback: number, errors: ConfigProblem[]): number {
  if (raw === undefined || raw === '') return fallback;
  if (!INTEGER.test(raw)) {
    errors.push({ path, message: 'Expected a whole number of milliseconds.' });
    return fallback;
  }
  const value = Number(raw);
  if (value < 1) {
    errors.push({ path, message: 'Expected a positive number of milliseconds.' });
    return fallback;
  }
  return value;
}