/**
 * Manual GitHub pull-request linking and candidate refresh (SHARED.md, MVP journey).
 *
 * The MVP journey is `Request → Delivery Contract → External execution → GitHub Candidate
 * → Verification → Owner Decision`. This module owns the fourth step and the read that keeps
 * it honest. Three design choices carry the weight, and each exists because of a specific
 * wrong answer it makes unreachable.
 *
 * **1. There is exactly one currency read, and it always talks to the provider.**
 * `readCandidate` is the only way to obtain a candidate's current facts, and it reads the
 * pull request *and* its checks before answering. There is no "read from the database" path
 * that answers a review question, because either one would be a call a review screen could
 * make and get an answer from without observing anything. An owner looking at a card is
 * therefore always looking at a read, never at a cache that happened to agree with the last
 * one — and a provider that stops answering produces a failure rather than a stale card
 * dressed as a current one (mvp-spec F24-AC4).
 *
 * **2. A changed head is a new candidate, and the old one stops being current.**
 * When the live facts differ from the recorded ones a new candidate row is appended and the
 * previous one is no longer what `readCandidate` returns. Nothing about the old candidate is
 * edited: it stays readable, because that is what lets evidence collected for SHA A keep
 * meaning "evidence about SHA A". `priorEvidenceStale` is the flag the verification layer
 * consumes and `previousHeadSha` names the commit stale evidence would be about. A view
 * cannot silently carry a ready status across a force push, because readiness is derived from
 * `live` on every read and from nothing stored.
 *
 * **3. The Git port has two methods and both are reads.**
 * `CandidateGitPort` is `CandidateLinkReader & CandidateCheckReader` — no `mergePullRequest`,
 * no `pushBranch`, no protection read, nothing to call. ShipLoop v0.1 links a pull request an
 * external workflow created and then observes it; merging, closing, approving and deploying are
 * outside the product, and the way that is expressed here is that this module holds no method
 * through which any of them could happen (SHARED.md, "Explicitly out of scope").
 *
 * Three refusals are load-bearing rather than incidental:
 *
 * - a pasted address must name the project's *configured* repository, taken from one injected
 *   source rather than from the URL and a second parameter that could disagree;
 * - the pull request's head must live in that repository too. A fork's pull request is refused
 *   with a stated reason rather than linked, because its commits were never in the project and
 *   attributing them to it would be a false record of who wrote the code;
 * - a pull request that is already closed or merged cannot be linked at all, and one that
 *   closes after linking stops being reviewable while remaining readable as history. Both
 *   states are recorded faithfully rather than normalised to "open".
 *
 * Readiness is reported as two answers because it is two questions. `checksReady` is about
 * provider check results alone; `reviewReadiness` is about whether *this* candidate can be
 * decided on at all — open, not a draft, and every required check satisfied. Collapsing them
 * would let a candidate with green checks and a closed pull request report itself ready.
 */

import {
  CANDIDATE_PROVIDER,
  candidateBindingFingerprint,
  candidateBindingOf,
  candidateChecksReady,
  blockingRequiredChecks,
  detectCandidateChange,
  err,
  invalid,
  isCommitSha,
  ok,
  parseGitHubPullRequestUrl,
  projectCandidateChecks,
  sameGitHubRepository,
} from '@shiploop/domain';
import type {
  CandidateBinding,
  CandidateChange,
  CandidateCheckStatus,
  CandidateFacts,
  CandidateId,
  CommitSha,
  DeliveryCandidate,
  DomainError,
  Fingerprint,
  ProjectId,
  ProviderCheckFact,
  PullRequestState,
  Result,
} from '@shiploop/domain';
import type { AdapterContext, CandidateGitPort, GitRepositoryRef, ProviderCheckObservation } from '@shiploop/adapters';
import type { CandidateLinkStore, DeliveryCandidateRecord } from '@shiploop/storage';

import type { ControllerClock, OwnerActor } from './profiles.ts';

/* -------------------------------------------------------------------------- */
/* Inputs and outputs                                                          */
/* -------------------------------------------------------------------------- */

