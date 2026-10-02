/**
 * Behavioural proof for versioned procedures and the context they form (F05-AC1,
 * F05-AC3, F05-AC4, F05-AC5, F01-AC1).
 *
 * Every case runs against a real SQLite file in a fresh temporary directory, opened by
 * `createCompositionRoot`, which runs the real `migrate`. No inline fixture schema
 * appears here, and nothing is asserted against a hand-written stand-in for the store:
 * the whole point of F05-AC4 is which rows a future run reads, so the rows are the
 * production rows and the second handle on the same file is how "a future run" is
 * represented here.
 *
 * The cases worth reading first are the three that could each have been quietly wrong:
 *
 *   - a proposed improvement creates a new version and changes nothing a run reads, and
 *     the owner save action is the only statement that moves it (F05-AC4);
 *   - a proposal naming a status, an acceptance or a release is refused by name, so the
 *     attempt is visible rather than stripped (F05-AC5);
 *   - a saved correction supersedes the stale remembered version a run would otherwise
 *     follow, and the stale statement stays readable rather than being rewritten (F05-AC3,
 *     F05-AC1).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CapabilityDeclaration, DomainError, InvalidError, ProjectId } from '@shiploop/domain';
import type { AdapterRegistry, ConnectorProbe } from './connectors.ts';
import type { CompositionRoot } from './composition.ts';
import { createCompositionRoot } from './composition.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';
import { createProcedureVersioningUseCases, readRunInstructions, validateProcedureImprovement } from './procedures.ts';

const NOW = '2026-10-02T12:00:00.000Z';
const LATER = '2026-10-02T13:00:00.000Z';
const FAST_PASSWORD_COST = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16 };

const PROJECT: ProjectId = '9c1d4e77-0000-4000-8000-000000pr0ce' as ProjectId;
const SUBJECT = 'run.checklist';

const OWNER: OwnerActor = {
  actorId: 'owner_procedures',
  role: 'Owner',
  ownerId: 'owner_procedures' as OwnerActor['ownerId'],
  sessionId: 'session_procedures',
};

const NON_OWNER: OwnerActor = {
  actorId: 'coding-agent-procedures',
  role: 'CodingAgent',
  ownerId: null,
  sessionId: null,
};

const adapters: AdapterRegistry = {
  declarationsFor: (): readonly CapabilityDeclaration[] => [],
  probeFor: (): ConnectorProbe | null => null,
};

function steppingClock(): ControllerClock {
  let ticks = 0;
  return {
    now: (): string => {
      ticks += 1;
      return ticks === 1 ? NOW : `${LATER}#${String(ticks)}`;
    },
  };
}

interface Harness {
  readonly root: CompositionRoot;
  readonly useCases: ReturnType<typeof createProcedureVersioningUseCases>;
  readonly clock: ControllerClock;
  /** Records an accepted version directly, the way a project setup would. */
  accept(content: string, subjectKey?: string): { readonly procedureVersionId: string; readonly versionNumber: number };
  /** A second root on the same file: the next process, reading the same rows. */
  restart(): CompositionRoot;
  close(): void;
}

/**
 * A real root, a real `procedure_versions` table and a clock that advances by one call.
 *
 * The clock steps so two recorded instants in one case stay ordered: a proposed version
 * and the save action that follows it must not share an instant, or "which came first"
 * would be decided by nothing (F05-AC1).
 */
