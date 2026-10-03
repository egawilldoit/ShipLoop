# GitHub git adapter

The first Git provider adapter in ShipLoop. It implements the full `GitAdapter` contract
from `../contracts/git.ts`: `readState`, `readChecks`, `pushBranch`, `findDrafts`,
`upsertDraft`, `declareNoCodeOutcome` and `mergePullRequest`, plus the `AdapterIdentity`
surface (`capabilities`, `checkCompatibility`). It also carries one method beyond the
contract, `readCommitRange`, because `GitStateRead` has no slot for a commit range and F20-AC1
needs one.

It carries a second method beyond the contract, `readLinkedPullRequest`, for the MVP candidate
journey (`../contracts/candidate-link.ts`). That contract is deliberately **read-only** and this
method is its only provider call beyond `readChecks`: it reads one pull request by display
number for an owner who pasted its address. It answers a different question from `readState`,
which takes a *branch* and reports the latest pull request for it; `readLinkedPullRequest`
takes the *number* the owner named, which is the question manual linking asks. See
"Proven against CONSTRUCTED payloads only" for its proof status.

This file exists because **"it typechecks" and "it works against GitHub" are different
claims**, and only one of them is evidence. Everything below is separated into what was
observed from the live API and what is proven only against constructed payloads. Where a
guarantee is weaker than the contract's wording, the weaker truth is stated here rather than
left for a reader to discover.

- Probed live on **1 October 2026**, `linux/arm64`, Node v24.18.0, against
  `egawilldoit/ShipLoop` through the owner's own `gh` credential.
- Base commit: `6170bb5`.
- **Every live call was read-only.** Nothing was created, modified, merged, pushed to or
  closed in any repository. See "Live write paths are unproven" below.

## Layout

| File | What it owns |
| --- | --- |
| `client.ts` | The REST transport (auth header, pinned API version, rate-limit policy, lost-write classification) and the `git` CLI transport (argv only, group-killed on abort) |
| `errors.ts` | GitHub status, error body and `git` stderr to `DomainError`; check-run and commit-status mapping |
| `adapter.ts` | The `GitAdapter` implementation: reads, translation, reconciliation, writes, merge |
| `candidate-link.ts` | Narrows this adapter to the read-only `CandidateGitPort` the MVP candidate journey is handed |
| `github.test.ts` | The adapter's own tests, plus the scripted REST and `git` surfaces they drive |
| `candidate-link.test.ts` | `readLinkedPullRequest`, the check mapping and the read-only port, against its own scripted REST surface |

Every assertion in `github.test.ts` travels through the shipped `client.ts`, `errors.ts` and
`adapter.ts`. Only HTTP and the `git` argv are scripted, and only by the `StubGitHub` and
`StubGit` classes at the top of the test file. What those add is the one thing `fetch` cannot
give: a record of which requests and argv arrays were actually issued, which is what turns
"a retry produced exactly one pull request" into an assertion rather than a claim.

## Commands

```bash
# typecheck (from the repository root)
node /home/ubuntu/projects/ShipLoop/node_modules/typescript/bin/tsc --noEmit -p packages/adapters/tsconfig.json

# project policy lint
node scripts/lint.mjs

# this adapter only
node --test packages/adapters/src/github/github.test.ts

# every package's tests
node scripts/run-tests.mjs

# the opt-in live pass (read-only)
SHIPLOOP_GITHUB_TOKEN="$(gh auth token)" SHIPLOOP_GITHUB_LIVE_REPOSITORY="egawilldoit/ShipLoop" \
  node --test packages/adapters/src/github/github.test.ts
```

The live test is skipped by default and says why, naming the missing prerequisite:

```
﹣ N05-AC2 a live read-only pass reads identity, refs, checks, a range and the pull request list
  # no SHIPLOOP_GITHUB_TOKEN in the environment; the live pass needs a real credential
```

Run with both variables set, the same file reports `tests 49 / pass 49 / fail 0 / skipped 0`.

## Token permissions: what was VERIFIED and what was assumed

This is the part of the adapter most easily misread, so it is stated first.

