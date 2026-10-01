/**
 * Behavioural proof for the publication and managed-progress use cases.
 *
 * The store is REAL throughout: a temporary SQLite file opened with `openDatabase` and
 * built by `migrate`, driven through `PublicationRepository` and the shipped operation,
 * outbox and reconciliation stores inside it. So every assertion about the ledger, the
 * work-item row, the pending-sync label and the reconciliation worklist is made against
 * what the product actually persists (N01-AC3, F30-AC5).
 *
 * The ticket provider is a DETERMINISTIC DOUBLE, stated plainly: it implements the shipped
 * `TicketAdapter` contract from `@shiploop/adapters` and records every operation it is
 * asked to perform, which is what turns "a repeat created no second issue" into an
 * assertion rather than a claim. The REAL `LinearTicketAdapter` cannot be imported from
 * this package - `@shiploop/adapters` exports only its root, and reaching the Linear
 * subpath from here would be the deep cross-package import the project forbids - so the
 * real adapter is driven end to end by the throwaway proof script that also injects the
 * lost response. Nothing here contacts a Linear workspace and nothing carries a credential.
 *
 * The plan side is real too: the published revision is projected from a plan the domain
 * itself drafted and the domain's own acceptance edit accepted, then through
 * `revisionFor`. A test cannot accidentally publish something the owner never accepted
 * (F08-AC3, F10-AC1).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { err, ok } from '@shiploop/domain';
import type {
  CapabilityKind,
  ConnectorId,
  DomainError,
  OwnerId,
  Plan,
  ProfileVersionId,
  ProjectId,
  ProviderId,
  PublishableTicket,
  Result,
  WorkItemId,
} from '@shiploop/domain';
import type {
  AdapterCapabilities,
  AdapterCompatibility,
  ManagedProgressOutcome,
  ManagedProgressUpdateRequest,
  PublishWorkOutcome,
  PublishWorkRequest,
  TicketAdapter,
  TicketScopeRead,
} from '@shiploop/adapters';
import { openDatabase, type Database } from '@shiploop/storage';
import { LATEST_SCHEMA_VERSION, migrate } from '@shiploop/storage';
import { ProjectProfileRepository, PublicationRepository, WorkItemRepository } from '@shiploop/storage';

import {
  createPublicationUseCases,
  failureCategoryFor,
  managedDeliveryOperationId,
  publicationOperationId,
  receiptPublicationOperationId,
  revisionFor,
  type PublicationReport,
  type PublicationUseCases,
} from './publication.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';

const PROJECT = '7c1d2e3f-0000-4000-8000-00000000000a' as ProjectId;
const OWNER_ID = 'own_publication_test' as OwnerId;
const T0 = '2026-06-01T09:00:00.000Z';
const T1 = '2026-06-01T09:10:00.000Z';
const TEAM = 'ENG';
const CORRELATION = 'corr-publication-1';

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
/* The deterministic ticket provider                                           */
/* -------------------------------------------------------------------------- */

const TICKET_CAPABILITIES: readonly CapabilityKind[] = [
  'Ticket:ReadScope',
  'Ticket:PublishIssue',
  'Ticket:UpdateManagedProgress',
];

/** One operation the provider was actually asked to perform. */
interface PerformedOperation {
  readonly name: 'readScope' | 'publishWork' | 'updateManagedProgress';
  readonly operationId: string;
  readonly target: string;
  /** The provider identity the write addressed, so two writes can be told apart. */
  readonly derivedIssueId: string;
}

/**
 * A ticket provider that behaves the way the contract describes and remembers everything.
 *
 * The derived issue identity is a pure function of the operation identity, mirroring what
 * the real adapter does and why: two attempts at one publication must address one issue.
 * `loseNextPublishResponse` performs the write and then reports `OutcomeUnknown`, which is
 * precisely what a dropped connection after the provider accepted a write looks like from
 * the caller's side (F30-AC5, N01-AC2).
 */
class RecordingTicketProvider implements TicketAdapter {
  readonly kind = 'Ticket' as const;
  readonly connectorId = 'connector_publication_double' as ConnectorId;
  readonly performed: PerformedOperation[] = [];
  readonly comments: { readonly commentId: string; readonly body: string; readonly milestoneKey: string }[] = [];
  private readonly issues = new Map<string, TicketScopeRead>();
  private readonly dispositions = new Map<string, 'CreatedNew' | 'AlreadyPresent'>();
  private sequence = 0;
  private loseNextPublish = false;
  private publishRefusal: DomainError | null = null;
  private publishRefusalAfter = 0;
  private createsIssued = 0;

  constructor() {
    this.seed();
  }

  /** The live issue shape every created issue reports, including one managed region. */
  seed(): void {
    this.issues.set('issue_fixture_01', {
      issue: {
        issueId: 'issue_fixture_01' as ProviderId,
        identifier: `${TEAM}-100`,
        url: 'https://tickets.double.invalid/ENG/issue_fixture_01',
      },
      snapshot: {
        workItemId: 'work_fixture_01',
        issueId: 'issue_fixture_01',
        issueIdentifier: `${TEAM}-100`,
        title: 'An issue that already exists',
        description: 'Description a person wrote.',
        providerRevision: T0,
        priority: 'High',
        dependencyIssueIds: [],
        acceptanceCriteria: [{ id: 'AC1', text: 'The existing behaviour keeps working.' }],
        retrievedAt: T0,
      },
      state: { kind: 'ProviderState', name: 'Todo', terminal: 'None' },
      relations: [],
      managedRegions: [
        {
          target: { kind: 'UpdatableComment', commentId: 'comment_seed' as ProviderId },
          lastMilestoneKey: null,
          lastDeliveredAt: null,
          lastDeliveredContentDigest: null,
        },
      ],
      observedAt: T0,
    });
  }

