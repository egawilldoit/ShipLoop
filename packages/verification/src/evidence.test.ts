import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateFingerprint, fingerprint } from '@shiploop/domain';
import type { CandidateIdentity, EvidenceId } from '@shiploop/domain';
import type { CheckExecutionRecord, RecordedCheckIdentity } from './checks.ts';
import { observationForCheck } from './evidence.ts';
import { buildEvidencePack } from './evidence.ts';
import type {
  CriterionRequirement,
  EligiblePreview,
  EvidenceArtifact,
  EvidencePackInput,
  ObservationInput,
  SanitizedApiExchange,
} from './evidence.ts';

const HEAD = 'a'.repeat(40) as CandidateIdentity['headSha'];
const BASE = 'b'.repeat(40) as CandidateIdentity['baseSha'];
const SCOPE = fingerprint({ criteria: ['F23-AC1'] });
const ENVIRONMENT = fingerprint({ environment: 'vm-1' });
const POLICY = fingerprint({ policy: 'proposed-v1' });
const WEB_DEPLOYMENT = 'dep_web_0001';

/** The domain brands evidence identity but ships no constructor for it. */
const evidenceId = (value: string): EvidenceId => value as EvidenceId;

const IDENTITY: CandidateIdentity = {
  headSha: HEAD,
  baseSha: BASE,
  scopeFingerprint: SCOPE,
  profileVersionId: 'profile-1',
  procedureVersionId: 'procedure-1',
  environmentFingerprint: ENVIRONMENT,
  policyFingerprint: POLICY,
  components: [
    { component: 'web', deploymentId: WEB_DEPLOYMENT, deploymentUrl: 'https://preview.example/dep_web_0001', environment: 'preview' },
  ],
};

const CANDIDATE = candidateFingerprint(IDENTITY);
const ELIGIBLE_PREVIEW: EligiblePreview = {
  component: 'web',
  deploymentId: WEB_DEPLOYMENT,
  environment: 'preview',
  candidateFingerprint: CANDIDATE,
};

function requirement(input: {
  readonly criterionId: string;
  readonly method: CriterionRequirement['method'];
  readonly requiresDeployedObservation?: boolean;
}): CriterionRequirement {
  return {
    criterionId: input.criterionId,
    text: `Criterion ${input.criterionId} is satisfied.`,
    method: input.method,
    requiresDeployedObservation: input.requiresDeployedObservation ?? false,
  };
}

function observation(input: {
  readonly criterionId: string;
  readonly evidence: string;
  readonly behavior?: ObservationInput['observation'];
  readonly environment?: ObservationInput['environment'];
  readonly deploymentId?: string | null;
  readonly artifacts?: readonly EvidenceArtifact[];
  readonly apiExchange?: SanitizedApiExchange | null;
  readonly detail?: string | null;
}): ObservationInput {
  return {
    criterionId: input.criterionId,
    evidenceId: evidenceId(input.evidence),
    observation: input.behavior ?? 'BehaviorConfirmed',
    environment: input.environment ?? 'Local',
    capturedAt: '2026-09-30T10:05:00.000Z',
    component: 'web',
    deploymentId: input.deploymentId ?? null,
    artifacts: input.artifacts ?? [],
    apiExchange: input.apiExchange ?? null,
    detail: input.detail ?? null,
  };
}

function pack(input: {
  readonly requirements: readonly CriterionRequirement[];
  readonly observations?: readonly ObservationInput[];
  readonly eligiblePreview?: EligiblePreview | null;
}): ReturnType<typeof buildEvidencePack> {
  const packInput: EvidencePackInput = {
    bundleId: 'bundle-1',
    correlationId: 'corr-9f2c',
    identity: IDENTITY,
    eligiblePreview: input.eligiblePreview === undefined ? ELIGIBLE_PREVIEW : input.eligiblePreview,
    requirements: input.requirements,
    observations: input.observations ?? [],
  };
  return buildEvidencePack(packInput);
}

