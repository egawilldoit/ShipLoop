/**
 * Project settings: the optional external-execution target, and a read-only view of the
 * repository and provider configuration this project already has (mvp-spec 3, L02-AC2,
 * L02-AC3, F02-AC1, F03-AC3).
 *
 * The MVP settings screen is deliberately small, and three decisions in it are the whole
 * design:
 *
 *   - **The T3 URL is optional everywhere.** Absent is a state the product works in, not a
 *     failure: `Request → Contract → packet → candidate → verification → review` must
 *     complete on a deployment that has configured no T3 at all (L02-AC3). So a null value
 *     is a successful save, and a read of a project that never configured one answers
 *     "not configured" rather than an error.
 *   - **The launch rule is Builder 3's, not this file's.** `parseT3LaunchUrl` already
 *     decides what a usable T3 deployment URL is: absolute, `http:`/`https:`, and free of an
 *     embedded username or password, with a refusal that never reproduces the value it
 *     refused (L02-AC2). Duplicating those checks here would be a second rule that could
 *     disagree with the packet's own. What this module adds is the one thing that rule does
 *     not cover: a URL that is a perfectly good URL *and* carries a token - which is a
 *     credential that would then be stored, returned and opened.
 *   - **Settings holds no secret and returns none.** A settings read is a browser response,
 *     so it carries the repository, the branches and each connector's identity and state,
 *     never a credential value and never a credential reference
 *     (`credentialReference`, the pointer into the credential store, stays on the connector
 *     route that registered it). What travels instead is the stored digest, which proves
 *     which reference a connector used without reproducing it (F03-AC3, F32-AC2).
 *
 * Repository and provider configuration is *read* here and *written* elsewhere on purpose.
 * A profile version is append-only and compare-and-set (F02-AC2, F02-AC3) and a connector is
 * registered by reference through its own route (F03-AC1); a second write path for either
 * fact would produce two answers to "what is this project's repository", which is the
 * ambiguity every other part of this system is built to remove.
 */

import { err, ok, redact } from '@shiploop/domain';
import type { DomainError, OwnerId, ProjectId, Result } from '@shiploop/domain';
import type {
  ConnectorRecord,
  ProjectProfileVersion,
  ProjectSettingsRecord,
  ProjectSettingsStore,
} from '@shiploop/storage';
import type { ControllerClock, OwnerActor } from './profiles.ts';
import { T3_URL_ENV_VAR, parseT3LaunchUrl } from './handoff/t3-launch.ts';

/** What the settings screen reads and writes about the external execution target. */
export interface T3LaunchSetting {
  /**
   * Whether this project has a T3 deployment configured.
   *
   * A separate flag rather than "is `url` non-null" so a reader can say "not configured"
   * without inferring it, and so an absent value is a state with a name (L02-AC3).
   */
  readonly configured: boolean;
  /** The configured URL, or null. Never a credential: the rules above refuse those. */
  readonly url: string | null;
}

/**
 * The repository configuration this project has, read from its current profile version.
 *
 * A projection, not a copy: `profileVersionId` and `versionNumber` are carried so a reader
 * knows *which* version it is looking at, and editing continues to happen through the
 * profile route against that same version (F02-AC2, F02-AC3).
 */
export interface RepositorySetting {
  /** False when this project has no saved profile version yet. */
  readonly configured: boolean;
  readonly profileVersionId: string | null;
  readonly versionNumber: number | null;
  readonly repository: string | null;
  readonly baseBranch: string | null;
  readonly targetBranch: string | null;
  readonly ticketProvider: string | null;
  readonly deploymentProvider: string | null;
  readonly engine: string | null;
}

/**
 * One configured provider, as settings reports it.
 *
 * No `credentialReference` field exists on this type, so the pointer cannot be reached by
 * reading it out of a settings response. `credentialReferenceDigest` is what remains: the
 * stored digest, which identifies the reference without carrying it (F03-AC3, F32-AC2).
 */
export interface ProviderSetting {
  readonly connectorId: string;
  readonly kind: ConnectorRecord['kind'];
  readonly provider: string;
  readonly resourceScope: string;
  readonly credentialReferenceDigest: string;
  readonly state: ConnectorRecord['state'];
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
}

