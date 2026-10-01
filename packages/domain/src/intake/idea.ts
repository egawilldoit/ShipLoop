import { fingerprint } from '../fingerprint.ts';
import type { Fingerprint, IdeaId } from '../ids.ts';
import type { DomainError, Result } from '../result.ts';
import { err, invalid, ok } from '../result.ts';

/**
 * Idea and bug intake (F06).
 *
 * The owner captures a rough request before it is actionable work, so the rule
 * that matters is that capture is cheap and lossy things are never forced: only
 * the raw request is required, and every optional field may be absent
 * (F06-AC3). Two separations are enforced structurally rather than by
 * convention, because both failures silently corrupt later work:
 *
 *   - the raw request and a generated summary are different fields (F06-AC1).
 *     A summary is derived data, so `summarizeDraft` has no parameter through
 *     which the raw text could be replaced, and the summary records the
 *     fingerprint of the exact raw text it was derived from;
 *   - attachments are named files, never embedded content (F06-AC1). The
 *     architecture already requires artifacts to be named files referenced by
 *     rows, so a name that could escape the artifact root is refused instead of
 *     sanitised into something that resolves somewhere unexpected.
 *
 * Nothing here publishes, schedules or runs anything. Archiving is the only
 * terminal state an owner can reach without producing work, and it is refused
 * once an idea has produced some, because discarding the record would orphan
 * code or a ticket (F06-AC5).
 */

export type IdeaKind = 'FeatureRequest' | 'Bug';

/**
 * Optional bug detail.
 *
 * Every member is nullable because the specification requires capture to succeed
 * when expected, actual and reproduction detail are unavailable: a bug is still a
 * valid capture even when the owner can only describe the symptom (F06-AC3).
 */
export interface BugDetail {
  readonly expected: string | null;
  readonly actual: string | null;
  readonly reproduction: string | null;
}

/**
 * The request kind and its kind-specific detail, as one discriminated union.
 *
 * A feature request cannot carry bug detail and a bug cannot be a bare string, so
 * "a feature request with reproduction steps" is not expressible rather than
 * being validated away later.
 */
export type IdeaRequest =
  | { readonly kind: 'FeatureRequest' }
  | { readonly kind: 'Bug'; readonly detail: BugDetail };

export const ATTACHMENT_MEDIA_TYPES = ['text/plain', 'image/png', 'image/jpeg'] as const;
export type AttachmentMediaType = (typeof ATTACHMENT_MEDIA_TYPES)[number];

/**
 * The supported attachment types (F06-AC1).
 *
 * This is both the source of `AttachmentMediaType` and the runtime predicate at
 * the decoded-input boundary, so an unsupported type is refused rather than
 * stored and quietly unreadable later.
 */
