import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { candidateFingerprint, classifyCheckFailure, fingerprint } from '@shiploop/domain';
import type { CandidateIdentityInput, Fingerprint } from '@shiploop/domain';
import {
  attributeCheckFailure,
  detectStaleness,
  evaluateCandidateReadiness,
  mapCheckOutcome,
  resolveRequiredChecks,
  runCheck,
} from './checks.ts';
import type {
  CheckExecutionRecord,
  CheckObservation,
  CheckOutcomeMappingInput,
  CheckPolicyContext,
  CheckRequest,
  CheckRunnerDeps,
  CommandRunOptions,
  CommandRunResult,
  CommandRunStatus,
  NotApplicableApproval,
  RecordedCheckIdentity,
  RequiredCheckPolicy,
} from './checks.ts';

const HEAD = 'a'.repeat(40) as CandidateIdentityInput['headSha'];
const BASE = 'b'.repeat(40) as CandidateIdentityInput['baseSha'];
const APPROVED_POLICY = fingerprint({ policy: 'owner-approved-v1' });
const PROPOSED_POLICY = fingerprint({ policy: 'proposed-v1' });
const REVISED_POLICY = fingerprint({ policy: 'proposed-v2' });
const SCOPE = fingerprint({ scope: 1 });
const ENVIRONMENT = fingerprint({ environment: 'vm-1' });
const MAX_OUTPUT = 65_536;

function identityFor(changed: Partial<CandidateIdentityInput> = {}): RecordedCheckIdentity {
  const resolved: CandidateIdentityInput = {
    headSha: HEAD,
    baseSha: BASE,
    scopeFingerprint: SCOPE,
    profileVersionId: 'profile-1',
    procedureVersionId: 'procedure-1',
    environmentFingerprint: ENVIRONMENT,
    policyFingerprint: PROPOSED_POLICY,
    ...changed,
  };
  return {
    candidateFingerprint: candidateFingerprint(resolved),
    headSha: resolved.headSha,
    baseSha: resolved.baseSha,
    scopeFingerprint: resolved.scopeFingerprint,
    environmentFingerprint: resolved.environmentFingerprint,
    policyFingerprint: resolved.policyFingerprint,
  };
}

function policy(input: {
  readonly requiredCheckIds: readonly string[];
  readonly approvals?: readonly NotApplicableApproval[];
  readonly policyFingerprint?: Fingerprint;
}): RequiredCheckPolicy {
  return {
    policyFingerprint: input.policyFingerprint ?? PROPOSED_POLICY,
    requiredCheckIds: input.requiredCheckIds,
    approvals: input.approvals ?? [],
    decidedBy: 'owner',
    decidedAt: '2026-09-30T10:00:00.000Z',
  };
}

function policyContext(requiredCheckIds: readonly string[]): CheckPolicyContext {
  return {
    approved: policy({ requiredCheckIds, policyFingerprint: APPROVED_POLICY }),
    proposed: policy({ requiredCheckIds }),
  };
}

function approvalFor(checkId: string, policyFingerprint: Fingerprint): NotApplicableApproval {
  return {
    checkId,
    policyFingerprint,
    approvedBy: 'owner',
    approvedAt: '2026-09-30T10:00:00.000Z',
    reason: 'Not part of this project profile.',
  };
}

function exited(exitCode: number | null): CheckObservation {
  return { kind: 'LocalExecution', status: 'Exited', exitCode };
}

function mappingInput(
  observation: CheckObservation,
  changed: Partial<CheckOutcomeMappingInput> = {},
): CheckOutcomeMappingInput {
  const identity = changed.identity ?? identityFor();
  return {
    observation,
    identity,
    currentCandidateFingerprint: identity.candidateFingerprint,
    currentPolicyFingerprint: identity.policyFingerprint,
    notApplicableRequested: false,
    notApplicableApproval: null,
    ...changed,
  };
}

function storedRecord(input: {
  readonly checkId: string;
  readonly result: CheckExecutionRecord['result'];
  readonly identity: RecordedCheckIdentity;
  readonly required?: boolean;
}): CheckExecutionRecord {
  return {
    checkId: input.checkId,
    name: input.checkId,
    origin: 'LocalCheck',
    required: input.required ?? true,
    result: input.result,
    candidateFingerprint: input.identity.candidateFingerprint,
    startedAt: '2026-09-30T10:00:00.000Z',
    endedAt: '2026-09-30T10:00:05.000Z',
    exitCode: input.result === 'Passed' ? 0 : 1,
    artifactRef: null,
    detail: null,
    notApplicableApprovedByPolicy: false,
    runStatus: 'Exited',
    identity: input.identity,
    notApplicableApproval: null,
    staleness: { stale: false, dimensions: [] },
  };
}

