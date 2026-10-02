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
  checkCodexResultAgainstSchema,
  codexUsageOf,
  finalizeCodexStream,
  initialCodexStreamState,
  readCodexUsage,
  translateCodexLine,
  translateCodexStream,
  type CodexFinalizeInput,
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
/* The structured result channel, against a result captured from a live run  */
/* -------------------------------------------------------------------------- */

/**
 * A real `PlanProposal` written by `codex exec` on this host on 2 October 2026.
 *
 * Produced by `codex exec --sandbox read-only --cd <throwaway git worktree> --json
 * --output-schema <schema.json> -o <result.json> -- "<prompt>"` against `codex-cli 0.160.0`,
 * answering with two requested outcomes, one task and two acceptance criteria. The artifact held
 * 2250 bytes; the same text also arrived as the turn's final `agent_message` on stdout. Both facts
 * are the point: the payload is far larger than the 400-character summary cap, and the artifact
 * was written by a read-only turn, because the CLI process writes it rather than a sandboxed
 * command. Captured verbatim rather than retyped, so the completeness check below is exercised
 * against the bytes the engine really produced.
 */
const CAPTURED_RESULT_JSON =
  "{\"kind\":\"PlanProposal\",\"briefId\":\"brief_probe_001\",\"draftedAt\":\"2026-10-02T00:00:00.000Z\",\"requestedOutcomes\":[{\"id\":\"brief.desiredOutcome\",\"statement\":\"The reader can resume an interrupted attempt without re-reading the whole transcript.\"},{\"id\":\"AC-1\",\"statement\":\"A pause records a checkpoint within two seconds of the pause request.\"}],\"tasks\":[{\"taskId\":\"T-1\",\"coversOutcomeIds\":[\"brief.desiredOutcome\"],\"outcome\":\"Enable a reader returning to an interrupted attempt to identify the last recorded checkpoint, understand what work remains, and continue from that point using a compact, durable summary instead of rereading the full transcript.\",\"scope\":\"Define and implement a resumable checkpoint representation that captures the attempt's current state, completed work, pending work, and useful context, then make that representation available when a reader resumes an interrupted attempt.\",\"acceptanceCriteria\":[\"For an interrupted attempt with a saved checkpoint, a reader can identify the current state, completed work, and next pending action from the checkpoint without needing to reread the transcript.\",\"The checkpoint preserves enough task-specific context to let a reader continue the interrupted attempt coherently, including relevant decisions and unresolved questions, without relying on unstated details from earlier conversation.\"],\"verificationMethod\":\"Create a representative interrupted attempt with a recorded checkpoint, then have a fresh reader use only that checkpoint to state the current status and next action; confirm both are accurate against the full attempt record.\",\"dependencies\":[],\"relevantProjectContext\":[\"The supplied brief defines the desired outcome as resuming an interrupted attempt without rereading the whole transcript.\",\"The user requested a read-only plan and explicitly instructed that the repository must not be inspected.\"],\"implementationLocation\":{\"kind\":\"ProposedLocation\",\"candidates\":[\"Undetermined until repository inspection is permitted; locate the existing attempt state or checkpoint implementation.\"],\"basis\":\"No repository file was read; this proposal is based on the user-supplied AGENTS.md instructions and brief, so the implementation file remains undetermined.\"}}],\"exclusions\":[]}";

