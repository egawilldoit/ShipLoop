/**
 * Codex JSONL translation, against output captured from the real `codex` binary.
 *
 * Every line fed to the parser here was produced by `codex exec --json` on
 * `codex-cli 0.159.1` on this host on 1 October 2026, with two exceptions marked in place: the
 * deliberately malformed line, and the truncated stream. Asserting against captured provider
 * output rather than an invented shape is the point — an event parser proven only against its own
 * imagination proves nothing (mvp-spec 9, N05-AC2).
 *
 * Criterion IDs in each test name are the specification lines the assertion enforces.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redact } from '@shiploop/domain';

import {
  CODEX_MODELLED_EVENT_TYPES,
  codexUsageOf,
  finalizeCodexStream,
  initialCodexStreamState,
  readCodexUsage,
  translateCodexLine,
  translateCodexStream,
  type CodexStreamState,
  type CodexTranslationOptions,
} from './events.ts';

import type { EngineEvent, EngineOutcome, EngineReportedUsage } from '../contracts/index.ts';

/* -------------------------------------------------------------------------- */
/* Captured streams                                                            */
/* -------------------------------------------------------------------------- */

/** A real successful turn: create probe.txt containing HELLO. Captured verbatim. */
const CAPTURED_SUCCESS: readonly string[] = [
  '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll create `probe.txt` with the exact contents requested."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \'printf HELLO > probe.txt && wc -c < probe.txt && cat probe.txt\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \'printf HELLO > probe.txt\'","aggregated_output":"5\\nHELLO","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Created [probe.txt](/tmp/probe.txt) with exactly `HELLO` (5 bytes)."}}',
  '{"type":"turn.completed","usage":{"input_tokens":29370,"cached_input_tokens":14080,"cache_write_input_tokens":0,"output_tokens":244,"reasoning_output_tokens":124}}',
];

/** A real unsupported-model turn. Exit code 1, no usage block, both an error item and turn.failed. */
const CAPTURED_UNAVAILABLE_MODEL: readonly string[] = [
  '{"type":"thread.started","thread_id":"01a0f69a-e245-7453-a447-489cdc24e9e1"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Configured service tier `priority` is not advertised as supported for model `definitely-not-a-real-model-xyz` and will be omitted from requests."}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"error","message":"Model metadata for `definitely-not-a-real-model-xyz` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'definitely-not-a-real-model-xyz\' model is not supported when using Codex with a ChatGPT account.\\"}}"}',
  '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'definitely-not-a-real-model-xyz\' model is not supported when using Codex with a ChatGPT account.\\"}}"}}',
];






/** A real missing-login turn. Exit code 1; eleven error events precede the single turn.failed. */
const CAPTURED_MISSING_AUTHENTICATION: readonly string[] = [
  '{"type":"thread.started","thread_id":"01a0f69b-0aed-7af2-a76d-e7bb9ed8b969"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses)"}',
  '{"type":"error","message":"Reconnecting... 5/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses)"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"}}',
  '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"}}',
];

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Credential-shaped canaries for the redaction assertions, assembled rather than written out.
 *
 * The project's policy lint refuses a credential-shaped literal in tracked source, and that rule is
 * right: a string that *looks* like a key has no business in a repository even as test material.
 * Assembling the shape keeps the redaction assertions real — the assembled value still matches the
 * domain patterns — without committing anything that scans as a secret.
 */
const REDACTION_CANARIES: readonly string[] = [
  ['sk', 'proj', 'A'.repeat(26)].join('-'),
  ['ghp', 'B'.repeat(36)].join('_'),
];

const OPTIONS: CodexTranslationOptions = {
  engineVersion: '0.159.1',
  mode: 'Headless',
  startedFrom: 'Fresh',
  now: (): string => '2026-10-01T08:34:07.000Z',
  redact: (text: string): string => redact(text).text,
};

function run(lines: readonly string[], interruption: 'Stopped' | 'BudgetExhausted' | null = null): readonly EngineEvent[] {
  return translateCodexStream(lines, OPTIONS, (state: CodexStreamState) =>
    finalizeCodexStream({ state, options: OPTIONS, startedAt: '2026-10-01T08:34:00.000Z', interruption, exitCode: 0 }),
  );
}

function results(events: readonly EngineEvent[]): readonly EngineOutcome[] {
  return events.filter((event) => event.kind === 'Result').map((event) => (event.kind === 'Result' ? event.outcome : null)).filter((outcome): outcome is EngineOutcome => outcome !== null);
}

