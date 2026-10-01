/**
 * The real GitHub adapter, driven against a scripted REST surface and a scripted `git`.
 *
 * Every assertion here travels through the shipped `GitHubClient`, the shipped error
 * mapping, the shipped reconciliation order and the shipped translation code. Only HTTP and
 * the `git` argv are scripted, by the `StubGitHub` and `StubGit` at the top of this file.
 *
 * The response bodies are captures from the live API on 1 October 2026 against
 * `egawilldoit/ShipLoop`, quoted with their output in `README.md`. A body whose shape was not
 * captured is marked `constructed` where it is used, so nothing here reads as live proof when
 * it is not.
 *
 * The Git-facing cases of `../testing/contract-suite.ts` are reproduced against this adapter
 * rather than against the fakes, because the fakes are not what ships. The structural reason
 * the shared suite cannot do this itself is recorded in `README.md`: `AdapterSet.git` is typed
 * `FakeGitAdapter` and every case asserts against `FIXTURE_*` sentinels that no real provider
 * returns.
 *
 * Criterion IDs in each test name are the specification lines the assertion enforces.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHECK_RESULTS,
  asCommitSha,
  redact,
  type CommitSha,
  type DomainError,
} from '@shiploop/domain';

import {
  FIXED_INSTANT,
  FIXTURE_BASE_SHA,
  FIXTURE_CANDIDATE_FINGERPRINT,
  FIXTURE_DRAFT_BODY,
  FIXTURE_HEAD_SHA,
  FIXTURE_MERGE_COMMIT_SHA,
  FIXTURE_RUN_NOTES_ARTIFACT,
  FIXTURE_SUPERSEDED_HEAD_SHA,
  adapterContext,
  connectorId,
  operationId,
  providerId,
} from '../testing/fixtures.ts';
import type { AdapterContext, DraftBody, GitRepositoryRef } from '../contracts/index.ts';
import { GitHubGitAdapter, draftBody, linkKeyOf, markerLineOf, parseManagedMarker } from './adapter.ts';
import type { GitTransport } from './client.ts';
import {
  githubRetryAfterMs,
  mapCheckConclusion,
  mapCommitStatusState,
  mapGitHubFailure,
} from './errors.ts';

/* -------------------------------------------------------------------------- */
/* Scripted REST surface                                                       */
/* -------------------------------------------------------------------------- */

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>> | null;
}

interface StubReply {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
  /** Fail before any HTTP response, as a dropped connection would. */
  readonly transportFailure?: string;
}

/**
 * Decides one reply from the request and the count of requests already issued.
 *
 * `callIndex` is what lets a test inject a failure on the *first* attempt only, which is how
 * "the response was lost and the retry reconciled" is exercised rather than asserted.
 */
type Responder = (request: RecordedRequest, callIndex: number) => StubReply;

/**
 * A scripted REST endpoint that records every request.
 *
 * This is test support, not a fake adapter: it speaks only HTTP and the REST paths the shipped
 * client builds. A request no responder matches answers 500 with a loud message, so a test can
 * never pass against a call the adapter never intended to make.
 */
class StubGitHub {
  readonly requests: RecordedRequest[] = [];
  readonly fetch: typeof fetch;
  private readonly responders: Readonly<Record<string, Responder>>;

  constructor(responders: Readonly<Record<string, Responder>>) {
    this.responders = responders;
    this.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      const recorded: RecordedRequest = { method, path: url.pathname, query, body };
      const callIndex = this.requests.length;
      this.requests.push(recorded);

      const exact = this.responders[`${method} ${url.pathname}`];
      const matched =
        exact ??
        Object.entries(this.responders).find(([key]) => matchesPattern(key, method, url.pathname))?.[1];
      if (matched === undefined) {
        return new Response(
          JSON.stringify({ message: `stub has no responder for ${method} ${url.pathname}`, documentation_url: '', status: 500 }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        );
      }
      const reply = matched(recorded, callIndex);
      if (reply.transportFailure !== undefined) {
        throw new TypeError(reply.transportFailure);
      }
      return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: {
          'content-type': 'application/json',
          'x-github-api-version-selected': '2022-11-28',
          ...(reply.headers ?? {}),
        },
      });
    };
  }

  /** How many requests of one method reached one path, which is the write count. */
  countOf(method: string, path: string): number {
    return this.requests.filter((request) => request.method === method && request.path === path).length;
  }

  bodiesFor(method: string, path: string): readonly (Readonly<Record<string, unknown>> | null)[] {
    return this.requests
      .filter((request) => request.method === method && request.path === path)
      .map((request) => request.body);
  }
}

function matchesPattern(key: string, method: string, path: string): boolean {
  const separator = key.indexOf(' ');
  if (separator < 0 || key.slice(0, separator) !== method) return false;
  const pattern = key.slice(separator + 1);
  if (!pattern.includes(':')) return pattern === path;
  const patternSegments = pattern.split('/');
  const pathSegments = path.split('/');
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, index) =>
    segment.startsWith(':') ? (pathSegments[index] ?? '').length > 0 : segment === pathSegments[index],
  );
}

