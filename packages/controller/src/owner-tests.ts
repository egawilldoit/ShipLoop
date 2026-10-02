/**
 * Manual owner test recording, bound to the exact candidate and the applicable
 * deployment (F25-AC1, F24-AC4, F23-AC1, F23-AC2, F23-AC3, F23-AC4, F23-AC5, F20-AC3,
 * F01-AC1, N02-AC2).
 *
 * An owner test is the owner's own statement about their own product. This module exists so
 * that every other way of arriving at "verified" is unavailable here, and the properties
 * below are each enforced by a mechanism rather than by a comment:
 *
 *   - **An observation is an observation of something (F23-AC3).** A command names a
 *     criterion, the exact candidate fingerprint the owner's page was rendered against, the
 *     deployment the owner looked at *or* an explicit statement that none applies, what they
 *     saw, and a reference to retained evidence. It has no field for a claimed result, a
 *     claimed actor or a claimed instant: the verdict is asked of the verification
 *     package's `buildEvidencePack`, the actor is the authenticated role's owner identity,
 *     and the instant is the injected clock. A caller cannot backdate or re-attribute an
 *     observation because it has nowhere to put either (F25-AC4).
 *   - **The deployment identity is resolved, not asserted (F22-AC1, F23-AC4).** A named
 *     deployment must match a component this candidate actually carries, on all three of
 *     component, deployment id and environment. A candidate that carries a deployment
 *     cannot be tested against "no deployment", so a local label can never quietly satisfy
 *     a criterion the owner was meant to look at in a preview; and "none applies" is a
 *     statement the owner has to make, with a reason, rather than a default.
 *   - **A stale submission is refused, not re-pointed (F24-AC4, F20-AC3).** Both the
 *     candidate the request names and the fingerprint it was prepared against are compared
 *     against the work item's current candidate, and either mismatch is a typed `Conflict`
 *     naming the expected and the actual identity. The refusal happens before any write, so
 *     a submission made against a superseded build is never filed against its replacement.
 *   - **An observation cannot replace a stronger method (F23-AC1).** The criterion must
 *     already carry the `OwnerTest` method, and each other method kind is refused naming
 *     which method actually verifies it. Choosing the method here would let a caller assign
 *     their own work the weakest verification, and a generic green check must not satisfy a
 *     criterion it never observed.
 *   - **A failed owner test is not a failed check (F23-AC5).** Every stored record carries
 *     `failureKind`: `BehaviorFailure` for something the owner watched go wrong,
 *     `CaptureFailure` for a capture that never happened, null for neither. A capture
 *     failure records the `Missing` status the verification package derives for it, and
 *     this field is what keeps that readable as a capture failure rather than as a
 *     behaviour failure; `methodKind` keeps the whole record apart from the `checks` table.
 *
 * Two durable rows are written, in one transaction:
 *
 *   - the **verdict** in `evidence`, bound to `(candidate_id, criterion_id, method_kind,
 *     candidate_fingerprint)`, so a replacement candidate starts with nothing satisfied and
 *     a repeat for the same identity converges on the corrected verdict rather than
 *     appending a second claim;
 *   - the **attribution** in `audit_log`, whose `actor` column is `NOT NULL`. That row is
 *     what makes the actor and the instant durable, and it is written in the same
 *     transaction because either row alone is a defect: a verdict with no recorded actor is
 *     an unattributable observation, and an audit entry for a verdict that was never filed
 *     records something that did not happen (F25-AC4).
 *
 * Nothing here is a second copy of a judgement. The verdict is asked of
 * `buildEvidencePack`, the current candidate is read from the store rather than compared
 * against anything supplied, and every stored or returned string passes through the
 * domain's `redact` (N02-AC2). This module imports no engine, adapter or webhook contract,
 * so a run that reports success, a provider event or an agent's own summary has no entry
 * point to call (F25-AC4).
 */

import { createHash } from 'node:crypto';

import { err, invalid, ok, redact } from '@shiploop/domain';
import type {
  CandidateId,
  ComponentIdentity,
  CriterionStatus,
  DomainError,
  EvidenceId,
  Fingerprint,
  OwnerId,
  ProjectId,
  Result,
  WorkItemId,
} from '@shiploop/domain';
import { buildEvidencePack } from '@shiploop/verification';
import type {
  BehaviorObservation,
  EvidenceArtifact,
  EvidenceEnvironment,
  EvidenceRecord,
} from '@shiploop/verification';
import { TransactionError, withTransaction } from '@shiploop/storage';
import type {
  CandidateRecord,
  CandidateStore,
  Database,
  ScopeSnapshotRecord,
  SqlRow,
  WorkItemRecord,
} from '@shiploop/storage';
import type { CriterionEvidenceRow, ObservationJournal } from './verification.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';

/* -------------------------------------------------------------------------- */
/* What one observation says                                                   */
/* -------------------------------------------------------------------------- */

/** The kinds of retained reference an owner test may point at (F23-AC2). */
export type OwnerEvidenceKind = EvidenceArtifact['kind'];

