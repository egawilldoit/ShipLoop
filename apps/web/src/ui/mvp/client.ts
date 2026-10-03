/**
 * The MVP owner's HTTP calls.
 *
 * A new module rather than additions to `api-client.ts`, because `api-client.ts` serves the
 * retired surfaces as well as these and the two are on different lifecycles: when the legacy
 * pages are deleted this file goes with them, and `api-client.ts` stays. What this module borrows
 * from it is the transport — the CSRF header, the session-scoped fetch, the refusal envelope and
 * the connection banner's state — because re-implementing those would give the same browser two
 * different ideas about whether it is signed in and whether the view is current.
 *
 * Every endpoint below is an **integration assumption** (see `wire.ts`). None of these routes
 * exist in this worktree: the backend is being built in parallel from the same shared contract.
 * The paths are named here so that building them is a transcription rather than a negotiation, and
 * so that a mismatch is one file to fix instead of one page per screen.
 *
 * Conventions taken from the existing server so the backend has nothing new to decide:
 *   - `GET` for reads, `POST` for writes. No other verb is used anywhere in this product.
 *   - Writes carry the session's derived CSRF token on the `x-shiploop-csrf` header.
 *   - A refusal is `{ error: { code, message, fields, prerequisites } }`, which
 *     `api-client.ts` already reads.
 *   - Every response carries its identity in the body (`{ contract }`, `{ items }`, …) rather than
 *     in the URL, so a client never reconstructs state from a path it built.
 */

import { request as sendJson } from '../api-client.ts';
import type { ApiResult } from '../api-client.ts';
import type {
  Candidate,
  DeliveryContract,
  HomeBoard,
  HandoffPacket,
  OwnerDecision,
  ProjectSettings,
  ProjectSettingsInput,
  RequestRecord,
  ReviewDetail,
  ReviewQueue,
  VerificationType,
} from './wire.ts';

/** `POST /api/requests` — captures a request and opens its first Delivery Contract draft. */
export function createRequest(input: {
  readonly projectId: string | null;
  readonly title: string;
  readonly description: string;
}): Promise<ApiResult<{ readonly request: RequestRecord; readonly contract: DeliveryContract }>> {
  return sendJson('/api/requests', { method: 'POST', csrf: true, body: input });
}

/**
 * `GET /api/home?projectId=` — the three Home groups, as facts.
 *
 * `projectId` is omitted rather than sent empty when no project is selected, so a request is never
 * built for a project literally named "undefined". The server answers with `projectId: null` when
 * the owner has no project, which the page renders as "no project yet" rather than as an empty
 * project.
 */
export function fetchHome(projectId: string | null): Promise<ApiResult<{ readonly home: HomeBoard }>> {
  const query = projectId === null ? '' : `?projectId=${encodeURIComponent(projectId)}`;
  return sendJson(`/api/home${query}`, { method: 'GET', csrf: false });
}

/**
 * `GET /api/contracts/:contractId` — the contract, and the request it belongs to.
 *
 * One read rather than two: the page shows both, and asking twice would let the two answers come
 * from different instants, which is how a page ends up showing a criterion from revision 3 under a
 * revision 2 heading.
 */
export function fetchContract(
  contractId: string,
): Promise<ApiResult<{ readonly contract: DeliveryContract; readonly request: RequestRecord }>> {
  return sendJson(`/api/contracts/${encodeURIComponent(contractId)}`, { method: 'GET', csrf: false });
}

/**
 * `POST /api/contracts/:contractId` — saves the draft.
 *
 * The server owns the revision rule. This client states the rule it expects as a comment and never
 * sends a revision number of its own: a client that sends "expectedRevision" would be offering the
 * domain a second opinion about concurrency, and `saveIntent` already decided what has to happen
 * for the owner to see.
 */
export function saveContract(
  contractId: string,
  body: {
    readonly outcome: string;
    readonly scope: string;
    readonly outOfScope: readonly string[];
    readonly acceptanceCriteria: readonly {
      readonly id: string | null;
      readonly description: string;
      readonly verificationType: VerificationType;
    }[];
  },
): Promise<ApiResult<{ readonly contract: DeliveryContract }>> {
  return sendJson(`/api/contracts/${encodeURIComponent(contractId)}`, { method: 'POST', csrf: true, body });
}

