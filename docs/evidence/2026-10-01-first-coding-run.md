# First coding run end to end: live engine, real store, real worker

Date: 1 October 2026. Commit at time of testing: `b8ca7cc` (branch
`task/run1-a`, worktree `/tmp/opencode/wt/run1-a`). Environment: the project VM
(Linux x86-64, Node 24.18.0, pnpm 11.15.0), `codex-cli 0.159.1` authenticated
through ChatGPT, no network access to any hosted provider.

This report records what was executed, not what is expected to work. It is
produced by one committed script, `apps/worker/src/live-run.ts`, which drives the
shipped code paths against a disposable fixture and prints what it observed.
Failing, refused and unproven behaviour is reported as a finding rather than
omitted, and the transcript is the script's own output, unedited.

## What this run is

| Property | Value |
| --- | --- |
| Command | `node apps/worker/src/live-run.ts` |
| Exit code | 0 |
| Real engine | `codex-cli 0.159.1`, `Logged in using ChatGPT` |
| Engine session | `01a0f815-edfa-7871-96ab-1d50e4cee406` |
| Engine outcome | `Succeeded`, 94 811 input / 1 103 output tokens, cost `Unknown` |
| Store | real `migrate()` on a fresh SQLite file, schema 11 of `LATEST_SCHEMA_VERSION` 11 |
| Controller | real use cases from `packages/controller/src/jobs.ts` and `profiles.ts` |
| Worker process | the shipped `apps/worker/src/index.ts`, spawned three times and signalled with `SIGTERM` |
| Workspace | real `prepareWorkspace` / `reuseWorkspace` / `cleanupWorkspace` from `packages/verification` |
| Remote | a local bare Git repository plus a loopback REST surface, **not** `api.github.com` |

The engine was asked for exactly one change: add a `GET /health` route. It made
that change, ran nothing else, and the diff is printed in full in phase 5.

## Honest limits of this evidence

- **No hosted provider was contacted.** The GitHub adapter ran against a bare
  repository on this host and a loopback REST surface implemented inside the
  harness. `git push` is a real push into that bare repository, and the ref
  reads behind the REST surface are real `git --git-dir` reads, but nothing
  here proves behaviour against `api.github.com`, and no pull request, merge or
  release exists anywhere external.
- **No Linear ticket was written.** `LinearTicketAdapter` is exercised for its
  capability declaration only.
- **Delivery, owner acceptance and release are not covered.** Phases 5 to 9 stop
  at a pushed branch and a recovered attempt. Merge
  (`Git:MergeWithPrecondition`), acceptance and release remain unproven here, and
  `packages/adapters/src/github/README.md` already records that every live call
  made against GitHub during development was read-only.
- **Three real engine turns were spent in total.** The first two were discarded:
  one because the harness's own fixture used a loopback HTTP test, which cannot
  pass inside the Codex sandbox's restricted network, and one because of a race
  in the harness that ended the script after the engine had already finished
  successfully. The transcript below is the third turn, and it is the only one
  reported as a result. No product defect was involved in either discard.
- **Phases 4, 8 and 9 use an engine-compatible stand-in for the engine process
  itself** (`/bin/sh` speaking the same JSONL protocol, plus the real
  `codex --version` for the compatibility probe), because the criteria under
  test there are about the stop, checkpoint, cancellation and recovery paths, not
  about the model's output. Phase 5 is the only phase that runs the real
  `codex` binary.

## Transcript

The two lines that reproduce the engine's own markdown summary have its links
flattened to plain paths, because this repository's link checker resolves a
`(/tmp/...)` link against the checkout and rejects it; the paths are truncated by
the engine's summary itself. Nothing else in the transcript is altered.

