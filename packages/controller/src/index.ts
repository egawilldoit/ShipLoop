/**
 * The controller's public surface: composition, owner and profile use cases, and
 * connector use cases.
 *
 * `apps/web` and `apps/worker` import only from this root. Nothing here reaches a
 * provider SDK or restates a lifecycle rule; the use cases are the only supported
 * entry points, so an application cannot reach the repositories without passing the
 * authorization gate in `profiles.ts`.
 */

export * from './composition.ts';
export * from './connectors.ts';
export * from './profiles.ts';