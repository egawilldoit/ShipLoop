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

export type IntakeRequestKind = 'FeatureRequest' | 'Bug';

export type IntakeDisposition = 'Unpublished' | 'Published' | 'Deferred' | 'Archived';

export interface BugDetail {
  readonly expected: string | null;
  readonly actual: string | null;
  readonly reproduction: string | null;
}

/** A named attachment row. Never its content: attachments are files (F06-AC1). */
export interface IntakeAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly addedAt: string;
}

/**
 * A generated summary, kept apart from the raw request (F06-AC1).
 *
 * `rawRequestFingerprint` is the fingerprint of the exact request this describes, so
 * the two can always be traced to each other. `null` means no summary has been
 * generated, which is different from an empty summary.
 */
export interface GeneratedSummary {
  readonly text: string;
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly rawRequestFingerprint: string;
}

/** One captured request (F06-AC1, F06-AC3, F06-AC5). */
export interface IntakeIdea {
  readonly ideaId: string;
  readonly rawRequest: string;
  readonly projectId: string | null;
  readonly notes: string | null;
  readonly kind: IntakeRequestKind;
  readonly bugDetail: BugDetail;
  readonly attachments: readonly IntakeAttachment[];
  readonly summary: GeneratedSummary | null;
  readonly disposition: IntakeDisposition;
  readonly dispositionDetail: string | null;
  readonly capturedAt: string;
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly text: string;
  readonly verification: string | null;
}

/** The seven sections F07-AC1 names. Every section is present; a list may be empty. */
export interface BriefSections {
  readonly problem: string;
  readonly desiredOutcome: string;
  readonly includedBehaviour: readonly string[];
  readonly excludedBehaviour: readonly string[];
  readonly assumptions: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly unresolvedQuestions: readonly string[];
}

export interface BriefVersion {
  readonly version: number;
  readonly state: 'Proposed' | 'Agreed';
  readonly authoredBy: string;
  readonly authoredAt: string;
  readonly supersedesVersion: number | null;
  readonly rawRequestFingerprint: string;
  readonly sections: BriefSections;
  readonly agreedBy: string | null;
  readonly agreedAt: string | null;
  readonly withdrawnCriterionIds: readonly string[];
}

export interface Brief {
  readonly briefId: string | null;
  readonly currentVersion: number | null;
  readonly current: BriefVersion | null;
  readonly versions: readonly BriefVersion[];
}

export interface ClarifyingQuestion {
  readonly questionId: string;
  readonly topic: string;
  readonly prompt: string;
  readonly readings: readonly string[];
  readonly whyMaterial: string;
  readonly origin: 'Ambiguity' | 'UnobservableCriterion';
  readonly state: 'Open' | 'Answered';
  readonly answer: string | null;
  readonly askedAt: string;
  readonly answeredAt: string | null;
}

/** A candidate question that was considered and declined (F07-AC2). */
export interface RejectedCandidate {
  readonly topic: string;
  readonly rejection: string;
  readonly explanation: string;
}

export interface IntakeTurn {
  readonly kind: 'RawRequest' | 'Question' | 'Answer' | 'Correction';
  readonly at: string;
  readonly text: string;
  readonly reference: string | null;
}

export interface IntakeDetail {
  readonly idea: IntakeIdea;
  readonly brief: Brief;
  readonly questions: readonly ClarifyingQuestion[];
  readonly rejected: readonly RejectedCandidate[];
  readonly turns: readonly IntakeTurn[];
}

/**
 * A resemblance report and the choices the owner holds (F06-AC4).
 *
 * `mergeable` and `discardable` are literal `false`, so no score can be read as a
 * merge, and `disposition` is one literal: the owner has not decided yet.
 */
export interface RelatednessReport {
  readonly candidateIdeaId: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly mergeable: false;
  readonly discardable: false;
  readonly disposition: 'OwnerChoiceRequired';
  readonly ownerChoices: readonly RelatedWorkChoice[];
}

export type RelatedWorkChoice = 'LinkToExisting' | 'ExtendExisting' | 'CreateNewIssue';

export interface RelatedWorkChoiceOutcome {
  readonly candidateIdeaId: string;
  readonly choice: RelatedWorkChoice;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly merged: false;
  readonly dispositionAfterChoice: {
    readonly idea: IntakeDisposition;
    readonly candidate: IntakeDisposition;
  };
}

