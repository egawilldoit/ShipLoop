/**
 * Adapter capability declarations (F03-AC2, F05-AC4, N05-AC2).
 *
 * An adapter states what it can and cannot do. The UI and controller reject
 * operations an adapter cannot support instead of discovering the limitation
 * halfway through a delivery, so provider differences stay visible rather than
 * being flattened into assumed parity.
 */

export type CapabilityKind =
  | 'Ticket:ReadScope'
  | 'Ticket:PublishIssue'
  | 'Ticket:UpdateManagedProgress'
  | 'Ticket:RequestTransition'
  | 'Git:ReadRepository'
  | 'Git:ReadChecks'
  | 'Git:PushBranch'
  | 'Git:CreateDraft'
  | 'Git:UpdateDraft'
  | 'Git:MergeWithPrecondition'
  | 'Deployment:Discover'
  | 'Deployment:ReadIdentity'
  | 'Deployment:Execute'
  | 'Deployment:VerifyDestination'
  | 'Engine:VersionCheck'
  | 'Engine:StartScoped'
  | 'Engine:StopGraceful'
  | 'Engine:ResumeSession'
  | 'Engine:ReportUsage';

export interface CapabilityDeclaration {
  readonly kind: CapabilityKind;
  readonly supported: boolean;
  /** Why it is unsupported, shown to the owner instead of a generic failure. */
  readonly limitation: string | null;
  /**
   * True when the operation is a privileged delivery action. Only an approved
   * delivery executor may receive these; the coding stage never holds them
   * (F03-AC5, N02-AC3).
   */
  readonly privileged: boolean;
  /** True when the provider offers a compare-and-set precondition for this write. */
  readonly supportsPrecondition: boolean;
}

export interface ConnectorHealth {
  readonly connectorId: string;
  readonly provider: string;
  readonly state: 'Healthy' | 'Degraded' | 'Revoked' | 'Unconfigured';
  /** Read capabilities the owner may rely on. */
  readonly reads: readonly CapabilityKind[];
  /** Write capabilities the owner may rely on. */
  readonly writes: readonly CapabilityKind[];
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
  /** Actionable message for expired or missing access. */
  readonly error: string | null;
}

export function capabilitiesFor(
  declarations: readonly CapabilityDeclaration[],
): {
  readonly reads: readonly CapabilityKind[];
  readonly writes: readonly CapabilityKind[];
  readonly unsupported: readonly { readonly kind: CapabilityKind; readonly limitation: string }[];
} {
  const supported = declarations.filter((declaration) => declaration.supported);
  return {
    reads: supported.filter((declaration) => !declaration.privileged).map((declaration) => declaration.kind),
    writes: supported.filter((declaration) => declaration.privileged).map((declaration) => declaration.kind),
    unsupported: declarations
      .filter((declaration) => !declaration.supported)
      .map((declaration) => ({ kind: declaration.kind, limitation: declaration.limitation ?? 'Not supported by this provider.' })),
  };
}

/** A missing required field name, for field-specific profile errors (F02-AC4). */
export interface ProfileFieldError {
  readonly field: string;
  readonly message: string;
  /** Capability the field requires, when the failure is capability driven. */
  readonly requiresCapability: CapabilityKind | null;
}

export function unsupportedCapabilityError(
  kind: CapabilityKind,
  limitation: string,
): ProfileFieldError {
  return { field: 'connectors', message: `${kind} is unavailable: ${limitation}`, requiresCapability: kind };
}
