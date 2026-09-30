# Storage contract rulings

Date: 30 September 2026. Author: orchestrator. These resolve four conflicts that
blocked the storage alignment unit. Each ruling follows from a specification
requirement, so none of them needs a new product decision.

## R1 — Publication intent is one concept, not two

The schema CHECK allowed `('Unpublished','DraftPublish','Published','Adopted')` and
the repository type used `('DoNotPublish','PublishWhenAgreed','Published')`. The two
vocabularies are disjoint, and neither is wrong on its own: the repository records
what the owner DECIDED, and the schema recorded what the provider CONFIRMED.

That is exactly the distinction the specification requires. F10-AC1 says issues are
created only after the owner selects Create tickets, and F12-AC5 forbids treating an
external status as ShipLoop's own conclusion.

Ruling: **one `publication_intent` column carries the owner's decision**, using
`('DoNotPublish','PublishWhenAgreed','Published')`. The provider-observed state is a
separate `publication_state` column using the repository's existing `PublicationState`
(`Unpublished | Publishing | Published | OutcomeUnknown | NotPublishing`). Drop
`DraftPublish` and `Adopted` from the intent vocabulary: `Adopted` is an origin, not an
intent, and `origin` already carries `('Proposed','Published','Adopted')`.

## R2 — `owners.identity_subject` becomes nullable

`provision()` receives no identity provider subject, and F01 specifies a single
provisioned owner signing in with a password. The column describes an optional
external identity link that this MVP does not use.

Ruling: make `identity_subject` nullable. Keep the unique index so a future
external identity cannot be attached twice. Do NOT write `ownerId` into it as a
substitute — that fudge makes the column lie about what it holds.

## R3 — Acceptance has no authorization subject, so the column is nullable

`owner_decisions.subject_fingerprint` was NOT NULL, but an ACCEPTANCE decision has no
authorized action to fingerprint; only an AUTHORIZATION does.

Ruling: make `subject_fingerprint` nullable, and add a CHECK that it is NOT NULL
exactly when `decision_type` is an authorization. This is stricter than before in the
direction that matters: the schema now enforces that an authorization can never lack a
bound subject (F26-AC1, F27-AC3), while still permitting an acceptance.

`owner_decisions.actor_owner_id` must be a real foreign key to `owners(owner_id)`.
Replace the free-text `actor` column with it. Owner decisions are attributable
(F32-AC1), so an un-attributable decision is not representable.

## R4 — Decompose candidate and evidence identity; keep jobs' foreign keys

The schema stores candidate identity as decomposed, CHECK-constrained columns
(`head_sha`, `base_sha`, `environment_fingerprint`, ...) while the repositories stored
a JSON blob; and `owner_decisions` used a free-text `actor`. A JSON blob cannot be
CHECKed, so the schema's real protection was being bypassed.

Ruling: **decompose.** The repositories must write the individual columns and read
them back into the domain `CandidateIdentity`. The commit-SHA CHECK (length 40 or 64,
lowercase hex) is the guarantee that an abbreviated SHA can never enter a candidate,
and it only works if the repository writes the real column.

For `jobs`: the schema requires `work_item_id`, `profile_version_id` and
`procedure_version_id` NOT NULL, and `EnqueueRequest` carries none of them. That is
correct on both sides — F13-AC1 requires a job to record the scope snapshot, project,
versions and limits before returning success. The ruling is to **extend
`EnqueueRequest`** with `workItemId`, `profileVersionId` and `procedureVersionId`, not
to relax the schema.

## R5 — `jobs.state` uses the domain `AttemptState` vocabulary

The schema allowed 9 values including `Claimed` and `Failed`; the domain defines 9
`AttemptState` values including `Preparing` and `Blocked` and excluding `Claimed`
and `Failed`. Two vocabularies for one field is the defect class this project keeps
eliminating.

Ruling: `jobs.state` CHECK must equal the domain `ATTEMPT_STATES` exactly — `Queued`,
`Preparing`, `Running`, `Verifying`, `WaitingForOwner`, `Paused`, `Blocked`,
`Completed`, `Cancelled`. `Claimed` is a lease fact, not an attempt state: it belongs
on the lease row, which already records the holder. `Failed` is an attempt outcome
recorded in the attempt record and the failure category, not a job state.

Derive the list from the domain array in `migrations.ts` so a new state cannot be
accepted by a fresh database and rejected by an already-migrated one.

## Non-negotiable

Do not relax any CHECK constraint, trigger, unique index or foreign key to make a
repository work. If an invariant genuinely cannot be expressed, report it here rather
than dropping it. Every one of these rulings exists to make the schema's protections
real rather than nominal.
