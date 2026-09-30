import {
  assertTransition,
  blocked,
  conflict,
  err,
  invalid,
  ok,
  type AttemptState,
  type DomainError,
  type JobId,
  type OperationId,
  type Result,
} from '@shiploop/domain';
import {
  defaultTransactionRunner,
  guard,
  readInteger,
  readOptionalText,
  readText,
  type LeaseState,
  type ReclaimOutcome,
  type SqlConnection,
  type SqlRow,
  type TransactionRunner,
  type WriterLease,
} from './types.ts';

/**
 * Writer ownership for the single global coding writer (F14-AC1, F14-AC3, F17-AC5, N01-AC1).
 *
 * The rule this file exists to enforce is that a missing heartbeat is not
 * evidence of a missing process. SQLite can prove that a lease expired; it
 * cannot prove the holder stopped, because a stopped process and a wedged or
 * partitioned one look identical from the database. So an expired lease moves
 * to `ReconciliationRequired` and grants nothing, and the only way forward is an
 * explicit `confirmHolderStopped` recording who confirmed what and when. A
 * timeout that quietly reassigned the writer would be precisely the second
 * writer F17-AC5 forbids.
 *
 * The workspace lock and the port reservations live here because they are
 * resource ownership rather than job lifecycle: a lock names its active owner,
 * and a port belongs to exactly one workspace, so a collision surfaces as a
 * blocker instead of silently attaching to an unrelated service (F14-AC3).
 *
 * The `*OnConnection` helpers are deliberately transaction-free. `claimNext`
 * must claim the slot, write the lease and move the job inside one transaction,
 * so the primitives cannot own their own transaction and are exported for the
 * queue to call within its own.
 */

/** Product default heartbeat cadence (mvp-spec 7, "Defaults to validate"). */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Beyond this silence a job needs reconciliation, and never a second writer. */
export const MISSED_HEARTBEAT_RECONCILE_MS = 60_000;

/**
 * Upper bound on a lease term.
 *
 * A longer term would hide a wedged writer from the owner for longer than the
 * pilot tolerates, which is a worse failure than an unnecessary reconciliation
 * prompt.
 */
export const MAX_LEASE_TTL_MS = 15 * 60 * 1000;

/** Singleton primary key of the coding slot row. */
export const CODING_SLOT_ROW_ID = 1;

/** What the durable lease row currently permits a caller to do. */
export type LeaseDisposition = 'Vacant' | 'Held' | 'ReconciliationRequired';

export interface AcquireLeaseRequest {
  readonly leaseId: string;
  readonly jobId: JobId;
  readonly holder: string;
  readonly operationId: OperationId;
  readonly now: string;
  readonly leaseTtlMs: number;
}

export interface RenewLeaseRequest {
  readonly leaseId: string;
  readonly jobId: JobId;
  readonly holder: string;
  readonly now: string;
  readonly leaseTtlMs: number;
}

export interface ReleaseLeaseRequest {
  readonly leaseId: string;
  readonly jobId: JobId;
  readonly holder: string;
  readonly now: string;
  readonly jobState: AttemptState;
}

export interface ReclaimLeaseRequest extends AcquireLeaseRequest {}

/**
 * An assertion that a holder is no longer running.
 *
 * `evidence` is recorded verbatim because this claim is what frees the single
 * coding writer, and "someone said so" is not a basis for granting a second.
 */
export interface ConfirmHolderStoppedRequest {
  readonly jobId: JobId;
  readonly holder: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly evidence: string;
}

export interface WorkspaceLockRecord {
  readonly workspaceId: string;
  readonly jobId: JobId;
  readonly holder: string;
  readonly branchName: string;
  readonly worktreePath: string;
  readonly acquiredAt: string;
}

export interface AcquireWorkspaceLockRequest {
  readonly workspaceId: string;
  readonly jobId: JobId;
  readonly holder: string;
  readonly branchName: string;
  readonly worktreePath: string;
  readonly now: string;
}

export interface PortAllocation {
  readonly serviceName: string;
  readonly port: number;
}

export interface PortReservation {
  readonly workspaceId: string;
  readonly jobId: JobId;
  readonly holder: string;
  readonly serviceName: string;
  readonly port: number;
}

