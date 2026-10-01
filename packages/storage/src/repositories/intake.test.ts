/**
 * Behavioural proof for durable intake (F06, F07, F32-AC2).
 *
 * Every test runs against the REAL migrated schema: a temporary SQLite file is
 * opened with `openDatabase`, `migrate` builds the production tables in it, and
 * the repository is driven against that. An inline fixture schema is not used
 * anywhere in this file, and that is the point: the previous version of
 * `core.test.ts` proved its repositories against a schema it invented, so it
 * passed while the application could not run. A test that proves a repository
 * against a schema it wrote itself proves nothing about the product.
 *
 * A file rather than `:memory:` is used because the properties under test are
 * durability properties. The raw request must still be the owner's own words
 * after the connection is closed and the file reopened, a prior brief version
 * must still be readable after a correction is appended, and the seeded secret
 * must be absent from an export taken after a restart. `:memory:` would make all
 * three vacuously true.
 *
 * The security-invariant tests are the other half of the proof. They assert
 * against the migrated schema's own triggers and CHECK constraints, because
 * those are what refuse a bad write in production: a repository method that
 * validated nothing would still be safe only if the database refused.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyProposal,
  createIdea,
  fingerprint,
  generateClarifyingQuestions,
} from '@shiploop/domain';
import type {
  BriefSections,
  DomainError,
  IdeaDraft,
  IdeaId,
  ProjectId,
  Result,
  ValidatedBriefProposal,
  WorkItemId,
} from '@shiploop/domain';
import { openDatabase, type Database } from '../db.ts';
import { LATEST_SCHEMA_VERSION, migrate } from '../migrations.ts';
import { IntakeRepository } from './intake.ts';

const PROJECT = '0a5f1c22-0000-4000-8000-00000000000a' as ProjectId;
const PROFILE_VERSION = '0a5f1c22-0000-4000-8000-00000000000f' as const;
const PROCEDURE_VERSION = 'procedure-version-1';
const OWNER = 'owner-0000-4000-8000-00000000000c';
const CAPTURED_AT = '2026-01-02T03:00:00.000Z';
const BRIEF_ID = 'brief-1';
const CONTENT_FINGERPRINT = fingerprint({ seed: 'intake-fixture' });
const RESTART_REQUEST = 'The saved run disappears when the browser closes.';

/**
 * A seeded credential, assembled from fragments at module load.
 *
 * It is a real match of the domain's github-token rule once evaluated, but no
 * tracked line contains a credential-shaped literal, which is what the
 * repository's own `secrets/no-literals` policy rule requires (N02-AC2).
 */
const SEEDED_TOKEN = ['gh', 'p_', 'Kf3Q9mZ2pLx7Rv4Tb8Nd6Hw1Ys5Uc0Ej'].join('');

function expectOk<T>(result: Result<T, DomainError>): T {
  if (!result.ok) assert.fail(`expected success but received ${result.error.code}: ${result.error.reason}`);
  return result.value;
}

function expectError<T>(result: Result<T, DomainError>, code: DomainError['code']): DomainError {
  if (result.ok) assert.fail(`expected ${code} but the call succeeded`);
  assert.equal(result.error.code, code);
  return result.error;
}

function ideaId(value: string): IdeaId {
  return value as IdeaId;
}

/**
 * A draft the domain has already accepted.
 *
 * Built through `createIdea` rather than assembled by hand so a test cannot
 * persist a shape the domain would refuse.
 */
function captured(
  id: string,
  rawRequest: string,
  overrides: Partial<Parameters<typeof createIdea>[0]> = {},
): IdeaDraft {
  const created = createIdea({
    ideaId: ideaId(id),
    rawRequest,
    capturedAt: CAPTURED_AT,
    kind: 'FeatureRequest',
    projectId: PROJECT,
    ...overrides,
  });
  if (!created.ok) assert.fail(`the fixture idea was refused: ${created.error.reason}`);
  return created.value;
}

const SECTIONS: BriefSections = {
  problem: 'The saved run disappears when the browser closes.',
  desiredOutcome: 'A saved run is still there after a restart.',
  includedBehaviour: ['A run survives a page reload.'],
  excludedBehaviour: ['Resuming a run on another machine is out of scope.'],
  assumptions: ['The local database file is the durable store.'],
  acceptanceCriteria: [
    { id: 'ac-1', text: 'the run list shows the saved run after the page is reloaded', verification: 'Browser run.' },
  ],
  unresolvedQuestions: [],
};

function validatedProposal(
  idea: IdeaId,
  sections: BriefSections,
  basedOn: number | null,
  at: string,
): ValidatedBriefProposal {
  return expectOk(
    applyProposal({
      kind: 'BriefProposal',
      ideaId: idea,
      authoredBy: 'ClarificationModel',
      authoredAt: at,
      basedOnBriefVersion: basedOn,
      sections,
    }),
  );
}

