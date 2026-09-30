# Testing and agent self-verification

The agent should prove its own implementation on the VM, including the real user
flow when an app exists. Owner testing remains a product decision, not a substitute
for agent verification. A missing test prerequisite is Blocked, never Passed.

## Available today

| Command | Coverage | Limit |
| --- | --- | --- |
| node scripts/doctor.mjs / pnpm doctor | Runtime, pnpm pin, Git, architecture, available memory/disk | No app, engine login or provider access check |
| pnpm check | Documentation links, config contracts, JavaScript syntax | No TypeScript app or runtime UI |
| pnpm test | Real subprocess success/failure/deadline, owned descendants, output caps, configuration/report behavior | Linux harness, synthetic fixtures |
| pnpm verify | Foundation check + tooling tests, sequential, bounded | Proves foundation only |
| pnpm verify:app | Application profile | Exits 2 Blocked until configured |

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

Local reports are written to .shiploop-artifacts/verify/<run-id>/report.json.
They include profile, stage, timestamps, host/runtime, Git head, dirty-content digest,
per-command exit/signal/status/output truncation, and overall result. Capture current
state again at completion; a change during verification makes the run Stale.
This is development evidence, not the future signed candidate/release authority.
Inspect/sanitize before attaching excerpts to a PR; raw logs are not automatically public.

Exit codes: 0 Passed for the selected profile, 1 Failed, 2 Blocked, 3 Stale.
Interrupted/timeout commands fail; unknown profiles and unavailable required commands
block. Never retry a timeout blindly. Reports retain first-failure output and run ID.

## Checks to add when the application exists

Replace the blocked application profile with actual commands only when all of these
exist: lint/format, TypeScript typecheck, domain/controller tests, real storage/adapter
integration tests, production build, and browser E2E for the relevant user flow.
Do not treat a bootstrap command named test as fulfilling application coverage.
Then CI must run the configured application gates on the proposed commit.

For web work use Playwright headless Chromium, isolated browser state, synthetic
seeded data, and a server ready signal/health check with a deadline. Retain a failed
trace and inspected screenshot. Shut down only the owned server after tests. Browser
setup must prove a launch on the actual VM CPU/OS, not just download an executable.
Readiness waits are bounded polling only when there is no event/health mechanism.

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
