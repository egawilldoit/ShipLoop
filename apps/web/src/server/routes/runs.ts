/**
 * Run routes: start, read, the three lifecycle moves, the owner's limit decision and the
 * owner's acceptance decision (F13-AC1, F13-AC2, F13-AC3, F13-AC5, F17-AC1, F17-AC2,
 * F17-AC3, F17-AC4, F18-AC2, F24-AC2, F24-AC3, F25-AC1, F25-AC2, F25-AC4, F09-AC1,
 * F09-AC2, F12-AC1, F01-AC1, N01-AC3).
 *
 * Every route sits behind the session guard and every body is validated by a
 * `strictObject` schema at this boundary, so a handler never sees an unvalidated value and
 * an unrecognised key is refused rather than dropped (F02-AC4). Validation failures are
 * reported per field, because a form can only mark the inputs it knows about and one
 * combined message leaves the owner guessing which input to fix.
 *
 * Five decisions are structural rather than documented, and each is one a reader would
 * otherwise have to re-derive:
 *
 *   - **A start answers 201, 200 or 202, and the status is the claim.** 201 says a run was
 *     created. 200 says the operation identity had already created it, so nothing was
 *     created now and the one durable job is returned unchanged (F13-AC2). 202 says the run
 *     exists but the single global coding writer is held, and the response names the runs
 *     holding it — a 201 there would report a writer claim nobody has made (F13-AC2).
 *   - **The instants are the transport's.** `assessedAt` and `retrievedAt` are not accepted
 *     from a request body: they record when this process observed the request, and a client
 *     that could set them could backdate a readiness assessment (F09-AC4, F12-AC3).
 *   - **The readiness observation is the transport's translation of confirmations.** The
 *     form collects one confirmation per area and this route validates it; the domain still
 *     decides the verdict, and an unconfirmed area is refused by name with its remedy
 *     (F09-AC1, F09-AC2). No area is defaulted to satisfied anywhere on this path.
 *   - **Dependencies are not collected here.** A run references no dependency in this slice,
 *     so the domain records the Dependencies area as satisfied with the reason it had nothing
 *     to await; dependency planning is a planning concern, not a start-form one (F08-AC4).
 *   - **A run is read, never asserted.** The lifecycle routes return the queue's own
 *     committed row, so a `Paused` answer is a stored state and `writerStopped` is the
 *     lease's own answer about the writer rather than this layer's opinion (F17-AC1,
 *     N01-AC3).
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

const MAXIMUM_TEXT = 20_000;
const MAXIMUM_SHORT_TEXT = 2_000;

const JOB_MODES = ['Plan', 'Investigate', 'Build', 'Test', 'Review'] as const;

const runParams = z.strictObject({
  jobId: z.string().trim().min(1, 'A job id is required.').max(128, 'A job id may be at most 128 characters.'),
});

const acceptanceCriterion = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1, 'An acceptance criterion needs a stable id (F12-AC1).')
    .max(120, 'A criterion id may be at most 120 characters.'),
  text: z.string().trim().min(1, 'An acceptance criterion needs text (F12-AC1).').max(MAXIMUM_SHORT_TEXT),
});

const scopeBody = z.strictObject({
  issueId: z
    .string()
    .trim()
    .min(1, 'Name the issue this run works on (F12-AC1).')
    .max(128, 'An issue id may be at most 128 characters.'),
  issueIdentifier: z
    .string()
    .trim()
    .min(1, 'Name the issue as its provider labels it (F12-AC1).')
    .max(128, 'An issue identifier may be at most 128 characters.'),
  title: z.string().trim().min(1, 'The run needs a title (F12-AC1).').max(MAXIMUM_SHORT_TEXT),
  description: z.string().trim().min(1, 'The run needs the scope text (F12-AC1).').max(MAXIMUM_TEXT),
  providerRevision: z
    .string()
    .trim()
    .max(128, 'A provider revision may be at most 128 characters.')
    .nullable()
    .default(null),
  priority: z.string().trim().max(64, 'A priority may be at most 64 characters.').nullable().default(null),
  dependencyIssueIds: z.array(z.string().trim().min(1, 'A dependency id may not be blank.').max(128)).max(20).default([]),
  acceptanceCriteria: z
    .array(acceptanceCriterion)
    .min(1, 'A run records at least one acceptance criterion; a run with none cannot be reviewed (F12-AC1).')
    .max(50),
});

/**
 * One prerequisite confirmation (F09-AC1).
 *
 * `confirmed` and `note` are the whole observation this process can make: it has looked at
 * nothing on the owner's behalf, so a note is optional and a confirmation is a statement by
 * the owner rather than a fact this server discovered. The domain's `assessReadiness` reads
 * the assembled record and decides, so a confirmation here cannot start work on its own
 * (F09-AC2, F09-AC4).
 */
