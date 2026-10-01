/**
 * The implementation plan and its dependent task proposals (F08).
 *
 * A plan is what the owner reviews before anything is published, so three of its
 * properties are structural rather than conventional:
 *
 *   - a proposed task carries every field F08-AC1 names, and `PLAN_TASK_CONTENT_FIELDS`
 *     is that list, so no field can be quietly dropped and none can be invented;
 *   - acceptance lives in the task's own type, so an unaccepted proposal has no
 *     publishable representation at all rather than an unaccepted publishable one
 *     (F08-AC3);
 *   - implementation locations are typed as proposals, so a suggestion cannot be
 *     read as an inspected fact (F08-AC5).
 *
 * Nothing here can set product acceptance, delivery or release state: those are
 * owner decisions on a candidate (mvp-spec 3), and `PlanProposal` has no lifecycle
 * key in which to record them even when structured output names one.
 */

import { fingerprint } from '../fingerprint.ts';
import type { Fingerprint } from '../ids.ts';
import { analyzeDependencies } from '../readiness.ts';
import type { DependencyNode } from '../readiness.ts';
import type { DomainError, Result } from '../result.ts';
import { err, invalid, ok } from '../result.ts';

/**
 * The content fields F08-AC1 names, as one list.
 *
 * A task is a complete record of these seven: outcome, scope, acceptance criteria,
 * verification method, dependencies, relevant project context, and a proposed
 * implementation location. Everything else on a task is structural identity or the
 * owner's acceptance, not plan content.
 */
export const PLAN_TASK_CONTENT_FIELDS = [
  'outcome',
  'scope',
  'acceptanceCriteria',
  'verificationMethod',
  'dependencies',
  'relevantProjectContext',
  'implementationLocation',
] as const;

export type PlanTaskContentField = (typeof PLAN_TASK_CONTENT_FIELDS)[number];

/** An outcome the owner asked for, before the plan decides how to deliver it. */
export interface RequestedOutcome {
  readonly id: string;
  readonly statement: string;
}

/**
 * An outcome the plan deliberately does not deliver, with the reason (F08-AC5).
 *
 * Coverage is "a proposed task or an explicit exclusion", so declining to deliver
 * something is a decision the owner can see rather than an omission.
 */
export interface OutcomeExclusion {
  readonly outcomeId: string;
  readonly excluded: string;
  readonly reason: string;
}

/**
 * Where the change would probably go, stated as a proposal.
 *
 * The `kind` tag is not decoration: a location reaches a plan only through this
 * type, so nothing downstream can treat it as an inspected fact (F08-AC5). `basis`
 * records what the suggestion came from, because "probably here" without a reason
 * is not a proposal a reviewer can judge.
 */
export interface ImplementationLocationProposal {
  readonly kind: 'ProposedLocation';
  readonly candidates: readonly string[];
  readonly basis: string;
}

/** The plan content of one proposed task: exactly the fields F08-AC1 names. */
export interface PlanTaskContent {
  readonly outcome: string;
  readonly scope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly verificationMethod: string;
  readonly dependencies: readonly string[];
  readonly relevantProjectContext: readonly string[];
  readonly implementationLocation: ImplementationLocationProposal;
}

/** A partial task content, used by an owner edit that changes only some fields. */
export type PlanTaskPatch = { readonly [K in PlanTaskContentField]?: PlanTaskContent[K] };

interface TaskRecord<T extends TaskAcceptance> extends PlanTaskContent {
  readonly taskId: string;
  /** Requested outcomes this task delivers; the input to the coverage check. */
  readonly coversOutcomeIds: readonly string[];
  readonly acceptance: T;
}

export interface ProposedAcceptance {
  readonly state: 'Proposed';
}

export interface AcceptedAcceptance {
  readonly state: 'Accepted';
  readonly acceptedBy: string;
  readonly acceptedAt: string;
}

/**
 * A removed proposal is kept rather than deleted.
 *
 * The owner saw it and rejected it, and a dependency may still name it: keeping
 * the record is what lets the plan show that a task depending on removed work has
 * an unresolved dependency (F08-AC4).
 */
export interface RemovedAcceptance {
  readonly state: 'Removed';
  readonly removedBy: string;
  readonly removedAt: string;
}

export type TaskAcceptance = ProposedAcceptance | AcceptedAcceptance | RemovedAcceptance;

export type ProposedPlanTask = TaskRecord<ProposedAcceptance>;
export type AcceptedPlanTask = TaskRecord<AcceptedAcceptance>;
export type RemovedPlanTask = TaskRecord<RemovedAcceptance>;

/**
 * A task is exactly one of proposed, accepted or removed.
 *
 * Splitting on `acceptance.state` means an accepted task cannot also be merely
 * proposed, and `AcceptedPlanTask` is the only shape with a publishable form
 * (F08-AC3).
 */
export type PlanTask = ProposedPlanTask | AcceptedPlanTask | RemovedPlanTask;

type TaskSeed = PlanTaskContent & {
  readonly taskId: string;
  readonly coversOutcomeIds: readonly string[];
};

/** Why the plan was split into the tasks it contains (F08-AC2). */
export type SplitJustification = 'IndependentlyReviewable' | 'RealDependency';

export interface ChangeSurface {
  readonly surfaceId: string;
  readonly description: string;
  /** What can be observed on this surface alone; blank means no reviewable unit. */
  readonly observableBehaviour: string;
  readonly independentlyReviewable: boolean;
}

/**
 * The change as the agent read it.
 *
 * `dependencyEdges` records real ordering: `surface` cannot be delivered before
 * `dependsOn`. A surface that merely mentions another is not an edge, which is why
 * edges are declared rather than inferred from the description text.
 */
export interface ChangeShape {
  readonly summary: string;
  readonly surfaces: readonly ChangeSurface[];
  readonly dependencyEdges: readonly { readonly surface: string; readonly dependsOn: string }[];
}

export interface SplitGroup {
  /** The surface whose behaviour defines this proposed unit of work. */
  readonly groupId: string;
  readonly surfaceIds: readonly string[];
}

export type SplitAdvice =
  | { readonly split: false; readonly reason: string }
  | {
      readonly split: true;
      readonly reason: string;
      readonly justifications: readonly SplitJustification[];
      readonly groups: readonly SplitGroup[];
      /** Surfaces in dependency order, so the proposed sequence is visible. */
      readonly order: readonly string[];
      /** Surfaces with no behaviour of their own, named so none is silently dropped. */
      readonly surfacesWithoutOwnBehaviour: readonly string[];
    };

