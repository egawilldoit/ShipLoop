# Contributing to ShipLoop

Read [AGENTS.md](AGENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), and the applicable
[MVP criteria](docs/product/mvp-spec.md). The current app is not implemented.
Use Node 24 and the pinned pnpm 11.15.0. Preserve packageManager and the lockfile.

## Implementation workflow

1. Inspect current Git state and existing scope. Use a feature branch/worktree.
2. Write a brief statement of observable behavior and applicable criterion IDs in
   the task or PR; no duplicate repo backlog is needed.
3. Implement the smallest coherent slice with focused behavior/regression tests.
4. Run applicable [verification](TESTING.md). UI changes require browser evidence;
   controller/provider changes require boundary tests and named integration limits.
5. Review the diff for missed callers, contract changes, secrets and generated drift.
6. Publish a draft PR with the problem, resulting behavior, checks and gaps.
   Use a Conventional Commit title and stage only intended files.
7. Resolve applicable review findings, update evidence after changes, and leave a
   clear next action. Follow [review/release](docs/runbooks/review-release.md).

Normal scoped implementation/testing/fixes continue without per-step approval.
Owner authorization is required for merge/release and material scope expansion.
No force push, destructive cleanup, or shared-service restart as routine recovery.

CI initially validates this foundation on Linux. It is not an application release gate.
As app slices arrive, add real required checks and test fixtures to verification.json
in the same change. Do not add passing placeholder scripts.
