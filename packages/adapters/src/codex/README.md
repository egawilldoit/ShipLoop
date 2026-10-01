# Codex coding-engine adapter

The first engine adapter in ShipLoop that runs a real external process. It implements the full
`EngineAdapter` contract from `../contracts/engine.ts`: `startSession`, `resumeSession`,
`stopSession`, plus the `AdapterIdentity` surface (`capabilities`, `checkCompatibility`), and it
implements every member of `EngineEvent`, `EngineOutcome`, `EngineContinuation`,
`EngineStopOutcome` and `EngineUsage`.

This file exists because **"it typechecks" and "it drives Codex" are different claims**, and only
one of them is evidence. Everything below is separated into what was observed from the real binary
on this host and what is proven only against captured output or a scripted process. Where a
guarantee is weaker than the contract's wording, the weaker truth is stated here rather than left
for a reader to discover.

- Probed live on **1 October 2026**, `linux/arm64` (2 x Neoverse-N1, ~12 GiB RAM, no swap),
  Node v24.18.0, against `codex-cli 0.159.1` authenticated with `Logged in using ChatGPT`.
- Every live run was confined to a throwaway Git workspace under `/tmp` and asked for **one** small
  file. Nothing outside that workspace was written, and no account, plan or credential was changed.

## Layout

| File | What it owns |
| --- | --- |
| `client.ts` | Process transport: version probe, argv construction, the sandbox allowlist, detached process groups, bounded shutdown |
| `events.ts` | Codex JSONL to the closed `EngineEvent` union, and the deferred terminal decision |
| `errors.ts` | Engine failure to `DomainError`, `EngineDiagnosticCategory` and blocked outcomes |
| `adapter.ts` | `EngineAdapter`: capability declarations, compatibility, session lifecycle, continuation, stop |

## Commands

```bash
# typecheck (from the repository root)
node /home/ubuntu/projects/ShipLoop/node_modules/typescript/bin/tsc --noEmit -p packages/adapters/tsconfig.json

# project policy lint
node scripts/lint.mjs

# this adapter only
node --test 'packages/adapters/src/codex/*.test.ts'

# every package's tests
node scripts/run-tests.mjs

# the opt-in live pass (spends account quota)
SHIPLOOP_CODEX_LIVE=1 node --test 'packages/adapters/src/codex/codex.test.ts'

# the opt-in live continuation pass, against a thread recorded by an earlier run
SHIPLOOP_CODEX_LIVE=1 SHIPLOOP_CODEX_LIVE_THREAD=<thread-uuid> \
  node --test 'packages/adapters/src/codex/codex.test.ts'
```

Both live tests are skipped by default and say why, naming the missing prerequisite:

```
﹣ F15-AC1, F15-AC4 a live Codex turn reports its real thread id, writes one file, and terminates
  # no SHIPLOOP_CODEX_LIVE=1; the live pass needs an authenticated codex on PATH and spends account quota
﹣ F15-AC4 a live resume continues the recorded conversation in place
  # no SHIPLOOP_CODEX_LIVE=1 with SHIPLOOP_CODEX_LIVE_THREAD; name a recorded Codex thread id to continue
```

## Proven against the LIVE `codex` binary

Each row was observed on 1 October 2026 on `codex-cli 0.159.1`. Nothing here is inferred from
documentation or from a fixture.

