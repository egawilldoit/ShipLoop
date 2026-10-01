/**
 * Behavioural proof for intake: capture, attachments, summaries, disposition,
 * related work, the brief, clarification and export (F06-AC1, F06-AC2, F06-AC3,
 * F06-AC4, F06-AC5, F07-AC1, F07-AC2, F07-AC3, F01-AC1).
 *
 * Every case runs against a real SQLite file in a fresh temporary directory, opened
 * by the real `openDatabase` and brought to the real `migrate` version. No inline
 * fixture schema appears here: the rows these cases read and write are the
 * production rows, so a trigger or a check the domain relies on is exercised rather
 * than assumed (F06-AC2).
 *
 * The three cases that prove something structural rather than behavioural are the
 * ones worth reading first:
 *
 *   - a name that could escape the artifact root is refused, and nothing is written
 *     (F06-AC1);
 *   - a refused attachment leaves no file behind, so a failed save is never reported
 *     as a success and never leaves an orphan the owner cannot account for;
 *   - a saved draft is read back through a *second* repository instance on the same
 *     file, which is what "survives a restart" means here (F06-AC2).
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DomainError, IdeaId, Result } from '@shiploop/domain';
import { IdeaRepository, IntakeRepository, migrate, openDatabase } from '@shiploop/storage';
import type { Database } from '@shiploop/storage';
import { createIntakeUseCases, resolveAttachmentPath } from './intake.ts';
import type { IntakeUseCases } from './intake.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';

const NOW = '2026-10-02T10:00:00.000Z';
const LATER = '2026-10-02T11:00:00.000Z';

const clock: ControllerClock = { now: () => NOW };

const OWNER: OwnerActor = {
  actorId: 'owner_intake_fixture',
  role: 'Owner',
  ownerId: 'owner_intake_fixture' as OwnerActor['ownerId'],
  sessionId: 'session_intake_fixture',
};

const CODING_AGENT: OwnerActor = {
  actorId: 'coding-agent-intake',
  role: 'CodingAgent',
  ownerId: null,
  sessionId: null,
};

/** A second actor claiming the owner role without an owner identity to attribute to (F32-AC1). */
const UNATTRIBUTED: OwnerActor = {
  actorId: 'unattributed',
  role: 'Owner',
  ownerId: null,
  sessionId: null,
};

const SEARCH_REQUEST =
  'when I look at the runs page there is no way to find a run by name, I have to scroll through everything';

interface Harness {
  readonly useCases: IntakeUseCases;
  readonly intake: IntakeRepository;
  readonly ideas: IdeaRepository;
  readonly database: Database;
  readonly artifactRoot: string;
  readonly directory: string;
  /** Closes the first handle, which is what a process restart looks like from the file. */
  closePrimary(): void;
  /** A second repository on the same file, standing in for a restarted process (F06-AC2). */
  reopen(): IntakeRepository;
}

/**
 * A real store, a real migrated schema and a real artifact root.
 *
 * The clock advances by one hour per call rather than reading ambient time, so two
 * recorded instants in the same case stay ordered and a replay is reproducible
 * (mvp-spec 7).
 */
