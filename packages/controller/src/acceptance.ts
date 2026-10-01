/**
 * Owner acceptance and feedback (F25-AC1, F25-AC2, F25-AC3, F25-AC4, F25-AC5).
 *
 * Acceptance is a *recorded owner decision*, and this module exists to make every other
 * way of arriving at "accepted" structurally unavailable. Three properties carry that,
 * and each is enforced by a different mechanism rather than by a comment:
 *
 *   - **Only the owner, and only through here.** `requestChanges` and `recordAcceptance`
 *     take an `OwnerActor`, and a non-owner role is refused before any row is read.
 *     Nothing in this module imports an engine, an adapter or a webhook contract, so a
 *     run that reports success, a provider event, or an agent's own summary has no entry
 *     point to call (F25-AC4). The decision row itself carries a real `actor_owner_id`
 *     foreign key, so an unattributable acceptance is not representable either.
 *   - **Acceptance is a verdict over every criterion, read from durable evidence.**
 *     `acceptanceReady` from the domain is asked, never restated, and the outstanding
 *     criteria are named rather than summarised. A green check run and a healthy preview
 *     deployment cannot promote a criterion: nothing here reads either, and the evidence
 *     journal is the only source of criterion status (F25-AC1).
 *   - **A changed identity makes an acceptance `Stale`, not current.** Acceptance is
 *     bound to a candidate fingerprint, and the comparison against the work item's
 *     current candidate is the domain's own `assessStaleness`, so a new head, base,
 *     scope, profile, procedure, environment, policy or deployment is reported by the
 *     function that defines what "changed" means (F25-AC3).
 *
 * Feedback is retained rather than replaced: `requestChanges` records the owner's reason
 * against the exact candidate that was tested, and the report and the read-back both
 * carry it, so a fix pass reads the feedback that produced it (F25-AC2). Feedback is
 * stored as a note on the decision and never widens the authorized task: nothing in this
 * module creates scope, so out-of-scope feedback has to become a proposed scope revision
 * in the scope layer rather than an instruction the coding pass may act on (F25-AC5).
 *
 * The same duplication note that applies to the observation journal applies here:
 * `@shiploop/storage` owns `owner_decisions` and exports `OwnerDecisionRepository` with no
 * reader for acceptance state, so the read-back in this file is a second reader over one
 * store. It reads only what the schema CHECKs, and it is reported rather than hidden.
 */

import { acceptanceReady, assessStaleness, err, ok, redact } from '@shiploop/domain';
import type {
  AcceptanceState,
  CandidateId,
  CriterionEvidence,
  CriterionStatus,
  DecisionId,
  DomainError,
  Fingerprint,
  OwnerId,
  Result,
  StaleReason,
  WorkItemId,
} from '@shiploop/domain';
import type {
  CandidateRecord,
  CandidateStore,
  OwnerDecisionRecord,
  OwnerDecisionStore,
  ScopeSnapshotRecord,
} from '@shiploop/storage';
import type { CandidateScopeReader, CriterionEvidenceRow, ObservationJournal } from './verification.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';

/* -------------------------------------------------------------------------- */
/* Inputs and outputs                                                          */
/* -------------------------------------------------------------------------- */

/** One criterion's standing, as the owner is shown it before they decide. */
export interface CriterionStanding {
  readonly criterionId: string;
  readonly text: string;
  readonly methodKind: CriterionEvidenceRow['methodKind'];
  readonly status: CriterionStatus;
  /** False when no evidence row exists at all, which is different from a row that failed. */
  readonly observed: boolean;
}

/** What the owner sees before accepting: the criteria, and what is still outstanding. */
export interface AcceptanceGate {
  readonly candidateFingerprint: Fingerprint;
  readonly headSha: string;
  readonly scopeFingerprint: Fingerprint;
  readonly criteria: readonly CriterionStanding[];
  readonly outstandingCriterionIds: readonly string[];
  readonly ready: boolean;
}

