/**
 * Shared adapter contract primitives.
 *
 * Every provider adapter (ticket, Git, deployment, engine, verification) speaks
 * through the same three shapes: an `AdapterCapabilities` declaration, an
 * `AdapterContext` that carries correlation and the redaction seam, and
 * `Result<T, DomainError>` returns. Keeping them here is what stops each adapter
 * from inventing its own way of saying "this provider cannot do that" or "I do
 * not know whether that write landed".
 *
 * This module owns no lifecycle policy and no ticket database (ARCHITECTURE
 * package table). It owns only the vocabulary an adapter and its caller must
 * agree on before any provider call happens.
 */

import type {
  CapabilityDeclaration,
  CapabilityKind,
  CommitSha,
  ConnectorId,
  Fingerprint,
  OperationId,
  Result,
  UnavailableError,
} from '@shiploop/domain';

export type AdapterKind = 'Ticket' | 'Git' | 'Deployment' | 'Engine' | 'Verification';

/**
 * Protocol version of these contracts.
 *
 * ARCHITECTURE requires protocol versions and runtime compatibility to be tested
 * at the boundary, so the version is data rather than a comment: an adapter
 * reports the contract version it implements and a mismatch is a compatibility
 * failure, not a coercion (ARCHITECTURE, "Interfaces to establish with each
 * slice").
 */
export const ADAPTER_CONTRACT_VERSION = 1;

export const ADAPTER_CONTRACT_VERSIONS: Readonly<Record<AdapterKind, number>> = {
  Ticket: ADAPTER_CONTRACT_VERSION,
  Git: ADAPTER_CONTRACT_VERSION,
  Deployment: ADAPTER_CONTRACT_VERSION,
  Engine: ADAPTER_CONTRACT_VERSION,
  Verification: ADAPTER_CONTRACT_VERSION,
};

/**
 * Capability kinds that name a privileged delivery action.
 *
 * These are the kinds a coding session must never hold (F03-AC5, N02-AC3). The
 * union is derived from this list so a grant typed as `CodingSessionCapability`
 * cannot name a delivery action at all. If `CapabilityKind` gains another
 * delivery kind, add it here and the type boundary closes again.
 */
export const PRIVILEGED_CAPABILITY_KINDS = ['Git:MergeWithPrecondition', 'Deployment:Execute'] as const;

export type PrivilegedCapabilityKind = (typeof PRIVILEGED_CAPABILITY_KINDS)[number];

/** Capability kinds a coding stage session may hold. Delivery kinds are absent by construction. */
export type CodingSessionCapability = Exclude<CapabilityKind, PrivilegedCapabilityKind>;

function isPrivilegedCapability(kind: CapabilityKind): kind is PrivilegedCapabilityKind {
  return (PRIVILEGED_CAPABILITY_KINDS as readonly CapabilityKind[]).includes(kind);
}

/**
 * Delivery kinds that must be absent from a coding stage grant.
 *
 * Used by the capability boundary check (F03-AC5, N02-AC3) so a denied
 * invocation is a tested refusal rather than a prompt asking the model to behave.
 */
export function deniedCodingCapabilities(
  granted: readonly CapabilityKind[],
): readonly PrivilegedCapabilityKind[] {
  return granted.filter(isPrivilegedCapability);
}

/** The subset of an adapter's declaration list that performs privileged delivery writes. */
export function declaredPrivilegedCapabilities(
  declarations: readonly CapabilityDeclaration[],
): readonly CapabilityKind[] {
  return declarations
    .filter((declaration) => declaration.privileged && declaration.supported)
    .map((declaration) => declaration.kind);
}

export interface AdapterCapabilities {
  readonly kind: AdapterKind;
  readonly contractVersion: number;
  /**
   * Every kind this adapter may perform, including the ones it cannot. An
   * unsupported entry carries the owner-visible limitation so the UI and
   * controller can reject the operation up front instead of half way through a
   * delivery (mvp-spec 7 "Provider contracts", F03-AC2).
   */
  readonly declarations: readonly CapabilityDeclaration[];
}

/** Runtime and protocol compatibility, observed rather than assumed (F04-AC2). */
export interface AdapterCompatibility {
  readonly kind: AdapterKind;
  readonly contractVersion: number;
  /** Provider or engine reported version, sanitized. Null when it reports none. */
  readonly runtimeVersion: string | null;
  readonly compatible: boolean;
  readonly detail: string;
  readonly observedAt: string;
}

export type AdapterLogLevel = 'Debug' | 'Info' | 'Warn' | 'Error';

export type AdapterLogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface AdapterLogRecord {
  readonly level: AdapterLogLevel;
  /** Already passed through `AdapterContext.redact`. */
  readonly message: string;
  readonly correlationId: string;
  readonly operationId: OperationId;
  /** Field values are redacted before they reach this record (N02-AC2). */
  readonly fields: AdapterLogFields;
}

