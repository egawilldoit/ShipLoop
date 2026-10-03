/**
 * In-memory fakes for the provider adapter contracts.
 *
 * These fakes implement `TicketAdapter`, `GitAdapter`, `DeploymentAdapter`,
 * `EngineAdapter` and `VerificationAdapter` from `../contracts` by import. A
 * locally declared copy of a contract would be worth nothing: it would still
 * compile after the contract changed, so a contract case could pass against a
 * shape the real provider no longer speaks.
 *
 * They are fakes, not a live integration. They exist so ordering, rate limits,
 * timeouts and ambiguous results can be reproduced on demand (mvp-spec 9, "Use
 * provider simulators for ordering, rate limits, timeouts, and ambiguous
 * results"). A suite that passes here proves the adapter's contract logic, never
 * the provider's live compatibility.
 *
 * Why the behaviour is what it is:
 *
 *   - Writes carry an operation identity and are deduplicated against a ledger,
 *     so a replayed request provably produces one side effect (F30-AC2, F10-AC3).
 *   - A lost response is recorded as a real side effect with an unknown outcome,
 *     so reconciliation has something to reconcile (F28-AC4, F30-AC5).
 *   - Unsupported capabilities are refused with `Unavailable` before any work,
 *     and an unsupported continuation falls back to a checkpoint instead of
 *     faking a restored session (N05-AC2, F15-AC4).
 *   - Every call is counted by the fake's own base class, so a contract case can
 *     assert an adapter did not retry a deterministic failure (F03-AC4, F30-AC4).
 *     The count lives on the fake rather than on the contract because "how many
 *     times were you called" is not part of a provider's surface.
 */

import {
  capabilitiesFor,
  conflict,
  deriveReadiness,
  err,
  fingerprint,
  isCommitSha,
  ok,
  outcomeUnknown,
  type CapabilityDeclaration,
  type CapabilityKind,
  type CommitSha,
  type ConnectorHealth,
  type ConnectorId,
  type CriterionEvidence,
  type CriterionStatus,
  type DomainError,
  type ForbiddenError,
  type NotFoundError,
  type OperationId,
  type ProviderId,
  type RateLimitedError,
  type ReadinessFinding,
  type ReadinessStatus,
  type Result,
  type ScopeSnapshot,
  type UnavailableError,
} from '@shiploop/domain';
import {
  ADAPTER_CONTRACT_VERSION,
  deniedCodingCapabilities,
  type AdapterCapabilities,
  type AdapterCompatibility,
  type AdapterContext,
  type AdapterKind,
  type ApiExchangeSpec,
  type ApiExchangeOutcome,
  type ArtifactReference,
  type BrowserFlowSpec,
  type BrowserOutcome,
  type CandidateGitPort,
  type CheckCompletion,
  type CheckExecutionRecord,
  type CheckExecutionRequest,
  type CodingSessionCapability,
  type CollectEvidenceRequest,
  type ComponentFailure,
  type CriterionObservation,
  type DeclareNoCodeOutcomeRequest,
  type DeploymentAdapter,
  type DeploymentAvailability,
  type DeploymentDiscovery,
  type DeploymentExecutionOutcome,
  type DeploymentIdentityRead,
  type DescribeTransitionsRequest,
  type DestinationVerification,
  type DiscoverDeploymentRequest,
  type DraftRef,
  type EngineAdapter,
  type EngineContinuation,
  type EngineDiagnosticCategory,
  type EngineEvent,
  type EngineSessionHandle,
  type EngineSessionStart,
  type EngineStage,
  type EngineStartRequest,
  type EngineStopOutcome,
  type EngineUsage,
  type EvidenceBundle,
  type ExecutionWorkspace,
  type FindDraftsRequest,
  type GitAdapter,
  type GitRepositoryRef,
  type GitStateRead,
  type LinkedPullRequestFacts,
  type ReadLinkedPullRequestRequest,
  type ManagedProgressOutcome,
  type ManagedProgressUpdateRequest,
  type MapCriteriaRequest,
  type MergeOutcome,
  type MergePullRequestRequest,
  type NoCodeOutcomeRecord,
  type PermittedDeliveryAction,
  type PreflightRequest,
  type PreflightReport,
  type ProposalRevision,
  type ProviderCheckObservation,
  type PublishedIssue,
  type PublishWorkOutcome,
  type PublishWorkRequest,
  type PushBranchOutcome,
  type PushBranchRequest,
  type ReadChecksRequest,
  type ReadDeploymentIdentityRequest,
  type ReadGitStateRequest,
  type ReadTicketScopeRequest,
  type RelatedIssue,
  type RelatedIssueSearchRequest,
  type ResumeEngineSessionRequest,
  type SmokeObservation,
  type SmokeResult,
  type StopEngineSessionRequest,
  type TicketAdapter,
  type TicketScopeRead,
  type TicketTransitionDescriptor,
  type TicketTransitionOutcome,
  type TicketTransitionRequest,
  type UpsertDraftOutcome,
  type UpsertDraftRequest,
  type VerificationAdapter,
  type VerifiedComponentIdentity,
  type VerifyDestinationRequest,
} from '../contracts/index.ts';
import {
  FIXED_EARLIER_INSTANT,
  FIXTURE_BASE_SHA,
  FIXTURE_CHECK_OBSERVATIONS,
  FIXTURE_DEPLOYMENT_CONNECTOR,
  FIXTURE_DEPLOYMENT_PROVIDER,
  FIXTURE_ENGINE_CONNECTOR,
  FIXTURE_ENGINE_EVENT_LINES,
  FIXTURE_ENGINE_PROVIDER,
  FIXTURE_ENGINE_VERSION,
  FIXTURE_GIT_CONNECTOR,
  FIXTURE_GIT_PROVIDER,
  FIXTURE_HEAD_SHA,
  FIXTURE_MERGE_COMMIT_SHA,
  FIXTURE_REPOSITORY,
  FIXTURE_REPOSITORY_FULL_NAME,
  FIXTURE_SUPERSEDED_HEAD_SHA,
  FIXTURE_TICKET_CONNECTOR,
  FIXTURE_TICKET_PROVIDER,
  FIXTURE_TICKET_RELATED,
  FIXTURE_TICKET_SCOPE_READ,
  FIXTURE_TICKET_TRANSITIONS,
  FIXTURE_VERIFICATION_CONNECTOR,
  FIXTURE_VERIFICATION_PROVIDER,
  accessObservationFor,
  availabilityStateFor,
  fixtureAvailabilityIdentities,
  providerId,
  type ProviderEvent,
} from './fixtures.ts';

const FAKE_OBSERVED_AT = '2026-09-30T12:05:00.000Z';
const FAKE_LAST_SUCCESS_AT = '2026-09-30T12:04:00.000Z';

function unavailable(reason: string): UnavailableError {
  return { code: 'Unavailable', reason };
}

function forbidden(reason: string): ForbiddenError {
  return { code: 'Forbidden', reason };
}

function absent(reason: string): NotFoundError {
  return { code: 'NotFound', reason };
}

function rateLimited(reason: string, retryAfterMs: number | null): RateLimitedError {
  return { code: 'RateLimited', reason, retryAfterMs };
}

/**
 * Every engine stage the contract declares, as a membership test.
 *
 * The contract types `EngineStage` but publishes no list of it, and the native
 * event parser needs a runtime set. A `Record` over the union means a stage added
 * to the contract without a parser case is a compile error rather than a line the
 * parser quietly rejects.
 */
const ENGINE_STAGE_MEMBERS: Readonly<Record<EngineStage, true>> = {
  Preparing: true,
  ReadingInstructions: true,
  Planning: true,
  Implementing: true,
  RunningChecks: true,
  PreparingDraft: true,
  SummingUp: true,
};

const DIAGNOSTIC_CATEGORIES: Readonly<Record<EngineDiagnosticCategory, true>> = {
  MalformedOutput: true,
  MissingAuthentication: true,
  UnavailableModel: true,
  QuotaExhausted: true,
  UnsupportedRuntime: true,
  ToolError: true,
  NetworkError: true,
  SandboxDenial: true,
};

function isEngineStage(value: string): value is EngineStage {
  return Object.hasOwn(ENGINE_STAGE_MEMBERS, value);
}

function isDiagnosticCategory(value: string): value is EngineDiagnosticCategory {
  return Object.hasOwn(DIAGNOSTIC_CATEGORIES, value);
}

/* -------------------------------------------------------------------------- */
/* Side effects                                                                */
/* -------------------------------------------------------------------------- */

/** An external side effect the fake performed, so a case can prove it happened once. */
export interface SideEffect {
  readonly operationId: string;
  readonly operation: string;
  readonly target: string;
  readonly outcome: 'Succeeded' | 'OutcomeUnknown';
  readonly externalId: string | null;
  readonly occurredAt: string;
}

/**
 * Append-only record of the external side effects the fakes actually performed.
 *
 * It does not deduplicate. A duplicate write must show up as two entries so a
 * contract case can observe it; making the record tidy would hide the very bug
 * the assertion exists to catch.
 */
export class SideEffectLedger {
  private readonly recorded: SideEffect[] = [];

  record(effect: SideEffect): SideEffect {
    this.recorded.push(effect);
    return effect;
  }

  entries(): readonly SideEffect[] {
    return [...this.recorded];
  }

  find(operationId: string): SideEffect | undefined {
    return this.recorded.find((effect) => effect.operationId === operationId);
  }

  effectsFor(operationId: string): readonly SideEffect[] {
    return this.recorded.filter((effect) => effect.operationId === operationId);
  }

  count(): number {
    return this.recorded.length;
  }
}

/* -------------------------------------------------------------------------- */
/* Induced provider conditions                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How a test induces provider conditions.
 *
 * These ports exist because the required behaviours are the ones a happy-path
 * fake cannot demonstrate: a lost response, a rate limit with its retry hint, a
 * revoked credential, per-component delivery outcomes, and the profile decision
 * that approves a check as not applicable.
 */
export interface AdapterConditions {
  /** Make the next `count` external writes perform their side effect, then lose the response. */
  loseNextWriteResponse(count: number): void;
  /** Make the next `count` calls fail with the provider's rate-limit category. */
  rateLimitNextCall(count: number, retryAfterMs: number | null): void;
  /** Revoke a connector's access as the provider or an operator would. */
  revokeAccess(connectorId: ConnectorId, error: string): void;
  /** Set the state each component reaches after the next delivery execution. */
  programComponentOutcomes(states: Readonly<Record<string, DeploymentAvailability['kind']>>): void;
  /**
   * Record the project profile's decision that named checks are not applicable.
   *
   * `CheckExecutionRequest` carries no approval field, so whoever owns the
   * profile has to inject the decision. Only that decision may produce a
   * `NotApplicable` completion (F20-AC5).
   */
  approveNotApplicable(checks: readonly string[]): void;
}

type RateLimitDecision =
  | { readonly limited: false }
  | { readonly limited: true; readonly retryAfterMs: number | null };

export class FakeConditions implements AdapterConditions {
  private lostResponseBudget = 0;
  private rateLimitBudget = 0;
  private retryAfterMs: number | null = null;
  private readonly revoked = new Map<string, string>();
  private readonly notApplicableApprovals = new Set<string>();
  private componentOutcomes: Readonly<Record<string, DeploymentAvailability['kind']>> = {};

