/**
 * Behavioural proof for manual owner test recording (F25-AC1, F25-AC4, F24-AC4, F23-AC1,
 * F23-AC2, F23-AC3, F23-AC4, F23-AC5, F20-AC3, F01-AC1, N02-AC2).
 *
 * Every case runs against a real SQLite file in a fresh temporary directory, opened by the
 * real `openDatabase` and brought to the real `migrate` version. No inline fixture schema
 * appears here, so the foreign keys, the `CHECK` on a `Verified` row, the `CHECK` binding an
 * automated method to a real `checks` row, and the `NOT NULL` on `audit_log.actor` are
 * exercised rather than assumed: an observation with no owner behind it cannot be filed even
 * if every check in this layer were removed.
 *
 * The projects, work items, scope snapshots and candidates are read and written through the
 * real `@shiploop/storage` repositories, and the criterion verdicts this path reads and
 * writes go through the real `SqliteObservationJournal`. The methods are assigned by the real
 * `buildEvidencePack`, through `createVerificationUseCases`, so the rows these cases assert
 * against are the rows the product produces rather than rows a fixture invented.
 *
 * What is deliberately not run here: the environment recipe's local check execution. These
 * cases are about what an owner may record and against what, so the one automated criterion
 * they need is seeded through the real journal with a real `checks` row instead of spawning a
 * process. `verification.test.ts` is where a check is actually executed, and the `run`
 * member of `ProjectChecks` refuses by name here rather than quietly succeeding at something
 * no case exercises.
 *
 * The cases worth reading first:
 *
 *   - a recorded observation carries the criterion, the exact candidate fingerprint, the
 *     deployment it was made against, the owner's own identity and the instant from the
 *     injected clock, and the durable actor is the resolved owner (F25-AC1, F23-AC3);
 *   - a submission prepared against a superseded fingerprint is refused with a typed
 *     `Conflict` naming both identities, and nothing is written — neither against the old
 *     candidate nor against its replacement (F24-AC4, F20-AC3);
 *   - a non-owner role is refused before any row is read, so the refusal discloses nothing
 *     and leaves nothing behind (F25-AC4);
 *   - an owner test is refused for an automated criterion, naming the check that verifies
 *     it, and refused for a criterion with no assigned method at all (F23-AC1);
 *   - a deployment the candidate does not carry is refused with both identities, and "no
 *     deployment applies" is refused outright for a candidate that has one, so a local label
 *     cannot satisfy a criterion meant to be observed in a preview (F22-AC1, F23-AC4);
 *   - a capture failure, a behaviour failure and an un-recorded criterion stay three
 *     distinguishable facts, and none of them is a `checks` row (F23-AC5);
 *   - re-recording against a replacement candidate leaves the earlier observation bound to
 *     the earlier build (F20-AC3).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalize, err, fingerprint, ok } from '@shiploop/domain';
import type {
  CandidateId,
  CheckRecord,
  CommitSha,
  DomainError,
  Fingerprint,
  OwnerId,
  ProjectId,
  Result,
  ScopeSnapshot,
  WorkItemId,
} from '@shiploop/domain';
import { FIXTURE_BASE_SHA, FIXTURE_HEAD_SHA, FIXTURE_REPOSITORY } from '@shiploop/adapters';
import { recipeFingerprint } from '@shiploop/verification';
import type { BoundedCommand, RecipeVersion, RequiredCheckPolicy } from '@shiploop/verification';
import {
  CandidateRepository,
  ProcedureRepository,
  ProjectProfileRepository,
  ScopeRepository,
  WorkItemRepository,
  migrate,
  openDatabase,
} from '@shiploop/storage';
import type {
  CandidateRecord,
  Database,
  ProfilePolicy,
  ProjectProfileContent,
  ProjectProfileVersion,
} from '@shiploop/storage';
import { RECIPE_SUBJECT_KEY } from './profiles.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';
import type { ProjectCheckPolicy } from './verification.ts';
import { SqliteObservationJournal, createVerificationUseCases } from './verification.ts';
import type { CriterionAssignment, VerificationUseCases } from './verification.ts';
import {
  SqliteOwnerObservationJournal,
  createOwnerObservationUseCases,
} from './owner-tests.ts';
import type {
  OwnerObservationReport,
  OwnerObservationTarget,
  OwnerObservationUseCases,
  RecordOwnerObservationCommand,
} from './owner-tests.ts';

const T0 = '2026-11-02T09:00:00.000Z';
const T1 = '2026-11-02T10:00:00.000Z';
const T2 = '2026-11-02T11:00:00.000Z';
const T3 = '2026-11-02T12:00:00.000Z';

const PROJECT = 'proj-owner-tests' as ProjectId;
const OWNER = 'owner-owner-tests' as OwnerId;
const ISSUE_IDENTIFIER = 'SHIP-410';
const RECIPE_ID = 'recipe-owner-tests';

/** The deployed component every candidate in these cases carries. */
const COMPONENT = 'web';
const DEPLOYMENT_ID = 'deployment-owner-tests';
const DEPLOYMENT_ENVIRONMENT = 'preview';

/** A different deployment of the same component, which no candidate here carries. */
const OTHER_DEPLOYMENT_ID = 'deployment-from-an-older-build';
const OTHER_DEPLOYMENT_ENVIRONMENT = 'staging-preview';

const CRITERION_OWNER = 'AC-1';
const CRITERION_AUTOMATED = 'AC-2';
const CRITERION_CAPTURED = 'AC-3';
const CRITERION_UNASSIGNED = 'AC-4';

/** The check the automated criterion is verified by. */
const AUTOMATED_CHECK_NAME = 'pnpm unit';

