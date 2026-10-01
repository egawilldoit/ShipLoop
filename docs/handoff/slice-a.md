# ShipLoop v0.1 — slice A handoff

Date: 1 October 2026. Branch `dev`. Pushed commit `8642f73`.

This records what is running, how to start it, what is proven, and what is not.
Slice A covers F01–F04 and the foundations of F30/F32. It is **not** the MVP.

## Start it

```bash
cd ~/projects/ShipLoop
pnpm install --frozen-lockfile
node scripts/doctor.mjs          # host, pinned pnpm, browser, resources

# First run only: provision the owner. The server refuses to start without this.
SHIPLOOP_DATABASE_PATH=.shiploop-dev/shiploop.db \
SHIPLOOP_CSRF_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')" \
SHIPLOOP_CONTROLLER_MODULE=@shiploop/controller \
SHIPLOOP_STATIC_ROOT=apps/web/dist/client \
SHIPLOOP_PORT=8787 \
node apps/web/src/server/main.ts

curl -s localhost:8787/api/health     # {"status":"ok"}
```

`SHIPLOOP_PORT=0` means "let the OS choose"; the caller must read the real bound
port from the server's startup output.

From the owner's browser, forward the port over SSH:

```bash
ssh -L 8787:127.0.0.1:8787 <this-vm>
# then open http://localhost:8787
```

The UI calls its own origin. There is no localhost API URL in the bundle and no
CORS header anywhere, so a reverse proxy or tunnel must stay same-origin.

## Verification

```bash
pnpm verify          # foundation: config, doc links, tooling tests
pnpm verify:app      # application: 11 real gates, all passing at 8642f73
```

`pnpm verify:app` runs, and all pass at `8642f73` on `linux/arm64`, node v24.18.0,
working tree clean:

| Gate | Result |
| --- | --- |
| `foundation-check` | Passed |
| `policy-lint` | Passed |
| `typecheck-domain` … `typecheck-web` (6 packages) | Passed |
| `app-tests` | Passed — 7 suites, 545 tests |
| `web-build` | Passed |
| `browser-e2e` | Passed — 12/12, real Chromium 1243 on ARM64 |

Unit and integration coverage by package: domain 298, storage 75, controller 47,
verification 43, web 33, adapters 8, foundation 13.

Browser evidence is real, not simulated. The suite spawns
`apps/web/src/server/main.ts` with the real `@shiploop/controller`, waits on the
real `/api/health`, and one spec asserts that the shipped entrypoint booted rather
than a substitute — so a server that cannot start fails the gate instead of being
worked around. Chromium is the revision already cached on this host; nothing is
downloaded.

## What slice A delivers

**Owner access (F01).** One provisioned owner signs in, refreshes and signs out.
The session cookie is `HttpOnly`, `Secure`, `SameSite=Strict`; the plaintext token
is minted in the web process and never leaves it, and only a digest is stored.
Sign-out revokes server-side, so the old cookie is refused. State-changing requests
need a CSRF token, and a request without one writes nothing — verified by
read-back. An unauthenticated request to any private route gets 401 with no private
data. Sign-in gives identical answers for a wrong password and an unknown owner, so
it is not an existence oracle.

**Project profiles (F02).** Versioned, append-only, compare-and-set. A save returns
a new version and the previous stays readable. Every missing field is reported under
its own path, so a form can show them all at once.

**Connectors and credentials (F03).** A connector stores a credential *reference*;
a value matching a secret pattern is refused before it is written. Status, last
check, last success, declared read/write capabilities and an actionable error are
all exposed. Revocation blocks the next operation while preserving history.

**Recipes and preflight (F04).** Versioned environment recipes with field-specific
validation. Preflight runs real probes through real bounded subprocesses and returns
`Blocked` naming the failed prerequisite — a missing runtime, an unreachable service
or a missing secret never reports as started successfully. A changed dependency
digest requires maintenance instead of silently reusing an old pass.

## Defects this slice found and fixed

The parallel work was reviewed rather than trusted, and the review paid for itself.

- **Ten defects in the pure domain layer**, found by the tests written to check it:
  `OutcomeUnknown` could reach `Released` (the blind repetition F28-AC4 forbids);
  `compareScope` never reported a removed dependency, so it could return
  `kind: 'Unchanged'` with its own fingerprints disagreeing; `assertTransition`
  accepted an unknown state when compared to itself; the Anthropic redaction rule
  was unreachable behind the OpenAI one; `stripSecretFields` deleted legitimate
  fields like `tokenCount` from an export; `upsertAttentionItem` persisted its input
  envelope; `checkAuthorization` accepted a `now` it never read, so no lapse of time
  could expire an authorization.
- **A `Waiting` required check reported ready** — a check that had not finished was
  treated as one that had, and the suite asserted the gap as intended.
- **The schema and repositories disagreed**: migrations created plural tables while
  the repositories read singular ones. The controller's own tests hid this by
  installing a private fixture schema, so every controller test was green against a
  database the app could never open. Fixed, and the fixture was deleted so the real
  `migrate(db)` is now the only thing under test.
- **Two session-token digest formats** that could never agree, so a real session was
  always refused. One function is now authoritative and the workaround is gone.
