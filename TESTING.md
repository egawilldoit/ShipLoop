# Testing and agent self-verification

The agent should prove its own implementation on the VM, including the real user
flow when an app exists. Owner testing remains a product decision, not a substitute
for agent verification. A missing test prerequisite is Blocked, never Passed.

## Available today

| Command | Coverage | Limit |
| --- | --- | --- |
| node scripts/doctor.mjs / pnpm doctor | Runtime, pnpm pin, Git, architecture, available memory/disk | No app, engine login or provider access check |
| pnpm check | Documentation links, config contracts, JavaScript syntax | No TypeScript app or runtime UI |
| pnpm test | Real domain, storage, adapters, verification, controller and web unit/integration tests, plus tooling behavior | Linux harness, synthetic fixtures, no browser |
| pnpm verify | Foundation check + tooling tests, sequential, bounded | Proves foundation only |
| pnpm verify:app | Foundation check, policy lint, six package typechecks, pnpm test, web build, browser E2E | Stops at its first failure; see the state below |
| pnpm e2e | Browser E2E only | Needs `pnpm build` first; the harness serves `dist/client` and starts its own server on an OS-assigned port |

### Current state of the application profile

The application profile is configured and executable. It is **red**, at one command:

| Command | Result |
| --- | --- |
| foundation-check, policy-lint | Passing |
| typecheck-domain, -storage, -adapters, -verification, -controller, -web | Passing |
| app-tests | Passing |
| web-build | Passing |
| browser-e2e | **Failing**, and only for the reason below |

`browser-e2e` fails on one assertion, `this run drove the shipped server entrypoint, not a
substitute`. Ten of its eleven specs pass. The reason is that `apps/web/src/server/main.ts`
refuses to start: `SHIPLOOP_CONTROLLER_MODULE` (`@shiploop/controller`) does not export the
`ControllerSurface` that `apps/web/src/server/contracts.ts` requires. The harness prints that
startup failure and substitutes a real in-process HTTP server so the remaining specs still run;
the assertion above exists so that substitution can never turn a broken startup into a passing
gate. It is an assertion, not a skip, so the command goes green by itself the moment the
controller is wired.

Consequently the browser suite currently proves the shipped client bundle, the responsive layout
and the domain session/CSRF rules. It does **not** yet prove server startup or the owner API. Do
not read a browser pass as application proof until that assertion passes on the same candidate.

The verification runner needs Linux. The product targets browser clients across
platforms; Windows/macOS runners are a later explicit portability milestone.
Actual ARM64 VM proof is required before claiming ARM64 support.

## Runner contract

verification.json owns profiles and commands. Commands are argument arrays executed
without a shell. Every command has a timeout and bounded captured output. The runner
cleans only its spawned POSIX process group. Programs that escape the process group
need stronger container/cgroup ownership before use; this tool is not a security sandbox.

Each run uses a private temporary HOME/XDG/TMP directory and an allowlisted environment,
with UTC and CI mode. It forwards no provider credentials. Test programs can still read
their working directory; use trusted checks and synthetic fixtures. Live contract tests
must be a separate explicitly configured workflow with scoped test access.

One environment value is passed through to commands deliberately: `PLAYWRIGHT_BROWSERS_PATH`,
resolved at run time from the real host, so the browser the app lockfile pins stays visible
inside the temporary HOME. Without it Playwright would look in an empty temporary cache, find no
Chromium, and try to download one - which an offline profile must never cause, and which would
make the check provision its own toolchain. It names installed tooling, not test state; the
temporary HOME still isolates every cache, data and config directory a command could inherit. On
a host with no cached browser the variable is omitted and the browser command fails and says the
executable is missing, which is a named failure rather than a hidden download.

Local reports are written to .shiploop-artifacts/verify/<run-id>/report.json.
They include profile, stage, timestamps, host/runtime, Git head, dirty-content digest,
per-command exit/signal/status/output truncation, and overall result. Capture current
state again at completion; a change during verification makes the run Stale.
This is development evidence, not the future signed candidate/release authority.
Inspect/sanitize before attaching excerpts to a PR; raw logs are not automatically public.

