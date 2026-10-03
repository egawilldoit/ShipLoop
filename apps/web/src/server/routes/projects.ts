/**
 * Project routes: list the projects the owner selects from, and create one (F02-AC1).
 *
 * This file exists because of a defect, and the reason is worth recording. Every other
 * route that addresses a project takes its identity from somewhere: the intake form, the
 * plan, the connector registration. Nothing told the client *which* project it was
 * addressing, so the client reached for a field the session response did not carry and
 * every project-scoped request went to a path spelled `/api/profiles/undefined`. The
 * server answered that honestly — 404, "no such project" — and the client reported it as
 * "that project has no saved profile yet", which is a different and wrong claim. A missing
 * identity became an assertion about a project's contents (F02-AC1, F02-AC4).
 *
 * Two properties make the fix structural rather than cosmetic:
 *
 *   - **`list` returns every project, archived included, and `create` needs no provider.**
 *     A project row previously came into existence only as a side effect of a profile save,
 *     a connector registration or a procedure append, and each of those three is refused by
 *     name when no adapter declares the capability it needs. An owner who had configured no
 *     provider therefore had no project to select at all, so a selector fed by those writes
 *     would always have been empty (F03-AC2).
 *   - **The identity is the owner's, chosen explicitly.** A project id is typed by the owner
 *     and validated as a single path segment, because it addresses a directory tree (an
 *     artifact root, a workspace) and a value carrying `/` or `..` is a traversal rather
 *     than a name (F06-AC1).
 *
 * `create` is idempotent by identity: resubmitting the form addresses the project that
 * exists rather than colliding with it, and a repeat does not overwrite the name, so a
 * stale tab cannot rename a project back (F02-AC2, F24-AC4).
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
import type { ControllerSurface } from '../contracts.ts';
import type { SessionGuard } from '../auth-guard.ts';

/**
 * A project identity.
 *
 * Bounded and refused on a path separator or `..` because the value addresses storage: an
 * artifact root, a workspace path and a git checkout are all derived from it. A project id
 * is one path segment, and this is the one place that is enforced for every write (F06-AC1).
 */
const projectIdentifier = z
  .string()
  .trim()
  .min(1, 'A project id is required.')
  .max(128, 'A project id may be at most 128 characters.')
  .refine((value) => !/[/\\]/.test(value) && !value.includes('..'), 'A project id may not contain a path separator or "..".');

const createBody = z.strictObject({
  projectId: projectIdentifier,
  name: z.string().trim().min(1, 'A project needs a name.').max(200, 'A project name may be at most 200 characters.'),
});

export interface ProjectRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
  readonly now: () => Date;
}

export function registerProjectRoutes(app: FastifyInstance, options: ProjectRouteOptions): void {
  /**
   * The projects this deployment holds, oldest first (F02-AC1).
   *
   * Reads carry no caller and take no project selector: there is exactly one provisioned
   * owner, so the whole list is the owner's, and a body naming a project would be a claim
   * this layer cannot check (F01-AC1). Ordering is the store's own rather than recency of
   * use, so the first entry a client renders is the same one every time it loads (N04-AC2).
   */
  app.get('/api/projects', { preHandler: options.guard }, async (_request, reply) => {
    const listed = await options.controller.projects.listProjects();
    if (!listed.ok) return sendProblem(reply, problemFor(listed.error));
    return reply.status(200).send({ projects: listed.value });
  });

  /**
   * Creates a project, or returns the one that already holds that identity (F02-AC1).
   *
   * 201 on a row this request created and 200 on one that already existed, because the
   * difference is what a client needs to decide whether to navigate or to re-read: a 201
   * followed by a redirect to a project that was already there is not wrong, but a client
   * told 201 every time would report a creation that never happened (F02-AC3).
   */
  app.post('/api/projects', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const body = parseBody(createBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    const existing = await options.controller.projects.listProjects();
    if (!existing.ok) return sendProblem(reply, problemFor(existing.error));
    const alreadyThere = existing.value.some((project) => project.projectId === body.value.projectId);

    const created = await options.controller.projects.createProject({
      projectId: body.value.projectId,
      name: body.value.name,
      at: options.now().toISOString(),
    });
    if (!created.ok) return sendProblem(reply, problemFor(created.error));
    return reply.status(alreadyThere ? 200 : 201).send({ project: created.value });
  });
}
