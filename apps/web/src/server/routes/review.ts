/**
 * The Review Card and the owner decision (mvp-spec 3, F24, F25).
 *
 * Two routes, and they are the last two the minimal MVP journey reaches:
 * `Request → Delivery Contract → External execution → GitHub candidate → Verification →
 * Owner decision`. Everything after this point — merge, deployment, release — is outside
 * the cut, and nothing in this file can reach a provider, a queue or a deployment. The only
 * write here records one owner decision against one exact commit.
 *
 * Five properties are structural rather than documented, and each closes a specific wrong
 * answer:
 *
 *   - **The card is one projection, computed once.** The read model the controller returns
 *     carries the request, the contract revision, the candidate with its full SHA, the
 *     checks, the criteria, the evidence, the owner tests, the staleness, the decision and
 *     the eligibility together, so a criterion cannot be green on one panel and stale on
 *     another (F24-AC2, F24-AC3).
 *   - **`evidence[].outcome` does not exist on the wire.** The projection renames it
 *     `recordedOutcome` and adds `countsForCurrentCandidate`, because the domain states the
 *     hazard itself: `outcome` is what the source said and stays `passed` after a push,
 *     while `currentOutcome` reads `stale`. A client that reaches for a field named
 *     `outcome` finds nothing to reach for, so a stale pass cannot be rendered as current
 *     (F20-AC3, F24-AC3).
 *   - **A stale head is a conflict, not a re-pointed decision.** The body carries
 *     `expectedHeadSha` and `expectedContractRevision` — what the owner's page was rendered
 *     against — and the controller refuses a mismatch with the expected and actual named. Had
 *     this route resolved the current candidate and decided against that, an acceptance the
 *     owner made about one commit would silently authorise the next one (F24-AC4, F25-AC3).
 *   - **The decision's owner is the session, and there is no field to argue with.** The body
 *     is a `strictObject` with no `owner`, `ownerId`, `actor` or `decidedAt`, so an attempt to
 *     attribute the decision to somebody else, or to backdate it, is refused *by name* rather
 *     than ignored. The actor is built from the proved session here and nowhere else
 *     (F25-AC1, F25-AC4, F01-AC1).
 *   - **Nothing in this file can satisfy an owner test.** There is no route that records an
 *     owner-test outcome, so a criterion the owner must act on keeps reading `pending` until
 *     they act. That is a gap in the phase's transport contract rather than a choice here,
 *     and the card reports it honestly rather than inferring a pass (F23-AC1, F24-AC3).
 *
 * The dependency is injected rather than read off the controller surface, and that is
 * deliberate: `ControllerSurface` is the shared port every route registration and every
 * surface guard in this repository reads, so adding a group to it is a change to that
 * boundary rather than to this route. Whoever wires the composition root supplies
 * `createMvpReviewCardUseCases` and it becomes reachable; until then both routes answer 503
 * naming the missing composition rather than an empty card, because a card with no
 * dependency behind it is a claim about a candidate nobody read.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  fieldErrorsOf,
  fieldsProblem,
  parseBody,
  problemFor,
  sendProblem,
  signInRequiredProblem,
} from '../http-error.ts';
import type { SessionGuard } from '../auth-guard.ts';
import type { DomainError, MvpActor, OwnerId, Result } from '@shiploop/domain';

/* -------------------------------------------------------------------------- */
/* Boundary schemas                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A project identity from the path.
 *
 * Bounded and refused on a path separator or `..`, matching `routes/contracts.ts` exactly:
 * the value addresses an artifact root, a workspace and a git checkout, so a traversal here
 * is a traversal there (F06-AC1). Repeated rather than imported because each route file
 * validates its own params and a shared schema module would make a change to this boundary a
 * change to every other route's boundary too.
 */
const projectParams = z.strictObject({
  projectId: z
    .string()
    .trim()
    .min(1, 'A project id is required.')
    .max(128, 'A project id may be at most 128 characters.')
    .refine(
      (value) => !/[/\\]/.test(value) && !value.includes('..'),
      'A project id may not contain a path separator or "..".',
    ),
});