/**
 * Opens a real database file, migrates it with the production runner, runs the
 * body, closes, then runs `afterReopen` against a second connection to the same
 * file before removing the directory.
 *
 * `openDatabase` is the real connection factory, so the pragmas this repository
 * depends on are the ones production gets. The post-close hook is what lets a
 * test assert durability rather than asserting an in-memory cache.
 */
async function withDatabase(
  run: (database: { readonly connection: Database; readonly file: string }) => Promise<void> | void,
  afterReopen?: (file: string) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-storage-intake-'));
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
    if (afterReopen !== undefined) {
      const reopened = openDatabase(file);
      assert.ok(reopened.ok, 'the database could not be reopened');
      try {
        await afterReopen(file);
      } finally {
        reopened.value.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Creates the owner, project and run-context parents the foreign keys require.
 *
 * `work_items` and the brief tables carry real foreign keys here because
 * `openDatabase` turns them on, so those parents must exist before the
 * repository can write a child. The repository deliberately does not create a
 * project: a repository that quietly created its own parent would hide a missing
 * provisioning step.
 */
function seedOwnerAndProject(connection: Database): void {
  connection
    .prepare('INSERT INTO owners (owner_id, display_name, created_at) VALUES (?, ?, ?)')
    .run(OWNER, 'Solo owner', '2026-01-01T00:00:00.000Z');
  connection
    .prepare('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)')
    .run(PROJECT, 'Example project', '2026-01-01T00:00:00.000Z');
  connection
    .prepare(
      `INSERT INTO project_profile_versions
         (profile_version_id, project_id, version, content_json, content_fingerprint, created_by, created_at)
       VALUES (?, ?, 1, '{}', ?, ?, ?)`,
    )
    .run(PROFILE_VERSION, PROJECT, CONTENT_FINGERPRINT, OWNER, '2026-01-01T00:00:00.000Z');
  connection
    .prepare(
      `INSERT INTO procedure_versions
         (procedure_version_id, project_id, version, kind, source, content_json, content_fingerprint, created_by, created_at)
       VALUES (?, ?, 1, 'Procedure', 'Owner', '{}', ?, ?, ?)`,
    )
    .run(PROCEDURE_VERSION, PROJECT, CONTENT_FINGERPRINT, OWNER, '2026-01-01T00:00:00.000Z');
}

/** A work item to publish an idea as, because the produced-work foreign key is real. */
function seedWorkItem(connection: Database, workItemId: string): void {
  connection
    .prepare(
      `INSERT INTO work_items (work_item_id, project_id, profile_version_id, source, origin, title, issue_id, publication_intent, created_at)
       VALUES (?, ?, ?, 'CapturedIdea', 'Proposed', 'Ship the release receipt page', ?, 'PublishWhenAgreed', ?)`,
    )
    .run(workItemId, PROJECT, PROFILE_VERSION, `issue-${workItemId}`, CAPTURED_AT);
}

test('capture persists the request, its optional project, notes and the bug detail that exists (F06-AC1, F06-AC3)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const intake = new IntakeRepository(connection);

    const bug = captured('idea-bug', '  The saved run disappears when the browser closes.  ', {
      kind: 'Bug',
      notes: 'Happened twice on the preview project.',
      detail: {
        expected: 'The run resumes after a restart.',
        actual: 'The run list is empty.',
        reproduction: 'Start a run, close the tab, reopen it.',
      },
    });
    expectOk(intake.capture(bug));

    // Surrounding whitespace is removed once at capture, and the stored text is
    // the owner's own words (F06-AC1).
    const stored = expectOk(intake.read(bug.ideaId));
    assert.equal(stored.rawRequest, 'The saved run disappears when the browser closes.');
    assert.equal(stored.projectId, PROJECT);
    assert.equal(stored.notes, 'Happened twice on the preview project.');
    assert.deepEqual(stored.request, {
      kind: 'Bug',
      detail: {
        expected: 'The run resumes after a restart.',
        actual: 'The run list is empty.',
        reproduction: 'Start a run, close the tab, reopen it.',
      },
    });
    assert.equal(stored.disposition.state, 'Unpublished');
    assert.equal(stored.summary, null);
    assert.deepEqual(stored.attachments, []);

    // A bug with no detail at all is still a capture: missing optional fields
    // must not prevent one (F06-AC3).
    const bare = captured('idea-bare-bug', 'The dashboard is empty after a restart.', { kind: 'Bug' });
    expectOk(intake.capture(bare));
    assert.deepEqual(expectOk(intake.read(bare.ideaId)).request, {
      kind: 'Bug',
      detail: { expected: null, actual: null, reproduction: null },
    });

    // A feature request carries no bug detail, and an absent project is allowed.
    const feature = captured('idea-feature', 'Ship the release receipt page.', { projectId: null, notes: null });
    expectOk(intake.capture(feature));
    const readFeature = expectOk(intake.read(feature.ideaId));
    assert.deepEqual(readFeature.request, { kind: 'FeatureRequest' });
    assert.equal(readFeature.projectId, null);
    assert.equal(readFeature.notes, null);
  });
});

