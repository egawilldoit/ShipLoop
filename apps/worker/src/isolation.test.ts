/**
 * The execution boundary, proved against the child that is actually launched (F03-AC5, N02-AC3, F17-AC1).
 *
 * These tests do not assert that the configuration *says* the engine is isolated. Each one launches a
 * real child through the launcher this product installs, and that child reports — from the inside —
 * which uid it became, which `HOME` it was given, which variable names it holds, whether it could
 * write in its workspace and which protected paths it could read. A test that read the settings back
 * would pass on a host where the boundary does not exist, which is the failure mode
 * `docs/evidence/2026-10-01-credential-separation.md` documented.
 *
 * **Secrets here are synthetic.** A seeded file and a seeded environment variable stand in for the
 * operator's credentials, because a test that read a real credential to prove it cannot be read would
 * itself be a disclosure. The operator's own paths (`$HOME`, `~/.ssh`) appear only as *protected
 * paths whose readability is asserted to be absent*, which reads nothing: the probe discards any read
 * to `/dev/null` and reports only the verdict.
 *
 * **A host without the execution principal proves the refusal instead.** The principal is provisioned
 * by the commands in `docs/evidence/2026-10-01-execution-isolation.md`; where it is absent, isolation
 * cannot be established and the tests assert the typed blocker that says so, rather than skipping.
 * A skipped security test is indistinguishable from a passed one, and this one is the evidence that
 * the engine cannot reach an operator credential (F03-AC5).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { CommitSha, ConnectorId, DomainError, Fingerprint, OperationId, Result } from '@shiploop/domain';
import type {
  AdapterCapabilities,
  AdapterCompatibility,
  AdapterContext,
  EngineAdapter,
  EngineContinuation,
  EngineSessionHandle,
  EngineStartRequest,
  EngineStopOutcome,
  ExecutionWorkspace,
  TestAccess,
} from '@shiploop/adapters';

import {
  ENGINE_ENVIRONMENT_NAMES,
  createIsolatedEngine,
  groupIsAlive,
  isolatedArgv,
  launchTrackedGroup,
  parseProbeReport,
  planIsolation,
  principalTransition,
  readGroupFile,
  readIsolationConfiguration,
  readIsolationSettings,
  stopIsolatedGroup,
  stopTrackedGroup,
} from './isolation.ts';
import type { ExecutionPrincipal, IsolationSettings } from './isolation.ts';

const PRINCIPAL_USER = process.env['SHIPLOOP_TEST_ENGINE_PRINCIPAL'] ?? 'shiploop-engine';
const ENGINE_BINARY = process.env['SHIPLOOP_TEST_ENGINE_BINARY'] ?? '/srv/shiploop/engine-bin/codex';
const SYNTHETIC_ENV_NAME = 'SHIPLOOP_SYNTHETIC_CREDENTIAL';
const SYNTHETIC_ENV_VALUE = 'synthetic-value-not-a-real-credential';
const PROVISIONING_HINT =
  'Provision the execution principal first: sudo -n groupadd --system --gid 1999 shiploop-engine && ' +
  'sudo -n useradd --system --uid 1999 --gid 1999 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin shiploop-engine ' +
  '(see docs/evidence/2026-10-01-execution-isolation.md)';

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly root: string;
  readonly launcherRoot: string;
  readonly homeRoot: string;
  readonly tempRoot: string;
  readonly workspace: string;
  /**
   * A synthetic operator home, seeded by this fixture.
   *
   * It stands in for the operator's real home rather than reading `HOME`, because the verification
   * harness deliberately runs every command against an empty temporary home so no operator
   * credential leaks into a check (`scripts/lib/command.mjs`). Reading the ambient home made these
   * assertions vacuous under that harness — the seeded paths simply did not exist — while passing
   * only on a host whose real home happened to be populated.
   */
  readonly operatorHome: string;
  /** 0700, so nothing outside this process may read what is seeded in it. */
  readonly privateDir: string;
  readonly seededSecretFile: string;
  readonly seededDatabaseFile: string;
  readonly databaseFile: string;
  readonly settings: IsolationSettings;
}

/**
 * A tree the isolation plan can work with.
 *
 * Every directory above the workspace is traversable, because the execution principal has to reach
 * the launcher and the workspace at all; the seeded secrets are inside one `0700` directory, which is
 * what an operator's credential directory looks like to another uid.
 */
