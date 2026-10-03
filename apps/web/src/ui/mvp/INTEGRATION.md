# MVP owner UI — integration contract

What Builder 2's four MVP surfaces call, and what they expect back. Everything below is an
**assumption**: the endpoints do not exist in this worktree, and are being written from the same
shared contract by other builders. This file is the UI's half of that negotiation, so a mismatch is
a single edit here rather than a per-screen fix.

The authoritative wire shapes are in `wire.ts` (beside this file); the executable version of the
same shapes is the browser harness in `apps/web/e2e/mvp-contract-server.ts`, which answers every
endpoint below from an in-memory model. Building the backend against that fixture gives a
disagreement as a failing field rather than a blank page.

## Conventions

Inherited from the existing server, so there is nothing new to decide:

- `GET` for reads, `POST` for writes. No other verb is used anywhere in this product.
- Writes carry the session's derived CSRF token on the `x-shiploop-csrf` header, and are refused
  without it.
- A refusal is `{ error: { code, message, fields: [{ path, message }], prerequisites } }`, which
  `api-client.ts` already reads. A bare `{ code, reason }` is still accepted as a fallback.
- Every response carries its identity in the body (`{ contract }`, `{ queue }`, …) rather than in
  the URL, so the client never reconstructs state from a path it built.
- Percent-encode every identifier in a path.

## Endpoints called

| Method | Path | Request body | Response body |
| --- | --- | --- | --- |
| `GET` | `/api/home?projectId=<id>` | — | `{ home: { projectId: string \| null, collectedAt: string, items: HomeItem[] } }` |
| `POST` | `/api/requests` | `{ projectId: string \| null, title: string, description: string }` | `{ request: RequestRecord, contract: DeliveryContract }` |
| `GET` | `/api/contracts/:contractId` | — | `{ contract: DeliveryContract, request: RequestRecord }` |
| `POST` | `/api/contracts/:contractId` | `{ outcome, scope, outOfScope: string[], acceptanceCriteria: [{ id: string \| null, description, verificationType }] }` | `{ contract: DeliveryContract }` |
| `POST` | `/api/contracts/:contractId/approve` | `{}` | `{ contract: DeliveryContract }` |
| `POST` | `/api/contracts/:contractId/handoff` | `{}` | `{ packet: HandoffPacket }` |
| `POST` | `/api/candidates` | `{ contractId, repository, pullRequestNumber: number \| null, pullRequestUrl: string \| null, baseBranch, headSha }` | `{ candidate: Candidate }` |
| `GET` | `/api/review?projectId=<id>` | — | `{ queue: { projectId: string \| null, collectedAt, items: ReviewQueueItem[] } }` |
| `GET` | `/api/review/:candidateId` | — | `{ review: ReviewDetail }` |
| `POST` | `/api/review/:candidateId/observations` | `{ criterionId, expectedHeadSha, observation: 'BehaviorConfirmed' \| 'BehaviorFailed', environment: 'Local' \| 'Preview' \| 'LiveSmoke', note: string \| null }` | `{ criterion: { id: string, status: string } }` |
| `POST` | `/api/review/:candidateId/decision` | `{ decision: 'accepted' \| 'changes_requested', feedback?: string }` | `{ decision: OwnerDecision }` |
| `GET` | `/api/projects/:projectId/settings` | — | `{ settings: ProjectSettings }` |
| `POST` | `/api/projects/:projectId/settings` | `ProjectSettingsInput` | `{ settings: ProjectSettings }` |

Already existing and reused unchanged: `GET /api/owner/session`, `POST /api/owner/sign-in`,
`POST /api/owner/sign-out`, `GET /api/projects`, `POST /api/projects`, `GET /api/health`.

## Rules the backend must honour, because the UI cannot enforce them

These are the ones where a plausible-but-wrong implementation passes every browser spec and still
misleads an owner.

1. **`POST /api/requests` creates the first Delivery Contract draft and returns it.** The New
   Request screen navigates straight to `contract.id`. A response without a contract leaves the
   screen with nowhere to go.
2. **`POST /api/contracts/:id` applies the revision rule, not the client.** Changed content against
   an approved revision increments `revision` and returns status `draft`. Unchanged content against
   an approved revision returns the same revision, still `approved`. The client sends no revision
   number of its own — it would be a second opinion about concurrency. A browser spec asserts both
   halves.
3. **`POST /api/contracts/:id/approve` is the only thing that sets `approved`.** Nothing else may,
   including any draft, suggestion or later step. The UI hides the control in that state rather than
   sending a redundant write.
4. **`POST /api/contracts/:id/handoff` creates an artefact and nothing else.** No agent, no queue,
   no job, no progress. `packet.content` is the packet, generated server-side; the client renders
   and copies it verbatim and never assembles its own.
