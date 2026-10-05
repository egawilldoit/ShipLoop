/**
 * The HTTP boundary for the handoff packet and project settings — PARTIAL, and marked for deletion.
 *
 * ## WHAT REMAINS HERE, AND WHY
 *
 * This file was one stand-in transport for the whole post-approval flow. Everything that has been
 * re-pointed at the shipped client in `apps/web/src/ui/mvp-client/` has been removed from it:
 *
 *   - **the candidate journey** — link, read, refresh, verify — now goes through
 *     `mvp-client`'s `linkCandidate`, `readCandidate`, `refreshCandidate` and `verifyCandidate`.
 *     `verifyCandidate` sends no body by default and never a result, which is the property the
 *     candidate screen depends on and the reason its display model lives in `review-model.ts`
 *     (F20-AC2, F23-AC1).
 *   - **the review card, the owner test and the decision** now go through `fetchReview`,
 *     `recordOwnerTest` and `decideCandidate` (F24-AC2, F25-AC3).
 *
 * What is left is what two files owned by other work still import, and nothing here has been
 * allowed to grow a fourth importer:
 *
 *   - `apps/web/src/ui/mvp/HandoffPage.tsx` imports `fetchHandoff`, `Handoff`,
 *     `HandoffExternalTool` and `TransportOutcome`;
 *   - `apps/web/src/ui/mvp/ExternalToolSetting.tsx` imports `fetchSettings`,
 *     `saveExternalToolUrl` and `ProjectSettings`.
 *
 * When those two are re-pointed, this file and `transport.test.ts` are deleted outright. Both
 * already have a client waiting: `fetchHandoff` exists in `mvp-client` for the first, and
 * `fetchSettings`/`updateSettings` for the second (mvp-spec L02, L02-AC3).
 *
 * ## The routes, and the handler each answer came from
 *
 * Both routes below were read before they were called. The names in the comments are the files in
 * `apps/web/src/server/routes/` that define the handler, and each entry states the property of
 * that handler this module depends on — not a restatement of it (mvp-spec 7).
 *
 *   GET   /api/projects/:projectId/contracts/:contractId/:revision/handoff
 *         → `routes/handoff.ts`. Answers `{ handoff }` with the controller's packet bytes
 *           untouched plus `t3` as one of three states. `GET`, not `POST`: nothing is written
 *           and nothing is decided, so the same approved contract renders the same document
 *           twice.
 *   GET   /api/projects/:projectId/settings
 *         → `routes/settings.ts`. Answers 200 with `{ settings }` even for a project that has
 *           configured nothing, which is the state a fresh deployment is in. Never carries a
 *           credential.
 *   PATCH /api/projects/:projectId/settings
 *         → `routes/settings.ts`. Body is `strictObject({ t3Url })` with `t3Url` nullable: `null`
 *           clears it, which is why the field is nullable rather than merely optional. A refused
 *           value is never echoed back.
 *
 * No unscoped spelling appears anywhere in this file. Every project-scoped path names the project
 * first, because a client that could address a candidate without saying of which project would be
 * asking a question the server has no way to check (F02-AC2).
 */

import { CSRF_HEADER, csrfTokenForRequests, type ApiFailure, type ApiFieldError, type ApiPrerequisite } from '../api-client.ts';
import { isHttpUrl } from './external-url.ts';

/* -------------------------------------------------------------------------- */
/* Result                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One call's outcome, as a value rather than an exception.
 *
 * `unreachable` is carried alongside the failure because "the browser could not reach the
 * server" and "the server received the request and declined it" are different states, and a
 * screen that renders both as an error has told the owner their view stopped being current when
 * in fact it answered (N03-AC1, N03-AC3). The distinction is why this is a separate member rather
 * than a code inside `ApiFailure`.
 */
export type TransportOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ApiFailure; readonly unreachable: boolean };

function answered<T>(value: T): TransportOutcome<T> {
  return { ok: true, value };
}

