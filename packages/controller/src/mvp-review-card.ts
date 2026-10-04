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
 * ## The two evidence paths, and why they are two
 *
 * `recordVerification` and `recordOwnerTest` are the only things here that turn an observation
 * into a stored `MvpRecordedEvidence` row reachable from the shipped transport, and they are
 * deliberately not one function with a flag:
 *
 *   - **`recordVerification` derives its result.** It reads the provider live, hands the facts to
 *     the verification package's `recordGitHubProjection`, and passes the outcome that function
 *     produced to `recordEvidence`. No member of its command carries a result: the observation
 *     vocabulary has no "claimed" member, so a caller that believes it chose the outcome is told
 *     the outcome is not its to choose (F20-AC2, F23-AC1).
 *   - **`recordOwnerTest` accepts one, because the owner's own test is not a measurement.** There
 *     is no provider to read it from, so `outcome` is the owner's report and only the owner may
 *     file it. The criterion must still be one the contract declares `owner_test`, so choosing the
 *     weaker verification for one's own work is refused rather than accepted (F23-AC1, F25-AC4).
 *
 * Both bind the six facts the domain requires - project, request, contract revision, criterion or
 * check, candidate and *full* candidate SHA - and both derive the commit from the stored candidate
 * row rather than from the caller, because "which candidate is this evidence about" has exactly
 * one answer and the caller is not the authority on it (F20-AC3, F24-AC4).
 */

import { createHash, randomUUID } from 'node:crypto';
import { isCommitSha, requireMvpOwner } from '@shiploop/domain';
import type {
  CandidateCheckStatus,
  CandidateId,
  CheckResult,
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
  MvpEvidenceObservation,
  MvpRecordedEvidence,
  MvpReviewReadModel,
  MvpRequestView,
  OwnerId,
  ProjectId,
  Request,
  RequestId,
  Result,
} from '@shiploop/domain';
import { recordGitHubProjection } from '@shiploop/verification';
import type {
  GitHubCandidateProjection,
  GitHubCheckProjection,
  GitHubProjectionTarget,
} from '@shiploop/verification';
import { createMvpReviewUseCases, type MvpReviewFacts, type MvpReviewUseCases } from './mvp-review.ts';
import type { ControllerClock } from './profiles.ts';
import type { CandidateView } from './candidate-linking.ts';
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

/**
 * The live provider read the automated verification path derives its results from.
 *
 * Narrowed to what this module needs - an owner identity, the project and the request - rather
 * than to the candidate module's own `readCandidate` input, so this seam does not drag the
 * run-scoped `OwnerActor` vocabulary into a contract-revision review.
 *
 * `null` means this deployment composed no read-only git provider at all, which is a different
 * fact from a provider that refused the read: the first is answered with a named `Unavailable` at
 * the operation and records nothing, the second arrives as whatever the provider returned
 * (F03-AC2, F20-AC2).
 *
 * The reader is expected to contact the provider rather than answer from a stored row. That is
 * what makes what it returns an observation of the commit the candidate currently holds, and it is
 * why `recordVerification` records nothing at all when it cannot be reached.
 */
export type MvpLiveCandidateReader = (input: {
  readonly ownerId: OwnerId;
  readonly projectId: ProjectId;
  readonly requestId: string;
  readonly correlationId: string;
}) => Promise<Result<CandidateView, DomainError>>;

/**
 * Record the provider's check results for a candidate.
 *
 * There is deliberately **no result, no outcome and no check id on this command**. The server
 * derives every one of them from the provider read below, so this schema cannot be widened into a
 * way for a client to assert that something passed. `correlationId` is the only member about this
 * call rather than about the candidate, and it is the transport's own trace identity (F20-AC2).
 */
export interface RecordMvpVerificationCommand {
  readonly projectId: string;
  readonly candidateId: string;
  readonly actor: MvpActor;
  readonly correlationId: string;
}

/**
 * Record what the owner says they observed.
 *
 * `outcome` is the one member a caller supplies a verdict through, and it is here because the
 * owner's own test is an observation rather than a measurement: there is no provider to read it
 * from. Two members and no third - no owner, no commit, no instant and no way to name a
 * criterion's verification type - so this command cannot attribute the observation to somebody
 * else, backdate it, or discharge an automated criterion (F01-AC1, F23-AC1, F25-AC4).
 */
