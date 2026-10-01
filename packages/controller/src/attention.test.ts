/**
 * Behavioural proof for the attention dashboard and the use cases behind it
 * (F31-AC1, F31-AC2, F31-AC3, F31-AC4, F31-AC5, F24-AC3, F25-AC3, F20-AC2,
 * N04-AC2, N04-AC3).
 *
 * Every case runs against a real SQLite file in a fresh temporary directory,
 * opened by the real `openDatabase` and brought to the real `migrate` version.
 * No inline fixture schema appears here, so the foreign keys, enums and CHECKs the
 * dashboard's readers depend on are exercised rather than assumed: a `jobs.state`
 * that the lifecycle does not allow, or an `attention_items.kind` the column
 * refuses, fails in these cases instead of at the first owner request.
 *
 * Candidates, checks, owner decisions and attention items are written through the
 * real `@shiploop/storage` repositories, so the rows these cases assert on are the
 * production rows. The job and checkpoint rows are written directly because
 * `packages/storage/src/jobs/queue.ts` is not exported from `@shiploop/storage`, and
 * the dashboard binds `SqliteAttentionJobQuery` rather than the queue itself (see the
 * duplication report on the class).
 *
 * The cases worth reading first:
 *
 *   - grouping is derived from the durable rows, never from a caller-supplied list,
 *     and a second project in the same database never leaks into the first project's
 *     board (F31-AC1, F31-AC2);
 *   - collecting twice produces the same identities and the same count, with the
 *     stored occurrence count rising instead of a second row appearing (F31-AC3);
 *   - acknowledging leaves every run, acceptance, delivery and release row
 *     byte-identical, compared before and after (F31-AC4);
 *   - a candidate that has been superseded cannot present as ready for release: the
 *     release item resolves and the replacement candidate is named (F31-AC5).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  AttemptState,
  AttentionBucket,
  AttentionItem,
  AttentionItemId,
  CheckResult,
  CommitSha,
  Fingerprint,
  OwnerId,
  ProjectId,
  WorkItemId,
} from '@shiploop/domain';
import {
  AttentionItemRepository,
  CandidateRepository,
  EvidenceRepository,
  OwnerDecisionRepository,
  migrate,
  openDatabase,
} from '@shiploop/storage';
import type { CandidateRecord, Database } from '@shiploop/storage';
import { SqliteAttentionJobQuery, SqliteAttentionScope, createAttentionUseCases } from './attention.ts';
import type { AttentionBoard, AttentionUseCases } from './attention.ts';
import type { ControllerClock } from './profiles.ts';

const T0 = '2026-10-05T09:00:00.000Z';
const T1 = '2026-10-05T10:00:00.000Z';
const T2 = '2026-10-05T11:00:00.000Z';

const PROJECT_ALPHA = 'proj-alpha' as ProjectId;
const PROJECT_BETA = 'proj-beta' as ProjectId;
const OWNER = 'owner-attention' as OwnerId;
const BASE_SHA = 'b'.repeat(40) as CommitSha;
const SCOPE_FINGERPRINT = `fp_${'1'.repeat(32)}` as Fingerprint;
const ENVIRONMENT_FINGERPRINT = `fp_${'2'.repeat(32)}` as Fingerprint;
const POLICY_FINGERPRINT = `fp_${'3'.repeat(32)}` as Fingerprint;
const QUESTION_BODY = 'Does the retry budget apply per tenant or per request?';

/** A full commit SHA unique per candidate, because a candidate's identity is hashed. */
function headShaOf(tag: string): CommitSha {
  return createHash('sha256').update(tag, 'utf8').digest('hex') as CommitSha;
}

interface SeededWorkItem {
  readonly workItemId: string;
  readonly projectId: ProjectId;
  readonly scopeSnapshotId: string;
  readonly profileVersionId: string;
  readonly procedureVersionId: string;
}

interface Harness {
  readonly database: Database;
  readonly useCases: AttentionUseCases;
  readonly attentionItems: AttentionItemRepository;
  readonly candidates: CandidateRepository;
  readonly evidence: EvidenceRepository;
  readonly decisions: OwnerDecisionRepository;
  readonly project: ProjectId;
  /** Moves the injected clock, so a recorded instant is never ambient (mvp-spec 7). */
  setNow(instant: string): void;
}

