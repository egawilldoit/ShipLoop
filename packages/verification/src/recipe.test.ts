/**
 * Recipe validation, versioning, dependency-drift and capability-profile tests.
 *
 * The subjects here are pure functions, so these tests are the real proof of the
 * rules rather than a proxy for them: an invalid recipe must be rejected with a
 * field path a form can render, a new version must leave the old one readable, and
 * a changed dependency digest must never be answered with a silent reuse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint } from '@shiploop/domain';
import type {
  BoundedCommand,
  RecipeStep,
  RecipeVersion,
  RecipeVersionContent,
} from './recipe.ts';
import {
  capabilityEffect,
  effectiveEnvironment,
  nextVersion,
  permitsStep,
  readOnlyCapabilityProfile,
  recipeFingerprint,
  recordVerification,
  requiredCapabilityProfile,
  validateRecipe,
} from './recipe.ts';

const VERIFIED_AT = '2026-02-01T10:00:00.000Z';
const SECOND_VERIFIED_AT = '2026-02-02T10:00:00.000Z';
const HEAD_SHA = 'a'.repeat(40);
const DIGEST_A = fingerprint({ lockfile: 'revision-a' });
const DIGEST_B = fingerprint({ lockfile: 'revision-b' });

function bounded(argv: readonly string[], overrides: Partial<BoundedCommand> = {}): BoundedCommand {
  return { argv, timeoutMs: 5_000, maxOutputBytes: 8_192, cwd: null, ...overrides };
}

const INSTALL_STEP: RecipeStep = {
  id: 'install',
  kind: 'InstallDependencies',
  description: 'Install the locked dependencies.',
  command: bounded(['pnpm', 'install', '--frozen-lockfile']),
  requiredCapability: 'Dependencies:Install',
  serviceId: null,
  port: null,
};

const INSPECT_STEP: RecipeStep = {
  id: 'inspect-deps',
  kind: 'InspectDependencies',
  description: 'Report which dependencies are installed.',
  command: bounded(['node', '-e', 'process.exit(0)']),
  requiredCapability: 'Dependencies:Inspect',
  serviceId: null,
  port: null,
};

const START_STEP: RecipeStep = {
  id: 'start-api',
  kind: 'StartService',
  description: 'Start the API on its isolated port.',
  command: bounded(['pnpm', 'run', 'dev:api']),
  requiredCapability: 'Service:Start',
  serviceId: 'api',
  port: 4010,
};

function baseContent(): RecipeVersionContent {
  return {
    requirements: {
      runtime: { name: 'node', minVersion: '24.0.0', maxVersionExclusive: null },
      cpu: { architecture: 'x64', minCores: 2 },
    },
    dependencyInstall: [INSPECT_STEP, INSTALL_STEP],
    serviceStartup: [START_STEP],
    checks: [
      { id: 'typecheck', name: 'TypeScript typecheck', command: bounded(['pnpm', 'run', 'typecheck']), required: true },
    ],
    ports: [
      { serviceId: 'api', port: 4010, purpose: 'Test', required: true },
      { serviceId: 'metrics', port: 4011, purpose: 'Metrics', required: false },
    ],
    dataLocations: [
      { id: 'testdata', path: 'data/test', purpose: 'TestData' },
      { id: 'cache', path: 'data/cache', purpose: 'Cache' },
    ],
    testAccess: [
      {
        id: 'api-endpoint',
        description: 'Base URL the checks target.',
        kind: 'ServiceEndpoint',
        target: 'http://127.0.0.1:4010',
      },
    ],
    requiredSecrets: ['SHIPLOOP_DEPLOY_TOKEN'],
    declaredCapabilities: ['Dependencies:Inspect', 'Dependencies:Install', 'Service:Start'],
    maintenance: {
      action: 'RunMaintenanceStep',
      command: bounded(['pnpm', 'install', '--frozen-lockfile']),
      incompatibilityReason: null,
    },
  };
}

function baseRecipe(overrides: Partial<RecipeVersionContent> = {}): RecipeVersion {
  return {
    ...baseContent(),
    ...overrides,
    recipeId: 'recipe-shiploop',
    version: 1,
    supersedesVersion: null,
    provenance: {
      source: 'OwnerSaved',
      scope: 'project:shiploop',
      createdBy: 'owner',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    lastVerification: {
      result: 'NeverVerified',
      verifiedAt: null,
      verifiedRevision: null,
      dependencyDigest: null,
    },
  };
}

function fieldPaths(result: ReturnType<typeof validateRecipe>): readonly string[] {
  if (result.ok) return [];
  if (result.error.code !== 'Invalid') return [];
  return result.error.fields.map((field) => field.path);
}

test('a complete recipe validates and returns itself unchanged (F04-AC1, F02-AC4)', () => {
  const recipe = baseRecipe();
  const result = validateRecipe(recipe);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, recipe);
});

test('every missing field is rejected with its own path (F02-AC4)', () => {
  const cases: readonly { readonly label: string; readonly recipe: RecipeVersion; readonly path: string }[] = [
    {
      label: 'missing runtime',
      recipe: baseRecipe({ requirements: { runtime: null, cpu: { architecture: 'x64', minCores: 2 } } }),
      path: 'requirements.runtime',
    },
    {
      label: 'runtime without a minimum version',
      recipe: baseRecipe({
        requirements: { runtime: { name: 'node', minVersion: '', maxVersionExclusive: null }, cpu: { architecture: 'x64', minCores: 2 } },
      }),
      path: 'requirements.runtime.minVersion',
    },
    {
      label: 'missing cpu constraint',
      recipe: baseRecipe({
        requirements: { runtime: { name: 'node', minVersion: '24.0.0', maxVersionExclusive: null }, cpu: null },
      }),
      path: 'requirements.cpu',
    },
    {
      label: 'cpu constraint without an architecture',
      recipe: baseRecipe({
        requirements: {
          runtime: { name: 'node', minVersion: '24.0.0', maxVersionExclusive: null },
          cpu: { architecture: '   ', minCores: 2 },
        },
      }),
      path: 'requirements.cpu.architecture',
    },
    {
      label: 'step needing an undeclared capability',
      recipe: baseRecipe({ declaredCapabilities: ['Service:Start'] }),
      path: 'dependencyInstall[1].requiredCapability',
    },
    {
      label: 'unbounded check command',
      recipe: baseRecipe({
        checks: [
          { id: 'typecheck', name: 'Typecheck', command: bounded(['pnpm', 'run', 'typecheck'], { timeoutMs: null }), required: true },
        ],
      }),
      path: 'checks[0].command.timeoutMs',
    },
    {
      label: 'check command without an output cap',
      recipe: baseRecipe({
        checks: [
          { id: 'typecheck', name: 'Typecheck', command: bounded(['pnpm', 'run', 'typecheck'], { maxOutputBytes: 0 }), required: true },
        ],
      }),
      path: 'checks[0].command.maxOutputBytes',
    },
    {
      label: 'data directory escaping the attempt root',
      recipe: baseRecipe({ dataLocations: [{ id: 'shared', path: '../shared-project', purpose: 'TestData' }] }),
      path: 'dataLocations[0].path',
    },
    {
      label: 'service binding an unallocated port',
      recipe: baseRecipe({ serviceStartup: [{ ...START_STEP, port: 4999 }] }),
      path: 'serviceStartup[0].port',
    },
    {
      label: 'port outside the valid range',
      recipe: baseRecipe({ ports: [{ serviceId: 'api', port: 70_000, purpose: 'Test', required: true }] }),
      path: 'ports[0].port',
    },
    {
      label: 'maintenance policy promising a step it does not record',
      recipe: baseRecipe({ maintenance: { action: 'RunMaintenanceStep', command: null, incompatibilityReason: null } }),
      path: 'maintenance.command',
    },
    {
      label: 'incompatibility policy without a reason',
      recipe: baseRecipe({ maintenance: { action: 'Incompatible', command: null, incompatibilityReason: null } }),
      path: 'maintenance.incompatibilityReason',
    },
    {
      label: 'unnamed required secret',
      recipe: baseRecipe({ requiredSecrets: ['  '] }),
      path: 'requiredSecrets[0]',
    },
  ];

  for (const testCase of cases) {
    const result = validateRecipe(testCase.recipe);
    assert.equal(result.ok, false, testCase.label);
    if (result.ok) continue;
    assert.equal(result.error.code, 'Invalid', testCase.label);
    const paths = fieldPaths(result);
    assert.ok(
      paths.includes(testCase.path),
      `${testCase.label}: expected ${testCase.path}, got ${paths.join(', ') || '(none)'}`,
    );
  }
});

test('a port allocated twice inside one recipe is rejected (F14-AC3)', () => {
  const result = validateRecipe(
    baseRecipe({
      ports: [
        { serviceId: 'api', port: 4010, purpose: 'Test', required: true },
        { serviceId: 'worker', port: 4010, purpose: 'Test', required: true },
      ],
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'Invalid');
  if (result.error.code !== 'Invalid') return;
  const collision = result.error.fields.find((field) => field.path === 'ports[1].port');
  assert.ok(collision !== undefined, 'the second allocation must be the field that fails');
  assert.match(collision?.message ?? '', /4010/);
  assert.match(collision?.message ?? '', /api/);
});

test('a check command with no timeout is rejected as unbounded', () => {
  const result = validateRecipe(
    baseRecipe({
      checks: [
        { id: 'e2e', name: 'Browser E2E', command: bounded(['pnpm', 'run', 'e2e'], { timeoutMs: null }), required: true },
      ],
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  if (result.error.code !== 'Invalid') return assert.fail('expected an Invalid error');
  const unbounded = result.error.fields.filter((field) => field.path === 'checks[0].command.timeoutMs');
  assert.equal(unbounded.length, 1);
  assert.match(unbounded[0]?.message ?? '', /timeout/);
});

test('a data directory that escapes the attempt root is rejected (F04-AC5, F14-AC5)', () => {
  for (const path of ['../shared-project', '../../etc/shiploop', '/var/lib/shared', 'data/../../elsewhere', '']) {
    const result = validateRecipe(
      baseRecipe({ dataLocations: [{ id: 'testdata', path, purpose: 'TestData' }] }),
    );
    assert.equal(result.ok, false, `path ${JSON.stringify(path)} must be rejected`);
    if (result.ok) continue;
    if (result.error.code !== 'Invalid') continue;
    assert.ok(
      result.error.fields.some((field) => field.path === 'dataLocations[0].path'),
      `path ${JSON.stringify(path)} must be reported against dataLocations[0].path`,
    );
  }
  const inside = validateRecipe(
    baseRecipe({ dataLocations: [{ id: 'testdata', path: 'data/../data/test', purpose: 'TestData' }] }),
  );
  assert.equal(inside.ok, true, 'a path that normalises back inside the attempt root is allowed');
});

test('appending a version leaves the previous version readable and unmodified (F04-AC1, F05-AC4)', () => {
  const first = baseRecipe();
  const snapshot = structuredClone(first);

  const appended = nextVersion(first, { ...baseContent(), checks: [] }, {
    source: 'ProposedByAgent',
    scope: 'project:shiploop',
    createdBy: 'agent',
    createdAt: SECOND_VERIFIED_AT,
  });

  assert.ok(appended.ok);
  if (!appended.ok) return;
  assert.equal(appended.value.recipeId, first.recipeId);
  assert.equal(appended.value.version, 2);
  assert.equal(appended.value.supersedesVersion, 1);
  assert.equal(appended.value.provenance.source, 'ProposedByAgent');
  assert.equal(appended.value.lastVerification.result, 'NeverVerified');
  assert.equal(appended.value.lastVerification.dependencyDigest, null);
  assert.notEqual(recipeFingerprint(first), recipeFingerprint(appended.value));

  assert.deepEqual(first, snapshot, 'the earlier version must be untouched by an append');
  assert.equal(first.version, 1);
  assert.equal(first.checks.length, 1);
  assert.equal(validateRecipe(first).ok, true, 'the earlier version is still a valid recipe');
});

test('a changed dependency digest requires maintenance instead of a silent reuse (F04-AC4)', () => {
  const verified = recordVerification(baseRecipe(), {
    result: 'Verified',
    verifiedAt: VERIFIED_AT,
    revision: HEAD_SHA,
    dependencyDigest: DIGEST_A,
  });

  const unchanged = effectiveEnvironment(verified, { observedAt: VERIFIED_AT, dependencyDigest: DIGEST_A });
  assert.ok(unchanged.ok);
  if (unchanged.ok) assert.equal(unchanged.value.disposition, 'Reusable');
  if (unchanged.ok) assert.equal(unchanged.value.requiredMaintenance, null);

  const drifted = effectiveEnvironment(verified, { observedAt: SECOND_VERIFIED_AT, dependencyDigest: DIGEST_B });
  assert.ok(drifted.ok, 'a recorded maintenance step makes the drift recoverable, not fatal');
  if (drifted.ok) {
    assert.equal(drifted.value.disposition, 'MaintenanceRequired');
    assert.notEqual(drifted.value.requiredMaintenance, null);
    assert.equal(drifted.value.observedDependencyDigest, DIGEST_B);
    assert.equal(drifted.value.verifiedDependencyDigest, DIGEST_A);
  }

  const neverVerified = effectiveEnvironment(baseRecipe(), { observedAt: VERIFIED_AT, dependencyDigest: DIGEST_A });
  assert.equal(neverVerified.ok, false, 'an unverified recipe has no earlier success to reuse');
  if (neverVerified.ok) return;
  assert.equal(neverVerified.error.code, 'Blocked');

  const withoutMaintenance = effectiveEnvironment(
    recordVerification(baseRecipe({ maintenance: { action: 'RunMaintenanceStep', command: null, incompatibilityReason: null } }), {
      result: 'Verified',
      verifiedAt: VERIFIED_AT,
      revision: HEAD_SHA,
      dependencyDigest: DIGEST_A,
    }),
    { observedAt: SECOND_VERIFIED_AT, dependencyDigest: DIGEST_B },
  );
  assert.equal(withoutMaintenance.ok, false, 'no maintenance step and no incompatibility means the recipe is unusable');
  if (withoutMaintenance.ok) return;
  assert.equal(withoutMaintenance.error.code, 'Blocked');

  const incompatible = effectiveEnvironment(
    recordVerification(
      baseRecipe({
        maintenance: {
          action: 'Incompatible',
          command: null,
          incompatibilityReason: 'The lockfile moved to a workspace layout this recipe cannot install.',
        },
      }),
      { result: 'Verified', verifiedAt: VERIFIED_AT, revision: HEAD_SHA, dependencyDigest: DIGEST_A },
    ),
    { observedAt: SECOND_VERIFIED_AT, dependencyDigest: DIGEST_B },
  );
  assert.equal(incompatible.ok, false, 'an explicit incompatibility is reported, not worked around');
  if (incompatible.ok) return;
  assert.equal(incompatible.error.code, 'Blocked');
  const prerequisite = incompatible.error.prerequisites[0];
  assert.ok(prerequisite !== undefined);
  assert.match(prerequisite?.detail ?? '', /workspace layout/);
  assert.ok((prerequisite?.remedy ?? '').length > 0);
});

test('recording a verification does not mutate the recipe it was recorded against', () => {
  const first = baseRecipe();
  const snapshot = structuredClone(first);
  const recorded = recordVerification(first, {
    result: 'Verified',
    verifiedAt: VERIFIED_AT,
    revision: HEAD_SHA,
    dependencyDigest: DIGEST_A,
  });
  assert.deepEqual(first, snapshot);
  assert.equal(recorded.lastVerification.result, 'Verified');
  assert.equal(recorded.lastVerification.dependencyDigest, DIGEST_A);
  assert.equal(recorded.version, first.version);
});

test('a read-only capability profile classifies steps and refuses mutating ones (F07-AC5)', () => {
  const recipe = baseRecipe();

  assert.equal(capabilityEffect('Repository:Read'), 'ReadOnly');
  assert.equal(capabilityEffect('Dependencies:Inspect'), 'ReadOnly');
  assert.equal(capabilityEffect('Secret:InspectPresence'), 'ReadOnly');
  assert.equal(capabilityEffect('Service:Probe'), 'ReadOnly');
  assert.equal(capabilityEffect('Dependencies:Install'), 'Mutating');
  assert.equal(capabilityEffect('Service:Start'), 'Mutating');
  assert.equal(capabilityEffect('Check:Execute'), 'Mutating');
  assert.equal(capabilityEffect('Workspace:Write'), 'Mutating');

  const full = requiredCapabilityProfile(recipe);
  assert.equal(full.kind, 'Full');
  assert.ok(full.readOnly.includes('Dependencies:Inspect'));
  assert.ok(full.mutating.includes('Dependencies:Install'));
  assert.ok(full.mutating.includes('Service:Start'));
  assert.ok(full.mutating.includes('Check:Execute'), 'a recipe with checks needs the check capability');

  const readOnly = readOnlyCapabilityProfile(recipe);
  assert.equal(readOnly.kind, 'ReadOnly');
  assert.deepEqual(readOnly.mutating, []);
  assert.ok(readOnly.readOnly.includes('Dependencies:Inspect'));

  assert.equal(permitsStep(full, INSTALL_STEP).ok, true);
  assert.equal(permitsStep(full, START_STEP).ok, true);
  assert.equal(permitsStep(readOnly, INSPECT_STEP).ok, true);

  for (const mutating of [INSTALL_STEP, START_STEP]) {
    const denied = permitsStep(readOnly, mutating);
    assert.equal(denied.ok, false, `${mutating.id} must not be permitted by a read-only profile`);
    if (denied.ok) continue;
    assert.equal(denied.error.code, 'Forbidden');
    if (denied.error.code !== 'Forbidden') continue;
    assert.match(denied.error.reason, new RegExp(mutating.requiredCapability));
  }
});

test('the environment fingerprint changes when the recorded environment changes', () => {
  const recipe = baseRecipe();
  const changedPort = baseRecipe({
    ports: [
      { serviceId: 'api', port: 4020, purpose: 'Test', required: true },
      { serviceId: 'metrics', port: 4011, purpose: 'Metrics', required: false },
    ],
  });
  const reorderedProvenance: RecipeVersion = {
    ...recipe,
    provenance: { ...recipe.provenance, createdBy: 'someone-else', createdAt: SECOND_VERIFIED_AT },
  };

  assert.equal(recipeFingerprint(recipe), recipeFingerprint(baseRecipe()));
  assert.notEqual(recipeFingerprint(recipe), recipeFingerprint(changedPort));
  assert.equal(
    recipeFingerprint(reorderedProvenance),
    recipeFingerprint(recipe),
    'who saved the recipe and when is not part of the environment it describes',
  );
});
