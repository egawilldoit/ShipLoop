import { fingerprint } from './fingerprint.ts';
import type { ContractId, Fingerprint, OwnerId, ProjectId, RequestId } from './ids.ts';
import type { DomainError, Result } from './result.ts';
import { err, invalid, ok } from './result.ts';

/**
 * The Delivery Contract: the versioned agreement describing what a successful
 * implementation looks like (mvp-spec 3, MVP "Delivery Contract").
 *
 * This is the single editable source of truth for "done" in this product, and three
 * structural properties are what make it one:
 *
 *   - **An approved revision is frozen.** `editContract` refuses anything but a draft,
 *     so there is no function that can change approved text. A material change is
 *     answered by `reviseContract`, which writes a *new* revision and marks the
 *     previous approval `stale` in the same step. An approved contract therefore
 *     cannot silently mutate, and a candidate bound to revision 3 can never be
 *     described by revision 4's text (mvp-spec 3, ARCHITECTURE "Candidate and
 *     decision rules").
 *   - **Approval is an owner action with a recorded identity.** `approveContract`
 *     takes an `OwnerId` and writes `approvedBy`. The shape a model may emit
 *     (`ContractProposal`) has no status, no approval and no timestamp field, and
 *     `applyContractProposal` refuses an unknown key rather than dropping it, so
 *     structured output cannot assert agreement even by naming it. This is the same
 *     choke point `intake/brief.ts` uses, applied to a stricter rule (MVP, "Never let
 *     agent or model output set approved directly").
 *   - **Staleness has exactly one cause and is never inferred.** A revision becomes
 *     `stale` either because it was superseded by a new revision, or because
 *     `invalidateContract` was called with a named reason. It is never "probably out
 *     of date": a candidate or a check cannot demote an agreement, because demotion
 *     is an owner decision about scope.
 *
 * ## Why this is not a second `Brief`
 *
 * `intake/brief.ts` already models a versioned, append-only clarification document and
 * it is genuinely different, so the two are not merged - but they would have been two
 * editable sources of truth for the same thing, which is the defect this module has to
 * avoid. The distinction that settles it:
 *
 *   - a `Brief` is a *proposal about a problem*, produced by or with a model, holding
 *     assumptions and unresolved questions. It is never approved, only `Proposed` or
 *     `Agreed` in the sense of "the owner agreed this text reads correctly", and it is
 *     append-only: a correction appends a version rather than editing one (F07-AC3).
 *     It may exist with no project and no contract at all.
 *   - a `DeliveryContract` is the *agreement about this request in this project*, is
 *     owned by an owner, and carries the verification type of every criterion. It is
 *     project-scoped and request-scoped, and an approved revision is what a candidate
 *     and its evidence are measured against.
 *
 * A brief may seed a contract draft exactly once, and the revision records which brief
 * version did so (`sourceBriefId`, `sourceBriefVersion`, `sourceFingerprint`). After
 * that the dependency is one-way: editing a contract never writes back to a brief, and
 * re-reading the brief never changes a contract. A brief can therefore never disagree
 * with an approved contract, because the contract does not read it.
 */

