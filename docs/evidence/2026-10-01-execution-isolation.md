# Execution isolation and the restricted broker — measured 2026-10-01

**Status:** the coding engine can be, and from this commit is configured to be, launched as a
different uid with a ShipLoop-owned home and an empty inherited environment, and every remote write
goes through a broker that refuses a privileged action from that uid. What is *not* done: the worker
only isolates the engine when `SHIPLOOP_ENGINE_*` is configured, and no deployment on this host is
configured yet.

This is the work item 3.3 of `2026-10-01-credential-separation.md` — "a broker that performs the
privileged write" — plus the second half of 3.2, "a home the worker cannot read". Section 4 of that
document is unchanged: the credential decisions and the branch protection are still the owner's, and
section 6 below says exactly which step is left.

Everything quoted here was produced on this VM as the `ubuntu` user. The only host changes are the
reversible provisioning in section 2. No credential was read, created, rotated or copied, no live
repository was touched, and every secret in this document is synthetic.

---

## 1. The mechanism, and why this one

The engine is launched by `apps/worker/src/isolation.ts` as `shiploop-engine` (uid 1999, its own
group, `nologin` shell, home `/nonexistent`), with a per-attempt `HOME` it owns alone, a per-attempt
`TMPDIR`, and an environment built from nothing.

A dedicated uid was chosen over the alternatives, and the reason is specific rather than
general:

| Alternative | Why it was not chosen here |
| --- | --- |
| Mount namespace (`unshare --mount` + bind mounts) | Still runs as the operator's uid, so anything the bind mounts do not enumerate stays reachable, and hiding `/home/ubuntu` also hides the toolchain installed there. Measured available on this host; not used. |
| Container (LXD is installed and the daemon answers) | The right answer for an untrusted third-party image. Costs a daemon, an image pipeline and a network policy to confine one engine this product already trusts to write only its own workspace. |
| User namespace (`unshare --user --map-root-user`) | **Cannot be used here at all.** A process in a child user namespace may not be signalled by the operator that spawned it, so the worker could not stop the group it is required to stop (F17-AC1). Measured available; rejected. |
| **`setpriv` / `sudo -n` to a dedicated uid** | Closes the directory channel with ordinary POSIX permissions, needs no daemon, keeps the engine inside the process group the existing shutdown contract already signals, and is reversible with one `userdel`. |

The environment is an allowlist by construction rather than by scrubbing: the transition runs first,
because only it can change the uid, and everything after it starts from `env -i`. A denylist of
credential-shaped names cannot be exhaustive, and `packages/adapters/src/codex/client.ts` already
scrubs the variable channel; what a different uid adds is the *filesystem* channel.

Two consequences of a different uid were measured rather than assumed, and both changed the code:

1. **The worker can no longer signal the engine's process group.** `kill(-pgid)` from uid 1001 is
   skipped for members owned by 1999, so `SIGTERM` and `SIGKILL` both leave an isolated child
   running. The stop path therefore escalates through the same transition (`stopTrackedGroup`,
   `stopIsolatedGroup`), and the launcher records the group id it leads before the transition, because
   after the transition nothing else can find it.
2. **The engine cannot read the toolchain installed under the operator's home.** `node`, `npm`,
   `pnpm` and the operator's `codex` 0.159.1 all live under `/home/ubuntu`, which the principal
   cannot even traverse. Section 3 installs a ShipLoop-owned copy of the engine at
   `/srv/shiploop/engine-bin/codex`; `node` and `git` were found at system paths and need nothing.

## 2. Provisioning, and the exact rollback

Every command was run on this VM as `ubuntu`. The two that need root use `sudo -n`, which is
passwordless for this user (`/etc/sudoers.d/99-zz-ubuntu-nopasswd: ubuntu ALL=(ALL:ALL) NOPASSWD:ALL`).

