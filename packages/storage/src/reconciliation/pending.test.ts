/**
 * Behavioural proof for the reconciliation worklist, the retry gate and the pending
 * sync view.
 *
 * Every test runs against the REAL migrated schema: a temporary SQLite file opened with
 * `openDatabase` and built by `migrate`, driven through the real `node:sqlite` driver.
 * The properties under test are durability and anti-duplication properties, so the
 * ledger is written through the real `createOperationStore` and `createOutboxStore`
 * rather than by hand: a fixture that inserted a status directly would prove that a
 * hand-written row reads back, not that a lost response is treated as unresolved.
 *
 * The retry gate is measured the way the ledger measures it. `assertWritable` is the
 * controller's last gate before a provider call, so the count of writes it actually
 * allowed is the count that matters, and a test that only read a `permitted` boolean
 * would prove nothing about whether a second write can happen.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DomainError, ProfileVersionId, ProjectId, Result, WorkItemId } from '@shiploop/domain';
import { fingerprint } from '@shiploop/domain';
import { openDatabase, type Database } from '../db.ts';
import { migrate } from '../migrations.ts';
import { withTransaction } from '../tx.ts';
import { WorkItemRepository } from '../repositories/core.ts';
import { createOperationStore } from '../events/operations.ts';
import { createOutboxStore } from '../events/outbox.ts';
import type { ExternalRef, SqlConnection } from '../events/types.ts';
import { PendingReconciliationStore } from './pending.ts';

const PROJECT = '7d1b2c33-0000-4000-8000-00000000000a' as ProjectId;
const PROFILE_VERSION = '7d1b2c33-0000-4000-8000-00000000000b' as ProfileVersionId;
const OWNER = '7d1b2c33-0000-4000-8000-00000000000c';
const T0 = '2026-04-01T08:00:00.000Z';
const LATER = '2026-04-01T09:00:00.000Z';
const WELL_PAST = '2026-04-01T12:00:00.000Z';
const BOUND = 60_000;

function expectOk<T>(result: Result<T, DomainError>): T {
  if (!result.ok) {
    assert.fail(`expected success but received ${result.error.code}: ${result.error.reason}`);
  }
  return result.value;
}

function expectError<T>(result: Result<T, DomainError>, code: DomainError['code']): DomainError {
  if (result.ok) {
    assert.fail(`expected ${code} but the call succeeded`);
  }
  assert.equal(result.error.code, code);
  return result.error;
}

function ref(id: string, kind = 'Issue'): ExternalRef {
  return { id, kind, url: `https://linear.test/${id}` };
}

function minutes(ms: number): string {
  return new Date(Date.parse(T0) + ms).toISOString();
}

interface Harness {
  readonly connection: Database;
  readonly sql: SqlConnection;
  readonly workItemId: WorkItemId;
  readonly operations: ReturnType<typeof createOperationStore>;
  readonly outbox: ReturnType<typeof createOutboxStore>;
  readonly pending: PendingReconciliationStore;
  readonly close: () => Promise<void>;
}

async function withDatabase(
  run: (context: Harness) => Promise<void> | void,
  options: { readonly boundMs?: number } = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-pending-'));
  const opened = openDatabase(join(directory, 'pending.sqlite'));
  assert.ok(opened.ok, `the database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
  const connection: Database = opened.value;
  try {
    const migrated = migrate(connection);
    assert.ok(migrated.ok, `the schema could not be migrated: ${migrated.ok ? '' : migrated.error.reason}`);
    const workItemId = seedLedgerParents(connection);
    const sql: SqlConnection = {
      exec: (statement) => connection.exec(statement),
      prepare: (statement) => connection.prepare(statement),
      get isTransaction() {
        return connection.isTransaction;
      },
    };
    await run({
      connection,
      sql,
      workItemId,
      operations: createOperationStore({ connection: sql, inFlightBoundMs: BOUND }),
      outbox: createOutboxStore({ connection: sql }),
      pending: new PendingReconciliationStore(connection, {
        ...(options.boundMs === undefined ? {} : { boundMs: options.boundMs }),
      }),
      close: async () => {
        connection.close();
      },
    });
  } finally {
    connection.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The parents the ledger's foreign keys require, plus the work item being synced.
 *
 * The work item is created through the real repository rather than a fixture INSERT,
 * so every column its reader requires is bound the way the product binds it. A
 * hand-written row that omitted one would fail for a reason that has nothing to do
 * with what these tests are about.
 */
