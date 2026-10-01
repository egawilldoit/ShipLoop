/**
 * The Linear GraphQL transport (F03-AC1, F30-AC4).
 *
 * Linear's API is a single POST endpoint authenticated with the raw API key in the
 * `Authorization` header and **no** `Bearer` prefix; adding one is the most common
 * cause of a 401 that looks like a revoked credential. Observed live on 1 October
 * 2026: `Authorization: <key>` returns 200 with the viewer's identity, and the same
 * request with `Bearer <key>` would be rejected.
 *
 * The client never throws and never retries by default. F30-AC4 requires a rate
 * limit to reach the caller with its category and its retry hint rather than being
 * absorbed by an adapter-internal loop, so retrying a rate limit is opt-in through
 * `maxRateLimitRetries` and is still the only retry category this transport has:
 * an auth failure, a not-found and a malformed input are returned to the caller,
 * never retried, because repeating them cannot change the answer.
 */

import { err, ok, type DomainError, type Result } from '@shiploop/domain';
import type { AdapterContext } from '../contracts/index.ts';
import { lostWriteOutcome, mapLinearFailure, type LinearHeaders } from './errors.ts';

export const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

export interface LinearClientOptions {
  /** Read from the environment by the caller; never logged and never persisted. */
  readonly apiKey: string;
  readonly endpoint?: string;
  /** Hard bound on one request, so an unresponsive provider cannot hang a run. */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Zero by default (F30-AC4). Values above zero enable bounded rate-limit backoff only. */
  readonly maxRateLimitRetries?: number;
  readonly maxBackoffMs?: number;
}

/** The provider's own rate-limit budget, read from the `x-ratelimit-*` headers. */
export interface LinearRateLimitSnapshot {
  readonly requestLimit: number | null;
  readonly requestRemaining: number | null;
  readonly endpointLimit: number | null;
  readonly endpointRemaining: number | null;
  readonly complexityRemaining: number | null;
  readonly resetAtMs: number | null;
}