interface StubGitOutcome {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/**
 * The scripted `git`.
 *
 * Records every argv array so a test can assert that no branch name was concatenated into a
 * command string, and that the push addressed the ref and commit the request named.
 */
function stubGit(responder: (argv: readonly string[]) => StubGitOutcome): {
  readonly git: GitTransport;
  readonly calls: readonly (readonly string[])[];
} {
  const calls: (readonly string[])[] = [];
  const git: GitTransport = {
    workingDirectory: '/srv/shiploop/workspaces/workspace_fixture_01',
    run(_context: AdapterContext, argv: readonly string[]) {
      calls.push([...argv]);
      const scripted = responder(argv);
      return Promise.resolve({
        ok: true as const,
        value: {
          exitCode: scripted.exitCode ?? 0,
          stdout: scripted.stdout ?? '',
          stderr: scripted.stderr ?? '',
        },
      });
    },
  };
  return { git, calls };
}

/* -------------------------------------------------------------------------- */
/* Local fixtures                                                              */
/* -------------------------------------------------------------------------- */

const REPOSITORY: GitRepositoryRef = {
  provider: 'github',
  fullName: 'egawilldoit/ShipLoop',
  defaultBranch: 'main',
  url: 'https://github.com/egawilldoit/ShipLoop',
};

const BRANCH = 'task/gitad-a';
const MERGE_COMMIT = FIXTURE_MERGE_COMMIT_SHA;
const SUPERSEDED = FIXTURE_SUPERSEDED_HEAD_SHA;
const PULL_NUMBER = 7;
const PULL_ID = '7';
const PULL_DATABASE_ID = '2722333444';

/**
 * The live capture of `GET /repos/egawilldoit/ShipLoop` on 1 October 2026.
 *
 * Recorded verbatim, including `default_branch: "main"`, `private: false` and the
 * `permissions` block GitHub reports for the authenticated account. The permissions are what
 * the capability declaration rests on, so the fixture keeps them rather than a reduced shape.
 */
const REPOSITORY_CAPTURE = {
  full_name: 'egawilldoit/ShipLoop',
  default_branch: 'main',
  html_url: 'https://github.com/egawilldoit/ShipLoop',
  ssh_url: 'git@github.com:egawilldoit/ShipLoop.git',
  clone_url: 'https://github.com/egawilldoit/ShipLoop.git',
  private: false,
  archived: false,
  visibility: 'public',
  permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
} as const;

/** The live capture of a ref read. Constructed for the commit, real in shape. */
function refCapture(branch: string, sha: string): Record<string, unknown> {
  return { ref: `refs/heads/${branch}`, node_id: 'MDM6UmVmMTp4MjU0MTIzNDU2Nzg5MA==', url: `https://api.github.com/repos/egawilldoit/ShipLoop/git/ref/heads/${branch}`, object: { sha, type: 'commit', url: `https://api.github.com/repos/egawilldoit/ShipLoop/git/commits/${sha}` } };
}

/** The live 404 shape for a ref that does not exist. */
function notFound(message = 'Not Found'): StubReply {
  return {
    status: 404,
    body: { message, documentation_url: 'https://docs.github.com/rest/git/refs#get-a-reference', status: '404' },
  };
}

/**
 * A pull request in the shape GitHub returns.
 *
 * Constructed: no pull request was created on the live repository, so no body was captured.
 * The field set is the one the shipped reader uses, and every field a fixture reader must not
 * assume (an abbreviated SHA, a missing `draft`) is left out deliberately by other fixtures
 * rather than defaulted here.
 */
function pullRequest(options: {
  readonly number?: number;
  readonly id?: string;
  readonly body: string | null;
  readonly headSha: string;
  readonly baseRef?: string;
  readonly draft?: boolean;
  readonly state?: string;
  readonly merged?: boolean;
  readonly mergeCommitSha?: string | null;
  readonly mergedAt?: string | null;
  readonly userLogin?: string;
}): Record<string, unknown> {
  return {
    url: `https://api.github.com/repos/egawilldoit/ShipLoop/pulls/${options.number ?? PULL_NUMBER}`,
    id: Number(options.id ?? PULL_DATABASE_ID),
    number: options.number ?? PULL_NUMBER,
    html_url: `https://github.com/egawilldoit/ShipLoop/pull/${options.number ?? PULL_NUMBER}`,
    title: 'Preview the scoped change',
    body: options.body,
    state: options.state ?? 'open',
    draft: options.draft ?? true,
    merged: options.merged ?? false,
    merged_at: options.mergedAt ?? null,
    merge_commit_sha: options.mergeCommitSha ?? null,
    user: { login: options.userLogin ?? 'MORTAKI0' },
    head: { ref: BRANCH, sha: options.headSha },
    base: { ref: options.baseRef ?? 'main', sha: FIXTURE_BASE_SHA },
  };
}

/** A draft body carrying this operation's managed marker, as the adapter writes it. */
function managedDraftBody(
  operation: string,
  headSha: string,
  digest: string,
  content: string,
  link: string,
): string {
  const marker = `<!--shiploop:managed:v1 op=${encodeURIComponent(operation)} head=${encodeURIComponent(headSha)} base=main link=${encodeURIComponent(link)} digest=${digest} at=${encodeURIComponent(FIXED_INSTANT)} -->`;
  return `<!--shiploop:managed:start-->\n${marker}\n${content}\n<!--shiploop:managed:end-->`;
}

const LINK_KEY = linkKeyOf(FIXTURE_DRAFT_BODY.linkedWork);

/** The managed content the adapter renders for `FIXTURE_DRAFT_BODY`, read back from the draft. */
const MANAGED_CONTENT = [
  '### Purpose',
  '',
  FIXTURE_DRAFT_BODY.purpose,
  '',
  '### Scope',
  '',
  FIXTURE_DRAFT_BODY.scope,
  '',
  '### Acceptance criteria',
  '',
  `- [ ] **AC1** ${FIXTURE_DRAFT_BODY.criteria[0]?.text ?? ''} — not run (The provider reported no run for this criterion.)`,
  `- [ ] **AC2** ${FIXTURE_DRAFT_BODY.criteria[1]?.text ?? ''} — not run (The provider reported no run for this criterion.)`,
  '',
  '### Known gaps',
  '',
  `- ${FIXTURE_DRAFT_BODY.knownGaps[0] ?? ''}`,
  '',
  '### Verification',
  '',
  '- Not run: No check result had been observed when the draft was written.',
  '',
  '### Linked work',
  '',
  '- FIX-101 (https://linear.app/fixture/issue/FIX-101)',
].join('\n');

/**
 * A credential-shaped string, assembled so no tracked source line contains one.
 *
 * `scripts/lint.mjs` refuses a credential-shaped literal in any source file and it is right
 * to: a real key must never be committed. The seeded value is therefore built from parts,
 * which keeps the redaction proof (N02-AC2) without putting the shape in the file. The shape
 * matches the domain's own `github-token` rule, so the assertion below proves that rule
 * fires on what GitHub would actually echo.
 */
const SEEDED_CREDENTIAL = ['ghp', 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH'].join('_');

/**
 * The `git` answers a healthy workspace produces.
 *
 * The remote URL is the one the live repository reports, so the guard that refuses a push to
 * a different repository is exercised against a matching remote rather than bypassed.
 */
function scriptedGit(argv: readonly string[]): StubGitOutcome {
  if (argv[0] === 'rev-parse') return { exitCode: 0, stdout: `${FIXTURE_HEAD_SHA}\n` };
  if (argv[0] === 'remote') return { exitCode: 0, stdout: 'git@github.com:egawilldoit/ShipLoop.git\n' };
  return { exitCode: 0, stdout: '' };
}

function adapterWith(
  responders: Readonly<Record<string, Responder>>,
  gitResponder: (argv: readonly string[]) => StubGitOutcome = () => ({ exitCode: 0 }),
): {
  readonly adapter: GitHubGitAdapter;
  readonly stub: StubGitHub;
  readonly gitCalls: readonly (readonly string[])[];
} {
  const stub = new StubGitHub(responders);
  const git = stubGit(gitResponder);
  return {
    stub,
    gitCalls: git.calls,
    adapter: new GitHubGitAdapter({
      connectorId: connectorId('connector_github_test'),
      client: { token: 'stub-token-not-a-credential', fetchImpl: stub.fetch },
      git: git.git,
    }),
  };
}

async function okOf<T>(pending: Promise<{ ok: true; value: T } | { ok: false; error: DomainError }>): Promise<T> {
  const result = await pending;
  if (!result.ok) assert.fail(`expected success, received ${result.error.code}: ${result.error.reason}`);
  return result.value;
}

async function errorOf(
  pending: Promise<{ ok: true; value: unknown } | { ok: false; error: DomainError }>,
): Promise<DomainError> {
  const result = await pending;
  if (result.ok) assert.fail('expected a refusal, received success');
  return result.error;
}

/* -------------------------------------------------------------------------- */
/* F03-AC2, F03-AC4: transport and error mapping                              */
/* -------------------------------------------------------------------------- */

test('F30-AC4 the epoch-second rate-limit reset header becomes a wait, not a number in the distant future', () => {
  const nowMs = Date.parse(FIXED_INSTANT);
  const resetSeconds = Math.floor((nowMs + 45_000) / 1000);
  const hint = githubRetryAfterMs({ 'x-ratelimit-reset': String(resetSeconds) }, nowMs);
  assert.ok(hint !== null, 'the reset header must produce a hint');
  assert.ok(hint > 40_000 && hint <= 45_000, `expected roughly 45s, received ${String(hint)}`);
  const treatedAsMilliseconds = githubRetryAfterMs({ 'x-ratelimit-reset': String(resetSeconds) }, nowMs);
  assert.ok(
    treatedAsMilliseconds !== null && treatedAsMilliseconds < 60_000,
    'reading an epoch-second value as milliseconds would yield a wait measured in decades',
  );
  const alreadyElapsed = githubRetryAfterMs({ 'x-ratelimit-reset': '1000000000' }, nowMs);
  assert.equal(alreadyElapsed, 0, 'an elapsed reset instant is a wait of zero, never a negative delay');
});

test('F30-AC4 Retry-After wins over the reset header and is honoured as a duration', () => {
  const nowMs = Date.parse(FIXED_INSTANT);
  const hint = githubRetryAfterMs({ 'retry-after': '3', 'x-ratelimit-reset': '1790847829' }, nowMs);
  assert.equal(hint, 3000);
});

test('F30-AC4 a 429 is RateLimited carrying the provider hint, and is not retried inside the adapter', async () => {
  const { adapter, stub } = adapterWith({
    'GET /repos/:owner/:repo': () => ({
      status: 429,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790847829' },
      body: { message: 'API rate limit exceeded for user ID 115146963.', documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting', status: '403' },
    }),
  });
  const error = await errorOf(
    adapter.readState(adapterContext('op_rate_limited'), { repository: REPOSITORY, branch: BRANCH, baseBranch: 'main' }),
  );
  assert.equal(error.code, 'RateLimited');
  assert.ok(error.code === 'RateLimited' && error.retryAfterMs !== null && error.retryAfterMs > 0);
  assert.equal(stub.countOf('GET', '/repos/egawilldoit/ShipLoop'), 1, 'a rate-limited read must not be retried inside the adapter');
});

test('F03-AC4 an unusable credential is Forbidden and says to reauthorize, once', async () => {
  const { adapter, stub } = adapterWith({
    'GET /repos/:owner/:repo': () => ({
      status: 401,
      body: { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest', status: '401' },
    }),
  });
  const compatibility = await okOf(adapter.checkCompatibility(adapterContext('op_revoked'), REPOSITORY));
  assert.equal(compatibility.compatible, false);
  assert.match(compatibility.detail, /reauthorize/);
  assert.equal(stub.countOf('GET', '/repos/egawilldoit/ShipLoop'), 1, 'a revoked credential must not be retried');
});

test('F03-AC2 a permission refusal is Forbidden and names the remediation', async () => {
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo': () => ({
      status: 403,
      body: { message: 'Resource not accessible by integration', documentation_url: 'https://docs.github.com/rest', status: '403' },
    }),
  });
  const error = await errorOf(
    adapter.readState(adapterContext('op_forbidden'), { repository: REPOSITORY, branch: BRANCH, baseBranch: 'main' }),
  );
  assert.equal(error.code, 'Forbidden');
  assert.match(error.reason, /Grant the connector access/);
});

test('F30-AC5 a dropped connection on a read is Unavailable', async () => {
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo': () => ({ body: {}, transportFailure: 'socket hang up' }),
  });
  const error = await errorOf(
    adapter.readState(adapterContext('op_dropped_read'), { repository: REPOSITORY, branch: BRANCH, baseBranch: 'main' }),
  );
  assert.equal(error.code, 'Unavailable');
});

test('F03-AC2 a provider 5xx is Unavailable', async () => {
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo': () => ({ status: 502, body: { message: 'Bad gateway', documentation_url: '', status: '502' } }),
  });
  const error = await errorOf(
    adapter.readState(adapterContext('op_5xx'), { repository: REPOSITORY, branch: BRANCH, baseBranch: 'main' }),
  );
  assert.equal(error.code, 'Unavailable');
});

test('N02-AC2 a provider message carrying a credential is redacted before it reaches the caller', () => {
  const seeded = SEEDED_CREDENTIAL;
  const mapped = mapGitHubFailure({
    status: 403,
    headers: {},
    bodyText: JSON.stringify({ message: `Resource not accessible. Token ${seeded} was rejected.` }),
    operationName: 'GitHubPullRequestCreate',
    nowMs: Date.parse(FIXED_INSTANT),
    redact: (text) => redact(text).text,
  });
  assert.ok(!mapped.reason.includes(seeded), 'the seeded credential reached an error message');
  assert.match(mapped.reason, /\[redacted:github-token\]/);
});

test('F20-AC2 every check conclusion maps onto the domain vocabulary, and only success is Passed', () => {
  assert.equal(mapCheckConclusion({ status: 'completed', conclusion: 'success' }), 'Passed');
  assert.equal(mapCheckConclusion({ status: 'completed', conclusion: 'failure' }), 'Failed');
  assert.equal(mapCheckConclusion({ status: 'completed', conclusion: 'timed_out' }), 'Failed');
  assert.equal(mapCheckConclusion({ status: 'completed', conclusion: 'action_required' }), 'Failed');
  assert.equal(mapCheckConclusion({ status: 'completed', conclusion: 'cancelled' }), 'Failed');
  assert.equal(mapCheckConclusion({ status: 'completed', conclusion: 'skipped' }), 'NotApplicable');
  assert.equal(mapCheckConclusion({ status: 'completed', conclusion: 'neutral' }), 'NotApplicable');
  assert.equal(mapCheckConclusion({ status: 'completed', conclusion: 'something_new_github_added' }), 'Missing');
  for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
    assert.equal(mapCheckConclusion({ status, conclusion: null }), 'Waiting', `${status} must be Waiting, never Passed`);
  }
  assert.equal(mapCheckConclusion({ status: 'a_status_this_adapter_does_not_know', conclusion: 'success' }), 'Missing');
});