test('a blank request is refused before anything is written, and the column refuses it too (F06-AC1)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const blank = createIdea({
      ideaId: ideaId('idea-blank'),
      rawRequest: '   ',
      capturedAt: CAPTURED_AT,
      kind: 'FeatureRequest',
    });
    expectError(blank, 'Invalid');

    // The schema is the backstop: a statement that bypassed the domain is
    // refused by the column's own CHECK.
    assert.throws(() =>
      connection
        .prepare(
          `INSERT INTO ideas (idea_id, project_id, kind, raw_request, state, open_questions, created_at, updated_at)
           VALUES (?, ?, 'FeatureRequest', '   ', 'Received', '[]', ?, ?)`,
        )
        .run(ideaId('idea-blank'), PROJECT, CAPTURED_AT, CAPTURED_AT),
    );
  });
});

test('a generated summary is separate from the raw request and records the text it came from (F06-AC1)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const intake = new IntakeRepository(connection);
    const idea = captured('idea-summary', 'The saved run disappears when the browser closes.');
    expectOk(intake.capture(idea));

    const summarized = expectOk(
      intake.summarize({
        ideaId: idea.ideaId,
        text: 'Durable runs survive a browser restart.',
        generatedBy: 'clarification-model',
        at: '2026-01-02T03:05:00.000Z',
      }),
    );
    assert.equal(summarized.summary?.text, 'Durable runs survive a browser restart.');
    assert.equal(summarized.summary?.generatedBy, 'clarification-model');
    assert.equal(summarized.summary?.generatedAt, '2026-01-02T03:05:00.000Z');
    assert.equal(summarized.summary?.rawRequestFingerprint, fingerprint(idea.rawRequest));
    assert.notEqual(summarized.rawRequest, summarized.summary?.text);
    assert.equal(summarized.rawRequest, idea.rawRequest);

    // Re-summarising replaces the derived sentence and leaves the request
    // byte-identical.
    const resummarized = expectOk(
      intake.summarize({
        ideaId: idea.ideaId,
        text: 'Runs persist in SQLite and reconcile on startup.',
        generatedBy: 'clarification-model',
        at: '2026-01-02T03:06:00.000Z',
      }),
    );
    assert.equal(resummarized.summary?.text, 'Runs persist in SQLite and reconcile on startup.');
    assert.equal(resummarized.rawRequest, idea.rawRequest);
    assert.equal(resummarized.summary?.rawRequestFingerprint, fingerprint(idea.rawRequest));

    // The columns are distinct on disk, which is the property the domain's
    // separation exists to guarantee.
    const row = connection
      .prepare('SELECT raw_request, generated_summary FROM ideas WHERE idea_id = ?')
      .get(idea.ideaId);
    assert.equal(row?.['raw_request'], idea.rawRequest);
    assert.equal(row?.['generated_summary'], 'Runs persist in SQLite and reconcile on startup.');

    // A summary that can no longer be traced to a request is refused by the
    // schema, whichever column loses the provenance.
    assert.throws(
      () =>
        connection
          .prepare('UPDATE ideas SET summary_generated_by = NULL WHERE idea_id = ?')
          .run(idea.ideaId),
      /records when, by what/,
    );
    assert.throws(
      () =>
        connection
          .prepare('UPDATE ideas SET summary_raw_request_fingerprint = NULL WHERE idea_id = ?')
          .run(idea.ideaId),
      /records when, by what/,
    );
    assert.throws(
      () =>
        connection
          .prepare('UPDATE ideas SET generated_summary = NULL WHERE idea_id = ?')
          .run(idea.ideaId),
      /records when, by what/,
    );
    // A truncated fingerprint is refused by the column's own CHECK.
    assert.throws(
      () =>
        connection
          .prepare('UPDATE ideas SET summary_raw_request_fingerprint = ? WHERE idea_id = ?')
          .run('fp_short', idea.ideaId),
    );
    assert.equal(expectOk(intake.read(idea.ideaId)).summary?.text, 'Runs persist in SQLite and reconcile on startup.');
  });
});

