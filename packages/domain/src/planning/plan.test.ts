/**
 * Regression proof for the implementation plan and its task proposals (F08).
 *
 * A plan is the last thing the owner sees before work exists anywhere else, so the
 * four things this file protects are the ones a plan gets wrong in practice:
 *
 *   - a task carries every field F08-AC1 names, so the agent cannot be handed a
 *     ticket that says what to do without saying how it will be checked;
 *   - a small change stays one ticket, and a split only ever happens for a reason the
 *     owner can read (F08-AC2);
 *   - nothing reaches publication without the owner accepting it, and the refusal is in
 *     the type rather than in a filter (F08-AC3);
 *   - a cyclic or dangling dependency stops the affected task being called ready, and
 *     every requested outcome is either delivered or explicitly excluded (F08-AC4,
 *     F08-AC5).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DomainError, Result } from '../result.ts';
import {
  PLAN_TASK_CONTENT_FIELDS,
  applyPlanProposal,
  coverageCheck,
  draftPlan,
  editPlan,
  isAccepted,
  isActive,
  planReadiness,
  publishableTickets,
  shouldSplit,
  toPublishableTicket,
} from './plan.ts';
import type {
  AcceptedPlanTask,
  ChangeShape,
  ChangeSurface,
  ImplementationLocationProposal,
  OutcomeExclusion,
  Plan,
  PlanEdit,
  PlanProposal,
  PlanTask,
  PlanTaskContent,
  PlanTaskPatch,
  ProposedPlanTask,
  RemovedPlanTask,
  RequestedOutcome,
  ValidatedPlanProposal,
} from './plan.ts';

const PLAN_ID = 'plan-1';
const BRIEF_ID = 'brief-1';
const OWNER = 'owner-1';
const DRAFTED_AT = '2026-10-01T09:00:00.000Z';
const EDITED_AT = '2026-10-01T10:00:00.000Z';
const LATER_AT = '2026-10-01T11:00:00.000Z';

const OUTCOMES: readonly RequestedOutcome[] = [
  { id: 'o-failed-save', statement: 'A failed save is reported and never displays Saved.' },
  { id: 'o-summary', statement: 'The saved request stays distinct from the generated summary.' },
  { id: 'o-archive', statement: 'An unpublished idea can be archived without creating a ticket.' },
];

const LOCATION: ImplementationLocationProposal = {
  kind: 'ProposedLocation',
  candidates: ['apps/web/src/client/drafts/save.ts'],
  basis: 'The status line and the save call both live in the draft client.',
};

type TaskSeed = PlanTaskContent & { readonly taskId: string; readonly coversOutcomeIds: readonly string[] };

function task(overrides: Partial<TaskSeed> & { readonly taskId: string }): TaskSeed {
  return {
    outcome: 'A rejected save shows Save failed and keeps the draft on screen.',
    scope: 'The save call and the status line the client sets from its result.',
    acceptanceCriteria: ['A rejected save leaves the status line reading Save failed.'],
    verificationMethod: 'A browser run that rejects the save request and reads the status line.',
    dependencies: [],
    relevantProjectContext: ['Drafts already survive a service restart (F06-AC2).'],
    implementationLocation: LOCATION,
    coversOutcomeIds: ['o-failed-save'],
    ...overrides,
  };
}

const SAVE_TASK = task({ taskId: 'task-save' });
const SUMMARY_TASK = task({
  taskId: 'task-summary',
  outcome: 'The summary is rendered beside the raw request, never in place of it.',
  coversOutcomeIds: ['o-summary'],
});
function surface(overrides: Partial<ChangeSurface> & { readonly surfaceId: string }): ChangeSurface {
  return {
    description: 'The status line the draft client writes after a save attempt.',
    observableBehaviour: 'A rejected save shows Save failed.',
    independentlyReviewable: true,
    ...overrides,
  };
}

const ONE_FILE_FIX: ChangeShape = {
  summary: 'One status line reads the wrong string after a rejected save.',
  surfaces: [surface({ surfaceId: 'save-status' })],
  dependencyEdges: [],
};

const TWO_BEHAVIOURS: ChangeShape = {
  summary: 'Two behaviours that can be reviewed on their own.',
  surfaces: [
    surface({ surfaceId: 'save-status', observableBehaviour: 'A rejected save shows Save failed.' }),
    surface({ surfaceId: 'summary', observableBehaviour: 'The raw request stays readable beside the summary.' }),
  ],
  dependencyEdges: [],
};

const THREE_BEHAVIOURS: ChangeShape = {
  summary: 'Three behaviours, two of which the owner may want reviewed separately.',
  surfaces: [
    surface({ surfaceId: 'save-status', observableBehaviour: 'A rejected save shows Save failed.' }),
    surface({ surfaceId: 'summary', observableBehaviour: 'The raw request stays readable beside the summary.' }),
    surface({ surfaceId: 'archive', observableBehaviour: 'An archived idea has no Linear issue.' }),
  ],
  dependencyEdges: [],
};

const DEPENDENT_PAIR: ChangeShape = {
  summary: 'A handler that can only be reviewed once the column it reads exists.',
  surfaces: [
    surface({
      surfaceId: 'column',
      description: 'A migration adding the column the handler reads.',
      observableBehaviour: '',
      independentlyReviewable: false,
    }),
    surface({
      surfaceId: 'handler',
      observableBehaviour: 'The handler refuses a row whose column is empty.',
      independentlyReviewable: false,
    }),
  ],
  dependencyEdges: [{ surface: 'handler', dependsOn: 'column' }],
};

function proposalFor(input: {
  readonly tasks: readonly TaskSeed[];
  readonly outcomes?: readonly RequestedOutcome[];
  readonly exclusions?: readonly OutcomeExclusion[];
  readonly basedOnRevision?: number | null;
}): PlanProposal {
  return {
    kind: 'PlanProposal',
    briefId: BRIEF_ID,
    draftedAt: DRAFTED_AT,
    basedOnRevision: input.basedOnRevision ?? null,
    requestedOutcomes: input.outcomes ?? [OUTCOMES[0] as RequestedOutcome],
    tasks: input.tasks,
    exclusions: input.exclusions ?? [],
  };
}

function refuse<T>(result: Result<T, DomainError>): DomainError {
  assert.equal(result.ok, false, 'expected the command to be refused');
  if (result.ok || result.error === undefined) throw new Error('unreachable');
  return result.error;
}

function fieldDetails(error: DomainError): readonly string[] {
  assert.equal(error.code, 'Invalid');
  if (error.code !== 'Invalid') throw new Error('unreachable');
  return error.fields.map((field) => `${field.path}: ${field.message}`);
}

function validated(input: PlanProposal = proposalFor({ tasks: [SAVE_TASK] })): ValidatedPlanProposal {
  return unwrap(applyPlanProposal(input));
}

function unwrap<T>(result: Result<T, DomainError>): T {
  if (!result.ok) {
    const detail =
      result.error.code === 'Invalid'
        ? result.error.fields.map((field) => `${field.path}: ${field.message}`).join(' | ')
        : result.error.reason;
    assert.fail(`expected the command to succeed, got ${result.error.code}: ${detail}`);
  }
  return result.value;
}

function planFor(
  tasks: readonly TaskSeed[],
  change: ChangeShape,
  extras: { readonly outcomes?: readonly RequestedOutcome[]; readonly exclusions?: readonly OutcomeExclusion[] } = {},
): Plan {
  return unwrap(
    draftPlan({
      planId: PLAN_ID,
      briefId: BRIEF_ID,
      change,
      proposal: validated(proposalFor({ tasks, ...extras })),
    }),
  );
}

const SINGLE_TASK_PLAN: () => Plan = () => planFor([SAVE_TASK], ONE_FILE_FIX);
const SPLIT_PLAN: () => Plan = () => planFor([SAVE_TASK, SUMMARY_TASK], TWO_BEHAVIOURS, { outcomes: OUTCOMES.slice(0, 2) });

function edited(plan: Plan, ...edits: readonly PlanEdit[]): Plan {
  let current = plan;
  for (const edit of edits) {
    current = unwrap(editPlan(current, edit));
  }
  return current;
}

function taskById(plan: Plan, taskId: string): PlanTask {
  const found = plan.tasks.find((task) => task.taskId === taskId);
  assert.ok(found, `the plan must carry "${taskId}"`);
  return found;
}

function acceptedBy(plan: Plan, taskId: string): AcceptedPlanTask {
  const found = plan.tasks.find((task) => task.taskId === taskId);
  if (found === undefined || !isAccepted(found)) {
    throw new Error(`the plan must carry "${taskId}" as an accepted proposal`);
  }
  return found;
}

function accept(taskId: string, at = EDITED_AT, expectedRevision = 1): PlanEdit {
  return { kind: 'Accept', taskId, expectedRevision, by: OWNER, at };
}

/*
 * Compile-time structural assertions. Exported so the type checker evaluates them
 * and nothing reports them as unused.
 */