function seedLedgerParents(connection: Database): WorkItemId {
  connection
    .prepare('INSERT INTO owners (owner_id, display_name, created_at) VALUES (?, ?, ?)')
    .run(OWNER, 'Solo owner', T0);
  connection
    .prepare('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)')
    .run(PROJECT, 'Pending project', T0);
  connection
    .prepare(
      `INSERT INTO project_profile_versions (profile_version_id, project_id, version, content_json, content_fingerprint, created_by, created_at)
       VALUES (?, ?, 1, '{}', ?, ?, ?)`,
    )
    .run(PROFILE_VERSION, PROJECT, fingerprint({ profile: 'pending' }), OWNER, T0);
  return expectOk(
    new WorkItemRepository(connection).create({
      projectId: PROJECT,
      profileVersionId: PROFILE_VERSION,
      source: 'ProposedNewIssue',
      title: 'Publish the run summary',
      externalIssueId: 'issue-pending',
      externalIssueIdentifier: 'ENG-42',
      externalIssueUrl: 'https://linear.test/ENG-42',
      publicationIntent: 'PublishWhenAgreed',
      relatedWorkItemIds: [],
      adoption: null,
      at: T0,
    }),
  ).workItemId;
}

function intent(
  operations: Harness['operations'],
  operationId: string,
  kind: string,
  target: string,
  expected: readonly ExternalRef[],
  at = T0,
): void {
  expectOk(
    operations.recordIntent({
      operationId,
      projectId: PROJECT,
      kind,
      target,
      expectedRefs: expected,
      correlationId: 'correlation-1',
      at,
    }),
  );
}

test('an operation with a lost response is on the worklist with the identity needed to reconcile it (F30-AC5)', async () => {
  await withDatabase(async ({ operations, pending }) => {
    const expected = [ref('ENG-99')];
    intent(operations, 'op-publish-1', 'PublishIssue', 'idea-9/ticket', expected);
    expectOk(
      operations.recordOutcome('op-publish-1', {
        status: 'OutcomeUnknown',
        at: T0,
        detail: 'The provider connection closed before a response arrived.',
      }),
    );

    const worklist = pending.pendingReconciliation(LATER);
    const entry = worklist.find((candidate) => candidate.operationId === 'op-publish-1');
    assert.ok(entry, 'an unresolved write is on the worklist');
    assert.equal(entry.kind, 'PublishIssue');
    assert.equal(entry.target, 'idea-9/ticket');
    assert.deepEqual(
      entry.expectedRefs.map((reference) => reference.id),
      ['ENG-99'],
      'the refs a repeated request must not duplicate are named',
    );
    assert.equal(entry.status, 'OutcomeUnknown');
    assert.equal(entry.workItemId, null);
    assert.equal(entry.operationRef, null);
    assert.equal(
      entry.unknown,
      'The provider connection closed before a response arrived.',
      'what could not be established is stated, not just flagged',
    );
    assert.equal(entry.unresolvedSince, T0);
  });
});

test('an operation resolved any way at all leaves the worklist (F30-AC5, F28-AC4)', async () => {
  await withDatabase(async ({ operations, pending }) => {
    intent(operations, 'op-succeeded', 'Merge', 'main', []);
    expectOk(operations.recordOutcome('op-succeeded', { status: 'Succeeded', at: T0, operationRef: 'pr-1' }));
    intent(operations, 'op-failed', 'Deploy', 'preview', []);
    expectOk(operations.recordOutcome('op-failed', { status: 'Failed', at: T0, detail: 'The provider refused it.' }));

    assert.deepEqual(
      pending.pendingReconciliation(LATER).map((entry) => entry.operationId),
      [],
      'a settled write is not a question for anyone',
    );
  });
});