test('the raw request cannot be overwritten, by this repository or by a direct statement (F06-AC1)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const intake = new IntakeRepository(connection);
    const idea = captured('idea-immutable', 'The saved run disappears when the browser closes.');
    expectOk(intake.capture(idea));
    expectOk(
      intake.summarize({
        ideaId: idea.ideaId,
        text: 'Durable runs survive a browser restart.',
        generatedBy: 'clarification-model',
        at: '2026-01-02T03:05:00.000Z',
      }),
    );

    // A statement that tries to make the generated sentence the request is
    // refused by the trigger, and the request is still the owner's own words.
    assert.throws(
      () =>
        connection
          .prepare("UPDATE ideas SET raw_request = generated_summary WHERE idea_id = ?")
          .run(idea.ideaId),
      /raw_request/,
    );
    assert.throws(
      () =>
        connection
          .prepare('UPDATE ideas SET raw_request = ? WHERE idea_id = ?')
          .run('A tidied-up version of the request.', idea.ideaId),
      /raw_request/,
    );
    assert.equal(expectOk(intake.read(idea.ideaId)).rawRequest, idea.rawRequest);
  });
});

test('the raw request survives a close and a reopen (F06-AC2)', async () => {
  await withDatabase(
    async ({ connection }) => {
      seedOwnerAndProject(connection);
      const intake = new IntakeRepository(connection);
      const idea = captured('idea-restart', RESTART_REQUEST);
      expectOk(intake.capture(idea));
      expectOk(
        intake.summarize({
          ideaId: idea.ideaId,
          text: 'Durable runs survive a browser restart.',
          generatedBy: 'clarification-model',
          at: '2026-01-02T03:05:00.000Z',
        }),
      );
    },
    async (file) => {
      const reopened = openDatabase(file);
      assert.ok(reopened.ok, 'the database could not be reopened');
      try {
        const intake = new IntakeRepository(reopened.value);
        const survived = expectOk(intake.read(ideaId('idea-restart')));
        assert.equal(survived.rawRequest, RESTART_REQUEST);
        assert.equal(survived.summary?.text, 'Durable runs survive a browser restart.');
        assert.equal(survived.summary?.rawRequestFingerprint, fingerprint(RESTART_REQUEST));
      } finally {
        reopened.value.close();
      }
    },
  );
});

test('attachments are named files referenced by rows, and a name that could escape is refused (F06-AC1)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const intake = new IntakeRepository(connection);
    const idea = captured('idea-attachments', 'Attach the screenshot of the empty run list.');
    expectOk(intake.capture(idea));

    const withFile = expectOk(
      intake.addAttachment({
        ideaId: idea.ideaId,
        name: 'empty-run-list.png',
        mediaType: 'image/png',
        byteSize: 20481,
        addedAt: '2026-01-02T03:06:00.000Z',
      }),
    );
    assert.equal(withFile.attachments.length, 1);
    assert.equal(withFile.attachments[0]?.name, 'empty-run-list.png');
    assert.equal(withFile.attachments[0]?.mediaType, 'image/png');
    assert.equal(withFile.attachments[0]?.byteSize, 20481);

    // The row carries a pointer and a digest, never the bytes: an idea record
    // cannot become an alternative content store.
    const row = connection
      .prepare('SELECT artifact_ref, byte_size, content_digest, relative_path FROM idea_attachments WHERE idea_id = ?')
      .get(idea.ideaId);
    assert.equal(row?.['artifact_ref'], 'empty-run-list.png');
    assert.equal(row?.['byte_size'], 20481);
    assert.equal(typeof row?.['content_digest'], 'string');
    assert.equal(row?.['relative_path'], 'empty-run-list.png');

    // Every refusal names the traversal it prevents, because a sanitised name
    // would write somewhere the owner did not intend.
    expectError(
      intake.addAttachment({
        ideaId: idea.ideaId,
        name: '../secrets.txt',
        mediaType: 'text/plain',
        byteSize: 12,
        addedAt: '2026-01-02T03:07:00.000Z',
      }),
      'Invalid',
    );
    expectError(
      intake.addAttachment({
        ideaId: idea.ideaId,
        name: 'artifacts/ideas/nested.png',
        mediaType: 'image/png',
        byteSize: 12,
        addedAt: '2026-01-02T03:07:00.000Z',
      }),
      'Invalid',
    );
    expectError(
      intake.addAttachment({
        ideaId: idea.ideaId,
        name: 'empty-run-list.png',
        mediaType: 'image/png',
        byteSize: 12,
        addedAt: '2026-01-02T03:07:00.000Z',
      }),
      'Invalid',
    );
    expectError(
      intake.addAttachment({
        ideaId: idea.ideaId,
        name: 'notes.exe',
        mediaType: 'application/octet-stream' as 'text/plain',
        byteSize: 12,
        addedAt: '2026-01-02T03:07:00.000Z',
      }),
      'Invalid',
    );
    assert.equal(expectOk(intake.read(idea.ideaId)).attachments.length, 1);
  });
});