export interface RecordMvpOwnerTestCommand {
  readonly projectId: string;
  readonly candidateId: string;
  readonly actor: MvpActor;
  readonly criterionId: string;
  readonly outcome: 'passed' | 'failed';
  readonly note: string | null;
  readonly correlationId: string;
}

/** One automated observation as recorded, and as it stands for the candidate on screen. */
export interface MvpRecordedObservationReport {
  readonly evidenceId: string;
  readonly checkId: string;
  /** What the provider said at the time. History, and never re-derived as a verdict (F20-AC3). */
  readonly recordedOutcome: MvpEvidenceOutcomeProjection;
  /** What that observation means for the candidate the card is about. */
  readonly currentOutcome: MvpEvidenceOutcomeProjection | 'stale';
  readonly countsForCurrentCandidate: boolean;
  /** The commit the provider attributed the run to, or null when it attributed nothing. */
  readonly observedHeadSha: string | null;
  readonly observedContractRevision: number | null;
  readonly observedAt: string | null;
  readonly reason: string;
}

/**
 * What one automated verification pass observed, and the card it produced.
 *
 * Both heads are carried and they are allowed to differ, because that difference *is* the answer:
 * `candidateHeadSha` is the commit the evidence is bound to and `providerHeadSha` is the commit the
 * pull request holds now. When they differ, every check the provider attributed to the newer commit
 * lands unbound, reads `stale` and proves nothing about the candidate under review - which is the
 * correct outcome, and the reason the two are reported side by side rather than collapsed
 * (F20-AC3, F24-AC4).
 */
export interface MvpVerificationReport {
  readonly projectId: string;
  readonly candidateId: string;
  readonly candidateHeadSha: string;
  readonly providerHeadSha: string;
  readonly contractId: string;
  readonly contractRevision: number;
  /** The source that produced every observation in this report. One, and named (F20-AC2). */
  readonly method: 'github_checks';
  readonly observedAt: string;
  readonly recorded: readonly MvpRecordedObservationReport[];
  readonly review: MvpReviewCard;
}

/** What the owner recorded, and the card it produced. */
export interface MvpOwnerTestReport {
  readonly projectId: string;
  readonly candidateId: string;
  /** The commit the owner's observation is bound to, read from the stored candidate. */
  readonly candidateHeadSha: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly criterionId: string;
  readonly outcome: 'passed' | 'failed';
  readonly evidenceId: string;
  readonly observedAt: string;
  readonly note: string | null;
  readonly review: MvpReviewCard;
}

export interface MvpReviewCardUseCases {
  readonly getReview: (command: ReadMvpReviewCommand) => Promise<Result<MvpReviewCard, DomainError>>;
  readonly decide: (command: RecordMvpOwnerDecisionCommand) => Promise<Result<MvpReviewCard, DomainError>>;
  /**
   * Reads the provider and records what it said, bound to the candidate's exact commit.
   *
   * Server-controlled by construction: the command carries no result (F20-AC2, F23-AC1).
   */
  readonly recordVerification: (
    command: RecordMvpVerificationCommand,
  ) => Promise<Result<MvpVerificationReport, DomainError>>;
  /** The owner's own observation of one `owner_test` criterion (F23-AC1, F25-AC4). */
  readonly recordOwnerTest: (command: RecordMvpOwnerTestCommand) => Promise<Result<MvpOwnerTestReport, DomainError>>;
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
  /**
   * The live candidate read the automated verification path derives its results from.
   *
   * Absent by default rather than defaulted to a stub that refuses every call, because a
   * deployment with no git provider must be told so by name at the operation instead of being
   * handed a use case that presents as a configured capability it cannot use (F03-AC2).
   */
  readonly readLiveCandidate?: MvpLiveCandidateReader | null;
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
 * The four review endpoints, over durable state.
 *
 * `review`, `decide`, `recordEvidence` and `recordOwnerTest` are Builder 5's use cases, used
 * unmodified. This module reads the facts they need, projects what they return, and refuses a
 * non-owner before any fact read so that a refused caller learns nothing about the candidate
 * (F25-AC4).
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

