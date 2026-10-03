/**
 * The review card and the owner decision, as the transport serves them (mvp-spec F24, F25).
 *
 * Builder 5's review layer already decides everything: `buildMvpReviewReadModel` derives one
 * self-consistent projection, `recordMvpOwnerDecision` binds a decision to one exact commit,
 * and `createMvpReviewUseCases` refuses a submission prepared against facts that have moved.
 * Nothing here re-decides any of that. This module supplies the two things a domain function
 * cannot do for itself, and nothing else:
 *
 *   - **the facts.** A candidate names a project, a request, a contract and a revision. The
 *     read model projects *those* facts, so somebody has to read them from durable state and
 *     refuse a candidate that belongs to another project. That is this module's whole
 *     remaining job, and it is why it is a separate module rather than three lines in a route:
 *     a route that assembled facts would be a use case wearing a transport's clothes.
 *   - **the wire shape.** The domain's read model is deliberately careful about a stale
 *     observation: `outcome` is what the source said and stays `passed` after a push, while
 *     `currentOutcome` is `stale` once the binding no longer holds. Passing those two fields
 *     through under their own names invites the exact defect the review doc warns about - a UI
 *     that reads `outcome` renders a stale pass in green. So the projection renames them to
 *     `recordedOutcome` (a claim about the past) and `currentOutcome` (a claim about this
 *     candidate), adds `countsForCurrentCandidate` as the single affirmative flag, and never
 *     exposes a bare `outcome` a reader could reach for by mistake (F20-AC3, F24-AC3).
 *
 * Two things are deliberately absent, and both are refusals rather than omissions:
 *
 *   - **No decision is created anywhere but here, by an authenticated owner.** The actor is
 *     the domain's `MvpActor`, whose non-owner variants carry no owner identity, and it is
 *     narrowed before any candidate is read, so an agent, a webhook or an engine completion
 *     event learns nothing about the candidate even from the refusal (F25-AC4).
 *   - **No submission is re-pointed.** Every decision names the full SHA and the contract
 *     revision it was prepared against, and the domain compares both against the live
 *     candidate. An acceptance of SHA A therefore refuses to become an acceptance of SHA B
 *     (F24-AC4, F25-AC3).
 *
 * The evidence a check or an owner test produces is *not* written here: no HTTP route in the
 * minimal MVP records one, so `recordEvidence` and `recordOwnerTest` are reachable only from the
 * use cases. That is a gap in the phase's transport contract rather than a choice, and the read
 * model answers honestly in the meantime - a criterion nobody observed reads `unverified` and an
 * owner test reads `pending`, so nothing on the card can look accepted (F24-AC3).
 */

import { randomUUID } from 'node:crypto';
import { requireMvpOwner } from '@shiploop/domain';
import type {
  CandidateId,
  ContractId,
  ContractStatus,
  CriterionVerificationMethod,
  DeliveryContract,
  DomainError,
  MvpActor,
  MvpCandidateView,
  MvpContractCriterionView,
  MvpContractView,
  MvpCriterionResultView,
  MvpDecisionView,
  MvpReviewReadModel,
  MvpRequestView,
  ProjectId,
  Request,
  RequestId,
  Result,
} from '@shiploop/domain';
import { createMvpReviewUseCases, type MvpReviewFacts, type MvpReviewUseCases } from './mvp-review.ts';
import type { ControllerClock } from './profiles.ts';
import type {
  CandidateLinkStore,
  ContractStore,
  DeliveryCandidateRecord,
  MvpReviewStore,
  RequestStore,
} from '@shiploop/storage';

/* -------------------------------------------------------------------------- */
/* The projection the transport serves                                          */
/* -------------------------------------------------------------------------- */

/** The states a criterion may read on the card. Closed, so a reader cannot invent one. */
export type MvpCriterionState = 'passed' | 'failed' | 'pending' | 'stale' | 'unverified';

/** What a check may read, including the two that are explicitly not a pass. */
export type MvpCheckResult =
  | 'passed'
  | 'failed'
  | 'waiting'
  | 'missing'
  | 'capture_failed'
  | 'stale'
  | 'not_run';

