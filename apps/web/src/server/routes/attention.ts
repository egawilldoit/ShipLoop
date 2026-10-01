/**
 * Attention routes: the board and acknowledgement (F31-AC1, F31-AC2, F31-AC3, F31-AC4,
 * F31-AC5, N04-AC2, N04-AC3, F01-AC1).
 *
 * The board is derived from durable state on every read, so a client cannot be handed a
 * list of things that need attention by anything but the store itself (F31-AC1). The two
 * routes here are the whole surface: a read and the one write that records that the owner
 * has seen something.
 *
 * Four decisions are structural:
 *
 *   - **The four buckets are the dashboard's, and the response names only the occupied
 *     ones.** The domain's own grouping drops an empty bucket, and this route does not
 *     re-add one: a client that rendered an empty section from an absent bucket would be
 *     inventing a fact the grouping did not state (F31-AC1).
 *   - **`collectedAt` travels with every read.** A view that has stopped moving looks
 *     exactly like one with nothing to report, and the instant is what tells them apart
 *     (N04-AC2).
 *   - **Acknowledgement records attention and nothing else.** The write touches the
 *     attention row alone and returns that row, so no run, acceptance or delivery fact can
 *     move because the owner looked at something (F31-AC4).
 *   - **An item with no durable row cannot be acknowledged.** The board names which
 *     identities have one in `persistedItemIds`, because a derived run-progress item has a
 *     stable identity but nothing to record against, and a successful acknowledgement of
 *     nothing is the one answer that cannot be told apart from a recorded one (F31-AC3,
 *     F31-AC4).
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
import { asAttentionItemId, type ControllerSurface } from '../contracts.ts';
import type { SessionGuard } from '../auth-guard.ts';

const itemParams = z.strictObject({
  itemId: z
    .string()
    .trim()
    .min(1, 'An attention item id is required.')
    .max(128, 'An attention item id may be at most 128 characters.'),
});

/**
 * The project to read a board for (F31-AC2).
 *
 * Optional because this server has no project selector: with no project named, the board is
 * collected for the project this owner's recorded work belongs to, and an owner with no
 * recorded work gets an empty board that names no project rather than a board about a
 * project nobody looked at.
 */
const boardQuery = z.strictObject({
  projectId: z
    .string()
    .trim()
    .min(1, 'A project id may not be blank.')
    .max(128, 'A project id may be at most 128 characters.')
    .nullable()
    .default(null),
});

export interface AttentionRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
  readonly now: () => Date;
}

export function registerAttentionRoutes(app: FastifyInstance, options: AttentionRouteOptions): void {
  app.get('/api/attention', { preHandler: options.guard }, async (request, reply) => {
    const query = parseBody(boardQuery, request.query);
    if (!query.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(query.problem)));
    const board = await options.controller.attention.collectAttention({
      projectId: query.value.projectId,
      at: options.now().toISOString(),
    });
    if (!board.ok) return sendProblem(reply, problemFor(board.error));
    return reply.status(200).send({ board: board.value });
  });

  /**
   * Records that the owner has seen an item (F31-AC4).
   *
   * Answered with the stored row rather than a bare acknowledgement, so what the owner is
   * shown afterwards is what the store holds, including who acknowledged it and when.
   */
  app.post('/api/attention/:itemId/acknowledge', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(itemParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const acknowledged = await options.controller.attention.acknowledge({
      attentionItemId: asAttentionItemId(params.value.itemId),
      actor: session.ownerId,
    });
    if (!acknowledged.ok) return sendProblem(reply, problemFor(acknowledged.error));
    return reply.status(200).send({ item: acknowledged.value });
  });
}