/**
 * What the owner was looking at.
 *
 * Two shapes and no third, because the third — "somewhere" — is the one that lets a local
 * check or a stale preview stand in for the eligible deployment (F23-AC4).
 * `Deployment` names a component this candidate carries and is resolved against it below;
 * `NoDeployment` is the owner's explicit statement that nothing is deployed for this
 * candidate, with the reason they state, and it is refused outright when a deployment does
 * exist. The evidence environment label is derived from this union rather than accepted, so
 * a `Local` label cannot be attached to a preview or the reverse.
 */
export type OwnerObservationTarget =
  | {
      readonly kind: 'Deployment';
      readonly component: string;
      readonly deploymentId: string;
      readonly environment: string;
    }
  | {
      readonly kind: 'NoDeployment';
      /** Why no deployment applies, recorded verbatim (F23-AC3). */
      readonly reason: string;
    };

/** The retained evidence an observation points at: a store name, never a value (F23-AC2). */
export interface OwnerEvidenceReference {
  readonly kind: OwnerEvidenceKind;
  readonly reference: string;
}

/** One recorded owner observation, read back from the two rows it wrote. */
export interface OwnerObservationRecord {
  readonly evidenceId: EvidenceId;
  readonly criterionId: string;
  readonly methodKind: 'OwnerTest';
  readonly status: CriterionStatus;
  /**
   * How an observation failed to be a pass.
   *
   * `BehaviorFailure` is a behaviour the owner watched go wrong; `CaptureFailure` is a
   * capture that never happened, so nothing was observed at all; null is neither. The two
   * produce different statuses and this field is what keeps them apart without reading the
   * detail prose (F23-AC5).
   */
  readonly failureKind: 'BehaviorFailure' | 'CaptureFailure' | null;
  /** The authenticated owner the observation is attributed to (F25-AC1). */
  readonly observedBy: OwnerId;
  readonly observedAt: string;
  /** Derived from the observation's target, never from the caller. */
  readonly environment: EvidenceEnvironment;
  readonly component: string | null;
  readonly deploymentId: string | null;
  readonly evidenceKind: OwnerEvidenceKind;
  readonly evidenceRef: string;
  readonly detail: string | null;
  readonly candidateId: CandidateId;
  readonly candidateFingerprint: Fingerprint;
  readonly scopeFingerprint: Fingerprint;
  readonly correlationId: string;
}

export interface RecordOwnerObservationCommand {
  /** The candidate the owner's page named. Resolved to the work item's current one below. */
  readonly candidateId: CandidateId;
  /**
   * The fingerprint the owner's page was rendered against.
   *
   * Required and compared, never trusted: a client that could omit it would get whatever is
   * current, which is exactly the action F24-AC4 refuses from an outdated card.
   */
  readonly expectedCandidateFingerprint: Fingerprint;
  readonly criterionId: string;
  /** The authenticated caller. Only the `Owner` role carrying an owner identity passes. */
  readonly actor: OwnerActor;
  readonly observation: BehaviorObservation;
  readonly observedAgainst: OwnerObservationTarget;
  readonly evidence: OwnerEvidenceReference;
  readonly note: string | null;
  readonly correlationId: string;
}

/** The outcome of recording one observation, with the criteria still outstanding. */
export interface OwnerObservationReport {
  readonly observation: OwnerObservationRecord;
  /**
   * Always false, and typed: recording an observation is not accepting the work.
   *
   * Acceptance is a separate decision over every criterion, made by the acceptance use
   * cases, and a client that could read this write as delivery permission would let a
   * single criterion's observation approve a build (F25-AC1, F24-AC3).
   */
  readonly recordedForDelivery: false;
  /** The criteria still not verified for this identity, named (F24-AC3). */
  readonly outstandingCriterionIds: readonly string[];
}

export interface ListOwnerObservationsQuery {
  readonly candidateId: CandidateId;
  /** The exact identity to read; an observation filed under another one is not returned. */
  readonly candidateFingerprint: Fingerprint;
}

/* -------------------------------------------------------------------------- */
/* Ports                                                                       */
/* -------------------------------------------------------------------------- */

/** The work item a candidate belongs to, which is what resolves its project. */
export interface OwnerObservationWorkItemReader {
  get(workItemId: WorkItemId): Result<WorkItemRecord, DomainError>;
}

/** The captured scope a candidate's acceptance criteria come from (F12-AC1). */
export interface OwnerObservationScopeReader {
  latestScopeSnapshot(workItemId: WorkItemId): Result<ScopeSnapshotRecord | null, DomainError>;
}

/** One observation as the writer receives it, with the verdict already derived for it. */
export interface OwnerObservationWrite {
  readonly candidate: CandidateRecord;
  readonly projectId: ProjectId;
  readonly criterionId: string;
  /** The identity the observation is bound to, which the verdict row is filed under. */
  readonly bundleFingerprint: Fingerprint;
  /** The verdict the verification package derived, forwarded to the criterion journal. */
  readonly record: EvidenceRecord;
  readonly observation: BehaviorObservation;
  readonly environment: EvidenceEnvironment;
  readonly component: string | null;
  readonly deploymentId: string | null;
  readonly evidenceKind: OwnerEvidenceKind;
  readonly evidenceRef: string;
  readonly observedBy: OwnerId;
  readonly observedAt: string;
  readonly correlationId: string;
}

