import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  JOB_MODE_DECLARATIONS,
  JOB_MODES,
  evaluateGrant,
  evaluateRequiredCheckPolicy,
  isPrivilegedDelivery,
  requiredChecksFor,
} from './capability-grant.ts';
import type { JobMode, RequiredCheckPolicy } from './capability-grant.ts';

const allBuildCapabilities = JOB_MODE_DECLARATIONS.Build.capabilities;

function policy(): RequiredCheckPolicy {
  return {
    projectId: 'project-1',
    revision: 1,
    checks: [
      { checkId: 'lint', name: 'Lint', required: true },
      { checkId: 'typecheck', name: 'Typecheck', required: true },
      { checkId: 'bundle-size', name: 'Bundle size', required: false },
    ],
    changedBy: 'owner-1',
    changedAt: '2026-09-30T10:00:00.000Z',
    reason: 'Initial profile policy',
  };
}

test('no job mode implies delivery authority and declares no delivery action (F13-AC3)', () => {
  assert.deepEqual([...JOB_MODES], ['Plan', 'Investigate', 'Build', 'Test', 'Review']);

  for (const mode of JOB_MODES) {
    const declaration = JOB_MODE_DECLARATIONS[mode];
    assert.equal(declaration.impliesDeliveryAuthority, false);
    assert.equal(declaration.capabilities.includes('Git:MergeWithPrecondition'), false);
    assert.equal(declaration.capabilities.includes('Deployment:Execute'), false);
  }
});

test('Build mode permits its declared workspace capabilities', () => {
  const decision = evaluateGrant({
    mode: 'Build',
    requestedCapability: 'Git:PushBranch',
    grantedCapabilities: allBuildCapabilities,
    actorRole: 'CodingAgent',
  });

  assert.equal(decision.allowed, true);
  if (decision.allowed) {
    assert.equal(decision.capability, 'Git:PushBranch');
    assert.equal(decision.privileged, false);
  }
});

test('a Build-mode coding actor is denied merge and production deployment (F03-AC5, N02-AC3)', () => {
  for (const requested of ['Git:MergeWithPrecondition', 'Deployment:Execute'] as const) {
    const decision = evaluateGrant({
      mode: 'Build',
      requestedCapability: requested,
      grantedCapabilities: allBuildCapabilities,
      actorRole: 'CodingAgent',
    });

    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.reason, 'DeliveryRequiresOwnerAuthorization');
      assert.match(decision.explanation, /privileged delivery action/);
    }
  }
});

test('delivery stays denied for a coding actor even when it is granted explicitly (N02-AC3)', () => {
  const decision = evaluateGrant({
    mode: 'Build',
    requestedCapability: 'Git:MergeWithPrecondition',
    grantedCapabilities: [...allBuildCapabilities, 'Git:MergeWithPrecondition'],
    actorRole: 'CodingAgent',
  });

  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.reason, 'DeliveryRequiresOwnerAuthorization');
});

test('a coding actor is denied every operation that would modify owner acceptance (N02-AC3)', () => {
  for (const requested of ['Acceptance:Decide', 'Acceptance:Withdraw', 'Policy:ChangeRequiredChecks'] as const) {
    const decision = evaluateGrant({
      mode: 'Build',
      requestedCapability: requested,
      grantedCapabilities: allBuildCapabilities,
      actorRole: 'CodingAgent',
    });

    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.reason, 'OwnerOnlyOperation');
      assert.match(decision.explanation, /owner decision/);
    }
  }
});

test('owner-only operations are denied for every mode and role except the owner', () => {
  for (const mode of JOB_MODES) {
    const decision = evaluateGrant({
      mode,
      requestedCapability: 'Acceptance:Decide',
      grantedCapabilities: allBuildCapabilities,
      actorRole: 'DeliveryExecutor',
    });
    assert.equal(decision.allowed, false);
  }
});

test('a capability outside the mode set is denied even when granted', () => {
  const decision = evaluateGrant({
    mode: 'Plan',
    requestedCapability: 'Git:PushBranch',
    grantedCapabilities: [...JOB_MODE_DECLARATIONS.Plan.capabilities, 'Git:PushBranch'],
    actorRole: 'CodingAgent',
  });

  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.reason, 'NotInModeCapabilitySet');
    assert.match(decision.explanation, /Plan mode does not declare/);
  }
});