  /** Make the next issue creation reach the provider and then lose its response. */
  loseNextPublishResponse(): void {
    this.loseNextPublish = true;
  }

  /** Make every later issue creation be refused with this error. */
  refusePublishWith(error: DomainError): void {
    this.publishRefusal = error;
    this.publishRefusalAfter = 0;
  }

  /**
   * Let `successful` creations through, then refuse with this error.
   *
   * Counting rather than refusing outright is what makes a partial publication testable: a
   * provider that refused every create would prove only that total failure is reported,
   * which says nothing about the mapping that succeeded (F10-AC2, F10-AC5).
   */
  refusePublishAfter(successful: number, error: DomainError): void {
    this.publishRefusal = error;
    this.publishRefusalAfter = successful;
  }

  /** Stop refusing, as a corrected connector would. */
  allowPublish(): void {
    this.publishRefusal = null;
    this.publishRefusalAfter = 0;
  }

  /** The issue identity one publication operation owns, derived as the contract requires. */
  static derivedIssueId(operationId: string): string {
    return `derived:${operationId}`;
  }

  issueCount(): number {
    return this.sequence;
  }

  commentCount(): number {
    return this.comments.length;
  }

  capabilities(): AdapterCapabilities {
    return {
      kind: 'Ticket',
      contractVersion: 1,
      declarations: TICKET_CAPABILITIES.map((kind) => ({
        kind,
        supported: true,
        limitation: null,
        privileged: false,
        supportsPrecondition: false,
      })),
    };
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

  async readScope(
    _context: Parameters<TicketAdapter['readScope']>[0],
    request: Parameters<TicketAdapter['readScope']>[1],
  ): Promise<Result<TicketScopeRead>> {
    this.performed.push({
      name: 'readScope',
      operationId: String(request.workItemId),
      target: request.issueId,
      derivedIssueId: request.issueId,
    });
    const known = this.issues.get(request.issueId);
    return known === undefined
      ? err({ code: 'NotFound', reason: `The provider has no issue ${request.issueId}.` })
      : ok(known);
  }

  async findRelatedIssues(): Promise<Result<readonly never[]>> {
    return ok([]);
  }

  async publishWork(
    _context: Parameters<TicketAdapter['publishWork']>[0],
    request: PublishWorkRequest,
  ): Promise<Result<PublishWorkOutcome>> {
    const derived = RecordingTicketProvider.derivedIssueId(request.operationId);
    this.performed.push({
      name: 'publishWork',
      operationId: request.operationId,
      target: request.revision.targetTeamKey,
      derivedIssueId: derived,
    });
    if (this.publishRefusal !== null && this.createsIssued >= this.publishRefusalAfter) {
      return err(this.publishRefusal);
    }

    if (this.loseNextPublish) {
      this.loseNextPublish = false;
      this.createsIssued += 1;
      this.sequence += 1;
      this.issues.set(derived, this.issueFor(derived, `${TEAM}-${700 + this.sequence}`, request));
      return err({
        code: 'OutcomeUnknown',
        reason: 'The issue creation was sent and its response was lost.',
        operationId: request.operationId,
        target: derived,
      });
    }

    const replay = this.dispositions.get(request.operationId) === 'CreatedNew';
    this.createsIssued += 1;
    this.sequence += 1;
    const identifier = `${TEAM}-${700 + this.sequence}`;
    this.issues.set(derived, this.issueFor(derived, identifier, request));
    this.dispositions.set(request.operationId, replay ? 'AlreadyPresent' : 'CreatedNew');
    return ok({
      kind: 'Published',
      published: [
        {
          issue: {
            issueId: derived as ProviderId,
            identifier,
            url: `https://tickets.double.invalid/${TEAM}/${derived}`,
          },
          disposition: replay ? 'AlreadyPresent' : 'CreatedNew',
          snapshot: this.issues.get(derived)?.snapshot ?? this.issueFor(derived, identifier, request).snapshot,
        },
      ],
    });
  }

  async updateManagedProgress(
    _context: Parameters<TicketAdapter['updateManagedProgress']>[0],
    request: ManagedProgressUpdateRequest,
  ): Promise<Result<ManagedProgressOutcome>> {
    this.performed.push({
      name: 'updateManagedProgress',
      operationId: request.operationId,
      target: request.issueId,
      derivedIssueId: request.operationId,
    });
    const issue = this.issues.get(request.issueId);
    if (issue === undefined) {
      return err({ code: 'NotFound', reason: `The provider has no issue ${request.issueId}.` });
    }
    const commentId = `comment_${request.operationId}`;
    const existing = this.comments.find((comment) => comment.commentId === commentId);
    if (existing !== undefined) {
      return ok({
        kind: 'Unchanged',
        region: { kind: 'UpdatableComment', commentId: commentId as ProviderId },
        deliveredMilestoneKey: existing.milestoneKey,
        deliveredAt: T0,
      });
    }
    this.comments.push({ commentId, body: request.body, milestoneKey: request.milestoneKey });
    return ok({
      kind: 'Updated',
      region: { kind: 'UpdatableComment', commentId: commentId as ProviderId },
      previousMilestoneKey: issue.managedRegions[0]?.lastMilestoneKey ?? null,
      deliveredAt: T0,
    });
  }

  async describeTransitions(): Promise<Result<readonly never[]>> {
    return ok([]);
  }

  async requestTransition(): Promise<Result<never>> {
    return err({ code: 'Unavailable', reason: 'This provider cannot request a transition.' });
  }

  private issueFor(derived: string, identifier: string, request: PublishWorkRequest): TicketScopeRead {
    return {
      issue: {
        issueId: derived as ProviderId,
        identifier,
        url: `https://tickets.double.invalid/${TEAM}/${derived}`,
      },
      snapshot: {
        workItemId: request.revision.workItemId,
        issueId: derived,
        issueIdentifier: identifier,
        title: request.revision.title,
        description: request.revision.description,
        providerRevision: T0,
        priority: null,
        dependencyIssueIds: [...request.revision.dependencyIssueIds],
        acceptanceCriteria: [...request.revision.criteria],
        retrievedAt: T0,
      },
      state: { kind: 'ProviderState', name: 'Todo', terminal: 'None' },
      relations: [],
      managedRegions: [
        {
          target: { kind: 'UpdatableComment', commentId: `comment_seed_${derived}` as ProviderId },
          lastMilestoneKey: null,
          lastDeliveredAt: null,
          lastDeliveredContentDigest: null,
        },
      ],
      observedAt: T0,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Plan fixtures                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A plan the owner accepted.
 *
 * Built through the domain's own proposal, draft and acceptance path rather than assembled,
 * so the only publishable form available to the controller is the one the owner agreed to
 * (F08-AC3, F10-AC1). A test that hand-wrote a `PublishableTicket` could pass while proving
 * nothing about what was actually accepted.
 */
async function acceptedPlan(): Promise<Plan> {
  const { applyPlanProposal, draftPlan, editPlan } = await import('@shiploop/domain');
  const validated = applyPlanProposal({
    kind: 'PlanProposal',
    briefId: 'brief-1',
    draftedAt: T0,
    basedOnRevision: null,
    requestedOutcomes: [{ id: 'o1', statement: 'The agreed ticket appears in Linear.' }],
    tasks: [
      {
        outcome: 'The agreed ticket appears in Linear.',
        scope: 'Create the issue from the accepted plan revision and record its identity.',
        acceptanceCriteria: ['The issue carries the accepted title, scope and criteria.'],
        verificationMethod: 'Read the created issue back and compare it with the proposal.',
        dependencies: [],
        relevantProjectContext: [],
        implementationLocation: {
          kind: 'ProposedLocation',
          candidates: ['packages/controller/src/publication.ts'],
          basis: 'the publication path is where an issue is created',
        },
        taskId: 'task-1',
        coversOutcomeIds: ['o1'],
      },
    ],
    exclusions: [],
  });
  assert.ok(validated.ok, 'the plan proposal should validate');

  const drafted = draftPlan({
    planId: 'plan-1',
    briefId: 'brief-1',
    change: {
      summary: 'One reviewable publication behaviour.',
      surfaces: [
        {
          surfaceId: 'publication',
          description: 'Publishing an accepted plan revision.',
          observableBehaviour: 'A read of the published issue shows the accepted scope.',
          independentlyReviewable: true,
        },
      ],
      dependencyEdges: [],
    },
    proposal: validated.value,
  });
  assert.ok(drafted.ok, 'the plan should draft');

  const accepted = editPlan(drafted.value, {
    kind: 'Accept',
    taskId: 'task-1',
    expectedRevision: drafted.value.revision,
    by: OWNER_ID,
    at: T0,
  });
  assert.ok(accepted.ok, 'the owner acceptance should apply');
  return accepted.value;
}

async function agreedTicket(): Promise<PublishableTicket> {
  const { publishableTickets } = await import('@shiploop/domain');
  const plan = await acceptedPlan();
  const tickets = publishableTickets(plan);
  const ticket = tickets[0];
  assert.ok(ticket !== undefined, 'an accepted plan should hold a publishable ticket');
  return ticket;
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly useCases: PublicationUseCases;
  readonly publications: PublicationRepository;
  readonly provider: RecordingTicketProvider;
  readonly workItems: WorkItemRepository;
  readonly database: Database;
  readonly workItemId: WorkItemId;
  readonly profileVersionId: ProfileVersionId;
  readonly publish: (requestId: string, workItemIds?: readonly WorkItemId[]) => Promise<Result<PublicationReport, DomainError>>;
}

/**
 * A migrated database with one work item awaiting publication.
 *
 * The work item is created through the real repository so every column its reader needs is
 * bound the way the product binds it, and the use cases are the real ones over the real
 * store. The clock is fixed, so a recorded decision replays identically.
 */
async function withPublication(run: (harness: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-publication-use-case-'));
  const opened = openDatabase(join(directory, 'publication.sqlite'));
  assert.ok(opened.ok, `the database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
  const database: Database = opened.value;
  try {
    const migrated = migrate(database);
    assert.ok(migrated.ok, `the schema could not be migrated: ${migrated.ok ? '' : migrated.error.reason}`);
    assert.equal(LATEST_SCHEMA_VERSION, 11, 'the provider-revision migration should be the newest applied');

    database
      .prepare('INSERT INTO owners (owner_id, display_name, created_at) VALUES (?, ?, ?)')
      .run(OWNER_ID, 'Publication owner', T0);
    database
      .prepare('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)')
      .run(PROJECT, 'Publication project', T0);
    const profile = expectOk(new ProjectProfileRepository(database).saveVersion({
      projectId: PROJECT,
      content: {
        references: {
          repository: 'github.com/example/shiploop',
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
    }));

    // The profile the work item is bound to is the one the repository just wrote, rather
    // than a second fixture row: a work item whose profile version is a hand-made row would
    // not be the shape the product produces.
    const profileVersionId = profile.profileVersionId;

    const workItems = new WorkItemRepository(database);
    const ticket = await agreedTicket();
    const created = workItems.create({
      projectId: PROJECT,
      profileVersionId,
      source: 'ProposedNewIssue',
      title: ticket.title,
      externalIssueId: null,
      externalIssueIdentifier: null,
      externalIssueUrl: null,
      publicationIntent: 'PublishWhenAgreed',
      relatedWorkItemIds: [],
      adoption: null,
      at: T0,
    });
    assert.ok(created.ok, `the work item should be created: ${created.ok ? '' : created.error.reason}`);

    const provider = new RecordingTicketProvider();
    const publications = new PublicationRepository(database);
    const useCases = createPublicationUseCases({ clock, publications, ticket: provider });

    const publish = async (requestId: string, workItemIds?: readonly WorkItemId[]) => {
      const ids = workItemIds ?? [created.value.workItemId];
      const tickets = [];
      for (const id of ids) {
        const revision = revisionFor(ticket, id, TEAM, []);
        assert.ok(revision.ok, `the revision should project: ${revision.ok ? '' : revision.error.reason}`);
        tickets.push({ workItemId: id, revision: revision.value });
      }
      return useCases.publishAcceptedWork({
        actor: owner,
        projectId: PROJECT,
        requestId,
        correlationId: CORRELATION,
        tickets,
      });
    };

    const harness: Harness = {
      useCases,
      publications,
      provider,
      workItems,
      database,
      workItemId: created.value.workItemId,
      profileVersionId,
      publish,
    };
    await run(harness);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* F10-AC1                                                                     */
/* -------------------------------------------------------------------------- */

test('F10-AC1 an accepted proposal publishes the agreed title, scope, criteria and team', async () => {
  await withPublication(async ({ publish, provider, workItemId }) => {
    const ticket = await agreedTicket();
    const revision = expectOk(revisionFor(ticket, workItemId, TEAM, ['issue_dependency_1']));
    assert.equal(revision.criteria.length, 1, 'the accepted criteria must reach the provider (F10-AC1)');
    assert.deepEqual(revision.dependencyIssueIds, ['issue_dependency_1'], 'the accepted dependencies must be carried');

    const report = expectOk(
      await publish('request-happy', [workItemId]),
    );
    void ticket;

    assert.deepEqual(report.published, [workItemId]);
    assert.deepEqual(report.unpublished, []);
    const published = report.tickets[0];
    assert.equal(published?.kind, 'Published');
    if (published?.kind !== 'Published') return;
    assert.equal(published.disposition, 'CreatedNew');
    assert.equal(published.issue.identifier, 'ENG-701');

    const creation = provider.performed.filter((operation) => operation.name === 'publishWork');
    assert.equal(creation.length, 1);
    assert.equal(creation[0]?.target, TEAM, 'the issue was addressed to a team other than the configured one (F10-AC1)');
  });
});

test('F10-AC1 an incomplete accepted proposal is refused with the missing field named', () => {
  const incomplete: PublishableTicket = {
    taskId: 'task-x',
    title: 'Publish',
    outcome: 'outcome',
    scope: 'scope',
    acceptanceCriteria: [],
    verificationMethod: 'read it back',
    dependencyTaskIds: [],
    relevantProjectContext: [],
    acceptedBy: OWNER_ID,
    acceptedAt: T0,
  };
  const error = expectError(
    revisionFor(incomplete, 'work-1' as WorkItemId, TEAM, []),
    'Invalid',
  );
  assert.match(JSON.stringify(error), /acceptance criterion/, 'the refusal must name what is missing (F10-AC1)');

  const noTeam = expectError(
    revisionFor({ ...incomplete, acceptanceCriteria: ['a criterion'] }, 'work-1' as WorkItemId, '   ', []),
    'Invalid',
  );
  assert.match(JSON.stringify(noTeam), /ticket team/, 'the refusal must name the missing team (F10-AC1)');
});

test('F10-AC1 only the owner may publish agreed work, and the provider is never reached', async () => {
  await withPublication(async ({ useCases, provider, workItemId }) => {
    const ticket = await agreedTicket();
    const revision = expectOk(revisionFor(ticket, workItemId, TEAM, []));
    const error = expectError(
      await useCases.publishAcceptedWork({
        actor: agent,
        projectId: PROJECT,
        requestId: 'request-agent',
        correlationId: CORRELATION,
        tickets: [{ workItemId, revision }],
      }),
      'Forbidden',
    );
    assert.match(error.reason, /owner/i);
    assert.equal(provider.performed.length, 0, 'a refused publication reached the provider (F10-AC1)');
  });
});

test('F10-AC1 a publication request with no tickets or no identity is refused', async () => {
  await withPublication(async ({ useCases, provider, workItemId }) => {
    const ticket = await agreedTicket();
    const revision = expectOk(revisionFor(ticket, workItemId, TEAM, []));
    const empty = expectError(
      await useCases.publishAcceptedWork({
        actor: owner,
        projectId: PROJECT,
        requestId: 'request-empty',
        correlationId: CORRELATION,
        tickets: [],
      }),
      'Invalid',
    );
    assert.match(JSON.stringify(empty), /named no tickets/);

    const unidentified = expectError(
      await useCases.publishAcceptedWork({
        actor: owner,
        projectId: PROJECT,
        requestId: '  ',
        correlationId: CORRELATION,
        tickets: [{ workItemId, revision }],
      }),
      'Invalid',
    );
    assert.match(JSON.stringify(unidentified), /identity/);
    assert.equal(provider.performed.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* F10-AC2 / F10-AC3                                                           */
/* -------------------------------------------------------------------------- */

test('F10-AC3 a repeat after a lost response reconciles and creates no second issue (F30-AC5, N01-AC2)', async () => {
  await withPublication(async ({ publish, provider, publications, workItems, workItemId }) => {
    provider.loseNextPublishResponse();

    const first = expectOk(await publish('request-lost'));
    assert.equal(first.tickets[0]?.kind, 'OutcomeUnknown', 'a lost response must not read as published (F30-AC5)');
    assert.deepEqual(first.unpublished, [workItemId], 'an unresolved ticket still owes a write (F10-AC2)');
    assert.equal(provider.issueCount(), 1, 'the injection did not reach the provider at all');

    const operationId = publicationOperationId('request-lost', workItemId);
    assert.equal(
      publications.findOperation(operationId)?.status,
      'OutcomeUnknown',
      'the ledger did not record the lost outcome (N01-AC2)',
    );
    assert.equal(
      expectOk(workItems.get(workItemId)).publicationState,
      'OutcomeUnknown',
      'the work item did not record that its outcome is unknown (F30-AC5)',
    );

    const repeat = expectOk(await publish('request-lost'));
    assert.equal(repeat.tickets[0]?.kind, 'OutcomeUnknown', 'the repeat wrote again instead of waiting (F10-AC3)');
    assert.equal(
      provider.issueCount(),
      1,
      'a repeated request created a second issue, which is exactly the failure F10-AC3 exists to prevent',
    );
    assert.equal(
      provider.performed.filter((operation) => operation.name === 'publishWork').length,
      1,
      'the repeat reached the provider at all',
    );
  });
});

test('F10-AC3 a reconciliation that established the write settles the state as published exactly once', async () => {
  await withPublication(async ({ publish, useCases, provider, publications, workItemId }) => {
    provider.loseNextPublishResponse();
    expectOk(await publish('request-reconcile'));
    const operationId = publicationOperationId('request-reconcile', workItemId);
    const derived = RecordingTicketProvider.derivedIssueId(operationId);

    const settled = expectOk(
      useCases.reconcilePublication({
        actor: owner,
        operationId,
        correlationId: CORRELATION,
        observedAt: T1,
        resolvedBy: OWNER_ID,
        resolution: {
          resolution: 'Applied',
          providerIssueId: derived,
          providerIssueIdentifier: 'ENG-701',
          providerIssueUrl: `https://tickets.double.invalid/${TEAM}/${derived}`,
          providerRevision: T0,
          detail: 'Read the team backlog and found the issue the operation created.',
        },
      }),
    );
    assert.equal(settled.kind, 'Published');

    const target = expectOk(publications.listPublicationTargets(PROJECT)).find(
      (entry) => entry.workItemId === workItemId,
    );
    assert.equal(target?.publicationState, 'Published', 'the reconciled publication did not settle (F10-AC3)');
    assert.equal(target?.providerIssueIdentifier, 'ENG-701', 'the reconciled identifier was not saved (F10-AC2)');
    assert.equal(target?.providerIssueId, derived);
    assert.equal(publications.findOperation(operationId)?.status, 'Succeeded');
    assert.equal(
      provider.issueCount(),
      1,
      'reconciliation created a second issue rather than reading the existing one (F10-AC3)',
    );

    const after = expectOk(await publish('request-reconcile'));
    const entry = after.tickets[0];
    assert.equal(entry?.kind, 'Published');
    assert.equal(entry?.kind === 'Published' ? entry.disposition : null, 'AlreadyPresent');
    assert.equal(
      provider.issueCount(),
      1,
      'a settled publication created a second issue (F10-AC3)',
    );
  });
});