| Fact | How it was observed | Consequence in the code |
| --- | --- | --- |
| `codex --version` prints `codex-cli 0.159.1` on stdout, exit 0 | direct invocation | `parseCodexVersion` requires exactly that shape and returns null otherwise. A banner it cannot read is a version whose schema it will not claim to understand |
| `codex login status` prints `Logged in using ChatGPT` | direct invocation | the account path is observed, not assumed. The adapter passes no credential of its own (F15-AC5) |
| `codex exec --json` emits JSONL on **stdout**; the banner and transport warnings go to **stderr** | a full bounded run | stdout is the only structured-event source; stderr is a bounded tail used only when a start produced no `thread.started` |
| The session identity is `{"type":"thread.started","thread_id":"01a0f699-7149-7d20-831e-98f7b7b43a71"}` | a full bounded run | that `thread_id` is the `EngineSessionHandle.sessionId`. It is the engine's own id, never a locally generated placeholder, because `codex exec resume` addresses exactly this value |
| `turn.completed` carries `usage` with `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` | a full bounded run | `readCodexUsage` requires the two fields the contract has room for and ignores the rest. The cached and reasoning splits are **not** folded into `outputTokens`; doing so would invent a number (F18-AC4) |
| A successful turn ends with exactly one `turn.completed` and exits 0 | a full bounded run | `Succeeded` is emitted from `turn.completed` alone |
| Failure is `{"type":"error","message":...}` followed by `{"type":"turn.failed","error":{"message":...}}`, exit 1 | unsupported model; empty `CODEX_HOME` | only `turn.failed` and `turn.completed` end a turn. `error` events become diagnostics |
| A missing login produces **eleven** `Reconnecting... N/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header ...)` lines and then one `turn.failed` | `CODEX_HOME` pointed at an empty directory | authentication is classified **before** network. Network-first would report the tenth reconnect as the result and tell the owner to wait instead of to sign in |
| An unsupported model produces `The '<model>' model is not supported when using Codex with a ChatGPT account.` inside `turn.failed`, exit 1 | `-m definitely-not-a-real-model-xyz` | `UnavailableModel` is a `Blocked` outcome with a remedy naming plan or model choice |
| `{"type":"item.completed","item":{"type":"error","message":...}}` is a real event shape | the unsupported-model run | an error item is a diagnostic, never a terminal outcome |
| `codex exec resume --help` lists `--json`, `--output-last-message` and `-c`, and lists **neither** `--sandbox` nor `--cd` | `--help` | `buildArgv` emits a different flag set per invocation. Faking one shared list would have produced a resume running unrestricted |
| `-c sandbox_mode='read-only'` **does** constrain a resumed session: asked to write a file, it produced no file and reported the workspace read-only | live resume | the resume sandbox is a config override, and the refusal is not assumed |
| `-c sandbox_mode='workspace-write'` **does** permit the same write in the same resumed session | live resume | the override is a real constraint in both directions, not a no-op |
| `codex exec resume <SESSION_ID> <PROMPT>` restores the conversation. Asked, with no tool available to check, which file it had created in the earlier turn, it answered `probe.txt: HELLO` | live resume | continuation is **genuinely in place**, so `resumeSession` reports `ResumedInPlace` rather than declaring restoration unsupported (F15-AC4) |
| The resumed session runs in the **spawned process's** working directory, not the thread's recorded directory | live resume from a second workspace | `resume` has no `--cd`, so the workspace is scoped by `spawn`'s `cwd`. This is the same mechanism `--cd` uses for a fresh start |
| An unknown thread id fails with **no JSONL at all** and exit 1: `Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)` | `codex exec resume 00000000-0000-4000-8000-000000000000` | that exact condition, and only that condition, produces `RestartedFromCheckpoint` with a fresh session seeded from the checkpoint |
| `--` ends flag parsing, so an instruction beginning with `-` is still an instruction | `codex exec --sandbox read-only --cd <dir> --json -- "<prompt>"` started normally | the prompt is passed after `--` and can never be read as an option |
| The binary's `ThreadEvent` serde names corroborate the observed set: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error` | `strings` over the shipped binary | `CODEX_MODELLED_EVENT_TYPES` matches the wire, so a type this adapter does not model is a deliberate omission rather than a guess |

## Proven against CAPTURED output, not a live run

These are real code paths over bytes a real `codex` produced, asserted in `events.test.ts`. They
are translation proofs, not compatibility proofs.

| Behaviour | Why it is not re-proven live on every run |
| --- | --- |
| The full `EngineEvent` mapping, including stage translation, `milestoneKey` dedup and the success summary | Already proven by a live run (above). Re-running costs quota on every test execution, so the captured stream is the fixture |
| `MissingAuthentication` and `UnavailableModel` blocked outcomes | Both were observed live. Re-proving them requires either an empty `CODEX_HOME` or an invalid model on every test run |
| `QuotaExhausted` | **Not observed live.** Exhausting the account's quota is not something this adapter may do to prove a mapping. See below |
| `UnsupportedRuntime`, `SandboxDenial`, `ToolError`, `NetworkError` categories | Not provoked. Each requires breaking the host or the engine on purpose |

