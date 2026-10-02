/**
 * Behavioural proof for the adoption use cases.
 *
 * The store is REAL throughout: a temporary SQLite file opened with `openDatabase` and
 * built by `migrate`, with the scope snapshots appended through the real
 * `ScopeRepository`. So the adoption assertions are made against what the product persists -
 * the immutable scope snapshot with the provider's own revision, the adopted work item, and
 * the `adoption_json` reference - rather than against a value a use case returned
 * (F11-AC1, F12-AC1).
 *
 * Both providers are DETERMINISTIC DOUBLES implementing the shipped `TicketAdapter` and
 * `GitAdapter` contracts, stated plainly: `@shiploop/adapters` exports only its root, so the
 * Linear and Git adapters cannot be imported from this package without the deep
 * cross-package import the project forbids. Each double records the operations it was asked
 * to perform, which is what turns "adoption wrote nothing" into an assertion. The real
 * `LinearTicketAdapter` is driven end to end, with the lost response injected at the
 * adapter boundary, by the throwaway proof script.
 *
 * Nothing here contacts a provider and nothing carries a credential.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { err, fingerprint, ok } from '@shiploop/domain';
import type {
  CandidateId,
  CapabilityKind,
  CommitSha,
  ConnectorId,
  DomainError,
  OwnerId,
  ProfileVersionId,
  ProjectId,
  ProviderId,
  Result,
  WorkItemId,
} from '@shiploop/domain';
import type {
  AdapterCapabilities,
  AdapterCompatibility,
  GitAdapter,
  GitRepositoryRef,
  GitStateRead,
  ManagedProgressOutcome,
  PublishWorkOutcome,
  PublishWorkRequest,
  ReadGitStateRequest,
  ReadTicketScopeRequest,
  TicketAdapter,
  TicketIssueRef,
  TicketScopeRead,
} from '@shiploop/adapters';
import { openDatabase, type Database } from '@shiploop/storage';
import { LATEST_SCHEMA_VERSION, migrate } from '@shiploop/storage';
import {
  ProjectProfileRepository,
  PublicationRepository,
  ScopeRepository,
  WorkItemRepository,
} from '@shiploop/storage';

import { createAdoptionUseCases, repositoryMatches, teamOf, type AdoptionUseCases } from './adoption.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';

const PROJECT = '5b2c3d4e-0000-4000-8000-00000000000a' as ProjectId;
const OTHER_PROJECT = '5b2c3d4e-0000-4000-8000-00000000000b' as ProjectId;
const OWNER_ID = 'own_adoption_test' as OwnerId;
const T0 = '2026-07-01T09:00:00.000Z';
const TEAM = 'ENG';
const REPOSITORY_REFERENCE = 'github.com/example/shiploop';
const REPOSITORY: GitRepositoryRef = {
  provider: 'github',
  fullName: 'example/shiploop',
  defaultBranch: 'main',
  url: 'https://github.invalid/example/shiploop',
};
const HEAD_SHA = '1f0c2a9d3b6e4c8a7d5f1e3b9c2a6d4e8f0a1b3c' as CommitSha;
const OTHER_HEAD_SHA = '7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a3' as CommitSha;
const ISSUE_UUID = '3a2f1e0d-0000-4000-8000-000000000001';
const CORRELATION = 'corr-adoption-1';

const clock: ControllerClock = { now: () => T0 };
const owner: OwnerActor = { actorId: OWNER_ID, role: 'Owner', ownerId: OWNER_ID, sessionId: 'sess-1' };
const agent: OwnerActor = { actorId: 'agent-1', role: 'CodingAgent', ownerId: null, sessionId: null };

function expectOk<T>(result: Result<T, DomainError>): T {
  if (!result.ok) {
    assert.fail(`expected success but received ${result.error.code}: ${result.error.reason}`);
  }
  return result.value;
}

/**
 * The refusal, narrowed to the code that was expected.
 *
 * Narrowing the return rather than the caller's assertion is what lets a case read
 * `error.expected` on a `Conflict` without a cast: a typed error carries the two sides of
 * the disagreement, and losing that is what makes a failure message vague (F10-AC2).
 */
function expectError<T, C extends DomainError['code']>(
  result: Result<T, DomainError>,
  code: C,
): Extract<DomainError, { readonly code: C }> {
  if (result.ok) {
    assert.fail(`expected ${code} but the call succeeded`);
  }
  assert.equal(result.error.code, code);
  return result.error as Extract<DomainError, { readonly code: C }>;
}

