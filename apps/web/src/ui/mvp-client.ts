/**
 * The MVP transport for the app shell and the Home surface.
 *
 * ## This module is meant to be deleted
 *
 * F1 owns the browser client. Every call here is written against a handler that already
 * exists in this tree, and every call belongs in one client module rather than in a
 * component. When F1's client lands, this file's contents move into it and this file goes
 * away: nothing else may import it directly except the shell and Home, so the move is one
 * file plus its import lines. It exists because F1's module is not in this worktree, not
 * because the two clients are meant to coexist.
 *
 * ## The routes, and the handlers they were read from
 *
 * | Call | Route | Handler read |
 * | --- | --- | --- |
 * | `readOwnerSession` | `GET /api/owner/session` | `server/routes/owner.ts` |
 * | `selectActiveProject` | `PUT /api/owner/active-project` | `server/routes/owner.ts` |
 * | `fetchHome` | `GET /api/projects/:projectId/home` | `server/routes/home.ts` |
 *
 * Project-scoped routes carry the project in the path and are refused on a path separator
 * or `..` (F06-AC1), so an id is encoded here rather than pasted into a URL by a caller.
 * No unscoped spelling of any of these appears in this file, and none may appear in a
 * component.
 *
 * ## Why each response is read into a declared shape instead of cast
 *
 * `routes/home.ts` documents `HomeEntry` as carrying no progress field, no percentage and
 * no executor status, because ShipLoop has no integration that would prove any of them.
 * A cast would let a future payload add one and have it reach the board unexamined. The
 * readers below therefore accept only what the handler declares: an unknown `kind`, a
 * `headSha` that is not a full 40-character commit, or a missing group is a
 * `MalformedResponse` the page renders as an error, never a half-populated board.
 */

/** Header carrying the derived CSRF token on the one write this module makes (F01-AC4). */
export const CSRF_HEADER = 'x-shiploop-csrf';

/**
 * Why a call did not produce a projection.
 *
 * Three states, kept apart because the owner acts on them differently, and merging them is
 * how "your view is out of date" becomes "the server said no":
 *
 *   - `Disconnected` - no response arrived. There is nothing to correct and no refusal to
 *     argue with, and the same request may well succeed a moment later (N03-AC1).
 *   - `Refused` - the server answered with a problem. `serverCode` carries the code it
 *     chose and the reason is its own wording, never this client's paraphrase of it.
 *   - `MalformedResponse` - a response arrived that does not match the handler this module
 *     was written against. Rendering part of it would put a claim on the board that the
 *     server did not make.
 */
export type MvpFailure =
  | { readonly code: 'Disconnected'; readonly reason: string; readonly serverCode: null }
  | { readonly code: 'Refused'; readonly reason: string; readonly serverCode: string }
  | { readonly code: 'MalformedResponse'; readonly reason: string; readonly serverCode: null };

export type MvpResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: MvpFailure };

/* -------------------------------------------------------------------------- */
/* Project identity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Which project the session addresses, or the state the owner is in when none is chosen
 * (F02-AC1, F02-AC2).
 *
 * The field names are the server's, deliberately, so this type can be deleted in favour of
 * `ActiveProjectView` from `server/contracts.ts` at integration without a rename. A union
 * rather than a nullable pair: the only way to hold an id is to hold the `Selected` variant,
 * which the controller built from a project row this deployment holds. There is no
 * placeholder project and no default to fall back on, and the `selectableProjectCount` in
 * the other variant lets the UI say "choose one of three" instead of showing an empty field.
 */
export type ActiveProject =
  | {
      readonly state: 'Selected';
      readonly activeProjectId: string;
      readonly activeProjectName: string;
    }
  | {
      readonly state: 'NoProjectSelected';
      readonly selectableProjectCount: number;
    };

/** The owner block the session route returns: identity only, never a credential (F01-AC1). */
export interface SessionOwner {
  readonly ownerId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly activeProject: ActiveProject;
}

export interface OwnerSession {
  readonly owner: SessionOwner;
  readonly csrfToken: string;
}

/* -------------------------------------------------------------------------- */
/* Home                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The closed vocabulary of home entry kinds.
 *
 * Repeated from `HOME_ENTRY_KINDS` in `server/routes/home.ts` rather than imported: that
 * file imports `fastify`, which cannot be bundled into a browser build. It is a closed set
 * because each member is a state the projection can prove from recorded facts, and an
 * unknown value means this client and that route have drifted apart - which is a refusal,
 * not a row to render under a guessed label.
 */
