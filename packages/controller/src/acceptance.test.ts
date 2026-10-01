/**
 * Behavioural proof for owner acceptance and feedback (F25-AC1, F25-AC2, F25-AC3,
 * F25-AC4, F25-AC5, F24-AC2, F24-AC3).
 *
 * Every case runs against a real SQLite file in a fresh temporary directory, opened by the
 * real `openDatabase` and brought to the real `migrate` version. No inline fixture schema
 * appears here, so the `owner_decisions` foreign key to a real owner, the CHECK that an
 * acceptance decision carries an acceptance state, and the candidate fingerprint CHECK are
 * exercised rather than assumed: a decision for an identity that is not a provisioned
 * owner fails in these cases rather than in production.
 *
 * Criterion verdicts are written through the real `SqliteObservationJournal` from records
 * the real `@shiploop/verification` `buildEvidencePack` produced, so "Verified" here means
 * the same thing it means to the review card. The cases worth reading first:
 *
 *   - acceptance records the owner, the time, the scope revision, the candidate fingerprint
 *     and the observed deployment, and nothing else may write it (F25-AC1, F25-AC4);
 *   - a criterion whose owner test has not been recorded blocks acceptance, and the refusal
 *     names every outstanding criterion, so incomplete work stays inspectable with reasons
 *     (F25-AC1, F24-AC3);
 *   - a change request retains the owner's feedback against the tested candidate and names
 *     the criteria it lands on, and a later acceptance carries that feedback forward
 *     (F25-AC2);
 *   - an acceptance recorded for a candidate that has since been superseded reads `Stale`
 *     with the differing inputs named, and writing acceptance for it is refused (F25-AC3);
 *   - a non-owner role is refused, and a decision for an owner that does not exist cannot be
 *     written at all (F25-AC4);
 *   - a green required check and a healthy preview deployment do not make an untested owner
 *     criterion verified, so acceptance is never inferred from a check or a deployment
 *     (F25-AC4, F23-AC1);
 *   - a change request records a note and creates no scope revision and no work item, so
 *     out-of-scope feedback cannot silently broaden the authorized task (F25-AC5).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalize, fingerprint } from '@shiploop/domain';
import type {
  CandidateId,
  CommitSha,
  CriterionVerificationMethod,
  DomainError,
  Fingerprint,
  OwnerId,
  ProjectId,
  Result,
  ScopeSnapshot,
  WorkItemId,
} from '@shiploop/domain';
import { buildEvidencePack } from '@shiploop/verification';
import type { EvidenceBundle, ObservationInput } from '@shiploop/verification';
import {
  CandidateRepository,
  OwnerDecisionRepository,
  OwnerRepository,
  ProcedureRepository,
  ProjectProfileRepository,
  ScopeRepository,
  WorkItemRepository,
  migrate,
  openDatabase,
} from '@shiploop/storage';
import type { Database, ProfilePolicy, ProjectProfileContent } from '@shiploop/storage';
import { RECIPE_SUBJECT_KEY } from './profiles.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';
import { SqliteObservationJournal } from './verification.ts';
import { createAcceptanceUseCases } from './acceptance.ts';
import type { AcceptanceUseCases } from './acceptance.ts';

const T0 = '2026-10-01T09:00:00.000Z';
const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-01T11:00:00.000Z';

const PROJECT = 'proj-acceptance' as ProjectId;
const OWNER = 'owner-acceptance' as OwnerId;
const NOT_AN_OWNER = 'owner-that-does-not-exist' as OwnerId;
const ISSUE_IDENTIFIER = 'SHIP-410';
const RECIPE_ID = 'recipe-acceptance';
const HEAD = '3d1f0a2b4c5d6e7f8091a2b3c4d5e6f708192a3b' as CommitSha;
const NEXT_HEAD = '4e2a1b3c5d6e7f8091a2b3c4d5e6f708192a3b4c' as CommitSha;
const BASE = '0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d' as CommitSha;
const BASE_ADVANCED = '1b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c' as CommitSha;

const CRITERION_CHECKED = 'AC-1';
const CRITERION_OWNER = 'AC-2';
const CRITERION_DEPLOYED = 'AC-3';
const CRITERION_UNASSIGNED = 'AC-4';

const ALL_CRITERIA: readonly string[] = [CRITERION_CHECKED, CRITERION_OWNER, CRITERION_DEPLOYED, CRITERION_UNASSIGNED];

const DEPLOYMENT_ID = 'deployment-acceptance';
const PREVIEW_URL = 'https://acceptance.preview.invalid';

const OWNER_ACTOR: OwnerActor = {
  actorId: OWNER,
  role: 'Owner',
  ownerId: OWNER,
  sessionId: 'session-acceptance' as OwnerActor['sessionId'],
};

const CODING_ACTOR: OwnerActor = {
  actorId: 'agent-coding',
  role: 'CodingAgent',
  ownerId: null,
  sessionId: null,
};

function unwrap<T>(result: Result<T, DomainError>, what: string): T {
  assert.ok(result.ok, `${what} failed: ${result.ok ? '' : result.error.reason}`);
  return result.value;
}

function fingerprintOf(value: unknown): Fingerprint {
  return fingerprint(value);
}

/**
 * The verification method a fixture criterion is assigned.
 *
 * Built per variant rather than from a computed key so each method keeps the payload its
 * own type requires: an `AutomatedCheck` names a check, while a `BrowserEvidence` names the
 * evidence that observed it, and a caller that could produce either from one value could
 * also produce a method that names a check which does not exist (F23-AC1).
 */