function checkRecord(result: CheckExecutionRecord['result'], identity?: Partial<RecordedCheckIdentity>): CheckExecutionRecord {
  const recorded: RecordedCheckIdentity = {
    candidateFingerprint: identity?.candidateFingerprint ?? CANDIDATE,
    headSha: HEAD,
    baseSha: BASE,
    scopeFingerprint: SCOPE,
    environmentFingerprint: ENVIRONMENT,
    policyFingerprint: POLICY,
    ...identity,
  };
  return {
    checkId: 'typecheck',
    name: 'Type check',
    origin: 'LocalCheck',
    required: true,
    result,
    candidateFingerprint: recorded.candidateFingerprint,
    startedAt: '2026-09-30T10:00:00.000Z',
    endedAt: '2026-09-30T10:00:04.000Z',
    exitCode: result === 'Passed' ? 0 : 1,
    artifactRef: 'logs/typecheck.log',
    detail: 'exit 0',
    notApplicableApprovedByPolicy: false,
    runStatus: 'Exited',
    identity: recorded,
    notApplicableApproval: null,
    staleness: { stale: false, dimensions: [] },
  };
}

test('a criterion with no observation is Untested or Missing, never Verified', () => {
  const bundle = pack({
    requirements: [
      requirement({ criterionId: 'AC-automated', method: { kind: 'AutomatedCheck', checkId: 'typecheck' } }),
      requirement({ criterionId: 'AC-untested', method: { kind: 'Untested', reason: 'No automated method exists for this criterion.' } }),
      requirement({ criterionId: 'AC-owner', method: { kind: 'OwnerTest', instructions: 'Click Save and confirm the toast.' } }),
    ],
    observations: [],
  });
  assert.equal(bundle.ok, true);
  if (!bundle.ok) return;
  assert.deepEqual(bundle.value.records.map((record) => record.status), ['Missing', 'Untested', 'PendingOwnerTest']);
  assert.equal(bundle.value.records.some((record) => record.status === 'Verified'), false);
  assert.deepEqual(bundle.value.unverifiedCriterionIds, ['AC-automated', 'AC-untested', 'AC-owner']);
  assert.deepEqual(bundle.value.records.map((record) => record.observation), [null, null, null]);
});

test('one green check verifies only the criterion it observes', () => {
  const bundle = pack({
    requirements: [
      requirement({ criterionId: 'AC-observed', method: { kind: 'AutomatedCheck', checkId: 'typecheck' } }),
      requirement({ criterionId: 'AC-unclaimed', method: { kind: 'AutomatedCheck', checkId: 'typecheck' } }),
    ],
    observations: [observation({ criterionId: 'AC-observed', evidence: 'ev-1' })],
  });
  assert.equal(bundle.ok, true);
  if (!bundle.ok) return;
  assert.deepEqual(bundle.value.records.map((record) => record.status), ['Verified', 'Missing']);
  assert.deepEqual(bundle.value.unverifiedCriterionIds, ['AC-unclaimed']);
  assert.equal(observationForCheck(checkRecord('Passed'), CANDIDATE, POLICY), 'BehaviorConfirmed');
  assert.equal(observationForCheck(checkRecord('Failed'), CANDIDATE, POLICY), 'BehaviorFailed');
  for (const result of ['Missing', 'Waiting', 'Stale', 'NotApplicable'] as const) {
    assert.equal(observationForCheck(checkRecord(result), CANDIDATE, POLICY), null, result);
  }
  const superseded = observationForCheck(
    checkRecord('Passed', { candidateFingerprint: fingerprint({ candidate: 'other' }) }),
    CANDIDATE,
    POLICY,
  );
  assert.equal(superseded, null);
});