/** The facts a live read returned, including the parts a change comparison does not use. */
export interface LiveCandidateFacts extends CandidateFacts {
  readonly providerPullRequestId: string;
  readonly pullRequestUrl: string;
  /** Repository the head branch lives in; a fork's name for a pull request from a fork. */
  readonly headRepository: string | null;
  readonly observedAt: string;
}

/**
 * Whether this candidate can be decided on right now, and why not when it cannot.
 *
 * A list rather than a boolean, because every reason here is something the owner can act on
 * — reopen the pull request, wait for a check, accept the head that is actually there — and a
 * bare "not ready" cannot be acted on.
 */
export interface ReviewReadiness {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

/**
 * Everything a caller needs about the current candidate, from one live read.
 *
 * `candidate` and `live` are both present on purpose. `candidate` is what ShipLoop recorded
 * and will keep as history; `live` is what GitHub said during this read. They are equal when
 * nothing moved, and `change` says exactly which of them differs — so a consumer never has to
 * recompute the difference, and therefore never has an excuse to forget to.
 */
export interface CandidateView {
  /** The recorded candidate that is current for this request. */
  readonly candidate: DeliveryCandidate;
  /** What the provider reported during this read. */
  readonly live: LiveCandidateFacts;
  /** The `(contract id, contract revision, head SHA)` triple evidence must name. */
  readonly binding: CandidateBinding;
  /** A stable value for that triple, comparable with `===`. */
  readonly bindingFingerprint: Fingerprint;
  readonly change: CandidateChange;
  /**
   * True when a material fact moved during this read.
   *
   * The verification layer's signal: while this is true, no evidence recorded before this read
   * proves `live.headSha`. It is true for a moved head *and* for a closed pull request or a
   * retargeted base, because all three change what the owner would be approving.
   */
  readonly priorEvidenceStale: boolean;
  /** The candidate the record pointed at before this read, when one existed. */
  readonly previousCandidateId: CandidateId | null;
  /** The head `previousCandidateId` named: what stale evidence would be about. */
  readonly previousHeadSha: CommitSha | null;
  /** Every candidate recorded for this request other than the current one, oldest first. */
  readonly supersededCandidates: readonly CandidateId[];
  readonly checks: readonly CandidateCheckStatus[];
  /** Whether every required check is satisfied. About checks only. */
  readonly checksReady: boolean;
  /** The required checks that are not satisfied, named. */
  readonly blockingChecks: readonly string[];
  readonly reviewReadiness: ReviewReadiness;
  /** When the provider was read for this view. */
  readonly observedAt: string;
}

/** Linking a pull request the owner named. */
export interface LinkPullRequestInput {
  readonly actor: OwnerActor;
  readonly projectId: ProjectId;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  /** The address the owner pasted. */
  readonly pullRequestUrl: string;
  /**
   * The branch the project expects a candidate to land on.
   *
   * Null when the caller has no expectation to enforce. When supplied, a pull request
   * targeting a different branch is refused rather than linked, because a diff against an
   * unexpected base is not the diff the project asked to review.
   */
  readonly expectedBaseBranch: string | null;
  readonly correlationId: string;
}

/**
 * What a successful link established.
 *
 * Deliberately carries no readiness answer. A link is a fact about identity, and a shape with
 * no `checksReady` field cannot be read as "ready" by a caller that has not read the checks.
 */
export interface LinkedCandidate {
  readonly candidate: DeliveryCandidate;
  readonly live: LiveCandidateFacts;
  readonly binding: CandidateBinding;
  readonly bindingFingerprint: Fingerprint;
  /** True when this exact identity was already recorded, so nothing was appended. */
  readonly alreadyRecorded: boolean;
  readonly observedAt: string;
}

/** Reading the current candidate for a request. */
export interface ReadCandidateInput {
  readonly actor: OwnerActor;
  readonly projectId: ProjectId;
  readonly requestId: string;
  readonly correlationId: string;
}

/** Looking a candidate up by the binding recorded evidence carries. */
export interface CandidateForBindingInput {
  readonly contractId: string;
  readonly contractRevision: number;
  /** A full 40-character commit SHA. An abbreviation is refused, not resolved. */
  readonly headSha: string;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

export interface CandidateLinkDeps {
  readonly clock: ControllerClock;
  readonly candidates: CandidateLinkStore;
  /**
   * The read-only Git port.
   *
   * Typed as `CandidateGitPort`, which has `readLinkedPullRequest` and `readChecks` and nothing
   * else. A full `GitAdapter` satisfies it structurally, so the composition root can pass the
   * shipped adapter — but this module receives the narrowed object, and there is no merge, push,
   * close, approve or protection method on the type it holds.
   */
  readonly git: CandidateGitPort;
  /**
   * The GitHub repository this project is configured with.
   *
   * One source of truth for "the project's repository", used both to compare the pasted address
   * against and to address the check read. Taking it from the profile rather than from a
   * parameter is what stops a caller passing the repository it wants compared against.
   */
  readonly repositoryRef: (projectId: ProjectId) => Result<GitRepositoryRef, DomainError>;
  /**
   * The check names the project profile requires.
   *
   * A function rather than a list because the profile is versioned and this module must not cache
   * a requirement: a name the profile no longer requires has to stop blocking, and one it newly
   * requires has to start. A required name the provider does not report is `Missing`, never
   * `Passed` (mvp-spec F20-AC2).
   */
  readonly requiredCheckNames: (projectId: ProjectId) => Result<readonly string[], DomainError>;
  /** Candidate identity, injected so a recorded run replays identically. */
  readonly newCandidateId: () => CandidateId;
  /** Redaction applied to provider text before it reaches a stored row (N02-AC2). */
  readonly redactProviderText?: (text: string) => string;
}

export interface CandidateLinkUseCases {
  /** Links the pull request the owner named, after validating it against the project. */
  readonly linkPullRequest: (input: LinkPullRequestInput) => Promise<Result<LinkedCandidate, DomainError>>;
  /** The one currency read: live pull-request facts plus the checks for the live head. */
  readonly readCandidate: (input: ReadCandidateInput) => Promise<Result<CandidateView, DomainError>>;
  /**
   * The recorded candidate for a request, with no provider call.
   *
   * Exists for a caller that needs the binding to *name* in a decision or an evidence row, not
   * to review. It makes no currency claim, and `readCandidate` is the read that does.
   */
  readonly recordedCandidate: (requestId: string) => Result<DeliveryCandidate | null, DomainError>;
  /** Every candidate recorded for a request, oldest first, each naming the head it was for. */
  readonly candidateHistory: (requestId: string) => Result<readonly DeliveryCandidate[], DomainError>;
  /**
   * The candidate recorded for one `(contract revision, head SHA)` binding, or null.
   *
   * This is how the verification layer asks "does a candidate still exist for what this evidence
   * was collected against?", which is the question that turns a superseded candidate's green
   * checks into `Stale` rather than into a pass.
   */
  readonly candidateForBinding: (input: CandidateForBindingInput) => Result<DeliveryCandidate | null, DomainError>;
}

/**
 * Builds the candidate-linking use cases.
 *
 * `clock` and `newCandidateId` are injected, so a decision recorded in a test replays identically
 * and nothing here constructs a provider client or reads ambient time.
 */
export function createCandidateLinkUseCases(deps: CandidateLinkDeps): CandidateLinkUseCases {
  const providerText = deps.redactProviderText ?? ((text: string): string => text);

  /**
   * The ambient context every provider call receives.
   *
   * A stable operation identity per read, because a read that fails still has to be attributable
   * in a log, and `correlationId` is the caller's.
   */
  const contextFor = (operationId: string, correlationId: string): AdapterContext => ({
    correlationId,
    operationId: operationId as AdapterContext['operationId'],
    clock: { now: () => deps.clock.now(), elapsedMs: () => 0 },
    logger: { emit: () => undefined },
    signal: new AbortController().signal,
    redact: providerText,
  });

  const requireOwner = (actor: OwnerActor): Result<true, DomainError> =>
    actor.role === 'Owner'
      ? ok(true)
      : err({
          code: 'Forbidden',
          reason: `Linking and reading a candidate is an owner action; the ${actor.role} role may not (SHARED.md, MVP journey).`,
        });

  /* ------------------------------------------------------------------ */
  /* Linking                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Links the pull request the owner named.
   *
   * The order is the order of the questions being asked, and each refusal answers a different
   * one:
   *
   *   1. may this actor link a candidate at all?
   *   2. does the link name a request and a contract revision?
   *   3. is the pasted address a GitHub pull request?
   *   4. does it name *this project's* configured repository?
   *   5. does the pull request exist, and can the credential read it?
   *   6. does its head live in the project's repository rather than in a fork?
   *   7. does it target the branch the project expects?
   *   8. is it still open?
   *   9. does GitHub report two full commit SHAs for it?
   *
   * Only after all nine is a candidate written. Nothing is written on any refusal, so a rejected
   * paste leaves no half-linked candidate behind.
   */
  const linkPullRequest = async (input: LinkPullRequestInput): Promise<Result<LinkedCandidate, DomainError>> => {
    const permitted = requireOwner(input.actor);
    if (!permitted.ok) return err(permitted.error);

    const fields: { path: string; message: string }[] = [];
    if (input.requestId.trim().length === 0) {
      fields.push({ path: 'requestId', message: 'An empty id is not a request. A candidate belongs to one.' });
    }
    if (input.contractId.trim().length === 0) {
      fields.push({
        path: 'contractId',
        message: 'A candidate is bound to the contract revision it implements, so it needs a contract.',
      });
    }
    if (!Number.isSafeInteger(input.contractRevision) || input.contractRevision < 1) {
      fields.push({ path: 'contractRevision', message: 'Contract revisions start at 1.' });
    }
    if (fields.length > 0) {
      return err(invalid('A candidate cannot be linked to nothing.', fields));
    }

    const repository = deps.repositoryRef(input.projectId);
    if (!repository.ok) return err(repository.error);
    if (repository.value.provider !== CANDIDATE_PROVIDER) {
      return err({
        code: 'Forbidden',
        reason: `This project is configured for provider "${repository.value.provider}", not GitHub. ShipLoop v0.1 links GitHub pull requests only (SHARED.md, out of scope).`,
      });
    }

    const parsed = parseGitHubPullRequestUrl(input.pullRequestUrl);
    if (!parsed.ok) return err(parsed.error);

    // The pasted address and the configured repository are two independent claims, and the
    // comparison is the whole check: a similarly named repository, a fork and another
    // provider's copy of the same name all fail here.
    if (!sameGitHubRepository(parsed.value.fullName, repository.value.fullName)) {
      return err(
        invalid('That pull request belongs to a different repository than this project.', [
          {
            path: 'pullRequestUrl',
            message: `The address names ${parsed.value.fullName}, but this project is configured for ${repository.value.fullName}. A repository of the same name elsewhere is not this project.`,
          },
        ]),
      );
    }

    const live = await readLivePullRequest(
      repository.value,
      parsed.value.number,
      input.correlationId,
      `link-${parsed.value.fullName}-${parsed.value.number}`,
    );
    if (!live.ok) return live;

    const head = requireFullSha(live.value.headSha, 'head SHA');
    if (!head.ok) return err(head.error);
    const base = requireFullSha(live.value.baseSha, 'base SHA');
    if (!base.ok) return err(base.error);

    if (live.value.headRepository !== null && !sameGitHubRepository(live.value.headRepository, live.value.repository)) {
      return err({
        code: 'Blocked',
        reason: `GitHub reports the head of ${live.value.repository}#${live.value.pullRequestNumber} in ${live.value.headRepository}, not in this project. The commits it proposes were never in ${live.value.repository}, so linking it would attribute someone else's code to this project.`,
        prerequisites: [
          {
            name: 'HeadOutsideProjectRepository',
            detail: `head repository ${live.value.headRepository}`,
            remedy: `Open the pull request from a branch of ${live.value.repository}, or point this project at ${live.value.headRepository}. Nothing was linked and no state changed.`,
          },
        ],
      });
    }

    if (input.expectedBaseBranch !== null && live.value.baseBranch !== input.expectedBaseBranch) {
      return err({
        code: 'Blocked',
        reason: `${live.value.repository}#${live.value.pullRequestNumber} targets "${live.value.baseBranch}", but this project expects candidates to land on "${input.expectedBaseBranch}". A diff against an unexpected base is not the change this project asked to review.`,
        prerequisites: [
          {
            name: 'UnexpectedBaseBranch',
            detail: `base branch ${live.value.baseBranch}`,
            remedy: `Retarget the pull request to "${input.expectedBaseBranch}" on GitHub, or change the project's base branch. Nothing was linked.`,
          },
        ],
      });
    }

    if (live.value.pullRequestState !== 'Open') {
      return err({
        code: 'Blocked',
        reason: `${live.value.repository}#${live.value.pullRequestNumber} is ${live.value.pullRequestState}, so there is no open change to link as a candidate. ${stateRemedy(live.value.pullRequestState)}`,
        prerequisites: [
          {
            name: 'PullRequestNotOpen',
            detail: `state ${live.value.pullRequestState}`,
            remedy: stateRemedy(live.value.pullRequestState),
          },
        ],
      });
    }

    const recorded = deps.candidates.record({
      candidateId: deps.newCandidateId(),
      projectId: input.projectId,
      requestId: input.requestId,
      contractId: input.contractId,
      contractRevision: input.contractRevision,
      provider: CANDIDATE_PROVIDER,
      repository: live.value.repository,
      pullRequestNumber: live.value.pullRequestNumber,
      pullRequestUrl: live.value.pullRequestUrl,
      baseBranch: live.value.baseBranch,
      baseSha: base.value,
      headBranch: live.value.headBranch,
      headSha: head.value,
      headRepository: live.value.headRepository,
      pullRequestState: live.value.pullRequestState,
      draft: live.value.draft,
      observedAt: live.value.observedAt,
      correlationId: input.correlationId,
    });
    if (!recorded.ok) return err(recorded.error);

    const candidate = toDeliveryCandidate(recorded.value.candidate);
    const binding = candidateBindingOf(candidate);
    return ok({
      candidate,
      live: live.value,
      binding,
      bindingFingerprint: candidateBindingFingerprint(binding),
      alreadyRecorded: recorded.value.alreadyRecorded,
      observedAt: live.value.observedAt,
    });
  };

  /* ------------------------------------------------------------------ */
  /* Reading                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Reads the current candidate for a request, live, and reports what moved.
   *
   * There is no other currency read on purpose (see the module header). The steps:
   *
   *   1. may this actor read a candidate at all?
   *   2. is there a recorded candidate for this request *in this project*?
   *   3. what does the provider say now — one payload, so head and base are consistent?
   *   4. what moved since the record, and does that make prior evidence stale?
   *   5. if something material moved, append a new candidate so the record follows the
   *      provider, never by editing the previous row;
   *   6. read the checks for the *live* head and project them, so readiness is derived from
   *      this read and from nothing stored;
   *   7. answer both readiness questions.
   *
   * A provider failure at step 3 or 6 returns that failure. It never falls back to the stored
   * row, because a card served from a stale record after the provider stopped answering is
   * precisely the failure this read path exists to prevent.
   */
  const readCandidate = async (input: ReadCandidateInput): Promise<Result<CandidateView, DomainError>> => {
    const permitted = requireOwner(input.actor);
    if (!permitted.ok) return err(permitted.error);

    const current = deps.candidates.currentForRequest(input.requestId);
    if (!current.ok) return err(current.error);
    if (current.value === null) {
      return err({
        code: 'NotFound',
        reason: `Request ${input.requestId} has no linked candidate. Link a pull request before reading one.`,
      });
    }
    // The project is part of the question, not a filter applied afterwards: a candidate
    // belonging to another project must not be readable through this project's session.
    if (current.value.projectId !== input.projectId) {
      return err({
        code: 'NotFound',
        reason: `Request ${input.requestId} has no linked candidate in this project.`,
      });
    }
    const stored = current.value;

    const repository = deps.repositoryRef(input.projectId);
    if (!repository.ok) return err(repository.error);

    const live = await readLivePullRequest(
      repository.value,
      stored.pullRequestNumber,
      input.correlationId,
      `read-${stored.pullRequestNumber}`,
    );
    if (!live.ok) return live;

    const head = requireFullSha(live.value.headSha, 'head SHA');
    if (!head.ok) return err(head.error);
    const base = requireFullSha(live.value.baseSha, 'base SHA');
    if (!base.ok) return err(base.error);

    const change = detectCandidateChange(factsOf(stored), factsOfLive(live.value));

    // A moved head is a new candidate, appended. The previous row is left exactly as it was so
    // the evidence naming it stays meaningful, and `currentForRequest` stops returning it
    // because the new row carries the higher sequence.
    const effective = change.changedAnything
      ? appendCandidate(stored, live.value, base.value, input.correlationId)
      : ok(stored);
    if (!effective.ok) return effective;
    const record = effective.value;
    const candidate = toDeliveryCandidate(record);
    const binding = candidateBindingOf(candidate);
    const fingerprint = candidateBindingFingerprint(binding);

    const checks = await readCandidateChecks(
      repository.value,
      record,
      base.value,
      fingerprint,
      input.correlationId,
    );
    if (!checks.ok) return err(checks.error);

    const history = deps.candidates.historyForRequest(input.requestId);
    if (!history.ok) return err(history.error);

    return ok({
      candidate,
      live: live.value,
      binding,
      bindingFingerprint: fingerprint,
      change,
      priorEvidenceStale: change.priorEvidenceStale,
      previousCandidateId: change.changedAnything ? stored.candidateId : null,
      previousHeadSha: change.changedAnything ? stored.headSha : null,
      supersededCandidates: history.value
        .map((entry) => entry.candidateId)
        .filter((candidateId) => candidateId !== candidate.candidateId),
      checks: checks.value,
      checksReady: candidateChecksReady(checks.value),
      blockingChecks: blockingRequiredChecks(checks.value),
      reviewReadiness: readinessOf(live.value, checks.value),
      observedAt: live.value.observedAt,
    });
  };

  /**
   * Appends the candidate the live read established.
   *
   * Split out of `readCandidate` because it is the one place a read writes, and a reader looking
   * for the second write in this module should find one function rather than a condition inside
   * the read.
   */
  const appendCandidate = (
    stored: DeliveryCandidateRecord,
    live: LiveCandidateFacts,
    baseSha: CommitSha,
    correlationId: string,
  ): Result<DeliveryCandidateRecord, DomainError> => {
    const recorded = deps.candidates.record({
      candidateId: deps.newCandidateId(),
      projectId: stored.projectId,
      requestId: stored.requestId,
      contractId: stored.contractId,
      contractRevision: stored.contractRevision,
      provider: CANDIDATE_PROVIDER,
      repository: live.repository,
      pullRequestNumber: live.pullRequestNumber,
      pullRequestUrl: live.pullRequestUrl,
      baseBranch: live.baseBranch,
      baseSha,
      headBranch: live.headBranch,
      headSha: live.headSha,
      headRepository: live.headRepository,
      pullRequestState: live.pullRequestState,
      draft: live.draft,
      observedAt: live.observedAt,
      correlationId,
    });
    if (!recorded.ok) return err(recorded.error);
    return ok(recorded.value.candidate);
  };

  /**
   * Reads and projects the checks for the live head.
   *
   * Asked for the head the provider holds *now*, not the head the record held, because a green
   * result for a superseded commit is not a result for this candidate. The projection turns
   * anything the adapter could not attribute to this head into `Stale` and adds a required check
   * the provider never ran as `Missing`.
   *
   * The candidate fingerprint sent to the adapter is the binding fingerprint, so the check
   * results this call returns are attributable to exactly the identity the view reports.
   */
  const readCandidateChecks = async (
    repository: GitRepositoryRef,
    record: DeliveryCandidateRecord,
    baseSha: CommitSha,
    fingerprint: Fingerprint,
    correlationId: string,
  ): Promise<Result<readonly CandidateCheckStatus[], DomainError>> => {
    const required = deps.requiredCheckNames(record.projectId);
    if (!required.ok) return err(required.error);
    const read = await deps.git.readChecks(contextFor(`checks-${fingerprint.slice(0, 16)}`, correlationId), {
      repository,
      headSha: record.headSha,
      baseSha,
      candidateFingerprint: fingerprint,
      requiredCheckNames: required.value,
    });
    if (!read.ok) return err(read.error);
    return ok(projectCandidateChecks(factsFrom(read.value, new Set(required.value)), record.headSha, required.value));
  };

  /** Reads one pull request from the provider and shapes it as live facts. */
  const readLivePullRequest = async (
    repository: GitRepositoryRef,
    pullRequestNumber: number,
    correlationId: string,
    operationSuffix: string,
  ): Promise<Result<LiveCandidateFacts, DomainError>> => {
    const read = await deps.git.readLinkedPullRequest(
      contextFor(`pull-${operationSuffix}`, correlationId),
      { repository, pullRequestNumber },
    );
    if (!read.ok) return err(read.error);
    const facts = read.value;
    return ok({
      provider: facts.repository.provider,
      repository: facts.repository.fullName,
      pullRequestNumber: facts.number,
      pullRequestUrl: facts.url,
      baseBranch: facts.baseBranch,
      baseSha: facts.baseSha,
      headBranch: facts.headBranch,
      headSha: facts.headSha,
      headRepository: facts.headRepository,
      pullRequestState: facts.state,
      draft: facts.draft,
      providerPullRequestId: facts.providerPullRequestId,
      observedAt: facts.observedAt,
    });
  };

  const recordedCandidate = (requestId: string): Result<DeliveryCandidate | null, DomainError> => {
    const found = deps.candidates.currentForRequest(requestId);
    if (!found.ok) return err(found.error);
    return ok(found.value === null ? null : toDeliveryCandidate(found.value));
  };

  const candidateHistory = (requestId: string): Result<readonly DeliveryCandidate[], DomainError> => {
    const history = deps.candidates.historyForRequest(requestId);
    if (!history.ok) return err(history.error);
    return ok(history.value.map(toDeliveryCandidate));
  };

  const candidateForBinding = (
    input: CandidateForBindingInput,
  ): Result<DeliveryCandidate | null, DomainError> => {
    // Refuse an abbreviation rather than resolving it. A resolved prefix would answer "yes,
    // there is a candidate for this" about a commit the caller never named, which is the exact
    // substitution the full-SHA rule exists to prevent.
    const headSha = requireFullSha(input.headSha.trim(), 'headSha');
    if (!headSha.ok) return err(headSha.error);
    if (!Number.isSafeInteger(input.contractRevision) || input.contractRevision < 1) {
      return err(
        invalid('A candidate binding names a contract revision.', [
          { path: 'contractRevision', message: 'Contract revisions start at 1.' },
        ]),
      );
    }
    const found = deps.candidates.findByBinding(input.contractId, input.contractRevision, headSha.value);
    if (!found.ok) return err(found.error);
    return ok(found.value === null ? null : toDeliveryCandidate(found.value));
  };

  return { linkPullRequest, readCandidate, recordedCandidate, candidateHistory, candidateForBinding };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Whether the live pull request can be decided on, and the reasons when it cannot.
 *
 * Derived from `live` and from the checks read during this same read. Nothing here reads a
 * stored field, so a candidate that moved cannot keep a ready answer.
 */
function readinessOf(
  live: LiveCandidateFacts,
  checks: readonly CandidateCheckStatus[],
): ReviewReadiness {
  const reasons: string[] = [];
  if (live.pullRequestState !== 'Open') {
    reasons.push(`The pull request is ${live.pullRequestState}, so there is no open change to decide on.`);
  }
  if (live.draft) {
    reasons.push('The pull request is a draft, so its contents are not proposed for review yet.');
  }
  if (live.headRepository !== null && !sameGitHubRepository(live.headRepository, live.repository)) {
    reasons.push(`The head is in ${live.headRepository}, not in ${live.repository}.`);
  }
  reasons.push(...blockingRequiredChecks(checks));
  return reasons.length === 0 ? { ready: true, reasons: [] } : { ready: false, reasons };
}

function stateRemedy(state: PullRequestState): string {
  return state === 'Merged'
    ? 'The change has already landed, so there is nothing left to verify. Nothing was linked.'
    : 'Reopen the pull request on GitHub if the change is still meant to be reviewed. Nothing was linked.';
}

/**
 * Refuses a value that is not a full commit SHA.
 *
 * `Unavailable` rather than `Invalid`, because the value came from the provider rather than from
 * a caller: this is the adapter reporting something this module cannot represent, and the honest
 * answer is that the read failed rather than that the owner typed something wrong.
 */
function requireFullSha(value: string, field: string): Result<CommitSha, DomainError> {
  if (isCommitSha(value)) return ok(value);
  return err({
    code: 'Unavailable',
    reason: `GitHub reported a ${field} of "${value.slice(0, 12)}", which is not a full commit SHA. An abbreviated commit is refused rather than resolved, so nothing was recorded against it and no evidence can claim it.`,
  });
}

function factsOf(record: DeliveryCandidateRecord): CandidateFacts {
  return {
    provider: record.provider,
    repository: record.repository,
    pullRequestNumber: record.pullRequestNumber,
    baseBranch: record.baseBranch,
    baseSha: record.baseSha,
    headBranch: record.headBranch,
    headSha: record.headSha,
    pullRequestState: record.pullRequestState,
    draft: record.draft,
  };
}

function factsOfLive(live: LiveCandidateFacts): CandidateFacts {
  return {
    provider: live.provider,
    repository: live.repository,
    pullRequestNumber: live.pullRequestNumber,
    baseBranch: live.baseBranch,
    baseSha: live.baseSha,
    headBranch: live.headBranch,
    headSha: live.headSha,
    pullRequestState: live.pullRequestState,
    draft: live.draft,
  };
}

/**
 * Projects provider observations into the domain's check facts.
 *
 * `observedHeadSha` is left null because `ProviderCheckObservation` does not carry the commit an
 * observation belonged to: the read was already addressed to one head, and the adapter has
 * already demoted anything GitHub attributed to another commit. Inventing an attribution here
 * would either mark every check `Stale` or silently vouch for a revision the adapter never
 * confirmed — and `Stale` for everything would be as dishonest as `Passed` for everything.
 */
function factsFrom(
  observations: readonly ProviderCheckObservation[],
  required: ReadonlySet<string>,
): readonly ProviderCheckFact[] {
  return observations.map((observation) => ({
    name: observation.name,
    result: observation.result,
    required: observation.requirement === 'ProfileRequired' || required.has(observation.name),
    observedHeadSha: null,
    startedAt: observation.startedAt,
    endedAt: observation.endedAt,
    artifactUrl: observation.artifactUrl,
    detail: observation.detail,
  }));
}

/** Projects a stored row into the domain candidate, keeping both SHAs at full length. */
function toDeliveryCandidate(record: DeliveryCandidateRecord): DeliveryCandidate {
  return {
    candidateId: record.candidateId,
    projectId: record.projectId,
    requestId: record.requestId,
    contractId: record.contractId,
    contractRevision: record.contractRevision,
    provider: CANDIDATE_PROVIDER,
    repository: record.repository,
    pullRequestNumber: record.pullRequestNumber,
    pullRequestUrl: record.pullRequestUrl,
    baseBranch: record.baseBranch,
    baseSha: record.baseSha,
    headBranch: record.headBranch,
    headSha: record.headSha,
    pullRequestState: record.pullRequestState,
    draft: record.draft,
    observedAt: record.observedAt,
    linkedAt: record.linkedAt,
  };
}
