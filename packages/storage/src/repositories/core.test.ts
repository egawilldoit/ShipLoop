/**
 * Behavioural proof for the storage core repositories.
 *
 * Every test runs against the REAL migrated schema: a temporary SQLite file is
 * opened with `openDatabase`, then `migrate` builds the production tables in
 * it, and the repositories are driven against that. The previous version of
 * this file created its own inline fixture schema, which is precisely why it
 * could pass while the application could not run: the repositories read and
 * wrote singular table names (`owner`, `connector`, `idea`) that `migrations.ts`
 * never creates, so every use case failed with "no such table" against a real
 * database. A test that proves a repository against a schema it invented
 * proves nothing about the product, so the fixture is gone.
 *
 * A file rather than `:memory:` is used because the properties under test are
 * durability properties: rows that must survive a close, versions that stay
 * readable after a newer one is written, and a session token that must not be
 * recoverable from the file. `:memory:` would make all three vacuously true.
 *
 * The security-invariant tests at the end are the other half of the proof. They
 * assert against the migrated schema's own CHECK constraints and triggers,
 * because those are what refuse a bad write in production: a repository method
 * that validated nothing would still be safe only if the database refused.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  asCommitSha,
  asFingerprint,
  fingerprint,
  generateSessionToken,
  hashSessionToken,
  verifySessionToken,
} from '@shiploop/domain';
import type {
  AuthorizationSubject,
  CapabilityDeclaration,
  CandidateIdentity,
  ConnectorId,
  DomainError,
  Fingerprint,
  OwnerId,
  ProfileVersionId,
  ProjectId,
  Result,
  ScopeSnapshot,
  WorkItemId,
} from '@shiploop/domain';
import { openDatabase, type Database } from '../db.ts';
import { migrate } from '../migrations.ts';
import {
  AttentionItemRepository,
  CandidateRepository,
  ConnectorRepository,
  EvidenceRepository,
  IdeaRepository,
  OwnerDecisionRepository,
  OwnerRepository,
  ProcedureRepository,
  ProjectProfileRepository,
  WorkItemRepository,
} from './core.ts';
import type {
  AppendProcedureVersionInput,
  ProjectProfileContent,
  StorageTransactions,
  UpsertAttentionItemInput,
} from './types.ts';

const PROJECT = '0a5f1c22-0000-4000-8000-00000000000a' as ProjectId;
const OTHER_PROJECT = '0a5f1c22-0000-4000-8000-00000000000b' as ProjectId;
const FIXTURE_PROJECT = '0a5f1c22-0000-4000-8000-00000000000e' as ProjectId;
const OWNER = 'owner-0000-4000-8000-00000000000c';
const OWNER_ID = OWNER as OwnerId;
const OTHER_OWNER = 'owner-0000-4000-8000-00000000000d';
const OTHER_OWNER_ID = OTHER_OWNER as OwnerId;
const PROFILE_VERSION_ID = 'profile-version-1' as ProfileVersionId;
const PROCEDURE_VERSION_ID = 'procedure-version-1';
const CONTENT_FINGERPRINT = fingerprint({ seed: 'profile-and-procedure-content' });
const ABSENT_CONNECTOR = '00000000-0000-4000-8000-000000000000' as ConnectorId;
const ABSENT_FINGERPRINT = asFingerprint(`fp_${'9'.repeat(32)}`);
const SESSION_TOKEN = 'ship-loop-session-token-for-verification-only';
// A real scrypt-style digest of a fixture password. The value is irrelevant to
// the assertions; only that it is stored and returned verbatim matters.
const PASSWORD_DIGEST = 'scrypt$16384$8$1$c2FsdA$Y2FuYXJ5J2hhc2g';
const ROTATED_TOKEN = 'ship-loop-rotated-session-token-for-verification';
const SCOPE_FINGERPRINT = fingerprint({ description: 'scope', criteria: ['ac1'] });
const ENVIRONMENT_FINGERPRINT = fingerprint({ runtime: 'node24', ports: [5173] });
const POLICY_FINGERPRINT = fingerprint({ policyRevision: 7 });
const HEAD_SHA = 'a1b2c3d4'.repeat(5);
const OTHER_HEAD_SHA = 'f0e1d2c3'.repeat(5);
const BASE_SHA = '0f0f0f0f'.repeat(5);

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

function profileContent(targetBranch: string): ProjectProfileContent {
  return {
    references: {
      repository: 'shiploop/example-app',
      ticketProvider: 'linear',
      ticketTeamKey: 'ENG',
      baseBranch: 'main',
      targetBranch,
      deploymentProvider: 'render',
      engine: 'codex',
      previewComponents: [{ component: 'web', environment: 'preview' }],
    },
    policy: {
      requiredChecks: ['typecheck', 'unit'],
      deliveryBehavior: 'ManualAuthorizationOnly',
      maxFixPasses: 2,
      workspaceIsolation: 'WorktreeAndDataDirectory',
      capabilityVersion: 1,
    },
    recipe: 'pnpm install --frozen-lockfile',
    environment: {
      runtime: 'node24',
      ports: [5173],
      secretReferences: ['credential/ticket', 'credential/git'],
    },
  };
}

function candidateIdentity(headSha: string): CandidateIdentity {
  return {
    headSha: asCommitSha(headSha),
    baseSha: asCommitSha(BASE_SHA),
    scopeFingerprint: SCOPE_FINGERPRINT,
    profileVersionId: PROFILE_VERSION_ID,
    procedureVersionId: PROCEDURE_VERSION_ID,
    environmentFingerprint: ENVIRONMENT_FINGERPRINT,
    policyFingerprint: POLICY_FINGERPRINT,
    components: [
      {
        component: 'web',
        deploymentId: 'deployment-1',
        deploymentUrl: 'https://preview.example.test',
        environment: 'preview',
      },
    ],
  };
}

function scopeSnapshot(workItemId: string, description: string): ScopeSnapshot {
  return {
    workItemId,
    issueId: 'issue-1',
    issueIdentifier: 'ENG-1',
    title: 'Adopt an existing issue',
    description,
    providerRevision: 'rev-1',
    priority: 'High',
    dependencyIssueIds: ['issue-0'],
    acceptanceCriteria: [{ id: 'ac1', text: 'The issue is adopted without a duplicate.' }],
    retrievedAt: '2026-01-02T03:04:05.000Z',
  };
}

function attentionInput(overrides: Partial<UpsertAttentionItemInput> = {}): UpsertAttentionItemInput {
  return {
    dedupKey: 'Blocker:attempt-1',
    kind: 'Blocker',
    projectId: PROJECT,
    workItemId: null,
    issueIdentifier: 'ENG-1',
    title: 'The run is blocked',
    blocker: 'The provider rejected the branch push.',
    nextAction: 'Review the branch protection requirement.',
    candidateFingerprint: null,
    observedAt: '2026-01-02T03:04:05.000Z',
    resolved: false,
    ...overrides,
  };
}

const CONNECTOR_DECLARATIONS: readonly CapabilityDeclaration[] = [
  { kind: 'Ticket:ReadScope', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  {
    kind: 'Git:MergeWithPrecondition',
    supported: true,
    limitation: null,
    privileged: true,
    supportsPrecondition: true,
  },
  {
    kind: 'Deployment:Execute',
    supported: false,
    limitation: 'Not offered by this provider.',
    privileged: true,
    supportsPrecondition: false,
  },
];

/**
 * Opens a real database file, migrates it with the production runner, runs the
 * body, closes, then runs `afterClose` against the closed file before removing
 * the directory.
 *
 * `openDatabase` is the real connection factory, so the pragmas a repository
 * depends on (foreign keys on, WAL, busy timeout) are the ones production gets
 * rather than ones a test chose. `migrate` is the real runner, so the tables are
 * the ones an application would find. The post-close hook is what lets a test
 * inspect the bytes that a backup would actually contain.
 */
