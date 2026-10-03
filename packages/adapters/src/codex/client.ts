/**
 * The Codex process transport (F03-AC5, F15-AC1, F15-AC4, F17-AC1, N02-AC3).
 *
 * Every invocation is `spawn(binary, argvArray)`. There is no shell anywhere in this module and
 * no string is ever concatenated into a command line, because the instruction text comes from a
 * work item and a shell would turn an owner-supplied instruction into host command execution.
 * Node's `spawn` without `shell: true` hands `argv` to `execvp` directly, so an instruction
 * containing `; rm -rf /` is one argument rather than three commands.
 *
 * **The sandbox is an allowlist, not a denylist.** `CODEX_SANDBOX_MODES` holds only the two
 * modes a coding stage may have, and `resolveSandboxMode` refuses anything else by identity
 * rather than by comparing against a forbidden name. That is deliberate: the operator profile
 * on this host sets an unrestricted `sandbox_mode` and `approval_policy = "never"` in
 * `~/.codex/config.toml`, so the flag this module puts on the command line is the only thing
 * between a ShipLoop attempt and an unrestricted engine. A denylist that missed a future Codex
 * sandbox name would fail open; an allowlist fails closed, and the refusal names both permitted
 * modes so an owner correcting the profile does not have to read this file (F03-AC5, N02-AC3).
 *
 * **`resume` has no `--sandbox` flag.** Verified against `codex exec resume --help` on
 * 0.159.1: the flag list offers `--dangerously-bypass-approvals-and-sandbox` but no
 * `--sandbox`, and no `--cd` either. A resumed session is therefore constrained with
 * `-c sandbox_mode='<mode>'` instead, and that was **verified live** on this host: a resumed
 * session asked to write a file under `sandbox_mode="read-only"` produced no file and reported
 * the workspace read-only, while the same prompt under `sandbox_mode="workspace-write"` wrote
 * it. `buildArgv` therefore emits a different flag set per invocation, and `README.md` records
 * that difference rather than hiding it behind one shared list.
 *
 * **Shutdown targets one process group, never a name.** The child is spawned `detached`, so it
 * leads a new process group and every descendant it starts inherits that group id.
 * `stopCodexProcess` sends `SIGTERM` to the group, waits a bounded window, then sends `SIGKILL`
 * to the same group, and reports which one ended it. Nothing here matches on a command name, a
 * port or a pattern, so a concurrent Codex run belonging to someone else is unreachable from
 * this adapter (F17-AC1, F17-AC5).
 *
 * **The environment is an allowlist of seven names.** `engineEnvironment` builds the child's
 * environment from scratch: it copies nothing it was not asked for and forwards nothing whose
 * name is not in {@link ENGINE_ENVIRONMENT_VARIABLES}. The earlier version of this file did the
 * opposite — it started from `process.env` and dropped names matching two regexes — which fails
 * open in the one direction that matters, because a credential whose name nobody anticipated is
 * still handed to code the owner is being asked to trust with their repository. A denylist of
 * known credential names cannot be complete; an allowlist is complete by construction, and the
 * test in `codex.test.ts` is written so that reverting to the denylist makes it fail (F03-AC5,
 * N02-AC3).
 *
 * **`CODEX_HOME` is ShipLoop-owned, never the operator's, and it is never seeded from the
 * operator's credential.** Two facts forced the first. Codex reads its own configuration from
 * `$CODEX_HOME/config.toml`, and on this host that file sets an unrestricted `sandbox_mode`
 * together with `approval_policy = "never"` for every trusted project, this repository included —
 * so inheriting the operator's `CODEX_HOME` would hand the engine a configuration that disables
 * the sandbox the flag above requests.
 *
 * The second fact is the reason this module used to **copy** `auth.json`, and copying it was a
 * defect rather than a convenience. A ChatGPT login is a *rotating* credential: Codex spends the
 * refresh token and writes a new one back into `$CODEX_HOME/auth.json` in place. Two files holding
 * the same refresh token are therefore two writers of one credential, and the second one to
 * refresh loses, with the provider's own wording, `Your access token could not be refreshed
 * because your refresh token was already used. Please log out and sign in again.` The old code
 * copied the operator's login on every launch and re-copied it whenever the operator's file looked
 * newer, which both made the engine's own rotated token unrecoverable and put the operator's
 * interactive session one refresh away from breaking. **The copy is gone.** The engine's
 * credential is whatever ShipLoop provisioned into its own `CODEX_HOME`, and
 * {@link resolveEngineAuthentication} refuses a run that finds nothing there instead of reaching
 * for the operator's file (F15-AC5).
 *
 * **What Codex 0.160.0 actually supports was measured, not assumed**, on this host on 2 October
 * 2026, because the supported route is the whole answer to "how does the engine get its own
 * identity":
 *
 * - **`CODEX_API_KEY` in the environment is honoured and is never written to disk.** With an
 *   empty `CODEX_HOME` and `CODEX_API_KEY=sk-invalid-…`, the provider answered `401 Incorrect API
 *   key provided: sk-inval***…` with `auth error code: invalid_api_key` — the engine had read the
 *   key out of the environment and presented it — and **no `auth.json` appeared**. The binary's
 *   own string table says why: `externally provided auth cannot be loaded from auth storage`.
 * - **`OPENAI_API_KEY` alone is *not* honoured.** The identical run with only `OPENAI_API_KEY` set
 *   produced the baseline `401 Missing bearer or basic authentication in header`, byte for byte the
 *   answer an unauthenticated run gives. Shipping that variable would have been a credential that
 *   does nothing.
 * - **`codex login --with-api-key` provisions a static credential** into any `CODEX_HOME`: it
 *   reads the key from stdin and writes exactly `{"auth_mode":"apikey","OPENAI_API_KEY":"sk-…"}`,
 *   mode 0600, after which `codex login status` prints `Logged in using an API key`. An API key
 *   has no refresh token, so there is nothing to rotate and nothing to collide over. This is the
 *   route {@link ENGINE_CREDENTIAL_PROVISION_COMMAND} names.
 * - **`codex login --device-auth` exists** and produces a genuinely separate ChatGPT identity, but
 *   it needs the owner to complete a browser or device-code flow, and its login is a rotating
 *   refresh token again. It is supported and is not what this adapter requires.
 *
 * The operator's `config.toml`, trusted-project list, model preferences, MCP servers and hooks are
 * not there to be inherited, and neither is their login.
 *
 * The residual exposure is stated rather than hidden: the child runs as the same uid as the
 * worker, so an absolute path to `~/.codex/auth.json` or `~/.ssh/id_ed25519` is still readable.
 * What the allowlist removes is the ambient *channel* — the operator's session cookies, `gh`
 * tokens, `LINEAR_API_KEY`, `DATABASE_URL`, netrc and askpass pointers — and what the ShipLoop
 * `HOME` removes is the ambient *directory*. Same-uid isolation is a separate change, recorded
 * in `docs/evidence/2026-10-01-credential-separation.md`.
 *
 * **A structured result rides its own channel, never a widened summary.** `MAX_SUMMARY_CHARS`
 * in `events.ts` is a bound on what a human reads in a progress line, and a plan proposal is
 * thousands of characters, so it cannot go there. Codex 0.160.0 supports two flags for this and
 * both were used together on this host on 2 October 2026 against a live `codex exec
 * --sandbox read-only`:
 *
 *   - `--output-schema <FILE>` — a JSON Schema describing the shape of the model's **final
 *     response**. The observed run answered with exactly the requested object and no prose, so
 *     the engine's own channel is constrained rather than merely requested.
 *   - `-o/--output-last-message <FILE>` — writes that final message to a file. The observed run
 *     wrote 2250 bytes where the last `agent_message` on stdout carried the identical text, and
 *     the file appeared **even under `read-only`**, because the CLI process itself writes it
 *     rather than a sandboxed command. That matters because a plan session runs read-only.
 *
 * The two are only useful together: `--output-schema` alone would leave the payload on stdout,
 * where the summary cap truncates it, and `-o` alone would capture whatever prose the model
 * chose. Both live in this file because argv construction and the result artifact are the same
 * transport decision.
 *
 * **The result artifact is confined to the attempt's own directory, and confinement is verified
 * rather than assumed.** It lands under `<stateRoot>/home/<attemptKey>/.shiploop/results/`, which
 * is created mode 0700 by {@link prepareEngineState} for this workspace and is handed to the
 * engine as `HOME`, so it is the one directory both sides already agree on. Four things are
 * checked, and each is checked *after* resolving symlinks, because a containment test on the
 * unresolved path passes for a link that points outside:
 *
 *   1. the results directory is resolved and must still be inside the resolved attempt home, so
 *      a planted `.shiploop` symlink cannot move the channel out;
 *   2. the result path is resolved against its resolved parent and must be inside it, which is
 *      what rejects `..` traversal;
 *   3. the path must not already exist, so a file a previous attempt on the same worktree left
 *      behind can never be read as this attempt's answer — the token is per launch and the
 *      existence check is the guarantee, not the token;
 *   4. at read time the artifact must be a regular file and its resolved path must still be
 *      inside the attempt home, which is what rejects a symlink swapped in during the run.
 *
 * The alternative — writing the result into the workspace — was rejected: an untracked file in
 * the attempt's own worktree appears in its change inventory, which is exactly the marker
 * `apps/worker/src/isolation.ts` deletes after its probe so a no-code run cannot look like a
 * change (F14-AC4, F19-AC5).
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

import { blocked, conflict, err, invalid, ok, type DomainError, type Result } from '@shiploop/domain';
import type { AdapterContext, EngineResultRequest, EngineResultSchema } from '../contracts/index.ts';
import { mapCodexVersionProbeFailure } from './errors.ts';

/**
 * The Codex version this adapter was written against.
 *
 * `CODEX_VERIFIED_VERSION` is the version whose `--json` event schema, flags and thread-id shape
 * were **measured** on this host on 1 October 2026, not the newest version published. It is
 * pinned so a report can name the engine that produced an artefact. `MINIMUM_CODEX_VERSION` is
 * the floor below which the measured schema does not hold: 0.159.1 emits a `thread.started`
 * event carrying `thread_id`, and that event is what this adapter maps a session identity and a
 * terminal result from. `checkCodexVersion` returns a verdict against the floor rather than
 * assuming compatibility (F04-AC2, F15-AC4).
 */