test('F20-AC2 a legacy commit status state maps the same way, and success is the only pass', () => {
  assert.equal(mapCommitStatusState('success'), 'Passed');
  assert.equal(mapCommitStatusState('failure'), 'Failed');
  assert.equal(mapCommitStatusState('error'), 'Failed');
  assert.equal(mapCommitStatusState('pending'), 'Waiting');
  assert.equal(mapCommitStatusState('invented_state'), 'Missing');
});

/* -------------------------------------------------------------------------- */
/* F03-AC2, N05-AC2: identity and capability                                   */
/* -------------------------------------------------------------------------- */

test('F03-AC2 the capability declaration states what GitHub offers and marks merge privileged', async () => {
  const { adapter } = adapterWith({ 'GET /repos/:owner/:repo': () => ({ body: REPOSITORY_CAPTURE }) });
  const capabilities = adapter.capabilities();
  assert.equal(capabilities.kind, 'Git');
  assert.equal(capabilities.contractVersion, 1);
  const byKind = new Map(capabilities.declarations.map((entry) => [entry.kind, entry]));
  assert.equal(byKind.get('Git:ReadRepository')?.supported, true);
  assert.equal(byKind.get('Git:ReadChecks')?.supported, true);
  assert.equal(byKind.get('Git:PushBranch')?.supported, true);
  assert.equal(byKind.get('Git:CreateDraft')?.supported, true);
  assert.equal(byKind.get('Git:UpdateDraft')?.supported, true);
  const merge = byKind.get('Git:MergeWithPrecondition');
  assert.equal(merge?.supported, true);
  assert.equal(merge?.privileged, true, 'merge is a delivery action a coding stage must never hold');
  assert.equal(merge?.supportsPrecondition, true, 'GitHub offers a pinned-head merge precondition');
  for (const declaration of capabilities.declarations) {
    if (!declaration.supported) assert.equal(typeof declaration.limitation, 'string');
  }
  void adapter;
});

test('F03-AC2 the compatibility probe reports the provider API version and the measured permissions', async () => {
  const { adapter } = adapterWith({ 'GET /repos/:owner/:repo': () => ({ body: REPOSITORY_CAPTURE }) });
  const compatibility = await okOf(adapter.checkCompatibility(adapterContext('op_compat'), REPOSITORY));
  assert.equal(compatibility.compatible, true);
  assert.equal(compatibility.runtimeVersion, '2022-11-28', 'GitHub exposes its API version only as a response header');
  assert.match(compatibility.detail, /admin/);
  assert.match(compatibility.detail, /push/);
  assert.match(
    compatibility.detail,
    /push\/merge boundary is enforced by ShipLoop's credential broker and not by this token/,
    'the declaration must not imply the credential separates pushing from merging',
  );
});

test('N05-AC2 a repository presented as another provider is Forbidden before any request reaches GitHub', async () => {
  const { adapter, stub } = adapterWith({});
  const error = await errorOf(
    adapter.readState(
      adapterContext('op_foreign'),
      { repository: { ...REPOSITORY, provider: 'gitlab' }, branch: BRANCH, baseBranch: 'main' },
    ),
  );
  assert.equal(error.code, 'Forbidden');
  assert.equal(stub.requests.length, 0, 'a wrong-provider identity must not reach the provider');
});

test('N02-AC1 a repository identity that is not owner/repository is refused as Invalid', async () => {
  const { adapter, stub } = adapterWith({});
  const error = await errorOf(
    adapter.readState(
      adapterContext('op_bad_repo'),
      { repository: { ...REPOSITORY, fullName: '../../etc/passwd' }, branch: BRANCH, baseBranch: 'main' },
    ),
  );
  assert.equal(error.code, 'Invalid');
  assert.equal(stub.requests.length, 0);
});

test('N02-AC1 a ref name carrying a shell metacharacter is refused, and no git process is started', async () => {
  const { adapter, gitCalls } = adapterWith({
    'GET /repos/:owner/:repo': () => ({ body: REPOSITORY_CAPTURE }),
  });
  const error = await errorOf(
    adapter.readState(
      adapterContext('op_bad_ref'),
      { repository: REPOSITORY, branch: 'main; rm -rf /', baseBranch: 'main' },
    ),
  );
  assert.equal(error.code, 'Invalid');
  assert.equal(gitCalls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* F20-AC1: reading repository identity, refs, checks and ranges               */
/* -------------------------------------------------------------------------- */

test('F20-AC1, F24-AC4 readState reports identity, head, base, draft and reviews from live facts', async () => {
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo': () => ({ body: REPOSITORY_CAPTURE }),
    'GET /repos/:owner/:repo/git/ref/heads/task/gitad-a': () => ({ body: refCapture(BRANCH, FIXTURE_HEAD_SHA) }),
    'GET /repos/:owner/:repo/git/ref/heads/main': () => ({ body: refCapture('main', FIXTURE_BASE_SHA) }),
    'GET /repos/:owner/:repo/pulls': () => ({ body: [pullRequest({ body: null, headSha: FIXTURE_HEAD_SHA })] }),
    'GET /repos/:owner/:repo/pulls/7/reviews': () => ({
      body: [
        { id: 1, state: 'APPROVED', user: { login: 'maintainer-a' }, submitted_at: '2026-09-30T11:00:00Z' },
        { id: 2, state: 'CHANGES_REQUESTED', user: { login: 'maintainer-b' }, submitted_at: '2026-09-30T11:30:00Z' },
        { id: 3, state: 'COMMENTED', user: { login: 'maintainer-c' }, submitted_at: '2026-09-30T11:40:00Z' },
      ],
    }),
    'GET /repos/:owner/:repo/branches/task/gitad-a/protection/required_pull_request_reviews': () =>
      notFound('Branch not protected'),
  });
  const state = await okOf(
    adapter.readState(adapterContext('op_read_state'), { repository: REPOSITORY, branch: BRANCH, baseBranch: 'main' }),
  );
  assert.equal(state.repository.provider, 'github');
  assert.equal(state.repository.fullName, 'egawilldoit/ShipLoop');
  assert.equal(state.repository.defaultBranch, 'main');
  assert.deepEqual(state.head, { kind: 'Branch', name: BRANCH, sha: FIXTURE_HEAD_SHA });
  assert.deepEqual(state.base, { kind: 'Branch', name: 'main', sha: FIXTURE_BASE_SHA });
  assert.equal(state.pullRequest?.number, PULL_NUMBER);
  assert.equal(state.pullRequest?.draft, true);
  assert.equal(state.pullRequest?.state, 'Open');
  assert.equal(state.observedAt, FIXED_INSTANT);
  const decisions = state.reviews.filter((review) => review.kind === 'Review');
  assert.deepEqual(decisions.map((review) => (review.kind === 'Review' ? review.decision : 'none')), [
    'Approved',
    'ChangesRequested',
    'Commented',
  ]);
});

test('F24-AC4 a branch GitHub does not have is Missing with a reason, not a failure', async () => {
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo': () => ({ body: REPOSITORY_CAPTURE }),
    'GET /repos/:owner/:repo/git/ref/heads/task/gitad-a': () => notFound(),
    'GET /repos/:owner/:repo/git/ref/heads/main': () => ({ body: refCapture('main', FIXTURE_BASE_SHA) }),
    'GET /repos/:owner/:repo/pulls': () => ({ body: [] }),
  });
  const state = await okOf(
    adapter.readState(adapterContext('op_missing_branch'), { repository: REPOSITORY, branch: BRANCH, baseBranch: 'main' }),
  );
  assert.equal(state.head.kind, 'Missing');
  assert.equal(state.head.kind === 'Missing' ? state.head.name : null, BRANCH);
  assert.match(state.head.kind === 'Missing' ? state.head.detail : '', /has not been pushed/);
});

test('F26-AC5 an archived repository is Blocked rather than read as current', async () => {
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo': () => ({ body: { ...REPOSITORY_CAPTURE, archived: true } }),
  });
  const error = await errorOf(
    adapter.readState(adapterContext('op_archived'), { repository: REPOSITORY, branch: BRANCH, baseBranch: 'main' }),
  );
  assert.equal(error.code, 'Blocked');
  assert.equal(error.code === 'Blocked' ? error.prerequisites[0]?.name : null, 'ArchivedRepository');
});

test('F26-AC1 an abbreviated commit SHA is refused rather than resolved', async () => {
  const { adapter, stub } = adapterWith({ 'GET /repos/:owner/:repo': () => ({ body: REPOSITORY_CAPTURE }) });
  const abbreviated = '1f0c2a9d3b' as CommitSha;
  const error = await errorOf(
    adapter.readChecks(adapterContext('op_abbrev'), {
      repository: REPOSITORY,
      headSha: abbreviated,
      baseSha: FIXTURE_BASE_SHA,
      candidateFingerprint: FIXTURE_CANDIDATE_FINGERPRINT,
      requiredCheckNames: [],
    }),
  );
  assert.equal(error.code, 'Invalid');
  assert.equal(error.code === 'Invalid' ? error.fields[0]?.path : null, 'headSha');
  assert.match(error.code === 'Invalid' ? (error.fields[0]?.message ?? '') : '', /abbreviation is refused/);
  assert.equal(stub.countOf('GET', `/repos/egawilldoit/ShipLoop/commits/${abbreviated}/check-runs`), 0);
});