async function withDatabase(
  run: (database: { readonly connection: Database; readonly file: string }) => Promise<void> | void,
  afterClose?: (file: string) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-storage-core-'));
  const file = join(directory, 'storage.sqlite');
  try {
    const opened = openDatabase(file);
    assert.ok(opened.ok, `the database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
    const connection = opened.value;
    try {
      const migrated = migrate(connection);
      assert.ok(migrated.ok, `the schema could not be migrated: ${migrated.ok ? '' : migrated.error.reason}`);
      await run({ connection, file });
    } finally {
      connection.close();
    }
    if (afterClose !== undefined) await afterClose(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Creates the owner and project rows the migrated schema requires.
 *
 * The foreign keys on `work_items`, `connectors`, `candidates` and
 * `owner_decisions` are real in this file because `openDatabase` turns them on,
 * so those parents must exist before a repository can write a child. The
 * repositories deliberately do not create projects or owners: those are separate
 * use cases, and a repository that quietly created its own parent would hide a
 * missing provisioning step.
 */
function seedOwnerAndProject(connection: Database): void {
  connection
    .prepare('INSERT INTO owners (owner_id, display_name, created_at) VALUES (?, ?, ?)')
    .run(OWNER_ID, 'Solo owner', '2026-01-01T00:00:00.000Z');
  connection
    .prepare('INSERT INTO owners (owner_id, display_name, created_at) VALUES (?, ?, ?)')
    .run(OTHER_OWNER_ID, 'Second owner', '2026-01-01T00:00:00.000Z');
  connection
    .prepare('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)')
    .run(PROJECT, 'Example project', '2026-01-01T00:00:00.000Z');
  connection
    .prepare('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)')
    .run(OTHER_PROJECT, 'Other project', '2026-01-01T00:00:00.000Z');
  connection
    .prepare('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)')
    .run(FIXTURE_PROJECT, 'Foreign-key fixture project', '2026-01-01T00:00:00.000Z');

  // Work items, scope snapshots, candidates and jobs all carry foreign keys to
  // the profile and procedure versions a run is started from, so those parents
  // must exist too. They are inserted directly because a repository only ever
  // mints a new version of its own entity (F02-AC3, F05-AC4); seeding a
  // specific one is setup, not a behaviour under test.
  connection
    .prepare(
      `INSERT INTO project_profile_versions
         (profile_version_id, project_id, version, content_json, content_fingerprint, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(PROFILE_VERSION_ID, FIXTURE_PROJECT, 1, '{}', CONTENT_FINGERPRINT, OWNER, '2026-01-01T00:00:00.000Z');
  connection
    .prepare(
      `INSERT INTO procedure_versions
         (procedure_version_id, project_id, version, kind, source, content_json, content_fingerprint, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      PROCEDURE_VERSION_ID,
      FIXTURE_PROJECT,
      1,
      'Procedure',
      'Owner',
      '{}',
      CONTENT_FINGERPRINT,
      OWNER,
      '2026-01-01T00:00:00.000Z',
    );
}

test('a saved profile returns a new version id and leaves the earlier version readable (F02-AC3)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const profiles = new ProjectProfileRepository(connection);
    const first = expectOk(
      profiles.saveVersion({
        projectId: PROJECT,
        content: profileContent('main'),
        note: 'first cut',
        createdAt: '2026-01-02T03:00:00.000Z',
        createdBy: OWNER,
        expectedVersionNumber: null,
      }),
    );
    const second = expectOk(
      profiles.saveVersion({
        projectId: PROJECT,
        content: profileContent('release/1.x'),
        note: 'target branch moved',
        createdAt: '2026-01-02T04:00:00.000Z',
        createdBy: OWNER,
        expectedVersionNumber: 1,
      }),
    );

    assert.notEqual(second.profileVersionId, first.profileVersionId);
    assert.equal(first.versionNumber, 1);
    assert.equal(second.versionNumber, 2);
    assert.equal(second.supersedesVersionId, first.profileVersionId);

    const reread = expectOk(profiles.getVersion(first.profileVersionId));
    assert.equal(reread.content.references.targetBranch, 'main');
    assert.equal(reread.content.references.repository, 'shiploop/example-app');
    assert.deepEqual(reread.content.policy.requiredChecks, ['typecheck', 'unit']);

    const current = expectOk(profiles.currentVersion(PROJECT));
    assert.equal(current?.profileVersionId, second.profileVersionId);

    const since = expectOk(profiles.listVersionsSince(PROJECT, first.versionNumber));
    assert.deepEqual(
      since.map((version) => version.versionNumber),
      [2],
    );

    const stale = profiles.saveVersion({
      projectId: PROJECT,
      content: profileContent('main'),
      note: null,
      createdAt: '2026-01-02T05:00:00.000Z',
      createdBy: OWNER,
      expectedVersionNumber: 1,
    });
    expectError(stale, 'Conflict');
  });
});

test('an injected transaction runner owns the transaction boundary (F32-AC1)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    let started = 0;
    let committed = 0;
    let rolledBack = 0;
    const transactions: StorageTransactions = {
      transaction<T>(body: () => T): T {
        started += 1;
        connection.exec('BEGIN IMMEDIATE');
        try {
          const value = body();
          connection.exec('COMMIT');
          committed += 1;
          return value;
        } catch (error) {
          connection.exec('ROLLBACK');
          rolledBack += 1;
          throw error;
        }
      },
    };

    const profiles = new ProjectProfileRepository(connection, transactions);
    const version = expectOk(
      profiles.saveVersion({
        projectId: PROJECT,
        content: profileContent('main'),
        note: null,
        createdAt: '2026-01-02T03:00:00.000Z',
        createdBy: OWNER,
        expectedVersionNumber: null,
      }),
    );
    assert.equal(started, 1);
    assert.equal(committed, 1);
    assert.equal(rolledBack, 0);
    assert.equal(version.versionNumber, 1);

    expectError(
      profiles.saveVersion({
        projectId: PROJECT,
        content: profileContent('main'),
        note: null,
        createdAt: '2026-01-02T04:00:00.000Z',
        createdBy: OWNER,
        expectedVersionNumber: 7,
      }),
      'Conflict',
    );
    assert.equal(started, 2);
    assert.equal(rolledBack, 0);

    assert.throws(() =>
      transactions.transaction(() => {
        connection
          .prepare('INSERT INTO audit_log (audit_id, project_id, actor, action, correlation_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            'audit-rolled-back',
            PROJECT,
            OWNER,
            'provision.owner',
            'correlation-rollback',
            '2026-01-02T05:00:00.000Z',
          );
        throw new Error('simulated failure after a write');
      }),
    );
    assert.equal(rolledBack, 1);
    assert.equal(
      connection.prepare('SELECT COUNT(*) AS total FROM audit_log').get()?.total,
      0,
      'the write made before the failure must not survive the rollback',
    );
    assert.equal(expectOk(profiles.listVersions(PROJECT)).length, 1);
  });
});

test('versioned records survive close and reopen (F32-AC1)', async () => {
  let savedId: ProfileVersionId | null = null;
  let savedFile = '';
  await withDatabase(
    async ({ connection, file }) => {
      seedOwnerAndProject(connection);
      savedFile = file;
      const profiles = new ProjectProfileRepository(connection);
      const version = expectOk(
        profiles.saveVersion({
          projectId: PROJECT,
          content: profileContent('main'),
          note: null,
          createdAt: '2026-01-02T03:00:00.000Z',
          createdBy: OWNER,
          expectedVersionNumber: null,
        }),
      );
      savedId = version.profileVersionId;
    },
    (file) => {
      const opened = openDatabase(file);
      assert.ok(opened.ok, `the database could not be reopened: ${opened.ok ? '' : opened.error.reason}`);
      const reopened = opened.value;
      try {
        const profiles = new ProjectProfileRepository(reopened);
        assert.ok(savedId !== null);
        const version = expectOk(profiles.getVersion(savedId));
        assert.equal(version.versionNumber, 1);
        assert.equal(version.content.recipe, 'pnpm install --frozen-lockfile');
      } finally {
        reopened.close();
      }
      assert.equal(file, savedFile);
    },
  );
});

test('a scope snapshot cannot be updated or deleted in place (F12-AC1)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const work = new WorkItemRepository(connection);
    const item = expectOk(
      work.create({
        projectId: PROJECT,
        profileVersionId: PROFILE_VERSION_ID,
        source: 'AdoptedIssue',
        title: 'Adopt an existing issue',
        externalIssueId: 'issue-1',
        externalIssueIdentifier: 'ENG-1',
        externalIssueUrl: 'https://linear.example.test/ENG-1',
        publicationIntent: 'DoNotPublish',
        relatedWorkItemIds: [],
        adoption: {
          repository: 'shiploop/example-app',
          headSha: HEAD_SHA,
          targetBranch: 'main',
          pullRequestId: null,
        },
        at: '2026-01-02T03:00:00.000Z',
      }),
    );

    const first = expectOk(
      work.appendScopeSnapshot({
        scope: scopeSnapshot(item.workItemId, 'Original description.'),
        attemptId: null,
        profileVersionId: item.profileVersionId,
        procedureVersionId: PROCEDURE_VERSION_ID,
        capturedAt: '2026-01-02T03:01:00.000Z',
        correlationId: 'correlation-1',
      }),
    );
    const second = expectOk(
      work.appendScopeSnapshot({
        scope: scopeSnapshot(item.workItemId, 'Revised description.'),
        attemptId: null,
        profileVersionId: item.profileVersionId,
        procedureVersionId: PROCEDURE_VERSION_ID,
        capturedAt: '2026-01-02T05:01:00.000Z',
        correlationId: 'correlation-1',
      }),
    );

    assert.equal(first.sequenceNumber, 1);
    assert.equal(second.sequenceNumber, 2);
    assert.notEqual(first.scopeFingerprint, second.scopeFingerprint);
    assert.notEqual(first.scopeSnapshotId, second.scopeSnapshotId);

    assert.throws(
      () =>
        connection
          .prepare('UPDATE scope_snapshots SET description = ? WHERE scope_snapshot_id = ?')
          .run('Rewritten history.', first.scopeSnapshotId),
      /immutable/,
    );
    assert.throws(
      () => connection.prepare('DELETE FROM scope_snapshots WHERE scope_snapshot_id = ?').run(first.scopeSnapshotId),
      /immutable/,
    );

    const snapshots = expectOk(work.listScopeSnapshots(item.workItemId));
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0]?.description, 'Original description.');
    assert.equal(snapshots[1]?.description, 'Revised description.');

    const latest = expectOk(work.latestScopeSnapshot(item.workItemId));
    assert.equal(latest?.scopeSnapshotId, second.scopeSnapshotId);
  });
});

test('repeated attention events update one item and acknowledgment does not move the run (F31-AC3, F31-AC4)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const work = new WorkItemRepository(connection);
    const item = expectOk(
      work.create({
        projectId: PROJECT,
        profileVersionId: PROFILE_VERSION_ID,
        source: 'CapturedIdea',
        title: 'Draft work',
        externalIssueId: null,
        externalIssueIdentifier: null,
        externalIssueUrl: null,
        publicationIntent: 'PublishWhenAgreed',
        relatedWorkItemIds: [],
        adoption: null,
        at: '2026-01-02T03:00:00.000Z',
      }),
    );
    const beforeAcknowledgement = expectOk(work.get(item.workItemId));

    const attention = new AttentionItemRepository(connection);
    const first = expectOk(attention.upsert(attentionInput({ workItemId: item.workItemId })));
    const second = expectOk(
      attention.upsert(
        attentionInput({
          workItemId: item.workItemId,
          observedAt: '2026-01-02T03:09:00.000Z',
          blocker: 'The provider rejected the branch push a second time.',
        }),
      ),
    );

    assert.equal(second.attentionItemId, first.attentionItemId);
    assert.equal(second.occurrenceCount, 2);
    assert.equal(second.firstObservedAt, '2026-01-02T03:04:05.000Z');
    assert.equal(second.updatedAt, '2026-01-02T03:09:00.000Z');
    assert.equal(expectOk(attention.list(null)).length, 1);

    const acknowledged = expectOk(
      attention.acknowledge(first.attentionItemId, OWNER, '2026-01-02T03:10:00.000Z'),
    );
    assert.equal(acknowledged.state, 'Acknowledged');
    assert.equal(acknowledged.acknowledgedBy, OWNER);

    const afterRepeatedEvent = expectOk(
      attention.upsert(attentionInput({ workItemId: item.workItemId, observedAt: '2026-01-02T03:20:00.000Z' })),
    );
    assert.equal(afterRepeatedEvent.attentionItemId, first.attentionItemId);
    assert.equal(afterRepeatedEvent.state, 'Acknowledged');
    assert.equal(afterRepeatedEvent.acknowledgedAt, '2026-01-02T03:10:00.000Z');
    assert.equal(afterRepeatedEvent.occurrenceCount, 3);
    assert.equal(expectOk(attention.list(null)).length, 1);

    const afterAcknowledgement = expectOk(work.get(item.workItemId));
    assert.deepEqual(afterAcknowledgement, beforeAcknowledgement);

    const resolved = expectOk(attention.resolve(first.attentionItemId, '2026-01-02T03:30:00.000Z'));
    assert.equal(resolved.state, 'Resolved');
    assert.equal(resolved.acknowledgedAt, null);
    expectError(
      attention.acknowledge(first.attentionItemId, OWNER, '2026-01-02T03:31:00.000Z'),
      'Conflict',
    );
  });
});

/**
 * Captures the scope snapshot a candidate is built from.
 *
 * `candidates.scope_snapshot_id` is NOT NULL, which is the schema making F12-AC1
 * real: a candidate records the scope it was built against, so evidence and
 * staleness can be checked against it. The repository resolves the snapshot from
 * the work item, so a test that records a candidate has to capture one first.
 */
function captureSnapshot(
  connection: Database,
  workItemId: WorkItemId,
  description = 'Original description.',
): void {
  const work = new WorkItemRepository(connection);
  expectOk(
    work.appendScopeSnapshot({
      scope: scopeSnapshot(workItemId, description),
      attemptId: null,
      profileVersionId: PROFILE_VERSION_ID,
      procedureVersionId: PROCEDURE_VERSION_ID,
      capturedAt: '2026-01-02T03:01:00.000Z',
      correlationId: 'correlation-1',
    }),
  );
}

test('a revoked or rotated-away session is never returned as valid (F01-AC2)', async () => {
  await withDatabase(
    async ({ connection }) => {
      const owners = new OwnerRepository(connection);
      expectOk(owners.provision(OWNER_ID, 'Solo owner', '2026-01-01T00:00:00.000Z'));
      expectError(
        owners.provision(OWNER_ID, 'Someone else', '2026-01-01T00:00:00.000Z'),
        'Conflict',
      );

      const created = expectOk(
        owners.createSession({
          ownerId: OWNER_ID,
          token: SESSION_TOKEN,
          issuedAt: '2026-01-02T03:00:00.000Z',
          expiresAt: '2026-01-03T03:00:00.000Z',
        }),
      );
      assert.notEqual(created.tokenHash, SESSION_TOKEN);
      assert.equal(created.tokenHash, hashSessionToken(SESSION_TOKEN));
      assert.equal(created.revokedAt, null);
      assert.equal(
        created.lastSeenAt,
        '2026-01-02T03:00:00.000Z',
        'a new session must already carry an activity instant or the idle limit can never fire',
      );
      expectOk(owners.authenticate(SESSION_TOKEN, '2026-01-02T04:00:00.000Z'));

      const rotated = expectOk(
        owners.rotateSession({
          ownerId: OWNER_ID,
          token: SESSION_TOKEN,
          newToken: ROTATED_TOKEN,
          issuedAt: '2026-01-02T05:00:00.000Z',
          expiresAt: '2026-01-03T05:00:00.000Z',
        }),
      );
      assert.equal(rotated.rotatedFromSessionId, created.sessionId);
      assert.equal(rotated.lastSeenAt, '2026-01-02T05:00:00.000Z');
      expectError(owners.authenticate(SESSION_TOKEN, '2026-01-02T05:01:00.000Z'), 'Forbidden');
      expectOk(owners.authenticate(ROTATED_TOKEN, '2026-01-02T05:01:00.000Z'));

      expectOk(owners.revokeSession(ROTATED_TOKEN, '2026-01-02T06:00:00.000Z'));
      expectError(owners.authenticate(ROTATED_TOKEN, '2026-01-02T06:01:00.000Z'), 'Forbidden');
      expectOk(owners.revokeAllSessions(OWNER_ID, '2026-01-02T07:00:00.000Z'));
      expectError(owners.authenticate(ROTATED_TOKEN, '2026-01-02T07:01:00.000Z'), 'Forbidden');

      const expired = expectOk(
        owners.createSession({
          ownerId: OWNER_ID,
          token: 'ship-loop-expired-session-token-for-verification',
          issuedAt: '2026-01-02T03:00:00.000Z',
          expiresAt: '2026-01-02T04:00:00.000Z',
        }),
      );
      assert.equal(expired.revokedAt, null);
      expectError(
        owners.authenticate('ship-loop-expired-session-token-for-verification', '2026-01-02T04:00:01.000Z'),
        'Forbidden',
      );
    },
    async (file) => {
      const bytes = await readFile(file);
      const onDisk = bytes.toString('latin1');
      assert.ok(!onDisk.includes(SESSION_TOKEN), 'the session token must not be recoverable from the file');
      assert.ok(!onDisk.includes(ROTATED_TOKEN), 'the rotated token must not be recoverable from the file');
      assert.ok(onDisk.includes(hashSessionToken(SESSION_TOKEN)), 'the token digest must be stored instead');
    },
  );
});

test('a token minted by the domain authenticates through this repository (F01-AC2)', async () => {
  await withDatabase(async ({ connection }) => {
    const owners = new OwnerRepository(connection);
    expectOk(owners.provision(OWNER_ID, 'Solo owner', '2026-01-01T00:00:00.000Z'));

    const token = generateSessionToken();
    const created = expectOk(
      owners.createSession({
        ownerId: OWNER_ID,
        token,
        issuedAt: '2026-01-02T03:00:00.000Z',
        expiresAt: '2026-01-03T03:00:00.000Z',
      }),
    );

    assert.equal(created.tokenHash, hashSessionToken(token));
    assert.ok(
      verifySessionToken(token, created.tokenHash),
      'the domain digest function must be the only one this column ever holds, or no session can authorize',
    );
    const found = expectOk(owners.findSessionByToken(token));
    assert.equal(found?.sessionId, created.sessionId);
    assert.equal(expectOk(owners.findSessionByToken('a-different-token')), null);
  });
});

test('activity moves the idle deadline and revocation by identity is idempotent (F01-AC2)', async () => {
  await withDatabase(async ({ connection }) => {
    const owners = new OwnerRepository(connection);
    expectOk(owners.provision(OWNER_ID, 'Solo owner', '2026-01-01T00:00:00.000Z'));
    const created = expectOk(
      owners.createSession({
        ownerId: OWNER_ID,
        token: SESSION_TOKEN,
        issuedAt: '2026-01-02T03:00:00.000Z',
        expiresAt: '2026-01-03T03:00:00.000Z',
      }),
    );

    const touched = expectOk(owners.touchSession(created.sessionId, '2026-01-02T03:30:00.000Z'));
    assert.equal(touched.lastSeenAt, '2026-01-02T03:30:00.000Z');
    expectError(owners.touchSession('no-such-session', '2026-01-02T03:31:00.000Z'), 'NotFound');

    const revoked = expectOk(owners.revokeSessionById(created.sessionId, '2026-01-02T04:00:00.000Z'));
    assert.equal(revoked.revokedAt, '2026-01-02T04:00:00.000Z');
    assert.equal(revoked.lastSeenAt, '2026-01-02T03:30:00.000Z', 'revocation must not rewrite activity');
    const again = expectOk(owners.revokeSessionById(created.sessionId, '2026-01-02T05:00:00.000Z'));
    assert.equal(again.revokedAt, '2026-01-02T04:00:00.000Z', 'a retried sign-out keeps the first instant');
    expectError(owners.revokeSessionById('no-such-session', '2026-01-02T04:00:00.000Z'), 'NotFound');

    assert.equal(
      expectOk(owners.findSessionByToken(SESSION_TOKEN))?.revokedAt,
      '2026-01-02T04:00:00.000Z',
      'a revoked session still resolves, so the domain can be the one that refuses it (F01-AC2)',
    );
  });
});

test('a connector stores a credential reference and refuses a secret value (F03-AC2, F03-AC3)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const connectors = new ConnectorRepository(connection);
    const secretShaped = connectors.upsert({
      projectId: PROJECT,
      provider: 'linear',
      kind: 'Ticket',
      resourceScope: 'team ENG',
      credentialReference:
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0aWNrZXQifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
      declarations: CONNECTOR_DECLARATIONS,
      state: 'Healthy',
      error: null,
      at: '2026-01-02T03:00:00.000Z',
    });
    const rejected = expectError(secretShaped, 'Invalid');
    assert.ok(rejected.code === 'Invalid');
    assert.ok(rejected.fields.some((field) => field.path === 'credentialReference'));
    assert.match(rejected.fields[0]?.message ?? '', /jwt/);

    const saved = expectOk(
      connectors.upsert({
        projectId: PROJECT,
        provider: 'linear',
        kind: 'Ticket',
        resourceScope: 'team ENG',
        credentialReference: 'credential-store/ticket-primary',
        declarations: CONNECTOR_DECLARATIONS,
        state: 'Unconfigured',
        error: null,
        at: '2026-01-02T03:00:00.000Z',
      }),
    );
    assert.equal(saved.credentialReference, 'credential-store/ticket-primary');
    assert.equal(saved.lastSuccessAt, null);
    assert.equal(saved.lastCheckedAt, null);

    const healthy = expectOk(
      connectors.recordCheck(saved.connectorId, {
        checkedAt: '2026-01-02T03:05:00.000Z',
        succeeded: true,
        state: 'Healthy',
        error: null,
        declarations: null,
      }),
    );
    assert.equal(healthy.lastCheckedAt, '2026-01-02T03:05:00.000Z');
    assert.equal(healthy.lastSuccessAt, '2026-01-02T03:05:00.000Z');

    const degraded = expectOk(
      connectors.recordCheck(saved.connectorId, {
        checkedAt: '2026-01-02T03:06:00.000Z',
        succeeded: false,
        state: 'Degraded',
        error: 'The stored token was rejected.',
        declarations: null,
      }),
    );
    assert.equal(degraded.lastCheckedAt, '2026-01-02T03:06:00.000Z');
    assert.equal(degraded.lastSuccessAt, '2026-01-02T03:05:00.000Z');
    assert.equal(degraded.error, 'The stored token was rejected.');

    const capabilities = expectOk(connectors.capabilitySummary(saved.connectorId));
    assert.deepEqual(capabilities.reads, ['Ticket:ReadScope']);
    assert.deepEqual(capabilities.writes, ['Git:MergeWithPrecondition']);
    assert.deepEqual(capabilities.unsupported, [
      { kind: 'Deployment:Execute', limitation: 'Not offered by this provider.' },
    ]);

    const revoked = expectOk(connectors.revoke(saved.connectorId, '2026-01-02T03:07:00.000Z', 'Owner revoked access.'));
    assert.equal(revoked.state, 'Revoked');

    const found = expectOk(connectors.findByKind(PROJECT, 'Ticket'));
    assert.equal(found?.connectorId, saved.connectorId);
    expectError(connectors.get(ABSENT_CONNECTOR), 'NotFound');
  });
});

test('a proposed procedure improvement never changes what a run would read (F05-AC1, F05-AC4)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const procedures = new ProcedureRepository(connection);
    const first = expectOk(
      procedures.appendVersion({
        projectId: PROJECT,
        subjectKey: 'release.web',
        kind: 'Procedure',
        scope: 'project',
        source: 'Owner',
        sourceRevision: null,
        content: 'Merge with squash, then promote the preview deployment.',
        status: 'Accepted',
        createdAt: '2026-01-02T03:00:00.000Z',
        createdBy: OWNER,
        note: 'owner note',
        expectedVersionNumber: null,
      }),
    );
    assert.equal(first.lastVerifiedRevision, null);

    const verified = expectOk(procedures.recordVerification(first.procedureVersionId, 'r3', '2026-01-02T03:10:00.000Z'));
    assert.equal(verified.lastVerifiedRevision, 'r3');
    assert.equal(verified.lastVerifiedAt, '2026-01-02T03:10:00.000Z');

    const proposal = expectOk(
      procedures.appendVersion({
        projectId: PROJECT,
        subjectKey: 'release.web',
        kind: 'Procedure',
        scope: 'project',
        source: 'Repository',
        sourceRevision: null,
        content: 'Merge with rebase and skip the preview step.',
        status: 'Proposed',
        createdAt: '2026-01-02T04:00:00.000Z',
        createdBy: 'agent',
        note: 'agent suggestion: suggested during the last run.',
        expectedVersionNumber: 1,
      }),
    );
    assert.equal(proposal.versionNumber, 2);
    assert.equal(expectOk(procedures.listProposed(PROJECT)).length, 1);

    const stillCurrent = expectOk(procedures.currentVersion(PROJECT, 'release.web'));
    assert.equal(stillCurrent?.procedureVersionId, first.procedureVersionId);
    assert.equal(
      stillCurrent?.content,
      'Merge with squash, then promote the preview deployment.',
    );

    const accepted = expectOk(procedures.acceptVersion(proposal.procedureVersionId, '2026-01-02T05:00:00.000Z'));
    assert.equal(accepted.status, 'Accepted');
    assert.equal(accepted.acceptedAt, '2026-01-02T05:00:00.000Z');
    assert.equal(accepted.createdAt, '2026-01-02T04:00:00.000Z');
    assert.equal(proposal.acceptedAt, null);
    assert.equal(expectOk(procedures.currentVersion(PROJECT, 'release.web'))?.procedureVersionId, proposal.procedureVersionId);
    assert.equal(expectOk(procedures.getVersion(first.procedureVersionId)).status, 'Superseded');
    expectError(
      procedures.acceptVersion(first.procedureVersionId, '2026-01-02T05:01:00.000Z'),
      'Conflict',
    );
    assert.equal(expectOk(procedures.currentVersion(OTHER_PROJECT, 'release.web')), null);
  });
});

/** A procedure version to append, with only the field a case is about varied. */
function procedureInput(
  overrides: Partial<AppendProcedureVersionInput> & { readonly content: string },
): AppendProcedureVersionInput {
  return {
    projectId: PROJECT,
    subjectKey: 'release.web',
    kind: 'Procedure',
    scope: 'project',
    source: 'Owner',
    sourceRevision: null,
    status: 'Accepted',
    createdAt: '2026-01-02T03:00:00.000Z',
    createdBy: OWNER,
    note: null,
    expectedVersionNumber: null,
    ...overrides,
  };
}

test('a proposed procedure version is not what a run reads until the owner accepts it (F05-AC4)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const procedures = new ProcedureRepository(connection);

    // A proposal is the first version of its subject: there is nothing accepted
    // for a run to read, and the proposal must not stand in for it.
    const proposal = expectOk(
      procedures.appendVersion(
        procedureInput({
          content: 'Tag the release only after the preview deployment reports ready.',
          status: 'Proposed',
          createdBy: 'agent',
        }),
      ),
    );
    assert.equal(expectOk(procedures.currentVersion(PROJECT, 'release.web')), null);
    assert.deepEqual(
      expectOk(procedures.listProposed(PROJECT)).map((version) => version.procedureVersionId),
      [proposal.procedureVersionId],
    );

    // Accepting it is what makes it the version a later run is told.
    const accepted = expectOk(
      procedures.acceptVersion(proposal.procedureVersionId, '2026-01-02T04:00:00.000Z'),
    );
    assert.equal(accepted.status, 'Accepted');
    assert.equal(expectOk(procedures.currentVersion(PROJECT, 'release.web'))?.procedureVersionId, proposal.procedureVersionId);
    assert.deepEqual(expectOk(procedures.listProposed(PROJECT)), []);

    // A later proposal is again invisible: the accepted version stays current
    // until the owner saves the proposal as a new accepted version.
    const second = expectOk(
      procedures.appendVersion(
        procedureInput({
          content: 'Tag the release only after the preview deployment reports ready twice.',
          status: 'Proposed',
          createdAt: '2026-01-02T05:00:00.000Z',
          createdBy: 'agent',
          expectedVersionNumber: 1,
        }),
      ),
    );
    assert.equal(
      expectOk(procedures.currentVersion(PROJECT, 'release.web'))?.procedureVersionId,
      proposal.procedureVersionId,
    );
    assert.deepEqual(
      expectOk(procedures.listProposed(PROJECT)).map((version) => version.procedureVersionId),
      [second.procedureVersionId],
    );
  });
});

test('accepting a version supersedes the accepted version before it and keeps it readable (F05-AC4)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const procedures = new ProcedureRepository(connection);

    const first = expectOk(
      procedures.appendVersion(
        procedureInput({ content: 'Promote the preview after every merge.', createdAt: '2026-01-02T03:00:00.000Z' }),
      ),
    );
    const proposal = expectOk(
      procedures.appendVersion(
        procedureInput({
          content: 'Promote the preview after a green postflight check.',
          status: 'Proposed',
          createdAt: '2026-01-02T04:00:00.000Z',
          createdBy: 'agent',
          expectedVersionNumber: 1,
        }),
      ),
    );
    expectOk(procedures.acceptVersion(proposal.procedureVersionId, '2026-01-02T05:00:00.000Z'));

    const superseded = expectOk(procedures.getVersion(first.procedureVersionId));
    assert.equal(superseded.status, 'Superseded');
    // Superseding records what happened; it does not rewrite history. A run that
    // already referenced this version still finds the document it was given.
    assert.equal(superseded.content, 'Promote the preview after every merge.');
    assert.equal(superseded.acceptedAt, '2026-01-02T03:00:00.000Z');
    assert.equal(expectOk(procedures.currentVersion(PROJECT, 'release.web'))?.procedureVersionId, proposal.procedureVersionId);

    // Appending an accepted version directly supersedes the previous one too, so
    // exactly one version of a subject is ever current.
    const third = expectOk(
      procedures.appendVersion(
        procedureInput({
          content: 'Promote the preview after a green postflight check and a smoke test.',
          createdAt: '2026-01-02T06:00:00.000Z',
          expectedVersionNumber: 2,
        }),
      ),
    );
    assert.equal(expectOk(procedures.getVersion(proposal.procedureVersionId)).status, 'Superseded');
    assert.equal(expectOk(procedures.currentVersion(PROJECT, 'release.web'))?.procedureVersionId, third.procedureVersionId);
    assert.deepEqual(
      expectOk(procedures.listVersions(PROJECT, 'release.web')).map((version) => version.status),
      ['Superseded', 'Superseded', 'Accepted'],
    );
  });
});

test('the last verified revision and time round-trip on the version a run reads (F05-AC1)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const procedures = new ProcedureRepository(connection);

    const version = expectOk(
      procedures.appendVersion(
        procedureInput({
          content: '{"runtime":"node24"}',
          source: 'Repository',
          sourceRevision: '9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d',
        }),
      ),
    );
    assert.equal(version.sourceRevision, '9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d');
    assert.equal(version.lastVerifiedRevision, null);
    assert.equal(version.lastVerifiedAt, null);

    expectOk(
      procedures.recordVerification(version.procedureVersionId, 'sha256:abc123', '2026-01-02T07:30:00.000Z'),
    );

    // Read back from the store rather than from the returned record, so the
    // claim is about what was persisted.
    const reread = expectOk(procedures.getVersion(version.procedureVersionId));
    assert.equal(reread.lastVerifiedRevision, 'sha256:abc123');
    assert.equal(reread.lastVerifiedAt, '2026-01-02T07:30:00.000Z');
    assert.equal(expectOk(procedures.currentVersion(PROJECT, 'release.web'))?.lastVerifiedAt, '2026-01-02T07:30:00.000Z');
    const stored = connection
      .prepare('SELECT last_verified_revision, last_verified_at FROM procedure_versions WHERE procedure_version_id = ?')
      .get(version.procedureVersionId);
    assert.equal(stored?.['last_verified_revision'], 'sha256:abc123');
    assert.equal(stored?.['last_verified_at'], '2026-01-02T07:30:00.000Z');

    // A new version starts unverified: the older verification described
    // different content (F04-AC1).
    const next = expectOk(
      procedures.appendVersion(
        procedureInput({ content: '{"runtime":"node25"}', createdAt: '2026-01-02T08:00:00.000Z', expectedVersionNumber: 1 }),
      ),
    );
    assert.equal(next.lastVerifiedRevision, null);
    assert.equal(next.lastVerifiedAt, null);
  });
});

test('the schema refuses an accepted version with no approval time (F05-AC4)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const procedures = new ProcedureRepository(connection);

    // The invariant the repository relies on is the column's, not the method's: a
    // write that skipped appendVersion must still be refused. A NULL approval
    // time is refused, and so is an explicitly NULL one on an otherwise
    // identical row, so the refusal is the CHECK and not a side effect.
    const insert = connection.prepare(
      `INSERT INTO procedure_versions
         (procedure_version_id, project_id, subject_key, version, kind, scope, source, content_json,
          content_fingerprint, status, approved_at, created_at, created_by)
       VALUES (?, ?, 'release.web', 1, 'Procedure', 'project', 'Owner', ?, ?, 'Accepted', ?, ?, ?)`,
    );
    assert.throws(
      () =>
        insert.run(
          'procedure-direct-1',
          OTHER_PROJECT,
          'direct write',
          fingerprint({ direct: true }),
          null,
          '2026-01-02T03:00:00.000Z',
          OWNER,
        ),
      /status <> 'Accepted' OR approved_at IS NOT NULL/,
    );
    assert.equal(
      connection
        .prepare("SELECT count(*) AS rows FROM procedure_versions WHERE project_id = ? AND status = 'Accepted'")
        .get(OTHER_PROJECT)?.['rows'],
      0,
    );

    // The same row with an approval time is representable, and a proposal with no
    // approval time is what the owner's save action produces.
    insert.run(
      'procedure-direct-3',
      OTHER_PROJECT,
      'direct write',
      fingerprint({ direct: true }),
      '2026-01-02T03:00:00.000Z',
      '2026-01-02T03:00:00.000Z',
      OWNER,
    );
    assert.equal(
      expectOk(procedures.currentVersion(OTHER_PROJECT, 'release.web'))?.procedureVersionId,
      'procedure-direct-3',
    );
  });
});

test('appending with a stale expected version number is refused rather than overwriting (F05-AC4)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const procedures = new ProcedureRepository(connection);

    const first = expectOk(
      procedures.appendVersion(procedureInput({ content: 'First saved procedure.' })),
    );
    expectError(
      procedures.appendVersion(
        procedureInput({
          content: 'Written from a stale editor.',
          createdAt: '2026-01-02T04:00:00.000Z',
          expectedVersionNumber: 0,
        }),
      ),
      'Conflict',
    );
    // The refusal must not have written anything.
    assert.equal(expectOk(procedures.listVersions(PROJECT, 'release.web')).length, 1);

    expectOk(
      procedures.appendVersion(
        procedureInput({
          content: 'Second saved procedure.',
          createdAt: '2026-01-02T04:00:00.000Z',
          expectedVersionNumber: first.versionNumber,
        }),
      ),
    );
    assert.equal(expectOk(procedures.currentVersion(PROJECT, 'release.web'))?.content, 'Second saved procedure.');
  });
});

test('listProposed returns a project\'s proposals oldest first and ignores another project (F05-AC4)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const procedures = new ProcedureRepository(connection);

    const first = expectOk(
      procedures.appendVersion(
        procedureInput({
          content: 'First proposal.',
          status: 'Proposed',
          createdAt: '2026-01-02T07:00:00.000Z',
          createdBy: 'agent',
        }),
      ),
    );
    // Two proposals sharing one timestamp are ordered by version, so the order
    // the owner reads them in does not depend on which row SQLite returns first.
    const second = expectOk(
      procedures.appendVersion(
        procedureInput({
          content: 'Second proposal.',
          status: 'Proposed',
          createdAt: '2026-01-02T07:00:00.000Z',
          createdBy: 'agent',
          expectedVersionNumber: first.versionNumber,
        }),
      ),
    );
    const third = expectOk(
      procedures.appendVersion(
        procedureInput({
          content: 'Third proposal.',
          status: 'Proposed',
          createdAt: '2026-01-02T09:00:00.000Z',
          createdBy: 'agent',
          expectedVersionNumber: second.versionNumber,
        }),
      ),
    );
    assert.deepEqual(
      expectOk(procedures.listVersions(PROJECT, 'release.web')).map((version) => version.versionNumber),
      [1, 2, 3],
    );
    expectOk(
      procedures.appendVersion(
        procedureInput({
          projectId: OTHER_PROJECT,
          content: 'Another project\'s proposal.',
          status: 'Proposed',
          createdAt: '2026-01-02T07:30:00.000Z',
          createdBy: 'agent',
        }),
      ),
    );

    assert.deepEqual(
      expectOk(procedures.listProposed(PROJECT)).map((version) => version.procedureVersionId),
      [first.procedureVersionId, second.procedureVersionId, third.procedureVersionId],
    );
    assert.equal(expectOk(procedures.listProposed(OTHER_PROJECT)).length, 1);
  });
});

test('two subjects of one project each hold version 1 and advance independently (F05-AC1, F05-AC3)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const procedures = new ProcedureRepository(connection);

    // `appendVersion` numbers per subject, so these two writes are each a subject's
    // first version. Under the project-wide uniqueness the second was refused, which
    // left one subject's first version able to make every other subject unstorable
    // (F05-AC3).
    const releaseFirst = expectOk(
      procedures.appendVersion(
        procedureInput({ content: 'Merge with squash, then promote the preview.' }),
      ),
    );
    const environmentFirst = expectOk(
      procedures.appendVersion(
        procedureInput({
          subjectKey: 'environment.recipe',
          scope: 'Environment',
          content: 'Run pnpm verify:app on node 24 before promoting.',
        }),
      ),
    );
    assert.equal(releaseFirst.versionNumber, 1);
    assert.equal(environmentFirst.versionNumber, 1);
    assert.notEqual(releaseFirst.procedureVersionId, environmentFirst.procedureVersionId);

    // Each subject reads only its own current version, and the numbers move per subject:
    // advancing one must not renumber the other, and must not make it unwritable.
    const environmentSecond = expectOk(
      procedures.appendVersion(
        procedureInput({
          subjectKey: 'environment.recipe',
          scope: 'Environment',
          content: 'Run pnpm verify:app and the browser suite on node 24.',
        }),
      ),
    );
    assert.equal(environmentSecond.versionNumber, 2);
    assert.equal(expectOk(procedures.currentVersion(PROJECT, 'environment.recipe'))?.procedureVersionId, environmentSecond.procedureVersionId);
    assert.equal(expectOk(procedures.currentVersion(PROJECT, 'release.web'))?.procedureVersionId, releaseFirst.procedureVersionId);

    const releaseSecond = expectOk(
      procedures.appendVersion(
        procedureInput({ content: 'Merge with squash, promote the preview, then record the receipt.' }),
      ),
    );
    assert.equal(releaseSecond.versionNumber, 2, 'the release subject advanced on its own numbering');

    // Superseding one subject leaves the other exactly as it was.
    assert.deepEqual(
      expectOk(procedures.listVersions(PROJECT, 'environment.recipe')).map((version) => [
        version.versionNumber,
        version.status,
      ]),
      [
        [1, 'Superseded'],
        [2, 'Accepted'],
      ],
    );
    assert.deepEqual(
      expectOk(procedures.listVersions(PROJECT, 'release.web')).map((version) => version.versionNumber),
      [1, 2],
    );

    // The optimistic check is per subject too: a write prepared against a version this
    // subject has moved past is refused rather than appended over it.
    expectError(
      procedures.appendVersion(
        procedureInput({
          content: 'A rewrite prepared against a version this subject has moved past.',
          expectedVersionNumber: 1,
        }),
      ),
      'Conflict',
    );
  });
});

test('the migrated procedure_versions columns are exactly the ones the repository reads', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const columns = connection.prepare('PRAGMA table_info(procedure_versions)').all();

    // One column per concept. The columns versions 1 to 7 carried for a second
    // name are gone, so a reader cannot pick the wrong one and a writer cannot
    // fill a column nothing reads.
    assert.deepEqual(
      columns.map((column) => column['name']),
      [
        'procedure_version_id',
        'project_id',
        'subject_key',
        'version',
        'kind',
        'scope',
        'source',
        'source_revision',
        'content_json',
        'content_fingerprint',
        'status',
        'last_verified_revision',
        'last_verified_at',
        'approved_at',
        'created_at',
        'created_by',
        'note',
      ],
    );

    const notNull = new Map(
      columns.map((column) => [String(column['name']), column['notnull']] as const),
    );
    // The repository binds these on every write, so the column refuses a NULL.
    assert.equal(notNull.get('subject_key'), 1);
    assert.equal(notNull.get('scope'), 1);
    assert.equal(notNull.get('created_by'), 1);
    assert.equal(notNull.get('status'), 1);
    // A fact may have no source revision, a version is unverified until something
    // verifies it, and a note is optional.
    assert.equal(notNull.get('source_revision'), 0);
    assert.equal(notNull.get('last_verified_revision'), 0);
    assert.equal(notNull.get('last_verified_at'), 0);
    assert.equal(notNull.get('note'), 0);
  });
});

test('raw intake stays distinct from generated material and archiving creates no ticket (F06-AC1, F06-AC5)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const ideas = new IdeaRepository(connection);
    const idea = expectOk(
      ideas.capture({
        projectId: PROJECT,
        kind: 'Bug',
        rawRequest: 'The saved run disappears when the browser closes.',
        notes: 'Happened twice on the preview project.',
        bugExpected: 'The run resumes after a restart.',
        bugActual: 'The run list is empty.',
        bugReproduction: 'Start a run, close the tab, reopen it.',
        capturedAt: '2026-01-02T03:00:00.000Z',
      }),
    );
    assert.equal(idea.state, 'Received');
    assert.equal(idea.generatedSummary, null);
    assert.equal(idea.agreedBrief, null);
    assert.deepEqual(idea.openQuestions, []);

    expectError(
      ideas.capture({
        projectId: null,
        kind: 'FeatureRequest',
        rawRequest: '   ',
        notes: null,
        bugExpected: null,
        bugActual: null,
        bugReproduction: null,
        capturedAt: '2026-01-02T03:00:00.000Z',
      }),
      'Invalid',
    );

    const summarised = expectOk(
      ideas.recordSummary(idea.ideaId, 'Durable runs survive a browser restart.', '2026-01-02T03:05:00.000Z'),
    );
    assert.equal(summarised.generatedSummary, 'Durable runs survive a browser restart.');
    assert.equal(summarised.rawRequest, 'The saved run disappears when the browser closes.');

    const clarified = expectOk(
      ideas.recordAgreedBrief(idea.ideaId, 'Runs persist in SQLite and reconcile on startup.', ['Which page owns the resume button?'], '2026-01-02T03:20:00.000Z'),
    );
    assert.equal(clarified.state, 'Planned');
    assert.deepEqual(clarified.openQuestions, ['Which page owns the resume button?']);

    const attachment = expectOk(
      ideas.addAttachment({
        ideaId: idea.ideaId,
        fileName: 'empty-run-list.png',
        mediaType: 'image/png',
        byteSize: 20481,
        contentDigest: 'sha256:1f0c',
        relativePath: 'artifacts/ideas/empty-run-list.png',
        createdAt: '2026-01-02T03:06:00.000Z',
      }),
    );
    assert.equal(attachment.relativePath, 'artifacts/ideas/empty-run-list.png');
    assert.equal(expectOk(ideas.listAttachments(idea.ideaId)).length, 1);

    const archived = expectOk(ideas.archive(idea.ideaId, 'Superseded by the reliability slice.', '2026-01-02T04:00:00.000Z'));
    assert.equal(archived.state, 'Abandoned');
    assert.equal(archived.publishedWorkItemId, null);
    assert.equal(
      connection.prepare('SELECT COUNT(*) AS total FROM work_items').get()?.total,
      0,
    );

    const published = expectOk(ideas.capture({
      projectId: PROJECT,
      kind: 'FeatureRequest',
      rawRequest: 'Ship the release receipt page.',
      notes: null,
      bugExpected: null,
      bugActual: null,
      bugReproduction: null,
      capturedAt: '2026-01-02T05:00:00.000Z',
    }));
    const work = new WorkItemRepository(connection);
    const item = expectOk(
      work.create({
        projectId: PROJECT,
        profileVersionId: PROFILE_VERSION_ID,
        source: 'CapturedIdea',
        title: 'Ship the release receipt page',
        externalIssueId: 'issue-9',
        externalIssueIdentifier: 'ENG-9',
        externalIssueUrl: 'https://linear.example.test/ENG-9',
        publicationIntent: 'PublishWhenAgreed',
        relatedWorkItemIds: [],
        adoption: null,
        at: '2026-01-02T05:01:00.000Z',
      }),
    );
    expectOk(ideas.markPublished(published.ideaId, item.workItemId, '2026-01-02T05:02:00.000Z'));
    expectError(ideas.archive(published.ideaId, 'Changed my mind.', '2026-01-02T05:03:00.000Z'), 'Conflict');
  });
});

test('publication intent stays separate from confirmed publication and a failed sync stays labelled (F16-AC4)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const work = new WorkItemRepository(connection);
    const created = expectOk(
      work.create({
        projectId: PROJECT,
        profileVersionId: PROFILE_VERSION_ID,
        source: 'ProposedNewIssue',
        title: 'Publish agreed work',
        externalIssueId: null,
        externalIssueIdentifier: null,
        externalIssueUrl: null,
        publicationIntent: 'PublishWhenAgreed',
        relatedWorkItemIds: ['work-item-other'],
        adoption: null,
        at: '2026-01-02T03:00:00.000Z',
      }),
    );
    assert.equal(created.publicationIntent, 'PublishWhenAgreed');
    assert.equal(created.publicationState, 'Unpublished');
    assert.deepEqual(created.relatedWorkItemIds, ['work-item-other']);
    assert.equal(expectOk(work.getSync(created.workItemId)), null);

    const duplicate = work.create({
      projectId: PROJECT,
      profileVersionId: PROFILE_VERSION_ID,
      source: 'AdoptedIssue',
      title: 'Adopt the same issue',
      externalIssueId: 'issue-77',
      externalIssueIdentifier: 'ENG-77',
      externalIssueUrl: null,
      publicationIntent: 'DoNotPublish',
      relatedWorkItemIds: [],
      adoption: {
        repository: 'shiploop/example-app',
        headSha: HEAD_SHA,
        targetBranch: 'main',
        pullRequestId: 'pr-42',
      },
      at: '2026-01-02T03:01:00.000Z',
    });
    const firstAdoption = expectOk(duplicate);
    assert.equal(firstAdoption.adoption?.pullRequestId, 'pr-42');
    const secondAdoption = work.create({
      projectId: PROJECT,
      profileVersionId: PROFILE_VERSION_ID,
      source: 'AdoptedIssue',
      title: 'Adopt the same issue again',
      externalIssueId: 'issue-77',
      externalIssueIdentifier: 'ENG-77',
      externalIssueUrl: null,
      publicationIntent: 'DoNotPublish',
      relatedWorkItemIds: [],
      adoption: null,
      at: '2026-01-02T03:02:00.000Z',
    });
    expectError(secondAdoption, 'Conflict');
    assert.equal(expectOk(work.findByExternalIssueId('issue-missing')), null);
    assert.equal(expectOk(work.findByExternalIssueId('issue-77'))?.workItemId, firstAdoption.workItemId);

    const lost = expectOk(
      work.recordPublication(created.workItemId, 'OutcomeUnknown', 'operation-7', '2026-01-02T03:10:00.000Z'),
    );
    assert.equal(lost.publicationState, 'OutcomeUnknown');
    assert.equal(lost.publicationOperationId, 'operation-7');
    assert.equal(lost.publicationIntent, 'PublishWhenAgreed');

    const reconciled = expectOk(
      work.recordPublication(created.workItemId, 'Published', 'operation-7', '2026-01-02T03:20:00.000Z'),
    );
    assert.equal(reconciled.publicationState, 'Published');
    assert.equal(reconciled.publicationIntent, 'Published');

    expectOk(
      work.recordSyncResult({
        workItemId: created.workItemId,
        attemptedAt: '2026-01-02T03:21:00.000Z',
        succeeded: true,
        error: null,
      }),
    );
    const failed = expectOk(
      work.recordSyncResult({
        workItemId: created.workItemId,
        attemptedAt: '2026-01-02T03:22:00.000Z',
        succeeded: false,
        error: 'The managed comment was rejected.',
      }),
    );
    assert.equal(failed.state, 'PendingSync');
    assert.equal(failed.lastSuccessAt, '2026-01-02T03:21:00.000Z');
    assert.equal(failed.attemptCount, 2);
    assert.equal(failed.lastError, 'The managed comment was rejected.');
  });
});

test('acceptance and authorization are separate single-use decisions bound to a fingerprint (F25, F26-AC1, F27-AC3)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const work = new WorkItemRepository(connection);
    const item = expectOk(
      work.create({
        projectId: PROJECT,
        profileVersionId: PROFILE_VERSION_ID,
        source: 'CapturedIdea',
        title: 'Deliver reviewed work',
        externalIssueId: null,
        externalIssueIdentifier: null,
        externalIssueUrl: null,
        publicationIntent: 'PublishWhenAgreed',
        relatedWorkItemIds: [],
        adoption: null,
        at: '2026-01-02T03:00:00.000Z',
      }),
    );
    captureSnapshot(connection, item.workItemId);
    const candidates = new CandidateRepository(connection);
    const candidate = expectOk(
      candidates.record({
        attemptId: null,
        workItemId: item.workItemId,
        identity: candidateIdentity(HEAD_SHA),
        pullRequestId: 'pr-42',
        targetBranch: 'main',
        recordedAt: '2026-01-02T03:01:00.000Z',
        correlationId: 'correlation-1',
      }),
    );
    const otherFingerprint = ABSENT_FINGERPRINT;

    const decisions = new OwnerDecisionRepository(connection);
    const acceptance = expectOk(
      decisions.recordAcceptance({
        workItemId: item.workItemId,
        candidateFingerprint: candidate.candidateFingerprint,
        scopeFingerprint: SCOPE_FINGERPRINT,
        actorOwnerId: OWNER_ID,
        note: 'Tested against the preview deployment.',
        createdAt: '2026-01-02T03:30:00.000Z',
        correlationId: 'correlation-1',
      }),
    );
    assert.equal(acceptance.decisionType, 'AcceptProduct');
    assert.equal(acceptance.acceptanceState, 'Accepted');
    assert.equal(acceptance.subject, null);
    assert.equal(acceptance.subjectFingerprint, null);
    assert.equal(acceptance.state, 'Recorded');

    const changes = expectOk(
      decisions.recordChangesRequested({
        workItemId: item.workItemId,
        candidateFingerprint: candidate.candidateFingerprint,
        scopeFingerprint: SCOPE_FINGERPRINT,
        actorOwnerId: OWNER_ID,
        feedback: 'The empty state still flashes.',
        createdAt: '2026-01-02T03:31:00.000Z',
        correlationId: 'correlation-1',
      }),
    );
    assert.equal(changes.note, 'The empty state still flashes.');

    const subject: AuthorizationSubject = {
      action: { kind: 'Merge', mergeMethod: 'Squash' },
      destination: 'production',
      pullRequestId: 'pr-42',
      headSha: HEAD_SHA,
      targetBranch: 'main',
      candidateFingerprint: candidate.candidateFingerprint,
      componentDeployments: [{ component: 'web', deploymentId: 'deployment-1' }],
    };
    const authorization = expectOk(
      decisions.authorize({
        workItemId: item.workItemId,
        candidateFingerprint: candidate.candidateFingerprint,
        scopeFingerprint: SCOPE_FINGERPRINT,
        actorOwnerId: OWNER_ID,
        decisionType: 'AuthorizeMerge',
        subject,
        note: null,
        createdAt: '2026-01-02T03:40:00.000Z',
        correlationId: 'correlation-1',
      }),
    );
    assert.equal(authorization.decisionType, 'AuthorizeMerge');
    assert.equal(authorization.acceptanceState, null, 'an authorization carries no acceptance state');
    assert.equal(authorization.subjectFingerprint?.startsWith('fp_'), true);

    assert.equal(expectOk(decisions.listUnconsumed(candidate.candidateFingerprint)).length, 3);
    assert.equal(expectOk(decisions.listUnconsumed(otherFingerprint)).length, 0);

    const consumed = expectOk(decisions.consume(authorization.decisionId, '2026-01-02T03:41:00.000Z'));
    assert.equal(consumed.state, 'Consumed');
    assert.equal(consumed.consumedAt, '2026-01-02T03:41:00.000Z');
    expectError(decisions.consume(authorization.decisionId, '2026-01-02T03:42:00.000Z'), 'Conflict');
    expectError(decisions.invalidate(authorization.decisionId, 'Replayed request.', '2026-01-02T03:43:00.000Z'), 'Conflict');

    const invalidated = expectOk(decisions.invalidate(acceptance.decisionId, 'Head changed.', '2026-01-02T03:44:00.000Z'));
    assert.equal(invalidated.state, 'Invalidated');
    assert.equal(invalidated.invalidatedReason, 'Head changed.');
    assert.equal(expectOk(decisions.listForWorkItem(item.workItemId)).length, 3);

    const unknownActor = decisions.recordAcceptance({
      workItemId: item.workItemId,
      candidateFingerprint: candidate.candidateFingerprint,
      scopeFingerprint: SCOPE_FINGERPRINT,
      actorOwnerId: 'owner-that-was-never-provisioned' as OwnerId,
      note: null,
      createdAt: '2026-01-02T03:45:00.000Z',
      correlationId: null,
    });
    assert.equal(unknownActor.ok, false, 'a decision must be attributable to a provisioned owner');
    if (unknownActor.ok) throw new Error('unreachable');
    assert.equal(unknownActor.error.code, 'Unavailable');
  });
});

test('an owner without a provisioned identity cannot obtain a session (F01-AC1)', async () => {
  await withDatabase(async ({ connection }) => {
    // Deliberately NOT seeded: this test is about an owner that does not exist,
    // so provisioning one here would make it prove nothing.
    const owners = new OwnerRepository(connection);
    expectError(
      owners.createSession({
        ownerId: OWNER_ID,
        token: SESSION_TOKEN,
        issuedAt: '2026-01-02T03:00:00.000Z',
        expiresAt: '2026-01-03T03:00:00.000Z',
      }),
      'NotFound',
    );
    assert.equal(expectOk(owners.current()), null);
  });
});
/**
 * The security invariants, asserted against the REAL migrated schema.
 *
 * Every case here is a property the database itself has to hold, not a property
 * a repository method happens to check. That distinction is the point: the
 * repositories are one caller, and a caller that forgets a check must not be
 * able to write a row the schema forbids. Each test therefore either drives a
 * repository to attempt the forbidden write, or writes the row directly to show
 * the column refuses it.
 */

/**
 * Reads a column a test needs as a bind parameter.
 *
 * `SqlRow` is an index signature, so a lookup is `SqlValue | undefined` under
 * `noUncheckedIndexedAccess`. These columns are written by a row the test just
 * inserted, so an absent one is a test bug rather than a case to handle: saying
 * so is better than coercing an optional value into a bind parameter.
 */
function requiredColumn(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    assert.fail(`expected column ${column} to be present and textual`);
  }
  return value;
}

/** A candidate, its scope snapshot and its work item, ready for the checks below. */
function seedCandidate(
  connection: Database,
  headSha: string,
): { readonly workItemId: WorkItemId; readonly candidateFingerprint: Fingerprint } {
  const work = new WorkItemRepository(connection);
  const item = expectOk(
    work.create({
      projectId: PROJECT,
      profileVersionId: PROFILE_VERSION_ID,
      source: 'CapturedIdea',
      title: 'Security fixture work',
      externalIssueId: null,
      externalIssueIdentifier: null,
      externalIssueUrl: null,
      publicationIntent: 'PublishWhenAgreed',
      relatedWorkItemIds: [],
      adoption: null,
      at: '2026-02-01T03:00:00.000Z',
    }),
  );
  captureSnapshot(connection, item.workItemId);
  const candidate = expectOk(
    new CandidateRepository(connection).record({
      attemptId: null,
      workItemId: item.workItemId,
      identity: candidateIdentity(headSha),
      pullRequestId: 'pr-42',
      targetBranch: 'main',
      recordedAt: '2026-02-01T03:01:00.000Z',
      correlationId: 'correlation-1',
    }),
  );
  return { workItemId: item.workItemId, candidateFingerprint: candidate.candidateFingerprint };
}

test('an abbreviated commit SHA is refused by the candidate column (F17-AC2, F20-AC3)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const { workItemId } = seedCandidate(connection, HEAD_SHA);

    // The repository cannot even be handed an abbreviation: the domain brands a
    // commit SHA, so an abbreviation is not a value the type admits.
    const abbreviated = 'abc1234';
    assert.throws(() => asCommitSha(abbreviated), /Not a full commit SHA/);

    // And if a caller bypasses the type and writes the column directly, the
    // schema refuses, which is the guarantee the JSON blob used to bypass.
    const candidate = connection
      .prepare('SELECT candidate_id, project_id, scope_snapshot_id, profile_version_id, procedure_version_id FROM candidates WHERE work_item_id = ?')
      .get(workItemId);
    assert.ok(candidate !== undefined);
    assert.throws(
      () =>
        connection
          .prepare(
            `INSERT INTO candidates (candidate_id, work_item_id, project_id, scope_snapshot_id, profile_version_id, procedure_version_id, fingerprint, head_sha, base_sha, scope_fingerprint, environment_fingerprint, policy_fingerprint)
             VALUES ('abbreviated-sha', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            workItemId as string,
            requiredColumn(candidate, 'project_id'),
            requiredColumn(candidate, 'scope_snapshot_id'),
            requiredColumn(candidate, 'profile_version_id'),
            requiredColumn(candidate, 'procedure_version_id'),
            SCOPE_FINGERPRINT,
            abbreviated,
            BASE_SHA,
            SCOPE_FINGERPRINT,
            ENVIRONMENT_FINGERPRINT,
            POLICY_FINGERPRINT,
          ),
      /CHECK constraint failed: length\(head_sha\)/,
      'the column, not the caller, is what refuses an abbreviated SHA',
    );
  });
});

