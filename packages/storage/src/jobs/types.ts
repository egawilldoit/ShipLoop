import {
  ATTEMPT_STATES,
  CHECK_RESULTS,
  err,
  type AttemptState,
  type CheckResult,
  type CommitSha,
  type ConflictError,
  type DomainError,
  type Fingerprint,
  type JobId,
  type OperationId,
  type ProjectId,
  type Result,
  type ScopeSnapshotId,
} from '@shiploop/domain';

/**
 * Shared contracts for the durable job queue (F13, F14, F17, F18, N01-AC3).
 *
 * Two decisions here are load bearing and are stated once so the queue and the
 * lease manager cannot drift apart.
 *
 * The connection is a narrow structural interface rather than `DatabaseSync`.
 * The queue only ever needs `exec` and `prepare`, so this package depends on the
 * capability, not on the driver, and the transaction runner stays injectable.
 * `DatabaseSync` satisfies this interface structurally, so nothing is lost.
 *
 * The transaction runner is injectable with a local default that uses
 * `BEGIN IMMEDIATE`. A deferred transaction takes its write lock at the first
 * write instead of at the start, which is how two claimers both read "slot is
 * free" and then both write. Taking the lock up front is what makes the single
 * global coding writer (F13-AC2) a property of the database rather than a
 * property of caller discipline.
 */

/** Values SQLite accepts as a bound parameter. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** A result row. Indexing yields `SqlValue | undefined` under noUncheckedIndexedAccess. */
export interface SqlRow {
  readonly [column: string]: SqlValue;
}

/** The statement surface the queue uses. Mirrors `StatementSync` without importing it. */
export interface SqlStatement {
  run(...parameters: readonly SqlValue[]): { readonly changes: number | bigint; readonly lastInsertRowid: number | bigint };
  get(...parameters: readonly SqlValue[]): SqlRow | undefined;
  all(...parameters: readonly SqlValue[]): readonly SqlRow[];
}

/** The connection surface the queue uses. `DatabaseSync` satisfies this structurally. */
export interface SqlConnection {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}

/**
 * Runs `work` as one write transaction and commits on return.
 *
 * Implementations must take the write lock before `work` reads anything it
 * depends on, otherwise the claim below is only as strong as call scheduling.
 */
export type TransactionRunner = <T>(connection: SqlConnection, work: () => T) => T;

/** An `Error` carrying the typed rejection that explains a transaction failure. */
export type TransactionConflict = Error & { readonly conflict: ConflictError };

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

function sqliteErrorCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = (error as { readonly errcode?: unknown }).errcode;
  return typeof candidate === 'number' ? candidate : null;
}

/**
 * True when the failure means another connection already holds the write lock.
 *
 * This is the expected outcome of two claimers racing, not an infrastructure
 * fault, so it is reported as a Conflict rather than Unavailable (F13-AC2).
 */
export function isWriteLockContention(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  return code === SQLITE_BUSY || code === SQLITE_LOCKED;
}

function transactionConflict(message: string, expected: string, actual: string): TransactionConflict {
  return Object.assign(new Error(message), {
    conflict: { code: 'Conflict', reason: message, expected, actual } satisfies ConflictError,
  });
}

/**
 * The default transaction runner: `BEGIN IMMEDIATE`, commit, or roll back.
 *
 * Lock contention is rethrown as a `TransactionConflict` so the queue can
 * return the typed `Conflict` its callers expect instead of leaking a driver
 * error across the public boundary.
 */
export function immediateTransaction<T>(connection: SqlConnection, work: () => T): T {
  let begun = false;
  try {
    connection.exec('BEGIN IMMEDIATE');
    begun = true;
  } catch (error) {
    if (isWriteLockContention(error)) {
      throw transactionConflict(
        'Another connection already holds the write transaction on this database, so this claim could not start.',
        'no write transaction held on this database',
        'a write transaction held by another connection',
      );
    }
    throw error;
  }

  let value: T;
  try {
    value = work();
  } catch (error) {
    try {
      connection.exec('ROLLBACK');
    } catch (rollbackFailure) {
      throw new AggregateError(
        [error, rollbackFailure],
        'The transaction failed and could not be rolled back, so this connection is no longer safe to reuse.',
      );
    }
    throw error;
  }
  if (!begun) {
    throw new Error('The transaction ended without ever being begun.');
  }
  connection.exec('COMMIT');
  return value;
}

