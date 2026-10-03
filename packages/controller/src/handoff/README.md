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

**Generate the packet (owner-authenticated, `POST` with the contract identity):**

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