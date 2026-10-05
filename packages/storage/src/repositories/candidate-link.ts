/**
 * Durable candidate links for the MVP journey (SHARED.md, "Candidate").
 *
 * This is the storage half of manual GitHub pull-request linking, and it is a log rather
 * than a pointer. Four properties are structural here, because each one is a way a
 * candidate's identity could quietly stop meaning the code it was recorded for.
 *
 * 1. **A row is one exact identity, and it is never edited.** A link is a
 *    `(contract revision, full head SHA)` pair. A refresh that observes a different head
 *    appends a new row with the next `observation_sequence`; it never moves the old one.
 *    `UPDATE` and `DELETE` on this table are aborted by a trigger installed by migration
 *    `mvp_candidate_linking`, so "append a new candidate instead" is enforced by the schema
 *    rather than by this file's discipline. That is what keeps evidence collected for SHA A
 *    readable as evidence *about SHA A* after the candidate has moved on.
 * 2. **"Current" is a single row, not an ordering the reader guesses at.**
 *    `currentForRequest` returns the row with the highest `observation_sequence` for the
 *    request. Timestamps are not used to pick it, because two refreshes inside the same
 *    millisecond would tie, and a tie two readers resolve differently is exactly how an
 *    outdated card comes to look current.
 * 3. **Re-linking the same facts is idempotent; a different observation is visible.**
 *    The `UNIQUE (contract_id, contract_revision, head_sha, base_sha, base_branch,
 *    head_branch, pull_request_state, draft)` constraint means a second attempt at the same
 *    observation returns the row that already exists rather than recording a second belief
 *    about it. A *different* observation is a new row by design, and that includes a pull
 *    request whose head did not move but which was closed, marked draft or retargeted: each
 *    of those changes what the owner would be approving, and a changed candidate has to be a
 *    fact somebody can read rather than a silent overwrite.
 * 4. **No provider call happens here.** This package never reaches GitHub. The row is
 *    written from facts a caller already read, because a transaction that waited on the
 *    network would hold the single global writer open and make a lost response
 *    indistinguishable from a lost write (ARCHITECTURE, "Authority and durable state").
 *
 * The identity fingerprint is computed here from the row's own fields rather than trusted
 * from the caller, so a stored `binding_fingerprint` cannot disagree with the
 * `contract_id`/`contract_revision`/`head_sha` columns it is supposed to summarise.
 *
 * The repository is a separate class rather than an addition to `repositories/core.ts`
 * because it stores a different fact. `candidates` there is tied to a work item, a scope
 * snapshot, a profile version and a procedure version — the run-scoped candidate of the
 * execution slice. This table is the delivery candidate of the MVP journey, which has a
 * request and a contract revision and needs none of the run-scoped parents.
 */

import { PULL_REQUEST_STATES as DOMAIN_PULL_REQUEST_STATES, candidateBindingFingerprint, err, invalid, ok } from '@shiploop/domain';
import type { CandidateId, CommitSha, DomainError, ProjectId, PullRequestState, Result } from '@shiploop/domain';

import type { Database } from '../db.ts';
import { withTransaction } from '../tx.ts';

const COLUMNS = [
  'candidate_id',
  'project_id',
  'request_id',
  'contract_id',
  'contract_revision',
  'observation_sequence',
  'provider',
  'repository',
  'pull_request_number',
  'pull_request_url',
  'base_branch',
  'base_sha',
  'head_branch',
  'head_sha',
  'head_repository',
  'pull_request_state',
  'draft',
  'binding_fingerprint',
  'observed_at',
  'linked_at',
  'correlation_id',
].join(', ');

/**
 * The pull-request states this store accepts, derived from the domain rather than restated.
 *
 * This used to be its own three-item list. That was a third copy of one vocabulary — the domain
 * and the `delivery_candidates` CHECK had already been widened to admit `Unknown`, so an unrecognised
 * provider state was legal everywhere and refused only here, at the last step before storage. The
 * consequence was precise and bad: the adapter reported a state it could not read, the schema had a
 * column for it, and the repository threw it away, so the honest reading never reached a row. A
 * derived list cannot drift from the domain, which is the only thing that should decide the vocabulary.
 */
const PULL_REQUEST_STATES: readonly PullRequestState[] = DOMAIN_PULL_REQUEST_STATES;