test('F10-AC3 an applied reconciliation may not be recorded without the provider identity (F28-AC4)', async () => {
  await withPublication(async ({ publish, useCases, publications, workItemId, provider }) => {
    provider.loseNextPublishResponse();
    expectOk(await publish('request-unproven'));
    const operationId = publicationOperationId('request-unproven', workItemId);

    const refused = expectError(
      useCases.reconcilePublication({
        actor: owner,
        operationId,
        correlationId: CORRELATION,
        observedAt: T1,
        resolvedBy: OWNER_ID,
        resolution: {
          resolution: 'Applied',
          providerIssueId: '',
          providerIssueIdentifier: 'ENG-701',
          providerIssueUrl: '',
          providerRevision: null,
          detail: 'Probably fine.',
        },
      }),
      'Invalid',
    );
    assert.match(JSON.stringify(refused), /provider identity/, 'the refusal must name what is missing (F28-AC4)');
    assert.equal(
      publications.findOperation(operationId)?.status,
      'OutcomeUnknown',
      'an unevidenced claim settled the operation anyway (F28-AC4)',
    );
  });
});

test('F10-AC3 a repeat reconciliation of a settled operation reports it and rewrites nothing', async () => {
  await withPublication(async ({ publish, useCases, publications, provider, workItems, workItemId }) => {
    expectOk(await publish('request-settled'));
    const operationId = publicationOperationId('request-settled', workItemId);
    const before = expectOk(workItems.get(workItemId)).externalIssueId;

    const repeat = expectOk(
      useCases.reconcilePublication({
        actor: owner,
        operationId,
        correlationId: CORRELATION,
        observedAt: T1,
        resolvedBy: OWNER_ID,
        resolution: {
          resolution: 'Applied',
          providerIssueId: 'derived:a-different-issue',
          providerIssueIdentifier: 'ENG-999',
          providerIssueUrl: 'https://tickets.double.invalid/ENG/derived:a-different-issue',
          providerRevision: T1,
          detail: 'A reconciler claimed a different issue for an already-settled write.',
        },
      }),
    );
    assert.equal(repeat.kind, 'Published');
    assert.equal(repeat.kind === 'Published' ? repeat.issueId : null, before, 'the recorded identity was overwritten');
    assert.equal(expectOk(workItems.get(workItemId)).externalIssueId, before);
    assert.equal(provider.issueCount(), 1, 'the reconciliation issued a write (F10-AC3)');
    assert.equal(publications.findOperation(operationId)?.status, 'Succeeded');
  });
});

