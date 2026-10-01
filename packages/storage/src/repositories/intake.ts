/**
 * Durable intake: ideas, brief versions and the owner conversation (F06, F07).
 *
 * The domain in `packages/domain/src/intake` decides what an idea may become;
 * this file makes those decisions survive a restart. It adds no policy of its
 * own: every write routes through the domain function that owns the rule, and
 * this module persists only the result. There is no SQL here that decides
 * something, only SQL that records a decision already made.
 *
 * Every property that matters here is structural - in the schema and not only in
 * this code - and each one names the trigger that holds it:
 *
 *   - the raw request is the owner's own words and no write can replace it
 *     (F06-AC1). `ideas_raw_request_immutable_update` refuses the UPDATE, so a
 *     generated summary cannot overwrite the request even if a future caller
 *     tries, and no statement below names the column after capture;
 *   - a generated summary lives in its own columns and carries the fingerprint of
 *     the exact raw text it was derived from (F06-AC1). The
 *     `ideas_summary_provenance_*` triggers refuse a summary that records only
 *     part of that provenance;
 *   - a brief version's content is immutable and versions are append-only
 *     (F07-AC3). A correction adds the next version, `briefs_version_immutable_update`
 *     refuses to edit one, and `briefs_append_only_delete` refuses to remove one;
 *   - conversation turns are appended, never edited or removed (F07-AC3), which
 *     `idea_messages_append_only_*` enforce;
 *   - an idea that produced work cannot be archived (F06-AC5), which
 *     `ideas_with_produced_work_are_not_archived` decides by reading the
 *     produced-work rows rather than a flag.
 *
 * A row this package cannot interpret is reported as `Unavailable` rather than
 * thrown, because a corrupt row is a storage fault and not a refusal the owner
 * asked for. Every expected refusal - a name that would escape the artifact
 * root, an idea that already produced work - is a value.
 */

import { randomUUID } from 'node:crypto';
import {
  appendAttachment as domainAppendAttachment,
  applyCorrection as domainApplyCorrection,
  archiveIdea as domainArchiveIdea,
  agreeBrief as domainAgreeBrief,
  canonicalize,
  deferIdea as domainDeferIdea,
  draftBrief as domainDraftBrief,
  fingerprint,
  invalid,
  recordProducedWork as domainRecordProducedWork,
  redactDeep,
  stripSecretFields,
  summarizeDraft as domainSummarizeDraft,
} from '@shiploop/domain';
import type {
  AttachmentMediaType,
  Brief,
  BriefSections,
  ClarificationConversation,
  ClarifyingQuestion,
  ConversationTurn,
  DomainError,
  Fingerprint,
  IdeaAttachment,
  IdeaDraft,
  IdeaId,
  IdeaRequest,
  ProjectId,
  Result,
  ShipLoopId,
  ValidatedBriefProposal,
} from '@shiploop/domain';
import type { Database } from '../db.ts';
import { withTransaction } from '../tx.ts';