/**
 * Whether a change should stay one task or split (F08-AC2).
 *
 * The test is evidence, not preference: split only when the change has at least two
 * independently reviewable units, or a real dependency between its surfaces. A
 * one-file fix fails both and stays one task, which is the point — three tickets for
 * one edit is the failure mode this avoids.
 */
export function shouldSplit(change: ChangeShape): SplitAdvice {
  const declared = new Set(change.surfaces.map((surface) => surface.surfaceId));
  const realEdges = change.dependencyEdges.filter(
    (edge) => declared.has(edge.surface) && declared.has(edge.dependsOn) && edge.surface !== edge.dependsOn,
  );
  const reviewable = change.surfaces.filter((surface) => surface.observableBehaviour.trim().length > 0);
  const independent = reviewable.filter((surface) => surface.independentlyReviewable);

  if (independent.length < 2 && realEdges.length === 0) {
    const basis =
      independent.length === 0
        ? 'no surface carries observable behaviour that can be reviewed on its own'
        : 'only one surface carries observable behaviour that can be reviewed on its own';
    return {
      split: false,
      reason: `The change stays one task: ${basis}, and no surface depends on another (F08-AC2).`,
    };
  }

  const nodes: DependencyNode[] = change.surfaces.map((surface) => ({
    id: surface.surfaceId,
    dependsOn: realEdges.filter((edge) => edge.surface === surface.surfaceId).map((edge) => edge.dependsOn),
  }));
  const { order } = analyzeDependencies(nodes);

  const groups = new Map<string, string[]>();
  for (const surface of independent) {
    groups.set(surface.surfaceId, [surface.surfaceId]);
  }
  const withoutOwnBehaviour: string[] = [];
  for (const surface of change.surfaces) {
    if (groups.has(surface.surfaceId)) continue;
    const owner = relatedGroupOf(surface, groups, realEdges);
    if (owner === null) {
      groups.set(surface.surfaceId, [surface.surfaceId]);
      if (surface.observableBehaviour.trim().length === 0) withoutOwnBehaviour.push(surface.surfaceId);
    } else {
      groups.get(owner)?.push(surface.surfaceId);
    }
  }

  const justifications: SplitJustification[] = [];
  if (independent.length >= 2) justifications.push('IndependentlyReviewable');
  if (realEdges.length > 0) justifications.push('RealDependency');

  const ordered = order.filter((id) => groups.has(id));
  const unordered = [...groups.keys()].filter((id) => !ordered.includes(id));

  return {
    split: true,
    reason:
      `The change splits into ${groups.size} proposed task(s): ${independent.length} surface(s) carry ` +
      `independently reviewable behaviour` +
      (realEdges.length > 0 ? ` and ${realEdges.length} surface(s) depend on another surface` : '') +
      ' (F08-AC2).',
    justifications,
    groups: [...ordered, ...unordered].map((groupId) => ({
      groupId,
      surfaceIds: [...(groups.get(groupId) ?? [])],
    })),
    order,
    surfacesWithoutOwnBehaviour: withoutOwnBehaviour,
  };
}

/** The existing group a surface belongs with, by the dependency that ties it to one. */
function relatedGroupOf(
  surface: ChangeSurface,
  groups: ReadonlyMap<string, string[]>,
  edges: readonly { readonly surface: string; readonly dependsOn: string }[],
): string | null {
  const prerequisite = edges.find((edge) => edge.surface === surface.surfaceId && groups.has(edge.dependsOn));
  if (prerequisite) return prerequisite.dependsOn;
  const dependent = edges.find((edge) => edge.dependsOn === surface.surfaceId && groups.has(edge.surface));
  return dependent ? dependent.surface : null;
}

export type OutcomeCoverage =
  | { readonly outcomeId: string; readonly via: 'Task'; readonly taskId: string }
  | { readonly outcomeId: string; readonly via: 'Exclusion'; readonly reason: string };

/**
 * The recorded proof that every requested outcome is accounted for.
 *
 * A plan carries this record rather than trusting that coverage happens to hold, so
 * the owner can be shown which task delivers what without recomputing it.
 */
export interface CoverageReport {
  readonly coverage: readonly OutcomeCoverage[];
}

/**
 * Every requested outcome is delivered by a proposed task or explicitly excluded
 * (F08-AC5).
 *
 * An outcome covered by neither is refused by name rather than quietly dropped: a
 * plan that silently loses one of the owner's outcomes is indistinguishable from a
 * plan that never intended to deliver it.
 */
export function coverageCheck(
  requestedOutcomes: readonly RequestedOutcome[],
  tasks: readonly PlanTask[],
  exclusions: readonly OutcomeExclusion[],
): Result<CoverageReport, DomainError> {
  const active = tasks.filter((task) => task.acceptance.state !== 'Removed');
  const uncovered: RequestedOutcome[] = [];
  const coverage: OutcomeCoverage[] = [];

  for (const outcome of requestedOutcomes) {
    const task = active.find((candidate) => candidate.coversOutcomeIds.includes(outcome.id));
    if (task) {
      coverage.push({ outcomeId: outcome.id, via: 'Task', taskId: task.taskId });
      continue;
    }
    const exclusion = exclusions.find((candidate) => candidate.outcomeId === outcome.id);
    if (exclusion) {
      coverage.push({ outcomeId: outcome.id, via: 'Exclusion', reason: exclusion.reason });
      continue;
    }
    uncovered.push(outcome);
  }

  if (uncovered.length > 0) {
    return err<DomainError>(
      invalid(
        'Every requested outcome must be covered by a proposed task or an explicit exclusion (F08-AC5).',
        uncovered.map((outcome) => ({
          path: `requestedOutcomes[${outcome.id}]`,
          message: `Requested outcome "${outcome.statement}" is covered by neither a proposed task nor an explicit exclusion.`,
        })),
      ),
    );
  }

  return ok<CoverageReport>({ coverage: Object.freeze(coverage) });
}

/**
 * Fields structured output must not carry, because they are owner decisions.
 *
 * Acceptance, delivery and release are the three dimensions mvp-spec 3 keeps
 * independent, and a plan has no business claiming any of them (F05-AC5, F08-AC3).
 */