function methodFor(method: HarnessMethod, criterionId: string, text: string): CriterionVerificationMethod {
  switch (method) {
    case 'OwnerTest':
      return { kind: 'OwnerTest', instructions: text };
    // A deployed criterion's method names the very evidence that observed it, so the two
    // cannot disagree about which capture verified the criterion (F23-AC1).
    case 'BrowserEvidence':
      return { kind: 'BrowserEvidence', evidenceId: `evid-${criterionId}` };
    case 'ApiEvidence':
      return { kind: 'ApiEvidence', evidenceId: `evid-${criterionId}` };
    case 'AutomatedCheck':
      return { kind: 'AutomatedCheck', checkId: 'check-1' };
    case 'Untested':
      return { kind: 'Untested', reason: 'No verification method is assigned to this criterion.' };
  }
}

type HarnessMethod = 'AutomatedCheck' | 'OwnerTest' | 'BrowserEvidence' | 'ApiEvidence' | 'Untested';

/**
 * The method each fixture criterion is verified by.
 *
 * Stated once so a criterion cannot be observed through a method the scope never assigned
 * it: an unassigned criterion has no verified result whatever an observation claims
 * (F23-AC1).
 */
const METHOD_FOR_CRITERION: Readonly<Record<string, HarnessMethod>> = {
  [CRITERION_CHECKED]: 'AutomatedCheck',
  [CRITERION_OWNER]: 'OwnerTest',
  [CRITERION_DEPLOYED]: 'BrowserEvidence',
  [CRITERION_UNASSIGNED]: 'ApiEvidence',
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

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
      repository: 'fixture/repo',
      ticketProvider: 'fixture-ticket',
      ticketTeamKey: 'SHIP',
      baseBranch: 'main',
      targetBranch: 'main',
      deploymentProvider: 'fixture-deployment',
      engine: 'fixture-engine',
      previewComponents: [{ component: 'web', environment: 'preview' }],
    },
    policy,
    recipe: 'Saved through the recipe use case',
    environment: { runtime: 'node 24', ports: [4200], secretReferences: [] },
  };
}

