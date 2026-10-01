/**
 * Codex engine failure to `DomainError` and `EngineOutcome` mapping (F15-AC3, F18-AC1, F18-AC5).
 *
 * Codex reports failure two ways and both were observed on `codex-cli 0.159.1` on this host
 * (linux/arm64, 2 x Neoverse-N1, Node 24.18.0) on 1 October 2026:
 *
 * 1. A **`turn.failed` JSONL event**, which is the terminal signal, and
 * 2. **`error` JSONL events**, which are progress-level reports and are frequently
 *    *transient*.
 *
 * That second shape is why a diagnostic never decides a run's outcome on its own. A real
 * capture of a missing login produced eleven `error` lines that were all
 * `Reconnecting... N/5 (unexpected status 401 Unauthorized: ...)`, and the run's only
 * terminal event was the `turn.failed` carrying the same 401. Reading an `error` line as
 * the outcome would therefore report the tenth reconnect as the result. Only `turn.failed`
 * and `turn.completed` end a turn; everything else is a diagnostic.
 *
 * The wording below is Codex's own. Quoted strings are byte-for-byte from a capture on this
 * host unless the comment says otherwise, and `README.md` separates the observed clauses
 * from the ones derived from the binary's error-variant names.
 */

import { blocked, invalid, type DomainError } from '@shiploop/domain';
import type { EngineDiagnosticCategory, EngineDiagnosticRetry, EngineOutcome } from '../contracts/index.ts';

/** Failure inputs shared by every mapping in this module. */
export interface CodexFailureInput {
  /** Verbatim engine text, already truncated by the caller. */
  readonly detail: string;
  /** Process exit code, or null when the process was signalled. */
  readonly exitCode: number | null;
  readonly redact: (text: string) => string;
}

/**
 * Codex's own wording, observed live.
 *
 * Every string in this table came from a capture on 1 October 2026 and the comment names
 * the capture. `codex` wraps a provider error as a JSON string inside `message`, so the
 * marker search runs over the raw text rather than a parsed object.
 */
const AUTH_MARKERS: readonly string[] = [
  // Observed: `turn.failed` after an empty CODEX_HOME —
  // "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header".
  'missing bearer or basic authentication',
  // Observed: the same capture, on the websocket transport.
  '401 unauthorized',
  // Observed: `codex login status` outside a logged-in CODEX_HOME prints exactly this.
  'not logged in',
  // From the binary's `CodexError` variant list (`unauthorized`), not from a capture.
  'unauthorized',
];

const MODEL_MARKERS: readonly string[] = [
  // Observed: `-m definitely-not-a-real-model-xyz` produced
  // "The 'definitely-not-a-real-model-xyz' model is not supported when using Codex with a ChatGPT account."
  'model is not supported when using codex',
  // Observed: the same run, as an earlier `item.completed` error item.
  'model metadata for',
  // From the binary's error-variant list, not from a capture.
  'model_not_found',
];

const QUOTA_MARKERS: readonly string[] = [
  // Observed in the binary's owner-facing strings ("You have hit your usage limit. Upgrade to
  // Pro ..., visit .../usage to purchase more credits"). Not provoked live: exhausting the
  // owner's quota is not something this adapter may do to prove a mapping.
  'usage limit',
  // From the binary's error-variant list (`rate_limit_exceeded`, `quota_exceeded`,
  // `usage_limit_reached`), not from a capture.
  'rate_limit_exceeded',
  'quota_exceeded',
  'usage_limit_reached',
  'workspace_owner_usage_limit_reached',
  'workspace_member_credits_depleted',
  'insufficient_quota',
];

/**
 * Runtime the host cannot support.
 *
 * `sandbox ... cannot be enforced on this host` is a real message the binary carries for the
 * case where no sandbox executable is available; it was **not** observed here, because this
 * host does have a working bundled sandbox. It is listed because an engine that cannot enforce
 * its sandbox must not be reported as running inside one (F03-AC5).
 */
const RUNTIME_MARKERS: readonly string[] = [
  'cannot be enforced on this host',
  'sandbox_executable_not_provided',
  'unsupported platform',
  'not supported on this platform',
  'exec format error',
  'no such file or directory',
];

/**
 * Output the engine (or the reader) could not interpret.
 *
 * A stream this adapter cannot read is a deterministic condition, so it must be `Terminal` and
 * must never be retried or re-parsed into a success (F15-AC2, F18-AC5).
 */