test('a write that never reached the ledger, because its intent is older than the bound, is on the worklist (N01-AC2)', async () => {
  await withDatabase(async ({ operations, pending }) => {
    intent(operations, 'op-inflight', 'Deploy', 'production', []);

    assert.deepEqual(
      pending.pendingReconciliation(minutes(30_000)).map((entry) => entry.operationId),
      [],
      'a write still inside the provider timeout is in flight, not unresolved',
    );
    const stale = pending.pendingReconciliation(minutes(120_000));
    assert.deepEqual(
      stale.map((entry) => entry.operationId),
      ['op-inflight'],
      'past the bound an unrecorded intent may already have reached the provider',
    );
    assert.match(stale[0]?.unknown ?? '', /may already have reached the provider/);
  });
});

test('a sync attempt that never completed is on the worklist with its own identity (F16-AC4, F30-AC5)', async () => {
  await withDatabase(async ({ connection, operations, outbox, pending }) => {
    intent(operations, 'op-comment', 'ProgressComment', 'ENG-42', [ref('ENG-42')]);
    const enqueued = expectOk(
      withTransaction(connection, () =>
        outbox.enqueue({
          effectId: 'effect-comment',
          dedupKey: 'ProgressComment:ENG-42',
          kind: 'ProgressComment',
          target: 'ENG-42',
          payload: '{}',
          correlationId: 'correlation-1',
          operationId: 'op-comment',
          expectedRefs: [ref('ENG-42')],
          at: T0,
        }),
      ),
    );
    assert.equal(enqueued.created, true);
    expectOk(operations.recordOutcome('op-comment', { status: 'Succeeded', at: T0, operationRef: 'ENG-42' }));

    // The effect's own delivery did not complete even though the operation settled.
    expectOk(outbox.markAttempt('effect-comment', T0));
    expectOk(
      outbox.markFailed('effect-comment', { category: 'TransientProvider', detail: 'The provider returned 503.' }, T0),
    );

    const entry = pending
      .pendingReconciliation(WELL_PAST)
      .find((candidate) => candidate.operationId === 'op-comment');
    assert.ok(entry, 'an incomplete sync attempt is still a reconciliation question');
    assert.equal(entry.unknown, 'The provider returned 503.');
    assert.equal(entry.unresolvedSince, T0);
  });
});

test('a recorded resolution is a fact with an actor, and it settles the ledger to match (F28-AC4, N01-AC2)', async () => {
  await withDatabase(async ({ connection, operations, pending }) => {
    intent(operations, 'op-publish', 'PublishIssue', 'idea-9/ticket', [ref('ENG-99')]);
    expectOk(operations.recordOutcome('op-publish', { status: 'OutcomeUnknown', at: T0, detail: 'Timed out.' }));

    const recorded = expectOk(
      pending.recordResolution('op-publish', {
        resolution: 'Applied',
        providerIdentity: 'ENG-99',
        detail: 'The issue exists in the team with the agreed title.',
        resolvedBy: 'owner@example.test',
        resolvedAt: LATER,
        correlationId: 'correlation-2',
      }),
    );
    assert.equal(recorded.resolution, 'Applied');
    assert.equal(recorded.providerIdentity, 'ENG-99');
    assert.equal(recorded.resolvedBy, 'owner@example.test');
    assert.equal(recorded.resolvedAt, LATER);
    assert.equal(recorded.operationId, 'op-publish');

    const ledger = operations.findByOperation('op-publish');
    assert.equal(ledger?.status, 'Succeeded', 'the ledger and the resolution agree');
    assert.equal(ledger?.operationRef, 'ENG-99');
    assert.deepEqual(
      pending.pendingReconciliation(WELL_PAST).map((entry) => entry.operationId),
      [],
      'a reconciled write leaves the worklist',
    );

    assert.throws(
      () =>
        connection
          .prepare('UPDATE reconciliation_resolutions SET resolution = ? WHERE reconciliation_resolution_id = ?')
          .run('NotApplied', recorded.reconciliationResolutionId),
      /reconciliation_resolutions is append-only/,
      'what was established about a lost response cannot be edited',
    );
    assert.throws(
      () =>
        connection
          .prepare('DELETE FROM reconciliation_resolutions WHERE reconciliation_resolution_id = ?')
          .run(recorded.reconciliationResolutionId),
      /retained: what was established about a lost response is a fact/,
    );
  });
});

