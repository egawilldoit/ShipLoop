/**
 * Planning routes: the proposed plan, its owner edits, its readiness assessment, its
 * publication and reconciliation, and adoption of existing work (F08, F09, F10, F11,
 * F02-AC4, F01-AC1).
 *
 * Every route sits behind the session guard and every body is validated by a
 * `strictObject` schema at this boundary, so a handler never sees an unrecognised key
 * and a client cannot smuggle in a field the product does not have (F02-AC4).
 * Validation failures are reported per field, because a form can only mark the inputs
 * it knows about.
 *
 * Four properties of this route tree are structural rather than documented.
 *
 *   - **Publication is its own route and its own action.** `POST .../publish` is never
 *     reached by drafting or editing a plan, so reaching the provider is always
 *     something the owner did on an accepted revision rather than a side effect of
 *     reviewing a proposal (F10-AC1).
 *   - **The publication request id is the client's.** It is required in the body rather
 *     than minted here, because the request boundary is the only place that can present
 *     the same identity again after a timeout, and a controller-minted id would be new
 *     on every attempt (F10-AC3).
 *   - **A proposal and a readiness observation are passed through unvalidated.** Both
 *     are decoded structured data that `applyPlanProposal` and `assessReadiness` are the
 *     single validators for. The route checks only that each is an object, because
 *     reading the members here would be a second and weaker copy of rules that already
 *     refuse a lifecycle field and a confidence percentage by name (F05-AC5, F09-AC4).
 *   - **Nothing here merges anything.** Adoption reads an existing issue and binds it to
 *     a new work item; there is no merge control, no write at the provider, and
 *     `mergeable` is a literal `false` in the response (F11-AC1, F11-AC3).
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
import { asProjectId, type ControllerSurface } from '../contracts.ts';
import type { SessionGuard } from '../auth-guard.ts';

const MAXIMUM_TEXT = 20_000;
const MAXIMUM_STATEMENT = 4_000;

/**
 * The plan address, named `workItemId` to match the route contract.
 *
 * It accepts either the plan's own id or any work item the plan publishes as, so a
 * client that was handed a work item id by a publication report can come back to the
 * plan without a second lookup. Both resolve to one plan, and an address that is
 * neither is a `NotFound` naming both forms rather than an empty plan (F10-AC2).
 */
const planParams = z.strictObject({
  workItemId: z
    .string()
    .trim()
    .min(1, 'A plan address is required.')
    .max(300, 'A plan address may be at most 300 characters.'),
});

/**
 * The work item an adoption acts on.
 *
 * In the body rather than the path because the assigned contract is three flat
 * endpoints, and because the choice of which work item to adopt into is part of the
 * request the owner made rather than an address they navigated to (F11-AC1, F11-AC2).
 */
const adoptionWorkItem = z
  .string()
  .trim()
  .min(1, 'A work item id is required (F11-AC1).')
  .max(300, 'A work item id may be at most 300 characters.');

const statementList = z.array(z.string().trim().min(1, 'A statement may not be blank.').max(MAXIMUM_STATEMENT)).max(100);

const changeSurface = z.strictObject({
  surfaceId: z.string().trim().min(1, 'A surface needs an id (F08-AC2).').max(200),
  description: z.string().trim().min(1, 'A surface needs a description (F08-AC1).').max(MAXIMUM_STATEMENT),
  observableBehaviour: z.string().trim().max(MAXIMUM_STATEMENT).default(''),
  independentlyReviewable: z
    .boolean({ error: 'A surface must say whether its behaviour can be reviewed on its own (F08-AC2).' }),
});

const changeShape = z.strictObject({
  summary: z.string().trim().min(1, 'A change must state what it changes (F08-AC1).').max(MAXIMUM_TEXT),
  surfaces: z
    .array(changeSurface)
    .min(1, 'A change must declare at least one surface (F08-AC2).')
    .max(50),
  dependencyEdges: z
    .array(
      z.strictObject({
        surface: z.string().trim().min(1, 'An edge names the surface it orders (F08-AC4).').max(200),
        dependsOn: z.string().trim().min(1, 'An edge names what it depends on (F08-AC4).').max(200),
      }),
    )
    .max(100)
    .default([]),
});