const MALFORMED_MARKERS: readonly string[] = [
  'could not be parsed',
  'could not parse',
  'malformed',
  'invalid json',
  'expected value at line',
  'unexpected end of json input',
];

const SANDBOX_MARKERS: readonly string[] = [
  'sandbox',
  'permission denied',
  'read-only file system',
  'outside the workspace',
];

const NETWORK_MARKERS: readonly string[] = [
  // Observed: the websocket and HTTPS transport both reported
  // "Reconnecting... N/5 (unexpected status 401 ...)" and "Falling back from WebSockets to HTTPS transport.".
  'reconnecting',
  'falling back from websockets',
  'connection',
  'econnreset',
  'etimedout',
  'enotfound',
  'stream error',
  'http_connection_failed',
  'response_stream_disconnected',
];

/** A refusal that leaves the workspace intact and states who must act (F15-AC3). */
export interface CodexBlocker {
  readonly category: Extract<
    EngineDiagnosticCategory,
    'MissingAuthentication' | 'UnavailableModel' | 'QuotaExhausted' | 'UnsupportedRuntime'
  >;
  readonly name: string;
  readonly remedy: string;
}

/**
 * Classifies engine text into the contract's closed diagnostic vocabulary.
 *
 * The order is deliberate and is the whole design of this function. Authentication is checked
 * before network because Codex wraps its 401 inside a `Reconnecting...` line, so a
 * network-first order would classify every missing login as a retryable network blip and the
 * owner would be told to wait rather than to sign in. Model is checked before network for the
 * same reason: the unsupported-model capture also arrived through the same transport.
 */
export function classifyCodexFailure(detail: string): EngineDiagnosticCategory {
  const haystack = detail.toLowerCase();
  if (AUTH_MARKERS.some((marker) => haystack.includes(marker))) return 'MissingAuthentication';
  if (MODEL_MARKERS.some((marker) => haystack.includes(marker))) return 'UnavailableModel';
  if (QUOTA_MARKERS.some((marker) => haystack.includes(marker))) return 'QuotaExhausted';
  if (RUNTIME_MARKERS.some((marker) => haystack.includes(marker))) return 'UnsupportedRuntime';
  if (MALFORMED_MARKERS.some((marker) => haystack.includes(marker))) return 'MalformedOutput';
  if (SANDBOX_MARKERS.some((marker) => haystack.includes(marker))) return 'SandboxDenial';
  if (NETWORK_MARKERS.some((marker) => haystack.includes(marker))) return 'NetworkError';
  return 'ToolError';
}

/**
 * Whether a category may be retried without a change of inputs.
 *
 * F18-AC5 forbids retrying a deterministic scope or authentication failure blindly, so the
 * four blockers are terminal and only the two environmental categories are retryable.
 */
export function codexDiagnosticRetry(category: EngineDiagnosticCategory): EngineDiagnosticRetry {
  return category === 'NetworkError' || category === 'ToolError' ? 'Retryable' : 'Terminal';
}

/** The four categories the contract allows as a `Blocked` outcome (F15-AC3). */
const BLOCKERS: Readonly<Record<string, CodexBlocker>> = {
  MissingAuthentication: {
    category: 'MissingAuthentication',
    name: 'CodexAuthentication',
    remedy:
      'Run `codex login` on the execution host, or set a supported Codex API key environment variable, then start a new attempt. Repeating the same run without credentials cannot succeed. ShipLoop does not copy browser credentials and does not switch accounts for you (F15-AC5).',
  },
  UnavailableModel: {
    category: 'UnavailableModel',
    name: 'CodexModelAvailability',
    remedy:
      'Choose a model the configured Codex account is entitled to, or ask the account owner to change the plan. The requested model name was rejected by the provider, so no other model will be accepted for this configuration.',
  },
  QuotaExhausted: {
    category: 'QuotaExhausted',
    name: 'CodexAccountQuota',
    remedy:
      'Wait for the account usage window to reset, or have the owner add credits or raise the plan. The reported figure was the provider own; ShipLoop does not estimate remaining quota or cost (F18-AC4).',
  },
  UnsupportedRuntime: {
    category: 'UnsupportedRuntime',
    name: 'CodexRuntime',
    remedy:
      'Install a Codex build for this host architecture and confirm it can enforce its sandbox, then start a new attempt. An engine that cannot enforce the sandbox is refused rather than run unrestricted (F03-AC5).',
  },
};

