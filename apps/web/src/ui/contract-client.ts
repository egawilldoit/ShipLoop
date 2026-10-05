/**
 * The HTTP boundary for the owner flow **New Request → Delivery Contract → Save Draft →
 * Approve → Prepare Implementation**.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE IS A PLACEHOLDER AND SHOULD BE REPLACED BY F1's CLIENT.
 * ---------------------------------------------------------------------------
 *
 * The owner flow's calls are collected here and nowhere else, so no component holds a
 * `fetch` or a URL string. F1 owns the browser client; when their module lands, the
 * functions below should move into it and this file should be deleted. Every function
 * here is one thin call over the same envelope handling F1's client already performs
 * (CSRF header, refusal envelope, connection state), so the move is a deletion rather
 * than a rewrite.
 *
 * ## Every route called here, and the handler that defines it
 *
 * All of them were read before being called. None is guessed, and no unscoped spelling
 * is used — every project-scoped route carries the project in the path, so a request and
 * its contract are always addressed as a pair (`server/routes/contracts.ts`).
 *
 * | Call | Route | Handler |
 * | --- | --- | --- |
 * | `fetchRequests` | `GET /api/projects/:projectId/requests` | `contracts.ts`, "The requests of this project, newest first" — answers `{ requests }` |
 * | `createRequest` | `POST /api/projects/:projectId/requests` | `contracts.ts` — 201 `{ request }`; body is a strict `{ title, description }` |
 * | `fetchRequestDetail` | `GET /api/projects/:projectId/requests/:requestId` | `contracts.ts` — answers `RequestDetailView` **unwrapped**, with `request`, `latestRevision`, `approvedRevision`, `revisions` |
 * | `updateRequest` | `PATCH /api/projects/:projectId/requests/:requestId` | `contracts.ts` — body requires `expectedUpdatedAt`; 409 when the instant moved |
 * | `fetchContractRevisions` (not called) | `GET /api/projects/:projectId/requests/:requestId/contracts` | `contracts.ts` — answers `{ contracts }`, oldest first |
 * | `draftContract` | `POST /api/projects/:projectId/requests/:requestId/contracts` | `contracts.ts` — 201 `{ contract }` |
 * | `fetchContractRevision` | `GET /api/projects/:projectId/contracts/:contractId/:revision` | `contracts.ts` — answers `{ contract }`; carries `contentFingerprint` and `updatedAt` |
 * | `saveContractDraft` | `PATCH /api/projects/:projectId/contracts/:contractId/:revision` | `contracts.ts` — body requires `expectedUpdatedAt`; an approved revision answers 400 |
 * | `approveContractRevision` | `POST /api/projects/:projectId/contracts/:contractId/:revision/approve` | `contracts.ts` — body is a strict `{ expectedContentFingerprint }` |
 * | `fetchVerificationChecks` | `GET /api/profiles/:projectId` | `profiles.ts` — answers `{ profile }`; `profile.content.policy.requiredChecks` is the project's configured check names |
 *
 * ### The one spelling outside `/api/projects/...`, and why it is not a defect
 *
 * `GET /api/profiles/:projectId` is the project's profile, and it carries the project in
 * its path — the property the transport rule actually protects (a body or a global
 * spelling would let a client read one project's configuration while believing it had
 * addressed another). The profiles route registers exactly this path in
 * `server/routes/profiles.ts`; there is no `/api/projects/:projectId/profile` to call
 * instead. It is also the only route in the tree that answers the project's *configured
 * check names*, which is what an automated criterion must bind to, so this flow cannot
 * do without it.
 *
 * ### Why a criterion binds a check *name*
 *
 * `criterion.verificationCheckId` is a check name from the project's profile policy —
 * `unit-tests`, `browser-e2e`, `typecheck` — not an opaque row id, so the same binding
 * survives every re-run. The choice list is read from the project's own configuration
 * rather than hard-coded here: a hard-coded list would let a criterion bind to a check
 * this project never runs, which is the defect `verificationCheckId` exists to prevent
 * (F23-AC1, F24-AC3). See `contract-draft.ts` for how the list is merged with a binding
 * that a profile edit has since dropped.
 *
 * ### The approval compare-and-set token
 *
 * `approveContractRevision` takes the `contentFingerprint` of the revision **read** and
 * sends it back unchanged. It is a required, `strictObject` body: a body without it is
 * `400`, and a body carrying an extra member (`approvedBy`, `status`) is refused by name
 * rather than ignored, because no request can attribute an approval to somebody else —
 * the approver is read from the proved session. A mismatch is `409 Conflict` and the
 * response carries both `expected` and `actual`, which this client reads so the owner can
 * be told what is stored now without guessing.
 */

