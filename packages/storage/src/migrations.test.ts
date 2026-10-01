/**
 * Proof for the migration runner, against real database files.
 *
 * The repositories were proved against `migrate`, but nothing proved `migrate`
 * itself, so a defect here would have shown up as a repository failure with no
 * explanation. The properties asserted here are the ones the product depends on
 * and cannot be inferred from a passing use case:
 *
 *   - a fresh file reaches the version this build defines, and a second run
 *     applies nothing, because a migration that re-runs is a schema that
 *     re-derives itself (N08-AC3);
 *   - a database already at an earlier version upgrades without losing a row,
 *     which is what "forward-only" has to mean in practice: the only alternative
 *     is a database that cannot be upgraded at all;
 *   - a history that does not match this build is refused rather than guessed at,
 *     because guessing leaves a half-upgraded store that is never diagnosed;
 *   - the CHECKs, unique indexes and triggers the product relies on are really
 *     in the migrated schema, rather than in the memory of whoever wrote them.
 *
 * Every case uses a temporary file rather than `:memory:`: durability, the
 * bootstrap table and the replayed history are all properties of a file, and an
 * in-memory database would make them vacuous.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprint } from '@shiploop/domain';
import type { DomainError, Result } from '@shiploop/domain';
import { openDatabase, type Database } from './db.ts';
import {
  LATEST_SCHEMA_VERSION,
  appliedMigrations,
  currentVersion,
  migrate,
  migrationDefinitions,
} from './migrations.ts';
import { withTransaction } from './tx.ts';

const PROJECT = 'project-migration-01';
const OTHER_PROJECT = 'project-migration-02';
const OWNER = 'owner-migration-01';
const PROFILE_VERSION = 'profile-migration-01';
const WORK_ITEM = 'work-item-migration-01';
const SCOPE_SNAPSHOT = 'scope-snapshot-migration-01';
const HEAD_SHA = 'a1b2c3d4'.repeat(5);
const BASE_SHA = '0f0f0f0f'.repeat(5);
const T0 = '2026-02-01T00:00:00.000Z';

function expectOk<T>(result: Result<T, DomainError>): T {
  if (!result.ok) {
    assert.fail(`expected success but received ${result.error.code}: ${result.error.reason}`);
  }
  return result.value;
}

function expectRefusal<T>(result: Result<T, DomainError>, code: DomainError['code']): DomainError {
  if (result.ok) {
    assert.fail(`expected a ${code} refusal but the call succeeded`);
  }
  assert.equal(result.error.code, code);
  return result.error;
}

/** Opens a temporary file, runs `migrate`, hands the connection over, cleans up. */
async function withMigratedDatabase(
  run: (db: Database) => Promise<void> | void,
): Promise<void> {
  await withTemporaryDatabase(async (db) => {
    expectOk(migrate(db));
    await run(db);
  });
}

