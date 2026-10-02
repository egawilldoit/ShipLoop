/**
 * Provider registration from configuration (F03-AC1, F03-AC2, F03-AC4, F10-AC1, F11-AC1).
 *
 * This is what the shipped web process registers instead of declaring no adapter at all. A
 * process with nothing configured keeps the honest state it had before — no declarations, and a
 * refusal that names the missing provider — and a process with something configured gets the
 * real `LinearTicketAdapter`, `GitHubGitAdapter` and `CodexEngineAdapter`, built here from the
 * environment rather than from a test-only composition module.
 *
 * Four properties are the reason the shape is what it is:
 *
 *   - **Configuration names where a credential lives, never the credential.** A provider
 *     configuration carries the *name* of an environment variable and the credential reference
 *     that variable is authorised for (F03-AC3). A secret in configuration is a secret in a
 *     process listing, an image layer and a support bundle.
 *   - **Resolution happens per operation.** A credential absent at boot and one withdrawn since
 *     produce the same blocker at the operation that needed it, naming the capability that could
 *     not run (F03-AC4). Resolving once at startup would report a usable provider for the life
 *     of the process.
 *   - **Missing access is `Blocked`, not `Unavailable`.** `Unavailable` is reserved for a
 *     provider that does not implement a capability at all, so an absent credential can never be
 *     read as an unimplemented one, and neither is a silent success (F03-AC2, N05-AC2).
 *   - **Capability comes from the shipped adapter, not from a list written here.** The
 *     declarations the profile gate and the connector registry read are the ones the real
 *     adapter reports, so what ShipLoop claims to support and what it can perform are the same
 *     fact (F03-AC2).
 *
 * The stored credential reference is checked against the configured one before any provider is
 * contacted, so a project pointing at a credential this deployment was not given is refused by
 * name rather than silently served with whichever credential the process happens to hold
 * (F03-AC1, F03-AC3).
 */

import {
  ADAPTER_CONTRACT_VERSION,
  CodexEngineAdapter,
  GITHUB_PROVIDER,
  GitHubGitAdapter,
  createGitTransport,
  deniedCodingCapabilities,
} from '@shiploop/adapters';
import type {
  AdapterCapabilities,
  AdapterCompatibility,
  AdapterContext,
  CodingSessionCapability,
  DeclareNoCodeOutcomeRequest,
  DescribeTransitionsRequest,
  DraftRef,
  EngineAdapter,
  EngineContinuation,
  EngineEvent,
  EngineSessionHandle,
  EngineStopOutcome,
  FindDraftsRequest,
  GitAdapter,
  GitRepositoryRef,
  GitStateRead,
  GitTransport,
  ManagedProgressOutcome,
  ManagedProgressUpdateRequest,
  MergeOutcome,
  MergePullRequestRequest,
  NoCodeOutcomeRecord,
  ProviderCheckObservation,
  PublishWorkOutcome,
  PublishWorkRequest,
  PushBranchOutcome,
  PushBranchRequest,
  ReadChecksRequest,
  ReadGitStateRequest,
  ReadTicketScopeRequest,
  RelatedIssue,
  RelatedIssueSearchRequest,
  ResumeEngineSessionRequest,
  StopEngineSessionRequest,
  TicketAdapter,
  TicketScopeRead,
  TicketTransitionDescriptor,
  TicketTransitionOutcome,
  TicketTransitionRequest,
  UpsertDraftOutcome,
  UpsertDraftRequest,
} from '@shiploop/adapters';
import { readFileSync } from 'node:fs';
// `@shiploop/adapters` publishes only its root entry point, which does not carry Linear, so the
// shipped Linear adapter is reached by the same relative path `apps/worker/src/live-run.ts`
// uses. Widening that package's exports is not part of this change.
import { LinearTicketAdapter } from '../../adapters/src/linear/index.ts';
import { blocked, err, invalid, ok, redact, secretFreeReason } from '@shiploop/domain';
import type {
  BlockedError,
  CapabilityDeclaration,
  CapabilityKind,
  ConnectorId,
  DomainError,
  OperationId,
  ProviderId,
  Result,
} from '@shiploop/domain';
import type { ConnectorKind, ConnectorRecord } from '@shiploop/storage';
import type {
  AdapterRegistry,
  ConnectorProbe,
  ConnectorProbeContext,
  ConnectorProbeObservation,
} from './connectors.ts';

/* -------------------------------------------------------------------------- */
/* The boundary                                                               */
/* -------------------------------------------------------------------------- */

/** The only ticket provider name this module knows how to register. */
export const LINEAR_PROVIDER = 'linear';

/** Names the ticket provider this process serves, as `linear` (F03-AC1). */
export const TICKET_PROVIDER_ENV = 'SHIPLOOP_PROVIDER_TICKET';
/** The credential reference the ticket provider's credential is authorised for (F03-AC3). */
export const TICKET_CREDENTIAL_REFERENCE_ENV = 'SHIPLOOP_PROVIDER_TICKET_CREDENTIAL_REFERENCE';
/** The environment variable whose value is the ticket provider's credential, never the credential. */
export const TICKET_SECRET_ENV = 'SHIPLOOP_PROVIDER_TICKET_SECRET_ENV';
/** The endpoint the ticket adapter addresses; absent takes the adapter's published default. */
export const TICKET_ENDPOINT_ENV = 'SHIPLOOP_PROVIDER_TICKET_ENDPOINT';
/** Names the git provider this process serves, as `github` (F03-AC1). */
export const GIT_PROVIDER_ENV = 'SHIPLOOP_PROVIDER_GIT';
/** The credential reference the git provider's credential is authorised for (F03-AC3). */
export const GIT_CREDENTIAL_REFERENCE_ENV = 'SHIPLOOP_PROVIDER_GIT_CREDENTIAL_REFERENCE';
/** The environment variable whose value is the git provider's credential, never the credential. */
export const GIT_SECRET_ENV = 'SHIPLOOP_PROVIDER_GIT_SECRET_ENV';
/** The REST base URL the git adapter addresses; absent takes the adapter's published default. */
export const GIT_API_BASE_URL_ENV = 'SHIPLOOP_PROVIDER_GIT_API_BASE_URL';
/** The local checkout `git push` runs in, which a git provider cannot be used without. */
export const GIT_WORKTREE_ENV = 'SHIPLOOP_PROVIDER_GIT_WORKTREE';
/** The coding engine binary this process serves; absent means no engine is registered. */
export const ENGINE_BINARY_ENV = 'SHIPLOOP_PROVIDER_ENGINE_BINARY';
/** The recorded answers this process replays instead of contacting a model. */
export const ENGINE_TRANSCRIPT_ENV = 'SHIPLOOP_PROVIDER_ENGINE_TRANSCRIPT';

