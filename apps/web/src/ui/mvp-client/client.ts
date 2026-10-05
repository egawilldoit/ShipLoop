/**
 * Every MVP client call, one function per route, and the route each one hits.
 *
 * The previous wave's UI shipped against `/api/requests`, `/api/contracts/:id`, `/api/home`,
 * `/api/review` and `/api/candidates` — none of which this server registers. Every function
 * below names the handler it was read from, and every project-scoped path is built in
 * `transport.ts` from a `ProjectScope`, so there is no way to spell an unscoped URL from a page
 * (mvp-spec 3, F02-AC2).
 *
 * Three conventions hold throughout, and each exists because the alternative produced a
 * specific wrong answer:
 *
 *   - **A write returns the state the server produced, not a bare acknowledgement.** Creating a
 *     request answers `{ request }`, drafting a contract answers `{ contract }`, a decision
 *     answers the whole card. A page that re-read afterwards could render a state that disagrees
 *     with the write it just made, which is how "accepted" appears on a card the decision route
 *     never accepted (F24-AC2, F25-AC2).
 *   - **Approval and decision return a discriminated outcome, not a boolean.** `approveRevision`
 *     and `decideCandidate` answer a union whose members name the failure the owner has to be
 *     shown differently: `contract-changed` and `superseded-commit` mean a reload, `not-eligible`
 *     means outstanding requirements are named, and `refused` means anything else. A `409` from
 *     either is never reported as success and never discards what the owner typed (mvp-spec 7,
 *     F24-AC4, F25-AC3).
 *   - **`verifyCandidate` sends nothing but at most `method`.** `routes/verification.ts` parses a
 *     `strictObject` with one optional member and no `result`, `outcome`, `checkId`, `criterionId`
 *     or `headSha`, and refuses a body carrying any of them by name — the server owns the verdict
 *     (F20-AC2, F23-AC1).
 */

import {
  envelope,
  failed,
  idSegment,
  profileScopedGet,
  revisionSegment,
  scopedGet,
  scopedSend,
  send,
  type MvpFailure,
  type MvpResult,
} from './transport.ts';
import type {
  ActiveProjectView,
  ContractCriterionView,
  ContractView,
  HandoffView,
  HomeProjection,
  LinkedCandidateReport,
  OwnerTestReportView,
  ProfileVersionView,
  ProjectSettingsView,
  ProjectView,
  ProjectScope,
  RequestDetailView,
  RequestView,
  ReviewCardView,
  CandidateReport,
  SessionView,
  VerificationReportView,
} from './types.ts';

/* -------------------------------------------------------------------------- */
/* Project scope                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The project a page is acting in, or an explicit statement that none is selected.
 *
 * The only bridge from `session.owner.activeProject` to the `ProjectScope` every project-scoped
 * call takes. Two rules hold here, and they are the reason the function exists:
 *
 *   - **A `Selected` variant yields its id; a `NoProjectSelected` variant yields none.** There is
 *     no fallback, no default and no placeholder, because there is no project row to fall back on
 *     — and a request for a project literally named `undefined` was the defect the server's honest
 *     404 was then misreported against (F02-AC1, F02-AC4).
 *   - **`selectableProjectCount` travels into the refusal**, so a page can say "choose one of
 *     three" rather than showing an empty selector, and "create one first" when there is nothing
 *     to choose from.
 *
 * A page holding no scope must render the onboarding state. It must not call a project-scoped
 * function, and it cannot: every one of them requires a `ProjectScope` by type.
 */
export function projectScopeOf(activeProject: ActiveProjectView | null): ProjectScope {
  if (activeProject === null) {
    return { kind: 'no-project-selected', selectableProjectCount: 0 };
  }
  if (activeProject.state === 'NoProjectSelected') {
    return { kind: 'no-project-selected', selectableProjectCount: activeProject.selectableProjectCount };
  }
  return {
    kind: 'project',
    projectId: activeProject.activeProjectId,
    projectName: activeProject.activeProjectName,
  };
}

/**
 * The project id, or null.
 *
 * For a navigation key or a test selector. Never for addressing a request: a page that has an id
 * in hand still goes through the `ProjectScope` its call takes, so there is one spelling of
 * "which project" rather than two (F02-AC1).
 */
export function projectIdOf(scope: ProjectScope): string | null {
  return scope.kind === 'project' ? scope.projectId : null;
}

