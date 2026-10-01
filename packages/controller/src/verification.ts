/**
 * Required checks, the review card and criterion evidence (F20-AC1, F20-AC2,
 * F20-AC3, F20-AC4, F20-AC5, F23-AC1, F23-AC3, F23-AC4, F23-AC5, F24-AC2,
 * F24-AC3, F24-AC4, N02-AC2).
 *
 * This layer answers three owner-facing questions and owns no rule of its own. Every
 * judgement is asked for rather than restated: check outcomes come from the
 * verification package's `mapCheckOutcome`, readiness from `evaluateCandidateReadiness`,
 * failure attribution from `classifyCheckFailure`, freshness from the domain's
 * `assessStaleness` and `detectStaleness`, and the criterion pack from
 * `buildEvidencePack`. A second copy of any of those here would be the copy a reviewer
 * reads and the one that decides, so none exists.
 *
 * The properties that carry the product:
 *
 *   - **Only an observation produces `Passed`** (F20-AC2). A required check the profile
 *     names but nothing ran is `Missing`; a provider run still in flight is `Waiting`; a
 *     run the provider attributed to another commit is an absence, not a pass. Nothing a
 *     caller or an agent writes reaches the mapping, because the mapping takes a
 *     `CheckObservation` and that union has no member carrying a claimed result.
 *   - **A check belongs to the identity it ran under** (F20-AC3). A result is journaled
 *     with the fingerprint current when it ran, so a changed head, base, scope,
 *     environment or policy revision makes the recorded result `Stale` and closes
 *     ready-for-owner-test until the applicable checks rerun. A rerun writes a new
 *     observation; a check that has not rerun keeps reading `Stale`.
 *   - **An existing failure is visible but never a waiver** (F20-AC4). A check that also
 *     failed on the base commit is reported as `PresentOnBase` and still blocks; the
 *     required set is what the profile says it is, and a proposed revision may extend it
 *     but never shrink it or retire one of its checks (F20-AC5).
 *   - **Green CI cannot claim a criterion** (F23-AC1). A criterion is `Verified` only
 *     from a linked observation against the eligible preview, `PendingOwnerTest` when the
 *     owner owns the step, and `Missing` or `Untested` when nothing observed it. A local
 *     check cannot satisfy a deployed criterion, and a capture that never happened is
 *     `Missing` with its own reason rather than a behaviour failure (F23-AC4, F23-AC5).
 *   - **An outdated card is refused, not quietly refreshed** (F24-AC4). A candidate that
 *     is no longer the current one is a `Conflict` naming the expected and the actual
 *     identity, so the caller re-renders against current facts instead of acting on
 *     evidence belonging to a superseded build. A candidate that is still current but
 *     whose scope, environment or policy revision moved is not refused: its results read
 *     `Stale` and the card names them, which is what lets the owner see why the work is
 *     not ready rather than only being turned away.
 *
 * Every string this module emits or stores has passed through the domain redaction,
 * because a check detail, an artifact name and a card are all quoted into issue comments
 * and exports (N02-AC2).
 */

import { createHash } from 'node:crypto';

import {
  CHECK_RESULTS,
  acceptanceReady,
  assessStaleness,
  candidateFingerprint,
  conflict,
  err,
  invalid,
  ok,
  redact,
  redactDeep,
} from '@shiploop/domain';
import type {
  CandidateIdentity,
  CheckOrigin,
  CheckRecord,
  CheckResult,
  CommitSha,
  CriterionEvidence,
  CriterionStatus,
  CriterionVerificationMethod,
  DomainError,
  EvidenceId,
  FailureClassification,
  Fingerprint,
  ProfileVersionId,
  ProjectId,
  ProcedureVersionId,
  Result,
  WorkItemId,
} from '@shiploop/domain';
import type { ProviderCheckObservation } from '@shiploop/adapters';
import {
  attributeCheckFailure,
  buildEvidencePack as buildCriterionBundle,
  detectStaleness,
  evaluateCandidateReadiness,
  mapCheckOutcome,
  resolveRequiredChecks,
} from '@shiploop/verification';
import type {
  BehaviorObservation,
  CheckCommand,
  CheckExecutionRecord,
  CheckObservation,
  CheckPolicyContext,
  EvidenceBundle,
  EvidenceEnvironment,
  EvidenceRecord,
  ObservationInput,
  ReadinessAssessment,
  RecordedCheckIdentity,
  RequiredCheckPolicy,
} from '@shiploop/verification';
import type {
  CandidateRecord,
  CandidateStore,
  ScopeSnapshotRecord,
  SqlRow,
  StorageConnection,
  WorkItemRecord,
} from '@shiploop/storage';
import type { ControllerClock, OwnerActor } from './profiles.ts';

/* -------------------------------------------------------------------------- */
/* Ports                                                                        */
/* -------------------------------------------------------------------------- */

/** What a provider can say about one commit's checks (F20-AC1). */
export interface ProviderCheckRequest {
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  readonly candidateFingerprint: Fingerprint;
  /**
   * Names the project profile requires.
   *
   * A name the provider never reported comes back `Missing` rather than `Passed`, and a
   * name it did not run for this commit comes back as an absence, because the profile is
   * the only thing that knows a name is required (F20-AC2, F20-AC5).
   */
  readonly requiredCheckNames: readonly string[];
}

/** The base-commit question F20-AC4 needs answered per check name. */
export interface ProviderBaseCheckRequest {
  readonly baseSha: CommitSha;
  readonly checkNames: readonly string[];
}

/**
 * The provider's check-run reader.
 *
 * Declared structurally rather than imported as `GitAdapter`, so this layer depends on
 * the read it needs and the composition root binds the real Git or GitLab adapter.
 *
 * `failureOnBase` is separate because it answers a different question: whether a check
 * also failed on the base commit. The provider read available today derives `Stale` from
 * a base-reported run and reports nothing about how that run ended, so until an adapter
 * answers this the honest answer is "not observed" and the domain records the
 * attribution as `Indeterminate` rather than guessing in either direction (F20-AC4).
 */
export interface ProviderCheckReader {
  readChecks(
    request: ProviderCheckRequest,
  ): Promise<Result<readonly ProviderCheckObservation[], DomainError>>;
  failureOnBase(
    request: ProviderBaseCheckRequest,
  ): Promise<Result<ReadonlyMap<string, boolean | null>, DomainError>>;
}

/**
 * The project profile's required-check policy.
 *
 * `approved` is the owner-approved set and `proposed` is what a coding pass is asking
 * for. A proposal may extend the approved set and may never shrink it or attach a
 * NotApplicable approval to a check the owner required, which is what stops a coding
 * agent passing its own work by deleting the gate that would have caught the defect
 * (F20-AC5).
 */
export interface ProjectCheckPolicy {
  readonly profileVersionId: ProfileVersionId;
  readonly approved: RequiredCheckPolicy;
  readonly proposed: RequiredCheckPolicy;
}

/**
 * The local check to execute, already bound to the identity current now.
 *
 * The identity is passed rather than looked up because a check must be recorded against
 * the facts that are true when it runs: a result written under a superseded scope,
 * environment or policy revision is `Stale` the moment it is recorded (F20-AC3).
 *
 * The journal keys a check by its owner-visible name, because the profile's required set
 * is expressed in names and a name is the only identity a local recipe command and a
 * provider-reported run agree on. The recipe's own check id stays the recipe's business.
 */
export interface LocalCheckRequest {
  readonly check: CheckCommand;
  readonly identity: RecordedCheckIdentity;
  readonly currentCandidateFingerprint: Fingerprint;
  readonly policy: CheckPolicyContext;
}