test('F10-AC3 a reconciliation may only be recorded by the owner', async () => {
  await withPublication(async ({ publish, useCases, workItemId, provider }) => {
    provider.loseNextPublishResponse();
    expectOk(await publish('request-unauthorised'));
    const error = expectError(
      useCases.reconcilePublication({
        actor: agent,
        operationId: publicationOperationId('request-unauthorised', workItemId),
        correlationId: CORRELATION,
        observedAt: T1,
        resolvedBy: 'agent-1',
        resolution: {
          resolution: 'Applied',
          providerIssueId: 'derived:x',
          providerIssueIdentifier: 'ENG-1',
          providerIssueUrl: '',
          providerRevision: null,
          detail: 'n/a',
        },
      }),
      'Forbidden',
    );
    assert.match(error.reason, /owner/i);
  });
});

/* -------------------------------------------------------------------------- */
/* F10-AC2 partial failure                                                     */
/* -------------------------------------------------------------------------- */

test('F10-AC2 a refused ticket names what remains unpublished and keeps the mapping that succeeded (F10-AC5)', async () => {
  await withPublication(async ({ publish, provider, workItems, workItemId, profileVersionId }) => {
    const second = expectOk(
      workItems.create({
        projectId: PROJECT,
        profileVersionId,
        source: 'ProposedNewIssue',
        title: 'Second ticket',
        externalIssueId: null,
        externalIssueIdentifier: null,
        externalIssueUrl: null,
        publicationIntent: 'PublishWhenAgreed',
        relatedWorkItemIds: [],
        adoption: null,
        at: T0,
      }),
    );

    // The first ticket publishes; the next create is refused with a permission error, which
    // is the shape F10-AC5 describes. Refusal is programmed after the first success rather
    // than before it, so the partial outcome is a real partial rather than a total failure.
    provider.refusePublishAfter(1, {
      code: 'Forbidden',
      reason: 'The connector was refused permission to create issues in this team.',
    });

    const report = expectOk(await publish('request-partial', [workItemId, second.workItemId]));

    assert.equal(report.tickets[0]?.kind, 'Published', 'the first ticket should have published');
    assert.equal(report.tickets[1]?.kind, 'Failed', 'the second ticket should have been refused');
    assert.deepEqual(report.published, [workItemId], 'the report must name what published (F10-AC2)');
    assert.deepEqual(
      report.unpublished,
      [second.workItemId],
      'a partial failure must name exactly what remains unpublished (F10-AC2)',
    );

    const failed = report.tickets[1];
    if (failed?.kind !== 'Failed') return;
    assert.match(failed.error.reason, /permission/i, "the refusal must be explained in the owner's terms (F10-AC5)");
    assert.equal(
      expectOk(workItems.get(failed.workItemId)).publicationState,
      'Unpublished',
      'a refused ticket must return to unpublished (F10-AC5)',
    );
    const refused = expectOk(workItems.get(second.workItemId));
    assert.equal(
      refused.publicationIntent,
      'PublishWhenAgreed',
      "a refusal must preserve the owner selection so a retry needs nothing but the correction (F10-AC5)",
    );

    const published = expectOk(workItems.get(workItemId));
    assert.equal(published.publicationState, 'Published', 'the successful mapping was lost (F10-AC5)');
    assert.equal(published.externalIssueIdentifier, 'ENG-701');
  });
});

