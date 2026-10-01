/**
 * Job start, lifecycle transitions and owner limit extensions (F13, F17, F18).
 *
 * This layer answers three questions and owns no policy of its own:
 *
 *   - may this work start, and what is it then permitted to do (F13-AC1, F13-AC3);
 *   - which lifecycle move may be made, and what survives it (F17-AC1, F17-AC3, F17-AC4);
 *   - what happens when an attempt reaches a bounded limit (F18-AC2).
 *
 * Every judgement is delegated rather than restated. Readiness comes from the domain's
 * `assessReadiness`, the limit decision from `evaluateLimits`, the delivery refusal from
 * `evaluateGrant`, and transition legality from the durable queue's own `markState`, which
 * validates against the domain attempt table. A second copy of any of those in this file
 * would be the copy a reviewer reads and the one that decides, so none exists here.
 *
 * Every durable write is one of the queue's, and the queue commits the row before it
 * reports success, so an acknowledged start is a persisted job rather than an intention
 * (F13-AC1, N01-AC3). Success is never reported for work this layer cannot see persisted.
 *
 * Three properties are enforced rather than documented:
 *
 *   - a start is refused unless the recorded readiness verdict is `Ready`, and the refusal
 *     names the area that failed with its remedy, so the owner is told what to fix rather
 *     than that something is wrong (F09-AC2, F13-AC1);
 *   - the capability grant returned by a start is read back from the durable row and
 *     carries no delivery capability, with the domain's own refusal explanation attached, so
 *     "no mode implies merge or release authorization" is a value a caller can read rather
 *     than a promise (F13-AC3, N01-AC3);
 *   - cancellation preserves the recorded resume point and reports external delivery as
 *     untouched, because a cancelled job cannot unmerge, unrelease or unredeploy anything
 *     (F17-AC4).
 */

import { createHash } from 'node:crypto';

import {
  DEFAULT_LIMITS,
  assessReadiness,
  blocked,
  conflict,
  err,
  evaluateGrant,
  evaluateLimits,
  invalid,
  ok,
} from '@shiploop/domain';
import type {
  AttemptLimits,
  CapabilityKind,
  DomainError,
  ExceededLimit,
  JobId,
  JobMode,
  LimitsEvaluation,
  OperationId,
  OwnerId,
  OwnerWaitInterval,
  ReadinessDecision,
  ReadinessObservation,
  Result,
  ScopeSnapshot,
  WorkItemId,
} from '@shiploop/domain';
import type {
  JobCheckpoint,
  JobLimits,
  JobOperation,
  JobQueue,
  JobRecord,
  LeaseDisposition,
  LeaseManager,
  ProjectProfileRepository,
  ProcedureRepository,
  ScopeRepository,
  ScopeSnapshotRecord,
  WorkItemRepository,
} from '@shiploop/storage';

import { RECIPE_SUBJECT_KEY } from './profiles.ts';
import type { ControllerClock } from './profiles.ts';

/* -------------------------------------------------------------------------- */
/* Inputs and outputs                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A request to start work on one work item.
 *
 * `operationId` is the caller's stable operation identity, not one minted here: a handler
 * that retries after a timeout must be able to present the same identity, and a
 * controller-generated one would be new on every attempt, so the retry would start a second
 * job (F13-AC2).
 *
 * `readiness` and `scope` are observations rather than decisions. Readiness is a recorded
 * judgement about live provider facts (F09-AC1, F09-AC4) and scope belongs to the provider
 * that owns the issue (F12-AC1); neither is something this layer can read for itself, so the
 * caller hands over what it observed and the domain decides what it means.
 */
export interface StartRunInput {
  readonly workItemId: WorkItemId;
  /** One of Plan, Investigate, Build, Test or Review (F13-AC3). */
  readonly mode: JobMode;
  readonly operationId: OperationId;
  /**
   * The owner who asked for the start.
   *
   * Required because F13-AC5 makes the recorded owner start action the only thing that
   * launches a coding job: an ordinary ticket update must not start one.
   */
  readonly ownerId: OwnerId;
  readonly readiness: ReadinessObservation;
  readonly scope: ScopeSnapshot;
  /** Identity of the larger flow this run is part of; the operation identity when it is not. */
  readonly correlationId: string | null;
}

/**
 * The capability grant a started job holds.
 *
 * `permittedOperations` is re-read from the durable row rather than recomputed from the
 * mode, so this is what the job may actually do and not what it was supposed to do. The
 * refusal is part of the value: a grant that is silently missing merge authority reads as
 * an oversight, and a caller that cannot see the reason cannot show the owner why delivery
 * is a separate decision (F13-AC3, F03-AC5).
 */
export interface RunCapabilityGrant {
  readonly mode: JobMode;
  readonly permittedOperations: readonly JobOperation[];
  /** Delivery operations absent from the grant, named rather than omitted (F13-AC3). */
  readonly refusedDeliveryOperations: readonly JobOperation[];
  /** The domain boundary's own explanation of the refusal (F03-AC5). */
  readonly refusalReason: string;
}