export interface ReservePortsRequest extends AcquireWorkspaceLockRequest {
  readonly allocations: readonly PortAllocation[];
}

/** Connections and the transaction runner the lease manager is built on. */
export interface LeaseStore {
  readonly connection: SqlConnection;
  readonly transaction?: TransactionRunner | null;
}

export interface LeaseManager {
  ensureCodingSlot: () => void;
  acquireLease: (request: AcquireLeaseRequest) => Result<WriterLease, DomainError>;
  renewLease: (request: RenewLeaseRequest) => Result<WriterLease, DomainError>;
  releaseLease: (request: ReleaseLeaseRequest) => Result<WriterLease, DomainError>;
  reclaimLease: (request: ReclaimLeaseRequest) => Result<ReclaimOutcome, DomainError>;
  confirmHolderStopped: (request: ConfirmHolderStoppedRequest) => Result<WriterLease, DomainError>;
  leaseStatus: (jobId: JobId) => Result<WriterLease | null, DomainError>;
  leaseDisposition: (lease: WriterLease, now: string) => LeaseDisposition;
  acquireWorkspaceLock: (request: AcquireWorkspaceLockRequest) => Result<WorkspaceLockRecord, DomainError>;
  reserveWorkspacePorts: (request: ReservePortsRequest) => Result<readonly PortReservation[], DomainError>;
  readPortOwner: (port: number) => PortReservation | null;
}

/**
 * The durable tables this slice reads, with the columns it depends on.
 *
 * The statements in this module do not create them: `migrations.ts` owns the
 * schema, and a module that quietly issued its own `CREATE TABLE` would let two
 * definitions of the same table drift apart.
 */
export const LEASE_SCHEMA_CONTRACT = {
  codingSlot:
    'coding_slot(slot_id INTEGER PRIMARY KEY CHECK (slot_id = 1), job_id TEXT, holder TEXT, operation_id TEXT, acquired_at TEXT, expires_at TEXT, generation INTEGER NOT NULL)',
  writerLease:
    'writer_lease(lease_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, holder TEXT NOT NULL, operation_id TEXT NOT NULL, acquired_at TEXT NOT NULL, renewed_at TEXT NOT NULL, expires_at TEXT NOT NULL, state TEXT NOT NULL, reconciliation_required INTEGER NOT NULL, reconciliation_reason TEXT, confirmed_stopped_by TEXT, confirmed_stopped_at TEXT, confirmed_stopped_evidence TEXT)',
  workspaceLock:
    'workspace_lock(workspace_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, holder TEXT NOT NULL, branch_name TEXT NOT NULL, worktree_path TEXT NOT NULL, acquired_at TEXT NOT NULL)',
  workspacePort:
    'workspace_port(workspace_id TEXT NOT NULL, service_name TEXT NOT NULL, port INTEGER NOT NULL UNIQUE, job_id TEXT NOT NULL, holder TEXT NOT NULL, reserved_at TEXT NOT NULL, PRIMARY KEY (workspace_id, service_name))',
} as const;

/**
 * Rejects a lease term that could not distinguish a wedged writer from a dead one.
 *
 * Exported because `claimNext` takes the same term and must refuse it for the
 * same reason: a claim whose lease is shorter than the missed-heartbeat
 * threshold would start a writer the product cannot later ask about.
 */
export function rejectLeaseTerm(leaseTtlMs: number): Result<null, DomainError> {
  if (!Number.isFinite(leaseTtlMs) || leaseTtlMs < MISSED_HEARTBEAT_RECONCILE_MS) {
    return err(
      invalid(`A lease term must be at least ${MISSED_HEARTBEAT_RECONCILE_MS}ms.`, [
        {
          path: 'leaseTtlMs',
          message:
            'A term shorter than the missed-heartbeat threshold would let the queue call a live process stopped before the product is allowed to ask whether it stopped (F17-AC5).',
        },
      ]),
    );
  }
  if (leaseTtlMs > MAX_LEASE_TTL_MS) {
    return err(
      invalid(`A lease term must not exceed ${MAX_LEASE_TTL_MS}ms.`, [
        { path: 'leaseTtlMs', message: 'A longer term hides a wedged writer for longer than the pilot can accept.' },
      ]),
    );
  }
  return ok(null);
}