/**
 * Reads the environment variable that holds a credential.
 *
 * Injected rather than reaching for `process.env` inside the resolvers, so a test never reads the
 * process it is running in and a credential cannot reach this module except through a call that
 * needed it (N02-AC2).
 */
export type ProviderSecretReader = (variable: string) => string | undefined;

/** One configured provider and the stored credential reference it is authorised for. */
export interface ProviderBinding {
  readonly kind: ConnectorKind;
  readonly provider: string;
  readonly connectorId: ConnectorId;
  /** The reference this process may resolve. A connector row naming another one is refused. */
  readonly credentialReference: string;
  /** The environment variable that holds the credential. Its name, never its value (F03-AC3). */
  readonly secretEnvironmentVariable: string;
  /** Provider endpoint, or null to take the shipped adapter's own default. */
  readonly endpoint: string | null;
  /** Local checkout the git adapter pushes from; null for a provider that pushes nothing. */
  readonly worktree: string | null;
}

/**
 * How this process runs model work (F07-AC1, F08-AC1, F03-AC5).
 *
 * Two drivers, named rather than implied, because they are different claims and a record that
 * cannot say which one produced it cannot be reviewed:
 *
 *   - `Executable` spawns the configured binary through the shipped `CodexEngineAdapter`.
 *     This is the only driver that contacts a model, and it is what an operator means by
 *     "configure the engine".
 *   - `RecordedTranscript` replays an answer recorded ahead of time. No model is contacted, no
 *     budget is spent, and the answer is a fixed document, so it exists for a deployment that
 *     must exercise the generation path deterministically. Everything else about the pass is
 *     unchanged: the domain validates the answer, the store records what it validated and the
 *     owner reads it, which is why it is a driver rather than a bypass.
 *
 * A driver is never chosen by inference from the other's absence: one variable names an
 * executable, the other names a transcript, and setting both is a configuration error rather
 * than a silent preference (F03-AC1).
 */
export type EngineDriver = 'Executable' | 'RecordedTranscript';

/** The coding engine, configured as an executable or as a recorded transcript. */
export interface EngineBinding {
  readonly connectorId: ConnectorId;
  readonly driver: EngineDriver;
  /** The executable for `Executable`; the transcript file for `RecordedTranscript`. */
  readonly source: string;
}

/**
 * Everything the boundary parsed, validated once.
 *
 * An absent binding means the operator configured no such provider, which is a different state
 * from one configured without a credential: the first reports that nothing is registered, the
 * second reports that a specific capability is blocked (F03-AC2).
 */
export interface ProviderConfiguration {
  readonly ticket: ProviderBinding | null;
  readonly git: ProviderBinding | null;
  readonly engine: EngineBinding | null;
}

/** The seams a test drives the real adapters through instead of replacing them (N05-AC2). */
export interface ProviderTransport {
  /** HTTP transport both provider clients speak. Defaults to this process's own `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** `git` transport the git adapter pushes through. Defaults to the configured worktree. */
  readonly gitTransport?: GitTransport;
  /** Credential lookup. Defaults to reading this process's environment. */
  readonly readSecret?: ProviderSecretReader;
}

/** The providers this process registered. */
export interface ProviderRegistry {
  /** What the connector layer and the profile gate read (F03-AC2). */
  readonly adapters: AdapterRegistry;
  /** Present only when a ticket provider is configured; publication and adoption read it. */
  readonly ticket: TicketAdapter | null;
  /** Present only when a git provider is configured; adopting a branch needs one (F11-AC2). */
  readonly git: GitAdapter | null;
  /**
   * The coding engine this process registered, or null when it configured none.
   *
   * Published rather than kept inside this module because generation is the only caller that
   * reaches an engine, and a caller that had to reach into the registry's own constructor to
   * find one would either get nothing or get a second engine that is not the configured one
   * (F07-AC1, F08-AC1, N05-AC2). Absent is reported as a named refusal at the operation rather
   * than as a stub that refuses every call (F03-AC2).
   */
  readonly engine: EngineAdapter | null;
  /**
   * The blocker an operation must stop on, or null when its provider may act.
   *
   * `operation` names the capability the caller was performing, so the refusal says which action
   * is blocked. `storedReference` is the reference on the connector row when the caller has one;
   * without it the process's configured reference is the only reference in play, which is the
   * case for publication and adoption (F03-AC1, F03-AC3).
   */
  readonly credentialBlocker: (
    kind: ConnectorKind,
    operation: string,
    storedReference?: string,
  ) => DomainError | null;
}

const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reads and validates the provider configuration from the environment.
 *
 * Every problem is reported at once, because an operator fixing a deployment should not need one
 * restart per mistake (F03-AC1). A provider name this module cannot register is a configuration
 * error rather than a silent no-provider state: `SHIPLOOP_PROVIDER_TICKET=linera` that quietly
 * registered nothing would leave the owner reading "this deployment has no ticket provider" for a
 * provider that was configured (F03-AC2).
 */
