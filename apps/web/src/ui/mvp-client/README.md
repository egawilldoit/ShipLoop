# `mvp-client` — the browser transport for the minimal MVP

One module, one `fetch`, one CSRF token, one set of refusal types. Pages import from
`../mvp-client/index.ts` and nothing else.

Every function below was written **after reading the handler it calls**, and `client.test.ts`
asserts mechanically that each recorded method and path is one the server registers — it parses
`apps/web/src/server/routes/*.ts` and matches. That test exists because the previous wave shipped
a complete UI against `/api/requests`, `/api/contracts/:id`, `/api/home`, `/api/review` and
`/api/candidates`, none of which this backend registers.

## Project identity comes from the session, and nowhere else

`session.owner.activeProject` is a union, not a nullable string:

```ts
{ state: 'Selected',        activeProjectId: string, activeProjectName: string }
{ state: 'NoProjectSelected', selectableProjectCount: number }
```

`projectScopeOf(activeProject)` turns it into a `ProjectScope`, and **every project-scoped call
takes a `ProjectScope` rather than a `projectId: string`.** There is no overload that accepts a
string, so a page cannot address a project it made up: when no project is selected the call returns
a `NoProjectSelected` refusal and sends no request at all. There is no placeholder project and no
default id anywhere in this module.

Wiring note: `setMvpCsrfToken(session.csrfToken)` must be called from the session layer after
`fetchSession()` or `signIn()` succeeds, and `setMvpCsrfToken(null)` on sign-out. The token has one
owner here so sign-out cannot clear one copy and leave another.

## Refusals are values

`MvpResult<T>` is `{ ok: true; value: T } | { ok: false; failure: MvpFailure }`. Nothing throws.

`MvpFailure.code` is one of `Invalid · Unauthorized · Forbidden · NotFound · Conflict · Blocked ·
OutcomeUnknown · RateLimited · Unavailable · InternalError · Disconnected · NoProjectSelected ·
MalformedResponse`, plus `fields` (per-input messages), `prerequisites` (what is outstanding and
the remedy) and `expected` / `actual` (present on a `Conflict`).

Two refusals are **not** the same screen:

| code | what it means | what the page does |
| --- | --- | --- |
| `Conflict` | the thing moved under the owner | offer reload / re-render; **never** report success |
| `Blocked` | requirements are outstanding | show `prerequisites`; often fixable in place |
| `NoProjectSelected` | no project chosen | onboarding / selector |
| `Disconnected` | no response was received | disconnected state, offer retry |
| `Unavailable` | the server refused (503) | say so; **never** render as an empty group |
| `MalformedResponse` | a body this client cannot read | report it; **never** render as empty data |

## The calls

### Identity

| function | route | notes |
| --- | --- | --- |
| `fetchSession()` | `GET /api/owner/session` | `owner.activeProject` is here, not a second read |
| `signIn({ identifier, password })` | `POST /api/owner/sign-in` | unauthenticated, no CSRF |
| `signOut()` | `POST /api/owner/sign-out` | 204, no body |
| `selectActiveProject(projectId)` | `PUT /api/owner/active-project` | server-side, survives reload |
| `listProjects()` | `GET /api/projects` | the selector's contents |
| `createProject({ projectId, name })` | `POST /api/projects` | 200 = existed, 201 = created |
| `projectScopeOf(activeProject)` | — | the only bridge from the session to a scope |
| `projectIdOf(scope)` | — | for a route key, never for addressing a request |

### Home

| function | route |
| --- | --- |
| `fetchHome(scope)` | `GET /api/projects/:projectId/home` |

Three independent lists: a request may be in `needsYou` **and** `readyForReview`. Do not
deduplicate, and do not add a "Done" group.

### Requests

| function | route |
| --- | --- |
| `listRequests(scope)` | `GET /api/projects/:projectId/requests` |
| `createRequest(scope, { title, description })` | `POST /api/projects/:projectId/requests` |
| `getRequest(scope, requestId)` | `GET /api/projects/:projectId/requests/:requestId` |
| `updateRequest(scope, requestId, { …, expectedUpdatedAt })` | `PATCH …/requests/:requestId` |

`getRequest` is answered **unwrapped** — the only route in this set that is. `expectedUpdatedAt` is
required by the route's `strictObject` and must come from the `updatedAt` of the read that was
rendered; a stale editor is a `Conflict`, not an overwrite.

### Contracts

| function | route |
| --- | --- |
| `listContractRevisions(scope, requestId)` | `GET …/requests/:requestId/contracts` |
| `draftContract(scope, requestId, content)` | `POST …/requests/:requestId/contracts` |
| `getContract(scope, contractId, revision)` | `GET …/contracts/:contractId/:revision` |
| `listContractCriteria(scope, contractId, revision)` | `GET …/contracts/:contractId/:revision/criteria` |
| `editContract(scope, contractId, revision, content & { expectedContentFingerprint })` | `PATCH …/contracts/:contractId/:revision` |
| `approveContract(scope, contractId, revision, expectedContentFingerprint)` | `POST …/contracts/:contractId/:revision/approve` |
| `reviseContract(scope, contractId, revision, content)` | `POST …/contracts/:contractId/:revision/revise` |
| `invalidateContract(scope, contractId, revision, reason)` | `POST …/contracts/:contractId/:revision/invalidate` |

**Editing a draft is the same compare-and-set.** `editContract` also takes
`expectedContentFingerprint`, the `contentFingerprint` of the read that was rendered, and the 200
body's `contract.contentFingerprint` is the value the *next* edit or approval must send back. A
stale one is a `Conflict`: offer a reload and re-save rather than reporting success. The instant
cannot stand in for it — two writes can share a millisecond — so a page must never substitute
`contract.updatedAt` here.

