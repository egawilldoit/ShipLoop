import type { CapabilityDeclaration, CapabilityKind } from '../capability.ts';
import type { DomainError, Result } from '../result.ts';
import { err, ok } from '../result.ts';

/**
 * The enforced capability boundary (F03-AC5, F13-AC3, N02-AC3, F20-AC5).
 *
 * The specification is explicit that a prompt saying "do not merge" is not
 * enforcement. Delivery authorization is therefore decided here, as a pure
 * function of mode, capability, grant list and role, and the controller must
 * ask this function rather than interpret the granted set itself.
 *
 * Two protections are separate and both live here:
 *   - a coding-stage actor can never reach production delivery or change owner
 *     acceptance, regardless of what a mode or a grant list happens to contain;
 *   - only an owner may change which checks are required, so the coding agent
 *     cannot delete the gate that its own work has to pass.
 */

/** Actor kinds that may request a capability. */
export type ActorRole = 'Owner' | 'CodingAgent' | 'DeliveryExecutor';

export const JOB_MODES = ['Plan', 'Investigate', 'Build', 'Test', 'Review'] as const;
export type JobMode = (typeof JOB_MODES)[number];

/**
 * Operations that are not provider capabilities at all.
 *
 * Acceptance and verification policy live in ShipLoop rather than in an adapter,
 * so expressing them as CapabilityKind would put an owner-only decision inside a
 * provider capability vocabulary. They are declared here so the boundary covers
 * every owner-only operation, not only the ones an adapter could model.
 */
export const OWNER_ONLY_OPERATIONS = [
  'Acceptance:Decide',
  'Acceptance:Withdraw',
  'Policy:ChangeRequiredChecks',
] as const;
export type OwnerOnlyOperation = (typeof OWNER_ONLY_OPERATIONS)[number];

export type RequestedCapability = CapabilityKind | OwnerOnlyOperation;

export interface JobModeDeclaration {
  readonly mode: JobMode;
  readonly description: string;
  readonly capabilities: readonly CapabilityKind[];
  /** Always false: no mode implies merge or release authority (F13-AC3). */
  readonly impliesDeliveryAuthority: false;
}

/**
 * Declared capabilities per mode.
 *
 * No entry contains Git:MergeWithPrecondition or Deployment:Execute, and the
 * only Deployment capability declared anywhere is the read-only identity lookup
 * an investigation needs to compare a live deployment against a candidate.
 * Delivery is therefore not reachable by choosing a mode, which is why the
 * boundary does not depend on a mode having been configured carefully.
 */
export const JOB_MODE_DECLARATIONS: Readonly<Record<JobMode, JobModeDeclaration>> = Object.freeze({
  Plan: Object.freeze({
    mode: 'Plan',
    description: 'Read scope and repository context, then propose a plan without writing code.',
    capabilities: Object.freeze(['Ticket:ReadScope', 'Git:ReadRepository', 'Git:ReadChecks'] as const),
    impliesDeliveryAuthority: false,
  }),
  Investigate: Object.freeze({
    mode: 'Investigate',
    description: 'Read-only investigation of code, checks and live external state.',
    capabilities: Object.freeze([
      'Ticket:ReadScope',
      'Git:ReadRepository',
      'Git:ReadChecks',
      'Deployment:ReadIdentity',
    ] as const),
    impliesDeliveryAuthority: false,
  }),
  Build: Object.freeze({
    mode: 'Build',
    description: 'Write code in the isolated workspace, push a branch and maintain a linked draft.',
    capabilities: Object.freeze([
      'Ticket:ReadScope',
      'Ticket:PublishIssue',
      'Ticket:UpdateManagedProgress',
      'Ticket:RequestTransition',
      'Git:ReadRepository',
      'Git:ReadChecks',
      'Git:PushBranch',
      'Git:CreateDraft',
      'Git:UpdateDraft',
      'Engine:VersionCheck',
      'Engine:StartScoped',
      'Engine:StopGraceful',
      'Engine:ResumeSession',
      'Engine:ReportUsage',
    ] as const),
    impliesDeliveryAuthority: false,
  }),
  Test: Object.freeze({
    mode: 'Test',
    description: 'Execute configured checks and record evidence for the current candidate.',
    capabilities: Object.freeze([
      'Ticket:ReadScope',
      'Ticket:UpdateManagedProgress',
      'Git:ReadRepository',
      'Git:ReadChecks',
      'Git:PushBranch',
      'Git:UpdateDraft',
      'Engine:VersionCheck',
      'Engine:StartScoped',
      'Engine:StopGraceful',
      'Engine:ResumeSession',
      'Engine:ReportUsage',
    ] as const),
    impliesDeliveryAuthority: false,
  }),
  Review: Object.freeze({
    mode: 'Review',
    description: 'Inspect the diff and report findings without changing the candidate.',
    capabilities: Object.freeze([
      'Ticket:ReadScope',
      'Ticket:PublishIssue',
      'Ticket:UpdateManagedProgress',
      'Git:ReadRepository',
      'Git:ReadChecks',
      'Engine:StartScoped',
      'Engine:StopGraceful',
      'Engine:ReportUsage',
    ] as const),
    impliesDeliveryAuthority: false,
  }),
});

