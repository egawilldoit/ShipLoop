/**
 * The HTTP boundary for the MVP review and settings surfaces — TEMPORARY.
 *
 * **This module should be deleted and replaced by F1's browser client.** It exists only
 * because F1 owns the shared client in parallel and this branch does not have it yet. It
 * is deliberately one file with every `fetch` in it, so the replacement is a delete and an
 * import rewrite rather than a hunt: no component below `apps/web/src/ui/mvp/` calls `fetch`
 * or names a URL.
 *
 * What it does not do, on purpose:
 *
 *   - **No invented routes.** Every path here is one of the five the MVP namespace actually
 *     registers, and every path is project-scoped (`/api/projects/:projectId/...`). An
 *     unscoped spelling must never appear in this file; the historical defect this UI keeps
 *     being rebuilt after is a request for `/api/profiles/undefined` (F02-AC1, F02-AC4).
 *   - **No client-side judgement about the product.** This module reads refusals off the
 *     server's envelope and returns them. It does not decide whether a candidate is eligible,
 *     what an observation means, or whether a decision may be made; those are the server's
 *     (F23-AC1, F25-AC3).
 *   - **No invented verdict vocabulary.** A body here carries only what the route's own zod
 *     schema accepts. `POST .../verify` sends at most `{ method }` and never a result,
 *     because the browser is not allowed to state what a check concluded (F20-AC2).
 *
 * The wire types are imported from the server's own contract module with `import type`, so
 * they are erased at build time and never reach the browser bundle — `@shiploop/domain`
 * reaches for `node:crypto` and cannot be bundled — while a change to the server's view
 * still fails this application's type check instead of silently desynchronising (F24-AC2).
 */

import type {
  MvpOwnerTestReportView,
  MvpReviewCardView,
  MvpVerificationReportView,
  ProjectSettingsView,
  ReviewDecisionKind,
} from '../../server/contracts.ts';

/** Header carrying the derived CSRF token; the cookie itself is HttpOnly (F01-AC4). */
export const CSRF_HEADER = 'x-shiploop-csrf';

/* -------------------------------------------------------------------------- */
/* Results                                                                      */
/* -------------------------------------------------------------------------- */

/** One rejected field, carrying the path a form can attach the message to (F02-AC4). */
export interface MvpFieldError {
  readonly path: string;
  readonly message: string;
}

/** One unmet prerequisite a `Blocked` refusal named, with its remedy (F04-AC3). */
export interface MvpPrerequisite {
  readonly name: string;
  readonly detail: string;
  readonly remedy: string;
}

/** The domain's codes plus `Unauthorized`, which is a transport fact with no domain twin. */
export type MvpErrorCode =
  | 'Invalid'
  | 'NotFound'
  | 'Forbidden'
  | 'Conflict'
  | 'Blocked'
  | 'OutcomeUnknown'
  | 'RateLimited'
  | 'Unavailable'
  | 'Unauthorized';

const ERROR_CODES: ReadonlySet<string> = new Set<MvpErrorCode>([
  'Invalid',
  'NotFound',
  'Forbidden',
  'Conflict',
  'Blocked',
  'OutcomeUnknown',
  'RateLimited',
  'Unavailable',
  'Unauthorized',
]);

/**
 * What went wrong, in the terms a screen can act on.
 *
 * `reachable` is the member that keeps "disconnected" and "refused" apart, which the MVP
 * requires to be visibly different states: a refusal means the server read the request and
 * declined it, and `reachable: false` means nothing was heard at all. Collapsing them is how
 * a lost connection reads as a rejected decision (N03-AC1, N03-AC3).
 *
 * `expected` and `actual` are carried because a `Conflict` names them: the owner learns what
 * the submission was prepared against and what the server holds, which is the difference
 * between "try again" and "go and look at what changed" (F24-AC4).
 */
export interface MvpFailure {
  readonly code: MvpErrorCode;
  readonly reason: string;
  readonly fields: readonly MvpFieldError[];
  readonly prerequisites: readonly MvpPrerequisite[];
  readonly expected: string | null;
  readonly actual: string | null;
  readonly reachable: boolean;
}

export type MvpResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: MvpFailure };