  loseNextWriteResponse(count: number): void {
    this.lostResponseBudget = count;
  }

  rateLimitNextCall(count: number, retryAfterMs: number | null): void {
    this.rateLimitBudget = count;
    this.retryAfterMs = retryAfterMs;
  }

  revokeAccess(connectorId: ConnectorId, error: string): void {
    this.revoked.set(connectorId, error);
  }

  programComponentOutcomes(states: Readonly<Record<string, DeploymentAvailability['kind']>>): void {
    this.componentOutcomes = states;
  }

  approveNotApplicable(checks: readonly string[]): void {
    for (const check of checks) this.notApplicableApprovals.add(check);
  }

  consumeLostResponse(): boolean {
    if (this.lostResponseBudget <= 0) return false;
    this.lostResponseBudget -= 1;
    return true;
  }

  consumeRateLimit(): RateLimitDecision {
    if (this.rateLimitBudget <= 0) return { limited: false };
    this.rateLimitBudget -= 1;
    return { limited: true, retryAfterMs: this.retryAfterMs };
  }

  accessError(connectorId: ConnectorId): string | null {
    return this.revoked.get(connectorId) ?? null;
  }

  componentState(component: string): DeploymentAvailability['kind'] {
    return this.componentOutcomes[component] ?? 'Usable';
  }

  approvesNotApplicable(check: string): boolean {
    return this.notApplicableApprovals.has(check);
  }
}

/* -------------------------------------------------------------------------- */
/* Shared base                                                                 */
/* -------------------------------------------------------------------------- */

export interface WriteIntent {
  readonly operationId: OperationId;
  readonly target: string;
  readonly operation: string;
}

export interface FakeAdapterInit {
  readonly connectorId: ConnectorId;
  readonly provider: string;
  readonly kind: AdapterKind;
  readonly runtimeVersion: string;
  readonly declarations: readonly CapabilityDeclaration[];
  readonly ledger: SideEffectLedger;
  readonly conditions: FakeConditions;
}

function declaration(
  kind: CapabilityKind,
  supported: boolean,
  privileged: boolean,
  supportsPrecondition: boolean,
  limitation: string | null,
): CapabilityDeclaration {
  return { kind, supported, limitation, privileged, supportsPrecondition };
}

/**
 * What every fake owes the controller beyond its own contract.
 *
 * `capabilities()` and `checkCompatibility()` are the contract's identity
 * surface. The rest is test support: the connector health the owner UI shows and
 * the attempt count that makes "did not blindly retry" observable. None of it
 * extends the contract, because none of it is part of a provider's surface.
 */
export class FakeAdapterBase {
  readonly connectorId: ConnectorId;
  readonly provider: string;
  readonly kind: AdapterKind;
  readonly runtimeVersion: string;
  protected readonly ledger: SideEffectLedger;
  protected readonly conditions: FakeConditions;
  private readonly declared: readonly CapabilityDeclaration[];
  private readonly attemptsByOperation = new Map<string, number>();

  constructor(init: FakeAdapterInit) {
    this.connectorId = init.connectorId;
    this.provider = init.provider;
    this.kind = init.kind;
    this.runtimeVersion = init.runtimeVersion;
    this.declared = init.declarations;
    this.ledger = init.ledger;
    this.conditions = init.conditions;
  }

  capabilities(): AdapterCapabilities {
    return { kind: this.kind, contractVersion: ADAPTER_CONTRACT_VERSION, declarations: this.declared };
  }

  async checkCompatibility(context: AdapterContext): Promise<Result<AdapterCompatibility>> {
    const health = this.health();
    return ok({
      kind: this.kind,
      contractVersion: ADAPTER_CONTRACT_VERSION,
      runtimeVersion: this.runtimeVersion,
      compatible: health.state === 'Healthy',
      detail: health.error ?? `The ${this.provider} connector reported no access error.`,
      observedAt: context.clock.now(),
    });
  }

  /** `Unavailable` when the operation is not supported, before any work is attempted. */
  ensureSupported(kind: CapabilityKind): Result<void, DomainError> {
    const declaration = this.declared.find((entry) => entry.kind === kind);
    if (declaration === undefined) {
      return err(
        unavailable(`${this.provider} does not declare ${kind}, so the controller must not attempt it.`),
      );
    }
    if (!declaration.supported) {
      return err(
        unavailable(
          `${kind} is unavailable on ${this.provider}: ${declaration.limitation ?? 'the provider does not offer it'}.`,
        ),
      );
    }
    return ok(undefined);
  }

  health(): ConnectorHealth {
    const summary = capabilitiesFor(this.declared);
    const revoked = this.conditions.accessError(this.connectorId);
    return {
      connectorId: this.connectorId,
      provider: this.provider,
      state: revoked === null ? 'Healthy' : 'Revoked',
      reads: summary.reads,
      writes: summary.writes,
      lastCheckedAt: FAKE_OBSERVED_AT,
      lastSuccessAt: revoked === null ? FAKE_OBSERVED_AT : FAKE_LAST_SUCCESS_AT,
      error: revoked,
    };
  }

  /** How many times the fake was asked to perform an operation, for retry assertions. */
  attempts(operation: string): number {
    return this.attemptsByOperation.get(operation) ?? 0;
  }

  protected countAttempt(operation: string): void {
    this.attemptsByOperation.set(operation, this.attempts(operation) + 1);
  }

  /** Whether a prior attempt for this operation identity already performed its write. */
  protected alreadyPerformed(intent: WriteIntent): boolean {
    return this.ledger.find(intent.operationId)?.outcome === 'Succeeded';
  }

  /**
   * The shared gate: attempt count, capability refusal, access, rate limit, then
   * the action.
   *
   * A revoked credential and a rate limit are returned once, with their own
   * category and retry hint, rather than retried locally (F03-AC4, F30-AC4). A
   * null capability means the domain's `CapabilityKind` has no member for the
   * operation, so there is no declaration to check it against.
   */
  protected gated<T>(
    capability: CapabilityKind | null,
    operation: string,
    action: () => Result<T, DomainError>,
  ): Result<T, DomainError> {
    this.countAttempt(operation);
    if (capability !== null) {
      const supported = this.ensureSupported(capability);
      if (!supported.ok) return supported;
    }
    const revoked = this.conditions.accessError(this.connectorId);
    if (revoked !== null) return err(forbidden(revoked));
    const limit = this.conditions.consumeRateLimit();
    if (limit.limited) {
      return err(
        rateLimited(
          `${this.provider} rate limited ${operation}. The provider supplied no retry hint.`,
          limit.retryAfterMs,
        ),
      );
    }
    return action();
  }

  /**
   * Returns the value of a prior identical write, or `OutcomeUnknown` after a
   * lost response, so a repeated request can never reach the provider twice.
   *
   * The provider identity is minted before the lost-response check because the
   * provider assigned it even when the response never arrived; reconciliation
   * needs it to establish what happened (F19-AC3, F30-AC5).
   */
  protected replayOrRun<T>(
    completed: Map<string, T>,
    intent: WriteIntent,
    mintExternalId: () => ProviderId,
    produce: (externalId: ProviderId) => T,
  ): Result<T, DomainError> {
    const recorded = this.ledger.find(intent.operationId);
    if (recorded !== undefined) {
      const prior = completed.get(intent.operationId);
      if (recorded.outcome === 'Succeeded' && prior !== undefined) return ok(prior);
      return err(this.reconcileFirstError(intent));
    }
    const externalId = mintExternalId();
    if (this.conditions.consumeLostResponse()) return this.lostResponse<T>(intent, externalId);
    const value = produce(externalId);
    completed.set(intent.operationId, value);
    this.recordWrite(intent, externalId);
    return ok(value);
  }

  /** Records a write that completed and returned. */
  protected recordWrite(intent: WriteIntent, externalId: ProviderId): void {
    this.ledger.record({
      operationId: intent.operationId,
      operation: intent.operation,
      target: intent.target,
      outcome: 'Succeeded',
      externalId,
      occurredAt: FAKE_OBSERVED_AT,
    });
  }

  /** Records the write that already happened and reports the ambiguity honestly. */
  protected lostResponse<T>(intent: WriteIntent, externalId: ProviderId): Result<T, DomainError> {
    this.ledger.record({
      operationId: intent.operationId,
      operation: intent.operation,
      target: intent.target,
      outcome: 'OutcomeUnknown',
      externalId,
      occurredAt: FAKE_OBSERVED_AT,
    });
    return err(
      outcomeUnknown(
        `The ${intent.operation} request was sent and its response was lost. Whether it took effect is unknown until provider state is read.`,
        intent.operationId,
        intent.target,
      ),
    );
  }

  /** A blind retry over an unreconciled write could duplicate it, so it is refused. */
  protected reconcileFirstError(intent: WriteIntent): DomainError {
    return outcomeUnknown(
      `A previous attempt for ${intent.operation} lost its response. Reconcile provider state before retrying.`,
      intent.operationId,
      intent.target,
    );
  }