const readinessArea = z.strictObject({
  confirmed: z.boolean(),
  note: z.string().trim().max(MAXIMUM_SHORT_TEXT, 'A note about a prerequisite is too long.').nullable().default(null),
});

const startBody = z.strictObject({
  workItemId: z
    .string()
    .trim()
    .min(1, 'Name the work item this run works on (F13-AC1).')
    .max(128, 'A work item id may be at most 128 characters.'),
  mode: z.enum(JOB_MODES, { error: 'A run is Plan, Investigate, Build, Test or Review (F13-AC3).' }),
  operationId: z
    .string()
    .trim()
    .min(1, 'A stable operation identity is required, so a repeated Start returns the one run rather than a second (F13-AC2).')
    .max(200, 'An operation identity may be at most 200 characters.'),
  correlationId: z.string().trim().max(200, 'A correlation identity may be at most 200 characters.').nullable().default(null),
  scope: scopeBody,
  readiness: z.strictObject({
    scope: readinessArea,
    criteria: readinessArea,
    repository: readinessArea,
    target: readinessArea,
    verification: readinessArea,
    access: readinessArea,
  }),
});

const extensionBody = z.strictObject({
  decision: z.enum(['Grant', 'Decline'], {
    error: 'Decide whether to grant the extension or decline it (F18-AC2).',
  }),
});

/**
 * The owner's decision about the run's candidate (F25-AC1, F25-AC2, F25-AC4).
 *
 * Two commands behind one body rather than two routes, because they are one decision at
 * two moments — reject now, accept later — and a client that had to guess which route meant
 * which would eventually post a rejection to the accepting one. `decision` is the only
 * discriminator and it is required: a body with neither `reason` nor `note` is refused per
 * field rather than accepted as an empty decision (F02-AC4).
 */
const acceptanceBody = z
  .strictObject({
    decision: z.enum(['RequestChanges', 'Accept'], {
      error: 'Decide whether to accept this work or request changes (F25-AC1).',
    }),
    reason: z
      .string()
      .trim()
      .min(1, 'Say what is wrong, so the fix pass can act on it (F25-AC2).')
      .max(MAXIMUM_TEXT)
      .nullable()
      .default(null),
    note: z.string().trim().max(MAXIMUM_SHORT_TEXT, 'A note is too long.').nullable().default(null),
  })
  .refine((value) => value.decision !== 'RequestChanges' || value.reason !== null, {
    path: ['reason'],
    message: 'Requesting changes needs a reason; it is retained against the candidate you tested (F25-AC2).',
  });

export interface RunRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
  readonly now: () => Date;
}

