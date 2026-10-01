/**
 * The GitHub transport: REST for provider facts and writes, the `git` CLI for
 * pushing (F19-AC1, F20-AC1, F26-AC3).
 *
 * Two facts measured on this host on 1 October 2026 shape the HTTP side, and both are
 * recorded in `README.md` with their output rather than asserted from documentation:
 *
 * 1. The REST API authenticates with `Authorization: Bearer <token>` and reports the
 *    credential's scopes back in `x-oauth-scopes`
 *    (`admin:public_key, gist, read:org, repo`). The `X-GitHub-Api-Version` request
 *    header is echoed as `x-github-api-version-selected: 2022-11-28`, which is the only
 *    runtime version GitHub exposes, so `checkCompatibility` reports that header rather
 *    than inventing a version.
 * 2. The rate-limit headers are **epoch seconds**, not milliseconds:
 *    `x-ratelimit-limit: 5000`, `x-ratelimit-remaining: 5000`,
 *    `x-ratelimit-reset: 1790847829`. A transport that treats that as milliseconds
 *    computes a retry hint in 1970 and busy-loops, so the unit conversion is explicit
 *    here and asserted in the adapter's own tests.
 *
 * The transport never retries by default. F30-AC4 requires a rate limit to reach the
 * caller with its category and its hint rather than being absorbed by an adapter-internal
 * loop, so bounded rate-limit backoff is opt-in through `maxRateLimitRetries` and is the
 * only retry category: an auth failure, a not-found and a malformed input are returned,
 * never retried, because repeating them cannot change the answer.
 *
 * Pushes go through the `git` CLI rather than the API for a reason that matters for
 * correctness: `POST /repos/{owner}/{repo}/git/refs` refuses a SHA the remote has never
 * seen, so publishing a locally created commit means transferring objects, and the only
 * supported way to do that is the protocol. Every invocation is an **argv array** with
 * `shell: false`; no branch name, repository name or SHA is ever concatenated into a
 * command string, so a branch named `main; rm -rf /` is an ordinary ref that GitHub
 * rejects rather than a shell command.
 */

import { spawn } from 'node:child_process';

import { err, invalid, ok, type DomainError, type Result } from '@shiploop/domain';
import type { AdapterContext } from '../contracts/index.ts';
import { lostGitHubWriteOutcome, mapGitHubFailure, type GitHubHeaders } from './errors.ts';

export const GITHUB_API_BASE_URL = 'https://api.github.com';

/** Pinned so a provider change cannot silently alter request or response semantics. */
export const GITHUB_API_VERSION = '2022-11-28';

export const GITHUB_USER_AGENT = 'shiploop-adapters';

export type GitHubMethod = 'GET' | 'POST' | 'PATCH' | 'PUT';

export interface GitHubRequest {
  /** Owner-visible name of the call, so an error says which provider operation failed. */
  readonly operationName: string;
  readonly method: GitHubMethod;
  /** Path with `{owner}` and `{repo}` already substituted. Never a full URL. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number>> | undefined;
  readonly body?: unknown;
  /**
   * Marks a request that changes provider state. It is not documentation: it is what
   * decides whether a lost response becomes `OutcomeUnknown` or `Unavailable`. Repeating
   * a read is free, so a lost read is an unavailability; repeating a write may create a
   * second pull request, so the ambiguity is reported rather than absorbed (F28-AC4,
   * F30-AC5).
   */
  readonly mutating?: boolean | undefined;
  /** The external identity the write addresses, retained so a caller can reconcile. */
  readonly target?: string | undefined;
}

export interface GitHubSuccess {
  /** Raw decoded payload; every field is read through a boundary reader, never trusted. */
  readonly data: unknown;
  readonly status: number;
  readonly headers: GitHubHeaders;
  /** `x-github-api-version-selected`, the only runtime version GitHub reports. */
  readonly runtimeVersion: string | null;
}

/** Exit status and streams of one `git` invocation. Never a shell string. */
export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The `git` seam.
 *
 * It is an interface so the adapter's own tests can drive push behaviour, including a
 * rejected non-fast-forward and a lost response, without a network or a remote. The
 * shipped implementation is `createGitTransport`, which spawns the binary directly.
 */
