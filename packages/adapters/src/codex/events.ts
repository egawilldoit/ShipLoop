/**
 * Codex JSONL to the contract's closed `EngineEvent` union (F15-AC1, F15-AC2, F15-AC3, F18-AC4, F18-AC5).
 *
 * Every event shape below was **observed live** on `codex-cli 0.159.1` on this host
 * (linux/arm64, Node 24.18.0) on 1 October 2026 by running `codex exec --json` and by running
 * `codex exec resume --json` against the same thread. The captured lines were:
 *
 * ```
 * {"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}
 * {"type":"turn.started"}
 * {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll create `probe.txt` ..."}}
 * {"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc 'printf HELLO > probe.txt'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
 * {"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"...","aggregated_output":"5\nHELLO","exit_code":0,"status":"completed"}}
 * {"type":"turn.completed","usage":{"input_tokens":29370,"cached_input_tokens":14080,"cache_write_input_tokens":0,"output_tokens":244,"reasoning_output_tokens":124}}
 * ```
 *
 * and, for the two failure paths, `{"type":"error","message":"..."}` followed by
 * `{"type":"turn.failed","error":{"message":"..."}}`, plus
 * `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"..."}}`.
 * The binary's own `ThreadEvent` serde names corroborate the set: `thread.started`,
 * `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`,
 * `item.completed` and `error`.
 *
 * Two rules make this a translation rather than a pass-through.
 *
 * **Malformed never becomes success.** A stream containing a line this module cannot read
 * produces a `MalformedOutput` diagnostic and **no** `Result` event at all, even when the
 * stream literally carried a `turn.completed` first. That is F15-AC2, and it holds because
 * every terminal decision is deferred to `finalizeCodexStream`, which reads the malformed list
 * before it reads the terminal signal. A well-formed line whose `type` this module does not
 * model is *not* malformed: a Codex release that adds an event type must not fail every run,
 * and an unmodelled event cannot contribute a terminal outcome, so ignoring it cannot
 * manufacture success either.
 *
 * **Usage is passed through or it is `Unknown`.** Codex reports four token counts and nothing
 * about money or a quota window. The contract has no field for the cached or reasoning splits,
 * so they are not folded into `outputTokens` — that would be inventing a number. Absent usage
 * is an explicit `Unknown` with a reason, never a zero (F18-AC4).
 */

import type { ProviderId } from '@shiploop/domain';

import type {
  EngineDiagnosticCategory,
  EngineEvent,
  EngineOutcome,
  EngineReportedUsage,
  EngineStage,
  EngineUsage,
} from '../contracts/index.ts';
import { classifyCodexFailure, codexBlockedOutcome, codexDiagnosticRetry, isCodexBlocker } from './errors.ts';

/** Upper bound on any engine text that becomes an event summary. */
const MAX_SUMMARY_CHARS = 400;

/** Upper bound on retained malformed-line text, so a diagnostic cannot carry a whole stream. */
const MAX_MALFORMED_CHARS = 200;

/**
 * A Codex thread id is an opaque provider identity.
 *
 * The brand exists so a provider id cannot be swapped for a commit SHA or a local id by
 * accident (mvp-spec 7 "Provider contracts"). Codex's own shape is a UUID — the capture above
 * reads `01a0f699-7149-7d20-831e-98f7b7b43a71` — so the value is already an opaque identity
 * and needs no derivation.
 */
