/**
 * Process entrypoint: read the environment, open the store, run the loop, stop cleanly.
 *
 * This is the only file in the worker that writes to the console, and it writes lifecycle lines
 * only. Everything it composes is injected, so a test drives `createWorker` directly and this
 * file stays the thin process shell the architecture asks for (ARCHITECTURE "Deployment and
 * responsibilities": the worker must not live inside request handlers).
 *
 * One dependency is resolved through a configured module specifier rather than imported
 * directly, which is the pattern `apps/web` already uses for its controller: the isolated
 * workspace provider. Preparing a worktree, a data directory, ports and a lock is the F14 unit's
 * work, and this process must not invent a workspace (F14-AC1). The engine is the real Codex
 * adapter from `@shiploop/adapters`, because a worker that spawned `codex` itself would be a
 * second engine implementation outside the verified process-group boundary (F17-AC1, N02-AC3).
 */

import { setTimeout as delay } from 'node:timers/promises';
import { redact } from '@shiploop/domain';
import type { ConnectorId } from '@shiploop/domain';
import { CodexEngineAdapter } from '@shiploop/adapters';
import type { AdapterClock, AdapterLogger } from '@shiploop/adapters';
import {
  AttentionItemRepository,
  WorkItemRepository,
  createJobQueue,
  createLeaseManager,
} from '@shiploop/storage';
import type { JobQueue, LeaseManager } from '@shiploop/storage';
import { describeConfigErrors, readWorkerConfig } from './config.ts';
import type { CheckpointFactsPort, OwnerExtensionPort, WorkspacePort } from './runner.ts';
import { createWorker, openWorkerStore } from './worker.ts';
import type { HolderLivenessPort } from './worker.ts';

/** Bound on structured engine events one session may produce before the attempt is cut off. */
const ENGINE_EVENT_LIMIT = 1_000;

/** The process clock. Every policy decision reads this rather than `Date.now()` (F18-AC2). */
const systemClock: AdapterClock = {
  now: (): string => new Date().toISOString(),
  elapsedMs: (): number => Number(process.hrtime.bigint() / 1_000n),
};

/** Lifecycle lines only; the loop's own detail goes through the injected logger (N06-AC1). */
const lifecycleLogger: AdapterLogger = {
  emit(record): void {
    if (record.level === 'Error') console.error(`${record.level} ${record.message}`);
    else if (record.level === 'Warn') console.warn(`${record.level} ${record.message}`);
  },
};

async function main(): Promise<void> {
  const config = readWorkerConfig(process.env);
  if (!config.ok) {
    throw new Error(`ShipLoop worker configuration is invalid: ${describeConfigErrors(config.errors)}`);
  }

  const store = openWorkerStore(config.value.databasePath);
  if (!store.ok) throw new Error(`ShipLoop worker cannot open its store: ${store.error.reason}`);

  const leases: LeaseManager = createLeaseManager({ connection: store.value.database });
  const queue: JobQueue = createJobQueue({ connection: store.value.database });
  const workspaces = await loadWorkspacePort(config.value.workspaceModule);

  const worker = createWorker(
    {
      holder: config.value.holder,
      projectId: config.value.projectId,
      leaseTtlMs: config.value.leaseTtlMs,
      pollIntervalMs: config.value.pollIntervalMs,
      engineEventLimit: ENGINE_EVENT_LIMIT,
    },
    {
      clock: systemClock,
      logger: lifecycleLogger,
      redact: (text: string): string => redact(text).text,
      engine: new CodexEngineAdapter({
        connectorId: `engine_${config.value.holder}` as ConnectorId,
        client: {
          binary: config.value.engine.binary,
          gracefulStopMs: config.value.gracefulStopMs,
          killWaitMs: config.value.killWaitMs,
        },
        sandbox: config.value.engine.sandbox,
      }),
      queue,
      leases,
      workItems: new WorkItemRepository(store.value.database),
      attention: new AttentionItemRepository(store.value.database),
      workspaces,
      extensions: noOwnerExtensions(),
      facts: noCheckpointFacts(),
      liveness: unknownHolderLiveness(),
      sleep: async (ms: number): Promise<void> => {
        await delay(ms);
      },
    },
  );
  if (!worker.ok) {
    store.value.close();
    throw new Error(`ShipLoop worker cannot start: ${worker.error.reason}`);
  }

  console.log(`ShipLoop worker ${config.value.holder} starting on ${config.value.databasePath}`);
  const controller = new AbortController();
  const stop = (): void => {
    worker.value.requestStop();
    controller.abort();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  try {
    const report = await worker.value.run(controller.signal);
    console.log(
      `ShipLoop worker stopped after ${String(report.ticks)} tick(s): ${String(report.claimed)} claimed, ${String(report.resumed)} recovered, ${String(report.completed)} completed, ${String(report.paused)} paused, ${String(report.detached)} awaiting reconciliation, ${String(report.errors.length)} error(s).`,
    );
  } finally {
    const closed = store.value.close();
    if (!closed.ok) console.error(`ShipLoop worker could not close its store: ${closed.error.reason}`);
  }
}

/**
 * Loads the isolated-workspace provider and refuses anything that is not one.
 *
 * The loaded value is external input, so it is checked before any job runs: a provider that
 * could not prepare a workspace would otherwise fail at the first attempt, inside the single
 * coding writer (F14-AC1).
 */
async function loadWorkspacePort(specifier: string): Promise<WorkspacePort> {
  const loaded: unknown = await import(specifier);
  const candidate =
    typeof loaded === 'object' && loaded !== null
      ? (loaded as { readonly createWorkspacePort?: unknown }).createWorkspacePort
      : undefined;
  if (typeof candidate !== 'function') {
    throw new Error(`${specifier} must export a createWorkspacePort function returning a WorkspacePort (F14-AC1).`);
  }
  const factory = candidate as () => WorkspacePort | Promise<WorkspacePort>;
  return await factory();
}

/**
 * No owner extension is configured in this build.
 *
 * F18-AC2 requires reaching a limit to checkpoint and wait for an owner extension, and no durable
 * record for such an extension exists yet. Until it does, waiting is the correct behaviour and
 * silently lifting the limit would be the wrong one.
 */
function noOwnerExtensions(): OwnerExtensionPort {
  return { extensionFor: () => null };
}

/** Owner feedback and observed check results have no durable source in this build (F17-AC2). */
function noCheckpointFacts(): CheckpointFactsPort {
  return { feedbackFor: () => [], resultsFor: () => [] };
}

/**
 * A restarted worker cannot observe a process it did not spawn.
 *
 * Answering `Unknown` keeps the coding writer with its previous holder until an operator or a
 * process supervisor confirms that holder stopped (F17-AC5).
 */
function unknownHolderLiveness(): HolderLivenessPort {
  return {
    probe: (request) => ({
      kind: 'Unknown',
      evidence: `This process holds no handle to the group ${request.holder} used for job ${request.jobId}, so whether it is still writing cannot be established from here.`,
    }),
  };
}

await main();