/**
 * The one transport every MVP client call goes through.
 *
 * This module owns `fetch`, the CSRF header, the credential mode, the refusal envelope and the
 * connection state. No page, component or other client module calls `fetch` directly, which is
 * the property this file exists to guarantee: the previous wave built a complete UI whose
 * endpoints did not exist, and one reason nothing caught it is that URL strings were scattered
 * through components where no single review could see them (mvp-spec 3, F02-AC4).
 *
 * Three rules are enforced here rather than at each call site:
 *
 *   - **A path is built only by `projectPath` and its two siblings**, so every project-scoped
 *     URL is `/api/projects/<projectId>/…`. There is no way for a caller to assemble an
 *     unscoped spelling such as `/api/requests` or `/api/contracts/:id`, because those
 *     templates do not exist in this module and `projectPath` is the only thing that
 *     interpolates a project (F02-AC2).
 *   - **A refusal is a value, not a throw**, and it carries the code, the field errors and the
 *     unmet prerequisites the server sent. `Conflict` is a first-class member rather than a
 *     generic failure, because a 409 from an approval means the contract changed under the
 *     owner and the page has to offer a reload — which is a different screen from an
 *     unreachable server (mvp-spec 7, F24-AC4).
 *   - **A CSRF token is required for every state-changing call and its absence is reported as a
 *     `Forbidden` refusal**, not swallowed into "the server could not be reached". The header is
 *     what the guard reads, and the cookie is HttpOnly, so a page cannot obtain the token any
 *     other way (F01-AC4).
 *
 * The connection signal is published here rather than per page because "this view may no longer
 * be current" is a fact about the transport, and a page that re-derived it would disagree with
 * the banner (N03-AC1, N03-AC3).
 */

import { CSRF_HEADER } from '../api-client.ts';
import type { ProjectScope } from './types.ts';

/* -------------------------------------------------------------------------- */
/* Failure                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The refusal codes this server produces, plus the two the transport itself raises.
 *
 * `Unauthorized` and `Disconnected` have no domain equivalent: the first is the signal that the
 * app must return to sign-in, and the second means no response was ever received, which is a
 * different fact from any server refusal (F01-AC2, N03-AC1). `NoProjectSelected` is a client-side
 * refusal, raised before any request goes out, so an unselected project can never become a path
 * (F02-AC1, F02-AC4).
 */
export type MvpFailureCode =
  | 'Invalid'
  | 'Unauthorized'
  | 'Forbidden'
  | 'NotFound'
  | 'Conflict'
  | 'Blocked'
  | 'OutcomeUnknown'
  | 'RateLimited'
  | 'Unavailable'
  | 'InternalError'
  | 'Disconnected'
  | 'NoProjectSelected'
  | 'MalformedResponse';

/** One rejected field, with the form path its message belongs next to (F02-AC4, N03-AC3). */
export interface MvpFieldError {
  readonly path: string;
  readonly message: string;
}

/** One unmet prerequisite with its remedy — carried so `Blocked` is actionable (F04-AC3, F25-AC1). */
export interface MvpPrerequisite {
  readonly name: string;
  readonly detail: string;
  readonly remedy: string;
}

/**
 * A refusal, as a value.
 *
 * `expected` and `actual` are carried for `Conflict` only, and they are the whole point of
 * distinguishing it: the approval route answers a fingerprint mismatch with the fingerprint that
 * was asked for and the one now stored, and the review route answers a superseded decision with
 * the commit prepared against and the one on screen. A page can therefore say what moved and
 * offer a reload, rather than reporting a generic failure and leaving the owner at a dead end
 * (mvp-spec 7, F24-AC4, F25-AC3).
 */
export interface MvpFailure {
  readonly code: MvpFailureCode;
  readonly reason: string;
  /** The HTTP status, or 0 when no request completed. */
  readonly status: number;
  readonly fields: readonly MvpFieldError[];
  readonly prerequisites: readonly MvpPrerequisite[];
  /** What the submission was prepared against, on a `Conflict`. Null otherwise. */
  readonly expected: string | null;
  /** What is current now, on a `Conflict`. Null otherwise. */
  readonly actual: string | null;
}

/** What every client call returns: the value, or the refusal to render. */
export type MvpResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: MvpFailure };

export function succeeded<T>(value: T): MvpResult<T> {
  return { ok: true, value };
}

export function failed<T>(failure: MvpFailure): MvpResult<T> {
  return { ok: false, failure };
}

/* -------------------------------------------------------------------------- */
/* Connection state                                                            */
/* -------------------------------------------------------------------------- */

/** Transport health, so a stale view and a dead one are visibly different (N03-AC1). */
export interface MvpConnectionState {
  readonly connected: boolean;
  readonly lastSuccessAt: string | null;
  readonly lastFailureReason: string | null;
}