/* -------------------------------------------------------------------------- */
/* Session and project identity                                                */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/owner/session` — the signed-in owner, the session, and which project this session
 * addresses. Read in `apps/web/src/server/routes/owner.ts`.
 *
 * This is the only source of project identity in the client. `activeProject` travels here rather
 * than being fetched separately, and there is nothing to derive and nothing to fall back on: when
 * `state` is `NoProjectSelected` there is no project id to obtain, and the correct response is
 * `projectScopeOf()` reporting that rather than a page inventing one (F02-AC1, F02-AC4).
 */
export function fetchSession(): Promise<MvpResult<SessionView>> {
  return send<SessionView>({ method: 'GET', path: '/api/owner/session' });
}

/**
 * `POST /api/owner/sign-in` — provisions the session cookie and returns the same block as
 * `fetchSession`. Unauthenticated, and it carries no CSRF token because there is no session to
 * derive one from yet (F01-AC1, F01-AC4).
 */
export function signIn(credentials: {
  readonly identifier: string;
  readonly password: string;
}): Promise<MvpResult<SessionView>> {
  return send<SessionView>({
    method: 'POST',
    path: '/api/owner/sign-in',
    body: { identifier: credentials.identifier, password: credentials.password },
  });
}

/**
 * `POST /api/owner/sign-out` — revokes server-side and clears the cookie. 204 with no body, so
 * nothing is read from the response (F01-AC2).
 */
export async function signOut(): Promise<MvpResult<null>> {
  const result = await send<null>({ method: 'POST', path: '/api/owner/sign-out' });
  return result;
}

/**
 * `PUT /api/owner/active-project` — chooses the project every subsequent project-scoped call
 * addresses. Read in `routes/owner.ts`.
 *
 * A server-side write rather than a value the client keeps, because a selection the client holds
 * is a selection the next page load does not have — which is the defect that produced requests for
 * a project named `undefined` (F02-AC1). Null is not accepted: "no project selected" is reached by
 * never selecting one, so a client asking to select nothing is refused rather than silently
 * clearing the owner's choice.
 */
export async function selectActiveProject(projectId: string): Promise<MvpResult<SessionView['owner']['activeProject']>> {
  const body = await send<{ readonly activeProject: SessionView['owner']['activeProject'] }>({
    method: 'PUT',
    path: '/api/owner/active-project',
    body: { projectId },
  });
  if (!body.ok) return body;
  return envelope<SessionView['owner']['activeProject']>(body.value, 'activeProject', '/api/owner/active-project');
}

/**
 * `GET /api/projects` — every project this deployment holds, archived included. Read in
 * `routes/projects.ts`.
 *
 * Not project-scoped, and correctly so: there is no project to scope it to. This is what the
 * selector offers, and it is a durable read rather than anything derived from the session (F02-AC1).
 */
export async function listProjects(): Promise<MvpResult<readonly ProjectView[]>> {
  const body = await send<{ readonly projects: readonly ProjectView[] }>({ method: 'GET', path: '/api/projects' });
  if (!body.ok) return body;
  return envelope<readonly ProjectView[]>(body.value, 'projects', '/api/projects');
}

/**
 * `POST /api/projects` — creates a project, or addresses the one already holding that identity.
 * Read in `routes/projects.ts`. 201 on a row this call created and 200 on one that existed; both
 * carry the project, and the status is what tells a page whether to announce a creation (F02-AC3).
 */
export async function createProject(input: {
  readonly projectId: string;
  readonly name: string;
}): Promise<MvpResult<ProjectView>> {
  const body = await send<{ readonly project: ProjectView }>({
    method: 'POST',
    path: '/api/projects',
    body: input,
  });
  if (!body.ok) return body;
  return envelope<ProjectView>(body.value, 'project', '/api/projects');
}

/* -------------------------------------------------------------------------- */
/* Home                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/projects/:projectId/home` — `needsYou`, `inProgress`, `readyForReview`. Read in
 * `routes/home.ts`.
 *
 * Three independent lists rather than a partition: a candidate with current automated evidence
 * and a pending owner test is truthfully in two of them, and deduplicating it away drops a true
 * statement (F24-AC3). A deployment composed without the candidate and review projections answers
 * 503 with a named reason rather than three empty lists, so a `Disconnected`/`Unavailable`
 * refusal here must not be rendered as "nothing needs you" (mvp-spec 3).
 */