/**
 * The durable write, and the read-back of what it wrote.
 *
 * One write method rather than two, because the verdict and its attribution must not be
 * separable: a caller that could file one without the other could record an observation no
 * owner made (F25-AC4).
 */
export interface OwnerObservationJournal {
  record(write: OwnerObservationWrite): Result<OwnerObservationRecord, DomainError>;
  list(query: ListOwnerObservationsQuery): Result<readonly OwnerObservationRecord[], DomainError>;
}

export interface OwnerObservationDeps {
  readonly clock: ControllerClock;
  readonly candidates: Pick<CandidateStore, 'get' | 'listForWorkItem'>;
  readonly workItems: OwnerObservationWorkItemReader;
  readonly scope: OwnerObservationScopeReader;
  /** The criterion verdicts this path reads the assigned method from and files under. */
  readonly evidence: ObservationJournal;
  readonly observations: OwnerObservationJournal;
}

export interface OwnerObservationUseCases {
  /** F25-AC1, F24-AC4, F23-AC1: records one manual criterion observation. */
  readonly recordOwnerObservation: (
    command: RecordOwnerObservationCommand,
  ) => Result<OwnerObservationReport, DomainError>;
  /** F20-AC3: every observation bound to one exact candidate identity. */
  readonly listOwnerObservations: (
    query: ListOwnerObservationsQuery,
  ) => Result<readonly OwnerObservationRecord[], DomainError>;
}

/* -------------------------------------------------------------------------- */
/* Refusals, named                                                              */
/* -------------------------------------------------------------------------- */

/** Every string this module emits or stores is redacted: notes travel into exports (N02-AC2). */
function safe(text: string): string {
  return redact(text).text;
}

/**
 * F25-AC4: the only role permitted to record an observation.
 *
 * Checked before any row is read, so a non-owner caller learns nothing about the candidate
 * from the refusal. Both halves are checked, because a role that claims `Owner` without
 * carrying an owner identity is exactly the unattributable write F25-AC1 rules out — and
 * the durable `actor` column is `NOT NULL`, so the store refuses the same thing again.
 */
function requireOwner(actor: OwnerActor): Result<OwnerId, DomainError> {
  if (actor.role !== 'Owner' || actor.ownerId === null) {
    return err({
      code: 'Forbidden',
      reason: `Only the owner may record a manual test result; the ${actor.role} role may not, and an observation with no authenticated owner behind it is not an observation (F23-AC1, F25-AC1, F25-AC4).`,
    });
  }
  return ok(actor.ownerId);
}

/**
 * F23-AC1: why a criterion cannot take an owner test, named per method kind.
 *
 * Three different facts, so three different messages. An automated criterion is refused
 * because a generic green check is not evidence about a criterion it never observed, and
 * equally an owner statement is not evidence about a check that does observe it: a
 * captured-evidence criterion is refused because a retained screenshot or sanitized
 * exchange is a different kind of artefact rather than a weaker one; and a criterion with no
 * method at all is refused because assigning the method here would let the caller pick the
 * weakest verification for their own work.
 *
 * The method kind is named and nothing else is, because the durable row's `check_id` is a
 * per-execution row surrogate rather than the profile-visible check name, and printing a
 * surrogate to an owner would answer a question they did not ask (F20-AC3).
 */
function weakerMethodRefusal(criterionId: string, recorded: CriterionEvidenceRow | null): DomainError {
  const methodKind = recorded?.methodKind ?? 'Untested';
  const because =
    methodKind === 'AutomatedCheck'
      ? 'It is verified by a recorded automated check. A manual observation cannot stand in for the check that actually observes it, and a green check is not evidence about a criterion it never observed (F23-AC1).'
      : methodKind === 'BrowserEvidence'
        ? 'Its method is BrowserEvidence, which is verified by a retained screenshot of the flow, not by a manual statement (F23-AC2).'
        : methodKind === 'ApiEvidence'
          ? 'Its method is ApiEvidence, which is verified by a retained sanitized request/result, not by a manual statement (F23-AC2).'
          : 'No verification method is assigned to it. Choosing the method here would let the caller assign their own work the weakest verification (F23-AC1).';
  return invalid(`Criterion "${safe(criterionId)}" is not verified by an owner test.`, [
    { path: 'criterionId', message: `Its assigned method is ${methodKind}. ${because}` },
  ]);
}

/** The target as the writer records it, once it has been resolved against the candidate. */
type ResolvedTarget =
  | { readonly environment: 'Preview'; readonly component: string; readonly deploymentId: string; readonly previewEnvironment: string }
  | { readonly environment: 'Local'; readonly component: null; readonly deploymentId: null };

