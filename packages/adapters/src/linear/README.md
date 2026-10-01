# Linear ticket adapter

The first provider adapter in ShipLoop that talks to a real external product. It
implements the full `TicketAdapter` contract from `../contracts/ticket.ts`:
`readScope`, `findRelatedIssues`, `publishWork`, `updateManagedProgress`,
`describeTransitions` and `requestTransition`, plus the `AdapterIdentity` surface
(`capabilities`, `checkCompatibility`).

This file exists because **"it typechecks" and "it works against Linear" are different
claims**, and only one of them is evidence. Everything below is separated into what was
observed from the live API and what was proven against constructed payloads. Where a
guarantee is weaker than the contract's wording, the weaker truth is stated here rather
than left for a reader to discover.

- Probed live on **1 October 2026**, `linux/arm64`, Node v24.18.0, against the owner's
  real workspace through `LINEAR_API_KEY`.
- Base commit: `5af0e0c` (`docs: record the slice A handoff, evidence and honest gaps`).
- Every live call was **read-only**. Nothing was created, updated or deleted in the
  owner's workspace.

## Layout

| File | What it owns |
| --- | --- |
| `client.ts` | The GraphQL transport: auth header, timeouts, rate-limit policy, raw-envelope reading |
| `errors.ts` | Linear `errors[]` and HTTP status to `DomainError` mapping |
| `adapter.ts` | The `TicketAdapter` implementation: reading, translation, identity, writes |
| `signature.ts` | Webhook signature and freshness verification over the original bytes |
| `stub.ts` | A scripted HTTP endpoint that records operations. Test support, **not** a fake adapter |

Every assertion in the two test files travels through the shipped `client.ts`,
`errors.ts` and `adapter.ts`. `stub.ts` speaks only HTTP and the GraphQL envelope and
adds the one thing `fetch` cannot: a record of which operations were actually issued,
which is what turns "a repeated write produced exactly one side effect" into an
assertion rather than a claim.

## Commands

```bash
# typecheck (from the repository root)
node /home/ubuntu/projects/ShipLoop/node_modules/typescript/bin/tsc --noEmit -p packages/adapters/tsconfig.json

# project policy lint
node scripts/lint.mjs

# this adapter only
node --test 'packages/adapters/src/linear/*.test.ts'

# every package's tests
node scripts/run-tests.mjs

# the opt-in live pass (read-only; spends workspace request budget)
LINEAR_API_KEY="$LINEAR_API_KEY" SHIPLOOP_LINEAR_LIVE_ISSUE=EGA-664 \
  node --test 'packages/adapters/src/linear/linear.test.ts'
```

The live test is skipped by default and says why, naming the missing prerequisite:

```
﹣ N05-AC2 a live read-only pass reads identity, one issue and its related work
  # no SHIPLOOP_LINEAR_LIVE_ISSUE; name a Linear issue identifier, such as a
    team-relative one, to read
```

Run with both variables set, the same file reports `tests 70 / pass 70 / fail 0 /
skipped 0` — the skip is a missing prerequisite, not a passing test.

## Proven against the LIVE API

Each row was observed on 1 October 2026 with a real credential. Nothing here is
inferred from documentation or from a fixture.

