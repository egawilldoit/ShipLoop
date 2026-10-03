/**
 * Request and Delivery Contract routes (mvp-spec 3).
 *
 * The MVP journey starts here: what the owner wants changed, then the versioned agreement
 * describing what a successful implementation looks like.
 *
 * Four properties are structural rather than documented, and three of them exist because of
 * the defects this slice was built to close:
 *
 *   - **The project travels in the path, not in the body.** Every route is under
 *     `/api/projects/:projectId/...`, so a request and its contract are always addressed as a
 *     pair. A body carrying the project would let a client read one project's request while
 *     believing it had addressed another, and the server would have no way to check (F02-AC2).
 *   - **`approveRevision` takes an empty body.** No approver field exists to send, so no body
 *     can attribute an approval to somebody else. The approver is read from the proved
 *     session; the schema is `strictObject({})` rather than no schema, so a body that meant
 *     to say who approved is refused rather than silently dropped (mvp-spec 3).
 *   - **Every edit carries `expectedUpdatedAt`; approval carries none, and this file says
 *     so rather than implying otherwise.** A stale tab editing a request or a draft
 *     revision is refused with a 409 instead of overwriting text somebody else has since
 *     replaced, and the conflict names both instants (mvp-spec 7, F24-AC4). An approval
 *     names a revision and freezes the text that revision holds when the call lands, so it
 *     has no instant to compare against - which leaves a real gap: an owner who approves a
 *     draft another tab edited since their page was rendered approves text they did not
 *     read. That gap belongs to the approval use case rather than to this file, and it is
 *     stated here so no caller is told a guard exists that does not (mvp-spec 3).
 *   - **Reads of one revision are keyed by `(projectId, contractId, revision)`.** A revision
 *     number is not decoration: a candidate and its evidence bind to it, so addressing a
 *     revision without its number is addressing something unidentifiable (mvp-spec 3).
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
import {
  CONTRACT_STALE_REASONS,
  type ControllerSurface,
} from '../contracts.ts';
import type { OwnerId } from '@shiploop/domain';
import type { SessionGuard } from '../auth-guard.ts';

/** Longest title a request may carry; a title is a label, not a document. */
const MAXIMUM_TITLE_LENGTH = 200;

/** Longest description, outcome or criterion text a body may carry. */
const MAXIMUM_TEXT_LENGTH = 20_000;

/**
 * A project identity.
 *
 * Bounded and refused on a path separator or `..`, matching `routes/projects.ts` exactly:
 * the value addresses an artifact root, a workspace and a git checkout, so a traversal here
 * is a traversal there (F06-AC1).
 */
const projectIdentifier = z
  .string()
  .trim()
  .min(1, 'A project id is required.')
  .max(128, 'A project id may be at most 128 characters.')
  .refine((value) => !/[/\\]/.test(value) && !value.includes('..'), 'A project id may not contain a path separator or "..".');

const projectParams = z.strictObject({ projectId: projectIdentifier });

const requestParams = projectParams.extend({
  requestId: z.string().trim().min(1, 'A request id is required.').max(128, 'A request id may be at most 128 characters.'),
});

/**
 * One contract revision, addressed by identity and revision number.
 *
 * The revision is a positive integer in the path rather than a string, so `/contracts/x/edit`
 * cannot parse as "revision 0" and be silently accepted.
 */
const contractParams = projectParams.extend({
  contractId: z.string().trim().min(1, 'A contract id is required.').max(128, 'A contract id may be at most 128 characters.'),
  revision: z.coerce.number().int().positive('A revision number starts at 1.'),
});

const createRequestBody = z.strictObject({
  title: z.string().trim().min(1, 'A request needs a title.').max(MAXIMUM_TITLE_LENGTH, 'A title may be at most 200 characters.'),
  description: z
    .string()
    .trim()
    .min(1, 'A request needs a description of what should change.')
    .max(MAXIMUM_TEXT_LENGTH, 'The description is too long.'),
});

/**
 * An edit to a request draft.
 *
 * At least one field, and both optional: a request is edited field by field, and a body with
 * neither is refused by the domain as a no-op rather than reported as a save (mvp-spec 7).
 */
