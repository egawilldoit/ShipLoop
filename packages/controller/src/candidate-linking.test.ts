/**
 * Proof for manual pull-request linking and candidate refresh.
 *
 * These cases drive the real use cases against a real migrated database and a scripted
 * read-only Git port, so every assertion travels through the shipped storage repository, the
 * shipped domain projections and the shipped change detection. Only the provider is scripted,
 * because the provider is the one thing that must not be trusted without a read.
 *
 * What the cases establish, and the wrong answer each one rules out:
 *
 *   - a link validates provider, repository, existence, accessibility, base branch, full head
 *     SHA and state *before* anything is written, and a rejected paste leaves no candidate;
 *   - a pull request in the wrong repository, one that does not exist, one the credential
 *     cannot read and one whose head lives in a fork are each refused for their own reason;
 *   - a refresh that observes a moved head appends a candidate, returns
 *     `priorEvidenceStale` with the previous head named, and makes the previous row
 *     unreachable as current while leaving it readable;
 *   - a pull request that closed after linking stops being reviewable without the stored
 *     candidate being silently reported as still good;
 *   - a skipped, unknown, missing or base-only check never makes a candidate ready;
 *   - the port this module holds has no write method to call.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { err, ok } from '@shiploop/domain';
import type { CandidateId, CheckResult, CommitSha, DomainError, ProjectId, Result } from '@shiploop/domain';
import type { GitRepositoryRef, ProviderCheckObservation } from '@shiploop/adapters';
import { openDatabase, type Database } from '@shiploop/storage';
import { DeliveryCandidateRepository, migrate } from '@shiploop/storage';

import { createCandidateLinkUseCases } from './candidate-linking.ts';
import type { CandidateLinkUseCases } from './candidate-linking.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';

/* -------------------------------------------------------------------------- */
/* Scripted provider                                                           */
/* -------------------------------------------------------------------------- */

const HEAD = '1f0c2a9d3b6e4c8a7d5f1e3b9c2a6d4e8f0a1b3c' as CommitSha;
const NEXT_HEAD = '7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a3' as CommitSha;
const BASE = '0b9d8c7b6a5948372615e4d3c2b1a09f8e7d6c5b' as CommitSha;
const REPOSITORY = 'egawilldoit/ShipLoop';
const PROJECT = 'project-candidate-01';
const OTHER_PROJECT = 'project-candidate-02';
const T1 = '2026-10-01T00:05:00.000Z';

const REPOSITORY_REF: GitRepositoryRef = {
  provider: 'github',
  fullName: REPOSITORY,
  defaultBranch: 'main',
  url: `https://github.com/${REPOSITORY}`,
};

/** One scripted pull request, as the read-only port would report it. */
interface ScriptedPull {
  readonly number: number;
  readonly state: 'Open' | 'Closed' | 'Merged';
  readonly headSha: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly draft: boolean;
  readonly headRepository: string | null;
  /** A refusal the provider would return instead of facts. Narrow on purpose: these are the
   *  three answers a link has to tell apart, and a broader union would hide that. */
  readonly failure?: { readonly code: 'NotFound' | 'Forbidden' | 'Unavailable'; readonly reason: string };
}

/**
 * A read-only Git port that records what it was asked.
 *
 * It is deliberately typed as the port the controller depends on, so this file cannot reach a
 * write even by accident — and the case at the end proves the type it holds has no write member.
 */
class ScriptedGit {
  /**
   * Mutable on purpose: several cases link a candidate and then move the pull request, which
   * is the whole point of a refresh. The first entry for a number wins, so listing a
   * "before" and an "after" pull cannot make the "before" unreachable.
   */
  readonly pullRequests: Map<number, ScriptedPull>;
  checks: readonly ProviderCheckObservation[] = [];
  checkFailure: DomainError | null = null;
  profileFailure: DomainError | null = null;
  /** Every call this port received, so a case can assert what was read. */
  readonly calls: string[] = [];

  constructor(pulls: readonly ScriptedPull[]) {
    this.pullRequests = new Map();
    for (const pull of pulls) {
      if (!this.pullRequests.has(pull.number)) this.pullRequests.set(pull.number, pull);
    }
  }

