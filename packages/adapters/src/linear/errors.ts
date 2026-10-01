/**
 * Linear API failure to `DomainError` mapping (F03-AC2, F03-AC4, F30-AC4, N02-AC2).
 *
 * Two properties of Linear's GraphQL endpoint shape this module. Both were captured
 * live on 1 October 2026 against the owner's workspace and are quoted in `README.md`:
 *
 * 1. A failure is usually **not** an HTTP error status. A missing issue came back as
 *    HTTP **200** with `data: null` and one entry in `errors[]`
 *    (`"Entity not found: Issue"`, `extensions.code = "INPUT_ERROR"`,
 *    `extensions.statusCode = 400`). A transport that only branches on the status code
 *    reads that as a success with no data, so the `errors[]` envelope is parsed first
 *    and the status is consulted only for the categories the envelope does not
 *    describe. Observed statuses were 200 (not found), 400 (invalid input) and 401
 *    (unauthenticated); 403, 404, 429 and 5xx are handled because F30-AC4 requires the
 *    category and the hint whether or not Linear itself emits them today.
 * 2. A rate limit is **not** a 429 in Linear's own docs: it is HTTP 400 with
 *    `errors[].extensions.code === "RATELIMITED"`. This was **not** observed live,
 *    because provoking one would spend the workspace's shared budget, so the clause
 *    below is documentation-derived. Neither form carries a `Retry-After` header on the
 *    responses observed here; the hint lives in the `x-ratelimit-*-reset`
 *    epoch-millisecond headers, which were read directly.
 *
 * Every provider-supplied string is passed through the caller's `redact` before it
 * reaches an error message, because a provider message is echoed into the owner UI,
 * logs and exports (N02-AC2).
 *
 * A fourth shape is separated from the rest: a **write whose response was lost**.
 * Nothing in the HTTP exchange says whether the mutation reached Linear, so it is
 * reported as `OutcomeUnknown` with the operation identity retained, never as a
 * failure (F28-AC4, F30-AC5). See `lostWriteOutcome`.
 */

import {
  blocked,
  invalid,
  outcomeUnknown,
  type DomainError,
} from '@shiploop/domain';

/** One entry of Linear's `errors[]` envelope, as far as the mapping needs it. */
export interface LinearApiError {
  readonly message: string;
  /** Field path GraphQL reported, e.g. `["issueCreate", "input", "teamId"]`. */
  readonly path: readonly string[];
  readonly code: string | null;
  readonly type: string | null;
  /** Linear's own owner-facing phrasing, preferred over the internal `message`. */
  readonly userPresentableMessage: string | null;
  readonly statusCode: number | null;
}

/** Header names are case-insensitive on the wire and lowercased by `fetch`. */
export type LinearHeaders = Readonly<Record<string, string>>;

export interface LinearFailure {
  /** HTTP status, or 0 when the request never produced a response. */
  readonly status: number;
  readonly headers: LinearHeaders;
  /** Raw response body, because the error category is inside it. */
  readonly bodyText: string;
  /** GraphQL operation name, so an owner-visible error says which call failed. */
  readonly operationName: string;
  /** Milliseconds since the epoch, used to turn a reset instant into a wait. */
  readonly nowMs: number;
  readonly redact: (text: string) => string;
}

const CODE_RATE_LIMITED = 'RATELIMITED';
const CODE_AUTHENTICATION = new Set(['AUTHENTICATION_ERROR', 'AUTHENTICATION_FAILED', 'AUTHENTICATION_REQUIRED']);
const CODE_AUTHORIZATION = new Set(['FORBIDDEN', 'ENTITY_FORBIDDEN', 'FEATURE_NOT_ACCESSIBLE', 'PERMISSION_DENIED']);
const CODE_NOT_FOUND = new Set(['ENTITY_NOT_FOUND', 'NOT_FOUND']);
const CODE_INVALID = new Set(['INVALID_INPUT', 'BAD_USER_INPUT', 'INVALID_ARGUMENT', 'GRAPHQL_VALIDATION_FAILED']);
const CODE_DEPRECATED = new Set(['DEPRECATED_ENDPOINT']);

