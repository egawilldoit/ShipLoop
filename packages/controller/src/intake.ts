/**
 * Idea capture, the concise brief, clarification and the owner's disposition of
 * both (F06-AC1, F06-AC2, F06-AC3, F06-AC4, F06-AC5, F07-AC1, F07-AC2, F07-AC3,
 * F01-AC1).
 *
 * The policy in `packages/domain/src/intake` decides what an idea may become. This
 * layer is what an API call passes through to reach it, and it owns three things
 * that belong to no other layer.
 *
 * Authorization. Every use case demands an owner and refuses before it reads a
 * private row, so the transport's session guard and this check are two
 * independent reasons a non-owner learns nothing (F01-AC1). The domain holds no
 * caller at all; putting the check here is what lets `IdeaDraft` stay a plain
 * value a test can build without inventing an owner, and it is why the reads reach
 * the same gate as the writes instead of a weaker one.
 *
 * Attachment bytes. F06-AC1 requires an attachment to be a named file under the
 * artifact root rather than content inlined into a row, so this is the layer that
 * touches the filesystem. The name is checked twice on purpose: the controller
 * resolves it against the root and confirms it stays inside, which is what makes
 * the write safe, and the domain refuses a separator, a `..` segment, an absolute
 * prefix and a NUL, which is what makes the refusal legible to the owner in words.
 *
 * Write ordering. The bytes are written first and the row second, because a row
 * naming a file that does not exist is a broken record while a file with no row is
 * only an unreferenced file. When the row write fails the file is removed and the
 * refusal is returned, so the durable state and the reported outcome agree and a
 * failed save never reads as success (F06-AC2).
 *
 * What is deliberately absent: no method creates a ticket or consumes a coding run.
 * `archiveIdea` exists so an owner can set a request aside without either happening
 * (F06-AC5), and related work is reported with a literal `mergeable: false` and a
 * single literal `disposition: 'OwnerChoiceRequired'`, so there is no path here that
 * could act on the resemblance and merge anything behind the owner's back (F06-AC4).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  appendAttachment,
  applyProposal,
  createIdea,
  err,
  generateClarifyingQuestions,
  invalid,
  isSupportedMediaType,
  ok,
  rankRelatedness,
} from '@shiploop/domain';
import type {
  AcceptanceCriterion,
  Ambiguity,
  AmbiguityImpact,
  AmbiguityKind,
  AttachmentMediaType,
  Brief,
  BriefSections,
  DomainError,
  IdeaDraft,
  IdeaId,
  InvalidError,
  ProjectId,
  RelatednessReport,
  Result,
  ValidatedBriefProposal,
} from '@shiploop/domain';
import type { IdeaExport, IdeaRepository, IntakeRepository } from '@shiploop/storage';
import type { ControllerClock, OwnerActor } from './profiles.ts';

/** Where attachment bytes are written, or null when no artifact store is configured. */
export type IntakeArtifactRoot = string | null;

/**
 * The conversation turn kinds the domain models, as this layer reports them.
 *
 * Turns are returned in the order they were appended and are never rewritten, so
 * the owner's original words and every later decision stay readable together
 * (F07-AC3).
 */
export type ClarificationTurnKind = 'RawRequest' | 'Question' | 'Answer' | 'Correction';

/** One turn of the owner conversation, as the transport reads it (F07-AC3). */
export interface IntakeTurnView {
  readonly kind: ClarificationTurnKind;
  readonly at: string;
  readonly text: string;
  /** The question or correction this turn names, or null when it names none. */
  readonly reference: string | null;
}

/**
 * A question that was considered and not asked (F07-AC2).
 *
 * Reported rather than dropped, so the owner can see that a candidate existed and
 * why it did not survive. An empty list is the honest answer for a request that
 * already settles its own ambiguities.
 */
export interface RejectedCandidateView {
  readonly topic: string;
  readonly rejection: string;
  readonly explanation: string;
}

/** A stored clarifying question, including why it was worth the owner's time (F07-AC2). */
export interface ClarifyingQuestionView {
  readonly questionId: string;
  readonly topic: string;
  readonly prompt: string;
  readonly readings: readonly string[];
  /** Why the answer changes the work, so the question is not an interview (F07-AC2). */
  readonly whyMaterial: string;
  /** Whether an enumerated ambiguity or an unobservable criterion earned it (F07-AC2). */
  readonly origin: 'Ambiguity' | 'UnobservableCriterion';
  readonly state: 'Open' | 'Answered';
  readonly answer: string | null;
  readonly askedAt: string;
  readonly answeredAt: string | null;
}

/** One brief version, including the criteria a correction withdrew from it (F07-AC3). */
export interface BriefVersionView {
  readonly version: number;
  readonly state: 'Proposed' | 'Agreed';
  readonly authoredBy: string;
  readonly authoredAt: string;
  readonly supersedesVersion: number | null;
  readonly rawRequestFingerprint: string;
  readonly sections: BriefSections;
  readonly agreedBy: string | null;
  readonly agreedAt: string | null;
  readonly withdrawnCriterionIds: readonly string[];
}

/**
 * The current brief and every version before it.
 *
 * `versions` is oldest first, so an owner reads what they agreed to before a
 * correction as readily as what the correction produced (F07-AC3).
 */
