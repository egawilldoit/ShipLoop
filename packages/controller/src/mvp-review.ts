import {
  buildMvpReviewReadModel,
  err,
  isCommitSha,
  ok,
  recordMvpEvidence,
  recordMvpOwnerDecision,
} from '@shiploop/domain';
import type {
  CommitSha,
  CriterionVerificationMethod,
  DomainError,
  MvpActor,
  MvpCandidateView,
  MvpContractView,
  MvpEvidenceObservation,
  MvpEvidenceSubject,
  MvpOwnerActor,
  MvpOwnerDecision,
  MvpRecordedEvidence,
  MvpRequestView,
  MvpReviewReadModel,
  MvpVerificationPolicy,
  Result,
} from '@shiploop/domain';
import type { MvpReviewStore } from '@shiploop/storage';

/**
 * The MVP review use cases: one read model, and the two owner decisions (F24, F25).
 *
 * This layer owns no rule. Every judgement is asked of the domain: the projection from
 * `buildMvpReviewReadModel`, the binding from `recordMvpEvidence`, the decision from
 * `recordMvpOwnerDecision`. What this layer adds is the part a domain function cannot do:
 * reading the current request, contract and candidate from durable state, refusing an
 * action submitted against facts that have since moved, and writing the result.
 *
 * Three refusals carry the product, and each is here rather than in a comment:
 *
 *   - **Only an owner decides.** `MvpActor`'s non-owner variants carry no owner identity,
 *     so there is nothing for an agent, a webhook or an engine completion event to fill in
 *     (F25-AC4).
 *   - **A submission names the candidate it was prepared against.** Every decision input
 *     carries `expectedHeadSha` and `expectedContractRevision`. A mismatch is a typed
 *     `Conflict` naming the expected and the actual, and nothing is written. That is F24-AC4:
 *     an action from an outdated card must conflict rather than be re-pointed at whatever
 *     the candidate happens to be now.
 *   - **An acceptance is refused while eligibility says no.** `accept` asks the projection
 *     first and refuses with the outstanding criteria named. Accepting is not a statement
 *     that the owner looked; it is a statement that what the owner looked satisfied the
 *     contract, so a failing automated requirement cannot be accepted over (F23-AC1,
 *     F24-AC3).
 */

/* -------------------------------------------------------------------------- */
/* Inputs                                                                       */
/* -------------------------------------------------------------------------- */

/** The authenticated caller. Non-owner roles carry no owner identity to borrow. */
export type MvpReviewActor = MvpActor;

/** The facts the review path reads for one candidate. Supplied by the caller, not derived here. */
export interface MvpReviewFacts {
  readonly request: MvpRequestView;
  readonly contract: MvpContractView;
  readonly candidate: MvpCandidateView;
  readonly policy?: MvpVerificationPolicy;
}

export interface ReviewRequest {
  readonly projectId: string;
  readonly requestId: string;
  readonly candidateId: string;
  /** The full SHA the caller's page was rendered against. Required on every action. */
  readonly expectedHeadSha: string;
  readonly expectedContractRevision: number;
}

export interface ReviewRequestInput extends ReviewRequest {
  readonly facts: MvpReviewFacts;
}

export interface RecordEvidenceInput extends ReviewRequest {
  readonly facts: MvpReviewFacts;
  readonly evidenceId: string;
  /** The criterion or the check this observation speaks for. */
  readonly subject: MvpEvidenceSubject;
  readonly method: CriterionVerificationMethod;
  /**
   * The observation itself. No member carries a claimed verdict string, so there is no
   * value a caller can pass that the domain reads as a pass.
   */
  readonly observation: MvpEvidenceObservation;
  /** The owner, for an `owner_test` observation; null for every automated one. */
  readonly owner: MvpOwnerActor | null;
  /** What the source actually observed. Null when the source could not attribute the run. */
  readonly observedHeadSha: string | null;
  readonly observedContractRevision: number | null;
  readonly observedAt: string | null;
  readonly detail: string | null;
  readonly artifactRef: string | null;
  readonly correlationId: string;
}

export interface RecordOwnerTestInput extends ReviewRequest {
  readonly facts: MvpReviewFacts;
  readonly actor: MvpReviewActor;
  readonly criterionId: string;
  readonly outcome: 'passed' | 'failed' | 'capture_failed';
  readonly evidenceId: string;
  readonly observedAt: string;
  readonly detail: string | null;
  readonly artifactRef: string | null;
  readonly correlationId: string;
}