const FORBIDDEN_LIFECYCLE_FIELDS: readonly string[] = Object.freeze([
  'acceptance',
  'accepted',
  'acceptedBy',
  'acceptedAt',
  'authorization',
  'authorized',
  'delivery',
  'delivered',
  'merged',
  'release',
  'released',
  'releaseReceipt',
  'state',
  'status',
]);

const PLAN_PROPOSAL_FIELDS: readonly string[] = Object.freeze([
  'kind',
  'briefId',
  'draftedAt',
  'basedOnRevision',
  'requestedOutcomes',
  'tasks',
  'exclusions',
]);

const TASK_PROPOSAL_FIELDS: readonly string[] = Object.freeze(['taskId', ...PLAN_TASK_CONTENT_FIELDS, 'coversOutcomeIds']);

const LOCATION_PROPOSAL_FIELDS: readonly string[] = Object.freeze(['kind', 'candidates', 'basis']);
const OUTCOME_FIELDS: readonly string[] = Object.freeze(['id', 'statement']);
const EXCLUSION_FIELDS: readonly string[] = Object.freeze(['outcomeId', 'excluded', 'reason']);

interface FieldError {
  readonly path: string;
  readonly message: string;
}

function unexpectedField(path: string, key: string): FieldError {
  return FORBIDDEN_LIFECYCLE_FIELDS.includes(key)
    ? {
        path,
        message: `"${key}" is not a plan field: acceptance, delivery and release are owner decisions (F05-AC5, F08-AC3).`,
      }
    : { path, message: `A plan has no field "${key}".` };
}

/**
 * A structured plan proposal: the only shape a model may emit.
 *
 * It deliberately has no acceptance, delivery, release or status field, so no
 * structured output can set those owner decisions even by naming one (F05-AC5).
 * Every task it carries is still only a proposal: acceptance is added by `editPlan`
 * when the owner acts, never by the proposal.
 */
export interface PlanProposal {
  readonly kind: 'PlanProposal';
  readonly briefId: string;
  readonly draftedAt: string;
  /** null for a first plan, or the plan revision this proposal supersedes. */
  readonly basedOnRevision: number | null;
  readonly requestedOutcomes: readonly RequestedOutcome[];
  readonly tasks: readonly (PlanTaskContent & {
    readonly taskId: string;
    readonly coversOutcomeIds: readonly string[];
  })[];
  readonly exclusions: readonly OutcomeExclusion[];
}

/** A proposal that passed validation; the only accepted input to `draftPlan`. */
export interface ValidatedPlanProposal {
  readonly validated: true;
  readonly briefId: string;
  readonly draftedAt: string;
  readonly basedOnRevision: number | null;
  readonly requestedOutcomes: readonly RequestedOutcome[];
  readonly tasks: readonly ProposedPlanTask[];
  readonly exclusions: readonly OutcomeExclusion[];
}

/**
 * Every reason the proposal does not describe a usable plan.
 *
 * Unknown keys are checked as well as content, because structured output reaches
 * this layer as decoded JSON that may carry fields the type does not describe
 * (F05-AC5). A top-level `acceptance` is refused rather than dropped: a model that
 * tried to set an owner decision is a signal the caller needs to see. Returning all
 * failures at once is what makes the rejection recoverable.
 */
function planErrors(proposal: PlanProposal): readonly FieldError[] {
  const errors: FieldError[] = [];
  const present = proposal === null || typeof proposal !== 'object' ? [] : Object.keys(proposal);

  for (const field of present) {
    if (!PLAN_PROPOSAL_FIELDS.includes(field)) errors.push(unexpectedField(field, field));
  }

  if (typeof proposal.briefId !== 'string' || proposal.briefId.trim().length === 0) {
    errors.push({ path: 'briefId', message: 'A plan must name the brief it delivers.' });
  }
  if (typeof proposal.draftedAt !== 'string' || proposal.draftedAt.trim().length === 0) {
    errors.push({ path: 'draftedAt', message: 'A plan must carry the time it was drafted.' });
  }
  if (proposal.basedOnRevision !== null && typeof proposal.basedOnRevision !== 'number') {
    errors.push({ path: 'basedOnRevision', message: 'A plan revision is a number or null.' });
  }

  // Decoded structured output is checked as unknown: the declared type says these are
  // lists, and the shape pass is what makes it safe to read their members (F05-AC5).
  const outcomes: unknown = proposal.requestedOutcomes;
  const tasks: unknown = proposal.tasks;
  const exclusions: unknown = proposal.exclusions;

  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    errors.push({ path: 'requestedOutcomes', message: 'A plan must record the outcomes the owner asked for.' });
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    errors.push({ path: 'tasks', message: 'A plan must propose at least one task.' });
  }
  if (!Array.isArray(exclusions)) {
    errors.push({ path: 'exclusions', message: 'The "exclusions" field must be a list of excluded outcomes.' });
  }

  const outcomeIds = new Set<string>();
  for (const [index, entry] of Array.isArray(outcomes) ? outcomes.entries() : [].entries()) {
    const path = `requestedOutcomes[${index}]`;
    const outcome = asRecord(entry);
    if (outcome === null) {
      errors.push({ path, message: 'A requested outcome must carry id and statement.' });
      continue;
    }
    for (const key of Object.keys(outcome)) {
      if (!OUTCOME_FIELDS.includes(key)) errors.push(unexpectedField(`${path}.${key}`, key));
    }
    const id = outcome['id'];
    if (typeof id !== 'string' || id.trim().length === 0) {
      errors.push({ path: `${path}.id`, message: 'A requested outcome needs an id.' });
    } else if (outcomeIds.has(id)) {
      errors.push({ path: `${path}.id`, message: `Requested outcome id "${id}" is used twice.` });
    } else {
      outcomeIds.add(id);
    }
    if (!isFilledText(outcome['statement'])) {
      errors.push({ path: `${path}.statement`, message: 'A requested outcome needs a statement.' });
    }
  }

  const seen = new Set<string>();
  for (const [index, entry] of Array.isArray(tasks) ? tasks.entries() : [].entries()) {
    const path = `tasks[${index}]`;
    const task = asRecord(entry);
    if (task === null) {
      errors.push({ path, message: 'A proposed task must be an object.' });
      continue;
    }
    for (const key of Object.keys(task)) {
      if (!TASK_PROPOSAL_FIELDS.includes(key)) errors.push(unexpectedField(`${path}.${key}`, key));
    }
    const taskId = task['taskId'];
    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      errors.push({ path: `${path}.taskId`, message: 'A proposed task needs an id.' });
    } else if (seen.has(taskId)) {
      errors.push({ path: `${path}.taskId`, message: `Task id "${taskId}" is used twice.` });
    } else {
      seen.add(taskId);
    }
    const covers = task['coversOutcomeIds'];
    if (!Array.isArray(covers)) {
      errors.push({ path: `${path}.coversOutcomeIds`, message: 'A task must list the requested outcomes it delivers.' });
    } else {
      covers.forEach((outcomeId: unknown, position: number) => {
        if (typeof outcomeId !== 'string' || !outcomeIds.has(outcomeId)) {
          errors.push({
            path: `${path}.coversOutcomeIds[${position}]`,
            message: `"${String(outcomeId)}" is not a requested outcome of this plan.`,
          });
        }
      });
    }
    errors.push(...contentErrors(task, `${path}.`));
  }

  for (const [index, entry] of Array.isArray(exclusions) ? exclusions.entries() : [].entries()) {
    const path = `exclusions[${index}]`;
    const exclusion = asRecord(entry);
    if (exclusion === null) {
      errors.push({ path, message: 'An exclusion must be an object.' });
      continue;
    }
    for (const key of Object.keys(exclusion)) {
      if (!EXCLUSION_FIELDS.includes(key)) errors.push(unexpectedField(`${path}.${key}`, key));
    }
    const outcomeId = exclusion['outcomeId'];
    if (typeof outcomeId !== 'string' || !outcomeIds.has(outcomeId)) {
      errors.push({ path: `${path}.outcomeId`, message: 'An exclusion must name a requested outcome of this plan.' });
    }
    if (!isFilledText(exclusion['excluded'])) {
      errors.push({ path: `${path}.excluded`, message: 'An exclusion must state what is not delivered.' });
    }
    if (!isFilledText(exclusion['reason'])) {
      errors.push({ path: `${path}.reason`, message: 'An exclusion must state why the outcome is not delivered.' });
    }
  }

  return errors;
}