export const CODEX_VERIFIED_VERSION = '0.159.1';
export const MINIMUM_CODEX_VERSION = '0.159.1';

/**
 * The Codex version the structured-result channel was measured on.
 *
 * A second constant rather than a wider claim on {@link CODEX_VERIFIED_VERSION}, because the two
 * facts were established on different binaries and one number cannot honestly carry both. The
 * `--json` event schema, the flag set and the thread-id shape were read off 0.159.1 on 1 October
 * 2026. The `--output-schema` / `--output-last-message` behaviour — including that the artifact is
 * written by a read-only turn, and that the provider requires `additionalProperties: false` on
 * every object node of the schema — was read off **0.160.0** on 2 October 2026, which is what this
 * host runs. Overloading one constant would have made a report name an engine that was never asked
 * these questions (F04-AC2).
 */
export const CODEX_RESULT_CHANNEL_VERSION = '0.160.0';

/**
 * The version the engine's **separate-credential** behaviour was measured on.
 *
 * A third constant for the same reason the other two exist: `--output-schema` was read off 0.160.0
 * and the `--json` event schema off 0.159.1, and this one — `CODEX_API_KEY` being honoured while
 * `OPENAI_API_KEY` alone is not, and env-provided auth never reaching `auth.json` — was measured
 * on 0.160.0 on 2 October 2026. One number cannot honestly carry three different binaries (F04-AC2).
 */
export const CODEX_SEPARATE_CREDENTIAL_VERSION = '0.160.0';

/**
 * The exact command that provisions this product's engine credential, quoted wherever a run is
 * blocked for want of one.
 *
 * Named here rather than written into each message so the blocker, the provisioning script and the
 * README cannot drift apart: three copies of a command an owner has to type is three chances to
 * be wrong. The `env -i` form is deliberate — the key is read on stdin, never on a command line,
 * because `argv` is world-readable through `/proc/<pid>/cmdline` for the life of the process.
 */
export const ENGINE_CREDENTIAL_PROVISION_COMMAND =
  'printenv OPENAI_API_KEY | env -i PATH="$PATH" HOME="$HOME" CODEX_HOME=<stateRoot>/codex codex login --with-api-key';

/**
 * The credential ShipLoop provisions for the engine, and how it was established.
 *
 * Reported rather than inferred, because the two modes differ in a way an owner must be told:
 * `ApiKey` is static and cannot collide with anything, while `ChatGPT` is a rotating refresh token
 * and this adapter deliberately refuses to rotate the operator's copy of one. A run on `ChatGPT`
 * is honest about what it is rather than being reported as a separate identity (F15-AC5).
 */
export type CodexCredentialMode = 'ApiKey' | 'ChatGPT';

export interface CodexEngineAuthentication {
  /** Which kind of credential the ShipLoop-owned `CODEX_HOME` holds. */
  readonly mode: CodexCredentialMode;
  /** The ShipLoop-owned `CODEX_HOME` the engine was pointed at. Never the operator's. */
  readonly codexHome: string;
  /** The credential file inside it. Reported for diagnostics; never printed by value. */
  readonly credentialPath: string;
}

/** The sandbox modes a ShipLoop coding session may be granted. */
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write'] as const;

export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/** Whether this is a first run or a continuation of a recorded Codex thread. */
export type CodexInvocation = 'Fresh' | 'Resume';

export interface CodexClientOptions {
  /** Absolute path to the `codex` executable. Never a shell word. */
  readonly binary: string;
  /** Model passed as `-m`. Null uses whatever the operator profile selects. */
  readonly model?: string | null;
  /**
   * Absolute root of the ShipLoop-owned directory holding engine state.
   *
   * Defaults to `<XDG_STATE_HOME or ~/.local/state>/shiploop/codex`. It must not live under
   * `TMPDIR`: Codex refuses to create its PATH-alias helper binaries beneath a temporary
   * directory and warns on every run when it has to (measured on 0.159.1).
   */
  readonly stateRoot?: string;
  /** Bound on one graceful shutdown before the group is killed. */
  readonly gracefulStopMs?: number;
  /** Bound on waiting for a killed group to disappear. */
  readonly killWaitMs?: number;
  /** Hard bound on one `codex --version` probe. */
  readonly versionProbeTimeoutMs?: number;
  /** Pass `--skip-git-repo-check`. Off by default: the workspace is expected to be a worktree. */
  readonly skipGitRepoCheck?: boolean;
  /** Extra `-c key=value` overrides, already TOML-encoded by the caller. */
  readonly configOverrides?: readonly string[];
}