  /**
   * Refuses an identity another provider owns.
   *
   * A similarly named repository or issue belonging to someone else is never
   * substituted: guessing one is how the wrong code or the wrong issue gets
   * accepted (F11-AC3, N05-AC2).
   */
  protected refuseForeignProvider(kind: AdapterKind, id: string, owner: string): ForbiddenError | null {
    if (owner === this.provider) return null;
    return forbidden(
      `${this.provider} does not own ${kind} identity ${id}; it belongs to ${owner}. A similarly named resource is not a substitute.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Ticket                                                                      */
/* -------------------------------------------------------------------------- */

/** The snapshot a published issue carries, derived from the proposal it published. */
function scopeSnapshotFor(
  revision: ProposalRevision,
  issueId: string,
  retrievedAt: string,
): ScopeSnapshot {
  return {
    workItemId: revision.workItemId,
    issueId,
    issueIdentifier: `${revision.targetTeamKey}-${revision.revision}`,
    title: revision.title,
    description: revision.description,
    providerRevision: null,
    priority: null,
    dependencyIssueIds: revision.dependencyIssueIds,
    acceptanceCriteria: revision.criteria,
    retrievedAt,
  };
}

export class FakeTicketAdapter extends FakeAdapterBase implements TicketAdapter {
  override readonly kind = 'Ticket';

  private readonly ownedIssueIds: Map<ProviderId, TicketScopeRead>;
  private readonly issuesOwnedElsewhere: ReadonlyMap<ProviderId, string>;
  private readonly related: readonly RelatedIssue[];
  private readonly transitions: readonly TicketTransitionDescriptor[];
  private readonly published = new Map<string, PublishedIssue>();
  private readonly progress = new Map<string, ManagedProgressOutcome>();
  private readonly lastMilestone = new Map<ProviderId, string>();
  private publishedCounter = 0;

  constructor(
    init: FakeAdapterInit,
    owned: readonly TicketScopeRead[],
    issuesOwnedElsewhere: ReadonlyMap<ProviderId, string>,
    related: readonly RelatedIssue[],
    transitions: readonly TicketTransitionDescriptor[],
  ) {
    super(init);
    this.ownedIssueIds = new Map(owned.map((read) => [read.issue.issueId, read]));
    this.issuesOwnedElsewhere = issuesOwnedElsewhere;
    this.related = related;
    this.transitions = transitions;
  }

  async readScope(context: AdapterContext, request: ReadTicketScopeRequest): Promise<Result<TicketScopeRead>> {
    return this.gated<TicketScopeRead>('Ticket:ReadScope', 'readScope', () => {
      const foreign = this.refuseIssue(request.issueId);
      if (foreign !== null) return err(foreign);
      const read = this.ownedIssueIds.get(request.issueId);
      if (read === undefined) return err(absent(`${this.provider} has no issue ${request.issueId}.`));
      return ok({ ...read, observedAt: context.clock.now() });
    });
  }

  /**
   * Surfaces related work for the owner to decide.
   *
   * There is no auto-adopt variant in the contract, and the adapter never merges
   * resemblance into a decision (F06-AC4).
   */
  async findRelatedIssues(
    _context: AdapterContext,
    request: RelatedIssueSearchRequest,
  ): Promise<Result<readonly RelatedIssue[]>> {
    return this.gated<readonly RelatedIssue[]>('Ticket:ReadScope', 'findRelatedIssues', () =>
      ok(this.related.slice(0, request.limit)),
    );
  }

  async publishWork(context: AdapterContext, request: PublishWorkRequest): Promise<Result<PublishWorkOutcome>> {
    return this.gated<PublishWorkOutcome>('Ticket:PublishIssue', 'publishWork', () => {
      const adopted = request.adoptExistingIssueId;
      if (adopted !== null) {
        const foreign = this.refuseIssue(adopted);
        if (foreign !== null) return err(foreign);
        return ok({
          kind: 'AdoptedExisting',
          published: [
            {
              issue: this.issueRef(adopted, request.revision),
              disposition: 'AlreadyPresent',
              snapshot: scopeSnapshotFor(request.revision, adopted, context.clock.now()),
            },
          ],
        });
      }
      const intent: WriteIntent = {
        operationId: request.operationId,
        target: `${this.provider}:${request.revision.targetTeamKey}`,
        operation: 'publishWork',
      };
      const replayed = this.alreadyPerformed(intent);
      const result = this.replayOrRun(
        this.published,
        intent,
        () => this.nextPublishedIssueId(request.revision.targetTeamKey),
        (issueId) => ({
          issue: this.issueRef(issueId, request.revision),
          disposition: 'CreatedNew',
          snapshot: scopeSnapshotFor(request.revision, issueId, context.clock.now()),
        }),
      );
      if (!result.ok) return result;
      // A repeat of the same operation identity reports the issue as already
      // present rather than creating a second one (F10-AC3).
      return ok({
        kind: 'Published',
        published: [{ ...result.value, disposition: replayed ? 'AlreadyPresent' : 'CreatedNew' }],
      });
    });
  }

  /**
   * Delivers one milestone to the managed region.
   *
   * The provider's comment identity is minted once per operation and reported in
   * the region, so a replay provably names the same comment rather than a second
   * one (F16-AC3).
   */
  async updateManagedProgress(
    context: AdapterContext,
    request: ManagedProgressUpdateRequest,
  ): Promise<Result<ManagedProgressOutcome>> {
    return this.gated<ManagedProgressOutcome>('Ticket:UpdateManagedProgress', 'updateManagedProgress', () => {
      const foreign = this.refuseIssue(request.issueId);
      if (foreign !== null) return err(foreign);
      const intent: WriteIntent = {
        operationId: request.operationId,
        target: request.issueId,
        operation: 'updateManagedProgress',
      };
      const replayed = this.alreadyPerformed(intent);
      const previousMilestoneKey = this.lastMilestone.get(request.issueId) ?? null;
      const result = this.replayOrRun(
        this.progress,
        intent,
        () => providerId(`comment_${request.operationId}`),
        (commentId): ManagedProgressOutcome => ({
          kind: 'Updated',
          region: { kind: 'UpdatableComment', commentId },
          previousMilestoneKey,
          deliveredAt: context.clock.now(),
        }),
      );
      if (!result.ok) return result;
      if (replayed) {
        return ok({
          kind: 'Unchanged',
          region: result.value.region,
          deliveredMilestoneKey: request.milestoneKey,
          deliveredAt: result.value.deliveredAt,
        });
      }
      this.lastMilestone.set(request.issueId, request.milestoneKey);
      return ok(result.value);
    });
  }

  async describeTransitions(
    _context: AdapterContext,
    request: DescribeTransitionsRequest,
  ): Promise<Result<readonly TicketTransitionDescriptor[]>> {
    return this.gated<readonly TicketTransitionDescriptor[]>('Ticket:ReadScope', 'describeTransitions', () => {
      const foreign = this.refuseIssue(request.issueId);
      if (foreign !== null) return err(foreign);
      return ok(this.ownedIssueIds.has(request.issueId) ? this.transitions : []);
    });
  }

  /**
   * Refused rather than faked.
   *
   * The provider's agent API is a Developer Preview, so ShipLoop reports the
   * limitation instead of claiming a transition it cannot perform. The owner sets
   * the state; `describeTransitions` is what ShipLoop offers instead.
   */
  async requestTransition(
    _context: AdapterContext,
    _request: TicketTransitionRequest,
  ): Promise<Result<TicketTransitionOutcome>> {
    return this.gated<TicketTransitionOutcome>('Ticket:RequestTransition', 'requestTransition', () =>
      err(
        unavailable(
          `${this.provider} agent sessions are a Developer Preview, so ShipLoop cannot request a ticket transition through it. The owner changes the state in ${this.provider}.`,
        ),
      ),
    );
  }

  private refuseIssue(issueId: ProviderId): ForbiddenError | null {
    const owner = this.issuesOwnedElsewhere.get(issueId);
    if (owner === undefined) return null;
    return forbidden(
      `${this.provider} does not own issue identity ${issueId}; it is a ${owner} resource. A similarly named identity is not a substitute.`,
    );
  }

  private issueRef(issueId: ProviderId, revision: ProposalRevision): PublishedIssue['issue'] {
    return {
      issueId,
      identifier: `${revision.targetTeamKey}-${revision.revision}`,
      url: `https://tickets.fixture.invalid/${revision.targetTeamKey}/${issueId}`,
    };
  }

