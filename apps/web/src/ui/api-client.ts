/**
 * The single HTTP boundary for the owner UI.
 *
 * Every `fetch` in this application lives in this file. The server API is built by
 * another agent, so the response shapes this client depends on are declared here as
 * local interfaces rather than imported: `@shiploop/domain` re-exports modules that
 * reach for `node:crypto`, which cannot be bundled into a browser build. Integration is
 * therefore a one-file adjustment - either these interfaces are deleted in favour of the
 * server's own types, or the server is adjusted to answer in these shapes.
 *
 * The error shape mirrors the domain's command result so that "you must supply
 * information", "your view is stale" and "we do not know whether the write happened"
 * stay distinguishable in the UI (Blocked / Conflict / OutcomeUnknown). `Unauthorized` is
 * the one addition: a refused session has no domain equivalent and is the signal that the
 * app must return to sign-in (F01-AC2).
 */

/** Header carrying the derived CSRF token on every state-changing call (F01-AC4). */
export const CSRF_HEADER = 'x-shiploop-csrf';

/**
 * Refresh cadence for live data. N04-AC2 requires a persisted milestone to be visible
 * within five seconds, so the poll must be strictly faster than that budget.
 */
export const LIVE_REFRESH_MS = 4000;

export type ApiErrorCode =
  | 'Blocked'
  | 'Conflict'
  | 'OutcomeUnknown'
  | 'Invalid'
  | 'NotFound'
  | 'Forbidden'
  | 'RateLimited'
  | 'Unavailable'
  | 'Unauthorized';

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

/** One rejected field, carrying the form path the message belongs next to (F02-AC4). */
export interface ApiFieldError {
  readonly path: string;
  readonly message: string;
}

/** The failure every call reports instead of throwing, so pages can render it as state. */
export interface ApiFailure {
  readonly code: ApiErrorCode;
  readonly reason: string;
  readonly fields: readonly ApiFieldError[];
}

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiFailure };

/** The signed-in owner. Identity only: never a credential or a token (F03-AC3). */
export interface OwnerIdentity {
  readonly ownerId: string;
  readonly email: string;
  readonly displayName: string;
}

/** Repository and provider identity a profile points at (F02-AC1). */
export interface RepositoryIdentity {
  readonly provider: string;
  readonly repositoryUrl: string;
  readonly fullName: string;
}

