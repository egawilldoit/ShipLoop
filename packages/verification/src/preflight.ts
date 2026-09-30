/**
 * Preflight probes, prerequisite blocking and owned cleanup
 * (F04-AC2, F04-AC3, F04-AC5, F14-AC3, F14-AC5, N02-AC2).
 *
 * Preflight runs before implementation and answers one question: is the recorded
 * environment actually usable right now. It reports what it observed, including
 * real exit codes and real captured output, because a summary claim that "the
 * environment is fine" is indistinguishable from a guess and is exactly the kind
 * of evidence this product must not accept (F04-AC2).
 *
 * A missing prerequisite is a distinct outcome. When the runtime is absent, a
 * required service is unreachable or a required secret is missing, `runPreflight`
 * returns `err` with a `BlockedError`, so there is no report value a caller could
 * mistake for a successful start. Implementation never begins from either the
 * blocked or the failed branch (F04-AC3).
 *
 * This module performs no I/O of its own. Every external effect goes through the
 * injected `CommandRunner` and the injected host facts, so a test can supply a
 * real subprocess or a deterministic fake without changing what is verified. The
 * real `node:child_process` runner lives in `./process-runner.ts`.
 */

import type { BlockedError, BlockedPrerequisite, Fingerprint, Result } from '@shiploop/domain';
import { blocked, fingerprint, redact } from '@shiploop/domain';
import type { BoundedCommand, RecipeVersion } from './recipe.ts';
import { recipeFingerprint } from './recipe.ts';

/** Fixed order: cheapest and most fundamental first, so a blocker surfaces early. */
export const PREFLIGHT_PROBES = [
  'RepositoryAccess',
  'RuntimeCompatibility',
  'DependencyInstall',
  'ServiceReachable',
  'RequiredSecretPresent',
] as const;
export type ProbeName = (typeof PREFLIGHT_PROBES)[number];

export type ProbeStatus = 'Passed' | 'Failed' | 'Skipped';

/** Host runtime facts, as observed rather than assumed. */
export interface RuntimeFacts {
  readonly version: string;
  readonly architecture: string;
}

export interface CommandOptions {
  readonly cwd: string | null;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /**
   * Extra environment for this command only, merged over the runner's allowlist.
   * Ambient process environment is never forwarded, so a provider credential
   * cannot leak into an ordinary probe by accident (N02-AC2).
   */
  readonly env: Readonly<Record<string, string>> | null;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Actual bounded output, already truncated to the requested limit. */
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Set when the process could not be started at all. */
  readonly spawnError: string | null;
  /** Process group id created for this command, for the owned process registry. */
  readonly groupId: number | null;
}

/** The only way this module may execute anything. */
export interface CommandRunner {
  run(argv: readonly string[], options: CommandOptions): Promise<CommandResult>;
}

export interface PreflightDeps {
  readonly runCommand: CommandRunner;
  /** Null when the host has no such runtime at all. */
  readonly readRuntime: () => RuntimeFacts | null;
  /** Null when this deployment cannot probe a port; services then report Skipped. */
  readonly probePort: ((port: number, timeoutMs: number) => Promise<boolean>) | null;
  /** Existence only. Implementations must never return the value (N02-AC2). */
  readonly hasSecret: (name: string) => boolean;
  readonly now: () => string;
}

export interface PreflightRequest {
  readonly attemptId: string;
  readonly recipe: RecipeVersion;
  readonly workingDirectory: string;
  /** Directory under which the caller will persist the actual probe output. */
  readonly evidenceDirectory: string;
  /** Argv proving the connected repository is readable from the attempt root. */
  readonly repositoryProbe: BoundedCommand;
  /** Argv proving the recorded dependencies are actually installed. */
  readonly dependencyProbe: BoundedCommand;
}

const PORT_PROBE_TIMEOUT_MS = 2000;

export interface ProbeResult {
  readonly name: ProbeName;
  readonly status: ProbeStatus;
  /**
   * Required false means the probe does not apply to this recipe, so its Skipped
   * status is not a missing prerequisite. Required true with status Skipped means
   * the probe did not run, which is never a pass (mvp-spec F20-AC2).
   */
  readonly required: boolean;
  /** Sanitized summary. Never contains a secret value. */
  readonly detail: string;
  /** Where the actual output for this probe belongs once persisted. */
  readonly evidenceRef: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Actual captured output, redacted, not a claim about what it said. */
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  /** Set only when the probed condition itself is a missing prerequisite. */
  readonly blockedPrerequisite: BlockedPrerequisite | null;
}

