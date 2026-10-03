/**
 * Requests and delivery contracts over the migrated SQLite store (mvp-spec 3).
 *
 * One repository for both because the interesting write - "revise" - spans them: a new
 * revision and the supersession of the approval it replaces must land together or not at
 * all. Splitting them would mean two callers each half-remembering to do both.
 *
 * Every method takes the project the caller believes it is acting in and checks it
 * against the row, rather than trusting the identifier alone. That is the whole
 * isolation rule (F02-AC2, N02-AC3): a request id is a string, and a string from
 * another project must not become a read of this one's data. The refusal is `NotFound`
 * rather than `Forbidden` on purpose - a caller learns there is no such request *here*,
 * which is the same answer whether the request does not exist or belongs elsewhere.
 *
 * Nothing here computes a fingerprint. The domain owns `contractContentFingerprint`, so
 * "material" means one thing when writing a draft and the same thing when a stored
 * revision is compared (mvp-spec 3).
 */

import { canonicalize, contractContentFingerprint, err, invalid, ok } from '@shiploop/domain';
import type {
  ContractContent,
  ContractCriterion,
  ContractId,
  DeliveryContract,
  DomainError,
  Fingerprint,
  OwnerId,
  ProjectId,
  Request,
  RequestId,
  Result,
  VerificationType,
} from '@shiploop/domain';
import type { Database } from '../db.ts';
import { withTransaction } from '../tx.ts';

/** What the driver accepts as a bound parameter. */
type SqlInputValue = string | number | bigint | null | Uint8Array;

type SqlRow = Record<string, unknown>;

const REQUEST_COLUMNS = 'request_id, project_id, title, description, source_idea_id, created_at, updated_at';

const CONTRACT_COLUMNS = [
  'contract_id',
  'project_id',
  'request_id',
  'revision',
  'outcome',
  'scope_json',
  'out_of_scope_json',
  'acceptance_criteria_json',
  'status',
  'content_fingerprint',
  'request_fingerprint',
  'approved_by_owner_id',
  'approved_at',
  'stale_reason',
  'superseded_by_revision',
  'source_brief_id',
  'source_brief_version',
  'created_by_owner_id',
  'created_at',
  'updated_at',
].join(', ');

function requiredText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`column ${column} is missing or not text`);
  return value;
}

function nullableText(row: SqlRow, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

function requiredInteger(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`column ${column} is missing or not an integer`);
}

function nullableInteger(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`column ${column} is not an integer`);
}

function fingerprintOf(row: SqlRow, column: string): Fingerprint {
  return requiredText(row, column) as Fingerprint;
}

/**
 * Reads a stored JSON document.
 *
 * The cast is the trust boundary: every one of these documents was serialised by this
 * repository from a typed record on the way in, and the columns CHECK `json_valid` plus
 * `json_type = 'array'`. A row restored from an older backup or hand-edited is the case
 * this cannot defend, and the checks below report it rather than inventing a value.
 */
function parseJsonArray<T>(row: SqlRow, column: string): readonly T[] {
  const parsed: unknown = JSON.parse(requiredText(row, column));
  if (!Array.isArray(parsed)) throw new Error(`column ${column} is not a JSON array`);
  return parsed as readonly T[];
}

function parseStringArray(row: SqlRow, column: string): readonly string[] {
  const entries = parseJsonArray<unknown>(row, column);
  for (const entry of entries) {
    if (typeof entry !== 'string') throw new Error(`column ${column} holds a non-text entry`);
  }
  return entries as readonly string[];
}