/**
 * Privileged delivery operations (F03-AC5).
 *
 * Derived from the capability vocabulary's own `privileged` marker rather than
 * from a second hard-coded list, so a newly declared privileged capability is
 * covered by the boundary by construction.
 */
export function isPrivilegedDelivery(kind: CapabilityKind, declarations?: readonly CapabilityDeclaration[]): boolean {
  if (declarations !== undefined) {
    const declared = declarations.find((declaration) => declaration.kind === kind);
    if (declared !== undefined) return declared.privileged;
  }
  return kind === 'Git:MergeWithPrecondition' || kind.startsWith('Deployment:Execute');
}

export function isOwnerOnlyOperation(requested: RequestedCapability): requested is OwnerOnlyOperation {
  return (OWNER_ONLY_OPERATIONS as readonly string[]).includes(requested);
}

export type GrantDenialReason =
  | 'OwnerOnlyOperation'
  | 'DeliveryRequiresOwnerAuthorization'
  | 'NotInModeCapabilitySet'
  | 'NotGranted';

export type GrantDecision =
  | {
      readonly allowed: true;
      readonly mode: JobMode;
      readonly capability: RequestedCapability;
      readonly privileged: boolean;
    }
  | {
      readonly allowed: false;
      readonly reason: GrantDenialReason;
      readonly explanation: string;
    };

/**
 * The single decision point for "may this actor do this, now".
 *
 * Owner-only operations are refused before the mode or the grant list is
 * consulted, so no configuration can widen them. Privileged delivery is refused
 * for every non-owner role for the same reason: the coding role is denied
 * production delivery even if a mode, a grant list and a prompt all agree
 * (N02-AC3). Individual authorization for a specific merge or release is decided
 * separately against a subject fingerprint.
 */
export function evaluateGrant(input: {
  readonly mode: JobMode;
  readonly requestedCapability: RequestedCapability;
  readonly grantedCapabilities: readonly CapabilityKind[];
  readonly actorRole: ActorRole;
  readonly declarations?: readonly CapabilityDeclaration[];
}): GrantDecision {
  const { requestedCapability: requested, mode, actorRole } = input;

  if (isOwnerOnlyOperation(requested)) {
    return {
      allowed: false,
      reason: 'OwnerOnlyOperation',
      explanation: `${requested} is an owner decision. No job mode or capability grant can authorize it.`,
    };
  }

  const privileged = isPrivilegedDelivery(requested, input.declarations);
  if (privileged && actorRole !== 'Owner') {
    return {
      allowed: false,
      reason: 'DeliveryRequiresOwnerAuthorization',
      explanation: `${requested} is a privileged delivery action and the ${actorRole} role holds no delivery authority.`,
    };
  }

  const declaration = JOB_MODE_DECLARATIONS[mode];
  if (!declaration.capabilities.includes(requested)) {
    return {
      allowed: false,
      reason: 'NotInModeCapabilitySet',
      explanation: `${mode} mode does not declare ${requested}.`,
    };
  }

  if (!input.grantedCapabilities.includes(requested)) {
    return {
      allowed: false,
      reason: 'NotGranted',
      explanation: `${requested} is declared by ${mode} mode but was not granted to this job.`,
    };
  }

  return { allowed: true, mode, capability: requested, privileged };
}

