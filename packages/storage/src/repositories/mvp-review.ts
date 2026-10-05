import { recordMvpEvidence, recordMvpOwnerDecision } from '@shiploop/domain';
import type {
  CommitSha,
  CriterionVerificationMethod,
  DomainError,
  MvpDecisionKind,
  MvpEvidenceObservation,
  MvpEvidenceOutcome,
  MvpEvidenceSource,
  MvpEvidenceSubject,
  MvpOwnerActor,
  MvpOwnerDecision,
  MvpRecordedEvidence,
  Result,
} from '@shiploop/domain';
import { err, ok } from '@shiploop/domain';
import type { SqlRow, StorageConnection, StorageStatementChanges, StorageTransactions } from './types.ts';

/**
 * Durable storage for the MVP review path (F20-AC3, F23-AC3, F25-AC1, F25-AC3).
 *
 * Everything here is a thin persistence layer over the domain, and the direction of
 * dependency is the point. A write does not validate: the caller must hand in a value
 * that `recordMvpEvidence` or `recordMvpOwnerDecision` already produced, and this module
 * only serialises it. A read does validate: each stored row is rebuilt by calling the
 * same domain constructor, so a row this build cannot reconstruct into a legal
 * `MvpRecordedEvidence` or `MvpOwnerDecision` is reported as an error rather than
 * quietly dropped. Silently dropping it would remove evidence the owner was already
 * shown on a card.
 *
 * The owner identity for an owner-test row is the one the caller supplies, and the
 * schema requires it whenever the source is `owner_test`. That is what makes an owner
 * test attributable after a restart (F25-AC1, F25-AC4): the row carries the identity of
 * the owner who ran it, not merely the fact that somebody did.
 *
 * Both tables are append-only (migration 13 installs the triggers), so a re-run writes a
 * new row and the projection reads the newest *applicable* one. A correction therefore
 * supersedes rather than overwrites a recorded observation, and a repeated write converges
 * on the same end state instead of accumulating duplicates.
 */

/** The owner identity a write is attributed to, when the row records one. */
export interface MvpEvidenceActor {
  /** Required for an `owner_test` row, absent otherwise. */
  readonly owner: MvpOwnerActor | null;
}

export interface RecordMvpReviewEvidenceInput extends MvpEvidenceActor {
  /** A value the domain's `recordMvpEvidence` already accepted. */
  readonly evidence: MvpRecordedEvidence;
  readonly projectId: string;
  readonly requestId: string;
  /** The candidate under review, so the row is bound to the exact commit being offered. */
  readonly candidateId: string;
  readonly candidateHeadSha: CommitSha;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly recordedAt: string;
  readonly correlationId: string;
}

export interface RecordMvpDecisionRowInput {
  /** A value the domain's `recordMvpOwnerDecision` already accepted. */
  readonly decision: MvpOwnerDecision;
  readonly correlationId: string;
}

/** Everything the read model needs for one candidate at one contract revision. */
export interface MvpReviewProjection {
  readonly evidence: readonly MvpRecordedEvidence[];
  readonly decisions: readonly MvpOwnerDecision[];
}

export interface MvpReviewStore {
  recordEvidence(input: RecordMvpReviewEvidenceInput): Result<{ readonly evidenceId: string }>;
  recordDecision(input: RecordMvpDecisionRowInput): Result<{ readonly decisionId: string }>;
  readProjection(input: {
    readonly candidateId: string;
    readonly candidateHeadSha: CommitSha;
    readonly contractId: string;
    readonly contractRevision: number;
  }): Result<MvpReviewProjection>;
}

const EVIDENCE_COLUMNS = `evidence_id, project_id, request_id, contract_id, contract_revision, candidate_id,
  candidate_head_sha, subject_kind, subject_id, method_kind, method_detail, source, outcome,
  observed_head_sha, observed_contract_revision, observed_at, detail_redacted, artifact_ref, owner_id`;

const DECISION_COLUMNS = `decision_id, project_id, request_id, contract_id, contract_revision, candidate_id,
  candidate_head_sha, kind, owner_id, decided_at, feedback_redacted`;