/**
 * A proposed task as structured output carries it (F08-AC1).
 *
 * Only the fields F08-AC1 names are accepted, and every list is a list of statements,
 * so a body cannot supply a field the plan does not have. The proposal is handed to
 * `applyPlanProposal` as an object rather than being assembled here, because that
 * function is the validator for decoded structured output and a route that reshaped it
 * first would hide exactly the incompleteness it exists to catch (F05-AC5).
 */
const proposedTask = z.strictObject({
  taskId: z.string().trim().min(1, 'A proposed task needs an id (F08-AC1).').max(200),
  outcome: z.string().trim().min(1, 'A proposed task must state its outcome (F08-AC1).').max(MAXIMUM_STATEMENT),
  scope: z.string().trim().min(1, 'A proposed task must state its scope (F08-AC1).').max(MAXIMUM_TEXT),
  acceptanceCriteria: statementList,
  verificationMethod: z
    .string()
    .trim()
    .min(1, 'A proposed task must state how it will be verified (F08-AC1).')
    .max(MAXIMUM_STATEMENT),
  dependencies: z.array(z.string().trim().min(1, 'A dependency must name a task.')).max(50).default([]),
  relevantProjectContext: statementList.default([]),
  implementationLocation: z.strictObject({
    kind: z.literal('ProposedLocation', {
      error: 'A location is a proposal and must be tagged ProposedLocation (F08-AC5).',
    }),
    candidates: z
      .array(z.string().trim().min(1, 'A candidate location may not be blank.').max(400))
      .min(1, 'A location proposal must offer at least one candidate location (F08-AC5).')
      .max(20),
    basis: z
      .string()
      .trim()
      .min(1, 'A location proposal must state what the suggestion is based on (F08-AC5).')
      .max(MAXIMUM_STATEMENT),
  }),
  coversOutcomeIds: z
    .array(z.string().trim().min(1, 'A covered outcome needs an id (F08-AC5).'))
    .max(50)
    .default([]),
});

const requestedOutcome = z.strictObject({
  id: z.string().trim().min(1, 'A requested outcome needs an id (F08-AC5).').max(200),
  statement: z.string().trim().min(1, 'A requested outcome needs a statement (F08-AC5).').max(MAXIMUM_STATEMENT),
});

const outcomeExclusion = z.strictObject({
  outcomeId: z.string().trim().min(1, 'An exclusion names a requested outcome (F08-AC5).').max(200),
  excluded: z.string().trim().min(1, 'An exclusion must state what is not delivered (F08-AC5).').max(MAXIMUM_STATEMENT),
  reason: z.string().trim().min(1, 'An exclusion must state why (F08-AC5).').max(MAXIMUM_STATEMENT),
});

const planProposal = z.strictObject({
  kind: z.literal('PlanProposal', {
    error: 'A plan proposal must be tagged as a PlanProposal (F05-AC5).',
  }),
  briefId: z.string().trim().min(1, 'A plan must name the brief it delivers (F08-AC1).').max(200),
  draftedAt: z.string().trim().min(1, 'A plan must carry the time it was drafted (F08-AC1).').max(100),
  basedOnRevision: z.number().int().min(0).nullable().default(null),
  requestedOutcomes: z.array(requestedOutcome).min(1, 'A plan must record what the owner asked for (F08-AC5).').max(50),
  tasks: z.array(proposedTask).min(1, 'A plan must propose at least one task (F08-AC1).').max(50),
  exclusions: z.array(outcomeExclusion).max(50).default([]),
});

const draftPlanBody = z.strictObject({
  ideaId: z
    .string()
    .trim()
    .min(1, 'A plan belongs to a captured request.')
    .max(200, 'An idea id may be at most 200 characters.'),
  planId: z
    .string()
    .trim()
    .min(1, 'A plan needs an id.')
    .max(200, 'A plan id may be at most 200 characters.'),
  change: changeShape,
  proposal: planProposal,
});

/**
 * The content fields an owner edit may change, which is `PLAN_TASK_CONTENT_FIELDS` (F08-AC1).
 *
 * The list is spelled out because the point of F08-AC1 is that no field can be quietly
 * dropped and none can be invented, and `strictObject` is what refuses `acceptance`,
 * `delivery` or `status` here rather than after the domain has read the edit.
 */