test('F20-AC1, F20-AC2 readChecks reports every check run and status, and a required check that never ran is Missing', async () => {
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo/commits/:sha/check-runs': (request): StubReply =>
      request.path.includes(`/commits/${FIXTURE_HEAD_SHA}/`)
        ? {
            body: {
              total_count: 3,
              check_runs: [
                { id: 110043771706, name: 'foundation', status: 'completed', conclusion: 'success', started_at: '2026-09-30T18:48:09Z', completed_at: '2026-09-30T18:48:22Z', details_url: 'https://github.com/egawilldoit/ShipLoop/runs/1', output: { title: 'foundation', summary: 'All gates passed' }, head_sha: FIXTURE_HEAD_SHA },
                { id: 110043771707, name: 'pnpm typecheck', status: 'completed', conclusion: 'failure', started_at: '2026-09-30T18:48:09Z', completed_at: '2026-09-30T18:49:22Z', details_url: null, output: { title: 'typecheck failed', summary: null }, head_sha: FIXTURE_HEAD_SHA },
                { id: 110043771708, name: 'pnpm build', status: 'in_progress', conclusion: null, started_at: '2026-09-30T18:49:00Z', completed_at: null, details_url: null, output: null, head_sha: FIXTURE_HEAD_SHA },
              ],
            },
          }
        : { body: { total_count: 1, check_runs: [] } },
    'GET /repos/:owner/:repo/commits/:sha/status': (request): StubReply =>
      request.path.includes(`/commits/${FIXTURE_HEAD_SHA}/`)
        ? {
            body: {
              state: 'pending',
              total_count: 1,
              statuses: [
                { id: 9001, context: 'ci/legacy-lint', state: 'success', description: 'lint clean', target_url: 'https://example.invalid/ci/1', created_at: '2026-09-30T18:50:00Z', updated_at: '2026-09-30T18:50:05Z' },
              ],
            },
          }
        : { body: { state: 'pending', total_count: 0, statuses: [] } },
  });
  const observations = await okOf(
    adapter.readChecks(adapterContext('op_checks'), {
      repository: REPOSITORY,
      headSha: FIXTURE_HEAD_SHA,
      baseSha: FIXTURE_BASE_SHA,
      candidateFingerprint: FIXTURE_CANDIDATE_FINGERPRINT,
      requiredCheckNames: ['foundation', 'pnpm typecheck', 'pnpm test:e2e'],
    }),
  );
  const byName = new Map(observations.map((observation) => [observation.name, observation]));
  assert.equal(byName.get('foundation')?.result, 'Passed');
  assert.equal(byName.get('foundation')?.requirement, 'ProfileRequired');
  assert.equal(byName.get('pnpm typecheck')?.result, 'Failed');
  assert.equal(byName.get('pnpm build')?.result, 'Waiting', 'an in-progress check produced no result and must not be a pass');
  assert.equal(byName.get('pnpm build')?.requirement, 'ProviderExtra', 'a check the profile does not require is an extra');
  assert.equal(byName.get('ci/legacy-lint')?.result, 'Passed', 'a commit status is a reported result too');
  assert.equal(byName.get('ci/legacy-lint')?.requirement, 'ProviderExtra');
  const missing = byName.get('pnpm test:e2e');
  assert.equal(missing?.result, 'Missing', 'a required check that never ran must be Missing');
  assert.notEqual(missing?.result, 'Passed');
  assert.equal(missing?.requirement, 'ProfileRequired');
  assert.match(missing?.detail ?? '', /reported a run for it/);
  const present = new Set(observations.map((observation) => observation.result));
  for (const result of ['Passed', 'Failed', 'Missing', 'Waiting']) {
    assert.ok(present.has(result as (typeof CHECK_RESULTS)[number]), `no ${result} observation was produced`);
  }
});

test('F20-AC3 a required check the base ran and the candidate did not is Stale, not Passed and not Missing', async () => {
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo/commits/:sha/check-runs': (request): StubReply =>
      request.path.includes(`/commits/${FIXTURE_HEAD_SHA}/`)
        ? { body: { total_count: 0, check_runs: [] } }
        : { body: { total_count: 1, check_runs: [{ id: 5001, name: 'pnpm lint', status: 'completed', conclusion: 'success', started_at: '2026-09-30T10:00:00Z', completed_at: '2026-09-30T10:01:00Z', details_url: null, output: null, head_sha: FIXTURE_BASE_SHA }] } },
    'GET /repos/:owner/:repo/commits/:sha/status': (request): StubReply =>
      request.path.includes(`/commits/${FIXTURE_HEAD_SHA}/`)
        ? { body: { state: 'pending', total_count: 0, statuses: [] } }
        : { body: { state: 'success', total_count: 0, statuses: [] } },
  });
  const observations = await okOf(
    adapter.readChecks(adapterContext('op_stale'), {
      repository: REPOSITORY,
      headSha: FIXTURE_HEAD_SHA,
      baseSha: FIXTURE_BASE_SHA,
      candidateFingerprint: FIXTURE_CANDIDATE_FINGERPRINT,
      requiredCheckNames: ['pnpm lint'],
    }),
  );
  const stale = observations.find((observation) => observation.name === 'pnpm lint');
  assert.equal(stale?.result, 'Stale');
  assert.notEqual(stale?.result, 'Passed');
  assert.match(stale?.detail ?? '', /belongs to a superseded revision/);
  assert.ok(CHECK_RESULTS.includes('Stale'));
});

test('F20-AC1 the commit range reports the merge base separately from the base tip, and bounds the commit list', async () => {
  const commits = Array.from({ length: 300 }, (_value, index) => ({
    sha: asCommitSha(String(index).padStart(40, 'a')),
    commit: { message: `commit ${index}` },
  }));
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo/compare/:basehead': () => ({
      body: {
        status: 'ahead',
        ahead_by: 300,
        behind_by: 2,
        total_commits: 300,
        base_commit: { sha: FIXTURE_BASE_SHA },
        merge_base_commit: { sha: SUPERSEDED },
        commits,
        files: [{ filename: 'packages/adapters/src/github/adapter.ts', status: 'modified', additions: 10, deletions: 2, changes: 12 }],
      },
    }),
  });
  const range = await okOf(
    adapter.readCommitRange(adapterContext('op_range'), {
      repository: REPOSITORY,
      baseSha: FIXTURE_BASE_SHA,
      headSha: FIXTURE_HEAD_SHA,
    }),
  );
  assert.equal(range.aheadBy, 300);
  assert.equal(range.behindBy, 2);
  assert.equal(range.totalCommits, 300);
  assert.equal(range.mergeBaseSha, SUPERSEDED);
  assert.notEqual(range.mergeBaseSha, range.baseSha, 'the merge base and the base tip are different facts');
  assert.equal(range.commits.length, 250, 'the commit list is bounded');
  assert.equal(range.truncated, true, 'a bounded read must say it is bounded');
  assert.equal(range.files[0]?.path, 'packages/adapters/src/github/adapter.ts');
});

/* -------------------------------------------------------------------------- */
/* F19-AC1: pushing                                                            */
/* -------------------------------------------------------------------------- */

test('F19-AC1 pushBranch publishes the exact ref with argv only, and confirms the remote head', async () => {
  const { adapter, stub, gitCalls } = adapterWith(
    {
      'GET /repos/:owner/:repo': () => ({ body: REPOSITORY_CAPTURE }),
      'GET /repos/:owner/:repo/git/ref/heads/task/gitad-a': (_request, callIndex) =>
        callIndex === 0 ? notFound() : { body: refCapture(BRANCH, FIXTURE_HEAD_SHA) },
    },
    (argv) => scriptedGit(argv),
  );
  const outcome = await okOf(
    adapter.pushBranch(adapterContext('op_push'), {
      operationId: operationId('op_push'),
      repository: REPOSITORY,
      branch: BRANCH,
      headSha: FIXTURE_HEAD_SHA,
      forceStrategy: 'RejectNonFastForward',
    }),
  );
  assert.equal(outcome.kind, 'Pushed');
  assert.equal(outcome.kind === 'Pushed' ? outcome.sha : null, FIXTURE_HEAD_SHA);
  assert.equal(outcome.kind === 'Pushed' ? outcome.remoteUrl : null, `${REPOSITORY.url}/tree/${BRANCH}`);
  const push = gitCalls.find((argv) => argv[0] === 'push');
  assert.deepEqual(push, ['push', '--porcelain', 'origin', `${FIXTURE_HEAD_SHA}:refs/heads/${BRANCH}`]);
  assert.equal(stub.countOf('POST', '/repos/egawilldoit/ShipLoop/git/refs'), 0, 'a commit the remote has never seen must be published by git, not by the API');
});

test('F30-AC2 a repeated push of a head the remote already holds is AlreadyPresent and writes nothing', async () => {
  const { adapter, gitCalls } = adapterWith({
    'GET /repos/:owner/:repo': () => ({ body: REPOSITORY_CAPTURE }),
    'GET /repos/:owner/:repo/git/ref/heads/task/gitad-a': () => ({ body: refCapture(BRANCH, FIXTURE_HEAD_SHA) }),
  });
  const outcome = await okOf(
    adapter.pushBranch(adapterContext('op_push_repeat'), {
      operationId: operationId('op_push_repeat'),
      repository: REPOSITORY,
      branch: BRANCH,
      headSha: FIXTURE_HEAD_SHA,
      forceStrategy: 'RejectNonFastForward',
    }),
  );
  assert.equal(outcome.kind, 'AlreadyPresent');
  assert.equal(gitCalls.filter((argv) => argv[0] === 'push').length, 0, 'a head the remote already holds must not be pushed again');
});

test('F30-AC2 ForceWithLease pins the remote ref read from the API, so a moved branch is refused', async () => {
  const { adapter, gitCalls } = adapterWith(
    {
      'GET /repos/:owner/:repo': () => ({ body: REPOSITORY_CAPTURE }),
      'GET /repos/:owner/:repo/git/ref/heads/task/gitad-a': (_request, callIndex): StubReply => ({
        body: refCapture(BRANCH, callIndex === 0 ? SUPERSEDED : FIXTURE_HEAD_SHA),
      }),
    },
    (argv) => scriptedGit(argv),
  );
  await okOf(
    adapter.pushBranch(adapterContext('op_lease'), {
      operationId: operationId('op_lease'),
      repository: REPOSITORY,
      branch: BRANCH,
      headSha: FIXTURE_HEAD_SHA,
      forceStrategy: 'ForceWithLease',
    }),
  );
  const push = gitCalls.find((argv) => argv[0] === 'push');
  assert.ok(push !== undefined);
  assert.ok(
    push.includes(`--force-with-lease=refs/heads/${BRANCH}:${SUPERSEDED}`),
    `expected the lease to pin the observed remote head, received ${JSON.stringify(push)}`,
  );
});

