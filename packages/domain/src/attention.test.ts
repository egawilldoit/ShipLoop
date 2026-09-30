import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  bucketFor,
  dedupKeyFor,
  groupAttention,
  upsertAttentionItem,
  type AttentionBucket,
  type AttentionItem,
  type AttentionKind,
} from './attention.ts';
import { fingerprint } from './fingerprint.ts';

/**
 * One item per actionable situation. Acknowledging records owner attention only:
 * the type carries no run, acceptance or release fact, so this module cannot
 * express a lifecycle transition at all.
 */

const CANDIDATE = fingerprint({ candidate: 'current' });

const ALL_KINDS: readonly AttentionKind[] = [
  'ClarificationRequested',
  'Blocker',
  'ReadyForYourTest',
  'DeliveryDecision',
  'RecoveryDecision',
  'ReleaseResult',
  'SyncFailure',
  'WorkerStopped',
  'InvalidProfile',
  'LowArtifactCapacity',
];

const ALL_BUCKETS: readonly AttentionBucket[] = ['Working', 'NeedsYourInput', 'ReadyForYourTest', 'ReadyForRelease'];

const EXPECTED_BUCKET: Readonly<Record<AttentionKind, AttentionBucket>> = {
  ClarificationRequested: 'NeedsYourInput',
  Blocker: 'NeedsYourInput',
  ReadyForYourTest: 'ReadyForYourTest',
  DeliveryDecision: 'ReadyForRelease',
  RecoveryDecision: 'NeedsYourInput',
  ReleaseResult: 'NeedsYourInput',
  SyncFailure: 'NeedsYourInput',
  WorkerStopped: 'NeedsYourInput',
  InvalidProfile: 'NeedsYourInput',
  LowArtifactCapacity: 'NeedsYourInput',
};

type IncomingAttention = Parameters<typeof upsertAttentionItem>[1];

function incomingObservation(overrides: Partial<IncomingAttention> = {}): IncomingAttention {
  return {
    attentionItemId: 'att_proposed',
    dedupKey: dedupKeyFor('Blocker', 'SL-12'),
    kind: 'Blocker',
    projectId: 'prj_1',
    workItemId: 'wi_1',
    issueIdentifier: 'SL-12',
    title: 'Verification is blocked',
    blocker: 'The required browser acceptance flow has not run.',
    nextAction: 'Run the browser acceptance flow, then re-observe.',
    now: '2026-03-04T09:00:00.000Z',
    candidateFingerprint: CANDIDATE,
    ...overrides,
  };
}

function itemAt(overrides: Partial<AttentionItem> & Pick<AttentionItem, 'attentionItemId'>): AttentionItem {
  return {
    dedupKey: dedupKeyFor('Blocker', 'SL-12'),
    kind: 'Blocker',
    state: 'Open',
    projectId: 'prj_1',
    workItemId: 'wi_1',
    issueIdentifier: 'SL-12',
    title: 'Verification is blocked',
    blocker: 'The required browser acceptance flow has not run.',
    nextAction: 'Run the browser acceptance flow, then re-observe.',
    createdAt: '2026-03-04T09:00:00.000Z',
    updatedAt: '2026-03-04T09:00:00.000Z',
    acknowledgedAt: null,
    acknowledgedBy: null,
    candidateFingerprint: CANDIDATE,
    ...overrides,
  };
}

function only<T>(values: readonly T[], label: string): T {
  assert.equal(values.length, 1, `${label}: expected exactly one entry`);
  const value = values[0];
  if (value === undefined) throw new Error(`${label}: missing entry`);
  return value;
}

describe('F31-AC3 bucketing and dedup keys', () => {
  test('bucketFor maps every attention kind to one of the four buckets', () => {
    for (const kind of ALL_KINDS) {
      const bucket = bucketFor(kind);
      assert.ok(
        ALL_BUCKETS.includes(bucket),
        `${kind} mapped to ${bucket}, which is not one of the four documented buckets`,
      );
      assert.equal(bucket, EXPECTED_BUCKET[kind]);
    }
  });

  test('dedupKeyFor is stable and distinguishes both the kind and the subject', () => {
    const key = dedupKeyFor('Blocker', 'SL-12');

    assert.equal(key, dedupKeyFor('Blocker', 'SL-12'));
    assert.notEqual(key, dedupKeyFor('ClarificationRequested', 'SL-12'));
    assert.notEqual(key, dedupKeyFor('Blocker', 'SL-13'));
  });
});

