/**
 * The Delivery Contract's editable shape, and the rules about when it may be approved.
 *
 * A Delivery Contract is the versioned agreement describing successful implementation, so this
 * file exists to keep three properties that a form cannot enforce by itself:
 *
 *   - **An approved contract never silently mutates.** Saving changed content against a revision
 *     that has been approved produces a *new* revision, and the old approval is left describing the
 *     old text. `saveIntent` is the function that decides which of those two things a save is, and
 *     it is here rather than in the page so the rule is testable without a browser.
 *   - **Approval is never inferred.** `approvalRefusals` returns the reasons an approval would be
 *     refused, and the page renders them rather than disabling a button and hoping the owner
 *     infers why. Nothing in this file decides that a contract *is* approved; only the server does.
 *   - **Every criterion says how it will be verified.** A criterion with no verification method
 *     cannot be judged later, which is exactly the state the product forbids being presented as
 *     verified.
 */

import type { ContractStatus, DeliveryContract, VerificationType } from './wire.ts';

export const VERIFICATION_TYPES: readonly { readonly id: VerificationType; readonly label: string; readonly meaning: string }[] = [
  {
    id: 'automated',
    label: 'Automated',
    meaning: 'A check runs and records the result against the exact commit.',
  },
  {
    id: 'owner_test',
    label: 'I will test this myself',
    meaning: 'You perform the step and record what you observed. ShipLoop never decides it for you.',
  },
];

export interface CriterionDraft {
  /** The server's criterion id, or null for a criterion this owner has just written. */
  readonly id: string | null;
  readonly description: string;
  readonly verificationType: VerificationType;
}

export interface ContractDraft {
  readonly outcome: string;
  readonly scope: string;
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly CriterionDraft[];
}

/** One reason a draft is not acceptable, carrying the form path its message belongs beside. */
export interface DraftProblem {
  readonly path: string;
  readonly message: string;
}

export function emptyDraft(): ContractDraft {
  return { outcome: '', scope: '', outOfScope: [], acceptanceCriteria: [] };
}

/** A blank criterion row, in the state a newly added one starts in. */
export function blankCriterion(): CriterionDraft {
  return { id: null, description: '', verificationType: 'automated' };
}

/**
 * Reads an existing contract into the form's shape.
 *
 * `verificationType` falls back to `owner_test` for a criterion the server sent with no usable
 * method, and says so on the page. Defaulting to `automated` would claim a check exists for a
 * criterion that has none, which is the one reading this product must never produce.
 */
export function draftFromContract(contract: DeliveryContract): ContractDraft {
  return {
    outcome: contract.outcome,
    scope: contract.scope,
    outOfScope: [...contract.outOfScope],
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      verificationType: criterion.verificationType,
    })),
  };
}

/** Whether the form is dirty, compared on content rather than on identity. */
export function isDraftDirty(left: ContractDraft, right: ContractDraft): boolean {
  return JSON.stringify(normalise(left)) !== JSON.stringify(normalise(right));
}

/** The comparable shape of a draft: content only, with blank rows dropped. */
interface ComparableDraft {
  readonly outcome: string;
  readonly scope: string;
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly {
    readonly description: string;
    readonly verificationType: VerificationType;
  }[];
}

/** Trims and drops blank rows so a stray empty input cannot look like a saved change. */
function normalise(draft: ContractDraft): ComparableDraft {
  return {
    outcome: draft.outcome.trim(),
    scope: draft.scope.trim(),
    outOfScope: draft.outOfScope.map((entry) => entry.trim()).filter((entry) => entry !== ''),
    acceptanceCriteria: draft.acceptanceCriteria
      .filter((criterion) => criterion.description.trim() !== '')
      .map((criterion) => ({ description: criterion.description.trim(), verificationType: criterion.verificationType })),
  };
}

/**
 * Everything that stops a draft being saved or approved, as field-addressed messages.
 *
 * An empty `out of scope` list is allowed. A contract that forbids nothing is a real position,
 * and inventing a required "none" row would put a sentence in the agreement that the owner never
 * wrote.
 */