function expiryOf(now: string, leaseTtlMs: number): string {
  const parsed = Date.parse(now);
  if (Number.isNaN(parsed)) throw new Error(`"${now}" is not a usable timestamp.`);
  return new Date(parsed + leaseTtlMs).toISOString();
}

/** ISO-8601 UTC timestamps of one fixed width sort lexicographically. */
function laterTimestamp(left: string, right: string): string {
  return left > right ? left : right;
}

/**
 * Builds the lease row a fresh acquisition writes.
 *
 * Exported so `claimNext` can mint the lease and take the slot inside one
 * transaction; a claim that wrote them separately would leave a claimed slot
 * whose lease does not yet exist (N01-AC1).
 */
export function mintWriterLease(request: AcquireLeaseRequest): WriterLease {
  return {
    leaseId: request.leaseId,
    jobId: request.jobId,
    holder: request.holder,
    operationId: request.operationId,
    acquiredAt: request.now,
    renewedAt: request.now,
    expiresAt: expiryOf(request.now, request.leaseTtlMs),
    state: 'Active',
    reconciliationRequired: false,
    reconciliationReason: null,
    confirmedStoppedBy: null,
    confirmedStoppedAt: null,
    confirmedStoppedEvidence: null,
  };
}

/**
 * What the stored lease currently permits.
 *
 * Expiry alone yields `ReconciliationRequired`, never `Vacant`. That one
 * decision is the whole of F17-AC5.
 */
export function leaseDispositionOf(lease: WriterLease, now: string): LeaseDisposition {
  if (lease.state === 'Released' || lease.state === 'HolderStoppedConfirmed') return 'Vacant';
  if (lease.state === 'ReconciliationRequired' || lease.reconciliationRequired) return 'ReconciliationRequired';
  if (lease.expiresAt <= now) return 'ReconciliationRequired';
  return 'Held';
}

/**
 * Seeds the singleton slot row if the migration has not already done so.
 *
 * Idempotent and taken through the transaction runner, so two workers starting
 * together cannot both win.
 */
export function ensureCodingSlotOnConnection(connection: SqlConnection, transaction: TransactionRunner): void {
  transaction(connection, () => {
    connection
      .prepare('INSERT OR IGNORE INTO coding_slot (slot_id, generation) VALUES (?, 0)')
      .run(CODING_SLOT_ROW_ID);
  });
}

/** Reads the single global coding slot. */
export function readSlotOnConnection(connection: SqlConnection): import('./types.ts').CodingSlot {
  const row = connection.prepare('SELECT * FROM coding_slot WHERE slot_id = ?').get(CODING_SLOT_ROW_ID);
  if (row === undefined) {
    throw new Error('The coding slot row is missing; seed it before claiming work.');
  }
  const jobId = readOptionalText(row, 'job_id');
  const holder = readOptionalText(row, 'holder');
  const operationId = readOptionalText(row, 'operation_id');
  return {
    jobId: jobId === null ? null : (jobId as JobId),
    holder,
    operationId: operationId === null ? null : (operationId as OperationId),
    acquiredAt: readOptionalText(row, 'acquired_at'),
    expiresAt: readOptionalText(row, 'expires_at'),
    generation: readInteger(row, 'generation'),
  };
}

/** Reads the durable lease for a job, or null when none was ever written. */
export function readLeaseOnConnection(connection: SqlConnection, jobId: JobId): WriterLease | null {
  const row = connection.prepare('SELECT * FROM writer_lease WHERE job_id = ?').get(jobId);
  if (row === undefined) return null;
  return {
    leaseId: readText(row, 'lease_id'),
    jobId: readText(row, 'job_id') as JobId,
    holder: readText(row, 'holder'),
    operationId: readText(row, 'operation_id') as OperationId,
    acquiredAt: readText(row, 'acquired_at'),
    renewedAt: readText(row, 'renewed_at'),
    expiresAt: readText(row, 'expires_at'),
    state: readText(row, 'state') as LeaseState,
    reconciliationRequired: readInteger(row, 'reconciliation_required') === 1,
    reconciliationReason: readOptionalText(row, 'reconciliation_reason'),
    confirmedStoppedBy: readOptionalText(row, 'confirmed_stopped_by'),
    confirmedStoppedAt: readOptionalText(row, 'confirmed_stopped_at'),
    confirmedStoppedEvidence: readOptionalText(row, 'confirmed_stopped_evidence'),
  };
}

