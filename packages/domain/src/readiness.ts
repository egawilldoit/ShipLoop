/**
 * Readiness diagnosis (F09) and dependency planning (F08-AC4).
 *
 * Readiness is a recorded assessment against live facts, never a permanent
 * boolean or a percentage confidence score (F09-AC4). Every assessment states
 * what it looked at, so a later change in prerequisites produces a new assessment
 * that shows what changed.
 */

export type ReadinessVerdict = 'Ready' | 'NeedsInformation' | 'Blocked';

export type ReadinessArea =
  | 'Scope'
  | 'Criteria'
  | 'Repository'
  | 'Target'
  | 'Dependencies'
  | 'Verification'
  | 'Access';

export type ReadinessStatus = 'Satisfied' | 'Unmet' | 'Unknown';

export interface ReadinessFinding {
  readonly area: ReadinessArea;
  readonly status: ReadinessStatus;
  readonly reason: string;
  readonly remedy: string | null;
}

export interface ReadinessAssessment {
  readonly verdict: ReadinessVerdict;
  readonly findings: readonly ReadinessFinding[];
  /** Inputs this assessment observed, so a later comparison can show the delta. */
  readonly observedAt: string;
  readonly observationsDigest: string;
}

/**
 * Derives the verdict from the findings.
 *
 * An Unmet prerequisite blocks: build must be disabled when a required
 * prerequisite is absent (F09-AC2). Unknown is NeedsInformation rather than
 * Blocked, because a read-only investigation can still resolve the uncertainty.
 * A fully satisfied set with no open question is Ready, without inventing
 * blockers (F09-AC5).
 */
export function deriveReadiness(findings: readonly ReadinessFinding[]): ReadinessVerdict {
  if (findings.some((finding) => finding.status === 'Unmet')) return 'Blocked';
  if (findings.some((finding) => finding.status === 'Unknown')) return 'NeedsInformation';
  return 'Ready';
}

export interface DependencyNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

/**
 * Detects cyclic or unresolved dependencies (F08-AC4).
 *
 * A cycle is reported with the nodes involved so the UI can show it, and any
 * dependency referencing an unknown id is unresolved rather than silently
 * treated as satisfied.
 */
export function analyzeDependencies(
  nodes: readonly DependencyNode[],
): {
  readonly order: readonly string[];
  readonly cycles: readonly (readonly string[])[];
  readonly unresolved: readonly { readonly node: string; readonly dependsOn: string }[];
} {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const unresolved: { node: string; dependsOn: string }[] = [];
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) unresolved.push({ node: node.id, dependsOn: dependency });
    }
  }

  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const order: string[] = [];
  const stack: string[] = [];

  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dependency)) visit(dependency);
    }
    stack.pop();
    state.set(id, 'done');
    order.push(id);
  };

  for (const node of nodes) visit(node.id);

  return { order, cycles, unresolved };
}

/**
 * Whether a dependency marked Done can be treated as available (F09-AC3).
 *
 * A Done status without the required delivery evidence is not availability, so
 * the dependency stays unmet and the dependent work is not declared Ready.
 */
export function dependencyAvailable(input: {
  readonly status: 'Done' | 'InProgress' | 'Todo' | 'Canceled';
  readonly releaseReceiptRecorded: boolean;
  readonly requiresRelease: boolean;
}): { readonly available: boolean; readonly reason: string } {
  if (input.status === 'Canceled') {
    return { available: false, reason: 'The dependency was canceled.' };
  }
  if (input.status !== 'Done') {
    return { available: false, reason: `The dependency is ${input.status}.` };
  }
  if (input.requiresRelease && !input.releaseReceiptRecorded) {
    return {
      available: false,
      reason: 'The dependency is marked Done but has no release receipt, so its release is not confirmed.',
    };
  }
  return { available: true, reason: 'The dependency is Done and its required evidence exists.' };
}