  private nextPublishedIssueId(teamKey: string): ProviderId {
    this.publishedCounter += 1;
    return providerId(`issue_${teamKey}_${this.publishedCounter}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Git                                                                         */
/* -------------------------------------------------------------------------- */

function bodyDigest(body: UpsertDraftRequest['body']): string {
  return fingerprint({ body });
}

function sameLink(left: DraftRef['link'], right: DraftRef['link']): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'None' || right.kind === 'None') return true;
  return left.issue.issueId === right.issue.issueId;
}

function requirementFor(name: string, requiredCheckNames: readonly string[]): ProviderCheckObservation['requirement'] {
  return requiredCheckNames.includes(name) ? 'ProfileRequired' : 'ProviderExtra';
}

/**
 * What a scripted `readLinkedPullRequest` reports for one pull request.
 *
 * Both commit SHAs are `CommitSha`, so an abbreviation cannot be scripted by accident; the
 * adapter re-checks at the read anyway, because the point of a fake is to be able to hand a
 * caller a payload the real adapter would refuse.
 */
export interface FakeLinkedPullRequest {
  readonly number: number;
  readonly state: 'Open' | 'Closed' | 'Merged';
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly draft: boolean;
  /** Absent means "the head is in this repository", which is the common case. */
  readonly headRepository?: string | null;
  readonly mergedSha?: CommitSha | null;
}

export class FakeGitAdapter extends FakeAdapterBase implements GitAdapter {
  override readonly kind = 'Git';

  private readonly repository: GitRepositoryRef;
  private readonly observations: readonly ProviderCheckObservation[];
  private readonly reviews: GitStateRead['reviews'];
  private readonly drafts = new Map<ProviderId, DraftRef>();
  private readonly completedDrafts = new Map<string, DraftRef>();
  private readonly completedPushes = new Map<string, PushBranchOutcome>();
  private readonly completedMerges = new Map<string, MergeOutcome>();
  private readonly noCodeDeclarations = new Map<string, NoCodeOutcomeRecord>();
  private head: CommitSha;
  private readonly base: CommitSha;
  private draftCount = 0;

  constructor(
    init: FakeAdapterInit,
    repository: GitRepositoryRef,
    headSha: CommitSha,
    baseSha: CommitSha,
    observations: readonly ProviderCheckObservation[],
    reviews: GitStateRead['reviews'],
  ) {
    super(init);
    this.repository = repository;
    this.head = headSha;
    this.base = baseSha;
    this.observations = observations;
    this.reviews = reviews;
  }

  async readState(context: AdapterContext, request: ReadGitStateRequest): Promise<Result<GitStateRead>> {
    return this.gated<GitStateRead>('Git:ReadRepository', 'readState', () => {
      const foreign = this.refuseRepository(request.repository);
      if (foreign !== null) return err(foreign);
      if (request.repository.fullName !== this.repository.fullName) {
        return err(absent(`${this.provider} has no repository ${request.repository.fullName}.`));
      }
      return ok({
        repository: this.repository,
        head: { kind: 'Branch', name: request.branch, sha: this.head },
        base: { kind: 'Branch', name: request.baseBranch, sha: this.base },
        pullRequest: this.latestPullRequest(),
        reviews: this.reviews,
        observedAt: context.clock.now(),
      });
    });
  }

  /**
   * Reports every observed check and the required ones the provider never ran.
   *
   * `requirement` is re-derived from the caller's list on every read, because
   * only the controller knows what the project profile requires. A required name
   * with no reported run comes back `Missing`, never `Passed` (F20-AC2, F20-AC5).
   */
  async readChecks(
    _context: AdapterContext,
    request: ReadChecksRequest,
  ): Promise<Result<readonly ProviderCheckObservation[]>> {
    return this.gated<readonly ProviderCheckObservation[]>('Git:ReadChecks', 'readChecks', () => {
      const foreign = this.refuseRepository(request.repository);
      if (foreign !== null) return err(foreign);
      if (request.headSha !== this.head) {
        return err(absent(`The provider reports no check results for head ${request.headSha.slice(0, 12)}.`));
      }
      const reported = this.observations.map((observation) => ({
        ...observation,
        requirement: requirementFor(observation.name, request.requiredCheckNames),
      }));
      const reportedNames = new Set(reported.map((observation) => observation.name));
      const unreported = request.requiredCheckNames
        .filter((name) => !reportedNames.has(name))
        .map(
          (name): ProviderCheckObservation => ({
            checkId: `check_missing_${name}`,
            name,
            result: 'Missing',
            requirement: 'ProfileRequired',
            startedAt: null,
            endedAt: null,
            exitCode: null,
            detail: `The project profile requires "${name}" and the provider reported no run for it.`,
            artifactUrl: null,
          }),
        );
      return ok([...reported, ...unreported]);
    });
  }

  async pushBranch(_context: AdapterContext, request: PushBranchRequest): Promise<Result<PushBranchOutcome>> {
    return this.gated<PushBranchOutcome>('Git:PushBranch', 'pushBranch', () => {
      const foreign = this.refuseRepository(request.repository);
      if (foreign !== null) return err(foreign);
      const intent: WriteIntent = {
        operationId: request.operationId,
        target: `${request.repository.fullName}:${request.branch}`,
        operation: 'pushBranch',
      };
      const replayed = this.alreadyPerformed(intent);
      const result = this.replayOrRun(
        this.completedPushes,
        intent,
        () => providerId(`push_${request.branch}`),
        (): PushBranchOutcome => ({
          kind: 'Pushed',
          branch: request.branch,
          sha: request.headSha,
          remoteUrl: `${request.repository.url}/tree/${request.branch}`,
        }),
      );
      if (!result.ok) return result;
      if (replayed) return ok({ kind: 'AlreadyPresent', branch: request.branch, sha: request.headSha });
      return ok(result.value);
    });
  }

  /**
   * The reconciliation read.
   *
   * A write whose response was lost is found by the operation identity its
   * managed marker carries, which is how a caller establishes what happened
   * without repeating the write (F19-AC3, F30-AC5).
   */
  async findDrafts(
    _context: AdapterContext,
    request: FindDraftsRequest,
  ): Promise<Result<readonly DraftRef[]>> {
    return this.gated<readonly DraftRef[]>('Git:ReadRepository', 'findDrafts', () => {
      const foreign = this.refuseRepository(request.repository);
      if (foreign !== null) return err(foreign);
      return ok(
        [...this.drafts.values()].filter(
          (draft) =>
            draft.managedMarker.includes(request.operationId) ||
            (draft.headSha === request.headSha && sameLink(draft.link, request.link)),
        ),
      );
    });
  }

  async upsertDraft(_context: AdapterContext, request: UpsertDraftRequest): Promise<Result<UpsertDraftOutcome>> {
    const capability: CapabilityKind = request.existingDraft === null ? 'Git:CreateDraft' : 'Git:UpdateDraft';
    return this.gated<UpsertDraftOutcome>(capability, 'upsertDraft', () => {
      const foreign = this.refuseRepository(request.repository);
      if (foreign !== null) return err(foreign);
      const intent: WriteIntent = {
        operationId: request.operationId,
        target: `${request.repository.fullName}#${request.body.managedMarker}`,
        operation: 'upsertDraft',
      };
      const recorded = this.ledger.find(intent.operationId);
      if (recorded !== undefined) {
        if (recorded.outcome !== 'Succeeded') return err(this.reconcileFirstError(intent));
        const existing =
          this.completedDrafts.get(intent.operationId) ?? this.draftForMarker(request.body.managedMarker);
        if (existing === undefined) {
          return err(absent(`No draft change for operation ${intent.operationId} was found.`));
        }
        const digest = bodyDigest(request.body);
        if (digest === existing.bodyDigest) return ok({ kind: 'Unchanged', draft: existing });
        const updated: DraftRef = { ...existing, headSha: request.headSha, bodyDigest: digest };
        this.drafts.set(updated.pullRequest.pullRequestId, updated);
        return ok({ kind: 'Updated', draft: updated, changedSections: ['managedProgressRegion'] });
      }
      const externalId = this.nextDraftId();
      const draft: DraftRef = {
        pullRequest: {
          pullRequestId: externalId,
          number: this.draftCount,
          url: `${request.repository.url}/pull/${this.draftCount}`,
          draft: true,
          state: 'Open',
        },
        headSha: request.headSha,
        baseBranch: request.baseBranch,
        link: request.link,
        managedMarker: request.body.managedMarker,
        bodyDigest: bodyDigest(request.body),
      };
      // The provider holds the draft from the moment it is created, whether or
      // not the response ever arrives, so a lost write stays reconcilable.
      this.drafts.set(externalId, draft);
      if (this.conditions.consumeLostResponse()) return this.lostResponse<UpsertDraftOutcome>(intent, externalId);
      this.completedDrafts.set(intent.operationId, draft);
      this.recordWrite(intent, externalId);
      return ok({ kind: 'Created', draft });
    });
  }

  /**
   * Records a stated no-code outcome.
   *
   * This is a declaration against the branch rather than a provider write, so it
   * is deliberately absent from the side-effect ledger: a job that performed no
   * external write must leave none behind (F19-AC5). A repeat of the same
   * operation identity is answered from the declaration already recorded.
   */
  async declareNoCodeOutcome(
    _context: AdapterContext,
    request: DeclareNoCodeOutcomeRequest,
  ): Promise<Result<NoCodeOutcomeRecord>> {
    return this.gated<NoCodeOutcomeRecord>(null, 'declareNoCodeOutcome', () => {
      const foreign = this.refuseRepository(request.repository);
      if (foreign !== null) return err(foreign);
      const alreadyDeclared = this.noCodeDeclarations.get(request.operationId);
      if (alreadyDeclared !== undefined) return ok(alreadyDeclared);
      const record: NoCodeOutcomeRecord = {
        reason: request.reason,
        branchState: 'NeverPushed',
        pullRequest: null,
        evidence: request.evidence,
        declaredAt: request.declaredAt,
      };
      this.noCodeDeclarations.set(request.operationId, record);
      return ok(record);
    });
  }

  async mergePullRequest(
    context: AdapterContext,
    request: MergePullRequestRequest,
  ): Promise<Result<MergeOutcome>> {
    return this.gated<MergeOutcome>('Git:MergeWithPrecondition', 'mergePullRequest', () => {
      const foreign = this.refuseRepository(request.repository);
      if (foreign !== null) return err(foreign);
      const draft = this.drafts.get(request.pullRequestId);
      if (draft === undefined) return err(absent(`No draft change ${request.pullRequestId} exists.`));
      const pinnedHead =
        request.precondition.kind === 'ProviderExpectedHead' ? request.precondition.expectedHeadSha : null;
      if (pinnedHead !== null && pinnedHead !== this.head) {
        return err(
          conflict(
            'The merge precondition head no longer matches the provider head, so the merge was refused.',
            pinnedHead,
            this.head,
          ),
        );
      }
      const intent: WriteIntent = {
        operationId: request.operationId,
        target: `${request.repository.fullName}#${request.targetBranch}`,
        operation: 'mergePullRequest',
      };
      const replayed = this.alreadyPerformed(intent);
      const authorizedHead = request.expectedHeadSha;
      const mergedHead = this.head;
      const result = this.replayOrRun(
        this.completedMerges,
        intent,
        () => providerId(`merge_${request.pullRequestId}`),
        (): MergeOutcome => ({
          kind: 'Merged',
          mergeCommitSha: FIXTURE_MERGE_COMMIT_SHA,
          headSha: mergedHead,
          targetBranch: request.targetBranch,
          mergedAt: context.clock.now(),
          contentRelation:
            mergedHead === authorizedHead
              ? { kind: 'MatchesAuthorizedHead' }
              : {
                  kind: 'DiffersFromAuthorizedHead',
                  detail: `The merged head ${mergedHead.slice(0, 12)} is not the authorized head ${authorizedHead.slice(0, 12)}.`,
                },
        }),
      );
      if (!result.ok) return result;
      if (replayed) {
        return ok({
          kind: 'AlreadyMerged',
          mergeCommitSha: FIXTURE_MERGE_COMMIT_SHA,
          mergedAt: context.clock.now(),
        });
      }
      this.head = FIXTURE_MERGE_COMMIT_SHA;
      return ok(result.value);
    });
  }

  private refuseRepository(repository: GitRepositoryRef): ForbiddenError | null {
    return this.refuseForeignProvider('Git', repository.fullName, repository.provider);
  }

  /**
   * The facts a manual candidate link reads, scripted per pull-request number.
   *
   * A test scripts these because the interesting transitions — a force push, a close, a
   * retargeted base — are the *change* between two reads, and a fake that can only report one
   * fixed state cannot express "the head moved". Scripting is therefore by number, so a case can
   * replace one entry and read again.
   */
  private readonly linkedPullRequests = new Map<number, FakeLinkedPullRequest>();

  /** Replaces what the next read of one pull request reports. */
  scriptLinkedPullRequest(pullRequest: FakeLinkedPullRequest): void {
    this.linkedPullRequests.set(pullRequest.number, pullRequest);
  }

  /**
   * Reads one pull request by number, as the MVP candidate journey does.
   *
   * Distinct from `readState`, which answers a different question: it takes a *branch* and
   * reports the latest pull request for it. Manual linking names a *number*, so a fake that
   * only supported the branch form would make the MVP journey untestable.
   *
   * With nothing scripted the pull request does not exist, and the read says so. The fake
   * refuses to invent a resource here: a default that answered for any number would make "the
   * PR does not exist" unrepresentable, and that is one of the refusals the MVP journey has to
   * be able to test. `headSha` is validated as a full commit before it is returned, because an
   * abbreviated identity reaching a candidate is the failure this read exists to prevent
   * (F20-AC3).
   */
  async readLinkedPullRequest(
    context: AdapterContext,
    request: ReadLinkedPullRequestRequest,
  ): Promise<Result<LinkedPullRequestFacts>> {
    return this.gated<LinkedPullRequestFacts>('Git:ReadRepository', 'readLinkedPullRequest', () => {
      const foreign = this.refuseRepository(request.repository);
      if (foreign !== null) return err(foreign);
      if (request.repository.fullName !== this.repository.fullName) {
        return err(absent(`${this.provider} has no repository ${request.repository.fullName}.`));
      }
      const scripted = this.linkedPullRequests.get(request.pullRequestNumber);
      if (scripted === undefined) {
        return err(
          absent(
            `${this.provider} has no pull request ${request.pullRequestNumber} in ${this.repository.fullName}. Script one with scriptLinkedPullRequest before reading it.`,
          ),
        );
      }
      if (!isCommitSha(scripted.headSha) || !isCommitSha(scripted.baseSha)) {
        return err(
          unavailable(
            `${this.provider} reported an abbreviated commit for pull request ${request.pullRequestNumber}, which cannot be candidate identity.`,
          ),
        );
      }
      return ok({
        repository: this.repository,
        providerPullRequestId: providerId(`pull_fixture_${request.pullRequestNumber}`),
        number: scripted.number,
        url: `https://fixture.invalid/${this.repository.fullName}/pull/${scripted.number}`,
        state: scripted.state,
        draft: scripted.draft,
        headBranch: scripted.headBranch,
        headSha: scripted.headSha,
        baseBranch: scripted.baseBranch,
        baseSha: scripted.baseSha,
        headRepository: scripted.headRepository ?? this.repository.fullName,
        mergedSha: scripted.state === 'Merged' ? (scripted.mergedSha ?? null) : null,
        mergedAt: null,
        observedAt: context.clock.now(),
      });
    });
  }

  private latestPullRequest(): GitStateRead['pullRequest'] {
    const latest = [...this.drafts.values()].at(-1);
    return latest?.pullRequest ?? null;
  }

  private draftForMarker(managedMarker: string): DraftRef | undefined {
    return [...this.drafts.values()].find((draft) => draft.managedMarker === managedMarker);
  }

  private nextDraftId(): ProviderId {
    this.draftCount += 1;
    return providerId(`draft_${this.draftCount}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Deployment                                                                  */
/* -------------------------------------------------------------------------- */

function discoveryKey(component: string, environment: string, commitSha: CommitSha): string {
  return `${component}|${environment}|${commitSha}`;
}

function deploymentMatch(
  deployment: DeploymentIdentityRead,
  expectedCommitSha: CommitSha | null,
  expectedEnvironment: string,
): DeploymentIdentityRead['match'] {
  if (expectedCommitSha === null) {
    return { kind: 'Unchecked', detail: 'No candidate was supplied, so the deployment was not matched against one.' };
  }
  if (deployment.commitSha !== expectedCommitSha) {
    return { kind: 'MismatchedCommit', expected: expectedCommitSha, observed: deployment.commitSha };
  }
  if (deployment.environment !== expectedEnvironment) {
    return { kind: 'MismatchedEnvironment', expected: expectedEnvironment, observed: deployment.environment };
  }
  return { kind: 'Matches', commitSha: deployment.commitSha, environment: deployment.environment };
}

function smokeArtifact(probeId: string, producedAt: string): ArtifactReference {
  return {
    artifactId: `artifact_${probeId}`,
    kind: 'Log',
    uri: `artifact://fixture/smoke/${probeId}.txt`,
    mediaType: 'text/plain',
    byteLength: null,
    producedAt,
    sanitized: true,
  };
}

