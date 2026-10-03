import type { ProjectId, RequestId } from './ids.ts';
import type { DomainError, Result } from './result.ts';
import { err, invalid, ok } from './result.ts';

/**
 * The owner's request: what they want changed (mvp-spec 3, MVP "Request").
 *
 * A request is deliberately the smallest thing in this product that the owner writes
 * and the contract is written against. Three properties are structural rather than
 * conventional:
 *
 *   - **It needs no engine.** Nothing here reads a model, a repository or a provider.
 *     Creating and reading a request is a pure value transition, so the MVP journey
 *     starts on a deployment with no coding engine configured at all. That is the
 *     whole reason this is not modelled as a generated artefact (MVP, "No AI engine
 *     may be required").
 *   - **A draft is editable and an edited draft is still a draft.** `updateRequest`
 *     returns a new value rather than mutating, so a stale client holding an old copy
 *     cannot make the stored record describe something the owner did not type.
 *   - **Editing a request never reaches a contract.** An approved contract is a frozen
 *     agreement; changing the request under it is exactly the silent mutation the
 *     delivery contract forbids. `updateRequest` therefore has no contract parameter
 *     at all, and the contract layer is the only place a revision is created
 *     (`contract.ts`).
 *
 * Why this is not the existing `IdeaDraft` (F06):
 *
 * An idea is a *pre-project capture*: it is optional about its project, it may be
 * deferred or archived before anything is built, it carries attachments and a
 * generated summary, and its purpose is to become a Linear issue through the
 * clarification and planning pipeline. A request is *project-scoped by construction*
 * and exists to be answered by exactly one delivery contract; it has no publication
 * disposition and no attachments. Conflating them would either give a contract a
 * nullable project, or give an idea a contract revision, and both would make "which
 * project is this for" answerable two ways. They are genuinely different records with
 * a one-way relationship: an idea may be promoted into a request, and a request
 * records the idea it came from.
 */

/** The longest title a request may carry; a title is a label, not a document. */
export const MAXIMUM_REQUEST_TITLE_LENGTH = 200;

/** The longest description a request may carry. */
export const MAXIMUM_REQUEST_DESCRIPTION_LENGTH = 20_000;

/**
 * What the owner wants changed, inside one project.
 *
 * Read-only and frozen: every function that produces one returns a new value, so a
 * consumer cannot edit a stored request in place and leave the record claiming
 * something the owner never typed.
 */
export interface Request {
  readonly requestId: RequestId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly description: string;
  /**
   * The idea this request was promoted from, or null when it was captured directly.
   *
   * One-way provenance rather than a live link: the idea keeps its own immutable raw
   * request (F06-AC1) and this record keeps the owner's current wording. Nothing reads
   * the other to answer for it.
   */
  readonly sourceIdeaId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateRequestInput {
  readonly requestId: RequestId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly description: string;
  readonly sourceIdeaId?: string | null;
  readonly at: string;
}

interface FieldError {
  readonly path: string;
  readonly message: string;
}

/** A partial edit. An absent field is unchanged; an empty one is refused. */
export interface RequestPatch {
  readonly title?: string;
  readonly description?: string;
}

/**
 * Validates the two fields a request is made of.
 *
 * Both are required and both are bounded. A request with no description cannot be
 * answered by any contract, and a request with no title cannot be listed in a way an
 * owner recognises, so neither is defaulted rather than refused - unlike intake, where
 * F06-AC3 exists precisely so a lossy capture still succeeds. A request is not a
 * capture: it is the first thing the owner has decided is worth specifying.
 */
function requestFieldErrors(title: string, description: string): readonly FieldError[] {
  const errors: FieldError[] = [];
  if (title.trim().length === 0) {
    errors.push({ path: 'title', message: 'A request needs a title.' });
  } else if (title.trim().length > MAXIMUM_REQUEST_TITLE_LENGTH) {
    errors.push({
      path: 'title',
      message: `A title may be at most ${MAXIMUM_REQUEST_TITLE_LENGTH} characters.`,
    });
  }
  if (description.trim().length === 0) {
    errors.push({ path: 'description', message: 'A request needs a description of what should change.' });
  } else if (description.trim().length > MAXIMUM_REQUEST_DESCRIPTION_LENGTH) {
    errors.push({
      path: 'description',
      message: `A description may be at most ${MAXIMUM_REQUEST_DESCRIPTION_LENGTH} characters.`,
    });
  }
  return errors;
}

/**
 * Creates a request.
 *
 * The project identity is required, not optional: a contract binds to a project, and a
 * request with no project could not be answered without inventing one. The stored text
 * is trimmed once here so a pasted form value is not padded and a blank request is
 * detectable; it is otherwise exactly what the owner typed.
 */
export function createRequest(input: CreateRequestInput): Result<Request, DomainError> {
  const title = input.title.trim();
  const description = input.description.trim();
  const errors: FieldError[] = [...requestFieldErrors(title, description)];
  if (input.projectId.trim().length === 0) {
    errors.push({ path: 'projectId', message: 'A request belongs to a project.' });
  }
  if (errors.length > 0) {
    return err<DomainError>(invalid('The request could not be created.', errors));
  }

  return ok<Request>(Object.freeze({
    requestId: input.requestId,
    projectId: input.projectId,
    title,
    description,
    sourceIdeaId: input.sourceIdeaId ?? null,
    createdAt: input.at,
    updatedAt: input.at,
  }));
}

/**
 * Applies an owner's edit to a request draft.
 *
 * Returns a new value with a moved `updatedAt`. `expectedUpdatedAt` is a
 * compare-and-set rather than a nicety: two tabs editing one draft would otherwise
 * silently drop one edit, and the owner would see their save succeed against a record
 * they had already replaced (mvp-spec 7, "Reject stale requests").
 *
 * An edit that changes nothing is refused rather than accepted as a no-op, because a
 * write that reports success while moving nothing is what makes a client believe a
 * save happened.
 */
export function updateRequest(
  request: Request,
  patch: RequestPatch,
  options: { readonly expectedUpdatedAt: string; readonly at: string },
): Result<Request, DomainError> {
  if (options.expectedUpdatedAt !== request.updatedAt) {
    return err<DomainError>({
      code: 'Conflict',
      reason: 'The request changed after it was loaded. Reload it before saving again.',
      expected: options.expectedUpdatedAt,
      actual: request.updatedAt,
    });
  }

  const title = patch.title === undefined ? request.title : patch.title.trim();
  const description = patch.description === undefined ? request.description : patch.description.trim();
  const errors = requestFieldErrors(title, description);
  if (errors.length > 0) {
    return err<DomainError>(invalid('The request could not be updated.', errors));
  }
  if (title === request.title && description === request.description) {
    return err<DomainError>(
      invalid('The request could not be updated.', [
        { path: 'request', message: 'Nothing changed; edit the title or the description.' },
      ]),
    );
  }

  return ok<Request>(
    Object.freeze({
      ...request,
      title,
      description,
      updatedAt: options.at,
    }),
  );
}

/** Whether this request still carries the text it was created with. */
export function isUntouchedRequest(request: Request): boolean {
  return request.createdAt === request.updatedAt;
}