/**
 * Proof for candidate identity, change detection and check projection.
 *
 * These are the rules the rest of the MVP leans on without re-checking, so each case
 * here is an assertion that a specific wrong answer is unreachable:
 *
 *   - a pull request URL that is not a GitHub pull request is refused, and a similar
 *     repository is not accepted as the project's own;
 *   - an abbreviated SHA, a branch name and a pull request number are each refused as
 *     identity, and a full SHA survives a round trip unchanged;
 *   - a changed head is reported as a change with the previous head named, so a view
 *     cannot keep a ready status across a force push;
 *   - `Skipped`, an unknown conclusion, a check that never ran and a check reported
 *     against another commit all block, and only `Passed` does not.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CANDIDATE_CHANGE_KINDS,
  PULL_REQUEST_STATES,
  blockingRequiredChecks,
  candidateBindingFingerprint,
  candidateBindingOf,
  candidateChecksReady,
  detectCandidateChange,
  evidenceBindingVerdict,
  parseGitHubPullRequestUrl,
  projectCandidateChecks,
  requireFullCommitSha,
  sameGitHubRepository,
} from './candidate-link.ts';
import type { CandidateFacts, DeliveryCandidate, ProviderCheckFact } from './candidate-link.ts';
import type { CommitSha, ProjectId } from './ids.ts';
import type { Result, DomainError, InvalidError } from './result.ts';
import type { CheckResult } from './evidence.ts';
import type { ParsedPullRequestUrl } from './candidate-link.ts';

const HEAD = '1f0c2a9d3b6e4c8a7d5f1e3b9c2a6d4e8f0a1b3c' as CommitSha;
const NEXT_HEAD = '7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a3' as CommitSha;
const BASE = '0b9d8c7b6a5948372615e4d3c2b1a09f8e7d6c5b' as CommitSha;

function expectOk<T>(result: Result<T, DomainError>): T {
  if (!result.ok) assert.fail(`expected success, received ${result.error.code}: ${result.error.reason}`);
  return result.value;
}

function expectInvalid<T>(result: Result<T, DomainError>): InvalidError {
  if (result.ok) assert.fail('expected an Invalid refusal, but the call succeeded');
  assert.equal(result.error.code, 'Invalid');
  return result.error as InvalidError;
}

const FACTS: CandidateFacts = {
  provider: 'github',
  repository: 'egawilldoit/ShipLoop',
  pullRequestNumber: 7,
  baseBranch: 'main',
  baseSha: BASE,
  headBranch: 'task/mvp',
  headSha: HEAD,
  pullRequestState: 'Open',
  draft: false,
};

/* -------------------------------------------------------------------------- */
/* URL validation                                                              */
/* -------------------------------------------------------------------------- */

test('a pasted GitHub pull request address becomes provider identity', () => {
  const parsed: ParsedPullRequestUrl = expectOk(
    parseGitHubPullRequestUrl('  https://github.com/egawilldoit/ShipLoop/pull/7  '),
  );
  assert.equal(parsed.provider, 'github');
  assert.equal(parsed.fullName, 'egawilldoit/ShipLoop');
  assert.equal(parsed.number, 7);
  assert.equal(parsed.url, 'https://github.com/egawilldoit/ShipLoop/pull/7');
});

test('a copied browser URL with a trailing view or fragment is still the same pull request', () => {
  for (const input of [
    'https://github.com/egawilldoit/ShipLoop/pull/7/files',
    'https://github.com/egawilldoit/ShipLoop/pull/7#issuecomment-1',
    'github.com/egawilldoit/ShipLoop/pull/7',
    'https://github.com/egawilldoit/ShipLoop/pull/7?w=1',
  ]) {
    const parsed = expectOk(parseGitHubPullRequestUrl(input));
    assert.equal(parsed.number, 7, `${input} should resolve to pull request 7`);
  }
});

test('a non-GitHub provider is refused rather than read as a GitHub pull request', () => {
  // GitLab and Bitbucket are explicitly out of scope for v0.1, so an address at either
  // must fail loudly rather than be parsed into an owner/repository pair.
  const refusal = expectInvalid(parseGitHubPullRequestUrl('https://gitlab.com/owner/repo/-/merge_requests/7'));
  assert.match(refusal.fields[0]?.message ?? '', /not github\.com/);
  expectInvalid(parseGitHubPullRequestUrl('https://bitbucket.org/owner/repo/pull-requests/7'));
  // A look-alike host must not pass as GitHub either.
  expectInvalid(parseGitHubPullRequestUrl('https://github.com.evil.test/owner/repo/pull/7'));
  expectInvalid(parseGitHubPullRequestUrl('https://evil.test/github.com/owner/repo/pull/7'));
});

