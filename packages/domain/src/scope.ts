import type { CommitSha, Fingerprint } from './ids.ts';
import { fingerprint } from './fingerprint.ts';

/**
 * Immutable scope snapshots (F12).
 *
 * Linear owns published scope, so a run captures the issue content at start and
 * compares against live content later. The snapshot is immutable: reconciliation
 * records a decision against it rather than editing it, so the history of what
 * ShipLoop believed and when remains inspectable.
 */

export interface ScopeSnapshot {
  readonly workItemId: string;
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly description: string;
  /** Stable provider revision when the provider supplies one; otherwise a content digest. */
  readonly providerRevision: string | null;
  readonly priority: string | null;
  /** Dependency work item identities this scope depends on. */
  readonly dependencyIssueIds: readonly string[];
  readonly acceptanceCriteria: readonly ScopeCriterion[];
  /** When this content was retrieved from the provider. */
  readonly retrievedAt: string;
}

export interface ScopeCriterion {
  readonly id: string;
  readonly text: string;
}

/**
 * The semantic scope fingerprint.
 *
 * Deliberately excludes title, priority and retrieval time: those are display or
 * ordering fields whose change must not restart coding or erase an acceptance
 * decision (F12-AC3). Description, criteria and dependency identity are the
 * material content, so a change there produces a different fingerprint.
 */
export function scopeFingerprint(snapshot: ScopeSnapshot): Fingerprint {
  return fingerprint({
    description: snapshot.description,
    criteria: [...snapshot.acceptanceCriteria]
      .map((criterion) => ({ id: criterion.id, text: criterion.text }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    dependencies: [...snapshot.dependencyIssueIds].sort(),
  });
}

/** A fingerprint that deliberately ignores cosmetic fields, for cosmetic comparisons. */
export function materialScopeFingerprint(snapshot: ScopeSnapshot): Fingerprint {
  return scopeFingerprint(snapshot);
}

export type ScopeChangeKind = 'Material' | 'Cosmetic' | 'Unchanged';

export interface ScopeComparison {
  readonly kind: ScopeChangeKind;
  /** Material differences only; cosmetic differences are reported separately. */
  readonly materialDifferences: readonly string[];
  readonly cosmeticDifferences: readonly string[];
  readonly recordedFingerprint: Fingerprint;
  readonly currentFingerprint: Fingerprint;
}

/**
 * Classifies a live issue against a captured snapshot.
 *
 * A priority or title edit is Cosmetic so it cannot restart coding. A criteria,
 * description or dependency change is Material and blocks acceptance and delivery
 * until the owner reconciles it, while unaffected bounded work may continue
 * (F12-AC2).
 */
export function compareScope(recorded: ScopeSnapshot, current: ScopeSnapshot): ScopeComparison {
  const recordedFingerprint = scopeFingerprint(recorded);
  const currentFingerprint = scopeFingerprint(current);
  const materialDifferences: string[] = [];
  const cosmeticDifferences: string[] = [];

  if (recorded.description !== current.description) {
    materialDifferences.push('description');
  }

  const recordedCriteria = new Map(recorded.acceptanceCriteria.map((criterion) => [criterion.id, criterion.text]));
  const currentCriteria = new Map(current.acceptanceCriteria.map((criterion) => [criterion.id, criterion.text]));
  for (const [id, text] of currentCriteria) {
    if (!recordedCriteria.has(id)) materialDifferences.push(`criteria.added.${id}`);
    else if (recordedCriteria.get(id) !== text) materialDifferences.push(`criteria.changed.${id}`);
  }
  for (const id of recordedCriteria.keys()) {
    if (!currentCriteria.has(id)) materialDifferences.push(`criteria.removed.${id}`);
  }

  const recordedDependencies = new Set(recorded.dependencyIssueIds);
  for (const dependency of current.dependencyIssueIds) {
    if (!recordedDependencies.has(dependency)) materialDifferences.push(`dependencies.added.${dependency}`);
  }

  if (recorded.title !== current.title) cosmeticDifferences.push('title');
  if (recorded.priority !== current.priority) cosmeticDifferences.push('priority');

  return {
    kind: materialDifferences.length > 0 ? 'Material' : cosmeticDifferences.length > 0 ? 'Cosmetic' : 'Unchanged',
    materialDifferences,
    cosmeticDifferences,
    recordedFingerprint,
    currentFingerprint,
  };
}

/** Reconciliation choices recorded by the owner after a material scope change. */
export type ScopeReconciliationChoice =
  | 'AdoptRevisedScope'
  | 'KeepPendingClarification'
  | 'ProposeFollowUpIssue';

export interface ScopeReconciliation {
  readonly choice: ScopeReconciliationChoice;
  /** Set when the owner chose to raise separate work. */
  readonly followUpNote: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly comparison: ScopeComparison;
}

export interface RunStartContext {
  readonly scope: ScopeSnapshot;
  readonly baseSha: CommitSha;
  readonly profileVersionId: string;
  readonly procedureVersionId: string;
}

/**
 * The full captured run context (F12-AC1): issue content, semantic fingerprint,
 * retrieval time and the selected profile/procedure versions.
 */
export interface CapturedRunContext {
  readonly scope: ScopeSnapshot;
  readonly scopeFingerprintValue: Fingerprint;
  readonly baseSha: CommitSha;
  readonly profileVersionId: string;
  readonly procedureVersionId: string;
  readonly capturedAt: string;
}

export function captureRunContext(
  context: RunStartContext,
  capturedAt: string,
): CapturedRunContext {
  return {
    scope: context.scope,
    scopeFingerprintValue: scopeFingerprint(context.scope),
    baseSha: context.baseSha,
    profileVersionId: context.profileVersionId,
    procedureVersionId: context.procedureVersionId,
    capturedAt,
  };
}
