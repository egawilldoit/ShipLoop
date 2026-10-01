/**
 * The composition root (F01-AC1, F02-AC1, F03-AC1, F06-AC1, F07-AC3, ARCHITECTURE
 * "Authority and durable state").
 *
 * One place where the durable store, the clock and the adapters are bound, so the
 * web layer obtains dependencies rather than constructing them and every process
 * shares one set of repositories. Three properties are deliberate:
 *
 *   - it returns a `Result`, and a root is only returned once the database is open,
 *     migrated and known to carry the schema the repositories write. A half-built
 *     root is worse than none, because each of its use cases would fail separately
 *     and the first real request would be the place that discovered it;
 *   - it holds exactly one repository of each kind, so a compare-and-set on a
 *     profile version is meaningful within a process (F02-AC2);
 *   - the clock and the adapter registry are injected, so a test contacts no
 *     provider and records no ambient time.
 *
 * The root verifies that the tables and columns its repositories need actually
 * exist after migrating, and refuses to start with a named cause rather than
 * handing out a root whose every use case would throw "no such table" or "no such
 * column". Intake's tables are in that list because an idea that cannot be stored
 * would fail at the first capture, which is the one request the owner cannot afford to
 * lose (F06-AC2). Owner credentials are read from and written to the owner row itself,
 * because `@shiploop/storage` owns those columns and a second credential table would
 * put sign-in state outside the backup.
 */

import {
  DEFAULT_LIMITS,
  err,
  ok,
  type DomainError,
  type OwnerId,
  type PasswordHash,
  type ProcedureVersionId,
  type Result,
  type ScryptParameters,
} from '@shiploop/domain';
import {
  closeDatabase,
  createJobQueue,
  createLeaseManager,
  migrate,
  openDatabase,
  AttentionItemRepository,
  CandidateRepository,
  OwnerDecisionRepository,
  ConnectorRepository,
  IdeaRepository,
  IntakeRepository,
  OwnerRepository,
  ProcedureRepository,
  ProjectProfileRepository,
  ScopeRepository,
  WorkItemRepository,
} from '@shiploop/storage';
import type {
  Database,
  JobLimits,
  JobQueue,
  LeaseManager,
  MigrateOptions,
  OpenDatabaseOptions,
  ProcedureVersion,
  SqlRow,
  StorageConnection,
} from '@shiploop/storage';
import { validateRecipe, type PreflightDeps, type RecipeVersion, type RequiredCheckPolicy } from '@shiploop/verification';
import type { AdapterRegistry, ConnectorUseCases } from './connectors.ts';
import { createConnectorUseCases } from './connectors.ts';
import type { AcceptanceUseCases } from './acceptance.ts';
import { createAcceptanceUseCases } from './acceptance.ts';
import type { AttentionUseCases } from './attention.ts';
import { SqliteAttentionScope, createAttentionUseCases } from './attention.ts';
import type { IntakeArtifactRoot, IntakeUseCases } from './intake.ts';
import { createIntakeUseCases } from './intake.ts';
import type { JobUseCases } from './jobs.ts';
import { createJobUseCases } from './jobs.ts';
import type { ControllerClock, OwnerCredentialRecord, OwnerCredentialStore, ProfileUseCases } from './profiles.ts';
import { RECIPE_SUBJECT_KEY, createProfileUseCases } from './profiles.ts';
import type { SessionUseCases } from './sessions.ts';
import { createSessionUseCases } from './sessions.ts';
import type {
  ProjectCheckPolicy,
  ProjectChecks,
  ProjectEnvironment,
  ProjectEnvironmentReader,
  ProviderCheckReader,
  VerificationUseCases,
} from './verification.ts';
import { SqliteObservationJournal, createVerificationUseCases } from './verification.ts';