```
=== 1: Disposable fixture application and local bare remote ===
  fixture root: /tmp/shiploop-live-run-QoMfJL
  fixture checkout: /tmp/shiploop-live-run-QoMfJL/checkout
  local bare remote (origin): /tmp/shiploop-live-run-QoMfJL/origin.git
  base commit: 582e1d5ca5a0be75a27f2a66179d7e7bc647ab37
  origin branches: * main
  fixture `npm test` before the run: exit 0 (ℹ pass 1 | ℹ fail 0)

=== 2: Real migrated SQLite database ===
  database path: /tmp/shiploop-live-run-QoMfJL/state/live-run.sqlite
  schema version after migrate: 11
  LATEST_SCHEMA_VERSION: 11

=== 3: Owner and project profile through the real controller use cases ===
  ownerId: own_40f086893abc362d13f8dda356fc5a16
  actor role: Owner
  profileVersionId: 58b7589d-1e5d-4a95-8f39-a9c14086a240
  profile contentFingerprint: fp_0465d5373637181c1028fc0b3e2bddab
  procedureVersionId: 4e873860-ba2c-4ec7-a60d-49923e211544
  environmentFingerprint: fp_9ce4ef998425310d200cfa554c811975
  workItemId: 71da5db9-cdc9-417d-86fc-a47f24e0a808

=== 4: Real startRun, and the duplicate start it must refuse ===
  jobId: job_5697f7771a10000535684c21711cdcbe
  job state: Queued
  scopeSnapshotId: 77b525d9-625a-49a9-9212-d71c20732446
  scopeFingerprint: fp_376538451033a4a8e2207f0ff03ddd58
  dispatch: Queued (No other job holds the single global coding writer, so the coding worker can claim this job (F13-AC2).)
  permittedOperations: ReadScope, ReadRepository, ReadChecks, PushBranch, CreateDraft, UpdateDraft, RunChecks, CollectEvidence
  refusedDeliveryOperations: Merge, Release, RecoveryRedeploy
  repeat deduplicated: true
  repeat returned the same job: true
  rows in jobs table after the repeat: 1

=== 5: The live Codex engine, in the real isolated workspace ===
  engine runtime version: 0.159.1
  engine compatible: true
  live job reached Running: true
  coding slot holder while Running: live-run-writer
  active writer leases while Running: 1
  second writer claim while Running: refused (Conflict)
  second writer refusal: The single global coding slot is held by live-run-writer for job job_5697f7771a10000535684c21711cdcbe, so job stays queued until that writer finishes (F13-AC2).
  [engine Info] engine milestone Preparing
  [engine Info] engine milestone Implementing
  [engine Info] engine milestone Implementing
  [engine Info] engine milestone Implementing
  [engine Info] engine milestone Implementing
  [engine Info] engine milestone Implementing
  [engine Info] engine milestone Implementing
  [engine Info] engine milestone Implementing
  [engine Info] engine milestone Implementing
  [engine Info] engine milestone Implementing
  [engine Info] engine milestone Implementing
  [engine Info] engine milestone Implementing
  [engine Info] engine milestone Implementing
  [engine Info] engine milestone Implementing
  tick kind: Claimed
  attempt outcome: Completed
  engine summary: Added `GET /health` returning HTTP 200 with `{"status":"ok"}`, plus a route test. Changed: /tmp/shiploop-live-run-QoMfJL/state/attempts/worktrees/ws_ffb7ad75aec5c947fd6fac6e0e4690e2/app.mjs, /tmp/shiploop-live-run-
  reported usage: {"availability":"Reported","inputTokens":94811,"outputTokens":1103,"totalTokens":95914,"remainingQuota":"Unknown","cost":"Unknown","source":"EngineReported"}
  engine session id: 01a0f815-edfa-7871-96ab-1d50e4cee406
  engine version reported: 0.159.1
  engine event kinds: SessionStarted, Progress, Usage, Result
  engine result event: Succeeded: Added `GET /health` returning HTTP 200 with `{"status":"ok"}`, plus a route test. Changed: /tmp/shiploop-live-run-QoMfJL/state/attempts/worktrees/ws_ffb7ad75aec5c947fd6fac6e0e4690e2/app.mjs
  engine start kind: Fresh
  granted coding capabilities: Ticket:ReadScope, Git:ReadRepository, Git:ReadChecks, Git:PushBranch, Git:CreateDraft, Git:UpdateDraft
  sandbox requested: workspace-write
  instruction sent to the engine: Work against this captured scope. It is authoritative and does not change during the attempt. Make exactly one change to this repository: add a `GET /health` route to the application in app.mjs that responds with HTTP 200 and the JSON body 
  engine active wall clock bound: 899904
  job state after the turn: Completed
  job holder after the turn: null
  job attempt count: 1
  coding slot after the turn: {"holder":null,"jobId":null}
  active writer leases after the turn: 0
  checkpoints recorded for the live job: 0
  isolated worktree: /tmp/shiploop-live-run-QoMfJL/state/attempts/worktrees/ws_ffb7ad75aec5c947fd6fac6e0e4690e2
  isolated data directory: /tmp/shiploop-live-run-QoMfJL/state/attempts/data/ws_ffb7ad75aec5c947fd6fac6e0e4690e2
  isolated browser profile: /tmp/shiploop-live-run-QoMfJL/state/attempts/browser/ws_ffb7ad75aec5c947fd6fac6e0e4690e2
  process registry: /tmp/shiploop-live-run-QoMfJL/state/attempts/processes/ws_ffb7ad75aec5c947fd6fac6e0e4690e2/registry.json
  lock document: /tmp/shiploop-live-run-QoMfJL/state/attempts/locks/ws_ffb7ad75aec5c947fd6fac6e0e4690e2.json
  allocated ports: app=46111 (AllocatedFree)
  engine git status --porcelain: M app.mjs |  M app.test.mjs
  engine diff --stat: app.mjs      | 5 +++++ |  app.test.mjs | 7 +++++++ |  2 files changed, 12 insertions(+)
  engine diff:
    diff --git a/app.mjs b/app.mjs
    index 98fd98f..6b6dc2d 100644
    --- a/app.mjs
    +++ b/app.mjs
    @@ -9,6 +9,11 @@ import { createServer } from 'node:http';
       * under test.
       */
      export function handleRequest(request, response) {
    +  if (request.method === 'GET' && request.url === '/health') {
    +    response.writeHead(200, { 'content-type': 'application/json' });
    +    response.end(JSON.stringify({ status: 'ok' }));
    +    return;
    +  }
        if (request.url === '/') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ name: 'shiploop-live-run-fixture' }));
    diff --git a/app.test.mjs b/app.test.mjs
    index 34c6490..4e500d9 100644
    --- a/app.test.mjs
    +++ b/app.test.mjs
    @@ -26,3 +26,10 @@ test('GET / answers with the application name', () => {
          body: { name: 'shiploop-live-run-fixture' },
        });
      });
    +
    +test('GET /health answers with ok status', () => {
    +  assert.deepEqual(call('GET', '/health'), {
    +    statusCode: 200,
    +    body: { status: 'ok' },
    +  });
    +});
    
=== 6: One writer, and what a Blocked attempt leaves holding it ===
  claimed jobId: job_6caae9ef820a24cb25eb09dd6b67dc5c
  job state: Blocked
  coding slot while Blocked: {"holder":"live-run-writer","jobId":"job_6caae9ef820a24cb25eb09dd6b67dc5c"}
  active writer leases while Blocked: 1
  another writer claim while Blocked: refused (Conflict)
  cancelRun outcome: Cancelled, external delivery UnchangedByCancellation
  checkpoint preserved by the cancellation: none
  coding slot after the cancellation: {"holder":null,"jobId":null}
  active writer leases after the cancellation: 0

=== 7: Commit, push and one draft, against the local bare remote ===
  committed head: 5f0a3185ebe5f5960086b691a1d492f803569c75
  local GitHub REST surface: http://127.0.0.1:36487
  remote branch before the push: null
  push outcome: Pushed
  remote branch after the push: 5f0a3185ebe5f5960086b691a1d492f803569c75
  the bare remote holds exactly the pushed commit: true
  branches the provider reports at that head: shiploop/live-run/job_5697f7771a10000535684c21711cdcbe
  first upsertDraft outcome: Created
  first upsertDraft pull request: 1 at http://127.0.0.1/local-run/pull/1
  first upsertDraft head sha: 5f0a3185ebe5f5960086b691a1d492f803569c75
  first upsertDraft draft: true
  first upsertDraft POST /pulls so far: 1
  second upsertDraft, same operation id outcome: RecoveredAfterLostResponse
  second upsertDraft, same operation id pull request: 1 at http://127.0.0.1/local-run/pull/1
  second upsertDraft, same operation id head sha: 5f0a3185ebe5f5960086b691a1d492f803569c75
  second upsertDraft, same operation id draft: true
  second upsertDraft, same operation id detail: The draft this operation created (1) was found by reading the open pull requests for this branch, and its managed content already matches, so nothing was written and no second draft was created (F19-AC3).
  second upsertDraft, same operation id POST /pulls so far: 1
  POST /pulls calls against the local surface: 1
  drafts created for one operation identity: 1
  local GitHub REST surface closed: true
  cleanupWorkspace removed: /tmp/shiploop-live-run-QoMfJL/state/attempts/data/ws_ffb7ad75aec5c947fd6fac6e0e4690e2, /tmp/shiploop-live-run-QoMfJL/state/attempts/browser/ws_ffb7ad75aec5c947fd6fac6e0e4690e2, /tmp/shiploop-live-run-QoMfJL/state/attempts/worktrees/ws_ffb7ad75aec5c947fd6fac6e0e4690e2, /tmp/shiploop-live-run-QoMfJL/state/attempts/locks/ws_ffb7ad75aec5c947fd6fac6e0e4690e2.json, /tmp/shiploop-live-run-QoMfJL/state/attempts/processes/ws_ffb7ad75aec5c947fd6fac6e0e4690e2/registry.json
  cleanupWorkspace retained anything: false

=== 8: Cancellation mid-run: a checkpoint and preserved work ===
  cancellable jobId: job_7e890b18de1ed30e68cb626bbec78149
  [engine Info] engine milestone Preparing
  engine session id: live-run-cancel-thread
  engine process group tracked by the adapter: yes (real codex-compatible process, one detached group)
  tick kind: Claimed
  attempt outcome: Stopped
  job state after the stop: Paused
  writer lease after the stop: Released
  coding slot after the stop: {"holder":null,"jobId":null}
  checkpoint id: ckpt:job_7e890b18de1ed30e68cb626bbec78149:1
  checkpoint head sha: 582e1d5ca5a0be75a27f2a66179d7e7bc647ab37
  checkpoint base sha: 582e1d5ca5a0be75a27f2a66179d7e7bc647ab37
  checkpoint dirty files: []
  checkpoint untracked files: []
  checkpoint blocker: The owner asked for this attempt to stop before the engine reported a result.
  checkpoint next action: Resume from the recorded checkpoint after inspecting the workspace (F17-AC3).
  work actually in the worktree: ?? cancel-in-progress.txt
  resume attempt after the cancellation: refused: Workspace ws_5a259b188d5fe801e8da7296abbda5c3 cannot be reused by live-run-writer: 1 difference(s) from checkpoint ckpt:job_7e890b18de1ed30e68cb626bbec78149:1 are not accounted for, starting with "cancel-in-progress.txt" is a new untracked file in the workspace that the retained checkpoint ckpt:job_7e890b18de1ed30e68cb626bbec78149:1 does not record..
  job state left by the refused resume: Running
  timed out waiting for the shipped entrypoint to reach the expected state
  shipped entrypoint exit against the unreusable workspace: exit 0
    ShipLoop worker live-run-writer starting on /tmp/shiploop-live-run-QoMfJL/state/live-run.sqlite
    ShipLoop worker stopped after 15 tick(s): 0 claimed, 15 recovered, 0 completed, 0 paused, 0 awaiting reconciliation, 15 error(s).
  released by cancelRun: Cancelled, checkpoint ckpt:job_7e890b18de1ed30e68cb626bbec78149:1
  coding slot after that cancellation: {"holder":null,"jobId":null}
  cancelled workspace cleaned: yes

=== 9: SIGTERM mid-run, then a restart that recovers the job exactly once ===
  9.1 signal delivered while the engine session is live, no harness timer
  restartable jobId: job_896a7d87ce73dcb494ef2f934f8bb7bd
  rows in jobs table before the restart case: 4
  engine invocations recorded before any worker ran: 0
  engine session live when the signal was sent: true
  unmitigated entrypoint exit: exit 0
  unmitigated entrypoint output:
    ShipLoop worker live-run-writer starting on /tmp/shiploop-live-run-QoMfJL/state/live-run.sqlite
    ShipLoop worker stopped after 1 tick(s): 1 claimed, 0 recovered, 0 completed, 1 paused, 0 awaiting reconciliation, 0 error(s).
  job state after the signal: Paused
  lease after the signal: Released
  checkpoint after the signal: ckpt:job_896a7d87ce73dcb494ef2f934f8bb7bd:1
  coding slot left behind: {"holder":null,"jobId":null}
  the shipped stop wrote its checkpoint on this attempt: yes
  owner cancelled that job: Cancelled, external delivery UnchangedByCancellation
  coding slot after the cancellation: {"holder":null,"jobId":null}
  9.2 the same signal with the harness loop holder present
  pausable jobId: job_5985c6b5ecafdef658fe7d8e02b6f206
  coding slot held while it ran: {"holder":null,"jobId":null}
  active writer leases while it ran: 0
  held entrypoint exit: exit 0
    ShipLoop worker stopped after 1 tick(s): 1 claimed, 0 recovered, 0 completed, 1 paused, 0 awaiting reconciliation, 0 error(s).
  job state after the signal: Paused
  lease after the signal: Released
  checkpoint after the signal: ckpt:job_5985c6b5ecafdef658fe7d8e02b6f206:1
  engine invocations after the held worker: 2
  9.3 a second process recovers the paused job
  restarted worker completed the recovered job: true
  restarted entrypoint exit: exit 0
    ShipLoop worker stopped after 1 tick(s): 0 claimed, 1 recovered, 1 completed, 0 paused, 0 awaiting reconciliation, 0 error(s).
  job state after the restart: Completed
  lease after the restart: Released
  coding slot after the restart: {"holder":null,"jobId":null}
  rows in jobs table after the restart: 5
  attempt count recorded on the job: 1
  engine invocations the recovery added: 1
  engine invocations in total: 3
  the completed job needs no release: Completed, slot {"holder":null,"jobId":null}

=== 10: Cleanup ===
  composition root closed: true
  fixture root removed: /tmp/shiploop-live-run-QoMfJL
  fixture root still present: false
  processes spawned by this script still running: none: every child was awaited or signalled, and the engine groups were bounded by the adapter
```