| Fact | How it was observed | Consequence in the code |
| --- | --- | --- |
| The `Authorization` header carries the **raw API key, with no `Bearer` prefix** | `viewer` query returned 200 with `Authorization: <key>` | `client.ts` sends the bare key. Adding `Bearer` is the most common cause of a 401 that looks like a revoked credential. |
| Viewer identity resolves: `MORTAKI ABDELILAH`, `ab.mortaki@gmail.com`, id `d4cdf91d-509f-4927-8e42-b5885d6d6983` | `{ viewer { id name email displayName } }` | `checkCompatibility` probes the credential instead of assuming it works |
| Teams are `EGA` (Egawilldoit, `62431c44-34e1-45c3-9306-be1a1cc028e2`) and `GYM` (gymtrack space, `e6cfdf95-fa28-4675-913e-08a641228b6c`) | `teams(first: 50)` | `resolveTeam` maps `targetTeamKey` to a real `teamId` and refuses an unreadable key rather than guessing |
| Both teams expose 7 states covering `backlog`, `unstarted`, `started`, `completed`, `canceled`, `duplicate` | `teams { states }` | `STATE_TYPE_TERMINAL` covers every observed type. `duplicate` maps to `Cancelled`, **not** `Done`, so a duplicated issue can never read as a shipped one |
| **A missing issue is HTTP 200**, not 404, with `data: null` and one `errors[]` entry: `"Entity not found: Issue"`, `extensions.code = INPUT_ERROR`, `extensions.statusCode = 400` | `issue(id: "00000000-0000-4000-8000-000000000000")` | `errors.ts` parses the envelope **before** consulting the status, and tests not-found ahead of invalid-input, because the not-found entry also carries `statusCode: 400` |
| Rate-limit headers are present and are **epoch milliseconds**: `x-ratelimit-requests-limit: 2500`, `x-ratelimit-requests-remaining: 2497`, `x-ratelimit-complexity-remaining: 2999999`, `x-ratelimit-requests-reset: 1790831299395` | headers of a successful call | `linearRetryAfterMs` reads the reset header and converts it to a duration from the injected clock. No `Retry-After` was ever sent |
| `Issue` has **no acceptance-criteria field** | all 85 fields read through `__type(name: "Issue")` introspection | Criteria can only come from the description. `readScope` extracts them from a marked region or a recognised heading and reports **none** otherwise rather than promoting prose bullets into criteria |
| `IssueCreateInput.id` is a client-supplied `String` | introspection | Publication identity is **derived from the `OperationId`**, so two attempts address the same Linear issue rather than two |
| `CommentCreateInput.id` is client-supplied | introspection | The managed comment's identity is derived from its operation, so a raced first delivery cannot create two |
| `IssueRelationCreateInput = { id, type, issueId, relatedIssueId }` | introspection | A re-run links nothing twice; the relation identity is derived from the operation and the dependency |
| `IssueUpdateInput` has `stateId` and **no expected-state precondition** | introspection | `requestTransition` re-reads immediately after the write and reports `Conflict` naming both states, rather than claiming a compare-and-set |
| `WorkflowState.type` is a plain `String`, not an enum | introspection | An unrecognised value is possible, so an unmapped type becomes `Unknown` with a reason, never a pass-through |
| Relation direction: every `Blocks` on one issue appears as `BlockedBy` on the other | 20 readable EGA issues, no disagreement in either direction | The outgoing/inverse mapping is correct as written. One `inverseRelations` row self-references and is dropped in both directions, or every issue would depend on itself |
| `issue(id: "EGA-664")` resolves a human-typed identifier to its UUID | `readScope` with a `KEY-123` identity | A typed identifier is **resolvable**, not refused. Only an identity that cannot be Linear's is `Forbidden` (F11-AC3) |
| Real scope reads, criteria extraction and related-work discovery produce correct shapes | `EGA-664` (0 criteria — its description is `## Idea` prose, correctly reported as no criteria) and `EGA-663` (47 criteria, 4 relations, 5 related issues) | The conservative "no criteria rather than invented criteria" behaviour was confirmed on real prose, not only on fixtures |
| `searchIssues` works with an 8-word natural-language phrase | 12/12 real EGA titles returned hits | `searchTermFor` was left alone. An earlier hypothesis that the long phrase was the problem was **disproved by measurement**; the defect was the similarity measure, not the term |
| A near-duplicate is findable only with a containment measure | 7,140 real title pairs across 120 issues: at a 0.5 gate Jaccard admitted 4 pairs, containment admitted 71 and ranked three near-identical `[W6][SPEC-006] Implement MCP … tool` issues at 0.833 | `lexicalOverlap` is a containment ratio. The **threshold is unchanged at 0.5**; only the measure was wrong, and Jaccard's length penalty was hiding duplicates |

## Proven against CONSTRUCTED payloads only

These are real code paths, exercised through the real client and the real mapping, but
the provider's response was authored by `stub.ts`. Treat them as translation proofs, not
compatibility proofs.

