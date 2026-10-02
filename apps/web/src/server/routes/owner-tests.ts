/**
 * Owner test routes: record one manual criterion observation, and read what is bound to one
 * exact candidate identity (F23-AC1, F23-AC2, F23-AC3, F23-AC4, F23-AC5, F24-AC4, F25-AC1,
 * F25-AC4, F01-AC1, F01-AC4, F02-AC4).
 *
 * Every route sits behind the session guard and every body is validated by a `strictObject`
 * schema at this boundary, so a handler never sees an unvalidated value and an unrecognised
 * key is refused rather than dropped (F02-AC4).
 *
 * Four decisions are structural rather than documented, and each is one a reader would
 * otherwise have to re-derive:
 *
 *   - **The body cannot name the observer.** There is no `actor`, `observedBy` or `observedAt`
 *     field, and `strictObject` refuses an unrecognised key by name, so a request that tries to
 *     attribute its observation to another owner or another instant is answered with a field
 *     error instead of being silently ignored. The actor is the session the guard proved and
 *     the instant is the server's clock (F25-AC1, F25-AC4, F01-AC1). This is also what stops
 *     the agent-facing path from reaching the write with a claim of its own: there is nothing
 *     here for it to claim with.
 *   - **The identity is submitted, not resolved.** `expectedCandidateFingerprint` is required
 *     and is what the owner's page was rendered against; the controller compares it against the
 *     candidate the run currently offers and answers a `Conflict` naming both when they differ.
 *     Had this route looked the current candidate up and recorded against it, an action taken
 *     from an outdated card would silently land on a build nobody tested (F24-AC4, F20-AC3).
 *   - **The deployment is a required union, not an optional string.** `observedAgainst` is
 *     either a named deployment or the owner's explicit statement that none applies, with a
 *     reason. There is no "leave it blank" shape, so a local check or an unrelated preview can
 *     never be recorded as the thing the owner looked at (F23-AC4, F22-AC1).
 *   - **The observation kind distinguishes a capture failure from a behaviour failure.**
 *     `CaptureFailed` is its own member and produces its own reported outcome, so nothing the
 *     owner reports can collapse "I could not capture it" into "it is broken" (F23-AC5).
 *
 * The write answers `200` rather than `201` for the same reason the acceptance routes do: it
 * records a decision about work that already exists, and no new resource is created. The read
 * answers `200` with an empty list rather than a refusal for a candidate nothing has been
 * observed against, because "this build has no owner observations" is the answer an owner
 * asking whether they have already tested it wants (F23-AC1).
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
import { asJobId, type ControllerSurface } from '../contracts.ts';
import type { SessionGuard } from '../auth-guard.ts';

const MAXIMUM_SHORT_TEXT = 2_000;
const MAXIMUM_REFERENCE = 512;

const runParams = z.strictObject({
  jobId: z.string().trim().min(1, 'A job id is required.').max(128, 'A job id may be at most 128 characters.'),
});

/**
 * The candidate fingerprint the owner's page was rendered against (F24-AC4).
 *
 * Required rather than defaulted to "whatever is current": that default would make an action
 * from an outdated card record against a build its author never looked at, which is the exact
 * failure F24-AC4 exists to prevent.
 */
const candidateFingerprint = z
  .string()
  .trim()
  .min(1, 'Name the candidate fingerprint this observation was made against (F23-AC3, F24-AC4).')
  .max(200, 'A candidate fingerprint may be at most 200 characters.');

/** One named deployment of this candidate (F22-AC1, F23-AC3). */
const deploymentTarget = z.strictObject({
  kind: z.literal('Deployment'),
  component: z.string().trim().min(1, 'Name the component the deployment belongs to (F22-AC1).').max(120),
  deploymentId: z.string().trim().min(1, 'Name the deployment identity (F23-AC3).').max(200),
  environment: z.string().trim().min(1, 'Name the environment the deployment belongs to (F23-AC3).').max(120),
});

/**
 * The owner's explicit statement that nothing is deployed for this candidate (F23-AC3).
 *
 * A reason is required, because an unexplained absence is indistinguishable from a caller who
 * did not fill the field in, and the stored record has to say which it was.
 */
