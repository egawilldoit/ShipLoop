/**
 * Intake routes: capture, disposition, related work, brief, clarification and
 * export (F06-AC1, F06-AC3, F06-AC4, F06-AC5, F07-AC1, F07-AC2, F07-AC3, F02-AC4,
 * F01-AC1).
 *
 * Every route sits behind the session guard and every body is validated by a
 * `strictObject` schema at this boundary, so a handler never sees an unvalidated
 * value and an unrecognised key is refused rather than dropped (F02-AC4). Validation
 * failures are reported per field, because a form can only mark the inputs it knows
 * about and a single combined message would leave the owner guessing which one to
 * fix.
 *
 * The request kinds of body are deliberately small. A capture carries only the raw
 * request plus optional detail, because every optional field may be absent and a
 * request that insists on completeness is a request an owner gives up on
 * (F06-AC3). A brief carries all seven sections, because `applyProposal` refuses a
 * proposal missing one and a schema that defaulted a section would hide exactly the
 * incompleteness the domain exists to catch (F07-AC1).
 *
 * Three properties are structural rather than documented. `POST` routes that create
 * something answer 201 with the created record, so "accepted" is never confused with
 * "exists" (F02-AC3). The related-work choice names the candidate in the path, because
 * the choice is about that specific pair and a body field would let a client record a
 * decision about a request it never saw compared (F06-AC4). And nothing here
 * publishes, schedules or runs: there is no route that creates a ticket or consumes a
 * coding run, which is what makes archiving an idea safe (F06-AC5).
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
import { asIdeaId, type ControllerSurface } from '../contracts.ts';
import type { SessionGuard } from '../auth-guard.ts';

const MAXIMUM_REQUEST_LENGTH = 20_000;
const MAXIMUM_ATTACHMENT_LENGTH = 20_000;

const ideaParams = z.strictObject({
  ideaId: z.string().trim().min(1, 'An idea id is required.').max(128, 'An idea id may be at most 128 characters.'),
});

const questionParams = z.strictObject({
  ideaId: z.string().trim().min(1, 'An idea id is required.').max(128, 'An idea id may be at most 128 characters.'),
  questionId: z.string().trim().min(1, 'A question id is required.').max(128, 'A question id may be at most 128 characters.'),
});

const candidateParams = z.strictObject({
  ideaId: z.string().trim().min(1, 'An idea id is required.').max(128, 'An idea id may be at most 128 characters.'),
  candidateIdeaId: z
    .string()
    .trim()
    .min(1, 'A candidate idea id is required.')
    .max(128, 'A candidate idea id may be at most 128 characters.'),
});

/**
 * A bug's optional detail (F06-AC3).
 *
 * Every member is nullable and the whole object is optional, so a bug with only a
 * symptom is a valid capture and a feature request may carry no detail at all. The
 * schema cannot express "a feature request with reproduction steps", because the
 * domain refuses that combination rather than storing it.
 */
const bugDetail = z.strictObject({
  expected: z.string().trim().max(MAXIMUM_REQUEST_LENGTH, 'Expected behaviour is too long.').nullable().default(null),
  actual: z.string().trim().max(MAXIMUM_REQUEST_LENGTH, 'Actual behaviour is too long.').nullable().default(null),
  reproduction: z
    .string()
    .trim()
    .max(MAXIMUM_REQUEST_LENGTH, 'Reproduction steps are too long.')
    .nullable()
    .default(null),
});

const captureBody = z.strictObject({
  rawRequest: z
    .string()
    .trim()
    .min(1, "The owner's own words are required; capture is what the idea is (F06-AC1).")
    .max(MAXIMUM_REQUEST_LENGTH, `A request may be at most ${MAXIMUM_REQUEST_LENGTH} characters.`),
  kind: z.enum(['FeatureRequest', 'Bug'], { error: 'A request is either a feature request or a bug (F06-AC3).' }),
  projectId: z.string().trim().max(128, 'A project id may be at most 128 characters.').nullable().default(null),
  notes: z.string().trim().max(MAXIMUM_REQUEST_LENGTH, 'Notes are too long.').nullable().default(null),
  detail: bugDetail.nullable().default(null),
});