| Behaviour | Why it is not live-proven |
| --- | --- |
| `publishWork` / `completePublication` / `linkDependencies` | **Any** write proof would mutate the owner's workspace. Every write path in this adapter is unproven against Linear. |
| `updateManagedProgress` comment create and update | Same reason. The managed-marker format and the dedup logic are proven; the two mutations are not. |
| `requestTransition` state change | Same reason. |
| The rate-limit **category** mapping | Provoking a real rate limit would spend the shared workspace budget. Linear's own documentation describes it as HTTP 400 with `extensions.code = "RATELIMITED"`, which is handled, but neither that nor a 429 was observed. |
| `errors.ts` "already exists" markers | Linear's exact wording for a taken client-supplied `IssueCreateInput.id` is **unknown**. Matched on documented intent, and it is the one clause in the module not backed by a capture. If Linear words it differently, the raced-publication path returns `Invalid` instead of reconciling — a lost-response retry is still safe, because the retry re-reads first. |
| Capacity (`Blocked` on issue limit) | Recognised by content from Linear's own wording. Not observed. |
| `signature.ts` in full | Requires a publicly reachable HTTPS endpoint configured in the workspace, which does not exist. See below. |

## Exactly-once: what is and is not guaranteed

F10-AC3 forbids duplicate issues on a repeated publication. F30-AC5 forbids claiming
exactly-once where the provider has no atomic operation. Both are honoured, and the
distinction matters.

**`publishWork` is exactly-once, and the guarantee is the provider's.** Because
`IssueCreateInput.id` is client-supplied (confirmed live by introspection) and
`publicationIssueId` is a pure function of the `OperationId`, two attempts at one
publication carry the *same* Linear issue identity. Linear's uniqueness constraint is
what prevents the second issue — not a read-then-write in this adapter, which would have
a window. The read of the derived identity is there to report `AlreadyPresent`, not to
provide the safety.

**`updateManagedProgress` cannot be exactly-once, and says so.** There is a genuine
residual race: two processes can both read an issue with no managed comment, and both
create one. `CommentCreateInput.id` is client-supplied and derived from the
`OperationId`, which *bounds* the damage — the racing creates collide on one identity
rather than producing two comments — but Linear's behaviour when a client-supplied
comment id is reused was **not** observed, so this is a bound, not a proof. After the
race the loser must reconcile by reading the issue, which is what the contract's
`OutcomeUnknown` is for. F16-AC3's guarantee that matters — a repeated milestone does not
append a second comment — does hold, because a second delivery updates the *same*
comment in place rather than appending.

**`requestTransition` cannot be atomic at all.** Linear offers no expected-state
precondition, so a concurrent human edit can land between the read and the write. The
race is rechecked immediately after the write and reported as `Conflict` naming both
states. It is narrowed, never eliminated.

**A lost response is never a failure.** Every write is issued as a `mutating: true`
query, so a dropped connection becomes `OutcomeUnknown` carrying the operation identity
and target. Reporting it as a failure would invite the retry that produces the
duplicate the identity exists to prevent.

## One caller obligation worth stating

`updateManagedProgress` dedups on the `milestoneKey` **or** the operation identity, then on
a matching content digest. The operation-identity branch means that **a caller which
reuses one `OperationId` across two different milestone keys will have the second
suppressed.** That is the deliberate F30-AC2 reading — a replayed delivery is not
delivered again — and it is safe to detect rather than silent, because `Unchanged`
reports the `deliveredMilestoneKey` the provider actually holds, which will not match
the key that was asked for. A caller must mint a fresh `OperationId` per delivery.

## The contract suite, and what ran against what

This is the distinction a reader of `docs/handoff/slice-a.md` needs, because that
handoff records `N05-AC2` as "contract suite over fakes only".

**The shared suite cannot execute against this adapter, and that is structural rather
than an omission.** `runAdapterContractSuite` takes an `AdapterSet` whose `ticket` is
typed `FakeTicketAdapter` (`../testing/fake.ts`), and every case asserts against
`FIXTURE_*` identities such as `issue_fixture_01` and the sentinel
`providerRevision: 'fixture-revision-3'`. No real provider can return that string, so
the ticket cases are fake-only by construction: pointing them at a real adapter would
require the adapter to echo a fixture sentinel, which is inventing a capability. Editing
`../testing/` is outside this unit's file ownership, and it would weaken a shared
harness to make one provider look covered.

So the suite runs where it was written, against the fakes, and this adapter reproduces
the ticket-facing assertions in `linear.test.ts` against itself.

