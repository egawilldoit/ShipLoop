/**
 * The home projection: what needs the owner, what ShipLoop has recorded as still moving,
 * and what is ready to be looked at (mvp-spec 3, MVP journey).
 *
 * This route adds no workflow. It holds no table, runs no state machine and asks nothing of
 * an external executor. Every entry it returns is a reading of a fact another layer already
 * recorded — a request and its contract revisions, a linked candidate, and the domain's own
 * review read model — and the only judgement here is *which group a recorded fact belongs
 * to*. That judgement is deliberately small and deliberately visible: the reasons it writes
 * are quoted from the projection that decided them, so a reader can always find the fact a
 * group membership was derived from.
 *
 * Three properties are structural rather than documented, and each exists because of a
 * specific wrong answer it makes unreachable:
 *
 *   - **Nothing here claims external execution progress.** `HomeEntry` has no field for a
 *     percentage, a start time, an elapsed duration or an executor status, because ShipLoop
 *     has no supported integration that proves any of them. `InProgress` therefore says
 *     what ShipLoop *recorded* — an approved revision with no candidate, a required check
 *     with no result against the current commit — and a state it cannot derive is omitted
 *     rather than approximated. The handoff packet records what was handed to an external
 *     executor; nothing on this route reads it back as a claim.
 *   - **Evidence bound to a superseded commit is not evidence.** Readiness, the outstanding
 *     criteria and staleness are read from `MvpReviewReadModel`, which the domain already
 *     computes from the `(contract revision, full SHA)` binding of every evidence row
 *     (F20-AC3). Nothing here recomputes eligibility, so this route cannot hold a second
 *     and drifting opinion about whether a candidate is reviewable.
 *   - **A group with nothing in it is empty.** There is no placeholder entry, no
 *     "nothing to do" row and no timestamp-derived filler, and a deployment that cannot
 *     read a candidate at all refuses rather than answering with three empty lists.
 *
 * What the board deliberately does not show: a candidate the owner has already accepted,
 * and one they have already asked for changes on. Both are finished with the owner, so
 * neither is outstanding owner action, neither is moving, and neither is awaiting a
 * review. Adding a fourth "Done" group would answer a question this projection was not
 * asked, and re-showing accepted work under `Ready For Review` would invite a second
 * decision on a candidate that already has one.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  fieldErrorsOf,
  fieldsProblem,
  parseBody,
  problemFor,
  sendProblem,
  signInRequiredProblem,
} from '../http-error.ts';
import type { ControllerSurface, RequestDetailView } from '../contracts.ts';
import type { DeliveryCandidate, DomainError, MvpReviewReadModel, OwnerId, Result } from '@shiploop/domain';
import type { SessionGuard } from '../auth-guard.ts';

/**
 * A project identity from the path.
 *
 * Bounded and refused on a path separator or `..`, matching `routes/contracts.ts` exactly:
 * the value addresses an artifact root, a workspace and a git checkout, so a traversal here
 * is a traversal there (F06-AC1). Repeated rather than imported because each route file in
 * this directory validates its own params, and a shared schema module would make a change
 * to this boundary a change to every other route's boundary too.
 */
const projectParams = z.strictObject({
  projectId: z
    .string()
    .trim()
    .min(1, 'A project id is required.')
    .max(128, 'A project id may be at most 128 characters.')
    .refine((value) => !/[/\\]/.test(value) && !value.includes('..'), 'A project id may not contain a path separator or "..".'),
});

/**
 * The closed vocabulary of reasons an entry can appear.
 *
 * A closed set rather than free text because each member is a state the projection can
 * prove from recorded facts, and a new member would be a new claim. Nothing here describes
 * an external system, so no member may ever name one.
 */
export const HOME_ENTRY_KINDS = [
  /** A request with no delivery contract at all, so there is nothing to implement against. */
  'ContractNotWritten',
  /** A draft revision the owner has not approved. */
  'ContractAwaitingApproval',
  /** An approved revision with no candidate linked to the request. */
  'CandidateNotLinked',
  /** A candidate whose required verification has no result against its current commit. */
  'VerificationOutstanding',
  /** A recorded verification failure, which needs an owner decision rather than a retry. */
  'VerificationFailed',
  /** A criterion the contract assigned to an owner test that has not been recorded. */
  'OwnerTestOutstanding',
  /** Every criterion satisfied and no decision yet: Accept or Request Changes is the action. */
  'DecisionAwaiting',
  /** Current automated evidence for the candidate on screen, and no decision against it. */
  'CandidateReadyForReview',
] as const;