  async readLinkedPullRequest(
    _context: unknown,
    request: { readonly repository: GitRepositoryRef; readonly pullRequestNumber: number },
  ): Promise<Result<unknown, DomainError>> {
    this.calls.push(`readLinkedPullRequest ${request.pullRequestNumber}`);
    if (request.repository.provider !== 'github') {
      return err({ code: 'Forbidden', reason: 'not this provider' });
    }
    const pull = this.pullRequests.get(request.pullRequestNumber);
    if (pull === undefined) {
      return err({ code: 'NotFound', reason: `GitHub has no pull request ${request.pullRequestNumber}.` });
    }
    if (pull.failure !== undefined) {
      return err({ code: pull.failure.code, reason: pull.failure.reason });
    }
    return ok({
      repository: { ...request.repository, fullName: request.repository.fullName },
      providerPullRequestId: String(pull.number),
      number: pull.number,
      url: `https://github.com/${request.repository.fullName}/pull/${pull.number}`,
      state: pull.state,
      draft: pull.draft,
      headBranch: pull.headBranch,
      headSha: pull.headSha,
      baseBranch: pull.baseBranch,
      baseSha: pull.baseSha,
      headRepository: pull.headRepository,
      mergedSha: pull.state === 'Merged' ? NEXT_HEAD : null,
      mergedAt: null,
      observedAt: T1,
    });
  }

  async readChecks(
    _context: unknown,
    request: { readonly headSha: string; readonly requiredCheckNames: readonly string[] },
  ): Promise<Result<readonly ProviderCheckObservation[], DomainError>> {
    this.calls.push(`readChecks ${request.headSha.slice(0, 12)}`);
    if (this.checkFailure !== null) return err(this.checkFailure);
    return ok(this.checks);
  }

  /** The only two members this object exposes to the controller. */
  asPort(): Parameters<typeof createCandidateLinkUseCases>[0]['git'] {
    return {
      kind: 'Git',
      readLinkedPullRequest: this.readLinkedPullRequest.bind(this) as never,
      readChecks: this.readChecks.bind(this) as never,
    } as never;
  }
}