test('F10-AC5 a retry after a corrected refusal publishes without a second ticket losing its mapping', async () => {
  await withPublication(async ({ publish, provider, workItems, workItemId, profileVersionId }) => {
    const second = expectOk(
      workItems.create({
        projectId: PROJECT,
        profileVersionId,
        source: 'ProposedNewIssue',
        title: 'Second ticket',
        externalIssueId: null,
        externalIssueIdentifier: null,
        externalIssueUrl: null,
        publicationIntent: 'PublishWhenAgreed',
        relatedWorkItemIds: [],
        adoption: null,
        at: T0,
      }),
    );
    provider.refusePublishAfter(1, { code: 'Forbidden', reason: 'Permission denied for this team.' });
    expectOk(await publish('request-retry', [workItemId, second.workItemId]));

    provider.allowPublish();
    const retried = expectOk(await publish('request-retry', [workItemId, second.workItemId]));

    const firstEntry = retried.tickets[0];
    assert.equal(firstEntry?.kind, 'Published');
    assert.equal(
      firstEntry?.kind === 'Published' ? firstEntry.disposition : null,
      'AlreadyPresent',
      'the retry recreated the ticket that had already published (F10-AC5)',
    );
    assert.equal(retried.tickets[1]?.kind, 'Published', 'the corrected ticket did not publish on retry (F10-AC5)');
    assert.deepEqual(retried.unpublished, []);
    assert.equal(provider.issueCount(), 2, 'the retry created more issues than the two tickets (F10-AC5)');
  });
});