const taskPatch = z
  .strictObject({
    outcome: z.string().trim().min(1, 'An outcome must say something (F08-AC1).').max(MAXIMUM_STATEMENT).optional(),
    scope: z.string().trim().min(1, 'A scope must say something (F08-AC1).').max(MAXIMUM_TEXT).optional(),
    acceptanceCriteria: statementList.optional(),
    verificationMethod: z
      .string()
      .trim()
      .min(1, 'A verification method must say something (F08-AC1).')
      .max(MAXIMUM_STATEMENT)
      .optional(),
    dependencies: z.array(z.string().trim().min(1, 'A dependency must name a task.')).max(50).optional(),
    relevantProjectContext: statementList.optional(),
    implementationLocation: z
      .strictObject({
        kind: z.literal('ProposedLocation', {
          error: 'A location is a proposal and must be tagged ProposedLocation (F08-AC5).',
        }),
        candidates: z
          .array(z.string().trim().min(1, 'A candidate location may not be blank.').max(400))
          .min(1, 'A location proposal must offer at least one candidate location (F08-AC5).')
          .max(20),
        basis: z
          .string()
          .trim()
          .min(1, 'A location proposal must state what the suggestion is based on (F08-AC5).')
          .max(MAXIMUM_STATEMENT),
      })
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'An edit must change at least one field (F08-AC1).',
  });

const editBase = {
  expectedRevision: z
    .number()
    .int()
    .min(1, 'An edit names the plan revision it was prepared against (F08-AC3).'),
};

const planEditBody = z.discriminatedUnion('kind', [
  z.strictObject({ ...editBase, kind: z.literal('Accept'), taskId: z.string().trim().min(1, 'Name the task.').max(200) }),
  z.strictObject({ ...editBase, kind: z.literal('Remove'), taskId: z.string().trim().min(1, 'Name the task.').max(200) }),
  z.strictObject({ ...editBase, kind: z.literal('Edit'), taskId: z.string().trim().min(1, 'Name the task.').max(200), changes: taskPatch }),
  z.strictObject({
    ...editBase,
    kind: z.literal('Reorder'),
    order: z
      .array(z.string().trim().min(1, 'An order names a task.').max(200))
      .min(1, 'A new order must name at least one task (F08-AC3).')
      .max(50),
  }),
  z.strictObject({
    ...editBase,
    kind: z.literal('Combine'),
    intoTaskId: z.string().trim().min(1, 'Name the task that absorbs the others.').max(200),
    fromTaskIds: z
      .array(z.string().trim().min(1, 'Name the task being absorbed.').max(200))
      .min(1, 'A combine must name at least one absorbed task (F08-AC3).')
      .max(50),
  }),
  z.strictObject({
    ...editBase,
    kind: z.literal('Exclusion'),
    outcomeId: z.string().trim().min(1, 'Name the requested outcome.').max(200),
    excluded: z.string().trim().min(1, 'State what is not delivered (F08-AC5).').max(MAXIMUM_STATEMENT),
    reason: z.string().trim().min(1, 'State why (F08-AC5).').max(MAXIMUM_STATEMENT),
  }),
]);

const publishBody = z.strictObject({
  /**
   * The identity of this publication request, reused by every retry of it (F10-AC3).
   *
   * Required rather than minted because the caller owns the request boundary: a browser
   * that retried after a timeout must be able to present the same id, and a
   * server-minted one would be new on every attempt (F10-AC3).
   */
  requestId: z
    .string()
    .trim()
    .min(1, 'A publication request needs an identity; a retry presents the same one (F10-AC3).')
    .max(200, 'A request id may be at most 200 characters.'),
});

const reconciliationOutcome = z.discriminatedUnion('resolution', [
  z.strictObject({
    resolution: z.literal('Applied'),
    providerIssueId: z.string().trim().min(1, 'An applied reconciliation names the provider issue (F10-AC2).').max(200),
    providerIssueIdentifier: z
      .string()
      .trim()
      .min(1, 'An applied reconciliation names the human identifier (F10-AC2).')
      .max(200),
    providerIssueUrl: z.string().trim().min(1, 'An applied reconciliation carries the URL (F10-AC2).').max(2_000),
    providerRevision: z.string().trim().max(200).nullable().default(null),
    detail: z.string().trim().min(1, 'A reconciliation must state what was found (F10-AC3).').max(MAXIMUM_STATEMENT),
  }),
  z.strictObject({
    resolution: z.literal('NotApplied'),
    detail: z.string().trim().min(1, 'A reconciliation must state what was found (F10-AC3).').max(MAXIMUM_STATEMENT),
  }),
  z.strictObject({
    resolution: z.literal('StillUnknown'),
    detail: z.string().trim().min(1, 'A reconciliation must state what was found (F10-AC3).').max(MAXIMUM_STATEMENT),
  }),
]);