/** One acceptance criterion as the owner reads it on the card (F24-AC2). */
export interface MvpCriterionProjection {
  readonly criterionId: string;
  readonly description: string;
  readonly verificationType: 'automated' | 'owner_test';
  /**
   * The check that verifies an automated criterion, or null when nobody assigned one.
   *
   * Reported from the criterion's assigned method rather than filled in from whichever check
   * happened to pass: a criterion with no bound verifier is `unverified`, and that is the
   * honest state (F23-AC1).
   */
  readonly verificationCheckId: string | null;
  readonly state: MvpCriterionState;
  readonly methodKind: string;
  /** The check id, the instructions or the reference, depending on the method. */
  readonly methodDetail: string | null;
  readonly evidenceId: string | null;
  readonly observedAt: string | null;
  readonly reason: string;
}

/**
 * One required or observed check (F20-AC2, F24-AC2).
 *
 * `not_run` and `stale` are members rather than absences, so a check nobody reported and a check
 * bound to another commit are both displayed rather than omitted - a table that lists only what
 * ran cannot show a gate that was dropped (F20-AC2).
 */
export interface MvpCheckProjection {
  readonly checkId: string;
  readonly required: boolean;
  readonly blocking: boolean;
  readonly result: MvpCheckResult;
  readonly evidenceId: string | null;
  readonly source: MvpEvidenceSourceProjection | null;
  readonly reason: string;
}

export type MvpEvidenceSourceProjection = 'project_command' | 'github_check' | 'browser' | 'owner_test';

export type MvpEvidenceOutcomeProjection = 'passed' | 'failed' | 'waiting' | 'missing' | 'capture_failed';

/**
 * One recorded observation, with its staleness stated rather than implied (F20-AC3).
 *
 * The three fields a reader must not confuse:
 *
 *   - `recordedOutcome` — what the source said at the time it ran. It never changes, so it
 *     stays `passed` after a push and is history rather than a verdict on this candidate.
 *   - `currentOutcome` — what that observation means for the candidate on screen. It is
 *     `stale` whenever `countsForCurrentCandidate` is false, because that is what the domain
 *     computed; this projection does not re-derive it (F24-AC3).
 *   - `countsForCurrentCandidate` — the affirmative answer to "may this be shown as this
 *     candidate's result?".
 */
export interface MvpEvidenceProjection {
  readonly evidenceId: string;
  readonly source: MvpEvidenceSourceProjection;
  readonly criterionId: string | null;
  readonly checkId: string | null;
  readonly recordedOutcome: MvpEvidenceOutcomeProjection;
  readonly currentOutcome: MvpEvidenceOutcomeProjection | 'stale';
  readonly countsForCurrentCandidate: boolean;
  /** Why it no longer counts, empty when it does. */
  readonly staleReasons: readonly string[];
  readonly reason: string;
  readonly observedAt: string | null;
  /** The commit the source said it observed. Null when the source could not attribute it. */
  readonly candidateHeadSha: string | null;
  readonly contractRevision: number | null;
  readonly detail: string | null;
  readonly artifactRef: string | null;
}

/**
 * The owner tests the contract declares, as their own list.
 *
 * Separate from `criteria` because these are the owner's own steps and only the owner may
 * discharge them. `state` is `pending` until the owner records a result, and nothing on this
 * card can move it (F23-AC1, F24-AC3).
 */
export interface MvpOwnerTestProjection {
  readonly criterionId: string;
  readonly description: string;
  readonly instructions: string | null;
  readonly state: MvpCriterionState;
  readonly evidenceId: string | null;
  readonly observedAt: string | null;
  readonly reason: string;
}

/** One owner decision that no longer describes the candidate on screen (F25-AC3). */
export interface MvpStaleDecisionProjection {
  readonly decisionId: string;
  readonly kind: 'accepted' | 'changes_requested';
  readonly candidateHeadSha: string;
  readonly contractRevision: number;
  readonly reason: string;
}