/** A decoded member read as a record, or null when it is not an object at all. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value === null || typeof value !== 'object' ? null : (value as Record<string, unknown>);
}

function isFilledText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Content validation for one task, shared by the proposal boundary and owner edits
 * so an edited task is held to the same standard as a proposed one.
 *
 * It checks the shape of every field before reading any value, so a decoded proposal
 * carrying the wrong kind of value is refused with a field error rather than throwing
 * partway through (F05-AC5).
 */
function contentErrors(task: Record<string, unknown>, pathPrefix: string): readonly FieldError[] {
  const errors: FieldError[] = [];

  for (const field of ['outcome', 'scope', 'verificationMethod'] as const) {
    if (!isFilledText(task[field])) {
      errors.push({ path: `${pathPrefix}${field}`, message: `A proposed task must state its ${field}.` });
    }
  }
  for (const field of ['acceptanceCriteria', 'dependencies', 'relevantProjectContext'] as const) {
    if (!Array.isArray(task[field])) {
      errors.push({ path: `${pathPrefix}${field}`, message: `The "${field}" field must be a list of statements.` });
    }
  }

  const criteria = task['acceptanceCriteria'];
  if (Array.isArray(criteria)) {
    if (criteria.length === 0) {
      errors.push({ path: `${pathPrefix}acceptanceCriteria`, message: 'A proposed task must state acceptance criteria.' });
    }
    criteria.forEach((criterion: unknown, index: number) => {
      if (!isFilledText(criterion)) {
        errors.push({ path: `${pathPrefix}acceptanceCriteria[${index}]`, message: 'An acceptance criterion must be a statement.' });
      }
    });
  }

  const dependencies = task['dependencies'];
  if (Array.isArray(dependencies)) {
    dependencies.forEach((dependency: unknown, index: number) => {
      if (!isFilledText(dependency)) {
        errors.push({ path: `${pathPrefix}dependencies[${index}]`, message: 'A dependency must be a task id.' });
      } else if (dependency === task['taskId']) {
        errors.push({ path: `${pathPrefix}dependencies[${index}]`, message: 'A task cannot depend on itself.' });
      }
    });
  }

  const record = asRecord(task['implementationLocation']);
  if (record === null) {
    errors.push({
      path: `${pathPrefix}implementationLocation`,
      message: 'A proposed task must carry a proposed implementation location (F08-AC5).',
    });
    return errors;
  }
  for (const key of Object.keys(record)) {
    if (!LOCATION_PROPOSAL_FIELDS.includes(key)) errors.push(unexpectedField(`${pathPrefix}implementationLocation.${key}`, key));
  }
  if (record['kind'] !== 'ProposedLocation') {
    errors.push({
      path: `${pathPrefix}implementationLocation.kind`,
      message: 'An implementation location is a proposal and must be tagged ProposedLocation (F08-AC5).',
    });
  }
  const candidates = record['candidates'];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    errors.push({
      path: `${pathPrefix}implementationLocation.candidates`,
      message: 'A location proposal must offer at least one candidate location (F08-AC5).',
    });
  }
  if (!isFilledText(record['basis'])) {
    errors.push({
      path: `${pathPrefix}implementationLocation.basis`,
      message: 'A location proposal must state what the suggestion is based on (F08-AC5).',
    });
  }
  return errors;
}

/**
 * Validates structured output before anything downstream can use it (F05-AC5).
 *
 * Refusal is recoverable: the error names every failing field, so the caller can
 * correct and resubmit instead of guessing what was wrong. A proposal carrying a
 * lifecycle field is refused rather than stripped, so the attempt to set an owner
 * decision stays visible.
 */
export function applyPlanProposal(proposal: PlanProposal): Result<ValidatedPlanProposal, DomainError> {
  if (proposal === null || typeof proposal !== 'object' || proposal.kind !== 'PlanProposal') {
    return err<DomainError>(
      invalid('The structured output is not a plan proposal.', [
        { path: 'kind', message: 'A plan proposal must be tagged as a PlanProposal.' },
      ]),
    );
  }

  const errors = planErrors(proposal);
  if (errors.length > 0) {
    return err<DomainError>(invalid('The proposed plan is not a valid plan.', errors));
  }

  return ok<ValidatedPlanProposal>(
    Object.freeze({
      validated: true,
      briefId: proposal.briefId,
      draftedAt: proposal.draftedAt,
      basedOnRevision: proposal.basedOnRevision,
      requestedOutcomes: Object.freeze([...proposal.requestedOutcomes]),
      tasks: Object.freeze(
        proposal.tasks.map((task) => freezeTask(task, Object.freeze({ state: 'Proposed' }))),
      ),
      exclusions: Object.freeze([...proposal.exclusions]),
    }),
  );
}