/**
 * Writes the lease row, replacing any existing row for the same job.
 *
 * Exported for `claimNext`, which must persist the lease inside the same
 * transaction that claims the coding slot. Two statements in two transactions
 * would let a crash land between them and leave a claimed slot with no lease,
 * which is the unrecoverable state the atomic claim exists to prevent
 * (N01-AC1, N01-AC3).
 */
export function writeLeaseOnConnection(connection: SqlConnection, lease: WriterLease): void {
  connection
    .prepare(
      `INSERT INTO writer_lease (
         lease_id, job_id, holder, operation_id, acquired_at, renewed_at, expires_at,
         state, reconciliation_required, reconciliation_reason,
         confirmed_stopped_by, confirmed_stopped_at, confirmed_stopped_evidence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         lease_id = excluded.lease_id,
         holder = excluded.holder,
         operation_id = excluded.operation_id,
         acquired_at = excluded.acquired_at,
         renewed_at = excluded.renewed_at,
         expires_at = excluded.expires_at,
         state = excluded.state,
         reconciliation_required = excluded.reconciliation_required,
         reconciliation_reason = excluded.reconciliation_reason,
         confirmed_stopped_by = excluded.confirmed_stopped_by,
         confirmed_stopped_at = excluded.confirmed_stopped_at,
         confirmed_stopped_evidence = excluded.confirmed_stopped_evidence`,
    )
    .run(
      lease.leaseId,
      lease.jobId,
      lease.holder,
      lease.operationId,
      lease.acquiredAt,
      lease.renewedAt,
      lease.expiresAt,
      lease.state,
      lease.reconciliationRequired ? 1 : 0,
      lease.reconciliationReason,
      lease.confirmedStoppedBy,
      lease.confirmedStoppedAt,
      lease.confirmedStoppedEvidence,
    );
}

/**
 * Takes the single global coding slot.
 *
 * The re-read is not defensive duplication: the conditional UPDATE is evaluated
 * by SQLite while the write lock is held, so a loser loses on the database
 * rather than on scheduling. Callers must be inside a transaction, because
 * outside one this is just a row update with no lock to hold it in place.
 */
export function claimSlotOnConnection(
  connection: SqlConnection,
  request: AcquireLeaseRequest,
  lease: WriterLease,
): Result<import('./types.ts').CodingSlot, DomainError> {
  const outcome = connection
    .prepare(
      `UPDATE coding_slot
         SET job_id = ?, holder = ?, operation_id = ?, acquired_at = ?, expires_at = ?, generation = generation + 1
       WHERE slot_id = ? AND (holder IS NULL OR holder = ?)`,
    )
    .run(request.jobId, request.holder, request.operationId, request.now, lease.expiresAt, CODING_SLOT_ROW_ID, request.holder);
  if (Number(outcome.changes) !== 1) {
    const occupant = readSlotOnConnection(connection);
    return err(
      conflict(
        `The single global coding slot is held by ${occupant.holder ?? 'another writer'} for job ${occupant.jobId ?? 'unknown'}; this job stays queued (F13-AC2).`,
        'an unheld coding slot',
        `held by ${occupant.holder ?? 'another writer'}`,
      ),
    );
  }
  return ok(readSlotOnConnection(connection));
}

/** Extends the slot's visible expiry to match its lease. */
export function extendSlotOnConnection(connection: SqlConnection, jobId: JobId, expiresAt: string): void {
  connection
    .prepare('UPDATE coding_slot SET expires_at = ? WHERE slot_id = ? AND job_id = ?')
    .run(expiresAt, CODING_SLOT_ROW_ID, jobId);
}