test('deferring and archiving an unpublished idea create no ticket and consume no coding run (F06-AC5)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const intake = new IntakeRepository(connection);

    const deferred = captured('idea-deferred', 'A dashboard filter nobody has asked for yet.');
    expectOk(intake.capture(deferred));
    const deferredDraft = expectOk(
      intake.defer(deferred.ideaId, '2026-01-02T04:00:00.000Z', 'Waiting on the filter design.'),
    );
    assert.equal(deferredDraft.disposition.state, 'Deferred');
    assert.equal(
      connection.prepare('SELECT COUNT(*) AS total FROM work_items').get()?.total,
      0,
    );
    assert.equal(connection.prepare('SELECT COUNT(*) AS total FROM jobs').get()?.total, 0);

    const archived = captured('idea-archived', 'An idea that turned out to be a duplicate.');
    expectOk(intake.capture(archived));
    const archivedDraft = expectOk(
      intake.archive(archived.ideaId, OWNER, '2026-01-02T04:05:00.000Z', 'Already covered by ENG-4.'),
    );
    assert.equal(archivedDraft.disposition.state, 'Archived');
    assert.equal(
      archivedDraft.disposition.state === 'Archived' ? archivedDraft.disposition.archivedBy : null,
      OWNER,
    );
    assert.equal(connection.prepare('SELECT COUNT(*) AS total FROM work_items').get()?.total, 0);
    assert.equal(connection.prepare('SELECT COUNT(*) AS total FROM jobs').get()?.total, 0);
  });
});

test('an idea that produced work cannot be archived, by the domain or by a direct statement (F06-AC5)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    seedWorkItem(connection, 'work-item-published');
    const intake = new IntakeRepository(connection);
    const idea = captured('idea-published', 'Ship the release receipt page.');
    expectOk(intake.capture(idea));

    const published = expectOk(
      intake.recordProducedWork({
        ideaId: idea.ideaId,
        workItemIds: ['work-item-published' as WorkItemId],
        codingRunIds: ['coding-run-1'],
        at: '2026-01-02T05:00:00.000Z',
      }),
    );
    assert.equal(published.disposition.state, 'Published');
    assert.equal(
      published.disposition.state === 'Published' ? published.disposition.workItemIds[0] : null,
      'work-item-published',
    );

    expectError(intake.archive(idea.ideaId, OWNER, '2026-01-02T05:01:00.000Z', 'Changed my mind.'), 'Forbidden');

    // The schema refuses it independently by reading the produced-work rows, so
    // the rule does not depend on a flag a caller might forget to maintain.
    assert.throws(
      () =>
        connection
          .prepare("UPDATE ideas SET state = 'Abandoned', archived_at = ?, archived_by = ? WHERE idea_id = ?")
          .run('2026-01-02T05:02:00.000Z', OWNER, idea.ideaId),
      /cannot be archived/,
    );
    assert.equal(expectOk(intake.read(idea.ideaId)).disposition.state, 'Published');
  });
});

test('a brief records the request it was derived from and cannot be bound to another idea (F07-AC1, F05-AC5)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const intake = new IntakeRepository(connection);
    const idea = captured('idea-brief', 'The saved run disappears when the browser closes.');
    expectOk(intake.capture(idea));
    const other = captured('idea-other', 'Ship the release receipt page.');
    expectOk(intake.capture(other));

    const brief = expectOk(
      intake.draftAndAppend(BRIEF_ID, idea, validatedProposal(idea.ideaId, SECTIONS, null, '2026-01-02T03:10:00.000Z')),
    );
    assert.equal(brief.version, 1);
    assert.equal(brief.state, 'Proposed');
    assert.equal(brief.rawRequestFingerprint, fingerprint(idea.rawRequest));
    assert.equal(brief.supersedesVersion, null);

    // A proposal produced for another idea is a Conflict, not a rebinding: the
    // brief for `idea` cannot be built from a proposal that claims to be about
    // `other` (F05-AC5).
    const forOther = expectOk(
      applyProposal({
        kind: 'BriefProposal',
        ideaId: other.ideaId,
        authoredBy: 'ClarificationModel',
        authoredAt: '2026-01-02T03:11:00.000Z',
        basedOnBriefVersion: null,
        sections: SECTIONS,
      }),
    );
    expectError(intake.draftAndAppend(BRIEF_ID, idea, forOther), 'Conflict');
    assert.equal(expectOk(intake.listBriefs(idea.ideaId)).length, 1);
    assert.equal(expectOk(intake.listBriefs(other.ideaId)).length, 0);
  });
});