function refused(failure: ApiFailure): TransportOutcome<never> {
  return { ok: false, failure, unreachable: false };
}

function notReached(reason: string): TransportOutcome<never> {
  return {
    ok: false,
    unreachable: true,
    failure: { code: 'Unavailable', reason, fields: [], prerequisites: [] },
  };
}

/* -------------------------------------------------------------------------- */
/* The server's wire shapes                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The handoff packet, as `routes/handoff.ts` carries it.
 *
 * `markdown` is the controller's bytes and nothing in this layer reformats, trims or re-escapes
 * them: one approved contract must produce one document, and a transport that tidied the text
 * would make two packets differ for a reason nobody chose (N02-AC2). `fingerprint` is the digest of
 * those bytes, so the page can show what proves the clipboard holds the same document.
 */
export interface HandoffPacket {
  readonly markdown: string;
  readonly fingerprint: string;
}

/**
 * Where the browser may be sent to open the external tool, if anywhere.
 *
 * Three states because a nullable URL cannot tell them apart, and the difference changes what the
 * owner is told: nothing configured is normal and the packet works anyway, while a configured
 * value the server would not use is an operator error with a different remedy. No state
 * reproduces a value other than the configured URL itself.
 */
export type HandoffExternalTool =
  | { readonly state: 'Configured'; readonly url: string }
  | {
      readonly state: 'NotConfigured';
      readonly reason: string;
      readonly prerequisites: readonly HandoffPrerequisite[];
    }
  | {
      readonly state: 'Unusable';
      readonly reason: string;
      readonly prerequisites: readonly HandoffPrerequisite[];
    };

/** One unmet prerequisite with the remedy the owner can act on (F04-AC3). */
export interface HandoffPrerequisite {
  readonly name: string;
  readonly detail: string;
  readonly remedy: string;
}

export interface Handoff {
  readonly contractId: string;
  readonly revision: number;
  readonly packet: HandoffPacket;
  readonly t3: HandoffExternalTool;
}

/** What one project's settings hold. Never carries a credential (L02-AC2). */
export interface ProjectSettings {
  readonly projectId: string;
  readonly t3: { readonly configured: boolean; readonly url: string | null };
  readonly repository: {
    readonly configured: boolean;
    readonly repository: string | null;
    readonly baseBranch: string | null;
  };
  readonly updatedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Reading untrusted wire data                                                 */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function records(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

/**
 * Reads the `strictObject` refusal envelope `http-error.ts` actually sends.
 *
 * `{ error: { code, message, fields, prerequisites } }`, so a bare read of `code` would find
 * nothing and report every refusal as an unreachable server. The per-field list is carried because
 * a form can only mark the inputs it knows about, and the prerequisites because "blocked" alone
 * tells the owner nothing they can act on (F02-AC4, F04-AC3).
 */
function readRefusal(body: unknown, status: number): ApiFailure {
  const envelope = isRecord(body) && isRecord(body['error']) ? (body['error'] as Record<string, unknown>) : null;
  const source = envelope ?? (isRecord(body) ? body : null);
  const message =
    source !== null && str(source['message']) !== null
      ? (str(source['message']) as string)
      : `The server refused the request (${status}).`;
  const fields: ApiFieldError[] = records(source?.['fields']).flatMap((entry) => {
    const path = str(entry['path']);
    const text = str(entry['message']);
    return path !== null && text !== null ? [{ path, message: text }] : [];
  });
  const prerequisites: ApiPrerequisite[] = records(source?.['prerequisites']).flatMap((entry) => {
    const name = str(entry['name']);
    if (name === null) return [];
    return [{ name, detail: str(entry['detail']) ?? '', remedy: str(entry['remedy']) ?? '' }];
  });
  return {
    code: readCode(source?.['code']),
    reason: message,
    fields,
    prerequisites,
  };
}

function readCode(value: unknown): ApiFailure['code'] {
  switch (value) {
    case 'Blocked':
    case 'Conflict':
    case 'OutcomeUnknown':
    case 'Invalid':
    case 'NotFound':
    case 'Forbidden':
    case 'RateLimited':
    case 'Unauthorized':
      return value;
    default:
      return 'Unavailable';
  }
}

/* -------------------------------------------------------------------------- */
/* The request                                                                 */
/* -------------------------------------------------------------------------- */

type Method = 'GET' | 'POST' | 'PATCH';

async function send(method: Method, path: string, body?: unknown): Promise<TransportOutcome<unknown>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    // A state-changing call carries the session's derived token. A client without one is refused
    // by the server rather than silently proceeding, and saying so here names the fix — reload,
    // sign in again — instead of showing a bare refusal (F01-AC4, N03-AC3).
    const token = csrfTokenForRequests();
    if (token === null) {
      return notReached('This session has no request token, so nothing was sent. Reload the page and sign in again.');
    }
    headers[CSRF_HEADER] = token;
  }
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) init.body = JSON.stringify(body);
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    return notReached('The server could not be reached, so nothing was sent.');
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return refused({
      code: 'Unavailable',
      reason: 'The server answered, but the response could not be read.',
      fields: [],
      prerequisites: [],
    });
  }
  if (text === '') return answered(null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refused({
      code: 'Unavailable',
      reason: 'The server returned a response that was not valid JSON, so nothing here can be read as a result.',
      fields: [],
      prerequisites: [],
    });
  }
  // A refusal is an answer. It is not reported as a lost connection, because telling the owner
  // their view had stopped being current when the server received the request and declined it is
  // exactly the confusion the connection banner exists to prevent (N03-AC1, N03-AC3).
  if (!response.ok) return refused(readRefusal(parsed, response.status));
  return answered(parsed);
}