function observation(name: string, result: CheckResult, requirement: 'ProfileRequired' | 'ProviderExtra' = 'ProviderExtra'): ProviderCheckObservation {
  return {
    checkId: `check_${name}`,
    name,
    result,
    requirement,
    startedAt: T1,
    endedAt: T1,
    exitCode: null,
    detail: null,
    artifactUrl: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const OWNER: OwnerActor = {
  actorId: 'owner-01',
  role: 'Owner',
  ownerId: 'owner-01' as OwnerActor['ownerId'],
  sessionId: 'session-01',
};

const NON_OWNER: OwnerActor = { ...OWNER, role: 'CodingAgent', actorId: 'agent-01' };

function clockAt(instant: string): ControllerClock {
  return { now: () => instant };
}

let candidateSequence = 0;

/**
 * Runs `body` against a fresh migrated database and a wired set of use cases.
 *
 * Candidate ids are minted from a counter rather than a UUID so a failure names which
 * candidate was which, and the clock is supplied per call so a test can place a refresh before
 * or after a push without sleeping.
 */
async function withUseCases(
  options: { readonly requiredCheckNames?: readonly string[]; readonly repositoryRef?: GitRepositoryRef } | ((useCases: CandidateLinkUseCases, git: ScriptedGit) => Promise<void>),
  pulls: readonly ScriptedPull[],
  body?: (useCases: CandidateLinkUseCases, git: ScriptedGit, db: Database) => Promise<void>,
): Promise<void> {
  const configure = typeof options === 'function' ? undefined : options;
  const run = typeof options === 'function' ? options : body;
  if (run === undefined) throw new Error('a body is required');

  const directory = await mkdtemp(join(tmpdir(), 'shiploop-candidate-link-'));
  const opened = openDatabase(join(directory, 'storage.sqlite'));
  assert.ok(opened.ok, 'the database could not be opened');
  const db = opened.value;
  try {
    const migrated = migrate(db);
    assert.ok(migrated.ok, `migrate failed: ${migrated.ok ? '' : migrated.error.reason}`);
    db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(PROJECT, 'Candidate project');
    db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(OTHER_PROJECT, 'Other project');

    candidateSequence = 0;
    const git = new ScriptedGit(pulls);
    const useCases = createCandidateLinkUseCases({
      clock: clockAt(T1),
      candidates: new DeliveryCandidateRepository(db),
      git: git.asPort(),
      repositoryRef: () =>
        configure?.repositoryRef === undefined ? ok(REPOSITORY_REF) : ok(configure.repositoryRef),
      requiredCheckNames: () => {
        const failure = git.profileFailure;
        return failure === null ? ok(configure?.requiredCheckNames ?? []) : err(failure);
      },
      newCandidateId: () => `candidate-${(++candidateSequence).toString().padStart(4, '0')}` as CandidateId,
    });
    await run(useCases, git, db);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Unwraps a result, awaiting it when the use case was asynchronous.
 *
 * Two of the five candidate use cases are synchronous — a binding lookup and a recorded read —
 * and one test helper covering both is better than two helpers that could disagree about how a
 * refusal is reported.
 */
async function okOf<T>(pending: Result<T, DomainError> | Promise<Result<T, DomainError>>): Promise<T> {
  const result = await pending;
  if (!result.ok) assert.fail(`expected success, received ${result.error.code}: ${result.error.reason}`);
  return result.value;
}

async function errorOf(
  pending: Result<unknown, DomainError> | Promise<Result<unknown, DomainError>>,
): Promise<DomainError> {
  const result = await pending;
  if (result.ok) assert.fail('expected a refusal, but the call succeeded');
  return result.error;
}

const OPEN_PULL: ScriptedPull = {
  number: 7,
  state: 'Open',
  headSha: HEAD,
  baseSha: BASE,
  headBranch: 'task/mvp-candidate',
  baseBranch: 'main',
  draft: false,
  headRepository: REPOSITORY,
};

function linkInput(overrides: Partial<Parameters<CandidateLinkUseCases['linkPullRequest']>[0]> = {}) {
  return {
    actor: OWNER,
    projectId: PROJECT as ProjectId,
    requestId: 'request-01',
    contractId: 'contract-01',
    contractRevision: 1,
    pullRequestUrl: `https://github.com/${REPOSITORY}/pull/7`,
    expectedBaseBranch: 'main',
    correlationId: 'corr-01',
    ...overrides,
  };
}

function readInput(overrides: Partial<Parameters<CandidateLinkUseCases['readCandidate']>[0]> = {}) {
  return {
    actor: OWNER,
    projectId: PROJECT as ProjectId,
    requestId: 'request-01',
    correlationId: 'corr-01',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Linking                                                                     */
/* -------------------------------------------------------------------------- */

test('a pasted pull request address becomes an exact candidate bound to its contract revision', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases) => {
    const linked = await okOf(useCases.linkPullRequest(linkInput()));
    assert.equal(linked.alreadyRecorded, false);
    assert.equal(linked.candidate.headSha, HEAD);
    assert.equal(linked.candidate.headSha.length, 40);
    assert.equal(linked.candidate.baseSha, BASE);
    assert.equal(linked.candidate.pullRequestNumber, 7);
    assert.equal(linked.candidate.pullRequestUrl, `https://github.com/${REPOSITORY}/pull/7`);
    assert.equal(linked.candidate.baseBranch, 'main');
    assert.equal(linked.candidate.pullRequestState, 'Open');
    assert.equal(linked.candidate.contractId, 'contract-01');
    assert.equal(linked.candidate.contractRevision, 1);
    assert.equal(linked.candidate.requestId, 'request-01');
    // The binding is the triple every piece of evidence has to name.
    assert.deepEqual(linked.binding, { contractId: 'contract-01', contractRevision: 1, headSha: HEAD });
    assert.equal(linked.bindingFingerprint.length, 35);
    assert.equal(linked.live.headSha, HEAD);

    // The same link again changes nothing and says so.
    const again = await okOf(useCases.linkPullRequest(linkInput()));
    assert.equal(again.alreadyRecorded, true);
    assert.equal(again.candidate.candidateId, linked.candidate.candidateId);
  });
});

test('a pull request in a different repository is refused and nothing is recorded', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases) => {
    const error = await errorOf(
      useCases.linkPullRequest(
        linkInput({ pullRequestUrl: 'https://github.com/someone-else/ShipLoop/pull/7' }),
      ),
    );
    assert.equal(error.code, 'Invalid');
    assert.match(error.code === 'Invalid' ? (error.fields[0]?.message ?? '') : '', /someone-else\/ShipLoop/);
    assert.equal(
      await okOf(useCases.recordedCandidate('request-01')),
      null,
      'a refused link must leave no candidate behind',
    );
  });
});

