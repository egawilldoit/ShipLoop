/**
 * Behavioural proof for required checks, the review card and criterion evidence
 * (F20-AC1, F20-AC2, F20-AC3, F20-AC4, F20-AC5, F23-AC1, F23-AC3, F23-AC4, F23-AC5,
 * F24-AC2, F24-AC3, F24-AC4, N02-AC2).
 *
 * Every case runs against a real SQLite file in a fresh temporary directory, opened by
 * the real `openDatabase` and brought to the real `migrate` version. No inline fixture
 * schema appears here, so the foreign keys, enums and CHECKs the journal depends on are
 * exercised rather than assumed: a check result outside `CHECK_RESULTS`, an evidence row
 * whose method and check disagree, or a `Verified` row with no observation fails in these
 * cases instead of at the first owner request.
 *
 * The checks, candidates, scope, profiles, procedure versions and work items are read and
 * written through the real `@shiploop/storage` repositories, and a local check is executed
 * by spawning a real Node process through the verification package's own `runCheck`, so
 * the recorded exit code and the output tail in the detail are an observation rather than
 * a fixture. The provider half is driven through the exported `FakeGitAdapter`, which is
 * the real adapter contract answering with check observations: the case scripts which
 * names it reports so one case cannot be decided by a fixture written for another, and the
 * `Missing` entry the adapter synthesises for a required name it never ran is what proves
 * a required check that never ran is not a pass.
 *
 * The cases worth reading first:
 *
 *   - a required check the recipe does not define and the provider never ran is `Missing`;
 *     one the provider reports as still running is `Waiting`; a failing check the profile
 *     did not require is reported without blocking; and a detail that claims every check
 *     passed changes no result (F20-AC2);
 *   - a policy revision change between two runs makes the recorded result `Stale` and
 *     closes ready-for-owner-test; the rerun writes a new observation while the check the
 *     provider has not rerun keeps reading `Stale` (F20-AC3);
 *   - a failure the base commit also reported is attributed to the base and is still not
 *     waived, while a base that passed makes it change-introduced and an unobserved base
 *     is `Indeterminate` (F20-AC4);
 *   - a proposed policy revision that removes an owner-required check, or that tries to
 *     retire one with a NotApplicable approval, is refused before anything runs, while a
 *     revision that adds a check is allowed (F20-AC5);
 *   - a criterion with no linked observation is `Untested` or `Missing` and never
 *     `Verified`, even when every check is green; a local check cannot satisfy a criterion
 *     requiring deployed behaviour; and a capture failure is not a behaviour failure
 *     (F23-AC1, F23-AC4, F23-AC5);
 *   - a card for a superseded candidate is refused with a `Conflict` naming the expected
 *     and the actual identity, and the replacement inherits none of its results
 *     (F24-AC4, F20-AC3).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { asCommitSha, canonicalize, err, fingerprint, isCommitSha, ok } from '@shiploop/domain';
import type {
  CommitSha,
  DomainError,
  EvidenceId,
  Fingerprint,
  OperationId,
  OwnerId,
  ProjectId,
  Result,
  ScopeSnapshot,
  WorkItemId,
} from '@shiploop/domain';
import type { AdapterContext, ProviderCheckObservation } from '@shiploop/adapters';
import {
  FIXED_EARLIER_INSTANT,
  FIXED_LATER_INSTANT,
  FIXTURE_BASE_SHA,
  FIXTURE_HEAD_SHA,
  FIXTURE_REPOSITORY,
  createFakeAdapterSet,
} from '@shiploop/adapters';
import { recipeFingerprint, runCheck } from '@shiploop/verification';
import type {
  BoundedCommand,
  CommandRunOptions,
  CommandRunResult,
  CommandRunStatus,
  ObservationInput,
  RecipeVersion,
  RequiredCheckPolicy,
} from '@shiploop/verification';
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
  ScopeSnapshotRecord,
} from '@shiploop/storage';
import { RECIPE_SUBJECT_KEY } from './profiles.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';
import { SqliteObservationJournal, createVerificationUseCases } from './verification.ts';
import type {
  EvidencePackRequest,
  OwnerTestOutcome,
  ProjectCheckPolicy,
  ProjectEnvironment,
  ReviewCard,
  VerificationUseCases,
} from './verification.ts';

const T0 = '2026-10-06T09:00:00.000Z';
const T1 = '2026-10-06T10:00:00.000Z';
const T2 = '2026-10-06T11:00:00.000Z';
const T3 = '2026-10-06T12:00:00.000Z';
const T4 = '2026-10-06T13:00:00.000Z';

const PROJECT = 'proj-verification' as ProjectId;
const OWNER = 'owner-verification' as OwnerId;
const ISSUE_IDENTIFIER = 'SHIP-300';
const RECIPE_ID = 'recipe-verification';
const DEPLOYMENT_ID = 'deployment-verification';

/** The local check the environment recipe defines, and the ones the provider owns. */
const LOCAL_CHECK_NAME = 'pnpm unit';
const PROVIDER_CHECK_NAME = 'pnpm test';
const NEVER_RUN_CHECK_NAME = 'pnpm test:e2e';
const RUNNING_CHECK_NAME = 'pnpm build:image';
const EXTRA_CHECK_NAME = 'pnpm lint:extra';

const CRITERION_AUTOMATED = 'AC-1';
const CRITERION_DEPLOYED = 'AC-2';
const CRITERION_OWNER = 'AC-3';
const CRITERION_UNASSIGNED = 'AC-4';

/** A second full commit, so recording it produces a different candidate identity (F20-AC3). */
const REPLACEMENT_HEAD_SHA = asCommitSha('3b7d1e0c9a5f2e8d4c6b0a1f3e7d9c5b2a8e4f60');

/** A credential-shaped value assembled at runtime, so no tracked source holds one (N02-AC2). */
const SEEDED_SECRET = ['sk', 'proj', 'shiploopseed', 'fixtureonly', 'aaaaaaaaaaaaaaaaaaaaaaaa'].join('-');

const OWNER_ACTOR: OwnerActor = {
  actorId: OWNER,
  role: 'Owner',
  ownerId: OWNER,
  sessionId: 'session-verification' as OwnerActor['sessionId'],
};

const ADAPTER_CONTEXT: AdapterContext = {
  correlationId: 'correlation-verification',
  operationId: 'op:read-checks' as OperationId,
  clock: { now: () => T1, elapsedMs: () => 0 },
  logger: { emit: () => undefined },
  signal: new AbortController().signal,
  redact: (text: string) => text,
};

function unwrap<T>(result: Result<T, DomainError>, what: string): T {
  assert.ok(result.ok, `${what} failed: ${result.ok ? '' : result.error.reason}`);
  return result.value;
}

function fingerprintOf(value: unknown): Fingerprint {
  return fingerprint(value);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

function boundedCommand(argv: readonly string[]): BoundedCommand {
  return { argv, timeoutMs: 30_000, maxOutputBytes: 65_536, cwd: null };
}

/**
 * A real local check command.
 *
 * A Node process rather than a stubbed runner, so the recorded exit code and the output
 * tail in the detail are observations of something that ran (F20-AC1).
 */
function localCheckCommand(name: string, exitCode: number): BoundedCommand {
  return boundedCommand([process.execPath, '-e', `console.log("ran ${name}"); process.exit(${exitCode});`]);
}

interface LocalCommand {
  readonly id: string;
  readonly name: string;
  readonly exitCode: number;
}

function recipeWith(commands: readonly LocalCommand[], version: number): RecipeVersion {
  return {
    recipeId: RECIPE_ID,
    version,
    supersedesVersion: version === 1 ? null : version - 1,
    provenance: { source: 'OwnerSaved', scope: 'Environment', createdBy: 'owner', createdAt: T0 },
    lastVerification: {
      result: 'Verified',
      verifiedAt: T0,
      verifiedRevision: 'main',
      dependencyDigest: fingerprintOf({ dependencies: version }),
    },
    requirements: { runtime: { name: 'node', minVersion: '24.0.0', maxVersionExclusive: null }, cpu: null },
    dependencyInstall: [],
    serviceStartup: [],
    checks: commands.map((command) => ({
      id: command.id,
      name: command.name,
      command: localCheckCommand(command.name, command.exitCode),
      required: true,
    })),
    ports: [],
    dataLocations: [],
    testAccess: [],
    requiredSecrets: [],
    declaredCapabilities: [],
    maintenance: {
      action: 'RunMaintenanceStep' as const,
      command: boundedCommand([process.execPath, '-e', 'process.exit(0)']),
      incompatibilityReason: null,
    },
  };
}

function profileContent(requiredChecks: readonly string[]): ProjectProfileContent {
  const policy: ProfilePolicy = {
    requiredChecks,
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
      previewComponents: [{ component: 'web', environment: 'preview' }],
    },
    policy,
    recipe: 'Saved through the recipe use case',
    environment: { runtime: 'node 24', ports: [4100], secretReferences: ['registry.token'] },
  };
}