export interface CompositionRootConfig {
  readonly databasePath: string;
  readonly clock: ControllerClock;
  readonly adapters: AdapterRegistry;
  /** Cost override so a test can exercise real hashing without production cost. */
  readonly passwordParameters?: Partial<ScryptParameters>;
  /**
   * The idle session limit this deployment runs with (F01-AC2).
   *
   * Required rather than defaulted: an authorization gate that reads a constant
   * instead of the configured value is a limit the owner believes they set and
   * cannot change, which is the same failure as having no idle timeout at all.
   */
  readonly sessionIdleTimeoutSeconds: number;
  /**
   * The bounded limits every run this process starts is recorded with (F18-AC2).
   *
   * Defaults to the v0.1 bound rather than to nothing, because a start with no configured
   * bound would record `DEFAULT_JOB_LIMITS` deeper in the queue where a reader of the
   * configuration could not see it, and a deployment that wants a different bound says so
   * here. The two published fields come from the domain's frozen `DEFAULT_LIMITS` so this
   * file cannot drift from the allowance they state; the attempt count has no domain
   * default and is stated once, here, where it is visible.
   */
  readonly jobLimits?: JobLimits;
  /** Injected probe runner; absent means preflight cannot be attempted (F04-AC2). */
  readonly preflight?: PreflightDeps;
  readonly openDatabaseOptions?: OpenDatabaseOptions;
  readonly migrateOptions?: MigrateOptions;
  /**
   * Directory intake attachment bytes are written under (F06-AC1).
   *
   * Required rather than defaulted because the only honest default is none: writing
   * an owner's attachment somewhere this configuration did not name would produce a
   * file the owner cannot find and cannot delete through the product. A root of null
   * means attachments are refused by name rather than written to a temporary
   * directory nobody backs up (F01-AC3).
   */
  readonly artifactRoot?: IntakeArtifactRoot;
}

/**
 * Everything the web/API layer may reach, plus the handle it needs to read and
 * back up the durable store.
 */
export interface CompositionRoot {
  readonly database: Database;
  readonly owners: OwnerRepository;
  readonly profiles: ProjectProfileRepository;
  readonly connectors: ConnectorRepository;
  readonly procedures: ProcedureRepository;
  readonly intake: IntakeRepository;
  readonly ideas: IdeaRepository;
  readonly workItems: WorkItemRepository;
  readonly scope: ScopeRepository;
  readonly candidates: CandidateRepository;
  /**
   * The durable job queue and its writer-lease manager (F13-AC2, F17-AC5).
   *
   * Published rather than kept private because a process that has to read which runs
   * exist reads the same rows the worker claims from, and a second projection of the
   * `jobs` table is how a run list and a worker end up disagreeing about what is
   * queued.
   */
  readonly jobs: JobQueue;
  readonly leases: LeaseManager;
  readonly credentials: OwnerCredentialStore;
  readonly useCases: ProfileUseCases & ConnectorUseCases;
  readonly intakeUseCases: IntakeUseCases;
  readonly sessionUseCases: SessionUseCases;
  /** Run start, lifecycle transitions and owner limit decisions (F13, F17, F18). */
  readonly jobUseCases: JobUseCases;
  /** The attention dashboard and acknowledgement (F31). */
  readonly attentionUseCases: AttentionUseCases;
  /** Required checks, the review card and criterion evidence (F20, F23, F24). */
  readonly verificationUseCases: VerificationUseCases;
  /** Owner acceptance and retained change feedback (F25). */
  readonly acceptanceUseCases: AcceptanceUseCases;
  /** Closes only the database handle this root opened. */
  close(): Result<true, DomainError>;
}

/**
 * The v0.1 bound a run is recorded with when the configuration names none.
 *
 * The active-execution and fix-pass allowances are the domain's frozen `DEFAULT_LIMITS`
 * rather than literals, so this cannot drift from the allowance the specification
 * publishes. The tool-retry count is that allowance's own per-operation attempt count, and
 * the attempt count is stated here because the domain declares no default for it: a
 * deployment that wants a different bound says so through `jobLimits` (F18-AC2).
 */
const DEFAULT_JOB_LIMITS: JobLimits = {
  activeExecutionMs: DEFAULT_LIMITS.activeExecutionMs,
  maxAutomatedFixPasses: DEFAULT_LIMITS.automatedFixPasses,
  maxToolRetries: DEFAULT_LIMITS.toolRetry.attemptsPerOperation,
  maxAttempts: 2,
};

/** The tables the bound repositories read and write. */
const REQUIRED_TABLES: readonly string[] = [
  'owners',
  'sessions',
  'project_profile_versions',
  'connectors',
  'procedure_versions',
  'ideas',
  'idea_messages',
  'idea_attachments',
  'idea_questions',
  'briefs',
];

/**
 * Owner credentials live on the owner row itself.
 *
 * `@shiploop/storage`'s migrations own `owners.email` and `owners.password_digest`,
 * so there is no second credential table here: one place stores an owner, which is
 * what lets a restored backup carry sign-in with everything else.
 */
const OWNER_CREDENTIAL_COLUMNS = 'owner_id, email, password_digest, created_at';

function requiredText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`column ${column} is missing or not text`);
  return value;
}

/**
 * Owner credentials as durable rows.
 *
 * Only the domain's self-describing encoding is stored, so the plaintext has no
 * path to a column and a stronger cost can be recognised later without a migration
 * guess (F01-AC1). Lookups are by normalised address, which is what makes "unknown
 * address" and "wrong password" the same question to ask (N02-AC1).
 */
