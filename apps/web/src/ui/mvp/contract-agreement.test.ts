/**
 * What a Delivery Contract save and approval send, and what a conflict is reported as.
 *
 * The cases here observe the recorded HTTP request or the sentences a reader sees. Nothing asserts
 * that a function was called, because "the save function ran" is not a property of the product.
 *
 * The cases worth having:
 *
 *   - **a save sends the fingerprint of the read it was made from.** Two tabs on one draft both
 *     address `contracts/:id/1`, so the fingerprint is the only thing separating "I am saving what I
 *     read" from "I am overwriting what somebody else wrote" (mvp-spec 3, m24-AC4). The read's
 *     fingerprint is asserted on the wire, not on a function argument, so a helper that re-derived one
 *     could not pass;
 *   - **a 409 is never reported as a save or an approval.** It returns the owner's typed draft
 *     unchanged, names both values the server compared, and does not offer a retry — the same stale
 *     reference would be refused again;
 *   - **an approval names the fingerprint of the revision being approved** and nothing else, because
 *     the route's body is a `strictObject` and a client that tried to say who approved would be
 *     refused by name (F01-AC1, mvp-spec 3);
 *   - **an edit against an approved revision sends no request at all** — the route answers 400, and
 *     the route forward is `/revise` (mvp-spec 3);
 *   - **an automated criterion's binding is one of the project's own configured names**, offered as
 *     that name, with a project that has no profile reported as a state rather than a failure
 *     (F23-AC1, F02-AC4);
 *   - **a saved revision reports the new fingerprint**, which is the value the next edit or approval
 *     must send back (mvp-spec 7).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  approveContractText,
  conflictReport,
  hasUnsavedChanges,
  problemsOf,
  readContractForEditing,
  refusedCriterionIds,
  reviseContractText,
  saveContractDraft,
  withAddedStatement,
  withNewCriterion,
  withStatement,
  withoutCriterion,
  withoutStatement,
  type ContractRead,
} from './contract-agreement.ts';
import { draftContent, type ContractDraft } from '../contract-draft.ts';
import { setMvpCsrfToken } from '../mvp-client/index.ts';
import type { ContractView, MvpFailure, ProjectScope, RequestDetailView } from '../mvp-client/index.ts';

const SCOPE: ProjectScope = { kind: 'project', projectId: 'demo', projectName: 'Demo' };
const UNSELECTED: ProjectScope = { kind: 'no-project-selected', selectableProjectCount: 1 };

const READ_FINGERPRINT = 'fp_11111111111111111111111111111111';
const OTHER_FINGERPRINT = 'fp_99999999999999999999999999999999';

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const realFetch = globalThis.fetch;
let calls: RecordedCall[] = [];
/** Answers in order, so one test can drive a read and then a write. */
let queue: { readonly status: number; readonly body: unknown }[] = [];

