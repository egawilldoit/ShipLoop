/**
 * The contract suite run against the in-memory fakes.
 *
 * These tests prove the harness itself, not just that it is green: that every
 * declared case passes, that case names carry their criterion, that repeated
 * runs observe identical facts, and that a contract violation or an impossible
 * precondition produces a reported failure instead of a silent pass.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runAdapterContractSuite, type ContractCaseResult } from './contract-suite.ts';
import { createFakeAdapterSet, type AdapterSet } from './fake.ts';

function runSuite(): readonly ContractCaseResult[] {
  return runAdapterContractSuite(createFakeAdapterSet(), () => createFakeAdapterSet());
}

function failures(results: readonly ContractCaseResult[]): readonly ContractCaseResult[] {
  return results.filter((result) => !result.passed);
}

function describeAll(results: readonly ContractCaseResult[]): readonly string[] {
  return results.map((result) => `${result.name}: ${result.detail}`);
}

test('every adapter contract case passes against the fakes', () => {
  const results = runSuite();
  assert.ok(results.length >= 9, `the suite declared only ${results.length} cases`);
  assert.deepEqual(describeAll(failures(results)), []);
});

test('each case name leads with the acceptance criterion it enforces', () => {
  for (const result of runSuite()) {
    assert.match(result.name, /^[FN]\d{2}-AC\d\b/, `case name does not lead with a criterion ID: ${result.name}`);
  }
});

test('case names are unique so a new provider cannot double-report one case', () => {
  const names = runSuite().map((result) => result.name);
  assert.equal(new Set(names).size, names.length);
});

test('each case reports a non-empty detail', () => {
  for (const result of runSuite()) {
    assert.ok(result.detail.trim().length > 0, `${result.name} reported no detail`);
  }
});

test('two runs observe identical facts, so no case depends on leftover state or a clock', () => {
  assert.deepEqual(describeAll(runSuite()), describeAll(runSuite()));
});

test('a fresh adapter set starts with no side effects and no access error', () => {
  const adapters = createFakeAdapterSet();
  assert.equal(adapters.effects.count(), 0);
  assert.equal(adapters.git.health().state, 'Healthy');
  assert.deepEqual(adapters.events.appliedDeliveries(), []);
});

test('an adapter that reports malformed output as success fails the F15-AC2 case', () => {
  const results = runAdapterContractSuite(brokenAdapterSet(createFakeAdapterSet()), () =>
    brokenAdapterSet(createFakeAdapterSet()),
  );
  const broken = failures(results).map((result) => result.name);
  assert.ok(
    broken.includes('F15-AC2 malformed engine output does not become a successful completion'),
    `the malformed-output case did not fail against an adapter that reports success: ${broken.join(', ')}`,
  );
});

test('an impossible precondition is reported as a failed case, not a crashed run', () => {
  const results = runAdapterContractSuite(createFakeAdapterSet(), () => {
    const adapters = createFakeAdapterSet();
    adapters.conditions.revokeAccess(adapters.git.connectorId, 'revoked for the precondition probe');
    return adapters;
  });
  const reported = failures(results);
  assert.ok(reported.length > 0, 'a revoked adapter that cannot satisfy the cases still reported a pass');
  for (const result of reported) {
    assert.ok(result.detail.trim().length > 0, `${result.name} failed without a detail`);
  }
});

/**
 * Wraps a working set so the engine adapter claims success for malformed output.
 *
 * Everything else is delegated unchanged, so the only difference between this set
 * and a passing one is the criterion the F15-AC2 case exists to catch.
 */
function brokenAdapterSet(adapters: AdapterSet): AdapterSet {
  return new Proxy(adapters, {
    get(target, property, receiver): unknown {
      if (property === 'engine') {
        return {
          ...adapters.engine,
          parseEventStream(lines: readonly string[]) {
            const parsed = adapters.engine.parseEventStream(lines);
            if (!parsed.ok) return parsed;
            return { ok: true, value: { ...parsed.value, outcome: 'Succeeded', succeeded: true } };
          },
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