/** A candidate identity from the path, bounded for the same reason the project id is. */
const candidateParams = projectParams.extend({
  candidateId: z
    .string()
    .trim()
    .min(1, 'A candidate id is required.')
    .max(128, 'A candidate id may be at most 128 characters.'),
});

/** The two decisions the minimal MVP ends at, as a closed set (F25). */
const DECISION_KINDS = ['accepted', 'changes_requested'] as const;

/**
 * The full commit SHA the owner's card was rendered against.
 *
 * Pattern-validated here so an abbreviated SHA is refused as a malformed field rather than
 * travelling to the domain and coming back as a refusal about the candidate. 40 or 64
 * lowercase hexadecimal characters, matching `isCommitSha`: a branch name, an abbreviation or
 * a PR number cannot identify what was reviewed (F24-AC4, F25-AC1).
 */
const fullCommitSha = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/, {
    message:
      'Name the full 40-character commit SHA this decision was made against. A branch name, an abbreviation or a PR number cannot identify what was reviewed (F24-AC4, F25-AC1).',
  });

/** Longest feedback a decision may carry; feedback is a note, not a document. */
const MAXIMUM_FEEDBACK_LENGTH = 20_000;

/**
 * One owner decision.
 *
 * Four fields, and the four that are absent are the point:
 *
 *   - no `owner`, `ownerId`, `actor` or `approver` — the decision's owner is the session
 *     (F25-AC4);
 *   - no `decidedAt` — the instant is the server's clock, so a decision cannot be backdated
 *     (F25-AC1);
 *   - no `contractId` — the candidate binds the contract and its revision, and a body that
 *     could name a different contract is a body that could accept against one (F25-AC3);
 *   - no `candidateId` or `projectId` — both travel in the path, so a body carrying them
 *     would be a second, unchecked source of identity (F02-AC2).
 *
 * `strictObject` refuses every one of those by name rather than dropping it, which is what
 * turns "I tried to decide as somebody else" into a 400 naming the field instead of a
 * success recorded against this session.
 */
const decisionBody = z.strictObject({
  decision: z.enum(DECISION_KINDS, {
    error: `A decision is either ${DECISION_KINDS[0]} or ${DECISION_KINDS[1]}; ShipLoop v0.1 ends here, with no merge and no deployment (F25).`,
  }),
  expectedHeadSha: fullCommitSha,
  expectedContractRevision: z.coerce
    .number()
    .int()
    .positive('A contract revision starts at 1, so name the one your card was rendered against (F24-AC4).'),
  feedback: z
    .string()
    .trim()
    .max(MAXIMUM_FEEDBACK_LENGTH, 'Feedback is too long.')
    .nullable()
    .optional(),
});

/* -------------------------------------------------------------------------- */
/* The port                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The two use cases this route serves, over durable state.
 *
 * Declared as the smallest surface the handlers call rather than imported from
 * `@shiploop/controller`, because `apps/web` declares its ports and the controller package
 * declares its own. The return value is the review card projection: every element the owner
 * reads, computed once by the domain's read model.
 */
export interface ReviewCardRouteSources {
  /** The one card, for the candidate named in the path. */
  getReview(command: {
    readonly projectId: string;
    readonly candidateId: string;
    readonly actor: MvpActor;
  }): Promise<Result<unknown, DomainError>>;
  /** Accept, or Request Changes, bound to the commit the caller's card named. */
  decide(command: {
    readonly projectId: string;
    readonly candidateId: string;
    readonly actor: MvpActor;
    /** What the decision is: the owner's choice, never derived from eligibility. */
    readonly decision: 'accepted' | 'changes_requested';
    readonly expectedHeadSha: string;
    readonly expectedContractRevision: number;
    readonly feedback: string | null;
  }): Promise<Result<unknown, DomainError>>;
}

export interface ReviewRouteOptions {
  readonly guard: SessionGuard;
  /**
   * The review use cases, or null when this process composed none.
   *
   * Null rather than an empty card: a server that cannot read a candidate has no basis for a
   * card, and a card of empty arrays is a claim about a candidate that was never read.
   */
  readonly sources: ReviewCardRouteSources | null;
}