/**
 * The scope a run captures.
 *
 * The work item identity is the one the repository minted, so the snapshot is captured
 * against the row that exists rather than against a name the test chose.
 */
function scopeFor(workItemId: WorkItemId): ScopeSnapshot {
  return {
    workItemId,
    issueId: 'issue-verification',
    issueIdentifier: ISSUE_IDENTIFIER,
    title: 'Wire the required checks and the review card',
    description: 'A candidate must prove its checks before the owner is asked to test it.',
    providerRevision: 'rev-1',
    priority: 'High',
    dependencyIssueIds: [],
    acceptanceCriteria: [
      { id: CRITERION_AUTOMATED, text: 'The local unit check passes for the candidate head' },
      { id: CRITERION_DEPLOYED, text: 'The owner sees the same preview the candidate deployed' },
      { id: CRITERION_OWNER, text: 'The owner finds the review card wording acceptable' },
      { id: CRITERION_UNASSIGNED, text: 'The export keeps the run history readable' },
    ],
    retrievedAt: T0,
  };
}

/** The retained output of one real spawned check, bounded so a chatty command cannot grow a report. */
const MAX_KEPT_OUTPUT_BYTES = 65_536;

/**
 * A real spawned process, the way the verification package's own cases run a check.
 *
 * The process group is created detached and killed as a group, so a deadline that fires
 * reaches only the process this runner started (F20-AC1, F18-AC1).
 */
function realCommandRunner(argv: readonly string[], options: CommandRunOptions): Promise<CommandRunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const [program, ...args] = argv;
    const child = spawn(program ?? '', args, {
      cwd: options.cwd,
      env: { ...options.env },
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let kept = 0;
    let settled = false;
    let timedOut = false;
    let failure: string | null = null;

    const collect = (chunk: Buffer): void => {
      if (kept >= MAX_KEPT_OUTPUT_BYTES) return;
      chunks.push(chunk);
      kept += chunk.byteLength;
    };

    const finish = (status: CommandRunStatus, detail: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        exitCode: status === 'Exited' ? child.exitCode : null,
        signal: child.signalCode,
        output: Buffer.concat(chunks).toString('utf8'),
        outputTruncated: kept >= MAX_KEPT_OUTPUT_BYTES,
        durationMs: Date.now() - started,
        detail,
      });
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error: Error) => {
      failure = error.message;
      finish('CouldNotStart', error.message);
    });
    child.on('close', (code: number | null) => {
      if (timedOut) return finish('TimedOut', null);
      if (code === null) return finish('Interrupted', failure);
      return finish('Exited', null);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }, options.timeoutMs);
  });
}

/* -------------------------------------------------------------------------- */
/* Provider scripting                                                           */
/* -------------------------------------------------------------------------- */

/** One scripted provider observation, before it is asked of the adapter contract. */
function script(
  name: string,
  result: ProviderCheckObservation['result'],
  detail: string,
  artifactUrl: string | null = result === 'Missing' || result === 'Waiting' ? null : `artifact://provider/${name}`,
): ProviderCheckObservation {
  return {
    checkId: `provider-${name}`,
    name,
    result,
    requirement: 'ProfileRequired',
    startedAt: FIXED_EARLIER_INSTANT,
    endedAt: result === 'Waiting' ? null : FIXED_LATER_INSTANT,
    exitCode: result === 'Passed' ? 0 : result === 'Failed' ? 1 : null,
    detail,
    artifactUrl,
  };
}

interface ProviderScript {
  /** The names the provider reports, and what it reports for each. */
  readonly observations: readonly ProviderCheckObservation[];
  /** Base-commit outcomes by check name; a name that is absent was not observed. */
  readonly onBase: ReadonlyMap<string, boolean | null>;
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                      */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly database: Database;
  readonly directory: string;
  readonly useCases: VerificationUseCases;
  readonly candidates: CandidateRepository;
  readonly journal: SqliteObservationJournal;
  readonly project: ProjectId;
  readonly workItemId: WorkItemId;
  readonly candidate: CandidateRecord;
  readonly snapshot: ScopeSnapshotRecord;
  /** Appends a new recipe version, which is how the environment fingerprint moves (F20-AC3). */
  supersedeRecipe(commands: readonly LocalCommand[], version: number): void;
  /** Offers a proposed check-policy revision, which is what a coding pass asks for (F20-AC5). */
  proposePolicy(proposal: Omit<RequiredCheckPolicy, 'decidedBy' | 'decidedAt'>): void;
  setNow(instant: string): void;
}

interface HarnessOptions {
  readonly requiredChecks: readonly string[];
  readonly localCommands: readonly LocalCommand[];
  readonly provider: ProviderScript;
  readonly headSha?: CommitSha;
  readonly baseSha?: CommitSha;
}

