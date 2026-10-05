/**
 * The review card and the owner's decision (mvp-spec 3, F24, F25).
 *
 * Two routes, and the MVP journey ends here: `GET .../review` renders one card, and
 * `POST .../decision` records Accept or Request Changes against it. Nothing in this file
 * merges, deploys, releases, or contacts a provider — the port it declares has no such
 * method, and the file has no import that could reach one (mvp-spec 3, F03-AC5).
 *
 * The rules below are not decoration. Each one exists because there is a specific wrong
 * answer it makes unreachable:
 *
 *   - **A verdict rests on an observation that counts.** `recordedOutcome`, `currentOutcome`
 *     and `countsForCurrentCandidate` say three different things, and a card that publishes
 *     them without tying them to the verdicts above is a card that renders a stale pass in
 *     green. So a criterion, an owner test or a check reading `passed` must name an
 *     observation that describes the candidate on screen, and the card's staleness summary
 *     must count exactly the rows that no longer do. `review.invariants.test.ts` builds a
 *     card for each way this can be violated and each one is refused (F20-AC3, F24-AC3).
 *   - **The two evidence outcomes cannot be confused.** The domain read model carries both
 *     `outcome` (what the source said at the time, which stays `passed` after a push) and
 *     `currentOutcome` (`stale` once the binding no longer holds). A card that published
 *     the first under its own name is a card that renders a stale pass in green. So the
 *     wire names are `recordedOutcome`, `currentOutcome` and `countsForCurrentCandidate`,
 *     `evidenceRow` refuses any row carrying a bare `outcome`, and it refuses a row whose
 *     two outcomes disagree about staleness — a port cannot answer with a card that
 *     claims an observation both counts and does not (F20-AC3, F24-AC3).
 *   - **A decision names the commit it was made against.** `expectedHeadSha` and
 *     `expectedContractRevision` are required in the body, and `decideCard` refuses any
 *     card whose decision does not bind exactly those. A push between rendering and
 *     submitting is a `409`, never a decision about the new head (F24-AC4, F25-AC3).
 *   - **The owner is the session, never the body.** `decisionBody` is a `strictObject` with
 *     no owner member, so a payload naming an `ownerId` or an `approver` is refused by name
 *     rather than ignored (F01-AC1, F25-AC4).
 *   - **Accept is gated, Request Changes is not.** `Accept` is passed to the use case only
 *     when `eligibility.readyForAcceptance` is true, and the refusal names the card's own
 *     outstanding requirements; `Request Changes` is always permitted, which is what makes
 *     "the work is not ready" expressible (F23-AC1, F24-AC3, F25-AC2).
 *   - **An owner test is nobody else's to settle.** `owner test criterion reads passed
 *     without evidence` is refused, so nothing that is not an owner observation can present
 *     itself as one (F23-AC1, F25-AC4).
 *   - **The project is proven twice.** It travels in the path, the owner comes from the
 *     proved session, and the response's own project and candidate identities are checked
 *     against the path before anything is returned (F02-AC2).
 *
 * Reused rather than rewritten: `isCommitSha` from the domain is the only definition of
 * what may stand in for a commit identity; the zod params schema matches
 * `routes/contracts.ts`; and every judgement about readiness, staleness and eligibility is
 * the use case's, passed through rather than restated.
 */

import { isCommitSha } from '@shiploop/domain';
import type { OwnerId } from '@shiploop/domain';
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
import type { ControllerSurface, MvpReviewCardView } from '../contracts.ts';
import type { SessionGuard } from '../auth-guard.ts';

/* -------------------------------------------------------------------------- */
/* Request schemas                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One project and one candidate.
 *
 * The project schema is identical to `routes/contracts.ts` and `routes/candidates.ts`: the
 * value addresses an artifact root, a workspace and a git checkout downstream, so a
 * traversal here is a traversal there (F06-AC1). Repeated rather than imported because each
 * route file validates its own params, and a shared schema module would make a change to
 * this boundary a change to every other route's boundary too.
 */
