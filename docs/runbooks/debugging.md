# Debugging without getting stuck

An agent cannot guarantee every VM dependency will work. It can guarantee bounded
attempts, visible failure, preserved work and a concrete recovery action.

1. Capture the first failing command, run ID, exit/signal, deadline, host architecture
   and relevant sanitized output. Inspect the exact entry point and prerequisites.
2. Classify the failure: product bug, fixture/isolation, runtime/tool/version,
   dependency/network, browser binary/library, port/process, credentials/quota,
   or ambiguous provider write.
3. Repair the owning cause inside authorized scope; run the smallest check that
   proves the repair. Do not rerun unchanged inputs hoping for green.
4. After two identical failures without new evidence or 10 minutes without progress,
   change method or report Blocked. Preserve work and failed evidence.
5. Default future coding attempt budget: 60 active minutes and two automatic
   fix passes. Human wait is excluded. Recipe/command limits must be explicit.

| Symptom | Useful next action |
| --- | --- |
| pnpm exits before printing a version | Validate/repair package.json; use node scripts/doctor.mjs |
| Wrong pnpm version | Use the project pin through the existing runtime manager |
| Missing browser/library | Inspect browser launch error and CPU/OS; satisfy actual supported prerequisites |
| Port already used | Inspect port owner; select a new port; stop only a proven task-owned process |
| Command timeout or retained pipes | Let runner clean its owned group; inspect child lifecycle before restart |
| OOM or ENOSPC | Reduce owned job concurrency/artifacts; preserve work; do not clear shared caches blindly |
| Auth expired / quota exhausted | Stop affected retries; show required account/action, without exposing credentials |
| SQLite lock | Find the actual writer; settle transactions/owned process; do not delete WAL files |
| Merge/deploy response lost | Fetch current provider state and operation identity before a write retry |

Blocked output must say: what was attempted, observed failure, work preserved,
what still works, and the smallest next action. Do not label tooling failures product
defects or let an unavailable optional tool block unrelated authorized work.