/**
 * Wording Linear uses when the requested issue identity already exists.
 *
 * `IssueCreateInput.id` is client-supplied (confirmed by introspection), so a repeat
 * publication addresses an identity that may already be taken. Linear's exact
 * rejection for that case has **not** been observed, because establishing it requires
 * a write in the owner's workspace; this is the one clause in the module that is
 * matched on documented intent rather than on a live capture, and `README.md` records
 * it as unproven. Everything else below was captured live.
 */
const ALREADY_EXISTS_MARKERS = ['already exists', 'already been taken', 'duplicate identifier'];

/**
 * Linear's own wording for a full workspace.
 *
 * The specification requires capacity blockers to be reported rather than
 * discovered as a generic failure (mvp-spec 11, Linear pricing). Linear returns
 * this as an ordinary user error, so it is recognised by content.
 */
const CAPACITY_MARKERS = ['issue limit', 'limit reached', 'maximum number of issues', 'issue limit reached', 'too many issues'];

/** Parses the `errors[]` envelope, returning an empty list for a non-envelope body. */
export function parseLinearErrors(bodyText: string): readonly LinearApiError[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(bodyText);
  } catch {
    return [];
  }
  if (decoded === null || typeof decoded !== 'object') return [];
  const errors = (decoded as { readonly errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  const parsed: LinearApiError[] = [];
  for (const entry of errors) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const extensions =
      record['extensions'] !== null && typeof record['extensions'] === 'object'
        ? (record['extensions'] as Record<string, unknown>)
        : {};
    parsed.push({
      message: stringOr(record['message'], 'Linear reported a failure without a message.'),
      path: stringArray(record['path']),
      code: stringOrNull(extensions['code']),
      type: stringOrNull(extensions['type']),
      userPresentableMessage: stringOrNull(extensions['userPresentableMessage']),
      statusCode: typeof extensions['statusCode'] === 'number' ? extensions['statusCode'] : null,
    });
  }
  return parsed;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function header(headers: LinearHeaders, name: string): string | null {
  const found = headers[name.toLowerCase()];
  return typeof found === 'string' && found.length > 0 ? found : null;
}

/**
 * The wait a rate-limited caller should honour.
 *
 * `Retry-After` wins when present because it is the only value that states a delay
 * rather than an instant. It is either delta-seconds or an HTTP-date, and both forms
 * are accepted because a gateway in front of the API may emit either. Otherwise the
 * reset headers are epoch milliseconds — verified live, they read
 * `x-ratelimit-requests-reset: 1790829152303` — so the hint is the distance from now,
 * floored at zero.
 */
export function linearRetryAfterMs(headers: LinearHeaders, nowMs: number): number | null {
  const retryAfter = header(headers, 'retry-after');
  if (retryAfter !== null) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) return Math.max(0, asDate - nowMs);
  }
  for (const name of ['x-ratelimit-endpoint-requests-reset', 'x-ratelimit-requests-reset', 'x-ratelimit-complexity-reset']) {
    const reset = header(headers, name);
    if (reset === null) continue;
    const at = Number.parseInt(reset, 10);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  return null;
}

/**
 * A mutation whose response never arrived.
 *
 * The write may or may not have reached Linear, and a plain failure would invite the
 * caller to retry it and risk a duplicate issue, comment or relation. Reporting
 * `OutcomeUnknown` with the operation identity keeps reconciliation the next step
 * instead (F30-AC5, and ARCHITECTURE "A lost response becomes Outcome unknown").
 */
export function lostWriteOutcome(input: {
  readonly operationName: string;
  readonly operationId: string;
  readonly target: string;
  readonly detail: string;
  readonly redact: (text: string) => string;
}): DomainError {
  return outcomeUnknown(
    input.redact(
      `The ${input.operationName} write was issued to Linear and its response was lost (${input.detail}). Whether it took effect is unknown, so read the target instead of repeating the write.`,
    ),
    input.operationId,
    input.target,
  );
}