test('a look-alike repository name is a different repository', async () => {
  await withUseCases({}, [{ ...OPEN_PULL }], async (useCases) => {
    for (const fullName of ['egawilldoit/ShipLoop-fork', 'egawilldoit/shiploop-2', 'a/egawilldoit/ShipLoop']) {
      const error = await errorOf(
        useCases.linkPullRequest(linkInput({ pullRequestUrl: `https://github.com/${fullName}/pull/7` })),
      );
      assert.equal(error.code, 'Invalid', `${fullName} must not be accepted as ${REPOSITORY}`);
    }
  });
});

test('a repository name that differs only in case is the same repository', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases) => {
    const linked = await okOf(
      useCases.linkPullRequest(
        linkInput({ pullRequestUrl: `https://github.com/EGAWILLDOIT/shiploop/pull/7/files` }),
      ),
    );
    assert.equal(linked.candidate.repository, REPOSITORY);
  });
});

test('a non-GitHub address is refused by the URL parser, before any provider read', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases, git) => {
    const error = await errorOf(
      useCases.linkPullRequest(linkInput({ pullRequestUrl: 'https://gitlab.com/egawilldoit/ShipLoop/-/merge_requests/7' })),
    );
    assert.equal(error.code, 'Invalid');
    assert.deepEqual(git.calls, [], 'a non-GitHub address must not reach the provider');
  });
});

test('a pull request that does not exist is refused as NotFound', async () => {
  await withUseCases({}, [], async (useCases) => {
    const error = await errorOf(useCases.linkPullRequest(linkInput()));
    assert.equal(error.code, 'NotFound');
    assert.equal(await okOf(useCases.recordedCandidate('request-01')), null);
  });
});

test('a pull request the credential cannot read is refused as Forbidden, not as missing', async () => {
  await withUseCases(
    {},
    [
      {
        ...OPEN_PULL,
        failure: { code: 'Forbidden', reason: 'GitHub refused this credential for the pull request.' },
      },
    ],
    async (useCases) => {
      const error = await errorOf(useCases.linkPullRequest(linkInput()));
      assert.equal(error.code, 'Forbidden');
      assert.notEqual(error.code, 'NotFound');
    },
  );
});

test('a pull request whose head lives in a fork is refused with a stated reason', async () => {
  await withUseCases({}, [{ ...OPEN_PULL, headRepository: 'someone-else/ShipLoop' }], async (useCases) => {
    const error = await errorOf(useCases.linkPullRequest(linkInput()));
    assert.equal(error.code, 'Blocked');
    assert.equal(error.code === 'Blocked' ? error.prerequisites[0]?.name : null, 'HeadOutsideProjectRepository');
    assert.match(error.reason, /never in egawilldoit\/ShipLoop/);
    assert.equal(await okOf(useCases.recordedCandidate('request-01')), null);
  });
});

test('a pull request targeting an unexpected base branch is refused', async () => {
  await withUseCases({}, [{ ...OPEN_PULL, baseBranch: 'release' }], async (useCases) => {
    const error = await errorOf(useCases.linkPullRequest(linkInput({ expectedBaseBranch: 'main' })));
    assert.equal(error.code, 'Blocked');
    assert.equal(error.code === 'Blocked' ? error.prerequisites[0]?.name : null, 'UnexpectedBaseBranch');
    assert.match(error.reason, /release/);
    // With no expectation supplied, the pull request's own base branch is what gets recorded.
    const linked = await okOf(useCases.linkPullRequest(linkInput({ expectedBaseBranch: null })));
    assert.equal(linked.candidate.baseBranch, 'release');
  });
});

test('a closed or merged pull request cannot be linked, and each says what would unblock it', async () => {
  await withUseCases(
    {},
    [
      { ...OPEN_PULL, state: 'Closed' },
      { ...OPEN_PULL, number: 8, state: 'Merged' },
    ],
    async (useCases) => {
      const closed = await errorOf(useCases.linkPullRequest(linkInput()));
      assert.equal(closed.code, 'Blocked');
      assert.match(closed.reason, /Closed/);
      assert.match(closed.reason, /Reopen the pull request/);

      const merged = await errorOf(
        useCases.linkPullRequest(linkInput({ pullRequestUrl: `https://github.com/${REPOSITORY}/pull/8` })),
      );
      assert.equal(merged.code, 'Blocked');
      assert.match(merged.reason, /Merged/);
      assert.match(merged.reason, /already landed/);
      assert.equal(await okOf(useCases.recordedCandidate('request-01')), null);
    },
  );
});