export function readProviderConfiguration(env: NodeJS.ProcessEnv): Result<ProviderConfiguration, DomainError> {
  const problems: { readonly path: string; readonly message: string }[] = [];

  let ticket: ProviderBinding | null = null;
  const ticketName = trimmed(env[TICKET_PROVIDER_ENV]);
  if (ticketName !== null) {
    if (ticketName !== LINEAR_PROVIDER) {
      problems.push({ path: TICKET_PROVIDER_ENV, message: `Expected "${LINEAR_PROVIDER}".` });
    } else {
      const reference = requiredText(env[TICKET_CREDENTIAL_REFERENCE_ENV], TICKET_CREDENTIAL_REFERENCE_ENV, problems);
      const secretVariable = environmentVariableName(env[TICKET_SECRET_ENV], TICKET_SECRET_ENV, problems);
      if (reference !== null && secretVariable !== null) {
        ticket = {
          kind: 'Ticket',
          provider: LINEAR_PROVIDER,
          connectorId: connectorIdFor(LINEAR_PROVIDER),
          credentialReference: reference,
          secretEnvironmentVariable: secretVariable,
          endpoint: trimmed(env[TICKET_ENDPOINT_ENV]),
          worktree: null,
        };
      }
    }
  }

  let git: ProviderBinding | null = null;
  const gitName = trimmed(env[GIT_PROVIDER_ENV]);
  if (gitName !== null) {
    if (gitName !== GITHUB_PROVIDER) {
      problems.push({ path: GIT_PROVIDER_ENV, message: `Expected "${GITHUB_PROVIDER}".` });
    } else {
      const reference = requiredText(env[GIT_CREDENTIAL_REFERENCE_ENV], GIT_CREDENTIAL_REFERENCE_ENV, problems);
      const secretVariable = environmentVariableName(env[GIT_SECRET_ENV], GIT_SECRET_ENV, problems);
      // Required rather than defaulted: a git adapter pushes through a local checkout, and a
      // default would mean pushing from wherever the process happened to be started.
      const worktree = requiredText(env[GIT_WORKTREE_ENV], GIT_WORKTREE_ENV, problems);
      if (reference !== null && secretVariable !== null && worktree !== null) {
        git = {
          kind: 'Git',
          provider: GITHUB_PROVIDER,
          connectorId: connectorIdFor(GITHUB_PROVIDER),
          credentialReference: reference,
          secretEnvironmentVariable: secretVariable,
          endpoint: trimmed(env[GIT_API_BASE_URL_ENV]),
          worktree,
        };
      }
    }
  }

const engineBinary = trimmed(env[ENGINE_BINARY_ENV]);
  const engineTranscript = trimmed(env[ENGINE_TRANSCRIPT_ENV]);
  if (engineBinary !== null && engineTranscript !== null) {
    problems.push({
      path: ENGINE_TRANSCRIPT_ENV,
      message: `${ENGINE_BINARY_ENV} and ${ENGINE_TRANSCRIPT_ENV} name two different engines. Configure exactly one: a process either runs a model or replays recorded answers (F03-AC1).`,
    });
  }
  const engine: EngineBinding | null =
    engineBinary !== null
      ? { connectorId: connectorIdFor('codex'), driver: 'Executable', source: engineBinary }
      : engineTranscript !== null
        ? { connectorId: connectorIdFor('codex-recorded'), driver: 'RecordedTranscript', source: engineTranscript }
        : null;

  if (problems.length > 0) return err(invalid('The provider configuration is not usable.', problems));
  return ok({ ticket, git, engine });
}

/**
 * The adapter's own connector identity.
 *
 * Derived rather than configured: nothing an operator enters here is an identity, and a
 * configurable value would be one more place for two processes to disagree about who they are.
 */
function connectorIdFor(provider: string): ConnectorId {
  return `connector_configured_${provider}` as ConnectorId;
}

function trimmed(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value.trim();
  return text.length === 0 ? null : text;
}

function requiredText(
  value: string | undefined,
  path: string,
  problems: { readonly path: string; readonly message: string }[],
): string | null {
  const text = trimmed(value);
  if (text === null) {
    problems.push({ path, message: 'Required when the provider it configures is set (F03-AC1).' });
    return null;
  }
  return text;
}

/**
 * Reads the *name* of the variable that holds a credential.
 *
 * The value is never read here, which is what keeps a credential out of configuration and out of
 * this process's memory before an operation asks for one (F03-AC3).
 */
function environmentVariableName(
  value: string | undefined,
  path: string,
  problems: { readonly path: string; readonly message: string }[],
): string | null {
  const name = requiredText(value, path, problems);
  if (name === null) return null;
  if (!ENVIRONMENT_VARIABLE_NAME.test(name)) {
    problems.push({
      path,
      message: 'Expected the NAME of the variable holding the credential, not the credential itself (F03-AC3).',
    });
    return null;
  }
  return name;
}

/* -------------------------------------------------------------------------- */
/* Credential resolution                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The blocker for a stored reference this deployment was not configured for.
 *
 * Distinct from an absent secret because it is fixed differently: a row pointing at a reference
 * this process cannot serve is an owner-side correction, while an empty secret variable is an
 * operator-side one. Collapsing them would tell the owner to change something that is correct
 * (F03-AC1, F03-AC4).
 */
function referenceBlocker(
  binding: ProviderBinding,
  operation: string,
  storedReference: string | undefined,
): BlockedError | null {
  if (storedReference === undefined || storedReference === binding.credentialReference) return null;
  return blocked(
    `${operation} is blocked: this deployment acts for ${binding.provider} credential reference "${binding.credentialReference}", and the stored connector names "${storedReference}" instead (F03-AC1, F03-AC3).`,
    [
      {
        name: `${binding.provider} credential reference`,
        detail: `The connector row stores credential reference "${storedReference}". No credential this deployment holds is authorised for it, so acting would mean using a different credential than the owner recorded (F03-AC3).`,
        remedy: `Point the connector at credential reference "${binding.credentialReference}", or configure this deployment for "${storedReference}" and restart it, then try again (F03-AC1).`,
      },
    ],
  );
}

/** The blocker for a credential this process does not hold. */
function secretBlocker(binding: ProviderBinding, operation: string): BlockedError {
  return blocked(
    `${operation} is blocked: the ${binding.provider} credential for reference "${binding.credentialReference}" is not present in this process (F03-AC3).`,
    [
      {
        name: `${binding.provider} credential`,
        detail: `Reference "${binding.credentialReference}" is configured to read its credential from ${binding.secretEnvironmentVariable}, and that variable is unset or empty. The credential itself is never read from configuration (F03-AC3).`,
        remedy: `Set ${binding.secretEnvironmentVariable} to the ${binding.provider} credential this reference names, restart the process, then try again (F03-AC1, F03-AC2).`,
      },
    ],
  );
}

