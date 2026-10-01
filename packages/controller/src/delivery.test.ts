/**
 * Behavioural proof for owner-authorized delivery (F26-AC1, F26-AC2, F26-AC3, F26-AC4,
 * F26-AC5, F27-AC1, F27-AC2, F27-AC3, F27-AC5, F28-AC1, F28-AC2, F28-AC3, F28-AC4,
 * F28-AC5, F29-AC1, F29-AC2, F29-AC3, F29-AC4, F29-AC5, F30-AC4, F30-AC5, N01-AC2).
 *
 * Every case runs against a real SQLite file in a fresh temporary directory, opened by the
 * real `openDatabase` and brought to the real `migrate` version. The `deliveries`,
 * `delivery_components`, `live_smoke_results`, `release_receipts` and `external_operations`
 * rows are the schema's own, and the operation bracket is the real `createOperationStore`,
 * so "the write was refused before it reached the provider" is proved by the ledger refusing
 * rather than by a mock expecting a call count.
 *
 * The provider half is the real `@shiploop/adapters` fake set answering the real
 * `GitAdapter` and `DeploymentAdapter` contracts, scripted through `FakeConditions`: a lost
 * response, a per-component availability, a lost ref, and a provider review that requests
 * changes. The cases worth reading first:
 *
 *   - an authorization is bound to the action, destination, pull request, head, target
 *     branch, candidate fingerprint and component deployment ids, and changing any one of
 *     them invalidates it before it is consumed (F26-AC1, F27-AC3);
 *   - the check runs against a live read taken immediately before the write, so a head that
 *     moved between authorization and execution is refused by name (F26-AC2, F25-AC3);
 *   - a second consumption is refused with `AlreadyConsumed`, and the row records who
 *     consumed it and when (F26-AC3, F27-AC2);
 *   - a lost merge response becomes `OutcomeUnknown`, the second attempt never reaches the
 *     provider, and reconciliation settles the delivery once by reading the target
 *     (F28-AC3, F28-AC4, N01-AC2);
 *   - a moving merge base and a provider review requesting changes are refusals naming the
 *     unmet precondition, with nothing written and the authorization untouched (F28-AC1,
 *     F26-AC5);
 *   - a release is `Released` only on a confirmed destination and a satisfied smoke
 *     requirement, and a partial release names every component that did not reach the
 *     destination (F28-AC2, F28-AC3, F29-AC5);
 *   - no receipt is written from an unconfirmed result, a failure produces a typed receipt
 *     carrying the provider's reason, and a second request republishes nothing
 *     (F29-AC2, F29-AC3, F29-AC4);
 *   - the bounded sweep defers what it cannot settle with an exponentially growing delay and
 *     never issues a write (F30-AC4, F30-AC5).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalize, fingerprint, ok } from '@shiploop/domain';
import type {
  AuthorizationSubject,
  CandidateId,
  CommitSha,
  DecisionId,
  EvidenceId,
  DeliveryAction,
  DomainError,
  Fingerprint,
  OwnerId,
  ProjectId,
  ProviderId,
  Result,
  ScopeSnapshot,
  WorkItemId,
} from '@shiploop/domain';
import type {
  AdapterContext,
  DraftBody,
  DraftLinkTarget,
  GitStateRead,
  LiveSmokeRequirement,
  MergePullRequestRequest,
  ReadGitStateRequest,
} from '@shiploop/adapters';
import {
  FIXTURE_BASE_SHA,
  FIXTURE_HEAD_SHA,
  FIXTURE_MERGE_COMMIT_SHA,
  FIXTURE_REPOSITORY,
  FIXTURE_USABLE_DEPLOYMENT,
  createFakeAdapterSet,
} from '@shiploop/adapters';
import type { AdapterSet } from '@shiploop/adapters';
import { buildEvidencePack } from '@shiploop/verification';
import type { EvidenceRecord } from '@shiploop/verification';
import {
  CandidateRepository,
  OwnerDecisionRepository,
  OwnerRepository,
  ProcedureRepository,
  ProjectProfileRepository,
  ScopeRepository,
  WorkItemRepository,
  createOperationStore,
  migrate,
  openDatabase,
} from '@shiploop/storage';
import type { Database, ProfilePolicy, ProjectProfileContent } from '@shiploop/storage';
import { RECIPE_SUBJECT_KEY } from './profiles.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';
import { SqliteObservationJournal } from './verification.ts';
import { createAcceptanceUseCases } from './acceptance.ts';
import { createDeliveryUseCases, SqliteDeliveryJournal, componentOperationId, deliveryOperationId } from './delivery.ts';
import type {
  AuthorizationRecord,
  DeliveryGit,
  DeliveryUseCases,
  ReleaseReceipt,
} from './delivery.ts';

const T0 = '2026-10-01T09:00:00.000Z';
const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-01T11:00:00.000Z';
const T3 = '2026-10-01T12:00:00.000Z';
// Sweep instants one base interval apart after the lost response at T2, so the reported
// backoff is observable rather than already capped.
const S1 = '2026-10-01T11:01:00.000Z';
const S2 = '2026-10-01T11:02:00.000Z';
const S3 = '2026-10-01T11:03:00.000Z';
const S4 = '2026-10-01T11:04:00.000Z';
const S5 = '2026-10-01T11:05:00.000Z';

const PROJECT = 'proj-delivery' as ProjectId;
const OWNER = 'owner-delivery' as OwnerId;
const ISSUE_IDENTIFIER = 'SHIP-510';
const RECIPE_ID = 'recipe-delivery';
const DESTINATION = 'https://delivery.production.invalid';
const CORRELATION = 'correlation-delivery';
const ADVANCED_BASE = 'e2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3' as CommitSha;
const MOVED_HEAD = 'f3e2d1c0b9a8f7e6d5c4b3a29180f7e6d5c4b3a2' as CommitSha;
const MOVED_TARGET = '0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d' as CommitSha;

const CRITERION_AUTOMATED = 'AC-1';
const CRITERION_OWNER = 'AC-2';

const OWNER_ACTOR: OwnerActor = {
  actorId: OWNER,
  role: 'Owner',
  ownerId: OWNER,
  sessionId: 'session-delivery' as OwnerActor['sessionId'],
};

const CODING_ACTOR: OwnerActor = {
  actorId: 'agent-coding',
  role: 'CodingAgent',
  ownerId: null,
  sessionId: null,
};

const MERGE_ACTION: DeliveryAction = { kind: 'Merge', mergeMethod: 'Squash' };
const RELEASE_ACTION: DeliveryAction = { kind: 'Release', destination: DESTINATION };

function unwrap<T>(result: Result<T, DomainError>, what: string): T {
  assert.ok(result.ok, `${what} failed: ${result.ok ? '' : result.error.reason}`);
  return result.value;
}

function fingerprintOf(value: unknown): Fingerprint {
  return fingerprint(value);
}

function profileContent(): ProjectProfileContent {
  const policy: ProfilePolicy = {
    requiredChecks: ['pnpm test'],
    deliveryBehavior: 'ManualAuthorizationOnly',
    maxFixPasses: 2,
    workspaceIsolation: 'WorktreeAndDataDirectory',
    capabilityVersion: 1,
  };
  return {
    references: {
      repository: FIXTURE_REPOSITORY.fullName,
      ticketProvider: 'fixture-ticket',
      ticketTeamKey: 'SHIP',
      baseBranch: FIXTURE_REPOSITORY.defaultBranch,
      targetBranch: FIXTURE_REPOSITORY.defaultBranch,
      deploymentProvider: 'fixture-deployment',
      engine: 'fixture-engine',
      previewComponents: [{ component: 'storefront', environment: 'preview' }],
    },
    policy,
    recipe: 'Saved through the recipe use case',
    environment: { runtime: 'node 24', ports: [4300], secretReferences: [] },
  };
}

function scopeFor(workItemId: WorkItemId): ScopeSnapshot {
  return {
    workItemId,
    issueId: 'issue-delivery',
    issueIdentifier: ISSUE_IDENTIFIER,
    title: 'Authorize, merge and release one reviewed change',
    description: 'The owner authorizes an exact action against an exact candidate.',
    providerRevision: 'rev-1',
    priority: 'High',
    dependencyIssueIds: [],
    acceptanceCriteria: [
      { id: CRITERION_AUTOMATED, text: 'The required check passes for the candidate head' },
      { id: CRITERION_OWNER, text: 'The owner accepts the result the checks describe' },
    ],
    retrievedAt: T0,
  };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                      */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly database: Database;
  readonly useCases: DeliveryUseCases;
  readonly adapters: AdapterSet;
  readonly git: DeliveryGit;
  readonly workItemId: WorkItemId;
  readonly candidateId: CandidateId;
  readonly candidateFingerprint: Fingerprint;
  readonly pullRequestId: ProviderId;
  /** Authorizes and consumes an acceptance for the current candidate. */
  accept(): void;
  /**
   * Performs a real authorized merge, which is what a separate post-merge release delivers
   * (F27-AC1, F27-AC2).
   */
  mergeFirst(): Promise<{ readonly authorizationId: DecisionId; readonly deliveryId: string }>;
  authorize(options?: {
    readonly action?: DeliveryAction;
    readonly destination?: string;
    readonly pullRequestId?: string | null;
    readonly targetBranch?: string;
  }): Promise<AuthorizationRecord>;
  /** Every live state read the delivery layer performed, in order. */
  liveReads(): readonly GitStateRead[];
  at(instant: string): void;
  /**
   * The delivery row, read back from the schema.
   *
   * Keyed by either the decision that authorized it or the delivery's own identity, because
   * a separate post-merge release acts on the merge's delivery rather than one of its own
   * (F27-AC2).
   */
  delivery(id: string): { readonly state: string; readonly detail: string | null } | null;
  receipt(deliveryId: string): ReleaseReceipt | null;
  operation(operationId: string): { readonly status: string; readonly detail: string | null } | null;
}