test('an address that is not a pull request is refused, and says what was expected', () => {
  expectInvalid(parseGitHubPullRequestUrl('https://github.com/egawilldoit/ShipLoop'));
  expectInvalid(parseGitHubPullRequestUrl('https://github.com/egawilldoit/ShipLoop/tree/main'));
  expectInvalid(parseGitHubPullRequestUrl('https://github.com/egawilldoit/ShipLoop/pull/not-a-number'));
  expectInvalid(parseGitHubPullRequestUrl('https://github.com/egawilldoit/ShipLoop/pull/7/unexpected'));
});

test('an empty link is refused with the shape of a real one named', () => {
  const refusal = expectInvalid(parseGitHubPullRequestUrl('   '));
  assert.equal(refusal.fields[0]?.path, 'pullRequestUrl');
  assert.match(refusal.fields[0]?.message ?? '', /pull\/1/);
});

test('a pull request number alone is refused: it is not identity and proves nothing exists', () => {
  const refusal = expectInvalid(parseGitHubPullRequestUrl('7'));
  assert.match(refusal.fields[0]?.message ?? '', /not github\.com|not a github\.com/);
});

test('repository names compare case-insensitively but a different owner is a different repository', () => {
  assert.equal(sameGitHubRepository('egawilldoit/ShipLoop', 'EGAWILLDOIT/shiploop'), true);
  assert.equal(sameGitHubRepository('egawilldoit/ShipLoop', 'someone-else/ShipLoop'), false);
  assert.equal(sameGitHubRepository('egawilldoit/ShipLoop', 'egawilldoit/ShipLoop-fork'), false);
});

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

test('a full commit SHA is accepted and preserved exactly', () => {
  assert.equal(expectOk(requireFullCommitSha(HEAD, 'headSha')), HEAD);
  assert.equal(HEAD.length, 40);
});

test('an abbreviated SHA, a branch name and a pull request number are each refused as identity', () => {
  for (const abbreviation of ['1f0c2a9d3b6', 'main', 'task/mvp', '7', 'refs/heads/main', '']) {
    const refusal = expectInvalid(requireFullCommitSha(abbreviation, 'headSha'));
    assert.equal(refusal.fields[0]?.path, 'headSha');
  }
});

test('a candidate binds to its contract revision and full head SHA, and nothing display-shaped', () => {
  const candidate: DeliveryCandidate = {
    candidateId: 'candidate-binding-01' as DeliveryCandidate['candidateId'],
    projectId: 'project-01' as ProjectId,
    requestId: 'request-01',
    contractId: 'contract-01',
    contractRevision: 3,
    provider: 'github',
    repository: 'egawilldoit/ShipLoop',
    pullRequestNumber: 7,
    pullRequestUrl: 'https://github.com/egawilldoit/ShipLoop/pull/7',
    baseBranch: 'main',
    baseSha: BASE,
    headBranch: 'task/mvp',
    headSha: HEAD,
    pullRequestState: 'Open',
    draft: false,
    observedAt: '2026-10-01T00:00:00.000Z',
    linkedAt: '2026-10-01T00:00:00.000Z',
  };
  const binding = candidateBindingOf(candidate);
  assert.deepEqual(binding, { contractId: 'contract-01', contractRevision: 3, headSha: HEAD });
  // The binding value is a function of identity alone: renaming a branch or renumbering
  // nothing may not change it, while a different head must.
  assert.equal(candidateBindingFingerprint(binding), candidateBindingFingerprint(binding));
  assert.notEqual(
    candidateBindingFingerprint(binding),
    candidateBindingFingerprint({ contractId: 'contract-01', contractRevision: 3, headSha: NEXT_HEAD }),
  );
  assert.notEqual(
    candidateBindingFingerprint(binding),
    candidateBindingFingerprint({ contractId: 'contract-01', contractRevision: 4, headSha: HEAD }),
  );
});

test('evidence bound to one head SHA can never prove another, and a prefix match does not help', () => {
  const current = { contractId: 'contract-01', contractRevision: 1, headSha: HEAD };
  assert.deepEqual(
    evidenceBindingVerdict({ contractId: 'contract-01', contractRevision: 1, headSha: HEAD }, current),
    { stale: false, exact: true, reasons: [] },
  );
  // The same commit at a different contract revision is a different question.
  const otherRevision = evidenceBindingVerdict(
    { contractId: 'contract-01', contractRevision: 2, headSha: HEAD },
    current,
  );
  assert.equal(otherRevision.stale, true);
  assert.deepEqual(otherRevision.reasons, ['ContractSuperseded']);
  // An abbreviated SHA is not a match, however unambiguous it looks.
  const abbreviated = evidenceBindingVerdict(
    { contractId: 'contract-01', contractRevision: 1, headSha: HEAD.slice(0, 12) },
    current,
  );
  assert.equal(abbreviated.stale, true);
  assert.equal(abbreviated.exact, false);
  assert.deepEqual(abbreviated.reasons, ['HeadSuperseded']);
  // Both differ at once: both reasons are reported rather than the first.
  const both = evidenceBindingVerdict(
    { contractId: 'contract-09', contractRevision: 9, headSha: NEXT_HEAD },
    current,
  );
  assert.deepEqual(both.reasons, ['ContractSuperseded', 'HeadSuperseded']);
});