test('a declared capability that was not granted is denied', () => {
  const decision = evaluateGrant({
    mode: 'Build',
    requestedCapability: 'Git:PushBranch',
    grantedCapabilities: ['Git:ReadRepository'],
    actorRole: 'CodingAgent',
  });

  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.reason, 'NotGranted');
    assert.match(decision.explanation, /was not granted/);
  }
});

test('privileged delivery is derived from the capability declaration vocabulary (F03-AC5)', () => {
  assert.equal(isPrivilegedDelivery('Git:MergeWithPrecondition'), true);
  assert.equal(isPrivilegedDelivery('Deployment:Execute'), true);
  assert.equal(isPrivilegedDelivery('Git:PushBranch'), false);

  const declaredPrivileged = evaluateGrant({
    mode: 'Review',
    requestedCapability: 'Engine:StartScoped',
    grantedCapabilities: ['Engine:StartScoped'],
    actorRole: 'CodingAgent',
    declarations: [
      { kind: 'Engine:StartScoped', supported: true, limitation: null, privileged: true, supportsPrecondition: false },
    ],
  });
  assert.equal(declaredPrivileged.allowed, false);
  if (!declaredPrivileged.allowed) {
    assert.equal(declaredPrivileged.reason, 'DeliveryRequiresOwnerAuthorization');
  }
});

test('an owner may change required-check policy and the change is a new revision (F20-AC5)', () => {
  const current = policy();

  const result = evaluateRequiredCheckPolicy({
    policy: current,
    action: 'Require',
    checkId: 'bundle-size',
    actorRole: 'Owner',
    actorId: 'owner-1',
    now: '2026-09-30T11:00:00.000Z',
    reason: 'Bundle budget now part of the gate',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.revision, current.revision + 1);
  assert.equal(result.value.changedBy, 'owner-1');
  assert.equal(result.value.changedAt, '2026-09-30T11:00:00.000Z');
  assert.equal(current.revision, 1);
  assert.deepEqual(
    requiredChecksFor(result.value).map((rule) => rule.checkId),
    ['lint', 'typecheck', 'bundle-size'],
  );
});

test('a coding actor may not drop or downgrade a required check to pass its own work (F20-AC5)', () => {
  const current = policy();

  for (const action of ['DropRequirement', 'DowngradeToAdvisory'] as const) {
    const result = evaluateRequiredCheckPolicy({
      policy: current,
      action,
      checkId: 'typecheck',
      actorRole: 'CodingAgent',
      actorId: 'agent-1',
      now: '2026-09-30T11:00:00.000Z',
      reason: 'Check is too slow to pass',
    });

    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.error.code, 'Forbidden');
    assert.match(result.error.reason, /Required-check policy is owner-controlled/);
  }

  assert.equal(current.checks.find((rule) => rule.checkId === 'typecheck')?.required, true);
  assert.equal(requiredChecksFor(current).length, 2);
});

test('required checks for the review card contain only blocking rules (F20-AC5)', () => {
  assert.deepEqual(
    requiredChecksFor(policy()).map((rule) => rule.checkId),
    ['lint', 'typecheck'],
  );
});

test('a redundant policy change conflicts rather than inventing a revision', () => {
  const result = evaluateRequiredCheckPolicy({
    policy: policy(),
    action: 'Require',
    checkId: 'lint',
    actorRole: 'Owner',
    actorId: 'owner-1',
    now: '2026-09-30T11:00:00.000Z',
    reason: 'Already required',
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'Conflict');
});

test('requiring an unknown check is a NotFound refusal, not a silent addition', () => {
  const result = evaluateRequiredCheckPolicy({
    policy: policy(),
    action: 'DropRequirement',
    checkId: 'does-not-exist',
    actorRole: 'Owner',
    actorId: 'owner-1',
    now: '2026-09-30T11:00:00.000Z',
    reason: 'Remove a check that was never configured',
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'NotFound');
});

test('every declared mode is present in the declaration table', () => {
  const declared: readonly JobMode[] = JOB_MODES;
  for (const mode of declared) {
    assert.equal(JOB_MODE_DECLARATIONS[mode].mode, mode);
    assert.ok(JOB_MODE_DECLARATIONS[mode].capabilities.length > 0);
  }
});