/**
 * F22-AC1, F23-AC4: the deployment an observation claims, resolved against the candidate.
 *
 * The candidate's own `identity.components` is the authority, because that is the identity
 * the deployment was recorded under. A component this candidate does not carry is refused by
 * name, and a deployment id or environment that disagrees with the recorded one is refused
 * with both, so an owner who tested a stale preview is told which preview they should have
 * tested rather than having the answer filed against the wrong build.
 */
function resolveTarget(candidate: CandidateRecord, target: OwnerObservationTarget): Result<ResolvedTarget, DomainError> {
  if (target.kind === 'NoDeployment') {
    if (target.reason.trim().length === 0) {
      return err(
        invalid('An observation that names no deployment must say why.', [
          {
            path: 'observedAgainst.reason',
            message: 'State why no deployment applies, so the observation is not an unexplained absence (F23-AC3).',
          },
        ]),
      );
    }
    const deployed = candidate.identity.components.filter(hasDeployment);
    if (deployed.length > 0) {
      return err(
        invalid(`Candidate ${safe(candidate.candidateFingerprint)} carries a deployment, so an observation of it cannot declare that none applies.`, [
          {
            path: 'observedAgainst',
            message: `This candidate was deployed as ${deployed.map(describeComponent).join(', ')}. Observe it there: local evidence is labelled local and cannot satisfy a criterion that requires deployed behaviour (F23-AC4, F22-AC1).`,
          },
        ]),
      );
    }
    return ok({ environment: 'Local', component: null, deploymentId: null });
  }

  const declared = candidate.identity.components.find((component) => component.component === target.component);
  if (declared === undefined) {
    const known = candidate.identity.components.map((component) => component.component).join(', ') || 'none';
    return err(
      invalid(`Candidate ${safe(candidate.candidateFingerprint)} carries no component "${safe(target.component)}".`, [
        {
          path: 'observedAgainst.component',
          message: `This candidate's components are ${known}. An observation belongs to a deployment this candidate carries, or it does not belong to it (F22-AC1).`,
        },
      ]),
    );
  }
  if (declared.deploymentId === null) {
    return err(
      invalid(`Component "${safe(target.component)}" is not deployed for candidate ${safe(candidate.candidateFingerprint)}.`, [
        {
          path: 'observedAgainst.deploymentId',
          message: 'This component carries no deployment identity, so there is nothing to observe it on (F22-AC1).',
        },
      ]),
    );
  }
  if (declared.deploymentId !== target.deploymentId || declared.environment !== target.environment) {
    return err(
      invalid(
        `Deployment "${safe(target.deploymentId)}" in ${safe(target.environment)} is not this candidate's ${safe(target.component)} deployment.`,
        [
          {
            path: 'observedAgainst',
            message: `Candidate ${safe(candidate.candidateFingerprint)} deployed ${safe(target.component)} as ${safe(declared.deploymentId)} in ${safe(declared.environment)}. An observation of a different deployment is not evidence about this build (F22-AC2, F23-AC4).`,
          },
        ],
      ),
    );
  }
  return ok({
    environment: 'Preview',
    component: declared.component,
    deploymentId: declared.deploymentId,
    previewEnvironment: declared.environment,
  });
}

function hasDeployment(component: ComponentIdentity): component is ComponentIdentity & { readonly deploymentId: string } {
  return component.deploymentId !== null;
}

function describeComponent(component: ComponentIdentity & { readonly deploymentId: string }): string {
  return `${safe(component.component)} at ${safe(component.deploymentId)}`;
}

/** The evidence identity one owner test records itself under, per candidate identity (F23-AC1). */
function ownerTestEvidenceId(candidate: CandidateRecord, criterionId: string, fingerprint: Fingerprint): EvidenceId {
  return `evid-owner-test:${candidate.candidateId}:${safe(criterionId)}:${fingerprint}` as EvidenceId;
}