export async function fetchHome(scope: ProjectScope): Promise<MvpResult<HomeProjection>> {
  const body = await scopedGet<{ readonly home: HomeProjection }>(scope, '/home');
  if (!body.ok) return body;
  return envelope<HomeProjection>(body.value, 'home', '/api/projects/:projectId/home');
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/projects/:projectId/requests` — every request of this project, newest first. Read in
 * `routes/contracts.ts`.
 */
export async function listRequests(scope: ProjectScope): Promise<MvpResult<readonly RequestView[]>> {
  const body = await scopedGet<{ readonly requests: readonly RequestView[] }>(scope, '/requests');
  if (!body.ok) return body;
  return envelope<readonly RequestView[]>(body.value, 'requests', '/api/projects/:projectId/requests');
}

/**
 * `POST /api/projects/:projectId/requests` — creates a request. Read in `routes/contracts.ts`.
 * 201 with the created record, because a request this call created and one that already existed
 * are different outcomes (mvp-spec 7). No engine is consulted, so this works on a deployment that
 * has configured none.
 */
export async function createRequest(
  scope: ProjectScope,
  input: { readonly title: string; readonly description: string },
): Promise<MvpResult<RequestView>> {
  const body = await scopedSend<{ readonly request: RequestView }>(scope, 'POST', '/requests', input);
  if (!body.ok) return body;
  return envelope<RequestView>(body.value, 'request', '/api/projects/:projectId/requests');
}

/**
 * `GET /api/projects/:projectId/requests/:requestId` — the request with the contract state
 * answering it. Read in `routes/contracts.ts`.
 *
 * The one response in that file answered **unwrapped**, so no envelope member is read here. It is
 * the request plus `latestRevision`, `approvedRevision` and `revisions`, which is what a page needs
 * to know which revision is approved and which is being edited without a second round trip that
 * could describe a different moment (mvp-spec 3).
 */
export function getRequest(scope: ProjectScope, requestId: string): Promise<MvpResult<RequestDetailView>> {
  return scopedGet<RequestDetailView>(scope, `/requests/${idSegment(requestId)}`);
}

/**
 * `PATCH /api/projects/:projectId/requests/:requestId` — edits a request draft. Read in
 * `routes/contracts.ts`.
 *
 * `expectedUpdatedAt` is required by the route's `strictObject`, and it is what turns a stale
 * editor into a `Conflict` rather than a silent overwrite of somebody else's text (F02-AC2,
 * F24-AC4). The caller therefore has to hold the `updatedAt` of the read it rendered.
 */
export async function updateRequest(
  scope: ProjectScope,
  requestId: string,
  input: {
    readonly title?: string;
    readonly description?: string;
    readonly expectedUpdatedAt: string;
  },
): Promise<MvpResult<RequestView>> {
  const body = await scopedSend<{ readonly request: RequestView }>(
    scope,
    'PATCH',
    `/requests/${idSegment(requestId)}`,
    {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
      expectedUpdatedAt: input.expectedUpdatedAt,
    },
  );
  if (!body.ok) return body;
  return envelope<RequestView>(body.value, 'request', '/api/projects/:projectId/requests/:requestId');
}

/* -------------------------------------------------------------------------- */
/* Contracts                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The contract content one draft, edit or revise submits.
 *
 * One shape for all three because they are the same decision, and three shapes would be three
 * places for them to drift. `verificationCheckId` is required here — as `string | null` rather
 * than optional — so a caller cannot omit it and be refused at approval for a binding they
 * intended to state: `strictObject` on the route means an automated criterion must name one of the
 * project's configured check names, and an owner test must carry `null` (F23-AC1, F24-AC3).
 */
export interface ContractContentInput {
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly {
    readonly id: string;
    readonly description: string;
    readonly verificationType: 'automated' | 'owner_test';
    /** A check name from the project's profile for `automated`; `null` for `owner_test`. */
    readonly verificationCheckId: string | null;
  }[];
}

/**
 * `GET /api/projects/:projectId/requests/:requestId/contracts` — every revision of this request,
 * oldest first. Read in `routes/contracts.ts`.
 */
export async function listContractRevisions(
  scope: ProjectScope,
  requestId: string,
): Promise<MvpResult<readonly ContractView[]>> {
  const body = await scopedGet<{ readonly contracts: readonly ContractView[] }>(
    scope,
    `/requests/${idSegment(requestId)}/contracts`,
  );
  if (!body.ok) return body;
  return envelope<readonly ContractView[]>(body.value, 'contracts', '/api/projects/:projectId/requests/:requestId/contracts');
}

/**
 * `POST /api/projects/:projectId/requests/:requestId/contracts` — drafts revision 1. Read in
 * `routes/contracts.ts`. 201 with the drafted revision.
 */
export async function draftContract(
  scope: ProjectScope,
  requestId: string,
  content: ContractContentInput,
): Promise<MvpResult<ContractView>> {
  const body = await scopedSend<{ readonly contract: ContractView }>(
    scope,
    'POST',
    `/requests/${idSegment(requestId)}/contracts`,
    content,
  );
  if (!body.ok) return body;
  return envelope<ContractView>(body.value, 'contract', '/api/projects/:projectId/requests/:requestId/contracts');
}

/**
 * `GET /api/projects/:projectId/contracts/:contractId/:revision` — one revision, addressed by its
 * own number. Read in `routes/contracts.ts`.
 *
 * The revision is a positive integer in the path and is not decoration: a candidate and its
 * evidence bind to it, so addressing a revision without its number addresses something
 * unidentifiable (mvp-spec 3). `contentFingerprint` from this read is the CAS token
 * `approveContract` sends back.
 */
export function getContract(
  scope: ProjectScope,
  contractId: string,
  revision: number,
): Promise<MvpResult<ContractView>> {
  return scopedGet<{ readonly contract: ContractView }>(
    scope,
    `/contracts/${idSegment(contractId)}/${revisionSegment(revision)}`,
  ).then((body) => (body.ok ? envelope<ContractView>(body.value, 'contract', CONTRACT_ROUTE) : body));
}

/**
 * `GET /api/projects/:projectId/contracts/:contractId/:revision/criteria` — the acceptance
 * criteria of one revision, in the order they were written. Read in `routes/contracts.ts`.
 *
 * A separate read because criteria are what verification and the review card read and they change
 * only when the revision does, so a client polling them need not carry the whole revision
 * (mvp-spec 3, mvp-spec 7).
 */
export async function listContractCriteria(
  scope: ProjectScope,
  contractId: string,
  revision: number,
): Promise<MvpResult<readonly ContractCriterionView[]>> {
  const body = await scopedGet<{ readonly criteria: readonly ContractCriterionView[] }>(
    scope,
    `/contracts/${idSegment(contractId)}/${revisionSegment(revision)}/criteria`,
  );
  if (!body.ok) return body;
  return envelope<readonly ContractCriterionView[]>(
    body.value,
    'criteria',
    CONTRACT_ROUTE + '/criteria',
  );
}

/**
 * `PATCH /api/projects/:projectId/contracts/:contractId/:revision` — edits a draft revision in
 * place. Read in `routes/contracts.ts`.
 *
 * `expectedContentFingerprint` is required by the route, and a stale editor is a `Conflict`
 * rather than an overwrite. It is the `contentFingerprint` of the read that was rendered, the
 * same value `approveContract` sends, because it is the only token that identifies the text
 * this call is about: a revision number outlives its text and two writes can share a
 * millisecond, so an instant would let the second of two tabs land over the first. An approved
 * revision answers 400 here; `reviseContract` is the way forward (mvp-spec 3, F24-AC4).
 */
export async function editContract(
  scope: ProjectScope,
  contractId: string,
  revision: number,
  content: ContractContentInput & { readonly expectedContentFingerprint: string },
): Promise<MvpResult<ContractView>> {
  const body = await scopedSend<{ readonly contract: ContractView }>(
    scope,
    'PATCH',
    `/contracts/${idSegment(contractId)}/${revisionSegment(revision)}`,
    { ...content, expectedContentFingerprint: content.expectedContentFingerprint },
  );
  if (!body.ok) return body;
  return envelope<ContractView>(body.value, 'contract', CONTRACT_ROUTE);
}

/**
 * The outcome of approving a revision.
 *
 * `contract-changed` is the 409, and it is a member of this union rather than a generic failure
 * for the reason the route's fingerprint exists at all: two tabs on one draft both address
 * `contracts/:id/1`, so the fingerprint the owner's page was rendered against is the only thing
 * separating "I approve what I read" from "I approve what somebody else wrote". The response
 * names the fingerprint asked for and the one now stored, and the page's job is to offer a reload
 * and re-approve — never to report success and never to discard what the owner typed
 * (mvp-spec 3, mvp-spec 7, F24-AC4).
 */
export type ApproveContractOutcome =
  | { readonly kind: 'approved'; readonly contract: ContractView }
  | {
      readonly kind: 'contract-changed';
      readonly reason: string;
      /** The fingerprint this approval named. */
      readonly expected: string | null;
      /** The fingerprint the server holds now, when it said. */
      readonly actual: string | null;
    }
  | {
      readonly kind: 'refused';
      readonly failure: MvpFailure;
    };

/**
 * `POST /api/projects/:projectId/contracts/:contractId/:revision/approve` — approves the text
 * named by `expectedContentFingerprint`. Read in `routes/contracts.ts`.
 *
 * The body has exactly one member and the route is a `strictObject`, so a body that tried to say
 * who approved is refused by name rather than dropped; the approver is read from the proved
 * session (mvp-spec 3, F01-AC1). An approval without the fingerprint is a 400 and a stale one is a
 * 409 — which is why the parameter is required here rather than optional: approving text the
 * owner did not read is the failure the guard exists to stop.
 *
 * On 422 the returned `refused.failure.prerequisites` names `acceptanceCriteria.<id>.verificationCheckId`
 * for an automated criterion that reached approval unbound, which is the one refusal here that is
 * fixable by editing the draft rather than by reloading (F23-AC1, F24-AC3).
 */
export async function approveContract(
  scope: ProjectScope,
  contractId: string,
  revision: number,
  expectedContentFingerprint: string,
): Promise<ApproveContractOutcome> {
  const result = await scopedSend<{ readonly contract: ContractView }>(
    scope,
    'POST',
    `/contracts/${idSegment(contractId)}/${revisionSegment(revision)}/approve`,
    { expectedContentFingerprint },
  );
  if (!result.ok) {
    if (result.failure.code === 'Conflict') {
      return {
        kind: 'contract-changed',
        reason: result.failure.reason,
        expected: expectedContentFingerprint,
        actual: result.failure.actual,
      };
    }
    return { kind: 'refused', failure: result.failure };
  }
  const contract = envelope<ContractView>(result.value, 'contract', CONTRACT_ROUTE + '/approve');
  if (!contract.ok) return { kind: 'refused', failure: contract.failure };
  return { kind: 'approved', contract: contract.value };
}

/**
 * `POST /api/projects/:projectId/contracts/:contractId/:revision/revise` — starts the next
 * revision and retires the approval it replaces, in one controller step so no caller can leave a
 * new revision beside a still-current approval. Read in `routes/contracts.ts`. 201 with the new
 * revision.
 */
export async function reviseContract(
  scope: ProjectScope,
  contractId: string,
  revision: number,
  content: ContractContentInput,
): Promise<MvpResult<ContractView>> {
  const body = await scopedSend<{ readonly contract: ContractView }>(
    scope,
    'POST',
    `/contracts/${idSegment(contractId)}/${revisionSegment(revision)}/revise`,
    content,
  );
  if (!body.ok) return body;
  return envelope<ContractView>(body.value, 'contract', CONTRACT_ROUTE + '/revise');
}

/** Why an approval may be retired, as the route's enum names them (mvp-spec 3). */
export type ContractStaleReason = 'RequestChanged' | 'SurroundingContextChanged' | 'WithdrawnByOwner';

/**
 * `POST /api/projects/:projectId/contracts/:contractId/:revision/invalidate` — retires an approval
 * for a named reason. Read in `routes/contracts.ts`.
 *
 * An enum rather than text, so the stored explanation is one a page can act on:
 * `RequestChanged` means revise the contract, `WithdrawnByOwner` means the request has no
 * agreement any more. Staleness is never inferred here (mvp-spec 3).
 */
export async function invalidateContract(
  scope: ProjectScope,
  contractId: string,
  revision: number,
  reason: ContractStaleReason,
): Promise<MvpResult<ContractView>> {
  const body = await scopedSend<{ readonly contract: ContractView }>(
    scope,
    'POST',
    `/contracts/${idSegment(contractId)}/${revisionSegment(revision)}/invalidate`,
    { reason },
  );
  if (!body.ok) return body;
  return envelope<ContractView>(body.value, 'contract', CONTRACT_ROUTE + '/invalidate');
}

/* -------------------------------------------------------------------------- */
/* Handoff                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/projects/:projectId/contracts/:contractId/:revision/handoff` — the packet, plus where
 * the external executor is configured to be opened. Read in `routes/handoff.ts`.
 *
 * A `GET` because nothing is written and nothing is decided here: the same approved contract always
 * renders the same bytes, so a page may read it twice and compare rather than trust either
 * (mvp-spec 7). Nothing is contacted — no T3 API, no session, no execution status, and no claim
 * about any (mvp-spec L02).
 *
 * `NotConfigured` is a normal 200 answer rather than an error: the packet is text the owner can
 * paste anywhere and the MVP journey must not depend on an external tool (mvp-spec L02-AC3).
 */
export async function fetchHandoff(
  scope: ProjectScope,
  contractId: string,
  revision: number,
): Promise<MvpResult<HandoffView>> {
  const body = await scopedGet<{ readonly handoff: HandoffView }>(
    scope,
    `/contracts/${idSegment(contractId)}/${revisionSegment(revision)}/handoff`,
  );
  if (!body.ok) return body;
  return envelope<HandoffView>(body.value, 'handoff', CONTRACT_ROUTE + '/handoff');
}

/* -------------------------------------------------------------------------- */
/* Candidate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/projects/:projectId/candidates` — links the pull request the owner named. Read in
 * `routes/candidates.ts`.
 *
 * The body has four members and the absence of more is the point: no `headSha`, no `headBranch`,
 * no `pullRequestNumber`, no `pullRequestState`, no `merge`. Identity is read from the provider
 * and nothing else, so a client cannot record "PR 7" as the candidate and inherit whatever the
 * provider points at on the next read (mvp-spec 3, SHARED.md "Candidate"). A body carrying any of
 * them is refused by name rather than silently ignored.
 */
export async function linkCandidate(
  scope: ProjectScope,
  input: {
    readonly requestId: string;
    readonly contractId: string;
    readonly contractRevision: number;
    readonly pullRequestUrl: string;
  },
): Promise<MvpResult<LinkedCandidateReport>> {
  const body = await scopedSend<{ readonly candidate: LinkedCandidateReport }>(
    scope,
    'POST',
    '/candidates',
    input,
  );
  if (!body.ok) return body;
  return envelope<LinkedCandidateReport>(body.value, 'candidate', '/api/projects/:projectId/candidates');
}

/**
 * `GET /api/projects/:projectId/candidates/:candidateId` — one candidate, read live from the
 * provider. Read in `routes/candidates.ts`.
 *
 * A `GET` that still talks to GitHub on purpose: the card the owner is looking at must be an
 * observation, and a cache that agreed with the last read would present withdrawn work as current
 * (mvp-spec F24-AC4). A deployment composed without a candidate port answers 503 naming the missing
 * wiring rather than a 404 that would read as "this project has no candidate" — a different and
 * wrong claim about the project's contents (F02-AC4).
 */
export async function readCandidate(
  scope: ProjectScope,
  candidateId: string,
): Promise<MvpResult<CandidateReport>> {
  const body = await scopedGet<{ readonly candidate: CandidateReport }>(
    scope,
    `/candidates/${idSegment(candidateId)}`,
  );
  if (!body.ok) return body;
  return envelope<CandidateReport>(body.value, 'candidate', CANDIDATE_ROUTE);
}

/**
 * `POST /api/projects/:projectId/candidates/:candidateId/refresh` — re-reads the provider and
 * reports what moved. Read in `routes/candidates.ts`.
 *
 * `POST` because the owner asked for a fresh observation, and with **no body**: the route parses
 * `strictObject({}).nullish()`, so a body that tried to say what changed or to name a head is
 * refused rather than dropped. This client therefore sends nothing — sending `{}` would be a body
 * where the server expects none (mvp-spec F20-AC3).
 *
 * The response is the same read as `readCandidate` with `change` made explicit. When the head
 * moved, `change.previousHeadSha` names the commit prior evidence is about and `evidence.status`
 * is `Stale`, so a view that kept a ready status across a force push has nothing to keep
 * (F20-AC3, F24-AC4, F25-AC3).
 */
export async function refreshCandidate(
  scope: ProjectScope,
  candidateId: string,
): Promise<MvpResult<CandidateReport>> {
  const body = await scopedSend<{ readonly candidate: CandidateReport }>(
    scope,
    'POST',
    `/candidates/${idSegment(candidateId)}/refresh`,
  );
  if (!body.ok) return body;
  return envelope<CandidateReport>(body.value, 'candidate', CANDIDATE_ROUTE + '/refresh');
}

/* -------------------------------------------------------------------------- */
/* The two evidence writes                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of one automated verification pass.
 *
 * `report.candidateHeadSha` and `report.providerHeadSha` are both carried and are allowed to
 * differ, because that difference is the finding: once the pull request has moved on, every check
 * the provider attributed to the newer commit lands unbound and proves nothing about the
 * candidate under review (F20-AC3, F24-AC4).
 *
 * The card travels with the report rather than requiring a second read, so a page cannot assemble
 * a verdict from a report and a card computed at different moments (F24-AC2).
 */
export type VerifyCandidateOutcome =
  | { readonly kind: 'verified'; readonly report: VerificationReportView }
  | { readonly kind: 'refused'; readonly failure: MvpFailure };

/**
 * `POST /api/projects/:projectId/candidates/:candidateId/verify` — reads the provider and records
 * what it said. Read in `routes/verification.ts`.
 *
 * **Server-controlled.** The request schema is a `strictObject` with one optional `method` and
 * nothing else: no `result`, no `outcome`, no `checkId`, no `criterionId`, no `headSha`, no
 * `evidenceId`, because every one of those would let the browser state what a check concluded. A
 * body carrying any of them is refused *by name*, so this function takes no result parameter at
 * all and sends nothing unless asked to be explicit about the method (F20-AC2, F23-AC1).
 *
 * A `Unavailable` refusal means a provider that could not be read, and nothing was recorded —
 * which is the one thing that must never be rendered as "nothing failed" (F03-AC2, F20-AC2).
 */
export async function verifyCandidate(
  scope: ProjectScope,
  candidateId: string,
  options: { readonly method?: 'github_checks' } = {},
): Promise<VerifyCandidateOutcome> {
  const suffix = `/candidates/${idSegment(candidateId)}/verify`;
  const body =
    options.method === undefined
      ? await scopedSend<{ readonly verification: VerificationReportView }>(scope, 'POST', suffix)
      : await scopedSend<{ readonly verification: VerificationReportView }>(scope, 'POST', suffix, {
          method: options.method,
        });
  if (!body.ok) return { kind: 'refused', failure: body.failure };
  const report = envelope<VerificationReportView>(body.value, 'verification', CANDIDATE_ROUTE + '/verify');
  if (!report.ok) return { kind: 'refused', failure: report.failure };
  return { kind: 'verified', report: report.value };
}

/** What the owner may report about their own test — two outcomes and no third (F23-AC1, F25-AC2). */
export type OwnerTestResult = 'passed' | 'failed';

/**
 * `POST /api/projects/:projectId/candidates/:candidateId/criteria/:criterionId/owner-test` — the
 * owner's own test of one criterion. Read in `routes/verification.ts`.
 *
 * **Owner-controlled**, because an owner's test is an observation rather than a measurement and
 * there is no provider to read it from. The body carries `result` and an optional `note` and
 * nothing else — no owner, no instant, no commit, no verification type. The owner is the proved
 * session (F01-AC1, F25-AC4).
 *
 * `capture_failed` is deliberately not accepted: a screenshot that was never taken observed
 * nothing, and filing it as a behaviour failure would claim a break the owner did not observe.
 * Such a criterion is left `unverified`, which is the honest state (F23-AC5).
 *
 * The write binds the exact contract revision and the full candidate SHA, so a SHA change stales
 * it — and a criterion the contract declares `automated` is refused with 400 here, because that is
 * a request the endpoint cannot serve rather than a fact it discovered about the product (F23-AC1,
 * F02-AC2).
 */
export async function recordOwnerTest(
  scope: ProjectScope,
  candidateId: string,
  criterionId: string,
  input: { readonly result: OwnerTestResult; readonly note?: string | null },
): Promise<MvpResult<OwnerTestReportView>> {
  const body = await scopedSend<{ readonly ownerTest: OwnerTestReportView }>(
    scope,
    'POST',
    `/candidates/${idSegment(candidateId)}/criteria/${idSegment(criterionId)}/owner-test`,
    { result: input.result, ...(input.note === undefined ? {} : { note: input.note }) },
  );
  if (!body.ok) return body;
  return envelope<OwnerTestReportView>(
    body.value,
    'ownerTest',
    CANDIDATE_ROUTE + '/criteria/:criterionId/owner-test',
  );
}

/* -------------------------------------------------------------------------- */
/* Review card and decision                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/projects/:projectId/candidates/:candidateId/review` — the whole card. Read in
 * `routes/review.ts`.
 *
 * Answered as one object because it was computed in one pass over the request, the contract
 * revision, the candidate, the checks, the criteria, the evidence and the decisions: a page cannot
 * assemble a card from two reads that disagree about whether the work is ready (F24-AC2).
 *
 * `card.evidence[].currentOutcome` and `card.evidence[].countsForCurrentCandidate` are the fields
 * that name current state, and there is no `outcome` member to reach for by mistake — a card that
 * publishes only what the source said at the time is a card that renders a stale pass in green
 * (F20-AC3, F24-AC3). `card.staleness.stale` is the headline and it is guaranteed to count exactly
 * the rows that no longer count.
 */
export async function fetchReview(scope: ProjectScope, candidateId: string): Promise<MvpResult<ReviewCardView>> {
  const body = await scopedGet<{ readonly review: ReviewCardView }>(
    scope,
    `/candidates/${idSegment(candidateId)}/review`,
  );
  if (!body.ok) return body;
  return envelope<ReviewCardView>(body.value, 'review', CANDIDATE_ROUTE + '/review');
}

/**
 * The outcome of the owner's decision.
 *
 * `superseded-commit` and `superseded-revision` are the 409s, and they are members here rather
 * than a generic failure because the remedy is specific and different from every other refusal: a
 * push or a revision moved after the page was rendered, so the decision was not made and nothing
 * was recorded. The response names the commit or revision prepared against and the one current
 * now, and the page's job is to re-render and let the owner decide again — the server compares
 * identity **before** the acceptance gate, precisely so a stale submission is not answered with
 * blockers belonging to a build the owner never looked at (mvp-spec F24-AC4, F25-AC3).
 *
 * `not-eligible` is the 422 for an acceptance the card refuses, with `failure.prerequisites`
 * naming every outstanding requirement. `Request Changes` is never gated, which is what makes "the
 * work is not ready" expressible (F23-AC1, F24-AC3, F25-AC2).
 *
 * A stale decision is *shown*, not hidden: `card.decision.staleDecisions` carries the decisions a
 * push invalidated, and `card.decision.authorizesCurrentCandidate` is false when the acceptance on
 * file is for an earlier commit (F25-AC3, F27-AC3).
 */
export type DecideCandidateOutcome =
  | { readonly kind: 'decided'; readonly review: ReviewCardView }
  | {
      readonly kind: 'superseded-commit';
      readonly reason: string;
      /** The full SHA the submission named. */
      readonly expected: string | null;
      /** The commit the server holds now. */
      readonly actual: string | null;
    }
  | {
      readonly kind: 'superseded-revision';
      readonly reason: string;
      readonly expected: string | null;
      readonly actual: string | null;
    }
  | { readonly kind: 'not-eligible'; readonly failure: MvpFailure }
  | { readonly kind: 'refused'; readonly failure: MvpFailure };

/**
 * `POST /api/projects/:projectId/candidates/:candidateId/decision` — Accept or Request Changes.
 * Read in `routes/review.ts`.
 *
 * `expectedHeadSha` and `expectedContractRevision` are required by the route's `strictObject`, and
 * both must come from the card that was rendered: they are the identity the owner's page was
 * prepared against, and comparing them against the live candidate is what turns an action taken
 * from an outdated card into a `Conflict` rather than a decision about whatever the candidate has
 * become (F24-AC4, F25-AC3).
 *
 * The body carries no owner: there is no `ownerId`, `approver`, `decidedBy` or `at` member, so a
 * decision cannot be attributed to anybody but the session that made it (F01-AC1, F25-AC4).
 *
 * v0.1 ends here. There is no merge, no deploy and no release for a client to ask for, and the
 * port this route declares has no such method (mvp-spec 3, F03-AC5).
 */
export async function decideCandidate(
  scope: ProjectScope,
  candidateId: string,
  input: {
    readonly decision: 'accepted' | 'changes_requested';
    readonly expectedHeadSha: string;
    readonly expectedContractRevision: number;
    readonly feedback?: string | null;
  },
): Promise<DecideCandidateOutcome> {
  const result = await scopedSend<{ readonly review: ReviewCardView }>(
    scope,
    'POST',
    `/candidates/${idSegment(candidateId)}/decision`,
    {
      decision: input.decision,
      expectedHeadSha: input.expectedHeadSha,
      expectedContractRevision: input.expectedContractRevision,
      ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
    },
  );
  if (!result.ok) {
    if (result.failure.code === 'Conflict') {
      // The route answers a revision conflict with revision numbers and a head conflict with full
      // SHAs, so which one this is is decided by what the caller submitted rather than by
      // inspecting prose (mvp-spec F24-AC4).
      const isRevision = result.failure.expected === String(input.expectedContractRevision);
      return isRevision
        ? {
            kind: 'superseded-revision',
            reason: result.failure.reason,
            expected: result.failure.expected,
            actual: result.failure.actual,
          }
        : {
            kind: 'superseded-commit',
            reason: result.failure.reason,
            expected: result.failure.expected ?? input.expectedHeadSha,
            actual: result.failure.actual,
          };
    }
    if (result.failure.code === 'Blocked') return { kind: 'not-eligible', failure: result.failure };
    return { kind: 'refused', failure: result.failure };
  }
  const review = envelope<ReviewCardView>(result.value, 'review', CANDIDATE_ROUTE + '/decision');
  if (!review.ok) return { kind: 'refused', failure: review.failure };
  return { kind: 'decided', review: review.value };
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/projects/:projectId/settings` — everything this project's settings hold. Read in
 * `routes/settings.ts`.
 *
 * 200 for a project that has configured nothing (`t3.configured: false`), because that is the
 * state a fresh MVP deployment is in and the handoff packet works there; 404 is reserved for a
 * project this deployment does not hold (mvp-spec L02-AC3, F02-AC2). There is no credential in
 * the response — only a connector's stored digest (L02-AC2, F32-AC2).
 *
 * Note what this response does **not** carry: the project's configured verification check names.
 * `GET /api/projects/:projectId/settings` has no member for them, which is why
 * `readVerificationCheckNames` exists (F23-AC1, F24-AC3).
 */
export async function fetchSettings(scope: ProjectScope): Promise<MvpResult<ProjectSettingsView>> {
  const body = await scopedGet<{ readonly settings: ProjectSettingsView }>(scope, '/settings');
  if (!body.ok) return body;
  return envelope<ProjectSettingsView>(body.value, 'settings', '/api/projects/:projectId/settings');
}

/**
 * `PATCH /api/projects/:projectId/settings` — saves or clears the T3 deployment URL. Read in
 * `routes/settings.ts`.
 *
 * `t3Url: null` clears it, which is why the member is nullable rather than optional: "there is no
 * T3 deployment" and "I did not say" are different states, and a body that had to omit the field
 * to mean the second could not also say the first (mvp-spec L02-AC3).
 *
 * The route is `strictObject`, so a body carrying a credential under another name is refused by
 * name rather than dropped — a request that thinks it stored something it did not is the defect
 * that shape exists to prevent (F02-AC4). A refused URL answers 422 and **never echoes the
 * submitted value**, so `failure.reason` is safe to render (N02-AC2).
 *
 * Omitting `t3Url` reads back rather than writing, which makes a read-then-save round trip
 * idempotent (mvp-spec 7).
 */
export async function updateSettings(
  scope: ProjectScope,
  input: { readonly t3Url?: string | null },
): Promise<MvpResult<ProjectSettingsView>> {
  const body =
    input.t3Url === undefined
      ? await scopedSend<{ readonly settings: ProjectSettingsView }>(scope, 'PATCH', '/settings')
      : await scopedSend<{ readonly settings: ProjectSettingsView }>(scope, 'PATCH', '/settings', {
          t3Url: input.t3Url,
        });
  if (!body.ok) return body;
  return envelope<ProjectSettingsView>(body.value, 'settings', '/api/projects/:projectId/settings');
}

/* -------------------------------------------------------------------------- */
/* The configured verification check names                                     */
/* -------------------------------------------------------------------------- */

/**
 * The check names an automated criterion may bind to.
 *
 * Read from `GET /api/projects/:projectId`… no: from `GET /api/profiles/:projectId`, whose
 * `content.policy.requiredChecks` is the *only* place in this tree the configured names are
 * readable. `routes/settings.ts` carries the repository and the connectors but not the checks, so
 * a page that offered a free-text identifier here would let a criterion bind to a check nobody
 * runs — and approval refuses that unbound automated criterion anyway, at which point the owner
 * has typed a field that cannot become one (F23-AC1, F24-AC3).
 *
 * The second element of the union is the honest answer for a project with no saved profile: the
 * route answers 404 ("That project has no saved profile yet"), which is a fact about the project's
 * configuration rather than about the criterion the owner was authoring. A page shows that the
 * choices are unavailable *because* the project has no profile, rather than collecting an opaque
 * string (F02-AC4).
 */
export type VerificationCheckNames =
  | { readonly kind: 'configured'; readonly names: readonly string[] }
  | { readonly kind: 'no-profile'; readonly reason: string };

/**
 * `GET /api/profiles/:projectId` — the project's current profile version. Read in
 * `routes/profiles.ts`.
 *
 * Declared for the one reason documented on `VerificationCheckNames`: the configured check names
 * live in `content.policy.requiredChecks`, and `verificationCheckId` must be one of them. This is
 * the MVP read; the profile editor is behind the legacy escape hatch (F23-AC1, F24-AC3).
 */
export async function readVerificationCheckNames(scope: ProjectScope): Promise<MvpResult<VerificationCheckNames>> {
  const result = await profileScopedGet<{ readonly profile: ProfileVersionView }>(scope, '');
  if (!result.ok) {
    // "No saved profile yet" is a fact about the project's configuration rather than a failure to
    // read one, so it becomes its own member of the union instead of an error shown beside the
    // criterion form — and an automated criterion cannot be authored without it, which is a
    // different fact from "this page is broken" (F02-AC4, F23-AC1).
    if (result.failure.code === 'NotFound') {
      return { ok: true, value: { kind: 'no-profile', reason: result.failure.reason } };
    }
    return result;
  }
  const profile = envelope<ProfileVersionView>(result.value, 'profile', '/api/profiles/:projectId');
  if (!profile.ok) {
    if (profile.failure.code === 'NotFound') {
      return { ok: true, value: { kind: 'no-profile', reason: profile.failure.reason } };
    }
    return profile;
  }
  const names = requiredChecksOf(profile.value);
  if (names === null) {
    // The route is a `strictObject` and the controller composes the profile, so this shape cannot
    // be wrong from an honest server. Refusing rather than throwing keeps the promise this module
    // makes: no client call ever throws, so no page needs a try/catch around a read (N03-AC3).
    return failed({
      code: 'MalformedResponse',
      reason: 'The project profile arrived without its configured verification checks, so no criterion can be bound to one yet.',
      status: 200,
      fields: [],
      prerequisites: [],
      expected: null,
      actual: null,
    });
  }
  return { ok: true, value: { kind: 'configured', names } };
}

/* -------------------------------------------------------------------------- */
/* Path names, quoted for failures and for the README                           */
/* -------------------------------------------------------------------------- */

/**
 * The route templates, quoted into failure messages and into the README.
 *
 * Named constants rather than assembled strings at each call site, so the route a failure names is
 * the route that was called and cannot drift from it. They carry `:projectId` rather than an id,
 * so a message never echoes a value the owner typed (N02-AC2, F02-AC4).
 */
const CONTRACT_ROUTE = '/api/projects/:projectId/contracts/:contractId/:revision';
const CANDIDATE_ROUTE = '/api/projects/:projectId/candidates/:candidateId';

/**
 * The project's configured verification check names, or null when the profile did not carry them.
 *
 * Read defensively rather than by property access, because this client promises no call throws and
 * a profile without its `policy` would otherwise become an unhandled rejection on the criterion
 * authoring screen (N03-AC3).
 */
function requiredChecksOf(profile: ProfileVersionView): readonly string[] | null {
  const content = memberOf(profile, 'content');
  const policy = memberOf(content, 'policy');
  const checks = memberOf(policy, 'requiredChecks');
  if (!Array.isArray(checks)) return null;
  return checks.filter((name): name is string => typeof name === 'string');
}

/** One member of an untrusted value, or null. Never throws, whatever was sent. */
function memberOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return null;
  return (value as Record<string, unknown>)[key] ?? null;
}