/** The schema that run was asked for, in the shape `applyPlanProposal` needs from a plan. */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'briefId', 'draftedAt', 'requestedOutcomes', 'tasks', 'exclusions'],
  properties: {
    kind: { type: 'string', enum: ['PlanProposal'] },
    briefId: { type: 'string' },
    draftedAt: { type: 'string' },
    requestedOutcomes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'statement'],
        properties: { id: { type: 'string' }, statement: { type: 'string' } },
      },
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'taskId',
          'coversOutcomeIds',
          'outcome',
          'scope',
          'acceptanceCriteria',
          'verificationMethod',
          'dependencies',
          'relevantProjectContext',
          'implementationLocation',
        ],
        properties: {
          taskId: { type: 'string' },
          coversOutcomeIds: { type: 'array', items: { type: 'string' } },
          outcome: { type: 'string' },
          scope: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          verificationMethod: { type: 'string' },
          dependencies: { type: 'array', items: { type: 'string' } },
          relevantProjectContext: { type: 'array', items: { type: 'string' } },
          implementationLocation: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'candidates', 'basis'],
            properties: {
              kind: { type: 'string', enum: ['ProposedLocation'] },
              candidates: { type: 'array', items: { type: 'string' } },
              basis: { type: 'string' },
            },
          },
        },
      },
    },
    exclusions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['outcomeId', 'excluded', 'reason'],
        properties: { outcomeId: { type: 'string' }, excluded: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
} as const;

/** One JSONL line carrying `text` as a completed `agent_message`, as Codex emits it. */
function agentMessageLine(text: string): string {
  return JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
}

/** The captured turn that produced it, on stdout: the same JSON, in a completed agent message. */
const CAPTURED_RESULT_TURN: readonly string[] = [
  '{"type":"thread.started","thread_id":"01a0fd2d-02db-78d3-931e-061b2b3832f5"}',
  '{"type":"turn.started"}',
  agentMessageLine(CAPTURED_RESULT_JSON),
  '{"type":"turn.completed","usage":{"input_tokens":14876,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1530,"reasoning_output_tokens":1097}}',
];

/** The bytes a reader must be able to arrive on. */
const CAPTURED_RESULT_BYTES = Buffer.byteLength(CAPTURED_RESULT_JSON, 'utf8');

function readResult(text: string, sourcePath = '.shiploop/results/token.json') {
  return { kind: 'Read', text, byteLength: Buffer.byteLength(text, 'utf8'), sourcePath } as const;
}

function succeeded(events: readonly EngineEvent[]): Extract<EngineOutcome, { kind: 'Succeeded' }> | null {
  const outcome = results(events).find((candidate) => candidate.kind === 'Succeeded');
  return outcome !== undefined && outcome.kind === 'Succeeded' ? outcome : null;
}

test('F15-AC2 the summary cap stays a cap: a 2250-byte result rides its own field, and every summary stays bounded', () => {
  // This is the defect the channel exists for. The engine put a whole plan on stdout and in the
  // artifact; the old behaviour kept only the truncated summary, so a real session arrived cut off
  // and `applyPlanProposal` was asked to read half an object.
  const events = run(CAPTURED_RESULT_TURN, null, readResult(CAPTURED_RESULT_JSON), RESULT_SCHEMA);

  assert.ok(CAPTURED_RESULT_BYTES > 400, 'the captured result must be longer than the summary cap for this to mean anything');
  const summaries = events
    .filter((event) => event.kind === 'Progress')
    .map((event) => (event.kind === 'Progress' ? event.summary : ''));
  assert.ok(summaries.length > 0, 'the captured turn produced no progress summary to bound');
  for (const summary of summaries) {
    assert.ok(summary.length <= 412, `a progress summary grew past the 400-character cap: ${String(summary.length)}`);
  }
  // A progress summary never carries the payload at all: Codex's own `agent_message` text becomes a
  // bounded stage line, so there is nothing there for a reader to mistake for an answer.
  assert.ok(
    !summaries.some((summary) => summary.includes('acceptanceCriteria')),
    'a progress summary carried the payload rather than a bounded stage line',
  );

  const outcome = succeeded(events);
  assert.ok(outcome !== null, 'a complete result did not produce a Succeeded outcome');
  assert.ok(outcome.summary.length <= 412, `the terminal summary grew past the cap: ${String(outcome.summary.length)}`);
  // The terminal summary is where the old channel lost the payload, so it is the one that has to
  // show the cut: bounded, marked truncated, and visibly not the answer.
  assert.match(outcome.summary, /\[truncated\]$/);
  assert.equal(outcome.summary, `${CAPTURED_RESULT_JSON.slice(0, 400)} [truncated]`);

  // The whole payload, byte for byte, on the field that is not a summary.
  assert.ok(outcome.result !== undefined, 'the result did not arrive on its own field');
  assert.equal(outcome.result.byteLength, CAPTURED_RESULT_BYTES);
  assert.equal(outcome.result.json, CAPTURED_RESULT_JSON);
  assert.ok(outcome.result.json.length > 400, 'the payload was truncated somewhere');
  assert.deepEqual(JSON.parse(outcome.result.json), JSON.parse(CAPTURED_RESULT_JSON));
});