    /**
     * Records the provider's check results for this candidate.
     *
     * The order of the steps is the argument:
     *
     *   1. refuse a non-owner, so an agent learns nothing about the candidate (F25-AC4);
     *   2. read the facts, which refuses a candidate belonging to another project (F02-AC2);
     *   3. refuse a revision that is not approved - see `approvedRevisionOf` for why that has to
     *      happen here rather than at the projection;
     *   4. refuse with a named reason when this deployment composed no git provider, rather than
     *      answering an empty report that reads as "nothing failed" (F03-AC2);
     *   5. read the provider live, and return its failure unchanged - a provider that stopped
     *      answering must not be recorded as a clean run;
     *   6. bind the results to the candidate's *stored* commit rather than to whatever the provider
     *      just reported. That asymmetry is the whole of F20-AC3: a source may honestly not know
     *      which commit it ran against, but the evidence it produces is always about one candidate.
     */
    recordVerification: async (
      command: RecordMvpVerificationCommand,
    ): Promise<Result<MvpVerificationReport, DomainError>> => {
      const owner = requireMvpOwner(command.actor, 'Recording automated verification');
      if (!owner.ok) return owner;

      const facts = readFacts(deps, command);
      if (!facts.ok) return facts;

      const approved = approvedRevisionOf(facts.value.contract);
      if (!approved.ok) return approved;

      if (deps.readLiveCandidate === null || deps.readLiveCandidate === undefined) {
        return {
          ok: false,
          error: {
            code: 'Unavailable',
            reason:
              'This deployment composed no read-only git provider, so no check result could be read and no automated evidence was recorded. Nothing was verified and nothing is claimed to have been (F03-AC2, F20-AC2).',
          },
        };
      }

      const live = await deps.readLiveCandidate({
        ownerId: owner.value.ownerId,
        projectId: command.projectId as ProjectId,
        requestId: facts.value.facts.request.id,
        correlationId: command.correlationId,
      });
      if (!live.ok) return live;

      const contract = facts.value.facts.contract;
      const candidate = facts.value.facts.candidate;
      if (!isCommitSha(candidate.headSha)) {
        return {
          ok: false,
          error: {
            code: 'Invalid',
            reason: `Candidate ${candidate.id} records head "${truncate(candidate.headSha)}", which is not a full commit SHA. A branch name, an abbreviation and a pull request number are routing facts rather than identity, so no result can be bound to it (mvp-spec 3, F20-AC3).`,
            fields: [
              {
                path: 'candidate.headSha',
                message: 'A result can only be bound to the full 40-character commit SHA the candidate recorded.',
              },
            ],
          },
        };
      }

      const target: GitHubProjectionTarget = {
        candidateId: command.candidateId,
        contractId: contract.id,
        contractRevision: contract.revision,
        headSha: candidate.headSha,
      };
      const observedAt = live.value.observedAt;
      // The commit the provider read was made for. It is the candidate's own head in the ordinary
      // case, and the two differ exactly when the pull request has been pushed on since the
      // candidate was recorded (F24-AC4).
      const liveHeadSha = live.value.live.headSha;
      const projection: GitHubCandidateProjection = {
        candidateId: command.candidateId,
        contractId: contract.id,
        contractRevision: contract.revision,
        headSha: candidate.headSha,
        checks: live.value.checks.map((check) => providerCheckFor(check, liveHeadSha, candidate.headSha)),
        observedAt,
      };

      // The verification package owns the provider vocabulary: which verdicts are not a pass, and
      // what an unattributable run records. Reused rather than restated, so a `skipped` verdict
      // cannot be recorded green here after being refused there (F20-AC2).
      const derived = recordGitHubProjection({
        projection,
        target,
        evidenceIdFor: (check) =>
          observationEvidenceId('github-check', {
            candidateId: command.candidateId,
            contractId: contract.id,
            contractRevision: String(contract.revision),
            checkId: check.checkId,
            status: check.status,
            headSha: check.headSha ?? '',
            observedAt: check.completedAt ?? check.startedAt ?? '',
          }),
      });
      if (!derived.ok) return derived;

      const recorded: MvpRecordedObservationReport[] = [];
      for (const evidence of derived.value) {
        const observation = providerObservationOf(evidence);
        if (observation === null) {
          return {
            ok: false,
            error: {
              code: 'Unavailable',
              reason: `Derived evidence ${evidence.evidenceId} came back from source "${evidence.source}", which this automated path cannot state. Nothing further was recorded, because a result whose source cannot be named cannot be reviewed (F20-AC2).`,
            },
          };
        }
        const written = await useCases.recordEvidence({
          projectId: command.projectId,
          requestId: facts.value.facts.request.id,
          candidateId: command.candidateId,
          expectedHeadSha: candidate.headSha,
          expectedContractRevision: contract.revision,
          facts: facts.value.facts,
          evidenceId: evidence.evidenceId,
          subject: evidence.subject,
          method: evidence.method,
          observation,
          // An automated observation records no owner, so there is no owner identity for one to
          // borrow (F25-AC4).
          owner: null,
          observedHeadSha: evidence.observedHeadSha,
          observedContractRevision: evidence.observedContractRevision,
          observedAt: evidence.observedAt,
          detail: evidence.detail,
          artifactRef: evidence.artifactRef,
          correlationId: command.correlationId,
        });
        if (!written.ok) return written;
        recorded.push(observationReport(evidence, written.value, evidence.subject));
      }

      // The card is projected once, after the last write, so what the caller receives describes
      // every row this call produced rather than a state part way through them (F24-AC2).
      const final = await useCases.review({
        projectId: command.projectId,
        requestId: facts.value.facts.request.id,
        candidateId: command.candidateId,
        expectedHeadSha: candidate.headSha,
        expectedContractRevision: contract.revision,
        facts: facts.value.facts,
      });
      if (!final.ok) return final;

      return {
        ok: true,
        value: {
          projectId: command.projectId,
          candidateId: command.candidateId,
          candidateHeadSha: candidate.headSha,
          // The commit the pull request holds right now, reported next to the bound head rather
          // than substituted for it: a difference is the finding, not a nuisance (F20-AC3).
          providerHeadSha: liveHeadSha,
          contractId: contract.id,
          contractRevision: contract.revision,
          method: 'github_checks',
          observedAt,
          recorded,
          review: toCard(final.value, facts.value, deps.clock.now()),
        },
      };
    },