/** Everything one project's settings currently hold. */
export interface ProjectSettingsView {
  readonly projectId: string;
  readonly t3: T3LaunchSetting;
  readonly repository: RepositorySetting;
  readonly providers: readonly ProviderSetting[];
  /** When these settings were last written, or null when they never were. */
  readonly updatedAt: string | null;
}

export interface SettingsReadRequest {
  readonly projectId: ProjectId;
  readonly actor: OwnerActor;
}

export interface UpdateSettingsInput {
  readonly projectId: ProjectId;
  readonly actor: OwnerActor;
  /**
   * The T3 deployment URL, or null/blank to clear it.
   *
   * Optional so a caller that only wants to re-read need not write; when present it is the
   * new value in full, because there is exactly one such setting and a partial write to a
   * single field could only mean "keep the old one".
   */
  readonly t3Url?: string | null;
}

export interface SettingsUseCaseDeps {
  readonly clock: ControllerClock;
  readonly settings: ProjectSettingsStore;
  /** Whether this deployment holds the project being addressed (F02-AC1, F02-AC2). */
  readonly projects: { get(projectId: ProjectId): Result<{ readonly projectId: ProjectId } | null> };
  readonly profiles: { currentVersion(projectId: ProjectId): Result<ProjectProfileVersion | null> };
  readonly connectors: { listForProject(projectId: ProjectId): Result<readonly ConnectorRecord[]> };
  /** Resolves the single provisioned owner, refusing when none exists (F01-AC1). */
  readonly resolveOwner: () => Result<OwnerActor, DomainError>;
}

export interface SettingsUseCases {
  readonly readSettings: (request: SettingsReadRequest) => Result<ProjectSettingsView, DomainError>;
  readonly updateSettings: (input: UpdateSettingsInput) => Result<ProjectSettingsView, DomainError>;
}

/**
 * The query and fragment names that carry a credential rather than a location.
 *
 * Narrow on purpose: `?thread=abc` and `?ref=main` are things a launch URL legitimately
 * carries and Builder 3's own tests accept them, so refusing every query would refuse a
 * working deployment. What is refused is a parameter whose name says it holds a secret, and
 * the refusal never names the value (L02-AC2, N02-AC2).
 */
const CREDENTIAL_QUERY_NAMES: readonly string[] = [
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'auth_token',
  'credential',
  'id_token',
  'key',
  'passwd',
  'password',
  'secret',
  'session',
  'sig',
  'signature',
  'token',
];

/**
 * Validates a submitted T3 deployment URL for this project's settings.
 *
 * `null` and blank mean "not configured" and are a success, because a deployment that does
 * not use T3 is a normal one (L02-AC3). Everything else is judged by
 * {@link parseT3LaunchUrl} first, so the scheme and credential rules and the refusal shape
 * are Builder 3's and cannot drift from the packet's.
 */
export function validateT3Setting(submitted: string | null | undefined): Result<T3LaunchSetting, DomainError> {
  if (submitted === null || submitted === undefined || submitted.trim() === '') {
    return ok({ configured: false, url: null });
  }

  const parsed = parseT3LaunchUrl(submitted);
  if (!parsed.ok) return err(parsed.error);

  const credential = credentialIn(parsed.value.url);
  if (credential !== null) return err(credential);

  return ok({ configured: true, url: parsed.value.url });
}

/**
 * The refusal for a URL that is well-formed and still carries a credential.
 *
 * Never quotes the URL, a parameter name or a value: a value bad enough to be refused is
 * exactly the value that must not reach a log, an error body or a stored row (N02-AC2). It
 * names the setting instead, and it is `Blocked` rather than `Invalid` because the remedy is
 * an operator action on configuration - the same shape as every other missing prerequisite,
 * so the HTTP layer renders it with the remedy attached.
 */
