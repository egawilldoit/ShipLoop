/**
 * GitHub API and `git` failure to `DomainError` mapping
 * (F19-AC2, F19-AC4, F20-AC2, F26-AC3, F28-AC4, F30-AC2, F30-AC4, F30-AC5, N02-AC2).
 *
 * Five provider facts shape this module. All were captured live on 1 October 2026
 * against `egawilldoit/ShipLoop` with the owner's own credential, and every capture is
 * quoted with its output in `README.md` rather than asserted from documentation:
 *
 * 1. **A missing resource is HTTP 404** with a flat error object rather than an
 *    envelope: `GET /repos/egawilldoit/ShipLoop/git/ref/heads/does-not-exist` returned
 *    `{"message":"Not Found","documentation_url":"https://docs.github.com/rest/git/refs#get-a-reference","status":"404"}`.
 *    So `message` is the only useful field and the transport reads it before the status.
 * 2. **The rate-limit reset header is epoch SECONDS**, verified live as
 *    `x-ratelimit-reset: 1790847829`. It is not the epoch milliseconds another provider
 *    uses, so `githubRetryAfterMs` multiplies before subtracting; treating it as
 *    milliseconds produces a hint in 1970 and a busy retry loop (F30-AC4).
 * 3. **A merge precondition failure is HTTP 409, not 412.** The endpoint's own
 *    description is `Conflict if sha was provided and pull request head did not match`,
 *    with the example body `{"message":"Head branch was modified. Review and try the
 *    merge again."}`. F26-AC3 requires that case to be `Conflict` naming both SHAs, so
 *    409 is tested before the generic conflict branch. This mapping is
 *    documentation-derived rather than captured, because provoking it requires a merge
 *    attempt on live state; `README.md` says so.
 * 4. **A merge that cannot be performed is HTTP 405**, described as `Method Not Allowed
 *    if merge cannot be performed` with `{"message":"Pull Request is not mergeable"}`. A
 *    draft, an unresolved conflict or an unmet protection rule all arrive this way, so it
 *    is `Blocked` with the provider's own reason and a remedy, not `Unavailable`: the
 *    operation is possible once someone does something (F19-AC4 makes an inaccessible
 *    right an explicit blocker).
 * 5. **A lost write response is not distinguishable from any other failure at the HTTP
 *    layer.** Nothing says whether the request reached GitHub, so `lostGitHubWriteOutcome`
 *    reports `OutcomeUnknown` retaining the operation identity. Reporting it as a failure
 *    would invite the retry that creates the second pull request F19-AC1 and F19-AC3
 *    forbid (F28-AC4, F30-AC5).
 *
 * Every provider-supplied string is passed through the caller's `redact` before it
 * reaches an error message, because a provider message is echoed into the owner UI, logs
 * and exports, and raw check output routinely contains credentials (N02-AC2).
 */

import {
  blocked,
  conflict,
  invalid,
  outcomeUnknown,
  type CheckResult,
  type DomainError,
} from '@shiploop/domain';

/** Header names are case-insensitive on the wire and lowercased by `fetch`. */
export type GitHubHeaders = Readonly<Record<string, string>>;

/** GitHub's own error object, as far as the mapping needs it. */
export interface GitHubApiError {
  readonly message: string;
  readonly documentationUrl: string | null;
  /** GitHub echoes the status inside the body; null when it did not. */
  readonly status: number | null;
}

export interface GitHubFailure {
  /** HTTP status. Zero is reserved for a request that never produced a response. */
  readonly status: number;
  readonly headers: GitHubHeaders;
  /** Raw response body, because the error category is inside it. */
  readonly bodyText: string;
  /** Owner-visible name of the call, so an error says which provider operation failed. */
  readonly operationName: string;
  /** Milliseconds since the epoch, used to turn a reset instant into a wait. */
  readonly nowMs: number;
  readonly redact: (text: string) => string;
}

/**
 * Wording GitHub uses when a merge's pinned head no longer matches.
 *
 * Matched on content rather than on the status alone, because 409 also covers unrelated
 * write conflicts and reporting a head precondition failure as a generic conflict would
 * hide the one fact F26-AC2 needs (which head the provider actually holds).
 */
const HEAD_PRECONDITION_MARKERS = ['head branch was modified', 'head branch has been modified'];

const NON_FAST_FORWARD_MARKERS = ['non-fast-forward', 'fetch first', 'updates were rejected'];

/** Parses GitHub's flat error object, returning `null` for a body that carries none. */
export function parseGitHubError(bodyText: string): GitHubApiError | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const record = decoded as Record<string, unknown>;
  const message = record['message'];
  if (typeof message !== 'string' || message.length === 0) return null;
  const documentation = record['documentation_url'];
  const status = record['status'];
  return {
    message,
    documentationUrl: typeof documentation === 'string' ? documentation : null,
    status: typeof status === 'number' ? status : null,
  };
}

