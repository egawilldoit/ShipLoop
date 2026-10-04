/**
 * Request and Delivery Contract use cases (mvp-spec 3, MVP "Request" and "Delivery
 * Contract").
 *
 * The layer owns three things the domain and the store each deliberately do not:
 *
 *   - **Authorization.** Every use case demands an attributable owner before it reads a
 *     project-scoped row, so the transport's session guard and this check are two
 *     independent reasons a non-owner learns nothing. The check runs first, before the
 *     project is even validated, so a refused caller cannot use the refusal to
 *     enumerate projects (F01-AC1).
 *   - **Binding a contract to the request it answers.** The domain stores a
 *     `requestFingerprint` on each revision; computing it here, from the request read
 *     out of storage in this same call, is what makes "does this contract still answer
 *     this request" a question with an answer rather than a comment. A caller cannot
 *     supply the fingerprint, so a contract cannot be filed against a request whose text
 *     it never read (mvp-spec 3, ARCHITECTURE "Candidate and decision rules").
 *   - **Revision identity.** The next contract id and revision number are minted here,
 *     from the stored history of that request, so revision numbering is one rule in one
 *     place and a caller cannot choose a number that skips or repeats.
 *   - **Saying which draft an approval approves.** `approveContract` forwards the
 *     fingerprint the caller read into the domain transition and into the store's
 *     compare-and-set, so a caller's approval can only ever seal text it named. The
 *     approver comes from the actor; the reviewed text comes from the read. Neither is
 *     taken from the command's other members, which is what makes "an owner approved this
 *     scope" a fact rather than a claim.
 *
 * What this module deliberately has no path for: creating a ticket, starting a run, or
 * setting a status from anything but an explicit owner action. Nothing here imports an
 * engine, an adapter or a webhook contract, so a run reporting success or a model's own
 * summary has no entry point (MVP: "Never let agent or model output set approved
 * directly").
 */

import { randomUUID } from 'node:crypto';
import {
  approveContract,
  contractAnswersRequest,
  contractGate,
  createContractDraft,
  createRequest,
  editContract,
  err,
  fingerprint,
  invalidateContract,
  isFingerprint,
  nextRevisionNumber,
  ok,
  reviseContract,
  supersedeContract,
  updateRequest,
} from '@shiploop/domain';
import type {
  ContractContent,
  ContractCriterion,
  ContractId,
  DeliveryContract,
  DomainError,
  Fingerprint,
  OwnerId,
  ProjectId,
  Request,
  RequestId,
  Result,
  VerificationType,
} from '@shiploop/domain';
import type { ContractRepository, RequestRepository } from '@shiploop/storage';
import type { ControllerClock, OwnerActor } from './profiles.ts';

/** One criterion as a caller submits it. */
export interface ContractCriterionInput {
  readonly id: string;
  readonly description: string;
  readonly verificationType: VerificationType;
  /**
   * The check that verifies an `automated` criterion, as a check name from the project's
   * own verification configuration.
   *
   * Optional on submission because a draft may be mid-authoring: the binding is required
   * at approval, not here, so an owner writing criteria one at a time is not refused while
   * doing it. Absent means unbound, and `approveContract` refuses to agree an automated
   * criterion in that state (F23-AC1, F24-AC3).
   */
  readonly verificationCheckId?: string | null;
}

/** The contract content as a caller submits it, on create and on edit alike. */
export interface ContractContentInput {
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly ContractCriterionInput[];
}

/** What the owner may state about which revision is stale and why. */
export const CONTRACT_STALE_REASONS = [
  /** The request itself changed, so the revision no longer answers what was asked. */
  'RequestChanged',
  /** Something outside the contract changed: a profile, a recipe, a required check. */
  'SurroundingContextChanged',
  /** The owner withdrew the agreement without replacing it. */
  'WithdrawnByOwner',
] as const;
export type ContractStaleReason = (typeof CONTRACT_STALE_REASONS)[number];

/** The closure a stale reason stands for, so the stored row carries an explanation. */
const STALE_REASON_TEXT: Readonly<Record<ContractStaleReason, string>> = Object.freeze({
  RequestChanged: 'The request this revision answers has changed.',
  SurroundingContextChanged: 'Something the contract depends on outside the contract has changed.',
  WithdrawnByOwner: 'The owner withdrew this revision without replacing it.',
});