**The credential this adapter was probed with can both push and merge.** `gh auth status`
reports token scopes `admin:public_key, gist, read:org, repo`, and the `repo` scope grants
write access to the repository, which is the permission GitHub derives merging from. The
repository read confirms what that means in practice:

```json
{"allow_auto_merge":false,"allow_merge_commit":true,"allow_rebase_merge":true,
 "allow_squash_merge":true,"archived":false,"default_branch":"main",
 "delete_branch_on_merge":false,"full_name":"egawilldoit/ShipLoop",
 "permissions":{"admin":true,"maintain":true,"pull":true,"push":true,"triage":true},
 "private":false}
```

```json
{"permission":"admin","role_name":"admin","user":"MORTAKI0"}
```

So this credential **cannot** enforce "the coding stage may push but not merge"
(F03-AC5, N02-AC3). Nothing in GitHub's token model separates the two for this credential,
and nothing in this adapter pretends otherwise. The merge capability is declared
`privileged: true`, so `declaredPrivilegedCapabilities` places it outside a coding-stage
grant — but that boundary is enforced by **who is handed which credential**, which is the
orchestrator's separate broker lane, not by this adapter. `README.md` does not claim a
boundary the token does not provide.

Two further live facts weaken any assumption that the provider would have caught a stale
merge anyway:

```json
{"name":"main","protected":false,
 "protection":{"enforce_admins":null,"required_pull_request_reviews":null,
 "required_status_checks":{"checks":[],"contexts":[],"enforcement_level":"off"}},
 "required_status_checks":null}
```

```json
[]
```

`main` is unprotected and the repository has no rulesets. Nothing at GitHub would have refused
a merge of unreviewed code on this repository as it stands today. The precondition this adapter
relies on is one **it supplies** (the pinned `sha`), not one the repository enforces.

### Verified versus assumed

| Statement | How it was established |
| --- | --- |
| The credential is valid and can read the repository | `gh auth status`, `GET /user`, `GET /repos/egawilldoit/ShipLoop` — all live |
| Its scopes are `admin:public_key, gist, read:org, repo` | `x-oauth-scopes` response header on a live call |
| It holds `admin` on this repository | `permissions` block on the live repository read, and the collaborator-permission endpoint |
| It **can merge** | **Inferred** from `repo` scope + `permissions.push: true` + `allow_merge_commit: true`, **not** proven by performing a merge. Provoking one would mutate live state. |
| It **can push** | The ssh key is accepted (`ssh -T git@github.com` → `Hi MORTAKI0!`) and pushes have succeeded on this repository all session — but **not by this adapter**, see below. |
| `main` is unprotected; there are no rulesets | Live branch read and a live `GET /rulesets` |
| Merge and all three merge methods are enabled | Live `allow_merge_commit` / `allow_squash_merge` / `allow_rebase_merge` |
| The REST API version in use is `2022-11-28` | `x-github-api-version-selected` response header on every live call |
| The rate-limit budget is 5000/hour and the reset header is epoch **seconds** | Live headers: `x-ratelimit-limit: 5000`, `x-ratelimit-remaining: 5000`, `x-ratelimit-reset: 1790847829` |

## Proven against the LIVE API

Each row was observed on 1 October 2026 with a real credential. Nothing here is inferred from
documentation.