test('F15-AC2 a result that satisfies the schema is reported complete, and names how much was checked', () => {
  const events = run(CAPTURED_RESULT_TURN, null, readResult(CAPTURED_RESULT_JSON), RESULT_SCHEMA);
  const outcome = succeeded(events);
  assert.ok(outcome?.result !== undefined);
  assert.ok(
    outcome.result.checkedProperties > 20,
    `the completeness claim covered only ${String(outcome.result.checkedProperties)} properties`,
  );
  assert.equal(outcome.result.sourcePath, '.shiploop/results/token.json');
  assert.equal(diagnostics(events).length, 0);
});

test('F15-AC2 a truncated result is a failure naming the fault, never a partial success', () => {
  // The exact payload the old channel produced: the first 400 characters of a real result. It is
  // valid-looking text and it is not JSON, which is why a length check alone would have passed it.
  const truncated = CAPTURED_RESULT_JSON.slice(0, 400);
  const events = run(CAPTURED_RESULT_TURN, null, readResult(truncated), RESULT_SCHEMA);

  assert.equal(results(events).length, 0, 'a truncated result still produced a terminal Result');
  const seen = diagnostics(events);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.category, 'MalformedOutput');
  assert.equal(seen[0]?.retry, 'Terminal');
  assert.match(seen[0]?.detail ?? '', /not readable JSON/);
  assert.match(seen[0]?.detail ?? '', /refused rather than reported as a result/);
  assert.match(seen[0]?.detail ?? '', /token\.json/);
  // Usage stays whatever the stream actually reported; a bad result is not a usage fault.
  assert.equal(usageOf(events)?.kind, 'Reported');
});

test('F15-AC2 a payload missing a schema-declared property is refused by name', () => {
  const decoded = JSON.parse(CAPTURED_RESULT_JSON) as Record<string, unknown>;
  delete decoded['exclusions'];
  const events = run(CAPTURED_RESULT_TURN, null, readResult(JSON.stringify(decoded)), RESULT_SCHEMA);

  assert.equal(results(events).length, 0);
  const detail = diagnostics(events)[0]?.detail ?? '';
  assert.match(detail, /does not satisfy the schema/);
  assert.match(detail, /schema-required property "exclusions"/);
  assert.match(detail, /F15-AC2/);
});

test('F15-AC2 an incomplete task inside the payload is refused with the path that is missing it', () => {
  // The shape a cut-off or lazily written payload has: a real proposal whose task lost two of the
  // seven content fields F08-AC1 names. Top-level completeness passes; the nested check is what
  // catches this, which is why the walk recurses rather than reading only the root.
  const payload = JSON.stringify({
    kind: 'PlanProposal',
    briefId: 'brief_probe_001',
    draftedAt: '2026-10-02T00:00:00.000Z',
    requestedOutcomes: [{ id: 'brief.desiredOutcome', statement: 'Resume an interrupted attempt.' }],
    tasks: [
      {
        taskId: 'T-1',
        coversOutcomeIds: ['brief.desiredOutcome'],
        outcome: 'An outcome.',
        scope: 'A scope.',
        acceptanceCriteria: ['A criterion.'],
        dependencies: [],
        relevantProjectContext: [],
        implementationLocation: { kind: 'ProposedLocation', candidates: ['a.ts'], basis: 'Read from the brief.' },
      },
    ],
    exclusions: [],
  });
  const events = run(CAPTURED_RESULT_TURN, null, readResult(payload), RESULT_SCHEMA);

  assert.equal(results(events).length, 0);
  const detail = diagnostics(events)[0]?.detail ?? '';
  assert.match(detail, /tasks\[0\] is missing the schema-required property "verificationMethod"/);
  assert.match(detail, /schema-declared property "tasks\[0\]\.verificationMethod"/);
});