const noDeploymentTarget = z.strictObject({
  kind: z.literal('NoDeployment'),
  reason: z
    .string()
    .trim()
    .min(1, 'Say why no deployment applies, so the record is not an unexplained absence (F23-AC3).')
    .max(MAXIMUM_SHORT_TEXT),
});

/**
 * One manual criterion observation (F23-AC1, F23-AC5).
 *
 * Three fields are deliberately absent. There is no actor, because the observer is the
 * session this request proved (F25-AC4). There is no observed instant, because it is the
 * server's clock and a client that could set it could backdate the record (F23-AC3). And there
 * is no candidate, because the run decides which candidate this is and the fingerprint below
 * decides whether that is still the current one (F24-AC4).
 */
const observationBody = z.strictObject({
  criterionId: z
    .string()
    .trim()
    .min(1, 'Name the acceptance criterion this observation is about (F23-AC1).')
    .max(120, 'A criterion id may be at most 120 characters.'),
  expectedCandidateFingerprint: candidateFingerprint,
  observation: z.enum(['BehaviorConfirmed', 'BehaviorFailed', 'CaptureFailed'], {
    error:
      'Report what you observed: the behaviour was confirmed, the behaviour failed, or the capture itself never happened (F23-AC5).',
  }),
  observedAgainst: z.discriminatedUnion('kind', [deploymentTarget, noDeploymentTarget], {
    error: 'Name the deployment you observed, or state explicitly that none applies (F23-AC3, F23-AC4).',
  }),
  evidence: z.strictObject({
    kind: z.enum(['Screenshot', 'ApiExchange', 'CheckOutput'], {
      error: 'An observation points at a screenshot, a sanitized request/result, or retained output (F23-AC2).',
    }),
    reference: z
      .string()
      .trim()
      .min(1, 'Name the retained evidence, so the claim points at something that exists (F23-AC2).')
      .max(MAXIMUM_REFERENCE, 'An evidence reference may be at most 512 characters.'),
  }),
  note: z.string().trim().max(MAXIMUM_SHORT_TEXT, 'A note is too long.').nullable().default(null),
});

/** The identity the observations of one candidate are read for (F20-AC3). */
const observationQuery = z.strictObject({
  candidateFingerprint,
});

export interface OwnerTestRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
}

export function registerOwnerTestRoutes(app: FastifyInstance, options: OwnerTestRouteOptions): void {
  /**
   * Records what the owner observed for one criterion (F23-AC1, F25-AC1, F24-AC4).
   *
   * The owner comes from the guard and never from the body, and the answer is a report: the
   * recorded observation together with the criteria still outstanding, so a client cannot show
   * a single recorded result as an approved build (F24-AC3).
   */
  app.post('/api/runs/:jobId/owner-observations', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(runParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(observationBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    const recorded = await options.controller.ownerTests.recordOwnerObservation({
      jobId: asJobId(params.value.jobId),
      criterionId: body.value.criterionId,
      expectedCandidateFingerprint: body.value.expectedCandidateFingerprint,
      observation: body.value.observation,
      observedAgainst: body.value.observedAgainst,
      evidence: body.value.evidence,
      note: body.value.note,
      actor: session.ownerId,
    });
    if (!recorded.ok) return sendProblem(reply, problemFor(recorded.error));
    return reply.status(200).send({ report: recorded.value });
  });

  /**
   * What has been observed against one exact candidate (F20-AC3, F23-AC1).
   *
   * A read with no caller in its body, following the rule every other read here follows: the
   * journal is the authority and a query cannot be authorized by a request (F01-AC1). The
   * fingerprint is required, because an answer spanning every identity would read as one build
   * having inherited another's observations.
   */
  app.get('/api/runs/:jobId/owner-observations', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(runParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const query = parseBody(observationQuery, request.query);
    if (!query.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(query.problem)));

    const listed = await options.controller.ownerTests.listOwnerObservations({
      jobId: asJobId(params.value.jobId),
      candidateFingerprint: query.value.candidateFingerprint,
    });
    if (!listed.ok) return sendProblem(reply, problemFor(listed.error));
    return reply.status(200).send({ observations: listed.value });
  });
}