const reviewParams = z.strictObject({
  projectId: z
    .string()
    .trim()
    .min(1, 'A project id is required.')
    .max(128, 'A project id may be at most 128 characters.')
    .refine((value) => !/[/\\]/.test(value) && !value.includes('..'), 'A project id may not contain a path separator or "..".'),
  candidateId: z
    .string()
    .trim()
    .min(1, 'A candidate id is required.')
    .max(128, 'A candidate id may be at most 128 characters.'),
});

/**
 * The commit the page was rendered against.
 *
 * The domain's own rule is reused for the check rather than restated, because a second
 * spelling of "full SHA" is a second opinion about what may stand in for identity: a
 * branch name and an abbreviation both fail `isCommitSha`, which is the property that
 * keeps a submission bound to one build (mvp-spec 3, F24-AC4).
 */
const fullCommitSha = z
  .string()
  .trim()
  .refine((value) => isCommitSha(value), 'A full 40-character commit SHA is required; a branch name, an abbreviation or a pull request number is not a candidate identity.');

/**
 * What an owner may decide.
 *
 * Two members and no third, because the MVP ends at `accepted` or `changes_requested`:
 * there is no `merged`, no `deployed` and no `released` for a client to ask for (mvp-spec 3).
 */
const decisionKind = z.enum(['accepted', 'changes_requested']);

/**
 * The decision body.
 *
 * `strictObject` and no owner member. There is no `ownerId`, no `approver`, no `decidedBy`
 * and no `at`: the owner is the proved session and the instant is the controller's clock,
 * so a body carrying any of them is refused by name instead of silently dropped — a client
 * that believes it chose the deciding identity should be told that identity is not its to
 * choose (F01-AC1, F25-AC4).
 *
 * `feedback` is optional and may be null. The use case refuses a change request with
 * nothing in it, because a fix pass with no instruction has nothing to follow (F25-AC2);
 * that rule stays there rather than becoming a second copy here.
 */
const decisionBody = z.strictObject({
  decision: decisionKind,
  expectedHeadSha: fullCommitSha,
  expectedContractRevision: z
    .number({ error: 'A contract revision is a number.' })
    .int('A contract revision is a whole number.')
    .min(1, 'Contract revisions start at 1.'),
  feedback: z
    .string()
    .max(8000, 'Feedback is too long to record against a decision.')
    .nullish()
    .transform((value) => value ?? null),
});

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The owner a request proved.
 *
 * Local rather than shared: reads are behind the guard, so a null session is a wiring
 * fault rather than an expected outcome, and substituting an empty identity would hand the
 * use case a caller nobody is (F01-AC1).
 */
function provedOwnerOf(
  request: { readonly session: { readonly ownerId: OwnerId } | null },
  reply: FastifyReply,
): OwnerId | null {
  if (request.session !== null) return request.session.ownerId;
  sendProblem(reply, signInRequiredProblem());
  return null;
}

export interface ReviewRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
}