export interface DecideInput extends ReviewRequest {
  readonly facts: MvpReviewFacts;
  readonly actor: MvpReviewActor;
  readonly kind: 'accepted' | 'changes_requested';
  readonly feedback: string | null;
  readonly correlationId: string;
}

export interface MvpReviewUseCases {
  /** The one read model. Returns the typed conflict when the caller's card is out of date. */
  readonly review: (input: ReviewRequestInput) => Promise<Result<MvpReviewReadModel, DomainError>>;
  /** Records one automated observation, bound to the candidate it was observed against. */
  readonly recordEvidence: (input: RecordEvidenceInput) => Promise<Result<MvpReviewReadModel, DomainError>>;
  /** Records the owner's own test outcome. */
  readonly recordOwnerTest: (input: RecordOwnerTestInput) => Promise<Result<MvpReviewReadModel, DomainError>>;
  /** Accept, or Request Changes. Both bind the exact candidate. */
  readonly decide: (input: DecideInput) => Promise<Result<MvpReviewReadModel, DomainError>>;
}

export interface MvpReviewDeps {
  readonly store: Pick<MvpReviewStore, 'recordEvidence' | 'recordDecision' | 'readProjection'>;
  /** Injected so a decision recorded in a test replays identically. */
  readonly clock: { readonly now: () => string };
  readonly newDecisionId: () => string;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The candidate identity a submission must name, as the domain compares it.
 *
 * Built once and used by every guard, so "which candidate is this submission about" has
 * exactly one answer in this module rather than one per refusal.
 */
function expectedIdentity(input: ReviewRequest): Result<CommitSha, DomainError> {
  if (!isCommitSha(input.expectedHeadSha)) {
    return err({
      code: 'Invalid',
      reason: 'A review submission must name the full 40-character candidate commit SHA it was prepared against; a branch name or PR number cannot identify what was reviewed (F24-AC4).',
      fields: [{ path: 'expectedHeadSha', message: 'The full 40-character commit SHA is required.' }],
    });
  }
  return ok(input.expectedHeadSha);
}

/**
 * F24-AC4: the refusal a stale submission earns.
 *
 * Named with both identities so the caller can re-render against current facts rather
 * than being turned away without an explanation.
 */
function staleSubmission(input: ReviewRequest, facts: MvpReviewFacts): DomainError | null {
  const identity = expectedIdentity(input);
  if (!identity.ok) return identity.error;
  if (input.candidateId !== facts.candidate.id) {
    return {
      code: 'Conflict',
      reason: `This submission names candidate ${input.candidateId}, but the candidate under review is ${facts.candidate.id}. Re-render and submit again (F24-AC4).`,
      expected: input.candidateId,
      actual: facts.candidate.id,
    };
  }
  if (input.expectedContractRevision !== facts.contract.revision) {
    return {
      code: 'Conflict',
      reason: `This submission was prepared against contract revision ${input.expectedContractRevision}, but revision ${facts.contract.revision} is current. Re-render and submit again (F24-AC4).`,
      expected: String(input.expectedContractRevision),
      actual: String(facts.contract.revision),
    };
  }
  if (identity.value !== facts.candidate.headSha) {
    return {
      code: 'Conflict',
      reason: `This submission was prepared against candidate ${identity.value}, but the candidate on screen is ${facts.candidate.headSha}. Evidence and decisions from the earlier commit do not describe this one (F24-AC4, F25-AC3).`,
      expected: identity.value,
      actual: facts.candidate.headSha,
    };
  }
  return null;
}

export function createMvpReviewUseCases(deps: MvpReviewDeps): MvpReviewUseCases {
  /**
   * Reads the durable rows and projects them.
   *
   * The stale-submission guard runs first, so a submitter on an outdated card is told
   * before any write is attempted and without learning anything new about the candidate.
   */
  const project = async (
    input: ReviewRequestInput,
  ): Promise<Result<MvpReviewReadModel, DomainError>> => {
    const stale = staleSubmission(input, input.facts);
    if (stale !== null) return err(stale);
    const identity = expectedIdentity(input);
    if (!identity.ok) return err(identity.error);

    const stored = await deps.store.readProjection({
      candidateId: input.candidateId,
      candidateHeadSha: identity.value,
      contractId: input.facts.contract.id,
      contractRevision: input.facts.contract.revision,
    });
    if (!stored.ok) return err(stored.error);

    return buildMvpReviewReadModel({
      request: input.facts.request,
      contract: input.facts.contract,
      candidate: input.facts.candidate,
      ...(input.facts.policy === undefined ? {} : { policy: input.facts.policy }),
      evidence: stored.value.evidence,
      decisions: stored.value.decisions,
      evaluatedAt: deps.clock.now(),
    });
  };

  const review = (input: ReviewRequestInput): Promise<Result<MvpReviewReadModel, DomainError>> =>
    project(input);

  /**
   * Records one automated observation.
   *
   * The domain builds the evidence, so the caller cannot hand in a pre-built value with a
   * claimed outcome; and the row is bound to the candidate on screen, so the caller's
   * `observedHeadSha` describes the run rather than selecting which candidate it lands on.
   * That asymmetry is deliberate: the source may legitimately not know the commit it ran
   * against, but the review it feeds is always about one candidate.
   */
  const recordEvidence = async (
    input: RecordEvidenceInput,
  ): Promise<Result<MvpReviewReadModel, DomainError>> => {
    const stale = staleSubmission(input, input.facts);
    if (stale !== null) return err(stale);
    const identity = expectedIdentity(input);
    if (!identity.ok) return err(identity.error);

    const recorded = recordMvpEvidence({
      evidenceId: input.evidenceId,
      contractId: input.facts.contract.id,
      candidateId: input.candidateId,
      subject: input.subject,
      method: input.method,
      observation: input.observation,
      observedHeadSha: input.observedHeadSha,
      observedContractRevision: input.observedContractRevision,
      observedAt: input.observedAt,
      detail: input.detail,
      artifactRef: input.artifactRef,
    });
    if (!recorded.ok) return err(recorded.error);

    const written = await deps.store.recordEvidence({
      evidence: recorded.value,
      projectId: input.projectId,
      requestId: input.requestId,
      candidateId: input.candidateId,
      candidateHeadSha: identity.value,
      contractId: input.facts.contract.id,
      contractRevision: input.facts.contract.revision,
      recordedAt: deps.clock.now(),
      correlationId: input.correlationId,
      owner: input.owner,
    });
    if (!written.ok) return err(written.error);

    return project(input);
  };

  /**
   * Records the owner's own test outcome.
   *
   * Owner-only by construction, and bound to the criterion the contract actually declares
   * as an owner test. A criterion assigned to an automated method cannot be discharged here,
   * because choosing the weaker verification for one's own work is not an owner test (F23-AC1).
   */
  const recordOwnerTest = async (
    input: RecordOwnerTestInput,
  ): Promise<Result<MvpReviewReadModel, DomainError>> => {
    const stale = staleSubmission(input, input.facts);
    if (stale !== null) return err(stale);
    const identity = expectedIdentity(input);
    if (!identity.ok) return err(identity.error);
    if (input.actor.role !== 'owner') {
      return err({
        code: 'Forbidden',
        reason: `Only the owner may record an owner test outcome; the ${input.actor.role} role may not, and that role carries no owner identity (F25-AC4).`,
      });
    }

    const criterion = input.facts.contract.acceptanceCriteria.find((entry) => entry.id === input.criterionId);
    if (criterion === undefined) {
      return err({
        code: 'NotFound',
        reason: `Contract revision ${input.facts.contract.revision} declares no criterion "${input.criterionId}", so there is nothing for the owner to have tested (F23-AC1).`,
      });
    }
    if (criterion.verificationType !== 'owner_test') {
      return err({
        code: 'Invalid',
        reason: `Criterion "${input.criterionId}" is verified automatically, so an owner test cannot discharge it. Changing the verification method is a contract decision (F23-AC1).`,
        fields: [{ path: 'criterionId', message: 'Only an owner_test criterion accepts a recorded owner test.' }],
      });
    }

    const recorded = recordMvpEvidence({
      evidenceId: input.evidenceId,
      contractId: input.facts.contract.id,
      candidateId: input.candidateId,
      subject: { kind: 'criterion', criterionId: input.criterionId },
      method: { kind: 'OwnerTest', instructions: criterion.description },
      observation: { kind: 'owner_test', outcome: input.outcome, actor: input.actor },
      observedHeadSha: identity.value,
      observedContractRevision: input.facts.contract.revision,
      observedAt: input.observedAt,
      detail: input.detail,
      artifactRef: input.artifactRef,
    });
    if (!recorded.ok) return err(recorded.error);

    const written = await deps.store.recordEvidence({
      evidence: recorded.value,
      projectId: input.projectId,
      requestId: input.requestId,
      candidateId: input.candidateId,
      candidateHeadSha: identity.value,
      contractId: input.facts.contract.id,
      contractRevision: input.facts.contract.revision,
      recordedAt: deps.clock.now(),
      correlationId: input.correlationId,
      owner: input.actor,
    });
    if (!written.ok) return err(written.error);

    return project(input);
  };

  /**
   * Accept, or Request Changes.
   *
   * Request Changes is refused without feedback, because a change request with nothing to
   * act on is not actionable and the fix pass has no instruction to follow (F25-AC2).
   * Accept is refused while eligibility says no, and names every outstanding criterion
   * rather than only counting them — an owner who is told "3 of 4" learns nothing, while
   * being told which three learns exactly what to do.
   */
  const decide = async (
    input: DecideInput,
  ): Promise<Result<MvpReviewReadModel, DomainError>> => {
    // The owner check comes before everything else, including reading the candidate's
    // facts. A non-owner caller learns nothing about the candidate from the refusal, and
    // cannot be handed an eligibility report that tells it what is still outstanding
    // (F25-AC4). Checking eligibility first would leak exactly that.
    if (input.actor.role !== 'owner') {
      return err({
        code: 'Forbidden',
        reason: `Only the owner may ${input.kind === 'accepted' ? 'accept a candidate' : 'request changes'}; the ${input.actor.role} role may not, and that role carries no owner identity (F25-AC4).`,
      });
    }
    const stale = staleSubmission(input, input.facts);
    if (stale !== null) return err(stale);
    const identity = expectedIdentity(input);
    if (!identity.ok) return err(identity.error);
    if (input.kind === 'changes_requested' && (input.feedback === null || input.feedback.trim() === '')) {
      return err({
        code: 'Invalid',
        reason: 'A change request needs feedback, or the fix pass has nothing to act on (F25-AC2).',
        fields: [{ path: 'feedback', message: 'State what should change.' }],
      });
    }

    const current = await project(input);
    if (!current.ok) return err(current.error);

    // The acceptance gate, not the review-offer gate. A pending owner test may sit on the
    // review offer as the owner's own action (F24-AC3) but must be discharged before the
    // candidate is accepted, and each outstanding item is named so the owner learns what
    // to do rather than only how many things remain.
    if (input.kind === 'accepted' && !current.value.eligibility.readyForAcceptance) {
      return err({
        code: 'Blocked',
        reason: `This candidate cannot be accepted yet: ${current.value.eligibility.acceptanceBlockers.length} outstanding requirements (F23-AC1, F24-AC3).`,
        prerequisites: current.value.eligibility.acceptanceBlockers.map((reason) => ({
          name: 'Outstanding requirement',
          detail: reason,
          remedy: 'Record the missing observation, or request changes with what is wrong.',
        })),
      });
    }

    const decided = recordMvpOwnerDecision({
      decisionId: deps.newDecisionId(),
      kind: input.kind,
      actor: input.actor,
      projectId: input.projectId,
      requestId: input.requestId,
      contractId: input.facts.contract.id,
      contractRevision: input.facts.contract.revision,
      candidateId: input.candidateId,
      candidateHeadSha: identity.value,
      decidedAt: deps.clock.now(),
      feedback: input.feedback,
    });
    if (!decided.ok) return err(decided.error);

    const written = await deps.store.recordDecision({ decision: decided.value, correlationId: input.correlationId });
    if (!written.ok) return err(written.error);

    return project(input);
  };

  return { review, recordEvidence, recordOwnerTest, decide };
}

/** The evidence a caller supplied, so the record is typed rather than a bag of strings. */
export type MvpEvidenceRecord = MvpRecordedEvidence;

/** A decision this layer recorded, for the caller's response shape. */
export type MvpRecordedOwnerDecision = MvpOwnerDecision;