export interface CodexSpawnRequest {
  readonly cwd: string;
  readonly sandbox: CodexSandboxMode;
  readonly prompt: string;
  readonly invocation: CodexInvocation;
  /** The recorded Codex thread to continue. Required for `Resume`, refused without it. */
  readonly priorSessionId?: string;
  readonly signal: AbortSignal;
  /**
   * The structured result this session must produce, or null when its text is enough.
   *
   * The channel is prepared *before* the process exists, so a schema that cannot be written or a
   * result path that cannot be confined is a refusal with no engine run behind it rather than a
   * session that starts and then cannot be read.
   */
  readonly result?: EngineResultRequest | null;
  /**
   * Identifies one launch's result files inside the attempt's results directory.
   *
   * Injected rather than generated here so the adapter — the layer that owns randomness —
   * decides it, and so a test can pin it and prove that a second launch on the same worktree
   * refuses a leftover file instead of reading it.
   */
  readonly resultToken?: string;
}

const DEFAULT_GRACEFUL_STOP_MS = 10_000;
const DEFAULT_KILL_WAIT_MS = 5_000;
const DEFAULT_VERSION_PROBE_MS = 15_000;
const STDERR_TAIL_LIMIT = 8_000;
const STDOUT_CAPTURE_LIMIT = 8_000;
const VERSION_PATTERN = /codex-cli\s+(\d+)\.(\d+)\.(\d+)/;

/**
 * Parses `codex-cli 0.159.1` into `0.159.1`.
 *
 * Returns null for anything else, including a bare `codex 0.159.1`, because a version this
 * adapter cannot read is a version whose event schema it cannot claim to understand. The shape
 * observed on 0.159.1 was exactly `codex-cli 0.159.1` on stdout with exit code 0.
 */
export function parseCodexVersion(stdout: string): string | null {
  const match = VERSION_PATTERN.exec(stdout.trim());
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  return major !== undefined && minor !== undefined && patch !== undefined ? `${major}.${minor}.${patch}` : null;
}

/** A version verdict against the declared floor. */
export interface CodexVersionVerdict {
  readonly runtimeVersion: string;
  readonly compatible: boolean;
  readonly detail: string;
}

/**
 * Compares an observed version against {@link MINIMUM_CODEX_VERSION}.
 *
 * Numeric component comparison rather than string comparison, because `0.159.10` is newer than
 * `0.159.9` and a lexicographic test would call it older.
 */
export function checkCodexVersion(observed: string): CodexVersionVerdict {
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(observed);
  if (parsed === null) {
    return {
      runtimeVersion: observed,
      compatible: false,
      detail: `Codex reported the unrecognised version "${observed}", so its event schema cannot be claimed compatible with the ${MINIMUM_CODEX_VERSION} floor this adapter was measured against.`,
    };
  }
  const observedTriplet: readonly [number, number, number] = [
    Number(parsed[1]),
    Number(parsed[2]),
    Number(parsed[3]),
  ];
  const floorTriplet = MINIMUM_CODEX_VERSION.split('.').map((part) => Number.parseInt(part, 10));
  const floor: readonly [number, number, number] = [
    floorTriplet[0] ?? 0,
    floorTriplet[1] ?? 0,
    floorTriplet[2] ?? 0,
  ];
  if (compareTriples(observedTriplet, floor) < 0) {
    return {
      runtimeVersion: observed,
      compatible: false,
      detail: `Codex ${observed} is older than the ${MINIMUM_CODEX_VERSION} floor. Its --json stream predates the thread.started event this adapter maps a session identity and a terminal result from, so it is refused rather than run on an assumed schema.`,
    };
  }
  return {
    runtimeVersion: observed,
    compatible: true,
    detail: `Codex ${observed} satisfies the ${MINIMUM_CODEX_VERSION} floor this adapter was measured against.`,
  };
}

