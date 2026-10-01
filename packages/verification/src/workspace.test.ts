/**
 * Isolated workspace and resource ownership proof (F14-AC1 to F14-AC5).
 *
 * Every case runs against a real Git repository, a real migrated SQLite database
 * and real child processes, in real temporary directories that are removed in
 * `finally`. Nothing here is asserted against a fake:
 *
 *   - a worktree is a real linked worktree, and "an unrelated worktree is
 *     untouched" is proven by comparing its bytes and its diff before and after,
 *     not by observing that no function was called (F14-AC2);
 *   - a port is proven free by binding it and proven occupied by a refusal to
 *     bind it against a real listener, because a mock that answers "free" proves
 *     nothing about the host (F14-AC3);
 *   - cleanup is proven against real detached process groups, since a cleanup never
 *     pointed at a live process is a claim rather than a result (F14-AC5).
 *
 * The durable ownership rows come from the tables `@shiploop/storage` migrates, so
 * the port collision asserted here is enforced by the real unique index on
 * `workspace_ports.port` and not by this file's expectations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommitSha, DomainError, JobId, Result } from '@shiploop/domain';
import { MEMORY_PATH, migrate, openDatabase } from '@shiploop/storage';
import type { Database } from '@shiploop/storage';
import type { OwnedProcess } from './preflight.ts';
import {
  nodeProcessRunner,
  removeOwnedPath,
  spawnOwnedProcess,
  stopOwnedProcessGroup,
} from './process-runner.ts';
import type {
  PrepareWorkspaceDeps,
  PrepareWorkspaceRequest,
  PreparedWorkspace,
  PortBinder,
  WorkspaceCheckpoint,
  WorkspaceOwnership,
  WorkspaceReuseRefusal,
  WorkspaceReuseReport,
} from './workspace.ts';
import {
  cleanupWorkspace,
  createPortBinder,
  deriveWorkspaceId,
  prepareWorkspace,
  readOwnedProcesses,
  registerOwnedProcess,
  reuseWorkspace,
  sqliteWorkspaceOwnership,
} from './workspace.ts';

const GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
});
const GIT_IDENTITY: readonly string[] = [
  '-c',
  'user.name=ShipLoop Workspace Test',
  '-c',
  'user.email=workspace@shiploop.invalid',
  '-c',
  'commit.gpgsign=false',
];
const ACQUIRED_AT = '2026-03-04T08:00:00.000Z';
const OWNER = 'writer-alpha';

function describeResult<T, E extends { code: string; reason: string }>(result: Result<T, E>): string {
  return result.ok ? 'a successful result' : `${result.error.code}: ${result.error.reason}`;
}

function expectOk<T>(result: Result<T, DomainError>): T {
  if (!result.ok) assert.fail(`Expected success but got ${describeResult(result)}`);
  return result.value;
}

function expectRefusal(result: Result<unknown, WorkspaceReuseRefusal>): WorkspaceReuseRefusal {
  if (result.ok) assert.fail('Expected the reuse to be refused, but it was allowed.');
  return result.error;
}

function expectReusable(result: Result<WorkspaceReuseReport, WorkspaceReuseRefusal>): WorkspaceReuseReport {
  if (!result.ok) assert.fail(`Expected the reuse to be allowed, but it was refused: ${result.error.error.reason}`);
  return result.value;
}

async function git(cwd: string, argv: readonly string[]): Promise<string> {
  const result = await nodeProcessRunner.run(['git', '-C', cwd, ...argv], {
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes: 262_144,
    env: GIT_ENV,
  });
  assert.equal(result.spawnError, null, `git ${argv.join(' ')} could not be started: ${result.spawnError}`);
  assert.equal(result.timedOut, false, `git ${argv.join(' ')} exceeded its deadline`);
  assert.equal(result.exitCode, 0, `git ${argv.join(' ')} exited ${result.exitCode ?? 'with no code'}: ${result.output}`);
  return result.output;
}

async function makeRepository(root: string, name = 'repository'): Promise<string> {
  const repository = join(root, name);
  await mkdir(repository, { recursive: true });
  await git(repository, ['init', '-b', 'main']);
  await writeFile(join(repository, 'app.ts'), 'export const answer = 42;\n');
  await writeFile(join(repository, 'README.md'), '# pilot change\n');
  await git(repository, ['add', '-A']);
  await git(repository, [...GIT_IDENTITY, 'commit', '-m', 'initial commit']);
  return repository;
}

function realOwnership(): { database: Database; ownership: WorkspaceOwnership } {
  const opened = openDatabase(MEMORY_PATH);
  assert.ok(opened.ok, `The real database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
  const migrated = migrate(opened.value);
  assert.ok(migrated.ok, `The real schema could not be migrated: ${migrated.ok ? '' : migrated.error.reason}`);
  return { database: opened.value, ownership: sqliteWorkspaceOwnership(opened.value) };
}

interface PortBinderLog {
  readonly allocated: number[];
  readonly occupancyChecks: number[];
}

/**
 * Wraps the real binder so the test can show which port came from a port-0 bind.
 *
 * The record is the evidence that allocation is a kernel-assigned port rather than
 * a number this test chose: every recorded port is one the binder returned.
 */
