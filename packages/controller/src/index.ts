/**
 * The controller's public surface: composition, owner and profile use cases,
 * connector use cases, intake use cases, session use cases, the external-execution
 * handoff, and the surface the HTTP layer loads.
 *
 * `apps/web` and `apps/worker` import only from this root. Nothing here reaches a
 * provider SDK or restates a lifecycle rule; the use cases are the only supported
 * entry points, so an application cannot reach the repositories without passing the
 * authorization gate in `profiles.ts`.
 *
 * The surface is re-exported as this package's default rather than only from
 * `web-surface.ts`, because `export *` skips a default export and the web server
 * loads this module by specifier: it takes whatever `default` it finds, and a
 * package whose entry point has no `default` makes `apps/web` refuse to start with
 * the surface one import away.
 */

export { default } from './web-surface.ts';
export * from './acceptance.ts';
export * from './adoption.ts';
export * from './composition.ts';
export * from './context-packet.ts';
export * from './brief-generation.ts';
export * from './candidate-linking.ts';
export * from './connectors.ts';
export * from './contracts.ts';
export * from './delivery.ts';
export * from './handoff/index.ts';
export * from './intake.ts';
export * from './profiles.ts';
export * from './publication.ts';
export * from './jobs.ts';
export * from './mvp-review.ts';
export * from './mvp-review-card.ts';
export * from './attention.ts';
export * from './owner-tests.ts';
export * from './plan-generation.ts';
export * from './procedures.ts';
export * from './verification.ts';
export * from './sessions.ts';
export * from './web-surface.ts';