const OUTCOMES: readonly MvpEvidenceOutcome[] = ['passed', 'failed', 'waiting', 'missing', 'capture_failed'];
const SOURCES: readonly MvpEvidenceSource[] = ['project_command', 'github_check', 'browser', 'owner_test'];
const DECISION_KINDS: readonly MvpDecisionKind[] = ['accepted', 'changes_requested'];
const METHOD_KINDS: readonly CriterionVerificationMethod['kind'][] = [
  'AutomatedCheck',
  'OwnerTest',
  'BrowserEvidence',
  'ApiEvidence',
];

/** The one string each method kind carries, reduced to a storable detail column. */
function methodDetailOf(method: CriterionVerificationMethod): string | null {
  switch (method.kind) {
    case 'AutomatedCheck':
      return method.checkId;
    case 'BrowserEvidence':
    case 'ApiEvidence':
      return method.evidenceId;
    case 'OwnerTest':
      return method.instructions;
    case 'Untested':
      return null;
  }
}

/** The observation vocabulary a source's results arrive in. */
function observationKindFor(source: MvpEvidenceSource): 'command' | 'provider_check' | 'browser' {
  switch (source) {
    case 'project_command':
      return 'command';
    case 'github_check':
      return 'provider_check';
    case 'browser':
      return 'browser';
    case 'owner_test':
      // Unreachable: an owner test always takes the owner branch below.
      return 'command';
  }
}

/**
 * The observation a stored row reconstructs.
 *
 * Rebuilt from the durable columns rather than read back from a verdict string, so a
 * reader can never see an outcome the source did not report. An owner-test row keeps its
 * `capture_failed` outcome across the round trip; an automated row has no such outcome,
 * so one stored there degrades to `missing` rather than becoming a fabricated failure.
 */
function observationOf(row: SqlRow, source: MvpEvidenceSource): MvpEvidenceObservation {
  const outcome = oneOf(requiredText(row, 'outcome'), OUTCOMES, 'outcome');
  if (source === 'owner_test') {
    const ownerId = requiredText(row, 'owner_id') as MvpOwnerActor['ownerId'];
    const ownerOutcome = outcome === 'capture_failed' ? 'capture_failed' : outcome === 'failed' ? 'failed' : 'passed';
    return { kind: 'owner_test', outcome: ownerOutcome, actor: { role: 'owner', ownerId } };
  }
  return { kind: observationKindFor(source), outcome: outcome === 'capture_failed' ? 'missing' : outcome };
}

function methodOf(row: SqlRow): CriterionVerificationMethod {
  const kind = oneOf(requiredText(row, 'method_kind'), METHOD_KINDS, 'method_kind');
  const detail = nullableText(row, 'method_detail') ?? '';
  switch (kind) {
    case 'AutomatedCheck':
      return { kind: 'AutomatedCheck', checkId: detail };
    case 'BrowserEvidence':
      return { kind: 'BrowserEvidence', evidenceId: detail };
    case 'ApiEvidence':
      return { kind: 'ApiEvidence', evidenceId: detail };
    case 'OwnerTest':
      return { kind: 'OwnerTest', instructions: detail };
    default:
      // `Untested` is the absence of a method, and a stored row names one. The domain
      // refuses it as a method, so reaching here means the column is corrupt.
      throw new Error(`method_kind holds "${kind}", which names no stored verification method`);
  }
}

function subjectOf(row: SqlRow): MvpEvidenceSubject {
  const id = requiredText(row, 'subject_id');
  return requiredText(row, 'subject_kind') === 'criterion'
    ? { kind: 'criterion', criterionId: id }
    : { kind: 'check', checkId: id };
}

function requiredText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`column ${column} is missing or not text`);
  return value;
}

function nullableText(row: SqlRow, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' && value !== '' ? value : null;
}

function nullableInteger(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`column ${column} is neither a number nor absent`);
}

function requiredInteger(row: SqlRow, column: string): number {
  const value = nullableInteger(row, column);
  if (value === null) throw new Error(`column ${column} is null, which the schema forbids here`);
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], column: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`column ${column} holds "${value}", which is not a value this code recognises`);
  }
  return value as T;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown storage failure';
}

/**
 * The SQLite store for the MVP review path.
 *
 * Multi-statement methods run inside the injected transaction runner, which `tx.ts`
 * owns; this module never issues its own `BEGIN`, so nesting stays safe and a caller
 * already inside a transaction does not get a second one.
 */
export class SqliteMvpReviewStore implements MvpReviewStore {
  private readonly connection: StorageConnection;
  private readonly transactions: StorageTransactions | undefined;