export class FakeDeploymentAdapter extends FakeAdapterBase implements DeploymentAdapter {
  override readonly kind = 'Deployment';

  private readonly byDeploymentId = new Map<ProviderId, DeploymentIdentityRead>();
  private readonly byDiscoveryKey = new Map<string, DeploymentIdentityRead>();
  private readonly componentIdentities = new Map<string, DeploymentIdentityRead>();
  private readonly completedExecutions = new Map<string, DeploymentExecutionOutcome>();

  constructor(init: FakeAdapterInit, deployments: readonly DeploymentIdentityRead[]) {
    super(init);
    for (const deployment of deployments) {
      this.byDeploymentId.set(deployment.deploymentId, deployment);
      this.byDiscoveryKey.set(
        discoveryKey(deployment.component, deployment.environment, deployment.commitSha),
        deployment,
      );
    }
  }

  /**
   * Finds exactly the deployment the request names, or says why none stands in.
   *
   * Discovery is keyed by repository, full commit, component and environment. A
   * deployment at another commit is reported as ineligible rather than returned,
   * because a neighbour is not tested identity (F22-AC2).
   */
  async discoverDeployment(
    _context: AdapterContext,
    request: DiscoverDeploymentRequest,
  ): Promise<Result<DeploymentDiscovery>> {
    return this.gated<DeploymentDiscovery>('Deployment:Discover', 'discoverDeployment', () => {
      const found = this.byDiscoveryKey.get(
        discoveryKey(request.component, request.environment, request.commitSha),
      );
      if (found !== undefined) {
        return ok({
          kind: 'Found',
          deployment: this.readAt(found, request.commitSha, request.environment),
        });
      }
      const nearMisses = [...this.byDeploymentId.values()].filter(
        (deployment) =>
          deployment.component === request.component &&
          deployment.environment === request.environment &&
          deployment.commitSha !== request.commitSha,
      );
      return ok({
        kind: 'NotFound',
        detail: `No deployment matches ${request.component} at ${request.commitSha.slice(0, 12)} in ${request.environment}.`,
        ineligible: nearMisses.map((deployment) => ({
          deploymentId: deployment.deploymentId,
          commitSha: deployment.commitSha,
          url: deployment.url,
          ineligibility: 'DifferentCommit' as const,
          detail: `${deployment.deploymentId} is at ${deployment.commitSha.slice(0, 12)}, not the requested commit.`,
        })),
      });
    });
  }

  async readIdentity(
    _context: AdapterContext,
    request: ReadDeploymentIdentityRequest,
  ): Promise<Result<DeploymentIdentityRead>> {
    return this.gated<DeploymentIdentityRead>('Deployment:ReadIdentity', 'readIdentity', () => {
      const known = this.byDeploymentId.get(request.deploymentId);
      if (known === undefined) return err(absent(`No deployment with identity ${request.deploymentId} exists.`));
      return ok(this.readAt(known, request.expectedCommitSha, request.expectedEnvironment));
    });
  }

  async executeDeliveryAction(
    context: AdapterContext,
    action: PermittedDeliveryAction,
  ): Promise<Result<DeploymentExecutionOutcome>> {
    return this.gated<DeploymentExecutionOutcome>('Deployment:Execute', 'executeDeliveryAction', () => {
      if (action.kind === 'ObserveAuthorizedPipeline') {
        const observed = this.byDeploymentId.get(action.deploymentId);
        if (observed === undefined) return err(absent(`No deployment with identity ${action.deploymentId} exists.`));
        return ok({
          kind: 'Observed',
          deployment: observed,
          detail: `Observed the pipeline ${action.pipelineReference} the authorized merge triggered. No second delivery was triggered (F28-AC1).`,
        });
      }
      const source = this.byDeploymentId.get(action.sourceDeploymentId);
      if (source === undefined) {
        return err(absent(`No deployment with identity ${action.sourceDeploymentId} exists to deliver from.`));
      }
      const intent: WriteIntent = {
        operationId: context.operationId,
        target: `${action.environment}:${action.component}`,
        operation: 'executeDeliveryAction',
      };
      return this.replayOrRun(
        this.completedExecutions,
        intent,
        () => providerId(`deploy_${context.operationId}`),
        (deploymentId) =>
          this.deliver(action.component, action.environment, source.commitSha, deploymentId, context.clock.now()),
      );
    });
  }

  /**
   * Post-delivery confirmation.
   *
   * Confirmation needs every required component identity to match the authorized
   * candidate, to be usable, and to pass its live smoke probe. A partial
   * component failure therefore yields `PartiallyConfirmed` with the failing
   * component named, never `Confirmed` (F28-AC2, F28-AC3).
   */
  async verifyDestination(
    context: AdapterContext,
    request: VerifyDestinationRequest,
  ): Promise<Result<DestinationVerification>> {
    return this.gated<DestinationVerification>('Deployment:VerifyDestination', 'verifyDestination', () => {
      if (!this.completedExecutions.has(context.operationId)) {
        return err(
          absent(
            `No executed delivery with operation ${context.operationId} is recorded, so ${request.destination} cannot be verified.`,
          ),
        );
      }
      const components: VerifiedComponentIdentity[] = [];
      const failures: ComponentFailure[] = [];
      for (const component of request.requiredComponents) {
        const identity = this.componentIdentities.get(component);
        if (identity === undefined) {
          failures.push({
            component,
            kind: 'Unavailable',
            detail: `No deployment identity was established for ${component} on ${request.destination}.`,
          });
          continue;
        }
        const match = deploymentMatch(identity, request.expectedCommitSha, request.expectedEnvironment);
        if (match.kind !== 'Matches') {
          failures.push({
            component,
            kind: 'IdentityMismatch',
            detail: `${component} on ${request.destination} was read at ${identity.commitSha.slice(0, 12)} in ${identity.environment}, which is not the authorized candidate.`,
          });
          continue;
        }
        if (identity.availability.kind !== 'Usable') {
          failures.push({
            component,
            kind: 'SmokeFailed',
            detail: `${component} is ${identity.availability.kind} on ${request.destination}, so the live smoke check could not pass.`,
          });
          continue;
        }
        components.push({
          component,
          deploymentId: identity.deploymentId,
          commitSha: identity.commitSha,
          url: identity.url,
          environment: identity.environment,
        });
      }
      const smoke = this.smokeResult(request, context.clock.now());
      if (failures.length === 0) {
        return ok({ kind: 'Confirmed', components, smoke, verifiedAt: context.clock.now() });
      }
      if (components.length > 0) return ok({ kind: 'PartiallyConfirmed', components, failures, smoke });
      return ok({
        kind: 'Unverifiable',
        detail: `${failures.map((failure) => failure.component).join(', ')} could not be verified on ${request.destination}.`,
        smoke,
      });
    });
  }

  private deliver(
    component: string,
    environment: string,
    commitSha: CommitSha,
    deploymentId: ProviderId,
    observedAt: string,
  ): DeploymentExecutionOutcome {
    const state = this.conditions.componentState(component);
    const url = `https://${environment}.fixture.invalid/${component}/${deploymentId}`;
    const deployment: DeploymentIdentityRead = {
      deploymentId,
      provider: this.provider,
      component,
      environment,
      repositoryFullName: FIXTURE_REPOSITORY_FULL_NAME,
      commitSha,
      url,
      availability: availabilityStateFor(state, `The provider reports ${component} as ${state} in ${environment}.`),
      access: accessObservationFor(state, url),
      match: { kind: 'Matches', commitSha, environment },
      providerRevision: `revision_${environment}_${component}`,
      observedAt,
    };
    this.componentIdentities.set(component, deployment);
    this.byDeploymentId.set(deploymentId, deployment);
    // A deployment that does not exist yet has nothing to complete; the provider
    // has only accepted the action.
    if (state === 'Missing') {
      return {
        kind: 'Triggered',
        deploymentId,
        providerOperationReference: `provider_operation_${deploymentId}`,
        acceptedAt: observedAt,
      };
    }
    return { kind: 'Completed', deployment };
  }

  private readAt(
    deployment: DeploymentIdentityRead,
    expectedCommitSha: CommitSha | null,
    expectedEnvironment: string,
  ): DeploymentIdentityRead {
    return { ...deployment, match: deploymentMatch(deployment, expectedCommitSha, expectedEnvironment) };
  }

  private smokeResult(request: VerifyDestinationRequest, observedAt: string): SmokeResult {
    if (request.liveSmoke.kind === 'None') return { kind: 'NotRun', reason: request.liveSmoke.reason };
    const failing = new Set(
      request.requiredComponents.filter(
        (component) => this.componentIdentities.get(component)?.availability.kind !== 'Usable',
      ),
    );
    const probes: SmokeObservation[] = request.liveSmoke.probes.map((probe) => {
      const served = !failing.has(probe.component);
      return {
        probeId: probe.probeId,
        url: probe.url,
        observedAt,
        outcome: served
          ? { kind: 'StatusMatched', httpStatus: probe.expectStatus }
          : { kind: 'StatusMismatch', expected: probe.expectStatus, observed: 502 },
        evidence: served ? [smokeArtifact(probe.probeId, observedAt)] : [],
      };
    });
    return failing.size === 0
      ? { kind: 'Passed', probes }
      : {
          kind: 'Failed',
          probes,
          detail: `${[...failing].join(', ')} did not serve ${request.destination}; the delivery is not confirmed.`,
        };
  }
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                      */
/* -------------------------------------------------------------------------- */

/** One event as the engine's own output reports it, before translation. */
type NativeEngineEvent =
  | { readonly type: 'session.started'; readonly sessionId: string }
  | { readonly type: 'milestone'; readonly stage: EngineStage; readonly message: string }
  | { readonly type: 'artifact'; readonly path: string }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'no-code-change'; readonly stage: EngineStage; readonly reason: string }
  | { readonly type: 'completion'; readonly status: 'success' }
  | { readonly type: 'completion'; readonly status: 'failed'; readonly category: EngineDiagnosticCategory };

