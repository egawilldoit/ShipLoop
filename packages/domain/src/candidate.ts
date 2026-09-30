import type { CommitSha, Fingerprint } from './ids.ts';
import { fingerprint } from './fingerprint.ts';

/**
 * Candidate identity (mvp-spec 3, F20-AC3, F24-AC4, F25-AC3, F26, F27-AC3).
 *
 * A candidate is the code and artifacts proposed for testing or delivery. Its
 * identity deliberately includes every input that can change the meaning of the
 * evidence collected for it: full head/base SHAs, the scope revision, the profile
 * and procedure versions, the environment fingerprint, component identities and
 * the deployment identity.
 *
 * The consequence that matters: reusing approval for a replacement build is
 * impossible, because a replacement build has a different fingerprint even when
 * the pull request number is unchanged.
 */

export interface ComponentIdentity {
  /** Stable component key from the project profile, e.g. "web" or "api". */
  readonly component: string;
  /** Provider-side deployment identity, or null when the component is not deployed. */
  readonly deploymentId: string | null;
  /** Deployment URL that identifies this specific deployment. */
  readonly deploymentUrl: string | null;
  /** Preview environment this deployment belongs to. */
  readonly environment: string;
}

export interface CandidateIdentity {
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  /** Semantic scope revision this candidate was built against. */
  readonly scopeFingerprint: Fingerprint;
  readonly profileVersionId: string;
  readonly procedureVersionId: string;
  /** Machine/workspace configuration digest: runtime, dependency lock digest, ports. */
  readonly environmentFingerprint: Fingerprint;
  /** Required-policy revision. A policy change invalidates the affected results. */
  readonly policyFingerprint: Fingerprint;
  readonly components: readonly ComponentIdentity[];
}

export interface CandidateIdentityInput {
  headSha: CommitSha;
  baseSha: CommitSha;
  scopeFingerprint: Fingerprint;
  profileVersionId: string;
  procedureVersionId: string;
  environmentFingerprint: Fingerprint;
  policyFingerprint: Fingerprint;
  components?: readonly ComponentIdentity[];
}

function normalizeComponent(component: ComponentIdentity): ComponentIdentity {
  return {
    component: component.component,
    deploymentId: component.deploymentId,
    deploymentUrl: component.deploymentUrl,
    environment: component.environment,
  };
}

/**
 * The fingerprint of a candidate identity.
 *
 * Components are sorted by name so that discovery order cannot change the result,
 * and every field participates so that any changed input yields a different value.
 */
export function candidateFingerprint(identity: CandidateIdentityInput): Fingerprint {
  const components = [...(identity.components ?? [])]
    .map(normalizeComponent)
    .sort((left, right) => (left.component < right.component ? -1 : left.component > right.component ? 1 : 0));

  return fingerprint({
    headSha: identity.headSha,
    baseSha: identity.baseSha,
    scopeFingerprint: identity.scopeFingerprint,
    profileVersionId: identity.profileVersionId,
    procedureVersionId: identity.procedureVersionId,
    environmentFingerprint: identity.environmentFingerprint,
    policyFingerprint: identity.policyFingerprint,
    components,
  });
}

/** The inputs whose change invalidates evidence and decisions for a candidate. */
export type StaleReason =
  | 'HeadChanged'
  | 'BaseChanged'
  | 'ScopeChanged'
  | 'ProfileVersionChanged'
  | 'ProcedureVersionChanged'
  | 'EnvironmentChanged'
  | 'PolicyChanged'
  | 'ComponentChanged'
  | 'DeploymentReplaced';

export interface StalenessAssessment {
  readonly stale: boolean;
  readonly reasons: readonly StaleReason[];
  /** Per-component detail, present when the reason is component or deployment related. */
  readonly componentDetail: readonly { readonly component: string; readonly reason: StaleReason }[];
}

/**
 * Compares a recorded identity against current live facts.
 *
 * Used by F12 (external scope changes), F20-AC3 (check freshness), F22-AC5
 * (replaced deployments), F24-AC4 and F25-AC3 (stale decisions). Returns every
 * differing input rather than stopping at the first, because the owner needs to
 * see the full reason a decision is no longer eligible.
 */
export function assessStaleness(
  recorded: CandidateIdentity,
  current: CandidateIdentityInput,
): StalenessAssessment {
  const reasons: StaleReason[] = [];
  const componentDetail: { component: string; reason: StaleReason }[] = [];

  if (recorded.headSha !== current.headSha) reasons.push('HeadChanged');
  if (recorded.baseSha !== current.baseSha) reasons.push('BaseChanged');
  if (recorded.scopeFingerprint !== current.scopeFingerprint) reasons.push('ScopeChanged');
  if (recorded.profileVersionId !== current.profileVersionId) reasons.push('ProfileVersionChanged');
  if (recorded.procedureVersionId !== current.procedureVersionId) reasons.push('ProcedureVersionChanged');
  if (recorded.environmentFingerprint !== current.environmentFingerprint) reasons.push('EnvironmentChanged');
  if (recorded.policyFingerprint !== current.policyFingerprint) reasons.push('PolicyChanged');

  const recordedComponents = new Map(recorded.components.map((entry) => [entry.component, entry]));
  for (const component of current.components ?? []) {
    const previous = recordedComponents.get(component.component);
    if (!previous) {
      reasons.push('ComponentChanged');
      componentDetail.push({ component: component.component, reason: 'ComponentChanged' });
      continue;
    }
    const replaced =
      previous.deploymentId !== component.deploymentId ||
      previous.deploymentUrl !== component.deploymentUrl ||
      previous.environment !== component.environment;
    if (replaced) {
      if (!reasons.includes('DeploymentReplaced')) reasons.push('DeploymentReplaced');
      componentDetail.push({ component: component.component, reason: 'DeploymentReplaced' });
    }
  }
  for (const component of recorded.components) {
    if (!(current.components ?? []).some((entry) => entry.component === component.component)) {
      reasons.push('ComponentChanged');
      componentDetail.push({ component: component.component, reason: 'ComponentChanged' });
    }
  }

  return { stale: reasons.length > 0, reasons, componentDetail };
}