describe('F31-AC3 deduplication', () => {
  test('the same dedup key updates the existing item instead of appending a new one', () => {
    const created = upsertAttentionItem([], incomingObservation({ attentionItemId: 'att_1' }));
    assert.equal(created.length, 1);

    const again = upsertAttentionItem(created, incomingObservation({ attentionItemId: 'att_2', now: '2026-03-05T09:00:00.000Z' }));

    assert.equal(again.length, 1, 'a repeated event must not increase the array length');
    const item = only(again, 'updated item');
    assert.equal(item.attentionItemId, 'att_1', 'the existing item keeps its identity');
    assert.equal(item.createdAt, '2026-03-04T09:00:00.000Z');
    assert.equal(item.updatedAt, '2026-03-05T09:00:00.000Z');
  });

  test('a different dedup key creates a separate item', () => {
    const created = upsertAttentionItem([], incomingObservation({ attentionItemId: 'att_1' }));
    const other = upsertAttentionItem(
      created,
      incomingObservation({ attentionItemId: 'att_2', dedupKey: dedupKeyFor('SyncFailure', 'SL-12'), kind: 'SyncFailure' }),
    );

    assert.equal(other.length, 2);
  });

  test('updating in place preserves the position of the existing item', () => {
    const first = upsertAttentionItem([], incomingObservation({ attentionItemId: 'att_1' }));
    const two = upsertAttentionItem(
      first,
      incomingObservation({ attentionItemId: 'att_x', dedupKey: dedupKeyFor('ReadyForYourTest', 'SL-20'), kind: 'ReadyForYourTest' }),
    );

    const updated = upsertAttentionItem(two, incomingObservation({ attentionItemId: 'att_y', now: '2026-03-06T09:00:00.000Z' }));

    assert.deepEqual(
      updated.map((item) => item.attentionItemId),
      ['att_1', 'att_x'],
    );
  });
});

describe('F31-AC4 acknowledgment and resolution', () => {
  test('acknowledging then re-observing the same condition preserves the acknowledgment', () => {
    const acknowledged = itemAt({
      attentionItemId: 'att_1',
      state: 'Acknowledged',
      acknowledgedAt: '2026-03-04T10:00:00.000Z',
      acknowledgedBy: 'owner_1',
      updatedAt: '2026-03-04T10:00:00.000Z',
    });

    const reobserved = upsertAttentionItem([acknowledged], incomingObservation({ now: '2026-03-05T09:00:00.000Z' }));
    const item = only(reobserved, 're-observed item');

    assert.equal(item.attentionItemId, 'att_1');
    assert.equal(item.state, 'Acknowledged');
    assert.equal(item.acknowledgedAt, '2026-03-04T10:00:00.000Z');
    assert.equal(item.acknowledgedBy, 'owner_1');
    assert.equal(item.updatedAt, '2026-03-05T09:00:00.000Z', 'the repeat is still recorded');
  });

  test('acknowledging cannot express a lifecycle change: no run, acceptance or release field exists', () => {
    const acknowledged = itemAt({
      attentionItemId: 'att_1',
      state: 'Acknowledged',
      acknowledgedAt: '2026-03-04T10:00:00.000Z',
      acknowledgedBy: 'owner_1',
    });
    const item = only(
      upsertAttentionItem([acknowledged], incomingObservation({ now: '2026-03-05T09:00:00.000Z' })),
      're-observed item',
    );

    const lifecycleFields = [
      'attempt',
      'attemptStatus',
      'run',
      'runStatus',
      'acceptance',
      'acceptanceStatus',
      'release',
      'releaseState',
      'released',
      'mergeState',
    ];
    for (const field of lifecycleFields) {
      assert.equal(field in item, false, `${field} must not exist on an attention item`);
    }
  });

  test('resolving the underlying condition transitions the item to Resolved and clears the acknowledgment', () => {
    const acknowledged = itemAt({
      attentionItemId: 'att_1',
      state: 'Acknowledged',
      acknowledgedAt: '2026-03-04T10:00:00.000Z',
      acknowledgedBy: 'owner_1',
    });

    const resolved = upsertAttentionItem(
      [acknowledged],
      incomingObservation({ attentionItemId: 'att_ignored', now: '2026-03-06T09:00:00.000Z', resolved: true }),
    );
    const item = only(resolved, 'resolved item');

    assert.equal(item.state, 'Resolved');
    assert.equal(item.acknowledgedAt, null);
    assert.equal(item.acknowledgedBy, null);
    assert.equal(item.attentionItemId, 'att_1');
    assert.equal(item.updatedAt, '2026-03-06T09:00:00.000Z');
  });

  test('a resolved observation on a new item creates it already resolved', () => {
    const created = upsertAttentionItem([], incomingObservation({ resolved: true }));
    const item = only(created, 'newly resolved item');

    assert.equal(item.state, 'Resolved');
    assert.equal(item.createdAt, '2026-03-04T09:00:00.000Z');
  });
});