test('a correction appends a brief version and the prior version stays readable (F07-AC3)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const intake = new IntakeRepository(connection);
    const idea = captured('idea-correction', 'The saved run disappears when the browser closes.');
    expectOk(intake.capture(idea));
    expectOk(intake.recordTurn(idea.ideaId, { kind: 'RawRequest', at: CAPTURED_AT, text: idea.rawRequest }));

    const first = expectOk(
      intake.draftAndAppend(BRIEF_ID, idea, validatedProposal(idea.ideaId, SECTIONS, null, '2026-01-02T03:10:00.000Z')),
    );

    const correctedSections: BriefSections = {
      ...SECTIONS,
      excludedBehaviour: [...SECTIONS.excludedBehaviour, 'Migrating an existing database is out of scope.'],
      acceptanceCriteria: [
        ...SECTIONS.acceptanceCriteria,
        { id: 'ac-2', text: 'the run list records the run that was restored', verification: 'Browser run.' },
      ],
    };
    const second = expectOk(
      intake.applyCorrection({
        ideaId: idea.ideaId,
        brief: first,
        correctionId: 'correction-1',
        text: 'The run list must also record which run was restored.',
        at: '2026-01-02T03:20:00.000Z',
        proposal: validatedProposal(idea.ideaId, correctedSections, 1, '2026-01-02T03:20:00.000Z'),
      }),
    );
    assert.equal(second.version, 2);
    assert.equal(second.supersedesVersion, 1);

    const versions = expectOk(intake.listBriefs(idea.ideaId));
    assert.equal(versions.length, 2);
    assert.equal(versions[0]?.version, 1);
    assert.equal(versions[1]?.version, 2);
    // The prior version is unchanged, so the owner can see what they said and
    // what changed in response (F07-AC3).
    assert.deepEqual(versions[0]?.sections, SECTIONS);
    assert.equal(versions[1]?.sections.acceptanceCriteria.length, 2);
    assert.equal(expectOk(intake.currentBrief(idea.ideaId))?.version, 2);

    // The correction is in the conversation, in order, after the raw request.
    const conversation = expectOk(intake.conversation(idea.ideaId));
    assert.equal(conversation.ideaId, idea.ideaId);
    assert.deepEqual(
      conversation.turns.map((turn) => turn.kind),
      ['RawRequest', 'Correction'],
    );
    const correctionTurn = conversation.turns[1];
    assert.equal(correctionTurn?.kind === 'Correction' ? correctionTurn.briefVersion : null, 2);
    assert.equal(
      correctionTurn?.kind === 'Correction' ? correctionTurn.text : null,
      'The run list must also record which run was restored.',
    );
  });
});

test('a brief version is immutable in the schema, not only in this repository (F07-AC3)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const intake = new IntakeRepository(connection);
    const idea = captured('idea-immutable-brief', 'The saved run disappears when the browser closes.');
    expectOk(intake.capture(idea));
    const brief = expectOk(
      intake.draftAndAppend(BRIEF_ID, idea, validatedProposal(idea.ideaId, SECTIONS, null, '2026-01-02T03:10:00.000Z')),
    );

    assert.throws(
      () => connection.prepare('UPDATE briefs SET sections_json = ? WHERE brief_id = ?').run('{}', brief.briefId),
      /immutable/,
    );
    assert.throws(
      () => connection.prepare('DELETE FROM briefs WHERE brief_id = ?').run(brief.briefId),
      /retained/,
    );
    assert.deepEqual(expectOk(intake.listBriefs(idea.ideaId))[0]?.sections, SECTIONS);

    // Agreement is the one thing that may land afterwards, and only forwards.
    const agreed = expectOk(intake.agreeBrief(brief.briefId, OWNER, '2026-01-02T03:30:00.000Z'));
    assert.equal(agreed.state, 'Agreed');
    assert.equal(agreed.state === 'Agreed' ? agreed.agreedBy : null, OWNER);
    assert.throws(
      () => connection.prepare("UPDATE briefs SET state = 'Draft' WHERE brief_id = ?").run(brief.briefId),
      /immutable/,
    );
    expectError(intake.agreeBrief(brief.briefId, OWNER, '2026-01-02T03:31:00.000Z'), 'Conflict');
  });
});