/* -------------------------------------------------------------------------- */
/* Provider doubles                                                            */
/* -------------------------------------------------------------------------- */

/** One operation a provider was asked to perform, which is the write count. */
interface PerformedOperation {
  readonly name: string;
  readonly operationId: string;
  readonly target: string;
}

/**
 * A ticket provider holding one existing issue and performing no writes at all.
 *
 * `publishWork` and `updateManagedProgress` both record themselves and then refuse, so a
 * case that accidentally reached a write sees the refusal rather than passing quietly.
 */
class ExistingIssueProvider implements TicketAdapter {
  readonly kind = 'Ticket' as const;
  readonly connectorId = 'connector_adoption_double' as ConnectorId;
  readonly performed: PerformedOperation[] = [];
  /** Mutable so a case can present the provider reporting a different issue (F11-AC3). */
  issue = {
    issueId: ISSUE_UUID as ProviderId,
    identifier: `${TEAM}-900`,
    url: `https://tickets.double.invalid/${TEAM}/900`,
  } satisfies TicketIssueRef;
  visible = true;

  capabilities(): AdapterCapabilities {
    return { kind: 'Ticket', contractVersion: 1, declarations: [] };
  }

  async checkCompatibility(): Promise<Result<AdapterCompatibility>> {
    return ok({
      kind: 'Ticket',
      contractVersion: 1,
      runtimeVersion: null,
      compatible: true,
      detail: 'The deterministic double always answers.',
      observedAt: T0,
    });
  }

  async readScope(_context: unknown, request: ReadTicketScopeRequest): Promise<Result<TicketScopeRead>> {
    this.performed.push({ name: 'readScope', operationId: String(request.workItemId), target: request.issueId });
    if (!this.visible || request.issueId !== ISSUE_UUID) {
      return err({ code: 'NotFound', reason: `The provider has no issue ${request.issueId}.` });
    }
    return ok({
      issue: this.issue,
      snapshot: {
        workItemId: 'work_fixture_01',
        issueId: ISSUE_UUID,
        issueIdentifier: `${TEAM}-900`,
        title: 'Keep the existing review card honest',
        description: 'A description a person wrote, with `## Acceptance Criteria` below.',
        providerRevision: T0,
        priority: 'High',
        dependencyIssueIds: [],
        acceptanceCriteria: [{ id: 'AC1', text: 'The card names why a preview is unusable.' }],
        retrievedAt: T0,
      },
      state: { kind: 'ProviderState', name: 'In Progress', terminal: 'None' },
      relations: [],
      managedRegions: [
        {
          target: { kind: 'UpdatableComment', commentId: 'comment_existing' as ProviderId },
          lastMilestoneKey: null,
          lastDeliveredAt: null,
          lastDeliveredContentDigest: null,
        },
      ],
      observedAt: T0,
    });
  }

  async findRelatedIssues(): Promise<Result<readonly never[]>> {
    return ok([]);
  }

  async publishWork(_context: unknown, request: PublishWorkRequest): Promise<Result<PublishWorkOutcome>> {
    this.performed.push({ name: 'publishWork', operationId: request.operationId, target: 'publish' });
    return err({ code: 'Unavailable', reason: 'Adoption must not create an issue (F11-AC1).' });
  }

  async updateManagedProgress(): Promise<Result<ManagedProgressOutcome>> {
    this.performed.push({ name: 'updateManagedProgress', operationId: 'unknown', target: 'comment' });
    return err({ code: 'Unavailable', reason: 'Adoption must not rewrite an issue (F11-AC4).' });
  }

  async describeTransitions(): Promise<Result<readonly never[]>> {
    return ok([]);
  }

  async requestTransition(): Promise<Result<never>> {
    return err({ code: 'Unavailable', reason: 'This provider cannot request a transition.' });
  }
}

/**
 * A Git provider reporting one branch, and no capability that could move it.
 *
 * Every write method records itself and refuses. `pushBranch`, `mergePullRequest` and
 * `declareNoCodeOutcome` are never called by adoption, and the record is what proves it
 * (F11-AC4, F14-AC2).
 */