/** The acceptance state one candidate currently holds (F25-AC3). */
export interface AcceptanceView {
  readonly candidateId: CandidateId;
  readonly candidateFingerprint: Fingerprint;
  /** `Stale` for an acceptance recorded against a superseded candidate (F25-AC3). */
  readonly state: AcceptanceState;
  readonly decisionId: DecisionId | null;
  readonly ownerId: OwnerId | null;
  readonly decidedAt: string | null;
  readonly note: string | null;
  /** Identity inputs that differ from the ones the acceptance was recorded against. */
  readonly staleReasons: readonly StaleReason[];
  /** Feedback the owner left on this candidate, retained for a fix pass (F25-AC2). */
  readonly retainedFeedback: readonly { readonly decisionId: DecisionId; readonly feedback: string }[];
}

export interface RequestChangesInput {
  readonly candidateId: CandidateId;
  /**
   * The authenticated caller.
   *
   * `role` is an enforcement input, not a label: the refusal below is what makes F25-AC4
   * a tested boundary rather than a convention.
   */
  readonly actor: OwnerActor;
  /** The owner's reason, retained against the tested candidate (F25-AC2). */
  readonly reason: string;
  readonly correlationId: string;
}

export interface ChangeRequestReport {
  readonly candidateId: CandidateId;
  readonly workItemId: WorkItemId;
  readonly decisionId: DecisionId;
  readonly state: Extract<AcceptanceState, 'ChangesRequested'>;
  readonly ownerId: OwnerId;
  readonly decidedAt: string;
  readonly feedback: string;
  /**
   * Criteria the candidate had not yet satisfied, so the fix pass can see what the
   * feedback lands on rather than only that something was rejected (F25-AC2).
   */
  readonly outstandingCriterionIds: readonly string[];
}

export interface RecordAcceptanceInput {
  readonly candidateId: CandidateId;
  readonly actor: OwnerActor;
  /** Optional owner note, recorded with the decision (F25-AC1). */
  readonly note: string | null;
  readonly correlationId: string;
}

export interface AcceptanceReport {
  readonly candidateId: CandidateId;
  readonly workItemId: WorkItemId;
  readonly decisionId: DecisionId;
  readonly state: Extract<AcceptanceState, 'Accepted'>;
  readonly ownerId: OwnerId;
  readonly decidedAt: string;
  readonly candidateFingerprint: Fingerprint;
  readonly headSha: string;
  readonly scopeFingerprint: Fingerprint;
  /** What the owner observed, as recorded in the candidate's own identity (F25-AC1). */
  readonly observedDeployments: readonly {
    readonly component: string;
    readonly deploymentId: string | null;
    readonly deploymentUrl: string | null;
    readonly environment: string;
  }[];
  readonly feedbackHonoured: readonly { readonly decisionId: DecisionId; readonly feedback: string }[];
}

/* -------------------------------------------------------------------------- */
/* Ports                                                                       */
/* -------------------------------------------------------------------------- */

export interface AcceptanceUseCaseDeps {
  readonly clock: ControllerClock;
  readonly decisions: OwnerDecisionStore;
  readonly candidates: Pick<CandidateStore, 'get' | 'listForWorkItem'>;
  readonly evidence: ObservationJournal;
  readonly scope: CandidateScopeReader;
  /** Redaction applied to owner feedback before it reaches a stored row (N02-AC2). */
  readonly redactText?: (text: string) => string;
}