type NativeCompletion = Extract<NativeEngineEvent, { type: 'completion' }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asMember(record: Record<string, unknown>, key: string): string | null {
  const member = record[key];
  return typeof member === 'string' ? member : null;
}

function asTokenCount(record: Record<string, unknown>, key: string): number | null {
  const member = record[key];
  return typeof member === 'number' && Number.isInteger(member) && member >= 0 ? member : null;
}

/** Returns null for anything that is not a well-formed engine event. */
function readNativeEngineEvent(line: string): NativeEngineEvent | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return null;
  }
  const record = asRecord(decoded);
  if (record === null) return null;
  switch (asMember(record, 'type')) {
    case 'session.started': {
      const sessionId = asMember(record, 'session_id');
      return sessionId === null ? null : { type: 'session.started', sessionId };
    }
    case 'milestone': {
      const stage = asMember(record, 'stage');
      const message = asMember(record, 'message');
      if (stage === null || message === null || !isEngineStage(stage)) return null;
      return { type: 'milestone', stage, message };
    }
    case 'artifact': {
      const path = asMember(record, 'path');
      return path === null ? null : { type: 'artifact', path };
    }
    case 'usage': {
      const inputTokens = asTokenCount(record, 'input_tokens');
      const outputTokens = asTokenCount(record, 'output_tokens');
      return inputTokens === null || outputTokens === null ? null : { type: 'usage', inputTokens, outputTokens };
    }
    case 'no-code-change': {
      const stage = asMember(record, 'stage');
      const reason = asMember(record, 'reason');
      if (stage === null || reason === null || !isEngineStage(stage)) return null;
      return { type: 'no-code-change', stage, reason };
    }
    case 'completion': {
      const status = asMember(record, 'status');
      if (status === 'success') return { type: 'completion', status: 'success' };
      // A failed completion must name its category: the adapter reports a remedy,
      // and a bare failure does not say what to do next (F15-AC3).
      const category = asMember(record, 'category');
      if (status !== 'failed' || category === null || !isDiagnosticCategory(category)) return null;
      return { type: 'completion', status: 'failed', category };
    }
    default:
      return null;
  }
}

function eventStream(events: readonly EngineEvent[]): AsyncIterable<EngineEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
      for (const event of events) yield event;
    },
  };
}

function lastProgressIndex(events: readonly EngineEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.kind === 'Progress') return index;
  }
  return -1;
}

export class FakeEngineAdapter extends FakeAdapterBase implements EngineAdapter {
  override readonly kind = 'Engine';

  private readonly nativeOutput: readonly string[];
  private readonly sessions = new Map<ProviderId, EngineSessionHandle>();
  private sessionCounter = 0;

  constructor(init: FakeAdapterInit, nativeOutput: readonly string[]) {
    super(init);
    this.nativeOutput = nativeOutput;
  }

  async startSession(context: AdapterContext, request: EngineStartRequest): Promise<Result<EngineSessionHandle>> {
    return this.startSessionFrom(context, request, this.nativeOutput);
  }

  /**
   * Starts a session whose provider produced the given native output.
   *
   * The seeded output is the common case; a case that must observe a different
   * stream (a read-only run, a retry) names it here rather than mutating the
   * fake's seed, so two cases cannot see each other's output.
   */
  async startSessionFrom(
    context: AdapterContext,
    request: EngineStartRequest,
    nativeOutput: readonly string[],
  ): Promise<Result<EngineSessionHandle>> {
    return this.gated<EngineSessionHandle>('Engine:StartScoped', 'startSession', () => {
      // The contract already excludes delivery kinds from a coding grant. This
      // refuses them at runtime as well, because the request crosses a trust
      // boundary: a grant assembled outside the type system must not be able to
      // carry a delivery action into a coding session (F03-AC5, N02-AC3).
      const denied = deniedCodingCapabilities(request.grantedCapabilities);
      if (denied.length > 0) {
        return err(
          forbidden(
            `A coding stage session may not hold ${denied.join(', ')}; a delivery action belongs to an authorized delivery executor.`,
          ),
        );
      }
      const events = this.translateNativeOutput(context, nativeOutput, request.start);
      return ok(this.newSession(context, request.workspace, request.grantedCapabilities, request.mode, events));
    });
  }

  /**
   * Translates the engine's native output into the contract's closed event union.
   *
   * This is the whole point of an engine adapter: the engine's own text never
   * becomes state. A line that cannot be parsed disqualifies the run from
   * reporting success even when the stream literally claims it (F15-AC2), and it
   * also disqualifies the reported usage, because a stream containing an
   * unparseable line cannot be trusted to carry a complete usage record
   * (F18-AC4).
   *
   * It is public so a test can tamper with exactly this translation and prove the
   * suite's malformed-output case catches an adapter that inherits the engine's
   * success claim.
   */
  translateNativeOutput(
    context: AdapterContext,
    lines: readonly string[],
    start: EngineSessionStart,
  ): EngineEvent[] {
    const now = context.clock.now();
    const events: EngineEvent[] = [];
    const malformed: { readonly index: number; readonly line: string }[] = [];
    let usage: EngineUsage | null = null;
    let completion: NativeCompletion | null = null;
    let noCodeReason: string | null = null;

    for (const [index, raw] of lines.entries()) {
      const line = raw.trim();
      if (line.length === 0) continue;
      const event = readNativeEngineEvent(line);
      if (event === null) {
        malformed.push({ index, line });
        continue;
      }
      switch (event.type) {
        case 'session.started':
          events.push({
            kind: 'SessionStarted',
            at: now,
            sessionId: providerId(event.sessionId),
            engineVersion: this.runtimeVersion,
            mode: 'Headless',
            startedFrom: start.kind,
          });
          break;
        case 'milestone':
          events.push({
            kind: 'Progress',
            at: now,
            stage: event.stage,
            milestoneKey: null,
            summary: event.message,
            detail: null,
          });
          break;
        case 'artifact': {
          // An artifact is reported as part of a stage, so it attaches to the
          // progress event that stage produced. A bare artifact line is not
          // well-formed output.
          const target = lastProgressIndex(events);
          if (target < 0) {
            malformed.push({ index, line });
            break;
          }
          const attachment: ArtifactReference = {
            artifactId: `artifact_${index}`,
            kind: 'Log',
            uri: event.path,
            mediaType: 'text/markdown',
            byteLength: null,
            producedAt: now,
            sanitized: true,
          };
          const progress = events[target];
          if (progress?.kind === 'Progress') events[target] = { ...progress, detail: attachment };
          break;
        }
        case 'usage':
          usage = {
            availability: 'Reported',
            windowStart: null,
            windowEnd: null,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            billedAmount: null,
            currency: null,
            unknownReason: null,
          };
          break;
        case 'no-code-change':
          noCodeReason = event.reason;
          events.push({
            kind: 'Progress',
            at: now,
            stage: event.stage,
            milestoneKey: 'no-code-change',
            summary: `The engine reported no repository change: ${event.reason}`,
            detail: null,
          });
          break;
        case 'completion':
          completion = event;
          break;
      }
    }

    if (usage !== null) {
      events.push({
        kind: 'Usage',
        at: now,
        usage:
          malformed.length === 0
            ? { kind: 'Reported', usage }
            : {
                kind: 'Unknown',
                reason: 'The stream contained a line that could not be parsed, so its usage record cannot be trusted.',
              },
      });
    }
    if (malformed.length > 0) {
      const first = malformed[0];
      events.push({
        kind: 'Diagnostic',
        at: now,
        category: 'MalformedOutput',
        detail: `Engine output could not be parsed at line ${String(first?.index ?? 0)}: ${first?.line ?? ''}`,
        retry: 'Terminal',
        evidence: null,
      });
      return events;
    }
    if (completion === null) {
      events.push({
        kind: 'Diagnostic',
        at: now,
        category: 'MalformedOutput',
        detail: 'The engine reported no completion event, so the run cannot be called successful.',
        retry: 'Terminal',
        evidence: null,
      });
      return events;
    }
    events.push({
      kind: 'Result',
      at: now,
      outcome:
        completion.status === 'success'
          ? {
              kind: 'Succeeded',
              summary:
                noCodeReason === null
                  ? 'The engine reported a successful completion.'
                  : `The engine completed successfully and reported no repository change: ${noCodeReason}`,
            }
          : {
              kind: 'Failed',
              category: completion.category,
              summary: `The engine reported a failed completion in category ${completion.category}.`,
              remedy: 'Read the recorded diagnostic and re-run the scoped step after addressing it.',
            },
    });
    return events;
  }

  /**
   * Continuation is not faked.
   *
   * When the provider exposes no restoration the adapter reports
   * `ContinuationUnsupported` and the caller starts a fresh session from the
   * checkpoint, rather than claiming a restored conversation (F15-AC4). When the
   * provider does claim restoration, this in-memory provider genuinely holds the
   * session and resumes it in place.
   */
  async resumeSession(
    context: AdapterContext,
    request: ResumeEngineSessionRequest,
  ): Promise<Result<EngineContinuation>> {
    return this.gated<EngineContinuation>(null, 'resumeSession', () => {
      const supported = this.ensureSupported('Engine:ResumeSession');
      if (!supported.ok) {
        return ok({
          kind: 'ContinuationUnsupported',
          checkpoint: request.checkpoint,
          limitation: `Session restoration is not supported: ${supported.error.reason} A fresh session starts from checkpoint ${request.checkpoint.checkpointId}.`,
          requiresFreshSessionFromCheckpoint: true,
        });
      }
      const prior = this.sessions.get(request.priorSession.sessionId);
      if (prior === undefined) {
        return ok({
          kind: 'RestartedFromCheckpoint',
          session: this.newSession(context, request.workspace, request.grantedCapabilities, 'Headless', []),
          checkpoint: request.checkpoint,
          limitation: `The provider no longer holds session ${request.priorSession.sessionId}, so the attempt restarted from its checkpoint.`,
        });
      }
      return ok({ kind: 'ResumedInPlace', session: prior, resumedFromEventAt: request.priorSession.lastEventAt });
    });
  }

  async stopSession(_context: AdapterContext, request: StopEngineSessionRequest): Promise<Result<EngineStopOutcome>> {
    return this.gated<EngineStopOutcome>('Engine:StopGraceful', 'stopSession', () => {
      const session = this.sessions.get(request.sessionId);
      if (session === undefined) {
        return ok({ kind: 'StopRefused', detail: `No session ${request.sessionId} is running, so nothing was stopped.` });
      }
      this.sessions.delete(request.sessionId);
      return ok({
        kind: 'Stopped',
        stoppedAt: FAKE_OBSERVED_AT,
        checkpoint: {
          checkpointId: `checkpoint_${session.sessionId}`,
          capturedAt: FAKE_OBSERVED_AT,
          scopeFingerprint: session.workspace.scopeFingerprint,
          headSha: session.workspace.headSha,
          baseSha: session.workspace.baseSha,
          dirtyPaths: [],
          untrackedPaths: [],
          blocker: null,
          nextAction: 'Hand the candidate to the owner for acceptance.',
          resumeInstructions: 'The workspace is intact; resume from this checkpoint without widening the scope.',
        },
      });
    });
  }