test('a local observation cannot satisfy a criterion that requires deployed behaviour', () => {
  const requirements = [requirement({
    criterionId: 'AC-preview-flow',
    method: { kind: 'BrowserEvidence', evidenceId: 'ev-local' },
    requiresDeployedObservation: true,
  })];
  const local = pack({
    requirements,
    observations: [observation({
      criterionId: 'AC-preview-flow',
      evidence: 'ev-local',
      environment: 'Local',
      artifacts: [{ kind: 'Screenshot', name: 'ui/local-flow.png', capturedAt: '2026-09-30T10:05:00.000Z' }],
    })],
  });
  assert.equal(local.ok, true);
  if (!local.ok) return;
  assert.equal(local.value.records[0]?.status, 'Missing');
  assert.equal(local.value.records[0]?.environment, 'Local');
  assert.match(local.value.records[0]?.detail ?? '', /labelled local/);

  const againstPreview = pack({
    requirements,
    observations: [observation({
      criterionId: 'AC-preview-flow',
      evidence: 'ev-local',
      environment: 'Preview',
      deploymentId: WEB_DEPLOYMENT,
      artifacts: [{ kind: 'Screenshot', name: 'ui/preview-flow.png', capturedAt: '2026-09-30T10:05:00.000Z' }],
    })],
  });
  assert.equal(againstPreview.ok, true);
  if (!againstPreview.ok) return;
  assert.equal(againstPreview.value.records[0]?.status, 'Verified');

  const noPreview = pack({
    requirements,
    observations: [observation({
      criterionId: 'AC-preview-flow',
      evidence: 'ev-local',
      environment: 'Preview',
      deploymentId: WEB_DEPLOYMENT,
      artifacts: [{ kind: 'Screenshot', name: 'ui/preview-flow.png', capturedAt: '2026-09-30T10:05:00.000Z' }],
    })],
    eligiblePreview: null,
  });
  assert.equal(noPreview.ok, true);
  assert.equal(noPreview.ok ? noPreview.value.records[0]?.status : 'error', 'Missing');

  const otherDeployment = pack({
    requirements,
    observations: [observation({
      criterionId: 'AC-preview-flow',
      evidence: 'ev-local',
      environment: 'Preview',
      deploymentId: 'dep_web_0002',
      artifacts: [{ kind: 'Screenshot', name: 'ui/preview-flow.png', capturedAt: '2026-09-30T10:05:00.000Z' }],
    })],
  });
  assert.equal(otherDeployment.ok, true);
  assert.equal(otherDeployment.ok ? otherDeployment.value.records[0]?.status : 'error', 'Stale');

  const liveSmoke = pack({
    requirements,
    observations: [observation({
      criterionId: 'AC-preview-flow',
      evidence: 'ev-local',
      environment: 'LiveSmoke',
      deploymentId: WEB_DEPLOYMENT,
      artifacts: [{ kind: 'Screenshot', name: 'ui/preview-flow.png', capturedAt: '2026-09-30T10:05:00.000Z' }],
    })],
  });
  assert.equal(liveSmoke.ok, true);
  assert.equal(liveSmoke.ok ? liveSmoke.value.records[0]?.status : 'error', 'Stale');
});

test('a capture failure is recorded as a capture failure, not a behaviour failure', () => {
  const requirements = [requirement({ criterionId: 'AC-ui-flow', method: { kind: 'BrowserEvidence', evidenceId: 'ev-capture' } })];
  const captureFailed = pack({
    requirements,
    observations: [observation({
      criterionId: 'AC-ui-flow',
      evidence: 'ev-capture',
      behavior: 'CaptureFailed',
      detail: 'The browser closed before the screenshot was written.',
      artifacts: [],
    })],
  });
  assert.equal(captureFailed.ok, true);
  if (!captureFailed.ok) return;
  const captured = captureFailed.value.records[0];
  assert.equal(captured?.observation, 'CaptureFailed');
  assert.equal(captured?.status, 'Missing');
  assert.equal(captured?.evidenceId, evidenceId('ev-capture'));
  assert.match(captured?.detail ?? '', /capture failure, not a behaviour failure/);

  const behaviourFailed = pack({
    requirements,
    observations: [observation({
      criterionId: 'AC-ui-flow',
      evidence: 'ev-capture',
      behavior: 'BehaviorFailed',
      detail: 'The confirmation dialog never appeared.',
      artifacts: [{ kind: 'Screenshot', name: 'ui/flow.png', capturedAt: '2026-09-30T10:05:00.000Z' }],
    })],
  });
  assert.equal(behaviourFailed.ok, true);
  if (!behaviourFailed.ok) return;
  assert.equal(behaviourFailed.value.records[0]?.observation, 'BehaviorFailed');
  assert.equal(behaviourFailed.value.records[0]?.status, 'Failed');
  assert.notEqual(behaviourFailed.value.records[0]?.detail, captured?.detail);
});