import {
  CSRF_HEADER,
  type ApiErrorCode,
  type ApiFailure,
  type ApiFieldError,
  getCsrfToken,
} from './api-client.ts';

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Who settles one criterion, and the check that settles it.
 *
 * `verificationCheckId` is a **check name**, always explicit rather than optional: the
 * route turns an omitted binding into `null` before it reaches the controller, so no
 * caller has to ask whether the key was absent. `null` on an `automated` criterion means
 * nothing is bound, and approval refuses it by naming
 * `acceptanceCriteria.<id>.verificationCheckId` (F23-AC1).
 */
export interface ContractCriterionView {
  readonly id: string;
  readonly description: string;
  readonly verificationType: 'automated' | 'owner_test';
  readonly verificationCheckId: string | null;
}

/** One revision of a delivery contract, as `server/contracts.ts` defines it. */
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
  /** The identity an approval must name, because an approval seals text (mvp-spec 3). */
  readonly contentFingerprint: string;
  readonly requestFingerprint: string;
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
  readonly blockedBecause: string | null;
}

/** One request, as `server/contracts.ts` defines it. */
export interface RequestView {
  readonly requestId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly sourceIdeaId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One request and the contract state that answers it.
 *
 * The detail rather than the bare request: an owner opening a request needs to know which
 * revision is approved and which is being edited, and two round trips for that leaves a
 * window in which the two answers describe different moments (mvp-spec 3).
 */
export interface RequestDetailView {
  readonly request: RequestView;
  readonly latestRevision: ContractView | null;
  readonly approvedRevision: ContractView | null;
  readonly revisions: readonly ContractView[];
}

/**
 * What the project's profile says about verification.
 *
 * A discriminated union rather than a list plus a flag, because "this project configured
 * no checks" and "I could not read its configuration" are different facts and must not
 * read alike: the first is something the owner can act on in Settings, the second is a
 * read that failed. Collapsing them would either hide a failed read behind an empty
 * picker or tell an owner to go fix a configuration that is actually fine.
 */
export type VerificationCheckChoices =
  | { readonly kind: 'configured'; readonly checks: readonly string[] }
  | { readonly kind: 'none-configured' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** A contract body, on draft, on save and on approve alike — the route uses one schema. */
export interface ContractContentInput {
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly {
    readonly id: string;
    readonly description: string;
    readonly verificationType: 'automated' | 'owner_test';
    readonly verificationCheckId: string | null;
  }[];
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A refusal that also carries the two instants a conflict is about.
 *
 * The server answers a `Conflict` with `{ error: { code, message, expected, actual } }`
 * (`server/http-error.ts`), and `ApiFailure` has no place for those two. They are the
 * difference between "this changed" and "this is what changed", so the flow carries them
 * rather than re-deriving anything from the message text.
 */
export interface ContractApiFailure extends ApiFailure {
  readonly expected: string | null;
  readonly actual: string | null;
}

export type ContractResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ContractApiFailure };

interface SendOptions {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly csrf: boolean;
  readonly body?: unknown;
}

const API_ERROR_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
  'Blocked',
  'Conflict',
  'OutcomeUnknown',
  'Invalid',
  'NotFound',
  'Forbidden',
  'RateLimited',
  'Unavailable',
  'Unauthorized',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isApiErrorCode(value: string): value is ApiErrorCode {
  return API_ERROR_CODES.has(value);
}

/**
 * Per-field messages, read defensively.
 *
 * A field whose `message` is missing is dropped rather than rendered blank, because an
 * input marked invalid with no explanation is worse than one not marked at all: it claims
 * the server objected without saying what to change (F02-AC4).
 */
function readFields(source: Record<string, unknown>): readonly ApiFieldError[] {
  const raw: unknown = source['fields'];
  if (!Array.isArray(raw)) return [];
  const fields: ApiFieldError[] = [];
  for (const entry of raw as readonly unknown[]) {
    if (!isRecord(entry)) continue;
    const path = entry['path'];
    const message = entry['message'];
    if (typeof path === 'string' && typeof message === 'string') fields.push({ path, message });
  }
  return fields;
}

/** The unmet prerequisites of a `Blocked` refusal, with what to do about them (F04-AC3). */
function readPrerequisites(source: Record<string, unknown>): readonly ApiFailure['prerequisites'][number][] {
  const raw: unknown = source['prerequisites'];
  if (!Array.isArray(raw)) return [];
  const prerequisites: ApiFailure['prerequisites'][number][] = [];
  for (const entry of raw as readonly unknown[]) {
    if (!isRecord(entry)) continue;
    const name = entry['name'];
    if (typeof name !== 'string') continue;
    prerequisites.push({
      name,
      detail: typeof entry['detail'] === 'string' ? entry['detail'] : '',
      remedy: typeof entry['remedy'] === 'string' ? entry['remedy'] : '',
    });
  }
  return prerequisites;
}

/**
 * The refusal, read out of the envelope the server actually sends.
 *
 * `problem()` nests everything under `error`, so reading a bare `code` off the top level
 * finds neither it nor a message and would report every refusal as an unreachable server.
 * The bare form is kept as a fallback so a proxy or a future shape does not turn a
 * refusal into a transport failure.
 */
function readRefusal(body: unknown, status: number): ContractApiFailure {
  const envelope = isRecord(body) && isRecord(body['error']) ? body['error'] : null;
  const source = envelope ?? (isRecord(body) ? body : {});
  const message =
    readString(source['message']) ??
    readString(source['reason']) ??
    `The server refused the request (${status}).`;
  const rawCode = source['code'] ?? source['reason'];
  // A code outside the vocabulary is not guessed at. It reads as `Unavailable` — "this
  // refusal is not one I can act on" — rather than being widened to the nearest known
  // code, because a misread code would send the owner down the wrong remedy (N03-AC3).
  const code: ApiErrorCode =
    typeof rawCode === 'string' && isApiErrorCode(rawCode) ? rawCode : 'Unavailable';
  return {
    code,
    reason: message,
    fields: readFields(source),
    prerequisites: readPrerequisites(source),
    expected: readString(source['expected']),
    actual: readString(source['actual']),
  };
}

function failure(code: ApiErrorCode, reason: string): ContractResult<never> {
  return { ok: false, error: { code, reason, fields: [], prerequisites: [], expected: null, actual: null } };
}

function contractRequest<T>(path: string, options: SendOptions): Promise<ContractResult<T>> {
  return send(path, options).then(async (outcome) => {
    if (outcome.kind === 'offline') return failure('Unavailable', 'The server could not be reached.');
    const { response } = outcome;
    let text: string;
    try {
      text = await response.text();
    } catch {
      return failure('Unavailable', 'The response could not be read.');
    }
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        return failure('Unavailable', 'The server returned a response that was not valid JSON.');
      }
    }
    if (response.ok) return { ok: true, value: parsed as T };
    // A refusal is an answer, not a lost connection: the server received the request and
    // declined it, so marking the connection down here would tell the owner their view had
    // stopped being current when it is the contract that was refused (N03-AC1).
    return { ok: false, error: readRefusal(parsed, response.status) };
  });
}