/**
 * The project's checks: the policy that names them, and the execution of one.
 *
 * Both sit on one port because they are one concern — the policy decides which checks are
 * required and `run` executes a check the environment recipe defined. The implementation
 * owns the isolated workspace the command runs in and the artifact store its output goes
 * to; this layer holds no working directory and spawns nothing (F20-AC1, F14-AC2).
 */
export interface ProjectChecks {
  policyFor(projectId: ProjectId): Result<ProjectCheckPolicy, DomainError>;
  run(
    request: LocalCheckRequest,
    now: () => string,
  ): Promise<Result<CheckExecutionRecord, DomainError>>;
}

/** The environment the current run executes in, as the project's recipe version states it. */
export interface ProjectEnvironment {
  readonly procedureVersionId: ProcedureVersionId;
  /** The recipe's environment identity, as `recipeFingerprint` derives it. */
  readonly environmentFingerprint: Fingerprint;
  /** The local check commands the recipe defines. */
  readonly checks: readonly CheckCommand[];
}

/** Reads the current environment recipe version of a project (F04, F20-AC3). */
export interface ProjectEnvironmentReader {
  currentEnvironment(projectId: ProjectId): Result<ProjectEnvironment, DomainError>;
}

/** The scope a candidate was built from, which is where its acceptance criteria live. */
export interface CandidateScopeReader {
  latestScopeSnapshot(workItemId: WorkItemId): Result<ScopeSnapshotRecord | null, DomainError>;
}

/** The work item a candidate belongs to, which is what resolves its project. */
export interface WorkItemReader {
  get(workItemId: WorkItemId): Result<WorkItemRecord, DomainError>;
}

/* -------------------------------------------------------------------------- */
/* The durable observation journal                                             */
/* -------------------------------------------------------------------------- */

/** A recorded check result, together with the identity it was recorded under. */
export interface RecordedCheck {
  readonly record: CheckRecord;
  readonly identity: RecordedCheckIdentity;
}

export interface RecordCheckInput {
  readonly candidate: CandidateRecord;
  readonly record: CheckRecord;
  readonly correlationId: string | null;
}

/** The method vocabulary the durable `evidence.method_kind` column constrains. */
export type CriterionMethodKind = CriterionVerificationMethod['kind'];

/**
 * One criterion's recorded verdict.
 *
 * `methodKind` is stored rather than the whole method because the durable row records
 * which kind of verification produced the result and, for an automated criterion, the
 * check that produced it. The steps of an owner test are the criterion text the scope
 * snapshot captured: no separate instruction document is stored, and inventing one here
 * would be a claim no observation supports (F23-AC1).
 */
export interface CriterionEvidenceRow {
  readonly evidenceId: EvidenceId;
  readonly criterionId: string;
  readonly methodKind: CriterionMethodKind;
  readonly status: CriterionStatus;
  readonly checkId: string | null;
  readonly candidateFingerprint: Fingerprint;
  readonly scopeFingerprint: Fingerprint;
  readonly observedAt: string | null;
  readonly artifactRef: string | null;
  readonly detail: string | null;
}

export interface RecordCriterionInput {
  readonly candidate: CandidateRecord;
  /** The identity the pack was built for, which the durable row is bound to. */
  readonly bundleFingerprint: Fingerprint;
  readonly record: EvidenceRecord;
  readonly recordedAt: string;
  readonly correlationId: string | null;
}

/**
 * The durable record of what was observed for a candidate.
 *
 * One journal for both tables because they are one fact: a `checks` row is the
 * observation, and an `evidence` row is that observation's verdict on a named criterion.
 * Storage writes the check row from inside its own evidence write and exports no reader
 * for either table, so the implementation at the bottom of this file is
 * controller-owned and reported as a duplication (F20-AC1, F23-AC1).
 */
export interface ObservationJournal {
  recordCheck(input: RecordCheckInput): Result<RecordedCheck>;
  listChecks(candidate: CandidateRecord): Result<readonly RecordedCheck[]>;
  criteriaFor(
    candidate: CandidateRecord,
    currentCandidateFingerprint: Fingerprint,
  ): Result<readonly CriterionEvidenceRow[]>;
  criterionFor(
    candidate: CandidateRecord,
    currentCandidateFingerprint: Fingerprint,
    criterionId: string,
  ): Result<CriterionEvidenceRow | null>;
  recordCriterion(input: RecordCriterionInput): Result<CriterionEvidenceRow>;
}

/* -------------------------------------------------------------------------- */
/* Use case inputs and outputs                                                 */
/* -------------------------------------------------------------------------- */

export interface VerificationUseCaseDeps {
  readonly clock: ControllerClock;
  readonly git: ProviderCheckReader;
  readonly checks: ProjectChecks;
  readonly evidence: ObservationJournal;
  readonly candidates: Pick<CandidateStore, 'listForWorkItem'>;
  readonly scope: CandidateScopeReader;
  readonly workItems: WorkItemReader;
  readonly procedureVersions: ProjectEnvironmentReader;
}

/** One required check's failure, attributed and explicitly not waived (F20-AC4). */
export interface CheckFailureReport {
  readonly checkId: string;
  readonly name: string;
  readonly attribution: FailureClassification;
  /**
   * Always false.
   *
   * A failure already present on the base commit is reported, not forgiven: the required
   * check is what the profile says it is, and only an owner policy revision can change
   * that (F20-AC4, F20-AC5).
   */
  readonly waivesRequiredCheck: false;
}

/** What one execution and collection of the required checks established. */
export interface RequiredCheckReport {
  readonly candidateFingerprint: Fingerprint;
  /** The identity the checks were recorded under (F20-AC3). */
  readonly currentCandidateFingerprint: Fingerprint;
  readonly collectedAt: string;
  readonly records: readonly RecordedCheck[];
  readonly readiness: ReadinessAssessment;
  readonly failures: readonly CheckFailureReport[];
  /** The identity inputs that differ from the ones the candidate was recorded with. */
  readonly staleReasons: readonly string[];
  readonly notReady: readonly string[];
}

export interface ReviewCardCheck {
  readonly checkId: string;
  readonly name: string;
  /** Null for a required check with no recorded run, because nothing reported where it would run. */
  readonly origin: CheckOrigin | null;
  readonly required: boolean;
  readonly result: CheckResult;
  readonly blocking: boolean;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly artifactRef: string | null;
  readonly detail: string | null;
}

export interface ReviewCardCriterion {
  readonly criterionId: string;
  readonly text: string;
  readonly methodKind: CriterionMethodKind;
  readonly status: CriterionStatus;
  readonly evidenceId: EvidenceId | null;
  readonly observedAt: string | null;
  readonly detail: string | null;
}

/**
 * What the owner is shown for one candidate (F24-AC2, F24-AC3).
 *
 * `notReady` is the point of the card: the reasons the work cannot be accepted are named,
 * so incomplete work stays inspectable with its reasons rather than presenting as a card
 * that is green everywhere except the parts nobody could see (F24-AC3).
 */
export interface ReviewCard {
  readonly candidateFingerprint: Fingerprint;
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  readonly scopeFingerprint: Fingerprint;
  /** The captured scope revision the candidate was built against. */
  readonly scopeRevision: number;
  readonly collectedAt: string;
  readonly checks: readonly ReviewCardCheck[];
  readonly criteria: readonly ReviewCardCriterion[];
  /** Criteria whose step belongs to the owner and may still be pending at this gate. */
  readonly pendingOwnerTestCriterionIds: readonly string[];
  readonly readyForOwnerTest: boolean;
  readonly notReady: readonly string[];
}

/**
 * The method assigned to one criterion.
 *
 * Assigning a method is a scope decision rather than evidence: it says how the criterion
 * will be checked, and it produces no verified result on its own (F23-AC1).
 */