test('a link with no request or no contract revision is refused before a provider read', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases, git) => {
    const error = await errorOf(
      useCases.linkPullRequest(linkInput({ requestId: '  ', contractId: '', contractRevision: 0 })),
    );
    assert.equal(error.code, 'Invalid');
    assert.deepEqual(
      (error.code === 'Invalid' ? error.fields.map((field) => field.path).sort() : []),
      ['contractId', 'contractRevision', 'requestId'],
    );
    assert.deepEqual(git.calls, []);
  });
});

test('a project configured for another provider cannot link a GitHub candidate', async () => {
  await withUseCases({ repositoryRef: { ...REPOSITORY_REF, provider: 'gitlab' } }, [OPEN_PULL], async (useCases, git) => {
    const error = await errorOf(useCases.linkPullRequest(linkInput()));
    assert.equal(error.code, 'Forbidden');
    assert.match(error.reason, /GitHub pull requests only/);
    assert.deepEqual(git.calls, []);
  });
});

test('a non-owner role cannot link or read a candidate', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases) => {
    const refused = await errorOf(useCases.linkPullRequest(linkInput({ actor: NON_OWNER })));
    assert.equal(refused.code, 'Forbidden');
    assert.match(refused.reason, /CodingAgent/);
    assert.equal(await okOf(useCases.recordedCandidate('request-01')), null);
  });
});

/* -------------------------------------------------------------------------- */
/* Refresh                                                                     */
/* -------------------------------------------------------------------------- */

test('an unchanged pull request reports no change and appends nothing', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases) => {
    const linked = await okOf(useCases.linkPullRequest(linkInput()));
    const view = await okOf(useCases.readCandidate(readInput()));
    assert.equal(view.change.kind, 'Unchanged');
    assert.equal(view.priorEvidenceStale, false);
    assert.equal(view.previousCandidateId, null);
    assert.equal(view.previousHeadSha, null);
    assert.equal(view.candidate.candidateId, linked.candidate.candidateId);
    assert.deepEqual(view.supersededCandidates, []);
    assert.equal(view.candidate.headSha, HEAD);
    assert.equal(view.binding.headSha, HEAD);
  });
});

test('a moved head becomes a new candidate, and the old one stops being current', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases, git) => {
    const linked = await okOf(useCases.linkPullRequest(linkInput()));
    // The branch is force-pushed: GitHub now holds a different commit under the same branch.
    git.pullRequests.set(7, { ...OPEN_PULL, headSha: NEXT_HEAD });
    const view = await okOf(useCases.readCandidate(readInput()));

    assert.equal(view.change.kind, 'HeadChanged');
    assert.deepEqual(view.change.changed, ['HeadChanged']);
    assert.equal(view.priorEvidenceStale, true);
    assert.equal(view.previousCandidateId, linked.candidate.candidateId);
    assert.equal(view.previousHeadSha, HEAD, 'stale evidence is about the head that was there before');
    assert.equal(view.candidate.headSha, NEXT_HEAD);
    assert.notEqual(view.candidate.candidateId, linked.candidate.candidateId);
    assert.deepEqual(view.supersededCandidates, [linked.candidate.candidateId]);

    // A second read observes the new head as current and reports nothing stale about it, so
    // the staleness flag marks the *transition*, not the candidate forever.
    const second = await okOf(useCases.readCandidate(readInput()));
    assert.equal(second.change.kind, 'Unchanged');
    assert.equal(second.priorEvidenceStale, false);
    assert.equal(second.candidate.headSha, NEXT_HEAD);
  });
});