function scopeFor(workItemId: WorkItemId): ScopeSnapshot {
  return {
    workItemId,
    issueId: 'issue-acceptance',
    issueIdentifier: ISSUE_IDENTIFIER,
    title: 'Confirm the acceptance gate and the retained owner feedback',
    description: 'An owner decision must be recorded against the exact candidate that was tested.',
    providerRevision: 'rev-1',
    priority: 'High',
    dependencyIssueIds: [],
    acceptanceCriteria: [
      { id: CRITERION_CHECKED, text: 'The required check passes for the candidate head' },
      { id: CRITERION_OWNER, text: 'The owner finds the confirmation wording acceptable' },
      { id: CRITERION_DEPLOYED, text: 'The preview the owner tested is the candidate deployment' },
      { id: CRITERION_UNASSIGNED, text: 'The export keeps the run history readable' },
    ],
    retrievedAt: T0,
  };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                      */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly database: Database;
  readonly useCases: AcceptanceUseCases;
  readonly candidates: CandidateRepository;
  readonly journal: SqliteObservationJournal;
  readonly scope: ScopeRepository;
  readonly workItemId: WorkItemId;
  readonly candidateId: CandidateId;
  readonly candidateFingerprint: Fingerprint;
  readonly scopeRevision: number;
  /** Records one criterion's observation through the real evidence pack builder. */
  observe(options: {
    readonly criterionId: string;
    readonly method: HarnessMethod;
    readonly confirmed: boolean;
    readonly component?: string | null;
    readonly deploymentId?: string | null;
  }): void;
  /** Records a replacement build for the same work item, which is what makes acceptance stale. */
  supersede(options?: { readonly headSha?: CommitSha; readonly baseSha?: CommitSha }): CandidateId;
  /** Advances the reviewer's clock. */
  at(instant: string): void;
  now(): string;
}

interface HarnessOptions {
  /** Criterion ids observed as confirmed before the body runs; everything else stays open. */
  readonly confirmed?: readonly string[];
}