export interface BriefView {
  readonly briefId: string | null;
  readonly ideaId: IdeaId;
  readonly currentVersion: number | null;
  readonly current: BriefVersionView | null;
  readonly versions: readonly BriefVersionView[];
}

/** Everything one captured request currently consists of. */
export interface IntakeDetailView {
  readonly idea: IdeaDraft;
  readonly brief: BriefView;
  readonly questions: readonly ClarifyingQuestionView[];
  readonly rejected: readonly RejectedCandidateView[];
  readonly turns: readonly IntakeTurnView[];
}

/** A captured request as the transport reports it (F06-AC1, F06-AC3). */
export interface CapturedIdeaView {
  readonly idea: IdeaDraft;
  /** Absent until a summary is generated, so "no summary yet" is not "an empty summary". */
  readonly summary: IdeaDraft['summary'];
  readonly attachments: readonly IdeaDraft['attachments'][number][];
  readonly disposition: IdeaDraft['disposition']['state'];
}

/** How similar another captured request is to this one, and what the owner may do about it. */
export interface RelatedWorkView {
  readonly candidate: CapturedIdeaView;
  readonly report: RelatednessReport;
}

/** What the owner may choose about possibly-related work (F06-AC4). */
export const RELATED_WORK_CHOICES = ['LinkToExisting', 'ExtendExisting', 'CreateNewIssue'] as const;

export type RelatedWorkChoice = (typeof RELATED_WORK_CHOICES)[number];

/**
 * What the owner's choice about related work actually did (F06-AC4).
 *
 * Both requests are read again after the choice is recorded and reported side by
 * side, so the answer to "did it merge anything" is a pair of unchanged
 * dispositions rather than a promise. A slice with no publication path cannot
 * honestly claim a link was created, so it claims only what it can prove.
 */
export interface RelatedWorkChoiceView {
  readonly ideaId: IdeaId;
  readonly candidateIdeaId: IdeaId;
  readonly choice: RelatedWorkChoice;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly merged: false;
  readonly dispositionAfterChoice: {
    readonly idea: IdeaDraft['disposition']['state'];
    readonly candidate: IdeaDraft['disposition']['state'];
  };
}

/** One acceptance criterion as a caller submits it (F07-AC1). */
export interface AcceptanceCriterionInput {
  readonly id: string;
  readonly text: string;
  readonly verification?: string | null;
}

/**
 * The seven brief sections as a caller submits them (F07-AC1).
 *
 * Every member is required and every list may be empty, because an absent section
 * and an empty one mean different things to `applyProposal`: a missing section is a
 * proposal that is not a brief, while an empty list is a section that is present and
 * says nothing yet.
 */
export interface BriefSectionsInput {
  readonly problem: string;
  readonly desiredOutcome: string;
  readonly includedBehaviour: readonly string[];
  readonly excludedBehaviour: readonly string[];
  readonly assumptions: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionInput[];
  readonly unresolvedQuestions: readonly string[];
}

/** One ambiguity the caller believes the request leaves open (F07-AC2). */
export interface AmbiguityInput {
  readonly kind: AmbiguityKind;
  readonly topic: string;
  readonly readings: readonly string[];
  readonly answeredBy: readonly string[];
  readonly impact: AmbiguityImpact;
  readonly evidence: string;
}

export interface CaptureIdeaCommand {
  readonly rawRequest: string;
  readonly kind: 'FeatureRequest' | 'Bug';
  readonly projectId?: string | null;
  readonly notes?: string | null;
  readonly detail?: {
    readonly expected: string | null;
    readonly actual: string | null;
    readonly reproduction: string | null;
  } | null;
}

export interface AttachFileCommand {
  readonly ideaId: IdeaId;
  readonly name: string;
  readonly mediaType: string;
  readonly content: string;
}

export interface RecordSummaryCommand {
  readonly ideaId: IdeaId;
  readonly text: string;
  readonly generatedBy: string;
}

export interface DispositionCommand {
  readonly ideaId: IdeaId;
  readonly reason: string | null;
}

export interface RelatedWorkRequest {
  readonly ideaId: IdeaId;
  readonly minimumScore?: number;
}

export interface RecordRelatedWorkChoiceCommand {
  readonly ideaId: IdeaId;
  readonly candidateIdeaId: IdeaId;
  readonly choice: string;
  readonly minimumScore?: number;
}

export interface DraftBriefCommand {
  readonly ideaId: IdeaId;
  readonly authoredBy: 'Owner' | 'ClarificationModel' | 'OwnerEdit';
  readonly sections: BriefSectionsInput;
  /** The version this draft was written against, or null for a first version (F07-AC3). */
  readonly basedOnBriefVersion: number | null;
}

export interface AskClarifyingQuestionsCommand {
  readonly ideaId: IdeaId;
  /** The proposed sections to ask about; clarification runs before they are validated (F07-AC2). */
  readonly sections: BriefSectionsInput;
  readonly ambiguities: readonly AmbiguityInput[];
}

export interface AnswerClarifyingQuestionCommand {
  readonly ideaId: IdeaId;
  readonly questionId: string;
  readonly answer: string;
}

export interface ApplyCorrectionCommand {
  readonly ideaId: IdeaId;
  readonly text: string;
  readonly sections: BriefSectionsInput;
  /** The version the owner corrected, refused when it is no longer current (F07-AC3). */
  readonly basedOnBriefVersion: number;
}