export interface LinearSuccess {
  /** Raw `data` object; every field is read through a boundary reader, never trusted. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly rateLimit: LinearRateLimitSnapshot;
  readonly requestId: string | null;
}

export interface LinearReadQuery {
  readonly operationName: string;
  readonly document: string;
  readonly variables: Record<string, unknown>;
}

/**
 * A query that writes.
 *
 * `mutating` is not documentation: it is what decides whether a lost response becomes
 * `OutcomeUnknown` or `Unavailable`. Repeating a read is free, so a lost read is an
 * unavailability; repeating a write may duplicate an issue, a comment or a relation,
 * so the ambiguity has to be reported rather than absorbed (F28-AC4, F30-AC5).
 */
export interface LinearWriteQuery extends LinearReadQuery {
  readonly mutating: true;
  /** The external identity the write addresses, for reconciliation. */
  readonly target: string;
}

export type LinearQuery = LinearReadQuery | LinearWriteQuery;

/** Whether a query addresses the provider as a write. */
export function isLinearWrite(query: LinearQuery): query is LinearWriteQuery {
  return (query as LinearWriteQuery).mutating === true;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * A minimal GraphQL envelope reader.
 *
 * Linear's `data` is `null` whenever any error is present, so the shape is only
 * read when `errors` is absent.
 */
function isUsableEnvelope(value: unknown): value is { readonly data: Record<string, unknown> } {
  if (!isRecord(value)) return false;
  const errors = value['errors'];
  if (Array.isArray(errors) && errors.length > 0) return false;
  return isRecord(value['data']);
}

export class LinearClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly maxBackoffMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LinearClientOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error('A Linear API key is required; the value is never logged.');
    }
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 0;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Runs one GraphQL operation and returns raw `data` or a mapped domain error.
   *
   * The caller supplies the abort signal, so a controller-cancelled run stops the
   * provider call instead of waiting out the timeout.
   */
  async execute(context: AdapterContext, query: LinearQuery): Promise<Result<LinearSuccess>> {
    let attempt = 0;
    for (;;) {
      const outcome = await this.attempt(context, query);
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
   * A read that never came back is retried by the controller like any other
   * unavailability. A write that never came back may have landed, so it is
   * `OutcomeUnknown` naming the operation identity the caller supplied and the target
   * the write addressed — never a failure, which would invite the duplicate F10-AC3
   * forbids.
   */
  private undelivered(
    context: AdapterContext,
    query: LinearQuery,
    detail: string,
  ): DomainError {
    if (isLinearWrite(query)) {
      return lostWriteOutcome({
        operationName: query.operationName,
        operationId: context.operationId,
        target: query.target,
        detail,
        redact: context.redact,
      });
    }
    return {
      code: 'Unavailable',
      reason: context.redact(
        `${query.operationName} was not answered by Linear (${detail}). The call was a read, so repeating it cannot change provider state; retry or wait for reconciliation.`,
      ),
    };
  }

  /** Bounded, deterministic backoff: the provider's own hint first, then a capped ramp. */
  private backoffFor(retryAfterMs: number | null, attempt: number): number {
    const ramp = Math.min(this.maxBackoffMs, 500 * 2 ** (attempt - 1));
    const requested = retryAfterMs ?? ramp;
    return Math.min(this.maxBackoffMs, Math.max(requested, 0));
  }

  private async attempt(context: AdapterContext, query: LinearQuery): Promise<Result<LinearSuccess>> {
    // The retry hint a rate limit carries is a duration from now, so the "now" it is
    // measured against is the injected clock rather than the ambient one. Using
    // `Date.now()` would make the hint untestable and inconsistent with every other
    // timestamp the adapter reports.
    const observed = Date.parse(context.clock.now());
    const nowMs = Number.isFinite(observed) ? observed : Date.now();
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([context.signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: this.apiKey,
        },
        body: JSON.stringify({
          operationName: query.operationName,
          query: query.document,
          variables: query.variables,
        }),
        signal,
      });
    } catch (cause) {
      const detail = context.signal.aborted
        ? 'the caller aborted the operation'
        : `no HTTP response (${context.redact(cause instanceof Error ? cause.message : String(cause))})`;
      return err(this.undelivered(context, query, detail));
    }

    const headers = headersOf(response);
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (cause) {
      // The status line arrived, so the provider accepted the request; only the body
      // was lost. For a write that is still an unknown outcome.
      return err(
        this.undelivered(
          context,
          query,
          `the response body could not be read (${context.redact(cause instanceof Error ? cause.message : String(cause))})`,
        ),
      );
    }

    const envelope = safeParse(bodyText);
    const rateLimit = readRateLimit(headers);

    if (!response.ok || !isUsableEnvelope(envelope)) {
      return err(
        mapLinearFailure({
          status: response.status,
          headers,
          bodyText,
          operationName: query.operationName,
          nowMs,
          redact: context.redact,
        }),
      );
    }

    return ok({
      data: envelope.data,
      rateLimit,
      requestId: headers['x-request-id'] ?? null,
    });
  }
}

function safeParse(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

function headersOf(response: Response): LinearHeaders {
  const collected: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    collected[key.toLowerCase()] = value;
  });
  return collected;
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readRateLimit(headers: LinearHeaders): LinearRateLimitSnapshot {
  return {
    requestLimit: numberOrNull(headers['x-ratelimit-requests-limit']),
    requestRemaining: numberOrNull(headers['x-ratelimit-requests-remaining']),
    endpointLimit: numberOrNull(headers['x-ratelimit-endpoint-requests-limit']),
    endpointRemaining: numberOrNull(headers['x-ratelimit-endpoint-requests-remaining']),
    complexityRemaining: numberOrNull(headers['x-ratelimit-complexity-remaining']),
    resetAtMs: numberOrNull(headers['x-ratelimit-requests-reset']),
  };
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