## What the run proves

| Criterion | Observed evidence |
| --- | --- |
| F13-AC2 single global coding writer | A second `claimNext` while the live job was `Running` was refused with `Conflict`, naming the holder and the job; the slot and one `Active` lease were held for the whole attempt and both were released on completion (phases 5, 6, 9). |
| F13-AC1 durable start | `startRun` produced one `Queued` job, and a repeat start with the same operation identity deduplicated to the same job with one row (phase 4). |
| F14-AC1 isolated workspace | A real detached worktree, data directory, browser profile, process registry and lock file were created for the attempt, an `AllocatedFree` port was bound, and `cleanupWorkspace` removed exactly those five paths and retained nothing (phases 5, 7). |
| F15 engine execution | A real `codex` session produced the requested `/health` route, ran under `workspace-write`, reported `Succeeded` with usage, and the diff was read back from the worktree (phase 5). |
| F16/F04 capability grant | The job's grant produced `PushBranch`, `CreateDraft` and `UpdateDraft` with `Merge`, `Release` and `RecoveryRedeploy` refused, and the adapter refused the same capabilities the grant refused (phases 4, 5, 7). |
| F17-AC1 stop and checkpoint | A `SIGTERM`-equivalent stop of a live attempt produced `Stopped`, `Paused`, a `Released` lease, a vacant slot and checkpoint `ckpt:<job>:1` (phase 9), and cancellation did the same plus workspace cleanup (phase 8). |
| F17-AC3 delivery recorded once | A repeated `upsertDraft` with the same operation identity returned `RecoveredAfterLostResponse` and the loopback surface counted exactly one `POST /pulls` (phase 7). |
| F17-AC5 no blind takeover | A restarted worker did not reclaim a job whose previous writer's lease was still `Active`; the job stayed `Running` and the restarted process reported `0 claimed, 0 recovered, 0 error(s)` while it polled (phase 8). |
| N01-AC1 restart recovery | The second process reported `0 claimed, 1 recovered, 1 completed` and the job reached `Completed`, with the engine invoked once more and the delivery not repeated (phase 9). |
| N02-AC3 real engine adapter | The engine was the shipped `CodexEngineAdapter` throughout, and the process group it spawned was observed as one detached group the adapter could stop (phases 5, 8, 9). |