## Proven against a SCRIPTED process, not Codex

`codex.test.ts` writes a small `sh` script into a temp directory that emits Codex's real JSONL and
exits on cue, then drives `startSession` and `stopSession` against it. That is not a fake adapter:
it is a real process emitting the real wire format, and everything downstream of it — argv,
detached process group, line queue, translation, terminal decision, shutdown — is the shipped
code. It exists because proving those properties does not require spending engine quota, and
because the shutdown contract needs a process that **ignores `SIGTERM`** in order to prove that
escalation is what ended it.

## `resumeSession`: what it actually does, and what it is honest about

**It really does continue the conversation.** `codex exec resume <SESSION_ID>` on 0.159.1 restores
the recorded rollout, proven live: a resumed session recalled a file created in the earlier turn
without running any tool. So `Engine:ResumeSession` is declared **supported** and the happy path
returns `ResumedInPlace` carrying the prior `lastEventAt`.

Three caveats are recorded rather than hidden, and all three are in the capability declaration's
`limitation` string so the owner UI can show them before a resume is attempted:

1. **`resume` has no `--sandbox`.** The sandbox arrives as `-c sandbox_mode='<mode>'`, verified live
   in both directions (read-only refused a write; workspace-write permitted it).
2. **`resume` has no `--cd`.** The workspace is scoped by the spawned process's working directory,
   which is the same mechanism `--cd` provides for a fresh start. The resumed session runs in the
   directory the adapter spawned it in, **not** the directory recorded in the thread — verified by
   resuming from a second workspace.
3. **`resume` outside a git directory needs `--skip-git-repo-check`.** Without it Codex refuses with
   `Not inside a trusted directory and --skip-git-repo-check was not specified.` and exits 1. The
   option defaults to **off** because a ShipLoop workspace is expected to be a worktree, and
   silently disabling the check would let an engine run somewhere other than the intended repository.

**The contract's other two continuation variants are not manufactured.** `RestartedFromCheckpoint`
is produced only for the observed `no rollout found` wording. `ContinuationUnsupported` is
**unreachable** in this implementation, because Codex 0.159.1 does support restoration; reporting
it would be a false claim of a limitation. That is a deliberate divergence from the shared
`FakeEngineAdapter`, which must return it — see the contract-suite note below.

## The shared contract suite cannot execute against this adapter

**This is structural, not an omission, and it is the same reason recorded for the Linear adapter.**
`runAdapterContractSuite` takes an `AdapterSet` whose `engine` is typed `FakeEngineAdapter`
(`../testing/fake.ts`), and the engine cases assert against `FIXTURE_*` identities such as
`sess_fixture_01` and the sentinel event lines `FIXTURE_ENGINE_EVENT_LINES`, one of which is
deliberately truncated. No real engine can produce those bytes, so the engine cases are fake-only
by construction: pointing them at this adapter would require it to echo a fixture sentinel, which
is inventing a capability. `../testing/` is outside this unit's file ownership, and weakening a
shared harness to make one provider look covered would be the wrong trade.

So the suite runs where it was written, against the fakes, and this adapter reproduces the
engine-facing assertions against itself and against captured real output.

| Contract case | Touches `engine`? | Proven against the **real** adapter |
| --- | --- | --- |
| F15-AC2 malformed engine output is not a completion | yes | **yes** — `events.test.ts` and `codex.test.ts` both assert the diagnostic, the terminal retry, `usage: Unknown` and the absence of any `Result` |
| N05-AC2 an unsupported operation is unavailable, and an unsupported continuation falls back to a checkpoint | yes (`ensureSupported`, `resumeSession`) | **No, and it cannot be.** The fake declares `Engine:ResumeSession` unsupported and the case asserts `ContinuationUnsupported`. Codex supports restoration, so that premise is false for this adapter |
| F19-AC5 a read-only job completes with a stated no-code outcome | yes | **No.** Codex reports no repository-change flag; that is a Git fact the engine does not state. See "Contract members Codex cannot support" |
| F12-AC1, F11-AC1, F30-AC2 (ticket half), F28-AC4, F03-AC4, F30-AC4 | no | not applicable — those are ticket, Git and deployment cases |