async function withHarness(
  options: HarnessOptions,
  body: (harness: Harness) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-controller-acceptance-'));
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
        title: 'Confirm the acceptance gate and the retained owner feedback',
        externalIssueId: 'issue-acceptance',
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
        correlationId: 'correlation-acceptance',
      }),
      'capture the scope snapshot',
    );

    const identity = (headSha: CommitSha, baseSha: CommitSha) => ({
      headSha,
      baseSha,
      scopeFingerprint: snapshot.scopeFingerprint,
      profileVersionId: profile.profileVersionId,
      procedureVersionId: procedure.procedureVersionId,
      environmentFingerprint: fingerprintOf({ environment: 'node 24' }),
      policyFingerprint: profile.contentFingerprint,
      components: [
        {
          component: 'web',
          deploymentId: DEPLOYMENT_ID,
          deploymentUrl: PREVIEW_URL,
          environment: 'preview',
        },
      ],
    });

    const candidate = unwrap(
      candidates.record({
        attemptId: null,
        workItemId: workItem.workItemId,
        identity: identity(HEAD, BASE),
        pullRequestId: 'pr_acceptance_1',
        targetBranch: 'main',
        recordedAt: T0,
        correlationId: 'correlation-acceptance',
      }),
      'record the candidate',
    );

    let instant = T0;
    const clock: ControllerClock = { now: () => instant };
    const useCases = createAcceptanceUseCases({
      clock,
      decisions,
      candidates,
      evidence: journal,
      scope: { latestScopeSnapshot: (id) => workItems.latestScopeSnapshot(id) },
    });

    const observe = (input: {
      criterionId: string;
      method: 'AutomatedCheck' | 'OwnerTest' | 'BrowserEvidence' | 'ApiEvidence' | 'Untested';
      confirmed: boolean;
      component?: string | null;
      deploymentId?: string | null;
    }): void => {
      const requirement = snapshot.acceptanceCriteria.find((entry) => entry.id === input.criterionId);
      assert.ok(requirement !== undefined, `criterion ${input.criterionId} is in the captured scope`);
      // A deployed observation must name the deployment it watched (F23-AC3), and an
      // automated check is a local observation, so the two are not given the same shape.
      const deployed = input.method === 'BrowserEvidence' || input.method === 'ApiEvidence';
      const observation: ObservationInput = {
        criterionId: input.criterionId,
        evidenceId: `evid-${input.criterionId}` as ObservationInput['evidenceId'],
        observation: input.confirmed ? 'BehaviorConfirmed' : 'BehaviorFailed',
        environment: deployed ? 'Preview' : 'Local',
        capturedAt: T1,
        component: input.component ?? null,
        deploymentId: deployed ? (input.deploymentId ?? DEPLOYMENT_ID) : null,
        // A deployed criterion keeps the reference that proves what was observed: a UI
        // flow a screenshot, an API flow a sanitized exchange (F23-AC2).
        artifacts:
          input.method === 'BrowserEvidence'
            ? [{ kind: 'Screenshot' as const, name: `screenshot-${input.criterionId}`, capturedAt: T1 }]
            : [],
        apiExchange:
          input.method === 'ApiEvidence'
            ? { request: 'GET /shiploop/acceptance', result: '200 with the acceptance summary' }
            : null,
        detail: input.confirmed ? 'The owner observed the behaviour.' : 'The observation reported a failure.',
      };
      if (input.method === 'AutomatedCheck') {
        // An automated criterion is bound to a check that actually ran, so the check row is
        // recorded first: a criterion cannot name a check no execution produced (F20-AC2).
        unwrap(
          journal.recordCheck({
            candidate,
            record: {
              checkId: 'check-1',
              name: 'check-1',
              origin: 'LocalCheck',
              required: true,
              result: input.confirmed ? 'Passed' : 'Failed',
              candidateFingerprint: candidate.candidateFingerprint,
              startedAt: T0,
              endedAt: T1,
              exitCode: input.confirmed ? 0 : 1,
              artifactRef: 'artifact://acceptance/check-1.log',
              detail: input.confirmed ? 'The check exited 0.' : 'The check exited 1.',
              notApplicableApprovedByPolicy: false,
            },
            correlationId: 'correlation-acceptance',
          }),
          'record the check the automated criterion names',
        );
      }
      const bundle: Result<EvidenceBundle, DomainError> = buildEvidencePack({
        bundleId: `bundle-${input.criterionId}`,
        correlationId: 'correlation-acceptance',
        identity: identity(HEAD, BASE),
        eligiblePreview: {
          component: 'web',
          deploymentId: DEPLOYMENT_ID,
          environment: 'preview',
          candidateFingerprint: candidate.candidateFingerprint,
        },
        requirements: [
          {
            criterionId: input.criterionId,
            text: requirement.text,
            method: methodFor(input.method, input.criterionId, requirement.text),
            requiresDeployedObservation: input.method === 'BrowserEvidence',
          },
        ],
        observations: [observation],
      });
      const built = unwrap(bundle, `build the evidence pack for ${input.criterionId}`);
      for (const record of built.records) {
        unwrap(
          journal.recordCriterion({
            candidate,
            bundleFingerprint: candidate.candidateFingerprint,
            record,
            recordedAt: T1,
            correlationId: 'correlation-acceptance',
          }),
          `record the criterion verdict for ${input.criterionId}`,
        );
      }
    };

    for (const criterionId of options.confirmed ?? []) {
      observe({ criterionId, method: METHOD_FOR_CRITERION[criterionId] ?? 'Untested', confirmed: true });
    }

    const harness: Harness = {
      database,
      useCases,
      candidates,
      journal,
      scope,
      workItemId: workItem.workItemId,
      candidateId: candidate.candidateId,
      candidateFingerprint: candidate.candidateFingerprint,
      scopeRevision: snapshot.sequenceNumber,
      observe,
      supersede: (overrides = {}) => {
        const next = unwrap(
          candidates.record({
            attemptId: null,
            workItemId: workItem.workItemId,
            identity: identity(overrides.headSha ?? NEXT_HEAD, overrides.baseSha ?? BASE),
            pullRequestId: 'pr_acceptance_2',
            targetBranch: 'main',
            recordedAt: T2,
            correlationId: 'correlation-acceptance',
          }),
          'record the replacement candidate',
        );
        return next.candidateId;
      },
      at: (value) => {
        instant = value;
      },
      now: () => instant,
    };
    await body(harness);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* F25-AC1, F25-AC4: what an acceptance records, and who may record it         */
/* -------------------------------------------------------------------------- */

