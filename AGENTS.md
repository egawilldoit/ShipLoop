# ShipLoop agent guide

ShipLoop turns an idea into clarified scope, Linear work, VM execution, tested
candidates, owner acceptance, and confirmed delivery. Read [ARCHITECTURE.md](ARCHITECTURE.md)
before changing lifecycle or integration behavior. The [MVP spec](docs/product/mvp-spec.md)
owns feature/acceptance IDs; it describes planned behavior, not implemented features.

## Current stage and commands

The web server and owner UI exist and are typechecked, tested and built by the commands below,
but the shipped entrypoint still refuses to start: `SHIPLOOP_CONTROLLER_MODULE` must export the
`ControllerSurface` from `apps/web/src/server/contracts.ts`, and `packages/controller` does not
yet. Treat this as a foundation with a partially assembled application, not a running product.
Node 24, pnpm **11.15.0** (package.json), Linux VM. Preserve the pnpm lockfile.
Run commands from this checkout; never paste `set -e` into the parent SSH shell.

| Command | What it proves |
| --- | --- |
| `node scripts/doctor.mjs` | Bounded bootstrap diagnostics, usable even if pnpm is broken |
| `pnpm doctor` | Node, pinned pnpm, Git, host resources |
| `pnpm check` | Foundation configuration, documentation links, JavaScript syntax |
| `pnpm test` | Domain, storage, adapters, verification, controller and web unit/integration tests |
| `pnpm verify` | Foundation checks/tests, with a local evidence report |
| `pnpm verify:app` | Foundation + lint + all package typechecks + `pnpm test` + web build + browser E2E |
| `pnpm e2e` | Browser E2E alone; needs `pnpm build` first (the harness serves `dist/client`) |

The application profile is configured, not blocked, and it stops at its first failure. Its
current honest state is that everything through `web-build` passes and `browser-e2e` is **red**:
the harness's assertion that the run drove `apps/web/src/server/main.ts` fails, because
`@shiploop/controller` does not yet export the `ControllerSurface` that
`src/server/contracts.ts` requires. Until that wiring lands, no browser run may be reported as
application proof, and the browser E2E command must stay failing rather than be waived.

[TESTING.md](TESTING.md) owns verification selection and the report format.
[VM development](docs/runbooks/vm-development.md) owns setup, processes, ports,
browser prerequisites, and SSH access. Do not invent commands absent from package.json.

## Before editing

1. Inspect Git status, branch, changed files, and the relevant existing code/tests.
   Preserve user changes. Use a separate worktree when another task owns the checkout.
2. Identify the requested outcome and applicable spec criteria. For a defect,
   reproduce at the actual failing entry point and distinguish tool failures from bugs.
3. Read the nearest scoped AGENTS.md and its linked guide before editing that area.
   The root governs shared behavior; scoped files add local facts.
4. Make the smallest coherent change. Put vendor behavior behind adapters, pure
   lifecycle rules in the domain, and privileged side effects in the controller.
   Add narrower agent guides when real packages exist; do not create empty scaffolds.

## Work through verification

- Normal implementation, debugging, testing, and scoped fixes already authorized
  by the task do not need repeated permission.
- Run focused meaningful tests while editing, then applicable required gates.
  Behavior changes need regression proof; UI changes need a real browser flow.
  Report platform/VM/external-service coverage actually exercised.
- Keep test state, browser storage, ports, and artifacts isolated. Use synthetic
  fixtures, explicit test accounts, and development credentials.
- Track PIDs at spawn. Stop only owned processes/groups. No pattern kills, no
  shared-service restart, no reset/clean/stash of unrelated work.
- Every unattended command has a deadline, bounded output, and an outcome.
  On a repeated identical failure, diagnose or change approach; do not loop for green.
  Follow [debugging](docs/runbooks/debugging.md).
- Never waive a required check, weaken an assertion, hide a failure with retries,
  or call skipped/missing checks passed. A foundation pass is not application proof.
- New evidence must identify the tested commit, dirty state, environment, profile,
  command, result, and limits. A changed candidate invalidates affected proof.
- Prefer typed contracts and small modules. Validate external input at adapter/API
  boundaries; preserve current state authority across asynchronous side effects.
- Keep secrets and live state out of code, logs, screenshots, and published reports.
  Ignored local artifacts are private until inspected and sanitized.

## Review, merge, and completion

Follow [CONTRIBUTING.md](CONTRIBUTING.md) and [review/release](docs/runbooks/review-release.md).
A request to implement permits a reviewable branch/draft PR when appropriate.
Merge or production release needs the owner's authorization for that candidate.
Recheck current refs, checks, deployment identity, and provider policy at the action.
Do not bypass provider rules or retry an uncertain write before reconciling it.

A task is done when its scoped behavior is implemented and applicable verification
is recorded, or a concrete blocker is explained with preserved recovery state.
Agent completion, owner acceptance, merged code, and released software are separate.
Summarize what changed, what ran, results, and material gaps. Link the PR once.

## Guidance ownership

- Product: [MVP specification](docs/product/mvp-spec.md).
- System boundaries: [architecture](ARCHITECTURE.md).
- Verification: [testing](TESTING.md); tooling-specific guide in [scripts](scripts/AGENTS.md).
- Operations: [VM](docs/runbooks/vm-development.md), [debugging](docs/runbooks/debugging.md),
  [review and release](docs/runbooks/review-release.md).
- Decisions: [ADRs](docs/decisions/README.md).
- Upstream pattern comparison: [reference analysis](docs/reference/upstream-guidance.md).

Update the owning document when behavior changes; do not append competing rules.
Explicit owner instructions define task scope; repository defaults cannot grant
production authority or permission to delete unrelated resources.