/** What a correction changed, with the version it superseded (F07-AC3). */
export interface CorrectionView {
  readonly ideaId: IdeaId;
  readonly currentVersion: BriefVersionView;
  readonly priorVersion: BriefVersionView;
  readonly withdrawnCriterionIds: readonly string[];
}

/** One round of generated questions and the candidates that were declined (F07-AC2). */
export interface ClarificationRoundView {
  readonly ideaId: IdeaId;
  readonly questions: readonly ClarifyingQuestionView[];
  readonly rejected: readonly RejectedCandidateView[];
}

export interface IntakeUseCaseDeps {
  readonly clock: ControllerClock;
  readonly intake: IntakeRepository;
  /**
   * The idea index, used only to enumerate identities.
   *
   * Reads go through `IntakeRepository` because it is the only reader that returns a
   * draft with the domain's derived disposition and the summary provenance beside
   * the request, which is the pairing F06-AC1 requires. This repository contributes
   * the ordered identity list and nothing else.
   */
  readonly ideas: IdeaRepository;
  /**
   * Directory attachment bytes are written under, or null when none is configured.
   *
   * Null is a refusal rather than a fallback to a temporary directory: an owner's
   * attachment written somewhere the deployment did not name would be a file the
   * owner cannot find, cannot back up and cannot delete through the product
   * (F01-AC3, F06-AC1).
   */
  readonly artifactRoot: IntakeArtifactRoot;
}

/** The prefix that makes every brief for one idea share one identity and one version chain. */
const BRIEF_ID_PREFIX = 'brief-';

const DEFAULT_MINIMUM_SCORE = 0.1;