/**
 * Where a started job sits with respect to the single global coding writer (F13-AC2).
 *
 * `claimed: true` would be the interesting statement — "a worker takes this now" — and
 * nothing here can support it, because claiming is the writer's act. So this states only
 * what durable state supports: the job is Queued, and these jobs still hold the writer.
 */
export interface RunDispatch {
  readonly state: 'Queued';
  /** Jobs still holding the single global coding writer. Empty when it is free. */
  readonly heldByWriter: readonly JobId[];
  readonly reason: string;
}

/**
 * A start that was accepted, or a repeat of one that already was.
 *
 * `deduplicated` is what distinguishes the two (F13-AC2): both return the one job the
 * operation identity started, and only the second call was a repeat.
 */
export interface RunStart {
  readonly job: JobRecord;
  readonly deduplicated: boolean;
  readonly capturedScope: ScopeSnapshotRecord;
  readonly dispatch: RunDispatch;
  readonly grant: RunCapabilityGrant;
  /**
   * The decision this start was admitted on, or null for a repeat.
   *
   * A repeat is not re-admitted: the durable job is the record of that decision, and
   * refusing the repeat because the world has moved on would hide work already running
   * (F13-AC2).
   */
  readonly readiness: ReadinessDecision | null;
  readonly requestedByOwner: OwnerId;
}

/** Who holds the coding writer for a job, and whether that ownership is usable (F17-AC5). */
export interface RunWriter {
  readonly holder: string | null;
  /** `Unleased` when no lease was ever written for this job. */
  readonly disposition: LeaseDisposition | 'Unleased';
  readonly expiresAt: string | null;
  /** Why a writer cannot be trusted yet, when the lease says so (F17-AC5). */
  readonly reconciliationReason: string | null;
}

/**
 * A run as it is stored.
 *
 * The checkpoint is read through the queue rather than remembered, so a resume point that
 * was never written is reported as absent instead of being reconstructed (F17-AC2).
 */
export interface RunView {
  readonly job: JobRecord;
  readonly checkpoint: JobCheckpoint | null;
  readonly writer: RunWriter;
}

/**
 * A paused run, and the evidence that its writer stopped (F17-AC1).
 *
 * `writerStopped` is a separate field rather than an implication of the state because
 * F17-AC1 allows `Paused` to be shown only once the writer is stopped or safely detached.
 * A pause that leaves a writer recorded is a pause that can still be writing code.
 */
export interface PausedRun {
  readonly job: JobRecord;
  readonly writerStopped: boolean;
  readonly writer: RunWriter;
  readonly checkpoint: JobCheckpoint | null;
}

/**
 * A resumed run and the resume point it resumed from (F17-AC3).
 *
 * The checkpoint is not optional: resuming without one is re-deriving the workspace from
 * scratch, which is the work F17-AC2 exists to make unnecessary.
 */
export interface ResumedRun {
  readonly job: JobRecord;
  readonly checkpoint: JobCheckpoint;
}

/**
 * A cancelled run and what survived it (F17-AC4).
 *
 * `externalDelivery` is a one-member type on purpose. A cancelled job cannot unmerge,
 * unrelease or unredeploy anything: those are external writes this layer neither issued nor
 * can reverse, so "the delivery was undone" is not a value a caller can even construct here.
 * An already-started delivery stays in whatever state the provider reached and is reconciled
 * from there (F17-AC4, F30-AC5).
 */
export interface CancelledRun {
  readonly job: JobRecord;
  readonly preservedCheckpoint: JobCheckpoint | null;
  readonly writer: RunWriter;
  readonly externalDelivery: 'UnchangedByCancellation';
}

/** What an attempt has consumed, as reported by the layer that ran it (F18-AC2). */
export interface RunLimitUsage {
  readonly wallClockMs: number;
  readonly fixPasses: number;
  /** Recorded owner waits, which do not consume active execution time (F18-AC3). */
  readonly ownerWaits: readonly OwnerWaitInterval[];
}

/**
 * The owner decision a reached limit asks for (F18-AC2).
 *
 * The reason and the limits are the domain's own strings and numbers: the request is a
 * record of the policy's decision, so a second arithmetic rule in this layer could not
 * produce a different bound from the one that raised the request.
 */
export interface OwnerExtensionRequest {
  readonly jobId: JobId;
  readonly reached: readonly ExceededLimit[];
  readonly reason: string;
  readonly limits: AttemptLimits;
  readonly observedActiveMs: number;
  readonly observedFixPasses: number;
  readonly raisedAt: string;
}

/** The limit decision for one attempt, and the request it raised, if any (F18-AC2). */
export interface RunLimitAssessment {
  readonly evaluation: LimitsEvaluation;
  readonly limits: AttemptLimits;
  /** Present exactly when the attempt must checkpoint and wait for an owner (F18-AC2). */
  readonly request: OwnerExtensionRequest | null;
}