/** The lifecycle of one contract revision. */
export const CONTRACT_STATUSES = ['draft', 'approved', 'stale'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/**
 * How a criterion is shown to be satisfied.
 *
 * A closed vocabulary because it decides who may settle it: an `automated` criterion
 * is settled by a check run, and an `owner_test` criterion only by the owner acting in
 * the app. A free-text field here is how "verified" comes to mean "someone read it".
 */
export const VERIFICATION_TYPES = ['automated', 'owner_test'] as const;
export type VerificationType = (typeof VERIFICATION_TYPES)[number];

/** One criterion an implementation must satisfy to count as successful. */
export interface ContractCriterion {
  readonly id: string;
  readonly description: string;
  readonly verificationType: VerificationType;
}

/** The contract's material content, which is what a revision freezes. */
export interface ContractContent {
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly ContractCriterion[];
}

/**
 * One revision of a delivery contract.
 *
 * A discriminated union rather than a status field, because the interesting fact about
 * an approved revision is that it carries an approver. `approvedAt` and `approvedBy`
 * exist only on the variant that has them, so "approved, approved by nobody" is not
 * representable rather than merely discouraged.
 */
export type DeliveryContract =
  | (ContractContent & {
      readonly contractId: ContractId;
      readonly projectId: ProjectId;
      readonly requestId: RequestId;
      readonly revision: number;
      readonly status: 'draft';
      readonly approvedAt: null;
      readonly approvedBy: null;
      readonly staleReason: null;
      readonly supersededByRevision: null;
      readonly sourceBriefId: string | null;
      readonly sourceBriefVersion: number | null;
      /** The content fingerprint, recomputed on every write and compared on every read. */
      readonly contentFingerprint: Fingerprint;
      /** The request text this revision was written against, so a later request edit is detectable. */
      readonly requestFingerprint: Fingerprint;
      readonly createdAt: string;
      readonly updatedAt: string;
    })
  | (ContractContent & {
      readonly contractId: ContractId;
      readonly projectId: ProjectId;
      readonly requestId: RequestId;
      readonly revision: number;
      readonly status: 'approved';
      readonly approvedAt: string;
      readonly approvedBy: OwnerId;
      readonly staleReason: null;
      readonly supersededByRevision: null;
      readonly sourceBriefId: string | null;
      readonly sourceBriefVersion: number | null;
      readonly contentFingerprint: Fingerprint;
      readonly requestFingerprint: Fingerprint;
      readonly createdAt: string;
      readonly updatedAt: string;
    })
  | (ContractContent & {
      readonly contractId: ContractId;
      readonly projectId: ProjectId;
      readonly requestId: RequestId;
      readonly revision: number;
      readonly status: 'stale';
      /** null only when this revision was superseded by a newer one. */
      readonly approvedAt: string | null;
      /** null only when this revision was superseded before it was ever approved. */
      readonly approvedBy: OwnerId | null;
      readonly staleReason: string;
      readonly supersededByRevision: number | null;
      readonly sourceBriefId: string | null;
      readonly sourceBriefVersion: number | null;
      readonly contentFingerprint: Fingerprint;
      readonly requestFingerprint: Fingerprint;
      readonly createdAt: string;
      readonly updatedAt: string;
    });

/** The longest outcome statement a revision may carry. */
export const MAXIMUM_OUTCOME_LENGTH = 2_000;

/** Bounds on the scope lists, so a contract cannot be used to fill storage. */
export const MAXIMUM_SCOPE_ENTRIES = 200;
export const MAXIMUM_SCOPE_ENTRY_LENGTH = 2_000;

/** Bounds on criteria, the part a candidate is actually measured against. */
export const MAXIMUM_CRITERIA = 100;
export const MAXIMUM_CRITERION_DESCRIPTION_LENGTH = 2_000;

/**
 * The fingerprint of a revision's material content.
 *
 * The single authority for "did this change": a draft edit, an approval and a later
 * staleness comparison all read this one function, so "material" cannot mean one thing
 * when writing and another when checking.
 */
export function contractContentFingerprint(content: ContractContent): Fingerprint {
  return fingerprint({
    outcome: content.outcome,
    scope: [...content.scope],
    outOfScope: [...content.outOfScope],
    // Sorted by id: criteria are a set keyed by identity, and a reordering of the same
    // criteria is a display change, not a change to what must be satisfied.
    acceptanceCriteria: [...content.acceptanceCriteria]
      .map((criterion) => ({
        id: criterion.id,
        description: criterion.description,
        verificationType: criterion.verificationType,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  });
}

interface FieldError {
  readonly path: string;
  readonly message: string;
}

function nonBlankEntries(
  entries: readonly string[],
  path: string,
  label: string,
): FieldError[] {
  const errors: FieldError[] = [];
  if (entries.length > MAXIMUM_SCOPE_ENTRIES) {
    errors.push({ path, message: `${label} may hold at most ${MAXIMUM_SCOPE_ENTRIES} entries.` });
    return errors;
  }
  for (const [index, entry] of entries.entries()) {
    if (entry.trim().length === 0) {
      errors.push({ path: `${path}[${index}]`, message: 'An empty entry says nothing; remove it instead.' });
    } else if (entry.trim().length > MAXIMUM_SCOPE_ENTRY_LENGTH) {
      errors.push({
        path: `${path}[${index}]`,
        message: `An entry may be at most ${MAXIMUM_SCOPE_ENTRY_LENGTH} characters.`,
      });
    }
  }
  return errors;
}

function criterionErrors(criteria: readonly ContractCriterion[]): FieldError[] {
  const errors: FieldError[] = [];
  if (criteria.length === 0) {
    errors.push({
      path: 'acceptanceCriteria',
      message: 'A contract needs at least one acceptance criterion; without one, "successful" has no definition.',
    });
    return errors;
  }
  if (criteria.length > MAXIMUM_CRITERIA) {
    errors.push({
      path: 'acceptanceCriteria',
      message: `A contract may hold at most ${MAXIMUM_CRITERIA} acceptance criteria.`,
    });
    return errors;
  }

  const seen = new Set<string>();
  for (const [index, criterion] of criteria.entries()) {
    const path = `acceptanceCriteria[${index}]`;
    if (criterion.id.trim().length === 0) {
      errors.push({ path: `${path}.id`, message: 'An acceptance criterion needs an id.' });
    } else if (seen.has(criterion.id)) {
      errors.push({ path: `${path}.id`, message: `Acceptance criterion id "${criterion.id}" is used twice.` });
    } else {
      seen.add(criterion.id);
    }

    if (criterion.description.trim().length === 0) {
      errors.push({ path: `${path}.description`, message: 'An acceptance criterion needs a description.' });
    } else if (criterion.description.trim().length > MAXIMUM_CRITERION_DESCRIPTION_LENGTH) {
      errors.push({
        path: `${path}.description`,
        message: `A criterion description may be at most ${MAXIMUM_CRITERION_DESCRIPTION_LENGTH} characters.`,
      });
    }

    if (!(VERIFICATION_TYPES as readonly string[]).includes(criterion.verificationType)) {
      errors.push({
        path: `${path}.verificationType`,
        message: `"${criterion.verificationType}" is not a verification type; use ${VERIFICATION_TYPES.join(' or ')}.`,
      });
    }
  }
  return errors;
}

function contentErrors(content: ContractContent): FieldError[] {
  const errors: FieldError[] = [];
  if (content.outcome.trim().length === 0) {
    errors.push({ path: 'outcome', message: 'A contract needs the outcome it promises.' });
  } else if (content.outcome.trim().length > MAXIMUM_OUTCOME_LENGTH) {
    errors.push({
      path: 'outcome',
      message: `An outcome may be at most ${MAXIMUM_OUTCOME_LENGTH} characters.`,
    });
  }
  errors.push(...nonBlankEntries(content.scope, 'scope', 'Scope'));
  errors.push(...nonBlankEntries(content.outOfScope, 'outOfScope', 'Out of scope'));
  errors.push(...criterionErrors(content.acceptanceCriteria));
  return errors;
}

/** Trims every text field once, so a stored revision is never padded. */
function normalizeContent(content: ContractContent): ContractContent {
  return {
    outcome: content.outcome.trim(),
    scope: Object.freeze(content.scope.map((entry) => entry.trim())),
    outOfScope: Object.freeze(content.outOfScope.map((entry) => entry.trim())),
    acceptanceCriteria: Object.freeze(
      content.acceptanceCriteria.map((criterion) =>
        Object.freeze({
          id: criterion.id.trim(),
          description: criterion.description.trim(),
          verificationType: criterion.verificationType,
        }),
      ),
    ),
  };
}

export interface CreateContractInput {
  readonly contractId: ContractId;
  readonly projectId: ProjectId;
  readonly requestId: RequestId;
  /** The revision number this contract takes. Computed by the caller from the prior revisions. */
  readonly revision: number;
  readonly content: ContractContent;
  /** Fingerprint of the request text this revision answers, so a later request edit is detectable. */
  readonly requestFingerprint: Fingerprint;
  readonly sourceBriefId?: string | null;
  readonly sourceBriefVersion?: number | null;
  readonly createdBy: OwnerId;
  readonly at: string;
}

/**
 * Creates a draft revision.
 *
 * Always `draft`: there is no parameter through which a status could arrive, so a
 * caller that has an approved contract's contents cannot construct an approved
 * contract out of them. Revision 1 is created by `reviseContract` or by this function
 * when there is no prior revision; the caller supplies the number so revision numbering
 * stays one rule in one place.
 */
export function createContractDraft(input: CreateContractInput): Result<DeliveryContract, DomainError> {
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    return err<DomainError>(
      invalid('The contract revision could not be created.', [
        { path: 'revision', message: 'A revision number starts at 1.' },
      ]),
    );
  }
  const content = normalizeContent(input.content);
  const errors = contentErrors(content);
  if (errors.length > 0) {
    return err<DomainError>(invalid('The contract revision could not be created.', errors));
  }

  return ok<DeliveryContract>(
    Object.freeze({
      ...content,
      contractId: input.contractId,
      projectId: input.projectId,
      requestId: input.requestId,
      revision: input.revision,
      status: 'draft',
      approvedAt: null,
      approvedBy: null,
      staleReason: null,
      supersededByRevision: null,
      sourceBriefId: input.sourceBriefId ?? null,
      sourceBriefVersion: input.sourceBriefVersion ?? null,
      contentFingerprint: contractContentFingerprint(content),
      requestFingerprint: input.requestFingerprint,
      createdAt: input.at,
      updatedAt: input.at,
    }),
  );
}

/**
 * Edits a draft revision in place.
 *
 * The same revision number is kept: nothing has been agreed yet, so there is no
 * approval to invalidate and no candidate bound to this text. Once approved, this
 * function refuses - the way forward is `reviseContract`, which is what makes "an
 * approved contract never silently mutates" a property of the API rather than a rule
 * callers are trusted to follow.
 */
export function editContract(
  contract: DeliveryContract,
  content: ContractContent,
  options: { readonly expectedUpdatedAt: string; readonly at: string; readonly editedBy: OwnerId },
): Result<DeliveryContract, DomainError> {
  if (contract.status !== 'draft') {
    return err<DomainError>(
      invalid(
        `Revision ${contract.revision} is ${contract.status}, so its text cannot be edited. Draft a new revision instead.`,
        [{ path: 'status', message: contractStatusRefusal(contract) }],
      ),
    );
  }
  if (options.expectedUpdatedAt !== contract.updatedAt) {
    return err<DomainError>({
      code: 'Conflict',
      reason: 'The contract revision changed after it was loaded. Reload it before saving again.',
      expected: options.expectedUpdatedAt,
      actual: contract.updatedAt,
    });
  }

  const normalized = normalizeContent(content);
  const errors = contentErrors(normalized);
  if (errors.length > 0) {
    return err<DomainError>(invalid('The contract revision could not be edited.', errors));
  }
  if (contractContentFingerprint(normalized) === contract.contentFingerprint) {
    return err<DomainError>(
      invalid('The contract revision could not be edited.', [
        { path: 'contract', message: 'Nothing changed; edit the outcome, the scope or a criterion.' },
      ]),
    );
  }

  return ok<DeliveryContract>(
    Object.freeze({
      ...normalized,
      contractId: contract.contractId,
      projectId: contract.projectId,
      requestId: contract.requestId,
      revision: contract.revision,
      status: 'draft',
      approvedAt: null,
      approvedBy: null,
      staleReason: null,
      supersededByRevision: null,
      sourceBriefId: contract.sourceBriefId,
      sourceBriefVersion: contract.sourceBriefVersion,
      contentFingerprint: contractContentFingerprint(normalized),
      requestFingerprint: contract.requestFingerprint,
      createdAt: contract.createdAt,
      updatedAt: options.at,
    }),
  );
}

function contractStatusRefusal(contract: DeliveryContract): string {
  if (contract.status === 'approved') {
    return 'An approved revision is frozen. Approve a new revision instead of editing this one.';
  }
  return `Revision ${contract.revision} is stale and is kept for history. Draft a new revision instead.`;
}

/**
 * Records the owner's approval of a draft revision.
 *
 * The only function in this module that produces an approved revision, and it takes
 * the approver. Approval also re-derives the content fingerprint from the text being
 * approved rather than trusting the draft's stored one, so a fingerprint that drifted
 * from its content cannot be sealed into an agreement.
 */
export function approveContract(
  contract: DeliveryContract,
  input: { readonly approvedBy: OwnerId; readonly at: string },
): Result<DeliveryContract, DomainError> {
  if (contract.status !== 'draft') {
    return err<DomainError>({
      code: 'Conflict',
      reason:
        contract.status === 'approved'
          ? `Revision ${contract.revision} is already approved.`
          : `Revision ${contract.revision} is stale and cannot be approved.`,
      expected: 'draft',
      actual: contract.status,
    });
  }

  const content = normalizeContent(contract);
  return ok<DeliveryContract>(
    Object.freeze({
      ...content,
      contractId: contract.contractId,
      projectId: contract.projectId,
      requestId: contract.requestId,
      revision: contract.revision,
      status: 'approved',
      approvedAt: input.at,
      approvedBy: input.approvedBy,
      staleReason: null,
      supersededByRevision: null,
      sourceBriefId: contract.sourceBriefId,
      sourceBriefVersion: contract.sourceBriefVersion,
      contentFingerprint: contractContentFingerprint(content),
      requestFingerprint: contract.requestFingerprint,
      createdAt: contract.createdAt,
      updatedAt: input.at,
    }),
  );
}

/**
 * Marks an approval no longer current, for a named reason.
 *
 * This is the "invalidate the approval after a material change" step and the reason is
 * required, so a stale revision always says what made it stale. A stale revision keeps
 * its text and its approver: it is history, not a deletion, and a candidate measured
 * against it must still be able to say what it was measured against.
 *
 * Only an approved revision can be invalidated this way. A draft has nothing to
 * invalidate, and a revision that is already stale cannot be given a second, different
 * reason - otherwise the first explanation would be silently replaced.
 */
export function invalidateContract(
  contract: DeliveryContract,
  input: { readonly reason: string; readonly at: string },
): Result<DeliveryContract, DomainError> {
  if (contract.status !== 'approved') {
    return err<DomainError>({
      code: 'Conflict',
      reason:
        contract.status === 'draft'
          ? `Revision ${contract.revision} is a draft; it has no approval to invalidate.`
          : `Revision ${contract.revision} is already stale.`,
      expected: 'approved',
      actual: contract.status,
    });
  }
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return err<DomainError>(
      invalid('The approval could not be invalidated.', [
        { path: 'reason', message: 'Say what made the approval stale.' },
      ]),
    );
  }

  return ok<DeliveryContract>(
    Object.freeze({
      ...contract,
      status: 'stale',
      staleReason: reason,
      updatedAt: input.at,
    }),
  );
}

/**
 * Marks an approved revision superseded, because a newer revision now answers the same
 * request.
 *
 * Kept separate from `invalidateContract` because the two mean different things and a
 * reader must be able to tell them apart: superseded says "there is a newer agreement",
 * invalidated says "this agreement no longer applies, and here is why". Both end in
 * `stale`; only this one records which revision replaced it.
 */
export function supersedeContract(
  contract: DeliveryContract,
  input: { readonly supersededByRevision: number; readonly at: string },
): Result<DeliveryContract, DomainError> {
  if (contract.status !== 'approved') {
    return err<DomainError>({
      code: 'Conflict',
      reason:
        contract.status === 'draft'
          ? `Revision ${contract.revision} is a draft; a draft is replaced by editing it, not by superseding it.`
          : `Revision ${contract.revision} is already stale.`,
      expected: 'approved',
      actual: contract.status,
    });
  }
  if (!Number.isInteger(input.supersededByRevision) || input.supersededByRevision <= contract.revision) {
    return err<DomainError>(
      invalid('The revision could not be superseded.', [
        {
          path: 'supersededByRevision',
          message: `Only a revision after ${contract.revision} can supersede it.`,
        },
      ]),
    );
  }

  return ok<DeliveryContract>(
    Object.freeze({
      ...contract,
      status: 'stale',
      staleReason: `Superseded by revision ${input.supersededByRevision}.`,
      supersededByRevision: input.supersededByRevision,
      updatedAt: input.at,
    }),
  );
}

/**
 * Starts the next revision from the current one, superseding the approval it replaces.
 *
 * One step rather than two, because the interesting failure is a new revision that
 * exists while the old approval still reads as current: a candidate measured against
 * revision 3 would then be described by revision 4's text. Both writes belong in one
 * transaction, and this function returns both halves so the caller has no gap to leave.
 */
export function reviseContract(
  current: DeliveryContract,
  input: {
    readonly contractId: ContractId;
    readonly content: ContractContent;
    readonly requestFingerprint: Fingerprint;
    readonly revisedBy: OwnerId;
    readonly at: string;
  },
): Result<{ readonly superseded: DeliveryContract | null; readonly draft: DeliveryContract }, DomainError> {
  const nextRevision = current.revision + 1;
  const draft = createContractDraft({
    contractId: input.contractId,
    projectId: current.projectId,
    requestId: current.requestId,
    revision: nextRevision,
    content: input.content,
    requestFingerprint: input.requestFingerprint,
    // The provenance of the prior revision is carried forward deliberately: a chain of
    // revisions descends from the same brief, and dropping it would make revision 4 look
    // like it was written without one.
    sourceBriefId: current.sourceBriefId,
    sourceBriefVersion: current.sourceBriefVersion,
    createdBy: input.revisedBy,
    at: input.at,
  });
  if (!draft.ok) return err(draft.error);

  if (current.status !== 'approved') {
    return ok({ superseded: null, draft: draft.value });
  }

  const superseded = supersedeContract(current, { supersededByRevision: nextRevision, at: input.at });
  if (!superseded.ok) return err(superseded.error);
  return ok({ superseded: superseded.value, draft: draft.value });
}

/** The next revision number for a request whose latest revision is `latest`. */
export function nextRevisionNumber(latest: DeliveryContract | null): number {
  return latest === null ? 1 : latest.revision + 1;
}

/**
 * Whether an approval still answers the request as it now reads.
 *
 * The recorded request fingerprint is compared against the current one, so a request
 * edit is reported here instead of silently leaving an approved contract describing a
 * request that no longer says that. This is a *report*, not a transition: the caller
 * decides whether the difference is material and then invalidates the approval with a
 * reason, because that judgement is an owner's call about scope.
 */
export function contractAnswersRequest(contract: DeliveryContract, currentRequestFingerprint: Fingerprint): boolean {
  return contract.requestFingerprint === currentRequestFingerprint;
}

/**
 * The structured shape a model may emit to propose a contract.
 *
 * It has no `status`, no `approvedAt`, no `approvedBy` and no `revision`, so there is
 * no key through which structured output could assert that an agreement exists. The
 * owner identity and the revision number are supplied by the caller that applies it,
 * from the authenticated session and from the stored revision history.
 */
export interface ContractProposal {
  readonly kind: 'ContractProposal';
  readonly requestId: RequestId;
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly ContractCriterion[];
}

const CONTRACT_PROPOSAL_FIELDS: readonly string[] = Object.freeze([
  'kind',
  'requestId',
  'outcome',
  'scope',
  'outOfScope',
  'acceptanceCriteria',
]);

/**
 * Validates a structured proposal before it can reach a contract revision.
 *
 * The single entry point for anything a model produced, and it mirrors
 * `applyProposal` in `intake/brief.ts` for the same reason: an unknown top-level field
 * is refused rather than dropped, because a proposal that tried to carry `status` or
 * `approvedAt` is a fact the caller needs to see, not noise to discard.
 */
export function applyContractProposal(
  proposal: ContractProposal,
): Result<ContractContent, DomainError> {
  if (proposal === null || typeof proposal !== 'object' || proposal.kind !== 'ContractProposal') {
    return err<DomainError>(
      invalid('The structured output is not a contract proposal.', [
        { path: 'kind', message: 'A contract proposal must be tagged as a ContractProposal.' },
      ]),
    );
  }

  const errors: FieldError[] = [];
  for (const field of Object.keys(proposal)) {
    if (!CONTRACT_PROPOSAL_FIELDS.includes(field)) {
      errors.push({
        path: field,
        message: `A contract proposal has no field "${field}"; status and approval are owner decisions, not proposals.`,
      });
    }
  }
  if (!Array.isArray(proposal.scope) || !Array.isArray(proposal.outOfScope)) {
    errors.push({ path: 'scope', message: 'Scope and out-of-scope are lists of statements.' });
  }
  if (!Array.isArray(proposal.acceptanceCriteria)) {
    errors.push({ path: 'acceptanceCriteria', message: 'Acceptance criteria must be a list.' });
  }
  if (typeof proposal.outcome !== 'string') {
    errors.push({ path: 'outcome', message: 'The outcome must be text.' });
  }
  for (const [index, criterion] of (proposal.acceptanceCriteria ?? []).entries()) {
    if (
      typeof criterion?.id !== 'string' ||
      typeof criterion?.description !== 'string' ||
      typeof criterion?.verificationType !== 'string'
    ) {
      errors.push({
        path: `acceptanceCriteria[${index}]`,
        message: 'A criterion must carry string id, description and verificationType fields.',
      });
    }
  }
  if (errors.length > 0) {
    return err<DomainError>(invalid('The proposed contract is not a valid contract.', errors));
  }

  const content = normalizeContent(proposal);
  const contentFailures = contentErrors(content);
  if (contentFailures.length > 0) {
    return err<DomainError>(invalid('The proposed contract is not a valid contract.', contentFailures));
  }
  return ok(content);
}

/**
 * The rules a contract revision must satisfy before any candidate may be measured
 * against it.
 *
 * A pure function over a stored revision so every caller asks the same question. A
 * candidate for a stale revision is refused here rather than at each consumer, because
 * "was it approved?" asked three times in three files is three chances to ask it
 * differently.
 */
export function contractGate(
  contract: DeliveryContract,
): { readonly satisfied: boolean; readonly reason: string } {
  if (contract.status !== 'approved') {
    return {
      satisfied: false,
      reason: `Contract revision ${contract.revision} is ${contract.status}; only an approved revision may be measured against.`,
    };
  }
  return { satisfied: true, reason: `Contract revision ${contract.revision} was approved by its owner.` };
}