export function isCodexBlocker(
  category: EngineDiagnosticCategory,
): category is CodexBlocker['category'] {
  return Object.hasOwn(BLOCKERS, category);
}

/**
 * The actionable remedy for a blocked category.
 *
 * Returning null for a non-blocked category is what keeps a `Blocked` outcome from being
 * manufactured for a failure the contract does not allow to block on.
 */
export function codexBlockerFor(category: EngineDiagnosticCategory): CodexBlocker | null {
  return isCodexBlocker(category) ? (BLOCKERS[category] ?? null) : null;
}

/**
 * The `Blocked` outcome for a failure the owner has to resolve.
 *
 * F15-AC3 also requires the workspace to survive, and the way this adapter honours that is
 * structural rather than a promise: a blocked run only ever reads and executes commands inside
 * the workspace it was given, and nothing in this module removes a path. The workspace is left
 * exactly as the engine left it.
 */
export function codexBlockedOutcome(
  category: CodexBlocker['category'],
  detail: string,
  redact: (text: string) => string,
): EngineOutcome {
  const blocker = BLOCKERS[category];
  return {
    kind: 'Blocked',
    category,
    remedy: blocker?.remedy ?? 'The owner must resolve the reported engine precondition before a new attempt can start.',
    summary: redact(detail),
  };
}

/**
 * Maps a terminal engine failure onto the domain vocabulary.
 *
 * The four blockers become `Blocked` with a named prerequisite, because the specification
 * requires an actionable blocked result rather than a failure the owner has to decode
 * (F15-AC3). Everything else becomes a typed refusal: a malformed or absent Codex build is
 * `Unavailable` because retrying the same binary cannot help, and an unrecognised failure is
 * `Invalid` because the input that produced it must change first.
 */
export function mapCodexFailure(input: CodexFailureInput): DomainError {
  const category = classifyCodexFailure(input.detail);
  const detail = input.redact(input.detail);
  const exit = input.exitCode === null ? 'the process was signalled' : `exit code ${input.exitCode}`;

  if (isCodexBlocker(category)) {
    const blocker = BLOCKERS[category];
    return blocked(
      `Codex reported ${category} (${exit}): ${detail}`,
      [
        {
          name: blocker?.name ?? 'CodexPrecondition',
          detail,
          remedy: blocker?.remedy ?? 'Resolve the reported precondition and start a new attempt.',
        },
      ],
    );
  }

  if (category === 'MalformedOutput') {
    return {
      code: 'Unavailable',
      reason: `Codex produced output this adapter cannot read (${exit}): ${detail} The failure is deterministic, so it is not retried (F18-AC5).`,
    };
  }

  if (category === 'SandboxDenial') {
    return invalid(`Codex refused the command under its sandbox policy (${exit}): ${detail}`, [
      {
        path: 'workspace',
        message: 'The engine sandbox denied a command inside the attempt workspace. Widen the instruction or the granted capabilities rather than the sandbox.',
      },
    ]);
  }

  return {
    code: 'Unavailable',
    reason: `Codex did not complete the turn (${exit}): ${detail} The failure was not retried inside the adapter.`,
  };
}

/**
 * Maps the failure of the `codex --version` probe itself.
 *
 * This is separate from `mapCodexFailure` because the two answer different questions. A turn
 * failure asks what the engine refused to do; a version probe failure asks whether there is a
 * usable engine at all, which is the `UnsupportedRuntime` blocker and the reason
 * `Engine:VersionCheck` exists.
 */
export function mapCodexVersionProbeFailure(
  detail: string,
  exitCode: number | null,
  redact: (text: string) => string,
): DomainError {
  const blocker = BLOCKERS['UnsupportedRuntime'];
  const excerpt = redact(detail);
  return blocked(`Codex could not report a version (${exitCode === null ? 'signalled' : `exit ${exitCode}`}): ${excerpt}`, [
    {
      name: blocker?.name ?? 'CodexRuntime',
      detail: excerpt,
      remedy:
        blocker?.remedy ??
        'Install a Codex build this host can execute, then re-run the compatibility check. No coding session starts against an unverified engine (F04-AC2).',
    },
  ]);
}