Two of the fake's engine behaviours are **deliberately not reproduced**, and both are divergences
worth stating:

- **The fake emits no `Usage` event when the stream reported none.** F18-AC4 says "report provider
  usage when available, and `Unknown` when absent", and `EngineReportedUsage` has an `Unknown`
  variant with a reason for exactly that. This adapter therefore emits exactly **one** `Usage`
  event per session, always. An event stream that sometimes omits the record makes "absent" and
  "not reported" indistinguishable to anything reading the log.
- **The fake returns `checkpoint` with empty `dirtyPaths` on stop.** Codex holds no checkpoint and
  this adapter has no way to read a dirty inventory or a `CommitSha`, so `stopSession` returns
  `checkpoint: null`. The contract permits null in `EngineStopOutcome.Stopped` for this case, and
  inventing an empty inventory would assert a fact about the repository that nobody observed.

## Contract members Codex cannot genuinely support

| Contract member | Status | Why |
| --- | --- | --- |
| `EngineSessionHandle.sessionId` | supported, real | the `thread_id` from `thread.started`, verified live |
| `EngineEvent` `SessionStarted` / `Progress` / `Result` / `Diagnostic` / `Usage` / `Stopped` | supported | all six, over the observed wire format |
| `EngineEvent` `Checkpoint` | **never emitted** | Codex has no checkpoint concept, and an `EngineCheckpoint` needs the dirty and untracked inventory plus two `CommitSha` values, which are Git facts. Emitting one would be asserting an unobserved repository state |
| `Progress.detail` (`ArtifactReference`) | **always null** | Codex writes to stdout, stderr and the workspace; it does not write into a ShipLoop artifact store. `ArtifactReference` requires a `uri` and a literal `sanitized: true`, and this unit has no store to point at, so naming one would fabricate evidence (F15-AC2) |
| `Progress.stage` | **translated, not read** | Codex reports no stage. `STAGE_BY_ITEM_TYPE` is this adapter's mapping and every event carries the engine's own text beside it so the raw fact stays visible |
| `EngineUsage` cached / reasoning token splits | **dropped** | the contract has no field for them. They are read (so a partial block is detected) and then not reported, because folding them into `outputTokens` would change the meaning of the number |
| `EngineUsage` window, balance and cost | **always null** | Codex reports none. Deriving a cost from a token count would invent a figure the owner would budget against (F18-AC4) |
| `EngineOutcome` `Succeeded` | supported, strictly | produced only from a well-formed `turn.completed` with no malformed line anywhere in the stream |
| `EngineOutcome` `Blocked` (four categories) | supported | three of four proven live or captured; `QuotaExhausted` is matched on the engine's own published wording only |
| `EngineContinuation` `ResumedInPlace` | supported, proven live | conversation restoration works |
| `EngineContinuation` `RestartedFromCheckpoint` | supported | reached on the observed `no rollout found` failure |
| `EngineContinuation` `ContinuationUnsupported` | **unreachable** | Codex does support restoration. Reporting it would be a false claim of a limitation |
| `EngineStopOutcome.Stopped.checkpoint` | **always null** | see above |
| `EngineStopOutcome.Detached` | supported | reported when the tracked group is still populated after `SIGKILL`, with `reconcileRequired: true` |
| `EngineStopOutcome.StopRefused` | supported | reported for a session this adapter did not spawn |
| `EngineMode` `Interactive` | **refused** | Codex is driven through `codex exec`, which has no interactive transport this adapter can read as structured events. An interactive session would report progress the adapter cannot see |

## Exactly what "the writer is stopped" means here