/* -------------------------------------------------------------------------- */
/* F10-AC4                                                                     */
/* -------------------------------------------------------------------------- */

test('F10-AC4 the published row is a snapshot of the provider revision, with no editable content', async () => {
  await withPublication(async ({ publish, database, workItemId }) => {
    expectOk(await publish('request-snapshot'));
    const stored = database
      .prepare('SELECT provider_revision, external_issue_identifier FROM work_items WHERE work_item_id = ?')
      .get(workItemId);
    assert.equal(stored?.['provider_revision'], T0, 'the published row must name what it read (F10-AC4)');
    assert.equal(stored?.['external_issue_identifier'], 'ENG-701');

    const editable = database
      .prepare("SELECT name FROM pragma_table_info('work_items') WHERE name IN ('description', 'acceptance_criteria', 'body')")
      .all();
    assert.deepEqual(editable, [], 'the local row grew an editable copy of the live ticket (F10-AC4)');
  });
});

/* -------------------------------------------------------------------------- */
/* F16-AC2 / F16-AC3 / F16-AC4                                                 */
/* -------------------------------------------------------------------------- */

test('F16-AC2 a managed milestone is delivered into the region the provider reports', async () => {
  await withPublication(async ({ publish, useCases, provider, workItemId }) => {
    expectOk(await publish('request-progress-base'));
    const delivery = expectOk(
      await useCases.publishManagedProgress({
        actor: owner,
        workItemId,
        milestoneKey: 'build-started',
        body: 'Started the build. Latest milestone: build started.',
        correlationId: CORRELATION,
      }),
    );
    assert.equal(delivery.kind, 'Updated');
    if (delivery.kind !== 'Updated') return;
    assert.equal(delivery.regionKind, 'UpdatableComment', 'progress did not land in a managed comment (F16-AC2)');
    assert.equal(provider.commentCount(), 1);
    assert.equal(provider.comments[0]?.milestoneKey, 'build-started');
  });
});