function recordingBinder(inner: PortBinder, log: PortBinderLog): PortBinder {
  return {
    async allocateFreePort() {
      const port = await inner.allocateFreePort();
      if (port !== null) log.allocated.push(port);
      return port;
    },
    async isOccupied(port) {
      log.occupancyChecks.push(port);
      return inner.isOccupied(port);
    },
  };
}

function prepareRequest(overrides: Partial<PrepareWorkspaceRequest> & Pick<PrepareWorkspaceRequest, 'repository' | 'attemptRoot'>): PrepareWorkspaceRequest {
  return {
    jobId: 'job-alpha' as JobId,
    baseRef: 'main',
    branchName: 'shiploop/task-alpha',
    holder: OWNER,
    services: [{ serviceName: 'api', port: null }],
    now: ACQUIRED_AT,
    ...overrides,
  };
}

function depsFor(ownership: WorkspaceOwnership, binder: PortBinder): PrepareWorkspaceDeps {
  return { runCommand: nodeProcessRunner, ports: binder, ownership };
}

function checkpointOf(workspace: PreparedWorkspace, overrides: Partial<WorkspaceCheckpoint> = {}): WorkspaceCheckpoint {
  return {
    checkpointId: 'cp-1',
    workspaceId: workspace.workspaceId,
    branchName: workspace.branchName,
    worktreePath: workspace.paths.worktreePath,
    headSha: workspace.headSha,
    baseSha: workspace.baseSha,
    dirtyFiles: [],
    untrackedFiles: [],
    recordedAt: ACQUIRED_AT,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, deadlineMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > deadlineMs) assert.fail('The awaited process state did not arrive before the deadline.');
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

/** The path a `git worktree list --porcelain` entry names, without its record key. */
function worktreePathOf(record: string): string {
  return record.slice('worktree '.length);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function listenForRealOccupiedPort(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer((_request, response) => {
    response.end('an unrelated service');
  });
  await new Promise<void>((resolve) => {
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return { server, port: address.port };
}

test('a prepared workspace is a linked worktree on a task branch whose lock records its active owner, recorded base and identity, and two workspaces of one repository never collide (F14-AC1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-workspace-ac1-'));
  const { database, ownership } = realOwnership();
  const log: PortBinderLog = { allocated: [], occupancyChecks: [] };
  const binder = recordingBinder(createPortBinder(), log);
  try {
    const repository = await makeRepository(root);
    const mainHead = (await git(repository, ['rev-parse', 'HEAD'])).trim() as CommitSha;
    const attemptRoot = join(root, 'attempt-root');

    const first = expectOk(
      await prepareWorkspace(
        prepareRequest({ repository, attemptRoot }),
        depsFor(ownership, binder),
      ),
    );

    assert.equal(first.lock.holder, OWNER, 'The durable lock must record the active owner.');
    assert.equal(first.lock.branchName, 'shiploop/task-alpha');
    assert.equal(first.lock.worktreePath, first.paths.worktreePath);
    assert.equal(first.lock.acquiredAt, ACQUIRED_AT);
    assert.deepEqual(ownership.readLock(first.workspaceId), first.lock, 'The lock row must be readable as written.');

    assert.equal(first.baseSha, mainHead, 'The workspace must be based on the recorded base ref.');
    assert.equal(first.headSha, mainHead);
    assert.equal(first.baseRef, 'main');

    const lockDocument = JSON.parse(await readFile(first.paths.lockDocumentPath, 'utf8')) as Record<string, unknown>;
    assert.equal(lockDocument['owner'], OWNER, 'The lock document must record the active owner.');
    assert.equal(lockDocument['baseRef'], 'main');
    assert.equal(lockDocument['baseSha'], mainHead, 'The lock document must record the base the worktree was created from.');
    assert.equal(lockDocument['workspaceId'], first.workspaceId);
    assert.equal(lockDocument['branchName'], 'shiploop/task-alpha');

    assert.equal((await git(first.paths.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'shiploop/task-alpha');
    const worktrees = await git(repository, ['worktree', 'list', '--porcelain']);
    assert.match(worktrees, /worktree \/.*shiploop-workspace-ac1-/);
    assert.match(worktrees, /branch refs\/heads\/shiploop\/task-alpha/);

    const second = expectOk(
      await prepareWorkspace(
        prepareRequest({
          repository,
          attemptRoot,
          jobId: 'job-beta' as JobId,
          branchName: 'shiploop/task-beta',
          services: [{ serviceName: 'api', port: null }],
        }),
        depsFor(ownership, binder),
      ),
    );

    assert.notEqual(second.workspaceId, first.workspaceId, 'Two workspaces of one repository must not share an identity.');
    assert.notEqual(second.paths.worktreePath, first.paths.worktreePath);
    assert.notEqual(second.paths.dataDirectory, first.paths.dataDirectory);
    assert.notEqual(second.paths.browserProfileDirectory, first.paths.browserProfileDirectory);
    assert.notEqual(second.paths.processRegistryPath, first.paths.processRegistryPath);
    assert.notEqual(second.branchName, first.branchName);
    assert.equal(ownership.readLock(first.workspaceId)?.holder, OWNER);
    assert.equal(ownership.readLock(second.workspaceId)?.holder, OWNER);
    assert.equal(ownership.readLock(first.workspaceId)?.branchName, 'shiploop/task-alpha');
    assert.equal(ownership.readLock(second.workspaceId)?.branchName, 'shiploop/task-beta');

    const bothWorktrees = await git(repository, ['worktree', 'list', '--porcelain']);
    const listed = bothWorktrees.split('\n').filter((line) => line.startsWith('worktree ')).map(worktreePathOf);
    assert.equal(listed.length, 3, `The repository must list its own checkout plus both task worktrees: ${bothWorktrees}`);

    assert.equal(
      deriveWorkspaceId({ jobId: 'job-alpha', repository, branchName: 'shiploop/task-alpha' }),
      first.workspaceId,
      'The workspace identity must be reproducible from the recorded job, repository and branch.',
    );
    assert.notEqual(
      deriveWorkspaceId({ jobId: 'job-alpha', repository, branchName: 'shiploop/task-alpha-2' }),
      first.workspaceId,
      'A different task branch of the same job must be a different workspace.',
    );
    assert.notEqual(
      deriveWorkspaceId({ jobId: 'job-other', repository, branchName: 'shiploop/task-alpha' }),
      first.workspaceId,
      'A different job on the same branch must be a different workspace.',
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('preparing a task workspace leaves an unrelated worktree and its uncommitted changes byte-identical (F14-AC2)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-workspace-ac2-'));
  const { database, ownership } = realOwnership();
  const binder = createPortBinder();
  try {
    const repository = await makeRepository(root);
    const ownerWorktree = join(root, 'owner-experiment');
    await git(repository, ['worktree', 'add', '-b', 'owner/experiment', ownerWorktree, 'HEAD']);
    await writeFile(join(ownerWorktree, 'app.ts'), 'export const answer = 42;\nexport const ownerEdit = true;\n');
    await writeFile(join(ownerWorktree, 'owner-notes.md'), 'uncommitted owner note\n');
    await rm(join(repository, 'app.ts'));

    const before = {
      files: await Promise.all([
        readFile(join(ownerWorktree, 'app.ts')),
        readFile(join(ownerWorktree, 'owner-notes.md')),
        readFile(join(ownerWorktree, 'README.md')),
      ]),
      diff: await git(ownerWorktree, ['diff', 'HEAD']),
      status: await git(ownerWorktree, ['status', '--porcelain']),
      head: await git(ownerWorktree, ['rev-parse', 'HEAD']),
      worktreeList: await git(repository, ['worktree', 'list', '--porcelain']),
      mainStatus: await git(repository, ['status', '--porcelain']),
      branches: await git(repository, ['branch', '--list']),
    };
    assert.ok(before.diff.length > 0, 'The unrelated worktree must really be dirty for this case to mean anything.');

    const first = expectOk(
      await prepareWorkspace(prepareRequest({ repository, attemptRoot: join(root, 'attempt-root') }), depsFor(ownership, binder)),
    );
    const second = expectOk(
      await prepareWorkspace(
        prepareRequest({
          repository,
          attemptRoot: join(root, 'attempt-root'),
          jobId: 'job-beta' as JobId,
          branchName: 'shiploop/task-beta',
        }),
        depsFor(ownership, binder),
      ),
    );

    const after = {
      files: await Promise.all([
        readFile(join(ownerWorktree, 'app.ts')),
        readFile(join(ownerWorktree, 'owner-notes.md')),
        readFile(join(ownerWorktree, 'README.md')),
      ]),
      diff: await git(ownerWorktree, ['diff', 'HEAD']),
      status: await git(ownerWorktree, ['status', '--porcelain']),
      head: await git(ownerWorktree, ['rev-parse', 'HEAD']),
      worktreeList: await git(repository, ['worktree', 'list', '--porcelain']),
      mainStatus: await git(repository, ['status', '--porcelain']),
      branches: await git(repository, ['branch', '--list']),
    };

    after.files.forEach((content, index) => {
      assert.deepEqual(content, before.files[index], `The unrelated worktree's file ${index} changed byte-for-byte.`);
    });
    assert.equal(after.diff, before.diff, "The unrelated worktree's uncommitted diff must be byte-identical.");
    assert.equal(after.status, before.status, "The unrelated worktree's porcelain status must be byte-identical.");
    assert.equal(after.head, before.head, 'The unrelated worktree must still be on its own commit.');
    assert.equal(after.mainStatus, before.mainStatus, "The owner's own checkout must keep its uncommitted deletion.");
    before.branches
      .split('\n')
      .filter((line) => line.length > 0)
      .forEach((line) => {
        assert.ok(after.branches.includes(line), `The owner's own branch entry "${line}" must survive unchanged.`);
      });
    assert.match(after.branches, /shiploop\/task-alpha/);
    assert.match(after.branches, /shiploop\/task-beta/);

    const listedBefore = before.worktreeList.split('\n').filter((line) => line.startsWith('worktree ')).map(worktreePathOf);
    const listedAfter = after.worktreeList.split('\n').filter((line) => line.startsWith('worktree ')).map(worktreePathOf);
    assert.ok(listedAfter.includes(first.paths.worktreePath), 'The first task worktree must be registered.');
    assert.ok(listedAfter.includes(second.paths.worktreePath), 'The second task worktree must be registered.');
    listedBefore.forEach((line) => {
      assert.ok(listedAfter.includes(line), `The pre-existing worktree ${line} must still be registered.`);
    });

    assert.equal(existsSync(join(first.paths.worktreePath, 'owner-notes.md')), false, 'Task worktrees must not inherit the owner\'s untracked file.');
    assert.equal(existsSync(join(first.paths.worktreePath, 'app.ts')), true, 'The task worktree carries the committed file the owner deleted locally.');
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a worktree alone is not isolation: each attempt gets its own data directory, kernel-allocated ports, browser storage and process registry, and an occupied port is a blocker (F14-AC3)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-workspace-ac3-'));
  const { database, ownership } = realOwnership();
  const log: PortBinderLog = { allocated: [], occupancyChecks: [] };
  const binder = recordingBinder(createPortBinder(), log);
  const occupied = await listenForRealOccupiedPort();
  try {
    const repository = await makeRepository(root);
    const attemptRoot = join(root, 'attempt-root');

    const first = expectOk(
      await prepareWorkspace(
        prepareRequest({ repository, attemptRoot, services: [{ serviceName: 'api', port: null }, { serviceName: 'web', port: null }] }),
        depsFor(ownership, binder),
      ),
    );
    const second = expectOk(
      await prepareWorkspace(
        prepareRequest({
          repository,
          attemptRoot,
          jobId: 'job-beta' as JobId,
          branchName: 'shiploop/task-beta',
          services: [{ serviceName: 'api', port: null }, { serviceName: 'web', port: null }],
        }),
        depsFor(ownership, binder),
      ),
    );

    const firstPorts = first.ports.map((port) => port.port);
    const secondPorts = second.ports.map((port) => port.port);
    assert.equal(new Set([...firstPorts, ...secondPorts]).size, 4, `Two workspaces must not share a port: ${firstPorts} and ${secondPorts}`);
    assert.ok(
      firstPorts.every((port) => log.allocated.includes(port)),
      `Every allocated port must have come from binding port 0: ${firstPorts} against ${log.allocated}`,
    );
    assert.ok(
      secondPorts.every((port) => log.allocated.includes(port)),
      `Every allocated port must have come from binding port 0: ${secondPorts} against ${log.allocated}`,
    );
    for (const port of [...firstPorts, ...secondPorts]) {
      assert.equal(await binder.isOccupied(port), false, `Port ${port} was reported allocated but the host holds it.`);
    }
    firstPorts.forEach((port, index) => {
      assert.equal(ownership.readPortOwner(port)?.workspaceId, first.workspaceId);
      assert.equal(ownership.readPortOwner(port)?.serviceName, first.ports[index]?.serviceName);
    });

    assert.notEqual(first.paths.dataDirectory, second.paths.dataDirectory);
    assert.notEqual(first.paths.browserProfileDirectory, second.paths.browserProfileDirectory);
    assert.notEqual(first.paths.processRegistryPath, second.paths.processRegistryPath);
    for (const path of [first.paths.dataDirectory, first.paths.browserProfileDirectory, first.paths.processRegistryPath, first.paths.lockDocumentPath]) {
      assert.ok(existsSync(path), `${path} must exist for the attempt that owns it.`);
      assert.ok(!second.paths.worktreePath.startsWith(path), 'One attempt root must not nest one workspace inside another.');
    }
    assert.ok(existsSync(first.paths.processRegistryPath), 'The process registry must exist before any process is spawned.');

    const worktreesBefore = (await git(repository, ['worktree', 'list', '--porcelain'])).split('\n').filter((line) => line.startsWith('worktree '));
    const refusedBranch = 'shiploop/task-occupied';
    const refused = await prepareWorkspace(
      prepareRequest({
        repository,
        attemptRoot,
        jobId: 'job-gamma' as JobId,
        branchName: refusedBranch,
        services: [{ serviceName: 'api', port: occupied.port }],
      }),
      depsFor(ownership, binder),
    );
    assert.equal(refused.ok, false, 'An occupied port must never be accepted.');
    if (refused.ok) return;
    assert.equal(refused.error.code, 'Blocked', `A port collision must be a blocker, not a failure: ${refused.error.reason}`);
    assert.match(refused.error.reason, new RegExp(String(occupied.port)));
    assert.match(refused.error.reason, /already holds that port/);
    assert.equal(refused.error.prerequisites.length, 1);
    assert.equal(refused.error.prerequisites[0]?.name, 'isolated-port-api');
    assert.match(refused.error.prerequisites[0]?.remedy ?? '', /F14-AC3/);
    assert.ok(log.occupancyChecks.includes(occupied.port), 'An explicitly requested port must be probed for occupancy, not assumed free.');

    const refusedWorkspaceId = deriveWorkspaceId({ jobId: 'job-gamma', repository, branchName: refusedBranch });
    assert.equal(ownership.readLock(refusedWorkspaceId), null, 'A refused workspace must not leave a lock behind.');
    assert.equal(ownership.readPortOwner(occupied.port), null, 'A refused preparation must not record a reservation for a port it does not own.');
    const worktreesAfter = (await git(repository, ['worktree', 'list', '--porcelain'])).split('\n').filter((line) => line.startsWith('worktree '));
    assert.deepEqual(worktreesAfter, worktreesBefore, 'A refused preparation must not create a worktree.');
    assert.equal((await git(repository, ['branch', '--list', refusedBranch])).trim(), '', 'A refused preparation must not leave a branch.');
    assert.equal(existsSync(join(attemptRoot, 'data', refusedWorkspaceId)), false, 'A refused preparation must not create an isolated data directory.');

    const stolenPort = firstPorts[0] ?? 0;
    const collidingBranch = 'shiploop/task-collision';
    const collided = await prepareWorkspace(
      prepareRequest({
        repository,
        attemptRoot,
        jobId: 'job-delta' as JobId,
        branchName: collidingBranch,
        services: [{ serviceName: 'api', port: stolenPort }],
      }),
      depsFor(ownership, binder),
    );
    assert.equal(collided.ok, false, 'A port already reserved by another workspace must be refused even when nothing is listening.');
    if (collided.ok) return;
    assert.equal(collided.error.code, 'Blocked', `A reserved-port collision must be a blocker: ${collided.error.reason}`);
    assert.match(collided.error.reason, new RegExp(`port ${stolenPort}`));
    assert.match(collided.error.reason, new RegExp(first.workspaceId));
    assert.equal(collided.error.prerequisites[0]?.name, 'isolated-port-allocation');
    const collidedWorkspaceId = deriveWorkspaceId({ jobId: 'job-delta', repository, branchName: collidingBranch });
    assert.equal(ownership.readLock(collidedWorkspaceId), null);
    assert.equal(ownership.readPortOwner(stolenPort)?.jobId, first.jobId, 'The reserved port must still belong to the workspace that holds it.');
  } finally {
    await new Promise<void>((resolve) => {
      occupied.server.close(() => {
        resolve();
      });
    });
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('reuse compares the actual files and HEAD against the retained checkpoint and refuses, naming every unexpected difference (F14-AC4)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-workspace-ac4-'));
  const { database, ownership } = realOwnership();
  const binder = createPortBinder();
  try {
    const repository = await makeRepository(root);
    const workspace = expectOk(
      await prepareWorkspace(
        prepareRequest({ repository, attemptRoot: join(root, 'attempt-root') }),
        depsFor(ownership, binder),
      ),
    );
    const checkpoint = checkpointOf(workspace);
    const reuseDeps = { runCommand: nodeProcessRunner };

    const untouched = expectReusable(await reuseWorkspace({ checkpoint, holder: OWNER, now: ACQUIRED_AT }, reuseDeps));
    assert.deepEqual(untouched.divergences, [], 'An untouched workspace must be reusable, or the comparison proves nothing.');
    assert.equal(untouched.actualHeadSha, workspace.headSha);
    assert.deepEqual(untouched.observedDirtyFiles, []);
    assert.deepEqual(untouched.observedUntrackedFiles, []);

    await writeFile(join(workspace.paths.worktreePath, 'app.ts'), 'export const answer = 43;\n');
    await writeFile(join(workspace.paths.worktreePath, 'owner-notes.md'), 'an edit made by a person\n');

    const refused = expectRefusal(await reuseWorkspace({ checkpoint, holder: OWNER, now: ACQUIRED_AT }, reuseDeps));
    assert.equal(refused.error.code, 'Blocked', `Unexpected human changes must block reuse: ${refused.error.reason}`);
    assert.match(refused.error.reason, /checkpoint cp-1/);
    const kinds = refused.report.divergences.map((divergence) => divergence.kind).sort();
    assert.deepEqual(kinds, ['UnexpectedModification', 'UnexpectedUntrackedFile']);
    const modified = refused.report.divergences.find((divergence) => divergence.kind === 'UnexpectedModification');
    assert.equal(modified?.path, 'app.ts');
    assert.match(modified?.detail ?? '', /app\.ts/);
    assert.match(modified?.detail ?? '', /recorded it as unchanged/);
    const untracked = refused.report.divergences.find((divergence) => divergence.kind === 'UnexpectedUntrackedFile');
    assert.equal(untracked?.path, 'owner-notes.md');
    const prerequisites = refused.error.prerequisites.map((prerequisite) => `${prerequisite.name}: ${prerequisite.detail}`);
    assert.ok(
      prerequisites.some((entry) => entry.startsWith('UnexpectedModification') && entry.includes('app.ts')),
      `The refusal must name the changed file: ${prerequisites.join(' | ')}`,
    );
    assert.ok(
      prerequisites.some((entry) => entry.startsWith('UnexpectedUntrackedFile') && entry.includes('owner-notes.md')),
      `The refusal must name the untracked file: ${prerequisites.join(' | ')}`,
    );
    assert.deepEqual(refused.report.expectedDirtyFiles, []);
    assert.deepEqual(refused.report.observedDirtyFiles, ['app.ts']);

    await git(workspace.paths.worktreePath, ['checkout', '--', 'app.ts']);
    await rm(join(workspace.paths.worktreePath, 'owner-notes.md'));
    await writeFile(join(workspace.paths.worktreePath, 'app.ts'), 'export const answer = 44;\n');
    await git(workspace.paths.worktreePath, ['add', '-A']);
    await git(workspace.paths.worktreePath, [...GIT_IDENTITY, 'commit', '-m', 'agent work']);
    const movedHead = (await git(workspace.paths.worktreePath, ['rev-parse', 'HEAD'])).trim() as CommitSha;

    const headRefusal = expectRefusal(await reuseWorkspace({ checkpoint, holder: OWNER, now: ACQUIRED_AT }, reuseDeps));
    const headDivergence = headRefusal.report.divergences.find((divergence) => divergence.kind === 'HeadMoved');
    assert.ok(headDivergence !== undefined, `A moved HEAD must be reported: ${JSON.stringify(headRefusal.report.divergences)}`);
    assert.match(headDivergence?.detail ?? '', new RegExp(checkpoint.headSha));
    assert.match(headDivergence?.detail ?? '', new RegExp(movedHead));
    assert.equal(headRefusal.report.actualHeadSha, movedHead);

    const resumed = expectReusable(
      await reuseWorkspace(
        { checkpoint: checkpointOf(workspace, { checkpointId: 'cp-2', headSha: movedHead }), holder: OWNER, now: ACQUIRED_AT },
        reuseDeps,
      ),
    );
    assert.deepEqual(resumed.divergences, [], 'A checkpoint that matches the workspace must be reusable again.');
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanup stops only the process groups this attempt spawned, removes only eligible temporaries, and retained work survives ordinary cancellation (F14-AC5)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-workspace-ac5-'));
  const { database, ownership } = realOwnership();
  const binder = createPortBinder();
  const spawned: number[] = [];
  try {
    const repository = await makeRepository(root);
    const workspace = expectOk(
      await prepareWorkspace(
        prepareRequest({ repository, attemptRoot: join(root, 'attempt-root') }),
        depsFor(ownership, binder),
      ),
    );
    await writeFile(join(workspace.paths.dataDirectory, 'fixture.json'), '{"seeded": true}\n');

    const owned = spawnOwnedProcess(['node', '-e', 'setInterval(() => {}, 1000)'], { cwd: workspace.paths.worktreePath });
    const unrelated = spawnOwnedProcess(['node', '-e', 'setInterval(() => {}, 1000)'], { cwd: workspace.paths.worktreePath });
    spawned.push(owned.pid, unrelated.pid);
    const unrelatedRecord: OwnedProcess = { ...unrelated, ownsGroup: false };
    await waitFor(() => isAlive(owned.pid) && isAlive(unrelated.pid));

    const ownedRecord: OwnedProcess = { ...owned, ownsGroup: true };
    expectOk(await registerOwnedProcess(workspace.paths.processRegistryPath, workspace.workspaceId, ownedRecord));
    expectOk(await registerOwnedProcess(workspace.paths.processRegistryPath, workspace.workspaceId, unrelatedRecord));
    const registered = expectOk(await readOwnedProcesses(workspace.paths.processRegistryPath));
    assert.equal(registered.length, 2);
    assert.equal(registered.find((entry) => entry.pid === owned.pid)?.groupId, owned.pid);

    const cleanupDeps = {
      runCommand: nodeProcessRunner,
      ownership,
      stopProcessGroup: stopOwnedProcessGroup,
      removePath: removeOwnedPath,
      now: () => '2026-03-04T08:30:00.000Z',
    };

    const cancelled = expectOk(
      await cleanupWorkspace(
        { workspace, processes: registered, retainWorkspace: true, now: '2026-03-04T08:30:00.000Z' },
        cleanupDeps,
      ),
    );

    assert.deepEqual(cancelled.report.stoppedGroups, [owned.pid], 'Only the group this attempt spawned may be signalled.');
    assert.deepEqual(cancelled.report.untouchedProcessIds, [unrelated.pid], 'A process this attempt did not spawn must be reported untouched.');
    assert.ok(
      cancelled.report.actions.some((action) => action.kind === 'SkipUnownedProcess' && action.target === `pid ${unrelated.pid}`),
      'The unowned process must be skipped explicitly.',
    );
    await waitFor(() => !isAlive(owned.pid));
    assert.equal(isAlive(owned.pid), false, 'The owned child must be gone after cancellation.');
    assert.equal(isAlive(unrelated.pid), true, 'An unrelated child must still be running after cancellation.');

    assert.equal(existsSync(workspace.paths.dataDirectory), false, 'Attempt scratch data is an eligible temporary resource.');
    assert.equal(existsSync(workspace.paths.browserProfileDirectory), false, 'The attempt browser profile is an eligible temporary resource.');
    assert.equal(cancelled.retained, true);
    for (const path of [workspace.paths.worktreePath, workspace.paths.lockDocumentPath, workspace.paths.processRegistryPath]) {
      assert.ok(existsSync(path), `${path} is retained work and must survive ordinary cancellation.`);
    }
    assert.ok(cancelled.retainedPaths.includes(workspace.paths.worktreePath));
    assert.ok(
      cancelled.report.actions.some((action) => action.kind === 'RetainResource' && action.target.startsWith(`worktree:${workspace.workspaceId}`)),
      'Retaining the worktree must be recorded as a decision.',
    );
    assert.ok(
      (await git(repository, ['worktree', 'list', '--porcelain'])).includes(workspace.paths.worktreePath),
      'A retained workspace must stay registered so it can be recovered.',
    );
    assert.ok(ownership.readLock(workspace.workspaceId) !== null, 'A retained workspace keeps its ownership lock.');
    for (const port of workspace.ports) {
      assert.equal(ownership.readPortOwner(port.port), null, 'A stopped service must not keep its port reserved.');
      assert.ok(cancelled.releasedPortReservations.includes(port.port));
    }

    const discarded = expectOk(
      await cleanupWorkspace(
        { workspace, processes: [], retainWorkspace: false, now: '2026-03-04T09:00:00.000Z' },
        cleanupDeps,
      ),
    );
    assert.ok(discarded.removedPaths.includes(workspace.paths.worktreePath));
    assert.equal(existsSync(workspace.paths.worktreePath), false, 'An unretained worktree is eligible for removal.');
    assert.equal(existsSync(workspace.paths.lockDocumentPath), false);
    assert.equal(
      (await git(repository, ['worktree', 'list', '--porcelain'])).includes(workspace.paths.worktreePath),
      false,
      'Removing a worktree must also remove it from the connected repository\'s own record.',
    );
    assert.equal(ownership.readLock(workspace.workspaceId), null, 'A discarded workspace gives up its ownership lock.');
    assert.deepEqual(discarded.retainedPaths, []);
    assert.equal(isAlive(unrelated.pid), true, 'Cleanup must still not have touched the unrelated process.');
  } finally {
    for (const pid of spawned) {
      if (!isAlive(pid)) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
