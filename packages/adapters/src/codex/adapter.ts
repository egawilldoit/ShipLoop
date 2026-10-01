/**
 * The Codex coding-engine adapter (F15, F15-AC1, F15-AC2, F15-AC3, F15-AC4, F17-AC1, F18-AC4, F03-AC5, N02-AC3).
 *
 * Codex is the first engine ShipLoop actually runs. Everything this adapter reports about Codex
 * was observed on `codex-cli 0.159.1` on this host (linux/arm64, 2 x Neoverse-N1, ~12 GiB RAM,
 * no swap, Node 24.18.0) on 1 October 2026; `README.md` separates those captures from the clauses
 * that are derived only from the binary's own strings.
 *
 * Three engine limits shape this file and are stated rather than worked around.
 *
 * **Codex reports no stage and no artifact.** Its JSONL names a thread, a turn and typed items,
 * and nothing else. Stages are therefore this adapter's translation, and every progress event
 * carries the engine's own text beside it. Codex also writes nothing to a ShipLoop artifact
 * store, so `Progress.detail` is always null: naming an `ArtifactReference` requires a `uri` and
 * a literal `sanitized: true`, and this unit has no store to point at, so claiming one would be
 * fabricating evidence rather than reporting it (F15-AC2).
 *
 * **Codex cannot produce an `EngineCheckpoint`.** A checkpoint needs the dirty and untracked
 * inventory, which is a Git fact, and `EngineCheckpoint.headSha` is a `CommitSha` this adapter
 * has no way to read. `stopSession` therefore returns `checkpoint: null` rather than a partial
 * one; the controller composes the checkpoint from the Git adapter, and the contract permits
 * null in `EngineStopOutcome.Stopped` for exactly this case.
 *
 * **Continuation is genuinely available, with one caveat.** `codex exec resume <SESSION_ID>` exists
 * on 0.159.1 and really does restore the conversation: a resumed run was asked, with no tool
 * available to check, which file it had created in the earlier turn, and answered
 * `probe.txt: HELLO`. `resumeSession` therefore reports `ResumedInPlace` rather than declaring
 * restoration unsupported, and falls back to `RestartedFromCheckpoint` only when the recorded
 * rollout is genuinely gone. The caveat is that `resume` accepts neither `--sandbox` nor `--cd`,
 * so the sandbox arrives as `-c sandbox_mode=...` and the workspace as the child's own working
 * directory. Both were verified live and both are named in the `Engine:ResumeSession`
 * capability declaration, so the limitation is visible before a resume is attempted rather than
 * discovered afterwards (F15-AC4).
 */

import { err, ok, type CapabilityDeclaration, type ConnectorId, type DomainError, type ProviderId, type Result } from '@shiploop/domain';

import {
  ADAPTER_CONTRACT_VERSION,
  deniedCodingCapabilities,
  type AdapterCapabilities,
  type AdapterCompatibility,
  type AdapterContext,
  type CodingSessionCapability,
  type EngineAdapter,
  type EngineBounds,
  type EngineContinuation,
  type EngineEvent,
  type EngineMode,
  type EngineSessionHandle,
  type EngineSessionStart,
  type EngineStartRequest,
  type EngineStopOutcome,
  type EngineStopReason,
  type ResumeEngineSessionRequest,
  type StopEngineSessionRequest,
} from '../contracts/index.ts';

import {
  CODEX_VERIFIED_VERSION,
  CodexClient,
  MINIMUM_CODEX_VERSION,
  resolveSandboxMode,
  stopCodexProcess,
  type CodexClientOptions,
  type CodexProcess,
  type CodexStopReport,
} from './client.ts';

import {
  finalizeCodexStream,
  initialCodexStreamState,
  translateCodexLine,
  type CodexStreamInterruption,
  type CodexStreamState,
  type CodexTranslationOptions,
} from './events.ts';

import { mapCodexFailure } from './errors.ts';

