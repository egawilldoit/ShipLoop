/**
 * What a New Request sends, and what it says afterwards.
 *
 * Every case here observes one of two things a reader or the server can see: the HTTP request that
 * went out, or the sentences the screen renders. Nothing asserts that a function was called.
 *
 * The cases worth having:
 *
 *   - **the create body carries exactly two members.** `routes/contracts.ts` types it as a
 *     `strictObject` with `title` and `description`, so a third member would be refused by name. The
 *     test reads the recorded body rather than the function signature, because the question is what
 *     leaves the browser, and a helper that stripped a field at runtime would satisfy a signature
 *     check while still having sent it (mvp-spec 3, F02-AC2);
 *   - **an empty description sends nothing at all.** "Not ready" must never be mistaken for a request
 *     that was created, so the recorded call list is empty rather than a 400 (N03-AC3);
 *   - **an unselected project sends nothing**, and no URL is built for a project the owner did not
 *     choose (F02-AC1, F02-AC4);
 *   - **the read-back names the revision and its fingerprint.** A request created a moment ago is
 *     rendered with what the server holds about its contract, not with the create response, and the
 *     fingerprint is the identity of the approved text (mvp-spec 3, F24-AC2).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRequestFromWords,
  derivedRequestTitle,
  readRequestDetail,
  readProjectRequests,
  requestDraft,
  requestProgress,
} from './request-intake.ts';
import { setMvpCsrfToken } from '../mvp-client/index.ts';
import type { ContractView, ProjectScope, RequestDetailView } from '../mvp-client/index.ts';

const SCOPE: ProjectScope = { kind: 'project', projectId: 'demo', projectName: 'Demo' };
const UNSELECTED: ProjectScope = { kind: 'no-project-selected', selectableProjectCount: 2 };

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const realFetch = globalThis.fetch;
let calls: RecordedCall[] = [];
let next: { readonly status: number; readonly body: unknown } = { status: 200, body: {} };

function recordFetch(): void {
  calls = [];
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const request = (init ?? {}) as { readonly method?: string; readonly body?: string };
    calls.push({
      method: request.method ?? 'GET',
      path: String(input),
      body: request.body === undefined ? null : (JSON.parse(request.body) as unknown),
    });
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => JSON.stringify(next.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function answer(status: number, body: unknown): void {
  next = { status, body };
}

/** Every recorded call, restored afterwards so one case cannot leak a `fetch` into the next. */
async function withFetch<T>(run: () => Promise<T>): Promise<T> {
  recordFetch();
  setMvpCsrfToken('token-for-tests');
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/**
 * One contract revision, as `routes/contracts.ts` reports it.
 *
 * Built with explicit literals rather than a partial spread so the shape is checked here: a field the
 * client reads that this fixture omits would silently become `undefined` in every test that uses it,
 * which is how a view starts depending on a member the server may not send (F24-AC2).
 */
function contractRevision(options: {
  readonly status?: 'draft' | 'approved' | 'stale';
  readonly revision?: number;
  readonly fingerprint?: string;
  readonly answersCurrentRequest?: boolean;
  readonly blockedBecause?: string | null;
} = {}): ContractView {
  const status = options.status ?? 'draft';
  return {
    contractId: 'ct-1',
    revision: options.revision ?? 1,
    projectId: 'demo',
    requestId: 'req-1',
    status,
    outcome: 'The owner sees the change.',
    scope: [],
    outOfScope: [],
    acceptanceCriteria: [
      { id: 'AC1', description: 'It works', verificationType: 'automated', verificationCheckId: 'pnpm test' },
    ],
    contentFingerprint: options.fingerprint ?? 'fp_11111111111111111111111111111111',
    requestFingerprint: 'fp_22222222222222222222222222222222',
    answersCurrentRequest: options.answersCurrentRequest ?? true,
    approvedAt: status === 'approved' ? '2026-10-05T09:00:00.000Z' : null,
    approvedBy: status === 'approved' ? 'owner-1' : null,
    staleReason: status === 'stale' ? 'The request changed.' : null,
    supersededByRevision: null,
    sourceBriefId: null,
    sourceBriefVersion: null,
    createdBy: 'owner-1',
    createdAt: '2026-10-05T08:00:00.000Z',
    updatedAt: '2026-10-05T08:30:00.000Z',
    blockedBecause: options.blockedBecause ?? null,
  };
}

/** One request and one contract revision, as `GET .../requests/:requestId` answers it. */
function detail(options: {
  readonly status?: 'draft' | 'approved' | 'stale';
  readonly revision?: number;
  readonly fingerprint?: string;
  readonly answersCurrentRequest?: boolean;
  readonly blockedBecause?: string | null;
  readonly hasRevision?: boolean;
} = {}): RequestDetailView {
  const latest = options.hasRevision === false ? null : contractRevision(options);
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

/* -------------------------------------------------------------------------- */
/* The body                                                                     */
/* -------------------------------------------------------------------------- */

test('creating a request sends exactly the two members the route accepts', async () => {
  await withFetch(async () => {
    answer(201, { request: detail().request });
    await createRequestFromWords(SCOPE, { description: '  The header scrolls away.  ', title: '' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'POST');
    assert.equal(calls[0]?.path, '/api/projects/demo/requests');
    // The route is a `strictObject`, so a third member is refused by name. Read off the recorded
    // body rather than the signature: what matters is what left the browser (mvp-spec 3).
    assert.deepEqual(Object.keys(calls[0]?.body as object).sort(), ['description', 'title']);
    assert.deepEqual(calls[0]?.body, { title: 'The header scrolls away.', description: 'The header scrolls away.' });
  });
});

test('the request form asks for no scope, no criteria and no category', async () => {
  await withFetch(async () => {
    answer(201, { request: detail().request });
    await createRequestFromWords(SCOPE, {
      description: 'Make the search box remember what I typed between page loads.',
      title: '',
    });

    const body = JSON.stringify(calls[0]?.body) ?? '';
    for (const member of ['scope', 'outOfScope', 'acceptanceCriteria', 'verificationType', 'category', 'priority', 'projectId']) {
      assert.equal(
        body.includes(`"${member}"`),
        false,
        `a request is a capture; "${member}" belongs to the delivery contract and the route would refuse it`,
      );
    }
  });
});

test('a title the owner wrote is used as written, and never overwritten by derivation', () => {
  const draft = requestDraft({ description: 'The header scrolls away.', title: 'Sticky header' });
  assert.equal(draft.kind, 'ready');
  assert.equal(draft.kind === 'ready' ? draft.title : '', 'Sticky header');
});

test('a blank title is derived from the owner\'s own first sentence', () => {
  const draft = requestDraft({
    description: 'The header scrolls away on long pages.\nIt should stay put.',
    title: '   ',
  });
  assert.equal(draft.kind === 'ready' ? draft.title : '', 'The header scrolls away on long pages.');
  assert.equal(
    draft.kind === 'ready' ? draft.description : '',
    'The header scrolls away on long pages.\nIt should stay put.',
    'the description is sent whole; only the label is derived from it',
  );
});

test('a derived title never exceeds the route\'s own bound', () => {
  const long = `${'word '.repeat(80)}end`;
  const title = derivedRequestTitle(long);
  assert.ok(title.length > 0, 'a title must never be empty');
  assert.ok(title.length <= 200, `a title may be at most 200 characters, got ${title.length}`);
  assert.ok(!title.endsWith(' '), 'the shortened label should not end in a space');
});

test('an empty description is refused without sending anything', async () => {
  await withFetch(async () => {
    answer(201, { request: detail().request });
    const result = await createRequestFromWords(SCOPE, { description: '   \n  ', title: 'Something' });

    assert.equal(result.ok, false);
    assert.deepEqual(calls, [], 'a form that is not ready must not produce a request at all');
    const reason = result.ok ? '' : result.failure.reason;
    assert.match(reason, /Say what you want changed/);
  });
});

test('no project selected means no request and no URL naming one', async () => {
  await withFetch(async () => {
    const result = await createRequestFromWords(UNSELECTED, { description: 'Anything at all.', title: '' });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.failure.code, 'NoProjectSelected');
    assert.deepEqual(calls, [], 'an unselected project must not become a path (F02-AC1, F02-AC4)');
  });
});

test('a refused create keeps the owner\'s sentence', async () => {
  await withFetch(async () => {
    answer(400, { error: { code: 'Invalid', message: 'That description is too long.', fields: [{ path: 'description', message: 'The description is too long.' }] } });
    const result = await createRequestFromWords(SCOPE, { description: 'x'.repeat(20_001), title: '' });

    assert.equal(result.ok, false);
    // The screen holds its own copy of the form, so the test that matters is that the refusal comes
    // back with the field message attached rather than as a bare error the form cannot place (F02-AC4).
    const failure = result.ok ? null : result.failure;
    assert.deepEqual(failure?.fields, [{ path: 'description', message: 'The description is too long.' }]);
  });
});

/* -------------------------------------------------------------------------- */
/* What is read back                                                            */
/* -------------------------------------------------------------------------- */

test('the created request is re-read from the server rather than read off the create response', async () => {
  await withFetch(async () => {
    answer(201, { request: detail().request });
    await createRequestFromWords(SCOPE, { description: 'The header scrolls away.', title: '' });

    answer(200, detail({ status: 'draft', revision: 2 }));
    await readRequestDetail(SCOPE, 'req-1');

    assert.equal(calls[1]?.method, 'GET');
    assert.equal(calls[1]?.path, '/api/projects/demo/requests/req-1');
  });
});

test('a request list reads the project-scoped route and nothing unscoped', async () => {
  await withFetch(async () => {
    answer(200, { requests: [detail().request] });
    await readProjectRequests(SCOPE);

    assert.equal(calls[0]?.path, '/api/projects/demo/requests');
    assert.doesNotMatch(calls[0]?.path ?? '', /^\/api\/requests/);
  });
});

test('a request with no contract yet says so, rather than rendering an empty state', () => {
  const lines = requestProgress(detail({ hasRevision: false }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]?.fact ?? '', /No delivery contract yet/);
  assert.match(lines[0]?.detail ?? '', /contract is the agreement/);
});

test('an approved request names the revision and the fingerprint of the text that was agreed', () => {
  const fingerprint = 'fp_33333333333333333333333333333333';
  const lines = requestProgress(detail({ status: 'approved', revision: 3, fingerprint }));

  const approved = lines.find((line) => line.fact.includes('Approved revision 3'));
  assert.ok(approved !== undefined, 'the approved revision must be named');
  assert.match(approved.detail, new RegExp(fingerprint));
});

test('a draft revision is reported as a draft, with its fingerprint, and never as agreed', () => {
  const fingerprint = 'fp_44444444444444444444444444444444';
  const lines = requestProgress(detail({ status: 'draft', revision: 1, fingerprint }));

  const draft = lines.find((line) => line.fact.includes('Draft revision 1'));
  assert.ok(draft !== undefined, 'the draft revision must be named');
  assert.match(draft.detail, new RegExp(fingerprint));
  assert.match(draft.detail, /Nothing is agreed yet/);
  assert.equal(
    lines.some((line) => line.fact.startsWith('Approved')),
    false,
    'a draft must never be reported as an approval',
  );
});

test('an approval that no longer answers the request is shown, not hidden', () => {
  const lines = requestProgress(detail({ status: 'approved', revision: 2, answersCurrentRequest: false }));
  assert.ok(
    lines.some((line) => line.fact.includes('The request has changed since this was approved')),
    'the server reports that the approved revision no longer answers the request; that must be visible',
  );
});

test('a blocked approval is reported with the server\'s own reason', () => {
  // `blockedBecause` is the server's sentence about why this revision may not be measured against a
  // candidate. It is rendered verbatim rather than summarised, because a paraphrase would be a claim
  // about the reason that the server never made (F24-AC3).
  const reason = 'The request has changed since this was approved.';
  const lines = requestProgress(detail({ status: 'approved', revision: 1, blockedBecause: reason }));
  const line = lines.find((entry) => entry.fact.includes('cannot be measured against a candidate'));
  assert.equal(line?.detail, reason);
});
