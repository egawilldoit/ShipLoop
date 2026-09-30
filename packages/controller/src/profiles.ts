/**
 * Owner identity, versioned project profiles, the capability boundary and the
 * reusable environment recipe (F01-AC1, F01-AC2, F02-AC1, F02-AC2, F02-AC3,
 * F02-AC4, F03-AC5, F04-AC1, F04-AC2, F04-AC3, N02-AC1, N02-AC3).
 *
 * The controller owns API use cases and privileged operations. It contains no
 * lifecycle policy and no provider SDK call: hashing, session rules, capability
 * grants and recipe validation come from `@shiploop/domain` and
 * `@shiploop/verification`, while every SQL statement comes from
 * `@shiploop/storage`. What remains here is the part only the controller can do:
 * decide whether a caller's request is admissible, hand the work to those layers,
 * and return their typed answer without inventing a second policy.
 *
 * Three refusals are deliberate:
 *
 *   - provisioning an owner twice is a `Conflict`, never a silent overwrite, so a
 *     repeat call cannot reset a live owner's credential (F01-AC1);
 *   - an unknown email and a wrong password produce one identical answer for one
 *     identical amount of work, so sign-in is not an account-existence oracle
 *     (N02-AC1);
 *   - an unauthorized caller is refused before any private row is read, so a
 *     profile cannot be reached without a session (F01-AC1).
 */

import {
  canonicalize,
  conflict,
  describeSessionRejection,
  err,
  evaluateGrant,
  evaluateSession,
  fingerprint,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  invalid,
  ok,
  redact,
  secretFreeReason,
  sessionDeadlines,
  verifyPassword,
} from '@shiploop/domain';
import type {
  ActorRole,
  CapabilityKind,
  DomainError,
  Fingerprint,
  JobMode,
  OwnerId,
  PasswordHash,
  ProcedureVersionId,
  ProfileVersionId,
  ProjectId,
  RequestedCapability,
  Result,
  ScryptParameters,
  SessionToken,
  SessionTokenDigest,
} from '@shiploop/domain';
import {
  implementationMayStart,
  nextVersion,
  recordVerification,
  recipeFingerprint,
  runPreflight,
  validateRecipe,
} from '@shiploop/verification';
import type {
  BoundedCommand,
  PreflightDeps,
  PreflightReport,
  RecipeProvenance,
  RecipeVersion,
  RecipeVersionContent,
} from '@shiploop/verification';
import type {
  ConnectorKind,
  OwnerRepository,
  ProcedureRepository,
  ProcedureVersion,
  ProjectProfileContent,
  ProjectProfileRepository,
  ProjectProfileVersion,
} from '@shiploop/storage';
import type { AdapterRegistry } from './connectors.ts';

/**
 * Injected time source.
 *
 * Every recorded instant in this layer comes from here, so a decision recorded in
 * a test replays identically and no use case reads ambient time (mvp-spec 7,
 * "All mutating client operations use stable operation identity and expected
 * current version").
 */
export interface ControllerClock {
  now(): string;
}

/**
 * The caller of a use case.
 *
 * `role` is an enforcement input, not a display label: the capability boundary
 * passes it to the domain's `evaluateGrant`, which refuses privileged delivery for
 * every non-owner role (F03-AC5, N02-AC3). A non-owner actor therefore cannot
 * obtain merge or release authority by holding a connector that declares it.
 */
export interface OwnerActor {
  readonly actorId: string;
  readonly role: ActorRole;
  readonly ownerId: OwnerId | null;
  readonly sessionId: string | null;
}

/**
 * A provisioned owner credential.
 *
 * The plaintext password never has this shape, so it cannot be passed where a
 * stored value is expected and cannot reach a column (F01-AC1).
 */
export interface OwnerCredentialRecord {
  readonly ownerId: OwnerId;
  readonly email: string;
  readonly passwordHash: PasswordHash;
  readonly updatedAt: string;
}

/**
 * Durable owner credential storage.
 *
 * A port rather than a bound table, so the encoding, comparison and no-oracle
 * rules are independent of where the row lives and the storage shape can change
 * without touching a use case.
 */
export interface OwnerCredentialStore {
  put(record: OwnerCredentialRecord): Result<OwnerCredentialRecord>;
  findByEmail(email: string): Result<OwnerCredentialRecord | null>;
  findByOwnerId(ownerId: OwnerId): Result<OwnerCredentialRecord | null>;
}

