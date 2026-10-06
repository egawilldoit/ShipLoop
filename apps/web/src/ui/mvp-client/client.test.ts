/**
 * Tests for the MVP browser transport (mvp-spec 3, mvp-spec 7, F02-AC1, F02-AC2, F02-AC4,
 * F23-AC1, F24-AC4, F25-AC3).
 *
 * The test that matters most here is `every call targets a route the server registers`. It reads
 * the route files, extracts the paths and methods they actually register, drives every exported
 * client call against a recording `fetch`, and asserts the recorded method and path match one of
 * those registrations. That is a mechanical check rather than a promise, and it exists because the
 * previous wave shipped a complete UI against `/api/requests`, `/api/contracts/:id`, `/api/home`,
 * `/api/review` and `/api/candidates` — none of which the backend had, and nothing in the build
 * noticed because the URL strings were scattered through components where no single review could
 * see them (mvp-spec 3, F02-AC2).
 *
 * The other cases each close a specific wrong answer:
 *
 *   - an unselected project produces a `NoProjectSelected` refusal and **no request at all**, so a
 *     page cannot address a project named `undefined` (F02-AC1, F02-AC4);
 *   - a 409 from an approval is `contract-changed`, carrying the fingerprint asked for, and is
 *     never reported as an approval (mvp-spec 7, F24-AC4);
 *   - a 409 from a decision is `superseded-commit` or `superseded-revision`, never a decision
 *     (F25-AC3);
 *   - a 422 on an acceptance is `not-eligible` with the outstanding requirements named, which is
 *     different from a stale submission (F23-AC1, F25-AC2);
 *   - `verifyCandidate` sends no body by default and no result ever; `refreshCandidate` sends no
 *     body at all, because `routes/candidates.ts` and `routes/verification.ts` parse
 *     `strictObject` bodies that refuse a client trying to name a result (F20-AC2);
 *   - `linkCandidate` sends the request, contract, revision and pull-request URL and no head SHA or
 *     branch, because the provider owns the candidate's identity (mvp-spec 3);
 *   - `recordOwnerTest` sends `result` and `note` and nothing else — no owner, no instant, no
 *     commit (F01-AC1, F25-AC4);
 *   - a project id carrying `..` or a separator is refused before a URL is built (F06-AC1);
 *   - a missing CSRF token is a `Forbidden` refusal with no request sent (F01-AC4);
 *   - a response whose envelope member is missing is `MalformedResponse`, never an empty value
 *     that would render as an empty board (mvp-spec 3);
 *   - a 503 from the home route is `Unavailable`, which a page must not draw as three empty groups
 *     (mvp-spec 3).
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  approveContract,
  createRequest,
  decideCandidate,
  draftContract,
  fetchHandoff,
  fetchHome,
  fetchReview,
  fetchSession,
  linkCandidate,
  listProjects,
  projectScopeOf,
  readCandidate,
  readVerificationCheckNames,
  recordOwnerTest,
  signIn,
  refreshCandidate,
  selectActiveProject,
  updateRequest,
  verifyCandidate,
} from './client.ts';
import { send, setMvpCsrfToken } from './transport.ts';
import type { ProjectScope } from './types.ts';

const SCOPE: ProjectScope = { kind: 'project', projectId: 'demo', projectName: 'Demo' };
const UNSELECTED: ProjectScope = { kind: 'no-project-selected', selectableProjectCount: 3 };

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly hasBody: boolean;
}

const realFetch = globalThis.fetch;
let calls: RecordedCall[] = [];
let nextResponse: { readonly status: number; readonly body: unknown; readonly raw?: string } = {
  status: 200,
  body: {},
};

/** Replaces `fetch` with a recorder. Restored by `restoreFetch` in each test's teardown. */
function recordFetch(): void {
  calls = [];
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const request = (init ?? {}) as { readonly method?: string; readonly body?: string };
    calls.push({
      method: request.method ?? 'GET',
      path: String(input),
      body: request.body === undefined ? null : JSON.parse(request.body) as unknown,
      hasBody: request.body !== undefined,
    });
    return {
      ok: nextResponse.status >= 200 && nextResponse.status < 300,
      status: nextResponse.status,
      text: async () => nextResponse.raw ?? JSON.stringify(nextResponse.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

function answer(status: number, body: unknown): void {
  nextResponse = { status, body };
}

/** The server's refusal envelope, as `apps/web/src/server/http-error.ts` sends it. */
function refusal(
  status: number,
  error: {
    readonly code: string;
    readonly message: string;
    readonly expected?: string;
    readonly actual?: string;
    readonly prerequisites?: readonly { readonly name: string; readonly detail: string; readonly remedy: string }[];
    readonly fields?: readonly { readonly path: string; readonly message: string }[];
  },
): void {
  answer(status, { error });
}

/* -------------------------------------------------------------------------- */
/* The routes the server actually registers                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every route this server registers, read out of the route files.
 *
 * Parsed from source rather than imported, so the check is against what `app.ts` wires rather than
 * against a list somebody maintains by hand — a hand-maintained list would drift exactly the way
 * the previous wave's UI did. `app.<method>(\s*'path'` also matches a registration whose path is
 * on the next line, which is how `routes/verification.ts` writes the owner-test route.
 */
async function registeredRoutes(): Promise<readonly string[]> {
  const routesDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../server/routes');
  const files = (await readdir(routesDirectory)).filter((name) => name.endsWith('.ts'));
  const routes: string[] = [];
  for (const file of files) {
    const contents = await readFile(join(routesDirectory, file), 'utf8');
    for (const match of contents.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      const method = match[1];
      const path = match[2];
      if (method !== undefined && path !== undefined) routes.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return routes;
}

/** Every route this server registers as a path, without the method, for path-only matching. */
async function registeredPaths(): Promise<readonly string[]> {
  return (await registeredRoutes()).map((route) => route.slice(route.indexOf(' ') + 1));
}

test('every call targets a route the server registers', async (t) => {
  const registered = await registeredRoutes();
  assert.ok(registered.length > 40, `expected the route files to register the MVP surface, read ${registered.length}`);

  const cases: readonly { readonly name: string; readonly run: () => Promise<unknown> }[] = [
    { name: 'fetchSession', run: () => fetchSession() },
    { name: 'listProjects', run: () => listProjects() },
    { name: 'selectActiveProject', run: () => selectActiveProject('demo') },
    { name: 'fetchHome', run: () => fetchHome(SCOPE) },
    { name: 'createRequest', run: () => createRequest(SCOPE, { title: 't', description: 'd' }) },
    { name: 'updateRequest', run: () => updateRequest(SCOPE, 'req_1', { expectedUpdatedAt: 'now' }) },
    { name: 'draftContract', run: () => draftContract(SCOPE, 'req_1', contractContent()) },
    { name: 'approveContract', run: () => approveContract(SCOPE, 'con_1', 1, 'fp_00000000000000000000000000000000') },
    { name: 'fetchHandoff', run: () => fetchHandoff(SCOPE, 'con_1', 1) },
    { name: 'linkCandidate', run: () =>
      linkCandidate(SCOPE, { requestId: 'req_1', contractId: 'con_1', contractRevision: 1, pullRequestUrl: 'https://github.com/o/r/pull/1' }) },
    { name: 'readCandidate', run: () => readCandidate(SCOPE, 'cand_1') },
    { name: 'refreshCandidate', run: () => refreshCandidate(SCOPE, 'cand_1') },
    { name: 'verifyCandidate', run: () => verifyCandidate(SCOPE, 'cand_1') },
    { name: 'verifyCandidate with method', run: () => verifyCandidate(SCOPE, 'cand_1', { method: 'github_checks' }) },
    { name: 'recordOwnerTest', run: () => recordOwnerTest(SCOPE, 'cand_1', 'ac_1', { result: 'passed' }) },
    { name: 'fetchReview', run: () => fetchReview(SCOPE, 'cand_1') },
    { name: 'decideCandidate', run: () =>
      decideCandidate(SCOPE, 'cand_1', { decision: 'accepted', expectedHeadSha: SHA, expectedContractRevision: 1 }) },
    { name: 'readVerificationCheckNames', run: () => readVerificationCheckNames(SCOPE) },
  ];

  await t.test('each call records one method and one path', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      for (const entry of cases) {
        calls = [];
        answer(200, { request: {}, contract: {}, candidate: {}, review: {}, verification: {}, ownerTest: {}, handoff: {}, owner: {}, activeProject: {}, profile: {} });
        await entry.run();
        assert.equal(calls.length, 1, `${entry.name} should send exactly one request`);
        const call = calls[0];
        assert.ok(call !== undefined, `${entry.name} recorded no request`);
        assert.match(call.method, /^(GET|POST|PUT|PATCH)$/, `${entry.name} used an unexpected method`);
        assert.match(
          call.path,
          /^\/api\//,
          `${entry.name} called ${call.path}, which is outside /api/ and is therefore not a route`,
        );
      }
    } finally {
      restoreFetch();
    }
  });

  await t.test('each recorded route is registered by the server', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    const paths = await registeredPaths();
    try {
      for (const entry of cases) {
        calls = [];
        answer(200, {});
        await entry.run();
        const call = calls[0];
        assert.ok(call !== undefined, `${entry.name} recorded no request`);
        assert.ok(
          paths.some((template) => matchesRoute(template, call.path)),
          `${entry.name} called ${call.path}, and no registered route declares it. Registered: ${paths.join(', ')}`,
        );
      }
    } finally {
      restoreFetch();
    }
  });

  await t.test('the recorded method is one the route declares', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      for (const entry of cases) {
        calls = [];
        answer(200, {});
        await entry.run();
        const call = calls[0];
        assert.ok(call !== undefined, `${entry.name} recorded no request`);
        const declared = (await registeredRoutes()).filter((route) => {
          const path = route.slice(route.indexOf(' ') + 1);
          return matchesRoute(path, call.path);
        });
        const methods = declared.map((route) => route.slice(0, route.indexOf(' ')));
        assert.ok(
          methods.includes(call.method),
          `${entry.name} used ${call.method} ${call.path}; the route declares ${methods.join(', ') || 'nothing'}`,
        );
      }
    } finally {
      restoreFetch();
    }
  });

  await t.test('no project-scoped call escapes the /api/projects namespace', async () => {
    // `/api/profiles/:projectId` is the one registered route outside the namespace, and it is
    // reached through the same `ProjectScope`, so the project identity still has one spelling
    // (F02-AC1, F02-AC2).
    const exceptions = new Set(['/api/profiles/:projectId']);
    const unscoped = new Set(['fetchSession', 'listProjects', 'selectActiveProject']);
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      for (const entry of cases) {
        if (unscoped.has(entry.name)) continue;
        calls = [];
        answer(200, {});
        await entry.run();
        const call = calls[0];
        assert.ok(call !== undefined, `${entry.name} recorded no request`);
        const template = call.path.split('/').map((segment, index) => (index === 3 && segment === 'demo' ? ':projectId' : segment)).join('/');
        if (exceptions.has(template)) continue;
        assert.match(
          template,
          /^\/api\/projects\/:projectId\//,
          `${entry.name} called ${template}, which is not project-scoped. Unscoped spellings such as /api/requests or /api/home are the defect this client exists to prevent (mvp-spec 3, F02-AC2).`,
        );
      }
    } finally {
      restoreFetch();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Truthful project identity                                                   */
/* -------------------------------------------------------------------------- */

test('an unselected project produces a refusal and no request at all', async (t) => {
  await t.test('the session states both variants honestly', () => {
    assert.deepEqual(projectScopeOf(null), { kind: 'no-project-selected', selectableProjectCount: 0 });
    assert.deepEqual(
      projectScopeOf({ state: 'NoProjectSelected', selectableProjectCount: 3 }),
      { kind: 'no-project-selected', selectableProjectCount: 3 },
    );
    assert.deepEqual(
      projectScopeOf({ state: 'Selected', activeProjectId: 'demo', activeProjectName: 'Demo' }),
      { kind: 'project', projectId: 'demo', projectName: 'Demo' },
    );
  });

  await t.test('no project id is ever interpolated into a path', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      answer(200, {});
      const home = await fetchHome(UNSELECTED);
      assert.equal(home.ok, false);
      if (!home.ok) {
        assert.equal(home.failure.code, 'NoProjectSelected');
        assert.match(home.failure.reason, /choose one of 3/i);
      }
      const review = await fetchReview(UNSELECTED, 'cand_1');
      assert.equal(review.ok, false);
      assert.equal(calls.length, 0, 'an unselected project must produce no request, not a request for a named project');
    } finally {
      restoreFetch();
    }
  });

  await t.test('a project id carrying a traversal is refused before a URL is built', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      answer(200, {});
      await assert.rejects(
        () => fetchHome({ kind: 'project', projectId: '..', projectName: 'Traversal' }),
        /path segment/i,
      );
      await assert.rejects(
        () => fetchHome({ kind: 'project', projectId: 'a/b', projectName: 'Separator' }),
        /path segment/i,
      );
      assert.equal(calls.length, 0);
    } finally {
      restoreFetch();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Conflicts are distinct outcomes                                             */
/* -------------------------------------------------------------------------- */

test('an approval whose contract changed is a distinct outcome, never a success', async (t) => {
  const stored = 'fp_11111111111111111111111111111111';
  const asked = 'fp_00000000000000000000000000000000';

  await t.test('a 409 reports the fingerprint asked for and the one stored', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      refusal(409, {
        code: 'Conflict',
        message: 'This revision has changed since you read it.',
        expected: asked,
        actual: stored,
      });
      const outcome = await approveContract(SCOPE, 'con_1', 1, asked);
      assert.equal(outcome.kind, 'contract-changed');
      if (outcome.kind === 'contract-changed') {
        assert.equal(outcome.expected, asked);
        assert.equal(outcome.actual, stored);
      }
    } finally {
      restoreFetch();
    }
  });

  await t.test('a 422 keeps the unmet prerequisites so the draft can be fixed', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      refusal(422, {
        code: 'Blocked',
        message: 'An automated criterion names no check.',
        prerequisites: [
          {
            name: 'Outstanding requirement',
            detail: 'acceptanceCriteria.ac_1.verificationCheckId',
            remedy: 'Bind the criterion to one of the project\'s configured checks.',
          },
        ],
      });
      const outcome = await approveContract(SCOPE, 'con_1', 1, asked);
      assert.equal(outcome.kind, 'refused');
      if (outcome.kind === 'refused') {
        assert.equal(outcome.failure.code, 'Blocked');
        assert.equal(outcome.failure.prerequisites.length, 1);
        assert.equal(outcome.failure.prerequisites[0]?.detail, 'acceptanceCriteria.ac_1.verificationCheckId');
      }
    } finally {
      restoreFetch();
    }
  });

  await t.test('the approval body carries the fingerprint and nothing else', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      answer(200, { contract: {} });
      await approveContract(SCOPE, 'con_1', 1, asked);
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.equal(call.method, 'POST');
      assert.equal(call.path, '/api/projects/demo/contracts/con_1/1/approve');
      // The route is a `strictObject` with exactly this one member; a body naming an approver is
      // refused by name there, and the approver is read from the session instead (mvp-spec 3).
      assert.deepEqual(call.body, { expectedContentFingerprint: asked });
    } finally {
      restoreFetch();
    }
  });
});