export class SqliteOwnerCredentialStore implements OwnerCredentialStore {
  private readonly connection: StorageConnection;

  constructor(connection: StorageConnection) {
    this.connection = connection;
  }

  findByEmail(email: string): Result<OwnerCredentialRecord | null> {
    return this.find('email', email.trim().toLowerCase());
  }

  findByOwnerId(ownerId: OwnerId): Result<OwnerCredentialRecord | null> {
    return this.find('owner_id', ownerId);
  }

  private find(column: 'email' | 'owner_id', value: string): Result<OwnerCredentialRecord | null> {
    try {
      const row = this.connection
        .prepare(`SELECT ${OWNER_CREDENTIAL_COLUMNS} FROM owners WHERE ${column} = ?`)
        .get(value);
      if (row === undefined) return ok(null);
      // A row with no credential is an owner provisioned by another path, not a
      // failed sign-in: returning null keeps unknown-address and wrong-password
      // indistinguishable to the caller (N02-AC1).
      //
      // Read as text-or-absent rather than required text, because both columns are
      // nullable in the migrated schema and an owner that has no password digest
      // yet is a legitimate row. Treating that as a missing column turned an
      // ordinary unknown-owner sign-in attempt into a storage failure.
      const email = nullableText(row, 'email');
      const passwordHash = nullableText(row, 'password_digest');
      if (email === null || email === '' || passwordHash === null || passwordHash === '') return ok(null);
      return ok({
        ownerId: requiredText(row, 'owner_id') as OwnerId,
        email,
        passwordHash: passwordHash as PasswordHash,
        updatedAt: nullableText(row, 'created_at') ?? '',
      });
    } catch (error) {
      return err({ code: 'Unavailable', reason: `owner credential lookup failed: ${describe(error)}` });
    }
  }
}

