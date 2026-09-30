/**
 * Preflight blocking, redaction, bounded execution and owned cleanup tests.
 *
 * The bounded-execution and cleanup tests drive real detached child processes
 * rather than a stub, because a timeout that was never observed against a real
 * process and a cleanup that was never pointed at a real process group are both
 * claims rather than proof (TESTING.md, mvp-spec "Bound output/context packets,
 * subprocess duration").
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fingerprint } from '@shiploop/domain';
import { fingerprint } from '@shiploop/domain';
import type {
  CommandResult,
  CommandRunner,
  PreflightDeps,
  PreflightRequest,
  ProbeResult,
  ResourceRegistry,
  RuntimeFacts,
} from './preflight.ts';
import type { BoundedCommand, RecipeVersion, RecipeVersionContent } from './recipe.ts';
import {
  cleanupOwnedResources,
  implementationMayStart,
  preflightReportDigest,
  runPreflight,
} from './preflight.ts';
import {
  nodeProcessRunner,
  removeOwnedPath,
  spawnOwnedProcess,
  stopOwnedProcessGroup,
} from './process-runner.ts';

const SECRET_NAME = 'SHIPLOOP_TEST_DEPLOY_TOKEN';
/** Assembled from fragments so no tracked line contains a credential-shaped literal (N02-AC2). */
const SEEDED_SECRET_VALUE = ['sk', 'proj', 'shiploopseed', 'fixtureonly', 'aaaaaaaaaaaaaaaaaaaaaa'].join('-');
const RUNTIME: RuntimeFacts = { version: '24.18.0', architecture: 'x64' };
const STARTED_AT = '2026-03-01T09:00:00.000Z';
const REPOSITORY_MARKER = 'repository-access';
const DEPENDENCY_MARKER = 'dependency-state';

function bounded(argv: readonly string[], overrides: Partial<BoundedCommand> = {}): BoundedCommand {
  return { argv, timeoutMs: 5_000, maxOutputBytes: 8_192, cwd: null, ...overrides };
}

function baseContent(overrides: Partial<RecipeVersionContent> = {}): RecipeVersionContent {
  return {
    requirements: {
      runtime: { name: 'node', minVersion: '24.0.0', maxVersionExclusive: null },
      cpu: { architecture: 'x64', minCores: 2 },
    },
    dependencyInstall: [
      {
        id: 'install',
        kind: 'InstallDependencies',
        description: 'Install the locked dependencies.',
        command: bounded(['pnpm', 'install', '--frozen-lockfile']),
        requiredCapability: 'Dependencies:Install',
        serviceId: null,
        port: null,
      },
    ],
    serviceStartup: [
      {
        id: 'start-api',
        kind: 'StartService',
        description: 'Start the API on its isolated port.',
        command: bounded(['pnpm', 'run', 'dev:api']),
        requiredCapability: 'Service:Start',
        serviceId: 'api',
        port: 4010,
      },
    ],
    checks: [
      { id: 'typecheck', name: 'Typecheck', command: bounded(['pnpm', 'run', 'typecheck']), required: true },
    ],
    ports: [
      { serviceId: 'api', port: 4010, purpose: 'Test', required: true },
      { serviceId: 'metrics', port: 4011, purpose: 'Metrics', required: false },
    ],
    dataLocations: [{ id: 'testdata', path: 'data/test', purpose: 'TestData' }],
    testAccess: [
      {
        id: 'api-endpoint',
        description: 'Base URL the checks target.',
        kind: 'ServiceEndpoint',
        target: 'http://127.0.0.1:4010',
      },
    ],
    requiredSecrets: [SECRET_NAME],
    declaredCapabilities: ['Dependencies:Install', 'Service:Start'],
    maintenance: {
      action: 'RunMaintenanceStep',
      command: bounded(['pnpm', 'install', '--frozen-lockfile']),
      incompatibilityReason: null,
    },
    ...overrides,
  };
}