export type HomeEntryKind = (typeof HOME_ENTRY_KINDS)[number];

/**
 * One thing on the board.
 *
 * Carries no progress field, no percentage, no executor identifier and no elapsed time, and
 * that absence is the point: there is no value this route can fill in truthfully, so there
 * is no field for a caller to expect one in. `headSha` is the full 40-character commit or
 * null, never an abbreviation and never a branch name, because a candidate is identified by
 * its commit (F17-AC2, F25-AC3).
 */
export interface HomeEntry {
  readonly kind: HomeEntryKind;
  readonly requestId: string;
  readonly title: string;
  readonly contractId: string | null;
  readonly contractRevision: number | null;
  readonly candidateId: string | null;
  /** Full 40-character commit SHA, or null when no candidate is linked. */
  readonly headSha: string | null;
  /** Why this entry is here, quoted from the projection that decided it. */
  readonly reason: string;
  /** What the owner does next. A statement about the owner's action, never an executor's. */
  readonly nextAction: string;
  /** Criterion ids the review read model does not currently have a passing observation for. */
  readonly outstandingCriterionIds: readonly string[];
}

/**
 * The three groups, and the instant they were read.
 *
 * Each list is independent rather than a partition of the requests: a candidate with
 * current automated evidence *and* an unrun owner test is truthfully both ready to be looked
 * at and waiting on the owner, because F24-AC3 offers the review while the owner test is
 * still outstanding. Forcing one entry into one group would have meant dropping a true
 * statement to keep the lists tidy.
 */
export interface HomeProjection {
  readonly projectId: string;
  readonly collectedAt: string;
  readonly needsYou: readonly HomeEntry[];
  readonly inProgress: readonly HomeEntry[];
  readonly readyForReview: readonly HomeEntry[];
}

export interface HomeCandidateQuery {
  readonly projectId: string;
  readonly requestId: string;
}

export interface HomeReviewQuery extends HomeCandidateQuery {
  readonly candidateId: string;
}

/**
 * The stored candidate and review projections this read composes.
 *
 * Two methods, both durable reads, and the distinction is load-bearing:
 *
 *   - `recordedCandidate` answers from the row ShipLoop recorded. It is deliberately *not*
 *     `readCandidate`, which reads the provider live: rendering a board must not turn a page
 *     load into a claim about GitHub, and a board that re-read the provider would report
 *     what the provider said just now rather than what ShipLoop owns.
 *   - `reviewReadModel` returns the domain's own projection
 *     (`buildMvpReviewReadModel`), so readiness, the outstanding criteria and staleness are
 *     computed once, in the layer that owns them (F20-AC3, F24-AC3).
 *
 * The project travels in both queries and is part of the question rather than a filter
 * applied afterwards: a candidate belonging to another project must be invisible through
 * this project's session, not merely refused (F02-AC2).
 */
export interface HomeEvidenceSources {
  recordedCandidate(query: HomeCandidateQuery): Promise<Result<DeliveryCandidate | null, DomainError>>;
  reviewReadModel(query: HomeReviewQuery): Promise<Result<MvpReviewReadModel, DomainError>>;
}

export interface HomeRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
  readonly now: () => Date;
  /**
   * The candidate and review projections, or null when this deployment exposes none.
   *
   * Null rather than optional-with-a-default because there is no safe default. Without them
   * the board cannot know whether a candidate exists, so it would answer "nothing needs you,
   * nothing is moving, nothing is ready" — an emptiness that reads as a fact about the
   * project and is not one. The route refuses instead, and says which composition
   * dependency is missing.
   */
  readonly sources: HomeEvidenceSources | null;
}

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

/** One request's contribution to the board, or null where it contributes nothing. */
interface Placement {
  readonly needsYou: HomeEntry | null;
  readonly inProgress: HomeEntry | null;
  readonly readyForReview: HomeEntry | null;
}