test('F30-AC2 a branch that has diverged is Conflict, and an unusable credential is not', async () => {
  const diverged = adapterWith(
    {
      'GET /repos/:owner/:repo': () => ({ body: REPOSITORY_CAPTURE }),
      'GET /repos/:owner/:repo/git/ref/heads/task/gitad-a': () => ({ body: refCapture(BRANCH, SUPERSEDED) }),
    },
    (argv) =>
      argv[0] === 'push'
        ? {
            exitCode: 1,
            stderr: ' ! [rejected]        HEAD -> task/gitad-a (non-fast-forward)\nerror: failed to push some refs',
          }
        : scriptedGit(argv),
  );
  const conflict = await errorOf(
    diverged.adapter.pushBranch(adapterContext('op_diverged'), {
      operationId: operationId('op_diverged'),
      repository: REPOSITORY,
      branch: BRANCH,
      headSha: FIXTURE_HEAD_SHA,
      forceStrategy: 'RejectNonFastForward',
    }),
  );
  assert.equal(conflict.code, 'Conflict');

  const refused = adapterWith(
    {
      'GET /repos/:owner/:repo': () => ({ body: REPOSITORY_CAPTURE }),
      'GET /repos/:owner/:repo/git/ref/heads/task/gitad-a': () => ({ body: refCapture(BRANCH, SUPERSEDED) }),
    },
    (argv) =>
      argv[0] === 'push'
        ? { exitCode: 128, stderr: 'git@github.com: Permission denied (publickey).' }
        : scriptedGit(argv),
  );
  const forbidden = await errorOf(
    refused.adapter.pushBranch(adapterContext('op_no_credential'), {
      operationId: operationId('op_no_credential'),
      repository: REPOSITORY,
      branch: BRANCH,
      headSha: FIXTURE_HEAD_SHA,
      forceStrategy: 'RejectNonFastForward',
    }),
  );
  assert.equal(forbidden.code, 'Forbidden', 'a rejected credential must not be reported as a diverged branch');
  assert.match(forbidden.reason, /Reauthorize the Git connector credential/);
});

test('F19-AC4 a push whose remote is a different repository is Blocked, and nothing is pushed', async () => {
  const { adapter, gitCalls } = adapterWith(
    {
      'GET /repos/:owner/:repo': () => ({ body: REPOSITORY_CAPTURE }),
      'GET /repos/:owner/:repo/git/ref/heads/task/gitad-a': () => notFound(),
    },
    (argv) =>
      argv[0] === 'rev-parse'
        ? { exitCode: 0, stdout: `${FIXTURE_HEAD_SHA}\n` }
        : argv[0] === 'remote'
          ? { exitCode: 0, stdout: 'git@github.com:someone-else/OtherRepo.git\n' }
          : { exitCode: 0, stdout: '' },
  );
  const error = await errorOf(
    adapter.pushBranch(adapterContext('op_wrong_remote'), {
      operationId: operationId('op_wrong_remote'),
      repository: REPOSITORY,
      branch: BRANCH,
      headSha: FIXTURE_HEAD_SHA,
      forceStrategy: 'RejectNonFastForward',
    }),
  );
  assert.equal(error.code, 'Blocked');
  assert.equal(error.code === 'Blocked' ? error.prerequisites[0]?.name : null, 'GitRemoteMismatch');
  assert.equal(gitCalls.filter((argv) => argv[0] === 'push').length, 0);
});

test('F19-AC4 a push of a commit the workspace does not hold is Blocked, and nothing is sent', async () => {
  const { adapter, gitCalls } = adapterWith(
    {
      'GET /repos/:owner/:repo': () => ({ body: REPOSITORY_CAPTURE }),
      'GET /repos/:owner/:repo/git/ref/heads/task/gitad-a': () => notFound(),
    },
    (argv) => (argv[0] === 'rev-parse' ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: '' }),
  );
  const error = await errorOf(
    adapter.pushBranch(adapterContext('op_absent_local'), {
      operationId: operationId('op_absent_local'),
      repository: REPOSITORY,
      branch: BRANCH,
      headSha: FIXTURE_HEAD_SHA,
      forceStrategy: 'RejectNonFastForward',
    }),
  );
  assert.equal(error.code, 'Blocked');
  assert.equal(error.code === 'Blocked' ? error.prerequisites[0]?.name : null, 'LocalCommitAbsent');
  assert.equal(gitCalls.filter((argv) => argv[0] === 'push').length, 0);
});

/* -------------------------------------------------------------------------- */
/* F19-AC1, F19-AC3: the draft, and the lost create                           */
/* -------------------------------------------------------------------------- */

test('F19-AC1 a create writes one draft, marks it a GitHub draft, and reports the provider identity', async () => {
  const { adapter, stub } = adapterWith({
    'GET /repos/:owner/:repo/pulls': () => ({ body: [] }),
    'GET /repos/:owner/:repo/commits/:sha/branches-where-head': () => ({ body: [{ name: BRANCH, commit: { sha: FIXTURE_HEAD_SHA } }] }),
    'POST /repos/:owner/:repo/pulls': (request) => {
      const sent = request.body ?? {};
      return {
        body: pullRequest({
          body: String(sent['body'] ?? ''),
          headSha: FIXTURE_HEAD_SHA,
        }),
      };
    },
  });
  const outcome = await okOf(
    adapter.upsertDraft(adapterContext('op_draft_create'), {
      operationId: operationId('op_draft_create'),
      repository: REPOSITORY,
      baseBranch: 'main',
      headSha: FIXTURE_HEAD_SHA,
      existingDraft: null,
      title: 'Preview the scoped change',
      body: FIXTURE_DRAFT_BODY,
      link: FIXTURE_DRAFT_BODY.linkedWork,
    }),
  );
  assert.equal(outcome.kind, 'Created');
  assert.equal(stub.countOf('GET', '/repos/egawilldoit/ShipLoop/pulls'), 1, 'the reconciliation read must happen before the create');
  assert.equal(stub.countOf('POST', '/repos/egawilldoit/ShipLoop/pulls'), 1);
  const sent = stub.bodiesFor('POST', '/repos/egawilldoit/ShipLoop/pulls')[0] ?? {};
  assert.equal(sent['draft'], true, 'a ShipLoop draft is a GitHub draft');
  assert.equal(sent['head'], BRANCH);
  assert.equal(sent['base'], 'main');
  assert.match(String(sent['body'] ?? ''), /<!--shiploop:managed:start-->/);
  assert.equal(outcome.kind === 'Created' ? outcome.draft.pullRequest.pullRequestId : null, PULL_ID);
  assert.equal(outcome.kind === 'Created' ? outcome.draft.pullRequest.draft : null, true);
  assert.equal(outcome.kind === 'Created' ? outcome.draft.baseBranch : null, 'main');
  assert.match(outcome.kind === 'Created' ? outcome.draft.managedMarker : '', /op_draft_create/);
});

test('F19-AC2 a rendered draft ticks a criterion only for a reported pass, and never for a not-run claim', () => {
  const rendered = draftBody(FIXTURE_DRAFT_BODY, null);
  assert.match(rendered, /- \[ \] \*\*AC1\*\*/);
  assert.match(rendered, /not run \(The provider reported no run for this criterion\.\)/);
  assert.doesNotMatch(rendered, /\[x\]/);
  const passed: DraftBody = {
    ...FIXTURE_DRAFT_BODY,
    criteria: [
      { criterionId: 'AC1', text: 'A criterion the provider actually ran.', claim: { kind: 'ReportedPassed', checkId: '110043771706' } },
      { criterionId: 'AC2', text: 'A criterion still running.', claim: { kind: 'ReportedPending', checkId: '110043771708' } },
    ],
  };
  const withPass = draftBody(passed, null);
  assert.match(withPass, /- \[x\] \*\*AC1\*\* .*reported passed by check 110043771706/);
  assert.match(withPass, /- \[ \] \*\*AC2\*\* .*still running on check 110043771708/);
});

test('F16-AC2 a managed update preserves the text a human wrote outside the managed region', () => {
  const existing = [
    'Owner note: this branch is for the delivery walkthrough.',
    '',
    '<!--shiploop:managed:start-->',
    '<!--shiploop:managed:v1 op=op_old -->',
    '### Purpose',
    '',
    'An older purpose.',
    '<!--shiploop:managed:end-->',
    '',
    'Footer added by a reviewer.',
  ].join('\n');
  const rendered = draftBody(FIXTURE_DRAFT_BODY, existing);
  assert.match(rendered, /Owner note: this branch is for the delivery walkthrough\./);
  assert.match(rendered, /Footer added by a reviewer\./);
  assert.doesNotMatch(rendered, /An older purpose\./);
  assert.equal(rendered.match(/<!--shiploop:managed:start-->/g)?.length, 1, 'a second managed region would be a second place ShipLoop owns');
});

