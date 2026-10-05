/**
 * Delivery Contract: the edit-or-draft decision, the compare-and-set that guards it, and the words a
 * conflict is reported with.
 *
 * ## Why this module is separate from the screen
 *
 * `ContractScreen.tsx` owns markup and component state. This owns three things that must be true
 * regardless of how they are rendered, and each of them is the kind of rule that is invisible in a
 * component and catastrophic when wrong:
 *
 *   1. **Every save and every approval names the text the screen was rendered from.** The
 *      fingerprint is not passed in by the caller — it is read off the `ContractRead` this module
 *      produced, so a save cannot be bound to a fingerprint from a different render. Two tabs on one
 *      draft both address `contracts/:id/1`, and only this compare-and-set separates "I am saving what
 *      I read" from "I am overwriting what somebody else wrote" (mvp-spec 3, mvp-spec 7, F24-AC4).
 *   2. **A `Conflict` is never a save.** It has its own outcome, it carries what the submission named
 *      and what the server holds now, and it returns the owner's typed draft unchanged so the screen
 *      has nothing to reconstruct.
 *   3. **An edit, a draft, a revise and an approval are four different calls** chosen by the revision
 *      the server reported, not by a button the screen invented. A revision the server calls
 *      `approved` answers 400 to `PATCH`; the route forward is `/revise`, and the screen offers that
 *      instead (mvp-spec 3).
 *
 * ## Nothing here decides whether a contract may be agreed
 *
 * Whether a revision is approvable — an automated criterion naming no check, a request that has moved
 * past the approval — is the server's answer, read and reflected. `contract-draft.ts` holds the same
 * rules as pure data so the owner is not told a contract is fine and then refused, and this module
 * uses those helpers rather than restating them; but the *refusal* is still the server's, and its
 * per-criterion field paths are what the screen marks (F23-AC1, F24-AC3).
 *
 * ## Check names are the project's, not typed in
 *
 * `readVerificationCheckNames` is the only readable source of a project's configured check names, and
 * those names are exactly what `verificationCheckId` must carry — they are the identity a verdict is
 * filed against, so the same binding survives every re-run. A project with no saved profile is a
 * *state*, not a failure, and it is reported as one: the choices are unavailable because the project
 * has no profile, never because nothing was chosen (F23-AC1, F02-AC4).
 */

import {
  blankCriterion,
  draftContent,
  draftFromContract,
  draftFromRequest,
  draftProblems,
  nextCriterionId,
  verificationChoices,
  type ContractDraft,
  type DraftCriterion,
  type DraftProblems,
  type VerificationChoices,
} from '../contract-draft.ts';
import {
  approveContract,
  draftContract,
  editContract,
  getRequest,
  readVerificationCheckNames,
  reviseContract,
  type ContractContentInput,
  type ContractView,
  type MvpFailure,
  type MvpResult,
  type ProjectScope,
  type RequestDetailView,
  type VerificationCheckNames,
} from '../mvp-client/index.ts';

/* -------------------------------------------------------------------------- */
/* The read                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Which revision the screen is looking at, and what the server says about it.
 *
 * `origin` is read off `latestRevision.status` rather than derived from anything the screen decided,
 * because "one current approvable draft" is the server's property and a client that chose its own
 * subject could approve a revision the request has already moved past (mvp-spec 3).
 */
export type ContractOrigin = 'no-contract' | 'draft' | 'agreed' | 'stale';

/** What one read of a request's contract produced, and everything a save may be bound to. */
export interface ContractRead {
  readonly detail: RequestDetailView;
  readonly origin: ContractOrigin;
  /** The revision being worked on, or null when this request has no revision at all. */
  readonly revisionInView: ContractView | null;
  /** The text the screen starts from: the revision's, or the request's description when there is none. */
  readonly draft: ContractDraft;
  /** Exactly what the shared check picker renders, plus the server's sentence when there is no profile. */
  readonly checks: CheckAvailability;
}