/** Opens a temporary file without migrating it, for the history cases. */
async function withTemporaryDatabase(run: (db: Database) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-migrations-'));
  try {
    const opened = openDatabase(join(directory, 'storage.sqlite'));
    assert.ok(opened.ok, `the database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
    const db = opened.value;
    try {
      await run(db);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The parents every run-scoped row references.
 *
 * `candidates`, `jobs` and `scope_snapshots` all carry foreign keys to the
 * profile and procedure versions a run starts from, and the CHECKs under test
 * live on those child tables. Seeding the parents is what lets the negative cases
 * prove a column constraint rather than a missing parent.
 */
function seedRunParents(db: Database): void {
  db.prepare('INSERT INTO owners (owner_id, display_name) VALUES (?, ?)').run(OWNER, 'Solo owner');
  db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(PROJECT, 'Migration project');
  db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(OTHER_PROJECT, 'Other project');
  db
    .prepare(
      `INSERT INTO project_profile_versions (profile_version_id, project_id, version, content_json, content_fingerprint, created_by, created_at)
       VALUES (?, ?, 1, '{}', ?, ?, ?)`,
    )
    .run(PROFILE_VERSION, PROJECT, fingerprint({ profile: 'migration' }), OWNER, T0);
  db
    .prepare(
      `INSERT INTO procedure_versions
         (procedure_version_id, project_id, subject_key, version, kind, scope, source, content_json, content_fingerprint, status, approved_at, created_at, created_by)
       VALUES ('procedure-migration-01', ?, 'environment.recipe', 1, 'Procedure', 'Environment', 'Owner', '{"step":"build"}', ?,
               'Accepted', ?, ?, ?)`,
    )
    .run(PROJECT, fingerprint({ procedure: 'migration' }), T0, T0, OWNER);
  db
    .prepare(
      `INSERT INTO work_items (work_item_id, project_id, issue_id, publication_intent, origin, profile_version_id)
       VALUES (?, ?, 'issue-migration-01', 'PublishWhenAgreed', 'Proposed', ?)`,
    )
    .run(WORK_ITEM, PROJECT, PROFILE_VERSION);
  db
    .prepare(
      `INSERT INTO scope_snapshots
         (scope_snapshot_id, work_item_id, project_id, issue_id, description, scope_fingerprint, retrieved_at, profile_version_id, procedure_version_id)
       VALUES (?, ?, ?, 'issue-migration-01', 'Migration scope', ?, ?, ?, 'procedure-migration-01')`,
    )
    .run(SCOPE_SNAPSHOT, WORK_ITEM, PROJECT, fingerprint({ scope: 'migration' }), T0, PROFILE_VERSION);
}

test('a fresh file is migrated to the version this build defines (N08-AC3)', async () => {
  await withMigratedDatabase((db) => {
    assert.ok(LATEST_SCHEMA_VERSION >= 8, 'this build knows a procedure-version migration');
    const recorded = expectOk(appliedMigrations(db));
    assert.deepEqual(
      recorded.map((record) => record.version),
      migrationDefinitions.map((definition) => definition.version),
    );
    for (const record of recorded) {
      assert.match(record.appliedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(record.checksum.length, 32);
    }
    assert.equal(expectOk(currentVersion(db)), LATEST_SCHEMA_VERSION);
  });
});

test('a second migrate applies nothing and leaves the version unchanged (N08-AC3)', async () => {
  await withMigratedDatabase((db) => {
    const before = expectOk(appliedMigrations(db));

    const second = expectOk(migrate(db));
    assert.deepEqual(second.applied, []);
    assert.equal(second.fromVersion, LATEST_SCHEMA_VERSION);
    assert.equal(second.toVersion, LATEST_SCHEMA_VERSION);
    assert.deepEqual(expectOk(appliedMigrations(db)), before);
    assert.equal(expectOk(currentVersion(db)), LATEST_SCHEMA_VERSION);
  });
});

test('a migrated database reports no dangling foreign key and no corruption', async () => {
  await withMigratedDatabase((db) => {
    seedRunParents(db);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all(), [{ integrity_check: 'ok' }]);
  });
});

test('an applied version this build does not define is refused rather than ignored (N08-AC3)', async () => {
  await withMigratedDatabase((db) => {
    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
    ).run(LATEST_SCHEMA_VERSION + 1, 'from_a_newer_build', T0, 'f'.repeat(32));

    const refusal = expectRefusal(migrate(db), 'Invalid');
    assert.match(refusal.reason, /newer or different build/);
    // The refusal must not have applied anything on the way out.
    assert.equal(
      db
        .prepare('SELECT count(*) AS rows FROM schema_migrations WHERE version = ?')
        .get(LATEST_SCHEMA_VERSION + 1)?.['rows'],
      1,
    );
    assert.equal(expectOk(currentVersion(db)), LATEST_SCHEMA_VERSION);
  });
});

test('a gap below the applied maximum is refused, because a migration cannot be inserted out of order', async () => {
  await withMigratedDatabase((db) => {
    db.prepare('DELETE FROM schema_migrations WHERE version = 3').run();

    const refusal = expectRefusal(migrate(db), 'Invalid');
    assert.match(refusal.reason, /gap below the recorded maximum/);
    assert.match(refusal.reason, /Version 3 missing/);
  });
});

test('a renamed applied migration is refused, because forward-only migrations cannot be rewritten', async () => {
  await withMigratedDatabase((db) => {
    db.prepare('UPDATE schema_migrations SET name = ? WHERE version = 8').run('something_else');

    const refusal = expectRefusal(migrate(db), 'Invalid');
    assert.match(refusal.reason, /renamed after the fact/);
  });
});

/**
 * A database left at an earlier version, exactly as the build that owned that
 * migration left it.
 *
 * The definitions are replayed one per transaction, and each version's record -
 * including the checksum the runner reconciles against - is copied from a
 * database this same runner migrated. Copying the records rather than inventing
 * them keeps the reconciliation path under test the real one: a fixture whose
 * checksums did not match would be refused for a reason that has nothing to do
 * with the migration being tested.
 *
 * The bookkeeping table itself is created from the DDL a migrated database
 * stores, so the fixture cannot drift from what `migrate` bootstraps.
 */
async function withDatabaseAtVersion(
  upToVersion: number,
  run: (db: Database) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-migrations-tail-'));
  try {
    const history: Record<string, unknown>[] = [];
    const reference = openDatabase(join(directory, 'reference.sqlite'));
    assert.ok(reference.ok, 'the reference database opened');
    try {
      expectOk(migrate(reference.value));
      history.push(
        ...reference.value
          .prepare(
            'SELECT version, name, applied_at, checksum FROM schema_migrations WHERE version <= ? ORDER BY version',
          )
          .all(upToVersion),
      );
      const opened = openDatabase(join(directory, 'older.sqlite'));
      assert.ok(opened.ok, 'the older database opened');
      const older = opened.value;
      try {
        older.exec(
          String(
            reference.value
              .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
              .get()?.['sql'],
          ),
        );
        for (const definition of migrationDefinitions) {
          if (definition.version > upToVersion) break;
          withTransaction(older, () => definition.up(older));
        }
        const record = older.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
        );
        for (const row of history) {
          record.run(row['version'], row['name'], row['applied_at'], row['checksum']);
        }
        await run(older);
      } finally {
        older.close();
      }
    } finally {
      reference.value.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a database already at the previous version is upgraded without losing a row (N08-AC3)', async () => {
  await withDatabaseAtVersion(LATEST_SCHEMA_VERSION - 1, (db) => {
    db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(PROJECT, 'Migration project');
    db
      .prepare(
        `INSERT INTO project_profile_versions (profile_version_id, project_id, version, content_json, content_fingerprint, created_by, created_at)
         VALUES (?, ?, 1, '{}', ?, ?, ?)`,
      )
      .run(PROFILE_VERSION, PROJECT, fingerprint({ profile: 'legacy' }), OWNER, T0);

    // Four rows in the shape the previous schema produced: a draft written
    // before a subject key existed, an approved one, a superseded one, and a row
    // the repository wrote after the columns arrived.
    const insertLegacy = db.prepare(
      `INSERT INTO procedure_versions
         (procedure_version_id, project_id, version, kind, source, provider_revision, content_json,
          content_fingerprint, approval_state, approved_at, created_at, subject_key, scope,
          source_revision, content, status, created_by, note)
       VALUES (?, ?, ?, 'Procedure', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertLegacy.run(
      'legacy-draft',
      PROJECT,
      1,
      'Repository',
      'rev-legacy',
      '"{\\"step\\":\\"merge\\"}"',
      fingerprint({ legacy: 'draft' }),
      'Draft',
      null,
      T0,
      null,
      null,
      null,
      '{"step":"merge"}',
      null,
      null,
      null,
    );
    insertLegacy.run(
      'legacy-approved',
      PROJECT,
      2,
      'Owner',
      null,
      '{"step":"build"}',
      fingerprint({ legacy: 'approved' }),
      'Approved',
      T0,
      T0,
      null,
      null,
      null,
      null,
      null,
      null,
      'owner note',
    );
    insertLegacy.run(
      'legacy-superseded',
      PROJECT,
      3,
      'Owner',
      null,
      '{"step":"release"}',
      fingerprint({ legacy: 'superseded' }),
      'Superseded',
      T0,
      T0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    insertLegacy.run(
      'aligned-row',
      PROJECT,
      4,
      'Owner',
      null,
      '{"step":"deploy"}',
      fingerprint({ legacy: 'aligned' }),
      'Draft',
      null,
      T0,
      'environment.recipe',
      'Environment',
      'rev-aligned',
      '{"step":"deploy"}',
      'Proposed',
      OWNER,
      null,
    );

    // Rows that reference a procedure version: the rebuild must carry them
    // across, not drop or rewrite them.
    db
      .prepare(
        `INSERT INTO work_items (work_item_id, project_id, issue_id, publication_intent, origin, profile_version_id)
         VALUES (?, ?, 'issue-legacy', 'PublishWhenAgreed', 'Proposed', ?)`,
      )
      .run(WORK_ITEM, PROJECT, PROFILE_VERSION);
    db
      .prepare(
        `INSERT INTO scope_snapshots
           (scope_snapshot_id, work_item_id, project_id, issue_id, description, scope_fingerprint, retrieved_at, profile_version_id, procedure_version_id)
         VALUES (?, ?, ?, 'issue-legacy', 'Legacy scope', ?, ?, ?, 'legacy-draft')`,
      )
      .run(SCOPE_SNAPSHOT, WORK_ITEM, PROJECT, fingerprint({ scope: 'legacy' }), T0, PROFILE_VERSION);
    db
      .prepare(
        `INSERT INTO jobs (job_id, work_item_id, project_id, scope_snapshot_id, profile_version_id, procedure_version_id, mode, operation_id, correlation_id, queued_at)
         VALUES ('job-legacy', ?, ?, ?, ?, 'legacy-approved', 'Build', 'op-legacy', 'corr-legacy', ?)`,
      )
      .run(WORK_ITEM, PROJECT, SCOPE_SNAPSHOT, PROFILE_VERSION, T0);

    const report = expectOk(migrate(db));
    assert.equal(report.fromVersion, LATEST_SCHEMA_VERSION - 1);
    assert.equal(report.toVersion, LATEST_SCHEMA_VERSION);
    assert.deepEqual(report.applied, [
      { version: LATEST_SCHEMA_VERSION, name: 'procedure_version_alignment' },
    ]);

    // Every row survived, and the approval state was translated rather than
    // invented. A draft becomes a proposal: content nobody accepted still cannot
    // be what a run reads (F05-AC4).
    const rows = db
      .prepare(
        `SELECT procedure_version_id, status, subject_key, scope, source_revision, content_json, created_by, approved_at
         FROM procedure_versions ORDER BY version`,
      )
      .all();
    assert.deepEqual(
      rows.map((row) => [row['procedure_version_id'], row['status']]),
      [
        ['legacy-draft', 'Proposed'],
        ['legacy-approved', 'Accepted'],
        ['legacy-superseded', 'Superseded'],
        ['aligned-row', 'Proposed'],
      ],
    );
    assert.equal(rows[0]?.['subject_key'], '');
    assert.equal(rows[0]?.['scope'], '');
    assert.equal(rows[0]?.['created_by'], '');
    // The revision recorded before the rename is still the row's revision.
    assert.equal(rows[0]?.['source_revision'], 'rev-legacy');
    assert.equal(rows[1]?.['source_revision'], null);
    // The document is stored once, and it is the document rather than a JSON
    // string of the document.
    assert.equal(rows[0]?.['content_json'], '{"step":"merge"}');
    assert.equal(rows[1]?.['content_json'], '{"step":"build"}');
    assert.equal(rows[1]?.['approved_at'], T0);
    assert.equal(rows[3]?.['subject_key'], 'environment.recipe');
    assert.equal(rows[3]?.['scope'], 'Environment');
    assert.equal(rows[3]?.['created_by'], OWNER);

    // The referencing rows are intact and still point at the versions they named.
    assert.equal(
      db.prepare('SELECT procedure_version_id FROM jobs WHERE job_id = ?').get('job-legacy')?.['procedure_version_id'],
      'legacy-approved',
    );
    assert.equal(
      db.prepare('SELECT procedure_version_id FROM scope_snapshots WHERE scope_snapshot_id = ?').get(SCOPE_SNAPSHOT)?.[
        'procedure_version_id'
      ],
      'legacy-draft',
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

    // The columns that carried a second name for one idea are gone, so a reader
    // cannot pick the wrong one.
    const columns = db
      .prepare('PRAGMA table_info(procedure_versions)')
      .all()
      .map((row) => String(row['name']));
    for (const removed of ['approval_state', 'content', 'provider_revision', 'version_number']) {
      assert.equal(columns.includes(removed), false, `${removed} should no longer exist`);
    }
  });
});

test('the rebuilt procedure_versions index the queries the repository actually runs', async () => {
  await withMigratedDatabase((db) => {
    const indexes = new Map(
      db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'procedure_versions'")
        .all()
        .map((row) => [String(row['name']), String(row['sql'] ?? '')] as const),
    );
    assert.match(indexes.get('procedure_versions_by_subject') ?? '', /project_id, subject_key, status, version DESC/);
    assert.match(indexes.get('procedure_versions_proposed') ?? '', /WHERE status = 'Proposed'/);
    assert.match(indexes.get('procedure_versions_by_project') ?? '', /project_id, kind, version DESC/);
  });
});

test('an abbreviated commit SHA is refused by the candidate column (F17-AC2, F20-AC3)', async () => {
  await withMigratedDatabase((db) => {
    seedRunParents(db);
    const insert = db.prepare(
      `INSERT INTO candidates (candidate_id, work_item_id, project_id, scope_snapshot_id, profile_version_id,
         procedure_version_id, fingerprint, head_sha, base_sha, scope_fingerprint, environment_fingerprint, policy_fingerprint)
       VALUES ('candidate-migration-01', ?, ?, ?, ?, 'procedure-migration-01', ?, ?, ?, ?, ?, ?)`,
    );
    const identity = [
      WORK_ITEM,
      PROJECT,
      SCOPE_SNAPSHOT,
      PROFILE_VERSION,
      fingerprint({ candidate: 'migration' }),
    ] as const;
    const tail = [
      BASE_SHA,
      fingerprint({ scope: 'migration' }),
      fingerprint({ environment: 'migration' }),
      fingerprint({ policy: 'migration' }),
    ] as const;

    assert.throws(() => insert.run(...identity, 'a1b2c3d', ...tail), /length\(head_sha\) IN \(40, 64\)/);
    assert.equal(db.prepare('SELECT count(*) AS rows FROM candidates').get()?.['rows'], 0);
    insert.run(...identity, HEAD_SHA, ...tail);
    assert.equal(db.prepare('SELECT count(*) AS rows FROM candidates').get()?.['rows'], 1);
  });
});

test('a repeated operation identity cannot create a second job (F13-AC2)', async () => {
  await withMigratedDatabase((db) => {
    seedRunParents(db);
    const enqueue = db.prepare(
      `INSERT INTO jobs (job_id, work_item_id, project_id, scope_snapshot_id, profile_version_id, procedure_version_id, mode, operation_id, correlation_id, queued_at)
       VALUES (?, ?, ?, ?, ?, 'procedure-migration-01', 'Build', 'op-migration-01', 'corr-migration-01', ?)`,
    );
    const parents = [WORK_ITEM, PROJECT, SCOPE_SNAPSHOT, PROFILE_VERSION, T0] as const;
    enqueue.run('job-migration-01', ...parents);
    assert.throws(() => enqueue.run('job-migration-02', ...parents), /UNIQUE constraint failed: jobs\.operation_id/);
    assert.equal(db.prepare('SELECT count(*) AS rows FROM jobs').get()?.['rows'], 1);
  });
});

test('there is exactly one coding slot and it cannot be duplicated (F13-AC2, F17-AC5)', async () => {
  await withMigratedDatabase((db) => {
    assert.deepEqual(db.prepare('SELECT slot_id, generation FROM coding_slots').all(), [
      { slot_id: 1, generation: 0 },
    ]);
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO coding_slots (slot_id, generation) VALUES (2, 0)')
          .run(),
      /CHECK constraint failed: slot_id = 1/,
    );
    db.prepare('UPDATE coding_slots SET holder = ? WHERE slot_id = 1').run('worker-1');
    assert.equal(db.prepare('SELECT holder FROM coding_slots WHERE slot_id = 1').get()?.['holder'], 'worker-1');
    assert.equal(db.prepare('SELECT count(*) AS rows FROM coding_slots').get()?.['rows'], 1);
  });
});

test('a scope snapshot stays append-only (F12-AC1)', async () => {
  await withMigratedDatabase((db) => {
    seedRunParents(db);
    assert.throws(
      () =>
        db
          .prepare('UPDATE scope_snapshots SET description = ? WHERE scope_snapshot_id = ?')
          .run('Rewritten scope', SCOPE_SNAPSHOT),
      /scope_snapshots are immutable/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM scope_snapshots WHERE scope_snapshot_id = ?').run(SCOPE_SNAPSHOT),
      /scope_snapshots are immutable and retained for history/,
    );
    assert.equal(
      db.prepare('SELECT description FROM scope_snapshots WHERE scope_snapshot_id = ?').get(SCOPE_SNAPSHOT)?.[
        'description'
      ],
      'Migration scope',
    );
  });
});

test('the unique indexes the product relies on are present after migrating', async () => {
  await withMigratedDatabase((db) => {
    const unique = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql LIKE 'CREATE UNIQUE INDEX%'")
        .all()
        .map((row) => String(row['name'])),
    );
    for (const name of [
      // One sign-in identity per address, and one provider issue per work item,
      // so adopting existing work cannot produce a duplicate (F10).
      'owners_by_email',
      'work_items_by_external_issue',
      // One workspace per port, so a collision is a blocker rather than an
      // unrelated service answering (F14-AC3).
      'workspace_ports_unique_port',
      // One snapshot per sequence number for a work item, so a replayed append
      // returns the original snapshot (F12-AC1).
      'scope_snapshots_by_work_item_sequence',
    ]) {
      assert.equal(unique.has(name), true, `${name} should be a unique index`);
    }

    // A second port reservation for the same workspace refuses to collide with
    // another workspace's port.
    seedRunParents(db);
    db.prepare(
      'INSERT INTO workspace_ports (workspace_id, service_name, port, job_id, holder, reserved_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('workspace-a', 'web', 4200, 'job-a', 'worker-1', T0);
    assert.throws(
      () =>
        db
          .prepare(
            'INSERT INTO workspace_ports (workspace_id, service_name, port, job_id, holder, reserved_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run('workspace-b', 'web', 4200, 'job-b', 'worker-1', T0),
      /UNIQUE constraint failed: workspace_ports\.port/,
    );
  });
});