/** The credential for one operation, or the blocker naming why there is none. */
function credentialFor(binding: ProviderBinding, operation: string, readSecret: ProviderSecretReader): Result<string> {
  const secret = readSecret(binding.secretEnvironmentVariable);
  if (secret === undefined || secret.trim().length === 0) return err(secretBlocker(binding, operation));
  return ok(secret);
}

/**
 * The blocker an operation stops on, or null when it may proceed.
 *
 * Null for an unconfigured provider is deliberate: the caller already reported that no provider
 * of this kind is registered, and reporting a credential problem for one that does not exist
 * would name the wrong fix (F03-AC2).
 */
function credentialBlockerFor(
  binding: ProviderBinding | null,
  operation: string,
  storedReference: string | undefined,
  readSecret: ProviderSecretReader,
): BlockedError | null {
  if (binding === null) return null;
  const mismatch = referenceBlocker(binding, operation, storedReference);
  if (mismatch !== null) return mismatch;
  return credentialFor(binding, operation, readSecret).ok ? null : secretBlocker(binding, operation);
}

/**
 * The blocker a stored reference cannot be acted under, as owner-facing text.
 *
 * `testConnections` records an observation rather than an error, so the blocker is rendered here
 * rather than discarded. One renderer, so the owner reads the sentence the operation would have
 * refused with.
 */
function blockerText(error: DomainError): string {
  const remedies =
    error.code === 'Blocked' ? error.prerequisites.map((prerequisite) => prerequisite.remedy).join(' ') : '';
  return secretFreeReason(remedies.length === 0 ? error.reason : `${error.reason} ${remedies}`);
}

/* -------------------------------------------------------------------------- */
/* Credential-scoped adapters                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The credential the declaration-only instance carries.
 *
 * An adapter reports its capabilities from an instance while its client refuses to be built
 * without a credential, so answering "what does this adapter declare" needs an instance before
 * any credential has been resolved. This constant authenticates nothing and names no account:
 * the client it is attached to refuses every request, so the instance cannot reach a provider
 * even by mistake, and every operation that contacts one builds its own adapter from the
 * resolved credential instead.
 */
const DECLARATION_ONLY_CREDENTIAL = 'shiploop-declarations-only';

const declarationOnlyFetch: typeof fetch = () =>
  Promise.reject(new Error('This adapter instance reports capabilities only and must never reach a provider.'));

/** A typed refusal for an operation whose credential could not be resolved. */
function refusal<T>(error: DomainError): Promise<Result<T>> {
  return Promise.resolve(err(error));
}

/**
 * A ticket adapter that resolves its credential per operation.
 *
 * The shipped `LinearTicketAdapter` is built for each call, which is what makes a credential
 * that appears after boot usable and one withdrawn mid-run stop being used, without the process
 * holding a credential longer than a single operation (F03-AC4).
 */
class CredentialScopedTicketAdapter implements TicketAdapter {
  readonly kind = 'Ticket' as const;
  readonly connectorId: ConnectorId;
  private readonly declarations: readonly CapabilityDeclaration[];
  private readonly resolve: (operation: string) => Result<TicketAdapter>;

  constructor(
    connectorId: ConnectorId,
    declarations: readonly CapabilityDeclaration[],
    resolve: (operation: string) => Result<TicketAdapter>,
  ) {
    this.connectorId = connectorId;
    this.declarations = declarations;
    this.resolve = resolve;
  }

  capabilities(): AdapterCapabilities {
    return { kind: 'Ticket', contractVersion: ADAPTER_CONTRACT_VERSION, declarations: this.declarations };
  }

  /**
   * A missing credential is reported as an incompatible provider carrying the blocker, so a
   * probe can show the owner which remedy applies rather than a bare failure (F03-AC2).
   */
  async checkCompatibility(context: AdapterContext): Promise<Result<AdapterCompatibility>> {
    const adapter = this.resolve('checking ticket provider access');
    if (!adapter.ok) {
      return ok({
        kind: 'Ticket',
        contractVersion: ADAPTER_CONTRACT_VERSION,
        runtimeVersion: null,
        compatible: false,
        detail: blockerText(adapter.error),
        observedAt: context.clock.now(),
      });
    }
    return adapter.value.checkCompatibility(context);
  }

  readScope(context: AdapterContext, request: ReadTicketScopeRequest): Promise<Result<TicketScopeRead>> {
    const adapter = this.resolve('Ticket:ReadScope');
    return adapter.ok ? adapter.value.readScope(context, request) : refusal<TicketScopeRead>(adapter.error);
  }

  findRelatedIssues(
    context: AdapterContext,
    request: RelatedIssueSearchRequest,
  ): Promise<Result<readonly RelatedIssue[]>> {
    const adapter = this.resolve('Ticket:ReadScope');
    return adapter.ok
      ? adapter.value.findRelatedIssues(context, request)
      : refusal<readonly RelatedIssue[]>(adapter.error);
  }

  publishWork(context: AdapterContext, request: PublishWorkRequest): Promise<Result<PublishWorkOutcome>> {
    const adapter = this.resolve('Ticket:PublishIssue');
    return adapter.ok ? adapter.value.publishWork(context, request) : refusal<PublishWorkOutcome>(adapter.error);
  }

  updateManagedProgress(
    context: AdapterContext,
    request: ManagedProgressUpdateRequest,
  ): Promise<Result<ManagedProgressOutcome>> {
    const adapter = this.resolve('Ticket:UpdateManagedProgress');
    return adapter.ok
      ? adapter.value.updateManagedProgress(context, request)
      : refusal<ManagedProgressOutcome>(adapter.error);
  }

  describeTransitions(
    context: AdapterContext,
    request: DescribeTransitionsRequest,
  ): Promise<Result<readonly TicketTransitionDescriptor[]>> {
    const adapter = this.resolve('Ticket:RequestTransition');
    return adapter.ok
      ? adapter.value.describeTransitions(context, request)
      : refusal<readonly TicketTransitionDescriptor[]>(adapter.error);
  }

  requestTransition(
    context: AdapterContext,
    request: TicketTransitionRequest,
  ): Promise<Result<TicketTransitionOutcome>> {
    const adapter = this.resolve('Ticket:RequestTransition');
    return adapter.ok
      ? adapter.value.requestTransition(context, request)
      : refusal<TicketTransitionOutcome>(adapter.error);
  }
}

