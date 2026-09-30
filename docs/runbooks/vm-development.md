# VM development runbook

Scope: ShipLoop development on a Linux VM, including Ubuntu. This does not install
ShipLoop into connected app repositories or operate the user's live T3 instance.

## First checkout and bootstrap

Check Node 24, Git and the pinned pnpm version. Keep your interactive SSH shell open:
run setup scripts in child processes, not with set -e in the parent shell.

```bash
cd ~/projects/ShipLoop
node scripts/doctor.mjs
pnpm --version
pnpm install --frozen-lockfile
pnpm verify
```

The dependency install may contact the registry; a DNS/network/auth failure is a
setup blocker. Once dependencies exist, use offline foundation checks. Do not
change packageManager to whichever version happens to be installed. If package.json
is invalid, repair it before invoking a package-manager shim that reads it.

Node/pnpm missing: use the machine's existing runtime manager to install Node 24
and pnpm 11.15.0. Do not perform a global/root install or change a shared toolchain
without knowing what other projects use it. On CI disposable hosts, the workflow
installs the exact pinned pnpm. Doctor has 5-second command deadlines and gives
specific missing-version/tool/resource results.

Inspect actual architecture with doctor: x64 and arm64 are different targets.
Record free memory/disk before dependency/browser builds. A failed native/binary
dependency on arm64 needs an actual supported build/package, not an x64 download.

## Isolate work before starting servers

Use a dedicated Git worktree for concurrent tasks. Give it its own database,
artifact directory, browser storage and actual reserved/listening ports. Default
development state should live under the checkout's ignored .shiploop-dev directory;
never reuse a running production database or ~/.t3/userdata. Use synthetic seeded
fixtures with enough records to expose non-empty behavior.

Prefer port 0 for test listeners and read the actual bound port. For fixed ports,
check ownership before reuse; a free-port probe alone does not reserve a port.
Track every spawned PID/group, workspace, port and data path. Do not kill by name/path.
Do not symlink live secrets or databases into a test worktree.

## Browser and remote access when the web slice exists

Install the Playwright Chromium version pinned by the app lockfile and required
OS libraries once. Prove a headless browser launch on this VM. Chromium missing,
unsupported CPU or missing shared libraries is a named preflight blocker.

The future pnpm test:e2e must start its own isolated server, wait for bounded ready/
health state, run the acceptance flow, save a failed trace/screenshot, and stop its
owned server in finally. It is not available in the foundation yet.

Test locally inside the VM first. Access from the owner's browser through a normal
SSH port forward to the selected local web port. Configure same-origin HTTP/WebSocket
requests; never bundle a fixed localhost API origin into the remote UI.
Do not expose a development admin interface publicly to avoid setting up a tunnel.
An existing authorized private tunnel is also usable; do not restart T3 to obtain one.

## Keep work alive and recover after SSH disconnect

Use the VM's existing tmux/session service for interactive development. A product
worker eventually runs as its own service and persists jobs; shell backgrounding
alone does not provide durable execution. Do not restart services owned by another task.

On reconnect: inspect Git status, current owned processes, run reports/checkpoints
and provider outcomes. Confirm the previous writer stopped before resuming.
Keep work/untracked files. Restart only the failed owned resource. Follow
[debugging](debugging.md) for bounded retries and [review/release](review-release.md)
before external delivery.