function fixedDeps(outcome: CommandRunResult, artifactName: string | null = null): CheckRunnerDeps {
  let tick = 0;
  return {
    run: async () => outcome,
    captureOutput: async (request) =>
      artifactName === null ? null : { name: `${artifactName}/${request.checkId}.log`, byteLength: request.output.length },
    now: () => `2026-09-30T10:00:0${tick++}.000Z`,
  };
}

function checkRequest(input: {
  readonly checkId?: string;
  readonly identity: RecordedCheckIdentity;
  readonly policy: CheckPolicyContext;
  readonly argv?: readonly string[];
  readonly timeoutMs?: number;
}): CheckRequest {
  return {
    checkId: input.checkId ?? 'typecheck',
    name: 'Type check',
    origin: 'LocalCheck',
    argv: input.argv ?? [process.execPath, '-e', 'process.exit(0)'],
    timeoutMs: input.timeoutMs ?? 30_000,
    cwd: process.cwd(),
    env: { PATH: '/usr/bin', CI: '1' },
    identity: input.identity,
    currentCandidateFingerprint: input.identity.candidateFingerprint,
    policy: input.policy,
  };
}

test('mapCheckOutcome maps every observable outcome to its honest result', () => {
  const cases: readonly { readonly observation: CheckObservation; readonly expected: string }[] = [
    { observation: exited(0), expected: 'Passed' },
    { observation: exited(1), expected: 'Failed' },
    { observation: exited(7), expected: 'Failed' },
    { observation: { kind: 'LocalExecution', status: 'TimedOut', exitCode: null }, expected: 'Failed' },
    { observation: { kind: 'LocalExecution', status: 'CouldNotStart', exitCode: null }, expected: 'Missing' },
    { observation: { kind: 'LocalExecution', status: 'Interrupted', exitCode: null }, expected: 'Missing' },
    { observation: { kind: 'LocalExecution', status: 'Exited', exitCode: null }, expected: 'Missing' },
    { observation: { kind: 'PrerequisiteAbsent' }, expected: 'Missing' },
    { observation: { kind: 'ProviderRun', providerStatus: 'Succeeded' }, expected: 'Passed' },
    { observation: { kind: 'ProviderRun', providerStatus: 'Failed' }, expected: 'Failed' },
    { observation: { kind: 'ProviderRun', providerStatus: 'InProgress' }, expected: 'Waiting' },
    { observation: { kind: 'ProviderRun', providerStatus: 'NotFound' }, expected: 'Missing' },
  ];
  for (const entry of cases) {
    const mapped = mapCheckOutcome(mappingInput(entry.observation));
    assert.equal(mapped.ok, true);
    assert.equal(mapped.ok ? mapped.value.result : 'error', entry.expected, JSON.stringify(entry.observation));
  }
});

test('a foreign candidate fingerprint makes even a passing observation Stale', () => {
  const recorded = identityFor();
  const current = identityFor({ headSha: 'c'.repeat(40) as CandidateIdentityInput['headSha'] });
  const mapped = mapCheckOutcome(mappingInput(exited(0), {
    identity: recorded,
    currentCandidateFingerprint: current.candidateFingerprint,
  }));
  assert.equal(mapped.ok, true);
  assert.equal(mapped.ok ? mapped.value.result : 'error', 'Stale');
  assert.deepEqual(mapped.ok ? mapped.value.staleness.dimensions : [], ['CandidateIdentity']);
});