test('the superseded candidate stays readable, so its evidence still names a real commit', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases, git) => {
    const linked = await okOf(useCases.linkPullRequest(linkInput()));
    git.pullRequests.set(7, { ...OPEN_PULL, headSha: NEXT_HEAD });
    await okOf(useCases.readCandidate(readInput()));

    // The old row was not edited or deleted.
    const history = await okOf(useCases.candidateHistory('request-01'));
    assert.deepEqual(history.map((entry) => entry.headSha), [HEAD, NEXT_HEAD]);
    // And the current candidate is the new head, so a review read cannot pick the old one.
    assert.equal((await okOf(useCases.recordedCandidate('request-01')))?.headSha, NEXT_HEAD);
    assert.equal(history[0]?.candidateId, linked.candidate.candidateId);
  });
});

test('a candidate is still findable by the binding its evidence carries, old or new', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases, git) => {
    await okOf(useCases.linkPullRequest(linkInput()));
    git.pullRequests.set(7, { ...OPEN_PULL, headSha: NEXT_HEAD });
    await okOf(useCases.readCandidate(readInput()));

    const forOldHead = await okOf(
      useCases.candidateForBinding({ contractId: 'contract-01', contractRevision: 1, headSha: HEAD }),
    );
    assert.equal(forOldHead?.headSha, HEAD, 'evidence for the superseded head still resolves to its candidate');
    const forNewHead = await okOf(
      useCases.candidateForBinding({ contractId: 'contract-01', contractRevision: 1, headSha: NEXT_HEAD }),
    );
    assert.equal(forNewHead?.headSha, NEXT_HEAD);
    // A commit no candidate was ever recorded for is null, not a near match.
    assert.equal(
      await okOf(
        useCases.candidateForBinding({
          contractId: 'contract-01',
          contractRevision: 1,
          headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
        }),
      ),
      null,
    );
    // An abbreviated head is refused rather than resolved to whatever it names.
    const refusal = useCases.candidateForBinding({ contractId: 'contract-01', contractRevision: 1, headSha: HEAD.slice(0, 12) });
    assert.equal(refusal.ok, false);
    if (!refusal.ok) assert.match(refusal.error.reason, /not a full commit SHA/);
  });
});

test('a closed pull request stops being reviewable and is reported as a change', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases, git) => {
    await okOf(useCases.linkPullRequest(linkInput()));
    // The owner closes the pull request on GitHub between the link and the review read.
    git.pullRequests.set(7, { ...OPEN_PULL, state: 'Closed' });

    const view = await okOf(useCases.readCandidate(readInput()));
    assert.equal(view.change.kind, 'StateChanged');
    assert.equal(view.priorEvidenceStale, true);
    assert.equal(view.previousHeadSha, HEAD);
    assert.equal(view.candidate.pullRequestState, 'Closed');
    assert.equal(view.reviewReadiness.ready, false);
    assert.ok(
      view.reviewReadiness.reasons.some((reason) => reason.includes('Closed')),
      `expected a Closed reason, got ${JSON.stringify(view.reviewReadiness.reasons)}`,
    );
    // The commit did not move, so the head is still the one that was linked.
    assert.equal(view.candidate.headSha, HEAD);
  });
});

test('a merged pull request is not reviewable and names what happened', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases, git) => {
    await okOf(useCases.linkPullRequest(linkInput()));
    git.pullRequests.set(7, { ...OPEN_PULL, state: 'Merged' });
    const view = await okOf(useCases.readCandidate(readInput()));
    assert.equal(view.candidate.pullRequestState, 'Merged');
    assert.equal(view.reviewReadiness.ready, false);
    assert.ok(view.reviewReadiness.reasons.some((reason) => reason.includes('Merged')));
  });
});

test('a retargeted base branch and a renamed head branch are reported as changes', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases, git) => {
    await okOf(useCases.linkPullRequest(linkInput()));
    git.pullRequests.set(7, { ...OPEN_PULL, baseBranch: 'release', headBranch: 'task/renamed' });
    const view = await okOf(useCases.readCandidate(readInput()));
    assert.deepEqual(view.change.changed, ['BaseBranchChanged', 'HeadBranchChanged']);
    assert.equal(view.priorEvidenceStale, true);
    assert.equal(view.candidate.baseBranch, 'release');
    assert.equal(view.candidate.headBranch, 'task/renamed');
  });
});

test('a read for a request with no candidate says so rather than returning an empty candidate', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases) => {
    const error = await errorOf(useCases.readCandidate(readInput()));
    assert.equal(error.code, 'NotFound');
    assert.match(error.reason, /no linked candidate/);
  });
});

