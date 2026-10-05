/**
 * The HTTP boundary for the post-approval flow: GitHub candidate, refresh, verification and project
 * settings.
 *
 * ## PARTLY REPLACED BY `../mvp-client/index.ts` — WHAT REMAINS HERE, AND WHY
 *
 * This module was a single local stand-in, written because the MVP browser client is being built in
 * parallel. The handoff half of this flow no longer needs it: `HandoffPage.tsx` now reads the packet
 * through `fetchHandoff` and the approved text's fingerprint through `getContract` from
 * `../mvp-client/index.ts`, and the handoff types and reader this file carried are deleted rather than
 * left behind as a second spelling of the same wire shapes (mvp-spec 7, N02-AC2).
 *
 * What is still here is the part another surface owns and has not re-pointed:
 *
 *   - `CandidatePage.tsx` — the GitHub candidate link, read, refresh and verification calls;
 *   - `ExternalToolSetting.tsx` — the project's settings read and the `t3Url` save;
 *   - `ObservationRow.tsx` / `observation-standing.ts` — the `RecordedObservation` type, which is a
 *     response shape only.
 *
 * Those three are not re-pointed in the work that re-pointed the handoff, so deleting the file now
 * would break them. The migration is therefore: the next change to this file re-points
 * `CandidatePage.tsx` and `ExternalToolSetting.tsx` at `../mvp-client/index.ts`, and then this module
 * is deleted outright. Nothing below this line holds a URL, a method, or a body shape outside these
 * calls, so the remaining migration is an import rewrite and a delete.
 *
 * ## The routes, and the handler each answer came from
 *
 * Every route below was read before it was called. The names in the comments are the files in
 * `apps/web/src/server/routes/` that define the handler, and each entry states the property of
 * that handler this module depends on — not a restatement of it (mvp-spec 7).
 *
 *   POST  /api/projects/:projectId/candidates
 *         → `routes/candidates.ts`. Body is exactly `requestId`, `contractId`,
 *           `contractRevision`, `pullRequestUrl` under `strictObject`. There is no head-SHA
 *           field, no branch field and no pull-request-number field to send, because identity is
 *           read from the provider and is not the owner's to assert. Answers 201 with
 *           `{ candidate }` as a `LinkedCandidateReport`.
 *   GET   /api/projects/:projectId/candidates/:candidateId
 *         → `routes/candidates.ts`. Answers `{ candidate }` as a `CandidateReport`. This `GET`
 *           talks to the provider on purpose; it is an observation, not a cache.
 *   POST  /api/projects/:projectId/candidates/:candidateId/refresh
 *         → `routes/candidates.ts`. Body is `strictObject({})` and `nullish`: a refresh carries
 *           nothing, and a body that tried to say what changed is refused rather than dropped.
 *           Answers `{ candidate }` with `change` and `evidence` made explicit.
 *   POST  /api/projects/:projectId/candidates/:candidateId/verify
 *         → `routes/verification.ts`. Body is a `strictObject` with one optional member
 *           (`method`) and nothing else. There is deliberately no `result`, `outcome`, `checkId`,
 *           `criterionId` or `headSha`; a body carrying any of them is refused by name, because a
 *           browser must not be able to state what a check concluded. This module therefore sends
 *           `method` alone and reads every verdict back off the response (F20-AC2, F23-AC1).
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

/** A commit at full length. The route refuses anything shorter before it answers. */
export type CommitSha = string;

/** What the candidate read reports about the change between the record and the provider. */
export interface CandidateChange {
  readonly kind: string;
  readonly changed: readonly string[];
  readonly changedAnything: boolean;
  readonly previousHeadSha: CommitSha | null;
  readonly currentHeadSha: CommitSha;
  readonly priorEvidenceStale: boolean;
  readonly detail: string;
}

/**
 * Whether evidence recorded against an earlier head still describes this one.
 *
 * `priorReadinessPreserved` is the literal `false` on every response: this transport holds no
 * stored readiness, so a ready status cannot survive a force push (F24-AC4, F25-AC3).
 */