/** A candidate row exactly as it is stored and returned. */
export interface DeliveryCandidateRecord {
  readonly candidateId: CandidateId;
  readonly projectId: ProjectId;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  /** 1 for the first candidate recorded for this request, then increasing. */
  readonly observationSequence: number;
  readonly provider: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly baseBranch: string;
  readonly baseSha: CommitSha;
  readonly headBranch: string;
  readonly headSha: CommitSha;
  /** Repository the head branch lives in; a fork's name for a pull request from a fork. */
  readonly headRepository: string | null;
  readonly pullRequestState: PullRequestState;
  readonly draft: boolean;
  readonly bindingFingerprint: string;
  /** When the provider was read for this row. */
  readonly observedAt: string;
  /** When this exact identity was first recorded. */
  readonly linkedAt: string;
  readonly correlationId: string | null;
}

/**
 * One observation that becomes a row.
 *
 * `headSha` and `baseSha` are typed `CommitSha`, so an abbreviation cannot reach this input:
 * the refusal happens at the type boundary before any SQL runs, and the column's CHECK
 * refuses it again for a caller who casts.
 */
export interface RecordDeliveryCandidateInput {
  readonly projectId: ProjectId;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly provider: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly baseBranch: string;
  readonly baseSha: CommitSha;
  readonly headBranch: string;
  readonly headSha: CommitSha;
  readonly headRepository: string | null;
  readonly pullRequestState: PullRequestState;
  readonly draft: boolean;
  readonly observedAt: string;
  readonly correlationId: string | null;
  /** Minted by the controller, which owns candidate identity. */
  readonly candidateId: CandidateId;
}

/** The answer to a record attempt, including whether anything new was written. */
export interface RecordedCandidate {
  readonly candidate: DeliveryCandidateRecord;
  /** True when this exact identity was already stored, so nothing was appended. */
  readonly alreadyRecorded: boolean;
}

/** The persistence port the candidate-linking controller depends on. */
export interface CandidateLinkStore {
  /**
   * Records a candidate, or returns the row that already records these exact facts.
   *
   * Idempotent on the whole material fact set — contract revision, head, base, both branch
   * names, state and draft — rather than on the head alone. `alreadyRecorded` is what lets a
   * caller distinguish "I read the same state of the same commit again" from "the candidate
   * changed", so a retry after a timeout cannot present a re-read as a new candidate while a
   * closed pull request still gets recorded.
   */
  record(input: RecordDeliveryCandidateInput): Result<RecordedCandidate>;
  get(candidateId: CandidateId): Result<DeliveryCandidateRecord>;
  /** The highest-sequence row for a request, or null when it has no candidate yet. */
  currentForRequest(requestId: string): Result<DeliveryCandidateRecord | null>;
  /** Every row for a request, oldest first, so the sequence of heads is readable. */
  historyForRequest(requestId: string): Result<readonly DeliveryCandidateRecord[]>;
  findByBinding(
    contractId: string,
    contractRevision: number,
    headSha: CommitSha,
  ): Result<DeliveryCandidateRecord | null>;
}

export class DeliveryCandidateRepository implements CandidateLinkStore {
  private readonly database: Database;
  private readonly cache = new Map<string, ReturnType<Database['prepare']>>();

  constructor(database: Database) {
    this.database = database;
  }

  private statement(sql: string): ReturnType<Database['prepare']> {
    const cached = this.cache.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.database.prepare(sql);
    this.cache.set(sql, prepared);
    return prepared;
  }

  /**
   * Turns an unexpected driver failure into a typed `Unavailable`.
   *
   * A method returns its own `Result` so an expected refusal (NotFound, Invalid) stays
   * distinguishable from storage being broken — the caller above needs to tell "this
   * candidate is not recorded" from "the database did not answer".
   */
  private attempt<T>(description: string, body: () => Result<T, DomainError>): Result<T, DomainError> {
    try {
      return body();
    } catch (error) {
      return err({
        code: 'Unavailable',
        reason: `${description} failed: ${error instanceof Error ? error.message : 'unknown storage failure'}`,
      });
    }
  }