```console
$ sudo -n groupadd --system --gid 1999 shiploop-engine
$ sudo -n useradd --system --uid 1999 --gid 1999 \
    --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin shiploop-engine
$ getent passwd shiploop-engine
shiploop-engine:x:1999:1999::/nonexistent:/usr/sbin/nologin

# ShipLoop-owned roots. /srv/shiploop itself is root-owned; the three working roots are owned by the
# worker, because the worker creates the per-attempt directories inside them. The execution principal
# is not the owner and cannot write any of them.
$ sudo -n install -d -o root   -g root    -m 0755 /srv/shiploop
$ sudo -n install -d -o ubuntu -g ubuntu  -m 0755 \
    /srv/shiploop/bin /srv/shiploop/attempts /srv/shiploop/engine-homes /srv/shiploop/engine-tmp

# The verified engine, at a path the execution principal can reach. The operator's copy is inside a
# home the principal cannot read, so it is copied rather than symlinked.
$ sudo -n install -d -o root -g root -m 0755 /srv/shiploop/engine-bin
$ sudo -n cp /home/ubuntu/.codex/packages/standalone/releases/0.159.1-aarch64-unknown-linux-musl/bin/codex \
    /srv/shiploop/engine-bin/codex
$ sudo -n chown root:root /srv/shiploop/engine-bin/codex && sudo -n chmod 0755 /srv/shiploop/engine-bin/codex
$ ls -l /srv/shiploop/engine-bin/
-rwxr-xr-x 1 root root 247590168 Oct  1 23:50 /srv/shiploop/engine-bin/codex
$ sudo -n -u shiploop-engine -- /usr/bin/env -i HOME=/nonexistent PATH=/usr/bin:/bin \
    /srv/shiploop/engine-bin/codex --version
WARNING: proceeding, even though we could not create PATH aliases: Permission denied (os error 13)
codex-cli 0.159.1
```

(The warning is the same one as in 5.3: `HOME=/nonexistent` is not writable and there is no
`TMPDIR`, so the engine declines to create its helper symlinks. It reports the version and exits 0.)

Resulting tree:

```console
$ ls -ld /srv/shiploop /srv/shiploop/*
drwxr-xr-x 7 root   root   4096 Oct  1 23:50 /srv/shiploop
drwxr-xr-x 2 ubuntu ubuntu 4096 Oct  1 23:50 /srv/shiploop/attempts
drwxr-xr-x 2 ubuntu ubuntu 4096 Oct  1 23:50 /srv/shiploop/bin
drwxr-xr-x 2 root   root   4096 Oct  1 23:50 /srv/shiploop/engine-bin
drwxr-xr-x 2 ubuntu ubuntu 4096 Oct  1 23:50 /srv/shiploop/engine-homes
drwxr-xr-x 2 ubuntu ubuntu 4096 Oct  1 23:50 /srv/shiploop/engine-tmp
```

The launcher and probe executables are written into `/srv/shiploop/bin` at dispatch time, named with
the attempt id and a random token, mode 0755, owned by the worker. `planIsolation` refuses to
dispatch if the principal owns them or if any group or other write bit is set, because a launcher the
engine can rewrite is not a launcher.

### Rollback, exactly — measured, then re-provisioned

This was run against the live provisioning to confirm it removes everything, and the provisioning in
the previous section was then re-run to put it back:

```console
$ sudo -n rm -rf /srv/shiploop                      # launchers, per-attempt homes, attempt roots, engine copy
$ sudo -n userdel shiploop-engine
$ sudo -n groupdel shiploop-engine
groupdel: group 'shiploop-engine' does not exist  # userdel removed the private group with the account
$ getent passwd shiploop-engine || echo "no shiploop-engine account"
no shiploop-engine account
$ ls -ld /srv/shiploop || echo "no /srv/shiploop"
ls: cannot access '/srv/shiploop': No such file or directory
no /srv/shiploop
$ sudo -n -u shiploop-engine true
sudo: unknown user shiploop-engine
```

`groupdel` is kept in the sequence as a no-op safety net for the case where the account was created
with `--user-group` disabled. Per-attempt homes, temporary directories and launcher files live under
`/srv/shiploop` and go with it; nothing this work item created exists anywhere else on the host.