const INITIAL_CONNECTION: MvpConnectionState = {
  connected: true,
  lastSuccessAt: null,
  lastFailureReason: null,
};

let connection: MvpConnectionState = INITIAL_CONNECTION;
const connectionListeners = new Set<(state: MvpConnectionState) => void>();

export function subscribeToMvpConnection(listener: (state: MvpConnectionState) => void): () => void {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}

export function getMvpConnectionState(): MvpConnectionState {
  return connection;
}

function publishConnection(next: MvpConnectionState): void {
  connection = next;
  for (const listener of connectionListeners) listener(next);
}

function noteReachable(): void {
  publishConnection({
    connected: true,
    lastSuccessAt: new Date().toISOString(),
    lastFailureReason: null,
  });
}

function noteUnreachable(reason: string): void {
  publishConnection({
    connected: false,
    lastSuccessAt: connection.lastSuccessAt,
    lastFailureReason: reason,
  });
}

/* -------------------------------------------------------------------------- */
/* CSRF token                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The session's derived token, held here rather than in a page.
 *
 * Kept in this module so the value has exactly one owner: a page that could set it could clear
 * it without clearing the session, and sign-out has to invalidate both (F01-AC2, F01-AC5). The
 * session layer sets it from `GET /api/owner/session` or the sign-in response; nothing else
 * writes it.
 */
let csrfToken: string | null = null;