export type PreflightOutcome = 'PreflightPassed' | 'PreflightFailed' | 'Blocked';

export interface SecretPresence {
  readonly name: string;
  readonly present: boolean;
}

export interface PreflightReport {
  readonly attemptId: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly environmentFingerprint: Fingerprint;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly probes: readonly ProbeResult[];
  readonly secretPresence: readonly SecretPresence[];
  readonly outcome: PreflightOutcome;
  readonly blocked: BlockedError | null;
}

export interface PreflightBlocked {
  readonly error: BlockedError;
  /** Kept so the actual observed outputs survive the blocked result. */
  readonly report: PreflightReport;
}

interface PreflightContext {
  readonly request: PreflightRequest;
  readonly deps: PreflightDeps;
}

interface ProbeDraft {
  readonly status: ProbeStatus;
  readonly required: boolean;
  readonly detail: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly output?: string;
  readonly outputTruncated?: boolean;
  readonly durationMs?: number;
  readonly blockedPrerequisite?: BlockedPrerequisite | null;
}

/** Every string that reaches a report or an error goes through domain redaction. */
function sanitize(value: string): string {
  return redact(value).text;
}

function sanitizePrerequisite(prerequisite: BlockedPrerequisite): BlockedPrerequisite {
  return {
    name: sanitize(prerequisite.name),
    detail: sanitize(prerequisite.detail),
    remedy: sanitize(prerequisite.remedy),
  };
}

function evidenceRefFor(request: PreflightRequest, name: ProbeName): string {
  return `${request.evidenceDirectory}/preflight/${request.attemptId}/${name}.log`;
}

function buildProbe(context: PreflightContext, name: ProbeName, draft: ProbeDraft, startedAt: string, endedAt: string): ProbeResult {
  return {
    name,
    status: draft.status,
    required: draft.required,
    detail: sanitize(draft.detail),
    evidenceRef: evidenceRefFor(context.request, name),
    exitCode: draft.exitCode ?? null,
    signal: draft.signal ?? null,
    output: sanitize(draft.output ?? ''),
    outputTruncated: draft.outputTruncated ?? false,
    startedAt,
    endedAt,
    durationMs: draft.durationMs ?? 0,
    blockedPrerequisite:
      draft.blockedPrerequisite === undefined || draft.blockedPrerequisite === null
        ? null
        : sanitizePrerequisite(draft.blockedPrerequisite),
  };
}

function observed(result: CommandResult): Pick<ProbeDraft, 'exitCode' | 'signal' | 'output' | 'outputTruncated' | 'durationMs'> {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    output: result.output,
    outputTruncated: result.outputTruncated,
    durationMs: result.durationMs,
  };
}

/**
 * Runs one argv and turns the run into a probe draft.
 *
 * Execution defects (unbounded command, spawn failure, timeout, output cap
 * exceeded) are always Failed and never Blocked: they are facts about how this run
 * executed, not about a prerequisite the owner is missing. Only a command that ran
 * to completion and reported a failed condition blocks, because only that is
 * evidence about the environment (F04-AC3).
 */