describe('F31-AC1 attention grouping', () => {
  const items: readonly AttentionItem[] = [
    itemAt({ attentionItemId: 'att_delivery_new', dedupKey: 'k_delivery_new', kind: 'DeliveryDecision', createdAt: '2026-03-05T08:00:00.000Z' }),
    itemAt({ attentionItemId: 'att_blocker_old', dedupKey: 'k_blocker_old', kind: 'Blocker', createdAt: '2026-03-01T08:00:00.000Z' }),
    itemAt({
      attentionItemId: 'att_resolved',
      dedupKey: 'k_resolved',
      kind: 'SyncFailure',
      state: 'Resolved',
      createdAt: '2026-03-02T08:00:00.000Z',
    }),
    itemAt({
      attentionItemId: 'att_blocker_new',
      dedupKey: 'k_blocker_new',
      kind: 'Blocker',
      state: 'Acknowledged',
      createdAt: '2026-03-03T08:00:00.000Z',
      acknowledgedAt: '2026-03-03T09:00:00.000Z',
      acknowledgedBy: 'owner_1',
    }),
    itemAt({
      attentionItemId: 'att_ready_test',
      dedupKey: 'k_ready_test',
      kind: 'ReadyForYourTest',
      createdAt: '2026-03-04T08:00:00.000Z',
    }),
  ];

  test('returns only non-resolved items', () => {
    const groups = groupAttention(items);
    const shown = groups.flatMap((group) => group.items.map((item) => item.attentionItemId));

    assert.deepEqual(shown.sort(), ['att_blocker_new', 'att_blocker_old', 'att_delivery_new', 'att_ready_test']);
    for (const item of groups.flatMap((group) => group.items)) {
      assert.notEqual(item.state, 'Resolved');
    }
  });

  test('emits buckets in the documented order', () => {
    const groups = groupAttention(items);

    assert.deepEqual(
      groups.map((group) => group.bucket),
      ['NeedsYourInput', 'ReadyForYourTest', 'ReadyForRelease'],
    );
  });

  test('sorts each bucket oldest first and keeps a lower priority item ahead of a later one', () => {
    const groups = groupAttention(items);
    const needsInput = groups[0];
    assert.ok(needsInput, 'NeedsYourInput group must be present');

    assert.deepEqual(
      needsInput.items.map((item) => item.attentionItemId),
      ['att_blocker_old', 'att_blocker_new'],
    );
  });

  test('omits buckets that hold no open items', () => {
    const groups = groupAttention([items[1] as AttentionItem]);

    assert.deepEqual(
      groups.map((group) => group.bucket),
      ['NeedsYourInput'],
    );
    assert.deepEqual(groupAttention([]), []);
  });

  test('an acknowledged item stays visible until the blocker is actually resolved', () => {
    const groups = groupAttention(items);
    const acknowledged = groups.flatMap((group) => group.items).find((item) => item.attentionItemId === 'att_blocker_new');

    assert.ok(acknowledged, 'an acknowledged item must still be listed');
    assert.equal(acknowledged.state, 'Acknowledged');
  });
});