const summaryBody = z.strictObject({
  text: z.string().trim().min(1, 'A generated summary cannot be blank (F06-AC1).').max(MAXIMUM_REQUEST_LENGTH),
  generatedBy: z
    .string()
    .trim()
    .min(1, 'A generated summary records what generated it (F06-AC1).')
    .max(200, 'A generator name may be at most 200 characters.'),
});

const dispositionBody = z.strictObject({
  reason: z.string().trim().max(500, 'A reason may be at most 500 characters.').nullable().default(null),
});

const attachmentBody = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, 'An attachment needs a file name (F06-AC1).')
    .max(255, 'A file name may be at most 255 characters.')
    .refine(
      (value) => !value.includes('/') && !value.includes('\\') && !value.includes('..'),
      'A file name cannot contain a path separator or ".."; attachments are named files under the artifact root (F06-AC1).',
    ),
  mediaType: z.enum(['text/plain', 'image/png', 'image/jpeg'], {
    error: 'An attachment must be text/plain, image/png or image/jpeg (F06-AC1).',
  }),
  content: z
    .string()
    .min(1, 'An attachment must carry the content it names, not an empty file (F06-AC1).')
    .max(MAXIMUM_ATTACHMENT_LENGTH, `An attachment may be at most ${MAXIMUM_ATTACHMENT_LENGTH} characters.`),
});

const relatedChoiceBody = z.strictObject({
  choice: z.enum(['LinkToExisting', 'ExtendExisting', 'CreateNewIssue'], {
    error: 'Choose LinkToExisting, ExtendExisting or CreateNewIssue (F06-AC4).',
  }),
});

const acceptanceCriterion = z.strictObject({
  id: z.string().trim().min(1, 'An acceptance criterion needs an id (F07-AC1).').max(120),
  text: z.string().trim().min(1, 'An acceptance criterion needs text (F07-AC1).').max(2000),
  verification: z.string().trim().max(2000, 'How the criterion is verified is too long.').nullable().default(null),
});

const statementList = z.array(z.string().trim().min(1, 'A statement may not be blank.').max(2000)).max(50);

const briefSections = z.strictObject({
  problem: z.string().trim().min(1, 'The brief needs the problem it solves (F07-AC1).').max(4000),
  desiredOutcome: z.string().trim().min(1, 'The brief needs the outcome wanted (F07-AC1).').max(4000),
  includedBehaviour: statementList,
  excludedBehaviour: statementList,
  assumptions: statementList,
  acceptanceCriteria: z.array(acceptanceCriterion).max(50),
  unresolvedQuestions: statementList,
});

const draftBriefBody = z.strictObject({
  authoredBy: z.enum(['Owner', 'ClarificationModel', 'OwnerEdit'], {
    error: 'A brief is authored by the Owner, the ClarificationModel or an OwnerEdit (F07-AC1).',
  }),
  sections: briefSections,
  basedOnBriefVersion: z.number().int().min(1).nullable().default(null),
});

const ambiguity = z.strictObject({
  kind: z.enum([
    'UnspecifiedSubject',
    'ConflictingStatement',
    'MissingAcceptanceThreshold',
    'UnstatedScopeBoundary',
    'UnresolvedDependency',
  ]),
  topic: z.string().trim().min(1, 'An ambiguity must name what it is about (F07-AC2).').max(200),
  readings: z.array(z.string().trim().min(1, 'A reading may not be blank.').max(500)).min(1).max(10),
  answeredBy: z.array(z.string().trim().max(2000)).max(10).default([]),
  impact: z.enum(['ChangesBehaviour', 'ChangesAcceptance', 'Cosmetic'], {
    error: 'An ambiguity changes behaviour, changes acceptance, or is cosmetic (F07-AC2).',
  }),
  evidence: z
    .string()
    .trim()
    .min(1, 'An ambiguity must quote the request text that shows it exists (F07-AC2).')
    .max(2000),
});