async function runCommandProbe(
  context: PreflightContext,
  command: BoundedCommand,
  blockedPrerequisite: BlockedPrerequisite,
): Promise<ProbeDraft> {
  if (command.timeoutMs === null || command.timeoutMs < 1) {
    return {
      status: 'Failed',
      required: true,
      detail: 'The recipe records this command with no timeout, so it was not run. An unbounded command cannot be allowed to hang a run.',
    };
  }
  if (command.argv.length === 0) {
    return {
      status: 'Failed',
      required: true,
      detail: 'The recipe records this command with an empty argument array, so it was not run.',
    };
  }

  let result: CommandResult;
  try {
    result = await context.deps.runCommand.run(command.argv, {
      cwd: command.cwd,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: command.maxOutputBytes,
      env: null,
    });
  } catch (error) {
    return {
      status: 'Failed',
      required: true,
      detail: `The command could not be executed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const executed = `${command.argv[0] ?? ''} exited ${result.exitCode ?? 'with no code'}${
    result.signal === null ? '' : ` (signal ${result.signal})`
  } after ${result.durationMs} ms`;

  if (result.spawnError !== null) {
    return { status: 'Failed', required: true, detail: `The command could not be started: ${result.spawnError}`, ...observed(result) };
  }
  if (result.timedOut) {
    return {
      status: 'Failed',
      required: true,
      detail: `The command exceeded its ${command.timeoutMs} ms timeout and its process group was stopped. ${executed}.`,
      ...observed(result),
    };
  }
  if (result.outputTruncated) {
    return {
      status: 'Failed',
      required: true,
      detail: `The command exceeded its ${command.maxOutputBytes} byte output cap. The excess was discarded rather than reported, so its result cannot be trusted. ${executed}.`,
      ...observed(result),
    };
  }
  if (result.exitCode !== 0) {
    return { status: 'Failed', required: true, detail: executed, blockedPrerequisite, ...observed(result) };
  }
  return { status: 'Passed', required: true, detail: executed, ...observed(result) };
}

function parseVersion(value: string): number[] {
  return value.split('.').map((part) => {
    const match = /^(\d+)/.exec(part.trim());
    return match?.[1] === undefined ? 0 : Number(match[1]);
  });
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function satisfiesRuntime(version: string, minimum: string, maximumExclusive: string | null): boolean {
  if (compareVersions(version, minimum) < 0) return false;
  return maximumExclusive === null || compareVersions(version, maximumExclusive) < 0;
}

async function probeRepositoryAccess(context: PreflightContext): Promise<ProbeDraft> {
  return runCommandProbe(context, context.request.repositoryProbe, {
    name: `Repository access at ${context.request.workingDirectory}`,
    detail: 'The recorded repository probe did not succeed against the connected repository.',
    remedy: 'Check the recorded repository path and the provider access this profile declares (F03-AC1).',
  });
}

async function probeRuntimeCompatibility(context: PreflightContext): Promise<ProbeDraft> {
  const requirements = context.request.recipe.requirements;
  if (requirements.runtime === null || requirements.cpu === null) {
    return {
      status: 'Failed',
      required: true,
      detail: 'The recipe records no runtime or CPU requirement, so compatibility cannot be established.',
      blockedPrerequisite: {
        name: 'Recipe requirements',
        detail: 'A versioned recipe must record runtime and CPU requirements (F04-AC1).',
        remedy: 'Save a new recipe version that states the runtime and architecture it needs.',
      },
    };
  }

  const facts = context.deps.readRuntime();
  if (facts === null) {
    return {
      status: 'Failed',
      required: true,
      detail: `No ${requirements.runtime.name} runtime is available on this host.`,
      blockedPrerequisite: {
        name: `Runtime ${requirements.runtime.name}`,
        detail: `The host reported no ${requirements.runtime.name} installation.`,
        remedy: `Install ${requirements.runtime.name} ${requirements.runtime.minVersion} or newer on the VM, then re-run preflight.`,
      },
    };
  }

  if (facts.architecture !== requirements.cpu.architecture) {
    return {
      status: 'Failed',
      required: true,
      detail: `The host reports architecture ${facts.architecture} but the recipe requires ${requirements.cpu.architecture}.`,
      blockedPrerequisite: {
        name: `CPU architecture ${requirements.cpu.architecture}`,
        detail: `Observed ${facts.architecture}.`,
        remedy: `Run this recipe on a ${requirements.cpu.architecture} host, or save a recipe version for the architecture the VM provides.`,
      },
    };
  }

  if (!satisfiesRuntime(facts.version, requirements.runtime.minVersion, requirements.runtime.maxVersionExclusive)) {
    const accepted =
      requirements.runtime.maxVersionExclusive === null
        ? `${requirements.runtime.minVersion} or newer`
        : `>= ${requirements.runtime.minVersion} and < ${requirements.runtime.maxVersionExclusive}`;
    return {
      status: 'Failed',
      required: true,
      detail: `The host runs ${requirements.runtime.name} ${facts.version}; the recipe requires ${accepted}.`,
      blockedPrerequisite: {
        name: `Runtime ${requirements.runtime.name} ${requirements.runtime.minVersion}`,
        detail: `Observed ${facts.version}.`,
        remedy: `Install a supported ${requirements.runtime.name} on the VM, or save a recipe version for the version the VM provides.`,
      },
    };
  }

  return {
    status: 'Passed',
    required: true,
    detail: `The host runs ${requirements.runtime.name} ${facts.version} on ${facts.architecture}, which satisfies the recipe.`,
  };
}

async function probeDependencyInstall(context: PreflightContext): Promise<ProbeDraft> {
  return runCommandProbe(context, context.request.dependencyProbe, {
    name: 'Installed dependencies',
    detail: 'The dependency probe did not succeed, so the recorded install state is not present.',
    remedy: 'Run the recipe dependency install, or the recorded maintenance step when dependencies have changed (F04-AC4).',
  });
}

async function probeServicesReachable(context: PreflightContext): Promise<ProbeDraft> {
  const probePort = context.deps.probePort;
  const required = context.request.recipe.ports.filter((allocation) => allocation.required);
  const optional = context.request.recipe.ports.filter((allocation) => !allocation.required);

  if (context.request.recipe.ports.length === 0) {
    return { status: 'Skipped', required: false, detail: 'This recipe allocates no ports, so no service is required.' };
  }
  if (probePort === null) {
    return {
      status: 'Skipped',
      required: required.length > 0,
      detail: 'This deployment has no port probe, so service reachability was not established. Not running a check is not a pass.',
    };
  }

  const unreachableRequired: string[] = [];
  const unansweredOptional: string[] = [];
  for (const allocation of [...required, ...optional]) {
    const reachable = await probePort(allocation.port, PORT_PROBE_TIMEOUT_MS);
    if (reachable) continue;
    if (allocation.required) unreachableRequired.push(`${allocation.serviceId} on port ${allocation.port}`);
    else unansweredOptional.push(`${allocation.serviceId} on port ${allocation.port}`);
  }

  if (unreachableRequired.length > 0) {
    const named = unreachableRequired.join(', ');
    return {
      status: 'Failed',
      required: true,
      detail: `Required service(s) ${named} did not answer on their isolated port within ${PORT_PROBE_TIMEOUT_MS} ms.`,
      blockedPrerequisite: {
        name: `Service ${unreachableRequired[0] ?? ''}`.trim(),
        detail: `${named} are unreachable on the ports this recipe allocates; attaching to whatever holds those ports would mean attaching to an unrelated service (F14-AC3).`,
        remedy: `Start ${named} with this recipe's service startup step on the same isolated port, then re-run preflight.`,
      },
    };
  }

  return {
    status: 'Passed',
    required: true,
    detail:
      unansweredOptional.length === 0
        ? `All ${required.length + optional.length} allocated service port(s) answered within ${PORT_PROBE_TIMEOUT_MS} ms.`
        : `Every required service port answered within ${PORT_PROBE_TIMEOUT_MS} ms; optional port(s) ${unansweredOptional.join(', ')} did not answer and are not required.`,
  };
}