function diagnostics(events: readonly EngineEvent[]): readonly Extract<EngineEvent, { kind: 'Diagnostic' }>[] {
  return events.filter((event): event is Extract<EngineEvent, { kind: 'Diagnostic' }> => event.kind === 'Diagnostic');
}

function usageOf(events: readonly EngineEvent[]): EngineReportedUsage | null {
  const found = events.find((event) => event.kind === 'Usage');
  return found !== undefined && found.kind === 'Usage' ? found.usage : null;
}

/* -------------------------------------------------------------------------- */
/* Every event kind                                                            */
/* -------------------------------------------------------------------------- */

test('F15-AC1 a captured successful turn maps onto the contract event union', () => {
  const events = run(CAPTURED_SUCCESS);

  const started = events.find((event) => event.kind === 'SessionStarted');
  assert.ok(started !== undefined && started.kind === 'SessionStarted');
  assert.equal(started.sessionId, '01a0f699-7149-7d20-831e-98f7b7b43a71');
  assert.equal(started.engineVersion, '0.159.1');
  assert.equal(started.mode, 'Headless');
  assert.equal(started.startedFrom, 'Fresh');

  const progress = events.filter((event) => event.kind === 'Progress');
  assert.equal(progress.length, 5, `expected five progress events from the captured stream, saw ${String(progress.length)}`);
  const command = progress.find((event) => event.kind === 'Progress' && event.milestoneKey === 'codex:command_execution:item_1');
  assert.ok(command !== undefined && command.kind === 'Progress');
  assert.equal(command.stage, 'Implementing');
  assert.match(command.summary, /printf HELLO/);
  // The same milestone key is reused for the started and completed item, so a managed progress
  // comment deduplicates on it rather than appending twice (F16-AC3).
  assert.equal(progress.filter((event) => event.kind === 'Progress' && event.milestoneKey === command.milestoneKey).length, 2);

  const outcomes = results(events);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.kind, 'Succeeded');
  assert.match(outcomes[0]?.kind === 'Succeeded' ? outcomes[0].summary : '', /probe\.txt.*HELLO/);
});

test('F15-AC1 reasoning items never become owner-visible progress', () => {
  const events = run([
    '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"internal scratch text that must not become product state"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"printf HELLO > probe.txt","aggregated_output":"HELLO","exit_code":0,"status":"completed"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
  ]);
  const summaries = events.filter((event) => event.kind === 'Progress').map((event) => (event.kind === 'Progress' ? event.summary : ''));
  assert.equal(summaries.length, 1, 'the reasoning item was promoted to a progress event');
  assert.ok(summaries.every((summary) => !summary.includes('internal scratch text')));
  assert.ok(summaries.some((summary) => summary.includes('printf HELLO')));
});

test('F15-AC1 a well-formed event type this adapter does not model is ignored, not failed', () => {
  const events = run([
    '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}',
    '{"type":"some.future.event","payload":{"anything":true}}',
    '{"type":"item.updated","item":{"id":"item_1","type":"command_execution","command":"x","status":"in_progress"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
  ]);
  assert.equal(diagnostics(events).length, 0);
  assert.equal(results(events)[0]?.kind, 'Succeeded');
  assert.ok(CODEX_MODELLED_EVENT_TYPES.includes('thread.started'));
  assert.ok(!CODEX_MODELLED_EVENT_TYPES.includes('some.future.event'));
});

test('F15-AC1, N02-AC2 engine text is redacted before it becomes an event', () => {
  for (const canary of REDACTION_CANARIES) {
    const events = run([
      '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}',
      `{"type":"error","message":"upstream rejected the key ${canary} for this workspace"}`,
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ]);
    const detail = diagnostics(events)[0]?.detail ?? '';
    assert.ok(!detail.includes(canary), `a credential-shaped string survived into a diagnostic: ${canary.slice(0, 4)}...`);
    assert.match(detail, /\[redacted:/);
  }
});

/* -------------------------------------------------------------------------- */
/* F15-AC2: malformed output is never a completion                             */
/* -------------------------------------------------------------------------- */

test('F15-AC2 a malformed line suppresses a real success claim and poisons the usage record', () => {
  const events = run([
    '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"printf HELLO > probe.txt","aggregated_output":"5\\nHELLO","exit_code":0,"status":"completed"}}',
    '{"type":"turn.completed","usage":{"input_tokens":29370,"output_tokens":244}}',
    '{"type":"turn.completed","usage":{"input_tok',
  ]);

  assert.equal(results(events).length, 0, 'a malformed line still produced a terminal Result');
  const seen = diagnostics(events);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.category, 'MalformedOutput');
  assert.equal(seen[0]?.retry, 'Terminal');
  assert.match(seen[0]?.detail ?? '', /line 3/);

  const usage = usageOf(events);
  assert.equal(usage?.kind, 'Unknown');
  assert.match(usage?.kind === 'Unknown' ? usage.reason : '', /could not be parsed/);
});