function freezeContent(content: PlanTaskContent): PlanTaskContent {
  return Object.freeze({
    outcome: content.outcome,
    scope: content.scope,
    acceptanceCriteria: Object.freeze([...content.acceptanceCriteria]),
    verificationMethod: content.verificationMethod,
    dependencies: Object.freeze([...content.dependencies]),
    relevantProjectContext: Object.freeze([...content.relevantProjectContext]),
    implementationLocation: Object.freeze({
      kind: 'ProposedLocation',
      candidates: Object.freeze([...content.implementationLocation.candidates]),
      basis: content.implementationLocation.basis,
    }),
  });
}

function freezeTask(seed: TaskSeed, acceptance: ProposedAcceptance): ProposedPlanTask;
function freezeTask(seed: TaskSeed, acceptance: AcceptedAcceptance): AcceptedPlanTask;
function freezeTask(seed: TaskSeed, acceptance: RemovedAcceptance): RemovedPlanTask;
function freezeTask(seed: TaskSeed, acceptance: TaskAcceptance): PlanTask;
function freezeTask(seed: TaskSeed, acceptance: TaskAcceptance): PlanTask {
  const base = { ...freezeContent(seed), taskId: seed.taskId, coversOutcomeIds: Object.freeze([...seed.coversOutcomeIds]) };
  if (acceptance.state === 'Accepted') {
    return Object.freeze({
      ...base,
      acceptance: Object.freeze({
        state: 'Accepted',
        acceptedBy: acceptance.acceptedBy,
        acceptedAt: acceptance.acceptedAt,
      }),
    });
  }
  if (acceptance.state === 'Removed') {
    return Object.freeze({
      ...base,
      acceptance: Object.freeze({
        state: 'Removed',
        removedBy: acceptance.removedBy,
        removedAt: acceptance.removedAt,
      }),
    });
  }
  return Object.freeze({ ...base, acceptance: Object.freeze({ state: 'Proposed' }) });
}

export interface PlanDraftInput {
  readonly planId: string;
  readonly briefId: string;
  readonly change: ChangeShape;
  readonly proposal: ValidatedPlanProposal;
}

/**
 * The plan: a recorded proposal whose tasks the owner still has to accept.
 *
 * `coverage` is stored rather than assumed, so no plan exists in which a requested
 * outcome is unaccounted for (F08-AC5). `split` is stored for the same reason: the
 * reason a plan has the number of tasks it has must be inspectable (F08-AC2).
 */
export interface Plan {
  readonly planId: string;
  readonly briefId: string;
  /** Monotonic. Revision 1 is the draft; every owner edit appends the next. */
  readonly revision: number;
  readonly draftedAt: string;
  readonly lastEditedAt: string | null;
  readonly lastEditedBy: string | null;
  readonly requestedOutcomes: readonly RequestedOutcome[];
  readonly tasks: readonly PlanTask[];
  readonly exclusions: readonly OutcomeExclusion[];
  readonly coverage: readonly OutcomeCoverage[];
  readonly split: SplitAdvice;
  readonly digest: Fingerprint;
}

/**
 * Drafts a plan from a validated proposal (F08-AC1, F08-AC2, F08-AC5).
 *
 * The task count is checked against the recorded split advice rather than taken on
 * trust: several tickets for a change with no independently reviewable unit and no
 * dependency is the over-decomposition F08-AC2 exists to prevent.
 *
 * The check runs in one direction only. A change that could be split may still be
 * planned as one task, because the specification says a split is *justified* by
 * independently reviewable behaviour or a real dependency, not that one is required,
 * and the journey asks for the smallest useful plan (mvp-spec 4, step 3). Refusing
 * the single-task plan would force decomposition the owner did not ask for.
 *
 * Exclusions are stored as the proposal stated them. A proposal that both delivers an
 * outcome and excludes it is contradictory, but `coverageCheck` resolves the report in
 * favour of the task, and rewriting the model's own words would hide the contradiction
 * from whoever reviews the plan.
 */
export function draftPlan(input: PlanDraftInput): Result<Plan, DomainError> {
  const { proposal } = input;

  if (input.planId.trim().length === 0) {
    return err<DomainError>(invalid('A plan needs an id.', [{ path: 'planId', message: 'A plan must have an id.' }]));
  }
  if (proposal.briefId !== input.briefId) {
    return err<DomainError>({
      code: 'Conflict',
      reason: 'The proposal was produced for a different brief.',
      expected: input.briefId,
      actual: proposal.briefId,
    });
  }

  const split = shouldSplit(input.change);
  const coverage = coverageCheck(proposal.requestedOutcomes, proposal.tasks, proposal.exclusions);
  if (!coverage.ok) return coverage;

  if (!split.split && proposal.tasks.length !== 1) {
    return err<DomainError>(
      invalid('The plan splits a change that is one reviewable task (F08-AC2).', [
        { path: 'tasks', message: `${split.reason} The proposal asks for ${proposal.tasks.length} tasks.` },
      ]),
    );
  }

  return ok<Plan>(
    Object.freeze({
      planId: input.planId,
      briefId: input.briefId,
      revision: (proposal.basedOnRevision ?? 0) + 1,
      draftedAt: proposal.draftedAt,
      lastEditedAt: null,
      lastEditedBy: null,
      requestedOutcomes: Object.freeze([...proposal.requestedOutcomes]),
      tasks: proposal.tasks,
      exclusions: Object.freeze([...proposal.exclusions]),
      coverage: coverage.value.coverage,
      split,
      digest: planDigest(proposal.requestedOutcomes, proposal.tasks, proposal.exclusions),
    }),
  );
}

function planDigest(
  requestedOutcomes: readonly RequestedOutcome[],
  tasks: readonly PlanTask[],
  exclusions: readonly OutcomeExclusion[],
): Fingerprint {
  return fingerprint({ requestedOutcomes, tasks, exclusions });
}

interface PlanEditBase {
  /** The plan revision the owner was looking at; a stale edit is a conflict. */
  readonly expectedRevision: number;
  readonly by: string;
  readonly at: string;
}