/** The transaction runner the queue and lease manager use unless one is injected. */
export const defaultTransactionRunner: TransactionRunner = immediateTransaction;

/**
 * Runs `work` inside one transaction and converts an unexpected failure into a
 * typed `Unavailable`.
 *
 * Every public function in this slice returns a `Result`, so an unexpected
 * driver error must not escape as a thrown exception (F13-AC1: success is only
 * reported once the durable row is committed).
 */
export function guard<T>(work: () => Result<T, DomainError>): Result<T, DomainError> {
  try {
    return work();
  } catch (error) {
    if (isTransactionConflict(error)) return err(error.conflict);
    return err({
      code: 'Unavailable',
      reason: describeFailure(error),
    });
  }
}

/** A transaction failure that already knows its typed rejection. */
export function isTransactionConflict(error: unknown): error is TransactionConflict {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = (error as { readonly conflict?: unknown }).conflict;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    (candidate as { readonly code?: unknown }).code === 'Conflict'
  );
}

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'The storage operation failed without a usable error message.';
}

function corrupt(field: string): Error {
  return new Error(`Stored ${field} is not readable, so the record cannot be trusted.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(field: string, raw: string | null): unknown {
  if (raw === null) throw corrupt(field);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corrupt(field);
  }
  return parsed;
}

function requireStringArray(field: string, value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw corrupt(field);
  return value.map((entry) => {
    if (typeof entry !== 'string') throw corrupt(field);
    return entry;
  });
}

/** True when `value` is one of the domain attempt states, rather than a parallel list. */
export function isAttemptState(value: string): value is AttemptState {
  return ATTEMPT_STATES.some((candidate) => candidate === value);
}

/** True when `value` is one of the domain check results. */
export function isCheckResult(value: string): value is CheckResult {
  return CHECK_RESULTS.some((candidate) => candidate === value);
}

/** Reads a required string column, treating an unreadable row as corrupt rather than empty. */
export function readText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw corrupt(column);
  return value;
}

/** Reads a nullable string column. */
export function readOptionalText(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw corrupt(column);
  return value;
}

/** Reads a required integer column. */
export function readInteger(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw corrupt(column);
}

/** The job modes a coding job may run in (F13-AC3). */
export const JOB_MODES = ['Plan', 'Investigate', 'Build', 'Test', 'Review'] as const;
export type JobMode = (typeof JOB_MODES)[number];

/**
 * Operations a job may hold.
 *
 * The last three are privileged. A coding job may never hold them, which is why
 * `enqueue` refuses them rather than merely declining to use them (N02-AC3,
 * F03-AC5).
 */
export const JOB_OPERATIONS = [
  'ReadScope',
  'PublishIssue',
  'UpdateManagedProgress',
  'ReadRepository',
  'ReadChecks',
  'PushBranch',
  'CreateDraft',
  'UpdateDraft',
  'RunChecks',
  'CollectEvidence',
  'Merge',
  'Release',
  'RecoveryRedeploy',
] as const;
export type JobOperation = (typeof JOB_OPERATIONS)[number];

/** Operations only an owner-authorized delivery executor may ever hold. */
export const PRIVILEGED_JOB_OPERATIONS: readonly JobOperation[] = ['Merge', 'Release', 'RecoveryRedeploy'];

export function isJobOperation(value: string): value is JobOperation {
  return JOB_OPERATIONS.some((candidate) => candidate === value);
}

/**
 * Capabilities each mode declares.
 *
 * No mode lists a privileged operation, and no mode derives one: merge and
 * release authority is an owner decision with its own recorded authorization,
 * never a consequence of asking for a Build (F13-AC3, F26-AC2).
 */
export const MODE_PERMITTED_OPERATIONS: Readonly<Record<JobMode, readonly JobOperation[]>> = {
  Plan: ['ReadScope', 'ReadRepository', 'PublishIssue', 'UpdateManagedProgress', 'CreateDraft', 'UpdateDraft'],
  Investigate: ['ReadScope', 'ReadRepository', 'ReadChecks'],
  Build: ['ReadScope', 'ReadRepository', 'ReadChecks', 'PushBranch', 'CreateDraft', 'UpdateDraft', 'RunChecks', 'CollectEvidence'],
  Test: ['ReadScope', 'ReadRepository', 'ReadChecks', 'RunChecks', 'CollectEvidence'],
  Review: ['ReadScope', 'ReadRepository', 'ReadChecks', 'CollectEvidence'],
};

/** Bounded work limits recorded with the job (F13-AC1, F18-AC2). */
export interface JobLimits {
  readonly activeExecutionMs: number;
  readonly maxAutomatedFixPasses: number;
  readonly maxToolRetries: number;
  readonly maxAttempts: number;
}

/**
 * v0.1 default limits (mvp-spec 7, F18-AC2).
 *
 * Sixty minutes of active execution and two automated fix passes. Owner waiting
 * time is deliberately absent: a required owner answer must not consume active
 * execution budget (F18-AC3).
 */
export const DEFAULT_JOB_LIMITS: JobLimits = {
  activeExecutionMs: 60 * 60 * 1000,
  maxAutomatedFixPasses: 2,
  maxToolRetries: 3,
  maxAttempts: 2,
};

/** A durable job row as stored. */
export interface JobRecord {
  readonly jobId: JobId;
  readonly operationId: OperationId;
  readonly mode: JobMode;
  readonly scopeSnapshotId: ScopeSnapshotId;
  readonly projectId: ProjectId;
  readonly state: AttemptState;
  readonly limits: JobLimits;
  readonly permittedOperations: readonly JobOperation[];
  readonly holder: string | null;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The request that starts work (F13-AC1). */
export interface EnqueueRequest {
  readonly operationId: OperationId;
  readonly mode: JobMode;
  readonly scopeSnapshotId: ScopeSnapshotId;
  readonly projectId: ProjectId;
  readonly jobId: JobId;
  readonly now: string;
  readonly limits: JobLimits | null;
  readonly permittedOperations: readonly JobOperation[] | null;
}

/** A claimed job together with the writer identity it was claimed for. */
export interface ClaimedJob {
  readonly job: JobRecord;
  readonly lease: WriterLease;
  readonly slot: CodingSlot;
}

/** Who is asking to claim, and when. */
export interface ClaimCandidate {
  readonly holder: string;
  readonly now: string;
  readonly leaseTtlMs: number;
  readonly projectId: ProjectId | null;
}

/** The single global coding writer. Exactly one row, id 1. */
export interface CodingSlot {
  readonly jobId: JobId | null;
  readonly holder: string | null;
  readonly operationId: OperationId | null;
  readonly acquiredAt: string | null;
  readonly expiresAt: string | null;
  readonly generation: number;
}

export const LEASE_STATES = ['Active', 'Released', 'ReconciliationRequired', 'HolderStoppedConfirmed'] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

/** Writer ownership for one job (F17-AC5). */
export interface WriterLease {
  readonly leaseId: string;
  readonly jobId: JobId;
  readonly holder: string;
  readonly operationId: OperationId;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  readonly state: LeaseState;
  readonly reconciliationRequired: boolean;
  readonly reconciliationReason: string | null;
  readonly confirmedStoppedBy: string | null;
  readonly confirmedStoppedAt: string | null;
  readonly confirmedStoppedEvidence: string | null;
}

/** The result of a request to take over a job whose writer ownership is unclear. */
export type ReclaimOutcome =
  | {
      readonly granted: true;
      readonly lease: WriterLease;
      readonly slot: CodingSlot;
      /** The lease that was replaced, when there was one to replace. */
      readonly previousHolder: string | null;
    }
  | {
      readonly granted: false;
      /** True when the previous holder's process must be established as stopped first. */
      readonly reconciliationRequired: boolean;
      readonly reason: string;
      readonly lease: WriterLease | null;
      readonly slot: CodingSlot;
    };

/** One check result captured at checkpoint time. */
export interface CheckpointResult {
  readonly name: string;
  readonly result: CheckResult;
  readonly detail: string | null;
}

/** Owner or agent feedback retained with the checkpoint (F17-AC2). */
export interface FeedbackNote {
  readonly author: string;
  readonly at: string;
  readonly body: string;
}

/** Isolated workspace identity for one job (F14-AC1). */
export interface WorkspaceIdentity {
  readonly workspaceId: string;
  readonly branchName: string;
  readonly worktreePath: string;
}

/**
 * Everything needed to resume work without re-deriving it (F17-AC2).
 *
 * Head and base are stored as full commit SHAs. Resume compares the actual
 * workspace against them, and an abbreviated SHA cannot be compared against a
 * real checkout, so an abbreviation here would make the comparison meaningless.
 */
export interface JobCheckpoint {
  readonly jobId: JobId;
  readonly checkpointId: string;
  readonly scopeSnapshotId: ScopeSnapshotId;
  readonly scopeFingerprint: Fingerprint;
  readonly profileVersionId: string;
  readonly procedureVersionId: string;
  readonly engineVersion: string | null;
  readonly workspace: WorkspaceIdentity;
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  readonly dirtyFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly results: readonly CheckpointResult[];
  readonly feedback: readonly FeedbackNote[];
  readonly blocker: string | null;
  readonly nextAction: string;
  readonly recordedAt: string;
}

export function encodeLimits(limits: JobLimits): string {
  return JSON.stringify(limits);
}

export function decodeLimits(raw: string | null): JobLimits {
  const parsed = parseJson('limits', raw);
  if (!isRecord(parsed)) throw corrupt('limits');
  const fields = ['activeExecutionMs', 'maxAutomatedFixPasses', 'maxToolRetries', 'maxAttempts'] as const;
  const decoded: Record<string, number> = {};
  for (const field of fields) {
    const value = parsed[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw corrupt(`limits.${field}`);
    decoded[field] = value;
  }
  return {
    activeExecutionMs: decoded['activeExecutionMs'] ?? 0,
    maxAutomatedFixPasses: decoded['maxAutomatedFixPasses'] ?? 0,
    maxToolRetries: decoded['maxToolRetries'] ?? 0,
    maxAttempts: decoded['maxAttempts'] ?? 0,
  };
}

export function encodeOperations(operations: readonly JobOperation[]): string {
  return JSON.stringify([...operations]);
}

export function decodeOperations(raw: string | null): readonly JobOperation[] {
  return requireStringArray('permitted_operations', parseJson('permitted_operations', raw)).filter((entry): entry is JobOperation =>
    isJobOperation(entry),
  );
}

export function encodeFileList(files: readonly string[]): string {
  return JSON.stringify([...files]);
}

export function decodeFileList(raw: string | null, field: string): readonly string[] {
  return requireStringArray(field, parseJson(field, raw));
}

export function encodeResults(results: readonly CheckpointResult[]): string {
  return JSON.stringify(results.map((entry) => ({ name: entry.name, result: entry.result, detail: entry.detail })));
}

export function decodeResults(raw: string | null): readonly CheckpointResult[] {
  const parsed = parseJson('results', raw);
  if (!Array.isArray(parsed)) throw corrupt('results');
  return parsed.map((entry) => {
    if (!isRecord(entry)) throw corrupt('results');
    const name = entry['name'];
    const result = entry['result'];
    const detail = entry['detail'];
    if (typeof name !== 'string') throw corrupt('results.name');
    if (typeof result !== 'string' || !isCheckResult(result)) throw corrupt('results.result');
    if (detail !== null && typeof detail !== 'string') throw corrupt('results.detail');
    return { name, result, detail: detail === null ? null : detail };
  });
}

export function encodeFeedback(feedback: readonly FeedbackNote[]): string {
  return JSON.stringify(feedback.map((entry) => ({ author: entry.author, at: entry.at, body: entry.body })));
}

export function decodeFeedback(raw: string | null): readonly FeedbackNote[] {
  const parsed = parseJson('feedback', raw);
  if (!Array.isArray(parsed)) throw corrupt('feedback');
  return parsed.map((entry) => {
    if (!isRecord(entry)) throw corrupt('feedback');
    const author = entry['author'];
    const at = entry['at'];
    const body = entry['body'];
    if (typeof author !== 'string' || typeof at !== 'string' || typeof body !== 'string') throw corrupt('feedback');
    return { author, at, body };
  });
}