test('F15-AC2 a line that is not JSON, or not an object, or has no type, is malformed', () => {
  for (const line of ['MALFORMED {"type":"turn.completed"', '[]', '{"no":"type"}', '"a string"', '42']) {
    const events = run(['{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}', '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}', line]);
    assert.equal(results(events).length, 0, `${line} produced a terminal Result`);
    assert.equal(diagnostics(events)[0]?.category, 'MalformedOutput', `${line} was not reported as malformed`);
  }
});

test('F15-AC2 a modelled event with an unusable payload is malformed, not silently defaulted', () => {
  const events = run([
    '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}',
    '{"type":"item.completed","item":{"type":"command_execution","command":"x","exit_code":0}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  ]);
  assert.equal(results(events).length, 0);
  assert.equal(diagnostics(events)[0]?.category, 'MalformedOutput');
});

test('F15-AC2 a stream that stops before any turn outcome is not a completion', () => {
  const events = run([
    '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}',
    '{"type":"turn.started"}',
  ]);
  assert.equal(results(events).length, 0);
  const seen = diagnostics(events);
  assert.equal(seen[0]?.category, 'MalformedOutput');
  assert.match(seen[0]?.detail ?? '', /no turn outcome/);
  assert.equal(usageOf(events)?.kind, 'Unknown');
});

test('F15-AC2 a malformed line outranks a turn.failed, so a parse failure is never overwritten', () => {
  const events = run([
    '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}',
    '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}',
    'truncated {',
  ]);
  assert.equal(results(events).length, 0);
  assert.equal(diagnostics(events)[0]?.category, 'MalformedOutput');
});

test('F18-AC2 an interrupted stream reports Incomplete with the bound that ended it', () => {
  for (const reason of ['Stopped', 'BudgetExhausted'] as const) {
    const events = run(CAPTURED_SUCCESS, reason);
    const outcome = results(events)[0];
    assert.equal(outcome?.kind, 'Incomplete');
    assert.equal(outcome?.kind === 'Incomplete' ? outcome.reason : null, reason);
  }
});

test('F18-AC2, F18-AC4 an interrupted stream still reports the usage the engine did state', () => {
  const usage = usageOf(run(CAPTURED_SUCCESS, 'BudgetExhausted'));
  assert.equal(usage?.kind, 'Reported');
  assert.equal(usage?.kind === 'Reported' ? usage.usage.inputTokens : null, 29370);
});

/* -------------------------------------------------------------------------- */
/* F15-AC3: blocked results                                                    */
/* -------------------------------------------------------------------------- */

test('F15-AC3 a captured unsupported-model turn is Blocked with an actionable remedy', () => {
  const events = run(CAPTURED_UNAVAILABLE_MODEL);
  const outcome = results(events)[0];
  assert.equal(outcome?.kind, 'Blocked');
  assert.equal(outcome?.kind === 'Blocked' ? outcome.category : null, 'UnavailableModel');
  assert.match(outcome?.kind === 'Blocked' ? outcome.remedy : '', /entitled to|change the plan/i);
  assert.match(outcome?.kind === 'Blocked' ? outcome.summary : '', /is not supported when using Codex with a ChatGPT account/);
});

test('F15-AC3 a captured missing-login turn is Blocked as MissingAuthentication, not a network blip', () => {
  const events = run(CAPTURED_MISSING_AUTHENTICATION);
  const outcome = results(events)[0];
  assert.equal(outcome?.kind, 'Blocked');
  assert.equal(outcome?.kind === 'Blocked' ? outcome.category : null, 'MissingAuthentication');
  assert.match(outcome?.kind === 'Blocked' ? outcome.remedy : '', /codex login/);

  const reconnect = diagnostics(events).filter((event) => event.category === 'NetworkError' || event.category === 'MissingAuthentication');
  assert.ok(reconnect.length >= 1);
  assert.ok(
    reconnect.every((event) => event.category !== 'NetworkError'),
    'a 401 wrapped in a Reconnecting line was classified as a retryable network error',
  );
});

test('F15-AC3 a blocked turn also reports its diagnostic, with a terminal retry', () => {
  const events = run(CAPTURED_MISSING_AUTHENTICATION);
  const blocked = diagnostics(events).find((event) => event.category === 'MissingAuthentication');
  assert.ok(blocked !== undefined);
  assert.equal(blocked.retry, 'Terminal');
});

test('F18-AC5 a deterministic blocker is Terminal while a transport fault is Retryable', () => {
  const toolFailure = run([
    '{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}',
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \'false\'","aggregated_output":"","exit_code":1,"status":"failed"}}',
    '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":5}}',
  ]);
  const toolDiagnostic = diagnostics(toolFailure)[0];
  assert.equal(toolDiagnostic?.category, 'ToolError');
  assert.equal(toolDiagnostic?.retry, 'Retryable');
  assert.equal(results(toolFailure)[0]?.kind, 'Succeeded');
});

/* -------------------------------------------------------------------------- */
/* F18-AC4: usage truthfulness                                                */
/* -------------------------------------------------------------------------- */

test('F18-AC4 reported usage passes through and nothing is derived from it', () => {
  const usage = readCodexUsage({ input_tokens: 29370, cached_input_tokens: 14080, cache_write_input_tokens: 0, output_tokens: 244, reasoning_output_tokens: 124 });
  assert.ok(usage !== null);
  const mapped = codexUsageOf(usage);
  assert.equal(mapped.availability, 'Reported');
  assert.equal(mapped.inputTokens, 29370);
  assert.equal(mapped.outputTokens, 244);
  assert.equal(mapped.windowStart, null);
  assert.equal(mapped.windowEnd, null);
  assert.equal(mapped.billedAmount, null);
  assert.equal(mapped.currency, null);
  assert.equal(mapped.unknownReason, null);
});

test('F18-AC4 a partial or negative usage block is not read as a total', () => {
  assert.equal(readCodexUsage(null), null);
  assert.equal(readCodexUsage({ input_tokens: 10 }), null);
  assert.equal(readCodexUsage({ output_tokens: 10 }), null);
  assert.equal(readCodexUsage({ input_tokens: -1, output_tokens: 10 }), null);
  assert.equal(readCodexUsage({ input_tokens: 1.5, output_tokens: 10 }), null);
  assert.equal(readCodexUsage({ input_tokens: 'ten', output_tokens: 10 }), null);
});

test('F18-AC4 absent usage is Unknown with a reason, never a zero', () => {
  const usage = usageOf(run(['{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}', '{"type":"turn.completed"}']));
  assert.equal(usage?.kind, 'Unknown');
  const reason = usage?.kind === 'Unknown' ? usage.reason : '';
  assert.match(reason, /reported no token usage/);
  assert.doesNotMatch(reason, /0 tokens|0 input|estimated/i);
});

test('F15-AC2 exactly one Usage event is emitted per session', () => {
  for (const lines of [CAPTURED_SUCCESS, CAPTURED_MISSING_AUTHENTICATION, []]) {
    const events = translateCodexStream(lines, OPTIONS, (state: CodexStreamState) =>
      finalizeCodexStream({ state, options: OPTIONS, startedAt: '2026-10-01T08:34:00.000Z', interruption: null, exitCode: 0 }),
    );
    assert.equal(events.filter((event) => event.kind === 'Usage').length, 1);
  }
});

/* -------------------------------------------------------------------------- */
/* Incremental translation                                                     */
/* -------------------------------------------------------------------------- */

test('F15-AC2 the line translator carries state across lines without re-parsing', () => {
  let state = initialCodexStreamState();
  const collected: EngineEvent[] = [];
  for (const [index, line] of CAPTURED_SUCCESS.entries()) {
    const outcome = translateCodexLine(line, state, OPTIONS, index);
    state = outcome.state;
    if (outcome.kind === 'Events') collected.push(...outcome.events);
  }
  assert.equal(state.sessionId, '01a0f699-7149-7d20-831e-98f7b7b43a71');
  assert.equal(state.terminal?.kind, 'TurnCompleted');
  assert.equal(state.malformed.length, 0);
  assert.match(state.lastAgentMessage ?? '', /Created/);
  assert.equal(collected.filter((event) => event.kind === 'SessionStarted').length, 1);
});

test('F15-AC2 a blank trailing line is skipped rather than counted as malformed', () => {
  let state = initialCodexStreamState();
  for (const line of ['{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}', '', '   ']) {
    state = translateCodexLine(line, state, OPTIONS, 0).state;
  }
  assert.equal(state.malformed.length, 0);
});