/** A read-only projection of one `ideas` row, including the version 9 columns. */
interface IdeaRow {
  readonly ideaId: IdeaId;
  readonly projectId: ProjectId | null;
  readonly kind: 'FeatureRequest' | 'Bug';
  readonly rawRequest: string;
  readonly notes: string | null;
  readonly bugExpected: string | null;
  readonly bugActual: string | null;
  readonly bugReproduction: string | null;
  readonly generatedSummary: string | null;
  readonly summaryGeneratedAt: string | null;
  readonly summaryGeneratedBy: string | null;
  readonly summaryRawRequestFingerprint: Fingerprint | null;
  readonly deferredAt: string | null;
  readonly deferredReason: string | null;
  readonly archivedAt: string | null;
  readonly archivedBy: string | null;
  readonly archivedReason: string | null;
  readonly publishedAt: string | null;
  readonly codingRunIds: readonly string[];
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const IDEA_COLUMNS = [
  'idea_id',
  'project_id',
  'kind',
  'raw_request',
  'notes',
  'bug_expected',
  'bug_actual',
  'bug_reproduction',
  'generated_summary',
  'summary_generated_at',
  'summary_generated_by',
  'summary_raw_request_fingerprint',
  'deferred_at',
  'deferred_reason',
  'archived_at',
  'archived_by',
  'archived_reason',
  'published_at',
  'coding_run_ids',
  'state',
  'created_at',
  'updated_at',
] as const;

const IDEA_SELECT = IDEA_COLUMNS.join(', ');

const ATTACHMENT_SELECT =
  'idea_id, file_name, media_type, byte_size, content_digest, relative_path, created_at';

/** The `ideas.state` values the schema's CHECK accepts. */
const IDEA_STATES = ['Received', 'Clarifying', 'Planned', 'Published', 'Abandoned'] as const;

/**
 * The state a capture records.
 *
 * `Received` is the schema's default and the only state a capture may write:
 * capture is the first durable fact about an idea, and recording a later state
 * here would persist a decision the domain has not made (F06-AC1).
 */
const CAPTURE_STATE = 'Received';

const BRIEF_COLUMNS = [
  'brief_id',
  'idea_id',
  'version',
  'sections_json',
  'state',
  'authored_by',
  'authored_at',
  'raw_request_fingerprint',
  'supersedes_version',
  'agreed_by',
  'agreed_at',
  'created_at',
] as const;

/** One stored brief version, as the export reports it. */
export interface BriefVersionSummary {
  readonly version: number;
  readonly state: 'Proposed' | 'Agreed';
  readonly authoredBy: string;
  readonly authoredAt: string;
  readonly rawRequestFingerprint: Fingerprint;
  readonly supersedesVersion: number | null;
  readonly sections: BriefSections;
}

/** One stored conversation turn, as the export reports it. */
export interface ConversationTurnSummary {
  readonly kind: ConversationTurn['kind'];
  readonly at: string;
  readonly text: string;
}

/** One stored clarifying question. */
export interface ClarifyingQuestionRecord {
  readonly questionId: string;
  readonly ideaId: IdeaId;
  readonly briefId: string | null;
  readonly briefVersion: number | null;
  readonly topic: string;
  readonly prompt: string;
  readonly readings: readonly string[];
  readonly whyMaterial: string;
  readonly origin: ClarifyingQuestion['origin'];
  readonly state: 'Open' | 'Answered';
  readonly answer: string | null;
  readonly createdAt: string;
  readonly answeredAt: string | null;
}

/** One candidate question that was considered and not asked (F07-AC2). */
export interface RejectedQuestionRecord {
  readonly rejectionId: string;
  readonly ideaId: IdeaId;
  readonly briefId: string | null;
  readonly briefVersion: number | null;
  readonly topic: string;
  readonly rejection: string;
  readonly explanation: string;
  readonly createdAt: string;
}

/**
 * A sanitized export of one idea (F32-AC2).
 *
 * The shape carries the owner's own text, structural facts, fingerprints and an
 * attachment index. It has no credential field, and `stripSecretFields` runs over
 * the assembled record as a second line of defence so a future field named like
 * a credential cannot be added to an export by accident.
 */
export interface IdeaExport {
  readonly ideaId: IdeaId;
  readonly kind: 'FeatureRequest' | 'Bug';
  readonly capturedAt: string;
  readonly rawRequest: string;
  readonly notes: string | null;
  readonly projectId: ProjectId | null;
  readonly bugDetail: {
    readonly expected: string | null;
    readonly actual: string | null;
    readonly reproduction: string | null;
  };
  readonly summary: {
    readonly text: string;
    readonly generatedAt: string;
    readonly generatedBy: string;
    readonly rawRequestFingerprint: Fingerprint;
  } | null;
  readonly disposition: { readonly state: string; readonly detail: string | null };
  readonly attachments: readonly {
    readonly fileName: string;
    readonly mediaType: string;
    readonly byteSize: number;
    readonly contentDigest: string;
  }[];
  readonly briefVersions: readonly BriefVersionSummary[];
  readonly conversation: readonly ConversationTurnSummary[];
  readonly questions: readonly ClarifyingQuestionRecord[];
  readonly rejectedQuestions: readonly RejectedQuestionRecord[];
}

/** Everything a caller may do to one idea's durable intake record. */
export interface IntakeStore {
  capture(draft: IdeaDraft): Result<IdeaDraft>;
  read(ideaId: IdeaId): Result<IdeaDraft>;
  addAttachment(input: {
    readonly ideaId: IdeaId;
    readonly name: string;
    readonly mediaType: AttachmentMediaType;
    readonly byteSize: number;
    readonly addedAt: string;
  }): Result<IdeaDraft>;
  summarize(input: {
    readonly ideaId: IdeaId;
    readonly text: string;
    readonly generatedBy: string;
    readonly at: string;
  }): Result<IdeaDraft>;
  defer(ideaId: IdeaId, at: string, reason: string | null): Result<IdeaDraft>;
  archive(ideaId: IdeaId, by: string, at: string, reason: string | null): Result<IdeaDraft>;
  recordProducedWork(input: {
    readonly ideaId: IdeaId;
    readonly workItemIds: readonly string[];
    readonly codingRunIds: readonly string[];
    readonly at: string;
  }): Result<IdeaDraft>;
  draftAndAppend(briefId: string, idea: IdeaDraft, proposal: ValidatedBriefProposal): Result<Brief>;
  appendBrief(brief: Brief): Result<Brief>;
  currentBrief(ideaId: IdeaId): Result<Brief | null>;
  listBriefs(ideaId: IdeaId): Result<readonly Brief[]>;
  agreeBrief(briefId: string, agreedBy: string, at: string): Result<Brief>;
  recordQuestion(input: {
    readonly ideaId: IdeaId;
    readonly briefId: string | null;
    readonly briefVersion: number | null;
    readonly question: ClarifyingQuestion;
    readonly at: string;
  }): Result<ClarifyingQuestionRecord>;
  answerQuestion(questionId: string, answer: string, at: string): Result<ClarifyingQuestionRecord>;
  listQuestions(ideaId: IdeaId): Result<readonly ClarifyingQuestionRecord[]>;
  recordRejectedQuestion(input: {
    readonly ideaId: IdeaId;
    readonly briefId: string | null;
    readonly briefVersion: number | null;
    readonly topic: string;
    readonly rejection: string;
    readonly explanation: string;
    readonly at: string;
  }): Result<RejectedQuestionRecord>;
  recordTurn(ideaId: IdeaId, turn: ConversationTurn): Result<ConversationTurn>;
  conversation(ideaId: IdeaId): Result<ClarificationConversation>;
  applyCorrection(input: {
    readonly ideaId: IdeaId;
    readonly brief: Brief;
    readonly correctionId: string;
    readonly text: string;
    readonly at: string;
    readonly proposal: ValidatedBriefProposal;
  }): Result<Brief>;
  exportIdea(ideaId: IdeaId): Result<IdeaExport>;
}

/** A row this package wrote and cannot now interpret. */
class CorruptRowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptRowError';
  }
}

function requiredText(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new CorruptRowError(`column ${column} is missing or not text`);
  return value;
}

function nullableText(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

function requiredInteger(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw new CorruptRowError(`column ${column} is missing or not an integer`);
}

function nullableInteger(row: Record<string, unknown>, column: string): number | null {
  return row[column] === null || row[column] === undefined ? null : requiredInteger(row, column);
}

/**
 * Reads a stored JSON document.
 *
 * Every document this package writes is canonical JSON it wrote itself, so the
 * cast is the trust boundary. A malformed document is a corrupt row and is
 * reported, never silently replaced with an empty one.
 */
function parseJson<T>(row: Record<string, unknown>, column: string): T {
  const raw = requiredText(row, column);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CorruptRowError(`column ${column} does not hold valid JSON`);
  }
}

function parseStringList(row: Record<string, unknown>, column: string): readonly string[] {
  const stored = parseJson<unknown>(row, column);
  if (!Array.isArray(stored)) throw new CorruptRowError(`column ${column} is not a JSON array`);
  const entries: string[] = [];
  for (const entry of stored as readonly unknown[]) {
    if (typeof entry !== 'string') throw new CorruptRowError(`column ${column} holds a non-text entry`);
    entries.push(entry);
  }
  return entries;
}

function notFound(entity: string, identity: string): DomainError {
  return { code: 'NotFound', reason: `${entity} ${identity} does not exist.` };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown storage failure';
}

function isIdeaState(value: string): value is (typeof IDEA_STATES)[number] {
  return (IDEA_STATES as readonly string[]).includes(value);
}

function newId<K extends string>(): ShipLoopId<K> {
  return randomUUID() as ShipLoopId<K>;
}