test('F16-AC3 a repeated milestone is not delivered again', async () => {
  await withPublication(async ({ publish, useCases, provider, workItemId }) => {
    expectOk(await publish('request-progress-repeat'));
    const request = {
      actor: owner,
      workItemId,
      milestoneKey: 'build-started',
      body: 'Started the build.',
      correlationId: CORRELATION,
    };
    expectOk(await useCases.publishManagedProgress(request));
    const second = expectOk(await useCases.publishManagedProgress(request));

    assert.equal(second.kind, 'Unchanged', 'a repeated milestone was delivered again (F16-AC3)');
    assert.equal(provider.commentCount(), 1, 'a repeated milestone created a second comment (F16-AC3)');
    assert.equal(
      provider.performed.filter((operation) => operation.name === 'updateManagedProgress').length,
      1,
      'the repeat reached the provider at all (F16-AC3)',
    );
    assert.equal(
      managedDeliveryOperationId(workItemId, 'build-started'),
      managedDeliveryOperationId(workItemId, 'build-started'),
    );
  });
});

test('F16-AC3 two different milestones are two deliveries', async () => {
  await withPublication(async ({ publish, useCases, provider, workItemId }) => {
    expectOk(await publish('request-progress-two'));
    expectOk(
      await useCases.publishManagedProgress({
        actor: owner,
        workItemId,
        milestoneKey: 'build-started',
        body: 'Build started.',
        correlationId: CORRELATION,
      }),
    );
    const second = expectOk(
      await useCases.publishManagedProgress({
        actor: owner,
        workItemId,
        milestoneKey: 'checks-running',
        body: 'Checks are running.',
        correlationId: CORRELATION,
      }),
    );
    assert.equal(second.kind, 'Updated', 'a distinct milestone was suppressed (F16-AC3)');
    assert.equal(provider.commentCount(), 2);
  });
});

test('F16-AC4 managed progress for an unpublished work item is refused rather than written anywhere', async () => {
  await withPublication(async ({ useCases, provider, workItemId }) => {
    const error = expectError(
      await useCases.publishManagedProgress({
        actor: owner,
        workItemId,
        milestoneKey: 'build-started',
        body: 'Started.',
        correlationId: CORRELATION,
      }),
      'Invalid',
    );
    assert.match(JSON.stringify(error), /not published/i);
    assert.equal(provider.commentCount(), 0, 'progress was written for an unpublished work item (F16-AC2)');
  });
});

/* -------------------------------------------------------------------------- */
/* F29-AC4                                                                     */
/* -------------------------------------------------------------------------- */

