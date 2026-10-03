/**
 * The two evidence write paths, over HTTP (mvp-spec 3, F20-AC2, F20-AC3, F23-AC1, F25-AC4).
 *
 * Before this file, a criterion could not leave `unverified` and an owner test could not leave
 * `pending`: the use cases that record an observation existed and were reachable from nothing. It
 * did not follow that one route could reach both. They are two routes, and the split is the
 * product, not a layering preference:
 *
 *   - `POST .../verify` is **server-controlled**. Its request schema carries an optional requested
 *     method and nothing else. There is no `result`, no `outcome`, no `checkId`, no `criterionId`,
 *     no `headSha` and no `evidenceId` on it, because every one of those would be a way for the
 *     browser to state what a check concluded. The server reads the provider and derives the
 *     verdicts; a body that carries one is refused *by name*, so a client that believes it chose
 *     the result is told that result is not its to choose (F20-AC2, F23-AC1).
 *   - `POST .../criteria/:criterionId/owner-test` is **owner-controlled**, because the owner's own
 *     test is an observation rather than a measurement and there is no provider to read it from.
 *     It may carry `result` and a `note`, and it may carry nothing else - no owner, no instant, no
 *     commit. The owner is the proved session (F01-AC1, F25-AC4).
 *
 * Five properties make up the work, and each exists to make a specific wrong answer unreachable:
 *
 *   - **The two cannot be crossed.** The automated route has no criterion parameter and derives
 *     every subject it records from the provider's own check identities; the owner route has a
 *     criterion parameter and refuses any criterion the contract does not declare `owner_test`.
 *     Neither route can be used to discharge the other's step, which is the F23-AC1 rule in the
 *     only place a transport could have broken it (F20-AC2, F23-AC1).
 *   - **Identity is the full SHA, and it comes from the stored candidate.** The route checks the
 *     commit on every report it returns is a full 40-character SHA, that it is the candidate on
 *     screen, and - for the owner path - that the stored candidate row and the report agree. A
 *     report naming a branch, an abbreviation or a pull request number is refused rather than
 *     rendered (mvp-spec 3, F20-AC3, F24-AC4).
 *   - **A report cannot claim more than its observations.** Every recorded row is checked against
 *     the card it comes with: `countsForCurrentCandidate` must agree with `currentOutcome`, a
 *     counting row must name the candidate head, and a non-counting row must say why it does not.
 *     This is the same check `routes/review.ts` applies to a card, and a report that skipped it
 *     would be a way to render a stale pass in green (F20-AC3, F24-AC3).
 *   - **A provider failure is a refusal, not a report.** `Unavailable` becomes a 503 naming the
 *     missing wiring; nothing was recorded and nothing is claimed to have been verified. A 200
 *     with an empty `recorded` list would read as "nothing failed", which is the one thing it must
 *     never mean (F03-AC2, F20-AC2).
 *   - **The project is proven twice.** The project travels in the path, the owner comes from the
 *     proved session, and the response's own project and candidate identities are checked against
 *     the path before anything is returned (F02-AC2, F01-AC1).
 *
 * Reused rather than rewritten: the domain's `isCommitSha` is the only definition of what may
 * stand in for a commit identity; the zod params schema matches `routes/review.ts`; the verdict
 * mapping, the staleness comparison and every eligibility judgement are the use case's, passed
 * through rather than restated.
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
import type {
  ControllerSurface,
  MvpOwnerTestReportView,
  MvpRecordedObservationView,
  MvpReviewCardView,
  MvpVerificationReportView,
} from '../contracts.ts';
import type { SessionGuard } from '../auth-guard.ts';

/* -------------------------------------------------------------------------- */
/* Request schemas                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One project and one candidate.
 *
 * Identical to `routes/review.ts` and `routes/candidates.ts`, and repeated for the same reason
 * those repeat it: the project value addresses a workspace and a git checkout downstream, so a
 * traversal here is a traversal there (F06-AC1, F02-AC2).
 */
