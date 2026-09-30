/**
 * Persistence contracts for the storage core repositories.
 *
 * `packages/storage` owns the SQLite schema and atomic operations but never a
 * remote side effect: nothing here performs a provider call, because a
 * transaction that waits on a network would hold the single global writer and
 * make a lost response indistinguishable from a lost write (ARCHITECTURE,
 * "Authority and durable state" and "Execution and recovery").
 *
 * Two shapes live in this file. Row records are the camelCase projections the
 * rest of the system reads; repository ports are the only surface callers may
 * depend on, so replacing SQL never reaches a controller. Database columns stay
 * snake_case and never escape this package.
 */

import type {
  AttentionItem,
  AttentionItemId,
  AttentionKind,
  AttemptId,
  AuthorizationSubject,
  CandidateId,
  CandidateIdentity,
  CapabilityDeclaration,
  CapabilityKind,
  CheckResult,
  ConnectorId,
  DecisionId,
  EvidenceId,
  Fingerprint,
  IdeaId,
  OwnerId,
  ProcedureVersionId,
  ProfileVersionId,
  ProjectId,
  Result,
  ScopeSnapshot,
  ScopeSnapshotId,
  WorkItemId,
} from '@shiploop/domain';

/**
 * The structural database surface the repositories use.
 *
 * Declared here rather than imported so the repositories stay usable against a
 * bare `node:sqlite` `DatabaseSync` and so `db.ts` owns connection policy
 * (WAL, foreign keys, busy timeout) without the repositories depending on it.
 * `DatabaseSync` satisfies this interface structurally, which is why the test
 * suite can open a real file database without any extra adapter.
 */
export interface StorageConnection {
  prepare(sql: string): StorageStatement;
  exec(sql: string): void;
}

/** Parameter kinds the repositories ever bind. Blobs are deliberately excluded. */
export type SqlParameter = null | number | bigint | string;

/** A result row. Column values are narrowed by the readers in `core.ts`. */
export type SqlRow = Record<string, unknown>;

