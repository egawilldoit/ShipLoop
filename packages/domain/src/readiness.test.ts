import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  analyzeDependencies,
  dependencyAvailable,
  deriveReadiness,
  type DependencyNode,
  type ReadinessArea,
  type ReadinessFinding,
  type ReadinessStatus,
} from './readiness.ts';

/**
 * Readiness is a recorded assessment, not a confidence score: Unmet blocks,
 * Unknown asks a question, and nothing else is invented. Dependencies are checked
 * before readiness because a cycle or an unresolved edge must never be laundered
 * into a clean Ready verdict.
 */

function finding(area: ReadinessArea, status: ReadinessStatus): ReadinessFinding {
  return {
    area,
    status,
    reason: `${area} is ${status}.`,
    remedy: status === 'Satisfied' ? null : 'Observe the missing fact before starting the run.',
  };
}

function positionOf(order: readonly string[]): (id: string) => number {
  const positions = new Map(order.map((id, index) => [id, index]));
  return (id: string): number => {
    const index = positions.get(id);
    if (index === undefined) throw new Error(`"${id}" is absent from the produced order`);
    return index;
  };
}

const ACYCLIC: readonly DependencyNode[] = [
  { id: 'api-client', dependsOn: ['shared-types'] },
  { id: 'shared-types', dependsOn: [] },
  { id: 'docs', dependsOn: ['api-client', 'shared-types'] },
];

const TWO_CYCLE: readonly DependencyNode[] = [
  { id: 'api-client', dependsOn: ['web-client'] },
  { id: 'web-client', dependsOn: ['api-client'] },
];

const THREE_CYCLE: readonly DependencyNode[] = [
  { id: 'a', dependsOn: ['b'] },
  { id: 'b', dependsOn: ['c'] },
  { id: 'c', dependsOn: ['a'] },
];

describe('F09-AC2 and F09-AC5 readiness verdict', () => {
  test('any Unmet finding yields Blocked', () => {
    assert.equal(
      deriveReadiness([finding('Repository', 'Satisfied'), finding('Access', 'Unmet'), finding('Scope', 'Satisfied')]),
      'Blocked',
    );
  });

  test('an Unmet finding outranks an Unknown finding', () => {
    assert.equal(
      deriveReadiness([finding('Scope', 'Unmet'), finding('Target', 'Unknown')]),
      'Blocked',
    );
  });

  test('an Unknown finding with no Unmet finding yields NeedsInformation, not Blocked', () => {
    assert.equal(
      deriveReadiness([finding('Scope', 'Satisfied'), finding('Target', 'Unknown')]),
      'NeedsInformation',
    );
  });

  test('all Satisfied findings yield Ready without inventing blockers', () => {
    assert.equal(
      deriveReadiness([
        finding('Scope', 'Satisfied'),
        finding('Criteria', 'Satisfied'),
        finding('Repository', 'Satisfied'),
        finding('Target', 'Satisfied'),
        finding('Dependencies', 'Satisfied'),
        finding('Verification', 'Satisfied'),
        finding('Access', 'Satisfied'),
      ]),
      'Ready',
    );
  });
});

describe('F08-AC4 dependency analysis', () => {
  test('returns a topological order in which every dependency precedes its dependent', () => {
    const analysis = analyzeDependencies(ACYCLIC);
    const position = positionOf(analysis.order);

    assert.deepEqual(analysis.order, ['shared-types', 'api-client', 'docs']);
    assert.deepEqual(analysis.cycles, []);
    assert.deepEqual(analysis.unresolved, []);
    for (const node of ACYCLIC) {
      for (const dependency of node.dependsOn) {
        assert.ok(position(dependency) < position(node.id), `${dependency} must precede ${node.id}`);
      }
    }
  });

  test('detects a two-node cycle and names the nodes involved', () => {
    const analysis = analyzeDependencies(TWO_CYCLE);

    assert.equal(analysis.cycles.length, 1);
    const cycle = analysis.cycles[0];
    assert.ok(cycle, 'a cycle must be reported');
    assert.equal(cycle[0], cycle[cycle.length - 1], 'a reported cycle is a closed walk');
    assert.deepEqual([...new Set(cycle)].sort(), ['api-client', 'web-client']);
  });

  test('detects a three-node cycle and names the nodes involved', () => {
    const analysis = analyzeDependencies(THREE_CYCLE);

    assert.equal(analysis.cycles.length, 1);
    const cycle = analysis.cycles[0];
    assert.ok(cycle, 'a cycle must be reported');
    assert.equal(cycle[0], cycle[cycle.length - 1], 'a reported cycle is a closed walk');
    assert.deepEqual([...new Set(cycle)].sort(), ['a', 'b', 'c']);
  });

  test('reports a dependency referencing an unknown id as unresolved rather than satisfied', () => {
    const analysis = analyzeDependencies([
      { id: 'api-client', dependsOn: ['missing-lib'] },
      { id: 'shared-types', dependsOn: [] },
    ]);

    assert.deepEqual(analysis.unresolved, [{ node: 'api-client', dependsOn: 'missing-lib' }]);
    assert.deepEqual(analysis.cycles, []);
  });

  test('a cycle does not throw', () => {
    assert.doesNotThrow(() => analyzeDependencies(TWO_CYCLE));
    assert.doesNotThrow(() => analyzeDependencies(THREE_CYCLE));
  });

  test('a cycle does not silently produce a valid topological order', () => {
    for (const nodes of [TWO_CYCLE, THREE_CYCLE]) {
      const analysis = analyzeDependencies(nodes);
      const position = positionOf(analysis.order);
      const outOfOrder = nodes.filter((node) =>
        node.dependsOn.some((dependency) => position(dependency) < position(node.id)),
      );

      assert.ok(outOfOrder.length > 0, 'a cyclic graph must never yield a valid topological order');
      assert.ok(analysis.cycles.length > 0, 'a cyclic graph must report the cycle');
    }
  });
});

describe('F09-AC3 dependency availability', () => {
  test('a dependency marked Done with no release receipt is not available when the release is required', () => {
    const result = dependencyAvailable({ status: 'Done', releaseReceiptRecorded: false, requiresRelease: true });

    assert.equal(result.available, false);
    assert.match(result.reason, /no release receipt/);
  });

  test('the same dependency is available once the release receipt exists', () => {
    const result = dependencyAvailable({ status: 'Done', releaseReceiptRecorded: true, requiresRelease: true });

    assert.equal(result.available, true);
    assert.match(result.reason, /required evidence exists/);
  });

  test('a Done dependency that needs no release is available without a receipt', () => {
    const result = dependencyAvailable({ status: 'Done', releaseReceiptRecorded: false, requiresRelease: false });

    assert.equal(result.available, true);
  });

  test('a canceled dependency is not available even when a receipt was recorded', () => {
    const result = dependencyAvailable({ status: 'Canceled', releaseReceiptRecorded: true, requiresRelease: true });

    assert.equal(result.available, false);
    assert.match(result.reason, /canceled/);
  });

  test('F09-AC2 a dependency still in progress or still to do is not available', () => {
    assert.equal(
      dependencyAvailable({ status: 'InProgress', releaseReceiptRecorded: true, requiresRelease: true }).available,
      false,
    );
    assert.equal(
      dependencyAvailable({ status: 'Todo', releaseReceiptRecorded: false, requiresRelease: false }).available,
      false,
    );
  });
});