/* -------------------------------------------------------------------------- */
/* Change detection                                                            */
/* -------------------------------------------------------------------------- */

test('an unchanged pull request reports no change and does not call prior evidence stale', () => {
  const change = detectCandidateChange(FACTS, { ...FACTS });
  assert.equal(change.kind, 'Unchanged');
  assert.deepEqual(change.changed, []);
  assert.equal(change.changedAnything, false);
  assert.equal(change.priorEvidenceStale, false);
  assert.equal(change.previousHeadSha, HEAD);
  assert.equal(change.currentHeadSha, HEAD);
});

test('a changed head is an explicit change that names both heads and invalidates prior evidence', () => {
  const change = detectCandidateChange(FACTS, { ...FACTS, headSha: NEXT_HEAD });
  assert.equal(change.kind, 'HeadChanged');
  assert.deepEqual(change.changed, ['HeadChanged']);
  assert.equal(change.priorEvidenceStale, true);
  assert.equal(change.previousHeadSha, HEAD);
  assert.equal(change.currentHeadSha, NEXT_HEAD);
  assert.match(change.detail, /1f0c2a9d3b6/);
  assert.match(change.detail, /7c6b5a493827/);
});

test('a closed pull request is a change, not a silently preserved ready candidate', () => {
  const change = detectCandidateChange(FACTS, { ...FACTS, pullRequestState: 'Closed' });
  assert.equal(change.kind, 'StateChanged');
  assert.equal(change.priorEvidenceStale, true);
});

test('every material difference is reported, most material first', () => {
  const change = detectCandidateChange(FACTS, {
    ...FACTS,
    headSha: NEXT_HEAD,
    pullRequestState: 'Merged',
    baseBranch: 'release',
  });
  assert.deepEqual(change.changed, ['HeadChanged', 'BaseBranchChanged', 'StateChanged']);
  assert.equal(change.kind, 'HeadChanged');
});

test('a retargeted base commit and a renamed head branch are changes too', () => {
  assert.deepEqual(
    detectCandidateChange(FACTS, { ...FACTS, baseSha: NEXT_HEAD }).changed,
    ['BaseChanged'],
  );
  assert.deepEqual(
    detectCandidateChange(FACTS, { ...FACTS, headBranch: 'task/renamed' }).changed,
    ['HeadBranchChanged'],
  );
  assert.deepEqual(detectCandidateChange(FACTS, { ...FACTS, draft: true }).changed, ['DraftChanged']);
  assert.deepEqual(
    detectCandidateChange(FACTS, { ...FACTS, repository: 'someone-else/ShipLoop' }).changed,
    ['RepositoryChanged'],
  );
  assert.deepEqual(
    detectCandidateChange(FACTS, { ...FACTS, pullRequestNumber: 8 }).changed,
    ['PullRequestChanged'],
  );
});

test('the first link has nothing to be stale against and does not claim the owner saw it before', () => {
  const change = detectCandidateChange(null, FACTS);
  assert.equal(change.changedAnything, false);
  assert.equal(change.priorEvidenceStale, false);
  assert.equal(change.previousHeadSha, null);
});

test('every declared change kind has a phrase, so a difference can never render as blank', () => {
  const reasons = new Set<string>();
  for (const kind of CANDIDATE_CHANGE_KINDS) {
    const change = detectCandidateChange(
      { ...FACTS },
      {
        ...FACTS,
        headSha: kind === 'HeadChanged' ? NEXT_HEAD : HEAD,
        baseSha: kind === 'BaseChanged' ? NEXT_HEAD : BASE,
        baseBranch: kind === 'BaseBranchChanged' ? 'other' : FACTS.baseBranch,
        headBranch: kind === 'HeadBranchChanged' ? 'other' : FACTS.headBranch,
        pullRequestState: kind === 'StateChanged' ? 'Closed' : FACTS.pullRequestState,
        draft: kind === 'DraftChanged',
        pullRequestNumber: kind === 'PullRequestChanged' ? 99 : FACTS.pullRequestNumber,
        repository: kind === 'RepositoryChanged' ? 'other/repo' : FACTS.repository,
      },
    );
    assert.equal(change.kind, kind, `${kind} should be reported first`);
    assert.ok(change.detail.length > 0, `${kind} must carry an owner-readable detail`);
    reasons.add(kind);
  }
  assert.equal(reasons.size, CANDIDATE_CHANGE_KINDS.length);
});