function probeSecrets(presence: readonly SecretPresence[]): ProbeDraft {
  if (presence.length === 0) {
    return { status: 'Skipped', required: false, detail: 'This recipe requires no secrets.' };
  }
  const missing = presence.filter((entry) => !entry.present).map((entry) => entry.name);
  if (missing.length > 0) {
    return {
      status: 'Failed',
      required: true,
      detail: `${missing.length} of ${presence.length} required secret(s) are absent: ${missing.join(', ')}.`,
      blockedPrerequisite: {
        name: `Required secret ${missing[0] ?? ''}`.trim(),
        detail: `Absent: ${missing.join(', ')}. Only presence was inspected; no value was read.`,
        remedy: 'Add the named secret to the VM credential store this profile references, then re-run preflight.',
      },
    };
  }
  return { status: 'Passed', required: true, detail: `All ${presence.length} required secret(s) are present. No value was read.` };
}

function deriveOutcome(probes: readonly ProbeResult[]): PreflightOutcome {
  if (probes.some((probe) => probe.blockedPrerequisite !== null)) return 'Blocked';
  return probes.some((probe) => probe.required && probe.status !== 'Passed') ? 'PreflightFailed' : 'PreflightPassed';
}

/**
 * Whether implementation may begin from this report.
 *
 * Separate from the result channel on purpose: a `PreflightFailed` run arrives as
 * a successful call whose report says the environment is not usable, and F04-AC3
 * requires that neither a blocked nor a failed preflight is reported as a
 * successful start.
 */
export function implementationMayStart(report: PreflightReport): boolean {
  return (
    report.outcome === 'PreflightPassed' &&
    report.probes.every((probe) => !probe.required || probe.status === 'Passed')
  );
}

/** Stable digest of a report, so evidence can be bound to exactly what was observed. */
export function preflightReportDigest(report: PreflightReport): Fingerprint {
  return fingerprint(report);
}

