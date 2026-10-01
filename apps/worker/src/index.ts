/**
 * Process entrypoint: read the environment, open the store, run the loop, stop cleanly.
 *
 * This is the only file in the worker that writes to the console, and it writes lifecycle lines
 * only. Everything it composes comes from `runtime.ts`, which opens the real migrated store, binds
 * the real Codex engine, the real isolated-workspace module, the real Git adapter, the real check
 * runner and the real controller use cases, so a start configured by the environment alone runs a
 * queued job to a linked draft (ARCHITECTURE "Deployment and responsibilities": the worker must not
 * live inside request handlers; F14-AC1, F19-AC1).
 *
 * The engine is the shipped `CodexEngineAdapter` from `@shiploop/adapters`, because a worker that
 * spawned `codex` itself would be a second engine implementation outside the verified process-group
 * boundary (F17-AC1, N02-AC3). The workspace provider is the shipped `@shiploop/verification`
 * module, and the only dependency left is the environment: a worker that had to be handed a module
 * specifier and an injected double was not runnable in production (F14-AC1).
 */

import { describeConfigErrors } from './config.ts';
import { createWorkerRuntime, readRuntimeConfig } from './runtime.ts';

/**
 * Holds the event loop for as long as the run is in flight.
 *
 * A graceful stop is the adapter waiting for the engine's process group to empty, and that wait
 * polls with unreferenced timers (`waitForEmptyGroup` in `packages/adapters/src/codex/client.ts`).
 * An unreferenced timer does not keep Node alive, so a stop whose group is momentarily still
 * occupied after the leader has been reaped has nothing left holding the process open: Node ends the
 * run, the process exits 13, and the job is left `Running` with no checkpoint — the one state
 * F17-AC5 says may not be taken over blind. The timer is referenced while the loop runs and cleared
 * when it returns, so the process lives exactly as long as the work does and no longer.
 */
function holdEventLoopOpen(): () => void {
  const timer = setInterval(() => undefined, 1_000);
  return (): void => {
    clearInterval(timer);
  };
}

async function main(): Promise<void> {
  const releaseEventLoop = holdEventLoopOpen();
  try {
    await runWorker();
  } finally {
    releaseEventLoop();
  }
}

async function runWorker(): Promise<void> {
  const config = readRuntimeConfig(process.env);
  if (!config.ok) {
    throw new Error(`ShipLoop worker configuration is invalid: ${describeConfigErrors(config.errors)}`);
  }

  const started = await createWorkerRuntime(config.value);
  if (!started.ok) throw new Error(`ShipLoop worker cannot start: ${started.error.reason}`);

  const runtime = started.value;
  console.log(`ShipLoop worker ${config.value.holder} starting on ${config.value.databasePath}`);
  const controller = new AbortController();
  const stop = (): void => {
    runtime.requestStop();
    controller.abort();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  try {
    const report = await runtime.run(controller.signal);
    const deliveries = report.deliveries
      .map((outcome) =>
        outcome.kind === 'DraftWritten'
          ? `draft ${String(outcome.pullRequestId)} at ${outcome.headSha} (${outcome.write}${outcome.notReady.length === 0 ? '' : `, not ready: ${outcome.notReady.length} reason(s)`})`
          : outcome.kind === 'NoCodeOutcome'
            ? `no-code outcome (${outcome.branchState})`
            : `delivery refused: ${outcome.reason}`,
      )
      .join('; ');
    console.log(
      `ShipLoop worker stopped after ${String(report.ticks)} tick(s): ${String(report.claimed)} claimed, ${String(report.completed)} completed, ${String(report.blocked)} blocked, ${String(report.waitingForOwner)} awaiting an owner, ${String(report.paused)} paused, ${String(report.detached)} awaiting reconciliation, ${String(report.idle)} idle, ${String(report.errors.length)} error(s).`,
    );
    if (deliveries !== '') console.log(`ShipLoop worker deliveries: ${deliveries}`);
    for (const error of report.errors) console.error(`Error ${error}`);
  } finally {
    const closed = runtime.close();
    if (!closed.ok) console.error(`Error ShipLoop worker could not close its store: ${closed.error.reason}`);
  }
}

await main();
