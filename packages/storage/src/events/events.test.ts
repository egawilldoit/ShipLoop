/**
 * Real SQLite coverage for the durable event store.
 *
 * These tests create a temporary database file per test with the inline schema
 * literals this slice owns, because migrations.ts and tx.ts belong to another branch
 * and do not exist here. The stores are driven through the real node:sqlite driver,
 * not a fake, because the properties under test are durability and transaction
 * semantics rather than data shaping.
 *
 * The external-write harness below is a stand-in for the controller: it asks the
 * operation ledger for permission before it "writes", and counts only the writes the
 * ledger actually allowed. That is what makes "zero second writes" a real measurement
 * instead of an assertion about a counter the store never touches.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase, type Database } from '../db.ts';
import { migrate } from '../migrations.ts';
import { createInboxStore, digestOf, eventIdFor, isSuperseded } from './inbox.ts';
import { createOperationStore } from './operations.ts';
import type { RecordIntentInput } from './operations.ts';
import { backoffForAttempt, createOutboxStore } from './outbox.ts';
import type { EnqueueEffect } from './outbox.ts';
import type { ExternalRef, InboxEvent, SqlConnection } from './types.ts';

interface Harness {
  readonly db: DatabaseSync;
  readonly sql: SqlConnection;
  readonly inbox: ReturnType<typeof createInboxStore>;
  readonly outbox: ReturnType<typeof createOutboxStore>;
  readonly operations: ReturnType<typeof createOperationStore>;
  readonly queries: SqlConnection;
  readonly close: () => Promise<void>;
}

/**
 * Opens a private database with this slice's schema, and removes it afterwards even
 * when the test fails, so no state leaks between tests.
 */
