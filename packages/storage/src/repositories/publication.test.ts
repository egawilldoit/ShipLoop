/**
 * Behavioural proof for publication, adoption and external-effect persistence.
 *
 * Every test runs against the REAL migrated schema: a temporary SQLite file opened with
 * `openDatabase` and built by `migrate`, driven through the real `node:sqlite` driver. A
 * file rather than `:memory:` because the properties under test are durability properties -
 * a published row that must survive a close, a ledger bracket that must be one transaction,
 * and an append-only resolution row.
 *
 * The fixture seeds only the parents the foreign keys require, and every work item is
 * created through the real `WorkItemRepository` so every column its reader needs is bound
 * the way the product binds it. The operations, outbox and reconciliation stores are the
 * shipped ones, composed inside `PublicationRepository`: a hand-written ledger row would
 * prove that a fixture reads back, not that a lost response is treated as unresolved.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fingerprint } from '@shiploop/domain';
import type {
  DomainError,
  ProfileVersionId,
  ProjectId,
  Result,
  WorkItemId,
} from '@shiploop/domain';

import { openDatabase, type Database } from '../db.ts';
import { migrate } from '../migrations.ts';
import { WorkItemRepository } from './core.ts';
import { PublicationRepository } from './publication.ts';
import type { AdoptionReference } from './types.ts';

const PROJECT = '9a1b2c3d-0000-4000-8000-00000000000a' as ProjectId;
const OTHER_PROJECT = '9a1b2c3d-0000-4000-8000-00000000000b' as ProjectId;
const PROFILE_VERSION = '9a1b2c3d-0000-4000-8000-00000000000c' as ProfileVersionId;
const OWNER = '9a1b2c3d-0000-4000-8000-00000000000d';
const T0 = '2026-05-01T09:00:00.000Z';
const T1 = '2026-05-01T09:05:00.000Z';
const LATER = '2026-05-01T10:00:00.000Z';

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

/** One work item awaiting publication. */
function workItem(database: Database, title: string, intent: 'PublishWhenAgreed' | 'DoNotPublish' = 'PublishWhenAgreed'): WorkItemId {
  return expectOk(
    new WorkItemRepository(database).create({
      projectId: PROJECT,
      profileVersionId: PROFILE_VERSION,
      source: 'ProposedNewIssue',
      title,
      externalIssueId: null,
      externalIssueIdentifier: null,
      externalIssueUrl: null,
      publicationIntent: intent,
      relatedWorkItemIds: [],
      adoption: null,
      at: T0,
    }),
  ).workItemId;
}

interface Harness {
  readonly database: Database;
  readonly publications: PublicationRepository;
  readonly close: () => Promise<void>;
}

/**
 * A migrated database with the parents the publication tables require.
 *
 * Every test drives the same real repositories through this, so the assertions below are
 * about the product's behaviour rather than about a fixture's shape.
 */