export interface CriterionAssignment {
  readonly criterionId: string;
  readonly method: CriterionVerificationMethod;
  /** True when only deployed behaviour can satisfy the criterion (F23-AC4). */
  readonly requiresDeployedObservation: boolean;
}

export interface EvidencePackRequest {
  /** A criterion with no assignment is reported `Untested` with a reason (F23-AC1). */
  readonly assignments: readonly CriterionAssignment[];
  /** Observations the capture path recorded, at most one per criterion. */
  readonly observations: readonly ObservationInput[];
  /** The preview a deployed criterion may be observed against, when one is eligible. */
  readonly eligiblePreview: {
    readonly component: string;
    readonly deploymentId: string;
    readonly environment: string;
    readonly candidateFingerprint: Fingerprint;
  } | null;
  readonly bundleId: string;
  readonly correlationId: string;
}

/** What the owner recorded when they performed a criterion's own test step. */
export interface OwnerTestOutcome {
  readonly actor: OwnerActor;
  /**
   * The owner's observation.
   *
   * `CaptureFailed` is a distinct outcome: nothing was observed, so the criterion can be
   * recorded neither as confirmed nor as a behaviour failure (F23-AC5).
   */
  readonly observation: BehaviorObservation;
  readonly environment: EvidenceEnvironment;
  readonly component: string | null;
  readonly deploymentId: string | null;
  readonly note: string | null;
  readonly correlationId: string;
}

export interface OwnerTestReport {
  readonly criterionId: string;
  readonly candidateFingerprint: Fingerprint;
  readonly criterion: CriterionEvidenceRow;
  /** The acceptance verdict over every criterion recorded for this identity (F23-AC1). */
  readonly acceptance: { readonly ready: boolean; readonly reasons: readonly string[] };
}

export interface VerificationUseCases {
  readonly runRequiredChecks: (
    candidate: CandidateRecord,
    projectId: ProjectId,
  ) => Promise<Result<RequiredCheckReport, DomainError>>;
  readonly buildReviewCard: (candidate: CandidateRecord) => Result<ReviewCard, DomainError>;
  readonly buildEvidencePack: (
    candidate: CandidateRecord,
    request: EvidencePackRequest,
  ) => Result<EvidenceBundle, DomainError>;
  readonly recordOwnerTest: (
    candidate: CandidateRecord,
    criterionId: string,
    outcome: OwnerTestOutcome,
  ) => Result<OwnerTestReport, DomainError>;
}

/* -------------------------------------------------------------------------- */
/* Result helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Every text this module emits or stores is redacted: cards and details travel outward (N02-AC2). */
function safe(text: string): string {
  return redact(text).text;
}

/**
 * The evidence kind a method's result files under, derived from the method rather than
 * restated. An owner test and an unassigned criterion are not evidence of any kind the
 * schema knows, so they file none (F23-AC1).
 */
const EVIDENCE_KIND_FOR_METHOD: Readonly<Record<CriterionMethodKind, string | null>> = {
  AutomatedCheck: 'CheckResult',
  BrowserEvidence: 'BrowserEvidence',
  ApiEvidence: 'ApiEvidence',
  OwnerTest: null,
  Untested: null,
};

/**
 * What an observation supports as a durable check result.
 *
 * A capture failure supports none: no outcome was observed, so the row records no result
 * rather than a failure the run never produced (F23-AC5).
 */
const CHECK_RESULT_FOR_OBSERVATION: Readonly<Record<BehaviorObservation, CheckResult | null>> = {
  BehaviorConfirmed: 'Passed',
  BehaviorFailed: 'Failed',
  CaptureFailed: null,
};

/**
 * The observation a provider-reported result supports on this candidate.
 *
 * A run the provider attributed to another commit, and a check it reported as retired or
 * skipped, are both statements that this candidate produced no result. They map to the
 * absence of an observation rather than to a pass, and the provider's own explanation is
 * kept in the detail so the owner can read what the provider actually said (F20-AC2,
 * F20-AC3).
 */
function observationForProviderResult(result: CheckResult): CheckObservation {
  switch (result) {
    case 'Passed':
      return { kind: 'ProviderRun', providerStatus: 'Succeeded' };
    case 'Failed':
      return { kind: 'ProviderRun', providerStatus: 'Failed' };
    case 'Waiting':
      return { kind: 'ProviderRun', providerStatus: 'InProgress' };
    case 'Missing':
      return { kind: 'ProviderRun', providerStatus: 'NotFound' };
    case 'Stale':
    case 'NotApplicable':
      return { kind: 'PrerequisiteAbsent' };
  }
}

/**
 * The status a criterion shows when nothing observed it.
 *
 * An owner test is `PendingOwnerTest` because the owner owns the step; a method nobody
 * assigned is `Untested` with a reason; anything else is `Missing`. None of the three is a
 * verified result, which is what stops green CI claiming every criterion (F23-AC1,
 * F24-AC3).
 */
const UNOBSERVED_STATUS: Readonly<Record<CriterionMethodKind, CriterionStatus>> = {
  OwnerTest: 'PendingOwnerTest',
  Untested: 'Untested',
  AutomatedCheck: 'Missing',
  BrowserEvidence: 'Missing',
  ApiEvidence: 'Missing',
};

const UNOBSERVED_DETAIL: Readonly<Record<CriterionMethodKind, string>> = {
  OwnerTest: 'This criterion is verified by the owner, and the owner test has not been recorded (F23-AC1).',
  Untested: 'No verification method is assigned to this criterion, so nothing can verify it (F23-AC1).',
  AutomatedCheck: 'No automated check result is recorded for this criterion (F23-AC1).',
  BrowserEvidence: 'No observation of this UI flow is recorded for this criterion (F23-AC2).',
  ApiEvidence: 'No sanitized request/result reference is recorded for this criterion (F23-AC2).',
};

