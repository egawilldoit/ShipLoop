import assert from 'node:assert/strict';
import test from 'node:test';

import { asFingerprint, asCommitSha } from '@shiploop/domain';
import type { OwnerId } from '@shiploop/domain';
import type { CheckPolicyContext, CheckRunnerDeps } from './checks.ts';
import type { CheckCommand } from './recipe.ts';
import {
  outcomeForProviderStatus,
  recordBrowserCommand,
  recordGitHubProjection,
  recordOwnerTestEvidence,
  recordProjectCommand,
} from './mvp-sources.ts';
import type { GitHubCandidateProjection, GitHubCheckProjection, MvpBrowserCommandRequest, MvpCommandRequest } from './mvp-sources.ts';

const HEAD = asCommitSha('a'.repeat(40));
const OTHER_HEAD = asCommitSha('b'.repeat(40));
const POLICY_FP = asFingerprint('fp_' + '1'.repeat(32));
const CANDIDATE_FP = asFingerprint('fp_' + '2'.repeat(32));
const ENV_FP = asFingerprint('fp_' + '3'.repeat(32));
const OWNER = 'own-1' as OwnerId;
const SCOPE_FP = asFingerprint('fp_' + '4'.repeat(32));

const POLICY: CheckPolicyContext = {
  approved: { policyFingerprint: POLICY_FP, requiredCheckIds: [], approvals: [], decidedBy: 'own-1', decidedAt: '2026-10-01T00:00:00Z' },
  proposed: { policyFingerprint: POLICY_FP, requiredCheckIds: ['lint'], approvals: [], decidedBy: 'own-1', decidedAt: '2026-10-01T00:00:00Z' },
};

const IDENTITY = {
  candidateFingerprint: CANDIDATE_FP,
  headSha: HEAD,
  baseSha: asCommitSha('c'.repeat(40)),
  scopeFingerprint: SCOPE_FP,
  environmentFingerprint: ENV_FP,
  policyFingerprint: POLICY_FP,
};

const CHECK: CheckCommand = {
  id: 'lint',
  name: 'lint',
  required: true,
  command: { argv: ['node', '--version'], timeoutMs: 5_000, maxOutputBytes: 4_096, cwd: null },
};

function depsReturning(exitCode: number | null, status: 'Exited' | 'CouldNotStart' = 'Exited'): CheckRunnerDeps {
  return {
    run: async () => ({
      status,
      exitCode,
      signal: null,
      output: exitCode === 0 ? 'ok' : 'lint failed',
      outputTruncated: false,
      durationMs: 5,
      detail: null,
    }),
    captureOutput: async () => ({ name: 'out.txt', byteLength: 2 }),
    now: () => '2026-10-03T10:00:00Z',
  };
}

function commandRequest(overrides: Partial<MvpCommandRequest> = {}): MvpCommandRequest {
  return {
    candidateId: 'cand-1',
    contractId: 'contract-1',
    contractRevision: 2,
    headSha: HEAD,
    check: CHECK,
    identity: IDENTITY,
    currentCandidateFingerprint: CANDIDATE_FP,
    policy: POLICY,
    cwd: '/tmp/work',
    env: { PATH: '/usr/bin' },
    observedAt: '2026-10-03T10:00:00Z',
    evidenceId: 'evid-lint-1',
    ...overrides,
  };
}

function providerCheck(overrides: Partial<GitHubCheckProjection> = {}): GitHubCheckProjection {
  return {
    checkId: 'build',
    name: 'build',
    status: 'success',
    headSha: HEAD,
    startedAt: '2026-10-03T09:00:00Z',
    completedAt: '2026-10-03T09:05:00Z',
    detailUrl: 'https://example.invalid/runs/1',
    summary: 'ok',
    ...overrides,
  };
}

function projection(checks: readonly GitHubCheckProjection[]): GitHubCandidateProjection {
  return {
    candidateId: 'cand-1',
    contractId: 'contract-1',
    contractRevision: 2,
    headSha: HEAD,
    checks,
    observedAt: '2026-10-03T09:06:00Z',
  };
}

test('a passing configured project command becomes passed evidence bound to the SHA', async () => {
  const recorded = await recordProjectCommand(commandRequest(), depsReturning(0));
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.value.outcome, 'passed');
  assert.equal(recorded.value.source, 'project_command');
  assert.equal(recorded.value.binding?.candidateHeadSha, HEAD);
  assert.equal(recorded.value.binding?.contractRevision, 2);
  assert.equal(recorded.value.binding?.observedAt, '2026-10-03T10:00:00Z');
});

test('a failing configured command becomes failed, not missing', async () => {
  const recorded = await recordProjectCommand(commandRequest(), depsReturning(1));
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.value.outcome, 'failed');
});

test('a command that could not start is missing, not a failure and not a pass', async () => {
  const recorded = await recordProjectCommand(commandRequest(), depsReturning(null, 'CouldNotStart'));
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.value.outcome, 'missing');
});

test('a check that ran under another candidate identity binds to nothing', async () => {
  const recorded = await recordProjectCommand(
    commandRequest({ identity: { ...IDENTITY, headSha: OTHER_HEAD } }),
    depsReturning(0),
  );
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.value.binding, null);
  assert.match(recorded.value.detail ?? '', /different candidate identity/);
});

test('an unbounded recipe command is refused rather than defaulted', async () => {
  const unbounded: CheckCommand = { ...CHECK, command: { ...CHECK.command, timeoutMs: null } };
  const recorded = await recordProjectCommand(commandRequest({ check: unbounded }), depsReturning(0));
  assert.equal(recorded.ok, false);
  if (recorded.ok) return;
  assert.equal(recorded.error.code, 'Invalid');
});