/* -------------------------------------------------------------------------- */
/* Transport                                                                    */
/* -------------------------------------------------------------------------- */

let csrfToken: string | null = null;

/**
 * Forgets the derived token.
 *
 * Called when the server answers 401 and on sign-out. Keeping a token after the session that
 * authorised it is gone is exactly what F01-AC5 exists to prevent, and a client that keeps
 * retrying with a stale token reports every refusal as a transport failure.
 */
export function forgetCsrfToken(): void {
  csrfToken = null;
}

/**
 * The token for the next write, read from the session when this module has none.
 *
 * `GET /api/owner/session` returns a derived token precisely so a reloaded page can recover
 * one without a second sign-in, and that is the only way a browser can obtain it: the cookie
 * it belongs to is HttpOnly. F1's client owns this properly through the session layer; until
 * then it is fetched once and held here, so no component has to know a token exists.
 */
async function tokenForWrite(): Promise<string | MvpFailure> {
  if (csrfToken !== null) return csrfToken;
  const session = await request<{ readonly csrfToken?: unknown }>('/api/owner/session', {
    method: 'GET',
    csrf: false,
  });
  if (!session.ok) return session.error;
  const token = session.value.csrfToken;
  if (typeof token !== 'string' || token === '') {
    return failure(
      'Unauthorized',
      'This session has no request token. Sign in again before changing anything.',
      false,
    );
  }
  csrfToken = token;
  return token;
}

interface SendOptions {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly body?: unknown;
  /** True for every state-changing call: each one is behind the guard and behind CSRF. */
  readonly csrf: boolean;
}

function failure(code: MvpErrorCode, reason: string, reachable: boolean): MvpFailure {
  return { code, reason, fields: [], prerequisites: [], expected: null, actual: null, reachable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The refusal as `apps/web/src/server/http-error.ts` actually sends it.
 *
 * `{ error: { code, message, fields, prerequisites, expected, actual } }`. Every member is
 * read defensively so a malformed envelope still renders the message rather than vanishing,
 * which is what a bare `body.code` read would produce (N02-AC1, N03-AC3).
 */
function readRefusal(body: unknown): MvpFailure {
  const envelope = isRecord(body) && isRecord(body['error']) ? body['error'] : isRecord(body) ? body : null;
  const message =
    envelope !== null && typeof envelope['message'] === 'string'
      ? envelope['message']
      : envelope !== null && typeof envelope['reason'] === 'string'
        ? envelope['reason']
        : 'The server refused the request.';
  const rawCode = envelope === null ? undefined : (envelope['code'] ?? envelope['reason']);
  const code = typeof rawCode === 'string' && ERROR_CODES.has(rawCode) ? (rawCode as MvpErrorCode) : 'Unavailable';
  return {
    code,
    reason: message,
    fields: readFields(envelope),
    prerequisites: readPrerequisites(envelope),
    expected: readString(envelope, 'expected'),
    actual: readString(envelope, 'actual'),
    reachable: true,
  };
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  if (source === null) return null;
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readFields(source: Record<string, unknown> | null): readonly MvpFieldError[] {
  const raw = source === null ? undefined : source['fields'];
  if (!Array.isArray(raw)) return [];
  const fields: MvpFieldError[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const path = entry['path'];
    const message = entry['message'];
    if (typeof path === 'string' && typeof message === 'string') fields.push({ path, message });
  }
  return fields;
}

function readPrerequisites(source: Record<string, unknown> | null): readonly MvpPrerequisite[] {
  const raw = source === null ? undefined : source['prerequisites'];
  if (!Array.isArray(raw)) return [];
  const prerequisites: MvpPrerequisite[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = entry['name'];
    if (typeof name !== 'string') continue;
    const detail = entry['detail'];
    const remedy = entry['remedy'];
    prerequisites.push({
      name,
      detail: typeof detail === 'string' ? detail : '',
      remedy: typeof remedy === 'string' ? remedy : '',
    });
  }
  return prerequisites;
}

/**
 * One request, and the two ways it can fail kept apart.
 *
 * A `fetch` that rejects means the server was never reached, which is a different state
 * from a refusal and must not be reported as one: "the server could not be reached" tells
 * the owner their view stopped being current, while "the server refused" tells them the
 * request was understood (N03-AC1).
 */
async function request<T>(path: string, options: SendOptions): Promise<MvpResult<T>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.csrf) {
    const token = await tokenForWrite();
    if (typeof token !== 'string') return { ok: false, error: token };
    headers[CSRF_HEADER] = token;
  }

  const init: RequestInit = {
    method: options.method,
    headers,
    credentials: 'same-origin',
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    return { ok: false, error: failure('Unavailable', 'The server could not be reached.', false) };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, error: failure('Unavailable', 'The response could not be read.', true) };
  }

  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, error: failure('Unavailable', 'The server returned a response that was not valid JSON.', true) };
    }
  }

  if (response.ok) return { ok: true, value: parsed as T };

  const refusal = readRefusal(parsed);
  // A refused session clears the token: continuing to send a token the server will not
  // accept turns one clear 401 into an endless run of transport failures (F01-AC2).
  if (refusal.code === 'Unauthorized') forgetCsrfToken();
  return { ok: false, error: refusal };
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Project-scoped, always, and always escaped.
 *
 * The project value addresses an artifact root, a workspace and a git checkout downstream,
 * so it is percent-encoded per segment here rather than interpolated raw (F06-AC1). There is
 * no unscoped spelling anywhere in this file, and no default project id: the caller either
 * has one or renders that it has none (F02-AC1).
 */