test('a NotApplicable check result is refused without a policy approval (F20-AC5)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const { workItemId, candidateFingerprint } = seedCandidate(connection, HEAD_SHA);
    const candidate = connection
      .prepare('SELECT candidate_id, project_id FROM candidates WHERE work_item_id = ?')
      .get(workItemId);
    assert.ok(candidate !== undefined);

    const insert = (approved: number): unknown =>
      connection
        .prepare(
          `INSERT INTO checks (check_id, candidate_id, work_item_id, project_id, candidate_fingerprint, name, origin, required, result, not_applicable_approved_by_policy, started_at)
           VALUES (?, ?, ?, ?, ?, 'not-configured', 'LocalCheck', 1, 'NotApplicable', ?, '2026-02-01T04:00:00.000Z')`,
        )
        .run(
          approved === 1 ? 'check-approved' : 'check-unapproved',
          requiredColumn(candidate, 'candidate_id'),
          workItemId,
          requiredColumn(candidate, 'project_id'),
          candidateFingerprint,
          approved,
        );

    assert.throws(
      () => insert(0),
      /CHECK constraint failed: result <> 'NotApplicable' OR not_applicable_approved_by_policy = 1/,
      'a model cannot mark a required check NotApplicable; only a policy decision can',
    );
    insert(1);
  });
});