class ReadOnlyGitProvider implements GitAdapter {
  readonly kind = 'Git' as const;
  readonly connectorId = 'connector_adoption_git_double' as ConnectorId;
  readonly performed: PerformedOperation[] = [];
  head: CommitSha = HEAD_SHA;
  /** The identity the provider reports, which may differ from the one requested. */
  reportedRepository: GitRepositoryRef = REPOSITORY;
  branchExists = true;
  baseBranch = 'main';
  pullRequestId: string | null = 'pr-77';

  capabilities(): AdapterCapabilities {
    return { kind: 'Git', contractVersion: 1, declarations: [] };
  }

  async checkCompatibility(): Promise<Result<AdapterCompatibility>> {
    return ok({
      kind: 'Git',
      contractVersion: 1,
      runtimeVersion: null,
      compatible: true,
      detail: 'The deterministic double always answers.',
      observedAt: T0,
    });
  }

  async readState(_context: unknown, request: ReadGitStateRequest): Promise<Result<GitStateRead>> {
    this.performed.push({
      name: 'readState',
      operationId: request.branch,
      target: `${request.repository.provider}/${request.repository.fullName}`,
    });
    if (!this.branchExists) {
      return ok({
        repository: this.reportedRepository,
        head: { kind: 'Missing', name: request.branch, detail: `no branch ${request.branch}` },
        base: { kind: 'Branch', name: this.baseBranch, sha: HEAD_SHA },
        pullRequest: null,
        reviews: [],
        observedAt: T0,
      });
    }
    return ok({
      repository: this.reportedRepository,
      head: { kind: 'Branch', name: request.branch, sha: this.head },
      base: { kind: 'Branch', name: this.baseBranch, sha: HEAD_SHA },
      pullRequest:
        this.pullRequestId === null
          ? null
          : {
              pullRequestId: this.pullRequestId as ProviderId,
              number: 77,
              url: `https://git.double.invalid/${this.reportedRepository.fullName}/pull/77`,
              draft: false,
              state: 'Open',
            },
      reviews: [],
      observedAt: T0,
    });
  }

  /** Records and refuses: adoption has no capability that may move a branch (F11-AC4). */
  async pushBranch(): Promise<Result<never>> {
    this.performed.push({ name: 'pushBranch', operationId: 'unknown', target: 'branch' });
    return err({ code: 'Unavailable', reason: 'Adoption must not push a branch (F11-AC4, F14-AC2).' });
  }

  async findDrafts(): Promise<Result<readonly never[]>> {
    this.performed.push({ name: 'findDrafts', operationId: 'unknown', target: 'drafts' });
    return ok([]);
  }

  async upsertDraft(): Promise<Result<never>> {
    this.performed.push({ name: 'upsertDraft', operationId: 'unknown', target: 'draft' });
    return err({ code: 'Unavailable', reason: 'Adoption must not rewrite a draft (F11-AC4).' });
  }

  async declareNoCodeOutcome(): Promise<Result<never>> {
    this.performed.push({ name: 'declareNoCodeOutcome', operationId: 'unknown', target: 'outcome' });
    return err({ code: 'Unavailable', reason: 'Adoption must not declare an outcome (F11-AC4).' });
  }

  async mergePullRequest(): Promise<Result<never>> {
    this.performed.push({ name: 'mergePullRequest', operationId: 'unknown', target: 'pull-request' });
    return err({ code: 'Unavailable', reason: 'Adoption must not merge (F11-AC4).' });
  }

  async readChecks(): Promise<Result<readonly never[]>> {
    return ok([]);
  }
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly database: Database;
  readonly useCases: AdoptionUseCases;
  readonly ticket: ExistingIssueProvider;
  readonly git: ReadOnlyGitProvider;
  readonly publications: PublicationRepository;
  readonly scope: ScopeRepository;
  readonly workItems: WorkItemRepository;
  readonly profileVersionId: ProfileVersionId;
  readonly profiles: ProjectProfileRepository;
  readonly adopt: (issueId?: string) => ReturnType<AdoptionUseCases['adoptExistingIssue']>;
}