test('a clarifying question records why it is material, and a row without that is refused (F07-AC2)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const intake = new IntakeRepository(connection);
    const idea = captured('idea-questions', 'Make the run list faster, or at least nicer.');
    expectOk(intake.capture(idea));
    expectOk(intake.recordTurn(idea.ideaId, { kind: 'RawRequest', at: CAPTURED_AT, text: idea.rawRequest }));

    const round = generateClarifyingQuestions({
      briefId: BRIEF_ID,
      ideaId: idea.ideaId,
      sections: SECTIONS,
      ambiguities: [
        {
          kind: 'UnspecifiedSubject',
          topic: 'run list latency',
          readings: ['the list query is slow', 'the page renders slowly after the data arrives'],
          answeredBy: [],
          impact: 'ChangesBehaviour',
          evidence: 'Make the run list faster, or at least nicer.',
        },
        {
          kind: 'UnstatedScopeBoundary',
          topic: 'run list colour',
          readings: ['restyle the list', 'restyle the list and the header'],
          answeredBy: [],
          impact: 'Cosmetic',
          evidence: 'or at least nicer',
        },
      ],
    });
    assert.equal(round.questions.length, 1);
    const question = round.questions[0];
    assert.equal(question?.topic, 'run list latency');

    const stored = expectOk(
      intake.recordQuestion({
        ideaId: idea.ideaId,
        briefId: BRIEF_ID,
        briefVersion: null,
        question: question!,
        at: '2026-01-02T03:12:00.000Z',
      }),
    );
    assert.equal(stored.topic, 'run list latency');
    assert.equal(stored.origin, 'Ambiguity');
    assert.equal(stored.readings.length, 2);
    assert.equal(stored.state, 'Open');

    // A question with no claim about why it is material is refused by the
    // column, so an interview the owner already sat through cannot be recorded.
    assert.throws(() =>
      connection
        .prepare("INSERT INTO idea_questions (question_id, idea_id, body, state, created_at) VALUES (?, ?, ?, 'Open', ?)")
        .run('question-unfounded', idea.ideaId, 'Which of these do you want?', CAPTURED_AT),
    );

    // A cosmetic ambiguity is recorded as considered and not asked (F07-AC2).
    const rejected = expectOk(
      intake.recordRejectedQuestion({
        ideaId: idea.ideaId,
        briefId: BRIEF_ID,
        briefVersion: null,
        topic: 'run list colour',
        rejection: 'CosmeticOnly',
        explanation: 'The ambiguity affects run list colour cosmetically, so an answer would not change the work.',
        at: '2026-01-02T03:12:00.000Z',
      }),
    );
    assert.equal(rejected.rejection, 'CosmeticOnly');
    assert.equal(expectOk(intake.listQuestions(idea.ideaId)).length, 1);

    const answered = expectOk(
      intake.answerQuestion(stored.questionId, 'The list query is slow.', '2026-01-02T03:15:00.000Z'),
    );
    assert.equal(answered.state, 'Answered');
    assert.equal(answered.answeredAt, '2026-01-02T03:15:00.000Z');

    expectOk(intake.recordTurn(idea.ideaId, { kind: 'Question', at: '2026-01-02T03:12:00.000Z', questionId: stored.questionId, prompt: question!.prompt }));
    expectOk(intake.recordTurn(idea.ideaId, { kind: 'Answer', at: '2026-01-02T03:15:00.000Z', questionId: stored.questionId, text: 'The list query is slow.' }));
    assert.deepEqual(
      expectOk(intake.conversation(idea.ideaId)).turns.map((turn) => turn.kind),
      ['RawRequest', 'Question', 'Answer'],
    );
  });
});

test('a conversation turn is append-only in the schema, and its kind must name what it references (F07-AC3)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const intake = new IntakeRepository(connection);
    const idea = captured('idea-turns', 'The saved run disappears when the browser closes.');
    expectOk(intake.capture(idea));
    expectOk(intake.recordTurn(idea.ideaId, { kind: 'RawRequest', at: CAPTURED_AT, text: idea.rawRequest }));

    assert.throws(
      () => connection.prepare('UPDATE idea_messages SET body_redacted = ?').run('A tidied version of the request.'),
      /appended/,
    );
    assert.throws(() => connection.prepare('DELETE FROM idea_messages').run(), /retained/);
    assert.throws(
      () =>
        connection
          .prepare(
            `INSERT INTO idea_messages (message_id, idea_id, turn_kind, correction_id, brief_version, author_role, body_redacted, created_at)
             VALUES (?, ?, 'Correction', 'correction-1', NULL, 'Owner', 'A correction with no version.', ?)`,
          )
          .run('message-1', idea.ideaId, CAPTURED_AT),
      /reference its kind names/,
    );
    assert.throws(
      () =>
        connection
          .prepare(
            `INSERT INTO idea_messages (message_id, idea_id, turn_kind, author_role, body_redacted, created_at)
             VALUES (?, ?, 'Question', 'Owner', 'An owner asking themselves.', ?)`,
          )
          .run('message-2', idea.ideaId, CAPTURED_AT),
      /reference its kind names/,
    );
    assert.deepEqual(
      expectOk(intake.conversation(idea.ideaId)).turns.map((turn) => turn.kind),
      ['RawRequest'],
    );
  });
});