async function withHarness(body: (harness: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-procedures-'));
  const clock = steppingClock();
  const opened = createCompositionRoot({
    databasePath: join(directory, 'shiploop.sqlite'),
    clock,
    adapters,
    passwordParameters: FAST_PASSWORD_COST,
    sessionIdleTimeoutSeconds: 900,
  });
  assert.ok(opened.ok, `the real root must open: ${opened.ok ? '' : opened.error.reason}`);
  const root = opened.value;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    root.close();
  };

  try {
    const useCases = createProcedureVersioningUseCases({ clock, procedures: root.procedures });

    const accept = (content: string, subjectKey = SUBJECT) => {
      const appended = root.procedures.appendVersion({
        projectId: PROJECT,
        subjectKey,
        kind: 'Procedure',
        scope: 'Verification',
        source: 'Owner',
        sourceRevision: null,
        content,
        status: 'Accepted',
        createdAt: clock.now(),
        createdBy: OWNER.actorId,
        note: null,
        expectedVersionNumber: null,
      });
      assert.ok(appended.ok, `an accepted version must be stored: ${appended.ok ? '' : appended.error.reason}`);
      return {
        procedureVersionId: appended.value.procedureVersionId,
        versionNumber: appended.value.versionNumber,
      };
    };

    await body({
      root,
      useCases,
      clock,
      accept,
      restart: (): CompositionRoot => {
        const second = createCompositionRoot({
          databasePath: join(directory, 'shiploop.sqlite'),
          clock,
          adapters,
          passwordParameters: FAST_PASSWORD_COST,
          sessionIdleTimeoutSeconds: 900,
        });
        assert.ok(second.ok, `a second root must open the same file: ${second.ok ? '' : second.error.reason}`);
        return second.value;
      },
      close,
    });
  } finally {
    close();
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A synthetic credential shape, present only so redaction has something to remove.
 *
 * It encodes nothing and authenticates nothing: the point is that a credential-shaped string
 * arriving in a suggested procedure never reaches the stored row (N02-AC2).
 */
const SEEDED_CREDENTIAL = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzaGlwbG9vcCJ9.eyJzaWduYXR1cmUiOiJzeW50aGV0aWMifQ';

function fieldsOf(error: DomainError): readonly { readonly path: string; readonly message: string }[] {
  return error.code === 'Invalid' ? (error as InvalidError).fields : [];
}

const SUGGESTION = {
  subjectKey: SUBJECT,
  scope: 'Verification',
  content: 'Run the browser suite before proposing a plan, because a plan that cannot be driven is not reviewable.',
  sourceRevision: null,
  rationale: 'A reviewer asked for the plan to be exercised in a browser before it is accepted.',
};

/* -------------------------------------------------------------------------- */
/* F05-AC4                                                                     */
/* -------------------------------------------------------------------------- */

test('a proposed improvement creates a new version that no future run reads until the owner saves it (F05-AC4)', async () => {
  await withHarness(async (harness) => {
    const original = harness.accept('Run the controller suite before proposing a plan.');

    const proposed = harness.useCases.proposeProcedureImprovement({ projectId: PROJECT, proposal: SUGGESTION, actor: OWNER });
    assert.ok(proposed.ok, `the suggestion must be recorded: ${proposed.ok ? '' : proposed.error.reason}`);

    // F05-AC1: the new version is a real row with its own number, provenance and note.
    assert.equal(proposed.value.status, 'Proposed');
    assert.equal(proposed.value.versionNumber, original.versionNumber + 1, 'a proposal appends a version rather than editing one');
    assert.equal(proposed.value.currentVersionNumber, original.versionNumber, 'the view states what a run is told today');
    const stored = harness.root.procedures.getVersion(proposed.value.procedureVersionId as never);
    assert.ok(stored.ok);
    assert.equal(stored.value.sourceRevision, null);
    assert.equal(stored.value.acceptedAt, null, 'a proposal carries no approval instant (F05-AC4)');
    assert.equal(stored.value.createdBy, OWNER.actorId, 'the author is the owner who asked, never the proposal text (F05-AC5)');

    // F05-AC4: what a run reads is unchanged.
    const beforeSave = harness.useCases.runInstructionsFor(PROJECT, SUBJECT);
    assert.ok(beforeSave.ok);
    assert.equal(beforeSave.value?.versionNumber, original.versionNumber);
    assert.equal(beforeSave.value?.content, 'Run the controller suite before proposing a plan.');

    // The suggestion is visible to the owner and to nobody else.
    const pending = harness.useCases.listProposedImprovements(PROJECT);
    assert.ok(pending.ok);
    assert.deepEqual(pending.value.map((version) => version.versionNumber), [2]);

    // The owner save action is the only statement that moves it.
    const saved = harness.useCases.saveProcedureImprovement({
      procedureVersionId: proposed.value.procedureVersionId,
      actor: OWNER,
    });
    assert.ok(saved.ok, `the owner save must succeed: ${saved.ok ? '' : saved.error.reason}`);
    assert.equal(saved.value.version.status, 'Accepted');
    assert.ok(saved.value.version.acceptedAt !== null, 'saving records when the owner decided');
    assert.equal(saved.value.previous?.versionNumber, original.versionNumber, 'the superseded version is named, not dropped');

    const afterSave = harness.useCases.runInstructionsFor(PROJECT, SUBJECT);
    assert.ok(afterSave.ok);
    assert.equal(afterSave.value?.versionNumber, 2, 'a run now reads the saved version');
    assert.notEqual(afterSave.value?.content, beforeSave.value?.content);

    const superseded = harness.root.procedures.getVersion(original.procedureVersionId as never);
    assert.ok(superseded.ok);
    assert.equal(superseded.value.status, 'Superseded', 'the earlier version stays readable as superseded (F05-AC1)');
    assert.equal(superseded.value.content, 'Run the controller suite before proposing a plan.', 'superseded is not rewritten (F05-AC1)');

    // Saving again is refused: there is no second owner decision to record.
    const again = harness.useCases.saveProcedureImprovement({
      procedureVersionId: proposed.value.procedureVersionId,
      actor: OWNER,
    });
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.error.code, 'Conflict');
  });
});

test('a proposal leaves the next process reading the same instructions it was going to read (F05-AC4, F06-AC2)', async () => {
  await withHarness(async (harness) => {
    const original = harness.accept('Run the controller suite before proposing a plan.');
    const proposed = harness.useCases.proposeProcedureImprovement({ projectId: PROJECT, proposal: SUGGESTION, actor: OWNER });
    assert.ok(proposed.ok);
    harness.close();

    // The next process reads the same rows, and a proposal is not one of them.
    const restarted = harness.restart();
    try {
      const instructions = readRunInstructions(restarted.procedures, PROJECT, SUBJECT);
      assert.ok(instructions.ok);
      assert.equal(instructions.value?.procedureVersionId, original.procedureVersionId);
      assert.equal(instructions.value?.versionNumber, 1);

      const pending = restarted.procedures.listProposed(PROJECT);
      assert.ok(pending.ok);
      assert.equal(pending.value.length, 1, 'the suggestion is durable and still only a suggestion (F05-AC4)');
      assert.equal(pending.value[0]?.procedureVersionId, proposed.value.procedureVersionId);

      // And after the owner saves it in the new process, the change lands exactly once.
      const saved = restarted.procedures.acceptVersion(pending.value[0]?.procedureVersionId as never, LATER);
      assert.ok(saved.ok);
      const afterSave = readRunInstructions(restarted.procedures, PROJECT, SUBJECT);
      assert.ok(afterSave.ok);
      assert.equal(afterSave.value?.versionNumber, 2);
    } finally {
      restarted.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* F05-AC5                                                                     */
/* -------------------------------------------------------------------------- */

test('a suggestion naming an owner decision is refused by name rather than dropped (F05-AC5)', async () => {
  await withHarness(async (harness) => {
    harness.accept('Run the controller suite before proposing a plan.');

    const attempts: readonly (readonly [string, Record<string, unknown>])[] = [
      ['status', { ...SUGGESTION, status: 'Accepted' }],
      ['acceptedAt', { ...SUGGESTION, acceptedAt: NOW }],
      ['createdBy', { ...SUGGESTION, createdBy: 'the model' }],
      ['release', { ...SUGGESTION, release: 'approved for release' }],
      ['scope', { ...SUGGESTION, scope: '   ' }],
    ];

    for (const [field, proposal] of attempts) {
      const attempt = harness.useCases.proposeProcedureImprovement({ projectId: PROJECT, proposal, actor: OWNER });
      assert.equal(attempt.ok, false, `"${field}" must be refused (F05-AC5)`);
      if (!attempt.ok) {
        assert.equal(attempt.error.code, 'Invalid');
        assert.ok(
          fieldsOf(attempt.error).some((entry) => entry.path === field),
          `"${field}" must be refused by name: ${fieldsOf(attempt.error).map((entry) => entry.path).join(', ')}`,
        );
      }
    }

    // Refused, not stripped: an unvalidated suggestion never becomes a row at all.
    const versions = harness.root.procedures.listVersions(PROJECT, SUBJECT);
    assert.ok(versions.ok);
    assert.equal(versions.value.length, 1, 'no refused suggestion became a version (F05-AC5)');
  });
});

test('a credential echoed into a suggested procedure is redacted before the row is written (N02-AC2, F05-AC5)', () => {
  const validated = validateProcedureImprovement({
    ...SUGGESTION,
    content: `Export with LINEAR_API_KEY=${SEEDED_CREDENTIAL} before proposing a plan.`,
  });
  assert.ok(validated.ok, `a suggestion with a credential in it is still a suggestion: ${validated.ok ? '' : validated.error.reason}`);
  assert.ok(
    !validated.value.content.includes(SEEDED_CREDENTIAL),
    'the credential is redacted where the text is produced (N02-AC2)',
  );
  assert.match(validated.value.content, /redacted:jwt/, 'the redaction placeholder is what is stored (N02-AC2)');
});

/* -------------------------------------------------------------------------- */
/* F01-AC1                                                                     */
/* -------------------------------------------------------------------------- */

test('only the owner may propose or save a procedure version (F01-AC1)', async () => {
  await withHarness(async (harness) => {
    harness.accept('Run the controller suite before proposing a plan.');

    const proposed = harness.useCases.proposeProcedureImprovement({ projectId: PROJECT, proposal: SUGGESTION, actor: NON_OWNER });
    assert.equal(proposed.ok, false, 'a coding agent may not record a procedure version (F01-AC1)');
    if (!proposed.ok) assert.equal(proposed.error.code, 'Forbidden');

    const versions = harness.root.procedures.listVersions(PROJECT, SUBJECT);
    assert.ok(versions.ok);
    assert.equal(versions.value.length, 1, 'the refused proposal wrote nothing');

    const ownerProposed = harness.useCases.proposeProcedureImprovement({ projectId: PROJECT, proposal: SUGGESTION, actor: OWNER });
    assert.ok(ownerProposed.ok);
    const saved = harness.useCases.saveProcedureImprovement({
      procedureVersionId: ownerProposed.value.procedureVersionId,
      actor: NON_OWNER,
    });
    assert.equal(saved.ok, false, 'saving is the owner save action and nobody else may perform it (F01-AC1, F05-AC4)');
    if (!saved.ok) assert.equal(saved.error.code, 'Forbidden');

    const instructions = harness.useCases.runInstructionsFor(PROJECT, SUBJECT);
    assert.ok(instructions.ok);
    assert.equal(instructions.value?.versionNumber, 1, 'the refused save changed nothing (F05-AC4)');
  });
});

/* -------------------------------------------------------------------------- */
/* F05-AC3                                                                     */
/* -------------------------------------------------------------------------- */

test('a saved correction supersedes the stale remembered version while both stay readable (F05-AC3, F05-AC1)', async () => {
  await withHarness(async (harness) => {
    const stale = harness.accept('Run the controller suite before proposing a plan.');

    const proposed = harness.useCases.proposeProcedureImprovement({
      projectId: PROJECT,
      proposal: {
        ...SUGGESTION,
        content: 'Run the browser suite before proposing a plan, because a plan that cannot be driven is not reviewable.',
      },
      actor: OWNER,
    });
    assert.ok(proposed.ok, `the correction must be recorded: ${proposed.ok ? '' : proposed.error.reason}`);

    // Before the save, the stale statement is still what a run reads: a remembered fact only
    // becomes current when the owner says so (F05-AC4).
    const beforeSave = harness.useCases.runInstructionsFor(PROJECT, SUBJECT);
    assert.ok(beforeSave.ok);
    assert.equal(beforeSave.value?.content, 'Run the controller suite before proposing a plan.');

    const saved = harness.useCases.saveProcedureImprovement({
      procedureVersionId: proposed.value.procedureVersionId,
      actor: OWNER,
    });
    assert.ok(saved.ok);

    // After it, the current fact wins and the superseded statement is still there to read, so
    // what changed is inspectable rather than gone (F05-AC3, F05-AC1).
    const current = harness.useCases.runInstructionsFor(PROJECT, SUBJECT);
    assert.ok(current.ok);
    assert.equal(current.value?.versionNumber, 2);
    assert.notEqual(current.value?.content, beforeSave.value?.content);

    const history = harness.root.procedures.listVersions(PROJECT, SUBJECT);
    assert.ok(history.ok);
    assert.deepEqual(history.value.map((version) => version.status), ['Superseded', 'Accepted']);
    const staleRow = history.value[0];
    assert.equal(staleRow?.procedureVersionId, stale.procedureVersionId);
    assert.equal(staleRow?.content, 'Run the controller suite before proposing a plan.', 'the stale statement is not rewritten (F05-AC1)');
  });
});