test('an operation may only be recorded applied with the provider identity that proves it (F28-AC4, F10-AC3)', async () => {
  await withDatabase(async ({ connection, operations, pending }) => {
    intent(operations, 'op-release', 'Release', 'web/production', []);
    expectOk(operations.recordOutcome('op-release', { status: 'OutcomeUnknown', at: T0, detail: 'Timed out.' }));

    assert.throws(
      () =>
        connection
          .prepare(
            `INSERT INTO reconciliation_resolutions
               (reconciliation_resolution_id, operation_id, resolution, resolved_by, resolved_at)
             VALUES ('r-1', 'op-release', 'Applied', 'owner@example.test', ?)`,
          )
          .run(LATER),
      /CHECK constraint failed/,
      'the schema refuses an unevidenced claim that an external write happened',
    );
    const refused = expectError(
      pending.recordResolution('op-release', {
        resolution: 'Applied',
        providerIdentity: '   ',
        detail: null,
        resolvedBy: 'owner@example.test',
        resolvedAt: LATER,
        correlationId: null,
      }),
      'Invalid',
    );
    assert.match(refused.reason, /provider identity that proves it/);
  });
});

test('a resolution naming nobody is refused (F32-AC1)', async () => {
  await withDatabase(async ({ operations, pending }) => {
    intent(operations, 'op-anon', 'Merge', 'main', []);
    expectOk(operations.recordOutcome('op-anon', { status: 'OutcomeUnknown', at: T0, detail: 'Timed out.' }));
    const refused = expectError(
      pending.recordResolution('op-anon', {
        resolution: 'NotApplied',
        detail: 'The branch does not exist.',
        resolvedBy: '  ',
        resolvedAt: LATER,
        correlationId: null,
      }),
      'Invalid',
    );
    assert.match(refused.reason, /must name who established it/);
  });
});

test('a resolution for an operation that does not exist is refused (F30-AC5)', async () => {
  await withDatabase(async ({ pending }) => {
    const refused = expectError(
      pending.recordResolution('op-never', {
        resolution: 'NotApplied',
        detail: 'Nothing was ever sent.',
        resolvedBy: 'owner@example.test',
        resolvedAt: LATER,
        correlationId: null,
      }),
      'NotFound',
    );
    assert.match(refused.reason, /Operation op-never does not exist/);
  });
});

test('an applied operation cannot be walked back, and a provider refusal cannot become a success (F10-AC3)', async () => {
  await withDatabase(async ({ operations, pending }) => {
    intent(operations, 'op-done', 'CreateBranch', 'feature-x', []);
    expectOk(operations.recordOutcome('op-done', { status: 'Succeeded', at: T0, operationRef: 'branch-1' }));
    const walkedBack = expectError(
      pending.recordResolution('op-done', {
        resolution: 'NotApplied',
        detail: 'Someone changed their mind.',
        resolvedBy: 'owner@example.test',
        resolvedAt: LATER,
        correlationId: null,
      }),
      'Conflict',
    );
    assert.match(walkedBack.reason, /already recorded as applied/);

    intent(operations, 'op-refused', 'Deploy', 'preview', []);
    expectOk(operations.recordOutcome('op-refused', { status: 'Failed', at: T0, detail: 'Bad credentials.' }));
    const promoted = expectError(
      pending.recordResolution('op-refused', {
        resolution: 'Applied',
        providerIdentity: 'dep-1',
        detail: null,
        resolvedBy: 'owner@example.test',
        resolvedAt: LATER,
        correlationId: null,
      }),
      'Conflict',
    );
    assert.match(promoted.reason, /refused by the provider/);
  });
});