/** A credential-shaped value assembled at runtime, so no tracked source holds one (N02-AC2). */
const SEEDED_SECRET = ['sk', 'ownertestseed', 'fixtureonly', 'aaaaaaaaaaaaaaaaaaaaaaa'].join('-');

const OWNER_ACTOR: OwnerActor = {
  actorId: OWNER,
  role: 'Owner',
  ownerId: OWNER,
  sessionId: 'session-owner-tests' as OwnerActor['sessionId'],
};

const CODING_AGENT_ACTOR: OwnerActor = {
  actorId: 'agent-owner-tests',
  role: 'CodingAgent',
  ownerId: null,
  sessionId: null,
};

function unwrap<T>(result: Result<T, DomainError>, what: string): T {
  assert.ok(result.ok, `${what} failed: ${result.ok ? '' : result.error.reason}`);
  return result.value;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

function maintenanceCommand(): BoundedCommand {
  return { argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 30_000, maxOutputBytes: 4_096, cwd: null };
}

/**
 * An environment recipe with no local checks.
 *
 * The `checks` list is empty because these cases seed the one automated criterion's check
 * through the real journal instead of executing a recipe command; the recipe still exists
 * because `buildEvidencePack` resolves the current environment through it, and a candidate
 * identity is not comparable without an environment fingerprint.
 */
function recipe(): RecipeVersion {
  return {
    recipeId: RECIPE_ID,
    version: 1,
    supersedesVersion: null,
    provenance: { source: 'OwnerSaved', scope: 'Environment', createdBy: 'owner', createdAt: T0 },
    lastVerification: {
      result: 'Verified',
      verifiedAt: T0,
      verifiedRevision: 'main',
      dependencyDigest: fingerprint({ dependencies: 1 }),
    },
    requirements: { runtime: { name: 'node', minVersion: '24.0.0', maxVersionExclusive: null }, cpu: null },
    dependencyInstall: [],
    serviceStartup: [],
    checks: [],
    ports: [],
    dataLocations: [],
    testAccess: [],
    requiredSecrets: [],
    declaredCapabilities: [],
    maintenance: { action: 'RunMaintenanceStep', command: maintenanceCommand(), incompatibilityReason: null },
  };
}

function profileContent(): ProjectProfileContent {
  const policy: ProfilePolicy = {
    requiredChecks: [AUTOMATED_CHECK_NAME],
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
      baseBranch: 'main',
      targetBranch: 'main',
      deploymentProvider: 'fixture-deployment',
      engine: 'fixture-engine',
      previewComponents: [{ component: COMPONENT, environment: DEPLOYMENT_ENVIRONMENT }],
    },
    policy,
    recipe: 'Saved through the profile use case',
    environment: { runtime: 'node 24', ports: [4100], secretReferences: ['registry.token'] },
  };
}

function scopeFor(workItemId: WorkItemId): ScopeSnapshot {
  return {
    workItemId,
    issueId: 'issue-owner-tests',
    issueIdentifier: ISSUE_IDENTIFIER,
    title: 'Let the owner record what they tested',
    description: 'A manual criterion result must belong to the exact build and preview the owner looked at.',
    providerRevision: 'rev-1',
    priority: 'High',
    dependencyIssueIds: [],
    acceptanceCriteria: [
      { id: CRITERION_OWNER, text: 'The owner can record what they saw for the wording criterion' },
      { id: CRITERION_AUTOMATED, text: 'The local unit check passes for the candidate head' },
      { id: CRITERION_CAPTURED, text: 'A screenshot of the main flow is retained' },
      { id: CRITERION_UNASSIGNED, text: 'The export keeps the run history readable' },
    ],
    retrievedAt: T0,
  };
}

/** The method assignment each criterion carries, decided here rather than by the product. */
function assignmentFor(criterionId: string): CriterionAssignment {
  switch (criterionId) {
    case CRITERION_OWNER:
      return { criterionId, method: { kind: 'OwnerTest', instructions: 'Read the card and judge the wording' }, requiresDeployedObservation: false };
    case CRITERION_AUTOMATED:
      return { criterionId, method: { kind: 'AutomatedCheck', checkId: AUTOMATED_CHECK_NAME }, requiresDeployedObservation: false };
    case CRITERION_CAPTURED:
      return { criterionId, method: { kind: 'BrowserEvidence', evidenceId: 'evid-captured' }, requiresDeployedObservation: true };
    default:
      return { criterionId, method: { kind: 'Untested', reason: 'No method assigned.' }, requiresDeployedObservation: false };
  }
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                      */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly database: Database;
  readonly useCases: OwnerObservationUseCases;
  readonly candidate: CandidateRecord;
  readonly workItemId: WorkItemId;
  /**
   * Records a replacement candidate for the same work item, which is what supersedes one,
   * and rebuilds the criterion verdicts for it.
   *
   * The rebuild is not decoration: a candidate fingerprint is part of every criterion row's
   * key, so a replacement build genuinely starts with no assigned method, and the capture
   * path is what assigns one again. A case that recorded against the replacement without it
   * would be testing a state the product never reaches (F20-AC3, F23-AC1).
   */
  supersede(headSha: CommitSha): CandidateRecord;
  /** How many `audit_log` attributions exist, which is what proves a refusal wrote nothing. */
  attributionCount(): number;
  /** How many criterion verdict rows exist for one criterion, at any identity. */
  verdictCount(criterionId: string): number;
  setNow(instant: string): void;
}

interface HarnessOptions {
  /** Recorded on the candidate, so a case can prove the "none applies" path. */
  readonly deploy: boolean;
  /** Assigns every method, which is what a review card needs before the owner can test. */
  readonly assignMethods: boolean;
}