/**
 * The owner edits a proposal before publication (F08-AC3).
 *
 * Acceptance is one of the edits because accepting is what the others are for: a task
 * that was never accepted must not reach publication, and it must be an explicit owner
 * action recording who accepted it and when.
 *
 * `Exclusion` is here because removing a proposal can orphan the outcome it delivered,
 * and the owner is the only party entitled to decide that an outcome is now out of
 * scope. Without it, a task that uniquely delivers an outcome could never be removed
 * and the refusal in `cover` would be terminal (F08-AC5).
 *
 * `Reorder` names the tasks the owner still has, which excludes removed ones; a
 * removed proposal keeps no position in the agreed sequence and is held at the end.
 */
export type PlanEdit =
  | (PlanEditBase & { readonly kind: 'Edit'; readonly taskId: string; readonly changes: PlanTaskPatch })
  | (PlanEditBase & { readonly kind: 'Remove'; readonly taskId: string })
  | (PlanEditBase & { readonly kind: 'Reorder'; readonly order: readonly string[] })
  | (PlanEditBase & { readonly kind: 'Combine'; readonly intoTaskId: string; readonly fromTaskIds: readonly string[] })
  | (PlanEditBase & { readonly kind: 'Exclusion'; readonly outcomeId: string; readonly excluded: string; readonly reason: string })
  | (PlanEditBase & { readonly kind: 'Accept'; readonly taskId: string });

/**
 * Applies one owner edit to a plan (F08-AC3).
 *
 * Every edit is revision-checked: an edit made against a plan the owner no longer sees
 * is refused rather than merged into a newer plan, because a reorder or a combine
 * applied to the wrong revision produces a plan nobody reviewed.
 */
export function editPlan(plan: Plan, edit: PlanEdit): Result<Plan, DomainError> {
  if (edit.expectedRevision !== plan.revision) {
    return err<DomainError>({
      code: 'Conflict',
      reason: 'The plan changed since this edit was prepared.',
      expected: `revision ${plan.revision}`,
      actual: `revision ${edit.expectedRevision}`,
    });
  }
  if (typeof edit.by !== 'string' || edit.by.trim().length === 0) {
    return err<DomainError>(invalid('An edit must record who made it.', [{ path: 'by', message: 'An edit needs an author.' }]));
  }

  const edited = applyEdit(plan, edit);
  if (!edited.ok) return edited;

  return ok<Plan>(
    Object.freeze({
      ...edited.value,
      revision: plan.revision + 1,
      lastEditedAt: edit.at,
      lastEditedBy: edit.by,
      digest: planDigest(edited.value.requestedOutcomes, edited.value.tasks, edited.value.exclusions),
    }),
  );
}

function applyEdit(plan: Plan, edit: PlanEdit): Result<Plan, DomainError> {
  const byId = new Map(plan.tasks.map((task) => [task.taskId, task] as const));

  if (edit.kind === 'Reorder') {
    const active = plan.tasks.filter((task) => task.acceptance.state !== 'Removed');
    const activeIds = new Set(active.map((task) => task.taskId));
    const missing = [...activeIds].filter((taskId) => !edit.order.includes(taskId));
    const unknown = edit.order.filter((taskId) => !activeIds.has(taskId));
    const duplicated = edit.order.filter((taskId, index) => edit.order.indexOf(taskId) !== index);
    const fieldErrors: FieldError[] = [
      ...missing.map((taskId) => ({ path: `order.${taskId}`, message: `Task "${taskId}" is missing from the new order.` })),
      ...unknown.map((taskId) => ({ path: `order.${taskId}`, message: `The plan has no active task "${taskId}".` })),
      ...duplicated.map((taskId) => ({ path: `order.${taskId}`, message: `Task "${taskId}" is listed twice.` })),
    ];
    if (fieldErrors.length > 0) {
      return err<DomainError>(invalid('The new order is not a permutation of the active plan tasks (F08-AC3).', fieldErrors));
    }
    const reordered: PlanTask[] = [];
    for (const taskId of edit.order) {
      const task = byId.get(taskId);
      if (task) reordered.push(task);
    }
    const removed = plan.tasks.filter((task) => task.acceptance.state === 'Removed');
    return withTasks(plan, [...reordered, ...removed]);
  }

  if (edit.kind === 'Combine') {
    return combinePlan(plan, edit.intoTaskId, edit.fromTaskIds, edit.by, edit.at);
  }

  if (edit.kind === 'Exclusion') {
    return withExclusion(plan, { outcomeId: edit.outcomeId, excluded: edit.excluded, reason: edit.reason });
  }

  const index = plan.tasks.findIndex((task) => task.taskId === edit.taskId);
  if (index < 0) {
    return err<DomainError>({ code: 'NotFound', reason: `The plan has no task "${edit.taskId}".` });
  }
  const task = plan.tasks[index];
  if (task === undefined) {
    return err<DomainError>({ code: 'NotFound', reason: `The plan has no task "${edit.taskId}".` });
  }

  if (edit.kind === 'Accept') {
    if (task.acceptance.state === 'Removed') {
      return err<DomainError>({
        code: 'Conflict',
        reason: 'A removed proposal cannot be accepted.',
        expected: 'Proposed',
        actual: 'Removed',
      });
    }
    if (task.acceptance.state === 'Accepted') {
      return err<DomainError>({
        code: 'Conflict',
        reason: 'This proposal is already accepted.',
        expected: 'Proposed',
        actual: 'Accepted',
      });
    }
    return withTasks(plan, replaceAt(plan.tasks, index, freezeTask(task, { state: 'Accepted', acceptedBy: edit.by, acceptedAt: edit.at })));
  }

  if (task.acceptance.state === 'Removed') {
    return err<DomainError>({
      code: 'Conflict',
      reason: 'A removed proposal cannot be edited.',
      expected: 'Proposed',
      actual: 'Removed',
    });
  }

  if (edit.kind === 'Remove') {
    return withTasks(plan, replaceAt(plan.tasks, index, freezeTask(task, { state: 'Removed', removedBy: edit.by, removedAt: edit.at })));
  }

  for (const key of Object.keys(edit.changes)) {
    if (!PLAN_TASK_CONTENT_FIELDS.includes(key as PlanTaskContentField)) {
      return err<DomainError>(
        invalid('The edit changes a field a task does not have (F08-AC1).', [unexpectedField(`changes.${key}`, key)]),
      );
    }
  }

  const patched: PlanTaskContent = {
    outcome: edit.changes.outcome ?? task.outcome,
    scope: edit.changes.scope ?? task.scope,
    acceptanceCriteria: edit.changes.acceptanceCriteria ?? task.acceptanceCriteria,
    verificationMethod: edit.changes.verificationMethod ?? task.verificationMethod,
    dependencies: edit.changes.dependencies ?? task.dependencies,
    relevantProjectContext: edit.changes.relevantProjectContext ?? task.relevantProjectContext,
    implementationLocation: edit.changes.implementationLocation ?? task.implementationLocation,
  };
  const errors = contentErrors({ ...patched }, '');
  if (errors.length > 0) {
    return err<DomainError>(invalid('The edited task is not a valid task.', errors));
  }

  return withTasks(
    plan,
    replaceAt(
      plan.tasks,
      index,
      freezeTask({ ...patched, taskId: task.taskId, coversOutcomeIds: task.coversOutcomeIds }, task.acceptance),
    ),
  );
}