| Fact | Live capture | Consequence in the code |
| --- | --- | --- |
| `GET /repos/{owner}/{repo}` returns `full_name`, `default_branch` (`"main"`), `html_url`, `ssh_url`, `clone_url`, `archived`, and a `permissions` block | the JSON above | `readRepository` reads exactly these, and `checkCompatibility` reports the granted flags rather than asserting access |
| `GET /user` resolves the identity | `{"id":115146963,"login":"MORTAKI0","type":"User"}` | compatibility detail names the default branch and the permissions the credential holds |
| A **missing ref is HTTP 404 with a flat error object**: `{"message":"Not Found","documentation_url":"https://docs.github.com/rest/git/refs#get-a-reference","status":"404"}` | `GET /repos/egawilldoit/ShipLoop/git/ref/heads/does-not-exist` | `parseGitHubError` reads `message` before the status; `refRead` turns a 404 into `Missing` with a reason, not a failure |
| Branch refs resolve: `main` → `e073a09ee54854f0ee7770087ed88369aee58720`, `dev` → `b0ab89d8f29a99545c37655466b90ef01b86d8fd` | `GET /branches/{b}` | full 40-character SHAs throughout; `isCommitSha` is applied to **every** SHA read back |
| `GET /commits/{sha}/check-runs` reports one run: `{"app":"github-actions","completed_at":"2026-09-30T18:48:22Z","conclusion":"success","id":110043771706,"name":"foundation","started_at":"2026-09-30T18:48:09Z","status":"completed"}` | live on the `main` head | `id` arrives **unquoted**, so provider identities are read as string-or-integer; `conclusion: "success"` maps to `Passed` |
| `GET /commits/{sha}/status` returns `{"state":"pending","total_count":0,"statuses":[]}` on a commit with **no** statuses | live on the `main` head | the aggregate `state` is deliberately **not** mapped. Mapping it would report a `Waiting` check for a commit on which nothing ran. Only per-status entries become observations |
| `GET /pulls?state=open` returns `[]` — no open pull requests | live | the reconciliation read has an empty answer to reconcile against on this repository today |
| `GET /compare/main...dev` returns `{"ahead_by":66,"base":"e073a09e…","behind_by":0,"merge_base":"e073a09e…","status":"ahead","total_commits":66}` | live | `readCommitRange` reports `mergeBaseSha` separately from `baseSha`; they are different facts |
| `GET /repos/{o}/{r}/branches/main` reports `protected: false` and `GET /rulesets` returns `[]` | live | `approvalRules` finds no rule to report and says nothing; README records that the provider enforces nothing here |
| Rate-limit headers are **epoch seconds** | `x-ratelimit-limit: 5000`, `x-ratelimit-reset: 1790847829` | `githubRetryAfterMs` multiplies before subtracting. This is the opposite unit from the Linear adapter's epoch-millisecond headers, so the test asserts it explicitly |
| An invalid bearer token is **HTTP 401** | live probe with a deliberately invalid token | `mapGitHubFailure` maps 401 to `Forbidden` with a reauthorization instruction |
| `x-oauth-scopes` is returned on authenticated calls | `admin:public_key, gist, read:org, repo` | the credential's authority is observed rather than assumed |

## Derived from GitHub's published OpenAPI, not from a live capture

These were read from `github/rest-api-description`'s `api.github.com.json`, which is the
schema GitHub publishes. They are documentation, not measurement, and each row says what
confirming it live would have cost.

| Behaviour | Source | Why it was not live-proven |
| --- | --- | --- |
| `POST /repos/{o}/{r}/pulls` accepts `title`, `head`, `head_repo`, `base`, `body`, `maintainer_can_modify`, `draft`, `issue` — **and no `id`** | OpenAPI request body schema | Creating a pull request mutates live state. This absence is the single most consequential fact in the adapter (see below) |
| `PATCH /repos/{o}/{r}/pulls/{n}` accepts `title`, `body`, `state`, `base`, `maintainer_can_modify` — **not `draft`** | OpenAPI | Same reason. Consequence: this adapter does **not** implement marking a draft ready for review, because the documented update body has no field for it |
| `PUT /repos/{o}/{r}/pulls/{n}/merge` accepts `sha` — "SHA that pull request head must match to allow merge" — and `merge_method` of `merge` / `squash` / `rebase`; returns `{sha, merged, message}` | OpenAPI | Merging is a live-state change. The endpoint's **own description** is `Conflict if sha was provided and pull request head did not match` with example body `{"message":"Head branch was modified. Review and try the merge again."}` |
| A merge that cannot be performed is **HTTP 405**, `{"message":"Pull Request is not mergeable"}` | OpenAPI | Provoking it needs a live merge attempt against an unmergeable pull request |
| Check run `status` is one of `queued`, `in_progress`, `completed`, `waiting`, `requested`, `pending`; `conclusion` is one of `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required`, nullable | OpenAPI enum | The live repository has one run, so five of the six statuses were never observed |
| `GET /commits/{sha}/branches-where-head` resolves a commit to the branches that point at it | OpenAPI | The live repository's commits were read, but resolving one would need no write — this one *is* available to a live proof and is exercised only by the scripted surface today |
| `GET /pulls/{n}/reviews` returns reviews whose `state` is `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING` | OpenAPI | No open pull request exists on the repository to carry a review |
| `GET /branches/{b}/protection/required_pull_request_reviews` returns `required_approving_review_count` | OpenAPI | `main` is unprotected, so this endpoint returns 404 on every branch here |
| The auth header is `Authorization: Bearer <token>` | OpenAPI plus a live 200 on every call above | The 401 probe confirms the header is what authenticates, not that no other form works |
| A pull request reports `state` (`open` / `closed`), `merged`, `merged_at`, `merge_commit_sha`, `draft` | OpenAPI | No open pull request to read |
| `head.repo.full_name` distinguishes a pull request opened from a fork | OpenAPI | No open pull request to read. `readLinkedPullRequest` reports it so a controller can refuse a fork rather than attribute a stranger's commits to the project; that refusal is proven only against a constructed payload |