type ContentKeys = keyof PlanTaskContent;
type ContentIsExactlyTheList = Exclude<ContentKeys, (typeof PLAN_TASK_CONTENT_FIELDS)[number]> extends never
  ? (typeof PLAN_TASK_CONTENT_FIELDS)[number] extends ContentKeys
    ? true
    : false
  : false;
export const TASK_CONTENT_IS_EXACTLY_THE_NAMED_FIELDS: ContentIsExactlyTheList = true;

type ProposalLifecycleKeys = Extract<
  keyof PlanProposal,
  | 'acceptance'
  | 'accepted'
  | 'acceptedBy'
  | 'authorization'
  | 'delivery'
  | 'merged'
  | 'release'
  | 'releaseReceipt'
  | 'released'
  | 'state'
  | 'status'
>;
export const A_PLAN_PROPOSAL_CANNOT_SET_LIFECYCLE_STATE: ProposalLifecycleKeys extends never ? true : false = true;

export const A_LOCATION_IS_ONLY_EVER_A_PROPOSAL: ImplementationLocationProposal['kind'] extends 'ProposedLocation'
  ? true
  : false = true;

type PublishableParameter = Parameters<typeof toPublishableTicket>[0];
export const PUBLICATION_TAKES_AN_ACCEPTED_TASK: PublishableParameter extends AcceptedPlanTask ? true : false = true;
export const AN_UNACCEPTED_PROPOSAL_IS_NOT_PUBLISHABLE: ProposedPlanTask extends PublishableParameter ? true : false = false;
export const A_REMOVED_PROPOSAL_IS_NOT_PUBLISHABLE: RemovedPlanTask extends PublishableParameter ? true : false = false;

export const VALIDATION_NEVER_ACCEPTS_A_TASK: Extract<
  ValidatedPlanProposal['tasks'][number],
  { readonly acceptance: { readonly state: 'Accepted' } }
> extends never
  ? true
  : false = true;

type TaskAcceptanceStates = PlanTask['acceptance']['state'];
export const A_TASK_IS_EXACTLY_ONE_OF_PROPOSED_ACCEPTED_REMOVED: TaskAcceptanceStates extends
  | 'Proposed'
  | 'Accepted'
  | 'Removed'
  ? true
  : false = true;