/** The write outcome of a prepared statement. */
export interface StorageStatementChanges {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

/** The prepared-statement surface. Every repository call goes through this. */
export interface StorageStatement {
  run(...parameters: SqlParameter[]): StorageStatementChanges;
  get(...parameters: SqlParameter[]): SqlRow | undefined;
  all(...parameters: SqlParameter[]): SqlRow[];
}

/**
 * Bounded transaction semantics.
 *
 * Injected rather than defined here so `tx.ts` remains the single owner of
 * BEGIN/COMMIT policy, nesting and busy handling. A multi-statement repository
 * method must be wrapped in this; a single-statement method runs in autocommit.
 */
export interface StorageTransactions {
  transaction<T>(body: () => T): T;
}

/** Provisioned owner identity (F01-AC1, F01-AC2). */
export interface OwnerRecord {
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly createdAt: string;
}

/**
 * A signed-in session.
 *
 * Only the hash of the session token is persisted, so a database copy cannot
 * be replayed as a live session (F01-AC2). `rotatedFromSessionId` preserves the
 * chain so a rotation can be audited rather than looking like two unrelated
 * sessions (F32-AC1).
 */
export interface OwnerSession {
  readonly sessionId: string;
  readonly ownerId: OwnerId;
  readonly tokenHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly rotatedFromSessionId: string | null;
}

export interface CreateSessionInput {
  readonly ownerId: OwnerId;
  readonly token: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface RotateSessionInput extends CreateSessionInput {
  readonly newToken: string;
}

/** One immutable project profile version (F02-AC3). */
export interface ProjectProfileVersion {
  readonly profileVersionId: ProfileVersionId;
  readonly projectId: ProjectId;
  readonly versionNumber: number;
  readonly supersedesVersionId: ProfileVersionId | null;
  readonly content: ProjectProfileContent;
  readonly contentFingerprint: Fingerprint;
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface ProfileProviderReferences {
  readonly repository: string;
  readonly ticketProvider: string;
  readonly ticketTeamKey: string | null;
  readonly baseBranch: string;
  readonly targetBranch: string;
  readonly deploymentProvider: string;
  readonly engine: string;
  readonly previewComponents: readonly PreviewComponentReference[];
}

export interface PreviewComponentReference {
  readonly component: string;
  readonly environment: string;
}

/**
 * Profile policy. `capabilityVersion` is stored so a run can tell whether the
 * connector capabilities it relied on were checked against the same revision
 * (F02-AC4, F20-AC5).
 */
export interface ProfilePolicy {
  readonly requiredChecks: readonly string[];
  readonly deliveryBehavior: 'ManualAuthorizationOnly';
  readonly maxFixPasses: number;
  readonly workspaceIsolation: 'WorktreeAndDataDirectory';
  readonly capabilityVersion: number;
}

export interface ProfileEnvironmentReference {
  readonly runtime: string;
  readonly ports: readonly number[];
  readonly secretReferences: readonly string[];
}

export interface ProjectProfileContent {
  readonly references: ProfileProviderReferences;
  readonly policy: ProfilePolicy;
  readonly recipe: string;
  readonly environment: ProfileEnvironmentReference;
}

export interface SaveProfileVersionInput {
  readonly projectId: ProjectId;
  readonly content: ProjectProfileContent;
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  /** Compare-and-set on the newest version, so a stale editor cannot clobber (F02-AC2). */
  readonly expectedVersionNumber: number | null;
}

export type ConnectorKind = 'Ticket' | 'Git' | 'Deployment' | 'Engine';

export type ConnectorState = 'Unconfigured' | 'Healthy' | 'Degraded' | 'Revoked' | 'Unreachable';

/**
 * A configured connector.
 *
 * `credentialReference` is a pointer into the credential store, never a secret
 * value. `credentialReferenceDigest` exists so an export can prove which
 * reference a record used without carrying the reference itself (F03-AC3,
 * F32-AC2).
 */
export interface ConnectorRecord {
  readonly connectorId: ConnectorId;
  readonly projectId: ProjectId;
  readonly provider: string;
  readonly kind: ConnectorKind;
  readonly resourceScope: string;
  readonly credentialReference: string;
  readonly credentialReferenceDigest: string;
  readonly declarations: readonly CapabilityDeclaration[];
  readonly state: ConnectorState;
  readonly error: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertConnectorInput {
  readonly projectId: ProjectId;
  readonly provider: string;
  readonly kind: ConnectorKind;
  readonly resourceScope: string;
  readonly credentialReference: string;
  readonly declarations: readonly CapabilityDeclaration[];
  readonly state: ConnectorState;
  readonly error: string | null;
  readonly at: string;
}

export interface ConnectorCheckResult {
  readonly checkedAt: string;
  readonly succeeded: boolean;
  readonly state: ConnectorState;
  readonly error: string | null;
  readonly declarations: readonly CapabilityDeclaration[] | null;
}

/**
 * A project fact or procedure at one version (F05-AC1).
 *
 * `status` is what keeps a proposal from changing what future runs read: a
 * `Proposed` row is visible to the owner but is never returned by
 * `currentVersion`, so a proposed improvement needs an explicit save action
 * before it can influence a run (F05-AC4).
 */
export type ProcedureStatus = 'Proposed' | 'Accepted' | 'Superseded' | 'Retired';

export type ProcedureKind = 'ProjectFact' | 'Procedure' | 'Decision';

export interface ProcedureVersion {
  readonly procedureVersionId: ProcedureVersionId;
  readonly projectId: ProjectId;
  /** Stable key for the fact or procedure being versioned, e.g. "deploy.web". */
  readonly subjectKey: string;
  readonly versionNumber: number;
  readonly kind: ProcedureKind;
  readonly scope: string;
  readonly source: string;
  readonly sourceRevision: string | null;
  readonly content: string;
  readonly contentFingerprint: Fingerprint;
  readonly status: ProcedureStatus;
  readonly lastVerifiedRevision: string | null;
  readonly lastVerifiedAt: string | null;
  /** When the owner promoted this version; null while the row is only a proposal. */
  readonly acceptedAt: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly note: string | null;
}

export interface AppendProcedureVersionInput {
  readonly projectId: ProjectId;
  readonly subjectKey: string;
  readonly kind: ProcedureKind;
  readonly scope: string;
  readonly source: string;
  readonly sourceRevision: string | null;
  readonly content: string;
  readonly status: ProcedureStatus;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly note: string | null;
  readonly expectedVersionNumber: number | null;
}

export type IdeaKind = 'FeatureRequest' | 'Bug';

export type IdeaState = 'Captured' | 'Clarifying' | 'Agreed' | 'Published' | 'Archived';

/**
 * Raw intake.
 *
 * `rawRequest` is what the owner typed and no repository method can change it.
 * Generated material lives in separate columns so a summary can never be
 * mistaken for, or silently overwrite, the original request (F06-AC1).
 */
export interface IdeaRecord {
  readonly ideaId: IdeaId;
  readonly projectId: ProjectId | null;
  readonly kind: IdeaKind;
  readonly rawRequest: string;
  readonly notes: string | null;
  readonly bugExpected: string | null;
  readonly bugActual: string | null;
  readonly bugReproduction: string | null;
  readonly generatedSummary: string | null;
  readonly agreedBrief: string | null;
  readonly openQuestions: readonly string[];
  readonly state: IdeaState;
  readonly publishedWorkItemId: WorkItemId | null;
  readonly archivedAt: string | null;
  readonly archivedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * An attachment referenced by a row.
 *
 * The bytes live in the artifact store under `relativePath`; the row carries
 * only the name, size and digest, so attachments are named files rather than a
 * second authoritative state store (ARCHITECTURE, "Authority and durable state").
 */
export interface IdeaAttachment {
  readonly attachmentId: string;
  readonly ideaId: IdeaId;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentDigest: string;
  readonly relativePath: string;
  readonly createdAt: string;
}

export interface CaptureIdeaInput {
  readonly projectId: ProjectId | null;
  readonly kind: IdeaKind;
  readonly rawRequest: string;
  readonly notes: string | null;
  readonly bugExpected: string | null;
  readonly bugActual: string | null;
  readonly bugReproduction: string | null;
  readonly capturedAt: string;
}

export interface AddAttachmentInput {
  readonly ideaId: IdeaId;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentDigest: string;
  readonly relativePath: string;
  readonly createdAt: string;
}

export type WorkItemSource = 'CapturedIdea' | 'AdoptedIssue' | 'ProposedNewIssue';

/**
 * Publication intent is separate from publication state.
 *
 * Recording that the owner *wants* the work published is a decision; recording
 * that the provider confirmed it is an observation. Collapsing them would make
 * "we meant to publish" look like "the ticket exists" (F10, F12-AC5).
 */
export type PublicationIntent = 'DoNotPublish' | 'PublishWhenAgreed' | 'Published';

export type PublicationState =
  | 'Unpublished'
  | 'Publishing'
  | 'Published'
  | 'OutcomeUnknown'
  | 'NotPublishing';

/** Verified identity of existing code adopted instead of generated (F11-AC2). */
export interface AdoptionReference {
  readonly repository: string;
  readonly headSha: string;
  readonly targetBranch: string;
  readonly pullRequestId: string | null;
}

export interface WorkItemRecord {
  readonly workItemId: WorkItemId;
  readonly projectId: ProjectId;
  readonly profileVersionId: ProfileVersionId;
  readonly source: WorkItemSource;
  readonly title: string;
  readonly externalIssueId: string | null;
  readonly externalIssueIdentifier: string | null;
  readonly externalIssueUrl: string | null;
  readonly publicationIntent: PublicationIntent;
  readonly publicationState: PublicationState;
  readonly publicationOperationId: string | null;
  readonly relatedWorkItemIds: readonly string[];
  readonly adoption: AdoptionReference | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWorkItemInput {
  readonly projectId: ProjectId;
  readonly profileVersionId: ProfileVersionId;
  readonly source: WorkItemSource;
  readonly title: string;
  readonly externalIssueId: string | null;
  readonly externalIssueIdentifier: string | null;
  readonly externalIssueUrl: string | null;
  readonly publicationIntent: PublicationIntent;
  readonly relatedWorkItemIds: readonly string[];
  readonly adoption: AdoptionReference | null;
  readonly at: string;
}

/**
 * Progress published to the external issue.
 *
 * A failed update is a labelled pending state with the last success time, not a
 * silent retry and not a lost local run (F16-AC4).
 */
export type ExternalSyncState = 'NeverAttempted' | 'InSync' | 'PendingSync' | 'Failed';

export interface WorkItemSync {
  readonly workItemId: WorkItemId;
  readonly state: ExternalSyncState;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly attemptCount: number;
  readonly lastError: string | null;
}

export interface RecordSyncResultInput {
  readonly workItemId: WorkItemId;
  readonly attemptedAt: string;
  readonly succeeded: boolean;
  readonly error: string | null;
}

/**
 * One captured scope snapshot.
 *
 * Append-only. `scopeFingerprint` is computed by the domain from the material
 * content so cosmetic edits cannot change it, and it is stored rather than
 * recomputed later so history keeps the belief ShipLoop actually held
 * (F12-AC1, F12-AC3).
 *
 * The schema this repository requires includes triggers that abort UPDATE and
 * DELETE on this table. `migrations.ts` must install them, otherwise
 * append-only is a convention rather than an enforced invariant.
 */
export interface ScopeSnapshotRecord {
  readonly scopeSnapshotId: ScopeSnapshotId;
  readonly workItemId: WorkItemId;
  readonly sequenceNumber: number;
  readonly attemptId: AttemptId | null;
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly description: string;
  readonly providerRevision: string | null;
  readonly priority: string | null;
  readonly dependencyIssueIds: readonly string[];
  readonly acceptanceCriteria: readonly ScopeSnapshotCriterion[];
  readonly retrievedAt: string;
  readonly scopeFingerprint: Fingerprint;
  readonly profileVersionId: ProfileVersionId;
  readonly procedureVersionId: string;
  readonly capturedAt: string;
  readonly correlationId: string | null;
}

export interface ScopeSnapshotCriterion {
  readonly id: string;
  readonly text: string;
}

export interface AppendScopeSnapshotInput {
  readonly scope: ScopeSnapshot;
  readonly attemptId: AttemptId | null;
  readonly profileVersionId: ProfileVersionId;
  readonly procedureVersionId: string;
  readonly capturedAt: string;
  readonly correlationId: string | null;
}

/**
 * One actionable situation needing the owner (F31).
 *
 * Extends the domain projection with storage-only bookkeeping so a repeated
 * event can be counted without changing what the dashboard reads.
 */
export interface AttentionItemRecord extends AttentionItem {
  readonly attentionItemId: AttentionItemId;
  readonly occurrenceCount: number;
  readonly firstObservedAt: string;
}

export interface UpsertAttentionItemInput {
  readonly dedupKey: string;
  readonly kind: AttentionKind;
  readonly projectId: ProjectId;
  readonly workItemId: WorkItemId | null;
  readonly issueIdentifier: string | null;
  readonly title: string;
  readonly blocker: string | null;
  readonly nextAction: string;
  readonly candidateFingerprint: Fingerprint | null;
  readonly observedAt: string;
  /** Set when the underlying blocker is genuinely gone, not merely unobserved. */
  readonly resolved: boolean;
}

/** A candidate: the code and artifacts proposed for testing or delivery. */
export interface CandidateRecord {
  readonly candidateId: CandidateId;
  readonly attemptId: AttemptId | null;
  readonly workItemId: WorkItemId;
  readonly candidateFingerprint: Fingerprint;
  readonly identity: CandidateIdentity;
  readonly pullRequestId: string | null;
  readonly targetBranch: string;
  readonly recordedAt: string;
  readonly correlationId: string | null;
}

export interface RecordCandidateInput {
  readonly attemptId: AttemptId | null;
  readonly workItemId: WorkItemId;
  readonly identity: CandidateIdentity;
  readonly pullRequestId: string | null;
  readonly targetBranch: string;
  readonly recordedAt: string;
  readonly correlationId: string | null;
}

/**
 * Evidence bound to one candidate fingerprint.
 *
 * The binding is the whole point: because every read filters on
 * `candidateFingerprint`, a changed candidate cannot inherit the previous
 * build's results even when the pull request number is unchanged
 * (F20-AC3, F25-AC3).
 */
export type EvidenceKind = 'CheckResult' | 'BrowserEvidence' | 'ApiEvidence' | 'LiveSmoke';

export interface EvidenceRecord {
  readonly evidenceId: EvidenceId;
  readonly candidateId: CandidateId;
  readonly candidateFingerprint: Fingerprint;
  readonly kind: EvidenceKind;
  readonly criterionId: string | null;
  readonly checkId: string | null;
  readonly checkName: string;
  readonly result: CheckResult;
  readonly observedAt: string | null;
  readonly environmentFingerprint: Fingerprint | null;
  readonly scopeFingerprint: Fingerprint | null;
  readonly artifactRef: string | null;
  readonly detail: string | null;
  readonly recordedAt: string;
  readonly correlationId: string | null;
}

export interface RecordEvidenceInput {
  readonly candidateFingerprint: Fingerprint;
  readonly kind: EvidenceKind;
  readonly criterionId: string | null;
  readonly checkId: string | null;
  readonly checkName: string;
  readonly result: CheckResult;
  readonly observedAt: string | null;
  readonly environmentFingerprint: Fingerprint | null;
  readonly scopeFingerprint: Fingerprint | null;
  readonly artifactRef: string | null;
  readonly detail: string | null;
  readonly recordedAt: string;
  readonly correlationId: string | null;
}

export type OwnerDecisionType =
  | 'Accepted'
  | 'ChangesRequested'
  | 'AuthorizedMerge'
  | 'AuthorizedRelease'
  | 'AuthorizedRecoveryRedeploy';

export type OwnerDecisionState = 'Recorded' | 'Consumed' | 'Invalidated';

/**
 * An owner decision.
 *
 * Acceptance and authorization are separate rows because they are separate
 * permissions: acceptance says the behaviour is right, authorization says
 * perform this exact action against this exact identity. `subjectFingerprint`
 * binds an authorization to its action, destination and candidate so an
 * unconsumed approval cannot authorize a different release (F26-AC1, F27-AC3).
 */
export interface OwnerDecisionRecord {
  readonly decisionId: DecisionId;
  readonly workItemId: WorkItemId | null;
  readonly candidateFingerprint: Fingerprint;
  readonly scopeFingerprint: Fingerprint;
  readonly actor: string;
  readonly decisionType: OwnerDecisionType;
  readonly subject: AuthorizationSubject | null;
  readonly subjectFingerprint: Fingerprint | null;
  readonly note: string | null;
  readonly state: OwnerDecisionState;
  readonly consumedAt: string | null;
  readonly invalidatedAt: string | null;
  readonly invalidatedReason: string | null;
  readonly createdAt: string;
  readonly correlationId: string | null;
}

export interface RecordAcceptanceInput {
  readonly workItemId: WorkItemId;
  readonly candidateFingerprint: Fingerprint;
  readonly scopeFingerprint: Fingerprint;
  readonly actor: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly correlationId: string | null;
}

export interface RecordChangesRequestedInput {
  readonly workItemId: WorkItemId;
  readonly candidateFingerprint: Fingerprint;
  readonly scopeFingerprint: Fingerprint;
  readonly actor: string;
  readonly feedback: string;
  readonly createdAt: string;
  readonly correlationId: string | null;
}

export interface RecordAuthorizationInput extends RecordAcceptanceInput {
  readonly decisionType: 'AuthorizedMerge' | 'AuthorizedRelease' | 'AuthorizedRecoveryRedeploy';
  readonly subject: AuthorizationSubject;
}

/**
 * Repository ports.
 *
 * Controllers depend on these, never on the SQL classes, so the storage
 * implementation can be rewritten without touching a caller. Every method
 * returns a typed result: expected refusals such as NotFound or Conflict are
 * values, not thrown exceptions, because each one carries a different next step
 * for the owner.
 */
export interface OwnerStore {
  provision(ownerId: OwnerId, displayName: string, createdAt: string): Result<OwnerRecord>;
  current(): Result<OwnerRecord | null>;
  createSession(input: CreateSessionInput): Result<OwnerSession>;
  authenticate(token: string, now: string): Result<OwnerSession>;
  rotateSession(input: RotateSessionInput): Result<OwnerSession>;
  revokeSession(token: string, revokedAt: string): Result<OwnerSession>;
  revokeAllSessions(ownerId: OwnerId, revokedAt: string): Result<number>;
}

export interface ProjectProfileStore {
  saveVersion(input: SaveProfileVersionInput): Result<ProjectProfileVersion>;
  getVersion(profileVersionId: ProfileVersionId): Result<ProjectProfileVersion>;
  currentVersion(projectId: ProjectId): Result<ProjectProfileVersion | null>;
  listVersions(projectId: ProjectId): Result<readonly ProjectProfileVersion[]>;
  listVersionsSince(projectId: ProjectId, versionNumber: number): Result<readonly ProjectProfileVersion[]>;
}

export interface ConnectorStore {
  upsert(input: UpsertConnectorInput): Result<ConnectorRecord>;
  get(connectorId: ConnectorId): Result<ConnectorRecord>;
  findByKind(projectId: ProjectId, kind: ConnectorKind): Result<ConnectorRecord | null>;
  listForProject(projectId: ProjectId): Result<readonly ConnectorRecord[]>;
  recordCheck(connectorId: ConnectorId, result: ConnectorCheckResult): Result<ConnectorRecord>;
  revoke(connectorId: ConnectorId, revokedAt: string, reason: string): Result<ConnectorRecord>;
  capabilitySummary(connectorId: ConnectorId): Result<CapabilitySummary>;
}

export interface ProcedureStore {
  appendVersion(input: AppendProcedureVersionInput): Result<ProcedureVersion>;
  acceptVersion(procedureVersionId: ProcedureVersionId, acceptedAt: string): Result<ProcedureVersion>;
  getVersion(procedureVersionId: ProcedureVersionId): Result<ProcedureVersion>;
  currentVersion(projectId: ProjectId, subjectKey: string): Result<ProcedureVersion | null>;
  listVersions(projectId: ProjectId, subjectKey: string): Result<readonly ProcedureVersion[]>;
  listProposed(projectId: ProjectId): Result<readonly ProcedureVersion[]>;
  recordVerification(
    procedureVersionId: ProcedureVersionId,
    revision: string,
    verifiedAt: string,
  ): Result<ProcedureVersion>;
}

export interface IdeaStore {
  capture(input: CaptureIdeaInput): Result<IdeaRecord>;
  get(ideaId: IdeaId): Result<IdeaRecord>;
  list(filter: { readonly projectId: ProjectId | null; readonly state: IdeaState | null }): Result<
    readonly IdeaRecord[]
  >;
  recordSummary(ideaId: IdeaId, summary: string, at: string): Result<IdeaRecord>;
  recordAgreedBrief(
    ideaId: IdeaId,
    brief: string,
    openQuestions: readonly string[],
    at: string,
  ): Result<IdeaRecord>;
  addAttachment(input: AddAttachmentInput): Result<IdeaAttachment>;
  listAttachments(ideaId: IdeaId): Result<readonly IdeaAttachment[]>;
  markPublished(ideaId: IdeaId, workItemId: WorkItemId, at: string): Result<IdeaRecord>;
  archive(ideaId: IdeaId, reason: string, at: string): Result<IdeaRecord>;
}

export interface WorkItemStore {
  create(input: CreateWorkItemInput): Result<WorkItemRecord>;
  get(workItemId: WorkItemId): Result<WorkItemRecord>;
  findByExternalIssueId(externalIssueId: string): Result<WorkItemRecord | null>;
  listForProject(projectId: ProjectId): Result<readonly WorkItemRecord[]>;
  recordPublication(
    workItemId: WorkItemId,
    state: PublicationState,
    operationId: string | null,
    at: string,
  ): Result<WorkItemRecord>;
  recordSyncResult(input: RecordSyncResultInput): Result<WorkItemSync>;
  getSync(workItemId: WorkItemId): Result<WorkItemSync | null>;
  appendScopeSnapshot(input: AppendScopeSnapshotInput): Result<ScopeSnapshotRecord>;
  getScopeSnapshot(scopeSnapshotId: ScopeSnapshotId): Result<ScopeSnapshotRecord>;
  latestScopeSnapshot(workItemId: WorkItemId): Result<ScopeSnapshotRecord | null>;
  listScopeSnapshots(workItemId: WorkItemId): Result<readonly ScopeSnapshotRecord[]>;
}

export interface AttentionItemStore {
  upsert(input: UpsertAttentionItemInput): Result<AttentionItemRecord>;
  acknowledge(attentionItemId: AttentionItemId, actor: string, at: string): Result<AttentionItemRecord>;
  resolve(attentionItemId: AttentionItemId, at: string): Result<AttentionItemRecord>;
  get(attentionItemId: AttentionItemId): Result<AttentionItemRecord>;
  list(state: AttentionItem['state'] | null): Result<readonly AttentionItemRecord[]>;
}

export interface CandidateStore {
  record(input: RecordCandidateInput): Result<CandidateRecord>;
  get(candidateId: CandidateId): Result<CandidateRecord>;
  findByFingerprint(candidateFingerprint: Fingerprint): Result<CandidateRecord | null>;
  listForWorkItem(workItemId: WorkItemId): Result<readonly CandidateRecord[]>;
}

export interface EvidenceStore {
  record(input: RecordEvidenceInput): Result<EvidenceRecord>;
  get(evidenceId: EvidenceId): Result<EvidenceRecord>;
  listForCandidate(candidateFingerprint: Fingerprint): Result<readonly EvidenceRecord[]>;
  listForCriterion(candidateFingerprint: Fingerprint, criterionId: string): Result<readonly EvidenceRecord[]>;
}

export interface OwnerDecisionStore {
  recordAcceptance(input: RecordAcceptanceInput): Result<OwnerDecisionRecord>;
  recordChangesRequested(input: RecordChangesRequestedInput): Result<OwnerDecisionRecord>;
  authorize(input: RecordAuthorizationInput): Result<OwnerDecisionRecord>;
  consume(decisionId: DecisionId, consumedAt: string): Result<OwnerDecisionRecord>;
  invalidate(decisionId: DecisionId, reason: string, at: string): Result<OwnerDecisionRecord>;
  get(decisionId: DecisionId): Result<OwnerDecisionRecord>;
  listForWorkItem(workItemId: WorkItemId): Result<readonly OwnerDecisionRecord[]>;
  listUnconsumed(candidateFingerprint: Fingerprint): Result<readonly OwnerDecisionRecord[]>;
}

/** The split of an adapter's declared capabilities, as the owner sees it (F03-AC2). */
export interface CapabilitySummary {
  readonly reads: readonly CapabilityKind[];
  readonly writes: readonly CapabilityKind[];
  readonly unsupported: readonly { readonly kind: CapabilityKind; readonly limitation: string }[];
}