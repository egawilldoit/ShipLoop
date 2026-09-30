/**
 * In-memory fakes for the provider adapter contract.
 *
 * The shapes below are the documented provider contract from mvp-spec section 7
 * (ticket, git, deployment, engine, verification) plus the two cross-cutting
 * surfaces every adapter owes the controller: an explicit capability
 * declaration, and a typed `Result` that can say `OutcomeUnknown` rather than
 * throwing.
 *
 * These are fakes, not a live integration. They exist so ordering, rate limits,
 * timeouts and ambiguous results can be reproduced on demand
 * (mvp-spec 9, "Use provider simulators for ordering, rate limits, timeouts, and
 * ambiguous results"). A suite that passes here proves the adapter's contract
 * logic, never the provider's live compatibility.
 *
 * Why the shape is what it is:
 *
 *   - Writes carry an `OperationId` and are deduplicated against a ledger, so a
 *     replayed request provably produces one side effect (F30-AC2).
 *   - A lost response is recorded as a real side effect with an unknown outcome,
 *     so reconciliation has something to reconcile (F28-AC4, F30-AC5).
 *   - Unsupported capabilities are refused with `Unavailable` before any work,
 *     and `Engine:ResumeSession` falls back to a checkpoint instead of faking
 *     continuation (N05-AC2, F15-AC4).
 *   - Every call is counted so a contract case can assert an adapter did not
 *     retry a deterministic failure (F03-AC4, F30-AC4).
 */

import {
  candidateFingerprint,
  capabilitiesFor,
  conflict,
  err,
  isBlocking,
  ok,
  outcomeUnknown,
  type CandidateIdentity,
  type CapabilityDeclaration,
  type CapabilityKind,
  type CheckOrigin,
  type CheckRecord,
  type CheckResult,
  type CommitSha,
  type ConnectorHealth,
  type DomainError,
  type Fingerprint,
  type ForbiddenError,
  type NotFoundError,
  type OperationId,
  type RateLimitedError,
  type Result,
  type ScopeSnapshot,
  type UnavailableError,
} from '@shiploop/domain';
import {
  FIXED_EARLIER_INSTANT,
  FIXTURE_BASE_SHA,
  FIXTURE_CHECK_OBSERVATIONS,
  FIXTURE_DEPLOYMENTS,
  FIXTURE_DEPLOYMENT_PROVIDER,
  FIXTURE_ENGINE_PROVIDER,
  FIXTURE_GIT_PROVIDER,
  FIXTURE_HEAD_SHA,
  FIXTURE_MERGE_COMMIT_SHA,
  FIXTURE_REPOSITORY_REFERENCE,
  FIXTURE_SCOPE_SNAPSHOT,
  FIXTURE_SUPERSEDED_HEAD_SHA,
  FIXTURE_TICKET_PROVIDER,
  FIXTURE_VERIFICATION_PROVIDER,
} from './fixtures.ts';

const FAKE_OBSERVED_AT = '2026-09-30T12:05:00.000Z';
const FAKE_LAST_SUCCESS_AT = '2026-09-30T12:04:00.000Z';

export type ProviderKind = 'Ticket' | 'Git' | 'Deployment' | 'Engine' | 'Verification';

export interface AdapterIdentity {
  readonly provider: string;
  readonly kind: ProviderKind;
}

/** An opaque provider-owned resource identity. Names and URLs are display fields. */
export interface ProviderReference {
  readonly provider: string;
  readonly kind: ProviderKind;
  readonly id: string;
}

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
 * Refuses an identity this adapter does not own.
 *
 * A similarly named repository, issue or deployment belonging to another provider
 * is never substituted: guessing one is how the wrong code or the wrong
 * deployment gets accepted (F11-AC3, N05-AC2).
 */
function refuseForeign(identity: AdapterIdentity, reference: ProviderReference): ForbiddenError | null {
  if (reference.kind !== identity.kind) {
    return forbidden(
      `${reference.kind} identity ${reference.id} was offered to the ${identity.kind} adapter of ${identity.provider}, which does not own that resource kind.`,
    );
  }
  if (reference.provider !== identity.provider) {
    return forbidden(
      `${identity.provider} does not own ${reference.kind} identity ${reference.id}; it belongs to ${reference.provider}. A similarly named resource is not a substitute.`,
    );
  }
  return null;
}

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

/**
 * How a test induces provider conditions.
 *
 * These ports exist because the required behaviours are the ones a happy-path
 * fake cannot demonstrate: a lost response, a rate limit with its retry hint, a
 * revoked credential, and per-component delivery outcomes.
 */
export interface AdapterConditions {
  /** Make the next `count` external writes perform their side effect, then lose the response. */
  loseNextWriteResponse(count: number): void;
  /** Make the next `count` calls fail with the provider's rate-limit category. */
  rateLimitNextCall(count: number, retryAfterMs: number | null): void;
  /** Revoke a connector's access as the provider or an operator would. */
  revokeAccess(connectorId: string, error: string): void;
  /** Set the state each component reaches after the next delivery execution. */
  programComponentOutcomes(states: Readonly<Record<string, DeploymentState>>): void;
}

type RateLimitDecision = { readonly limited: false } | { readonly limited: true; readonly retryAfterMs: number | null };

export class FakeConditions implements AdapterConditions {
  private lostResponseBudget = 0;
  private rateLimitBudget = 0;
  private retryAfterMs: number | null = null;
  private readonly revoked = new Map<string, string>();
  private componentOutcomes: Readonly<Record<string, DeploymentState>> = {};

  loseNextWriteResponse(count: number): void {
    this.lostResponseBudget = count;
  }

  rateLimitNextCall(count: number, retryAfterMs: number | null): void {
    this.rateLimitBudget = count;
    this.retryAfterMs = retryAfterMs;
  }

  revokeAccess(connectorId: string, error: string): void {
    this.revoked.set(connectorId, error);
  }