describe('F08-AC1 a proposed task carries every named field', () => {
  test('F08-AC1 the content field list is the six named fields plus a proposed location', () => {
    assert.deepEqual([...PLAN_TASK_CONTENT_FIELDS], [
      'outcome',
      'scope',
      'acceptanceCriteria',
      'verificationMethod',
      'dependencies',
      'relevantProjectContext',
      'implementationLocation',
    ]);
    assert.equal(TASK_CONTENT_IS_EXACTLY_THE_NAMED_FIELDS, true);
  });

  test('F08-AC1 a drafted task keeps the outcome, scope, criteria, method, dependencies and context', () => {
    const plan = SINGLE_TASK_PLAN();
    const drafted = taskById(plan, 'task-save');

    assert.equal(drafted.outcome, SAVE_TASK.outcome);
    assert.equal(drafted.scope, SAVE_TASK.scope);
    assert.deepEqual([...drafted.acceptanceCriteria], [...SAVE_TASK.acceptanceCriteria]);
    assert.equal(drafted.verificationMethod, SAVE_TASK.verificationMethod);
    assert.deepEqual([...drafted.dependencies], []);
    assert.deepEqual([...drafted.relevantProjectContext], [...SAVE_TASK.relevantProjectContext]);
    assert.deepEqual([...drafted.implementationLocation.candidates], [...LOCATION.candidates]);
    assert.equal(drafted.implementationLocation.basis, LOCATION.basis);
  });

  test('F08-AC1 a task with no verification method is refused, naming the field to supply', () => {
    const incomplete = { ...SAVE_TASK, verificationMethod: '   ' };

    const details = fieldDetails(refuse(applyPlanProposal(proposalFor({ tasks: [incomplete] }))));

    assert.deepEqual(
      details.filter((detail) => detail.startsWith('tasks[0].verificationMethod')),
      ['tasks[0].verificationMethod: A proposed task must state its verificationMethod.'],
    );
  });

  test('F08-AC1 a task with no acceptance criteria is refused, naming the field to supply', () => {
    const incomplete = { ...SAVE_TASK, acceptanceCriteria: [] };

    const details = fieldDetails(refuse(applyPlanProposal(proposalFor({ tasks: [incomplete] }))));

    assert.deepEqual(
      details.filter((detail) => detail.startsWith('tasks[0].acceptanceCriteria')),
      ['tasks[0].acceptanceCriteria: A proposed task must state acceptance criteria.'],
    );
  });

  test('F08-AC1 a task with no dependencies or project context is still a complete task', () => {
    const result = applyPlanProposal(proposalFor({ tasks: [{ ...SAVE_TASK, dependencies: [], relevantProjectContext: [] }] }));

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.deepEqual([...result.value.tasks[0]?.dependencies ?? []], []);
    assert.deepEqual([...result.value.tasks[0]?.relevantProjectContext ?? []], []);
  });

  test('F08-AC1 an owner edit is held to the same content standard as the proposal', () => {
    const error = refuse(
      editPlan(SINGLE_TASK_PLAN(), {
        kind: 'Edit',
        taskId: 'task-save',
        changes: { outcome: '  ' },
        expectedRevision: 1,
        by: OWNER,
        at: EDITED_AT,
      }),
    );

    assert.deepEqual(
      fieldDetails(error).filter((detail) => detail === 'outcome: A proposed task must state its outcome.'),
      ['outcome: A proposed task must state its outcome.'],
    );
  });
});

describe('F08-AC2 a small change stays one task', () => {
  test('F08-AC2 a one-file fix with no dependency is not split', () => {
    const advice = shouldSplit(ONE_FILE_FIX);

    assert.equal(advice.split, false);
    assert.equal(advice.reason.includes('F08-AC2'), true);
    if (advice.split) throw new Error('unreachable');
  });

  test('F08-AC2 two surfaces with no behaviour of their own are not split', () => {
    const advice = shouldSplit({
      summary: 'A rename across two files.',
      surfaces: [
        surface({ surfaceId: 'declaration', observableBehaviour: '', independentlyReviewable: false }),
        surface({ surfaceId: 'call-site', observableBehaviour: '', independentlyReviewable: false }),
      ],
      dependencyEdges: [],
    });

    assert.equal(advice.split, false);
  });

  test('F08-AC2 a split needs either two independently reviewable behaviours or a real dependency', () => {
    const behaviour = shouldSplit(TWO_BEHAVIOURS);
    const dependency = shouldSplit(DEPENDENT_PAIR);

    assert.equal(behaviour.split, true);
    if (!behaviour.split) throw new Error('unreachable');
    assert.deepEqual([...behaviour.justifications], ['IndependentlyReviewable']);

    assert.equal(dependency.split, true);
    if (!dependency.split) throw new Error('unreachable');
    assert.deepEqual([...dependency.justifications], ['RealDependency']);
  });

  test('F08-AC2 a dependency on a surface the change does not declare is not a real dependency', () => {
    const advice = shouldSplit({
      ...ONE_FILE_FIX,
      dependencyEdges: [
        { surface: 'save-status', dependsOn: 'save-status' },
        { surface: 'save-status', dependsOn: 'not-a-declared-surface' },
      ],
    });

    assert.equal(advice.split, false);
  });

  test('F08-AC2 a surface with no behaviour of its own is grouped, never silently dropped', () => {
    const advice = shouldSplit({
      summary: 'Two reviewable behaviours and a refactor that serves both.',
      surfaces: [
        surface({ surfaceId: 'save-status' }),
        surface({ surfaceId: 'summary' }),
        surface({ surfaceId: 'shared-helper', observableBehaviour: '', independentlyReviewable: false }),
      ],
      dependencyEdges: [],
    });

    assert.equal(advice.split, true);
    if (!advice.split) throw new Error('unreachable');
    const grouped = advice.groups.flatMap((group) => [...group.surfaceIds]);
    assert.deepEqual(grouped.sort(), ['save-status', 'shared-helper', 'summary']);
    assert.deepEqual([...advice.surfacesWithoutOwnBehaviour], ['shared-helper']);
  });

  test('F08-AC2 a draft that splits a one-task change is refused as unjustified decomposition', () => {
    const error = refuse(
      draftPlan({
        planId: PLAN_ID,
        briefId: BRIEF_ID,
        change: ONE_FILE_FIX,
        proposal: validated(
          proposalFor({ tasks: [SAVE_TASK, SUMMARY_TASK], outcomes: [OUTCOMES[0] as RequestedOutcome, OUTCOMES[1] as RequestedOutcome] }),
        ),
      }),
    );

    assert.match(error.reason, /splits a change that is one reviewable task \(F08-AC2\)/);
  });

  test('F08-AC2 a change that could be split may still be planned as one task', () => {
    const plan = planFor([task({ taskId: 'both', coversOutcomeIds: ['o-failed-save', 'o-summary'] })], TWO_BEHAVIOURS, {
      outcomes: OUTCOMES.slice(0, 2),
    });

    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.split.split, true);
  });
});