/** A nullable column read as text, with a null column reported as absent. */
function nullableText(row: SqlRow, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Confirms the owner row carries somewhere to keep an email and a password digest.
 *
 * Exported so a caller that binds repositories itself, rather than through
 * `createCompositionRoot`, fails at setup with a named cause instead of at the
 * first sign-in with a "no such column" error.
 */
export function ensureOwnerCredentialSchema(connection: StorageConnection): Result<true, DomainError> {
  let rows: SqlRow[];
  try {
    rows = connection.prepare("SELECT name FROM pragma_table_info('owners')").all();
  } catch (error) {
    return err({ code: 'Unavailable', reason: `owner credential columns could not be inspected: ${describe(error)}` });
  }
  const present = new Set(rows.map((row) => (typeof row['name'] === 'string' ? row['name'] : '')));
  const missing = ['email', 'password_digest'].filter((column) => !present.has(column));
  if (missing.length > 0) {
    return err({
      code: 'Unavailable',
      reason: `The owners table has no ${missing.join(' or ')} column, so an owner cannot sign in. Apply the @shiploop/storage migrations that carry owner credentials.`,
    });
  }
  return ok(true);
}

/**
 * Reports the first required table that is absent.
 *
 * Naming it is the whole point: a startup refusal that says which table is missing
 * is actionable, and one that says "unavailable" is the failure this function
 * exists to prevent.
 */
function missingRepositoryTable(connection: StorageConnection): string | null {
  let rows: SqlRow[];
  try {
    rows = connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();
  } catch (error) {
    throw new Error(`schema could not be inspected: ${describe(error)}`);
  }
  const present = new Set(rows.map((row) => (typeof row['name'] === 'string' ? row['name'] : '')));
  for (const table of REQUIRED_TABLES) {
    if (!present.has(table)) return table;
  }
  return null;
}

/**
 * Opens the store, migrates it, and binds every use case.
 *
 * Nothing is returned unless all of that succeeded; a failure at any step closes
 * whatever was opened, so a refused root leaves no file handle behind.
 */
export function createCompositionRoot(config: CompositionRootConfig): Result<CompositionRoot, DomainError> {
  const opened = openDatabase(config.databasePath, config.openDatabaseOptions ?? {});
  if (!opened.ok) return err(opened.error);
  const database = opened.value;

  const migrated = migrate(database, config.migrateOptions ?? {});
  if (!migrated.ok) {
    closeDatabase(database);
    return err(migrated.error);
  }

  try {
    const missing = missingRepositoryTable(database);
    if (missing !== null) {
      return refuse(database, {
        code: 'Unavailable',
        reason: `The database has no "${missing}" table after migrating, so the storage repositories cannot read or write it. The controller refuses to start rather than hand out a root whose use cases would all fail.`,
      });
    }
    const credentials = ensureOwnerCredentialSchema(database);
    if (!credentials.ok) return refuse(database, credentials.error);
  } catch (error) {
    return refuse(database, {
      code: 'Unavailable',
      reason: `The database schema could not be prepared: ${describe(error)}`,
    });
  }

  const owners = new OwnerRepository(database);
  const profiles = new ProjectProfileRepository(database);
  const connectors = new ConnectorRepository(database);
  const procedures = new ProcedureRepository(database);
  const intake = new IntakeRepository(database);
  const ideas = new IdeaRepository(database);
  const workItems = new WorkItemRepository(database);
  const scope = new ScopeRepository(database);
  const candidates = new CandidateRepository(database);
  const attentionItems = new AttentionItemRepository(database);
  const jobs = createJobQueue({ connection: database });
  const leases = createLeaseManager({ connection: database });
  const credentials = new SqliteOwnerCredentialStore(database);

  const profileUseCases = createProfileUseCases({
    clock: config.clock,
    owners,
    profiles,
    procedures,
    credentials,
    adapters: config.adapters,
    sessionIdleTimeoutSeconds: config.sessionIdleTimeoutSeconds,
    ...(config.passwordParameters === undefined ? {} : { passwordParameters: config.passwordParameters }),
    ...(config.preflight === undefined ? {} : { preflight: config.preflight }),
  });
  const connectorUseCases = createConnectorUseCases({ clock: config.clock, connectors, adapters: config.adapters });
  const sessionUseCases = createSessionUseCases({ clock: config.clock, owners });
  const intakeUseCases = createIntakeUseCases({
    clock: config.clock,
    intake,
    ideas,
    artifactRoot: config.artifactRoot ?? null,
  });

  /**
   * One queue, one lease manager and one clock for every run-facing use case.
   *
   * The queue is passed to both the job use cases and the attention dashboard rather
   * than the dashboard opening its own SQLite reader of the `jobs` table, because a
   * second projection of that table is exactly how a dashboard and a worker could
   * disagree about which jobs exist (F31-AC1, F13-AC2).
   */
  const jobUseCases = createJobUseCases({
    clock: config.clock,
    queue: jobs,
    leases,
    profiles,
    procedures,
    workItems,
    scope,
    limits: config.jobLimits ?? DEFAULT_JOB_LIMITS,
  });
  const attentionUseCases = createAttentionUseCases({
    clock: config.clock,
    queue: jobs,
    scope: new SqliteAttentionScope(database),
    attentionStore: attentionItems,
  });
  /**
   * One observation journal, shared by verification and acceptance.
   *
   * Both read criterion status from the same rows, and a second reader over one store
   * is how the review card and the acceptance gate could disagree about whether a
   * criterion was ever verified (F24-AC3, F25-AC1).
   */
  const observationJournal = new SqliteObservationJournal(database);
  const verificationUseCases = createVerificationUseCases({
    clock: config.clock,
    git: providerChecksFor(),
    checks: projectChecksFor(profiles),
    evidence: observationJournal,
    candidates,
    scope: workItems,
    workItems,
    procedureVersions: environmentReaderFor(procedures),
  });

  /**
   * Owner acceptance, bound to the same evidence the review card reads (F25-AC1).
   *
   * The decision store is the durable `owner_decisions` table rather than anything
   * in this process, because an unattributable acceptance is not representable there
   * and a decision lost on restart would let the same candidate be accepted twice
   * (F25-AC4).
   */
  const acceptanceUseCases = createAcceptanceUseCases({
    clock: config.clock,
    decisions: new OwnerDecisionRepository(database),
    candidates,
    evidence: observationJournal,
    scope: workItems,
  });

  let closed = false;

  return ok({
    database,
    owners,
    profiles,
    connectors,
    procedures,
    intake,
    ideas,
    workItems,
    scope,
    candidates,
    jobs,
    leases,
    credentials,
    useCases: { ...profileUseCases, ...connectorUseCases },
    intakeUseCases,
    sessionUseCases,
    jobUseCases,
    attentionUseCases,
    verificationUseCases,
    acceptanceUseCases,
    close(): Result<true, DomainError> {
      if (closed) return ok(true);
      closed = true;
      return closeDatabase(database);
    },
  });
}

/**
 * The environment a run's checks would execute in, read from the project's recipe (F20-AC3).
 *
 * The recipe document is parsed and re-validated rather than cast, because a row can be
 * edited or restored from an older backup and an environment fingerprint taken from a
 * malformed document is a fingerprint of nothing (F04-AC1). The check commands travel
 * with it because that is what the port declares; nothing in this process runs them.
 */
function environmentReaderFor(procedures: ProcedureRepository): ProjectEnvironmentReader {
  return {
    currentEnvironment: (projectId): Result<ProjectEnvironment, DomainError> => {
      const procedure = procedures.currentVersion(projectId, RECIPE_SUBJECT_KEY);
      if (!procedure.ok) return err(procedure.error);
      if (procedure.value === null) {
        return err({
          code: 'NotFound',
          reason: `Project ${projectId} has no accepted environment recipe, so no recorded result can be compared against an environment (F05-AC1).`,
        });
      }
      const recipe = readStoredRecipe(procedure.value);
      if (!recipe.ok) return err(recipe.error);
      return ok({
        procedureVersionId: procedure.value.procedureVersionId as ProcedureVersionId,
        environmentFingerprint: procedure.value.contentFingerprint,
        checks: recipe.value.checks,
      });
    },
  };
}

/**
 * The stored recipe document, read through the verification package's own validation.
 *
 * Reported as a duplication of the parsing `profiles.ts` and `apps/worker` each perform:
 * the reader is private there, so a process that has to state an environment identity
 * would otherwise have to cast the row itself (F04-AC1, F20-AC3).
 */
function readStoredRecipe(procedure: ProcedureVersion): Result<RecipeVersion, DomainError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(procedure.content);
  } catch {
    return err({
      code: 'Unavailable',
      reason: `The stored environment recipe for ${procedure.subjectKey} is not valid JSON, so no environment identity can be stated for it (F04-AC1).`,
    });
  }
  return validateRecipe(parsed as RecipeVersion);
}