export interface RequiredCheckRule {
  readonly checkId: string;
  readonly name: string;
  readonly required: boolean;
}

/**
 * A profile's required-check policy (F20-AC5).
 *
 * `revision` exists so a policy change is an additional recorded fact rather
 * than an edit: the review card can show which revision a verdict was computed
 * against and a downgrade cannot be indistinguishable from the original policy.
 */
export interface RequiredCheckPolicy {
  readonly projectId: string;
  readonly revision: number;
  readonly checks: readonly RequiredCheckRule[];
  readonly changedBy: string;
  readonly changedAt: string;
  readonly reason: string;
}

export type RequiredCheckChangeAction = 'Require' | 'DropRequirement' | 'DowngradeToAdvisory';

/**
 * The blocking checks for a profile, for the review card (F20-AC5).
 *
 * Only rules marked required are returned, so a consumer listing checks cannot
 * accidentally treat an advisory rule as a gate, and an omitted rule is absent
 * rather than silently Passed.
 */
export function requiredChecksFor(policy: RequiredCheckPolicy): readonly RequiredCheckRule[] {
  return policy.checks.filter((rule) => rule.required);
}

/**
 * Applies a required-check policy change.
 *
 * Only the owner may change the policy. A coding actor receives Forbidden, which
 * is the enforcement of F20-AC5: the coding agent cannot remove a required gate
 * in order to pass its own work, and it cannot do so by editing the profile
 * either. An owner change produces the next revision rather than mutating the
 * current one, so the gate that was in force stays inspectable.
 */
export function evaluateRequiredCheckPolicy(input: {
  readonly policy: RequiredCheckPolicy;
  readonly action: RequiredCheckChangeAction;
  readonly checkId: string;
  readonly actorRole: ActorRole;
  readonly actorId: string;
  readonly now: string;
  readonly reason: string;
}): Result<RequiredCheckPolicy> {
  const { policy, action, checkId, actorRole } = input;
  if (actorRole !== 'Owner') {
    return err<DomainError>({
      code: 'Forbidden',
      reason: `Required-check policy is owner-controlled; the ${actorRole} role cannot change it.`,
    });
  }

  const existing = policy.checks.find((rule) => rule.checkId === checkId);
  const required = action === 'Require';

  if (existing === undefined) {
    if (!required) {
      return err<DomainError>({
        code: 'NotFound',
        reason: `No check policy exists for "${checkId}".`,
      });
    }
    return ok<RequiredCheckPolicy>({
      ...policy,
      revision: policy.revision + 1,
      checks: [...policy.checks, { checkId, name: checkId, required: true }],
      changedBy: input.actorId,
      changedAt: input.now,
      reason: input.reason,
    });
  }

  if (existing.required === required) {
    return err<DomainError>({
      code: 'Conflict',
      reason: `Check "${checkId}" is already ${required ? 'required' : 'not required'}.`,
      expected: String(required),
      actual: String(existing.required),
    });
  }

  return ok<RequiredCheckPolicy>({
    ...policy,
    revision: policy.revision + 1,
    checks: policy.checks.map((rule) => (rule.checkId === checkId ? { ...rule, required } : rule)),
    changedBy: input.actorId,
    changedAt: input.now,
    reason: input.reason,
  });
}