/**
 * Injected logger. Adapters never write to a process stream directly, so a log
 * assertion can prove a seeded secret is absent from ordinary logs (N02-AC2).
 */
export interface AdapterLogger {
  emit(record: AdapterLogRecord): void;
}

/** Injected clock, so timestamps in adapter output are testable rather than ambient. */
export interface AdapterClock {
  now(): string;
  /** Monotonic milliseconds since an unspecified origin; never wall clock. */
  elapsedMs(): number;
}

/**
 * Ambient facts every adapter call receives.
 *
 * `redact` is a seam rather than a helper inside each adapter: adapter output
 * flows into issues, PR bodies, logs, screenshots and exports, so the same
 * configured credential patterns must be applied where the text is produced
 * (N02-AC2, mvp-spec 7 "Authorization and data handling").
 */
export interface AdapterContext {
  readonly correlationId: string;
  /** Stable identity of this external write, used to reconcile a lost response (F30-AC5). */
  readonly operationId: OperationId;
  readonly clock: AdapterClock;
  readonly logger: AdapterLogger;
  readonly signal: AbortSignal;
  readonly redact: (text: string) => string;
}

/** Builds a log record with every string value and the message redacted (N02-AC2). */
export function redactedLogRecord(
  context: AdapterContext,
  level: AdapterLogLevel,
  message: string,
  fields: AdapterLogFields = {},
): AdapterLogRecord {
  const redactedFields: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    redactedFields[key] = typeof value === 'string' ? context.redact(value) : value;
  }
  return {
    level,
    message: context.redact(message),
    correlationId: context.correlationId,
    operationId: context.operationId,
    fields: redactedFields,
  };
}

/**
 * The typed refusal for an operation this adapter cannot perform.
 *
 * Returning `Unavailable` rather than a generic failure is what keeps an
 * unsupported action from being presented as a successful one (L03-AC3,
 * F22-AC3 for deployment).
 */
export function unsupportedOperation(
  kind: AdapterKind,
  operation: string,
  limitation: string,
): UnavailableError {
  return { code: 'Unavailable', reason: `${kind}.${operation} is unavailable: ${limitation}` };
}

export type ArtifactKind =
  | 'CheckOutput'
  | 'Screenshot'
  | 'BrowserTrace'
  | 'HttpTranscript'
  | 'Log'
  | 'Diff'
  | 'Report';

/**
 * Reference to an artifact an adapter produced.
 *
 * `sanitized` is a literal `true` so a raw, unredacted artifact cannot be named
 * in a type. Raw provider output frequently contains credentials, so the only
 * artifact an adapter may point at is one that has already been redacted
 * (N02-AC2, and the `artifactRef` note on `CheckRecord`).
 */
export interface ArtifactReference {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  /** Artifact store reference or sanitized public URL, never a credential-bearing link. */
  readonly uri: string;
  readonly mediaType: string;
  readonly byteLength: number | null;
  readonly producedAt: string;
  readonly sanitized: true;
}

/**
 * Which environment an observation came from.
 *
 * Production is representable only so a live post-release smoke check can be
 * labelled as such; fixtures for production are never borrowed to make a
 * verification pass (mvp-spec 7 "Authorization and data handling").
 */
export type VerificationEnvironment = 'Dev' | 'Preview' | 'Production';

/** Test-only access to the running application. Never a production fixture (mvp-spec 7). */
export type TestAccess =
  | { readonly kind: 'None' }
  | {
      readonly kind: 'DevCredentials';
      readonly label: string;
      /** Credential reference, never the credential value (F03-AC3). */
      readonly secretRef: string;
    };

/**
 * The isolated workspace a bounded operation runs in.
 *
 * A worktree does not isolate services, databases or ports, so the workspace
 * carries its own ports and service endpoints (ARCHITECTURE, F14).
 */
export interface ExecutionWorkspace {
  readonly workspaceId: string;
  readonly absolutePath: string;
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  readonly environmentFingerprint: Fingerprint;
  readonly scopeFingerprint: Fingerprint;
  readonly isolatedPorts: Readonly<Record<string, number>>;
  readonly serviceEndpoints: readonly { readonly name: string; readonly baseUrl: string }[];
  readonly testAccess: TestAccess;
}

/** Identity and compatibility surface every adapter must provide. */
export interface AdapterIdentity {
  readonly kind: AdapterKind;
  readonly connectorId: ConnectorId;
  capabilities(): AdapterCapabilities;
  checkCompatibility(context: AdapterContext): Promise<Result<AdapterCompatibility>>;
}

export * from './ticket.ts';
export * from './git.ts';
export * from './candidate-link.ts';
export * from './deployment.ts';
export * from './engine.ts';
export * from './verification.ts';