export interface ProfileSummary {
  readonly profileId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly name: string;
  readonly repository: RepositoryIdentity;
  readonly targetBranch: string;
  readonly ticketTeamKey: string;
  readonly currentVersionId: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface ProfileListResponse {
  readonly profiles: readonly ProfileSummary[];
}

export type ProfileVerificationState = 'Verified' | 'Pending' | 'Unverified';

export interface ProfileVersion {
  readonly versionId: string;
  readonly profileId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly summary: string;
  readonly verificationState: ProfileVerificationState;
  readonly verificationDetail: string;
}

export interface ProfileVersionListResponse {
  readonly versions: readonly ProfileVersion[];
}

export interface ProfileDraft {
  readonly name: string;
  readonly provider: string;
  readonly repositoryUrl: string;
  readonly repositoryFullName: string;
  readonly ticketTeamKey: string;
  readonly ticketStateMapping: string;
  readonly targetBranch: string;
  readonly engineImage: string;
  readonly engineSandbox: 'Restricted' | 'Standard';
  readonly requiredChecks: readonly string[];
  readonly previewEnvironment: string;
  readonly deliveryStrategy: 'PullRequest' | 'DraftThenMerge';
  readonly deliveryRequiresAcceptance: boolean;
}

export interface CreateProfileRequest extends ProfileDraft {
  readonly projectId: string;
}

export interface CreateProfileResponse {
  readonly profile: ProfileSummary;
  readonly version: ProfileVersion;
}

export type ConnectorState = 'Healthy' | 'Degraded' | 'Revoked' | 'Unconfigured';

export type ConnectorType = 'RepositoryHost' | 'TicketTracker' | 'DeploymentTarget' | 'EngineHost';

/**
 * A connector as the UI is allowed to see it (F03-AC3).
 *
 * There is deliberately no credential field. The server returns a reference label naming
 * where the secret lives ("env:REPO_TOKEN"); the secret itself must never reach a UI
 * response, and a type with no place to put it is harder to violate than a convention.
 */
export interface ConnectorView {
  readonly connectorId: string;
  readonly profileId: string | null;
  readonly provider: string;
  readonly connectorType: ConnectorType;
  readonly state: ConnectorState;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly limitations: readonly { readonly kind: string; readonly limitation: string }[];
  readonly error: string | null;
  readonly remedy: string | null;
  readonly credentialReference: string;
}

export interface ConnectorListResponse {
  readonly connectors: readonly ConnectorView[];
}

export interface CreateConnectorRequest {
  readonly profileId: string | null;
  readonly provider: string;
  readonly connectorType: ConnectorType;
  readonly credentialReference: string;
}

export interface SessionResponse {
  readonly owner: OwnerIdentity;
  readonly csrfToken: string;
  readonly projectId: string;
  readonly projectName: string;
}

export type SignInResponse = SessionResponse;

export interface SignInRequest {
  readonly email: string;
  readonly password: string;
}

export interface SessionState {
  readonly status: 'signed-out' | 'signed-in';
  readonly owner: OwnerIdentity;
  readonly projectId: string;
  readonly projectName: string;
}

/** Transport health, mirrored so the owner is told when the view has stopped being current. */
export interface ConnectionState {
  readonly connected: boolean;
  readonly lastUpdateAt: string | null;
  readonly lastFailureReason: string | null;
}

let csrfToken: string | null = null;
let connection: ConnectionState = { connected: true, lastUpdateAt: null, lastFailureReason: null };
const connectionListeners = new Set<(state: ConnectionState) => void>();

/**
 * Records the session's CSRF token. Cleared on sign-out so no cached token can authorize
 * a later request from a signed-out client (F01-AC2, F01-AC5).
 */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function subscribeToConnection(listener: (state: ConnectionState) => void): () => void {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}

export function getConnectionState(): ConnectionState {
  return connection;
}

function publish(next: ConnectionState): void {
  connection = next;
  for (const listener of connectionListeners) listener(next);
}

function noteReachable(now: string): void {
  publish({ connected: true, lastUpdateAt: now, lastFailureReason: null });
}

function noteFailure(reason: string): void {
  publish({ connected: false, lastUpdateAt: connection.lastUpdateAt, lastFailureReason: reason });
}

interface SendOptions {
  readonly method: 'GET' | 'POST';
  readonly csrf: boolean;
  readonly body?: unknown;
}

type SendOutcome = { readonly kind: 'response'; readonly response: Response } | { readonly kind: 'offline' };

async function send(path: string, options: SendOptions): Promise<SendOutcome> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.csrf) {
    const token = csrfToken;
    if (token === null) {
      noteFailure('This session has no request token. Sign in again.');
      return { kind: 'offline' };
    }
    headers[CSRF_HEADER] = token;
  }
  const init: RequestInit = { method: options.method, headers, credentials: 'same-origin' };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  try {
    return { kind: 'response', response: await fetch(path, init) };
  } catch {
    noteFailure('The server could not be reached.');
    return { kind: 'offline' };
  }
}

async function readBody(response: Response): Promise<ApiResult<unknown>> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return failure('Unavailable', 'The response could not be read.');
  }
  if (text === '') return { ok: true, value: null };
  try {
    const parsed: unknown = JSON.parse(text);
    return { ok: true, value: parsed };
  } catch {
    return failure('Unavailable', 'The server returned a response that was not valid JSON.');
  }
}

