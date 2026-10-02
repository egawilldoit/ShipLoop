/**
 * The restricted broker, proved against a real remote (F03-AC5, N02-AC3, F19-AC1).
 *
 * The publication half is proved by pushing a real branch into a real bare repository: a test that
 * recorded "the publisher was called" would pass whether or not anything reached the remote, and the
 * whole point of the broker is that a credential performs a write somebody else asked for. The
 * refusal half is proved by the opposite measurement — the privileged deliverer is a spy, and the
 * assertion is that it was never called and that the bare repository's base branch did not move.
 *
 * **The remote is synthetic.** It is a local bare repository in a temporary directory, so the tests
 * perform real Git writes without touching a live repository, a live credential or a live branch
 * (N02-AC2).
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { err, ok } from '@shiploop/domain';
import type { DomainError, Result } from '@shiploop/domain';

import {
  controllerPrincipal,
  createRestrictedBroker,
  describePrincipal,
  isEnginePrincipal,
  refusePrivileged,
  refusePrivilegedDelivery,
  refusePublication,
} from './broker.ts';
import type {
  Broker,
  BrokerOutcome,
  BrokerPrincipal,
  BrokerRepository,
  FeatureBranchCredential,
  MergeReceipt,
  OwnerAuthorization,
  PrivilegedCredential,
  PrivilegedDeliverer,
  PushReceipt,
  ReleaseReceipt,
} from './broker.ts';

const REPOSITORY: BrokerRepository = { provider: 'github', fullName: 'synthetic/shiploop', defaultBranch: 'main' };
const TASK_BRANCH = 'shiploop/task/ws_broker_probe';
const BASE_SHA_PLACEHOLDER = 'base';

interface Remote {
  readonly root: string;
  readonly bare: string;
  readonly worktree: string;
  readonly baseSha: string;
  /** The commit a caller asks the broker to publish. */
  readonly featureSha: string;
  /** The ref the base branch points at in the bare repository, read live. */
  baseRef(): string | null;
  branchRef(branch: string): string | null;
  close(): Promise<void>;
}

/**
 * A real bare remote with one published base commit and one unpushed feature commit.
 *
 * The base commit is on `main` in the remote, the feature commit is in the worktree on a task branch,
 * so a publication that worked is visible as a new remote ref and a refusal is visible as the absence
 * of one — both read back with `git` rather than from anything the broker reported.
 */