/**
 * One bug-detail member, or null when the request is not a bug.
 *
 * The domain types `IdeaRequest` as a union precisely so "a feature request with
 * reproduction steps" is not expressible, and this is the only place that reads
 * those members out of three independent nullable columns (F06-AC3).
 */
function bugMember(request: IdeaRequest, member: 'expected' | 'actual' | 'reproduction'): string | null {
  return request.kind === 'Bug' ? request.detail[member] : null;
}

function requestOf(row: IdeaRow): IdeaRequest {
  if (row.kind === 'Bug') {
    return {
      kind: 'Bug',
      detail: {
        expected: row.bugExpected,
        actual: row.bugActual,
        reproduction: row.bugReproduction,
      },
    };
  }
  return { kind: 'FeatureRequest' };
}

function toIdeaRow(row: Record<string, unknown>): IdeaRow {
  const projectId = nullableText(row, 'project_id');
  const kind = requiredText(row, 'kind');
  const state = requiredText(row, 'state');
  return {
    ideaId: requiredText(row, 'idea_id') as IdeaId,
    projectId: projectId === null ? null : (projectId as ProjectId),
    kind: kind === 'Bug' ? 'Bug' : 'FeatureRequest',
    rawRequest: requiredText(row, 'raw_request'),
    notes: nullableText(row, 'notes'),
    bugExpected: nullableText(row, 'bug_expected'),
    bugActual: nullableText(row, 'bug_actual'),
    bugReproduction: nullableText(row, 'bug_reproduction'),
    generatedSummary: nullableText(row, 'generated_summary'),
    summaryGeneratedAt: nullableText(row, 'summary_generated_at'),
    summaryGeneratedBy: nullableText(row, 'summary_generated_by'),
    summaryRawRequestFingerprint: nullableText(row, 'summary_raw_request_fingerprint') as Fingerprint | null,
    deferredAt: nullableText(row, 'deferred_at'),
    deferredReason: nullableText(row, 'deferred_reason'),
    archivedAt: nullableText(row, 'archived_at'),
    archivedBy: nullableText(row, 'archived_by'),
    archivedReason: nullableText(row, 'archived_reason'),
    publishedAt: nullableText(row, 'published_at'),
    codingRunIds: nullableText(row, 'coding_run_ids') === null ? [] : parseStringList(row, 'coding_run_ids'),
    state,
    createdAt: requiredText(row, 'created_at'),
    updatedAt: requiredText(row, 'updated_at'),
  };
}

/**
 * The disposition a stored row is in, derived rather than invented.
 *
 * The domain models four dispositions; the schema's `state` column models an
 * intake lifecycle plus a terminal 'Abandoned'. The mapping is total and
 * one-way, so no disposition is unrepresentable: `Published` and `Abandoned' are
 * states, and `Deferred` versus `Archived` is told apart by which instant the
 * schema recorded (F06-AC5). No second state column is introduced, because one
 * column with two names for one concept is the defect the project keeps removing.
 *
 * Two shapes are reported rather than read, and both come from the same place:
 * `IdeaRepository` in `repositories/core.ts` records a publication with no
 * publication instant and an archive with no actor, while the domain's
 * `Published` and `Archived` states require both. A missing value is not
 * inferred from a neighbouring column, because an inferred actor is a fabricated
 * one and F32-AC1 is about attribution. Both are therefore `Unavailable` reads
 * until that repository is retired.
 */
function dispositionOf(row: IdeaRow, workItemIds: readonly string[]): IdeaDraft['disposition'] {
  if (row.state === 'Published') {
    const publishedAt = row.publishedAt;
    if (publishedAt === null) {
      throw new CorruptRowError('a published idea records no publication instant');
    }
    return { state: 'Published', publishedAt, workItemIds: [...workItemIds], codingRunIds: [...row.codingRunIds] };
  }
  if (row.state !== 'Abandoned' && row.archivedAt === null && row.deferredAt === null) {
    if (!isIdeaState(row.state)) throw new CorruptRowError(`unknown idea state ${row.state}`);
    return { state: 'Unpublished' };
  }
  if (row.archivedAt !== null) {
    const archivedBy = row.archivedBy;
    if (archivedBy === null) throw new CorruptRowError('an archived idea records no actor');
    return { state: 'Archived', archivedAt: row.archivedAt, archivedBy, reason: row.archivedReason };
  }
  const deferredAt = row.deferredAt;
  if (deferredAt === null) throw new CorruptRowError('an abandoned idea records neither a deferral nor an archive');
  return { state: 'Deferred', deferredAt, reason: row.deferredReason };
}

function toDraft(row: IdeaRow, workItemIds: readonly string[], attachments: readonly IdeaAttachment[]): IdeaDraft {
  const summary =
    row.generatedSummary === null
      ? null
      : {
          text: row.generatedSummary,
          generatedAt: requireColumn(row.summaryGeneratedAt, 'summary_generated_at'),
          generatedBy: requireColumn(row.summaryGeneratedBy, 'summary_generated_by'),
          rawRequestFingerprint: requireColumn(
            row.summaryRawRequestFingerprint,
            'summary_raw_request_fingerprint',
          ),
        };
  return {
    ideaId: row.ideaId,
    rawRequest: row.rawRequest,
    projectId: row.projectId,
    notes: row.notes,
    request: requestOf(row),
    attachments,
    summary,
    disposition: dispositionOf(row, workItemIds),
    capturedAt: row.createdAt,
  };
}

function requireColumn<T>(value: T | null, column: string): T {
  if (value === null) throw new CorruptRowError(`column ${column} is required by the row that uses it`);
  return value;
}

function toAttachment(row: Record<string, unknown>): IdeaAttachment {
  return {
    name: requiredText(row, 'file_name'),
    mediaType: requiredText(row, 'media_type') as AttachmentMediaType,
    byteSize: requiredInteger(row, 'byte_size'),
    addedAt: requiredText(row, 'created_at'),
  };
}

function toBrief(row: Record<string, unknown>): Brief {
  const base = {
    briefId: requiredText(row, 'brief_id'),
    version: requiredInteger(row, 'version'),
    ideaId: requiredText(row, 'idea_id') as IdeaId,
    sections: parseJson<BriefSections>(row, 'sections_json'),
    authoredBy: requiredText(row, 'authored_by') as Brief['authoredBy'],
    authoredAt: requiredText(row, 'authored_at'),
    rawRequestFingerprint: requiredText(row, 'raw_request_fingerprint') as Fingerprint,
    supersedesVersion: nullableInteger(row, 'supersedes_version'),
  };
  if (requiredText(row, 'state') !== 'Agreed') return { ...base, state: 'Proposed' };
  return {
    ...base,
    state: 'Agreed',
    agreedBy: requiredText(row, 'agreed_by'),
    agreedAt: requiredText(row, 'agreed_at'),
  };
}

