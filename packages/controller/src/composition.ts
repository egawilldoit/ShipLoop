/**
 * The composition root (F01-AC1, F02-AC1, F03-AC1, ARCHITECTURE "Authority and
 * durable state").
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
 * Known gap, reported rather than papered over: `@shiploop/storage`'s
 * `migrations.ts` installs plural table names (`owners`, `connectors`, …) while
 * `repositories/core.ts` reads and writes singular ones (`owner`, `connector`, …).
 * The root verifies the tables its repositories need and refuses to start with a
 * named cause rather than handing out a root whose every use case would throw
 * "no such table". The controller-owned `owner_credential` table below is likewise
 * provisional: `OwnerRepository.provision` takes no credential column, so a
 * migration in `@shiploop/storage` carrying owner email and password digest is the
 * change that removes it.
 */

import {
  err,
  ok,
  type DomainError,
  type OwnerId,
  type PasswordHash,
  type Result,
  type ScryptParameters,
} from '@shiploop/domain';
import {
  closeDatabase,
  migrate,
  openDatabase,
  ConnectorRepository,
  OwnerRepository,
  ProcedureRepository,
  ProjectProfileRepository,
} from '@shiploop/storage';
import type {
  Database,
  MigrateOptions,
  OpenDatabaseOptions,
  SqlRow,
  StorageConnection,
} from '@shiploop/storage';
import type { PreflightDeps } from '@shiploop/verification';
import type { AdapterRegistry, ConnectorUseCases } from './connectors.ts';
import { createConnectorUseCases } from './connectors.ts';
import type { ControllerClock, OwnerCredentialRecord, OwnerCredentialStore, ProfileUseCases } from './profiles.ts';
import { createProfileUseCases } from './profiles.ts';

export interface CompositionRootConfig {
  readonly databasePath: string;
  readonly clock: ControllerClock;
  readonly adapters: AdapterRegistry;
  /** Cost override so a test can exercise real hashing without production cost. */
  readonly passwordParameters?: Partial<ScryptParameters>;
  /** Injected probe runner; absent means preflight cannot be attempted (F04-AC2). */
  readonly preflight?: PreflightDeps;
  readonly openDatabaseOptions?: OpenDatabaseOptions;
  readonly migrateOptions?: MigrateOptions;
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
  readonly credentials: OwnerCredentialStore;
  readonly useCases: ProfileUseCases & ConnectorUseCases;
  /** Closes only the database handle this root opened. */
  close(): Result<true, DomainError>;
}

/** The tables the bound repositories read and write. */
const REQUIRED_TABLES: readonly string[] = [
  'owner',
  'owner_session',
  'project_profile_version',
  'connector',
  'procedure_version',
];

/**
 * Provisional owner credential table.
 *
 * It exists because the owner row has nowhere to keep an email or a password
 * digest. Move it into `@shiploop/storage`'s migrations with a credential column on
 * the owner table; nothing else here depends on its shape.
 */
const OWNER_CREDENTIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS owner_credential (
  owner_id      TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;
`;

const OWNER_CREDENTIAL_COLUMNS = 'owner_id, email, password_hash, updated_at';

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

  put(record: OwnerCredentialRecord): Result<OwnerCredentialRecord> {
    try {
      this.connection
        .prepare(
          `INSERT INTO owner_credential (${OWNER_CREDENTIAL_COLUMNS}) VALUES (?, ?, ?, ?)`,
        )
        .run(record.ownerId, record.email, record.passwordHash, record.updatedAt);
    } catch (error) {
      return err({
        code: 'Conflict',
        reason: `An owner credential already exists for that identity; it was not overwritten (${describe(error)}).`,
        expected: 'no owner credential',
        actual: 'existing owner credential',
      });
    }
    return ok(record);
  }

  findByEmail(email: string): Result<OwnerCredentialRecord | null> {
    return this.find('email', email);
  }

  findByOwnerId(ownerId: OwnerId): Result<OwnerCredentialRecord | null> {
    return this.find('owner_id', ownerId);
  }

  private find(column: 'email' | 'owner_id', value: string): Result<OwnerCredentialRecord | null> {
    try {
      const row = this.connection
        .prepare(`SELECT ${OWNER_CREDENTIAL_COLUMNS} FROM owner_credential WHERE ${column} = ?`)
        .get(value);
      if (row === undefined) return ok(null);
      return ok({
        ownerId: requiredText(row, 'owner_id') as OwnerId,
        email: requiredText(row, 'email'),
        passwordHash: requiredText(row, 'password_hash') as PasswordHash,
        updatedAt: requiredText(row, 'updated_at'),
      });
    } catch (error) {
      return err({ code: 'Unavailable', reason: `owner credential lookup failed: ${describe(error)}` });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Installs the provisional owner credential table.
 *
 * Exported so a caller that binds repositories itself, rather than through
 * `createCompositionRoot`, still gets the same table instead of a "no such table"
 * failure at the first sign-in.
 */
export function ensureOwnerCredentialSchema(connection: StorageConnection): Result<true, DomainError> {
  try {
    connection.exec(OWNER_CREDENTIAL_SCHEMA);
  } catch (error) {
    return err({ code: 'Unavailable', reason: `owner credential schema could not be created: ${describe(error)}` });
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
        reason: `The database has no "${missing}" table, so the storage repositories cannot read or write it. @shiploop/storage migrations and repositories currently disagree on table names; the controller refuses to start rather than hand out a root whose use cases would all fail.`,
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
  const credentials = new SqliteOwnerCredentialStore(database);

  const profileUseCases = createProfileUseCases({
    clock: config.clock,
    owners,
    profiles,
    procedures,
    credentials,
    adapters: config.adapters,
    ...(config.passwordParameters === undefined ? {} : { passwordParameters: config.passwordParameters }),
    ...(config.preflight === undefined ? {} : { preflight: config.preflight }),
  });
  const connectorUseCases = createConnectorUseCases({ clock: config.clock, connectors, adapters: config.adapters });

  let closed = false;

  return ok({
    database,
    owners,
    profiles,
    connectors,
    procedures,
    credentials,
    useCases: { ...profileUseCases, ...connectorUseCases },
    close(): Result<true, DomainError> {
      if (closed) return ok(true);
      closed = true;
      return closeDatabase(database);
    },
  });
}

/** Closes what was opened and returns the refusal, so no handle survives. */
function refuse(database: Database, error: DomainError): Result<never, DomainError> {
  closeDatabase(database);
  return err(error);
}