const reconcileBody = z.strictObject({
  operationId: z.string().trim().min(1, 'A reconciliation names the operation it settles (F10-AC3).').max(300),
  resolution: reconciliationOutcome,
  observedAt: z.string().trim().min(1, 'A reconciliation records when it was observed (F10-AC3).').max(100),
  resolvedBy: z.string().trim().min(1, 'A reconciliation records who resolved it (F10-AC3).').max(200),
});

const adoptIssueBody = z.strictObject({
  projectId: z.string().trim().min(1, 'Adoption happens inside a project (F02-AC1).').max(200),
  profileVersionId: z.string().trim().min(1, 'Adoption is bound to a saved profile version (F02-AC1).').max(200),
  procedureVersionId: z.string().trim().min(1, 'A captured scope is bound to a recipe version (F12-AC1).').max(200),
  /**
   * The provider identity of the issue, never a name to search for (F11-AC3).
   *
   * `expectedIdentifier` is optional and checked when given, because a human who typed
   * `EGA-664` and got back `EGA-665` has been given the wrong issue and the honest
   * answer names both.
   */
  issueId: z.string().trim().min(1, 'Name the issue by its provider identity (F11-AC3).').max(200),
  expectedIdentifier: z.string().trim().max(200).nullable().default(null),
  title: z.string().trim().max(500).default(''),
});

const linkChangeBody = z.strictObject({
  workItemId: adoptionWorkItem,
  repository: z.strictObject({
    provider: z.string().trim().min(1, 'A repository is named by its git provider (F11-AC3).').max(200),
    fullName: z
      .string()
      .trim()
      .min(1, 'A repository is named by its owner and path, never by display name (F11-AC3).')
      .max(400),
    defaultBranch: z.string().trim().max(200).default(''),
    url: z.string().trim().max(2_000).default(''),
  }),
  branch: z.string().trim().min(1, 'Name the branch being linked (F11-AC2).').max(400),
  baseBranch: z.string().trim().min(1, 'Name the branch this work targets (F11-AC2).').max(400),
  expectedHeadSha: z.string().trim().max(200).nullable().default(null),
  pullRequestId: z.string().trim().max(200).nullable().default(null),
});

const evaluateBody = z.strictObject({
  workItemId: adoptionWorkItem,
  candidateId: z.string().trim().max(200).nullable().default(null),
  candidateFingerprint: z.string().trim().max(200).nullable().default(null),
  /**
   * `Build` is accepted so the use case's own refusal is what the owner reads.
   *
   * A schema that omitted it would silently turn a Build request into something else,
   * and an owner who asked for a build must be told that adopted work cannot take one
   * (F11-AC5, F11-AC4).
   */
  mode: z.enum(['Test', 'Review', 'Build'], {
    error: 'Choose Test, Review or Build; Build is refused for adopted work (F11-AC5).',
  }),
});

export interface PlanningRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
  readonly now: () => Date;
}

