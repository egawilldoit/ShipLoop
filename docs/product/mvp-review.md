# MVP review contract: verification, evidence and the owner decision

This document is the interface contract for the minimal MVP review path. It states what
consumers get, what the product guarantees, and what an integrator must satisfy. It does
not restate the specification; [mvp-spec](mvp-spec.md) owns acceptance criteria and
[ARCHITECTURE](../../ARCHITECTURE.md) owns system boundaries.

Where this document and an implementation disagree, the implementation is wrong and this
document is the defect to file against.

## The journey this path serves

`Request → Delivery Contract → External execution → GitHub candidate → Verification → Owner decision`

External execution is outside ShipLoop. This path starts at a linked candidate and ends at
an owner Accept or Request Changes. It ends there: nothing here merges or deploys.

## The five product invariants this path enforces

Each is enforced by a type or a comparison, not by a comment:

| Invariant | Mechanism |
| --- | --- |
| `agent completed` is not `verified` | `MvpEvidenceObservation` has no member carrying a claimed verdict; `CriterionState` is reached only through `deriveCriterionState` |
| `verified` is not `accepted` | `recordMvpOwnerDecision` requires an `MvpOwnerActor`; the non-owner variants carry no `ownerId` |
| `accepted` is not `merged` | `MvpEligibility.readyForDelivery` requires an applicable acceptance; nothing in this path merges |
| evidence for SHA A cannot prove SHA B | `bindingAppliesTo` compares the full `candidateHeadSha` and `contractRevision`; a mismatch is `stale`, and `stale` is never a pass |
| a change of candidate invalidates prior acceptance | `decisionAppliesTo` reuses the same comparison, so an acceptance becomes inapplicable rather than merely old |

## Criterion states

`packages/domain/src/review/criterion.ts`

```ts
type CriterionState = 'passed' | 'failed' | 'pending' | 'stale' | 'unverified';
type MvpVerificationType = 'automated' | 'owner_test';
```

| State | Meaning |
| --- | --- |
| `passed` | A current, applicable observation, recorded with the criterion's assigned method, supports the criterion |
| `failed` | A current observation says the behaviour is wrong |
| `pending` | The owner owns a step nobody has run, or a verification is still running |
| `stale` | The observation exists but was made against another commit or another contract revision |
| `unverified` | Nothing observed it, or the capture itself failed |

Derivation precedence is fixed and each step is a refusal to reach `passed` earlier:

1. stale binding → `stale`, whatever the outcome says;
2. no observation → `pending` for an owner test, `unverified` otherwise;
3. an automated result on an owner-test criterion → `pending`;
4. an owner test on an automated criterion → `unverified`;
5. a method mismatch, including a different check identity → `unverified`;
6. otherwise the outcome speaks, with `capture_failed` kept distinct from `failed`.

**An automated criterion names the check that verifies it.** `MvpContractCriterionView.verificationCheckId`
is required for that link and may not be inferred from whichever check passed.

## Evidence binding

`packages/domain/src/review/evidence.ts`

```ts
interface MvpEvidenceBinding {
  contractId: string;
  contractRevision: number;      // positive integer
  candidateId: string;
  candidateHeadSha: CommitSha;   // full 40 or 64 lowercase hex; nothing else is accepted
  subject: { kind: 'criterion'; criterionId: string } | { kind: 'check'; checkId: string };
  method: CriterionVerificationMethod;
  observedAt: string;            // ISO-8601 instant
}
```

`recordMvpEvidence` is the only constructor. It refuses an abbreviated SHA, an undated
candidate-bound result, and a subject that disagrees with the observation kind: a command or
provider result describes a check, a browser capture or an owner test describes a criterion.

An observation the source could not attribute is still recordable. It lands with
`binding: null` and reads `stale` everywhere, which is different from refusing it at the
boundary — a source that cannot name the commit produced a fact worth keeping.

## Verification sources

`packages/verification/src/mvp-sources.ts`

There is one command runner in the repository. Configured project commands and configured
Playwright invocations both go through `runCheck` from `./checks.ts`; no second runner
exists in this path.

| Source | Entry point | Subject | What binds it |
| --- | --- | --- | --- |
| Configured project command | `recordProjectCommand` | check | the identity the check ran under |
| Configured browser command | `recordBrowserCommand` | criterion | the identity the check ran under |
| GitHub check projection | `recordGitHubProjection` | check | the projection's `headSha`, only when it equals the candidate's |
| Owner test | `recordOwnerTestEvidence` | criterion | the candidate SHA, plus the authenticated owner |

### The projection interface the candidate module must supply

The candidate module owns fetching and refresh. This path consumes a projection and binds
it. `GitHubCandidateProjection`:

```ts
interface GitHubCheckProjection {
  checkId: string;                              // profile-visible check name
  name: string;
  status: 'success' | 'failure' | 'pending' | 'skipped' | 'neutral';
  headSha: string | null;                       // full SHA the run belongs to, or null
  startedAt: string | null;
  completedAt: string | null;
  detailUrl: string | null;
  summary: string | null;
}

interface GitHubCandidateProjection {
  candidateId: string;
  contractId: string;
  contractRevision: number;
  headSha: string;                              // the candidate's full SHA
  checks: readonly GitHubCheckProjection[];
  observedAt: string;
}
```