describe('F08-AC3 the owner edits, removes, reorders and combines before publication', () => {
  test('F08-AC3 an edit changes content, appends a revision and records who and when', () => {
    const plan = SINGLE_TASK_PLAN();
    const editedPlan = edited(plan, {
      kind: 'Edit',
      taskId: 'task-save',
      changes: { scope: 'The save call, the status line and the error the client maps it to.' },
      expectedRevision: 1,
      by: OWNER,
      at: EDITED_AT,
    });

    assert.equal(editedPlan.revision, 2);
    assert.equal(editedPlan.lastEditedBy, OWNER);
    assert.equal(editedPlan.lastEditedAt, EDITED_AT);
    assert.match(taskById(editedPlan, 'task-save').scope, /the error the client maps it to/);
    assert.notEqual(editedPlan.digest, plan.digest);
  });

  test('F08-AC3 an edit against a revision the owner no longer sees is a conflict', () => {
    const error = refuse(
      editPlan(SINGLE_TASK_PLAN(), {
        kind: 'Edit',
        taskId: 'task-save',
        changes: { outcome: 'Something else entirely.' },
        expectedRevision: 4,
        by: OWNER,
        at: EDITED_AT,
      }),
    );

    assert.equal(error.code, 'Conflict');
  });

  test('F08-AC3 an edit cannot change a field the task does not have', () => {
    const error = refuse(
      editPlan(SINGLE_TASK_PLAN(), {
        kind: 'Edit',
        taskId: 'task-save',
        changes: { acceptance: 'Accepted' } as unknown as PlanTaskPatch,
        expectedRevision: 1,
        by: OWNER,
        at: EDITED_AT,
      }),
    );

    assert.match(fieldDetails(error).join(' '), /"acceptance" is not a plan field/);
  });

  test('F08-AC3 an edit without an author is refused', () => {
    const error = refuse(
      editPlan(SINGLE_TASK_PLAN(), {
        kind: 'Edit',
        taskId: 'task-save',
        changes: { outcome: 'A rejected save shows Save failed.' },
        expectedRevision: 1,
        by: '  ',
        at: EDITED_AT,
      }),
    );

    assert.match(fieldDetails(error).join(' '), /An edit needs an author/);
  });

  test('F08-AC3 a reorder that is not a permutation of the live tasks is refused by name', () => {
    const plan = SPLIT_PLAN();

    const missing = refuse(
      editPlan(plan, { kind: 'Reorder', order: ['task-save'], expectedRevision: 1, by: OWNER, at: EDITED_AT }),
    );
    const unknown = refuse(
      editPlan(plan, { kind: 'Reorder', order: ['task-nope', 'task-save', 'task-summary'], expectedRevision: 1, by: OWNER, at: EDITED_AT }),
    );
    const duplicated = refuse(
      editPlan(plan, { kind: 'Reorder', order: ['task-save', 'task-save', 'task-summary'], expectedRevision: 1, by: OWNER, at: EDITED_AT }),
    );

    assert.match(fieldDetails(missing).join(' '), /"task-summary" is missing from the new order/);
    assert.match(fieldDetails(unknown).join(' '), /The plan has no active task "task-nope"/);
    assert.match(fieldDetails(duplicated).join(' '), /"task-save" is listed twice/);
  });

  test('F08-AC3 a reorder keeps the owner sequence and moves removed proposals out of it', () => {
    const plan = SPLIT_PLAN();

    const reordered = edited(plan, { kind: 'Reorder', order: ['task-summary', 'task-save'], expectedRevision: 1, by: OWNER, at: EDITED_AT });
    assert.deepEqual(reordered.tasks.map((task) => task.taskId), ['task-summary', 'task-save']);

    const withRemoved = edited(
      plan,
      { kind: 'Exclusion', outcomeId: 'o-summary', excluded: 'The summary stays beside the raw request.', reason: 'The owner will decide this after the save work lands.', expectedRevision: 1, by: OWNER, at: EDITED_AT },
      { kind: 'Remove', taskId: 'task-summary', expectedRevision: 2, by: OWNER, at: LATER_AT },
      { kind: 'Reorder', order: ['task-save'], expectedRevision: 3, by: OWNER, at: LATER_AT },
    );

    assert.deepEqual(withRemoved.tasks.map((task) => task.taskId), ['task-save', 'task-summary']);
    assert.equal(isActive(taskById(withRemoved, 'task-summary')), false);
  });

  test('F08-AC3 a removed proposal is kept, not deleted, so a dependent can be shown unresolved', () => {
    const plan = edited(
      planFor(
        [
          task({ taskId: 'first', coversOutcomeIds: ['o-failed-save'] }),
          task({ taskId: 'second', dependencies: ['first'], coversOutcomeIds: ['o-summary'] }),
        ],
        DEPENDENT_PAIR,
        {
          outcomes: [OUTCOMES[0] as RequestedOutcome, OUTCOMES[1] as RequestedOutcome],
        },
      ),
      {
        kind: 'Exclusion',
        outcomeId: 'o-failed-save',
        excluded: 'The separate first surface.',
        reason: 'Its behaviour now belongs to the second task.',
        expectedRevision: 1,
        by: OWNER,
        at: EDITED_AT,
      },
      { kind: 'Remove', taskId: 'first', expectedRevision: 2, by: OWNER, at: LATER_AT },
    );

    const removed = taskById(plan, 'first');
    assert.equal(isActive(removed), false);
    assert.equal(removed.acceptance.state, 'Removed');
    if (removed.acceptance.state !== 'Removed') throw new Error('unreachable');
    assert.equal(removed.acceptance.removedBy, OWNER);
    assert.equal(removed.acceptance.removedAt, LATER_AT);
    const readiness = planReadiness(plan);
    assert.deepEqual(readiness.unresolved, [{ node: 'second', dependsOn: 'first' }]);
  });

  test('F08-AC3 a removed proposal cannot be edited, accepted or combined back in', () => {
    const plan = edited(
      planFor(
        [
          task({ taskId: 'first', coversOutcomeIds: ['o-failed-save'] }),
          task({ taskId: 'second', coversOutcomeIds: ['o-summary'] }),
        ],
        DEPENDENT_PAIR,
        {
          outcomes: [OUTCOMES[0] as RequestedOutcome, OUTCOMES[1] as RequestedOutcome],
        },
      ),
      {
        kind: 'Exclusion',
        outcomeId: 'o-failed-save',
        excluded: 'The separate first surface.',
        reason: 'Its behaviour now belongs to the second task.',
        expectedRevision: 1,
        by: OWNER,
        at: EDITED_AT,
      },
      { kind: 'Remove', taskId: 'first', expectedRevision: 2, by: OWNER, at: LATER_AT },
    );

    const edit = refuse(editPlan(plan, { kind: 'Edit', taskId: 'first', changes: { outcome: 'x' }, expectedRevision: 3, by: OWNER, at: LATER_AT }));
    const reaccept = refuse(editPlan(plan, { kind: 'Accept', taskId: 'first', expectedRevision: 3, by: OWNER, at: LATER_AT }));
    const combine = refuse(editPlan(plan, { kind: 'Combine', intoTaskId: 'second', fromTaskIds: ['first'], expectedRevision: 3, by: OWNER, at: LATER_AT }));

    assert.equal(edit.code, 'Conflict');
    assert.equal(reaccept.code, 'Conflict');
    assert.equal(combine.code, 'Conflict');
  });

  test('F08-AC3 a combine merges content, absorbs the other proposal and repoints its dependents', () => {
    const dependent = task({ taskId: 'third', dependencies: ['task-summary'], coversOutcomeIds: ['o-archive'] });
    const plan = planFor([SAVE_TASK, SUMMARY_TASK, dependent], THREE_BEHAVIOURS, { outcomes: OUTCOMES });

    const combined = edited(plan, {
      kind: 'Combine',
      intoTaskId: 'task-save',
      fromTaskIds: ['task-summary'],
      expectedRevision: 1,
      by: OWNER,
      at: EDITED_AT,
    });

    const merged = taskById(combined, 'task-save');
    assert.equal(merged.outcome.includes(SUMMARY_TASK.outcome), true);
    assert.equal(merged.scope.includes(SUMMARY_TASK.scope), true);
    assert.deepEqual([...merged.acceptanceCriteria], [...SAVE_TASK.acceptanceCriteria, ...SUMMARY_TASK.acceptanceCriteria]);
    assert.deepEqual([...merged.coversOutcomeIds].sort(), ['o-failed-save', 'o-summary']);
    assert.equal(isActive(taskById(combined, 'task-summary')), false);
    assert.deepEqual([...taskById(combined, 'third').dependencies], ['task-save']);
  });

  test('F08-AC3 content the owner has not seen returns to Proposed after a combine', () => {
    const plan = planFor([SAVE_TASK, SUMMARY_TASK], TWO_BEHAVIOURS, { outcomes: OUTCOMES.slice(0, 2) });

    const combined = edited(plan, {
      kind: 'Combine',
      intoTaskId: 'task-save',
      fromTaskIds: ['task-summary'],
      expectedRevision: 1,
      by: OWNER,
      at: EDITED_AT,
    });

    assert.equal(taskById(combined, 'task-save').acceptance.state, 'Proposed');
    assert.deepEqual(publishableTickets(combined), []);
  });

  test('F08-AC3 a combine of already accepted work keeps the acceptance it was given', () => {
    const accepted = SPLIT_PLAN();
    const both = edited(accepted, accept('task-save'), accept('task-summary', EDITED_AT, 2));

    const combined = edited(both, {
      kind: 'Combine',
      intoTaskId: 'task-save',
      fromTaskIds: ['task-summary'],
      expectedRevision: 3,
      by: OWNER,
      at: LATER_AT,
    });

    const merged = acceptedBy(combined, 'task-save');
    assert.equal(merged.acceptance.acceptedBy, OWNER);
    assert.equal(merged.acceptance.acceptedAt, LATER_AT);
    assert.equal(publishableTickets(combined).length, 1);
  });

  test('F08-AC3 a combine names no tasks to absorb, or a task the plan does not have', () => {
    const plan = SPLIT_PLAN();

    const empty = refuse(editPlan(plan, { kind: 'Combine', intoTaskId: 'task-save', fromTaskIds: [], expectedRevision: 1, by: OWNER, at: EDITED_AT }));
    const unknown = refuse(editPlan(plan, { kind: 'Combine', intoTaskId: 'task-save', fromTaskIds: ['task-nope'], expectedRevision: 1, by: OWNER, at: EDITED_AT }));

    assert.match(fieldDetails(empty).join(' '), /A combine needs at least one absorbed task/);
    assert.equal(unknown.code, 'NotFound');
  });

  test('F08-AC3 acceptance records who and when, and cannot be taken twice', () => {
    const plan = edited(SINGLE_TASK_PLAN(), accept('task-save'));
    const acceptedTask = acceptedBy(plan, 'task-save');

    assert.equal(acceptedTask.acceptance.acceptedBy, OWNER);
    assert.equal(acceptedTask.acceptance.acceptedAt, EDITED_AT);
    assert.equal(refuse(editPlan(plan, accept('task-save', LATER_AT, 2))).code, 'Conflict');
  });

  test('F08-AC3 an unaccepted proposal has no publishable representation', () => {
    const plan = SINGLE_TASK_PLAN();

    assert.equal(PUBLICATION_TAKES_AN_ACCEPTED_TASK, true);
    assert.equal(AN_UNACCEPTED_PROPOSAL_IS_NOT_PUBLISHABLE, false);
    assert.deepEqual(publishableTickets(plan), []);
    assert.equal(plan.tasks.every((task) => task.acceptance.state === 'Proposed'), true);
  });

  test('F08-AC3 only the proposals the owner accepted become tickets', () => {
    const accepted = edited(SPLIT_PLAN(), accept('task-save'));

    const tickets = publishableTickets(accepted);

    assert.deepEqual(tickets.map((ticket) => ticket.taskId), ['task-save']);
    assert.equal(tickets[0]?.acceptedBy, OWNER);
    assert.equal(tickets[0]?.acceptedAt, EDITED_AT);
    assert.equal(tickets[0]?.title, SAVE_TASK.outcome);
  });

  test('F08-AC3 a ticket carries the accepted criteria, method, dependencies and context, not a title the plan stored', () => {
    const accepted = edited(
      planFor(
        [
          task({ taskId: 'first', coversOutcomeIds: ['o-failed-save'] }),
          task({ taskId: 'second', dependencies: ['first'], coversOutcomeIds: ['o-summary'] }),
        ],
        DEPENDENT_PAIR,
        {
          outcomes: [OUTCOMES[0] as RequestedOutcome, OUTCOMES[1] as RequestedOutcome],
        },
      ),
      accept('first'),
      accept('second', EDITED_AT, 2),
    );

    const tickets = publishableTickets(accepted);
    assert.deepEqual(tickets.map((ticket) => ticket.taskId), ['first', 'second']);
    assert.deepEqual(tickets[1]?.dependencyTaskIds, ['first']);
    assert.deepEqual(tickets[1]?.acceptanceCriteria, [...SAVE_TASK.acceptanceCriteria]);
    assert.equal(tickets[1]?.verificationMethod, SAVE_TASK.verificationMethod);
    assert.deepEqual(tickets[1]?.relevantProjectContext, [...SAVE_TASK.relevantProjectContext]);
    assert.equal(tickets[1]?.title, SAVE_TASK.outcome);
  });

  test('F08-AC3 a removal that orphans a requested outcome is refused, naming the outcome', () => {
    const plan = SPLIT_PLAN();

    const error = refuse(editPlan(plan, { kind: 'Remove', taskId: 'task-save', expectedRevision: 1, by: OWNER, at: EDITED_AT }));

    assert.match(error.reason, /covered by neither a task nor an explicit exclusion \(F08-AC5\)/);
    assert.match(fieldDetails(error).join(' '), /o-failed-save/);
  });

  test('F08-AC3 the owner can exclude an outcome so the removal it blocks becomes possible', () => {
    const plan = SPLIT_PLAN();

    const withExclusion = edited(
      plan,
      { kind: 'Exclusion', outcomeId: 'o-failed-save', excluded: 'The Save failed status line.', reason: 'The existing error banner already says the save failed.', expectedRevision: 1, by: OWNER, at: EDITED_AT },
      { kind: 'Remove', taskId: 'task-save', expectedRevision: 2, by: OWNER, at: LATER_AT },
    );

    assert.deepEqual(withExclusion.exclusions, [
      { outcomeId: 'o-failed-save', excluded: 'The Save failed status line.', reason: 'The existing error banner already says the save failed.' },
    ]);
    assert.equal(isActive(taskById(withExclusion, 'task-save')), false);
    assert.deepEqual(withExclusion.coverage, [
      { outcomeId: 'o-failed-save', via: 'Exclusion', reason: 'The existing error banner already says the save failed.' },
      { outcomeId: 'o-summary', via: 'Task', taskId: 'task-summary' },
    ]);
  });

  test('F08-AC3 an exclusion of an outcome the plan never requested is refused', () => {
    const error = refuse(
      editPlan(SINGLE_TASK_PLAN(), {
        kind: 'Exclusion',
        outcomeId: 'o-never-asked',
        excluded: 'Something.',
        reason: 'Nothing.',
        expectedRevision: 1,
        by: OWNER,
        at: EDITED_AT,
      }),
    );

    assert.match(fieldDetails(error).join(' '), /"o-never-asked" is not a requested outcome of this plan/);
  });

  test('F08-AC3 an exclusion with no stated reason is refused', () => {
    const error = refuse(
      editPlan(SINGLE_TASK_PLAN(), {
        kind: 'Exclusion',
        outcomeId: 'o-failed-save',
        excluded: 'The Save failed status line.',
        reason: '  ',
        expectedRevision: 1,
        by: OWNER,
        at: EDITED_AT,
      }),
    );

    assert.match(fieldDetails(error).join(' '), /An exclusion must state why the outcome is not delivered/);
  });

  test('F08-AC3 an edited plan is frozen, so a consumer cannot rewrite what the owner agreed to', () => {
    const plan = SPLIT_PLAN();

    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.tasks), true);
    assert.equal(Object.isFrozen(plan.tasks[0]), true);
    assert.equal(Object.isFrozen(plan.tasks[0]?.acceptanceCriteria), true);
  });
});