function toTurn(row: Record<string, unknown>): ConversationTurn {
  const kind = requiredText(row, 'turn_kind');
  const at = requiredText(row, 'created_at');
  const body = requiredText(row, 'body_redacted');
  if (kind === 'RawRequest') return { kind: 'RawRequest', at, text: body };
  if (kind === 'Question') {
    return { kind: 'Question', at, questionId: requiredText(row, 'question_id'), prompt: body };
  }
  if (kind === 'Answer') {
    return { kind: 'Answer', at, questionId: requiredText(row, 'question_id'), text: body };
  }
  return {
    kind: 'Correction',
    at,
    correctionId: requiredText(row, 'correction_id'),
    text: body,
    briefVersion: requiredInteger(row, 'brief_version'),
  };
}

function toQuestion(row: Record<string, unknown>): ClarifyingQuestionRecord {
  return {
    questionId: requiredText(row, 'question_id'),
    ideaId: requiredText(row, 'idea_id') as IdeaId,
    briefId: nullableText(row, 'brief_id'),
    briefVersion: nullableInteger(row, 'brief_version'),
    topic: requiredText(row, 'topic'),
    prompt: requiredText(row, 'body'),
    readings: parseStringList(row, 'readings'),
    whyMaterial: requiredText(row, 'why_material'),
    origin: requiredText(row, 'origin') as ClarifyingQuestion['origin'],
    state: requiredText(row, 'state') === 'Answered' ? 'Answered' : 'Open',
    answer: nullableText(row, 'answer_redacted'),
    createdAt: requiredText(row, 'created_at'),
    answeredAt: nullableText(row, 'answered_at'),
  };
}

/**
 * Durable intake over the migrated SQLite store.
 *
 * Writes are prepared and, where they span several statements, bounded by
 * `tx.ts`, which nests by savepoint so a repository call inside another
 * repository's transaction is safe. Nothing here performs a network call, so no
 * transaction can wait on a provider and hold the single global writer open.
 */
export class IntakeRepository implements IntakeStore {
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
   * An expected refusal is returned as a value from the body, so it reaches the
   * caller unchanged with the next step its own code describes. Only something
   * genuinely broken becomes `Unavailable`.
   */
  private attempt<T>(description: string, body: () => Result<T, DomainError>): Result<T, DomainError> {
    try {
      return body();
    } catch (error) {
      return { ok: false, error: { code: 'Unavailable', reason: `${description} failed: ${describeError(error)}` } };
    }
  }

  private rowOf(ideaId: IdeaId): Result<IdeaRow> {
    const row = this.statement(`SELECT ${IDEA_SELECT} FROM ideas WHERE idea_id = ?`).get(ideaId);
    if (row === undefined) return { ok: false, error: notFound('Idea', ideaId) };
    return { ok: true, value: toIdeaRow(row) };
  }

  private workItemIdsOf(ideaId: IdeaId): readonly string[] {
    return this
      .statement('SELECT work_item_id FROM idea_produced_work WHERE idea_id = ? ORDER BY produced_at ASC, work_item_id ASC')
      .all(ideaId)
      .map((row) => requiredText(row, 'work_item_id'));
  }

  private attachmentsOf(ideaId: IdeaId): readonly IdeaAttachment[] {
    return this
      .statement(
        `SELECT ${ATTACHMENT_SELECT} FROM idea_attachments WHERE idea_id = ? ORDER BY created_at ASC, attachment_id ASC`,
      )
      .all(ideaId)
      .map(toAttachment);
  }

  private draftOf(ideaId: IdeaId): Result<IdeaDraft> {
    const row = this.rowOf(ideaId);
    if (!row.ok) return row;
    return { ok: true, value: toDraft(row.value, this.workItemIdsOf(ideaId), this.attachmentsOf(ideaId)) };
  }

  // ------------------------------------------------------------------ capture

