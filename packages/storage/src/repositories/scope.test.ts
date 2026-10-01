/**
 * Behavioural proof for scope capture, diffing and owner reconciliation.
 *
 * Every test runs against the REAL migrated schema: a temporary SQLite file is opened
 * with `openDatabase`, `migrate` builds the production tables in it, and the
 * repositories are driven against that. A file rather than `:memory:` because the
 * properties under test are durability properties: snapshots that must survive a close,
 * triggers that must still abort an in-place edit after the newest migration ran, and a
 * ledger row that must be a fact rather than a mutable label.
 *
 * The fixture is seeded with the parents the foreign keys require, and nothing else.
 * Every snapshot in these tests is written through `ScopeRepository.capture`, so the
 * row shapes under test are the ones the product writes.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprint, scopeFingerprint } from '@shiploop/domain';
import type {
  DomainError,
  Fingerprint,
  ProfileVersionId,
  ProjectId,
  Result,
  ScopeComparison,
  ScopeReconciliation,
  ScopeSnapshot,
  WorkItemId,
} from '@shiploop/domain';
import { openDatabase, type Database } from '../db.ts';
import {
  appliedMigrations,
  LATEST_SCHEMA_VERSION,
  migrate,
  migrationDefinitions,
} from '../migrations.ts';
import { withTransaction } from '../tx.ts';
import { WorkItemRepository } from './core.ts';
import { ScopeRepository } from './scope.ts';
import type { ExternalRef } from '../events/types.ts';
import type { AppendScopeSnapshotInput } from './types.ts';

const PROJECT = '5c0a1f22-0000-4000-8000-00000000000a' as ProjectId;
const PROFILE_VERSION = '5c0a1f22-0000-4000-8000-00000000000b' as ProfileVersionId;
const PROCEDURE_VERSION = '5c0a1f22-0000-4000-8000-00000000000c';
const OWNER = '5c0a1f22-0000-4000-8000-00000000000d';
const T0 = '2026-03-01T09:00:00.000Z';
const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-01T11:00:00.000Z';

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

/** The scope a run starts from. Every field is real content, not a placeholder. */
function liveScope(overrides: Partial<ScopeSnapshot> = {}): ScopeSnapshot {
  return {
    workItemId: 'work-item-1' as WorkItemId,
    issueId: 'issue-42',
    issueIdentifier: 'ENG-42',
    title: 'Publish the run summary',
    description: 'Publish a managed summary comment on the linked issue.',
    providerRevision: 'rev-1',
    priority: 'High',
    dependencyIssueIds: ['issue-7'],
    acceptanceCriteria: [
      { id: 'ac-1', text: 'The summary names the candidate fingerprint.' },
      { id: 'ac-2', text: 'Republishing does not duplicate the comment.' },
    ],
    retrievedAt: T0,
    ...overrides,
  };
}

function captureInput(
  workItemId: WorkItemId,
  scope: ScopeSnapshot,
  overrides: Partial<AppendScopeSnapshotInput> = {},
): AppendScopeSnapshotInput {
  return {
    scope: { ...scope, workItemId },
    attemptId: null,
    profileVersionId: PROFILE_VERSION,
    procedureVersionId: PROCEDURE_VERSION,
    capturedAt: T0,
    correlationId: 'correlation-1',
    ...overrides,
  };
}

function ref(id: string, kind = 'Issue'): ExternalRef {
  return { id, kind, url: `https://linear.test/${id}` };
}

interface Harness {
  readonly connection: Database;
  readonly workItems: WorkItemRepository;
  readonly scope: ScopeRepository;
  readonly workItemId: WorkItemId;
  readonly close: () => Promise<void>;
}

