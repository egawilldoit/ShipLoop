/**
 * Regression proof for scope snapshots and material versus cosmetic change.
 *
 * Linear owns the published scope, so a run records what it read and later
 * compares. The rule under test is which differences may invalidate that record:
 * display fields must not restart coding (F12-AC3), while the content an owner
 * accepted against must (F12-AC1, F12-AC2).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { asCommitSha } from './ids.ts';
import type { CommitSha } from './ids.ts';
import {
  captureRunContext,
  compareScope,
  materialScopeFingerprint,
  scopeFingerprint,
} from './scope.ts';
import type { ScopeCriterion, ScopeSnapshot } from './scope.ts';

const BASE_SHA: CommitSha = asCommitSha('0123456789abcdef0123456789abcdef01234567');

const CRITERION_ONE: ScopeCriterion = {
  id: 'c1',
  text: 'A failed delivery retries at most three times',
};
const CRITERION_TWO: ScopeCriterion = {
  id: 'c2',
  text: 'Each retry is visible in the delivery receipt',
};

const RECORDED: ScopeSnapshot = {
  workItemId: 'work-item-1',
  issueId: 'issue-1',
  issueIdentifier: 'ENG-123',
  title: 'Add retry to the delivery queue',
  description: 'Retries must be bounded and observable.',
  providerRevision: 'rev-9',
  priority: 'Medium',
  dependencyIssueIds: ['ENG-100', 'ENG-101'],
  acceptanceCriteria: [CRITERION_ONE, CRITERION_TWO],
  retrievedAt: '2026-09-30T09:00:00.000Z',
};

const RECORDED_FINGERPRINT = scopeFingerprint(RECORDED);
const LATER_RETRIEVAL = '2026-09-30T18:45:12.000Z';

function withScope(overrides: Partial<ScopeSnapshot>): ScopeSnapshot {
  return { ...RECORDED, ...overrides };
}

function capture(overrides: Partial<ScopeSnapshot> = {}, capturedAt = RECORDED.retrievedAt) {
  return captureRunContext(
    {
      scope: withScope(overrides),
      baseSha: BASE_SHA,
      profileVersionId: 'profile-version-1',
      procedureVersionId: 'procedure-version-1',
    },
    capturedAt,
  );
}

describe('scope fingerprint: determinism', () => {
  test('F12-AC1 - the same content always yields the same fingerprint', () => {
    assert.equal(scopeFingerprint(RECORDED), RECORDED_FINGERPRINT);
    assert.equal(scopeFingerprint(withScope({})), RECORDED_FINGERPRINT);
    assert.equal(scopeFingerprint(RECORDED), scopeFingerprint(RECORDED));
  });

  test('F12-AC1 - fingerprinting does not reorder the snapshot it was given', () => {
    const criteriaOrderBefore = RECORDED.acceptanceCriteria.map((criterion) => criterion.id);
    const dependenciesBefore = [...RECORDED.dependencyIssueIds];
    scopeFingerprint(RECORDED);
    assert.deepEqual(RECORDED.acceptanceCriteria.map((criterion) => criterion.id), criteriaOrderBefore);
    assert.deepEqual(RECORDED.dependencyIssueIds, dependenciesBefore);
  });

  test('F12-AC1 - the material fingerprint agrees with the scope fingerprint', () => {
    assert.equal(materialScopeFingerprint(RECORDED), RECORDED_FINGERPRINT);
    const changed = withScope({ description: 'Different description.' });
    assert.equal(materialScopeFingerprint(changed), scopeFingerprint(changed));
  });
});

describe('scope fingerprint: cosmetic fields are excluded', () => {
  test('F12-AC3 - a title edit alone does not change the scope fingerprint', () => {
    const edited = withScope({ title: 'Add bounded retry to the delivery queue' });
    assert.notEqual(edited.title, RECORDED.title);
    assert.equal(scopeFingerprint(edited), RECORDED_FINGERPRINT);
  });

  test('F12-AC3 - a priority edit alone does not change the scope fingerprint', () => {
    for (const priority of ['Urgent', 'Low', null]) {
      assert.equal(
        scopeFingerprint(withScope({ priority })),
        RECORDED_FINGERPRINT,
        `priority ${String(priority)} must not be material`,
      );
    }
  });

  test('F12-AC1 - the retrieval time does not change the scope fingerprint', () => {
    assert.equal(scopeFingerprint(withScope({ retrievedAt: LATER_RETRIEVAL })), RECORDED_FINGERPRINT);
  });

  test('F12-AC3 - cosmetic fields changing together stay cosmetic', () => {
    const edited = withScope({
      title: 'Add bounded retry to the delivery queue',
      priority: 'Urgent',
      retrievedAt: LATER_RETRIEVAL,
      providerRevision: 'rev-10',
    });
    assert.equal(scopeFingerprint(edited), RECORDED_FINGERPRINT);
    assert.equal(compareScope(RECORDED, edited).kind, 'Cosmetic');
  });
});

describe('scope fingerprint: material content is included', () => {
  test('F12-AC2 - a description edit changes the scope fingerprint', () => {
    const edited = withScope({ description: 'Retries must be bounded, observable and cancelable.' });
    assert.notEqual(scopeFingerprint(edited), RECORDED_FINGERPRINT);
  });

  test('F12-AC2 - edited acceptance criterion text changes the scope fingerprint', () => {
    const edited = withScope({
      acceptanceCriteria: [{ ...CRITERION_ONE, text: 'A failed delivery retries at most five times' }, CRITERION_TWO],
    });
    assert.notEqual(scopeFingerprint(edited), RECORDED_FINGERPRINT);
  });

  test('F12-AC2 - an added acceptance criterion changes the scope fingerprint', () => {
    const added: ScopeCriterion = { id: 'c3', text: 'A retry storm is capped per work item' };
    const edited = withScope({ acceptanceCriteria: [...RECORDED.acceptanceCriteria, added] });
    assert.notEqual(scopeFingerprint(edited), RECORDED_FINGERPRINT);
  });

  test('F12-AC2 - a removed acceptance criterion changes the scope fingerprint', () => {
    const edited = withScope({ acceptanceCriteria: [CRITERION_ONE] });
    assert.notEqual(scopeFingerprint(edited), RECORDED_FINGERPRINT);
  });

  test('F12-AC2 - an added dependency changes the scope fingerprint', () => {
    const edited = withScope({ dependencyIssueIds: [...RECORDED.dependencyIssueIds, 'ENG-102'] });
    assert.notEqual(scopeFingerprint(edited), RECORDED_FINGERPRINT);
  });

  test('F12-AC1 - criterion and dependency order does not change the fingerprint', () => {
    const reordered = withScope({
      acceptanceCriteria: [...RECORDED.acceptanceCriteria].reverse(),
      dependencyIssueIds: [...RECORDED.dependencyIssueIds].reverse(),
    });
    assert.equal(scopeFingerprint(reordered), RECORDED_FINGERPRINT);
  });
});

describe('scope comparison: unchanged', () => {
  test('F12-AC2 - identical content is Unchanged with no differences', () => {
    const comparison = compareScope(RECORDED, withScope({}));
    assert.equal(comparison.kind, 'Unchanged');
    assert.deepEqual(comparison.materialDifferences, []);
    assert.deepEqual(comparison.cosmeticDifferences, []);
    assert.equal(comparison.recordedFingerprint, comparison.currentFingerprint);
  });

  test('F12-AC3 - re-retrieving the same content is Unchanged', () => {
    const comparison = compareScope(RECORDED, withScope({ retrievedAt: LATER_RETRIEVAL }));
    assert.equal(comparison.kind, 'Unchanged');
    assert.equal(comparison.recordedFingerprint, RECORDED_FINGERPRINT);
    assert.equal(comparison.currentFingerprint, RECORDED_FINGERPRINT);
  });

  test('F12-AC1 - reordered criteria are Unchanged', () => {
    const reordered = withScope({ acceptanceCriteria: [...RECORDED.acceptanceCriteria].reverse() });
    const comparison = compareScope(RECORDED, reordered);
    assert.equal(comparison.kind, 'Unchanged');
    assert.deepEqual(comparison.materialDifferences, []);
  });
});

describe('scope comparison: cosmetic', () => {
  test('F12-AC3 - a title edit is Cosmetic and reports title', () => {
    const comparison = compareScope(RECORDED, withScope({ title: 'Add bounded retry' }));
    assert.equal(comparison.kind, 'Cosmetic');
    assert.deepEqual(comparison.cosmeticDifferences, ['title']);
    assert.deepEqual(comparison.materialDifferences, []);
    assert.equal(comparison.recordedFingerprint, comparison.currentFingerprint);
  });

  test('F12-AC3 - a priority edit is Cosmetic and reports priority', () => {
    const comparison = compareScope(RECORDED, withScope({ priority: 'Urgent' }));
    assert.equal(comparison.kind, 'Cosmetic');
    assert.deepEqual(comparison.cosmeticDifferences, ['priority']);
    assert.deepEqual(comparison.materialDifferences, []);
  });

  test('F12-AC3 - a cosmetic edit leaves the acceptance decision standing', () => {
    const comparison = compareScope(RECORDED, withScope({ title: 'Add bounded retry', priority: 'Urgent' }));
    assert.equal(comparison.kind, 'Cosmetic');
    assert.equal(comparison.recordedFingerprint, comparison.currentFingerprint);
  });
});

describe('scope comparison: material', () => {
  test('F12-AC2 - a description edit is Material and reports description', () => {
    const comparison = compareScope(RECORDED, withScope({ description: 'Retries must be cancelable.' }));
    assert.equal(comparison.kind, 'Material');
    assert.deepEqual(comparison.materialDifferences, ['description']);
    assert.deepEqual(comparison.cosmeticDifferences, []);
    assert.notEqual(comparison.recordedFingerprint, comparison.currentFingerprint);
  });

  test('F12-AC2 - an edited criterion is Material and names the criterion', () => {
    const comparison = compareScope(
      RECORDED,
      withScope({
        acceptanceCriteria: [{ ...CRITERION_ONE, text: 'A failed delivery retries at most five times' }, CRITERION_TWO],
      }),
    );
    assert.equal(comparison.kind, 'Material');
    assert.deepEqual(comparison.materialDifferences, ['criteria.changed.c1']);
  });

  test('F12-AC2 - an added criterion is Material and names the criterion', () => {
    const added: ScopeCriterion = { id: 'c3', text: 'A retry storm is capped per work item' };
    const comparison = compareScope(
      RECORDED,
      withScope({ acceptanceCriteria: [...RECORDED.acceptanceCriteria, added] }),
    );
    assert.equal(comparison.kind, 'Material');
    assert.deepEqual(comparison.materialDifferences, ['criteria.added.c3']);
  });

  test('F12-AC2 - a removed criterion is Material and names the criterion', () => {
    const comparison = compareScope(RECORDED, withScope({ acceptanceCriteria: [CRITERION_ONE] }));
    assert.equal(comparison.kind, 'Material');
    assert.deepEqual(comparison.materialDifferences, ['criteria.removed.c2']);
  });

  test('F12-AC2 - an added dependency is Material and names the dependency', () => {
    const comparison = compareScope(
      RECORDED,
      withScope({ dependencyIssueIds: [...RECORDED.dependencyIssueIds, 'ENG-102'] }),
    );
    assert.equal(comparison.kind, 'Material');
    assert.deepEqual(comparison.materialDifferences, ['dependencies.added.ENG-102']);
  });

  test('F12-AC2 - a removed dependency is Material and names the dependency', () => {
    // Removals were never reported, so the comparison returned kind Unchanged while
    // its own recordedFingerprint and currentFingerprint disagreed.
    const comparison = compareScope(RECORDED, withScope({ dependencyIssueIds: ['ENG-100'] }));

    assert.equal(comparison.kind, 'Material');
    assert.deepEqual(comparison.materialDifferences, ['dependencies.removed.ENG-101']);
    assert.ok(comparison.materialDifferences.length > 0, 'a removed dependency is a material difference');
    assert.notEqual(
      comparison.recordedFingerprint,
      comparison.currentFingerprint,
      'the two fingerprints must differ, so Unchanged could never have been honest here',
    );
  });

  test('F12-AC2 - Unchanged is only returned when the two fingerprints actually agree', () => {
    const samples: readonly ScopeSnapshot[] = [
      withScope({}),
      withScope({ dependencyIssueIds: [] }),
      withScope({ dependencyIssueIds: ['ENG-101', 'ENG-100'] }),
      withScope({ description: 'Retries must be cancelable.' }),
      withScope({ acceptanceCriteria: [CRITERION_ONE] }),
      withScope({ title: 'Renamed' }),
    ];
    for (const current of samples) {
      const comparison = compareScope(RECORDED, current);
      const fingerprintsAgree = comparison.recordedFingerprint === comparison.currentFingerprint;
      if (!fingerprintsAgree) {
        assert.equal(
          comparison.kind,
          'Material',
          `differing fingerprints must never be reported as ${comparison.kind}`,
        );
        assert.ok(comparison.materialDifferences.length > 0, 'Material must carry at least one difference');
      }
    }
  });

  test('F12-AC2 - a material edit outranks a cosmetic one in the same comparison', () => {
    const comparison = compareScope(
      RECORDED,
      withScope({ title: 'Add bounded retry', priority: 'Urgent', description: 'Retries must be cancelable.' }),
    );
    assert.equal(comparison.kind, 'Material');
    assert.deepEqual(comparison.materialDifferences, ['description']);
    assert.deepEqual(comparison.cosmeticDifferences, ['title', 'priority']);
  });

  test('F12-AC2 - every differing field is reported, not just the first', () => {
    const comparison = compareScope(
      RECORDED,
      withScope({
        description: 'Retries must be cancelable.',
        acceptanceCriteria: [
          { ...CRITERION_ONE, text: 'A failed delivery retries at most five times' },
          { id: 'c3', text: 'A retry storm is capped per work item' },
        ],
        dependencyIssueIds: ['ENG-100', 'ENG-102'],
      }),
    );
    assert.equal(comparison.kind, 'Material');
    assert.deepEqual(comparison.materialDifferences, [
      'description',
      'criteria.changed.c1',
      'criteria.added.c3',
      'criteria.removed.c2',
      // Swapping ENG-101 for ENG-102 is both an addition and a removal. The
      // removal was silently dropped before the fix, so this list was incomplete
      // while the test claimed to prove it was complete.
      'dependencies.added.ENG-102',
      'dependencies.removed.ENG-101',
    ]);
  });
});

describe('run start context capture', () => {
  test('F12-AC1 - capture records the scope, its fingerprint, versions and the capture time', () => {
    const captured = capture();
    assert.deepEqual(captured.scope, RECORDED);
    assert.equal(captured.scopeFingerprintValue, RECORDED_FINGERPRINT);
    assert.equal(captured.baseSha, BASE_SHA);
    assert.equal(captured.profileVersionId, 'profile-version-1');
    assert.equal(captured.procedureVersionId, 'procedure-version-1');
    assert.equal(captured.capturedAt, RECORDED.retrievedAt);
  });

  test('F12-AC1 - the recorded fingerprint is the semantic one, not a content hash', () => {
    const captured = capture();
    assert.equal(captured.scopeFingerprintValue, scopeFingerprint(captured.scope));
    assert.equal(
      captured.scopeFingerprintValue,
      scopeFingerprint(withScope({ title: 'Renamed', priority: 'Low', retrievedAt: LATER_RETRIEVAL })),
      'a cosmetic edit must not create a new scope revision',
    );
  });

  test('F12-AC1 - capture time is recorded verbatim, not derived from the snapshot', () => {
    const captured = capture({}, LATER_RETRIEVAL);
    assert.equal(captured.capturedAt, LATER_RETRIEVAL);
    assert.notEqual(captured.capturedAt, RECORDED.retrievedAt);
  });

  test('F12-AC1 - a material edit between runs produces a new scope revision', () => {
    const first = capture();
    const second = capture({ description: 'Retries must be cancelable.' }, LATER_RETRIEVAL);
    assert.notEqual(second.scopeFingerprintValue, first.scopeFingerprintValue);
    assert.equal(compareScope(first.scope, second.scope).kind, 'Material');
  });
});

describe('scope snapshot immutability', () => {
  /**
   * F12 depends on a captured snapshot being append-only.
   *
   * The types alone were not enough: captureRunContext used to hand back the
   * caller's own scope object, so a storage adapter returning a mutable decoded
   * record could change the scope after the fingerprint was recorded. The
   * collections are now frozen and copied, which is provable at runtime.
   */

  /** True only for a mutable array type, so `= false` proves the field is readonly. */
  type IsMutableArray<T> = T extends unknown[] ? true : false;

  test('F12 - the criterion and dependency collections are readonly by type', () => {
    // Compile-time proof: widening either field to a mutable array fails these
    // assignments, which is the append-only guarantee F12 depends on.
    const criteriaAreMutable: IsMutableArray<ScopeSnapshot['acceptanceCriteria']> = false;
    const dependenciesAreMutable: IsMutableArray<ScopeSnapshot['dependencyIssueIds']> = false;
    assert.equal(criteriaAreMutable, false);
    assert.equal(dependenciesAreMutable, false);
  });

  test('F12 - a captured snapshot records the scope it was given', () => {
    const captured = capture();
    assert.deepEqual(captured.scope, RECORDED);
    assert.equal(scopeFingerprint(captured.scope), captured.scopeFingerprintValue);
  });

  test('F12-AC1 - mutating the caller dependency array afterwards does not change the captured scope', () => {
    // The caller keeps a genuinely mutable array, which the readonly ScopeSnapshot
    // field accepts. Under the old by-reference capture this push was visible
    // through the captured snapshot and through its recorded fingerprint.
    const sharedDependencies: string[] = [...RECORDED.dependencyIssueIds];
    const captured = captureRunContext(
      {
        scope: { ...RECORDED, dependencyIssueIds: sharedDependencies },
        baseSha: BASE_SHA,
        profileVersionId: 'profile-version-1',
        procedureVersionId: 'procedure-version-1',
      },
      RECORDED.retrievedAt,
    );
    const fingerprintAtCapture = captured.scopeFingerprintValue;

    sharedDependencies.push('ENG-999');
    assert.deepEqual(sharedDependencies, ['ENG-100', 'ENG-101', 'ENG-999'], 'the caller array really was mutated');

    assert.deepEqual([...captured.scope.dependencyIssueIds], ['ENG-100', 'ENG-101']);
    assert.equal(
      scopeFingerprint(captured.scope),
      fingerprintAtCapture,
      'a mutated caller array must not change the recomputed scope fingerprint',
    );
    assert.notEqual(
      scopeFingerprint(withScope({ dependencyIssueIds: sharedDependencies })),
      fingerprintAtCapture,
      'the mutation really is material, so the assertion above is not vacuous',
    );
  });

  test('F12-AC1 - mutating the caller criteria array afterwards does not change the captured scope', () => {
    const sharedCriteria: ScopeCriterion[] = [CRITERION_ONE, CRITERION_TWO];
    const captured = captureRunContext(
      {
        scope: { ...RECORDED, acceptanceCriteria: sharedCriteria },
        baseSha: BASE_SHA,
        profileVersionId: 'profile-version-1',
        procedureVersionId: 'procedure-version-1',
      },
      RECORDED.retrievedAt,
    );
    const fingerprintAtCapture = captured.scopeFingerprintValue;

    sharedCriteria[1] = { id: 'c2', text: 'A retry storm is capped per work item' };
    sharedCriteria.push({ id: 'c3', text: 'A retry storm is capped per work item' });

    assert.deepEqual(
      captured.scope.acceptanceCriteria.map((criterion) => criterion.id),
      ['c1', 'c2'],
    );
    assert.equal(
      captured.scope.acceptanceCriteria[1]?.text,
      CRITERION_TWO.text,
      'the captured criterion keeps its captured text, not the mutated one',
    );
    assert.equal(scopeFingerprint(captured.scope), fingerprintAtCapture);
  });

  test('F12-AC1 - the captured collections are frozen, so a later write cannot even be attempted', () => {
    const captured = capture();

    assert.equal(Object.isFrozen(captured.scope.dependencyIssueIds), true);
    assert.equal(Object.isFrozen(captured.scope.acceptanceCriteria), true);
    for (const criterion of captured.scope.acceptanceCriteria) {
      assert.equal(Object.isFrozen(criterion), true);
    }
  });

  test('F12-AC3 - re-capturing after a cosmetic edit keeps the same scope revision', () => {
    const first = capture();
    const second = capture({ title: 'Renamed', priority: 'Urgent' }, LATER_RETRIEVAL);
    assert.equal(second.scopeFingerprintValue, first.scopeFingerprintValue);
    assert.notEqual(second.capturedAt, first.capturedAt);
  });
});