test('NotApplicable is refused without a recorded approval and recorded with a current one', () => {
  const identity = identityFor();
  const withoutApproval = mapCheckOutcome(mappingInput({ kind: 'PolicyNotApplicable' }, {
    identity,
    currentPolicyFingerprint: PROPOSED_POLICY,
    notApplicableRequested: true,
    notApplicableApproval: null,
  }));
  assert.equal(withoutApproval.ok, false);
  assert.equal(withoutApproval.ok ? '' : withoutApproval.error.code, 'Forbidden');

  const superseded = mapCheckOutcome(mappingInput({ kind: 'PolicyNotApplicable' }, {
    identity,
    currentPolicyFingerprint: PROPOSED_POLICY,
    notApplicableRequested: true,
    notApplicableApproval: approvalFor('e2e-suite', APPROVED_POLICY),
  }));
  assert.equal(superseded.ok, false);
  assert.equal(superseded.ok ? '' : superseded.error.code, 'Forbidden');

  const current = approvalFor('e2e-suite', PROPOSED_POLICY);
  const allowed = mapCheckOutcome(mappingInput({ kind: 'PolicyNotApplicable' }, {
    identity,
    currentPolicyFingerprint: PROPOSED_POLICY,
    notApplicableRequested: true,
    notApplicableApproval: current,
  }));
  assert.equal(allowed.ok, true);
  assert.equal(allowed.ok ? allowed.value.result : 'error', 'NotApplicable');
  assert.deepEqual(allowed.ok ? allowed.value.notApplicableApproval : null, current);
});

test('agent text claiming a pass has no input into the mapping', () => {
  const agentText: Record<string, string> = {
    agentClaim: 'passed',
    claimedResult: 'Passed',
    narrative: 'All checks are green and approved by the agent.',
  };
  const unobserved = { ...mappingInput({ kind: 'LocalExecution', status: 'CouldNotStart', exitCode: null }), ...agentText };
  assert.deepEqual(Object.keys(unobserved).filter((key) => key in agentText), Object.keys(agentText));

  const claimedPass = mapCheckOutcome(unobserved);
  assert.equal(claimedPass.ok, true);
  assert.equal(claimedPass.ok ? claimedPass.value.result : 'error', 'Missing');

  const inFlight = {
    ...mappingInput({ kind: 'ProviderRun', providerStatus: 'InProgress' }),
    ...agentText,
  };
  const stillWaiting = mapCheckOutcome(inFlight);
  assert.equal(stillWaiting.ok, true);
  assert.equal(stillWaiting.ok ? stillWaiting.value.result : 'error', 'Waiting');
});

test('a required check with no recorded result blocks ready-for-delivery', () => {
  const identity = identityFor();
  const assessment = evaluateCandidateReadiness({
    policy: policyContext(['typecheck', 'policy-lint']),
    records: [storedRecord({ checkId: 'typecheck', result: 'Passed', identity })],
    currentCandidateFingerprint: identity.candidateFingerprint,
  });
  assert.equal(assessment.ok, true);
  if (!assessment.ok) return;
  assert.equal(assessment.value.ready, false);
  assert.deepEqual(assessment.value.required.map((entry) => entry.result), ['Passed', 'Missing']);
  assert.equal(assessment.value.blockingReasons.length, 1);
  assert.match(assessment.value.blockingReasons[0] ?? '', /policy-lint/);
});

test('a failed check the owner did not require does not block', () => {
  const identity = identityFor();
  const assessment = evaluateCandidateReadiness({
    policy: policyContext(['typecheck']),
    records: [
      storedRecord({ checkId: 'typecheck', result: 'Passed', identity }),
      storedRecord({ checkId: 'optional-lint', result: 'Failed', identity, required: false }),
    ],
    currentCandidateFingerprint: identity.candidateFingerprint,
  });
  assert.equal(assessment.ok, true);
  if (!assessment.ok) return;
  assert.equal(assessment.value.ready, true);
  assert.deepEqual(assessment.value.nonRequired.map((entry) => entry.result), ['Failed']);
  assert.deepEqual(assessment.value.blockingReasons, []);
});