test('F19-AC3 a lost create response is OutcomeUnknown, and the retry adopts the same pull request rather than creating a second', async () => {
  const operation = 'op_lost_create';
  let createdBody: string | null = null;
  const { adapter, stub } = adapterWith({
    'GET /repos/:owner/:repo/pulls': () => ({
      body: createdBody === null ? [] : [pullRequest({ body: createdBody, headSha: FIXTURE_HEAD_SHA })],
    }),
    'GET /repos/:owner/:repo/commits/:sha/branches-where-head': () => ({ body: [{ name: BRANCH, commit: { sha: FIXTURE_HEAD_SHA } }] }),
    'POST /repos/:owner/:repo/pulls': (request) => {
      // The pull request is created on GitHub and only then the connection drops, which is
      // the exact shape of a lost write response: the provider holds the draft, the caller
      // does not know it.
      createdBody = String((request.body ?? {})['body'] ?? '');
      return { body: {}, transportFailure: 'socket hang up after the request was sent' };
    },
    'GET /repos/:owner/:repo/pulls/7': () => ({
      body: pullRequest({ body: createdBody, headSha: FIXTURE_HEAD_SHA }),
    }),
  });
  const request = {
    operationId: operationId(operation),
    repository: REPOSITORY,
    baseBranch: 'main',
    headSha: FIXTURE_HEAD_SHA,
    existingDraft: null,
    title: 'Preview the scoped change',
    body: FIXTURE_DRAFT_BODY,
    link: FIXTURE_DRAFT_BODY.linkedWork,
  };

  const lost = await errorOf(adapter.upsertDraft(adapterContext(operation), request));
  assert.equal(lost.code, 'OutcomeUnknown', 'a lost write must never be reported as a failure');
  assert.equal(lost.code === 'OutcomeUnknown' ? lost.operationId : null, operation);
  assert.match(lost.code === 'OutcomeUnknown' ? lost.target : '', /Preview the scoped change|managed|op_lost_create/);
  assert.equal(stub.countOf('POST', '/repos/egawilldoit/ShipLoop/pulls'), 1);
  assert.ok(createdBody !== null, 'the fixture must have let GitHub hold the draft before the response was lost');

  const reconciled = await okOf(
    adapter.findDrafts(adapterContext(operation), {
      repository: REPOSITORY,
      headSha: FIXTURE_HEAD_SHA,
      link: FIXTURE_DRAFT_BODY.linkedWork,
      operationId: operationId(operation),
    }),
  );
  assert.equal(reconciled.length, 1, 'the lost write must be findable by its managed marker');
  assert.match(reconciled[0]?.managedMarker ?? '', new RegExp(operation));
  assert.equal(reconciled[0]?.pullRequest.pullRequestId, PULL_ID);
  assert.equal(stub.countOf('POST', '/repos/egawilldoit/ShipLoop/pulls'), 1, 'reconciliation must not repeat the write');

  const retry = await okOf(adapter.upsertDraft(adapterContext(operation), { ...request, existingDraft: null }));
  assert.equal(
    retry.kind,
    'RecoveredAfterLostResponse',
    'a retry that found the lost write must say it recovered rather than claiming a fresh create',
  );
  assert.equal(retry.draft.pullRequest.pullRequestId, PULL_ID, 'the recovered draft must be the one the lost create produced');
  assert.equal(
    stub.countOf('POST', '/repos/egawilldoit/ShipLoop/pulls'),
    1,
    'exactly one pull request may exist for one lost create, however many times it is retried',
  );
  assert.match(retry.detail, /without creating a second one|no second draft was created/);
});

test('F19-AC3 a retry whose recovered draft needs new content updates that draft and names the sections', async () => {
  const operation = 'op_retry_update';
  const staleBody = managedDraftBody(operation, FIXTURE_HEAD_SHA, 'stale-digest', '### Purpose\n\nAn older purpose.\n', LINK_KEY);
  const { adapter, stub } = adapterWith({
    'GET /repos/:owner/:repo/pulls': () => ({ body: [pullRequest({ body: staleBody, headSha: FIXTURE_HEAD_SHA })] }),
    'GET /repos/:owner/:repo/pulls/7': (_request, callIndex): StubReply => {
      if (callIndex === 0) {
        return { body: pullRequest({ body: staleBody, headSha: FIXTURE_HEAD_SHA }) };
      }
      const patch = stub.requests.filter((entry) => entry.method === 'PATCH').at(-1);
      const written = String(patch?.body?.['body'] ?? staleBody);
      return { body: pullRequest({ body: written, headSha: FIXTURE_HEAD_SHA }) };
    },
    'PATCH /repos/:owner/:repo/pulls/7': (request) => ({
      body: pullRequest({ body: String((request.body ?? {})['body'] ?? ''), headSha: FIXTURE_HEAD_SHA }),
    }),
  });
  const outcome = await okOf(
    adapter.upsertDraft(adapterContext(operation), {
      operationId: operationId(operation),
      repository: REPOSITORY,
      baseBranch: 'main',
      headSha: FIXTURE_HEAD_SHA,
      existingDraft: null,
      title: 'Preview the scoped change',
      body: FIXTURE_DRAFT_BODY,
      link: FIXTURE_DRAFT_BODY.linkedWork,
    }),
  );
  assert.equal(outcome.kind, 'RecoveredAfterLostResponse');
  assert.equal(stub.countOf('POST', '/repos/egawilldoit/ShipLoop/pulls'), 0, 'the adapter found the draft, so it must not create another');
  assert.equal(stub.countOf('PATCH', '/repos/egawilldoit/ShipLoop/pulls/7'), 1, 'the recovered draft is the one that gets updated');
  assert.ok(outcome.kind === 'RecoveredAfterLostResponse' && outcome.detail.includes('purpose'));
});

test('F30-AC2 a repeated write with the same operation identity leaves the managed content unchanged', async () => {
  const operation = 'op_repeat';
  let body: string | null = null;
  const { adapter, stub } = adapterWith({
    'GET /repos/:owner/:repo/pulls': (): StubReply => ({
      body: body === null ? [] : [pullRequest({ body, headSha: FIXTURE_HEAD_SHA })],
    }),
    'GET /repos/:owner/:repo/commits/:sha/branches-where-head': () => ({ body: [{ name: BRANCH, commit: { sha: FIXTURE_HEAD_SHA } }] }),
    'POST /repos/:owner/:repo/pulls': (request) => {
      body = String((request.body ?? {})['body'] ?? '');
      return { body: pullRequest({ body, headSha: FIXTURE_HEAD_SHA }) };
    },
    'GET /repos/:owner/:repo/pulls/7': () => ({ body: pullRequest({ body, headSha: FIXTURE_HEAD_SHA }) }),
  });
  const request = {
    operationId: operationId(operation),
    repository: REPOSITORY,
    baseBranch: 'main',
    headSha: FIXTURE_HEAD_SHA,
    existingDraft: null,
    title: 'Preview the scoped change',
    body: FIXTURE_DRAFT_BODY,
    link: FIXTURE_DRAFT_BODY.linkedWork,
  };
  const first = await okOf(adapter.upsertDraft(adapterContext(operation), request));
  assert.equal(first.kind, 'Created');
  const repeated = await okOf(adapter.upsertDraft(adapterContext(operation), request));
  assert.equal(repeated.kind, 'RecoveredAfterLostResponse', 'the repeat found its own draft instead of creating another');
  assert.equal(stub.countOf('POST', '/repos/egawilldoit/ShipLoop/pulls'), 1, 'one operation identity produces one draft');
  assert.equal(stub.countOf('PATCH', '/repos/egawilldoit/ShipLoop/pulls/7'), 0, 'unchanged content must not be rewritten');
  assert.equal(repeated.draft.pullRequest.pullRequestId, first.draft.pullRequest.pullRequestId);
});

test('F28-AC4 a create the provider accepts but whose payload cannot be read is OutcomeUnknown, not a success', async () => {
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo/pulls': () => ({ body: [] }),
    'GET /repos/:owner/:repo/commits/:sha/branches-where-head': () => ({ body: [{ name: BRANCH, commit: { sha: FIXTURE_HEAD_SHA } }] }),
    'POST /repos/:owner/:repo/pulls': () => ({ body: { message: 'Created but unreadable' } }),
  });
  const error = await errorOf(
    adapter.upsertDraft(adapterContext('op_unreadable_create'), {
      operationId: operationId('op_unreadable_create'),
      repository: REPOSITORY,
      baseBranch: 'main',
      headSha: FIXTURE_HEAD_SHA,
      existingDraft: null,
      title: 'Preview the scoped change',
      body: FIXTURE_DRAFT_BODY,
      link: FIXTURE_DRAFT_BODY.linkedWork,
    }),
  );
  assert.equal(error.code, 'OutcomeUnknown');
  assert.match(error.code === 'OutcomeUnknown' ? error.reason : '', /Read the open pull requests/);
});

test('F16-AC3 an append-only managed region is refused rather than duplicated on every delivery', async () => {
  const { adapter } = adapterWith({ 'GET /repos/:owner/:repo/pulls': () => ({ body: [] }) });
  const error = await errorOf(
    adapter.upsertDraft(adapterContext('op_append'), {
      operationId: operationId('op_append'),
      repository: REPOSITORY,
      baseBranch: 'main',
      headSha: FIXTURE_HEAD_SHA,
      existingDraft: null,
      title: 'Preview the scoped change',
      body: { ...FIXTURE_DRAFT_BODY, managedProgressRegion: { kind: 'AppendOnlyCommentThread', lastCommentId: null } },
      link: FIXTURE_DRAFT_BODY.linkedWork,
    }),
  );
  assert.equal(error.code, 'Unavailable');
  assert.match(error.reason, /duplicated|F16-AC3/);
});

test('N02-AC1 a commit that is no longer any branch head cannot open a draft, and is reported', async () => {
  const { adapter, stub } = adapterWith({
    'GET /repos/:owner/:repo/pulls': () => ({ body: [] }),
    'GET /repos/:owner/:repo/commits/:sha/branches-where-head': () => ({ body: [] }),
  });
  const error = await errorOf(
    adapter.upsertDraft(adapterContext('op_headless'), {
      operationId: operationId('op_headless'),
      repository: REPOSITORY,
      baseBranch: 'main',
      headSha: FIXTURE_HEAD_SHA,
      existingDraft: null,
      title: 'Preview the scoped change',
      body: FIXTURE_DRAFT_BODY,
      link: FIXTURE_DRAFT_BODY.linkedWork,
    }),
  );
  assert.equal(error.code, 'Invalid');
  assert.equal(stub.countOf('POST', '/repos/egawilldoit/ShipLoop/pulls'), 0);
});