test('a read through the wrong project does not reach another project candidate', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases) => {
    await okOf(useCases.linkPullRequest(linkInput()));
    const error = await errorOf(useCases.readCandidate(readInput({ projectId: OTHER_PROJECT as ProjectId })));
    assert.equal(error.code, 'NotFound');
    assert.match(error.reason, /in this project/);
  });
});

test('a provider failure is returned rather than answered from the stored candidate', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases, git) => {
    await okOf(useCases.linkPullRequest(linkInput()));
    git.pullRequests.set(7, { ...OPEN_PULL, failure: { code: 'Unavailable', reason: 'GitHub returned HTTP 503.' } });
    const error = await errorOf(useCases.readCandidate(readInput()));
    assert.equal(error.code, 'Unavailable');
    assert.match(error.reason, /503/);
    // The stored candidate is untouched, so the owner can read it again once GitHub answers.
    assert.equal((await okOf(useCases.recordedCandidate('request-01')))?.headSha, HEAD);
  });
});

test('a failed check read is returned rather than answering with no checks at all', async () => {
  await withUseCases({ requiredCheckNames: ['test'] }, [OPEN_PULL], async (useCases, git) => {
    await okOf(useCases.linkPullRequest(linkInput()));
    git.checkFailure = { code: 'Unavailable', reason: 'GitHub returned HTTP 500.' };
    const error = await errorOf(useCases.readCandidate(readInput()));
    assert.equal(error.code, 'Unavailable');
  });
});

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

test('a green candidate is ready, and its checks are read for the live head', async () => {
  await withUseCases({ requiredCheckNames: ['test'] }, [OPEN_PULL], async (useCases, git) => {
    git.checks = [observation('test', 'Passed', 'ProfileRequired')];
    await okOf(useCases.linkPullRequest(linkInput()));
    const view = await okOf(useCases.readCandidate(readInput()));
    assert.equal(view.checksReady, true);
    assert.deepEqual(view.blockingChecks, []);
    assert.equal(view.reviewReadiness.ready, true);
    assert.deepEqual(view.reviewReadiness.reasons, []);
    assert.ok(
      git.calls.some((call) => call === `readChecks ${HEAD.slice(0, 12)}`),
      `the check read must address the live head; saw ${git.calls.join(', ')}`,
    );
  });
});

test('a moved head is checked at the new commit, never at the one the record held', async () => {
  await withUseCases({ requiredCheckNames: ['test'] }, [OPEN_PULL], async (useCases, git) => {
    git.checks = [observation('test', 'Passed', 'ProfileRequired')];
    await okOf(useCases.linkPullRequest(linkInput()));
    git.pullRequests.set(7, { ...OPEN_PULL, headSha: NEXT_HEAD });
    await okOf(useCases.readCandidate(readInput()));
    assert.ok(
      git.calls.includes(`readChecks ${NEXT_HEAD.slice(0, 12)}`),
      `a refresh must read checks for the new head; saw ${git.calls.join(', ')}`,
    );
  });
});

test('a skipped check does not make a candidate ready', async () => {
  await withUseCases({ requiredCheckNames: ['deploy-preview'] }, [OPEN_PULL], async (useCases, git) => {
    git.checks = [observation('deploy-preview', 'NotApplicable', 'ProfileRequired')];
    await okOf(useCases.linkPullRequest(linkInput()));
    const view = await okOf(useCases.readCandidate(readInput()));
    assert.equal(view.checksReady, false);
    assert.deepEqual(view.blockingChecks, ['deploy-preview is NotApplicable']);
    assert.equal(view.reviewReadiness.ready, false);
  });
});

test('a check the provider never reported is Missing, not an absent entry and not a pass', async () => {
  await withUseCases({ requiredCheckNames: ['test', 'lint'] }, [OPEN_PULL], async (useCases, git) => {
    git.checks = [observation('test', 'Passed', 'ProfileRequired')];
    await okOf(useCases.linkPullRequest(linkInput()));
    const view = await okOf(useCases.readCandidate(readInput()));
    assert.deepEqual(
      view.checks.map((check) => [check.name, check.result]),
      [
        ['lint', 'Missing'],
        ['test', 'Passed'],
      ],
    );
    assert.equal(view.checksReady, false);
    assert.deepEqual(view.blockingChecks, ['lint is Missing']);
  });
});

