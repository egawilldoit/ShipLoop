# ADR 0002: Lean web runtime on a two-core VM

Status: accepted. Date: 30 September 30 2026. Supersedes the framework preference
in [ARCHITECTURE.md](../../ARCHITECTURE.md) section "Deployment and responsibilities".

## Context

[ARCHITECTURE.md](../../ARCHITECTURE.md) and mvp-spec 7 prefer React/Next.js for the
web app and suggest a TypeScript monorepo. The feasibility report
([wave0](../evidence/2026-09-30-wave0-vm-feasibility.md)) measured the actual
pilot host: 2 × Neoverse-N1 cores, 11.9 GiB RAM with no swap, 58 GiB free disk.

On that host the worker, the API, the test suite and a headless Chromium must all
share two cores. Next.js was rejected for three measured reasons:

- Its production build is a large multi-pass bundling job. Every iteration pays it,
  and it competes with the worker for both cores.
- Its development server adds a second long-lived process that must stay
  responsive while the worker runs attempts and Playwright drives a browser.
- Its dependency set is the largest single contributor to install time and disk on
  an already constrained host, and its framework-specific conventions (server
  components, route handlers, build caching) obscure the layer boundary that
  ARCHITECTURE.md actually requires.

None of these are arguments against Next.js on a larger host. They are arguments
about this host.

## Decision

Build the web app as a Vite-built React single-page app served by a Fastify HTTP
API, in the same Node process. Keep the seven package boundaries from
ARCHITECTURE.md unchanged: `domain`, `storage`, `adapters`, `controller`,
`verification`, `apps/web`, `apps/worker`.

TypeScript is executed directly by Node 24, which strips types natively, and unit
and integration tests use the built-in `node:test` runner. This removes the test
runner and TypeScript execution dependencies entirely. `tsc --noEmit` remains the
typecheck gate.

Additional consequences of the measured host:

- Storage uses `node:sqlite`, not a native module, so no ARM64 prebuild or
  `node-gyp` toolchain is needed.
- Playwright is pinned to the version whose bundled Chromium revision already
  exists on the host, so browser setup requires no download and the tested binary
  is the one that runs.

## Consequences

The owner UI is a client-rendered SPA behind an authenticated same-origin API, so
every read that matters is an authenticated API call. This suits a private
single-owner tool and keeps the CSRF and session boundary in one place.

Server-rendered first paint and SEO are not goals for a private owner tool and are
not traded away for anything user-visible.

The layer boundaries that ARCHITECTURE.md cares about are enforced by module
import direction rather than by framework conventions, so the framework choice is
reversible. If a future host makes the build cost acceptable, the React app and
the Fastify controller can be hosted behind Next.js without touching `domain`,
`storage` or `adapters`.