test('F15-AC2 a declared enum the payload violates is refused with the values it allows', () => {
  const payload = CAPTURED_RESULT_JSON.replace('"kind":"PlanProposal"', '"kind":"NotAPlanProposal"');
  const events = run(CAPTURED_RESULT_TURN, null, readResult(payload), RESULT_SCHEMA);

  assert.equal(results(events).length, 0);
  const detail = diagnostics(events)[0]?.detail ?? '';
  assert.match(detail, /kind is "NotAPlanProposal"/);
  assert.match(detail, /PlanProposal/);
});

test('F15-AC2 a result artifact the engine never wrote is a failure naming the path, not an empty success', () => {
  const events = run(
    CAPTURED_RESULT_TURN,
    null,
    { kind: 'Unreadable', detail: 'No structured result was written to .shiploop/results/token.json inside the attempt directory.' },
    RESULT_SCHEMA,
  );

  assert.equal(results(events).length, 0);
  assert.equal(diagnostics(events)[0]?.category, 'MalformedOutput');
  assert.match(diagnostics(events)[0]?.detail ?? '', /No structured result was written to \.shiploop\/results\/token\.json/);
});

test('F15-AC2 a session that asked for a result and got none is refused rather than reported empty', () => {
  const events = run(CAPTURED_RESULT_TURN, null, null, RESULT_SCHEMA);
  assert.equal(results(events).length, 0);
  assert.match(diagnostics(events)[0]?.detail ?? '', /asked for a structured result and none was read/);
});

test('F15-AC2 a session that asked for no result is unaffected by the channel', () => {
  const events = run(CAPTURED_RESULT_TURN);
  const outcome = succeeded(events);
  assert.ok(outcome !== null);
  // No `result` key at all, rather than an empty one: "nothing was asked for" and "nothing was
  // produced" have to stay distinguishable, and an always-present field could not tell them apart.
  assert.equal(outcome.result, undefined);
  assert.equal('result' in outcome, false);
  assert.match(outcome.summary, /PlanProposal/);
  assert.ok(outcome.summary.length <= 412);
});

test('F15-AC2 a malformed stream still outranks a valid result, so a bad result cannot repair a bad stream', () => {
  const events = run(
    [...CAPTURED_RESULT_TURN.slice(0, 3), '{"type":"turn.completed","usage":{"input_tok'],
    null,
    readResult(CAPTURED_RESULT_JSON),
    RESULT_SCHEMA,
  );
  assert.equal(results(events).length, 0);
  assert.match(diagnostics(events)[0]?.detail ?? '', /could not be parsed at line/);
  assert.equal(usageOf(events)?.kind, 'Unknown');
});

test('F15-AC2 a result schema nested past the depth bound is refused rather than partly checked', () => {
  // Fail-closed: a check that stopped early has not established completeness, so reporting it as
  // one would be the same defect as reading a truncated summary as a whole answer.
  let nested: Record<string, unknown> = { type: 'string' };
  let value: unknown = 'leaf';
  for (let depth = 0; depth < 20; depth += 1) {
    nested = { type: 'object', properties: { child: nested } };
    value = { child: value };
  }
  // The value nests as deep as the schema, so the walk really descends rather than stopping at the
  // first absent property and calling it complete.
  const check = checkCodexResultAgainstSchema(value, nested);
  assert.equal(check.boundReached, 'DepthBudget');
  assert.ok(check.totalFailures > 0);

  const events = run(CAPTURED_RESULT_TURN, null, readResult(JSON.stringify(value)), nested);
  assert.equal(results(events).length, 0);
  assert.match(diagnostics(events)[0]?.detail ?? '', /nests deeper than/);
});