test('a decision naming a superseded commit is a distinct outcome', async (t) => {
  const prepared = SHA;
  const current = `${SHA.slice(0, 39)}f`;

  await t.test('a 409 for the head reports a superseded commit', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      refusal(409, {
        code: 'Conflict',
        message: 'This submission was prepared against an earlier commit.',
        expected: prepared,
        actual: current,
      });
      const outcome = await decideCandidate(SCOPE, 'cand_1', {
        decision: 'accepted',
        expectedHeadSha: prepared,
        expectedContractRevision: 1,
      });
      assert.equal(outcome.kind, 'superseded-commit');
      if (outcome.kind === 'superseded-commit') {
        assert.equal(outcome.expected, prepared);
        assert.equal(outcome.actual, current);
      }
    } finally {
      restoreFetch();
    }
  });

  await t.test('a 409 for the revision reports a superseded revision', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      refusal(409, {
        code: 'Conflict',
        message: 'A newer contract revision is current.',
        expected: '1',
        actual: '2',
      });
      const outcome = await decideCandidate(SCOPE, 'cand_1', {
        decision: 'changes_requested',
        expectedHeadSha: prepared,
        expectedContractRevision: 1,
        feedback: 'not this',
      });
      assert.equal(outcome.kind, 'superseded-revision');
      if (outcome.kind === 'superseded-revision') assert.equal(outcome.actual, '2');
    } finally {
      restoreFetch();
    }
  });

  await t.test('a 422 is not-eligible rather than a conflict, and names the blockers', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      refusal(422, {
        code: 'Blocked',
        message: 'This candidate cannot be accepted yet.',
        prerequisites: [{ name: 'Outstanding requirement', detail: 'Owner test ac_2 is pending.', remedy: 'Record it.' }],
      });
      const outcome = await decideCandidate(SCOPE, 'cand_1', {
        decision: 'accepted',
        expectedHeadSha: prepared,
        expectedContractRevision: 1,
      });
      assert.equal(outcome.kind, 'not-eligible');
      if (outcome.kind === 'not-eligible') {
        assert.equal(outcome.failure.prerequisites.length, 1);
      }
    } finally {
      restoreFetch();
    }
  });

  await t.test('the body names the commit and revision and no owner', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      answer(200, { review: {} });
      await decideCandidate(SCOPE, 'cand_1', {
        decision: 'accepted',
        expectedHeadSha: prepared,
        expectedContractRevision: 2,
      });
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.deepEqual(Object.keys(call.body as Record<string, unknown>).sort(), [
        'decision',
        'expectedContractRevision',
        'expectedHeadSha',
      ]);
    } finally {
      restoreFetch();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The two evidence writes carry nothing the server refuses                     */
/* -------------------------------------------------------------------------- */

test('the evidence writes submit what the routes accept and nothing more', async (t) => {
  await t.test('verify sends no body unless asked to be explicit about the method', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      answer(200, { verification: {} });
      await verifyCandidate(SCOPE, 'cand_1');
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.equal(call.path, '/api/projects/demo/candidates/cand_1/verify');
      assert.equal(call.hasBody, false, 'routes/verification.ts accepts an absent body and refuses any other member by name (F20-AC2)');

      calls = [];
      await verifyCandidate(SCOPE, 'cand_1', { method: 'github_checks' });
      const explicit = calls[0];
      assert.ok(explicit !== undefined);
      assert.deepEqual(explicit.body, { method: 'github_checks' });
    } finally {
      restoreFetch();
    }
  });

  await t.test('refresh sends no body, because the route parses strictObject({})', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      answer(200, { candidate: {} });
      await refreshCandidate(SCOPE, 'cand_1');
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.equal(call.method, 'POST');
      assert.equal(call.path, '/api/projects/demo/candidates/cand_1/refresh');
      assert.equal(call.hasBody, false);
    } finally {
      restoreFetch();
    }
  });

  await t.test('the link body carries exactly the four fields the route accepts', async () => {
    // `linkCandidateBody` in `routes/candidates.ts` is `strictObject` with `requestId`, `contractId`,
    // `contractRevision` and `pullRequestUrl`. There is no head-SHA field, no branch field and no
    // pull-request-number field to send, because identity is the provider's to state (mvp-spec 3).
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      answer(200, { candidate: {} });
      await linkCandidate(SCOPE, {
        requestId: 'req_1',
        contractId: 'con_1',
        contractRevision: 1,
        pullRequestUrl: 'https://github.com/o/r/pull/1',
      });
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.equal(call.method, 'POST');
      assert.equal(call.path, '/api/projects/demo/candidates');
      assert.deepEqual(Object.keys(call.body as Record<string, unknown>).sort(), [
        'contractId',
        'contractRevision',
        'pullRequestUrl',
        'requestId',
      ]);
    } finally {
      restoreFetch();
    }
  });

  await t.test('a candidate read asks for one candidate and sends nothing', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      answer(200, { candidate: {} });
      await readCandidate(SCOPE, 'cand_1');
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.equal(call.method, 'GET');
      assert.equal(call.path, '/api/projects/demo/candidates/cand_1');
      assert.equal(call.hasBody, false);
    } finally {
      restoreFetch();
    }
  });

  await t.test('an owner test carries a result and a note and no owner, instant or commit', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      answer(200, { ownerTest: {} });
      await recordOwnerTest(SCOPE, 'cand_1', 'ac_1', { result: 'failed', note: 'it still 404s' });
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.equal(call.path, '/api/projects/demo/candidates/cand_1/criteria/ac_1/owner-test');
      assert.deepEqual(call.body, { result: 'failed', note: 'it still 404s' });
    } finally {
      restoreFetch();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Transport refusals a page has to render differently                          */
/* -------------------------------------------------------------------------- */

test('transport failures are distinguishable values, never a thrown error', async (t) => {
  await t.test('a write with no CSRF token is refused and no request is sent', async () => {
    recordFetch();
    setMvpCsrfToken(null);
    try {
      answer(200, {});
      const result = await createRequest(SCOPE, { title: 't', description: 'd' });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.failure.code, 'Forbidden');
      assert.equal(calls.length, 0, 'a request with no token must not be attempted (F01-AC4)');
    } finally {
      restoreFetch();
    }
  });

  await t.test('a 503 from home is Unavailable, not three empty groups', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      refusal(503, { code: 'Unavailable', message: 'This deployment exposes no stored candidate or review projection.' });
      const result = await fetchHome(SCOPE);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.failure.code, 'Unavailable');
        assert.equal(result.failure.status, 503);
      }
    } finally {
      restoreFetch();
    }
  });

  await t.test('a body with no envelope member is MalformedResponse, never an empty value', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      answer(200, {});
      const result = await fetchHome(SCOPE);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.failure.code, 'MalformedResponse');
        assert.match(result.failure.reason, /home/);
      }
    } finally {
      restoreFetch();
    }
  });

  await t.test('a body that is not JSON is MalformedResponse', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      nextResponse = { status: 200, body: null, raw: '<!doctype html><title>owner shell</title>' };
      const result = await fetchReview(SCOPE, 'cand_1');
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.failure.code, 'MalformedResponse');
    } finally {
      restoreFetch();
    }
  });

  await t.test('field errors reach the input they belong to', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      refusal(400, {
        code: 'Invalid',
        message: 'The submitted values were not accepted.',
        fields: [
          { path: 'description', message: 'A request needs a description of what should change.' },
          { path: 'result', message: '"result" is not accepted here. Remove it or check the spelling.' },
        ],
      });
      const result = await updateRequest(SCOPE, 'req_1', { expectedUpdatedAt: 'now', description: '' });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.deepEqual(
          result.failure.fields.map((field) => field.path),
          ['description', 'result'],
        );
      }
    } finally {
      restoreFetch();
    }
  });

  await t.test('an unreadable project profile is its own state, not a failure to author a criterion', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      refusal(404, { code: 'NotFound', message: 'That project has no saved profile yet.' });
      const result = await readVerificationCheckNames(SCOPE);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value.kind, 'no-profile');
    } finally {
      restoreFetch();
    }
  });

  await t.test('the configured check names come from the profile, not from free text', async () => {
    recordFetch();
    setMvpCsrfToken('token-under-test');
    try {
      answer(200, {
        profile: { content: { policy: { requiredChecks: ['unit-tests', 'browser-e2e'] } } },
      });
      const result = await readVerificationCheckNames(SCOPE);
      assert.equal(result.ok, true);
      if (result.ok && result.value.kind === 'configured') {
        assert.deepEqual([...result.value.names], ['unit-tests', 'browser-e2e']);
      } else {
        assert.fail('expected the configured check names');
      }
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.equal(call.path, '/api/profiles/demo', 'the names are readable only from the project profile');
    } finally {
      restoreFetch();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Paths that must never appear                                                */
/* -------------------------------------------------------------------------- */

test('no unscoped spelling appears anywhere in this client', async () => {
  const directory = join(dirname(fileURLToPath(import.meta.url)));
  const files = ['client.ts', 'transport.ts', 'types.ts', 'index.ts'];
  // The five paths the previous wave invented and the backend never registered
  // (mvp-spec 3, F02-AC2). Matched with quotes so a test asserting their absence cannot match its
  // own source line.
  const forbidden = [
    "'/api/requests",
    "'/api/home",
    "'/api/review",
    "'/api/candidates",
    "'/api/contracts",
    '"/api/requests',
    '"/api/home',
    '"/api/review',
    '"/api/candidates',
    '"/api/contracts',
  ];
  for (const file of files) {
    const contents = await readFile(join(directory, file), 'utf8');
    for (const spelling of forbidden) {
      assert.equal(
        contents.includes(spelling),
        false,
        `${file} contains the unscoped spelling ${spelling}. Every project-scoped route takes the project in the path (mvp-spec 3, F02-AC2).`,
      );
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const SHA = 'a'.repeat(40);

function contractContent() {
  return {
    outcome: 'The owner sees the board.',
    scope: ['Home'],
    outOfScope: ['Deployment'],
    acceptanceCriteria: [
      {
        id: 'ac_1',
        description: 'The board names what needs the owner.',
        verificationType: 'automated' as const,
        verificationCheckId: 'browser-e2e',
      },
    ],
  };
}

/**
 * Whether a concrete path is the path a declared route template serves.
 *
 * Compares segment by segment, with a `:name` segment matching any single segment. That is the
 * honest comparison: this client was called with fixed literal ids (`req_1`, `con_1`, `cand_1`),
 * so a route either is the one this call addresses or it is not, and a matcher that guessed which
 * segments were parameters could pass a call against a route it does not address (mvp-spec 3,
 * F02-AC2).
 */
function matchesRoute(template: string, path: string): boolean {
  const templateSegments = template.split('/');
  const pathSegments = path.split('/');
  if (templateSegments.length !== pathSegments.length) return false;
  return templateSegments.every((segment, index) => {
    if (segment.startsWith(':')) return (pathSegments[index] ?? '') !== '';
    return segment === pathSegments[index];
  });
}
/**
 * The sign-in exemption is the one place this transport lets a state-changing call go out with no
 * forgery token, so it is pinned from both sides: sign-in is sent, and nothing else is.
 *
 * Without the first case the shell cannot sign in at all — the guard refused the request before it
 * was sent and named a missing token rather than the server being unreachable, which is both untrue
 * and useless to someone signing in for the first time (F01-AC4). Without the second, "allow a
 * tokenless POST" would have become a property any caller could reach, and the guard that protects
 * every other write in the product would be one flag away from being off.
 */
test('the session-establishing call is sent with no forgery token', async () => {
  recordFetch();
  setMvpCsrfToken(null);
  try {
    answer(200, { owner: {}, session: {}, csrfToken: 'tok' });

    const result = await signIn({ identifier: 'owner@example.invalid', password: 'hunter2-hunter2' });

    assert.equal(result.ok, true, `sign-in must be sent, not refused locally: ${JSON.stringify(result)}`);
    assert.deepEqual(
      calls.map((call) => call.path),
      ['/api/owner/sign-in'],
      'and it must be the sign-in route that was called',
    );
  } finally {
    restoreFetch();
  }
});

test('no other state-changing call is sent without a forgery token', async () => {
  // Every other write in the product depends on this refusal. The two calls below are chosen because
  // they are the ones that change a delivery decision, so the exemption leaking to either would be
  // the owner being able to decide something the server should have refused.
  recordFetch();
  try {
    for (const entry of [
      { name: 'recordOwnerTest', run: () => recordOwnerTest(SCOPE, 'cand-1', 'AC2', { result: 'passed' }) },
      {
        name: 'decideCandidate',
        run: () =>
          decideCandidate(SCOPE, 'cand-1', {
            decision: 'accepted' as const,
            expectedHeadSha: 'a'.repeat(40),
            expectedContractRevision: 1,
            feedback: null,
          }),
      },
    ]) {
      setMvpCsrfToken(null);
      calls = [];
      answer(200, {});

      const result = await entry.run();

      // The two calls report failure differently on purpose: the decision call answers with its own
      // outcome vocabulary because the transport answers a decision refusal with the outstanding
      // requirements the owner still has to discharge. Both must carry the same transport refusal,
      // and both must be refused before a request is made — which is what is asserted here, rather
      // than which shape each one happens to use (F24-AC3).
      const failure =
        'ok' in result && result.ok === false
          ? result.failure
          : 'failure' in result
            ? result.failure
            : null;
      assert.ok(failure !== null, `${entry.name} must report a refusal, got ${JSON.stringify(result)}`);
      assert.equal(failure.code, 'Forbidden', `${entry.name} must refuse for the missing forgery token`);
      assert.deepEqual(calls, [], `${entry.name} must be refused *before* any request was made`);
    }
  } finally {
    restoreFetch();
  }
});

test('the exemption is not reachable by asking for it on another route', async () => {
  // `establishesSession` is a member a caller can set, so the guard has to check it against the
  // path as well as the flag. A caller that sets it on a decision write must still be refused.
  recordFetch();
  try {
    setMvpCsrfToken(null);
    answer(200, {});

    const result = await send({
      method: 'POST',
      path: '/api/projects/demo/candidates/cand-1/decision',
      body: { decision: 'accepted' },
      establishesSession: true,
    });

    assert.equal(result.ok, false, 'asking for the exemption on another route must not work');
    assert.deepEqual(calls, [], 'and must be refused before any request');
  } finally {
    restoreFetch();
  }
});