export function validateContractDraft(draft: ContractDraft): readonly DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (draft.outcome.trim() === '') {
    problems.push({
      path: 'outcome',
      message: 'An outcome is required: one sentence saying what is true when this work is done.',
    });
  }
  if (draft.scope.trim() === '') {
    problems.push({ path: 'scope', message: 'Some scope is required, so the work has an edge.' });
  }
  draft.outOfScope.forEach((entry, index) => {
    if (entry.trim() === '') {
      problems.push({ path: `outOfScope.${String(index)}`, message: 'Remove this empty row or say what is excluded.' });
    }
  });
  const criteria = draft.acceptanceCriteria.filter((criterion) => criterion.description.trim() !== '');
  if (criteria.length === 0) {
    problems.push({
      path: 'acceptanceCriteria',
      message: 'At least one acceptance criterion is required. A contract with no criterion cannot be judged.',
    });
  }
  draft.acceptanceCriteria.forEach((criterion, index) => {
    if (criterion.description.trim() !== '' && !VERIFICATION_TYPES.some((type) => type.id === criterion.verificationType)) {
      problems.push({
        path: `acceptanceCriteria.${String(index)}.verificationType`,
        message: 'Say how this criterion is verified.',
      });
    }
  });
  return problems;
}

/** Field messages grouped by path, so each lands beside the input it belongs to. */
export function draftProblemsByPath(problems: readonly DraftProblem[]): Readonly<Record<string, string>> {
  const grouped: Record<string, string> = {};
  for (const problem of problems) {
    if (grouped[problem.path] === undefined) grouped[problem.path] = problem.message;
  }
  return grouped;
}

export interface SaveIntent {
  /**
   * True when this save must become a new revision.
   *
   * Set when the revision being edited has been approved and the content differs, because the
   * approval was given for text that is about to change. The page turns this into a confirmation
   * the owner can read, and the server is what actually increments the revision.
   */
  readonly createsNewRevision: boolean;
  readonly explanation: string;
}

/**
 * What saving this draft means for the revision number.
 *
 * Three cases, and the distinction between them is the whole point of the function:
 *
 *   - Unchanged content: nothing happens. Approving revision 3 and pressing Save on the text as
 *     it already stands must not produce revision 4 and invalidate an approval for no reason.
 *   - A revision that was never approved (draft, or stale so its approval no longer holds):
 *     edited in place, keeping its revision number. Nothing approved is being rewritten.
 *   - A revision that was approved and is being changed: a new revision, and the old approval
 *     stops describing the work.
 */
export function saveIntent(draft: ContractDraft, saved: ContractDraft, status: ContractStatus): SaveIntent {
  if (!isDraftDirty(draft, saved)) {
    return { createsNewRevision: false, explanation: 'Nothing has changed, so the revision number stays as it is.' };
  }
  if (status === 'approved') {
    return {
      createsNewRevision: true,
      explanation:
        'This revision was approved, so changing it records a new revision. The approval you gave stands against the text as it was.',
    };
  }
  return {
    createsNewRevision: false,
    explanation:
      status === 'stale'
        ? 'This revision is stale and holds no approval, so it is edited in place and its number does not change.'
        : 'This revision is a draft and holds no approval, so it is edited in place.',
  };
}

/**
 * The reasons approval would be refused right now, in the order the owner should read them.
 *
 * An already-approved revision is refused because there is nothing to approve: the page hides the
 * control in that state, and this list is what makes the hidden control explainable rather than
 * mysterious.
 */
export function approvalRefusals(
  draft: ContractDraft,
  status: ContractStatus,
  problems: readonly DraftProblem[] = validateContractDraft(draft),
): readonly string[] {
  if (status === 'approved') return ['This revision is already approved.'];
  return problems.map((problem) => problem.message);
}

/** Whether the owner-test count is worth naming, because it changes what the owner must do later. */
export function ownerTestCount(draft: ContractDraft): number {
  return draft.acceptanceCriteria.filter(
    (criterion) => criterion.description.trim() !== '' && criterion.verificationType === 'owner_test',
  ).length;
}

/** The body a save submits. Criterion ids are carried so the server can match existing rows. */
export function saveBody(draft: ContractDraft): {
  readonly outcome: string;
  readonly scope: string;
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly { readonly id: string | null; readonly description: string; readonly verificationType: VerificationType }[];
} {
  return {
    outcome: draft.outcome.trim(),
    scope: draft.scope.trim(),
    outOfScope: draft.outOfScope.map((entry) => entry.trim()).filter((entry) => entry !== ''),
    acceptanceCriteria: draft.acceptanceCriteria
      .filter((criterion) => criterion.description.trim() !== '')
      .map((criterion) => ({
        id: criterion.id,
        description: criterion.description.trim(),
        verificationType: criterion.verificationType,
      })),
  };
}

/** What the one-line read of a criterion reads as in a list. */
export function criterionLabel(criterion: CriterionDraft): string {
  const text = criterion.description.trim();
  if (text === '') return 'Unwritten criterion';
  return criterion.verificationType === 'owner_test' ? `${text} — you test this` : text;
}