function providerIdOf(value: string): ProviderId {
  return value as ProviderId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)} [truncated]`;
}

/** The event `type` values this adapter models. Anything else is well-formed but unmodelled. */
export const CODEX_MODELLED_EVENT_TYPES: readonly string[] = [
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
];

/**
 * Codex item type to the contract's stage vocabulary.
 *
 * Codex reports **no** stage of its own, so this table is the adapter's translation, and every
 * event carries the engine's own text as its summary so a reader can see the raw fact beside
 * the translation. `reasoning` is deliberately absent: it is the engine's private scratch text
 * and promoting it to owner-visible progress would put model reasoning into product state. A
 * type missing from this table yields no progress event at all rather than a guessed stage.
 *
 * `agent_message` maps to `Implementing`, not to a summary stage, because Codex emits it for
 * forward-looking narration too — the captured run opened with "I'll create `probe.txt` with the
 * exact contents requested" before any command ran. Calling that a summary would be wrong; the
 * last completed `agent_message` is what becomes the success summary instead, and that decision
 * is made at finalize time when the position in the stream is actually known.
 */
const STAGE_BY_ITEM_TYPE: Readonly<Record<string, EngineStage>> = {
  agent_message: 'Implementing',
  command_execution: 'Implementing',
  file_change: 'Implementing',
  mcp_tool_call: 'Implementing',
  web_search: 'ReadingInstructions',
  todo_list: 'Planning',
};

/** One line the parser could not read, located so F18-AC1 can point at the evidence. */
export interface CodexMalformedLine {
  /** Zero-based position of the line in the JSONL stream, as the diagnostic reports it. */
  readonly index: number;
  readonly excerpt: string;
}

/** Usage exactly as Codex stated it, with nothing derived. */
export interface CodexTokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number | null;
}

/** The terminal signal Codex emitted, or the absence of one. */
export type CodexTerminal =
  | { readonly kind: 'TurnCompleted' }
  | { readonly kind: 'TurnFailed'; readonly detail: string };

/** Everything the stream translation accumulates before it can decide a terminal outcome. */
export interface CodexStreamState {
  readonly sessionId: ProviderId | null;
  readonly usage: CodexTokenUsage | null;
  readonly terminal: CodexTerminal | null;
  readonly malformed: readonly CodexMalformedLine[];
  readonly unmodelledTypes: readonly string[];
  /** Last completed `agent_message` text, used verbatim as the success summary. */
  readonly lastAgentMessage: string | null;
}

export interface CodexTranslationOptions {
  readonly engineVersion: string;
  readonly mode: 'Headless' | 'Interactive';
  /**
   * Carried onto the `SessionStarted` event so a restart can never be read as a resume
   * (`EngineSessionStart.kind`, not the whole start, because the event names the kind).
   */
  readonly startedFrom: 'Fresh' | 'FromCheckpoint';
  /** Injected clock; the parser must not read the ambient wall clock. */
  readonly now: () => string;
  readonly redact: (text: string) => string;
}

/** What `translateCodexLine` returns for one input line. */
export type CodexLineTranslation =
  | { readonly kind: 'Events'; readonly events: readonly EngineEvent[]; readonly state: CodexStreamState }
  | { readonly kind: 'Malformed'; readonly state: CodexStreamState };

export function initialCodexStreamState(): CodexStreamState {
  return {
    sessionId: null,
    usage: null,
    terminal: null,
    malformed: [],
    unmodelledTypes: [],
    lastAgentMessage: null,
  };
}

/**
 * Reads the token block of a `turn.completed` event.
 *
 * Returns null unless the two fields the contract has room for are finite non-negative
 * integers, because a partially readable usage block is still a number this adapter would be
 * guessing at.
 */
export function readCodexUsage(value: unknown): CodexTokenUsage | null {
  if (!isRecord(value)) return null;
  const input = value['input_tokens'];
  const output = value['output_tokens'];
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0) return null;
  if (typeof output !== 'number' || !Number.isInteger(output) || output < 0) return null;
  return {
    inputTokens: input,
    cachedInputTokens: optionalCount(value['cached_input_tokens']),
    cacheWriteInputTokens: optionalCount(value['cache_write_input_tokens']),
    outputTokens: output,
    reasoningOutputTokens: optionalCount(value['reasoning_output_tokens']),
  };
}

function optionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Builds the contract's `EngineUsage` from what Codex stated, and nothing else.
 *
 * `windowStart`, `windowEnd`, `billedAmount` and `currency` stay null because Codex reports no
 * quota window and no money. Deriving a cost from a token count would invent a figure the
 * owner would then budget against (F18-AC4).
 */
export function codexUsageOf(reported: CodexTokenUsage): EngineUsage {
  return {
    availability: 'Reported',
    windowStart: null,
    windowEnd: null,
    inputTokens: reported.inputTokens,
    outputTokens: reported.outputTokens,
    billedAmount: null,
    currency: null,
    unknownReason: null,
  };
}

function recordMalformed(
  state: CodexStreamState,
  options: CodexTranslationOptions,
  line: string,
  lineIndex: number,
): CodexStreamState {
  return {
    ...state,
    malformed: [...state.malformed, { index: lineIndex, excerpt: truncate(options.redact(line), MAX_MALFORMED_CHARS) }],
  };
}

function emit(events: readonly EngineEvent[], state: CodexStreamState): CodexLineTranslation {
  return { kind: 'Events', events, state };
}

function diagnostic(category: EngineDiagnosticCategory, detail: string): EngineEvent {
  return {
    kind: 'Diagnostic',
    at: '',
    category,
    detail,
    retry: codexDiagnosticRetry(category),
    evidence: null,
  };
}

/**
 * Translates one JSONL line into contract events.
 *
 * A blank line is skipped rather than counted. Codex's stream legitimately ends with a newline,
 * and treating the empty remainder as malformed would fail every successful run — which is the
 * failure mode F15-AC2 must not become.
 */
export function translateCodexLine(
  line: string,
  state: CodexStreamState,
  options: CodexTranslationOptions,
  lineIndex: number,
): CodexLineTranslation {
  const trimmed = line.trim();
  if (trimmed.length === 0) return emit([], state);

  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return { kind: 'Malformed', state: recordMalformed(state, options, trimmed, lineIndex) };
  }
  if (!isRecord(decoded)) return { kind: 'Malformed', state: recordMalformed(state, options, trimmed, lineIndex) };
  const type = str(decoded['type']);
  if (type === null) return { kind: 'Malformed', state: recordMalformed(state, options, trimmed, lineIndex) };

  if (!CODEX_MODELLED_EVENT_TYPES.includes(type)) {
    const unmodelledTypes = state.unmodelledTypes.includes(type) ? state.unmodelledTypes : [...state.unmodelledTypes, type];
    return emit([], { ...state, unmodelledTypes });
  }

  switch (type) {
    case 'thread.started':
      return translateThreadStarted(decoded, state, options, lineIndex);
    case 'turn.started':
      return emit(
        [
          {
            kind: 'Progress',
            at: options.now(),
            stage: 'Preparing',
            milestoneKey: 'codex:turn-started',
            summary: 'Codex started a turn.',
            detail: null,
          },
        ],
        state,
      );
    case 'item.started':
      return translateItem(decoded, state, options, 'started', lineIndex);
    case 'item.updated':
      return emit([], state);
    case 'item.completed':
      return translateItem(decoded, state, options, 'completed', lineIndex);
    case 'turn.completed':
      return emit([], {
        ...state,
        usage: readCodexUsage(decoded['usage']) ?? state.usage,
        terminal: { kind: 'TurnCompleted' },
      });
    case 'turn.failed':
      return translateTurnFailed(decoded, state, options);
    case 'error':
      return translateErrorEvent(decoded, state, options);
    default:
      return emit([], state);
  }
}

function translateThreadStarted(
  decoded: Record<string, unknown>,
  state: CodexStreamState,
  options: CodexTranslationOptions,
  lineIndex: number,
): CodexLineTranslation {
  const threadId = str(decoded['thread_id']);
  if (threadId === null) {
    return { kind: 'Malformed', state: recordMalformed(state, options, JSON.stringify(decoded), lineIndex) };
  }
  const sessionId = providerIdOf(threadId);
  return emit(
    [
      {
        kind: 'SessionStarted',
        at: options.now(),
        sessionId,
        engineVersion: options.engineVersion,
        mode: options.mode,
        startedFrom: options.startedFrom,
      },
    ],
    { ...state, sessionId },
  );
}

function translateItem(
  decoded: Record<string, unknown>,
  state: CodexStreamState,
  options: CodexTranslationOptions,
  phase: 'started' | 'completed',
  lineIndex: number,
): CodexLineTranslation {
  const item = decoded['item'];
  if (!isRecord(item)) {
    return { kind: 'Malformed', state: recordMalformed(state, options, JSON.stringify(decoded), lineIndex) };
  }
  const itemId = str(item['id']);
  const itemType = str(item['type']);
  if (itemId === null || itemType === null) {
    return { kind: 'Malformed', state: recordMalformed(state, options, JSON.stringify(decoded), lineIndex) };
  }

  if (itemType === 'error') {
    const detail = options.redact(str(item['message']) ?? `Codex reported an error item ${itemId}.`);
    return emit([{ ...diagnostic(classifyCodexFailure(detail), detail), at: options.now() }], state);
  }

  const stage = STAGE_BY_ITEM_TYPE[itemType];
  if (stage === undefined) return emit([], state);

  if (phase === 'started') {
    const summary = options.redact(
      truncate(str(item['command']) ?? `Codex started a ${itemType}.`, MAX_SUMMARY_CHARS),
    );
    return emit(
      [
        {
          kind: 'Progress',
          at: options.now(),
          stage,
          milestoneKey: `codex:${itemType}:${itemId}`,
          summary,
          detail: null,
        },
      ],
      state,
    );
  }

  const exitCode = item['exit_code'];
  if (typeof exitCode === 'number' && exitCode !== 0) {
    const output = str(item['aggregated_output']);
    const detail = options.redact(
      truncate(
        output ?? `Codex item ${itemId} exited with code ${String(exitCode)} without output.`,
        MAX_SUMMARY_CHARS,
      ),
    );
    return emit([{ ...diagnostic('ToolError', detail), at: options.now() }], state);
  }

  const lastAgentMessage =
    itemType === 'agent_message' ? (str(item['text']) ?? state.lastAgentMessage) : state.lastAgentMessage;
  const summary = options.redact(truncate(itemSummary(itemType, item, itemId), MAX_SUMMARY_CHARS));
  return emit(
    [
      {
        kind: 'Progress',
        at: options.now(),
        stage,
        milestoneKey: `codex:${itemType}:${itemId}`,
        summary,
        detail: null,
      },
    ],
    { ...state, lastAgentMessage },
  );
}

function itemSummary(itemType: string, item: Record<string, unknown>, itemId: string): string {
  if (itemType === 'command_execution') {
    const command = str(item['command']);
    const output = str(item['aggregated_output']);
    const head = command ?? `Codex item ${itemId}`;
    return output === null ? `${head} (exit ${String(item['exit_code'])})` : `${head}\n${output}`;
  }
  if (itemType === 'file_change') {
    const changes = item['changes'];
    if (Array.isArray(changes)) {
      const paths = changes
        .map((entry) => (isRecord(entry) ? str(entry['path']) : null))
        .filter((path): path is string => path !== null);
      if (paths.length > 0) return `Codex changed: ${paths.join(', ')}`;
    }
    return `Codex completed a file change (${itemId}).`;
  }
  return `Codex completed a ${itemType} (${itemId}).`;
}

function translateTurnFailed(
  decoded: Record<string, unknown>,
  state: CodexStreamState,
  options: CodexTranslationOptions,
): CodexLineTranslation {
  const error = decoded['error'];
  const raw = isRecord(error) ? str(error['message']) : null;
  const detail = options.redact(raw ?? 'Codex reported a failed turn without a message.');
  return emit([], { ...state, terminal: { kind: 'TurnFailed', detail } });
}

function translateErrorEvent(
  decoded: Record<string, unknown>,
  state: CodexStreamState,
  options: CodexTranslationOptions,
): CodexLineTranslation {
  const message = str(decoded['message']);
  const detail = options.redact(message ?? 'Codex reported an error event without a message.');
  return emit([{ ...diagnostic(classifyCodexFailure(detail), detail), at: options.now() }], state);
}

/* -------------------------------------------------------------------------- */
/* Terminal decision                                                           */
/* -------------------------------------------------------------------------- */

/** Why ShipLoop ended the stream, when the engine did not end it itself. */
export type CodexStreamInterruption = 'Stopped' | 'BudgetExhausted';

export interface CodexFinalizeInput {
  readonly state: CodexStreamState;
  readonly options: CodexTranslationOptions;
  /** Session start instant, quoted verbatim in the `Unknown` usage reason. */
  readonly startedAt: string;
  readonly interruption: CodexStreamInterruption | null;
  readonly exitCode: number | null;
}

/**
 * Decides the end of the stream and emits the terminal events.
 *
 * The order of the checks *is* the F15-AC2 guarantee, so it is one ordered chain rather than
 * independent guards:
 *
 * 1. A malformed line exists → `MalformedOutput`, terminal retry, and **no** `Result` event,
 *    whatever the stream claimed. This is first so a truncated tail cannot overwrite a real
 *    failure and a real success cannot hide behind a parse failure.
 * 2. ShipLoop interrupted the stream → `Incomplete`, and no completion.
 * 3. Codex emitted no terminal event → `Incomplete` with `OutputTruncated`. An engine that
 *    stops talking is not a success, which is the other half of F15-AC2.
 * 4. `turn.failed` → `Blocked` for the four blocker categories, `Failed` otherwise (F15-AC3).
 * 5. `turn.completed` → `Succeeded`, with the engine's own last message as the summary.
 *
 * Exactly one `Usage` event is emitted, always. F18-AC4 asks for `Unknown` when usage is
 * absent, and a stream that sometimes omits the record entirely makes "absent" and "not
 * reported" indistinguishable to anything reading the log.
 */
export function finalizeCodexStream(input: CodexFinalizeInput): readonly EngineEvent[] {
  const { state, options } = input;
  const at = options.now();
  const events: EngineEvent[] = [];

  if (state.malformed.length > 0) {
    const first = state.malformed[0];
    events.push({
      kind: 'Diagnostic',
      at,
      category: 'MalformedOutput',
      detail: `Codex output could not be parsed at line ${String(first?.index ?? 0)}: ${first?.excerpt ?? ''}`,
      retry: 'Terminal',
      evidence: null,
    });
    events.push(usageEvent(state, options, input.startedAt));
    return events;
  }

  if (input.interruption !== null) {
    events.push({
      kind: 'Result',
      at,
      outcome: {
        kind: 'Incomplete',
        reason: input.interruption,
        summary:
          input.interruption === 'Stopped'
            ? 'ShipLoop stopped the Codex session before the engine reported a turn outcome.'
            : 'The attempt reached a configured bound before Codex reported a turn outcome.',
      },
    });
    events.push(usageEvent(state, options, input.startedAt));
    return events;
  }

  if (state.terminal === null) {
    events.push({
      kind: 'Diagnostic',
      at,
      category: 'MalformedOutput',
      detail: `Codex produced no turn outcome, so the run cannot be called successful. The stream ended with no turn.completed and no turn.failed (process exit ${String(input.exitCode)}).`,
      retry: 'Terminal',
      evidence: null,
    });
    events.push(usageEvent(state, options, input.startedAt));
    return events;
  }

  events.push(usageEvent(state, options, input.startedAt));

  if (state.terminal.kind === 'TurnFailed') {
    const detail = state.terminal.detail;
    const category = classifyCodexFailure(detail);
    events.push({ ...diagnostic(category, detail), at });
    const outcome: EngineOutcome = isCodexBlocker(category)
      ? codexBlockedOutcome(category, detail, options.redact)
      : {
          kind: 'Failed',
          category,
          summary: detail,
          remedy: 'Read the recorded diagnostic, address it, then start a new attempt. The workspace is unchanged.',
        };
    events.push({ kind: 'Result', at, outcome });
    return events;
  }

  events.push({
    kind: 'Result',
    at,
    outcome: {
      kind: 'Succeeded',
      summary: options.redact(
        truncate(state.lastAgentMessage ?? 'Codex reported a completed turn with no final message.', MAX_SUMMARY_CHARS),
      ),
    },
  });
  return events;
}

/**
 * The single usage record for the session.
 *
 * A stream that contained a malformed line yields `Unknown`, because such a stream cannot be
 * shown to carry a complete usage record and a partial count presented as the total is exactly
 * the invention F18-AC4 forbids.
 */
function usageEvent(state: CodexStreamState, options: CodexTranslationOptions, startedAt: string): EngineEvent {
  const at = options.now();
  if (state.malformed.length > 0) {
    const usage: EngineReportedUsage = {
      kind: 'Unknown',
      reason: 'The Codex stream contained a line that could not be parsed, so its usage record cannot be trusted as complete.',
    };
    return { kind: 'Usage', at, usage };
  }
  if (state.usage === null) {
    const usage: EngineReportedUsage = {
      kind: 'Unknown',
      reason: `Codex reported no token usage for this session, which started at ${startedAt}. ShipLoop does not estimate tokens, remaining quota or cost (F18-AC4).`,
    };
    return { kind: 'Usage', at, usage };
  }
  const usage: EngineReportedUsage = { kind: 'Reported', usage: codexUsageOf(state.usage) };
  return { kind: 'Usage', at, usage };
}

/** Translates a whole captured stream, which is what the tests and the live proof exercise. */
export function translateCodexStream(
  lines: readonly string[],
  options: CodexTranslationOptions,
  finalize: (state: CodexStreamState) => readonly EngineEvent[],
): readonly EngineEvent[] {
  let state = initialCodexStreamState();
  const events: EngineEvent[] = [];
  for (const [index, line] of lines.entries()) {
    const outcome = translateCodexLine(line, state, options, index);
    state = outcome.state;
    if (outcome.kind === 'Events') events.push(...outcome.events);
  }
  return [...events, ...finalize(state)];
}