type SendOutcome = { readonly kind: 'response'; readonly response: Response } | { readonly kind: 'offline' };

async function send(path: string, options: SendOptions): Promise<SendOutcome> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.csrf) {
    const token = getCsrfToken();
    if (token === null) return { kind: 'offline' };
    headers[CSRF_HEADER] = token;
  }
  const init: RequestInit = { method: options.method, headers, credentials: 'same-origin' };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  try {
    return { kind: 'response', response: await fetch(path, init) };
  } catch {
    return { kind: 'offline' };
  }
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

function projectsRoot(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

/** The requests of this project, newest first (mvp-spec 3). */
export function fetchRequests(projectId: string): Promise<ContractResult<{ readonly requests: readonly RequestView[] }>> {
  return contractRequest(`${projectsRoot(projectId)}/requests`, { method: 'GET', csrf: false });
}

/**
 * Creates a request in this project.
 *
 * 201 with the created record, and no engine is consulted: creating a request must work on
 * a deployment that has configured none. The 201/200 distinction matters to a client — a
 * request this call created and one that already existed are different outcomes.
 */
export function createRequest(
  projectId: string,
  input: { readonly title: string; readonly description: string },
): Promise<ContractResult<{ readonly request: RequestView }>> {
  return contractRequest(`${projectsRoot(projectId)}/requests`, { method: 'POST', csrf: true, body: input });
}

/** One request with its contract state, answered unwrapped as `RequestDetailView`. */
export function fetchRequestDetail(projectId: string, requestId: string): Promise<ContractResult<RequestDetailView>> {
  return contractRequest(
    `${projectsRoot(projectId)}/requests/${encodeURIComponent(requestId)}`,
    { method: 'GET', csrf: false },
  );
}

/**
 * Edits a request draft.
 *
 * `expectedUpdatedAt` is required by the route, so a stale editor is a 409 rather than a
 * silent overwrite of text somebody else has since replaced (F02-AC2, F24-AC4).
 */
export function updateRequest(
  projectId: string,
  requestId: string,
  input: { readonly title?: string; readonly description?: string; readonly expectedUpdatedAt: string },
): Promise<ContractResult<{ readonly request: RequestView }>> {
  return contractRequest(`${projectsRoot(projectId)}/requests/${encodeURIComponent(requestId)}`, {
    method: 'PATCH',
    csrf: true,
    body: input,
  });
}

/**
 * Every revision of this request, oldest first (mvp-spec 3).
 *
 * Deliberately not called by this flow. `GET /api/projects/:projectId/requests/:requestId`
 * already answers `revisions` alongside `latestRevision` and `approvedRevision`, so a second
 * read for the same history would be a round trip whose two answers could describe different
 * moments — and the page needs the detail anyway. It is here because it is a real route in the
 * same namespace and its shape was read while establishing the transport; delete it with the
 * rest of this module when F1's client lands.
 */
export function fetchContractRevisions(
  projectId: string,
  requestId: string,
): Promise<ContractResult<{ readonly contracts: readonly ContractView[] }>> {
  return contractRequest(`${projectsRoot(projectId)}/requests/${encodeURIComponent(requestId)}/contracts`, {
    method: 'GET',
    csrf: false,
  });
}

/** Drafts revision 1 of this request's delivery contract (mvp-spec 3). */
export function draftContract(
  projectId: string,
  requestId: string,
  content: ContractContentInput,
): Promise<ContractResult<{ readonly contract: ContractView }>> {
  return contractRequest(`${projectsRoot(projectId)}/requests/${encodeURIComponent(requestId)}/contracts`, {
    method: 'POST',
    csrf: true,
    body: content,
  });
}

/**
 * One revision, addressed by its own number.
 *
 * This is the read an approval is measured against: its `contentFingerprint` is the token
 * `approveContractRevision` sends back, and its `updatedAt` is the token a draft save
 * sends back. Both are read here rather than taken from a list, so the compare-and-set
 * token provably describes the text that was rendered.
 */
export function fetchContractRevision(
  projectId: string,
  contractId: string,
  revision: number,
): Promise<ContractResult<{ readonly contract: ContractView }>> {
  return contractRequest(`${projectsRoot(projectId)}/contracts/${encodeURIComponent(contractId)}/${revision}`, {
    method: 'GET',
    csrf: false,
  });
}

/**
 * Edits a draft revision in place.
 *
 * `expectedUpdatedAt` is required; an approved revision answers 400 here, because an
 * approved contract must never silently mutate — a material change is a new revision.
 */
export function saveContractDraft(
  projectId: string,
  contractId: string,
  revision: number,
  content: ContractContentInput & { readonly expectedUpdatedAt: string },
): Promise<ContractResult<{ readonly contract: ContractView }>> {
  return contractRequest(`${projectsRoot(projectId)}/contracts/${encodeURIComponent(contractId)}/${revision}`, {
    method: 'PATCH',
    csrf: true,
    body: content,
  });
}

/**
 * Approves this revision, naming the text it approves.
 *
 * The body has exactly one member, `expectedContentFingerprint`, and it is the
 * `contentFingerprint` the read returned. An approval is a statement about text: two tabs
 * on one draft both address `contracts/:id/1`, so the fingerprint is the only thing that
 * separates "I approve what I read" from "I approve what somebody else wrote", and nothing
 * afterwards could detect the difference because a frozen revision reports itself as
 * approved. Required, so a body without it is `400`; stale, so a mismatch is `409` with
 * both `expected` and `actual` in the refusal (mvp-spec 3, mvp-spec 7, F24-AC4).
 *
 * `approvedBy` and `status` are deliberately absent and the schema is strict, so a client
 * that tried to send them would be refused by name rather than having them ignored — no
 * request can attribute an approval to somebody else.
 */
export function approveContractRevision(
  projectId: string,
  contractId: string,
  revision: number,
  expectedContentFingerprint: string,
): Promise<ContractResult<{ readonly contract: ContractView }>> {
  return contractRequest(`${projectsRoot(projectId)}/contracts/${encodeURIComponent(contractId)}/${revision}/approve`, {
    method: 'POST',
    csrf: true,
    body: { expectedContentFingerprint },
  });
}

/**
 * The project's configured check names, read from its profile policy.
 *
 * `GET /api/profiles/:projectId` answers `{ profile }`, and `profile.content.policy.requiredChecks`
 * is the list of check names the project runs. The domain uses the same vocabulary for a
 * criterion's `verificationCheckId`, which is why these are the choices an automated
 * criterion may bind to.
 *
 * A project with no saved profile is a 404 (`profiles.ts` answers `notFound` when
 * `currentVersion` is null), and that is reported as `none-configured` rather than as an
 * error: a fresh MVP deployment has no profile, and that is a state the owner can act on,
 * not a failed read. Any other refusal is `unreadable`, because offering an empty picker
 * after a failed read would tell the owner this project runs no checks when in fact the
 * list is unknown.
 */
export async function fetchVerificationChecks(projectId: string): Promise<VerificationCheckChoices> {
  const result = await contractRequest<{ readonly profile?: unknown }>(
    `/api/profiles/${encodeURIComponent(projectId)}`,
    { method: 'GET', csrf: false },
  );
  if (!result.ok) {
    if (result.error.code === 'NotFound') return { kind: 'none-configured' };
    return { kind: 'unreadable', reason: result.error.reason };
  }
  const profile = result.value.profile;
  if (!isRecord(profile)) return { kind: 'unreadable', reason: 'The project profile carried no profile to read checks from.' };
  const content = profile['content'];
  if (!isRecord(content)) return { kind: 'unreadable', reason: 'The project profile carried no content, so it names no checks.' };
  const policy = content['policy'];
  if (!isRecord(policy)) return { kind: 'unreadable', reason: 'The project profile named no policy, so it names no checks.' };
  const raw: unknown = policy['requiredChecks'];
  if (!Array.isArray(raw)) return { kind: 'none-configured' };
  const checks: string[] = [];
  for (const entry of raw as readonly unknown[]) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    // Duplicates would render two identical options and read as two distinct checks; a
    // blank name binds nothing and is refused by the route's own schema.
    if (name !== '' && !checks.includes(name)) checks.push(name);
  }
  return { kind: 'configured', checks };
}