  programComponentOutcomes(states: Readonly<Record<string, DeploymentState>>): void {
    this.componentOutcomes = states;
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

  accessError(connectorId: string): string | null {
    return this.revoked.get(connectorId) ?? null;
  }

  componentState(component: string): DeploymentState {
    return this.componentOutcomes[component] ?? 'Usable';
  }
}

/** What every adapter must expose to the controller and the owner UI. */
export interface AdapterBase {
  readonly connectorId: string;
  readonly identity: AdapterIdentity;
  /** Explicit support per capability; the UI rejects what is not declared (F03-AC2). */
  capabilities(): readonly CapabilityDeclaration[];
  /** `Unavailable` when the operation is not supported, before any work is attempted. */
  ensureSupported(kind: CapabilityKind): Result<void, DomainError>;
  health(): ConnectorHealth;
  /** How many times the adapter was asked to perform an operation, for retry assertions. */
  attempts(operation: string): number;
}

export interface WriteIntent {
  readonly operationId: OperationId;
  readonly target: string;
  readonly operation: string;
}

interface FakeAdapterInit {
  readonly connectorId: string;
  readonly identity: AdapterIdentity;
  readonly declarations: readonly CapabilityDeclaration[];
  readonly ledger: SideEffectLedger;
  readonly conditions: FakeConditions;
}

/** Shared gate: capability, access, attempt count, rate limit, then the action. */
export class FakeAdapterBase implements AdapterBase {
  readonly connectorId: string;
  readonly identity: AdapterIdentity;
  protected readonly ledger: SideEffectLedger;
  protected readonly conditions: FakeConditions;
  private readonly declarations: readonly CapabilityDeclaration[];
  private readonly attemptsByOperation = new Map<string, number>();

  constructor(init: FakeAdapterInit) {
    this.connectorId = init.connectorId;
    this.identity = init.identity;
    this.declarations = init.declarations;
    this.ledger = init.ledger;
    this.conditions = init.conditions;
  }

  capabilities(): readonly CapabilityDeclaration[] {
    return this.declarations;
  }

  ensureSupported(kind: CapabilityKind): Result<void, DomainError> {
    const declaration = this.declarations.find((entry) => entry.kind === kind);
    if (declaration === undefined) {
      return err(unavailable(`${this.identity.provider} does not declare ${kind}, so the controller must not attempt it.`));
    }
    if (!declaration.supported) {
      return err(
        unavailable(
          `${kind} is unavailable on ${this.identity.provider}: ${declaration.limitation ?? 'the provider does not offer it'}.`,
        ),
      );
    }
    return ok(undefined);
  }

  health(): ConnectorHealth {
    const summary = capabilitiesFor(this.declarations);
    const revoked = this.conditions.accessError(this.connectorId);
    return {
      connectorId: this.connectorId,
      provider: this.identity.provider,
      state: revoked === null ? 'Healthy' : 'Revoked',
      reads: summary.reads,
      writes: summary.writes,
      lastCheckedAt: FAKE_OBSERVED_AT,
      lastSuccessAt: revoked === null ? FAKE_OBSERVED_AT : FAKE_LAST_SUCCESS_AT,
      error: revoked,
    };
  }

  attempts(operation: string): number {
    return this.attemptsByOperation.get(operation) ?? 0;
  }

  protected countAttempt(operation: string): void {
    this.attemptsByOperation.set(operation, this.attempts(operation) + 1);
  }

  /**
   * Refuses revoked access without retrying it, and passes a rate limit through
   * with its category and retry hint instead of sleeping or spinning (F03-AC4,
   * F30-AC4).
   */
  protected gate<T>(
    kind: CapabilityKind,
    operation: string,
    action: () => Result<T, DomainError>,
  ): Result<T, DomainError> {
    this.countAttempt(operation);
    const supported = this.ensureSupported(kind);
    if (!supported.ok) return supported;
    const revoked = this.conditions.accessError(this.connectorId);
    if (revoked !== null) return err(forbidden(revoked));
    const limit = this.conditions.consumeRateLimit();
    if (limit.limited) {
      return err(
        rateLimited(
          `${this.identity.provider} rate limited ${operation}. The provider supplied no retry hint.`,
          limit.retryAfterMs,
        ),
      );
    }
    return action();
  }

  /**
   * Returns the value of a prior identical write, or `OutcomeUnknown` after a lost
   * response, so a repeated request can never reach the provider twice.
   *
   * The provider identity is minted before the lost-response check because the
   * provider assigned it even when the response never arrived; reconciliation needs
   * it to establish what happened (F19-AC3, F30-AC5).
   */
  protected replayOrRun<T>(
    completed: Map<string, T>,
    intent: WriteIntent,
    mintExternalId: () => string,
    produce: (externalId: string) => T,
  ): Result<T, DomainError> {
    const recorded = this.ledger.find(intent.operationId);
    if (recorded !== undefined) {
      const prior = completed.get(intent.operationId);
      if (recorded.outcome === 'Succeeded' && prior !== undefined) return ok(prior);
      return err(
        outcomeUnknown(
          `A previous attempt for ${intent.operation} lost its response. Reconcile provider state before retrying.`,
          intent.operationId,
          intent.target,
        ),
      );
    }
    const externalId = mintExternalId();
    if (this.conditions.consumeLostResponse()) return this.lostResponse<T>(intent, externalId);
    const value = produce(externalId);
    completed.set(intent.operationId, value);
    this.ledger.record({
      operationId: intent.operationId,
      operation: intent.operation,
      target: intent.target,
      outcome: 'Succeeded',
      externalId,
      occurredAt: FAKE_OBSERVED_AT,
    });
    return ok(value);
  }