  /**
   * Persists a draft the domain has already accepted (F06-AC1).
   *
   * This is the only statement in the file that writes `raw_request`, and it
   * writes the owner's text once. Every later method leaves the column alone
   * entirely, so a generated sentence can never take its place.
   */
  capture(draft: IdeaDraft): Result<IdeaDraft> {
    return this.attempt('capture idea', () =>
      withTransaction(this.db, () => {
        // A draft is the first fact about an idea, and `createIdea` is what
        // produces one, so it carries neither a summary nor a disposition. A
        // caller that arrives with either is asking for a write this method
        // cannot make, and dropping them silently would record a request whose
        // generated sentence or lifecycle state had already been decided.
        if (draft.summary !== null || draft.disposition.state !== 'Unpublished' || draft.attachments.length > 0) {
          return {
            ok: false,
            error: invalid('A draft is captured before it is summarised, deferred, archived or given attachments.', [
              { path: 'draft', message: 'Capture the request first, then record the summary and the lifecycle.' },
            ]),
          };
        }
        this.statement(
          `INSERT INTO ideas (idea_id, project_id, kind, raw_request, notes, bug_expected, bug_actual, bug_reproduction,
             generated_summary, summary_generated_at, summary_generated_by, summary_raw_request_fingerprint,
             deferred_at, deferred_reason, archived_at, archived_by, archived_reason, published_at, coding_run_ids,
             open_questions, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
        ).run(
          draft.ideaId,
          draft.projectId,
          draft.request.kind,
          draft.rawRequest,
          draft.notes,
          bugMember(draft.request, 'expected'),
          bugMember(draft.request, 'actual'),
          bugMember(draft.request, 'reproduction'),
          canonicalize([]),
          CAPTURE_STATE,
          draft.capturedAt,
          draft.capturedAt,
        );
        return this.draftOf(draft.ideaId);
      }),
    );
  }

  /** The durable draft, its attachments and its disposition, or a typed `NotFound`. */
  read(ideaId: IdeaId): Result<IdeaDraft> {
    return this.attempt('read idea', () => this.draftOf(ideaId));
  }

  // ------------------------------------------------------------- attachments

  /**
   * References a named file from a draft (F06-AC1).
   *
   * The domain's `appendAttachment` refuses a separator, a `..` segment, an
   * absolute prefix, an unsupported media type and a duplicate name, rather
   * than sanitising them into a name that resolves somewhere unexpected. The
   * bytes are never inlined: the row carries a name, a size and a digest, and
   * the file itself lives under the artifact root.
   */
  addAttachment(input: {
    readonly ideaId: IdeaId;
    readonly name: string;
    readonly mediaType: AttachmentMediaType;
    readonly byteSize: number;
    readonly addedAt: string;
  }): Result<IdeaDraft> {
    return this.attempt('add idea attachment', () =>
      withTransaction(this.db, () => {
        const current = this.draftOf(input.ideaId);
        if (!current.ok) return current;
        const appended = domainAppendAttachment(current.value, {
          name: input.name,
          mediaType: input.mediaType,
          byteSize: input.byteSize,
          addedAt: input.addedAt,
        });
        if (!appended.ok) return appended;
        const attachment = appended.value.attachments[appended.value.attachments.length - 1];
        if (attachment === undefined) {
          return { ok: false, error: invalid('The attachment was not appended.', []) };
        }
        this.statement(
          `INSERT INTO idea_attachments (attachment_id, idea_id, artifact_ref, file_name, media_type, byte_size, content_digest, relative_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newId<'IdeaAttachmentId'>(),
          input.ideaId,
          attachment.name,
          attachment.name,
          attachment.mediaType,
          attachment.byteSize,
          contentDigestOf(attachment),
          attachment.name,
          attachment.addedAt,
        );
        return this.draftOf(input.ideaId);
      }),
    );
  }

  // ----------------------------------------------------------------- summary

  /**
   * Records a generated summary beside the raw request (F06-AC1).
   *
   * `summarizeDraft` has no parameter through which the raw text could be
   * replaced, and the fingerprint it computes is stored beside the summary, so a
   * summary can always be traced to the request it describes. The statement names
   * the four summary columns and no others.
   */
  summarize(input: {
    readonly ideaId: IdeaId;
    readonly text: string;
    readonly generatedBy: string;
    readonly at: string;
  }): Result<IdeaDraft> {
    return this.attempt('record generated summary', () =>
      withTransaction(this.db, () => {
        const current = this.draftOf(input.ideaId);
        if (!current.ok) return current;
        const summarized = domainSummarizeDraft(current.value, {
          text: input.text,
          generatedAt: input.at,
          generatedBy: input.generatedBy,
        });
        if (!summarized.ok) return summarized;
        const summary = summarized.value.summary;
        if (summary === null) return { ok: false, error: invalid('The summary cannot be recorded.', []) };
        this.statement(
          `UPDATE ideas SET generated_summary = ?, summary_generated_at = ?, summary_generated_by = ?,
             summary_raw_request_fingerprint = ?, updated_at = ? WHERE idea_id = ?`,
        ).run(summary.text, summary.generatedAt, summary.generatedBy, summary.rawRequestFingerprint, input.at, input.ideaId);
        return this.draftOf(input.ideaId);
      }),
    );
  }

  // ------------------------------------------------------------ dispositions

  /**
   * Defers an unpublished idea (F06-AC5).
   *
   * Pure bookkeeping: it writes two columns and creates no ticket and consumes
   * no coding run, which is why it needs no side effect. The domain refuses a
   * published or archived idea, and the schema refuses to hold a deferred and an
   * archived instant at the same time.
   */
  defer(ideaId: IdeaId, at: string, reason: string | null): Result<IdeaDraft> {
    return this.attempt('defer idea', () =>
      withTransaction(this.db, () => {
        const current = this.draftOf(ideaId);
        if (!current.ok) return current;
        const deferred = domainDeferIdea(current.value, { at, reason });
        if (!deferred.ok) return deferred;
        this.statement(
          `UPDATE ideas SET state = 'Abandoned', deferred_at = ?, deferred_reason = ?, updated_at = ? WHERE idea_id = ?`,
        ).run(at, reason, at, ideaId);
        return this.draftOf(ideaId);
      }),
    );
  }

  /**
   * Archives an idea that produced no work (F06-AC5).
   *
   * The domain refuses an idea that produced work, and the schema refuses the
   * same UPDATE independently by reading `idea_produced_work`, so "this idea is
   * not archivable" does not depend on a flag a caller might forget to maintain.
   */
  archive(ideaId: IdeaId, by: string, at: string, reason: string | null): Result<IdeaDraft> {
    return this.attempt('archive idea', () =>
      withTransaction(this.db, () => {
        const current = this.draftOf(ideaId);
        if (!current.ok) return current;
        const archived = domainArchiveIdea(current.value, { by, at, reason });
        if (!archived.ok) return archived;
        this.statement(
          `UPDATE ideas SET state = 'Abandoned', archived_at = ?, archived_by = ?, archived_reason = ?,
             deferred_at = NULL, deferred_reason = NULL, updated_at = ? WHERE idea_id = ?`,
        ).run(at, by, reason, at, ideaId);
        return this.draftOf(ideaId);
      }),
    );
  }

  /**
   * Records the external work an idea produced (F06-AC5).
   *
   * Each work item is a row with a real foreign key, so "this idea produced
   * work" is a fact about a ticket that exists rather than a string claiming
   * one, and the archivable check can read it. The coding run ids are a list on
   * the idea, matching the domain's `codingRunIds`.
   */
  recordProducedWork(input: {
    readonly ideaId: IdeaId;
    readonly workItemIds: readonly string[];
    readonly codingRunIds: readonly string[];
    readonly at: string;
  }): Result<IdeaDraft> {
    return this.attempt('record produced work', () =>
      withTransaction(this.db, () => {
        const current = this.draftOf(input.ideaId);
        if (!current.ok) return current;
        const produced = domainRecordProducedWork(
          current.value,
          { workItemIds: input.workItemIds, codingRunIds: input.codingRunIds },
          input.at,
        );
        if (!produced.ok) return produced;
        for (const workItemId of input.workItemIds) {
          this.statement(
            `INSERT INTO idea_produced_work (idea_id, work_item_id, produced_at) VALUES (?, ?, ?)
             ON CONFLICT (idea_id, work_item_id) DO UPDATE SET produced_at = excluded.produced_at`,
          ).run(input.ideaId, workItemId, input.at);
        }
        this.statement(
          `UPDATE ideas SET state = 'Published', published_at = ?, coding_run_ids = ?,
             published_work_item_id = COALESCE(published_work_item_id, ?), updated_at = ? WHERE idea_id = ?`,
        ).run(input.at, canonicalize([...input.codingRunIds]), input.workItemIds[0] ?? null, input.at, input.ideaId);
        return this.draftOf(input.ideaId);
      }),
    );
  }

  // ------------------------------------------------------------------ briefs

  /**
   * The one statement that writes a brief version.
   *
   * Shared by `appendBrief` and `applyCorrection` so the correction's turn and
   * its version are written by the same INSERT in the same transaction, and a
   * constraint that refuses the version rolls the turn back with it. Nothing
   * throws a typed result from here: a refusal belongs to the domain, and a
   * column that refuses a version is a storage fault the transaction must undo.
   */
  private insertBriefVersion(brief: Brief): void {
    this.statement(
      `INSERT INTO briefs (brief_id, idea_id, version, sections_json, state, created_at, updated_at,
         authored_by, authored_at, raw_request_fingerprint, supersedes_version)
       VALUES (?, ?, ?, ?, 'Draft', ?, ?, ?, ?, ?, ?)`,
    ).run(
      brief.briefId,
      brief.ideaId,
      brief.version,
      canonicalize(brief.sections),
      brief.authoredAt,
      brief.authoredAt,
      brief.authoredBy,
      brief.authoredAt,
      brief.rawRequestFingerprint,
      brief.supersedesVersion,
    );
  }

  /**
   * Appends a brief version (F07-AC3).
   *
   * A correction is an append, never an edit: there is no UPDATE path for the
   * versioned columns anywhere in this file, and the trigger refuses one, so a
   * prior version stays readable exactly as it was recorded. The version number
   * is the domain's, and the schema requires it to supersede the one immediately
   * before it.
   */
  appendBrief(brief: Brief): Result<Brief> {
    return this.attempt('append brief version', () =>
      withTransaction(this.db, () => {
        if (brief.state === 'Agreed') {
          return {
            ok: false,
            error: invalid('A brief is appended as a proposal; agreement is a separate owner decision.', [
              { path: 'brief.state', message: 'Append the version, then record the agreement against it.' },
            ]),
          };
        }
        this.insertBriefVersion(brief);
        return { ok: true, value: brief };
      }),
    );
  }

  /**
   * Builds a brief from a validated proposal and appends it (F07-AC1, F05-AC5).
   *
   * `draftBrief` is the only route from a proposal to a brief, and it computes
   * the request fingerprint from the draft the domain already holds, so a
   * structured output cannot attach a brief to a request it never read.
   */
  draftAndAppend(briefId: string, idea: IdeaDraft, proposal: ValidatedBriefProposal): Result<Brief> {
    const drafted = domainDraftBrief({ briefId, idea, proposal });
    if (!drafted.ok) return drafted;
    return this.appendBrief(drafted.value);
  }

  /** The highest-numbered version, which is the one a correction supersedes. */
  currentBrief(ideaId: IdeaId): Result<Brief | null> {
    return this.attempt('read current brief', () => {
      const row = this
        .statement(`SELECT ${BRIEF_COLUMNS.join(', ')} FROM briefs WHERE idea_id = ? ORDER BY version DESC LIMIT 1`)
        .get(ideaId);
      return { ok: true, value: row === undefined ? null : toBrief(row) };
    });
  }

  /** Every version, oldest first, so a prior decision stays readable (F07-AC3). */
  listBriefs(ideaId: IdeaId): Result<readonly Brief[]> {
    return this.attempt('list brief versions', () => {
      const rows = this
        .statement(`SELECT ${BRIEF_COLUMNS.join(', ')} FROM briefs WHERE idea_id = ? ORDER BY version ASC`)
        .all(ideaId);
      return { ok: true, value: rows.map(toBrief) };
    });
  }

  /**
   * Records owner agreement with a brief (F05-AC5).
   *
   * Agreement is an owner decision about scope, not product acceptance: it says
   * the scope is right, not that code behaves correctly, and it records nothing
   * about delivery or release. The two columns written are exactly the ones the
   * schema requires for an agreed version, and the trigger refuses an agreement
   * that names neither an owner nor an instant.
   */
  agreeBrief(briefId: string, agreedBy: string, at: string): Result<Brief> {
    return this.attempt('agree brief', () =>
      withTransaction(this.db, () => {
        const row = this
          .statement(`SELECT ${BRIEF_COLUMNS.join(', ')} FROM briefs WHERE brief_id = ? ORDER BY version DESC LIMIT 1`)
          .get(briefId);
        if (row === undefined) return { ok: false, error: notFound('Brief', briefId) };
        const agreed = domainAgreeBrief(toBrief(row), { agreedBy, at });
        if (!agreed.ok) return agreed;
        this.statement(
          `UPDATE briefs SET state = 'Agreed', agreed_by = ?, agreed_at = ?, updated_at = ? WHERE brief_id = ? AND version = ?`,
        ).run(agreedBy, at, at, briefId, agreed.value.version);
        return { ok: true, value: agreed.value };
      }),
    );
  }

  // ----------------------------------------------------------- clarification

  /**
   * Records a clarifying question (F07-AC2).
   *
   * The row carries the claim that earns the question: the topic, the readings it
   * separates, why it changes the work, and whether it came from an enumerated
   * ambiguity or from a criterion that cannot be checked. The trigger refuses a
   * question that does not, so "ask the owner anyway" is not reachable by writing
   * a row directly.
   */
  recordQuestion(input: {
    readonly ideaId: IdeaId;
    readonly briefId: string | null;
    readonly briefVersion: number | null;
    readonly question: ClarifyingQuestion;
    readonly at: string;
  }): Result<ClarifyingQuestionRecord> {
    return this.attempt('record clarifying question', () =>
      withTransaction(this.db, () => {
        if (this.rowOf(input.ideaId).ok === false) {
          return { ok: false, error: notFound('Idea', input.ideaId) };
        }
        const questionId = newId<'QuestionId'>();
        this.statement(
          `INSERT INTO idea_questions (question_id, idea_id, brief_id, brief_version, body, topic, readings, why_material, origin, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?)`,
        ).run(
          questionId,
          input.ideaId,
          input.briefId,
          input.briefVersion,
          input.question.prompt,
          input.question.topic,
          canonicalize([...input.question.readings]),
          input.question.whyMaterial,
          input.question.origin,
          input.at,
        );
        const row = this.questionRow(questionId);
        if (row === undefined) return { ok: false, error: notFound('Clarifying question', questionId) };
        return { ok: true, value: toQuestion(row) };
      }),
    );
  }

  /** Records the owner's answer, which is what makes the question no longer open. */
  answerQuestion(questionId: string, answer: string, at: string): Result<ClarifyingQuestionRecord> {
    return this.attempt('answer clarifying question', () =>
      withTransaction(this.db, () => {
        const changes = this.statement(
          `UPDATE idea_questions SET state = 'Answered', answer_redacted = ?, answered_at = ? WHERE question_id = ?`,
        ).run(answer, at, questionId);
        if (Number(changes.changes) === 0) return { ok: false, error: notFound('Clarifying question', questionId) };
        const row = this.questionRow(questionId);
        if (row === undefined) return { ok: false, error: notFound('Clarifying question', questionId) };
        return { ok: true, value: toQuestion(row) };
      }),
    );
  }

  listQuestions(ideaId: IdeaId): Result<readonly ClarifyingQuestionRecord[]> {
    return this.attempt('list clarifying questions', () => {
      const rows = this
        .statement(
          `SELECT question_id, idea_id, brief_id, brief_version, body, topic, readings, why_material, origin, state, answer_redacted, created_at, answered_at
           FROM idea_questions WHERE idea_id = ? ORDER BY created_at ASC, question_id ASC`,
        )
        .all(ideaId);
      return { ok: true, value: rows.map(toQuestion) };
    });
  }

  /**
   * Records a candidate that was considered and not asked (F07-AC2).
   *
   * A rejected candidate is a row, not an absence, so the owner can be shown
   * that something was considered and why it was not asked. It is stored apart
   * from `idea_questions` because it is not a question: no value of that table's
   * `state` means "considered and declined".
   */
  recordRejectedQuestion(input: {
    readonly ideaId: IdeaId;
    readonly briefId: string | null;
    readonly briefVersion: number | null;
    readonly topic: string;
    readonly rejection: string;
    readonly explanation: string;
    readonly at: string;
  }): Result<RejectedQuestionRecord> {
    return this.attempt('record rejected question', () =>
      withTransaction(this.db, () => {
        if (this.rowOf(input.ideaId).ok === false) {
          return { ok: false, error: notFound('Idea', input.ideaId) };
        }
        const rejectionId = newId<'RejectionId'>();
        this.statement(
          `INSERT INTO idea_question_rejections (rejection_id, idea_id, brief_id, brief_version, topic, rejection, explanation, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          rejectionId,
          input.ideaId,
          input.briefId,
          input.briefVersion,
          input.topic,
          input.rejection,
          input.explanation,
          input.at,
        );
        return {
          ok: true,
          value: {
            rejectionId,
            ideaId: input.ideaId,
            briefId: input.briefId,
            briefVersion: input.briefVersion,
            topic: input.topic,
            rejection: input.rejection,
            explanation: input.explanation,
            createdAt: input.at,
          },
        };
      }),
    );
  }

  /**
   * Appends one owner-conversation turn (F07-AC3).
   *
   * Turns are append-only in the schema, so a correction adds a turn and never
   * edits one: the owner's original words and every later decision stay readable
   * in order. The turn's `kind` and the reference it names must agree, which the
   * `idea_messages_turn_shape_insert` trigger enforces.
   */
  recordTurn(ideaId: IdeaId, turn: ConversationTurn): Result<ConversationTurn> {
    return this.attempt('record conversation turn', () =>
      withTransaction(this.db, () => {
        if (this.rowOf(ideaId).ok === false) return { ok: false, error: notFound('Idea', ideaId) };
        this.statement(
          `INSERT INTO idea_messages (message_id, idea_id, turn_kind, question_id, correction_id, brief_version, author_role, body_redacted, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newId<'MessageId'>(),
          ideaId,
          turn.kind,
          turn.kind === 'Question' || turn.kind === 'Answer' ? turn.questionId : null,
          turn.kind === 'Correction' ? turn.correctionId : null,
          turn.kind === 'Correction' ? turn.briefVersion : null,
          turn.kind === 'Question' ? 'Agent' : 'Owner',
          turn.kind === 'Question' ? turn.prompt : turn.text,
          turn.at,
        );
        return { ok: true, value: turn };
      }),
    );
  }

  /**
   * The conversation about one idea, in order (F07-AC3).
   *
   * One conversation per idea, so the turns of an idea are the conversation
   * about it and there is no second conversation to confuse the record with. The
   * first turn is normally the raw request, which is what makes
   * `rawRequestOf` find the text a correction is bound to.
   */
  conversation(ideaId: IdeaId): Result<ClarificationConversation> {
    return this.attempt('read conversation', () => {
      const rows = this
        .statement(
          `SELECT message_id, idea_id, turn_kind, question_id, correction_id, brief_version, body_redacted, created_at
           FROM idea_messages WHERE idea_id = ? ORDER BY created_at ASC, message_id ASC`,
        )
        .all(ideaId);
      return {
        ok: true,
        value: {
          conversationId: `conversation-${ideaId}`,
          ideaId,
          turns: rows.map(toTurn),
        },
      };
    });
  }

  /**
   * Appends a correction and the brief version it produces, atomically (F07-AC3).
   *
   * Both writes happen in one bounded transaction, so a crash between them
   * cannot leave a correction in the conversation with no version behind it, or a
   * version with no correction recorded. The domain validates the correction
   * against the current version first, so a correction built on a stale brief is
   * a `Conflict` rather than a silent overwrite of someone else's reasoning.
   */
  applyCorrection(input: {
    readonly ideaId: IdeaId;
    readonly brief: Brief;
    readonly correctionId: string;
    readonly text: string;
    readonly at: string;
    readonly proposal: ValidatedBriefProposal;
  }): Result<Brief> {
    return this.attempt('apply owner correction', () =>
      withTransaction(this.db, () => {
        const conversation = this.conversation(input.ideaId);
        if (!conversation.ok) return conversation;
        const applied = domainApplyCorrection(conversation.value, input.brief, {
          correctionId: input.correctionId,
          text: input.text,
          at: input.at,
          proposal: {
            kind: 'BriefProposal',
            ideaId: input.ideaId,
            authoredBy: input.proposal.authoredBy,
            authoredAt: input.proposal.authoredAt,
            basedOnBriefVersion: input.brief.version,
            sections: input.proposal.sections,
          },
        });
        if (!applied.ok) return applied;
        this.statement(
          `INSERT INTO idea_messages (message_id, idea_id, turn_kind, correction_id, brief_version, author_role, body_redacted, created_at)
           VALUES (?, ?, 'Correction', ?, ?, 'Owner', ?, ?)`,
        ).run(
          newId<'MessageId'>(),
          input.ideaId,
          input.correctionId,
          applied.value.brief.version,
          input.text,
          input.at,
        );
        this.insertBriefVersion(applied.value.brief);
        return { ok: true, value: applied.value.brief };
      }),
    );
  }

  // ------------------------------------------------------------------ export

  /**
   * A sanitized export of one idea (F32-AC2).
   *
   * Two independent controls run over the assembled record and neither is
   * optional. `redact` removes a credential whose shape matches a configured
   * rule, which is what stops a token the owner pasted into their own request
   * from travelling with the export. `stripSecretFields` removes a field whose
   * name is credential-bearing, which is the backstop for a secret with a shape
   * no pattern recognises. The attachment section is an index: names, types,
   * sizes and digests, never bytes and never a file path outside the artifact
   * root.
   */
  exportIdea(ideaId: IdeaId): Result<IdeaExport> {
    return this.attempt('export idea', () => {
      const row = this.rowOf(ideaId);
      if (!row.ok) return row;
      const briefs = this.listBriefs(ideaId);
      if (!briefs.ok) return briefs;
      const conversation = this.conversation(ideaId);
      if (!conversation.ok) return conversation;
      const questions = this.listQuestions(ideaId);
      if (!questions.ok) return questions;

      const idea = row.value;
      const assembled: IdeaExport = {
        ideaId: idea.ideaId,
        kind: idea.kind,
        capturedAt: idea.createdAt,
        rawRequest: idea.rawRequest,
        notes: idea.notes,
        projectId: idea.projectId,
        bugDetail: {
          expected: idea.bugExpected,
          actual: idea.bugActual,
          reproduction: idea.bugReproduction,
        },
        summary:
          idea.generatedSummary === null
            ? null
            : {
                text: idea.generatedSummary,
                generatedAt: requireColumn(idea.summaryGeneratedAt, 'summary_generated_at'),
                generatedBy: requireColumn(idea.summaryGeneratedBy, 'summary_generated_by'),
                rawRequestFingerprint: requireColumn(
                  idea.summaryRawRequestFingerprint,
                  'summary_raw_request_fingerprint',
                ),
              },
        disposition: {
          state: dispositionOf(idea, this.workItemIdsOf(ideaId)).state,
          detail: dispositionDetailOf(idea, this.workItemIdsOf(ideaId)),
        },
        attachments: this.statement(
          `SELECT ${ATTACHMENT_SELECT} FROM idea_attachments WHERE idea_id = ? ORDER BY created_at ASC, attachment_id ASC`,
        )
          .all(ideaId)
          .map((attachment) => ({
            fileName: requiredText(attachment, 'file_name'),
            mediaType: requiredText(attachment, 'media_type'),
            byteSize: requiredInteger(attachment, 'byte_size'),
            contentDigest: requiredText(attachment, 'content_digest'),
          })),
        briefVersions: briefs.value.map((brief) => ({
          version: brief.version,
          state: brief.state,
          authoredBy: brief.authoredBy,
          authoredAt: brief.authoredAt,
          rawRequestFingerprint: brief.rawRequestFingerprint,
          supersedesVersion: brief.supersedesVersion,
          sections: brief.sections,
        })),
        conversation: conversation.value.turns.map((turn) => ({
          kind: turn.kind,
          at: turn.at,
          text: turn.kind === 'Question' ? turn.prompt : turn.text,
        })),
        questions: questions.value,
        rejectedQuestions: this.rejectedOf(ideaId),
      };
      return { ok: true, value: stripSecretFields(redactDeep(assembled)) };
    });
  }

  private questionRow(questionId: string): Record<string, unknown> | undefined {
    return this
      .statement(
        `SELECT question_id, idea_id, brief_id, body, topic, readings, why_material, origin, state, answer_redacted, created_at, answered_at
         FROM idea_questions WHERE question_id = ?`,
      )
      .get(questionId);
  }

  private rejectedOf(ideaId: IdeaId): readonly RejectedQuestionRecord[] {
    return this
      .statement(
        `SELECT rejection_id, idea_id, brief_id, brief_version, topic, rejection, explanation, created_at
         FROM idea_question_rejections WHERE idea_id = ? ORDER BY created_at ASC, rejection_id ASC`,
      )
      .all(ideaId)
      .map((row) => ({
        rejectionId: requiredText(row, 'rejection_id'),
        ideaId: requiredText(row, 'idea_id') as IdeaId,
        briefId: nullableText(row, 'brief_id'),
        briefVersion: nullableInteger(row, 'brief_version'),
        topic: requiredText(row, 'topic'),
        rejection: requiredText(row, 'rejection'),
        explanation: requiredText(row, 'explanation'),
        createdAt: requiredText(row, 'created_at'),
      }));
  }
}

/**
 * A digest that proves which artifact a row referenced.
 *
 * Derived from the reference and the size rather than the bytes, because this
 * layer never sees the bytes: the artifact store writes the file and this column
 * records what the row pointed at. It is the same "a pointer, not a content
 * store" property the architecture requires of every attachment (F06-AC1).
 */
function contentDigestOf(attachment: IdeaAttachment): string {
  return `sha256:${fingerprint({ name: attachment.name, byteSize: attachment.byteSize }).slice(3)}`;
}

function dispositionDetailOf(row: IdeaRow, workItemIds: readonly string[]): string {
  const disposition = dispositionOf(row, workItemIds);
  if (disposition.state === 'Unpublished') return 'not published, not deferred, not archived';
  if (disposition.state === 'Published') {
    return `${disposition.workItemIds.length} work item(s), ${disposition.codingRunIds.length} coding run(s)`;
  }
  if (disposition.state === 'Deferred') return disposition.reason ?? 'deferred without a stated reason';
  return disposition.reason ?? 'archived without a stated reason';
}