export function setMvpCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getMvpCsrfToken(): string | null {
  return csrfToken;
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Encodes one path segment, refusing anything that would address outside the segment.
 *
 * `encodeURIComponent` alone is not enough: it leaves `.` alone, so `..` would survive and a
 * project id that reached a path as `..` would be a traversal on the server side. Every project
 * id addresses an artifact root, a workspace and a git checkout downstream, so this refuses the
 * two shapes the server's own schema refuses — a path separator and `..` — before they reach a
 * URL (F06-AC1).
 */
function segment(value: string): string {
  const encoded = encodeURIComponent(value);
  if (encoded === '.' || encoded === '..' || value.includes('/') || value.includes('\\')) {
    throw new Error('A path segment may not be empty, ".", ".." or contain a separator.');
  }
  return encoded;
}

/**
 * The prefix every project-scoped route carries, or null when no project is selected.
 *
 * Returning null rather than a path with an empty or `undefined` project is the structural fix
 * for the defect this file exists in part to prevent: the client used to build
 * `/api/profiles/undefined`, the server honestly answered "no such project", and the page
 * reported that as "that project has no saved profile yet" — a different and wrong claim about a
 * project's contents (F02-AC1, F02-AC4).
 */
function projectPath(scope: ProjectScope): string | null {
  if (scope.kind === 'no-project-selected') return null;
  return `/api/projects/${segment(scope.projectId)}`;
}

/** The refusal an unselected project produces, naming how many projects there are to choose from. */
function noProjectFailure<T>(scope: ProjectScope): MvpResult<T> {
  if (scope.kind === 'project') {
    throw new Error('A selected scope must not produce a no-project refusal.');
  }
  return failed({
    code: 'NoProjectSelected',
    reason:
      scope.selectableProjectCount === 0
        ? 'No project is selected, and this account has no project to choose from yet. Create one before opening this screen.'
        : `No project is selected. Choose one of ${scope.selectableProjectCount} to continue.`,
    status: 0,
    fields: [],
    prerequisites: [],
    expected: null,
    actual: null,
  });
}

/** Builds a project-scoped path, or produces the no-project refusal. */
function scoped<T>(scope: ProjectScope, suffix: string): string | MvpResult<T> {
  const prefix = projectPath(scope);
  if (prefix === null) return noProjectFailure<T>(scope);
  return `${prefix}${suffix}`;
}

/**
 * Builds the one path outside the `/api/projects/:projectId/…` namespace.
 *
 * `GET /api/profiles/:projectId` predates the MVP namespace and is the only route in this
 * client's scope that lives under `/api/profiles`. It is still reached through a `ProjectScope`
 * rather than a bare id, so the project identity comes from the session in exactly one way and a
 * page cannot pass its own (F02-AC1, F02-AC2).
 */
function profileScoped<T>(scope: ProjectScope, suffix: string): string | MvpResult<T> {
  if (scope.kind === 'no-project-selected') return noProjectFailure<T>(scope);
  return `/api/profiles/${segment(scope.projectId)}${suffix}`;
}

/** Narrows the helper above at each call site without a cast in the return position. */
function isFailure<T>(value: string | MvpResult<T>): value is MvpResult<T> {
  return typeof value !== 'string';
}

/* -------------------------------------------------------------------------- */
/* Request                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How a refusal maps to a code.
 *
 * Read off the envelope the server actually sends (`{ error: { code, message, … } }`, per
 * `apps/web/src/server/http-error.ts`) rather than from a bare top-level `code`, and a status
 * fallback covers a proxy or a future shape. `InternalError` and `MalformedResponse` are members
 * because a 500 is not a provider failure and a truncated body is not a refusal, and collapsing
 * either into `Unavailable` would tell the owner their project could not be read when in fact the
 * request arrived and was mishandled (N02-AC1, N03-AC3).
 */
const STATUS_CODES: Readonly<Record<number, MvpFailureCode>> = {
  202: 'OutcomeUnknown',
  400: 'Invalid',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'NotFound',
  409: 'Conflict',
  413: 'Invalid',
  415: 'Invalid',
  422: 'Blocked',
  429: 'RateLimited',
  500: 'InternalError',
  503: 'Unavailable',
};

const KNOWN_CODES: ReadonlySet<string> = new Set<MvpFailureCode>([
  'Invalid',
  'Unauthorized',
  'Forbidden',
  'NotFound',
  'Conflict',
  'Blocked',
  'OutcomeUnknown',
  'RateLimited',
  'Unavailable',
  'InternalError',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readCode(source: Record<string, unknown>, status: number): MvpFailureCode {
  const raw = source['code'];
  if (typeof raw === 'string' && KNOWN_CODES.has(raw)) return raw as MvpFailureCode;
  return STATUS_CODES[status] ?? 'Unavailable';
}

function readFields(source: Record<string, unknown>): readonly MvpFieldError[] {
  const raw: unknown = source['fields'];
  if (!Array.isArray(raw)) return [];
  const fields: MvpFieldError[] = [];
  for (const entry of raw as readonly unknown[]) {
    if (!isRecord(entry)) continue;
    const path = entry['path'];
    const message = entry['message'];
    if (typeof path === 'string' && typeof message === 'string') fields.push({ path, message });
  }
  return fields;
}

function readPrerequisites(source: Record<string, unknown>): readonly MvpPrerequisite[] {
  const raw: unknown = source['prerequisites'];
  if (!Array.isArray(raw)) return [];
  const prerequisites: MvpPrerequisite[] = [];
  for (const entry of raw as readonly unknown[]) {
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

function readOptionalString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/** The refusal this response is, read out of the envelope it actually carries. */
export function readRefusal(body: unknown, status: number): MvpFailure {
  const envelope = isRecord(body) && isRecord(body['error']) ? body['error'] : null;
  const source = envelope ?? (isRecord(body) ? body : null);
  if (source === null) {
    return {
      code: STATUS_CODES[status] ?? 'Unavailable',
      reason: `The server refused the request (${status}) without saying why.`,
      status,
      fields: [],
      prerequisites: [],
      expected: null,
      actual: null,
    };
  }
  const message = source['message'];
  const reason = source['reason'];
  return {
    code: readCode(source, status),
    reason:
      typeof message === 'string' && message !== ''
        ? message
        : typeof reason === 'string' && reason !== ''
          ? reason
          : `The server refused the request (${status}).`,
    status,
    fields: readFields(source),
    prerequisites: readPrerequisites(source),
    expected: readOptionalString(source, 'expected'),
    actual: readOptionalString(source, 'actual'),
  };
}

function disconnected(reason: string): MvpFailure {
  return {
    code: 'Disconnected',
    reason,
    status: 0,
    fields: [],
    prerequisites: [],
    expected: null,
    actual: null,
  };
}

export interface MvpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  readonly path: string;
  /**
   * The JSON body, or `undefined` for a call that submits nothing.
   *
   * `undefined` and an empty object are different on the wire, and two of this server's routes
   * care: `POST .../refresh` and `POST .../verify` accept an absent body and refuse a body
   * carrying a key that would mean the client chose the result, so a client that always sent `{}`
   * would be sending a body where the server expects none (F20-AC2).
   */
  readonly body?: unknown;
}

/**
 * Performs one request and reads the answer as a value.
 *
 * No call site ever sees a thrown network error: a `fetch` rejection is a `Disconnected` refusal
 * and an unreadable body is a `MalformedResponse` refusal, so "the server said no" and "the server
 * was never reached" stay distinguishable without a try/catch at every page (N03-AC1, N03-AC3).
 *
 * A server refusal does **not** mark the connection down. It is an answer, and telling the owner
 * their view had stopped being current when the server received the request and declined it is
 * the confusion the banner exists to prevent (N03-AC3).
 */
export async function send<T>(request: MvpRequest): Promise<MvpResult<T>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = { method: request.method, headers, credentials: 'same-origin' };

  if (request.method !== 'GET') {
    const token = csrfToken;
    if (token === null) {
      // Reported rather than attempted: the guard would refuse it as `Forbidden` with a message
      // about a missing token, and a page rendering that as a server problem would be wrong
      // about who is at fault (F01-AC4).
      noteUnreachable('This session has no request token. Sign in again.');
      return failed<T>({
        code: 'Forbidden',
        reason: 'This session has no forgery-protection token, so nothing was changed. Reload the page and sign in again.',
        status: 0,
        fields: [],
        prerequisites: [],
        expected: null,
        actual: null,
      });
    }
    headers[CSRF_HEADER] = token;
  }

  if (request.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(request.body);
  }

  let response: Response;
  try {
    response = await fetch(request.path, init);
  } catch {
    noteUnreachable('The server could not be reached.');
    return failed(disconnected('The server could not be reached, so nothing was changed.'));
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    noteUnreachable('The server response could not be read.');
    return failed(disconnected('The server answered but the response could not be read, so nothing was changed.'));
  }

  let parsed: unknown = null;
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return failed({
        code: 'MalformedResponse',
        reason: 'The server returned a response that was not valid JSON.',
        status: response.status,
        fields: [],
        prerequisites: [],
        expected: null,
        actual: null,
      });
    }
  }

  if (!response.ok) {
    return failed(readRefusal(parsed, response.status));
  }

  noteReachable();
  return succeeded(parsed as T);
}

/* -------------------------------------------------------------------------- */
/* Envelope readers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Reads one named member out of a response body.
 *
 * Every route in this client's scope answers `{ <singular>: <value> }`, so this is the single
 * place that knowledge lives. It refuses rather than casting: a route that stopped wrapping its
 * payload would otherwise hand a page an `undefined` it would render as an empty list, which is
 * the "empty board that reads as a fact about the project" failure in a different costume
 * (mvp-spec 3).
 */
export function envelope<T>(body: unknown, key: string, path: string): MvpResult<T> {
  if (!isRecord(body)) {
    return failed({
      code: 'MalformedResponse',
      reason: `The server answered ${path} with a body that was not an object, so nothing could be read from it.`,
      status: 200,
      fields: [],
      prerequisites: [],
      expected: null,
      actual: null,
    });
  }
  const value = body[key];
  if (value === undefined) {
    return failed({
      code: 'MalformedResponse',
      reason: `The server answered ${path} without a "${key}", so nothing could be read from it.`,
      status: 200,
      fields: [],
      prerequisites: [],
      expected: null,
      actual: null,
    });
  }
  return succeeded(value as T);
}

/**
 * Runs a project-scoped call whose path depends on the scope, or produces the no-project refusal.
 *
 * Exported so the per-resource clients in `client.ts` build their paths here and nowhere else.
 */
export async function scopedGet<T>(scope: ProjectScope, suffix: string): Promise<MvpResult<T>> {
  const path = scoped<T>(scope, suffix);
  if (isFailure<T>(path)) return path;
  return send<T>({ method: 'GET', path });
}

export async function scopedSend<T>(
  scope: ProjectScope,
  method: 'POST' | 'PUT' | 'PATCH',
  suffix: string,
  body?: unknown,
): Promise<MvpResult<T>> {
  const path = scoped<T>(scope, suffix);
  if (isFailure<T>(path)) return path;
  return send<T>(body === undefined ? { method, path } : { method, path, body });
}

/** `GET /api/profiles/:projectId…`, the one route outside the `/api/projects` namespace. */
export async function profileScopedGet<T>(scope: ProjectScope, suffix: string): Promise<MvpResult<T>> {
  const path = profileScoped<T>(scope, suffix);
  if (isFailure<T>(path)) return path;
  return send<T>({ method: 'GET', path });
}

/**
 * Encodes an identifier for use inside a project-scoped suffix.
 *
 * Exported because a request id, a contract id and a candidate id all land in a suffix built by
 * the per-resource clients, and the traversal refusal in `segment` has to apply to every one of
 * them rather than only to the project id (F06-AC1).
 */
export function idSegment(value: string): string {
  return segment(value);
}

/** Encodes a positive revision number for the `:revision` path position. */
export function revisionSegment(revision: number): string {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error('A revision number starts at 1.');
  }
  return String(revision);
}

/**
 * Reads one array member out of an untrusted response body, or null when it is not there.
 *
 * Exported because a client call must never throw on a response shape it did not expect: the
 * server's schema and its controller composition are trusted to be right, but a client that throws
 * on an unexpected shape turns a rendering problem into an unhandled rejection and takes the page
 * down with it (N03-AC3, N02-AC1).
 */
export function readStringArrayMember(value: unknown, key: string): readonly string[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const member = (value as Record<string, unknown>)[key];
  if (!Array.isArray(member)) return null;
  return (member as readonly unknown[]).filter((entry): entry is string => typeof entry === 'string');
}