async function withHarness(
  options: HarnessOptions,
  body: (harness: Harness) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-controller-owner-tests-'));
  const opened = openDatabase(join(directory, 'shiploop.sqlite'));
  assert.ok(opened.ok, `the real database opened: ${opened.ok ? '' : opened.error.reason}`);
  const database = opened.value;
  try {
    assert.ok(migrate(database).ok, 'the real schema migrated');

    const profiles = new ProjectProfileRepository(database);
    const procedures = new ProcedureRepository(database);
    const workItems = new WorkItemRepository(database);
    const scope = new ScopeRepository(database);
    const candidates = new CandidateRepository(database);
    const journal = new SqliteObservationJournal(database);
    const observations = new SqliteOwnerObservationJournal(database, journal);

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
        content: canonicalize(recipe()),
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
        title: 'Let the owner record what they tested',
        externalIssueId: 'issue-owner-tests',
        externalIssueIdentifier: ISSUE_IDENTIFIER,
        externalIssueUrl: 'https://linear.invalid/issue/SHIP-410',
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
        correlationId: 'correlation-owner-tests',
      }),
      'capture the scope snapshot',
    );

    let instant = T0;
    const clock: ControllerClock = { now: () => instant };
    const environmentFingerprint = recipeFingerprint(recipe());

    const identityFor = (headSha: CommitSha) => ({
      headSha,
      baseSha: FIXTURE_BASE_SHA,
      scopeFingerprint: snapshot.scopeFingerprint,
      profileVersionId: profile.profileVersionId,
      procedureVersionId: procedure.procedureVersionId,
      environmentFingerprint,
      policyFingerprint: profile.contentFingerprint,
      components: options.deploy
        ? [
            {
              component: COMPONENT,
              deploymentId: DEPLOYMENT_ID,
              deploymentUrl: 'https://owner-tests.preview.invalid',
              environment: DEPLOYMENT_ENVIRONMENT,
            },
          ]
        : [{ component: COMPONENT, deploymentId: null, deploymentUrl: null, environment: DEPLOYMENT_ENVIRONMENT }],
    });

    /**
     * A candidate recorded at the instant it was built.
     *
     * The instant matters rather than being fixture detail: the store orders a work item's
     * candidates by `recorded_at`, and "the current one" is the last of that order, so a
     * replacement recorded at the same instant as the build it replaces would be ordered
     * against a random row identity. A replacement is therefore recorded later, which is
     * what the product does.
     */
    const recordCandidate = (headSha: CommitSha, recordedAt: string): CandidateRecord =>
      unwrap(
        candidates.record({
          attemptId: null,
          workItemId: workItem.workItemId,
          identity: identityFor(headSha),
          pullRequestId: null,
          targetBranch: 'main',
          recordedAt,
          correlationId: 'correlation-owner-tests',
        }),
        'record the candidate',
      );

    const candidate = recordCandidate(FIXTURE_HEAD_SHA, T0);

    const assignMethodsFor = (target: CandidateRecord): void => {
      /**
       * The one automated criterion's check, written as a real `checks` row.
       *
       * Seeded rather than executed because no case here runs the recipe, and the schema
       * binds an automated criterion's verdict to a real check row, so the row has to exist
       * for `recordCriterion` to accept the assignment at all.
       */
      const check: CheckRecord = {
        checkId: AUTOMATED_CHECK_NAME,
        name: AUTOMATED_CHECK_NAME,
        origin: 'LocalCheck',
        required: true,
        result: 'Passed',
        candidateFingerprint: target.candidateFingerprint,
        startedAt: T1,
        endedAt: T1,
        exitCode: 0,
        artifactRef: null,
        detail: 'the check ran and passed',
        notApplicableApprovedByPolicy: false,
      };
      unwrap(journal.recordCheck({ candidate: target, record: check, correlationId: null }), 'record the automated check result');

      const verification: VerificationUseCases = createVerificationUseCases({
        clock,
        git: {
          async readChecks() {
            return ok([]);
          },
          async failureOnBase() {
            return ok(new Map());
          },
        },
        checks: {
          policyFor: (): Result<ProjectCheckPolicy, DomainError> => {
            const current = profiles.currentVersion(PROJECT);
            if (!current.ok) return err(current.error);
            const version = current.value as ProjectProfileVersion;
            const approved: RequiredCheckPolicy = {
              policyFingerprint: version.contentFingerprint,
              requiredCheckIds: version.content.policy.requiredChecks,
              approvals: [],
              decidedBy: OWNER,
              decidedAt: version.createdAt,
            };
            return ok({ profileVersionId: version.profileVersionId, approved, proposed: approved });
          },
          async run() {
            return err({
              code: 'Unavailable',
              reason: 'These cases seed a check row through the journal rather than executing the environment recipe.',
            });
          },
        },
        evidence: journal,
        candidates,
        scope: { latestScopeSnapshot: (id) => workItems.latestScopeSnapshot(id) },
        workItems: { get: (id) => workItems.get(id) },
        procedureVersions: {
          currentEnvironment: (projectId) => {
            const found = procedures.currentVersion(projectId, RECIPE_SUBJECT_KEY);
            if (!found.ok) return err(found.error);
            if (found.value === null) {
              return err({ code: 'NotFound', reason: `project ${projectId} has no saved environment recipe` });
            }
            return ok({
              procedureVersionId: found.value.procedureVersionId,
              environmentFingerprint,
              checks: recipe().checks,
            });
          },
        },
      });
      unwrap(
        verification.buildEvidencePack(target, {
          assignments: [CRITERION_OWNER, CRITERION_AUTOMATED, CRITERION_CAPTURED].map(assignmentFor),
          observations: [
            {
              criterionId: CRITERION_CAPTURED,
              evidenceId: 'evid-captured' as never,
              observation: 'BehaviorConfirmed',
              environment: 'Preview',
              capturedAt: T1,
              component: COMPONENT,
              deploymentId: DEPLOYMENT_ID,
              artifacts: [{ kind: 'Screenshot', name: 'screenshots/flow.png', capturedAt: T1 }],
              apiExchange: null,
              detail: null,
            },
          ],
          eligiblePreview: {
            component: COMPONENT,
            deploymentId: DEPLOYMENT_ID,
            environment: DEPLOYMENT_ENVIRONMENT,
            candidateFingerprint: target.candidateFingerprint,
          },
          bundleId: 'bundle-owner-tests',
          correlationId: 'correlation-owner-tests',
        }),
        'assign the criterion methods',
      );
    };
    if (options.assignMethods) assignMethodsFor(candidate);

    const useCases = createOwnerObservationUseCases({
      clock,
      candidates,
      workItems: { get: (id) => workItems.get(id) },
      scope: { latestScopeSnapshot: (id) => workItems.latestScopeSnapshot(id) },
      evidence: journal,
      observations,
    });

    await body({
      database,
      useCases,
      candidate,
      workItemId: workItem.workItemId,
      supersede(headSha) {
        const replacement = recordCandidate(headSha, T2);
        if (options.assignMethods) assignMethodsFor(replacement);
        return replacement;
      },
      attributionCount(): number {
        const row = database
          .prepare("SELECT COUNT(*) AS total FROM audit_log WHERE action = 'RecordOwnerTest'")
          .get();
        return Number(row?.['total'] ?? 0);
      },
      verdictCount(criterionId: string): number {
        const row = database
          .prepare('SELECT COUNT(*) AS total FROM evidence WHERE criterion_id = ?')
          .get(criterionId);
        return Number(row?.['total'] ?? 0);
      },
      setNow(next: string): void {
        instant = next;
      },
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                     */
/* -------------------------------------------------------------------------- */

const PREVIEW_TARGET: OwnerObservationTarget = {
  kind: 'Deployment',
  component: COMPONENT,
  deploymentId: DEPLOYMENT_ID,
  environment: DEPLOYMENT_ENVIRONMENT,
};

function command(
  harness: Harness,
  overrides: Partial<RecordOwnerObservationCommand> = {},
): RecordOwnerObservationCommand {
  return {
    candidateId: harness.candidate.candidateId,
    expectedCandidateFingerprint: harness.candidate.candidateFingerprint,
    criterionId: CRITERION_OWNER,
    actor: OWNER_ACTOR,
    observation: 'BehaviorConfirmed',
    observedAgainst: PREVIEW_TARGET,
    evidence: { kind: 'Screenshot', reference: 'screenshots/review-card.png' },
    note: 'The wording reads as the owner expects.',
    correlationId: 'correlation-owner-test',
    ...overrides,
  };
}

function record(
  harness: Harness,
  overrides: Partial<RecordOwnerObservationCommand> = {},
): OwnerObservationReport {
  return unwrap(harness.useCases.recordOwnerObservation(command(harness, overrides)), 'record the owner observation');
}

/**
 * Asserts that a refused submission left nothing behind.
 *
 * Counted as a delta rather than as an absolute, because assigning the criterion methods is
 * itself a real `evidence` write: the question a refusal has to answer is "did *this* call
 * add anything", not "is the table empty", and an absolute count would make every assignment
 * look like a leak (F23-AC1).
 */
function assertRecordedNothing(
  harness: Harness,
  before: { readonly verdicts: number; readonly attributions: number },
  what: string,
): void {
  assert.equal(harness.attributionCount(), before.attributions, `no attribution was filed: ${what}`);
  assert.equal(harness.verdictCount(CRITERION_OWNER), before.verdicts, `no verdict was filed: ${what}`);
}

/** How many rows the harness's own assignment has already written, per criterion. */
function recordedSoFar(harness: Harness): { readonly verdicts: number; readonly attributions: number } {
  return { verdicts: harness.verdictCount(CRITERION_OWNER), attributions: harness.attributionCount() };
}

/* -------------------------------------------------------------------------- */
/* F25-AC1, F23-AC3: what one observation records                             */
/* -------------------------------------------------------------------------- */

test('F25-AC1, F23-AC3: a recorded observation names the criterion, the exact candidate, the deployment, the owner and the instant', async () => {
  await withHarness({ deploy: true, assignMethods: true }, (harness) => {
    harness.setNow(T2);
    const report = record(harness);

    assert.equal(report.observation.criterionId, CRITERION_OWNER);
    assert.equal(
      report.observation.candidateFingerprint,
      harness.candidate.candidateFingerprint,
      'the observation is bound to the exact fingerprint the owner acted on (F25-AC1, F20-AC3)',
    );
    assert.equal(report.observation.methodKind, 'OwnerTest');
    assert.equal(report.observation.status, 'Verified');
    assert.equal(report.observation.failureKind, null, 'a confirmed observation is not a failure of either kind (F23-AC5)');
    assert.equal(
      report.observation.deploymentId,
      DEPLOYMENT_ID,
      'an observation names the deployment it was made against (F23-AC3, F22-AC1)',
    );
    assert.equal(report.observation.component, COMPONENT);
    assert.equal(report.observation.environment, 'Preview');
    assert.equal(
      report.observation.evidenceRef,
      'screenshots/review-card.png',
      'the retained evidence reference travels with the record (F23-AC2)',
    );
    assert.equal(report.observation.evidenceKind, 'Screenshot');
    assert.equal(report.observation.observedBy, OWNER, 'the actor is the authenticated owner (F25-AC1)');
    assert.equal(
      report.observation.observedAt,
      T2,
      'the instant is the injected clock, which no caller can supply (F23-AC3, F09-AC4)',
    );
    assert.equal(
      report.recordedForDelivery,
      false,
      'recording one observation is not accepting the build (F25-AC1, F24-AC3)',
    );
    assert.ok(
      report.outstandingCriterionIds.includes(CRITERION_AUTOMATED),
      'the criteria that are not verified are named rather than summarised (F24-AC3)',
    );
    assert.equal(
      report.outstandingCriterionIds.includes(CRITERION_OWNER),
      false,
      'the criterion just observed is no longer outstanding',
    );

    const row = harness.database
      .prepare('SELECT candidate_fingerprint, artifact_ref, status, method_kind, observed_at FROM evidence WHERE criterion_id = ?')
      .get(CRITERION_OWNER);
    assert.equal(row?.['candidate_fingerprint'], harness.candidate.candidateFingerprint);
    assert.equal(row?.['artifact_ref'], 'screenshots/review-card.png');
    assert.equal(row?.['method_kind'], 'OwnerTest');
    assert.equal(row?.['status'], 'Verified');
    assert.equal(row?.['observed_at'], T2);

    const attribution = harness.database
      .prepare("SELECT actor, action, occurred_at, detail_json FROM audit_log WHERE action = 'RecordOwnerTest'")
      .get();
    assert.equal(attribution?.['actor'], OWNER, 'the actor is durable and is the schema NOT NULL column (F25-AC1)');
    assert.equal(attribution?.['occurred_at'], T2, 'the instant is durable beside the actor (F23-AC3)');
    const detail = JSON.parse(String(attribution?.['detail_json'])) as Record<string, unknown>;
    assert.equal(detail['deploymentId'], DEPLOYMENT_ID);
    assert.equal(detail['candidateFingerprint'], harness.candidate.candidateFingerprint);
    assert.equal(detail['failureKind'], null);

    assert.equal(
      harness.database.prepare("SELECT COUNT(*) AS total FROM checks WHERE name LIKE 'owner test%'").get()?.['total'],
      0,
      'an owner test files no automated check row, so it is never read as a check result (F23-AC5)',
    );
  });
});

test('F25-AC4: the verdict and its attribution are one indivisible write', async () => {
  await withHarness({ deploy: true, assignMethods: true }, (harness) => {
    harness.setNow(T2);
    // A verdict the schema cannot file: the observation names a criterion whose recorded
    // row is for a method that cannot carry a check row.
    const before = recordedSoFar(harness);
    const refused = harness.useCases.recordOwnerObservation(
      command(harness, { criterionId: CRITERION_CAPTURED }),
    );
    assert.equal(refused.ok, false, 'a captured-evidence criterion refuses an owner test (F23-AC1)');
    assertRecordedNothing(
      harness,
      before,
      'there is no record of an observation nobody made, and no verdict for one (F25-AC4)',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* F24-AC4: a stale submission                                                */
/* -------------------------------------------------------------------------- */

test('F24-AC4, F20-AC3: a submission prepared against a superseded candidate is refused and records nothing', async () => {
  await withHarness({ deploy: true, assignMethods: true }, (harness) => {
    harness.setNow(T1);
    const first = record(harness);
    assert.equal(first.observation.status, 'Verified');

    harness.setNow(T2);
    const replacement = harness.supersede('b'.repeat(40) as CommitSha);
    assert.notEqual(replacement.candidateFingerprint, harness.candidate.candidateFingerprint);

    const before = recordedSoFar(harness);
    const stale = harness.useCases.recordOwnerObservation(
      command(harness, { expectedCandidateFingerprint: harness.candidate.candidateFingerprint }),
    );
    assert.equal(stale.ok, false, 'a submission against a superseded fingerprint is refused (F24-AC4)');
    const error = stale.ok ? undefined : stale.error;
    assert.equal(error?.code, 'Conflict');
    assert.equal(error?.code === 'Conflict' ? error.expected : null, harness.candidate.candidateFingerprint);
    assert.equal(
      error?.code === 'Conflict' ? error.actual : null,
      replacement.candidateFingerprint,
      'the conflict names both identities so the owner can re-read current facts (F24-AC4)',
    );

    assertRecordedNothing(
      harness,
      before,
      'the refusal did not add a verdict, and did not file against the replacement (F24-AC4)',
    );

    const carriedOver = unwrap(
      harness.useCases.listOwnerObservations({
        candidateId: replacement.candidateId,
        candidateFingerprint: replacement.candidateFingerprint,
      }),
      'read the replacement candidate observations',
    );
    assert.deepEqual(
      carriedOver,
      [],
      'the replacement candidate inherits no observation from the build it replaced (F20-AC3, F23-AC1)',
    );
    const retained = unwrap(
      harness.useCases.listOwnerObservations({
        candidateId: harness.candidate.candidateId,
        candidateFingerprint: harness.candidate.candidateFingerprint,
      }),
      'read the original candidate observations',
    );
    assert.equal(retained.length, 1, 'the original observation is still bound to the build it was made against (F20-AC3)');
    assert.equal(retained[0]?.candidateFingerprint, harness.candidate.candidateFingerprint);
  });
});

test('F24-AC4: naming a superseded candidate is refused with both identities', async () => {
  await withHarness({ deploy: true, assignMethods: true }, (harness) => {
    harness.setNow(T1);
    const replacement = harness.supersede('c'.repeat(40) as CommitSha);

    const before = recordedSoFar(harness);
    const stale = harness.useCases.recordOwnerObservation(
      command(harness, {
        candidateId: harness.candidate.candidateId,
        expectedCandidateFingerprint: harness.candidate.candidateFingerprint,
      }),
    );
    assert.equal(stale.ok, false);
    const error = stale.ok ? undefined : stale.error;
    assert.equal(error?.code, 'Conflict');
    assert.equal(error?.code === 'Conflict' ? error.expected : null, harness.candidate.candidateFingerprint);
    assert.equal(error?.code === 'Conflict' ? error.actual : null, replacement.candidateFingerprint);
    assertRecordedNothing(harness, before, 'a superseded candidate is refused before any write (F24-AC4)');
  });
});

/* -------------------------------------------------------------------------- */
/* F25-AC4: no fabrication                                                     */
/* -------------------------------------------------------------------------- */

test('F25-AC4: only the owner may record an observation, and the refusal discloses nothing', async () => {
  await withHarness({ deploy: true, assignMethods: true }, (harness) => {
    const before = recordedSoFar(harness);
    const forbidden = harness.useCases.recordOwnerObservation(command(harness, { actor: CODING_AGENT_ACTOR }));
    assert.equal(forbidden.ok, false, 'a coding agent may not record an owner observation (F25-AC4)');
    assert.equal(forbidden.ok ? '' : forbidden.error.code, 'Forbidden');

    const unowned = harness.useCases.recordOwnerObservation(
      command(harness, { actor: { ...OWNER_ACTOR, ownerId: null } }),
    );
    assert.equal(
      unowned.ok,
      false,
      'a role claiming Owner with no owner identity behind it is refused, because the row could not be attributed (F25-AC1)',
    );
    assert.equal(unowned.ok ? '' : unowned.error.code, 'Forbidden');

    assertRecordedNothing(harness, before, 'a caller that was not the owner recorded nothing (F25-AC4)');
  });
});

test('F01-AC1: an observation cannot be attributed to an owner the caller names', async () => {
  await withHarness({ deploy: true, assignMethods: true }, (harness) => {
    harness.setNow(T2);
    // The command type has no actor field a request could fill, so the only actor that can
    // reach the row is the authenticated one. This case records that fact rather than
    // asserting it about a type: the durable row and its `NOT NULL` actor are read back.
    const report = record(harness, { note: `Observed with ${OWNER}` });
    assert.equal(report.observation.observedBy, OWNER);
    const attribution = harness.database
      .prepare("SELECT actor FROM audit_log WHERE action = 'RecordOwnerTest'")
      .get();
    assert.equal(attribution?.['actor'], OWNER, 'the stored actor is the authenticated owner and nothing else (F01-AC1)');
  });
});

/* -------------------------------------------------------------------------- */
/* F23-AC1: an owner observation may not replace a stronger method             */
/* -------------------------------------------------------------------------- */

test('F23-AC1: an owner test is refused for a criterion an automated check verifies, naming that check', async () => {
  await withHarness({ deploy: true, assignMethods: true }, (harness) => {
    const before = recordedSoFar(harness);
    const refused = harness.useCases.recordOwnerObservation(
      command(harness, { criterionId: CRITERION_AUTOMATED }),
    );
    assert.equal(refused.ok, false, 'a generic passing check must not be replaced by, or replaced with, an owner statement (F23-AC1)');
    const error = refused.ok ? undefined : refused.error;
    assert.equal(error?.code, 'Invalid');
    const message = error?.code === 'Invalid' ? error.fields[0]?.message ?? '' : '';
    assert.match(message, /AutomatedCheck/, 'the refusal names the method that actually verifies it (F23-AC1)');
    assert.match(message, /green check is not evidence about a criterion it never observed/, 'and why a weaker method cannot take its place');
    assertRecordedNothing(harness, before, 'a refused method recorded nothing (F23-AC1)');
  });
});

test('F23-AC1: a criterion with no assigned method cannot be given one by recording an owner test', async () => {
  await withHarness({ deploy: true, assignMethods: true }, (harness) => {
    const refused = harness.useCases.recordOwnerObservation(command(harness, { criterionId: CRITERION_UNASSIGNED }));
    assert.equal(refused.ok, false);
    const error = refused.ok ? undefined : refused.error;
    assert.equal(error?.code, 'Invalid');
    assert.match(
      error?.code === 'Invalid' ? error.fields[0]?.message ?? '' : '',
      /No verification method is assigned/,
      'the refusal says the method is the caller choice that is not being made here (F23-AC1)',
    );

    const unknown = harness.useCases.recordOwnerObservation(command(harness, { criterionId: 'AC-404' }));
    assert.equal(unknown.ok ? '' : unknown.error.code, 'NotFound', 'a criterion the captured scope does not name has nothing to test');
  });
});

/* -------------------------------------------------------------------------- */
/* F22-AC1, F23-AC4: the deployment binding                                    */
/* -------------------------------------------------------------------------- */

test('F22-AC1, F23-AC4: an observation is refused when the deployment it names is not this candidate deployment', async () => {
  await withHarness({ deploy: true, assignMethods: true }, (harness) => {
    const before = recordedSoFar(harness);
    const stalePreview = harness.useCases.recordOwnerObservation(
      command(harness, {
        observedAgainst: {
          kind: 'Deployment',
          component: COMPONENT,
          deploymentId: OTHER_DEPLOYMENT_ID,
          environment: OTHER_DEPLOYMENT_ENVIRONMENT,
        },
      }),
    );
    assert.equal(stalePreview.ok, false, 'an observation of a deployment this candidate does not carry is refused (F22-AC2)');
    const error = stalePreview.ok ? undefined : stalePreview.error;
    assert.equal(error?.code, 'Invalid');
    const message = error?.code === 'Invalid' ? error.fields[0]?.message ?? '' : '';
    assert.match(message, new RegExp(DEPLOYMENT_ID), 'the refusal names the deployment the candidate does have (F22-AC2)');
    assert.match(message, new RegExp(DEPLOYMENT_ENVIRONMENT));

    const unknownComponent = harness.useCases.recordOwnerObservation(
      command(harness, {
        observedAgainst: { kind: 'Deployment', component: 'api', deploymentId: DEPLOYMENT_ID, environment: DEPLOYMENT_ENVIRONMENT },
      }),
    );
    assert.equal(unknownComponent.ok, false, 'a component the candidate does not carry is refused by name (F22-AC1)');

    const wrongEnvironment = harness.useCases.recordOwnerObservation(
      command(harness, {
        observedAgainst: { kind: 'Deployment', component: COMPONENT, deploymentId: DEPLOYMENT_ID, environment: 'production' },
      }),
    );
    assert.equal(
      wrongEnvironment.ok,
      false,
      'the right deployment in the wrong environment is a different observation (F23-AC4)',
    );

    assertRecordedNothing(harness, before, 'a deployment the candidate does not carry recorded nothing (F22-AC1)');
  });
});

test('F23-AC4: "no deployment applies" is refused for a deployed candidate, so a local label cannot stand in for the preview', async () => {
  await withHarness({ deploy: true, assignMethods: true }, (harness) => {
    const refused = harness.useCases.recordOwnerObservation(
      command(harness, { observedAgainst: { kind: 'NoDeployment', reason: 'I tested it locally.' } }),
    );
    assert.equal(refused.ok, false, 'a deployed candidate cannot be observed as having no deployment (F23-AC4)');
    const error = refused.ok ? undefined : refused.error;
    assert.match(
      error?.code === 'Invalid' ? error.fields[0]?.message ?? '' : '',
      new RegExp(DEPLOYMENT_ID),
      'the refusal names the deployment that does apply, so the owner can observe that (F23-AC4)',
    );
    assert.equal(harness.attributionCount(), 0);
  });
});

test('F23-AC3, F23-AC4: a candidate with no deployment records an explicit statement, and the label is local', async () => {
  await withHarness({ deploy: false, assignMethods: true }, (harness) => {
    harness.setNow(T2);
    const report = record(harness, {
      observedAgainst: { kind: 'NoDeployment', reason: 'This project deploys nothing; the owner ran it from a clean checkout.' },
      evidence: { kind: 'CheckOutput', reference: 'logs/owner-run.log' },
    });
    assert.equal(
      report.observation.environment,
      'Local',
      'the environment label is derived from the target, so it cannot be claimed as a preview (F23-AC4)',
    );
    assert.equal(report.observation.deploymentId, null);
    assert.equal(report.observation.component, null);
    assert.equal(report.observation.evidenceKind, 'CheckOutput');

    const unattributed = harness.useCases.recordOwnerObservation(
      command(harness, { observedAgainst: { kind: 'NoDeployment', reason: '   ' } }),
    );
    assert.equal(unattributed.ok, false, 'an unexplained absence is refused; the statement needs a reason (F23-AC3)');
  });
});

/* -------------------------------------------------------------------------- */
/* F23-AC5: the distinctions                                                   */
/* -------------------------------------------------------------------------- */

test('F23-AC5: a capture failure, a behaviour failure and an unrecorded criterion stay three distinguishable facts', async () => {
  await withHarness({ deploy: true, assignMethods: true }, (harness) => {
    const before = unwrap(
      harness.useCases.listOwnerObservations({
        candidateId: harness.candidate.candidateId,
        candidateFingerprint: harness.candidate.candidateFingerprint,
      }),
      'read observations before anything was recorded',
    );
    assert.deepEqual(before, [], 'an owner test nobody performed is an absent observation, not a failure (F23-AC1)');
    const pendingRow = harness.database
      .prepare('SELECT status FROM evidence WHERE criterion_id = ? AND criterion_id IS NOT NULL')
      .get(CRITERION_UNASSIGNED);
    assert.equal(
      pendingRow?.['status'],
      'Untested',
      'a criterion with no assigned method reads Untested, which is not Failed (F23-AC1)',
    );

    harness.setNow(T2);
    const captured = record(harness, {
      observation: 'CaptureFailed',
      note: 'The recording tool never started.',
      evidence: { kind: 'Screenshot', reference: 'screenshots/never-written.png' },
    });
    assert.equal(captured.observation.status, 'Missing', 'a capture failure observed no behaviour (F23-AC5)');
    assert.equal(captured.observation.failureKind, 'CaptureFailure');
    assert.match(captured.observation.detail ?? '', /capture failure, not a behaviour failure/);
    assert.equal(
      harness.database.prepare('SELECT result FROM evidence WHERE criterion_id = ?').get(CRITERION_OWNER)?.['result'],
      null,
      'a capture that never happened records no check result at all (F23-AC5)',
    );

    harness.setNow(T3);
    const failed = record(harness, {
      observation: 'BehaviorFailed',
      note: 'The card omitted the failing check.',
    });
    assert.equal(failed.observation.status, 'Failed');
    assert.equal(failed.observation.failureKind, 'BehaviorFailure');
    assert.equal(failed.observation.detail, 'The card omitted the failing check.');
    assert.notEqual(
      failed.observation.status,
      captured.observation.status,
      'a behaviour failure and a capture failure are different outcomes (F23-AC5)',
    );

    const automated = harness.database
      .prepare('SELECT method_kind, status FROM evidence WHERE criterion_id = ?')
      .get(CRITERION_AUTOMATED);
    assert.equal(
      automated?.['method_kind'],
      'AutomatedCheck',
      'the automated criterion is still under its own method, on its own row (F23-AC1)',
    );
    const automatedCheck = harness.database
      .prepare('SELECT result FROM checks WHERE name = ?')
      .get(AUTOMATED_CHECK_NAME);
    assert.equal(
      automatedCheck?.['result'],
      'Passed',
      'a failed owner test left the automated check result exactly as it was (F23-AC5)',
    );

    const corrected = record(harness, { observation: 'BehaviorConfirmed' });
    assert.equal(corrected.observation.status, 'Verified');
    assert.equal(corrected.observation.failureKind, null, 'a corrected verdict is neither kind of failure (F23-AC5)');
    assert.equal(
      harness.verdictCount(CRITERION_OWNER),
      1,
      'one verdict per criterion per identity, so a repeat converges rather than appending (F23-AC1)',
    );
    const listed = unwrap(
      harness.useCases.listOwnerObservations({
        candidateId: harness.candidate.candidateId,
        candidateFingerprint: harness.candidate.candidateFingerprint,
      }),
      'read the recorded observations',
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.status, 'Verified', 'the read-back is the current verdict, not every verdict ever given (F23-AC5)');
  });
});

/* -------------------------------------------------------------------------- */
/* F20-AC3: rebinding to a replacement candidate                               */
/* -------------------------------------------------------------------------- */

test('F20-AC3: re-recording against a new candidate rebinds the observation and keeps the old one on its own build', async () => {
  await withHarness({ deploy: true, assignMethods: true }, (harness) => {
    harness.setNow(T1);
    record(harness, { note: 'Observed against the first build.' });

    harness.setNow(T2);
    const replacement = harness.supersede('d'.repeat(40) as CommitSha);
    const second = unwrap(
      harness.useCases.recordOwnerObservation(
        command(harness, {
          candidateId: replacement.candidateId,
          expectedCandidateFingerprint: replacement.candidateFingerprint,
          note: 'Observed against the replacement build.',
        }),
      ),
      'record against the replacement candidate',
    );

    assert.equal(second.observation.candidateId, replacement.candidateId);
    assert.equal(second.observation.candidateFingerprint, replacement.candidateFingerprint);
    assert.equal(second.observation.detail, 'Observed against the replacement build.');

    const onReplacement = unwrap(
      harness.useCases.listOwnerObservations({
        candidateId: replacement.candidateId,
        candidateFingerprint: replacement.candidateFingerprint,
      }),
      'read the replacement observations',
    );
    assert.equal(onReplacement.length, 1);
    assert.equal(onReplacement[0]?.observedBy, OWNER, 'each observation is attributed to the owner who made it (F25-AC1)');
    assert.equal(onReplacement[0]?.observedAt, T2, 'and to the instant it was made at (F23-AC3)');

    const onOriginal = unwrap(
      harness.useCases.listOwnerObservations({
        candidateId: harness.candidate.candidateId,
        candidateFingerprint: harness.candidate.candidateFingerprint,
      }),
      'read the original observations',
    );
    assert.equal(onOriginal.length, 1, 'the earlier build keeps its own observation (F20-AC3)');
    assert.equal(onOriginal[0]?.observedAt, T1, 'recorded at the instant it was actually made (F23-AC3)');
    assert.equal(onOriginal[0]?.detail, 'Observed against the first build.');
  });
});

test('F20-AC3: an observation for an identity no candidate carries reads as nothing', async () => {
  await withHarness({ deploy: true, assignMethods: true }, (harness) => {
    harness.setNow(T2);
    record(harness);

    const wrongIdentity = unwrap(
      harness.useCases.listOwnerObservations({
        candidateId: harness.candidate.candidateId,
        candidateFingerprint: 'fp_0000000000000000' as Fingerprint,
      }),
      'read observations for an identity nothing was recorded under',
    );
    assert.deepEqual(
      wrongIdentity,
      [],
      'the fingerprint is part of the query, so a mis-read identity shows no evidence rather than another build\'s (F23-AC1)',
    );

    const unknownCandidate = harness.useCases.listOwnerObservations({
      candidateId: 'cand_nope' as CandidateId,
      candidateFingerprint: harness.candidate.candidateFingerprint,
    });
    assert.equal(unknownCandidate.ok ? '' : unknownCandidate.error.code, 'NotFound');
  });
});

/* -------------------------------------------------------------------------- */
/* N02-AC2                                                                      */
/* -------------------------------------------------------------------------- */

test('N02-AC2: a credential pasted into an observation is redacted before it is stored or returned', async () => {
  await withHarness({ deploy: true, assignMethods: true }, (harness) => {
    harness.setNow(T2);
    const report = record(harness, {
      note: `I used the header Authorization: Bearer ${SEEDED_SECRET}`,
      evidence: { kind: 'Screenshot', reference: `screenshots/${SEEDED_SECRET}.png` },
    });

    assert.equal(
      report.observation.detail?.includes(SEEDED_SECRET) ?? true,
      false,
      'the stored detail reaches the owner without the credential (N02-AC2)',
    );
    assert.equal(
      report.observation.evidenceRef.includes(SEEDED_SECRET),
      false,
      'the evidence reference is redacted before it is stored (N02-AC2)',
    );

    const stored = harness.database
      .prepare('SELECT detail_redacted, artifact_ref FROM evidence WHERE criterion_id = ?')
      .get(CRITERION_OWNER);
    assert.equal(String(stored?.['detail_redacted']).includes(SEEDED_SECRET), false, 'the durable row holds no credential');
    assert.equal(String(stored?.['artifact_ref']).includes(SEEDED_SECRET), false);
    const attribution = harness.database
      .prepare('SELECT detail_json FROM audit_log WHERE action = ?')
      .get('RecordOwnerTest');
    assert.equal(String(attribution?.['detail_json']).includes(SEEDED_SECRET), false, 'nor does the attribution');
  });
});