- **The web server and controller had never run in the same process.** `main.ts`
  could not start: `@shiploop/controller` did not export the surface it requires.
  The browser suite substituted a fake server to pass, which is why 12 specs were
  green while the app could not boot.
- **A `Waiting`-class gate dishonesty**: the E2E harness let a substituted server
  report a pass. It now declares the substitution and a spec asserts it did not
  happen, so the gate goes green only when the real server runs.
- **An intermittent application-gate failure**, roughly one run in six: a reaped
  descendant raises `ESRCH`, not `ENOENT`, and the test read that as a failure.

## What is NOT proven

Do not read the green gates as more than they say.

- **No adapter is real.** `packages/adapters` holds contracts, a deterministic fake
  and a contract suite. There is no Linear client, no GitHub client, no deployment
  client and no Codex invocation. F03-AC1, F03-AC2, all of F15 and N05-AC2 are
  **unproven against a live provider**; the suite proves the harness, and says so in
  its own header. Per the specification, contract tests must pass against a
  disposable external project before compatibility is claimed.
- **No profile can actually be saved in a running app.** `web-surface.ts` registers
  no adapters, so a save is refused with named capability errors rather than
  falsely accepted. That refusal is correct behaviour, and it means the profile and
  connector screens have never completed a round trip against real storage in a
  browser.
- **The coding engine is not wired.** Wave 0 proved Codex 0.159.1 executes a real
  tool call on this VM with working ChatGPT auth, but no product code invokes it.
- **The delivery boundary is not enforceable.** The available `gh` credential holds
  `repo` scope, which permits merging as well as pushing. F03-AC5 and N02-AC3 are
  policy-level only: `capability-grant.ts` refuses delivery to a coding actor, and
  that decision function is tested, but nothing stops a credential that can both
  push and merge. Owner action required: a push-only token or a branch-protection
  boundary.
- **No deployment provider credential exists on this host.** F22, F27-AC4, F28-AC2
  and F29 cannot be proven live. Owner action required.
- **The React UI has no component tests.** Its accessibility and 375px/1280px
  behaviour were verified by driving real Chromium by hand and by the browser specs,
  not by an automated component suite. N03-AC1 and N03-AC3 are unproven by automation.
- **N04-AC1** (p95 under 1s with 100 work items and 1000 events) has no dataset and
  no measurement.
- **The v4→v8 migration path over pre-existing rows is unproven.** Every migration
  test starts from an empty database or from `LATEST-1`.
- **`apps/worker` was deleted.** It was an empty scaffold that failed typecheck and
  aborted the whole gate. The worker is slice C work.

## Criterion status

| Criterion | Status | Evidence |
| --- | --- | --- |
| F01-AC1 | proved | `api.test.ts`, `auth-boundary.spec.ts`, real Chromium |
| F01-AC2 | proved | `api.test.ts`, `auth-boundary.spec.ts`, real session row |
| F01-AC3 | partial | 375/1280 measured; intake, attention, review card and approval surfaces do not exist yet |
| F01-AC4 | proved | CSRF proved twice; write-nothing read-back |
| F01-AC5 | partial | disconnected state proved; no offline/cache authorization surface yet |
| F02-AC1 | unproven | no successful save in a running app (no adapters registered) |
| F02-AC2 | partial | compare-and-set proved at API; no run uses a profile yet |
| F02-AC3 | proved | append-only, supersedes chain, history retained |
| F02-AC4 | proved | every field path reported together |
| F02-AC5 | partial | proxy only |
| F03-AC1 | **blocked** | no adapter exists |
| F03-AC2 | partial | declared capabilities, not probed |
| F03-AC3 | proved | secret-shaped value refused before persistence; no secret in any response |
| F03-AC4 | partial | blocks the next operation; no running attempt to preserve |
| F03-AC5 | partial | policy proved; credential boundary not enforceable |
| F04-AC1 | partial | validated record nothing executes |
| F04-AC2 | proved | real subprocesses through the production runner |
| F04-AC3 | proved | `Blocked` names the prerequisite |
| F04-AC4 | proved | dependency drift requires maintenance |
| F04-AC5 | partial | owned cleanup proved; no VM pilot run |
| N02-AC1 | partial | transport proved; no webhook ingress yet |
| N02-AC2 | proved | seeded secret absent from refusals, logs, artifact names |
| N02-AC3 | partial | policy proved; credential enforcement blocked |
| N03-AC1 | unproven by automation | verified by hand in real Chromium |
| N03-AC2 | unproven | surfaces not built |
| N03-AC3 | unproven by automation | verified by hand in real Chromium |
| N04-AC1 | unproven | no dataset |
| N04-AC2 | partial | 4s poll constant; no milestone to propagate |
| N04-AC3 | unproven | no job path in the web layer |
| N05-AC2 | partial | contract suite over fakes only |
| N08-AC1 | partial | migrations tested from empty and `LATEST-1` |

## Next

Slice B (F06–F11: intake, clarification, plan, readiness, publication, adoption) and
slice C (F12–F19: the worker) are the next increments. The adapters package needs a
real Linear client first, because without it no profile can be saved and slices B
and D both depend on that.