No other file on this host was changed: no `/etc/sudoers.d` entry, no systemd unit, no kernel or
sysctl setting, no `lxc` profile, and nothing in the repository's own Git configuration. `sudo`,
`setpriv`, `unshare`, `lxc` and `systemd-run` were measured, not installed.

## 3. The worker configuration that turns this on

```console
export SHIPLOOP_WORKER_DATABASE=/var/lib/shiploop/data/shiploop.db
export SHIPLOOP_WORKER_HOLDER=shiploop-worker-1
export SHIPLOOP_WORKER_REPOSITORY=/srv/shiploop/repos/ShipLoop
export SHIPLOOP_WORKER_ATTEMPT_ROOT=/srv/shiploop/attempts

export SHIPLOOP_ENGINE_PRINCIPAL=shiploop-engine
export SHIPLOOP_ENGINE_UID=1999
export SHIPLOOP_ENGINE_GID=1999
export SHIPLOOP_ENGINE_HOME_ROOT=/srv/shiploop/engine-homes
export SHIPLOOP_ENGINE_TEMP_ROOT=/srv/shiploop/engine-tmp
export SHIPLOOP_ENGINE_LAUNCHER_ROOT=/srv/shiploop/bin
export SHIPLOOP_ENGINE_BINARY=/srv/shiploop/engine-bin/codex
export SHIPLOOP_ENGINE_OPERATOR_HOME=$HOME
export SHIPLOOP_ENGINE_DATABASE_PATH=/var/lib/shiploop/data/shiploop.db
export SHIPLOOP_ENGINE_PROTECTED_PATHS=$HOME/.ssh:$HOME/.ssh/id_ed25519:$HOME/.codex
```

`SHIPLOOP_ENGINE_*` is what `readIsolationConfiguration` reads. **Absent is a different answer from
invalid**: an environment that mentions none of them runs the engine unisolated and says so once at
startup, and an environment that mentions some of them is a configuration fault that is refused. That
is the one place this design is weaker than the specification would like, and section 6 says what
closes it. A configured isolation that cannot be established is *never* downgraded: `planIsolation`
returns a `Blocked` error naming each failed prerequisite with its remedy, and the attempt is not
dispatched.

Paths are refused unless they match `/^\/[A-Za-z0-9._+\/-]*$/`, because they are written into a
generated shell script as single-quoted words.

## 4. The launcher this product installs

Generated per attempt by `planIsolation`, installed 0755, and pointed at by
`CodexEngineAdapter`'s `binary`:

```sh
#!/bin/sh
# ShipLoop engine launcher. Generated by apps/worker/src/isolation.ts; do not edit by hand.
# The engine runs as shiploop-engine (1999:1999)
# with HOME=/srv/shiploop/engine-homes/ws_proof/home and an environment built from nothing by `env -i`.
set -e
SHIPLOOP_ENGINE_PROGRAM='/srv/shiploop/engine-bin/codex'
# The preflight proves the boundary by running itself through this launcher, so what is verified
# is the executable the engine adapter is pointed at rather than a separate code path.
if [ "${1:-}" = '--shiploop-isolation-probe' ]; then
  shift
  exec '/usr/bin/sudo' '-n' '-u' 'shiploop-engine' '--' '/usr/bin/env' -i \
  'HOME=/srv/shiploop/engine-homes/ws_proof/home' \
  'PATH=/usr/local/bin:/usr/bin:/bin' \
  'TMPDIR=/srv/shiploop/engine-tmp/ws_proof' \
  'LANG=C.UTF-8' \
  'TZ=UTC' \
  'SHIPLOOP_ATTEMPT_ID=ws_proof' \
  '/bin/sh' '/srv/shiploop/bin/isolation-probe-ws_proof-<token>.sh' "$@"
fi
# The process group this engine leads, recorded before the transition because after it this
# process cannot signal the group it started. $$ is the launcher's own pid, and the launcher
# leads the group, so this is the group id and not a name or a port (F17-AC1).
printf '%s\n' "$$" > '/srv/shiploop/bin/engine-group-ws_proof-<token>.pid'
exec '/usr/bin/sudo' '-n' '-u' 'shiploop-engine' '--' '/usr/bin/env' -i \
  'HOME=/srv/shiploop/engine-homes/ws_proof/home' \
  'PATH=/usr/local/bin:/usr/bin:/bin' \
  'TMPDIR=/srv/shiploop/engine-tmp/ws_proof' \
  'LANG=C.UTF-8' \
  'TZ=UTC' \
  'SHIPLOOP_ATTEMPT_ID=ws_proof' \
  '/srv/shiploop/engine-bin/codex' "$@"
```