const verificationParams = z.strictObject({
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

/** The same two, plus the criterion the owner says they tested. */
const ownerTestParams = verificationParams.extend({
  criterionId: z
    .string()
    .trim()
    .min(1, 'An owner test records a criterion, so name the one that was tested.')
    .max(128, 'A criterion id may be at most 128 characters.'),
});

/**
 * The methods a caller may ask for.
 *
 * One member, and the request body may be absent entirely. The member exists so a client can be
 * explicit about wanting the provider read rather than relying on it, not so a client can pick
 * where a verdict comes from - which is why it is a closed enum with a single case. Widening this
 * is how "the browser chooses the verification source" would start, so a second member has to be
 * justified by a second *server* implementation of one (F20-AC2).
 */
const verificationMethod = z.enum(['github_checks'], {
  error: 'Expected "github_checks": the only automated method this deployment runs is the provider check read.',
});

/**
 * The automated verification request.
 *
 * `strictObject`, one optional member, `nullish`, and **the absence of more is the point**. There is
 * no `result`, `outcome`, `checkId`, `criterionId`, `headSha`, `candidateId` or `evidenceId`: every
 * one of those would be a member through which a client could assert what a check concluded, and
 * the server derives all of them from the provider read. A body carrying any of them is refused by
 * name through `fieldErrorsOf`'s `unrecognized_keys` handling rather than silently dropped, so a
 * client that believes it stated the result is told the result is not the client's to state
 * (F20-AC2, F23-AC1).
 */
const verificationBody = z.strictObject({
  method: verificationMethod.optional(),
}).nullish();

/**
 * What the owner may report.
 *
 * `result` is required and `note` is optional; that is the whole vocabulary. There is no
 * `ownerId`, `observedBy`, `observedAt`, `headSha`, `evidenceId` or `verificationType`: the owner
 * is the session, the instant is the controller's clock, the commit is the stored candidate's, the
 * evidence identity is derived from what was observed, and whether a criterion may be an owner test
 * at all is the contract's to say (F01-AC1, F23-AC1, F25-AC4).
 *
 * `result` is an enum of exactly two outcomes. `capture_failed` exists in the domain vocabulary
 * for "the screenshot was never taken", which is not a statement about the product, and this
 * transport does not accept it: a criterion whose capture failed is left `unverified`, which is the
 * honest state, rather than being filed as a behaviour failure the owner did not observe
 * (F23-AC5).
 */
const ownerTestBody = z.strictObject({
  result: z.enum(['passed', 'failed'], {
    error: 'An owner test is either "passed" or "failed". There is no third answer that is not a claim about the product.',
  }),
  note: z
    .string()
    .max(8000, 'A note is too long to record against an owner test.')
    .nullish()
    .transform((value) => value ?? null),
});

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The owner a request proved.
 *
 * Local rather than shared, for the reason `routes/review.ts` is local: reads and writes are both
 * behind the guard, so a null session is a wiring fault rather than an expected outcome, and
 * substituting an empty identity would hand the use case a caller nobody is (F01-AC1).
 */
function provedOwnerOf(
  request: { readonly session: { readonly ownerId: OwnerId } | null },
  reply: FastifyReply,
): OwnerId | null {
  if (request.session !== null) return request.session.ownerId;
  sendProblem(reply, signInRequiredProblem());
  return null;
}

export interface VerificationRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
  /** The transport's instant, used only for the correlation identity (F01-AC1, F25-AC4). */
  readonly now: () => Date;
}

export function registerVerificationRoutes(app: FastifyInstance, options: VerificationRouteOptions): void {
  /**
   * The correlation identity each write carries.
   *
   * Derived from this request's own instant rather than from a counter, so two requests never share
   * one and a trace can be followed from this log entry into the adapter call (mvp-spec 7).
   */
  const correlationId = (): string => `http-verify-${options.now().toISOString()}`;

  /**
   * Read the provider and record what it said.
   *
   * `POST` because the owner asked for a fresh observation and something was written durably.
   * Behind the session guard and therefore behind CSRF.
   *
   * 200 with the report *and* the card it produced, rather than 201: a re-run over an unchanged
   * provider writes no new row, so "created" would be a claim this transport cannot make about
   * how many observations exist. Every refusal keeps its own status - `503` for a deployment with no
   * provider or a provider that would not answer, `404` for a candidate this project does not hold,
   * `409` for a submission against facts that moved - and each says what was and was not recorded
   * (F20-AC2, F24-AC4, F02-AC2).
   */
  app.post('/api/projects/:projectId/candidates/:candidateId/verify', { preHandler: options.guard }, async (request, reply) => {
    const owner = provedOwnerOf(request, reply);
    if (owner === null) return reply;
    const params = parseBody(verificationParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(verificationBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    const recorded = await options.controller.mvpReview.recordVerification({
      projectId: params.value.projectId,
      candidateId: params.value.candidateId,
      actor: String(owner),
      correlationId: correlationId(),
    });
    if (!recorded.ok) return sendProblem(reply, problemFor(recorded.error));

    const report = checkedVerification(recorded.value, params.value.projectId, params.value.candidateId, reply);
    if (report === null) return reply;
    return reply.status(200).send({ verification: report.value });
  });

  /**
   * The owner's own test of one criterion.
   *
   * `POST` behind the guard and behind CSRF. The criterion is in the path because it is the thing
   * the owner acted on; `result` and `note` are in the body; the owner and the instant are not in
   * either (F23-AC1, F25-AC4).
   *
   * 200 with the record and the card it produced. A refused write leaves nothing behind, and the
   * refusals keep their own statuses: `404` for a candidate this project does not hold or a
   * criterion the revision does not declare, `400` for an automated criterion, because that is a
   * request the endpoint cannot serve rather than a fact it discovered about the product
   * (F23-AC1, F02-AC2).
   */
  app.post(
    '/api/projects/:projectId/candidates/:candidateId/criteria/:criterionId/owner-test',
    { preHandler: options.guard },
    async (request, reply) => {
      const owner = provedOwnerOf(request, reply);
      if (owner === null) return reply;
      const params = parseBody(ownerTestParams, request.params);
      if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
      const body = parseBody(ownerTestBody, request.body);
      if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

      const recorded = await options.controller.mvpReview.recordOwnerTest({
        projectId: params.value.projectId,
        candidateId: params.value.candidateId,
        actor: String(owner),
        criterionId: params.value.criterionId,
        outcome: body.value.result,
        note: body.value.note,
      });
      if (!recorded.ok) return sendProblem(reply, problemFor(recorded.error));

      const report = checkedOwnerTest(
        recorded.value,
        params.value.projectId,
        params.value.candidateId,
        params.value.criterionId,
        reply,
      );
      if (report === null) return reply;
      return reply.status(200).send({ ownerTest: report.value });
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Projection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Checks a verification report before it is returned.
 *
 * Re-derived here rather than trusted, so a report that contradicts itself is refused instead of
 * sent:
 *
 *   - the project, the candidate and the contract revision are the ones the path named, so a
 *     report about another project cannot be read through this project's path (F02-AC2);
 *   - both commit identities are full 40-character SHAs, and the bound one is the candidate's own
 *     head. A branch name, an abbreviation and a pull request number cannot stand in for a build
 *     (mvp-spec 3, F20-AC3);
 *   - the method is the one this transport can state, so a client is never handed a report whose
 *     source it cannot name (F20-AC2);
 *   - every recorded observation agrees with itself about staleness, and with the card it came
 *     from: a counting row names the candidate head and does not read `stale`; a non-counting row
 *     reads `stale` and says why. This is the check that stops a stale pass being rendered green
 *     (F20-AC3, F24-AC3);
 *   - the card is the card of the same candidate, revision and commit.
 *
 * Returns null after answering the reply, so a caller cannot send a partial body by accident.
 */
function checkedVerification(
  report: MvpVerificationReportView,
  projectId: string,
  candidateId: string,
  reply: FastifyReply,
): { readonly value: MvpVerificationReportView } | null {
  if (report.projectId !== projectId || report.candidateId !== candidateId) {
    refuse(
      reply,
      `The report is about candidate ${report.candidateId} of project ${report.projectId}, not ${candidateId} of ${projectId}, so it is not returned through this project's path (F02-AC2).`,
    );
    return null;
  }
  if (report.method !== 'github_checks') {
    refuse(
      reply,
      `The report names verification method "${truncate(String(report.method))}", which is not one this transport can state. A result whose source cannot be named cannot be reviewed (F20-AC2).`,
    );
    return null;
  }

  const candidateHead = requireFullSha(report.candidateHeadSha, 'candidate head SHA', 'The verification report', reply);
  if (candidateHead === null) return null;
  // The provider's head is checked rather than required to match: after a push the two differ, and
  // that difference is the finding the owner needs, not a reason to withhold the report (F20-AC3).
  if (requireFullSha(report.providerHeadSha, 'provider head SHA', 'The verification report', reply) === null) return null;

  const card = checkedCard(report.review, projectId, candidateId, candidateHead, reply);
  if (card === null) return null;
  if (card.contract.revision !== report.contractRevision) {
    refuse(
      reply,
      `The report binds contract revision ${report.contractRevision} while the card it carries is revision ${card.contract.revision}. One verification pass cannot describe two agreements (F24-AC4).`,
    );
    return null;
  }

  const observations: MvpRecordedObservationView[] = [];
  for (const observation of report.recorded) {
    if (!isStaleConsistent(observation, candidateHead)) {
      refuse(
        reply,
        `Observation ${observation.evidenceId} reports recordedOutcome=${observation.recordedOutcome}, currentOutcome=${observation.currentOutcome} and countsForCurrentCandidate=${String(observation.countsForCurrentCandidate)}, which cannot all be true at once. A report that both counts and discounts a result is refused rather than returned (F20-AC3, F24-AC3).`,
      );
      return null;
    }
    // The card must agree with the report about the same row. Two objects describing one
    // observation differently is precisely how a stale pass reaches a green card (F24-AC2).
    const row = card.evidence.find((entry) => entry.evidenceId === observation.evidenceId);
    if (row === undefined) {
      refuse(
        reply,
        `The report records observation ${observation.evidenceId} but the card it carries has no such evidence row, so the two disagree about what was observed (F24-AC2).`,
      );
      return null;
    }
    if (row.currentOutcome !== observation.currentOutcome || row.countsForCurrentCandidate !== observation.countsForCurrentCandidate) {
      refuse(
        reply,
        `Observation ${observation.evidenceId} is ${observation.currentOutcome} in the report and ${row.currentOutcome} on the card it carries. The two are one pass and cannot disagree (F24-AC2).`,
      );
      return null;
    }
    observations.push(observation);
  }

  return {
    value: {
      ...report,
      candidateHeadSha: candidateHead,
      recorded: observations,
      review: card,
    },
  };
}

/**
 * Whether one observation tells one story about its own staleness.
 *
 * `countsForCurrentCandidate` is the affirmative flag and `currentOutcome` is its consequence, so
 * the two must agree: a row cannot both count for this candidate and read `stale`, and a row that
 * counts must name the commit it observed, which must be the candidate's. A result recorded for
 * SHA A cannot prove SHA B, and a row that names no commit is evidence for no candidate at all
 * (F20-AC3, F24-AC3).
 */
function isStaleConsistent(observation: MvpRecordedObservationView, headSha: string): boolean {
  if (observation.countsForCurrentCandidate) {
    if (observation.currentOutcome === 'stale') return false;
    if (observation.observedHeadSha !== headSha) return false;
    return observation.observedContractRevision !== null;
  }
  return observation.currentOutcome === 'stale';
}

/**
 * Checks the common card facts for either report.
 *
 * A smaller sibling of `routes/review.ts`'s `checkedCard`, and deliberately not shared with it: a
 * shared module would make a change to this boundary a change to that route's boundary too. What is
 * common is what both need - the project, the candidate, a full head SHA, and evidence rows that
 * agree with themselves about staleness - and each file checks it for itself (F24-AC2).
 */
function checkedCard(
  card: MvpReviewCardView,
  projectId: string,
  candidateId: string,
  headSha: string,
  reply: FastifyReply,
): MvpReviewCardView | null {
  if (card.candidate.candidateId !== candidateId || card.candidate.projectId !== projectId) {
    refuse(
      reply,
      `The card is about candidate ${card.candidate.candidateId} of project ${card.candidate.projectId}, not ${candidateId} of ${projectId}, so it is not returned through this project's path (F02-AC2).`,
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
  if (card.candidate.headSha !== headSha) {
    refuse(
      reply,
      `The report is bound to ${headSha} while the card it carries is for ${card.candidate.headSha}. One verification pass cannot describe two builds (F20-AC3, F24-AC4).`,
    );
    return null;
  }
  for (const row of card.evidence) {
    if (row.countsForCurrentCandidate) {
      if (row.currentOutcome === 'stale') {
        refuse(
          reply,
          `Evidence ${row.evidenceId} both counts for this candidate and reads stale. The two cannot be true at once, so the card is not returned (F20-AC3).`,
        );
        return null;
      }
      if (row.candidateHeadSha !== headSha) {
        refuse(
          reply,
          `Evidence ${row.evidenceId} counts for this candidate while naming commit "${truncate(String(row.candidateHeadSha))}". A result recorded for one commit cannot prove another (F20-AC3).`,
        );
        return null;
      }
    } else if (row.currentOutcome !== 'stale' || row.staleReasons.length === 0) {
      refuse(
        reply,
        `Evidence ${row.evidenceId} does not count for this candidate yet does not read stale, and names no reason. A discounted observation must say why (F24-AC3).`,
      );
      return null;
    }
  }
  return card;
}

/**
 * Checks an owner-test report before it is returned.
 *
 * Beyond the card checks, three facts this route alone can be wrong about:
 *
 *   - the criterion is the one in the path, so a report cannot answer a different criterion's
 *     request (F23-AC1);
 *   - the outcome is the one submitted, so a response cannot report a pass for a request that
 *     asked for a failure or the reverse (F25-AC2);
 *   - the evidence row behind it is an `owner_test`, attributed to the session that made the
 *     call. A report claiming an owner test was passed by anything else is refused rather than
 *     returned, because that is the assertion the whole product exists to keep honest
 *     (F23-AC1, F25-AC4).
 */
function checkedOwnerTest(
  report: MvpOwnerTestReportView,
  projectId: string,
  candidateId: string,
  criterionId: string,
  reply: FastifyReply,
): { readonly value: MvpOwnerTestReportView } | null {
  if (report.projectId !== projectId || report.candidateId !== candidateId) {
    refuse(
      reply,
      `The owner-test record is about candidate ${report.candidateId} of project ${report.projectId}, not ${candidateId} of ${projectId}, so it is not returned through this project's path (F02-AC2).`,
    );
    return null;
  }
  if (report.criterionId !== criterionId) {
    refuse(
      reply,
      `The record is for criterion ${report.criterionId} rather than ${criterionId}, which this request asked about, so it is not returned as the answer to it (F23-AC1).`,
    );
    return null;
  }

  const candidateHead = requireFullSha(report.candidateHeadSha, 'candidate head SHA', 'The owner-test record', reply);
  if (candidateHead === null) return null;

  const card = checkedCard(report.review, projectId, candidateId, candidateHead, reply);
  if (card === null) return null;
  if (card.contract.revision !== report.contractRevision) {
    refuse(
      reply,
      `The record binds contract revision ${report.contractRevision} while the card it carries is revision ${card.contract.revision}. One observation cannot describe two agreements (F24-AC4).`,
    );
    return null;
  }

  const row = card.evidence.find((entry) => entry.evidenceId === report.evidenceId);
  if (row === undefined) {
    refuse(
      reply,
      `The record names evidence ${report.evidenceId} but the card it carries has no such row, so nothing is returned that would let it read as recorded (F25-AC2).`,
    );
    return null;
  }
  if (row.source !== 'owner_test') {
    refuse(
      reply,
      `Evidence ${report.evidenceId} came from source "${row.source}" rather than from an owner test. Only the owner may discharge an owner test, and no automated result or agent output can stand in for that (F23-AC1, F25-AC4).`,
    );
    return null;
  }
  if (row.criterionId !== report.criterionId) {
    refuse(
      reply,
      `Evidence ${report.evidenceId} speaks for criterion "${truncate(String(row.criterionId))}" rather than ${report.criterionId}, so it is not returned as this criterion's observation (F23-AC1).`,
    );
    return null;
  }
  if (row.recordedOutcome !== report.outcome) {
    refuse(
      reply,
      `The record reports outcome ${report.outcome} while its evidence row recorded ${row.recordedOutcome}. The two are one observation and cannot disagree (F25-AC2).`,
    );
    return null;
  }

  // The criterion must be one the contract declares the owner's own, read from the card rather
  // than from the request, so a client cannot settle an automated criterion through this route
  // (F23-AC1).
  const criterion = card.contract.acceptanceCriteria.find((entry) => entry.id === report.criterionId);
  if (criterion === undefined) {
    refuse(
      reply,
      `Contract revision ${card.contract.revision} declares no criterion ${report.criterionId}, so there is nothing for the owner to have tested (F23-AC1).`,
    );
    return null;
  }
  if (criterion.verificationType !== 'owner_test') {
    refuse(
      reply,
      `Criterion ${report.criterionId} is verified automatically, so an owner test cannot discharge it. Changing the verification method is a contract decision, not an owner-test write (F23-AC1).`,
    );
    return null;
  }

  return {
    value: {
      ...report,
      candidateHeadSha: candidateHead,
      review: card,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Boundary refusals                                                          */
/* -------------------------------------------------------------------------- */

/** The domain's own rule for what may stand in for a commit identity. */
function isFullSha(value: string): boolean {
  return typeof value === 'string' && isCommitSha(value);
}

/** Refuses a value that is not a full commit SHA, naming what was expected. */
function requireFullSha(value: string, field: string, subject: string, reply: FastifyReply): string | null {
  if (isFullSha(value)) return value;
  refuse(
    reply,
    `${subject} reports ${field} "${truncate(String(value))}", which is not a full commit SHA. A branch name, an abbreviated SHA and a pull request number are routing facts rather than identity, so nothing is returned that would let one stand in for the candidate (mvp-spec 3).`,
  );
  return null;
}

/** Bounds a value quoted in a refusal, so an unreadable provider string is not echoed whole. */
function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

/** Answers with a 503 and a named reason, for a fact this transport could not verify. */
function refuse(reply: FastifyReply, reason: string): FastifyReply {
  return sendProblem(reply, problemFor({ code: 'Unavailable', reason }));
}