function recipe(overrides: Partial<RecipeVersionContent> = {}): RecipeVersion {
  return {
    ...baseContent(overrides),
    recipeId: 'recipe-shiploop',
    version: 3,
    supersedesVersion: 2,
    provenance: { source: 'OwnerSaved', scope: 'project:shiploop', createdBy: 'owner', createdAt: STARTED_AT },
    lastVerification: {
      result: 'Verified',
      verifiedAt: STARTED_AT,
      verifiedRevision: 'b'.repeat(40),
      dependencyDigest: fingerprint({ lockfile: 'revision-a' }) as Fingerprint,
    },
  };
}

function request(overrides: Partial<PreflightRequest> = {}): PreflightRequest {
  return {
    attemptId: 'attempt-7',
    recipe: recipe(),
    workingDirectory: '/shiploop/attempts/attempt-7',
    evidenceDirectory: '/shiploop/evidence',
    repositoryProbe: bounded(['node', '-e', REPOSITORY_MARKER]),
    dependencyProbe: bounded(['node', '-e', DEPENDENCY_MARKER]),
    ...overrides,
  };
}

function okResult(output = ''): CommandResult {
  return {
    exitCode: 0,
    signal: null,
    output,
    outputTruncated: false,
    timedOut: false,
    durationMs: 4,
    spawnError: null,
    groupId: null,
  };
}

/** A deterministic fake: it returns canned runs and spawns nothing. */
function fakeRunner(options: { readonly failingMarkers?: readonly string[]; readonly output?: string } = {}): CommandRunner {
  const failing = new Set(options.failingMarkers ?? []);
  return {
    run: async (argv) => {
      const marker = argv[2] ?? '';
      if (failing.has(marker)) {
        return { ...okResult('fatal: not a usable repository'), exitCode: 128, durationMs: 9 };
      }
      return okResult(options.output ?? '');
    },
  };
}

function fixedClock(start: string): () => string {
  let tick = 0;
  return () => new Date(Date.parse(start) + tick++ * 1_000).toISOString();
}

function deps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    runCommand: fakeRunner(),
    readRuntime: () => RUNTIME,
    probePort: async () => true,
    hasSecret: () => true,
    now: fixedClock(STARTED_AT),
    ...overrides,
  };
}

function probeNamed(probes: readonly ProbeResult[], name: ProbeResult['name']): ProbeResult {
  const probe = probes.find((candidate) => candidate.name === name);
  assert.ok(probe !== undefined, `expected a ${name} probe`);
  if (probe === undefined) throw new Error(`missing ${name} probe`);
  return probe;
}

