/**
 * The delivery contract's editable content, as pure data.
 *
 * The whole point of this module is that the rules which decide whether a contract may be
 * approved are *derived from the draft in front of the owner*, not left to the server to
 * discover at the end. Approval refuses an automated criterion that names no check, with a
 * 400 naming `acceptanceCriteria.<id>.verificationCheckId`. Discovering that only after
 * pressing Approve means the owner is told their contract was wrong at the moment they
 * were declaring it right, and it gives them a round trip to fix it. So the binding is
 * checked here, in the same terms, and the check is the same check the server makes —
 * not a client-side guess at it.
 *
 * Nothing in this module touches the network, React, or the DOM, so every rule below is
 * directly testable and every component that renders a draft agrees on what a valid one is.
 */

import type {
  ContractContentInput,
  ContractView,
  VerificationCheckChoices,
} from './contract-client.ts';

/**
 * Who settles a criterion.
 *
 * A closed vocabulary rather than free text, because a text field here is how "verified"
 * comes to mean "someone read it". The same pair the route accepts and the review card
 * reports, spelled the same way, so no translation layer can drift from the server's.
 */
export type VerificationType = 'automated' | 'owner_test';

/**
 * One criterion as the owner is editing it.
 *
 * `key` is a stable handle for React and for the field-error map, kept separate from `id`.
 * The owner cannot retype ids, so `id` is generated once when the row is created and never
 * changes; `key` survives a reorder and is what the DOM addresses. Conflating them means a
 * rejected message lands on the wrong row the moment two rows are swapped.
 */
export interface DraftCriterion {
  readonly key: string;
  /** The identity the server stores and the approval refusal names. Generated, not typed. */
  readonly id: string;
  readonly description: string;
  readonly verificationType: VerificationType;
  /** A check name, or null when nothing is bound. */
  readonly verificationCheckId: string | null;
}

/** One contract revision as the owner edits it. */
export interface ContractDraft {
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly DraftCriterion[];
}

/** Longest title the route accepts; a title is a label, not a document. */
export const MAXIMUM_TITLE_LENGTH = 200;

/** Longest criterion id the route accepts. */
const MAXIMUM_CRITERION_ID_LENGTH = 128;

/** Longest check name the route accepts. */
const MAXIMUM_CHECK_NAME_LENGTH = 200;

/**
 * The route's own bounds, repeated here so the client can predict them.
 *
 * Kept in step with `routes/contracts.ts` rather than trusted from it at runtime: a bound
 * enforced only by the server is a bound the owner discovers by being refused, and the
 * whole point of this module is to reach the same conclusion first. `contract-draft.test.ts`
 * asserts these agree with the route's schema.
 */
const MAXIMUM_LIST_ENTRIES = 200;
const MAXIMUM_CRITERIA = 100;

/**
 * A criterion id derived from the row's position and the ids already in use.
 *
 * `AC1`, `AC2`, … — a stable identity the owner never has to invent, and one that reads
 * back in a refusal message. `used` is consulted so a removed row's id is not handed to a
 * new row: two criteria sharing an id would make the approval refusal name one of them
 * ambiguously, and the review card would report a verdict against the wrong criterion.
 */