const NOWHERE: Placement = { needsYou: null, inProgress: null, readyForReview: null };

/**
 * A candidate together with the review projection about it.
 *
 * One value rather than two arguments, because the two cannot honestly be separated: a
 * candidate without a projection would have no readiness, no outstanding criteria and no
 * staleness, and every question below would then be answered about nothing. Bundling them
 * makes "a candidate whose review could not be read" unrepresentable here — the read is
 * required to produce the pair, and a refusal stops the whole projection instead.
 */
interface LinkedCandidate {
  readonly candidate: DeliveryCandidate;
  readonly model: MvpReviewReadModel;
}

/**
 * Where one request belongs, from the facts recorded against it.
 *
 * `linked` is null when no candidate is linked. The order of the questions is the order of
 * the journey — agree what to build, link a candidate, verify it, test it, decide — and each
 * step is only asked once the previous one has an answer, so a request is never reported for
 * a step it has not reached.
 */
function place(detail: RequestDetailView, linked: LinkedCandidate | null): Placement {
  const approved = detail.approvedRevision;

  if (approved === null) {
    const draft = detail.latestRevision;
    if (draft === null) {
      return {
        needsYou: entry(detail, {
          kind: 'ContractNotWritten',
          reason: 'This request has no delivery contract, so there is nothing written down to implement against.',
          nextAction: 'Write a delivery contract for this request and approve it.',
        }),
        inProgress: null,
        readyForReview: null,
      };
    }
    return {
      needsYou: entry(detail, {
        kind: 'ContractAwaitingApproval',
        reason: `Contract revision ${draft.revision} is a draft. Approval is the owner's action, and nothing is agreed until it is given.`,
        nextAction: `Finish contract revision ${draft.revision} and approve it.`,
        contractId: draft.contractId,
        contractRevision: draft.revision,
      }),
      inProgress: null,
      readyForReview: null,
    };
  }

  if (linked === null) {
    return {
      needsYou: null,
      inProgress: entry(detail, {
        kind: 'CandidateNotLinked',
        reason: `Contract revision ${approved.revision} is approved and no candidate is linked to this request.`,
        nextAction: 'Link the pull request that implements this contract revision.',
        contractId: approved.contractId,
        contractRevision: approved.revision,
      }),
      readyForReview: null,
    };
  }

  const { candidate, model } = linked;

  // The candidate's own binding, not the approved revision's: an entry about a candidate
  // must name the agreement that candidate implements, which is the thing that can disagree.
  const candidateFacts = {
    candidateId: candidate.candidateId,
    headSha: candidate.headSha,
    contractId: candidate.contractId,
    contractRevision: candidate.contractRevision,
  };

  // A candidate bound to a revision that is not the approved one describes a retired
  // agreement. That is reachable — link a candidate, then revise — and it is reported as an
  // outstanding verification rather than refused, because the honest answer is "this
  // candidate has no current agreement behind it", not an error the owner caused.
  const bound = detail.revisions.find(
    (revision) => revision.contractId === candidate.contractId && revision.revision === candidate.contractRevision,
  );
  if (bound === undefined || bound.status !== 'approved') {
    return {
      needsYou: null,
      inProgress: entry(
        detail,
        {
          kind: 'VerificationOutstanding',
          reason: `This candidate is bound to contract ${candidate.contractId} revision ${candidate.contractRevision}, which is not the approved revision. No verification describes what this project currently agreed.`,
          nextAction: 'Link a candidate for the approved contract revision, or revise and re-approve the contract.',
        },
        candidateFacts,
        [],
      ),
      readyForReview: null,
    };
  }

  // From here the read model is the only source of readiness, staleness and outstanding work.
  const outstanding = model.criteria.filter((criterion) => criterion.state !== 'passed');
  const outstandingIds = outstanding.map((criterion) => criterion.criterionId);
  const blockingChecks = model.checks.filter((check) => check.required && check.result !== 'passed');
  const unproven = [
    ...blockingChecks,
    ...outstanding.filter((criterion) => criterion.verificationType === 'automated'),
  ];
  const failed = [
    ...blockingChecks.filter((check) => check.result === 'failed'),
    ...outstanding.filter((criterion) => criterion.state === 'failed'),
  ];
  const ownerTests = outstanding.filter((criterion) => criterion.verificationType === 'owner_test');

  // A recorded failure needs an owner decision: retrying is not something ShipLoop can do
  // here, and reporting it as merely "outstanding" would hide a red result behind a grey one.
  if (failed.length > 0) {
    return {
      needsYou: entry(
        detail,
        {
          kind: 'VerificationFailed',
          reason: failed[0]?.reason ?? 'A recorded verification result is not a pass.',
          nextAction: 'Decide what this candidate should do: record what is missing, or request changes with what is wrong.',
        },
        candidateFacts,
        outstandingIds,
      ),
      inProgress: null,
      readyForReview: null,
    };
  }

  // Something ShipLoop records as required has no result for the commit on screen. `stale`
  // evidence lands here too, because evidence for a superseded commit is not a result for
  // this one (F20-AC3) — and nothing here says who is going to produce the missing result.
  if (unproven.length > 0) {
    return {
      needsYou: null,
      inProgress: entry(
        detail,
        {
          kind: 'VerificationOutstanding',
          reason: unproven[0]?.reason ?? 'No current result is recorded for this candidate.',
          nextAction: 'Record a current result against this commit before the candidate can be reviewed.',
        },
        candidateFacts,
        outstandingIds,
      ),
      readyForReview: null,
    };
  }

  if (ownerTests.length > 0) {
    return {
      needsYou: entry(
        detail,
        {
          kind: 'OwnerTestOutstanding',
          reason: ownerTests[0]?.reason ?? 'A criterion this contract assigned to the owner has not been recorded.',
          nextAction: 'Run the owner test and record what you observed.',
        },
        candidateFacts,
        outstandingIds,
      ),
      inProgress: null,
      // F24-AC3: the review offer stands while an owner test is outstanding, because the
      // test is the owner's own action rather than something ShipLoop is waiting on.
      readyForReview: reviewed(detail, candidate, outstandingIds),
    };
  }

  if (model.decision.outcome === 'none') {
    return {
      needsYou: entry(
        detail,
        {
          kind: 'DecisionAwaiting',
          reason: `Every criterion is satisfied for ${candidate.headSha} and no owner decision applies to it.`,
          nextAction: 'Accept this candidate, or request changes with what is wrong.',
        },
        candidateFacts,
        outstandingIds,
      ),
      inProgress: null,
      readyForReview: reviewed(detail, candidate, outstandingIds),
    };
  }

  // Already decided, and the decision still describes this commit: the owner has nothing
  // outstanding, the candidate is not awaiting a first look, and claiming otherwise would
  // invite a second decision on a candidate that already has one.
  return NOWHERE;
}