async function withDatabase(run: (context: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-scope-'));
  const opened = openDatabase(join(directory, 'scope.sqlite'));
  assert.ok(opened.ok, `the database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
  const connection: Database = opened.value;
  try {
    const migrated = migrate(connection);
    assert.ok(migrated.ok, `the schema could not be migrated: ${migrated.ok ? '' : migrated.error.reason}`);
    seedParents(connection);
    const workItems = new WorkItemRepository(connection);
    const workItemId = expectOk(
      workItems.create({
        projectId: PROJECT,
        profileVersionId: PROFILE_VERSION,
        source: 'ProposedNewIssue',
        title: 'Publish the run summary',
        externalIssueId: 'issue-42',
        externalIssueIdentifier: 'ENG-42',
        externalIssueUrl: 'https://linear.test/ENG-42',
        publicationIntent: 'PublishWhenAgreed',
        relatedWorkItemIds: [],
        adoption: null,
        at: T0,
      }),
    ).workItemId;
    await run({
      connection,
      workItems,
      scope: new ScopeRepository(connection),
      workItemId,
      close: async () => {
        connection.close();
      },
    });
  } finally {
    connection.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** The rows the scope tables' foreign keys require, and nothing more. */
function seedParents(connection: Database): void {
  connection
    .prepare('INSERT INTO owners (owner_id, display_name, created_at) VALUES (?, ?, ?)')
    .run(OWNER, 'Solo owner', T0);
  connection
    .prepare('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)')
    .run(PROJECT, 'Scope project', T0);
  connection
    .prepare(
      `INSERT INTO project_profile_versions (profile_version_id, project_id, version, content_json, content_fingerprint, created_by, created_at)
       VALUES (?, ?, 1, '{}', ?, ?, ?)`,
    )
    .run(PROFILE_VERSION, PROJECT, fingerprint({ profile: 'scope' }), OWNER, T0);
  connection
    .prepare(
      `INSERT INTO procedure_versions (procedure_version_id, project_id, version, kind, source, content_json, content_fingerprint, created_by, created_at)
       VALUES (?, ?, 1, 'Procedure', 'Owner', '{}', ?, ?, ?)`,
    )
    .run(PROCEDURE_VERSION, PROJECT, fingerprint({ procedure: 'scope' }), OWNER, T0);
}

/**
 * An external operation and the outbox effect that carries it.
 *
 * Written directly because the discrepancy's foreign keys to both are real, and a
 * discrepancy that could name an effect that does not exist would be a reference
 * nothing can resolve. The outbox lifecycle itself is proven in
 * `reconciliation/pending.test.ts`.
 */
function seedExternalEffect(connection: Database, operationId: string, effectId: string): void {
  connection
    .prepare(
      `INSERT INTO external_operations
         (operation_id, project_id, work_item_id, kind, target_identity, expected_refs, state, status,
          correlation_id, requested_at, recorded_at, updated_at)
       VALUES (?, ?, NULL, 'ProgressComment', ?, '[]', 'InFlight', 'IntentRecorded', ?, ?, ?, ?)`,
    )
    .run(operationId, PROJECT, `issue-42/${operationId}`, 'correlation-1', T0, T0, T0);
  connection
    .prepare(
      `INSERT INTO outbox_events
         (outbox_event_id, project_id, event_kind, kind, target, dedup_key, payload_json, payload,
          correlation_id, operation_id, state, status, attempt_count, next_attempt_at,
          last_failure_category, expected_refs, succeeded_refs, created_at)
       VALUES (?, ?, 'ProgressComment', 'ProgressComment', ?, ?, '{}', '{}', ?, ?, 'Pending', 'PendingSync',
               0, ?, 'None', '[]', '[]', ?)`,
    )
    .run(effectId, PROJECT, `issue-42/${effectId}`, effectId, 'correlation-1', operationId, T0, T0);
}

function materialReconciliation(  comparison: ScopeComparison,
  choice: ScopeReconciliation['choice'],
  decidedAt = T1,
): ScopeReconciliation {
  return {
    choice,
    followUpNote: null,
    decidedBy: 'owner@example.test',
    decidedAt,
    comparison,
  };
}

test('a capture persists the content, the semantic fingerprint, the retrieval time and the selected versions (F12-AC1)', async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    const scope0 = liveScope({ workItemId });
    const captured = expectOk(scope.capture(captureInput(workItemId, scope0)));

    assert.equal(captured.workItemId, workItemId);
    assert.equal(captured.issueId, 'issue-42');
    assert.equal(captured.issueIdentifier, 'ENG-42');
    assert.equal(captured.title, 'Publish the run summary');
    assert.equal(captured.description, scope0.description);
    assert.equal(captured.providerRevision, 'rev-1');
    assert.equal(captured.priority, 'High');
    assert.deepEqual(captured.dependencyIssueIds, ['issue-7']);
    assert.deepEqual(
      captured.acceptanceCriteria.map((criterion) => criterion.id),
      ['ac-1', 'ac-2'],
    );
    assert.equal(captured.retrievedAt, T0, 'the retrieval time is part of the snapshot');
    assert.equal(captured.capturedAt, T0, 'the capture time is part of the snapshot');
    assert.equal(captured.profileVersionId, PROFILE_VERSION);
    assert.equal(captured.procedureVersionId, PROCEDURE_VERSION);
    assert.equal(captured.sequenceNumber, 1);
    assert.equal(captured.attemptId, null);

    // The fingerprint is the domain's, not the caller's and not a digest of the row.
    assert.equal(captured.scopeFingerprint, scopeFingerprint(scope0));
    assert.equal(captured.scopeFingerprint, expectOk(scope.compareStoredToLive(workItemId, scope0)).recordedFingerprint);
  });
});

test('the criteria and dependency rows carry the same facts as the JSON columns (F12-AC1)', async () => {
  await withDatabase(async ({ connection, scope, workItemId }) => {
    const captured = expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));

    const criteria = connection
      .prepare('SELECT criterion_id, text FROM scope_snapshot_criteria WHERE scope_snapshot_id = ? ORDER BY criterion_id')
      .all(captured.scopeSnapshotId);
    assert.deepEqual(
      criteria.map((row) => [row['criterion_id'], row['text']]),
      [
        ['ac-1', 'The summary names the candidate fingerprint.'],
        ['ac-2', 'Republishing does not duplicate the comment.'],
      ],
      'each criterion has its own row under its own stable id',
    );
    const dependencies = connection
      .prepare('SELECT dependency_issue_id FROM scope_snapshot_dependencies WHERE scope_snapshot_id = ?')
      .all(captured.scopeSnapshotId);
    assert.deepEqual(
      dependencies.map((row) => row['dependency_issue_id']),
      ['issue-7'],
    );
  });
});

test('a duplicate criterion id is refused rather than collapsed, so the two representations cannot disagree (F12-AC1)', async () => {
  await withDatabase(async ({ connection, scope, workItemId }) => {
    const duplicated = liveScope({
      workItemId,
      acceptanceCriteria: [
        { id: 'ac-1', text: 'First.' },
        { id: 'ac-1', text: 'Second.' },
      ],
    });
    const refused = expectError(scope.capture(captureInput(workItemId, duplicated)), 'Invalid');
    assert.match(refused.reason, /same acceptance criterion twice/);
    const rows = connection.prepare('SELECT COUNT(*) AS total FROM scope_snapshots').all();
    assert.equal(rows[0]?.['total'], 0, 'a refused capture writes no snapshot at all');
  });
});

/**
 * A database left at version 8, exactly as that build left it.
 *
 * The definitions up to `upToVersion` are replayed one per transaction, and the
 * bookkeeping records - checksums included - are copied from a database this same
 * runner migrated, so the reconciliation path under test is the real one.
 */
async function withDatabaseAtVersion(
  upToVersion: number,
  run: (connection: Database) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-scope-upgrade-'));
  try {
    const history: Record<string, unknown>[] = [];
    const reference = openDatabase(join(directory, 'reference.sqlite'));
    assert.ok(reference.ok, 'the reference database opened');
    try {
      const migrated = expectOk(migrate(reference.value));
      assert.ok(
        migrated.applied.length >= upToVersion,
        'the reference database reached the version this fixture needs',
      );
      for (const record of expectOk(appliedMigrations(reference.value))) {
        if (record.version > upToVersion) break;
        history.push({
          version: record.version,
          name: record.name,
          applied_at: record.appliedAt,
          checksum: record.checksum,
        });
      }
      const older = openDatabase(join(directory, 'older.sqlite'));
      assert.ok(older.ok, 'the older database opened');
      try {
        // The DDL comes from the reference database, so the fixture cannot drift from
        // what `migrate` bootstraps.
        const bootstrap = reference.value.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        );
        const bookkeeping = bootstrap.get();
        const bookkeepingDdl = bookkeeping?.['sql'];
        assert.equal(typeof bookkeepingDdl, 'string', 'the bookkeeping DDL is the one migrate bootstraps');
        older.value.exec(String(bookkeepingDdl));
        const referenceRows = reference.value
          .prepare('SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version')
          .all();
        const record = older.value.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
        );
        for (const row of referenceRows) {
          const version = row['version'];
          if (typeof version !== 'number' || version > upToVersion) continue;
          record.run(
            version,
            String(row['name']),
            String(row['applied_at']),
            String(row['checksum']),
          );
        }
        for (const definition of migrationDefinitions) {
          if (definition.version > upToVersion) break;
          withTransaction(older.value, () => definition.up(older.value));
        }
        assert.equal(history.length, upToVersion);
        await run(older.value);
      } finally {
        older.value.close();
      }
    } finally {
      reference.value.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a database at version 8 with a stored snapshot upgrades to the current version without losing it (N08-AC3, F12-AC1)', async () => {
  const ALIGNMENT_FROM = 8;
  await withDatabaseAtVersion(ALIGNMENT_FROM, async (connection) => {
    seedParents(connection);
    connection
      .prepare(
        `INSERT INTO work_items (work_item_id, project_id, issue_id, publication_intent, origin, source, profile_version_id, created_at)
         VALUES ('work-item-legacy', ?, 'issue-legacy', 'PublishWhenAgreed', 'Proposed', 'ProposedNewIssue', ?, ?)`,
      )
      .run(PROJECT, PROFILE_VERSION, T0);
    const legacyFingerprint = fingerprint({ scope: 'legacy' });
    connection
      .prepare(
        `INSERT INTO scope_snapshots (scope_snapshot_id, work_item_id, project_id, issue_id, description,
                                       scope_fingerprint, retrieved_at, profile_version_id, procedure_version_id)
         VALUES ('snap-legacy', 'work-item-legacy', ?, 'issue-legacy', 'Legacy scope', ?, ?, ?, ?)`,
      )
      .run(PROJECT, legacyFingerprint, T0, PROFILE_VERSION, PROCEDURE_VERSION);

    const report = expectOk(migrate(connection));
    assert.equal(report.fromVersion, ALIGNMENT_FROM);
    assert.equal(report.toVersion, LATEST_SCHEMA_VERSION);
    assert.ok(
      report.applied.some((step) => step.name === 'scope_capture_and_reconciliation'),
      'the alignment ran against these rows',
    );

    const stored = connection
      .prepare('SELECT * FROM scope_snapshots WHERE scope_snapshot_id = ?')
      .get('snap-legacy');
    assert.ok(stored, 'the snapshot survived the rebuild');
    assert.equal(stored['scope_fingerprint'], legacyFingerprint, 'its fingerprint is unchanged');
    assert.equal(stored['description'], 'Legacy scope');
    assert.equal(stored['issue_identifier'], '', 'a column the row never had is now a stated absence');
    assert.equal(stored['acceptance_criteria'], '[]');
    assert.equal(
      stored['captured_at'],
      stored['created_at'],
      'a row written before the capture time existed falls back to when it was written, not to an empty value',
    );
  });
});

test('a snapshot cannot be edited or deleted in place after the newest migration ran (F12-AC1)', async () => {
  await withDatabase(async ({ connection, scope, workItemId }) => {
    const captured = expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));

    assert.throws(
      () =>
        connection
          .prepare('UPDATE scope_snapshots SET description = ? WHERE scope_snapshot_id = ?')
          .run('A silently rewritten description.', captured.scopeSnapshotId),
      /scope_snapshots are immutable/,
      'the append-only trigger still aborts an in-place edit',
    );
    assert.throws(
      () => connection.prepare('DELETE FROM scope_snapshots WHERE scope_snapshot_id = ?').run(captured.scopeSnapshotId),
      /scope_snapshots are immutable/,
      'the append-only trigger still aborts a delete',
    );

    const stored = connection
      .prepare('SELECT description FROM scope_snapshots WHERE scope_snapshot_id = ?')
      .get(captured.scopeSnapshotId);
    assert.equal(stored?.['description'], 'Publish a managed summary comment on the linked issue.');
  });
});

test('a second capture of identical content is a new row with the same fingerprint (F12-AC1, F12-AC3)', async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    const first = expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));
    const second = expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }), { capturedAt: T1 })));

    assert.notEqual(second.scopeSnapshotId, first.scopeSnapshotId, 'append-only means a new row, not an edit');
    assert.equal(second.sequenceNumber, 2);
    assert.equal(
      second.scopeFingerprint,
      first.scopeFingerprint,
      'identical material content has one semantic fingerprint however often it is captured',
    );
    assert.equal(second.capturedAt, T1, 'the second capture carries its own time');
  });
});

test('a criteria edit is Material and blocks acceptance until the owner reconciles it (F12-AC2)', async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));

    const changed = liveScope({
      workItemId,
      providerRevision: 'rev-2',
      acceptanceCriteria: [
        { id: 'ac-1', text: 'The summary names the candidate fingerprint.' },
        { id: 'ac-2', text: 'Republishing does not duplicate the comment.' },
        { id: 'ac-3', text: 'The comment links the evidence bundle.' },
      ],
      retrievedAt: T1,
    });
    const comparison = expectOk(scope.compareStoredToLive(workItemId, changed));
    assert.equal(comparison.kind, 'Material');
    assert.deepEqual(comparison.materialDifferences, ['criteria.added.ac-3']);
    assert.deepEqual(comparison.cosmeticDifferences, []);

    const detection = expectOk(
      scope.recordComparison({
        workItemId,
        comparison,
        observedAt: T1,
        providerRevision: 'rev-2',
        correlationId: 'correlation-1',
      }),
    );
    assert.equal(detection.changeKind, 'Material');
    assert.deepEqual(detection.materialDifferences, ['criteria.added.ac-3']);

    const blocking = expectOk(scope.unreconciledMaterialChange(workItemId));
    assert.equal(blocking?.scopeChangeDetectionId, detection.scopeChangeDetectionId);

    expectOk(scope.recordReconciliation(workItemId, materialReconciliation(comparison, 'KeepPendingClarification')));
    assert.equal(
      expectOk(scope.unreconciledMaterialChange(workItemId)),
      null,
      'a recorded owner choice lifts the block, whether it adopted the scope or kept it pending',
    );
  });
});

test('each material difference is named by its own criterion id, and a removed criterion is a difference too (F12-AC2)', async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));

    const edited = liveScope({
      workItemId,
      description: 'Publish a managed summary comment, and link the evidence.',
      acceptanceCriteria: [
        { id: 'ac-1', text: 'The summary names the candidate fingerprint and the evidence bundle.' },
      ],
      dependencyIssueIds: ['issue-7', 'issue-8'],
      retrievedAt: T1,
    });
    const comparison = expectOk(scope.compareStoredToLive(workItemId, edited));
    assert.equal(comparison.kind, 'Material');
    assert.deepEqual(
      [...comparison.materialDifferences].sort(),
      [
        'criteria.changed.ac-1',
        'criteria.removed.ac-2',
        'dependencies.added.issue-8',
        'description',
      ],
    );
  });
});

test('a title or priority edit alone is Cosmetic, renumbers nothing, and blocks nothing (F12-AC3)', async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    const captured = expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));

    const cosmetic = liveScope({
      workItemId,
      title: 'Publish the run summary (renamed)',
      priority: 'Urgent',
      providerRevision: 'rev-2',
      retrievedAt: T1,
    });
    const comparison = expectOk(scope.compareStoredToLive(workItemId, cosmetic));
    assert.equal(comparison.kind, 'Cosmetic');
    assert.deepEqual(comparison.materialDifferences, []);
    assert.deepEqual([...comparison.cosmeticDifferences].sort(), ['priority', 'title']);
    assert.equal(
      comparison.recordedFingerprint,
      comparison.currentFingerprint,
      'a cosmetic edit cannot change the semantic fingerprint, so a decision keyed on it still matches',
    );
    assert.equal(comparison.recordedFingerprint, captured.scopeFingerprint);

    const detection = expectOk(
      scope.recordComparison({ workItemId, comparison, observedAt: T1, providerRevision: 'rev-2', correlationId: null }),
    );
    assert.equal(detection.changeKind, 'Cosmetic');
    assert.deepEqual(
      detection.materialDifferences,
      [],
      'the criteria ids are untouched, so nothing was renumbered',
    );
    assert.equal(
      expectOk(scope.unreconciledMaterialChange(workItemId)),
      null,
      'a cosmetic edit never blocks acceptance or delivery',
    );
  });
});

test('repeating a check of the same live content records one difference, not a list of them (F12-AC2)', async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));
    const changed = liveScope({ workItemId, description: 'A different description entirely.', retrievedAt: T1 });
    const comparison = expectOk(scope.compareStoredToLive(workItemId, changed));

    const first = expectOk(
      scope.recordComparison({ workItemId, comparison, observedAt: T1, providerRevision: null, correlationId: null }),
    );
    const second = expectOk(
      scope.recordComparison({ workItemId, comparison, observedAt: T2, providerRevision: null, correlationId: null }),
    );
    assert.equal(second.scopeChangeDetectionId, first.scopeChangeDetectionId);
    assert.equal(second.observedAt, T1, 'the first observation time is the one kept');
  });
});

test("the owner's choice is recorded with its actor, time and note (F12-AC4)", async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    const captured = expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));
    const changed = liveScope({ workItemId, description: 'Ship the receipt in the comment too.', retrievedAt: T1 });
    const comparison = expectOk(scope.compareStoredToLive(workItemId, changed));
    const detection = expectOk(
      scope.recordComparison({ workItemId, comparison, observedAt: T1, providerRevision: 'rev-2', correlationId: null }),
    );

    const recorded = expectOk(
      scope.recordReconciliation(
        workItemId,
        {
          choice: 'ProposeFollowUpIssue',
          followUpNote: 'Receipt publication belongs in its own issue.',
          decidedBy: 'owner@example.test',
          decidedAt: T1,
          comparison,
        },
        'correlation-2',
      ),
    );
    assert.equal(recorded.choice, 'ProposeFollowUpIssue');
    assert.equal(recorded.followUpNote, 'Receipt publication belongs in its own issue.');
    assert.equal(recorded.decidedBy, 'owner@example.test');
    assert.equal(recorded.decidedAt, T1);
    assert.equal(recorded.correlationId, 'correlation-2');
    assert.equal(recorded.workItemId, workItemId);
    assert.equal(
      recorded.recordedSnapshotId,
      captured.scopeSnapshotId,
      'the decision names the snapshot whose belief it resolved',
    );
    assert.equal(
      recorded.scopeChangeDetectionId,
      detection.scopeChangeDetectionId,
      'the decision names the difference it was about',
    );

    const listed = expectOk(scope.listReconciliations(workItemId));
    assert.deepEqual(
      listed.map((entry) => [entry.choice, entry.decidedBy, entry.decidedAt]),
      [['ProposeFollowUpIssue', 'owner@example.test', T1]],
    );
  });
});

test('a cosmetic change cannot be reconciled, because there is nothing to decide (F12-AC3, F12-AC4)', async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));
    const cosmetic = liveScope({ workItemId, title: 'Renamed', retrievedAt: T1 });
    const comparison = expectOk(scope.compareStoredToLive(workItemId, cosmetic));
    const refused = expectError(
      scope.recordReconciliation(workItemId, materialReconciliation(comparison, 'AdoptRevisedScope')),
      'Invalid',
    );
    assert.match(refused.reason, /Only a material scope change can be reconciled/);
    assert.deepEqual(expectOk(scope.listReconciliations(workItemId)), []);
  });
});

test('the same difference may only be decided once, and a decision needs a recorded difference (F12-AC4)', async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));
    const changed = liveScope({ workItemId, description: 'A materially different description.', retrievedAt: T1 });
    const comparison = expectOk(scope.compareStoredToLive(workItemId, changed));

    const unrecorded = expectError(
      scope.recordReconciliation(workItemId, materialReconciliation(comparison, 'AdoptRevisedScope')),
      'Conflict',
    );
    assert.match(unrecorded.reason, /was never recorded as a difference/);

    expectOk(scope.recordComparison({ workItemId, comparison, observedAt: T1, providerRevision: null, correlationId: null }));
    expectOk(scope.recordReconciliation(workItemId, materialReconciliation(comparison, 'AdoptRevisedScope')));
    const second = expectError(
      scope.recordReconciliation(workItemId, materialReconciliation(comparison, 'KeepPendingClarification', T2)),
      'Conflict',
    );
    assert.match(second.reason, /already reconciled as AdoptRevisedScope/);
    assert.equal(expectOk(scope.listReconciliations(workItemId)).length, 1);
  });
});

test('a recorded difference and a recorded reconciliation cannot be edited after the fact (F12-AC1, F12-AC4)', async () => {
  await withDatabase(async ({ connection, scope, workItemId }) => {
    expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));
    const changed = liveScope({ workItemId, description: 'A materially different description.', retrievedAt: T1 });
    const comparison = expectOk(scope.compareStoredToLive(workItemId, changed));
    const detection = expectOk(
      scope.recordComparison({ workItemId, comparison, observedAt: T1, providerRevision: null, correlationId: null }),
    );
    const recorded = expectOk(scope.recordReconciliation(workItemId, materialReconciliation(comparison, 'AdoptRevisedScope')));

    assert.throws(
      () =>
        connection
          .prepare('UPDATE scope_change_detections SET change_kind = ? WHERE scope_change_detection_id = ?')
          .run('Cosmetic', detection.scopeChangeDetectionId),
      /scope_change_detections is append-only/,
    );
    assert.throws(
      () => connection.prepare('DELETE FROM scope_change_detections WHERE scope_change_detection_id = ?').run(detection.scopeChangeDetectionId),
      /retained: a difference that was detected is a fact about the past/,
    );
    assert.throws(
      () => connection.prepare('UPDATE scope_reconciliations SET choice = ? WHERE scope_reconciliation_id = ?').run('AdoptRevisedScope', recorded.scopeReconciliationId),
      /scope_reconciliations is append-only/,
    );
    assert.throws(
      () => connection.prepare('DELETE FROM scope_reconciliations WHERE scope_reconciliation_id = ?').run(recorded.scopeReconciliationId),
      /a decision cannot be edited/,
    );
  });
});

test('a sync attempt carrying content the provider no longer has is refused and the discrepancy is recorded (F12-AC5)', async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));

    // The owner edited the description by hand. The sync was computed from the
    // recorded scope, so publishing it would restore the older text over the edit.
    const manuallyEdited = liveScope({
      workItemId,
      description: 'The owner rewrote this paragraph by hand.',
      providerRevision: 'rev-9',
      retrievedAt: T1,
    });
    const verdict = expectOk(
      scope.recordSyncAttempt({
        workItemId,
        liveScope: manuallyEdited,
        providerStatus: 'InProgress',
        outboxEventId: null,
        operationId: null,
        expectedRefs: [ref('issue-42')],
        succeededRefs: [],
        attemptedAt: T1,
        correlationId: 'correlation-1',
      }),
    );
    assert.equal(verdict.outcome, 'RefusedStaleContent');
    assert.ok(verdict.discrepancy);
    assert.equal(verdict.discrepancy.kind, 'StaleContentRefused');
    assert.equal(verdict.discrepancy.refusedAction, 'push-observed-content');
    assert.match(verdict.discrepancy.detail, /description/);
    assert.equal(verdict.discrepancy.observedStatus, 'InProgress', 'what the provider showed is recorded as observed');

    const recorded = expectOk(scope.listDiscrepancies(workItemId));
    assert.equal(recorded.length, 1, 'the refusal is a durable record, not a log line');
    assert.equal(recorded[0]?.kind, 'StaleContentRefused');
    assert.deepEqual(
      recorded[0]?.unpublishedRefs.map((entry) => entry.id),
      ['issue-42'],
      'the refused attempt still names what it did not publish',
    );
  });
});

test('a sync attempt whose content still matches the record is accepted and records nothing (F12-AC5)', async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));
    const verdict = expectOk(
      scope.recordSyncAttempt({
        workItemId,
        liveScope: liveScope({ workItemId, providerRevision: 'rev-2', retrievedAt: T1 }),
        providerStatus: 'InProgress',
        outboxEventId: null,
        operationId: null,
        expectedRefs: [ref('issue-42')],
        succeededRefs: [ref('issue-42')],
        attemptedAt: T1,
        correlationId: null,
      }),
    );
    assert.equal(verdict.outcome, 'Accepted');
    assert.equal(verdict.discrepancy, null);
    assert.deepEqual(expectOk(scope.listDiscrepancies(workItemId)), []);
  });
});

test('an external Done is preserved and flagged, never treated as release confirmation (F12-AC5, F29-AC5)', async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));
    const verdict = expectOk(
      scope.recordSyncAttempt({
        workItemId,
        liveScope: liveScope({ workItemId, providerRevision: 'rev-2', retrievedAt: T1 }),
        providerStatus: 'Done',
        outboxEventId: null,
        operationId: null,
        expectedRefs: [ref('issue-42')],
        succeededRefs: [ref('issue-42')],
        attemptedAt: T1,
        correlationId: null,
      }),
    );
    assert.equal(verdict.outcome, 'ExternalStatusWithoutReleaseEvidence');
    assert.ok(verdict.discrepancy);
    assert.equal(verdict.discrepancy.kind, 'ExternalStatusWithoutReleaseEvidence');
    assert.equal(verdict.discrepancy.refusedAction, 'confirm-release');
    assert.equal(verdict.discrepancy.observedStatus, 'Done', 'the human closing their issue is preserved as observed');

    const state = expectOk(
      scope.recordSyncAttempt({
        workItemId,
        liveScope: liveScope({ workItemId, providerRevision: 'rev-3', retrievedAt: T2 }),
        providerStatus: 'Done',
        outboxEventId: null,
        operationId: null,
        expectedRefs: [ref('issue-42')],
        succeededRefs: [ref('issue-42')],
        attemptedAt: T2,
        correlationId: null,
      }),
    );
    assert.equal(state.outcome, 'ExternalStatusWithoutReleaseEvidence', 'it is flagged again rather than quietly accepted');
  });
});

test('a partial publication names what is unpublished without losing the mappings that succeeded (F10-AC2, F10-AC5)', async () => {
  await withDatabase(async ({ connection, scope, workItemId }) => {
    expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));
    seedExternalEffect(connection, 'op-1', 'effect-1');
    const succeeded = ref('issue-42');
    const outstanding = ref('issue-43');
    const verdict = expectOk(
      scope.recordSyncAttempt({
        workItemId,
        liveScope: liveScope({ workItemId, providerRevision: 'rev-2', retrievedAt: T1 }),
        providerStatus: 'InProgress',
        outboxEventId: 'effect-1',
        operationId: 'op-1',
        expectedRefs: [succeeded, outstanding],
        succeededRefs: [succeeded],
        attemptedAt: T1,
        correlationId: null,
      }),
    );
    assert.equal(verdict.outcome, 'PartialPublication');
    assert.ok(verdict.discrepancy);
    assert.deepEqual(
      verdict.discrepancy.unpublishedRefs.map((entry) => entry.id),
      ['issue-43'],
      'what remains unpublished is named',
    );
    assert.deepEqual(
      verdict.discrepancy.succeededRefs.map((entry) => entry.id),
      ['issue-42'],
      'the mapping that succeeded is kept, so a retry cannot republish it',
    );
    assert.equal(verdict.discrepancy.outboxEventId, 'effect-1');
    assert.equal(verdict.discrepancy.operationId, 'op-1');
  });
});

test('a refused attempt carries both ref lists, so one row answers what the attempt did not achieve (F12-AC5, F10-AC2)', async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));
    const verdict = expectOk(
      scope.recordSyncAttempt({
        workItemId,
        liveScope: liveScope({ workItemId, description: 'Hand-edited by the owner.', retrievedAt: T1 }),
        providerStatus: 'InProgress',
        outboxEventId: null,
        operationId: null,
        expectedRefs: [ref('issue-42'), ref('issue-43')],
        succeededRefs: [ref('issue-42')],
        attemptedAt: T1,
        correlationId: null,
      }),
    );
    assert.equal(verdict.outcome, 'RefusedStaleContent');
    assert.ok(verdict.discrepancy);
    assert.deepEqual(
      verdict.discrepancy.unpublishedRefs.map((entry) => entry.id),
      ['issue-43'],
    );
    assert.deepEqual(
      verdict.discrepancy.succeededRefs.map((entry) => entry.id),
      ['issue-42'],
    );
  });
});

test('comparing against a work item with no snapshot, or the wrong work item, is refused (F12-AC2)', async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    const noSnapshot = expectError(
      scope.compareStoredToLive(workItemId, liveScope({ workItemId })),
      'NotFound',
    );
    assert.match(noSnapshot.reason, /Scope snapshot for work item/);

    expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));
    const wrongWorkItem = expectError(
      scope.compareStoredToLive(workItemId, liveScope({ workItemId: 'work-item-2' as WorkItemId })),
      'Invalid',
    );
    assert.match(wrongWorkItem.reason, /names a different work item/);
  });
});

test('a comparison made against a fingerprint the work item never recorded is a conflict (F12-AC2)', async () => {
  await withDatabase(async ({ scope, workItemId }) => {
    expectOk(scope.capture(captureInput(workItemId, liveScope({ workItemId }))));
    const comparison = expectOk(scope.compareStoredToLive(workItemId, liveScope({ workItemId })));
    const tampered: ScopeComparison = {
      ...comparison,
      recordedFingerprint: fingerprint({ never: 'recorded' }) as Fingerprint,
    };
    const refused = expectError(
      scope.recordComparison({ workItemId, comparison: tampered, observedAt: T1, providerRevision: null, correlationId: null }),
      'Conflict',
    );
    assert.match(refused.reason, /is not what work item/);
  });
});