function compareTriples(left: readonly [number, number, number], right: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Refuses a sandbox mode this adapter will not grant.
 *
 * The refusal names the two permitted modes because the profile an owner is most likely editing
 * is the operator's own `~/.codex/config.toml`, where the value has to be spelled exactly as it
 * appears on the command line.
 */
export function resolveSandboxMode(requested: string, redact: (text: string) => string): Result<CodexSandboxMode> {
  const allowed = CODEX_SANDBOX_MODES.find((mode) => mode === requested);
  if (allowed !== undefined) return ok(allowed);
  return err({
    code: 'Forbidden',
    reason: redact(
      `"${requested}" is not a sandbox mode a ShipLoop coding session may hold. The permitted modes are ${CODEX_SANDBOX_MODES.join(' and ')}. A coding stage never runs the engine unrestricted, whatever the operator profile on the host asks for (F03-AC5, N02-AC3).`,
    ),
  });
}

/**
 * Builds the argv for one invocation.
 *
 * The prompt is the final positional argument and never a flag, so an instruction beginning with
 * `-` cannot be read as an option. Nothing here is shell-quoted because nothing here is ever
 * handed to a shell. `--` ends flag parsing so a prompt starting with a dash is still a prompt.
 *
 * `--output-schema` and `-o` are added for **both** invocations and only when a result was
 * requested, because `codex exec --help` and `codex exec resume --help` on 0.160.0 list both
 * under each. They precede `--`, so neither the schema path nor the result path can be read as
 * the prompt, and neither is ever interpolated into a command line.
 */
export function buildArgv(request: {
  readonly sandbox: CodexSandboxMode;
  readonly invocation: CodexInvocation;
  readonly prompt: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly skipGitRepoCheck: boolean;
  readonly configOverrides: readonly string[];
  readonly resultChannel: Pick<CodexResultChannel, 'schemaPath' | 'resultPath'> | null;
  readonly priorSessionId?: string;
}): readonly string[] {
  const argv: string[] = ['exec'];

  if (request.invocation === 'Resume') {
    // `codex exec resume` on 0.159.1 accepts --json, --output-last-message and -c, but no
    // --sandbox and no --cd. The working directory is therefore carried by the child's own cwd
    // and the sandbox by a config override, both verified live on this host.
    argv.push('resume', '-c', `sandbox_mode='${request.sandbox}'`);
  } else {
    argv.push('--sandbox', request.sandbox);
    argv.push('--cd', request.cwd);
  }

  argv.push('--json');
  if (request.model !== null) argv.push('-m', request.model);
  if (request.skipGitRepoCheck) argv.push('--skip-git-repo-check');
  if (request.resultChannel !== null) {
    argv.push('--output-schema', request.resultChannel.schemaPath);
    argv.push('-o', request.resultChannel.resultPath);
  }
  for (const override of request.configOverrides) argv.push('-c', override);
  argv.push('--');
  if (request.priorSessionId !== undefined) argv.push(request.priorSessionId);
  argv.push(request.prompt);
  return argv;
}

/** A Codex process this adapter spawned, with the facts needed to stop it honestly. */
export interface CodexProcess {
  readonly pid: number;
  /** The process-group id, equal to the child's pid because the child was spawned detached. */
  readonly processGroupId: number;
  readonly argv: readonly string[];
  readonly cwd: string;
  /**
   * The structured-result channel this session was given, or null when it was not asked for one.
   *
   * It is part of the process record rather than a separate return value because the answer has to
   * be read from *this* launch's artifact: a channel returned beside the process could be paired
   * with a different one by a caller, and a stale result would then be read as this session's.
   */
  readonly resultChannel: CodexResultChannel | null;
  /** Lines from stdout, in order. Ends when the process closes its stdout. */
  lines(): AsyncIterable<string>;
  /** Bounded tail of stderr. Codex writes its startup banner and warnings there. */
  stderrTail(): string;
  /** Resolves with the exit code, or null when the process was signalled. */
  waited(): Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
  /** `SIGTERM` to the tracked group. Never matches by name. */
  requestGracefulStop(): void;
  /** `SIGKILL` to the tracked group. Never matches by name. */
  killProcessGroup(): void;
  /** Whether any process remains in the tracked group. */
  groupHasSurvivors(): boolean;
  /** Releases listeners so a finished session does not hold the event loop open. */
  dispose(): void;
}

/**
 * The child shape this module handles.
 *
 * stdin is `null` rather than a pipe because the prompt travels in argv: an engine that is
 * handed an open stdin will read it, and a caller that never closes it would hang the session.
 */
type CodexChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export class CodexClient {
  private readonly options: CodexClientOptions;

  constructor(options: CodexClientOptions) {
    this.options = options;
  }

  /**
   * Runs `codex --version` and returns a verdict against the declared floor.
   *
   * This is the `Engine:VersionCheck` capability, and it observes rather than assumes (F04-AC2):
   * the version comes from the engine's own stdout, and a probe that cannot run at all is a
   * `Blocked` prerequisite naming the missing runtime rather than a compatibility answer.
   */
  async checkVersion(context: AdapterContext): Promise<Result<CodexVersionVerdict>> {
    const outcome = await this.probe(['--version'], this.options.versionProbeTimeoutMs ?? DEFAULT_VERSION_PROBE_MS, context.redact);
    if (!outcome.ok) return outcome;
    const version = parseCodexVersion(outcome.value.stdout);
    if (version === null) {
      return err(
        mapCodexVersionProbeFailure(
          `expected a line of the form "codex-cli <major>.<minor>.<patch>" and received: ${outcome.value.stdout.slice(0, 200)}`,
          outcome.value.exitCode,
          context.redact,
        ),
      );
    }
    return ok(checkCodexVersion(version));
  }

  /**
   * Spawns a Codex session as the leader of its own process group.
   *
   * The ShipLoop-owned state is created first, because the engine's environment cannot be
   * assembled without it and because a failure to create it must be a refusal rather than a
   * fallback onto the operator's `~/.codex`. The engine's credential is then *resolved*, so a
   * ShipLoop-owned `CODEX_HOME` with nothing in it is a typed blocker with the provisioning
   * command rather than a copy of the operator's rotating login. The structured-result channel is
   * prepared after that and before the process exists, so a schema that cannot be written or a
   * result path that cannot be confined leaves no running engine behind.
   */
  start(request: CodexSpawnRequest): Result<CodexProcess> {
    if (request.invocation === 'Resume' && request.priorSessionId === undefined) {
      return err(
        mapCodexVersionProbeFailure(
          'a Codex resume must name the recorded thread it continues; `codex exec resume --last` would pick an arbitrary session and silently continue the wrong conversation (F15-AC4).',
          null,
          (text: string): string => text,
        ),
      );
    }
    const state = prepareEngineState({
      stateRoot: this.options.stateRoot,
      attempt: request.cwd,
    });
    if (!state.ok) return err(state.error);

    const authentication = resolveEngineAuthentication(state.value);
    if (!authentication.ok) return err(authentication.error);

    const resultChannel =
      request.result === undefined || request.result === null
        ? null
        : prepareEngineResultChannel({
            layout: state.value,
            schema: request.result.schema,
            token: request.resultToken ?? randomUUID(),
          });
    if (resultChannel !== null && !resultChannel.ok) return err(resultChannel.error);

    const argv = buildArgv({
      sandbox: request.sandbox,
      invocation: request.invocation,
      prompt: request.prompt,
      cwd: request.cwd,
      model: this.options.model ?? null,
      skipGitRepoCheck: this.options.skipGitRepoCheck ?? false,
      configOverrides: this.options.configOverrides ?? [],
      resultChannel: resultChannel === null || !resultChannel.ok ? null : resultChannel.value,
      ...(request.priorSessionId === undefined ? {} : { priorSessionId: request.priorSessionId }),
    });

    const tracked = spawnTrackedGroup(
      [this.options.binary, ...argv],
      request.cwd,
      engineEnvironment(process.env, state.value),
      resultChannel === null || !resultChannel.ok ? null : resultChannel.value,
    );
    if (tracked.ok) return tracked;
    return err(
      mapCodexVersionProbeFailure(
        `the Codex process could not be spawned (${tracked.error.reason})`,
        null,
        (text: string): string => text,
      ),
    );
  }

  /**
   * Bounded one-shot execution, used only for the version probe.
   *
   * The probe is not spawned detached: it is a single short-lived `codex --version` with no
   * descendants, and the caller only needs its exit status and stdout. If it overruns, the child
   * itself is killed and the call fails rather than waiting.
   *
* It runs with the same allowlist as a session. A probe inherits an environment exactly like
   * any other child, so leaving it on `process.env` would keep the whole exposure in place for the
   * one call an operator most often runs by hand. The credential is deliberately **not** required
   * for a version probe and is never created for one: `--version` never authenticates, so resolving
   * a login here would make "can I run codex at all" depend on a credential it does not use.
   */
  private probe(
    argv: readonly string[],
    timeoutMs: number,
    redact: (text: string) => string,
  ): Promise<Result<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }>> {
    const state = prepareEngineState({
      stateRoot: this.options.stateRoot,
      attempt: `codex-version-probe:${this.options.binary}`,
    });
    if (!state.ok) return Promise.resolve(err(state.error));
    const environment = engineEnvironment(process.env, state.value);
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let child: CodexChildProcess;
      try {
        child = spawn(this.options.binary, [...argv], {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          env: environment,
        });
      } catch (cause) {
        resolve(err(mapCodexVersionProbeFailure(describe(cause), null, redact)));
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        resolve(
          err(
            mapCodexVersionProbeFailure(`\`codex ${argv.join(' ')}\` did not answer within ${String(timeoutMs)}ms`, null, redact),
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < STDOUT_CAPTURE_LIMIT) stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < STDERR_TAIL_LIMIT) stderr += chunk;
      });
      child.on('error', (cause: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(err(mapCodexVersionProbeFailure(cause.message, null, redact)));
      });
      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok({ stdout, stderr, exitCode: code }));
      });
    });
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function signalGroup(child: CodexChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone, which is the state the caller asked for */
    }
  }
}

/**
 * The only variables the engine process receives.
 *
 * Every entry is here because the engine demonstrably needs it on 0.159.1, measured on this
 * host, and nothing else is here because nothing else was needed to run `codex --version` and
 * one bounded `codex exec` to completion under exactly this set:
 *
 * - `PATH` — Codex resolves its own Linux sandbox helper and the `git` and shell tools the
 *   session runs from it. Removing it makes the engine unable to start its sandbox.
 * - `HOME` — required by `git`, by every tool the session may run, and by Node itself. It is
 *   **not** the operator's home: {@link engineStateLayout} points it at a ShipLoop-owned
 *   directory created for that attempt, so no operator credential resolves through `$HOME`.
 * - `TMPDIR` — where Codex and its sandbox stage files. Defaults to the OS temporary directory.
 * - `LANG` and `LC_ALL` — Codex refuses to assume a UTF-8 locale and prints
 *   `locale is not UTF-8 - unicode glyphs may render incorrectly` when neither is usable, so
 *   the operator's locale is forwarded rather than invented.
 * - `TZ` — timestamps in the engine's own output are rendered through it.
 * - `CODEX_HOME` — where Codex reads the login this product provisioned and writes its rollouts. It
 *   points at a directory this product created and never at the operator's `~/.codex`; see the
 *   module comment for both reasons (the operator's `sandbox_mode`, and the rotating login).
 *
 * Deliberately absent, each because inheriting it hands the engine authority or a pointer to
 * authority: every other provider credential (`GH_TOKEN`, `LINEAR_API_KEY`, …), `DATABASE_URL`
 * (the authoritative store), the credential-FILE pointers (`NETRC`, `GIT_CONFIG_GLOBAL`,
 * `GIT_CONFIG_NOSYSTEM`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_SSH_COMMAND`, `SSH_AUTH_SOCK`,
 * `XDG_CONFIG_HOME`), the AWS profile selectors, the proxy variables (a proxy URL is a
 * credential and it redirects the engine's traffic), and any operator Codex override such as
 * `CODEX_MANAGED_BY_NPM` or `CONFIG_PROFILE`.
 */