    /**
     * Records the owner's own test outcome for one criterion.
     *
     * Owner-only, narrowed before the candidate is read so a refused caller learns nothing about
     * it, and stamped with the controller's clock rather than a value from the request so it can
     * be neither backdated nor attributed to somebody else (F01-AC1, F25-AC4).
     *
     * The criterion must be one the current revision declares `owner_test`; that check is the
     * domain's rather than this module's, and the refusal names the criterion (F23-AC1). The commit
     * is the stored candidate's, which is what makes an earlier observation history instead of a
     * verdict on the candidate on screen (F24-AC4, F25-AC3).
     */
    recordOwnerTest: async (
      command: RecordMvpOwnerTestCommand,
    ): Promise<Result<MvpOwnerTestReport, DomainError>> => {
      const owner = requireMvpOwner(command.actor, 'Recording an owner test outcome');
      if (!owner.ok) return owner;

      const facts = readFacts(deps, command);
      if (!facts.ok) return facts;

      const approved = approvedRevisionOf(facts.value.contract);
      if (!approved.ok) return approved;

      const contract = facts.value.facts.contract;
      const candidate = facts.value.facts.candidate;
      const observedAt = deps.clock.now();
      const evidenceId = observationEvidenceId('owner-test', {
        candidateId: command.candidateId,
        contractId: contract.id,
        contractRevision: String(contract.revision),
        criterionId: command.criterionId,
        outcome: command.outcome,
        observedAt,
      });

      const recorded = await useCases.recordOwnerTest({
        projectId: command.projectId,
        requestId: facts.value.facts.request.id,
        candidateId: command.candidateId,
        expectedHeadSha: candidate.headSha,
        expectedContractRevision: contract.revision,
        facts: facts.value.facts,
        actor: command.actor,
        criterionId: command.criterionId,
        outcome: command.outcome,
        evidenceId,
        observedAt,
        detail: command.note,
        artifactRef: null,
        correlationId: command.correlationId,
      });
      if (!recorded.ok) return recorded;

      return {
        ok: true,
        value: {
          projectId: command.projectId,
          candidateId: command.candidateId,
          candidateHeadSha: candidate.headSha,
          contractId: contract.id,
          contractRevision: contract.revision,
          criterionId: command.criterionId,
          outcome: command.outcome,
          evidenceId,
          observedAt,
          note: command.note,
          review: toCard(recorded.value, facts.value, deps.clock.now()),
        },
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Evidence derivation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The refusal an evidence write against a revision nobody approved earns.
 *
 * Checked here rather than left to the projection because the projection runs *after* the write:
 * an evidence row recorded against a draft revision would be durable, and the refusal that
 * followed would read as "this observation could not be read" rather than "this observation was
 * never made" (F24-AC4, F25-AC1).
 */
function approvedRevisionOf(contract: DeliveryContract): Result<true, DomainError> {
  if (contract.status === 'approved') return { ok: true, value: true };
  return {
    ok: false,
    error: {
      code: 'Invalid',
      reason: `Contract ${contract.contractId} revision ${contract.revision} is ${contract.status}, so a candidate is neither verified nor tested against it. Approve the revision first (F24-AC4).`,
      fields: [
        {
          path: 'contract.status',
          message: 'A candidate is only verified against an approved contract revision.',
        },
      ],
    },
  };
}

/**
 * One provider check, in the vocabulary `recordGitHubProjection` consumes.
 *
 * `status` is the provider's verdict translated, never normalised into a pass: `Missing` and
 * `NotApplicable` become `skipped` and `Stale` becomes `neutral`, all three of which the
 * verification package maps to `missing`. A check that did not run therefore cannot be recorded as
 * one that passed, however this function is edited (F20-AC2).
 *
 * `headSha` is the commit this observation is about, and this is where an observation stops being
 * about this candidate. See `attributableTo` for what it is derived from and why.
 */
function providerCheckFor(
  check: CandidateCheckStatus,
  liveHeadSha: string,
  candidateHeadSha: string,
): GitHubCheckProjection {
  const attributable = attributableTo(check, liveHeadSha, candidateHeadSha);
  return {
    checkId: check.name,
    name: check.name,
    status: providerStatusOf(check.result),
    // The commit this observation is attributed to, and the one thing that decides whether
    // `recordGitHubProjection` binds it. An observation that is not about this candidate must not
    // name this candidate's head, or the binding would be asserted by the very field meant to
    // carry it (F20-AC3).
    headSha: attributable ? candidateHeadSha : unattributedHeadOf(check, liveHeadSha, candidateHeadSha),
    startedAt: check.startedAt,
    completedAt: check.endedAt,
    detailUrl: check.artifactUrl,
    summary: check.detail,
  };
}

/**
 * The commit an observation that is not about this candidate names, or null.
 *
 * `recordGitHubProjection` records a check unbound when its `headSha` is not the target's or is
 * absent, so this returns anything other than the candidate's head. The candidate module's live
 * head is used when it differs, because that names which build the read was actually made for and
 * is the more useful thing for a reader to see. When the live head *is* the candidate's - the
 * ordinary case for a `Stale` result, which exists precisely because the run belonged to some
 * other commit - there is no other SHA available, so the observation names none and the
 * verification package's own summary says why (F20-AC3).
 */
function unattributedHeadOf(
  check: CandidateCheckStatus,
  liveHeadSha: string,
  candidateHeadSha: string,
): string | null {
  if (check.observedHeadSha !== null) return check.observedHeadSha;
  return liveHeadSha === candidateHeadSha ? null : liveHeadSha;
}

/**
 * Whether an observation may be said to describe this candidate.
 *
 * Derived from two facts and not from a third one that does not exist. The shipped
 * `ProviderCheckObservation` carries no per-check commit - the git adapter resolves a check
 * reported for another commit into `result: 'Stale'` and says which commit in its detail rather
 * than in a field - so there is no SHA here to compare. What there *is* is the candidate module's
 * own verdict, which this path is bound to respect rather than second-guess:
 *
 *   - **`Stale` is never attributable.** That result exists for exactly one reason: the provider
 *     ran the check for a different commit. A green base-branch result must not approve this
 *     candidate, and the adapter already decided it does not (F20-AC3, F24-AC4).
 *   - **The live head must be the candidate's head.** The provider read was made for the commit the
 *     candidate module holds; if that is not the commit under review, every check it returned
 *     belongs to a build this pass is not verifying, and attributing them would be the F20-AC3 bug
 *     from the other direction.
 *   - **`Missing` and `NotApplicable` are attributable on the same terms as a verdict.** A check
 *     the project requires and the provider never ran *was* observed for this candidate: the read
 *     asked about this head and the answer was "nothing". Binding it is what makes the card say
 *     `missing` rather than `stale`, and neither state is a pass (F20-AC2).
 *
 * A `Stale` result that also had an attributable SHA would still be refused here, because the
 * adapter's staleness verdict and a comparison could only disagree if one of them were wrong, and
 * the one that has read the provider is the adapter.
 */
function attributableTo(
  check: CandidateCheckStatus,
  liveHeadSha: string,
  candidateHeadSha: string,
): boolean {
  if (liveHeadSha !== candidateHeadSha) return false;
  return check.result !== 'Stale';
}

/**
 * A provider verdict in the five the projection accepts.
 *
 * Total over the domain's six states, so widening `CHECK_RESULTS` fails to compile here rather
 * than defaulting a new state onto a pass (F20-AC2).
 */
function providerStatusOf(result: CheckResult): GitHubCheckProjection['status'] {
  switch (result) {
    case 'Passed':
      return 'success';
    case 'Failed':
      return 'failure';
    case 'Waiting':
      return 'pending';
    case 'Missing':
    case 'NotApplicable':
      return 'skipped';
    case 'Stale':
      return 'neutral';
  }
}

/**
 * The observation a derived provider row states, or null when its source is not this path's.
 *
 * Reconstructed from the row's own `source` rather than assumed, so a mapping that started
 * producing another source is refused instead of being relabelled as a provider check. The
 * `capture_failed` degradation mirrors the store's own read path: an automated row has no such
 * outcome, so one can be neither a fabricated capture failure nor a fabricated behaviour failure
 * (F23-AC5).
 */
function providerObservationOf(evidence: MvpRecordedEvidence): MvpEvidenceObservation | null {
  if (evidence.source !== 'github_check') return null;
  return {
    kind: 'provider_check',
    outcome: evidence.outcome === 'capture_failed' ? 'missing' : evidence.outcome,
  };
}

/**
 * One recorded observation, as the write and the projection together produced it.
 *
 * Both outcomes travel for the reason the card carries both: `recordedOutcome` is what the provider
 * said and never changes, while `currentOutcome` and `countsForCurrentCandidate` answer "may this
 * be shown as this candidate's result". A client handed only the first would render a stale pass in
 * green (F20-AC3, F24-AC3).
 */
function observationReport(
  evidence: MvpRecordedEvidence,
  model: MvpReviewReadModel,
  subject: MvpRecordedEvidence['subject'],
): MvpRecordedObservationReport {
  const row = model.evidence.find((entry) => entry.evidenceId === evidence.evidenceId);
  return {
    evidenceId: evidence.evidenceId,
    // A provider result always speaks for a check, and this path records no other source. The
    // fallback keeps the report total rather than reaching for an identifier that does not exist.
    checkId: subject.kind === 'check' ? subject.checkId : '',
    recordedOutcome: evidence.outcome,
    currentOutcome: row?.currentOutcome ?? 'stale',
    countsForCurrentCandidate: row?.appliesToCurrentCandidate ?? false,
    observedHeadSha: evidence.observedHeadSha,
    observedContractRevision: evidence.observedContractRevision,
    observedAt: evidence.observedAt,
    reason:
      row?.reason ??
      'The stored row could not be read back as an observation of this candidate, so it is reported as counting for nothing (F20-AC3).',
  };
}

/**
 * A stable identity for one observation.
 *
 * Content-addressed over the facts that make two observations the same observation, because the
 * evidence table is append-only with a conflict-no-op primary key: an identity derived from the
 * candidate alone would make a re-run *after CI finished* a no-op, and the card would keep
 * reporting the earlier "still running" verdict forever. The read instant is deliberately absent
 * from the provider variant and present in the owner variant - a check run reports its own
 * timestamps, while an owner test has only the clock, so including it there is what tells two
 * clicks apart from one (F20-AC3).
 */
function observationEvidenceId(prefix: string, parts: Readonly<Record<string, string>>): string {
  // `JSON.stringify` over the sorted members rather than a joined string, so a value containing a
  // delimiter cannot forge a different pair's identity by containing the delimiter itself.
  const canonical = JSON.stringify(
    Object.keys(parts)
      .sort()
      .map((key) => [key, parts[key] ?? '']),
  );
  return `mvp-${prefix}-${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

/** Bounds a value quoted in a refusal, so an unreadable stored string is not echoed whole. */
function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}