export interface IntakeAmbiguity {
  readonly kind:
    | 'UnspecifiedSubject'
    | 'ConflictingStatement'
    | 'MissingAcceptanceThreshold'
    | 'UnstatedScopeBoundary'
    | 'UnresolvedDependency';
  readonly topic: string;
  readonly readings: readonly string[];
  readonly answeredBy: readonly string[];
  readonly impact: 'ChangesBehaviour' | 'ChangesAcceptance' | 'Cosmetic';
  readonly evidence: string;
}

export interface ClarificationRound {
  readonly questions: readonly ClarifyingQuestion[];
  readonly rejected: readonly RejectedCandidate[];
}

export interface CorrectionOutcome {
  readonly currentVersion: BriefVersion;
  readonly priorVersion: BriefVersion;
  readonly withdrawnCriterionIds: readonly string[];
}

export interface IntakeIdeaExport {
  readonly ideaId: string;
  readonly kind: IntakeRequestKind;
  readonly capturedAt: string;
  readonly rawRequest: string;
  readonly notes: string | null;
  readonly projectId: string | null;
  readonly bugDetail: BugDetail;
  readonly summary: GeneratedSummary | null;
  readonly disposition: { readonly state: string; readonly detail: string | null };
  readonly attachments: readonly {
    readonly fileName: string;
    readonly mediaType: string;
    readonly byteSize: number;
    readonly contentDigest: string;
  }[];
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
/**
 * The server's refusal, read out of the envelope it actually sends.
 *
 * `apps/web/src/server/http-error.ts` answers `{ error: { code, message, fields } }`, so
 * reading a bare `code` and `reason` off the top level finds neither and would report
 * every refusal as an unreachable server. Reading the envelope is what lets a rejected
 * field's message reach the input it belongs to, which is the whole reason the server
 * returns one (F02-AC4, N03-AC3). The bare form is still accepted as a fallback so a
 * proxy or a future shape does not turn a refusal into a transport failure.
 */
function readRefusal(body: unknown, status: number): ApiFailure {
  const envelope = isRecord(body) && isRecord(body['error']) ? (body['error'] as Record<string, unknown>) : null;
  const source = envelope ?? (isRecord(body) ? body : null);
  const message = source !== null && typeof source['message'] === 'string'
    ? source['message']
    : typeof source?.['reason'] === 'string'
      ? source['reason']
      : `The server refused the request (${status}).`;
  const rawCode = source === null ? undefined : (source['code'] ?? source['reason']);
  return {
    code: isApiErrorCode(rawCode) ? rawCode : 'Unavailable',
    reason: message,
    fields: readFields(source),
  };
}

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
    // A refusal is an answer, so the transport is not treated as lost. Marking the
    // connection down here would tell the owner their view had stopped being current
    // when in fact the server received the request and declined it, which is the
    // confusion the banner exists to prevent (N03-AC1, N03-AC3).
    return { ok: false, error: readRefusal(body.value, response.status) };
  });
}

function pathFor(prefix: string, id: string, suffix = ''): string {
  return `${prefix}/${encodeURIComponent(id)}${suffix}`;
}

/**
 * Signs in with whatever the owner typed.
 *
 * The submitted body speaks the server's vocabulary rather than the form's: the route
 * accepts an `identifier`, which it matches against both a display name and a derived
 * address, so sending the typed value under a field named `email` is what makes
 * "sign in with the name you provisioned" work against the real entrypoint instead of
 * being refused as an unrecognised key (F01-AC1).
 */
export function signIn(credentials: SignInRequest): Promise<ApiResult<SignInResponse>> {
  return request<SignInResponse>('/api/owner/sign-in', {
    method: 'POST',
    csrf: false,
    body: { identifier: credentials.email, password: credentials.password },
  });
}

const INTAKE_ROOT = '/api/intake';

export function fetchIntakeIdeas(): Promise<ApiResult<{ readonly ideas: readonly IntakeIdea[] }>> {
  return request<{ readonly ideas: readonly IntakeIdea[] }>(`${INTAKE_ROOT}/ideas`, { method: 'GET', csrf: false });
}

export function captureIdea(draft: {
  readonly rawRequest: string;
  readonly kind: IntakeRequestKind;
  readonly projectId: string | null;
  readonly notes: string | null;
  readonly detail: BugDetail | null;
}): Promise<ApiResult<{ readonly idea: IntakeIdea }>> {
  return request<{ readonly idea: IntakeIdea }>(`${INTAKE_ROOT}/ideas`, {
    method: 'POST',
    csrf: true,
    body: draft,
  });
}