/** The review-offer entry, phrased from the eligibility the domain computed. */
function reviewed(
  detail: RequestDetailView,
  candidate: DeliveryCandidate,
  outstandingIds: readonly string[],
): HomeEntry {
  return entry(
    detail,
    {
      kind: 'CandidateReadyForReview',
      reason: `The verification recorded for ${candidate.headSha} is current, and no owner decision applies to it.`,
      nextAction: 'Look at the review card and record your decision.',
    },
    {
      candidateId: candidate.candidateId,
      headSha: candidate.headSha,
      contractId: candidate.contractId,
      contractRevision: candidate.contractRevision,
    },
    outstandingIds,
  );
}

/** One entry, with the candidate identity filled in when there is one. */
function entry(
  detail: RequestDetailView,
  parts: {
    readonly kind: HomeEntryKind;
    readonly reason: string;
    readonly nextAction: string;
    readonly contractId?: string;
    readonly contractRevision?: number;
  },
  candidateFacts?: {
    readonly candidateId: string;
    readonly headSha: string;
    readonly contractId: string;
    readonly contractRevision: number;
  },
  outstandingIds: readonly string[] = [],
): HomeEntry {
  return {
    kind: parts.kind,
    requestId: detail.request.requestId,
    title: detail.request.title,
    contractId: candidateFacts?.contractId ?? parts.contractId ?? null,
    contractRevision: candidateFacts?.contractRevision ?? parts.contractRevision ?? null,
    candidateId: candidateFacts?.candidateId ?? null,
    headSha: candidateFacts?.headSha ?? null,
    reason: parts.reason,
    nextAction: parts.nextAction,
    outstandingCriterionIds: outstandingIds,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Reads every request of this project and places it on the board.
 *
 * The project's requests are the enumeration, so a fact this route could not have reached
 * has nowhere to enter the projection from. Each request's detail, candidate and review
 * model are then read once, and a refusal from any of them stops the read rather than
 * dropping that request: a board that silently omits a request whose verification could not
 * be read would report "nothing needs you" about a request that does.
 */
async function project(
  options: HomeRouteOptions,
  sources: HomeEvidenceSources,
  projectId: string,
  actor: OwnerId,
  collectedAt: string,
): Promise<Result<HomeProjection, DomainError>> {
  const listed = await options.controller.contracts.listRequests({ projectId, actor });
  if (!listed.ok) return listed;

  const needsYou: HomeEntry[] = [];
  const inProgress: HomeEntry[] = [];
  const readyForReview: HomeEntry[] = [];

  for (const request of listed.value) {
    const detail = await options.controller.contracts.getRequest({ projectId, requestId: request.requestId, actor });
    if (!detail.ok) return detail;

    const found = await sources.recordedCandidate({ projectId, requestId: request.requestId });
    if (!found.ok) return found;
    const candidate = found.value;

    // A linked candidate and its review projection are read together, so the pair below is
    // either both present or the read stops. Half a candidate would be a candidate this route
    // could say nothing true about.
    let linked: LinkedCandidate | null = null;
    if (candidate !== null) {
      const read = await sources.reviewReadModel({
        projectId,
        requestId: request.requestId,
        candidateId: candidate.candidateId,
      });
      if (!read.ok) return read;
      linked = { candidate, model: read.value };
    }

    const placement = place(detail.value, linked);
    if (placement.needsYou !== null) needsYou.push(placement.needsYou);
    if (placement.inProgress !== null) inProgress.push(placement.inProgress);
    if (placement.readyForReview !== null) readyForReview.push(placement.readyForReview);
  }

  return { ok: true, value: { projectId, collectedAt, needsYou, inProgress, readyForReview } };
}

/**
 * The owner a request proved, for a read.
 *
 * Reads are behind the guard, so a null session is a wiring fault rather than an expected
 * outcome — which is why this refuses rather than substituting an empty identity. Substituting
 * one would hand the use case a caller nobody is, and the refusal it returns would then be a
 * claim about an owner that does not exist (F01-AC1).
 */
function provedOwnerOf(
  request: { readonly session: { readonly ownerId: OwnerId } | null },
  reply: FastifyReply,
): OwnerId | null {
  if (request.session !== null) return request.session.ownerId;
  sendProblem(reply, signInRequiredProblem());
  return null;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

export function registerHomeRoutes(app: FastifyInstance, options: HomeRouteOptions): void {
  /**
   * This project's home projection: what needs the owner, what is recorded as still moving,
   * and what is ready to be looked at.
   *
   * Project-scoped and behind the session guard, with the project taken from the path and the
   * owner from the proved session — the same shape as `routes/contracts.ts`, so a request is
   * always addressed as a pair and a body cannot say which project it means (mvp-spec 3,
   * F01-AC1, F02-AC2). A read, so it takes no CSRF token.
   */
  app.get('/api/projects/:projectId/home', { preHandler: options.guard }, async (request, reply) => {
    const owner = provedOwnerOf(request, reply);
    if (owner === null) return reply;
    const params = parseBody(projectParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));

    if (options.sources === null) {
      return sendProblem(
        reply,
        problemFor({
          code: 'Unavailable',
          reason:
            'This deployment exposes no stored candidate or review projection, so the home projection cannot be composed. It is refused rather than answered with three empty groups, because an empty board would claim there is nothing to review and that is not a fact this server can prove.',
        }),
      );
    }

    const projected = await project(options, options.sources, params.value.projectId, owner, options.now().toISOString());
    if (!projected.ok) return sendProblem(reply, problemFor(projected.error));
    return reply.status(200).send({ home: projected.value });
  });
}