/** Releases the single global coding slot. */
export function releaseSlotOnConnection(connection: SqlConnection, jobId: JobId, holder: string): void {
  const outcome = connection
    .prepare(
      'UPDATE coding_slot SET job_id = NULL, holder = NULL, operation_id = NULL, acquired_at = NULL, expires_at = NULL, generation = generation + 1 WHERE slot_id = ? AND job_id = ? AND holder = ?',
    )
    .run(CODING_SLOT_ROW_ID, jobId, holder);
  if (Number(outcome.changes) === 0) {
    throw new Error(`The coding slot was not held by ${holder} for job ${jobId}, so it cannot be released.`);
  }
}

function openReconciliationOnConnection(
  connection: SqlConnection,
  lease: WriterLease,
  reason: string,
  now: string,
): WriterLease {
  const updated: WriterLease = {
    ...lease,
    state: 'ReconciliationRequired',
    reconciliationRequired: true,
    reconciliationReason: reason,
    renewedAt: laterTimestamp(lease.renewedAt, now),
  };
  writeLeaseOnConnection(connection, updated);
  return updated;
}

/**
 * Renews an existing lease in place.
 *
 * Renewal is not acquisition. It refuses when the holder lost the lease, so a
 * process that was reclaimed while suspended cannot silently keep extending
 * ownership it no longer holds.
 */
export function renewLeaseOnConnection(
  connection: SqlConnection,
  request: RenewLeaseRequest,
): Result<WriterLease, DomainError> {
  const existing = readLeaseOnConnection(connection, request.jobId);
  if (existing === null) {
    return err({ code: 'NotFound', reason: `No writer lease exists for job ${request.jobId}.` });
  }
  if (existing.holder !== request.holder) {
    return err(conflict(`Only ${existing.holder} may renew this lease.`, existing.holder, request.holder));
  }
  if (existing.state !== 'Active') {
    return err(
      conflict(
        `This lease is ${existing.state}; renewing it would extend ownership the holder has already given up.`,
        'Active',
        existing.state,
      ),
    );
  }
  const rejected = rejectLeaseTerm(request.leaseTtlMs);
  if (!rejected.ok) return rejected;

  const renewed: WriterLease = {
    ...existing,
    renewedAt: laterTimestamp(existing.renewedAt, request.now),
    expiresAt: laterTimestamp(existing.expiresAt, expiryOf(request.now, request.leaseTtlMs)),
  };
  writeLeaseOnConnection(connection, renewed);
  extendSlotOnConnection(connection, request.jobId, renewed.expiresAt);
  return ok(renewed);
}

/**
 * Records a holder's declared job state when it gives the slot up.
 *
 * The transition is validated against the domain attempt transitions, so
 * releasing the slot cannot smuggle a job into a state the lifecycle forbids.
 */
export function moveJobStateOnConnection(
  connection: SqlConnection,
  jobId: JobId,
  jobState: AttemptState,
  now: string,
): Result<null, DomainError> {
  const current = connection.prepare('SELECT state FROM job WHERE job_id = ?').get(jobId);
  if (current === undefined) return ok(null);
  const transition = assertTransition('attempt', readText(current, 'state'), jobState);
  if (!transition.ok) return transition;
  connection.prepare('UPDATE job SET state = ?, holder = NULL, updated_at = ? WHERE job_id = ?').run(jobState, now, jobId);
  return ok(null);
}

function workspaceLockFrom(row: SqlRow): WorkspaceLockRecord {
  return {
    workspaceId: readText(row, 'workspace_id'),
    jobId: readText(row, 'job_id') as JobId,
    holder: readText(row, 'holder'),
    branchName: readText(row, 'branch_name'),
    worktreePath: readText(row, 'worktree_path'),
    acquiredAt: readText(row, 'acquired_at'),
  };
}

function readPortOwnerOnConnection(connection: SqlConnection, port: number): PortReservation | null {
  const row = connection.prepare('SELECT * FROM workspace_port WHERE port = ?').get(port);
  if (row === undefined) return null;
  return {
    workspaceId: readText(row, 'workspace_id'),
    jobId: readText(row, 'job_id') as JobId,
    holder: readText(row, 'holder'),
    serviceName: readText(row, 'service_name'),
    port: readInteger(row, 'port'),
  };
}