5. **`packet.t3Url` is validated server-side** and is `null` when nothing is configured. The client
   does not re-check it: a second, weaker check in the browser could only disagree with the one
   that will be followed, and the disagreement would be invisible.
6. **`POST /api/candidates` requires a full 40-character `headSha`.** The client refuses an
   abbreviated one before sending, and the server must re-check regardless: a client check is a
   courtesy, never a control. A candidate recorded against an abbreviated SHA cannot be compared
   with a checkout and cannot be shown stale when the branch moves.
7. **`ReviewDetail.verification` is the server's statement, and the UI never recomputes it.** Accept
   is offered on `verification.complete === true` and on an empty `staleReasons`. A green set of
   checks does not set it.
8. **`evidence` on a criterion always carries `candidateHeadSha` and `contractRevision`.** The Review
   surface compares `evidence.candidateHeadSha` against the commit on screen and labels a mismatch
   rather than counting it. Evidence recorded for SHA A can never prove SHA B, and this is where
   that shows up.
9. **`POST /api/review/:id/observations` refuses a moved candidate.** `expectedHeadSha` is sent and
   must be compared against the stored candidate; a mismatch is a `Conflict`, not a re-attribution.
   The body carries an *observation*, never a verdict — there is deliberately no way for a client to
   assert that a criterion passed.
10. **`POST /api/review/:id/decision` records against the full SHA and the contract revision.** Only
    `accepted` and `changes_requested` exist. `feedback` is required in practice for
    `changes_requested` and the client refuses to send it empty.
11. **`GET /api/projects/:id/settings` returns the whole settings object** including `linear: null`
    when unconfigured. A missing optional connector is `null`, never a placeholder object: "no Linear
    configuration" and "an empty Linear configuration" must not read alike.
12. **`ProjectSettings.github.connector.credentialReference` is a reference, never a secret.** The
    Settings form names where the secret lives (`env:REPO_TOKEN`) and cannot accept a token.

## What the UI derives, and what it refuses to derive

The UI holds no opinion the server has not stated, so there is nothing for integration to
reconcile here — but these are the places a second implementation would be tempted to differ:

- **Home groups** (`home.ts`) map durable facts to three buckets plus a settled count. There is no
  `group` field on the wire, deliberately: the mapping is one testable function rather than a value
  that arrives pre-bucketed and is never checked against the states it claims to summarise.
- **Contract validation** (`contract.ts`) is a client-side courtesy that produces per-field messages.
  The server must validate independently; the browser's check exists so the owner learns immediately
  rather than after a round trip.
- **Check and criterion tones** (`review-view.ts`) render the server's own result word as the label.
  The tone only reinforces it, and an unrecognised word renders as itself rather than being dropped.
- **Accept availability** (`review-view.ts`) is a refusal list, not a boolean. The UI renders the
  sentences.

## Integration hazards

Files outside `apps/web/src/ui/**` that this work touches, and what changed in each.

| File | Change | How to resolve a conflict |
| --- | --- | --- |
| `apps/web/src/ui/App.tsx` | Rewritten. Header keeps the project selector and sign-out; navigation becomes four tabs; routing is `location.hash`; the retired surfaces are dispatched from `mvp/MvpSurface.tsx`. | Take the four-tab nav and the hash router. The legacy pages still need their props, which moved to `MvpSurface`'s `legacySelection`. |
| `apps/web/src/ui/api-client.ts` | One word plus a doc comment: `function request` became `export function request`. Nothing else changed. | If the symbol was renamed, import the transport under whatever name it now has; the MVP client is the only consumer of the export. |
| `apps/web/src/ui/styles.css` | Appended four rules (`.sha`, `.field__input--area`, `.packet`, `.repeater*`) and one comment block. No existing rule was changed. | Additive; a conflict means the other side appended too, and both sets should be kept. |
| `apps/web/e2e/intake.spec.ts`, `planning.spec.ts`, `review-card.spec.ts`, `runs.spec.ts` | Nav clicks replaced by `openLegacy(page, '<section>')` from the new `e2e/legacy-nav.ts`. `planning.spec.ts` also gained two lines in `captureThroughForm`. | The `openLegacy` import and the call sites. The `captureThroughForm` change is semantically required: the shell no longer opens on Intake, so a helper that filled the capture form without navigating there would silently fill nothing. |

Nothing was changed in `packages/**`, `apps/web/src/server/**`, storage, migrations or the controller
composition root. No migration was added.

### One behavioural change worth naming

The shell's default surface was **Intake** and is now **Home**, and the current section moved from
component state to the address bar. A reload or a shared link now lands where it points rather than
on Intake. Every existing browser spec was updated for this; a spec that opens a retired surface by
clicking a nav button will not find one, and must use `openLegacy`.