/**
 * A git adapter that resolves its credential per operation.
 *
 * The connector probe does not come through here: a git credential is only compatible once it
 * can read a named repository, and this port has no repository to name, so `checkCompatibility`
 * is absent from the `GitAdapter` contract for that reason and the probe reads the repository
 * through the shipped adapter directly (F03-AC2, F11-AC3).
 */
class CredentialScopedGitAdapter implements GitAdapter {
  readonly kind = 'Git' as const;
  readonly connectorId: ConnectorId;
  private readonly declarations: readonly CapabilityDeclaration[];
  private readonly resolve: (operation: string) => Result<GitAdapter>;

  constructor(
    connectorId: ConnectorId,
    declarations: readonly CapabilityDeclaration[],
    resolve: (operation: string) => Result<GitAdapter>,
  ) {
    this.connectorId = connectorId;
    this.declarations = declarations;
    this.resolve = resolve;
  }

  capabilities(): AdapterCapabilities {
    return { kind: 'Git', contractVersion: ADAPTER_CONTRACT_VERSION, declarations: this.declarations };
  }

  /** Delegates, so the answer about an unnamed repository is the shipped adapter's own. */
  async checkCompatibility(context: AdapterContext): Promise<Result<AdapterCompatibility>> {
    const adapter = this.resolve('Git:ReadRepository');
    return adapter.ok ? adapter.value.checkCompatibility(context) : err(adapter.error);
  }

  readState(context: AdapterContext, request: ReadGitStateRequest): Promise<Result<GitStateRead>> {
    const adapter = this.resolve('Git:ReadRepository');
    return adapter.ok ? adapter.value.readState(context, request) : refusal<GitStateRead>(adapter.error);
  }

  readChecks(
    context: AdapterContext,
    request: ReadChecksRequest,
  ): Promise<Result<readonly ProviderCheckObservation[]>> {
    const adapter = this.resolve('Git:ReadChecks');
    return adapter.ok
      ? adapter.value.readChecks(context, request)
      : refusal<readonly ProviderCheckObservation[]>(adapter.error);
  }

  pushBranch(context: AdapterContext, request: PushBranchRequest): Promise<Result<PushBranchOutcome>> {
    const adapter = this.resolve('Git:PushBranch');
    return adapter.ok ? adapter.value.pushBranch(context, request) : refusal<PushBranchOutcome>(adapter.error);
  }

  findDrafts(context: AdapterContext, request: FindDraftsRequest): Promise<Result<readonly DraftRef[]>> {
    const adapter = this.resolve('Git:CreateDraft');
    return adapter.ok ? adapter.value.findDrafts(context, request) : refusal<readonly DraftRef[]>(adapter.error);
  }

  upsertDraft(context: AdapterContext, request: UpsertDraftRequest): Promise<Result<UpsertDraftOutcome>> {
    const adapter = this.resolve('Git:CreateDraft');
    return adapter.ok ? adapter.value.upsertDraft(context, request) : refusal<UpsertDraftOutcome>(adapter.error);
  }

  declareNoCodeOutcome(
    context: AdapterContext,
    request: DeclareNoCodeOutcomeRequest,
  ): Promise<Result<NoCodeOutcomeRecord>> {
    const adapter = this.resolve('Git:DeclareNoCode');
    return adapter.ok
      ? adapter.value.declareNoCodeOutcome(context, request)
      : refusal<NoCodeOutcomeRecord>(adapter.error);
  }

  mergePullRequest(
    context: AdapterContext,
    request: MergePullRequestRequest,
  ): Promise<Result<MergeOutcome>> {
    const adapter = this.resolve('Git:MergeWithPrecondition');
    return adapter.ok ? adapter.value.mergePullRequest(context, request) : refusal<MergeOutcome>(adapter.error);
  }
}

/* -------------------------------------------------------------------------- */
/* The recorded engine driver                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One recorded answer, and the session that produced it.
 *
 * The answer is the engine's own structured text, verbatim and unparsed: the recorded driver
 * exists to hand the generation path a fixed document, and reading it here would move the
 * validation the domain performs out of the path that performs it (F05-AC5).
 */
export interface RecordedEnginePass {
  readonly sessionId: string;
  readonly answer: string;
}

/**
 * The whole recorded transcript, one answer per read-only pass.
 *
 * Keyed by pass rather than by a queue of answers because a queue would make the second
 * generation of the same pass return a different document for no stated reason, and a
 * recorded engine that changes its mind between two identical requests is a source of
 * differences nobody can account for (F07-AC1).
 */
export interface RecordedEngineTranscript {
  readonly engineVersion: string;
  readonly clarification: RecordedEnginePass;
  readonly plan: RecordedEnginePass;
}

/**
 * Reads and validates a recorded transcript.
 *
 * Every problem is reported at once and names the member it is about, because a transcript is
 * configuration an operator wrote by hand and a refusal that says only "malformed" costs a
 * round trip to find one missing brace (F03-AC1).
 */
export function readRecordedEngineTranscript(raw: string): Result<RecordedEngineTranscript, DomainError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch (error) {
    return err(
      invalid('The recorded engine transcript is not valid JSON.', [
        { path: 'transcript', message: `${error instanceof Error ? error.message : String(error)}` },
      ]),
    );
  }
  const record = typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded) ? (decoded as Record<string, unknown>) : null;
  const problems: { readonly path: string; readonly message: string }[] = [];
  if (record === null) {
    return err(
      invalid('The recorded engine transcript is not an object.', [
        { path: 'transcript', message: 'Expected an object with "engineVersion", "clarification" and "plan".' },
      ]),
    );
  }
  const engineVersion = typeof record['engineVersion'] === 'string' ? record['engineVersion'].trim() : '';
  if (engineVersion.length === 0) {
    problems.push({ path: 'engineVersion', message: 'A recorded run reports which engine produced it.' });
  }
  const passes: RecordedEnginePass[] = [];
  for (const key of ['clarification', 'plan'] as const) {
    const member = typeof record[key] === 'object' && record[key] !== null ? (record[key] as Record<string, unknown>) : null;
    const sessionId = member === null || typeof member['sessionId'] !== 'string' ? '' : member['sessionId'].trim();
    const answer = member === null || typeof member['answer'] !== 'string' ? '' : member['answer'];
    if (member === null) {
      problems.push({ path: key, message: `The recorded transcript needs a "${key}" answer.` });
      continue;
    }
    if (sessionId.length === 0) {
      problems.push({ path: `${key}.sessionId`, message: 'A recorded answer names the session it came from.' });
    }
    if (answer.trim().length === 0) {
      problems.push({ path: `${key}.answer`, message: 'A recorded answer may not be blank.' });
    }
    passes.push({ sessionId, answer });
  }
  if (problems.length > 0) {
    return err(invalid('The recorded engine transcript is not usable.', problems));
  }
  const [clarification, plan] = passes;
  if (clarification === undefined || plan === undefined) {
    return err(
      invalid('The recorded engine transcript is not usable.', [
        { path: 'transcript', message: 'Both a clarification and a plan answer are required.' },
      ]),
    );
  }
  return ok({ engineVersion, clarification, plan });
}