/**
 * The check names an automated criterion may bind to, and why there may be none.
 *
 * `choices` is the union the picker renders, computed by `contract-draft.ts` so this screen and the
 * legacy one agree. `noProfileReason` is kept beside it because "the project configured no checks"
 * and "the project has no saved profile" have different remedies, and a picker that only knew
 * "nothing configured" would send the owner to the wrong place (F02-AC4).
 */
export interface CheckAvailability {
  readonly choices: VerificationChoices;
  readonly noProfileReason: string | null;
}

/** A read outcome, as the two things a reader has to be able to tell apart (N03-AC1). */
export type ContractReadOutcome =
  | { readonly kind: 'ready'; readonly read: ContractRead }
  | { readonly kind: 'refused'; readonly failure: MvpFailure };

/**
 * Reads the request's contract state and the project's check names together.
 *
 * Two reads rather than one because they are two facts about two different things, and the contract
 * is still readable when the profile is not: a `no-profile` answer degrades the picker, it does not
 * blank the contract. That is why the second read's failure is folded into `choices` rather than
 * failing the whole read (F02-AC4).
 */
export async function readContractForEditing(
  scope: ProjectScope,
  requestId: string,
): Promise<ContractReadOutcome> {
  const [detail, names] = await Promise.all([getRequest(scope, requestId), readVerificationCheckNames(scope)]);
  if (!detail.ok) return { kind: 'refused', failure: detail.failure };

  const latest = detail.value.latestRevision;
  const origin: ContractOrigin =
    latest === null ? 'no-contract' : latest.status === 'draft' ? 'draft' : latest.status === 'approved' ? 'agreed' : 'stale';

  return {
    kind: 'ready',
    read: {
      detail: detail.value,
      origin,
      revisionInView: latest,
      // A revision the server already holds is the text the owner starts from, criterion identities
      // included; a request with none starts from the words the owner already wrote, so the outcome
      // is not retyped (F06-AC1).
      draft: latest === null ? draftFromRequest(detail.value.request) : draftFromContract(latest),
      checks: readCheckAvailability(names, latest === null ? detail.value.request : latest),
    },
  };
}

function readCheckAvailability(
  names: MvpResult<VerificationCheckNames>,
  seed: { readonly title: string; readonly description: string } | ContractView,
): CheckAvailability {
  if (!names.ok) {
    // The configuration could not be read, so nothing is known and no check is offered. Presenting
    // ignorance as a fact about the project is the failure this member exists to prevent (F02-AC4).
    return { choices: { kind: 'unreadable', reason: names.failure.reason }, noProfileReason: null };
  }
  if (names.value.kind === 'no-profile') {
    return { choices: { kind: 'none-configured' }, noProfileReason: names.value.reason };
  }
  const draft = isContractView(seed) ? draftFromContract(seed) : draftFromRequest(seed);
  return {
    choices: verificationChoices({ kind: 'configured', checks: names.value.names }, draft),
    noProfileReason: null,
  };
}

function isContractView(value: { readonly title: string } | ContractView): value is ContractView {
  return 'contractId' in value;
}

/* -------------------------------------------------------------------------- */
/* Saving                                                                       */
/* -------------------------------------------------------------------------- */

/** What one save attempt did. Three outcomes, and the middle one is the point of this module. */
export type ContractSaveOutcome =
  | { readonly kind: 'saved'; readonly contract: ContractView }
  | {
      readonly kind: 'contract-changed';
      /** What the submission named — the fingerprint of the read this save was made against. */
      readonly expected: string | null;
      /** What the server holds now, when it said. */
      readonly actual: string | null;
      readonly reason: string;
      /** The owner's typed draft, handed back untouched so the screen keeps it. */
      readonly draft: ContractDraft;
    }
  | { readonly kind: 'refused'; readonly failure: MvpFailure };

/**
 * A refusal raised here rather than by the server, with **no request sent**.
 *
 * Carries the same shape as every other refusal so a screen has one thing to render, and `status: 0`
 * because no request completed — "this cannot be done here" is not a server error, and a page that
 * reported it as one would send the owner looking for a fault that is not there (F02-AC4, N03-AC3).
 */