async function withFixture(overrides: (base: IsolationSettings) => IsolationSettings, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-isolation-'));
  try {
    await chmod(root, 0o755);
    const launcherRoot = join(root, 'launcher');
    const homeRoot = join(root, 'home-root');
    const tempRoot = join(root, 'temp-root');
    const workspace = join(root, 'workspace');
    const operatorHome = join(root, 'operator-home');
    const privateDir = join(root, 'private');
    const databaseFile = join(root, 'state', 'shiploop.sqlite');
    await mkdir(workspace, { recursive: true });
    await mkdir(privateDir, { recursive: true });
    await mkdir(join(root, 'state'), { recursive: true });
    await chmod(privateDir, 0o700);
    await chmod(join(root, 'state'), 0o700);

    // Seeded, and deliberately NOT readable by the execution principal: an operator home another uid
    // can read is the historical failure this boundary exists to prevent, and the launcher refuses
    // that outright. So the modes here are what a real operator home looks like from outside, and the
    // assertions below then prove the engine is kept out of material it has no other reason to miss.
    // Only the config's unreadability is asserted — it has to be a real profile to be worth keeping
    // out, and its bytes are a plausible `never`-approval profile rather than the unrestricted-sandbox
    // literal this repository's own policy lint bans.
    await mkdir(join(operatorHome, '.ssh'), { recursive: true });
    await mkdir(join(operatorHome, '.codex'), { recursive: true });
    await writeFile(join(operatorHome, '.ssh', 'id_ed25519'), 'synthetic operator private key\n', { mode: 0o600 });
    await writeFile(
      join(operatorHome, '.codex', 'config.toml'),
      'model = "gpt-5-codex"\napproval_policy = "never"\n',
      { mode: 0o600 },
    );
    await chmod(join(operatorHome, '.ssh'), 0o700);
    await chmod(join(operatorHome, '.codex'), 0o700);
    await chmod(operatorHome, 0o700);

    const seededSecretFile = join(privateDir, 'seeded-secret.txt');
    const seededDatabaseFile = join(privateDir, 'seeded-authoritative.sqlite');
    await writeFile(seededSecretFile, 'synthetic-secret-for-the-isolation-probe\n', { mode: 0o600 });
    await writeFile(seededDatabaseFile, 'SQLite format 3 synthetic authoritative store\n', { mode: 0o600 });
    await writeFile(databaseFile, 'SQLite format 3 synthetic authoritative store\n', { mode: 0o600 });

    const principal = readPrincipal();
    const base = readIsolationSettings({
      SHIPLOOP_ENGINE_PRINCIPAL: PRINCIPAL_USER,
      SHIPLOOP_ENGINE_UID: principal === null ? '1999' : String(principal.uid),
      SHIPLOOP_ENGINE_GID: principal === null ? '1999' : String(principal.gid),
      SHIPLOOP_ENGINE_HOME_ROOT: homeRoot,
      SHIPLOOP_ENGINE_TEMP_ROOT: tempRoot,
      SHIPLOOP_ENGINE_LAUNCHER_ROOT: launcherRoot,
      SHIPLOOP_ENGINE_BINARY: ENGINE_BINARY,
      SHIPLOOP_ENGINE_OPERATOR_HOME: operatorHome,
      SHIPLOOP_ENGINE_PROTECTED_PATHS: [
        join(operatorHome, '.ssh'),
        join(operatorHome, '.ssh', 'id_ed25519'),
        join(operatorHome, '.codex', 'config.toml'),
      ].join(':'),
      SHIPLOOP_ENGINE_DATABASE_PATH: databaseFile,
      SHIPLOOP_ENGINE_COMMAND_TIMEOUT_MS: '30000',
      HOME: operatorHome,
    });
    assert.ok(base.ok, `the fixture settings were refused: ${base.ok ? '' : describeError(base.error)}`);

    await run({
      root,
      launcherRoot,
      homeRoot,
      tempRoot,
      workspace,
      operatorHome,
      privateDir,
      seededSecretFile,
      seededDatabaseFile,
      databaseFile,
      settings: overrides(base.value),
    });
  } finally {
    await reclaimFixture(root);
  }
}