  private newSession(
    context: AdapterContext,
    workspace: ExecutionWorkspace,
    grantedCapabilities: readonly CodingSessionCapability[],
    mode: EngineSessionHandle['mode'],
    events: readonly EngineEvent[],
  ): EngineSessionHandle {
    this.sessionCounter += 1;
    const handle: EngineSessionHandle = {
      sessionId: providerId(`sess_fixture_${this.sessionCounter}`),
      engineVersion: this.runtimeVersion,
      mode,
      workspace,
      grantedCapabilities,
      startedAt: context.clock.now(),
      events: eventStream(events),
    };
    this.sessions.set(handle.sessionId, handle);
    return handle;
  }
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

function isCheckObservation(
  observation: CriterionObservation,
): observation is Extract<CriterionObservation, { kind: 'Check' }> {
  return observation.kind === 'Check';
}

/**
 * What one recorded observation means for a criterion.
 *
 * An outcome that could not be read is never promoted to `Verified`, and a check
 * the profile approved as not applicable verified nothing (F15-AC2 applied to
 * criteria, F20-AC2).
 */
function criterionStatusFor(completion: CheckCompletion): {
  readonly status: CriterionStatus;
  readonly reason: string | null;
} {
  if (completion.kind === 'Concluded') {
    switch (completion.result) {
      case 'Passed':
        return { status: 'Verified', reason: null };
      case 'Failed':
        return { status: 'Failed', reason: null };
      case 'Missing':
        return { status: 'Missing', reason: null };
      case 'Stale':
        return { status: 'Stale', reason: null };
      case 'Waiting':
        return { status: 'Untested', reason: 'The check is still queued, so no result was observed.' };
      case 'NotApplicable':
        return {
          status: 'Untested',
          reason: 'The check was reported Not applicable with no policy approval attached, so it verified nothing.',
        };
    }
  }
  if (completion.kind === 'NotStarted') return { status: 'Missing', reason: completion.detail };
  if (completion.kind === 'NotApplicable') {
    return {
      status: 'Untested',
      reason: `The check was approved as Not applicable by policy, so it verified nothing: ${completion.detail}`,
    };
  }
  return { status: 'Untested', reason: completion.detail };
}

export class FakeVerificationAdapter extends FakeAdapterBase implements VerificationAdapter {
  override readonly kind = 'Verification';

  private readonly observations: readonly ProviderCheckObservation[];
  private readonly deployments: readonly DeploymentIdentityRead[];

  constructor(
    init: FakeAdapterInit,
    observations: readonly ProviderCheckObservation[],
    deployments: readonly DeploymentIdentityRead[],
  ) {
    super(init);
    this.observations = observations;
    this.deployments = deployments;
  }

  /**
   * Readiness against the recipe probes the caller names.
   *
   * A probe that is also a configured check reports that check's observed state:
   * an unmet probe blocks, and a probe the provider never ran is unknown rather
   * than met (F09-AC2, F04-AC2).
   */
  async runPreflight(context: AdapterContext, request: PreflightRequest): Promise<Result<PreflightReport>> {
    return this.gated<PreflightReport>(null, 'runPreflight', () => {
      const findings: readonly ReadinessFinding[] = request.probes.map((probe) => {
        const status: ReadinessStatus = this.probeStatus(probe.probeId);
        return {
          area: 'Verification',
          status,
          reason: `Recipe probe ${probe.probeId} (${probe.description}) was observed as ${status}.`,
          remedy: status === 'Satisfied' ? null : 'Resolve the probe on the workspace before starting an attempt.',
        };
      });
      return ok({
        assessment: {
          verdict: deriveReadiness(findings),
          findings,
          observedAt: context.clock.now(),
          observationsDigest: fingerprint({
            recipeVersionId: request.recipeVersionId,
            probes: request.probes.map((probe) => probe.probeId),
          }),
        },
        recipeVersionId: request.recipeVersionId,
        environmentFingerprint: request.workspace.environmentFingerprint,
        artifacts: [],
      });
    });
  }

  /**
   * Records the check the profile configured, bound to the candidate the
   * controller named.
   *
   * A required check the coding run tried to drop is refused rather than mapped:
   * a `NotApplicable` completion is only expressible with a policy approval, and
   * without one the honest outcome is an actionable refusal (F20-AC2, F20-AC5).
   */
  async runCheck(context: AdapterContext, request: CheckExecutionRequest): Promise<Result<CheckExecutionRecord>> {
    return this.gated<CheckExecutionRecord>('Git:ReadChecks', 'runCheck', () => {
      const observation = this.observationFor(request.check.name);
      const approved = this.conditions.approvesNotApplicable(request.check.name);
      if (request.check.required && observation?.result === 'NotApplicable' && !approved) {
        return err({
          code: 'Blocked',
          reason: `Required check "${request.check.name}" was reported Not applicable without a profile policy decision.`,
          prerequisites: [
            {
              name: 'RequiredCheckPolicy',
              detail: `${observation.checkId} was marked Not applicable by the coding run.`,
              remedy: 'The owner must approve Not applicable for this check in the project profile, or the check must run.',
            },
          ],
        });
      }
      const endedAt = observation?.endedAt ?? null;
      const artifactUrl = observation?.artifactUrl ?? null;
      return ok({
        checkId: request.check.checkId,
        name: request.check.name,
        kind: request.check.kind,
        required: request.check.required,
        candidateFingerprint: request.candidateFingerprint,
        completion: this.completionFor(request.check.name, observation),
        startedAt: observation?.startedAt ?? context.clock.now(),
        endedAt,
        exitCode: observation?.exitCode ?? null,
        artifacts: artifactUrl === null ? [] : [checkOutputArtifact(request.check.checkId, artifactUrl, endedAt ?? context.clock.now())],
        detail: observation?.detail ?? 'The provider reported no run for this check.',
      });
    });
  }

  /**
   * Binds each criterion to the observation recorded under the same identity.
   *
   * The controller supplies both sides, so nothing here infers a match from
   * prose. `candidateFingerprint` is echoed rather than derived: only the
   * controller knows which candidate is being verified (F20-AC3).
   */
  async mapCriteria(
    _context: AdapterContext,
    request: MapCriteriaRequest,
  ): Promise<Result<readonly CriterionEvidence[]>> {
    return this.gated<readonly CriterionEvidence[]>('Git:ReadChecks', 'mapCriteria', () => {
      const completions = new Map(
        request.observations
          .filter(isCheckObservation)
          .map((observation) => [observation.checkId, observation.completion]),
      );
      return ok(
        request.criteria.map((criterion): CriterionEvidence => {
          const completion = completions.get(criterion.id);
          const derived =
            completion === undefined
              ? { status: 'Untested' as CriterionStatus, reason: `No observation was recorded for ${criterion.id}.` }
              : criterionStatusFor(completion);
          return {
            criterionId: criterion.id,
            method:
              completion === undefined || derived.reason !== null
                ? { kind: 'Untested', reason: derived.reason ?? 'No observation was recorded.' }
                : { kind: 'AutomatedCheck', checkId: criterion.id },
            status: derived.status,
            evidenceId: null,
            candidateFingerprint: request.candidateFingerprint,
            scopeFingerprint: request.scopeFingerprint,
            observedAt: request.observedAt,
          };
        }),
      );
    });
  }

  /**
   * Runs a browser or API flow against whatever deployment serves the URL.
   *
   * A protected destination is reported as `BlockedBySignIn`, never as an
   * expectation the application met: a sign-in page satisfies almost every naive
   * "did the page load" assertion and is not application verification (F22-AC3).
   */
  async collectEvidence(context: AdapterContext, request: CollectEvidenceRequest): Promise<Result<EvidenceBundle>> {
    return this.gated<EvidenceBundle>('Deployment:VerifyDestination', 'collectEvidence', () => {
      const observedAt = context.clock.now();
      if (request.kind === 'Browser') {
        const flow: BrowserFlowSpec = request.flow;
        return ok({
          kind: 'Browser',
          evidence: {
            kind: 'Browser',
            flowId: flow.flowId,
            baseUrl: flow.baseUrl,
            environment: flow.environment,
            outcome: this.browserOutcome(flow, observedAt),
            observedAt,
            artifacts: [browserArtifact(flow.flowId, observedAt)],
          },
          criterionIds: request.criterionIds,
        });
      }
      const exchange: ApiExchangeSpec = request.exchange;
      return ok({
        kind: 'Api',
        evidence: {
          kind: 'Api',
          exchangeId: exchange.exchangeId,
          baseUrl: exchange.baseUrl,
          environment: exchange.environment,
          outcome: this.apiOutcome(exchange),
          observedAt,
          artifacts: [],
        },
        criterionIds: request.criterionIds,
      });
    });
  }

  private completionFor(checkName: string, observation: ProviderCheckObservation | undefined): CheckCompletion {
    if (observation === undefined) {
      return { kind: 'NotStarted', detail: 'The provider reported no run for this check on the candidate head.' };
    }
    if (observation.result === 'NotApplicable' && this.conditions.approvesNotApplicable(checkName)) {
      return {
        kind: 'NotApplicable',
        approvedByPolicy: true,
        detail: observation.detail ?? 'Approved as not applicable by the project profile.',
      };
    }
    return { kind: 'Concluded', result: observation.result };
  }

  private observationFor(checkName: string): ProviderCheckObservation | undefined {
    return this.observations.find((observation) => observation.name === checkName);
  }

  private probeStatus(probeId: string): ReadinessStatus {
    const observation = this.observationFor(probeId);
    if (observation === undefined) return 'Satisfied';
    if (observation.result === 'Passed') return 'Satisfied';
    if (observation.result === 'NotApplicable') return 'Satisfied';
    if (observation.result === 'Missing' || observation.result === 'Waiting') return 'Unknown';
    return 'Unmet';
  }

  private deploymentFor(url: string): DeploymentIdentityRead | undefined {
    return this.deployments.find(
      (deployment) => url.startsWith(deployment.url) || deployment.url.startsWith(url),
    );
  }

  private browserOutcome(flow: BrowserFlowSpec, observedAt: string): BrowserOutcome {
    const deployment = this.deploymentFor(flow.baseUrl);
    if (deployment === undefined) {
      return { kind: 'Inconclusive', reason: `No deployment serves ${flow.baseUrl}, so the flow was never reached.` };
    }
    switch (deployment.availability.kind) {
      case 'Usable':
        return {
          kind: 'ExpectationMet',
          expectation: flow.expectation,
          detail: `The application at ${flow.baseUrl} met the expectation as an authenticated owner.`,
        };
      case 'Protected':
        return {
          kind: 'BlockedBySignIn',
          observedAt,
          detail: `${flow.baseUrl} returned a sign-in page, so the application itself was never observed.`,
        };
      case 'Building':
        return { kind: 'Inconclusive', reason: `The deployment at ${flow.baseUrl} is still building.` };
      case 'Failed':
        return { kind: 'FailedAtStep', stepIndex: 0, detail: `The deployment at ${flow.baseUrl} reports a failed build.` };
      case 'Missing':
        return { kind: 'Inconclusive', reason: `No deployment is serving ${flow.baseUrl}.` };
    }
  }