interface HarnessOptions {
  /** Components the candidate carries, in the order the release delivers them. */
  readonly components?: readonly { readonly component: string; readonly deploymentId: string | null; readonly url: string | null }[];
  /** Records the owner acceptance up front, which every authorization needs (F27-AC5). */
  readonly accepted?: boolean;
  /**
   * Rewrites what the provider reports, so a case can make the world move after the owner
   * decided: an advanced base, a review that requests changes, a pull request that is
   * already merged. The fake adapter has no such transitions to drive, and the behaviour
   * under test is the decision this layer makes *from* the read rather than the read itself.
   */
  readonly liveRead?: (read: GitStateRead) => GitStateRead;
}

const DEFAULT_COMPONENTS = [
  { component: 'storefront', deploymentId: FIXTURE_USABLE_DEPLOYMENT.deploymentId, url: FIXTURE_USABLE_DEPLOYMENT.url },
];

async function withHarness(
  options: HarnessOptions,
  body: (harness: Harness) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-controller-delivery-'));
  try {
    const opened = openDatabase(join(directory, 'shiploop.sqlite'));
    assert.ok(opened.ok, `the real database opened: ${opened.ok ? '' : opened.error.reason}`);
    const database = opened.value;
    assert.ok(migrate(database).ok, 'the real schema migrated');

    const owners = new OwnerRepository(database);
    const profiles = new ProjectProfileRepository(database);
    const procedures = new ProcedureRepository(database);
    const workItems = new WorkItemRepository(database);
    const scope = new ScopeRepository(database);
    const candidates = new CandidateRepository(database);
    const decisions = new OwnerDecisionRepository(database);
    const journal = new SqliteObservationJournal(database);
    const operations = createOperationStore({ connection: database });

    unwrap(owners.provision(OWNER, 'ShipLoop owner', T0), 'provision the owner');
    const profile = unwrap(
      profiles.saveVersion({
        projectId: PROJECT,
        content: profileContent(),
        note: null,
        createdAt: T0,
        createdBy: OWNER,
        expectedVersionNumber: null,
      }),
      'save the project profile',
    );
    const procedure = unwrap(
      procedures.appendVersion({
        projectId: PROJECT,
        subjectKey: RECIPE_SUBJECT_KEY,
        kind: 'Procedure',
        scope: 'Environment',
        source: 'Owner',
        sourceRevision: '1',
        content: canonicalize({ recipeId: RECIPE_ID, version: 1 }),
        status: 'Accepted',
        createdAt: T0,
        createdBy: OWNER,
        note: null,
        expectedVersionNumber: null,
      }),
      'append the environment recipe',
    );

    const workItem = unwrap(
      workItems.create({
        projectId: PROJECT,
        profileVersionId: profile.profileVersionId,
        source: 'CapturedIdea',
        title: 'Authorize, merge and release one reviewed change',
        externalIssueId: 'issue-delivery',
        externalIssueIdentifier: ISSUE_IDENTIFIER,
        externalIssueUrl: 'https://linear.invalid/issue/SHIP-510',
        publicationIntent: 'Published',
        relatedWorkItemIds: [],
        adoption: null,
        at: T0,
      }),
      'create the work item',
    );
    const snapshot = unwrap(
      scope.capture({
        scope: scopeFor(workItem.workItemId),
        attemptId: null,
        profileVersionId: profile.profileVersionId,
        procedureVersionId: procedure.procedureVersionId,
        capturedAt: T0,
        correlationId: CORRELATION,
      }),
      'capture the scope snapshot',
    );

    const components = options.components ?? DEFAULT_COMPONENTS;
    const identity = {
      headSha: FIXTURE_HEAD_SHA,
      baseSha: FIXTURE_BASE_SHA,
      scopeFingerprint: snapshot.scopeFingerprint,
      profileVersionId: profile.profileVersionId,
      procedureVersionId: procedure.procedureVersionId,
      environmentFingerprint: fingerprintOf({ environment: 'node 24' }),
      policyFingerprint: profile.contentFingerprint,
      components: components.map((entry) => ({
        component: entry.component,
        deploymentId: entry.deploymentId,
        deploymentUrl: entry.url,
        environment: 'preview',
      })),
    };
    const candidate = unwrap(
      candidates.record({
        attemptId: null,
        workItemId: workItem.workItemId,
        identity,
        pullRequestId: null,
        targetBranch: FIXTURE_REPOSITORY.defaultBranch,
        recordedAt: T0,
        correlationId: CORRELATION,
      }),
      'record the candidate',
    );

    // A real open pull request exists at the candidate head, because a merge authorization
    // has to name one and the provider's precondition needs a draft to merge.
    const adapters = createFakeAdapterSet();
    const draftContext: AdapterContext = {
      correlationId: CORRELATION,
      operationId: 'op:draft' as MergePullRequestRequest['operationId'],
      clock: { now: () => T0, elapsedMs: () => 0 },
      logger: { emit: () => undefined },
      signal: new AbortController().signal,
      redact: (text: string) => text,
    };
    const link: DraftLinkTarget = { kind: 'None', reason: 'The fixture link is not under test here.' };
    const draftBody: DraftBody = {
      managedMarker: 'shiploop:managed:op:draft',
      purpose: 'Carry the reviewed change for the delivery gate.',
      scope: 'One reviewed change.',
      criteria: [],
      knownGaps: [],
      verification: { kind: 'NotRun', reason: 'The checks are covered by their own cases.' },
      linkedWork: link,
      managedProgressRegion: null,
    };
    const draft = unwrap(
      await adapters.git.upsertDraft(draftContext, {
        operationId: draftContext.operationId,
        repository: FIXTURE_REPOSITORY,
        baseBranch: FIXTURE_REPOSITORY.defaultBranch,
        headSha: FIXTURE_HEAD_SHA,
        existingDraft: null,
        title: 'Authorize, merge and release one reviewed change',
        body: draftBody,
        link,
      }),
      'open the pull request under test',
    );
    const pullRequestId =
      draft.kind === 'Created' || draft.kind === 'Updated' || draft.kind === 'RecoveredAfterLostResponse'
        ? draft.draft.pullRequest.pullRequestId
        : draft.draft.pullRequest.pullRequestId;

    let instant = T0;
    const clock: ControllerClock = { now: () => instant };
    const acceptance = createAcceptanceUseCases({ clock, decisions, candidates, evidence: journal, scope: { latestScopeSnapshot: (id) => workItems.latestScopeSnapshot(id) } });
    const reads: GitStateRead[] = [];
    const git: DeliveryGit = {
      async readState(context: AdapterContext, request: ReadGitStateRequest) {
        const read = await adapters.git.readState(context, request);
        if (!read.ok) return read;
        reads.push(read.value);
        return ok(options.liveRead === undefined ? read.value : options.liveRead(read.value));
      },
      mergePullRequest: (context: AdapterContext, request: MergePullRequestRequest) =>
        adapters.git.mergePullRequest(context, request),
    };
    // One journal over the real schema, shared by both use cases, so the rows a test reads
    // are the rows the use cases wrote.
    const deliveryJournal = new SqliteDeliveryJournal(database);
    const bound = createDeliveryUseCases({
      clock,
      decisions,
      candidates,
      journal: deliveryJournal,
      operations,
      git,
      deployments: adapters.deployment,
      acceptance,
      authorizationTtlMs: 24 * 60 * 60_000,
    });

    // The criterion evidence an acceptance needs, written through the real journal.
    const accept = (): void => {
      unwrap(
        journal.recordCheck({
          candidate,
          record: {
            checkId: 'check-1',
            name: 'check-1',
            origin: 'ProviderCi',
            required: true,
            result: 'Passed',
            candidateFingerprint: candidate.candidateFingerprint,
            startedAt: T0,
            endedAt: T1,
            exitCode: 0,
            artifactRef: 'artifact://delivery/check-1.log',
            detail: 'The check exited 0.',
            notApplicableApprovedByPolicy: false,
          },
          correlationId: CORRELATION,
        }),
        'record the required check',
      );
      const observe = (criterionId: string, method: 'AutomatedCheck' | 'OwnerTest'): void => {
        const requirement = snapshot.acceptanceCriteria.find((entry) => entry.id === criterionId);
        assert.ok(requirement !== undefined, `criterion ${criterionId} is in the captured scope`);
        const built = buildDeliveryEvidencePack({
          criterionId,
          text: requirement.text,
          method,
          identity,
        });
        for (const record of built.records) {
          unwrap(
            journal.recordCriterion({
              candidate,
              bundleFingerprint: candidate.candidateFingerprint,
              record,
              recordedAt: T1,
              correlationId: CORRELATION,
            }),
            `record the verdict for ${criterionId}`,
          );
        }
      };
      observe(CRITERION_AUTOMATED, 'AutomatedCheck');
      observe(CRITERION_OWNER, 'OwnerTest');
      unwrap(
        acceptance.recordAcceptance({
          candidateId: candidate.candidateId,
          actor: OWNER_ACTOR,
          note: null,
          correlationId: CORRELATION,
        }),
        'record the owner acceptance',
      );
    };
    if (options.accepted !== false) accept();

    const harness: Harness = {
      database,
      useCases: bound,
      adapters,
      git,
      workItemId: workItem.workItemId,
      candidateId: candidate.candidateId,
      candidateFingerprint: candidate.candidateFingerprint,
      pullRequestId,
      accept,
      mergeFirst: async () => {
        instant = T1;
        const record = await bound.authorizeDelivery({
          candidateId: candidate.candidateId,
          actor: OWNER_ACTOR,
          action: MERGE_ACTION,
          destination: DESTINATION,
          pullRequestId,
          targetBranch: FIXTURE_REPOSITORY.defaultBranch,
          repository: FIXTURE_REPOSITORY,
          correlationId: CORRELATION,
        });
        assert.ok(record.ok, `the merge is authorized: ${record.ok ? '' : record.error.reason}`);
        instant = T2;
        const merged = await bound.executeMerge({
          authorizationId: record.value.authorizationId,
          actor: OWNER_ACTOR,
          correlationId: CORRELATION,
        });
        assert.ok(merged.ok, `the merge is performed: ${merged.ok ? '' : merged.error.reason}`);
        instant = T3;
        return { authorizationId: record.value.authorizationId, deliveryId: record.value.deliveryId };
      },
      authorize: async (overrides = {}) => {
        const action = overrides.action ?? MERGE_ACTION;
        return unwrap(
          await bound.authorizeDelivery({
            candidateId: candidate.candidateId,
            actor: OWNER_ACTOR,
            action,
            destination: overrides.destination ?? DESTINATION,
            pullRequestId:
              overrides.pullRequestId === undefined
                ? action.kind === 'Release' || action.kind === 'RecoveryRedeploy'
                  ? null
                  : pullRequestId
                : overrides.pullRequestId,
            targetBranch: overrides.targetBranch ?? FIXTURE_REPOSITORY.defaultBranch,
            repository: FIXTURE_REPOSITORY,
            correlationId: CORRELATION,
          }),
          'authorize the delivery',
        );
      },
      liveReads: () => reads,
      at: (value) => {
        instant = value;
      },
      delivery: (id) => {
        const row = database
          .prepare('SELECT state, failure_detail_redacted FROM deliveries WHERE decision_id = ? OR delivery_id = ?')
          .get(id, id);
        if (row === undefined) return null;
        const detail = row['failure_detail_redacted'];
        return { state: String(row['state']), detail: typeof detail === 'string' ? detail : null };
      },
      receipt: (deliveryId) => {
        const row = database.prepare('SELECT receipt_json FROM release_receipts WHERE delivery_id = ?').get(deliveryId);
        if (row === undefined) return null;
        const json = row['receipt_json'];
        return typeof json === 'string' ? (JSON.parse(json) as ReleaseReceipt) : null;
      },
      operation: (operationId) => {
        const row = database
          .prepare('SELECT status, outcome_detail FROM external_operations WHERE operation_id = ?')
          .get(operationId);
        if (row === undefined) return null;
        const detail = row['outcome_detail'];
        return { status: String(row['status']), detail: typeof detail === 'string' ? detail : null };
      },
    };
    await body(harness);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The subject an authorization is bound to, read back from the durable row.
 *
 * Parsed as the domain type rather than as an open record, so a mutation a case applies is
 * checked against the shape the check will actually compare (F27-AC3).
 */
function subjectOf(harness: Harness, authorizationId: DecisionId): AuthorizationSubject {
  const row = harness.database
    .prepare('SELECT subject_json FROM owner_decisions WHERE decision_id = ?')
    .get(authorizationId);
  assert.ok(row !== undefined, `the authorization ${authorizationId} is durable`);
  return JSON.parse(String(row['subject_json'])) as AuthorizationSubject;
}

/** The live smoke requirement a release must satisfy before it is `Released` (F28-AC2). */
function smokeRequirement(components: readonly string[]): LiveSmokeRequirement {
  return {
    kind: 'Required',
    probes: components.map((component) => ({
      probeId: `probe_${component}`,
      component,
      url: `https://production.fixture.invalid/${component}`,
      expectStatus: 200,
      expectBodyContains: `${component} is serving`,
      environment: 'Production' as const,
    })),
  };
}

/** The criterion verdict one fixture observation records, built by the real pack builder. */
function buildDeliveryEvidencePack(input: {
  readonly criterionId: string;
  readonly text: string;
  readonly method: 'AutomatedCheck' | 'OwnerTest';
  readonly identity: {
    readonly headSha: CommitSha;
    readonly baseSha: CommitSha;
    readonly scopeFingerprint: Fingerprint;
    readonly profileVersionId: string;
    readonly procedureVersionId: string;
    readonly environmentFingerprint: Fingerprint;
    readonly policyFingerprint: Fingerprint;
    readonly components: readonly {
      readonly component: string;
      readonly deploymentId: string | null;
      readonly deploymentUrl: string | null;
      readonly environment: string;
    }[];
  };
}): { readonly records: readonly EvidenceRecord[] } {
  const built = buildEvidencePack({
    bundleId: `bundle-${input.criterionId}`,
    correlationId: CORRELATION,
    identity: input.identity,
    eligiblePreview: null,
    requirements: [
      {
        criterionId: input.criterionId,
        text: input.text,
        method: input.method === 'OwnerTest' ? { kind: 'OwnerTest', instructions: input.text } : { kind: 'AutomatedCheck', checkId: 'check-1' },
        requiresDeployedObservation: false,
      },
    ],
    observations: [
      {
        criterionId: input.criterionId,
        evidenceId: `evid-${input.criterionId}` as EvidenceId,
        observation: 'BehaviorConfirmed',
        environment: 'Local',
        capturedAt: T1,
        component: null,
        deploymentId: null,
        artifacts: [],
        apiExchange: null,
        detail: 'The owner observed the behaviour.',
      },
    ],
  });
  assert.ok(built.ok, `the evidence pack for ${input.criterionId} builds`);
  return built.value;
}

/* -------------------------------------------------------------------------- */
/* F26-AC1, F27-AC1, F27-AC3: what an authorization is bound to                */
/* -------------------------------------------------------------------------- */

test('F26-AC1: an authorization is recorded as a single-use decision bound to the action, destination, pull request, head, target branch, candidate fingerprint and component deployment ids', async () => {
  await withHarness({}, async (h) => {
    h.at(T1);
    const record = await h.authorize();

    assert.equal(record.state, 'Authorized');
    assert.equal(record.singleUse, true);
    assert.equal(record.ownerId, OWNER);
    assert.equal(record.issuedAt, T1);
    assert.equal(record.pullRequestId, h.pullRequestId);
    assert.equal(record.headSha, FIXTURE_HEAD_SHA);
    assert.equal(record.destination, DESTINATION);
    assert.equal(record.candidateFingerprint, h.candidateFingerprint);
    assert.equal(record.subjectFingerprint.length > 0, true);

    // The durable row is bound to a real candidate and a real owner, and the storage
    // repository's own schema CHECK is what refuses an authorization without a subject
    // fingerprint (F26-AC1, R3).
    const row = h.database
      .prepare(
        `SELECT d.decision_type, d.subject_fingerprint, d.single_use, d.state, d.expires_at,
                o.owner_id, c.candidate_id
           FROM owner_decisions d
           JOIN owners o ON o.owner_id = d.actor_owner_id
           JOIN candidates c ON c.candidate_id = d.candidate_id
          WHERE d.decision_id = ?`,
      )
      .get(record.authorizationId);
    assert.ok(row !== undefined, 'the authorization is durable and attributable');
    assert.equal(row['decision_type'], 'AuthorizeMerge');
    assert.equal(row['subject_fingerprint'], record.subjectFingerprint);
    assert.equal(row['single_use'], 1, 'the single-use invariant is the schema\'s, not a convention');
    assert.equal(row['state'], 'Recorded');
    assert.equal(row['owner_id'], OWNER);

    const stored = h.database
      .prepare('SELECT subject_json FROM owner_decisions WHERE decision_id = ?')
      .get(record.authorizationId);
    const parsed = JSON.parse(String(stored?.['subject_json'])) as {
      action: { kind: string; mergeMethod: string };
      destination: string;
      pullRequestId: string;
      headSha: string;
      targetBranch: string;
      candidateFingerprint: string;
      componentDeployments: readonly { component: string; deploymentId: string | null }[];
    };
    assert.equal(parsed.action.mergeMethod, 'Squash');
    assert.equal(parsed.destination, DESTINATION);
    assert.equal(parsed.pullRequestId, h.pullRequestId);
    assert.equal(parsed.headSha, FIXTURE_HEAD_SHA);
    assert.equal(parsed.candidateFingerprint, h.candidateFingerprint);
    assert.deepEqual(parsed.componentDeployments, [
      { component: 'storefront', deploymentId: FIXTURE_USABLE_DEPLOYMENT.deploymentId },
    ]);

    // The delivery row exists for this authorization and names the same operation identity
    // the ledger will refuse to write twice (F28-AC4).
    assert.equal(h.delivery(record.authorizationId)?.state, 'Authorized');
    assert.equal(record.operationId, deliveryOperationId(record.authorizationId, 'Merge'));
  });
});

test('F27-AC3: changing the action, the destination, the head, the target branch or a component deployment invalidates an unconsumed authorization', async () => {
  const mutations: readonly {
    readonly what: string;
    readonly mutate: (subject: AuthorizationSubject) => AuthorizationSubject;
  }[] = [
    {
      what: 'the merge method',
      mutate: (subject) => ({ ...subject, action: { kind: 'Merge', mergeMethod: 'Rebase' } }),
    },
    {
      what: 'the destination',
      mutate: (subject) => ({ ...subject, destination: 'https://somewhere-else.invalid' }),
    },
    { what: 'the head', mutate: (subject) => ({ ...subject, headSha: 'a'.repeat(40) }) },
    {
      what: 'the target branch',
      mutate: (subject) => ({ ...subject, targetBranch: 'release/2026-10' }),
    },
    {
      what: 'a component deployment',
      mutate: (subject) => ({
        ...subject,
        componentDeployments: [{ component: 'storefront', deploymentId: 'dep_replaced' }],
      }),
    },
  ];

  for (const mutation of mutations) {
    await withHarness({}, async (h) => {
      h.at(T1);
      const record = await h.authorize();
      const subject = mutation.mutate(subjectOf(h, record.authorizationId));

      const refused = h.useCases.consumeDeliveryAuthorization({
        authorizationId: record.authorizationId,
        actor: OWNER_ACTOR,
        proposed: subject,
        correlationId: CORRELATION,
      });
      assert.equal(refused.ok, false, `changing ${mutation.what} invalidates the authorization`);
      if (!refused.ok) {
        assert.equal(refused.error.code, 'Conflict');
        assert.match(refused.error.reason, /SubjectChanged/);
        assert.match(refused.error.reason, /bound to head/);
      }

      // The decision is still on record and still unconsumed: it is recorded but no longer
      // usable, which is what lets a reconciliation say why (F27-AC3).
      const row = h.database
        .prepare('SELECT state, consumed_at FROM owner_decisions WHERE decision_id = ?')
        .get(record.authorizationId);
      assert.equal(row?.['state'], 'Recorded');
      assert.equal(row?.['consumed_at'], null);
    });
  }
});

test('F27-AC5: a delivery cannot be authorized without a current owner acceptance, and a merge-only authorization cannot be executed as a release', async () => {
  await withHarness({ accepted: false }, async (h) => {
    h.at(T1);
    const refused = await h.useCases.authorizeDelivery({
      candidateId: h.candidateId,
      actor: OWNER_ACTOR,
      action: MERGE_ACTION,
      destination: DESTINATION,
      pullRequestId: h.pullRequestId,
      targetBranch: FIXTURE_REPOSITORY.defaultBranch,
      repository: FIXTURE_REPOSITORY,
      correlationId: CORRELATION,
    });
    assert.equal(refused.ok, false, 'nothing is authorizable before the owner accepted');
    if (!refused.ok) {
      assert.equal(refused.error.code, 'Blocked');
      assert.match(refused.error.reason, /F25-AC1, F27-AC5/);
    }

    const byAgent = await h.useCases.authorizeDelivery({
      candidateId: h.candidateId,
      actor: CODING_ACTOR,
      action: MERGE_ACTION,
      destination: DESTINATION,
      pullRequestId: h.pullRequestId,
      targetBranch: FIXTURE_REPOSITORY.defaultBranch,
      repository: FIXTURE_REPOSITORY,
      correlationId: CORRELATION,
    });
    assert.equal(byAgent.ok, false, 'no other role may bind a production-changing action');
    if (!byAgent.ok) assert.equal(byAgent.error.code, 'Forbidden');

    assert.equal(h.database.prepare('SELECT COUNT(*) AS n FROM deliveries').get()?.['n'], 0);
  });

  await withHarness({}, async (h) => {
    h.at(T1);
    const record = await h.authorize();
    const asRelease = await h.useCases.executeRelease({
      authorizationId: record.authorizationId,
      actor: OWNER_ACTOR,
      correlationId: CORRELATION,
    });
    assert.equal(asRelease.ok, false);
    if (!asRelease.ok) {
      assert.equal(asRelease.error.code, 'Invalid');
      assert.match(asRelease.error.reason, /F27-AC2, F27-AC5/);
    }
    // Nothing was written and the authorization is untouched, so a merge is still possible.
    assert.equal(h.delivery(record.authorizationId)?.state, 'Authorized');
    assert.equal(
      h.database.prepare('SELECT state FROM owner_decisions WHERE decision_id = ?').get(record.authorizationId)?.['state'],
      'Recorded',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* F26-AC2, F26-AC3, F27-AC2: the live read and the single use                 */
/* -------------------------------------------------------------------------- */

test('F26-AC2: the authorization is checked against live provider state read immediately before the write, and a head that moved is refused by name', async () => {
  let head = FIXTURE_HEAD_SHA;
  await withHarness(
    {
      liveRead: (read) => ({
        ...read,
        head: read.head.kind === 'Branch' ? { ...read.head, sha: head } : read.head,
      }),
    },
    async (h) => {
    h.at(T1);
    const record = await h.authorize();
    const readsAfterAuthorization = h.liveReads().length;
    assert.ok(readsAfterAuthorization > 0, 'authorizing itself reads live state (F26-AC2)');

    // The provider head moves after the owner decided. The delivery reads live state again
    // rather than trusting the value the authorization carries (F26-AC2).
    head = MOVED_HEAD;
    h.at(T2);
    const refused = await h.useCases.executeMerge({
      authorizationId: record.authorizationId,
      actor: OWNER_ACTOR,
      correlationId: CORRELATION,
    });
    assert.ok(h.liveReads().length > readsAfterAuthorization, 'the write path re-read live state');
    assert.equal(refused.ok, false, 'a moved head is refused rather than merged');
    if (!refused.ok) {
      assert.equal(refused.error.code, 'Blocked');
      const named = refused.error.prerequisites.map((entry) => entry.name);
      assert.deepEqual(named, ['Expected head']);
      assert.match(refused.error.prerequisites[0]?.detail ?? '', /F25-AC3, F26-AC2/);
    }

    // The refusal is a refusal: no provider write, no consumed authorization, and no
    // operation row at all.
    assert.equal(h.delivery(record.authorizationId)?.state, 'Authorized');
    assert.equal(
      h.database.prepare('SELECT state FROM owner_decisions WHERE decision_id = ?').get(record.authorizationId)?.['state'],
      'Recorded',
    );
    assert.equal(h.operation(record.operationId), null, 'no intent was recorded for a refused precondition');
    assert.equal(h.adapters.effects.count(), 1, 'only the draft creation reached the provider');
    },
  );
});

test('F26-AC3: a second consumption is refused with AlreadyConsumed, and the row records the consuming owner and the instant', async () => {
  await withHarness({}, async (h) => {
    h.at(T1);
    const record = await h.authorize();
    const proposed = subjectOf(h, record.authorizationId);

    h.at(T2);
    const first = unwrap(
      h.useCases.consumeDeliveryAuthorization({
        authorizationId: record.authorizationId,
        actor: OWNER_ACTOR,
        proposed,
        correlationId: CORRELATION,
      }),
      'consume the authorization once',
    );
    assert.equal(first.state, 'Consumed');
    assert.equal(first.consumedAt, T2);

    h.at(T3);
    const second = h.useCases.consumeDeliveryAuthorization({
      authorizationId: record.authorizationId,
      actor: OWNER_ACTOR,
      proposed,
      correlationId: CORRELATION,
    });
    assert.equal(second.ok, false, 'a single-use authorization cannot be spent twice');
    if (!second.ok) {
      assert.equal(second.error.code, 'Conflict');
      assert.match(second.error.reason, /AlreadyConsumed/);
      assert.equal(second.error.code === 'Conflict' ? second.error.actual : null, 'Consumed');
    }

    const row = h.database
      .prepare('SELECT state, consumed_at, actor_owner_id FROM owner_decisions WHERE decision_id = ?')
      .get(record.authorizationId);
    assert.equal(row?.['state'], 'Consumed');
    assert.equal(row?.['consumed_at'], T2, 'the consuming instant is durable (F26-AC5)');
    assert.equal(row?.['actor_owner_id'], OWNER);

    // A second owner's call is refused as a permission problem, not as a spent permission.
    const otherOwner = { actorId: 'other', role: 'Owner' as const, ownerId: 'owner-other' as OwnerId, sessionId: null };
    const byOther = h.useCases.consumeDeliveryAuthorization({
      authorizationId: record.authorizationId,
      actor: otherOwner,
      proposed,
      correlationId: CORRELATION,
    });
    assert.equal(byOther.ok, false);
  });
});

/* -------------------------------------------------------------------------- */
/* F28-AC1, F28-AC3, F28-AC4, N01-AC2: the merge write and a lost response      */
/* -------------------------------------------------------------------------- */

test('F26-AC4: a confirmed merge records the provider merge commit and the content relation to the tested candidate', async () => {
  await withHarness({}, async (h) => {
    h.at(T1);
    const record = await h.authorize();
    h.at(T2);
    const merged = unwrap(
      await h.useCases.executeMerge({ authorizationId: record.authorizationId, actor: OWNER_ACTOR, correlationId: CORRELATION }),
      'merge the authorized change',
    );

    assert.equal(merged.state, 'Merged');
    assert.equal(merged.disposition, 'Merged');
    assert.equal(merged.mergeCommitSha, FIXTURE_MERGE_COMMIT_SHA);
    assert.equal(merged.contentRelation.kind, 'MatchesAuthorizedHead');
    assert.equal(merged.precondition.kind, 'ProviderExpectedHead');
    assert.equal(merged.precondition.kind === 'ProviderExpectedHead' ? merged.precondition.expectedHeadSha : null, FIXTURE_HEAD_SHA);
    assert.equal(merged.consumedAuthorization.state, 'Consumed');

    const row = h.database
      .prepare('SELECT state, merged_at, manifest_json FROM deliveries WHERE decision_id = ?')
      .get(record.authorizationId);
    assert.equal(row?.['state'], 'Merged');
    assert.equal(row?.['merged_at'], T2);
    const manifest = JSON.parse(String(row?.['manifest_json'])) as { mergeCommitSha: string };
    assert.equal(manifest.mergeCommitSha, FIXTURE_MERGE_COMMIT_SHA, 'the provider merge commit is on the manifest (F26-AC4)');
    assert.equal(h.operation(record.operationId)?.status, 'Succeeded');
  });
});

test('F28-AC4: a lost merge response becomes OutcomeUnknown, a repeat never reaches the provider again, and reconciliation settles the delivery once by reading the target', async () => {
  await withHarness({}, async (h) => {
    h.at(T1);
    const record = await h.authorize();
    const writesBefore = h.adapters.effects.count();

    h.at(T2);
    h.adapters.conditions.loseNextWriteResponse(1);
    const lost = await h.useCases.executeMerge({
      authorizationId: record.authorizationId,
      actor: OWNER_ACTOR,
      correlationId: CORRELATION,
    });
    assert.equal(lost.ok, false, 'a lost response is not a success');
    if (!lost.ok) {
      assert.equal(lost.error.code, 'OutcomeUnknown');
      assert.equal(lost.error.operationId, record.operationId);
    }
    assert.equal(h.delivery(record.authorizationId)?.state, 'OutcomeUnknown');
    assert.equal(h.operation(record.operationId)?.status, 'OutcomeUnknown');
    assert.equal(h.adapters.effects.count(), writesBefore + 1, 'exactly one write reached the provider');

    // A repeat is refused by the ledger before the provider is consulted at all.
    h.at(T3);
    const repeat = await h.useCases.executeMerge({
      authorizationId: record.authorizationId,
      actor: OWNER_ACTOR,
      correlationId: CORRELATION,
    });
    assert.equal(repeat.ok, false);
    if (!repeat.ok) assert.equal(repeat.error.code, 'OutcomeUnknown');
    assert.equal(h.adapters.effects.count(), writesBefore + 1, 'the second attempt never reached the provider');
    assert.equal(h.adapters.git.attempts('mergePullRequest'), 1, 'the adapter was asked once');

    // Reconciliation reads the target. The provider still reports the pull request open at
    // the authorized head, so the write provably did not reach it (F28-AC4).
    const reconciled = unwrap(
      await h.useCases.reconcileDelivery({
        operationId: record.operationId,
        resolvedBy: 'test-reconciler',
        correlationId: CORRELATION,
      }),
      'reconcile the lost response',
    );
    assert.equal(reconciled.resolution, 'DidNotHappen');
    assert.equal(h.delivery(record.authorizationId)?.state, 'Failed');
    assert.equal(h.operation(record.operationId)?.status, 'Failed');
    assert.equal(h.adapters.effects.count(), writesBefore + 1, 'reconciliation issued no write');

    // A settled delivery is not reconciled again: nothing is in doubt, and re-recording a
    // resolution would overwrite the fact that settled it.
    const again = await h.useCases.reconcileDelivery({
      operationId: record.operationId,
      resolvedBy: 'test-reconciler',
      correlationId: CORRELATION,
    });
    assert.equal(again.ok, false, 'reconciliation settles an operation once');
    if (!again.ok) assert.equal(again.error.code, 'Conflict');
  });
});

test('F28-AC4: a lost merge response the provider did apply is settled as Merged from the live read, and the repeat never reached the provider', async () => {
  // The provider merged before the response was lost, and now reports the pull request
  // merged. That read is the fact reconciliation settles on, and the merge is never
  // repeated to find out (F28-AC4).
  let merged = false;
  let targetMoved = false;
  await withHarness(
    {
      liveRead: (read) => ({
        ...read,
        pullRequest:
          merged && read.pullRequest !== null ? { ...read.pullRequest, state: 'Merged' as const } : read.pullRequest,
        head: targetMoved && read.head.kind === 'Branch' ? { ...read.head, sha: MOVED_TARGET } : read.head,
      }),
    },
    async (h) => {
      h.at(T1);
      const record = await h.authorize();
      h.at(T2);
      h.adapters.conditions.loseNextWriteResponse(1);
      const lost = await h.useCases.executeMerge({
        authorizationId: record.authorizationId,
        actor: OWNER_ACTOR,
        correlationId: CORRELATION,
      });
      assert.equal(lost.ok, false, 'a lost response is not a success');
      assert.equal(h.delivery(record.authorizationId)?.state, 'OutcomeUnknown');
      const writes = h.adapters.effects.count();
      assert.equal(h.adapters.git.attempts('mergePullRequest'), 1);

      // The target moved while the pull request stayed open, so somebody else changed it
      // and this read establishes neither outcome. The delivery is left exactly as blocked
      // as it was, because the write may still have landed (F30-AC3, F30-AC5).
      targetMoved = true;
      const premature = unwrap(
        await h.useCases.reconcileDelivery({
          operationId: record.operationId,
          resolvedBy: 'test-reconciler',
          correlationId: CORRELATION,
        }),
        'reconcile before the provider reports anything',
      );
      assert.equal(premature.resolution, 'StillUnknown');
      assert.equal(h.delivery(record.authorizationId)?.state, 'OutcomeUnknown');
      assert.equal(h.operation(record.operationId)?.status, 'OutcomeUnknown');

      merged = true;
      targetMoved = false;
      const settled = unwrap(
        await h.useCases.reconcileDelivery({
          operationId: record.operationId,
          resolvedBy: 'test-reconciler',
          correlationId: CORRELATION,
        }),
        'reconcile the applied merge',
      );
      assert.equal(settled.resolution, 'DidHappen');
      assert.equal(settled.state, 'Merged');
      assert.match(settled.detail, /as Merged/);
      assert.equal(h.delivery(record.authorizationId)?.state, 'Merged');
      assert.equal(h.operation(record.operationId)?.status, 'Succeeded');
      assert.equal(h.adapters.effects.count(), writes, 'reconciliation issued no second write');
      assert.equal(h.adapters.git.attempts('mergePullRequest'), 1, 'the merge was never repeated');
    },
  );
});

/* -------------------------------------------------------------------------- */
/* F28-AC1, F26-AC5: refusals name the unmet precondition                      */
/* -------------------------------------------------------------------------- */

test('F28-AC1: a moving merge base is a refusal naming the precondition, and nothing is written', async () => {
  let advanced = false;
  await withHarness(
    {
      liveRead: (read) =>
        advanced && read.base.kind === 'Branch'
          ? { ...read, base: { kind: 'Branch' as const, name: read.base.name, sha: ADVANCED_BASE } }
          : read,
    },
    async (h) => {
    h.at(T1);
    const record = await h.authorize();
    const writesBefore = h.adapters.effects.count();

    // The base the candidate was tested against advances after the owner decided, which is
    // the precondition case worth reading: what would merge is no longer what was tested.
    advanced = true;
    h.at(T2);
    const refused = await h.useCases.executeMerge({
      authorizationId: record.authorizationId,
      actor: OWNER_ACTOR,
      correlationId: CORRELATION,
    });
    assert.equal(refused.ok, false, 'a moving base is refused, not merged and not failed');
    if (!refused.ok) {
      assert.equal(refused.error.code, 'Blocked', 'a refusal, not a failure');
      const base = refused.error.prerequisites.find((entry) => entry.name === 'Merge base');
      assert.ok(base !== undefined, 'the unmet precondition is named');
      assert.match(base.detail, /The base advanced to/);
      assert.match(base.remedy, /not an error to retry through/);
    }
    assert.equal(h.delivery(record.authorizationId)?.state, 'Authorized', 'the delivery did not move');
    assert.equal(h.operation(record.operationId), null, 'no intent was recorded');
    assert.equal(h.adapters.effects.count(), writesBefore, 'the provider was not written to');
    },
  );
});

test('F26-AC5: owner acceptance does not impersonate a provider-required reviewer', async () => {
  let reviews: GitStateRead['reviews'] = [];
  await withHarness({ liveRead: (read) => ({ ...read, reviews }) }, async (h) => {
    h.at(T1);
    const record = await h.authorize();
    const writesBefore = h.adapters.effects.count();

    h.at(T2);
    reviews = [
      { kind: 'Review', decision: 'ChangesRequested', reviewer: 'provider-reviewer', submittedAt: T1 },
    ];
    const refused = await h.useCases.executeMerge({
      authorizationId: record.authorizationId,
      actor: OWNER_ACTOR,
      correlationId: CORRELATION,
    });
    assert.equal(refused.ok, false, 'a provider review requesting changes blocks the merge');
    if (!refused.ok) {
      assert.equal(refused.error.code, 'Blocked');
      const review = refused.error.prerequisites.find((entry) => entry.name === 'Review by provider-reviewer');
      assert.ok(review !== undefined, 'the blocking reviewer is named');
      assert.match(review.detail, /does not stand in for that reviewer \(F26-AC5\)/);
    }

    reviews = [
      { kind: 'ApprovalRulePending', rule: 'two approvals', detail: 'One more approval is required.' },
    ];
    const blocked = await h.useCases.executeMerge({
      authorizationId: record.authorizationId,
      actor: OWNER_ACTOR,
      correlationId: CORRELATION,
    });
    assert.equal(blocked.ok, false, 'an unmet provider approval rule is a visible blocker (F26-AC5)');
    if (!blocked.ok) {
      assert.equal(blocked.error.code, 'Blocked');
      assert.ok(
        blocked.error.code === 'Blocked' &&
          blocked.error.prerequisites.some((entry) => entry.name === 'Approval rule two approvals'),
        'the rule the provider enforces is named',
      );
    }

    assert.equal(h.adapters.effects.count(), writesBefore, 'no provider write in either case');
  });
});

/* -------------------------------------------------------------------------- */
/* F28-AC2, F28-AC3, F28-AC5, F29-AC5: the release                             */
/* -------------------------------------------------------------------------- */

test('F28-AC2: a release is Released only on a confirmed destination and a satisfied live smoke requirement', async () => {
  await withHarness({}, async (h) => {
    // A separate post-merge release delivers the merge's content, so the merge happens
    // first and the release is authorized against the merged delivery (F27-AC1, F27-AC2).
    await h.mergeFirst();
    h.at(T1);
    const record = await h.authorize({ action: RELEASE_ACTION, pullRequestId: null });
    h.at(T2);
    const released = unwrap(
      await h.useCases.executeRelease({
        authorizationId: record.authorizationId,
        actor: OWNER_ACTOR,
        correlationId: CORRELATION,
        liveSmoke: smokeRequirement(['storefront']),
      }),
      'release the authorized destination',
    );

    assert.equal(released.state, 'Released');
    assert.equal(released.destination, DESTINATION);
    assert.equal(released.headSha, FIXTURE_HEAD_SHA);
    assert.equal(released.releasedAt, T2);
    assert.equal(released.smokeResult, 'Passed');
    assert.deepEqual(released.components.map((entry) => entry.component), ['storefront']);
    assert.equal(h.delivery(record.deliveryId)?.state, 'Released');
    assert.equal(h.operation(componentOperationId(record.operationId, 'storefront'))?.status, 'Succeeded');

    // The component and smoke evidence is durable before the state moved, so a receipt
    // written later reads rows rather than a summary (F29-AC1, F29-AC5).
    const components = h.database
      .prepare('SELECT component, state FROM delivery_components WHERE delivery_id = ?')
      .all(record.deliveryId);
    assert.deepEqual(components.map((row) => [row['component'], row['state']]), [['storefront', 'Released']]);
    const smokes = h.database
      .prepare('SELECT result FROM live_smoke_results WHERE delivery_id = ?')
      .all(record.deliveryId);
    assert.deepEqual(smokes.map((row) => row['result']), ['Passed']);
  });
});

test('F28-AC3: a partial component failure stays Failed and names every component that did not reach the destination', async () => {
  const components = [
    { component: 'storefront', deploymentId: FIXTURE_USABLE_DEPLOYMENT.deploymentId, url: FIXTURE_USABLE_DEPLOYMENT.url },
    { component: 'worker', deploymentId: 'dep_fixture_building', url: 'https://worker.preview.invalid' },
  ];
  await withHarness({ components }, async (h) => {
    await h.mergeFirst();
    h.at(T1);
    const record = await h.authorize({ action: RELEASE_ACTION, pullRequestId: null });
    // The provider accepts the storefront and refuses the worker, which is the partial
    // component failure F28-AC3 is about.
    h.adapters.conditions.programComponentOutcomes({ storefront: 'Usable', worker: 'Failed' });

    h.at(T2);
    const failed = await h.useCases.executeRelease({
      authorizationId: record.authorizationId,
      actor: OWNER_ACTOR,
      correlationId: CORRELATION,
      liveSmoke: smokeRequirement(['storefront', 'worker']),
    });
    assert.equal(failed.ok, false, 'a partial release is not Released');
    if (!failed.ok) {
      assert.equal(failed.error.code, 'Blocked');
      const named = failed.error.prerequisites.map((entry) => entry.name);
      assert.ok(named.includes('worker'), 'the component that did not reach the destination is named');
      assert.equal(named.includes('storefront'), false, 'the component that did is not listed as a failure');
      const worker = failed.error.prerequisites.find((entry) => entry.name === 'worker');
      assert.match(worker?.detail ?? '', /worker/);
    }
    assert.equal(h.delivery(record.deliveryId)?.state, 'Failed');
    assert.match(
      h.delivery(record.deliveryId)?.detail ?? '',
      /Component worker did not reach https:\/\/delivery\.production\.invalid/,
      'the failure names the component that did not arrive (F29-AC5)',
    );

    const rows = h.database
      .prepare('SELECT component, state FROM delivery_components WHERE delivery_id = ? ORDER BY component')
      .all(record.deliveryId);
    assert.deepEqual(
      rows.map((row) => [row['component'], row['state']]),
      [['storefront', 'Released'], ['worker', 'Failed']],
      'the component evidence is durable, not a summary (F29-AC5)',
    );
  });
});

test('F28-AC5: a recovery redeploy is refused without a stated migration reversal, and accepted with one', async () => {
  await withHarness({}, async (h) => {
    await h.mergeFirst();
    h.at(T1);
    const record = await h.authorize({
      action: { kind: 'RecoveryRedeploy', destination: DESTINATION },
      pullRequestId: null,
    });

    h.at(T2);
    const withoutStatement = await h.useCases.executeRelease({
      authorizationId: record.authorizationId,
      actor: OWNER_ACTOR,
      correlationId: CORRELATION,
    });
    assert.equal(withoutStatement.ok, false, 'a reversal cannot be inferred from an omitted field');
    if (!withoutStatement.ok) {
      assert.equal(withoutStatement.error.code, 'Invalid');
      assert.match(withoutStatement.error.reason, /reversing a migration is not a code redeploy \(F28-AC5\)/);
    }
    assert.equal(h.delivery(record.deliveryId)?.state, 'Merged', 'nothing was written');

    const withStatement = unwrap(
      await h.useCases.executeRelease({
        authorizationId: record.authorizationId,
        actor: OWNER_ACTOR,
        correlationId: CORRELATION,
        reversalStatement: 'Roll the billing schema back to revision 3 before redeploying the code.',
      }),
      'release the stated recovery redeploy',
    );
    assert.equal(withStatement.state, 'Released');
  });
});

/* -------------------------------------------------------------------------- */
/* F29: the receipt                                                             */
/* -------------------------------------------------------------------------- */

test('F29-AC1: a receipt records the exact result, the head and base SHAs, the destination, the checks, the deployment identity, the timestamps and the link', async () => {
  await withHarness({}, async (h) => {
    const merged = await h.mergeFirst();
    h.at(T1);
    const record = await h.authorize({ action: RELEASE_ACTION, pullRequestId: null });
    h.at(T2);
    const released = unwrap(
      await h.useCases.executeRelease({
        authorizationId: record.authorizationId,
        actor: OWNER_ACTOR,
        correlationId: CORRELATION,
        liveSmoke: smokeRequirement(['storefront']),
      }),
      'release the authorized destination',
    );

    const checks = [
      { name: 'pnpm test', result: 'Passed', detail: 'All suites passed.' },
      { name: 'pnpm lint', result: 'Passed', detail: null },
    ];
    const written = unwrap(
      h.useCases.releaseReceipt({
        deliveryId: released.deliveryId,
        actor: OWNER_ACTOR,
        link: 'https://delivery.production.invalid/deployments/run-1',
        checks,
        correlationId: CORRELATION,
      }),
      'write the release receipt',
    );
    assert.equal(written.kind, 'Recorded');
    const receipt = written.receipt;

    assert.equal(receipt.outcome, 'Confirmed');
    assert.equal(receipt.deliveryState, 'Released');
    assert.equal(receipt.headSha, FIXTURE_HEAD_SHA);
    assert.equal(receipt.baseSha, FIXTURE_BASE_SHA);
    assert.equal(receipt.mergeSha, FIXTURE_MERGE_COMMIT_SHA, 'the receipt names the commit the provider produced (F26-AC4)');
    assert.equal(receipt.destination, DESTINATION);
    assert.equal(receipt.targetBranch, FIXTURE_REPOSITORY.defaultBranch);
    assert.equal(receipt.pullRequestId, h.pullRequestId);
    assert.deepEqual(receipt.checks, checks, 'the required checks travel with the receipt (F29-AC1)');
    assert.equal(receipt.link, 'https://delivery.production.invalid/deployments/run-1');
    assert.equal(receipt.createdAt, T2);
    assert.equal(receipt.finalizedAt, null, 'closure is pending sync until the publication path confirms it (F29-AC4)');
    assert.equal(receipt.issueClosedAt, null);
    assert.equal(receipt.smokeResult, 'Passed');
    assert.equal(receipt.failureReason, null, 'a confirmed receipt carries no failure reason');
    assert.deepEqual(receipt.releasedComponents, ['storefront']);
    assert.deepEqual(receipt.unreleasedComponents, []);
    assert.deepEqual(receipt.components, [
      {
        component: 'storefront',
        released: true,
        // The deployment the release produced, not the one the candidate was delivered
        // from: F28-AC1 retains the operation and deployment identity, and the receipt is
        // the record a later reader trusts for what is live (F29-AC1).
        deploymentId: released.components[0]?.deploymentId ?? null,
        deploymentUrl: released.components[0]?.url ?? null,
        environment: 'preview',
        smokeResult: 'Passed',
        reason: null,
      },
    ]);
    assert.notEqual(receipt.components[0]?.deploymentId, FIXTURE_USABLE_DEPLOYMENT.deploymentId);

    // The owner decisions the delivery rests on travel with it, so the receipt is a
    // self-contained record rather than a pointer into a table that may change.
    assert.deepEqual(
      receipt.ownerDecisions.map((decision) => decision.decisionType).sort(),
      ['AcceptProduct', 'AuthorizeMerge', 'AuthorizeRelease'],
    );
    assert.equal(
      receipt.ownerDecisions.every((decision) => decision.ownerId === OWNER),
      true,
      'every decision on the receipt is attributable to a real owner (F32-AC1)',
    );
    assert.equal(
      receipt.ownerDecisions.some((decision) => decision.decisionId === merged.authorizationId),
      true,
      'the merge decision is on the receipt',
    );

    // The receipt is durable, and its provider columns agree with the JSON body rather than
    // being a second source of truth.
    const row = h.database
      .prepare(
        `SELECT r.receipt_id, r.merge_sha, r.provider_deployment_ids, r.issue_closed_at, r.finalized_at,
                d.state, d.head_sha
           FROM release_receipts r JOIN deliveries d ON d.delivery_id = r.delivery_id
          WHERE r.delivery_id = ?`,
      )
      .get(released.deliveryId);
    assert.equal(row?.['merge_sha'], FIXTURE_MERGE_COMMIT_SHA);
    assert.deepEqual(JSON.parse(String(row?.['provider_deployment_ids'])), [released.components[0]?.deploymentId]);
    assert.equal(row?.['issue_closed_at'], null);
    assert.equal(row?.['finalized_at'], null);
    assert.equal(row?.['state'], 'Released');
    assert.equal(row?.['head_sha'], FIXTURE_HEAD_SHA);
    assert.deepEqual(h.receipt(released.deliveryId), receipt);
  });
});

test('F29-AC2: a failed delivery produces a typed receipt carrying the provider reason, never a silent success', async () => {
  const components = [
    { component: 'storefront', deploymentId: FIXTURE_USABLE_DEPLOYMENT.deploymentId, url: FIXTURE_USABLE_DEPLOYMENT.url },
    { component: 'worker', deploymentId: 'dep_fixture_building', url: 'https://worker.preview.invalid' },
  ];
  await withHarness({ components }, async (h) => {
    h.at(T1);
    const denied = await h.useCases.authorizeDelivery({
      candidateId: h.candidateId,
      actor: CODING_ACTOR,
      action: MERGE_ACTION,
      destination: DESTINATION,
      pullRequestId: h.pullRequestId,
      targetBranch: FIXTURE_REPOSITORY.defaultBranch,
      repository: FIXTURE_REPOSITORY,
      correlationId: CORRELATION,
    });
    assert.equal(denied.ok, false, 'no other role may author a delivery whose receipt would be published');

    await h.mergeFirst();
    h.at(T1);
    const record = await h.authorize({ action: RELEASE_ACTION, pullRequestId: null });
    h.at(T2);
    h.adapters.conditions.programComponentOutcomes({ storefront: 'Usable', worker: 'Failed' });
    const partial = await h.useCases.executeRelease({
      authorizationId: record.authorizationId,
      actor: OWNER_ACTOR,
      correlationId: CORRELATION,
      liveSmoke: smokeRequirement(['storefront', 'worker']),
    });
    assert.equal(partial.ok, false);
    const failedRow = h.database
      .prepare('SELECT delivery_id, state, failure_detail_redacted FROM deliveries WHERE delivery_id = ?')
      .get(record.deliveryId);
    assert.equal(failedRow?.['state'], 'Failed');
    assert.match(String(failedRow?.['failure_detail_redacted']), /did not reach/);

    const written = unwrap(
      h.useCases.releaseReceipt({
        deliveryId: String(failedRow?.['delivery_id']),
        actor: OWNER_ACTOR,
        link: null,
        checks: [{ name: 'pnpm test', result: 'Passed', detail: 'All suites passed.' }],
        correlationId: CORRELATION,
      }),
      'write the failure receipt',
    );
    const receipt = written.receipt;
    assert.equal(receipt.outcome, 'Failed', 'a failed delivery is never a confirmed receipt (F29-AC2)');
    assert.equal(receipt.deliveryState, 'Failed');
    assert.match(receipt.failureReason ?? '', /did not reach/);
    assert.deepEqual(receipt.releasedComponents, ['storefront'], 'what did reach the destination is still named (F29-AC5)');
    assert.deepEqual(
      receipt.unreleasedComponents.map((entry) => entry.component),
      ['worker'],
    );
    assert.match(
      receipt.unreleasedComponents[0]?.reason ?? '',
      /answered 502 where 200 was expected/,
      'the reason is what the destination actually returned, not a composed sentence (F29-AC2)',
    );
    assert.equal(receipt.checks[0]?.result, 'Passed', 'green checks do not make a failed release a success');
    assert.equal(h.receipt(String(failedRow?.['delivery_id']))?.outcome, 'Failed');
  });
});

test('F29-AC3: no receipt is recorded from an unconfirmed result, and a second request republishes nothing', async () => {
  await withHarness({}, async (h) => {
    h.at(T1);
    const record = await h.authorize();
    h.at(T2);
    h.adapters.conditions.loseNextWriteResponse(1);
    const lost = await h.useCases.executeMerge({
      authorizationId: record.authorizationId,
      actor: OWNER_ACTOR,
      correlationId: CORRELATION,
    });
    assert.equal(lost.ok, false);
    assert.equal(h.delivery(record.authorizationId)?.state, 'OutcomeUnknown');
    const row = h.database
      .prepare('SELECT delivery_id FROM deliveries WHERE decision_id = ?')
      .get(record.authorizationId);
    const unresolved = String(row?.['delivery_id']);

    const refused = h.useCases.releaseReceipt({
      deliveryId: unresolved,
      actor: OWNER_ACTOR,
      link: null,
      checks: [],
      correlationId: CORRELATION,
    });
    assert.equal(refused.ok, false, 'a receipt is never written from an unconfirmed result (F29-AC3)');
    if (!refused.ok) {
      assert.equal(refused.error.code, 'Blocked');
      assert.match(refused.error.reason, /no confirmed result exists to receipt/);
    }
    assert.equal(h.database.prepare('SELECT COUNT(*) AS n FROM release_receipts').get()?.['n'], 0);

    // Settle it, then the receipt is allowed, and a retry returns the same one (F29-AC4).
    unwrap(
      await h.useCases.reconcileDelivery({
        operationId: record.operationId,
        resolvedBy: 'test-reconciler',
        correlationId: CORRELATION,
      }),
      'reconcile the lost response',
    );
    h.at(T3);
    const first = unwrap(
      h.useCases.releaseReceipt({ deliveryId: unresolved, actor: OWNER_ACTOR, link: null, checks: [], correlationId: CORRELATION }),
      'write the receipt once',
    );
    assert.equal(first.kind, 'Recorded');

    const second = unwrap(
      h.useCases.releaseReceipt({ deliveryId: unresolved, actor: OWNER_ACTOR, link: null, checks: [], correlationId: CORRELATION }),
      'ask for the receipt again',
    );
    assert.equal(second.kind, 'AlreadyRecorded', 'a retry republishes nothing (F29-AC4)');
    assert.equal(second.receipt.receiptId, first.receipt.receiptId);
    assert.equal(
      h.database.prepare('SELECT COUNT(*) AS n FROM release_receipts').get()?.['n'],
      1,
      'exactly one receipt row exists, and the schema would refuse a second',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* F30-AC5: the bounded sweep                                                   */
/* -------------------------------------------------------------------------- */

test('F30-AC5: the bounded sweep defers what it cannot settle with a growing delay, settles what it can, and never issues a write', async () => {
  // While the target has moved but the pull request is still open, no read establishes
  // whether the write landed, so the sweep defers rather than retries (F30-AC3, F30-AC5).
  let applied = false;
  let targetMoved = false;
  await withHarness(
    {
      liveRead: (read) => ({
        ...read,
        head: read.head.kind === 'Branch' && targetMoved && !applied ? { ...read.head, sha: MOVED_TARGET } : read.head,
        pullRequest: applied && read.pullRequest !== null ? { ...read.pullRequest, state: 'Merged' as const } : read.pullRequest,
      }),
    },
    async (h) => {
      h.at(T1);
      const first = await h.authorize();
      h.at(T2);
      h.adapters.conditions.loseNextWriteResponse(1);
      const lost = await h.useCases.executeMerge({
        authorizationId: first.authorizationId,
        actor: OWNER_ACTOR,
        correlationId: CORRELATION,
      });
      assert.equal(lost.ok, false);
      assert.equal(h.delivery(first.authorizationId)?.state, 'OutcomeUnknown');
      // The target moves and the response was lost, so no later read can tell whether the
      // merge landed until the provider reports the pull request merged.
      targetMoved = true;
      const writes = h.adapters.effects.count();
      const reported: string[] = [];

      const sweepAt = async (now: string) => {
        h.at(now);
        return unwrap(
          await h.useCases.frequentOperationReconciliation({
            now,
            limit: 5,
            baseDelayMs: 60_000,
            maxDelayMs: 3_600_000,
            correlationId: CORRELATION,
          }),
          `the sweep at ${now}`,
        );
      };

      for (const now of [S1, S2, S3]) {
        const sweep = await sweepAt(now);
        reported.push(sweep.deferred[0]?.nextAttemptAt ?? '');
        assert.equal(sweep.swept, 1, 'the unresolved operation is on the worklist');
        assert.equal(sweep.didHappen, 0);
        assert.equal(sweep.didNotHappen, 0);
        assert.equal(sweep.stillUnknown, 1, 'an ambiguous read settles nothing');
        assert.equal(sweep.deferred.length, 1);
        assert.equal(sweep.deferred[0]?.operationId, first.operationId);
        assert.equal(
          h.delivery(first.authorizationId)?.state,
          'OutcomeUnknown',
          'an unsettled sweep leaves the delivery exactly as blocked as it was',
        );
        assert.equal(h.adapters.effects.count(), writes, 'a sweep never issues a write (F30-AC5)');
      }
      // Unresolved for 1, 2 and 3 base intervals, so the reported delay doubles (F30-AC4).
      assert.deepEqual(
        reported.map((instant, index) => Date.parse(instant) - Date.parse([S1, S2, S3][index] ?? S1)),
        [2 * 60_000, 4 * 60_000, 8 * 60_000],
      );

      applied = true;
      const settled = await sweepAt(S4);
      assert.equal(settled.swept, 1);
      assert.equal(settled.didHappen, 1, 'a confirmed read settles the delivery');
      assert.equal(settled.stillUnknown, 0);
      assert.deepEqual(settled.deferred, []);
      assert.equal(h.delivery(first.authorizationId)?.state, 'Merged');
      assert.equal(h.adapters.effects.count(), writes, 'settling an applied write still issues none');

      const after = await sweepAt(S5);
      assert.equal(after.swept, 0, 'a settled operation is not on the worklist again');

      const refused = await h.useCases.frequentOperationReconciliation({
        now: S5,
        limit: 0,
        correlationId: CORRELATION,
      });
      assert.equal(refused.ok, false, 'a sweep with no bound is refused rather than unbounded (F30-AC4)');
      if (!refused.ok) assert.equal(refused.error.code, 'Invalid');
    },
  );
});