test('each changed identity input makes the recorded result Stale and blocks delivery', () => {
  const changes: readonly { readonly name: string; readonly changed: Partial<CandidateIdentityInput> }[] = [
    { name: 'head', changed: { headSha: 'c'.repeat(40) as CandidateIdentityInput['headSha'] } },
    { name: 'base', changed: { baseSha: 'd'.repeat(40) as CandidateIdentityInput['baseSha'] } },
    { name: 'scope', changed: { scopeFingerprint: fingerprint({ scope: 2 }) } },
    { name: 'environment', changed: { environmentFingerprint: fingerprint({ environment: 'vm-2' }) } },
  ];
  for (const change of changes) {
    const recorded = identityFor();
    const current = identityFor(change.changed);
    const verdict = detectStaleness(recorded, current.candidateFingerprint, recorded.policyFingerprint);
    assert.deepEqual(verdict.dimensions, ['CandidateIdentity'], change.name);
    assert.equal(verdict.stale, true, change.name);

    const mapped = mapCheckOutcome(mappingInput(exited(0), {
      identity: recorded,
      currentCandidateFingerprint: current.candidateFingerprint,
    }));
    assert.equal(mapped.ok ? mapped.value.result : 'error', 'Stale', change.name);

    const assessment = evaluateCandidateReadiness({
      policy: policyContext(['typecheck']),
      records: [storedRecord({ checkId: 'typecheck', result: 'Passed', identity: recorded })],
      currentCandidateFingerprint: current.candidateFingerprint,
    });
    assert.equal(assessment.ok ? assessment.value.ready : true, false, change.name);
  }

  const recorded = identityFor();
  const policyChanged = detectStaleness(recorded, recorded.candidateFingerprint, REVISED_POLICY);
  assert.deepEqual(policyChanged.dimensions, ['Policy']);
  assert.equal(policyChanged.stale, true);
  const policyMapped = mapCheckOutcome(mappingInput(exited(0), {
    identity: recorded,
    currentPolicyFingerprint: REVISED_POLICY,
  }));
  assert.equal(policyMapped.ok ? policyMapped.value.result : 'error', 'Stale');
});

test('failure attribution is delegated to the domain and never waives a required check', () => {
  const inputs = [
    { failedOnCandidate: true, failedOnBaseSha: true, baseShaObserved: true },
    { failedOnCandidate: true, failedOnBaseSha: false, baseShaObserved: true },
    { failedOnCandidate: true, failedOnBaseSha: null, baseShaObserved: false },
  ] as const;
  for (const input of inputs) {
    const delegated = attributeCheckFailure(input);
    assert.deepEqual(delegated.classification, classifyCheckFailure(input));
    assert.equal(delegated.waivesRequiredCheck, false);
  }
  assert.equal(attributeCheckFailure(inputs[0]).classification.attribution, 'PresentOnBase');
  assert.equal(attributeCheckFailure(inputs[1]).classification.attribution, 'IntroducedByChange');

  const identity = identityFor();
  const assessment = evaluateCandidateReadiness({
    policy: policyContext(['typecheck']),
    records: [storedRecord({ checkId: 'typecheck', result: 'Failed', identity })],
    currentCandidateFingerprint: identity.candidateFingerprint,
  });
  assert.equal(assessment.ok ? assessment.value.ready : true, false);
});

test('a policy that removes or downgrades an owner-required check is refused', () => {
  const removed = resolveRequiredChecks({
    approved: policy({ requiredCheckIds: ['typecheck', 'policy-lint'], policyFingerprint: APPROVED_POLICY }),
    proposed: policy({ requiredCheckIds: ['typecheck'] }),
  });
  assert.equal(removed.ok, false);
  assert.equal(removed.ok ? '' : removed.error.code, 'Forbidden');

  const downgraded = resolveRequiredChecks({
    approved: policy({ requiredCheckIds: ['typecheck'], policyFingerprint: APPROVED_POLICY }),
    proposed: policy({ requiredCheckIds: ['typecheck'], approvals: [approvalFor('typecheck', PROPOSED_POLICY)] }),
  });
  assert.equal(downgraded.ok, false);
  assert.equal(downgraded.ok ? '' : downgraded.error.code, 'Forbidden');

  const widened = resolveRequiredChecks({
    approved: policy({ requiredCheckIds: ['typecheck'], policyFingerprint: APPROVED_POLICY }),
    proposed: policy({ requiredCheckIds: ['typecheck', 'extra-gate'] }),
  });
  assert.equal(widened.ok, true);
  assert.deepEqual(widened.ok ? widened.value.requiredCheckIds : [], ['typecheck', 'extra-gate']);
});