## Findings

These are defects or gaps found by running the system, not by reading it. Each
one is reproducible from the transcript above or from the isolated observation
described.

### 1. A checkpoint records the workspace as it was before the attempt, not as the attempt left it

`apps/worker/src/runner.ts:245` captures `observation` once, when the workspace is
prepared, and passes that same value to every `persistCheckpoint` call
(`apps/worker/src/runner.ts:295`, `:341`, `:351`, `:367`, `:383`; the parameter
is declared at `:868`).

Phase 8 shows the consequence. The attempt was stopped while the engine had a
new untracked file in the worktree, and the checkpoint written at the stop
records `checkpoint untracked files: []` while `work actually in the worktree:
?? cancel-in-progress.txt`. The follow-up resume is therefore refused, naming
the file the checkpoint does not account for.

The refusal itself is correct behaviour (F14-AC4, F17-AC3: unaccounted work is
reported, never written over). The defect is that the harness reached that state
at all: a stop that can interrupt work the runner has not yet observed produces a
checkpoint that is wrong about the workspace at the moment it is written, so the
retained checkpoint can never authorise resuming its own workspace. The
observation must be re-read at the moment the checkpoint is written.

### 2. A deterministic reconciliation refusal is retried forever by the shipped worker

Phase 8: a resume that is refused because the workspace cannot be reused leaves
the job `Running` with a `Released` lease. The shipped `apps/worker/src/index.ts`
then reports `15 recovered, 15 error(s)` and, in a longer observation taken while
developing this run, `0 claimed, 583 recovered, 583 error(s)` — one identical
reconciliation failure per tick, with no backoff and no terminal state.