/** The decision that applies, and the ones a push invalidated (F25-AC2, F25-AC3). */
export interface MvpDecisionProjection {
  readonly outcome: 'none' | 'accepted' | 'changes_requested';
  readonly decision: {
    readonly decisionId: string;
    readonly kind: 'accepted' | 'changes_requested';
    readonly ownerId: string;
    readonly decidedAt: string;
    readonly requestId: string;
    readonly contractId: string;
    readonly contractRevision: number;
    readonly candidateId: string;
    readonly candidateHeadSha: string;
    readonly feedback: string | null;
  } | null;
  readonly staleDecisions: readonly MvpStaleDecisionProjection[];
  /**
   * Whether the decision authorises the candidate on screen.
   *
   * False after a push. A card gates on this rather than on `outcome`: an acceptance for SHA A
   * does not authorise SHA B (F27-AC3).
   */
  readonly authorizesCurrentCandidate: boolean;
}

/** What no longer describes this candidate, by id and by reason (F20-AC3, F25-AC3). */
export interface MvpStalenessProjection {
  readonly stale: boolean;
  readonly reasons: readonly string[];
  readonly staleEvidenceIds: readonly string[];
  readonly staleDecisionIds: readonly string[];
}

/** The three gates, kept apart because the product keeps them apart (F24-AC3, F25-AC1). */
export interface MvpEligibilityProjection {
  readonly readyForOwnerReview: boolean;
  readonly readyForAcceptance: boolean;
  readonly readyForDelivery: boolean;
  readonly blockingReasons: readonly string[];
  readonly ownerActions: readonly string[];
  readonly acceptanceBlockers: readonly string[];
  readonly deliveryBlockers: readonly string[];
}

/**
 * The whole card: one object, computed once.
 *
 * Nothing here is accumulated across routes, which is what makes the card self-consistent - the
 * same criterion cannot be green in `criteria` and stale in `evidence`, because both come from
 * the same pass (F24-AC2).
 */
