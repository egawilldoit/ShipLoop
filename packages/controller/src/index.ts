/**
 * The controller's public surface: composition, owner and profile use cases,
 * connector use cases, session use cases, and the surface the HTTP layer loads.
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
export * from './adoption.ts';
export * from './composition.ts';
export * from './connectors.ts';
export * from './profiles.ts';
export * from './publication.ts';
export * from './sessions.ts';
export * from './web-surface.ts';