const askQuestionsBody = z.strictObject({
  sections: briefSections,
  ambiguities: z.array(ambiguity).max(20).default([]),
});

const answerBody = z.strictObject({
  answer: z
    .string()
    .trim()
    .min(1, "An answer must say something; an empty answer leaves the question open (F07-AC2).")
    .max(4000, 'An answer may be at most 4000 characters.'),
});

const correctionBody = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1, "A correction must record the owner's own words (F07-AC3).")
    .max(4000, 'A correction may be at most 4000 characters.'),
  sections: briefSections,
  basedOnBriefVersion: z.number().int().min(1, 'A correction names the brief version it corrects (F07-AC3).'),
});

export interface IntakeRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
  readonly now: () => Date;
}

export function registerIntakeRoutes(app: FastifyInstance, options: IntakeRouteOptions): void {
  app.post('/api/intake/ideas', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const body = parseBody(captureBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const captured = await options.controller.intake.captureIdea({
      rawRequest: body.value.rawRequest,
      kind: body.value.kind,
      projectId: body.value.projectId,
      notes: body.value.notes,
      detail: body.value.detail,
      actor: session.ownerId,
    });
    if (!captured.ok) return sendProblem(reply, problemFor(captured.error));
    return reply.status(201).send({ idea: captured.value });
  });

  app.get('/api/intake/ideas', { preHandler: options.guard }, async (_request, reply) => {
    const listed = await options.controller.intake.listIdeas();
    if (!listed.ok) return sendProblem(reply, problemFor(listed.error));
    return reply.status(200).send({ ideas: listed.value });
  });

  app.get('/api/intake/ideas/:ideaId', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(ideaParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const detail = await options.controller.intake.getIdea(asIdeaId(params.value.ideaId));
    if (!detail.ok) return sendProblem(reply, problemFor(detail.error));
    return reply.status(200).send(detail.value);
  });

  app.get('/api/intake/ideas/:ideaId/export', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(ideaParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const exported = await options.controller.intake.exportIdea(asIdeaId(params.value.ideaId));
    if (!exported.ok) return sendProblem(reply, problemFor(exported.error));
    return reply.status(200).send({ export: exported.value });
  });

  app.get('/api/intake/ideas/:ideaId/related', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(ideaParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const related = await options.controller.intake.findRelatedWork(asIdeaId(params.value.ideaId));
    if (!related.ok) return sendProblem(reply, problemFor(related.error));
    return reply.status(200).send({ related: related.value });
  });

  app.post('/api/intake/ideas/:ideaId/related/choice/:candidateIdeaId', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(candidateParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(relatedChoiceBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const chosen = await options.controller.intake.recordRelatedWorkChoice({
      ideaId: asIdeaId(params.value.ideaId),
      candidateIdeaId: asIdeaId(params.value.candidateIdeaId),
      choice: body.value.choice,
      actor: session.ownerId,
    });
    if (!chosen.ok) return sendProblem(reply, problemFor(chosen.error));
    return reply.status(200).send({ choice: chosen.value });
  });

  app.post('/api/intake/ideas/:ideaId/attachments', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(ideaParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(attachmentBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const attached = await options.controller.intake.attachFile({
      ideaId: asIdeaId(params.value.ideaId),
      name: body.value.name,
      mediaType: body.value.mediaType,
      content: body.value.content,
      actor: session.ownerId,
    });
    if (!attached.ok) return sendProblem(reply, problemFor(attached.error));
    return reply.status(201).send({ idea: attached.value });
  });

  app.post('/api/intake/ideas/:ideaId/summary', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(ideaParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(summaryBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const summarized = await options.controller.intake.recordSummary({
      ideaId: asIdeaId(params.value.ideaId),
      text: body.value.text,
      generatedBy: body.value.generatedBy,
      actor: session.ownerId,
    });
    if (!summarized.ok) return sendProblem(reply, problemFor(summarized.error));
    return reply.status(200).send({ idea: summarized.value });
  });

  app.post('/api/intake/ideas/:ideaId/archive', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(ideaParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(dispositionBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const archived = await options.controller.intake.archiveIdea({
      ideaId: asIdeaId(params.value.ideaId),
      reason: body.value.reason,
      actor: session.ownerId,
    });
    if (!archived.ok) return sendProblem(reply, problemFor(archived.error));
    return reply.status(200).send({ idea: archived.value });
  });

  app.post('/api/intake/ideas/:ideaId/defer', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(ideaParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(dispositionBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const deferred = await options.controller.intake.deferIdea({
      ideaId: asIdeaId(params.value.ideaId),
      reason: body.value.reason,
      actor: session.ownerId,
    });
    if (!deferred.ok) return sendProblem(reply, problemFor(deferred.error));
    return reply.status(200).send({ idea: deferred.value });
  });

  app.post('/api/intake/ideas/:ideaId/brief', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(ideaParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(draftBriefBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const drafted = await options.controller.intake.draftBrief({
      ideaId: asIdeaId(params.value.ideaId),
      authoredBy: body.value.authoredBy,
      sections: body.value.sections,
      basedOnBriefVersion: body.value.basedOnBriefVersion,
      actor: session.ownerId,
    });
    if (!drafted.ok) return sendProblem(reply, problemFor(drafted.error));
    return reply.status(201).send({ brief: drafted.value });
  });

  app.post('/api/intake/ideas/:ideaId/brief/agree', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(ideaParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const agreed = await options.controller.intake.agreeBrief({
      ideaId: asIdeaId(params.value.ideaId),
      actor: session.ownerId,
    });
    if (!agreed.ok) return sendProblem(reply, problemFor(agreed.error));
    return reply.status(200).send({ brief: agreed.value });
  });

  app.post('/api/intake/ideas/:ideaId/questions', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(ideaParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(askQuestionsBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const round = await options.controller.intake.askClarifyingQuestions({
      ideaId: asIdeaId(params.value.ideaId),
      sections: body.value.sections,
      ambiguities: body.value.ambiguities,
      actor: session.ownerId,
    });
    if (!round.ok) return sendProblem(reply, problemFor(round.error));
    return reply.status(201).send(round.value);
  });

  app.post(
    '/api/intake/ideas/:ideaId/questions/:questionId/answer',
    { preHandler: options.guard },
    async (request, reply) => {
      const session = request.session;
      if (session === null) return sendProblem(reply, signInRequiredProblem());
      const params = parseBody(questionParams, request.params);
      if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
      const body = parseBody(answerBody, request.body);
      if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
      const answered = await options.controller.intake.answerClarifyingQuestion({
        ideaId: asIdeaId(params.value.ideaId),
        questionId: params.value.questionId,
        answer: body.value.answer,
        actor: session.ownerId,
      });
      if (!answered.ok) return sendProblem(reply, problemFor(answered.error));
      return reply.status(200).send({ question: answered.value });
    },
  );

  app.post('/api/intake/ideas/:ideaId/corrections', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(ideaParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(correctionBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const applied = await options.controller.intake.applyOwnerCorrection({
      ideaId: asIdeaId(params.value.ideaId),
      text: body.value.text,
      sections: body.value.sections,
      basedOnBriefVersion: body.value.basedOnBriefVersion,
      actor: session.ownerId,
    });
    if (!applied.ok) return sendProblem(reply, problemFor(applied.error));
    return reply.status(201).send(applied.value);
  });
}