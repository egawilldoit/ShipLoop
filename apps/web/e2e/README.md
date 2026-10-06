# Browser suite

Two specs remain: `smoke.spec.ts` and `auth-boundary.spec.ts`.

## What was retired, and what it cost

`intake.spec.ts`, `planning.spec.ts`, `review-card.spec.ts` and `runs.spec.ts` drove the
legacy orchestration screens — Intake, Brief, Plan, Publication, Runs and the run-based
Review card — by clicking their buttons in the primary navigation.

The M1 product's primary navigation is Home / New Request / Review / Settings. Eight of
the nine sections the shell used to offer were surfaces for orchestrating a coding agent,
which is outside ShipLoop's boundary, so those screens are no longer what the owner is
shown. The legacy pages remain in the tree at `apps/web/src/ui/pages/` and still compile;
they are simply not reachable from primary navigation.

**The coverage this cost, stated plainly:** those four specs were the *only* browser-level
coverage of the `intake`, `planning` and `runs` HTTP routes. No server-side test drives
those three route modules. Retiring the specs therefore leaves those routes without
browser proof, and that gap is real.

It is recorded here rather than left to be discovered because the routes are still
registered and still answer. The follow-up this implies is a decision, not an oversight:
either those routes are removed as stale surfaces, or they keep browser coverage written
against HTTP directly rather than through navigation that no longer exists.

The M1 product's own HTTP surface is fully covered without them —
`candidates.surface.test.ts`, `handoff.test.ts`, `home.test.ts`, `review.test.ts`,
`review.invariants.test.ts`, `settings.test.ts`, `verification.chain.test.ts` and
`verification.test.ts` at the server layer, and the two surviving specs in the browser.