`exec` in both branches is what keeps the group leader's pid, so the group
`packages/adapters` tracks is the group the engine and its descendants belong to. `"$@"` is the
adapter's own argv, passed through unchanged and never interpreted.

## 5. The proof: the launched child, not a helper function

`node /tmp/opencode/proof/prove-isolation.ts` from the task worktree. The probe is launched **through
the installed launcher**, so what section 5.1 shows is the executable the engine adapter is pointed
at. Synthetic secrets only: a seeded `0600` file inside a `0700` directory standing in for an operator
credential directory, and a seeded environment variable (`SHIPLOOP_SYNTHETIC_CREDENTIAL`) set in the
launching process's own environment, so a forwarded environment would carry it.

### 5.1 The preflight probe's own report

```console
=== 1. the preflight probe, launched through the installed launcher ===
launcher: /tmp/shiploop-proof-u8SorL/launcher/engine-launcher-ws_proof-8cf2ba9c0ba94b0e.sh
engine=executable
uid=1999
gid=1999
groups=1999
home=/tmp/shiploop-proof-u8SorL/engine-homes/ws_proof/home
envnames=HOME,LANG,PATH,PWD,SHIPLOOP_ATTEMPT_ID,TMPDIR,TZ,
stdin=notty
wrote=ok
denied=/home/ubuntu
denied=/home/ubuntu/.ssh
denied=/home/ubuntu/.ssh/id_ed25519
denied=/home/ubuntu/.codex/config.toml
denied=/tmp/shiploop-proof-u8SorL/operator-private/seeded-secret.txt
denied=/tmp/shiploop-proof-u8SorL/operator-private/shiploop.sqlite
denied=/tmp/shiploop-proof-u8SorL/operator-private
```

`wrote=ok` means the probe wrote into the workspace it was assigned *and deleted the marker again*:
the probe runs inside the attempt's own worktree, and a marker left there would be an untracked file in
the attempt's checkpoint inventory, which is exactly what makes a no-code run look like a change
(F14-AC4, F19-AC5).

`stdin=notty` is a real check, not decoration: `use_pty` is set in this host's `/etc/sudoers`, and an
engine handed an interactive stdin would block a turn on input nobody sends. Measured on sudo 1.9.9,
a `-n` command still gets a non-tty stdin and CR-free output.

### 5.2 The same transition, with real errno text

```console
=== 2. the same launcher, argv spelled out, answering with real errno text ===
$ id
uid=1999(shiploop-engine) gid=1999(shiploop-engine) groups=1999(shiploop-engine)
$ echo HOME=/tmp/shiploop-proof-u8SorL/engine-homes/ws_proof/home
HOME=/tmp/shiploop-proof-u8SorL/engine-homes/ws_proof/home
$ printenv | wc -l  (variable count the engine was given)
6
$ printenv | cut -d= -f1
HOME LANG PATH PWD TMPDIR TZ
$ echo absent   # the seeded credential variable
absent
$ cat /tmp/shiploop-proof-u8SorL/operator-private/seeded-secret.txt
cat: /tmp/shiploop-proof-u8SorL/operator-private/seeded-secret.txt: Permission denied
$ ls /tmp/shiploop-proof-u8SorL/operator-private
ls: cannot open directory '/tmp/shiploop-proof-u8SorL/operator-private': Permission denied
$ cat /tmp/shiploop-proof-u8SorL/operator-private/shiploop.sqlite
cat: /tmp/shiploop-proof-u8SorL/operator-private/shiploop.sqlite: Permission denied
$ cat /home/ubuntu/.ssh/id_ed25519
cat: /home/ubuntu/.ssh/id_ed25519: Permission denied
$ ls -d /home/ubuntu/.ssh
ls: cannot access '/home/ubuntu/.ssh': Permission denied
$ cat /home/ubuntu/.codex/config.toml
cat: /home/ubuntu/.codex/config.toml: Permission denied
$ ls -ld /tmp/shiploop-proof-u8SorL/engine-homes/ws_proof/home
ls: cannot access '/tmp/shiploop-proof-u8SorL/engine-homes/ws_proof/home': Permission denied
$ echo written-by-the-engine > /tmp/shiploop-proof-u8SorL/attempts/worktrees/ws_proof/proof.txt
written-by-the-engine
$ whoami; git --version; node --version
shiploop-engine
git version 2.34.1
v24.14.1
exit=0
workspace owner uid = 1999, proof.txt owner uid = 1999, worker uid = 1001
```