/**
 * The one sign-in refusal.
 *
 * A single string for both an unknown email and a wrong password: two messages
 * would turn sign-in into an account-existence oracle however well the timings
 * match (N02-AC1).
 */
export const SIGN_IN_REFUSAL = 'Sign-in failed. Check the email and password, then try again.';

/** Credential hashed for an unknown account, so the comparison work is the same. */
const DECOY_CREDENTIAL = 'shiploop-decoy-credential-value-for-equal-cost';

/**
 * A deliberately unparsable encoding used when the decoy cannot be derived.
 *
 * `verifyPassword` treats it as an unverifiable row: it still performs the full
 * default-cost derivation and still answers false, so the equal-cost property
 * survives even this branch (N02-AC1).
 */
const UNVERIFIABLE_DECOD = 'unverifiable-decod';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** A successful sign-in. The token leaves the process exactly once (F01-AC2). */
export interface OwnerSignIn {
  readonly ownerId: OwnerId;
  readonly sessionId: string;
  readonly sessionToken: SessionToken;
  /** Domain digest, so a caller can compare a presented token without storing it. */
  readonly sessionTokenDigest: SessionTokenDigest;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** The session a privileged request presented. */
export interface SessionCredential {
  readonly token: string;
}

export interface ProvisionOwnerInput {
  readonly ownerId: OwnerId;
  readonly email: string;
  readonly password: string;
  /** Recorded as the owner row's display name; defaults to the sign-in address. */
  readonly displayName?: string;
}

export interface AuthenticateOwnerInput {
  readonly email: string;
  readonly password: string;
}

/** The owner as the API returns it. The credential reference is never included. */
export interface OwnerRecordView {
  readonly ownerId: OwnerId;
  readonly provisionedAt: string;
}

/**
 * A profile submission.
 *
 * `expectedVersionNumber` is the compare-and-set value from the editor that loaded
 * the profile, so a stale tab cannot silently overwrite a newer version (F02-AC2).
 * It is null only for a project's first version.
 */
export interface SaveProfileInput {
  readonly projectId: ProjectId;
  readonly content: ProjectProfileContent;
  readonly note: string | null;
  readonly expectedVersionNumber: number | null;
}

export interface ProfileReadRequest {
  readonly projectId: ProjectId;
  readonly actor: OwnerActor;
}

/** One exact profile version, for a run that must read what it was given. */
export interface ProfileVersionRequest extends ProfileReadRequest {
  readonly profileVersionId: ProfileVersionId;
}

/**
 * Changes recorded after the version a run selected.
 *
 * This is how a run discovers that the profile moved underneath it without
 * re-reading the whole history (F02-AC3).
 */
export interface ProfileChangeSet {
  readonly selectedVersionNumber: number;
  readonly selectedProfileVersionId: ProfileVersionId;
  readonly currentVersionNumber: number | null;
  readonly changed: boolean;
  readonly laterVersions: readonly ProjectProfileVersion[];
}

/** The inputs the domain's capability boundary needs, plus the calling actor. */
export interface GrantedCapabilityRequest {
  readonly mode: JobMode;
  readonly requestedCapability: RequestedCapability;
  readonly grantedCapabilities: readonly CapabilityKind[];
  readonly actor: OwnerActor;
}

/** The project key an environment recipe is versioned under. */
export const RECIPE_SUBJECT_KEY = 'environment.recipe';

export interface SaveRecipeInput {
  readonly projectId: ProjectId;
  readonly recipeId: string;
  readonly content: RecipeVersionContent;
  readonly provenance: RecipeProvenance;
  readonly expectedVersionNumber: number | null;
  readonly actor: OwnerActor;
}

/** A saved recipe: the durable row, the validated document and its identity. */
export interface SavedRecipe {
  readonly procedureVersion: ProcedureVersion;
  readonly recipe: RecipeVersion;
  readonly environmentFingerprint: Fingerprint;
}

export interface PreflightRequest {
  readonly projectId: ProjectId;
  readonly procedureVersionId: ProcedureVersionId;
  readonly attemptId: string;
  readonly workingDirectory: string;
  readonly evidenceDirectory: string;
  readonly repositoryProbe: BoundedCommand;
  readonly dependencyProbe: BoundedCommand;
}

/**
 * A preflight that ran.
 *
 * `mayStartImplementation` is separate from the result channel because a
 * `PreflightFailed` run arrives as a successful call whose report says the
 * environment is unusable, and neither outcome may be reported as a started run
 * (F04-AC3). `verifiedRecipe` is null unless preflight passed, so an unverified
 * recipe is never presented as verified.
 */
export interface PreflightAssessment {
  readonly report: PreflightReport;
  readonly mayStartImplementation: boolean;
  readonly verifiedRecipe: RecipeVersion | null;
}

/**
 * A preflight that could not run or that blocked.
 *
 * The report travels with the error because the actual probe outputs must survive
 * a blocked outcome (F04-AC2), while `error` is an ordinary `BlockedError` naming
 * the failed prerequisite and its remedy (F04-AC3).
 */
export interface BlockedPreflight {
  readonly error: DomainError;
  readonly report: PreflightReport;
}

export interface ProfileUseCaseDeps {
  readonly clock: ControllerClock;
  readonly owners: OwnerRepository;
  readonly profiles: ProjectProfileRepository;
  readonly procedures: ProcedureRepository;
  readonly credentials: OwnerCredentialStore;
  readonly adapters: AdapterRegistry;
  /** Cost override so a test can exercise real hashing without production cost. */
  readonly passwordParameters?: Partial<ScryptParameters>;
  /** Injected runner; absent means preflight cannot be attempted (F04-AC2). */
  readonly preflight?: PreflightDeps;
}

export interface ProfileUseCases {
  readonly provisionOwner: (input: ProvisionOwnerInput) => Result<OwnerRecordView, DomainError>;
  readonly authenticateOwner: (input: AuthenticateOwnerInput) => Result<OwnerSignIn, DomainError>;
  readonly signOut: (credential: SessionCredential) => Result<true, DomainError>;
  readonly authorizeRequest: (credential: SessionCredential) => Result<OwnerActor, DomainError>;
  readonly saveProfile: (input: SaveProfileInput, actor: OwnerActor) => Result<ProjectProfileVersion, DomainError>;
  readonly getProfile: (request: ProfileVersionRequest) => Result<ProjectProfileVersion, DomainError>;
  readonly currentProfile: (request: ProfileReadRequest) => Result<ProjectProfileVersion, DomainError>;
  readonly listProfileVersions: (request: ProfileReadRequest) => Result<readonly ProjectProfileVersion[], DomainError>;
  readonly changesSinceSelectedVersion: (
    request: ProfileReadRequest & { readonly selectedVersionId: ProfileVersionId },
  ) => Result<ProfileChangeSet, DomainError>;
  readonly authorizeCapability: (request: GrantedCapabilityRequest) => Result<true, DomainError>;
  readonly saveRecipe: (input: SaveRecipeInput) => Result<SavedRecipe, DomainError>;
  readonly preflightEnvironment: (request: PreflightRequest) => Promise<Result<PreflightAssessment, BlockedPreflight>>;
}

/**
 * One field problem, with the capability a capability-driven failure needs.
 *
 * Named with the field path so the profile form can show every problem at once
 * rather than only the first (F02-AC4).
 */
interface FieldProblem {
  readonly path: string;
  readonly message: string;
}

/** A capability a profile needs, and the field that creates the need. */
interface CapabilityRequirement {
  readonly path: string;
  readonly kind: CapabilityKind;
}

/** The adapter kind that owns a capability, or null when none can declare it. */
function connectorKindFor(kind: CapabilityKind): ConnectorKind | null {
  if (kind.startsWith('Ticket:')) return 'Ticket';
  if (kind.startsWith('Git:')) return 'Git';
  if (kind.startsWith('Deployment:')) return 'Deployment';
  if (kind.startsWith('Engine:')) return 'Engine';
  return null;
}

/**
 * Capabilities a profile needs before a run may use it.
 *
 * Derived from the profile's own fields rather than from a fixed list, so a profile
 * that names no preview component does not demand deployment access, and one that
 * does cannot be saved against an adapter that cannot discover deployments
 * (F02-AC4, F03-AC2).
 */
function requiredCapabilities(content: ProjectProfileContent): readonly CapabilityRequirement[] {
  const requirements: CapabilityRequirement[] = [
    { path: 'references.repository', kind: 'Git:ReadRepository' },
    { path: 'references.repository', kind: 'Git:ReadChecks' },
    { path: 'references.repository', kind: 'Git:PushBranch' },
    { path: 'references.ticketProvider', kind: 'Ticket:ReadScope' },
    { path: 'references.ticketProvider', kind: 'Ticket:UpdateManagedProgress' },
    { path: 'references.engine', kind: 'Engine:VersionCheck' },
    { path: 'references.engine', kind: 'Engine:StartScoped' },
  ];
  if (content.references.previewComponents.length > 0) {
    requirements.push({ path: 'references.previewComponents', kind: 'Deployment:Discover' });
    requirements.push({ path: 'references.previewComponents', kind: 'Deployment:ReadIdentity' });
  }
  return requirements;
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function required(path: string, value: string): FieldProblem[] {
  return isNonEmpty(value) ? [] : [{ path, message: 'Required.' }];
}

/**
 * Whether a value is a credential reference rather than a credential.
 *
 * The domain's own redaction rules decide, so this refusal cannot drift from the
 * patterns stripped from logs, issue text and exports (F03-AC3, N02-AC2).
 */
function secretReferenceProblem(value: string): string | null {
  if (!isNonEmpty(value)) return 'Required.';
  const applied = redact(value).appliedLabels;
  if (applied.length === 0) return null;
  return `Looks like a secret value (${applied.join(', ')}). Store a reference into the credential store instead (F03-AC3).`;
}

/** Every field problem in one pass, so a form can show the whole set (F02-AC4). */
function collectFieldProblems(content: ProjectProfileContent): readonly FieldProblem[] {
  const { references, policy, environment } = content;
  const problems: FieldProblem[] = [
    ...required('references.repository', references.repository),
    ...required('references.ticketProvider', references.ticketProvider),
    ...required('references.baseBranch', references.baseBranch),
    ...required('references.targetBranch', references.targetBranch),
    ...required('references.deploymentProvider', references.deploymentProvider),
    ...required('references.engine', references.engine),
    ...required('recipe', content.recipe),
    ...required('environment.runtime', environment.runtime),
  ];

  references.previewComponents.forEach((component, index) => {
    problems.push(...required(`references.previewComponents[${index}].component`, component.component));
    problems.push(...required(`references.previewComponents[${index}].environment`, component.environment));
  });

  environment.ports.forEach((port, index) => {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      problems.push({
        path: `environment.ports[${index}]`,
        message: 'Must be an isolated unprivileged port between 1024 and 65535 (F14-AC2).',
      });
    }
  });
  if (new Set(environment.ports).size !== environment.ports.length) {
    problems.push({
      path: 'environment.ports',
      message: 'Each allocated port must be distinct, so two services cannot collide on one port (F14-AC2).',
    });
  }

  environment.secretReferences.forEach((reference, index) => {
    const problem = secretReferenceProblem(reference);
    if (problem !== null) problems.push({ path: `environment.secretReferences[${index}]`, message: problem });
  });

  if (policy.requiredChecks.length === 0) {
    problems.push({
      path: 'policy.requiredChecks',
      message: 'At least one required check must be named, so acceptance cannot be reached without evidence (F20-AC5).',
    });
  }
  if (!Number.isInteger(policy.maxFixPasses) || policy.maxFixPasses < 0) {
    problems.push({ path: 'policy.maxFixPasses', message: 'Must be a non-negative count of automated fix passes.' });
  }
  if (!Number.isInteger(policy.capabilityVersion) || policy.capabilityVersion < 1) {
    problems.push({ path: 'policy.capabilityVersion', message: 'Must be a positive integer capability revision.' });
  }
  if (policy.deliveryBehavior !== 'ManualAuthorizationOnly') {
    problems.push({
      path: 'policy.deliveryBehavior',
      message: 'Delivery may only be authorized by the owner (F03-AC5).',
    });
  }
  if (policy.workspaceIsolation !== 'WorktreeAndDataDirectory') {
    problems.push({
      path: 'policy.workspaceIsolation',
      message: 'An attempt requires its own worktree and data directory (F14-AC2).',
    });
  }

  return problems;
}

function ownerRefusal(): { readonly code: 'Forbidden'; readonly reason: string } {
  return { code: 'Forbidden', reason: SIGN_IN_REFUSAL };
}

function deriveDecoyHash(parameters: Partial<ScryptParameters>): PasswordHash {
  const derived = hashPassword(DECOY_CREDENTIAL, parameters);
  return derived.ok ? derived.value : (UNVERIFIABLE_DECOD as PasswordHash);
}

/**
 * Builds the owner, profile, capability and recipe use cases.
 *
 * Everything they touch is injected: clock, repositories, credential store, adapter
 * registry and the preflight runner. A test therefore contacts no provider and
 * reads no ambient time; a deployment supplies the same shapes from the composition
 * root.
 */
export function createProfileUseCases(deps: ProfileUseCaseDeps): ProfileUseCases {
  const passwordParameters = deps.passwordParameters ?? {};
  const decoyHash = deriveDecoyHash(passwordParameters);

  const encodePassword = (password: string): Result<PasswordHash, DomainError> => {
    const hashed = hashPassword(password, passwordParameters);
    if (!hashed.ok) return err(hashed.error);
    return ok(hashed.value);
  };

  /**
   * The single gate a privileged request passes (F01-AC1, F01-AC2).
   *
   * Two layers, each owning what it is authoritative for. Storage resolves the
   * presented token to its row and refuses a revoked or expired one, because it
   * owns the stored digest format; the domain then evaluates the window itself, so
   * revocation is judged by the same policy everywhere and a correct token can never
   * outlive a sign-out. Every refusal reaches the caller as `Forbidden`, so this
   * gate is not an oracle either.
   *
   * The split is required rather than stylistic: `OwnerRepository` stores a plain
   * SHA-256 of the token while the domain's `hashSessionToken` is domain-separated,
   * so `authorizeSession` would compare a digest this row does not hold. The token
   * comparison therefore stays with storage and the window rules stay with the
   * domain; reconciling the two digest formats is a storage change, not a controller
   * workaround.
   */
  const authorizeRequest = (credential: SessionCredential): Result<OwnerActor, DomainError> => {
    const anonymous = { code: 'Forbidden', reason: 'Sign in to continue (F01-AC1).' } as const;
    if (credential.token === '') return err(anonymous);
    const now = deps.clock.now();
    const session = deps.owners.authenticate(credential.token, now);
    if (!session.ok) return err(anonymous);
    const window = evaluateSession({
      issuedAt: session.value.issuedAt,
      expiresAt: session.value.expiresAt,
      revokedAt: session.value.revokedAt,
      now,
    });
    if (!window.valid) {
      return err({ code: 'Forbidden', reason: describeSessionRejection(window.reason ?? 'Malformed') });
    }
    return ok({
      actorId: session.value.ownerId,
      role: 'Owner',
      ownerId: session.value.ownerId,
      sessionId: session.value.sessionId,
    });
  };

  const requireOwner = (actor: OwnerActor): Result<true, DomainError> => {
    if (actor.role !== 'Owner') {
      return err({
        code: 'Forbidden',
        reason: `Only the owner may perform this action; the ${actor.role} role may not (F01-AC1).`,
      });
    }
    return ok(true);
  };

  /**
   * Provisions the single owner and their credential (F01-AC1).
   *
   * The password is hashed before anything is written, and the two refusals that
   * matter are typed rather than silent: an existing credential for the owner or the
   * address is a `Conflict`, and the repository's own conflict for an existing owner
   * row is passed through unchanged.
   */
  const provisionOwner = (input: ProvisionOwnerInput): Result<OwnerRecordView, DomainError> => {
    const email = input.email.trim().toLowerCase();
    const hashed = encodePassword(input.password);
    if (!hashed.ok) return err(hashed.error);
    if (!EMAIL_PATTERN.test(email)) {
      return err(
        invalid('The owner could not be provisioned.', [{ path: 'email', message: 'A sign-in email address is required.' }]),
      );
    }

    const byEmail = deps.credentials.findByEmail(email);
    if (!byEmail.ok) return err(byEmail.error);
    const byOwner = deps.credentials.findByOwnerId(input.ownerId);
    if (!byOwner.ok) return err(byOwner.error);
    if (byEmail.value !== null || byOwner.value !== null) {
      return err(
        conflict(
          'An owner credential already exists; provisioning is refused rather than overwriting it.',
          'no owner credential',
          byEmail.value?.ownerId ?? byOwner.value?.ownerId ?? input.ownerId,
        ),
      );
    }

    const now = deps.clock.now();
    const provisioned = deps.owners.provision(input.ownerId, input.displayName ?? email, now);
    if (!provisioned.ok) return err(provisioned.error);

    const stored = deps.credentials.put({
      ownerId: input.ownerId,
      email,
      passwordHash: hashed.value,
      updatedAt: now,
    });
    if (!stored.ok) return err(stored.error);
    return ok({ ownerId: input.ownerId, provisionedAt: now });
  };

  /**
   * Signs an owner in, and refuses identically either way (N02-AC1).
   *
   * An unknown address still pays one full verification against the decoy encoding,
   * so the response is not only equal in wording but equal in work. A token and its
   * digest are produced only after the password verifies.
   */
  const authenticateOwner = (input: AuthenticateOwnerInput): Result<OwnerSignIn, DomainError> => {
    const email = input.email.trim().toLowerCase();
    const record = deps.credentials.findByEmail(email);
    if (!record.ok) return err(record.error);
    if (record.value === null) {
      verifyPassword(input.password, decoyHash);
      return err(ownerRefusal());
    }
    if (!verifyPassword(input.password, record.value.passwordHash)) return err(ownerRefusal());

    const issuedAt = deps.clock.now();
    const token = generateSessionToken();
    const deadlines = sessionDeadlines({ issuedAt });
    const session = deps.owners.createSession({
      ownerId: record.value.ownerId,
      token,
      issuedAt,
      expiresAt: deadlines.expiresAt,
    });
    if (!session.ok) return err(session.error);
    return ok({
      ownerId: record.value.ownerId,
      sessionId: session.value.sessionId,
      sessionToken: token,
      sessionTokenDigest: hashSessionToken(token),
      issuedAt,
      expiresAt: session.value.expiresAt,
    });
  };

  /** Ends a session so it cannot authorize anything afterwards (F01-AC2). */
  const signOut = (credential: SessionCredential): Result<true, DomainError> => {
    const revoked = deps.owners.revokeSession(credential.token, deps.clock.now());
    if (!revoked.ok) return err(revoked.error);
    return ok(true);
  };

  /**
   * Saves an immutable new profile version (F02-AC3).
   *
   * Every field problem is reported together, and a profile that needs a capability
   * the configured adapters do not declare is refused rather than warned about,
   * because a warning would leave the affected operation to fail later against the
   * same missing capability (F02-AC4). The write itself is append-only: the previous
   * version stays readable.
   */
  const saveProfile = (
    input: SaveProfileInput,
    actor: OwnerActor,
  ): Result<ProjectProfileVersion, DomainError> => {
    const permitted = requireOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    const problems = [...collectFieldProblems(input.content)];
    if (input.note !== null && input.note.trim() === '') {
      problems.push({ path: 'note', message: 'A version note must say something when it is present.' });
    }
    problems.push(...unsupportedCapabilityProblems(input.content, deps.adapters));

    if (problems.length > 0) {
      return err(
        invalid(
          `The profile has ${problems.length} field problem(s) that must be corrected before it can be saved.`,
          problems,
        ),
      );
    }

    return deps.profiles.saveVersion({
      projectId: input.projectId,
      content: input.content,
      note: input.note,
      createdAt: deps.clock.now(),
      createdBy: actor.actorId,
      expectedVersionNumber: input.expectedVersionNumber,
    });
  };

  /**
   * The newest profile version for a project.
   *
   * A run reads this to see what is configured now; a run that already started
   * reads `getProfile` for the exact version it selected, so a later save cannot
   * silently change the inputs a live run is working from (F02-AC2, F02-AC3).
   */
  const currentProfile = (request: ProfileReadRequest): Result<ProjectProfileVersion, DomainError> => {
    const permitted = requireOwner(request.actor);
    if (!permitted.ok) return err(permitted.error);
    const current = deps.profiles.currentVersion(request.projectId);
    if (!current.ok) return err(current.error);
    if (current.value === null) {
      return err({ code: 'NotFound', reason: 'No profile has been saved for this project yet (F02-AC1).' });
    }
    return ok(current.value);
  };

  /**
   * One exact profile version.
   *
   * The version must belong to the requested project, so a wrong identity is a
   * `NotFound` rather than another project's configuration leaking through a
   * guessed id (F02-AC2).
   */
  const getProfile = (request: ProfileVersionRequest): Result<ProjectProfileVersion, DomainError> => {
    const permitted = requireOwner(request.actor);
    if (!permitted.ok) return err(permitted.error);
    const version = deps.profiles.getVersion(request.profileVersionId);
    if (!version.ok) return err(version.error);
    if (version.value.projectId !== request.projectId) {
      return err({ code: 'NotFound', reason: 'That profile version belongs to a different project (F02-AC2).' });
    }
    return ok(version.value);
  };

  const listProfileVersions = (
    request: ProfileReadRequest,
  ): Result<readonly ProjectProfileVersion[], DomainError> => {
    const permitted = requireOwner(request.actor);
    if (!permitted.ok) return err(permitted.error);
    return deps.profiles.listVersions(request.projectId);
  };

  const changesSinceSelectedVersion = (
    request: ProfileReadRequest & { readonly selectedVersionId: ProfileVersionId },
  ): Result<ProfileChangeSet, DomainError> => {
    const permitted = requireOwner(request.actor);
    if (!permitted.ok) return err(permitted.error);
    const selected = deps.profiles.getVersion(request.selectedVersionId);
    if (!selected.ok) return err(selected.error);
    if (selected.value.projectId !== request.projectId) {
      return err({ code: 'NotFound', reason: 'That profile version belongs to a different project (F02-AC2).' });
    }
    const later = deps.profiles.listVersionsSince(request.projectId, selected.value.versionNumber);
    if (!later.ok) return err(later.error);
    const current = deps.profiles.currentVersion(request.projectId);
    if (!current.ok) return err(current.error);
    return ok({
      selectedVersionNumber: selected.value.versionNumber,
      selectedProfileVersionId: selected.value.profileVersionId,
      currentVersionNumber: current.value?.versionNumber ?? null,
      changed: later.value.length > 0,
      laterVersions: later.value,
    });
  };

  /**
   * The capability boundary, delegated (F03-AC5, N02-AC3).
   *
   * The controller does not interpret a granted set itself. It asks the domain,
   * passes the configured adapters' declarations as evidence, and returns the
   * domain's own refusal, so a connector that declares merge authority cannot
   * hand it to a non-owner role.
   */
  const authorizeCapability = (request: GrantedCapabilityRequest): Result<true, DomainError> => {
    const kind = connectorKindFor(request.requestedCapability as CapabilityKind);
    const decision = evaluateGrant({
      mode: request.mode,
      requestedCapability: request.requestedCapability,
      grantedCapabilities: request.grantedCapabilities,
      actorRole: request.actor.role,
      ...(kind === null ? {} : { declarations: deps.adapters.declarationsFor(kind) }),
    });
    if (!decision.allowed) {
      return err({ code: 'Forbidden', reason: secretFreeReason(decision.explanation) });
    }
    return ok(true);
  };

  /**
   * Appends a validated recipe version (F04-AC1, F04-AC4).
   *
   * The first version of a project is validated directly; every later one goes
   * through the domain's `nextVersion`, which keeps the version a previous run used
   * readable and starts the new one unverified, because the older verification
   * described different content.
   */
  const saveRecipe = (input: SaveRecipeInput): Result<SavedRecipe, DomainError> => {
    const permitted = requireOwner(input.actor);
    if (!permitted.ok) return err(permitted.error);

    const previous = deps.procedures.currentVersion(input.projectId, RECIPE_SUBJECT_KEY);
    if (!previous.ok) return err(previous.error);

    const built = buildRecipe(input, previous.value);
    if (!built.ok) return err(built.error);

    const appended = deps.procedures.appendVersion({
      projectId: input.projectId,
      subjectKey: RECIPE_SUBJECT_KEY,
      kind: 'Procedure',
      scope: 'Environment',
      source: 'Owner',
      sourceRevision: built.value.version.toString(),
      content: canonicalize(built.value),
      status: 'Accepted',
      createdAt: input.provenance.createdAt,
      createdBy: input.actor.actorId,
      note: `Recipe version ${built.value.version}`,
      expectedVersionNumber: input.expectedVersionNumber,
    });
    if (!appended.ok) return err(appended.error);
    return ok({
      procedureVersion: appended.value,
      recipe: built.value,
      environmentFingerprint: recipeFingerprint(built.value),
    });
  };

  /**
   * Preflight against the recorded recipe (F04-AC2, F04-AC3).
   *
   * The blocked branch returns the domain's `BlockedError` unchanged, so the owner
   * sees the failed prerequisite and its remedy, and keeps the report describing
   * what was actually observed. A run may not start from either a blocked or a
   * failed preflight.
   */
  const preflightEnvironment = async (
    request: PreflightRequest,
  ): Promise<Result<PreflightAssessment, BlockedPreflight>> => {
    const preflightDeps = deps.preflight;
    if (preflightDeps === undefined) {
      return refuse(
        request,
        { code: 'Unavailable', reason: 'No preflight runner is configured, so the environment was not verified (F04-AC2).' },
      );
    }

    const stored = deps.procedures.getVersion(request.procedureVersionId);
    if (!stored.ok) return refuse(request, stored.error);
    if (stored.value.projectId !== request.projectId) {
      return refuse(request, { code: 'NotFound', reason: 'That recipe version belongs to a different project (F02-AC2).' });
    }
    const recipe = readRecipe(stored.value);
    if (!recipe.ok) return refuse(request, recipe.error);

    const outcome = await runPreflight(
      {
        attemptId: request.attemptId,
        recipe: recipe.value,
        workingDirectory: request.workingDirectory,
        evidenceDirectory: request.evidenceDirectory,
        repositoryProbe: request.repositoryProbe,
        dependencyProbe: request.dependencyProbe,
      },
      preflightDeps,
    );

    if (!outcome.ok) return { ok: false, error: { error: outcome.error.error, report: outcome.error.report } };

    const report = outcome.value;
    const mayStart = implementationMayStart(report);
    const verifiedRecipe = mayStart
      ? recordVerification(recipe.value, {
          result: 'Verified',
          verifiedAt: report.endedAt,
          revision: report.environmentFingerprint,
          dependencyDigest: fingerprint({
            recipeId: recipe.value.recipeId,
            version: recipe.value.version,
            checks: recipe.value.checks,
          }),
        })
      : null;

    if (mayStart) {
      deps.procedures.recordVerification(
        request.procedureVersionId,
        report.environmentFingerprint,
        report.endedAt,
      );
    }

    return ok({ report, mayStartImplementation: mayStart, verifiedRecipe });
  };

  return {
    provisionOwner,
    authenticateOwner,
    signOut,
    authorizeRequest,
    saveProfile,
    getProfile,
    currentProfile,
    listProfileVersions,
    changesSinceSelectedVersion,
    authorizeCapability,
    saveRecipe,
    preflightEnvironment,
  };
}

function buildRecipe(input: SaveRecipeInput, previous: ProcedureVersion | null): Result<RecipeVersion, DomainError> {
  if (previous === null) {
    return validateRecipe({
      ...input.content,
      recipeId: input.recipeId,
      version: 1,
      supersedesVersion: null,
      provenance: input.provenance,
      lastVerification: {
        result: 'NeverVerified',
        verifiedAt: null,
        verifiedRevision: null,
        dependencyDigest: null,
      },
    });
  }
  const prior = readRecipe(previous);
  if (!prior.ok) return err(prior.error);
  return nextVersion(prior.value, input.content, input.provenance);
}

/**
 * Refusals a profile needs the configured adapters to satisfy (F02-AC4, F03-AC2).
 *
 * An unsupported capability is named on the `connectors` field with the provider's
 * own limitation, so the owner is told which connection to change rather than being
 * left to discover it during a run.
 */
function unsupportedCapabilityProblems(
  content: ProjectProfileContent,
  adapters: AdapterRegistry,
): readonly FieldProblem[] {
  const problems: FieldProblem[] = [];
  for (const requirement of requiredCapabilities(content)) {
    const kind = connectorKindFor(requirement.kind);
    const declarations = kind === null ? [] : adapters.declarationsFor(kind);
    const declaration = declarations.find((entry) => entry.kind === requirement.kind);
    if (declaration !== undefined && declaration.supported) continue;
    problems.push({
      path: 'connectors',
      message: `${requirement.kind} is unavailable: ${
        declaration?.limitation ??
        `no configured ${kind ?? 'provider'} adapter declares it, so the affected operation would fail (F03-AC2)`
      }`,
    });
  }
  return problems;
}

/**
 * Reads a stored recipe back through validation.
 *
 * The document was written by this controller, but a row can still be edited by an
 * operator or restored from an older backup, so it is parsed and re-validated at
 * this boundary instead of cast and trusted (F04-AC1).
 */
function readRecipe(procedure: ProcedureVersion): Result<RecipeVersion, DomainError> {
  const rejected = (message: string): DomainError =>
    invalid('The stored recipe could not be read.', [{ path: procedure.subjectKey, message }]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(procedure.content);
  } catch {
    return err(rejected('The stored recipe document is not valid JSON.'));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err(rejected('The stored recipe document is not a recipe.'));
  }
  const candidate = parsed as RecipeVersion;
  if (!Array.isArray(candidate.requiredSecrets) || typeof candidate.requirements !== 'object') {
    return err(rejected('The stored recipe document is missing its required structure.'));
  }
  return validateRecipe(candidate);
}

function refuse(request: PreflightRequest, error: DomainError): { ok: false; error: BlockedPreflight } {
  return { ok: false, error: { error, report: unverifiedReport(request) } };
}

/** A report that records nothing was observed, because nothing was run. */
function unverifiedReport(request: PreflightRequest): PreflightReport {
  return {
    attemptId: request.attemptId,
    recipeId: '',
    recipeVersion: 0,
    environmentFingerprint: fingerprint({ attemptId: request.attemptId }),
    startedAt: '',
    endedAt: '',
    probes: [],
    secretPresence: [],
    outcome: 'Blocked',
    blocked: null,
  };
}