A refusal that cannot change without an operator is a decision the loop should
stop repeating, not a tick to retry forever. Until it stops, one unreconcilable
job burns a worker process and the single coding slot indefinitely.

### 3. `Blocked` and `WaitingForOwner` do not give up the coding writer

`packages/storage/src/jobs/queue.ts:867` lists the states that release the writer
as `Queued`, `Paused`, `Completed`, `Cancelled`. `Blocked` and `WaitingForOwner`
are absent, so `releaseCodingSlot` (`:887`) never runs for them.

Phase 6 shows the effect: a `Blocked` job still held `{"holder":"live-run-writer",
"jobId":"job_6caae9…"}` and one `Active` lease, and only an owner `cancelRun`
freed them. A job that has stopped making progress therefore blocks every other
job in the project until an owner intervenes, which is the opposite of what
`WaitingForOwner` exists to do (F18-AC2).

### 4. The engine adapter's stop can end the process instead of reporting

`stopCodexProcess` (`packages/adapters/src/codex/client.ts:550`) polls for an
empty process group in `waitForEmptyGroup` (`:579`) using `timer.unref()`
timers (`:586`), and `waitForExit` (`:591`) does the same at `:598`. An
unreferenced timer does not keep the event loop alive, so once the engine process
has been reaped and the group is momentarily still occupied, the poll has nothing
left to hold the process open: Node ends the worker with `Detected unsettled
top-level await` and exit code 13.