function recordFetch(): void {
  calls = [];
  queue = [];
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const request = (init ?? {}) as { readonly method?: string; readonly body?: string };
    calls.push({
      method: request.method ?? 'GET',
      path: String(input),
      body: request.body === undefined ? null : (JSON.parse(request.body) as unknown),
    });
    const answer = queue.shift() ?? { status: 200, body: {} };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => JSON.stringify(answer.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function answer(status: number, body: unknown): void {
  queue.push({ status, body });
}

async function withFetch<T>(run: () => Promise<T>): Promise<T> {
  recordFetch();
  setMvpCsrfToken('token-for-tests');
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

function revision(options: {
  readonly status?: 'draft' | 'approved' | 'stale';
  readonly revision?: number;
  readonly fingerprint?: string;
} = {}): ContractView {
  return {
    contractId: 'ct-1',
    revision: options.revision ?? 1,
    projectId: 'demo',
    requestId: 'req-1',
    status: options.status ?? 'draft',
    outcome: 'The owner sees the change.',
    scope: ['the header'],
    outOfScope: [],
    acceptanceCriteria: [
      { id: 'AC1', description: 'The header stays put', verificationType: 'automated', verificationCheckId: 'pnpm test' },
    ],
    contentFingerprint: options.fingerprint ?? READ_FINGERPRINT,
    requestFingerprint: 'fp_22222222222222222222222222222222',
    answersCurrentRequest: true,
    approvedAt: options.status === 'approved' ? '2026-10-05T09:00:00.000Z' : null,
    approvedBy: options.status === 'approved' ? 'owner-1' : null,
    staleReason: null,
    supersededByRevision: null,
    sourceBriefId: null,
    sourceBriefVersion: null,
    createdBy: 'owner-1',
    createdAt: '2026-10-05T08:00:00.000Z',
    updatedAt: '2026-10-05T08:00:00.000Z',
    blockedBecause: null,
  };
}

function detail(options: { readonly latest?: ContractView | null } = {}): RequestDetailView {
  const latest = options.latest === undefined ? revision() : options.latest;
  return {
    request: {
      requestId: 'req-1',
      projectId: 'demo',
      title: 'Make the header stick',
      description: 'The header scrolls away.',
      sourceIdeaId: null,
      createdAt: '2026-10-05T08:00:00.000Z',
      updatedAt: '2026-10-05T08:00:00.000Z',
    },
    latestRevision: latest,
    approvedRevision: latest?.status === 'approved' ? latest : null,
    revisions: latest === null ? [] : [latest],
  };
}

/** A draft whose outcome and criterion are filled in, so a save is not refused for emptiness. */
function usableDraft(): ContractDraft {
  const base: ContractDraft = {
    outcome: 'The owner sees the change.',
    scope: ['the header'],
    outOfScope: [],
    acceptanceCriteria: [
      {
        key: 'criterion-1',
        id: 'AC1',
        description: 'The header stays put',
        verificationType: 'automated',
        verificationCheckId: 'pnpm test',
      },
    ],
  };
  return base;
}

/** The read the screen would hold after reading a draft revision. */
function draftRead(
  options: {
    readonly fingerprint?: string;
    readonly status?: 'draft' | 'approved' | 'stale';
    readonly revision?: number;
  } = {},
): ContractRead {
  const latest = revision({
    ...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }),
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.revision === undefined ? {} : { revision: options.revision }),
  });
  return {
    detail: detail({ latest }),
    origin: latest.status === 'draft' ? 'draft' : latest.status === 'approved' ? 'agreed' : 'stale',
    revisionInView: latest,
    draft: {
      outcome: latest.outcome,
      scope: [...latest.scope],
      outOfScope: [...latest.outOfScope],
      acceptanceCriteria: latest.acceptanceCriteria.map((criterion, index) => ({
        key: `criterion-${index + 1}-${criterion.id}`,
        ...criterion,
      })),
    },
    checks: { choices: { kind: 'available', choices: [{ name: 'pnpm test', noLongerConfigured: false }] }, noProfileReason: null },
  };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                      */
/* -------------------------------------------------------------------------- */

test('reading a contract asks for the request detail and the project\'s checks, both project-scoped', async () => {
  await withFetch(async () => {
    answer(200, detail());
    answer(200, { profile: { content: { policy: { requiredChecks: ['pnpm test'] } } } });

    const outcome = await readContractForEditing(SCOPE, 'req-1');

    assert.equal(outcome.kind, 'ready');
    const paths = calls.map((call) => call.path);
    assert.ok(
      paths.includes('/api/projects/demo/requests/req-1'),
      `expected the request detail route, saw ${paths.join(', ')}`,
    );
    assert.ok(
      paths.some((path) => path.startsWith('/api/profiles/demo')),
      `expected the profile route that carries the check names, saw ${paths.join(', ')}`,
    );
    // Every project-scoped read names its project: either under `/api/projects/<id>/…` or, for the
    // one profile route that predates the namespace, as `/api/profiles/<id>` with the id present.
    // A bare `/api/requests` or `/api/contracts/:id` is what the previous wave shipped (F02-AC2).
    for (const path of paths) {
      assert.doesNotMatch(
        path,
        /^\/api\/(requests|contracts|candidates|home|review|settings)(\/|$)/,
        `${path} addresses something without naming the project it belongs to (F02-AC2)`,
      );
      assert.match(
        path,
        /^\/api\/(projects|profiles)\/demo(\/|$)/,
        `${path} does not name the project it was scoped to (F02-AC2)`,
      );
    }
  });
});

test('an automated criterion is offered the project\'s own check names, as those names', async () => {
  await withFetch(async () => {
    answer(200, detail());
    answer(200, { profile: { content: { policy: { requiredChecks: ['pnpm test', 'pnpm typecheck'] } } } });

    const outcome = await readContractForEditing(SCOPE, 'req-1');
    assert.equal(outcome.kind, 'ready');
    if (outcome.kind !== 'ready') return;

    assert.equal(outcome.read.checks.choices.kind, 'available');
    if (outcome.read.checks.choices.kind !== 'available') return;
    assert.deepEqual(
      outcome.read.checks.choices.choices.map((choice) => choice.name),
      ['pnpm test', 'pnpm typecheck'],
      'the choices are the configured names, which are what verificationCheckId must carry (F23-AC1)',
    );
  });
});

test('a project with no saved profile degrades the picker and keeps the contract readable', async () => {
  await withFetch(async () => {
    answer(200, detail());
    answer(404, { error: { code: 'NotFound', message: 'That project has no saved profile yet.' } });

    const outcome = await readContractForEditing(SCOPE, 'req-1');

    assert.equal(outcome.kind, 'ready', 'a missing profile is a fact about the project, not a failed read (F02-AC4)');
    if (outcome.kind !== 'ready') return;
    assert.equal(outcome.read.checks.choices.kind, 'none-configured');
    assert.equal(outcome.read.checks.noProfileReason, 'That project has no saved profile yet.');
    assert.equal(outcome.read.revisionInView?.revision, 1, 'the contract itself is still readable');
  });
});

test('a read with no request asks the server rather than assuming a project', async () => {
  await withFetch(async () => {
    const outcome = await readContractForEditing(UNSELECTED, 'req-1');
    assert.equal(outcome.kind, 'refused');
    assert.equal(outcome.kind === 'refused' ? outcome.failure.code : '', 'NoProjectSelected');
    assert.deepEqual(calls, [], 'no scope means no path is built at all (F02-AC1)');
  });
});

/* -------------------------------------------------------------------------- */
/* Saving                                                                       */
/* -------------------------------------------------------------------------- */

test('a first save drafts revision 1 and carries no fingerprint', async () => {
  await withFetch(async () => {
    answer(201, { contract: revision() });
    const read: ContractRead = {
      ...draftRead(),
      revisionInView: null,
      origin: 'no-contract',
      detail: detail({ latest: null }),
    };

    const outcome = await saveContractDraft(SCOPE, read, usableDraft());

    assert.equal(outcome.kind, 'saved');
    assert.equal(calls[0]?.method, 'POST');
    assert.equal(calls[0]?.path, '/api/projects/demo/requests/req-1/contracts');
    const body = calls[0]?.body as Record<string, unknown>;
    assert.equal(
      'expectedContentFingerprint' in body,
      false,
      'the draft route has no fingerprint: there is nothing yet to compare against (mvp-spec 3)',
    );
    assert.deepEqual(Object.keys(body).sort(), ['acceptanceCriteria', 'outOfScope', 'outcome', 'scope']);
  });
});

test('saving a draft sends the fingerprint of the read it was made from', async () => {
  await withFetch(async () => {
    answer(200, { contract: revision({ fingerprint: OTHER_FINGERPRINT }) });

    const outcome = await saveContractDraft(SCOPE, draftRead(), usableDraft());

    assert.equal(outcome.kind, 'saved');
    assert.equal(calls[0]?.method, 'PATCH');
    assert.equal(calls[0]?.path, '/api/projects/demo/contracts/ct-1/1');
    const body = calls[0]?.body as Record<string, unknown>;
    assert.equal(
      body['expectedContentFingerprint'],
      READ_FINGERPRINT,
      'the CAS token must be the fingerprint of the read that rendered this screen (mvp-spec 7, F24-AC4)',
    );
  });
});

test('a saved revision reports the new fingerprint, which is the next save\'s token', async () => {
  await withFetch(async () => {
    answer(200, { contract: revision({ fingerprint: OTHER_FINGERPRINT }) });

    const outcome = await saveContractDraft(SCOPE, draftRead(), usableDraft());

    assert.equal(outcome.kind, 'saved');
    assert.equal(
      outcome.kind === 'saved' ? outcome.contract.contentFingerprint : '',
      OTHER_FINGERPRINT,
      'the 200 body carries the fingerprint the next edit or approval must send (mvp-spec 7)',
    );
  });
});

test('a rejected save is not a save, and names the field the server named', async () => {
  await withFetch(async () => {
    answer(400, {
      error: {
        code: 'Invalid',
        message: 'Revision 1 cannot be approved: 1 automated criterion names no check.',
        fields: [
          {
            path: 'acceptanceCriteria.AC1.verificationCheckId',
            message: 'An automated criterion must name the check that verifies it.',
          },
        ],
      },
    });

    const outcome = await saveContractDraft(SCOPE, draftRead(), usableDraft());

    assert.equal(outcome.kind, 'refused');
    const failure = outcome.kind === 'refused' ? outcome.failure : null;
    assert.equal(refusedCriterionIds(failure as MvpFailure)[0], 'AC1', 'the message must reach the criterion it names (F23-AC1)');
  });
});

test('a conflict on a save is not a save, keeps the typed text, and names both fingerprints', async () => {
  const typed = { ...usableDraft(), outcome: 'The owner sees the header stay put at every width.' };

  await withFetch(async () => {
    answer(409, {
      error: {
        code: 'Conflict',
        message: 'Revision 1 changed after it was loaded.',
        expected: READ_FINGERPRINT,
        actual: OTHER_FINGERPRINT,
      },
    });

    const outcome = await saveContractDraft(SCOPE, draftRead(), typed);

    assert.equal(outcome.kind, 'contract-changed');
    if (outcome.kind !== 'contract-changed') return;
    assert.equal(outcome.expected, READ_FINGERPRINT);
    assert.equal(outcome.actual, OTHER_FINGERPRINT);
    assert.deepEqual(
      outcome.draft,
      typed,
      'the typed draft is handed back untouched, so nothing the owner wrote is lost to a refusal (N03-AC3)',
    );
  });
});

test('an edit against an approved revision sends no request at all', async () => {
  await withFetch(async () => {
    const outcome = await saveContractDraft(SCOPE, draftRead({ status: 'approved' }), usableDraft());

    assert.equal(outcome.kind, 'refused');
    assert.deepEqual(calls, [], 'the route answers 400 to a PATCH of an agreed revision; do not ask (mvp-spec 3)');
    const reason = outcome.kind === 'refused' ? outcome.failure.reason : '';
    assert.match(reason, /Start the next revision/);
  });
});

test('an edit against a stale revision sends no request either', async () => {
  await withFetch(async () => {
    const outcome = await saveContractDraft(SCOPE, draftRead({ status: 'stale' }), usableDraft());
    assert.equal(outcome.kind, 'refused');
    assert.deepEqual(calls, []);
  });
});

test('revising posts the content and no fingerprint, because it creates rather than replaces', async () => {
  await withFetch(async () => {
    answer(201, { contract: revision({ revision: 2, status: 'draft' }) });

    const outcome = await reviseContractText(SCOPE, draftRead({ status: 'approved' }), usableDraft());

    assert.equal(outcome.kind, 'saved');
    assert.equal(calls[0]?.path, '/api/projects/demo/contracts/ct-1/1/revise');
    const body = calls[0]?.body as Record<string, unknown>;
    assert.equal('expectedContentFingerprint' in body, false);
    assert.deepEqual(Object.keys(body).sort(), ['acceptanceCriteria', 'outOfScope', 'outcome', 'scope']);
  });
});

/* -------------------------------------------------------------------------- */
/* Approving                                                                    */
/* -------------------------------------------------------------------------- */

test('approving sends exactly the fingerprint of the revision being approved', async () => {
  await withFetch(async () => {
    answer(200, { contract: revision({ status: 'approved', revision: 1 }) });

    const outcome = await approveContractText(SCOPE, draftRead());

    assert.equal(outcome.kind, 'approved');
    assert.equal(calls[0]?.method, 'POST');
    assert.equal(calls[0]?.path, '/api/projects/demo/contracts/ct-1/1/approve');
    assert.deepEqual(
      Object.keys(calls[0]?.body as object),
      ['expectedContentFingerprint'],
      'the approve body is a strictObject with one member; an approver field would be refused by name (F01-AC1)',
    );
    assert.equal(
      (calls[0]?.body as Record<string, unknown>)['expectedContentFingerprint'],
      READ_FINGERPRINT,
      'the approval must name the text the owner read (mvp-spec 7)',
    );
  });
});

test('a 409 on approval is never an approval, and names both fingerprints', async () => {
  await withFetch(async () => {
    answer(409, {
      error: {
        code: 'Conflict',
        message: 'Revision 1 changed after it was loaded, so approving it now would seal text you did not review.',
        expected: READ_FINGERPRINT,
        actual: OTHER_FINGERPRINT,
      },
    });

    const outcome = await approveContractText(SCOPE, draftRead());

    assert.equal(outcome.kind, 'contract-changed');
    if (outcome.kind !== 'contract-changed') return;
    assert.equal(outcome.expected, READ_FINGERPRINT);
    assert.equal(outcome.actual, OTHER_FINGERPRINT);
  });
});

test('a 409 that the server answers without naming the current value still names what was sent', async () => {
  await withFetch(async () => {
    answer(409, { error: { code: 'Conflict', message: 'Revision 1 is not the newest revision of this request.' } });

    const outcome = await approveContractText(SCOPE, draftRead());

    assert.equal(outcome.kind, 'contract-changed');
    if (outcome.kind !== 'contract-changed') return;
    assert.equal(outcome.expected, READ_FINGERPRINT, 'the fingerprint this call named is not dropped when the server is silent');
    assert.equal(outcome.actual, null);
  });
});

test('approving an already-approved revision sends no request', async () => {
  await withFetch(async () => {
    const outcome = await approveContractText(SCOPE, draftRead({ status: 'approved' }));

    assert.equal(outcome.kind, 'refused');
    assert.deepEqual(calls, [], '"already approved" is the more useful answer than "your fingerprint is stale" (mvp-spec 3)');
  });
});

test('an unbound automated criterion is refused by the server with a path, and the row is identified', async () => {
  const failure: MvpFailure = {
    code: 'Invalid',
    reason: 'Revision 1 cannot be approved: 1 automated criterion names no check.',
    status: 400,
    fields: [
      { path: 'acceptanceCriteria.AC3.verificationCheckId', message: 'An automated criterion must name the check.' },
      { path: 'acceptanceCriteria.AC4.verificationCheckId', message: 'An automated criterion must name the check.' },
    ],
    prerequisites: [],
    expected: null,
    actual: null,
  };
  assert.deepEqual(refusedCriterionIds(failure), ['AC3', 'AC4']);
});

/* -------------------------------------------------------------------------- */
/* The words                                                                    */
/* -------------------------------------------------------------------------- */

test('a conflict is reported as a change under the owner, with a reload and no retry', () => {
  const report = conflictReport({
    expected: READ_FINGERPRINT,
    actual: OTHER_FINGERPRINT,
    reason: 'Revision 1 changed after it was loaded.',
    didSave: true,
  });

  assert.equal(report.requiresReload, true);
  const text = report.lines.join(' ');
  assert.match(text, new RegExp(READ_FINGERPRINT), 'the fingerprint the submission named must be shown');
  assert.match(text, new RegExp(OTHER_FINGERPRINT), 'the fingerprint the server holds must be shown');
  assert.match(text, /Nothing was saved/, 'nothing may be reported as saved');
  assert.match(
    text,
    /still on screen and has not been overwritten/,
    'the owner must be told their typed text is intact, or they will re-type it (N03-AC3)',
  );
  assert.match(text, /Read the contract again/, 'an explicit reconcile must be asked for');
  assert.doesNotMatch(text, /try again/i, 'a retry would send the same stale reference (F24-AC4)');
});

test('an approval conflict says nothing was approved', () => {
  const report = conflictReport({
    expected: READ_FINGERPRINT,
    actual: OTHER_FINGERPRINT,
    reason: 'Revision 1 changed after it was loaded.',
    didSave: false,
  });
  const text = report.lines.join(' ');
  assert.match(text, /Nothing was approved/);
  assert.equal(report.requiresReload, true);
});

test('the conflict report does not label a revision number a fingerprint', () => {
  // The server compares two revision numbers when a newer revision answers the request, and two
  // fingerprints when the text moved. One label cannot be right for both, so neither is hard-coded.
  const report = conflictReport({ expected: '1', actual: '2', reason: 'Not the newest revision.', didSave: false });
  const text = report.lines.join(' ');
  assert.match(text, /Your submission named: 1/);
  assert.match(text, /The server holds now: 2/);
});

test('unsaved text is detected as a change to what would be sealed', () => {
  const read = draftRead();
  assert.equal(hasUnsavedChanges(read, read.draft), false, 'the read\'s own draft has nothing unsaved');
  assert.equal(
    hasUnsavedChanges(read, { ...read.draft, outcome: 'Something else entirely.' }),
    true,
    'editing the outcome must be detected without saving',
  );
  assert.equal(
    hasUnsavedChanges(read, withStatement(read.draft, 'scope', 0, 'the header and the footer')),
    true,
    'editing a scope line must be detected without saving',
  );
  assert.equal(
    hasUnsavedChanges(read, withNewCriterion(read.draft)),
    true,
    'adding a criterion is an unsaved change',
  );
});

test('a blank statement line is reported as a problem rather than counted as unsaved text', () => {
  // `draftContent` drops a blank entry, so the body that would be sealed is identical to the stored
  // one — which is why an added blank line is not reported as an unsaved change. It is not silently
  // dropped either: `problemsOf` refuses it, because the route refuses a blank entry and an owner
  // should learn that here rather than from a 400 (F02-AC4).
  const draft = withAddedStatement(usableDraft(), 'scope');
  assert.equal(hasUnsavedChanges(draftRead(), draft), false);
  assert.match(problemsOf(draft).scope[0]?.message ?? '', /An empty entry says nothing/);
});

test('a saved draft with an empty new line is reported, because the route refuses one', () => {
  const draft = withAddedStatement(usableDraft(), 'scope');
  const problems = problemsOf(draft);
  assert.equal(problems.scope.length, 1);
  assert.match(problems.scope[0]?.message ?? '', /An empty entry says nothing/);
});

test('a new criterion gets an id no sibling holds, and never reuses a removed one', () => {
  let draft = usableDraft();
  draft = withNewCriterion(draft);
  draft = withNewCriterion(draft);
  assert.deepEqual(draft.acceptanceCriteria.map((criterion) => criterion.id), ['AC1', 'AC2', 'AC3']);

  draft = withoutCriterion(draft, draft.acceptanceCriteria[1]?.key ?? '');
  draft = withNewCriterion(draft);
  assert.equal(
    draft.acceptanceCriteria.some((criterion) => criterion.id === 'AC3'),
    true,
    'a removed id may not be handed to a new row, or an approval refusal would name two criteria (F23-AC1)',
  );
});

test('an owner test carries no check name, because a named check could discharge the owner\'s step', () => {
  const draft = usableDraft();
  const asOwnerTest: ContractDraft = {
    ...draft,
    acceptanceCriteria: [{ ...draft.acceptanceCriteria[0]!, verificationType: 'owner_test' }],
  };
  const content = draftContent(asOwnerTest);
  assert.equal(content.acceptanceCriteria[0]?.verificationCheckId, null);
});

test('statement edits, adds and removes touch only their own list', () => {
  const draft = withStatement(usableDraft(), 'scope', 0, 'the header and the footer');
  assert.deepEqual(draft.scope, ['the header and the footer']);
  const added = withAddedStatement(draft, 'outOfScope');
  assert.deepEqual(added.scope, ['the header and the footer'], 'adding to one list must not touch the other');
  assert.deepEqual(added.outOfScope, ['']);
  const removed = withoutStatement(added, 'outOfScope', 0);
  assert.deepEqual(removed.outOfScope, []);
});