export interface CandidateEvidenceStanding {
  readonly status: 'Current' | 'Stale';
  readonly priorReadinessPreserved: false;
  readonly priorCandidateId: string | null;
  readonly priorHeadSha: CommitSha | null;
  readonly detail: string;
}

/**
 * One provider check, as the candidate read presents it.
 *
 * `result` is the domain's own six words (`Passed`, `Failed`, `Missing`, `Waiting`, `Stale`,
 * `NotApplicable`) rather than the review card's lowercase spelling, because the two transports
 * really do use two spellings and the page must not quietly translate one into the other.
 * `blocking` is computed by the route with the domain's own `isBlocking`, and is read here rather
 * than recomputed (F20-AC2, F20-AC5).
 */
export interface CandidateCheck {
  readonly name: string;
  readonly result: string;
  readonly required: boolean;
  readonly blocking: boolean;
  readonly notApplicableApprovedByPolicy: boolean;
  readonly observedHeadSha: CommitSha | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly artifactUrl: string | null;
  readonly detail: string | null;
}

export interface CandidateReport {
  readonly candidate: {
    readonly candidateId: string;
    readonly projectId: string;
    readonly requestId: string;
    readonly contractId: string;
    readonly contractRevision: number;
    readonly provider: string;
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly pullRequestUrl: string;
    readonly baseBranch: string;
    readonly baseSha: CommitSha;
    readonly headBranch: string;
    readonly headSha: CommitSha;
    readonly pullRequestState: string;
    readonly draft: boolean;
    readonly observedAt: string;
    readonly linkedAt: string;
  };
  readonly live: {
    readonly provider: string;
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly pullRequestUrl: string;
    readonly baseBranch: string;
    readonly baseSha: CommitSha;
    readonly headBranch: string;
    readonly headSha: CommitSha;
    readonly headRepository: string | null;
    readonly pullRequestState: string;
    readonly draft: boolean;
    readonly observedAt: string;
  };
  readonly binding: {
    readonly contractId: string;
    readonly contractRevision: number;
    readonly headSha: CommitSha;
  };
  readonly bindingFingerprint: string;
  readonly change: CandidateChange;
  readonly evidence: CandidateEvidenceStanding;
  readonly supersededCandidateIds: readonly string[];
  readonly checks: readonly CandidateCheck[];
  readonly checksReady: boolean;
  readonly blockingChecks: readonly string[];
  readonly reviewReadiness: { readonly ready: boolean; readonly reasons: readonly string[] };
  readonly observedAt: string;
  /** Always false: no merge, close, approval or protection change happened (mvp-spec F03-AC5). */
  readonly providerWritePerformed: false;
}

/** What a link established. Carries no readiness answer at all, by construction. */
export interface LinkedCandidate {
  readonly candidate: CandidateReport['candidate'];
  readonly live: CandidateReport['live'];
  readonly binding: CandidateReport['binding'];
  readonly bindingFingerprint: string;
  readonly alreadyRecorded: boolean;
  readonly observedAt: string;
  readonly providerWritePerformed: false;
}

/**
 * One automated observation, as the verification report reads it back.
 *
 * Three outcome fields, and the absence of an `outcome` member is the point: `recordedOutcome` is
 * what the source said at the time and stays `passed` after a later push, `currentOutcome` is what
 * that observation means now, and `countsForCurrentCandidate` is the affirmative answer to "may
 * this be shown as this candidate's result". A client handed only the first would render a stale
 * pass in green (F20-AC3, F24-AC3).
 */
export interface RecordedObservation {
  readonly evidenceId: string;
  readonly checkId: string;
  readonly recordedOutcome: string;
  readonly currentOutcome: string;
  readonly countsForCurrentCandidate: boolean;
  readonly observedHeadSha: CommitSha | null;
  readonly observedContractRevision: number | null;
  readonly observedAt: string | null;
  readonly reason: string;
}