/** Whether a refusal names an identity Linear has already taken. */
export function isAlreadyExistsFailure(error: DomainError): boolean {
  if (error.code !== 'Invalid') return false;
  const haystack = `${error.reason} ${error.fields.map((field) => field.message).join(' ')}`.toLowerCase();
  return ALREADY_EXISTS_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * Maps one HTTP-level failure onto the domain vocabulary.
 *
 * The envelope is the primary signal because that is how Linear reports almost
 * everything; the status is the fallback for responses with no parseable envelope.
 */
export function mapLinearFailure(failure: LinearFailure): DomainError {
  const errors = parseLinearErrors(failure.bodyText);
  if (errors.length > 0) return mapLinearErrors(failure, errors);
  return mapOpaqueFailure(failure);
}

/** Maps a parsed `errors[]` envelope, whether it arrived with 200, 400 or 401. */
export function mapLinearErrors(failure: LinearFailure, errors: readonly LinearApiError[]): DomainError {
  const { redact } = failure;
  const rateLimited = errors.find(
    (entry) => entry.code === CODE_RATE_LIMITED || entry.statusCode === 429 || failure.status === 429,
  );
  if (rateLimited !== undefined) {
    return {
      code: 'RateLimited',
      reason: redact(
        `Linear rate limited ${failure.operationName}. The call was not retried inside the adapter, so no duplicate work is possible.`,
      ),
      retryAfterMs: linearRetryAfterMs(failure.headers, failure.nowMs),
    };
  }

  const deprecated = errors.find((entry) => CODE_DEPRECATED.has(entry.code ?? '') || entry.message.toLowerCase() === 'deprecated');
  if (deprecated !== undefined) {
    return {
      code: 'Unavailable',
      reason: redact(
        `Linear reports ${failure.operationName} as deprecated: ${preferMessage(deprecated, redact)}. This adapter must move to the supported endpoint before this operation can be called.`,
      ),
    };
  }

  const authFailed = errors.find(
    (entry) => entry.code !== null && CODE_AUTHENTICATION.has(entry.code),
  );
  if (authFailed !== undefined || failure.status === 401) {
    return {
      code: 'Forbidden',
      reason: redact(
        `Linear rejected the stored credential for ${failure.operationName} as unauthenticated. The Linear connector credential must be reauthorized in Linear before any new operation; repeated attempts with the same credential cannot succeed.`,
      ),
    };
  }

  const forbidden = errors.find((entry) => entry.code !== null && CODE_AUTHORIZATION.has(entry.code));
  if (forbidden !== undefined || failure.status === 403) {
    return {
      code: 'Forbidden',
      reason: redact(
        `Linear refused ${failure.operationName} for this credential: ${preferMessage(forbidden, redact)}. Grant the connector access to this workspace, team or issue in Linear; a similarly named issue or team is not a substitute.`,
      ),
    };
  }

  const capacity = errors.find((entry) => {
    const haystack = `${entry.message} ${entry.userPresentableMessage ?? ''}`.toLowerCase();
    return CAPACITY_MARKERS.some((marker) => haystack.includes(marker));
  });
  if (capacity !== undefined) {
    return blocked(
      redact(`Linear refused ${failure.operationName}: ${preferMessage(capacity, redact)}`),
      [
        {
          name: 'LinearIssueCapacity',
          detail: redact(preferMessage(capacity, redact)),
          remedy:
            'Free an issue slot in Linear by completing, cancelling or deleting a closed issue, or raise the workspace plan, then retry. The proposal is preserved and no issue was created.',
        },
      ],
    );
  }

  const notFound = errors.find(
    (entry) =>
      (entry.code !== null && CODE_NOT_FOUND.has(entry.code)) ||
      entry.message.toLowerCase().includes('entity not found') ||
      (entry.userPresentableMessage?.toLowerCase().includes('could not find referenced') ?? false),
  );
  if (notFound !== undefined || failure.status === 404) {
    return {
      code: 'NotFound',
      reason: redact(
        `Linear has no resource for ${failure.operationName}: ${preferMessage(notFound, redact)}. Confirm the identifier and that the connector credential can read it.`,
      ),
    };
  }

  const invalidInput = errors.find(
    (entry) =>
      (entry.code !== null && CODE_INVALID.has(entry.code)) ||
      entry.statusCode === 400 ||
      entry.type === 'invalid input',
  );
  if (invalidInput !== undefined || failure.status === 400 || failure.status === 422) {
    return invalid(
      redact(`Linear refused ${failure.operationName} as malformed or invalid input.`),
      errors.map((entry) => ({
        path: fieldPath(entry),
        message: redact(preferMessage(entry, redact)),
      })),
    );
  }

  if (failure.status >= 500) {
    return {
      code: 'Unavailable',
      reason: redact(`Linear returned HTTP ${failure.status} for ${failure.operationName}. The provider is unavailable; no local retry was attempted.`),
    };
  }

  return {
    code: 'Unavailable',
    reason: redact(
      `Linear returned HTTP ${failure.status} for ${failure.operationName} without a category this adapter recognises: ${preferMessage(errors[0], redact)}`,
    ),
  };
}

/** A response with no recognisable error envelope, including transport failures. */
function mapOpaqueFailure(failure: LinearFailure): DomainError {
  const { status, redact } = failure;
  const excerpt = redact(failure.bodyText.slice(0, 200));
  if (status === 0) {
    return {
      code: 'Unavailable',
      reason: redact(
        `The Linear API could not be reached for ${failure.operationName} (no HTTP response). The request may not have been delivered, so its outcome is unknown rather than failed.`,
      ),
    };
  }
  if (status === 429) {
    return {
      code: 'RateLimited',
      reason: redact(`Linear rate limited ${failure.operationName}. The call was not retried inside the adapter.`),
      retryAfterMs: linearRetryAfterMs(failure.headers, failure.nowMs),
    };
  }
  if (status === 401) {
    return {
      code: 'Forbidden',
      reason: redact(
        `Linear rejected the stored credential for ${failure.operationName} as unauthenticated. The Linear connector credential must be reauthorized in Linear before any new operation.`,
      ),
    };
  }
  if (status === 403) {
    return {
      code: 'Forbidden',
      reason: redact(`Linear refused ${failure.operationName} for this credential. Grant the connector access in Linear, then retry.`),
    };
  }
  if (status === 404) {
    return { code: 'NotFound', reason: redact(`Linear has no resource for ${failure.operationName}.`) };
  }
  if (status >= 500) {
    return {
      code: 'Unavailable',
      reason: redact(`Linear returned HTTP ${status} for ${failure.operationName}. The provider is unavailable; no local retry was attempted.`),
    };
  }
  return {
    code: 'Unavailable',
    reason: redact(`Linear returned HTTP ${status} for ${failure.operationName}: ${excerpt}`),
  };
}

/** Linear's owner-facing phrasing when it exists, because `message` is developer prose. */
function preferMessage(entry: LinearApiError | undefined, redact: (text: string) => string): string {
  if (entry === undefined) return 'no detail was supplied';
  return redact(entry.userPresentableMessage ?? entry.message);
}

/**
 * Turns a GraphQL path into a field path the owner UI can attach an error to.
 *
 * A GraphQL error path is rooted at the **field**, not the operation: a rejection of
 * `issueCreate` arrives as `["issueCreate", "input", "teamId"]`, observed live. So the
 * leading field name and any `input` segment are dropped and `teamId` — the field the
 * profile actually owns — is what remains. A path with nothing left means the provider
 * refused the request as a whole, which `(request)` states rather than inventing a field.
 */
function fieldPath(entry: LinearApiError): string {
  const segments = entry.path.filter((segment) => segment !== 'input');
  const rooted = segments.length > 1 && /^[a-z][A-Za-z0-9]*$/.test(segments[0] ?? '') ? segments.slice(1) : segments;
  return rooted.length > 0 ? rooted.join('.') : '(request)';
}