  constructor(connection: StorageConnection, transactions?: StorageTransactions) {
    this.connection = connection;
    this.transactions = transactions;
  }

  recordEvidence(input: RecordMvpReviewEvidenceInput): Result<{ readonly evidenceId: string }> {
    return this.bounded('record MVP review evidence', () => {
      const evidence = input.evidence;
      if (evidence.source === 'owner_test' && input.owner === null) {
        return err({
          code: 'Invalid',
          reason: 'An owner test row must record the authenticated owner who ran it; without that identity the observation is unattributable (F25-AC1).',
          fields: [{ path: 'owner', message: 'Required for an owner_test evidence row.' }],
        });
      }

      // `Untested` is the *absence* of a method, and this table has no column for an absence:
      // `method_kind` is constrained to the four named methods and `method_detail` carries the
      // one string each of them names. Relabelling it as `AutomatedCheck` on the way in would
      // store a row claiming a check identity of the empty string — a verdict no projection can
      // ever match, written as though it were the observation that was made. So it is refused
      // here, where the caller can be told, instead of being quietly rewritten on the way to disk.
      //
      // No shipped path records one, and it is refused anyway because this module's stated
      // contract is that it serialises what the domain produced rather than editing it: a silent
      // edit is the one thing a persistence layer must not do to a value it does not own (F23-AC1).
      if (evidence.method.kind === 'Untested') {
        return err({
          code: 'Invalid',
          reason:
            'An observation with no assigned verification method is not evidence of anything and cannot be stored: a stored row must name the method that observed it (F23-AC1).',
          fields: [
            {
              path: 'method',
              message:
                'Name the verification method that made this observation. A criterion with none is reported Untested by the projection; it is not stored as an observation.',
            },
          ],
        });
      }

      const recorded = this.insertEvidence(input);
      if (!recorded.ok) return err(recorded.error);
      return ok({ evidenceId: recorded.value.evidenceId });
    });
  }

  private insertEvidence(input: RecordMvpReviewEvidenceInput): Result<{ readonly evidenceId: string }> {
    const evidence = input.evidence;
    const written: StorageStatementChanges = this.connection
      .prepare(
        `INSERT INTO mvp_review_evidence (${EVIDENCE_COLUMNS}, recorded_at, correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (evidence_id) DO NOTHING`,
      )
      .run(
        evidence.evidenceId,
        input.projectId,
        input.requestId,
        input.contractId,
        input.contractRevision,
        input.candidateId,
        input.candidateHeadSha,
        evidence.subject.kind,
        evidence.subject.kind === 'criterion' ? evidence.subject.criterionId : evidence.subject.checkId,
        evidence.method.kind,
        methodDetailOf(evidence.method),
        evidence.source,
        evidence.outcome,
        evidence.observedHeadSha,
        evidence.observedContractRevision,
        evidence.observedAt,
        evidence.detail,
        evidence.artifactRef,
        input.owner === null ? null : input.owner.ownerId,
        input.recordedAt,
        input.correlationId,
      );
    void written;
    return ok({ evidenceId: evidence.evidenceId });
  }

  recordDecision(input: RecordMvpDecisionRowInput): Result<{ readonly decisionId: string }> {
    return this.bounded('record MVP owner decision', () => {
      const decision = input.decision;
      this.connection
        .prepare(
          `INSERT INTO mvp_owner_decisions (${DECISION_COLUMNS}, correlation_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (decision_id) DO NOTHING`,
        )
        .run(
          decision.decisionId,
          decision.projectId,
          decision.requestId,
          decision.contractId,
          decision.contractRevision,
          decision.candidateId,
          decision.candidateHeadSha,
          decision.kind,
          decision.ownerId,
          decision.decidedAt,
          decision.feedback,
          input.correlationId,
        );
      return ok({ decisionId: decision.decisionId });
    });
  }

