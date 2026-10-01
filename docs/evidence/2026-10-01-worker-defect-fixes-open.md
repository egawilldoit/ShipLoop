# Open unit: five defects from the first real coding run

Date: 1 October 2026. Base commit: `59b9f23`. Status: **source fixes written and
typecheck-clean, but one existing worker assertion fails, so the unit is NOT merged.**

The five defects are recorded in
[2026-10-01-first-coding-run.md](2026-10-01-first-coding-run.md). This file records
what was attempted and exactly where it stopped, so the next attempt starts from
evidence rather than from scratch.

## Preserved work

`2026-10-01-worker-defect-fixes-wip.patch` holds the complete attempted diff
(six files, +274/-32):

- `apps/worker/src/runner.ts` — checkpoint is now written from a post-attempt
  workspace re-read instead of the pre-attempt reading. A new `WorkspaceObserver`
  port was added and `workspaceObserverOf` REFUSES a provider that cannot
  re-observe, because a checkpoint describing a worktree the attempt had not yet
  written to can never authorise resuming its own workspace (F14-AC4, F17-AC2).
- `apps/worker/src/worker.ts` — wires the observer through; a non-retryable
  reconciliation refusal now reaches a terminal state instead of being retried
  forever (the live run recorded `583 recovered, 583 error(s)` with no terminal
  state).
- `packages/adapters/src/codex/client.ts` — the stop poll holds the event loop
  while it decides, so Node cannot end the worker with `unsettled top-level
  await` (exit 13) before the checkpoint is written.
- `packages/storage/src/jobs/queue.ts`, `lease.ts` — `Blocked` and
  `WaitingForOwner` release the global coding slot, while a reclaim is still
  refused while a writer may still be alive (F17-AC5).

All three packages typecheck clean and the policy lint passes.

## Where it stopped

`apps/worker/src/worker.test.ts` N01-AC1 ("a SIGTERM mid-run leaves durable state
consistent, and a restart recovers it without a second writer") fails because the
test's workspace port answers with the pre-attempt reading. The fix is correct and
the failure is the comparison working — but the port also has to present the same
workspace IDENTITY the interrupted run used (`ws-signal` at its own worktree
path), and the test double was not updated to do that consistently. All other 16
worker tests pass.

The unit was NOT merged because a branch with a failing assertion is not a
finished unit. `dev` is unchanged at `59b9f23` and green.

## Next attempt

Apply the patch, then:
1. give `ScriptedWorkspacePort` an `observe()` and set its identity to the
   interrupted run's workspace;
2. add the five named regression tests, one per defect — the live run's evidence
   gives the exact expected values (the checkpoint must list
   `in-progress.txt`; a `DeterministicScope` refusal must not be claimed twice;
   two attempts must not share a checkpoint key; stopping a SIGTERM-ignoring child
   must write the checkpoint; an expired lease must not open the slot while the
   holder still answers, and must open it once the holder is confirmed stopped).