function localRefusal(reason: string): MvpFailure {
  return {
    code: 'Invalid',
    reason,
    status: 0,
    fields: [],
    prerequisites: [],
    expected: null,
    actual: null,
  };
}

/**
 * Saves the draft, as a first revision or as an edit — whichever the read says this is.
 *
 * The fingerprint sent is `read.revisionInView.contentFingerprint`, the value of the read that
 * rendered this screen. It is not taken from a prop, a ref or the form, because every other source
 * can be a value from a render that is no longer on screen, and a stale fingerprint sent as if fresh
 * is the one failure this endpoint exists to catch (mvp-spec 7, F24-AC4).
 *
 * A `Conflict` returns the draft it was given, not a re-derived one, so nothing the owner typed is
 * lost to a refusal they can do nothing about until they reload.
 */
export async function saveContractDraft(
  scope: ProjectScope,
  read: ContractRead,
  draft: ContractDraft,
): Promise<ContractSaveOutcome> {
  const content = draftContent(draft);
  const revision = read.revisionInView;

  if (revision === null) {
    const created = await draftContract(scope, read.detail.request.requestId, content);
    return created.ok ? { kind: 'saved', contract: created.value } : readSaveRefusal(created, draft);
  }

  if (revision.status !== 'draft') {
    // An approved revision answers 400 to `PATCH`, and a stale one is history. Offering `revise` is
    // the route forward; a save against either would be a refusal the screen could have predicted.
    return { kind: 'refused', failure: readLocalFailure(revision) };
  }

  const edited = await editContract(scope, revision.contractId, revision.revision, {
    ...content,
    expectedContentFingerprint: revision.contentFingerprint,
  });
  return edited.ok ? { kind: 'saved', contract: edited.value } : readSaveRefusal(edited, draft);
}

/** Reads the refusal off a `MvpResult` without losing the typed draft. */
function readSaveRefusal(
  result: MvpResult<ContractView>,
  draft: ContractDraft,
): Exclude<ContractSaveOutcome, { readonly kind: 'saved' }> {
  if (result.ok) throw new Error('A successful save must not be read as a refusal.');
  if (result.failure.code === 'Conflict') {
    return {
      kind: 'contract-changed',
      expected: result.failure.expected,
      actual: result.failure.actual,
      reason: result.failure.reason,
      draft,
    };
  }
  return { kind: 'refused', failure: result.failure };
}

/**
 * Builds the refusal for an edit against a revision that is not a draft.
 *
 * Written out rather than assembled from `localRefusal` inside a conditional expression, because a
 * save that is refused locally must send **no request at all** — the difference between "this cannot
 * be edited here" and "the server declined" is one a reader acts on differently.
 */
function readLocalFailure(revision: ContractView): MvpFailure {
  return localRefusal(
    `Revision ${revision.revision} is ${revision.status}, so its text is not edited in place. Start the next ` +
      'revision instead — that is the only way an agreed contract moves forward (mvp-spec 3).',
  );
}

/**
 * Starts the next revision from the text on screen.
 *
 * `/revise` creates the new revision and retires the approval it replaces in one controller step, so
 * there is never a moment with a new revision beside a still-current approval — and no client can
 * separate the two writes and produce one (mvp-spec 3).
 *
 * This call carries no fingerprint: the route's body is the contract content alone, because the new
 * revision is created *from* what the owner is looking at rather than replacing text in place. A
 * `Conflict` is still reported as a conflict, because a refusal is never a revision.
 */
export async function reviseContractText(
  scope: ProjectScope,
  read: ContractRead,
  draft: ContractDraft,
): Promise<ContractSaveOutcome> {
  const revision = read.revisionInView;
  if (revision === null) {
    return {
      kind: 'refused',
      failure: readLocalFailureMissingRevision(),
    };
  }
  const revised = await reviseContract(scope, revision.contractId, revision.revision, draftContent(draft));
  return revised.ok ? { kind: 'saved', contract: revised.value } : readSaveRefusal(revised, draft);
}

function readLocalFailureMissingRevision(): MvpFailure {
  return localRefusal('This request has no revision to revise. Save a first revision instead.');
}