/**
 * Hands the fixture back before removing it.
 *
 * The plan deliberately gave the workspace and the per-attempt directories to the execution
 * principal, so this process can no longer unlink what is inside them. Reclaiming first is what keeps
 * the test from leaving `0700` directories owned by another identity under `/tmp`, and it is done
 * with the same one command the plan used, in reverse.
 */
async function reclaimFixture(root: string): Promise<void> {
  const uid = operatorUid();
  spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/chown', '-R', `${String(uid)}:${String(operatorGid())}`, root], { timeout: 30_000 });
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* a fixture another identity still owns is left for the operating system to reap */
  }
}

/** The provisioned execution principal, or null where this host has none. */
function readPrincipal(): ExecutionPrincipal | null {
  const uid = identityOf(['/usr/bin/id', '-u', PRINCIPAL_USER]);
  const gid = identityOf(['/usr/bin/id', '-g', PRINCIPAL_USER]);
  if (uid === null || gid === null) return null;
  if (uid === operatorUid()) return null;
  return { user: PRINCIPAL_USER, uid, gid };
}

function identityOf(argv: readonly string[]): number | null {
  const observed = spawnSync(argv[0] ?? '', [...argv.slice(1)], { encoding: 'utf8', timeout: 10_000 });
  const value = (observed.stdout ?? '').trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

/** The synthetic credential a forwarded environment would have carried. */
function seedSyntheticEnvironmentVariable(): void {
  process.env[SYNTHETIC_ENV_NAME] = SYNTHETIC_ENV_VALUE;
}

/** This process's uid, which is the identity the boundary must never be reached through. */
function operatorUid(): number {
  const uid = process.getuid?.();
  assert.ok(uid !== undefined, 'this test needs process.getuid, so it is running on a POSIX platform');
  return uid;
}

function operatorGid(): number {
  const gid = process.getgid?.();
  assert.ok(gid !== undefined, 'this test needs process.getgid, so it is running on a POSIX platform');
  return gid;
}

function describeError(error: DomainError): string {
  return error.code === 'Blocked'
    ? `${error.reason} ${error.prerequisites.map((prerequisite) => `${prerequisite.name}: ${prerequisite.detail}`).join(' ')}`
    : error.reason;
}

/**
 * What a refusal must look like when this host has no execution principal.
 *
 * The assertion is about the *typed* answer: a `Blocked` error naming the missing principal with a
 * remedy, and no launcher installed. It is the same shape a half-provisioned host produces, which is
 * why the test is worth having even where isolation does work.
 */
function assertRefusedWithoutPrincipal(outcome: Result<unknown, DomainError>, what: string): void {
  assert.equal(outcome.ok, false, `${what} must be refused where the execution principal does not exist. ${PROVISIONING_HINT}`);
  if (outcome.ok) return;
  assert.equal(outcome.error.code, 'Blocked', `${what}: expected a Blocked error, received ${outcome.error.code}`);
  if (outcome.error.code !== 'Blocked') return;
  assert.ok(outcome.error.prerequisites.length > 0, `${what}: a refusal must name what failed`);
  for (const prerequisite of outcome.error.prerequisites) {
    assert.ok(prerequisite.remedy.trim() !== '', `${what}: ${prerequisite.name} must carry a remedy`);
  }
}

/* -------------------------------------------------------------------------- */
/* The proof                                                                   */
/* -------------------------------------------------------------------------- */

test('F03-AC5: the launched child cannot read a seeded secret, the operator .ssh or the authoritative database, and can still write in its workspace', async () => {
  seedSyntheticEnvironmentVariable();
  try {
    await withFixture((base) => base, async (fixture) => {
      if (readPrincipal() === null) {
        assertRefusedWithoutPrincipal(
          await planIsolation(fixture.settings, {
            attemptId: 'ws_proof',
            workspacePath: fixture.workspace,
            additionalProtectedPaths: [fixture.seededSecretFile, fixture.seededDatabaseFile, fixture.privateDir],
          }),
          'a host without the execution principal',
        );
        return;
      }

      const planned = await planIsolation(fixture.settings, {
        attemptId: 'ws_proof',
        workspacePath: fixture.workspace,
        additionalProtectedPaths: [fixture.seededSecretFile, fixture.seededDatabaseFile, fixture.privateDir],
      });
      assert.ok(planned.ok, `the boundary was refused on a provisioned host: ${planned.ok ? '' : describeError(planned.error)}`);
      const plan = planned.value;
      const report = plan.report;

      // The child became somebody else. This is the whole boundary in one assertion.
      assert.equal(report.uid, fixture.settings.principal.uid, 'the launched child did not become the execution principal');
      assert.notEqual(report.uid, operatorUid(), 'the launched child ran as the operator, which is the exposure this closes');
      assert.equal(report.gid, fixture.settings.principal.gid);

      // Its home is ShipLoop's, so the operator's Codex profile cannot switch its sandbox off.
      assert.equal(report.home, plan.homePath);
      assert.notEqual(report.home, fixture.operatorHome);
      const operatorConfig = join(fixture.operatorHome, '.codex', 'config.toml');
      assert.ok(!report.environmentNames.includes('CODEX_HOME'), 'the engine was pointed at an operator Codex home');

      // Nothing protected was readable: the seeded secrets, the operator's ssh directory and key, and
      // the authoritative database the worker itself owns.
      for (const path of [fixture.seededSecretFile, fixture.seededDatabaseFile, fixture.privateDir, fixture.databaseFile, join(fixture.operatorHome, '.ssh'), join(fixture.operatorHome, '.ssh', 'id_ed25519'), operatorConfig]) {
        assert.ok(!report.readable.includes(path), `the launched child could read ${path}`);
      }

      // The credential-shaped variable did not survive, by name, while the engine's own variables did.
      assert.ok(!report.environmentNames.includes(SYNTHETIC_ENV_NAME), `the launched child inherited ${SYNTHETIC_ENV_NAME}`);
      assert.ok(!report.environmentNames.includes('LINEAR_API_KEY'));
      assert.ok(!report.environmentNames.includes('SSH_AUTH_SOCK'));
      for (const expected of ENGINE_ENVIRONMENT_NAMES) {
        assert.ok(report.environmentNames.includes(expected), `the launched child was not given ${expected}`);
      }
      const launcher = await readFile(plan.launcherPath, 'utf8');
      assert.ok(!launcher.includes(SYNTHETIC_ENV_NAME), 'the installed launcher mentions the seeded credential name');
      assert.ok(!launcher.includes('LINEAR_API_KEY'), 'the installed launcher names a provider credential');
      assert.ok(launcher.includes(`'${PRINCIPAL_USER}'`), 'the launcher does not name the execution principal');
      assert.ok(launcher.includes(`'HOME=${plan.homePath}'`), 'the launcher does not set the ShipLoop-owned home');
      assert.ok(launcher.includes(`'/usr/bin/env' -i`), 'the launcher does not build an empty environment');

      // It can still do its job: it wrote in the workspace it was assigned.
      assert.equal(report.wroteInWorkspace, true, 'the launched child could not write in the workspace it was assigned');
      await assert.rejects(
        () => stat(join(fixture.workspace, '.shiploop-isolation-probe')),
        'the probe left a marker in the attempt worktree, where it would be an untracked file',
      );
      const owner = (await stat(fixture.workspace)).uid;
      assert.equal(owner, fixture.settings.principal.uid, 'the workspace was not handed to the execution principal');

      // An interactive stdin would let a turn block on input nobody sends.
      assert.equal(report.stdinIsTerminal, false);

      // A home of its own, and one the principal alone owns.
      const homeStat = await stat(plan.homePath);
      assert.equal(homeStat.uid, fixture.settings.principal.uid);
      assert.equal(homeStat.mode & 0o777, 0o700, 'the engine home is reachable by another identity');
    });
  } finally {
    delete process.env[SYNTHETIC_ENV_NAME];
  }
});

test('F03-AC5: the engine binary the launcher names really runs as the execution principal', async () => {
  await withFixture((base) => base, async (fixture) => {
    if (readPrincipal() === null) return;
    const planned = await planIsolation(fixture.settings, { attemptId: 'ws_engine', workspacePath: fixture.workspace });
    assert.ok(planned.ok, `the boundary was refused: ${planned.ok ? '' : describeError(planned.error)}`);
    const plan = planned.value;

    const launched = launchTrackedGroup([plan.launcherPath, '--version'], { cwd: fixture.workspace });
    assert.ok(launched.ok, `the launcher could not start the engine: ${launched.ok ? '' : launched.error.reason}`);
    const child = launched.value;
    const exited = await child.finished();
    assert.equal(exited.exitCode, 0, `the engine exited ${String(exited.exitCode)}: ${child.errorOutput().slice(0, 400)}`);
    assert.match(child.output().trim(), /^codex-cli \d+\.\d+\.\d+$/, `the engine did not report a version: ${child.output().slice(0, 200)}`);

    // The group the launcher led is recorded, and it is the leader's own pid rather than a name.
    const groupId = await readGroupFile(plan.groupFilePath);
    assert.ok(groupId !== null, 'the launcher recorded no process group');
    assert.equal(groupIsAlive(groupId as number), false, 'the version probe left its process group running');

    // The same transition, spelled out, is what the launcher runs: a sudo that cannot prompt.
    const transition = principalTransition(fixture.settings);
    assert.equal(transition.kind, 'Sudo');
    assert.deepEqual([...transition.argv], ['/usr/bin/sudo', '-n', '-u', PRINCIPAL_USER, '--']);
  });
});

test('F17-AC1: stopping an isolated run by its process group leaves no descendant behind', async () => {
  await withFixture((base) => base, async (fixture) => {
    if (readPrincipal() === null) return;
    const planned = await planIsolation(fixture.settings, { attemptId: 'ws_tree', workspacePath: fixture.workspace });
    assert.ok(planned.ok, `the boundary was refused: ${planned.ok ? '' : describeError(planned.error)}`);
    const plan = planned.value;

    /**
     * A tree, not one process: the descendant is the point, because a signal that reaches only the
     * leader leaves a `sleep` running in a workspace nobody believes is still busy (F17-AC5).
     */
    const pidFile = join(fixture.workspace, 'descendant.pid');
    const script = `sleep 120 & echo $! > ${pidFile}; sleep 120`;
    const launched = launchTrackedGroup(isolatedArgv(fixture.settings, { program: '/bin/sh', args: ['-c', script], home: plan.homePath }), {
      cwd: fixture.workspace,
    });
    assert.ok(launched.ok, `the isolated tree could not be launched: ${launched.ok ? '' : launched.error.reason}`);
    const child = launched.value;

    const descendant = await readPidFile(pidFile);
    assert.ok(descendant !== null, 'the isolated child never reported a descendant');
    assert.equal(groupIsAlive(child.processGroupId), true);
    assert.equal(processState(descendant as number), 'alive');

    const stopped = await stopTrackedGroup(child, {
      gracefulStopMs: 1_000,
      killWaitMs: 2_000,
      transition: principalTransition(fixture.settings),
      killBinary: fixture.settings.killBinary,
    });
    assert.ok(stopped.ok, `the stop was refused: ${stopped.ok ? '' : stopped.error.reason}`);
    assert.deepEqual([...stopped.value.survivors], [], `the group still had survivors: ${stopped.value.survivors.join(', ')}`);
    assert.equal(groupIsAlive(child.processGroupId), false, 'the process group still answers after the kill');
    assert.equal(processState(child.pid), 'gone', 'the group leader survived the kill');
    assert.equal(processState(descendant as number), 'gone', 'a descendant of the isolated run survived the kill');
  });
});

test('F17-AC1: the group a launcher recorded is stopped by group id, and nothing is claimed for a group nothing recorded', async () => {
  await withFixture((base) => base, async (fixture) => {
    if (readPrincipal() === null) return;
    const planned = await planIsolation(fixture.settings, { attemptId: 'ws_recorded', workspacePath: fixture.workspace });
    assert.ok(planned.ok, `the boundary was refused: ${planned.ok ? '' : describeError(planned.error)}`);
    const plan = planned.value;

    const absent = await stopIsolatedGroup(join(fixture.launcherRoot, 'never-recorded.pid'), {
      gracefulStopMs: 100,
      killWaitMs: 100,
      transition: principalTransition(fixture.settings),
    });
    assert.equal(absent.ok, false, 'stopping a group nothing recorded must be refused');
    if (!absent.ok) {
      assert.equal(absent.error.code, 'NotFound');
      assert.match(absent.error.reason, /no engine process group/i);
    }

    // Record a group that is genuinely running, stop it, and read the report.
    const launched = launchTrackedGroup(isolatedArgv(fixture.settings, { program: '/bin/sh', args: ['-c', 'sleep 120'], home: plan.homePath }), {
      cwd: fixture.workspace,
    });
    assert.ok(launched.ok);
    await writeFile(plan.groupFilePath, `${String(launched.value.processGroupId)}\n`, 'utf8');
    const stopped = await stopIsolatedGroup(plan.groupFilePath, {
      gracefulStopMs: 1_000,
      killWaitMs: 2_000,
      transition: principalTransition(fixture.settings),
      killBinary: fixture.settings.killBinary,
    });
    assert.ok(stopped.ok, `the recorded group could not be stopped: ${stopped.ok ? '' : stopped.error.reason}`);
    assert.equal(stopped.value.groupId, launched.value.processGroupId);
    assert.deepEqual([...stopped.value.survivors], []);
    assert.equal(processState(launched.value.pid), 'gone');
  });
});

test('F03-AC5: a principal that is the worker\u2019s own uid establishes no boundary at all, and the refusal says which check failed', async () => {
  await withFixture(
    (base) => ({ ...base, principal: { user: process.env['USER'] ?? 'operator', uid: operatorUid(), gid: operatorGid() } }),
    async (fixture) => {
      const planned = await planIsolation(fixture.settings, {
        attemptId: 'ws_not_isolated',
        workspacePath: fixture.workspace,
        additionalProtectedPaths: [fixture.seededSecretFile, fixture.privateDir],
      });
      assert.equal(planned.ok, false, 'a plan that shares the operator uid must be refused');
      if (planned.ok) return;
      assert.equal(planned.error.code, 'Blocked');
      assert.match(planned.error.reason, /not a boundary|no coding work was dispatched/i);
      assert.ok(planned.error.prerequisites.length > 0, 'the refusal must name what failed');
      for (const prerequisite of planned.error.prerequisites) {
        assert.ok(prerequisite.remedy.trim() !== '', `${prerequisite.name} must carry a remedy`);
      }
      /**
       * Which check fires first is a fact about this host, and both answers are correct.
       *
       * A launcher directory this process owns is writable by the principal when the principal is
       * this process, which is the launcher-integrity refusal; a launcher directory owned by somebody
       * else gets as far as the probe, which then finds every protected path readable. Either way no
       * launcher is handed out and no engine is started.
       */
      const names = planned.error.prerequisites.map((prerequisite) => prerequisite.name);
      assert.ok(
        names.some((name) => name === 'launcher-integrity' || name === 'protected-path' || name === 'execution-principal'),
        `the refusal named none of the checks that apply: ${names.join(', ')}`,
      );
    },
  );
});

test('F03-AC5: an operator home the execution principal can read refuses the dispatch and names that home', async () => {
  if (readPrincipal() === null) return;
  await withFixture((base) => base, async (fixture) => {
    /**
     * A readable operator home is the historical failure this boundary exists to prevent, so it is
     * staged with a synthetic one: a directory the operator can read and the principal can too.
     */
    const readableHome = join(fixture.root, 'readable-home');
    await mkdir(readableHome, { recursive: true });
    await chmod(readableHome, 0o755);
    await writeFile(join(readableHome, 'hosts.yml'), 'synthetic credential file\n', { mode: 0o644 });

    const planned = await planIsolation(
      { ...fixture.settings, operatorHome: readableHome },
      { attemptId: 'ws_readable_home', workspacePath: fixture.workspace },
    );
    assert.equal(planned.ok, false, 'a readable operator home must refuse the dispatch');
    if (planned.ok) return;
    assert.equal(planned.error.code, 'Blocked');
    const leaked = planned.error.prerequisites.filter((prerequisite) => prerequisite.name === 'protected-path');
    assert.ok(leaked.length > 0, 'the refusal must name the readable path');
    const named = leaked.map((prerequisite) => prerequisite.detail).join(' ');
    assert.ok(named.includes(readableHome), `the refusal did not name the readable home: ${named}`);
    assert.match(leaked[0]?.remedy ?? '', /permissions|protected/i);
  });
});

test('F03-AC5: an engine binary the principal cannot execute refuses the dispatch instead of spawning it unisolated', async () => {
  await withFixture((base) => ({ ...base, engineBinary: '/srv/shiploop/engine-bin/does-not-exist' }), async (fixture) => {
    const planned = await planIsolation(fixture.settings, { attemptId: 'ws_no_engine', workspacePath: fixture.workspace });
    assert.equal(planned.ok, false, 'a plan whose engine binary is missing must be refused');
    if (planned.ok) return;
    assert.match(describeError(planned.error), /probe|dispatch/i);
  });
});

test('F03-AC5: the environment boundary refuses an execution uid equal to the worker\u2019s own, and a launcher path that would need shell escaping', () => {
  const refusedUid = readIsolationSettings({
    SHIPLOOP_ENGINE_UID: String(operatorUid()),
    SHIPLOOP_ENGINE_GID: String(operatorGid()),
    SHIPLOOP_ENGINE_HOME_ROOT: '/srv/shiploop/engine-homes',
    SHIPLOOP_ENGINE_LAUNCHER_ROOT: '/srv/shiploop/bin',
    SHIPLOOP_ENGINE_BINARY: '/srv/shiploop/engine-bin/codex',
  });
  assert.equal(refusedUid.ok, false);
  if (!refusedUid.ok && refusedUid.error.code === 'Invalid') {
    assert.ok(refusedUid.error.fields.some((field) => field.path === 'SHIPLOOP_ENGINE_UID'), 'the refusal must name the uid setting');
  }

  const refusedPath = readIsolationSettings({
    SHIPLOOP_ENGINE_UID: '1999',
    SHIPLOOP_ENGINE_GID: '1999',
    SHIPLOOP_ENGINE_HOME_ROOT: '/srv/shiploop/engine homes',
    SHIPLOOP_ENGINE_LAUNCHER_ROOT: '/srv/shiploop/bin',
    SHIPLOOP_ENGINE_BINARY: '/srv/shiploop/engine-bin/codex',
  });
  assert.equal(refusedPath.ok, false, 'a path with a space must be refused rather than escaped');
  if (!refusedPath.ok && refusedPath.error.code === 'Invalid') {
    assert.ok(refusedPath.error.fields.some((field) => field.path === 'SHIPLOOP_ENGINE_HOME_ROOT'));
  }

  const absent = readIsolationConfiguration({});
  assert.ok(absent.ok);
  assert.equal(absent.value, null, 'an environment that mentions nothing must report no isolation, not a default');

  const partial = readIsolationConfiguration({ SHIPLOOP_ENGINE_UID: '1999' });
  assert.equal(partial.ok, false, 'half a configuration is a fault, not an unconfigured deployment');
});

test('F03-AC5: the isolated engine port starts no session when the boundary cannot be established', async () => {
  let built = 0;
  let started = 0;
  const refused = <T>(): Promise<Result<T, DomainError>> => Promise.resolve({ ok: false, error: { code: 'NotFound', reason: 'the double is never reached' } });
  const engine: EngineAdapter = {
    kind: 'Engine',
    connectorId: TEST_CONNECTOR,
    capabilities: (): AdapterCapabilities => ({ kind: 'Engine', contractVersion: 1, declarations: [] }),
    checkCompatibility: (): Promise<Result<AdapterCompatibility>> => refused(),
    startSession: (): Promise<Result<EngineSessionHandle>> => {
      started += 1;
      return refused();
    },
    resumeSession: (): Promise<Result<EngineContinuation>> => refused(),
    stopSession: (): Promise<Result<EngineStopOutcome>> => refused(),
  };

  await withFixture(
    (base) => ({ ...base, principal: { user: process.env['USER'] ?? 'operator', uid: operatorUid(), gid: operatorGid() } }),
    async (fixture) => {
      const refusals: DomainError[] = [];
      const port = createIsolatedEngine({
        isolation: fixture.settings,
        buildEngine: (): EngineAdapter => {
          built += 1;
          return engine;
        },
        connectorId: TEST_CONNECTOR,
        gracefulStopMs: 100,
        killWaitMs: 100,
        onRefusal: (error): void => {
          refusals.push(error);
        },
      });

      const request: EngineStartRequest = {
        operationId: TEST_OPERATION,
        workspace: executionWorkspaceOf(fixture.workspace),
        start: { kind: 'Fresh', instruction: 'do nothing' },
        mode: 'Headless',
        grantedCapabilities: [],
        bounds: { activeWallClockMs: 1_000, retryBudget: 0, eventCountLimit: 1 },
      };
      const started = await port.startSession(adapterContext(), request);

      assert.equal(started.ok, false, 'a session must not start when the boundary cannot be established');
      if (started.ok) return;
      assert.equal(started.error.code, 'Blocked');
      assert.equal(refusals.length, 1, 'the refusal must reach the runtime\u2019s reporter');
      assert.equal(refusals[0]?.code, 'Blocked');

      // A stop for a session this port never started asserts nothing about a group (F17-AC5).
      const stopped = await port.stopSession(adapterContext(), {
        operationId: TEST_OPERATION,
        sessionId: 'session_never_started' as never,
        reason: 'PauseRequested',
      });
      assert.ok(stopped.ok === false || stopped.value.kind === 'Detached' || stopped.value.kind === 'StopRefused');
    },
  );
  assert.equal(started, 0, `a session was started for a refused plan: ${String(started)}`);
  // One adapter is built for the identity and capability surface, which spawns nothing; a second one
  // would mean a session launcher was handed out for a plan that was refused.
  assert.equal(built, 1, `engine adapters built for one refused plan: ${String(built)}`);
});

test('N02-AC3: a probe report that does not answer every question is refused rather than read as a pass', () => {
  const partial = parseProbeReport('uid=1999\ngid=1999\nhome=/srv/shiploop/engine-homes/a/home\n');
  assert.equal(partial.ok, false, 'a probe that never reported a write result must be refused');
  const noisy = parseProbeReport('uid=1999\nthis line has no answer\n');
  assert.equal(noisy.ok, false, 'an unparseable line must be refused');
  const complete = parseProbeReport(
    ['uid=1999', 'gid=1999', 'groups=1999', 'home=/srv/shiploop/engine-homes/a/home', 'envnames=HOME,PATH', 'stdin=notty', 'wrote=ok', 'denied=/root/.ssh', 'readable=/srv/a/secret'].join('\n'),
  );
  assert.ok(complete.ok);
  assert.deepEqual([...complete.value.readable], ['/srv/a/secret']);
  assert.equal(complete.value.wroteInWorkspace, true);
  assert.equal(complete.value.stdinIsTerminal, false);
  const unwritten = parseProbeReport('uid=1999\ngid=1999\nhome=/srv/a/home\nwrote=\n');
  assert.ok(unwritten.ok);
  assert.equal(unwritten.value.wroteInWorkspace, false);
});

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

async function readPidFile(path: string): Promise<number | null> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const raw = (await readFile(path, 'utf8')).trim();
      if (/^\d+$/.test(raw)) return Number(raw);
    } catch {
      /* the child has not written it yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/**
 * Whether a pid still names a process.
 *
 * `EPERM` means alive and owned by somebody else, which is exactly the case here: the isolated
 * children run as the execution principal, so this process may not signal them and `kill(pid, 0)`
 * answers `EPERM` rather than succeeding. Treating that as gone would report a stop that never
 * happened, so only `ESRCH` counts as gone (F17-AC1, F17-AC5).
 */
function processState(pid: number): 'alive' | 'gone' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'alive';
  }
}

const TEST_CONNECTOR = 'engine_isolation_test' as ConnectorId;
const TEST_OPERATION = 'op_isolation_test' as OperationId;

function adapterContext(): AdapterContext {
  return {
    correlationId: 'isolation-test',
    operationId: TEST_OPERATION,
    clock: { now: (): string => new Date().toISOString(), elapsedMs: (): number => 0 },
    logger: { emit: (): void => undefined },
    signal: new AbortController().signal,
    redact: (text: string): string => text,
  };
}

function executionWorkspaceOf(absolutePath: string): ExecutionWorkspace {
  const testAccess: TestAccess = { kind: 'None' };
  return {
    workspaceId: 'ws_port_refusal',
    absolutePath,
    headSha: '0'.repeat(40) as CommitSha,
    baseSha: '0'.repeat(40) as CommitSha,
    environmentFingerprint: 'f'.repeat(64) as Fingerprint,
    scopeFingerprint: 'f'.repeat(64) as Fingerprint,
    isolatedPorts: {},
    serviceEndpoints: [],
    testAccess,
  };
}