export const ENGINE_ENVIRONMENT_VARIABLES = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'CODEX_HOME'] as const;

/** The engine's own state directory: its login, its rollouts, and nothing the operator wrote. */
export const ENGINE_CODEX_HOME_DIRECTORY = 'codex';

/** Per-attempt home directories live under here, one per workspace, never the operator's. */
export const ENGINE_HOME_DIRECTORY = 'home';

export interface EngineStateLayout {
  /** Absolute, ShipLoop-owned root. Created with mode 0700. */
  readonly stateRoot: string;
  /** `CODEX_HOME` for every attempt: one login, one rollout store, no operator config. */
  readonly codexHome: string;
  /** `HOME` for this attempt alone. */
  readonly home: string;
  /** The directory name the attempt key produced, for diagnostics. */
  readonly attemptKey: string;
}

/** The default state root: XDG state, never a temporary directory. */
export function defaultEngineStateRoot(parent: NodeJS.ProcessEnv = process.env): string {
  const xdg = parent['XDG_STATE_HOME'];
  const base = typeof xdg === 'string' && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'shiploop', 'codex');
}

/**
 * The directory key one attempt's `HOME` is derived from.
 *
 * The workspace path, not the operation id: an attempt that is interrupted and later resumed
 * reconnects to the same worktree (`<attemptRoot>/worktrees/<workspaceId>`), so the same attempt
 * finds the same `HOME`, while two concurrent attempts get two. A short digest is used because
 * a workspace path is a path, and a directory named after a path is a path traversal waiting to
 * happen.
 */
export function attemptKeyOf(attempt: string): string {
  return createHash('sha256').update(attempt).digest('hex').slice(0, 32);
}

/** Resolves the three directories one attempt runs against, without creating anything. */
export function engineStateLayout(options: {
  readonly stateRoot?: string | undefined;
  readonly attempt: string;
}): EngineStateLayout {
  const stateRoot = options.stateRoot ?? defaultEngineStateRoot();
  const attemptKey = attemptKeyOf(options.attempt);
  return {
    stateRoot,
    codexHome: join(stateRoot, ENGINE_CODEX_HOME_DIRECTORY),
    home: join(stateRoot, ENGINE_HOME_DIRECTORY, attemptKey),
    attemptKey,
  };
}

/**
 * Creates the directories the engine runs against and returns them.
 *
 * Mode 0700 because the state root holds the engine's login: a directory the operator's other
 * accounts can list is a directory they can read a credential out of. Idempotent, and it creates
 * nothing but directories — in particular it no longer seeds `auth.json` from the operator's
 * `~/.codex`, because copying a rotating credential is what made the engine and the operator two
 * writers of one refresh token (F15-AC5).
 *
 * A failure here is a refusal, not a warning: a run whose `CODEX_HOME` could not be created
 * would otherwise fall back to `~/.codex` and inherit that file's unrestricted sandbox mode.
 */
export function prepareEngineState(options: {
  readonly stateRoot?: string | undefined;
  readonly attempt: string;
}): Result<EngineStateLayout> {
  const layout = engineStateLayout(options);
  try {
    mkdirSync(layout.stateRoot, { recursive: true, mode: 0o700 });
    mkdirSync(layout.codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(layout.home, { recursive: true, mode: 0o700 });
    chmodSync(layout.home, 0o700);
  } catch (cause) {
    return err({
      code: 'Unavailable',
      reason: `the ShipLoop-owned engine state directory ${layout.stateRoot} could not be created (${describe(cause)}). Running without it would make the engine fall back to the operator's ~/.codex, whose config.toml sets an unrestricted sandbox_mode and approval_policy = "never" on this host, so the attempt is refused rather than started (F03-AC5).`,
    });
  }
  return ok(layout);
}

/** The credential file Codex reads out of `CODEX_HOME`, and the only file ever read from it. */
export const ENGINE_CREDENTIAL_FILE = 'auth.json';

/**
 * Decides what the engine will authenticate as, or blocks the run with the command that fixes it.
 *
 * This is the replacement for the copy that used to live in {@link prepareEngineState}, and it is a
 * *read*. It never writes the credential, never refreshes it, and never looks outside the
 * ShipLoop-owned `CODEX_HOME` it is given — in particular it does not consult `~/.codex`, so there
 * is no path by which a run can begin by reading the operator's rotating token.
 *
 * Four outcomes, and the difference between them is the difference between a four-word fix and an
 * afternoon:
 *
 *   - **present and recognised** → the run proceeds, and the mode is reported rather than guessed;
 *   - **absent** → a `Blocked` error whose prerequisite names
 *     {@link ENGINE_CREDENTIAL_PROVISION_COMMAND}, because a 401 eleven reconnects deep into a
 *     turn is a far worse report than a refusal before a process exists;
 *   - **unreadable or unparseable** → `Unavailable`, naming the file, because a truncated login is
 *     a different fault from a missing one and has a different fix;
 *   - **group- or world-readable** → `Forbidden`, because a credential another account on this host
 *     can read is not a credential this product provisioned.
 *
 * `statSync` and not `lstatSync`, and the containment is not re-checked: `codexHome` is derived
 * from `stateRoot` by {@link engineStateLayout} rather than accepted from a caller, so there is no
 * path here that a symlink or an argument could redirect (F15-AC5).
 */
export function resolveEngineAuthentication(layout: EngineStateLayout): Result<CodexEngineAuthentication> {
  const credentialPath = join(layout.codexHome, ENGINE_CREDENTIAL_FILE);
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(credentialPath);
  } catch (cause) {
    return err(
      blocked(
        `No Codex credential is provisioned for the ShipLoop engine at ${credentialPath} (${describe(cause)}), so this run was refused before any engine process existed. Codex answers an unauthenticated turn with eleven reconnects and a 401, which names the symptom rather than the fix (F15-AC5).`,
        [
          {
            name: 'engine-credential',
            detail:
              'Codex reads its login from $CODEX_HOME/auth.json. ShipLoop points CODEX_HOME at a directory it owns and does not fill it from the operator\'s ~/.codex, because a ChatGPT login is a rotating refresh token and copying one makes the engine and the operator two writers of the same credential. Measured on codex-cli ' +
              CODEX_SEPARATE_CREDENTIAL_VERSION +
              ': an `apikey` login has no refresh token and therefore nothing to rotate.',
            remedy: `Provision one credential into ${layout.codexHome} with: ${ENGINE_CREDENTIAL_PROVISION_COMMAND}`,
          },
        ],
      ),
    );
  }

  if (!info.isFile()) {
    return err({
      code: 'Unavailable',
      reason: `The Codex credential at ${credentialPath} is not a regular file. Codex cannot read it, so this run was refused rather than started against a login that may be somebody else's (F15-AC5).`,
    });
  }
  if ((info.mode & 0o077) !== 0) {
    return err({
      code: 'Forbidden',
      reason: `The Codex credential at ${credentialPath} has mode ${modeText(info.mode)}, so every account on this host can read it. A credential another user can read is not a credential this product provisioned, so the run is refused until the mode is 0600 (F15-AC5).`,
    });
  }

  let mode: CodexCredentialMode | null;
  try {
    mode = readCredentialMode(readFileSync(credentialPath, 'utf8'));
  } catch (cause) {
    return err({
      code: 'Unavailable',
      reason: `The Codex credential at ${credentialPath} could not be read (${describe(cause)}). A login that cannot be read is a different fault from a login that is absent, so it is reported as such rather than as missing (F15-AC5).`,
    });
  }
  if (mode === null) {
    return err({
      code: 'Unavailable',
      reason: `The Codex credential at ${credentialPath} declares neither an "apikey" mode with a key nor a "chatgpt" mode with tokens, so this adapter cannot say what the engine would authenticate as. It is refused rather than run against a credential of unknown provenance (F15-AC5).`,
    });
  }
  return ok({ mode, codexHome: layout.codexHome, credentialPath });
}

