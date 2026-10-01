/**
 * The session use cases against the real migrated store (F01-AC2, N02-AC1).
 *
 * `web-surface.test.ts` proves the whole seam end to end; this file proves the
 * individual refusals, because a defect that only shows up as "the first request
 * was a 401" is exactly the kind that survives a seam test. Each case runs against
 * a temporary SQLite file with the production migrations applied, because the
 * properties here are about a column that exists (`sessions.last_seen_at`) and a
 * digest format that has to match the domain's.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateSessionToken, hashSessionToken, type OwnerId } from '@shiploop/domain';
import {
  OwnerRepository,
  closeDatabase,
  migrate,
  openDatabase,
  type Database,
} from '@shiploop/storage';
import type { ControllerClock } from './profiles.ts';
import { createSessionUseCases } from './sessions.ts';

const NOW = '2026-10-01T09:00:00.000Z';
const OWNER_ID = 'owner_sessions_fixture' as OwnerId;
const DISPLAY_NAME = 'Solo Owner';

const clock: ControllerClock = { now: () => NOW };

/**
 * A migrated file with one provisioned owner, which is all a session needs.
 *
 * The handle is passed through unchanged because `Database` is the SQLite handle:
 * the repositories read and write the same connection the migrations created, so
 * a test cannot accidentally exercise a different database than the product does.
 */
async function withStore(body: (owners: OwnerRepository, database: Database) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-sessions-'));
  const opened = openDatabase(join(directory, 'shiploop.db'));
  if (!opened.ok) throw new Error(`the database must open: ${opened.error.reason}`);
  try {
    const migrated = migrate(opened.value);
    assert.ok(migrated.ok, `the real schema must migrate: ${migrated.ok ? '' : migrated.error.reason}`);
    const owners = new OwnerRepository(opened.value);
    const provisioned = owners.provision(OWNER_ID, DISPLAY_NAME, '2026-10-01T08:00:00.000Z');
    assert.ok(provisioned.ok, `the owner must provision: ${provisioned.ok ? '' : provisioned.error.reason}`);
    await body(owners, opened.value);
  } finally {
    closeDatabase(opened.value);
    await rm(directory, { recursive: true, force: true });
  }
}

test('a session opens under the caller\'s limits and resolves from its digest (F01-AC2)', async () => {
  await withStore(async (owners) => {
    const sessions = createSessionUseCases({ clock, owners });
    const token = generateSessionToken();

    const opened = sessions.open({
      ownerId: OWNER_ID,
      displayName: DISPLAY_NAME,
      tokenDigest: hashSessionToken(token),
      issuedAt: NOW,
      absoluteTtlSeconds: 28_800,
      idleTimeoutSeconds: 900,
    });
    assert.ok(opened.ok, `a usable limit must open a session: ${opened.ok ? '' : opened.error.reason}`);
    assert.equal(opened.value.tokenDigest, hashSessionToken(token));
    assert.equal(opened.value.lastActivityAt, NOW, 'the idle clock starts at sign-in, not at the first request');
    assert.equal(opened.value.revokedAt, null);
    assert.equal(opened.value.displayName, DISPLAY_NAME);
    assert.equal(
      opened.value.expiresAt,
      '2026-10-01T09:15:00.000Z',
      'the stored deadline must state the limit the caller configured',
    );

    const loaded = sessions.loadByToken(token);
    assert.ok(loaded.ok, 'the presented token must resolve to its row');
    assert.equal(loaded.value.sessionId, opened.value.sessionId);
    assert.equal(loaded.value.tokenDigest, hashSessionToken(token));

    const absent = sessions.loadByToken(generateSessionToken());
    assert.equal(absent.ok, false, 'an unknown token must not resolve');
    if (!absent.ok) assert.equal(absent.error.code, 'NotFound');
    assert.equal(sessions.loadByToken('').ok, false, 'an empty token must not resolve');
  });
});

test('a digest that is not the domain\'s is refused rather than stored (F01-AC2)', async () => {
  await withStore(async (owners) => {
    const sessions = createSessionUseCases({ clock, owners });
    const refused = sessions.open({
      ownerId: OWNER_ID,
      displayName: DISPLAY_NAME,
      // A bare SHA-256, which is the format storage used to write. Accepting it
      // would put two formats in one column again.
      tokenDigest: 'a'.repeat(64),
      issuedAt: NOW,
      absoluteTtlSeconds: 28_800,
      idleTimeoutSeconds: 900,
    });
    assert.ok(refused.ok, 'a well-formed digest is accepted whatever produced it');
    assert.equal(refused.value.tokenDigest, 'a'.repeat(64));

    const unusable = sessions.open({
      ownerId: OWNER_ID,
      displayName: DISPLAY_NAME,
      tokenDigest: 'not-a-digest',
      issuedAt: NOW,
      absoluteTtlSeconds: 28_800,
      idleTimeoutSeconds: 900,
    });
    assert.equal(unusable.ok, false, 'a value the domain would never produce must not reach the column');
    if (!unusable.ok) assert.equal(unusable.error.code, 'Invalid');

    const noOwner = sessions.open({
      ownerId: 'owner_that_does_not_exist' as OwnerId,
      displayName: DISPLAY_NAME,
      tokenDigest: hashSessionToken(generateSessionToken()),
      issuedAt: NOW,
      absoluteTtlSeconds: 28_800,
      idleTimeoutSeconds: 900,
    });
    assert.equal(noOwner.ok, false, 'a session for an owner that does not exist must be refused');
    if (!noOwner.ok) assert.equal(noOwner.error.code, 'NotFound');
  });
});