## Proven against CONSTRUCTED payloads only

Every write path, and several read paths, are exercised through the real client and the real
mapping against responses authored by the test file. Treat them as translation proofs, not
compatibility proofs.

| Behaviour | Why it is not live-proven |
| --- | --- |
| `pushBranch` — the whole path, including `AlreadyPresent`, `ForceWithLease`, a rejected non-fast-forward and a refused credential | **Any** push would write to the owner's repository. `git push origin HEAD:refs/heads/task/gitad-a` from this worktree is exactly what the adapter does, but doing it through the adapter is unproven until a disposable fixture repository exists |
| `upsertDraft` create | Creating a pull request on the owner's repository is not acceptable |
| `upsertDraft` update and the lost-create recovery | Same reason |
| `declareNoCodeOutcome`'s `PushedWithoutDraft` branch | Requires a branch that exists without a draft; the live repository has neither |
| `mergePullRequest` in every outcome, including the 409 precondition refusal and the 405 refusal | Merging is the one action this adapter exists to perform safely, and performing it live is not authorized |
| The 409 → `Conflict` and 405 → `Blocked` mappings | Both require a live merge attempt against a deliberately wrong state |
| Every check conclusion other than `success` | The live repository has one check run, and manufacturing others means pushing a branch and running CI |
| `Stale` derivation | Requires a required check reported on a base commit but not on a candidate head; no such pair exists here |
| Review states other than "no reviews" | No pull request exists to review |
| `readLinkedPullRequest` — the whole path, including the abbreviated-head refusal, the fork report, the merged/closed/unrecognised state mapping and every refusal before it | The live repository has no pull request to read. Reading one would need `upsertDraft` to create it, which is a write this unit is not authorized to perform |

## Live write paths are unproven — owner action required

**Not one write in this adapter has been executed against GitHub.** The MVP requires a
disposable fixture repository (mvp-spec 9) and one does not exist. Creating one was not in
this unit's authority, so none was created.

Until the owner provides a fixture repository, the following remain
**deterministic-scripted only**: every `pushBranch` write, every `upsertDraft` create and
update, and every `mergePullRequest` call. The read paths, the error mapping, the SHA
rejection, the check mapping, the reconciliation *order* and the marker round trip are all
proven against real code; what is unproven is GitHub's response to a write.

## Exactly-once: what is and is not guaranteed

F19-AC1 requires one linked draft. F19-AC3 requires a lost create response to be reconciled
before any retry. F30-AC2 forbids claiming exactly-once where the provider has no atomic
operation. All three are honoured, and the distinction matters.

**GitHub offers no uniqueness constraint on pull-request creation.** The create endpoint's
body has no client-supplied `id` — this is the documented absence, and it is the difference
that shapes this adapter. The Linear adapter can derive a stable issue identity from the
`OperationId` and let Linear's own uniqueness constraint make a repeat collide; nothing here
can do that.

So exactly-once is achieved by **reading before writing**, not by a provider constraint:

1. `upsertDraft` with no `existingDraft` **first** lists the open pull requests and looks for
   one whose body carries this operation's managed marker. That is the reconciliation read,
   and it happens before any create.
