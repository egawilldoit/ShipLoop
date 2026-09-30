/**
 * Process entrypoint: read the environment, compose the controller, listen.
 *
 * The controller implementation is loaded from a module specifier named by
 * `SHIPLOOP_CONTROLLER_MODULE` and checked against the ports in `contracts.ts`.
 * Composing it here rather than importing it directly is what lets the web server be
 * built and tested against fakes while `packages/controller` is written against its
 * own use cases; the cost is that the loaded value is external input, so it is
 * validated structurally before anything starts.
 *
 * This is the only file in the server that opens a socket or writes to the console.
 */

import { buildApp } from './app.ts';
import { describeConfigErrors, readServerConfig } from './config.ts';
import { isControllerSurface, type ControllerSurface } from './contracts.ts';

const CONTROLLER_MODULE_ENV = 'SHIPLOOP_CONTROLLER_MODULE';

async function loadController(specifier: string): Promise<ControllerSurface> {
  const loaded: unknown = await import(specifier);
  const candidate = unwrapDefault(loaded);
  if (!isControllerSurface(candidate)) {
    throw new Error(
      `${specifier} does not export a controller surface. Expected an object with owners, sessions, profiles and connectors use cases.`,
    );
  }
  return candidate;
}

/** Accepts either a default export or the module namespace. */
function unwrapDefault(loaded: unknown): unknown {
  if (typeof loaded !== 'object' || loaded === null) return loaded;
  const candidate = (loaded as { readonly default?: unknown }).default;
  return candidate === undefined ? loaded : candidate;
}

async function main(): Promise<void> {
  const config = readServerConfig(process.env);
  if (!config.ok) throw new Error(`ShipLoop web configuration is invalid: ${describeConfigErrors(config.errors)}`);
  const specifier = process.env[CONTROLLER_MODULE_ENV];
  if (specifier === undefined || specifier === '') {
    throw new Error(
      `${CONTROLLER_MODULE_ENV} must name the module that builds the controller surface, for example '@shiploop/controller'.`,
    );
  }
  const app = await buildApp({
    config: config.value,
    controller: await loadController(specifier),
    now: () => new Date(),
  });
  const address = await app.listen({ host: config.value.host, port: config.value.port });
  console.log(`ShipLoop web listening on ${address}`);
}

await main();