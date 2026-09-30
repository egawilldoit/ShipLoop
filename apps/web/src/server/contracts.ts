/**
 * The controller surface this HTTP layer depends on.
 *
 * `packages/controller` owns the use cases and is written independently of the web
 * server, so the boundary is declared here as ports rather than imported (F01,
 * F02, F03: apps/web owns the authentication boundary and thin HTTP handlers,
 * packages/controller owns API use cases). Declaring the shape locally keeps both
 * sides honest: a use case that cannot be expressed here is a use case the
 * transport cannot answer, and nothing in this file reaches around the use case to
 * touch storage.
 *
 * Every port returns a typed `Result`. Expected refusals are values, never thrown
 * exceptions, because each one maps to a different status code and a different next
 * step for the owner (`http-error.ts`). No port returns a credential value: the
 * connector view carries a credential *reference* and its digest (F03-AC3).
 */

import type {
  CapabilityKind,
  ConnectorId,
  DomainError,
  OwnerId,
  ProfileVersionId,
  ProjectId,
  Result,
} from '@shiploop/domain';

/**
 * Narrows an identifier that arrived as validated HTTP text.
 *
 * The route schema has already proved the shape before this is called, so the
 * assertion records a boundary that was actually checked rather than papering
 * over an unvalidated value.
 */
export function asProjectId(value: string): ProjectId {
  return value as ProjectId;
}

/** Narrows validated HTTP text to a connector identifier. See `asProjectId`. */
export function asConnectorId(value: string): ConnectorId {
  return value as ConnectorId;
}

/**
 * The identity a request is allowed to act as, derived from a valid session.
 *
 * Carries no owner data beyond identity: anything a handler needs that is not "who is
 * asking" has to come from a use case, which is what keeps an unauthorized request
 * from being answered out of session state (F01-AC1).
 */
