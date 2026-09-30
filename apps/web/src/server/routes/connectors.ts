/**
 * Connector routes (F03-AC1, F03-AC2, F03-AC3, F03-AC4).
 *
 * A connector is registered by pointer, never by value: the request carries the name
 * of a stored credential and nothing else. There is deliberately no field here that
 * accepts a secret, so a secret cannot be submitted, stored through this route, or
 * reflected back (F03-AC3).
 *
 * The status response carries status, last-checked time, the read/write capability
 * split and the actionable error, because "is it connected" is not a question a
 * boolean answers and an expired credential needs to say so in words (F03-AC2).
 * Capabilities come from the adapter rather than from the request body, so a client
 * cannot claim a write authority it does not hold (F03-AC5).
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
import { asConnectorId, asProjectId, type ControllerSurface } from '../contracts.ts';
import type { SessionGuard } from '../auth-guard.ts';

const projectIdentifier = z
  .string()
  .trim()
  .min(1, 'A project id is required.')
  .max(128, 'A project id may be at most 128 characters.')
  .refine((value) => !/[/\\]/.test(value), 'A project id may not contain a path separator.');

const registerBody = z.strictObject({
  provider: z.string().trim().min(1, 'A provider is required.').max(120),
  kind: z.enum(['Ticket', 'Git', 'Deployment', 'Engine'], {
    error: 'A connector kind must be Ticket, Git, Deployment or Engine.',
  }),
  resourceScope: z
    .string()
    .trim()
    .min(1, 'A resource scope is required.')
    .max(300, 'A resource scope may be at most 300 characters.'),
  /**
   * A pointer into the credential store. Its length and shape are bounded so a
   * client cannot push a whole credential through a field meant for its name.
   */
  credentialReference: z
    .string()
    .trim()
    .min(1, 'A credential reference is required.')
    .max(200, 'A credential reference may be at most 200 characters.'),
});

const projectParams = z.strictObject({ projectId: projectIdentifier });
const connectorParams = z.strictObject({
  connectorId: z.string().trim().min(1, 'A connector id is required.').max(128),
});

const revokeBody = z.strictObject({
  reason: z.string().trim().min(1, 'A reason is required.').max(500, 'A reason may be at most 500 characters.'),
});

export interface ConnectorRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
  readonly now: () => Date;
}

export function registerConnectorRoutes(app: FastifyInstance, options: ConnectorRouteOptions): void {
  app.post('/api/profiles/:projectId/connectors', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(projectParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(registerBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const registered = await options.controller.connectors.register({
      projectId: asProjectId(params.value.projectId),
      provider: body.value.provider,
      kind: body.value.kind,
      resourceScope: body.value.resourceScope,
      credentialReference: body.value.credentialReference,
      at: options.now().toISOString(),
      actor: session.ownerId,
    });
    if (!registered.ok) return sendProblem(reply, problemFor(registered.error));
    return reply.status(201).send({ connector: registered.value });
  });

  app.get('/api/profiles/:projectId/connectors', { preHandler: options.guard }, async (request, reply) => {
    const params = parseBody(projectParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const connectors = await options.controller.connectors.listForProject(asProjectId(params.value.projectId));
    if (!connectors.ok) return sendProblem(reply, problemFor(connectors.error));
    return reply.status(200).send({ connectors: connectors.value });
  });

  app.post('/api/connectors/:connectorId/revoke', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const params = parseBody(connectorParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(revokeBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));
    const revoked = await options.controller.connectors.revoke({
      connectorId: asConnectorId(params.value.connectorId),
      at: options.now().toISOString(),
      reason: body.value.reason,
      actor: session.ownerId,
    });
    if (!revoked.ok) return sendProblem(reply, problemFor(revoked.error));
    return reply.status(200).send({ connector: revoked.value });
  });
}