test('recording that the write did not happen is a definite answer, and a retry becomes safe (F28-AC4, F10-AC3)', async () => {
  await withDatabase(async ({ operations, pending }) => {
    intent(operations, 'op-lost', 'PublishIssue', 'idea-9/ticket', [ref('ENG-99')]);
    expectOk(operations.recordOutcome('op-lost', { status: 'OutcomeUnknown', at: T0, detail: 'Timed out.' }));

    const before = expectOk(pending.retryDecision('op-lost', LATER));
    assert.equal(before.permitted, false);
    assert.equal(before.basis, 'OutcomeUnknown');

    expectOk(
      pending.recordResolution('op-lost', {
        resolution: 'NotApplied',
        detail: 'No issue exists in the team for this title.',
        resolvedBy: 'owner@example.test',
        resolvedAt: LATER,
        correlationId: null,
      }),
    );
    const after = expectOk(pending.retryDecision('op-lost', LATER));
    assert.equal(after.permitted, true, 'a write that provably never happened may be issued again');
    assert.equal(after.basis, 'DefiniteNotApplied');
  });
});

test('while the outcome is unknown, a retry is refused and the provider is never reached twice (F28-AC4, F10-AC3, N01-AC2)', async () => {
  await withDatabase(async ({ operations, pending }) => {
    const expected = [ref('ENG-99')];
    intent(operations, 'op-publish', 'PublishIssue', 'idea-9/ticket', expected);
    expectOk(operations.recordOutcome('op-publish', { status: 'OutcomeUnknown', at: T0, detail: 'Timed out.' }));

    // The controller's actual gate, asked once per attempt. Every refusal is counted.
    let writes = 0;
    const attempt = (now: string): void => {
      const gate = operations.assertWritable('op-publish', now);
      if (!gate.ok) return;
      writes += 1;
    };
    attempt(LATER);
    assert.equal(writes, 0, 'an unresolved write is not issued again');

    const decision = expectOk(pending.retryDecision('op-publish', LATER));
    assert.equal(decision.permitted, false);
    if (!decision.permitted) assert.equal(decision.basis, 'OutcomeUnknown');

    attempt(WELL_PAST);
    assert.equal(writes, 0, 'nor later, when it is even less likely to be in flight');

    // Only an established result opens the gate.
    expectOk(
      pending.recordResolution('op-publish', {
        resolution: 'Applied',
        providerIdentity: 'ENG-99',
        detail: 'Reconciled against the team.',
        resolvedBy: 'owner@example.test',
        resolvedAt: LATER,
        correlationId: null,
      }),
    );
    attempt(WELL_PAST);
    assert.equal(writes, 0, 'an applied write is done, so a second one would be a duplicate');
    const settled = expectOk(pending.retryDecision('op-publish', WELL_PAST));
    assert.equal(settled.permitted, false);
    if (!settled.permitted) {
      assert.equal(settled.basis, 'AlreadyApplied');
      assert.equal(settled.providerIdentity, 'ENG-99');
    }
  });
});