function segment(value: string): string {
  return encodeURIComponent(value);
}

function candidateRoot(projectId: string, candidateId: string): string {
  return `/api/projects/${segment(projectId)}/candidates/${segment(candidateId)}`;
}

/* -------------------------------------------------------------------------- */
/* The review card                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The whole card for one candidate, read once.
 *
 * `GET /api/projects/:projectId/candidates/:candidateId/review`. Read rather than assembled
 * from two calls, because the card's criterion states, evidence rows and decision are
 * computed in one pass and a client that stitched them together from separate reads could
 * show a state the server would never return (F24-AC2).
 */
export function readReviewCard(projectId: string, candidateId: string): Promise<MvpResult<MvpReviewCardView>> {
  return request<{ readonly review: MvpReviewCardView }>(`${candidateRoot(projectId, candidateId)}/review`, {
    method: 'GET',
    csrf: false,
  }).then(unwrap('review'));
}

/**
 * Accept, or Request Changes, bound to the commit the page was rendered against.
 *
 * `POST .../decision` with `expectedHeadSha` and `expectedContractRevision` **required**. They
 * are what turn a decision taken from an outdated card into a `Conflict` instead of a
 * decision about whatever the candidate has become, so they are taken from the card on
 * screen at the moment of pressing, never from a value cached before it (F24-AC4, F25-AC3).
 *
 * The card the server answers with is returned unwrapped, but the screen still re-reads the
 * card afterwards rather than trusting it: the card is the authority, and a write response is
 * a state the client did not ask for as its next fact (F24-AC2).
 */
export function recordDecision(input: {
  readonly projectId: string;
  readonly candidateId: string;
  readonly decision: ReviewDecisionKind;
  readonly expectedHeadSha: string;
  readonly expectedContractRevision: number;
  readonly feedback: string | null;
}): Promise<MvpResult<MvpReviewCardView>> {
  return request<{ readonly review: MvpReviewCardView }>(
    `${candidateRoot(input.projectId, input.candidateId)}/decision`,
    {
      method: 'POST',
      csrf: true,
      body: {
        decision: input.decision,
        expectedHeadSha: input.expectedHeadSha,
        expectedContractRevision: input.expectedContractRevision,
        feedback: input.feedback,
      },
    },
  ).then(unwrap('review'));
}

/**
 * The owner's own result for one owner-test criterion.
 *
 * `POST .../candidates/:candidateId/criteria/:criterionId/owner-test` with `result` and an
 * optional `note`, and nothing else. There is deliberately no `ownerId`, no `observedAt` and
 * no `headSha` in the body: the owner is the proved session, the instant is the controller's
 * clock and the commit is the stored candidate's, so a request cannot attribute an observation
 * to somebody else, backdate it, or claim it for another build (F01-AC1, F25-AC4).
 *
 * The criterion is in the path because it is the thing the owner acted on, and the endpoint
 * refuses a criterion the contract does not declare `owner_test` — which is why the screen
 * offers these controls on owner tests and only on owner tests (F23-AC1).
 */