/** Whether a recorded result is a current failure rather than a stale or absent one. */
function isCurrentFailure(
  recorded: RecordedCheck,
  currentCandidateFingerprint: Fingerprint,
  currentPolicyFingerprint: Fingerprint,
): boolean {
  return (
    !detectStaleness(recorded.identity, currentCandidateFingerprint, currentPolicyFingerprint).stale &&
    recorded.record.result === 'Failed'
  );
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Builds the verification use cases.
 *
 * Everything they touch is injected: the clock, the provider check reader, the check
 * policy and execution, the durable journal, and the readers that resolve a candidate's
 * project, scope and environment. No use case reads ambient time, constructs a provider
 * client or writes SQL, so a test exercises this layer against the real repositories and
 * the real migrated schema (mvp-spec 7).
 */
export function createVerificationUseCases(deps: VerificationUseCaseDeps): VerificationUseCases {
  /**
   * The identity inputs that are true right now for a candidate's commit.
   *
   * Head and base belong to the candidate. The scope revision, the profile and procedure
   * versions, the environment fingerprint and the policy revision are read from durable
   * state, because a candidate is stale precisely when those moved after it was recorded
   * (F20-AC3).
   */
  const currentIdentityFor = (
    candidate: CandidateRecord,
    policy: ProjectCheckPolicy,
    environment: ProjectEnvironment,
    scopeFingerprint: Fingerprint,
  ): CandidateIdentity => ({
    headSha: candidate.identity.headSha,
    baseSha: candidate.identity.baseSha,
    scopeFingerprint,
    profileVersionId: policy.profileVersionId,
    procedureVersionId: environment.procedureVersionId,
    environmentFingerprint: environment.environmentFingerprint,
    policyFingerprint: policy.proposed.policyFingerprint,
    components: candidate.identity.components,
  });

  /** The recorded check identity derived from a current identity (F20-AC3). */
  const checkIdentityFor = (current: CandidateIdentity): RecordedCheckIdentity => ({
    candidateFingerprint: candidateFingerprint(current),
    headSha: current.headSha,
    baseSha: current.baseSha,
    scopeFingerprint: current.scopeFingerprint,
    environmentFingerprint: current.environmentFingerprint,
    policyFingerprint: current.policyFingerprint,
  });

  /**
   * The captured scope revision a candidate's acceptance criteria come from.
   *
   * Absent rather than invented: a work item with no snapshot has no criteria, and
   * reporting an empty list would read as "nothing to verify" instead of "the scope was
   * never captured" (F12-AC1, F24-AC2).
   */
  const capturedScopeFor = (candidate: CandidateRecord): Result<ScopeSnapshotRecord, DomainError> => {
    const snapshot = deps.scope.latestScopeSnapshot(candidate.workItemId);
    if (!snapshot.ok) return err(snapshot.error);
    if (snapshot.value === null) {
      return err({
        code: 'NotFound',
        reason: `No scope snapshot is recorded for work item ${candidate.workItemId}, so its acceptance criteria cannot be read (F12-AC1, F24-AC2).`,
      });
    }
    return ok(snapshot.value);
  };

  /** Everything every use case here needs to know the candidate's facts right now. */
  const currentFactsFor = (
    candidate: CandidateRecord,
  ): Result<
    {
      readonly projectId: ProjectId;
      readonly policy: ProjectCheckPolicy;
      readonly environment: ProjectEnvironment;
      readonly snapshot: ScopeSnapshotRecord;
      readonly current: CandidateIdentity;
      readonly currentCandidateFingerprint: Fingerprint;
    },
    DomainError
  > => {
    const work = deps.workItems.get(candidate.workItemId);
    if (!work.ok) return err(work.error);
    const policy = deps.checks.policyFor(work.value.projectId);
    if (!policy.ok) return err(policy.error);
    const environment = deps.procedureVersions.currentEnvironment(work.value.projectId);
    if (!environment.ok) return err(environment.error);
    const snapshot = capturedScopeFor(candidate);
    if (!snapshot.ok) return err(snapshot.error);
    const current = currentIdentityFor(candidate, policy.value, environment.value, snapshot.value.scopeFingerprint);
    return ok({
      projectId: work.value.projectId,
      policy: policy.value,
      environment: environment.value,
      snapshot: snapshot.value,
      current,
      currentCandidateFingerprint: candidateFingerprint(current),
    });
  };

  /**
   * A recorded result as the readiness rules read it.
   *
   * `runStatus` and the NotApplicable approval are not durable and nothing in the
   * readiness judgement reads them: the verdict comes from the result, the required flag
   * and the identity, and all three are what the journal returns (F20-AC2).
   */
  const asExecutionRecord = (
    recorded: RecordedCheck,
    currentCandidateFingerprint: Fingerprint,
    currentPolicyFingerprint: Fingerprint,
  ): CheckExecutionRecord => ({
    ...recorded.record,
    runStatus: null,
    identity: recorded.identity,
    notApplicableApproval: null,
    staleness: detectStaleness(recorded.identity, currentCandidateFingerprint, currentPolicyFingerprint),
  });

  /**
   * F20-AC1, F20-AC2, F20-AC3, F20-AC4, F20-AC5: runs and collects the required checks
   * for a candidate, then reports what the durable store now says.
   *
   * A required check the environment recipe defines runs locally; every other required
   * name is collected from the provider, which reports a name it never ran as `Missing`.
   * Both paths reach `mapCheckOutcome` with an observation, and neither can be reached
   * with a claimed result.
   *
   * The policy is resolved through the verification package's own `resolveRequiredChecks`
   * before anything executes, so a proposed revision that removes an owner-required check
   * or retires one is refused before a process is spawned rather than after its result is
   * on disk (F20-AC5). The named project is checked against the work item's own project,
   * because running a candidate under another project's required set would apply one
   * project's gates to another project's work.
   */
  async function runRequiredChecks(
    candidate: CandidateRecord,
    projectId: ProjectId,
  ): Promise<Result<RequiredCheckReport, DomainError>> {
    const facts = currentFactsFor(candidate);
    if (!facts.ok) return err(facts.error);
    const { policy, environment, current } = facts.value;
    if (facts.value.projectId !== projectId) {
      return err(
        invalid(`Candidate ${candidate.candidateFingerprint} belongs to project ${facts.value.projectId}.`, [
          { path: 'projectId', message: `The work item for this candidate is in project ${facts.value.projectId}, not ${projectId}; its required checks cannot be read from another project (F20-AC5).` },
        ]),
      );
    }

    const context: CheckPolicyContext = { approved: policy.approved, proposed: policy.proposed };
    const resolved = resolveRequiredChecks(context);
    if (!resolved.ok) return err(resolved.error);

    const identity = checkIdentityFor(current);
    const currentCandidateFingerprint = identity.candidateFingerprint;
    const requiredNames = new Set(resolved.value.requiredCheckIds);
    const localNames = new Set(environment.checks.map((check) => check.name));

    for (const check of environment.checks.filter((entry) => requiredNames.has(entry.name))) {
      const executed = await deps.checks.run(
        { check, identity, currentCandidateFingerprint, policy: context },
        () => deps.clock.now(),
      );
      if (!executed.ok) return err(executed.error);
      const written = deps.evidence.recordCheck({ candidate, record: executed.value, correlationId: null });
      if (!written.ok) return err(written.error);
    }

    const read = await deps.git.readChecks({
      headSha: candidate.identity.headSha,
      baseSha: candidate.identity.baseSha,
      candidateFingerprint: currentCandidateFingerprint,
      requiredCheckNames: [...requiredNames].filter((name) => !localNames.has(name)),
    });
    if (!read.ok) return err(read.error);
    for (const observation of read.value) {
      const mapped = mapCheckOutcome({
        observation: observationForProviderResult(observation.result),
        identity,
        currentCandidateFingerprint,
        currentPolicyFingerprint: resolved.value.policyFingerprint,
        notApplicableRequested: false,
        notApplicableApproval: null,
      });
      if (!mapped.ok) return err(mapped.error);
      const written = deps.evidence.recordCheck({
        candidate,
        record: providerCheckRecord(observation, identity, requiredNames.has(observation.name), mapped.value.result),
        correlationId: null,
      });
      if (!written.ok) return err(written.error);
    }

    const listed = deps.evidence.listChecks(candidate);
    if (!listed.ok) return err(listed.error);

    const readiness = evaluateCandidateReadiness({
      policy: context,
      records: listed.value.map((recorded) =>
        asExecutionRecord(recorded, currentCandidateFingerprint, resolved.value.policyFingerprint),
      ),
      currentCandidateFingerprint,
    });
    if (!readiness.ok) return err(readiness.error);

    const failures = await attributeFailures(listed.value, identity, resolved.value.policyFingerprint);
    if (!failures.ok) return err(failures.error);

    return ok({
      candidateFingerprint: candidate.candidateFingerprint,
      currentCandidateFingerprint,
      collectedAt: deps.clock.now(),
      records: listed.value,
      readiness: readiness.value,
      failures: failures.value,
      staleReasons: assessStaleness(candidate.identity, current).reasons.map(safe),
      notReady: readiness.value.blockingReasons.map(safe),
    });
  }

  /**
   * The `checks` row a provider observation supports.
   *
   * The origin is `ProviderCi` because a provider read is not a local execution, and the
   * detail and artifact reference are redacted before they are stored because provider
   * output may carry a credential (N02-AC2, F20-AC1).
   */
  function providerCheckRecord(
    observation: ProviderCheckObservation,
    identity: RecordedCheckIdentity,
    required: boolean,
    result: CheckResult,
  ): CheckRecord {
    return {
      checkId: safe(observation.name),
      name: safe(observation.name),
      origin: 'ProviderCi',
      required,
      result,
      candidateFingerprint: identity.candidateFingerprint,
      startedAt: safe(observation.startedAt ?? deps.clock.now()),
      endedAt: observation.endedAt,
      exitCode: observation.exitCode,
      artifactRef: observation.artifactUrl === null ? null : safe(observation.artifactUrl),
      detail: observation.detail === null ? null : safe(observation.detail),
      notApplicableApprovedByPolicy: false,
    };
  }

  /**
   * F20-AC4: attributes every current failure of a required check and states that none of
   * them is waived.
   *
   * The base outcome comes from the provider reader. Where the provider cannot report
   * one, the domain records `Indeterminate` with its own explanation, which is the honest
   * answer rather than a guess in either direction.
   */
  async function attributeFailures(
    records: readonly RecordedCheck[],
    identity: RecordedCheckIdentity,
    currentPolicyFingerprint: Fingerprint,
  ): Promise<Result<readonly CheckFailureReport[], DomainError>> {
    const failed = records.filter(
      (recorded) =>
        recorded.record.required &&
        isCurrentFailure(recorded, identity.candidateFingerprint, currentPolicyFingerprint),
    );
    if (failed.length === 0) return ok([]);

    const onBase = await deps.git.failureOnBase({
      baseSha: identity.baseSha,
      checkNames: failed.map((recorded) => recorded.record.name),
    });
    if (!onBase.ok) return err(onBase.error);

    return ok(
      failed.map((recorded): CheckFailureReport => {
        const observed = onBase.value.get(recorded.record.name) ?? null;
        const attributed = attributeCheckFailure({
          failedOnCandidate: true,
          failedOnBaseSha: observed,
          baseShaObserved: observed !== null,
        });
        return {
          checkId: safe(recorded.record.checkId),
          name: safe(recorded.record.name),
          attribution: attributed.classification,
          waivesRequiredCheck: attributed.waivesRequiredCheck,
        };
      }),
    );
  }

  /**
   * F20-AC3, F20-AC4, F24-AC2, F24-AC3, F24-AC4: the card the owner reads.
   *
   * A candidate that is no longer the current one is refused with a `Conflict` naming the
   * expected and the actual identity, because a card rendered for a superseded build shows
   * evidence that cannot approve anything and an action taken from it would act on facts
   * that have moved (F24-AC4). A candidate that is still current but whose scope,
   * environment or policy revision moved is not refused: its results read `Stale` and the
   * card names them, which is what lets the owner see why the work is not ready
   * (F20-AC3).
   */
  function buildReviewCard(candidate: CandidateRecord): Result<ReviewCard, DomainError> {
    const facts = currentFactsFor(candidate);
    if (!facts.ok) return err(facts.error);
    const { policy, snapshot, currentCandidateFingerprint } = facts.value;

    const currentCandidate = currentCandidateFor(candidate);
    if (!currentCandidate.ok) return err(currentCandidate.error);
    if (currentCandidate.value.candidateFingerprint !== candidate.candidateFingerprint) {
      return err(supersededCandidate(candidate, currentCandidate.value));
    }

    const context: CheckPolicyContext = { approved: policy.approved, proposed: policy.proposed };
    const resolved = resolveRequiredChecks(context);
    if (!resolved.ok) return err(resolved.error);
    const currentPolicyFingerprint = resolved.value.policyFingerprint;

    const listed = deps.evidence.listChecks(candidate);
    if (!listed.ok) return err(listed.error);
    const records = listed.value.map((recorded) =>
      asExecutionRecord(recorded, currentCandidateFingerprint, currentPolicyFingerprint),
    );
    const readiness = evaluateCandidateReadiness({ policy: context, records, currentCandidateFingerprint });
    if (!readiness.ok) return err(readiness.error);
    const newestByCheckId = new Map(records.map((record) => [record.checkId, record]));

    /**
     * One line of the card.
     *
     * The result and the blocking flag come from the readiness rules rather than from a
     * second judgement here, which is what puts a required check with no recorded run on
     * the card as `Missing` instead of leaving it off and letting the card read as ready
     * (F20-AC2, F24-AC3).
     */
    const cardCheck = (checkId: string, result: CheckResult, blocking: boolean, required: boolean): ReviewCardCheck => {
      const record = newestByCheckId.get(checkId);
      return {
        checkId: safe(checkId),
        name: safe(record?.name ?? checkId),
        origin: record?.origin ?? null,
        required,
        result,
        blocking,
        exitCode: record?.exitCode ?? null,
        startedAt: record?.startedAt ?? '',
        endedAt: record?.endedAt ?? null,
        artifactRef: record?.artifactRef === null || record?.artifactRef === undefined ? null : safe(record.artifactRef),
        detail: record?.detail === null || record?.detail === undefined ? null : safe(record.detail),
      };
    };

    const checks: ReviewCardCheck[] = [
      ...readiness.value.required.map((check) => cardCheck(check.checkId, check.result, check.blocking, true)),
      ...readiness.value.nonRequired.map((check) => cardCheck(check.checkId, check.result, false, false)),
    ];

    const recorded = deps.evidence.criteriaFor(candidate, currentCandidateFingerprint);
    if (!recorded.ok) return err(recorded.error);
    const byCriterion = new Map(recorded.value.map((row) => [row.criterionId, row]));

    const criteria: ReviewCardCriterion[] = snapshot.acceptanceCriteria.map((criterion) => {
      const row = byCriterion.get(criterion.id);
      const methodKind = row?.methodKind ?? 'Untested';
      return {
        criterionId: safe(criterion.id),
        text: safe(criterion.text),
        methodKind,
        status: row?.status ?? UNOBSERVED_STATUS[methodKind],
        evidenceId: row?.evidenceId ?? null,
        observedAt: row?.observedAt ?? null,
        detail: row === undefined ? safe(UNOBSERVED_DETAIL[methodKind]) : (row.detail ?? null),
      };
    });

    const blockingChecks = checks.filter((check) => check.required && check.blocking);
    const unmet = criteria.filter(
      (criterion) => criterion.status !== 'Verified' && criterion.status !== 'PendingOwnerTest',
    );
    const notReady = [
      ...blockingChecks.map((check) => `Required check "${check.name}" is ${check.result}, not Passed.`),
      ...unmet.map(
        (criterion) => `Criterion "${criterion.criterionId}" is ${criterion.status}, with no verified observation.`,
      ),
    ].map(safe);

    return ok({
      candidateFingerprint: candidate.candidateFingerprint,
      headSha: candidate.identity.headSha,
      baseSha: candidate.identity.baseSha,
      scopeFingerprint: snapshot.scopeFingerprint,
      scopeRevision: snapshot.sequenceNumber,
      collectedAt: deps.clock.now(),
      checks,
      criteria,
      pendingOwnerTestCriterionIds: criteria
        .filter((criterion) => criterion.status === 'PendingOwnerTest')
        .map((criterion) => criterion.criterionId),
      readyForOwnerTest: blockingChecks.length === 0,
      notReady,
    });
  }

  /**
   * The candidate the work item currently offers.
   *
   * Read from the durable candidates rather than from the caller's argument, because the
   * whole question F24-AC4 asks is whether that argument is still current. A work item with
   * no other candidate is its own current candidate, so a first run is never refused.
   */
  const currentCandidateFor = (candidate: CandidateRecord): Result<CandidateRecord, DomainError> => {
    const listed = deps.candidates.listForWorkItem(candidate.workItemId);
    if (!listed.ok) return err(listed.error);
    return ok(listed.value[listed.value.length - 1] ?? candidate);
  };

  /**
   * The conflict a superseded candidate earns, naming both identities and the inputs that
   * differ.
   *
   * The reasons come from the domain's own comparison between the recorded identity and
   * the current one, so the card cannot claim a candidate is unchanged when the recorded
   * identities differ, and the owner is handed a candidate to look at rather than only a
   * refusal (F24-AC4).
   */
  const supersededCandidate = (candidate: CandidateRecord, current: CandidateRecord): DomainError => {
    const reasons = assessStaleness(candidate.identity, current.identity).reasons;
    return conflict(
      `This was requested for a candidate that is no longer the current one; it differs in ${
        reasons.length === 0 ? 'its recorded identity' : reasons.join(', ')
      }. Work from the current candidate instead (F24-AC4).`,
      candidate.candidateFingerprint,
      current.candidateFingerprint,
    );
  };

  /**
   * F23-AC1, F23-AC3, F23-AC4, F23-AC5: builds and records the criterion-linked pack.
   *
   * Every criterion the captured scope names gets a row: assigned a method, given at most
   * one observation's verdict, and persisted against the identity the pack was built for.
   * A criterion nothing observed is `Untested`, `Missing` or `PendingOwnerTest` — never
   * `Verified` — so a green check run cannot claim the whole scope (F23-AC1).
   */
  function buildEvidencePack(
    candidate: CandidateRecord,
    request: EvidencePackRequest,
  ): Result<EvidenceBundle, DomainError> {
    const facts = currentFactsFor(candidate);
    if (!facts.ok) return err(facts.error);
    const { snapshot, current, currentCandidateFingerprint } = facts.value;

    const currentCandidate = currentCandidateFor(candidate);
    if (!currentCandidate.ok) return err(currentCandidate.error);
    if (currentCandidate.value.candidateFingerprint !== candidate.candidateFingerprint) {
      return err(supersededCandidate(candidate, currentCandidate.value));
    }

    const assigned = new Map(request.assignments.map((assignment) => [assignment.criterionId, assignment]));
    const bundle = buildCriterionBundle({
      bundleId: request.bundleId,
      correlationId: request.correlationId,
      identity: current,
      eligiblePreview: request.eligiblePreview,
      requirements: snapshot.acceptanceCriteria.map((criterion) => {
        const assignment = assigned.get(criterion.id);
        return {
          criterionId: criterion.id,
          text: criterion.text,
          method:
            assignment?.method ??
            ({
              kind: 'Untested',
              reason: `No verification method is assigned to "${criterion.id}", so nothing can verify it (F23-AC1).`,
            } as const),
          requiresDeployedObservation: assignment?.requiresDeployedObservation ?? false,
        };
      }),
      observations: request.observations,
    });
    if (!bundle.ok) return err(bundle.error);

    const recordedAt = deps.clock.now();
    for (const record of bundle.value.records) {
      const written = deps.evidence.recordCriterion({
        candidate,
        bundleFingerprint: currentCandidateFingerprint,
        record,
        recordedAt,
        correlationId: request.correlationId,
      });
      if (!written.ok) return err(written.error);
    }
    return ok(bundle.value);
  }

  /**
   * F23-AC1, F23-AC5, F25: records the owner's own test outcome for one criterion.
   *
   * Owner-only, because an owner test is the owner's statement about their own product and
   * no other role may write it. The criterion must already be assigned the `OwnerTest`
   * method: assigning that method is a scope decision, and promoting an automated
   * criterion to an owner test here would let the caller choose the weaker verification
   * for their own work (F23-AC1).
   */
  function recordOwnerTest(
    candidate: CandidateRecord,
    criterionId: string,
    outcome: OwnerTestOutcome,
  ): Result<OwnerTestReport, DomainError> {
    if (outcome.actor.role !== 'Owner') {
      return err({
        code: 'Forbidden',
        reason: `Only the owner may record an owner test result; the ${outcome.actor.role} role may not (F23-AC1, F25-AC1).`,
      });
    }
    const facts = currentFactsFor(candidate);
    if (!facts.ok) return err(facts.error);
    const { snapshot, current, currentCandidateFingerprint } = facts.value;

    const criterion = snapshot.acceptanceCriteria.find((entry) => entry.id === criterionId);
    if (criterion === undefined) {
      return err({
        code: 'NotFound',
        reason: `The captured scope for work item ${candidate.workItemId} names no criterion "${criterionId}", so there is nothing for the owner to have tested (F23-AC1).`,
      });
    }

    const currentCandidate = currentCandidateFor(candidate);
    if (!currentCandidate.ok) return err(currentCandidate.error);
    if (currentCandidate.value.candidateFingerprint !== candidate.candidateFingerprint) {
      return err(supersededCandidate(candidate, currentCandidate.value));
    }

    const assigned = deps.evidence.criterionFor(candidate, currentCandidateFingerprint, criterionId);
    if (!assigned.ok) return err(assigned.error);
    if (assigned.value === null || assigned.value.methodKind !== 'OwnerTest') {
      return err(
        invalid(`Criterion "${criterionId}" is not an owner test.`, [
          {
            path: 'criterionId',
            message:
              'An owner test may only be recorded for a criterion whose assigned method is OwnerTest. Choosing that method here would let a caller pick the weaker verification (F23-AC1).',
          },
        ]),
      );
    }

    const bundle = buildCriterionBundle({
      bundleId: `owner-test:${criterionId}`,
      correlationId: outcome.correlationId,
      identity: current,
      eligiblePreview: null,
      requirements: [
        {
          criterionId,
          text: criterion.text,
          method: { kind: 'OwnerTest', instructions: safe(criterion.text) },
          requiresDeployedObservation: false,
        },
      ],
      observations: [
        {
          criterionId,
          evidenceId: ownerTestEvidenceId(candidate, criterionId, currentCandidateFingerprint),
          observation: outcome.observation,
          environment: outcome.environment,
          capturedAt: deps.clock.now(),
          component: outcome.component,
          deploymentId: outcome.deploymentId,
          artifacts: [],
          apiExchange: null,
          detail: outcome.note,
        },
      ],
    });
    if (!bundle.ok) return err(bundle.error);
    const record = bundle.value.records[0];
    if (record === undefined) {
      return err({
        code: 'Unavailable',
        reason: `The owner test for "${criterionId}" produced no criterion record, so nothing was recorded (F23-AC1).`,
      });
    }

    const written = deps.evidence.recordCriterion({
      candidate,
      bundleFingerprint: currentCandidateFingerprint,
      record,
      recordedAt: deps.clock.now(),
      correlationId: outcome.correlationId,
    });
    if (!written.ok) return err(written.error);

    const rows = deps.evidence.criteriaFor(candidate, currentCandidateFingerprint);
    if (!rows.ok) return err(rows.error);
    const texts = new Map(snapshot.acceptanceCriteria.map((entry) => [entry.id, safe(entry.text)]));
    const ready = acceptanceReady(rows.value.map((row) => criterionEvidenceFor(row, texts.get(row.criterionId) ?? '')));

    return ok({
      criterionId: safe(criterionId),
      candidateFingerprint: currentCandidateFingerprint,
      criterion: written.value,
      acceptance: {
        ready,
        reasons: ready
          ? []
          : rows.value
              .filter((row) => row.status !== 'Verified')
              .map((row) => safe(`Criterion "${row.criterionId}" is ${row.status}.`)),
      },
    });
  }

  return { runRequiredChecks, buildReviewCard, buildEvidencePack, recordOwnerTest };
}

/* -------------------------------------------------------------------------- */
/* Criterion projection                                                         */
/* -------------------------------------------------------------------------- */

/** The evidence identity one owner test records itself under (F23-AC1). */
function ownerTestEvidenceId(
  candidate: CandidateRecord,
  criterionId: string,
  bundleFingerprint: Fingerprint,
): EvidenceId {
  return `evid-owner-test:${candidate.candidateId}:${criterionId}:${bundleFingerprint}` as EvidenceId;
}

/**
 * The domain criterion evidence a stored row carries.
 *
 * The method is reconstructed from the durable kind rather than restated, and the row's own
 * identity is carried through, so a verdict recorded under a superseded identity cannot
 * satisfy acceptance for the current one (F20-AC3, F23-AC1).
 */
function criterionEvidenceFor(row: CriterionEvidenceRow, instructions: string): CriterionEvidence {
  return {
    criterionId: row.criterionId,
    method: methodFor(row, instructions),
    status: row.status,
    evidenceId: row.evidenceId,
    candidateFingerprint: row.candidateFingerprint,
    scopeFingerprint: row.scopeFingerprint,
    observedAt: row.observedAt,
  };
}

function methodFor(row: CriterionEvidenceRow, instructions: string): CriterionVerificationMethod {
  switch (row.methodKind) {
    case 'AutomatedCheck':
      return { kind: 'AutomatedCheck', checkId: row.checkId ?? '' };
    case 'OwnerTest':
      return { kind: 'OwnerTest', instructions };
    case 'BrowserEvidence':
      return { kind: 'BrowserEvidence', evidenceId: row.evidenceId };
    case 'ApiEvidence':
      return { kind: 'ApiEvidence', evidenceId: row.evidenceId };
    case 'Untested':
      return { kind: 'Untested', reason: row.detail ?? UNOBSERVED_DETAIL.Untested };
  }
}

/* -------------------------------------------------------------------------- */
/* SQLite journal                                                               */
/* -------------------------------------------------------------------------- */

const CHECK_COLUMNS =
  'check_id, name, origin, required, result, not_applicable_approved_by_policy, candidate_fingerprint, started_at, ended_at, exit_code, artifact_ref, detail_redacted';

const CRITERION_COLUMNS =
  'evidence_id, criterion_id, method_kind, status, check_id, candidate_fingerprint, scope_fingerprint, observed_at, artifact_ref, detail_redacted';

const CRITERION_STATUSES: readonly CriterionStatus[] = [
  'Verified',
  'PendingOwnerTest',
  'Failed',
  'Missing',
  'Untested',
  'Stale',
];

const METHOD_KINDS: readonly CriterionMethodKind[] = [
  'AutomatedCheck',
  'OwnerTest',
  'BrowserEvidence',
  'ApiEvidence',
  'Untested',
];

const CHECK_ORIGINS: readonly CheckOrigin[] = [
  'LocalCheck',
  'ProviderCi',
  'BrowserEvidence',
  'ApiEvidence',
  'LiveSmoke',
];

function requiredText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`column ${column} is missing or not text`);
  return value;
}