test('runCheck records a bounded real run at exit 0 and at a nonzero exit', async () => {
  const identity = identityFor();
  const context = policyContext(['exit-zero', 'exit-seven', 'exit-missing', 'exit-hang']);
  const deps: CheckRunnerDeps = {
    run: realCommandRunner,
    captureOutput: async (request) => ({ name: `logs/${request.checkId}.log`, byteLength: request.output.length }),
    now: (() => {
      let tick = 0;
      return () => `2026-09-30T10:00:0${tick++}.000Z`;
    })(),
  };

  const zero = await runCheck(
    checkRequest({ checkId: 'exit-zero', identity, policy: context, argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 5_000 }),
    deps,
  );
  assert.equal(zero.ok, true);
  if (!zero.ok) return;
  assert.equal(zero.value.result, 'Passed');
  assert.equal(zero.value.exitCode, 0);
  assert.equal(zero.value.runStatus, 'Exited');
  assert.equal(zero.value.required, true);
  assert.equal(zero.value.startedAt, '2026-09-30T10:00:00.000Z');
  assert.equal(zero.value.endedAt, '2026-09-30T10:00:01.000Z');
  assert.equal(zero.value.candidateFingerprint, identity.candidateFingerprint);
  assert.match(zero.value.artifactRef ?? '', /^logs\/exit-zero\.log$/);

  const seven = await runCheck(
    checkRequest({
      checkId: 'exit-seven',
      identity,
      policy: context,
      argv: [process.execPath, '-e', 'console.error("assertion failed: nope"); process.exit(7)'],
      timeoutMs: 5_000,
    }),
    deps,
  );
  assert.equal(seven.ok, true);
  if (!seven.ok) return;
  assert.equal(seven.value.result, 'Failed');
  assert.equal(seven.value.exitCode, 7);
  assert.match(seven.value.detail ?? '', /assertion failed: nope/);

  const absent = await runCheck(
    checkRequest({ checkId: 'exit-missing', identity, policy: context, argv: ['shiploop-no-such-check-binary'], timeoutMs: 5_000 }),
    deps,
  );
  assert.equal(absent.ok, true);
  if (!absent.ok) return;
  assert.equal(absent.value.result, 'Missing');
  assert.equal(absent.value.runStatus, 'CouldNotStart');
  assert.match(absent.value.detail ?? '', /ENOENT/);

  const assessment = evaluateCandidateReadiness({
    policy: context,
    records: [absent.value],
    currentCandidateFingerprint: identity.candidateFingerprint,
  });
  assert.equal(assessment.ok ? assessment.value.ready : true, false);

  const overrun = await runCheck(
    checkRequest({
      checkId: 'exit-hang',
      identity,
      policy: context,
      argv: [process.execPath, '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 50)'],
      timeoutMs: 250,
    }),
    deps,
  );
  assert.equal(overrun.ok, true);
  if (!overrun.ok) return;
  assert.equal(overrun.value.result, 'Failed');
  assert.equal(overrun.value.runStatus, 'TimedOut');
});

test('runCheck treats an interrupted or absent prerequisite as Missing, never Passed', async () => {
  const identity = identityFor();
  const outcome: CommandRunResult = {
    status: 'CouldNotStart',
    exitCode: null,
    signal: null,
    output: '',
    outputTruncated: false,
    durationMs: 2,
    detail: 'ENOENT: no such file or directory',
  };
  const missing = await runCheck(checkRequest({ identity, policy: policyContext(['typecheck']) }), fixedDeps(outcome));
  assert.equal(missing.ok, true);
  if (!missing.ok) return;
  assert.equal(missing.value.result, 'Missing');
  assert.equal(missing.value.exitCode, null);
  assert.match(missing.value.detail ?? '', /could not start/);
});

test('runCheck redacts a seeded secret from the stored detail and the artifact name', async () => {
  const openaiKey = ['sk', 'proj', 'q'.repeat(24)].join('-');
  const githubToken = ['ghp', 'p'.repeat(36)].join('_');
  const identity = identityFor();
  const deps: CheckRunnerDeps = {
    run: async () => ({
      status: 'Exited' as CommandRunStatus,
      exitCode: 1,
      signal: null,
      output: `authentication failed for ${openaiKey} using ${githubToken}`,
      outputTruncated: false,
      durationMs: 3,
      detail: null,
    }),
    captureOutput: async (request) => ({
      name: `logs/${request.checkId}-${openaiKey}.log`,
      byteLength: request.output.length,
    }),
    now: () => '2026-09-30T10:00:00.000Z',
  };

  const result = await runCheck(checkRequest({ identity, policy: policyContext(['typecheck']) }), deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.result, 'Failed');
  const stored = `${result.value.detail ?? ''}\n${result.value.artifactRef ?? ''}`;
  assert.equal(stored.includes(openaiKey), false);
  assert.equal(stored.includes(githubToken), false);
  assert.match(stored, /\[redacted:openai-key\]/);
  assert.match(stored, /\[redacted:github-token\]/);
});