  record(input: RecordDeliveryCandidateInput): Result<RecordedCandidate> {
    return this.attempt('record the candidate link', () => {
      const refusal = validate(input);
      if (refusal !== null) return err(refusal);

      // The explicit type argument is what lets the two success branches below — the
      // already-recorded one and the newly-appended one — be the same answer type instead
      // of two unrelated literal shapes inferred from the first `return`.
      return withTransaction<Result<RecordedCandidate, DomainError>>(this.database, () => {
        const existing = this.findExisting(input);
        if (existing !== null) return ok({ candidate: existing, alreadyRecorded: true });

        // The next sequence is derived from the rows already present, inside the same
        // BEGIN IMMEDIATE that inserts this one, so two concurrent refreshes cannot both
        // believe they are the current candidate.
        const sequence = this.nextSequence(input.requestId);
        // Computed from the row's own identity fields, never taken from the caller, so the
        // stored fingerprint cannot describe a different commit than the columns beside it.
        const bindingFingerprint = candidateBindingFingerprint({
          contractId: input.contractId,
          contractRevision: input.contractRevision,
          headSha: input.headSha,
        });
        this.statement(
          `INSERT INTO delivery_candidates (${COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.candidateId,
          input.projectId,
          input.requestId,
          input.contractId,
          input.contractRevision,
          sequence,
          input.provider,
          input.repository,
          input.pullRequestNumber,
          input.pullRequestUrl,
          input.baseBranch,
          input.baseSha,
          input.headBranch,
          input.headSha,
          input.headRepository,
          input.pullRequestState,
          input.draft ? 1 : 0,
          bindingFingerprint,
          input.observedAt,
          input.observedAt,
          input.correlationId,
        );
        const created = this.read(input.candidateId);
        if (created === null) {
          return err({
            code: 'Unavailable',
            reason:
              'The candidate link was written and could not be read back, so it is not reported as recorded. Re-read the request before retrying rather than writing a second row.',
          });
        }
        return ok({ candidate: created, alreadyRecorded: false });
      });
    });
  }

  get(candidateId: CandidateId): Result<DeliveryCandidateRecord> {
    return this.attempt('read the candidate link', () => {
      const row = this.read(candidateId);
      if (row === null) {
        return err({ code: 'NotFound', reason: `Candidate ${candidateId} does not exist.` });
      }
      return ok(row);
    });
  }

  currentForRequest(requestId: string): Result<DeliveryCandidateRecord | null> {
    return this.attempt('read the current candidate', () =>
      ok(
        this.rowOf(
          this.statement(
            `SELECT ${COLUMNS} FROM delivery_candidates WHERE request_id = ? ORDER BY observation_sequence DESC LIMIT 1`,
          ).get(requestId),
        ),
      ),
    );
  }

  historyForRequest(requestId: string): Result<readonly DeliveryCandidateRecord[]> {
    return this.attempt('read the candidate history', () =>
      ok(
        this.statement(
          `SELECT ${COLUMNS} FROM delivery_candidates WHERE request_id = ? ORDER BY observation_sequence ASC`,
        )
          .all(requestId)
          .map(toRecord),
      ),
    );
  }

  findByBinding(
    contractId: string,
    contractRevision: number,
    headSha: CommitSha,
  ): Result<DeliveryCandidateRecord | null> {
    return this.attempt('read the candidate by binding', () =>
      ok(
        this.rowOf(
          this.statement(
            `SELECT ${COLUMNS} FROM delivery_candidates
             WHERE contract_id = ? AND contract_revision = ? AND head_sha = ? LIMIT 1`,
          ).get(contractId, contractRevision, headSha),
        ),
      ),
    );
  }

  private read(candidateId: CandidateId): DeliveryCandidateRecord | null {
    return this.rowOf(
      this.statement(`SELECT ${COLUMNS} FROM delivery_candidates WHERE candidate_id = ?`).get(candidateId),
    );
  }

  private rowOf(row: Record<string, unknown> | undefined): DeliveryCandidateRecord | null {
    return row === undefined ? null : toRecord(row);
  }

  /**
   * The row already recording these exact facts, if there is one.
   *
   * Matches the schema's uniqueness tuple rather than the identity alone, because a pull
   * request can change without its head moving: a closed pull request, a draft flag and a
   * retargeted base all have to become a new row. Keying on the identity alone would make
   * those observations impossible to record, which is how a closed pull request would keep
   * reporting as the candidate that was linked when it was open.
   */
  private findExisting(input: RecordDeliveryCandidateInput): DeliveryCandidateRecord | null {
    return this.rowOf(
      this.statement(
        `SELECT ${COLUMNS} FROM delivery_candidates
         WHERE contract_id = ? AND contract_revision = ? AND head_sha = ? AND base_sha = ?
           AND base_branch = ? AND head_branch = ? AND pull_request_state = ? AND draft = ?
         LIMIT 1`,
      ).get(
        input.contractId,
        input.contractRevision,
        input.headSha,
        input.baseSha,
        input.baseBranch,
        input.headBranch,
        input.pullRequestState,
        input.draft ? 1 : 0,
      ),
    );
  }

  /**
   * The next observation sequence for a request.
   *
   * `MAX` rather than `COUNT`, so a row that could not be written for an unrelated reason
   * never leaves a gap the sequence would then skip; `COALESCE` so the first candidate for a
   * request is sequence 1 rather than 0, which the column's `> 0` check refuses.
   */
  private nextSequence(requestId: string): number {
    const row = this.statement(
      'SELECT COALESCE(MAX(observation_sequence), 0) AS highest FROM delivery_candidates WHERE request_id = ?',
    ).get(requestId);
    const highest = row?.['highest'];
    const numeric = typeof highest === 'bigint' ? Number(highest) : highest;
    if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric) || numeric < 0) {
      throw new Error('the observation sequence could not be read as an integer');
    }
    return numeric + 1;
  }
}

/**
 * Refuses an input that could not produce a candidate.
 *
 * The commit SHAs are already `CommitSha` by type, so what is checked here are the fields a
 * string can get wrong: an empty identity, a revision that is not positive, a pull request
 * number that is not positive, a provider the MVP does not support, and a state outside the
 * three GitHub reports. Each refusal carries the field path an owner needs rather than
 * producing a row that reads as a candidate.
 */
function validate(input: RecordDeliveryCandidateInput): DomainError | null {
  const fields: { path: string; message: string }[] = [];
  if (input.requestId.trim().length === 0) {
    fields.push({ path: 'requestId', message: 'A candidate belongs to a request; an empty id is not one.' });
  }
  if (input.contractId.trim().length === 0) {
    fields.push({ path: 'contractId', message: 'A candidate is bound to the contract revision it implements.' });
  }
  if (!Number.isSafeInteger(input.contractRevision) || input.contractRevision < 1) {
    fields.push({ path: 'contractRevision', message: 'Contract revisions start at 1.' });
  }
  if (input.provider !== 'github') {
    fields.push({
      path: 'provider',
      message: `"${input.provider}" is not a provider this MVP links candidates from.`,
    });
  }
  if (input.repository.trim().length === 0) {
    fields.push({ path: 'repository', message: 'A candidate must name the repository its code lives in.' });
  }
  if (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1) {
    fields.push({ path: 'pullRequestNumber', message: 'GitHub pull request numbers start at 1.' });
  }
  if (!PULL_REQUEST_STATES.includes(input.pullRequestState)) {
    fields.push({
      path: 'pullRequestState',
      message: `"${input.pullRequestState}" is not a pull request state the product has a vocabulary for.`,
    });
  }
  if (input.observedAt.trim().length === 0) {
    fields.push({ path: 'observedAt', message: 'A candidate records when the provider was read.' });
  }
  if (fields.length > 0) {
    return invalid('This candidate cannot be recorded as it stands.', fields);
  }
  return null;
}

function toRecord(row: Record<string, unknown>): DeliveryCandidateRecord {
  return {
    candidateId: text(row, 'candidate_id') as CandidateId,
    projectId: text(row, 'project_id') as ProjectId,
    requestId: text(row, 'request_id'),
    contractId: text(row, 'contract_id'),
    contractRevision: integer(row, 'contract_revision'),
    observationSequence: integer(row, 'observation_sequence'),
    provider: text(row, 'provider'),
    repository: text(row, 'repository'),
    pullRequestNumber: integer(row, 'pull_request_number'),
    pullRequestUrl: text(row, 'pull_request_url'),
    baseBranch: text(row, 'base_branch'),
    baseSha: text(row, 'base_sha') as CommitSha,
    headBranch: text(row, 'head_branch'),
    headSha: text(row, 'head_sha') as CommitSha,
    headRepository: nullableText(row, 'head_repository'),
    pullRequestState: text(row, 'pull_request_state') as PullRequestState,
    draft: integer(row, 'draft') === 1,
    bindingFingerprint: text(row, 'binding_fingerprint'),
    observedAt: text(row, 'observed_at'),
    linkedAt: text(row, 'linked_at'),
    correlationId: nullableText(row, 'correlation_id'),
  };
}

function text(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`column ${column} is missing or not text`);
  return value;
}

function nullableText(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

function integer(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`column ${column} is missing or not an integer`);
}
