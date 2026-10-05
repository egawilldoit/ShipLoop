/**
 * New Request: what the owner types, the two-member body it becomes, and the state the server
 * answers with afterwards.
 *
 * ## Why this module is separate from the screen
 *
 * The screen renders; this decides nothing the server has not already decided. It exists so the
 * rules that decide *what a request is* can be read and tested without a browser, and so the screen
 * cannot grow a second opinion about them. `RequestScreen.tsx` owns the markup and the state;
 * everything below is either a value the owner typed or an answer the server gave.
 *
 * ## One field, and the title is derived from it
 *
 * `routes/contracts.ts` accepts exactly two members on `POST .../requests` — `title` and
 * `description` — and both are required. It does **not** accept scope, acceptance criteria, a
 * verification type, a category, a priority or a project id, because those are the delivery
 * contract's content and putting them here would make creating a request a project-management form.
 * The owner writes one sentence of what they want changed; the short label the server also requires
 * is derived from their own words unless they choose to write one (mvp-spec 3, F06-AC1).
 *
 * Nothing is invented for them: `title` is their first line, whitespace-collapsed and cut at the
 * route's own bound. A title they typed themselves is never overwritten.
 *
 * ## Every request this module sends is project-scoped
 *
 * Each call takes a `ProjectScope` rather than a project id, so a screen cannot address a project it
 * made up: with no project selected the client answers `NoProjectSelected` and sends nothing at all
 * (F02-AC1, F02-AC2).
 */

import { MAXIMUM_TITLE_LENGTH } from '../contract-draft.ts';
import {
  createRequest,
  getRequest,
  listRequests,
  type MvpFailure,
  type MvpResult,
  type ProjectScope,
  type RequestDetailView,
  type RequestView,
} from '../mvp-client/index.ts';

/* -------------------------------------------------------------------------- */
/* What the owner typed                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The request form, as two strings.
 *
 * `description` is the request. `title` is optional here and required by the route, which is why the
 * distinction exists rather than being flattened into one field at the markup.
 */
export interface RequestForm {
  /** "What do you want changed?", in the owner's own words. */
  readonly description: string;
  /** An optional short label. Blank means "derive one from the description". */
  readonly title: string;
}

/**
 * A refusal raised here rather than by the server.
 *
 * Carries the same shape as every other refusal so a screen has one thing to render, and `status: 0`
 * because no request completed — a form that is not ready yet is not a server error (F02-AC4, N03-AC3).
 */
function localRefusal<T>(reason: string): MvpResult<T> {
  const failure: MvpFailure = {
    code: 'Invalid',
    reason,
    status: 0,
    fields: [],
    prerequisites: [],
    expected: null,
    actual: null,
  };
  return { ok: false, failure };
}

/**
 * The label the route requires, derived from the owner's own sentence.
 *
 * The first non-empty line, whitespace collapsed, cut at `MAXIMUM_TITLE_LENGTH` on a word boundary
 * so the label does not end mid-word. The bound is `routes/contracts.ts`'s own, and it is applied
 * here so a long first sentence is shortened rather than refused (F02-AC4).
 */
