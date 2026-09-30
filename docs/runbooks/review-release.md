# Review, merge and release

This file covers development of ShipLoop and the behavior its future controller
must implement. No merge/release automation exists in this foundation.

## Draft and review

Link task/spec criterion IDs where applicable. Keep a PR focused. Describe observable
behavior, verification commands/results, platform, sanitized evidence and unrun checks.
Review affected callers, boundary contracts, cleanup and migration/recovery paths.
A fresh agent review is useful but is not owner acceptance or independent human approval.

CI and local proof must refer to the proposed revision. When code, base, scope,
environment or deployment identity changes, refresh affected evidence. Keep failures
visible and repair their causes. Do not disable a gate to make a PR appear green.

## Merge checklist after owner authorization

1. Identify the authorized full head/base, scope and delivery destination.
2. Fetch current PR refs, mergeability, required checks/reviews and rules.
3. Reject stale authorization or unmet required gates; do not override provider rules.
4. Merge using expected-head protection when available. Record the actual merge result.
5. If a response is missing/timeout, reconcile actual provider state before retrying.
6. Confirm the remote merge result before cleanup or marking the work merged.

If merging automatically deploys production, owner authorization must cover that
delivery before the merge. Acceptance and merge permission are distinct decisions.
A pre-existing failing required check does not silently become optional.

## Release and recovery

Verify the deployment/artifact belongs to the intended merged candidate and environment.
Run configured live smoke checks; record provider IDs, commit identities, observed
result and release receipt. A preview URL alone is not release proof.

When release fails or its outcome is unknown, retain evidence and previous healthy
deployment identity. Propose a concrete recovery action for owner authorization.
Code rollback/redeploy does not automatically reverse database migrations. No blind
repeat deploy, schema downgrade, or deletion of live state.

Clean only task-owned processes/worktrees after remote results are confirmed and
work is committed/preserved. Do not delete another task's checkout or live state.