/* -------------------------------------------------------------------------- */
/* Approving                                                                    */
/* -------------------------------------------------------------------------- */

/** What one approval attempt did. Only a 200 is an approval. */
export type ContractApprovalOutcome =
  | { readonly kind: 'approved'; readonly contract: ContractView }
  | {
      readonly kind: 'contract-changed';
      readonly expected: string | null;
      readonly actual: string | null;
      readonly reason: string;
    }
  | { readonly kind: 'refused'; readonly failure: MvpFailure };

/**
 * Approves the revision this screen was rendered from.
 *
 * The fingerprint is `read.revisionInView.contentFingerprint`, read from the same render as the text
 * on screen, and it is required. An approval without it names a revision but not a state: two tabs
 * on one draft both address `contracts/:id/1`, and the call would seal whatever the other tab wrote
 * since — with nothing afterwards able to detect it, because a frozen revision reports itself as
 * approved (mvp-spec 3, mvp-spec 7, F24-AC4).
 *
 * A revision the server does not call a `draft` is refused **locally**, with no request sent: "already
 * approved" is a more useful answer than "your fingerprint is stale", and it stays true however the
 * caller got here.
 */
export async function approveContractText(
  scope: ProjectScope,
  read: ContractRead,
): Promise<ContractApprovalOutcome> {
  const revision = read.revisionInView;
  if (revision === null) {
    return { kind: 'refused', failure: readLocalFailureMissingRevision() };
  }
  if (revision.status !== 'draft') {
    return { kind: 'refused', failure: readLocalFailure(revision) };
  }

  const outcome = await approveContract(scope, revision.contractId, revision.revision, revision.contentFingerprint);
  if (outcome.kind === 'approved') return outcome;
  if (outcome.kind === 'contract-changed') {
    return {
      kind: 'contract-changed',
      expected: outcome.expected ?? revision.contentFingerprint,
      actual: outcome.actual,
      reason: outcome.reason,
    };
  }
  return outcome;
}

/* -------------------------------------------------------------------------- */
/* Unsaved text                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Whether the text on screen differs from the text the read returned.
 *
 * This is a statement about this form, not about the product: it is not an eligibility judgement and
 * it never decides whether an approval may happen. It exists so the screen can say "save your changes
 * first" instead of letting an owner approve text that was never saved — an approval seals what is
 * stored, so approving with unsaved edits would seal something other than what was on screen
 * (mvp-spec 3).
 */
export function hasUnsavedChanges(read: ContractRead, draft: ContractDraft): boolean {
  // With no revision there is nothing saved, so everything on screen is unsaved. That is true rather
  // than pedantic: it is why the approve control only appears once a revision exists.
  const saved: ContractContentInput | null =
    read.revisionInView === null ? null : draftContent(draftFromContract(read.revisionInView));
  return saved === null || stableContent(draftContent(draft)) !== stableContent(saved);
}