test('an unusable limit is refused instead of being defaulted (F01-AC2)', async () => {
  await withStore(async (owners) => {
    const sessions = createSessionUseCases({ clock, owners });
    const refused = sessions.open({
      ownerId: OWNER_ID,
      displayName: DISPLAY_NAME,
      tokenDigest: hashSessionToken(generateSessionToken()),
      issuedAt: NOW,
      absoluteTtlSeconds: 0,
      idleTimeoutSeconds: 900,
    });
    assert.equal(refused.ok, false, 'a zero limit must not silently become the domain default (F01-AC2)');
    if (!refused.ok) assert.equal(refused.error.code, 'Invalid');

    const unusableInstant = sessions.open({
      ownerId: OWNER_ID,
      displayName: DISPLAY_NAME,
      tokenDigest: hashSessionToken(generateSessionToken()),
      issuedAt: 'not an instant',
      absoluteTtlSeconds: 28_800,
      idleTimeoutSeconds: 900,
    });
    assert.equal(unusableInstant.ok, false, 'an unparsable instant must not produce a session');
  });
});

test('a row with no activity instant is refused rather than read as no limit (F01-AC2)', async () => {
  await withStore(async (owners, database) => {
    const sessions = createSessionUseCases({ clock, owners });
    const token = generateSessionToken();
    const opened = sessions.open({
      ownerId: OWNER_ID,
      displayName: DISPLAY_NAME,
      tokenDigest: hashSessionToken(token),
      issuedAt: NOW,
      absoluteTtlSeconds: 28_800,
      idleTimeoutSeconds: 900,
    });
    assert.ok(opened.ok);

    database.prepare('UPDATE sessions SET last_seen_at = NULL WHERE session_id = ?').run(opened.value.sessionId);

    const loaded = sessions.loadByToken(token);
    assert.equal(loaded.ok, false, 'a row the idle rule cannot be applied to must not be handed out');
    if (!loaded.ok) assert.match(loaded.error.reason, /Malformed/);
  });
});

test('activity moves forward and revocation is idempotent, both on the real row (F01-AC2)', async () => {
  await withStore(async (owners) => {
    const sessions = createSessionUseCases({ clock, owners });
    const token = generateSessionToken();
    const opened = sessions.open({
      ownerId: OWNER_ID,
      displayName: DISPLAY_NAME,
      tokenDigest: hashSessionToken(token),
      issuedAt: NOW,
      absoluteTtlSeconds: 28_800,
      idleTimeoutSeconds: 900,
    });
    assert.ok(opened.ok);

    assert.deepEqual(sessions.touch({ sessionId: opened.value.sessionId, lastActivityAt: '2026-10-01T09:05:00.000Z' }), {
      ok: true,
      value: true,
    });
    const moved = owners.findSessionByToken(token);
    assert.ok(moved.ok);
    assert.equal(
      moved.value?.lastSeenAt,
      '2026-10-01T09:05:00.000Z',
      'the column must move, or a configured idle limit can never fire',
    );

    const unknown = sessions.touch({ sessionId: 'no-such-session', lastActivityAt: NOW });
    assert.equal(unknown.ok, false, 'activity for a session that does not exist must be refused');
    if (!unknown.ok) assert.equal(unknown.error.code, 'NotFound');

    const revoked = sessions.revoke({ sessionId: opened.value.sessionId, revokedAt: '2026-10-01T09:06:00.000Z' });
    assert.ok(revoked.ok);
    assert.equal(revoked.value.revokedAt, '2026-10-01T09:06:00.000Z');

    // A revoked session still loads, so the caller's `authorizeSession` is the
    // authority that refuses it rather than this layer hiding it (F01-AC2).
    const afterRevocation = sessions.loadByToken(token);
    assert.ok(afterRevocation.ok, 'a revoked session must still resolve to its row');
    assert.equal(afterRevocation.value.revokedAt, '2026-10-01T09:06:00.000Z');

    const again = sessions.revoke({ sessionId: opened.value.sessionId, revokedAt: '2026-10-01T09:07:00.000Z' });
    assert.ok(again.ok, 'a retried sign-out must not be an error');
    assert.equal(again.value.revokedAt, '2026-10-01T09:06:00.000Z', 'the first revocation instant is the one kept');

    const missing = sessions.revoke({ sessionId: 'no-such-session', revokedAt: NOW });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, 'NotFound');
  });
});