function credentialIn(url: string): DomainError | null {
  const applied = redact(url).appliedLabels;
  if (applied.length > 0) return credentialRefusal();

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // `parseT3LaunchUrl` already refused anything `URL` cannot read, so reaching here means
    // the URL is well-formed; a failure here is not a second refusal, it is nothing to add.
    return null;
  }

  const names = [
    ...[...parsed.searchParams.keys()].map((name) => name.toLowerCase()),
    ...(parsed.hash.includes('=') ? parsed.hash.slice(1).split(/[&;]/) : []).map((entry) =>
      (entry.split('=')[0] ?? '').toLowerCase(),
    ),
  ];
  const offending = names.some((name) => CREDENTIAL_QUERY_NAMES.includes(name));
  return offending ? credentialRefusal() : null;
}

function credentialRefusal(): DomainError {
  return {
    code: 'Blocked',
    reason: `The T3 deployment URL configured for this project carries a credential (${T3_URL_ENV_VAR}).`,
    prerequisites: [
      {
        name: T3_URL_ENV_VAR,
        detail: 'A T3 launch URL must be a plain address. A credential in it would be stored, returned and opened.',
        remedy:
          'Remove the token, key or password from the URL and sign in to T3 in the browser instead. ShipLoop never needs a T3 credential, and the implementation handoff packet works without a T3 URL at all.',
      },
    ],
  };
}

/**
 * Builds the settings use cases.
 *
 * Everything they read is injected, so a test contacts no provider and reads no ambient
 * time, and a deployment supplies the same shapes from the composition root.
 */