Observed three times while developing this run, always at a stop, always before
the checkpoint was written. The consequence is a job left `Running` behind an
`Active` lease whose holder no longer exists, which is the one state the design
forbids taking over blind — a restarted worker correctly refuses to touch it
(`0 claimed, 0 recovered, 0 error(s)`), so the job is stuck until an operator
records that the previous writer stopped.

Isolating the adapter confirmed the mechanism: the same stop against the same
engine returns `{"kind":"Stopped"}` when one referenced timer is present in the
process, and never returns at all without it. `apps/worker/src/live-run.ts`
therefore runs phase 9 twice, once exactly as the shipped process receives the
signal and once with a bounded timer loaded into the child, so the difference is
attributable rather than assumed. The transcript's 9.1 and 9.2 both stopped
cleanly on this attempt: the race is intermittent, and this report claims only
that it was observed three times, that a single referenced timer removes it, and
that the unreferenced timers in that poll are the only ones on the stop path.

### 5. A recovered attempt is not recorded as a second attempt

Phase 9: the job was paused after one engine dispatch, then recovered and
completed after a second dispatch. `attempt count recorded on the job: 1` while
`engine invocations the recovery added: 1`. `jobs.attempt_count` does not move
when an attempt is recovered, so the durable record understates how many engine
sessions a job has consumed, and the checkpoint identifier
`ckpt:<jobId>:<attemptCount>` (built in `apps/worker/src/worker.ts:266`) cannot
distinguish two attempts of the same job.