function projectVersionsFor(projectId: ProjectId): {
  readonly profileVersionId: string;
  readonly procedureVersionId: string;
} {
  return { profileVersionId: `profile-${projectId}`, procedureVersionId: `procedure-${projectId}` };
}

function seedProject(db: Database, projectId: ProjectId): {
  readonly profileVersionId: string;
  readonly procedureVersionId: string;
} {
  const versions = projectVersionsFor(projectId);
  db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(projectId, `Project ${projectId}`);
  db.prepare(
    `INSERT INTO project_profile_versions (profile_version_id, project_id, version, content_json, content_fingerprint, created_by)
     VALUES (?, ?, 1, '{}', ?, ?)`,
  ).run(versions.profileVersionId, projectId, POLICY_FINGERPRINT, OWNER);
  db.prepare(
    `INSERT INTO procedure_versions (procedure_version_id, project_id, version, kind, source, content_json, content_fingerprint, created_by)
     VALUES (?, ?, 1, 'Procedure', 'Owner', '{}', ?, ?)`,
  ).run(versions.procedureVersionId, projectId, POLICY_FINGERPRINT, OWNER);
  return versions;
}

function seedWorkItem(
  db: Database,
  input: {
    readonly workItemId: string;
    readonly projectId: ProjectId;
    readonly issueId: string;
    readonly issueIdentifier: string;
    readonly title: string;
    readonly ideaId?: string;
  },
): SeededWorkItem {
  const versions = projectVersionsFor(input.projectId);
  db.prepare(
    `INSERT INTO work_items (work_item_id, project_id, idea_id, issue_id, issue_identifier, title, publication_intent, origin, profile_version_id)
     VALUES (?, ?, ?, ?, ?, ?, 'Published', 'Published', ?)`,
  ).run(
    input.workItemId,
    input.projectId,
    input.ideaId ?? null,
    input.issueId,
    input.issueIdentifier,
    input.title,
    versions.profileVersionId,
  );
  const scopeSnapshotId = `snapshot-${input.workItemId}`;
  db.prepare(
    `INSERT INTO scope_snapshots (scope_snapshot_id, work_item_id, project_id, issue_id, description, scope_fingerprint, retrieved_at, profile_version_id, procedure_version_id)
     VALUES (?, ?, ?, ?, 'Fixture scope', ?, ?, ?, ?)`,
  ).run(
    scopeSnapshotId,
    input.workItemId,
    input.projectId,
    input.issueId,
    SCOPE_FINGERPRINT,
    T0,
    versions.profileVersionId,
    versions.procedureVersionId,
  );
  return { workItemId: input.workItemId, projectId: input.projectId, scopeSnapshotId, ...versions };
}

/**
 * Writes the durable job row.
 *
 * Direct SQL because the queue is not exported from `@shiploop/storage`; the columns
 * it fills are the ones the migrated schema requires, including `started_at` for
 * every state the schema says is consuming execution capacity.
 */
function seedJob(db: Database, work: SeededWorkItem, jobId: string, state: AttemptState, now: string): void {
  const active = state === 'Preparing' || state === 'Running' || state === 'Verifying';
  db.prepare(
    `INSERT INTO jobs (job_id, work_item_id, project_id, scope_snapshot_id, profile_version_id, procedure_version_id,
                       mode, state, operation_id, correlation_id, queued_at, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Build', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    work.workItemId,
    work.projectId,
    work.scopeSnapshotId,
    work.profileVersionId,
    work.procedureVersionId,
    state,
    `operation-${jobId}`,
    `correlation-${jobId}`,
    now,
    active ? now : null,
    now,
    now,
  );
}

function seedCheckpoint(db: Database, work: SeededWorkItem, jobId: string, blocker: string | null, now: string): void {
  db.prepare(
    `INSERT INTO job_checkpoints (job_id, checkpoint_id, scope_snapshot_id, scope_fingerprint, profile_version_id,
                                  procedure_version_id, workspace_id, branch_name, worktree_path, head_sha, base_sha,
                                  dirty_files, untracked_files, results, feedback, blocker, next_action, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, 'workspace-1', 'shiploop/attention', '/tmp/worktree', ?, ?, '[]', '[]', '[]', '[]', ?, 'continue', ?)`,
  ).run(
    jobId,
    `checkpoint-${jobId}`,
    work.scopeSnapshotId,
    SCOPE_FINGERPRINT,
    work.profileVersionId,
    work.procedureVersionId,
    headShaOf(jobId),
    BASE_SHA,
    blocker,
    now,
  );
}

function recordCandidate(harness: Harness, work: SeededWorkItem, tag: string, recordedAt: string): CandidateRecord {
  const recorded = harness.candidates.record({
    attemptId: null,
    workItemId: work.workItemId as WorkItemId,
    identity: {
      headSha: headShaOf(tag),
      baseSha: BASE_SHA,
      scopeFingerprint: SCOPE_FINGERPRINT,
      profileVersionId: work.profileVersionId,
      procedureVersionId: work.procedureVersionId,
      environmentFingerprint: ENVIRONMENT_FINGERPRINT,
      policyFingerprint: POLICY_FINGERPRINT,
      components: [
        {
          component: 'web',
          deploymentId: `deployment-${tag}`,
          deploymentUrl: `https://${tag}.preview.invalid`,
          environment: 'preview',
        },
      ],
    },
    pullRequestId: null,
    targetBranch: 'main',
    recordedAt,
    correlationId: `correlation-${tag}`,
  });
  assert.ok(recorded.ok, `the candidate ${tag} could not be recorded: ${recorded.ok ? '' : recorded.error.reason}`);
  return recorded.value;
}