async function withHarness(options: HarnessOptions, body: (harness: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-controller-verification-'));
  try {
    const opened = openDatabase(join(directory, 'shiploop.sqlite'));
    assert.ok(opened.ok, `the real database opened: ${opened.ok ? '' : opened.error.reason}`);
    const database = opened.value;
    assert.ok(migrate(database).ok, 'the real schema migrated');

    const profiles = new ProjectProfileRepository(database);
    const procedures = new ProcedureRepository(database);
    const workItems = new WorkItemRepository(database);
    const scope = new ScopeRepository(database);
    const candidates = new CandidateRepository(database);
    const journal = new SqliteObservationJournal(database);

    const profile = unwrap(
      profiles.saveVersion({
        projectId: PROJECT,
        content: profileContent(options.requiredChecks),
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
        content: canonicalize(recipeWith(options.localCommands, 1)),
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
        title: 'Wire the required checks and the review card',
        externalIssueId: 'issue-verification',
        externalIssueIdentifier: ISSUE_IDENTIFIER,
        externalIssueUrl: 'https://linear.invalid/issue/SHIP-300',
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
        correlationId: 'correlation-verification',
      }),
      'capture the scope snapshot',
    );

    let instant = T0;
    const clock: ControllerClock = { now: () => instant };
    let proposal: Omit<RequiredCheckPolicy, 'decidedBy' | 'decidedAt'> | null = null;

    const policyFor = (): Result<ProjectCheckPolicy, DomainError> => {
      const current = profiles.currentVersion(PROJECT);
      if (!current.ok) return err(current.error);
      if (current.value === null) {
        return err({ code: 'NotFound', reason: `project ${PROJECT} has no current profile version` });
      }
      const version: ProjectProfileVersion = current.value;
      const approved: RequiredCheckPolicy = {
        policyFingerprint: version.contentFingerprint,
        requiredCheckIds: version.content.policy.requiredChecks,
        approvals: [],
        decidedBy: OWNER,
        decidedAt: version.createdAt,
      };
      return ok({
        profileVersionId: version.profileVersionId,
        approved,
        proposed: proposal === null ? approved : { ...approved, ...proposal },
      });
    };

    const currentEnvironment = (): Result<ProjectEnvironment, DomainError> => {
      const found = procedures.currentVersion(PROJECT, RECIPE_SUBJECT_KEY);
      if (!found.ok) return err(found.error);
      if (found.value === null) {
        return err({ code: 'NotFound', reason: `project ${PROJECT} has no saved environment recipe` });
      }
      const recipe = JSON.parse(found.value.content) as RecipeVersion;
      return ok({
        procedureVersionId: found.value.procedureVersionId,
        environmentFingerprint: recipeFingerprint(recipe),
        checks: recipe.checks,
      });
    };

    const candidate = unwrap(
      candidates.record({
        attemptId: null,
        workItemId: workItem.workItemId,
        identity: {
          headSha: options.headSha ?? FIXTURE_HEAD_SHA,
          baseSha: options.baseSha ?? FIXTURE_BASE_SHA,
          scopeFingerprint: snapshot.scopeFingerprint,
          profileVersionId: profile.profileVersionId,
          procedureVersionId: procedure.procedureVersionId,
          environmentFingerprint: recipeFingerprint(recipeWith(options.localCommands, 1)),
          policyFingerprint: profile.contentFingerprint,
          components: [
            {
              component: 'web',
              deploymentId: DEPLOYMENT_ID,
              deploymentUrl: 'https://verification.preview.invalid',
              environment: 'preview',
            },
          ],
        },
        pullRequestId: null,
        targetBranch: 'main',
        recordedAt: T0,
        correlationId: 'correlation-verification',
      }),
      'record the candidate',
    );

    const adapterSet = createFakeAdapterSet();
    const scripted = new Set(options.provider.observations.map((observation) => observation.name));

    const git = {
      async readChecks(request: {
        readonly headSha: CommitSha;
        readonly requiredCheckNames: readonly string[];
      }): Promise<Result<readonly ProviderCheckObservation[], DomainError>> {
        const read = await adapterSet.git.readChecks(ADAPTER_CONTEXT, {
          repository: FIXTURE_REPOSITORY,
          headSha: request.headSha,
          baseSha: candidate.identity.baseSha,
          candidateFingerprint: fingerprintOf({ providerRead: request.headSha }),
          requiredCheckNames: [...scripted],
        });
        if (!read.ok) return err(read.error);
        return ok(
          read.value
            .filter((observation) => scripted.has(observation.name))
            .map((observation) => {
              const replacement = options.provider.observations.find((entry) => entry.name === observation.name);
              return replacement === undefined ? observation : { ...observation, ...replacement };
            }),
        );
      },
      async failureOnBase(request: {
        readonly checkNames: readonly string[];
      }): Promise<Result<ReadonlyMap<string, boolean | null>, DomainError>> {
        const answers = new Map<string, boolean | null>();
        for (const name of request.checkNames) answers.set(name, options.provider.onBase.get(name) ?? null);
        return ok(answers);
      },
    };

    const useCases = createVerificationUseCases({
      clock,
      git,
      checks: {
        policyFor: () => policyFor(),
        run: (request, now) =>
          runCheck(
            {
              checkId: request.check.name,
              name: request.check.name,
              origin: 'LocalCheck',
              argv: request.check.command.argv,
              timeoutMs: request.check.command.timeoutMs ?? 30_000,
              cwd: directory,
              env: { PATH: process.env['PATH'] ?? '' },
              identity: request.identity,
              currentCandidateFingerprint: request.currentCandidateFingerprint,
              policy: request.policy,
            },
            {
              run: realCommandRunner,
              captureOutput: async (capture) => ({
                name: `logs/${capture.checkId}-${capture.candidateFingerprint}.log`,
                byteLength: capture.output.length,
              }),
              now,
            },
          ),
      },
      evidence: journal,
      candidates,
      scope: { latestScopeSnapshot: (id) => workItems.latestScopeSnapshot(id) },
      workItems: { get: (id) => workItems.get(id) },
      procedureVersions: { currentEnvironment: () => currentEnvironment() },
    });

    await body({
      database,
      directory,
      useCases,
      candidates,
      journal,
      project: PROJECT,
      workItemId: workItem.workItemId,
      candidate,
      snapshot,
      setNow(next: string): void {
        instant = next;
      },
      supersedeRecipe(commands, version): void {
        unwrap(
          procedures.appendVersion({
            projectId: PROJECT,
            subjectKey: RECIPE_SUBJECT_KEY,
            kind: 'Procedure',
            scope: 'Environment',
            source: 'Owner',
            sourceRevision: version.toString(),
            content: canonicalize(recipeWith(commands, version)),
            status: 'Accepted',
            createdAt: T2,
            createdBy: OWNER,
            note: 'The environment recipe changed',
            expectedVersionNumber: version - 1,
          }),
          'supersede the environment recipe',
        );
      },
      proposePolicy(next): void {
        proposal = next;
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function cardFor(harness: Harness, candidate: CandidateRecord = harness.candidate): ReviewCard {
  return unwrap(harness.useCases.buildReviewCard(candidate), 'build the review card');
}

async function runChecks(harness: Harness): ReturnType<VerificationUseCases['runRequiredChecks']> {
  return harness.useCases.runRequiredChecks(harness.candidate, harness.project);
}

function observationInput(overrides: Partial<ObservationInput> & Pick<ObservationInput, 'criterionId'>): ObservationInput {
  return {
    evidenceId: `evid-${overrides.criterionId}` as EvidenceId,
    observation: 'BehaviorConfirmed',
    environment: 'Local',
    capturedAt: T1,
    component: null,
    deploymentId: null,
    artifacts: [],
    apiExchange: null,
    detail: null,
    ...overrides,
  };
}

function packRequest(overrides: Partial<EvidencePackRequest> = {}): EvidencePackRequest {
  return {
    assignments: [
      {
        criterionId: CRITERION_AUTOMATED,
        method: { kind: 'AutomatedCheck', checkId: LOCAL_CHECK_NAME },
        requiresDeployedObservation: false,
      },
      {
        criterionId: CRITERION_DEPLOYED,
        method: { kind: 'BrowserEvidence', evidenceId: `evid-${CRITERION_DEPLOYED}` as EvidenceId },
        requiresDeployedObservation: true,
      },
      {
        criterionId: CRITERION_OWNER,
        method: { kind: 'OwnerTest', instructions: 'Read the card and judge the wording' },
        requiresDeployedObservation: false,
      },
    ],
    observations: [],
    eligiblePreview: null,
    bundleId: 'bundle-1',
    correlationId: 'correlation-verification',
    ...overrides,
  };
}

function ownerOutcome(overrides: Partial<OwnerTestOutcome> = {}): OwnerTestOutcome {
  return {
    actor: OWNER_ACTOR,
    observation: 'BehaviorConfirmed',
    environment: 'Preview',
    component: 'web',
    deploymentId: DEPLOYMENT_ID,
    note: 'The owner read the card',
    correlationId: 'correlation-owner-test',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* F20                                                                          */
/* -------------------------------------------------------------------------- */

test('F20-AC1: the required checks are executed and collected, and every fact about them is recorded', async () => {
  await withHarness(
    {
      requiredChecks: [LOCAL_CHECK_NAME, PROVIDER_CHECK_NAME],
      localCommands: [{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }],
      provider: {
        observations: [script(PROVIDER_CHECK_NAME, 'Passed', `the provider ran ${PROVIDER_CHECK_NAME} and it passed`)],
        onBase: new Map(),
      },
    },
    async (harness) => {
      harness.setNow(T1);
      const report = unwrap(await runChecks(harness), 'run the required checks');

      const local = report.records.find((entry) => entry.record.checkId === LOCAL_CHECK_NAME);
      assert.ok(local !== undefined, 'the locally executed required check is recorded');
      assert.equal(local.record.name, LOCAL_CHECK_NAME);
      assert.equal(local.record.origin, 'LocalCheck');
      assert.equal(local.record.required, true);
      assert.equal(local.record.result, 'Passed');
      assert.equal(local.record.exitCode, 0, 'the exit code is the one the real process returned');
      assert.equal(local.record.candidateFingerprint, report.currentCandidateFingerprint);
      assert.match(local.record.artifactRef ?? '', /^logs\/pnpm unit-fp_/, 'the captured output is referenced by name');
      assert.match(local.record.detail ?? '', /ran pnpm unit/, 'the real process output reaches the detail');
      assert.ok(local.record.startedAt.length > 0, 'the start instant is recorded');
      assert.ok((local.record.endedAt ?? '').length > 0, 'the end instant is recorded');

      const provider = report.records.find((entry) => entry.record.checkId === PROVIDER_CHECK_NAME);
      assert.ok(provider !== undefined, 'the provider-collected required check is recorded');
      assert.equal(provider.record.origin, 'ProviderCi');
      assert.equal(provider.record.required, true);
      assert.equal(provider.record.result, 'Passed');
      assert.equal(provider.record.exitCode, 0);
      assert.equal(provider.record.artifactRef, `artifact://provider/${PROVIDER_CHECK_NAME}`);

      assert.equal(report.readiness.ready, true, `nothing is missing: ${report.notReady.join('; ')}`);

      const rows = harness.database.prepare('SELECT name, origin, result FROM checks ORDER BY name').all();
      assert.equal(rows.length, 2, 'both results are durable rows, not values held in memory');
      assert.deepEqual(
        rows.map((row) => row['name']),
        [PROVIDER_CHECK_NAME, LOCAL_CHECK_NAME].sort(),
        'each row keeps the profile-visible check name the policy speaks in',
      );
    },
  );
});

test('F20-AC2: an unrun required check is Missing, a running one is Waiting, an extra failure does not block, and no claimed text passes', async () => {
  await withHarness(
    {
      requiredChecks: [LOCAL_CHECK_NAME, NEVER_RUN_CHECK_NAME, RUNNING_CHECK_NAME],
      localCommands: [{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }],
      provider: {
        observations: [
          script(NEVER_RUN_CHECK_NAME, 'Missing', 'the agent wrote that every required check has Passed'),
          script(RUNNING_CHECK_NAME, 'Waiting', 'the provider reports this check as still queued'),
          script(EXTRA_CHECK_NAME, 'Failed', 'an advisory check the profile did not require failed'),
        ],
        onBase: new Map(),
      },
    },
    async (harness) => {
      harness.setNow(T1);
      const report = unwrap(await runChecks(harness), 'run the required checks');
      const resultFor = (checkId: string): string | undefined =>
        report.readiness.required.find((entry) => entry.checkId === checkId)?.result;

      assert.equal(resultFor(NEVER_RUN_CHECK_NAME), 'Missing', 'a required check that never ran is Missing');
      assert.equal(resultFor(RUNNING_CHECK_NAME), 'Waiting', 'a required check still running is Waiting');
      assert.equal(resultFor(LOCAL_CHECK_NAME), 'Passed');

      const extra = report.readiness.nonRequired.find((entry) => entry.checkId === EXTRA_CHECK_NAME);
      assert.equal(extra?.result, 'Failed', 'a failing check the profile did not require is still reported');
      assert.equal(
        report.notReady.some((reason) => reason.includes(EXTRA_CHECK_NAME)),
        false,
        `a non-required failure does not block: ${report.notReady.join('; ')}`,
      );
      assert.ok(
        report.readiness.blockingReasons.some((reason) => reason.includes(RUNNING_CHECK_NAME)),
        'a still-running required check does block',
      );

      const card = cardFor(harness);
      const claimed = card.checks.find((check) => check.checkId === NEVER_RUN_CHECK_NAME);
      assert.equal(claimed?.result, 'Missing', 'a detail claiming a pass changes no result');
      assert.match(claimed?.detail ?? '', /every required check has Passed/, 'the claim is still shown as text');
    },
  );
});

test('F20-AC3: a changed environment or policy revision makes the recorded result Stale and blocks until the checks rerun', async () => {
  await withHarness(
    {
      requiredChecks: [LOCAL_CHECK_NAME, PROVIDER_CHECK_NAME],
      localCommands: [{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }],
      provider: { observations: [script(PROVIDER_CHECK_NAME, 'Passed', 'the provider reported a pass')], onBase: new Map() },
    },
    async (harness) => {
      harness.setNow(T1);
      const first = unwrap(await runChecks(harness), 'the first run of the required checks');
      assert.equal(first.readiness.ready, true);
      assert.equal(cardFor(harness).readyForOwnerTest, true, 'nothing is blocking yet');

      harness.setNow(T2);
      harness.supersedeRecipe([{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }], 2);
      const afterEnvironment = unwrap(await runChecks(harness), 'the run after the environment changed');
      assert.notEqual(
        afterEnvironment.currentCandidateFingerprint,
        first.currentCandidateFingerprint,
        'a changed environment yields a different candidate identity',
      );
      assert.ok(
        afterEnvironment.staleReasons.includes('EnvironmentChanged'),
        `the domain names the dimension that moved: ${afterEnvironment.staleReasons.join(', ')}`,
      );
      assert.equal(
        afterEnvironment.readiness.required.find((entry) => entry.checkId === LOCAL_CHECK_NAME)?.result,
        'Passed',
        'the rerun writes a new observation under the current identity',
      );
      assert.equal(
        afterEnvironment.readiness.required.find((entry) => entry.checkId === PROVIDER_CHECK_NAME)?.result,
        'Stale',
        'the result recorded under the previous identity no longer describes this candidate',
      );
      assert.equal(afterEnvironment.readiness.ready, false, 'a stale result prevents ready-for-delivery');

      const card = cardFor(harness);
      assert.equal(card.readyForOwnerTest, false);
      assert.ok(
        card.notReady.some((reason) => reason.includes(PROVIDER_CHECK_NAME) && reason.includes('Stale')),
        `the card names what is not ready: ${card.notReady.join('; ')}`,
      );

      harness.setNow(T3);
      harness.supersedeRecipe([{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }], 3);
      const movedAgain = cardFor(harness);
      assert.ok(
        movedAgain.checks.every((check) => check.result === 'Stale'),
        `every recorded result is Stale once the identity moves again: ${movedAgain.checks
          .map((check) => `${check.checkId}=${check.result}`)
          .join(', ')}`,
      );
      assert.equal(movedAgain.readyForOwnerTest, false, 'until the applicable checks rerun, the gate stays closed');

      harness.setNow(T4);
      const rerun = unwrap(await runChecks(harness), 'the rerun under the newest identity');
      assert.equal(
        rerun.readiness.required.find((entry) => entry.checkId === LOCAL_CHECK_NAME)?.result,
        'Passed',
        'the rerun writes a new observation under the current identity',
      );
      assert.equal(
        rerun.readiness.required.find((entry) => entry.checkId === PROVIDER_CHECK_NAME)?.result,
        'Stale',
        'a check the provider has not rerun keeps reading Stale, so readiness stays closed',
      );
      assert.equal(rerun.readiness.ready, false, 'until every applicable check has rerun');
    },
  );
});

test('F20-AC4: a failure the base commit also reported is attributed to the base and is still not waived', async () => {
  await withHarness(
    {
      requiredChecks: [PROVIDER_CHECK_NAME],
      localCommands: [],
      provider: {
        observations: [script(PROVIDER_CHECK_NAME, 'Failed', 'the provider reported a failure')],
        onBase: new Map([[PROVIDER_CHECK_NAME, true]]),
      },
    },
    async (harness) => {
      harness.setNow(T1);
      const report = unwrap(await runChecks(harness), 'run the required checks');
      assert.equal(report.failures.length, 1, 'the failing required check is attributed');
      const failure = report.failures[0];
      assert.ok(failure !== undefined);
      assert.equal(failure.name, PROVIDER_CHECK_NAME);
      assert.equal(failure.attribution.attribution, 'PresentOnBase');
      assert.equal(failure.waivesRequiredCheck, false);
      assert.equal(report.readiness.ready, false, 'a base failure does not waive the required check');
      assert.ok(
        report.notReady.some((reason) => reason.includes(PROVIDER_CHECK_NAME)),
        `the failure is still reported as blocking: ${report.notReady.join('; ')}`,
      );
    },
  );
});

test('F20-AC4: a base that passed makes the failure change-introduced, and an unobserved base is Indeterminate', async () => {
  await withHarness(
    {
      requiredChecks: [PROVIDER_CHECK_NAME],
      localCommands: [],
      provider: { observations: [script(PROVIDER_CHECK_NAME, 'Failed', 'the provider reported a failure')], onBase: new Map([[PROVIDER_CHECK_NAME, false]]) },
    },
    async (harness) => {
      harness.setNow(T1);
      const introduced = unwrap(await runChecks(harness), 'run the required checks');
      assert.equal(introduced.failures[0]?.attribution.attribution, 'IntroducedByChange');
      assert.equal(introduced.failures[0]?.waivesRequiredCheck, false);
    },
  );

  await withHarness(
    {
      requiredChecks: [PROVIDER_CHECK_NAME],
      localCommands: [],
      provider: { observations: [script(PROVIDER_CHECK_NAME, 'Failed', 'the provider reported a failure')], onBase: new Map() },
    },
    async (harness) => {
      harness.setNow(T1);
      const unobserved = unwrap(await runChecks(harness), 'run the required checks');
      const failure = unobserved.failures[0];
      assert.ok(failure !== undefined, 'the failure is still attributed, not dropped');
      assert.equal(failure.attribution.attribution, 'Indeterminate');
      assert.match(failure.attribution.evidence, /base commit was not observed/i);
      assert.equal(failure.waivesRequiredCheck, false);
    },
  );
});

test('F20-AC5: the required set comes from the profile, and a proposal may extend it but never shrink or retire it', async () => {
  await withHarness(
    {
      requiredChecks: [LOCAL_CHECK_NAME, PROVIDER_CHECK_NAME],
      localCommands: [{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }],
      provider: { observations: [script(PROVIDER_CHECK_NAME, 'Passed', 'the provider reported a pass')], onBase: new Map() },
    },
    async (harness) => {
      harness.setNow(T1);
      const baseline = unwrap(await runChecks(harness), 'the baseline run');
      assert.deepEqual(
        baseline.readiness.required.map((entry) => entry.checkId).sort(),
        [PROVIDER_CHECK_NAME, LOCAL_CHECK_NAME].sort(),
        'the required set is exactly what the profile names',
      );

      harness.setNow(T2);
      harness.proposePolicy({
        policyFingerprint: fingerprintOf({ policy: 'shrunk' }),
        requiredCheckIds: [PROVIDER_CHECK_NAME],
        approvals: [],
      });
      const shrunk = await runChecks(harness);
      assert.equal(shrunk.ok, false, 'a proposal that removes an owner-required check is refused');
      assert.equal(shrunk.ok ? '' : shrunk.error.code, 'Forbidden');
      assert.match(shrunk.ok ? '' : shrunk.error.reason, /removes owner-required checks/);

      const retired = fingerprintOf({ policy: 'retired' });
      harness.proposePolicy({
        policyFingerprint: retired,
        requiredCheckIds: [LOCAL_CHECK_NAME, PROVIDER_CHECK_NAME],
        approvals: [
          {
            checkId: LOCAL_CHECK_NAME,
            policyFingerprint: retired,
            approvedBy: OWNER,
            approvedAt: T2,
            reason: 'the coding pass asked for this gate to be retired',
          },
        ],
      });
      const retiredResult = await runChecks(harness);
      assert.equal(retiredResult.ok, false, 'a proposal that retires an owner-required check is refused');
      assert.match(retiredResult.ok ? '' : retiredResult.error.reason, /does not waive a required check/);

      harness.setNow(T3);
      harness.proposePolicy({
        policyFingerprint: fingerprintOf({ policy: 'extended' }),
        requiredCheckIds: [LOCAL_CHECK_NAME, PROVIDER_CHECK_NAME, EXTRA_CHECK_NAME],
        approvals: [],
      });
      const extended = unwrap(await runChecks(harness), 'the run under an extended proposal');
      assert.equal(extended.readiness.required.length, 3, 'a proposal may add a required check');
      assert.equal(
        extended.readiness.required.find((entry) => entry.checkId === EXTRA_CHECK_NAME)?.result,
        'Missing',
        'the added check has not run, and an unrun check is Missing',
      );
      assert.equal(
        extended.readiness.required.find((entry) => entry.checkId === PROVIDER_CHECK_NAME)?.result,
        'Stale',
        'the earlier results belong to the superseded policy revision',
      );
    },
  );
});

/* -------------------------------------------------------------------------- */
/* F24                                                                          */
/* -------------------------------------------------------------------------- */

test('F24-AC2: the card names the head, the base, the scope revision, every check result, every criterion status and what is not ready', async () => {
  await withHarness(
    {
      requiredChecks: [LOCAL_CHECK_NAME, NEVER_RUN_CHECK_NAME],
      localCommands: [{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }],
      provider: { observations: [script(NEVER_RUN_CHECK_NAME, 'Missing', 'no run was reported for this check')], onBase: new Map() },
    },
    async (harness) => {
      harness.setNow(T1);
      unwrap(await runChecks(harness), 'run the required checks');
      harness.setNow(T2);
      unwrap(
        harness.useCases.buildEvidencePack(
          harness.candidate,
          packRequest({
            observations: [
              observationInput({
                criterionId: CRITERION_AUTOMATED,
                evidenceId: 'evid-unit' as EvidenceId,
                detail: 'the local check observed the criterion',
              }),
            ],
          }),
        ),
        'build the evidence pack',
      );

      const card = cardFor(harness);
      assert.ok(isCommitSha(card.headSha), 'the card shows the full head SHA');
      assert.equal(card.headSha, harness.candidate.identity.headSha);
      assert.ok(isCommitSha(card.baseSha), 'the card shows the full base SHA');
      assert.equal(card.baseSha, harness.candidate.identity.baseSha);
      assert.equal(card.scopeFingerprint, harness.snapshot.scopeFingerprint);
      assert.equal(card.scopeRevision, harness.snapshot.sequenceNumber, 'the card shows the scope revision');
      assert.equal(card.candidateFingerprint, harness.candidate.candidateFingerprint);

      const local = card.checks.find((check) => check.checkId === LOCAL_CHECK_NAME);
      assert.equal(local?.result, 'Passed');
      assert.equal(local?.origin, 'LocalCheck');
      const missing = card.checks.find((check) => check.checkId === NEVER_RUN_CHECK_NAME);
      assert.equal(missing?.result, 'Missing');
      assert.equal(missing?.blocking, true);

      const statuses = new Map(card.criteria.map((criterion) => [criterion.criterionId, criterion.status]));
      assert.deepEqual(
        [...statuses.entries()].sort(),
        [
          [CRITERION_AUTOMATED, 'Verified'],
          [CRITERION_DEPLOYED, 'Missing'],
          [CRITERION_OWNER, 'PendingOwnerTest'],
          [CRITERION_UNASSIGNED, 'Untested'],
        ],
        'every captured criterion is on the card with a status',
      );
      const verified = card.criteria.find((criterion) => criterion.criterionId === CRITERION_AUTOMATED);
      assert.ok((verified?.evidenceId ?? '').length > 0, 'the verdict that verified a criterion is named');
      assert.equal(
        harness.database
          .prepare('SELECT evidence_id FROM evidence WHERE criterion_id = ?')
          .get(CRITERION_AUTOMATED)?.['evidence_id'],
        verified?.evidenceId,
        'the card names the durable verdict it read',
      );

      assert.ok(
        card.notReady.some((reason) => reason.includes(NEVER_RUN_CHECK_NAME)),
        `the unrun required check is named as not ready: ${card.notReady.join('; ')}`,
      );
      assert.ok(
        card.notReady.some((reason) => reason.includes(CRITERION_DEPLOYED)),
        'the criterion with no observation is named as not ready',
      );
      assert.equal(
        card.notReady.some((reason) => reason.includes(CRITERION_OWNER)),
        false,
        'an owner test may still be pending at this gate (F24-AC3)',
      );
      assert.deepEqual(card.pendingOwnerTestCriterionIds, [CRITERION_OWNER]);
    },
  );
});

test('F24-AC3: a missing or stale required check closes Ready for your test, and the owner-test criterion stays inspectable', async () => {
  await withHarness(
    {
      requiredChecks: [LOCAL_CHECK_NAME, PROVIDER_CHECK_NAME],
      localCommands: [{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }],
      provider: { observations: [script(PROVIDER_CHECK_NAME, 'Passed', 'the provider reported a pass')], onBase: new Map() },
    },
    async (harness) => {
      harness.setNow(T1);
      const beforeAnyRun = cardFor(harness);
      assert.equal(beforeAnyRun.readyForOwnerTest, false, 'a required check with no run is not ready for the owner test');
      assert.equal(
        beforeAnyRun.checks.filter((check) => check.result === 'Missing').length,
        2,
        'both required checks are on the card as Missing, because no run was reported for either',
      );
      assert.ok(
        beforeAnyRun.notReady.some((reason) => reason.includes(`Required check "${LOCAL_CHECK_NAME}" is Missing`)),
        `the card names the unrun required check: ${beforeAnyRun.notReady.join('; ')}`,
      );

      harness.setNow(T2);
      unwrap(await runChecks(harness), 'run the required checks');
      unwrap(harness.useCases.buildEvidencePack(harness.candidate, packRequest()), 'assign the methods');
      const green = cardFor(harness);
      assert.equal(green.readyForOwnerTest, true, 'both required checks are current passes');
      assert.equal(green.checks.find((check) => check.checkId === PROVIDER_CHECK_NAME)?.result, 'Passed');
      assert.deepEqual(
        green.pendingOwnerTestCriterionIds,
        [CRITERION_OWNER],
        'an owner test may still be pending while the required checks pass (F24-AC3)',
      );
      assert.equal(
        green.notReady.some((reason) => reason.includes(CRITERION_OWNER)),
        false,
        'a pending owner test is not itself a reason the work cannot be tested',
      );

      harness.setNow(T3);
      harness.proposePolicy({
        policyFingerprint: fingerprintOf({ policy: 'revised-after-the-run' }),
        requiredCheckIds: [LOCAL_CHECK_NAME, PROVIDER_CHECK_NAME],
        approvals: [],
      });
      const afterRevision = cardFor(harness);
      assert.equal(afterRevision.readyForOwnerTest, false, 'a stale required check closes the gate again');
      assert.equal(
        afterRevision.checks.find((check) => check.checkId === PROVIDER_CHECK_NAME)?.result,
        'Stale',
        'the pass belongs to the superseded policy revision',
      );
      assert.ok(
        afterRevision.notReady.some((reason) => reason.includes('Stale')),
        `the card names the stale results: ${afterRevision.notReady.join('; ')}`,
      );
      assert.ok(
        afterRevision.criteria.some((criterion) => criterion.status !== 'Verified'),
        'a verdict recorded under the superseded policy revision no longer describes this candidate',
      );
      assert.equal(
        afterRevision.criteria.length,
        4,
        'every captured criterion stays on the card, so the owner can see what is outstanding',
      );
    },
  );
});

test('F24-AC4: a card for a superseded candidate is refused with a Conflict naming the expected and the actual identity', async () => {
  await withHarness(
    {
      requiredChecks: [LOCAL_CHECK_NAME],
      localCommands: [{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }],
      provider: { observations: [], onBase: new Map() },
    },
    async (harness) => {
      harness.setNow(T1);
      unwrap(await runChecks(harness), 'run the required checks');
      const superseded = harness.candidate;
      assert.equal(cardFor(harness).readyForOwnerTest, true, 'the first candidate is ready while it is current');

      const replacement = unwrap(
        harness.candidates.record({
          attemptId: null,
          workItemId: harness.workItemId,
          identity: { ...superseded.identity, headSha: 'a'.repeat(40) as CommitSha },
          pullRequestId: null,
          targetBranch: 'main',
          recordedAt: T2,
          correlationId: 'correlation-replacement',
        }),
        'record a replacement candidate',
      );

      harness.setNow(T3);
      const refused = harness.useCases.buildReviewCard(superseded);
      assert.equal(refused.ok, false, 'the outdated card is refused');
      if (refused.ok) return;
      assert.equal(refused.error.code, 'Conflict');
      assert.equal(refused.error.expected, superseded.candidateFingerprint);
      assert.equal(refused.error.actual, replacement.candidateFingerprint);
      assert.match(refused.error.reason, /no longer the current one/);
      assert.match(refused.error.reason, /HeadChanged/, 'the reason names the dimension that moved');

      const packRefused = harness.useCases.buildEvidencePack(superseded, packRequest());
      assert.equal(packRefused.ok, false, 'the evidence pack for the same candidate is refused as well');
      assert.equal(packRefused.ok ? '' : packRefused.error.code, 'Conflict');

      const ownerRefused = harness.useCases.recordOwnerTest(superseded, CRITERION_OWNER, ownerOutcome());
      assert.equal(ownerRefused.ok, false, 'an owner decision on the outdated candidate is refused too');

      const current = cardFor(harness, replacement);
      assert.equal(current.candidateFingerprint, replacement.candidateFingerprint);
      assert.deepEqual(
        current.checks.map((check) => [check.checkId, check.result]),
        [[LOCAL_CHECK_NAME, 'Missing']],
        'the replacement candidate inherits no result from the build it replaced (F20-AC3)',
      );
      assert.equal(current.readyForOwnerTest, false, 'its required check has not run for the replacement either');
      assert.ok(
        current.notReady.some((reason) => reason.includes(CRITERION_DEPLOYED)),
        'the replacement still has unobserved criteria',
      );
    },
  );
});

/* -------------------------------------------------------------------------- */
/* F23                                                                          */
/* -------------------------------------------------------------------------- */

test('F23-AC1: every applicable criterion is assigned a method, and a green check run leaves the rest Untested or Missing', async () => {
  await withHarness(
    {
      requiredChecks: [LOCAL_CHECK_NAME],
      localCommands: [{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }],
      provider: { observations: [], onBase: new Map() },
    },
    async (harness) => {
      harness.setNow(T1);
      unwrap(await runChecks(harness), 'run every required check, green');
      const bundle = unwrap(
        harness.useCases.buildEvidencePack(harness.candidate, packRequest()),
        'build the evidence pack',
      );

      assert.equal(
        bundle.records.length,
        harness.snapshot.acceptanceCriteria.length,
        'every applicable criterion is assigned a method and given a row',
      );
      const byCriterion = new Map(bundle.records.map((record) => [record.criterionId, record]));
      assert.equal(
        byCriterion.get(CRITERION_AUTOMATED)?.status,
        'Missing',
        'a green check with no linked observation does not verify its criterion',
      );
      assert.equal(byCriterion.get(CRITERION_DEPLOYED)?.status, 'Missing');
      assert.equal(byCriterion.get(CRITERION_OWNER)?.status, 'PendingOwnerTest');
      assert.equal(byCriterion.get(CRITERION_UNASSIGNED)?.status, 'Untested');
      const unassigned = byCriterion.get(CRITERION_UNASSIGNED);
      assert.equal(unassigned?.method.kind, 'Untested');
      assert.match(
        unassigned?.method.kind === 'Untested' ? unassigned.method.reason : '',
        /No verification method is assigned/,
        'an unassigned criterion says why nothing can verify it',
      );
      assert.equal(
        bundle.records.filter((record) => record.status === 'Verified').length,
        0,
        'generic green CI claims no criterion at all',
      );
      assert.deepEqual(
        [...bundle.unverifiedCriterionIds].sort(),
        [CRITERION_AUTOMATED, CRITERION_DEPLOYED, CRITERION_OWNER, CRITERION_UNASSIGNED].sort(),
      );

      for (const record of bundle.records) {
        assert.equal(record.candidateFingerprint, bundle.candidateFingerprint, 'every record is bound to the identity');
        assert.equal(record.scopeFingerprint, harness.snapshot.scopeFingerprint, 'the scope revision is recorded');
        assert.equal(record.headSha, harness.candidate.identity.headSha, 'the full commit is recorded');
        assert.equal(record.baseSha, harness.candidate.identity.baseSha, 'the base commit is recorded');
      }

      const durable = harness.database.prepare('SELECT criterion_id, status, candidate_fingerprint FROM evidence').all();
      assert.equal(durable.length, 4, 'the verdicts are durable rows');
    },
  );
});

test('F23-AC4: a local check cannot satisfy a criterion that requires deployed behaviour', async () => {
  await withHarness(
    {
      requiredChecks: [LOCAL_CHECK_NAME],
      localCommands: [{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }],
      provider: { observations: [], onBase: new Map() },
    },
    async (harness) => {
      harness.setNow(T1);
      unwrap(await runChecks(harness), 'run the local check');
      const bundle = unwrap(
        harness.useCases.buildEvidencePack(
          harness.candidate,
          packRequest({
            eligiblePreview: {
              component: 'web',
              deploymentId: DEPLOYMENT_ID,
              environment: 'preview',
              candidateFingerprint: fingerprintOf({ preview: 1 }),
            },
            observations: [
              observationInput({
                criterionId: CRITERION_DEPLOYED,
                environment: 'Local',
                component: 'web',
                artifacts: [{ kind: 'Screenshot', name: `shots/${CRITERION_DEPLOYED}.png`, capturedAt: T1 }],
                detail: 'the flow worked on a developer machine',
              }),
            ],
          }),
        ),
        'build the evidence pack from a local observation',
      );
      const deployed = bundle.records.find((record) => record.criterionId === CRITERION_DEPLOYED);
      assert.equal(deployed?.status, 'Missing', 'local evidence is labelled local and does not satisfy a deployed criterion');
      assert.equal(deployed?.environment, 'Local', 'the observation keeps its environment label');
      assert.match(deployed?.detail ?? '', /Local evidence is labelled local/);
      assert.ok(
        bundle.unverifiedCriterionIds.includes(CRITERION_DEPLOYED),
        'the criterion stays unmet until it is observed against the eligible preview',
      );
    },
  );
});

test('F23-AC5: a capture failure and a behaviour failure are recorded as different outcomes', async () => {
  await withHarness(
    {
      requiredChecks: [LOCAL_CHECK_NAME],
      localCommands: [{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }],
      provider: { observations: [], onBase: new Map() },
    },
    async (harness) => {
      harness.setNow(T1);
      unwrap(await runChecks(harness), 'run the local check');
      unwrap(harness.useCases.buildEvidencePack(harness.candidate, packRequest()), 'assign the methods');

      const captured = unwrap(
        harness.useCases.recordOwnerTest(
          harness.candidate,
          CRITERION_OWNER,
          ownerOutcome({ observation: 'CaptureFailed', note: 'the recording tool never started' }),
        ),
        'record a capture failure',
      );
      assert.equal(captured.criterion.status, 'Missing', 'a capture failure observed no behaviour');
      assert.match(captured.criterion.detail ?? '', /capture failure, not a behaviour failure/);
      assert.equal(captured.acceptance.ready, false, 'acceptance is not ready on a capture failure');
      assert.equal(
        harness.database.prepare('SELECT result FROM evidence WHERE criterion_id = ?').get(CRITERION_OWNER)?.['result'],
        null,
        'a capture that never happened records no check result at all',
      );

      harness.setNow(T2);
      const failed = unwrap(
        harness.useCases.recordOwnerTest(
          harness.candidate,
          CRITERION_OWNER,
          ownerOutcome({ observation: 'BehaviorFailed', note: 'the card omitted the failing check' }),
        ),
        'record a behaviour failure',
      );
      assert.equal(failed.criterion.status, 'Failed');
      assert.equal(failed.criterion.detail, 'the card omitted the failing check');
      assert.notEqual(failed.criterion.status, captured.criterion.status, 'the two outcomes stay distinguishable');

      const row = harness.database
        .prepare('SELECT result, method_kind, status FROM evidence WHERE criterion_id = ?')
        .get(CRITERION_OWNER);
      assert.equal(row?.['method_kind'], 'OwnerTest', 'the verdict is filed under the owner-test method');
      assert.equal(row?.['status'], 'Failed');
      assert.equal(row?.['result'], 'Failed', 'the row says what was observed, and it is not a pass');
      assert.equal(
        captured.criterion.observedAt !== null,
        true,
        'a capture failure is still timestamped, so the owner can see the attempt happened',
      );
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Criterion identity: which check verified it                                  */
/* -------------------------------------------------------------------------- */

/**
 * One criterion's line on the card, or a failed assertion.
 *
 * A helper because every test in this section asks the same question about a criterion and a
 * null criterion would otherwise be asserted on as if it were a verdict (F24-AC3).
 */
function criterionOf(card: ReviewCard, criterionId: string): ReviewCard['criteria'][number] {
  const criterion = card.criteria.find((entry) => entry.criterionId === criterionId);
  assert.ok(criterion !== undefined, `the card must carry criterion ${criterionId}; it carries ${card.criteria.map((entry) => entry.criterionId).join(', ')}`);
  return criterion;
}

// F23-AC1: the criterion names the check that produced its verdict, the name reaches the card
// from the durable row rather than from the projection's own judgement, and no other check on
// the card can stand in for it — however green it is.
test('F23-AC1: a criterion names the check that produced its verdict, and no other check can be substituted for it', async () => {
  await withHarness(
    {
      requiredChecks: [LOCAL_CHECK_NAME, PROVIDER_CHECK_NAME],
      localCommands: [{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }],
      provider: {
        observations: [
          script(PROVIDER_CHECK_NAME, 'Failed', 'the provider reported a failure for this commit'),
          // A check that passed and that no criterion is bound to. If the projection reached for
          // "the first passing check" this is the row it would have picked (F23-AC1).
          script(EXTRA_CHECK_NAME, 'Passed', 'the provider reported a pass nobody linked to a criterion'),
        ],
        onBase: new Map(),
      },
    },
    async (harness) => {
      harness.setNow(T1);
      unwrap(await runChecks(harness), 'run every required check');

      unwrap(
        harness.useCases.buildEvidencePack(
          harness.candidate,
          packRequest({
            assignments: [
              {
                criterionId: CRITERION_AUTOMATED,
                method: { kind: 'AutomatedCheck', checkId: LOCAL_CHECK_NAME },
                requiresDeployedObservation: false,
              },
              {
                criterionId: CRITERION_DEPLOYED,
                method: { kind: 'AutomatedCheck', checkId: PROVIDER_CHECK_NAME },
                requiresDeployedObservation: false,
              },
              {
                criterionId: CRITERION_OWNER,
                method: { kind: 'OwnerTest', instructions: 'Read the card and judge the wording' },
                requiresDeployedObservation: false,
              },
            ],
            observations: [
              observationInput({
                criterionId: CRITERION_AUTOMATED,
                evidenceId: 'evid-unit' as EvidenceId,
                detail: 'the local check observed the criterion',
              }),
              observationInput({
                criterionId: CRITERION_DEPLOYED,
                evidenceId: 'evid-provider' as EvidenceId,
                observation: 'BehaviorFailed',
                detail: 'the provider check disproved the criterion',
              }),
            ],
          }),
        ),
        'bind one criterion to the passing check and one to the failing check',
      );

      const card = cardFor(harness);
      assert.equal(
        card.checks.find((check) => check.checkId === LOCAL_CHECK_NAME)?.result,
        'Passed',
        'the local check is on the card and green',
      );
      assert.equal(
        card.checks.find((check) => check.checkId === EXTRA_CHECK_NAME)?.result,
        'Passed',
        'the unrelated passing check is on the card too, which is what makes it substitutable',
      );

      // The identity the card names is the one the durable row holds: same `checks` row, same
      // `check_name`, resolved rather than restated (F23-AC1).
      const stored = harness.database
        .prepare('SELECT check_id, check_name FROM evidence WHERE criterion_id = ?')
        .get(CRITERION_AUTOMATED);
      const checkRow = harness.database
        .prepare('SELECT check_id FROM checks WHERE candidate_id = ? AND name = ? ORDER BY started_at DESC LIMIT 1')
        .get(harness.candidate.candidateId, LOCAL_CHECK_NAME);
      assert.equal(stored?.['check_name'], LOCAL_CHECK_NAME, 'the durable row holds the check name');
      assert.equal(
        stored?.['check_id'],
        checkRow?.['check_id'],
        'the durable row is bound to the row of the check that actually ran',
      );

      const verified = criterionOf(card, CRITERION_AUTOMATED);
      assert.equal(verified.status, 'Verified');
      assert.equal(verified.methodKind, 'AutomatedCheck');
      assert.equal(verified.verificationCheckId, LOCAL_CHECK_NAME, 'the criterion names the check that verified it');
      assert.equal(verified.verificationEvidenceId, verified.evidenceId, 'the evidence row travels with the criterion');
      assert.equal(
        harness.database.prepare('SELECT evidence_id FROM evidence WHERE criterion_id = ?').get(CRITERION_AUTOMATED)?.[
          'evidence_id'
        ],
        verified.verificationEvidenceId,
        'and it is the durable verdict, not a fresh identity',
      );
      assert.equal(verified.verificationDetail, `Verified by check "${LOCAL_CHECK_NAME}".`);

      // The reverse: a criterion bound to the failing check reads Failed, and the passing check
      // that ran alongside it is not offered in its place (F23-AC1).
      const failed = criterionOf(card, CRITERION_DEPLOYED);
      assert.equal(failed.status, 'Failed', 'a criterion bound to a failing check reads Failed, not Passed');
      assert.equal(failed.verificationCheckId, PROVIDER_CHECK_NAME, 'and it names that failing check');

      assert.deepEqual(
        card.criteria.map((criterion) => criterion.verificationCheckId),
        [LOCAL_CHECK_NAME, PROVIDER_CHECK_NAME, null, null],
        'each automated criterion names its own check, and no criterion names the unrelated pass',
      );
      assert.equal(
        card.criteria.some((criterion) => criterion.verificationCheckId === EXTRA_CHECK_NAME),
        false,
        'a passing check no criterion is bound to verifies nothing (F23-AC1)',
      );
      assert.ok(
        card.notReady.some((reason) => reason.includes(`Required check "${PROVIDER_CHECK_NAME}" is Failed`)),
        `the failing required check is still named as not ready: ${card.notReady.join('; ')}`,
      );
    },
  );
});

// F20-AC3, F23-AC1: a verdict belongs to the candidate identity it was recorded under, so a
// replacement build starts with no verdict and no verification identity to inherit.
test('F23-AC1: a changed candidate inherits neither the verdict nor the check that produced it', async () => {
  await withHarness(
    {
      requiredChecks: [LOCAL_CHECK_NAME],
      localCommands: [{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }],
      provider: { observations: [], onBase: new Map() },
    },
    async (harness) => {
      harness.setNow(T1);
      unwrap(await runChecks(harness), 'run every required check');
      unwrap(
        harness.useCases.buildEvidencePack(
          harness.candidate,
          packRequest({
            observations: [
              observationInput({
                criterionId: CRITERION_AUTOMATED,
                evidenceId: 'evid-unit' as EvidenceId,
                detail: 'the local check observed the criterion',
              }),
            ],
          }),
        ),
        'verify the criterion on the first candidate',
      );
      const first = criterionOf(cardFor(harness), CRITERION_AUTOMATED);
      assert.equal(first.status, 'Verified');
      assert.equal(first.verificationCheckId, LOCAL_CHECK_NAME);

      harness.setNow(T2);
      const replacement = unwrap(
        harness.candidates.record({
          attemptId: null,
          workItemId: harness.workItemId,
          identity: { ...harness.candidate.identity, headSha: REPLACEMENT_HEAD_SHA },
          pullRequestId: null,
          targetBranch: 'main',
          recordedAt: T2,
          correlationId: 'correlation-verification',
        }),
        'record a replacement candidate',
      );
      assert.notEqual(
        replacement.candidateFingerprint,
        harness.candidate.candidateFingerprint,
        'a changed head is a different candidate identity',
      );

      const inherited = criterionOf(cardFor(harness, replacement), CRITERION_AUTOMATED);
      assert.equal(inherited.status, 'Untested', 'the replacement candidate starts with no verdict');
      assert.equal(inherited.verificationCheckId, null, 'and names no check, because none ran against it');
      assert.equal(inherited.verificationEvidenceId, null);
      assert.equal(inherited.evidenceId, null);
      assert.equal(inherited.verificationDetail, null);
      assert.ok(
        cardFor(harness, replacement).notReady.some((reason) => reason.includes(CRITERION_AUTOMATED)),
        'the criterion it never verified is named as not ready on the new candidate',
      );

      // The old verdict is still on disk, bound to the identity that produced it: nothing was
      // rewritten, it simply stopped describing this candidate (F20-AC3).
      assert.equal(
        harness.database
          .prepare('SELECT COUNT(*) AS rows FROM evidence WHERE candidate_fingerprint = ?')
          .get(harness.candidate.candidateFingerprint)?.['rows'],
        4,
        'the previous candidate keeps its four verdict rows',
      );
      assert.equal(
        harness.database
          .prepare('SELECT COUNT(*) AS rows FROM evidence WHERE candidate_fingerprint = ?')
          .get(replacement.candidateFingerprint)?.['rows'],
        0,
        'the replacement candidate has none of its own',
      );
    },
  );
});

// F23-AC1: a later write for the same criterion under the same identity updates what the verdict
// says and keeps the check it was filed against, so a later write cannot re-point a criterion at
// a check that merely passed.
test('F23-AC1: a later write updates the verdict and keeps the check the criterion was bound to', async () => {
  await withHarness(
    {
      requiredChecks: [LOCAL_CHECK_NAME, PROVIDER_CHECK_NAME],
      localCommands: [{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }],
      provider: {
        observations: [script(PROVIDER_CHECK_NAME, 'Passed', 'the provider reported a pass')],
        onBase: new Map(),
      },
    },
    async (harness) => {
      harness.setNow(T1);
      unwrap(await runChecks(harness), 'run every required check');
      unwrap(
        harness.useCases.buildEvidencePack(
          harness.candidate,
          packRequest({
            assignments: [
              {
                criterionId: CRITERION_AUTOMATED,
                method: { kind: 'AutomatedCheck', checkId: LOCAL_CHECK_NAME },
                requiresDeployedObservation: false,
              },
            ],
            observations: [
              observationInput({
                criterionId: CRITERION_AUTOMATED,
                evidenceId: 'evid-unit' as EvidenceId,
                detail: 'the local check observed the criterion',
              }),
            ],
          }),
        ),
        'bind the criterion to the local check and verify it',
      );
      const bound = criterionOf(cardFor(harness), CRITERION_AUTOMATED);
      assert.equal(bound.verificationCheckId, LOCAL_CHECK_NAME);

      // A later write for the same criterion under the same identity, this time naming the other
      // check — which also passed — and recording a failure. Within one identity the assignment
      // comes from the scope revision the candidate was built against and cannot legitimately
      // move, so the journal keeps the first binding rather than trusting this one (F23-AC1).
      harness.setNow(T2);
      unwrap(
        harness.useCases.buildEvidencePack(
          harness.candidate,
          packRequest({
            assignments: [
              {
                criterionId: CRITERION_AUTOMATED,
                method: { kind: 'AutomatedCheck', checkId: PROVIDER_CHECK_NAME },
                requiresDeployedObservation: false,
              },
            ],
            observations: [
              observationInput({
                criterionId: CRITERION_AUTOMATED,
                evidenceId: 'evid-draft' as EvidenceId,
                observation: 'BehaviorFailed',
                detail: 'a later draft recorded a failure',
              }),
            ],
          }),
        ),
        'write a later verdict naming the other check that passed',
      );

      const after = criterionOf(cardFor(harness), CRITERION_AUTOMATED);
      assert.equal(after.status, 'Failed', 'the later verdict is what the card now reports');
      assert.equal(
        after.verificationCheckId,
        LOCAL_CHECK_NAME,
        'the bound check is retained, not re-pointed at the check that happened to pass (F23-AC1)',
      );
      assert.equal(
        after.verificationEvidenceId,
        bound.verificationEvidenceId,
        'it is still the same durable verdict row, updated in place',
      );
      assert.equal(
        harness.database.prepare('SELECT check_name FROM evidence WHERE criterion_id = ?').get(CRITERION_AUTOMATED)?.[
          'check_name'
        ],
        LOCAL_CHECK_NAME,
        'the durable row kept its binding as well',
      );
    },
  );
});

test('F23-AC1: only the owner may record an owner test, only for a criterion assigned to one, and it is what satisfies acceptance', async () => {
  await withHarness(
    {
      requiredChecks: [LOCAL_CHECK_NAME],
      localCommands: [{ id: 'local-unit', name: LOCAL_CHECK_NAME, exitCode: 0 }],
      provider: { observations: [], onBase: new Map() },
    },
    async (harness) => {
      harness.setNow(T1);
      unwrap(await runChecks(harness), 'run the local check');
      unwrap(harness.useCases.buildEvidencePack(harness.candidate, packRequest()), 'assign the methods');

      const forbidden = harness.useCases.recordOwnerTest(
        harness.candidate,
        CRITERION_OWNER,
        ownerOutcome({ actor: { ...OWNER_ACTOR, role: 'CodingAgent', ownerId: null } }),
      );
      assert.equal(forbidden.ok, false, 'a coding agent may not record the owner test');
      assert.equal(forbidden.ok ? '' : forbidden.error.code, 'Forbidden');

      const notAnOwnerTest = harness.useCases.recordOwnerTest(harness.candidate, CRITERION_AUTOMATED, ownerOutcome());
      assert.equal(notAnOwnerTest.ok, false, 'a caller may not promote an automated criterion to an owner test');
      assert.equal(notAnOwnerTest.ok ? '' : notAnOwnerTest.error.code, 'Invalid');

      const unknown = harness.useCases.recordOwnerTest(harness.candidate, 'AC-404', ownerOutcome());
      assert.equal(unknown.ok, false);
      assert.equal(unknown.ok ? '' : unknown.error.code, 'NotFound');

      const recorded = unwrap(
        harness.useCases.recordOwnerTest(harness.candidate, CRITERION_OWNER, ownerOutcome()),
        'record the owner test',
      );
      assert.equal(recorded.criterion.status, 'Verified');
      assert.equal(recorded.criterion.methodKind, 'OwnerTest');
      assert.equal(
        recorded.acceptance.ready,
        false,
        `the other criteria are still unmet: ${recorded.acceptance.reasons.join('; ')}`,
      );
      assert.ok(
        recorded.acceptance.reasons.some((reason) => reason.includes(CRITERION_DEPLOYED)),
        'acceptance names the criteria that are not satisfied',
      );
      assert.equal(
        recorded.acceptance.reasons.some((reason) => reason.includes(CRITERION_OWNER)),
        false,
        'the recorded owner test is satisfied',
      );

      harness.setNow(T2);
      const corrected = unwrap(
        harness.useCases.recordOwnerTest(
          harness.candidate,
          CRITERION_OWNER,
          ownerOutcome({ observation: 'BehaviorFailed', note: 'the wording was not acceptable after all' }),
        ),
        'correct the owner test',
      );
      assert.equal(corrected.criterion.status, 'Failed', 'a corrected verdict replaces the earlier one for the same identity');
      assert.equal(
        harness.database.prepare('SELECT COUNT(*) AS total FROM evidence WHERE criterion_id = ?').get(CRITERION_OWNER)?.['total'],
        1,
        'one verdict per criterion per identity, so a repeat does not append a duplicate',
      );
    },
  );
});

test('N02-AC2: a seeded credential in a check detail or artifact reference is redacted before it is stored or shown', async () => {
  await withHarness(
    {
      requiredChecks: [PROVIDER_CHECK_NAME],
      localCommands: [],
      provider: {
        observations: [
          script(
            PROVIDER_CHECK_NAME,
            'Failed',
            `the run used ${SEEDED_SECRET} to reach the registry`,
            `artifact://provider/run?token=${SEEDED_SECRET}`,
          ),
        ],
        onBase: new Map(),
      },
    },
    async (harness) => {
      harness.setNow(T1);
      unwrap(await runChecks(harness), 'run the required checks');
      const stored = harness.database.prepare('SELECT detail_redacted, artifact_ref FROM checks').all();
      const serialized = JSON.stringify(stored);
      assert.ok(!serialized.includes(SEEDED_SECRET), 'the seeded value must not survive into the durable row');
      assert.match(serialized, /\[redacted:openai-key\]/, 'the redaction is visible rather than silent');

      const card = cardFor(harness);
      assert.ok(!JSON.stringify(card).includes(SEEDED_SECRET), 'the seeded value must not reach the card');
      assert.match(
        card.checks.find((check) => check.checkId === PROVIDER_CHECK_NAME)?.detail ?? '',
        /\[redacted:openai-key\]/,
      );
    },
  );
});
