# ShipLoop

An independent workspace for turning ideas into clarified plans, Linear work,
implemented and verified candidates, and owner-approved delivery.

**Status:** a working vertical slice. The web server and owner UI run and are proven in
a real browser; the coding worker, adapters and required checks are wired into
production composition. Manual owner testing has no UI of its own, a deployment adapter
is not written, and no live provider delivery has been performed. This is not a finished
product and it is not a deployment. [AGENTS.md](AGENTS.md) records exactly what exists.

## Bootstrap on the VM

Use Node 24 and pnpm 11.15.0, as pinned in package.json. Run setup in child processes,
never with `set -e` in the parent SSH shell.

```bash
cd ~/projects/ShipLoop
node scripts/doctor.mjs          # bounded diagnostics; works even if pnpm is broken
pnpm install --frozen-lockfile
```

Use [VM development](docs/runbooks/vm-development.md) if bootstrap fails.

## Verify

```bash
pnpm check        # foundation configuration, documentation links, JavaScript syntax
pnpm test         # domain, storage, adapters, verification, controller and web tests
pnpm verify       # foundation check and tests, with a local evidence report
pnpm build        # build the owner UI into apps/web/dist/client
pnpm verify:app   # foundation + lint + every package typecheck + tests + build + browser E2E
pnpm e2e          # browser E2E alone; needs pnpm build first
```

[TESTING.md](TESTING.md) owns verification selection, the report format and the
criterion coverage matrix. `pnpm verify` and `pnpm verify:app` write private local
reports under `.shiploop-artifacts/`. No command here certifies the MVP or a
production deployment; [acceptance evidence](docs/product/acceptance-evidence.md)
records which criteria are actually proven.

## Run the owner UI for a hands-on look

The shipped entrypoint is `apps/web/src/server/main.ts`. It reads its configuration from
the environment and refuses to start rather than invent a database, a static root or a
CSRF secret. Give it an isolated data directory, an artifact directory and a generated
secret:

```bash
pnpm build    # the server serves apps/web/dist/client

SHIPLOOP_HOST=127.0.0.1 \
SHIPLOOP_PORT=8788 \
SHIPLOOP_NODE_ENV=development \
SHIPLOOP_STATIC_ROOT="$PWD/apps/web/dist/client" \
SHIPLOOP_ARTIFACT_ROOT="$PWD/.shiploop-dev/owner-preview/artifacts" \
SHIPLOOP_DATABASE_PATH="$PWD/.shiploop-dev/owner-preview/data/shiploop.db" \
SHIPLOOP_CONTROLLER_MODULE=@shiploop/controller \
SHIPLOOP_CSRF_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')" \
node apps/web/src/server/main.ts
```

The server binds to `127.0.0.1` only, so it is not reachable until you forward it:

```bash
ssh -L 8788:127.0.0.1:8788 <this-vm>   # the left port is yours to choose; the right must be 8788
# then open http://localhost:8788
```

Exactly one owner can sign in, and it is provisioned once through
`POST /api/owner/provision` with a display name and a password; a second attempt is
refused. Sign-in accepts either that display name or the address derived from it.
ShipLoop never asks a browser to hold a provider credential: configuration names the
*variable* a credential lives in, and a connector stores a reference, never a secret.

Nothing about brief or plan generation, publication, runs or the review card works
without configured providers. With no provider configured those screens refuse by name
rather than reporting a false success, which is the state a fresh preview is in.
`packages/controller/src/providers.ts` is the authority: it names every
`SHIPLOOP_PROVIDER_*` variable, the credential reference each is authorised for, and the
refusal an operation gets when the variable is unset.

## Read before building

- [AGENTS.md](AGENTS.md): agent entry point, and what is and is not implemented.
- [ARCHITECTURE.md](ARCHITECTURE.md): components, state ownership, interfaces, build slices.
- [MVP specification](docs/product/mvp-spec.md): complete feature catalog and acceptance IDs.
- [TESTING.md](TESTING.md): what agents must prove and what the current checks cover.
- [CONTRIBUTING.md](CONTRIBUTING.md): branch and PR workflow.
- [Slice A handoff](docs/handoff/slice-a.md): a worked startup record for the first
  browser-proven slice.
- [Upstream guidance analysis](docs/reference/upstream-guidance.md): patterns adapted from Hermes,
  T3 Code, Codex, and OpenClaw, with pinned sources.
