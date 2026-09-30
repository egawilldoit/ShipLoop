/**
 * Versioned project profile routes (F02-AC1, F02-AC3, F02-AC4, F03-AC3).
 *
 * Saving always appends a version and never edits one in place, because a run names
 * the profile version it used and that reference has to keep meaning the same thing
 * afterwards (F02-AC3). `expectedVersionNumber` travels with every save so a stale
 * editor is refused with a conflict instead of quietly overwriting a change it never
 * saw (F02-AC2, F24-AC4).
 *
 * A profile carries credential *references* only. No field in these schemas accepts a
 * secret value, so a saved profile cannot hold one and a response cannot echo one
 * (F03-AC3).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  fieldErrorsOf,
  fieldsProblem,
  notFound,
  parseBody,
  problemFor,
  sendProblem,
  signInRequiredProblem,
} from '../http-error.ts';
import { asProjectId, type ControllerSurface } from '../contracts.ts';
import type { SessionGuard } from '../auth-guard.ts';

const MAXIMUM_RECIPE_LENGTH = 2000;

const projectIdentifier = z
  .string()
  .trim()
  .min(1, 'A project id is required.')
  .max(128, 'A project id may be at most 128 characters.')
  .refine((value) => !/[/\\]/.test(value), 'A project id may not contain a path separator.');

const previewComponent = z.strictObject({
  component: z.string().trim().min(1, 'A preview component name is required.').max(120),
  environment: z.string().trim().min(1, 'A preview component environment is required.').max(120),
});

const references = z.strictObject({
  repository: z.string().trim().min(1, 'A repository is required.').max(300),
  ticketProvider: z.string().trim().min(1, 'A ticket provider is required.').max(120),
  ticketTeamKey: z.string().trim().max(120, 'A ticket team key may be at most 120 characters.').nullable(),
  baseBranch: z.string().trim().min(1, 'A base branch is required.').max(200),
  targetBranch: z.string().trim().min(1, 'A target branch is required.').max(200),
  deploymentProvider: z.string().trim().min(1, 'A deployment provider is required.').max(120),
  engine: z.string().trim().min(1, 'An engine is required.').max(120),
  previewComponents: z
    .array(previewComponent)
    .min(1, 'At least one preview component is required.')
    .max(20, 'At most 20 preview components are supported.'),
});

const policy = z.strictObject({
  requiredChecks: z
    .array(z.string().trim().min(1, 'A required check may not be blank.').max(200))
    .min(1, 'At least one required check is required.')
    .max(50),
  deliveryBehavior: z.literal('ManualAuthorizationOnly', {
    error: 'Delivery must remain manual-authorization-only (F03-AC5).',
  }),
  maxFixPasses: z.number().int().min(0, 'A fix pass count may not be negative.').max(20),
  workspaceIsolation: z.literal('WorktreeAndDataDirectory', {
    error: 'Workspace isolation must be a worktree and its own data directory.',
  }),
  capabilityVersion: z.number().int().min(1),
});

const environment = z.strictObject({
  runtime: z.string().trim().min(1, 'A runtime is required.').max(120),
  ports: z.array(z.number().int().min(1, 'A port must be between 1 and 65535.').max(65535)).max(20),
  secretReferences: z
    .array(z.string().trim().min(1, 'A secret reference may not be blank.').max(200))
    .max(50),
});

const content = z.strictObject({
  references,
  policy,
  recipe: z.string().trim().min(1, 'A recipe is required.').max(MAXIMUM_RECIPE_LENGTH),
  environment,
});

const saveBody = z.strictObject({
  projectId: projectIdentifier,
  content,
  note: z.string().trim().max(500, 'A note may be at most 500 characters.').nullable().default(null),
  expectedVersionNumber: z.number().int().min(1).nullable().default(null),
});

const projectParams = z.strictObject({ projectId: projectIdentifier });

export interface ProfileRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
  readonly now: () => Date;
}

export function registerProfileRoutes(app: FastifyInstance, options: ProfileRouteOptions): void {
  app.post('/api/profiles', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const body = parseBody(saveBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const saved = await options.controller.profiles.saveVersion({
      projectId: asProjectId(body.value.projectId),
      content: body.value.content,
      note: body.value.note,
      expectedVersionNumber: body.value.expectedVersionNumber,
      at: options.now().toISOString(),
      actor: session.ownerId,
    });
    if (!saved.ok) return sendProblem(reply, problemFor(saved.error));
    return reply.status(201).send({ profile: saved.value });
  });

  app.get('/api/profiles/:projectId', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(projectParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const current = await options.controller.profiles.currentVersion(asProjectId(params.value.projectId));
    if (!current.ok) return sendProblem(reply, problemFor(current.error));
    if (current.value === null) {
      return sendProblem(reply, problemFor(notFound('That project has no saved profile yet.')));
    }
    return reply.status(200).send({ profile: current.value });
  });

  app.get('/api/profiles/:projectId/versions', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(projectParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const versions = await options.controller.profiles.listVersions(asProjectId(params.value.projectId));
    if (!versions.ok) return sendProblem(reply, problemFor(versions.error));
    return reply.status(200).send({ profiles: versions.value });
  });
}