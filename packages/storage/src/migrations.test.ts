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
import { canonicalize, fingerprint } from '@shiploop/domain';
import type { DomainError, InvalidError, Result } from '@shiploop/domain';
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

/**
 * SQLite rows as plain objects.
 *
 * `node:sqlite` returns null-prototype rows, which `deepStrictEqual` treats as a
 * different type from an object literal. Spreading keeps the comparison strict about
 * every value while ignoring that representational detail, which is not what these
 * assertions are about.
 */
function plain<T>(rows: readonly T[]): T[] {
  return rows.map((row) => ({ ...row }) as T);
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
    // currentVersion reports what is RECORDED, not what this build defines, so the
    // fixture row is visible in it. That is what makes the refusal necessary: the
    // database claims a version this build cannot serve.
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
    // currentVersion reports what is RECORDED, not what this build defines, so the
    // fixture row is visible in it. That is what makes the refusal necessary: the
    // database claims a version this build cannot serve.
    assert.equal(expectOk(currentVersion(db)), LATEST_SCHEMA_VERSION);
  });
});

test('a migrated database reports no dangling foreign key and no corruption', async () => {
  await withMigratedDatabase((db) => {
    seedRunParents(db);
    assert.deepEqual(plain(db.prepare('PRAGMA foreign_key_check').all()), []);
    assert.deepEqual(plain(db.prepare('PRAGMA integrity_check').all()), [{ integrity_check: 'ok' }]);
  });
});

test('an applied version this build does not define is refused rather than ignored (N08-AC3)', async () => {
  await withMigratedDatabase((db) => {
    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
    ).run(LATEST_SCHEMA_VERSION + 1, 'from_a_newer_build', T0, 'f'.repeat(32));

    const before = db
      .prepare('SELECT count(*) AS rows FROM schema_migrations')
      .get()?.['rows'];

    const refusal = expectRefusal(migrate(db), 'Invalid');
    assert.match(refusal.reason, /newer or different build/);
    // The refusal must not have applied anything on the way out.
    assert.equal(
      db
        .prepare('SELECT count(*) AS rows FROM schema_migrations WHERE version = ?')
        .get(LATEST_SCHEMA_VERSION + 1)?.['rows'],
      1,
    );
    // currentVersion reports what is RECORDED, not what this build defines, so the
    // fixture row is visible in it. That is what makes the refusal necessary: the
    // database claims a version this build cannot serve.
    assert.equal(expectOk(currentVersion(db)), LATEST_SCHEMA_VERSION + 1);
    // No migration was recorded on the way out: the row count is exactly what the
    // fixture left behind.
    assert.equal(db.prepare('SELECT count(*) AS rows FROM schema_migrations').get()?.['rows'], before);
  });
});

test('a gap below the applied maximum is refused, because a migration cannot be inserted out of order', async () => {
  await withMigratedDatabase((db) => {
    db.prepare('DELETE FROM schema_migrations WHERE version = 3').run();

    const refusal = expectRefusal(migrate(db), 'Invalid');
    assert.match(refusal.reason, /gap below the recorded maximum/);
    // The named versions live in the field message, which is what an operator reads.
    assert.equal(refusal.code, 'Invalid');
    const detail = (refusal as InvalidError).fields
      .map((field: { path: string; message: string }) => `${field.path} ${field.message}`)
      .join(' | ');
    assert.match(detail, /Version 3 missing/);
  });
});