Exit codes: 0 Passed for the selected profile, 1 Failed, 2 Blocked, 3 Stale.
Interrupted/timeout commands fail; unknown profiles and unavailable required commands
block. Never retry a timeout blindly. Reports retain first-failure output and run ID.

## Checks to add as the application grows

The application profile now carries lint, six TypeScript typechecks, the real unit and
integration suites, a production build and browser E2E. What it still lacks, and must gain before
the profile is trusted as the pre-merge authority: live adapter contract tests, worker process
lifecycle coverage, and coverage of the owner flows beyond sign-in. Do not treat a bootstrap
command named test as fulfilling application coverage.

CI runs `pnpm verify` only, and that is deliberate rather than an oversight. Of the application
profile, every command except `browser-e2e` is green and is portable: the typechecks are pure
TypeScript, and `pnpm test` reaches durable state through Node's built-in `node:sqlite` with no
compiled native module, so an ARM64 pass is not hiding an x86-only build. `browser-e2e` cannot be
required yet for two independent reasons: the shipped entrypoint does not start, and
`apps/web/playwright.config.ts` deliberately never installs a browser, so a GitHub runner has no
Chromium and adding one would mean either a download step or a cached image.

So the workflow was left untouched in this change, and the gap is recorded rather than hidden
behind a disabled step: local evidence is stronger than CI evidence, and CI is still
foundation-only. The honest sequence is to land the controller wiring, add the browser to the
runner deliberately, confirm `pnpm verify:app` green on a candidate, and then add the application
profile to `.github/workflows/foundation.yml` in the same change that turns it green. Adding it
now would put a permanently red required check in front of every pull request, which trains
reviewers to ignore it.

For web work use Playwright headless Chromium, isolated browser state, synthetic
seeded data, and a server ready signal/health check with a deadline. Retain a failed
trace and inspected screenshot. Shut down only the owned server after tests. Browser
setup must prove a launch on the actual VM CPU/OS, not just download an executable.
Readiness waits are bounded polling only when there is no event/health mechanism.

`apps/web/e2e/fixtures.ts` is the working implementation of that paragraph: port `0` with the
bound address read back from the server, a fresh `mkdtemp` tree for data and artifacts, generated
credentials, no `storageState`, and `stop` in a `finally`. Readiness requires a 2xx from
`/api/health`, because a 401 or a 404 would prove only that a socket accepted bytes. When the
shipped entrypoint cannot start, the harness substitutes a real in-process server, prints the
startup failure, and asserts that it did so - so a substituted run is visible in the output, in
the `kind` field, and in a failing assertion.

## Proof matrix for each implemented slice

| Change | Required proof |
| --- | --- |
| Domain rule/state transition | Observable transition; rejected stale/invalid transition |
| Storage/durable job claim | Real temp SQLite; concurrent claim/restart/recovery; no second writer |
| Adapter/protocol | Typed contract tests and disposable live integration before claiming compatibility |
| Web behavior | UI/API path through real client; 375px and desktop when responsive behavior changes |
| Worker/process | Real child lifecycle, cancellation, timeout, owned cleanup and preserved workspace |
| Release/controller | Current head/authorization, duplicate/unknown-result reconciliation, deployed identity |
| Documentation only | Link/config sanity and git diff --check; no unrelated app suite |

Use deterministic adapter fixtures for rate limits, duplicate/out-of-order webhooks,
changed head/base, missing previews and lost external responses. Mocking an API does
not establish the provider's live compatibility. Inject clocks for domain timing;
real process timeouts need a small dedicated integration test, not arbitrary sleeps.

## Definition of verified work

Applicable criteria have evidence for the exact tested inputs. Required automated
checks pass; manual criteria are marked pending until the owner actually accepts.
No scope or head changed unnoticed. List what did not run and why. Fix a real defect
rather than weakening its test, increasing its timeout, or replaying until green.