export function registerPlanningRoutes(app: FastifyInstance, options: PlanningRouteOptions): void {
  /**
   * The correlation id every provider-touching request carries.
   *
   * Derived from the request's own instant rather than a counter, so two requests never
   * share one and a trace can be followed from this log entry to the adapter call
   * (mvp-spec 7).
   */
  const correlationId = (): string => `http-planning-${options.now().toISOString()}`;

  app.post('/api/plans', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const body = parseBody(draftPlanBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const drafted = await options.controller.planning.draftPlan({
      ideaId: body.value.ideaId,
      planId: body.value.planId,
      change: body.value.change,
      proposal: body.value.proposal,
      actor: session.ownerId,
    });
    if (!drafted.ok) return sendProblem(reply, problemFor(drafted.error));
    return reply.status(201).send({ plan: drafted.value });
  });

  app.get('/api/plans/:workItemId', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(planParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const found = await options.controller.planning.getPlan(params.value.workItemId);
    if (!found.ok) return sendProblem(reply, problemFor(found.error));
    return reply.status(200).send({ plan: found.value });
  });

  app.get('/api/ideas/:ideaId/plans', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(
      z.strictObject({
        ideaId: z.string().trim().min(1, 'An idea id is required.').max(200),
      }),
      request.params,
    );
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const listed = await options.controller.planning.listPlansForIdea(params.value.ideaId);
    if (!listed.ok) return sendProblem(reply, problemFor(listed.error));
    return reply.status(200).send({ plans: listed.value });
  });

  app.post('/api/plans/:workItemId/edit', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(planParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(planEditBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const edited = await options.controller.planning.editPlan({
      planId: params.value.workItemId,
      edit: body.value,
      actor: session.ownerId,
    });
    if (!edited.ok) return sendProblem(reply, problemFor(edited.error));
    return reply.status(200).send({ plan: edited.value });
  });

  app.get('/api/plans/:workItemId/readiness', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(planParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const assessed = await options.controller.planning.assessPlan(params.value.workItemId);
    if (!assessed.ok) return sendProblem(reply, problemFor(assessed.error));
    return reply.status(200).send({ assessment: assessed.value });
  });

  app.post('/api/plans/:workItemId/publish', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(planParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(publishBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const published = await options.controller.planning.publishPlan({
      planId: params.value.workItemId,
      requestId: body.value.requestId,
      correlationId: correlationId(),
      actor: session.ownerId,
    });
    if (!published.ok) return sendProblem(reply, problemFor(published.error));
    return reply.status(200).send({ report: published.value });
  });

  app.post('/api/plans/:workItemId/reconcile-publication', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(planParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(reconcileBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const reconciled = await options.controller.planning.reconcilePublication({
      operationId: body.value.operationId,
      resolution: body.value.resolution,
      observedAt: body.value.observedAt,
      resolvedBy: body.value.resolvedBy,
      correlationId: correlationId(),
      actor: session.ownerId,
    });
    if (!reconciled.ok) return sendProblem(reply, problemFor(reconciled.error));
    return reply.status(200).send({ reconciliation: reconciled.value });
  });

  app.post('/api/adoption/issue', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const body = parseBody(adoptIssueBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const adopted = await options.controller.planning.adoptExistingIssue({
      projectId: asProjectId(body.value.projectId),
      profileVersionId: body.value.profileVersionId as never,
      procedureVersionId: body.value.procedureVersionId,
      issueId: body.value.issueId,
      expectedIdentifier: body.value.expectedIdentifier,
      title: body.value.title,
      correlationId: correlationId(),
      actor: session.ownerId,
    });
    if (!adopted.ok) return sendProblem(reply, problemFor(adopted.error));
    return reply.status(201).send({ adopted: adopted.value });
  });

  app.post('/api/adoption/change', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const body = parseBody(linkChangeBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const linked = await options.controller.planning.linkExistingChange({
      workItemId: body.value.workItemId,
      repository: body.value.repository,
      branch: body.value.branch,
      baseBranch: body.value.baseBranch,
      expectedHeadSha: body.value.expectedHeadSha,
      pullRequestId: body.value.pullRequestId,
      correlationId: correlationId(),
      actor: session.ownerId,
    });
    if (!linked.ok) return sendProblem(reply, problemFor(linked.error));
    return reply.status(200).send({ change: linked.value });
  });

  app.post('/api/adoption/evaluate', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const body = parseBody(evaluateBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const requested = await options.controller.planning.requestAdoptedEvaluation({
      workItemId: body.value.workItemId,
      candidateId: body.value.candidateId,
      candidateFingerprint: body.value.candidateFingerprint,
      mode: body.value.mode,
      correlationId: correlationId(),
      actor: session.ownerId,
    });
    if (!requested.ok) return sendProblem(reply, problemFor(requested.error));
    // 201 the first time the intent is recorded and 200 when a repeat deduplicated onto
    // the same row, because "recorded" and "already recorded" are different answers and
    // a client deciding whether to retry needs to tell them apart (F30-AC2).
    return reply.status(requested.value.created ? 201 : 200).send({ evaluation: requested.value });
  });
}
