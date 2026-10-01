/**
 * Liveness, and nothing else.
 *
 * The browser E2E suite has to answer one question before it drives a flow: is the server it
 * just spawned actually serving? Polling an existing private route cannot answer it, because
 * every private route answers an anonymous caller with a refusal, and a readiness check that
 * accepts a 401 or a 404 proves only that a socket accepted bytes (TESTING.md: a server ready
 * signal/health check with a deadline; bounded polling only when there is no ready signal).
 * So the check needs a route whose 2xx means "the request path works", which is what this is.
 *
 * What makes that safe to leave unauthenticated is what it is allowed to say. It answers
 * `{"status":"ok"}` and nothing else: no owner, no project, no repository, no build or
 * dependency identity, no version, no count, no clock. Every one of those would turn an
 * unauthenticated route into a disclosure channel, and liveness has no use for any of them -
 * a caller learns what it needs from the 200 itself. The `onSend` hook in `app.ts` already
 * marks it `no-store` because it sits under `/api/`, so a cached answer cannot outlive the
 * process that produced it (F01-AC1).
 *
 * It deliberately does not check a dependency. A route that opened the database or called a
 * provider would report on that dependency's health, which is a different question with a
 * different blast radius: this process being able to answer at all is the only thing a test
 * harness needs to know before it starts, and readiness that blocks on an unrelated remote
 * would stall a browser run for a reason that has nothing to do with the flow under test.
 */

import type { FastifyInstance } from 'fastify';

/**
 * The one path that means "the server is up". Exported so the harness polls the same path the
 * application serves rather than a copy of it that can drift.
 */
export const HEALTH_PATH = '/api/health';

/** The whole response body. A closed shape on purpose: adding a field here is a disclosure decision. */
export interface HealthResponse {
  readonly status: 'ok';
}

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get(HEALTH_PATH, async () => ({ status: 'ok' }) satisfies HealthResponse);
}