test('the state vocabulary is the three GitHub states, not a fourth invented value', () => {
  assert.deepEqual([...PULL_REQUEST_STATES], ['Open', 'Closed', 'Merged']);
});

/* -------------------------------------------------------------------------- */
/* Check mapping                                                               */
/* -------------------------------------------------------------------------- */

function fact(overrides: Partial<ProviderCheckFact> & { name: string; result: CheckResult }): ProviderCheckFact {
  return {
    required: true,
    observedHeadSha: HEAD,
    startedAt: '2026-10-01T00:00:00.000Z',
    endedAt: '2026-10-01T00:01:00.000Z',
    artifactUrl: null,
    detail: null,
    ...overrides,
  };
}

test('a passed check is passed, and only a passed check makes the candidate ready', () => {
  const checks = projectCandidateChecks([fact({ name: 'test', result: 'Passed' })], HEAD);
  assert.deepEqual(
    checks.map((check) => [check.name, check.result]),
    [['test', 'Passed']],
  );
  assert.equal(candidateChecksReady(checks), true);
  assert.deepEqual(blockingRequiredChecks(checks), []);
});

test('every non-passed result blocks: failed, waiting, missing, stale and not applicable', () => {
  const blocking: CheckResult[] = ['Failed', 'Waiting', 'Missing', 'Stale', 'NotApplicable'];
  for (const result of blocking) {
    const checks = projectCandidateChecks([fact({ name: 'test', result })], HEAD);
    assert.equal(checks[0]?.result, result, `${result} must survive projection unchanged`);
    assert.equal(candidateChecksReady(checks), false, `${result} must not be ready`);
    assert.deepEqual(blockingRequiredChecks(checks), [`test is ${result}`]);
  }
});

test('a skipped check reported as NotApplicable becomes ready only with a policy approval', () => {
  const skipped = projectCandidateChecks([fact({ name: 'deploy-preview', result: 'NotApplicable' })], HEAD);
  assert.equal(candidateChecksReady(skipped), false);
  const approved = projectCandidateChecks(
    [fact({ name: 'deploy-preview', result: 'NotApplicable', notApplicableApprovedByPolicy: true })],
    HEAD,
  );
  assert.equal(candidateChecksReady(approved), true);
});

test('a required check the provider never reported appears as Missing rather than being absent', () => {
  const checks = projectCandidateChecks([fact({ name: 'lint', result: 'Passed' })], HEAD, ['lint', 'build']);
  assert.deepEqual(
    checks.map((check) => [check.name, check.result, check.required]),
    [
      ['build', 'Missing', true],
      ['lint', 'Passed', true],
    ],
  );
  assert.equal(candidateChecksReady(checks), false);
  assert.deepEqual(blockingRequiredChecks(checks), ['build is Missing']);
  assert.match(checks[0]?.detail ?? '', /never ran is not a pass/);
});

test('a check reported against another commit is demoted to Stale even when it passed', () => {
  const checks = projectCandidateChecks(
    [fact({ name: 'test', result: 'Passed', observedHeadSha: NEXT_HEAD })],
    HEAD,
  );
  assert.equal(checks[0]?.result, 'Stale');
  assert.equal(candidateChecksReady(checks), false);
  assert.match(checks[0]?.detail ?? '', /7c6b5a493827/);
});

test('a check the provider could not attribute keeps its result, because the read was for this head', () => {
  const checks = projectCandidateChecks([fact({ name: 'test', result: 'Passed', observedHeadSha: null })], HEAD);
  assert.equal(checks[0]?.result, 'Passed');
  assert.equal(candidateChecksReady(checks), true);
});

test('a re-run check reports its current state, not the pass that preceded it', () => {
  const checks = projectCandidateChecks(
    [fact({ name: 'test', result: 'Passed' }), fact({ name: 'test', result: 'Waiting' })],
    HEAD,
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.result, 'Waiting');
  assert.equal(candidateChecksReady(checks), false);
});

test('an optional check never blocks and never appears ready on its own', () => {
  const checks = projectCandidateChecks([fact({ name: 'codecov', result: 'Failed', required: false })], HEAD);
  assert.equal(candidateChecksReady(checks), true);
  assert.deepEqual(blockingRequiredChecks(checks), []);
  assert.equal(checks[0]?.result, 'Failed');
});

test('the check list is ordered by name, so two reads of the same state compare equal', () => {
  const first = projectCandidateChecks(
    [fact({ name: 'unit', result: 'Passed' }), fact({ name: 'build', result: 'Failed' })],
    HEAD,
  );
  const second = projectCandidateChecks(
    [fact({ name: 'build', result: 'Failed' }), fact({ name: 'unit', result: 'Passed' })],
    HEAD,
  );
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((check) => check.name), ['build', 'unit']);
});