/**
 * Runs the ordered preflight probes against a recorded recipe.
 *
 * Probes run in a fixed order and stop at the first missing prerequisite: once the
 * runtime is absent, the remaining observations say nothing useful and would only
 * add noise. Probes that did not run are recorded as Skipped with a reason, so the
 * report shows exactly what was and was not checked.
 *
 * A missing runtime, an unreachable required service, an unreadable repository,
 * uninstalled dependencies or an absent required secret returns `err` with a
 * `BlockedError` naming the failed prerequisite and its remedy. Any other failure
 * returns `ok` with a report whose outcome is `PreflightFailed`.
 */
export async function runPreflight(
  request: PreflightRequest,
  deps: PreflightDeps,
): Promise<Result<PreflightReport, PreflightBlocked>> {
  const context: PreflightContext = { request, deps };
  const startedAt = deps.now();
  const probes: ProbeResult[] = [];
  const secretPresence: SecretPresence[] = request.recipe.requiredSecrets.map((name) => ({
    name,
    present: deps.hasSecret(name),
  }));

  let blocker: BlockedPrerequisite | null = null;
  for (const name of PREFLIGHT_PROBES) {
    if (blocker !== null) {
      const at = deps.now();
      probes.push(
        buildProbe(
          context,
          name,
          {
            status: 'Skipped',
            required: true,
            detail: `Not run: the prerequisite "${blocker.name}" failed first.`,
          },
          at,
          at,
        ),
      );
      continue;
    }
    const probeStart = deps.now();
    let draft: ProbeDraft;
    switch (name) {
      case 'RepositoryAccess':
        draft = await probeRepositoryAccess(context);
        break;
      case 'RuntimeCompatibility':
        draft = await probeRuntimeCompatibility(context);
        break;
      case 'DependencyInstall':
        draft = await probeDependencyInstall(context);
        break;
      case 'ServiceReachable':
        draft = await probeServicesReachable(context);
        break;
      case 'RequiredSecretPresent':
        draft = probeSecrets(secretPresence);
        break;
    }
    const probeEnd = deps.now();
    const probe = buildProbe(context, name, draft, probeStart, probeEnd);
    probes.push(probe);
    if (probe.blockedPrerequisite !== null) blocker = probe.blockedPrerequisite;
  }

  const endedAt = deps.now();
  const base = {
    attemptId: request.attemptId,
    recipeId: request.recipe.recipeId,
    recipeVersion: request.recipe.version,
    environmentFingerprint: recipeFingerprint(request.recipe),
    startedAt,
    endedAt,
    probes,
    secretPresence,
    outcome: deriveOutcome(probes),
  } as const;

  if (blocker === null) {
    return { ok: true, value: { ...base, blocked: null } };
  }

  const error: BlockedError = blocked(`Preflight cannot start implementation: ${sanitize(blocker.name)}.`, [
    sanitizePrerequisite(blocker),
  ]);
  return { ok: false, error: { error, report: { ...base, blocked: error } } };
}

export type OwnedResourceKind = 'TemporaryDirectory' | 'ServiceData' | 'BrowserProfile' | 'PortAllocation';

export interface OwnedProcess {
  readonly pid: number;
  /** Process group created by the spawn this attempt performed. */
  readonly groupId: number;
  /** True only for a group this attempt spawned. A false here is never signalled. */
  readonly ownsGroup: boolean;
  readonly command: readonly string[];
  readonly startedAt: string;
}

export interface OwnedResource {
  readonly id: string;
  readonly kind: OwnedResourceKind;
  readonly path: string | null;
  readonly port: number | null;
  /** Work or evidence kept so a cancelled attempt can still be recovered (F14-AC5). */
  readonly retainForRecovery: boolean;
  /** Project data shared by every attempt; never owned by this attempt (F04-AC5). */
  readonly sharedProjectData: boolean;
  readonly createdAt: string;
}

export interface ResourceRegistry {
  readonly attemptId: string;
  readonly processes: readonly OwnedProcess[];
  readonly resources: readonly OwnedResource[];
}

export type CleanupActionKind =
  | 'SignalOwnedProcessGroup'
  | 'SignalFailed'
  | 'SkipUnownedProcess'
  | 'RemoveResource'
  | 'ReleasePort'
  | 'RetainResource'
  | 'RemoveFailed';

export interface CleanupAction {
  readonly kind: CleanupActionKind;
  readonly target: string;
  readonly reason: string;
}

export interface CleanupFailure {
  /** Resource id, or `process-group-<id>` when a process group could not be signalled. */
  readonly resourceId: string;
  readonly message: string;
}