test('an authorization without a subject fingerprint is refused (F26-AC1, R3)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const { workItemId, candidateFingerprint } = seedCandidate(connection, HEAD_SHA);
    const scopeSnapshot = connection
      .prepare('SELECT scope_snapshot_id FROM scope_snapshots WHERE work_item_id = ?')
      .get(workItemId);
    assert.ok(scopeSnapshot !== undefined);

    const insert = (subject: string | null): unknown =>
      connection
        .prepare(
          `INSERT INTO owner_decisions (decision_id, project_id, actor_owner_id, decision_type, subject_fingerprint, subject_json, correlation_id, decided_at, scope_snapshot_id, candidate_fingerprint, scope_fingerprint)
           VALUES (?, ?, ?, 'AuthorizeMerge', ?, '{}', 'correlation-1', '2026-02-01T05:00:00.000Z', ?, ?, ?)`,
        )
        .run(
          subject === null ? 'authorize-without-subject' : 'authorize-with-subject',
          PROJECT,
          OWNER_ID,
          subject,
          requiredColumn(scopeSnapshot, 'scope_snapshot_id'),
          candidateFingerprint,
          SCOPE_FINGERPRINT,
        );

    assert.throws(
      () => insert(null),
      /CHECK constraint failed: decision_type NOT IN/,
      'an authorization must name the subject it authorizes',
    );
    insert(SCOPE_FINGERPRINT);
  });
});

