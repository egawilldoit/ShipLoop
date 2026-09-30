# ADR 0001: Web control plane and persistent VM worker

Status: accepted MVP direction; implementation pending. Date: 2026-09-30.

## Context

One owner manages multiple projects through an SSH VM, Codex and T3 Code.
The system must remain outside app repositories, keep running when the browser closes,
and cost no additional mandatory orchestration subscription.

## Decision

Build a standalone responsive web app plus persistent TypeScript VM worker.
Use pnpm, SQLite on local disk and a named artifact directory for the single-host pilot.
Separate pure lifecycle policy from provider/engine adapters and privileged side effects.
Keep one active coding writer globally. Store project recipes/procedures in ShipLoop.
Use existing tools through validated adapters; provide manual T3 context handoff initially.

## Consequences

A native client, multi-host queue and Postgres are not required for the pilot.
SQLite migrations, backups, restart recovery and confirmed writer ownership are
required. Browser-platform portability does not mean every worker OS is supported.
Real VM/engine/browser feasibility must be proven before enabling live execution.
A second host or measured write contention can justify a later Postgres decision.