Four properties, each measured: the child is not the operator (1999, not 1001); the operator's `HOME`,
its `~/.ssh` directory and key, and its Codex profile — the file that sets
`sandbox_mode = "danger-full-access"` and `approval_policy = "never"` for this repository — are all
unreadable; the seeded credential variable is absent from a six-variable environment; and the child
can still write in the workspace it was assigned and run `git` and `node` from system paths.

`/home/ubuntu` is mode `0750` and `/home/ubuntu/.ssh` is `0700`, both owned by the operator, which is
why the denial starts one level above the credential.

### 5.3 The real engine binary, through the launcher

```console
=== 3. the real engine binary, launched through the installed launcher ===
stdout: codex-cli 0.159.1
stderr: WARNING: proceeding, even though we could not create PATH aliases: Permission denied (os error 13)
exit=0
process group recorded by the launcher: 3672170
transition: Sudo ["/usr/bin/sudo","-n","-u","shiploop-engine","--"]
```

The warning is the engine declining to create helper symlinks in a root-owned directory, and it is
the only difference from a run as the operator. It does not appear when `TMPDIR` is outside `/tmp`
(section 3 sets `/srv/shiploop/engine-tmp`), which is why that root is configurable.

### 5.4 Cleanup by process group leaves no descendant

The child is a tree — `sleep 300 & sleep 300` — so the assertion is about the descendant, because a
signal that reaches only the leader leaves a process running in a workspace nobody believes is busy.

```console
=== 4. cleanup by process group: a descendant tree, then the stop ===
group=3672175 leader=3672175 descendant=3672177 groupAlive=true
PID    PPID    PGID STAT USER     COMMAND
3672177 3672176 3672175 S    shiploo+ sleep 300
stop report: endedBy=SIGTERM survivors=[] groupAlive=false
ps for the descendant after the stop:
PID    PPID    PGID STAT USER     COMMAND
ps for the whole group after the stop:
(no process remains in process group 3672175)
```

The `ps` for the descendant pid is empty: the process is gone, not merely unsignalable. The stop
sends `SIGTERM` to the group, waits, sends `SIGKILL` to the same group, and reports survivors rather
than assuming them away; a survivor is reported as `Detached` so the coding slot stays held
(F17-AC1, F17-AC5).

## 6. The broker: allowed publication, refused privileged delivery

`apps/worker/src/broker.ts`. Feature-branch publication and privileged delivery are separate methods
over separate ports, and the ports take credentials of **different types**:
`FeatureBranchCredential { scope: 'FeatureBranchWrite' }` and
`PrivilegedCredential { scope: 'PrivilegedDelivery' }`. The engine path therefore has nothing it could
pass to the privileged call even if the check were removed. The refusal is computed from the
principal and the authorization *before* any credential is read.

`node /tmp/opencode/proof/prove-broker.ts`, against a synthetic local bare repository:

```console
$ git --git-dir=<bare> show-ref  (before anything)
9daca61c4aa9deb4f3637d10d863c4c1441fc004 refs/heads/main
base commit on main: 9daca61c4aa9deb4f3637d10d863c4c1441fc004
feature commit to publish: 76b98327893b346313959fb9b3e252bfddde2885
=== allowed: a feature-branch publication, performed by the broker with controller-held credentials ===
{
  "ok": true,
  "value": {
    "action": "PublishFeatureBranch",
    "performedBy": {
      "kind": "Engine",
      "uid": 1999,
      "attemptId": "ws_proof",
      "workspacePath": "/srv/shiploop/attempts/worktrees/ws_proof"
    },
    "receipt": {
      "repository": "synthetic/shiploop",
      "branch": "shiploop/task/ws_proof",
      "headSha": "76b98327893b346313959fb9b3e252bfddde2885",
      "remoteRef": "refs/heads/shiploop/task/ws_proof",
      "pushedAt": "2026-10-01T00:00:00.000Z"
    }
  }
}
$ git --git-dir=<bare> show-ref  (after the publication)
9daca61c4aa9deb4f3637d10d863c4c1441fc004 refs/heads/main
76b98327893b346313959fb9b3e252bfddde2885 refs/heads/shiploop/task/ws_proof
remote ref for the task branch: 76b98327893b346313959fb9b3e252bfddde2885 (feature commit is 76b98327893b346313959fb9b3e252bfddde2885)
=== refused: the same principal asks to merge, and to release ===
$ broker.mergeCandidate
  Forbidden: the coding engine as uid 1999 for attempt ws_proof may not merge shiploop/task/ws_proof. A coding attempt is not an owner: privileged delivery is performed by the broker on the owner's authorization, and no credential that could perform it exists on the engine's side of this boundary (F03-AC3, N02-AC3). Record the required checks, present the review card, and have the owner authorize the delivery.
$ broker.releaseDeployment
  Forbidden: the coding engine as uid 1999 for attempt ws_proof may not release shiploop/task/ws_proof. A coding attempt is not an owner: privileged delivery is performed by the broker on the owner's authorization, and no credential that could perform it exists on the engine's side of this boundary (F03-AC3, N02-AC3). Record the required checks, present the review card, and have the owner authorize the delivery.
$ broker.publish to the base branch
  Forbidden: The branch main is the base branch of synthetic/shiploop, so publishing to it is a privileged write and is not this path. Feature-branch publication writes the attempt's own branch; a merge or a release is the controller's to authorize (F03-AC5, N02-AC3).
$ broker.merge with no owner authorization
  Forbidden: Merging shiploop/task/ws_proof requires an owner authorization for that ref, and none was presented. The broker performs a privileged write only against a named owner decision (F13-AC3, N02-AC3).
$ broker.merge authorized for another ref
  Forbidden: The owner authorized merge of main, not shiploop/task/ws_proof. An authorization names one ref and is not transferable to another (F03-AC3, N02-AC3).
privileged port calls: 0
what the broker's ports observed: ["publish scope=FeatureBranchWrite branch=shiploop/task/ws_proof"]
$ git --git-dir=<bare> show-ref  (after every refusal)
9daca61c4aa9deb4f3637d10d863c4c1441fc004 refs/heads/main
76b98327893b346313959fb9b3e252bfddde2885 refs/heads/shiploop/task/ws_proof
remote main is still the base commit: true
=== the worker process: no privileged credential at all ===
worker merge: Forbidden: This worker holds no privileged delivery credential. Merge and release are the controller’s to perform on the owner’s authorization.
worker release: Forbidden: This worker holds no privileged delivery credential. Merge and release are the controller’s to perform on the owner’s authorization.
fixture removed: /tmp/shiploop-broker-proof-6nsJTC
```

`privileged port calls: 0` is the measurement that matters: after five refusals, including one that
presented a *valid* owner authorization, the privileged deliverer had still never been called, and the
only thing the publisher saw was a `FeatureBranchWrite` credential for the attempt's own branch.

The worker process itself is wired with `privilegedCredential: null` and
`refusePrivilegedDelivery(...)`, so `apps/worker/src/runtime.ts` has no merge or deploy path at all —
not a guarded one. `createDelivery` reaches the remote only through
`broker.publishFeatureBranch`.