export interface GitTransport {
  /** Local checkout the push reads objects from and validates the target remote against. */
  readonly workingDirectory: string;
  run(context: AdapterContext, argv: readonly string[]): Promise<Result<GitCommandResult>>;
}

export interface GitHubClientOptions {
  /** Read from the environment by the caller; never logged and never persisted. */
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly apiVersion?: string;
  readonly userAgent?: string;
  /** Hard bound on one request, so an unresponsive provider cannot hang a run. */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Zero by default (F30-AC4). Values above zero enable bounded rate-limit backoff only. */
  readonly maxRateLimitRetries?: number;
  readonly maxBackoffMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export class GitHubClient {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly apiVersion: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly maxBackoffMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubClientOptions) {
    if (options.token.trim().length === 0) {
      throw new Error('A GitHub token is required; the value is never logged.');
    }
    this.token = options.token;
    this.apiBaseUrl = options.apiBaseUrl ?? GITHUB_API_BASE_URL;
    this.apiVersion = options.apiVersion ?? GITHUB_API_VERSION;
    this.userAgent = options.userAgent ?? GITHUB_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 0;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async execute(context: AdapterContext, request: GitHubRequest): Promise<Result<GitHubSuccess>> {
    let attempt = 0;
    for (;;) {
      const outcome = await this.attempt(context, request);
      if (outcome.ok) return outcome;
      if (outcome.error.code !== 'RateLimited') return outcome;
      if (attempt >= this.maxRateLimitRetries) return outcome;
      attempt += 1;
      await delay(this.backoffFor(outcome.error.retryAfterMs, attempt), context.signal);
    }
  }

  /**
   * The ambiguity a caller must reconcile.
   *
   * A read that never came back is an unavailability: repeating it cannot change provider
   * state. A write that never came back may have landed, so it is `OutcomeUnknown` naming
   * the operation identity the caller supplied and the target the write addressed — never
   * a failure, which would invite the duplicate F19-AC1 and F19-AC3 forbid.
   */
  private undelivered(context: AdapterContext, request: GitHubRequest, detail: string): DomainError {
    if (request.mutating === true) {
      return lostGitHubWriteOutcome({
        operationName: request.operationName,
        operationId: context.operationId,
        target: request.target ?? request.path,
        detail,
        redact: context.redact,
      });
    }
    return {
      code: 'Unavailable',
      reason: context.redact(
        `${request.operationName} was not answered by GitHub (${detail}). The call was a read, so repeating it cannot change provider state; retry or wait for reconciliation.`,
      ),
    };
  }

  /** Bounded, deterministic backoff: the provider's own hint first, then a capped ramp. */
  private backoffFor(retryAfterMs: number | null, attempt: number): number {
    const ramp = Math.min(this.maxBackoffMs, 500 * 2 ** (attempt - 1));
    const requested = retryAfterMs ?? ramp;
    return Math.min(this.maxBackoffMs, Math.max(requested, 0));
  }

  private async attempt(context: AdapterContext, request: GitHubRequest): Promise<Result<GitHubSuccess>> {
    // A rate-limit reset is an absolute instant, so the "now" it is measured against is
    // the injected clock rather than the ambient one. Using `Date.now()` would make the
    // hint untestable and inconsistent with every other timestamp the adapter reports.
    const observed = Date.parse(context.clock.now());
    const nowMs = Number.isFinite(observed) ? observed : Date.now();
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(this.timeoutMs)]);
    const url = new URL(`${this.apiBaseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': this.apiVersion,
          'User-Agent': this.userAgent,
          ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal,
      });
    } catch (cause) {
      const detail = context.signal.aborted
        ? 'the caller aborted the operation'
        : `no HTTP response (${context.redact(cause instanceof Error ? cause.message : String(cause))})`;
      return err(this.undelivered(context, request, detail));
    }

    const headers = collectHeaders(response);
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (cause) {
      // The status line arrived, so GitHub accepted the request; only the body was lost.
      // For a write that is still an unknown outcome.
      return err(
        this.undelivered(
          context,
          request,
          `the response body could not be read (${context.redact(cause instanceof Error ? cause.message : String(cause))})`,
        ),
      );
    }

    if (!response.ok) {
      return err(
        mapGitHubFailure({
          status: response.status,
          headers,
          bodyText,
          operationName: request.operationName,
          nowMs,
          redact: context.redact,
        }),
      );
    }

    return ok({
      data: decodeJson(bodyText),
      status: response.status,
      headers,
      runtimeVersion: headers['x-github-api-version-selected'] ?? null,
    });
  }
}

function decodeJson(bodyText: string): unknown {
  if (bodyText.length === 0) return null;
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
}

function collectHeaders(response: Response): GitHubHeaders {
  const collected: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    collected[key.toLowerCase()] = value;
  });
  return collected;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export interface GitTransportOptions {
  /** Executable to run. Resolved through `PATH` when it contains no separator. */
  readonly gitBinary?: string;
  readonly timeoutMs?: number;
  /** Environment for the child. Defaults to the current environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The shipped `git` transport.
 *
 * `spawn` is called with an argv array and `shell: false`, so no argument is ever
 * interpreted by a shell. The child is tracked by handle and killed as a **group** on
 * abort or timeout, because `git push` spawns its own helpers and killing only the
 * parent can leave an ssh transfer running (AGENTS.md: track PIDs at spawn, stop only
 * owned groups).
 */
export function createGitTransport(
  workingDirectory: string,
  options: GitTransportOptions = {},
): GitTransport {
  const gitBinary = options.gitBinary ?? 'git';
  const timeoutMs = options.timeoutMs ?? 120_000;
  return {
    workingDirectory,
    async run(context: AdapterContext, argv: readonly string[]): Promise<Result<GitCommandResult>> {
      if (argv.length === 0) {
        return err(
          invalid('A git invocation needs a subcommand.', [
            { path: 'argv', message: 'No git subcommand was supplied.' },
          ]),
        );
      }
      const invocation = [gitBinary, ...argv].join(' ');
      return new Promise<Result<GitCommandResult>>((resolve) => {
        let settled = false;
        let child: ReturnType<typeof spawn> | undefined;
        const settle = (outcome: Result<GitCommandResult>): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          context.signal.removeEventListener('abort', onAbort);
          resolve(outcome);
        };
        const kill = (): void => {
          if (child === undefined) return;
          try {
            // The child is spawned `detached`, so it leads its own process group and a
            // group kill reaches the ssh helpers `git push` starts underneath it.
            if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            // The child is already gone, which is the outcome being sought.
          }
        };
        const onAbort = (): void => kill();
        const timer = setTimeout(() => {
          kill();
          settle(
            err({
              code: 'Unavailable',
              reason: `git ${context.redact(argv.join(' '))} exceeded the ${timeoutMs}ms bound and was stopped. The remote may already have received the objects, so read the remote ref before retrying.`,
            }),
          );
        }, timeoutMs);
        timer.unref?.();

        try {
          child = spawn(gitBinary, [...argv], {
            cwd: workingDirectory,
            shell: false,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ...(options.env ?? {}) },
          });
        } catch (cause) {
          settle(
            err({
              code: 'Unavailable',
              reason: context.redact(
                `git could not be started: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
            }),
          );
          return;
        }

        context.signal.addEventListener('abort', onAbort, { once: true });
        let stdout = '';
        let stderr = '';
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', (cause: Error) => {
          settle(
            err({
              code: 'Unavailable',
              reason: context.redact(
                `git ${argv.join(' ')} could not be run: ${cause.message}. Install git or configure the transport binary.`,
              ),
            }),
          );
        });
        child.on('close', (code: number | null) => {
          if (context.signal.aborted) {
            settle(
              err({
                code: 'OutcomeUnknown',
                reason: context.redact(
                  `git ${argv.join(' ')} was stopped because the caller aborted the operation, so whether it reached the remote is unknown. Read the remote ref before retrying.`,
                ),
                operationId: context.operationId,
                target: invocation,
              }),
            );
            return;
          }
          settle(ok({ exitCode: code ?? -1, stdout, stderr }));
        });
      });
    },
  };
}