/** One acceptance criterion as the transport reports it. */
export interface ContractCriterionView {
  readonly id: string;
  readonly description: string;
  readonly verificationType: VerificationType;
  /**
   * The check that verifies an automated criterion, or null when none is bound.
   *
   * Reported rather than filled in from whichever check is green: a criterion with no bound
   * verifier is `unverified`, and that is the honest reading rather than an inference
   * (F23-AC1).
   */
  readonly verificationCheckId: string | null;
}

/** One contract revision as the transport reports it. */
export interface ContractView {
  readonly contractId: string;
  readonly revision: number;
  readonly projectId: string;
  readonly requestId: string;
  readonly status: 'draft' | 'approved' | 'stale';
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly ContractCriterionView[];
  readonly contentFingerprint: string;
  readonly requestFingerprint: string;
  /**
   * Whether the revision still answers the request as it now reads.
   *
   * A report, not a state: the contract is not demoted here, because deciding that a
   * request edit is material to an agreement is an owner's call about scope. The flag
   * exists so a client can say "this contract answers an older version of the request"
   * instead of rendering an approval that quietly no longer applies (mvp-spec 3).
   */
  readonly answersCurrentRequest: boolean;
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
  readonly staleReason: string | null;
  readonly supersededByRevision: number | null;
  readonly sourceBriefId: string | null;
  readonly sourceBriefVersion: number | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Why this revision may not be measured against a candidate, or null when it may. */
  readonly blockedBecause: string | null;
}

/** One request and the contract state that answers it, as the transport reports it. */
export interface RequestDetailView {
  readonly request: Request;
  /** The newest revision of any status: where this request has got to. */
  readonly latestRevision: ContractView | null;
  /** The revision a candidate may currently be measured against, or null when none is approved. */
  readonly approvedRevision: ContractView | null;
  /** Every revision, oldest first. */
  readonly revisions: readonly ContractView[];
}

export interface CreateRequestCommand {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly description: string;
  /** The idea this request was promoted from, when it was. */
  readonly sourceIdeaId?: string | null;
}

export interface UpdateRequestCommand {
  readonly projectId: ProjectId;
  readonly requestId: RequestId;
  readonly title?: string;
  readonly description?: string;
  /** The instant the client loaded the request at, for the compare-and-set. */
  readonly expectedUpdatedAt: string;
}

export interface DraftContractCommand {
  readonly projectId: ProjectId;
  readonly requestId: RequestId;
  readonly content: ContractContentInput;
  /** The brief version this draft was seeded from, when it was. */
  readonly sourceBriefId?: string | null;
  readonly sourceBriefVersion?: number | null;
}

export interface EditContractCommand {
  readonly projectId: ProjectId;
  readonly contractId: ContractId;
  readonly revision: number;
  readonly content: ContractContentInput;
  readonly expectedUpdatedAt: string;
}

/**
 * Approves a revision the caller read.
 *
 * `expectedContentFingerprint` is the fingerprint the read returned, sent back by the
 * caller, and it is required: an approval is an owner's agreement to text, and an approval
 * that cannot say which text would seal the agreement over whatever happened to be stored
 * when the call landed. It arrives as text because it crossed a transport, and it is
 * checked against the fingerprint the domain derives rather than trusted (mvp-spec 3,
 * mvp-spec 7 "Reject stale requests").
 *
 * There is no approver field. The owner comes from the actor the guard proved, so a
 * command cannot record an approval attributed to somebody else.
 */
export interface ApproveContractCommand {
  readonly projectId: ProjectId;
  readonly contractId: ContractId;
  readonly revision: number;
  readonly expectedContentFingerprint: string;
}

export interface ReviseContractCommand {
  readonly projectId: ProjectId;
  readonly contractId: ContractId;
  readonly revision: number;
  readonly content: ContractContentInput;
}

export interface InvalidateContractCommand {
  readonly projectId: ProjectId;
  readonly contractId: ContractId;
  readonly revision: number;
  readonly reason: ContractStaleReason;
}

export interface ContractUseCaseDeps {
  readonly clock: ControllerClock;
  readonly requests: RequestRepository;
  readonly contracts: ContractRepository;
}

/**
 * The one gate every call passes (F01-AC1).
 *
 * Both halves are checked because an actor can name an owner without being one, and a
 * role of `Owner` with no owner identity is not a caller this layer can attribute an
 * approval to. Approval is the strongest write in this module, so the gate is where it
 * starts.
 */
