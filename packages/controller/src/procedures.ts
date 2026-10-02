/**
 * Versioned procedures and the context they form (F05-AC1, F05-AC3, F05-AC4,
 * F05-AC5, F01-AC1).
 *
 * This layer is the boundary between "the model suggested something" and "a future run
 * will be told something", and it exists because those are different acts.
 *
 * **A proposal is a version, and it is not the version a run reads.** `ProcedureRepository.appendVersion`
 * records a `Proposed` row and `currentVersion` returns only `Accepted` ones, so a model
 * that suggests a better procedure cannot change what the next run is told: the owner has
 * to save it first (F05-AC4). Everything here is written so that gap is the only way
 * through — `proposeProcedureImprovement` takes no status, no accepted-at instant and no
 * author, and sets them itself.
 *
 * **Model text cannot claim the owner's decisions.** `validateProcedureImprovement` is an
 * allowlist: a proposal naming `status`, `acceptedAt`, `createdBy`, `release` or anything
 * else outside the five content fields is refused with the field named, rather than
 * stripped. Stripping it would leave the reader unable to see that the suggestion tried
 * (F05-AC5).
 *
 * **What a run reads is a function, not a row.** `readRunInstructions` is the single way
 * this feature area learns what a run would be told, and it reads through
 * `currentVersion`. Generation, planning and the context packet all go through it, so
 * there is no path by which a proposed version can reach an engine prompt (F05-AC3,
 * F05-AC4).
 *
 * **The current fact supersedes the stale remembered one, and both stay readable.** A saved
 * version supersedes the one it replaces rather than deleting it, and `readRunInstructions`
 * answers with the newest `Accepted` row — so the statement a run follows can only ever be
 * the current one, while the older statement is still there for whoever has to see what
 * changed (F05-AC3, F05-AC1).
 *
 * Not implemented here, and named so it is not assumed: comparing a *remembered scope note*
 * against a *live recipe* across two subjects of one project. `procedure_versions` carries
 * `UNIQUE (project_id, version)` while `appendVersion` numbers versions per subject, so a
 * project can hold only one subject's first version and a second subject cannot be stored at
 * all. That comparison belongs in `@shiploop/storage` once the constraint and the numbering
 * agree; nothing here pretends to make it (F05-AC3).
 */

import { canonicalize, err, invalid, ok, redact } from '@shiploop/domain';
import type { DomainError, ProjectId, ProcedureVersionId, Result } from '@shiploop/domain';
import type { ProcedureRepository, ProcedureStatus, ProcedureVersion } from '@shiploop/storage';
import type { ControllerClock, OwnerActor } from './profiles.ts';

/* -------------------------------------------------------------------------- */
/* The proposal a model or an owner may make                                    */
/* -------------------------------------------------------------------------- */

/**
 * The fields an improvement proposal may carry, as one list.
 *
 * An allowlist rather than a denylist, because a field this list omits is a field a later
 * caller could add without noticing that it started being accepted (F05-AC5).
 */
export const PROCEDURE_IMPROVEMENT_FIELDS = ['subjectKey', 'scope', 'content', 'sourceRevision', 'rationale'] as const;

export type ProcedureImprovementField = (typeof PROCEDURE_IMPROVEMENT_FIELDS)[number];

/**
 * A suggested replacement for one procedure, as text rather than as a row.
 *
 * It carries no status, no approval instant and no author. Those are the owner's
 * decisions and the store's facts, so a suggestion has nowhere to put them even if it
 * names them (F05-AC4, F05-AC5).
 */
export interface ProcedureImprovementProposal {
  readonly subjectKey: string;
  readonly scope: string;
  readonly content: string;
  /** The revision of the evidence the suggestion came from, or null when it has none. */
  readonly sourceRevision: string | null;
  /** Why the owner or the model believes this is an improvement. */
  readonly rationale: string;
}

/** A proposal that passed validation; the only input to `proposeProcedureImprovement`. */
export interface ValidatedProcedureImprovement {
  readonly validated: true;
  readonly subjectKey: string;
  readonly scope: string;
  readonly content: string;
  readonly sourceRevision: string | null;
  readonly rationale: string;
}

/**
 * Validates a suggested procedure improvement before it can become a row (F05-AC5).
 *
 * Unknown keys are checked as well as content, because structured output reaches this
 * layer as decoded data and a key naming an owner decision has to be refused rather than
 * dropped. Every failure is returned at once so the caller can correct and resubmit.
 */