function optionalText(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error(`column ${column} is neither text nor absent`);
  return value;
}

function optionalInteger(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') throw new Error(`column ${column} is neither a number nor absent`);
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], column: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`column ${column} holds "${value}", which is not a value this code recognises`);
  }
  return value as T;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The durable observation journal over the migrated schema.
 *
 * A duplication, and reported as one: `@shiploop/storage` exports an `EvidenceRepository`
 * that writes a `checks` row from inside its own evidence write, and no reader for either
 * table. This class states only the columns F20 and F23 name, so replacing it with a
 * storage-side reader is a change of class rather than a change of schema.
 *
 * The two primary keys are per-execution surrogates derived here rather than the
 * profile-visible names, because `checks.check_id` and `evidence.evidence_id` are unique
 * across the whole database while a check name and a criterion identity repeat: the same
 * check runs again for the next candidate and under the next policy revision, and the same
 * criterion is re-judged for every candidate. A `CheckRecord` still carries the profile's
 * name as its `checkId`, because that is the identity the policy, the readiness rules and
 * the card speak in; the surrogate is a row identity the schema needs and no reader
 * presents (F20-AC3, F23-AC1).
 *
 * Two write rules are worth reading before changing anything here:
 *
 *   - a `checks` row is a fact about one execution, keyed by the candidate, the check name
 *     and the instant it started. A repeated write for the same execution is ignored and
 *     the existing row returned, because "the provider still reports the same run" is not
 *     a new observation and must not overwrite the one already on record. A genuine rerun
 *     starts later and writes its own row (F20-AC3);
 *   - an `evidence` row is a verdict, keyed by the candidate, the criterion, the method and
 *     the identity. A later observation of the same criterion under the same identity
 *     replaces the verdict, so a corrected owner test converges rather than conflicting
 *     (F23-AC1, and operations that converge on the same end state across retries).
 */