function envelope<T>(outcome: TransportOutcome<unknown>, key: string): TransportOutcome<T> {
  if (!outcome.ok) return outcome;
  if (!isRecord(outcome.value) || !(key in outcome.value)) {
    return refused({
      code: 'Unavailable',
      reason: `The server answered without the "${key}" this screen reads, so nothing is claimed about what it would have said.`,
      fields: [],
      prerequisites: [],
    });
  }
  return answered(outcome.value[key] as T);
}

function malformed(what: string): TransportOutcome<never> {
  return refused({
    code: 'Unavailable',
    reason: `The server answered a ${what} response this screen cannot read, so nothing is shown for it. No claim is made about the candidate or its checks.`,
    fields: [],
    prerequisites: [],
  });
}

function segment(value: string, what: string): TransportOutcome<string> {
  const trimmed = value.trim();
  if (trimmed === '') {
    return refused({
      code: 'Invalid',
      reason: `${what} is required before this can be read.`,
      fields: [],
      prerequisites: [],
    });
  }
  return answered(encodeURIComponent(trimmed));
}

/* -------------------------------------------------------------------------- */
/* Handoff                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The implementation packet for one approved revision of one project.
 *
 * A read, so it is safe to call again: the same approved contract renders the same bytes both
 * times, and the fingerprint is what lets a reader compare the two instead of trusting either
 * (mvp-spec 7, N02-AC2).
 */
export async function fetchHandoff(
  projectId: string,
  contractId: string,
  revision: number,
): Promise<TransportOutcome<Handoff>> {
  const project = await segment(projectId, 'A project');
  if (!project.ok) return project;
  const contract = await segment(contractId, 'A contract');
  if (!contract.ok) return contract;
  if (!Number.isInteger(revision) || revision < 1) {
    return refused({
      code: 'Invalid',
      reason: 'A revision number starts at 1, and nothing is rendered for one that is not a whole revision.',
      fields: [],
      prerequisites: [],
    });
  }
  const outcome = await send(
    'GET',
    `/api/projects/${project.value}/contracts/${contract.value}/${String(revision)}/handoff`,
  );
  const body = envelope<unknown>(outcome, 'handoff');
  if (!body.ok) return body;
  return readHandoff(body.value);
}

