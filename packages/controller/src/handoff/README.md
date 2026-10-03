# External-execution handoff

What an implementer outside ShipLoop is told, and where the external T3 deployment is
configured to be opened. Two modules, both exported from `@shiploop/controller`.

| File | What it owns |
| --- | --- |
| `implementation-packet.ts` | `generateImplementationPacket`: deterministic Markdown rendered from one approved Delivery Contract |
| `t3-launch.ts` | `resolveT3Launch` / `parseT3LaunchUrl`: the optional `SHIPLOOP_T3_URL` lookup |

External execution is outside ShipLoop (mvp-spec L02, ARCHITECTURE "T3 Code initially
receives a context packet/manual handoff"). Nothing here opens a session, calls a T3
API, reads a thread, or creates work. The only supported T3 interface in the MVP is a
URL a human opens and a text block they paste; the "direct session integration" of
L02-AC1 is still an open question about the owner's deployed version.

## What the packet is, and what it is not

`generateImplementationPacket(handoff)` returns
`Result<ImplementationPacket, DomainError>`, where `ImplementationPacket` is
`{ contractId, contractRevision, markdown, fingerprint }`.

`markdown` is byte-identical for the same `handoff`. There is no clock, no randomness,
no ambient configuration and no property-order dependence, so two packets can be
compared instead of trusted, and `fingerprint` is a stable digest of the document
(`fp_<32 hex>`) for that comparison.

The packet **describes** work. It never claims a session exists, that an agent ran, or
that anything was completed, verified, accepted, merged or deployed. Those words
belong to the owner, in ShipLoop, against an exact candidate SHA.

## How the owner UI is expected to call it

`apps/web` owns the transport, the clipboard and the `Open T3` button. The controller
owns the text. The browser must not assemble packet content itself, or the redaction
guarantee would belong to the UI.

**The shipped route.** `GET /api/projects/:projectId/contracts/:contractId/:revision/handoff`
(`apps/web/src/server/routes/handoff.ts`, registered in `app.ts`) answers with the
contract identity, the packet, and the optional T3 state:

```jsonc
{
  "handoff": {
    "contractId": "…",
    "revision": 1,
    "packet": { "markdown": "# ShipLoop implementation handoff\n…", "fingerprint": "fp_…" },
    "t3": { "state": "NotConfigured", "reason": "…", "prerequisites": [ … ] }
  }
}
```

`GET` rather than `POST`: nothing is written and nothing is decided here, so one approved
contract renders one document and a client may read the handoff twice and compare the
fingerprints instead of trusting either. The revision must be **approved** — a draft or a
retired approval is a 422 `Blocked` naming the approval as the remedy, and no packet is
rendered for either. The project travels in the path and the controller re-checks it
against the session, so a revision in another project is a 404 rather than a read.

`markdown` is carried as JSON-encoded text and is byte-identical to what
`generateImplementationPacket` produced; nothing in the transport reformats it. `t3` is
one of three states: `Configured` (with the configured URL), `NotConfigured` (the normal
case — the packet is complete without T3), or `Unusable` (a configured value that is
refused, reported with its remedy and never reproducing the value).

`handoff.ts` is what that route reaches. It reads the gated, project-scoped contract, the
project, its request and its current profile, refuses anything that is not an approved
revision, renders the packet through `generateImplementationPacket`, and resolves the
operator's `SHIPLOOP_T3_URL` through `parseT3LaunchUrl`. It contacts nothing.

Two shapes differ between the stored contract and this directory's contract type, and both
are the caller's business rather than the renderer's: `repository` and `defaultBranch` come
from the project's current profile (`references.repository` and `references.targetBranch`,
null when no profile is saved, so the packet states the absence), and the stored `scope` is
a list of statements while the packet states one block of scope — `handoff.ts` joins the
list with a line break so the order the owner wrote is the order the implementer reads.

**Generate the packet directly** (owner-authenticated, with the contract identity):

```ts
import { generateImplementationPacket } from '@shiploop/controller';

const result = generateImplementationPacket({
  project: {
    id: project.id,
    name: project.name,
    repository: project.repository ?? null,
    defaultBranch: project.defaultBranch ?? null,
  },
  request: { id: request.id, title: request.title, description: request.description },
  contract: {
    id: contract.id,
    revision: contract.revision,
    // Narrowed at the boundary: generateImplementationPacket refuses anything else,
    // so a draft or stale contract must not reach it.
    status: 'approved',
    approvedAt: contract.approvedAt,
    outcome: contract.outcome,
    scope: contract.scope,
    outOfScope: contract.outOfScope,
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      verificationType: criterion.verificationType, // 'automated' | 'owner_test'
    })),
  },
  procedureReferences: currentProcedureSubjects, // already-stored references only
});

if (!result.ok) return result; // DomainError: Invalid with every gap named, or nothing
return { markdown: result.value.markdown, fingerprint: result.value.fingerprint };
```