2. A match is adopted and reported `RecoveredAfterLostResponse`, with a detail saying the
   draft was found rather than created.
3. No match means a create is issued. A lost response is `OutcomeUnknown` carrying the
   operation identity, and the adapter never retries internally.
4. The next call with the same operation identity repeats step 1, finds the pull request the
   lost create produced, and finishes — with **no second create**.

The test `F19-AC3 a lost create response is OutcomeUnknown, and the retry adopts the same pull
request rather than creating a second` proves this end to end through the real code: it counts
`POST /repos/egawilldoit/ShipLoop/pulls` calls and asserts the count is 1 after the lost
response, after `findDrafts`, and after the retry.

**The residual race is real and is not eliminated.** Two processes that both complete step 1
before either completes its create can both create a pull request. The window is between the
read and the create inside one call, and nothing at the provider closes it. F30-AC5's honest
form of the guarantee is therefore: *a repeated write under the same operation identity
produces one draft in every case where the operations are sequential, and a concurrent race
would produce two drafts that reconciliation would then have to disambiguate.* A future
GitHub-side mitigation would be a repository ruleset or a pre-agreed draft-naming convention
the orchestrator enforces; neither is in this adapter.

**The managed marker is what makes this possible at all.** It is written into the draft body,
which GitHub makes queryable, and it carries the operation identity, the head, the base, the
linked-work identity and a content digest. Reconciliation keys on the operation identity
because it survives a head change: a draft whose branch advanced is still the draft that
operation created, and finding it by head alone would miss it.

**`git push` cannot be made atomic against the API and is not.** `POST /git/refs` refuses a
SHA the remote has never seen, so publishing locally created objects requires the git
protocol. A push is therefore verified by reading the remote ref back afterwards, and a
mismatch between what was pushed and what the ref now reads is `OutcomeUnknown` rather than
`Pushed`. `ForceWithLease` pins the remote ref read from the API immediately before the push,
so a branch that advanced after that read is refused by git rather than overwritten.

**A merge is verified, not assumed.** The precondition is sent as GitHub's own `sha`, the
merge response is followed by a read of the pull request, and only a read-back reporting
`merged: true` with a full merge-commit SHA produces `Merged`. An already-merged pull request
is `AlreadyMerged` with that commit — which is also how a lost merge response is reconciled
rather than repeated. A `NoProviderPrecondition` request is **refused** as `Unavailable`,
because GitHub does offer the precondition and F26-AC3 requires using it where one exists.

## Check-result mapping

Every `CheckResult` in the domain vocabulary is reachable, and only `success` becomes
`Passed`:

| GitHub | Domain | Why |
| --- | --- | --- |
| `status` in `queued`, `in_progress`, `waiting`, `requested`, `pending` | `Waiting` | A check that has not finished has produced no observation. F20-AC2's exact case |
| `completed` + `success` | `Passed` | the only pass |
| `completed` + `failure`, `timed_out`, `action_required`, `cancelled` | `Failed` | a terminal non-success |
| `completed` + `skipped`, `neutral` | `NotApplicable` | **not** `Passed`. F20-AC2 names skipped required checks explicitly, and `isBlocking` still blocks `NotApplicable` until a profile policy approves it |
| `completed` + a conclusion this adapter does not recognise | `Missing` | an unknown conclusion is not a pass and not a verified failure either |
| an unrecognised `status` | `Missing` | same reasoning |
| required by the profile, reported on neither the candidate nor the base | `Missing`, `requirement: 'ProfileRequired'` | a gate that never ran |
| required by the profile, reported on the base but not the candidate | `Stale`, `requirement: 'ProfileRequired'` | a green result belonging to a superseded revision. F20-AC3, F24-AC4 |
| a run whose own `head_sha` differs from the requested head | `Stale` | the provider reported it against a different revision |
| reported and not in the profile's required list | `ProviderExtra` | presentation only |

Commit statuses are read alongside check runs, because GitHub reports both and a project
whose CI posts statuses would otherwise appear to have no results. **The aggregate `state`
field is not mapped at all**, for the reason recorded above: it read `pending` on a live commit
with zero statuses.

## One caller obligation worth stating