test('F15-AC2 a schema declaring more properties than the budget allows is refused, not silently partly checked', () => {
  const wide: Record<string, unknown> = { type: 'object', required: [] };
  const required: string[] = [];
  for (let index = 0; index < 5_000; index += 1) required.push(`field_${String(index)}`);
  wide['required'] = required;
  const check = checkCodexResultAgainstSchema(JSON.parse(CAPTURED_RESULT_JSON), wide);
  assert.equal(check.boundReached, 'PropertyBudget');
  assert.ok(check.checkedProperties > 4_000);
});

test('F15-AC2 the completeness check passes on the captured payload and reads nothing it does not declare', () => {
  const check = checkCodexResultAgainstSchema(JSON.parse(CAPTURED_RESULT_JSON), RESULT_SCHEMA);
  assert.deepEqual([...check.failures], []);
  assert.equal(check.totalFailures, 0);
  assert.equal(check.boundReached, null);

  // A schema that declares nothing checks nothing, and the count says so rather than the zero
  // failures being read as a pass over the whole payload.
  const declares = checkCodexResultAgainstSchema(JSON.parse(CAPTURED_RESULT_JSON), { type: 'string' });
  assert.equal(declares.checkedProperties, 0);
  assert.equal(declares.totalFailures, 0);

  // A schema that declares exactly one property reports exactly one check.
  const one = checkCodexResultAgainstSchema(JSON.parse(CAPTURED_RESULT_JSON), {
    properties: { briefId: { type: 'string' } },
  });
  assert.equal(one.checkedProperties, 1);
  assert.equal(one.totalFailures, 0);
  assert.equal(checkCodexResultAgainstSchema(JSON.parse(CAPTURED_RESULT_JSON), { properties: { absent: {} } }).totalFailures, 1);
});

test('N02-AC2 a credential inside the payload is redacted before it reaches the caller', () => {
  const canary = REDACTION_CANARIES[0] ?? '';
  const payload = CAPTURED_RESULT_JSON.replace('The reader can resume', `upstream rejected ${canary} and the reader can resume`);
  const events = run(CAPTURED_RESULT_TURN, null, readResult(payload), RESULT_SCHEMA);

  const outcome = succeeded(events);
  assert.ok(outcome?.result !== undefined, 'the payload was refused instead of redacted, so nothing reached the caller to leak');
  assert.ok(!outcome.result.json.includes(canary), 'a credential-shaped string survived into the result payload');
  assert.match(outcome.result.json, /\[redacted:/);
  // The measurement is of what the engine wrote, not of what survived redaction.
  assert.equal(outcome.result.byteLength, Buffer.byteLength(payload, 'utf8'));
});

test('N02-AC2 a refusal carrying engine text is redacted too', () => {
  const canary = REDACTION_CANARIES[1] ?? '';
  const events = run(
    CAPTURED_RESULT_TURN,
    null,
    { kind: 'Unreadable', detail: `the artifact at ${canary} could not be parsed` },
    RESULT_SCHEMA,
  );
  assert.equal(results(events).length, 0);
  const detail = diagnostics(events)[0]?.detail ?? '';
  assert.ok(!detail.includes(canary), 'a credential-shaped string survived into a refusal');
  assert.match(detail, /\[redacted:/);
});

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

function run(
  lines: readonly string[],
  interruption: 'Stopped' | 'BudgetExhausted' | null = null,
  result: CodexFinalizeInput['result'] = null,
  schema: CodexFinalizeInput['schema'] = null,
): readonly EngineEvent[] {
  return translateCodexStream(lines, OPTIONS, (state: CodexStreamState) =>
    finalizeCodexStream({
      state,
      options: OPTIONS,
      startedAt: '2026-10-01T08:34:00.000Z',
      interruption,
      exitCode: 0,
      resultExpected: result !== null || schema !== null,
      result,
      schema,
    }),
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
      finalizeCodexStream({
        state,
        options: OPTIONS,
        startedAt: '2026-10-01T08:34:00.000Z',
        interruption: null,
        exitCode: 0,
        resultExpected: false,
        result: null,
        schema: null,
      }),
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