function combinePlan(
  plan: Plan,
  intoTaskId: string,
  fromTaskIds: readonly string[],
  by: string,
  at: string,
): Result<Plan, DomainError> {
  const into = plan.tasks.find((task) => task.taskId === intoTaskId);
  if (into === undefined) {
    return err<DomainError>({ code: 'NotFound', reason: `The plan has no task "${intoTaskId}".` });
  }
  if (fromTaskIds.length === 0) {
    return err<DomainError>(
      invalid('A combine must name the tasks it absorbs.', [
        { path: 'fromTaskIds', message: 'A combine needs at least one absorbed task.' },
      ]),
    );
  }

  const absorbed: PlanTask[] = [];
  for (const taskId of fromTaskIds) {
    const task = plan.tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined) {
      return err<DomainError>({ code: 'NotFound', reason: `The plan has no task "${taskId}".` });
    }
    if (task.acceptance.state === 'Removed') {
      return err<DomainError>({
        code: 'Conflict',
        reason: 'A removed proposal cannot be combined back into a task.',
        expected: 'Proposed',
        actual: 'Removed',
      });
    }
    absorbed.push(task);
  }

  const absorbedIds = new Set(fromTaskIds);
  const merged: PlanTask[] = [into, ...absorbed];
  const everyAccepted = merged.every((task) => task.acceptance.state === 'Accepted');

  const seed: TaskSeed = {
    taskId: intoTaskId,
    outcome: joinStatements(merged.map((task) => task.outcome)),
    scope: joinStatements(merged.map((task) => task.scope)),
    acceptanceCriteria: merged.flatMap((task) => [...task.acceptanceCriteria]),
    verificationMethod: joinStatements(merged.map((task) => task.verificationMethod)),
    dependencies: unique(merged.flatMap((task) => task.dependencies.filter((id) => id !== intoTaskId && !absorbedIds.has(id)))),
    relevantProjectContext: unique(merged.flatMap((task) => [...task.relevantProjectContext])),
    implementationLocation: {
      kind: 'ProposedLocation',
      candidates: unique(merged.flatMap((task) => [...task.implementationLocation.candidates])),
      basis: joinStatements(merged.map((task) => task.implementationLocation.basis)),
    },
    coversOutcomeIds: unique(merged.flatMap((task) => [...task.coversOutcomeIds])),
  };

  // Combining produces content the owner has not seen, so the merged task returns to
  // Proposed unless every task in it was already accepted. Acceptance that survives a
  // merge would be acceptance of text nobody agreed to (F08-AC3).
  const combined = freezeTask(
    seed,
    everyAccepted
      ? { state: 'Accepted', acceptedBy: into.acceptance.state === 'Accepted' ? into.acceptance.acceptedBy : by, acceptedAt: at }
      : { state: 'Proposed' },
  );

  const repointed = plan.tasks.map((task) => {
    if (task.taskId === intoTaskId) return combined;
    if (absorbedIds.has(task.taskId)) return freezeTask(task, { state: 'Removed', removedBy: by, removedAt: at });
    if (!task.dependencies.some((id) => absorbedIds.has(id))) return task;
    return freezeTask(
      { ...task, dependencies: unique(task.dependencies.map((id) => (absorbedIds.has(id) ? intoTaskId : id))) },
      task.acceptance,
    );
  });

  return withTasks(plan, repointed);
}

/**
 * Re-establishes coverage after an edit, so the plan's recorded coverage stays true.
 *
 * Removing or combining can orphan an outcome: the task that delivered it may be the
 * one that was removed or absorbed. The edit is refused by name rather than leaving a
 * plan that quietly stopped delivering something the owner asked for (F08-AC5).
 *
 * Exclusions are stored as the owner stated them, including one recorded ahead of the
 * removal it enables. A task that still delivers the outcome is what `coverageCheck`
 * reports, so the coverage record stays unambiguous, and dropping the owner's own
 * statement because a task happens to cover it would make the exclusion unrecordable.
 */
function cover(
  plan: Plan,
  tasks: readonly PlanTask[],
  exclusions: readonly OutcomeExclusion[],
): Result<Plan, DomainError> {
  const coverage = coverageCheck(plan.requestedOutcomes, tasks, exclusions);
  if (!coverage.ok) {
    return err<DomainError>(
      invalid(
        'The edit would leave a requested outcome covered by neither a task nor an explicit exclusion (F08-AC5).',
        coverage.error.code === 'Invalid'
          ? coverage.error.fields.map((field) => ({ path: field.path, message: `The edit would leave ${field.message}` }))
          : [],
      ),
    );
  }

  return ok<Plan>({
    ...plan,
    tasks: Object.freeze([...tasks]),
    exclusions: Object.freeze([...exclusions]),
    coverage: coverage.value.coverage,
  });
}

function withTasks(plan: Plan, tasks: readonly PlanTask[]): Result<Plan, DomainError> {
  return cover(plan, tasks, plan.exclusions);
}

/**
 * Records the owner's decision that a requested outcome is not delivered.
 *
 * Recording it twice for the same outcome replaces the earlier statement rather than
 * accumulating contradictory exclusions, so the reason on the plan is always the one
 * the owner gave last.
 */