export const HOME_ENTRY_KINDS = [
  'ContractNotWritten',
  'ContractAwaitingApproval',
  'CandidateNotLinked',
  'VerificationOutstanding',
  'VerificationFailed',
  'OwnerTestOutstanding',
  'DecisionAwaiting',
  'CandidateReadyForReview',
] as const;

export type HomeEntryKind = (typeof HOME_ENTRY_KINDS)[number];

function isHomeEntryKind(value: unknown): value is HomeEntryKind {
  return typeof value === 'string' && (HOME_ENTRY_KINDS as readonly string[]).includes(value);
}

/**
 * One thing on the board, exactly as `HomeEntry` in `server/routes/home.ts` declares it.
 *
 * There is deliberately no field for progress, a percentage, an elapsed time or an executor
 * status: ShipLoop has no supported integration that would prove any of them, so a caller
 * cannot ask for one here even by accident. `headSha` is the full commit or null - never an
 * abbreviation and never a branch name, because a candidate is identified by its commit
 * (F17-AC2, F25-AC3).
 */
export interface HomeEntry {
  readonly kind: HomeEntryKind;
  readonly requestId: string;
  readonly title: string;
  readonly contractId: string | null;
  readonly contractRevision: number | null;
  readonly candidateId: string | null;
  readonly headSha: string | null;
  /** Why this entry is here, quoted from the projection that decided it. */
  readonly reason: string;
  /** What the owner does next. A statement about the owner's action, never an executor's. */
  readonly nextAction: string;
  readonly outstandingCriterionIds: readonly string[];
}

/**
 * The three groups and the instant they were read.
 *
 * The groups are independent rather than a partition: a candidate with current automated
 * evidence and an unrun owner test is truthfully both ready to be looked at and waiting on
 * the owner (F24-AC3). Nothing here merges or removes an entry that appears in two groups -
 * `home-model.ts` renders the payload as it was sent, because the duplication is a true
 * statement about two different obligations rather than a display error.
 */
export interface HomeProjection {
  readonly projectId: string;
  readonly collectedAt: string;
  readonly needsYou: readonly HomeEntry[];
  readonly inProgress: readonly HomeEntry[];
  readonly readyForReview: readonly HomeEntry[];
}

/* -------------------------------------------------------------------------- */
/* The CSRF token                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The session's CSRF token, held here for the one write this module makes.
 *
 * `PUT /api/owner/active-project` is state-changing, so `auth-guard.ts` demands the header
 * for it (F01-AC4). The token comes from the session response - the cookie is HttpOnly, so
 * the browser cannot read it any other way - and the session layer sets it, which is also
 * where signing out clears it.
 */
let csrfToken: string | null = null;

export function setMvpCsrfToken(token: string | null): void {
  csrfToken = token;
}

/* -------------------------------------------------------------------------- */
/* The HTTP boundary                                                           */
/* -------------------------------------------------------------------------- */

function disconnected(reason: string): MvpFailure {
  return { code: 'Disconnected', reason, serverCode: null };
}

function malformed(reason: string): MvpFailure {
  return { code: 'MalformedResponse', reason, serverCode: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The refusal out of the envelope `http-error.ts` actually sends, `{ error: { code, message } }`.
 *
 * Reading a bare `code` and `reason` off the top level finds neither, and every refusal
 * would then render as an unreadable response - the same class of bug as reading `.reason`
 * off a domain `Result` the route already flattened.
 */
function readRefusal(body: unknown, status: number): MvpFailure {
  const envelope = isRecord(body) && isRecord(body['error']) ? body['error'] : null;
  const source = envelope ?? (isRecord(body) ? body : null);
  const message =
    source !== null && typeof source['message'] === 'string'
      ? source['message']
      : source !== null && typeof source['reason'] === 'string'
        ? source['reason']
        : `The server refused the request (${status}).`;
  const code =
    source !== null && typeof source['code'] === 'string'
      ? source['code']
      : source !== null && typeof source['reason'] === 'string'
        ? source['reason']
        : 'Refused';
  return { code: 'Refused', reason: message, serverCode: code };
}

type BodyRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: MvpFailure };

async function readBody(response: Response): Promise<BodyRead> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, error: malformed('The response arrived but its body could not be read.') };
  }
  if (text === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: malformed('The server returned a response that was not valid JSON.') };
  }
}

interface SendOptions {
  readonly method: 'GET' | 'PUT';
  readonly csrf?: boolean;
  readonly body?: unknown;
}