/**
 * Which credential a login file holds, or null when it declares neither.
 *
 * The two shapes are the two `codex login` routes measured on this host: `--with-api-key` writes
 * `{"auth_mode":"apikey","OPENAI_API_KEY":"sk-…"}`, and an interactive or device-code ChatGPT login
 * writes `{"auth_mode":"chatgpt","tokens":{…refresh_token…},"last_refresh":"…"}`. Both are checked
 * for the field that makes them *usable*, not only for the mode string, because a login file that
 * names a mode and carries nothing of it is precisely the state a half-finished provisioning leaves
 * behind — and reporting that as provisioned would produce a 401 rather than a fix.
 */
function readCredentialMode(text: string): CodexCredentialMode | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record['auth_mode'] === 'apikey' && typeof record['OPENAI_API_KEY'] === 'string' && record['OPENAI_API_KEY'].length > 0) {
    return 'ApiKey';
  }
  if (record['auth_mode'] === 'chatgpt' && typeof record['tokens'] === 'object' && record['tokens'] !== null) {
    return 'ChatGPT';
  }
  return null;
}

/** `0600` rather than `-rw-------`: the mode is a claim about access, not a rendering of it. */
function modeText(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

/**
 * The child's entire environment: seven names, and the value of each is named here.
 *
 * `HOME` and `CODEX_HOME` are *computed*, never copied — copying the operator's `HOME` is
 * precisely the failure this function exists to prevent, and copying the operator's `CODEX_HOME`
 * would carry that unrestricted `sandbox_mode` with it along with a rotating credential that must
 * never be spent twice.
 */
export function engineEnvironment(
  parent: NodeJS.ProcessEnv,
  layout: EngineStateLayout,
): NodeJS.ProcessEnv {
  const lang = parent['LANG'] ?? parent['LC_ALL'] ?? 'C.UTF-8';
  const environment: NodeJS.ProcessEnv = {
    PATH: parent['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: layout.home,
    TMPDIR: parent['TMPDIR'] ?? tmpdir(),
    LANG: lang,
    TZ: parent['TZ'] ?? 'UTC',
    CODEX_HOME: layout.codexHome,
  };
  // `LC_ALL` only when the operator set one: inventing it would override `LANG` and change the
  // engine's rendering, which is a configuration decision this adapter does not get to make.
  if (typeof parent['LC_ALL'] === 'string' && parent['LC_ALL'].length > 0) {
    environment['LC_ALL'] = parent['LC_ALL'];
  }
  return environment;
}

/* -------------------------------------------------------------------------- */
/* The structured result channel                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Where one attempt's result artifacts live, relative to its ShipLoop-owned home.
 *
 * Inside `HOME` because that directory is already created 0700 for this workspace by
 * {@link prepareEngineState} and is already what both sides agree the attempt owns. It is not
 * inside the workspace: an untracked file in the attempt's own worktree shows up in its change
 * inventory, which is what would make a read-only planning run look like a change (F14-AC4).
 */
export const ENGINE_RESULT_DIRECTORY = join('.shiploop', 'results');

/** The schema file name inside the results directory. One per attempt, rewritten each launch. */
export const ENGINE_RESULT_SCHEMA_FILE = 'schema.json';

/**
 * Upper bound on the bytes one result artifact may hold.
 *
 * A bound and not a truncation: a payload that reaches it was cut off somewhere, and this
 * adapter cannot tell whether it lost a field, so it refuses rather than reporting half a result
 * (F15-AC2). 256 KiB is far above a plan proposal — the live run measured on 2 October 2026
 * produced 2250 bytes for a full `PlanProposal` — and low enough that a runaway engine cannot
 * fill the attempt's state root.
 */
export const MAX_RESULT_BYTES = 256 * 1024;

/** One launch's structured-result channel: where the schema went and where the answer must appear. */
export interface CodexResultChannel {
  /** The attempt-owned directory the channel is confined to, already resolved through symlinks. */
  readonly root: string;
  /** The schema written for `--output-schema`. */
  readonly schemaPath: string;
  /** Where `--output-last-message` must write, confined to `root`. */
  readonly resultPath: string;
  /** `resultPath` relative to `root`, which is what an event reports instead of a host path. */
  readonly resultRelativePath: string;
  /** Upper bound on the bytes the engine may write. */
  readonly maxBytes: number;
}

/** What one result artifact actually held, read whole. */
export interface CodexResultRead {
  /** The engine's text exactly as stored. Not truncated, not yet redacted. */
  readonly text: string;
  /** Bytes the artifact held on disk. */
  readonly byteLength: number;
  /** The artifact's path relative to the attempt directory it was confined to. */
  readonly sourcePath: string;
}

/**
 * Prepares the channel for one launch: creates the directory, writes the schema, and refuses a
 * path that is not confined or already occupied.
 *
 * Nothing here is best-effort. A result channel that cannot be established is a refusal before a
 * process exists, because a session that started without one would end with no payload and no way
 * to say why (F15-AC2).
 */
export function prepareEngineResultChannel(options: {
  readonly layout: EngineStateLayout;
  readonly schema: EngineResultSchema;
  readonly token: string;
  readonly maxBytes?: number;
}): Result<CodexResultChannel, DomainError> {
  const maxBytes = options.maxBytes ?? MAX_RESULT_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESULT_BYTES) {
    return err(
      invalid(
        `A structured result may not be bounded by ${String(maxBytes)} bytes; the bound must be an integer from 1 to ${String(MAX_RESULT_BYTES)}. A bound this adapter does not honour is a bound that would truncate a result silently (F15-AC2).`,
        [{ path: 'maxBytes', message: `Expected an integer from 1 to ${String(MAX_RESULT_BYTES)}.` }],
      ),
    );
  }

  const root = realDirectory(options.layout.home);
  if (root === null) {
    return err({
      code: 'Unavailable',
      reason: `The ShipLoop-owned attempt home ${options.layout.home} is not a readable directory, so a structured result could not be confined to it (F15-AC2).`,
    });
  }

  // The results directory is created and then *resolved*, and the resolution must still be inside
  // the attempt home. That order is the whole point: a `.shiploop` symlink planted in the home
  // would pass a check on the unresolved path and put the channel somewhere else entirely.
  const wanted = join(root, ENGINE_RESULT_DIRECTORY);
  try {
    mkdirSync(wanted, { recursive: true, mode: 0o700 });
  } catch (cause) {
    return err({
      code: 'Unavailable',
      reason: `The result directory ${wanted} could not be created (${describe(cause)}), so a structured result could not be confined to the attempt directory (F15-AC2).`,
    });
  }
  const directory = realDirectory(wanted);
  if (directory === null || !isInside(root, directory)) {
    return err({
      code: 'Forbidden',
      reason: `The result directory ${wanted} does not resolve to a location inside the attempt directory ${root}. Reading a structured result through it could return a file this attempt does not own, so the session is refused rather than run (F15-AC2).`,
    });
  }

  const schemaPath = join(directory, ENGINE_RESULT_SCHEMA_FILE);
  try {
    writeFileSync(schemaPath, JSON.stringify(options.schema), { encoding: 'utf8', mode: 0o600 });
    chmodSync(schemaPath, 0o600);
  } catch (cause) {
    return err({
      code: 'Unavailable',
      reason: `The result schema could not be written to ${schemaPath} (${describe(cause)}). Codex would be asked for a structured answer with no schema to constrain it, so the session is refused rather than run unconstrained (F15-AC2).`,
    });
  }

  const confined = confineResultPath(root, join(directory, `${options.token}.json`));
  if (!confined.ok) return err(confined.error);
  const resultPath = confined.value;

  // The stale check. `token` makes a collision improbable; this makes it impossible, and it is
  // also what refuses a previous attempt's file when the caller pins a token deliberately.
  if (existsSync(resultPath)) {
    return err(
      conflict(
        `A result artifact already exists at ${resultPath}. It may belong to an earlier attempt on this workspace, and a result is only ever read as the current attempt's own, so this session is refused rather than started (F15-AC2).`,
        'no result artifact at this path',
        `a leftover file from an earlier launch`,
      ),
    );
  }

  return ok({
    root,
    schemaPath,
    resultPath,
    resultRelativePath: relative(root, resultPath),
    maxBytes,
  });
}

/**
 * Resolves a candidate result path and refuses it unless it lands inside the attempt directory.
 *
 * Containment is checked against the **resolved** parent directory, so `..` traversal and a
 * symlinked parent are both caught by the same comparison, and the returned path is the resolved
 * one rather than the requested one. A path equal to the root itself is refused too: the artifact
 * is a file, and a "path" that names the directory would have no basename to confine.
 */
export function confineResultPath(root: string, candidate: string): Result<string, DomainError> {
  if (!isAbsolute(candidate)) {
    return err(
      invalid(
        `A structured result path must be absolute; received "${candidate}". A relative path resolves against whatever the process happens to consider its working directory, which is not a boundary (F15-AC2).`,
        [{ path: 'resultPath', message: 'Expected an absolute path inside the attempt directory.' }],
      ),
    );
  }
  const requested = resolve(candidate);
  const name = basename(requested);
  if (name.length === 0 || name === '.' || name === '..') {
    return err(invalid(`The structured result path "${candidate}" does not name a file.`, [
      { path: 'resultPath', message: 'Expected a path whose last segment names a file.' },
    ]));
  }
  const parent = realDirectory(dirname(requested));
  if (parent === null) {
    return err({
      code: 'Unavailable',
      reason: `The directory ${dirname(requested)} does not exist, so the structured result path "${candidate}" cannot be resolved. Reading a result means resolving where it really is, before reading anything (F15-AC2).`,
    });
  }
  if (!isInside(root, parent)) {
    return err({
      code: 'Forbidden',
      reason: `The structured result path "${candidate}" resolves to ${join(parent, name)}, which is outside the attempt directory ${root}. A result confined to nothing is not a result this attempt produced, so the session is refused (F15-AC2).`,
    });
  }
  return ok(join(parent, name));
}

/**
 * Reads one attempt's result artifact whole, or says precisely why it could not be read.
 *
 * Four refusals, each naming its own fault, because "no result" and "a result from somewhere
 * else" are different problems with different fixes:
 *
 *   - nothing was written — an engine that produced no structured answer;
 *   - the artifact is not a regular file — a directory, or a symbolic link, which must never be
 *     followed because the link is the escape;
 *   - the artifact's **resolved** path left the attempt directory — a link swapped in after the
 *     launch;
 *   - the size is empty or past the bound — an engine that wrote nothing usable, or one whose
 *     output was cut off somewhere this adapter cannot see.
 *
 * The decoded text's byte length is compared with the file's own size. A file truncated in the
 * middle of a multi-byte character decodes to a replacement character and to fewer bytes than it
 * held, which is the only encoding fault a byte-count check would otherwise miss.
 */
export function readCodexResult(channel: CodexResultChannel): Result<CodexResultRead, DomainError> {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(channel.resultPath);
  } catch (cause) {
    return err({
      code: 'Unavailable',
      reason: `No structured result was written to ${channel.resultRelativePath} inside the attempt directory (${describe(cause)}). The session asked for a result, so a turn that produced none is a failure to report and not an empty success (F15-AC2).`,
    });
  }
  if (!info.isFile()) {
    return err({
      code: 'Forbidden',
      reason: `The structured result at ${channel.resultRelativePath} is not a regular file. A symbolic link is never followed here, because following it is exactly how a result would arrive from outside the attempt directory (F15-AC2).`,
    });
  }
  if (info.size === 0) {
    return err({
      code: 'Unavailable',
      reason: `The structured result at ${channel.resultRelativePath} is empty. Codex reported a completed turn but wrote no answer, so the session's requested result does not exist (F15-AC2).`,
    });
  }
  if (info.size > channel.maxBytes) {
    return err({
      code: 'Unavailable',
      reason: `The structured result at ${channel.resultRelativePath} is ${String(info.size)} bytes, past the ${String(channel.maxBytes)}-byte bound this adapter reads. It is refused rather than truncated: a cut-off payload cannot be told apart from a whole one, and half a proposal is not a proposal (F15-AC2).`,
    });
  }

  const resolved = realpathSync(channel.resultPath);
  if (!isInside(channel.root, dirname(resolved)) || !isInside(channel.root, resolved)) {
    return err({
      code: 'Forbidden',
      reason: `The structured result at ${channel.resultRelativePath} resolves to ${resolved}, outside the attempt directory ${channel.root}. The path was confined before the run and re-checked after it, so this means the artifact was replaced while the engine was writing (F15-AC2).`,
    });
  }

  let text: string;
  try {
    text = readFileSync(channel.resultPath, 'utf8');
  } catch (cause) {
    return err({
      code: 'Unavailable',
      reason: `The structured result at ${channel.resultRelativePath} could not be read (${describe(cause)}) (F15-AC2).`,
    });
  }
  if (Buffer.byteLength(text, 'utf8') !== info.size) {
    return err({
      code: 'Unavailable',
      reason: `The structured result at ${channel.resultRelativePath} decoded to ${String(Buffer.byteLength(text, 'utf8'))} bytes from a ${String(info.size)}-byte file, so it was cut off mid-character. A result that did not survive the round trip whole is not a result (F15-AC2).`,
    });
  }

  return ok({ text, byteLength: info.size, sourcePath: channel.resultRelativePath });
}