export function derivedRequestTitle(description: string): string {
  const firstLine = description
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  const collapsed = (firstLine ?? '').replace(/\s+/g, ' ');
  if (collapsed === '') return 'New request';
  if (collapsed.length <= MAXIMUM_TITLE_LENGTH) return collapsed;
  const cut = collapsed.slice(0, MAXIMUM_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  const shortened = lastSpace > 40 ? cut.slice(0, lastSpace) : cut;
  return shortened.trim() === '' ? cut : shortened.trim();
}

/**
 * What the form becomes: either a body the route will accept, or the reason it is not ready.
 *
 * A blank description is refused here rather than sent, because the server would answer 400 for a
 * form the screen could see was empty — and a refusal that costs a round trip to learn something
 * already on screen is the input-error experience F02-AC4 exists to remove.
 */
export type RequestDraft =
  | { readonly kind: 'ready'; readonly title: string; readonly description: string }
  | { readonly kind: 'not-yet'; readonly message: string };

export function requestDraft(form: RequestForm): RequestDraft {
  const description = form.description.trim();
  if (description === '') {
    return {
      kind: 'not-yet',
      message:
        'Say what you want changed. That sentence is the whole request — a title, scope, criteria and a ' +
        'category are not required, and the delivery contract comes after this.',
    };
  }
  const typed = form.title.trim();
  const title = typed === '' ? derivedRequestTitle(description) : typed.slice(0, MAXIMUM_TITLE_LENGTH);
  return { kind: 'ready', title, description };
}

/* -------------------------------------------------------------------------- */
/* The calls                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Creates the request from what the owner typed.
 *
 * Two members go out, `title` and `description`, and no third: the route's body is a `strictObject`
 * and would refuse anything else by name. A form that is not ready yet sends nothing at all, so
 * "not ready" can never be mistaken for a request that was created.
 */
export async function createRequestFromWords(
  scope: ProjectScope,
  form: RequestForm,
): Promise<MvpResult<RequestView>> {
  const draft = requestDraft(form);
  if (draft.kind === 'not-yet') return localRefusal(draft.message);
  return createRequest(scope, { title: draft.title, description: draft.description });
}

/**
 * Reads one request back with the contract state answering it.
 *
 * The screen calls this **after** a create instead of rendering the create response, for the same
 * reason every screen here re-reads after a write: the server is the authority, and the contract
 * state — which revision is approved, which is being edited — is only in this answer. Rendering the
 * `POST` body would leave the owner looking at a request whose contract state nobody has read yet
 * (mvp-spec 3, F24-AC2).
 */
export function readRequestDetail(
  scope: ProjectScope,
  requestId: string,
): Promise<MvpResult<RequestDetailView>> {
  return getRequest(scope, requestId);
}

/** Every request of this project, newest first — the list the picker offers. */
export function readProjectRequests(scope: ProjectScope): Promise<MvpResult<readonly RequestView[]>> {
  return listRequests(scope);
}

/* -------------------------------------------------------------------------- */
/* What the owner is told                                                       */
/* -------------------------------------------------------------------------- */

/** One fact about the request's contract state, in the server's own terms. */
export interface RequestProgressLine {
  readonly fact: string;
  readonly detail: string;
}

/**
 * Where this request stands, read off `RequestDetailView` and nothing else.
 *
 * Every number here is one the server sent: the revision, its `contentFingerprint`, its status. The
 * screen does not count revisions, decide which one "matters", or infer that an approved agreement
 * has gone stale — it reports what came back, so a stale or superseded revision is displayed rather
 * than hidden (mvp-spec 3, F24-AC2).
 *
 * The fingerprint is included because it is the identity of the approved *text*: showing revision 2
 * beside `fp_…` lets the owner see that the agreement they are looking at is the one that was sealed,
 * and it is the same value an approval or an edit must send back (mvp-spec 7).
 */
export function requestProgress(detail: RequestDetailView): readonly RequestProgressLine[] {
  const approved = detail.approvedRevision;
  const latest = detail.latestRevision;
  const lines: RequestProgressLine[] = [];

  if (approved !== null) {
    lines.push({
      fact: `Approved revision ${approved.revision}`,
      detail:
        `Content fingerprint ${approved.contentFingerprint}. This is the exact text that was agreed, and ` +
        'anything implemented against it is measured against this revision.',
    });
    // `answersCurrentRequest` is the server's *report*, published rather than acted on: the layer
    // refuses to decide that a request edit invalidates an agreement about that request, because that
    // is the owner's call about scope. So a `false` is shown here rather than treated as a
    // demotion — the owner decides whether the moved request still means the same work (mvp-spec 3).
    if (!approved.answersCurrentRequest) {
      lines.push({
        fact: 'The request has changed since this was approved',
        detail:
          `The server reports that revision ${approved.revision} no longer answers the request as it reads now. ` +
          'Revise the contract before treating the approval as covering the new request.',
      });
    }
    if (approved.blockedBecause !== null) {
      lines.push({
        fact: 'This approval cannot be measured against a candidate',
        detail: approved.blockedBecause,
      });
    }
  }

  if (latest !== null && latest.revision !== approved?.revision) {
    lines.push({
      fact:
        latest.status === 'draft'
          ? `Draft revision ${latest.revision}`
          : `Revision ${latest.revision} (${latest.status})`,
      detail:
        `Content fingerprint ${latest.contentFingerprint}. ` +
        (latest.status === 'draft'
          ? 'Nothing is agreed yet. Approve it before anything is implemented against it.'
          : 'This revision is kept for history and is not a current agreement.'),
    });
  }

  if (lines.length === 0) {
    lines.push({
      fact: 'No delivery contract yet',
      detail:
        'Write the outcome, the scope and the acceptance criteria on the contract screen. A request is ' +
        'capture; the contract is the agreement, and nothing can be handed off until one is approved.',
    });
  }

  return lines;
}