export function registerReviewRoutes(app: FastifyInstance, options: ReviewRouteOptions): void {
  /**
   * The whole review card for one candidate of this project.
   *
   * `GET`, because nothing is written and nothing is decided here: the same candidate and
   * the same stored evidence always render the same card, so a client may read it twice
   * and compare rather than trust either. Behind the session guard with the owner from the
   * session, and the project proven again in `checkedCard` before any of it is returned
   * (F01-AC1, F02-AC2).
   *
   * The card is answered as one object. It was computed in one pass over the request, the
   * contract revision, the candidate, the checks, the criteria, the evidence and the
   * decisions, so a client cannot assemble a card from two reads that disagree about
   * whether the work is ready (F24-AC2).
   */
  app.get('/api/projects/:projectId/candidates/:candidateId/review', { preHandler: options.guard }, async (request, reply) => {
    const owner = provedOwnerOf(request, reply);
    if (owner === null) return reply;
    const params = parseBody(reviewParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));

    const reviewed = await options.controller.mvpReview.getReview({
      projectId: params.value.projectId,
      candidateId: params.value.candidateId,
      actor: owner,
    });
    if (!reviewed.ok) return sendProblem(reply, problemFor(reviewed.error));

    const card = checkedCard(reviewed.value, params.value.projectId, params.value.candidateId, reply);
    if (card === null) return reply;
    return reply.status(200).send({ review: card.value });
  });

  /**
   * Accept, or Request Changes.
   *
   * `POST`, behind the session guard and therefore behind CSRF: this is the one route in
   * this group that changes something. The body names the decision, the commit and the
   * contract revision it was prepared against, and nothing else — in particular not the
   * owner, who is the session (F01-AC1, F24-AC4).
   *
   * 200 with the resulting card, because the owner needs to see the decision they just
   * made and what it did to eligibility; there is no 201, since the card was not created
   * by this call. Every refusal keeps its own status: `409` for a stale commit or a moved
   * revision, `422` for an acceptance the card says is not eligible, `404` for a candidate
   * this project does not hold (F24-AC4, F23-AC1, F02-AC2).
   */
  app.post('/api/projects/:projectId/candidates/:candidateId/decision', { preHandler: options.guard }, async (request, reply) => {
    const owner = provedOwnerOf(request, reply);
    if (owner === null) return reply;
    const params = parseBody(reviewParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(decisionBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    // The card is read before an acceptance is offered, because the accept gate is the
    // card's own `readyForAcceptance` and nothing else may stand in for it. Refusing here
    // reaches no write at all, and the refusal carries the card's outstanding requirements
    // so the owner learns what to do rather than only that the door is shut (F23-AC1).
    //
    // The identity is compared *first*, before eligibility, and the order is load-bearing.
    // A submission prepared against one commit cannot be answered with a report about
    // another: reading the current card's blockers and returning them as the reason an
    // acceptance of SHA A failed tells the owner to go and discharge requirements on a
    // build they never looked at, and never mentions that a push moved the ground. The
    // domain refuses in this order too: `staleSubmission` runs at the top of `decide`,
    // before the acceptance gate that reads `eligibility.readyForAcceptance` off the freshly
    // projected card. Verified rather than assumed — the ordering is what lets the transport and
    // the use case agree on what a stale submission is, rather than answering the same command
    // two different ways. That agreement was the point of the check, and it did not hold: the
    // transport refused with the wrong identity (see `staleCard`), so a submission the domain
    // called a moved revision was answered by this layer as a moved commit (F24-AC4, F25-AC3).
    if (body.value.decision === 'accepted') {
      const current = await options.controller.mvpReview.getReview({
        projectId: params.value.projectId,
        candidateId: params.value.candidateId,
        actor: owner,
      });
      if (!current.ok) return sendProblem(reply, problemFor(current.error));
      const card = checkedCard(current.value, params.value.projectId, params.value.candidateId, reply);
      if (card === null) return reply;
      // Which of the two facts moved is decided here, from the two comparisons, rather than
      // re-derived from the card below. The card's own `contract.revision` and
      // `candidate.contractRevision` are equal by construction - both come from one read of the
      // revision the candidate is bound to - so asking the card which one is wrong always answers
      // "neither", and a submission refused for a revision that moved was reported as a commit
      // that moved. Naming `expected` as the submitted commit and `actual` as the same commit
      // back is a conflict that describes nothing: the owner is sent to re-render without ever
      // being told the ground that moved was the revision (F24-AC4).
      const revisionMoved = card.value.contract.revision !== body.value.expectedContractRevision;
      const commitMoved = card.value.candidate.headSha !== body.value.expectedHeadSha;
      if (revisionMoved || commitMoved) {
        return sendProblem(
          reply,
          problemFor(
            staleCard(
              { headSha: body.value.expectedHeadSha, contractRevision: body.value.expectedContractRevision },
              card.value,
              revisionMoved,
            ),
          ),
        );
      }
      if (!card.value.eligibility.readyForAcceptance) {
        return sendProblem(
          reply,
          problemFor({
            code: 'Blocked',
            reason: `This candidate cannot be accepted yet: ${card.value.eligibility.acceptanceBlockers.length} outstanding requirements (F23-AC1, F24-AC3).`,
            prerequisites: card.value.eligibility.acceptanceBlockers.map((reason) => ({
              name: 'Outstanding requirement',
              detail: reason,
              remedy: 'Record the missing observation, or request changes with what is wrong.',
            })),
          }),
        );
      }
    }

    const decided = await options.controller.mvpReview.decide({
      projectId: params.value.projectId,
      candidateId: params.value.candidateId,
      actor: owner,
      decision: body.value.decision,
      expectedHeadSha: body.value.expectedHeadSha,
      expectedContractRevision: body.value.expectedContractRevision,
      feedback: body.value.feedback,
    });
    if (!decided.ok) return sendProblem(reply, problemFor(decided.error));

    // The decision is re-checked against what was submitted: a card whose decision names a
    // different commit, a different revision or a different owner than the one this call
    // was made with is refused rather than returned, because a response that reports an
    // acceptance of another build is worse than no response (F24-AC4, F25-AC3, F01-AC1).
    const card = checkedCard(decided.value, params.value.projectId, params.value.candidateId, reply);
    if (card === null) return reply;
    const bound = checkDecisionBinding(
      card.value,
      {
        decision: body.value.decision,
        headSha: body.value.expectedHeadSha,
        contractRevision: body.value.expectedContractRevision,
        ownerId: owner,
      },
      reply,
    );
    if (bound === null) return reply;
    return reply.status(200).send({ review: card.value });
  });
}

/**
 * The conflict a submission prepared against facts that have moved earns (F24-AC4).
 *
 * `revisionMoved` is a parameter rather than something derived from `card`, and the reason is
 * that the card cannot answer the question. Its `contract.revision` and
 * `candidate.contractRevision` are the same number by construction — both are read from the one
 * revision the candidate is bound to — so a card inspected for a disagreement between them is
 * always found consistent, and the wrong branch is the one that would have answered correctly.
 * The caller has already compared both submitted facts against both current ones, so it knows
 * which moved; this function only says so.
 *
 * The revision is reported first when it moved, because a decision names two facts and the
 * commit is the one a reader compares against a build. If both moved, saying the revision
 * leads is right: re-rendering resolves both, and naming only the commit would leave the owner
 * to discover the second on the next submission.
 */
function staleCard(
  submitted: { readonly headSha: string; readonly contractRevision: number },
  card: MvpReviewCardView,
  revisionMoved: boolean,
): { readonly code: 'Conflict'; readonly reason: string; readonly expected: string; readonly actual: string } {
  if (revisionMoved) {
    return {
      code: 'Conflict',
      reason: `This submission was prepared against contract revision ${submitted.contractRevision}, but revision ${card.contract.revision} is current. Re-render and submit again (F24-AC4).`,
      expected: String(submitted.contractRevision),
      actual: String(card.contract.revision),
    };
  }
  return {
    code: 'Conflict',
    reason: `This submission was prepared against candidate ${submitted.headSha}, but the candidate on screen is ${card.candidate.headSha}. Evidence and decisions from the earlier commit do not describe this one (F24-AC4, F25-AC3).`,
    expected: submitted.headSha,
    actual: card.candidate.headSha,
  };
}

/* -------------------------------------------------------------------------- */
/* Projection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Checks everything a card claims before it is returned.
 *
 * Re-derived here rather than trusted, so a card that contradicts itself is refused
 * instead of sent:
 *
 *   - the project and the candidate on the card are the ones the path named, so a card
 *     about another project cannot be read through this project's path (F02-AC2);
 *   - `candidate.headSha` is a full commit SHA, because that is the only acceptable
 *     identity for what is under review (mvp-spec 3);
 *   - every evidence row agrees with itself about staleness (F24-AC2);
 *   - **every verdict rests on an observation that counts for this candidate**, which is
 *     the rule the recorded/current split exists to make enforceable: a criterion, an
 *     owner test or a check reading `passed` on evidence that no longer describes the
 *     commit on screen is the stale pass rendered green, and it is refused rather than
 *     shipped (F20-AC3, F24-AC3);
 *   - the card's own staleness summary counts exactly the rows that no longer count, so a
 *     client reading the headline rather than every row is not told a stale candidate is
 *     current (F20-AC3, F25-AC3);
 *   - an owner test nobody ran reads `pending`: a card claiming `passed` without the
 *     evidence of an owner observation is refused, because no automated result and no
 *     agent may settle the owner's own step (F23-AC1, F25-AC4);
 *   - only an acceptance that names this commit and this revision authorises anything
 *     (F25-AC3, F27-AC3).
 *
 * Every one of these is measured rather than assumed, and `review.invariants.test.ts`
 * answers the port with cards built to fail each one, because a check that has only ever
 * run against an honest projection has not been shown to work.
 *
 * Returns null after answering the reply, so a caller cannot send a partial body by
 * accident.
 */
function checkedCard(
  card: MvpReviewCardView,
  projectId: string,
  candidateId: string,
  reply: FastifyReply,
): { readonly value: MvpReviewCardView } | null {
  if (card.candidate.candidateId !== candidateId || card.candidate.projectId !== projectId) {
    refuse(
      reply,
      `The card is about candidate ${card.candidate.candidateId} of project ${card.candidate.projectId}, not ${candidateId} of ${projectId}, so it is not returned through this path (F02-AC2).`,
    );
    return null;
  }
  if (card.request.projectId !== projectId || card.contract.projectId !== projectId) {
    refuse(
      reply,
      `The card mixes facts from more than one project (request ${card.request.projectId}, contract ${card.contract.projectId}, candidate ${card.candidate.projectId}), so it is not returned as one card (F02-AC2).`,
    );
    return null;
  }
  if (!isCommitSha(card.candidate.headSha)) {
    refuse(
      reply,
      `The card reports head "${truncate(card.candidate.headSha)}", which is not a full commit SHA. A branch name, an abbreviation and a pull request number are routing facts rather than identity, so nothing is returned that would let one stand in for the candidate (mvp-spec 3).`,
    );
    return null;
  }

  for (const evidence of card.evidence) {
    if (!isStaleConsistent(evidence, card.candidate.headSha)) {
      refuse(
        reply,
        `Evidence ${evidence.evidenceId} reports recordedOutcome=${evidence.recordedOutcome}, currentOutcome=${evidence.currentOutcome} and countsForCurrentCandidate=${String(evidence.countsForCurrentCandidate)}, which cannot all be true at once. A card that both counts and discounts an observation is refused rather than rendered (F20-AC3, F24-AC3).`,
      );
      return null;
    }
  }

  // Every verdict on the card is measured against the one question that matters: does the
  // observation behind it describe the candidate on screen? Checks, criteria and owner tests
  // are walked in turn, because a green criterion panel over a stale table is the exact
  // failure the two-outcome evidence shape was introduced to prevent (F20-AC3, F24-AC3).
  //
  // The three lists are built before any of them is checked, so a `passed` sitting in the
  // last criterion cannot be missed because an earlier one already failed - and the
  // accumulated disagreement is reported as one refusal naming every offender rather than
  // only the first. A card that is wrong in three places should read as wrong in three
  // places, not as a sequence of one-at-a-time surprises.
  const verdicts: readonly { readonly what: string; readonly state: string; readonly evidenceId: string | null }[] = [
    ...card.checks.map((check) => ({ what: `Check "${check.checkId}"`, state: check.result, evidenceId: check.evidenceId })),
    ...card.criteria.map((criterion) => ({ what: `Criterion ${criterion.criterionId}`, state: criterion.state, evidenceId: criterion.evidenceId })),
    ...card.ownerTests.map((criterion) => ({ what: `Owner test ${criterion.criterionId}`, state: criterion.state, evidenceId: criterion.evidenceId })),
  ];
  const unsupported = verdicts.filter((verdict) => !verdictIsSupported(card, verdict));
  if (unsupported.length > 0) {
    refuse(
      reply,
      `The card reports ${unsupported.length} verdict(s) that no observation of this candidate can stand behind: ${unsupported
        .map((verdict) => `${verdict.what} reads ${verdict.state} on ${verdict.evidenceId ?? 'nothing at all'}`)
        .join('; ')}. What the source said at the time is history; only an observation bound to ${card.candidate.headSha} can verify this candidate (F20-AC3, F24-AC3).`,
    );
    return null;
  }

  if (!stalenessSummaryAgrees(card, reply)) return null;

  for (const criterion of card.ownerTests) {
    if (criterion.state !== 'pending') continue;
    if (criterion.evidenceId !== null) {
      refuse(
        reply,
        `Owner test ${criterion.criterionId} reads pending while carrying evidence ${criterion.evidenceId}. A pending owner test has no recorded observation, so the two cannot both be true (F23-AC1).`,
      );
      return null;
    }
  }
  for (const criterion of card.ownerTests) {
    if (criterion.state !== 'passed') continue;
    const source = card.evidence.find((row) => row.evidenceId === criterion.evidenceId);
    if (criterion.evidenceId === null || source === undefined || source.source !== 'owner_test') {
      refuse(
        reply,
        `Owner test ${criterion.criterionId} reads passed without an owner observation behind it. Only the owner may discharge an owner test, and no automated result or agent output can stand in for that (F23-AC1, F25-AC4).`,
      );
      return null;
    }
  }

  if (card.decision.outcome !== 'none' && card.decision.decision === null) {
    refuse(
      reply,
      `The card reports the outcome "${card.decision.outcome}" while carrying no decision behind it. A decision the owner cannot read is not a decision they made, and nothing is returned that would let it read as one (F25-AC2).`,
    );
    return null;
  }
  if (card.decision.authorizesCurrentCandidate) {
    const governing = card.decision.decision;
    if (
      governing === null ||
      governing.kind !== 'accepted' ||
      card.decision.outcome !== 'accepted' ||
      governing.candidateHeadSha !== card.candidate.headSha ||
      governing.contractRevision !== card.contract.revision
    ) {
      refuse(
        reply,
        `The card reports a decision that authorises the candidate on screen while naming no acceptance of this commit and contract revision (it names ${governing === null ? 'no decision' : `a ${governing.kind} of ${governing.candidateHeadSha}`}). Only an acceptance authorises anything, and an acceptance of an earlier commit authorises nothing (F25-AC3, F27-AC3).`,
      );
      return null;
    }
  }

  return { value: card };
}

/**
 * Whether one verdict on the card is standing on an observation that counts.
 *
 * The rule, in one place because checks, criteria and owner tests all break the same way:
 * `passed` requires a named observation that counts for this candidate, and `stale` requires
 * one that does not. A row that no longer describes the candidate may say `passed` - that is
 * what `recordedOutcome` is for - but nothing on the card may read `passed` because of it,
 * and a row that does count cannot be reported as stale either (F20-AC3, F24-AC3).
 *
 * A check reading `passed` with no observation at all is the sharpest case: there is nothing
 * behind the green at all, which is a fabricated pass rather than a stale one (F20-AC2).
 *
 * The loop this is called from walks every check, criterion and owner test on the card rather
 * than stopping at the first disagreement, because the wrong answer is served if *any* one of
 * them is a stale pass - one green panel is enough to make the card lie.
 */
function verdictIsSupported(
  card: MvpReviewCardView,
  verdict: { readonly what: string; readonly state: string; readonly evidenceId: string | null },
): boolean {
  const row =
    verdict.evidenceId === null ? undefined : card.evidence.find((entry) => entry.evidenceId === verdict.evidenceId);
  const counts = row !== undefined && row.countsForCurrentCandidate;
  // `passed` needs an observation that counts; `stale` needs one that does not. Everything
  // else - `pending`, `unverified`, `not_run`, `failed`, `capture_failed` - is a refusal of a
  // claim rather than a claim of success, so it needs nothing behind it. That asymmetry is
  // the rule: this check can only be too strict about a claim of success, never about a
  // refusal to claim one.
  if (verdict.state === 'passed') return counts;
  if (verdict.state === 'stale') return !counts;
  return true;
}

/**
 * Whether the card's staleness summary tells the same story as its rows.
 *
 * `staleness` is what a client puts at the top of the page, so it has to be derivable from
 * the rows below it rather than maintained beside them: a card whose rows include a stale
 * observation while its summary reports nothing stale is a card whose headline contradicts
 * its table, and the owner would be told a stale candidate is current (F20-AC3, F25-AC3).
 * Compared as sets, because the summary is a list of identities and their order is not a
 * claim.
 */
function stalenessSummaryAgrees(card: MvpReviewCardView, reply: FastifyReply): boolean {
  const notCounting = new Set(card.evidence.filter((row) => !row.countsForCurrentCandidate).map((row) => row.evidenceId));
  const listed = new Set(card.staleness.staleEvidenceIds);
  const missing = [...notCounting].filter((id) => !listed.has(id));
  const extra = [...listed].filter((id) => !notCounting.has(id));
  if (missing.length > 0 || extra.length > 0) {
    refuse(
      reply,
      `The card's staleness summary does not match its evidence. Not counted for this candidate and not listed: ${missing.join(', ') || 'none'}. Listed as stale but counted: ${extra.join(', ') || 'none'}. A client reading the summary rather than every row would be told something the rows contradict (F20-AC3, F25-AC3).`,
    );
    return false;
  }
  const expected = notCounting.size > 0 || card.staleness.staleDecisionIds.length > 0;
  if (card.staleness.stale !== expected || (card.staleness.stale && card.staleness.reasons.length === 0)) {
    refuse(
      reply,
      `The card reports staleness=${String(card.staleness.stale)} with ${card.staleness.staleDecisionIds.length} stale decision(s) and ${notCounting.size} stale observation(s), which cannot both be true. A card that is stale says why (F20-AC3).`,
    );
    return false;
  }
  return true;
}

/**
 * Whether one evidence row tells one story about its own staleness.
 *
 * `countsForCurrentCandidate` is the affirmative flag and `currentOutcome` is its
 * consequence, so the two must agree: a row cannot both count for this candidate and read
 * `stale`, and a row that reads `stale` must say why. A row that counts must also name the
 * commit it observed, and that commit must be the candidate's — evidence for SHA A cannot
 * prove SHA B, and a row that names no commit is not evidence for any (F20-AC3).
 */
function isStaleConsistent(evidence: MvpReviewCardView['evidence'][number], headSha: string): boolean {
  if (evidence.countsForCurrentCandidate) {
    if (evidence.currentOutcome === 'stale') return false;
    if (evidence.candidateHeadSha === null || evidence.candidateHeadSha !== headSha) return false;
    return evidence.staleReasons.length === 0;
  }
  if (evidence.currentOutcome !== 'stale') return false;
  return evidence.staleReasons.length > 0;
}

/**
 * Checks that the decision on the card is the decision this call made.
 *
 * Seven facts, each of which a response could otherwise get wrong: the kind, the owner it is
 * attributed to, the request and the contract it belongs to, the candidate it names, the full
 * commit and the contract revision it binds. All seven are compared, because the decision is
 * the one object on the card that is returned as *this call's* answer, and a card carrying a
 * decision about another candidate would otherwise be answered with it (F02-AC2, F24-AC4,
 * F25-AC2, F25-AC3).
 *
 * The owner is compared against the proved session, so a decision recorded under somebody
 * else's identity is refused rather than returned (F01-AC1, F25-AC4). The request, contract and
 * candidate are compared against the card's own, which the path proved above: a decision naming
 * a candidate this path never addressed is the cross-project boundary failing one layer later
 * than it is checked (F02-AC2).
 */
function checkDecisionBinding(
  card: MvpReviewCardView,
  submitted: {
    readonly decision: 'accepted' | 'changes_requested';
    readonly headSha: string;
    readonly contractRevision: number;
    readonly ownerId: OwnerId;
  },
  reply: FastifyReply,
): { readonly ok: true } | null {
  if (card.decision.outcome !== submitted.decision) {
    refuse(
      reply,
      `The decision recorded is ${card.decision.outcome} rather than the ${submitted.decision} this request asked for, so the response is not returned as the answer to it (F24-AC4).`,
    );
    return null;
  }
  const decision = card.decision.decision;
  if (decision === null) {
    refuse(
      reply,
      `The card reports a ${submitted.decision} decision and carries no decision to show, so nothing is returned that would let it read as recorded (F25-AC2).`,
    );
    return null;
  }
  // The three identities a decision is *about*, before the commit it is bound to. Checked
  // here rather than left to `checkedCard` because `checkedCard` proves the card's candidate
  // and the path agree, which says nothing about the decision nested inside it: a card about
  // `cand-checkout` carrying a decision about `cand-checkout-other` is a card whose two halves
  // contradict each other, and returning it answers this call with another candidate's decision.
  // A decision is refused rather than corrected, because a response that reports a decision
  // other than the one recorded is worse than no response (F02-AC2, F25-AC2).
  for (const [what, recorded, expected] of [
    ['request', decision.requestId, card.request.requestId],
    ['contract', decision.contractId, card.contract.contractId],
    ['candidate', decision.candidateId, card.candidate.candidateId],
  ] as const) {
    if (recorded !== expected) {
      refuse(
        reply,
        `The recorded decision names ${what} ${recorded} rather than ${expected}, which is the one this request was about, so the response is not returned as this request's decision (F02-AC2, F25-AC2).`,
      );
      return null;
    }
  }
  if (decision.candidateHeadSha !== submitted.headSha) {
    refuse(
      reply,
      `The recorded decision names commit ${decision.candidateHeadSha} rather than ${submitted.headSha}, which is the commit this request decided about (F24-AC4, F25-AC3).`,
    );
    return null;
  }
  if (decision.contractRevision !== submitted.contractRevision) {
    refuse(
      reply,
      `The recorded decision names contract revision ${decision.contractRevision} rather than ${submitted.contractRevision}, which is the revision this request decided about (F24-AC4).`,
    );
    return null;
  }
  if (String(decision.ownerId) !== String(submitted.ownerId)) {
    refuse(
      reply,
      'The recorded decision is attributed to a different owner than the session that made this request, so it is not returned as this owner\'s decision (F01-AC1, F25-AC4).',
    );
    return null;
  }
  if (decision.kind !== submitted.decision) {
    refuse(
      reply,
      `The recorded decision is a ${decision.kind} while this request asked for a ${submitted.decision}, so the two cannot both describe what happened (F25-AC2).`,
    );
    return null;
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Boundary refusals                                                          */
/* -------------------------------------------------------------------------- */

/** Bounds a value quoted in a refusal, so an unreadable provider string is not echoed whole. */
function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

/** Answers with a 503 and a named reason, for a fact this transport could not verify. */
function refuse(reply: FastifyReply, reason: string): FastifyReply {
  return sendProblem(reply, problemFor({ code: 'Unavailable', reason }));
}