test('a usable environment reports Passed with the real exit results it observed (F04-AC2)', async () => {
  const result = await runPreflight(
    request(),
    deps({ runCommand: fakeRunner({ output: 'resolved 412 packages' }) }),
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  const report = result.value;

  assert.equal(report.outcome, 'PreflightPassed');
  assert.equal(report.blocked, null);
  assert.equal(implementationMayStart(report), true);
  assert.equal(report.probes.length, 5);
  assert.ok(report.probes.every((probe) => probe.status === 'Passed'));
  assert.equal(probeNamed(report.probes, 'RepositoryAccess').exitCode, 0);
  assert.equal(probeNamed(report.probes, 'DependencyInstall').output, 'resolved 412 packages');
  assert.match(probeNamed(report.probes, 'RepositoryAccess').evidenceRef, /attempt-7\/RepositoryAccess\.log$/);
  assert.deepEqual(report.secretPresence, [{ name: SECRET_NAME, present: true }]);
  assert.match(preflightReportDigest(report), /^fp_[0-9a-f]{32}$/);
});

test('a recipe that requires nothing optional still passes when its skips do not apply', async () => {
  const result = await runPreflight(
    request({ recipe: recipe({ requiredSecrets: [], ports: [] }) }),
    deps(),
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.outcome, 'PreflightPassed');
  assert.equal(implementationMayStart(result.value), true);
  assert.equal(probeNamed(result.value.probes, 'RequiredSecretPresent').status, 'Skipped');
  assert.equal(probeNamed(result.value.probes, 'RequiredSecretPresent').required, false);
});

test('a missing runtime is Blocked with the prerequisite named, never a success (F04-AC3)', async () => {
  const result = await runPreflight(request(), deps({ readRuntime: () => null }));
  assert.equal(result.ok, false, 'a missing runtime must not produce a successful call');
  if (result.ok) return;

  const error = result.error.error;
  assert.equal(error.code, 'Blocked');
  assert.match(error.reason, /Runtime node/);
  const prerequisite = error.prerequisites[0];
  assert.ok(prerequisite !== undefined);
  assert.equal(prerequisite?.name, 'Runtime node');
  assert.ok((prerequisite?.remedy ?? '').includes('Install node 24.0.0'));
  assert.equal(implementationMayStart(result.error.report), false);
  assert.equal(result.error.report.outcome, 'Blocked');
  assert.equal(result.error.report.blocked?.code, 'Blocked');

  const runtimeProbe = probeNamed(result.error.report.probes, 'RuntimeCompatibility');
  assert.equal(runtimeProbe.status, 'Failed');
  assert.equal(probeNamed(result.error.report.probes, 'DependencyInstall').status, 'Skipped');
  assert.match(
    probeNamed(result.error.report.probes, 'RequiredSecretPresent').detail,
    /Runtime node.*failed first/,
  );
});

test('a runtime that does not satisfy the recipe requirement is Blocked by version', async () => {
  const result = await runPreflight(
    request(),
    deps({ readRuntime: () => ({ version: '20.11.0', architecture: 'x64' }) }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.error.code, 'Blocked');
  assert.match(result.error.error.prerequisites[0]?.name ?? '', /Runtime node 24\.0\.0/);
  assert.match(result.error.error.prerequisites[0]?.detail ?? '', /20\.11\.0/);

  const wrongArchitecture = await runPreflight(
    request(),
    deps({ readRuntime: () => ({ version: '24.18.0', architecture: 'arm64' }) }),
  );
  assert.equal(wrongArchitecture.ok, false);
  if (wrongArchitecture.ok) return;
  assert.match(wrongArchitecture.error.error.prerequisites[0]?.name ?? '', /CPU architecture x64/);
});

test('an unreadable repository is Blocked rather than a partial pass (F04-AC2, F04-AC3)', async () => {
  const result = await runPreflight(request(), deps({ runCommand: fakeRunner({ failingMarkers: [REPOSITORY_MARKER] }) }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.error.code, 'Blocked');
  assert.match(result.error.error.prerequisites[0]?.name ?? '', /Repository access/);
  assert.equal(probeNamed(result.error.report.probes, 'RepositoryAccess').exitCode, 128);
  assert.match(probeNamed(result.error.report.probes, 'RepositoryAccess').output, /not a usable repository/);
});

test('an unreachable required service is Blocked naming the service (F04-AC3, F14-AC3)', async () => {
  const result = await runPreflight(request(), deps({ probePort: async (port) => port === 4011 }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.error.code, 'Blocked');
  const prerequisite = result.error.error.prerequisites[0];
  assert.equal(prerequisite?.name, 'Service api on port 4010');
  assert.match(prerequisite?.detail ?? '', /unrelated service/);
  assert.ok((prerequisite?.remedy ?? '').includes('4010'));
  const serviceProbe = probeNamed(result.error.report.probes, 'ServiceReachable');
  assert.equal(serviceProbe.status, 'Failed');
  assert.match(serviceProbe.detail, /api on port 4010/);
  assert.equal(probeNamed(result.error.report.probes, 'RequiredSecretPresent').status, 'Skipped');
});

test('a missing required secret is Blocked and its value appears nowhere in the report (N02-AC2)', async () => {
  const result = await runPreflight(
    request(),
    deps({
      runCommand: fakeRunner({ output: `using credential ${SEEDED_SECRET_VALUE} to reach the repository` }),
      hasSecret: () => false,
    }),
  );
  assert.equal(result.ok, false, 'a missing required secret must not produce a successful call');
  if (result.ok) return;

  const error = result.error.error;
  assert.equal(error.code, 'Blocked');
  assert.equal(error.prerequisites[0]?.name, `Required secret ${SECRET_NAME}`);
  assert.match(error.prerequisites[0]?.detail ?? '', /no value was read/);
  assert.deepEqual(result.error.report.secretPresence, [{ name: SECRET_NAME, present: false }]);

  const secretProbe = probeNamed(result.error.report.probes, 'RequiredSecretPresent');
  assert.equal(secretProbe.status, 'Failed');
  assert.equal(implementationMayStart(result.error.report), false);

  const serialized = JSON.stringify({ error, report: result.error.report });
  assert.ok(!serialized.includes(SEEDED_SECRET_VALUE), 'the seeded value must not survive redaction');
  for (const probe of result.error.report.probes) {
    assert.ok(!probe.detail.includes(SEEDED_SECRET_VALUE), `${probe.name} detail leaked the value`);
    assert.ok(!probe.output.includes(SEEDED_SECRET_VALUE), `${probe.name} output leaked the value`);
  }
  assert.ok(!error.reason.includes(SEEDED_SECRET_VALUE));
  assert.match(probeNamed(result.error.report.probes, 'RepositoryAccess').output, /\[redacted:/);
});

test('a real command that exceeds its timeout fails instead of hanging the run', async () => {
  const result = await runPreflight(
    request({
      repositoryProbe: bounded(['node', '-e', 'process.exit(0)'], { timeoutMs: 2_000 }),
      dependencyProbe: bounded(['node', '-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 250 }),
    }),
    deps({ runCommand: nodeProcessRunner }),
  );
  assert.ok(result.ok, 'a timeout is a failed check, not a blocked prerequisite');
  if (!result.ok) return;
  const probe = probeNamed(result.value.probes, 'DependencyInstall');
  assert.equal(probe.status, 'Failed');
  assert.equal(probe.blockedPrerequisite, null);
  assert.match(probe.detail, /250 ms timeout/);
  assert.equal(result.value.outcome, 'PreflightFailed');
  assert.equal(implementationMayStart(result.value), false);
});

test('a real command that exceeds its output cap fails instead of flooding the report', async () => {
  const result = await runPreflight(
    request({
      repositoryProbe: bounded(['node', '-e', 'process.exit(0)'], { timeoutMs: 2_000 }),
      dependencyProbe: bounded(['node', '-e', "process.stdout.write('x'.repeat(200000))"], {
        timeoutMs: 5_000,
        maxOutputBytes: 512,
      }),
    }),
    deps({ runCommand: nodeProcessRunner }),
  );
  assert.ok(result.ok, 'an over-noisy command is a failed check, not a blocked prerequisite');
  if (!result.ok) return;
  const probe = probeNamed(result.value.probes, 'DependencyInstall');
  assert.equal(probe.status, 'Failed');
  assert.equal(probe.blockedPrerequisite, null);
  assert.equal(probe.outputTruncated, true);
  assert.match(probe.detail, /512 byte output cap/);
  assert.ok(probe.output.length <= 512, `captured output must stay within the cap, saw ${probe.output.length}`);
  assert.equal(result.value.outcome, 'PreflightFailed');
  assert.equal(implementationMayStart(result.value), false);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntilDead(pid: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}

test('cleanup stops only owned process groups and never deletes retained or shared work (F04-AC5, F14-AC5)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-cleanup-'));
  const temporary = join(root, 'tmp');
  const retained = join(root, 'retained-evidence');
  const shared = join(root, 'shared-project');
  for (const directory of [temporary, retained, shared]) await mkdir(directory, { recursive: true });

  const owned = spawnOwnedProcess(['node', '-e', 'setInterval(() => {}, 1000)'], { cwd: null });
  const unspawned = spawnOwnedProcess(['node', '-e', 'setInterval(() => {}, 1000)'], { cwd: null });

  const signalledGroups: number[] = [];
  const registry: ResourceRegistry = {
    attemptId: 'attempt-7',
    processes: [
      { pid: owned.pid, groupId: owned.groupId, ownsGroup: true, command: owned.command, startedAt: owned.startedAt },
      {
        pid: unspawned.pid,
        groupId: unspawned.groupId,
        ownsGroup: false,
        command: unspawned.command,
        startedAt: unspawned.startedAt,
      },
    ],
    resources: [
      { id: 'tmp', kind: 'TemporaryDirectory', path: temporary, port: null, retainForRecovery: false, sharedProjectData: false, createdAt: STARTED_AT },
      { id: 'evidence', kind: 'TemporaryDirectory', path: retained, port: null, retainForRecovery: true, sharedProjectData: false, createdAt: STARTED_AT },
      { id: 'project', kind: 'ServiceData', path: shared, port: null, retainForRecovery: false, sharedProjectData: true, createdAt: STARTED_AT },
      { id: 'api-port', kind: 'PortAllocation', path: null, port: 4010, retainForRecovery: false, sharedProjectData: false, createdAt: STARTED_AT },
    ],
  };

  try {
    assert.equal(isAlive(owned.pid), true);
    assert.equal(isAlive(unspawned.pid), true);

    const report = await cleanupOwnedResources(registry, {
      stopProcessGroup: (groupId, signal) => {
        signalledGroups.push(groupId);
        return stopOwnedProcessGroup(groupId, signal);
      },
      removePath: removeOwnedPath,
      now: fixedClock(STARTED_AT),
    });

    assert.deepEqual(report.stoppedGroups, [owned.groupId]);
    assert.deepEqual(report.untouchedProcessIds, [unspawned.pid]);
    assert.deepEqual(signalledGroups, [owned.groupId], 'a group this attempt did not spawn is never signalled');
    assert.ok(
      report.actions.some((action) => action.kind === 'SkipUnownedProcess' && action.target === `pid ${unspawned.pid}`),
    );

    assert.deepEqual(report.removedResourceIds, ['tmp', 'api-port']);
    assert.deepEqual(report.retainedResourceIds, ['evidence', 'project']);
    assert.deepEqual(report.failures, []);
    assert.equal(existsSync(temporary), false);
    assert.equal(existsSync(retained), true, 'retained evidence must survive ordinary cancellation');
    assert.equal(existsSync(shared), true, 'shared project data is never removed by attempt cleanup');
    assert.ok(report.actions.some((action) => action.kind === 'ReleasePort' && action.target.includes('4010')));

    assert.equal(await waitUntilDead(owned.pid, 2_000), true, 'the owned process group must actually stop');
    assert.equal(isAlive(unspawned.pid), true, 'a process this attempt did not spawn must survive');
  } finally {
    stopOwnedProcessGroup(owned.groupId, 'SIGKILL');
    stopOwnedProcessGroup(unspawned.groupId, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('a resource that cannot be removed is reported as left in place, not as removed', async () => {
  const report = await cleanupOwnedResources(
    {
      attemptId: 'attempt-7',
      processes: [],
      resources: [
        { id: 'tmp', kind: 'TemporaryDirectory', path: '/shiploop/attempts/attempt-7/tmp', port: null, retainForRecovery: false, sharedProjectData: false, createdAt: STARTED_AT },
      ],
    },
    {
      stopProcessGroup: () => false,
      removePath: async () => {
        throw new Error('device or resource busy');
      },
      now: fixedClock(STARTED_AT),
    },
  );
  assert.deepEqual(report.removedResourceIds, []);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0]?.resourceId, 'tmp');
  assert.ok(report.actions.some((action) => action.kind === 'RemoveFailed'));
});