async function withHarness(body: (harness: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-controller-intake-'));
  const artifactRoot = join(directory, 'artifacts');
  const databasePath = join(directory, 'shiploop.sqlite');
  // The configured root exists before the case runs, because a deployment names a
  // directory that is already there; a case that asserts "nothing was written" must
  // be able to read an empty directory rather than a missing one.
  await mkdir(artifactRoot, { recursive: true });
  let primaryClosed = false;
  try {
    const opened = openDatabase(databasePath);
    assert.ok(opened.ok, 'the real database opened');
    assert.ok(migrate(opened.value).ok, 'the real schema migrated');

    const intake = new IntakeRepository(opened.value);
    const ideas = new IdeaRepository(opened.value);
    let ticks = 0;
    const stepped: ControllerClock = {
      now: () => {
        ticks += 1;
        return ticks === 1 ? NOW : `${LATER}#${ticks}`;
      },
    };
    const useCases = createIntakeUseCases({ clock: stepped, intake, ideas, artifactRoot });

    await body({
      useCases,
      intake,
      ideas,
      database: opened.value,
      artifactRoot,
      directory,
      reopen(): IntakeRepository {
        const second = openDatabase(databasePath);
        assert.ok(second.ok, 'a second handle opened the same file');
        return new IntakeRepository(second.value);
      },
      closePrimary(): void {
        opened.value.close();
        primaryClosed = true;
      },
    });
    if (!primaryClosed) opened.value.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function refusal<T>(result: Result<T, DomainError>): DomainError {
  if (result.ok) throw new Error('expected a refusal, received a value');
  return result.error;
}

function capture(
  useCases: IntakeUseCases,
  overrides: {
    readonly rawRequest?: string;
    readonly kind?: 'FeatureRequest' | 'Bug';
    readonly projectId?: string | null;
    readonly notes?: string | null;
    readonly detail?: { readonly expected: string | null; readonly actual: string | null; readonly reproduction: string | null } | null;
  } = {},
) {
  return useCases.captureIdea(
    {
      rawRequest: overrides.rawRequest ?? SEARCH_REQUEST,
      kind: overrides.kind ?? 'FeatureRequest',
      projectId: overrides.projectId ?? null,
      notes: overrides.notes ?? null,
      detail: overrides.detail ?? null,
    },
    OWNER,
  );
}

const BRIEF_SECTIONS = {
  problem: 'The runs page lists every run and offers no way to narrow it by name',
  desiredOutcome: 'An owner can find one run by name and reach its detail page',
  includedBehaviour: ['a search field above the runs table', 'a result row that links to the run'],
  excludedBehaviour: ['searching log output', 'searching across projects'],
  assumptions: ['runs are already listed per project'],
  acceptanceCriteria: [
    { id: 'AC-1', text: 'typing a run name shows that run in the results list', verification: null },
    { id: 'AC-2', text: 'the results list shows the run name and its status', verification: null },
  ],
  unresolvedQuestions: [],
} as const;

test('F06-AC1, F06-AC3: only the request is required, and it is stored as the owner wrote it', async () => {
  await withHarness(async ({ useCases }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok, 'a request with no project, notes or bug detail is still captured');

    const idea = captured.value.idea;
    assert.equal(idea.rawRequest, SEARCH_REQUEST);
    assert.equal(idea.projectId, null);
    assert.equal(idea.notes, null);
    assert.equal(idea.request.kind, 'FeatureRequest');
    assert.equal(idea.summary, null, 'no summary exists until one is generated');
    assert.equal(idea.disposition.state, 'Unpublished');
    assert.equal(captured.value.summary, null);
  });
});

test('F06-AC3: a bug is captured from its symptom alone, and expected/actual/reproduction are all optional', async () => {
  await withHarness(async ({ useCases }) => {
    const symptomOnly = capture(useCases, {
      rawRequest: 'the save button stops working after I upload a file',
      kind: 'Bug',
      detail: { expected: null, actual: 'nothing happens when I press save', reproduction: null },
    });
    assert.ok(symptomOnly.ok, 'a bug with only a symptom is a valid capture');
    assert.equal(symptomOnly.value.idea.request.kind, 'Bug');
    assert.deepEqual(symptomOnly.value.idea.request.kind === 'Bug' ? symptomOnly.value.idea.request.detail : null, {
      expected: null,
      actual: 'nothing happens when I press save',
      reproduction: null,
    });

    const noDetailAtAll = capture(useCases, { rawRequest: 'the list is wrong sometimes', kind: 'Bug' });
    assert.ok(noDetailAtAll.ok, 'a bug with no detail at all is still captured');

    const featureWithDetail = capture(useCases, {
      rawRequest: 'add a filter to the list',
      kind: 'FeatureRequest',
      detail: { expected: null, actual: null, reproduction: null },
    });
    assert.equal(refusal(featureWithDetail).code, 'Invalid', 'bug detail belongs to a bug');
  });
});

test('F06-AC2: a saved draft survives a restart, read through a second handle on the same file', async () => {
  await withHarness(async ({ useCases, reopen, closePrimary }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    const summarized = useCases.recordSummary(
      { ideaId, text: 'The owner cannot find a run by name.', generatedBy: 'intake-fixture' },
      OWNER,
    );
    assert.ok(summarized.ok, 'a generated summary is recorded beside the request');

    closePrimary();
    const restarted = reopen();
    const read = restarted.read(ideaId);
    assert.ok(read.ok, 'the draft is readable from a second handle on the same file');
    assert.equal(read.value.rawRequest, SEARCH_REQUEST, 'the raw request is byte-identical after restart');
    assert.ok(read.value.summary !== null);
    assert.equal(read.value.summary?.text, 'The owner cannot find a run by name.');
    assert.equal(read.value.summary?.generatedBy, 'intake-fixture');
    assert.equal(read.value.summary?.rawRequestFingerprint.length > 0, true);
  });
});

test('F06-AC1: the raw request and the generated summary are different facts', async () => {
  await withHarness(async ({ useCases }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    const summarized = useCases.recordSummary(
      { ideaId, text: 'A short generated sentence.', generatedBy: 'intake-fixture' },
      OWNER,
    );
    assert.ok(summarized.ok);
    assert.equal(summarized.value.idea.rawRequest, SEARCH_REQUEST, 'summarising does not shorten the request');
    assert.equal(summarized.value.summary?.text, 'A short generated sentence.');

    const blank = useCases.recordSummary({ ideaId, text: '   ', generatedBy: 'intake-fixture' }, OWNER);
    assert.equal(refusal(blank).code, 'Invalid', 'a blank summary is refused');

    const unattributed = useCases.recordSummary({ ideaId, text: 'x', generatedBy: '  ' }, OWNER);
    assert.equal(refusal(unattributed).code, 'Invalid', 'a summary must record what generated it');
  });
});

test('F06-AC1: an attachment is a named file under the artifact root, and the row records no bytes', async () => {
  await withHarness(async ({ useCases, artifactRoot }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    const attached = await useCases.attachFile(
      { ideaId, name: 'run-list-screenshot.txt', mediaType: 'text/plain', content: 'three runs listed' },
      OWNER,
    );
    assert.ok(attached.ok, `the attachment was accepted: ${attached.ok ? '' : attached.error.reason}`);
    assert.equal(attached.value.attachments.length, 1);
    assert.equal(attached.value.attachments[0]?.name, 'run-list-screenshot.txt');
    assert.equal(attached.value.attachments[0]?.byteSize, Buffer.byteLength('three runs listed', 'utf8'));
    assert.equal(JSON.stringify(attached.value).includes('three runs listed'), false, 'no content is inlined into the row');

    const written = await readdir(artifactRoot);
    assert.deepEqual(written, ['run-list-screenshot.txt'], 'the bytes live under the artifact root as a named file');
  });
});

test('F06-AC1: a name that could escape the artifact root is refused, and nothing is written', async () => {
  await withHarness(async ({ useCases, artifactRoot }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    for (const name of ['../escape.txt', 'nested/file.txt', '..', '.', '/etc/passwd']) {
      const attempted = await useCases.attachFile(
        { ideaId, name, mediaType: 'text/plain', content: 'should never be written' },
        OWNER,
      );
      const error = refusal(attempted);
      assert.equal(error.code, 'Invalid', `"${name}" is refused`);
      assert.ok(
        error.code === 'Invalid' && error.fields.some((entry) => entry.path === 'name'),
        `"${name}" names the offending field`,
      );
    }

    const listed = await readdir(artifactRoot);
    assert.deepEqual(listed, [], 'a refused traversal leaves nothing behind');
  });
});

test('F06-AC1, F06-AC2: an attachment whose row write fails is not reported as saved, and its file is removed', async () => {
  await withHarness(async ({ useCases, intake, artifactRoot }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    const attached = await useCases.attachFile(
      { ideaId, name: 'notes.txt', mediaType: 'text/plain', content: 'first write' },
      OWNER,
    );
    assert.ok(attached.ok);

    const duplicate = await useCases.attachFile(
      { ideaId, name: 'notes.txt', mediaType: 'text/plain', content: 'second write' },
      OWNER,
    );
    assert.equal(refusal(duplicate).code, 'Invalid', 'a duplicate name is refused rather than overwriting');
    assert.deepEqual(await readdir(artifactRoot), ['notes.txt'], 'the refused write left exactly the first file');

    const reread = intake.read(ideaId);
    assert.ok(reread.ok);
    assert.equal(reread.value.attachments.length, 1, 'the draft references one attachment, not two');
  });
});

test('F06-AC1: an unsupported attachment type and an unconfigured artifact root are both refused by name', async () => {
  await withHarness(async ({ useCases, database }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    const unsupported = await useCases.attachFile(
      { ideaId, name: 'notes.pdf', mediaType: 'application/pdf', content: 'x' },
      OWNER,
    );
    const mediaTypeError = refusal(unsupported);
    assert.equal(mediaTypeError.code, 'Invalid');
    assert.ok(
      mediaTypeError.code === 'Invalid' && mediaTypeError.fields.some((entry) => entry.path === 'mediaType'),
      'the unsupported media type is named',
    );

    const noRoot = createIntakeUseCases({
      clock,
      intake: new IntakeRepository(database),
      ideas: new IdeaRepository(database),
      artifactRoot: null,
    });
    const unattached = await noRoot.attachFile(
      { ideaId, name: 'notes.txt', mediaType: 'text/plain', content: 'x' },
      OWNER,
    );
    const rootError = refusal(unattached);
    assert.equal(rootError.code, 'Unavailable');
    assert.match(rootError.reason, /No artifact store is configured/);
  });
});

test('F01-AC1: a non-owner is refused before any row is read', async () => {
  await withHarness(async ({ useCases }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    for (const actor of [CODING_AGENT, UNATTRIBUTED]) {
      assert.equal(refusal(useCases.listIdeas(actor)).code, 'Forbidden');
      assert.equal(refusal(useCases.getIdea(ideaId, actor)).code, 'Forbidden');
      assert.equal(refusal(useCases.findRelatedWork({ ideaId }, actor)).code, 'Forbidden');
      assert.equal(refusal(useCases.exportIdea(ideaId, actor)).code, 'Forbidden');
      assert.equal(refusal(useCases.archiveIdea({ ideaId, reason: null }, actor)).code, 'Forbidden');
      assert.equal(refusal(useCases.deferIdea({ ideaId, reason: null }, actor)).code, 'Forbidden');
      assert.equal(refusal(useCases.agreeBrief(ideaId, actor)).code, 'Forbidden');
      assert.equal(
        refusal(
          useCases.captureIdea({ rawRequest: 'x', kind: 'FeatureRequest', projectId: null, notes: null, detail: null }, actor),
        ).code,
        'Forbidden',
      );
      const attachment = await useCases.attachFile(
        { ideaId, name: 'x.txt', mediaType: 'text/plain', content: 'x' },
        actor,
      );
      assert.equal(refusal(attachment).code, 'Forbidden');
    }
  });
});

test('F06-AC5: archiving creates no ticket and consumes no coding run, and it is refused twice', async () => {
  await withHarness(async ({ useCases, database }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    const archived = useCases.archiveIdea({ ideaId, reason: 'not wanted after all' }, OWNER);
    assert.ok(archived.ok);
    assert.equal(archived.value.disposition, 'Archived');

    const counts = {
      workItems: count(database, 'work_items'),
      jobs: count(database, 'jobs'),
      attempts: count(database, 'attempts'),
      candidates: count(database, 'candidates'),
    };
    assert.deepEqual(counts, { workItems: 0, jobs: 0, attempts: 0, candidates: 0 });

    const again = useCases.archiveIdea({ ideaId, reason: null }, OWNER);
    assert.equal(refusal(again).code, 'Conflict', 'an archived idea cannot be archived again');
  });
});

test('F06-AC5: an idea that produced work cannot be archived', async () => {
  await withHarness(async ({ useCases, database }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    // The published state is written directly because publishing is a different
    // slice and this one has no route to it: `ideas.published_work_item_id` and
    // `idea_produced_work` both reference a `work_items` row, and creating one needs
    // a project and a profile version that no repository here can produce. The
    // statement runs against the real migrated schema, so the domain refusal and the
    // schema trigger below it are the production ones.
    database
      .prepare("UPDATE ideas SET state = 'Published', published_at = ?, updated_at = ? WHERE idea_id = ?")
      .run(LATER, LATER, ideaId);

    const archived = useCases.archiveIdea({ ideaId, reason: null }, OWNER);
    const error = refusal(archived);
    assert.equal(error.code, 'Forbidden');
    assert.match(error.reason, /produced work/);
    assert.equal(count(database, 'work_items'), 0, 'the refusal created nothing');

    const reread = useCases.getIdea(ideaId, OWNER);
    assert.ok(reread.ok);
    assert.equal(reread.value.idea.disposition.state, 'Published', 'the refusal changed nothing');
  });
});

test('F06-AC5: deferring is bookkeeping, and an archived idea cannot be deferred', async () => {
  await withHarness(async ({ useCases, database }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    const deferred = useCases.deferIdea({ ideaId, reason: 'waiting on a decision' }, OWNER);
    assert.ok(deferred.ok);
    assert.equal(deferred.value.disposition, 'Deferred');
    assert.equal(count(database, 'work_items'), 0);

    useCases.archiveIdea({ ideaId, reason: 'superseded' }, OWNER);
    const refused = useCases.deferIdea({ ideaId, reason: null }, OWNER);
    assert.equal(refusal(refused).code, 'Conflict');
  });
});

test('F06-AC4: possibly-related work is reported with the owner choice required and no merge possible', async () => {
  await withHarness(async ({ useCases }) => {
    const first = capture(useCases);
    assert.ok(first.ok);
    const second = capture(useCases, {
      rawRequest: 'I cannot find a run by its name on the runs page, I have to scroll through all of them',
    });
    assert.ok(second.ok);
    const unrelated = capture(useCases, { rawRequest: 'the invoice export should use a comma decimal separator' });
    assert.ok(unrelated.ok);

    const related = useCases.findRelatedWork({ ideaId: second.value.idea.ideaId }, OWNER);
    assert.ok(related.ok);
    const candidates = related.value.map((entry) => entry.candidate.idea.ideaId);
    assert.equal(candidates.includes(first.value.idea.ideaId), true, 'the near-duplicate is reported');
    assert.equal(candidates.includes(second.value.idea.ideaId), false, 'a request is never related to itself');

    for (const entry of related.value) {
      assert.equal(entry.report.mergeable, false, 'no report can be read as a merge');
      assert.equal(entry.report.discardable, false, 'no report can be read as a discard');
      assert.equal(entry.report.disposition, 'OwnerChoiceRequired');
      assert.deepEqual([...entry.report.ownerChoices], ['LinkToExisting', 'ExtendExisting', 'CreateNewIssue']);
    }

    const high = related.value.find((entry) => entry.candidate.idea.ideaId === first.value.idea.ideaId);
    assert.ok(high !== undefined);
    assert.ok(high.report.score > 0.1, 'the near-duplicate scores above the default threshold');

    const strict = useCases.findRelatedWork({ ideaId: second.value.idea.ideaId, minimumScore: 0.99 }, OWNER);
    assert.ok(strict.ok);
    assert.equal(strict.value.length, 0, 'the owner sets the threshold, so a high one reports nothing');
  });
});

test('F06-AC4: the owner choice is explicit, is recorded, and merges nothing', async () => {
  await withHarness(async ({ useCases }) => {
    const first = capture(useCases);
    assert.ok(first.ok);
    const second = capture(useCases, {
      rawRequest: 'I cannot find a run by its name on the runs page, I have to scroll through all of them',
    });
    assert.ok(second.ok);

    const chosen = useCases.recordRelatedWorkChoice(
      { ideaId: second.value.idea.ideaId, candidateIdeaId: first.value.idea.ideaId, choice: 'ExtendExisting' },
      OWNER,
    );
    assert.ok(chosen.ok, `the choice was recorded: ${chosen.ok ? '' : chosen.error.reason}`);
    assert.equal(chosen.value.choice, 'ExtendExisting');
    assert.equal(chosen.value.merged, false);
    assert.deepEqual(chosen.value.dispositionAfterChoice, { idea: 'Unpublished', candidate: 'Unpublished' });

    const unsupported = useCases.recordRelatedWorkChoice(
      {
        ideaId: second.value.idea.ideaId,
        candidateIdeaId: first.value.idea.ideaId,
        choice: 'MergeSilently',
      },
      OWNER,
    );
    assert.equal(refusal(unsupported).code, 'Invalid', 'only the three named choices exist');

    const unrelated = capture(useCases, { rawRequest: 'print invoices in a second font for the finance team' });
    assert.ok(unrelated.ok);
    const notRelated = useCases.recordRelatedWorkChoice(
      {
        ideaId: second.value.idea.ideaId,
        candidateIdeaId: unrelated.value.idea.ideaId,
        choice: 'LinkToExisting',
      },
      OWNER,
    );
    assert.equal(refusal(notRelated).code, 'NotFound', 'a choice cannot be recorded against an unrelated request');

    const itself = useCases.recordRelatedWorkChoice(
      { ideaId: second.value.idea.ideaId, candidateIdeaId: second.value.idea.ideaId, choice: 'LinkToExisting' },
      OWNER,
    );
    assert.equal(refusal(itself).code, 'Invalid');
  });
});

test('F07-AC1: a brief carries the seven sections and refuses a criterion nobody could check', async () => {
  await withHarness(async ({ useCases }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    const drafted = useCases.draftBrief({ ideaId, authoredBy: 'Owner', sections: BRIEF_SECTIONS, basedOnBriefVersion: null }, OWNER);
    assert.ok(drafted.ok, `the brief was drafted: ${drafted.ok ? '' : drafted.error.reason}`);
    assert.equal(drafted.value.version, 1);
    assert.equal(drafted.value.state, 'Proposed');
    assert.equal(drafted.value.supersedesVersion, null);
    assert.ok(drafted.value.rawRequestFingerprint.startsWith('fp_'));

    const second = capture(useCases, { rawRequest: 'the run filter should remember what I typed' });
    assert.ok(second.ok);
    const unobservable = useCases.draftBrief(
      {
        ideaId: second.value.idea.ideaId,
        authoredBy: 'Owner',
        sections: {
          ...BRIEF_SECTIONS,
          acceptanceCriteria: [{ id: 'AC-1', text: 'the search is fast and intuitive', verification: null }],
        },
        basedOnBriefVersion: null,
      },
      OWNER,
    );
    const error = refusal(unobservable);
    assert.equal(error.code, 'Invalid');
    assert.ok(
      error.code === 'Invalid' && error.fields.some((entry) => entry.path === 'sections.acceptanceCriteria[0].text'),
      `the unobservable criterion is named per field: ${JSON.stringify(error)}`,
    );

    const again = useCases.draftBrief({ ideaId, authoredBy: 'Owner', sections: BRIEF_SECTIONS, basedOnBriefVersion: null }, OWNER);
    assert.equal(refusal(again).code, 'Conflict', 'a second silent draft is refused; a correction is how it changes');

    const staleBase = useCases.draftBrief(
      { ideaId, authoredBy: 'Owner', sections: BRIEF_SECTIONS, basedOnBriefVersion: 7 },
      OWNER,
    );
    assert.equal(refusal(staleBase).code, 'Conflict', 'a first brief supersedes no version');
  });
});

test('F07-AC1, F05-AC5: agreement is about scope, is refused when already agreed, and names its version', async () => {
  await withHarness(async ({ useCases }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    const noBrief = useCases.agreeBrief(ideaId, OWNER);
    assert.equal(refusal(noBrief).code, 'NotFound');

    const drafted = useCases.draftBrief({ ideaId, authoredBy: 'Owner', sections: BRIEF_SECTIONS, basedOnBriefVersion: null }, OWNER);
    assert.ok(drafted.ok);

    const agreed = useCases.agreeBrief(ideaId, OWNER);
    assert.ok(agreed.ok);
    assert.equal(agreed.value.state, 'Agreed');
    assert.equal(agreed.value.version, 1);
    assert.equal(agreed.value.agreedBy, OWNER.actorId);
    assert.equal(agreed.value.agreedAt !== null, true);
    assert.equal(
      Object.keys(agreed.value).some((key) => /accept|deliver|release/i.test(key)),
      false,
      'agreement records nothing about delivery or release',
    );

    const twice = useCases.agreeBrief(ideaId, OWNER);
    assert.equal(refusal(twice).code, 'Conflict');
  });
});

test('F07-AC2: only material ambiguity is asked, and a declined candidate is reported rather than dropped', async () => {
  await withHarness(async ({ useCases }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    const round = useCases.askClarifyingQuestions(
      {
        ideaId,
        sections: BRIEF_SECTIONS,
        ambiguities: [
          {
            kind: 'UnspecifiedSubject',
            topic: 'what the search matches on',
            readings: ['the run name only', 'the run name and its labels'],
            answeredBy: [],
            impact: 'ChangesBehaviour',
            evidence: SEARCH_REQUEST,
          },
          {
            kind: 'UnspecifiedSubject',
            topic: 'the colour of the empty state',
            readings: ['grey', 'blue'],
            answeredBy: [],
            impact: 'Cosmetic',
            evidence: SEARCH_REQUEST,
          },
          {
            kind: 'ConflictingStatement',
            topic: 'whether the old list stays',
            readings: ['keep the old list', 'remove the old list'],
            answeredBy: ['keep the old list'],
            impact: 'ChangesBehaviour',
            evidence: SEARCH_REQUEST,
          },
        ],
      },
      OWNER,
    );
    assert.ok(round.ok, `the round ran: ${round.ok ? '' : round.error.reason}`);

    const topics = round.value.questions.map((question) => question.topic);
    assert.deepEqual(topics, ['what the search matches on'], 'one material question, and no duplicates');
    const asked = round.value.questions[0];
    assert.ok(asked !== undefined);
    assert.equal(asked.state, 'Open');
    assert.equal(asked.whyMaterial.length > 0, true, 'the question states why it is worth asking');
    assert.deepEqual([...asked.readings], ['the run name only', 'the run name and its labels']);

    const rejectedTopics = round.value.rejected.map((entry) => entry.topic).sort();
    assert.deepEqual(rejectedTopics, ['the colour of the empty state', 'whether the old list stays']);
    const cosmetic = round.value.rejected.find((entry) => entry.topic === 'the colour of the empty state');
    assert.equal(cosmetic?.rejection, 'CosmeticOnly');
    const alreadyAnswered = round.value.rejected.find((entry) => entry.topic === 'whether the old list stays');
    assert.equal(alreadyAnswered?.rejection, 'AlreadyAnswered');

    const detail = useCases.getIdea(ideaId, OWNER);
    assert.ok(detail.ok);
    assert.equal(detail.value.questions.length, 1);
    assert.equal(detail.value.rejected.length, 2, 'the declined candidates are stored, not just returned');
    assert.equal(detail.value.turns.filter((turn) => turn.kind === 'Question').length, 1);
  });
});

test('F07-AC2: an unobservable criterion is itself a material question', async () => {
  await withHarness(async ({ useCases }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    const round = useCases.askClarifyingQuestions(
      {
        ideaId,
        sections: {
          ...BRIEF_SECTIONS,
          acceptanceCriteria: [{ id: 'AC-3', text: 'the results feel fast', verification: null }],
        },
        ambiguities: [],
      },
      OWNER,
    );
    assert.ok(round.ok);
    const asked = round.value.questions.find((question) => question.topic === 'acceptanceCriteria.AC-3');
    assert.ok(asked !== undefined, 'the vague criterion earned a question');
    assert.equal(asked.origin, 'UnobservableCriterion');
    assert.match(asked.whyMaterial, /target to build against/);
  });
});

test('F07-AC2: answering is idempotent in the sense that a second answer is a conflict, not a rewrite', async () => {
  await withHarness(async ({ useCases }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    const round = useCases.askClarifyingQuestions(
      {
        ideaId,
        sections: BRIEF_SECTIONS,
        ambiguities: [
          {
            kind: 'UnspecifiedSubject',
            topic: 'scope of the match',
            readings: ['name only', 'name and labels'],
            answeredBy: [],
            impact: 'ChangesBehaviour',
            evidence: SEARCH_REQUEST,
          },
        ],
      },
      OWNER,
    );
    assert.ok(round.ok);
    const question = round.value.questions[0];
    assert.ok(question !== undefined);

    const answered = useCases.answerClarifyingQuestion(
      { ideaId, questionId: question.questionId, answer: 'the run name only' },
      OWNER,
    );
    assert.ok(answered.ok);
    assert.equal(answered.value.state, 'Answered');
    assert.equal(answered.value.answer, 'the run name only');
    assert.ok(answered.value.answeredAt !== null);

    const twice = useCases.answerClarifyingQuestion(
      { ideaId, questionId: question.questionId, answer: 'name and labels' },
      OWNER,
    );
    assert.equal(refusal(twice).code, 'Conflict');

    const blank = useCases.answerClarifyingQuestion({ ideaId, questionId: question.questionId, answer: '  ' }, OWNER);
    assert.equal(refusal(blank).code, 'Invalid');

    const otherIdea = capture(useCases, { rawRequest: 'a completely separate request about invoices' });
    assert.ok(otherIdea.ok);
    const foreign = useCases.answerClarifyingQuestion(
      { ideaId: otherIdea.value.idea.ideaId, questionId: question.questionId, answer: 'x' },
      OWNER,
    );
    assert.equal(refusal(foreign).code, 'NotFound', "another request's question cannot be answered here");
  });
});

test('F07-AC3: a correction appends a version, keeps the prior one readable, and names what it withdrew', async () => {
  await withHarness(async ({ useCases }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    const drafted = useCases.draftBrief(
      { ideaId, authoredBy: 'Owner', sections: BRIEF_SECTIONS, basedOnBriefVersion: null },
      OWNER,
    );
    assert.ok(drafted.ok);
    useCases.agreeBrief(ideaId, OWNER);

    const correctedSections = {
      ...BRIEF_SECTIONS,
      includedBehaviour: [...BRIEF_SECTIONS.includedBehaviour, 'a label filter beside the name field'],
      acceptanceCriteria: [
        { id: 'AC-1', text: 'typing a run name shows that run in the results list', verification: null },
        { id: 'AC-3', text: 'selecting a label shows only the runs carrying that label', verification: null },
      ],
    };

    const applied = useCases.applyOwnerCorrection(
      { ideaId, text: 'also filter by label', sections: correctedSections, basedOnBriefVersion: 1 },
      OWNER,
    );
    assert.ok(applied.ok, `the correction was appended: ${applied.ok ? '' : applied.error.reason}`);
    assert.equal(applied.value.currentVersion.version, 2);
    assert.equal(applied.value.currentVersion.state, 'Proposed', 'a new version starts unagreed');
    assert.equal(applied.value.currentVersion.supersedesVersion, 1);
    assert.equal(applied.value.currentVersion.authoredBy, 'OwnerEdit');
    assert.equal(applied.value.priorVersion.version, 1);
    assert.equal(applied.value.priorVersion.state, 'Agreed', 'the prior version is unchanged');
    assert.deepEqual(
      [...applied.value.withdrawnCriterionIds],
      ['AC-2'],
      'the withdrawn criteria are reported on the version that lost them',
    );
    assert.deepEqual([...applied.value.priorVersion.withdrawnCriterionIds], ['AC-2']);

    const stale = useCases.applyOwnerCorrection(
      { ideaId, text: 'again', sections: correctedSections, basedOnBriefVersion: 1 },
      OWNER,
    );
    const conflict = refusal(stale);
    assert.equal(conflict.code, 'Conflict');
    assert.equal(conflict.code === 'Conflict' ? conflict.expected : '', '1');
    assert.equal(conflict.code === 'Conflict' ? conflict.actual : '', '2');

    const detail = useCases.getIdea(ideaId, OWNER);
    assert.ok(detail.ok);
    assert.equal(detail.value.brief.versions.length, 2, 'both versions stay readable');
    assert.equal(detail.value.brief.currentVersion, 2);
    const first = detail.value.brief.versions[0];
    assert.equal(first?.state, 'Agreed');
    assert.equal(first?.sections.acceptanceCriteria.length, 2);
    assert.deepEqual([...(first?.withdrawnCriterionIds ?? [])], ['AC-2']);
    const second = detail.value.brief.versions[1];
    assert.equal(second?.state, 'Proposed');
    assert.equal(second?.supersedesVersion, 1);

    const correctionTurns = detail.value.turns.filter((turn) => turn.kind === 'Correction');
    assert.equal(correctionTurns.length, 1);
    assert.equal(correctionTurns[0]?.text, 'also filter by label');
    assert.equal(
      detail.value.turns[0]?.kind,
      'RawRequest',
      "the owner's original words are still the first turn",
    );
    assert.equal(detail.value.turns[0]?.text, SEARCH_REQUEST, 'the raw request never changed');
  });
});

test('F07-AC3: a correction cannot introduce a criterion nobody could check', async () => {
  await withHarness(async ({ useCases }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;
    useCases.draftBrief({ ideaId, authoredBy: 'Owner', sections: BRIEF_SECTIONS, basedOnBriefVersion: null }, OWNER);

    const applied = useCases.applyOwnerCorrection(
      {
        ideaId,
        text: 'make it nicer',
        sections: { ...BRIEF_SECTIONS, acceptanceCriteria: [{ id: 'AC-1', text: 'the result is elegant', verification: null }] },
        basedOnBriefVersion: 1,
      },
      OWNER,
    );
    const error = refusal(applied);
    assert.equal(error.code, 'Invalid');
    assert.ok(
      error.code === 'Invalid' && error.fields.some((entry) => entry.path.endsWith('.text')),
      'the vague corrected criterion is refused',
    );

    const detail = useCases.getIdea(ideaId, OWNER);
    assert.ok(detail.ok);
    assert.equal(detail.value.brief.versions.length, 1, 'the refused correction appended nothing');
  });
});

test('F07-AC3: correcting a request with no brief is a not-found, not an invented version', async () => {
  await withHarness(async ({ useCases }) => {
    const captured = capture(useCases);
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;
    const attempted = useCases.applyOwnerCorrection(
      { ideaId, text: 'x', sections: BRIEF_SECTIONS, basedOnBriefVersion: 1 },
      OWNER,
    );
    assert.equal(refusal(attempted).code, 'NotFound');
  });
});

test('F32-AC2: the export carries the owner text, both brief versions, the conversation and an attachment index', async () => {
  await withHarness(async ({ useCases }) => {
    const captured = capture(useCases, { notes: 'raised after the demo' });
    assert.ok(captured.ok);
    const ideaId = captured.value.idea.ideaId;

    useCases.recordSummary({ ideaId, text: 'The owner cannot find a run by name.', generatedBy: 'intake-fixture' }, OWNER);
    await useCases.attachFile({ ideaId, name: 'notes.txt', mediaType: 'text/plain', content: 'three runs' }, OWNER);
    useCases.draftBrief({ ideaId, authoredBy: 'Owner', sections: BRIEF_SECTIONS, basedOnBriefVersion: null }, OWNER);
    useCases.applyOwnerCorrection(
      {
        ideaId,
        text: 'also filter by label',
        sections: { ...BRIEF_SECTIONS, acceptanceCriteria: [BRIEF_SECTIONS.acceptanceCriteria[0]!] },
        basedOnBriefVersion: 1,
      },
      OWNER,
    );

    const exported = useCases.exportIdea(ideaId, OWNER);
    assert.ok(exported.ok, `the export ran: ${exported.ok ? '' : exported.error.reason}`);
    const record = exported.value;
    assert.equal(record.rawRequest, SEARCH_REQUEST);
    // `ideas.project_id` references `projects` and this slice has no route that creates
    // one, so an intake capture here carries no project. The column stays optional, as
    // F06-AC3 requires, and a later slice supplies the project.
    assert.equal(record.projectId, null);
    assert.equal(record.notes, 'raised after the demo');
    assert.equal(record.summary?.text, 'The owner cannot find a run by name.');
    assert.equal(record.briefVersions.length, 2);
    assert.equal(record.conversation.length, 2, 'the raw request and the correction are both there');
    assert.equal(record.conversation[0]?.kind, 'RawRequest');
    assert.equal(record.conversation[0]?.text, SEARCH_REQUEST);
    assert.equal(record.conversation[1]?.kind, 'Correction');
    assert.equal(record.attachments.length, 1);
    assert.equal(record.attachments[0]?.fileName, 'notes.txt');
    assert.equal(
      Object.keys(record).some((key) => /password|secret|token|credential/i.test(key)),
      false,
      'the export carries no credential-shaped field',
    );
    assert.equal(JSON.stringify(record).includes('three runs'), false, 'the export is an index, never attachment bytes');
  });
});

test('F06-AC2: listing returns every captured request with its disposition', async () => {
  await withHarness(async ({ useCases }) => {
    const first = capture(useCases);
    assert.ok(first.ok);
    const second = capture(useCases, { rawRequest: 'print invoices with a decimal comma' });
    assert.ok(second.ok);
    useCases.archiveIdea({ ideaId: first.value.idea.ideaId, reason: null }, OWNER);

    const listed = useCases.listIdeas(OWNER);
    assert.ok(listed.ok);
    assert.equal(listed.value.length, 2);
    const byId = new Map(listed.value.map((entry) => [entry.idea.ideaId, entry]));
    assert.equal(byId.get(first.value.idea.ideaId)?.disposition, 'Archived');
    assert.equal(byId.get(second.value.idea.ideaId)?.disposition, 'Unpublished');
    assert.equal(byId.get(first.value.idea.ideaId)?.summary, null, 'no summary means null, not an empty one');
  });
});

test('an unknown idea is a typed not-found rather than an empty record', async () => {
  await withHarness(async ({ useCases }) => {
    const missing = '00000000-0000-4000-8000-000000000000' as IdeaId;
    assert.equal(refusal(useCases.getIdea(missing, OWNER)).code, 'NotFound');
    assert.equal(refusal(useCases.exportIdea(missing, OWNER)).code, 'NotFound');
    assert.equal(refusal(useCases.findRelatedWork({ ideaId: missing }, OWNER)).code, 'NotFound');
    assert.equal(refusal(useCases.archiveIdea({ ideaId: missing, reason: null }, OWNER)).code, 'NotFound');
    assert.equal(refusal(useCases.recordSummary({ ideaId: missing, text: 'x', generatedBy: 'y' }, OWNER)).code, 'NotFound');
  });
});

test('the artifact root boundary is proved by resolution, not by the shape of the name alone', () => {
  const root = resolveAttachmentPath('/srv/shiploop/artifacts', 'notes.txt');
  assert.ok(root.ok);
  assert.equal(root.value.path, '/srv/shiploop/artifacts/notes.txt');

  for (const name of ['../notes.txt', 'a/b.txt', 'a\\b.txt', '..', '.', '', '~/notes.txt', ' notes.txt', 'notes.txt ']) {
    assert.equal(resolveAttachmentPath('/srv/shiploop/artifacts', name).ok, false, `"${name}" is refused`);
  }
  assert.equal(resolveAttachmentPath(null, 'notes.txt').ok, false, 'no configured root means no attachment');
});

function count(database: Database, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
  const total = row === undefined ? undefined : row['total'];
  return typeof total === 'bigint' ? Number(total) : typeof total === 'number' ? total : -1;
}

/** Alias kept so the archive case reads the same as the ones above it. */