/** A granted extension and the bound work may now continue within (F18-AC2). */
export interface GrantedExtension {
  readonly job: JobRecord;
  readonly previousLimits: AttemptLimits;
  readonly extendedLimits: AttemptLimits;
  /**
   * Whether the extended bound is stored with the job.
   *
   * False, and typed rather than hidden: the durable job row carries the limits the job was
   * started with, and no port in `@shiploop/storage` writes an extension onto it. So the
   * extended bound travels on this response and cannot be recovered from the job alone,
   * which is a gap in F18-AC2 rather than a property of the grant. Reporting `true` here
   * would let a caller assume the owner could extend again after a restart and discover
   * otherwise from a job that silently lost the bound (F18-AC2, N01-AC3).
   */
  readonly extendedBoundRecorded: false;
  readonly decidedBy: OwnerId;
  readonly decidedAt: string;
}

/** A declined extension, which leaves the job waiting for its owner (F18-AC2). */
export interface DeclinedExtension {
  readonly job: JobRecord;
  readonly limitsInForce: AttemptLimits;
  readonly decidedBy: OwnerId;
  readonly decidedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Dependencies                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything the job use cases touch, injected (F13-AC1, F17-AC2, F18-AC2).
 *
 * `limits` is required rather than defaulted here so the recorded bound is whatever this
 * deployment configured; a bound no configured value can change is not a bound, and the
 * v0.1 default belongs to the domain's `DEFAULT_LIMITS` rather than to a constant here.
 */
export interface JobUseCaseDeps {
  readonly clock: ControllerClock;
  readonly queue: JobQueue;
  readonly leases: LeaseManager;
  readonly profiles: ProjectProfileRepository;
  readonly procedures: ProcedureRepository;
  readonly workItems: WorkItemRepository;
  readonly scope: ScopeRepository;
  readonly limits: JobLimits;
}

/**
 * The job use cases a transport drives.
 *
 * Every entry returns a `Result`: an owner waiting for an extension and an illegal lifecycle
 * move need different next steps, so neither may arrive as an exception or as a success that
 * means something else (mvp-spec 7, F18-AC2).
 */
export interface JobUseCases {
  readonly startRun: (input: StartRunInput) => Result<RunStart, DomainError>;
  readonly getRun: (jobId: JobId) => Result<RunView, DomainError>;
  readonly pauseRun: (jobId: JobId) => Result<PausedRun, DomainError>;
  readonly resumeRun: (jobId: JobId) => Result<ResumedRun, DomainError>;
  readonly cancelRun: (jobId: JobId) => Result<CancelledRun, DomainError>;
  readonly checkRunLimits: (jobId: JobId, usage: RunLimitUsage) => Result<RunLimitAssessment, DomainError>;
  readonly grantExtension: (jobId: JobId, ownerId: OwnerId) => Result<GrantedExtension, DomainError>;
  readonly declineExtension: (jobId: JobId, ownerId: OwnerId) => Result<DeclinedExtension, DomainError>;
  readonly permittedOperationFor: (jobId: JobId, operation: JobOperation) => Result<JobOperation, DomainError>;
}

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The delivery surface, named in both vocabularies that have to agree (F13-AC3, N01-AC3).
 *
 * A job's grant is the storage `JobOperation` vocabulary while the capability boundary
 * judges the domain's `CapabilityKind`, and neither names the other's terms. Naming the
 * correspondence is what lets the refusal reason come from `evaluateGrant` instead of being
 * written out a second time here, and it is checked against the domain's decision rather
 * than trusted (F03-AC5).
 */
const DELIVERY_OPERATIONS: readonly { readonly operation: JobOperation; readonly capability: CapabilityKind }[] = [
  { operation: 'Merge', capability: 'Git:MergeWithPrecondition' },
  { operation: 'Release', capability: 'Deployment:Execute' },
  { operation: 'RecoveryRedeploy', capability: 'Deployment:Execute' },
];

/**
 * The job identity an operation identity starts.
 *
 * Derived rather than generated so a retry of the same operation identity addresses the
 * same job before any work happens. That is what turns F13-AC2's "one job per operation
 * identity" into a property of the request rather than a race the queue has to win: the
 * repeat finds its own row and returns it, instead of capturing a second scope snapshot and
 * arriving at the queue as a different request.
 */
export function derivedJobId(operationId: OperationId): JobId {
  // A JSON array rather than a delimiter: no operation identity can be mistaken for a
  // boundary between the operation and the attempt.
  const seed = JSON.stringify(['job', operationId.trim()]);
  return `job_${createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32)}` as JobId;
}

/**
 * The bounded limits an attempt is judged against, from the ones recorded with the job.
 *
 * A projection between two shapes of one policy, not a second policy. The recorded bounds
 * are the job's; the retry allowance is the domain's declared one, because `JobLimits`
 * records a per-operation retry count while the decision that matters is the domain's own
 * `retryAllowedWithinLimits`. Every decision about whether a limit was reached stays in
 * `evaluateLimits` (F18-AC2, F18-AC3).
 */
export function attemptLimitsFor(limits: JobLimits): AttemptLimits {
  return {
    activeExecutionMs: limits.activeExecutionMs,
    automatedFixPasses: limits.maxAutomatedFixPasses,
    toolRetry: DEFAULT_LIMITS.toolRetry,
  };
}

/**
 * The bound one owner extension adds.
 *
 * One more unit of the domain's own default allowance rather than a number chosen here, so
 * a grant extends by the same measure the limit was expressed in and a deployment that
 * changes the default changes the grant with it (F18-AC2).
 */
function extendLimits(limits: AttemptLimits): AttemptLimits {
  return {
    ...limits,
    activeExecutionMs: limits.activeExecutionMs + DEFAULT_LIMITS.activeExecutionMs,
    automatedFixPasses: limits.automatedFixPasses + DEFAULT_LIMITS.automatedFixPasses,
  };
}

/**
 * The recorded grant of a job, with the delivery refusals that make it a boundary
 * (F13-AC3).
 *
 * Read from the durable row rather than recomputed from the mode, so this is what the job
 * may actually do. Two refusals are deliberate. A recorded grant that did contain a delivery
 * operation is an error rather than a value, because returning it would report authority the
 * queue still refuses later — a contradiction the caller would discover at the moment it
 * mattered most. And a grant the domain boundary would actually allow is equally an error,
 * because it would mean the refusal reason below was invented here rather than derived.
 */
function grantFor(job: JobRecord): Result<RunCapabilityGrant, DomainError> {
  const held = new Set(job.permittedOperations);
  const refused: JobOperation[] = [];
  const reasons: string[] = [];

  for (const entry of DELIVERY_OPERATIONS) {
    if (held.has(entry.operation)) {
      return err(
        blocked(`Job ${job.jobId} is recorded with ${entry.operation}, which no mode may hold (F13-AC3).`, [
          {
            name: 'delivery-authorization',
            detail: `Recorded grant: ${job.permittedOperations.join(', ')}.`,
            remedy:
              'Start the work in a mode that needs no delivery authority, then authorize merge or release as a separate owner decision.',
          },
        ]),
      );
    }
    const decision = evaluateGrant({
      mode: job.mode,
      requestedCapability: entry.capability,
      grantedCapabilities: [],
      actorRole: 'CodingAgent',
    });
    if (decision.allowed) {
      return err({
        code: 'Unavailable',
        reason: `The capability boundary authorized ${entry.capability} for a coding actor, so its refusal can no longer be stated as one (F03-AC5).`,
      });
    }
    refused.push(entry.operation);
    reasons.push(`${entry.operation}: ${decision.explanation}`);
  }

  return ok({
    mode: job.mode,
    permittedOperations: [...job.permittedOperations],
    refusedDeliveryOperations: refused,
    refusalReason: reasons.join(' '),
  });
}

/* -------------------------------------------------------------------------- */
/* Use cases                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Builds the job start, lifecycle and limit use cases.
 *
 * Everything they touch is injected: clock, queue, lease manager, repositories and the
 * recorded limits. A test therefore contacts no provider and reads no ambient time, and a
 * deployment supplies the same shapes from the composition root.
 */
export function createJobUseCases(deps: JobUseCaseDeps): JobUseCases {
  const now = (): string => deps.clock.now();

  const requireJob = (jobId: JobId): Result<JobRecord, DomainError> => {
    const job = deps.queue.readJob(jobId);
    if (!job.ok) return err(job.error);
    if (job.value === null) return err({ code: 'NotFound', reason: `No job ${jobId} exists.` });
    return ok(job.value);
  };

  const readWriter = (job: JobRecord, at: string): Result<RunWriter, DomainError> => {
    const lease = deps.leases.leaseStatus(job.jobId);
    if (!lease.ok) return err(lease.error);
    if (lease.value === null) {
      return ok({ holder: job.holder, disposition: 'Unleased', expiresAt: null, reconciliationReason: null });
    }
    return ok({
      holder: lease.value.holder,
      disposition: deps.leases.leaseDisposition(lease.value, at),
      expiresAt: lease.value.expiresAt,
      reconciliationReason: lease.value.reconciliationReason,
    });
  };

  /**
   * Who the owner is for a decision only an owner may make (F18-AC2).
   *
   * Refused rather than defaulted: an extension or a decline changes what work the system
   * may do next, and admitting an unnamed caller would make "the owner extended this" a
   * claim nothing supports.
   */
  const requireOwnerIdentity = (ownerId: OwnerId): Result<OwnerId, DomainError> => {
    if (ownerId.trim().length === 0) {
      return err({
        code: 'Forbidden',
        reason: 'An owner decision about a work limit must name the owner who made it (F18-AC2).',
      });
    }
    return ok(ownerId);
  };

  /**
   * Whether the single global coding writer is free (F13-AC2).
   *
   * Derived from two durable facts and the lease manager's own disposition rule rather than
   * from a private reading of the slot: a job that still names a holder, and a lease that
   * is not vacant. An expired lease is `ReconciliationRequired` rather than free, so a
   * start answered from this does not claim the writer is available while a second writer is
   * still a question somebody has to answer (F17-AC5).
   */
  const dispatchFor = (job: JobRecord, at: string): Result<RunDispatch, DomainError> => {
    const listed = deps.queue.listJobs({ states: null, projectId: null });
    if (!listed.ok) return err(listed.error);

    const held: JobId[] = [];
    for (const other of listed.value) {
      if (other.jobId === job.jobId || other.holder === null) continue;
      const lease = deps.leases.leaseStatus(other.jobId);
      if (!lease.ok) return err(lease.error);
      if (lease.value === null) continue;
      if (deps.leases.leaseDisposition(lease.value, at) === 'Vacant') continue;
      held.push(other.jobId);
    }

    if (held.length === 0) {
      return ok({
        state: 'Queued',
        heldByWriter: [],
        reason: 'No other job holds the single global coding writer, so the coding worker can claim this job (F13-AC2).',
      });
    }
    return ok({
      state: 'Queued',
      heldByWriter: held,
      reason: `The single global coding writer is held for ${held.join(', ')}, so this job stays Queued until that writer finishes (F13-AC2).`,
    });
  };

  /**
   * Refuses a start whose readiness is not `Ready`, naming the failed area (F09-AC2, F13-AC1).
   *
   * The area and its remedy travel with the refusal because a blocked start with no
   * actionable area is the one that costs the owner a session. Only `Ready` admits a start:
   * the decision's own `mayStartInvestigation` is carried on the assessment a caller already
   * holds, so this rule does not have to restate which modes are read-only to answer it.
   */
  const requireReady = (decision: ReadinessDecision): Result<true, DomainError> => {
    if (decision.verdict === 'Ready') return ok(true);
    return err(
      blocked(
        `Work ${decision.subjectId} is ${decision.verdict}: ${decision.reasons.map((reason) => `${reason.area} ${reason.reason}`).join(' ')} (F09-AC2).`,
        decision.findings.map((finding) => ({
          name: `readiness-${finding.area.toLowerCase()}`,
          detail: `${finding.area} is ${finding.status}: ${finding.reason}`,
          remedy: finding.remedy ?? 'Establish this prerequisite and assess readiness again.',
        })),
      ),
    );
  };

  /**
   * The inputs a job must record before it is resumable (F13-AC1, F02-AC3, F05-AC1).
   *
   * Resolved rather than accepted from the caller, because a job that recorded a profile or
   * recipe version belonging to another project would be resumable against the wrong
   * configuration and no later check would notice. The scope snapshot is captured here
   * because Linear owns the published scope and a run's belief about it has to be recorded
   * when it starts, not looked up later (F12-AC1).
   */
  const resolveRunInputs = (
    input: StartRunInput,
    at: string,
  ): Result<
    {
      readonly projectId: JobRecord['projectId'];
      readonly profileVersionId: string;
      readonly procedureVersionId: string;
      readonly capturedScope: ScopeSnapshotRecord;
    },
    DomainError
  > => {
    const workItem = deps.workItems.get(input.workItemId);
    if (!workItem.ok) return err(workItem.error);

    const profile = deps.profiles.getVersion(workItem.value.profileVersionId);
    if (!profile.ok) return err(profile.error);
    if (profile.value.projectId !== workItem.value.projectId) {
      return err({
        code: 'NotFound',
        reason: `Work item ${input.workItemId} names a profile version from another project (F02-AC2).`,
      });
    }

    const recipe = deps.procedures.currentVersion(workItem.value.projectId, RECIPE_SUBJECT_KEY);
    if (!recipe.ok) return err(recipe.error);
    if (recipe.value === null) {
      return err(
        blocked(`No environment recipe is recorded for this project, so there is nothing to prepare (F05-AC1).`, [
          {
            name: 'environment-recipe',
            detail: `Project ${workItem.value.projectId} has no current version of ${RECIPE_SUBJECT_KEY}.`,
            remedy: 'Save an environment recipe and let preflight verify it, then start the run again.',
          },
        ]),
      );
    }

    const captured = deps.scope.capture({
      scope: input.scope,
      attemptId: null,
      profileVersionId: workItem.value.profileVersionId,
      procedureVersionId: recipe.value.procedureVersionId,
      capturedAt: at,
      correlationId: input.correlationId,
    });
    if (!captured.ok) return err(captured.error);

    return ok({
      projectId: workItem.value.projectId,
      profileVersionId: workItem.value.profileVersionId,
      procedureVersionId: recipe.value.procedureVersionId,
      capturedScope: captured.value,
    });
  };

  /**
   * Starts work on a work item (F13-AC1, F13-AC2, F13-AC3, F09-AC2, F13-AC5).
   *
   * The order is load bearing. Readiness is judged before anything is captured, so a blocked
   * start leaves no scope snapshot behind as if work had begun. A repeat of an operation
   * identity is answered from the job it already started, before any of that, so the repeat
   * costs one read and cannot capture a second snapshot (F13-AC2). The durable row is written
   * by the queue inside its own transaction, and only after it commits does this report
   * success (F13-AC1, N01-AC3).
   */
  const startRun = (input: StartRunInput): Result<RunStart, DomainError> => {
    const empty = requireIdentities(input);
    if (!empty.ok) return err(empty.error);

    const at = now();
    const jobId = derivedJobId(input.operationId);

    const existing = deps.queue.readJob(jobId);
    if (!existing.ok) return err(existing.error);
    if (existing.value !== null) return repeatOfStart(input, existing.value, at);

    const readiness = assessReadiness(input.readiness);
    if (!readiness.ok) return err(readiness.error);
    const admitted = requireReady(readiness.value);
    if (!admitted.ok) return err(admitted.error);

    const inputs = resolveRunInputs(input, at);
    if (!inputs.ok) return err(inputs.error);

    const enqueued = deps.queue.enqueue({
      operationId: input.operationId,
      mode: input.mode,
      workItemId: input.workItemId,
      scopeSnapshotId: inputs.value.capturedScope.scopeSnapshotId,
      projectId: inputs.value.projectId,
      profileVersionId: inputs.value.profileVersionId,
      procedureVersionId: inputs.value.procedureVersionId,
      jobId,
      now: at,
      ...(input.correlationId === null ? {} : { correlationId: input.correlationId }),
      limits: deps.limits,
      permittedOperations: null,
    });
    if (!enqueued.ok) return err(enqueued.error);

    const grant = grantFor(enqueued.value.job);
    if (!grant.ok) return err(grant.error);
    const dispatch = dispatchFor(enqueued.value.job, at);
    if (!dispatch.ok) return err(dispatch.error);

    return ok({
      job: enqueued.value.job,
      deduplicated: enqueued.value.deduplicated,
      capturedScope: inputs.value.capturedScope,
      dispatch: dispatch.value,
      grant: grant.value,
      readiness: readiness.value,
      requestedByOwner: input.ownerId,
    });
  };

  /**
   * The start a repeated operation identity already made (F13-AC2).
   *
   * A repeat that names the same work in the same mode returns that job. A repeat that
   * names different work is a `Conflict` rather than the first job, because handing back a
   * job for a different request would report work that was never asked for as started.
   */
  const repeatOfStart = (input: StartRunInput, job: JobRecord, at: string): Result<RunStart, DomainError> => {
    if (job.operationId !== input.operationId || job.workItemId !== input.workItemId || job.mode !== input.mode) {
      return err(
        conflict(
          `Operation identity ${input.operationId} already started job ${job.jobId} as ${job.mode} for ${job.workItemId}; a different request cannot reuse it (F13-AC2).`,
          `${job.operationId}/${job.workItemId}/${job.mode}`,
          `${input.operationId}/${input.workItemId}/${input.mode}`,
        ),
      );
    }
    const capturedScope = deps.workItems.getScopeSnapshot(job.scopeSnapshotId);
    if (!capturedScope.ok) return err(capturedScope.error);
    const grant = grantFor(job);
    if (!grant.ok) return err(grant.error);
    const dispatch = dispatchFor(job, at);
    if (!dispatch.ok) return err(dispatch.error);

    return ok({
      job,
      deduplicated: true,
      capturedScope: capturedScope.value,
      dispatch: dispatch.value,
      grant: grant.value,
      readiness: null,
      requestedByOwner: input.ownerId,
    });
  };

  /** Reads the run and the resume point a resume would use (F13-AC1, F17-AC2). */
  const getRun = (jobId: JobId): Result<RunView, DomainError> => {
    const job = requireJob(jobId);
    if (!job.ok) return err(job.error);
    const writer = readWriter(job.value, now());
    if (!writer.ok) return err(writer.error);
    const checkpoint = deps.queue.readCheckpoint(jobId);
    if (!checkpoint.ok) return err(checkpoint.error);
    return ok({ job: job.value, checkpoint: checkpoint.value, writer: writer.value });
  };

  /**
   * Pauses a run and reports whether its writer actually stopped (F17-AC1).
   *
   * The transition is validated by the queue against the domain attempt table, so a pause
   * of a state that may not be paused is refused with the typed `Invalid` rather than
   * forced. Pausing also gives up the coding slot, and this layer reports that from the
   * lease rather than assuming it: a pause that left a writer recorded would be a pause that
   * may still be writing code.
   */
  const pauseRun = (jobId: JobId): Result<PausedRun, DomainError> => {
    const job = requireJob(jobId);
    if (!job.ok) return err(job.error);
    const at = now();

    const paused = deps.queue.markState({ jobId, state: 'Paused', now: at });
    if (!paused.ok) return err(paused.error);
    const writer = readWriter(paused.value, at);
    if (!writer.ok) return err(writer.error);
    const checkpoint = deps.queue.readCheckpoint(jobId);
    if (!checkpoint.ok) return err(checkpoint.error);

    const writerStopped = writer.value.disposition === 'Vacant' || writer.value.disposition === 'Unleased';
    if (!writerStopped) {
      return err({
        code: 'Unavailable',
        reason: `Job ${jobId} is Paused while ${writer.value.holder ?? 'a writer'} still holds it, so the pause cannot be reported as complete (F17-AC1).`,
      });
    }
    return ok({ job: paused.value, writerStopped, writer: writer.value, checkpoint: checkpoint.value });
  };

  /**
   * Resumes a paused run from its recorded resume point (F17-AC3).
   *
   * Refused without a checkpoint rather than resumed blind: the checkpoint is what carries
   * the workspace, the full commit identity and the dirty and untracked inventory, and
   * continuing without it re-derives the work the checkpoint exists to preserve (F17-AC2).
   * The comparison of that record against the actual workspace is the writer's act — this
   * layer holds no repository — and the checkpoint travels out with the response so the
   * comparison has something to be made against.
   */
  const resumeRun = (jobId: JobId): Result<ResumedRun, DomainError> => {
    const job = requireJob(jobId);
    if (!job.ok) return err(job.error);
    const at = now();

    const checkpoint = deps.queue.readCheckpoint(jobId);
    if (!checkpoint.ok) return err(checkpoint.error);
    if (checkpoint.value === null) {
      return err(
        blocked(`Job ${jobId} has no recorded resume point, so there is nothing to resume from (F17-AC2).`, [
          {
            name: 'resume-point',
            detail: `Job ${jobId} is ${job.value.state} and no checkpoint has been written for it.`,
            remedy: 'Write the resume point while the writer still holds the job, then resume it.',
          },
        ]),
      );
    }

    const resumed = deps.queue.markState({ jobId, state: 'Running', now: at });
    if (!resumed.ok) return err(resumed.error);
    return ok({ job: resumed.value, checkpoint: checkpoint.value });
  };

  /**
   * Cancels a run and preserves what it had (F17-AC4).
   *
   * The checkpoint is read back after the transition rather than remembered, so a
   * cancellation reports the resume point that actually survived. Cancelled is not Queued, so
   * the queue will not hand this job to another writer and no further coding is dispatched
   * for it. Nothing here touches external delivery, and the response type has no value that
   * could say otherwise.
   */
  const cancelRun = (jobId: JobId): Result<CancelledRun, DomainError> => {
    const job = requireJob(jobId);
    if (!job.ok) return err(job.error);
    const at = now();

    const cancelled = deps.queue.markState({ jobId, state: 'Cancelled', now: at });
    if (!cancelled.ok) return err(cancelled.error);
    const checkpoint = deps.queue.readCheckpoint(jobId);
    if (!checkpoint.ok) return err(checkpoint.error);
    const writer = readWriter(cancelled.value, at);
    if (!writer.ok) return err(writer.error);

    return ok({
      job: cancelled.value,
      preservedCheckpoint: checkpoint.value,
      writer: writer.value,
      externalDelivery: 'UnchangedByCancellation',
    });
  };

  /**
   * Judges an attempt against the recorded limits and raises the request it owes (F18-AC2).
   *
   * The decision is the domain's, over the limits recorded with the job, so the reason the
   * owner reads is the policy's own words. This call performs the waiting half of F18-AC2: the
   * job moves to `WaitingForOwner` in the same call that raises the request, so the request is
   * something the owner can find from the job rather than a value that existed inside one
   * response. Writing the resume point is the writer's half and happens before this call,
   * because only the writer holds the workspace identity a checkpoint records (F17-AC2).
   *
   * Repeating the call is harmless — the domain allows a state to its own self — so a worker
   * that re-asks after a crash converges on the same job rather than failing.
   */
  const checkRunLimits = (jobId: JobId, usage: RunLimitUsage): Result<RunLimitAssessment, DomainError> => {
    const job = requireJob(jobId);
    if (!job.ok) return err(job.error);
    const at = now();

    const limits = attemptLimitsFor(job.value.limits);
    const evaluation = evaluateLimits({
      limits,
      wallClockMs: usage.wallClockMs,
      fixPasses: usage.fixPasses,
      ownerWaits: usage.ownerWaits,
    });
    if (!evaluation.ownerExtensionRequired) return ok({ evaluation, limits, request: null });

    const waiting = deps.queue.markState({ jobId, state: 'WaitingForOwner', now: at });
    if (!waiting.ok) return err(waiting.error);

    return ok({
      evaluation,
      limits,
      request: {
        jobId,
        reached: evaluation.reached,
        reason: evaluation.reason,
        limits,
        observedActiveMs: evaluation.activeMs,
        observedFixPasses: evaluation.fixPasses,
        raisedAt: at,
      },
    });
  };

  /**
   * Extends a waiting attempt by one owner-decided unit and lets it continue (F18-AC2).
   *
   * The bound comes from the limits recorded with the job plus one unit of the domain's
   * default allowance, and the job returns to Running in the same call, so work resumes
   * rather than merely being permitted to. Only a job that is actually waiting can be
   * extended: extending a running one would be a quiet second budget nobody asked for.
   *
   * The extension is not written to storage, because nothing in `@shiploop/storage` can
   * write it: `jobs.limits` is written once, by `enqueue`. The response says so through
   * `extendedBoundRecorded`, and `checkRunLimits` therefore judges the recorded bound, so a
   * second reached limit raises a second request. That is the honest behaviour while the
   * durable form is missing: the owner can extend again, rather than the job appearing to
   * hold a budget that was never stored (F18-AC2).
   */
  const grantExtension = (jobId: JobId, ownerId: OwnerId): Result<GrantedExtension, DomainError> => {
    const owner = requireOwnerIdentity(ownerId);
    if (!owner.ok) return err(owner.error);
    const job = requireJob(jobId);
    if (!job.ok) return err(job.error);
    const at = now();

    if (job.value.state !== 'WaitingForOwner') {
      return err(
        conflict(
          `Job ${jobId} is ${job.value.state}, so there is no reached limit to extend.`,
          'WaitingForOwner',
          job.value.state,
        ),
      );
    }

    const previousLimits = attemptLimitsFor(job.value.limits);
    const extendedLimits = extendLimits(previousLimits);
    const resumed = deps.queue.markState({ jobId, state: 'Running', now: at });
    if (!resumed.ok) return err(resumed.error);

    return ok({
      job: resumed.value,
      previousLimits,
      extendedLimits,
      extendedBoundRecorded: false,
      decidedBy: owner.value,
      decidedAt: at,
    });
  };

  /**
   * Declines an extension, leaving the attempt waiting (F18-AC2).
   *
   * No state is written: a declined extension leaves the checkpointed work exactly as it was
   * and the job in `WaitingForOwner`, which is the whole meaning of the decision. The state
   * in the response is read back from storage, so it reports what the job is rather than
   * what this call intended.
   */
  const declineExtension = (jobId: JobId, ownerId: OwnerId): Result<DeclinedExtension, DomainError> => {
    const owner = requireOwnerIdentity(ownerId);
    if (!owner.ok) return err(owner.error);
    const job = requireJob(jobId);
    if (!job.ok) return err(job.error);

    if (job.value.state !== 'WaitingForOwner') {
      return err(
        conflict(
          `Job ${jobId} is ${job.value.state}, so there is no pending extension request to decline.`,
          'WaitingForOwner',
          job.value.state,
        ),
      );
    }

    return ok({
      job: job.value,
      limitsInForce: attemptLimitsFor(job.value.limits),
      decidedBy: owner.value,
      decidedAt: now(),
    });
  };

  /**
   * Whether a job may perform an operation, decided by the queue's own check (F13-AC3).
   *
   * Nothing here interprets the granted set: the operation is passed to the queue together
   * with the job row it recorded, so the answer is "does this job hold it" rather than
   * "does the mode permit it". A transport that reads an operation name out of a request
   * parses it into `JobOperation` at that boundary, so an unknown name cannot reach this
   * function and a grant the queue refuses cannot be widened by a caller reaching past it.
   */
  const permittedOperationFor = (jobId: JobId, operation: JobOperation): Result<JobOperation, DomainError> => {
    const job = requireJob(jobId);
    if (!job.ok) return err(job.error);
    return deps.queue.permittedOperation(job.value, operation);
  };

  return {
    startRun,
    getRun,
    pauseRun,
    resumeRun,
    cancelRun,
    checkRunLimits,
    grantExtension,
    declineExtension,
    permittedOperationFor,
  };
}

/**
 * Refuses a start that names nothing to start.
 *
 * An empty work item, operation or owner identity would produce a job row that cannot be
 * resumed, deduplicated or attributed, so each is refused where it was given rather than
 * becoming a column that reads as if it were recorded (F13-AC1, F13-AC5).
 */
function requireIdentities(input: StartRunInput): Result<true, DomainError> {
  const fields: { path: string; message: string }[] = [];
  if (input.workItemId.trim().length === 0) {
    fields.push({ path: 'workItemId', message: 'Name the work item this run works on.' });
  }
  if (input.operationId.trim().length === 0) {
    fields.push({
      path: 'operationId',
      message: 'A stable operation identity is required, so a retry resolves to one job rather than a second (F13-AC2).',
    });
  }
  if (input.ownerId.trim().length === 0) {
    fields.push({
      path: 'ownerId',
      message: 'The recorded owner start action is what launches a coding job (F13-AC5).',
    });
  }
  if (fields.length === 0) return ok(true);
  return err(invalid('The run could not be started as given.', fields));
}