test('an acceptance may not carry an acceptance state on an authorization (F25)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const { workItemId } = seedCandidate(connection, HEAD_SHA);
    const scopeSnapshot = connection
      .prepare('SELECT scope_snapshot_id FROM scope_snapshots WHERE work_item_id = ?')
      .get(workItemId);
    assert.ok(scopeSnapshot !== undefined);

    assert.throws(
      () =>
        connection
          .prepare(
            `INSERT INTO owner_decisions (decision_id, project_id, actor_owner_id, decision_type, acceptance_state, subject_fingerprint, subject_json, correlation_id, decided_at, scope_snapshot_id)
             VALUES ('authorization-with-acceptance', ?, ?, 'AuthorizeRelease', 'Accepted', ?, '{}', 'correlation-1', '2026-02-01T05:00:00.000Z', ?)`,
          )
          .run(PROJECT, OWNER_ID, SCOPE_FINGERPRINT, requiredColumn(scopeSnapshot, 'scope_snapshot_id')),
      /CHECK constraint failed: decision_type IN \('AcceptProduct', 'RequestChanges'\) OR acceptance_state IS NULL/,
      'an authorization says what may be done, not whether the product is accepted',
    );
  });
});

test('a second job with the same operation identity is refused (F13-AC2)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const insert = (jobId: string): unknown =>
      connection
        .prepare(
          `INSERT INTO jobs (job_id, work_item_id, project_id, scope_snapshot_id, profile_version_id, procedure_version_id, mode, operation_id, correlation_id, queued_at)
           VALUES (?, 'work-item-fixture', ?, 'snap-fixture', ?, ?, 'Build', 'operation-fixture', 'correlation-1', '2026-02-01T06:00:00.000Z')`,
        )
        .run(jobId, PROJECT, PROFILE_VERSION_ID, PROCEDURE_VERSION_ID);

    // The parents a job row references, created here so this test is about the
    // unique operation identity and nothing else.
    connection
      .prepare("INSERT INTO work_items (work_item_id, project_id, issue_id, publication_intent, origin) VALUES ('work-item-fixture', ?, 'issue-fixture', 'PublishWhenAgreed', 'Proposed')")
      .run(PROJECT);
    connection
      .prepare(
        `INSERT INTO scope_snapshots (scope_snapshot_id, work_item_id, project_id, issue_id, description, scope_fingerprint, retrieved_at)
         VALUES ('snap-fixture', 'work-item-fixture', ?, 'issue-fixture', 'Fixture scope', ?, '2026-02-01T06:00:00.000Z')`,
      )
      .run(PROJECT, SCOPE_FINGERPRINT);

    insert('job-fixture-1');
    assert.throws(
      () => insert('job-fixture-2'),
      /UNIQUE constraint failed: jobs\.operation_id/,
      'one operation identity starts one job, so a retry cannot start a second',
    );
  });
});

