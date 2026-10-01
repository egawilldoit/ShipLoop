/**
 * Owner-authorized delivery: authorization, execution, reconciliation and receipts
 * (F26-AC1, F26-AC2, F26-AC3, F26-AC4, F26-AC5, F27-AC1, F27-AC2, F27-AC3, F27-AC4,
 * F27-AC5, F28-AC1, F28-AC2, F28-AC3, F28-AC4, F28-AC5, F29-AC1, F29-AC2, F29-AC3,
 * F29-AC4, F29-AC5, F30-AC4, F30-AC5, N01-AC2).
 *
 * This is the only layer in the product that performs a privileged external write, and
 * it exists to make five properties true rather than to make the writes convenient.
 *
 * **1. An authorization is a bound, single-use permission, and the domain decides it.**
 * `checkAuthorization` and `consumeAuthorization` are asked, never restated, and they are
 * asked against a subject built from a *freshly read* provider state immediately before
 * the write. A moved head, a changed pull request, a different destination or a replaced
 * component deployment therefore produces a different subject fingerprint and the
 * authorization stops being valid (F26-AC1, F26-AC2, F27-AC3). The authorization is
 * consumed *before* the provider call, so a crash between the two leaves an owner who
 * has to decide again rather than a permission that can be replayed (F26-AC3, F27-AC2).
 *
 * **2. A refusal is a refusal, and a lost response is never a failure.**
 * `executeMerge` and `executeRelease` share one gate, and its order is the entire
 * anti-duplication story:
 *
 *   1. read live head, base, pull-request and review state;
 *   2. refuse an unmet precondition *by name*, before any ledger or provider call, because
 *      a precondition that no longer holds is a decision the owner has to re-make rather
 *      than an error to retry through. A moving merge base is the case that matters: what
 *      would merge is no longer what was tested (F28-AC1, F28-AC2);
 *   3. open the delivery (`Merging` for a merge, `Releasing` for a release), so a delivery
 *      that was never attempted is distinguishable from one whose call may be lost;
 *   4. ask the operation ledger whether this operation may be written again;
 *   5. check and consume the single-use authorization against the live subject;
 *   6. record the intent, bind it to the delivery, then let `assertWritable` answer once more;
 *   7. call the provider exactly once - one merge, or one delivery action per bound
 *      component under its own operation identity;
 *   8. settle the ledger and the delivery row together.
 *
 * A lost response becomes `OutcomeUnknown` in the ledger *and* in the delivery row, so
 * the next attempt with the same operation identity finds that row instead of issuing a
 * second write. `OutcomeUnknown` is never rounded to success or to failure: reaching the
 * provider twice creates a duplicate external fact (F28-AC3, F28-AC4, F30-AC5, N01-AC2).
 *
 * **3. A release is downstream of a merge, and a combined approval observes rather than
 * writes twice.** The delivery lifecycle has no path into `Releasing` other than from
 * `Merged`, and that is the product shape rather than an accident: F27-AC1 describes a
 * release manifest that carries source and *merge* identity. So a separate post-merge
 * release owns no delivery row of its own - it delivers the merge's, and it is bound to the
 * commit the provider actually merged rather than to the candidate head the merge started
 * from. A combined merge/release authorization performs the merge and its release step
 * *observes* the pipeline that merge triggered (F27-AC1, F27-AC2, F27-AC5, F28-AC1).
 *
 * **4. Reconciliation reads; it never writes.**
 * `reconcileDelivery` establishes what happened by reading the target, and only a
 * confirmed fact moves a delivery forward. `StillUnknown` leaves the delivery exactly as
 * blocked as it was, and `DidNotHappen` records a definite provider refusal and stops: the
 * authorization was single-use, so a repeat needs a new owner decision rather than a silent
 * second attempt (F28-AC4, F30-AC3, F30-AC5).
 *
 * **5. A receipt is written only from an established result, and is immutable.**
 * `release_receipts.delivery_id` is `UNIQUE`, so a retry reads the receipt that already
 * exists and republishes nothing (F29-AC2, F29-AC4). A `Failed` delivery produces a typed
 * receipt carrying the provider's own reason, because "it failed and here is why" is the
 * honest record and a silent success is the one thing a receipt must never be (F29-AC2,
 * F29-AC3).
 *
 * The delivery, component, smoke and receipt rows are written by `SqliteDeliveryJournal`
 * at the bottom of this file, over tables `migrations.ts` already creates. That is the
 * same duplication `SqliteObservationJournal` in `verification.ts` reports: `@shiploop/storage`
 * owns the schema and exports no reader or writer for these four tables, so the journal is
 * controller-owned and named as such rather than hidden behind an import that does not
 * exist. No migration was added: every column this journal writes was verified present in
 * the migrated schema.
 *
 * Every string this module stores passes through the domain redaction, because a provider
 * message, a review detail and an owner note all end up in a receipt, a comment and a log
 * (N02-AC2).
 */

import { createHash } from 'node:crypto';

import {
  canTransition,
  checkAuthorization,
  consumeAuthorization,
  err,
  invalid,
  ok,
  redact,
  subjectFingerprint,
} from '@shiploop/domain';
import type {
  AuthorizationRejection,
  AuthorizationState,
  AuthorizationSubject,
  CandidateId,
  CommitSha,
  DecisionId,
  DeliveryAction,
  DomainError,
  Fingerprint,
  OperationId,
  OwnerAuthorization,
  OwnerId,
  ProviderId,
  ReceiptId,
  Result,
  ShipLoopId,
  WorkItemId,
} from '@shiploop/domain';
import type {
  AdapterContext,
  ComponentFailure,
  ContentRelation,
  DeploymentExecutionOutcome,
  DestinationVerification,
  GitRepositoryRef,
  GitStateRead,
  LiveSmokeRequirement,
  MergeMethod,
  MergeOutcome,
  MergePrecondition,
  MergePullRequestRequest,
  PermittedDeliveryAction,
  ReadGitStateRequest,
  SmokeObservation,
  SmokeResult,
  VerifyDestinationRequest,
} from '@shiploop/adapters';
import type {
  CandidateRecord,
  CandidateStore,
  ExternalOperation,
  ExternalOperationStore,
  OwnerDecisionRecord,
  OwnerDecisionStore,
  SqlRow,
  StorageConnection,
  StorageStatement,
} from '@shiploop/storage';
import type { ControllerClock, OwnerActor } from './profiles.ts';
import type { AcceptanceView } from './acceptance.ts';

/* -------------------------------------------------------------------------- */
/* Ledger vocabulary                                                            */
/* -------------------------------------------------------------------------- */

/** `external_operations.kind` for an authorized merge. A name the schema CHECK admits. */
export const MERGE_OPERATION_KIND = 'Merge';

/** `external_operations.kind` for an authorized release. */
export const RELEASE_OPERATION_KIND = 'Release';

/** `external_operations.kind` for an authorized recovery redeploy (F28-AC5). */
export const REDEPLOY_OPERATION_KIND = 'Redeploy';

/**
 * The operation identity one authorized delivery owns.
 *
 * Derived from the authorization and the action rather than from a clock or a counter, so
 * a replayed request addresses the same operation. That is what lets the ledger's refusal
 * stop the second write: a fresh identity per attempt would defeat the only mechanism
 * standing between a lost response and a duplicate merge (F28-AC4).
 */
export function deliveryOperationId(authorizationId: string, actionKind: DeliveryAction['kind']): OperationId {
  return `delivery:${actionKind.toLowerCase()}:${authorizationId}` as OperationId;
}

const DECISION_TYPE_FOR_ACTION: Readonly<
  Record<DeliveryAction['kind'], 'AuthorizeMerge' | 'AuthorizeRelease' | 'AuthorizeMergeAndRelease' | 'AuthorizeRecovery'>
> = {
  Merge: 'AuthorizeMerge',
  Release: 'AuthorizeRelease',
  MergeAndRelease: 'AuthorizeMergeAndRelease',
  RecoveryRedeploy: 'AuthorizeRecovery',
};

const OPERATION_KIND_FOR_ACTION: Readonly<Record<DeliveryAction['kind'], string>> = {
  Merge: MERGE_OPERATION_KIND,
  Release: RELEASE_OPERATION_KIND,
  MergeAndRelease: RELEASE_OPERATION_KIND,
  RecoveryRedeploy: REDEPLOY_OPERATION_KIND,
};

/** The ledger kind an action's own operation is recorded under. */
function ledgerKindFor(action: DeliveryAction): string {
  return action.kind === 'Merge' ? MERGE_OPERATION_KIND : OPERATION_KIND_FOR_ACTION[action.kind];
}

/**
 * Whether the action performs a merge, which only the Git provider can execute.
 *
 * A combined merge/release performs a merge, and its release step only observes the
 * pipeline that merge triggered rather than triggering a second one (F27-AC2, F28-AC1).
 */
function performsMerge(action: DeliveryAction): boolean {
  return action.kind === 'Merge' || action.kind === 'MergeAndRelease';
}

/**
 * Whether the authorization owns a delivery row of its own.
 *
 * A merge-shaped action does. A separate post-merge release does not, because the delivery
 * it delivers is the merge's, and `deliveries.decision_id` is `UNIQUE`, so a second row for
 * the same merge would fork the history F29-AC2 requires to stay intact.
 */
function beginsOwnDelivery(action: DeliveryAction): boolean {
  return performsMerge(action);
}

/** The merge method the owner authorized, or null for an action that merges nothing. */
function mergeMethodFor(action: DeliveryAction): MergeMethod | null {
  return action.kind === 'Merge' || action.kind === 'MergeAndRelease' ? action.mergeMethod : null;
}

/* -------------------------------------------------------------------------- */
/* Ports                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The live provider reads and the one privileged Git write this module performs.
 *
 * Declared as the two methods it needs rather than as the whole adapter, so this layer
 * depends on the read and the write and the composition root binds the real Git adapter,
 * which satisfies it structurally. `readState` is the F26-AC2 read: head, base, pull
 * request and review state read together, because a decision made from a cached head is
 * the failure that criterion names.
 */
export interface DeliveryGit {
  readState(context: AdapterContext, request: ReadGitStateRequest): Promise<Result<GitStateRead>>;
  mergePullRequest(context: AdapterContext, request: MergePullRequestRequest): Promise<Result<MergeOutcome>>;
}

/** The delivery action and the destination confirmation a release performs (F28-AC1, F28-AC2). */
export interface DestinationConfirmation {
  executeDeliveryAction(
    context: AdapterContext,
    action: PermittedDeliveryAction,
  ): Promise<Result<DeploymentExecutionOutcome>>;
  verifyDestination(
    context: AdapterContext,
    request: VerifyDestinationRequest,
  ): Promise<Result<DestinationVerification>>;
}

/** The live acceptance read, so a delivery gate sees `Stale` rather than `Accepted`. */
export interface AcceptanceReader {
  currentAcceptance(candidateId: CandidateId): Result<AcceptanceView, DomainError>;
}

export interface BeginDeliveryInput {
  readonly deliveryId: string;
  readonly workItemId: WorkItemId;
  readonly candidate: CandidateRecord;
  readonly decisionId: DecisionId;
  readonly operationId: OperationId;
  readonly subject: AuthorizationSubject;
  readonly repository: GitRepositoryRef;
  readonly correlationId: string;
  readonly at: string;
}

export interface DeliveryComponentRecord {
  readonly component: string;
  readonly deploymentId: string | null;
  readonly deploymentUrl: string | null;
  readonly environment: string;
  readonly state: string;
}