/**
 * The refusal for a process that has not composed the review path.
 *
 * `Unavailable` rather than `NotFound`, because the difference matters to the owner: nothing
 * is missing at that address, this server cannot answer it. A 404 would read as "no such
 * candidate", which is a different claim about their project.
 */
const NOT_COMPOSED: DomainError = {
  code: 'Unavailable',
  reason:
    'This server has not composed the MVP review path, so it cannot read a review card or record a decision. The candidate has not been assessed; nothing here means it passed or failed.',
};

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The authenticated owner, as the actor every use case here is handed.
 *
 * Built from the session and nowhere else. `MvpActor`'s non-owner variants carry no owner
 * identity, so the domain can refuse a non-owner without this route ever constructing one —
 * which is why there is no code path by which a body, a header or a query parameter reaches
 * the `ownerId` (F25-AC4, F01-AC1).
 */
function ownerActorOf(session: { readonly ownerId: OwnerId }): MvpActor {
  return { role: 'owner', ownerId: session.ownerId };
}

export function registerReviewRoutes(app: FastifyInstance, options: ReviewRouteOptions): void {
  /**
   * The Review Card for one candidate (F24-AC2, F24-AC3).
   *
   * 200 with the whole card: one request, one moment. Two round trips would leave a window
   * in which the two answers describe different moments, and the second of them could be the
   * one an action is taken against.
   */
  app.get(
    '/api/projects/:projectId/candidates/:candidateId/review',
    { preHandler: options.guard },
    async (request, reply) => {
      const session = request.session;
      if (session === null) return sendProblem(reply, signInRequiredProblem());
      const params = parseBody(candidateParams, request.params);
      if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
      if (options.sources === null) return sendProblem(reply, problemFor(NOT_COMPOSED));

      const card = await options.sources.getReview({
        projectId: params.value.projectId,
        candidateId: params.value.candidateId,
        actor: ownerActorOf(session),
      });
      if (!card.ok) return sendProblem(reply, problemFor(card.error));
      return reply.status(200).send({ review: card.value });
    },
  );

  /**
   * Accept, or Request Changes (F25-AC1, F25-AC2, F25-AC3, F25-AC4).
   *
   * `200` rather than `201`: this records a judgement about a candidate that already exists,
   * and no new resource is created — the decision is a member of the card this same response
   * returns. The response *is* the re-projected card, so a client never has to re-fetch to
   * learn whether its own action was the one that took effect.
   *
   * Two refusals are worth naming because they are the product, not edge cases:
   *
   *   - `409 Conflict` — the reviewed commit is no longer the candidate's head, or the
   *     contract revision has moved. Nothing is written, and the expected and actual are both
   *     named so the client can re-render and submit again. Applying the decision to the new
   *     head instead is the exact defect this shape exists to prevent (F24-AC4, F25-AC3).
   *   - `422 Blocked` — Accept while the projection says something is outstanding. Every
   *     outstanding item travels as a named prerequisite, because an owner told "3 of 4"
   *     learns nothing and one told which three learns exactly what to do. Request Changes is
   *     not gated on this and stays available either way (F24-AC3, F25-AC2).
   */
  app.post(
    '/api/projects/:projectId/candidates/:candidateId/decision',
    { preHandler: options.guard },
    async (request, reply) => {
      const session = request.session;
      if (session === null) return sendProblem(reply, signInRequiredProblem());
      const params = parseBody(candidateParams, request.params);
      if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
      const body = parseBody(decisionBody, request.body);
      if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
      if (options.sources === null) return sendProblem(reply, problemFor(NOT_COMPOSED));

      const decided = await options.sources.decide({
        projectId: params.value.projectId,
        candidateId: params.value.candidateId,
        actor: ownerActorOf(session),
        decision: body.value.decision,
        expectedHeadSha: body.value.expectedHeadSha,
        expectedContractRevision: body.value.expectedContractRevision,
        feedback: body.value.feedback ?? null,
      });
      if (!decided.ok) return sendProblem(reply, problemFor(decided.error));
      return reply.status(200).send({ review: decided.value });
    },
  );
}