export interface MvpReviewCard {
  /** When this projection was computed, so a client can tell an old card from a new one. */
  readonly collectedAt: string;
  readonly request: {
    readonly requestId: string;
    readonly projectId: string;
    readonly title: string;
    readonly description: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly contract: {
    readonly contractId: string;
    readonly projectId: string;
    readonly requestId: string;
    /** The revision every criterion, every evidence row and every decision binds to. */
    readonly revision: number;
    readonly status: ContractStatus;
    readonly outcome: string;
    readonly scope: readonly string[];
    readonly outOfScope: readonly string[];
    readonly approval: { readonly approvedAt: string | null; readonly approvedBy: string | null };
    readonly acceptanceCriteria: readonly {
      readonly id: string;
      readonly verificationType: 'automated' | 'owner_test';
      /** The check that verifies an automated criterion, or null when none is bound. */
      readonly verificationCheckId: string | null;
    }[];
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly candidate: {
    readonly candidateId: string;
    readonly projectId: string;
    readonly requestId: string;
    readonly contractId: string;
    readonly contractRevision: number;
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly pullRequestUrl: string;
    /** GitHub's own state, passed through and never inferred (mvp-spec 3). */
    readonly pullRequestState: string;
    readonly draft: boolean;
    readonly baseBranch: string;
    /**
     * The full commit SHA. The only acceptable identity for what is under review: a branch
     * name, an abbreviation or a PR number cannot say which build passed (F20-AC3, F25-AC3).
     */
    readonly headSha: string;
    readonly observedAt: string;
  };
  readonly policy: {
    readonly policyId: string;
    readonly requiredAutomatedCheckIds: readonly string[];
    readonly ownerTestBlocksReview: boolean;
    readonly ownerTestBlocksDelivery: boolean;
  };
  readonly checks: readonly MvpCheckProjection[];
  readonly criteria: readonly MvpCriterionProjection[];
  readonly ownerTests: readonly MvpOwnerTestProjection[];
  readonly evidence: readonly MvpEvidenceProjection[];
  readonly staleness: MvpStalenessProjection;
  readonly decision: MvpDecisionProjection;
  readonly eligibility: MvpEligibilityProjection;
}

/* -------------------------------------------------------------------------- */
/* The port                                                                     */
/* -------------------------------------------------------------------------- */

export interface ReadMvpReviewCommand {
  readonly projectId: string;
  readonly candidateId: string;
  /** The domain's actor union, so a non-owner is refused rather than trusted. */
  readonly actor: MvpActor;
}

export interface RecordMvpOwnerDecisionCommand extends ReadMvpReviewCommand {
  readonly decision: 'accepted' | 'changes_requested';
  /** The full SHA the card was rendered against. Required: it is what makes staleness a conflict. */
  readonly expectedHeadSha: string;
  readonly expectedContractRevision: number;
  readonly feedback: string | null;
}

export interface MvpReviewCardUseCases {
  readonly getReview: (command: ReadMvpReviewCommand) => Promise<Result<MvpReviewCard, DomainError>>;
  readonly decide: (command: RecordMvpOwnerDecisionCommand) => Promise<Result<MvpReviewCard, DomainError>>;
}

/** The durable state the card is read from. Narrow reads, so nothing writes through this. */
export interface MvpReviewCardDeps {
  readonly clock: ControllerClock;
  readonly requests: Pick<RequestStore, 'read'>;
  readonly contracts: Pick<ContractStore, 'read'>;
  readonly candidates: Pick<CandidateLinkStore, 'get'>;
  readonly review: MvpReviewStore;
  /** Injected so a recorded decision replays identically in a test. */
  readonly newDecisionId?: () => string;
  readonly newCorrelationId?: () => string;
}

/* -------------------------------------------------------------------------- */
/* Facts                                                                       */
/* -------------------------------------------------------------------------- */

interface ReviewFacts {
  /** What the read model is given. */
  readonly facts: MvpReviewFacts;
  /** The stored rows, so provider facts reach the card unaltered. */
  readonly candidate: DeliveryCandidateRecord;
  readonly contract: DeliveryContract;
}

/**
 * The request, contract and candidate the card is measured against.
 *
 * Every read is keyed by the project as well as the identity, and a candidate recorded against
 * another project is refused rather than projected: a cross-project lookup by id alone would let
 * one project's owner read another's review card (F02-AC2).
 */
function readFacts(
  deps: MvpReviewCardDeps,
  command: ReadMvpReviewCommand,
): Result<ReviewFacts, DomainError> {
  const candidate = deps.candidates.get(command.candidateId as CandidateId);
  if (!candidate.ok) return candidate;
  if (String(candidate.value.projectId) !== command.projectId) {
    return {
      ok: false,
      error: {
        code: 'NotFound',
        reason: `This project holds no candidate ${command.candidateId}. A candidate is addressed by its own project, so one project's identifier cannot read another's card (F02-AC2).`,
      },
    };
  }

  const request = deps.requests.read(command.projectId as ProjectId, candidate.value.requestId as RequestId);
  if (!request.ok) return request;
  const contract = deps.contracts.read(
    command.projectId as ProjectId,
    candidate.value.contractId as ContractId,
    candidate.value.contractRevision,
  );
  if (!contract.ok) return contract;

  return {
    ok: true,
    value: { facts: toFacts(request.value, contract.value, candidate.value), candidate: candidate.value, contract: contract.value },
  };
}

/** The stored rows as the domain's review facts. Mapping only; no judgement here. */
function toFacts(
  request: Request,
  contract: DeliveryContract,
  candidate: DeliveryCandidateRecord,
): MvpReviewFacts {
  const requestView: MvpRequestView = {
    id: request.requestId,
    projectId: String(request.projectId),
    title: request.title,
    description: request.description,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
  const contractView: MvpContractView = {
    id: contract.contractId,
    projectId: String(contract.projectId),
    requestId: contract.requestId,
    revision: contract.revision,
    outcome: contract.outcome,
    // The review view's `scope` is a single string while a stored revision holds a list, so
    // the list is joined rather than dropped. The read model never reads it; the card takes its
    // scope from the stored row below, so nothing on the wire depends on this flattening.
    scope: contract.scope.join('\n'),
    outOfScope: [...contract.outOfScope],
    // Each criterion carries its own binding from the stored revision, so the read model
    // resolves it against the recorded results for this exact candidate SHA. Nothing is
    // inferred from whichever check happened to pass: an automated criterion whose revision
    // names no check reads `unverified`, which is the honest reading of "nothing is bound
    // to it" (F23-AC1).
    acceptanceCriteria: contract.acceptanceCriteria.map(toCriterionView),
    status: contract.status,
    approvedAt: contract.approvedAt,
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
  };
  const candidateView: MvpCandidateView = {
    id: candidate.candidateId,
    projectId: String(candidate.projectId),
    requestId: candidate.requestId,
    contractId: candidate.contractId,
    contractRevision: candidate.contractRevision,
    repository: candidate.repository,
    pullRequestNumber: candidate.pullRequestNumber,
    pullRequestUrl: candidate.pullRequestUrl,
    baseBranch: candidate.baseBranch,
    headSha: candidate.headSha,
    observedAt: candidate.observedAt,
  };
  return { request: requestView, contract: contractView, candidate: candidateView };
}

/**
 * One stored criterion, as the read model wants it.
 *
 * The binding is passed through from the revision rather than decided here. This module
 * supplies the *facts*; which check decides which criterion is the agreement's statement,
 * and a projection that chose one would be the inference F23-AC1 forbids. `owner_test` is
 * forced to null because the domain refuses to store a binding on one - and forcing it here
 * as well means a stored row that somehow carried one cannot reach the projection as an
 * automated binding (F23-AC1).
 */
function toCriterionView(criterion: DeliveryContract['acceptanceCriteria'][number]): MvpContractCriterionView {
  return {
    id: criterion.id,
    description: criterion.description,
    verificationType: criterion.verificationType,
    verificationCheckId:
      criterion.verificationType === 'automated' ? criterion.verificationCheckId : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Projection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The one projection every review surface reads.
 *
 * Two renames carry the whole point of this function, and both exist because the bare names are
 * dangerous at the boundary:
 *
 *   - `evidence[].outcome` becomes `recordedOutcome`: a claim about the past. A client that
 *     reaches for `outcome` finds nothing to reach for (F20-AC3).
 *   - `evidence[].currentOutcome` keeps its name and is guaranteed to be `stale` whenever
 *     `countsForCurrentCandidate` is false, because that is what the domain computed.
 *
 * Provider facts - the pull request state, the draft flag, the approver - are copied from the
 * stored rows rather than recomputed. An unrecognised provider state stays unrecognised here;
 * the projection has no vocabulary that would let it read as "open" (mvp-spec 3).
 */
function toCard(model: MvpReviewReadModel, facts: ReviewFacts, collectedAt: string): MvpReviewCard {
  return {
    collectedAt,
    request: {
      requestId: model.request.id,
      projectId: model.request.projectId,
      title: model.request.title,
      description: model.request.description,
      createdAt: model.request.createdAt,
      updatedAt: model.request.updatedAt,
    },
    contract: {
      contractId: model.contract.id,
      projectId: model.contract.projectId,
      requestId: model.contract.requestId,
      revision: model.contract.revision,
      status: model.contract.status,
      outcome: model.contract.outcome,
      scope: [...facts.contract.scope],
      outOfScope: [...facts.contract.outOfScope],
      approval: { approvedAt: facts.contract.approvedAt, approvedBy: facts.contract.approvedBy },
      acceptanceCriteria: model.contract.acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        verificationType: criterion.verificationType,
        verificationCheckId: criterion.verificationCheckId,
      })),
      createdAt: model.contract.createdAt,
      updatedAt: model.contract.updatedAt,
    },
    candidate: {
      candidateId: model.candidate.id,
      projectId: model.candidate.projectId,
      requestId: model.candidate.requestId,
      contractId: model.candidate.contractId,
      contractRevision: model.candidate.contractRevision,
      repository: facts.candidate.repository,
      pullRequestNumber: facts.candidate.pullRequestNumber,
      pullRequestUrl: facts.candidate.pullRequestUrl,
      pullRequestState: facts.candidate.pullRequestState,
      draft: facts.candidate.draft,
      baseBranch: model.candidate.baseBranch,
      headSha: model.candidate.headSha,
      observedAt: model.candidate.observedAt,
    },
    policy: {
      policyId: model.policy.policyId,
      requiredAutomatedCheckIds: [...model.policy.requiredAutomatedCheckIds],
      ownerTestBlocksReview: model.policy.ownerTestBlocksReview,
      ownerTestBlocksDelivery: model.policy.ownerTestBlocksDelivery,
    },
    checks: model.checks.map(toCheckProjection),
    criteria: model.criteria.map(toCriterionProjection),
    ownerTests: ownerTestsOf(model.criteria),
    evidence: model.evidence.map((evidence) => ({
      evidenceId: evidence.evidenceId,
      source: evidence.source,
      criterionId: evidence.criterionId,
      checkId: evidence.checkId,
      recordedOutcome: evidence.outcome,
      currentOutcome: evidence.currentOutcome,
      countsForCurrentCandidate: evidence.appliesToCurrentCandidate,
      staleReasons: [...evidence.staleReasons],
      reason: evidence.reason,
      observedAt: evidence.observedAt,
      candidateHeadSha: evidence.candidateHeadSha,
      contractRevision: evidence.contractRevision,
      detail: evidence.detail,
      artifactRef: evidence.artifactRef,
    })),
    staleness: {
      stale: model.staleness.stale,
      reasons: [...model.staleness.reasons],
      staleEvidenceIds: [...model.staleness.staleEvidenceIds],
      staleDecisionIds: [...model.staleness.staleDecisionIds],
    },
    decision: toDecisionProjection(model.decision),
    eligibility: {
      readyForOwnerReview: model.eligibility.readyForOwnerReview,
      readyForAcceptance: model.eligibility.readyForAcceptance,
      readyForDelivery: model.eligibility.readyForDelivery,
      blockingReasons: [...model.eligibility.blockingReasons],
      ownerActions: [...model.eligibility.ownerActions],
      acceptanceBlockers: [...model.eligibility.acceptanceBlockers],
      deliveryBlockers: [...model.eligibility.deliveryBlockers],
    },
  };
}

function toCheckProjection(check: MvpReviewReadModel['checks'][number]): MvpCheckProjection {
  return {
    checkId: check.checkId,
    required: check.required,
    blocking: check.blocking,
    result: check.result,
    evidenceId: check.evidenceId,
    source: check.source,
    reason: check.reason,
  };
}

function toCriterionProjection(criterion: MvpCriterionResultView): MvpCriterionProjection {
  return {
    criterionId: criterion.criterionId,
    description: criterion.description,
    verificationType: criterion.verificationType,
    verificationCheckId: criterion.method.kind === 'AutomatedCheck' ? criterion.method.checkId : null,
    state: criterion.state,
    methodKind: criterion.method.kind,
    methodDetail: methodDetailOf(criterion.method),
    evidenceId: criterion.evidenceId,
    observedAt: criterion.observedAt,
    reason: criterion.reason,
  };
}

/** The owner tests, in the order the contract declared them, with nothing inferred. */
function ownerTestsOf(criteria: readonly MvpCriterionResultView[]): MvpOwnerTestProjection[] {
  return criteria
    .filter((criterion) => criterion.verificationType === 'owner_test')
    .map((criterion) => ({
      criterionId: criterion.criterionId,
      description: criterion.description,
      instructions: criterion.method.kind === 'OwnerTest' ? criterion.method.instructions : null,
      state: criterion.state,
      evidenceId: criterion.evidenceId,
      observedAt: criterion.observedAt,
      reason: criterion.reason,
    }));
}

function methodDetailOf(method: CriterionVerificationMethod): string | null {
  switch (method.kind) {
    case 'AutomatedCheck':
      return method.checkId;
    case 'OwnerTest':
      return method.instructions;
    case 'BrowserEvidence':
    case 'ApiEvidence':
      return method.evidenceId;
    case 'Untested':
      return null;
  }
}

function toDecisionProjection(decision: MvpDecisionView): MvpDecisionProjection {
  return {
    outcome: decision.outcome,
    decision:
      decision.decision === null
        ? null
        : {
            decisionId: decision.decision.decisionId,
            kind: decision.decision.kind,
            ownerId: decision.decision.ownerId,
            decidedAt: decision.decision.decidedAt,
            requestId: decision.decision.requestId,
            contractId: decision.decision.contractId,
            contractRevision: decision.decision.contractRevision,
            candidateId: decision.decision.candidateId,
            candidateHeadSha: decision.decision.candidateHeadSha,
            feedback: decision.decision.feedback,
          },
    staleDecisions: decision.staleDecisions.map((stale) => ({
      decisionId: stale.decisionId,
      kind: stale.kind,
      candidateHeadSha: stale.candidateHeadSha,
      contractRevision: stale.contractRevision,
      reason: stale.reason,
    })),
    authorizesCurrentCandidate: decision.authorizesCurrentCandidate,
  };
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The two review endpoints, over durable state.
 *
 * `review` and `decide` are Builder 5's use cases, used unmodified. This module reads the facts
 * they need and projects what they return, and it refuses a non-owner before either fact read
 * so that a refused caller learns nothing about the candidate (F25-AC4).
 */
export function createMvpReviewCardUseCases(deps: MvpReviewCardDeps): MvpReviewCardUseCases {
  const newDecisionId = deps.newDecisionId ?? (() => randomUUID());
  const newCorrelationId = deps.newCorrelationId ?? (() => randomUUID());
  const useCases: MvpReviewUseCases = createMvpReviewUseCases({
    store: deps.review,
    clock: deps.clock,
    newDecisionId,
  });

  const collect = async (command: ReadMvpReviewCommand): Promise<Result<MvpReviewCard, DomainError>> => {
    // The owner check precedes every read, including for a read-only command: an agent that
    // asked is told the boundary exists and is told nothing about the candidate (F25-AC4).
    const owner = requireMvpOwner(command.actor, 'Reading or deciding on a review card');
    if (!owner.ok) return owner;

    const facts = readFacts(deps, command);
    if (!facts.ok) return facts;

    // A read is projected against the live head, because a read has no submission to compare.
    // The value a client submits back is `candidate.headSha` and `contract.revision` (F24-AC4).
    const projected = await useCases.review({
      projectId: command.projectId,
      requestId: facts.value.facts.request.id,
      candidateId: command.candidateId,
      expectedHeadSha: facts.value.facts.candidate.headSha,
      expectedContractRevision: facts.value.facts.contract.revision,
      facts: facts.value.facts,
    });
    if (!projected.ok) return projected;
    return { ok: true, value: toCard(projected.value, facts.value, deps.clock.now()) };
  };

  return {
    getReview: collect,

    /**
     * Accept, or Request Changes.
     *
     * The caller names the commit and the contract revision it was looking at; the domain
     * refuses a mismatch rather than applying the decision to whatever the candidate is now.
     * Accept is additionally refused while the projection says a criterion is outstanding, with
     * every outstanding item named, and Request Changes stays available either way (F23-AC1,
     * F24-AC3, F25-AC2).
     */
    decide: async (command: RecordMvpOwnerDecisionCommand): Promise<Result<MvpReviewCard, DomainError>> => {
      const owner = requireMvpOwner(
        command.actor,
        command.decision === 'accepted' ? 'Accepting a candidate' : 'Requesting changes',
      );
      if (!owner.ok) return owner;

      const facts = readFacts(deps, command);
      if (!facts.ok) return facts;

      const decided = await useCases.decide({
        projectId: command.projectId,
        requestId: facts.value.facts.request.id,
        candidateId: command.candidateId,
        expectedHeadSha: command.expectedHeadSha,
        expectedContractRevision: command.expectedContractRevision,
        facts: facts.value.facts,
        actor: command.actor,
        kind: command.decision,
        feedback: command.feedback,
        correlationId: newCorrelationId(),
      });
      if (!decided.ok) return decided;
      return { ok: true, value: toCard(decided.value, facts.value, deps.clock.now()) };
    },
  };
}