export function validateProcedureImprovement(proposal: unknown): Result<ValidatedProcedureImprovement, DomainError> {
  const record = asRecord(proposal);
  if (record === null) {
    return err(
      invalid('The structured output is not a procedure improvement proposal (F05-AC5).', [
        { path: 'proposal', message: 'A procedure improvement proposal must be an object.' },
      ]),
    );
  }

  const errors: { readonly path: string; readonly message: string }[] = [];
  for (const key of Object.keys(record)) {
    if (!PROCEDURE_IMPROVEMENT_FIELDS.includes(key as ProcedureImprovementField)) {
      errors.push({
        path: key,
        message: `"${key}" is not a procedure improvement field: status, acceptance and release are owner decisions (F05-AC5).`,
      });
    }
  }
  for (const field of ['subjectKey', 'scope', 'content', 'rationale'] as const) {
    if (!isFilledText(record[field])) {
      errors.push({ path: field, message: `A procedure improvement must state its ${field} (F05-AC5).` });
    }
  }
  if (record['sourceRevision'] !== null && record['sourceRevision'] !== undefined && typeof record['sourceRevision'] !== 'string') {
    errors.push({ path: 'sourceRevision', message: 'A source revision is text or null.' });
  }

  if (errors.length > 0) {
    return err(invalid('The proposed procedure improvement is not usable (F05-AC5).', errors));
  }

  return ok<ValidatedProcedureImprovement>(
    Object.freeze({
      validated: true,
      subjectKey: (record['subjectKey'] as string).trim(),
      scope: (record['scope'] as string).trim(),
      content: redact((record['content'] as string).trim()).text,
      sourceRevision:
        typeof record['sourceRevision'] === 'string' && record['sourceRevision'].trim().length > 0
          ? record['sourceRevision'].trim()
          : null,
      rationale: redact((record['rationale'] as string).trim()).text,
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Reading what a run is told                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The procedure version a future run would read, or null when there is none.
 *
 * `currentVersion` filters on `Accepted`, which is the whole of F05-AC4: a proposed
 * improvement is invisible here until an owner saves it. Every caller in this package
 * goes through this function, so there is no second reading of the table that could
 * disagree about this (F05-AC3, F05-AC4).
 */
export function readRunInstructions(
  procedures: ProcedureRepository,
  projectId: ProjectId,
  subjectKey: string,
): Result<ProcedureVersion | null, DomainError> {
  const current = procedures.currentVersion(projectId, subjectKey);
  if (!current.ok) return err(current.error);
  return ok(current.value);
}

/* -------------------------------------------------------------------------- */
/* Proposing, and the owner saving                                              */
/* -------------------------------------------------------------------------- */

/** What one proposal did, so the owner can see the suggestion without opening the row. */
export interface ProcedureProposalView {
  readonly procedureVersionId: ProcedureVersionId;
  readonly subjectKey: string;
  readonly versionNumber: number;
  /** Always `Proposed`: this view exists only for rows nobody has saved yet (F05-AC4). */
  readonly status: ProcedureStatus;
  readonly rationale: string;
  /** What a run is told today, so the suggestion is reviewable against the current text. */
  readonly currentVersionNumber: number | null;
}

export interface ProcedureVersioningDeps {
  readonly clock: ControllerClock;
  readonly procedures: ProcedureRepository;
}

export interface ProcedureImprovementRequest {
  readonly projectId: ProjectId;
  /**
   * The suggestion as the caller submits it, validated here so nothing unvalidated becomes
   * a row. Declared `unknown` on purpose: this is where decoded structured output arrives,
   * and a caller that assembled a `ProcedureImprovementProposal` is one case of many (F05-AC5).
   */
  readonly proposal: unknown;
  readonly actor: OwnerActor;
  /** The version this suggestion was written against, or null for a first suggestion. */
  readonly expectedVersionNumber?: number | null;
}

export interface SaveProcedureRequest {
  readonly procedureVersionId: ProcedureVersionId;
  readonly actor: OwnerActor;
}

export interface SavedProcedure {
  readonly version: ProcedureVersion;
  readonly previous: ProcedureVersion | null;
  /** The content a run is told from now on, which is the row that was just saved. */
  readonly runInstructions: ProcedureVersion;
}

export interface ProcedureVersioningUseCases {
  /**
   * Records a suggested improvement as a new `Proposed` version (F05-AC4).
   *
   * Nothing a run reads changes: `currentVersion` ignores this row, and the returned view
   * carries the version a run is told today so the owner can compare the two.
   */
  readonly proposeProcedureImprovement: (
    request: ProcedureImprovementRequest,
  ) => Result<ProcedureProposalView, DomainError>;
  /** The owner save action that makes a proposal the version a future run reads (F05-AC4). */
  readonly saveProcedureImprovement: (request: SaveProcedureRequest) => Result<SavedProcedure, DomainError>;
  /** The proposals waiting for an owner decision, newest first (F05-AC4). */
  readonly listProposedImprovements: (projectId: ProjectId) => Result<readonly ProcedureVersion[], DomainError>;
  /** What a run is told for one subject, read the way a run would read it (F05-AC3). */
  readonly runInstructionsFor: (projectId: ProjectId, subjectKey: string) => Result<ProcedureVersion | null, DomainError>;
}

/**
 * Binds procedure versioning to the durable store.
 *
 * The two writes are separate methods with separate gates on purpose. Proposing is open
 * to anything the owner asks for, because a suggestion nobody may make is a suggestion
 * the owner has to write themselves; saving is the owner's save action and it is the only
 * statement that a `Proposed` row becomes what a run reads (F05-AC4).
 */
export function createProcedureVersioningUseCases(deps: ProcedureVersioningDeps): ProcedureVersioningUseCases {
  const proposeProcedureImprovement = (
    request: ProcedureImprovementRequest,
  ): Result<ProcedureProposalView, DomainError> => {
    const permitted = requireProcedureOwner(request.actor);
    if (!permitted.ok) return err(permitted.error);

    const validated = validateProcedureImprovement(request.proposal);
    if (!validated.ok) return err(validated.error);

    const current = readRunInstructions(deps.procedures, request.projectId, validated.value.subjectKey);
    if (!current.ok) return err(current.error);

    // Status, createdBy and the approval instant are constants of this function rather
    // than members of the proposal, which is what makes "a proposal is never what a run
    // reads" a property of the code and not of the caller's restraint (F05-AC4, F05-AC5).
    const appended = deps.procedures.appendVersion({
      projectId: request.projectId,
      subjectKey: validated.value.subjectKey,
      kind: 'Procedure',
      scope: validated.value.scope,
      source: 'Owner',
      sourceRevision: validated.value.sourceRevision,
      content: canonicalize(validated.value.content),
      status: 'Proposed',
      createdAt: deps.clock.now(),
      createdBy: request.actor.actorId,
      note: validated.value.rationale,
      expectedVersionNumber: request.expectedVersionNumber ?? null,
    });
    if (!appended.ok) return err(appended.error);

    return ok<ProcedureProposalView>(
      Object.freeze({
        procedureVersionId: appended.value.procedureVersionId,
        subjectKey: appended.value.subjectKey,
        versionNumber: appended.value.versionNumber,
        status: appended.value.status,
        rationale: validated.value.rationale,
        currentVersionNumber: current.value?.versionNumber ?? null,
      }),
    );
  };

  const saveProcedureImprovement = (request: SaveProcedureRequest): Result<SavedProcedure, DomainError> => {
    const permitted = requireProcedureOwner(request.actor);
    if (!permitted.ok) return err(permitted.error);

    const proposed = deps.procedures.getVersion(request.procedureVersionId);
    if (!proposed.ok) return err(proposed.error);
    const target = proposed.value;

    const current = readRunInstructions(deps.procedures, target.projectId, target.subjectKey);
    if (!current.ok) return err(current.error);
    if (target.status !== 'Proposed') {
      return err({
        code: 'Conflict',
        reason: `Version ${String(target.versionNumber)} of "${target.subjectKey}" is ${target.status}, so there is nothing for the owner to save (F05-AC4).`,
        expected: 'Proposed',
        actual: target.status,
      });
    }

    const saved = deps.procedures.acceptVersion(request.procedureVersionId, deps.clock.now());
    if (!saved.ok) return err(saved.error);

    return ok<SavedProcedure>(
      Object.freeze({
        version: saved.value,
        previous: current.value,
        runInstructions: saved.value,
      }),
    );
  };

  const listProposedImprovements = (projectId: ProjectId): Result<readonly ProcedureVersion[], DomainError> => {
    const listed = deps.procedures.listProposed(projectId);
    if (!listed.ok) return err(listed.error);
    return ok(Object.freeze([...listed.value].reverse()));
  };

  const runInstructionsFor = (projectId: ProjectId, subjectKey: string): Result<ProcedureVersion | null, DomainError> =>
    readRunInstructions(deps.procedures, projectId, subjectKey);

  return {
    proposeProcedureImprovement,
    saveProcedureImprovement,
    listProposedImprovements,
    runInstructionsFor,
  };
}

/**
 * The owner gate both writes share (F01-AC1).
 *
 * Re-exported from `plan-generation` rather than restated here so the two feature areas
 * cannot drift into answering "is this the owner?" differently.
 */
export function requireProcedureOwner(actor: OwnerActor): Result<true, DomainError> {
  if (actor.role !== 'Owner' || actor.ownerId === null) {
    return err({
      code: 'Forbidden',
      reason: `Only the owner may record a procedure version; the ${actor.role} role may not (F01-AC1).`,
    });
  }
  return ok(true);
}

/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isFilledText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}