function field(path: string, message: string): InvalidError {
  return invalid(message, [{ path, message }]);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRelatedWorkChoice(value: string): value is RelatedWorkChoice {
  return (RELATED_WORK_CHOICES as readonly string[]).includes(value);
}

/**
 * The one gate every intake request passes (F01-AC1).
 *
 * It runs before any private row is read, so a refused caller learns nothing from
 * the shape of the refusal. Both halves are checked because an actor can name an
 * owner without being one, and a role of `Owner` with no owner identity is not a
 * caller this layer can attribute a write to (F32-AC1).
 */
export function requireIntakeOwner(actor: OwnerActor): Result<true, DomainError> {
  if (actor.role !== 'Owner' || actor.ownerId === null) {
    return err({
      code: 'Forbidden',
      reason: `Only the owner may use intake; the ${actor.role} role may not (F01-AC1).`,
    });
  }
  return ok(true);
}

/**
 * Where a named attachment would be written, proved to be inside the root (F06-AC1).
 *
 * The containment check is what makes the write safe and runs before any byte is
 * written, so a traversal attempt leaves nothing to clean up. It is deliberately
 * stricter than the domain's list: this function is the filesystem boundary, and a
 * name it would have to reason about platform-specifically is a name it refuses.
 */
export function resolveAttachmentPath(
  artifactRoot: IntakeArtifactRoot,
  name: string,
): Result<{ readonly path: string }, DomainError> {
  if (artifactRoot === null) {
    return err({
      code: 'Unavailable',
      reason: 'No artifact store is configured, so an attachment cannot be written (F01-AC3).',
    });
  }
  if (name === '' || name === '.' || name === '..') {
    return err(field('name', 'An attachment needs a file name that is not a path segment (F06-AC1).'));
  }
  if (name.includes('/') || name.includes('\\')) {
    return err(
      field(
        'name',
        'A file name cannot contain a path separator; an attachment is a named file directly under the artifact root (F06-AC1).',
      ),
    );
  }
  if (name.includes('\u0000') || name !== name.trim() || isAbsolute(name) || name.startsWith('~')) {
    return err(field('name', 'A file name must be a plain name relative to the artifact root (F06-AC1).'));
  }

  const root = resolve(artifactRoot);
  const target = resolve(join(root, name));
  if (target !== root && !target.startsWith(root + sep)) {
    return err(field('name', `"${name}" would be written outside the artifact root and was refused (F06-AC1).`));
  }
  return ok({ path: target });
}

/**
 * Builds the intake use cases.
 *
 * Everything they touch is injected: the clock, the two repositories and the
 * artifact root. A test therefore records no ambient instant, writes no real
 * provider and reaches no network, while the rows they read and write come from the
 * real migrated schema through the real `migrate` (F06-AC2).
 */
export function createIntakeUseCases(deps: IntakeUseCaseDeps) {
  const briefIdFor = (ideaId: IdeaId): string => `${BRIEF_ID_PREFIX}${ideaId}`;

  /**
   * A stored brief version with the criteria a later correction withdrew from it.
   *
   * The withdrawn set is computed from the versions themselves rather than stored,
   * because "what changed" is a relation between two records and the schema holds
   * no place to put it. Computing it here means the answer cannot disagree with the
   * two versions it is derived from (F07-AC3).
   */
  const toVersionView = (brief: Brief, next?: Brief): BriefVersionView => {
    const withdrawn =
      next === undefined
        ? []
        : brief.sections.acceptanceCriteria
            .map((criterion) => criterion.id)
            .filter((id) => !next.sections.acceptanceCriteria.some((criterion) => criterion.id === id));
    return {
      version: brief.version,
      state: brief.state,
      authoredBy: brief.authoredBy,
      authoredAt: brief.authoredAt,
      supersedesVersion: brief.supersedesVersion,
      rawRequestFingerprint: brief.rawRequestFingerprint,
      sections: brief.sections,
      agreedBy: brief.state === 'Agreed' ? brief.agreedBy : null,
      agreedAt: brief.state === 'Agreed' ? brief.agreedAt : null,
      withdrawnCriterionIds: withdrawn,
    };
  };

  const toCapturedView = (draft: IdeaDraft): CapturedIdeaView => {
    return {
      idea: draft,
      summary: draft.summary,
      attachments: [...draft.attachments],
      disposition: draft.disposition.state,
    };
  };

  const toQuestionView = (record: {
    readonly questionId: string;
    readonly topic: string;
    readonly prompt: string;
    readonly readings: readonly string[];
    readonly whyMaterial: string;
    readonly origin: 'Ambiguity' | 'UnobservableCriterion';
    readonly state: 'Open' | 'Answered';
    readonly answer: string | null;
    readonly createdAt: string;
    readonly answeredAt: string | null;
  }): ClarifyingQuestionView => {
    return {
      questionId: record.questionId,
      topic: record.topic,
      prompt: record.prompt,
      readings: [...record.readings],
      whyMaterial: record.whyMaterial,
      origin: record.origin,
      state: record.state,
      answer: record.answer,
      askedAt: record.createdAt,
      answeredAt: record.answeredAt,
    };
  };

  /**
   * Captures the owner's own words as a durable request (F06-AC1, F06-AC2, F06-AC3).
   *
   * The raw request is the only required field and every optional field may be
   * absent, because refusing a partial request is precisely how an owner loses one.
   * Nothing here can replace the stored text afterwards: the repository has no
   * statement that writes `raw_request` after capture.
   *
   * The RawRequest turn is appended after the capture because it references the idea
   * row. When it cannot be written the whole call reports failure, because that turn
   * is what a later correction binds to and a capture with an empty conversation
   * would refuse every correction with a prerequisite the owner cannot act on.
   */
  const captureIdea = (command: CaptureIdeaCommand, actor: OwnerActor): Result<CapturedIdeaView, DomainError> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    const capturedAt = deps.clock.now();
    const created = createIdea({
      ideaId: randomUUID() as IdeaId,
      rawRequest: command.rawRequest,
      capturedAt,
      kind: command.kind,
      projectId: command.projectId === undefined || command.projectId === null ? null : (command.projectId as ProjectId),
      notes: command.notes === undefined ? null : command.notes,
      detail:
        command.detail === undefined || command.detail === null
          ? null
          : {
              expected: command.detail.expected,
              actual: command.detail.actual,
              reproduction: command.detail.reproduction,
            },
    });
    if (!created.ok) return err(created.error);

    const captured = deps.intake.capture(created.value);
    if (!captured.ok) return err(captured.error);

    const recorded = deps.intake.recordTurn(captured.value.ideaId, {
      kind: 'RawRequest',
      at: capturedAt,
      text: captured.value.rawRequest,
    });
    if (!recorded.ok) return err(recorded.error);

    return ok(toCapturedView(captured.value));
  };

  /**
   * Every captured request, oldest first.
   *
   * The index supplies identities and the durable repository supplies each draft, so
   * a listed request carries the same disposition and summary provenance a direct
   * read does. A row the index lists but the repository cannot read is reported as a
   * failure rather than skipped: silently omitting a request the owner captured is
   * the same loss as refusing to capture it (F06-AC2).
   */
  const listIdeas = (actor: OwnerActor): Result<readonly CapturedIdeaView[], DomainError> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    const listed = deps.ideas.list({ projectId: null, state: null });
    if (!listed.ok) return err(listed.error);

    const views: CapturedIdeaView[] = [];
    for (const record of listed.value) {
      const draft = deps.intake.read(record.ideaId);
      if (!draft.ok) return err(draft.error);
      views.push(toCapturedView(draft.value));
    }
    return ok(views);
  };

  /** One request with everything recorded against it: brief, questions and conversation. */
  const getIdea = (ideaId: IdeaId, actor: OwnerActor): Result<IntakeDetailView, DomainError> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);
    return readDetail(ideaId);
  };

  const readDetail = (ideaId: IdeaId): Result<IntakeDetailView, DomainError> => {
    const idea = deps.intake.read(ideaId);
    if (!idea.ok) return err(idea.error);
    const versions = deps.intake.listBriefs(ideaId);
    if (!versions.ok) return err(versions.error);
    const questions = deps.intake.listQuestions(ideaId);
    if (!questions.ok) return err(questions.error);
    const conversation = deps.intake.conversation(ideaId);
    if (!conversation.ok) return err(conversation.error);
    const exported = deps.intake.exportIdea(ideaId);
    if (!exported.ok) return err(exported.error);

    const ordered = [...versions.value];
    const currentIndex = ordered.length - 1;
    const versionViews = ordered.map((brief, index) => toVersionView(brief, ordered[index + 1]));
    const currentBrief = ordered[currentIndex];

    const turns: IntakeTurnView[] = conversation.value.turns.map((turn) => {
      if (turn.kind === 'Question') {
        return { kind: turn.kind, at: turn.at, text: turn.prompt, reference: turn.questionId };
      }
      if (turn.kind === 'Answer') {
        return { kind: turn.kind, at: turn.at, text: turn.text, reference: turn.questionId };
      }
      if (turn.kind === 'Correction') {
        return { kind: turn.kind, at: turn.at, text: turn.text, reference: turn.correctionId };
      }
      return { kind: turn.kind, at: turn.at, text: turn.text, reference: null };
    });

    return ok({
      idea: idea.value,
      brief: {
        briefId: currentBrief?.briefId ?? null,
        ideaId,
        currentVersion: currentBrief?.version ?? null,
        current: currentBrief === undefined ? null : (versionViews[currentIndex] ?? null),
        versions: versionViews,
      },
      questions: questions.value.map(toQuestionView),
      rejected: exported.value.rejectedQuestions.map((entry) => ({
        topic: entry.topic,
        rejection: entry.rejection,
        explanation: entry.explanation,
      })),
      turns,
    });
  };

  /**
   * Writes a named attachment under the artifact root and references it (F06-AC1).
   *
   * Bytes travel as text, so the request body cannot become an alternative content
   * store: what crosses this boundary is a name, a media type and a byte count, and
   * the file itself lives where a backup can reach it.
   *
   * The domain's own attachment rules run first, so a duplicate name or an oversized
   * file is refused in the owner's words before anything is written; the repository
   * runs them again inside its transaction, which is what makes the check hold against
   * a concurrent capture rather than only against this call.
   *
   * The file is written before the row so a row can never name a missing file, and
   * the row is written before success is reported so a refused save is never read as
   * a saved one. A refusal from the row write removes the file again, which is why
   * the write order does not accumulate orphan artifacts.
   */
  const attachFile = async (
    command: AttachFileCommand,
    actor: OwnerActor,
  ): Promise<Result<CapturedIdeaView, DomainError>> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    const existing = deps.intake.read(command.ideaId);
    if (!existing.ok) return err(existing.error);

    if (!isSupportedMediaType(command.mediaType)) {
      return err(field('mediaType', `"${command.mediaType}" is not a supported attachment type (F06-AC1).`));
    }
    const mediaType: AttachmentMediaType = command.mediaType;
    const placement = resolveAttachmentPath(deps.artifactRoot, command.name);
    if (!placement.ok) return err(placement.error);

    const bytes = Buffer.from(command.content, 'utf8');
    const addedAt = deps.clock.now();
    const preflight = appendAttachment(existing.value, {
      name: command.name,
      mediaType,
      byteSize: bytes.byteLength,
      addedAt,
    });
    if (!preflight.ok) return err(preflight.error);

    if (bytes.byteLength === 0) {
      return err(field('content', 'An attachment must carry the content it names, not an empty file (F06-AC1).'));
    }

    const root = deps.artifactRoot;
    if (root === null) {
      return err({ code: 'Unavailable', reason: 'No artifact store is configured (F01-AC3).' });
    }
    try {
      await mkdir(root, { recursive: true });
      await writeFile(placement.value.path, bytes, { flag: 'wx' });
    } catch (error) {
      return err({
        code: 'Unavailable',
        reason: `The attachment could not be written under the artifact root: ${describe(error)}`,
      });
    }

    const appended = deps.intake.addAttachment({
      ideaId: command.ideaId,
      name: command.name,
      mediaType,
      byteSize: bytes.byteLength,
      addedAt,
    });
    if (!appended.ok) {
      await removeQuietly(placement.value.path);
      return err(appended.error);
    }

    return ok(toCapturedView(appended.value));
  };

  /**
   * Records a generated summary beside the raw request (F06-AC1).
   *
   * The domain's `summarizeDraft` has no parameter through which the request text
   * could be replaced, and the repository's statement names only the four summary
   * columns, so recording a summary cannot shorten the owner's own words.
   */
  const recordSummary = (
    command: RecordSummaryCommand,
    actor: OwnerActor,
  ): Result<CapturedIdeaView, DomainError> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    const summarized = deps.intake.summarize({
      ideaId: command.ideaId,
      text: command.text,
      generatedBy: command.generatedBy,
      at: deps.clock.now(),
    });
    if (!summarized.ok) return err(summarized.error);
    return ok(toCapturedView(summarized.value));
  };

  /**
   * Archives a request that produced no work (F06-AC5).
   *
   * Pure bookkeeping: no ticket is created and no coding run is consumed, which is
   * why it needs no side effect. An idea that produced work is refused rather than
   * archived, so a request with live code or a live ticket behind it cannot vanish
   * from the record.
   */
  const archiveIdea = (
    command: DispositionCommand,
    actor: OwnerActor,
  ): Result<CapturedIdeaView, DomainError> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    const archived = deps.intake.archive(command.ideaId, actor.actorId, deps.clock.now(), command.reason);
    if (!archived.ok) return err(archived.error);
    return ok(toCapturedView(archived.value));
  };

  /** Defers an unpublished request without publishing it or consuming a coding run (F06-AC5). */
  const deferIdea = (
    command: DispositionCommand,
    actor: OwnerActor,
  ): Result<CapturedIdeaView, DomainError> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    const deferred = deps.intake.defer(command.ideaId, deps.clock.now(), command.reason);
    if (!deferred.ok) return err(deferred.error);
    return ok(toCapturedView(deferred.value));
  };

  /**
   * Possibly-related work, before anything is published (F06-AC4).
   *
   * The resemblance is scored by the domain and reported as a decision the owner has
   * not made yet: `mergeable` and `discardable` are literal `false` and the
   * disposition is one literal, so no caller can read a merge out of a perfect
   * score. The threshold is the caller's because deciding what counts as possibly
   * related is the owner's call, not a constant this layer would pick for them.
   */
  const findRelatedWork = (
    request: RelatedWorkRequest,
    actor: OwnerActor,
  ): Result<readonly RelatedWorkView[], DomainError> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    const idea = deps.intake.read(request.ideaId);
    if (!idea.ok) return err(idea.error);
    const candidates = candidatesFor(idea.value);
    if (!candidates.ok) return err(candidates.error);

    const reports = rankRelatedness(
      idea.value,
      candidates.value,
      request.minimumScore === undefined ? DEFAULT_MINIMUM_SCORE : request.minimumScore,
    );
    const byId = new Map(candidates.value.map((candidate) => [candidate.ideaId, candidate]));
    const views: RelatedWorkView[] = [];
    for (const report of reports) {
      const candidate = byId.get(report.rightIdeaId);
      if (candidate !== undefined) views.push({ candidate: toCapturedView(candidate), report });
    }
    return ok(views);
  };

  /**
   * Records the owner's explicit choice about related work, and proves it merged
   * nothing (F06-AC4).
   *
   * The choice is accepted only when the resemblance is real at the caller's own
   * threshold, so a choice cannot be recorded against an unrelated request. Both
   * requests are read again afterwards and their dispositions reported, because the
   * only property this slice can honestly claim about a link is that no request was
   * merged, discarded or published by making it. The owner holds the decision; the
   * code holds no way to act on it.
   */
  const recordRelatedWorkChoice = (
    command: RecordRelatedWorkChoiceCommand,
    actor: OwnerActor,
  ): Result<RelatedWorkChoiceView, DomainError> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    if (!isRelatedWorkChoice(command.choice)) {
      return err(
        field(
          'choice',
          `"${command.choice}" is not a choice this product offers. Choose ${RELATED_WORK_CHOICES.join(', ')} (F06-AC4).`,
        ),
      );
    }
    if (command.candidateIdeaId === command.ideaId) {
      return err(field('candidateIdeaId', 'A request cannot be related to itself (F06-AC4).'));
    }

    const related = findRelatedWork(
      {
        ideaId: command.ideaId,
        ...(command.minimumScore === undefined ? {} : { minimumScore: command.minimumScore }),
      },
      actor,
    );
    if (!related.ok) return err(related.error);

    const report = related.value.find((entry) => entry.candidate.idea.ideaId === command.candidateIdeaId);
    if (report === undefined) {
      return err({
        code: 'NotFound',
        reason: 'That request is not reported as possibly related to this one, so there is nothing to choose about (F06-AC4).',
      });
    }

    const idea = deps.intake.read(command.ideaId);
    if (!idea.ok) return err(idea.error);
    const candidate = deps.intake.read(command.candidateIdeaId);
    if (!candidate.ok) return err(candidate.error);

    return ok({
      ideaId: command.ideaId,
      candidateIdeaId: command.candidateIdeaId,
      choice: command.choice,
      score: report.report.score,
      reasons: [...report.report.reasons],
      merged: false,
      dispositionAfterChoice: {
        idea: idea.value.disposition.state,
        candidate: candidate.value.disposition.state,
      },
    });
  };

  /**
   * Validates a submitted brief as a proposal (F07-AC1, F05-AC5).
   *
   * `applyProposal` is the only route structured output takes to reach a brief, and
   * it refuses a criterion that states a quality rather than a behaviour. Running it
   * here means the refusal arrives with the field path the owner's form needs, and
   * an unvalidated body never reaches the brief lifecycle.
   */
  const validateSections = (
    ideaId: IdeaId,
    sections: BriefSectionsInput,
    authoredBy: 'Owner' | 'ClarificationModel' | 'OwnerEdit',
    authoredAt: string,
    basedOnBriefVersion: number | null,
  ): Result<ValidatedBriefProposal, DomainError> => {
    const criteria: AcceptanceCriterion[] = sections.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      verification: criterion.verification === undefined ? null : criterion.verification,
    }));
    const proposal = applyProposal({
      kind: 'BriefProposal',
      ideaId,
      authoredBy,
      authoredAt,
      basedOnBriefVersion,
      sections: {
        problem: sections.problem,
        desiredOutcome: sections.desiredOutcome,
        includedBehaviour: [...sections.includedBehaviour],
        excludedBehaviour: [...sections.excludedBehaviour],
        assumptions: [...sections.assumptions],
        acceptanceCriteria: criteria,
        unresolvedQuestions: [...sections.unresolvedQuestions],
      },
    });
    if (!proposal.ok) return err(proposal.error);
    return ok(proposal.value);
  };

  /**
   * Appends a first brief for a request (F07-AC1, F07-AC3).
   *
   * Refused when a brief already exists. A second version is a correction, and a
   * correction appends a version with the owner's own words attached to it; a second
   * silent draft would be a rewrite with no record of what it replaced, which is the
   * history F07-AC3 exists to keep.
   */
  const draftBrief = (command: DraftBriefCommand, actor: OwnerActor): Result<BriefVersionView, DomainError> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    const idea = deps.intake.read(command.ideaId);
    if (!idea.ok) return err(idea.error);

    const existing = deps.intake.currentBrief(command.ideaId);
    if (!existing.ok) return err(existing.error);
    if (existing.value !== null) {
      return err({
        code: 'Conflict',
        reason: 'This request already has a brief. Record a correction so the new version states what it changed (F07-AC3).',
        expected: 'no brief yet',
        actual: `version ${existing.value.version}`,
      });
    }
    if (command.basedOnBriefVersion !== null) {
      return err({
        code: 'Conflict',
        reason: 'A first brief supersedes no version.',
        expected: 'null',
        actual: String(command.basedOnBriefVersion),
      });
    }

    const validated = validateSections(command.ideaId, command.sections, command.authoredBy, deps.clock.now(), null);
    if (!validated.ok) return err(validated.error);

    const appended = deps.intake.draftAndAppend(briefIdFor(command.ideaId), idea.value, validated.value);
    if (!appended.ok) return err(appended.error);
    return ok(toVersionView(appended.value));
  };

  /**
   * Records owner agreement with the current brief version (F07-AC1, F05-AC5).
   *
   * Agreement is a statement about scope: it is not product acceptance, and it says
   * nothing about delivery or release. The version agreed is whichever is current at
   * the moment of the call, and the answer states which one that was so the record
   * cannot be read as agreeing to something newer.
   */
  const agreeBrief = (ideaId: IdeaId, actor: OwnerActor): Result<BriefVersionView, DomainError> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    const current = deps.intake.currentBrief(ideaId);
    if (!current.ok) return err(current.error);
    if (current.value === null) {
      return err({ code: 'NotFound', reason: 'This request has no brief to agree with yet (F07-AC1).' });
    }

    const agreed = deps.intake.agreeBrief(current.value.briefId, actor.actorId, deps.clock.now());
    if (!agreed.ok) return err(agreed.error);
    return ok(toVersionView(agreed.value));
  };

  /**
   * Generates the questions worth asking, and records the ones worth not asking
   * (F07-AC2).
   *
   * Clarification runs on the proposed sections rather than a validated brief,
   * because that is the only point at which a vague acceptance criterion can still
   * be caught; a brief that had passed validation could not contain one. Both the
   * asked and the declined candidates are rows, so the owner can see that something
   * was considered and why it was not put to them.
   */
  const askClarifyingQuestions = (
    command: AskClarifyingQuestionsCommand,
    actor: OwnerActor,
  ): Result<ClarificationRoundView, DomainError> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    const idea = deps.intake.read(command.ideaId);
    if (!idea.ok) return err(idea.error);
    const current = deps.intake.currentBrief(command.ideaId);
    if (!current.ok) return err(current.error);

    const ambiguities: Ambiguity[] = command.ambiguities.map((ambiguity) => ({
      kind: ambiguity.kind,
      topic: ambiguity.topic,
      readings: [...ambiguity.readings],
      answeredBy: [...ambiguity.answeredBy],
      impact: ambiguity.impact,
      evidence: ambiguity.evidence,
    }));

    const at = deps.clock.now();
    const round = generateClarifyingQuestions({
      briefId: current.value?.briefId ?? briefIdFor(command.ideaId),
      ideaId: command.ideaId,
      sections: {
        problem: command.sections.problem,
        desiredOutcome: command.sections.desiredOutcome,
        includedBehaviour: [...command.sections.includedBehaviour],
        excludedBehaviour: [...command.sections.excludedBehaviour],
        assumptions: [...command.sections.assumptions],
        acceptanceCriteria: command.sections.acceptanceCriteria.map((criterion) => ({
          id: criterion.id,
          text: criterion.text,
          verification: criterion.verification === undefined ? null : criterion.verification,
        })),
        unresolvedQuestions: [...command.sections.unresolvedQuestions],
      },
      ambiguities,
    });

    const asked: ClarifyingQuestionView[] = [];
    for (const question of round.questions) {
      const recorded = deps.intake.recordQuestion({
        ideaId: command.ideaId,
        briefId: current.value?.briefId ?? null,
        briefVersion: current.value?.version ?? null,
        question,
        at,
      });
      if (!recorded.ok) return err(recorded.error);
      const turn = deps.intake.recordTurn(command.ideaId, {
        kind: 'Question',
        at,
        questionId: recorded.value.questionId,
        prompt: question.prompt,
      });
      if (!turn.ok) return err(turn.error);
      asked.push(toQuestionView(recorded.value));
    }

    for (const rejected of round.rejected) {
      const recorded = deps.intake.recordRejectedQuestion({
        ideaId: command.ideaId,
        briefId: current.value?.briefId ?? null,
        briefVersion: current.value?.version ?? null,
        topic: rejected.topic,
        rejection: rejected.rejection,
        explanation: rejected.explanation,
        at,
      });
      if (!recorded.ok) return err(recorded.error);
    }

    return ok({ ideaId: command.ideaId, questions: asked, rejected: round.rejected });
  };

  /**
   * Records the owner's answer to an open question (F07-AC2).
   *
   * The question is located through the idea's own list rather than trusted from
   * the request, so an identifier from another request cannot be answered here. An
   * already-answered question is refused rather than rewritten, because the answer is
   * part of what the owner agreed to and a second answer would leave two.
   */
  const answerClarifyingQuestion = (
    command: AnswerClarifyingQuestionCommand,
    actor: OwnerActor,
  ): Result<ClarifyingQuestionView, DomainError> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    if (command.answer.trim() === '') {
      return err(field('answer', 'An answer must say something; an empty answer leaves the question open (F07-AC2).'));
    }

    const listed = deps.intake.listQuestions(command.ideaId);
    if (!listed.ok) return err(listed.error);
    const question = listed.value.find((entry) => entry.questionId === command.questionId);
    if (question === undefined) {
      return err({ code: 'NotFound', reason: 'That clarifying question does not belong to this request (F07-AC2).' });
    }
    if (question.state === 'Answered') {
      return err({
        code: 'Conflict',
        reason: 'That clarifying question has already been answered.',
        expected: 'Open',
        actual: 'Answered',
      });
    }

    const at = deps.clock.now();
    const answered = deps.intake.answerQuestion(command.questionId, command.answer, at);
    if (!answered.ok) return err(answered.error);
    const turn = deps.intake.recordTurn(command.ideaId, {
      kind: 'Answer',
      at,
      questionId: command.questionId,
      text: command.answer,
    });
    if (!turn.ok) return err(turn.error);
    return ok(toQuestionView(answered.value));
  };

  /**
   * Appends an owner correction as the next brief version (F07-AC3).
   *
   * The correction goes through the same validation as every other proposal, so an
   * edit cannot introduce a criterion nobody could check, and it is matched against
   * the version the owner said they were correcting: a correction built on a stale
   * brief is a `Conflict` rather than a silent overwrite of reasoning the owner never
   * saw. The prior version stays readable and the withdrawn criteria are named.
   */
  const applyOwnerCorrection = (
    command: ApplyCorrectionCommand,
    actor: OwnerActor,
  ): Result<CorrectionView, DomainError> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    const current = deps.intake.currentBrief(command.ideaId);
    if (!current.ok) return err(current.error);
    if (current.value === null) {
      return err({ code: 'NotFound', reason: 'There is no brief to correct; draft one first (F07-AC1).' });
    }
    if (current.value.version !== command.basedOnBriefVersion) {
      return err({
        code: 'Conflict',
        reason: 'This correction was written against a different brief version than the current one (F07-AC3).',
        expected: String(command.basedOnBriefVersion),
        actual: String(current.value.version),
      });
    }

    const at = deps.clock.now();
    const validated = validateSections(
      command.ideaId,
      command.sections,
      'OwnerEdit',
      at,
      command.basedOnBriefVersion,
    );
    if (!validated.ok) return err(validated.error);

    const appended = deps.intake.applyCorrection({
      ideaId: command.ideaId,
      brief: current.value,
      correctionId: randomUUID(),
      text: command.text,
      at,
      proposal: validated.value,
    });
    if (!appended.ok) return err(appended.error);

    const priorView = toVersionView(current.value, appended.value);
    return ok({
      ideaId: command.ideaId,
      currentVersion: toVersionView(appended.value),
      priorVersion: priorView,
      withdrawnCriterionIds: priorView.withdrawnCriterionIds,
    });
  };

  /**
   * A sanitized export of one request (F06-AC2).
   *
   * The repository applies its redaction rules and strips credential-shaped fields
   * from the assembled record, so this layer adds nothing and withholds nothing: what
   * the owner downloads is exactly what the store holds.
   */
  const exportIdea = (ideaId: IdeaId, actor: OwnerActor): Result<IdeaExport, DomainError> => {
    const permitted = requireIntakeOwner(actor);
    if (!permitted.ok) return err(permitted.error);
    return deps.intake.exportIdea(ideaId);
  };

  /**
   * Every candidate draft except the one being compared.
   *
   * `rankRelatedness` drops the self-comparison itself. Candidates are read through
   * the durable repository rather than taken from the index, because resemblance is
   * scored on the request text, the notes and the bug detail together, and an index
   * row that lacked the notes would score a different pair than the owner is shown.
   */
  const candidatesFor = (idea: IdeaDraft): Result<readonly IdeaDraft[], DomainError> => {
    const listed = deps.ideas.list({ projectId: null, state: null });
    if (!listed.ok) return err(listed.error);
    const drafts: IdeaDraft[] = [];
    for (const record of listed.value) {
      if (record.ideaId === idea.ideaId) continue;
      const draft = deps.intake.read(record.ideaId);
      if (!draft.ok) return err(draft.error);
      drafts.push(draft.value);
    }
    return ok(drafts);
  };

  async function removeQuietly(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      return;
    }
  }

  return {
    captureIdea,
    listIdeas,
    getIdea,
    attachFile,
    recordSummary,
    archiveIdea,
    deferIdea,
    findRelatedWork,
    recordRelatedWorkChoice,
    draftBrief,
    agreeBrief,
    askClarifyingQuestions,
    answerClarifyingQuestion,
    applyOwnerCorrection,
    exportIdea,
  };
}

export type IntakeUseCases = ReturnType<typeof createIntakeUseCases>;