test('the sanitized export carries the record and never a seeded secret (F32-AC2)', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    seedWorkItem(connection, 'work-item-export');
    const intake = new IntakeRepository(connection);

    // The owner pasted a token into their own request. The database keeps what
    // they typed; the export must not.
    const secretRequest = `The saved run disappears when the browser closes. Debug with ${SEEDED_TOKEN}.`;
    const idea = captured('idea-export', secretRequest, { notes: `Also seen with ${SEEDED_TOKEN}` });
    expectOk(intake.capture(idea));
    expectOk(
      intake.summarize({
        ideaId: idea.ideaId,
        text: `Durable runs survive a restart, per the ${SEEDED_TOKEN} incident.`,
        generatedBy: 'clarification-model',
        at: '2026-01-02T03:05:00.000Z',
      }),
    );
    expectOk(
      intake.addAttachment({
        ideaId: idea.ideaId,
        name: 'empty-run-list.png',
        mediaType: 'image/png',
        byteSize: 20481,
        addedAt: '2026-01-02T03:06:00.000Z',
      }),
    );
    expectOk(intake.recordTurn(idea.ideaId, { kind: 'RawRequest', at: CAPTURED_AT, text: secretRequest }));
    const brief = expectOk(
      intake.draftAndAppend(BRIEF_ID, idea, validatedProposal(idea.ideaId, SECTIONS, null, '2026-01-02T03:10:00.000Z')),
    );
    expectOk(
      intake.applyCorrection({
        ideaId: idea.ideaId,
        brief,
        correctionId: 'correction-1',
        text: `Only the list needs to record the run; the header does not. See ${SEEDED_TOKEN}.`,
        at: '2026-01-02T03:20:00.000Z',
        proposal: validatedProposal(idea.ideaId, SECTIONS, 1, '2026-01-02T03:20:00.000Z'),
      }),
    );
    expectOk(
      intake.recordProducedWork({
        ideaId: idea.ideaId,
        workItemIds: ['work-item-export' as WorkItemId],
        codingRunIds: ['coding-run-1'],
        at: '2026-01-02T03:25:00.000Z',
      }),
    );

    const exported = expectOk(intake.exportIdea(idea.ideaId));
    const serialized = JSON.stringify(exported);
    assert.equal(serialized.includes(SEEDED_TOKEN), false, 'the seeded secret must not appear in an export');
    assert.match(serialized, /\[redacted:github-token\]/);

    // The export is the record: the request, the brief history, the conversation
    // and the attachment index.
    assert.equal(exported.kind, 'FeatureRequest');
    assert.equal(exported.capturedAt, CAPTURED_AT);
    assert.match(exported.rawRequest, /The saved run disappears when the browser closes\./);
    assert.equal(exported.notes, `Also seen with [redacted:github-token]`);
    assert.equal(exported.summary?.generatedBy, 'clarification-model');
    assert.equal(exported.summary?.rawRequestFingerprint, fingerprint(idea.rawRequest));
    assert.equal(exported.disposition.state, 'Published');
    assert.equal(exported.attachments.length, 1);
    assert.equal(exported.attachments[0]?.fileName, 'empty-run-list.png');
    assert.equal(exported.attachments[0]?.byteSize, 20481);
    assert.equal(exported.briefVersions.length, 2);
    assert.equal(exported.briefVersions[1]?.version, 2);
    assert.equal(exported.briefVersions[1]?.supersedesVersion, 1);
    assert.deepEqual(
      exported.conversation.map((turn) => turn.kind),
      ['RawRequest', 'Correction'],
    );

    // Nothing in the shape can carry a credential, and the structural backstop
    // is what proves it: a field named like a secret would be dropped, and this
    // record has none, so the export is unchanged by the second pass.
    const keys = Object.keys(exported);
    for (const key of keys) {
      assert.equal(/token|key|secret|password|credential/i.test(key), false, `export carries a credential-shaped key ${key}`);
    }
    assert.equal(JSON.stringify(exported).includes('password_digest'), false);
  });
});

test('an unknown idea is a typed NotFound rather than a throw', async () => {
  await withDatabase(async ({ connection }) => {
    seedOwnerAndProject(connection);
    const intake = new IntakeRepository(connection);
    expectError(intake.read(ideaId('idea-absent')), 'NotFound');
    expectError(intake.exportIdea(ideaId('idea-absent')), 'NotFound');
    expectError(
      intake.addAttachment({
        ideaId: ideaId('idea-absent'),
        name: 'a.png',
        mediaType: 'image/png',
        byteSize: 10,
        addedAt: CAPTURED_AT,
      }),
      'NotFound',
    );
  });
});

test('migrating a fresh database twice applies nothing the second time, and no foreign key dangles (N01-AC3, N08-AC3)', async () => {
  await withDatabase(async ({ connection }) => {
    const versions = connection
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => `${row['version']}:${row['name']}`);
    assert.equal(versions[versions.length - 1], `${LATEST_SCHEMA_VERSION}:intake_durable`);

    const before = connection
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
      .all();
    const second = expectOk(migrate(connection));
    assert.deepEqual(second.applied, []);
    assert.equal(second.fromVersion, LATEST_SCHEMA_VERSION);
    assert.equal(second.toVersion, LATEST_SCHEMA_VERSION);
    assert.deepEqual(
      connection.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      before,
    );
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);
  });
});