test('F25-AC1: acceptance records the authenticated owner, the time, the scope revision, the candidate fingerprint and the observed deployment', async () => {
  await withHarness({ confirmed: ALL_CRITERIA }, (h) => {
    h.at(T2);
    const report = unwrap(
      h.useCases.recordAcceptance({
        candidateId: h.candidateId,
        actor: OWNER_ACTOR,
        note: 'The confirmation wording reads correctly.',
        correlationId: 'correlation-acceptance',
      }),
      'record acceptance',
    );

    assert.equal(report.state, 'Accepted');
    assert.equal(report.ownerId, OWNER);
    assert.equal(report.decidedAt, T2);
    assert.equal(report.candidateFingerprint, h.candidateFingerprint);
    assert.equal(report.scopeFingerprint.length > 0, true);
    assert.deepEqual(
      report.observedDeployments.map((component) => [component.component, component.deploymentId, component.deploymentUrl]),
      [['web', DEPLOYMENT_ID, PREVIEW_URL]],
    );

    // The durable row is what a later gate reads, and it names a real owner.
    const row = h.database
      .prepare(
        `SELECT d.actor_owner_id, d.acceptance_state, d.candidate_fingerprint, o.owner_id
           FROM owner_decisions d JOIN owners o ON o.owner_id = d.actor_owner_id
          WHERE d.decision_id = ?`,
      )
      .get(report.decisionId);
    assert.ok(row !== undefined, 'the acceptance decision is durable');
    assert.equal(row['actor_owner_id'], OWNER);
    assert.equal(row['owner_id'], OWNER);
    assert.equal(row['acceptance_state'], 'Accepted');
    assert.equal(row['candidate_fingerprint'], h.candidateFingerprint);
  });
});

test('F25-AC4: only the owner may accept or request changes, and a decision for an owner that does not exist cannot be written', async () => {
  await withHarness({ confirmed: ALL_CRITERIA }, (h) => {

    const byAgent = h.useCases.recordAcceptance({
      candidateId: h.candidateId,
      actor: CODING_ACTOR,
      note: null,
      correlationId: 'correlation-acceptance',
    });
    assert.equal(byAgent.ok, false);
    if (!byAgent.ok) {
      assert.equal(byAgent.error.code, 'Forbidden');
      assert.match(byAgent.error.reason, /F25-AC1, F25-AC4/);
    }

    const feedbackByAgent = h.useCases.requestChanges({
      candidateId: h.candidateId,
      actor: CODING_ACTOR,
      reason: 'The run finished, so the candidate is good.',
      correlationId: 'correlation-acceptance',
    });
    assert.equal(feedbackByAgent.ok, false);
    if (!feedbackByAgent.ok) assert.equal(feedbackByAgent.error.code, 'Forbidden');

    // A caller that reaches past the role check still cannot write a decision for an
    // identity that is not a provisioned owner: the column is a real foreign key.
    const forged = new OwnerDecisionRepository(h.database);
    const written = forged.recordAcceptance({
      workItemId: h.workItemId,
      candidateFingerprint: h.candidateFingerprint,
      scopeFingerprint: fingerprintOf({ scope: 'captured' }),
      actorOwnerId: NOT_AN_OWNER,
      note: null,
      createdAt: T1,
      correlationId: 'correlation-acceptance',
    });
    assert.equal(written.ok, false);
    if (!written.ok) assert.equal(written.error.code, 'Unavailable');

    const decided = h.database.prepare('SELECT COUNT(*) AS n FROM owner_decisions').get();
    assert.equal(decided?.['n'], 0, 'no decision row exists after three refusals');
  });
});

/* -------------------------------------------------------------------------- */
/* F25-AC1, F24-AC3: acceptance is a verdict over every criterion               */
/* -------------------------------------------------------------------------- */

