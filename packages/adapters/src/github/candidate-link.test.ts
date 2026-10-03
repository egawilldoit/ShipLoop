/**
 * The GitHub read the MVP candidate journey performs, against a scripted REST surface.
 *
 * Only HTTP and `git` are scripted. Every assertion travels through the shipped
 * `GitHubClient`, the shipped error mapping and the shipped payload readers, so a payload
 * shape GitHub does not produce cannot pass here.
 *
 * What these cases establish, and why each is a separate failure mode:
 *
 *   - a pull request is read by its display number from the *configured* repository, and
 *     the head and base commit SHAs come back full and unchanged. Truncating either would
 *     make candidate identity a prefix, which is the failure the whole design exists to
 *     prevent;
 *   - a repository this provider does not own is refused before any request is made;
 *   - a pull request GitHub does not have is `NotFound`, and a repository the credential
 *     cannot read is *not* reported as a missing pull request — those two are different
 *     facts and an owner needs to see them differently;
 *   - a payload whose head SHA is abbreviated is refused as unreadable rather than carried
 *     forward as an identity;
 *   - the state GitHub reports distinguishes merged from closed, and a state the adapter
 *     does not recognise becomes `Closed` rather than `Open`;
 *   - the read-only port exposes exactly the two reads, while the shipped adapter still
 *     holds its write methods — the guarantee is about reachability, not about the
 *     underlying object having no writes;
 *   - check mapping keeps skipped, unknown and absent results away from `Passed`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CommitSha, DomainError } from '@shiploop/domain';

import {
  FIXED_INSTANT,
  FIXTURE_BASE_SHA,
  FIXTURE_CANDIDATE_FINGERPRINT,
  FIXTURE_FOREIGN_REPOSITORY,
  FIXTURE_HEAD_SHA,
  FIXTURE_REPOSITORY,
  FIXTURE_SUPERSEDED_HEAD_SHA,
  adapterContext,
  connectorId,
} from '../testing/fixtures.ts';
import { createFakeAdapterSet } from '../testing/fake.ts';
import type { FakeLinkedPullRequest } from '../testing/fake.ts';
import type { AdapterContext, GitRepositoryRef, ProviderCheckObservation } from '../contracts/index.ts';
import { CANDIDATE_PORT_MEMBERS, readOnlyCandidateGit } from '../contracts/candidate-link.ts';
import { GitHubGitAdapter } from './adapter.ts';
import { githubCandidatePort } from './candidate-link.ts';
import type { GitTransport } from './client.ts';

/* -------------------------------------------------------------------------- */
/* Scripted REST surface                                                       */
/* -------------------------------------------------------------------------- */

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
}

/**
 * A scripted GitHub REST endpoint.
 *
 * Test support rather than a fake adapter: it speaks only HTTP and the paths the shipped
 * client builds. A path with no responder answers 500 with a loud message, so a case can
 * never pass because the adapter skipped the call it was supposed to make.
 */
class StubGitHub {
  readonly requests: RecordedRequest[] = [];
  readonly fetch: typeof fetch;
  private readonly replies: Readonly<Record<string, { status: number; body: unknown }>>;

  constructor(replies: Readonly<Record<string, { status: number; body: unknown }>>) {
    this.replies = replies;
    this.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      const method = (input === null ? 'GET' : 'GET').toUpperCase();
      this.requests.push({ method, path: url.pathname });
      const key = `${method} ${url.pathname}`;
      const reply = this.replies[key];
      if (reply === undefined) {
        return new Response(
          JSON.stringify({ message: `stub has no responder for ${key}`, documentation_url: '', status: 500 }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json', 'x-github-api-version-selected': '2022-11-28' },
      });
    };
  }

  /** Every method+path pair requested, so a test can assert nothing was written. */
  get verbs(): readonly string[] {
    return this.requests.map((request) => `${request.method} ${request.path}`);
  }
}

const NO_GIT_CALLS = (_argv: readonly string[]) => ({ exitCode: 0, stdout: '', stderr: '' });

