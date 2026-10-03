/**
 * Project settings routes (mvp-spec 3, L02-AC2, L02-AC3).
 *
 * `GET|PATCH /api/projects/:projectId/settings`. The project travels in the path rather
 * than the body for the reason it does everywhere else in this namespace: a body carrying
 * the project would let a client read one project's configuration while believing it had
 * addressed another, and the server would have no way to check (F02-AC2).
 *
 * Three properties are set here rather than left to a client:
 *
 *   - **The response never carries a credential.** There is no field for one, and the
 *     stored value that would be one is refused before it is written, so nothing returned
 *     here can be a secret (L02-AC2, F03-AC3).
 *   - **A refusal never echoes the submitted value.** A value bad enough to be refused may
 *     itself be the credential, so the 4xx names the setting and its remedy and reproduces
 *     nothing the caller typed (N02-AC2).
 *   - **Absent is a 200.** A project with no T3 deployment configured reads
 *     `configured: false`; only a project this deployment does not hold is a 404, because
 *     that is a request for something that is not here rather than a fact about a blank
 *     configuration (L02-AC3, F02-AC2).
 *
 * `PATCH` accepts one field. Repository and provider configuration are *read* here and
 * written through the profile and connector routes, which are append-only and
 * compare-and-set respectively; a second write path for either fact would give the product
 * two answers to "what is this project's repository" (F02-AC2, F03-AC1).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
import { asProjectId, type ControllerSurface } from '../contracts.ts';
import type { SessionGuard } from '../auth-guard.ts';

/**
 * A project identity, bounded exactly as `routes/contracts.ts` and `routes/projects.ts`
 * bound it. The three are kept identical deliberately: the value addresses an artifact root,
 * a workspace and a git checkout, so a traversal accepted here is a traversal there
 * (F06-AC1).
 */
const projectIdentifier = z
  .string()
  .trim()
  .min(1, 'A project id is required.')
  .max(128, 'A project id may be at most 128 characters.')
  .refine((value) => !/[/\\]/.test(value) && !value.includes('..'), 'A project id may not contain a path separator or "..".');

const projectParams = z.strictObject({ projectId: projectIdentifier });

/**
 * The one writable setting.
 *
 * `null` clears it, which is why the field is nullable rather than optional: "there is no T3
 * deployment" and "I did not say" are different states, and a body that has to omit the
 * field to mean the second one cannot also say the first (L02-AC3).
 *
 * `strictObject`, so a body carrying a credential under some other name is refused by name
 * rather than dropped - a request that thinks it stored something it did not is the defect
 * this shape exists to prevent (F02-AC4).
 */
const updateBody = z.strictObject({
  t3Url: z.string().max(2_000, 'A T3 deployment URL may be at most 2000 characters.').nullable().optional(),
});

/**
 * The owner a request proved.
 *
 * Reads are behind the guard, so a null session is a wiring fault rather than an expected
 * outcome, which is why this refuses instead of substituting an empty identity: an empty
 * caller would make the use case's refusal a claim about an owner that does not exist
 * (F01-AC1).
 */
function provedOwnerOf(request: FastifyRequest, reply: FastifyReply): OwnerId | null {
  if (request.session !== null) return request.session.ownerId;
  sendProblem(reply, signInRequiredProblem());
  return null;
}

export interface SettingsRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
  readonly now: () => Date;
}

export function registerSettingsRoutes(app: FastifyInstance, options: SettingsRouteOptions): void {
  /**
   * One project's settings.
   *
   * 200 for a project that has configured nothing: that is the state a fresh MVP deployment
   * is in, and the handoff packet works there (L02-AC3). 404 is reserved for a project this
   * deployment does not hold (F02-AC2).
   */
  app.get('/api/projects/:projectId/settings', { preHandler: options.guard }, async (request, reply) => {
    const owner = provedOwnerOf(request, reply);
    if (owner === null) return reply;
    const params = parseBody(projectParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));

    const settings = await options.controller.settings.readSettings({
      projectId: asProjectId(params.value.projectId),
      actor: owner,
    });
    if (!settings.ok) return sendProblem(reply, problemFor(settings.error));
    return reply.status(200).send({ settings: settings.value });
  });

  /**
   * Saves or clears the T3 deployment URL.
   *
   * `PATCH` because the field is independently optional and a caller supplies only what it
   * changed; a body naming nothing reads back rather than writing, so a read-then-save round
   * trip is idempotent (mvp-spec 7).
   *
   * A refused URL is the use case's own `Blocked` refusal, so it answers 422 with the
   * prerequisite and its remedy - and with no part of the value in the body (L02-AC2).
   */
  app.patch('/api/projects/:projectId/settings', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(projectParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(updateBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    const updated = await options.controller.settings.updateSettings({
      projectId: asProjectId(params.value.projectId),
      ...(body.value.t3Url === undefined ? {} : { t3Url: body.value.t3Url }),
      at: options.now().toISOString(),
      actor: session.ownerId,
    });
    if (!updated.ok) return sendProblem(reply, problemFor(updated.error));
    return reply.status(200).send({ settings: updated.value });
  });
}