export function recordOwnerTest(input: {
  readonly projectId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly result: 'passed' | 'failed';
  readonly note: string | null;
}): Promise<MvpResult<MvpOwnerTestReportView>> {
  const path = `${candidateRoot(input.projectId, input.candidateId)}/criteria/${segment(input.criterionId)}/owner-test`;
  return request<{ readonly ownerTest: MvpOwnerTestReportView }>(path, {
    method: 'POST',
    csrf: true,
    body: { result: input.result, note: input.note },
  }).then(unwrap('ownerTest'));
}

/**
 * Ask the server to re-read the provider's checks.
 *
 * `POST .../verify` with at most `{ method }`. There is no `result`, `checkId` or `headSha` on
 * this body and none may be added: the server derives every verdict from the provider read,
 * and a member through which the browser could state a result is the defect this boundary
 * exists to prevent (F20-AC2, F23-AC1).
 *
 * A provider failure answers 503 and records nothing, so a caller must not read the absence
 * of new rows as "nothing failed" (F03-AC2).
 */
export function readProviderChecks(input: {
  readonly projectId: string;
  readonly candidateId: string;
}): Promise<MvpResult<MvpVerificationReportView>> {
  return request<{ readonly verification: MvpVerificationReportView }>(
    `${candidateRoot(input.projectId, input.candidateId)}/verify`,
    { method: 'POST', csrf: true, body: { method: 'github_checks' } },
  ).then(unwrap('verification'));
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Everything one project's settings currently hold.
 *
 * `GET /api/projects/:projectId/settings`. A project that has configured nothing answers 200
 * with `configured: false`, which is a state to render and not a failure — it is the state a
 * fresh MVP deployment is in (L02-AC3).
 */
export function readProjectSettings(projectId: string): Promise<MvpResult<ProjectSettingsView>> {
  return request<{ readonly settings: ProjectSettingsView }>(`/api/projects/${segment(projectId)}/settings`, {
    method: 'GET',
    csrf: false,
  }).then(unwrap('settings'));
}

/**
 * Saves or clears the T3 deployment URL.
 *
 * `PATCH /api/projects/:projectId/settings` with `{ t3Url }`, where `null` clears it and a
 * value is validated server-side: a malformed, non-http(s) or credential-bearing URL comes back
 * as a 422 naming a prerequisite and its remedy, with **no part of the value echoed** (L02-AC2).
 * The screen renders that refusal beside the field and keeps what the owner typed so it can be
 * corrected; it does not repeat the value back, because a value bad enough to be refused may
 * itself be the secret.
 */
export function writeProjectSettings(input: {
  readonly projectId: string;
  readonly t3Url: string | null;
}): Promise<MvpResult<ProjectSettingsView>> {
  return request<{ readonly settings: ProjectSettingsView }>(`/api/projects/${segment(input.projectId)}/settings`, {
    method: 'PATCH',
    csrf: true,
    body: { t3Url: input.t3Url },
  }).then(unwrap('settings'));
}

/* -------------------------------------------------------------------------- */
/* Envelope unwrapping                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Reads one member out of a `{ review }`, `{ ownerTest }`, `{ verification }` or `{ settings }`
 * envelope.
 *
 * The wrapper is named rather than assumed: a handler that answered the card without its
 * envelope would otherwise be read as an empty card, and an empty card renders as "nothing
 * outstanding", which is the one thing an empty card must never mean (F20-AC2, F24-AC2).
 */
function unwrap<K extends string, T>(key: K): (result: MvpResult<{ readonly [P in K]: T }>) => MvpResult<T> {
  return (result) => {
    if (!result.ok) return result;
    const envelope: unknown = result.value;
    const inner = isRecord(envelope) ? envelope[key] : undefined;
    if (inner === undefined) {
      return {
        ok: false,
        error: failure('Unavailable', `The server's answer did not carry "${key}", so there is nothing to show.`, true),
      };
    }
    // One cast at the wire boundary, where the value came off JSON and its shape is the
    // server's declared contract rather than anything proved at run time (F24-AC2).
    return { ok: true, value: inner as T };
  };
}