test('a second active coding slot is refused (F13-AC2, F14-AC1)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    // The coding slot is a singleton row: the schema makes a second writer
    // unrepresentable rather than relying on the queue to check.
    assert.throws(
      () =>
        connection
          .prepare('INSERT INTO coding_slots (slot_id, holder) VALUES (2, ?)')
          .run('writer-b'),
      /CHECK constraint failed: slot_id = 1/,
    );
    // And a workspace port belongs to exactly one workspace, so a collision
    // surfaces as a refusal rather than a second service answering (F14-AC3).
    connection
      .prepare('INSERT INTO workspace_ports (workspace_id, service_name, port, job_id, holder, reserved_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('ws-a', 'web', 5173, 'job-a', 'writer-a', '2026-02-01T07:00:00.000Z');
    assert.throws(
      () =>
        connection
          .prepare('INSERT INTO workspace_ports (workspace_id, service_name, port, job_id, holder, reserved_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run('ws-b', 'web', 5173, 'job-b', 'writer-b', '2026-02-01T07:00:01.000Z'),
      /UNIQUE constraint failed: workspace_ports\.port/,
    );
  });
});

test('evidence for one candidate fingerprint is never returned for another (F20-AC3, F25-AC3)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const first = seedCandidate(connection, HEAD_SHA);
    const replacement = seedCandidate(connection, OTHER_HEAD_SHA);

    const evidence = new EvidenceRepository(connection);
    const recorded = expectOk(
      evidence.record({
        candidateFingerprint: first.candidateFingerprint,
        kind: 'CheckResult',
        criterionId: 'ac1',
        checkId: 'typecheck',
        checkName: 'Type check',
        result: 'Passed',
        observedAt: '2026-02-01T08:00:00.000Z',
        environmentFingerprint: ENVIRONMENT_FINGERPRINT,
        scopeFingerprint: SCOPE_FINGERPRINT,
        artifactRef: 'artifacts/checks/typecheck.log',
        detail: null,
        recordedAt: '2026-02-01T08:00:01.000Z',
        correlationId: 'correlation-1',
      }),
    );
    assert.equal(recorded.candidateFingerprint, first.candidateFingerprint);
    assert.equal(recorded.result, 'Passed');

    assert.equal(expectOk(evidence.listForCandidate(first.candidateFingerprint)).length, 1);
    assert.equal(
      expectOk(evidence.listForCandidate(replacement.candidateFingerprint)).length,
      0,
      'a replacement build must not inherit the previous build green results',
    );
    assert.equal(
      expectOk(evidence.listForCriterion(replacement.candidateFingerprint, 'ac1')).length,
      0,
    );
  });
});

