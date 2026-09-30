# ShipLoop

An independent workspace for turning ideas into clarified plans, Linear work,
implemented and verified candidates, and owner-approved delivery.

**Status:** development foundation only. No web app or product worker exists yet.
The product remains outside connected application repositories.

## Start on the VM

Use Node 24 and pnpm 11.15.0, as pinned in package.json.

```bash
node scripts/doctor.mjs
pnpm install --frozen-lockfile
pnpm verify
```

Use [VM development](docs/runbooks/vm-development.md) if bootstrap fails.
Commands run as child processes and leave your interactive SSH shell open on failure.

## Read before building

- [AGENTS.md](AGENTS.md): agent entry point.
- [ARCHITECTURE.md](ARCHITECTURE.md): components, state ownership, interfaces, build slices.
- [MVP specification](docs/product/mvp-spec.md): complete feature catalog and acceptance IDs.
- [TESTING.md](TESTING.md): what agents must prove and what the current checks cover.
- [CONTRIBUTING.md](CONTRIBUTING.md): branch and PR workflow.
- [Upstream guidance analysis](docs/reference/upstream-guidance.md): patterns adapted from Hermes,
  T3 Code, Codex, and OpenClaw, with pinned sources.

`pnpm verify` writes private local reports under `.shiploop-artifacts/`.
`pnpm verify:app` deliberately exits blocked until real application gates exist.
It cannot certify the MVP or a production deployment.