test('a resolution that could not establish the result leaves the operation exactly as blocked (F28-AC4)', async () => {
  await withDatabase(async ({ operations, pending }) => {
    intent(operations, 'op-ambiguous', 'Release', 'web/production', []);
    expectOk(operations.recordOutcome('op-ambiguous', { status: 'OutcomeUnknown', at: T0, detail: 'Timed out.' }));

    expectOk(
      pending.recordResolution('op-ambiguous', {
        resolution: 'StillUnknown',
        detail: 'The provider status endpoint is also unavailable.',
        resolvedBy: 'owner@example.test',
        resolvedAt: LATER,
        correlationId: null,
      }),
    );

    const decision = expectOk(pending.retryDecision('op-ambiguous', LATER));
    assert.equal(decision.permitted, false, 'a second look that learned nothing is not a licence to write');
    if (!decision.permitted) assert.equal(decision.basis, 'UnresolvedResolution');
    assert.equal(operations.findByOperation('op-ambiguous')?.status, 'OutcomeUnknown');

    const entry = pending.pendingReconciliation(WELL_PAST).find((row) => row.operationId === 'op-ambiguous');
    assert.ok(entry, 'it stays on the worklist for another attempt at reconciliation');
    assert.equal(
      entry.unknown,
      'The provider status endpoint is also unavailable.',
      'the latest reason for the doubt is the one shown',
    );
    const resolutions = expectOk(pending.listResolutions('op-ambiguous'));
    assert.deepEqual(
      resolutions.map((row) => row.resolution),
      ['StillUnknown'],
      'the attempt at reconciliation is itself recorded',
    );
  });
});

test('a fresh intent may be issued, and a stale one may not (F28-AC4, N01-AC2)', async () => {
  await withDatabase(async ({ operations, pending }) => {
    intent(operations, 'op-fresh', 'CreateBranch', 'feature-y', []);

    const fresh = expectOk(pending.retryDecision('op-fresh', minutes(30_000)));
    assert.equal(fresh.permitted, true, 'its own in-flight attempt is allowed');
    assert.equal(fresh.basis, 'StillInFlight');

    const stale = expectOk(pending.retryDecision('op-fresh', minutes(120_000)));
    assert.equal(stale.permitted, false, 'past the bound the process may have died mid-write');
    if (!stale.permitted) assert.equal(stale.basis, 'StaleIntent');
  });
});

test('a provider refusal permits a retry immediately, and an unknown operation is not found (F28-AC4)', async () => {
  await withDatabase(async ({ operations, pending }) => {
    intent(operations, 'op-refused', 'Merge', 'main', []);
    expectOk(operations.recordOutcome('op-refused', { status: 'Failed', at: T0, detail: 'Conflict.' }));
    const decision = expectOk(pending.retryDecision('op-refused', LATER));
    assert.equal(decision.permitted, true);
    assert.equal(decision.basis, 'DefiniteNotApplied');

    const missing = expectError(pending.retryDecision('op-absent', LATER), 'NotFound');
    assert.match(missing.reason, /Operation op-absent does not exist/);
  });
});

test('a failed external update is labelled Pending sync with its last success time and retry status (F16-AC4)', async () => {
  await withDatabase(async ({ connection, workItemId, operations, outbox, pending }) => {
    intent(operations, 'op-progress', 'ProgressComment', 'ENG-42', [ref('ENG-42')]);
    expectOk(operations.recordOutcome('op-progress', { status: 'Succeeded', at: T0, operationRef: 'ENG-42' }));
    expectOk(
      withTransaction(connection, () =>
        outbox.enqueue({
          effectId: 'effect-1',
          dedupKey: 'ProgressComment:ENG-42',
          kind: 'ProgressComment',
          target: 'ENG-42',
          payload: '{}',
          correlationId: 'correlation-1',
          operationId: 'op-progress',
          expectedRefs: [ref('ENG-42')],
          at: T0,
        }),
      ),
    );
    expectOk(new WorkItemRepository(connection).recordPublication(workItemId, 'Published', 'op-progress', T0));
    expectOk(outbox.markAttempt('effect-1', T0));
    expectOk(
      outbox.markFailed('effect-1', { category: 'TransientProvider', detail: 'The provider returned 503.' }, T0),
    );

    // The per-work-item label is written by the real repository, not by a fixture
    // INSERT, so the view under test reads a row the product would have written.
    expectOk(
      new WorkItemRepository(connection).recordSyncResult({
        workItemId,
        attemptedAt: T0,
        succeeded: false,
        error: 'The provider returned 503.',
      }),
    );

    const view = expectOk(pending.pendingSyncStatus(workItemId));
    assert.equal(view.workItem?.state, 'PendingSync', 'the label the owner reads');
    assert.equal(view.workItem?.lastSuccessAt, null, 'nothing has succeeded yet');
    assert.equal(view.workItem?.attemptCount, 1);
    assert.equal(view.workItem?.lastError, 'The provider returned 503.');

    assert.equal(view.updates.length, 1);
    const update = view.updates[0];
    assert.ok(update);
    assert.equal(update.effectId, 'effect-1');
    assert.equal(update.operationId, 'op-progress');
    assert.equal(update.label, 'PendingSync');
    assert.equal(update.lastSuccessAt, null);
    assert.equal(update.attemptCount, 1);
    assert.equal(update.lastFailureCategory, 'TransientProvider');
    assert.equal(update.lastFailureDetail, 'The provider returned 503.');
  });
});