**Exactly 4 of the 14 cases touch the ticket adapter at all.** That was established by
extracting the `adapters.ticket.*` calls per case rather than by reading, and the other 10
are Git, engine, deployment, verification or event-delivery cases that this adapter is
never given.

| Contract case | Touches `ticket`? | Proven against the **real** adapter |
| --- | --- | --- |
| N05-AC2 unsupported operation → `Unavailable`, plus transition offered to the owner | yes (`requestTransition`, `describeTransitions`) | **No, and it cannot be** — see below |
| N05-AC2 wrong-provider identity → `Forbidden` | yes (`readScope`) | **yes** — including "no request reaches the provider" |
| F12-AC1 live scope read preserves criteria and dependencies | yes (`readScope`, `findRelatedIssues`) | **yes** |
| F30-AC2 a repeated write produces exactly one side effect | yes (`updateManagedProgress`, `publishWork`) | **yes** for the ticket half; the Git half is still fake-only |
| F28-AC4 lost response → `OutcomeUnknown` | no — Git only | ticket equivalent covered by `linear.test.ts` instead |
| F03-AC4 revoked access is actionable | no — Git only | ticket equivalent covered by `linear.test.ts` instead |
| F30-AC4 rate limit carries its category and hint | no — Git only | ticket equivalent covered by `linear.test.ts` instead |
| F26-AC3, F15-AC2, F19-AC5, F22-AC3, F28-AC3, F20-AC2, F30-AC2 (replay/late) | no | not applicable — no such adapter exists yet |

The N05-AC2 *unsupported* row is a real difference, not a gap in coverage. The fake
declares `Ticket:RequestTransition` unsupported with a "Developer Preview" limitation,
and the case asserts the owner is offered the transitions directly instead. Linear
supports all four ticket capabilities, so this adapter declares all four supported and
the case's premise is false for it. The suite's assertion is about the **harness**; the
adapter's own `F03-AC2` test asserts the declarations match what Linear actually offers,
and `linear.test.ts` covers the revoked-credential, rate-limit and lost-write paths that
the shared suite only exercises through Git.

## Webhook signature verification

`signature.ts` implements what Linear documents: `Linear-Signature` is a hex-encoded
HMAC-SHA256 of the **raw request body**, keyed with the webhook's signing secret, and
Linear states explicitly that re-stringifying a parsed body may change the signature. The
module therefore takes a `Uint8Array` and never accepts a parsed object. `signature.test.ts`
proves the negative cases that matter: wrong secret, missing header, non-hex signature,
single changed byte, and a body re-serialised after parsing being refused when the
signature was computed over the re-serialised form.

**A replay inside the acceptance window is not detectable and is not pretended to be.**
An HMAC over a payload cannot detect a replay; the same bytes with the same signature are
valid by construction. Freshness is therefore a separate condition, using
`Linear-Timestamp` when present and the body `webhookTimestamp` otherwise, and
disagreement between the two beyond the window is refused. A delivery still inside the
window verifies, and deduplication belongs to the store under the `Linear-Delivery`
identity. The test asserts exactly that instead of claiming a rejection the function
cannot make.

This is the one security-relevant part of the adapter whose algorithm is
**documentation-derived rather than observed**. It is unproven end to end until a
webhook endpoint is configured and a real delivery is captured.

## Known gaps

- **No write is proven against Linear.** A disposable project is required (mvp-spec 9).
- **`Issue` has no criteria field**, so criteria live in prose. A human who writes
  criteria as freeform prose under no recognised heading gets `acceptanceCriteria: []`,
  which is honest but means the run has no criteria to verify. A project profile should
  configure the headings, or ship the marked region.
- **The comment-page bound is 50.** A managed comment older than that is reported
  `Unavailable` rather than worked around, because working around it would create a
  second managed region.
- **`findRelatedIssues` similarity is a heuristic**, calibrated against 7,140 real title
  pairs but with no ground truth. It is presentation only and never an adoption
  decision — the contract has no auto-adopt variant and this adapter manufactures none.
- **The `DescriptionOverlap` gate is uncalibrated.** No live pair was measured for it, so
  it is left deliberately stricter than the title gate rather than tuned on a guess.
- **Signature verification is unproven end to end** (see above).