export interface AuthorizedOwner {
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly sessionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/**
 * The stored form of a session.
 *
 * Only `tokenDigest` is durable, matching the domain rule that the plaintext token
 * leaves the process exactly once inside `Set-Cookie` (F01-AC2). `revokedAt` is
 * what makes sign-out authoritative: the web layer calls `authorizeSession` on
 * every request, so a revoked row refuses access no matter how correct the token is.
 */
export interface StoredSessionRecord {
  readonly sessionId: string;
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  /** Null until the first authorized request; the idle deadline measures from it. */
  readonly lastActivityAt: string | null;
}

export interface CreateSessionCommand {
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  /**
   * Absolute and idle limits are the controller's policy: it must apply the domain
   * `sessionDeadlines` so a stored row states the limits it was created under.
   */
  readonly absoluteTtlSeconds: number;
  readonly idleTimeoutSeconds: number;
}

export interface RevokeSessionCommand {
  readonly sessionId: string;
  readonly revokedAt: string;
}

export interface TouchSessionCommand {
  readonly sessionId: string;
  readonly lastActivityAt: string;
}

/**
 * Session lifecycle.
 *
 * The controller stores and revokes; the web layer decides. Authorization itself
 * runs in the web layer through the domain `authorizeSession`, because the cookie
 * is a transport fact and the revocation check must sit on the request path
 * (F01-AC1, F01-AC2).
 */
export interface SessionUseCases {
  /** Resolves a presented token to its stored row. Refuses an unknown digest. */
  loadByToken(token: string): Promise<Result<StoredSessionRecord, DomainError>>;
  /** Persists a new session. The plaintext token is never passed in or stored. */
  create(command: CreateSessionCommand): Promise<Result<StoredSessionRecord, DomainError>>;
  /** Server-side revocation. Clearing the cookie is not a substitute (F01-AC2). */
  revoke(command: RevokeSessionCommand): Promise<Result<StoredSessionRecord, DomainError>>;
  /** Records activity so the idle deadline stays meaningful. */
  touch(command: TouchSessionCommand): Promise<Result<null, DomainError>>;
}

export interface ProvisionOwnerCommand {
  readonly displayName: string;
  readonly password: string;
  readonly at: string;
}

export interface OwnerView {
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly createdAt: string;
}

export interface SignInCommand {
  /** Display name or another owner identifier; never assumed to exist. */
  readonly identifier: string;
  readonly password: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  readonly absoluteTtlSeconds: number;
  readonly idleTimeoutSeconds: number;
}

/**
 * What a successful sign-in yields.
 *
 * Only the session comes back: the web layer minted the token, so it is the only
 * holder of the plaintext and the only component that may place it on the wire
 * (F01-AC4).
 */
export interface SignInGrant {
  readonly session: StoredSessionRecord;
}

export interface OwnerUseCases {
  provision(command: ProvisionOwnerCommand): Promise<Result<OwnerView, DomainError>>;
  /**
   * Verifies a credential and opens a session in one step.
   *
   * A wrong password and an unknown owner must produce indistinguishable results
   * here, otherwise this port is an owner-existence oracle (N02-AC1). The web layer
   * also collapses both refusals into one response, so neither side can leak.
   */
  signIn(command: SignInCommand): Promise<Result<SignInGrant, DomainError>>;
}

export type ProfileConnectorKind = 'Ticket' | 'Git' | 'Deployment' | 'Engine';

export type ProfileConnectorState = 'Unconfigured' | 'Healthy' | 'Degraded' | 'Revoked' | 'Unreachable';

export interface PreviewComponentReference {
  readonly component: string;
  readonly environment: string;
}

export interface ProfileReferences {
  readonly repository: string;
  readonly ticketProvider: string;
  readonly ticketTeamKey: string | null;
  readonly baseBranch: string;
  readonly targetBranch: string;
  readonly deploymentProvider: string;
  readonly engine: string;
  readonly previewComponents: readonly PreviewComponentReference[];
}

export interface ProfilePolicy {
  readonly requiredChecks: readonly string[];
  /** Delivery is always owner-authorized; a profile may not grant it (F03-AC5). */
  readonly deliveryBehavior: 'ManualAuthorizationOnly';
  readonly maxFixPasses: number;
  readonly workspaceIsolation: 'WorktreeAndDataDirectory';
  readonly capabilityVersion: number;
}

export interface ProfileEnvironmentReference {
  readonly runtime: string;
  readonly ports: readonly number[];
  /** Names of credentials the recipe needs. Never values (F03-AC3). */
  readonly secretReferences: readonly string[];
}

/**
 * The profile body as the transport carries it.
 *
 * `secretReferences` holds names only; a profile is project configuration and is
 * never a place a credential is stored (F02-AC1, F03-AC3).
 */
export interface ProfileContent {
  readonly references: ProfileReferences;
  readonly policy: ProfilePolicy;
  readonly recipe: string;
  readonly environment: ProfileEnvironmentReference;
}

/**
 * One immutable profile version.
 *
 * Saving always appends: a run names the version it used, so history has to stay
 * addressable rather than being overwritten (F02-AC3, F02-AC2).
 */
export interface ProfileVersionView {
  readonly profileVersionId: ProfileVersionId;
  readonly projectId: ProjectId;
  readonly versionNumber: number;
  readonly supersedesVersionId: ProfileVersionId | null;
  readonly content: ProfileContent;
  readonly contentFingerprint: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface SaveProfileVersionCommand {
  readonly projectId: ProjectId;
  readonly content: ProfileContent;
  readonly note: string | null;
  /**
   * Compare-and-set against the newest version. A stale editor must be refused
   * with a `Conflict`, never silently merged (F02-AC2, F24-AC4).
   */
  readonly expectedVersionNumber: number | null;
  readonly at: string;
  readonly actor: OwnerId;
}

export interface ProfileUseCases {
  saveVersion(command: SaveProfileVersionCommand): Promise<Result<ProfileVersionView, DomainError>>;
  /** Null when the project has no saved profile yet; the route answers 404 then. */
  currentVersion(projectId: ProjectId): Promise<Result<ProfileVersionView | null, DomainError>>;
  listVersions(projectId: ProjectId): Promise<Result<readonly ProfileVersionView[], DomainError>>;
}

export interface RegisterConnectorCommand {
  readonly projectId: ProjectId;
  readonly provider: string;
  readonly kind: ProfileConnectorKind;
  readonly resourceScope: string;
  /** A pointer into the credential store. A secret value must never arrive here (F03-AC3). */
  readonly credentialReference: string;
  readonly at: string;
  readonly actor: OwnerId;
}

export interface RevokeConnectorCommand {
  readonly connectorId: ConnectorId;
  readonly at: string;
  readonly reason: string;
  readonly actor: OwnerId;
}

/**
 * The owner-visible connector projection.
 *
 * Carries status, last-checked time, the read/write capability split and an
 * actionable error, because "is it connected" is not a question the owner can
 * answer from a boolean (F03-AC2). `credentialReference` is a pointer and
 * `credentialReferenceDigest` proves which pointer was used without repeating it
 * in an export (F03-AC3, F32-AC2).
 */
export interface ConnectorView {
  readonly connectorId: ConnectorId;
  readonly projectId: ProjectId;
  readonly provider: string;
  readonly kind: ProfileConnectorKind;
  readonly resourceScope: string;
  readonly credentialReference: string;
  readonly credentialReferenceDigest: string;
  readonly state: ProfileConnectorState;
  readonly error: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly reads: readonly CapabilityKind[];
  readonly writes: readonly CapabilityKind[];
  readonly unsupported: readonly { readonly kind: CapabilityKind; readonly limitation: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConnectorUseCases {
  /**
   * Registers a credential reference and probes the provider.
   *
   * Capabilities come from the adapter, never from the request body: a client that
   * could declare its own capabilities would be able to claim a merge authority it
   * does not hold (F03-AC2, F03-AC5).
   */
  register(command: RegisterConnectorCommand): Promise<Result<ConnectorView, DomainError>>;
  listForProject(projectId: ProjectId): Promise<Result<readonly ConnectorView[], DomainError>>;
  /**
   * Revocation must block later operations that depend on this connector; an
   * in-flight attempt keeps its work and reports the blocker (F03-AC4).
   */
  revoke(command: RevokeConnectorCommand): Promise<Result<ConnectorView, DomainError>>;
}

/** The whole injected surface. One argument, so a missing use case is a type error. */
export interface ControllerSurface {
  readonly owners: OwnerUseCases;
  readonly sessions: SessionUseCases;
  readonly profiles: ProfileUseCases;
  readonly connectors: ConnectorUseCases;
}

const REQUIRED_METHODS = {
  owners: ['provision', 'signIn'],
  sessions: ['loadByToken', 'create', 'revoke', 'touch'],
  profiles: ['saveVersion', 'currentVersion', 'listVersions'],
  connectors: ['register', 'listForProject', 'revoke'],
} as const satisfies Record<keyof ControllerSurface, readonly string[]>;

export type ControllerGroup = keyof typeof REQUIRED_METHODS;

/**
 * Structural check for a controller implementation loaded at runtime.
 *
 * The web server composes its controller from a module specifier, so the value
 * crossing this boundary is untrusted like any other external input. Checking the
 * shape here turns a wiring mistake into a startup failure with a named method
 * instead of a 500 on the owner's first request.
 */
export function isControllerSurface(value: unknown): value is ControllerSurface {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  for (const group of Object.keys(REQUIRED_METHODS) as ControllerGroup[]) {
    const port = candidate[group];
    if (typeof port !== 'object' || port === null) return false;
    const methods = port as Record<string, unknown>;
    for (const method of REQUIRED_METHODS[group]) {
      if (typeof methods[method] !== 'function') return false;
    }
  }
  return true;
}