function readHandoff(value: unknown): TransportOutcome<Handoff> {
  if (!isRecord(value)) return malformed('handoff');
  const contractId = str(value['contractId']);
  const revision = value['revision'];
  const packet = value['packet'];
  const t3 = value['t3'];
  if (contractId === null || typeof revision !== 'number' || !isRecord(packet) || !isRecord(t3)) {
    return malformed('handoff');
  }
  const markdown = str(packet['markdown']);
  const fingerprint = str(packet['fingerprint']);
  if (markdown === null || fingerprint === null) return malformed('handoff');
  const externalTool = readExternalTool(t3);
  if (externalTool === null) return malformed('handoff');
  return answered({
    contractId,
    revision,
    packet: { markdown, fingerprint },
    t3: externalTool,
  });
}

function readPrerequisites(value: unknown): readonly HandoffPrerequisite[] {
  return records(value).flatMap((entry) => {
    const name = str(entry['name']);
    if (name === null) return [];
    return [{ name, detail: str(entry['detail']) ?? '', remedy: str(entry['remedy']) ?? '' }];
  });
}

function readExternalTool(value: Record<string, unknown>): HandoffExternalTool | null {
  const state = str(value['state']);
  if (state === 'Configured') {
    const url = str(value['url']);
    // A configured URL is not rendered as a link unless it is one this browser can open. The
    // server already refuses a non-http(s) or credential-bearing value, so reaching here means
    // something upstream changed; refusing to link is the safe reading, and the packet does not
    // depend on it (L02-AC2, N02-AC2).
    if (url === null || !isHttpUrl(url)) return null;
    return { state: 'Configured', url };
  }
  if (state === 'NotConfigured' || state === 'Unusable') {
    const reason = str(value['reason']);
    if (reason === null) return null;
    return { state, reason, prerequisites: readPrerequisites(value['prerequisites']) };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reads one project's settings.
 *
 * A project that has configured nothing is a 200 with `configured: false`, so an empty answer here
 * is a fact about the configuration rather than a failed read (L02-AC3).
 */
export async function fetchSettings(projectId: string): Promise<TransportOutcome<ProjectSettings>> {
  const project = await segment(projectId, 'A project');
  if (!project.ok) return project;
  const outcome = await send('GET', `/api/projects/${project.value}/settings`);
  const body = envelope<unknown>(outcome, 'settings');
  if (!body.ok) return body;
  return readSettings(body.value);
}

/**
 * Saves or clears the external tool's deployment URL.
 *
 * `null` clears it, which is why the parameter is nullable rather than merely optional: "there is
 * none" and "I did not say" are different states. A refused URL is never echoed back into this
 * module, so a credential pasted into the field cannot reappear in a refusal message (L02-AC2).
 */
export async function saveExternalToolUrl(
  projectId: string,
  t3Url: string | null,
): Promise<TransportOutcome<ProjectSettings>> {
  const project = await segment(projectId, 'A project');
  if (!project.ok) return project;
  const outcome = await send('PATCH', `/api/projects/${project.value}/settings`, { t3Url });
  const body = envelope<unknown>(outcome, 'settings');
  if (!body.ok) return body;
  return readSettings(body.value);
}

function readSettings(value: unknown): TransportOutcome<ProjectSettings> {
  if (!isRecord(value)) return malformed('settings');
  const t3 = value['t3'];
  const repository = value['repository'];
  if (!isRecord(t3) || !isRecord(repository)) return malformed('settings');
  const url = optionalStr(t3['url']);
  return answered({
    projectId: str(value['projectId']) ?? '',
    // `configured` is carried rather than inferred from `url`, so "this project has no deployment"
    // is a state that can be rendered rather than something deduced from a null (L02-AC3).
    t3: { configured: bool(t3['configured']), url },
    repository: {
      configured: bool(repository['configured']),
      repository: optionalStr(repository['repository']),
      baseBranch: optionalStr(repository['baseBranch']),
    },
    updatedAt: optionalStr(value['updatedAt']),
  });
}