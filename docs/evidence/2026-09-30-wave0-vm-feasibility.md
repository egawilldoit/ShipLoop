# Wave 0 feasibility evidence: Oracle ARM64 VM

Date: 30 September 2026. Commit at time of testing: the `dev` branch initial
commit. Environment: the user's Oracle Cloud ARM64 instance, Ubuntu 22.04.5,
kernel `6.8.0-1058-oracle`.

This report records what was actually executed on the VM, not what is expected to
work. Each row states the command and the observed result. Failing or unproven
rows are listed as blockers rather than omitted.

## Host

| Property | Observed |
| --- | --- |
| Architecture | `aarch64` (ARMv8), `dpkg --print-architecture` = `arm64` |
| CPU | 2 × Neoverse-N1, `nproc` = 2 |
| Memory | 11 932 MiB total, ~8 300 MiB available at test time, no swap |
| Disk | 58 938 MiB free on `/` (194 G, 71% used) |
| OS | Ubuntu 22.04.5 LTS |

Two cores and no swap is the binding resource constraint for this build. It is the
measured reason for the runtime choice recorded in
[ADR 0002](../decisions/0002-lean-web-runtime-on-a-two-core-vm.md).

## Pinned toolchain

| Check | Command | Observed |
| --- | --- | --- |
| Node 24 | `node --version` | `v24.18.0` |
| pnpm pin | `pnpm --version` | `11.15.0`, matching `packageManager: pnpm@11.15.0` |
| Git | `git --version` | `2.34.1` |
| Workspace install | `pnpm install` | 8 projects resolved, 161 packages, exit 0 |
| Native SQLite | `node` + `node:sqlite` | `DatabaseSync` works, WAL and `foreign_keys=1` |

`node:sqlite` was chosen over `better-sqlite3` because it needs no native
compilation, so no ARM64 prebuild or `node-gyp` toolchain is required on this host.
This was verified before any storage code was written.

## Headless browser

| Check | Command | Observed |
| --- | --- | --- |
| Cached build | `ls ~/.cache/ms-playwright` | `chromium-1243` present |
| Revision match | `playwright-core@1.63.0/browsers.json` | chromium revision `1243` |
| Real launch | `chrome --headless --no-sandbox --disable-gpu --dump-dom about:blank` | Exit 0, rendered `<html>…</html>` |

The pinned Playwright version matches the browser already on the host, so no
download is required and the tested browser is the one that runs. The `dbus`
messages printed during launch are benign on this image and do not affect
rendering.

## Coding engine

| Check | Command | Observed |
| --- | --- | --- |
| Version | `codex --version` | `codex-cli 0.159.1` |
| Authentication | `codex login status` | `Logged in using ChatGPT` |
| Structured events | `codex exec --help` | `--json` JSONL events, `--output-schema`, `-o` last message |
| Real bounded execution | `codex exec --sandbox workspace-write "create probe.txt …"` | Exit 0; the engine issued a real `bash` tool call and wrote `probe.txt` containing `HELLO` |
| Session identity | exec banner | `session id: 01a0f3b1-…` |

The engine executed a real tool call and produced a verifiable file on this ARM64
host. This closes the specification's question 2 (does the actual VM support the
pinned engine and current authentication) with observed output rather than an
assumption. One `bubblewrap` warning is emitted because the package is absent;
Codex used its bundled binary and the sandboxed write succeeded.

Codex reports token usage. That is the only usage source available, so usage
fields elsewhere must remain `Unknown` rather than inferred (F18-AC4).

## Ticket provider

| Check | Command | Observed |
| --- | --- | --- |
| Identity | GraphQL `{ viewer { id name email } }` | Authenticated as `MORTAKI ABDELILAH` |
| Accessible teams | GraphQL `{ teams(first:5) }` | `GYM` (gymtrack space), `EGA` (Egawilldoit) |

Linear API access works from the VM. Team `EGA` matches the specification's
recommended pilot project.

## Git provider

| Check | Command | Observed |
| --- | --- | --- |
| CLI auth | `gh auth status` | Authenticated, `repo` scope, git protocol `ssh` |
| SSH transport | `ssh -T git@github.com` | `Hi MORTAKI0!` — key accepted |
| Repository | `git ls-remote` | `origin` reachable; `origin/dev` exists and equals the foundation commit |

Push authority to the connected repository is real, which is the capability the
pilot needs for F19. See the blocker below for the merge side.

## Blockers and unproven items

These are reported rather than worked around.

1. **Deployment provider credentials are absent.** No Vercel, Netlify, Fly,
   Railway, Cloudflare or Render token exists in the environment and no CLI is
   configured. The deployment adapter can be implemented and contract-tested
   against its declared interface, but F22, F27-AC4, F28-AC2 and F29 cannot be
   proven against a live provider on this host. Owner action: provide a
   disposable deployment project plus credential.
2. **The enforceable delivery boundary is unproven.** The available Git
   credential holds `repo` scope, which permits merging as well as pushing. A
   single credential cannot both let the coding stage push and prevent it from
   merging. F03-AC5 and N02-AC3 require a tested boundary, and specification
   question 3 asks this explicitly. Owner action: create a push-only fine-grained
   token or install a branch-protection/push-rule boundary, so merge authority can
   be held by a separate executor.
3. **No repository branch protection has been verified.** F26-AC5 needs to know
   whether the provider can require a reviewer the coding identity cannot satisfy.
4. **Owner acceptance and production actions were not performed.** They require
   real owner authorization and are not delegated to an agent (AGENTS.md,
   mvp-spec 4). No authorization was manufactured.
5. **A second deployment environment was not confirmed.** F22-AC4 needs to know
   that a preview web component reaches the intended API environment.

## What this wave did not prove

Durable restart recovery, isolation of a second workspace, check execution,
browser-driven evidence, merge authorization, release confirmation, and backup
restore are all unproven because no application code existed at the time of this
report. They are tracked against their criteria as slices land, and each must be
proven on this host before the MVP is called ready.
