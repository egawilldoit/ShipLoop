# Upstream agent guidance: reuse decisions

Inspected 2026-09-30 through GitHub at the full commits below. This is an assessment
for ShipLoop, not a promise that upstream APIs, commands or policies stay unchanged.
Instructions are written specifically for ShipLoop; no vendor code is included.

## What to adapt

| Upstream | Relevant observed pattern | ShipLoop adaptation | Do not transplant |
| --- | --- | --- | --- |
| Hermes | Root guide routes to scoped guides; canonical test wrapper scrubs credentials, uses temporary state and file subprocess isolation; behavior contracts and real integration paths | Short entry point with owned linked guides; one bounded runner, isolated HOME/state, deterministic fixtures and real boundary proof | Python/PM toolchain, Hermes-specific prompt-cache rules, its repository size/concurrency, reset-based merge advice |
| T3 Code | Captured process ownership, worktree-local state, actual port reporting, same-origin remote UI, adapters outside pure orchestration, focused tests and typed receipts | Never kill by pattern or use live T3 data; per-run resources; remote-browser coverage; provider boundaries and bounded ready/completion signals | vp commands, Electron/mobile scope, copying live secrets/data, its browser-permission and full-suite policies |
| Codex | Scope-specific wrappers, integration tests at the public protocol, generated schema updates, small API surfaces, host-native testing | Commands owned by package scripts; protocol/contract tests; generated artifacts change with schemas; explicitly report tested OS/CPU | Rust/Cargo/Bazel commands, platform-specific sandbox rules, treating Codex's internal repo policies as our permissions |
| OpenClaw | One authority per responsibility, explicit lifecycle ownership, early prerequisites, bounded troubleshooting, current authority before side effects, safe resource cleanup | Linear/Git/deployment ownership map; immutable candidate decisions; two-identical-failure recovery rule; isolated fixtures and truthful current proof | Direct-to-main emergency pushes, permissive failing-check/admin bypass policies, organization-specific release tools |

The strongest combination for this MVP is **T3's remote/process discipline + Hermes's
isolated runner + Codex's contract proof + OpenClaw's ownership/recovery model**.

## Files read and source snapshots

### Hermes — 3294d683af459f42f2e3d0d8e5e89dffd55e9544

- [AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/3294d683af459f42f2e3d0d8e5e89dffd55e9544/AGENTS.md)
- [CONTRIBUTING.md](https://github.com/NousResearch/hermes-agent/blob/3294d683af459f42f2e3d0d8e5e89dffd55e9544/CONTRIBUTING.md)
- [README.md](https://github.com/NousResearch/hermes-agent/blob/3294d683af459f42f2e3d0d8e5e89dffd55e9544/README.md)
- [pyproject.toml](https://github.com/NousResearch/hermes-agent/blob/3294d683af459f42f2e3d0d8e5e89dffd55e9544/pyproject.toml)
- [scripts/run_tests.sh](https://github.com/NousResearch/hermes-agent/blob/3294d683af459f42f2e3d0d8e5e89dffd55e9544/scripts/run_tests.sh)

Root/testing sections are the main evidence: tests must not write to live Hermes
state, must not fake host OS support, and should exercise actual integration paths.
The runner explicitly allowlists location/tool variables instead of inheriting
credentials. ShipLoop uses the same idea with Node tooling and much smaller scope.

### T3 Code — 38969148a23e7a422045be023627c7fbbddf7503

- [AGENTS.md](https://github.com/pingdotgg/t3code/blob/38969148a23e7a422045be023627c7fbbddf7503/AGENTS.md)
- [CLAUDE.md](https://github.com/pingdotgg/t3code/blob/38969148a23e7a422045be023627c7fbbddf7503/CLAUDE.md)
- [CONTRIBUTING.md](https://github.com/pingdotgg/t3code/blob/38969148a23e7a422045be023627c7fbbddf7503/CONTRIBUTING.md)
- [README.md](https://github.com/pingdotgg/t3code/blob/38969148a23e7a422045be023627c7fbbddf7503/README.md)
- [package.json](https://github.com/pingdotgg/t3code/blob/38969148a23e7a422045be023627c7fbbddf7503/package.json)
- [development runbook](https://github.com/pingdotgg/t3code/blob/38969148a23e7a422045be023627c7fbbddf7503/docs/operations/development.md)

The guide explicitly describes risks when developing through the same live T3
instance: indiscriminate process kills, writes to live userdata, and bundled
localhost origins. These are directly applicable to your remote VM workflow.
Its tiny CLAUDE pointer avoids maintaining duplicate instructions.

### Codex — 5aa92804d255dcaefe169dd7febb4006a2474e32

- [AGENTS.md](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/AGENTS.md)
- [README.md](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/README.md)
- [package.json](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/package.json)
- [justfile](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/justfile)

The root guide specifies integration tests for agent logic and public JSON-RPC
proof for app-server behavior, plus schema regeneration and external surface
compatibility checks. This informs our adapter test contract; it does not validate
a particular Codex execution API on your VM. That compatibility spike remains open.

### OpenClaw — 452758a4274a2a680179e232e097883308a57f65

- [AGENTS.md](https://github.com/openclaw/openclaw/blob/452758a4274a2a680179e232e097883308a57f65/AGENTS.md)
- [CONTRIBUTING.md](https://github.com/openclaw/openclaw/blob/452758a4274a2a680179e232e097883308a57f65/CONTRIBUTING.md)
- [README.md](https://github.com/openclaw/openclaw/blob/452758a4274a2a680179e232e097883308a57f65/README.md)
- [package.json](https://github.com/openclaw/openclaw/blob/452758a4274a2a680179e232e097883308a57f65/package.json)
- [test authoring](https://github.com/openclaw/openclaw/blob/452758a4274a2a680179e232e097883308a57f65/docs/help/testing/writing-tests.md)
- [LICENSE](https://github.com/openclaw/openclaw/blob/452758a4274a2a680179e232e097883308a57f65/LICENSE)

One owner, current authority after awaited work, isolated state and concrete
recovery are useful patterns. Its maintainer permission/landing exceptions are
specific to that project and conflict with ShipLoop's owner-controlled delivery.

## What this change provides

AGENTS.md is a compact router; ARCHITECTURE.md and an ADR establish responsibilities;
TESTING.md and runbooks own commands, self-verification, debugging and merge/release.
The existing detailed MVP spec is retained with stable acceptance IDs.

The executable addition is development tooling: doctor, foundation sanity checks,
bounded command runner, machine-readable reports, subprocess regression tests,
and Linux CI. It is not the product's durable job scheduler, isolation sandbox,
browser harness, production release controller or T3 automation integration.

Next proof to build: a real VM/browser/engine setup spike, then one vertical slice.
Add actual application gates with the first runnable slice. Maintain narrower
AGENTS.md files beside real packages as local conventions become concrete.