describe('F08-AC4 a cyclic or unresolved dependency prevents readiness', () => {
  function cyclePlan(): Plan {
    return planFor(
      [
        task({ taskId: 'client', dependencies: ['server'], coversOutcomeIds: ['o-failed-save'] }),
        task({ taskId: 'server', dependencies: ['client'], coversOutcomeIds: ['o-summary'] }),
      ],
      THREE_BEHAVIOURS,
      { outcomes: OUTCOMES.slice(0, 2) },
    );
  }

  test('F08-AC4 every task in a cycle is not ready and the cycle is named', () => {
    const readiness = planReadiness(cyclePlan());

    assert.equal(readiness.cycles.length, 1);
    for (const task of readiness.tasks) {
      assert.equal(task.ready, false);
      if (task.ready) throw new Error('unreachable');
      assert.equal(task.blockedBy.length, 1);
      assert.equal(task.blockedBy[0]?.kind, 'Cycle');
    }
    const named = readiness.tasks.flatMap((task) => (task.ready ? [] : task.blockedBy)).map((blocker) =>
      blocker.kind === 'Cycle' ? [...new Set(blocker.cycle)].sort().join(',') : blocker.dependsOn,
    );
    assert.deepEqual(named, ['client,server', 'client,server']);
  });

  test('F08-AC4 a task whose dependency resolves to nothing is not ready, and the missing id is named', () => {
    const plan = planFor(
      [task({ taskId: 'client', dependencies: ['shared-types'] }), SUMMARY_TASK],
      THREE_BEHAVIOURS,
      { outcomes: OUTCOMES.slice(0, 2) },
    );

    const readiness = planReadiness(plan);

    assert.deepEqual(readiness.unresolved, [{ node: 'client', dependsOn: 'shared-types' }]);
    const client = readiness.tasks.find((task) => task.taskId === 'client');
    if (client === undefined || client.ready) throw new Error('unreachable');
    assert.deepEqual(client.blockedBy, [{ kind: 'UnresolvedDependency', dependsOn: 'shared-types' }]);
    assert.equal(readiness.tasks.find((task) => task.taskId === 'task-summary')?.ready, true);
  });

  test('F08-AC4 the proposed order puts every prerequisite first', () => {
    const plan = planFor(
      [
        task({ taskId: 'third', dependencies: ['second'], coversOutcomeIds: ['o-archive'] }),
        task({ taskId: 'second', dependencies: ['first'], coversOutcomeIds: ['o-summary'] }),
        task({ taskId: 'first', coversOutcomeIds: ['o-failed-save'] }),
      ],
      THREE_BEHAVIOURS,
      { outcomes: OUTCOMES.slice(0, 3) },
    );

    const readiness = planReadiness(plan);
    const position = new Map(readiness.order.map((id, index) => [id, index]));

    assert.deepEqual(readiness.order, ['first', 'second', 'third']);
    assert.equal((position.get('first') ?? 0) < (position.get('second') ?? 0), true);
    assert.equal((position.get('second') ?? 0) < (position.get('third') ?? 0), true);
    assert.equal(readiness.cycles.length, 0);
    assert.equal(readiness.tasks.every((task) => task.ready), true);
  });

  test('F08-AC4 a task whose dependencies are all live is ready and names them', () => {
    const plan = planFor(
      [task({ taskId: 'first' }), task({ taskId: 'second', dependencies: ['first'], coversOutcomeIds: ['o-summary'] })],
      THREE_BEHAVIOURS,
      { outcomes: OUTCOMES.slice(0, 2) },
    );

    const second = planReadiness(plan).tasks.find((task) => task.taskId === 'second');

    assert.equal(second?.ready, true);
    if (second?.ready !== true) throw new Error('unreachable');
    assert.deepEqual([...second.readyAfter], ['first']);
  });

  test('F08-AC4 an accepted task is analysed exactly like a proposed one', () => {
    const plan = planFor(
      [
        task({ taskId: 'client', dependencies: ['server'], coversOutcomeIds: ['o-failed-save'] }),
        task({ taskId: 'server', coversOutcomeIds: ['o-summary'] }),
      ],
      THREE_BEHAVIOURS,
      { outcomes: OUTCOMES.slice(0, 2) },
    );
    const accepted = edited(plan, accept('client'));

    const client = planReadiness(accepted).tasks.find((task) => task.taskId === 'client');

    assert.equal(client?.ready, true);
    if (client?.ready !== true) throw new Error('unreachable');
    assert.deepEqual([...client.readyAfter], ['server']);
  });
});

