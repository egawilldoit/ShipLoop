/**
 * Behavioural proof for the storage core repositories.
 *
 * Every test opens a real SQLite file under a fresh temporary directory rather
 * than an in-memory database, because the properties under test are durability
 * properties: rows that must survive a close, versions that must stay readable
 * after a newer one is written, and a session token that must not be recoverable
 * from the file. `:memory:` would make all three vacuously true.
 *
 * The schema below is an inline literal because `../migrations.ts` is owned by a
 * different change and does not exist on this branch. It mirrors the entity list
 * in mvp-spec section 7 "Storage entities" and the column names this repository
 * layer writes. `migrations.ts` must produce the same columns, and must also
 * install the `scope_snapshot` immutability triggers: this file cannot prove an
 * invariant that only its own fixture enforces.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { asCommitSha, asFingerprint, fingerprint } from '@shiploop/domain';
import type {
  AuthorizationSubject,
  CapabilityDeclaration,
  CandidateIdentity,
  ConnectorId,
  DomainError,
  OwnerId,
  ProfileVersionId,
  ProjectId,
  Result,
  ScopeSnapshot,
} from '@shiploop/domain';
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
  sessionTokenHash,
} from './core.ts';
import type {
  ProjectProfileContent,
  StorageTransactions,
  UpsertAttentionItemInput,
} from './types.ts';

const SCHEMA = `
CREATE TABLE owner (
  owner_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE owner_session (
  session_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner(owner_id),
  token_hash TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  rotated_from_session_id TEXT
) STRICT;

CREATE TABLE project_profile_version (
  profile_version_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  supersedes_version_id TEXT,
  content_json TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (project_id, version_number)
) STRICT;

CREATE TABLE connector (
  connector_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  resource_scope TEXT NOT NULL,
  credential_reference TEXT NOT NULL,
  credential_reference_digest TEXT NOT NULL,
  capability_json TEXT NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  last_checked_at TEXT,
  last_success_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, kind)
) STRICT;

CREATE TABLE procedure_version (
  procedure_version_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  source TEXT NOT NULL,
  source_revision TEXT,
  content TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  last_verified_revision TEXT,
  last_verified_at TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  note TEXT,
  UNIQUE (project_id, subject_key, version_number)
) STRICT;

CREATE TABLE idea (
  idea_id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL,
  raw_request TEXT NOT NULL,
  notes TEXT,
  bug_expected TEXT,
  bug_actual TEXT,
  bug_reproduction TEXT,
  generated_summary TEXT,
  agreed_brief TEXT,
  open_questions TEXT NOT NULL,
  state TEXT NOT NULL,
  published_work_item_id TEXT,
  archived_at TEXT,
  archived_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE idea_attachment (
  attachment_id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL REFERENCES idea(idea_id),
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE work_item (
  work_item_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  profile_version_id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  external_issue_id TEXT UNIQUE,
  external_issue_identifier TEXT,
  external_issue_url TEXT,
  publication_intent TEXT NOT NULL,
  publication_state TEXT NOT NULL,
  publication_operation_id TEXT,
  related_work_item_ids TEXT NOT NULL,
  adoption_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE work_item_sync (
  work_item_id TEXT PRIMARY KEY REFERENCES work_item(work_item_id),
  state TEXT NOT NULL,
  last_attempt_at TEXT,
  last_success_at TEXT,
  attempt_count INTEGER NOT NULL,
  last_error TEXT
) STRICT;

CREATE TABLE scope_snapshot (
  scope_snapshot_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_item(work_item_id),
  sequence_number INTEGER NOT NULL,
  attempt_id TEXT,
  issue_id TEXT NOT NULL,
  issue_identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  provider_revision TEXT,
  priority TEXT,
  dependency_issue_ids TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  scope_fingerprint TEXT NOT NULL,
  profile_version_id TEXT NOT NULL,
  procedure_version_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  correlation_id TEXT,
  UNIQUE (work_item_id, sequence_number)
) STRICT;

CREATE TRIGGER scope_snapshot_reject_update BEFORE UPDATE ON scope_snapshot
BEGIN SELECT RAISE(ABORT, 'scope_snapshot is append-only'); END;

CREATE TRIGGER scope_snapshot_reject_delete BEFORE DELETE ON scope_snapshot
BEGIN SELECT RAISE(ABORT, 'scope_snapshot is append-only'); END;

CREATE TABLE attention_item (
  attention_item_id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  project_id TEXT NOT NULL,
  work_item_id TEXT,
  issue_identifier TEXT,
  title TEXT NOT NULL,
  blocker TEXT,
  next_action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  candidate_fingerprint TEXT,
  occurrence_count INTEGER NOT NULL,
  first_observed_at TEXT NOT NULL
) STRICT;

CREATE TABLE candidate (
  candidate_id TEXT PRIMARY KEY,
  attempt_id TEXT,
  work_item_id TEXT NOT NULL REFERENCES work_item(work_item_id),
  candidate_fingerprint TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  pull_request_id TEXT,
  target_branch TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  correlation_id TEXT
) STRICT;

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(candidate_id),
  candidate_fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  criterion_id TEXT,
  check_id TEXT,
  check_name TEXT NOT NULL,
  result TEXT NOT NULL,
  observed_at TEXT,
  environment_fingerprint TEXT,
  scope_fingerprint TEXT,
  artifact_ref TEXT,
  detail TEXT,
  recorded_at TEXT NOT NULL,
  correlation_id TEXT
) STRICT;

CREATE TABLE owner_decision (
  decision_id TEXT PRIMARY KEY,
  work_item_id TEXT REFERENCES work_item(work_item_id),
  candidate_fingerprint TEXT NOT NULL,
  scope_fingerprint TEXT NOT NULL,
  actor TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  subject_json TEXT NOT NULL,
  subject_fingerprint TEXT,
  note TEXT,
  state TEXT NOT NULL,
  consumed_at TEXT,
  invalidated_at TEXT,
  invalidated_reason TEXT,
  created_at TEXT NOT NULL,
  correlation_id TEXT
) STRICT;
`;

const PROJECT = '0a5f1c22-0000-4000-8000-00000000000a' as ProjectId;
const OTHER_PROJECT = '0a5f1c22-0000-4000-8000-00000000000b' as ProjectId;
const OWNER = 'owner-0000-4000-8000-00000000000c';
const OWNER_ID = OWNER as OwnerId;
const PROFILE_VERSION_ID = 'profile-version-1' as ProfileVersionId;
const ABSENT_CONNECTOR = '00000000-0000-4000-8000-000000000000' as ConnectorId;
const ABSENT_FINGERPRINT = asFingerprint(`fp_${'9'.repeat(32)}`);
const SESSION_TOKEN = 'ship-loop-session-token-for-verification-only';
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
    procedureVersionId: 'procedure-version-1',
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
 * Opens a real database file, runs the body, closes, then runs `afterClose`
 * against the closed file before removing the directory. The post-close hook is
 * what lets a test inspect the bytes that a backup would actually contain.
 */