test('an owner credential is stored as a digest, never as a password (F01-AC1, R2)', async () => {
  await withDatabase(async ({ connection }) => {
    const owners = new OwnerRepository(connection);
    const provisioned = expectOk(
      owners.provision(OWNER_ID, 'Solo owner', '2026-01-01T00:00:00.000Z', {
        ownerId: OWNER_ID,
        email: 'Owner@Example.test',
        passwordDigest: PASSWORD_DIGEST,
      }),
    );
    assert.equal(provisioned.email, 'owner@example.test', 'the address is normalised for sign-in');

    // One statement resolves either name an owner may sign in with, and an
    // unknown one costs the same query (N02-AC1).
    assert.equal(expectOk(owners.findBySignInIdentifier('  solo OWNER '))?.ownerId, OWNER_ID);
    assert.equal(expectOk(owners.findBySignInIdentifier('OWNER@EXAMPLE.TEST'))?.ownerId, OWNER_ID);
    assert.equal(expectOk(owners.findBySignInIdentifier('nobody@example.test')), null);

    // R2: a locally provisioned owner has no identity-provider subject, and the
    // column says so rather than holding a substitute value.
    const row = connection
      .prepare('SELECT identity_subject, password_digest FROM owners WHERE owner_id = ?')
      .get(OWNER_ID);
    assert.equal(row?.['identity_subject'], null, 'the column must not lie about what it holds');
    assert.equal(row?.['password_digest'], PASSWORD_DIGEST);
  });
});