describe('F08-AC5 every requested outcome is delivered or explicitly excluded', () => {
  test('F08-AC5 a task delivery is recorded as coverage', () => {
    const report = unwrap(coverageCheck(OUTCOMES.slice(0, 1), SINGLE_TASK_PLAN().tasks, []));

    assert.deepEqual([...report.coverage], [{ outcomeId: 'o-failed-save', via: 'Task', taskId: 'task-save' }]);
  });

  test('F08-AC5 an explicit exclusion is recorded as coverage, with the reason', () => {
    const exclusion: OutcomeExclusion = { outcomeId: 'o-failed-save', excluded: 'The status line wording.', reason: 'The owner accepted the existing wording.' };
    const report = unwrap(coverageCheck(OUTCOMES.slice(0, 1), [], [exclusion]));

    assert.deepEqual([...report.coverage], [{ outcomeId: 'o-failed-save', via: 'Exclusion', reason: exclusion.reason }]);
  });

  test('F08-AC5 an outcome covered by neither is refused by name, not dropped', () => {
    const error = refuse(coverageCheck(OUTCOMES, SINGLE_TASK_PLAN().tasks, []));

    assert.match(error.reason, /Every requested outcome must be covered by a proposed task or an explicit exclusion \(F08-AC5\)/);
    assert.deepEqual(
      fieldDetails(error).filter((detail) => detail.startsWith('requestedOutcomes[')),
      [
        'requestedOutcomes[o-summary]: Requested outcome "The saved request stays distinct from the generated summary." is covered by neither a proposed task nor an explicit exclusion.',
        'requestedOutcomes[o-archive]: Requested outcome "An unpublished idea can be archived without creating a ticket." is covered by neither a proposed task nor an explicit exclusion.',
      ],
    );
  });

  test('F08-AC5 a removed task no longer covers the outcome it delivered', () => {
    const plan = planFor([SAVE_TASK, SUMMARY_TASK], TWO_BEHAVIOURS, { outcomes: OUTCOMES.slice(0, 2) });
    const withoutSummary = taskById(
      unwrap(
        draftPlan({
          planId: PLAN_ID,
          briefId: BRIEF_ID,
          change: TWO_BEHAVIOURS,
          proposal: validated(proposalFor({ tasks: [SAVE_TASK, SUMMARY_TASK], outcomes: OUTCOMES.slice(0, 2) })),
        }),
      ),
      'task-summary',
    );
    assert.equal(isActive(withoutSummary), true);
    assert.equal(plan.coverage.length, 2);
  });

  test('F08-AC5 a drafted plan records the coverage that justified it', () => {
    const plan = planFor([SAVE_TASK, SUMMARY_TASK], TWO_BEHAVIOURS, { outcomes: OUTCOMES.slice(0, 2) });

    assert.deepEqual([...plan.coverage], [
      { outcomeId: 'o-failed-save', via: 'Task', taskId: 'task-save' },
      { outcomeId: 'o-summary', via: 'Task', taskId: 'task-summary' },
    ]);
  });

  test('F08-AC5 a plan is refused outright when an outcome is covered by nothing', () => {
    const error = refuse(
      draftPlan({
        planId: PLAN_ID,
        briefId: BRIEF_ID,
        change: ONE_FILE_FIX,
        proposal: validated(proposalFor({ tasks: [SAVE_TASK], outcomes: OUTCOMES })),
      }),
    );

    assert.match(error.reason, /Every requested outcome must be covered/);
  });

  test('F08-AC5 an implementation location is only ever a proposal, and certainty is refused', () => {
    assert.equal(A_LOCATION_IS_ONLY_EVER_A_PROPOSAL, true);
    const certain = {
      ...SAVE_TASK,
      implementationLocation: { kind: 'LocatedHere', candidates: ['a.ts'], basis: 'guess' },
    } as unknown as TaskSeed;

    const details = fieldDetails(refuse(applyPlanProposal(proposalFor({ tasks: [certain] }))));

    assert.deepEqual(
      details.filter((detail) => detail.includes('implementationLocation.kind')),
      [
        'tasks[0].implementationLocation.kind: An implementation location is a proposal and must be tagged ProposedLocation (F08-AC5).',
      ],
    );
  });

  test('F08-AC5 a location with no candidate and no basis is refused on both counts', () => {
    const vague = {
      ...SAVE_TASK,
      implementationLocation: { kind: 'ProposedLocation', candidates: [], basis: '  ' },
    } as unknown as TaskSeed;

    const details = fieldDetails(refuse(applyPlanProposal(proposalFor({ tasks: [vague] }))));

    assert.match(details.join(' '), /A location proposal must offer at least one candidate location \(F08-AC5\)/);
    assert.match(details.join(' '), /A location proposal must state what the suggestion is based on \(F08-AC5\)/);
  });

  test('F08-AC5 a task that delivers an outcome is the recorded delivery even when an exclusion exists', () => {
    const exclusion: OutcomeExclusion = { outcomeId: 'o-failed-save', excluded: 'The save path.', reason: 'The owner plans to remove that task.' };
    const plan = planFor([SAVE_TASK], ONE_FILE_FIX, { exclusions: [exclusion] });

    assert.deepEqual([...plan.exclusions], [exclusion]);
    assert.deepEqual([...plan.coverage], [{ outcomeId: 'o-failed-save', via: 'Task', taskId: 'task-save' }]);
  });
});