test('runCheck does not execute a check that policy approved as NotApplicable', async () => {
  const identity = identityFor();
  let spawnCount = 0;
  const deps: CheckRunnerDeps = {
    run: async () => {
      spawnCount += 1;
      return { status: 'Exited', exitCode: 0, signal: null, output: '', outputTruncated: false, durationMs: 1, detail: null };
    },
    captureOutput: async () => null,
    now: () => '2026-09-30T10:00:00.000Z',
  };
  const context: CheckPolicyContext = {
    approved: policy({ requiredCheckIds: ['typecheck'], policyFingerprint: APPROVED_POLICY }),
    proposed: policy({
      requiredCheckIds: ['typecheck', 'flaky-browser-suite'],
      approvals: [approvalFor('flaky-browser-suite', PROPOSED_POLICY)],
    }),
  };
  const result = await runCheck(checkRequest({ checkId: 'flaky-browser-suite', identity, policy: context }), deps);
  assert.equal(spawnCount, 0);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.result, 'NotApplicable');
  assert.equal(result.value.notApplicableApprovedByPolicy, true);
  assert.notEqual(result.value.notApplicableApproval, null);
  assert.equal(result.value.runStatus, null);
});

test('runCheck refuses an unusable deadline and an empty command', async () => {
  const identity = identityFor();
  const deps = fixedDeps({
    status: 'Exited',
    exitCode: 0,
    signal: null,
    output: '',
    outputTruncated: false,
    durationMs: 1,
    detail: null,
  });
  const unbounded = await runCheck(checkRequest({ identity, policy: policyContext(['typecheck']), timeoutMs: 0 }), deps);
  assert.equal(unbounded.ok, false);
  assert.equal(unbounded.ok ? '' : unbounded.error.code, 'Invalid');

  const empty = await runCheck(checkRequest({ identity, policy: policyContext(['typecheck']), argv: [] }), deps);
  assert.equal(empty.ok, false);
  assert.equal(empty.ok ? '' : empty.error.code, 'Invalid');

  const refusedPolicy = await runCheck(checkRequest({
    identity,
    policy: {
      approved: policy({ requiredCheckIds: ['typecheck'], policyFingerprint: APPROVED_POLICY }),
      proposed: policy({ requiredCheckIds: [] }),
    },
  }), deps);
  assert.equal(refusedPolicy.ok, false);
  assert.equal(refusedPolicy.ok ? '' : refusedPolicy.error.code, 'Forbidden');
});

/**
 * A real short-lived subprocess behind the injected port, so the mapping is proven
 * against an actual exit status rather than a fabricated one. The command is an
 * argument array with no shell, the spawned process group is tracked at spawn and
 * killed only when owned, and both the deadline and the retained output are bounded.
 */
function realCommandRunner(argv: readonly string[], options: CommandRunOptions): Promise<CommandRunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(argv[0] === 'node' ? process.execPath : (argv[0] ?? ''), argv.slice(1), {
      cwd: options.cwd,
      env: { ...options.env },
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let exitCode: number | null = null;

    const finish = (status: CommandRunStatus, detail: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          settled = true;
        }
      }
      resolve({
        status,
        exitCode,
        signal: null,
        output: Buffer.concat(chunks).toString('utf8'),
        outputTruncated: bytes > MAX_OUTPUT,
        durationMs: Date.now() - started,
        detail,
      });
    };

    const capture = (chunk: Buffer): void => {
      const remaining = MAX_OUTPUT - bytes;
      if (remaining <= 0) return;
      chunks.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.length, remaining);
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      finish('TimedOut', null);
    }, options.timeoutMs);

    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', (error: Error & { code?: string }) => {
      finish('CouldNotStart', `${error.code ?? 'ERROR'}: ${error.message}`);
    });
    child.once('close', (code) => {
      exitCode = code;
      finish(timedOut ? 'TimedOut' : 'Exited', null);
    });
  });
}