/**
 * Which recorded answer a session asks for.
 *
 * Structural rather than a substring of the prompt: a clarification pass is granted the
 * read-only capabilities and a plan pass is granted none, and `PLAN_ENGINE_CAPABILITIES` is
 * frozen empty precisely so that absence is a fact about the pass. A grant that is neither
 * empty nor wholly read-only is refused, because answering it from a generation transcript
 * would be answering a different request with this document (F07-AC5, F08-AC1).
 */
function recordedPassFor(granted: readonly CodingSessionCapability[], transcript: RecordedEngineTranscript): Result<RecordedEnginePass, DomainError> {
  if (granted.length === 0) return ok(transcript.plan);
  if (deniedCodingCapabilities(granted).length > 0) {
    return err({
      code: 'Forbidden',
      reason: `A recorded engine serves the read-only generation passes only; a session holding ${deniedCodingCapabilities(granted).join(', ')} is not one of them (F03-AC5).`,
    });
  }
  return ok(transcript.clarification);
}

/**
 * An `EngineAdapter` that replays recorded answers instead of contacting a model.
 *
 * It implements the same contract as the shipped `CodexEngineAdapter` and is registered
 * through the same configuration boundary, so the composition root reaches an engine rather
 * than a test double handed to it (N05-AC2). Three things are deliberately structural:
 *
 *   - **The answer is emitted twice, structurally.** Once as a `Progress` summary and once as
 *     the terminal `Succeeded` summary, because the two generation paths read different
 *     channels: the clarification pass reads the terminal outcome and the plan pass reads the
 *     engine's progress text. A driver that filled only one of them would make one of the two
 *     passes unreachable for a reason that has nothing to do with the pass (F07-AC1, F08-AC1).
 *   - **The answer is never parsed here.** Validation is the domain's, and a driver that
 *     accepted an answer the domain would refuse would make the refusal unreachable
 *     (F05-AC5).
 *   - **Nothing is resumed and nothing is stopped.** There is no process to signal and no
 *     rollout to restore, so both are named refusals rather than a fabricated `Stopped` or a
 *     session that pretends to have continued (F15-AC4).
 */
class RecordedEngineAdapter implements EngineAdapter {
  readonly kind = 'Engine' as const;
  readonly connectorId: ConnectorId;
  private readonly transcript: RecordedEngineTranscript;

  constructor(connectorId: ConnectorId, transcript: RecordedEngineTranscript) {
    this.connectorId = connectorId;
    this.transcript = transcript;
  }

  capabilities(): AdapterCapabilities {
    const read = (kind: CapabilityKind): CapabilityDeclaration => ({
      kind,
      supported: kind !== 'Engine:ResumeSession',
      limitation:
        kind === 'Engine:ResumeSession'
          ? 'A recorded answer is a fixed document with no rollout to continue, so a resume is refused rather than answered from the recording (F15-AC4).'
          : null,
      privileged: false,
      supportsPrecondition: false,
    });
    return {
      kind: 'Engine',
      contractVersion: ADAPTER_CONTRACT_VERSION,
      declarations: [read('Engine:VersionCheck'), read('Engine:StartScoped'), read('Engine:StopGraceful')],
    };
  }

  /** States plainly that no model was contacted, because a compatibility answer implies one. */
  async checkCompatibility(context: AdapterContext): Promise<Result<AdapterCompatibility>> {
    return ok({
      kind: 'Engine',
      contractVersion: ADAPTER_CONTRACT_VERSION,
      runtimeVersion: this.transcript.engineVersion,
      compatible: true,
      detail: `This deployment replays recorded answers from ${this.transcript.engineVersion}; no model is contacted, so nothing here proves a model can be reached (F03-AC1).`,
      observedAt: context.clock.now(),
    });
  }