function stableContent(content: ContractContentInput): string {
  return JSON.stringify([
    content.outcome,
    content.scope,
    content.outOfScope,
    content.acceptanceCriteria.map((criterion) => [
      criterion.id,
      criterion.description,
      criterion.verificationType,
      criterion.verificationCheckId,
    ]),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Adding a criterion                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Appends a criterion with an id no sibling holds.
 *
 * Ids are generated rather than typed because the owner should not have to invent an identifier to
 * say what must be true, and because the approval refusal names a criterion **by id** — two criteria
 * sharing one would make that message ambiguous and could file a verdict against the wrong row
 * (F02-AC4, F23-AC1).
 */
export function withNewCriterion(draft: ContractDraft): ContractDraft {
  const used = draft.acceptanceCriteria.map((criterion) => criterion.id);
  const key = `criterion-${used.length + 1}-${nextCriterionId(used)}`;
  return { ...draft, acceptanceCriteria: [...draft.acceptanceCriteria, blankCriterion(used, key)] };
}

/** Replaces one criterion, leaving every other row and its identity untouched. */
export function withCriterion(draft: ContractDraft, next: DraftCriterion): ContractDraft {
  return {
    ...draft,
    acceptanceCriteria: draft.acceptanceCriteria.map((criterion) => (criterion.key === next.key ? next : criterion)),
  };
}

/** Removes one criterion. The last one stays: the route refuses a contract with no criteria. */
export function withoutCriterion(draft: ContractDraft, key: string): ContractDraft {
  return { ...draft, acceptanceCriteria: draft.acceptanceCriteria.filter((criterion) => criterion.key !== key) };
}

/** Replaces one entry of a statement list, keeping every other entry. */
export function withStatement(
  draft: ContractDraft,
  list: 'scope' | 'outOfScope',
  index: number,
  value: string,
): ContractDraft {
  return {
    ...draft,
    [list]: draft[list].map((entry, position) => (position === index ? value : entry)),
  };
}

/**
 * Appends an empty line to a statement list.
 *
 * The empty line is inserted immediately rather than at the end, because an owner who pressed "add"
 * while a field was focused is looking at that field — and an empty entry is refused by the route, so
 * leaving it somewhere they are not looking would produce a save failure they could not see the cause
 * of. `draftProblems` still reports it until it is filled in or removed (F02-AC4).
 */
export function withAddedStatement(draft: ContractDraft, list: 'scope' | 'outOfScope'): ContractDraft {
  return { ...draft, [list]: [...draft[list], ''] };
}

/** Removes one entry of a statement list. */
export function withoutStatement(draft: ContractDraft, list: 'scope' | 'outOfScope', index: number): ContractDraft {
  return { ...draft, [list]: draft[list].filter((_entry, position) => position !== index) };
}

/** The validation the owner sees while typing — the same rules the server refuses with. */
export function problemsOf(draft: ContractDraft): DraftProblems {
  return draftProblems(draft);
}

/* -------------------------------------------------------------------------- */
/* What the owner is told                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What a `Conflict` is reported as: never a save, both fingerprints named, an explicit reload asked
 * for.
 *
 * `expected` and `actual` are the server's own two values, and they are not always the same kind of
 * thing — a fingerprint mismatch names two fingerprints, while "this is not the newest revision" names
 * two revision numbers. So both are printed under a label that stays true either way rather than
 * being labelled "fingerprint" and printing a revision number under it (mvp-spec 7).
 *
 * `requiresReload` is a literal: the screen must not offer a retry against the same fingerprint,
 * because the fingerprint the owner holds is precisely what has stopped describing the text.
 */
export function conflictReport(input: {
  readonly expected: string | null;
  readonly actual: string | null;
  readonly reason: string;
  readonly didSave: boolean;
}): {
  readonly heading: string;
  readonly lines: readonly string[];
  readonly requiresReload: true;
} {
  return {
    heading: 'The contract changed while you were working on it',
    lines: [
      input.didSave
        ? 'Nothing was saved. What you typed is still on screen and has not been overwritten.'
        : 'Nothing was approved, and the text on screen is exactly what you last read from the server.',
      `Your submission named: ${input.expected ?? 'nothing the server could name'}.`,
      `The server holds now: ${input.actual ?? 'text it did not name'}.`,
      input.reason,
      'Read the contract again and compare it with what is on screen before saving or approving. Retrying now ' +
        'would submit the same stale reference and be refused again.',
    ],
    requiresReload: true,
  };
}

/**
 * The criteria an approval refusal named, and where it landed.
 *
 * An unbound automated criterion is refused by **path** — `acceptanceCriteria.<id>.verificationCheckId`
 * — so the message goes to the row whose id is in the path. This is the server's answer rendered, not a
 * re-derivation of which criteria are unbound (F23-AC1, F24-AC3).
 */
export function refusedCriterionIds(failure: MvpFailure): readonly string[] {
  return [...new Set(failure.fields.map((field) => field.path))].flatMap((path) => {
    const match = /^acceptanceCriteria\.([^.[\]]+)\.verificationCheckId$/.exec(path);
    return match === null || match[1] === undefined ? [] : [match[1]];
  });
}