async function withRemote(run: (remote: Remote) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-broker-'));
  const bare = join(root, 'remote.git');
  const worktree = join(root, 'worktree');
  try {
    git(['init', '--bare', '--initial-branch=main', bare], root);
    git(['init', '--initial-branch=main', worktree], root);
    git(['-C', worktree, 'config', 'user.email', 'broker-test@shiploop.invalid'], root);
    git(['-C', worktree, 'config', 'user.name', 'ShipLoop Broker Test'], root);
    await writeFile(join(worktree, 'README.md'), 'base\n');
    git(['-C', worktree, 'add', '-A'], root);
    git(['-C', worktree, 'commit', '-m', 'base'], root);
    git(['-C', worktree, 'remote', 'add', 'origin', bare], root);
    git(['-C', worktree, 'push', '-u', 'origin', 'main'], root);
    git(['-C', worktree, 'checkout', '-b', TASK_BRANCH], root);
    await writeFile(join(worktree, 'feature.txt'), 'feature\n');
    git(['-C', worktree, 'add', '-A'], root);
    git(['-C', worktree, 'commit', '-m', 'feature'], root);

    const remote: Remote = {
      root,
      bare,
      worktree,
      baseSha: revParse(worktree, 'HEAD~1'),
      featureSha: revParse(worktree, 'HEAD'),
      baseRef: (): string | null => refIn(bare, 'refs/heads/main'),
      branchRef: (branch: string): string | null => refIn(bare, `refs/heads/${branch}`),
      close: async (): Promise<void> => {
        await rm(root, { recursive: true, force: true });
      },
    };
    await run(remote);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ENGINE: BrokerPrincipal = {
  kind: 'Engine',
  uid: 1999,
  attemptId: 'ws_broker_probe',
  workspacePath: '/srv/shiploop/attempts/worktrees/ws_broker_probe',
};
const CONTROLLER = controllerPrincipal('worker-a');

/** A publisher that performs a real push, and records the credential scope it was handed. */
interface PublisherSpy {
  readonly publisher: Broker['publishFeatureBranch'] extends never ? never : FeatureBranchPublisherSpy;
  readonly scopes: string[];
  readonly branches: string[];
}

interface FeatureBranchPublisherSpy {
  publish(request: {
    readonly repository: BrokerRepository;
    readonly branch: string;
    readonly headSha: string;
    readonly worktreePath: string;
    readonly credential: FeatureBranchCredential;
  }): Promise<Result<PushReceipt, DomainError>>;
}

/** A privileged deliverer that records every call; the refusal tests assert it recorded none. */
interface DelivererSpy {
  readonly deliverer: PrivilegedDeliverer;
  readonly merges: number;
  readonly releases: number;
  readonly credentialScopes: readonly string[];
}

function publisherSpy(remote: Remote): PublisherSpy {
  const scopes: string[] = [];
  const branches: string[] = [];
  return {
    scopes,
    branches,
    publisher: {
      publish: async (request): Promise<Result<PushReceipt, DomainError>> => {
        scopes.push(request.credential.scope);
        branches.push(request.branch);
        const pushed = await pushBranch(remote.bare, request.worktreePath, request.branch, request.headSha);
        if (!pushed.ok) return pushed;
        return ok({
          repository: request.repository.fullName,
          branch: request.branch,
          headSha: request.headSha,
          remoteRef: `refs/heads/${request.branch}`,
          pushedAt: new Date().toISOString(),
        });
      },
    },
  };
}

function delivererSpy(): DelivererSpy {
  const state = { merges: 0, releases: 0, credentialScopes: [] as string[] };
  const deliverer: PrivilegedDeliverer = {
    merge: async (request): Promise<Result<MergeReceipt, DomainError>> => {
      state.merges += 1;
      state.credentialScopes.push(request.credential.scope);
      return ok({
        repository: request.repository.fullName,
        branch: request.branch,
        mergedSha: request.headSha,
        mergedAt: new Date().toISOString(),
      });
    },
    release: async (request): Promise<Result<ReleaseReceipt, DomainError>> => {
      state.releases += 1;
      state.credentialScopes.push(request.credential.scope);
      return ok({
        repository: request.repository.fullName,
        environment: request.environment,
        releasedSha: '0'.repeat(40),
        releasedAt: new Date().toISOString(),
        receiptId: `release_${request.environment}`,
      });
    },
  };
  return {
    deliverer,
    get merges(): number {
      return state.merges;
    },
    get releases(): number {
      return state.releases;
    },
    get credentialScopes(): readonly string[] {
      return state.credentialScopes;
    },
  };
}

function brokerOver(remote: Remote): { readonly broker: Broker; readonly publisher: PublisherSpy; readonly deliverer: DelivererSpy } {
  const publisher = publisherSpy(remote);
  const deliverer = delivererSpy();
  const privileged: PrivilegedCredential = { scope: 'PrivilegedDelivery', secret: 'synthetic-privileged-secret' };
  return {
    publisher,
    deliverer,
    broker: createRestrictedBroker({
      featureBranchCredential: { scope: 'FeatureBranchWrite', secret: 'synthetic-feature-branch-secret' },
      privilegedCredential: privileged,
      publisher: publisher.publisher,
      deliverer: deliverer.deliverer,
      now: (): string => new Date().toISOString(),
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Publication: allowed from the engine path                                   */
/* -------------------------------------------------------------------------- */

test('N02-AC3: the engine path publishes a feature branch through the broker, and the remote really has it', async () => {
  await withRemote(async (remote) => {
    const { broker, publisher } = brokerOver(remote);
    assert.equal(remote.branchRef(TASK_BRANCH), null, 'the feature branch must not exist before the publication');

    const published = await broker.publishFeatureBranch({
      principal: ENGINE,
      repository: REPOSITORY,
      branch: TASK_BRANCH,
      headSha: remote.featureSha,
      worktreePath: remote.worktree,
    });

    assert.ok(published.ok, `the broker refused a feature-branch publication: ${published.ok ? '' : published.error.reason}`);
    assert.equal(published.value.action, 'PublishFeatureBranch');
    assert.deepEqual(published.value.performedBy, ENGINE, 'the outcome must record who asked');
    assert.equal(published.value.receipt.remoteRef, `refs/heads/${TASK_BRANCH}`);
    assert.equal(remote.branchRef(TASK_BRANCH), remote.featureSha, 'the remote does not carry the published commit');
    assert.deepEqual([...publisher.scopes], ['FeatureBranchWrite'], 'publication must use the feature-branch credential scope');
    assert.deepEqual([...publisher.branches], [TASK_BRANCH]);
  });
});

test('F19-AC1: publication refuses the base branch, a ref-shaped name and a nameless commit, and calls nothing', async () => {
  await withRemote(async (remote) => {
    const { broker, publisher } = brokerOver(remote);
    const refusals: string[] = [];

    for (const branch of [REPOSITORY.defaultBranch, 'refs/heads/main', '-main', 'a..b']) {
      const outcome = await broker.publishFeatureBranch({
        principal: CONTROLLER,
        repository: REPOSITORY,
        branch,
        headSha: remote.featureSha,
        worktreePath: remote.worktree,
      });
      assert.equal(outcome.ok, false, `publication of ${branch} must be refused`);
      if (outcome.ok) continue;
      refusals.push(`${outcome.error.code}: ${outcome.error.reason}`);
    }
    const emptyCommit = await broker.publishFeatureBranch({
      principal: CONTROLLER,
      repository: REPOSITORY,
      branch: TASK_BRANCH,
      headSha: '  ',
      worktreePath: remote.worktree,
    });
    assert.equal(emptyCommit.ok, false, 'a publication with no named commit must be refused');

    assert.deepEqual([...publisher.branches], [], 'a refused publication must not reach the credential');
    assert.ok(refusals.some((line) => line.startsWith('Forbidden:')), `no base-branch refusal was recorded: ${refusals.join(' | ')}`);
    assert.ok(
      refusals.some((line) => line.includes('privileged write')),
      `the base-branch refusal must say it is a privileged write: ${refusals.join(' | ')}`,
    );
    assert.equal(remote.baseRef(), remote.baseSha, 'the base branch moved');
    assert.equal(remote.branchRef(TASK_BRANCH), null, 'a refused branch reached the remote');
  });
});

/* -------------------------------------------------------------------------- */
/* Privileged delivery: refused from the engine path                           */
/* -------------------------------------------------------------------------- */

test('F03-AC5: a privileged action from the engine principal is refused, and no privileged credential is touched', async () => {
  await withRemote(async (remote) => {
    const { broker, deliverer } = brokerOver(remote);
    const before = remote.baseRef();

    const merged = await broker.mergeCandidate({
      principal: ENGINE,
      repository: REPOSITORY,
      branch: TASK_BRANCH,
      headSha: remote.featureSha,
      authorization: ownerAuthorizationFor('Merge', TASK_BRANCH),
    });
    assert.equal(merged.ok, false, 'the engine principal must not merge');
    if (merged.ok) return;
    assert.equal(merged.error.code, 'Forbidden');
    assert.match(merged.error.reason, /may not merge/i);
    assert.match(merged.error.reason, /not an owner/i);
    assert.match(merged.error.reason, /F03-AC3/);

    const released = await broker.releaseDeployment({
      principal: ENGINE,
      repository: REPOSITORY,
      environment: 'preview',
      ref: TASK_BRANCH,
      authorization: ownerAuthorizationFor('Release', TASK_BRANCH),
    });
    assert.equal(released.ok, false, 'the engine principal must not release');
    if (released.ok) return;
    assert.equal(released.error.code, 'Forbidden');
    assert.match(released.error.reason, /may not release/i);

    /**
     * The refusal came before the credential, and this is the measurement of that.
     *
     * A refusal that had already loaded the privileged credential would make "the engine asked"
     * indistinguishable from "the engine nearly had it", so the spy must record nothing at all —
     * including the credential scope, which is read only inside the privileged port.
     */
    assert.equal(deliverer.merges, 0, 'the privileged merge port was called for an engine request');
    assert.equal(deliverer.releases, 0, 'the privileged release port was called for an engine request');
    assert.deepEqual([...deliverer.credentialScopes], [], 'a privileged credential scope was observed');
    assert.equal(remote.baseRef(), before, 'the base branch moved');
  });
});

test('F03-AC5: the privileged decision reads the principal and the owner authorization, and nothing else', () => {
  const controller = refusePrivileged(CONTROLLER, 'Merge', TASK_BRANCH, ownerAuthorizationFor('Merge', TASK_BRANCH));
  assert.equal(controller, null, 'a controller with a matching authorization is the privileged path, and it is reachable');

  // The engine principal is refused even holding an authorization that is otherwise perfect, which is
  // the property that makes the refusal a decision rather than a check somebody can satisfy.
  const engine = refusePrivileged(ENGINE, 'Merge', TASK_BRANCH, ownerAuthorizationFor('Merge', TASK_BRANCH));
  assert.ok(engine !== null);
  assert.equal(engine.code, 'Forbidden');
  assert.match(engine.reason, /not an owner/i);
});

test('N02-AC3: privileged delivery needs the owner, the right action and the same ref', async () => {
  await withRemote(async (remote) => {
    const { broker, deliverer } = brokerOver(remote);

    const unauthorized = await broker.mergeCandidate({
      principal: CONTROLLER,
      repository: REPOSITORY,
      branch: TASK_BRANCH,
      headSha: remote.featureSha,
      authorization: null,
    });
    assert.equal(unauthorized.ok, false, 'a merge with no owner authorization must be refused');
    if (!unauthorized.ok) assert.match(unauthorized.error.reason, /owner authorization/i);

    const wrongRef = await broker.mergeCandidate({
      principal: CONTROLLER,
      repository: REPOSITORY,
      branch: TASK_BRANCH,
      headSha: remote.featureSha,
      authorization: ownerAuthorizationFor('Merge', 'main'),
    });
    assert.equal(wrongRef.ok, false, 'an authorization for another ref must be refused');
    if (!wrongRef.ok) assert.match(wrongRef.error.reason, /names one ref|not transferable/i);

    const wrongAction = await broker.mergeCandidate({
      principal: CONTROLLER,
      repository: REPOSITORY,
      branch: TASK_BRANCH,
      headSha: remote.featureSha,
      authorization: ownerAuthorizationFor('Release', TASK_BRANCH),
    });
    assert.equal(wrongAction.ok, false, 'a release authorization must not authorize a merge');
    if (!wrongAction.ok) assert.match(wrongAction.error.reason, /is not this merge/i);

    assert.equal(deliverer.merges, 0, 'a refused merge reached the privileged port');
    assert.equal(deliverer.releases, 0, 'a refused release reached the privileged port');

    // The owner-authorized path exists, uses the privileged credential and is a different port.
    const authorized = await broker.mergeCandidate({
      principal: { kind: 'Controller', actorId: 'owner-1', actorRole: 'Owner' },
      repository: REPOSITORY,
      branch: TASK_BRANCH,
      headSha: remote.featureSha,
      authorization: ownerAuthorizationFor('Merge', TASK_BRANCH),
    });
    assert.ok(authorized.ok, `the owner's merge was refused: ${authorized.ok ? '' : authorized.error.reason}`);
    assert.equal(authorized.value.action, 'MergeCandidate');
    assert.equal(deliverer.merges, 1);
    assert.deepEqual([...deliverer.credentialScopes], ['PrivilegedDelivery'], 'a merge must use the privileged credential scope');
  });
});

test('F03-AC5: the worker wires a privileged deliverer that refuses both actions, because it holds no privileged credential', async () => {
  const deliverer = refusePrivilegedDelivery('This worker holds no privileged delivery credential.');
  const repository = REPOSITORY;

  const merged = await deliverer.merge({
    repository,
    branch: TASK_BRANCH,
    headSha: BASE_SHA_PLACEHOLDER,
    authorization: ownerAuthorizationFor('Merge', TASK_BRANCH),
    credential: { scope: 'PrivilegedDelivery', secret: 'unused' },
  });
  assert.equal(merged.ok, false);
  if (!merged.ok) {
    assert.equal(merged.error.code, 'Forbidden');
    assert.match(merged.error.reason, /no privileged delivery credential/i);
  }

  const released = await deliverer.release({
    repository,
    environment: 'production',
    ref: 'main',
    authorization: ownerAuthorizationFor('Release', 'main'),
    credential: { scope: 'PrivilegedDelivery', secret: 'unused' },
  });
  assert.equal(released.ok, false);
  if (!released.ok) assert.equal(released.error.code, 'Forbidden');

  // And a broker holding no privileged credential refuses before it reaches that port.
  const publisher = publisherSpy({ branchRef: (): null => null, worktree: '' } as unknown as Remote);
  const broker = createRestrictedBroker({
    featureBranchCredential: { scope: 'FeatureBranchWrite', secret: 'synthetic' },
    privilegedCredential: null,
    publisher: publisher.publisher,
    deliverer: refusePrivilegedDelivery('unreachable'),
    now: (): string => new Date().toISOString(),
  });
  const outcome = await broker.mergeCandidate({
    principal: { kind: 'Controller', actorId: 'owner-1', actorRole: 'Owner' },
    repository,
    branch: TASK_BRANCH,
    headSha: BASE_SHA_PLACEHOLDER,
    authorization: ownerAuthorizationFor('Merge', TASK_BRANCH),
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, 'Unavailable');
    assert.match(outcome.error.reason, /cannot merge/i);
  }
});

test('F03-AC5: publication and privileged delivery are separate paths over separate credential scopes', () => {
  const broker = createRestrictedBroker({
    featureBranchCredential: { scope: 'FeatureBranchWrite', secret: 'synthetic' },
    privilegedCredential: null,
    publisher: publisherSpy({ branchRef: (): null => null, worktree: '' } as unknown as Remote).publisher,
    deliverer: refusePrivilegedDelivery('unreachable'),
    now: (): string => new Date().toISOString(),
  });

  // Three distinct entry points, and the privileged ones are separate calls rather than an argument.
  assert.deepEqual(Object.keys(broker).sort(), ['mergeCandidate', 'publishFeatureBranch', 'releaseDeployment']);
  assert.equal('publishPrivileged' in broker, false);

  // A refusal is decided from the principal alone, with no credential in scope at all.
  const refused = refusePublication({
    principal: ENGINE,
    repository: REPOSITORY,
    branch: REPOSITORY.defaultBranch,
    headSha: BASE_SHA_PLACEHOLDER,
    worktreePath: '/srv/shiploop/attempts/worktrees/ws_broker_probe',
  });
  assert.ok(refused !== null);
  assert.equal(refused.code, 'Forbidden');
  assert.ok(!JSON.stringify(refused).includes('secret'), 'a refusal carried a credential');

  assert.equal(isEnginePrincipal(ENGINE), true);
  assert.equal(isEnginePrincipal(CONTROLLER), false);
  assert.match(describePrincipal(ENGINE), /coding engine as uid 1999/);
  assert.match(describePrincipal(CONTROLLER), /controller worker-a/);
});

test('F03-AC5: an outcome never carries a credential, in either direction', () => {
  const outcome: BrokerOutcome = {
    action: 'MergeCandidate',
    performedBy: { kind: 'Controller', actorId: 'owner-1', actorRole: 'Owner' },
    receipt: { repository: 'synthetic/shiploop', branch: TASK_BRANCH, mergedSha: '0'.repeat(40), mergedAt: '2026-10-01T00:00:00.000Z' },
  };
  const serialised = JSON.stringify(outcome);
  assert.ok(!serialised.includes('secret'), `the outcome carried a credential: ${serialised}`);
  assert.ok(!('credential' in outcome), 'the outcome carries a credential field');
  assert.ok(!('authorization' in outcome), 'the outcome carries the owner authorization');
});

/* -------------------------------------------------------------------------- */
/* Git helpers                                                                 */
/* -------------------------------------------------------------------------- */

function ownerAuthorizationFor(scope: 'Merge' | 'Release', targetRef: string): OwnerAuthorization {
  return { scope, actorId: 'owner-1', targetRef, authorizedAt: '2026-10-01T00:00:00.000Z', justification: 'synthetic authorization for the broker test' };
}

function git(args: readonly string[], cwd: string): string {
  const observed = spawnSync('git', [...args], { cwd, encoding: 'utf8', timeout: 60_000 });
  if (observed.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${String(observed.status)}: ${(observed.stderr ?? '').slice(0, 300)}`);
  }
  return (observed.stdout ?? '').trim();
}

function revParse(cwd: string, ref: string): string {
  return git(['-C', cwd, 'rev-parse', ref], cwd);
}

function refIn(bare: string, ref: string): string | null {
  const observed = spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8', timeout: 30_000 });
  if (observed.status !== 0) return null;
  return (observed.stdout ?? '').trim();
}

/** One real push, bounded and without a shell, so the broker's proof is a Git fact. */
async function pushBranch(bare: string, worktreePath: string, branch: string, headSha: string): Promise<Result<null, DomainError>> {
  const outcome = await new Promise<{ readonly code: number | null; readonly stderr: string }>((resolve) => {
    const child = spawn('git', ['-C', worktreePath, 'push', bare, `${headSha}:refs/heads/${branch}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => resolve({ code: null, stderr: 'git could not be started' }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
  if (outcome.code !== 0) {
    return err({ code: 'Unavailable', reason: `git push exited ${String(outcome.code)}: ${outcome.stderr.trim().slice(0, 200)}` });
  }
  return ok(null);
}

async function writeFile(path: string, contents: string): Promise<void> {
  const { writeFile: write } = await import('node:fs/promises');
  await write(path, contents, 'utf8');
}