export function nextCriterionId(used: readonly string[]): string {
  let highest = 0;
  for (const id of used) {
    const match = /^AC(\d+)$/.exec(id);
    if (match === null) continue;
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > highest) highest = value;
  }
  let candidate = `AC${highest + 1}`;
  let suffix = 2;
  while (used.includes(candidate)) {
    candidate = `AC${highest + 1}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** One empty criterion, with an id unique among `used`. */
export function blankCriterion(used: readonly string[], key: string): DraftCriterion {
  return {
    key,
    id: nextCriterionId(used),
    description: '',
    // `automated` rather than `owner_test`: a new criterion is normally something a check
    // can settle, and the alternative would silently make every new row the owner's own
    // manual step. The binding is left null and the owner must choose one, which the
    // approval check below then requires.
    verificationType: 'automated',
    verificationCheckId: null,
  };
}

/** An empty draft for a request that has no contract yet. */
export function emptyDraft(): ContractDraft {
  return { outcome: '', scope: [], outOfScope: [], acceptanceCriteria: [blankCriterion([], 'criterion-1')] };
}

/** A draft seeded from what the owner asked for, so the outcome is not retyped. */
export function draftFromRequest(request: { readonly title: string; readonly description: string }): ContractDraft {
  return { ...emptyDraft(), outcome: request.description };
}

/** The stored revision as an editable draft, keeping every criterion identity. */
export function draftFromContract(contract: ContractView): ContractDraft {
  return {
    outcome: contract.outcome,
    scope: [...contract.scope],
    outOfScope: [...contract.outOfScope],
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion, index) => ({
      key: `criterion-${index + 1}-${criterion.id}`,
      id: criterion.id,
      description: criterion.description,
      verificationType: criterion.verificationType,
      verificationCheckId: criterion.verificationCheckId,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Why a contract cannot be approved yet                                      */
/* -------------------------------------------------------------------------- */

/** One reason the contract in front of the owner is not approvable, with where to fix it. */
export interface DraftProblem {
  /** A stable handle for the DOM, so a message is attached to the input that caused it. */
  readonly key: string;
  readonly message: string;
}

export interface DraftProblems {
  /** Problems with the outcome. */
  readonly outcome: readonly DraftProblem[];
  /** Problems with a scope entry, keyed by its index. */
  readonly scope: readonly DraftProblem[];
  readonly outOfScope: readonly DraftProblem[];
  /** Problems with one criterion, keyed by that row's `key`. */
  readonly criteria: Readonly<Record<string, readonly DraftProblem[]>>;
  /** Problems with a check binding, keyed by criterion `key`. */
  readonly bindings: Readonly<Record<string, readonly DraftProblem[]>>;
  /** True when nothing above is wrong. */
  readonly approvable: boolean;
}

const NO_PROBLEMS: DraftProblems = {
  outcome: [],
  scope: [],
  outOfScope: [],
  criteria: {},
  bindings: {},
  approvable: true,
};

/**
 * Why this draft cannot be approved yet.
 *
 * These are the same rules `routes/contracts.ts` and the domain enforce, in the same
 * terms, so an owner is never told a contract is fine and then refused:
 *
 *   - the outcome is required, and criteria are required (at least one);
 *   - a list entry may not be blank — the route refuses one, because an empty entry says
 *     nothing and the owner meant to remove it;
 *   - **an `automated` criterion must name a check.** This is the binding that decides
 *     which check settles the criterion, and an automated criterion with nothing bound
 *     could only ever read unverified and would block acceptance forever;
 *   - **an `owner_test` criterion must name none.** A named check is precisely the
 *     automated verification an owner test exists to replace: binding one would let a
 *     green check discharge work only the owner can judge (F23-AC1).
 */
export function draftProblems(draft: ContractDraft): DraftProblems {
  const outcome: DraftProblem[] = [];
  if (draft.outcome.trim() === '') {
    outcome.push({ key: 'outcome', message: 'A contract needs the outcome it promises.' });
  }

  const scope = listProblems(draft.scope, 'scope');
  const outOfScope = listProblems(draft.outOfScope, 'outOfScope');

  const criteria: Record<string, readonly DraftProblem[]> = {};
  const bindings: Record<string, readonly DraftProblem[]> = {};
  // Both bounds attach to the criteria region rather than a row: the offending entry is the
  // one past the bound, and there is no row for it.
  if (draft.acceptanceCriteria.length === 0) {
    criteria['criteria-region'] = [{ key: 'criteria-region', message: 'A contract needs at least one acceptance criterion.' }];
  } else if (draft.acceptanceCriteria.length > MAXIMUM_CRITERIA) {
    criteria['criteria-region'] = [
      { key: 'criteria-region', message: `A contract may hold at most ${MAXIMUM_CRITERIA} acceptance criteria.` },
    ];
  }

  for (const criterion of draft.acceptanceCriteria) {
    const rowProblems: DraftProblem[] = [];
    if (criterion.description.trim() === '') {
      rowProblems.push({ key: 'description', message: 'An acceptance criterion needs a description.' });
    }
    if (criterion.id.trim() === '') {
      rowProblems.push({ key: 'id', message: 'An acceptance criterion needs an id.' });
    } else if (criterion.id.length > MAXIMUM_CRITERION_ID_LENGTH) {
      rowProblems.push({
        key: 'id',
        message: `A criterion id may be at most ${MAXIMUM_CRITERION_ID_LENGTH} characters.`,
      });
    }
    if (rowProblems.length > 0) criteria[criterion.key] = rowProblems;

    const bindingProblems = bindingProblemsOf(criterion);
    if (bindingProblems.length > 0) bindings[criterion.key] = bindingProblems;
  }

  const approvable =
    outcome.length === 0 &&
    scope.length === 0 &&
    outOfScope.length === 0 &&
    Object.keys(criteria).length === 0 &&
    Object.keys(bindings).length === 0;
  if (approvable) return NO_PROBLEMS;
  return { outcome, scope, outOfScope, criteria, bindings, approvable };
}

/** Blank entries in a statement list, which the route refuses, plus the route's entry bound. */
function listProblems(entries: readonly string[], listKey: string): readonly DraftProblem[] {
  const problems: DraftProblem[] = [];
  entries.forEach((entry, index) => {
    if (entry.trim() === '') {
      problems.push({ key: `${listKey}-${index}`, message: 'An empty entry says nothing; remove it instead.' });
    }
  });
  // Reported against the list rather than a row, because the entry that would be refused is
  // the one past the bound and there is no row for it to attach to.
  if (entries.length > MAXIMUM_LIST_ENTRIES) {
    problems.push({
      key: listKey,
      message: `A list may hold at most ${MAXIMUM_LIST_ENTRIES} entries.`,
    });
  }
  return problems;
}

/** The binding rules for one criterion, kept apart so the editor can mark exactly this control. */
function bindingProblemsOf(criterion: DraftCriterion): readonly DraftProblem[] {
  const checkId = criterion.verificationCheckId;
  if (checkId === null) {
    if (criterion.verificationType !== 'automated') return [];
    return [
      {
        key: 'verificationCheckId',
        message:
          'An automated criterion must name the check that verifies it. Nothing is bound here, so it could only ever read unverified.',
      },
    ];
  }
  if (checkId.trim() === '') {
    return [{ key: 'verificationCheckId', message: 'An empty check name binds nothing. Name the check, or leave it unbound.' }];
  }
  if (checkId.length > MAXIMUM_CHECK_NAME_LENGTH) {
    return [{ key: 'verificationCheckId', message: `A check name may be at most ${MAXIMUM_CHECK_NAME_LENGTH} characters.` }];
  }
  if (criterion.verificationType === 'owner_test') {
    return [
      {
        key: 'verificationCheckId',
        message:
          "An owner test is the owner's own step; naming a check for it would let a green check discharge work only the owner can judge.",
      },
    ];
  }
  return [];
}

/**
 * The body a draft save sends.
 *
 * Trimming and blank-dropping happen here rather than being left to the schema, because a
 * rejected save must not cost the owner their text: the body is built from what they can
 * still see on screen. An `owner_test` binding is forced to `null` for the same reason —
 * the type decides the binding, so switching a row from automated to owner test clears a
 * check that no longer applies instead of sending a contradiction the route would refuse.
 *
 * Empty scope entries are dropped rather than sent, since a half-typed line the owner has
 * not finished is not part of the contract — but `draftProblems` still reports them, so
 * they are visible rather than silently discarded.
 */
export function draftContent(draft: ContractDraft): ContractContentInput {
  return {
    outcome: draft.outcome.trim(),
    scope: cleanList(draft.scope),
    outOfScope: cleanList(draft.outOfScope),
    acceptanceCriteria: draft.acceptanceCriteria.map((criterion) => ({
      id: criterion.id.trim(),
      description: criterion.description.trim(),
      verificationType: criterion.verificationType,
      verificationCheckId:
        criterion.verificationType === 'owner_test'
          ? null
          : criterion.verificationCheckId === null || criterion.verificationCheckId.trim() === ''
            ? null
            : criterion.verificationCheckId.trim(),
    })),
  };
}

function cleanList(entries: readonly string[]): readonly string[] {
  return entries.map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/* -------------------------------------------------------------------------- */
/* Choosing a verification method                                              */
/* -------------------------------------------------------------------------- */

/**
 * The checks an automated criterion may bind to, and what to say when there are none.
 *
 * The list is the project's own configured checks, read from its profile. Two facts have to
 * stay apart here and a plain `string[]` would merge them:
 *
 *   - **the project configured none.** The owner can go and configure some, so the editor
 *     must say so and point at the remedy rather than offering an empty dropdown that
 *     looks broken;
 *   - **the configuration could not be read.** Nothing is known, so offering a picker
 *     would present ignorance as a fact about the project.
 *
 * A binding the draft already carries is kept in the list even when the profile no longer
 * names it, and marked. Dropping it would silently unbind a criterion on the next save —
 * which is a material change to an agreement, made without the owner choosing it, and the
 * approval would then refuse for a reason they could not see.
 */
export interface VerificationChoice {
  /** The check name, exactly as it travels in `verificationCheckId`. */
  readonly name: string;
  /** True when the project's current configuration no longer names this check. */
  readonly noLongerConfigured: boolean;
}

export type VerificationChoices =
  | { readonly kind: 'available'; readonly choices: readonly VerificationChoice[] }
  | { readonly kind: 'none-configured' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** The bindings a draft currently carries, which must remain selectable. */
export function boundCheckNames(criteria: readonly DraftCriterion[]): readonly string[] {
  const names: string[] = [];
  for (const criterion of criteria) {
    const name = criterion.verificationCheckId;
    if (name === null || name.trim() === '') continue;
    if (criterion.verificationType !== 'automated') continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Merges the project's configured checks with the bindings the draft already carries.
 *
 * Configured checks come first and in the project's own order, because that is the list the
 * owner configured and scanning it in that order is what they expect. An already-bound but
 * no-longer-configured check is appended rather than dropped, so saving does not silently
 * unbind it — the owner is shown it as out of date and decides.
 */
export function verificationChoices(
  configured: VerificationCheckChoices,
  draft: ContractDraft,
): VerificationChoices {
  if (configured.kind === 'unreadable') return { kind: 'unreadable', reason: configured.reason };
  if (configured.kind === 'none-configured') {
    const retained = boundCheckNames(draft.acceptanceCriteria);
    if (retained.length === 0) return { kind: 'none-configured' };
    return {
      kind: 'available',
      choices: retained.map((name) => ({ name, noLongerConfigured: true })),
    };
  }
  const choices: VerificationChoice[] = configured.checks.map((name) => ({ name, noLongerConfigured: false }));
  for (const name of boundCheckNames(draft.acceptanceCriteria)) {
    if (choices.some((choice) => choice.name === name)) continue;
    choices.push({ name, noLongerConfigured: true });
  }
  return { kind: 'available', choices };
}

/* -------------------------------------------------------------------------- */
/* Reading what the server refused                                             */
/* -------------------------------------------------------------------------- */

/**
 * The criterion ids a refusal named, so the editor can point at those rows.
 *
 * The domain builds the path `acceptanceCriteria.<criterionId>.verificationCheckId` — keyed
 * by **id**, not by index or position — because the id is the stable identity the message
 * means. Reading it by index would attach the message to whichever row happens to be there
 * after a reorder, which is the wrong criterion and the worst possible place for a message
 * about a missing binding.
 *
 * An unparseable path is returned as null rather than guessed at: a message that cannot be
 * attributed to a row is still shown, in the summary, so it is never dropped — it just does
 * not claim to be about a particular criterion.
 */
export function criterionIdsInRefusal(
  paths: readonly string[],
): readonly { readonly criterionId: string; readonly binding: boolean }[] {
  const found: { criterionId: string; binding: boolean }[] = [];
  for (const path of paths) {
    const match = /^acceptanceCriteria\.([^.[\]]+)(\.[^.]+)?$/.exec(path);
    if (match === null) continue;
    const criterionId = match[1];
    if (criterionId === undefined || criterionId === '') continue;
    const suffix = match[2];
    const binding = suffix === '.verificationCheckId' || suffix === undefined;
    if (!found.some((entry) => entry.criterionId === criterionId && entry.binding === binding)) {
      found.push({ criterionId, binding });
    }
  }
  return found;
}

/** The draft row a refused criterion id belongs to, or null when the id is not in the draft. */
export function rowForRefusedCriterion(
  draft: ContractDraft,
  criterionId: string,
): DraftCriterion | null {
  return draft.acceptanceCriteria.find((criterion) => criterion.id === criterionId) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Contract state                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How a revision reads to the owner, in words that do not overclaim.
 *
 * `approvedAt` is nullable on the wire because a revision's history is what a reader needs:
 * an invalidated approval keeps its approver while `status` says it is no longer current.
 * `answersCurrentRequest` is the layer's *report* that an approved revision no longer
 * matches the request it answers — it does not demote it, since whether a request edit
 * invalidates an agreement is the owner's call about scope. It is carried here so the UI can
 * say so rather than rendering an out-of-date agreement as a current one.
 */
export type ContractState =
  | { readonly kind: 'draft' }
  | { readonly kind: 'approved'; readonly approvedAt: string; readonly answersCurrentRequest: boolean }
  | { readonly kind: 'stale'; readonly reason: string }
  | { readonly kind: 'superseded'; readonly byRevision: number };

export function contractState(contract: ContractView): ContractState {
  if (contract.status === 'approved') {
    return {
      kind: 'approved',
      approvedAt: contract.approvedAt ?? '',
      answersCurrentRequest: contract.answersCurrentRequest,
    };
  }
  if (contract.status === 'stale') {
    return {
      kind: 'stale',
      reason: contract.staleReason ?? 'This approval is no longer current.',
    };
  }
  if (contract.supersededByRevision !== null) {
    return { kind: 'superseded', byRevision: contract.supersededByRevision };
  }
  return { kind: 'draft' };
}