test('F29-AC4 a receipt retry does not republish a duplicate receipt', async () => {
  await withPublication(async ({ publish, useCases, provider, workItemId }) => {
    expectOk(await publish('request-receipt'));
    const request = {
      actor: owner,
      workItemId,
      receiptId: 'receipt-1',
      body: 'Delivered as abc123. Checks: pnpm test passed.',
      correlationId: CORRELATION,
    };
    assert.equal(expectOk(await useCases.publishReleaseReceipt(request)).kind, 'Published');
    assert.equal(expectOk(await useCases.publishReleaseReceipt(request)).kind, 'AlreadyPublished');
    assert.equal(provider.commentCount(), 1, 'a receipt retry wrote a second comment (F29-AC4)');
    assert.equal(
      receiptPublicationOperationId(workItemId, 'receipt-1'),
      receiptPublicationOperationId(workItemId, 'receipt-1'),
    );
    assert.notEqual(
      receiptPublicationOperationId(workItemId, 'receipt-1'),
      receiptPublicationOperationId(workItemId, 'receipt-2'),
    );
  });
});

test('F29-AC4 a lost receipt response is unresolved and the retry waits rather than duplicating', async () => {
  await withPublication(async ({ publish, useCases, provider, publications, workItems, workItemId }) => {
    expectOk(await publish('request-receipt-lost'));
    const operationId = receiptPublicationOperationId(workItemId, 'receipt-2');
    expectOk(
      publications.beginExternalUpdate(operationId, {
        projectId: PROJECT,
        correlationId: CORRELATION,
        at: T0,
        kind: 'ReceiptPublish',
        target: 'ENG-701',
      }),
    );
    expectOk(
      publications.settleUnresolved({
        workItemId,
        operationId,
        detail: 'The receipt comment response was lost.',
        observedAt: T0,
        scope: 'ExternalUpdate',
      }),
    );
    assert.equal(
      expectOk(workItems.get(workItemId)).publicationState,
      'Published',
      'an unresolved receipt reset the ticket it was published on (F29-AC4)',
    );

    const retry = expectOk(
      await useCases.publishReleaseReceipt({
        actor: owner,
        workItemId,
        receiptId: 'receipt-2',
        body: 'Delivered as abc123.',
        correlationId: CORRELATION,
      }),
    );
    assert.equal(retry.kind, 'OutcomeUnknown', 'a lost receipt response was retried blindly (F29-AC4, F30-AC5)');
    assert.equal(provider.commentCount(), 0, 'the retry wrote a duplicate receipt (F29-AC4)');
  });
});

test('F10-AC2 the per-ticket read names the same unpublished work the write reported', async () => {
  await withPublication(async ({ publish, useCases, provider, workItems, workItemId, profileVersionId }) => {
    const second = expectOk(
      workItems.create({
        projectId: PROJECT,
        profileVersionId,
        source: 'ProposedNewIssue',
        title: 'Second ticket',
        externalIssueId: null,
        externalIssueIdentifier: null,
        externalIssueUrl: null,
        publicationIntent: 'PublishWhenAgreed',
        relatedWorkItemIds: [],
        adoption: null,
        at: T0,
      }),
    );
    provider.refusePublishAfter(1, { code: 'Forbidden', reason: 'The team has no remaining issue capacity.' });
    const report = expectOk(await publish('request-targets', [workItemId, second.workItemId]));

    const targets = expectOk(useCases.publicationTargets(PROJECT));
    assert.deepEqual(
      targets.filter((target) => target.publicationState === 'Published').map((target) => target.workItemId),
      report.published,
      'the durable read disagrees with what the write reported (F10-AC2)',
    );
    assert.deepEqual(
      targets
        .filter((target) => target.publicationState !== 'Published')
        .map((target) => target.workItemId)
        .sort(),
      report.unpublished.slice().sort(),
      'the durable read disagrees about what remains unpublished (F10-AC2)',
    );
    const publishedTarget = targets.find((target) => target.workItemId === workItemId);
    assert.equal(publishedTarget?.providerIssueUrl !== null, true, 'the provider URL was not saved (F10-AC2)');
  });
});

/* -------------------------------------------------------------------------- */
/* Identity and classification                                                 */
/* -------------------------------------------------------------------------- */

test('F10-AC3 the publication identity a ticket owns is derived from the request and the ticket', () => {
  assert.equal(
    publicationOperationId('request-1', 'work-1'),
    publicationOperationId('request-1', 'work-1'),
    'the identity must be stable so a retry addresses the same operation (F10-AC3)',
  );
  assert.notEqual(publicationOperationId('request-1', 'work-1'), publicationOperationId('request-1', 'work-2'));
  assert.notEqual(publicationOperationId('request-1', 'work-1'), publicationOperationId('request-2', 'work-1'));
});

test('F30-AC4 each refusal category maps to the ledger category that decides its retry', () => {
  assert.equal(failureCategoryFor({ code: 'RateLimited', reason: 'r', retryAfterMs: 1000 }), 'RateLimited');
  assert.equal(failureCategoryFor({ code: 'Forbidden', reason: 'f' }), 'PermissionDenied');
  assert.equal(failureCategoryFor({ code: 'NotFound', reason: 'n' }), 'NotFound');
  assert.equal(failureCategoryFor({ code: 'Conflict', reason: 'c', expected: 'a', actual: 'b' }), 'Conflict');
  assert.equal(failureCategoryFor({ code: 'Invalid', reason: 'i', fields: [] }), 'Validation');
  assert.equal(failureCategoryFor({ code: 'Unavailable', reason: 'u' }), 'TransientProvider');
  assert.equal(
    failureCategoryFor({ code: 'OutcomeUnknown', reason: 'o', operationId: 'op', target: 't' }),
    'OutcomeUnknown',
  );
});