test('F25-AC1: acceptance is refused while any criterion is unverified, and every outstanding criterion is named', async () => {
  await withHarness({ confirmed: [CRITERION_CHECKED] }, (h) => {
    const gate = unwrap(h.useCases.acceptanceGate(h.candidateId), 'read the acceptance gate');
    assert.equal(gate.ready, false);
    // The owner test is the reason the owner has not decided yet, and the deployed and
    // unassigned criteria have no observation at all. All three are named rather than
    // summarised, so the owner can see what is missing instead of only being turned away.
    assert.deepEqual(
      [...gate.outstandingCriterionIds].sort(),
      [CRITERION_OWNER, CRITERION_DEPLOYED, CRITERION_UNASSIGNED].sort(),
    );
    // A criterion nothing observed reads `Untested` with `observed: false`: the method is
    // stored on the evidence row, so a criterion with no row has no method to report and
    // cannot be counted as anything a decision may rely on (F23-AC1).
    assert.equal(gate.criteria.find((entry) => entry.criterionId === CRITERION_OWNER)?.status, 'Untested');
    assert.equal(gate.criteria.find((entry) => entry.criterionId === CRITERION_OWNER)?.observed, false);
    assert.equal(gate.criteria.find((entry) => entry.criterionId === CRITERION_UNASSIGNED)?.observed, false);
    assert.equal(gate.criteria.find((entry) => entry.criterionId === CRITERION_CHECKED)?.status, 'Verified');

    const refused = h.useCases.recordAcceptance({
      candidateId: h.candidateId,
      actor: OWNER_ACTOR,
      note: null,
      correlationId: 'correlation-acceptance',
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.error.code, 'Blocked');
      assert.match(refused.error.reason, /3 of 4 criteria are not verified/);
      const named = refused.error.prerequisites.map((entry) => entry.name);
      assert.deepEqual(
        named,
        [`Criterion ${CRITERION_OWNER}`, `Criterion ${CRITERION_DEPLOYED}`, `Criterion ${CRITERION_UNASSIGNED}`],
      );
    }

    const decided = h.database.prepare('SELECT COUNT(*) AS n FROM owner_decisions').get();
    assert.equal(decided?.['n'], 0, 'a refused acceptance writes no decision');
  });
});