/** The row identity one execution of one check owns. */
function checkRowId(candidateId: string, name: string, startedAt: string): string {
  return `chk_${createHash('sha256').update(`${candidateId}|${name}|${startedAt}`, 'utf8').digest('hex').slice(0, 32)}`;
}

/** The row identity one criterion's verdict under one candidate identity owns. */
function evidenceRowId(
  candidateId: string,
  criterionId: string,
  methodKind: string,
  bundleFingerprint: string,
): string {
  return `evid_${createHash('sha256')
    .update(`${candidateId}|${criterionId}|${methodKind}|${bundleFingerprint}`, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}

export class SqliteObservationJournal implements ObservationJournal {
  private readonly connection: StorageConnection;

  constructor(connection: StorageConnection) {
    this.connection = connection;
  }

  recordCheck(input: RecordCheckInput): Result<RecordedCheck> {
    return this.attempt('record check result', () => {
      const project = this.projectFor(input.candidate.candidateId);
      const record = redactDeep<CheckRecord>(input.record);
      this.connection
        .prepare(
          `INSERT INTO checks (${CHECK_COLUMNS}, candidate_id, work_item_id, project_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(
          checkRowId(input.candidate.candidateId, record.name, record.startedAt),
          record.name,
          record.origin,
          record.required ? 1 : 0,
          record.result,
          record.notApplicableApprovedByPolicy ? 1 : 0,
          record.candidateFingerprint,
          record.startedAt,
          record.endedAt,
          record.exitCode,
          record.artifactRef,
          record.detail,
          input.candidate.candidateId,
          input.candidate.workItemId,
          project,
        );
      const row = this.connection
        .prepare(`SELECT ${CHECK_COLUMNS} FROM checks WHERE candidate_id = ? AND name = ? AND started_at = ?`)
        .get(input.candidate.candidateId, record.name, record.startedAt);
      if (row === undefined) return err({ code: 'NotFound', reason: `Check "${record.name}" was not recorded.` });
      return ok(this.toRecordedCheck(row, input.candidate));
    });
  }

  listChecks(candidate: CandidateRecord): Result<readonly RecordedCheck[]> {
    return this.attempt('list check results', () =>
      ok(
        this.connection
          .prepare(`SELECT ${CHECK_COLUMNS} FROM checks WHERE candidate_id = ? ORDER BY started_at ASC, check_id ASC`)
          .all(candidate.candidateId)
          .map((row) => this.toRecordedCheck(row, candidate)),
      ),
    );
  }

  criteriaFor(
    candidate: CandidateRecord,
    currentCandidateFingerprint: Fingerprint,
  ): Result<readonly CriterionEvidenceRow[]> {
    return this.attempt('list criterion evidence', () =>
      ok(
        this.connection
          .prepare(
            `SELECT ${CRITERION_COLUMNS} FROM evidence
               WHERE candidate_id = ? AND candidate_fingerprint = ?
               ORDER BY criterion_id ASC`,
          )
          .all(candidate.candidateId, currentCandidateFingerprint)
          .map(toCriterionRow),
      ),
    );
  }

  criterionFor(
    candidate: CandidateRecord,
    currentCandidateFingerprint: Fingerprint,
    criterionId: string,
  ): Result<CriterionEvidenceRow | null> {
    return this.attempt('read criterion evidence', () => {
      const row = this.connection
        .prepare(
          `SELECT ${CRITERION_COLUMNS} FROM evidence
             WHERE candidate_id = ? AND candidate_fingerprint = ? AND criterion_id = ?`,
        )
        .get(candidate.candidateId, currentCandidateFingerprint, criterionId);
      return ok(row === undefined ? null : toCriterionRow(row));
    });
  }

  recordCriterion(input: RecordCriterionInput): Result<CriterionEvidenceRow> {
    return this.attempt('record criterion evidence', () => {
      const record = input.record;
      const methodKind = record.method.kind;
      const checkId = methodKind === 'AutomatedCheck' ? this.checkRowOf(input.candidate, record.method.checkId) : null;
      if (methodKind === 'AutomatedCheck' && checkId === null) {
        return err(
          invalid(`Criterion "${record.criterionId}" names no recorded check for its automated method.`, [
            {
              path: 'method.checkId',
              message: `The durable row binds an automated criterion to a real check, and no check named "${record.method.checkId}" has run for this candidate. Run the check, then record the verdict (F23-AC1).`,
            },
          ]),
        );
      }
      const result = record.observation === null ? null : CHECK_RESULT_FOR_OBSERVATION[record.observation];
      const project = this.projectFor(input.candidate.candidateId);
      const artifactRef = record.artifacts[0]?.name;
      this.connection
        .prepare(
          `INSERT INTO evidence (evidence_id, candidate_id, work_item_id, project_id, check_id, candidate_fingerprint,
                                 scope_fingerprint, criterion_id, method_kind, status, kind, check_name, result,
                                 artifact_ref, detail_redacted, observed_at, environment_fingerprint, recorded_at,
                                 correlation_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (candidate_id, criterion_id, method_kind, candidate_fingerprint) DO UPDATE SET
             status = excluded.status,
             result = excluded.result,
             artifact_ref = excluded.artifact_ref,
             detail_redacted = excluded.detail_redacted,
             observed_at = excluded.observed_at,
             recorded_at = excluded.recorded_at,
             correlation_id = excluded.correlation_id,
             updated_at = excluded.updated_at`,
        )
        .run(
          evidenceRowId(input.candidate.candidateId, safe(record.criterionId), methodKind, input.bundleFingerprint),
          input.candidate.candidateId,
          input.candidate.workItemId,
          project,
          checkId,
          input.bundleFingerprint,
          record.scopeFingerprint,
          safe(record.criterionId),
          methodKind,
          record.status,
          EVIDENCE_KIND_FOR_METHOD[methodKind],
          methodKind === 'AutomatedCheck' ? safe(record.method.checkId) : null,
          result,
          artifactRef === undefined ? null : safe(artifactRef),
          record.detail === null ? null : safe(record.detail),
          record.observedAt,
          input.candidate.identity.environmentFingerprint,
          input.recordedAt,
          input.correlationId,
          input.recordedAt,
          input.recordedAt,
        );
      const read = this.connection
        .prepare(
          `SELECT ${CRITERION_COLUMNS} FROM evidence
             WHERE candidate_id = ? AND candidate_fingerprint = ? AND criterion_id = ?`,
        )
        .get(input.candidate.candidateId, input.bundleFingerprint, safe(record.criterionId));
      if (read === undefined) {
        return err({ code: 'NotFound', reason: `Criterion "${record.criterionId}" was not recorded.` });
      }
      return ok(toCriterionRow(read));
    });
  }

  /**
   * The row identity of the newest recorded run of a check the profile names.
   *
   * Resolved rather than trusted because the schema binds an automated criterion's verdict
   * to a real `checks` row, and a criterion that names a check which has never run has no
   * observation to file against. Null is the honest answer, and the caller refuses rather
   * than filing a verdict against nothing (F23-AC1).
   */
  private checkRowOf(candidate: CandidateRecord, name: string): string | null {
    const row = this.connection
      .prepare('SELECT check_id FROM checks WHERE candidate_id = ? AND name = ? ORDER BY started_at DESC LIMIT 1')
      .get(candidate.candidateId, safe(name));
    return row === undefined ? null : requiredText(row, 'check_id');
  }

  private projectFor(candidateId: string): string {
    const row = this.connection.prepare('SELECT project_id FROM candidates WHERE candidate_id = ?').get(candidateId);
    if (row === undefined) throw new Error(`candidate ${candidateId} is not recorded, so its project is unknown`);
    return requiredText(row, 'project_id');
  }

  /**
   * The recorded result with the identity it was recorded under.
   *
   * The durable row stores one identity input — the candidate fingerprint — so the other
   * inputs are read from the candidate the row belongs to. A row written under a
   * superseded policy or environment revision keeps that revision in its fingerprint, which
   * is the comparison the freshness rules make (F20-AC3).
   */
  private toRecordedCheck(row: SqlRow, candidate: CandidateRecord): RecordedCheck {
    const record: CheckRecord = {
      checkId: requiredText(row, 'name'),
      name: requiredText(row, 'name'),
      origin: oneOf(requiredText(row, 'origin'), CHECK_ORIGINS, 'origin'),
      required: optionalInteger(row, 'required') === 1,
      result: oneOf(requiredText(row, 'result'), CHECK_RESULTS, 'result'),
      candidateFingerprint: requiredText(row, 'candidate_fingerprint') as Fingerprint,
      startedAt: requiredText(row, 'started_at'),
      endedAt: optionalText(row, 'ended_at'),
      exitCode: optionalInteger(row, 'exit_code'),
      artifactRef: optionalText(row, 'artifact_ref'),
      detail: optionalText(row, 'detail_redacted'),
      notApplicableApprovedByPolicy: optionalInteger(row, 'not_applicable_approved_by_policy') === 1,
    };
    return {
      record,
      identity: {
        candidateFingerprint: record.candidateFingerprint,
        headSha: candidate.identity.headSha,
        baseSha: candidate.identity.baseSha,
        scopeFingerprint: candidate.identity.scopeFingerprint,
        environmentFingerprint: candidate.identity.environmentFingerprint,
        policyFingerprint: candidate.identity.policyFingerprint,
      },
    };
  }

  private attempt<T>(description: string, body: () => Result<T, DomainError>): Result<T, DomainError> {
    try {
      return body();
    } catch (error) {
      return err({ code: 'Unavailable', reason: `${description} failed: ${describe(error)}` });
    }
  }
}

function toCriterionRow(row: SqlRow): CriterionEvidenceRow {
  return {
    evidenceId: requiredText(row, 'evidence_id') as EvidenceId,
    criterionId: requiredText(row, 'criterion_id'),
    methodKind: oneOf(requiredText(row, 'method_kind'), METHOD_KINDS, 'method_kind'),
    status: oneOf(requiredText(row, 'status'), CRITERION_STATUSES, 'status'),
    checkId: optionalText(row, 'check_id'),
    candidateFingerprint: requiredText(row, 'candidate_fingerprint') as Fingerprint,
    scopeFingerprint: requiredText(row, 'scope_fingerprint') as Fingerprint,
    observedAt: optionalText(row, 'observed_at'),
    artifactRef: optionalText(row, 'artifact_ref'),
    detail: optionalText(row, 'detail_redacted'),
  };
}