## 7. The refusals, and the tests that hold them

`apps/worker/src/isolation.test.ts` (10 tests) and `apps/worker/src/broker.test.ts` (8 tests). The
refusals each have a test that makes the failure real rather than configured:

| Refusal | How the test produces it |
| --- | --- |
| The principal is the worker's own uid | `planIsolation` with the operator's uid: `Blocker` naming the check that failed and a remedy for each. |
| An operator home the principal can read | A synthetic `0755` home with a `0644` file in it, against the real principal: the probe reports it readable and the dispatch is refused naming that path. |
| The engine binary is not executable by the principal | `SHIPLOOP_ENGINE_BINARY` pointed at a path that does not exist: the probe reports `engine=missing`. |
| The launcher is writable by the principal | Implicit in the first row; the launcher-integrity check fires before the probe when principal and worker share a uid. |
| A half-configured environment | `SHIPLOOP_ENGINE_UID` with nothing else: refused, not treated as "unconfigured". |
| A path needing shell escaping | `SHIPLOOP_ENGINE_HOME_ROOT='/srv/shiploop/engine homes'`: refused at the boundary. |
| A probe that did not answer | `parseProbeReport` on a partial or noisy report: refused rather than read as a pass. |
| Privileged action from the engine | The broker, with a spy deliverer: `Forbidden`, zero calls, base branch unmoved. |
| Authorization for another ref or another action | Both refused with the reason naming the mismatch. |
| Publication of the base branch, `refs/…`, `-main`, `a..b`, or no commit | Refused for the controller as well, with the publisher never called. |

The isolation tests are host-dependent by nature: they prove a property of *this* host's principals
and permissions. Where the execution principal does not exist they assert the typed blocker that says
so, naming the provisioning commands — they never skip, because a skipped security test is
indistinguishable from a passed one. On this host the principal exists and all ten run the real
launcher.

## 8. What was established, and what was not

Established on this VM, with the output above:

- The engine runs as uid 1999 with a per-attempt `HOME` and a six-variable environment; the operator's
  home, `~/.ssh`, its key, its Codex profile and the authoritative database are all unreadable to it
  (5.1, 5.2).
- The seeded credential variable does not survive the transition (5.2).
- It can still write in its workspace and run `git` and `node` from system paths (5.2), and the real
  `codex` 0.159.1 runs through the launcher (5.3).
- A stop reaches a descendant of an isolated run and leaves nothing behind (5.4).
- A feature-branch publication performed by the broker reaches a real remote; five privileged or
  misdirected requests are refused, and the privileged port is never entered (6).

Not established, and deliberately so:

- **A real `codex exec` turn was not run under the new principal.** It would spend provider quota and
  needs the credential in section 9.1. The launcher, the identity, the environment and the workspace
  are all proven; a full engine turn is not.
- **`git` inside the workspace writes the index in the connected checkout's
  `.git/worktrees/<id>/`**, which stays owned by the worker. A `git add` *by the engine* therefore
  fails with `Unable to create … index.lock: Permission denied`, while `git status`, `git diff` and
  `git log` work. Committing and pushing is the broker's job, which is the design, but an engine that
  expects to stage its own work will hit this. The fix belongs with the checkout owner in section 9.2.
- **No dependency install was attempted.** `pnpm` and the pnpm store live under `/home/ubuntu`, which
  the principal cannot read; see 9.2.
- **Network policy is unchanged.** The Codex sandbox still decides egress. This work removes the
  credentials the engine could have *used* on that network; it does not decide what the network allows
  (3.4 of the credential-separation document is still open).

## 9. What is left for the owner

1. **Install a Codex credential for the execution principal.** The launcher deliberately reads no
   credential file, so nothing is inherited from the worker's environment. The owner's step, before
   the first attempt:

   ```console
   $ sudo -n install -d -o shiploop-engine -g shiploop-engine -m 0700 \
       /srv/shiploop/engine-homes/default-home/.codex
   # place the ShipLoop engine credential at
   # /srv/shiploop/engine-homes/<attempt>/home/.codex/auth.json , owner shiploop-engine, mode 0600
   ```

   Per-attempt homes are created fresh, so this has to be provisioned by whatever starts a run, or the
   home root should be seeded once and copied per attempt. A production-grade secret store is the
   durable answer; a `0600` file owned by the principal is the minimum that works today.