export function fetchIntakeIdea(ideaId: string): Promise<ApiResult<IntakeDetail>> {
  return request<IntakeDetail>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}`, {
    method: 'GET',
    csrf: false,
  });
}

export function attachIntakeFile(
  ideaId: string,
  attachment: { readonly name: string; readonly mediaType: string; readonly content: string },
): Promise<ApiResult<{ readonly idea: IntakeIdea }>> {
  return request<{ readonly idea: IntakeIdea }>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/attachments`, {
    method: 'POST',
    csrf: true,
    body: attachment,
  });
}

export function recordIntakeSummary(
  ideaId: string,
  summary: { readonly text: string; readonly generatedBy: string },
): Promise<ApiResult<{ readonly idea: IntakeIdea }>> {
  return request<{ readonly idea: IntakeIdea }>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/summary`, {
    method: 'POST',
    csrf: true,
    body: summary,
  });
}

export function archiveIntakeIdea(ideaId: string, reason: string | null): Promise<ApiResult<{ readonly idea: IntakeIdea }>> {
  return request<{ readonly idea: IntakeIdea }>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/archive`, {
    method: 'POST',
    csrf: true,
    body: { reason },
  });
}

export function deferIntakeIdea(ideaId: string, reason: string | null): Promise<ApiResult<{ readonly idea: IntakeIdea }>> {
  return request<{ readonly idea: IntakeIdea }>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/defer`, {
    method: 'POST',
    csrf: true,
    body: { reason },
  });
}

export function fetchRelatedWork(
  ideaId: string,
): Promise<ApiResult<{ readonly related: readonly RelatednessReport[] }>> {
  return request<{ readonly related: readonly RelatednessReport[] }>(
    `${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/related`,
    { method: 'GET', csrf: false },
  );
}

export function recordRelatedWorkChoice(
  ideaId: string,
  candidateIdeaId: string,
  choice: RelatedWorkChoice,
): Promise<ApiResult<{ readonly choice: RelatedWorkChoiceOutcome }>> {
  return request<{ readonly choice: RelatedWorkChoiceOutcome }>(
    `${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/related/choice/${encodeURIComponent(candidateIdeaId)}`,
    { method: 'POST', csrf: true, body: { choice } },
  );
}

export function draftIntakeBrief(
  ideaId: string,
  draft: {
    readonly authoredBy: 'Owner' | 'ClarificationModel' | 'OwnerEdit';
    readonly sections: BriefSections;
    readonly basedOnBriefVersion: number | null;
  },
): Promise<ApiResult<{ readonly brief: BriefVersion }>> {
  return request<{ readonly brief: BriefVersion }>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/brief`, {
    method: 'POST',
    csrf: true,
    body: draft,
  });
}

export function agreeIntakeBrief(ideaId: string): Promise<ApiResult<{ readonly brief: BriefVersion }>> {
  return request<{ readonly brief: BriefVersion }>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/brief/agree`, {
    method: 'POST',
    csrf: true,
    body: {},
  });
}

export function askIntakeQuestions(
  ideaId: string,
  round: { readonly sections: BriefSections; readonly ambiguities: readonly IntakeAmbiguity[] },
): Promise<ApiResult<ClarificationRound>> {
  return request<ClarificationRound>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/questions`, {
    method: 'POST',
    csrf: true,
    body: round,
  });
}

export function answerIntakeQuestion(
  ideaId: string,
  questionId: string,
  answer: string,
): Promise<ApiResult<{ readonly question: ClarifyingQuestion }>> {
  return request<{ readonly question: ClarifyingQuestion }>(
    `${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/questions/${encodeURIComponent(questionId)}/answer`,
    { method: 'POST', csrf: true, body: { answer } },
  );
}

export function applyIntakeCorrection(
  ideaId: string,
  correction: { readonly text: string; readonly sections: BriefSections; readonly basedOnBriefVersion: number },
): Promise<ApiResult<CorrectionOutcome>> {
  return request<CorrectionOutcome>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/corrections`, {
    method: 'POST',
    csrf: true,
    body: correction,
  });
}

export function exportIntakeIdea(ideaId: string): Promise<ApiResult<{ readonly export: IntakeIdeaExport }>> {
  return request<{ readonly export: IntakeIdeaExport }>(`${INTAKE_ROOT}/ideas/${encodeURIComponent(ideaId)}/export`, {
    method: 'GET',
    csrf: false,
  });
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
