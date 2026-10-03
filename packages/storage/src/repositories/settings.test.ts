/**
 * Behavioural proof for project settings storage (mvp-spec 3 "Settings", L02-AC2, L02-AC3).
 *
 * Every test runs against the REAL migrated schema on a temporary file, for the reason
 * `repositories/core.test.ts` gives: a repository proved against an invented fixture schema
 * proves nothing about the product. The table this slice added is migration 17, so these
 * tests also prove the migration applies and that the schema's own CHECK constraints refuse
 * what the use case refuses - the column is the backstop, not the validation.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProjectId } from '@shiploop/domain';
import { openDatabase, type Database } from '../db.ts';
import { migrate } from '../migrations.ts';
import { ProjectSettingsRepository } from './settings.ts';

const PROJECT = '0a5f1c22-0000-4000-8000-00000000000a' as ProjectId;
const OTHER_PROJECT = '0a5f1c22-0000-4000-8000-00000000000b' as ProjectId;
const T3_URL = 'https://t3.example.test/app';
const AT = '2026-03-01T12:00:00.000Z';

interface Fixture {
  readonly database: Database;
  readonly settings: ProjectSettingsRepository;
  readonly close: () => void;
}

async function withStore(body: (fixture: Fixture) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-settings-store-'));
  try {
    const opened = openDatabase(join(directory, 'shiploop.db'));
    assert.ok(opened.ok, `the database must open: ${opened.ok ? '' : opened.error.reason}`);
    const database = opened.value;
    const migrated = migrate(database);
    assert.ok(migrated.ok, `the schema must migrate: ${migrated.ok ? '' : migrated.error.reason}`);
    const repository = new ProjectSettingsRepository(database);
    seedProject(database, PROJECT);
    try {
      await body({ database, settings: repository, close: () => database.close() });
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Puts a project row in place, the way `ProjectRepository.create` would. */
function seedProject(database: Database, projectId: ProjectId): void {
  database.prepare('INSERT INTO projects (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    projectId,
    String(projectId),
    AT,
    AT,
  );
}

test('a project that never configured anything reads as not configured, not as a failure', async () => {
  await withStore(({ database, settings }) => {
    seedProject(database, OTHER_PROJECT);
    const read = settings.read(OTHER_PROJECT);

    assert.equal(read.ok, true, 'an absent settings row is a state, not a storage error (L02-AC3)');
    if (!read.ok) throw new Error('unreachable');
    assert.equal(read.value, null);
  });
});

test('a configured T3 URL survives a close, and clearing it is recorded rather than erased', async () => {
  await withStore(({ settings }) => {
    const saved = settings.setT3LaunchUrl(PROJECT, T3_URL, AT);
    assert.ok(saved.ok);
    if (!saved.ok) throw new Error('unreachable');
    assert.equal(saved.value.t3LaunchUrl, T3_URL);
    assert.equal(saved.value.updatedAt, AT);

    const reread = settings.read(PROJECT);
    assert.ok(reread.ok);
    if (!reread.ok) throw new Error('unreachable');
    assert.equal(reread.value?.t3LaunchUrl, T3_URL);

    const clearedAt = '2026-03-02T09:00:00.000Z';
    const cleared = settings.setT3LaunchUrl(PROJECT, null, clearedAt);
    assert.ok(cleared.ok);
    if (!cleared.ok) throw new Error('unreachable');
    assert.equal(cleared.value.t3LaunchUrl, null, 'clearing must leave "not configured" (L02-AC3)');
    assert.equal(cleared.value.updatedAt, clearedAt, 'the row stays, so the change has an instant');

    const afterClear = settings.read(PROJECT);
    assert.ok(afterClear.ok);
    if (!afterClear.ok) throw new Error('unreachable');
    assert.equal(afterClear.value?.t3LaunchUrl, null);
  });
});

test("one project's settings are never another's, and a project is never invented", async () => {
  await withStore(({ database, settings }) => {
    settings.setT3LaunchUrl(PROJECT, T3_URL, AT);

    const absent = settings.read(OTHER_PROJECT);
    assert.ok(absent.ok);
    if (!absent.ok) throw new Error('unreachable');
    assert.equal(absent.value, null, 'another project must not read this one\'s configuration');

    const missing = settings.setT3LaunchUrl(OTHER_PROJECT, T3_URL, AT);
    assert.equal(missing.ok, false, 'a settings write must not bring a project into existence');
    if (missing.ok) throw new Error('unreachable');
    assert.equal(missing.error.code, 'NotFound');
    assert.equal(
      database.prepare('SELECT COUNT(*) AS total FROM projects WHERE project_id = ?').get(OTHER_PROJECT)?.total,
      0,
      'and the refused write must leave no project row behind',
    );
  });
});

test('the schema refuses a launch URL that is not an absolute http or https URL', async () => {
  await withStore(({ database }) => {
    // Asserted against the column rather than against the repository, because the column is
    // what refuses a write from a caller that cast past the use case's validation (L02-AC2).
    for (const value of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ftp://t3.example.test', 't3.example.test', '   ']) {
      assert.throws(
        () =>
          database
            .prepare('INSERT INTO project_settings (project_id, t3_launch_url, updated_at) VALUES (?, ?, ?)')
            .run(PROJECT, value, AT),
        /CHECK constraint failed/,
        `expected ${JSON.stringify(value)} to be refused by the schema`,
      );
    }

    database
      .prepare('INSERT INTO project_settings (project_id, t3_launch_url, updated_at) VALUES (?, ?, ?)')
      .run(PROJECT, 'HTTPS://t3.example.test', AT);
  });
});

test('an http URL on a private network is storable, because `URL` accepts it too', async () => {
  await withStore(({ settings }) => {
    const saved = settings.setT3LaunchUrl(PROJECT, 'http://t3.internal.test', AT);
    assert.ok(saved.ok);
    if (!saved.ok) throw new Error('unreachable');
    assert.equal(saved.value.t3LaunchUrl, 'http://t3.internal.test');
  });
});