function recordCheck(
  harness: Harness,
  candidate: CandidateRecord,
  name: string,
  result: CheckResult,
  observedAt: string,
): void {
  const recorded = harness.evidence.record({
    candidateFingerprint: candidate.candidateFingerprint,
    kind: 'CheckResult',
    criterionId: `AC-${name}`,
    checkId: `check-${candidate.candidateFingerprint}-${name}`,
    checkName: name,
    result,
    observedAt,
    environmentFingerprint: ENVIRONMENT_FINGERPRINT,
    scopeFingerprint: SCOPE_FINGERPRINT,
    artifactRef: null,
    detail: null,
    recordedAt: observedAt,
    correlationId: `correlation-${name}`,
  });
  assert.ok(recorded.ok, `the check ${name} could not be recorded: ${recorded.ok ? '' : recorded.error.reason}`);
}

function acceptCandidate(harness: Harness, work: SeededWorkItem, candidate: CandidateRecord, decidedAt: string): void {
  const recorded = harness.decisions.recordAcceptance({
    workItemId: work.workItemId as WorkItemId,
    candidateFingerprint: candidate.candidateFingerprint,
    scopeFingerprint: SCOPE_FINGERPRINT,
    actorOwnerId: OWNER,
    note: null,
    createdAt: decidedAt,
    correlationId: `correlation-accept-${candidate.candidateFingerprint}`,
  });
  assert.ok(recorded.ok, `the acceptance could not be recorded: ${recorded.ok ? '' : recorded.error.reason}`);
}

/** The durable facts acknowledgement must never move (F31-AC4). */
const FACT_TABLES = [
  'attempts',
  'candidates',
  'candidate_components',
  'checks',
  'deliveries',
  'evidence',
  'history_links',
  'idea_questions',
  'job_checkpoints',
  'jobs',
  'owner_decisions',
  'release_receipts',
] as const;

function durableFacts(db: Database): Record<string, unknown[]> {
  const facts: Record<string, unknown[]> = {};
  for (const table of FACT_TABLES) {
    facts[table] = db.prepare(`SELECT * FROM ${table}`).all();
  }
  return facts;
}

function itemsIn(board: AttentionBoard, bucket: AttentionBucket): readonly AttentionItem[] {
  return board.groups.find((group) => group.bucket === bucket)?.items ?? [];
}

function onlyItem(items: readonly AttentionItem[], what: string): AttentionItem {
  assert.equal(items.length, 1, `expected exactly one ${what}, found ${items.length}`);
  const [item] = items;
  assert.ok(item !== undefined, `expected one ${what} to read`);
  return item;
}