  async startSession(context: AdapterContext, request: Parameters<EngineAdapter['startSession']>[1]): Promise<Result<EngineSessionHandle>> {
    const pass = recordedPassFor(request.grantedCapabilities, this.transcript);
    if (!pass.ok) return pass;
    const startedAt = context.clock.now();
    const sessionId = pass.value.sessionId as ProviderId;
    const events: readonly EngineEvent[] = [
      {
        kind: 'SessionStarted',
        at: startedAt,
        sessionId,
        engineVersion: this.transcript.engineVersion,
        mode: request.mode,
        startedFrom: request.start.kind,
      },
      {
        kind: 'Progress',
        at: context.clock.now(),
        stage: 'SummingUp',
        milestoneKey: null,
        summary: pass.value.answer,
        detail: null,
      },
      {
        kind: 'Result',
        at: context.clock.now(),
        outcome: { kind: 'Succeeded', summary: pass.value.answer },
      },
    ];
    return ok({
      sessionId,
      engineVersion: this.transcript.engineVersion,
      mode: request.mode,
      workspace: request.workspace,
      grantedCapabilities: request.grantedCapabilities,
      startedAt,
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
          for (const event of events) yield event;
        },
      },
    });
  }

  async resumeSession(
    _context: AdapterContext,
    request: ResumeEngineSessionRequest,
  ): Promise<Result<EngineContinuation>> {
    return ok({
      kind: 'ContinuationUnsupported',
      checkpoint: request.checkpoint,
      limitation: `A recorded answer is a fixed document with no rollout to continue, so session ${request.priorSession.sessionId} cannot be resumed (F15-AC4).`,
      requiresFreshSessionFromCheckpoint: true,
    });
  }

  async stopSession(
    context: AdapterContext,
    _request: StopEngineSessionRequest,
  ): Promise<Result<EngineStopOutcome>> {
    return ok({
      kind: 'Stopped',
      stoppedAt: context.clock.now(),
      checkpoint: null,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Registers the providers this process is configured with.
 *
 * The adapters handed back are the shipped ones, built over the injected transport, so what
 * ShipLoop claims to support and what it can perform travel the same code path (N05-AC2).
 * Nothing is resolved eagerly: a process whose credential variable is unset starts and says so
 * at the operation that needed it, rather than refusing to serve at all (F03-AC2).
 */
export function createProviderRegistry(
  configuration: ProviderConfiguration,
  transport: ProviderTransport = {},
): Result<ProviderRegistry, DomainError> {
  const readSecret = transport.readSecret ?? processSecretReader;
  const fetchImpl = transport.fetchImpl ?? globalThis.fetch;

  const gitTransport =
    configuration.git === null
      ? null
      : (transport.gitTransport ?? gitTransportFor(configuration.git));
  if (configuration.git !== null && gitTransport === null) {
    return err(
      invalid('The git provider is configured without a checkout to push from.', [
        {
          path: GIT_WORKTREE_ENV,
          message: `A configured git provider needs ${GIT_WORKTREE_ENV} to name the local checkout it pushes from (F03-AC1).`,
        },
      ]),
    );
  }

  const ticketBinding = configuration.ticket;
  const gitBinding = configuration.git;
  const engineBinding = configuration.engine;

  const ticketAdapter = ticketBinding === null ? null : buildTicketAdapter(ticketBinding, fetchImpl, readSecret);
  const gitAdapter =
    gitBinding === null || gitTransport === null
      ? null
      : buildGitAdapter(gitBinding, fetchImpl, gitTransport, readSecret);
  const engineAdapter = buildEngineAdapter(engineBinding);
  if (!engineAdapter.ok) return err(engineAdapter.error);
  const engine = engineAdapter.value;

  const declarationsFor = (kind: ConnectorKind): readonly CapabilityDeclaration[] => {
    if (kind === 'Ticket') return ticketAdapter?.capabilities().declarations ?? [];
    if (kind === 'Git') return gitAdapter?.capabilities().declarations ?? [];
    if (kind === 'Engine') return engine?.capabilities().declarations ?? [];
    return [];
  };

  const bindingFor = (kind: ConnectorKind, provider?: string): ProviderBinding | null => {
    if (kind === 'Ticket') return matches(ticketBinding, provider) ? ticketBinding : null;
    if (kind === 'Git') return matches(gitBinding, provider) ? gitBinding : null;
    return null;
  };

  const adapters: AdapterRegistry = {
    declarationsFor,
    probeFor(record) {
      const binding = bindingFor(record.kind, record.provider);
      if (binding === null) return null;
      return probeFor(binding, record, fetchImpl, gitTransport, readSecret);
    },
  };

  return ok({
    adapters,
    ticket: ticketAdapter,
    git: gitAdapter,
    engine,
    credentialBlocker: (kind, operation, storedReference) =>
      credentialBlockerFor(bindingFor(kind), operation, storedReference, readSecret),
  });
}

/**
 * The engine this process registered, from the configured driver.
 *
 * An executable driver is the shipped `CodexEngineAdapter`, so a deployment that configures a
 * binary gets the same spawn, sandbox, bounds and event translation a coding run gets; a
 * transcript driver is the recorded adapter above. A transcript that cannot be read or parsed
 * is refused here, at registration, rather than at the first generation the owner asked for:
 * a deployment that cannot answer a model turn should say so while it is still starting
 * (F03-AC1, F03-AC2).
 */
function buildEngineAdapter(binding: EngineBinding | null): Result<EngineAdapter | null, DomainError> {
  if (binding === null) return ok(null);
  if (binding.driver === 'Executable') {
    return ok(new CodexEngineAdapter({ connectorId: binding.connectorId, client: { binary: binding.source } }));
  }

  let raw: string;
  try {
    raw = readFileSync(binding.source, 'utf8');
  } catch (error) {
    return err(
      invalid('The recorded engine transcript could not be read.', [
        {
          path: ENGINE_TRANSCRIPT_ENV,
          message: `${binding.source} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        },
      ]),
    );
  }
  const transcript = readRecordedEngineTranscript(raw);
  if (!transcript.ok) return err(transcript.error);
  return ok(new RecordedEngineAdapter(binding.connectorId, transcript.value));
}

/** This process's own environment, read only where a credential is actually resolved. */
function processSecretReader(variable: string): string | undefined {
  return process.env[variable];
}

/** Whether a stored row belongs to this binding. Provider names are compared case-insensitively. */
function matches(binding: ProviderBinding | null, provider: string | undefined): boolean {
  if (binding === null) return false;
  return provider === undefined || binding.provider === provider.trim().toLowerCase();
}

/** The `git` transport a configured worktree provides; construction spawns nothing. */
function gitTransportFor(binding: ProviderBinding): GitTransport | null {
  if (binding.worktree === null) return null;
  return createGitTransport(binding.worktree);
}

function buildTicketAdapter(
  binding: ProviderBinding,
  fetchImpl: typeof fetch,
  readSecret: ProviderSecretReader,
): TicketAdapter {
  const build = (apiKey: string, transport: typeof fetch): TicketAdapter =>
    new LinearTicketAdapter({
      connectorId: binding.connectorId,
      client: { apiKey, fetchImpl: transport, ...(binding.endpoint === null ? {} : { endpoint: binding.endpoint }) },
    });
  const declarations = build(DECLARATION_ONLY_CREDENTIAL, declarationOnlyFetch).capabilities().declarations;
  return new CredentialScopedTicketAdapter(binding.connectorId, declarations, (operation) => {
    const secret = credentialFor(binding, operation, readSecret);
    return secret.ok ? ok(build(secret.value, fetchImpl)) : secret;
  });
}

function buildGitAdapter(
  binding: ProviderBinding,
  fetchImpl: typeof fetch,
  git: GitTransport,
  readSecret: ProviderSecretReader,
): GitAdapter {
  const build = (token: string, transport: typeof fetch): GitAdapter =>
    new GitHubGitAdapter({
      connectorId: binding.connectorId,
      client: { token, fetchImpl: transport, ...(binding.endpoint === null ? {} : { apiBaseUrl: binding.endpoint }) },
      git,
    });
  const declarations = build(DECLARATION_ONLY_CREDENTIAL, declarationOnlyFetch).capabilities().declarations;
  return new CredentialScopedGitAdapter(binding.connectorId, declarations, (operation) => {
    const secret = credentialFor(binding, operation, readSecret);
    return secret.ok ? ok(build(secret.value, fetchImpl)) : secret;
  });
}

/* -------------------------------------------------------------------------- */
/* Probing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The probe a stored connector is checked with.
 *
 * Only reached when a binding owns the row's kind and provider, so a connector naming a provider
 * this deployment was not configured for is reported as unconfigured rather than contacted with
 * whichever credential the process holds (F03-AC1).
 */
function probeFor(
  binding: ProviderBinding,
  record: ConnectorRecord,
  fetchImpl: typeof fetch,
  gitTransport: GitTransport | null,
  readSecret: ProviderSecretReader,
): ConnectorProbe {
  const kind = record.kind;
  const provider = record.provider;
  const operation = kind === 'Git' ? 'Git:ReadRepository' : `checking the ${record.provider} connector`;

  return {
    kind,
    provider,
    async probe(context: ConnectorProbeContext): Promise<ConnectorProbeObservation> {
      const blocker = credentialBlockerFor(binding, operation, context.credentialReference, readSecret);
      if (blocker !== null) {
        return { accessible: false, state: 'Degraded', error: blockerText(blocker), declarations: null };
      }
      const verdict =
        kind === 'Git' && gitTransport !== null
          ? await checkGit(binding, record, context, fetchImpl, gitTransport, readSecret)
          : await checkTicket(binding, context, fetchImpl, readSecret);
      if (!verdict.ok) {
        return { accessible: false, state: 'Unreachable', error: secretFreeReason(verdict.error.reason), declarations: null };
      }
      if (!verdict.value.compatible) {
        return { accessible: false, state: 'Degraded', error: secretFreeReason(verdict.value.detail), declarations: null };
      }
      return { accessible: true, state: 'Healthy', error: null, declarations: verdict.value.declarations };
    },
  };
}

/** A compatibility verdict carrying the declarations observed alongside it. */
interface ObservedCompatibility {
  readonly compatible: boolean;
  readonly detail: string;
  readonly declarations: readonly CapabilityDeclaration[];
}

/**
 * What the ticket provider reports about the credential (F03-AC1, F03-AC2).
 *
 * `declarations` is null whenever the provider could not be asked, which keeps the set recorded
 * at registration rather than replacing it with something the provider never said.
 */
async function checkTicket(
  binding: ProviderBinding,
  context: ConnectorProbeContext,
  fetchImpl: typeof fetch,
  readSecret: ProviderSecretReader,
): Promise<Result<ObservedCompatibility>> {
  const secret = credentialFor(binding, 'checking access', readSecret);
  if (!secret.ok) return secret;
  const adapter = new LinearTicketAdapter({
    connectorId: binding.connectorId,
    client: {
      apiKey: secret.value,
      fetchImpl,
      ...(binding.endpoint === null ? {} : { endpoint: binding.endpoint }),
    },
  });
  const verdict = await adapter.checkCompatibility(probeContext(context));
  if (!verdict.ok) return verdict;
  return ok({
    compatible: verdict.value.compatible,
    detail: verdict.value.detail,
    declarations: adapter.capabilities().declarations,
  });
}

/**
 * What the git provider reports about the stored repository (F03-AC2, F11-AC3).
 *
 * The repository named by the connector's resource scope is read rather than assumed, so the
 * credential is only called compatible once the provider itself confirms it can reach it.
 */
async function checkGit(
  binding: ProviderBinding,
  record: ConnectorRecord,
  context: ConnectorProbeContext,
  fetchImpl: typeof fetch,
  gitTransport: GitTransport,
  readSecret: ProviderSecretReader,
): Promise<Result<ObservedCompatibility>> {
  const secret = credentialFor(binding, 'Git:ReadRepository', readSecret);
  if (!secret.ok) return secret;
  const adapter = new GitHubGitAdapter({
    connectorId: binding.connectorId,
    client: {
      token: secret.value,
      fetchImpl,
      ...(binding.endpoint === null ? {} : { apiBaseUrl: binding.endpoint }),
    },
    git: gitTransport,
  });
  const verdict = await adapter.checkCompatibility(probeContext(context), repositoryFromScope(record));
  if (!verdict.ok) return verdict;
  return ok({
    compatible: verdict.value.compatible,
    detail: verdict.value.detail,
    declarations: adapter.capabilities().declarations,
  });
}

/**
 * The repository a Git connector row names.
 *
 * `owner/name`, which is what the shipped adapter's REST paths are built from. A row naming
 * anything else is passed through unchanged so the adapter refuses it by name rather than this
 * module guessing at a repository (F11-AC3).
 */
function repositoryFromScope(record: ConnectorRecord): GitRepositoryRef {
  return {
    provider: record.provider,
    fullName: record.resourceScope.trim(),
    defaultBranch: '',
    url: '',
  };
}

/**
 * The ambient facts a probe hands an adapter.
 *
 * The clock is the caller's `now` rather than the wall clock, so a recorded check time is the
 * time the caller asked for, and every string the adapter produces is redacted on the way out
 * (N02-AC2).
 */
function probeContext(context: ConnectorProbeContext): AdapterContext {
  return {
    correlationId: `connector:${context.connectorId}`,
    operationId: `connector-probe:${context.connectorId}` as OperationId,
    clock: { now: () => context.now, elapsedMs: () => 0 },
    logger: { emit: () => undefined },
    signal: new AbortController().signal,
    redact: (text: string): string => redact(text).text,
  };
}