2. **Move the connected checkout and the attempt root out of the operator's home.** Section 3 names
   `/srv/shiploop/repos/ShipLoop` and `/srv/shiploop/attempts`. `git status`/`diff`/`log` work with the
   checkout where it is; staging by the engine does not.
3. **Give the principal a package store it can read.** `pnpm`, its store and the operator's `node` are
   under `/home/ubuntu`. Either install a system `pnpm`/`node` and set
   `PNPM_HOME`/`XDG_DATA_HOME` to a ShipLoop-owned path, or pre-bake dependencies into the engine
   image and accept that the sandbox cannot install.
4. **Set `SHIPLOOP_ENGINE_*` in the worker service** (section 3). Until then the worker starts the
   engine unisolated and prints one warning at startup; that is the only remaining place where a
   deployment can run without the boundary. Making the default refuse rather than warn needs the
   `apps/worker` fixtures (`runtime.test.ts`) to be able to construct an isolated principal, which is
   a change to a test file outside this work item's ownership.
5. **Everything in section 4 of `2026-10-01-credential-separation.md`** is unchanged and still open:
   rotate the `gho_` token, protect `main`, remove the invalid second `gh` account, mint a scoped
   GitHub identity and a separate Linear key, and remove `LINEAR_API_KEY` from the worker's
   environment. This work makes the engine unable to reach whatever the worker holds; it does not
   reduce what the worker holds.

## 10. Gates

```console
$ node node_modules/typescript/bin/tsc --noEmit -p apps/worker/tsconfig.json
tsc exit=0
$ node scripts/lint.mjs
Passed: project policy lint
lint exit=0
$ node scripts/check.mjs
Passed: foundation config, links and JavaScript syntax
check exit=0
$ node --test apps/worker/src/isolation.test.ts apps/worker/src/broker.test.ts
ℹ tests 18
ℹ pass 18
ℹ fail 0
ℹ duration_ms 2448.69361
```

```console
$ node scripts/run-tests.mjs
PASS foundation (exit 0, 2.2s)
PASS adapters (exit 0, 6.2s)
PASS controller (exit 0, 61.5s)
PASS domain (exit 0, 6.9s)
PASS storage (exit 0, 54.0s)
PASS verification (exit 0, 5.5s)
PASS web (exit 0, 7.1s)
PASS worker (exit 0, 42.1s)
Passed: 8 test suite(s)
```

Per-suite counts on this commit, against the required floors: foundation 13 (≥13), adapters 209
(≥209), controller 181 (≥181), domain 514 (≥514), storage 148 (≥148), verification 48 (≥48), web 65
(≥65), worker 45 (≥27, was 27 before this change: +18 from the two new files). The 4 skipped adapter
tests are pre-existing and untouched.

Environment: `c8a2a77` plus this work item's changes, `linux/arm64`, Node 24.18.0, pnpm 11.15.0,
as `ubuntu` on the ShipLoop VM. The isolation tests require the principal from section 2; the broker
tests require only `git` and a temporary directory.

## 11. Reproducing this

The two proof scripts are scratch files under `/tmp/opencode/proof/`, are not committed, and write
only into temporary directories they remove afterwards:

```console
# from the task worktree
node /tmp/opencode/proof/prove-isolation.ts     # sections 5.1 to 5.4
cp /tmp/opencode/proof/prove-broker.ts apps/worker/src/__brokerproof.ts   # it imports @shiploop/domain
node apps/worker/src/__brokerproof.ts           # section 6
rm apps/worker/src/__brokerproof.ts
```

The committed proofs are the tests, which need no scratch files:

```console
node --test apps/worker/src/isolation.test.ts apps/worker/src/broker.test.ts
```