export function isSupportedMediaType(mediaType: string): mediaType is AttachmentMediaType {
  return (ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(mediaType);
}

/** Largest single attachment accepted, so a draft cannot be used to fill the artifact root. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Largest attachment name accepted; every supported filesystem path is shorter than this. */
export const MAX_ATTACHMENT_NAME_LENGTH = 255;

/** Largest number of attachments one draft may reference. */
export const MAX_ATTACHMENTS = 20;

const PATH_SEPARATORS = ['/', '\\'];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:/;

export interface IdeaAttachment {
  /**
   * The artifact file name, relative to the artifact root.
   *
   * Never a path: the name is checked to contain no separator, no `..` segment,
   * no absolute prefix and no NUL, so joining it to the root cannot escape.
   */
  readonly name: string;
  readonly mediaType: AttachmentMediaType;
  readonly byteSize: number;
  readonly addedAt: string;
}

export interface AttachmentInput {
  readonly name: string;
  readonly mediaType: AttachmentMediaType;
  readonly byteSize: number;
  readonly addedAt: string;
}

/**
 * A generated summary, kept separate from the raw request (F06-AC1).
 *
 * `rawRequestFingerprint` records which raw text produced the summary, so a
 * summary can always be traced to the request it describes and a later edit to
 * the raw request cannot be presented as if this summary had described it.
 */
export interface GeneratedSummary {
  readonly text: string;
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly rawRequestFingerprint: Fingerprint;
}

export interface GeneratedSummaryInput {
  readonly text: string;
  readonly generatedAt: string;
  readonly generatedBy: string;
}

/**
 * Where an unpublished idea stands.
 *
 * `Published` carries the external work the idea produced, which is what makes
 * the idea unarchivable (F06-AC5). Keeping that evidence inside the state variant
 * means the refusal in `archiveIdea` is decided by the type rather than by a
 * flag a caller might forget to maintain.
 */
export type IdeaDisposition =
  | { readonly state: 'Unpublished' }
  | {
      readonly state: 'Published';
      readonly publishedAt: string;
      readonly workItemIds: readonly string[];
      readonly codingRunIds: readonly string[];
    }
  | { readonly state: 'Deferred'; readonly deferredAt: string; readonly reason: string | null }
  | {
      readonly state: 'Archived';
      readonly archivedAt: string;
      readonly archivedBy: string;
      /** Why the idea was set aside, so the record explains itself later. */
      readonly reason: string | null;
    };

export interface IdeaDraft {
  readonly ideaId: IdeaId;
  /**
   * The owner's own words, never replaced (F06-AC1).
   *
   * Surrounding whitespace is removed once at capture so a blank request is
   * detectable and a pasted form value is not padded; the text is otherwise
   * stored exactly as received.
   */
  readonly rawRequest: string;
  readonly projectId: string | null;
  readonly notes: string | null;
  readonly request: IdeaRequest;
  readonly attachments: readonly IdeaAttachment[];
  /** Derived data. Absent until a summary is generated, and never the source of truth. */
  readonly summary: GeneratedSummary | null;
  readonly disposition: IdeaDisposition;
  readonly capturedAt: string;
}

export interface CreateIdeaInput {
  readonly ideaId: IdeaId;
  readonly rawRequest: string;
  readonly capturedAt: string;
  readonly kind: IdeaKind;
  readonly projectId?: string | null;
  readonly notes?: string | null;
  /** Accepted for bugs only, and optional there too (F06-AC3). */
  readonly detail?: BugDetail | null;
}

/**
 * Captures an idea, validating only what intake genuinely requires.
 *
 * `rawRequest` is the sole required field. Absent project, notes and bug detail
 * still produce a draft, because refusing a partial request is precisely how an
 * owner loses it (F06-AC3). Bug detail supplied for a feature request is refused
 * because that combination is not a request shape the product recognises.
 *
 * Validation is deliberately narrow here: this function decides what may be
 * captured, not what is ready to work on. Judging completeness belongs to the
 * brief and readiness, which can see the whole request (F06-AC3).
 */
export function createIdea(input: CreateIdeaInput): Result<IdeaDraft, DomainError> {
  const rawRequest = input.rawRequest.trim();
  if (rawRequest.length === 0) {
    return err<DomainError>(
      invalid('A captured idea needs the owner\'s own words.', [
        { path: 'rawRequest', message: 'The raw request is required and cannot be blank.' },
      ]),
    );
  }

  if (input.kind === 'FeatureRequest' && (input.detail ?? null) !== null) {
    return err<DomainError>(
      invalid('Bug detail was supplied for a feature request.', [
        { path: 'detail', message: 'Expected/actual/reproduction detail belongs to a bug, not a feature request.' },
      ]),
    );
  }

  const request: IdeaRequest =
    input.kind === 'Bug'
      ? { kind: 'Bug', detail: input.detail ?? { expected: null, actual: null, reproduction: null } }
      : { kind: 'FeatureRequest' };

  return ok<IdeaDraft>(
    Object.freeze({
      ideaId: input.ideaId,
      rawRequest,
      projectId: input.projectId ?? null,
      notes: input.notes ?? null,
      request,
      attachments: Object.freeze([] as readonly IdeaAttachment[]),
      summary: null,
      disposition: Object.freeze({ state: 'Unpublished' } as const),
      capturedAt: input.capturedAt,
    }),
  );
}

/**
 * Checks one attachment name against the artifact root boundary.
 *
 * Every refusal names the specific traversal it prevents, because a sanitised
 * name would silently write somewhere the owner did not intend. Bounded length
 * and the absence of control characters keep the name usable as a file name on
 * every supported host.
 */
function attachmentNameErrors(name: string): { readonly path: string; readonly message: string }[] {
  const errors: { path: string; message: string }[] = [];
  const field = 'attachment.name';

  if (name.length === 0) {
    errors.push({ path: field, message: 'An attachment needs a file name.' });
    return errors;
  }
  if (name.includes('\u0000')) {
    errors.push({ path: field, message: 'A file name cannot contain a NUL character.' });
  }
  if (CONTROL_CHARACTERS.test(name)) {
    errors.push({ path: field, message: 'A file name cannot contain control characters.' });
  }
  for (const separator of PATH_SEPARATORS) {
    if (name.includes(separator)) {
      errors.push({
        path: field,
        message: `A file name cannot contain the "${separator}" path separator; attachments are named files under the artifact root.`,
      });
    }
  }
  if (name === '.' || name === '..') {
    errors.push({ path: field, message: 'A file name cannot be a relative path segment.' });
  }
  if (name.includes('..')) {
    errors.push({ path: field, message: 'A file name cannot contain "..", which could escape the artifact root.' });
  }
  if (WINDOWS_ABSOLUTE.test(name) || name.startsWith('~')) {
    errors.push({ path: field, message: 'A file name must be relative to the artifact root, not an absolute path.' });
  }
  if (name !== name.trim()) {
    errors.push({ path: field, message: 'A file name cannot begin or end with whitespace.' });
  }
  if (name.length > MAX_ATTACHMENT_NAME_LENGTH) {
    errors.push({
      path: field,
      message: `A file name is limited to ${MAX_ATTACHMENT_NAME_LENGTH} characters.`,
    });
  }
  return errors;
}

/**
 * References a named file from a draft (F06-AC1).
 *
 * Only the name, media type, size and time are stored; attachment content is
 * never inlined into the draft, so an idea record cannot become an alternative
 * content store and a large capture cannot silently enter the database.
 */
export function appendAttachment(
  draft: IdeaDraft,
  attachment: AttachmentInput,
): Result<IdeaDraft, DomainError> {
  const errors = attachmentNameErrors(attachment.name);

  if (!isSupportedMediaType(attachment.mediaType)) {
    errors.push({
      path: 'attachment.mediaType',
      message: `"${attachment.mediaType}" is not a supported attachment type.`,
    });
  }
  if (!Number.isInteger(attachment.byteSize) || attachment.byteSize <= 0) {
    errors.push({ path: 'attachment.byteSize', message: 'An attachment must report a positive whole byte count.' });
  }
  if (attachment.byteSize > MAX_ATTACHMENT_BYTES) {
    errors.push({
      path: 'attachment.byteSize',
      message: `An attachment is limited to ${MAX_ATTACHMENT_BYTES} bytes.`,
    });
  }
  if (draft.attachments.length >= MAX_ATTACHMENTS) {
    errors.push({
      path: 'attachment',
      message: `A draft references at most ${MAX_ATTACHMENTS} attachments.`,
    });
  }
  if (draft.attachments.some((existing) => existing.name === attachment.name)) {
    errors.push({
      path: 'attachment.name',
      message: `"${attachment.name}" is already referenced by this draft.`,
    });
  }

  if (errors.length > 0) {
    return err<DomainError>(invalid('The attachment cannot be referenced by this draft.', errors));
  }

  return ok<IdeaDraft>({
    ...draft,
    attachments: Object.freeze([
      ...draft.attachments,
      Object.freeze({
        name: attachment.name,
        mediaType: attachment.mediaType,
        byteSize: attachment.byteSize,
        addedAt: attachment.addedAt,
      }),
    ]),
  });
}

/**
 * Records a generated summary alongside the raw request (F06-AC1).
 *
 * There is deliberately no parameter that could carry replacement raw text, so
 * "the summary overwrote the request" is not a reachable state rather than a
 * rule to remember. Re-summarising replaces the previous derived summary and
 * still leaves `rawRequest` byte-identical, which is the property that keeps a
 * generated sentence from becoming the source of truth.
 */
export function summarizeDraft(
  draft: IdeaDraft,
  generated: GeneratedSummaryInput,
): Result<IdeaDraft, DomainError> {
  const text = generated.text.trim();
  const errors: { path: string; message: string }[] = [];
  if (text.length === 0) {
    errors.push({ path: 'summary.text', message: 'A generated summary cannot be blank.' });
  }
  if (generated.generatedBy.trim().length === 0) {
    errors.push({ path: 'summary.generatedBy', message: 'A generated summary records what generated it.' });
  }
  if (errors.length > 0) {
    return err<DomainError>(invalid('The summary cannot be recorded.', errors));
  }

  return ok<IdeaDraft>({
    ...draft,
    summary: Object.freeze({
      text,
      generatedAt: generated.generatedAt,
      generatedBy: generated.generatedBy,
      rawRequestFingerprint: fingerprint(draft.rawRequest),
    }),
  });
}

/** Identities of the external work an idea produced, used to decide what it may become. */
export interface ProducedWork {
  readonly workItemIds: readonly string[];
  readonly codingRunIds: readonly string[];
}

/**
 * Records the external work an idea produced.
 *
 * Publication happens outside this module; this function only records the
 * consequence the intake rules care about. Once work exists the idea can no
 * longer be discarded, because the code or ticket would keep running without the
 * request that justified it (F06-AC5).
 */
export function recordProducedWork(
  draft: IdeaDraft,
  work: ProducedWork,
  publishedAt: string,
): Result<IdeaDraft, DomainError> {
  if (draft.disposition.state === 'Archived') {
    return err<DomainError>({
      code: 'Conflict',
      reason: 'An archived idea cannot later produce work.',
      expected: 'Unpublished or Deferred',
      actual: 'Archived',
    });
  }

  return ok<IdeaDraft>({
    ...draft,
    disposition: Object.freeze({
      state: 'Published',
      publishedAt,
      workItemIds: Object.freeze([...work.workItemIds]),
      codingRunIds: Object.freeze([...work.codingRunIds]),
    }),
  });
}

/**
 * Defers an unpublished idea without publishing it or consuming a coding run
 * (F06-AC5).
 */
export function deferIdea(
  draft: IdeaDraft,
  input: { readonly at: string; readonly reason: string | null },
): Result<IdeaDraft, DomainError> {
  if (draft.disposition.state === 'Archived') {
    return err<DomainError>({
      code: 'Conflict',
      reason: 'An archived idea cannot be deferred.',
      expected: 'Unpublished or Deferred',
      actual: 'Archived',
    });
  }
  if (draft.disposition.state === 'Published') {
    return err<DomainError>({
      code: 'Forbidden',
      reason: 'This idea already produced work, so it cannot be deferred as unpublished.',
    });
  }

  return ok<IdeaDraft>({
    ...draft,
    disposition: Object.freeze({ state: 'Deferred', deferredAt: input.at, reason: input.reason }),
  });
}

/**
 * Archives an unpublished idea (F06-AC5).
 *
 * Archiving is a pure bookkeeping move: it creates no ticket and consumes no
 * coding run, which is why it needs no side effect at all. An idea that produced
 * work is refused rather than archived, so a request with live code or a live
 * ticket behind it cannot disappear from the record.
 */
export function archiveIdea(
  draft: IdeaDraft,
  input: { readonly by: string; readonly at: string; readonly reason: string | null },
): Result<IdeaDraft, DomainError> {
  if (draft.disposition.state === 'Published') {
    const { workItemIds, codingRunIds } = draft.disposition;
    return err<DomainError>({
      code: 'Forbidden',
      reason:
        `This idea produced work (${workItemIds.length} work item(s), ${codingRunIds.length} coding run(s)) and cannot be archived.`,
    });
  }
  if (draft.disposition.state === 'Archived') {
    return err<DomainError>({
      code: 'Conflict',
      reason: 'This idea is already archived.',
      expected: 'Unpublished, Deferred',
      actual: 'Archived',
    });
  }

  return ok<IdeaDraft>({
    ...draft,
    disposition: Object.freeze({
      state: 'Archived',
      archivedAt: input.at,
      archivedBy: input.by,
      reason: input.reason,
    }),
  });
}

export type RelatednessReason =
  | 'IdenticalRawRequest'
  | 'SharedSubjectTerms'
  | 'SharedReproductionDetail'
  | 'SameProject'
  | 'SharedNotes'
  | 'NoOverlap';

/** What the owner may choose about related work (F06-AC4). */
export type RelatedWorkChoice = 'LinkToExisting' | 'ExtendExisting' | 'CreateNewIssue';

/**
 * A resemblance report, not a decision.
 *
 * `mergeable` and `discardable` are literal `false` and `disposition` is a single
 * literal, so no caller can read a merge or discard out of a perfect score. The
 * score exists to order a list the owner reads; the choice stays with the owner
 * (F06-AC4).
 */
export interface RelatednessReport {
  readonly leftIdeaId: IdeaId;
  readonly rightIdeaId: IdeaId;
  readonly score: number;
  readonly reasons: readonly RelatednessReason[];
  readonly mergeable: false;
  readonly discardable: false;
  readonly disposition: 'OwnerChoiceRequired';
  readonly ownerChoices: readonly RelatedWorkChoice[];
}

const OWNER_CHOICES: readonly RelatedWorkChoice[] = Object.freeze([
  'LinkToExisting',
  'ExtendExisting',
  'CreateNewIssue',
]);

/**
 * Words that carry no information about what an idea is *about*.
 *
 * Request scaffolding such as "add", "make", "want" and articles appears in
 * nearly every captured request, so two unrelated ideas would share those terms
 * and score as similar. Dropping them leaves the words that name the subject.
 */
const STOP_TERMS: ReadonlySet<string> = new Set([
  'a', 'about', 'add', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can',
  'could', 'do', 'does', 'for', 'from', 'get', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'like', 'make', 'me', 'my', 'need', 'not', 'now', 'of', 'on', 'one', 'only', 'or', 'our', 'out',
  'over', 'please', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'to', 'up', 'us', 'very', 'want', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

function ideaTerms(text: string | null): ReadonlySet<string> {
  if (text === null) return new Set<string>();
  const terms = new Set<string>();
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (token.length < 2 || STOP_TERMS.has(token)) continue;
    terms.add(token);
  }
  return terms;
}

function diceCoefficient(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const term of left) {
    if (right.has(term)) shared += 1;
  }
  return (2 * shared) / (left.size + right.size);
}

function reproductionOf(request: IdeaRequest): string | null {
  return request.kind === 'Bug' ? request.detail.reproduction : null;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Scores how similar two ideas are, so possibly-related work can be shown before
 * publication (F06-AC4).
 *
 * The score is a pure function of the two drafts and is deliberately bounded to
 * one. Signals are weighted so that an exact duplicate reaches exactly 1 and any
 * other pair stays below it, which keeps "these look the same" distinguishable
 * from "these are the same request". No output of this function merges,
 * discards or links anything; an identical request still returns
 * `OwnerChoiceRequired`.
 */
export function relatedness(left: IdeaDraft, right: IdeaDraft): RelatednessReport {
  const reasons: RelatednessReason[] = [];
  let score: number;

  if (left.rawRequest === right.rawRequest) {
    reasons.push('IdenticalRawRequest');
    score = 1;
  } else {
    const sharedSubject = diceCoefficient(ideaTerms(left.rawRequest), ideaTerms(right.rawRequest));
    const sharedReproduction = diceCoefficient(
      ideaTerms(reproductionOf(left.request)),
      ideaTerms(reproductionOf(right.request)),
    );
    const sameProject = left.projectId !== null && left.projectId === right.projectId;
    const sharedNotes = diceCoefficient(ideaTerms(left.notes), ideaTerms(right.notes));

    score = 0.6 * sharedSubject + 0.2 * sharedReproduction + 0.1 * (sameProject ? 1 : 0) + 0.1 * sharedNotes;

    if (sharedSubject > 0) reasons.push('SharedSubjectTerms');
    if (sharedReproduction > 0) reasons.push('SharedReproductionDetail');
    if (sameProject) reasons.push('SameProject');
    if (sharedNotes > 0) reasons.push('SharedNotes');
  }

  if (reasons.length === 0) reasons.push('NoOverlap');

  return {
    leftIdeaId: left.ideaId,
    rightIdeaId: right.ideaId,
    score: round4(Math.min(1, Math.max(0, score))),
    reasons,
    mergeable: false,
    discardable: false,
    disposition: 'OwnerChoiceRequired',
    ownerChoices: OWNER_CHOICES,
  };
}

/**
 * Ranks candidate ideas by resemblance, strongest first.
 *
 * The candidate list is supplied by the caller, and the threshold is the
 * caller's, because deciding what counts as possibly related is the owner's call
 * (F06-AC4). The self-comparison is dropped so an idea is never reported as
 * related to itself.
 */
export function rankRelatedness(
  draft: IdeaDraft,
  candidates: readonly IdeaDraft[],
  minimumScore = 0.1,
): readonly RelatednessReport[] {
  return candidates
    .filter((candidate) => candidate.ideaId !== draft.ideaId)
    .map((candidate) => relatedness(draft, candidate))
    .filter((report) => report.score >= minimumScore)
    .sort((first, second) => second.score - first.score);
}