function withExclusion(plan: Plan, exclusion: OutcomeExclusion): Result<Plan, DomainError> {
  if (!plan.requestedOutcomes.some((outcome) => outcome.id === exclusion.outcomeId)) {
    return err<DomainError>(
      invalid('An exclusion must name a requested outcome of this plan (F08-AC5).', [
        { path: 'outcomeId', message: `"${exclusion.outcomeId}" is not a requested outcome of this plan.` },
      ]),
    );
  }
  const fieldErrors: FieldError[] = [];
  if (!isFilledText(exclusion.excluded)) {
    fieldErrors.push({ path: 'excluded', message: 'An exclusion must state what is not delivered.' });
  }
  if (!isFilledText(exclusion.reason)) {
    fieldErrors.push({ path: 'reason', message: 'An exclusion must state why the outcome is not delivered.' });
  }
  if (fieldErrors.length > 0) {
    return err<DomainError>(invalid('The exclusion is not usable (F08-AC5).', fieldErrors));
  }

  const others = plan.exclusions.filter((existing) => existing.outcomeId !== exclusion.outcomeId);
  return cover(plan, plan.tasks, [...others, exclusion]);
}

function replaceAt(tasks: readonly PlanTask[], index: number, task: PlanTask): readonly PlanTask[] {
  return tasks.map((current, position) => (position === index ? task : current));
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function joinStatements(parts: readonly string[]): string {
  return parts.filter((part) => part.trim().length > 0).join('\n');
}

function activeTasks(plan: Plan): readonly PlanTask[] {
  return plan.tasks.filter((task) => task.acceptance.state !== 'Removed');
}

/** Whether the owner has not removed this proposal (F08-AC3). */
export function isActive(task: PlanTask): task is ProposedPlanTask | AcceptedPlanTask {
  return task.acceptance.state !== 'Removed';
}

/** Whether this proposal carries owner acceptance, and so may be published (F08-AC3). */
export function isAccepted(task: PlanTask): task is AcceptedPlanTask {
  return task.acceptance.state === 'Accepted';
}

/**
 * The ticket projection an accepted proposal becomes.
 *
 * This is the only form that may be handed to publication, and the title is derived
 * from the accepted outcome rather than stored: F08-AC1 names no title field, and the
 * accepted outcome is the record of what the owner agreed to.
 */
export interface PublishableTicket {
  readonly taskId: string;
  readonly title: string;
  readonly outcome: string;
  readonly scope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly verificationMethod: string;
  readonly dependencyTaskIds: readonly string[];
  readonly relevantProjectContext: readonly string[];
  readonly acceptedBy: string;
  readonly acceptedAt: string;
}

/**
 * Projects an accepted proposal into its publishable ticket (F08-AC3).
 *
 * The parameter is the `Accepted` variant of the task union, so a proposal that was
 * never accepted cannot be projected: the refusal is in the type rather than in a
 * runtime check a later refactor could drop.
 */
export function toPublishableTicket(task: AcceptedPlanTask): PublishableTicket {
  return Object.freeze({
    taskId: task.taskId,
    title: firstStatement(task.outcome),
    outcome: task.outcome,
    scope: task.scope,
    acceptanceCriteria: Object.freeze([...task.acceptanceCriteria]),
    verificationMethod: task.verificationMethod,
    dependencyTaskIds: Object.freeze([...task.dependencies]),
    relevantProjectContext: Object.freeze([...task.relevantProjectContext]),
    acceptedBy: task.acceptance.acceptedBy,
    acceptedAt: task.acceptance.acceptedAt,
  });
}

/**
 * The publishable tickets a plan currently holds.
 *
 * Only accepted proposals appear, so an unaccepted proposal has no publishable
 * representation to leak (F08-AC3).
 */
export function publishableTickets(plan: Plan): readonly PublishableTicket[] {
  return Object.freeze(plan.tasks.filter(isAccepted).map((task) => toPublishableTicket(task)));
}

function firstStatement(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return text.trim();
}

/** Why one task cannot be declared ready (F08-AC4). */
export type TaskReadinessBlocker =
  | { readonly kind: 'Cycle'; readonly cycle: readonly string[] }
  | { readonly kind: 'UnresolvedDependency'; readonly dependsOn: string };

export type TaskReadiness =
  | { readonly taskId: string; readonly ready: true; readonly readyAfter: readonly string[] }
  | { readonly taskId: string; readonly ready: false; readonly blockedBy: readonly TaskReadinessBlocker[] };

export interface PlanReadiness {
  readonly planId: string;
  /** Proposed order with prerequisites first; a cyclic plan has no valid order. */
  readonly order: readonly string[];
  readonly cycles: readonly (readonly string[])[];
  readonly unresolved: readonly { readonly node: string; readonly dependsOn: string }[];
  readonly tasks: readonly TaskReadiness[];
}

/**
 * Which tasks can be declared ready, and in which order (F08-AC4).
 *
 * Analysis is delegated to the shared `analyzeDependencies`, so a plan reports the
 * same cycles and unresolved references as every other caller. Only tasks the owner
 * has not removed are analysed, which is what makes a dependency on removed work
 * unresolved: a task that cannot be delivered because its prerequisite was removed must
 * not be declared ready.
 */
export function planReadiness(plan: Plan): PlanReadiness {
  const active = activeTasks(plan);
  const nodes: DependencyNode[] = active.map((task) => ({ id: task.taskId, dependsOn: [...task.dependencies] }));
  const { order, cycles, unresolved } = analyzeDependencies(nodes);

  const cycleMembers = new Set(cycles.flatMap((cycle) => [...cycle]));
  const tasks: TaskReadiness[] = active.map((task) => {
    const blockedBy: TaskReadinessBlocker[] = [];
    if (cycleMembers.has(task.taskId)) {
      const cycle = cycles.find((members) => members.includes(task.taskId));
      blockedBy.push({ kind: 'Cycle', cycle: cycle ? [...cycle] : [task.taskId] });
    }
    for (const reference of unresolved.filter((entry) => entry.node === task.taskId)) {
      blockedBy.push({ kind: 'UnresolvedDependency', dependsOn: reference.dependsOn });
    }
    if (blockedBy.length > 0) {
      return { taskId: task.taskId, ready: false, blockedBy: Object.freeze(blockedBy) };
    }
    return {
      taskId: task.taskId,
      ready: true,
      readyAfter: Object.freeze(task.dependencies.filter((id) => active.some((candidate) => candidate.taskId === id))),
    };
  });

  return Object.freeze({
    planId: plan.planId,
    order: Object.freeze([...order]),
    cycles: Object.freeze(cycles.map((cycle) => Object.freeze([...cycle]))),
    unresolved: Object.freeze(unresolved.map((entry) => Object.freeze({ ...entry }))),
    tasks: Object.freeze(tasks),
  });
}