/**
 * The wait a rate-limited caller should honour.
 *
 * `Retry-After` wins when present because it is the only value that states a delay rather
 * than an instant; it is delta-seconds or an HTTP-date and both are accepted because a
 * gateway in front of the API may emit either. Otherwise the reset header is epoch
 * **seconds** — verified live, `x-ratelimit-reset: 1790847829` — so the value is scaled
 * before it becomes a duration from the injected clock.
 */
export function githubRetryAfterMs(headers: GitHubHeaders, nowMs: number): number | null {
  const retryAfter = headers['retry-after'];
  if (typeof retryAfter === 'string' && retryAfter.length > 0) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) return Math.max(0, asDate - nowMs);
  }
  const reset = headers['x-ratelimit-reset'];
  if (typeof reset === 'string') {
    const at = Number.parseInt(reset, 10);
    if (Number.isFinite(at)) return Math.max(0, at * 1000 - nowMs);
  }
  return null;
}

/**
 * A write whose response never arrived.
 *
 * The write may or may not have reached GitHub, and a plain failure would invite the
 * caller to retry it and risk a second pull request. Reporting `OutcomeUnknown` with the
 * operation identity keeps reconciliation the next step instead (F19-AC3, F30-AC5).
 */
export function lostGitHubWriteOutcome(input: {
  readonly operationName: string;
  readonly operationId: string;
  readonly target: string;
  readonly detail: string;
  readonly redact: (text: string) => string;
}): DomainError {
  return outcomeUnknown(
    input.redact(
      `The ${input.operationName} write was issued to GitHub and its response was lost (${input.detail}). Whether it took effect is unknown, so read ${input.target} instead of repeating the write.`,
    ),
    input.operationId,
    input.target,
  );
}

/**
 * Maps one HTTP-level failure onto the domain vocabulary.
 *
 * GitHub's status codes are the primary signal because they are the part of the contract
 * the provider documents as stable; the body's `message` refines them and is what the
 * owner reads.
 */
export function mapGitHubFailure(failure: GitHubFailure): DomainError {
  const apiError = parseGitHubError(failure.bodyText);
  const message = failure.redact(apiError?.message ?? failure.bodyText.slice(0, 200));
  const { status, operationName, redact } = failure;

  if (status === 429 || status === 403 && isRateLimited(failure)) {
    return {
      code: 'RateLimited',
      reason: redact(
        `GitHub rate limited ${operationName}. The call was not retried inside the adapter, so no duplicate work is possible.`,
      ),
      retryAfterMs: githubRetryAfterMs(failure.headers, failure.nowMs),
    };
  }

  if (status === 401) {
    return {
      code: 'Forbidden',
      reason: redact(
        `GitHub rejected the stored credential for ${operationName} as unauthenticated. A 401 was measured live on this host for an invalid bearer token. The Git connector credential must be reauthorized before any new operation; repeated attempts with the same credential cannot succeed.`,
      ),
    };
  }

  if (status === 403) {
    return {
      code: 'Forbidden',
      reason: redact(
        `GitHub refused ${operationName} for this credential: ${message}. Grant the connector access to this repository in GitHub; a similarly named repository is not a substitute.`,
      ),
    };
  }

  if (status === 409) {
    return mergePreconditionFailure(failure, message);
  }

  if (status === 405) {
    return blocked(redact(`GitHub cannot perform ${operationName}: ${message}`), [
      {
        name: 'PullRequestNotMergeable',
        detail: message,
        remedy:
          'Open the pull request on GitHub and read the reason: a draft cannot be merged, a conflict needs resolving, or a required protection rule is unmet. Nothing was merged and no state changed.',
      },
    ]);
  }

  if (status === 404) {
    return {
      code: 'NotFound',
      reason: redact(
        `GitHub has no resource for ${operationName}: ${message}. Confirm the identifier and that the connector credential can read it.`,
      ),
    };
  }

  if (status === 422 || status === 400) {
    return invalid(
      redact(`GitHub refused ${operationName} as malformed or invalid input.`),
      [{ path: '(request)', message }],
    );
  }

  if (status >= 500) {
    return {
      code: 'Unavailable',
      reason: redact(
        `GitHub returned HTTP ${status} for ${operationName}. The provider is unavailable; no local retry was attempted.`,
      ),
    };
  }

  if (status === 0) {
    return {
      code: 'Unavailable',
      reason: redact(
        `GitHub could not be reached for ${operationName} (no HTTP response). The request may not have been delivered, so its outcome is unknown rather than failed.`,
      ),
    };
  }

  return {
    code: 'Unavailable',
    reason: redact(
      `GitHub returned HTTP ${status} for ${operationName} without a category this adapter recognises: ${message}`,
    ),
  };
}