/** `POST /api/contracts/:contractId/approve` — the owner's explicit approval of this revision. */
export function approveContract(contractId: string): Promise<ApiResult<{ readonly contract: DeliveryContract }>> {
  return sendJson(`/api/contracts/${encodeURIComponent(contractId)}/approve`, { method: 'POST', csrf: true, body: {} });
}

/**
 * `POST /api/contracts/:contractId/handoff` — "Prepare implementation".
 *
 * This creates an artefact and nothing else. It starts no agent, queues no run and reports no
 * progress: external execution is outside ShipLoop, so the response is the packet the owner will
 * hand to T3 themselves.
 */
export function prepareImplementation(
  contractId: string,
): Promise<ApiResult<{ readonly packet: HandoffPacket }>> {
  return sendJson(`/api/contracts/${encodeURIComponent(contractId)}/handoff`, { method: 'POST', csrf: true, body: {} });
}

/**
 * `POST /api/candidates` — links the GitHub pull request that implements an approved revision.
 *
 * `headSha` must be the full 40-character commit SHA. The client checks it first (see `sha.ts`)
 * and the server must check it again; a candidate recorded against an abbreviated SHA cannot be
 * compared with a checkout and cannot be shown stale when the branch moves.
 */
export function linkCandidate(input: {
  readonly contractId: string;
  readonly repository: string;
  readonly pullRequestNumber: number | null;
  readonly pullRequestUrl: string | null;
  readonly baseBranch: string;
  readonly headSha: string;
}): Promise<ApiResult<{ readonly candidate: Candidate }>> {
  return sendJson('/api/candidates', { method: 'POST', csrf: true, body: input });
}

/** `GET /api/review?projectId=` — the candidates awaiting an owner decision. */
export function fetchReviewQueue(projectId: string | null): Promise<ApiResult<{ readonly queue: ReviewQueue }>> {
  const query = projectId === null ? '' : `?projectId=${encodeURIComponent(projectId)}`;
  return sendJson(`/api/review${query}`, { method: 'GET', csrf: false });
}

/** `GET /api/review/:candidateId` — checks, criteria, evidence and staleness for one candidate. */
export function fetchReview(candidateId: string): Promise<ApiResult<{ readonly review: ReviewDetail }>> {
  return sendJson(`/api/review/${encodeURIComponent(candidateId)}`, { method: 'GET', csrf: false });
}

/**
 * `POST /api/review/:candidateId/decision` — the owner's decision.
 *
 * `accepted` and `changes_requested` are the only two values the MVP allows, and the server
 * records the decision against the full SHA and the contract revision it was made about. Nothing
 * else in the product creates an acceptance: this call is the whole of it.
 */
export function recordDecision(
  candidateId: string,
  decision: 'accepted' | 'changes_requested',
  feedback: string | null,
): Promise<ApiResult<{ readonly decision: OwnerDecision }>> {
  return sendJson(`/api/review/${encodeURIComponent(candidateId)}/decision`, {
    method: 'POST',
    csrf: true,
    body: feedback === null ? { decision } : { decision, feedback },
  });
}

/** `GET /api/projects/:projectId/settings` — everything Settings owns, in one read. */
export function fetchSettings(projectId: string): Promise<ApiResult<{ readonly settings: ProjectSettings }>> {
  return sendJson(`/api/projects/${encodeURIComponent(projectId)}/settings`, { method: 'GET', csrf: false });
}

/**
 * `POST /api/projects/:projectId/settings` — saves project, GitHub, optional Linear and the
 * optional T3 address.
 *
 * Optional connectors are sent as `null` when the owner cleared them. Sending an empty string
 * instead would leave the server to guess whether "no team key" means "unconfigured" or
 * "configured with a blank team".
 */
export function saveSettings(
  projectId: string,
  input: ProjectSettingsInput,
): Promise<ApiResult<{ readonly settings: ProjectSettings }>> {
  return sendJson(`/api/projects/${encodeURIComponent(projectId)}/settings`, { method: 'POST', csrf: true, body: input });
}

/** `GET /api/projects/:projectId/settings` — everything Settings owns, in one read. */