test('a UI flow without a screenshot and API work without an exchange stay unverified', () => {
  const withoutScreenshot = pack({
    requirements: [requirement({ criterionId: 'AC-ui', method: { kind: 'BrowserEvidence', evidenceId: 'ev-ui' } })],
    observations: [observation({ criterionId: 'AC-ui', evidence: 'ev-ui', artifacts: [] })],
  });
  assert.equal(withoutScreenshot.ok, true);
  assert.equal(withoutScreenshot.ok ? withoutScreenshot.value.records[0]?.status : 'error', 'Missing');
  assert.match(withoutScreenshot.ok ? withoutScreenshot.value.records[0]?.detail ?? '' : '', /screenshot reference/);

  const withScreenshot = pack({
    requirements: [requirement({ criterionId: 'AC-ui', method: { kind: 'BrowserEvidence', evidenceId: 'ev-ui' } })],
    observations: [observation({
      criterionId: 'AC-ui',
      evidence: 'ev-ui',
      artifacts: [{ kind: 'Screenshot', name: 'ui/main-flow.png', capturedAt: '2026-09-30T10:05:00.000Z' }],
    })],
  });
  assert.equal(withScreenshot.ok, true);
  if (!withScreenshot.ok) return;
  assert.equal(withScreenshot.value.records[0]?.status, 'Verified');
  assert.deepEqual(
    Object.keys(withScreenshot.value.records[0]?.artifacts[0] ?? {}).sort(),
    ['capturedAt', 'kind', 'name'],
  );

  const withoutExchange = pack({
    requirements: [requirement({ criterionId: 'AC-api', method: { kind: 'ApiEvidence', evidenceId: 'ev-api' } })],
    observations: [observation({ criterionId: 'AC-api', evidence: 'ev-api' })],
  });
  assert.equal(withoutExchange.ok, true);
  assert.equal(withoutExchange.ok ? withoutExchange.value.records[0]?.status : 'error', 'Missing');

  const withExchange = pack({
    requirements: [requirement({ criterionId: 'AC-api', method: { kind: 'ApiEvidence', evidenceId: 'ev-api' } })],
    observations: [observation({
      criterionId: 'AC-api',
      evidence: 'ev-api',
      apiExchange: { request: 'POST /v1/work-items', result: '201 Created with id work_42' },
    })],
  });
  assert.equal(withExchange.ok, true);
  if (!withExchange.ok) return;
  assert.equal(withExchange.value.records[0]?.status, 'Verified');
  assert.equal(withExchange.value.records[0]?.apiExchange?.request, 'POST /v1/work-items');
});

test('every record carries scope revision, full commit, deployment identity, environment and time', () => {
  const bundle = pack({
    requirements: [requirement({
      criterionId: 'AC-preview',
      method: { kind: 'BrowserEvidence', evidenceId: 'ev-preview' },
      requiresDeployedObservation: true,
    })],
    observations: [observation({
      criterionId: 'AC-preview',
      evidence: 'ev-preview',
      environment: 'Preview',
      deploymentId: WEB_DEPLOYMENT,
      artifacts: [{ kind: 'Screenshot', name: 'ui/preview.png', capturedAt: '2026-09-30T10:05:00.000Z' }],
    })],
  });
  assert.equal(bundle.ok, true);
  if (!bundle.ok) return;
  const record = bundle.value.records[0];
  assert.equal(record?.status, 'Verified');
  assert.equal(record?.headSha, HEAD);
  assert.equal(record?.baseSha, BASE);
  assert.equal(record?.scopeFingerprint, SCOPE);
  assert.equal(record?.candidateFingerprint, CANDIDATE);
  assert.equal(record?.deploymentId, WEB_DEPLOYMENT);
  assert.equal(record?.component, 'web');
  assert.equal(record?.environment, 'Preview');
  assert.equal(record?.observedAt, '2026-09-30T10:05:00.000Z');
  assert.equal(record?.method.kind, 'BrowserEvidence');
  assert.deepEqual(bundle.value.criteria[0], {
    criterionId: 'AC-preview',
    method: record?.method,
    status: 'Verified',
    evidenceId: record?.evidenceId ?? null,
    candidateFingerprint: CANDIDATE,
    scopeFingerprint: SCOPE,
    observedAt: '2026-09-30T10:05:00.000Z',
  });
  assert.equal(bundle.value.correlationId, 'corr-9f2c');
  assert.equal(bundle.value.bundleId, 'bundle-1');
});