`stopSession` signals **one process group**, captured at spawn time, and never searches by command
name, port or pattern. The child is spawned `detached`, so it leads a new process group and every
descendant it starts inherits that group id.

- `SIGTERM` to `-pgid`, then a bounded wait. If the group exits, the stop is reported as graceful
  with no escalation.
- `SIGKILL` to the same `-pgid`, then a bounded wait. The stop is reported as escalated.
- The group is then polled to a deadline, not sampled once. A single `kill(-pgid, 0)` immediately
  after the leader exits is a **race**: a descendant this adapter did not spawn is reaped by init,
  so the group can still hold a zombie for a few milliseconds. Sampling once would report
  `Detached` for a group that is in fact clean, which blocks an attempt for no reason.
- Only a group **observed** empty yields `Stopped`. A group still populated yields `Detached` with
  `reconcileRequired: true`, never `Stopped` (F17-AC1, F17-AC5).
- A session this adapter does not hold yields `StopRefused`. Signalling a process it did not spawn
  is precisely the second-writer hazard, and searching for one by name is never the alternative.

**The process-group proof is a real test, not a claim.** `codex.test.ts` spawns a `node -e` parent
that itself spawns a grandchild, with **both** ignoring `SIGTERM`, asserts `ps` shows two processes
in the tracked group before the stop, stops it, and then asserts `ps` shows none. If the adapter
signalled only the direct child, or matched by name, that assertion fails. The adapter-level test
does the same through a scripted engine whose `sh` body is `trap '' TERM` with a
`sh -c "trap '' TERM; sleep 120"` child, and additionally asserts the workspace file is untouched.

## Known gaps and honest limits

- **`Checkpoint` and `ArtifactReference` are never produced.** F15-AC2's "output artifacts" half is
  unmet by design in this unit: there is no artifact store to write to and no checkpoint source.
  Both need a Git adapter and an artifact store, and inventing the references would be worse than
  reporting `null`.
- **`QuotaExhausted` is unproven.** The markers are Codex's own published wording, recovered from
  the binary's string table (`usage limit`, `rate_limit_exceeded`, `quota_exceeded`,
  `usage_limit_reached`, `workspace_owner_usage_limit_reached`, `workspace_member_credits_depleted`).
  Exhausting the owner's quota to capture one is not something this adapter may do.
- **`UnsupportedRuntime`, `SandboxDenial`, `ToolError` and `NetworkError` are unproven live.** Each
  requires breaking the host or the engine deliberately. `ToolError` is exercised end to end by a
  scripted engine that reports a non-zero `exit_code`, so only its *wording* is unproven.
- **The operator profile on this host asks for an unrestricted engine.** `~/.codex/config.toml`
  sets `sandbox_mode` to the unrestricted value and `approval_policy = "never"`. The flag this
  adapter puts on the command line is the only thing that overrides it, which is why
  `resolveSandboxMode` is an **allowlist**: a denylist that missed a future Codex sandbox name
  would fail open, and an allowlist fails closed. The refusal names both permitted modes so an
  owner correcting the profile does not have to read this file.
- **`--output-last-message` is deliberately unused.** It writes a file, and this unit has no
  artifact store to own it. The engine's final message already arrives as a completed
  `agent_message` item, which is what the success summary uses.
- **Stage attribution is a translation, not a provider fact.** `reasoning` items are dropped
  deliberately: promoting the engine's private scratch text into owner-visible progress would put
  model reasoning into product state.
- **`Engine:ReportUsage` reports token counts only.** A cost figure would require a price list
  ShipLoop does not have and must not guess (F18-AC4).
- **No retry inside the adapter.** F18-AC5 makes deterministic scope and authentication failures
  non-retryable, and a network retry belongs to a separate bounded budget (`EngineBounds.retryBudget`)
  rather than to a transport that would restart the whole coding budget. Every diagnostic therefore
  carries an explicit `retry: Retryable | Terminal`.
- **`codex exec resume` is proven for one thread and one host.** Restoration is Codex's own rollout
  store under `CODEX_HOME`. It was not proven across a Codex upgrade, across a `CODEX_HOME` change,
  or for a session recorded by a different binary version.