test('a successful provider check binds to the candidate and passes', () => {
  const recorded = recordGitHubProjection({
    projection: projection([providerCheck()]),
    target: { candidateId: 'cand-1', contractId: 'contract-1', contractRevision: 2, headSha: HEAD },
    evidenceIdFor: (check) => `evid-gh-${check.checkId}`,
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.value[0]?.outcome, 'passed');
  assert.equal(recorded.value[0]?.source, 'github_check');
  assert.equal(recorded.value[0]?.binding?.candidateHeadSha, HEAD);
});

test('green CI from an older commit binds to nothing and reads stale downstream', () => {
  const recorded = recordGitHubProjection({
    projection: projection([providerCheck({ headSha: OTHER_HEAD })]),
    target: { candidateId: 'cand-1', contractId: 'contract-1', contractRevision: 2, headSha: HEAD },
    evidenceIdFor: (check) => `evid-gh-${check.checkId}`,
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.value[0]?.outcome, 'passed');
  assert.equal(recorded.value[0]?.binding, null);
  assert.match(recorded.value[0]?.detail ?? '', /not evidence about this candidate/);
});

test('a provider check the provider skipped or declined is missing, never passed', () => {
  assert.equal(outcomeForProviderStatus('skipped'), 'missing');
  assert.equal(outcomeForProviderStatus('neutral'), 'missing');
  assert.equal(outcomeForProviderStatus('pending'), 'waiting');
  assert.equal(outcomeForProviderStatus('failure'), 'failed');
});

test('a skipped required provider check records as missing evidence', () => {
  const recorded = recordGitHubProjection({
    projection: projection([providerCheck({ status: 'skipped' })]),
    target: { candidateId: 'cand-1', contractId: 'contract-1', contractRevision: 2, headSha: HEAD },
    evidenceIdFor: (check) => `evid-gh-${check.checkId}`,
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.value[0]?.outcome, 'missing');
  assert.notEqual(recorded.value[0]?.binding, null);
});

test('a browser command verifies the criterion it was configured for, not a check', async () => {
  const request: MvpBrowserCommandRequest = { ...commandRequest(), criterionId: 'login-works', evidenceId: 'evid-browser-1' };
  const recorded = await recordBrowserCommand(request, depsReturning(0));
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.value.source, 'browser');
  assert.deepEqual(recorded.value.subject, { kind: 'criterion', criterionId: 'login-works' });
  assert.equal(recorded.value.method.kind, 'BrowserEvidence');
  assert.equal(recorded.value.outcome, 'passed');
});

test('an agent cannot record an owner test: the non-owner role carries no identity', () => {
  const recorded = recordOwnerTestEvidence({
    actor: { role: 'agent' },
    candidateId: 'cand-1',
    contractId: 'contract-1',
    contractRevision: 2,
    headSha: HEAD,
    criterionId: 'looks-right',
    evidenceId: 'evid-owner-1',
    observedAt: '2026-10-03T10:00:00Z',
    outcome: 'passed',
    detail: null,
    artifactRef: null,
  });
  assert.equal(recorded.ok, false);
  if (recorded.ok) return;
  assert.equal(recorded.error.code, 'Forbidden');
});

test('a failed owner test binds to the owner and reports failure', () => {
  const recorded = recordOwnerTestEvidence({
    actor: { role: 'owner', ownerId: OWNER },
    candidateId: 'cand-1',
    contractId: 'contract-1',
    contractRevision: 2,
    headSha: HEAD,
    criterionId: 'looks-right',
    evidenceId: 'evid-owner-1',
    observedAt: '2026-10-03T10:00:00Z',
    outcome: 'failed',
    detail: 'the save button does nothing',
    artifactRef: 'owner-1.png',
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.value.outcome, 'failed');
  assert.equal(recorded.value.source, 'owner_test');
  assert.equal(recorded.value.binding?.candidateHeadSha, HEAD);
});

test('a failed capture is its own outcome so it cannot read as a behaviour failure', () => {
  const recorded = recordOwnerTestEvidence({
    actor: { role: 'owner', ownerId: OWNER },
    candidateId: 'cand-1',
    contractId: 'contract-1',
    contractRevision: 2,
    headSha: HEAD,
    criterionId: 'looks-right',
    evidenceId: 'evid-owner-1',
    observedAt: '2026-10-03T10:00:00Z',
    outcome: 'capture_failed',
    detail: null,
    artifactRef: null,
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.value.outcome, 'capture_failed');
});

test('an owner test against an abbreviated SHA binds to nothing', () => {
  const recorded = recordOwnerTestEvidence({
    actor: { role: 'owner', ownerId: OWNER },
    candidateId: 'cand-1',
    contractId: 'contract-1',
    contractRevision: 2,
    headSha: 'abc1234',
    criterionId: 'looks-right',
    evidenceId: 'evid-owner-1',
    observedAt: '2026-10-03T10:00:00Z',
    outcome: 'passed',
    detail: null,
    artifactRef: null,
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.value.binding, null);
});

test('a redacted check detail never reaches the recorded evidence verbatim', async () => {
  const deps: CheckRunnerDeps = {
    run: async () => ({
      status: 'Exited',
      exitCode: 1,
      signal: null,
      output: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      outputTruncated: false,
      durationMs: 5,
      detail: null,
    }),
    captureOutput: async () => ({ name: 'out.txt', byteLength: 2 }),
    now: () => '2026-10-03T10:00:00Z',
  };
  const recorded = await recordProjectCommand(commandRequest(), deps);
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.ok(!(recorded.value.detail ?? '').includes('abcdefghijklmnopqrstuvwxyz012345'));
});