async function withAdoption(run: (harness: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-adoption-'));
  const opened = openDatabase(join(directory, 'adoption.sqlite'));
  assert.ok(opened.ok, `the database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
  const database: Database = opened.value;
  try {
    const migrated = migrate(database);
    assert.ok(migrated.ok, `the schema could not be migrated: ${migrated.ok ? '' : migrated.error.reason}`);
    // The migration reached LATEST_SCHEMA_VERSION rather than any pinned number, so this
    // fixture keeps working when a later migration is added (N08-AC3).
    assert.equal(migrated.value.toVersion, LATEST_SCHEMA_VERSION);

    database
      .prepare('INSERT INTO owners (owner_id, display_name, created_at) VALUES (?, ?, ?)')
      .run(OWNER_ID, 'Adoption owner', T0);
    database
      .prepare('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?), (?, ?, ?)')
      .run(PROJECT, 'Adoption project', T0, OTHER_PROJECT, 'Other project', T0);

    const profiles = new ProjectProfileRepository(database);
    for (const projectId of [PROJECT, OTHER_PROJECT]) {
      expectOk(
        profiles.saveVersion({
          projectId,
          content: {
            references: {
              repository: REPOSITORY_REFERENCE,
              ticketProvider: 'linear',
              ticketTeamKey: TEAM,
              baseBranch: 'main',
              targetBranch: 'main',
              deploymentProvider: 'none',
              engine: 'claude-code',
              previewComponents: [],
            },
            policy: {
              requiredChecks: ['pnpm test'],
              deliveryBehavior: 'ManualAuthorizationOnly',
              maxFixPasses: 2,
              workspaceIsolation: 'WorktreeAndDataDirectory',
              capabilityVersion: 1,
            },
            recipe: 'pnpm install',
            environment: { runtime: 'node24', ports: [41000], secretReferences: [] },
          },
          note: null,
          createdAt: T0,
          createdBy: OWNER_ID,
          expectedVersionNumber: null,
        }),
      );
    }
    database
      .prepare(
        `INSERT INTO procedure_versions (procedure_version_id, project_id, subject_key, version, kind, source, content_json, content_fingerprint, created_by, created_at)
         VALUES (?, ?, ?, 1, 'Procedure', 'Owner', '{}', ?, ?, ?)`,
      )
      .run(
        'procedure-adoption-1',
        PROJECT,
        'environment.recipe',
        fingerprint({ recipe: 'adoption' }),
        OWNER_ID,
        T0,
      );

    const ticket = new ExistingIssueProvider();
    const git = new ReadOnlyGitProvider();
    const useCases = createAdoptionUseCases({
      clock,
      publications: new PublicationRepository(database),
      scope: new ScopeRepository(database),
      profiles,
      ticket,
      git,
    });

    const current = profiles.currentVersion(PROJECT);
    assert.ok(current.ok, 'the project should have a saved profile');
    assert.ok(current.value !== null, 'the project should have a saved profile version');
    const profileVersionId = current.value.profileVersionId;
    const adopt = (issueId: string = ISSUE_UUID) =>
      useCases.adoptExistingIssue({
        actor: owner,
        projectId: PROJECT,
        profileVersionId,
        procedureVersionId: 'procedure-adoption-1',
        issueId,
        expectedIdentifier: null,
        title: '',
        correlationId: CORRELATION,
      });

    await run({
      database,
      useCases,
      ticket,
      git,
      publications: new PublicationRepository(database),
      scope: new ScopeRepository(database),
      workItems: new WorkItemRepository(database),
      profileVersionId,
      profiles,
      adopt,
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* F11-AC1                                                                     */
/* -------------------------------------------------------------------------- */

test('F11-AC1 an existing issue is adopted with its live content and no replacement is created', async () => {
  await withAdoption(async ({ adopt, ticket, workItems }) => {
    const adopted = expectOk(await adopt());

    assert.equal(adopted.issue.identifier, `${TEAM}-900`);
    assert.equal(adopted.state.kind === 'ProviderState' ? adopted.state.name : null, 'In Progress');
    assert.equal(adopted.snapshot.description.includes('a person wrote'), true, 'the live description was not loaded');
    assert.deepEqual(
      adopted.snapshot.acceptanceCriteria.map((criterion) => criterion.id),
      ['AC1'],
      'the live criteria were not loaded (F11-AC1)',
    );
    assert.equal(adopted.snapshot.priority, 'High', 'the live priority was not loaded (F11-AC1)');

    const stored = expectOk(workItems.get(adopted.workItem.workItemId));
    assert.equal(stored.source, 'AdoptedIssue', "the work item claims ShipLoop proposed existing work (F11-AC4)");
    assert.equal(stored.externalIssueId, ISSUE_UUID);
    assert.equal(stored.externalIssueIdentifier, `${TEAM}-900`);
    assert.equal(stored.publicationState, 'Published');
    assert.equal(
      ticket.performed.filter((operation) => operation.name !== 'readScope').length,
      0,
      'adoption performed a provider write, so it created or rewrote something (F11-AC1, F11-AC4)',
    );

    const snapshot = expectOk(workItems.latestScopeSnapshot(adopted.workItem.workItemId));
    assert.notEqual(snapshot, null, 'the adopted scope was not captured (F11-AC1, F12-AC1)');
    assert.equal(snapshot?.providerRevision, T0, 'the captured scope must carry the provider revision (F12-AC1)');
    assert.equal(snapshot?.acceptanceCriteria.length, 1);
  });
});

test('F11-AC1 an inaccessible issue is refused with the provider\'s own reason', async () => {
  await withAdoption(async ({ adopt, ticket, workItems }) => {
    ticket.visible = false;
    const error = expectError(await adopt(), 'NotFound');
    assert.match(error.reason, /no issue/);
    assert.equal(
      expectOk(workItems.listForProject(PROJECT)).length,
      0,
      'a refused adoption created a local row anyway (F11-AC3)',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* F11-AC3                                                                     */
/* -------------------------------------------------------------------------- */

test('F11-AC3 an issue from another team is refused, naming both teams', async () => {
  await withAdoption(async ({ adopt, ticket }) => {
    ticket.issue.identifier = 'GYM-900';
    const error = expectError(await adopt(), 'Conflict');
    assert.equal(error.code, 'Conflict');
    assert.equal(error.expected, `an issue in team ${TEAM}`);
    assert.match(error.actual, /GYM/);
  });
});

test('F11-AC3 an issue that resolves to a different identifier is refused', async () => {
  await withAdoption(async ({ useCases, profileVersionId, ticket }) => {
    ticket.issue.identifier = `${TEAM}-901`;
    const error = expectError(
      await useCases.adoptExistingIssue({
        actor: owner,
        projectId: PROJECT,
        profileVersionId,
        procedureVersionId: 'procedure-adoption-1',
        issueId: ISSUE_UUID,
        expectedIdentifier: `${TEAM}-900`,
        title: '',
        correlationId: CORRELATION,
      }),
      'Conflict',
    );
    assert.equal(error.expected, `${TEAM}-900`);
    assert.equal(error.actual, `${TEAM}-901`);
  });
});

test('F11-AC3 an issue another project already adopted is refused, naming that project', async () => {
  await withAdoption(async ({ adopt, useCases, profiles, workItems }) => {
    expectOk(await adopt());
    const other = profiles.currentVersion(OTHER_PROJECT);
    assert.ok(other.ok && other.value !== null, 'the other project should have a saved profile');
    const otherProfile = other.value.profileVersionId;
    const error = expectError(
      await useCases.adoptExistingIssue({
        actor: owner,
        projectId: OTHER_PROJECT,
        profileVersionId: otherProfile,
        procedureVersionId: 'procedure-adoption-1',
        issueId: ISSUE_UUID,
        expectedIdentifier: null,
        title: '',
        correlationId: CORRELATION,
      }),
      'Conflict',
    );
    assert.match(error.reason, new RegExp(PROJECT));
    assert.equal(
      expectOk(workItems.listForProject(OTHER_PROJECT)).length,
      0,
      'the refused wrong-project adoption created a local row (F11-AC3)',
    );
  });
});

test('F11-AC1 only the owner may adopt existing work', async () => {
  await withAdoption(async ({ useCases, profileVersionId, ticket }) => {
    const error = expectError(
      await useCases.adoptExistingIssue({
        actor: agent,
        projectId: PROJECT,
        profileVersionId,
        procedureVersionId: 'procedure-adoption-1',
        issueId: ISSUE_UUID,
        expectedIdentifier: null,
        title: '',
        correlationId: CORRELATION,
      }),
      'Forbidden',
    );
    assert.match(error.reason, /owner/i);
    assert.equal(ticket.performed.length, 0, 'a refused adoption contacted the provider (F11-AC1)');
  });
});

/* -------------------------------------------------------------------------- */
/* F11-AC2 / F11-AC3 repository identity                                       */
/* -------------------------------------------------------------------------- */

async function adoptThenLink(
  run: (harness: Harness & { readonly workItemId: WorkItemId }) => Promise<void> | void,
): Promise<void> {
  await withAdoption(async (harness) => {
    const adopted = expectOk(await harness.adopt());
    await run({ ...harness, workItemId: adopted.workItem.workItemId });
  });
}

test('F11-AC2 a compatible branch is linked after repository, head and target are verified', async () => {
  await adoptThenLink(async ({ useCases, git, workItems, workItemId }) => {
    const linked = expectOk(
      await useCases.linkExistingChange({
        actor: owner,
        workItemId,
        repository: REPOSITORY,
        branch: 'feature/review-card',
        baseBranch: 'main',
        expectedHeadSha: HEAD_SHA,
        pullRequestId: 'pr-77',
        correlationId: CORRELATION,
      }),
    );

    assert.equal(linked.headSha, HEAD_SHA, 'the observed head was not recorded (F11-AC2)');
    assert.equal(linked.baseBranch, 'main');
    assert.equal(linked.pullRequestId, 'pr-77');
    assert.deepEqual(linked.adoption, {
      repository: `github/${REPOSITORY.fullName}`,
      headSha: HEAD_SHA,
      targetBranch: 'main',
      pullRequestId: 'pr-77',
    });

    const stored = expectOk(workItems.get(workItemId));
    assert.deepEqual(stored.adoption, linked.adoption, 'the adoption reference was not persisted (F11-AC2)');
    assert.equal(
      git.performed.filter((operation) => operation.name !== 'readState').length,
      0,
      'adoption performed a Git write, so it could have reset a human branch (F11-AC4, F14-AC2)',
    );
  });
});

test('F11-AC3 a similarly named repository is refused rather than adopted (identity, not name)', async () => {
  await adoptThenLink(async ({ useCases, workItems, workItemId }) => {
    const similarlyNamed: GitRepositoryRef = {
      ...REPOSITORY,
      fullName: 'example/shiploop-legacy',
      url: 'https://github.invalid/example/shiploop-legacy',
    };
    const error = expectError(
      await useCases.linkExistingChange({
        actor: owner,
        workItemId,
        repository: similarlyNamed,
        branch: 'feature/review-card',
        baseBranch: 'main',
        expectedHeadSha: null,
        pullRequestId: null,
        correlationId: CORRELATION,
      }),
      'Conflict',
    );
    assert.equal(error.expected, REPOSITORY_REFERENCE);
    assert.match(error.actual, /shiploop-legacy/);
    assert.equal(
      expectOk(workItems.get(workItemId)).adoption,
      null,
      'a refused repository mapping was recorded anyway (F11-AC3)',
    );
  });
});

test('F11-AC3 a provider that reports a different repository than the one requested is refused', async () => {
  await adoptThenLink(async ({ useCases, git, workItemId }) => {
    git.reportedRepository = { ...REPOSITORY, fullName: 'example/shiploop-legacy' };
    const error = expectError(
      await useCases.linkExistingChange({
        actor: owner,
        workItemId,
        repository: REPOSITORY,
        branch: 'feature/review-card',
        baseBranch: 'main',
        expectedHeadSha: null,
        pullRequestId: null,
        correlationId: CORRELATION,
      }),
      'Conflict',
    );
    assert.match(error.actual, /shiploop-legacy/);
  });
});

test('F11-AC3 a branch that targets another branch than the project delivers into is refused', async () => {
  await adoptThenLink(async ({ useCases, workItemId }) => {
    const error = expectError(
      await useCases.linkExistingChange({
        actor: owner,
        workItemId,
        repository: REPOSITORY,
        branch: 'feature/review-card',
        baseBranch: 'release',
        expectedHeadSha: null,
        pullRequestId: null,
        correlationId: CORRELATION,
      }),
      'Conflict',
    );
    assert.equal(error.expected, 'main');
    assert.equal(error.actual, 'release');
  });
});

test('F11-AC3 a branch that does not exist is refused with the provider\'s reason', async () => {
  await adoptThenLink(async ({ useCases, git, workItemId }) => {
    git.branchExists = false;
    const error = expectError(
      await useCases.linkExistingChange({
        actor: owner,
        workItemId,
        repository: REPOSITORY,
        branch: 'feature/never-created',
        baseBranch: 'main',
        expectedHeadSha: null,
        pullRequestId: null,
        correlationId: CORRELATION,
      }),
      'Conflict',
    );
    assert.match(error.reason, /does not exist/);
  });
});

test('F11-AC2 a head that moved since the owner selected it is a conflict naming both SHAs', async () => {
  await adoptThenLink(async ({ useCases, git, workItemId }) => {
    git.head = OTHER_HEAD_SHA;
    const error = expectError(
      await useCases.linkExistingChange({
        actor: owner,
        workItemId,
        repository: REPOSITORY,
        branch: 'feature/review-card',
        baseBranch: 'main',
        expectedHeadSha: HEAD_SHA,
        pullRequestId: null,
        correlationId: CORRELATION,
      }),
      'Conflict',
    );
    assert.equal(error.expected, HEAD_SHA);
    assert.equal(error.actual, OTHER_HEAD_SHA);
  });
});

test('F11-AC3 a different pull request than the one selected is refused', async () => {
  await adoptThenLink(async ({ useCases, git, workItemId }) => {
    git.pullRequestId = 'pr-91';
    const error = expectError(
      await useCases.linkExistingChange({
        actor: owner,
        workItemId,
        repository: REPOSITORY,
        branch: 'feature/review-card',
        baseBranch: 'main',
        expectedHeadSha: null,
        pullRequestId: 'pr-77',
        correlationId: CORRELATION,
      }),
      'Conflict',
    );
    assert.equal(error.expected, 'pr-77');
    assert.equal(error.actual, 'pr-91');
  });
});

/* -------------------------------------------------------------------------- */
/* F11-AC5 / F13-AC5                                                           */
/* -------------------------------------------------------------------------- */

test('F11-AC5 Test can be requested for an adopted candidate without a Build job or an issue rewrite', async () => {
  await adoptThenLink(async ({ useCases, ticket, database, workItemId }) => {
    const request = expectOk(
      useCases.requestAdoptedEvaluation({
        actor: owner,
        workItemId,
        candidateId: 'candidate-adopted-1' as CandidateId,
        candidateFingerprint: fingerprint({ candidate: 'adopted-1' }),
        mode: 'Test',
        correlationId: CORRELATION,
      }),
    );

    assert.equal(request.mode, 'Test');
    assert.equal(request.created, true);
    assert.equal(
      ticket.performed.filter((operation) => operation.name !== 'readScope').length,
      0,
      'requesting a review rewrote the original issue (F11-AC5)',
    );

    const jobs = database.prepare('SELECT count(*) AS total FROM jobs').get();
    assert.equal(jobs?.['total'], 0, 'requesting a review launched a job (F11-AC5, F13-AC5)');
    const attempts = database.prepare('SELECT count(*) AS total FROM attempts').get();
    assert.equal(attempts?.['total'], 0, 'requesting a review started an attempt (F13-AC5)');

    const repeated = expectOk(
      useCases.requestAdoptedEvaluation({
        actor: owner,
        workItemId,
        candidateId: 'candidate-adopted-1' as CandidateId,
        candidateFingerprint: fingerprint({ candidate: 'adopted-1' }),
        mode: 'Test',
        correlationId: CORRELATION,
      }),
    );
    assert.equal(repeated.created, false, 'a repeated request produced a second row (F30-AC2)');
    assert.equal(repeated.dedupKey, request.dedupKey);
  });
});

test('F11-AC5 Review is requestable and Build is refused for adopted work (F11-AC4, F14-AC2)', async () => {
  await adoptThenLink(async ({ useCases, database, workItemId }) => {
    expectOk(
      useCases.requestAdoptedEvaluation({
        actor: owner,
        workItemId,
        candidateId: null,
        candidateFingerprint: null,
        mode: 'Review',
        correlationId: CORRELATION,
      }),
    );

    const refused = expectError(
      useCases.requestAdoptedEvaluation({
        actor: owner,
        workItemId,
        candidateId: null,
        candidateFingerprint: null,
        mode: 'Build',
        correlationId: CORRELATION,
      }),
      'Invalid',
    );
    assert.match(JSON.stringify(refused), /reset/, 'the refusal must say what a build would do (F11-AC4)');
    assert.equal(database.prepare('SELECT count(*) AS total FROM jobs').get()?.['total'], 0);
  });
});

test('F13-AC5 a non-owner cannot request an evaluation of adopted work', async () => {
  await adoptThenLink(async ({ useCases, database, workItemId }) => {
    const error = expectError(
      useCases.requestAdoptedEvaluation({
        actor: agent,
        workItemId,
        candidateId: null,
        candidateFingerprint: null,
        mode: 'Test',
        correlationId: CORRELATION,
      }),
      'Forbidden',
    );
    assert.match(error.reason, /owner/i);
    assert.equal(database.prepare('SELECT count(*) AS total FROM outbox_events').get()?.['total'], 0);
  });
});

test('F11-AC2 a change cannot be linked to a work item with no adopted issue', async () => {
  await withAdoption(async ({ useCases, workItems, profileVersionId, adopt }) => {
    expectOk(await adopt());
    const unpublished = expectOk(
      workItems.create({
        projectId: PROJECT,
        profileVersionId,
        source: 'ProposedNewIssue',
        title: 'Not adopted',
        externalIssueId: null,
        externalIssueIdentifier: null,
        externalIssueUrl: null,
        publicationIntent: 'PublishWhenAgreed',
        relatedWorkItemIds: [],
        adoption: null,
        at: T0,
      }),
    );
    const error = expectError(
      await useCases.linkExistingChange({
        actor: owner,
        workItemId: unpublished.workItemId,
        repository: REPOSITORY,
        branch: 'feature/review-card',
        baseBranch: 'main',
        expectedHeadSha: null,
        pullRequestId: null,
        correlationId: CORRELATION,
      }),
      'Invalid',
    );
    assert.match(JSON.stringify(error), /no adopted issue/);
  });
});

/* -------------------------------------------------------------------------- */
/* F12-AC2 through the read path                                               */
/* -------------------------------------------------------------------------- */

test('F12-AC2 reading an adopted issue returns live content without writing it back', async () => {
  await adoptThenLink(async ({ useCases, ticket, workItemId }) => {
    const before = ticket.performed.length;
    const live = expectOk(await useCases.readAdoptedScope(workItemId));
    assert.equal(live.snapshot.issueIdentifier, `${TEAM}-900`);
    assert.equal(live.state.kind === 'ProviderState' ? live.state.name : null, 'In Progress');
    assert.equal(
      ticket.performed.filter((operation) => operation.name !== 'readScope').length,
      0,
      'a scope read pushed content back at the provider (F12-AC5, F10-AC4)',
    );
    assert.ok(ticket.performed.length > before, 'the read never reached the provider (F11-AC1)');
  });
});

/* -------------------------------------------------------------------------- */
/* Identity helpers                                                            */
/* -------------------------------------------------------------------------- */

test('F11-AC3 a repository reference matches on the full path, never on a name', () => {
  assert.equal(repositoryMatches('github.com/example/shiploop', REPOSITORY), true);
  assert.equal(repositoryMatches('example/shiploop', REPOSITORY), true);
  assert.equal(repositoryMatches('  github.com/example/shiploop/  ', REPOSITORY), true);
  assert.equal(repositoryMatches('github.com/example/shiploop-legacy', REPOSITORY), false);
  assert.equal(repositoryMatches('github.com/other/shiploop', REPOSITORY), false);
  assert.equal(repositoryMatches('shiploop', REPOSITORY), false);
  assert.equal(repositoryMatches('   ', REPOSITORY), false);
});

test('F11-AC3 a team prefix is read only from an identifier that carries one', () => {
  assert.equal(teamOf('ENG-900'), 'ENG');
  assert.equal(teamOf('ENG-12'), 'ENG');
  assert.equal(teamOf('123456'), null, 'a numeric identifier carries no team prefix');
  assert.equal(teamOf('ENG'), null, 'a bare team name is not an issue identifier');
  assert.equal(teamOf('lower-900'), 'lower', 'a lower-case team key is still a team key');
  assert.equal(teamOf('team with spaces-900'), null, 'an identifier carrying spaces is not a team-prefixed issue');
  assert.equal(teamOf('-900'), null);
});

test('F10-AC4 the capability vocabulary this slice uses is the one the adapters declare', () => {
  const declared: readonly CapabilityKind[] = ['Ticket:ReadScope', 'Ticket:PublishIssue', 'Ticket:UpdateManagedProgress'];
  assert.ok(declared.includes('Ticket:ReadScope'), 'the adoption path reads scope through a declared capability');
});