async function withHarness(body: (harness: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-controller-attention-'));
  try {
    const opened = openDatabase(join(directory, 'shiploop.sqlite'));
    assert.ok(opened.ok, `the real database opened: ${opened.ok ? '' : opened.error.reason}`);
    const database = opened.value;
    const migrated = migrate(database);
    assert.ok(migrated.ok, `the real schema migrated: ${migrated.ok ? '' : migrated.error.reason}`);

    seedProject(database, PROJECT_ALPHA);
    seedProject(database, PROJECT_BETA);
    database.prepare('INSERT INTO owners (owner_id, display_name) VALUES (?, ?)').run(OWNER, 'Solo owner');

    let instant = T0;
    const clock: ControllerClock = { now: () => instant };
    const attentionItems = new AttentionItemRepository(database);
    const useCases = createAttentionUseCases({
      clock,
      queue: new SqliteAttentionJobQuery(database),
      scope: new SqliteAttentionScope(database),
      attentionStore: attentionItems,
    });

    await body({
      database,
      useCases,
      attentionItems,
      candidates: new CandidateRepository(database),
      evidence: new EvidenceRepository(database),
      decisions: new OwnerDecisionRepository(database),
      project: PROJECT_ALPHA,
      setNow(next: string): void {
        instant = next;
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function collect(harness: Harness, projectId: ProjectId = PROJECT_ALPHA): AttentionBoard {
  const board = harness.useCases.collectAttention(projectId);
  assert.ok(board.ok, `collection failed: ${board.ok ? '' : board.error.reason}`);
  return board.value;
}

test('groups live durable state into the four buckets without a caller-supplied list (F31-AC1)', async () => {
  await withHarness((harness) => {
    const running = seedWorkItem(harness.database, {
      workItemId: 'wi-running',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-running',
      issueIdentifier: 'SHIP-101',
      title: 'Retry failed logins',
    });
    const blocked = seedWorkItem(harness.database, {
      workItemId: 'wi-blocked',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-blocked',
      issueIdentifier: 'SHIP-102',
      title: 'Rate limit the public API',
    });
    const failing = seedWorkItem(harness.database, {
      workItemId: 'wi-failing',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-failing',
      issueIdentifier: 'SHIP-103',
      title: 'Show deployment health',
    });
    const ready = seedWorkItem(harness.database, {
      workItemId: 'wi-ready',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-ready',
      issueIdentifier: 'SHIP-104',
      title: 'Export run history',
    });

    seedJob(harness.database, running, 'job-running', 'Running', T0);
    seedJob(harness.database, blocked, 'job-blocked', 'Blocked', T0);
    seedCheckpoint(harness.database, blocked, 'job-blocked', 'the registry rejected the credentials', T0);
    seedJob(harness.database, failing, 'job-failing', 'Completed', T0);
    seedJob(harness.database, ready, 'job-ready', 'Completed', T0);

    const failingCandidate = recordCandidate(harness, failing, 'failing', T0);
    recordCheck(harness, failingCandidate, 'typecheck', 'Failed', T0);

    const readyCandidate = recordCandidate(harness, ready, 'ready', T0);
    recordCheck(harness, readyCandidate, 'typecheck', 'Passed', T0);
    acceptCandidate(harness, ready, readyCandidate, T0);

    const board = collect(harness);

    assert.deepEqual(
      board.groups.map((group) => group.bucket),
      ['NeedsYourInput', 'ReadyForYourTest', 'ReadyForRelease', 'Working'],
    );

    const working = onlyItem(itemsIn(board, 'Working'), 'working item');
    assert.equal(working.kind, 'RunProgress');
    assert.equal(working.title, 'Job job-running is Running (SHIP-101)');
    assert.equal(working.candidateFingerprint, null);

    const needsInput = onlyItem(itemsIn(board, 'NeedsYourInput'), 'needs-your-input item');
    assert.equal(needsInput.kind, 'Blocker');
    assert.equal(needsInput.issueIdentifier, 'SHIP-102');
    assert.equal(needsInput.blocker, 'the registry rejected the credentials');

    const readyForTest = onlyItem(itemsIn(board, 'ReadyForYourTest'), 'ready-for-your-test item');
    assert.equal(readyForTest.kind, 'ReadyForYourTest');
    assert.equal(readyForTest.candidateFingerprint, failingCandidate.candidateFingerprint);

    const readyForRelease = onlyItem(itemsIn(board, 'ReadyForRelease'), 'ready-for-release item');
    assert.equal(readyForRelease.kind, 'DeliveryDecision');
    assert.equal(readyForRelease.candidateFingerprint, readyCandidate.candidateFingerprint);
    assert.equal(board.collectedAt, T0);

    assert.deepEqual(
      [...board.persistedItemIds].sort(),
      [needsInput.attentionItemId, readyForTest.attentionItemId, readyForRelease.attentionItemId].sort(),
    );
    assert.equal(board.persistedItemIds.includes(working.attentionItemId), false);
    const rows = harness.database.prepare('SELECT kind FROM attention_items ORDER BY kind').all();
    assert.deepEqual(
      rows.map((row) => row['kind']),
      ['Blocker', 'DeliveryDecision', 'ReadyForYourTest'],
    );
  });
});

test('filters by project without becoming a second editable backlog (F31-AC2)', async () => {
  await withHarness((harness) => {
    const alpha = seedWorkItem(harness.database, {
      workItemId: 'wi-alpha',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-alpha',
      issueIdentifier: 'SHIP-201',
      title: 'Alpha work',
    });
    const beta = seedWorkItem(harness.database, {
      workItemId: 'wi-beta',
      projectId: PROJECT_BETA,
      issueId: 'issue-beta',
      issueIdentifier: 'SHIP-901',
      title: 'Beta work',
    });
    seedJob(harness.database, alpha, 'job-alpha', 'Blocked', T0);
    seedJob(harness.database, beta, 'job-beta', 'Blocked', T0);

    const before = durableFacts(harness.database);
    const alphaBoard = collect(harness, PROJECT_ALPHA);
    const betaBoard = collect(harness, PROJECT_BETA);

    assert.deepEqual(
      alphaBoard.items.map((item) => item.issueIdentifier),
      ['SHIP-201'],
    );
    assert.deepEqual(
      betaBoard.items.map((item) => item.issueIdentifier),
      ['SHIP-901'],
    );
    assert.deepEqual(durableFacts(harness.database), before);
  });
});

test('every item states one concrete next action and a blocker names what is blocking (F31-AC2)', async () => {
  await withHarness((harness) => {
    const blocked = seedWorkItem(harness.database, {
      workItemId: 'wi-blocked',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-blocked',
      issueIdentifier: 'SHIP-302',
      title: 'Blocked work',
    });
    const failing = seedWorkItem(harness.database, {
      workItemId: 'wi-failing',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-failing',
      issueIdentifier: 'SHIP-303',
      title: 'Failing checks',
    });
    const unrecorded = seedWorkItem(harness.database, {
      workItemId: 'wi-unrecorded',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-unrecorded',
      issueIdentifier: 'SHIP-304',
      title: 'Blocked without a recorded reason',
    });
    seedJob(harness.database, blocked, 'job-blocked', 'Blocked', T0);
    seedCheckpoint(harness.database, blocked, 'job-blocked', 'the deploy key expired', T0);
    seedJob(harness.database, failing, 'job-failing', 'Completed', T0);
    seedJob(harness.database, unrecorded, 'job-unrecorded', 'Blocked', T0);
    const candidate = recordCandidate(harness, failing, 'failing', T0);
    recordCheck(harness, candidate, 'typecheck', 'Failed', T0);

    const board = collect(harness);
    for (const group of board.groups) {
      for (const item of group.items) {
        assert.ok(item.nextAction.trim().length > 0, `${item.kind} stated no next action`);
      }
    }

    const blockers = itemsIn(board, 'NeedsYourInput');
    const blocker = blockers.find((item) => item.issueIdentifier === 'SHIP-302');
    assert.ok(blocker !== undefined, 'the blocked item was derived');
    assert.equal(blocker.blocker, 'the deploy key expired');
    assert.match(blocker.nextAction, /^Resolve what is blocking job job-blocked/);

    const unrecordedBlocker = blockers.find((item) => item.issueIdentifier === 'SHIP-304');
    assert.ok(unrecordedBlocker !== undefined, 'the unrecorded blocker item was derived');
    assert.equal(unrecordedBlocker.blocker, 'no blocker reason is recorded for job job-unrecorded');

    const test = onlyItem(itemsIn(board, 'ReadyForYourTest'), 'ready-for-test item');
    assert.equal(test.blocker, 'required check "typecheck" is Failed');
    assert.match(test.nextAction, /^Ask for a fix pass on candidate fp_/);
  });
});

test('a repeated collection updates the existing item instead of appending a duplicate (F31-AC3)', async () => {
  await withHarness((harness) => {
    const blocked = seedWorkItem(harness.database, {
      workItemId: 'wi-blocked',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-blocked',
      issueIdentifier: 'SHIP-401',
      title: 'Blocked work',
    });
    seedJob(harness.database, blocked, 'job-blocked', 'Blocked', T0);
    seedCheckpoint(harness.database, blocked, 'job-blocked', 'the sandbox image is missing', T0);

    harness.setNow(T0);
    const first = collect(harness);
    harness.setNow(T1);
    const second = collect(harness);

    assert.deepEqual(
      second.items.map((item) => item.dedupKey),
      first.items.map((item) => item.dedupKey),
    );
    assert.deepEqual(
      second.items.map((item) => item.attentionItemId),
      first.items.map((item) => item.attentionItemId),
    );
    assert.equal(second.items.length, first.items.length);
    assert.equal(second.collectedAt, T1);

    const stored = harness.database.prepare('SELECT count(*) AS rows FROM attention_items').get();
    assert.equal(stored?.['rows'], 1);
    const occurrence = harness.database.prepare('SELECT occurrence_count FROM attention_items').get();
    assert.equal(occurrence?.['occurrence_count'], 2);
  });
});

test('acknowledging records owner attention only (F31-AC4)', async () => {
  await withHarness((harness) => {
    const ready = seedWorkItem(harness.database, {
      workItemId: 'wi-ready',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-ready',
      issueIdentifier: 'SHIP-501',
      title: 'Ready work',
    });
    seedJob(harness.database, ready, 'job-ready', 'Completed', T0);
    const candidate = recordCandidate(harness, ready, 'ready', T0);
    recordCheck(harness, candidate, 'typecheck', 'Passed', T0);
    acceptCandidate(harness, ready, candidate, T0);

    const board = collect(harness);
    const item = onlyItem(itemsIn(board, 'ReadyForRelease'), 'ready-for-release item');
    const before = durableFacts(harness.database);

    harness.setNow(T1);
    const acknowledged = harness.useCases.acknowledge(item.attentionItemId as AttentionItemId, OWNER);
    assert.ok(acknowledged.ok, `acknowledgement failed: ${acknowledged.ok ? '' : acknowledged.error.reason}`);
    assert.equal(acknowledged.value.state, 'Acknowledged');
    assert.equal(acknowledged.value.acknowledgedBy, OWNER);
    assert.equal(acknowledged.value.acknowledgedAt, T1);

    assert.deepEqual(durableFacts(harness.database), before);

    harness.setNow(T2);
    const afterCollection = collect(harness);
    const stillOpen = onlyItem(itemsIn(afterCollection, 'ReadyForRelease'), 'acknowledged item');
    assert.equal(stillOpen.state, 'Acknowledged');
    assert.deepEqual(durableFacts(harness.database), before);
  });
});

test('a condition that is genuinely gone resolves its item (F31-AC4)', async () => {
  await withHarness((harness) => {
    const question = seedIdeaQuestion(harness, 'wi-clarification', 'SHIP-601');
    const board = collect(harness);
    const item = onlyItem(itemsIn(board, 'NeedsYourInput'), 'clarification item');
    assert.equal(item.kind, 'ClarificationRequested');
    assert.equal(item.blocker, question.body);

    harness.database.prepare("UPDATE idea_questions SET state = 'Answered', answered_at = ? WHERE question_id = ?").run(T1, question.questionId);

    harness.setNow(T2);
    const afterAnswer = collect(harness);
    assert.deepEqual(afterAnswer.groups, []);
    const stored = harness.attentionItems.get(item.attentionItemId as AttentionItemId);
    assert.ok(stored.ok, `the item could not be read back: ${stored.ok ? '' : stored.error.reason}`);
    assert.equal(stored.value.state, 'Resolved');
  });
});

test('a superseded candidate cannot present as ready for release (F31-AC5)', async () => {
  await withHarness((harness) => {
    const work = seedWorkItem(harness.database, {
      workItemId: 'wi-superseded',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-superseded',
      issueIdentifier: 'SHIP-701',
      title: 'Superseded candidate work',
    });
    seedJob(harness.database, work, 'job-completed', 'Completed', T0);
    const first = recordCandidate(harness, work, 'first', T0);
    recordCheck(harness, first, 'typecheck', 'Passed', T0);
    acceptCandidate(harness, work, first, T0);

    harness.setNow(T0);
    const before = collect(harness);
    const releaseItem = onlyItem(itemsIn(before, 'ReadyForRelease'), 'release item');
    assert.equal(releaseItem.candidateFingerprint, first.candidateFingerprint);

    const second = recordCandidate(harness, work, 'second', T1);
    recordCheck(harness, second, 'typecheck', 'Passed', T1);
    harness.database
      .prepare('UPDATE candidates SET superseded_at = ? WHERE fingerprint = ?')
      .run(T1, first.candidateFingerprint);

    harness.setNow(T2);
    const after = collect(harness);

    assert.deepEqual(itemsIn(after, 'ReadyForRelease'), []);
    const fresh = onlyItem(itemsIn(after, 'ReadyForYourTest'), 'replacement candidate item');
    assert.equal(fresh.candidateFingerprint, second.candidateFingerprint);
    assert.ok(fresh.blocker?.includes(second.candidateFingerprint) ?? false, 'the item must name the superseding candidate');
    assert.match(fresh.blocker ?? '', /superseded by/);
    assert.match(fresh.blocker ?? '', /HeadChanged/);

    const stored = harness.attentionItems.get(releaseItem.attentionItemId as AttentionItemId);
    assert.ok(stored.ok, `the released item could not be read back: ${stored.ok ? '' : stored.error.reason}`);
    assert.equal(stored.value.state, 'Resolved');
  });
});

test('a delivery whose outcome is unknown asks the owner to reconcile (F31-AC1)', async () => {
  await withHarness((harness) => {
    const work = seedWorkItem(harness.database, {
      workItemId: 'wi-recovery',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-recovery',
      issueIdentifier: 'SHIP-801',
      title: 'Recovery work',
    });
    seedJob(harness.database, work, 'job-completed', 'Completed', T0);
    const candidate = recordCandidate(harness, work, 'recovery', T0);
    recordCheck(harness, candidate, 'typecheck', 'Passed', T0);
    acceptCandidate(harness, work, candidate, T0);
    seedUnknownDelivery(harness, work, candidate);

    const board = collect(harness);
    const item = onlyItem(itemsIn(board, 'NeedsYourInput'), 'recovery item');
    assert.equal(item.kind, 'RecoveryDecision');
    assert.match(item.blocker ?? '', /is OutcomeUnknown/);
    assert.match(item.nextAction, /^Reconcile delivery delivery-unknown/);
  });
});

test('without a bound store the dashboard still reports and refusals are named (F31-AC4)', async () => {
  await withHarness((harness) => {
    const work = seedWorkItem(harness.database, {
      workItemId: 'wi-blocked',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-blocked',
      issueIdentifier: 'SHIP-901',
      title: 'Blocked work',
    });
    seedJob(harness.database, work, 'job-blocked', 'Blocked', T0);

    const useCases = createAttentionUseCases({
      clock: { now: () => T0 },
      queue: new SqliteAttentionJobQuery(harness.database),
      scope: new SqliteAttentionScope(harness.database),
    });
    const board = useCases.collectAttention(PROJECT_ALPHA);
    assert.ok(board.ok, `collection failed: ${board.ok ? '' : board.error.reason}`);
    assert.equal(board.value.items.length, 1);
    assert.deepEqual(board.value.persistedItemIds, []);

    const acknowledged = useCases.acknowledge('item' as AttentionItemId, OWNER);
    assert.equal(acknowledged.ok, false);
    assert.equal(acknowledged.ok === false ? acknowledged.error.code : '', 'Unavailable');

    const resolved = useCases.resolve('item' as AttentionItemId);
    assert.equal(resolved.ok, false);
    assert.equal(resolved.ok === false ? resolved.error.code : '', 'Unavailable');

    const rows = harness.database.prepare('SELECT count(*) AS rows FROM attention_items').get();
    assert.equal(rows?.['rows'], 0);
  });
});

test('a persisted milestone appears on the next read with a later collected instant (N04-AC2)', async () => {
  await withHarness((harness) => {
    const work = seedWorkItem(harness.database, {
      workItemId: 'wi-ready',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-ready',
      issueIdentifier: 'SHIP-1001',
      title: 'Ready work',
    });
    seedJob(harness.database, work, 'job-completed', 'Completed', T0);

    harness.setNow(T0);
    const before = collect(harness);
    assert.deepEqual(before.groups, []);
    assert.equal(before.collectedAt, T0);

    const candidate = recordCandidate(harness, work, 'n04', T0);
    recordCheck(harness, candidate, 'typecheck', 'Passed', T1);

    harness.setNow(T2);
    const after = collect(harness);
    assert.equal(after.collectedAt, T2);
    const item = onlyItem(itemsIn(after, 'ReadyForYourTest'), 'item produced by the new milestone');
    assert.equal(item.candidateFingerprint, candidate.candidateFingerprint);
    assert.match(item.nextAction, /^Accept candidate fp_/);
  });
});

test('collecting never moves a run, so no owner action waits on a coding job (N04-AC3)', async () => {
  await withHarness((harness) => {
    const work = seedWorkItem(harness.database, {
      workItemId: 'wi-running',
      projectId: PROJECT_ALPHA,
      issueId: 'issue-running',
      issueIdentifier: 'SHIP-1101',
      title: 'Long running work',
    });
    seedJob(harness.database, work, 'job-running', 'Running', T0);
    const before = durableFacts(harness.database);

    const board = collect(harness);
    assert.equal(itemsIn(board, 'Working').length, 1);
    assert.deepEqual(durableFacts(harness.database), before);

    const state = harness.database.prepare('SELECT state FROM jobs WHERE job_id = ?').get('job-running');
    assert.equal(state?.['state'], 'Running');
  });
});

function seedIdeaQuestion(
  harness: Harness,
  workItemId: string,
  issueIdentifier: string,
): { readonly questionId: string; readonly body: string } {
  harness.database
    .prepare('INSERT INTO ideas (idea_id, project_id, raw_request, state, kind) VALUES (?, ?, ?, ?, ?)')
    .run('idea-clarification', PROJECT_ALPHA, 'Add tenant retry budgets', 'Clarifying', 'FeatureRequest');
  seedWorkItem(harness.database, {
    workItemId,
    projectId: PROJECT_ALPHA,
    issueId: 'issue-clarification',
    issueIdentifier,
    title: 'Clarified work',
    ideaId: 'idea-clarification',
  });
  harness.database
    .prepare(
      `INSERT INTO idea_questions (question_id, idea_id, body, state, topic, readings, why_material, origin)
       VALUES (?, ?, ?, 'Open', ?, ?, ?, ?)`,
    )
    .run(
      'question-clarification',
      'idea-clarification',
      QUESTION_BODY,
      'Retry budget scope',
      JSON.stringify(['per tenant', 'per request']),
      'The two readings produce different rate limits.',
      'Ambiguity',
    );
  return { questionId: 'question-clarification', body: QUESTION_BODY };
}

function seedUnknownDelivery(harness: Harness, work: SeededWorkItem, candidate: CandidateRecord): void {
  const authorization = harness.decisions.authorize({
    workItemId: work.workItemId as WorkItemId,
    candidateFingerprint: candidate.candidateFingerprint,
    scopeFingerprint: SCOPE_FINGERPRINT,
    actorOwnerId: OWNER,
    decisionType: 'AuthorizeMerge',
    subject: {
      action: { kind: 'Merge', mergeMethod: 'Squash' },
      destination: 'origin',
      pullRequestId: null,
      headSha: candidate.identity.headSha,
      targetBranch: 'main',
      candidateFingerprint: candidate.candidateFingerprint,
      componentDeployments: [],
    },
    note: null,
    createdAt: T0,
    correlationId: 'correlation-authorize',
  });
  assert.ok(authorization.ok, `the authorization failed: ${authorization.ok ? '' : authorization.error.reason}`);
  harness.database
    .prepare(
      `INSERT INTO deliveries (delivery_id, work_item_id, project_id, candidate_id, decision_id, state, correlation_id,
                               manifest_json, head_sha, target_branch, unknown_since, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'OutcomeUnknown', ?, '{}', ?, 'main', ?, ?, ?)`,
    )
    .run(
      'delivery-unknown',
      work.workItemId,
      work.projectId,
      candidate.candidateId,
      authorization.value.decisionId,
      'correlation-delivery',
      candidate.identity.headSha,
      T0,
      T0,
      T0,
    );
}