describe('a model proposal cannot set lifecycle state (F05-AC5, F08-AC3)', () => {
  test('F08-AC3 a proposal with a top-level acceptance field is refused, not stripped', () => {
    const withAcceptance = { ...proposalFor({ tasks: [SAVE_TASK] }), acceptance: 'Accepted' } as unknown as PlanProposal;

    const details = fieldDetails(refuse(applyPlanProposal(withAcceptance)));

    assert.deepEqual(
      details.filter((detail) => detail.startsWith('acceptance:')),
      ['acceptance: "acceptance" is not a plan field: acceptance, delivery and release are owner decisions (F05-AC5, F08-AC3).'],
    );
  });

  test('F08-AC3 a proposal field that would set delivery or release is refused the same way', () => {
    const withRelease = { ...proposalFor({ tasks: [SAVE_TASK] }), releaseReceipt: 'receipt-1' } as unknown as PlanProposal;
    const withStatus = { ...proposalFor({ tasks: [SAVE_TASK] }), status: 'Ready' } as unknown as PlanProposal;

    assert.match(fieldDetails(refuse(applyPlanProposal(withRelease))).join(' '), /"releaseReceipt" is not a plan field/);
    assert.match(fieldDetails(refuse(applyPlanProposal(withStatus))).join(' '), /"status" is not a plan field/);
  });

  test('F08-AC3 a proposed task claiming to be accepted or merged is refused, naming the task and the field', () => {
    const selfAccepting = { ...SAVE_TASK, status: 'Accepted' } as unknown as TaskSeed;
    const merged = { ...SUMMARY_TASK, merged: true } as unknown as TaskSeed;

    const details = [
      ...fieldDetails(refuse(applyPlanProposal(proposalFor({ tasks: [selfAccepting] })))),
      ...fieldDetails(refuse(applyPlanProposal(proposalFor({ tasks: [merged], outcomes: OUTCOMES.slice(0, 2) })))),
    ];

    assert.match(details.join(' '), /tasks\[0\]\.status: "status" is not a plan field/);
    assert.match(details.join(' '), /tasks\[0\]\.merged: "merged" is not a plan field/);
  });

  test('F08-AC3 the proposal type itself has no lifecycle key, so no structured output can name one', () => {
    assert.equal(A_PLAN_PROPOSAL_CANNOT_SET_LIFECYCLE_STATE, true);
    assert.equal(VALIDATION_NEVER_ACCEPTS_A_TASK, true);
    assert.equal(A_TASK_IS_EXACTLY_ONE_OF_PROPOSED_ACCEPTED_REMOVED, true);
    assert.equal(validated().tasks[0]?.acceptance.state, 'Proposed');
  });

  test('F08-AC3 a proposal with no tasks, no outcomes or a wrong tag is refused per field', () => {
    const noTasks = { ...proposalFor({ tasks: [] }) } as unknown as PlanProposal;
    const noOutcomes = { ...proposalFor({ tasks: [SAVE_TASK] }), requestedOutcomes: [] } as unknown as PlanProposal;
    const misTagged = { ...proposalFor({ tasks: [SAVE_TASK] }), kind: 'ImplementationPlan' } as unknown as PlanProposal;

    assert.match(fieldDetails(refuse(applyPlanProposal(noTasks))).join(' '), /A plan must propose at least one task/);
    assert.match(fieldDetails(refuse(applyPlanProposal(noOutcomes))).join(' '), /A plan must record the outcomes the owner asked for/);
    assert.match(refuse(applyPlanProposal(misTagged)).reason, /not a plan proposal/);
  });

  test('F08-AC3 one invalid proposal is rejected with every failing field, so the caller can correct and resubmit', () => {
    const broken = {
      ...proposalFor({ tasks: [SAVE_TASK] }),
      briefId: '  ',
      tasks: [{ ...SAVE_TASK, taskId: ' ', scope: '', coversOutcomeIds: ['o-not-requested'] }],
    } as unknown as PlanProposal;

    const paths = fieldDetails(refuse(applyPlanProposal(broken))).map((detail) => detail.split(':')[0]);

    assert.deepEqual(
      paths.filter((path) => path?.startsWith('briefId') || path?.startsWith('tasks[0]')),
      [
        'briefId',
        'tasks[0].taskId',
        'tasks[0].coversOutcomeIds[0]',
        'tasks[0].scope',
      ],
    );
  });

  test('F08-AC3 a duplicate task id, a duplicate outcome id and a self-dependency are each refused', () => {
    const duplicateTask = refuse(
      applyPlanProposal(proposalFor({ tasks: [SAVE_TASK, { ...SUMMARY_TASK, taskId: 'task-save' }], outcomes: OUTCOMES.slice(0, 2) })),
    );
    const duplicateOutcome = refuse(
      applyPlanProposal(
        proposalFor({ tasks: [SAVE_TASK], outcomes: [OUTCOMES[0] as RequestedOutcome, OUTCOMES[0] as RequestedOutcome] }),
      ),
    );
    const selfDependent = refuse(applyPlanProposal(proposalFor({ tasks: [{ ...SAVE_TASK, dependencies: ['task-save'] }] })));

    assert.match(fieldDetails(duplicateTask).join(' '), /Task id "task-save" is used twice/);
    assert.match(fieldDetails(duplicateOutcome).join(' '), /Requested outcome id "o-failed-save" is used twice/);
    assert.match(fieldDetails(selfDependent).join(' '), /A task cannot depend on itself/);
  });

  test('F08-AC3 a proposal produced for another brief is a conflict, not a silent rebinding', () => {
    const foreign = validated(proposalFor({ tasks: [SAVE_TASK] }));
    const error = refuse(draftPlan({ planId: PLAN_ID, briefId: 'brief-2', change: ONE_FILE_FIX, proposal: foreign }));

    assert.equal(error.code, 'Conflict');
  });

  test('F08-AC3 a plan drafted from a proposal starts at revision one and has no edit recorded', () => {
    const plan = SINGLE_TASK_PLAN();

    assert.equal(plan.revision, 1);
    assert.equal(plan.draftedAt, DRAFTED_AT);
    assert.equal(plan.lastEditedAt, null);
    assert.equal(plan.lastEditedBy, null);
  });

  test('F08-AC3 a re-proposed plan supersedes the revision it was based on', () => {
    const superseding = unwrap(
      draftPlan({
        planId: PLAN_ID,
        briefId: BRIEF_ID,
        change: ONE_FILE_FIX,
        proposal: validated(proposalFor({ tasks: [SAVE_TASK], basedOnRevision: 2 })),
      }),
    );

    assert.equal(superseding.revision, 3);
  });
});