test('a partial publication names what is unpublished and keeps the mappings that succeeded (F10-AC2, F10-AC5)', async () => {
  await withDatabase(async ({ connection, workItemId, operations, outbox, pending }) => {
    const first = ref('ENG-42');
    const second = ref('ENG-43');
    intent(operations, 'op-batch', 'PublishIssue', 'idea-9/tickets', [first, second]);
    expectOk(operations.recordOutcome('op-batch', { status: 'Succeeded', at: T0, operationRef: 'ENG-42' }));
    expectOk(
      withTransaction(connection, () =>
        outbox.enqueue({
          effectId: 'effect-batch',
          dedupKey: 'PublishIssue:idea-9',
          kind: 'PublishIssue',
          target: 'idea-9/tickets',
          payload: '{}',
          correlationId: 'correlation-1',
          operationId: 'op-batch',
          expectedRefs: [first, second],
          at: T0,
        }),
      ),
    );
    expectOk(new WorkItemRepository(connection).recordPublication(workItemId, 'Published', 'op-batch', T0));
    expectOk(outbox.markAttempt('effect-batch', T0));
    // Only the first ticket is created before the batch fails.
    const partial = expectOk(outbox.markSucceeded('effect-batch', { at: T0, refs: [first] }));
    assert.equal(partial.status, 'PendingSync', 'an incomplete publication stays Pending sync');

    const view = expectOk(pending.pendingSyncStatus(workItemId));
    const update = view.updates.find((entry) => entry.effectId === 'effect-batch');
    assert.ok(update);
    assert.equal(update.label, 'PendingSync');
    assert.equal(update.lastSuccessAt, T0, 'the time something did succeed is kept');
    assert.deepEqual(
      update.succeededRefs.map((entry) => entry.id),
      ['ENG-42'],
      'the mapping that succeeded is retained',
    );
    assert.deepEqual(
      update.unpublishedRefs.map((entry) => entry.id),
      ['ENG-43'],
      'and what is still unpublished is named',
    );
  });
});

test('a fully published update is labelled In sync and publishes nothing as outstanding (F10-AC2)', async () => {
  await withDatabase(async ({ connection, workItemId, operations, outbox, pending }) => {
    const only = ref('ENG-42');
    intent(operations, 'op-single', 'PublishIssue', 'idea-8/ticket', [only]);
    expectOk(operations.recordOutcome('op-single', { status: 'Succeeded', at: T0, operationRef: 'ENG-42' }));
    expectOk(
      withTransaction(connection, () =>
        outbox.enqueue({
          effectId: 'effect-single',
          dedupKey: 'PublishIssue:idea-8',
          kind: 'PublishIssue',
          target: 'idea-8/ticket',
          payload: '{}',
          correlationId: 'correlation-1',
          operationId: 'op-single',
          expectedRefs: [only],
          at: T0,
        }),
      ),
    );
    expectOk(new WorkItemRepository(connection).recordPublication(workItemId, 'Published', 'op-single', T0));
    expectOk(outbox.markSucceeded('effect-single', { at: T0, refs: [only] }));

    const update = expectOk(pending.pendingSyncStatus(workItemId)).updates[0];
    assert.ok(update);
    assert.equal(update.label, 'InSync');
    assert.deepEqual(update.unpublishedRefs, []);
  });
});