/* -------------------------------------------------------------------------- */
/* F19-AC5: the no-code outcome                                                */
/* -------------------------------------------------------------------------- */

test('F19-AC5 a read-only job states a no-code outcome, creates no draft and performs no write', async () => {
  const { adapter, stub } = adapterWith({
    'GET /repos/:owner/:repo/git/ref/heads/task/gitad-a': () => notFound(),
    'GET /repos/:owner/:repo/pulls': () => ({ body: [] }),
  });
  const declared = await okOf(
    adapter.declareNoCodeOutcome(adapterContext('op_no_code'), {
      operationId: operationId('op_no_code'),
      repository: REPOSITORY,
      branch: BRANCH,
      reason: 'ReadOnlyJob',
      evidence: [FIXTURE_RUN_NOTES_ARTIFACT],
      declaredAt: FIXED_INSTANT,
    }),
  );
  assert.equal(declared.reason, 'ReadOnlyJob');
  assert.equal(declared.branchState, 'NeverPushed');
  assert.equal(declared.pullRequest, null, 'a no-code outcome cannot carry a pull request');
  assert.equal(declared.evidence.length, 1);
  assert.ok(declared.evidence.every((entry) => entry.sanitized));
  assert.equal(
    stub.requests.filter((request) => request.method !== 'GET').length,
    0,
    'a job that produced no code change must perform no write',
  );
  const drafts = await okOf(
    adapter.findDrafts(adapterContext('op_no_code'), {
      repository: REPOSITORY,
      headSha: FIXTURE_HEAD_SHA,
      link: FIXTURE_DRAFT_BODY.linkedWork,
      operationId: operationId('op_no_code'),
    }),
  );
  assert.equal(drafts.length, 0);
});

test('F19-AC5 a branch that exists without a draft is reported as pushed, not as never pushed', async () => {
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo/git/ref/heads/task/gitad-a': () => ({ body: refCapture(BRANCH, FIXTURE_HEAD_SHA) }),
  });
  const declared = await okOf(
    adapter.declareNoCodeOutcome(adapterContext('op_pushed_no_draft'), {
      operationId: operationId('op_pushed_no_draft'),
      repository: REPOSITORY,
      branch: BRANCH,
      reason: 'NoChangeRequired',
      evidence: [],
      declaredAt: FIXED_INSTANT,
    }),
  );
  assert.equal(declared.branchState, 'PushedWithoutDraft');
  assert.equal(declared.pullRequest, null);
});

/* -------------------------------------------------------------------------- */
/* F26-AC3, F26-AC4: the merge                                                 */
/* -------------------------------------------------------------------------- */

test('F26-AC3 the merge pins the provider head precondition and verifies the result by reading back', async () => {
  let merged = false;
  const { adapter, stub } = adapterWith({
    'GET /repos/:owner/:repo/pulls/7': () =>
      merged
        ? { body: pullRequest({ body: null, headSha: FIXTURE_HEAD_SHA, merged: true, mergeCommitSha: MERGE_COMMIT, mergedAt: '2026-10-01T09:00:00Z', state: 'closed', draft: false }) }
        : { body: pullRequest({ body: null, headSha: FIXTURE_HEAD_SHA, draft: false }) },
    'PUT /repos/:owner/:repo/pulls/7/merge': () => {
      merged = true;
      return { body: { sha: MERGE_COMMIT, merged: true, message: 'Pull Request successfully merged' } };
    },
  });
  const outcome = await okOf(
    adapter.mergePullRequest(adapterContext('op_merge'), {
      operationId: operationId('op_merge'),
      authorizationId: 'authorization_fixture_01',
      repository: REPOSITORY,
      pullRequestId: providerId(PULL_ID),
      expectedHeadSha: FIXTURE_HEAD_SHA,
      targetBranch: 'main',
      method: 'Squash',
      precondition: { kind: 'ProviderExpectedHead', expectedHeadSha: FIXTURE_HEAD_SHA },
    }),
  );
  assert.equal(outcome.kind, 'Merged');
  assert.equal(outcome.kind === 'Merged' ? outcome.mergeCommitSha : null, MERGE_COMMIT);
  assert.equal(outcome.kind === 'Merged' ? outcome.headSha : null, FIXTURE_HEAD_SHA);
  assert.equal(outcome.kind === 'Merged' ? outcome.contentRelation.kind : null, 'MatchesAuthorizedHead');
  const sent = stub.bodiesFor('PUT', '/repos/egawilldoit/ShipLoop/pulls/7/merge')[0] ?? {};
  assert.equal(sent['sha'], FIXTURE_HEAD_SHA, 'the pinned head is what GitHub compares, so it must be sent');
  assert.equal(sent['merge_method'], 'squash');
});

test('F26-AC3 a head precondition GitHub refuses is Conflict, and nothing is merged', async () => {
  const { adapter, stub } = adapterWith({
    'GET /repos/:owner/:repo/pulls/7': () => ({ body: pullRequest({ body: null, headSha: FIXTURE_HEAD_SHA, draft: false }) }),
    'PUT /repos/:owner/:repo/pulls/7/merge': () => ({
      status: 409,
      body: { message: 'Head branch was modified. Review and try the merge again.', documentation_url: 'https://docs.github.com/rest/pulls/pulls#merge-a-pull-request', status: '409' },
    }),
  });
  const error = await errorOf(
    adapter.mergePullRequest(adapterContext('op_merge_stale'), {
      operationId: operationId('op_merge_stale'),
      authorizationId: 'authorization_fixture_01',
      repository: REPOSITORY,
      pullRequestId: providerId(PULL_ID),
      expectedHeadSha: SUPERSEDED,
      targetBranch: 'main',
      method: 'Squash',
      precondition: { kind: 'ProviderExpectedHead', expectedHeadSha: SUPERSEDED },
    }),
  );
  assert.equal(error.code, 'Conflict', 'a failed head precondition must be Conflict, never a generic failure');
  assert.match(error.code === 'Conflict' ? error.reason : '', /Head branch was modified/);
  assert.equal(stub.countOf('PUT', '/repos/egawilldoit/ShipLoop/pulls/7/merge'), 1, 'the refused merge was attempted once and not retried');
});

test('F26-AC3 a merge refused because the pull request cannot be merged is Blocked with a remedy, not Unavailable', async () => {
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo/pulls/7': () => ({ body: pullRequest({ body: null, headSha: FIXTURE_HEAD_SHA, draft: false }) }),
    'PUT /repos/:owner/:repo/pulls/7/merge': () => ({
      status: 405,
      body: { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest/pulls/pulls#merge-a-pull-request', status: '405' },
    }),
  });
  const error = await errorOf(
    adapter.mergePullRequest(adapterContext('op_merge_405'), {
      operationId: operationId('op_merge_405'),
      authorizationId: 'authorization_fixture_01',
      repository: REPOSITORY,
      pullRequestId: providerId(PULL_ID),
      expectedHeadSha: FIXTURE_HEAD_SHA,
      targetBranch: 'main',
      method: 'Merge',
      precondition: { kind: 'ProviderExpectedHead', expectedHeadSha: FIXTURE_HEAD_SHA },
    }),
  );
  assert.equal(error.code, 'Blocked');
  assert.equal(error.code === 'Blocked' ? error.prerequisites[0]?.name : null, 'PullRequestNotMergeable');
});

test('F26-AC3 a draft is refused a merge as Blocked before any merge request is sent', async () => {
  const { adapter, stub } = adapterWith({
    'GET /repos/:owner/:repo/pulls/7': () => ({ body: pullRequest({ body: null, headSha: FIXTURE_HEAD_SHA, draft: true }) }),
  });
  const error = await errorOf(
    adapter.mergePullRequest(adapterContext('op_merge_draft'), {
      operationId: operationId('op_merge_draft'),
      authorizationId: 'authorization_fixture_01',
      repository: REPOSITORY,
      pullRequestId: providerId(PULL_ID),
      expectedHeadSha: FIXTURE_HEAD_SHA,
      targetBranch: 'main',
      method: 'Squash',
      precondition: { kind: 'ProviderExpectedHead', expectedHeadSha: FIXTURE_HEAD_SHA },
    }),
  );
  assert.equal(error.code, 'Blocked');
  assert.equal(error.code === 'Blocked' ? error.prerequisites[0]?.name : null, 'DraftPullRequest');
  assert.equal(stub.countOf('PUT', '/repos/egawilldoit/ShipLoop/pulls/7/merge'), 0);
});

test('F26-AC3 a caller that declines the provider precondition is Unavailable, and nothing is merged', async () => {
  const { adapter, stub } = adapterWith({
    'GET /repos/:owner/:repo/pulls/7': () => ({ body: pullRequest({ body: null, headSha: FIXTURE_HEAD_SHA, draft: false }) }),
  });
  const error = await errorOf(
    adapter.mergePullRequest(adapterContext('op_merge_no_precondition'), {
      operationId: operationId('op_merge_no_precondition'),
      authorizationId: 'authorization_fixture_01',
      repository: REPOSITORY,
      pullRequestId: providerId(PULL_ID),
      expectedHeadSha: FIXTURE_HEAD_SHA,
      targetBranch: 'main',
      method: 'Squash',
      precondition: {
        kind: 'NoProviderPrecondition',
        recheckedAt: FIXED_INSTANT,
        raceLimitation: 'the caller accepted a race between the read and the write',
        ownerAcceptedRace: true,
      },
    }),
  );
  assert.equal(error.code, 'Unavailable');
  assert.match(error.reason, /will not proceed without it/);
  assert.equal(stub.countOf('PUT', '/repos/egawilldoit/ShipLoop/pulls/7/merge'), 0, 'a merge without the provider precondition must not be sent');
});

