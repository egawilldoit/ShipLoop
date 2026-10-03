/**
 * The implementation handoff route (mvp-spec L02, L02-AC3).
 *
 * One read, and the only thing this file decides: the response shape. The text belongs to the
 * controller, the approval decision belongs to the contract use case, and the T3 state
 * belongs to the configuration - a client that assembled any of them here would take on a
 * guarantee the product is supposed to hold (N02-AC2).
 *
 * Four properties are structural rather than documented:
 *
 *   - **The project travels in the path.** `/api/projects/:projectId/contracts/:contractId/:
 *     revision/handoff` addresses one revision of one project, so the server has both halves
 *     of the key it needs and a client cannot ask for "the handoff" without saying of what
 *     (F02-AC2). The controller re-checks ownership from the session it is handed; this route
 *     never decides who the caller is, it only refuses to act without a proved one (F01-AC1).
 *   - **The revision must be an approved one.** The refusal is the contract use case's gate,
 *     mapped to 422 with the remedy attached, because "have the owner approve revision N" is
 *     the next action a draft or a retired approval needs. Nothing is rendered for a revision
 *     that was not approved: a draft is not a permission slip (mvp-spec 3).
 *   - **No T3 is a normal answer, not an error.** A deployment with nothing configured gets
 *     the whole packet plus `NotConfigured`, because the packet is text the owner can paste
 *     anywhere and the MVP journey must not depend on an external tool (mvp-spec L02-AC3).
 *   - **Nothing is contacted.** No T3 API, no session, no execution status, and no claim
 *     about any. ShipLoop owns the contract and the evidence; the external executor owns
 *     implementation activity, and a response that implied otherwise would be a claim the
 *     server cannot support (mvp-spec L02).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { OwnerId } from '@shiploop/domain';
import {
  fieldErrorsOf,
  fieldsProblem,
  parseBody,
  problemFor,
  sendProblem,
  signInRequiredProblem,
} from '../http-error.ts';
import type { ControllerSurface } from '../contracts.ts';
import type { SessionGuard } from '../auth-guard.ts';

/**
 * One approved revision of one project.
 *
 * Identical to the identity `routes/contracts.ts` reads a revision by, on purpose: a
 * handoff for `contracts/x/1` must be the handoff for `contracts/x/1`, and two spellings of
 * one revision is how a client ends up packetizing a number the store never approved. The
 * revision is a positive integer in the path, so `/contracts/x/edit` cannot parse as
 * revision 0 and be silently accepted (mvp-spec 3).
 */
const handoffParams = z.strictObject({
  projectId: z
    .string()
    .trim()
    .min(1, 'A project id is required.')
    .max(128, 'A project id may be at most 128 characters.')
    .refine((value) => !/[/\\]/.test(value) && !value.includes('..'), 'A project id may not contain a path separator or "..".'),
  contractId: z
    .string()
    .trim()
    .min(1, 'A contract id is required.')
    .max(128, 'A contract id may be at most 128 characters.'),
  revision: z.coerce.number().int().positive('A revision number starts at 1.'),
});

export interface HandoffRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
}

/**
 * The owner a read was made by.
 *
 * The guard has already run, so a null session is a wiring fault rather than an expected
 * outcome - which is why this refuses rather than substituting an empty identity, because
 * the controller would then be answering a question about an owner that does not exist
 * (F01-AC1).
 */
function provedOwnerOf(
  request: { readonly session: { readonly ownerId: OwnerId } | null },
  reply: FastifyReply,
): OwnerId | null {
  if (request.session !== null) return request.session.ownerId;
  sendProblem(reply, signInRequiredProblem());
  return null;
}

export function registerHandoffRoutes(app: FastifyInstance, options: HandoffRouteOptions): void {
  /**
   * The handoff packet for one approved revision, plus where the external executor is
   * configured to be opened.
   *
   * `GET` rather than `POST` because nothing is written and nothing is decided here: the same
   * approved contract always renders the same bytes, so reading the handoff twice is the same
   * document and a client may compare the two instead of trusting either (mvp-spec 7). No
   * body is accepted, and none is needed - a request that could say *which* contract to
   * hand off would be a second way to address the identity the path already fixes.
   */
  app.get('/api/projects/:projectId/contracts/:contractId/:revision/handoff', { preHandler: options.guard }, async (request, reply) => {
    const owner = provedOwnerOf(request, reply);
    if (owner === null) return reply;
    const params = parseBody(handoffParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));

    const handoff = await options.controller.handoff.buildHandoff({
      projectId: params.value.projectId,
      contractId: params.value.contractId,
      revision: params.value.revision,
      actor: owner,
    });
    if (!handoff.ok) return sendProblem(reply, problemFor(handoff.error));
    // The packet is carried as JSON-encoded text rather than as a second `text/plain`
    // representation. One representation means there is nothing for a client to choose
    // wrongly, and `fingerprint` lets it prove the bytes it received are the bytes the
    // controller rendered - which is what the clipboard actually needs (N02-AC2).
    return reply.status(200).send({ handoff: handoff.value });
  });
}