export function registerRunRoutes(app: FastifyInstance, options: RunRouteOptions): void {
  /**
   * Starts a run, or reports the one this operation identity already started (F13-AC1, F13-AC2).
   *
   * The status is chosen from what the store did rather than from what the request asked
   * for: a fresh run with a free writer is 201, a repeat is 200 because nothing was created,
   * and a run queued behind the single global coding writer is 202 with the holder named.
   */
  app.post('/api/runs', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const body = parseBody(startBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const started = await options.controller.runs.startRun({
      workItemId: body.value.workItemId,
      mode: body.value.mode,
      operationId: body.value.operationId,
      correlationId: body.value.correlationId,
      scope: body.value.scope,
      readiness: body.value.readiness,
      at: options.now().toISOString(),
      actor: session.ownerId,
    });
    if (!started.ok) return sendProblem(reply, problemFor(started.error));
    const value = started.value;
    if (value.deduplicated) {
      return reply.status(200).send({
        run: value,
        disposition: 'AlreadyStarted',
        message: `Operation identity ${body.value.operationId} already started run ${value.job.jobId}. No second run was created (F13-AC2).`,
      });
    }
    if (value.dispatch.heldByWriter.length > 0) {
      return reply.status(202).send({
        run: value,
        disposition: 'QueuedBehindWriter',
        message: `Run ${value.job.jobId} is recorded and Queued, but the single global coding writer is held for ${value.dispatch.heldByWriter.join(', ')}, so no worker has claimed it (F13-AC2).`,
      });
    }
    return reply.status(201).send({ run: value, disposition: 'Started', message: value.dispatch.reason });
  });

  /** The recorded runs, oldest first (F13-AC1, N04-AC2). */
  app.get('/api/runs', { preHandler: options.guard }, async (_request, reply) => {
    const listed = await options.controller.runs.listRuns();
    if (!listed.ok) return sendProblem(reply, problemFor(listed.error));
    return reply.status(200).send({ runs: listed.value });
  });

  /** One run, its resume point and who holds the writer for it (F13-AC1, F17-AC2, F17-AC5). */
  app.get('/api/runs/:jobId', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(runParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const run = await options.controller.runs.getRun(asJobId(params.value.jobId));
    if (!run.ok) return sendProblem(reply, problemFor(run.error));
    return reply.status(200).send({ run: run.value });
  });

  /**
   * The resume point on its own (F17-AC2).
   *
   * A run with no recorded resume point is `NotFound` rather than a null body, so a client
   * cannot mistake "nothing was written" for "an empty resume point" and resume blind.
   */
  app.get('/api/runs/:jobId/checkpoint', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(runParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const run = await options.controller.runs.getRun(asJobId(params.value.jobId));
    if (!run.ok) return sendProblem(reply, problemFor(run.error));
    if (run.value.checkpoint === null) {
      return sendProblem(
        reply,
        problemFor({
          code: 'NotFound',
          reason: `Run ${params.value.jobId} has recorded no resume point, so there is nothing to show and nothing to resume from (F17-AC2).`,
        }),
      );
    }
    return reply.status(200).send({ checkpoint: run.value.checkpoint });
  });

  /**
   * Pauses a run (F17-AC1).
   *
   * The answer carries `writerStopped` and the writer's own disposition, because a pause may
   * only be shown as complete once the writer is stopped; a refusal here is a writer that is
   * still recorded, and its message is returned verbatim rather than summarised.
   */
  app.post('/api/runs/:jobId/pause', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(runParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const paused = await options.controller.runs.pauseRun(asJobId(params.value.jobId));
    if (!paused.ok) return sendProblem(reply, problemFor(paused.error));
    return reply.status(200).send({ run: paused.value });
  });

  /** Resumes a run from its recorded resume point (F17-AC3). */
  app.post('/api/runs/:jobId/resume', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(runParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const resumed = await options.controller.runs.resumeRun(asJobId(params.value.jobId));
    if (!resumed.ok) return sendProblem(reply, problemFor(resumed.error));
    return reply.status(200).send({ run: resumed.value });
  });

  /**
   * Cancels a run, reporting the resume point that survived and that no delivery was
   * touched (F17-AC4).
   */
  app.post('/api/runs/:jobId/cancel', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(runParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const cancelled = await options.controller.runs.cancelRun(asJobId(params.value.jobId));
    if (!cancelled.ok) return sendProblem(reply, problemFor(cancelled.error));
    return reply.status(200).send({ run: cancelled.value });
  });

  /**
   * The owner's decision about a reached limit (F18-AC2).
   *
   * Granting returns the previous and extended bounds and states that the extended bound is
   * not recorded, because no storage port writes one: a client that reported it as persisted
   * would promise an owner a budget a restart would lose (F18-AC2, N01-AC3). Declining
   * writes no state at all, which is the whole meaning of the decision, and the state in the
   * answer is read back from storage.
   */
  app.post('/api/runs/:jobId/extension', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(runParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(extensionBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const jobId = asJobId(params.value.jobId);
    if (body.value.decision === 'Grant') {
      const granted = await options.controller.runs.grantExtension({ jobId, actor: session.ownerId });
      if (!granted.ok) return sendProblem(reply, problemFor(granted.error));
      return reply.status(200).send({ extension: granted.value });
    }
    const declined = await options.controller.runs.declineExtension({ jobId, actor: session.ownerId });
    if (!declined.ok) return sendProblem(reply, problemFor(declined.error));
    return reply.status(200).send({ extension: declined.value });
  });

  /**
   * The review card for the candidate the run's work item currently offers (F24-AC2, F24-AC3).
   *
   * A run with no candidate yet is answered 404 by name, and the card itself always carries
   * `notReady`, so an incomplete candidate is inspectable with its reasons rather than
   * presenting as a card that is green everywhere except the parts nobody could see.
   */
  app.get('/api/runs/:jobId/review-card', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(runParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const card = await options.controller.reviewCards.buildReviewCard(asJobId(params.value.jobId));
    if (!card.ok) return sendProblem(reply, problemFor(card.error));
    return reply.status(200).send({ card: card.value });
  });

  /**
   * The owner's acceptance decision for the run's candidate (F25-AC1, F25-AC2).
   *
   * Accepting is `200` rather than `201` because it records a decision about work that
   * already exists; requesting changes is likewise a decision, not a new resource, so both
   * are `200`. A refusal is returned as the use case wrote it, so the owner is told which
   * criteria are outstanding instead of a generic failure (F25-AC1, F24-AC3).
   */
  app.post('/api/runs/:jobId/acceptance', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(runParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(acceptanceBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const jobId = asJobId(params.value.jobId);
    if (body.value.decision === 'RequestChanges') {
      const requested = await options.controller.acceptance.requestChanges({
        jobId,
        reason: body.value.reason ?? '',
        actor: session.ownerId,
        at: options.now().toISOString(),
      });
      if (!requested.ok) return sendProblem(reply, problemFor(requested.error));
      return reply.status(200).send({ changeRequest: requested.value });
    }
    const accepted = await options.controller.acceptance.recordAcceptance({
      jobId,
      note: body.value.note,
      actor: session.ownerId,
      at: options.now().toISOString(),
    });
    if (!accepted.ok) return sendProblem(reply, problemFor(accepted.error));
    return reply.status(200).send({ acceptance: accepted.value });
  });

  /**
   * What the owner would be accepting, and what is outstanding (F25-AC1, F25-AC3).
   *
   * A read with no caller in its body, following the same rule as the other reads: the
   * gate is derived from durable evidence and cannot be authorized by a request (F01-AC1).
   */
  app.get('/api/runs/:jobId/acceptance', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(runParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const gate = await options.controller.acceptance.acceptanceGate(asJobId(params.value.jobId));
    if (!gate.ok) return sendProblem(reply, problemFor(gate.error));
    const current = await options.controller.acceptance.currentAcceptance(asJobId(params.value.jobId));
    if (!current.ok) return sendProblem(reply, problemFor(current.error));
    return reply.status(200).send({ gate: gate.value, acceptance: current.value });
  });
}