export interface CleanupReport {
  readonly attemptId: string;
  readonly completedAt: string;
  readonly stoppedGroups: readonly number[];
  readonly removedResourceIds: readonly string[];
  readonly retainedResourceIds: readonly string[];
  /** Process ids this cleanup refused to touch because it did not spawn them. */
  readonly untouchedProcessIds: readonly number[];
  readonly actions: readonly CleanupAction[];
  readonly failures: readonly CleanupFailure[];
}

export interface CleanupDeps {
  /** Signals the group, never an individual pid, and returns whether a signal was delivered. */
  readonly stopProcessGroup: (groupId: number, signal: 'SIGTERM' | 'SIGKILL') => boolean;
  readonly removePath: (path: string) => Promise<void>;
  readonly now: () => string;
}

/**
 * Stops only what this attempt started and removes only what it may remove.
 *
 * Three refusals carry the contract. A process group is signalled only when this
 * attempt created it, so a listed pid that this attempt did not spawn is never
 * touched. A resource marked `retainForRecovery` survives ordinary cancellation,
 * because a cancelled attempt still has to be recoverable. Project data shared
 * across attempts survives always, because "this is a worktree" is not a reason to
 * delete somebody's repository (F04-AC5, F14-AC5).
 */
export async function cleanupOwnedResources(
  registry: ResourceRegistry,
  deps: CleanupDeps,
): Promise<CleanupReport> {
  const actions: CleanupAction[] = [];
  const stoppedGroups: number[] = [];
  const removedResourceIds: string[] = [];
  const retainedResourceIds: string[] = [];
  const untouchedProcessIds: number[] = [];
  const failures: CleanupFailure[] = [];

  for (const process of registry.processes) {
    if (!process.ownsGroup) {
      untouchedProcessIds.push(process.pid);
      actions.push({
        kind: 'SkipUnownedProcess',
        target: `pid ${process.pid}`,
        reason: 'This attempt did not create the process group, so it is not signalled (F14-AC5).',
      });
      continue;
    }
    let signalled = false;
    try {
      signalled = deps.stopProcessGroup(process.groupId, 'SIGTERM');
    } catch (error) {
      failures.push({
        resourceId: `process-group-${process.groupId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (signalled) stoppedGroups.push(process.groupId);
    actions.push({
      kind: signalled ? 'SignalOwnedProcessGroup' : 'SignalFailed',
      target: `group ${process.groupId}`,
      reason: signalled
        ? 'The process group was created by this attempt and was asked to stop.'
        : 'The process group was not signalled; it is recorded here rather than reported as stopped.',
    });
  }

  for (const resource of registry.resources) {
    if (resource.sharedProjectData) {
      retainedResourceIds.push(resource.id);
      actions.push({
        kind: 'RetainResource',
        target: resource.id,
        reason: 'Shared project data is not owned by this attempt and is never removed (F04-AC5).',
      });
      continue;
    }
    if (resource.retainForRecovery) {
      retainedResourceIds.push(resource.id);
      actions.push({
        kind: 'RetainResource',
        target: resource.id,
        reason: 'Retained work or evidence must survive ordinary cancellation so the attempt stays recoverable (F14-AC5).',
      });
      continue;
    }
    if (resource.path === null) {
      if (resource.kind === 'PortAllocation' && resource.port !== null) {
        removedResourceIds.push(resource.id);
        actions.push({
          kind: 'ReleasePort',
          target: `${resource.id} (port ${resource.port})`,
          reason: 'Isolated port reservation released with the attempt that created it.',
        });
        continue;
      }
      retainedResourceIds.push(resource.id);
      actions.push({
        kind: 'RetainResource',
        target: resource.id,
        reason: 'No removable path is recorded, so nothing was deleted.',
      });
      continue;
    }
    try {
      await deps.removePath(resource.path);
      removedResourceIds.push(resource.id);
      actions.push({
        kind: 'RemoveResource',
        target: `${resource.id} (${resource.path})`,
        reason: 'Temporary resource created by this attempt.',
      });
    } catch (error) {
      failures.push({ resourceId: resource.id, message: error instanceof Error ? error.message : String(error) });
      actions.push({
        kind: 'RemoveFailed',
        target: `${resource.id} (${resource.path})`,
        reason: 'Removal failed, so the resource is left in place rather than reported as removed.',
      });
    }
  }

  return {
    attemptId: registry.attemptId,
    completedAt: deps.now(),
    stoppedGroups,
    removedResourceIds,
    retainedResourceIds,
    untouchedProcessIds,
    actions,
    failures,
  };
}