function failure(code: ApiErrorCode, reason: string, fields: readonly ApiFieldError[] = []): ApiResult<never> {
  return { ok: false, error: { code, reason, fields } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && API_ERROR_CODES.has(value);
}

function readFields(value: unknown): readonly ApiFieldError[] {
  if (!isRecord(value)) return [];
  const raw: unknown = value['fields'];
  if (!Array.isArray(raw)) return [];
  const entries: readonly unknown[] = raw;
  const fields: ApiFieldError[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const path = entry['path'];
    const message = entry['message'];
    if (typeof path === 'string' && typeof message === 'string') fields.push({ path, message });
  }
  return fields;
}

/**
 * One cast of untrusted wire data to a declared local shape, made once at the boundary
 * instead of being repeated in every caller. Each endpoint below documents the shape it
 * expects, so a mismatch is a single-file fix.
 */
function request<T>(path: string, options: SendOptions): Promise<ApiResult<T>> {
  return send(path, options).then(async (outcome) => {
    if (outcome.kind === 'offline') return failure('Unavailable', 'The server could not be reached.');
    const { response } = outcome;
    const body = await readBody(response);
    if (!body.ok) {
      noteFailure(body.error.reason);
      return failure(body.error.code, body.error.reason);
    }
    if (response.ok) {
      noteReachable(new Date().toISOString());
      return { ok: true, value: body.value as T };
    }
    const reason = isRecord(body.value) && typeof body.value['reason'] === 'string'
      ? body.value['reason']
      : `The server refused the request (${response.status}).`;
    const code = isRecord(body.value) && isApiErrorCode(body.value['code']) ? body.value['code'] : 'Unavailable';
    noteFailure(reason);
    return failure(code, reason, readFields(body.value));
  });
}

function pathFor(prefix: string, id: string, suffix = ''): string {
  return `${prefix}/${encodeURIComponent(id)}${suffix}`;
}

export function signIn(credentials: SignInRequest): Promise<ApiResult<SignInResponse>> {
  return request<SignInResponse>('/api/owner/sign-in', { method: 'POST', csrf: false, body: credentials });
}

export function fetchSession(): Promise<ApiResult<SessionResponse>> {
  return request<SessionResponse>('/api/owner/session', { method: 'GET', csrf: false });
}

export function signOut(): Promise<ApiResult<void>> {
  return request<void>('/api/owner/sign-out', { method: 'POST', csrf: true });
}

export function fetchProfiles(projectId: string): Promise<ApiResult<ProfileListResponse>> {
  return request<ProfileListResponse>(pathFor('/api/profiles', projectId), { method: 'GET', csrf: false });
}

export function fetchProfileVersions(projectId: string): Promise<ApiResult<ProfileVersionListResponse>> {
  return request<ProfileVersionListResponse>(pathFor('/api/profiles', projectId, '/versions'), {
    method: 'GET',
    csrf: false,
  });
}

export function createProfile(draft: CreateProfileRequest): Promise<ApiResult<CreateProfileResponse>> {
  return request<CreateProfileResponse>('/api/profiles', { method: 'POST', csrf: true, body: draft });
}

export function fetchConnectors(projectId: string): Promise<ApiResult<ConnectorListResponse>> {
  return request<ConnectorListResponse>(pathFor('/api/profiles', projectId, '/connectors'), {
    method: 'GET',
    csrf: false,
  });
}

export function createConnector(
  projectId: string,
  draft: CreateConnectorRequest,
): Promise<ApiResult<ConnectorView>> {
  return request<ConnectorView>(pathFor('/api/profiles', projectId, '/connectors'), {
    method: 'POST',
    csrf: true,
    body: draft,
  });
}

export function revokeConnector(connectorId: string): Promise<ApiResult<ConnectorView>> {
  return request<ConnectorView>(pathFor('/api/connectors', connectorId, '/revoke'), { method: 'POST', csrf: true });
}

/** Groups a failure's field messages by form path so each can render beside its input. */
export function fieldMessages(failureValue: ApiFailure): Readonly<Record<string, string>> {
  const grouped: Record<string, string> = {};
  for (const field of failureValue.fields) {
    if (grouped[field.path] === undefined) grouped[field.path] = field.message;
  }
  return grouped;
}

/**
 * A relative timestamp for every surface that shows one. Kept beside the wire types
 * because every instant the UI renders arrives as an ISO string from these endpoints.
 */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'an unknown time';
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** An unambiguous absolute rendering to sit beside the relative one, since that drifts. */
export function formatTimestamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return `${new Date(parsed).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