/**
 * The required-check policy the project's current profile version states (F20-AC5).
 *
 * `policyFor` reads a profile and decides nothing: the approved set is the profile's own
 * list, and the proposal is the same set because only an owner policy revision can extend
 * or retire a check, and no coding pass in this process proposes one (F20-AC5). Reading
 * the newest version rather than the one a job recorded is what makes a moved policy
 * revision read as `Stale` instead of silently matching the recorded result (F20-AC3).
 *
 * `run` refuses by name. Executing a check means owning an isolated workspace and spawning
 * a process, which is the worker's act; a use case that quietly succeeded here would let a
 * check read as run by a process that never ran it (F20-AC1).
 */
function projectChecksFor(profiles: ProjectProfileRepository): ProjectChecks {
  return {
    policyFor: (projectId): Result<ProjectCheckPolicy, DomainError> => {
      const current = profiles.currentVersion(projectId);
      if (!current.ok) return err(current.error);
      if (current.value === null) {
        return err({
          code: 'NotFound',
          reason: `Project ${projectId} has no saved profile version, so no required check is named for it (F20-AC2).`,
        });
      }
      const version = current.value;
      const policy: RequiredCheckPolicy = {
        policyFingerprint: version.contentFingerprint,
        requiredCheckIds: version.content.policy.requiredChecks,
        approvals: [],
        decidedBy: version.createdBy,
        decidedAt: version.createdAt,
      };
      return ok({ profileVersionId: version.profileVersionId, approved: policy, proposed: policy });
    },
    run: (request) => Promise.resolve(err(noCheckExecution(`check "${request.check.name}"`))),
  };
}

/** Names the missing capability rather than reporting a check nobody ran (F20-AC1). */
function noCheckExecution(what: string): DomainError {
  return {
    code: 'Unavailable',
    reason: `${what} is read from the durable record only: this process never runs a check, because a check runs in an isolated workspace the coding worker owns (F20-AC1).`,
  };
}

/**
 * The provider check reader a process with no adapter bound reports.
 *
 * Declared rather than omitted so a use case that reaches for a live provider read fails
 * with a named cause instead of a missing method. This process configures no adapters, and a
 * reader that invented observations would be the one thing that could turn an unrun check
 * into a `Passed` (F20-AC2).
 */
function providerChecksFor(): ProviderCheckReader {
  return {
    readChecks: () => Promise.resolve(err(noProviderRead())),
    failureOnBase: () => Promise.resolve(err(noProviderRead())),
  };
}

function noProviderRead(): DomainError {
  return {
    code: 'Unavailable',
    reason: 'This process configured no provider adapter that can report check runs, so it cannot observe one. A check result must come from a provider report or from a run this system recorded (F20-AC1).',
  };
}

/** Closes what was opened and returns the refusal, so no handle survives. */
function refuse(database: Database, error: DomainError): Result<never, DomainError> {
  closeDatabase(database);
  return err(error);
}