export interface AcceptanceUseCases {
  /** F25-AC4, F25-AC2: records feedback against the tested candidate. */
  readonly requestChanges: (input: RequestChangesInput) => Result<ChangeRequestReport, DomainError>;
  /** F25-AC1, F25-AC3, F25-AC4: records acceptance, or names why it is not yet possible. */
  readonly recordAcceptance: (input: RecordAcceptanceInput) => Result<AcceptanceReport, DomainError>;
  /** F24-AC2, F24-AC3: the gate the review card renders, and the outstanding reasons. */
  readonly acceptanceGate: (candidateId: CandidateId) => Result<AcceptanceGate, DomainError>;
  /** F25-AC3: the acceptance state one candidate currently holds. */
  readonly currentAcceptance: (candidateId: CandidateId) => Result<AcceptanceView, DomainError>;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

function safe(text: string): string {
  return redact(text).text;
}

/**
 * Builds the acceptance use cases.
 *
 * `clock` is injected so a decision recorded in a test replays identically, and nothing
 * here reads ambient time or ambient identity.
 */
export function createAcceptanceUseCases(deps: AcceptanceUseCaseDeps): AcceptanceUseCases {
  const providerText = deps.redactText ?? ((text: string): string => safe(text));

  /**
   * F25-AC4: the only role permitted to move acceptance.
   *
   * Checked before any row is read, so a non-owner caller learns nothing about the
   * candidate from the refusal, and a non-owner role is refused rather than downgraded.
   */
  const requireOwner = (actor: OwnerActor): Result<OwnerId, DomainError> => {
    if (actor.role !== 'Owner' || actor.ownerId === null) {
      return err({
        code: 'Forbidden',
        reason: `Only the owner may accept or reject a candidate; the ${actor.role} role may not (F25-AC1, F25-AC4).`,
      });
    }
    return ok(actor.ownerId);
  };

  const candidateFor = (candidateId: CandidateId): Result<CandidateRecord, DomainError> => {
    const found = deps.candidates.get(candidateId);
    if (!found.ok) return err(found.error);
    return ok(found.value);
  };

  const snapshotFor = (workItemId: WorkItemId): Result<ScopeSnapshotRecord, DomainError> => {
    const found = deps.scope.latestScopeSnapshot(workItemId);
    if (!found.ok) return err(found.error);
    if (found.value === null) {
      return err({
        code: 'NotFound',
        reason: `Work item ${workItemId} has no captured scope revision, so there are no acceptance criteria to judge (F25-AC1).`,
      });
    }
    return ok(found.value);
  };

  /**
   * The candidate the work item currently offers, read from the durable candidates.
   *
   * Read rather than taken from the caller's argument, because whether that argument is
   * still current is the whole question F25-AC3 asks (F24-AC4).
   */
  const currentCandidateFor = (candidate: CandidateRecord): Result<CandidateRecord, DomainError> => {
    const listed = deps.candidates.listForWorkItem(candidate.workItemId);
    if (!listed.ok) return err(listed.error);
    return ok(listed.value[listed.value.length - 1] ?? candidate);
  };

  /**
   * The reason a superseded candidate is refused, naming the inputs that differ.
   *
   * The reasons come from the domain's own comparison, so this layer cannot claim a
   * candidate is unchanged when the recorded identities differ (F24-AC4, F25-AC3).
   */
  const superseded = (candidate: CandidateRecord, current: CandidateRecord): DomainError => {
    const reasons = assessStaleness(candidate.identity, current.identity).reasons;
    return {
      code: 'Conflict',
      reason: `This was requested for a candidate that is no longer the current one; it differs in ${
        reasons.length === 0 ? 'its recorded identity' : reasons.join(', ')
      }. Accept the current candidate instead, and the earlier evidence with it (F25-AC3, F24-AC4).`,
      expected: candidate.candidateFingerprint,
      actual: current.candidateFingerprint,
    };
  };

  /**
   * One criterion's standing, from the durable evidence rows.
   *
   * A criterion the captured scope names and nothing observed reads `observed: false`.
   * That is reported distinctly from a criterion with a row that failed, because "nothing
   * was watched" and "something was watched and it failed" are different facts and F23-AC1
   * needs the difference to stay visible.
   */
  const standingFor = (
    snapshot: ScopeSnapshotRecord,
    rows: readonly CriterionEvidenceRow[],
  ): readonly CriterionStanding[] => {
    const byCriterion = new Map(rows.map((row) => [row.criterionId, row]));
    return snapshot.acceptanceCriteria.map((criterion) => {
      const row = byCriterion.get(criterion.id);
      return {
        criterionId: criterion.id,
        text: criterion.text,
        methodKind: row?.methodKind ?? 'Untested',
        status: row?.status ?? 'Untested',
        observed: row !== undefined,
      };
    });
  };

  /**
   * The domain criterion evidence a standing projects into.
   *
   * The method is reconstructed from the durable kind rather than restated, and a
   * criterion with no row is given an `Untested` method with its own reason, so a missing
   * row cannot be read as a satisfied one (F23-AC1).
   */
  const criterionEvidenceFor = (candidate: CandidateRecord, standing: CriterionStanding): CriterionEvidence => ({
    criterionId: standing.criterionId,
    method: methodFor(standing),
    status: standing.status,
    evidenceId: null,
    candidateFingerprint: candidate.candidateFingerprint,
    scopeFingerprint: candidate.identity.scopeFingerprint,
    observedAt: null,
  });

  const methodFor = (standing: CriterionStanding): CriterionEvidence['method'] => {
    switch (standing.methodKind) {
      case 'AutomatedCheck':
        return { kind: 'AutomatedCheck', checkId: standing.criterionId };
      case 'OwnerTest':
        return { kind: 'OwnerTest', instructions: standing.text };
      case 'BrowserEvidence':
        return { kind: 'BrowserEvidence', evidenceId: standing.criterionId };
      case 'ApiEvidence':
        return { kind: 'ApiEvidence', evidenceId: standing.criterionId };
      case 'Untested':
        return {
          kind: 'Untested',
          reason: `No observation of "${standing.criterionId}" is recorded for this candidate, so it is not verified (F23-AC1).`,
        };
    }
  };

  /**
   * Every criterion's standing for the candidate's own identity.
   *
   * The read is filtered on the candidate fingerprint, so a replacement build starts with
   * no criteria satisfied and cannot inherit the previous build's verdicts (F20-AC3).
   */
  const gateFor = (
    candidate: CandidateRecord,
  ): Result<{ snapshot: ScopeSnapshotRecord; gate: AcceptanceGate }, DomainError> => {
    const snapshot = snapshotFor(candidate.workItemId);
    if (!snapshot.ok) return snapshot;
    const rows = deps.evidence.criteriaFor(candidate, candidate.candidateFingerprint);
    if (!rows.ok) return err(rows.error);
    const standing = standingFor(snapshot.value, rows.value);
    const ready = acceptanceReady(standing.map((entry) => criterionEvidenceFor(candidate, entry)));
    const outstanding = standing.filter((entry) => entry.status !== 'Verified');
    return ok({
      snapshot: snapshot.value,
      gate: {
        candidateFingerprint: candidate.candidateFingerprint,
        headSha: candidate.identity.headSha,
        scopeFingerprint: snapshot.value.scopeFingerprint,
        criteria: standing,
        outstandingCriterionIds: outstanding.map((entry) => entry.criterionId),
        ready,
      },
    });
  };

  /** Every owner decision recorded against one candidate, oldest first. */
  const decisionsFor = (
    candidate: CandidateRecord,
  ): Result<readonly OwnerDecisionRecord[], DomainError> => {
    const listed = deps.decisions.listForWorkItem(candidate.workItemId);
    if (!listed.ok) return err(listed.error);
    return ok(
      listed.value.filter(
        (decision) => decision.candidateFingerprint === candidate.candidateFingerprint,
      ),
    );
  };

  /**
   * F25-AC2, F25-AC4: records the owner's feedback against the tested candidate.
   *
   * The reason is redacted before it is stored, because feedback is quoted into a fix-pass
   * prompt and into an issue comment, and an owner who pastes a header into a reason would
   * otherwise put a credential in a durable row and a transcript (N02-AC2).
   *
   * Acceptance moves to `ChangesRequested` only through the storage repository, which
   * CHECKs that an acceptance-type decision carries an acceptance state; there is no
   * statement in this module that writes the state column.
   */
  const requestChanges = (input: RequestChangesInput): Result<ChangeRequestReport, DomainError> => {
    const owner = requireOwner(input.actor);
    if (!owner.ok) return err(owner.error);
    if (input.reason.trim().length === 0) {
      return err({
        code: 'Invalid',
        reason: 'A change request without feedback is not actionable.',
        fields: [
          {
            path: 'reason',
            message: 'State what should change, so the fix pass has something to act on (F25-AC2).',
          },
        ],
      });
    }
    const candidate = candidateFor(input.candidateId);
    if (!candidate.ok) return err(candidate.error);
    const current = currentCandidateFor(candidate.value);
    if (!current.ok) return err(current.error);
    if (current.value.candidateFingerprint !== candidate.value.candidateFingerprint) {
      return err(superseded(candidate.value, current.value));
    }
    const gate = gateFor(candidate.value);
    if (!gate.ok) return err(gate.error);

    const decidedAt = deps.clock.now();
    const recorded = deps.decisions.recordChangesRequested({
      workItemId: candidate.value.workItemId,
      candidateFingerprint: candidate.value.candidateFingerprint,
      scopeFingerprint: gate.value.snapshot.scopeFingerprint,
      actorOwnerId: owner.value,
      feedback: providerText(input.reason),
      createdAt: decidedAt,
      correlationId: input.correlationId,
    });
    if (!recorded.ok) return err(recorded.error);
    return ok({
      candidateId: candidate.value.candidateId,
      workItemId: candidate.value.workItemId,
      decisionId: recorded.value.decisionId,
      state: 'ChangesRequested',
      ownerId: owner.value,
      decidedAt,
      feedback: providerText(input.reason),
      outstandingCriterionIds: gate.value.gate.outstandingCriterionIds,
    });
  };

  /**
   * F25-AC1, F25-AC3, F25-AC4: records the owner's acceptance of one exact candidate.
   *
   * Three refusals, in this order, and the order matters:
   *
   *   1. the caller is not the owner (F25-AC4);
   *   2. the candidate is not the current one, so the evidence behind it belongs to a
   *      superseded build (F25-AC3, F24-AC4);
   *   3. `acceptanceReady` does not hold, and every outstanding criterion is named.
   *
   * A green required check and a healthy preview deployment are not consulted at all:
   * neither can verify a criterion, so a delivery-ready build with an untested criterion
   * still cannot be accepted. That is the point of F24-AC3 and F23-AC1, and it is why this
   * function has no check or deployment input to get wrong.
   */
  const recordAcceptance = (input: RecordAcceptanceInput): Result<AcceptanceReport, DomainError> => {
    const owner = requireOwner(input.actor);
    if (!owner.ok) return err(owner.error);
    const candidate = candidateFor(input.candidateId);
    if (!candidate.ok) return err(candidate.error);
    const current = currentCandidateFor(candidate.value);
    if (!current.ok) return err(current.error);
    if (current.value.candidateFingerprint !== candidate.value.candidateFingerprint) {
      return err(superseded(candidate.value, current.value));
    }
    const gate = gateFor(candidate.value);
    if (!gate.ok) return err(gate.error);
    if (!gate.value.gate.ready) {
      return err({
        code: 'Blocked',
        reason: `This candidate cannot be accepted yet: ${gate.value.gate.outstandingCriterionIds.length} of ${gate.value.gate.criteria.length} criteria are not verified (F25-AC1).`,
        prerequisites: gate.value.gate.criteria
          .filter((entry) => entry.status !== 'Verified')
          .map((entry) => ({
            name: `Criterion ${entry.criterionId}`,
            detail: safe(
              entry.observed
                ? `It is ${entry.status} under the ${entry.methodKind} method.`
                : 'No observation of it is recorded for this candidate.',
            ),
            remedy: safe(
              entry.methodKind === 'OwnerTest'
                ? 'Record the owner test for this criterion, or request changes with what is wrong.'
                : 'Produce a linked observation for this criterion, or request changes.',
            ),
          })),
      });
    }

    const decidedAt = deps.clock.now();
    const recorded = deps.decisions.recordAcceptance({
      workItemId: candidate.value.workItemId,
      candidateFingerprint: candidate.value.candidateFingerprint,
      scopeFingerprint: gate.value.snapshot.scopeFingerprint,
      actorOwnerId: owner.value,
      note: input.note === null ? null : providerText(input.note),
      createdAt: decidedAt,
      correlationId: input.correlationId,
    });
    if (!recorded.ok) return err(recorded.error);
    const prior = decisionsFor(candidate.value);
    if (!prior.ok) return err(prior.error);
    return ok({
      candidateId: candidate.value.candidateId,
      workItemId: candidate.value.workItemId,
      decisionId: recorded.value.decisionId,
      state: 'Accepted',
      ownerId: owner.value,
      decidedAt,
      candidateFingerprint: candidate.value.candidateFingerprint,
      headSha: candidate.value.identity.headSha,
      scopeFingerprint: gate.value.snapshot.scopeFingerprint,
      observedDeployments: candidate.value.identity.components.map((component) => ({
        component: component.component,
        deploymentId: component.deploymentId,
        deploymentUrl: component.deploymentUrl,
        environment: component.environment,
      })),
      feedbackHonoured: prior.value
        .filter((decision) => decision.decisionType === 'RequestChanges')
        .map((decision) => ({
          decisionId: decision.decisionId,
          feedback: decision.note ?? '',
        })),
    });
  };

  /** F24-AC2, F24-AC3: the criteria and the outstanding reasons, with nothing decided. */
  const acceptanceGate = (candidateId: CandidateId): Result<AcceptanceGate, DomainError> => {
    const candidate = candidateFor(candidateId);
    if (!candidate.ok) return err(candidate.error);
    const gate = gateFor(candidate.value);
    if (!gate.ok) return err(gate.error);
    return ok(gate.value.gate);
  };

  /**
   * F25-AC3: the acceptance state one candidate currently holds.
   *
   * A decision recorded against a candidate that has since been superseded reads `Stale`,
   * with the differing inputs named. That is the state a delivery gate has to see: an
   * acceptance that exists but no longer describes the current build is not permission
   * for anything, and reporting it as `Accepted` is how an old decision authorizes new
   * code (F27-AC3).
   */
  const currentAcceptance = (candidateId: CandidateId): Result<AcceptanceView, DomainError> => {
    const candidate = candidateFor(candidateId);
    if (!candidate.ok) return err(candidate.error);
    const current = currentCandidateFor(candidate.value);
    if (!current.ok) return err(current.error);
    const decisions = decisionsFor(candidate.value);
    if (!decisions.ok) return err(decisions.error);
    const staleness = assessStaleness(candidate.value.identity, current.value.identity);
    const supersededNow = current.value.candidateFingerprint !== candidate.value.candidateFingerprint;
    const newest = [...decisions.value].reverse().find((decision) => decision.decisionType === 'AcceptProduct');
    const changes = decisions.value.filter((decision) => decision.decisionType === 'RequestChanges');
    const invalidated = decisions.value.filter(
      (decision) => decision.state === 'Invalidated' && decision.decisionType === 'AcceptProduct',
    );

    const state: AcceptanceState = supersededNow
      ? 'Stale'
      : staleness.stale
        ? 'Stale'
        : newest === undefined
          ? changes.at(-1) !== undefined
            ? 'ChangesRequested'
            : 'NotRequested'
          : invalidated.some((decision) => decision.createdAt >= newest.createdAt)
            ? 'Stale'
            : 'Accepted';

    return ok({
      candidateId: candidate.value.candidateId,
      candidateFingerprint: candidate.value.candidateFingerprint,
      state,
      decisionId: newest?.decisionId ?? null,
      ownerId: newest?.actorOwnerId ?? null,
      decidedAt: newest?.createdAt ?? null,
      note: newest?.note ?? null,
      staleReasons: supersededNow || staleness.stale ? staleness.reasons : [],
      retainedFeedback: changes.map((decision) => ({
        decisionId: decision.decisionId,
        feedback: decision.note ?? '',
      })),
    });
  };

  return { requestChanges, recordAcceptance, acceptanceGate, currentAcceptance };
}