**Approval is a compare-and-set.** `expectedContentFingerprint` is `contract.contentFingerprint`
from the read that was rendered, and it is required. `approveContract` returns a union:

- `{ kind: 'approved', contract }` — only ever from a 200;
- `{ kind: 'contract-changed', reason, expected, actual }` — the 409. Offer a reload and
  re-approve. Never report success, never discard what the owner typed;
- `{ kind: 'refused', failure }` — anything else. On `Blocked`, `failure.prerequisites` names
  `acceptanceCriteria.<id>.verificationCheckId` for an unbound automated criterion.

`ContractContentInput.acceptanceCriteria[].verificationCheckId` is required as `string | null`
because `routes/contracts.ts` refuses an automated criterion that reaches approval unbound. Feed it
from `readVerificationCheckNames` — see below — rather than a free-text field.

### Handoff

| function | route |
| --- | --- |
| `fetchHandoff(scope, contractId, revision)` | `GET …/contracts/:contractId/:revision/handoff` |

`t3.state` is `Configured · NotConfigured · Unusable`. `NotConfigured` is a normal 200: the packet
is still usable, and `Open T3` should point at Settings rather than implying ShipLoop started
anything.

### Candidate

| function | route |
| --- | --- |
| `linkCandidate(scope, { requestId, contractId, contractRevision, pullRequestUrl })` | `POST /api/projects/:projectId/candidates` |
| `readCandidate(scope, candidateId)` | `GET …/candidates/:candidateId` |
| `refreshCandidate(scope, candidateId)` | `POST …/candidates/:candidateId/refresh` |

The link body has four members and no others: no `headSha`, no branch, no PR number. Identity is
read from the provider. `refreshCandidate` sends **no body** — the route parses
`strictObject({}).nullish()`.

Identity is the full 40-character SHA. `change.previousHeadSha` and `evidence.status === 'Stale'`
are the fields that say evidence no longer describes the candidate on screen.

### Evidence — the two writes

| function | route |
| --- | --- |
| `verifyCandidate(scope, candidateId, { method? })` | `POST …/candidates/:candidateId/verify` |
| `recordOwnerTest(scope, candidateId, criterionId, { result, note? })` | `POST …/candidates/:candidateId/criteria/:criterionId/owner-test` |

`verifyCandidate` takes **no result parameter**. The route is a `strictObject` with one optional
`method`; a body carrying `result`, `outcome`, `checkId`, `criterionId` or `headSha` is refused by
name. It sends no body at all unless you ask for `{ method: 'github_checks' }`. The verdict is read
back from `report`, which also carries `candidateHeadSha` and `providerHeadSha` — allowed to differ,
because that difference is the finding.

`recordOwnerTest` sends `result` and `note` and nothing else. `capture_failed` is not offered: a
capture that never happened observed nothing. `result` is `'passed' | 'failed'`.

### Review and decision

| function | route |
| --- | --- |
| `fetchReview(scope, candidateId)` | `GET …/candidates/:candidateId/review` |
| `decideCandidate(scope, candidateId, { decision, expectedHeadSha, expectedContractRevision, feedback? })` | `POST …/candidates/:candidateId/decision` |

On the card: read `evidence[].currentOutcome` and `evidence[].countsForCurrentCandidate` for current
state. There is **no `outcome` member** on an evidence row — `recordedOutcome` is history. A
`passed` verdict is only ever backed by a row that counts.

`decideCandidate` returns a union:

- `{ kind: 'decided', review }`;
- `{ kind: 'superseded-commit', reason, expected, actual }` — the 409 for a moved head;
- `{ kind: 'superseded-revision', reason, expected, actual }` — the 409 for a moved revision;
- `{ kind: 'not-eligible', failure }` — the 422, with `failure.prerequisites` naming what is
  outstanding;
- `{ kind: 'refused', failure }`.

`decision` is `'accepted' | 'changes_requested'` and nothing else. There is no merge and no deploy
to call, and nothing in this module mentions one.

Stale decisions are shown, not hidden: `review.decision.staleDecisions` and
`review.decision.authorizesCurrentCandidate`.

### Settings

| function | route |
| --- | --- |
| `fetchSettings(scope)` | `GET /api/projects/:projectId/settings` |
| `updateSettings(scope, { t3Url })` | `PATCH /api/projects/:projectId/settings` |

`t3Url: null` clears; omitting it reads back. A refused URL answers 422 and never echoes the value,
so `failure.reason` is safe to render.

### Configured verification check names

```ts
readVerificationCheckNames(scope): Promise<MvpResult<VerificationCheckNames>>
//   { kind: 'configured', names: readonly string[] } | { kind: 'no-profile', reason }
```

Reads `GET /api/profiles/:projectId` → `content.policy.requiredChecks`. **That is the only place in
this tree the configured names are readable** — `routes/settings.ts` carries the repository and the
connectors but not the checks. So an automated criterion's `verificationCheckId` must come from here.
`no-profile` is a state, not a failure: the project has no saved profile yet, which is a fact about
its configuration rather than about the criterion being authored. Do not substitute a free-text
field.

`/api/profiles/:projectId` is the one route in this client outside `/api/projects/:projectId/…`, and
it is still reached through a `ProjectScope`, so the project identity has exactly one spelling.

## Rules this module keeps so a page cannot break them

- **No unscoped spelling.** `/api/requests`, `/api/home`, `/api/review`, `/api/candidates` and
  `/api/contracts` do not appear in any file here, and `client.test.ts` fails if one is introduced.
- **No page holds a CSRF token.** One owner, cleared on sign-out.
- **A refusal does not mark the connection down.** The server received the request and declined it.
- **A project id is never interpolated unchecked.** `..` and a separator are refused before a URL
  exists.
- **Nothing here claims external executor progress.** No field could hold one.