test('an update whose response was lost is labelled by its stronger state, not Pending sync (F16-AC4, F30-AC5)', async () => {
  await withDatabase(async ({ connection, workItemId, operations, outbox, pending }) => {
    const only = ref('ENG-42');
    intent(operations, 'op-lost', 'ProgressComment', 'ENG-42', [only]);
    expectOk(operations.recordOutcome('op-lost', { status: 'Succeeded', at: T0, operationRef: 'ENG-42' }));
    expectOk(
      withTransaction(connection, () =>
        outbox.enqueue({
          effectId: 'effect-lost',
          dedupKey: 'ProgressComment:ENG-42:lost',
          kind: 'ProgressComment',
          target: 'ENG-42',
          payload: '{}',
          correlationId: 'correlation-1',
          operationId: 'op-lost',
          expectedRefs: [only],
          at: T0,
        }),
      ),
    );
    expectOk(new WorkItemRepository(connection).recordPublication(workItemId, 'Published', 'op-lost', T0));
    expectOk(outbox.markOutcomeUnknown('effect-lost', 'The response was lost.', T0));

    const update = expectOk(pending.pendingSyncStatus(workItemId)).updates[0];
    assert.ok(update);
    assert.equal(
      update.label,
      'OutcomeUnknown',
      'a lost response is not a retryable pending update; it is waiting for reconciliation',
    );
  });
});

test('an update bound to its work item directly is found without a publication operation (F16-AC4)', async () => {
  await withDatabase(async ({ connection, workItemId, operations, outbox, pending }) => {
    intent(operations, 'op-standalone', 'ProgressComment', 'ENG-42', [ref('ENG-42')]);
    expectOk(operations.recordOutcome('op-standalone', { status: 'Succeeded', at: T0, operationRef: 'ENG-42' }));
    expectOk(
      withTransaction(connection, () =>
        outbox.enqueue({
          effectId: 'effect-standalone',
          dedupKey: 'ProgressComment:ENG-42:standalone',
          kind: 'ProgressComment',
          target: 'ENG-42',
          payload: '{}',
          correlationId: 'correlation-1',
          operationId: 'op-standalone',
          expectedRefs: [ref('ENG-42')],
          at: T0,
        }),
      ),
    );
    // The schema's own work-item link, bound the way a controller that knows the work
    // item binds it. Nothing in the event stores does this yet, so the query is
    // written to use the column as soon as something does.
    connection
      .prepare('UPDATE outbox_events SET work_item_id = ? WHERE outbox_event_id = ?')
      .run(workItemId, 'effect-standalone');
    expectOk(outbox.markAttempt('effect-standalone', T0));
    expectOk(
      outbox.markFailed('effect-standalone', { category: 'TransientProvider', detail: '503' }, T0),
    );

    const view = expectOk(pending.pendingSyncStatus(workItemId));
    assert.equal(view.updates.length, 1);
    assert.equal(view.updates[0]?.effectId, 'effect-standalone');
    assert.equal(view.updates[0]?.label, 'PendingSync');
  });
});

test('a work item with no sync state and no updates reads as nothing rather than failing (F16-AC4)', async () => {
  await withDatabase(async ({ workItemId, pending }) => {
    // The work item exists, but nothing has ever been synced to it, so the view is
    // empty rather than a row of nulls a caller has to interpret.
    const view = expectOk(pending.pendingSyncStatus(workItemId));
    assert.equal(view.workItem, null);
    assert.deepEqual(view.updates, []);
  });
});