  /** Records the write that already happened and reports the ambiguity honestly. */
  protected lostResponse<T>(intent: WriteIntent, externalId: string): Result<T, DomainError> {
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

/* -------------------------------------------------------------------------- */
/* Ticket                                                                      */
/* -------------------------------------------------------------------------- */

export interface TicketPublishRequest {
  readonly operationId: OperationId;
  readonly teamKey: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly { readonly id: string; readonly text: string }[];
  readonly dependsOnIssueIds: readonly string[];
}

export interface PublishedIssue {
  readonly reference: ProviderReference;
  readonly url: string;
  readonly publishedAt: string;
}

export interface ManagedProgressUpdate {
  readonly operationId: OperationId;
  readonly issue: ProviderReference;
  readonly body: string;
  readonly milestone: string;
}

export interface ManagedProgressResult {
  readonly commentId: string;
  readonly updatedAt: string;
  readonly issueId: string;
}

export interface TransitionRequest {
  readonly operationId: OperationId;
  readonly issue: ProviderReference;
  readonly toState: string;
}

export interface TicketAdapter extends AdapterBase {
  readScope(reference: ProviderReference): Result<ScopeSnapshot, DomainError>;
  publishIssue(request: TicketPublishRequest): Result<PublishedIssue, DomainError>;
  updateManagedProgress(update: ManagedProgressUpdate): Result<ManagedProgressResult, DomainError>;
  requestTransition(request: TransitionRequest): Result<PublishedIssue, DomainError>;
}

class FakeTicketAdapter extends FakeAdapterBase implements TicketAdapter {
  private readonly completedIssues = new Map<string, PublishedIssue>();
  private readonly completedProgress = new Map<string, ManagedProgressResult>();

  constructor(init: FakeAdapterInit) {
    super(init);
  }

  readScope(reference: ProviderReference): Result<ScopeSnapshot, DomainError> {
    return this.gate('Ticket:ReadScope', 'readScope', () => {
      const foreign = refuseForeign(this.identity, reference);
      if (foreign !== null) return err(foreign);
      if (reference.id !== FIXTURE_SCOPE_SNAPSHOT.issueId) {
        return err(absent(`${this.identity.provider} has no issue ${reference.id}.`));
      }
      return ok(FIXTURE_SCOPE_SNAPSHOT);
    });
  }

  publishIssue(request: TicketPublishRequest): Result<PublishedIssue, DomainError> {
    return this.gate('Ticket:PublishIssue', 'publishIssue', () => {
      const intent: WriteIntent = {
        operationId: request.operationId,
        target: `${this.identity.provider}:${request.teamKey}`,
        operation: 'publishIssue',
      };
      return this.replayOrRun(
        this.completedIssues,
        intent,
        () => `issue_${request.operationId}`,
        (externalId) => ({
          reference: { provider: this.identity.provider, kind: 'Ticket' as const, id: externalId },
          url: `https://tickets.fixture.invalid/${request.teamKey}/${externalId}`,
          publishedAt: FAKE_OBSERVED_AT,
        }),
      );
    });
  }

  updateManagedProgress(update: ManagedProgressUpdate): Result<ManagedProgressResult, DomainError> {
    return this.gate('Ticket:UpdateManagedProgress', 'updateManagedProgress', () => {
      const foreign = refuseForeign(this.identity, update.issue);
      if (foreign !== null) return err(foreign);
      const intent: WriteIntent = {
        operationId: update.operationId,
        target: update.issue.id,
        operation: 'updateManagedProgress',
      };
      return this.replayOrRun(
        this.completedProgress,
        intent,
        () => `comment_${update.operationId}`,
        (externalId) => ({ commentId: externalId, updatedAt: FAKE_OBSERVED_AT, issueId: update.issue.id }),
      );
    });
  }

  requestTransition(_request: TransitionRequest): Result<PublishedIssue, DomainError> {
    return this.gate('Ticket:RequestTransition', 'requestTransition', () =>
      err(
        unavailable(
          `${this.identity.provider} agent sessions are a Developer Preview, so ShipLoop cannot request a ticket transition through it. The owner changes the state in ${this.identity.provider}.`,
        ),
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Git                                                                         */
/* -------------------------------------------------------------------------- */

export interface RepositoryReadRequest {
  readonly reference: ProviderReference;
  readonly branch: string;
}

export interface BranchFacts {
  readonly reference: ProviderReference;
  readonly fullName: string;
  readonly branch: string;
  readonly headSha: CommitSha;
  readonly baseBranch: string;
  readonly baseSha: CommitSha;
  readonly mergeable: boolean;
  readonly requiredReviewSatisfied: boolean;
}

export interface ChecksReadRequest {
  readonly reference: ProviderReference;
  readonly headSha: CommitSha;
}

export interface CheckObservationBatch {
  readonly provider: string;
  readonly headSha: CommitSha;
  readonly checks: readonly ObservableCheck[];
}

/** What the provider reports. The verification adapter maps it, not the Git adapter. */
export interface ObservableCheck {
  readonly checkId: string;
  readonly name: string;
  readonly origin: CheckOrigin;
  readonly required: boolean;
  readonly state: CheckResult;
  /** The head this check actually ran against, which may not be the candidate head. */
  readonly observedHeadSha: CommitSha | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly artifactRef: string | null;
  readonly detail: string | null;
  readonly notApplicableApprovedByPolicy: boolean;
}

export interface PushRequest {
  readonly operationId: OperationId;
  readonly repository: ProviderReference;
  readonly branch: string;
  readonly headSha: CommitSha;
}

export interface PushedBranch {
  readonly repositoryId: string;
  readonly branch: string;
  readonly headSha: CommitSha;
  readonly pushedAt: string;
}

export interface DraftRequest {
  readonly operationId: OperationId;
  readonly repository: ProviderReference;
  readonly branch: string;
  readonly baseBranch: string;
  readonly headSha: CommitSha;
  readonly body: string;
}

export interface DraftUpdateRequest {
  readonly operationId: OperationId;
  readonly draft: ProviderReference;
  readonly headSha: CommitSha;
  readonly body: string;
}

export interface DraftRecord {
  readonly reference: ProviderReference;
  readonly repositoryId: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly headSha: CommitSha;
  readonly url: string;
}

export interface MergeRequest {
  readonly operationId: OperationId;
  readonly draft: ProviderReference;
  /** Provider compare-and-set on head; refused when the head moved (F26-AC3). */
  readonly expectedHeadSha: CommitSha;
  readonly mergeMethod: 'Squash' | 'Merge' | 'Rebase';
}

export interface MergeOutcome {
  readonly reference: ProviderReference;
  readonly mergeCommitSha: CommitSha;
  readonly mergedAt: string;
}

export interface ReconciledWrite {
  readonly operationId: string;
  readonly target: string;
  readonly externalId: string;
  readonly occurredAt: string;
}

export interface GitAdapter extends AdapterBase {
  readRepository(request: RepositoryReadRequest): Result<BranchFacts, DomainError>;
  readChecks(request: ChecksReadRequest): Result<CheckObservationBatch, DomainError>;
  pushBranch(request: PushRequest): Result<PushedBranch, DomainError>;
  createDraft(request: DraftRequest): Result<DraftRecord, DomainError>;
  updateDraft(request: DraftUpdateRequest): Result<DraftRecord, DomainError>;
  listDrafts(repository: ProviderReference): Result<readonly DraftRecord[], DomainError>;
  merge(request: MergeRequest): Result<MergeOutcome, DomainError>;
  reconcile(operationId: OperationId): Result<ReconciledWrite, DomainError>;
}

class FakeGitAdapter extends FakeAdapterBase implements GitAdapter {
  private readonly branches = new Map<string, BranchFacts>();
  private readonly checkBatches = new Map<string, CheckObservationBatch>();
  private readonly drafts = new Map<string, DraftRecord>();
  private readonly completedDrafts = new Map<string, DraftRecord>();
  private readonly completedPushes = new Map<string, PushedBranch>();
  private readonly completedMerges = new Map<string, MergeOutcome>();
  private draftCount = 0;

  constructor(init: FakeAdapterInit, facts: readonly BranchFacts[], batches: readonly CheckObservationBatch[]) {
    super(init);
    for (const entry of facts) this.branches.set(`${entry.reference.id}:${entry.branch}`, entry);
    for (const batch of batches) this.checkBatches.set(`${this.identity.provider}:${batch.headSha}`, batch);
  }

  readRepository(request: RepositoryReadRequest): Result<BranchFacts, DomainError> {
    return this.gate('Git:ReadRepository', 'readRepository', () => {
      const foreign = refuseForeign(this.identity, request.reference);
      if (foreign !== null) return err(foreign);
      const facts = this.branches.get(`${request.reference.id}:${request.branch}`);
      if (facts === undefined) {
        return err(absent(`${this.identity.provider} has no branch ${request.branch} in ${request.reference.id}.`));
      }
      return ok(facts);
    });
  }

  readChecks(request: ChecksReadRequest): Result<CheckObservationBatch, DomainError> {
    return this.gate('Git:ReadChecks', 'readChecks', () => {
      const foreign = refuseForeign(this.identity, request.reference);
      if (foreign !== null) return err(foreign);
      const batch = this.checkBatches.get(`${request.reference.provider}:${request.headSha}`);
      if (batch === undefined) {
        return err(absent(`No check results are reported for head ${request.headSha.slice(0, 12)}.`));
      }
      return ok(batch);
    });
  }

  pushBranch(request: PushRequest): Result<PushedBranch, DomainError> {
    return this.gate('Git:PushBranch', 'pushBranch', () => {
      const foreign = refuseForeign(this.identity, request.repository);
      if (foreign !== null) return err(foreign);
      const intent: WriteIntent = {
        operationId: request.operationId,
        target: `${request.repository.id}:${request.branch}`,
        operation: 'pushBranch',
      };
      return this.replayOrRun(
        this.completedPushes,
        intent,
        () => `${request.repository.id}:${request.branch}@${request.headSha.slice(0, 12)}`,
        () => ({
          repositoryId: request.repository.id,
          branch: request.branch,
          headSha: request.headSha,
          pushedAt: FAKE_OBSERVED_AT,
        }),
      );
    });
  }

  createDraft(request: DraftRequest): Result<DraftRecord, DomainError> {
    return this.gate('Git:CreateDraft', 'createDraft', () => {
      const foreign = refuseForeign(this.identity, request.repository);
      if (foreign !== null) return err(foreign);
      const intent: WriteIntent = {
        operationId: request.operationId,
        target: `${request.repository.id}:${request.branch}`,
        operation: 'createDraft',
      };
      return this.replayOrRun(
        this.completedDrafts,
        intent,
        () => `draft_${this.nextDraftNumber()}`,
        (externalId) => {
          const draft: DraftRecord = {
            reference: { provider: this.identity.provider, kind: 'Git' as const, id: externalId },
            repositoryId: request.repository.id,
            branch: request.branch,
            baseBranch: request.baseBranch,
            headSha: request.headSha,
            url: `https://git.fixture.invalid/${request.repository.id}/pull/${externalId}`,
          };
          this.drafts.set(`${request.repository.id}:${request.branch}`, draft);
          return draft;
        },
      );
    });
  }

  updateDraft(request: DraftUpdateRequest): Result<DraftRecord, DomainError> {
    return this.gate('Git:UpdateDraft', 'updateDraft', () => {
      const foreign = refuseForeign(this.identity, request.draft);
      if (foreign !== null) return err(foreign);
      const existing = this.findDraft(request.draft.id);
      if (existing === undefined) return err(absent(`No draft change ${request.draft.id} exists.`));
      const updated: DraftRecord = { ...existing, headSha: request.headSha };
      this.drafts.set(`${existing.repositoryId}:${existing.branch}`, updated);
      return ok(updated);
    });
  }

  listDrafts(repository: ProviderReference): Result<readonly DraftRecord[], DomainError> {
    return this.gate('Git:ReadRepository', 'listDrafts', () => {
      const foreign = refuseForeign(this.identity, repository);
      if (foreign !== null) return err(foreign);
      return ok([...this.drafts.values()].filter((draft) => draft.repositoryId === repository.id));
    });
  }

  merge(request: MergeRequest): Result<MergeOutcome, DomainError> {
    return this.gate('Git:MergeWithPrecondition', 'merge', () => {
      const foreign = refuseForeign(this.identity, request.draft);
      if (foreign !== null) return err(foreign);
      const draft = this.findDraft(request.draft.id);
      if (draft === undefined) return err(absent(`No draft change ${request.draft.id} exists.`));
      if (draft.headSha !== request.expectedHeadSha) {
        return err(
          conflict(
            'The merge precondition head no longer matches the draft head, so the merge was refused.',
            request.expectedHeadSha,
            draft.headSha,
          ),
        );
      }
      const intent: WriteIntent = {
        operationId: request.operationId,
        target: `${draft.repositoryId}#${draft.branch}`,
        operation: 'merge',
      };
      return this.replayOrRun(
        this.completedMerges,
        intent,
        () => `merge_${draft.reference.id}`,
        (externalId) => ({
          reference: { provider: this.identity.provider, kind: 'Git' as const, id: externalId },
          mergeCommitSha: FIXTURE_MERGE_COMMIT_SHA,
          mergedAt: FAKE_OBSERVED_AT,
        }),
      );
    });
  }

  reconcile(operationId: OperationId): Result<ReconciledWrite, DomainError> {
    return this.gate('Git:ReadRepository', 'reconcile', () => {
      const recorded = this.ledger.find(operationId);
      if (recorded === undefined) {
        return err(absent(`No external operation with identity ${operationId} was recorded.`));
      }
      if (recorded.externalId === null) {
        return err(absent(`Operation ${operationId} has no provider identity to reconcile against.`));
      }
      return ok({
        operationId: recorded.operationId,
        target: recorded.target,
        externalId: recorded.externalId,
        occurredAt: recorded.occurredAt,
      });
    });
  }

  private nextDraftNumber(): number {
    this.draftCount += 1;
    return this.draftCount;
  }

  private findDraft(draftId: string): DraftRecord | undefined {
    for (const draft of this.drafts.values()) {
      if (draft.reference.id === draftId) return draft;
    }
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Deployment                                                                  */
/* -------------------------------------------------------------------------- */

export const DEPLOYMENT_STATES = ['Missing', 'Building', 'Failed', 'Protected', 'Usable'] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

export interface DeploymentQuery {
  readonly project: string;
  readonly component: string;
  readonly headSha: CommitSha;
  readonly environment: string;
}

export interface DeploymentIdentity {
  readonly reference: ProviderReference | null;
  readonly state: DeploymentState;
  readonly url: string | null;
  readonly headSha: CommitSha | null;
  readonly environment: string;
  readonly component: string;
  readonly access: 'Open' | 'Protected' | 'Unknown';
  readonly observedAt: string;
  readonly detail: string;
}

export interface DeploymentReadRequest {
  readonly query: DeploymentQuery;
  /** Known provider identity; null means no exact deployment identity was established. */
  readonly reference: ProviderReference | null;
}

/** The translation from provider identity to what the owner may be offered. */
export interface PreviewApplication {
  readonly state: DeploymentState;
  readonly usable: boolean;
  readonly detail: string;
}

export interface DeploymentExecution {
  readonly operationId: OperationId;
  readonly destination: string;
  readonly environment: string;
  readonly components: readonly string[];
  readonly expectedHeadSha: CommitSha;
  readonly action: 'Redeploy' | 'Promote';
}

export interface DeploymentComponentOutcome {
  readonly component: string;
  readonly state: DeploymentState;
  readonly deploymentId: string | null;
  readonly detail: string;
}

export interface DeploymentExecutionOutcome {
  readonly operationId: string;
  readonly destination: string;
  readonly components: readonly DeploymentComponentOutcome[];
  readonly released: boolean;
  readonly observedAt: string;
}

export interface DestinationVerificationRequest {
  readonly operationId: OperationId;
  readonly destination: string;
  readonly components: readonly { readonly component: string; readonly expectedDeploymentId: string | null }[];
}

export interface SmokeObservation {
  readonly component: string;
  readonly deploymentId: string | null;
  readonly served: boolean;
  readonly result: 'Passed' | 'Failed';
  readonly detail: string;
}

export interface DestinationVerificationResult {
  readonly destination: string;
  readonly verified: boolean;
  readonly components: readonly SmokeObservation[];
  readonly reason: string | null;
}

export interface DeploymentAdapter extends AdapterBase {
  discover(query: DeploymentQuery): Result<readonly DeploymentIdentity[], DomainError>;
  readIdentity(request: DeploymentReadRequest): Result<DeploymentIdentity, DomainError>;
  previewApplication(identity: DeploymentIdentity): PreviewApplication;
  applyExecution(execution: DeploymentExecution): Result<DeploymentExecutionOutcome, DomainError>;
  verifyDestination(request: DestinationVerificationRequest): Result<DestinationVerificationResult, DomainError>;
}

class FakeDeploymentAdapter extends FakeAdapterBase implements DeploymentAdapter {
  private readonly known = new Map<string, DeploymentIdentity>();
  private readonly completedExecutions = new Map<string, DeploymentExecutionOutcome>();

  constructor(init: FakeAdapterInit, identities: readonly DeploymentIdentity[]) {
    super(init);
    for (const identity of identities) {
      if (identity.reference !== null) this.known.set(identity.reference.id, identity);
    }
  }

  discover(query: DeploymentQuery): Result<readonly DeploymentIdentity[], DomainError> {
    return this.gate('Deployment:Discover', 'discover', () =>
      ok(
        FIXTURE_DEPLOYMENTS.filter(
          (identity) => identity.component === query.component && identity.environment === query.environment,
        ),
      ),
    );
  }

  readIdentity(request: DeploymentReadRequest): Result<DeploymentIdentity, DomainError> {
    return this.gate('Deployment:ReadIdentity', 'readIdentity', () => {
      if (request.reference === null) {
        return ok(missingDeployment(request.query));
      }
      const foreign = refuseForeign(this.identity, request.reference);
      if (foreign !== null) return err(foreign);
      const identity = this.known.get(request.reference.id);
      if (identity === undefined) {
        return err(absent(`No deployment with identity ${request.reference.id} exists.`));
      }
      return ok(identity);
    });
  }

  previewApplication(identity: DeploymentIdentity): PreviewApplication {
    const usable = identity.state === 'Usable' && identity.access === 'Open';
    const deploymentId = identity.reference?.id ?? 'an unidentified deployment';
    return {
      state: identity.state,
      usable,
      detail: usable
        ? `Deployment ${deploymentId} serves the candidate application to an authenticated owner.`
        : identity.detail,
    };
  }

  applyExecution(execution: DeploymentExecution): Result<DeploymentExecutionOutcome, DomainError> {
    return this.gate('Deployment:Execute', 'applyExecution', () => {
      const intent: WriteIntent = {
        operationId: execution.operationId,
        target: execution.destination,
        operation: 'applyExecution',
      };
      return this.replayOrRun(
        this.completedExecutions,
        intent,
        () => `deploy_${execution.operationId}`,
        (_externalId) => {
          const components: DeploymentComponentOutcome[] = execution.components.map((component) => {
            const state = this.conditions.componentState(component);
            const deploymentId =
              state === 'Missing' ? null : `${execution.environment}_${component}_${execution.expectedHeadSha.slice(0, 8)}`;
            return {
              component,
              state,
              deploymentId,
              detail:
                state === 'Usable'
                  ? `The provider reports ${component} as deployed and serving on ${execution.destination}.`
                  : `The provider reports ${component} as ${state} on ${execution.destination}.`,
            };
          });
          return {
            operationId: execution.operationId,
            destination: execution.destination,
            components,
            released: components.length > 0 && components.every((component) => component.state === 'Usable'),
            observedAt: FAKE_OBSERVED_AT,
          };
        },
      );
    });
  }

  verifyDestination(request: DestinationVerificationRequest): Result<DestinationVerificationResult, DomainError> {
    return this.gate('Deployment:VerifyDestination', 'verifyDestination', () => {
      const recorded = this.completedExecutions.get(request.operationId);
      if (recorded === undefined) {
        return err(
          absent(`No executed delivery with operation ${request.operationId} is recorded, so ${request.destination} cannot be verified.`),
        );
      }
      const expected = new Map(request.components.map((entry) => [entry.component, entry.expectedDeploymentId]));
      const components: SmokeObservation[] = recorded.components.map((component) => {
        const expectedId = expected.get(component.component);
        const identityMatches = expectedId === undefined || expectedId === component.deploymentId;
        const served = component.state === 'Usable' && identityMatches;
        return {
          component: component.component,
          deploymentId: component.deploymentId,
          served,
          result: served ? ('Passed' as const) : ('Failed' as const),
          detail: identityMatches
            ? component.detail
            : `${component.component} served ${component.deploymentId ?? 'no deployment'} but ${expectedId ?? 'the expected identity'} was required.`,
        };
      });
      const failed = components.filter((component) => component.result === 'Failed');
      return ok({
        destination: request.destination,
        verified: components.length > 0 && failed.length === 0,
        components,
        reason:
          failed.length === 0
            ? null
            : `${failed.map((component) => component.component).join(', ')} did not serve ${request.destination}; the delivery is not confirmed.`,
      });
    });
  }
}

function missingDeployment(query: DeploymentQuery): DeploymentIdentity {
  return {
    reference: null,
    state: 'Missing',
    url: null,
    headSha: null,
    environment: query.environment,
    component: query.component,
    access: 'Unknown',
    observedAt: FAKE_OBSERVED_AT,
    detail: `No deployment identity matched ${query.component} at ${query.headSha.slice(0, 12)} in ${query.environment}, so no preview is offered.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                      */
/* -------------------------------------------------------------------------- */

export type EngineOutcome = 'Succeeded' | 'Failed' | 'MalformedOutput' | 'NoCompletionReported';

export type EngineUsage =
  | { readonly kind: 'Reported'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: 'Unknown' };

export interface MalformedLine {
  readonly index: number;
  readonly line: string;
}

export interface EngineRunResult {
  readonly sessionId: string | null;
  readonly outcome: EngineOutcome;
  readonly succeeded: boolean;
  /** The stream literally contained a completion event claiming success. */
  readonly completionReported: boolean;
  readonly completionSucceeded: boolean;
  readonly milestones: readonly string[];
  readonly artifacts: readonly string[];
  readonly usage: EngineUsage;
  readonly malformed: readonly MalformedLine[];
  readonly failureReason: string | null;
  readonly codeProduced: boolean;
  readonly noCodeReason: string | null;
}

export interface EngineVersionFacts {
  readonly engineVersion: string;
  readonly runtimeVersion: string;
  readonly authenticated: boolean;
  readonly structuredEventsAvailable: boolean;
  readonly observedAt: string;
}

export interface EngineResumeRequest {
  readonly priorSessionId: string;
  readonly checkpointRef: string;
}

export interface EngineResumeOutcome {
  readonly resumed: boolean;
  readonly sessionId: string;
  readonly usedCheckpoint: true;
  readonly reason: string;
}

export interface EngineAdapter extends AdapterBase {
  checkVersion(): Result<EngineVersionFacts, DomainError>;
  /** Start, observation and stop lifecycles are proven by the engine integration slice. */
  parseEventStream(lines: readonly string[]): Result<EngineRunResult, DomainError>;
  resume(request: EngineResumeRequest): Result<EngineResumeOutcome, DomainError>;
}

type ParsedEngineEvent =
  | { readonly type: 'session.started'; readonly sessionId: string }
  | { readonly type: 'milestone'; readonly message: string }
  | { readonly type: 'artifact'; readonly path: string }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'no-code-change'; readonly reason: string }
  | { readonly type: 'completion'; readonly succeeded: boolean; readonly status: string };

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
function readEngineEvent(line: string): ParsedEngineEvent | null {
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
      const message = asMember(record, 'message');
      return message === null ? null : { type: 'milestone', message };
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
      const reason = asMember(record, 'reason');
      return reason === null ? null : { type: 'no-code-change', reason };
    }
    case 'completion': {
      const status = asMember(record, 'status');
      return status === null ? null : { type: 'completion', succeeded: status === 'success', status };
    }
    default:
      return null;
  }
}

/**
 * Translates native engine output into a run result.
 *
 * A malformed line disqualifies the run from reporting success, even when the
 * stream contains a completion event claiming success (F15-AC2). Usage becomes
 * `Unknown` in that case too: a stream containing an unparseable line cannot be
 * trusted to carry a complete usage record, and reporting a partial token count
 * as fact is the kind of invention F18-AC4 forbids.
 */
function translateEngineStream(lines: readonly string[]): EngineRunResult {
  const milestones: string[] = [];
  const artifacts: string[] = [];
  const malformed: MalformedLine[] = [];
  let sessionId: string | null = null;
  let usage: EngineUsage = { kind: 'Unknown' };
  let completionReported = false;
  let completionSucceeded = false;
  let completionStatus: string | null = null;
  let noCodeReason: string | null = null;

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const event = readEngineEvent(line);
    if (event === null) {
      malformed.push({ index, line });
      continue;
    }
    switch (event.type) {
      case 'session.started':
        sessionId = event.sessionId;
        break;
      case 'milestone':
        milestones.push(event.message);
        break;
      case 'artifact':
        artifacts.push(event.path);
        break;
      case 'usage':
        usage = { kind: 'Reported', inputTokens: event.inputTokens, outputTokens: event.outputTokens };
        break;
      case 'no-code-change':
        noCodeReason = event.reason;
        break;
      case 'completion':
        completionReported = true;
        completionSucceeded = event.succeeded;
        completionStatus = event.status;
        break;
    }
  }

  const outcome: EngineOutcome =
    malformed.length > 0
      ? 'MalformedOutput'
      : !completionReported
        ? 'NoCompletionReported'
        : completionSucceeded
          ? 'Succeeded'
          : 'Failed';

  const failureReason =
    outcome === 'MalformedOutput'
      ? `Engine output could not be parsed at line ${String(malformed[0]?.index ?? 0)}: ${malformed[0]?.line ?? ''}`
      : outcome === 'NoCompletionReported'
        ? 'The engine reported no completion event, so the run cannot be called successful.'
        : outcome === 'Failed'
          ? `The engine reported completion status "${completionStatus ?? 'unknown'}".`
          : null;

  return {
    sessionId,
    outcome,
    succeeded: outcome === 'Succeeded',
    completionReported,
    completionSucceeded,
    milestones,
    artifacts,
    usage: malformed.length > 0 ? { kind: 'Unknown' } : usage,
    malformed,
    failureReason,
    codeProduced: noCodeReason === null,
    noCodeReason,
  };
}

class FakeEngineAdapter extends FakeAdapterBase implements EngineAdapter {
  private sessionCounter = 0;

  constructor(init: FakeAdapterInit) {
    super(init);
  }

  checkVersion(): Result<EngineVersionFacts, DomainError> {
    return this.gate('Engine:VersionCheck', 'checkVersion', () =>
      ok({
        engineVersion: 'fixture-engine/1.0.0',
        runtimeVersion: 'node24',
        authenticated: true,
        structuredEventsAvailable: true,
        observedAt: FAKE_OBSERVED_AT,
      }),
    );
  }

  parseEventStream(lines: readonly string[]): Result<EngineRunResult, DomainError> {
    return this.gate('Engine:StartScoped', 'parseEventStream', () => ok(translateEngineStream(lines)));
  }

  /**
   * Continuation is not restored when the provider does not support it. The
   * adapter starts a fresh session from the checkpoint and says so, rather than
   * reporting a continuation that never happened (F15-AC4).
   */
  resume(request: EngineResumeRequest): Result<EngineResumeOutcome, DomainError> {
    this.countAttempt('resume');
    const supported = this.ensureSupported('Engine:ResumeSession');
    this.sessionCounter += 1;
    if (supported.ok) {
      return ok({
        resumed: true,
        sessionId: `sess_fixture_resumed_${this.sessionCounter}`,
        usedCheckpoint: true,
        reason: 'The provider restored the prior session.',
      });
    }
    return ok({
      resumed: false,
      sessionId: `sess_fixture_fresh_${this.sessionCounter}`,
      usedCheckpoint: true,
      reason: `Session restoration is not supported: ${supported.error.reason} Started a fresh session from checkpoint ${request.checkpointRef}.`,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

export interface VerificationRequest {
  readonly candidate: CandidateIdentity;
  readonly batch: CheckObservationBatch;
}

export interface CheckSetReport {
  readonly provider: string;
  readonly headSha: CommitSha;
  readonly candidateFingerprint: Fingerprint;
  readonly checks: readonly CheckRecord[];
  readonly blocking: readonly string[];
  readonly readyForDelivery: boolean;
}

export interface VerificationAdapter extends AdapterBase {
  mapObservations(request: VerificationRequest): Result<CheckSetReport, DomainError>;
}

/**
 * Binds a provider-reported check to the candidate it actually belongs to.
 *
 * The fingerprint is derived from the head the check ran against, not from the
 * candidate being reviewed. A result observed on an older head therefore keeps a
 * different fingerprint and cannot silently approve the current candidate
 * (F20-AC3).
 */
function toCheckRecord(observation: ObservableCheck, candidate: CandidateIdentity): CheckRecord {
  const observed =
    observation.observedHeadSha === null || observation.observedHeadSha === candidate.headSha
      ? candidateFingerprint(candidate)
      : candidateFingerprint({ ...candidate, headSha: observation.observedHeadSha });
  return {
    checkId: observation.checkId,
    name: observation.name,
    origin: observation.origin,
    required: observation.required,
    result: observation.state,
    candidateFingerprint: observed,
    startedAt: observation.startedAt,
    endedAt: observation.endedAt,
    exitCode: observation.exitCode,
    artifactRef: observation.artifactRef,
    detail: observation.detail,
    notApplicableApprovedByPolicy: observation.notApplicableApprovedByPolicy,
  };
}

class FakeVerificationAdapter extends FakeAdapterBase implements VerificationAdapter {
  constructor(init: FakeAdapterInit) {
    super(init);
  }

  /**
   * Maps provider check states onto the domain's six results.
   *
   * `NotApplicable` on a required check is refused unless profile policy approved
   * it, because a coding run must not be able to remove a gate that would then
   * report itself as passing (F20-AC2, F20-AC5).
   */
  mapObservations(request: VerificationRequest): Result<CheckSetReport, DomainError> {
    return this.gate('Git:ReadChecks', 'mapObservations', () => {
      if (request.batch.headSha !== request.candidate.headSha) {
        return err(
          conflict(
            'The reported check results belong to a different head than the candidate under review.',
            request.candidate.headSha,
            request.batch.headSha,
          ),
        );
      }
      const unapproved = request.batch.checks.find(
        (check) => check.state === 'NotApplicable' && check.required && !check.notApplicableApprovedByPolicy,
      );
      if (unapproved !== undefined) {
        return err(
          {
            code: 'Blocked',
            reason: `Required check "${unapproved.name}" was reported Not applicable without a profile policy decision.`,
            prerequisites: [
              {
                name: 'RequiredCheckPolicy',
                detail: `${unapproved.checkId} was marked Not applicable by the coding run.`,
                remedy: 'The owner must approve Not applicable for this check in the project profile, or the check must run.',
              },
            ],
          },
        );
      }
      const fingerprintValue = candidateFingerprint(request.candidate);
      const checks = request.batch.checks.map((observation) => toCheckRecord(observation, request.candidate));
      const blocking = checks
        .filter((check) => check.required && isBlocking(check.result))
        .map((check) => `${check.name} is ${check.result} for this candidate`);
      return ok({
        provider: request.batch.provider,
        headSha: request.batch.headSha,
        candidateFingerprint: fingerprintValue,
        checks,
        blocking,
        readyForDelivery: blocking.length === 0,
      });
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Provider events                                                             */
/* -------------------------------------------------------------------------- */

export interface ProviderEvent {
  readonly deliveryId: string;
  readonly sequence: number;
  readonly draftHeadSha: CommitSha;
  readonly observedAt: string;
}

export interface ReconciledFacts {
  readonly draftHeadSha: CommitSha;
  readonly sequence: number;
  readonly observedAt: string;
}

/**
 * Webhook ingestion (F30-AC2, F30-AC3).
 *
 * A replayed delivery identity is accepted without being applied twice, and an
 * event that is not newer than the facts already held is recorded but does not
 * revert them.
 */
export interface ProviderEventAdapter {
  readonly identity: AdapterIdentity;
  ingest(event: ProviderEvent): Result<ReconciledFacts, DomainError>;
  currentFacts(): ReconciledFacts;
  appliedDeliveries(): readonly string[];
}

class FakeProviderEventAdapter implements ProviderEventAdapter {
  readonly identity: AdapterIdentity;
  private draftHeadSha: CommitSha;
  private sequence: number;
  private observedAt: string;
  private readonly seenDeliveries = new Set<string>();
  private readonly applied: string[] = [];

  constructor(identity: AdapterIdentity, initial: ReconciledFacts) {
    this.identity = identity;
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

export interface AdapterSet {
  readonly ticket: TicketAdapter;
  readonly git: GitAdapter;
  readonly deployment: DeploymentAdapter;
  readonly engine: EngineAdapter;
  readonly verification: VerificationAdapter;
  readonly events: ProviderEventAdapter;
  readonly effects: SideEffectLedger;
  readonly conditions: AdapterConditions;
}

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

const FIXTURE_BRANCH_FACTS: readonly BranchFacts[] = [
  {
    reference: FIXTURE_REPOSITORY_REFERENCE,
    fullName: 'fixture/repo',
    branch: 'develop',
    headSha: FIXTURE_HEAD_SHA,
    baseBranch: 'develop',
    baseSha: FIXTURE_BASE_SHA,
    mergeable: true,
    requiredReviewSatisfied: true,
  },
];

const FIXTURE_CHECK_BATCHES: readonly CheckObservationBatch[] = [FIXTURE_CHECK_OBSERVATIONS];

/**
 * Builds one fresh in-memory adapter set.
 *
 * A suite case that revokes access or injects a rate limit mutates this state, so
 * the contract suite asks for a new set per case rather than sharing one.
 */
export function createFakeAdapterSet(): AdapterSet {
  const ledger = new SideEffectLedger();
  const conditions = new FakeConditions();

  const ticket = new FakeTicketAdapter({
    connectorId: 'connector_fixture_ticket',
    identity: { provider: FIXTURE_TICKET_PROVIDER, kind: 'Ticket' },
    declarations: TICKET_DECLARATIONS,
    ledger,
    conditions,
  });

  const git = new FakeGitAdapter(
    {
      connectorId: 'connector_fixture_git',
      identity: { provider: FIXTURE_GIT_PROVIDER, kind: 'Git' },
      declarations: GIT_DECLARATIONS,
      ledger,
      conditions,
    },
    FIXTURE_BRANCH_FACTS,
    FIXTURE_CHECK_BATCHES,
  );

  const deployment = new FakeDeploymentAdapter(
    {
      connectorId: 'connector_fixture_deployment',
      identity: { provider: FIXTURE_DEPLOYMENT_PROVIDER, kind: 'Deployment' },
      declarations: DEPLOYMENT_DECLARATIONS,
      ledger,
      conditions,
    },
    FIXTURE_DEPLOYMENTS,
  );

  const engine = new FakeEngineAdapter({
    connectorId: 'connector_fixture_engine',
    identity: { provider: FIXTURE_ENGINE_PROVIDER, kind: 'Engine' },
    declarations: ENGINE_DECLARATIONS,
    ledger,
    conditions,
  });

  const verification = new FakeVerificationAdapter({
    connectorId: 'connector_fixture_verification',
    identity: { provider: FIXTURE_VERIFICATION_PROVIDER, kind: 'Verification' },
    declarations: VERIFICATION_DECLARATIONS,
    ledger,
    conditions,
  });

  const events = new FakeProviderEventAdapter(
    { provider: FIXTURE_GIT_PROVIDER, kind: 'Git' },
    {
      draftHeadSha: FIXTURE_SUPERSEDED_HEAD_SHA,
      sequence: 0,
      observedAt: FIXED_EARLIER_INSTANT,
    },
  );

  return { ticket, git, deployment, engine, verification, events, effects: ledger, conditions };
}