test('F25-AC4: acceptance is never inferred from a check result or a deployment status', async () => {
  await withHarness({}, (h) => {
    // The candidate's preview deployment is live and usable, and the required check is
    // recorded as passed. Neither may promote the owner-test criterion.
    h.journal.recordCheck({
      candidate: unwrap(h.candidates.get(h.candidateId), 'read the candidate'),
      record: {
        checkId: 'pnpm test',
        name: 'pnpm test',
        origin: 'ProviderCi',
        required: true,
        result: 'Passed',
        candidateFingerprint: h.candidateFingerprint,
        startedAt: T0,
        endedAt: T1,
        exitCode: 0,
        artifactRef: 'artifact://acceptance/test.log',
        detail: 'All tests passed.',
        notApplicableApprovedByPolicy: false,
      },
      correlationId: 'correlation-acceptance',
    });
    h.observe({ criterionId: CRITERION_CHECKED, method: 'AutomatedCheck', confirmed: true });
    h.observe({
      criterionId: CRITERION_DEPLOYED,
      method: 'BrowserEvidence',
      confirmed: true,
      component: 'web',
      deploymentId: DEPLOYMENT_ID,
    });

    const view = unwrap(h.useCases.currentAcceptance(h.candidateId), 'read the current acceptance');
    assert.equal(view.state, 'NotRequested');
    assert.equal(view.decisionId, null);

    const refused = h.useCases.recordAcceptance({
      candidateId: h.candidateId,
      actor: OWNER_ACTOR,
      note: 'The checks are green and the preview is up.',
      correlationId: 'correlation-acceptance',
    });
    assert.equal(refused.ok, false, 'green checks and a live deployment do not verify an owner test');
    if (!refused.ok && refused.error.code === 'Blocked') {
      assert.ok(
        refused.error.prerequisites.some((entry) => entry.name === `Criterion ${CRITERION_OWNER}`),
        'the outstanding owner test is named',
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* F25-AC2, F25-AC5: retained feedback                                         */
/* -------------------------------------------------------------------------- */

test('F25-AC2: a change request retains the feedback against the tested candidate and names the criteria it lands on', async () => {
  await withHarness({ confirmed: [CRITERION_CHECKED] }, (h) => {
    const reason = 'The confirmation button reads "Ship it". Say what was accepted instead.';
    const report = unwrap(
      h.useCases.requestChanges({
        candidateId: h.candidateId,
        actor: OWNER_ACTOR,
        reason,
        correlationId: 'correlation-acceptance',
      }),
      'request changes',
    );
    assert.equal(report.state, 'ChangesRequested');
    assert.equal(report.feedback, reason);
    assert.deepEqual(
      [...report.outstandingCriterionIds].sort(),
      [CRITERION_OWNER, CRITERION_DEPLOYED, CRITERION_UNASSIGNED].sort(),
    );

    // The feedback survives on the candidate, so a fix pass reads the reason that produced
    // it rather than only learning that something was rejected.
    const view = unwrap(h.useCases.currentAcceptance(h.candidateId), 'read the current acceptance');
    assert.equal(view.state, 'ChangesRequested');
    assert.equal(view.retainedFeedback.length, 1);
    assert.equal(view.retainedFeedback[0]?.feedback, reason);
    assert.equal(view.retainedFeedback[0]?.decisionId, report.decisionId);

    // Once the owner has tested the remaining criteria, the acceptance carries the
    // feedback forward, so the record of what was fixed is on the decision that accepted
    // the result rather than only in the rejected one (F25-AC2).
    h.observe({ criterionId: CRITERION_OWNER, method: 'OwnerTest', confirmed: true });
    h.observe({ criterionId: CRITERION_DEPLOYED, method: 'BrowserEvidence', confirmed: true, component: 'web', deploymentId: DEPLOYMENT_ID });
    h.observe({ criterionId: CRITERION_UNASSIGNED, method: 'ApiEvidence', confirmed: true });
    const accepted = unwrap(
      h.useCases.recordAcceptance({
        candidateId: h.candidateId,
        actor: OWNER_ACTOR,
        note: null,
        correlationId: 'correlation-acceptance',
      }),
      'record acceptance after the fix',
    );
    assert.equal(accepted.state, 'Accepted');
    assert.deepEqual(accepted.feedbackHonoured.map((entry) => entry.decisionId), [report.decisionId]);

    const empty = h.useCases.requestChanges({
      candidateId: h.candidateId,
      actor: OWNER_ACTOR,
      reason: '   ',
      correlationId: 'correlation-acceptance',
    });
    assert.equal(empty.ok, false, 'a change request with no reason is refused');
    if (!empty.ok) assert.equal(empty.error.code, 'Invalid');
  });
});

test('F25-AC5: a change request records feedback as a note and creates no scope revision and no work item', async () => {
  await withHarness({ confirmed: [CRITERION_CHECKED] }, (h) => {
    const before = {
      snapshots: h.database.prepare('SELECT COUNT(*) AS n FROM scope_snapshots').get()?.['n'],
      workItems: h.database.prepare('SELECT COUNT(*) AS n FROM work_items').get()?.['n'],
      criteria: h.database.prepare('SELECT COUNT(*) AS n FROM evidence').get()?.['n'],
    };

    unwrap(
      h.useCases.requestChanges({
        candidateId: h.candidateId,
        actor: OWNER_ACTOR,
        // Feedback that is plainly outside the agreed scope: it asks for a feature the
        // captured scope does not mention.
        reason: 'While you are in there, add dark mode and a mobile layout as well.',
        correlationId: 'correlation-acceptance',
      }),
      'request changes with out-of-scope feedback',
    );

    const after = {
      snapshots: h.database.prepare('SELECT COUNT(*) AS n FROM scope_snapshots').get()?.['n'],
      workItems: h.database.prepare('SELECT COUNT(*) AS n FROM work_items').get()?.['n'],
      criteria: h.database.prepare('SELECT COUNT(*) AS n FROM evidence').get()?.['n'],
    };
    // Nothing about the authorized task moved: the feedback is stored, and turning it into
    // work is a scope decision the scope layer has to be asked for.
    assert.deepEqual(after, before);
    assert.equal(after.snapshots, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* F25-AC3: a changed identity makes an acceptance Stale                        */
/* -------------------------------------------------------------------------- */

test('F25-AC3: an acceptance recorded for a candidate that has been superseded reads Stale and cannot be written again', async () => {
  await withHarness({ confirmed: ALL_CRITERIA }, (h) => {
    h.observe({ criterionId: CRITERION_DEPLOYED, method: 'BrowserEvidence', confirmed: true, component: 'web', deploymentId: DEPLOYMENT_ID });
    unwrap(
      h.useCases.recordAcceptance({
        candidateId: h.candidateId,
        actor: OWNER_ACTOR,
        note: null,
        correlationId: 'correlation-acceptance',
      }),
      'record acceptance',
    );
    const current = unwrap(h.useCases.currentAcceptance(h.candidateId), 'read the acceptance before the move');
    assert.equal(current.state, 'Accepted');

    // A replacement build for the same work item is what a new head looks like durably.
    h.supersede();

    const stale = unwrap(h.useCases.currentAcceptance(h.candidateId), 'read the acceptance after the move');
    assert.equal(stale.state, 'Stale', 'the old acceptance is not current');
    assert.deepEqual(stale.staleReasons, ['HeadChanged']);
    assert.equal(stale.decisionId, current.decisionId, 'the decision is still on record');

    // The replacement build starts with no criteria satisfied, so it cannot inherit the
    // previous build's verdicts and it cannot be accepted on the old decision (F20-AC3).
    const listed = unwrap(h.candidates.listForWorkItem(h.workItemId), 'list the candidates for the work item');
    const replacementId = listed.at(-1)?.candidateId ?? h.candidateId;
    const gate = unwrap(h.useCases.acceptanceGate(replacementId), 'read the replacement gate');
    assert.equal(gate.ready, false);
    assert.equal(gate.criteria.every((entry) => entry.observed === false), true);

    const refused = h.useCases.recordAcceptance({
      candidateId: h.candidateId,
      actor: OWNER_ACTOR,
      note: null,
      correlationId: 'correlation-acceptance',
    });
    assert.equal(refused.ok, false, 'a superseded candidate cannot be accepted');
    if (!refused.ok) {
      assert.equal(refused.error.code, 'Conflict');
      assert.match(refused.error.reason, /HeadChanged/);
    }
  });
});

test('F25-AC3: an advanced merge base makes an otherwise current acceptance Stale', async () => {
  await withHarness({ confirmed: ALL_CRITERIA }, (h) => {
    h.observe({ criterionId: CRITERION_DEPLOYED, method: 'BrowserEvidence', confirmed: true, component: 'web', deploymentId: DEPLOYMENT_ID });
    unwrap(
      h.useCases.recordAcceptance({
        candidateId: h.candidateId,
        actor: OWNER_ACTOR,
        note: null,
        correlationId: 'correlation-acceptance',
      }),
      'record acceptance',
    );
    // Only the base moves, so the staleness reason is the base and nothing else.
    h.supersede({ headSha: HEAD, baseSha: BASE_ADVANCED });

    const stale = unwrap(h.useCases.currentAcceptance(h.candidateId), 'read the acceptance after the base moved');
    assert.equal(stale.state, 'Stale');
    assert.deepEqual(stale.staleReasons, ['BaseChanged']);
  });
});

/* -------------------------------------------------------------------------- */
/* F24-AC2: the gate the card renders                                          */
/* -------------------------------------------------------------------------- */

test('F24-AC2: the acceptance gate reports the criteria and their standing, and stays inspectable when it cannot be satisfied', async () => {
  await withHarness({ confirmed: [CRITERION_CHECKED] }, (h) => {
    h.observe({ criterionId: CRITERION_OWNER, method: 'OwnerTest', confirmed: false });
    const gate = unwrap(h.useCases.acceptanceGate(h.candidateId), 'read the acceptance gate');

    assert.equal(gate.candidateFingerprint, h.candidateFingerprint);
    assert.equal(gate.headSha, HEAD);
    assert.equal(gate.ready, false);
    assert.equal(gate.criteria.length, 4);
    assert.deepEqual(
      gate.criteria.map((entry) => [entry.criterionId, entry.methodKind, entry.status]),
      [
        [CRITERION_CHECKED, 'AutomatedCheck', 'Verified'],
        [CRITERION_OWNER, 'OwnerTest', 'Failed'],
        [CRITERION_DEPLOYED, 'Untested', 'Untested'],
        [CRITERION_UNASSIGNED, 'Untested', 'Untested'],
      ],
      'a failed owner test and an unobserved criterion are different facts and both are shown',
    );
    assert.deepEqual(
      [...gate.outstandingCriterionIds].sort(),
      [CRITERION_OWNER, CRITERION_DEPLOYED, CRITERION_UNASSIGNED].sort(),
    );
  });
});