export function createSettingsUseCases(deps: SettingsUseCaseDeps): SettingsUseCases {
  /**
   * The gate every settings call passes.
   *
   * Two refusals, in this order. First the caller must be an owner this deployment can
   * resolve server-side, so a request cannot be answered on a body's word about who is
   * asking (F01-AC1). Then the project must be a row this store holds: settings are
   * project-scoped, so an identity addressing a project this deployment does not have is a
   * `NotFound` rather than an empty or invented answer about somebody else's configuration
   * (F02-AC2).
   *
   * Recorded as a limit rather than glossed: the schema carries no owner on a project, so
   * "the caller owns this project" is established by there being one provisioned owner who
   * authenticated, and by the project existing in this deployment. A second owner or a
   * per-project membership would be a schema decision this slice does not get to make, and
   * inventing one here would be a claim about ownership that no row can support.
   */
  const requireOwnedProject = (actor: OwnerActor, projectId: ProjectId): Result<OwnerId, DomainError> => {
    if (actor.role !== 'Owner' || actor.ownerId === null) {
      return err({
        code: 'Forbidden',
        reason: `Only the owner may read or change project settings; the ${actor.role} role may not (F01-AC1).`,
      });
    }
    const owner = deps.resolveOwner();
    if (!owner.ok) return err(owner.error);
    if (owner.value.ownerId === null || String(owner.value.ownerId) !== String(actor.ownerId)) {
      return err({
        code: 'Forbidden',
        reason: 'This session was proved for an owner this deployment cannot resolve, so it may not address a project (F01-AC1).',
      });
    }
    const project = deps.projects.get(projectId);
    if (!project.ok) return err(project.error);
    if (project.value === null) {
      return err({
        code: 'NotFound',
        reason: 'This deployment holds no project with that identity, so there are no settings to read (F02-AC2).',
      });
    }
    return ok(actor.ownerId);
  };

  /** The repository configuration, or "not configured" when there is no profile version. */
  const readRepository = (projectId: ProjectId): Result<RepositorySetting, DomainError> => {
    const current = deps.profiles.currentVersion(projectId);
    if (!current.ok) return err(current.error);
    if (current.value === null) {
      return ok({
        configured: false,
        profileVersionId: null,
        versionNumber: null,
        repository: null,
        baseBranch: null,
        targetBranch: null,
        ticketProvider: null,
        deploymentProvider: null,
        engine: null,
      });
    }
    const { references } = current.value.content;
    return ok({
      configured: true,
      profileVersionId: current.value.profileVersionId,
      versionNumber: current.value.versionNumber,
      repository: references.repository,
      baseBranch: references.baseBranch,
      targetBranch: references.targetBranch,
      ticketProvider: references.ticketProvider,
      deploymentProvider: references.deploymentProvider,
      engine: references.engine,
    });
  };

  /**
   * The configured providers, without their credential references.
   *
   * `credentialReference` is dropped here rather than at the route, so the type this module
   * returns cannot be asked for the pointer at all (F03-AC3).
   */
  const readProviders = (projectId: ProjectId): Result<readonly ProviderSetting[], DomainError> => {
    const listed = deps.connectors.listForProject(projectId);
    if (!listed.ok) return err(listed.error);
    return ok(
      listed.value.map((record) => ({
        connectorId: record.connectorId,
        kind: record.kind,
        provider: record.provider,
        resourceScope: record.resourceScope,
        credentialReferenceDigest: record.credentialReferenceDigest,
        state: record.state,
        lastCheckedAt: record.lastCheckedAt,
        lastSuccessAt: record.lastSuccessAt,
      })),
    );
  };

  /**
   * The stored T3 setting, re-validated as it is read.
   *
   * A row written through this module always holds a value these rules accept, but a row can
   * still be edited by an operator or restored from an older backup. A value that no longer
   * validates is reported as a storage fault by name rather than passed to a browser as if it
   * were openable - and the value itself is not reproduced in the refusal (N02-AC2).
   */
  const readT3 = (stored: ProjectSettingsRecord | null): Result<T3LaunchSetting, DomainError> => {
    if (stored === null) return ok({ configured: false, url: null });
    const validated = validateT3Setting(stored.t3LaunchUrl);
    if (!validated.ok) {
      return err({
        code: 'Unavailable',
        reason: `The stored T3 deployment URL for this project is not usable and cannot be shown or opened. Correct or clear it in project settings (${T3_URL_ENV_VAR}).`,
      });
    }
    return ok(validated.value);
  };

  const compose = (
    projectId: ProjectId,
    stored: ProjectSettingsRecord | null,
  ): Result<ProjectSettingsView, DomainError> => {
    const t3 = readT3(stored);
    if (!t3.ok) return err(t3.error);
    const repository = readRepository(projectId);
    if (!repository.ok) return err(repository.error);
    const providers = readProviders(projectId);
    if (!providers.ok) return err(providers.error);
    return ok({
      projectId: String(projectId),
      t3: t3.value,
      repository: repository.value,
      providers: providers.value,
      updatedAt: stored?.updatedAt ?? null,
    });
  };

  /**
   * Reads one project's settings.
   *
   * A project with nothing configured reads successfully with `configured: false` everywhere
   * and a null `updatedAt`. That is the state a fresh MVP deployment is in, and answering it
   * with an error would make "you have not configured a T3 URL" indistinguishable from
   * "this deployment is broken" (L02-AC3).
   */
  const readSettings = (request: SettingsReadRequest): Result<ProjectSettingsView, DomainError> => {
    const permitted = requireOwnedProject(request.actor, request.projectId);
    if (!permitted.ok) return err(permitted.error);

    const stored = deps.settings.read(request.projectId);
    if (!stored.ok) return err(stored.error);
    return compose(request.projectId, stored.value);
  };

  /**
   * Saves the T3 deployment URL, or clears it.
   *
   * The write is validated before it reaches storage and only after the caller and the
   * project have both been established, so a refusal never tells an unauthorized caller
   * anything about the value it sent. The read-back after the write is what the response
   * reports: the row, not the request (mvp-spec 7, "state changes include current
   * identity").
   */
  const updateSettings = (input: UpdateSettingsInput): Result<ProjectSettingsView, DomainError> => {
    const permitted = requireOwnedProject(input.actor, input.projectId);
    if (!permitted.ok) return err(permitted.error);
    if (input.t3Url === undefined) {
      // Nothing to change. Reported as the current state rather than as a refusal, so a
      // client that reads, decides and writes back unchanged still gets an answer it can
      // render.
      return readSettings(input);
    }

    const validated = validateT3Setting(input.t3Url);
    if (!validated.ok) return err(validated.error);

    const stored = deps.settings.setT3LaunchUrl(input.projectId, validated.value.url, deps.clock.now());
    if (!stored.ok) return err(stored.error);
    return compose(input.projectId, stored.value);
  };

  return { readSettings, updateSettings };
}