/**
 * What one automated verification pass observed.
 *
 * `candidateHeadSha` and `providerHeadSha` are both carried and are allowed to differ, because
 * that difference is the finding: after a push, every check the provider attributed to the newer
 * commit lands unbound and proves nothing about the candidate under review (F20-AC3, F24-AC4).
 */
export interface VerificationReport {
  readonly projectId: string;
  readonly candidateId: string;
  readonly candidateHeadSha: CommitSha;
  readonly providerHeadSha: CommitSha;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly method: string;
  readonly observedAt: string;
  readonly recorded: readonly RecordedObservation[];
  readonly review: VerificationReviewCard;
}

/**
 * Only the part of the review card this flow renders.
 *
 * A projection rather than the whole card: the review card is another surface's read model, and
 * transcribing fields nobody here displays would make this module the second place a card shape is
 * stated (F24-AC2).
 */
export interface VerificationReviewCard {
  readonly collectedAt: string;
  readonly candidate: {
    readonly candidateId: string;
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly pullRequestUrl: string;
    readonly pullRequestState: string;
    readonly draft: boolean;
    readonly baseBranch: string;
    readonly headSha: CommitSha;
    readonly observedAt: string;
  };
  readonly checks: readonly {
    readonly checkId: string;
    readonly required: boolean;
    readonly blocking: boolean;
    readonly result: string;
    readonly evidenceId: string | null;
    readonly source: string | null;
    readonly reason: string;
  }[];
  readonly evidence: readonly {
    readonly evidenceId: string;
    readonly source: string;
    readonly checkId: string | null;
    readonly recordedOutcome: string;
    readonly currentOutcome: string;
    readonly countsForCurrentCandidate: boolean;
    readonly staleReasons: readonly string[];
    readonly reason: string;
    readonly observedAt: string | null;
    readonly candidateHeadSha: CommitSha | null;
    readonly contractRevision: number | null;
    readonly detail: string | null;
  }[];
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

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
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

/*
 * The handoff half of this module was re-pointed at `../mvp-client/index.ts` and removed:
 * `fetchHandoff`, `Handoff`, `HandoffPacket`, `HandoffExternalTool`, `HandoffPrerequisite` and the
 * readers above. Keeping them would have left two spellings of the same wire shapes on disk, and the
 * second one would be free to drift from the route without any test noticing (mvp-spec 7, N02-AC2).
 */

/* -------------------------------------------------------------------------- */
/* Candidate                                                                   */
/* -------------------------------------------------------------------------- */

export interface LinkCandidateInput {
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly pullRequestUrl: string;
}

/**
 * Links the pull request the owner named.
 *
 * The body is exactly the four fields `routes/candidates.ts` accepts. Nothing else is sent: there
 * is no head SHA, no branch, no pull request number, no state and no merge instruction, and the
 * schema would refuse each of them by name (mvp-spec 3, SHARED.md "Candidate").
 */
export async function linkCandidate(
  projectId: string,
  input: LinkCandidateInput,
): Promise<TransportOutcome<LinkedCandidate>> {
  const project = await segment(projectId, 'A project');
  if (!project.ok) return project;
  const outcome = await send('POST', `/api/projects/${project.value}/candidates`, {
    requestId: input.requestId,
    contractId: input.contractId,
    contractRevision: input.contractRevision,
    pullRequestUrl: input.pullRequestUrl,
  });
  const body = envelope<unknown>(outcome, 'candidate');
  if (!body.ok) return body;
  if (!isRecord(body.value) || body.value['providerWritePerformed'] !== false) {
    return malformed('candidate link');
  }
  const report = readCandidateReport(body.value);
  if (!report.ok) return report;
  return answered({
    candidate: report.value.candidate,
    live: report.value.live,
    binding: report.value.binding,
    bindingFingerprint: report.value.bindingFingerprint,
    alreadyRecorded: bool(body.value['alreadyRecorded']),
    observedAt: report.value.observedAt,
    providerWritePerformed: false,
  });
}

/**
 * Reads one candidate from the provider.
 *
 * A read that still contacts the provider on purpose: the card the owner is looking at must be an
 * observation, and a cache that agreed with the last read would present withdrawn work as current
 * (F24-AC4).
 */
export async function fetchCandidate(
  projectId: string,
  candidateId: string,
): Promise<TransportOutcome<CandidateReport>> {
  const path = await candidatePath(projectId, candidateId);
  if (!path.ok) return path;
  const outcome = await send('GET', path.value);
  const body = envelope<unknown>(outcome, 'candidate');
  if (!body.ok) return body;
  return readCandidateReport(body.value);
}

/**
 * Asks for a fresh observation.
 *
 * Sends no body at all rather than an empty one. The route accepts an absent body, and a refresh
 * has nothing to submit; refusing a POST that sent nothing would be an obstacle rather than a
 * protection (mvp-spec F20-AC3).
 */
export async function refreshCandidate(
  projectId: string,
  candidateId: string,
): Promise<TransportOutcome<CandidateReport>> {
  const path = await candidatePath(projectId, candidateId);
  if (!path.ok) return path;
  const outcome = await send('POST', `${path.value}/refresh`);
  const body = envelope<unknown>(outcome, 'candidate');
  if (!body.ok) return body;
  return readCandidateReport(body.value);
}

async function candidatePath(projectId: string, candidateId: string): Promise<TransportOutcome<string>> {
  const project = await segment(projectId, 'A project');
  if (!project.ok) return project;
  const candidate = await segment(candidateId, 'A candidate');
  if (!candidate.ok) return candidate;
  return answered(`/api/projects/${project.value}/candidates/${candidate.value}`);
}

function readCandidateReport(value: unknown): TransportOutcome<CandidateReport> {
  if (!isRecord(value)) return malformed('candidate');
  const recorded = value['candidate'];
  const live = value['live'];
  const binding = value['binding'];
  const change = value['change'];
  const evidence = value['evidence'];
  const readiness = value['reviewReadiness'];
  if (
    !isRecord(recorded) ||
    !isRecord(live) ||
    !isRecord(binding) ||
    !isRecord(change) ||
    !isRecord(evidence) ||
    !isRecord(readiness)
  ) {
    return malformed('candidate');
  }
  const headSha = str(recorded['headSha']);
  const liveHeadSha = str(live['headSha']);
  const baseSha = str(recorded['baseSha']);
  const previousHeadSha = optionalStr(change['previousHeadSha']);
  if (headSha === null || liveHeadSha === null || baseSha === null) return malformed('candidate');
  const observedAt = str(live['observedAt']);
  const liveObservedAt = str(live['observedAt']);
  const recordedObservedAt = str(recorded['observedAt']);
  if (observedAt === null || liveObservedAt === null || recordedObservedAt === null) {
    return malformed('candidate');
  }
  return answered({
    candidate: {
      candidateId: str(recorded['candidateId']) ?? '',
      projectId: str(recorded['projectId']) ?? '',
      requestId: str(recorded['requestId']) ?? '',
      contractId: str(recorded['contractId']) ?? '',
      contractRevision: num(recorded['contractRevision'], 0),
      provider: str(recorded['provider']) ?? str(live['provider']) ?? '',
      repository: str(recorded['repository']) ?? str(live['repository']) ?? '',
      pullRequestNumber: num(recorded['pullRequestNumber'], num(live['pullRequestNumber'], 0)),
      pullRequestUrl: str(recorded['pullRequestUrl']) ?? '',
      baseBranch: str(recorded['baseBranch']) ?? str(live['baseBranch']) ?? '',
      baseSha,
      headBranch: str(recorded['headBranch']) ?? str(live['headBranch']) ?? '',
      headSha,
      pullRequestState: str(recorded['pullRequestState']) ?? str(live['pullRequestState']) ?? '',
      draft: bool(recorded['draft']) || bool(live['draft']),
      observedAt: recordedObservedAt,
      linkedAt: str(recorded['linkedAt']) ?? recordedObservedAt,
    },
    live: {
      provider: str(live['provider']) ?? '',
      repository: str(live['repository']) ?? '',
      pullRequestNumber: num(live['pullRequestNumber'], 0),
      pullRequestUrl: str(live['pullRequestUrl']) ?? '',
      baseBranch: str(live['baseBranch']) ?? '',
      baseSha: str(live['baseSha']) ?? baseSha,
      headBranch: str(live['headBranch']) ?? '',
      headSha: liveHeadSha,
      headRepository: optionalStr(live['headRepository']),
      pullRequestState: str(live['pullRequestState']) ?? '',
      draft: bool(live['draft']),
      observedAt: liveObservedAt,
    },
    binding: {
      contractId: str(binding['contractId']) ?? '',
      contractRevision: num(binding['contractRevision'], 0),
      headSha,
    },
    bindingFingerprint: str(value['bindingFingerprint']) ?? '',
    change: {
      kind: str(change['kind']) ?? '',
      changed: strings(change['changed']),
      changedAnything: bool(change['changedAnything']),
      previousHeadSha,
      currentHeadSha: str(change['currentHeadSha']) ?? liveHeadSha,
      priorEvidenceStale: bool(change['priorEvidenceStale']),
      detail: str(change['detail']) ?? '',
    },
    evidence: {
      status: evidence['status'] === 'Stale' ? 'Stale' : 'Current',
      priorReadinessPreserved: false,
      priorCandidateId: optionalStr(evidence['priorCandidateId']),
      priorHeadSha: optionalStr(evidence['priorHeadSha']),
      detail: str(evidence['detail']) ?? '',
    },
    supersededCandidateIds: strings(value['supersededCandidateIds']),
    checks: records(value['checks']).flatMap((entry) => {
      const name = str(entry['name']);
      const result = str(entry['result']);
      if (name === null || result === null) return [];
      return [
        {
          name,
          result,
          required: bool(entry['required']),
          blocking: bool(entry['blocking']),
          notApplicableApprovedByPolicy: bool(entry['notApplicableApprovedByPolicy']),
          observedHeadSha: optionalStr(entry['observedHeadSha']),
          startedAt: optionalStr(entry['startedAt']),
          endedAt: optionalStr(entry['endedAt']),
          artifactUrl: optionalStr(entry['artifactUrl']),
          detail: optionalStr(entry['detail']),
        },
      ];
    }),
    checksReady: bool(value['checksReady']),
    blockingChecks: strings(value['blockingChecks']),
    reviewReadiness: {
      ready: bool(readiness['ready']),
      reasons: strings(readiness['reasons']),
    },
    observedAt,
    providerWritePerformed: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Reads the provider's check results for one candidate and records what it said.
 *
 * The body carries `method` and nothing else. That is the whole of what this transport is allowed
 * to say: the schema has one optional member and refuses a body carrying `result`, `outcome`,
 * `checkId`, `criterionId`, `headSha`, `candidateId` or `evidenceId` by name, because each of
 * those would be a way for the browser to state what a check concluded. Every verdict this screen
 * shows is read back off the response, which is the only direction the truth can travel in
 * (F20-AC2, F23-AC1).
 */
export async function runVerification(
  projectId: string,
  candidateId: string,
): Promise<TransportOutcome<VerificationReport>> {
  const path = await candidatePath(projectId, candidateId);
  if (!path.ok) return path;
  const outcome = await send('POST', `${path.value}/verify`, { method: 'github_checks' });
  const body = envelope<unknown>(outcome, 'verification');
  if (!body.ok) return body;
  return readVerificationReport(body.value);
}

function readVerificationReport(value: unknown): TransportOutcome<VerificationReport> {
  if (!isRecord(value)) return malformed('verification');
  const candidateHeadSha = str(value['candidateHeadSha']);
  const providerHeadSha = str(value['providerHeadSha']);
  const review = value['review'];
  if (candidateHeadSha === null || providerHeadSha === null || !isRecord(review)) {
    return malformed('verification');
  }
  const collectedAt = str(review['collectedAt']);
  const cardCandidate = review['candidate'];
  if (collectedAt === null || !isRecord(cardCandidate)) return malformed('verification');
  const cardHeadSha = str(cardCandidate['headSha']);
  if (cardHeadSha === null) return malformed('verification');

  const recorded = records(value['recorded']).flatMap((entry) => {
    const evidenceId = str(entry['evidenceId']);
    const checkId = str(entry['checkId']);
    const recordedOutcome = str(entry['recordedOutcome']);
    const currentOutcome = str(entry['currentOutcome']);
    if (evidenceId === null || checkId === null || recordedOutcome === null || currentOutcome === null) {
      return [];
    }
    return [
      {
        evidenceId,
        checkId,
        recordedOutcome,
        currentOutcome,
        countsForCurrentCandidate: bool(entry['countsForCurrentCandidate']),
        observedHeadSha: optionalStr(entry['observedHeadSha']),
        observedContractRevision:
          typeof entry['observedContractRevision'] === 'number' ? entry['observedContractRevision'] : null,
        observedAt: optionalStr(entry['observedAt']),
        reason: str(entry['reason']) ?? '',
      },
    ];
  });

  return answered({
    projectId: str(value['projectId']) ?? '',
    candidateId: str(value['candidateId']) ?? '',
    candidateHeadSha,
    providerHeadSha,
    contractId: str(value['contractId']) ?? '',
    contractRevision: num(value['contractRevision'], 0),
    method: str(value['method']) ?? '',
    observedAt: str(value['observedAt']) ?? collectedAt,
    recorded,
    review: {
      collectedAt,
      candidate: {
        candidateId: str(cardCandidate['candidateId']) ?? '',
        repository: str(cardCandidate['repository']) ?? '',
        pullRequestNumber: num(cardCandidate['pullRequestNumber'], 0),
        pullRequestUrl: str(cardCandidate['pullRequestUrl']) ?? '',
        pullRequestState: str(cardCandidate['pullRequestState']) ?? '',
        draft: bool(cardCandidate['draft']),
        baseBranch: str(cardCandidate['baseBranch']) ?? '',
        headSha: cardHeadSha,
        observedAt: str(cardCandidate['observedAt']) ?? collectedAt,
      },
      checks: records(review['checks']).flatMap((entry) => {
        const checkId = str(entry['checkId']);
        const result = str(entry['result']);
        if (checkId === null || result === null) return [];
        return [
          {
            checkId,
            required: bool(entry['required']),
            blocking: bool(entry['blocking']),
            result,
            evidenceId: optionalStr(entry['evidenceId']),
            source: optionalStr(entry['source']),
            reason: str(entry['reason']) ?? '',
          },
        ];
      }),
      evidence: records(review['evidence']).flatMap((entry) => {
        const evidenceId = str(entry['evidenceId']);
        const recordedOutcome = str(entry['recordedOutcome']);
        const currentOutcome = str(entry['currentOutcome']);
        if (evidenceId === null || recordedOutcome === null || currentOutcome === null) return [];
        return [
          {
            evidenceId,
            source: str(entry['source']) ?? '',
            checkId: optionalStr(entry['checkId']),
            recordedOutcome,
            currentOutcome,
            countsForCurrentCandidate: bool(entry['countsForCurrentCandidate']),
            staleReasons: strings(entry['staleReasons']),
            reason: str(entry['reason']) ?? '',
            observedAt: optionalStr(entry['observedAt']),
            candidateHeadSha: optionalStr(entry['candidateHeadSha']),
            contractRevision:
              typeof entry['contractRevision'] === 'number' ? entry['contractRevision'] : null,
            detail: optionalStr(entry['detail']),
          },
        ];
      }),
    },
  });
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