export interface DeliveryRecord {
  readonly deliveryId: string;
  readonly workItemId: WorkItemId;
  readonly projectId: string;
  readonly candidateId: CandidateId;
  readonly decisionId: DecisionId;
  readonly operationId: OperationId | null;
  readonly state: string;
  readonly correlationId: string;
  readonly subject: AuthorizationSubject;
  readonly repository: GitRepositoryRef;
  readonly pullRequestId: string | null;
  readonly headSha: CommitSha;
  readonly targetBranch: string;
  readonly unknownSince: string | null;
  readonly mergedAt: string | null;
  /**
   * The commit the provider produced, held in the delivery manifest.
   *
   * `manifest_json` is where F27-AC1 puts source and merge identity, and `deliveries` has
   * no dedicated column for it, so the manifest is the home the specification already gives
   * it rather than a JSON blob invented to dodge a migration.
   */
  readonly mergeCommitSha: CommitSha | null;
  readonly releasedAt: string | null;
  readonly failedAt: string | null;
  readonly failureDetail: string | null;
  readonly components: readonly DeliveryComponentRecord[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeliveryTransitionInput {
  readonly deliveryId: string;
  readonly to: string;
  readonly at: string;
  /** Recorded as the failure reason; required by the schema whenever `to` is `Failed`. */
  readonly detail?: string | null;
  /** The commit the provider produced, recorded in the manifest on a confirmed merge. */
  readonly mergeCommitSha?: CommitSha | null;
  readonly operationId?: OperationId | null;
}

/** One recorded live-smoke observation (F28-AC2). */
export interface SmokeRow {
  readonly component: string;
  readonly result: string;
  readonly artifactRef: string | null;
  readonly detail: string | null;
  readonly observedAt: string;
}

export interface ComponentStateInput {
  readonly component: string;
  readonly state: string;
  /**
   * The provider identity that actually reached the destination.
   *
   * Recorded rather than read back from the candidate, because the deployment a release
   * produces is a *new* deployment and the candidate's is the one it was delivered from
   * (F28-AC1).
   */
  readonly deploymentId?: string | null;
  readonly deploymentUrl?: string | null;
}

export interface SmokeResultInput {
  readonly deliveryId: string;
  readonly component: string;
  readonly candidateFingerprint: Fingerprint;
  readonly result: string;
  readonly artifactRef: string | null;
  readonly detail: string | null;
  readonly observedAt: string;
}

/** A component's release standing inside a receipt (F29-AC5). */
export interface ReceiptComponent {
  readonly component: string;
  readonly released: boolean;
  readonly deploymentId: string | null;
  readonly deploymentUrl: string | null;
  readonly environment: string;
  readonly smokeResult: string | null;
  /** Why this component was not released, when it was not. */
  readonly reason: string | null;
}

/** One required check as it stood when the receipt was written (F29-AC1). */
export interface ReceiptCheck {
  readonly name: string;
  readonly result: string;
  readonly detail: string | null;
}

export interface ReleaseReceipt {
  readonly receiptId: ShipLoopId<ReceiptId>;
  readonly deliveryId: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly candidateId: string;
  /** `Confirmed` only from a confirmed provider result; `Failed` carries the reason. */
  readonly outcome: 'Confirmed' | 'Failed';
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  readonly mergeSha: CommitSha | null;
  readonly destination: string;
  readonly targetBranch: string;
  readonly pullRequestId: string | null;
  readonly checks: readonly ReceiptCheck[];
  readonly ownerDecisions: readonly {
    readonly decisionId: string;
    readonly decisionType: string;
    readonly ownerId: string;
    readonly decidedAt: string;
  }[];
  readonly components: readonly ReceiptComponent[];
  /** Which components reached the destination and which did not, each with a reason. */
  readonly releasedComponents: readonly string[];
  readonly unreleasedComponents: readonly { readonly component: string; readonly reason: string }[];
  readonly smokeResult: string;
  /** The provider's own words, present exactly when `outcome` is `Failed` (F29-AC2). */
  readonly failureReason: string | null;
  readonly deliveryState: string;
  readonly link: string | null;
  readonly createdAt: string;
  /** Set once ticket closure is confirmed; null while closure is pending sync (F29-AC4). */
  readonly finalizedAt: string | null;
  readonly issueClosedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Use case inputs and outputs                                                  */
/* -------------------------------------------------------------------------- */

export interface AuthorizeDeliveryInput {
  readonly candidateId: CandidateId;
  readonly actor: OwnerActor;
  readonly action: DeliveryAction;
  /** The serving destination, which the authorization is bound to (F26-AC1, F27-AC3). */
  readonly destination: string;
  /**
   * The pull request a merge-shaped action acts on.
   *
   * Required for a merge and refused without one: a merge authorization naming no pull
   * request cannot be checked against live provider state, which is the read F26-AC2
   * requires immediately before the write.
   */
  readonly pullRequestId: string | null;
  readonly targetBranch: string;
  /** The project profile's repository identity, used for the live read (F02-AC1). */
  readonly repository: GitRepositoryRef;
  readonly correlationId: string;
}

export interface AuthorizationRecord {
  readonly authorizationId: DecisionId;
  readonly deliveryId: string;
  readonly operationId: OperationId;
  readonly ownerId: OwnerId;
  readonly action: DeliveryAction;
  readonly destination: string;
  readonly headSha: CommitSha;
  readonly targetBranch: string;
  readonly pullRequestId: string | null;
  readonly candidateFingerprint: Fingerprint;
  readonly subjectFingerprint: Fingerprint;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly state: AuthorizationState;
  readonly singleUse: true;
  /** When the live facts this authorization is bound to were read (F26-AC2). */
  readonly observedAt: string;
  readonly correlationId: string;
}

export interface ConsumeAuthorizationInput {
  readonly authorizationId: DecisionId;
  readonly actor: OwnerActor;
  /** The subject about to be performed, read fresh by the caller (F26-AC2). */
  readonly proposed: AuthorizationSubject;
  readonly correlationId: string;
}

export interface ConsumedAuthorization {
  readonly authorizationId: DecisionId;
  readonly ownerId: OwnerId;
  readonly consumedAt: string;
  readonly subjectFingerprint: Fingerprint;
  readonly state: AuthorizationState;
}

export interface ExecuteDeliveryInput {
  readonly authorizationId: DecisionId;
  readonly actor: OwnerActor;
  readonly correlationId: string;
  /** Required for a release: the probes the destination must pass before `Released`. */
  readonly liveSmoke?: LiveSmokeRequirement;
  /**
   * The migration reversal a recovery redeploy performs (F28-AC5).
   *
   * Required by `RecoveryRedeploy` and refused without one: reversing schema is not a
   * code redeploy, and a caller that could reverse a database by omitting a field would
   * make the distinction between the two unstatable.
   */
  readonly reversalStatement?: string;
}

export interface MergeExecution {
  readonly deliveryId: string;
  readonly operationId: OperationId;
  readonly state: 'Merged';
  readonly mergeCommitSha: CommitSha;
  readonly headSha: CommitSha;
  readonly targetBranch: string;
  readonly mergedAt: string;
  /** `AlreadyPresent` when the provider reported the merge had already happened. */
  readonly disposition: 'Merged' | 'AlreadyPresent';
  /** Whether the merged content is the content the owner authorized (F26-AC4). */
  readonly contentRelation: ContentRelation;
  readonly precondition: MergePrecondition;
  readonly consumedAuthorization: ConsumedAuthorization;
}

export interface ReleaseExecution {
  readonly deliveryId: string;
  readonly operationId: OperationId;
  readonly state: 'Released';
  readonly destination: string;
  readonly headSha: CommitSha;
  readonly releasedAt: string;
  readonly verifiedAt: string;
  readonly components: readonly {
    readonly component: string;
    readonly deploymentId: ProviderId;
    readonly url: string;
    readonly environment: string;
  }[];
  readonly smokeResult: string;
  readonly consumedAuthorization: ConsumedAuthorization;
}

export interface ReleaseReceiptInput {
  readonly deliveryId: string;
  readonly actor: OwnerActor;
  /** A sanitized link to the delivery evidence, carried on the receipt (F29-AC1). */
  readonly link: string | null;
  /** The required checks as they stood, recorded on the receipt (F29-AC1). */
  readonly checks: readonly ReceiptCheck[];
  readonly correlationId: string;
}

export type ReleaseReceiptReport =
  | { readonly kind: 'Recorded'; readonly receipt: ReleaseReceipt }
  /** A retry republishes nothing: the receipt that already exists is returned (F29-AC4). */
  | { readonly kind: 'AlreadyRecorded'; readonly receipt: ReleaseReceipt };

export interface ReconcileDeliveryInput {
  readonly operationId: string;
  /**
   * The delivery this operation acts on, when the operation is not the delivery's own.
   *
   * A separate post-merge release performs an operation the merged delivery row cannot hold,
   * because that row's `operation_id` already names the merge. Naming the delivery here keeps
   * a lost release response reconcilable rather than only discoverable in the operations
   * worklist (F28-AC4, F30-AC5).
   */
  readonly deliveryId?: string;
  /** Who established the resolution; an unattributable settlement is not a record. */
  readonly resolvedBy: string;
  readonly correlationId: string;
}

export interface ReconciledDelivery {
  readonly resolution: 'DidHappen' | 'DidNotHappen' | 'StillUnknown';
  readonly deliveryId: string;
  /** The state the delivery now holds. `StillUnknown` leaves the previous state intact. */
  readonly state: string;
  readonly detail: string;
}

export interface ReconciliationSweepInput {
  readonly now: string;
  /** Hard bound on how many operations one sweep may consider (F30-AC4). */
  readonly limit?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly correlationId: string;
}

export interface ReconciliationSweepReport {
  readonly swept: number;
  readonly didHappen: number;
  readonly didNotHappen: number;
  readonly stillUnknown: number;
  /** Operations this sweep did not consider, with the instant they are next due. */
  readonly deferred: readonly { readonly operationId: string; readonly nextAttemptAt: string }[];
}

export interface DeliveryJournal {
  beginDelivery(input: BeginDeliveryInput): Result<DeliveryRecord>;
  get(deliveryId: string): Result<DeliveryRecord>;
  findByDecision(decisionId: DecisionId): Result<DeliveryRecord | null>;
  findByOperation(operationId: string): Result<DeliveryRecord | null>;
  /**
   * The merged delivery a separate post-merge release continues (F27-AC1, F27-AC2).
   *
   * Exists because the delivery lifecycle has no path into `Releasing` other than from
   * `Merged`: a release is by definition downstream of a merge, and a release
   * authorization deliberately owns no delivery row of its own, so the delivery it acts on
   * is the merge's.
   */
  findMergedForCandidate(candidateId: CandidateId): Result<DeliveryRecord | null>;
  /**
   * Binds the ledger operation a delivery performs.
   *
   * Separate from `beginDelivery` because `deliveries.operation_id` is a foreign key: the
   * delivery row is written when the owner authorizes, and the operation row only when the
   * write is actually about to be attempted, so the reference is filled in at that point
   * rather than forcing the ledger row to exist for an authorization nobody has used.
   */
  bindOperation(deliveryId: string, operationId: OperationId): Result<DeliveryRecord>;
  /**
   * Moves the delivery, validating the edge against the domain lifecycle table first.
   *
   * The check is `canTransition` rather than `assertTransition` because an illegal edge is
   * a programming error here, not a caller input, and this journal returns `Result` rather
   * than throwing. Either way an illegal move cannot be written (F28-AC3).
   */
  transition(input: DeliveryTransitionInput): Result<DeliveryRecord>;
  recordComponents(deliveryId: string, components: readonly ComponentStateInput[], at: string): Result<void>;
  recordSmoke(input: SmokeResultInput): Result<void>;
  listSmoke(deliveryId: string): Result<readonly SmokeRow[]>;
  findReceipt(deliveryId: string): Result<ReleaseReceipt | null>;
  recordReceipt(receipt: ReleaseReceipt): Result<ReleaseReceipt>;
}

export interface DeliveryUseCaseDeps {
  readonly clock: ControllerClock;
  readonly decisions: OwnerDecisionStore;
  readonly candidates: Pick<CandidateStore, 'get' | 'listForWorkItem' | 'findByFingerprint'>;
  readonly journal: DeliveryJournal;
  readonly operations: ExternalOperationStore;
  readonly git: DeliveryGit;
  readonly deployments: DestinationConfirmation;
  readonly acceptance: AcceptanceReader;
  /**
   * How long an authorization stays usable, applied to the decision's recorded
   * `decided_at`.
   *
   * Derived from a durable fact rather than from a value only the issuing call held: the
   * schema has an `expires_at` column but the storage repository's `authorize` does not
   * write it, so computing the deadline here is what stops an unconsumed approval from
   * living forever without a migration.
   */
  readonly authorizationTtlMs?: number;
  /** Redaction applied to provider text before it reaches a stored row (N02-AC2). */
  readonly redactText?: (text: string) => string;
}

export interface DeliveryUseCases {
  readonly authorizeDelivery: (input: AuthorizeDeliveryInput) => Promise<Result<AuthorizationRecord, DomainError>>;
  readonly consumeDeliveryAuthorization: (
    input: ConsumeAuthorizationInput,
  ) => Result<ConsumedAuthorization, DomainError>;
  readonly executeMerge: (input: ExecuteDeliveryInput) => Promise<Result<MergeExecution, DomainError>>;
  readonly executeRelease: (input: ExecuteDeliveryInput) => Promise<Result<ReleaseExecution, DomainError>>;
  readonly reconcileDelivery: (input: ReconcileDeliveryInput) => Promise<Result<ReconciledDelivery, DomainError>>;
  readonly releaseReceipt: (input: ReleaseReceiptInput) => Result<ReleaseReceiptReport, DomainError>;
  readonly frequentOperationReconciliation: (
    input: ReconciliationSweepInput,
  ) => Promise<Result<ReconciliationSweepReport, DomainError>>;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                 */
/* -------------------------------------------------------------------------- */

const DEFAULT_AUTHORIZATION_TTL_MS = 60 * 60_000;
const DEFAULT_SWEEP_LIMIT = 10;
const DEFAULT_BASE_DELAY_MS = 30_000;
const DEFAULT_MAX_DELAY_MS = 30 * 60_000;

function safe(text: string): string {
  return redact(text).text;
}

function addMs(instant: string, delayMs: number): string {
  const base = Date.parse(instant);
  if (Number.isNaN(base)) throw new Error(`Expected a parseable instant but received ${instant}`);
  return new Date(base + delayMs).toISOString();
}

/** The head sha the provider currently reports, or null when it reports none. */
function headOf(state: GitStateRead): CommitSha | null {
  return state.head.kind === 'Branch' || state.head.kind === 'Commit' ? state.head.sha : null;
}

/** The base sha the provider currently reports, or null when it reports none. */
function baseOf(state: GitStateRead): CommitSha | null {
  return state.base.kind === 'Branch' || state.base.kind === 'Commit' ? state.base.sha : null;
}

/** The observed smoke result reduced to the vocabulary a receipt records. */
function smokeResultName(smoke: SmokeResult): string {
  return smoke.kind;
}

/** Whether the observed smoke result satisfies a `Released` decision (F28-AC2). */
function smokeSatisfies(smoke: SmokeResult, required: LiveSmokeRequirement): boolean {
  if (required.kind === 'None') return smoke.kind === 'Passed' || smoke.kind === 'NotRun';
  return smoke.kind === 'Passed';
}

/**
 * Every probe in a smoke result, flattened for the `live_smoke_results` rows.
 *
 * The component comes from the requirement rather than from the observation, because
 * `SmokeObservation` names a probe and not a component. Joining through the requirement is
 * what makes the row answer "which component did this smoke check cover", which is the
 * question a partial release receipt has to answer (F28-AC2, F29-AC5).
 */
function smokeProbes(
  smoke: SmokeResult,
  required: LiveSmokeRequirement,
): readonly { readonly component: string; readonly result: string; readonly detail: string | null }[] {
  if (smoke.kind !== 'Passed' && smoke.kind !== 'Failed') return [];
  const componentOf = new Map(
    required.kind === 'Required' ? required.probes.map((probe) => [probe.probeId, probe.component]) : [],
  );
  return smoke.probes.map((probe) => ({
    component: componentOf.get(probe.probeId) ?? probe.probeId,
    result: smoke.kind === 'Passed' ? 'Passed' : 'Failed',
    detail: smokeDetail(probe.outcome),
  }));
}

/**
 * What a probe actually reported, as a sentence the owner can act on.
 *
 * A bare outcome kind such as `StatusMismatch` is not a reason, so the observed values are
 * carried into the detail: the receipt's per-component reason is only useful if it says
 * what the destination returned (F28-AC3, F29-AC5).
 */
function smokeDetail(outcome: SmokeObservation['outcome']): string | null {
  switch (outcome.kind) {
    case 'StatusMatched':
    case 'BodyMatched':
      return null;
    case 'SignInIntercepted':
      return `The destination answered with a sign-in redirect to ${outcome.location}.`;
    case 'StatusMismatch':
      return `The destination answered ${outcome.observed} where ${outcome.expected} was expected.`;
    case 'ConnectionFailed':
      return outcome.detail;
  }
}

/**
 * Builds the delivery use cases.
 *
 * `clock` is injected and neither provider is constructed here, so a decision recorded in
 * a test replays identically and the composition root binds the real adapters rather than
 * this layer reaching for a client.
 */
export function createDeliveryUseCases(deps: DeliveryUseCaseDeps): DeliveryUseCases {
  const providerText = deps.redactText ?? ((text: string): string => safe(text));
  const authorizationTtlMs = deps.authorizationTtlMs ?? DEFAULT_AUTHORIZATION_TTL_MS;

  const contextFor = (operationId: OperationId, correlationId: string): AdapterContext => ({
    correlationId,
    operationId,
    clock: { now: () => deps.clock.now(), elapsedMs: () => 0 },
    logger: { emit: () => undefined },
    signal: new AbortController().signal,
    redact: providerText,
  });

  /** F26-AC5, F03-AC5: only the owner may bind or perform a production-changing action. */
  const requireOwner = (actor: OwnerActor): Result<OwnerId, DomainError> => {
    if (actor.role !== 'Owner' || actor.ownerId === null) {
      return err({
        code: 'Forbidden',
        reason: `Only the owner may authorize or perform a delivery action; the ${actor.role} role may not (F26-AC5, F03-AC5, N02-AC3).`,
      });
    }
    return ok(actor.ownerId);
  };

  const decisionFor = (authorizationId: DecisionId): Result<OwnerDecisionRecord, DomainError> => {
    const found = deps.decisions.get(authorizationId);
    if (!found.ok) return err(found.error);
    if (found.value.subject === null || found.value.subjectFingerprint === null) {
      return err(
        invalid(`Decision ${authorizationId} is not an authorization, so it cannot authorize a delivery action.`, [
          { path: 'decisionId', message: 'An acceptance is not a delivery permission (F26-AC1, R3).' },
        ]),
      );
    }
    return ok(found.value);
  };

  /**
   * The `OwnerAuthorization` a stored decision row denotes.
   *
   * Rebuilt rather than stored so there is exactly one definition of what an authorization
   * *is*, and the deadline comes from the row's own `decided_at` so it survives the process
   * that issued it.
   */
  const authorizationFor = (decision: OwnerDecisionRecord): OwnerAuthorization => ({
    authorizationId: decision.decisionId,
    ownerId: decision.actorOwnerId,
    issuedAt: decision.createdAt,
    expiresAt: addMs(decision.createdAt, authorizationTtlMs),
    subject: decision.subject as AuthorizationSubject,
    subjectFingerprint: decision.subjectFingerprint as Fingerprint,
    state: stateFor(decision),
    consumedAt: decision.consumedAt,
    invalidatedReason: decision.invalidatedReason,
    singleUse: true,
  });

  /** The domain state a stored row denotes. `Recorded` is the domain's `Authorized`. */
  const stateFor = (decision: OwnerDecisionRecord): AuthorizationState => {
    if (decision.state === 'Consumed') return 'Consumed';
    if (decision.state === 'Invalidated') return 'Invalidated';
    if (deps.clock.now() >= addMs(decision.createdAt, authorizationTtlMs)) return 'Expired';
    return 'Authorized';
  };

  const candidateFor = (candidateId: CandidateId): Result<CandidateRecord, DomainError> => {
    const found = deps.candidates.get(candidateId);
    if (!found.ok) return err(found.error);
    return ok(found.value);
  };

  /** The candidate a bound fingerprint denotes, for a release that owns no delivery row. */
  const candidateForFingerprint = (candidateFingerprint: Fingerprint): Result<CandidateRecord, DomainError> => {
    const found = deps.candidates.findByFingerprint(candidateFingerprint);
    if (!found.ok) return err(found.error);
    if (found.value === null) {
      return err({
        code: 'NotFound',
        reason: `No candidate carries fingerprint ${candidateFingerprint}, so the delivery it authorized cannot be found.`,
      });
    }
    return ok(found.value);
  };

  const currentCandidateFor = (candidate: CandidateRecord): Result<CandidateRecord, DomainError> => {
    const listed = deps.candidates.listForWorkItem(candidate.workItemId);
    if (!listed.ok) return err(listed.error);
    return ok(listed.value[listed.value.length - 1] ?? candidate);
  };

  /**
   * The subject the live provider state currently describes.
   *
   * The pull request id comes from the read rather than from the authorization, so a
   * closed or absent pull request produces a different subject and the domain check
   * refuses it instead of a merge being attempted against a stale identity (F27-AC3).
   */
  const liveSubjectFor = (
    authorization: OwnerAuthorization,
    live: GitStateRead,
    destination: string,
    components: readonly { readonly component: string; readonly deploymentId: string | null }[],
  ): AuthorizationSubject => ({
    action: authorization.subject.action,
    destination,
    // A release authorization binds no pull request, and a repository that happens to have
    // an open one must not change what the owner authorized (F27-AC3). A merge
    // authorization binds one, and the live read has to still report it.
    pullRequestId:
      authorization.subject.pullRequestId === null ? null : (live.pullRequest?.pullRequestId ?? null),
    headSha: authorization.subject.headSha,
    targetBranch: authorization.subject.targetBranch,
    candidateFingerprint: authorization.subject.candidateFingerprint,
    componentDeployments: components,
  });

  /**
   * The preconditions a delivery must satisfy against a live read (F26-AC2, F28-AC1).
   *
   * A moving merge base is the case worth reading. The base is part of what was tested, so
   * a base that advanced after the owner decided invalidates the decision; it is a
   * *refusal naming the unmet precondition*, not a failure and not something to retry
   * through, because the next attempt would merge content nobody accepted. The same
   * reasoning covers a moved head, a pull request that is no longer open, and a provider
   * review that requests changes or an approval rule that is still pending.
   *
   * Owner product acceptance never satisfies a provider-required reviewer: F26-AC5 says
   * the acceptance is the owner's statement about the product, and the review list is
   * consulted on its own terms.
   */
  const unmetPreconditions = (
    authorization: OwnerAuthorization,
    expected: { readonly headSha: CommitSha; readonly baseSha: CommitSha | null; readonly mergeMethod: MergeMethod | null },
    live: GitStateRead,
  ): readonly { readonly name: string; readonly detail: string; readonly remedy: string }[] => {
    const unmet: { name: string; detail: string; remedy: string }[] = [];
    const liveHead = headOf(live);
    if (liveHead === null) {
      unmet.push({
        name: 'Live head',
        detail: `The provider reports no head for ${authorization.subject.targetBranch}, so there is nothing to check the decision against (F26-AC2).`,
        remedy: 'Re-read provider state once the branch is readable, then authorize again.',
      });
    } else if (liveHead !== expected.headSha) {
      unmet.push({
        name: 'Expected head',
        detail: `The provider head is ${liveHead.slice(0, 12)}; the owner decided against ${expected.headSha.slice(0, 12)} (F25-AC3, F26-AC2).`,
        remedy: 'Re-test and re-accept the new head, then authorize a fresh action (F26-AC2).',
      });
    }
    const liveBase = baseOf(live);
    if (liveBase !== null && expected.baseSha !== null && liveBase !== expected.baseSha) {
      unmet.push({
        name: 'Merge base',
        detail: `The base advanced to ${liveBase.slice(0, 12)} after the owner decided against ${expected.baseSha.slice(0, 12)}, so what would merge is not what was tested.`,
        remedy:
          'Re-test against the new base and re-accept. A moving base is a refusal to be reported, not an error to retry through (F28-AC1, F28-AC2).',
      });
    }
    const pullRequest = live.pullRequest;
    if (authorization.subject.pullRequestId !== null) {
      if (pullRequest === null) {
        unmet.push({
          name: 'Pull request',
          detail: `The provider reports no pull request for ${authorization.subject.pullRequestId}.`,
          remedy: 'Confirm the pull request is still open before authorizing again (F26-AC2).',
        });
      } else if (pullRequest.state !== 'Open') {
        unmet.push({
          name: 'Pull request',
          detail: `The authorized pull request is ${pullRequest.state}, so there is nothing left to merge (F26-AC2).`,
          remedy: 'Reconcile the delivery that already happened, or authorize a new pull request.',
        });
      }
    }
    for (const review of live.reviews) {
      if (review.kind === 'Review' && review.decision === 'ChangesRequested') {
        unmet.push({
          name: `Review by ${review.reviewer}`,
          detail:
            'A provider review requests changes, so the provider itself does not consider the change mergeable. Owner product acceptance does not stand in for that reviewer (F26-AC5).',
          remedy: 'Address the review, then re-read live state before authorizing again.',
        });
      }
      if (review.kind === 'ApprovalRulePending') {
        unmet.push({
          name: `Approval rule ${review.rule}`,
          detail: review.detail,
          remedy: 'Satisfy the branch rule the provider enforces, or change it deliberately.',
        });
      }
    }
    return unmet;
  };

  /** The typed refusal each domain rejection becomes, naming the bound inputs. */
  const rejectionError = (rejection: AuthorizationRejection, reason: string, bound: OwnerAuthorization): DomainError => {
    const detail = `${reason} It was bound to head ${bound.subject.headSha.slice(0, 12)} on ${bound.subject.targetBranch} to ${bound.subject.destination}.`;
    switch (rejection) {
      case 'AlreadyConsumed':
        return { code: 'Conflict', reason: `${detail} (${rejection})`, expected: 'Authorized', actual: 'Consumed' };
      case 'OwnerMismatch':
        return { code: 'Forbidden', reason: `${detail} (${rejection})` };
      case 'Expired':
        return {
          code: 'Blocked',
          reason: `${detail} (${rejection})`,
          prerequisites: [
            {
              name: 'A current authorization',
              detail: `It expired at ${bound.expiresAt}.`,
              remedy: 'Re-read live state and authorize the action again.',
            },
          ],
        };
      case 'SubjectChanged':
        return {
          code: 'Conflict',
          reason: `${detail} (${rejection})`,
          expected: subjectFingerprint(bound.subject),
          actual: 'a subject that no longer matches',
        };
    }
  };

  /* ---------------------------------------------------------------------- */
  /* F26-AC1, F26-AC2, F27-AC1, F27-AC3: authorization                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Records a single-use authorization bound to one exact action.
   *
   * The binding is the domain's `subjectFingerprint` over the action, the destination, the
   * pull request, the head, the target branch, the candidate fingerprint and every
   * component deployment id, so any of those changing makes the authorization fail
   * `checkAuthorization` later. That is F27-AC3: an old decision cannot authorize a
   * different release, because the release it authorized does not produce the same subject.
   *
   * Acceptance is consulted first, because an authorization without a current acceptance is
   * the F27-AC5 button the specification forbids. The read is the same one the review card
   * renders, so the gate cannot disagree with what the owner saw (F24-AC2, F25-AC3).
   */
  const authorizeDelivery = async (
    input: AuthorizeDeliveryInput,
  ): Promise<Result<AuthorizationRecord, DomainError>> => {
    const owner = requireOwner(input.actor);
    if (!owner.ok) return err(owner.error);
    if (input.destination.trim().length === 0) {
      return err(
        invalid('An authorization must name the destination it authorizes.', [
          { path: 'destination', message: 'Must not be empty; the action is bound to it (F26-AC1, F27-AC3).' },
        ]),
      );
    }
    if (performsMerge(input.action) && (input.pullRequestId === null || input.pullRequestId.length === 0)) {
      return err(
        invalid('A merge authorization must name the pull request it authorizes.', [
          {
            path: 'pullRequestId',
            message:
              'Without it there is nothing to check against live provider state, which is the read F26-AC2 requires immediately before the write.',
          },
        ]),
      );
    }

    const candidate = candidateFor(input.candidateId);
    if (!candidate.ok) return err(candidate.error);
    const current = currentCandidateFor(candidate.value);
    if (!current.ok) return err(current.error);
    if (current.value.candidateFingerprint !== candidate.value.candidateFingerprint) {
      return err({
        code: 'Conflict',
        reason: 'This candidate is no longer the current one for its work item, so it cannot be authorized for delivery (F25-AC3, F27-AC3).',
        expected: candidate.value.candidateFingerprint,
        actual: current.value.candidateFingerprint,
      });
    }

    const acceptance = deps.acceptance.currentAcceptance(candidate.value.candidateId);
    if (!acceptance.ok) return err(acceptance.error);
    if (acceptance.value.state !== 'Accepted') {
      return err({
        code: 'Blocked',
        reason: `The owner acceptance for this candidate is ${acceptance.value.state}, so there is nothing to authorize (F25-AC1, F27-AC5).`,
        prerequisites: [
          {
            name: 'Current owner acceptance',
            detail:
              acceptance.value.staleReasons.length > 0
                ? `It was recorded for a candidate that differs in ${acceptance.value.staleReasons.join(', ')}.`
                : 'No owner has accepted this exact candidate.',
            remedy: 'Accept the current candidate, or request changes and re-test it.',
          },
        ],
      });
    }

    // A separate post-merge release delivers the merge's content, so the head it binds is
    // the commit the provider actually merged rather than the candidate head the merge
    // started from. A merge-shaped action binds the candidate head, because that is the
    // precondition deciding whether the merge may happen at all (F26-AC2, F27-AC2).
    const merged = beginsOwnDelivery(input.action)
      ? null
      : deps.journal.findMergedForCandidate(candidate.value.candidateId);
    if (merged !== null && !merged.ok) return err(merged.error);
    if (merged !== null && merged.value === null) {
      return err({
        code: 'Blocked',
        reason:
          'A separate release authorizes the content of a merge, and no merge has been confirmed for this candidate yet, so there is nothing to release (F27-AC1, F27-AC2).',
        prerequisites: [
          {
            name: 'A merged delivery',
            detail: 'No delivery for this candidate is in the Merged state.',
            remedy:
              'Authorize and perform the merge, then authorize the release against the merged delivery. A post-merge release button would be pretending to authorize a change the merge already triggered (F27-AC5).',
          },
        ],
      });
    }
    const mergeCommit = merged?.value?.mergeCommitSha ?? null;
    if (merged !== null && mergeCommit === null) {
      return err({
        code: 'Blocked',
        reason: `The merged delivery ${merged.value?.deliveryId} recorded no merge commit, so a release cannot be bound to the content that was merged (F26-AC4, F27-AC1).`,
        prerequisites: [
          {
            name: 'A recorded merge commit',
            detail: 'The provider reported the merge without the commit it produced.',
            remedy: 'Reconcile the merge against live provider state, then authorize the release.',
          },
        ],
      });
    }
    const expectedHead = mergeCommit ?? candidate.value.identity.headSha;

    const live = await deps.git.readState(contextFor('op:read-state' as OperationId, input.correlationId), {
      repository: input.repository,
      branch: input.targetBranch,
      baseBranch: input.targetBranch,
    });
    if (!live.ok) return err(live.error);
    const liveHead = headOf(live.value);
    if (liveHead === null) {
      return err({
        code: 'Unavailable',
        reason: `The provider reports no head for ${input.targetBranch}, so there is no live fact to authorize against (F26-AC2).`,
      });
    }
    if (liveHead !== expectedHead) {
      return err({
        code: 'Conflict',
        reason: `The provider head is ${liveHead.slice(0, 12)} but this ${performsMerge(input.action) ? 'merge' : 'release'} would act on ${expectedHead.slice(0, 12)}, so the world moved before the owner could authorize (F26-AC2, F25-AC3).`,
        expected: expectedHead,
        actual: liveHead,
      });
    }

    const subject: AuthorizationSubject = {
      action: input.action,
      destination: input.destination,
      pullRequestId: input.pullRequestId,
      headSha: expectedHead,
      targetBranch: input.targetBranch,
      candidateFingerprint: candidate.value.candidateFingerprint,
      componentDeployments: candidate.value.identity.components.map((component) => ({
        component: component.component,
        deploymentId: component.deploymentId,
      })),
    };
    const now = deps.clock.now();
    const recorded = deps.decisions.authorize({
      workItemId: candidate.value.workItemId,
      candidateFingerprint: candidate.value.candidateFingerprint,
      scopeFingerprint: candidate.value.identity.scopeFingerprint,
      actorOwnerId: owner.value,
      decisionType: DECISION_TYPE_FOR_ACTION[input.action.kind],
      subject,
      note: providerText(`Authorize ${input.action.kind} to ${input.destination}`),
      createdAt: now,
      correlationId: input.correlationId,
    });
    if (!recorded.ok) return err(recorded.error);

    const operationId = deliveryOperationId(recorded.value.decisionId, input.action.kind);
    // A merge-shaped authorization owns its delivery row; a separate release deliberately
    // does not, because the delivery it delivers is the merge's and `decision_id` is unique
    // on that table (F27-AC2, F29-AC2).
    const deliveryId = beginsOwnDelivery(input.action)
      ? deliveryRowId(recorded.value.decisionId)
      : (merged?.value as DeliveryRecord).deliveryId;
    if (beginsOwnDelivery(input.action)) {
      const created = deps.journal.beginDelivery({
        deliveryId,
        workItemId: candidate.value.workItemId,
        candidate: candidate.value,
        decisionId: recorded.value.decisionId,
        operationId,
        subject,
        repository: input.repository,
        correlationId: input.correlationId,
        at: now,
      });
      if (!created.ok) return err(created.error);
    }

    return ok({
      authorizationId: recorded.value.decisionId,
      deliveryId,
      operationId,
      ownerId: owner.value,
      action: input.action,
      destination: input.destination,
      headSha: expectedHead,
      targetBranch: input.targetBranch,
      pullRequestId: input.pullRequestId,
      candidateFingerprint: candidate.value.candidateFingerprint,
      subjectFingerprint: recorded.value.subjectFingerprint as Fingerprint,
      issuedAt: now,
      expiresAt: addMs(now, authorizationTtlMs),
      state: 'Authorized',
      singleUse: true,
      observedAt: live.value.observedAt,
      correlationId: input.correlationId,
    });
  };

  /**
   * F26-AC3, F27-AC2, F27-AC3: spends the single permitted use of an authorization.
   *
   * The check is the domain's own, run against the caller's freshly read subject. Every
   * rejection it can produce is surfaced with its kind, so `AlreadyConsumed` and
   * `SubjectChanged` are distinguishable by a caller rather than both being "not
   * authorized", and the refusal names the inputs the authorization was bound to.
   */
  const consumeDeliveryAuthorization = (
    input: ConsumeAuthorizationInput,
  ): Result<ConsumedAuthorization, DomainError> => {
    const owner = requireOwner(input.actor);
    if (!owner.ok) return err(owner.error);
    const decision = decisionFor(input.authorizationId);
    if (!decision.ok) return err(decision.error);
    const authorization = authorizationFor(decision.value);
    const now = deps.clock.now();

    const check = checkAuthorization({
      authorization,
      ownerId: owner.value,
      proposed: input.proposed,
      now,
    });
    if (!check.valid) return err(rejectionError(check.rejection, check.reason, authorization));

    const consumed = consumeAuthorization(authorization, now);
    const recorded = deps.decisions.consume(input.authorizationId, consumed.consumedAt ?? now);
    if (!recorded.ok) return err(recorded.error);
    return ok({
      authorizationId: input.authorizationId,
      ownerId: owner.value,
      consumedAt: consumed.consumedAt ?? now,
      subjectFingerprint: authorization.subjectFingerprint,
      state: 'Consumed',
    });
  };

  /* ---------------------------------------------------------------------- */
  /* F28-AC1, F28-AC4: the one path to a privileged write                   */

  /**
   * Whether the ledger will permit this operation to be written.
   *
   * A first attempt has no operation row yet, and `assertWritable` answers `NotFound` for a
   * missing intent - which is not a refusal to write, it is the absence of a prior attempt.
   * An operation that *is* recorded is asked about, and its answer is returned as given
   * (F28-AC4).
   */
  const gateFor = (operationId: OperationId, now: string): Result<true, DomainError> => {
    if (deps.operations.findByOperation(operationId) === null) return ok(true);
    const writable = deps.operations.assertWritable(operationId, now);
    return writable.ok ? ok(true) : err(writable.error);
  };
  /* ---------------------------------------------------------------------- */

  /**
   * The gate both executions share, in the order the module header describes.
   *
   * The ledger is asked *before* the authorization is consumed, so a replay of a write
   * that already succeeded never burns a fresh permission, and the intent is recorded
   * *after* the permission is spent, so there is no window in which an unconsumed
   * authorization coexists with a recorded intent. There is no path from here to a
   * provider call that has not passed all five steps.
   */
  const prepareWrite = async (
    input: ExecuteDeliveryInput,
  ): Promise<
    Result<
      {
        readonly delivery: DeliveryRecord;
        readonly authorization: OwnerAuthorization;
        readonly consumed: ConsumedAuthorization;
        readonly live: GitStateRead;
        readonly candidate: CandidateRecord;
        readonly operationId: OperationId;
        readonly precondition: MergePrecondition;
      },
      DomainError
    >
  > => {
    const owner = requireOwner(input.actor);
    if (!owner.ok) return err(owner.error);
    const decision = decisionFor(input.authorizationId);
    if (!decision.ok) return err(decision.error);
    const authorization = authorizationFor(decision.value);
    const own = deps.journal.findByDecision(input.authorizationId);
    if (!own.ok) return err(own.error);
    let delivery = own.value;
    if (delivery === null) {
      // A separate post-merge release owns no delivery row; the delivery it delivers is
      // the merge's, resolved from the candidate the authorization is bound to (F27-AC1).
      const bound = candidateForFingerprint(authorization.subject.candidateFingerprint);
      if (!bound.ok) return err(bound.error);
      const merged = deps.journal.findMergedForCandidate(bound.value.candidateId);
      if (!merged.ok) return err(merged.error);
      if (merged.value === null) {
        return err({
          code: 'Blocked',
          reason: `No merged delivery exists for the candidate this release authorizes, so there is nothing to release (F27-AC1, F27-AC2).`,
          prerequisites: [
            {
              name: 'A merged delivery',
              detail: 'The release authorization bound no delivery row of its own and none is merged.',
              remedy: 'Authorize and perform the merge, then release against the merged delivery.',
            },
          ],
        });
      }
      delivery = merged.value;
    }
    const candidate = candidateFor(delivery.candidateId);
    if (!candidate.ok) return err(candidate.error);
    // The operation identity is the authorization's own. A separate post-merge release acts
    // on a delivery row whose `operation_id` already names the merge, so deriving the
    // identity from the row would make the release a second attempt at the merge (F28-AC4).
    const operationId = deliveryOperationId(input.authorizationId, authorization.subject.action.kind);

    const live = await deps.git.readState(contextFor(operationId, input.correlationId), {
      repository: delivery.repository,
      branch: delivery.targetBranch,
      baseBranch: delivery.targetBranch,
    });
    if (!live.ok) return err(live.error);

    // A release is checked against the merge it delivers; a merge against the candidate it
    // merges. A moving base is a merge-shaped precondition: after a merge the base is the
    // merge's parent, not the base the candidate was tested against (F28-AC1).
    const expectedHead = performsMerge(authorization.subject.action)
      ? candidate.value.identity.headSha
      : (delivery.mergeCommitSha ?? candidate.value.identity.headSha);
    const unmet = unmetPreconditions(
      authorization,
      {
        headSha: expectedHead,
        baseSha: performsMerge(authorization.subject.action) ? candidate.value.identity.baseSha : null,
        mergeMethod: mergeMethodFor(authorization.subject.action),
      },
      live.value,
    );
    if (unmet.length > 0) {
      return err({
        code: 'Blocked',
        reason: 'The delivery precondition is not met, so nothing was written and the authorization is untouched (F28-AC1, F28-AC2).',
        prerequisites: unmet,
      });
    }

    const permitted = gateFor(operationId, deps.clock.now());
    if (!permitted.ok) return err(permitted.error);

    const proposed = liveSubjectFor(authorization, live.value, delivery.subject.destination, delivery.subject.componentDeployments);
    const consumed = consumeDeliveryAuthorization({
      authorizationId: input.authorizationId,
      actor: input.actor,
      proposed,
      correlationId: input.correlationId,
    });
    if (!consumed.ok) return err(consumed.error);

    const liveHead = headOf(live.value);
    if (liveHead === null) {
      return err({
        code: 'Unavailable',
        reason: `The provider reports no head for ${delivery.targetBranch}, so no head precondition can be sent (F26-AC3).`,
      });
    }

    const intent = deps.operations.recordIntent({
      operationId,
      projectId: delivery.projectId,
      kind: ledgerKindFor(authorization.subject.action),
      target: `${delivery.repository.fullName}#${delivery.targetBranch}@${liveHead.slice(0, 12)}`,
      expectedRefs: [],
      correlationId: input.correlationId,
      at: deps.clock.now(),
    });
    if (!intent.ok) return err(intent.error);
    const again = deps.operations.assertWritable(operationId, deps.clock.now());
    if (!again.ok) return err(again.error);
    const bound = beginsOwnDelivery(authorization.subject.action)
      ? deps.journal.bindOperation(delivery.deliveryId, operationId)
      : ok(delivery);
    if (!bound.ok) return err(bound.error);

    // The write is now in flight. The lifecycle table has no `Authorized -> Merged` edge
    // precisely because a delivery that was never attempted is different from one whose
    // provider call is outstanding and may yet be lost (F28-AC4).
    const inFlight = deps.journal.transition({
      deliveryId: bound.value.deliveryId,
      to: performsMerge(authorization.subject.action) ? 'Merging' : 'Releasing',
      at: deps.clock.now(),
      operationId,
    });
    if (!inFlight.ok) return err(inFlight.error);

    return ok({
      delivery: inFlight.value,
      authorization,
      consumed: consumed.value,
      live: live.value,
      candidate: candidate.value,
      operationId,
      precondition: { kind: 'ProviderExpectedHead', expectedHeadSha: liveHead },
    });
  };

  /**
   * F28-AC3, F28-AC4, N01-AC2: settle a merge attempt.
   *
   * Four branches, four different facts, kept apart on purpose:
   *
   *   - a confirmed merge records the provider's merge commit and the content relation to
   *     the tested candidate, because "merged" and "merged what you approved" are separate
   *     claims and F26-AC4 needs both (F26-AC4);
   *   - a `Conflict` from the provider is a *definite* failure carrying the provider's own
   *     reason, not a lost response;
   *   - `OutcomeUnknown` means the write may have landed, so the ledger and the delivery
   *     both say so and nothing may write again until reconciliation settles it (F28-AC4);
   *   - any other refusal is recorded as `Failed` with the provider's reason.
   */
  const settleMerge = (
    prepared: { readonly deliveryId: string; readonly operationId: OperationId; readonly at: string },
    outcome: Result<MergeOutcome, DomainError>,
  ): Result<{ readonly outcome: MergeOutcome; readonly disposition: 'Merged' | 'AlreadyPresent' }, DomainError> => {
    if (outcome.ok) {
      const settled = deps.operations.recordOutcome(prepared.operationId, {
        status: 'Succeeded',
        at: prepared.at,
        detail: providerText(`The provider merged and reported ${outcome.value.mergeCommitSha.slice(0, 12)}.`),
        operationRef: outcome.value.mergeCommitSha,
      });
      if (!settled.ok) return err(settled.error);
      const moved = deps.journal.transition({
        deliveryId: prepared.deliveryId,
        to: 'Merged',
        at: outcome.value.mergedAt,
        mergeCommitSha: outcome.value.mergeCommitSha,
        operationId: prepared.operationId,
      });
      if (!moved.ok) return err(moved.error);
      return ok({
        outcome: outcome.value,
        disposition: outcome.value.kind === 'AlreadyMerged' ? 'AlreadyPresent' : 'Merged',
      });
    }
    return err(settleRefusal(prepared.deliveryId, prepared.operationId, outcome.error, prepared.at));
  };

  /**
   * F28-AC3, F28-AC4: settle an attempt that did not confirm.
   *
   * `OutcomeUnknown` is passed through rather than swallowed, because the caller needs the
   * operation identity to reconcile: that is the difference between "the provider said no"
   * and "we do not know", and collapsing them is how a lost merge becomes a second merge
   * (F30-AC5, N01-AC2).
   */
  const settleRefusal = (
    deliveryId: string,
    operationId: OperationId,
    error: DomainError,
    at: string,
  ): DomainError => {
    if (error.code === 'OutcomeUnknown') {
      const unresolved = deps.operations.recordOutcome(operationId, {
        status: 'OutcomeUnknown',
        at,
        detail: providerText(error.reason),
      });
      if (!unresolved.ok) return unresolved.error;
      const moved = deps.journal.transition({
        deliveryId,
        to: 'OutcomeUnknown',
        at,
        detail: providerText(error.reason),
        operationId,
      });
      if (!moved.ok) return moved.error;
      return error;
    }
    const failed = deps.operations.recordOutcome(operationId, {
      status: 'Failed',
      at,
      detail: providerText(error.reason),
    });
    if (!failed.ok) return failed.error;
    const moved = deps.journal.transition({
      deliveryId,
      to: 'Failed',
      at,
      detail: providerText(error.reason),
      operationId,
    });
    if (!moved.ok) return moved.error;
    return error;
  };

  /**
   * F26-AC1, F26-AC2, F26-AC3, F26-AC4, F28-AC1, F28-AC4: performs the authorized merge.
   *
   * The provider is called exactly once, and the head precondition it receives is the one
   * re-checked by the live read moments earlier rather than the value the authorization was
   * issued against, so the compare-and-set the provider applies is the one ShipLoop
   * actually verified.
   */
  const executeMerge = async (input: ExecuteDeliveryInput): Promise<Result<MergeExecution, DomainError>> => {
    const owner = requireOwner(input.actor);
    if (!owner.ok) return err(owner.error);
    const decision = decisionFor(input.authorizationId);
    if (!decision.ok) return err(decision.error);
    const action = (decision.value.subject as AuthorizationSubject).action;
    if (!performsMerge(action)) {
      return err(
        invalid(`Authorization ${input.authorizationId} authorizes a ${action.kind}, which performs no merge, so executeMerge does not apply to it.`, [
          { path: 'action', message: 'Use executeRelease for a release authorization, or authorize a merge (F26-AC1).' },
        ]),
      );
    }
    const method = mergeMethodFor(action);
    if (method === null) {
      return err(invalid(`Authorization ${input.authorizationId} names no merge method.`, [{ path: 'action', message: 'A merge authorization must name the merge method the owner approved (F26-AC1).' }]));
    }

    const prepared = await prepareWrite(input);
    if (!prepared.ok) return err(prepared.error);
    const pullRequestId = prepared.value.authorization.subject.pullRequestId;
    if (pullRequestId === null) {
      return err(
        invalid('This authorization names no pull request to merge.', [
          { path: 'pullRequestId', message: 'Required for a merge (F26-AC1).' },
        ]),
      );
    }

    const request: MergePullRequestRequest = {
      operationId: prepared.value.operationId,
      authorizationId: input.authorizationId,
      repository: prepared.value.delivery.repository,
      pullRequestId: pullRequestId as ProviderId,
      expectedHeadSha: prepared.value.candidate.identity.headSha,
      targetBranch: prepared.value.delivery.targetBranch,
      method,
      precondition: prepared.value.precondition,
    };
    const attempted = await deps.git.mergePullRequest(
      contextFor(prepared.value.operationId, input.correlationId),
      request,
    );
    const at = deps.clock.now();
    const settled = settleMerge(
      { deliveryId: prepared.value.delivery.deliveryId, operationId: prepared.value.operationId, at },
      attempted,
    );
    if (!settled.ok) return err(settled.error);

    const merged = settled.value.outcome;
    const mergeCommitSha = merged.mergeCommitSha;
    return ok({
      deliveryId: prepared.value.delivery.deliveryId,
      operationId: prepared.value.operationId,
      state: 'Merged',
      mergeCommitSha,
      headSha: merged.kind === 'Merged' ? merged.headSha : prepared.value.candidate.identity.headSha,
      targetBranch: prepared.value.delivery.targetBranch,
      mergedAt: merged.mergedAt,
      disposition: settled.value.disposition,
      // `AlreadyMerged` means the provider confirms the content it merged, so the
      // authorized head is the content relation; the adapter does not re-report it (F26-AC4).
      contentRelation:
        merged.kind === 'Merged' ? merged.contentRelation : { kind: 'MatchesAuthorizedHead' },
      precondition: prepared.value.precondition,
      consumedAuthorization: prepared.value.consumed,
    });
  };

  /**
   * F27-AC1, F27-AC2, F27-AC5, F28-AC1, F28-AC2, F28-AC3, F29-AC5: performs the authorized
   * release and confirms it live.
   *
   * A merge-only authorization is refused, which is F27-AC5's actual content: there is no
   * route here that authorizes a production change the merge already triggered.
   *
   * A delivery becomes `Released` only when `verifyDestination` returns `Confirmed` *and*
   * the configured live smoke requirement is satisfied. Anything else is a named, typed
   * failure recording which components were released and which were not with the
   * provider's reason for each, because a partial release is the outcome most likely to be
   * misreported as a success (F28-AC2, F28-AC3).
   */
  const executeRelease = async (input: ExecuteDeliveryInput): Promise<Result<ReleaseExecution, DomainError>> => {
    const owner = requireOwner(input.actor);
    if (!owner.ok) return err(owner.error);
    const decision = decisionFor(input.authorizationId);
    if (!decision.ok) return err(decision.error);
    const authorization = authorizationFor(decision.value);
    const action = authorization.subject.action;
    if (action.kind === 'Merge') {
      return err(
        invalid(
          `Authorization ${input.authorizationId} authorizes a merge only; a separate release needs its own authorization, and a post-merge button would be pretending to authorize a change the merge already triggered (F27-AC2, F27-AC5).`,
          [
            {
              path: 'action',
              message:
                'A post-merge release button would be pretending to authorize a production change the merge already triggered (F27-AC2, F27-AC5).',
            },
          ],
        ),
      );
    }
    if (authorization.subject.componentDeployments.length === 0) {
      return err(
        invalid('This authorization names no component, so there is nothing to release.', [
          { path: 'action', message: 'A release must name the components it delivers (F27-AC1, F28-AC2).' },
        ]),
      );
    }
    // Checked before the delivery is opened, because a refusal about the request must not
    // leave the delivery in flight. Reversing a migration is not a code redeploy, so it is
    // stated rather than inferred from an omitted field (F28-AC5).
    const reversalStatement = requiredReversalStatement(input, action);
    if (!reversalStatement.ok) return err(reversalStatement.error);
    const liveSmoke: LiveSmokeRequirement =
      input.liveSmoke ?? { kind: 'None', reason: 'No live smoke probe is configured for this destination (F28-AC2).' };

    const prepared = await prepareWrite(input);
    if (!prepared.ok) return err(prepared.error);
    const delivery = prepared.value.delivery;
    const at = deps.clock.now();

    // A combined merge/release authorization is observing a pipeline the merge already
    // triggered, never triggering a second one (F27-AC2, F28-AC1).

    const executed: { readonly component: string; readonly operationId: OperationId }[] = [];
    for (const component of authorization.subject.componentDeployments) {
      const source = delivery.components.find((entry) => entry.component === component.component);
      if (source?.deploymentId === null || source?.deploymentId === undefined) {
        return err(
          settleRefusal(
            delivery.deliveryId,
            prepared.value.operationId,
            {
              code: 'Blocked',
              reason: `Component ${component.component} has no recorded deployment to deliver from, so nothing was written for it (F22-AC2, F28-AC1).`,
              prerequisites: [
                {
                  name: component.component,
                  detail: 'The candidate recorded no provider deployment identity for this component.',
                  remedy: 'Record the deployment the release delivers from, then authorize again.',
                },
              ],
            },
            at,
          ),
        );
      }
      const action = ok(
        deliveryActionFor(authorization, delivery, component.component, source.environment, source.deploymentId, reversalStatement.value),
      );
      const childOperationId = componentOperationId(prepared.value.operationId, component.component);
      const begun = deps.operations.recordIntent({
        operationId: childOperationId,
        projectId: delivery.projectId,
        kind: ledgerKindFor(authorization.subject.action),
        target: `${authorization.subject.destination}/${component.component}`,
        expectedRefs: [{ id: source.deploymentId, kind: 'Deployment', url: source.deploymentUrl }],
        correlationId: input.correlationId,
        at,
      });
      if (!begun.ok) return err(begun.error);
      const permitted = gateFor(childOperationId, at);
      if (!permitted.ok) return err(permitted.error);

      const performed = await deps.deployments.executeDeliveryAction(
        contextFor(childOperationId, input.correlationId),
        action.value,
      );
      if (!performed.ok) {
        return err(settleRefusal(delivery.deliveryId, childOperationId, performed.error, at));
      }
      const settled = deps.operations.recordOutcome(childOperationId, {
        status: 'Succeeded',
        at,
        detail: providerText(
          `The provider ${performed.value.kind === 'Triggered' ? 'accepted' : 'completed'} the delivery of ${component.component} on ${authorization.subject.destination}.`,
        ),
        operationRef:
          performed.value.kind === 'Triggered'
            ? performed.value.providerOperationReference
            : performed.value.kind === 'NoActionRequired'
              ? `${performed.value.detail}`
              : performed.value.deployment.deploymentId,
      });
      if (!settled.ok) return err(settled.error);
      executed.push({ component: component.component, operationId: childOperationId });
    }

    // The confirmation is read under the first executed component's operation, so the
    // destination read and the delivery that produced it share one identity.
    const confirmation = executed[0];
    if (confirmation === undefined) {
      return err({
        code: 'Unavailable',
        reason: 'No component was delivered, so there is no delivery to confirm (F28-AC2).',
      });
    }
    const verify = await deps.deployments.verifyDestination(
      contextFor(confirmation.operationId, input.correlationId),
      {
        operationId: confirmation.operationId,
        destination: authorization.subject.destination,
        expectedRepositoryFullName: delivery.repository.fullName,
        expectedCommitSha: prepared.value.candidate.identity.headSha,
        expectedEnvironment: environmentOf(delivery),
        requiredComponents: authorization.subject.componentDeployments.map((entry) => entry.component),
        liveSmoke,
      },
    );
    if (!verify.ok) {
      return err(settleRefusal(delivery.deliveryId, confirmation.operationId, verify.error, at));
    }
    return settleRelease(prepared.value, verify.value, liveSmoke, at);
  };

  /**
   * The provider action one component's delivery performs (F28-AC1, F28-AC5).
   *
   * Three shapes, and the difference between them is the whole of F28-AC5: redeploying
   * code, redeploying code *with a migration reversal*, and observing a pipeline the merge
   * already triggered. Only the last writes nothing, so a combined approval cannot trigger a
   * second production change after the merge that already did (F27-AC2, F28-AC1).
   */
  const deliveryActionFor = (
    authorization: OwnerAuthorization,
    delivery: DeliveryRecord,
    component: string,
    environment: string,
    sourceDeploymentId: string,
    reversalStatement: string | null,
  ): PermittedDeliveryAction => {
    const action = authorization.subject.action;
    if (action.kind === 'MergeAndRelease') {
      return {
        kind: 'ObserveAuthorizedPipeline',
        deploymentId: sourceDeploymentId as ProviderId,
        pipelineReference: delivery.mergeCommitSha ?? delivery.headSha,
        authorizationId: authorization.authorizationId,
      };
    }
    if (action.kind === 'RecoveryRedeploy' && reversalStatement !== null) {
      return {
        kind: 'RedeployWithMigrationReversal',
        sourceDeploymentId: sourceDeploymentId as ProviderId,
        component,
        environment,
        authorizationId: authorization.authorizationId,
        reversalStatement: providerText(reversalStatement),
        ownerConfirmedReversal: true,
      };
    }
    return {
      kind: 'RedeployCode',
      sourceDeploymentId: sourceDeploymentId as ProviderId,
      component,
      environment,
      authorizationId: authorization.authorizationId,
    };
  };

  /**
   * F28-AC2, F28-AC3, F29-AC5: settle a release against its live confirmation.
   *
   * Component states and smoke rows are written before the delivery state moves, so a
   * receipt written afterwards reads component evidence that is already durable rather
   * than a summary that only existed in memory (F29-AC1, F29-AC5).
   */
  const settleRelease = (
    prepared: {
      readonly delivery: DeliveryRecord;
      readonly authorization: OwnerAuthorization;
      readonly candidate: CandidateRecord;
      readonly consumed: ConsumedAuthorization;
      readonly operationId: OperationId;
    },
    verification: DestinationVerification,
    liveSmoke: LiveSmokeRequirement,
    at: string,
  ): Result<ReleaseExecution, DomainError> => {
    const { delivery, authorization, operationId } = prepared;
    const smoke = verification.smoke;
    // A partial confirmation names the components that did arrive, and those are the ones a
    // receipt may call released (F28-AC2, F29-AC5).
    const confirmed = verification.kind === 'Unverifiable' ? [] : verification.components;
    const failures: readonly ComponentFailure[] = verification.kind === 'PartiallyConfirmed' ? verification.failures : [];

    for (const probe of smokeProbes(smoke, liveSmoke)) {
      const written = deps.journal.recordSmoke({
        deliveryId: delivery.deliveryId,
        component: probe.component,
        candidateFingerprint: authorization.subject.candidateFingerprint,
        result: probe.result,
        artifactRef: null,
        detail: probe.detail === null ? null : providerText(probe.detail),
        observedAt: at,
      });
      if (!written.ok) return err(written.error);
    }
    const components = deps.journal.recordComponents(
      delivery.deliveryId,
      authorization.subject.componentDeployments.map((entry) => {
        const arrived = confirmed.find((released) => released.component === entry.component);
        return {
          component: entry.component,
          state: arrived === undefined ? 'Failed' : 'Released',
          deploymentId: arrived?.deploymentId ?? null,
          deploymentUrl: arrived?.url ?? null,
        };
      }),
      at,
    );
    if (!components.ok) return err(components.error);

    if (verification.kind === 'Confirmed' && smokeSatisfies(smoke, liveSmoke)) {
      const settled = deps.operations.recordOutcome(operationId, {
        status: 'Succeeded',
        at,
        detail: providerText(
          `The provider confirmed ${confirmed.map((entry) => entry.component).join(', ')} on ${authorization.subject.destination} and the live smoke check passed.`,
        ),
        operationRef: confirmed.map((entry) => entry.deploymentId).join(','),
      });
      if (!settled.ok) return err(settled.error);
      const moved = deps.journal.transition({ deliveryId: delivery.deliveryId, to: 'Released', at, operationId });
      if (!moved.ok) return err(moved.error);
      return ok({
        deliveryId: delivery.deliveryId,
        operationId,
        state: 'Released',
        destination: authorization.subject.destination,
        headSha: prepared.candidate.identity.headSha,
        releasedAt: at,
        verifiedAt: verification.verifiedAt,
        components: confirmed.map((entry) => ({
          component: entry.component,
          deploymentId: entry.deploymentId,
          url: entry.url,
          environment: entry.environment,
        })),
        smokeResult: smokeResultName(smoke),
        consumedAuthorization: prepared.consumed,
      });
    }

    // F29-AC5: a partial release names every component that did not reach the destination
    // and the reason the provider gave, as prerequisites the owner can act on. A list of
    // successes with a silent gap is the failure this exists to prevent.
    const unreleased = releaseUnreleased(authorization, verification, failures);
    const reason = providerText(
      verification.kind === 'Unverifiable'
        ? `The destination ${authorization.subject.destination} could not be verified: ${verification.detail} (F28-AC3).`
        : verification.kind === 'PartiallyConfirmed'
          ? `Component${unreleased.length === 1 ? '' : 's'} ${unreleased.map((entry) => entry.component).join(', ')} did not reach ${authorization.subject.destination}, so the release is not confirmed (F28-AC3, F29-AC5).`
          : `The live smoke check on ${authorization.subject.destination} reported ${smokeResultName(smoke)}${smoke.kind === 'Failed' ? `: ${smoke.detail}` : ''}, so the release is not confirmed (F28-AC2).`,
    );
    return err(
      settleRefusal(
        delivery.deliveryId,
        operationId,
        {
          code: 'Blocked',
          reason,
          prerequisites: unreleased.map((entry) => ({
            name: entry.component,
            detail: providerText(entry.reason),
            remedy: 'Resolve the component, then authorize a new release for the components that are not live.',
          })),
        },
        at,
      ),
    );
  };

  /* ---------------------------------------------------------------------- */
  /* F28-AC4, F30-AC3, F30-AC5: reconciliation                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Establishes what a delivery whose response was lost actually did, by reading the
   * target. It never writes to a provider, which is what makes it safe to run on a timer.
   *
   * The three outcomes are the point:
   *
   *   - `DidHappen` is the only one that moves the delivery forward, and only through an
   *     edge the domain lifecycle table allows;
   *   - `DidNotHappen` records a *definite* provider refusal in the ledger and returns the
   *     delivery to `Failed`, because the authorization was single-use and a repeat would
   *     need a new owner decision. It does not retry anything;
   *   - `StillUnknown` leaves both the ledger and the delivery exactly as they were, which
   *     is the honest state when a read establishes neither answer (F28-AC4, F30-AC5).
   *
   * Reconciling a delivery that already holds a definite outcome is refused: nothing is in
   * doubt, and recording a resolution would overwrite the fact that settled it.
   */
  const reconcileDelivery = async (
    input: ReconcileDeliveryInput,
  ): Promise<Result<ReconciledDelivery, DomainError>> => {
    if (input.resolvedBy.trim().length === 0) {
      return err(
        invalid('A reconciliation must name who established it.', [
          { path: 'resolvedBy', message: 'Must not be empty; an unattributable settlement is not a record (F32-AC1).' },
        ]),
      );
    }
    const found =
      input.deliveryId === undefined
        ? deps.journal.findByOperation(input.operationId)
        : deps.journal.get(input.deliveryId);
    if (!found.ok) return err(found.error);
    const delivery = found.value;
    if (delivery === null) {
      const operation = deps.operations.findByOperation(input.operationId);
      if (operation === null) {
        return err({ code: 'NotFound', reason: `Operation ${input.operationId} is not recorded (F30-AC5).` });
      }
      return err({
        code: 'NotFound',
        reason: `Operation ${input.operationId} is recorded but no delivery row claims it, so there is nothing to reconcile. Settle it in the operations worklist instead (F30-AC5).`,
      });
    }
    if (delivery.state !== 'OutcomeUnknown' && delivery.state !== 'Authorized' && delivery.state !== 'Merging' && delivery.state !== 'Releasing') {
      return err({
        code: 'Conflict',
        reason: `Delivery ${delivery.deliveryId} already holds the definite state ${delivery.state}, so its outcome is not in doubt (F28-AC4).`,
        expected: 'OutcomeUnknown',
        actual: delivery.state,
      });
    }

    const candidate = candidateFor(delivery.candidateId);
    if (!candidate.ok) return err(candidate.error);
    const authorizedHead = candidate.value.identity.headSha;
    const live = await deps.git.readState(contextFor('op:reconcile' as OperationId, input.correlationId), {
      repository: delivery.repository,
      branch: delivery.targetBranch,
      baseBranch: delivery.targetBranch,
    });
    if (!live.ok) {
      return ok({
        resolution: 'StillUnknown',
        deliveryId: delivery.deliveryId,
        state: delivery.state,
        detail: providerText(
          `Live provider state could not be read, so the outcome is still not established: ${live.error.reason} (F30-AC4).`,
        ),
      });
    }

    const pullRequest = live.value.pullRequest;
    if (ledgerKindOf(delivery) === MERGE_OPERATION_KIND) {
      if (pullRequest !== null && pullRequest.state === 'Merged') {
        const targetHead = headOf(live.value);
        return settleReconciled(
          delivery,
          'DidHappen',
          'Merged',
          providerText(
            `The provider reports pull request ${pullRequest.pullRequestId} as Merged, so the write did reach it. The target ${delivery.targetBranch} is at ${targetHead === null ? 'an unknown commit' : targetHead.slice(0, 12)} (F28-AC4).`,
          ),
          input,
        );
      }
      const liveHead = headOf(live.value);
      if (pullRequest !== null && pullRequest.state === 'Open' && liveHead === authorizedHead) {
        return settleReconciled(
          delivery,
          'DidNotHappen',
          'Failed',
          providerText(
            `The provider still reports pull request ${pullRequest.pullRequestId} as open with ${delivery.targetBranch} at the authorized head ${authorizedHead.slice(0, 12)}, so the merge did not happen (F28-AC4).`,
          ),
          input,
        );
      }
      return ok({
        resolution: 'StillUnknown',
        deliveryId: delivery.deliveryId,
        state: delivery.state,
        detail: providerText(
          `The provider reports the pull request as ${pullRequest?.state ?? 'absent'} and ${delivery.targetBranch} at ${liveHead === null ? 'no commit' : liveHead.slice(0, 12)}, which establishes neither outcome. The write may have landed, so it is not retried (F28-AC4, F30-AC3).`,
        ),
      });
    }

    const verify = await deps.deployments.verifyDestination(contextFor('op:reconcile' as OperationId, input.correlationId), {
      operationId: input.operationId as OperationId,
      destination: delivery.subject.destination,
      expectedRepositoryFullName: delivery.repository.fullName,
      expectedCommitSha: authorizedHead,
      expectedEnvironment: environmentOf(delivery),
      requiredComponents: delivery.subject.componentDeployments.map((entry) => entry.component),
      liveSmoke: { kind: 'None', reason: 'Reconciliation establishes identities, not smoke outcomes (F28-AC2).' },
    });
    if (!verify.ok) {
      return ok({
        resolution: 'StillUnknown',
        deliveryId: delivery.deliveryId,
        state: delivery.state,
        detail: providerText(`The destination could not be read: ${verify.error.reason} (F30-AC4).`),
      });
    }
    if (verify.value.kind === 'Confirmed') {
      return settleReconciled(
        delivery,
        'DidHappen',
        'Released',
        providerText(
          `The provider confirmed ${verify.value.components.map((entry) => entry.component).join(', ')} on ${delivery.subject.destination}, so the release did happen (F28-AC4).`,
        ),
        input,
      );
    }
    if (verify.value.kind === 'Unverifiable') {
      return ok({
        resolution: 'StillUnknown',
        deliveryId: delivery.deliveryId,
        state: delivery.state,
        detail: providerText(`${verify.value.detail} The write may have landed, so it is not repeated (F28-AC4).`),
      });
    }
    return settleReconciled(
      delivery,
      'DidNotHappen',
      'Failed',
      providerText(
        `Component${verify.value.failures.length === 1 ? '' : 's'} ${verify.value.failures.map((failure) => failure.component).join(', ')} did not reach ${delivery.subject.destination}. ${verify.value.failures.map((failure) => `${failure.component}: ${failure.detail}`).join(' ')} (F28-AC3, F29-AC5).`,
      ),
      input,
    );
  };

  /**
   * Writes the resolution, the ledger outcome and the delivery state together.
   *
   * The transition is validated against the domain lifecycle table first, so a resolution
   * that the table forbids cannot be written: `OutcomeUnknown` reaching `Released` has to
   * pass through a confirmed read, and this is the only function that can move it.
   */
  const settleReconciled = (
    delivery: DeliveryRecord,
    resolution: 'DidHappen' | 'DidNotHappen',
    state: string,
    detail: string,
    input: ReconcileDeliveryInput,
  ): Result<ReconciledDelivery, DomainError> => {
    if (!canTransition('delivery', delivery.state, state)) {
      return err({
        code: 'Conflict',
        reason: `A ${delivery.state} delivery cannot become ${state}, so the reconciliation cannot be recorded. Read live state again rather than forcing the move (F28-AC4).`,
        expected: delivery.state,
        actual: state,
      });
    }
    const at = deps.clock.now();
    const operationId = input.operationId as OperationId;
    const outcome =
      resolution === 'DidHappen'
        ? deps.operations.recordOutcome(operationId, { status: 'Succeeded', at, detail, operationRef: state })
        : deps.operations.recordOutcome(operationId, { status: 'Failed', at, detail });
    if (!outcome.ok) return err(outcome.error);
    const moved = deps.journal.transition({ deliveryId: delivery.deliveryId, to: state, at, detail, operationId });
    if (!moved.ok) return err(moved.error);
    return ok({ resolution, deliveryId: delivery.deliveryId, state, detail });
  };

  /* ---------------------------------------------------------------------- */
  /* F30-AC4, F30-AC5: the bounded sweep                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * A bounded sweep over the operations whose result is not established.
   *
   * Bounded in both directions: at most `limit` operations are considered, and an operation
   * that cannot be settled is left untouched with its next attempt at an exponentially
   * growing distance from now, capped so nothing is abandoned forever. Every entry is
   * reconciled by a read, so a sweep can never cause a second external write, which is the
   * only reason it is safe to run unattended.
   */
  const frequentOperationReconciliation = async (
    input: ReconciliationSweepInput,
  ): Promise<Result<ReconciliationSweepReport, DomainError>> => {
    const limit = input.limit ?? DEFAULT_SWEEP_LIMIT;
    const baseDelayMs = input.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxDelayMs = input.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    if (limit <= 0) {
      return err(
        invalid('A reconciliation sweep needs a positive bound.', [
          { path: 'limit', message: 'Must be greater than zero; a sweep has to stop (F30-AC4).' },
        ]),
      );
    }

    const due = deps.operations.pendingReconciliation(input.now, limit * 2);
    const report = {
      swept: 0,
      didHappen: 0,
      didNotHappen: 0,
      stillUnknown: 0,
      deferred: [] as { operationId: string; nextAttemptAt: string }[],
    };

    for (const operation of due) {
      if (report.swept >= limit) {
        report.deferred.push({ operationId: operation.operationId, nextAttemptAt: addMs(input.now, baseDelayMs) });
        continue;
      }
      const reconciled = await reconcileDelivery({
        operationId: operation.operationId,
        resolvedBy: 'frequent-reconciliation-sweep',
        correlationId: input.correlationId,
      });
      report.swept += 1;
      if (!reconciled.ok) {
        report.stillUnknown += 1;
        report.deferred.push({ operationId: operation.operationId, nextAttemptAt: addMs(input.now, backoffFor(operation, input.now, baseDelayMs, maxDelayMs)) });
        continue;
      }
      if (reconciled.value.resolution === 'DidHappen') {
        report.didHappen += 1;
        continue;
      }
      if (reconciled.value.resolution === 'DidNotHappen') {
        report.didNotHappen += 1;
        continue;
      }
      report.stillUnknown += 1;
      report.deferred.push({ operationId: operation.operationId, nextAttemptAt: addMs(input.now, backoffFor(operation, input.now, baseDelayMs, maxDelayMs)) });
    }
    return ok(report);
  };

  /**
   * The delay before an operation is considered again.
   *
   * Doubling per base-delay interval of unresolved age, capped at `maxDelayMs`. Keyed on
   * how long the operation has been unresolved rather than on a counter, because
   * `external_operations` has no attempt column and a counter kept in memory would reset
   * every time the process restarts - which is exactly when a hot loop is most likely.
   */
  function backoffFor(operation: ExternalOperation, now: string, baseDelayMs: number, maxDelayMs: number): number {
    const age = Math.max(0, Date.parse(now) - Date.parse(operation.updatedAt));
    const steps = Math.min(20, Math.floor(age / Math.max(1, baseDelayMs)));
    return Math.min(maxDelayMs, baseDelayMs * 2 ** steps);
  }

  /* ---------------------------------------------------------------------- */
  /* F29: receipts                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * F29-AC1, F29-AC2, F29-AC3, F29-AC4, F29-AC5: writes the receipt for one delivery.
   *
   * Three rules, and the first is the load-bearing one: a receipt records an *established*
   * result, so a delivery still in `OutcomeUnknown` is refused outright. A receipt written
   * from an unconfirmed write would be the single most damaging thing this product could
   * do, because it is the record the owner's issue closure is derived from (F29-AC3).
   *
   * A `Failed` delivery does get a receipt, and it is typed: it carries the provider's own
   * reason and an empty `releasedComponents` list, so "it did not ship, and this is why" is
   * a durable fact rather than an absence (F29-AC2). A second call for the same delivery
   * returns the receipt that exists and writes nothing, because `deliveries` is `UNIQUE`
   * in `release_receipts` and a retry republishes nothing (F29-AC4).
   */
  const releaseReceipt = (input: ReleaseReceiptInput): Result<ReleaseReceiptReport, DomainError> => {
    const owner = requireOwner(input.actor);
    if (!owner.ok) return err(owner.error);
    const found = deps.journal.get(input.deliveryId);
    if (!found.ok) return err(found.error);
    const delivery = found.value;

    const existing = deps.journal.findReceipt(delivery.deliveryId);
    if (!existing.ok) return err(existing.error);
    if (existing.value !== null) {
      return ok({ kind: 'AlreadyRecorded', receipt: existing.value });
    }

    if (delivery.state === 'OutcomeUnknown' || delivery.state === 'Merging' || delivery.state === 'Releasing') {
      return err({
        code: 'Blocked',
        reason: `Delivery ${delivery.deliveryId} is ${delivery.state}, so no confirmed result exists to receipt. Reconcile it against live provider state first; a receipt written now would be a claim nothing established (F29-AC3).`,
        prerequisites: [
          {
            name: 'A confirmed provider result',
            detail: `The delivery is ${delivery.state} and the operation has no settled outcome.`,
            remedy: 'Run reconciliation. Only a confirmed read may move this delivery (F28-AC4).',
          },
        ],
      });
    }

    const established = delivery.state === 'Merged' || delivery.state === 'Released' || delivery.state === 'Failed';
    if (!established) {
      return err({
        code: 'Blocked',
        reason: `Delivery ${delivery.deliveryId} is ${delivery.state}, which is not a delivery result, so there is nothing to receipt (F29-AC3).`,
        prerequisites: [
          {
            name: 'An authorized delivery',
            detail: `Its state is ${delivery.state}.`,
            remedy: 'Authorize and perform the delivery, or reconcile an unresolved one.',
          },
        ],
      });
    }

    const candidate = candidateFor(delivery.candidateId);
    if (!candidate.ok) return err(candidate.error);
    const decisions = deps.decisions.listForWorkItem(delivery.workItemId);
    if (!decisions.ok) return err(decisions.error);

    const smokes = deps.journal.listSmoke(delivery.deliveryId);
    if (!smokes.ok) return err(smokes.error);
    const at = deps.clock.now();
    const components = receiptComponents(delivery, smokes.value);
    const receipt: ReleaseReceipt = {
      receiptId: receiptIdFor(delivery.deliveryId),
      deliveryId: delivery.deliveryId,
      projectId: delivery.projectId,
      workItemId: delivery.workItemId,
      candidateId: delivery.candidateId,
      outcome: delivery.state === 'Failed' ? 'Failed' : 'Confirmed',
      headSha: candidate.value.identity.headSha,
      baseSha: candidate.value.identity.baseSha,
      // F26-AC4: the receipt names the commit the provider actually produced, not the
      // authorized head, because a squash commit and the tested head are different commits.
      mergeSha: delivery.mergeCommitSha,
      destination: delivery.subject.destination,
      targetBranch: delivery.targetBranch,
      pullRequestId: delivery.pullRequestId,
      checks: input.checks.map((check) => ({
        name: providerText(check.name),
        result: check.result,
        detail: check.detail === null ? null : providerText(check.detail),
      })),
      ownerDecisions: decisions.value
        .filter((decision) => decision.candidateFingerprint === candidate.value.candidateFingerprint)
        .map((decision) => ({
          decisionId: decision.decisionId,
          decisionType: decision.decisionType,
          ownerId: decision.actorOwnerId,
          decidedAt: decision.createdAt,
        })),
      components,
      releasedComponents: components.filter((component) => component.released).map((component) => component.component),
      unreleasedComponents: components
        .filter((component) => !component.released)
        .map((component) => ({ component: component.component, reason: component.reason ?? 'not released' })),
      smokeResult: smokeNameFor(smokes.value),
      failureReason: delivery.state === 'Failed' ? providerText(delivery.failureDetail ?? 'the provider refused the delivery') : null,
      deliveryState: delivery.state,
      link: input.link === null ? null : providerText(input.link),
      createdAt: at,
      // Closure is requested by the sibling publication path and finalized there; a null
      // `finalized_at` is what "Pending sync" reads as (F29-AC4).
      finalizedAt: null,
      issueClosedAt: null,
    };
    const recorded = deps.journal.recordReceipt(receipt);
    if (!recorded.ok) return err(recorded.error);
    return ok({ kind: 'Recorded', receipt: recorded.value });
  };

  /**
   * The component evidence a receipt carries.
   *
   * Read from the durable component and smoke rows rather than from the in-memory summary
   * of the last attempt, so a receipt written after a process restart still says which
   * components reached the destination and which did not (F29-AC5).
   */
  const receiptComponents = (
    delivery: DeliveryRecord,
    smokes: readonly SmokeRow[],
  ): readonly ReceiptComponent[] =>
    delivery.subject.componentDeployments.map((entry) => {
      const row = delivery.components.find((component) => component.component === entry.component);
      const released = row?.state === 'Released';
      return {
        component: entry.component,
        released,
        deploymentId: row?.deploymentId ?? entry.deploymentId,
        deploymentUrl: row?.deploymentUrl ?? null,
        environment: row?.environment ?? environmentOf(delivery),
        smokeResult: smokeNameFor(smokes, entry.component),
        // The provider's own words for this component where the smoke row recorded them,
        // and the delivery's recorded failure otherwise. Either way it is a reason that was
        // observed, never one this layer composed (F29-AC2, F29-AC5).
        reason: released
          ? null
          : providerText(
              smokes.find((smoke) => smoke.component === entry.component)?.detail ??
                delivery.failureDetail ??
                `The provider did not confirm ${entry.component} on ${delivery.subject.destination}.`,
            ),
      };
    });

  /**
   * The ledger kind a delivery row's operation was recorded under.
   *
   * Derived from the bound action, which is the fact the authorization states, rather than
   * from the current state name: a release that failed was still a release, and reading the
   * state instead would send reconciliation to the wrong provider.
   */
  const ledgerKindOf = (delivery: DeliveryRecord): string =>
    performsMerge(delivery.subject.action) ? MERGE_OPERATION_KIND : RELEASE_OPERATION_KIND;

  /**
   * The environment a delivery's components are confirmed in (F28-AC2).
   *
   * Read from the durable component rows the candidate recorded, not guessed: a
   * confirmation matched against the wrong environment is a false `Released`.
   */
  const environmentOf = (delivery: DeliveryRecord): string =>
    delivery.components[0]?.environment ?? 'production';

  return {
    authorizeDelivery,
    consumeDeliveryAuthorization,
    executeMerge,
    executeRelease,
    reconcileDelivery,
    releaseReceipt,
    frequentOperationReconciliation,
  };
}

/* -------------------------------------------------------------------------- */
/* Identities                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The operation identity one component's delivery owns.
 *
 * Derived from the delivery's own operation and the component name, so a retry of one
 * component's write is refused by the ledger before it reaches the provider, while a second
 * component still gets a distinct identity and is both delivered and reconciled on its own
 * (F28-AC3, F28-AC4).
 */
export function componentOperationId(operationId: OperationId, component: string): OperationId {
  return `${operationId}:${component}` as OperationId;
}

/** The delivery row identity one authorization owns. */
export function deliveryRowId(authorizationId: string): string {
  return `dlv_${createHash('sha256').update(authorizationId, 'utf8').digest('hex').slice(0, 32)}`;
}

/** The receipt identity one delivery owns, so a retry addresses the same row (F29-AC4). */
export function receiptIdFor(deliveryId: string): ShipLoopId<ReceiptId> {
  return `rcpt_${createHash('sha256').update(deliveryId, 'utf8').digest('hex').slice(0, 32)}` as ShipLoopId<ReceiptId>;
}

/**
 * The migration reversal a recovery redeploy must state before anything is opened (F28-AC5).
 *
 * Required by the action rather than by the caller, so the two cannot disagree: a
 * `RecoveryRedeploy` with no reversal is refused, and every other action needs none.
 */
function requiredReversalStatement(
  input: ExecuteDeliveryInput,
  action: DeliveryAction,
): Result<string | null, DomainError> {
  const stated = input.reversalStatement;
  if (action.kind !== 'RecoveryRedeploy') {
    if (stated !== undefined) {
      return err(
        invalid('Only a recovery redeploy reverses state, so this action may not carry a migration reversal (F28-AC5).', [
          { path: 'reversalStatement', message: 'A merge or a release never reverses schema.' },
        ]),
      );
    }
    return ok(null);
  }
  if (stated === undefined || stated.trim().length === 0) {
    return err(
      invalid('A recovery redeploy must state the migration reversal it performs, because reversing a migration is not a code redeploy (F28-AC5).', [
        { path: 'reversalStatement', message: 'State the reversal explicitly rather than omitting it.' },
      ]),
    );
  }
  return ok(stated);
}

/**
 * The smoke verdict a receipt records for a component, or for the delivery as a whole.
 *
 * `NotRun` when nothing was observed, and `Passed` only when every recorded probe passed.
 * A receipt must not read `Passed` because one of two probes passed (F28-AC2, F29-AC1).
 */
function smokeNameFor(smokes: readonly SmokeRow[], component?: string): string {
  const selected = component === undefined ? smokes : smokes.filter((row) => row.component === component);
  if (selected.length === 0) return 'NotRun';
  return selected.every((row) => row.result === 'Passed') ? 'Passed' : 'Failed';
}

/**
 * The components a release left unreleased, each with the reason the provider gave.
 *
 * F29-AC5 asks the receipt to name which components were released and which were not, so a
 * partial release is readable as a partial release rather than as a list of successes with
 * a silent gap.
 */
function releaseUnreleased(
  authorization: OwnerAuthorization,
  verification: DestinationVerification,
  failures: readonly ComponentFailure[],
): readonly { readonly component: string; readonly reason: string }[] {
  const released = new Set(
    verification.kind === 'Unverifiable'
      ? []
      : verification.components.map((entry) => entry.component),
  );
  const byComponent = new Map(failures.map((failure) => [failure.component, failure.detail]));
  return authorization.subject.componentDeployments
    .map((entry) => entry.component)
    .filter((component) => !released.has(component))
    .map((component) => ({
      component,
      reason:
        byComponent.get(component) ??
        (verification.kind === 'Unverifiable'
          ? verification.detail
          : `The provider did not confirm ${component} on ${authorization.subject.destination}.`),
    }));
}

/* -------------------------------------------------------------------------- */
/* SQLite journal                                                               */
/* -------------------------------------------------------------------------- */

const DELIVERY_COLUMNS =
  'delivery_id, work_item_id, project_id, candidate_id, decision_id, operation_id, state, correlation_id, manifest_json, pull_request_id, head_sha, target_branch, unknown_since, merged_at, released_at, failed_at, failure_detail_redacted, created_at, updated_at';

const DELIVERY_COMPONENT_COLUMNS =
  'delivery_id, component, deployment_id, deployment_url, environment, state, created_at, updated_at';

const SMOKE_COLUMNS =
  'smoke_id, delivery_id, component, candidate_fingerprint, result, artifact_ref, detail_redacted, observed_at, created_at';

const RECEIPT_COLUMNS =
  'receipt_id, delivery_id, project_id, work_item_id, candidate_id, merge_sha, provider_release_id, provider_deployment_ids, issue_closed_at, receipt_json, created_at, finalized_at';

const DELIVERY_STATES: readonly string[] = [
  'NotAuthorized',
  'Authorized',
  'Merging',
  'Merged',
  'Releasing',
  'Released',
  'Failed',
  'OutcomeUnknown',
];

const CHECK_RESULTS: readonly string[] = [
  'Passed',
  'Failed',
  'Missing',
  'Waiting',
  'Stale',
  'NotApplicable',
];

/** The delivery manifest: the facts F27-AC1 says a release manifest carries. */
interface DeliveryManifest {
  readonly subject: AuthorizationSubject;
  readonly repository: GitRepositoryRef;
  readonly mergeCommitSha: string | null;
}

function requiredText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`column ${column} is missing or not text`);
  return value;
}

function optionalText(row: SqlRow, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

function parseJson<T>(value: string, what: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (cause) {
    throw new Error(`${what} is not readable JSON: ${String(cause)}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The durable delivery, component, smoke and receipt rows over the migrated schema.
 *
 * Controller-owned, and reported as a duplication rather than hidden: `@shiploop/storage`
 * owns the schema and exports no reader or writer for these four tables, so this class
 * states only the columns the migrated tables actually have. Every column it reads and
 * writes was verified present by `PRAGMA table_info` against a real migrated database, and
 * no migration was added for this slice.
 *
 * Three write rules matter:
 *
 *   - a delivery is created once per authorization, bound to that decision row, so a
 *     re-authorization after a reconciliation is a *new* row rather than a rewrite of the
 *     history of the attempt that failed (F29-AC2);
 *   - a state change is validated against the domain lifecycle table before the UPDATE, so
 *     an illegal edge is refused rather than written (F28-AC3);
 *   - a receipt insert is idempotent by construction: `release_receipts.delivery_id` is
 *     `UNIQUE`, so a second write cannot land even if two callers race, and the read-back
 *     returns whichever row exists (F29-AC4).
 */
export class SqliteDeliveryJournal implements DeliveryJournal {
  private readonly connection: StorageConnection;
  private readonly statements = new Map<string, StorageStatement>();

  constructor(connection: StorageConnection) {
    this.connection = connection;
  }

  private statement(sql: string): StorageStatement {
    const cached = this.statements.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.connection.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  private attempt<T>(description: string, body: () => Result<T, DomainError>): Result<T, DomainError> {
    try {
      return body();
    } catch (cause) {
      return err({ code: 'Unavailable', reason: `${description} failed: ${describe(cause)}` });
    }
  }

  beginDelivery(input: BeginDeliveryInput): Result<DeliveryRecord> {
    return this.attempt('begin delivery', () => {
      // The project is resolved from the candidate row rather than taken from the caller,
      // so a delivery cannot name a project its candidate does not belong to.
      const candidate = this.statement('SELECT project_id FROM candidates WHERE candidate_id = ?').get(
        input.candidate.candidateId,
      );
      if (candidate === undefined) {
        return err({ code: 'NotFound', reason: `Candidate ${input.candidate.candidateId} is not recorded.` });
      }
      const projectId = requiredText(candidate, 'project_id');
      const existing = this.statement(`SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE delivery_id = ?`).get(
        input.deliveryId,
      );
      if (existing !== undefined) return ok(this.toDelivery(existing));

      const manifest: DeliveryManifest = {
        subject: input.subject,
        repository: input.repository,
        mergeCommitSha: null,
      };
      this.statement(
        `INSERT INTO deliveries (${DELIVERY_COLUMNS})
         VALUES (?, ?, ?, ?, ?, NULL, 'Authorized', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(
        input.deliveryId,
        input.workItemId,
        projectId,
        input.candidate.candidateId,
        input.decisionId,
        input.correlationId,
        JSON.stringify(manifest),
        input.subject.pullRequestId,
        input.candidate.identity.headSha,
        input.subject.targetBranch,
        input.at,
        input.at,
      );
      for (const component of input.candidate.identity.components) {
        this.statement(
          `INSERT INTO delivery_components (${DELIVERY_COMPONENT_COLUMNS})
           VALUES (?, ?, ?, ?, ?, 'NotAuthorized', ?, ?)
             ON CONFLICT(delivery_id, component) DO NOTHING`,
        ).run(
          input.deliveryId,
          component.component,
          component.deploymentId,
          component.deploymentUrl,
          component.environment,
          input.at,
          input.at,
        );
      }
      const created = this.statement(`SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE delivery_id = ?`).get(
        input.deliveryId,
      );
      if (created === undefined) return err({ code: 'NotFound', reason: `Delivery ${input.deliveryId} was not readable after insert.` });
      return ok(this.toDelivery(created));
    });
  }

  get(deliveryId: string): Result<DeliveryRecord> {
    return this.attempt('read delivery', () => {
      const row = this.statement(`SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE delivery_id = ?`).get(deliveryId);
      if (row === undefined) return err({ code: 'NotFound', reason: `Delivery ${deliveryId} is not recorded.` });
      return ok(this.toDelivery(row));
    });
  }

  findByDecision(decisionId: DecisionId): Result<DeliveryRecord | null> {
    return this.attempt('read delivery by decision', () => {
      const row = this.statement(`SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE decision_id = ?`).get(decisionId);
      return ok(row === undefined ? null : this.toDelivery(row));
    });
  }

  findByOperation(operationId: string): Result<DeliveryRecord | null> {
    return this.attempt('read delivery by operation', () => {
      const row = this.statement(`SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE operation_id = ?`).get(operationId);
      return ok(row === undefined ? null : this.toDelivery(row));
    });
  }

  findMergedForCandidate(candidateId: CandidateId): Result<DeliveryRecord | null> {
    return this.attempt('read the merged delivery for a candidate', () => {
      const row = this.statement(
        `SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE candidate_id = ? AND state = 'Merged' ORDER BY merged_at DESC, delivery_id DESC LIMIT 1`,
      ).get(candidateId);
      return ok(row === undefined ? null : this.toDelivery(row));
    });
  }

  bindOperation(deliveryId: string, operationId: OperationId): Result<DeliveryRecord> {
    return this.attempt('bind the delivery operation', () => {
      const bound = this.statement(
        'UPDATE deliveries SET operation_id = ?, updated_at = COALESCE(updated_at, ?) WHERE delivery_id = ? AND (operation_id IS NULL OR operation_id = ?)',
      ).run(operationId, operationId, deliveryId, operationId);
      if (bound.changes === 0) {
        const existing = this.statement('SELECT operation_id FROM deliveries WHERE delivery_id = ?').get(deliveryId);
        if (existing === undefined) return err({ code: 'NotFound', reason: `Delivery ${deliveryId} is not recorded.` });
        return err({
          code: 'Conflict',
          reason: `Delivery ${deliveryId} is already bound to operation ${String(existing['operation_id'])}, so a different write cannot claim it (F28-AC4).`,
          expected: operationId,
          actual: String(existing['operation_id']),
        });
      }
      return this.get(deliveryId);
    });
  }

  /**
   * Moves the delivery, refusing an edge the domain lifecycle table does not allow.
   *
   * The `unknown_since` and `failure_detail_redacted` columns are written here rather than
   * by the caller because the schema CHECKs both against the state, so a state written
   * without them would be rejected by the database for reasons the caller cannot see.
   */
  transition(input: DeliveryTransitionInput): Result<DeliveryRecord> {
    return this.attempt('move delivery', () => {
      if (!DELIVERY_STATES.includes(input.to)) {
        return err(
          invalid(`Unknown delivery state: ${input.to}`, [
            { path: 'to', message: `Must be one of ${DELIVERY_STATES.join(', ')}.` },
          ]),
        );
      }
      const current = this.get(input.deliveryId);
      if (!current.ok) return err(current.error);
      if (!canTransition('delivery', current.value.state, input.to)) {
        return err({
          code: 'Conflict',
          reason: `A ${current.value.state} delivery cannot become ${input.to}. Reconcile it against live provider state rather than forcing the move (F28-AC4, F30-AC3).`,
          expected: current.value.state,
          actual: input.to,
        });
      }
      if (input.to === 'Failed' && (input.detail === undefined || input.detail === null)) {
        return err(
          invalid('A failed delivery must record why the provider refused it.', [
            { path: 'detail', message: 'Required when the delivery becomes Failed (F28-AC3).' },
          ]),
        );
      }
      this.statement(
        `UPDATE deliveries
            SET state = ?, updated_at = ?, unknown_since = ?, merged_at = ?, released_at = ?,
                failed_at = ?, failure_detail_redacted = ?, operation_id = COALESCE(?, operation_id)
          WHERE delivery_id = ?`,
      ).run(
        input.to,
        input.at,
        input.to === 'OutcomeUnknown' ? input.at : null,
        input.to === 'Merged' ? input.at : null,
        input.to === 'Released' ? input.at : null,
        input.to === 'Failed' ? input.at : null,
        input.detail ?? null,
        input.operationId ?? null,
        input.deliveryId,
      );
      if (input.mergeCommitSha !== undefined && input.mergeCommitSha !== null) {
        this.writeManifest(input.deliveryId, input.mergeCommitSha);
      }
      return this.get(input.deliveryId);
    });
  }

  /**
   * Records which components reached the destination.
   *
   * Updates the rows the candidate created rather than inserting new ones, because the
   * component's deployment identity and environment came from the candidate and an insert
   * here would have to invent them (F22-AC2, F28-AC3).
   */
  recordComponents(deliveryId: string, components: readonly ComponentStateInput[], at: string): Result<void> {
    return this.attempt('record delivery component states', () => {
      for (const component of components) {
        if (!DELIVERY_STATES.includes(component.state)) {
          return err(
            invalid(`Unknown delivery state: ${component.state}`, [
              { path: 'state', message: `Must be one of ${DELIVERY_STATES.join(', ')}.` },
            ]),
          );
        }
        const updated = this.statement(
          `UPDATE delivery_components
              SET state = ?, updated_at = ?,
                  deployment_id = COALESCE(?, deployment_id), deployment_url = COALESCE(?, deployment_url)
            WHERE delivery_id = ? AND component = ?`,
        ).run(
          component.state,
          at,
          component.deploymentId ?? null,
          component.deploymentUrl ?? null,
          deliveryId,
          component.component,
        );
        if (updated.changes === 0) {
          return err({
            code: 'NotFound',
            reason: `Delivery ${deliveryId} has no component ${component.component}, so its state cannot be recorded. The component did not come from this candidate.`,
          });
        }
      }
      return ok(undefined);
    });
  }

  recordSmoke(input: SmokeResultInput): Result<void> {
    return this.attempt('record live smoke result', () => {
      if (!CHECK_RESULTS.includes(input.result)) {
        return err(
          invalid(`Unknown check result: ${input.result}`, [
            { path: 'result', message: `Must be one of ${CHECK_RESULTS.join(', ')} (F28-AC2).` },
          ]),
        );
      }
      this.statement(
        `INSERT INTO live_smoke_results (${SMOKE_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(delivery_id, component, observed_at) DO NOTHING`,
      ).run(
        smokeRowId(input.deliveryId, input.component, input.observedAt),
        input.deliveryId,
        input.component,
        input.candidateFingerprint,
        input.result,
        input.artifactRef,
        input.detail,
        input.observedAt,
        input.observedAt,
      );
      return ok(undefined);
    });
  }

  listSmoke(deliveryId: string): Result<readonly SmokeRow[]> {
    return this.attempt('list live smoke results', () => {
      const rows = this.statement(
        `SELECT component, result, artifact_ref, detail_redacted, observed_at
           FROM live_smoke_results WHERE delivery_id = ? ORDER BY component ASC, observed_at ASC`,
      ).all(deliveryId);
      return ok(
        rows.map((row) => ({
          component: requiredText(row, 'component'),
          result: requiredText(row, 'result'),
          artifactRef: optionalText(row, 'artifact_ref'),
          detail: optionalText(row, 'detail_redacted'),
          observedAt: requiredText(row, 'observed_at'),
        })),
      );
    });
  }

  findReceipt(deliveryId: string): Result<ReleaseReceipt | null> {
    return this.attempt('read release receipt', () => {
      const row = this.statement(`SELECT ${RECEIPT_COLUMNS} FROM release_receipts WHERE delivery_id = ?`).get(deliveryId);
      if (row === undefined) return ok(null);
      return ok(parseJson<ReleaseReceipt>(requiredText(row, 'receipt_json'), 'receipt_json'));
    });
  }

  recordReceipt(receipt: ReleaseReceipt): Result<ReleaseReceipt> {
    return this.attempt('record release receipt', () => {
      const existing = this.findReceipt(receipt.deliveryId);
      if (!existing.ok) return err(existing.error);
      if (existing.value !== null) return ok(existing.value);
      this.statement(
        `INSERT INTO release_receipts (${RECEIPT_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(
        receipt.receiptId,
        receipt.deliveryId,
        receipt.projectId,
        receipt.workItemId,
        receipt.candidateId,
        receipt.mergeSha,
        null,
        JSON.stringify(
          receipt.components.filter((component) => component.released && component.deploymentId !== null).map((component) => component.deploymentId),
        ),
        JSON.stringify(receipt),
        receipt.createdAt,
        receipt.finalizedAt,
      );
      const written = this.findReceipt(receipt.deliveryId);
      if (!written.ok) return err(written.error);
      if (written.value === null) {
        return err({ code: 'Unavailable', reason: `Receipt ${receipt.receiptId} was not readable after insert.` });
      }
      return ok(written.value);
    });
  }

  private writeManifest(deliveryId: string, mergeCommitSha: CommitSha): void {
    const row = this.statement('SELECT manifest_json FROM deliveries WHERE delivery_id = ?').get(deliveryId);
    if (row === undefined) return;
    const manifest = parseJson<DeliveryManifest>(requiredText(row, 'manifest_json'), 'manifest_json');
    this.statement('UPDATE deliveries SET manifest_json = ? WHERE delivery_id = ?').run(
      JSON.stringify({ ...manifest, mergeCommitSha }),
      deliveryId,
    );
  }

  private toDelivery(row: SqlRow): DeliveryRecord {
    const manifest = parseJson<DeliveryManifest>(requiredText(row, 'manifest_json'), 'manifest_json');
    const deliveryId = requiredText(row, 'delivery_id');
    const operationId = optionalText(row, 'operation_id');
    return {
      deliveryId,
      workItemId: requiredText(row, 'work_item_id') as WorkItemId,
      projectId: requiredText(row, 'project_id'),
      candidateId: requiredText(row, 'candidate_id') as CandidateId,
      decisionId: requiredText(row, 'decision_id') as DecisionId,
      operationId: operationId === null ? null : (operationId as OperationId),
      state: requiredText(row, 'state'),
      correlationId: requiredText(row, 'correlation_id'),
      subject: manifest.subject,
      repository: manifest.repository,
      pullRequestId: optionalText(row, 'pull_request_id'),
      headSha: requiredText(row, 'head_sha') as CommitSha,
      targetBranch: requiredText(row, 'target_branch'),
      unknownSince: optionalText(row, 'unknown_since'),
      mergedAt: optionalText(row, 'merged_at'),
      mergeCommitSha: manifest.mergeCommitSha === null ? null : (manifest.mergeCommitSha as CommitSha),
      releasedAt: optionalText(row, 'released_at'),
      failedAt: optionalText(row, 'failed_at'),
      failureDetail: optionalText(row, 'failure_detail_redacted'),
      components: this.componentsOf(deliveryId),
      createdAt: requiredText(row, 'created_at'),
      updatedAt: requiredText(row, 'updated_at'),
    };
  }

  private componentsOf(deliveryId: string): readonly DeliveryComponentRecord[] {
    return this.statement(
      `SELECT component, deployment_id, deployment_url, environment, state
         FROM delivery_components WHERE delivery_id = ? ORDER BY component ASC`,
    )
      .all(deliveryId)
      .map((row) => ({
        component: requiredText(row, 'component'),
        deploymentId: optionalText(row, 'deployment_id'),
        deploymentUrl: optionalText(row, 'deployment_url'),
        environment: requiredText(row, 'environment'),
        state: requiredText(row, 'state'),
      }));
  }
}

/** The row identity one smoke observation owns, so a repeated read cannot duplicate it. */
function smokeRowId(deliveryId: string, component: string, observedAt: string): string {
  return `smk_${createHash('sha256').update(`${deliveryId}|${component}|${observedAt}`, 'utf8').digest('hex').slice(0, 32)}`;
}