/**
 * Capability declarations.
 *
 * `Engine:ResumeSession` is declared supported because Codex restores its own conversation on
 * 0.159.1, verified live. Its `limitation` is non-null anyway, because the mechanism differs from
 * a fresh start and an owner reading the declarations should not have to run a resume to discover
 * that the sandbox arrives as a config override (F03-AC2).
 */
const DECLARATIONS: readonly CapabilityDeclaration[] = [
  { kind: 'Engine:VersionCheck', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  {
    kind: 'Engine:StartScoped',
    supported: true,
    limitation: null,
    privileged: false,
    supportsPrecondition: false,
  },
  {
    kind: 'Engine:StopGraceful',
    supported: true,
    limitation:
      'Stop sends SIGTERM to the spawned process group, waits a bounded window, then SIGKILLs the same group. `codex exec` has no in-band shutdown request, so a graceful stop is a signal to the group and nothing more. A group that survives the kill is reported Detached, never Stopped (F17-AC1).',
    privileged: false,
    supportsPrecondition: false,
  },
  {
    kind: 'Engine:ResumeSession',
    supported: true,
    limitation: `codex exec resume on ${CODEX_VERIFIED_VERSION} restores the recorded conversation, but it accepts neither --sandbox nor --cd: the sandbox is applied as -c sandbox_mode='<mode>' and the workspace as the spawned process working directory. Both were verified live on linux/arm64. When the recorded rollout no longer exists the adapter starts a fresh session seeded from the checkpoint (F15-AC4).`,
    privileged: false,
    supportsPrecondition: false,
  },
  {
    kind: 'Engine:ReportUsage',
    supported: true,
    limitation:
      'Codex reports input, cached input, cache-write and output token counts on turn.completed and nothing else: no quota window, no remaining balance and no cost. Absent usage is reported Unknown rather than estimated (F18-AC4).',
    privileged: false,
    supportsPrecondition: false,
  },
];

/** Bound on how long a start waits for Codex's first `thread.started` event before failing. */
const SESSION_START_TIMEOUT_MS = 120_000;

/** Upper bound on events buffered for a consumer that has not started iterating yet. */
const MAX_QUEUED_EVENTS = 4_096;

/** Upper bound on the checkpoint inventory handed to the engine, so it cannot dominate the prompt. */
const MAX_CHECKPOINT_PATHS = 100;

export interface CodexEngineAdapterOptions {
  readonly connectorId: ConnectorId;
  readonly client?: CodexClientOptions;
  /** The sandbox granted to every session. Must be one of the two permitted modes. */
  readonly sandbox?: string;
  /** Bound on waiting for Codex's first structured event before declaring the start failed. */
  readonly sessionStartTimeoutMs?: number;
}

/** A session this adapter is tracking, which is what makes an addressed stop possible. */
interface TrackedSession {
  readonly process: CodexProcess;
  readonly stopReason: { current: EngineStopReason | null };
}

/** Everything `launch` needs, so `startSession` and the resume fallback cannot drift apart. */
interface LaunchRequest {
  readonly workspace: EngineStartRequest['workspace'];
  readonly start: EngineSessionStart;
  readonly mode: EngineMode;
  readonly grantedCapabilities: readonly CodingSessionCapability[];
  readonly bounds: EngineBounds;
}

export class CodexEngineAdapter implements EngineAdapter {
  readonly kind = 'Engine' as const;
  readonly connectorId: ConnectorId;
  private readonly client: CodexClient;
  private readonly clientOptions: CodexClientOptions;
  private readonly requestedSandbox: string;
  private readonly sessionStartTimeoutMs: number;
  private readonly tracked = new Map<ProviderId, TrackedSession>();

  constructor(options: CodexEngineAdapterOptions) {
    this.connectorId = options.connectorId;
    this.clientOptions = options.client ?? { binary: 'codex' };
    this.client = new CodexClient(this.clientOptions);
    this.requestedSandbox = options.sandbox ?? 'workspace-write';
    this.sessionStartTimeoutMs = options.sessionStartTimeoutMs ?? SESSION_START_TIMEOUT_MS;
  }

  capabilities(): AdapterCapabilities {
    return { kind: 'Engine', contractVersion: ADAPTER_CONTRACT_VERSION, declarations: DECLARATIONS };
  }

  /**
   * `Engine:VersionCheck`: observes the engine rather than trusting a pinned constant.
   *
   * The verified version is a named constant, but a report still says which binary answered, and
   * an engine older than the measured event schema is reported incompatible with the reason
   * instead of being run on an assumption (F04-AC2, F15-AC4).
   */
  async checkCompatibility(context: AdapterContext): Promise<Result<AdapterCompatibility>> {
    const verdict = await this.client.checkVersion(context);
    if (!verdict.ok) return err(verdict.error);
    return ok({
      kind: 'Engine',
      contractVersion: ADAPTER_CONTRACT_VERSION,
      runtimeVersion: verdict.value.runtimeVersion,
      compatible: verdict.value.compatible,
      detail: `${verdict.value.detail} Verified against ${CODEX_VERIFIED_VERSION}; the declared floor is ${MINIMUM_CODEX_VERSION}.`,
      observedAt: context.clock.now(),
    });
  }

  /**
   * `Engine:StartScoped`: a Codex session confined to one workspace under a bounded sandbox.
   *
   * Two refusals happen before any process is created. A grant carrying a delivery capability is
   * refused at runtime as well as by the type, because the request crosses a trust boundary and
   * a grant assembled outside the type system must not carry a delivery action into a coding
   * session (F03-AC5, N02-AC3). An unlisted sandbox mode is refused by the allowlist in
   * `resolveSandboxMode`, because the operator profile on the host may ask for an unrestricted
   * engine and the flag on this command line is the only thing that overrides it.
   *
   * The returned handle carries the **real** Codex thread id, read from the `thread.started` event
   * Codex itself emits, never a locally generated placeholder: that id is what `codex exec resume`
   * addresses, so a placeholder would make every continuation impossible (F15-AC1).
   */
  async startSession(context: AdapterContext, request: EngineStartRequest): Promise<Result<EngineSessionHandle>> {
    return this.launch(context, request, 'Fresh');
  }

  /**
   * `Engine:ResumeSession`: continues the recorded Codex thread when it still exists.
   *
   * Codex restores its own conversation, so this is a real in-place continuation rather than a
   * checkpoint replay and is reported as one. The recorded rollout lives in Codex's own store
   * under `CODEX_HOME`; when it has gone, the observed stderr is
   * `thread/resume failed: no rollout found for thread id <id> (code -32600)` with exit code 1 and
   * no JSONL at all. That is the only condition that produces the contract's checkpoint fallback,
   * and the fallback is a **fresh** session seeded with the checkpoint rather than a bare retry
   * (F15-AC4).
   */
  async resumeSession(
    context: AdapterContext,
    request: ResumeEngineSessionRequest,
  ): Promise<Result<EngineContinuation>> {
    const launch: LaunchRequest = {
      workspace: request.workspace,
      start: { kind: 'FromCheckpoint', checkpoint: request.checkpoint, instruction: request.instruction },
      mode: 'Headless',
      grantedCapabilities: request.grantedCapabilities,
      bounds: request.bounds,
    };

    const resumed = await this.launch(context, launch, 'Resume', request.priorSession.sessionId);
    if (resumed.ok) {
      return ok({
        kind: 'ResumedInPlace',
        session: resumed.value,
        resumedFromEventAt: request.priorSession.lastEventAt,
      });
    }

    const limitation = missingRolloutDetail(resumed.error);
    if (limitation === null) return err(resumed.error);

    const fallback = await this.launch(context, launch, 'Fresh');
    if (!fallback.ok) return err(fallback.error);
    return ok({
      kind: 'RestartedFromCheckpoint',
      session: fallback.value,
      checkpoint: request.checkpoint,
      limitation,
    });
  }

  /**
   * `Engine:StopGraceful`: signal the tracked process group, then report what actually happened.
   *
   * `Stopped` is returned only after the group is confirmed gone. A session whose process this
   * adapter does not hold is `StopRefused`, because signalling a process it did not spawn is
   * exactly the second-writer hazard F17-AC5 is about, and searching for one by name or port is
   * never an alternative. A group that survives the kill is `Detached` with reconciliation
   * required, never `Stopped` (F17-AC1).
   */
  async stopSession(
    context: AdapterContext,
    request: StopEngineSessionRequest,
  ): Promise<Result<EngineStopOutcome>> {
    const session = this.tracked.get(request.sessionId);
    if (session === undefined) {
      return ok({
        kind: 'StopRefused',
        detail: `No Codex process group is tracked for session ${request.sessionId}, so nothing was signalled. Refusing rather than searching for a process by name is what keeps a second writer off the workspace (F17-AC5).`,
      });
    }
    session.stopReason.current = request.reason;

    const report: CodexStopReport = await stopCodexProcess(session.process, {
      ...(this.clientOptions.gracefulStopMs === undefined ? {} : { gracefulStopMs: this.clientOptions.gracefulStopMs }),
      ...(this.clientOptions.killWaitMs === undefined ? {} : { killWaitMs: this.clientOptions.killWaitMs }),
    });
    this.tracked.delete(request.sessionId);

    if (!report.stopped || report.survivors) {
      return ok({
        kind: 'Detached',
        detail: `Codex did not leave process group ${String(session.process.processGroupId)} after ${report.graceful ? 'SIGTERM' : 'SIGTERM and SIGKILL'}. A process may still be writing in the attempt workspace, so reconcile before any other writer touches it (F17-AC1, F17-AC5).`,
        reconcileRequired: true,
      });
    }

    return ok({
      kind: 'Stopped',
      stoppedAt: context.clock.now(),
      // Codex holds no checkpoint and cannot read the dirty inventory this contract requires, so
      // none is invented here. The controller composes the checkpoint from the Git adapter.
      checkpoint: null,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private async launch(
    context: AdapterContext,
    request: LaunchRequest,
    invocation: 'Fresh' | 'Resume',
    priorSessionId?: string,
  ): Promise<Result<EngineSessionHandle>> {
    const denied = deniedCodingCapabilities(request.grantedCapabilities);
    if (denied.length > 0) {
      return err({
        code: 'Forbidden',
        reason: `A coding stage session may not hold ${denied.join(', ')}; a delivery action belongs to an authorized delivery executor (F03-AC5, N02-AC3).`,
      });
    }
    if (request.mode !== 'Headless') {
      return err({
        code: 'Forbidden',
        reason:
          'Codex is driven headlessly through `codex exec`, which has no interactive transport this adapter can read as structured events. An interactive session would report progress the adapter cannot see, so it is refused rather than run unobserved.',
      });
    }
    const sandbox = resolveSandboxMode(this.requestedSandbox, context.redact);
    if (!sandbox.ok) return err(sandbox.error);

    const prompt = renderPrompt(request.start, context.redact);
    const startedAt = context.clock.now();
    // `EngineStartRequest.bounds` and `ResumeEngineSessionRequest.bounds` are both required, so
    // there is no adapter-level default to fall back to and none is invented here (F18-AC2).
    const bounds = request.bounds;

    const spawned = this.client.start({
      cwd: request.workspace.absolutePath,
      sandbox: sandbox.value,
      prompt,
      invocation,
      signal: context.signal,
      ...(priorSessionId === undefined ? {} : { priorSessionId }),
    });
    if (!spawned.ok) return err(spawned.error);
    const running = spawned.value;

    const channel = new EventChannel();
    const stopReason: { current: EngineStopReason | null } = { current: null };
    const options: CodexTranslationOptions = {
      engineVersion: CODEX_VERIFIED_VERSION,
      mode: request.mode,
      startedFrom: request.start.kind,
      now: (): string => context.clock.now(),
      redact: context.redact,
    };

    let observedSessionId: ProviderId | null = null;
    let announceSessionId: (id: ProviderId) => void = () => undefined;
    const announced = new Promise<ProviderId>((resolve) => {
      announceSessionId = resolve;
    });

    const pump = (async (): Promise<void> => {
      let state: CodexStreamState = initialCodexStreamState();
      let emitted = 0;
      let lineIndex = 0;
      let interruption: CodexStreamInterruption | null = null;

      const wallClock = setTimeout(() => {
        interruption = 'BudgetExhausted';
        running.killProcessGroup();
      }, Math.max(1, bounds.activeWallClockMs));
      wallClock.unref?.();
      const onAbort = (): void => {
        interruption = 'Stopped';
        running.killProcessGroup();
      };
      context.signal.addEventListener('abort', onAbort, { once: true });

      try {
        outer: for await (const line of running.lines()) {
          if (interruption !== null) break;
          const outcome = translateCodexLine(line, state, options, lineIndex);
          lineIndex += 1;
          state = outcome.state;
          if (outcome.kind === 'Events') {
            for (const event of outcome.events) {
              channel.push(event);
              emitted += 1;
              if (emitted >= Math.max(1, bounds.eventCountLimit)) {
                interruption = 'BudgetExhausted';
                break outer;
              }
            }
          }
          if (state.sessionId !== null && observedSessionId === null) {
            observedSessionId = state.sessionId;
            this.tracked.set(state.sessionId, { process: running, stopReason });
            announceSessionId(state.sessionId);
          }
        }
      } finally {
        clearTimeout(wallClock);
        context.signal.removeEventListener('abort', onAbort);
      }

      if (stopReason.current !== null) {
        channel.push({ kind: 'Stopped', at: context.clock.now(), reason: stopReason.current });
      }
      const exit = await running.waited();
      if (observedSessionId !== null) this.tracked.delete(observedSessionId);
      running.dispose();

      for (const event of finalizeCodexStream({
        state,
        options,
        startedAt,
        interruption: stopReason.current === null ? interruption : 'Stopped',
        exitCode: exit.exitCode,
      })) {
        channel.push(event);
      }
      channel.close();
    })();

    // A null race means the pump finished or the bound expired without a `thread.started` event.
    // Either way no session identity exists, so the attempt cannot start and the group is killed
    // rather than left running with nobody holding its handle. `dispose` is not called again here:
    // the pump owns it, and `waited()` still resolves because it captured the exit promise directly.
    const startedSessionId = await Promise.race([announced, pump.then(() => null), timeoutAfter(this.sessionStartTimeoutMs)]);
    if (startedSessionId === null) {
      running.killProcessGroup();
      const exit = await running.waited();
      return err(
        mapCodexFailure({
          detail: startupFailureDetail(running, exit.exitCode, context.redact),
          exitCode: exit.exitCode,
          redact: context.redact,
        }),
      );
    }

    return ok({
      sessionId: startedSessionId,
      engineVersion: CODEX_VERIFIED_VERSION,
      mode: request.mode,
      workspace: request.workspace,
      grantedCapabilities: request.grantedCapabilities,
      startedAt,
      events: channel,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Prompt                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Renders the instruction, prefixed by the checkpoint when the run continues one.
 *
 * The block states that it is authoritative and that the engine has no memory of the prior
 * attempt. Without that sentence a continued run reads the block as background colour instead of
 * as the state it must continue from, which is the failure F17-AC2 is about.
 */
export function renderPrompt(start: EngineSessionStart, redact: (text: string) => string): string {
  if (start.kind === 'Fresh') return redact(start.instruction);
  const checkpoint = start.checkpoint;
  return redact(
    [
      'ShipLoop continuation. The engine has no memory of the interrupted attempt; everything below is its state.',
      `- checkpoint: ${checkpoint.checkpointId} captured at ${checkpoint.capturedAt}`,
      `- scope fingerprint: ${checkpoint.scopeFingerprint}`,
      `- head commit: ${checkpoint.headSha}`,
      `- base commit: ${checkpoint.baseSha}`,
      `- dirty paths: ${pathsOrNone(checkpoint.dirtyPaths)}`,
      `- untracked paths: ${pathsOrNone(checkpoint.untrackedPaths)}`,
      `- blocker: ${checkpoint.blocker ?? 'none recorded'}`,
      `- next action: ${checkpoint.nextAction}`,
      `- resume instructions: ${checkpoint.resumeInstructions}`,
      '',
      'Instruction for this attempt:',
      start.instruction,
    ].join('\n'),
  );
}

function pathsOrNone(paths: readonly string[]): string {
  if (paths.length === 0) return 'none';
  const shown = paths.slice(0, MAX_CHECKPOINT_PATHS).join(', ');
  return paths.length > MAX_CHECKPOINT_PATHS ? `${shown} (and ${String(paths.length - MAX_CHECKPOINT_PATHS)} more)` : shown;
}

/**
 * Whether a failed resume means Codex no longer holds the recorded rollout.
 *
 * The wording was observed on stderr with exit code 1 and **no** JSONL, for
 * `codex exec resume 00000000-0000-4000-8000-000000000000`:
 * `Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)`.
 * Only that condition may produce the checkpoint fallback; every other failure is reported as
 * itself, so a rate limit is never mistaken for a missing conversation.
 */
export function missingRolloutDetail(error: DomainError): string | null {
  if (!error.reason.toLowerCase().includes('no rollout found')) return null;
  return `Codex no longer holds a recorded rollout for this thread, so the conversation could not be continued in place. A fresh session was started from the checkpoint instead (F15-AC4). Codex reported: ${error.reason}`;
}

/**
 * The text a failed start reports.
 *
 * Codex writes its diagnostics to stderr and its structured events to stdout, so when a start
 * never produced a `thread.started` event the stderr tail is the only engine statement available.
 * The startup banner's `session id:` line is read first because it is the engine naming itself
 * before it failed, which is more useful to an operator than the tail of a transport error.
 */
function startupFailureDetail(running: CodexProcess, exitCode: number | null, redact: (text: string) => string): string {
  const stderr = running.stderrTail().trim();
  const bannerSession = /session id:\s*([0-9a-f-]{36})/i.exec(stderr)?.[1];
  if (bannerSession !== undefined) {
    return redact(`Codex started (thread ${bannerSession}) but emitted no thread.started event on stdout before exiting.`);
  }
  if (stderr.length > 0) return redact(stderr.slice(0, 400));
  return `Codex exited with ${String(exitCode)} without emitting a thread.started event or any diagnostic.`;
}

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A bounded, single-consumer async queue of engine events.
 *
 * The queue exists because the handle must be returned as soon as the thread id is known while
 * the process keeps streaming, so one background pump feeds the iterable the caller consumes. It
 * carries a hard bound, because a caller that never iterates would otherwise accumulate an
 * unbounded transcript in memory.
 */
class EventChannel implements AsyncIterable<EngineEvent> {
  private readonly queue: EngineEvent[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(event: EngineEvent): void {
    if (this.closed) return;
    if (this.queue.length >= MAX_QUEUED_EVENTS) {
      this.closed = true;
      this.queue.length = 0;
    } else {
      this.queue.push(event);
    }
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const resume = this.waiter;
    this.waiter = null;
    resume?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    return {
      next: async (): Promise<IteratorResult<EngineEvent>> => {
        for (;;) {
          const event = this.queue.shift();
          if (event !== undefined) return { done: false, value: event };
          if (this.closed) return { done: true, value: undefined };
          await new Promise<void>((resolve) => {
            this.waiter = resolve;
          });
        }
      },
    };
  }
}

function timeoutAfter(ms: number): Promise<null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
}