Two invariants for the transport: return `markdown` as `text/plain` (or JSON-encoded
text) so the clipboard receives exactly these bytes, and never log it — the packet is
already redacted, but it is still a private description of unreleased work.

**Copy it:** `navigator.clipboard.writeText(markdown)` in the UI. The clipboard is
browser behaviour; the backend has no part in it.

**Open T3:** resolve the target server-side and hand the browser the URL.

```ts
import { resolveT3Launch } from '@shiploop/controller';

const launch = resolveT3Launch(process.env);
// ok  -> { url }                       open it, and only that
// err -> DomainError code 'Blocked'     render reason + prerequisites[0].remedy
```

`Open T3` with no `SHIPLOOP_T3_URL` is a `Blocked` error naming the variable and its
remedy; it is never a default URL, and it is not an error for the packet, which works
without T3. A malformed, non-HTTP(S) or credential-bearing URL is also `Blocked`, and
the message never echoes the configured value.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `SHIPLOOP_T3_URL` | no | Base URL of the owner's T3 deployment, `http` or `https`, no credentials |

There is no default and no hostname in the source. A deployment that does not use T3
leaves it unset; the Request → Contract → PR → Verify → Review journey does not depend
on it.

**Precedence, unresolved.** Project-scoped settings store an optional T3 launch URL per
project, and a stored project setting is the more specific fact: it should win over this
environment default for a project that has one. `resolveSurfaceRoot` reads
`SHIPLOOP_T3_URL` and hands it to the composition root, and the stored setting is not
reachable from this branch, so the environment value is what the handoff reports today.
When the two are joined, the rule to implement is *stored project setting first, this
variable as the fallback* — and a project with no stored setting must still report
`NotConfigured` when the variable is unset, rather than a new failure mode.

## What the tests prove

`implementation-packet.test.ts`

- byte-identical output for the same contract, and identical output after mutating
  `process.env`, `TZ` and the clock mid-process — the renderer reads nothing ambient;
- the contract id, revision, project, request, outcome, scope, every out-of-scope item
  and every acceptance criterion appear, in the contract's order;
- a revision change is visible in the text and in the fingerprint;
- an unrecorded repository, branch, description or procedure list is stated as an
  absence instead of being omitted or invented;
- a stored markdown heading renders as text, not as structure in the packet;
- the branch/PR/merge/deploy/acceptance instructions are present verbatim, and contract
  content cannot edit them away;
- no phrase claims a session, an agent, or completed work;
- every seeded credential class planted in each rendered field is replaced by its
  labelled placeholder, a credential-bearing URL and a database URL lose their
  user:pass portion, and a clean packet is untouched;
- a draft, a stale contract, a bad revision, an empty or duplicated criterion set, an
  unknown verification type, a blank required field, a structured identifier and an
  unparseable approval instant are each refused with the field named.

`t3-launch.test.ts`

- an unset, empty or blank `SHIPLOOP_T3_URL` is refused with a remedy, and the packet is
  still generated;
- a malformed URL and any non-HTTP(S) scheme are refused;
- a URL carrying credentials is refused, and no refusal reproduces the configured value;
- a configured URL resolves to exactly what the operator wrote, with nothing appended;
- an unset configuration resolves to nothing, proving there is no built-in host.

`handoff.test.ts` (this directory)

- an approved revision renders exactly the bytes `generateImplementationPacket` produces for
  the stored project facts, and the fingerprint is the digest of those bytes;
- a project with no saved profile states the absence instead of inventing a repository;
- a draft and a retired approval are both refused with the approval remedy, and an approved
  revision carrying no approval instant is refused rather than rendered;
- a caller who may not act learns nothing and **no second read happens** — the counters
  prove authorization is decided before any row is read;
- a revision in another project, and a project row this store does not hold, are both
  refused;
- `NotConfigured`, `Configured` and `Unusable` are distinguishable, a blank value is
  `NotConfigured`, and a refused value is never reproduced;
- the packet states that no procedure references are stored rather than omitting the section.

`apps/web/src/server/routes/handoff.test.ts`

- the same rules over HTTP against a real migrated store and the real controller, because a
  double cannot prove that the bytes on the wire are the generator's bytes;
- the response carries only `contractId`, `revision`, `packet` and `t3`, so it cannot be read
  as an execution status, and two reads of one approved revision carry one fingerprint.