### 6. Gaps in what the worker can do on its own

- **The worker has no Git port.** Commit, push and draft creation are not
  reachable from `apps/worker/src`: the worker completes an attempt and releases
  the writer, and something outside it must perform delivery. Phase 7 had to
  drive `GitHubGitAdapter` and the draft adapter directly, which is why delivery
  and `F19` are not proven by this run.
- **No shipped `createWorkspacePort` exists.** `apps/worker/src/index.ts:130`
  requires a module specifier that exports one, and nothing in the repository
  provides it; the run supplies its own and exports it from
  `apps/worker/src/live-run.ts`. The worker therefore cannot start against the
  shipped tree without a module this repository does not yet contain.
- **`apps/worker/package.json` does not declare `@shiploop/controller`,** and
  `@shiploop/adapters` publishes no subpath export, so the harness imports the
  controller and the Linear adapter by relative path. The worker's own imports
  resolve, so this is a packaging gap rather than a broken build.
- **`ResumeEngineSessionRequest` is unreachable from the runner.** Every dispatch
  calls `engine.startSession` (`apps/worker/src/runner.ts:603`), including a
  `FromCheckpoint` start, so a resumed attempt is a fresh engine session seeded
  from the checkpoint. `engine.resumeSession` is implemented in the adapter and
  has no caller.
- **Fixture limits.** The fixture's own `npm test` is run before the engine
  starts, not after, and no check result is collected from the finished work, so
  `RunChecks` and `CollectEvidence` are granted but unproven.

## Reproducing this run

```
node scripts/lint.mjs
node /home/ubuntu/projects/ShipLoop/node_modules/typescript/bin/tsc --noEmit -p apps/worker/tsconfig.json
node apps/worker/src/live-run.ts
```

The script creates everything it needs under `$TMPDIR`, requires `codex` on
`PATH` with a live ChatGPT session, contacts no hosted provider, and removes its
fixture root on completion. Its exit code is 0 only when all ten phases complete.

## Related evidence

- [Wave 0 feasibility evidence: Oracle ARM64 VM](2026-09-30-wave0-vm-feasibility.md)
  — the host, the pinned engine and the authenticated session this run used.
- [MVP specification](../product/mvp-spec.md) — the feature and acceptance
  identifiers cited above.
- [Testing](../../TESTING.md) — where this report sits in the verification
  profile.