function requireContractOwner(actor: OwnerActor): Result<OwnerId, DomainError> {
  if (actor.role !== 'Owner' || actor.ownerId === null) {
    return err({
      code: 'Forbidden',
      reason: `Only the owner may act on a request or its delivery contract; the ${actor.role} role may not (F01-AC1).`,
    });
  }
  return ok(actor.ownerId);
}

/**
 * The fingerprint of a request's current text.
 *
 * One function so "the request as it now reads" has one answer. The `sourceIdeaId` is
 * included deliberately: promoting an idea into a request is a change to what the
 * request is, and a contract written before that promotion does not answer it.
 */
function requestFingerprintOf(request: Request): Fingerprint {
  return fingerprint({
    projectId: request.projectId,
    title: request.title,
    description: request.description,
    sourceIdeaId: request.sourceIdeaId,
  });
}

/**
 * Validates the caller-supplied content against the closed vocabularies.
 *
 * Here rather than in the domain only because the *transport* has already parsed this as
 * JSON, and this is the boundary where an untrusted shape meets the domain's types. A
 * value outside the vocabulary is refused by name; it is never coerced to a default,
 * because defaulting a verification type would decide who may settle a criterion.
 *
 * The verification binding is read here too, for the same reason: a body may arrive with
 * no `verificationCheckId` at all, and turning that absence into an explicit `null` is
 * what lets the domain's approval gate see "unbound" rather than a hole in the shape.
 * A binding that is present but is not text is refused by name, because the alternative
 * - coercing it - would either invent a check or silently drop one the caller meant.
 */
function toContractContent(input: ContractContentInput): Result<ContractContent, DomainError> {
  const criteria: ContractCriterion[] = [];
  for (const [index, criterion] of input.acceptanceCriteria.entries()) {
    if (typeof criterion?.verificationType !== 'string') {
      return err({
        code: 'Invalid',
        reason: 'An acceptance criterion needs a verification type.',
        fields: [{ path: `acceptanceCriteria[${index}].verificationType`, message: 'Required.' }],
      });
    }
    const checkId = criterion.verificationCheckId;
    if (checkId !== undefined && checkId !== null && typeof checkId !== 'string') {
      return err({
        code: 'Invalid',
        reason: 'A verification binding is a check name or absent.',
        fields: [
          {
            path: `acceptanceCriteria[${index}].verificationCheckId`,
            message: 'Name the check that verifies an automated criterion, or leave it unbound.',
          },
        ],
      });
    }
    criteria.push({
      id: typeof criterion.id === 'string' ? criterion.id : '',
      description: typeof criterion.description === 'string' ? criterion.description : '',
      verificationType: criterion.verificationType,
      // Absent and blank both mean unbound, and both reach the domain as `null`. A blank
      // name is not a check anybody configured, so reading it as unbound is the only
      // honest reading - and the domain refuses to approve an automated criterion in that
      // state, so nothing unverifiable can be agreed either way.
      verificationCheckId: typeof checkId === 'string' && checkId.trim().length > 0 ? checkId : null,
    });
  }

  return ok({
    outcome: typeof input.outcome === 'string' ? input.outcome : '',
    scope: Array.isArray(input.scope) ? input.scope.filter((entry): entry is string => typeof entry === 'string') : [],
    outOfScope: Array.isArray(input.outOfScope)
      ? input.outOfScope.filter((entry): entry is string => typeof entry === 'string')
      : [],
    acceptanceCriteria: criteria,
  });
}

function toContractView(contract: DeliveryContract, currentRequestFingerprint: Fingerprint): ContractView {
  const gate = contractGate(contract);
  return {
    contractId: String(contract.contractId),
    revision: contract.revision,
    projectId: String(contract.projectId),
    requestId: String(contract.requestId),
    status: contract.status,
    outcome: contract.outcome,
    scope: [...contract.scope],
    outOfScope: [...contract.outOfScope],
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    contentFingerprint: contract.contentFingerprint,
    requestFingerprint: contract.requestFingerprint,
    answersCurrentRequest: contractAnswersRequest(contract, currentRequestFingerprint),
    approvedAt: contract.approvedAt,
    approvedBy: contract.approvedBy === null ? null : String(contract.approvedBy),
    staleReason: contract.staleReason,
    supersededByRevision: contract.supersededByRevision,
    sourceBriefId: contract.sourceBriefId,
    sourceBriefVersion: contract.sourceBriefVersion,
    createdBy: String(contract.createdBy),
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
    blockedBecause: gate.satisfied ? null : gate.reason,
  };
}