function stubGit(): GitTransport {
  return {
    workingDirectory: '/srv/shiploop/workspaces/workspace_candidate_01',
    run(_context: AdapterContext, _argv: readonly string[]) {
      return Promise.resolve({ ok: true as const, value: NO_GIT_CALLS(_argv) });
    },
  };
}

function adapterFor(replies: Readonly<Record<string, { status: number; body: unknown }>>): {
  readonly adapter: GitHubGitAdapter;
  readonly stub: StubGitHub;
} {
  const stub = new StubGitHub(replies);
  return {
    adapter: new GitHubGitAdapter({
      connectorId: connectorId('connector_github_candidate'),
      client: { token: 'stub-token-not-a-credential', fetchImpl: stub.fetch },
      git: stubGit(),
    }),
    stub,
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
  if (result.ok) assert.fail('expected a refusal, but the call succeeded');
  return result.error;
}

/* -------------------------------------------------------------------------- */
/* Payloads                                                                    */
/* -------------------------------------------------------------------------- */

const REPOSITORY: GitRepositoryRef = {
  provider: 'github',
  fullName: 'egawilldoit/ShipLoop',
  defaultBranch: 'main',
  url: 'https://github.com/egawilldoit/ShipLoop',
};

const PULL_PATH = '/repos/egawilldoit/ShipLoop/pulls/7';

/** The live capture shape of `GET /repos/egawilldoit/ShipLoop` on 1 October 2026. */
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

/**
 * A pull request in the shape GitHub returns. Constructed, not captured: no pull request
 * was created on the live repository. `head.repo.full_name` is included because it is what
 * distinguishes a fork's pull request from the project's own.
 */
function pullRequestCapture(options: {
  readonly headSha?: string;
  readonly headRepository?: string | null;
  readonly state?: string;
  readonly merged?: boolean;
  readonly mergeCommitSha?: string | null;
  readonly mergedAt?: string | null;
  readonly baseRef?: string;
  readonly draft?: boolean;
} = {}): Record<string, unknown> {
  return {
    id: 2722333444,
    node_id: 'PR_kwDOExample',
    number: 7,
    html_url: 'https://github.com/egawilldoit/ShipLoop/pull/7',
    state: options.state ?? 'open',
    draft: options.draft ?? false,
    merged: options.merged ?? false,
    merged_at: options.mergedAt ?? null,
    merge_commit_sha: options.mergeCommitSha ?? null,
    title: 'Candidate under review',
    body: null,
    user: { login: 'example-owner' },
    head: {
      ref: 'task/mvp-candidate',
      sha: options.headSha ?? FIXTURE_HEAD_SHA,
      repo: options.headRepository === null ? null : { full_name: options.headRepository ?? 'egawilldoit/ShipLoop' },
    },
    base: {
      ref: options.baseRef ?? 'main',
      sha: FIXTURE_BASE_SHA,
      repo: { full_name: 'egawilldoit/ShipLoop' },
    },
  };
}

const NOT_FOUND = {
  status: 404,
  body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest/pulls/pulls#get-a-pull-request', status: '404' },
};

/* -------------------------------------------------------------------------- */
/* Reading a linked pull request                                               */
/* -------------------------------------------------------------------------- */

test('a linked pull request is read by number and both commit SHAs come back full and unchanged', async () => {
  const { adapter, stub } = adapterFor({
    'GET /repos/egawilldoit/ShipLoop': { status: 200, body: REPOSITORY_CAPTURE },
    [`GET ${PULL_PATH}`]: { status: 200, body: pullRequestCapture() },
  });

  const facts = await okOf(
    adapter.readLinkedPullRequest(adapterContext('op_link_01'), {
      repository: REPOSITORY,
      pullRequestNumber: 7,
    }),
  );

  assert.equal(facts.repository.fullName, 'egawilldoit/ShipLoop');
  assert.equal(facts.number, 7);
  assert.equal(facts.url, 'https://github.com/egawilldoit/ShipLoop/pull/7');
  assert.equal(facts.headSha, FIXTURE_HEAD_SHA);
  assert.equal(facts.baseSha, FIXTURE_BASE_SHA);
  assert.equal(facts.headSha.length, 40);
  assert.equal(facts.baseSha.length, 40);
  assert.equal(facts.headBranch, 'task/mvp-candidate');
  assert.equal(facts.baseBranch, 'main');
  assert.equal(facts.state, 'Open');
  assert.equal(facts.draft, false);
  assert.equal(facts.headRepository, 'egawilldoit/ShipLoop');
  assert.equal(facts.observedAt, FIXED_INSTANT);
  assert.equal(facts.providerPullRequestId, '7');

  // The read is a GET of the repository and a GET of the pull request, in that order, and
  // nothing else. A candidate link must never be able to reach a write verb.
  assert.deepEqual(stub.verbs, ['GET /repos/egawilldoit/ShipLoop', `GET ${PULL_PATH}`]);
});

test('a repository at another provider is refused before any request is made', async () => {
  const { adapter, stub } = adapterFor({});
  const error = await errorOf(
    adapter.readLinkedPullRequest(adapterContext('op_foreign'), {
      repository: { ...REPOSITORY, provider: 'gitlab', fullName: 'egawilldoit/ShipLoop' },
      pullRequestNumber: 7,
    }),
  );
  assert.equal(error.code, 'Forbidden');
  assert.match(error.reason, /gitlab/);
  assert.deepEqual(stub.verbs, [], 'a foreign provider must not produce a provider call');
});

test('a repository name that is not owner/repository is refused rather than turned into a path', async () => {
  const { adapter, stub } = adapterFor({});
  for (const fullName of ['ShipLoop', 'a/b/c', '../../etc/passwd']) {
    const error = await errorOf(
      adapter.readLinkedPullRequest(adapterContext('op_bad_repo'), {
        repository: { ...REPOSITORY, fullName },
        pullRequestNumber: 7,
      }),
    );
    assert.equal(error.code, 'Invalid', `${fullName} must be refused as a repository name`);
  }
  assert.deepEqual(stub.verbs, []);
});

test('a number that is not a positive pull request number is refused', async () => {
  const { adapter, stub } = adapterFor({});
  for (const pullRequestNumber of [0, -1, 1.5]) {
    const error = await errorOf(
      adapter.readLinkedPullRequest(adapterContext('op_bad_number'), { repository: REPOSITORY, pullRequestNumber }),
    );
    assert.equal(error.code, 'Invalid');
    assert.equal(error.code === 'Invalid' ? error.fields[0]?.path : null, 'pullRequestNumber');
    // The refusal has to say why a number is not enough, because a number is exactly what
    // a well-meaning owner pastes when the address is incomplete.
    assert.match(error.code === 'Invalid' ? (error.fields[0]?.message ?? '') : '', /not candidate identity/);
  }
  assert.deepEqual(stub.verbs, []);
});

test('a pull request GitHub does not have is NotFound, and names the operation that failed', async () => {
  const { adapter } = adapterFor({
    'GET /repos/egawilldoit/ShipLoop': { status: 200, body: REPOSITORY_CAPTURE },
    [`GET ${PULL_PATH}`]: NOT_FOUND,
  });
  const error = await errorOf(
    adapter.readLinkedPullRequest(adapterContext('op_missing_pull'), { repository: REPOSITORY, pullRequestNumber: 7 }),
  );
  assert.equal(error.code, 'NotFound');
  assert.match(error.reason, /GitHubPullRequestRead/);
  assert.match(error.reason, /Not Found/);
  // GitHub answers "not found" for a pull request it will not show as well as one that does
  // not exist, so the reason tells the owner to check the credential too rather than
  // asserting the pull request is absent.
  assert.match(error.reason, /credential/);
});

test('a pull request the credential cannot read is Forbidden, not a missing pull request', async () => {
  const { adapter } = adapterFor({
    'GET /repos/egawilldoit/ShipLoop': {
      status: 200,
      body: REPOSITORY_CAPTURE,
    },
    [`GET ${PULL_PATH}`]: {
      status: 403,
      body: { message: 'Resource not accessible by integration', documentation_url: '', status: '403' },
    },
  });
  const error = await errorOf(
    adapter.readLinkedPullRequest(adapterContext('op_forbidden_pull'), { repository: REPOSITORY, pullRequestNumber: 7 }),
  );
  assert.equal(error.code, 'Forbidden');
  assert.notEqual(error.code, 'NotFound', '"you may not see it" and "it does not exist" are different facts');
});

test('an unreadable repository is refused before the pull request is addressed', async () => {
  const { adapter, stub } = adapterFor({
    'GET /repos/egawilldoit/ShipLoop': {
      status: 403,
      body: { message: 'Must have push access to view repository collaborators.', documentation_url: '', status: '403' },
    },
  });
  const error = await errorOf(
    adapter.readLinkedPullRequest(adapterContext('op_no_repo'), { repository: REPOSITORY, pullRequestNumber: 7 }),
  );
  assert.equal(error.code, 'Forbidden');
  assert.equal(
    stub.verbs.filter((verb) => verb.includes('/pulls/')).length,
    0,
    'the pull request must not be addressed when the repository itself is unreadable',
  );
});

test('an archived repository is Blocked, because its pull requests are read-only', async () => {
  const { adapter } = adapterFor({
    'GET /repos/egawilldoit/ShipLoop': { status: 200, body: { ...REPOSITORY_CAPTURE, archived: true } },
  });
  const error = await errorOf(
    adapter.readLinkedPullRequest(adapterContext('op_archived'), { repository: REPOSITORY, pullRequestNumber: 7 }),
  );
  assert.equal(error.code, 'Blocked');
  assert.equal(error.code === 'Blocked' ? error.prerequisites[0]?.name : null, 'ArchivedRepository');
});

test('a payload whose head SHA is abbreviated is refused as unreadable rather than carried forward', async () => {
  const { adapter } = adapterFor({
    'GET /repos/egawilldoit/ShipLoop': { status: 200, body: REPOSITORY_CAPTURE },
    [`GET ${PULL_PATH}`]: { status: 200, body: pullRequestCapture({ headSha: '1f0c2a9d3b6' }) },
  });
  const error = await errorOf(
    adapter.readLinkedPullRequest(adapterContext('op_abbreviated'), { repository: REPOSITORY, pullRequestNumber: 7 }),
  );
  // The payload reader drops a shape it cannot carry as a CommitSha, which becomes one
  // honest "this adapter cannot read it" for the whole call rather than a candidate whose
  // identity is a prefix.
  assert.equal(error.code, 'Unavailable');
  assert.match(error.reason, /cannot read/);
});

test('closed, merged and unrecognised pull request states are told apart', async () => {
  const cases: readonly { readonly body: Record<string, unknown>; readonly expected: string }[] = [
    { body: pullRequestCapture({ state: 'closed' }), expected: 'Closed' },
    { body: pullRequestCapture({ state: 'closed', merged: true, mergedAt: '2026-10-01T09:00:00.000Z' }), expected: 'Merged' },
    { body: pullRequestCapture({ state: 'whatever-new-state' }), expected: 'Closed' },
  ];
  for (const entry of cases) {
    const { adapter } = adapterFor({
      'GET /repos/egawilldoit/ShipLoop': { status: 200, body: REPOSITORY_CAPTURE },
      [`GET ${PULL_PATH}`]: { status: 200, body: entry.body },
    });
    const facts = await okOf(
      adapter.readLinkedPullRequest(adapterContext('op_state'), { repository: REPOSITORY, pullRequestNumber: 7 }),
    );
    assert.equal(facts.state, entry.expected);
  }
});

test('a merged pull request reports its merge commit, full length only', async () => {
  const { adapter } = adapterFor({
    'GET /repos/egawilldoit/ShipLoop': { status: 200, body: REPOSITORY_CAPTURE },
    [`GET ${PULL_PATH}`]: {
      status: 200,
      body: pullRequestCapture({
        state: 'closed',
        merged: true,
        mergedAt: '2026-10-01T09:00:00.000Z',
        mergeCommitSha: FIXTURE_SUPERSEDED_HEAD_SHA,
      }),
    },
  });
  const facts = await okOf(
    adapter.readLinkedPullRequest(adapterContext('op_merged'), { repository: REPOSITORY, pullRequestNumber: 7 }),
  );
  assert.equal(facts.state, 'Merged');
  assert.equal(facts.mergedSha, FIXTURE_SUPERSEDED_HEAD_SHA);
  assert.equal(facts.mergedAt, '2026-10-01T09:00:00.000Z');

  const abbreviated = adapterFor({
    'GET /repos/egawilldoit/ShipLoop': { status: 200, body: REPOSITORY_CAPTURE },
    [`GET ${PULL_PATH}`]: {
      status: 200,
      body: pullRequestCapture({ state: 'closed', merged: true, mergeCommitSha: '5d4c3b2a190' }),
    },
  });
  const factsOfAbbreviated = await okOf(
    abbreviated.adapter.readLinkedPullRequest(adapterContext('op_merged_short'), {
      repository: REPOSITORY,
      pullRequestNumber: 7,
    }),
  );
  assert.equal(factsOfAbbreviated.mergedSha, null, 'an abbreviated merge commit is dropped, not truncated');
});

test('a fork pull request reports the repository its head actually lives in', async () => {
  const { adapter } = adapterFor({
    'GET /repos/egawilldoit/ShipLoop': { status: 200, body: REPOSITORY_CAPTURE },
    [`GET ${PULL_PATH}`]: { status: 200, body: pullRequestCapture({ headRepository: 'someone-else/ShipLoop' }) },
  });
  const facts = await okOf(
    adapter.readLinkedPullRequest(adapterContext('op_fork'), { repository: REPOSITORY, pullRequestNumber: 7 }),
  );
  assert.equal(facts.headRepository, 'someone-else/ShipLoop');
  // The base is still the project's, which is exactly why the head repository has to be
  // carried separately rather than inferred from the request.
  assert.equal(facts.repository.fullName, 'egawilldoit/ShipLoop');
});

test('a retargeted base branch is read from the payload rather than assumed from the request', async () => {
  const { adapter } = adapterFor({
    'GET /repos/egawilldoit/ShipLoop': { status: 200, body: REPOSITORY_CAPTURE },
    [`GET ${PULL_PATH}`]: { status: 200, body: pullRequestCapture({ baseRef: 'release' }) },
  });
  const facts = await okOf(
    adapter.readLinkedPullRequest(adapterContext('op_retargeted'), { repository: REPOSITORY, pullRequestNumber: 7 }),
  );
  assert.equal(facts.baseBranch, 'release');
});

/* -------------------------------------------------------------------------- */
/* The port is read-only                                                        */
/* -------------------------------------------------------------------------- */

test('the read-only candidate port exposes exactly the declared reads and nothing else', async () => {
  const { adapter } = adapterFor({
    'GET /repos/egawilldoit/ShipLoop': { status: 200, body: REPOSITORY_CAPTURE },
    [`GET ${PULL_PATH}`]: { status: 200, body: pullRequestCapture() },
  });

  // The shipped adapter does hold writes; the port is what keeps them out of reach.
  const writable = adapter as unknown as Record<string, unknown>;
  assert.equal(typeof writable['mergePullRequest'], 'function');
  assert.equal(typeof writable['pushBranch'], 'function');
  assert.equal(typeof writable['upsertDraft'], 'function');

  const port = githubCandidatePort(adapter);
  const keys = Object.keys(port).sort();
  assert.deepEqual(keys, [...CANDIDATE_PORT_MEMBERS].sort());
  // Every member is a read: the two provider reads plus the identity surface a connector needs
  // to recognise the object. No write is among them.
  for (const member of keys) {
    assert.ok(
      !/merge|push|close|approve|deploy|protect|create|update|upsert|delete|write|post/i.test(member),
      `${member} must not be on the read-only candidate port`,
    );
  }
  for (const forbidden of [
    'mergePullRequest',
    'pushBranch',
    'upsertDraft',
    'declareNoCodeOutcome',
    'findDrafts',
    'approve',
    'close',
    'deploy',
    'updateProtection',
  ]) {
    assert.equal(
      (port as unknown as Record<string, unknown>)[forbidden],
      undefined,
      `${forbidden} must not be reachable from the candidate port`,
    );
  }

  // The port is a fresh object rather than the adapter under a read-only type, because a
  // TypeScript interface is erased at runtime and the adapter's writes would still be reachable.
  assert.notEqual(port as unknown, writable);

  // And the port is a working reader, not an empty shell.
  const facts = await okOf(
    port.readLinkedPullRequest(adapterContext('op_port'), { repository: REPOSITORY, pullRequestNumber: 7 }),
  );
  assert.equal(facts.headSha, FIXTURE_HEAD_SHA);
  assert.equal(port.kind, 'Git');
  assert.ok(port.capabilities().declarations.length > 0);
  assert.equal(typeof readOnlyCandidateGit(adapter).readChecks, 'function');
});

/* -------------------------------------------------------------------------- */
/* The shared fake can stand in for the port                                   */
/* -------------------------------------------------------------------------- */

test('the shared fake git adapter answers a candidate read, so an integrator needs no new double', async () => {
  const set = createFakeAdapterSet();
  const port = readOnlyCandidateGit(set.git);
  const repository = FIXTURE_REPOSITORY;

  // A number nobody scripted does not exist. The fake refuses to invent a resource, because
  // "the pull request does not exist" is one of the refusals the MVP journey must be able to
  // test and a permissive default would make it unrepresentable.
  const absent = await errorOf(
    port.readLinkedPullRequest(adapterContext('op_fake_00'), { repository, pullRequestNumber: 7 }),
  );
  assert.equal(absent.code, 'NotFound');

  const script = (overrides: Partial<FakeLinkedPullRequest> = {}): void => {
    set.git.scriptLinkedPullRequest({
      number: 7,
      state: 'Open',
      headSha: FIXTURE_HEAD_SHA,
      baseSha: FIXTURE_BASE_SHA,
      headBranch: 'fixture/head',
      baseBranch: repository.defaultBranch,
      draft: false,
      ...overrides,
    });
  };

  script();
  const initial = await okOf(port.readLinkedPullRequest(adapterContext('op_fake_01'), { repository, pullRequestNumber: 7 }));
  assert.equal(initial.headSha, FIXTURE_HEAD_SHA);
  assert.equal(initial.baseSha, FIXTURE_BASE_SHA);
  assert.equal(initial.state, 'Open');
  assert.equal(initial.headRepository, repository.fullName);

  // Scripting one entry is how a case expresses "the branch was force-pushed" between two
  // reads, which is the transition the whole refresh path exists to detect.
  script({ headSha: FIXTURE_SUPERSEDED_HEAD_SHA });
  const moved = await okOf(port.readLinkedPullRequest(adapterContext('op_fake_02'), { repository, pullRequestNumber: 7 }));
  assert.equal(moved.headSha, FIXTURE_SUPERSEDED_HEAD_SHA);
  assert.notEqual(moved.headSha, initial.headSha);

  // And a close, which an identity-keyed uniqueness rule would otherwise have swallowed.
  script({ headSha: FIXTURE_SUPERSEDED_HEAD_SHA, state: 'Closed' });
  const closed = await okOf(port.readLinkedPullRequest(adapterContext('op_fake_03'), { repository, pullRequestNumber: 7 }));
  assert.equal(closed.state, 'Closed');
  assert.equal(closed.mergedSha, null);

  // A fork is reported as its own repository, so a controller can refuse it.
  script({ headRepository: 'someone-else/repo' });
  const forked = await okOf(port.readLinkedPullRequest(adapterContext('op_fake_06'), { repository, pullRequestNumber: 7 }));
  assert.equal(forked.headRepository, 'someone-else/repo');

  // A repository this provider does not own is refused before the pull request is addressed.
  const foreign = await errorOf(
    port.readLinkedPullRequest(adapterContext('op_fake_05'), { repository: FIXTURE_FOREIGN_REPOSITORY, pullRequestNumber: 7 }),
  );
  assert.equal(foreign.code, 'Forbidden');
});

test('the shared fake refuses to report an abbreviated commit as a candidate', async () => {
  const set = createFakeAdapterSet();
  // Scripted past the type with a cast on purpose: the point is that a fake can hand a caller
  // the payload a real adapter refuses, and that the fake refuses it too.
  set.git.scriptLinkedPullRequest({
    number: 7,
    state: 'Open',
    headSha: FIXTURE_HEAD_SHA.slice(0, 12) as CommitSha,
    baseSha: FIXTURE_BASE_SHA,
    headBranch: 'fixture/head',
    baseBranch: 'develop',
    draft: false,
  });
  const error = await errorOf(
    readOnlyCandidateGit(set.git).readLinkedPullRequest(adapterContext('op_fake_short'), {
      repository: FIXTURE_REPOSITORY,
      pullRequestNumber: 7,
    }),
  );
  assert.equal(error.code, 'Unavailable');
  assert.match(error.reason, /abbreviated commit/);
});

/* -------------------------------------------------------------------------- */
/* Check mapping, through the shipped reader                                   */
/* -------------------------------------------------------------------------- */

function checkRun(options: {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly headSha?: string;
}): Record<string, unknown> {
  return {
    id: options.id,
    name: options.name,
    status: options.status,
    conclusion: options.conclusion,
    started_at: '2026-10-01T09:00:00.000Z',
    completed_at: '2026-10-01T09:01:00.000Z',
    details_url: 'https://github.com/egawilldoit/ShipLoop/runs/1',
    output: { title: options.name, summary: '' },
    head_sha: options.headSha ?? FIXTURE_HEAD_SHA,
  };
}

function checksAdapter(
  headRuns: readonly Record<string, unknown>[],
  options: { readonly baseRuns?: readonly Record<string, unknown>[] } = {},
): GitHubGitAdapter {
  const { adapter } = adapterFor({
    [`GET /repos/egawilldoit/ShipLoop/commits/${FIXTURE_HEAD_SHA}/check-runs`]: { status: 200, body: { check_runs: headRuns } },
    [`GET /repos/egawilldoit/ShipLoop/commits/${FIXTURE_HEAD_SHA}/status`]: { status: 200, body: { state: 'pending', total_count: 0, statuses: [] } },
    [`GET /repos/egawilldoit/ShipLoop/commits/${FIXTURE_BASE_SHA}/check-runs`]: {
      status: 200,
      body: { check_runs: options.baseRuns ?? [] },
    },
    [`GET /repos/egawilldoit/ShipLoop/commits/${FIXTURE_BASE_SHA}/status`]: {
      status: 200,
      body: { state: 'pending', total_count: 0, statuses: [] },
    },
  });
  return adapter;
}

async function readChecks(
  adapter: GitHubGitAdapter,
  requiredCheckNames: readonly string[],
): Promise<readonly ProviderCheckObservation[]> {
  return okOf(
    adapter.readChecks(adapterContext('op_checks'), {
      repository: REPOSITORY,
      headSha: FIXTURE_HEAD_SHA as CommitSha,
      baseSha: FIXTURE_BASE_SHA as CommitSha,
      candidateFingerprint: FIXTURE_CANDIDATE_FINGERPRINT,
      requiredCheckNames,
    }),
  );
}

test('a succeeded check run is Passed', async () => {
  const checks = await readChecks(
    checksAdapter([checkRun({ id: 1, name: 'test', status: 'completed', conclusion: 'success' })]),
    ['test'],
  );
  assert.deepEqual(checks.map((check) => [check.name, check.result]), [['test', 'Passed']]);
  assert.equal(checks[0]?.requirement, 'ProfileRequired');
});

test('a queued check is Waiting and a failed one Failed', async () => {
  const checks = await readChecks(
    checksAdapter([
      checkRun({ id: 1, name: 'queued', status: 'queued', conclusion: null }),
      checkRun({ id: 2, name: 'running', status: 'in_progress', conclusion: null }),
      checkRun({ id: 3, name: 'failed', status: 'completed', conclusion: 'failure' }),
    ]),
    ['queued', 'running', 'failed'],
  );
  assert.deepEqual(
    checks.map((check) => [check.name, check.result]),
    [
      ['queued', 'Waiting'],
      ['running', 'Waiting'],
      ['failed', 'Failed'],
    ],
  );
});

test('a skipped check is NotApplicable, never Passed', async () => {
  for (const conclusion of ['skipped', 'neutral']) {
    const checks = await readChecks(
      checksAdapter([checkRun({ id: 1, name: 'test', status: 'completed', conclusion })]),
      ['test'],
    );
    assert.equal(checks[0]?.result, 'NotApplicable', `${conclusion} must not be reported as a pass`);
  }
});

test('a conclusion this adapter does not recognise is Missing, never Passed', async () => {
  for (const conclusion of ['brand-new-conclusion', '']) {
    const checks = await readChecks(
      checksAdapter([checkRun({ id: 1, name: 'test', status: 'completed', conclusion })]),
      ['test'],
    );
    assert.equal(checks[0]?.result, 'Missing');
    // The provider's own words are carried through so an owner can see what GitHub said,
    // and no reading of them turns this into a pass.
    assert.match(checks[0]?.detail ?? '', /GitHub reported status completed/);
  }
  const unknownStatus = await readChecks(
    checksAdapter([checkRun({ id: 1, name: 'test', status: 'teleported', conclusion: null })]),
    ['test'],
  );
  assert.equal(unknownStatus[0]?.result, 'Missing');
  assert.match(unknownStatus[0]?.detail ?? '', /teleported/);
});

test('a required check the provider never reported is Missing on the candidate', async () => {
  const checks = await readChecks(checksAdapter([]), ['test', 'lint']);
  assert.deepEqual(
    checks.map((check) => [check.name, check.result]).sort(),
    [
      ['lint', 'Missing'],
      ['test', 'Missing'],
    ],
  );
});

test('a required check that ran only on the base commit is Stale, not Passed', async () => {
  const checks = await readChecks(
    checksAdapter([], { baseRuns: [checkRun({ id: 9, name: 'test', status: 'completed', conclusion: 'success' })] }),
    ['test'],
  );
  assert.equal(checks[0]?.result, 'Stale');
  assert.match(checks[0]?.detail ?? '', /cannot approve this candidate/);
});

test('a check run reported against another head SHA is demoted to Stale even when it succeeded', async () => {
  const checks = await readChecks(
    checksAdapter([
      checkRun({ id: 1, name: 'test', status: 'completed', conclusion: 'success', headSha: FIXTURE_SUPERSEDED_HEAD_SHA }),
    ]),
    ['test'],
  );
  assert.equal(checks[0]?.result, 'Stale');
});

test('an optional check the provider reported is ProviderExtra and does not become required', async () => {
  const checks = await readChecks(
    checksAdapter([checkRun({ id: 1, name: 'codecov', status: 'completed', conclusion: 'success' })]),
    [],
  );
  assert.equal(checks[0]?.requirement, 'ProviderExtra');
  assert.equal(checks[0]?.result, 'Passed');
});