async function send(path: string, options: SendOptions): Promise<MvpResult<unknown>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.csrf === true) {
    const token = csrfToken;
    if (token === null) {
      return { ok: false, error: disconnected('This session has no request token. Sign in again.') };
    }
    headers[CSRF_HEADER] = token;
  }
  const init: RequestInit = { method: options.method, headers, credentials: 'same-origin' };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    return { ok: false, error: disconnected('The server could not be reached.') };
  }

  const body = await readBody(response);
  if (!body.ok) return body;
  if (response.ok) return { ok: true, value: body.value };

  // A refusal is an answer, so it is not folded into `Disconnected`: the server received the
  // request and declined it, and telling the owner their view has stopped being current would
  // be a different and wrong claim (N03-AC1, N03-AC3).
  return { ok: false, error: readRefusal(body.value, response.status) };
}

/* -------------------------------------------------------------------------- */
/* The readers                                                                 */
/*                                                                             */
/* Exported so the boundary can be tested without a server standing in for it.  */
/* -------------------------------------------------------------------------- */

/**
 * `ActiveProject` out of a session or selection block, refusing anything else.
 *
 * A pair of nullable fields is the historical defect (F02-AC1): the client reached for a
 * project id it did not have and every project-scoped request went out for a project named
 * `undefined`. A discriminated union makes that unrepresentable rather than remembered.
 */
export function parseActiveProject(value: unknown): MvpResult<ActiveProject> {
  if (!isRecord(value)) {
    return { ok: false, error: malformed('The session did not say which project this owner is in.') };
  }
  const state = readString(value, 'state');
  if (state === 'Selected') {
    const id = readString(value, 'activeProjectId');
    const name = readString(value, 'activeProjectName');
    if (id === null || id === '' || name === null) {
      return { ok: false, error: malformed('The session reported a selected project it did not name.') };
    }
    return { ok: true, value: { state: 'Selected', activeProjectId: id, activeProjectName: name } };
  }
  if (state === 'NoProjectSelected') {
    const count = value['selectableProjectCount'];
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
      return { ok: false, error: malformed('The session reported no selected project and no list to choose from.') };
    }
    return { ok: true, value: { state: 'NoProjectSelected', selectableProjectCount: count } };
  }
  return { ok: false, error: malformed('The session reported a project state this client does not know.') };
}

/**
 * The owner block, read strictly enough that an owner with no address still renders one.
 *
 * `email` is nullable because an owner row can carry no sign-in address (F01-AC1), and a
 * missing fact has to be stated rather than rendered as an empty pair of parentheses.
 */
export function parseSessionOwner(value: unknown): MvpResult<SessionOwner> {
  if (!isRecord(value)) return { ok: false, error: malformed('The session response carried no owner block.') };
  const ownerId = readString(value, 'ownerId');
  const displayName = readString(value, 'displayName');
  if (ownerId === null || displayName === null) {
    return { ok: false, error: malformed('The session response did not name the signed-in owner.') };
  }
  const email = value['email'];
  const project = parseActiveProject(value['activeProject']);
  if (!project.ok) return project;
  return {
    ok: true,
    value: {
      ownerId,
      displayName,
      email: typeof email === 'string' ? email : null,
      activeProject: project.value,
    },
  };
}

/** A list of strings, or null when the list is not one. Never silently shortened. */
function readStringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    items.push(item);
  }
  return items;
}

/** The full 40-character commit, or null. An abbreviation is refused, not displayed. */
function readCommit(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) return undefined;
  return value;
}

/**
 * One board entry.
 *
 * A commit that is not the full 40 characters is refused rather than shown: an abbreviated
 * SHA displayed as the identity of the code under review is the specific wrong answer this
 * check makes unreachable (F17-AC2, F25-AC3). `undefined` is the internal "refuse" signal and
 * never leaves this module.
 */
export function parseHomeEntry(value: unknown): MvpResult<HomeEntry> {
  if (!isRecord(value)) return { ok: false, error: malformed('A home entry was not an object.') };

  const kind = value['kind'];
  if (!isHomeEntryKind(kind)) {
    return { ok: false, error: malformed('A home entry carried a reason this client cannot name.') };
  }
  const requestId = readString(value, 'requestId');
  const title = readString(value, 'title');
  const reason = readString(value, 'reason');
  const nextAction = readString(value, 'nextAction');
  if (requestId === null || title === null || reason === null || nextAction === null) {
    return { ok: false, error: malformed('A home entry did not say what it was or what to do next.') };
  }

  const commit = readCommit(value['headSha']);
  if (commit === undefined) {
    return { ok: false, error: malformed('A home entry named a candidate commit that is not a full 40-character SHA.') };
  }
  const criterionIds = readStringList(value['outstandingCriterionIds']);
  if (criterionIds === null) {
    return { ok: false, error: malformed('A home entry listed outstanding criteria in a shape this client cannot read.') };
  }
  const contractId = value['contractId'];
  const contractRevision = value['contractRevision'];
  const candidateId = value['candidateId'];

  return {
    ok: true,
    value: {
      kind,
      requestId,
      title,
      contractId: typeof contractId === 'string' ? contractId : null,
      contractRevision: typeof contractRevision === 'number' ? contractRevision : null,
      candidateId: typeof candidateId === 'string' ? candidateId : null,
      headSha: commit,
      reason,
      nextAction,
      outstandingCriterionIds: criterionIds,
    },
  };
}