/** How an observation failed to be a pass (F23-AC5). */
function failureKindFor(
  observation: BehaviorObservation,
): 'BehaviorFailure' | 'CaptureFailure' | null {
  if (observation === 'BehaviorFailed') return 'BehaviorFailure';
  if (observation === 'CaptureFailed') return 'CaptureFailure';
  return null;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Builds the owner-test use cases.
 *
 * Everything they touch is injected: the clock that stamps an observation, the durable
 * candidate list that decides whether a submission is current, the captured scope the
 * criteria come from, the criterion verdicts, and the writer that files both rows. No use
 * case reads ambient time or writes SQL, so a test exercises this layer against the real
 * repositories and the real migrated schema (mvp-spec 7).
 */
export function createOwnerObservationUseCases(deps: OwnerObservationDeps): OwnerObservationUseCases {
  /**
   * F24-AC4: the candidate this work item currently offers, and the refusal when the
   * request was not prepared against it.
   *
   * Read from the durable candidates rather than from the command, because whether that
   * command is still current is the whole question. Both mismatches are reported as the
   * identity the caller acted on against the one that is current, which is the direction
   * every other compare-and-set in this package reports, so a client reads them the same
   * way (F02-AC2).
   */
  const currentCandidateFor = (
    candidate: CandidateRecord,
    claimed: Fingerprint,
  ): Result<CandidateRecord, DomainError> => {
    const listed = deps.candidates.listForWorkItem(candidate.workItemId);
    if (!listed.ok) return err(listed.error);
    const current = listed.value[listed.value.length - 1] ?? candidate;
    if (current.candidateFingerprint !== candidate.candidateFingerprint) {
      return err({
        code: 'Conflict',
        reason: `This was recorded for candidate ${safe(candidate.candidateFingerprint)}, which is no longer the current one; the work item now offers ${safe(current.candidateFingerprint)}. Nothing was recorded against the replacement (F20-AC3, F24-AC4).`,
        expected: candidate.candidateFingerprint,
        actual: current.candidateFingerprint,
      });
    }
    if (claimed !== current.candidateFingerprint) {
      return err({
        code: 'Conflict',
        reason: `This submission was prepared against a candidate that is no longer the current one; nothing was recorded. Re-read the card and observe the current build (F24-AC4).`,
        expected: claimed,
        actual: current.candidateFingerprint,
      });
    }
    return ok(current);
  };

  /** F12-AC1, F24-AC2: the captured scope a candidate's criteria come from. */
  const criteriaFor = (candidate: CandidateRecord): Result<ScopeSnapshotRecord, DomainError> => {
    const found = deps.scope.latestScopeSnapshot(candidate.workItemId);
    if (!found.ok) return err(found.error);
    if (found.value === null) {
      return err({
        code: 'NotFound',
        reason: `No scope revision is recorded for work item ${safe(candidate.workItemId)}, so it has no acceptance criteria for an owner to test (F12-AC1, F24-AC2).`,
      });
    }
    return ok(found.value);
  };

  /**
   * F25-AC1, F24-AC4, F23-AC1, F23-AC3, F23-AC5: records one manual criterion observation.
   *
   * The refusals are ordered, and the order is the argument:
   *
   *   1. the caller is not the owner (F25-AC4), before a single row is read;
   *   2. the named candidate is not the current one, or the fingerprint it was prepared
   *      against is not the current one (F24-AC4, F20-AC3);
   *   3. the criterion does not exist in the captured scope, or is not verified by an owner
   *      test (F23-AC1);
   *   4. the deployment named is not one this candidate carries, or "none applies" is not
   *      true (F22-AC1, F23-AC4);
   *   5. no retained evidence reference was given (F23-AC2).
   *
   * Only after all five does anything get written. What is written is the verdict the
   * verification package derived from the observation plus the attribution this module
   * recorded. No green check run and no healthy deployment is consulted, because neither
   * can verify a criterion (F23-AC1).
   */
  function recordOwnerObservation(
    command: RecordOwnerObservationCommand,
  ): Result<OwnerObservationReport, DomainError> {
    const owner = requireOwner(command.actor);
    if (!owner.ok) return err(owner.error);

    const found = deps.candidates.get(command.candidateId);
    if (!found.ok) return err(found.error);
    const candidate = found.value;
    const current = currentCandidateFor(candidate, command.expectedCandidateFingerprint);
    if (!current.ok) return err(current.error);

    const snapshot = criteriaFor(candidate);
    if (!snapshot.ok) return err(snapshot.error);
    const criterion = snapshot.value.acceptanceCriteria.find((entry) => entry.id === command.criterionId);
    if (criterion === undefined) {
      return err({
        code: 'NotFound',
        reason: `The captured scope for work item ${safe(candidate.workItemId)} names no criterion "${safe(command.criterionId)}", so there is nothing for the owner to have tested (F23-AC1).`,
      });
    }

    /**
     * F23-AC1: the method is read from the recorded verdict, never from the command.
     *
     * The criterion's own row under the current identity is where its assigned method
     * lives. Reading it here rather than accepting one is what stops a caller recording an
     * owner test against a criterion an automated check already verifies, and what makes an
     * unassigned criterion a refusal rather than an invitation.
     */
    const assigned = deps.evidence.criterionFor(
      candidate,
      current.value.candidateFingerprint,
      command.criterionId,
    );
    if (!assigned.ok) return err(assigned.error);
    if (assigned.value === null || assigned.value.methodKind !== 'OwnerTest') {
      return err(weakerMethodRefusal(command.criterionId, assigned.value));
    }

    const target = resolveTarget(candidate, command.observedAgainst);
    if (!target.ok) return err(target.error);

    if (command.evidence.reference.trim().length === 0) {
      return err(
        invalid('A manual test result needs a reference to the evidence that was retained.', [
          {
            path: 'evidence.reference',
            message: 'Name the retained screenshot or sanitized request/result, so the claim points at something that exists (F23-AC2).',
          },
        ]),
      );
    }

    const work = deps.workItems.get(candidate.workItemId);
    if (!work.ok) return err(work.error);

    const observedAt = deps.clock.now();
    const bundle = buildEvidencePack({
      bundleId: `owner-test:${safe(command.criterionId)}`,
      correlationId: command.correlationId,
      identity: candidate.identity,
      eligiblePreview:
        target.value.environment === 'Preview'
          ? {
              component: target.value.component,
              deploymentId: target.value.deploymentId,
              environment: target.value.previewEnvironment,
              candidateFingerprint: current.value.candidateFingerprint,
            }
          : null,
      requirements: [
        {
          criterionId: command.criterionId,
          text: criterion.text,
          method: { kind: 'OwnerTest', instructions: safe(criterion.text) },
          requiresDeployedObservation: target.value.environment === 'Preview',
        },
      ],
      observations: [
        {
          criterionId: command.criterionId,
          evidenceId: ownerTestEvidenceId(candidate, command.criterionId, current.value.candidateFingerprint),
          observation: command.observation,
          environment: target.value.environment,
          capturedAt: observedAt,
          component: target.value.component,
          deploymentId: target.value.deploymentId,
          artifacts: [{ kind: command.evidence.kind, name: safe(command.evidence.reference), capturedAt: observedAt }],
          apiExchange: null,
          detail: command.note === null ? null : safe(command.note),
        },
      ],
    });
    if (!bundle.ok) return err(bundle.error);
    const verdict = bundle.value.records[0];
    if (verdict === undefined) {
      return err({
        code: 'Unavailable',
        reason: `The observation of "${safe(command.criterionId)}" produced no criterion verdict, so nothing was recorded (F23-AC1).`,
      });
    }
    if (bundle.value.candidateFingerprint !== current.value.candidateFingerprint) {
      return err({
        code: 'Unavailable',
        reason: `The candidate this observation resolves to is ${safe(bundle.value.candidateFingerprint)}, not the current ${safe(current.value.candidateFingerprint)}, so it was not recorded (F20-AC3).`,
      });
    }

    const written = deps.observations.record({
      candidate,
      projectId: work.value.projectId,
      criterionId: safe(verdict.criterionId),
      bundleFingerprint: bundle.value.candidateFingerprint,
      record: verdict,
      observation: command.observation,
      environment: target.value.environment,
      component: target.value.component,
      deploymentId: target.value.deploymentId,
      evidenceKind: command.evidence.kind,
      evidenceRef: safe(command.evidence.reference),
      observedBy: owner.value,
      observedAt,
      correlationId: command.correlationId,
    });
    if (!written.ok) return err(written.error);

    const rows = deps.evidence.criteriaFor(candidate, current.value.candidateFingerprint);
    if (!rows.ok) return err(rows.error);
    return ok({
      observation: written.value,
      recordedForDelivery: false,
      outstandingCriterionIds: rows.value.filter((row) => row.status !== 'Verified').map((row) => safe(row.criterionId)),
    });
  }

  /**
   * F20-AC3: every observation bound to one exact candidate identity.
   *
   * A read with no caller in its body, following the rule every other read here follows:
   * the journal is the authority and a query cannot be authorized by a request (F01-AC1).
   * The fingerprint is part of the query rather than a filter applied afterwards, which is
   * what makes a replacement candidate read as having inherited nothing (F23-AC1).
   */
  function listOwnerObservations(
    query: ListOwnerObservationsQuery,
  ): Result<readonly OwnerObservationRecord[], DomainError> {
    const found = deps.candidates.get(query.candidateId);
    if (!found.ok) return err(found.error);
    return deps.observations.list(query);
  }

  return { recordOwnerObservation, listOwnerObservations };
}

/* -------------------------------------------------------------------------- */
/* SQLite journal                                                               */
/* -------------------------------------------------------------------------- */

/** The `evidence` columns this reader projects, which is the whole F23 verdict. */
const EVIDENCE_COLUMNS =
  'evidence_id, criterion_id, method_kind, status, artifact_ref, detail_redacted, observed_at, candidate_id, candidate_fingerprint, scope_fingerprint, correlation_id';

/** The `audit_log` columns that carry an attribution. */
const ATTRIBUTION_COLUMNS = 'audit_id, actor, subject_id, correlation_id, occurred_at, detail_json';

/**
 * The owner-observation writer over the migrated schema.
 *
 * A reported duplication of one thing, and it is deliberate: the verdict is written by
 * delegating to the injected `ObservationJournal` rather than with an `INSERT` of this
 * file's own, so the `ON CONFLICT` convergence, the redaction, and the schema's own `CHECK`s
 * on a `Verified` row and on an automated method's `check_id` are the ones the verification
 * layer already exercises (F23-AC1). The attribution is written here, because
 * `@shiploop/storage` exports no writer or reader for `audit_log` and the actor of an
 * observation is the one fact with no other home in the schema: `owner_decisions` carries an
 * `actor_owner_id`, but its `decision_type` vocabulary has no owner-test member, and filing
 * an observation as one of its members would mean recording a decision the owner never
 * made.
 *
 * Both writes run inside one `withTransaction`, and a domain failure inside is raised as a
 * `TransactionError` so the rollback happens and the typed error survives it. Ordering them
 * without a transaction would leave one of two lies on disk: a verdict no owner made, or an
 * audit entry for a verdict that was never filed (F25-AC4).
 */
export class SqliteOwnerObservationJournal implements OwnerObservationJournal {
  private readonly database: Database;
  private readonly evidence: ObservationJournal;

  constructor(database: Database, evidence: ObservationJournal) {
    this.database = database;
    this.evidence = evidence;
  }

  record(write: OwnerObservationWrite): Result<OwnerObservationRecord, DomainError> {
    return this.attempt('record the owner observation', () =>
      withTransaction(this.database, () => {
        const auditId = this.writeAttribution(write);
        const filed = this.evidence.recordCriterion({
          candidate: write.candidate,
          bundleFingerprint: write.bundleFingerprint,
          record: write.record,
          recordedAt: write.observedAt,
          correlationId: write.correlationId,
        });
        if (!filed.ok) {
          throw new TransactionError(
            filed.error,
            'The criterion verdict could not be filed, so the attribution was rolled back with it.',
          );
        }
        const stored = this.stored(write, auditId);
        if (stored === null) {
          throw new TransactionError(
            {
              code: 'Unavailable',
              reason: `The observation of "${write.criterionId}" could not be read back, so nothing was recorded (F23-AC1).`,
            },
            'The observation was written but could not be read back.',
          );
        }
        return ok(stored);
      }),
    );
  }

  list(query: ListOwnerObservationsQuery): Result<readonly OwnerObservationRecord[], DomainError> {
    return this.attempt('list owner observations', () => {
      const rows = this.database
        .prepare(
          `SELECT ${EVIDENCE_COLUMNS} FROM evidence
             WHERE candidate_id = ? AND candidate_fingerprint = ? AND method_kind = 'OwnerTest'
             ORDER BY criterion_id ASC`,
        )
        .all(query.candidateId, query.candidateFingerprint);
      const attributions = this.attributionsFor(query.candidateId);
      const records: OwnerObservationRecord[] = [];
      for (const row of rows) {
        const projected = this.project(row, attributions);
        if (projected !== null) records.push(projected);
      }
      return ok(records);
    });
  }

  /**
   * The audit row that makes the actor and the instant durable (F25-AC1, F25-AC4).
   *
   * `actor` is the schema's `NOT NULL` column, so an observation with no owner behind it
   * cannot be filed even if every check above it were removed. `detail_json` carries the
   * deployment identity and the observation kind, which the `evidence` columns have no home
   * for, so the attribution is a complete record rather than a name and a time (F23-AC3).
   */
  private writeAttribution(write: OwnerObservationWrite): string {
    const auditId = auditRowId(write);
    this.database
      .prepare(
        `INSERT INTO audit_log (audit_id, project_id, actor, action, subject_kind, subject_id, correlation_id, occurred_at, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (audit_id) DO UPDATE SET
           detail_json = excluded.detail_json`,
      )
      .run(
        auditId,
        write.projectId,
        write.observedBy,
        'RecordOwnerTest',
        'Criterion',
        write.criterionId,
        write.correlationId,
        write.observedAt,
        JSON.stringify({
          candidateId: write.candidate.candidateId,
          candidateFingerprint: write.bundleFingerprint,
          observation: write.observation,
          failureKind: failureKindFor(write.observation),
          environment: write.environment,
          component: write.component,
          deploymentId: write.deploymentId,
          evidenceKind: write.evidenceKind,
          evidenceRef: write.evidenceRef,
        }),
      );
    return auditId;
  }

  /**
   * Every attribution filed against one candidate, newest first.
   *
   * Matched on the identity the JSON records rather than on the timestamp alone, so an
   * observation made on an earlier candidate is not attributed to this one, and one made
   * earlier for the same criterion is the one a repeat supersedes (F20-AC3, F23-AC5).
   */
  private attributionsFor(candidateId: CandidateId): readonly AttributionRow[] {
    return this.database
      .prepare(
        `SELECT ${ATTRIBUTION_COLUMNS} FROM audit_log
           WHERE action = 'RecordOwnerTest' AND subject_kind = 'Criterion'
             AND subject_id IN (SELECT criterion_id FROM evidence WHERE candidate_id = ?)
           ORDER BY occurred_at DESC, audit_id DESC`,
      )
      .all(candidateId)
      .map((row) => toAttributionRow(row))
      .filter((entry) => entry.candidateId === candidateId);
  }

  /** One stored verdict, paired with the attribution that recorded it, or null when absent. */
  private stored(write: OwnerObservationWrite, auditId: string): OwnerObservationRecord | null {
    const row = this.database
      .prepare(
        `SELECT ${EVIDENCE_COLUMNS} FROM evidence
           WHERE candidate_id = ? AND candidate_fingerprint = ? AND criterion_id = ?`,
      )
      .get(write.candidate.candidateId, write.bundleFingerprint, write.criterionId);
    if (row === undefined) return null;
    return this.project(row, this.attributionsFor(write.candidate.candidateId).filter((entry) => entry.auditId === auditId));
  }

  /**
   * One row projected with the attribution that belongs to it.
   *
   * Null rather than a partial record when the pair is incomplete: an observation whose
   * attribution cannot be read is reported as absent rather than as a claim with no actor,
   * because the actor is what makes it an owner's statement (F25-AC1, F25-AC4).
   */
  private project(row: SqlRow, attributions: readonly AttributionRow[]): OwnerObservationRecord | null {
    const criterionId = requiredText(row, 'criterion_id');
    const observedAt = optionalText(row, 'observed_at');
    const attribution = attributions.find((entry) => entry.subjectId === criterionId);
    if (attribution === undefined || observedAt === null) return null;
    const detail = parseAttributionDetail(attribution.detailJson);
    if (detail === null) return null;
    return {
      evidenceId: requiredText(row, 'evidence_id') as EvidenceId,
      criterionId,
      methodKind: 'OwnerTest',
      status: requiredText(row, 'status') as CriterionStatus,
      failureKind: failureKindFor(detail.observation),
      observedBy: attribution.actor as OwnerId,
      observedAt,
      environment: detail.environment,
      component: detail.component,
      deploymentId: detail.deploymentId,
      evidenceKind: detail.evidenceKind,
      evidenceRef: optionalText(row, 'artifact_ref') ?? detail.evidenceRef,
      detail: optionalText(row, 'detail_redacted'),
      candidateId: requiredText(row, 'candidate_id') as CandidateId,
      candidateFingerprint: requiredText(row, 'candidate_fingerprint') as Fingerprint,
      scopeFingerprint: requiredText(row, 'scope_fingerprint') as Fingerprint,
      correlationId: optionalText(row, 'correlation_id') ?? attribution.correlationId,
    };
  }

  private attempt<T>(description: string, body: () => Result<T, DomainError>): Result<T, DomainError> {
    try {
      return body();
    } catch (error) {
      if (error instanceof TransactionError) return err(error.result.error);
      const reason = error instanceof Error ? error.message : String(error);
      return err({ code: 'Unavailable', reason: `${description} failed: ${reason}` });
    }
  }
}

/**
 * The row identity one observation's attribution owns.
 *
 * Derived from the candidate, the criterion and the instant, the same three facts that make
 * an observation what it is, so a repeat of the same observation at the same instant
 * converges on one audit row while a genuine second observation writes its own. A
 * repository that appends instead of replacing would let an owner's corrected verdict be
 * read as the first one they gave (F23-AC5, operations that converge on one end state).
 */
function auditRowId(write: OwnerObservationWrite): string {
  const material = `${write.candidate.candidateId}|${write.criterionId}|${write.bundleFingerprint}|${write.observedAt}`;
  return `audit_owner_test_${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32)}`;
}

/** One audit row, read back as the attribution it is. */
interface AttributionRow {
  readonly auditId: string;
  readonly actor: string;
  readonly correlationId: string;
  readonly subjectId: string;
  readonly candidateId: CandidateId;
  readonly detailJson: string;
}

/** The attribution detail, read back rather than assumed (F23-AC3). */
interface AttributionDetail {
  readonly observation: BehaviorObservation;
  readonly environment: EvidenceEnvironment;
  readonly component: string | null;
  readonly deploymentId: string | null;
  readonly evidenceKind: OwnerEvidenceKind;
  readonly evidenceRef: string;
}

function toAttributionRow(row: SqlRow): AttributionRow {
  const detail = parseAttributionDetail(requiredText(row, 'detail_json'));
  if (detail === null) {
    throw new Error(`the attribution for ${requiredText(row, 'audit_id')} does not carry a readable observation`);
  }
  return {
    auditId: requiredText(row, 'audit_id'),
    actor: requiredText(row, 'actor'),
    correlationId: requiredText(row, 'correlation_id'),
    subjectId: requiredText(row, 'subject_id'),
    candidateId: detail.candidateId,
    detailJson: requiredText(row, 'detail_json'),
  };
}

function parseAttributionDetail(raw: string): (AttributionDetail & { readonly candidateId: CandidateId }) | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const observation = record['observation'];
  const environment = record['environment'];
  const evidenceKind = record['evidenceKind'];
  const evidenceRef = record['evidenceRef'];
  const candidateId = record['candidateId'];
  const component = record['component'];
  const deploymentId = record['deploymentId'];
  if (
    typeof candidateId !== 'string' ||
    !isBehaviorObservation(observation) ||
    !isEvidenceEnvironment(environment) ||
    !isEvidenceKind(evidenceKind) ||
    typeof evidenceRef !== 'string' ||
    (component !== null && typeof component !== 'string') ||
    (deploymentId !== null && typeof deploymentId !== 'string')
  ) {
    return null;
  }
  return {
    candidateId: candidateId as CandidateId,
    observation,
    environment,
    component,
    deploymentId,
    evidenceKind,
    evidenceRef,
  };
}

function isBehaviorObservation(value: unknown): value is BehaviorObservation {
  return value === 'BehaviorConfirmed' || value === 'BehaviorFailed' || value === 'CaptureFailed';
}

function isEvidenceEnvironment(value: unknown): value is EvidenceEnvironment {
  return value === 'Local' || value === 'Preview' || value === 'LiveSmoke' || value === 'ProviderCi';
}

function isEvidenceKind(value: unknown): value is OwnerEvidenceKind {
  return value === 'Screenshot' || value === 'ApiExchange' || value === 'CheckOutput';
}

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