async function harness(options: { readonly recordedAt?: string; readonly location?: string } = {}): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), 'shiploop-events-'));
  const path = options.location ?? join(workspace, 'events.sqlite');
  const opened = openDatabase(path);
  assert.ok(opened.ok, `the database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
  const db: Database = opened.value;
  const migrated = migrate(db);
  assert.ok(migrated.ok, `the schema could not be migrated: ${migrated.ok ? '' : migrated.error.reason}`);
  seedLedgerParents(db);
  const sql: SqlConnection = {
    exec: (statement) => db.exec(statement),
    prepare: (statement) => db.prepare(statement),
    get isTransaction() {
      return db.isTransaction;
    },
  };
  return {
    db,
    sql,
    queries: sql,
    inbox: createInboxStore({ connection: sql, now: () => options.recordedAt ?? '2026-01-01T00:00:00.000Z' }),
    outbox: createOutboxStore({ connection: sql }),
    operations: createOperationStore({ connection: sql }),
    close: async () => {
      db.close();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

/**
 * The rows the event ledger's foreign keys require.
 *
 * The schema ties an external operation to a project, so recording an intent
 * without one is refused. That is the schema making F10-AC3 real: a provider
 * write is always attributable to the work that authorised it.
 */
function seedLedgerParents(db: Database): void {
  db.prepare('INSERT INTO owners (owner_id, display_name) VALUES (?, ?)').run('event-owner', 'Solo owner');
  db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run('event-project', 'Event fixture project');
}

async function withHarness(work: (context: Harness) => void | Promise<void>): Promise<void> {
  const context = await harness();
  try {
    await work(context);
  } finally {
    await context.close();
  }
}

const encoder = new TextEncoder();
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function countRows(context: Pick<Harness, 'queries'>, table: string): number {
  const row = context.queries.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
  assert.ok(row !== undefined);
  return Number(row['total']);
}

/** Asserts the outcome of an accepted ingest and returns the recorded event. */
function recorded(result: ReturnType<Harness['inbox']['recordEvent']>): InboxEvent {
  assert.equal(result.ok, true, result.ok ? '' : result.error.reason);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.value.kind, 'Recorded');
  if (result.value.kind !== 'Recorded') throw new Error('unreachable');
  return result.value.event;
}

const REF_A: ExternalRef = { id: 'issue_a', kind: 'LinearIssue', url: null };
const REF_B: ExternalRef = { id: 'issue_b', kind: 'LinearIssue', url: null };

/** What the fake provider reports back after an allowed write. */
type ProviderResponse =
  | { readonly status: 'Succeeded'; readonly operationRef: string }
  | { readonly status: 'Failed' | 'OutcomeUnknown'; readonly detail: string };

/**
 * A minimal external write guarded by the ledger, in the order ARCHITECTURE.md
 * requires: record the intent, then write, then record the outcome.
 */
interface WriteAttempt {
  /** How many provider calls the ledger actually allowed. */
  readonly writes: () => number;
  readonly attempt: (
    input: RecordIntentInput,
    respond: (attemptNumber: number) => ProviderResponse,
  ) => ReturnType<Harness['operations']['assertWritable']>;
}

function writeHarness(context: Harness): WriteAttempt {
  let writes = 0;
  return {
    writes: () => writes,
    attempt: (input, respond) => {
      const intent = context.operations.recordIntent(input);
      if (!intent.ok) return intent;
      const gate = context.operations.assertWritable(input.operationId, input.at);
      if (!gate.ok) return gate;
      writes += 1;
      const response = respond(writes);
      const outcome =
        response.status === 'Succeeded'
          ? { status: 'Succeeded' as const, at: '2026-01-01T00:00:10.000Z', operationRef: response.operationRef }
          : { status: response.status, at: '2026-01-01T00:00:10.000Z', detail: response.detail };
      const recordedOutcome = context.operations.recordOutcome(input.operationId, outcome);
      if (!recordedOutcome.ok) return recordedOutcome;
      return gate;
    },
  };
}

test('an invalid signature is rejected and nothing is recorded (F30-AC1)', async () => {
  await withHarness(({ inbox, outbox, queries }) => {
    const result = inbox.recordEvent({
      deliveryId: 'delivery-invalid',
      signatureValid: false,
      rawPayloadBytes: encoder.encode('{"action":"update"}'),
      provider: 'linear',
      type: 'IssueUpdated',
      occurredAt: '2026-01-01T00:00:00.000Z',
      correlationId: 'issue_42',
    });

    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.error.code, 'Invalid');
    assert.equal(countRows({ queries }, 'inbox_events'), 0);
    assert.equal(countRows({ queries }, 'external_operations'), 0);
    assert.equal(countRows({ queries }, 'outbox_events'), 0);
    assert.equal(inbox.findByDelivery('linear', 'delivery-invalid'), null);
    assert.equal(outbox.due('2027-01-01T00:00:00.000Z').length, 0);
  });
});

test('a valid event is durably recorded before acknowledgement and survives reopen (F30-AC1)', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shiploop-events-'));
  const path = join(workspace, 'events.sqlite');
  const payload = encoder.encode('{"action":"update","issueId":"issue_42"}');

  const first = await harness({ location: path });
  try {
    const result = first.inbox.recordEvent({
      deliveryId: 'delivery-durable',
      signatureValid: true,
      rawPayloadBytes: payload,
      provider: 'linear',
      type: 'IssueUpdated',
      occurredAt: '2026-01-01T00:00:01.000Z',
      correlationId: 'issue_42',
    });
    const event = recorded(result);

    // A separate connection sees the row before recordEvent returned, so the fact is
    // committed rather than buffered in this connection (F30-AC1, N01-AC3).
    const observed = openDatabase(path);
    assert.ok(observed.ok, `the observer could not be opened: ${observed.ok ? '' : observed.error.reason}`);
    const observerRow = observed.value
      .prepare('SELECT payload_digest FROM inbox_events WHERE inbox_event_id = ?')
      .get(event.eventId);
    observed.value.close();

    assert.ok(observerRow !== undefined, 'the event must be committed before the caller is told it was accepted');
    assert.equal(observerRow['payload_digest'], digestOf(payload));
  } finally {
    first.db.close();
  }

  const reopenedOpen = openDatabase(path);
  assert.ok(reopenedOpen.ok, `the database could not be reopened: ${reopenedOpen.ok ? '' : reopenedOpen.error.reason}`);
  const reopened: Database = reopenedOpen.value;
  const sql: SqlConnection = {
    exec: (statement) => reopened.exec(statement),
    prepare: (statement) => reopened.prepare(statement),
    get isTransaction() {
      return reopened.isTransaction;
    },
  };
  try {
    const inbox = createInboxStore({ connection: sql });
    const restored = inbox.findByDelivery('linear', 'delivery-durable');
    assert.ok(restored !== null);
    assert.equal(restored.eventId, eventIdFor('linear', 'delivery-durable'));
    assert.equal(restored.payloadDigest, digestOf(payload));
    assert.equal(decode(restored.payloadBytes), decode(payload), 'the exact signed bytes must be recoverable');
    assert.equal(restored.correlationId, 'issue_42');
    assert.equal(restored.recordedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(restored.processedAt, null);
  } finally {
    reopened.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('recording an event dispatches no coding work and writes no external effect (F13-AC5)', async () => {
  await withHarness(({ inbox, outbox, operations }) => {
    recorded(
      inbox.recordEvent({
        deliveryId: 'delivery-no-dispatch',
        signatureValid: true,
        rawPayloadBytes: encoder.encode('{"state":"Todo"}'),
        provider: 'linear',
        type: 'IssueUpdated',
        occurredAt: '2026-01-01T00:00:00.000Z',
        correlationId: 'issue_42',
      }),
    );

    assert.equal(outbox.due('2027-01-01T00:00:00.000Z').length, 0, 'ingest must not enqueue an external write');
    assert.equal(operations.findByTarget('PublishProposal', 'issue_42').length, 0);
    assert.equal(inbox.listUnprocessed().length, 1, 'ingest records a fact and leaves processing to the caller');
  });
});

test('the same delivery id recorded twice yields one row and one effect (F30-AC2)', async () => {
  await withHarness((context) => {
    const { inbox } = context;
    const input = {
      deliveryId: 'delivery-replay',
      signatureValid: true,
      rawPayloadBytes: encoder.encode('{"action":"create","title":"Ship it"}'),
      provider: 'linear',
      type: 'IssueCreated',
      occurredAt: '2026-01-02T00:00:00.000Z',
      correlationId: 'issue_new',
    };

    const first = inbox.recordEvent(input);
    const second = inbox.recordEvent(input);

    const created = recorded(first);
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error('unreachable');
    assert.equal(second.value.kind, 'Duplicate');
    assert.equal(second.value.event.eventId, created.eventId);
    assert.equal(inbox.findByDelivery('linear', 'delivery-replay')?.eventId, created.eventId);

    // Only a fresh Recorded result may drive an effect; a Duplicate produces none.
    let publishedEffects = 0;
    for (const result of [first, second]) {
      if (result.ok && result.value.kind === 'Recorded') {
        context.sql.exec('BEGIN IMMEDIATE');
        const published = context.outbox.enqueue({
          effectId: 'eff_from_event',
          dedupKey: `issue_new:${result.value.event.eventId}`,
          kind: 'PublishProposal',
          target: 'issue_new',
          payload: '{}',
          correlationId: 'corr_publish',
          operationId: 'op_publish',
          expectedRefs: [REF_A],
          at: '2026-01-02T00:00:01.000Z',
        });
        context.sql.exec('COMMIT');
        assert.equal(published.ok, true);
        publishedEffects += 1;
      }
    }
    assert.equal(publishedEffects, 1, 'only the first delivery may produce an effect');
    assert.equal(countRows(context, 'inbox_events'), 1);
    assert.equal(context.queries.prepare('SELECT COUNT(*) AS total FROM outbox_events').get()?.['total'], 1);
  });
});

test('an out-of-order older event cannot revert a newer recorded fact (F30-AC3)', async () => {
  await withHarness(({ inbox }) => {
    const newer = recorded(
      inbox.recordEvent({
        deliveryId: 'delivery-order-new',
        signatureValid: true,
        rawPayloadBytes: encoder.encode('{"state":"Done"}'),
        provider: 'linear',
        type: 'IssueUpdated',
        occurredAt: '2026-01-03T00:00:00.000Z',
        correlationId: 'issue_order',
      }),
    );
    const older = inbox.recordEvent({
      deliveryId: 'delivery-order-old',
      signatureValid: true,
      rawPayloadBytes: encoder.encode('{"state":"Todo"}'),
      provider: 'linear',
      type: 'IssueUpdated',
      occurredAt: '2026-01-02T23:00:00.000Z',
      correlationId: 'issue_order',
    });

    assert.equal(older.ok, true);
    if (!older.ok) throw new Error('unreachable');
    assert.equal(older.value.kind, 'Superseded');
    if (older.value.kind !== 'Superseded') throw new Error('unreachable');
    assert.equal(older.value.currentEventId, newer.eventId);

    const current = inbox.currentFact('linear', 'issue_order');
    assert.ok(current !== null);
    assert.equal(current.eventId, newer.eventId, 'the newer fact stays current');
    assert.equal(isSuperseded(older.value.event, current), true);
    assert.equal(isSuperseded(newer, current), false);
  });
});

test('equal timestamps are resolved by ingest order, so the later delivery wins (F30-AC3)', async () => {
  await withHarness(({ inbox }) => {
    const first = recorded(
      inbox.recordEvent({
        deliveryId: 'delivery-tie-first',
        signatureValid: true,
        rawPayloadBytes: encoder.encode('{"a":1}'),
        provider: 'linear',
        type: 'IssueUpdated',
        occurredAt: '2026-01-04T00:00:00.000Z',
        correlationId: 'issue_tie',
      }),
    );
    const second = recorded(
      inbox.recordEvent({
        deliveryId: 'delivery-tie-second',
        signatureValid: true,
        rawPayloadBytes: encoder.encode('{"a":2}'),
        provider: 'linear',
        type: 'IssueUpdated',
        occurredAt: '2026-01-04T00:00:00.000Z',
        correlationId: 'issue_tie',
      }),
    );

    const current = inbox.currentFact('linear', 'issue_tie');
    assert.ok(current !== null);
    assert.equal(current.eventId, second.eventId);
    assert.equal(isSuperseded(first, current), true);
    assert.equal(second.sequence > first.sequence, true);
  });
});

test('markProcessed records the processing correlation id and stays idempotent', async () => {
  await withHarness(({ inbox }) => {
    const event = recorded(
      inbox.recordEvent({
        deliveryId: 'delivery-processed',
        signatureValid: true,
        rawPayloadBytes: encoder.encode('{}'),
        provider: 'linear',
        type: 'IssueUpdated',
        occurredAt: '2026-01-05T00:00:00.000Z',
        correlationId: 'issue_7',
      }),
    );

    const processed = inbox.markProcessed(event.eventId, 'corr_process_1', '2026-01-05T00:05:00.000Z');
    assert.equal(processed.ok, true);
    if (!processed.ok) throw new Error('unreachable');
    assert.equal(processed.value.processedAt, '2026-01-05T00:05:00.000Z');
    assert.equal(processed.value.processedBy, 'corr_process_1');
    assert.equal(processed.value.correlationId, 'issue_7', 'the ingest correlation id survives processing');
    assert.equal(inbox.listUnprocessed().length, 0);

    const again = inbox.markProcessed(event.eventId, 'corr_process_2', '2026-01-05T00:09:00.000Z');
    assert.equal(again.ok, true);
    if (!again.ok) throw new Error('unreachable');
    assert.equal(again.value.processedAt, '2026-01-05T00:05:00.000Z');
    assert.equal(again.value.processedBy, 'corr_process_1', 'a replayed processing pass does not rewrite history');

    const missing = inbox.markProcessed('evt_absent', 'corr_process_1', '2026-01-05T00:10:00.000Z');
    assert.equal(missing.ok, false);
    if (missing.ok) throw new Error('unreachable');
    assert.equal(missing.error.code, 'NotFound');
  });
});

test('an outbox effect enqueued in a committed transaction is present, and a rolled back one is absent (N01-AC3)', async () => {
  await withHarness(({ outbox, sql }) => {
    const committed: EnqueueEffect = {
      effectId: 'eff_tx_commit',
      dedupKey: 'dedup_tx_commit',
      kind: 'PublishProposal',
      target: 'issue_tx',
      payload: '{"title":"Ship it"}',
      correlationId: 'corr_tx',
      operationId: 'op_tx_commit',
      expectedRefs: [REF_A],
      at: '2026-01-06T00:00:00.000Z',
    };

    sql.exec('BEGIN IMMEDIATE');
    const enqueued = outbox.enqueue(committed);
    sql.exec('COMMIT');

    assert.equal(enqueued.ok, true);
    if (!enqueued.ok) throw new Error('unreachable');
    assert.equal(enqueued.value.created, true);
    assert.equal(outbox.findByDedupKey('dedup_tx_commit')?.effectId, 'eff_tx_commit');
    assert.deepEqual(
      outbox.due('2026-01-06T00:00:00.000Z').map((effect) => effect.effectId),
      ['eff_tx_commit'],
    );

    sql.exec('BEGIN IMMEDIATE');
    const rolledBack = outbox.enqueue({ ...committed, effectId: 'eff_tx_rollback', dedupKey: 'dedup_tx_rollback' });
    sql.exec('ROLLBACK');

    assert.equal(rolledBack.ok, true, 'enqueue itself succeeds; the rollback removes it');
    assert.equal(outbox.findByDedupKey('dedup_tx_rollback'), null);
    assert.equal(
      sql.prepare('SELECT COUNT(*) AS total FROM outbox_events').get()?.['total'],
      1,
      'a rolled back transaction leaves no effect behind',
    );
  });
});

test('enqueue outside a transaction is refused, because an uncommitted effect is the N01-AC3 failure', async () => {
  await withHarness(({ outbox }) => {
    const attempted = outbox.enqueue({
      effectId: 'eff_unwrapped',
      dedupKey: 'dedup_unwrapped',
      kind: 'PublishProposal',
      target: 'issue_unwrapped',
      payload: '{}',
      correlationId: 'corr_unwrapped',
      operationId: 'op_unwrapped',
      expectedRefs: [REF_A],
      at: '2026-01-06T00:00:00.000Z',
    });

    assert.equal(attempted.ok, false);
    if (attempted.ok) throw new Error('unreachable');
    assert.equal(attempted.error.code, 'Conflict');
    assert.equal(outbox.findByDedupKey('dedup_unwrapped'), null);
  });
});

test('re-enqueueing the same dedup key returns the original effect without a second row', async () => {
  await withHarness(({ outbox, sql }) => {
    const effect: EnqueueEffect = {
      effectId: 'eff_receipt',
      dedupKey: 'receipt:rcpt_1',
      kind: 'ReceiptPublish',
      target: 'rcpt_1',
      payload: '{"receiptId":"rcpt_1"}',
      correlationId: 'corr_receipt',
      operationId: 'op_receipt',
      expectedRefs: [{ id: 'rcpt_1', kind: 'LinearIssue', url: null }],
      at: '2026-01-07T00:00:00.000Z',
    };

    sql.exec('BEGIN IMMEDIATE');
    outbox.enqueue(effect);
    sql.exec('COMMIT');

    sql.exec('BEGIN IMMEDIATE');
    const repeat = outbox.enqueue({ ...effect, effectId: 'eff_receipt_second_id', at: '2026-01-07T00:05:00.000Z' });
    sql.exec('COMMIT');

    assert.equal(repeat.ok, true);
    if (!repeat.ok) throw new Error('unreachable');
    assert.equal(repeat.value.created, false);
    assert.equal(repeat.value.effect.effectId, 'eff_receipt');
    assert.equal(sql.prepare('SELECT COUNT(*) AS total FROM outbox_events').get()?.['total'], 1);
  });
});

test('a rate-limited outcome records the category and retry hint, and the effect stays Pending sync (F30-AC4)', async () => {
  await withHarness(({ outbox, sql }) => {
    sql.exec('BEGIN IMMEDIATE');
    outbox.enqueue({
      effectId: 'eff_rate_limited',
      dedupKey: 'dedup_rate_limited',
      kind: 'PublishProposal',
      target: 'issue_rl',
      payload: '{}',
      correlationId: 'corr_rl',
      operationId: 'op_rl',
      expectedRefs: [REF_A, REF_B],
      at: '2026-02-01T00:00:00.000Z',
    });
    sql.exec('COMMIT');

    const partial = outbox.markSucceeded('eff_rate_limited', {
      at: '2026-02-01T00:00:10.000Z',
      refs: [REF_A],
    });
    assert.equal(partial.ok, true);
    if (!partial.ok) throw new Error('unreachable');
    assert.equal(partial.value.status, 'PendingSync', 'one of two tickets is not a published proposal');
    assert.equal(partial.value.lastSuccessAt, '2026-02-01T00:00:10.000Z');
    assert.deepEqual(
      outbox.unpublishedRefs('eff_rate_limited').map((ref) => ref.id),
      ['issue_b'],
    );

    const attempted = outbox.markAttempt('eff_rate_limited', '2026-02-01T01:00:00.000Z');
    assert.equal(attempted.ok, true);
    if (!attempted.ok) throw new Error('unreachable');
    assert.equal(attempted.value.attemptCount, 1);

    const failed = outbox.markFailed(
      'eff_rate_limited',
      { category: 'RateLimited', detail: 'HTTP 429 retry-after 60s', retryAfterMs: 60_000 },
      '2026-02-01T01:00:00.000Z',
    );

    assert.equal(failed.ok, true);
    if (!failed.ok) throw new Error('unreachable');
    assert.equal(failed.value.status, 'PendingSync');
    assert.equal(failed.value.lastFailureCategory, 'RateLimited');
    assert.equal(failed.value.lastFailureDetail, 'HTTP 429 retry-after 60s');
    assert.equal(failed.value.nextAttemptAt, '2026-02-01T01:01:00.000Z', 'the provider retry hint wins over local backoff');
    assert.equal(failed.value.lastSuccessAt, '2026-02-01T00:00:10.000Z', 'a failure never clears the last success time');

    assert.deepEqual(outbox.due('2026-02-01T00:59:59.000Z'), [], 'backoff is honoured before the next attempt');
    assert.deepEqual(
      outbox.due('2026-02-01T01:01:00.000Z').map((effect) => effect.effectId),
      ['eff_rate_limited'],
    );

    const pending = outbox.pendingSync().filter((effect) => effect.effectId === 'eff_rate_limited');
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.lastSuccessAt, '2026-02-01T00:00:10.000Z');
    assert.equal(pending[0]?.status, 'PendingSync');
  });
});

test('a failed external update is never dropped: repeated failures keep pending sync with growing backoff (F16-AC4)', async () => {
  await withHarness(({ outbox, sql }) => {
    sql.exec('BEGIN IMMEDIATE');
    outbox.enqueue({
      effectId: 'eff_progress',
      dedupKey: 'dedup_progress',
      kind: 'ProgressComment',
      target: 'issue_progress',
      payload: '{}',
      correlationId: 'corr_progress',
      operationId: 'op_progress',
      expectedRefs: [REF_A],
      at: '2026-02-02T00:00:00.000Z',
    });
    sql.exec('COMMIT');

    outbox.markAttempt('eff_progress', '2026-02-02T00:00:01.000Z');
    const firstFailure = outbox.markFailed(
      'eff_progress',
      { category: 'PermissionDenied', detail: 'HTTP 403' },
      '2026-02-02T00:00:01.000Z',
    );
    assert.equal(firstFailure.ok, true);
    if (!firstFailure.ok) throw new Error('unreachable');
    assert.equal(firstFailure.value.nextAttemptAt, '2026-02-02T00:00:06.000Z', 'the first retry waits the base delay');

    outbox.markAttempt('eff_progress', '2026-02-02T00:01:00.000Z');
    const secondFailure = outbox.markFailed(
      'eff_progress',
      { category: 'PermissionDenied', detail: 'HTTP 403' },
      '2026-02-02T00:01:00.000Z',
    );
    assert.equal(secondFailure.ok, true);
    if (!secondFailure.ok) throw new Error('unreachable');
    assert.equal(secondFailure.value.attemptCount, 2);
    assert.equal(secondFailure.value.nextAttemptAt, '2026-02-02T00:01:15.000Z', 'the next retry backs off further');
    assert.equal(secondFailure.value.status, 'PendingSync');
    assert.equal(secondFailure.value.lastSuccessAt, null);

    const stillPending = outbox.pendingSync();
    assert.deepEqual(
      stillPending.map((effect) => effect.effectId),
      ['eff_progress'],
    );
  });
});

test('a partial publication records what remains unpublished without losing successful mappings (F10-AC2, F10-AC5)', async () => {
  await withHarness(({ outbox, sql }) => {
    sql.exec('BEGIN IMMEDIATE');
    outbox.enqueue({
      effectId: 'eff_partial',
      dedupKey: 'dedup_partial',
      kind: 'PublishProposal',
      target: 'scope_7',
      payload: '{}',
      correlationId: 'corr_partial',
      operationId: 'op_partial',
      expectedRefs: [REF_A, REF_B],
      at: '2026-03-01T00:00:00.000Z',
    });
    sql.exec('COMMIT');

    const partial = outbox.markSucceeded('eff_partial', {
      at: '2026-03-01T00:00:05.000Z',
      refs: [{ ...REF_A, url: 'https://linear.app/x/issue_a' }],
    });

    assert.equal(partial.ok, true);
    if (!partial.ok) throw new Error('unreachable');
    assert.equal(partial.value.status, 'PendingSync', 'an incomplete publication is not a success');
    assert.equal(partial.value.lastSuccessAt, '2026-03-01T00:00:05.000Z');
    assert.deepEqual(
      outbox.unpublishedRefs('eff_partial').map((ref) => ref.id),
      ['issue_b'],
    );

    outbox.markAttempt('eff_partial', '2026-03-01T00:00:06.000Z');
    const failed = outbox.markFailed(
      'eff_partial',
      { category: 'Validation', detail: 'issue_b rejected: title too long' },
      '2026-03-01T00:00:06.000Z',
    );
    assert.equal(failed.ok, true);
    if (!failed.ok) throw new Error('unreachable');
    assert.deepEqual(
      failed.value.succeededRefs.map((ref) => ref.id),
      ['issue_a'],
      'the successful mapping survives the failure',
    );

    const completed = outbox.markSucceeded('eff_partial', {
      at: '2026-03-01T00:10:00.000Z',
      refs: [{ ...REF_B, url: 'https://linear.app/x/issue_b' }],
    });
    assert.equal(completed.ok, true);
    if (!completed.ok) throw new Error('unreachable');
    assert.equal(completed.value.status, 'Succeeded');
    assert.deepEqual(
      completed.value.succeededRefs.map((ref) => ref.id),
      ['issue_a', 'issue_b'],
    );
    assert.deepEqual(outbox.unpublishedRefs('eff_partial'), []);
  });
});

test('an OutcomeUnknown effect leaves the due set and refuses further attempts (F28-AC4)', async () => {
  await withHarness(({ outbox, sql }) => {
    sql.exec('BEGIN IMMEDIATE');
    outbox.enqueue({
      effectId: 'eff_unknown',
      dedupKey: 'dedup_unknown',
      kind: 'Merge',
      target: 'repo/feature-branch',
      payload: '{}',
      correlationId: 'corr_unknown',
      operationId: 'op_unknown',
      expectedRefs: [REF_A],
      at: '2026-04-01T00:00:00.000Z',
    });
    sql.exec('COMMIT');

    outbox.markAttempt('eff_unknown', '2026-04-01T00:00:01.000Z');
    const unknown = outbox.markOutcomeUnknown('eff_unknown', 'connection reset before response', '2026-04-01T00:00:01.000Z');
    assert.equal(unknown.ok, true);
    if (!unknown.ok) throw new Error('unreachable');
    assert.equal(unknown.value.status, 'OutcomeUnknown');
    assert.equal(unknown.value.lastFailureCategory, 'OutcomeUnknown');

    assert.deepEqual(
      outbox.due('2026-04-01T01:00:00.000Z'),
      [],
      'an unknown outcome is never offered for another attempt',
    );

    const retry = outbox.markAttempt('eff_unknown', '2026-04-01T01:00:00.000Z');
    assert.equal(retry.ok, false);
    if (retry.ok) throw new Error('unreachable');
    assert.equal(retry.error.code, 'OutcomeUnknown');
    assert.equal(retry.error.operationId, 'op_unknown');
    assert.equal(retry.error.target, 'repo/feature-branch');

    const unresolved = outbox.pendingSync().filter((effect) => effect.effectId === 'eff_unknown');
    assert.equal(unresolved.length, 1, 'an unresolved write stays visible (F30-AC4)');
  });
});

test('bounded backoff grows and is capped', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 8].map((attempt) => backoffForAttempt(attempt)),
    [5_000, 15_000, 45_000, 135_000, 300_000, 300_000],
  );
});

test('recording intent then OutcomeUnknown, then writing again with the same operation id, performs zero second writes (F28-AC4, F10-AC3)', async () => {
  await withHarness((context) => {
    const intent: RecordIntentInput = {
      operationId: 'op_merge_1',
      projectId: 'event-project',
      kind: 'Merge',
      target: 'repo/feature-branch',
      expectedRefs: [{ id: 'sha_base', kind: 'CommitSha', url: null }],
      correlationId: 'corr_merge_1',
      at: '2026-05-01T00:00:00.000Z',
    };
    const writes = writeHarness(context);

    const firstAttempt = writes.attempt(intent, () => ({
      status: 'OutcomeUnknown',
      detail: 'provider response never arrived',
    }));
    assert.equal(firstAttempt.ok, true);
    assert.equal(writes.writes(), 1);

    const secondAttempt = writes.attempt(intent, () => ({ status: 'Succeeded', operationRef: 'merge_1' }));
    assert.equal(secondAttempt.ok, false);
    if (secondAttempt.ok) throw new Error('unreachable');
    assert.equal(secondAttempt.error.code, 'OutcomeUnknown');
    assert.equal(secondAttempt.error.operationId, 'op_merge_1');
    assert.equal(writes.writes(), 1, 'a lost response must never become a second write');

    const gate = context.operations.assertWritable('op_merge_1', '2026-05-01T00:05:00.000Z');
    assert.equal(gate.ok, false);
    assert.equal(writes.writes(), 1);

    assert.deepEqual(
      context.operations.pendingReconciliation('2026-05-01T00:00:01.000Z').map((op) => op.operationId),
      ['op_merge_1'],
    );
  });
});

test('an interruption after the write but before its outcome also blocks a second write (N01-AC2)', async () => {
  await withHarness((context) => {
    const intent: RecordIntentInput = {
      operationId: 'op_pr_create',
      projectId: 'event-project',
      kind: 'PullRequestCreate',
      target: 'repo/feature-branch',
      expectedRefs: [],
      correlationId: 'corr_pr',
      at: '2026-05-02T00:00:00.000Z',
    };
    let writes = 0;

    const recordedIntent = context.operations.recordIntent(intent);
    assert.equal(recordedIntent.ok, true);

    const inFlight = context.operations.assertWritable('op_pr_create', '2026-05-02T00:00:01.000Z');
    assert.equal(inFlight.ok, true, 'the write that this intent was recorded for is still in flight');
    writes += 1;

    // The process dies here: the provider received the write, no outcome was recorded.
    assert.equal(context.operations.assertWritable('op_pr_create', '2026-05-02T00:05:00.000Z').ok, false);
    assert.equal(writes, 1);

    const retry = context.operations.recordIntent({ ...intent, at: '2026-05-02T00:05:00.000Z' });
    assert.equal(retry.ok, true, 'the intent is already durable, so recording it again changes nothing');
    if (!retry.ok) throw new Error('unreachable');
    assert.equal(retry.value.status, 'IntentRecorded');
    assert.equal(context.operations.assertWritable('op_pr_create', '2026-05-02T00:05:00.000Z').ok, false);
    assert.equal(writes, 1, 'a stale intent with no outcome is never written again');

    assert.deepEqual(
      context.operations.pendingReconciliation('2026-05-02T00:01:00.000Z').map((op) => op.operationId),
      ['op_pr_create'],
      'an intent with no recorded outcome is unresolved work, not permission to retry',
    );

    assert.equal(context.operations.isStaleIntent(retry.value, '2026-05-02T00:05:00.000Z'), true);
    assert.equal(context.operations.isStaleIntent(retry.value, '2026-05-02T00:00:30.000Z'), false);

    const reconciled = context.operations.recordOutcome('op_pr_create', {
      status: 'Succeeded',
      at: '2026-05-02T00:06:00.000Z',
      operationRef: 'pr_991',
    });
    assert.equal(reconciled.ok, true);
    if (!reconciled.ok) throw new Error('unreachable');
    assert.equal(reconciled.value.operationRef, 'pr_991');
    assert.deepEqual(context.operations.pendingReconciliation('2026-06-01T00:00:00.000Z'), []);
  });
});

test('a definite failure is retryable, and a success is not (F30-AC5)', async () => {
  await withHarness((context) => {
    const intent: RecordIntentInput = {
      operationId: 'op_comment',
      projectId: 'event-project',
      kind: 'CommentCreate',
      target: 'issue_9',
      expectedRefs: [],
      correlationId: 'corr_comment',
      at: '2026-05-03T00:00:00.000Z',
    };
    const writes = writeHarness(context);

    writes.attempt(intent, () => ({ status: 'Failed', detail: 'HTTP 422 invalid body' }));
    assert.equal(writes.writes(), 1);

    const retry = writes.attempt(intent, () => ({ status: 'Succeeded', operationRef: 'comment_1' }));
    assert.equal(retry.ok, true, 'a refused write left nothing external, so a retry cannot duplicate it');
    assert.equal(writes.writes(), 2);

    const third = writes.attempt(intent, () => ({ status: 'Succeeded', operationRef: 'comment_2' }));
    assert.equal(third.ok, false);
    if (third.ok) throw new Error('unreachable');
    assert.equal(third.error.code, 'Conflict');
    assert.equal(writes.writes(), 2, 'a succeeded write is never issued again');
    assert.equal(context.operations.findByOperation('op_comment')?.operationRef, 'comment_1');
  });
});

test('two operation ids for the same target are distinguishable, so a genuinely new action is allowed', async () => {
  await withHarness(({ operations }) => {
    const first = operations.recordIntent({
      operationId: 'op_release_a',
      projectId: 'event-project',
      kind: 'Release',
      target: 'app/production',
      expectedRefs: [],
      correlationId: 'corr_release_a',
      at: '2026-06-01T00:00:00.000Z',
    });
    const second = operations.recordIntent({
      operationId: 'op_release_b',
      projectId: 'event-project',
      kind: 'Release',
      target: 'app/production',
      expectedRefs: [],
      correlationId: 'corr_release_b',
      at: '2026-06-01T01:00:00.000Z',
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    assert.notEqual(first.value.operationId, second.value.operationId);
    assert.equal(first.value.target, second.value.target);

    const byTarget = operations.findByTarget('Release', 'app/production');
    assert.deepEqual(
      byTarget.map((operation) => operation.operationId),
      ['op_release_a', 'op_release_b'],
    );

    // Both identities are live, in-flight intents, so each is writable exactly once and
    // the ledger never confuses one release for the other.
    assert.equal(operations.assertWritable('op_release_a', '2026-06-01T00:00:10.000Z').ok, true);
    assert.equal(operations.assertWritable('op_release_b', '2026-06-01T01:00:10.000Z').ok, true);
    assert.equal(operations.isStaleIntent(first.value, '2026-06-01T00:00:10.000Z'), false);
    assert.equal(operations.isStaleIntent(first.value, '2026-06-01T00:05:00.000Z'), true);

    const reused = operations.recordIntent({
      operationId: 'op_release_a',
      projectId: 'event-project',
      kind: 'Merge',
      target: 'app/production',
      expectedRefs: [],
      correlationId: 'corr_release_a',
      at: '2026-06-02T00:00:00.000Z',
    });
    assert.equal(reused.ok, false);
    if (reused.ok) throw new Error('unreachable');
    assert.equal(reused.error.code, 'Conflict');

    const absent = operations.assertWritable('op_never_recorded', '2026-06-02T00:00:00.000Z');
    assert.equal(absent.ok, false);
    if (absent.ok) throw new Error('unreachable');
    assert.equal(absent.error.code, 'NotFound');
  });
});

test('a release receipt retry does not republish a duplicate receipt (F29-AC4)', async () => {
  await withHarness(({ operations, outbox, sql }) => {
    const receipt: EnqueueEffect = {
      effectId: 'eff_receipt',
      dedupKey: 'receipt:rcpt_1',
      kind: 'ReceiptPublish',
      target: 'rcpt_1',
      payload: '{"receiptId":"rcpt_1"}',
      correlationId: 'corr_receipt',
      operationId: 'op_receipt',
      expectedRefs: [{ id: 'rcpt_1', kind: 'LinearIssue', url: null }],
      at: '2026-07-01T00:00:00.000Z',
    };

    sql.exec('BEGIN IMMEDIATE');
    outbox.enqueue(receipt);
    operations.recordIntent({
      operationId: 'op_receipt',
      projectId: 'event-project',
      kind: 'ReceiptPublish',
      target: 'rcpt_1',
      expectedRefs: [],
      correlationId: 'corr_receipt',
      at: '2026-07-01T00:00:00.000Z',
    });
    sql.exec('COMMIT');

    outbox.markAttempt('eff_receipt', '2026-07-01T00:00:01.000Z');
    outbox.markFailed('eff_receipt', { category: 'TransientProvider', detail: 'HTTP 502' }, '2026-07-01T00:00:01.000Z');
    assert.equal(outbox.findByDedupKey('receipt:rcpt_1')?.status, 'PendingSync');

    sql.exec('BEGIN IMMEDIATE');
    const retryEnqueue = outbox.enqueue({ ...receipt, effectId: 'eff_receipt_retry', at: '2026-07-01T00:10:00.000Z' });
    sql.exec('COMMIT');
    assert.equal(retryEnqueue.ok && retryEnqueue.value.created, false, 'the retry reuses the original effect');

    outbox.markAttempt('eff_receipt', '2026-07-01T00:10:01.000Z');
    const published = outbox.markSucceeded('eff_receipt', {
      at: '2026-07-01T00:10:02.000Z',
      refs: [{ id: 'rcpt_1', kind: 'LinearIssue', url: 'https://linear.app/x/rcpt_1' }],
    });
    assert.equal(published.ok, true);
    if (!published.ok) throw new Error('unreachable');
    assert.equal(published.value.status, 'Succeeded');

    assert.deepEqual(
      outbox.findByOperation('op_receipt').map((effect) => effect.effectId),
      ['eff_receipt'],
      'one effect means one published receipt',
    );
    assert.equal(sql.prepare('SELECT COUNT(*) AS total FROM outbox_events').get()?.['total'], 1);
    assert.deepEqual(outbox.unpublishedRefs('eff_receipt'), []);
    assert.deepEqual(outbox.pendingSync(), []);
  });
});