/** Whether a 403 is GitHub's primary rate limit rather than an authorization refusal. */
function isRateLimited(failure: GitHubFailure): boolean {
  const remaining = failure.headers['x-ratelimit-remaining'];
  if (remaining === '0') return true;
  const message = (parseGitHubError(failure.bodyText)?.message ?? '').toLowerCase();
  return message.includes('rate limit');
}

/**
 * A 409 on a merge.
 *
 * The provider's own precondition failure is `Conflict` naming the head it holds, because
 * F26-AC2 requires the owner to see current facts rather than a generic refusal. Any other
 * 409 falls through to the same shape with the provider message as the reason.
 */
function mergePreconditionFailure(failure: GitHubFailure, message: string): DomainError {
  const haystack = message.toLowerCase();
  const isHeadPrecondition = HEAD_PRECONDITION_MARKERS.some((marker) => haystack.includes(marker));
  if (!isHeadPrecondition) {
    return {
      code: 'Conflict',
      reason: failure.redact(`GitHub reported a conflicting state for ${failure.operationName}: ${message}`),
      expected: 'the state this adapter last observed',
      actual: 'a different state at GitHub',
    };
  }
  return conflict(
    failure.redact(
      `The merge precondition no longer holds, so nothing was merged: ${message}. GitHub compares the pinned head itself, so this is the provider refusing a stale decision rather than a check performed afterwards (F26-AC3).`,
    ),
    'the head the owner authorized',
    message,
  );
}

/**
 * Whether a failed `git` invocation is the provider refusing a non-fast-forward update.
 *
 * Matched on git's own wording rather than on the exit code, because `git push` exits 1
 * for an authentication failure, a rejected non-fast-forward and a remote outage alike.
 * Reporting all three as `Conflict` would tell the owner their branch moved when the real
 * cause was an unusable credential.
 */
export function isNonFastForwardFailure(stderr: string): boolean {
  const haystack = stderr.toLowerCase();
  return NON_FAST_FORWARD_MARKERS.some((marker) => haystack.includes(marker));
}

/** Whether a failed `git` invocation is an authentication or authorization refusal. */
export function isAuthenticationFailure(stderr: string): boolean {
  const haystack = stderr.toLowerCase();
  return (
    haystack.includes('permission denied') ||
    haystack.includes('authentication failed') ||
    haystack.includes('could not read username') ||
    haystack.includes('could not read from remote repository')
  );
}

/**
 * GitHub's check-run conclusion mapped onto the domain check vocabulary.
 *
 * The mapping is deliberately conservative in the direction that matters (F20-AC2). Only
 * `success` becomes `Passed`. A `skipped` or `neutral` conclusion is `NotApplicable`
 * rather than `Passed`, so a skipped required check still blocks until a profile policy
 * decision approves it. A conclusion this adapter does not recognise is `Missing` with a
 * detail naming the provider's value: inventing a pass from an unknown conclusion would be
 * the exact failure F20-AC2 forbids, and inventing a failure would misreport work that
 * passed.
 *
 * `status` is read before `conclusion` because a check that is `queued`, `in_progress`,
 * `waiting`, `requested` or `pending` has produced no result at all, so it is `Waiting`
 * whatever it will eventually conclude.
 */
export function mapCheckConclusion(input: {
  readonly status: string;
  readonly conclusion: string | null;
}): CheckResult {
  switch (input.status) {
    case 'queued':
    case 'in_progress':
    case 'waiting':
    case 'requested':
    case 'pending':
      return 'Waiting';
    case 'completed':
      break;
    default:
      return 'Missing';
  }
  switch (input.conclusion) {
    case 'success':
      return 'Passed';
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'cancelled':
      return 'Failed';
    case 'skipped':
    case 'neutral':
      return 'NotApplicable';
    default:
      return 'Missing';
  }
}

/**
 * GitHub's legacy commit-status state mapped onto the same vocabulary.
 *
 * The `/status` endpoint is still reported by GitHub alongside check runs, and a project
 * whose CI posts commit statuses rather than check runs would otherwise appear to have no
 * results at all. `error` and `failure` are failures; `success` is the only pass. A state
 * this adapter does not recognise is `Missing`, never `Passed`.
 *
 * The aggregate `state` field is deliberately **not** mapped. It was measured live on a
 * commit with zero statuses as `{"state":"pending","total_count":0,"statuses":[]}`, so
 * mapping the aggregate would report a `Waiting` check for a commit on which nothing ran.
 */
export function mapCommitStatusState(state: string): CheckResult {
  switch (state) {
    case 'success':
      return 'Passed';
    case 'failure':
    case 'error':
      return 'Failed';
    case 'pending':
      return 'Waiting';
    default:
      return 'Missing';
  }
}