  private apiOutcome(exchange: ApiExchangeSpec): ApiExchangeOutcome {
    const deployment = this.deploymentFor(exchange.baseUrl);
    if (deployment === undefined) {
      return { kind: 'Inconclusive', reason: `No deployment serves ${exchange.baseUrl}, so the exchange was never sent.` };
    }
    if (deployment.availability.kind === 'Usable') {
      return {
        kind: 'ExpectationsMet',
        steps: [{ kind: 'StatusMatched', status: 200 }],
        detail: `The API at ${exchange.baseUrl} answered as expected.`,
      };
    }
    return { kind: 'FailedAtStep', stepIndex: 0, outcome: { kind: 'StatusMismatch', expected: 200, observed: 302 } };
  }
}

function checkOutputArtifact(checkId: string, uri: string, producedAt: string): ArtifactReference {
  return {
    artifactId: `artifact_${checkId}`,
    kind: 'CheckOutput',
    uri,
    mediaType: 'text/plain',
    byteLength: null,
    producedAt,
    sanitized: true,
  };
}

function browserArtifact(flowId: string, producedAt: string): ArtifactReference {
  return {
    artifactId: `artifact_${flowId}`,
    kind: 'Screenshot',
    uri: `artifact://fixture/screenshots/${flowId}.png`,
    mediaType: 'image/png',
    byteLength: null,
    producedAt,
    sanitized: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Provider deliveries                                                         */
/* -------------------------------------------------------------------------- */

export interface ReconciledFacts {
  readonly draftHeadSha: CommitSha;
  readonly sequence: number;
  readonly observedAt: string;
}

export interface ProviderEventAdapter {
  ingest(event: ProviderEvent): Result<ReconciledFacts, DomainError>;
  currentFacts(): ReconciledFacts;
  appliedDeliveries(): readonly string[];
}

/**
 * Webhook ingestion (F30-AC2, F30-AC3).
 *
 * A replayed delivery identity is accepted without being applied twice, and an
 * event that is not newer than the facts already held is recorded but does not
 * revert them. A webhook is a hint, not proof of current state (ARCHITECTURE).
 */
export class FakeProviderEventAdapter extends FakeAdapterBase implements ProviderEventAdapter {
  private draftHeadSha: CommitSha;
  private sequence: number;
  private observedAt: string;
  private readonly seenDeliveries = new Set<string>();
  private readonly applied: string[] = [];

  constructor(init: FakeAdapterInit, initial: ReconciledFacts) {
    super(init);
    this.draftHeadSha = initial.draftHeadSha;
    this.sequence = initial.sequence;
    this.observedAt = initial.observedAt;
  }

  ingest(event: ProviderEvent): Result<ReconciledFacts, DomainError> {
    if (this.seenDeliveries.has(event.deliveryId)) return ok(this.currentFacts());
    this.seenDeliveries.add(event.deliveryId);
    if (event.sequence <= this.sequence) return ok(this.currentFacts());
    this.draftHeadSha = event.draftHeadSha;
    this.sequence = event.sequence;
    this.observedAt = event.observedAt;
    this.applied.push(event.deliveryId);
    return ok(this.currentFacts());
  }

  currentFacts(): ReconciledFacts {
    return { draftHeadSha: this.draftHeadSha, sequence: this.sequence, observedAt: this.observedAt };
  }

  appliedDeliveries(): readonly string[] {
    return [...this.applied];
  }
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

const TICKET_DECLARATIONS: readonly CapabilityDeclaration[] = [
  declaration('Ticket:ReadScope', true, false, false, null),
  declaration('Ticket:PublishIssue', true, false, false, null),
  declaration('Ticket:UpdateManagedProgress', true, false, false, null),
  declaration(
    'Ticket:RequestTransition',
    false,
    false,
    false,
    'the provider agent API is a Developer Preview, so the owner sets ticket state directly',
  ),
];

const GIT_DECLARATIONS: readonly CapabilityDeclaration[] = [
  declaration('Git:ReadRepository', true, false, false, null),
  declaration('Git:ReadChecks', true, false, false, null),
  declaration('Git:PushBranch', true, false, false, null),
  declaration('Git:CreateDraft', true, false, false, null),
  declaration('Git:UpdateDraft', true, false, false, null),
  declaration('Git:MergeWithPrecondition', true, true, true, null),
];

const DEPLOYMENT_DECLARATIONS: readonly CapabilityDeclaration[] = [
  declaration('Deployment:Discover', true, false, false, null),
  declaration('Deployment:ReadIdentity', true, false, false, null),
  declaration('Deployment:Execute', true, true, false, null),
  declaration('Deployment:VerifyDestination', true, false, false, null),
];

const ENGINE_DECLARATIONS: readonly CapabilityDeclaration[] = [
  declaration('Engine:VersionCheck', true, false, false, null),
  declaration('Engine:StartScoped', true, false, false, null),
  declaration('Engine:StopGraceful', true, false, false, null),
  declaration(
    'Engine:ResumeSession',
    false,
    false,
    false,
    'the provider exposes no supported session-restoration interface, so a fresh session starts from the checkpoint',
  ),
  declaration('Engine:ReportUsage', true, false, false, null),
];

const VERIFICATION_DECLARATIONS: readonly CapabilityDeclaration[] = [
  declaration('Git:ReadChecks', true, false, false, null),
  declaration('Deployment:VerifyDestination', true, false, false, null),
];

const FAKE_GIT_REVIEWS: GitStateRead['reviews'] = [
  {
    kind: 'Review',
    decision: 'Approved',
    reviewer: 'fixture-reviewer',
    submittedAt: FIXED_EARLIER_INSTANT,
  },
];

/**
 * Builds one fresh in-memory adapter set.
 *
 * A suite case that revokes access or injects a rate limit mutates this state, so
 * the contract suite asks for a new set per case rather than sharing one.
 */
export function createFakeAdapterSet(): AdapterSet {
  const ledger = new SideEffectLedger();
  const conditions = new FakeConditions();
  const deployments = fixtureAvailabilityIdentities();

  const ticket = new FakeTicketAdapter(
    {
      connectorId: FIXTURE_TICKET_CONNECTOR,
      provider: FIXTURE_TICKET_PROVIDER,
      kind: 'Ticket',
      runtimeVersion: 'fixture-ticket/1.0.0',
      declarations: TICKET_DECLARATIONS,
      ledger,
      conditions,
    },
    [FIXTURE_TICKET_SCOPE_READ],
    // The Git repository identity, offered to the ticket adapter by the
    // wrong-provider case, belongs to the Git provider (N05-AC2).
    new Map([[providerId('repo_fixture_01'), 'Git']]),
    FIXTURE_TICKET_RELATED,
    FIXTURE_TICKET_TRANSITIONS,
  );

  const git = new FakeGitAdapter(
    {
      connectorId: FIXTURE_GIT_CONNECTOR,
      provider: FIXTURE_GIT_PROVIDER,
      kind: 'Git',
      runtimeVersion: 'fixture-git/1.0.0',
      declarations: GIT_DECLARATIONS,
      ledger,
      conditions,
    },
    FIXTURE_REPOSITORY,
    FIXTURE_HEAD_SHA,
    FIXTURE_BASE_SHA,
    FIXTURE_CHECK_OBSERVATIONS,
    FAKE_GIT_REVIEWS,
  );

  const deployment = new FakeDeploymentAdapter(
    {
      connectorId: FIXTURE_DEPLOYMENT_CONNECTOR,
      provider: FIXTURE_DEPLOYMENT_PROVIDER,
      kind: 'Deployment',
      runtimeVersion: 'fixture-deployment/1.0.0',
      declarations: DEPLOYMENT_DECLARATIONS,
      ledger,
      conditions,
    },
    deployments,
  );

  const engine = new FakeEngineAdapter(
    {
      connectorId: FIXTURE_ENGINE_CONNECTOR,
      provider: FIXTURE_ENGINE_PROVIDER,
      kind: 'Engine',
      runtimeVersion: FIXTURE_ENGINE_VERSION,
      declarations: ENGINE_DECLARATIONS,
      ledger,
      conditions,
    },
    FIXTURE_ENGINE_EVENT_LINES,
  );

  const verification = new FakeVerificationAdapter(
    {
      connectorId: FIXTURE_VERIFICATION_CONNECTOR,
      provider: FIXTURE_VERIFICATION_PROVIDER,
      kind: 'Verification',
      runtimeVersion: 'fixture-verification/1.0.0',
      declarations: VERIFICATION_DECLARATIONS,
      ledger,
      conditions,
    },
    FIXTURE_CHECK_OBSERVATIONS,
    deployments,
  );

  const events = new FakeProviderEventAdapter(
    {
      connectorId: FIXTURE_GIT_CONNECTOR,
      provider: FIXTURE_GIT_PROVIDER,
      kind: 'Git',
      runtimeVersion: 'fixture-git/1.0.0',
      declarations: GIT_DECLARATIONS,
      ledger,
      conditions,
    },
    { draftHeadSha: FIXTURE_SUPERSEDED_HEAD_SHA, sequence: 0, observedAt: FIXED_EARLIER_INSTANT },
  );

  return { ticket, git, deployment, engine, verification, events, effects: ledger, conditions };
}

export interface AdapterSet {
  readonly ticket: FakeTicketAdapter;
  readonly git: FakeGitAdapter;
  readonly deployment: FakeDeploymentAdapter;
  readonly engine: FakeEngineAdapter;
  readonly verification: FakeVerificationAdapter;
  readonly events: FakeProviderEventAdapter;
  readonly effects: SideEffectLedger;
  readonly conditions: AdapterConditions;
}

/** The contract surface the fakes stand in for, named once. */
export type AdapterContractSurface = {
  readonly ticket: TicketAdapter;
  readonly git: GitAdapter;
  readonly deployment: DeploymentAdapter;
  readonly engine: EngineAdapter;
  readonly verification: VerificationAdapter;
};

/**
 * Fails to compile unless every fake in a set still satisfies the contract it
 * stands in for. Each fake class also declares `implements`; this guards the set
 * itself, so retyping a member as a local look-alike fails the build.
 */
export type AssertFakesAreContracts = AdapterSet extends AdapterContractSurface
  ? true
  : 'the fakes no longer satisfy the adapter contracts';

/**
 * Fails to compile unless the fake git adapter also satisfies the MVP candidate port.
 *
 * Kept separate from the assertion above because `CandidateGitPort` is a *narrower* thing: the
 * fake is allowed to keep its write methods for the slices that test them, but it must be able to
 * stand in for the read-only port a candidate-linking controller is handed. Without this, an
 * integrator wiring the candidate journey against `AdapterSet` would find only at runtime that
 * the standard fake cannot answer a pull-request read.
 */
export type AssertFakeGitIsACandidatePort = FakeGitAdapter extends CandidateGitPort
  ? true
  : 'the fake git adapter can no longer stand in for the read-only candidate port';