/**
 * Whether `candidate` is `root` itself or something under it.
 *
 * `relative` rather than a string prefix, because `/a/bc` starts with `/a/b` and a prefix test
 * would call it contained. Both sides are compared after resolution by the callers, so this only
 * has to be correct about the paths it is given.
 */
function isInside(root: string, candidate: string): boolean {
  const gap = relative(root, candidate);
  return gap.length > 0 && !gap.startsWith(`..${sep}`) && gap !== '..' && !isAbsolute(gap);
}

/** A resolved existing directory, or null when there is none or it is not a directory. */
function realDirectory(path: string): string | null {
  try {
    const resolved = realpathSync(path);
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Tracked process groups                                                      */
/* -------------------------------------------------------------------------- */
/**
 * Spawns any argv as the leader of its own process group, with an environment the caller chose.
 *
 * Exported separately from {@link CodexClient.start} so the shutdown contract can be proven
 * against a trivial `node -e` process group rather than by spending engine quota on every test
 * run. The Codex-specific argv and environment construction stay inside `start`, and this
 * function is the only place a process is ever created, so there is one implementation of
 * "detached, stdin closed, no shell, one tracked group" rather than two that could drift.
 *
 * `environment` is required rather than defaulted. A default of `process.env` here would put
 * the inheritance this module exists to remove back in one line, and it would be invisible.
 *
 * `resultChannel` defaults to null so a process spawned with no structured result to read needs
 * no extra argument, and is carried onto the returned record so the answer can only ever be read
 * from the launch that asked for it.
 */
export function spawnTrackedGroup(
  argv: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  resultChannel: CodexResultChannel | null = null,
): Result<CodexProcess> {
  let child: CodexChildProcess;
  try {
    child = spawn(argv[0] ?? '', [...argv.slice(1)], {
      cwd,
      // A new process group led by this child, so every descendant is reachable through one group
      // signal and nothing outside the group is (F17-AC1).
      detached: true,
      // stdin is closed rather than piped: an engine handed an open stdin reads it, and a caller
      // that never writes would leave the session waiting on input it will never send.
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      // An explicit environment, never an inherited one. The engine runs as the same uid and can
      // read any file the worker can, so an inherited `GH_TOKEN`, `LINEAR_API_KEY`,
      // `DATABASE_URL` or `SSH_AUTH_SOCK` is authority handed to code the owner is being asked to
      // trust with their repository. The map is the allowlist in `engineEnvironment` and nothing
      // else reaches this child (F03-AC5, N02-AC3).
      env: environment,
    });
  } catch (cause) {
    return err({ code: 'Unavailable', reason: `the process could not be spawned (${describe(cause)})` });
  }
  // A binary that does not exist, or is not executable, emits `error` asynchronously and carries no
  // pid. The listener is attached before that can fire because an `error` event with no listener is
  // an unhandled exception, which would take the whole worker down instead of reporting one
  // unrunnable attempt.
  child.on('error', () => undefined);
  if (typeof child.pid !== 'number') {
    return err({
      code: 'Unavailable',
      reason: `the binary ${argv[0] ?? ''} was not started, so no process id exists to track or stop. It is missing, is not executable, or is not on PATH.`,
    });
  }
  return ok(wrapProcess(child, argv, cwd, resultChannel));
}

/**
 * Wraps a spawned child as a tracked process group.
 *
 * `lines()` is an async queue rather than a polling loop, so a long silent turn costs nothing
 * and a closed stdout ends the iteration deterministically instead of after a fixed delay.
 */
function wrapProcess(child: CodexChildProcess, argv: readonly string[], cwd: string, resultChannel: CodexResultChannel | null): CodexProcess {
  const pid = child.pid as number;
  const queue: string[] = [];
  let buffer = '';
  let stderr = '';
  let closed = false;
  let waiter: (() => void) | null = null;
  let exitResult: { readonly exitCode: number | null; readonly signal: string | null } | null = null;
  let settleExit: (() => void) | null = null;

  const exited = new Promise<{ readonly exitCode: number | null; readonly signal: string | null }>((resolve) => {
    settleExit = () => resolve(exitResult ?? { exitCode: null, signal: null });
  });

  const wake = (): void => {
    const resume = waiter;
    waiter = null;
    resume?.();
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      queue.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
    wake();
  });
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < STDERR_TAIL_LIMIT) stderr += chunk;
  });
  child.on('error', (cause: Error) => {
    if (stderr.length < STDERR_TAIL_LIMIT) stderr += `${stderr.length > 0 ? '\n' : ''}${cause.message}`;
  });
  child.on('close', (code: number | null, signalName: NodeJS.Signals | null) => {
    if (buffer.length > 0) {
      queue.push(buffer);
      buffer = '';
    }
    closed = true;
    exitResult = { exitCode: code, signal: signalName };
    settleExit?.();
    wake();
  });

  return {
    pid,
    processGroupId: pid,
    argv,
    cwd,
    resultChannel,
    async *lines(): AsyncIterable<string> {
      let index = 0;
      for (;;) {
        while (index < queue.length) {
          const line = queue[index];
          index += 1;
          if (line !== undefined) yield line;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
    },
    stderrTail: (): string => stderr,
    waited: (): Promise<{ readonly exitCode: number | null; readonly signal: string | null }> => exited,
    requestGracefulStop: (): void => signalGroup(child, 'SIGTERM'),
    killProcessGroup: (): void => signalGroup(child, 'SIGKILL'),
    groupHasSurvivors: (): boolean => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    dispose: (): void => {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
    },
  };
}

/** What a stop attempt actually achieved, which is what F17-AC1 must be told. */
export interface CodexStopReport {
  /** The engine answered `SIGTERM` inside the graceful window. */
  readonly graceful: boolean;
  /** `SIGKILL` was needed to end the group. */
  readonly escalated: boolean;
  /** The process is confirmed gone. */
  readonly stopped: boolean;
  /** Whether a process still remains in the tracked group. */
  readonly survivors: boolean;
}

/**
 * Stops a session and reports which signal actually ended it.
 *
 * F17-AC1 permits a `Paused` report only once the writer is stopped or safely detached, so this
 * function never claims a stop it did not observe. A group that still has a member after
 * `SIGKILL` yields `stopped: false`, and the caller must report `Detached` with reconciliation
 * required rather than `Stopped` (F17-AC5).
 */
export async function stopCodexProcess(
  target: CodexProcess,
  options: { readonly gracefulStopMs?: number; readonly killWaitMs?: number } = {},
): Promise<CodexStopReport> {
  const gracefulMs = options.gracefulStopMs ?? DEFAULT_GRACEFUL_STOP_MS;
  const killMs = options.killWaitMs ?? DEFAULT_KILL_WAIT_MS;

  target.requestGracefulStop();
  if (await waitForExit(target.waited(), gracefulMs)) {
    return { graceful: true, escalated: false, stopped: true, survivors: !(await waitForEmptyGroup(target, killMs)) };
  }

  target.killProcessGroup();
  if (await waitForExit(target.waited(), killMs)) {
    return { graceful: false, escalated: true, stopped: true, survivors: !(await waitForEmptyGroup(target, killMs)) };
  }

  return { graceful: false, escalated: true, stopped: false, survivors: true };
}

/**
 * Waits, for a bounded window, until the tracked group holds no process.
 *
 * A single `kill(-pgid, 0)` immediately after the leader exits is a race, not an observation: a
 * descendant this adapter did not spawn is reaped by init, so the group can still hold a zombie
 * for a few milliseconds after the kill. Sampling once would report `Detached` for a group that
 * is in fact clean, which is the wrong answer in the direction that blocks an attempt. Polling to
 * a deadline is what makes `survivors: false` mean the group was **observed** empty.
 *
 * The sleep between samples is a referenced timer. This poll runs at the one moment nothing else
 * holds the event loop: the leader has been reaped, so the only handle left is this timer, and an
 * unreferenced one lets Node end the worker with `Detected unsettled top-level await` and exit 13
 * before the checkpoint is written. The bound is the deadline, not the timer's reference
 * (F17-AC1, F17-AC2).
 */
async function waitForEmptyGroup(target: CodexProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!target.groupHasSurvivors()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

/**
 * Waits, for a bounded window, until the child exits.
 *
 * The timeout is referenced for the same reason the group poll's sleep is: after the last process
 * handle is released, an unreferenced timeout is the only thing left, and Node would end the worker
 * before it could report whether the group actually stopped (F17-AC1, F17-AC2).
 */
async function waitForExit(
  waited: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const outcome = await Promise.race([waited.then(() => 'exited' as const), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome === 'exited';
}