async function withDatabase(
  run: (database: { readonly connection: DatabaseSync; readonly file: string }) => Promise<void> | void,
  afterClose?: (file: string) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-storage-core-'));
  const file = join(directory, 'storage.sqlite');
  try {
    const connection = new DatabaseSync(file);
    try {
      connection.exec('PRAGMA journal_mode = WAL');
      connection.exec('PRAGMA foreign_keys = ON');
      connection.exec(SCHEMA);
      await run({ connection, file });
    } finally {
      connection.close();
    }
    if (afterClose !== undefined) await afterClose(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a saved profile returns a new version id and leaves the earlier version readable (F02-AC3)', async () => {
  await withDatabase(async ({ connection }) => {
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
          .prepare('INSERT INTO owner (owner_id, display_name, created_at) VALUES (?, ?, ?)')
          .run(OWNER_ID, 'Solo owner', '2026-01-02T05:00:00.000Z');
        throw new Error('simulated failure after a write');
      }),
    );
    assert.equal(rolledBack, 1);
    assert.equal(connection.prepare('SELECT COUNT(*) AS total FROM owner').get()?.total, 0);
    assert.equal(expectOk(profiles.listVersions(PROJECT)).length, 1);
  });
});

test('versioned records survive close and reopen (F32-AC1)', async () => {
  let savedId: ProfileVersionId | null = null;
  let savedFile = '';
  await withDatabase(
    async ({ connection, file }) => {
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
      const reopened = new DatabaseSync(file);
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
        procedureVersionId: 'procedure-version-1',
        capturedAt: '2026-01-02T03:01:00.000Z',
        correlationId: 'correlation-1',
      }),
    );
    const second = expectOk(
      work.appendScopeSnapshot({
        scope: scopeSnapshot(item.workItemId, 'Revised description.'),
        attemptId: null,
        profileVersionId: item.profileVersionId,
        procedureVersionId: 'procedure-version-1',
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
          .prepare('UPDATE scope_snapshot SET description = ? WHERE scope_snapshot_id = ?')
          .run('Rewritten history.', first.scopeSnapshotId),
      /append-only/,
    );
    assert.throws(
      () => connection.prepare('DELETE FROM scope_snapshot WHERE scope_snapshot_id = ?').run(first.scopeSnapshotId),
      /append-only/,
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

test('evidence for one candidate fingerprint is never returned for another (F20-AC3, F25-AC3)', async () => {
  await withDatabase(async ({ connection }) => {
    const work = new WorkItemRepository(connection);
    const item = expectOk(
      work.create({
        projectId: PROJECT,
        profileVersionId: PROFILE_VERSION_ID,
        source: 'CapturedIdea',
        title: 'Build work',
        externalIssueId: null,
        externalIssueIdentifier: null,
        externalIssueUrl: null,
        publicationIntent: 'PublishWhenAgreed',
        relatedWorkItemIds: [],
        adoption: null,
        at: '2026-01-02T03:00:00.000Z',
      }),
    );

    const candidates = new CandidateRepository(connection);
    const evidence = new EvidenceRepository(connection);

    const first = expectOk(
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
    const replacement = expectOk(
      candidates.record({
        attemptId: null,
        workItemId: item.workItemId,
        identity: candidateIdentity(OTHER_HEAD_SHA),
        pullRequestId: 'pr-42',
        targetBranch: 'main',
        recordedAt: '2026-01-02T04:01:00.000Z',
        correlationId: 'correlation-2',
      }),
    );

    assert.equal(first.pullRequestId, replacement.pullRequestId);
    assert.notEqual(replacement.candidateFingerprint, first.candidateFingerprint);

    const recorded = expectOk(
      evidence.record({
        candidateFingerprint: first.candidateFingerprint,
        kind: 'CheckResult',
        criterionId: 'ac1',
        checkId: 'typecheck',
        checkName: 'Type check',
        result: 'Passed',
        observedAt: '2026-01-02T03:20:00.000Z',
        environmentFingerprint: ENVIRONMENT_FINGERPRINT,
        scopeFingerprint: SCOPE_FINGERPRINT,
        artifactRef: 'artifacts/checks/typecheck.log',
        detail: null,
        recordedAt: '2026-01-02T03:20:01.000Z',
        correlationId: 'correlation-1',
      }),
    );
    assert.equal(recorded.candidateId, first.candidateId);

    assert.equal(expectOk(evidence.listForCandidate(first.candidateFingerprint)).length, 1);
    assert.equal(expectOk(evidence.listForCandidate(replacement.candidateFingerprint)).length, 0);
    assert.equal(
      expectOk(evidence.listForCriterion(replacement.candidateFingerprint, 'ac1')).length,
      0,
    );

    const unbound = evidence.record({
      candidateFingerprint: ABSENT_FINGERPRINT,
      kind: 'CheckResult',
      criterionId: 'ac1',
      checkId: 'typecheck',
      checkName: 'Type check',
      result: 'Passed',
      observedAt: null,
      environmentFingerprint: null,
      scopeFingerprint: null,
      artifactRef: null,
      detail: null,
      recordedAt: '2026-01-02T03:25:00.000Z',
      correlationId: null,
    });
    expectError(unbound, 'NotFound');

    const found = expectOk(candidates.findByFingerprint(first.candidateFingerprint));
    assert.equal(found?.candidateId, first.candidateId);
    assert.equal(found?.identity.headSha, HEAD_SHA);
  });
});

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
      assert.equal(created.tokenHash, sessionTokenHash(SESSION_TOKEN));
      assert.equal(created.revokedAt, null);
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
      assert.ok(onDisk.includes(sessionTokenHash(SESSION_TOKEN)), 'the token digest must be stored instead');
    },
  );
});

test('a connector stores a credential reference and refuses a secret value (F03-AC2, F03-AC3)', async () => {
  await withDatabase(async ({ connection }) => {
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
    const procedures = new ProcedureRepository(connection);
    const first = expectOk(
      procedures.appendVersion({
        projectId: PROJECT,
        subjectKey: 'release.web',
        kind: 'Procedure',
        scope: 'project',
        source: 'owner note',
        sourceRevision: null,
        content: 'Merge with squash, then promote the preview deployment.',
        status: 'Accepted',
        createdAt: '2026-01-02T03:00:00.000Z',
        createdBy: OWNER,
        note: null,
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
        source: 'agent suggestion',
        sourceRevision: null,
        content: 'Merge with rebase and skip the preview step.',
        status: 'Proposed',
        createdAt: '2026-01-02T04:00:00.000Z',
        createdBy: 'agent',
        note: 'Suggested during the last run.',
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

test('raw intake stays distinct from generated material and archiving creates no ticket (F06-AC1, F06-AC5)', async () => {
  await withDatabase(async ({ connection }) => {
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
    assert.equal(idea.state, 'Captured');
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
    assert.equal(clarified.state, 'Agreed');
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
    assert.equal(archived.state, 'Archived');
    assert.equal(archived.publishedWorkItemId, null);
    assert.equal(
      connection.prepare('SELECT COUNT(*) AS total FROM work_item').get()?.total,
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
        actor: OWNER,
        note: 'Tested against the preview deployment.',
        createdAt: '2026-01-02T03:30:00.000Z',
        correlationId: 'correlation-1',
      }),
    );
    assert.equal(acceptance.decisionType, 'Accepted');
    assert.equal(acceptance.subject, null);
    assert.equal(acceptance.subjectFingerprint, null);
    assert.equal(acceptance.state, 'Recorded');

    const changes = expectOk(
      decisions.recordChangesRequested({
        workItemId: item.workItemId,
        candidateFingerprint: candidate.candidateFingerprint,
        scopeFingerprint: SCOPE_FINGERPRINT,
        actor: OWNER,
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
        actor: OWNER,
        decisionType: 'AuthorizedMerge',
        subject,
        note: null,
        createdAt: '2026-01-02T03:40:00.000Z',
        correlationId: 'correlation-1',
      }),
    );
    assert.equal(authorization.decisionType, 'AuthorizedMerge');
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

    expectError(
      decisions.recordAcceptance({
        workItemId: item.workItemId,
        candidateFingerprint: candidate.candidateFingerprint,
        scopeFingerprint: SCOPE_FINGERPRINT,
        actor: '   ',
        note: null,
        createdAt: '2026-01-02T03:45:00.000Z',
        correlationId: null,
      }),
      'Invalid',
    );
  });
});

test('an owner without a provisioned identity cannot obtain a session (F01-AC1)', async () => {
  await withDatabase(async ({ connection }) => {
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