import type { Fingerprint } from './ids.ts';

/**
 * Attention items (F31).
 *
 * One item per actionable situation, keyed by a stable dedup key, so a repeated
 * event updates the existing item instead of creating a new one (F31-AC3).
 *
 * Acknowledging an item records owner attention only. It must not change the
 * underlying run, acceptance or release fact, so no field here can express a
 * lifecycle transition (F31-AC4).
 */

export type AttentionKind =
  | 'ClarificationRequested'
  | 'Blocker'
  | 'ReadyForYourTest'
  | 'DeliveryDecision'
  | 'RecoveryDecision'
  | 'ReleaseResult'
  | 'SyncFailure'
  | 'WorkerStopped'
  | 'InvalidProfile'
  | 'LowArtifactCapacity';

export type AttentionBucket = 'Working' | 'NeedsYourInput' | 'ReadyForYourTest' | 'ReadyForRelease';

export type AttentionState = 'Open' | 'Acknowledged' | 'Resolved';

export interface AttentionItem {
  readonly attentionItemId: string;
  /** Stable key derived from kind plus subject, used for deduplication. */
  readonly dedupKey: string;
  readonly kind: AttentionKind;
  readonly state: AttentionState;
  readonly projectId: string;
  readonly workItemId: string | null;
  readonly issueIdentifier: string | null;
  readonly title: string;
  readonly blocker: string | null;
  readonly nextAction: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  /** Candidate the item refers to, so a stale item can be detected. */
  readonly candidateFingerprint: Fingerprint | null;
}

const KIND_TO_BUCKET: Readonly<Record<AttentionKind, AttentionBucket>> = {
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

export function bucketFor(kind: AttentionKind): AttentionBucket {
  return KIND_TO_BUCKET[kind];
}

export function dedupKeyFor(kind: AttentionKind, subject: string): string {
  return `${kind}:${subject}`;
}

/**
 * Merges a new observation into the existing item list.
 *
 * An existing open or acknowledged item with the same dedup key is updated in
 * place, preserving its identity and acknowledgment, rather than appended.
 */
export function upsertAttentionItem(
  existing: readonly AttentionItem[],
  incoming: Omit<AttentionItem, 'createdAt' | 'updatedAt' | 'state' | 'acknowledgedAt' | 'acknowledgedBy' | 'attentionItemId'> & {
    readonly now: string;
    readonly attentionItemId: string;
    /** Resolves when the underlying blocker is genuinely gone. */
    readonly resolved?: boolean;
  },
): readonly AttentionItem[] {
  const index = existing.findIndex((item) => item.dedupKey === incoming.dedupKey);
  const shared = {
    ...incoming,
    state: (incoming.resolved ? 'Resolved' : 'Open') as AttentionState,
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
  if (index === -1) {
    return [...existing, { ...shared, createdAt: incoming.now, updatedAt: incoming.now }];
  }
  const previous = existing[index];
  if (previous) {
    const resolved = incoming.resolved === true;
    const updated: AttentionItem = {
      ...previous,
      ...shared,
      attentionItemId: previous.attentionItemId,
      createdAt: previous.createdAt,
      // Acknowledgment survives a repeated observation of the same condition.
      state: resolved ? 'Resolved' : previous.state,
      acknowledgedAt: resolved ? null : previous.acknowledgedAt,
      acknowledgedBy: resolved ? null : previous.acknowledgedBy,
      updatedAt: incoming.now,
    };
    return [...existing.slice(0, index), updated, ...existing.slice(index + 1)];
  }
  return existing;
}

export interface AttentionGroup {
  readonly bucket: AttentionBucket;
  readonly items: readonly AttentionItem[];
}

/** Groups open items for the dashboard, oldest first within each bucket. */
export function groupAttention(items: readonly AttentionItem[]): readonly AttentionGroup[] {
  const open = items.filter((item) => item.state !== 'Resolved');
  const buckets: readonly AttentionBucket[] = [
    'NeedsYourInput',
    'ReadyForYourTest',
    'ReadyForRelease',
    'Working',
  ];
  return buckets
    .map((bucket) => ({
      bucket,
      items: open.filter((item) => bucketFor(item.kind) === bucket).sort((left, right) =>
        left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0,
      ),
    }))
    .filter((group) => group.items.length > 0);
}