test('a renamed applied migration is refused, because forward-only migrations cannot be rewritten', async () => {
  await withMigratedDatabase((db) => {
    // A rename in SOURCE changes both the recorded name and the checksum derived
    // from it, because the runner hashes `version:name`. Editing only the stored
    // name would leave the checksum intact and correctly match, so the fixture has
    // to reproduce what a renamed migration actually looks like on disk.
    db.prepare('UPDATE schema_migrations SET name = ?, checksum = ? WHERE version = 8').run(
      'something_else',
      'a'.repeat(32),
    );

    const refusal = expectRefusal(migrate(db), 'Invalid');
    assert.match(refusal.reason, /renamed after the fact/);
    assert.equal(refusal.code, 'Invalid');
    const detail = (refusal as InvalidError).fields
      .map((field: { path: string; message: string }) => `${field.path} ${field.message}`)
      .join(' | ');
    assert.match(detail, /Version 8 is recorded as "something_else"/);
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
          record.run(
            row['version'] as number,
            row['name'] as string,
            row['applied_at'] as string,
            row['checksum'] as string,
          );
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

/**
 * The version pair this fixture is written for.
 *
 * The rows below are in the shape version 7 produced - `provider_revision` still
 * on `procedure_versions`, `approval_state` rather than `status` - because they
 * exist to prove the version 8 rebuild translates them instead of dropping them.
 * Writing the pair down rather than deriving it from `LATEST_SCHEMA_VERSION` keeps
 * that proof intact when a later migration is added: a fixture pinned to "one
 * version back" silently changes shape when the tail moves, and then fails on a
 * column that has nothing to do with what it is testing. The upgrade path of the
 * newest migration is covered against a populated database in the file that owns
 * that migration.
 */
const PROCEDURE_ALIGNMENT_FROM = 7;

/**
 * The version that still carried the project-wide uniqueness constraint.
 *
 * Everything before this rebuilt `procedure_versions` with
 * `UNIQUE (project_id, version)`, so a database at this version is the one shape the
 * subject-scoped rebuild has to accept (F05-AC3).
 */
const PROCEDURE_SUBJECT_IDENTITY_FROM = 11;

test('a database at version 7 upgrades to 8 without losing a row (N08-AC3)', async () => {
  await withDatabaseAtVersion(PROCEDURE_ALIGNMENT_FROM, (db) => {
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
    assert.equal(report.fromVersion, PROCEDURE_ALIGNMENT_FROM);
    // The runner applies every unrecorded version, so this asserts that the
    // procedure-version rebuild was one of the steps that ran rather than that it
    // was the last one. Which rows survived it is the rest of this test.
    assert.ok(
      report.toVersion > PROCEDURE_ALIGNMENT_FROM,
      `the database moved past version ${PROCEDURE_ALIGNMENT_FROM}`,
    );
    assert.ok(
      report.applied.some((step) => step.name === 'procedure_version_alignment'),
      'the procedure-version alignment ran against these rows',
    );

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
    assert.deepEqual(plain(db.prepare('PRAGMA foreign_key_check').all()), []);

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

test('a procedure version is identified by its subject, so two subjects may both start at 1 (F05-AC1, F05-AC3)', async () => {
  await withMigratedDatabase((db) => {
    db.prepare('INSERT INTO owners (owner_id, display_name) VALUES (?, ?)').run(OWNER, 'Solo owner');
    db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(PROJECT, 'Migration project');
    const insert = db.prepare(
      `INSERT INTO procedure_versions
         (procedure_version_id, project_id, subject_key, version, kind, scope, source, content_json,
          content_fingerprint, status, approved_at, created_at, created_by)
       VALUES (?, ?, ?, ?, 'Procedure', 'project', 'Owner', ?, ?, 'Accepted', ?, ?, ?)`,
    );
    insert.run('subject-a-1', PROJECT, 'release.web', 1, '{"step":"merge"}', fingerprint({ a: 1 }), T0, T0, OWNER);

    // The constraint this migration changed: under the project-wide uniqueness the
    // second subject's first version was refused, which is what made comparing two
    // subjects of one project unstorable (F05-AC3).
    insert.run('subject-b-1', PROJECT, 'environment.recipe', 1, '{"step":"build"}', fingerprint({ b: 1 }), T0, T0, OWNER);
    insert.run('subject-b-2', PROJECT, 'environment.recipe', 2, '{"step":"verify"}', fingerprint({ b: 2 }), T0, T0, OWNER);

    const rows = db
      .prepare('SELECT procedure_version_id, subject_key, version FROM procedure_versions ORDER BY subject_key, version')
      .all();
    assert.deepEqual(
      plain(rows).map((row) => [row['procedure_version_id'], row['subject_key'], row['version']]),
      [
        ['subject-b-1', 'environment.recipe', 1],
        ['subject-b-2', 'environment.recipe', 2],
        ['subject-a-1', 'release.web', 1],
      ],
    );

    // The numbering is still per subject, so re-using a number within one subject is
    // refused while the same number under another subject is not. Nothing was weakened
    // to make the second subject storable.
    assert.throws(
      () =>
        insert.run(
          'subject-a-duplicate',
          PROJECT,
          'release.web',
          1,
          '{"step":"other"}',
          fingerprint({ a: 2 }),
          T0,
          T0,
          OWNER,
        ),
      /UNIQUE constraint failed: procedure_versions.project_id, procedure_versions.subject_key, procedure_versions.version/,
    );
  });
});

test('the subject-scoped rebuild keeps every procedure version and every reference to one (F05-AC3, F12-AC3, N08-AC3)', async () => {
  await withDatabaseAtVersion(PROCEDURE_SUBJECT_IDENTITY_FROM, (db) => {
    db.prepare('INSERT INTO owners (owner_id, display_name) VALUES (?, ?)').run(OWNER, 'Solo owner');
    db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(PROJECT, 'Migration project');
    db
      .prepare(
        `INSERT INTO project_profile_versions (profile_version_id, project_id, version, content_json, content_fingerprint, created_by, created_at)
         VALUES (?, ?, 1, '{}', ?, ?, ?)`,
      )
      .run(PROFILE_VERSION, PROJECT, fingerprint({ profile: 'subject-identity' }), OWNER, T0);
    db
      .prepare(
        `INSERT INTO procedure_versions
           (procedure_version_id, project_id, subject_key, version, kind, scope, source, source_revision, content_json,
            content_fingerprint, status, approved_at, created_at, created_by, note)
         VALUES ('procedure-subject-1', ?, 'environment.recipe', 1, 'Procedure', 'Environment', 'Owner', 'rev-1', '{"step":"build"}', ?,
                 'Accepted', ?, ?, ?, 'the owner note')`,
      )
      .run(PROJECT, fingerprint({ procedure: 'subject-identity' }), T0, T0, OWNER);

    // Three different kinds of reference, because `rebuildTables` stashes whatever the
    // live schema reports and a reference it did not carry across would be a lost fact
    // about work that already happened (F12-AC3).
    db
      .prepare(
        `INSERT INTO work_items (work_item_id, project_id, issue_id, publication_intent, origin, profile_version_id, created_at)
         VALUES (?, ?, 'issue-subject-identity', 'PublishWhenAgreed', 'Proposed', ?, ?)`,
      )
      .run(WORK_ITEM, PROJECT, PROFILE_VERSION, T0);
    db
      .prepare(
        `INSERT INTO scope_snapshots
           (scope_snapshot_id, work_item_id, project_id, issue_id, description, scope_fingerprint, retrieved_at,
            profile_version_id, procedure_version_id, created_at)
         VALUES (?, ?, ?, 'issue-subject-identity', 'Subject scope', ?, ?, ?, 'procedure-subject-1', ?)`,
      )
      .run(SCOPE_SNAPSHOT, WORK_ITEM, PROJECT, fingerprint({ scope: 'subject-identity' }), T0, PROFILE_VERSION, T0);
    db
      .prepare(
        `INSERT INTO jobs (job_id, work_item_id, project_id, scope_snapshot_id, profile_version_id, procedure_version_id,
           mode, operation_id, correlation_id, queued_at, created_at)
         VALUES ('job-subject-1', ?, ?, ?, ?, 'procedure-subject-1', 'Build', 'op-subject-1', 'corr-subject-1', ?, ?)`,
      )
      .run(WORK_ITEM, PROJECT, SCOPE_SNAPSHOT, PROFILE_VERSION, T0, T0);

    const report = expectOk(migrate(db));
    assert.equal(report.fromVersion, PROCEDURE_SUBJECT_IDENTITY_FROM);
    assert.ok(
      report.applied.some((step) => step.name === 'procedure_version_subject_identity'),
      'the subject-scoped rebuild ran against these rows',
    );

    const row = db.prepare('SELECT * FROM procedure_versions WHERE procedure_version_id = ?').get('procedure-subject-1');
    assert.ok(row !== undefined, 'the version keeps its identity across the rebuild');
    assert.equal(row['subject_key'], 'environment.recipe');
    assert.equal(row['version'], 1);
    assert.equal(row['content_json'], '{"step":"build"}');
    assert.equal(row['source_revision'], 'rev-1');
    assert.equal(row['status'], 'Accepted');
    assert.equal(row['approved_at'], T0);
    assert.equal(row['created_by'], OWNER);
    assert.equal(row['note'], 'the owner note');
    assert.equal(
      row['content_fingerprint'],
      fingerprint({ procedure: 'subject-identity' }),
      'the fact identity is carried across unchanged',
    );

    assert.equal(
      db.prepare('SELECT procedure_version_id FROM jobs WHERE job_id = ?').get('job-subject-1')?.['procedure_version_id'],
      'procedure-subject-1',
    );
    assert.equal(
      db.prepare('SELECT procedure_version_id FROM scope_snapshots WHERE scope_snapshot_id = ?').get(SCOPE_SNAPSHOT)?.[
        'procedure_version_id'
      ],
      'procedure-subject-1',
    );
    assert.deepEqual(plain(db.prepare('PRAGMA foreign_key_check').all()), []);

    // The row the rebuild produced is the one the repository's per-subject numbering now
    // accepts: a second version of the same subject follows it, and a different subject
    // may hold its own version 1 (F05-AC1).
    db
      .prepare(
        `INSERT INTO procedure_versions
           (procedure_version_id, project_id, subject_key, version, kind, scope, source, content_json,
            content_fingerprint, status, created_at, created_by)
         VALUES ('procedure-subject-2', ?, 'environment.recipe', 2, 'Procedure', 'Environment', 'Owner', '{"step":"verify"}', ?,
                 'Proposed', ?, ?)`,
      )
      .run(PROJECT, fingerprint({ procedure: 'subject-identity-2' }), T0, OWNER);
    db
      .prepare(
        `INSERT INTO procedure_versions
           (procedure_version_id, project_id, subject_key, version, kind, scope, source, content_json,
            content_fingerprint, status, created_at, created_by)
         VALUES ('procedure-other-subject-1', ?, 'release.web', 1, 'Procedure', 'project', 'Owner', '{"step":"merge"}', ?,
                 'Proposed', ?, ?)`,
      )
      .run(PROJECT, fingerprint({ procedure: 'subject-identity-3' }), T0, OWNER);
    assert.deepEqual(
      plain(
        db
          .prepare(
            `SELECT subject_key, version FROM procedure_versions ORDER BY subject_key, version`,
          )
          .all(),
      ).map((row) => [row['subject_key'], row['version']]),
      [
        ['environment.recipe', 1],
        ['environment.recipe', 2],
        ['release.web', 1],
      ],
    );
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
    assert.deepEqual(plain(db.prepare('SELECT slot_id, generation FROM coding_slots').all()), [
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

/* -------------------------------------------------------------------------- */
/* Requests and delivery contracts (mvp-spec 3)                                */
/* -------------------------------------------------------------------------- */

const REQUEST = 'request-migration-01';
const CONTRACT = 'contract-migration-01';
const REQUEST_FINGERPRINT = fingerprint({ request: 'migration' });
const CRITERIA = canonicalize([
  { id: 'AC1', description: 'The endpoint returns 200.', verificationType: 'automated' },
]);

/** The parent rows a request and a contract reference. */
function seedContractParents(db: Database): void {
  db.prepare('INSERT INTO owners (owner_id, display_name) VALUES (?, ?)').run(OWNER, 'Solo owner');
  db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(PROJECT, 'Migration project');
  db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(OTHER_PROJECT, 'Other project');
}

function insertRequest(db: Database, requestId = REQUEST, projectId = PROJECT): void {
  db.prepare(
    'INSERT INTO requests (request_id, project_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(requestId, projectId, 'Checkout totals', 'The summary shows the pre-tax total.', T0, T0);
}

function insertContract(
  db: Database,
  overrides: {
    readonly contractId?: string;
    readonly requestId?: string;
    readonly projectId?: string;
    readonly revision?: number;
    readonly status?: string;
    readonly outcome?: string;
    readonly scopeJson?: string;
    readonly outOfScopeJson?: string;
    readonly criteriaJson?: string;
    readonly approvedBy?: string | null;
    readonly approvedAt?: string | null;
    readonly staleReason?: string | null;
    readonly supersededByRevision?: number | null;
    readonly sourceBriefId?: string | null;
    readonly sourceBriefVersion?: number | null;
    readonly contentFingerprint?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO delivery_contracts
       (contract_id, project_id, request_id, revision, outcome, scope_json, out_of_scope_json,
        acceptance_criteria_json, status, content_fingerprint, request_fingerprint, approved_by_owner_id,
        approved_at, stale_reason, superseded_by_revision, source_brief_id, source_brief_version,
        created_by_owner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.contractId ?? CONTRACT,
    overrides.projectId ?? PROJECT,
    overrides.requestId ?? REQUEST,
    overrides.revision ?? 1,
    overrides.outcome ?? 'The summary shows the total including tax.',
    overrides.scopeJson ?? canonicalize(['Sum before tax']),
    overrides.outOfScopeJson ?? canonicalize(['Changing the tax rate']),
    overrides.criteriaJson ?? CRITERIA,
    overrides.status ?? 'draft',
    overrides.contentFingerprint ?? fingerprint({ contract: 'migration' }),
    REQUEST_FINGERPRINT,
    overrides.approvedBy === undefined ? null : overrides.approvedBy,
    overrides.approvedAt === undefined ? null : overrides.approvedAt,
    overrides.staleReason === undefined ? null : overrides.staleReason,
    overrides.supersededByRevision === undefined ? null : overrides.supersededByRevision,
    overrides.sourceBriefId === undefined ? null : overrides.sourceBriefId,
    overrides.sourceBriefVersion === undefined ? null : overrides.sourceBriefVersion,
    OWNER,
    T0,
    T0,
  );
}

test('a request belongs to a project and needs a title and a description (mvp-spec 3)', async () => {
  await withMigratedDatabase((db) => {
    seedContractParents(db);
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO requests (request_id, project_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run('req-blank', PROJECT, '   ', 'Something', T0, T0),
      /CHECK constraint failed: length\(trim\(title\)\) > 0/,
    );
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO requests (request_id, project_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run('req-blank-desc', PROJECT, 'Title', '  ', T0, T0),
      /CHECK constraint failed: length\(trim\(description\)\) > 0/,
    );
    // A request with no project is refused by the foreign key, so "which project is
    // this for" can never be answered two ways.
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO requests (request_id, project_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run('req-no-project', 'no-such-project', 'Title', 'Something', T0, T0),
      /FOREIGN KEY constraint failed/,
    );
  });
});

test('a request title and description stay editable, because a request is a draft (mvp-spec 3)', async () => {
  await withMigratedDatabase((db) => {
    seedContractParents(db);
    insertRequest(db);
    db.prepare('UPDATE requests SET title = ?, description = ?, updated_at = ? WHERE request_id = ?').run(
      'Checkout totals including tax',
      'The summary shows the total including tax.',
      '2026-02-02T00:00:00.000Z',
      REQUEST,
    );
    const row = db.prepare('SELECT title, description, updated_at FROM requests WHERE request_id = ?').get(REQUEST);
    assert.equal(row?.['title'], 'Checkout totals including tax');
    assert.equal(row?.['updated_at'], '2026-02-02T00:00:00.000Z');
  });
});

test('an approval is an owner decision with a recorded identity, or it is not an approval (mvp-spec 3)', async () => {
  await withMigratedDatabase((db) => {
    seedContractParents(db);
    insertRequest(db);
    // Approved by nobody.
    assert.throws(
      () => insertContract(db, { status: 'approved', approvedAt: T0 }),
      /CHECK constraint failed/,
    );
    // Approved at no instant.
    assert.throws(
      () => insertContract(db, { status: 'approved', approvedBy: OWNER }),
      /CHECK constraint failed/,
    );
    // Approved by a row that is not an owner.
    assert.throws(
      () => insertContract(db, { status: 'approved', approvedBy: 'own_not_real', approvedAt: T0 }),
      /FOREIGN KEY constraint failed/,
    );
    // Both halves together is accepted.
    insertContract(db, { status: 'approved', approvedBy: OWNER, approvedAt: T0 });
    assert.equal(
      db.prepare('SELECT status FROM delivery_contracts WHERE request_id = ?').get(REQUEST)?.['status'],
      'approved',
    );
  });
});

test('an approved or stale revision is frozen by the schema, not only by the domain (mvp-spec 3)', async () => {
  await withMigratedDatabase((db) => {
    seedContractParents(db);
    insertRequest(db);
    insertContract(db, { status: 'approved', approvedBy: OWNER, approvedAt: T0 });

    assert.throws(
      () =>
        db
          .prepare('UPDATE delivery_contracts SET outcome = ? WHERE request_id = ?')
          .run('A different outcome entirely', REQUEST),
      /an approved or stale delivery contract revision is frozen/,
    );
    assert.throws(
      () =>
        db
          .prepare('UPDATE delivery_contracts SET acceptance_criteria_json = ? WHERE request_id = ?')
          .run(canonicalize([]), REQUEST),
      /an approved or stale delivery contract revision is frozen/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM delivery_contracts WHERE request_id = ?').run(REQUEST),
      /an approved or stale delivery contract revision is retained for history/,
    );
    assert.equal(
      db.prepare('SELECT outcome FROM delivery_contracts WHERE request_id = ?').get(REQUEST)?.['outcome'],
      'The summary shows the total including tax.',
    );

    // The transition out of approved is the one thing that is allowed, and it must name
    // a reason: a stale revision always explains itself.
    assert.throws(
      () =>
        db
          .prepare("UPDATE delivery_contracts SET status = 'stale' WHERE request_id = ?")
          .run(REQUEST),
      /CHECK constraint failed/,
    );
    db.prepare("UPDATE delivery_contracts SET status = 'stale', stale_reason = ? WHERE request_id = ?").run(
      'The owner changed the scope.',
      REQUEST,
    );
    assert.equal(
      db.prepare('SELECT stale_reason FROM delivery_contracts WHERE request_id = ?').get(REQUEST)?.['stale_reason'],
      'The owner changed the scope.',
    );
  });
});

test('a draft revision keeps its own content editable while its identity stays fixed (mvp-spec 7)', async () => {
  await withMigratedDatabase((db) => {
    seedContractParents(db);
    insertRequest(db);
    insertContract(db);

    db.prepare('UPDATE delivery_contracts SET outcome = ?, updated_at = ? WHERE request_id = ?').run(
      'The summary shows the total including tax and shipping.',
      '2026-02-02T00:00:00.000Z',
      REQUEST,
    );
    assert.equal(
      db.prepare('SELECT outcome FROM delivery_contracts WHERE request_id = ?').get(REQUEST)?.['outcome'],
      'The summary shows the total including tax and shipping.',
    );

    for (const [column, value] of [
      ['contract_id', 'contract-rewritten'],
      ['revision', '9'],
      ['request_id', 'request-rewritten'],
      ['project_id', OTHER_PROJECT],
      ['created_at', '2026-01-01T00:00:00.000Z'],
      ['created_by_owner_id', 'own_rewritten'],
    ] as const) {
      assert.throws(
        () =>
          db.prepare(`UPDATE delivery_contracts SET ${column} = ? WHERE request_id = ?`).run(value, REQUEST),
        /a delivery contract revision keeps its identity for its whole life/,
        `${column} must not be rewritten`,
      );
    }
  });
});

test('a request has at most one draft and one approved revision, so "the contract" is one thing (mvp-spec 3)', async () => {
  await withMigratedDatabase((db) => {
    seedContractParents(db);
    insertRequest(db);
    insertContract(db);
    // A second draft for the same request: the constraint that stops two texts being
    // editable at once, which is how a revision gets approved while another is on screen.
    assert.throws(
      () => insertContract(db, { contractId: 'contract-second-draft', revision: 2 }),
      /UNIQUE constraint failed: delivery_contracts\.request_id/,
    );

    db.prepare('DELETE FROM delivery_contracts WHERE request_id = ?').run(REQUEST);
    insertContract(db, { status: 'approved', approvedBy: OWNER, approvedAt: T0 });
    assert.throws(
      () =>
        insertContract(db, {
          contractId: 'contract-second-approved',
          revision: 2,
          status: 'approved',
          approvedBy: OWNER,
          approvedAt: T0,
        }),
      /UNIQUE constraint failed: delivery_contracts\.request_id/,
    );
    // A draft alongside the approved revision is fine: drafting a revision is how a
    // material change is made, and the old approval stays current until it is superseded.
    insertContract(db, { contractId: 'contract-next-draft', revision: 2 });
  });
});

test('a request may hold many revisions, and each is addressed by its own number (mvp-spec 3)', async () => {
  await withMigratedDatabase((db) => {
    seedContractParents(db);
    insertRequest(db);
    insertContract(db, { status: 'approved', approvedBy: OWNER, approvedAt: T0 });
    db.prepare('UPDATE delivery_contracts SET status = ?, stale_reason = ? WHERE request_id = ?').run(
      'stale',
      'Superseded by revision 2.',
      REQUEST,
    );
    insertContract(db, { contractId: 'contract-second', revision: 2, status: 'draft' });

    const rows = db
      .prepare('SELECT contract_id, revision, status FROM delivery_contracts WHERE request_id = ? ORDER BY revision')
      .all(REQUEST);
    assert.deepEqual(
      plain(rows).map((row) => [row['contract_id'], row['revision'], row['status']]),
      [
        [CONTRACT, 1, 'stale'],
        ['contract-second', 2, 'draft'],
      ],
    );
    // The same revision number cannot be reused for the same request.
    assert.throws(
      () => insertContract(db, { contractId: 'contract-duplicate-revision', revision: 2, status: 'draft' }),
      /UNIQUE constraint failed/,
    );
  });
});

test('a revision is superseded only by a strictly later one, and a superseded one was approved (mvp-spec 3)', async () => {
  await withMigratedDatabase((db) => {
    seedContractParents(db);
    insertRequest(db);
    insertContract(db);
    // Superseding itself: the reason names revision 1, which is what this row is.
    assert.throws(
      () =>
        db
          .prepare("UPDATE delivery_contracts SET status = 'stale', stale_reason = 'Superseded by revision 1.', superseded_by_revision = 1 WHERE request_id = ?")
          .run(REQUEST),
      /CHECK constraint failed/,
    );
    // Superseding by a later revision while the row is a draft: there is no approval to
    // supersede, so the pairing is refused rather than recorded as one.
    assert.throws(
      () =>
        db
          .prepare("UPDATE delivery_contracts SET status = 'stale', stale_reason = 'Superseded by revision 4.', superseded_by_revision = 4 WHERE request_id = ?")
          .run(REQUEST),
      /CHECK constraint failed/,
    );

    // The real shape: an approved revision superseded by a later one.
    db.prepare('DELETE FROM delivery_contracts WHERE request_id = ?').run(REQUEST);
    insertContract(db, { status: 'approved', approvedBy: OWNER, approvedAt: T0 });
    db.prepare("UPDATE delivery_contracts SET status = 'stale', stale_reason = ?, superseded_by_revision = 2 WHERE request_id = ?").run(
      'Superseded by revision 2.',
      REQUEST,
    );
    const row = db.prepare('SELECT status, stale_reason, superseded_by_revision, approved_by_owner_id FROM delivery_contracts WHERE request_id = ?').get(REQUEST);
    assert.equal(row?.['status'], 'stale');
    assert.equal(row?.['stale_reason'], 'Superseded by revision 2.');
    assert.equal(row?.['superseded_by_revision'], 2);
    // The approval survives, because a superseded revision is history rather than a deletion.
    assert.equal(row?.['approved_by_owner_id'], OWNER);
  });
});

test('brief provenance is all-or-nothing, so a revision never cites half a brief (F07-AC3)', async () => {
  await withMigratedDatabase((db) => {
    seedContractParents(db);
    insertRequest(db);
    assert.throws(
      () => insertContract(db, { sourceBriefId: 'brief-1', sourceBriefVersion: null }),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insertContract(db, { sourceBriefId: null, sourceBriefVersion: 2 }),
      /CHECK constraint failed/,
    );
    insertContract(db, { sourceBriefId: 'brief-1', sourceBriefVersion: 2 });
    assert.equal(
      db.prepare('SELECT source_brief_version FROM delivery_contracts WHERE request_id = ?').get(REQUEST)?.[
        'source_brief_version'
      ],
      2,
    );
  });
});

test('a contract stores its content as canonical documents, not as opaque text (mvp-spec 7)', async () => {
  await withMigratedDatabase((db) => {
    seedContractParents(db);
    insertRequest(db);
    // Non-JSON, or JSON of the wrong shape, is refused at the column rather than read
    // back as a contract whose scope is a string.
    for (const [label, overrides] of [
      ['scope_json', { scopeJson: 'not json' }],
      ['out_of_scope_json', { outOfScopeJson: '"a string"' }],
      ['acceptance_criteria_json', { criteriaJson: '{"AC1":"not an array"}' }],
    ] as const) {
      assert.throws(
        () => insertContract(db, overrides),
        /CHECK constraint failed/,
        `${label} must hold a JSON array`,
      );
    }
    // A malformed content fingerprint is refused too: a fingerprint of nothing cannot
    // identify a revision.
    assert.throws(
      () => insertContract(db, { contentFingerprint: 'fp_short' }),
      /CHECK constraint failed/,
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
      // One draft and one approved revision per request, so "the current contract" is
      // a single thing rather than two rows a client picks between (mvp-spec 3).
      'delivery_contracts_one_draft_per_request',
      'delivery_contracts_one_approved_per_request',
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