  /**
   * Reads everything the review projection needs for one candidate.
   *
   * Rows for *any* candidate are not filtered out here. An older SHA's evidence is
   * returned deliberately so the projection can mark it stale by comparison rather than
   * by absence, and an owner looking at a pushed commit needs to see that the previous
   * run exists and no longer counts. Only the contract revision is filtered, because a
   * different revision is a different agreement and is not this review's business.
   */
  readProjection(input: {
    readonly candidateId: string;
    readonly candidateHeadSha: CommitSha;
    readonly contractId: string;
    readonly contractRevision: number;
  }): Result<MvpReviewProjection> {
    return this.bounded('read MVP review projection', () => {
      const evidenceRows = this.connection
        .prepare(
          `SELECT ${EVIDENCE_COLUMNS} FROM mvp_review_evidence
             WHERE candidate_id = ? AND contract_id = ? AND contract_revision = ?
             ORDER BY observed_at DESC, evidence_id DESC`,
        )
        .all(input.candidateId, input.contractId, input.contractRevision);

      const decisionRows = this.connection
        .prepare(
          `SELECT ${DECISION_COLUMNS} FROM mvp_owner_decisions
             WHERE candidate_id = ? AND contract_id = ? AND contract_revision = ?
             ORDER BY decided_at DESC, decision_id DESC`,
        )
        .all(input.candidateId, input.contractId, input.contractRevision);

      const evidence: MvpRecordedEvidence[] = [];
      for (const row of evidenceRows) {
        const source = oneOf(requiredText(row, 'source'), SOURCES, 'source');
        const rebuilt = recordMvpEvidence({
          evidenceId: requiredText(row, 'evidence_id'),
          contractId: requiredText(row, 'contract_id'),
          candidateId: requiredText(row, 'candidate_id'),
          subject: subjectOf(row),
          method: methodOf(row),
          observation: observationOf(row, source),
          observedHeadSha: nullableText(row, 'observed_head_sha'),
          observedContractRevision: nullableInteger(row, 'observed_contract_revision'),
          observedAt: nullableText(row, 'observed_at'),
          detail: nullableText(row, 'detail_redacted'),
          artifactRef: nullableText(row, 'artifact_ref'),
        });
        if (!rebuilt.ok) {
          return err({
            code: 'Unavailable',
            reason: `Evidence ${requiredText(row, 'evidence_id')} cannot be reconstructed as a legal MVP result, so the review projection would be incomplete: ${rebuilt.error.reason}`,
          });
        }
        evidence.push(rebuilt.value);
      }

      const decisions: MvpOwnerDecision[] = [];
      for (const row of decisionRows) {
        const ownerId = requiredText(row, 'owner_id');
        const decision = recordMvpOwnerDecision({
          decisionId: requiredText(row, 'decision_id'),
          kind: oneOf(requiredText(row, 'kind'), DECISION_KINDS, 'kind'),
          actor: { role: 'owner', ownerId: ownerId as never },
          projectId: requiredText(row, 'project_id'),
          requestId: requiredText(row, 'request_id'),
          contractId: requiredText(row, 'contract_id'),
          contractRevision: requiredInteger(row, 'contract_revision'),
          candidateId: requiredText(row, 'candidate_id'),
          candidateHeadSha: requiredText(row, 'candidate_head_sha'),
          decidedAt: requiredText(row, 'decided_at'),
          feedback: nullableText(row, 'feedback_redacted'),
        });
        if (!decision.ok) {
          return err({
            code: 'Unavailable',
            reason: `Decision ${requiredText(row, 'decision_id')} cannot be reconstructed as a legal MVP decision, so the review projection would be incomplete: ${decision.error.reason}`,
          });
        }
        decisions.push(decision.value);
      }

      return ok({ evidence, decisions });
    });
  }

  private bounded<T>(description: string, body: () => Result<T, DomainError>): Result<T, DomainError> {
    try {
      return this.transactions !== undefined
        ? this.transactions.transaction(body)
        : runLocalTransaction(this.connection, body);
    } catch (error) {
      return err({ code: 'Unavailable', reason: `${description} failed: ${detail(error)}` });
    }
  }
}

/**
 * BEGIN/COMMIT for a store constructed without the shared runner.
 *
 * Deliberately the same shape as the rest of the repositories: a caller that supplies
 * `transactions` gets nesting-safe behaviour from `tx.ts`, and a caller that does not
 * still gets an atomic single-file store.
 */
function runLocalTransaction<T>(
  connection: StorageConnection,
  body: () => Result<T, DomainError>,
): Result<T, DomainError> {
  connection.exec('BEGIN IMMEDIATE');
  try {
    const value = body();
    connection.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      connection.exec('ROLLBACK');
    } catch {
      // A rollback failure must not mask the original error.
    }
    throw error;
  }
}