test('a seeded secret cannot leave the module through detail, artifact name or exchange body', () => {
  const openaiKey = ['sk', 'proj', 'z'.repeat(24)].join('-');
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'].join('.');
  const bundle = pack({
    requirements: [
      requirement({ criterionId: 'AC-ui', method: { kind: 'BrowserEvidence', evidenceId: 'ev-ui' } }),
      requirement({ criterionId: 'AC-api', method: { kind: 'ApiEvidence', evidenceId: 'ev-api' } }),
    ],
    observations: [
      observation({
        criterionId: 'AC-ui',
        evidence: 'ev-ui',
        detail: `screenshot captured with ${openaiKey}`,
        artifacts: [{ kind: 'Screenshot', name: `ui/main-flow-${openaiKey}.png`, capturedAt: '2026-09-30T10:05:00.000Z' }],
      }),
      observation({
        criterionId: 'AC-api',
        evidence: 'ev-api',
        behavior: 'BehaviorFailed',
        detail: `request rejected for token ${jwt}`,
        apiExchange: { request: `POST /v1/work-items with Bearer ${openaiKey}`, result: '401 Unauthorized' },
      }),
    ],
  });
  assert.equal(bundle.ok, true);
  if (!bundle.ok) return;
  const exported = JSON.stringify(bundle.value);
  assert.equal(exported.includes(openaiKey), false);
  assert.equal(exported.includes(jwt), false);
  assert.match(exported, /\[redacted:openai-key\]/);
  assert.match(exported, /\[redacted:jwt\]/);
});

test('a pack is refused when an observation, identity or method does not line up', () => {
  const unknownCriterion = pack({
    requirements: [requirement({ criterionId: 'AC-known', method: { kind: 'AutomatedCheck', checkId: 'typecheck' } })],
    observations: [observation({ criterionId: 'AC-other', evidence: 'ev-1' })],
  });
  assert.equal(unknownCriterion.ok, false);
  assert.equal(unknownCriterion.ok ? '' : unknownCriterion.error.code, 'Invalid');

  const duplicateEvidence = pack({
    requirements: [
      requirement({ criterionId: 'AC-one', method: { kind: 'AutomatedCheck', checkId: 'typecheck' } }),
      requirement({ criterionId: 'AC-two', method: { kind: 'AutomatedCheck', checkId: 'typecheck' } }),
    ],
    observations: [
      observation({ criterionId: 'AC-one', evidence: 'ev-shared' }),
      observation({ criterionId: 'AC-two', evidence: 'ev-shared' }),
    ],
  });
  assert.equal(duplicateEvidence.ok, false);

  const localWithoutDeployment = pack({
    requirements: [requirement({
      criterionId: 'AC-preview',
      method: { kind: 'BrowserEvidence', evidenceId: 'ev-preview' },
      requiresDeployedObservation: true,
    })],
    observations: [observation({
      criterionId: 'AC-preview',
      evidence: 'ev-preview',
      environment: 'Preview',
      deploymentId: null,
      artifacts: [{ kind: 'Screenshot', name: 'ui/preview.png', capturedAt: '2026-09-30T10:05:00.000Z' }],
    })],
  });
  assert.equal(localWithoutDeployment.ok, false);

  const mismatchedMethod = pack({
    requirements: [requirement({ criterionId: 'AC-ui', method: { kind: 'BrowserEvidence', evidenceId: 'ev-other' } })],
    observations: [observation({ criterionId: 'AC-ui', evidence: 'ev-ui' })],
  });
  assert.equal(mismatchedMethod.ok, false);
  assert.match(mismatchedMethod.ok ? '' : mismatchedMethod.error.reason, /assigned method .* observation/i);

  const uncorrelated = buildEvidencePack({
    bundleId: 'bundle-1',
    correlationId: '',
    identity: IDENTITY,
    eligiblePreview: ELIGIBLE_PREVIEW,
    requirements: [requirement({ criterionId: 'AC-one', method: { kind: 'AutomatedCheck', checkId: 'typecheck' } })],
    observations: [],
  });
  assert.equal(uncorrelated.ok, false);
});