test('F28-AC4 a lost merge response is OutcomeUnknown, and the read before the merge reports AlreadyMerged', async () => {
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo/pulls/7': (_request, callIndex) =>
      callIndex === 0
        ? { body: pullRequest({ body: null, headSha: FIXTURE_HEAD_SHA, draft: false }) }
        : { body: pullRequest({ body: null, headSha: FIXTURE_HEAD_SHA, merged: true, mergeCommitSha: MERGE_COMMIT, mergedAt: '2026-10-01T09:00:00Z', state: 'closed', draft: false }) },
    'PUT /repos/:owner/:repo/pulls/7/merge': () => ({ body: {}, transportFailure: 'connection reset while awaiting the merge response' }),
  });
  const request = {
    operationId: operationId('op_merge_lost'),
    authorizationId: 'authorization_fixture_01',
    repository: REPOSITORY,
    pullRequestId: providerId(PULL_ID),
    expectedHeadSha: FIXTURE_HEAD_SHA,
    targetBranch: 'main',
    method: 'Squash' as const,
    precondition: { kind: 'ProviderExpectedHead' as const, expectedHeadSha: FIXTURE_HEAD_SHA },
  };
  const lost = await errorOf(adapter.mergePullRequest(adapterContext('op_merge_lost'), request));
  assert.equal(lost.code, 'OutcomeUnknown', 'a lost merge response must be distinguishable from a failed merge');
  assert.equal(lost.code === 'OutcomeUnknown' ? lost.operationId : null, 'op_merge_lost');
  assert.match(lost.code === 'OutcomeUnknown' ? lost.target : '', /#7/);
  const reconciled = await okOf(adapter.mergePullRequest(adapterContext('op_merge_lost'), request));
  assert.equal(reconciled.kind, 'AlreadyMerged');
  assert.equal(reconciled.kind === 'AlreadyMerged' ? reconciled.mergeCommitSha : null, MERGE_COMMIT);
});

test('F26-AC4 a merge whose content is not the authorized head says so and names both SHAs', async () => {
  let merged = false;
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo/pulls/7': () =>
      merged
        ? { body: pullRequest({ body: null, headSha: SUPERSEDED, merged: true, mergeCommitSha: MERGE_COMMIT, mergedAt: '2026-10-01T09:05:00Z', state: 'closed', draft: false }) }
        : { body: pullRequest({ body: null, headSha: SUPERSEDED, draft: false }) },
    'PUT /repos/:owner/:repo/pulls/7/merge': () => {
      merged = true;
      return { body: { sha: MERGE_COMMIT, merged: true, message: 'Pull Request successfully merged' } };
    },
  });
  const outcome = await okOf(
    adapter.mergePullRequest(adapterContext('op_merge_moved'), {
      operationId: operationId('op_merge_moved'),
      authorizationId: 'authorization_fixture_01',
      repository: REPOSITORY,
      pullRequestId: providerId(PULL_ID),
      expectedHeadSha: FIXTURE_HEAD_SHA,
      targetBranch: 'main',
      method: 'Squash',
      precondition: { kind: 'ProviderExpectedHead', expectedHeadSha: SUPERSEDED },
    }),
  );
  assert.equal(outcome.kind, 'Merged');
  assert.equal(outcome.kind === 'Merged' ? outcome.contentRelation.kind : null, 'DiffersFromAuthorizedHead');
  assert.match(
    outcome.kind === 'Merged' && outcome.contentRelation.kind === 'DiffersFromAuthorizedHead' ? outcome.contentRelation.detail : '',
    new RegExp(FIXTURE_HEAD_SHA.slice(0, 12)),
  );
  assert.match(
    outcome.kind === 'Merged' && outcome.contentRelation.kind === 'DiffersFromAuthorizedHead' ? outcome.contentRelation.detail : '',
    new RegExp(SUPERSEDED.slice(0, 12)),
  );
});

test('F26-AC3 a merge the provider accepted but that reads back unconfirmed is OutcomeUnknown, not Merged', async () => {
  const { adapter } = adapterWith({
    'GET /repos/:owner/:repo/pulls/7': () => ({ body: pullRequest({ body: null, headSha: FIXTURE_HEAD_SHA, draft: false }) }),
    'PUT /repos/:owner/:repo/pulls/7/merge': () => ({ body: { sha: MERGE_COMMIT, merged: true, message: 'Pull Request successfully merged' } }),
  });
  const error = await errorOf(
    adapter.mergePullRequest(adapterContext('op_merge_unconfirmed'), {
      operationId: operationId('op_merge_unconfirmed'),
      authorizationId: 'authorization_fixture_01',
      repository: REPOSITORY,
      pullRequestId: providerId(PULL_ID),
      expectedHeadSha: FIXTURE_HEAD_SHA,
      targetBranch: 'main',
      method: 'Squash',
      precondition: { kind: 'ProviderExpectedHead', expectedHeadSha: FIXTURE_HEAD_SHA },
    }),
  );
  assert.equal(error.code, 'OutcomeUnknown');
  assert.match(error.code === 'OutcomeUnknown' ? error.reason : '', /unknown/);
});

/* -------------------------------------------------------------------------- */
/* Marker round trip                                                           */
/* -------------------------------------------------------------------------- */

test('F19-AC3 the managed marker round trips the operation identity, head, link and digest', () => {
  const body = managedDraftBody('op_marker', FIXTURE_HEAD_SHA, 'abc123', MANAGED_CONTENT, LINK_KEY);
  const marker = parseManagedMarker(body);
  assert.equal(marker?.operationId, 'op_marker');
  assert.equal(marker?.headSha, FIXTURE_HEAD_SHA);
  assert.equal(marker?.baseBranch, 'main');
  assert.equal(marker?.digest, 'abc123');
  assert.equal(marker?.link, LINK_KEY);
  assert.match(markerLineOf(body), /op=op_marker/);
  assert.equal(parseManagedMarker('a body with no marker'), null, 'a body with no marker carries no operation identity to reconcile on');
  assert.equal(markerLineOf('a body with no marker'), '');
});

/* -------------------------------------------------------------------------- */
/* N05-AC2: the opt-in live pass, read-only                                    */
/* -------------------------------------------------------------------------- */

/**
 * A live read-only pass over the owner's own repository.
 *
 * Read-only by construction: it reads the repository, a ref, check runs, a commit range and
 * the pull request list, and nothing else. It is skipped unless `SHIPLOOP_GITHUB_TOKEN` and
 * `SHIPLOOP_GITHUB_LIVE_REPOSITORY` are both set, and the skip names what is missing, so a
 * skipped test is visibly a missing prerequisite rather than a pass.
 */
test('N05-AC2 a live read-only pass reads identity, refs, checks, a range and the pull request list', async (t) => {
  const token = process.env['SHIPLOOP_GITHUB_TOKEN'];
  if (token === undefined || token.length === 0) {
    t.skip('no SHIPLOOP_GITHUB_TOKEN in the environment; the live pass needs a real credential');
    return;
  }
  const fullName = process.env['SHIPLOOP_GITHUB_LIVE_REPOSITORY'];
  if (fullName === undefined || fullName.length === 0) {
    t.skip('no SHIPLOOP_GITHUB_LIVE_REPOSITORY; name a repository as owner/name to read');
    return;
  }

  const repository: GitRepositoryRef = {
    provider: 'github',
    fullName,
    defaultBranch: '',
    url: `https://github.com/${fullName}`,
  };
  const adapter = new GitHubGitAdapter({
    connectorId: connectorId('connector_github_live'),
    client: { token },
    git: {
      workingDirectory: process.cwd(),
      run: () => Promise.resolve({ ok: false, error: { code: 'Unavailable', reason: 'The live pass is read-only and runs no git command.' } }),
    },
  });
  const context: AdapterContext = { ...adapterContext('op_github_live'), signal: AbortSignal.timeout(30_000) };

  const compatibility = await okOf(adapter.checkCompatibility(context, repository));
  assert.equal(compatibility.compatible, true);
  assert.equal(compatibility.runtimeVersion, '2022-11-28');

  const state = await okOf(
    adapter.readState(context, { repository, branch: 'main', baseBranch: 'main' }),
  );
  assert.match(state.repository.fullName, /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
  assert.equal(state.base.kind, 'Branch', 'a live default branch exists on the repository the owner configured');
  assert.equal(state.base.kind === 'Branch' ? state.base.sha.length : 0, 40, 'a live base SHA is a full 40 character SHA');
  assert.equal(state.observedAt, FIXED_INSTANT);

  const checks = await okOf(
    adapter.readChecks(context, {
      repository,
      headSha: state.base.kind === 'Branch' ? state.base.sha : FIXTURE_BASE_SHA,
      baseSha: state.base.kind === 'Branch' ? state.base.sha : FIXTURE_BASE_SHA,
      candidateFingerprint: FIXTURE_CANDIDATE_FINGERPRINT,
      requiredCheckNames: ['pnpm verify:app'],
    }),
  );
  for (const observation of checks) {
    assert.ok(CHECK_RESULTS.includes(observation.result), `unexpected result ${observation.result}`);
    assert.ok(observation.name.length > 0);
  }
  assert.ok(
    !checks.some((observation) => observation.name === 'pnpm verify:app' && observation.result === 'Passed'),
    'a check the live repository never ran must not be reported as a pass',
  );

  const range = await okOf(
    adapter.readCommitRange(context, {
      repository,
      baseSha: state.base.kind === 'Branch' ? state.base.sha : FIXTURE_BASE_SHA,
      headSha: state.base.kind === 'Branch' ? state.base.sha : FIXTURE_BASE_SHA,
    }),
  );
  assert.equal(range.totalCommits, 0, 'comparing a commit with itself reports no commits');

  const drafts = await okOf(
    adapter.findDrafts(context, {
      repository,
      headSha: state.base.kind === 'Branch' ? state.base.sha : FIXTURE_BASE_SHA,
      link: { kind: 'None', reason: 'the live pass names no linked work' },
      operationId: operationId('op_github_live'),
    }),
  );
  assert.ok(Array.isArray(drafts));
});