const updateRequestBody = z.strictObject({
  title: z.string().trim().min(1, 'A request needs a title.').max(MAXIMUM_TITLE_LENGTH).optional(),
  description: z.string().trim().min(1, 'A request needs a description.').max(MAXIMUM_TEXT_LENGTH).optional(),
  expectedUpdatedAt: z
    .string()
    .trim()
    .min(1, 'The instant the request was loaded is required, so a stale editor is refused (F02-AC2).'),
});

/**
 * One acceptance criterion.
 *
 * `verificationType` is an enum rather than text: it decides who may settle the criterion, and
 * a value outside the vocabulary is refused here rather than defaulted (mvp-spec 3).
 */
const criterion = z.strictObject({
  id: z.string().trim().min(1, 'An acceptance criterion needs an id.').max(128, 'A criterion id may be at most 128 characters.'),
  description: z
    .string()
    .trim()
    .min(1, 'An acceptance criterion needs a description.')
    .max(MAXIMUM_TEXT_LENGTH, 'A criterion description is too long.'),
  verificationType: z.enum(['automated', 'owner_test'], {
    error: 'A criterion is verified by an automated check or by an owner test (mvp-spec 3).',
  }),
});

const statementList = z
  .array(z.string().trim().min(1, 'An empty entry says nothing; remove it instead.').max(MAXIMUM_TEXT_LENGTH))
  .max(200, 'A list may hold at most 200 entries.');

/**
 * The contract content, on create, on edit and on revise alike.
 *
 * The same shape for all three because they are the same decision: what a successful
 * implementation looks like. Three separate schemas would be three places for them to drift,
 * and a client that could draft an agreement it could not then edit would be a client with
 * two contracts (mvp-spec 3).
 */
const contractContent = z.strictObject({
  outcome: z
    .string()
    .trim()
    .min(1, 'A contract needs the outcome it promises.')
    .max(MAXIMUM_TEXT_LENGTH, 'The outcome is too long.'),
  scope: statementList,
  outOfScope: statementList,
  acceptanceCriteria: z.array(criterion).min(1, 'A contract needs at least one acceptance criterion.').max(100, 'A contract may hold at most 100 acceptance criteria.'),
});

const editContractBody = contractContent.extend({
  expectedUpdatedAt: z
    .string()
    .trim()
    .min(1, 'The instant the revision was loaded is required, so a stale editor is refused (mvp-spec 3).'),
});

/**
 * Approval carries nothing.
 *
 * `strictObject({})` and not an absent schema: a client that tried to send `approvedBy` or
 * `status` is refused with a named field rather than having it ignored, because a body that
 * *thinks* it named the approver is the exact defect this route is shaped to prevent
 * (mvp-spec 3).
 *
 * Empty means empty: adding a compare-and-set instant here would make an approval
 * refusable on a field whose only other purpose is to say who approved, and the approver
 * is the one thing this body must never carry (mvp-spec 3).
 */
const approveBody = z.strictObject({});

const invalidateBody = z.strictObject({
  reason: z.enum(CONTRACT_STALE_REASONS, {
    error: `Say why the approval is stale: ${CONTRACT_STALE_REASONS.join(', ')}.`,
  }),
});