Two obligations on the producer:

1. `headSha` is the full 40-character SHA the run belongs to. A run attributed to another
   commit must arrive with `headSha: null`, never with the candidate's SHA. Filling it in
   defeats the staleness comparison this path depends on.
2. `status` is the provider's raw verdict. `skipped` and `neutral` become `missing`, not
   `passed`; normalising them to `success` in the adapter is the bug this interface exists
   to prevent.

## The three gates

`MvpEligibility`, computed by `buildMvpReviewReadModel`:

| Gate | Requires |
| --- | --- |
| `readyForOwnerReview` | Every required automated check reads `passed` against the current candidate. A pending owner test is offered as an owner action, not a blocker |
| `readyForAcceptance` | The above, plus every criterion `passed`, owner tests included |
| `readyForDelivery` | The above, plus the delivery-only checks, plus an applicable acceptance |

`acceptanceBlockers` and `deliveryBlockers` name what stands in the way. A gate that only
reported a count would leave the owner unable to act.

## Owner decisions

`packages/domain/src/review/decision.ts`

```ts
recordMvpOwnerDecision({
  decisionId, kind: 'accepted' | 'changes_requested',
  actor: MvpOwnerActor,
  projectId, requestId, contractId, contractRevision,
  candidateId, candidateHeadSha,   // full SHA, required
  decidedAt,                       // ISO-8601, supplied by the caller
  feedback,                        // null is allowed; '' is not
})
```

Order of enforcement: the actor is refused first, so a non-owner learns nothing about the
candidate from the refusal. Then the full SHA, then the revision, then the timestamp.
Feedback is redacted before it is recorded.

`governingMvpDecision` returns the decision that applies to the current candidate and,
separately, the ones a push invalidated. A newer change request outranks an older
acceptance; a later acceptance supersedes an earlier change request.

## The read model

`packages/domain/src/review/readiness.ts` — one projection, computed once, from facts.

```ts
interface MvpReviewReadModel {
  request: MvpRequestView;      // id, projectId, title, description, createdAt, updatedAt
  contract: MvpContractView;    // id, projectId, requestId, revision, outcome, scope,
                                // outOfScope[], acceptanceCriteria[], status, approvedAt, ...
  candidate: MvpCandidateView;  // id, projectId, requestId, contractId, contractRevision,
                                // repository, pullRequestNumber, pullRequestUrl,
                                // baseBranch, headSha, observedAt
  policy: MvpVerificationPolicy;
  checks: MvpCheckView[];       // checkId, required, result, blocking, evidenceId, source, reason
  criteria: MvpCriterionResultView[]; // criterionId, description, verificationType, state,
                                       // method, evidenceId, observedAt, reason
  evidence: MvpEvidenceView[];  // evidenceId, source, criterionId, checkId, method, outcome,
                                // currentOutcome, appliesToCurrentCandidate, staleReasons,
                                // reason, observedAt, candidateHeadSha, contractRevision, detail
  staleness: MvpStaleView;      // stale, reasons[], staleEvidenceIds[], staleDecisionIds[]
  decision: MvpDecisionView;    // outcome, decision, staleDecisions[], authorizesCurrentCandidate
  eligibility: MvpEligibility;
}
```

Read `currentOutcome`, not `outcome`, on an evidence row: `outcome` is what the source said
and stays `passed` after a push; `currentOutcome` is `stale` once the binding no longer
holds. The read model sorts observations newest-first internally, so the caller's array
order never decides which observation counts.

A non-approved contract is refused, and a candidate bound to a different contract revision
is a `Conflict` naming both.

## Persistence

Migration **13 `mvp_review_bindings`**, in `packages/storage/src/migrations.ts`.

Two append-only tables, `mvp_review_evidence` and `mvp_owner_decisions`, both carrying
`candidate_head_sha` CHECKed to a full 40/64 hex SHA and `contract_revision`. Evidence
carries `observed_head_sha` and `observed_contract_revision`, nullable together, for an
observation a source could not attribute. An `owner_test` row requires `owner_id`.

`SqliteMvpReviewStore` (`packages/storage/src/repositories/mvp-review.ts`) writes only what
the domain constructors already accepted and rebuilds every read through those same
constructors, so a row this build cannot reconstruct is reported rather than dropped.

## What an integrator must satisfy

1. **Candidate identity.** Supply a full 40-character `headSha` for every candidate. A
   branch name or PR number is not identity and the domain will refuse it.
2. **Contract criteria.** Every automated criterion needs `verificationCheckId` naming a
   check that exists in the policy. An automated criterion without one stays `unverified`,
   which is correct: nothing bound to it.
3. **Policy.** `MvpVerificationPolicy.requiredAutomatedCheckIds` is the gate list.
   `ownerTestBlocksReview` defaults false and `ownerTestBlocksDelivery` true, which is
   F24-AC3 read as configuration.
4. **The GitHub projection.** Per the two obligations above.
5. **Not stale reads.** A review submission must carry `expectedHeadSha` and
   `expectedContractRevision`. `MvpReviewUseCases` refuses a mismatch with a typed
   `Conflict` before any write.
6. **Actions.** Offer Accept only when `eligibility.readyForAcceptance`, Request Changes
   always, and render `eligibility.ownerActions` as the owner's own steps. Never render a
   pending owner test as anything else.