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
import { adapterContext } from './fixtures.ts';
import {
  createFakeAdapterSet,
  type AdapterSet,
  type FakeEngineAdapter,
} from './fake.ts';
import type { AdapterContext, EngineEvent, EngineSessionStart } from '../contracts/index.ts';

/** The number of contract cases the suite must keep proving. */
const DECLARED_CASES = 14;

async function runSuite(): Promise<readonly ContractCaseResult[]> {
  return runAdapterContractSuite(createFakeAdapterSet(), () => createFakeAdapterSet());
}

function failures(results: readonly ContractCaseResult[]): readonly ContractCaseResult[] {
  return results.filter((result) => !result.passed);
}

function describeAll(results: readonly ContractCaseResult[]): readonly string[] {
  return results.map((result) => `${result.name}: ${result.detail}`);
}

test('every adapter contract case passes against the fakes', async () => {
  const results = await runSuite();
  assert.equal(results.length, DECLARED_CASES);
  assert.deepEqual(describeAll(failures(results)), []);
});

test('each case name leads with the acceptance criterion it enforces', async () => {
  for (const result of await runSuite()) {
    assert.match(result.name, /^[FN]\d{2}-AC\d\b/, `case name does not lead with a criterion ID: ${result.name}`);
  }
});

test('case names are unique so a new provider cannot double-report one case', async () => {
  const names = (await runSuite()).map((result) => result.name);
  assert.equal(new Set(names).size, names.length);
});

test('each case reports a non-empty detail', async () => {
  for (const result of await runSuite()) {
    assert.ok(result.detail.trim().length > 0, `${result.name} reported no detail`);
  }
});

test('two runs observe identical facts, so no case depends on leftover state or a clock', async () => {
  assert.deepEqual(describeAll(await runSuite()), describeAll(await runSuite()));
});

test('a fresh adapter set starts with no side effects and no access error', async () => {
  const adapters = createFakeAdapterSet();
  assert.equal(adapters.effects.count(), 0);
  assert.equal(adapters.git.health().state, 'Healthy');
  assert.deepEqual(adapters.events.appliedDeliveries(), []);
  const compatibility = await adapters.git.checkCompatibility(adapterContext('op_fresh_compatibility'));
  assert.equal(compatibility.ok && compatibility.value.compatible, true);
});

test('an adapter that reports malformed output as success fails the F15-AC2 case', async () => {
  const results = await runAdapterContractSuite(brokenAdapterSet(createFakeAdapterSet()), () =>
    brokenAdapterSet(createFakeAdapterSet()),
  );
  const broken = failures(results).map((result) => result.name);
  assert.ok(
    broken.includes('F15-AC2 malformed engine output does not become a successful completion'),
    `the malformed-output case did not fail against an adapter that reports success: ${broken.join(', ')}`,
  );
});

test('an impossible precondition is reported as a failed case, not a crashed run', async () => {
  const results = await runAdapterContractSuite(createFakeAdapterSet(), () => {
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
 * and a passing one is the translation the F15-AC2 case exists to catch: a
 * provider that says "malformed" is translated into "succeeded".
 */
function brokenAdapterSet(adapters: AdapterSet): AdapterSet {
  return new Proxy(adapters, {
    get(target, property, receiver): unknown {
      const member: unknown = Reflect.get(target, property, receiver);
      if (property !== 'engine' || typeof member !== 'object' || member === null) return member;
      return new Proxy(member as FakeEngineAdapter, {
        get(engineTarget, engineProperty, engineReceiver): unknown {
          if (engineProperty !== 'translateNativeOutput') {
            return Reflect.get(engineTarget, engineProperty, engineReceiver);
          }
          return (
            context: AdapterContext,
            lines: readonly string[],
            start: EngineSessionStart,
          ): EngineEvent[] => {
            const events: EngineEvent[] = Reflect.get(engineTarget, engineProperty, engineReceiver)(
              context,
              lines,
              start,
            ) as EngineEvent[];
            return [
              ...events,
              {
                kind: 'Result',
                at: context.clock.now(),
                outcome: { kind: 'Succeeded', summary: 'The provider reported success for unparseable output.' },
              },
            ];
          };
        },
      });
    },
  });
}