`findDrafts` and the reconciliation inside `upsertDraft` key on the managed marker, so a
caller must mint **one `OperationId` per draft delivery**. Two operation identities produce
two markers and therefore two drafts, which is the correct outcome for two deliveries rather
than a defect. The fallback clause — matching a draft by head and linked work — is what adopts
a draft written before a restart, and it is only reached when no marker matches.

## The contract suite, and what ran against what

The Git-facing cases of `../testing/contract-suite.ts` run against `FakeGitAdapter`, not
against this adapter, and that is structural rather than an omission: the suite's cases assert
against `FIXTURE_*` sentinels such as `issue_fixture_01`, `fixture/repo` and
`providerRevision: 'fixture-revision-3'`. No real provider returns those, and pointing the
suite at a real adapter would require the adapter to echo fixture sentinels, which is inventing
a capability. `../testing/` is outside this unit's file ownership.

So the suite runs where it was written, and the Git-facing assertions are reproduced in
`github.test.ts` against the real code:

| Contract case | Proven against the **real** GitHub adapter |
| --- | --- |
| F30-AC2 a repeated write with one operation identity produces exactly one side effect | **yes**, for `upsertDraft` and for `pushBranch` (`AlreadyPresent`) |
| F28-AC4 a lost response yields `OutcomeUnknown` and is reconciled without a second write | **yes** — the case's central behaviour, and the one this unit exists for |
| F03-AC4 revoked access is an actionable error reported once | **yes** (401 → `Forbidden`, `compatible: false`, one request) |
| F30-AC4 a rate limit carries its category and retry hint | **yes**, including the epoch-**second** unit this provider uses |
| F26-AC3 a merge is refused when the head precondition no longer matches | **yes**, including the `DiffersFromAuthorizedHead` follow-up |
| F19-AC5 a read-only job completes with a no-code outcome and no draft | **yes** |
| F20-AC2 every check result state is preserved | **yes** for every state GitHub can report, plus the `Stale` and `Missing` derivations |
| F12-AC1, F15-AC2, F22-AC3, F28-AC3, F30-AC2 (late replay) | not applicable — those are ticket, engine, deployment and event-delivery cases |

The ticket, engine, deployment and verification halves of the shared suite remain
fake-only, exactly as `../linear/README.md` records for the ticket half.

## Known gaps and limits

- **No write is proven against GitHub.** A disposable fixture repository is required
  (mvp-spec 9). Every write path is deterministic-scripted only.
- **Exactly-once draft creation is not provider-guaranteed** and the concurrent-create race
  is not eliminated. See the section above; this is the honest form of F19-AC1.
- **`Git:UpdateDraft` cannot un-draft a pull request.** GitHub's documented update body has
  no `draft` field, so marking a draft ready for review is not something this adapter can do
  through the REST API. It is not claimed in the capability declaration.
- **The credential can push *and* merge.** The push/merge boundary is the orchestrator's
  credential broker, not this adapter and not this token. See the top of this file.
- **Nothing at the provider protects this repository.** `main` is unprotected and there are no
  rulesets, so a merge would succeed without any review the adapter knows about. The
  precondition it supplies is the only gate.
- **A push is verified by reading the ref back, not atomically.** An object transfer can
  partially complete; the adapter reports `OutcomeUnknown` rather than `Pushed` when the
  read-back disagrees.
- **Commit statuses are read but their aggregate `state` is not.** A project that only ever
  reads the aggregate would see nothing; per-status entries are the observations.
- **A commit that is no longer any branch's head cannot open a draft.** GitHub's create
  endpoint takes a branch, and the contract names only a head commit, so the adapter resolves
  one through `branches-where-head` and reports `Invalid` when there is none.
- **Branch-protection reads need administration.** A 403 on the protection endpoint is treated
  as "no rule to report", which is correct for an unprotected repository and **silent** for a
  protected one this credential cannot read. A profile that requires an approval rule should
  not rely on this read alone.
- **The pull request list is bounded** at three pages of 100. A repository with more open
  pull requests and no ShipLoop marker on any of the first 300 is reported `Unavailable`
  rather than reporting "none found" from a prefix — working around the bound by widening it
  could create a second draft.