/** One group, refusing an absent group rather than reporting it as empty. */
function parseHomeGroup(value: unknown, what: string): MvpResult<readonly HomeEntry[]> {
  if (!Array.isArray(value)) {
    return { ok: false, error: malformed(`The board left out ${what} instead of reporting it as empty.`) };
  }
  const entries: HomeEntry[] = [];
  for (const item of value) {
    const entry = parseHomeEntry(item);
    if (!entry.ok) return entry;
    entries.push(entry.value);
  }
  return { ok: true, value: entries };
}

/**
 * The board, refused rather than partly rendered.
 *
 * `routes/home.ts` never answers with three empty lists to mean "I could not read anything",
 * and it refuses outright when it cannot compose the projection - so a response whose
 * `needsYou` is missing is a disagreement between this client and that route. Showing an
 * empty group for it would put "nothing needs you" on the board, which is a claim the server
 * did not make (F20-AC1).
 */
export function parseHomeProjection(value: unknown): MvpResult<HomeProjection> {
  if (!isRecord(value)) return { ok: false, error: malformed('The home response carried no board.') };
  const home = value['home'];
  if (!isRecord(home)) return { ok: false, error: malformed('The home response carried no board.') };

  const projectId = readString(home, 'projectId');
  const collectedAt = readString(home, 'collectedAt');
  if (projectId === null || collectedAt === null) {
    return { ok: false, error: malformed('The board did not say which project it is about or when it was read.') };
  }

  const needsYou = parseHomeGroup(home['needsYou'], 'the "needs you" group');
  if (!needsYou.ok) return needsYou;
  const inProgress = parseHomeGroup(home['inProgress'], 'the in-progress group');
  if (!inProgress.ok) return inProgress;
  const readyForReview = parseHomeGroup(home['readyForReview'], 'the ready-for-review group');
  if (!readyForReview.ok) return readyForReview;

  return {
    ok: true,
    value: { projectId, collectedAt, needsYou: needsYou.value, inProgress: inProgress.value, readyForReview: readyForReview.value },
  };
}

/* -------------------------------------------------------------------------- */
/* The calls                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The signed-in owner's identity, request token and current project (F01-AC1, F02-AC1).
 *
 * The project travels in this response rather than being asked for separately, so a page
 * cannot act in the window between reading the identity and reading the project.
 */
export async function readOwnerSession(): Promise<MvpResult<OwnerSession>> {
  const response = await send('/api/owner/session', { method: 'GET' });
  if (!response.ok) return response;
  if (!isRecord(response.value)) return { ok: false, error: malformed('The session response was not an object.') };
  const token = readString(response.value, 'csrfToken');
  if (token === null) return { ok: false, error: malformed('The session response carried no request token.') };
  const owner = parseSessionOwner(response.value['owner']);
  if (!owner.ok) return owner;
  return { ok: true, value: { owner: owner.value, csrfToken: token } };
}

/**
 * Chooses the project every subsequent project-scoped call addresses (F02-AC1).
 *
 * `PUT`, because the resource is the session's current project and re-selecting one is
 * idempotent (F02-AC4). The route refuses null, so "no project selected" is reached by never
 * choosing one - the state the session response already reports - and never by asking to
 * select nothing. A refusal is returned rather than applied, so the caller keeps addressing
 * the project it actually has.
 */
export async function selectActiveProject(projectId: string): Promise<MvpResult<ActiveProject>> {
  const response = await send('/api/owner/active-project', { method: 'PUT', csrf: true, body: { projectId } });
  if (!response.ok) return response;
  if (!isRecord(response.value)) return { ok: false, error: malformed('The selection response was not an object.') };
  return parseActiveProject(response.value['activeProject']);
}

/**
 * This project's home projection (mvp-spec 3, F24-AC3).
 *
 * A read, so it takes no CSRF token, and it asks nothing of an external executor.
 */
export async function fetchHome(projectId: string): Promise<MvpResult<HomeProjection>> {
  const response = await send(`/api/projects/${encodeURIComponent(projectId)}/home`, { method: 'GET' });
  if (!response.ok) return response;
  return parseHomeProjection(response.value);
}