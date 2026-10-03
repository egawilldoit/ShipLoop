# MVP owner surfaces

The four surfaces the MVP ships: **Home**, **New Request**, **Review**, **Settings**, plus the two
that hang off a contract — the Delivery Contract and the handoff.

Navigation is four tabs. The nine sections the product used to expose (profiles, connectors, intake,
brief, runs, review card, dashboard, plan, publication) are **not deleted**: each still has browser
evidence behind it, and deleting a page while its spec stayed would turn a green suite into a claim
about work nobody ran. They are reachable only by address (`#/legacy/<section>`) and mounted from
`MvpSurface.tsx`. See [INTEGRATION.md](INTEGRATION.md) for the hazards that creates.

## What is here

| Path | What it owns |
| --- | --- |
| `navigation.ts` | Which surface the browser is on, and how it is written down. The single place a surface is named. |
| `wire.ts` | Every wire shape, as an assumption about a backend being built in parallel. No behaviour. |
| `client.ts` | The endpoint calls, one function each. Borrows `api-client.ts`'s transport rather than forking it. |
| `home.ts` | Home's grouping rules: which durable fact puts a request in which bucket. |
| `contract.ts` | The Delivery Contract's editable shape, its validation, and when a save makes a new revision. |
| `sha.ts` | Full-commit-SHA identity, and the sentence that says why. |
| `review-view.ts` | Words, tones and enabled controls for the Review surface. |
| `request.ts` | The one derivation the owner does not type: the request title. |
| `pages/` | One component per surface. |
| `components/` | The shared state line, panel, SHA and the two repeating editors. |

Everything in the four non-`pages` modules is pure and has a `.test.ts` beside it, run by
`node scripts/run-tests.mjs`. The rules that carry the product — how Home buckets a request, when a
save makes a revision, when Accept is offered, what a commit identity is — are functions with names
and assertions rather than conditions inside JSX, because they are the claims a reviewer needs to
check and a branch coverage number is not one.

## The rules these modules exist to hold

Each of these is a place where the plausible implementation misleads, so each is a named function
with a test rather than an inline condition.

- **`home.ts` — no inferred external progress.** External execution happens outside ShipLoop, so this
  product observes nothing about whether an implementation is being worked on. An approved contract
  with no linked candidate therefore sits in **Needs you**, not **In progress**: it is
  indistinguishable from an agent mid-edit, and putting it in a progress bucket would report a fact
  nobody observed.
- **`contract.ts` — an approved contract never silently mutates.** `saveIntent` decides whether a save
  edits the revision in place or records a new one, from the revision's status and whether the
  content changed. The server applies it; this states it and tests it.
- **`sha.ts` — a candidate is a commit, not a branch.** An abbreviated SHA is refused by name, and a
  branch name is refused differently, because "the SHA is wrong" sends an owner looking for a typo
  they never made.
- **`review-view.ts` — `verified` is not `accepted`.** Accept is offered on the server's own
  `verification.complete` and nothing else. Every refusal is a sentence, because a disabled control
  is not an explanation.
- **`client.ts` / `review-view.ts` — the client cannot manufacture evidence.** An owner observation is
  an observation with an environment attached, never a verdict. There is no request this client can
  send that asserts a criterion passed.

## Testing

- **Unit** — `node scripts/run-tests.mjs`. Covers the grouping, revision, identity, availability and
  routing rules.
- **Browser** — `apps/web/e2e/mvp-journey.spec.ts` drives the whole journey in real Chromium against
  the shipped `src/server/main.ts`, with only the eleven MVP endpoints substituted
  (`apps/web/e2e/mvp-contract-server.ts`). That substitution is stated in both files: it is proof of
  the browser client, and **not** evidence for the backend.
- The retired surfaces are driven from their own specs through `e2e/legacy-nav.ts`.