/**
 * The owner a request proved, for a read.
 *
 * Reads are behind the guard, so a null session is a wiring fault rather than an expected
 * outcome - which is why this refuses rather than substituting an empty identity. Substituting
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

export interface ContractRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
  readonly now: () => Date;
}

export function registerContractRoutes(app: FastifyInstance, options: ContractRouteOptions): void {
  /* ---------------------------------------------------------------- requests */

  /**
   * Creates a request in this project.
   *
   * 201 with the created record, because a request this call created and one that already
   * existed are different outcomes and a client told 201 either way would navigate as though
   * something new happened (mvp-spec 7). No engine is consulted: creating a request must work
   * on a deployment that has configured none (MVP).
   */
  app.post('/api/projects/:projectId/requests', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(projectParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(createRequestBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    const created = await options.controller.contracts.createRequest({
      projectId: params.value.projectId,
      title: body.value.title,
      description: body.value.description,
      actor: session.ownerId,
    });
    if (!created.ok) return sendProblem(reply, problemFor(created.error));
    return reply.status(201).send({ request: created.value });
  });

  /** The requests of this project, newest first (mvp-spec 3). */
  app.get('/api/projects/:projectId/requests', { preHandler: options.guard }, async (request, reply) => {
    const owner = provedOwnerOf(request, reply);
    if (owner === null) return reply;
    const params = parseBody(projectParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));

    const listed = await options.controller.contracts.listRequests({
      projectId: params.value.projectId,
      actor: owner,
    });
    if (!listed.ok) return sendProblem(reply, problemFor(listed.error));
    return reply.status(200).send({ requests: listed.value });
  });

  /**
   * One request with its contract state.
   *
   * The detail, not the bare request: an owner opening a request needs to know which revision
   * is approved and which is being edited, and making two round trips for that leaves a window
   * in which the two answers describe different moments (mvp-spec 3).
   */
  app.get('/api/projects/:projectId/requests/:requestId', { preHandler: options.guard }, async (request, reply) => {
    const owner = provedOwnerOf(request, reply);
    if (owner === null) return reply;
    const params = parseBody(requestParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));

    const detail = await options.controller.contracts.getRequest({
      projectId: params.value.projectId,
      requestId: params.value.requestId,
      actor: owner,
    });
    if (!detail.ok) return sendProblem(reply, problemFor(detail.error));
    return reply.status(200).send(detail.value);
  });

  /**
   * Edits a request draft.
   *
   * `PATCH` because both fields are independently optional and the caller supplies only what it
   * changed. The compare-and-set instant is required, so a stale editor is a 409 rather than a
   * silent overwrite (F02-AC2, F24-AC4).
   */
  app.patch('/api/projects/:projectId/requests/:requestId', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(requestParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(updateRequestBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    const updated = await options.controller.contracts.updateRequest({
      projectId: params.value.projectId,
      requestId: params.value.requestId,
      ...(body.value.title === undefined ? {} : { title: body.value.title }),
      ...(body.value.description === undefined ? {} : { description: body.value.description }),
      expectedUpdatedAt: body.value.expectedUpdatedAt,
      actor: session.ownerId,
    });
    if (!updated.ok) return sendProblem(reply, problemFor(updated.error));
    return reply.status(200).send({ request: updated.value });
  });

  /* --------------------------------------------------------------- contracts */

  /**
   * Drafts revision 1 of this request's delivery contract (mvp-spec 3).
   *
   * `/contracts`, plural, the same sub-resource the listing beside it answers: a client
   * that drafts revision 1 and then lists the revisions holds one path and one noun, and a
   * singular twin would be a second shape for the same write.
   */
  app.post('/api/projects/:projectId/requests/:requestId/contracts', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(requestParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(contractContent, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    const drafted = await options.controller.contracts.draftContract({
      projectId: params.value.projectId,
      requestId: params.value.requestId,
      ...body.value,
      actor: session.ownerId,
    });
    if (!drafted.ok) return sendProblem(reply, problemFor(drafted.error));
    return reply.status(201).send({ contract: drafted.value });
  });

  /** Every revision of this request, oldest first (mvp-spec 3). */
  app.get('/api/projects/:projectId/requests/:requestId/contracts', { preHandler: options.guard }, async (request, reply) => {
    const owner = provedOwnerOf(request, reply);
    if (owner === null) return reply;
    const params = parseBody(requestParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));

    const revisions = await options.controller.contracts.listContractRevisions({
      projectId: params.value.projectId,
      requestId: params.value.requestId,
      actor: owner,
    });
    if (!revisions.ok) return sendProblem(reply, problemFor(revisions.error));
    return reply.status(200).send({ contracts: revisions.value });
  });

  /** One revision, addressed by its own number (mvp-spec 3). */
  app.get('/api/projects/:projectId/contracts/:contractId/:revision', { preHandler: options.guard }, async (request, reply) => {
    const owner = provedOwnerOf(request, reply);
    if (owner === null) return reply;
    const params = parseBody(contractParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));

    const contract = await options.controller.contracts.getContract({
      projectId: params.value.projectId,
      contractId: params.value.contractId,
      revision: params.value.revision,
      actor: owner,
    });
    if (!contract.ok) return sendProblem(reply, problemFor(contract.error));
    return reply.status(200).send({ contract: contract.value });
  });

  /**
   * The acceptance criteria of one revision, in the order they were written.
   *
   * A separate route because criteria are what verification and the review card read, and they
   * change only when the revision does - so a client polling them does not have to carry the
   * whole revision (mvp-spec 3, mvp-spec 7).
   */
  app.get('/api/projects/:projectId/contracts/:contractId/:revision/criteria', { preHandler: options.guard }, async (request, reply) => {
    const owner = provedOwnerOf(request, reply);
    if (owner === null) return reply;
    const params = parseBody(contractParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));

    const criteria = await options.controller.contracts.listContractCriteria({
      projectId: params.value.projectId,
      contractId: params.value.contractId,
      revision: params.value.revision,
      actor: owner,
    });
    if (!criteria.ok) return sendProblem(reply, problemFor(criteria.error));
    return reply.status(200).send({ criteria: criteria.value });
  });

  /**
   * Edits a draft revision in place.
   *
   * `PATCH` on a revision rather than a new revision: nothing is agreed yet, so there is no
   * approval to invalidate and no candidate bound to this text. An approved revision answers
   * 400 here, and `revise` is the way forward (mvp-spec 3).
   */
  app.patch('/api/projects/:projectId/contracts/:contractId/:revision', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(contractParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(editContractBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    const edited = await options.controller.contracts.editContract({
      projectId: params.value.projectId,
      contractId: params.value.contractId,
      revision: params.value.revision,
      outcome: body.value.outcome,
      scope: body.value.scope,
      outOfScope: body.value.outOfScope,
      acceptanceCriteria: body.value.acceptanceCriteria,
      expectedUpdatedAt: body.value.expectedUpdatedAt,
      actor: session.ownerId,
    });
    if (!edited.ok) return sendProblem(reply, problemFor(edited.error));
    return reply.status(200).send({ contract: edited.value });
  });

  /**
   * Approves this revision. The owner's action, and the only way to become approved.
   *
   * The body is empty and the approver is read from the session, so no request can attribute
   * an approval to somebody else. That is the shape of the whole product rule about approval
   * rather than an omission (mvp-spec 3).
   */
  app.post('/api/projects/:projectId/contracts/:contractId/:revision/approve', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(contractParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(approveBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    const approved = await options.controller.contracts.approveRevision({
      projectId: params.value.projectId,
      contractId: params.value.contractId,
      revision: params.value.revision,
      actor: session.ownerId,
    });
    if (!approved.ok) return sendProblem(reply, problemFor(approved.error));
    return reply.status(200).send({ contract: approved.value });
  });

  /**
   * Starts the next revision and retires the approval it replaces.
   *
   * `POST` to a `/revise` sub-resource rather than a `PUT` of the revision, because a revision
   * is immutable and this creates a *new* one. The two writes are the controller's single
   * step, so no caller can separate them and leave a new revision beside a still-current
   * approval (mvp-spec 3).
   */
  app.post('/api/projects/:projectId/contracts/:contractId/:revision/revise', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(contractParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(contractContent, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    const revised = await options.controller.contracts.reviseContract({
      projectId: params.value.projectId,
      contractId: params.value.contractId,
      revision: params.value.revision,
      outcome: body.value.outcome,
      scope: body.value.scope,
      outOfScope: body.value.outOfScope,
      acceptanceCriteria: body.value.acceptanceCriteria,
      actor: session.ownerId,
    });
    if (!revised.ok) return sendProblem(reply, problemFor(revised.error));
    return reply.status(201).send({ contract: revised.value });
  });

  /**
   * Retires an approval for a named reason.
   *
   * The reason is an enum rather than text, so the stored explanation is one a client can act
   * on: `RequestChanged` means revise the contract, `WithdrawnByOwner` means the request has
   * no agreement any more. Staleness is never inferred here (mvp-spec 3).
   */
  app.post('/api/projects/:projectId/contracts/:contractId/:revision/invalidate', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(contractParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(invalidateBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    const stale = await options.controller.contracts.invalidateRevision({
      projectId: params.value.projectId,
      contractId: params.value.contractId,
      revision: params.value.revision,
      reason: body.value.reason,
      actor: session.ownerId,
    });
    if (!stale.ok) return sendProblem(reply, problemFor(stale.error));
    return reply.status(200).send({ contract: stale.value });
  });
}