export function createContractUseCases(deps: ContractUseCaseDeps) {
  /**
   * The stored request, or the refusal a caller should see first.
   *
   * Project-scoped read: the identity alone is never enough, so a request id from
   * another project is invisible here rather than merely refused (F02-AC2).
   */
  const requireRequest = (projectId: ProjectId, requestId: RequestId): Result<Request, DomainError> => {
    const read = deps.requests.read(projectId, requestId);
    if (!read.ok) return err(read.error);
    return ok(read.value);
  };

  /** One stored revision, addressed by its project as well as its identity. */
  const requireContract = (
    projectId: ProjectId,
    contractId: ContractId,
    revision: number,
  ): Result<DeliveryContract, DomainError> => {
    const read = deps.contracts.read(projectId, contractId, revision);
    if (!read.ok) return err(read.error);
    return ok(read.value);
  };

  /**
   * Creates a request.
   *
   * No engine, no provider and no project configuration is consulted: this is the first
   * step of the MVP journey and it must work on a deployment that has configured none of
   * them (MVP: "No AI engine may be required to create or read a request").
   */
  const createRequestUseCase = (
    command: CreateRequestCommand,
    actor: OwnerActor,
  ): Result<Request, DomainError> => {
    const owner = requireContractOwner(actor);
    if (!owner.ok) return err(owner.error);

    const created = createRequest({
      requestId: randomUUID() as RequestId,
      projectId: command.projectId,
      title: command.title,
      description: command.description,
      sourceIdeaId: command.sourceIdeaId ?? null,
      at: deps.clock.now(),
    });
    if (!created.ok) return err(created.error);

    const stored = deps.requests.create(created.value);
    if (!stored.ok) return err(stored.error);
    return ok(stored.value);
  };

  /** One request, with everything recorded against it. */
  const getRequest = (command: UpdateRequestCommand, actor: OwnerActor): Result<RequestDetailView, DomainError> => {
    const owner = requireContractOwner(actor);
    if (!owner.ok) return err(owner.error);

    const request = requireRequest(command.projectId, command.requestId);
    if (!request.ok) return err(request.error);
    return readDetail(request.value);
  };

  /**
   * The request, its newest revision, its approved revision and its whole history.
   *
   * The approved revision is a separate field rather than something a client derives
   * from the history, because "may a candidate be measured against this?" has one
   * answer and a client picking the newest row would answer it differently.
   */
  const readDetail = (request: Request): Result<RequestDetailView, DomainError> => {
    const currentFingerprint = requestFingerprintOf(request);
    const revisions = deps.contracts.listForRequest(request.projectId, request.requestId);
    if (!revisions.ok) return err(revisions.error);
    const latest = deps.contracts.latest(request.projectId, request.requestId);
    if (!latest.ok) return err(latest.error);
    const approved = deps.contracts.currentApproved(request.projectId, request.requestId);
    if (!approved.ok) return err(approved.error);

    return ok({
      request,
      latestRevision: latest.value === null ? null : toContractView(latest.value, currentFingerprint),
      approvedRevision: approved.value === null ? null : toContractView(approved.value, currentFingerprint),
      revisions: revisions.value.map((contract) => toContractView(contract, currentFingerprint)),
    });
  };

  /** The requests of one project, newest first. */
  const listRequests = (
    projectId: ProjectId,
    actor: OwnerActor,
  ): Result<readonly Request[], DomainError> => {
    const owner = requireContractOwner(actor);
    if (!owner.ok) return err(owner.error);
    return deps.requests.listForProject(projectId);
  };

  /**
   * Edits a request draft.
   *
   * The compare-and-set instant is the caller's, and the write names it, so two tabs
   * editing one draft cannot both report success (mvp-spec 7). Nothing here touches a
   * contract: an approved contract is a frozen agreement, and the way to change the scope
   * is a new revision, not an edit to the request underneath it.
   */
  const updateRequestUseCase = (
    command: UpdateRequestCommand,
    actor: OwnerActor,
  ): Result<Request, DomainError> => {
    const owner = requireContractOwner(actor);
    if (!owner.ok) return err(owner.error);

    const stored = requireRequest(command.projectId, command.requestId);
    if (!stored.ok) return err(stored.error);

    const edited = updateRequest(
      stored.value,
      {
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.description === undefined ? {} : { description: command.description }),
      },
      { expectedUpdatedAt: command.expectedUpdatedAt, at: deps.clock.now() },
    );
    if (!edited.ok) return err(edited.error);

    const written = deps.requests.update(edited.value, command.expectedUpdatedAt);
    if (!written.ok) return err(written.error);
    return ok(written.value);
  };

  /**
   * Creates revision 1 of a contract for a request.
   *
   * Refused when the request already has a revision, rather than silently producing a
   * second revision: two drafts for one request is exactly the state the schema forbids,
   * and reaching it through this path would mean the numbering rule and the store
   * disagreed. Revising is `reviseContract`.
   */
  const draftContract = (
    command: DraftContractCommand,
    actor: OwnerActor,
  ): Result<ContractView, DomainError> => {
    const owner = requireContractOwner(actor);
    if (!owner.ok) return err(owner.error);

    const request = requireRequest(command.projectId, command.requestId);
    if (!request.ok) return err(request.error);

    const existing = deps.contracts.listForRequest(command.projectId, command.requestId);
    if (!existing.ok) return err(existing.error);
    if (existing.value.length > 0) {
      return err({
        code: 'Conflict',
        reason: `This request already has ${existing.value.length} contract revision(s). Revise the newest one instead of drafting a new first revision.`,
        expected: 'no revisions',
        actual: `${existing.value.length} revision(s)`,
      });
    }

    const content = toContractContent(command.content);
    if (!content.ok) return err(content.error);

    const drafted = createContractDraft({
      contractId: randomUUID() as ContractId,
      projectId: command.projectId,
      requestId: command.requestId,
      revision: nextRevisionNumber(null),
      content: content.value,
      // Computed from the request this call read, never supplied by the caller.
      requestFingerprint: requestFingerprintOf(request.value),
      sourceBriefId: command.sourceBriefId ?? null,
      sourceBriefVersion: command.sourceBriefVersion ?? null,
      createdBy: owner.value,
      at: deps.clock.now(),
    });
    if (!drafted.ok) return err(drafted.error);

    const written = deps.contracts.createDraft(drafted.value);
    if (!written.ok) return err(written.error);
    return ok(toContractView(written.value, requestFingerprintOf(request.value)));
  };

  /** One stored revision, with its criteria and whether it still answers its request. */
  const getContract = (
    command: { readonly projectId: ProjectId; readonly contractId: ContractId; readonly revision: number },
    actor: OwnerActor,
  ): Result<ContractView, DomainError> => {
    const owner = requireContractOwner(actor);
    if (!owner.ok) return err(owner.error);

    const contract = requireContract(command.projectId, command.contractId, command.revision);
    if (!contract.ok) return err(contract.error);
    const request = requireRequest(command.projectId, contract.value.requestId);
    if (!request.ok) return err(request.error);
    return ok(toContractView(contract.value, requestFingerprintOf(request.value)));
  };

  /**
   * Every revision of one request, oldest first.
   *
   * The same rows `getRequest` reports, read through the same repository method, so the
   * two answers cannot disagree about which revisions exist.
   */
  const listContractRevisions = (
    command: { readonly projectId: ProjectId; readonly requestId: RequestId },
    actor: OwnerActor,
  ): Result<readonly ContractView[], DomainError> => {
    const owner = requireContractOwner(actor);
    if (!owner.ok) return err(owner.error);

    const request = requireRequest(command.projectId, command.requestId);
    if (!request.ok) return err(request.error);
    const currentFingerprint = requestFingerprintOf(request.value);

    const revisions = deps.contracts.listForRequest(command.projectId, command.requestId);
    if (!revisions.ok) return err(revisions.error);
    return ok(revisions.value.map((contract) => toContractView(contract, currentFingerprint)));
  };

  /** The acceptance criteria of one revision, in the order they were written. */
  const listContractCriteria = (
    command: { readonly projectId: ProjectId; readonly contractId: ContractId; readonly revision: number },
    actor: OwnerActor,
  ): Result<readonly ContractCriterionView[], DomainError> => {
    const owner = requireContractOwner(actor);
    if (!owner.ok) return err(owner.error);

    const contract = requireContract(command.projectId, command.contractId, command.revision);
    if (!contract.ok) return err(contract.error);
    return ok(contract.value.acceptanceCriteria.map((criterion) => ({ ...criterion })));
  };

  /**
   * Edits a draft revision in place.
   *
   * Refused for an approved or stale revision by the domain, which is what makes "an
   * approved contract never silently mutates" a property of the API rather than a rule
   * every caller is trusted to follow (mvp-spec 3).
   */
  const editContractUseCase = (
    command: EditContractCommand,
    actor: OwnerActor,
  ): Result<ContractView, DomainError> => {
    const owner = requireContractOwner(actor);
    if (!owner.ok) return err(owner.error);

    const contract = requireContract(command.projectId, command.contractId, command.revision);
    if (!contract.ok) return err(contract.error);

    const content = toContractContent(command.content);
    if (!content.ok) return err(content.error);

    const edited = editContract(contract.value, content.value, {
      expectedUpdatedAt: command.expectedUpdatedAt,
      at: deps.clock.now(),
      editedBy: owner.value,
    });
    if (!edited.ok) return err(edited.error);

    const written = deps.contracts.editDraft(edited.value, command.expectedUpdatedAt);
    if (!written.ok) return err(written.error);

    const request = requireRequest(command.projectId, written.value.requestId);
    if (!request.ok) return err(request.error);
    return ok(toContractView(written.value, requestFingerprintOf(request.value)));
  };

  /**
   * Approves a draft revision. The owner's action, and the only way to become approved.
   *
   * The approver comes from the authenticated actor rather than the command, so no caller
   * - and no model behind a caller - can record an approval attributed to somebody else
   * (mvp-spec 3, MVP: "Never let agent or model output set approved directly").
   *
   * The command also has to say which text the owner reviewed, and that is checked twice
   * on purpose. The domain refuses a fingerprint that does not describe the draft it holds,
   * and the store's WHERE clause refuses to write when the row has moved since - so the
   * two-tab case is refused whether the other tab's edit landed before this call was made
   * or between the read and the write. Neither check reads text from the command: the
   * command carries one value the server derived, and the server decides whether it still
   * describes what is stored (mvp-spec 7, "Reject stale requests").
   */
  const approveContractUseCase = (
    command: ApproveContractCommand,
    actor: OwnerActor,
  ): Result<ContractView, DomainError> => {
    const owner = requireContractOwner(actor);
    if (!owner.ok) return err(owner.error);

    if (!isFingerprint(command.expectedContentFingerprint)) {
      return err({
        code: 'Invalid',
        reason: 'An approval must name the draft text it approves, so an owner approves what they read.',
        fields: [
          {
            path: 'expectedContentFingerprint',
            message:
              'Send the contentFingerprint the revision carried when it was read. A value that is not a fingerprint describes no draft.',
          },
        ],
      });
    }
    const reviewed = command.expectedContentFingerprint;

    const contract = requireContract(command.projectId, command.contractId, command.revision);
    if (!contract.ok) return err(contract.error);

    const approvedValue = approveContract(contract.value, {
      approvedBy: owner.value,
      at: deps.clock.now(),
      expectedContentFingerprint: reviewed,
    });
    if (!approvedValue.ok) return err(approvedValue.error);

    const written = deps.contracts.approve(approvedValue.value, {
      updatedAt: contract.value.updatedAt,
      contentFingerprint: reviewed,
    });
    if (!written.ok) return err(written.error);

    const request = requireRequest(command.projectId, written.value.requestId);
    if (!request.ok) return err(request.error);
    return ok(toContractView(written.value, requestFingerprintOf(request.value)));
  };

  /**
   * Starts the next revision from the current one, retiring the approval it replaces.
   *
   * The two writes are the domain's single step and the repository's single transaction,
   * because the state worth preventing is a new revision existing while the previous
   * approval still reads as current: a candidate measured against revision 1 would then
   * be described by revision 2's text (mvp-spec 3).
   */
  const reviseContractUseCase = (
    command: ReviseContractCommand,
    actor: OwnerActor,
  ): Result<ContractView, DomainError> => {
    const owner = requireContractOwner(actor);
    if (!owner.ok) return err(owner.error);

    const contract = requireContract(command.projectId, command.contractId, command.revision);
    if (!contract.ok) return err(contract.error);

    const request = requireRequest(command.projectId, contract.value.requestId);
    if (!request.ok) return err(request.error);

    const content = toContractContent(command.content);
    if (!content.ok) return err(content.error);

    const at = deps.clock.now();
    const revised = reviseContract(contract.value, {
      // A new identity per revision: two revisions of one contract are different
      // agreements, and reusing the id would make revision the only thing distinguishing
      // them - which is exactly the "same PR number, different build" mistake the
      // candidate rules exist to prevent (ARCHITECTURE, "Candidate and decision rules").
      contractId: randomUUID() as ContractId,
      content: content.value,
      requestFingerprint: requestFingerprintOf(request.value),
      revisedBy: owner.value,
      at,
    });
    if (!revised.ok) return err(revised.error);

    const written = deps.contracts.revise(revised.value);
    if (!written.ok) return err(written.error);
    return ok(toContractView(written.value, requestFingerprintOf(request.value)));
  };

  /**
   * Retires an approval for a named reason.
   *
   * The reason is a closed vocabulary rather than free text so the stored explanation is
   * one a client can act on: `RequestChanged` means revise the contract,
   * `WithdrawnByOwner` means the request has no agreement any more. The reason is *not*
   * inferred from the request's fingerprint: deciding that a request edit is material to
   * an agreement is an owner's call about scope, so this is an explicit action
   * (mvp-spec 3).
   */
  const invalidateContractUseCase = (
    command: InvalidateContractCommand,
    actor: OwnerActor,
  ): Result<ContractView, DomainError> => {
    const owner = requireContractOwner(actor);
    if (!owner.ok) return err(owner.error);

    const reason = command.reason;
    if (!(CONTRACT_STALE_REASONS as readonly string[]).includes(reason)) {
      return err({
        code: 'Invalid',
        reason: `"${reason}" is not a reason a delivery contract can be made stale for.`,
        fields: [{ path: 'reason', message: `Must be one of ${CONTRACT_STALE_REASONS.join(', ')}.` }],
      });
    }

    const contract = requireContract(command.projectId, command.contractId, command.revision);
    if (!contract.ok) return err(contract.error);

    const at = deps.clock.now();
    const stale = invalidateContract(contract.value, { reason: STALE_REASON_TEXT[reason], at });
    if (!stale.ok) return err(stale.error);

    const written = deps.contracts.markStale(stale.value, contract.value.updatedAt);
    if (!written.ok) return err(written.error);

    const request = requireRequest(command.projectId, written.value.requestId);
    if (!request.ok) return err(request.error);
    return ok(toContractView(written.value, requestFingerprintOf(request.value)));
  };

  /**
   * Supersedes an approved revision without drafting its replacement.
   *
   * Separate from `invalidateContractUseCase` because the two facts are different:
   * superseded says "there is a newer agreement", withdrawn says "there is none". A
   * caller that only wants to retire an approval without yet writing the next revision
   * uses this, and the stored reason says which of the two happened.
   */
  const supersedeContractUseCase = (
    command: { readonly projectId: ProjectId; readonly contractId: ContractId; readonly revision: number; readonly supersededByRevision: number },
    actor: OwnerActor,
  ): Result<ContractView, DomainError> => {
    const owner = requireContractOwner(actor);
    if (!owner.ok) return err(owner.error);

    const contract = requireContract(command.projectId, command.contractId, command.revision);
    if (!contract.ok) return err(contract.error);

    const superseded = supersedeContract(contract.value, {
      supersededByRevision: command.supersededByRevision,
      at: deps.clock.now(),
    });
    if (!superseded.ok) return err(superseded.error);

    const written = deps.contracts.markStale(superseded.value, contract.value.updatedAt);
    if (!written.ok) return err(written.error);

    const request = requireRequest(command.projectId, written.value.requestId);
    if (!request.ok) return err(request.error);
    return ok(toContractView(written.value, requestFingerprintOf(request.value)));
  };

  return {
    createRequest: createRequestUseCase,
    getRequest,
    listRequests,
    updateRequest: updateRequestUseCase,
    draftContract,
    getContract,
    listContractRevisions,
    listContractCriteria,
    editContract: editContractUseCase,
    approveContract: approveContractUseCase,
    reviseContract: reviseContractUseCase,
    invalidateContract: invalidateContractUseCase,
    supersedeContract: supersedeContractUseCase,
  };
}

export type ContractUseCases = ReturnType<typeof createContractUseCases>;