async function withDatabase(run: (context: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-publication-'));
  const opened = openDatabase(join(directory, 'publication.sqlite'));
  assert.ok(opened.ok, `the database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
  const database: Database = opened.value;
  try {
    const migrated = migrate(database);
    assert.ok(migrated.ok, `the schema could not be migrated: ${migrated.ok ? '' : migrated.error.reason}`);
    database
      .prepare('INSERT INTO owners (owner_id, display_name, created_at) VALUES (?, ?, ?)')
      .run(OWNER, 'Solo owner', T0);
    database
      .prepare('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?), (?, ?, ?)')
      .run(PROJECT, 'Publication project', T0, OTHER_PROJECT, 'Other project', T0);
    database
      .prepare(
        `INSERT INTO project_profile_versions (profile_version_id, project_id, version, content_json, content_fingerprint, created_by, created_at)
         VALUES (?, ?, 1, '{}', ?, ?, ?)`,
      )
      .run(PROFILE_VERSION, PROJECT, fingerprint({ profile: 'publication' }), OWNER, T0);
    await run({ database, publications: new PublicationRepository(database), close: async () => undefined });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('F10-AC4 a published row carries the provider revision the build added a column for (N08-AC3)', async () => {
  await withDatabase(({ database }) => {
    const columns = database.prepare("SELECT name FROM pragma_table_info('work_items')").all();
    const names = new Set(columns.map((row) => String(row['name'])));
    // This asserts the migration that ADDED provider_revision is applied, not that it is the newest.
    // Pinning the newest version here would fail on every future migration, which is a test
    // that measures the wrong fact (N08-AC3).
    assert.ok(
      names.has('provider_revision'),
      'work_items has no provider_revision column, so a published row could not name what it read (F10-AC4)',
    );
  });
});

test('F10-AC1 a work item the owner did not select for publication is refused, and no ledger row appears', async () => {
  await withDatabase(({ database, publications }) => {
    const declined = workItem(database, 'Not selected for publication', 'DoNotPublish');
    const error = expectError(publications.requirePublishable(declined), 'Invalid');
    assert.equal(error.code, 'Invalid');
    assert.match(JSON.stringify(error), /DoNotPublish/, 'the refusal must name the recorded intent (F10-AC1)');

    const begun = publications.beginPublication(
      { workItemId: declined, operationId: 'op-declined' },
      { projectId: PROJECT, correlationId: 'corr-1', at: T0 },
    );
    expectError(begun, 'Invalid');
    assert.equal(
      publications.findOperation('op-declined'),
      null,
      'a refused publication must not record an intent it will never perform',
    );
  });
});

test('N01-AC3 the intent row and the publishing state commit together (F10-AC1)', async () => {
  await withDatabase(({ database, publications }) => {
    const item = workItem(database, 'Publish the run summary');
    const begun = expectOk(
      publications.beginPublication(
        { workItemId: item, operationId: 'op-begin' },
        { projectId: PROJECT, correlationId: 'corr-1', at: T0 },
      ),
    );

    assert.equal(begun.workItem.publicationState, 'Publishing');
    assert.equal(begun.workItem.publicationOperationId, 'op-begin');
    const operation = publications.findOperation('op-begin');
    assert.notEqual(operation, null, 'the ledger intent row did not commit with the work item');
    assert.equal(operation?.kind, 'PublishIssue');
    assert.equal(operation?.status, 'IntentRecorded');
  });
});

test('F10-AC2 a publication saves the provider identity, URL and revision, and nothing else (F10-AC4)', async () => {
  await withDatabase(({ database, publications }) => {
    const item = workItem(database, 'Publish the run summary');
    expectOk(
      publications.beginPublication(
        { workItemId: item, operationId: 'op-publish' },
        { projectId: PROJECT, correlationId: 'corr-1', at: T0 },
      ),
    );

    const settled = expectOk(
      publications.settlePublished(
        {
          operationId: 'op-publish',
          providerIssueId: '3a2f1e0d-0000-4000-8000-000000000001',
          providerIssueIdentifier: 'ENG-101',
          providerIssueUrl: 'https://tickets.invalid/ENG-101',
          providerRevision: '2026-05-01T09:04:59.000Z',
          publishedAt: T1,
        },
        item,
      ),
    );

    assert.equal(settled.publicationState, 'Published');
    assert.equal(settled.publicationIntent, 'Published');
    assert.equal(settled.externalIssueIdentifier, 'ENG-101');
    assert.equal(settled.externalIssueUrl, 'https://tickets.invalid/ENG-101');

    const revision = database
      .prepare('SELECT provider_revision FROM work_items WHERE work_item_id = ?')
      .get(item);
    assert.equal(revision?.['provider_revision'], '2026-05-01T09:04:59.000Z');

    // The live issue is the ticket: the row holds no editable copy of its content.
    const editable = database
      .prepare("SELECT name FROM pragma_table_info('work_items') WHERE name IN ('description', 'acceptance_criteria')")
      .all();
    assert.deepEqual(
      editable,
      [],
      'work_items grew an editable content column, which would be a second live ticket (F10-AC4)',
    );
  });
});

test('F10-AC3 a repeat of an applied publication is refused by the ledger, not written again', async () => {
  await withDatabase(({ database, publications }) => {
    const item = workItem(database, 'Publish the run summary');
    expectOk(
      publications.beginPublication(
        { workItemId: item, operationId: 'op-repeat' },
        { projectId: PROJECT, correlationId: 'corr-1', at: T0 },
      ),
    );
    expectOk(
      publications.settlePublished(
        {
          operationId: 'op-repeat',
          providerIssueId: '3a2f1e0d-0000-4000-8000-000000000002',
          providerIssueIdentifier: 'ENG-102',
          providerIssueUrl: 'https://tickets.invalid/ENG-102',
          providerRevision: null,
          publishedAt: T1,
        },
        item,
      ),
    );

    const refused = expectError(publications.assertWritable('op-repeat', T1), 'Conflict');
    assert.match(refused.reason, /already succeeded/);

    const decision = expectOk(publications.retryDecision('op-repeat', T1));
    assert.equal(decision.permitted, false);
    assert.equal(decision.permitted === false ? decision.basis : null, 'AlreadyApplied');
    assert.equal(
      decision.permitted === false ? decision.providerIdentity : null,
      '3a2f1e0d-0000-4000-8000-000000000002',
      'the reconciliation must be able to read the identity the successful write produced',
    );
  });
});

test('F30-AC5 a lost response becomes OutcomeUnknown and blocks every later write (N01-AC2)', async () => {
  await withDatabase(({ database, publications }) => {
    const item = workItem(database, 'Publish the run summary');
    expectOk(
      publications.beginPublication(
        { workItemId: item, operationId: 'op-lost' },
        { projectId: PROJECT, correlationId: 'corr-1', at: T0 },
      ),
    );

    const unresolved = expectOk(
      publications.settleUnresolved({
        workItemId: item,
        operationId: 'op-lost',
        detail: 'The response to the issue creation was never received.',
        observedAt: T1,
      }),
    );
    assert.equal(unresolved.publicationState, 'OutcomeUnknown');

    const writable = publications.assertWritable('op-lost', T1);
    assert.equal(writable.ok, false, 'a lost response must not be writable again (F30-AC5)');
    const decision = expectOk(publications.retryDecision('op-lost', T1));
    assert.equal(decision.permitted, false);
    assert.equal(decision.permitted === false ? decision.basis : null, 'OutcomeUnknown');

    const worklist = publications.pendingReconciliation(LATER).filter((entry) => entry.operationId === 'op-lost');
    assert.equal(worklist.length, 1, 'an unresolved write must appear on the reconciliation worklist (F30-AC5)');
    assert.match(worklist[0]?.unknown ?? '', /never received/);
  });
});

test('F10-AC5 a provider refusal keeps the proposal and permits a retry without a second operation', async () => {
  await withDatabase(({ database, publications }) => {
    const published = workItem(database, 'Already published');
    const refused = workItem(database, 'Permission refused');

    expectOk(
      publications.beginPublication(
        { workItemId: published, operationId: 'op-ok' },
        { projectId: PROJECT, correlationId: 'corr-1', at: T0 },
      ),
    );
    expectOk(
      publications.settlePublished(
        {
          operationId: 'op-ok',
          providerIssueId: '3a2f1e0d-0000-4000-8000-000000000003',
          providerIssueIdentifier: 'ENG-103',
          providerIssueUrl: 'https://tickets.invalid/ENG-103',
          providerRevision: null,
          publishedAt: T1,
        },
        published,
      ),
    );

    expectOk(
      publications.beginPublication(
        { workItemId: refused, operationId: 'op-forbidden' },
        { projectId: PROJECT, correlationId: 'corr-1', at: T0 },
      ),
    );
    const settled = expectOk(
      publications.settleRefused({
        workItemId: refused,
        operationId: 'op-forbidden',
        detail: 'The connector was refused permission to create issues in this team.',
        category: 'PermissionDenied',
        observedAt: T1,
      }),
    );

    assert.equal(settled.publicationState, 'Unpublished', 'a refusal must return the ticket to unpublished');
    assert.equal(settled.publicationIntent, 'PublishWhenAgreed', "the owner's selection must survive the refusal");

    const decision = expectOk(publications.retryDecision('op-forbidden', T1));
    assert.equal(decision.permitted, true, 'a refused write established as not applied must permit a retry');

    const targets = expectOk(publications.listPublicationTargets(PROJECT));
    const succeeded = targets.find((target) => target.workItemId === published);
    assert.equal(succeeded?.publicationState, 'Published');
    assert.equal(succeeded?.providerIssueIdentifier, 'ENG-103', 'the successful mapping must survive another ticket failing');
  });
});

test('F10-AC2 the per-ticket report names exactly what remains unpublished', async () => {
  await withDatabase(({ database, publications }) => {
    const first = workItem(database, 'First ticket');
    const second = workItem(database, 'Second ticket');
    const third = workItem(database, 'Third ticket');

    for (const [index, id] of [first, second, third].entries()) {
      expectOk(
        publications.beginPublication(
          { workItemId: id, operationId: `op-ticket-${index}` },
          { projectId: PROJECT, correlationId: 'corr-1', at: T0 },
        ),
      );
    }
    expectOk(
      publications.settlePublished(
        {
          operationId: 'op-ticket-0',
          providerIssueId: '3a2f1e0d-0000-4000-8000-000000000010',
          providerIssueIdentifier: 'ENG-110',
          providerIssueUrl: 'https://tickets.invalid/ENG-110',
          providerRevision: null,
          publishedAt: T1,
        },
        first,
      ),
    );
    expectOk(
      publications.settleRefused({
        workItemId: second,
        operationId: 'op-ticket-1',
        detail: 'The team has no remaining issue capacity.',
        category: 'Validation',
        observedAt: T1,
      }),
    );
    expectOk(
      publications.settleUnresolved({
        workItemId: third,
        operationId: 'op-ticket-2',
        detail: 'The response was lost.',
        observedAt: T1,
      }),
    );

    const targets = expectOk(publications.listPublicationTargets(PROJECT));
    assert.equal(targets.length, 3);
    const sorted = (ids: readonly string[]): string[] => [...ids].sort();
    assert.deepEqual(
      sorted(targets.filter((target) => target.publicationState === 'Published').map((target) => target.workItemId)),
      sorted([first]),
      'a partial publication must keep the mapping that succeeded (F10-AC5)',
    );
    assert.deepEqual(
      sorted(targets.filter((target) => target.publicationState !== 'Published').map((target) => target.workItemId)),
      sorted([second, third]),
      'every unpublished ticket must remain named (F10-AC2)',
    );
  });
});

test('F10-AC3 one work item cannot be published by two operations', async () => {
  await withDatabase(({ database, publications }) => {
    const item = workItem(database, 'Publish the run summary');
    expectOk(
      publications.beginPublication(
        { workItemId: item, operationId: 'op-first' },
        { projectId: PROJECT, correlationId: 'corr-1', at: T0 },
      ),
    );
    const second = publications.beginPublication(
      { workItemId: item, operationId: 'op-second' },
      { projectId: PROJECT, correlationId: 'corr-1', at: T0 },
    );
    const error = expectError(second, 'Conflict');
    assert.match(error.reason, /op-first/);
  });
});

test('F28-AC4 an applied resolution may only be recorded with the provider identity that proves it', async () => {
  await withDatabase(({ database, publications }) => {
    const item = workItem(database, 'Publish the run summary');
    expectOk(
      publications.beginPublication(
        { workItemId: item, operationId: 'op-resolve' },
        { projectId: PROJECT, correlationId: 'corr-1', at: T0 },
      ),
    );
    expectOk(
      publications.settleUnresolved({
        workItemId: item,
        operationId: 'op-resolve',
        detail: 'The response was lost.',
        observedAt: T1,
      }),
    );

    const unevidenced = publications.recordResolution('op-resolve', {
      resolution: 'Applied',
      providerIdentity: '',
      detail: 'Probably fine.',
      resolvedBy: OWNER,
      resolvedAt: LATER,
      correlationId: 'corr-1',
    });
    expectError(unevidenced, 'Invalid');

    const applied = expectOk(
      publications.recordResolution('op-resolve', {
        resolution: 'Applied',
        providerIdentity: '3a2f1e0d-0000-4000-8000-000000000020',
        detail: 'Read the team backlog and found the issue the operation created.',
        resolvedBy: OWNER,
        resolvedAt: LATER,
        correlationId: 'corr-1',
      }),
    );
    assert.equal(applied.resolution, 'Applied');
    assert.equal(applied.providerIdentity, '3a2f1e0d-0000-4000-8000-000000000020');

    const decision = expectOk(publications.retryDecision('op-resolve', LATER));
    assert.equal(decision.permitted === false ? decision.basis : null, 'AlreadyApplied');
  });
});

test('F29-AC4 a repeated receipt publication is one row, not two (F16-AC4)', async () => {
  await withDatabase(({ database, publications }) => {
    const item = workItem(database, 'Publish the release receipt');
    expectOk(
      publications.beginPublication(
        { workItemId: item, operationId: 'op-receipt' },
        { projectId: PROJECT, correlationId: 'corr-1', at: T0 },
      ),
    );
    expectOk(
      publications.settlePublished(
        {
          operationId: 'op-receipt',
          providerIssueId: '3a2f1e0d-0000-4000-8000-000000000030',
          providerIssueIdentifier: 'ENG-130',
          providerIssueUrl: 'https://tickets.invalid/ENG-130',
          providerRevision: null,
          publishedAt: T1,
        },
        item,
      ),
    );

    const effect = {
      kind: 'ReceiptPublish',
      dedupKey: 'release-receipt:receipt-42',
      target: 'ENG-130',
      operationId: 'op-receipt',
      workItemId: item,
      correlationId: 'corr-1',
      payload: { receiptId: 'receipt-42' },
      expectedRefs: [{ id: 'comment_receipt-42', kind: 'ManagedComment', url: null }],
      at: T1,
    };
    const first = expectOk(publications.enqueueExternalEffect(effect));
    const second = expectOk(publications.enqueueExternalEffect(effect));
    assert.equal(first.created, true);
    assert.equal(second.created, false, 'a repeated receipt publication enqueued a second effect (F29-AC4)');
    assert.equal(second.effect.effectId, first.effect.effectId);
    assert.equal(publications.findEffectByOperation('op-receipt').length, 1);
  });
});

test('F16-AC4 a failed external update is Pending sync and keeps the last success time', async () => {
  await withDatabase(({ database, publications }) => {
    const item = workItem(database, 'Publish the run summary');
    expectOk(
      publications.beginPublication(
        { workItemId: item, operationId: 'op-sync' },
        { projectId: PROJECT, correlationId: 'corr-1', at: T0 },
      ),
    );
    expectOk(
      publications.settlePublished(
        {
          operationId: 'op-sync',
          providerIssueId: '3a2f1e0d-0000-4000-8000-000000000040',
          providerIssueIdentifier: 'ENG-140',
          providerIssueUrl: 'https://tickets.invalid/ENG-140',
          providerRevision: null,
          publishedAt: T1,
        },
        item,
      ),
    );

    expectOk(
      publications.recordSyncResult({
        workItemId: item,
        attemptedAt: LATER,
        succeeded: false,
        error: 'The provider refused the update.',
      }),
    );

    const view = expectOk(publications.pendingSyncStatus(item));
    assert.equal(view.workItem?.state, 'PendingSync', 'a failed update must be a labelled pending state (F16-AC4)');
    assert.equal(view.workItem?.lastSuccessAt, T1, 'the last success time must survive the failure');
    assert.equal(view.workItem?.attemptCount, 2);
  });
});

test('F11-AC3 an issue already mapped in this project is refused, naming the holder (F11-AC4)', async () => {
  await withDatabase(({ publications }) => {
    const first = expectOk(
      publications.createAdoptedWorkItem({
        projectId: PROJECT,
        profileVersionId: PROFILE_VERSION,
        title: 'Existing work',
        externalIssueIdentifier: null,
        externalIssueUrl: null,
        publicationIntent: 'Published',
        relatedWorkItemIds: [],
        adoption: null,
        at: T0,
      }),
    );
    expectOk(
      publications.recordAdoption({
        workItemId: first.workItemId,
        operationId: null,
        providerIssueId: '3a2f1e0d-0000-4000-8000-000000000050',
        providerIssueIdentifier: 'ENG-150',
        providerIssueUrl: 'https://tickets.invalid/ENG-150',
        adoption: null,
        observedAt: T1,
        correlationId: 'corr-1',
      }),
    );

    const second = expectOk(
      publications.createAdoptedWorkItem({
        projectId: OTHER_PROJECT,
        profileVersionId: PROFILE_VERSION,
        title: 'Competing adoption',
        externalIssueIdentifier: null,
        externalIssueUrl: null,
        publicationIntent: 'Published',
        relatedWorkItemIds: [],
        adoption: null,
        at: T0,
      }),
    );
    const error = expectError(
      publications.recordAdoption({
        workItemId: second.workItemId,
        operationId: null,
        providerIssueId: '3a2f1e0d-0000-4000-8000-000000000050',
        providerIssueIdentifier: 'ENG-150',
        providerIssueUrl: 'https://tickets.invalid/ENG-150',
        adoption: null,
        observedAt: T1,
        correlationId: 'corr-1',
      }),
      'Conflict',
    );
    assert.match(error.reason, new RegExp(first.workItemId));
    assert.match(error.reason, new RegExp(PROJECT));

    assert.equal(publications.findByProviderIssue('3a2f1e0d-0000-4000-8000-000000000050')?.workItemId, first.workItemId);
  });
});

test('F11-AC4 an adopted branch records the head and target that were observed, never a generated start (F14-AC2)', async () => {
  await withDatabase(({ publications }) => {
    const adopted = expectOk(
      publications.createAdoptedWorkItem({
        projectId: PROJECT,
        profileVersionId: PROFILE_VERSION,
        title: 'Existing work',
        externalIssueIdentifier: null,
        externalIssueUrl: null,
        publicationIntent: 'Published',
        relatedWorkItemIds: [],
        adoption: null,
        at: T0,
      }),
    );

    const headSha = '4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7';
    const adoption: AdoptionReference = {
      repository: 'github.com/example/existing',
      headSha,
      targetBranch: 'main',
      pullRequestId: 'pr-77',
    };
    const bound = expectOk(
      publications.recordAdoption({
        workItemId: adopted.workItemId,
        operationId: null,
        providerIssueId: '3a2f1e0d-0000-4000-8000-000000000060',
        providerIssueIdentifier: 'ENG-160',
        providerIssueUrl: 'https://tickets.invalid/ENG-160',
        adoption,
        observedAt: T1,
        correlationId: 'corr-1',
      }),
    );

    assert.deepEqual(bound.adoption, adoption);
    assert.equal(bound.publicationState, 'Published');
    assert.equal(
      bound.source,
      'AdoptedIssue',
      "an adopted work item must not claim ShipLoop proposed it (F11-AC4)",
    );
  });
});

test('F11-AC2 linking a branch records the reference without rewriting the issue binding (F11-AC4)', async () => {
  await withDatabase(({ database, publications }) => {
    const adopted = expectOk(
      publications.createAdoptedWorkItem({
        projectId: PROJECT,
        profileVersionId: PROFILE_VERSION,
        title: 'Existing work',
        externalIssueIdentifier: null,
        externalIssueUrl: null,
        publicationIntent: 'Published',
        relatedWorkItemIds: [],
        adoption: null,
        at: T0,
      }),
    );
    expectOk(
      publications.recordAdoption({
        workItemId: adopted.workItemId,
        operationId: null,
        providerIssueId: '3a2f1e0d-0000-4000-8000-000000000080',
        providerIssueIdentifier: 'ENG-180',
        providerIssueUrl: 'https://tickets.invalid/ENG-180',
        adoption: null,
        observedAt: T1,
        correlationId: 'corr-1',
      }),
    );

    const linked = expectOk(
      publications.recordAdoptionReference({
        workItemId: adopted.workItemId,
        adoption: {
          repository: 'github.com/example/existing',
          headSha: '5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f',
          targetBranch: 'main',
          pullRequestId: 'pr-12',
        },
        observedAt: T1,
        correlationId: 'corr-1',
      }),
    );

    assert.equal(linked.externalIssueId, '3a2f1e0d-0000-4000-8000-000000000080', 'linking rewrote the issue binding (F11-AC4)');
    assert.equal(linked.externalIssueIdentifier, 'ENG-180');
    assert.equal(linked.adoption?.pullRequestId, 'pr-12');
    assert.equal(
      database
        .prepare('SELECT provider_revision FROM work_items WHERE work_item_id = ?')
        .get(adopted.workItemId)?.['provider_revision'],
      null,
      'linking a branch invented a provider revision for an issue it never read (F10-AC4)',
    );
  });
});

test('N01-AC3 an effect is bound to its work item, so the pending-sync view can find it (F16-AC4)', async () => {
  await withDatabase(({ database, publications }) => {
    const item = workItem(database, 'Publish the run summary');
    expectOk(
      publications.beginPublication(
        { workItemId: item, operationId: 'op-effect' },
        { projectId: PROJECT, correlationId: 'corr-1', at: T0 },
      ),
    );
    expectOk(
      publications.settlePublished(
        {
          operationId: 'op-effect',
          providerIssueId: '3a2f1e0d-0000-4000-8000-000000000070',
          providerIssueIdentifier: 'ENG-170',
          providerIssueUrl: 'https://tickets.invalid/ENG-170',
          providerRevision: null,
          publishedAt: T1,
        },
        item,
      ),
    );

    const enqueued = expectOk(
      publications.enqueueExternalEffect({
        kind: 'ProgressComment',
        dedupKey: 'progress:ENG-170:milestone-1',
        target: 'ENG-170',
        operationId: 'op-effect',
        workItemId: item,
        correlationId: 'corr-1',
        payload: { milestoneKey: 'milestone-1' },
        expectedRefs: [{ id: 'comment-1', kind: 'ManagedComment', url: null }],
        at: T1,
      }),
    );

    const view = expectOk(publications.pendingSyncStatus(item));
    assert.equal(view.updates.length, 1, 'the effect was not reachable from its work item');
    assert.deepEqual(view.updates[0]?.unpublishedRefs, [{ id: 'comment-1', kind: 'ManagedComment', url: null }]);

    expectOk(publications.markEffectSucceeded(enqueued.effect.effectId, T1, [{ id: 'comment-1', kind: 'ManagedComment', url: null }]));
    assert.deepEqual(publications.unpublishedRefs(enqueued.effect.effectId), []);
    assert.equal(
      database
        .prepare('SELECT work_item_id FROM outbox_events WHERE outbox_event_id = ?')
        .get(enqueued.effect.effectId)?.['work_item_id'],
      item,
    );
  });
});