test('a required check that ran only on the base commit is Stale and blocks', async () => {
  await withUseCases({ requiredCheckNames: ['test'] }, [OPEN_PULL], async (useCases, git) => {
    git.checks = [observation('test', 'Stale', 'ProfileRequired')];
    await okOf(useCases.linkPullRequest(linkInput()));
    const view = await okOf(useCases.readCandidate(readInput()));
    assert.equal(view.checksReady, false);
    assert.deepEqual(view.blockingChecks, ['test is Stale']);
  });
});

test('an unknown or still-running check blocks rather than being read as a pass', async () => {
  for (const result of ['Missing', 'Waiting', 'Failed'] as const) {
    await withUseCases({ requiredCheckNames: ['test'] }, [OPEN_PULL], async (useCases, git) => {
      git.checks = [observation('test', result, 'ProfileRequired')];
      await okOf(useCases.linkPullRequest(linkInput()));
      const view = await okOf(useCases.readCandidate(readInput()));
      assert.equal(view.checksReady, false, `${result} must not be ready`);
      assert.deepEqual(view.blockingChecks, [`test is ${result}`]);
      assert.equal(view.reviewReadiness.ready, false);
    });
  }
});

test('an optional failing check does not block the candidate', async () => {
  await withUseCases({ requiredCheckNames: ['test'] }, [OPEN_PULL], async (useCases, git) => {
    git.checks = [
      observation('test', 'Passed', 'ProfileRequired'),
      observation('codecov', 'Failed', 'ProviderExtra'),
    ];
    await okOf(useCases.linkPullRequest(linkInput()));
    const view = await okOf(useCases.readCandidate(readInput()));
    assert.equal(view.checksReady, true);
    assert.equal(view.checks.find((check) => check.name === 'codecov')?.result, 'Failed');
  });
});

test('a draft pull request is not reviewable even with every check green', async () => {
  await withUseCases({ requiredCheckNames: ['test'] }, [{ ...OPEN_PULL, draft: true }], async (useCases, git) => {
    git.checks = [observation('test', 'Passed', 'ProfileRequired')];
    await okOf(useCases.linkPullRequest(linkInput()));
    const view = await okOf(useCases.readCandidate(readInput()));
    assert.equal(view.checksReady, true);
    assert.equal(view.reviewReadiness.ready, false);
    assert.ok(view.reviewReadiness.reasons.some((reason) => reason.includes('draft')));
  });
});

test('a profile that requires nothing reports ready with no checks and no invented pass', async () => {
  await withUseCases({}, [OPEN_PULL], async (useCases, git) => {
    git.checks = [];
    await okOf(useCases.linkPullRequest(linkInput()));
    const view = await okOf(useCases.readCandidate(readInput()));
    assert.deepEqual(view.checks, []);
    assert.equal(view.checksReady, true);
    assert.equal(view.reviewReadiness.ready, true);
  });
});

test('a profile requirement failure is returned rather than treated as no requirements', async () => {
  await withUseCases({ requiredCheckNames: ['test'] }, [OPEN_PULL], async (useCases, git) => {
    git.profileFailure = { code: 'Unavailable', reason: 'the project profile could not be read' };
    // The link still succeeds: it is a fact about identity and needs no check policy.
    await okOf(useCases.linkPullRequest(linkInput()));
    // The read cannot answer, because "I could not find out what is required" and "nothing is
    // required" must not collapse into the same view.
    const error = await errorOf(useCases.readCandidate(readInput()));
    assert.equal(error.code, 'Unavailable');
    assert.match(error.reason, /project profile/);
  });
});

/* -------------------------------------------------------------------------- */
/* The port is read-only                                                        */
/* -------------------------------------------------------------------------- */

test('the Git port this module holds exposes only reads, so no write is reachable', () => {
  const git = new ScriptedGit([]);
  const port = git.asPort() as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(port).sort(), ['kind', 'readChecks', 'readLinkedPullRequest']);
  for (const forbidden of [
    'mergePullRequest',
    'pushBranch',
    'upsertDraft',
    'declareNoCodeOutcome',
    'findDrafts',
    'closePullRequest',
    'approvePullRequest',
    'deploy',
    'updateBranchProtection',
  ]) {
    assert.equal(port[forbidden], undefined, `${forbidden} must not be reachable from the candidate port`);
  }
});