/** Builds a lease manager bound to one connection and one transaction runner. */
export function createLeaseManager(store: LeaseStore): LeaseManager {
  const connection = store.connection;
  const transaction: TransactionRunner = store.transaction ?? defaultTransactionRunner;

  function acquireLease(request: AcquireLeaseRequest): Result<WriterLease, DomainError> {
    return guard(() =>
      transaction(connection, () => {
        const rejected = rejectLeaseTerm(request.leaseTtlMs);
        if (!rejected.ok) return rejected;

        const existing = readLeaseOnConnection(connection, request.jobId);
        if (existing !== null) {
          const disposition = leaseDispositionOf(existing, request.now);
          if (disposition === 'Held') {
            return err(
              conflict(
                `Writer ownership is held by ${existing.holder} until ${existing.expiresAt}.`,
                'no current writer',
                `writer ${existing.holder}`,
              ),
            );
          }
          if (disposition === 'ReconciliationRequired') {
            return err(
              conflict(
                `Writer ownership must be reconciled first: ${
                  existing.reconciliationReason ?? 'the previous holder stopped heartbeating'
                }.`,
                'the previous holder confirmed stopped',
                `writer ${existing.holder} unreconciled`,
              ),
            );
          }
        }
        const lease = mintWriterLease(request);
        writeLeaseOnConnection(connection, lease);
        return ok(lease);
      }),
    );
  }

  function renewLease(request: RenewLeaseRequest): Result<WriterLease, DomainError> {
    return guard(() => transaction(connection, () => renewLeaseOnConnection(connection, request)));
  }

  function releaseLease(request: ReleaseLeaseRequest): Result<WriterLease, DomainError> {
    return guard(() =>
      transaction(connection, () => {
        const existing = readLeaseOnConnection(connection, request.jobId);
        if (existing === null) {
          return err({ code: 'NotFound', reason: `No writer lease exists for job ${request.jobId}.` });
        }
        if (existing.holder !== request.holder) {
          return err(conflict(`Only ${existing.holder} may release this lease.`, existing.holder, request.holder));
        }
        if (existing.state === 'ReconciliationRequired') {
          return err(
            conflict(
              'A lease awaiting reconciliation cannot be released; confirm the holder stopped instead.',
              'HolderStoppedConfirmed',
              'ReconciliationRequired',
            ),
          );
        }
        const moved = moveJobStateOnConnection(connection, request.jobId, request.jobState, request.now);
        if (!moved.ok) return moved;

        const released: WriterLease = { ...existing, state: 'Released' as LeaseState };
        writeLeaseOnConnection(connection, released);
        const slot = readSlotOnConnection(connection);
        if (slot.jobId === request.jobId && slot.holder === request.holder) {
          releaseSlotOnConnection(connection, request.jobId, request.holder);
        }
        return ok(released);
      }),
    );
  }

  /**
   * Decides whether a caller may take over a job whose writer ownership is unclear.
   *
   * This grants the single coding writer, so it is where the tempting shortcut
   * lives: "the lease expired, therefore the process is gone". It is refused
   * here. An expired lease records that reconciliation is required and returns
   * without granting; only a lease the operator confirmed stopped is vacant.
   */
  function reclaimLease(request: ReclaimLeaseRequest): Result<ReclaimOutcome, DomainError> {
    return guard((): Result<ReclaimOutcome, DomainError> =>
      transaction(connection, (): Result<ReclaimOutcome, DomainError> => {
        const rejected = rejectLeaseTerm(request.leaseTtlMs);
        if (!rejected.ok) return rejected;

        const existing = readLeaseOnConnection(connection, request.jobId);

        if (existing === null) {
          const lease = mintWriterLease(request);
          writeLeaseOnConnection(connection, lease);
          const claimed = claimSlotOnConnection(connection, request, lease);
          if (!claimed.ok) return claimed;
          return ok({ granted: true, lease, slot: claimed.value, previousHolder: null });
        }

        if (existing.holder === request.holder) {
          return ok({ granted: true, lease: existing, slot: readSlotOnConnection(connection), previousHolder: existing.holder });
        }

        const disposition = leaseDispositionOf(existing, request.now);
        if (disposition === 'Held') {
          return ok({
            granted: false,
            reconciliationRequired: false,
            reason: `Writer ${existing.holder} is inside its lease until ${existing.expiresAt}; a second writer is not permitted.`,
            lease: existing,
            slot: readSlotOnConnection(connection),
          });
        }

        if (disposition === 'ReconciliationRequired') {
          const opened = openReconciliationOnConnection(
            connection,
            existing,
            existing.reconciliationReason ??
              `No heartbeat from ${existing.holder} since ${existing.renewedAt}; whether that process still writes is unknown.`,
            request.now,
          );
          return ok({
            granted: false,
            reconciliationRequired: true,
            reason:
              'The lease expired, which proves only that heartbeats stopped. Establish that the previous holder is no longer writing, then reclaim again (F17-AC5).',
            lease: opened,
            slot: readSlotOnConnection(connection),
          });
        }

        const lease = mintWriterLease(request);
        writeLeaseOnConnection(connection, lease);
        const claimed = claimSlotOnConnection(connection, request, lease);
        if (!claimed.ok) return claimed;
        return ok({ granted: true, lease, slot: claimed.value, previousHolder: existing.holder });
      }),
    );
  }

  /**
   * Records an operator's confirmation that a holder stopped, the only way an
   * expired lease becomes reclaimable (F17-AC5).
   *
   * The confirmation also frees the coding slot, because that confirmation is
   * what authorises another writer: leaving the slot held would make the single
   * global writer permanently unrecoverable, and a recovery path that cannot
   * complete is indistinguishable from one that forbids recovery.
   */
  function confirmHolderStopped(request: ConfirmHolderStoppedRequest): Result<WriterLease, DomainError> {
    return guard(() =>
      transaction(connection, () => {
        if (request.confirmedBy.trim().length === 0) {
          return err(
            invalid('A holder-stopped confirmation must name who made it.', [
              { path: 'confirmedBy', message: 'Name the operator or system that established the holder stopped.' },
            ]),
          );
        }
        if (request.evidence.trim().length === 0) {
          return err(
            invalid('A holder-stopped confirmation must record what established it.', [
              { path: 'evidence', message: 'Record what showed the process is no longer writing.' },
            ]),
          );
        }
        const existing = readLeaseOnConnection(connection, request.jobId);
        if (existing === null) {
          return err({ code: 'NotFound', reason: `No writer lease exists for job ${request.jobId}.` });
        }
        if (existing.holder !== request.holder) {
          return err(
            conflict(
              `This confirmation names ${request.holder}, but the recorded holder is ${existing.holder}.`,
              existing.holder,
              request.holder,
            ),
          );
        }
        if (existing.state === 'Released') {
          return err(
            conflict(
              'This lease was released normally, so there is no stopped process to reconcile.',
              'ReconciliationRequired',
              'Released',
            ),
          );
        }
        if (existing.state === 'HolderStoppedConfirmed') {
          return ok(existing);
        }
        if (leaseDispositionOf(existing, request.confirmedAt) === 'Held') {
          return err(
            conflict(
              `Writer ${existing.holder} is inside its lease until ${existing.expiresAt}; confirming it stopped now would be a guess, not a reconciliation.`,
              'ReconciliationRequired',
              'Held',
            ),
          );
        }
        const confirmed: WriterLease = {
          ...existing,
          state: 'HolderStoppedConfirmed',
          reconciliationRequired: false,
          confirmedStoppedBy: request.confirmedBy,
          confirmedStoppedAt: request.confirmedAt,
          confirmedStoppedEvidence: request.evidence,
          renewedAt: laterTimestamp(existing.renewedAt, request.confirmedAt),
        };
        writeLeaseOnConnection(connection, confirmed);
        const slot = readSlotOnConnection(connection);
        if (slot.jobId === request.jobId && slot.holder === request.holder) {
          releaseSlotOnConnection(connection, request.jobId, request.holder);
        }
        return ok(confirmed);
      }),
    );
  }

  /**
   * Reserves ports for one workspace, refusing a collision rather than
   * re-pointing a service at whatever already answers there (F14-AC3).
   */
  function reserveWorkspacePorts(request: ReservePortsRequest): Result<readonly PortReservation[], DomainError> {
    return guard(() =>
      transaction(connection, () => {
        const requested = new Set<number>();
        for (const allocation of request.allocations) {
          if (!Number.isInteger(allocation.port) || allocation.port <= 0 || allocation.port > 65535) {
            return err(
              invalid(`"${allocation.port}" is not a usable port for ${allocation.serviceName}.`, [
                { path: 'allocations.port', message: 'A port must be an integer between 1 and 65535.' },
              ]),
            );
          }
          if (requested.has(allocation.port)) {
            return err(
              invalid(`Port ${allocation.port} was requested twice by workspace ${request.workspaceId}.`, [
                { path: 'allocations', message: 'One workspace cannot reserve the same port for two of its services.' },
              ]),
            );
          }
          requested.add(allocation.port);
        }

        const collisions: string[] = [];
        for (const allocation of request.allocations) {
          const occupant = readPortOwnerOnConnection(connection, allocation.port);
          if (occupant !== null && occupant.workspaceId !== request.workspaceId) {
            collisions.push(
              `port ${allocation.port} for ${allocation.serviceName} is already reserved by workspace ${occupant.workspaceId} (job ${occupant.jobId}, holder ${occupant.holder})`,
            );
          }
        }
        if (collisions.length > 0) {
          return err(
            blocked(`Workspace ${request.workspaceId} cannot start its services: ${collisions.join('; ')}.`, [
              {
                name: 'isolated-port-allocation',
                detail: collisions.join('; '),
                remedy:
                  "Stop the other workspace or move one workspace's configured ports, then start again. Reusing the occupied port would report another process's behaviour as this job's result (F14-AC3).",
              },
            ]),
          );
        }

        const reservations: PortReservation[] = [];
        for (const allocation of request.allocations) {
          connection
            .prepare(
              `INSERT INTO workspace_port (workspace_id, service_name, port, job_id, holder, reserved_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(workspace_id, service_name) DO UPDATE SET
                 port = excluded.port, job_id = excluded.job_id, holder = excluded.holder, reserved_at = excluded.reserved_at`,
            )
            .run(
              request.workspaceId,
              allocation.serviceName,
              allocation.port,
              request.jobId,
              request.holder,
              request.now,
            );
          reservations.push({
            workspaceId: request.workspaceId,
            jobId: request.jobId,
            holder: request.holder,
            serviceName: allocation.serviceName,
            port: allocation.port,
          });
        }
        return ok(reservations);
      }),
    );
  }

  function acquireWorkspaceLock(request: AcquireWorkspaceLockRequest): Result<WorkspaceLockRecord, DomainError> {
    return guard(() =>
      transaction(connection, () => {
        const existing = connection.prepare('SELECT * FROM workspace_lock WHERE workspace_id = ?').get(request.workspaceId);
        if (existing !== undefined) {
          const lock = workspaceLockFrom(existing);
          if (lock.holder !== request.holder || lock.jobId !== request.jobId) {
            return err(
              conflict(
                `Workspace ${request.workspaceId} is owned by ${lock.holder} for job ${lock.jobId}.`,
                `${lock.holder}/${lock.jobId}`,
                `${request.holder}/${request.jobId}`,
              ),
            );
          }
          return ok(lock);
        }
        connection
          .prepare(
            'INSERT INTO workspace_lock (workspace_id, job_id, holder, branch_name, worktree_path, acquired_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(request.workspaceId, request.jobId, request.holder, request.branchName, request.worktreePath, request.now);
        const stored = connection.prepare('SELECT * FROM workspace_lock WHERE workspace_id = ?').get(request.workspaceId);
        if (stored === undefined) throw new Error('The workspace lock was unreadable immediately after insert.');
        return ok(workspaceLockFrom(stored));
      }),
    );
  }

  return {
    ensureCodingSlot: () => ensureCodingSlotOnConnection(connection, transaction),
    acquireLease,
    renewLease,
    releaseLease,
    reclaimLease,
    confirmHolderStopped,
    leaseStatus: (jobId) => guard(() => ok(readLeaseOnConnection(connection, jobId))),
    leaseDisposition: (lease, now) => leaseDispositionOf(lease, now),
    acquireWorkspaceLock,
    reserveWorkspacePorts,
    readPortOwner: (port) => readPortOwnerOnConnection(connection, port),
  };
}