test('provisioning cannot leave an owner without a credential, and cannot be retried into one (F01-AC1)', async () => {
  await withDatabase(async ({ connection }) => {
    const owners = new OwnerRepository(connection);
    connection.prepare('INSERT INTO owners (owner_id, identity_subject, display_name, created_at) VALUES (?, ?, ?, ?)').run(
      OWNER_ID,
      null,
      'Interrupted owner',
      '2026-01-01T00:00:00.000Z',
    );

    const recovered = expectOk(
      owners.provision(OWNER_ID, 'Recovered owner', '2026-01-05T00:00:00.000Z', {
        ownerId: OWNER_ID,
        email: 'Owner@Example.test',
        passwordDigest: PASSWORD_DIGEST,
      }),
    );
    assert.equal(recovered.createdAt, '2026-01-01T00:00:00.000Z', 'the original row is kept, not duplicated');

    expectError(
      owners.provision(OWNER_ID, 'Someone else', '2026-01-06T00:00:00.000Z', {
        ownerId: OWNER_ID,
        email: 'Other@Example.test',
        passwordDigest: PASSWORD_DIGEST,
      }),
      'Conflict',
    );
    expectError(
      owners.provision(OTHER_OWNER_ID, 'Someone else', '2026-01-06T00:00:00.000Z', {
        ownerId: OTHER_OWNER_ID,
        email: 'OWNER@example.test',
        passwordDigest: PASSWORD_DIGEST,
      }),
      'Conflict',
    );

    const stored = connection.prepare('SELECT display_name, password_digest FROM owners WHERE owner_id = ?').get(
      OWNER_ID,
    );
    assert.equal(stored?.['display_name'], 'Recovered owner');
    assert.equal(stored?.['password_digest'], PASSWORD_DIGEST, 'a refused retry must not reset the credential');
  });
});
