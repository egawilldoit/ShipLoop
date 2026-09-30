/**
 * Deterministic adapter test support.
 *
 * Exported so any package writing a provider adapter can run the same contract
 * cases without copying them, and so the orchestrator can re-export this
 * subpath from the package root.
 */

export * from './fixtures.ts';
export * from './fake.ts';
export * from './contract-suite.ts';