function notFound(entity: string, identity: string): DomainError {
  return { code: 'NotFound', reason: `${entity} ${identity} does not exist.` };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toRequest(row: SqlRow): Request {
  return Object.freeze({
    requestId: requiredText(row, 'request_id') as RequestId,
    projectId: requiredText(row, 'project_id') as ProjectId,
    title: requiredText(row, 'title'),
    description: requiredText(row, 'description'),
    sourceIdeaId: nullableText(row, 'source_idea_id'),
    createdAt: requiredText(row, 'created_at'),
    updatedAt: requiredText(row, 'updated_at'),
  });
}

interface StoredCriterion {
  readonly id: string;
  readonly description: string;
  readonly verificationType: VerificationType;
}

/**
 * Rebuilds a stored revision, refusing a row this build cannot interpret.
 *
 * The refusal matters more than it looks. A malformed row read as a contract with an
 * invented criterion would put text in front of an owner that no approval ever covered,
 * and a candidate could then be measured against it. `Unavailable` is the honest answer:
 * the row is there and this build cannot explain it.
 */
function toContract(row: SqlRow): Result<DeliveryContract> {
  let scope: readonly string[];
  let outOfScope: readonly string[];
  let acceptanceCriteria: readonly ContractCriterion[];
  try {
    scope = parseStringArray(row, 'scope_json');
    outOfScope = parseStringArray(row, 'out_of_scope_json');
    acceptanceCriteria = parseJsonArray<StoredCriterion>(row, 'acceptance_criteria_json').map((criterion) => {
      if (
        typeof criterion?.id !== 'string' ||
        typeof criterion?.description !== 'string' ||
        typeof criterion?.verificationType !== 'string'
      ) {
        throw new Error('a stored criterion is missing id, description or verificationType');
      }
      return Object.freeze({ ...criterion });
    });
  } catch (error) {
    return err({
      code: 'Unavailable',
      reason: `A stored delivery contract revision cannot be read: ${describeError(error)}.`,
    });
  }

  const status = requiredText(row, 'status');
  const contractId = requiredText(row, 'contract_id') as ContractId;
  const projectId = requiredText(row, 'project_id') as ProjectId;
  const requestId = requiredText(row, 'request_id') as RequestId;
  const revision = requiredInteger(row, 'revision');
  const contentFingerprint = fingerprintOf(row, 'content_fingerprint');
  const requestFingerprint = fingerprintOf(row, 'request_fingerprint');
  const sourceBriefId = nullableText(row, 'source_brief_id');
  const sourceBriefVersion = nullableInteger(row, 'source_brief_version');
  const createdBy = nullableText(row, 'created_by_owner_id');
  const createdAt = requiredText(row, 'created_at');
  const updatedAt = requiredText(row, 'updated_at');
  const staleReason = nullableText(row, 'stale_reason');
  const supersededByRevision = nullableInteger(row, 'superseded_by_revision');
  const approvedBy = nullableText(row, 'approved_by_owner_id');
  const approvedAt = nullableText(row, 'approved_at');

  const content: ContractContent = Object.freeze({
    outcome: requiredText(row, 'outcome'),
    scope: Object.freeze([...scope]),
    outOfScope: Object.freeze([...outOfScope]),
    acceptanceCriteria: Object.freeze([...acceptanceCriteria]),
  });

  const base = {
    ...content,
    contractId,
    projectId,
    requestId,
    revision,
    sourceBriefId,
    sourceBriefVersion,
    contentFingerprint,
    requestFingerprint,
    createdBy: createdBy as OwnerId,
    createdAt,
    updatedAt,
  };

  // The column is NOT NULL, so a null here means the row came from somewhere that did
  // not write it. Reporting it beats inventing an owner: an agreement whose writer is a
  // fiction is exactly what the approval rule exists to prevent.
  if (createdBy === null) {
    return err({
      code: 'Unavailable',
      reason: `Delivery contract revision ${revision} is stored without recording who wrote it.`,
    });
  }

  if (status === 'draft') {
    if (approvedBy !== null || approvedAt !== null || staleReason !== null || supersededByRevision !== null) {
      return err({
        code: 'Unavailable',
        reason: `Delivery contract revision ${revision} is stored as a draft but carries an approval or a staleness fact.`,
      });
    }
    return ok(Object.freeze({ ...base, status: 'draft', approvedAt: null, approvedBy: null, staleReason: null, supersededByRevision: null }));
  }

  if (status === 'approved') {
    if (approvedBy === null || approvedAt === null) {
      return err({
        code: 'Unavailable',
        reason: `Delivery contract revision ${revision} is stored as approved without an owner or an instant.`,
      });
    }
    return ok(
      Object.freeze({
        ...base,
        status: 'approved',
        approvedAt,
        approvedBy: approvedBy as OwnerId,
        staleReason: null,
        supersededByRevision: null,
      }),
    );
  }

  if (status === 'stale') {
    if (staleReason === null) {
      return err({
        code: 'Unavailable',
        reason: `Delivery contract revision ${revision} is stored as stale without saying why.`,
      });
    }
    return ok(Object.freeze({ ...base, status: 'stale', approvedAt, approvedBy: approvedBy as OwnerId | null, staleReason, supersededByRevision }));
  }

  return err({
    code: 'Unavailable',
    reason: `Delivery contract revision ${revision} holds an unknown status "${status}".`,
  });
}

/** The whole durable record of a request and the revisions written against it. */
export interface RequestStore {
  create(request: Request): Result<Request>;
  read(projectId: ProjectId, requestId: RequestId): Result<Request>;
  listForProject(projectId: ProjectId): Result<readonly Request[]>;
  update(request: Request, expectedUpdatedAt: string): Result<Request>;
}

export class RequestRepository implements RequestStore {
  private readonly db: Database;
  private readonly prepared = new Map<string, ReturnType<Database['prepare']>>();

  constructor(db: Database) {
    this.db = db;
  }

  private statement(sql: string): ReturnType<Database['prepare']> {
    const cached = this.prepared.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.db.prepare(sql);
    this.prepared.set(sql, prepared);
    return prepared;
  }

  /**
   * Converts a driver or row fault into a typed rejection.
   *
   * An expected refusal is returned as a value, so it reaches the caller with the next
   * step its own code describes; only something genuinely broken becomes `Unavailable`.
   */
  private attempt<T>(description: string, body: () => Result<T>): Result<T> {
    try {
      return body();
    } catch (error) {
      return err({ code: 'Unavailable', reason: `${description} failed: ${describeError(error)}` });
    }
  }

  /**
   * The row for this project only.
   *
   * The project is part of the key, not a check afterwards, so a request belonging to
   * another project is invisible here rather than merely refused. That is what keeps a
   * cross-project identifier from becoming a read of this project's data (F02-AC2).
   */
  private rowOf(projectId: ProjectId, requestId: RequestId): Result<SqlRow> {
    const row = this.statement(
      `SELECT ${REQUEST_COLUMNS} FROM requests WHERE request_id = ? AND project_id = ?`,
    ).get(requestId, projectId);
    if (row === undefined) {
      return err(notFound(`Request ${requestId} in project ${projectId}`, requestId));
    }
    return ok(row);
  }

  /**
   * Writes a request the domain has already accepted.
   *
   * The identifier comes from the caller, so a retry after a lost response addresses the
   * same request rather than creating a second one - the same reason `ProjectRepository.create`
   * is idempotent by identity (F02-AC2, mvp-spec 7: stable operation identity).
   */
  create(request: Request): Result<Request> {
    return this.attempt('create request', () => {
      const existing = this.statement(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE request_id = ?`).get(request.requestId);
      if (existing !== undefined) {
        // A different project claiming this identity is a collision, not an idempotent
        // repeat: silently returning the other project's row would be the cross-project
        // read this class refuses everywhere else.
        if (requiredText(existing, 'project_id') !== request.projectId) {
          return err(notFound(`Request ${request.requestId} in project ${request.projectId}`, request.requestId));
        }
        return ok(toRequest(existing));
      }
      this.statement(
        `INSERT INTO requests (${REQUEST_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        request.requestId,
        request.projectId,
        request.title,
        request.description,
        request.sourceIdeaId,
        request.createdAt,
        request.updatedAt,
      );
      return ok(request);
    });
  }

  read(projectId: ProjectId, requestId: RequestId): Result<Request> {
    return this.attempt('read request', () => {
      const row = this.rowOf(projectId, requestId);
      if (!row.ok) return row;
      return ok(toRequest(row.value));
    });
  }

  /**
   * The requests of one project, newest first.
   *
   * Ties are broken by identity so two requests captured in the same millisecond keep a
   * stable order across reads rather than swapping places on every call (N04-AC2).
   */
  listForProject(projectId: ProjectId): Result<readonly Request[]> {
    return this.attempt('list project requests', () =>
      ok(
        this.statement(
          `SELECT ${REQUEST_COLUMNS} FROM requests WHERE project_id = ? ORDER BY created_at DESC, request_id ASC`,
        )
          .all(projectId)
          .map(toRequest),
      ),
    );
  }

  /**
   * Writes an edited draft, but only if the store still holds what the caller read.
   *
   * `expectedUpdatedAt` is the caller's loaded value and goes into the WHERE clause
   * rather than being re-read here. Re-reading it inside the transaction would make the
   * check vacuous - the row would always match itself - and two tabs editing one draft
   * would both report success against a record one of them has already replaced
   * (mvp-spec 7, "Reject stale requests").
   */
  update(request: Request, expectedUpdatedAt: string): Result<Request> {
    return this.attempt('update request', () =>
      withTransaction(this.db, () => {
        const row = this.rowOf(request.projectId, request.requestId);
        if (!row.ok) return row;
        const stored = requiredText(row.value, 'updated_at');
        if (stored !== expectedUpdatedAt) {
          return err({
            code: 'Conflict',
            reason: 'The request changed after it was loaded. Reload it before saving again.',
            expected: expectedUpdatedAt,
            actual: stored,
          });
        }
        this.statement(
          'UPDATE requests SET title = ?, description = ?, updated_at = ? WHERE request_id = ? AND project_id = ? AND updated_at = ?',
        ).run(request.title, request.description, request.updatedAt, request.requestId, request.projectId, expectedUpdatedAt);
        return ok(request);
      }),
    );
  }
}

/**
 * What an approval must still find in the row for the write to be applied.
 *
 * `updatedAt` is the store's own concurrency token for a draft edit, and it is kept
 * because a tab that edited the revision moves it. `contentFingerprint` is the owner's
 * reviewed text, and it is the one that decides whether an approval is answering the
 * question its owner asked. They are separate fields rather than one token because they
 * answer different questions: an owner who never reloaded still holds the fingerprint
 * they read, and an edit made in the same millisecond as the previous one leaves
 * `updatedAt` unchanged while the fingerprint has certainly moved.
 */
export interface ApprovalExpectation {
  readonly updatedAt: string;
  readonly contentFingerprint: Fingerprint;
}

/** The whole durable record of delivery contract revisions. */
export interface ContractStore {
  createDraft(contract: DeliveryContract): Result<DeliveryContract>;
  read(projectId: ProjectId, contractId: ContractId, revision: number): Result<DeliveryContract>;
  listForRequest(projectId: ProjectId, requestId: RequestId): Result<readonly DeliveryContract[]>;
  currentApproved(projectId: ProjectId, requestId: RequestId): Result<DeliveryContract | null>;
  latest(projectId: ProjectId, requestId: RequestId): Result<DeliveryContract | null>;
  editDraft(contract: DeliveryContract, expectedUpdatedAt: string): Result<DeliveryContract>;
  approve(contract: DeliveryContract, expected: ApprovalExpectation): Result<DeliveryContract>;
  markStale(contract: DeliveryContract, expectedUpdatedAt: string): Result<DeliveryContract>;
  /** Writes a new revision and supersedes the approval it replaces, in one transaction. */
  revise(input: {
    readonly draft: DeliveryContract;
    readonly superseded: DeliveryContract | null;
  }): Result<DeliveryContract>;
}

/**
 * Delivery contract revisions (mvp-spec 3).
 *
 * Three properties are enforced here rather than left to the caller:
 *
 *   - **Project is part of every key.** Reads and writes address `(project_id, ...)`, so
 *     an identifier from another project is a `NotFound` rather than a read.
 *   - **The stored fingerprint is re-derived on write.** `insert` recomputes
 *     `contractContentFingerprint` from the text it is about to store and writes that,
 *     not the caller's value. A caller that stored a fingerprint of different text would
 *     otherwise produce a revision whose identity does not describe it, and every later
 *     "did this change?" comparison would be answering about the wrong thing.
 *   - **Approving is a distinct statement from editing, and it names the text.** `approve`
 *     writes the status and the approval together, so there is no intermediate row that
 *     claims an approval it does not have, and its WHERE clause names the fingerprint the
 *     owner reviewed as well as the status and the instant - so the statement that seals an
 *     agreement is the same statement that refuses to seal one nobody read (mvp-spec 3).
 */
export class ContractRepository implements ContractStore {
  private readonly db: Database;
  private readonly prepared = new Map<string, ReturnType<Database['prepare']>>();

  constructor(db: Database) {
    this.db = db;
  }

  private statement(sql: string): ReturnType<Database['prepare']> {
    const cached = this.prepared.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.db.prepare(sql);
    this.prepared.set(sql, prepared);
    return prepared;
  }

  private attempt<T>(description: string, body: () => Result<T>): Result<T> {
    try {
      return body();
    } catch (error) {
      return err({ code: 'Unavailable', reason: `${description} failed: ${describeError(error)}` });
    }
  }

  private rowOf(projectId: ProjectId, contractId: ContractId, revision: number): Result<SqlRow> {
    const row = this.statement(
      `SELECT ${CONTRACT_COLUMNS} FROM delivery_contracts WHERE contract_id = ? AND revision = ? AND project_id = ?`,
    ).get(contractId, revision, projectId);
    if (row === undefined) {
      return err(notFound(`Delivery contract revision ${contractId}#${revision} in project ${projectId}`, `${contractId}#${revision}`));
    }
    return ok(row);
  }

  /**
   * The stored row for a contract the domain has already transitioned.
   *
   * The compare-and-set on `status` and `updated_at` is what stops two writers from both
   * acting on the same draft: the second finds the row no longer in the state it read, and
   * is refused with the state it actually found (mvp-spec 7, "Reject stale requests").
   *
   * `guard` names the caller's own transition condition - the approval's reviewed-text
   * fingerprint - so it can be read back off the row before the write and quoted in the
   * refusal. The condition itself belongs in the caller's `sql`, because a check performed
   * before the statement is a check performed before it and another writer can commit in
   * between; naming it in the statement means SQLite decides, so a lost race changes zero
   * rows instead of overwriting. Zero rows is then reported as the conflict it is, naming
   * the row as it now reads.
   */
  private writeTransition(
    contract: DeliveryContract,
    expectedStatus: DeliveryContract['status'],
    expectedUpdatedAt: string,
    sql: string,
    parameters: readonly SqlInputValue[],
    guard?: {
      /** What the refusal says the caller asked for. */
      readonly expected: string;
      /** The same fact read off a row, so the refusal names what it found instead. */
      readonly actual: (row: SqlRow) => string;
    },
  ): Result<DeliveryContract> {
    return this.attempt('write delivery contract revision', () =>
      withTransaction(this.db, () => {
        const row = this.rowOf(contract.projectId, contract.contractId, contract.revision);
        if (!row.ok) return row;
        const actualStatus = requiredText(row.value, 'status');
        const actualUpdatedAt = requiredText(row.value, 'updated_at');
        if (actualStatus !== expectedStatus || actualUpdatedAt !== expectedUpdatedAt) {
          return err({
            code: 'Conflict',
            reason: 'The delivery contract revision changed after it was loaded. Reload it before saving again.',
            expected: `${expectedStatus}@${expectedUpdatedAt}`,
            actual: `${actualStatus}@${actualUpdatedAt}`,
          });
        }
        // Read before the write as well as inside it, so a caller that never got as far as
        // the statement is told what it asked for rather than that it lost a race it never
        // entered.
        if (guard !== undefined && guard.actual(row.value) !== guard.expected) {
          return err({
            code: 'Conflict',
            reason: 'The delivery contract revision is not the text that was reviewed. Read it again before approving it.',
            expected: guard.expected,
            actual: guard.actual(row.value),
          });
        }
        const changes = this.statement(sql).run(...parameters);
        if (Number(changes.changes) === 0) {
          // The statement named the guard, so zero rows means a writer committed between
          // the read above and this statement. Nothing was written, so there is nothing to
          // roll back; the row is read once more so the refusal names the state that won.
          const current = this.rowOf(contract.projectId, contract.contractId, contract.revision);
          return err({
            code: 'Conflict',
            reason:
              'The delivery contract revision changed while it was being written, so the change was not saved. Read it again before saving.',
            expected: guard === undefined ? `${expectedStatus}@${expectedUpdatedAt}` : guard.expected,
            actual: current.ok
              ? guard === undefined
                ? `${requiredText(current.value, 'status')}@${requiredText(current.value, 'updated_at')}`
                : guard.actual(current.value)
              : 'a state this store cannot now read',
          });
        }
        const written = this.rowOf(contract.projectId, contract.contractId, contract.revision);
        if (!written.ok) return written;
        return toContract(written.value);
      }),
    );
  }

  createDraft(contract: DeliveryContract): Result<DeliveryContract> {
    return this.attempt('create delivery contract draft', () => {
      if (contract.status !== 'draft') {
        return err(
          invalid('A new revision is written as a draft.', [
            { path: 'status', message: 'Only a draft revision may be created.' },
          ]),
        );
      }
      const projectExists = this.statement('SELECT 1 AS present FROM projects WHERE project_id = ?').get(contract.projectId);
      if (projectExists === undefined) {
        return err(notFound(`Project ${contract.projectId}`, contract.projectId));
      }
      this.statement(
        `INSERT INTO delivery_contracts (${CONTRACT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
      ).run(
        contract.contractId,
        contract.projectId,
        contract.requestId,
        contract.revision,
        contract.outcome,
        canonicalize(contract.scope),
        canonicalize(contract.outOfScope),
        canonicalize(contract.acceptanceCriteria),
        'draft',
        // Recomputed here rather than taken from the caller: the fingerprint and the text
        // are written in one statement, so they cannot disagree.
        contractContentFingerprint(contract),
        contract.requestFingerprint,
        contract.sourceBriefId,
        contract.sourceBriefVersion,
        // `created_by_owner_id` is NOT NULL and names who wrote this revision, which is a
        // fact about the write rather than about the text.
        contract.createdBy,
        contract.createdAt,
        contract.updatedAt,
      );
      const created = this.rowOf(contract.projectId, contract.contractId, contract.revision);
      if (!created.ok) return created;
      return toContract(created.value);
    });
  }

  read(projectId: ProjectId, contractId: ContractId, revision: number): Result<DeliveryContract> {
    return this.attempt('read delivery contract revision', () => {
      const row = this.rowOf(projectId, contractId, revision);
      if (!row.ok) return row;
      return toContract(row.value);
    });
  }

  /**
   * Every revision of one request, oldest revision first.
   *
   * Oldest first deliberately: a reader wants revision 3 before revision 1, and a
   * newest-first list would make the history read backwards.
   */
  listForRequest(projectId: ProjectId, requestId: RequestId): Result<readonly DeliveryContract[]> {
    return this.attempt('list delivery contract revisions', () => {
      const rows = this.statement(
        `SELECT ${CONTRACT_COLUMNS} FROM delivery_contracts WHERE request_id = ? AND project_id = ? ORDER BY revision ASC`,
      ).all(requestId, projectId);
      const contracts: DeliveryContract[] = [];
      for (const row of rows) {
        const contract = toContract(row);
        if (!contract.ok) return err(contract.error);
        contracts.push(contract.value);
      }
      return ok(contracts);
    });
  }

  /** The one approved revision of a request, or null when none is approved. */
  currentApproved(projectId: ProjectId, requestId: RequestId): Result<DeliveryContract | null> {
    return this.attempt('read the approved delivery contract revision', () => {
      const row = this.statement(
        `SELECT ${CONTRACT_COLUMNS} FROM delivery_contracts WHERE request_id = ? AND project_id = ? AND status = 'approved' ORDER BY revision DESC LIMIT 1`,
      ).get(requestId, projectId);
      if (row === undefined) return ok(null);
      const contract = toContract(row);
      if (!contract.ok) return contract;
      return ok(contract.value);
    });
  }

  /**
   * The newest revision of a request, whatever its status.
   *
   * This is the one a caller wants when it needs "where is this request up to". It reads
   * the same rows as `currentApproved` rather than a second projection of them, so the
   * two cannot disagree about which revisions exist.
   */
  latest(projectId: ProjectId, requestId: RequestId): Result<DeliveryContract | null> {
    return this.attempt('read the latest delivery contract revision', () => {
      const row = this.statement(
        `SELECT ${CONTRACT_COLUMNS} FROM delivery_contracts WHERE request_id = ? AND project_id = ? ORDER BY revision DESC LIMIT 1`,
      ).get(requestId, projectId);
      if (row === undefined) return ok(null);
      const contract = toContract(row);
      if (!contract.ok) return contract;
      return ok(contract.value);
    });
  }

  editDraft(contract: DeliveryContract, expectedUpdatedAt: string): Result<DeliveryContract> {
    if (contract.status !== 'draft') {
      return err(
        invalid(`Revision ${contract.revision} is ${contract.status}, so it cannot be edited.`, [
          { path: 'status', message: 'Only a draft revision may be edited.' },
        ]),
      );
    }
    return this.writeTransition(
      contract,
      'draft',
      expectedUpdatedAt,
      `UPDATE delivery_contracts SET outcome = ?, scope_json = ?, out_of_scope_json = ?, acceptance_criteria_json = ?,
         content_fingerprint = ?, request_fingerprint = ?, updated_at = ?
       WHERE contract_id = ? AND revision = ? AND project_id = ? AND status = 'draft'`,
      [
        contract.outcome,
        canonicalize(contract.scope),
        canonicalize(contract.outOfScope),
        canonicalize(contract.acceptanceCriteria),
        contractContentFingerprint(contract),
        contract.requestFingerprint,
        contract.updatedAt,
        contract.contractId,
        contract.revision,
        contract.projectId,
      ],
    );
  }

  /**
   * Seals an approval, and only over the text its owner said they reviewed.
   *
   * The reviewed fingerprint goes into the WHERE clause rather than being compared in the
   * caller, so the condition SQLite evaluates is the whole of what makes this an approval:
   * the row is still a draft, still at the instant the caller read, and still holding that
   * exact text. An owner approving from a tab that missed an edit gets a `Conflict` naming
   * the fingerprint that is stored now, and the agreement is not written (mvp-spec 3,
   * mvp-spec 7 "Reject stale requests").
   */
  approve(contract: DeliveryContract, expected: ApprovalExpectation): Result<DeliveryContract> {
    if (contract.status !== 'approved') {
      return err(
        invalid(`Revision ${contract.revision} is ${contract.status}, so it cannot be approved.`, [
          { path: 'status', message: 'Only a draft revision may be approved.' },
        ]),
      );
    }
    return this.writeTransition(
      contract,
      'draft',
      expected.updatedAt,
      `UPDATE delivery_contracts SET status = 'approved', approved_by_owner_id = ?, approved_at = ?,
         content_fingerprint = ?, updated_at = ?
       WHERE contract_id = ? AND revision = ? AND project_id = ? AND status = 'draft'
         AND updated_at = ? AND content_fingerprint = ?`,
      [
        contract.approvedBy,
        contract.approvedAt,
        contractContentFingerprint(contract),
        contract.updatedAt,
        contract.contractId,
        contract.revision,
        contract.projectId,
        expected.updatedAt,
        expected.contentFingerprint,
      ],
      {
        expected: expected.contentFingerprint,
        actual: (row) => fingerprintOf(row, 'content_fingerprint'),
      },
    );
  }

  /**
   * Records a revision as stale, superseded or invalidated.
   *
   * The UPDATE names `status` in its WHERE clause, so a second attempt against the same
   * starting state changes nothing and the caller's compare-and-set above reports it as
   * a conflict rather than overwriting the first explanation with a second one.
   */
  markStale(contract: DeliveryContract, expectedUpdatedAt: string): Result<DeliveryContract> {
    if (contract.status !== 'stale') {
      return err(
        invalid(`Revision ${contract.revision} is ${contract.status}, so it is not stale.`, [
          { path: 'status', message: 'Only an approved revision becomes stale.' },
        ]),
      );
    }
    return this.writeTransition(
      contract,
      'approved',
      expectedUpdatedAt,
      `UPDATE delivery_contracts SET status = 'stale', stale_reason = ?, superseded_by_revision = ?, updated_at = ?
       WHERE contract_id = ? AND revision = ? AND project_id = ? AND status = 'approved' AND updated_at = ?`,
      [
        contract.staleReason,
        contract.supersededByRevision,
        contract.updatedAt,
        contract.contractId,
        contract.revision,
        contract.projectId,
        expectedUpdatedAt,
      ],
    );
  }

  /**
   * Writes the next revision and supersedes the approval it replaces.
   *
   * One transaction because the intermediate states are both wrong: a new revision
   * existing while the old approval still reads as current, or an approval retired with
   * no replacement. `superseded === null` is the revise-a-draft case, where there is no
   * approval to retire.
   *
   * The supersession UPDATE is conditional on `status = 'approved'`, so a concurrent
   * approval of the revision being replaced is not silently overwritten - the whole
   * transaction rolls back and the caller retries against what is actually stored.
   */
  revise(input: { readonly draft: DeliveryContract; readonly superseded: DeliveryContract | null }): Result<DeliveryContract> {
    return this.attempt('revise delivery contract', () =>
      withTransaction(this.db, () => {
        const { draft, superseded } = input;
        if (draft.status !== 'draft') {
          return err(
            invalid('A revision is revised by writing a new draft.', [
              { path: 'status', message: 'Only a draft revision may be created by a revision.' },
            ]),
          );
        }
        if (superseded !== null) {
          const current = this.rowOf(draft.projectId, superseded.contractId, superseded.revision);
          if (!current.ok) return current;
          const actualStatus = requiredText(current.value, 'status');
          if (actualStatus !== 'approved') {
            return err({
              code: 'Conflict',
              reason: `Revision ${superseded.revision} is ${actualStatus}, so there is no approval to supersede.`,
              expected: 'approved',
              actual: actualStatus,
            });
          }
        }

        this.statement(
          `INSERT INTO delivery_contracts (${CONTRACT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
        ).run(
          draft.contractId,
          draft.projectId,
          draft.requestId,
          draft.revision,
          draft.outcome,
          canonicalize(draft.scope),
          canonicalize(draft.outOfScope),
          canonicalize(draft.acceptanceCriteria),
          'draft',
          contractContentFingerprint(draft),
          draft.requestFingerprint,
          draft.sourceBriefId,
          draft.sourceBriefVersion,
          draft.createdBy,
          draft.createdAt,
          draft.updatedAt,
        );

        if (superseded !== null) {
          const changes = this.statement(
            `UPDATE delivery_contracts SET status = 'stale', stale_reason = ?, superseded_by_revision = ?, updated_at = ?
             WHERE contract_id = ? AND revision = ? AND project_id = ? AND status = 'approved'`,
          ).run(
            superseded.staleReason,
            superseded.supersededByRevision,
            superseded.updatedAt,
            superseded.contractId,
            superseded.revision,
            superseded.projectId,
          );
          if (Number(changes.changes) === 0) {
            return err({
              code: 'Conflict',
              reason: `Revision ${superseded.revision} changed while the new revision was being written, so the revision was not recorded.`,
              expected: 'approved',
              actual: 'a different state',
            });
          }
        }

        const created = this.rowOf(draft.projectId, draft.contractId, draft.revision);
        if (!created.ok) return created;
        return toContract(created.value);
      }),
    );
  }
}

