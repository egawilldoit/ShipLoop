/**
 * Concrete SQLite repositories for the durable core entities.
 *
 * Every method uses prepared statements, returns `Result<T, DomainError>`
 * instead of throwing for an expected refusal, and performs no remote call: a
 * transaction that waits on a provider would hold the single global coding
 * writer open and make a lost response indistinguishable from a lost write
 * (ARCHITECTURE, "Authority and durable state"). Remote work is planned outside
 * a transaction and reconciled against these rows afterwards.
 *
 * The versioned and append-only rules are structural rather than conventional.
 * Profile, procedure and scope-snapshot writes only ever INSERT, so an accepted
 * version cannot be edited after a run has referenced it (F02-AC3, F05-AC4,
 * F12-AC1). Evidence is keyed by candidate fingerprint, so a changed candidate
 * cannot inherit the previous build's results (F20-AC3, F25-AC3).
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  CHECK_RESULTS,
  canonicalize,
  capabilitiesFor,
  candidateFingerprint,
  conflict,
  err,
  fingerprint,
  invalid,
  ok,
  redact,
  scopeFingerprint,
  subjectFingerprint,
} from '@shiploop/domain';
import type {
  AcceptanceState,
  AttentionItemId,
  AttemptId,
  AuthorizationSubject,
  CandidateId,
  CheckResult,
  CommitSha,
  ConnectorId,
  DecisionId,
  DomainError,
  EvidenceId,
  Fingerprint,
  IdeaId,
  OwnerId,
  ProcedureVersionId,
  ProfileVersionId,
  ProjectId,
  Result,
  ScopeSnapshotId,
  ShipLoopId,
  WorkItemId,
} from '@shiploop/domain';
import type {
  AddAttachmentInput,
  AdoptionReference,
  AppendProcedureVersionInput,
  AppendScopeSnapshotInput,
  AttentionItemRecord,
  AttentionItemStore,
  CandidateRecord,
  CandidateStore,
  CapabilitySummary,
  CaptureIdeaInput,
  ConnectorCheckResult,
  ConnectorRecord,
  ConnectorState,
  ConnectorStore,
  CreateSessionInput,
  CreateWorkItemInput,
  EvidenceRecord,
  EvidenceStore,
  IdeaAttachment,
  IdeaRecord,
  IdeaStore,
  IdeaState,
  OwnerDecisionRecord,
  OwnerDecisionState,
  OwnerDecisionStore,
  OwnerCredentialInput,
  OwnerCredentialRecord,
  OwnerDecisionType,
  OwnerRecord,
  OwnerSession,
  OwnerStore,
  ProcedureSource,
  ProcedureStatus,
  ProcedureStore,
  ProcedureVersion,
  ProjectProfileContent,
  ProjectProfileStore,
  ProjectProfileVersion,
  PublicationIntent,
  PublicationState,
  RecordAcceptanceInput,
  RecordAuthorizationInput,
  RecordCandidateInput,
  RecordChangesRequestedInput,
  RecordEvidenceInput,
  RecordSyncResultInput,
  RotateSessionInput,
  SaveProfileVersionInput,
  ScopeSnapshotCriterion,
  ScopeSnapshotRecord,
  SqlRow,
  StorageConnection,
  StorageStatement,
  StorageTransactions,
  UpsertAttentionItemInput,
  UpsertConnectorInput,
  WorkItemRecord,
  WorkItemStore,
  WorkItemSync,
} from './types.ts';

/**
 * Session tokens are stored only as a SHA-256 digest.
 *
 * A database copy must not be replayable as a live session, so the token itself
 * never reaches a column, a log or a backup (F01-AC2).
 */
export function sessionTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const transactionDepth = new WeakMap<StorageConnection, number>();

function rollbackQuietly(connection: StorageConnection): void {
  try {
    connection.exec('ROLLBACK');
  } catch {
    return;
  }
}

/**
 * The bounded transaction used for multi-statement methods.
 *
 * `BEGIN IMMEDIATE` takes the write lock up front so two callers cannot both
 * read a version number and then each append one. When a transaction runner is
 * injected it owns BEGIN/COMMIT/ROLLBACK entirely; otherwise this falls back to
 * the same semantics locally. Either way a call made while a repository
 * transaction is already open joins it instead of issuing a second BEGIN.
 *
 * A caller that opens its own transaction must use the same injected runner,
 * which is required to be nesting-safe; the repository cannot detect a
 * transaction it did not start.
 */
function runBounded<T>(
  connection: StorageConnection,
  transactions: StorageTransactions | undefined,
  body: () => T,
): T {
  if ((transactionDepth.get(connection) ?? 0) > 0) return body();
  transactionDepth.set(connection, 1);
  try {
    return transactions !== undefined
      ? transactions.transaction(body)
      : runLocalTransaction(connection, body);
  } finally {
    transactionDepth.delete(connection);
  }
}

function runLocalTransaction<T>(connection: StorageConnection, body: () => T): T {
  connection.exec('BEGIN IMMEDIATE');
  try {
    const value = body();
    connection.exec('COMMIT');
    return value;
  } catch (error) {
    rollbackQuietly(connection);
    throw error;
  }
}

function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown storage failure';
}

function newId<K extends string>(): ShipLoopId<K> {
  return randomUUID() as ShipLoopId<K>;
}

function requiredText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`column ${column} is missing or not text`);
  return value;
}

function nullableText(row: SqlRow, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

function requiredInteger(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`column ${column} is missing or not an integer`);
}

/**
 * Reads a stored JSON document.
 *
 * Columns hold canonical JSON written by this package, so the cast is the trust
 * boundary: every value in these documents was serialised from a typed record
 * on the way in.
 */
function parseJson<T>(row: SqlRow, column: string): T {
  const parsed: unknown = JSON.parse(requiredText(row, column));
  return parsed as T;
}

function parseStringList(row: SqlRow, column: string): readonly string[] {
  const stored = parseJson<unknown>(row, column);
  if (!Array.isArray(stored)) throw new Error(`column ${column} is not a JSON array`);
  const entries: string[] = [];
  for (const entry of stored as readonly unknown[]) {
    if (typeof entry !== 'string') throw new Error(`column ${column} holds a non-text entry`);
    entries.push(entry);
  }
  return entries;
}

function notFound(entity: string, identity: string): DomainError {
  return { code: 'NotFound', reason: `${entity} ${identity} does not exist.` };
}

function changeCount(changes: number | bigint): number {
  return typeof changes === 'bigint' ? Number(changes) : changes;
}

/**
 * Shared plumbing: prepared-statement caching, bounded transactions, and the
 * conversion of an unexpected driver failure into a typed `Unavailable`.
 *
 * A method body returns its own `Result` so an expected refusal (NotFound,
 * Conflict, Invalid) stays distinguishable from storage being broken.
 */
abstract class SqlRepository {
  private readonly connection: StorageConnection;
  private readonly transactions: StorageTransactions | undefined;
  private readonly cache = new Map<string, StorageStatement>();

  constructor(connection: StorageConnection, transactions?: StorageTransactions) {
    this.connection = connection;
    this.transactions = transactions;
  }

  protected statement(sql: string): StorageStatement {
    const cached = this.cache.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.connection.prepare(sql);
    this.cache.set(sql, prepared);
    return prepared;
  }

  protected bounded<T>(body: () => T): T {
    return runBounded(this.connection, this.transactions, body);
  }

  protected attempt<T>(description: string, body: () => Result<T, DomainError>): Result<T, DomainError> {
    try {
      return body();
    } catch (error) {
      return err({ code: 'Unavailable', reason: `${description} failed: ${failureDetail(error)}` });
    }
  }
}

const OWNER_COLUMNS = 'owner_id, identity_subject, display_name, email, password_digest, created_at';
const SESSION_COLUMNS =
  'session_id, owner_id, token_hash, issued_at, expires_at, revoked_at, rotated_from_session_id';

function toOwner(row: SqlRow): OwnerRecord {
  return {
    ownerId: requiredText(row, 'owner_id') as OwnerId,
    displayName: requiredText(row, 'display_name'),
    email: nullableText(row, 'email'),
    createdAt: requiredText(row, 'created_at'),
  };
}

function toCredential(row: SqlRow): OwnerCredentialRecord {
  return {
    ownerId: requiredText(row, 'owner_id') as OwnerId,
    email: requiredText(row, 'email'),
    passwordDigest: requiredText(row, 'password_digest'),
  };
}

function toSession(row: SqlRow): OwnerSession {
  return {
    sessionId: requiredText(row, 'session_id'),
    ownerId: requiredText(row, 'owner_id') as OwnerId,
    tokenHash: requiredText(row, 'token_hash'),
    issuedAt: requiredText(row, 'issued_at'),
    expiresAt: requiredText(row, 'expires_at'),
    revokedAt: nullableText(row, 'revoked_at'),
    rotatedFromSessionId: nullableText(row, 'rotated_from_session_id'),
  };
}

/**
 * The provisioned owner, their credentials and their sessions (F01-AC1, F01-AC2).
 *
 * There is one provisioned owner, so provisioning twice is a conflict rather
 * than a second identity. Revoking writes `revoked_at`, and `authenticate`
 * refuses a revoked or expired session, which is what makes signing out stop
 * privileged use instead of only removing a cookie.
 *
 * Credentials live on the owner row rather than in a separate table: the
 * migrated schema owns this entity, and a credential with no owner row would be
 * an identity the product cannot authorize. Only the domain's self-describing
 * digest is stored, so the plaintext password has no path to a column, a log or
 * a backup. The address is the sign-in identity and is unique, which is what
 * makes "unknown address" and "wrong password" the same question to ask
 * (N02-AC1).
 */
export class OwnerRepository extends SqlRepository implements OwnerStore {
  provision(
    ownerId: OwnerId,
    displayName: string,
    createdAt: string,
    credential?: OwnerCredentialInput,
  ): Result<OwnerRecord> {
    return this.attempt('provision owner', () =>
      this.bounded(() => {
        const existing = this.statement(`SELECT ${OWNER_COLUMNS} FROM owners WHERE owner_id = ?`).get(ownerId);
        if (existing !== undefined) {
          return err(
            conflict('The owner is already provisioned.', 'no owner', requiredText(existing, 'owner_id')),
          );
        }
        const email = credential?.email.trim().toLowerCase() ?? null;
        if (credential !== undefined && (email === null || email === '' || credential.passwordDigest === '')) {
          return err(
            invalid('An owner credential needs an email address and a password digest.', [
              { path: 'email', message: 'Required.' },
              { path: 'passwordDigest', message: 'Required.' },
            ]),
          );
        }
        this.statement(
          'INSERT INTO owners (owner_id, identity_subject, display_name, email, password_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        // `identity_subject` names the subject an identity PROVIDER knows this
        // owner by. A locally provisioned owner has no such subject, so the
        // column is left NULL rather than filled with the owner id: a value
        // there would claim an external link that does not exist, and a later
        // sign-in would trust it (F01-AC1, ADR 0003 R2).
        ).run(ownerId, null, displayName, email, credential?.passwordDigest ?? null, createdAt);
        return ok<OwnerRecord>({
          ownerId,
          displayName,
          email,
          createdAt,
        });
      }),
    );
  }

  current(): Result<OwnerRecord | null> {
    return this.attempt('read the provisioned owner', () => {
      const row = this.statement(
        `SELECT ${OWNER_COLUMNS} FROM owners ORDER BY created_at ASC, owner_id ASC LIMIT 1`,
      ).get();
      return ok(row === undefined ? null : toOwner(row));
    });
  }

  /**
   * Records the owner's credential after provisioning.
   *
   * A second write is refused rather than overwriting, because a silent
   * replacement would let a caller change the identity the owner signs in with
   * without that being an explicit act.
   */
  setCredential(input: OwnerCredentialInput): Result<OwnerCredentialRecord> {
    return this.attempt('record owner credential', () =>
      this.bounded(() => {
        const email = input.email.trim().toLowerCase();
        if (email === '' || input.passwordDigest === '') {
          return err(
            invalid('An owner credential needs an email address and a password digest.', [
              { path: 'email', message: 'Required.' },
              { path: 'passwordDigest', message: 'Required.' },
            ]),
          );
        }
        const owner = this.statement('SELECT owner_id, email, password_digest FROM owners WHERE owner_id = ?').get(
          input.ownerId,
        );
        if (owner === undefined) return err(notFound('Owner', input.ownerId));
        if (nullableText(owner, 'password_digest') !== null) {
          return err(
            conflict('This owner already has a credential; it was not overwritten.', 'no credential', input.email),
          );
        }
        this.statement('UPDATE owners SET email = ?, password_digest = ? WHERE owner_id = ?').run(
          email,
          input.passwordDigest,
          input.ownerId,
        );
        return ok(toCredential({ ...owner, email, password_digest: input.passwordDigest }));
      }),
    );
  }

  /**
   * Looks a credential up by address.
   *
   * Lookups are by normalised address so an unknown address and a wrong
   * password are indistinguishable to the caller (N02-AC1).
   */
  findCredentialByEmail(email: string): Result<OwnerCredentialRecord | null> {
    return this.attempt('read owner credential by email', () => {
      const row = this.statement(
        'SELECT owner_id, email, password_digest FROM owners WHERE email = ?',
      ).get(email.trim().toLowerCase());
      return ok(row === undefined ? null : toCredential(row));
    });
  }

  findCredentialByOwnerId(ownerId: OwnerId): Result<OwnerCredentialRecord | null> {
    return this.attempt('read owner credential by owner', () => {
      const row = this.statement(
        'SELECT owner_id, email, password_digest FROM owners WHERE owner_id = ? AND password_digest IS NOT NULL',
      ).get(ownerId);
      return ok(row === undefined ? null : toCredential(row));
    });
  }

  createSession(input: CreateSessionInput): Result<OwnerSession> {
    return this.attempt('create owner session', () =>
      this.bounded(() => {
        if (input.token === '') {
          return err(invalid('A session token is required.', [{ path: 'token', message: 'Required.' }]));
        }
        const owner = this.statement(`SELECT ${OWNER_COLUMNS} FROM owners WHERE owner_id = ?`).get(
          input.ownerId,
        );
        if (owner === undefined) return err(notFound('Owner', input.ownerId));
        this.statement(
          `INSERT INTO sessions (${SESSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
        ).run(newId<'SessionId'>(), input.ownerId, sessionTokenHash(input.token), input.issuedAt, input.expiresAt);
        const created = this.statement(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE token_hash = ?`).get(
          sessionTokenHash(input.token),
        );
        if (created === undefined) return err(notFound('Session', 'created session'));
        return ok(toSession(created));
      }),
    );
  }

  authenticate(token: string, now: string): Result<OwnerSession> {
    return this.attempt('authenticate owner session', () => {
      const row = this.statement(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE token_hash = ?`).get(
        sessionTokenHash(token),
      );
      if (row === undefined) {
        return err({ code: 'Forbidden', reason: 'The session is unknown.' });
      }
      const session = toSession(row);
      if (session.revokedAt !== null) {
        return err({ code: 'Forbidden', reason: 'The session was revoked.' });
      }
      if (now >= session.expiresAt) {
        return err({ code: 'Forbidden', reason: 'The session expired.' });
      }
      return ok(session);
    });
  }

  rotateSession(input: RotateSessionInput): Result<OwnerSession> {
    return this.attempt('rotate owner session', () =>
      this.bounded(() => {
        if (input.token === '' || input.newToken === '') {
          return err(
            invalid('Both the current and the replacement token are required.', [
              { path: 'token', message: 'Required.' },
              { path: 'newToken', message: 'Required.' },
            ]),
          );
        }
        const current = this.authenticate(input.token, input.issuedAt);
        if (!current.ok) return current;
        const nextHash = sessionTokenHash(input.newToken);
        if (nextHash === current.value.tokenHash) {
          return err(invalid('The replacement token must differ from the current token.', [
            { path: 'newToken', message: 'Must differ from the current token.' },
          ]));
        }
        this.statement(
          'UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
        ).run(input.issuedAt, current.value.tokenHash);
        this.statement(`INSERT INTO sessions (${SESSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, NULL, ?)`).run(
          newId<'SessionId'>(),
          current.value.ownerId,
          nextHash,
          input.issuedAt,
          input.expiresAt,
          current.value.sessionId,
        );
        const created = this.statement(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE token_hash = ?`).get(
          nextHash,
        );
        if (created === undefined) return err(notFound('Session', 'rotated session'));
        return ok(toSession(created));
      }),
    );
  }

  revokeSession(token: string, revokedAt: string): Result<OwnerSession> {
    return this.attempt('revoke owner session', () =>
      this.bounded(() => {
        const hash = sessionTokenHash(token);
        const row = this.statement(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE token_hash = ?`).get(hash);
        if (row === undefined) return err(notFound('Session', 'unknown token'));
        const session = toSession(row);
        if (session.revokedAt !== null) return ok(session);
        this.statement('UPDATE sessions SET revoked_at = ? WHERE session_id = ?').run(
          revokedAt,
          session.sessionId,
        );
        const updated = this.statement(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`).get(
          session.sessionId,
        );
        if (updated === undefined) return err(notFound('Session', session.sessionId));
        return ok(toSession(updated));
      }),
    );
  }

  revokeAllSessions(ownerId: OwnerId, revokedAt: string): Result<number> {
    return this.attempt('revoke every owner session', () => {
      const changes = this.statement(
        'UPDATE sessions SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL',
      ).run(revokedAt, ownerId);
      return ok(changeCount(changes.changes));
    });
  }
}

const PROFILE_COLUMNS =
  'profile_version_id, project_id, version, supersedes_version_id, content_json, content_fingerprint, note, created_at, created_by';

function toProfileVersion(row: SqlRow): ProjectProfileVersion {
  const supersedes = nullableText(row, 'supersedes_version_id');
  return {
    profileVersionId: requiredText(row, 'profile_version_id') as ProfileVersionId,
    projectId: requiredText(row, 'project_id') as ProjectId,
    versionNumber: requiredInteger(row, 'version'),
    supersedesVersionId: supersedes === null ? null : (supersedes as ProfileVersionId),
    content: parseJson<ProjectProfileContent>(row, 'content_json'),
    contentFingerprint: requiredText(row, 'content_fingerprint') as Fingerprint,
    note: nullableText(row, 'note'),
    createdAt: requiredText(row, 'created_at'),
    createdBy: requiredText(row, 'created_by'),
  };
}

/**
 * The project's display name, derived from the repository it targets.
 *
 * `projects.name` is NOT NULL, and the profile is the only thing that exists when a
 * project is first saved. Deriving the name from the repository keeps the row honest
 * rather than storing a placeholder that would later contradict the profile.
 */
function projectNameFrom(content: ProjectProfileContent): string {
  const repository = content.references.repository.trim();
  if (repository.length === 0) return 'project';
  const segments = repository.replace(/\.git$/, '').split('/');
  return segments[segments.length - 1] ?? repository;
}

/**
 * Versioned project profiles (F02-AC3).
 *
 * `saveVersion` only INSERTs. There is deliberately no update method, because a
 * profile version a run already referenced must keep describing the inputs that
 * run used; a change is a new version, and `listVersionsSince` is how a run
 * discovers that later versions exist.
 */
export class ProjectProfileRepository extends SqlRepository implements ProjectProfileStore {
  saveVersion(input: SaveProfileVersionInput): Result<ProjectProfileVersion> {
    return this.attempt('save project profile version', () =>
      this.bounded(() => {
        // The project row is created on first save rather than demanded separately.
        // A profile version is what makes a project exist in ShipLoop's terms, so
        // making the caller provision an empty project first would mean a project
        // with no saved version, which is not a state any criterion describes.
        // The insert is ignored when the row already exists, so an existing project
        // is never reset by a later profile save.
        this.statement(
          'INSERT INTO projects (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id) DO NOTHING',
        ).run(input.projectId, projectNameFrom(input.content), input.createdAt, input.createdAt);

        const newest = this.statement(
          'SELECT profile_version_id, version FROM project_profile_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1',
        ).get(input.projectId);
        const newestNumber = newest === undefined ? 0 : requiredInteger(newest, 'version');
        if (input.expectedVersionNumber !== null && input.expectedVersionNumber !== newestNumber) {
          return err(
            conflict(
              'The profile changed since it was loaded.',
              String(input.expectedVersionNumber),
              String(newestNumber),
            ),
          );
        }
        const versionId = newId<'ProfileVersionId'>();
        const supersedes = newest === undefined ? null : requiredText(newest, 'profile_version_id');
        const contentFingerprint = fingerprint(input.content);
        this.statement(
          `INSERT INTO project_profile_versions (${PROFILE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          versionId,
          input.projectId,
          newestNumber + 1,
          supersedes,
          canonicalize(input.content),
          contentFingerprint,
          input.note,
          input.createdAt,
          input.createdBy,
        );
        const created = this.statement(
          `SELECT ${PROFILE_COLUMNS} FROM project_profile_versions WHERE profile_version_id = ?`,
        ).get(versionId);
        if (created === undefined) return err(notFound('Profile version', versionId));
        return ok(toProfileVersion(created));
      }),
    );
  }

  getVersion(profileVersionId: ProfileVersionId): Result<ProjectProfileVersion> {
    return this.attempt('read project profile version', () => {
      const row = this.statement(
        `SELECT ${PROFILE_COLUMNS} FROM project_profile_versions WHERE profile_version_id = ?`,
      ).get(profileVersionId);
      if (row === undefined) return err(notFound('Profile version', profileVersionId));
      return ok(toProfileVersion(row));
    });
  }

  currentVersion(projectId: ProjectId): Result<ProjectProfileVersion | null> {
    return this.attempt('read the current project profile version', () => {
      const row = this.statement(
        `SELECT ${PROFILE_COLUMNS} FROM project_profile_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1`,
      ).get(projectId);
      return ok(row === undefined ? null : toProfileVersion(row));
    });
  }

  listVersions(projectId: ProjectId): Result<readonly ProjectProfileVersion[]> {
    return this.attempt('list project profile versions', () => {
      const rows = this.statement(
        `SELECT ${PROFILE_COLUMNS} FROM project_profile_versions WHERE project_id = ? ORDER BY version ASC`,
      ).all(projectId);
      return ok(rows.map(toProfileVersion));
    });
  }

  listVersionsSince(
    projectId: ProjectId,
    versionNumber: number,
  ): Result<readonly ProjectProfileVersion[]> {
    return this.attempt('list later project profile versions', () => {
      const rows = this.statement(
        `SELECT ${PROFILE_COLUMNS} FROM project_profile_versions WHERE project_id = ? AND version > ? ORDER BY version ASC`,
      ).all(projectId, versionNumber);
      return ok(rows.map(toProfileVersion));
    });
  }
}

const CONNECTOR_COLUMNS =
  'connector_id, project_id, provider, kind, resource_scope, credential_ref, credential_reference_digest, capability_json, state, error, last_checked_at, last_success_at, created_at, updated_at';

const CONNECTOR_KINDS: readonly string[] = ['Ticket', 'Git', 'Deployment', 'Engine'];
const CONNECTOR_STATES: readonly string[] = ['Unconfigured', 'Healthy', 'Degraded', 'Revoked', 'Unreachable'];

function toConnector(row: SqlRow): ConnectorRecord {
  return {
    connectorId: requiredText(row, 'connector_id') as ConnectorId,
    projectId: requiredText(row, 'project_id') as ProjectId,
    provider: requiredText(row, 'provider'),
    kind: requiredText(row, 'kind') as ConnectorRecord['kind'],
    resourceScope: requiredText(row, 'resource_scope'),
    credentialReference: requiredText(row, 'credential_ref'),
    credentialReferenceDigest: requiredText(row, 'credential_reference_digest'),
    declarations: parseJson<ConnectorRecord['declarations']>(row, 'capability_json'),
    state: requiredText(row, 'state') as ConnectorState,
    error: nullableText(row, 'error'),
    lastCheckedAt: nullableText(row, 'last_checked_at'),
    lastSuccessAt: nullableText(row, 'last_success_at'),
    createdAt: requiredText(row, 'created_at'),
    updatedAt: requiredText(row, 'updated_at'),
  };
}

/**
 * Connectors (F03-AC2, F03-AC3).
 *
 * A row holds a credential *reference* and nothing else. A value that matches a
 * configured secret pattern is refused rather than stored, because the cheapest
 * moment to keep a secret out of a backup and an export is before it is written.
 *
 * The project row is created on first registration. F03-AC1 configures connectors
 * before a profile version necessarily exists, and the schema makes
 * `connectors.project_id` a foreign key; requiring an empty project to exist first
 * would mean a project in a state no criterion describes. `name` is derived from
 * the resource scope so the row never carries a placeholder a later profile save
 * would contradict.
 */
export class ConnectorRepository extends SqlRepository implements ConnectorStore {
  upsert(input: UpsertConnectorInput): Result<ConnectorRecord> {
    return this.attempt('save connector', () =>
      this.bounded(() => {
        if (!CONNECTOR_KINDS.includes(input.kind)) {
          return err(invalid(`Unknown connector kind: ${input.kind}`, [
            { path: 'kind', message: `Must be one of ${CONNECTOR_KINDS.join(', ')}.` },
          ]));
        }
        if (!CONNECTOR_STATES.includes(input.state)) {
          return err(invalid(`Unknown connector state: ${input.state}`, [
            { path: 'state', message: `Must be one of ${CONNECTOR_STATES.join(', ')}.` },
          ]));
        }
        if (input.credentialReference.trim() === '') {
          return err(invalid('A credential reference is required.', [
            { path: 'credentialReference', message: 'Required.' },
          ]));
        }
        const exposed = redact(input.credentialReference).appliedLabels;
        if (exposed.length > 0) {
          return err(
            invalid('The credential field holds a secret value, not a reference.', [
              {
                path: 'credentialReference',
                message: `Matches the ${exposed.join(', ')} credential pattern; store a reference instead.`,
              },
            ]),
          );
        }
        const digest = createHash('sha256').update(input.credentialReference, 'utf8').digest('hex');
        const scope = input.resourceScope.trim();
        this.statement(
          'INSERT INTO projects (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id) DO NOTHING',
        ).run(input.projectId, scope === '' ? String(input.projectId) : scope, input.at, input.at);
        const existing = this.statement(
          `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE project_id = ? AND kind = ?`,
        ).get(input.projectId, input.kind);
        const connectorId = existing === undefined ? newId<'ConnectorId'>() : requiredText(existing, 'connector_id');
        if (existing === undefined) {
          this.statement(
            `INSERT INTO connectors (${CONNECTOR_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
          ).run(
            connectorId,
            input.projectId,
            input.provider,
            input.kind,
            input.resourceScope,
            input.credentialReference,
            digest,
            canonicalize(input.declarations),
            input.state,
            input.error,
            input.at,
            input.at,
          );
        } else {
          this.statement(
            'UPDATE connectors SET provider = ?, resource_scope = ?, credential_reference = ?, credential_reference_digest = ?, capability_json = ?, state = ?, error = ?, updated_at = ? WHERE connector_id = ?',
          ).run(
            input.provider,
            input.resourceScope,
            input.credentialReference,
            digest,
            canonicalize(input.declarations),
            input.state,
            input.error,
            input.at,
            connectorId,
          );
        }
        const saved = this.statement(
          `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE connector_id = ?`,
        ).get(connectorId);
        if (saved === undefined) return err(notFound('Connector', connectorId));
        return ok(toConnector(saved));
      }),
    );
  }

  get(connectorId: ConnectorId): Result<ConnectorRecord> {
    return this.attempt('read connector', () => {
      const row = this.statement(`SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE connector_id = ?`).get(
        connectorId,
      );
      if (row === undefined) return err(notFound('Connector', connectorId));
      return ok(toConnector(row));
    });
  }

  findByKind(projectId: ProjectId, kind: ConnectorRecord['kind']): Result<ConnectorRecord | null> {
    return this.attempt('read connector by kind', () => {
      const row = this.statement(
        `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE project_id = ? AND kind = ?`,
      ).get(projectId, kind);
      return ok(row === undefined ? null : toConnector(row));
    });
  }

  listForProject(projectId: ProjectId): Result<readonly ConnectorRecord[]> {
    return this.attempt('list project connectors', () => {
      const rows = this.statement(
        `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE project_id = ? ORDER BY kind ASC`,
      ).all(projectId);
      return ok(rows.map(toConnector));
    });
  }

  /**
   * Records one capability/health probe.
   *
   * `last_success_at` only moves forward, so a failure cannot present itself as
   * a successful check and leave the owner with a misleading freshness claim
   * (F03-AC2).
   */
  recordCheck(connectorId: ConnectorId, result: ConnectorCheckResult): Result<ConnectorRecord> {
    return this.attempt('record connector check', () =>
      this.bounded(() => {
        const existing = this.statement(
          `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE connector_id = ?`,
        ).get(connectorId);
        if (existing === undefined) return err(notFound('Connector', connectorId));
        const declarations =
          result.declarations === null
            ? requiredText(existing, 'capability_json')
            : canonicalize(result.declarations);
        this.statement(
          'UPDATE connectors SET capability_json = ?, state = ?, error = ?, last_checked_at = ?, last_success_at = ?, updated_at = ? WHERE connector_id = ?',
        ).run(
          declarations,
          result.state,
          result.error,
          result.checkedAt,
          result.succeeded ? result.checkedAt : nullableText(existing, 'last_success_at'),
          result.checkedAt,
          connectorId,
        );
        const updated = this.statement(
          `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE connector_id = ?`,
        ).get(connectorId);
        if (updated === undefined) return err(notFound('Connector', connectorId));
        return ok(toConnector(updated));
      }),
    );
  }

  revoke(connectorId: ConnectorId, revokedAt: string, reason: string): Result<ConnectorRecord> {
    return this.attempt('revoke connector', () =>
      this.bounded(() => {
        const existing = this.statement(
          `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE connector_id = ?`,
        ).get(connectorId);
        if (existing === undefined) return err(notFound('Connector', connectorId));
        this.statement(
          'UPDATE connectors SET state = ?, error = ?, updated_at = ? WHERE connector_id = ?',
        ).run('Revoked', reason, revokedAt, connectorId);
        const updated = this.statement(
          `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE connector_id = ?`,
        ).get(connectorId);
        if (updated === undefined) return err(notFound('Connector', connectorId));
        return ok(toConnector(updated));
      }),
    );
  }

  capabilitySummary(connectorId: ConnectorId): Result<CapabilitySummary> {
    return this.attempt('read connector capabilities', () => {
      const row = this.statement(
        `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE connector_id = ?`,
      ).get(connectorId);
      if (row === undefined) return err(notFound('Connector', connectorId));
      const record = toConnector(row);
      const summary = capabilitiesFor(record.declarations);
      return ok({
        reads: [...summary.reads],
        writes: [...summary.writes],
        unsupported: summary.unsupported.map((entry) => ({ ...entry })),
      });
    });
  }
}

const PROCEDURE_COLUMNS =
  'procedure_version_id, project_id, subject_key, version, kind, scope, source, source_revision, content, content_fingerprint, status, last_verified_revision, last_verified_at, approved_at, created_at, created_by, note';

const PROCEDURE_STATUSES: readonly string[] = ['Proposed', 'Accepted', 'Superseded', 'Retired'];

function toProcedureVersion(row: SqlRow): ProcedureVersion {
  return {
    procedureVersionId: requiredText(row, 'procedure_version_id') as ProcedureVersionId,
    projectId: requiredText(row, 'project_id') as ProjectId,
    subjectKey: requiredText(row, 'subject_key'),
    versionNumber: requiredInteger(row, 'version'),
    kind: requiredText(row, 'kind') as ProcedureVersion['kind'],
    scope: requiredText(row, 'scope'),
    source: requiredText(row, 'source') as ProcedureSource,
    sourceRevision: nullableText(row, 'source_revision'),
    content: requiredText(row, 'content'),
    contentFingerprint: requiredText(row, 'content_fingerprint') as Fingerprint,
    status: requiredText(row, 'status') as ProcedureStatus,
    lastVerifiedRevision: nullableText(row, 'last_verified_revision'),
    lastVerifiedAt: nullableText(row, 'last_verified_at'),
    acceptedAt: nullableText(row, 'approved_at'),
    createdAt: requiredText(row, 'created_at'),
    createdBy: requiredText(row, 'created_by'),
    note: nullableText(row, 'note'),
  };
}

/**
 * Versioned project facts and procedures (F05-AC1, F05-AC4).
 *
 * `appendVersion` is the only way content is added, and `currentVersion` reads
 * only `Accepted` rows. A `Proposed` row is therefore visible to the owner and
 * invisible to future runs, which is exactly the separation F05-AC4 requires: a
 * suggested improvement needs an explicit save action before it can change what
 * an agent is told.
 */
export class ProcedureRepository extends SqlRepository implements ProcedureStore {
  appendVersion(input: AppendProcedureVersionInput): Result<ProcedureVersion> {
    return this.attempt('append procedure version', () =>
      this.bounded(() => {
        if (!PROCEDURE_STATUSES.includes(input.status)) {
          return err(invalid(`Unknown procedure status: ${input.status}`, [
            { path: 'status', message: `Must be one of ${PROCEDURE_STATUSES.join(', ')}.` },
          ]));
        }
        const newest = this.statement(
          'SELECT version FROM procedure_versions WHERE project_id = ? AND subject_key = ? ORDER BY version DESC LIMIT 1',
        ).get(input.projectId, input.subjectKey);
        const newestNumber = newest === undefined ? 0 : requiredInteger(newest, 'version');
        if (input.expectedVersionNumber !== null && input.expectedVersionNumber !== newestNumber) {
          return err(
            conflict(
              'The procedure changed since it was loaded.',
              String(input.expectedVersionNumber),
              String(newestNumber),
            ),
          );
        }
        if (input.status === 'Accepted') {
          this.statement(
            "UPDATE procedure_versions SET status = 'Superseded' WHERE project_id = ? AND subject_key = ? AND status = 'Accepted'",
          ).run(input.projectId, input.subjectKey);
        }
        const versionId = newId<'ProcedureVersionId'>();
        this.statement(
          `INSERT INTO procedure_versions (${PROCEDURE_COLUMNS}, content_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
        ).run(
          versionId,
          input.projectId,
          input.subjectKey,
          newestNumber + 1,
          input.kind,
          input.scope,
          input.source,
          input.sourceRevision,
          input.content,
          fingerprint(input.content),
          input.status,
          input.status === 'Accepted' ? input.createdAt : null,
          input.createdAt,
          input.createdBy,
          input.note,
          canonicalize(input.content),
        );
        const created = this.statement(
          `SELECT ${PROCEDURE_COLUMNS} FROM procedure_versions WHERE procedure_version_id = ?`,
        ).get(versionId);
        if (created === undefined) return err(notFound('Procedure version', versionId));
        return ok(toProcedureVersion(created));
      }),
    );
  }

  acceptVersion(procedureVersionId: ProcedureVersionId, acceptedAt: string): Result<ProcedureVersion> {
    return this.attempt('accept procedure version', () =>
      this.bounded(() => {
        const row = this.statement(
          `SELECT ${PROCEDURE_COLUMNS} FROM procedure_versions WHERE procedure_version_id = ?`,
        ).get(procedureVersionId);
        if (row === undefined) return err(notFound('Procedure version', procedureVersionId));
        const target = toProcedureVersion(row);
        if (target.status !== 'Proposed') {
          return err(
            conflict('Only a proposed version can be accepted.', 'Proposed', target.status),
          );
        }
        this.statement(
          "UPDATE procedure_versions SET status = 'Superseded' WHERE project_id = ? AND subject_key = ? AND status = 'Accepted' AND procedure_version_id <> ?",
        ).run(target.projectId, target.subjectKey, procedureVersionId);
        this.statement(
          'UPDATE procedure_versions SET status = ?, approved_at = ? WHERE procedure_version_id = ?',
        ).run('Accepted', acceptedAt, procedureVersionId);
        const updated = this.statement(
          `SELECT ${PROCEDURE_COLUMNS} FROM procedure_versions WHERE procedure_version_id = ?`,
        ).get(procedureVersionId);
        if (updated === undefined) return err(notFound('Procedure version', procedureVersionId));
        return ok(toProcedureVersion(updated));
      }),
    );
  }

  getVersion(procedureVersionId: ProcedureVersionId): Result<ProcedureVersion> {
    return this.attempt('read procedure version', () => {
      const row = this.statement(
        `SELECT ${PROCEDURE_COLUMNS} FROM procedure_versions WHERE procedure_version_id = ?`,
      ).get(procedureVersionId);
      if (row === undefined) return err(notFound('Procedure version', procedureVersionId));
      return ok(toProcedureVersion(row));
    });
  }

  currentVersion(projectId: ProjectId, subjectKey: string): Result<ProcedureVersion | null> {
    return this.attempt('read the current procedure version', () => {
      const row = this.statement(
        `SELECT ${PROCEDURE_COLUMNS} FROM procedure_versions WHERE project_id = ? AND subject_key = ? AND status = 'Accepted' ORDER BY version DESC LIMIT 1`,
      ).get(projectId, subjectKey);
      return ok(row === undefined ? null : toProcedureVersion(row));
    });
  }

  listVersions(projectId: ProjectId, subjectKey: string): Result<readonly ProcedureVersion[]> {
    return this.attempt('list procedure versions', () => {
      const rows = this.statement(
        `SELECT ${PROCEDURE_COLUMNS} FROM procedure_versions WHERE project_id = ? AND subject_key = ? ORDER BY version ASC`,
      ).all(projectId, subjectKey);
      return ok(rows.map(toProcedureVersion));
    });
  }

  listProposed(projectId: ProjectId): Result<readonly ProcedureVersion[]> {
    return this.attempt('list proposed procedure versions', () => {
      const rows = this.statement(
        `SELECT ${PROCEDURE_COLUMNS} FROM procedure_versions WHERE project_id = ? AND status = 'Proposed' ORDER BY created_at ASC, version ASC`,
      ).all(projectId);
      return ok(rows.map(toProcedureVersion));
    });
  }

  recordVerification(
    procedureVersionId: ProcedureVersionId,
    revision: string,
    verifiedAt: string,
  ): Result<ProcedureVersion> {
    return this.attempt('record procedure verification', () =>
      this.bounded(() => {
        const existing = this.statement(
          'SELECT procedure_version_id FROM procedure_versions WHERE procedure_version_id = ?',
        ).get(procedureVersionId);
        if (existing === undefined) return err(notFound('Procedure version', procedureVersionId));
        this.statement(
          'UPDATE procedure_versions SET last_verified_revision = ?, last_verified_at = ? WHERE procedure_version_id = ?',
        ).run(revision, verifiedAt, procedureVersionId);
        const updated = this.statement(
          `SELECT ${PROCEDURE_COLUMNS} FROM procedure_versions WHERE procedure_version_id = ?`,
        ).get(procedureVersionId);
        if (updated === undefined) return err(notFound('Procedure version', procedureVersionId));
        return ok(toProcedureVersion(updated));
      }),
    );
  }
}

const IDEA_COLUMNS =
  'idea_id, project_id, kind, raw_request, notes, bug_expected, bug_actual, bug_reproduction, generated_summary, agreed_brief, open_questions, state, published_work_item_id, archived_at, archived_reason, created_at, updated_at';

function toIdea(row: SqlRow): IdeaRecord {
  const projectId = nullableText(row, 'project_id');
  const publishedWorkItemId = nullableText(row, 'published_work_item_id');
  return {
    ideaId: requiredText(row, 'idea_id') as IdeaId,
    projectId: projectId === null ? null : (projectId as ProjectId),
    kind: requiredText(row, 'kind') as IdeaRecord['kind'],
    rawRequest: requiredText(row, 'raw_request'),
    notes: nullableText(row, 'notes'),
    bugExpected: nullableText(row, 'bug_expected'),
    bugActual: nullableText(row, 'bug_actual'),
    bugReproduction: nullableText(row, 'bug_reproduction'),
    generatedSummary: nullableText(row, 'generated_summary'),
    agreedBrief: nullableText(row, 'agreed_brief'),
    openQuestions: parseStringList(row, 'open_questions'),
    state: requiredText(row, 'state') as IdeaState,
    publishedWorkItemId: publishedWorkItemId === null ? null : (publishedWorkItemId as WorkItemId),
    archivedAt: nullableText(row, 'archived_at'),
    archivedReason: nullableText(row, 'archived_reason'),
    createdAt: requiredText(row, 'created_at'),
    updatedAt: requiredText(row, 'updated_at'),
  };
}

/**
 * Raw intake (F06-AC1, F06-AC5).
 *
 * No method can change `rawRequest`: what the owner typed is captured once, and
 * generated material is written to `generated_summary` or `agreed_brief`. That
 * keeps the original recoverable even when a summary is wrong.
 *
 * `archive` refuses an idea that already has a published work item, so
 * deferring intake can never look like it withdrew real work (F06-AC5).
 */
export class IdeaRepository extends SqlRepository implements IdeaStore {
  capture(input: CaptureIdeaInput): Result<IdeaRecord> {
    return this.attempt('capture idea', () => {
      if (input.rawRequest.trim() === '') {
        return err(invalid('A raw request is required.', [
          { path: 'rawRequest', message: 'Required.' },
        ]));
      }
      const ideaId = newId<'IdeaId'>();
      this.statement(
        `INSERT INTO ideas (${IDEA_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'Received', NULL, NULL, NULL, ?, ?)`,
      ).run(
        ideaId,
        input.projectId,
        input.kind,
        input.rawRequest,
        input.notes,
        input.bugExpected,
        input.bugActual,
        input.bugReproduction,
        canonicalize([]),
        input.capturedAt,
        input.capturedAt,
      );
      const created = this.statement(`SELECT ${IDEA_COLUMNS} FROM ideas WHERE idea_id = ?`).get(ideaId);
      if (created === undefined) return err(notFound('Idea', ideaId));
      return ok(toIdea(created));
    });
  }

  get(ideaId: IdeaId): Result<IdeaRecord> {
    return this.attempt('read idea', () => {
      const row = this.statement(`SELECT ${IDEA_COLUMNS} FROM ideas WHERE idea_id = ?`).get(ideaId);
      if (row === undefined) return err(notFound('Idea', ideaId));
      return ok(toIdea(row));
    });
  }

  list(filter: {
    readonly projectId: ProjectId | null;
    readonly state: IdeaState | null;
  }): Result<readonly IdeaRecord[]> {
    return this.attempt('list ideas', () => {
      const clauses: string[] = [];
      const parameters: (string | null)[] = [];
      if (filter.projectId !== null) {
        clauses.push('project_id = ?');
        parameters.push(filter.projectId);
      }
      if (filter.state !== null) {
        clauses.push('state = ?');
        parameters.push(filter.state);
      }
      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
      const rows = this.statement(
        `SELECT ${IDEA_COLUMNS} FROM ideas${where} ORDER BY created_at ASC, idea_id ASC`,
      ).all(...parameters);
      return ok(rows.map(toIdea));
    });
  }

  recordSummary(ideaId: IdeaId, summary: string, at: string): Result<IdeaRecord> {
    return this.attempt('record generated summary', () =>
      this.bounded(() => {
        const idea = this.get(ideaId);
        if (!idea.ok) return idea;
        if (idea.value.state === 'Abandoned') {
          return err(conflict('An abandoned idea cannot be summarised.', 'active', 'Abandoned'));
        }
        this.statement('UPDATE ideas SET generated_summary = ?, updated_at = ? WHERE idea_id = ?').run(
          summary,
          at,
          ideaId,
        );
        return this.get(ideaId);
      }),
    );
  }

  recordAgreedBrief(
    ideaId: IdeaId,
    brief: string,
    openQuestions: readonly string[],
    at: string,
  ): Result<IdeaRecord> {
    return this.attempt('record agreed brief', () =>
      this.bounded(() => {
        const idea = this.get(ideaId);
        if (!idea.ok) return idea;
        if (idea.value.state === 'Abandoned') {
          return err(conflict('An abandoned idea cannot be clarified.', 'active', 'Abandoned'));
        }
        this.statement(
          "UPDATE ideas SET agreed_brief = ?, open_questions = ?, state = 'Planned', updated_at = ? WHERE idea_id = ?",
        ).run(brief, canonicalize(openQuestions), at, ideaId);
        return this.get(ideaId);
      }),
    );
  }

  addAttachment(input: AddAttachmentInput): Result<IdeaAttachment> {
    return this.attempt('add idea attachment', () => {
      const idea = this.statement('SELECT idea_id FROM ideas WHERE idea_id = ?').get(input.ideaId);
      if (idea === undefined) return err(notFound('Idea', input.ideaId));
      const attachmentId = newId<'IdeaAttachmentId'>();
      // 'artifact_ref' is where the bytes live; 'relative_path' is the same
      // reference as the caller states it, so the row records the pointer once
      // and the digest proves what the pointer resolved to (F06-AC1).
      this.statement(
        'INSERT INTO idea_attachments (attachment_id, idea_id, artifact_ref, file_name, media_type, byte_size, content_digest, relative_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        attachmentId,
        input.ideaId,
        input.relativePath,
        input.fileName,
        input.mediaType,
        input.byteSize,
        input.contentDigest,
        input.relativePath,
        input.createdAt,
      );
      const created = this.statement(
        'SELECT attachment_id, idea_id, file_name, media_type, byte_size, content_digest, relative_path, created_at FROM idea_attachments WHERE attachment_id = ?',
      ).get(attachmentId);
      if (created === undefined) return err(notFound('Idea attachment', attachmentId));
      return ok(toAttachment(created));
    });
  }

  listAttachments(ideaId: IdeaId): Result<readonly IdeaAttachment[]> {
    return this.attempt('list idea attachments', () => {
      const rows = this.statement(
        'SELECT attachment_id, idea_id, file_name, media_type, byte_size, content_digest, relative_path, created_at FROM idea_attachments WHERE idea_id = ? ORDER BY created_at ASC, attachment_id ASC',
      ).all(ideaId);
      return ok(rows.map(toAttachment));
    });
  }

  markPublished(ideaId: IdeaId, workItemId: WorkItemId, at: string): Result<IdeaRecord> {
    return this.attempt('mark idea published', () =>
      this.bounded(() => {
        const idea = this.get(ideaId);
        if (!idea.ok) return idea;
        this.statement(
          "UPDATE ideas SET state = 'Published', published_work_item_id = ?, archived_at = NULL, archived_reason = NULL, updated_at = ? WHERE idea_id = ?",
        ).run(workItemId, at, ideaId);
        return this.get(ideaId);
      }),
    );
  }

  archive(ideaId: IdeaId, reason: string, at: string): Result<IdeaRecord> {
    return this.attempt('archive idea', () =>
      this.bounded(() => {
        const idea = this.get(ideaId);
        if (!idea.ok) return idea;
        if (idea.value.publishedWorkItemId !== null) {
          return err(
            conflict(
              'This idea already produced published work and cannot be archived from intake.',
              'unpublished',
              idea.value.publishedWorkItemId,
            ),
          );
        }
        this.statement(
          "UPDATE ideas SET state = 'Abandoned', archived_at = ?, archived_reason = ?, updated_at = ? WHERE idea_id = ?",
        ).run(at, reason, at, ideaId);
        return this.get(ideaId);
      }),
    );
  }
}

function toAttachment(row: SqlRow): IdeaAttachment {
  return {
    attachmentId: requiredText(row, 'attachment_id'),
    ideaId: requiredText(row, 'idea_id') as IdeaId,
    fileName: requiredText(row, 'file_name'),
    mediaType: requiredText(row, 'media_type'),
    byteSize: requiredInteger(row, 'byte_size'),
    contentDigest: requiredText(row, 'content_digest'),
    relativePath: requiredText(row, 'relative_path'),
    createdAt: requiredText(row, 'created_at'),
  };
}

const WORK_ITEM_COLUMNS =
  'work_item_id, project_id, profile_version_id, source, origin, title, external_issue_id, external_issue_identifier, external_issue_url, publication_intent, publication_state, publication_operation_id, related_work_item_ids, adoption_json, created_at, updated_at';

const PUBLICATION_STATES: readonly string[] = [
  'Unpublished',
  'Publishing',
  'Published',
  'OutcomeUnknown',
  'NotPublishing',
];

/**
 * The durable origin of a work item, derived from how it entered the system.
 *
 * The schema records origin separately from publication intent: an adopted
 * issue already exists at the provider, while anything ShipLoop proposed began
 * here and may never be published at all (F11, F10). The two are recorded
 * independently so "we wrote it" can never be read as "the provider has it".
 */
function originFor(source: WorkItemRecord['source']): 'Proposed' | 'Published' | 'Adopted' {
  return source === 'AdoptedIssue' ? 'Adopted' : 'Proposed';
}

function toWorkItem(row: SqlRow): WorkItemRecord {
  const externalIssueId = nullableText(row, 'external_issue_id');
  const externalIssueIdentifier = nullableText(row, 'external_issue_identifier');
  const externalIssueUrl = nullableText(row, 'external_issue_url');
  const publicationOperationId = nullableText(row, 'publication_operation_id');
  const profileVersionId = requiredText(row, 'profile_version_id');
  return {
    workItemId: requiredText(row, 'work_item_id') as WorkItemId,
    projectId: requiredText(row, 'project_id') as ProjectId,
    profileVersionId: profileVersionId as ProfileVersionId,
    source: requiredText(row, 'source') as WorkItemRecord['source'],
    title: requiredText(row, 'title'),
    externalIssueId,
    externalIssueIdentifier,
    externalIssueUrl,
    publicationIntent: requiredText(row, 'publication_intent') as PublicationIntent,
    publicationState: requiredText(row, 'publication_state') as PublicationState,
    publicationOperationId,
    relatedWorkItemIds: parseStringList(row, 'related_work_item_ids'),
    adoption: parseJson<AdoptionReference | null>(row, 'adoption_json'),
    createdAt: requiredText(row, 'created_at'),
    updatedAt: requiredText(row, 'updated_at'),
  };
}

const SNAPSHOT_COLUMNS =
  'scope_snapshot_id, work_item_id, sequence_number, attempt_id, issue_id, issue_identifier, title, description, provider_revision, priority, dependency_issue_ids, acceptance_criteria, retrieved_at, scope_fingerprint, profile_version_id, procedure_version_id, captured_at, correlation_id';

function toScopeSnapshot(row: SqlRow): ScopeSnapshotRecord {
  const attemptId = nullableText(row, 'attempt_id');
  return {
    scopeSnapshotId: requiredText(row, 'scope_snapshot_id') as ScopeSnapshotId,
    workItemId: requiredText(row, 'work_item_id') as WorkItemId,
    sequenceNumber: requiredInteger(row, 'sequence_number'),
    attemptId: attemptId === null ? null : (attemptId as AttemptId),
    issueId: requiredText(row, 'issue_id'),
    issueIdentifier: requiredText(row, 'issue_identifier'),
    title: requiredText(row, 'title'),
    description: requiredText(row, 'description'),
    providerRevision: nullableText(row, 'provider_revision'),
    priority: nullableText(row, 'priority'),
    dependencyIssueIds: parseStringList(row, 'dependency_issue_ids'),
    acceptanceCriteria: parseJson<readonly ScopeSnapshotCriterion[]>(row, 'acceptance_criteria'),
    retrievedAt: requiredText(row, 'retrieved_at'),
    scopeFingerprint: requiredText(row, 'scope_fingerprint') as Fingerprint,
    profileVersionId: requiredText(row, 'profile_version_id') as ProfileVersionId,
    procedureVersionId: requiredText(row, 'procedure_version_id'),
    capturedAt: requiredText(row, 'captured_at'),
    correlationId: nullableText(row, 'correlation_id'),
  };
}

/**
 * Work mapping, external sync state and scope snapshots (F10, F11, F12, F16-AC4).
 *
 * Publication intent and publication state are separate columns, so an intent to
 * publish can never be read as a confirmed ticket. A publish whose response was
 * lost is recorded as `OutcomeUnknown` for reconciliation instead of being
 * retried blind (F28-AC4).
 *
 * Scope snapshots are append-only: this repository exposes no update or delete,
 * and the schema installs triggers that abort both. Reconciliation records a new
 * snapshot plus a decision rather than editing history (F12-AC1).
 */
export class WorkItemRepository extends SqlRepository implements WorkItemStore {
  create(input: CreateWorkItemInput): Result<WorkItemRecord> {
    return this.attempt('create work item', () =>
      this.bounded(() => {
        const workItemId = newId<'WorkItemId'>();
        if (input.externalIssueId !== null) {
          const existing = this.statement(
            'SELECT work_item_id FROM work_items WHERE external_issue_id = ?',
          ).get(input.externalIssueId);
          if (existing !== undefined) {
            return err(
              conflict('That external issue is already mapped to a work item.', 'unmapped', input.externalIssueId),
            );
          }
        }
        const publicationState: PublicationState =
          input.publicationIntent === 'DoNotPublish' ? 'NotPublishing' : 'Unpublished';
        this.statement(
          `INSERT INTO work_items (${WORK_ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        ).run(
          workItemId,
          input.projectId,
          input.profileVersionId,
          input.source,
          originFor(input.source),
          input.title,
          input.externalIssueId,
          input.externalIssueIdentifier,
          input.externalIssueUrl,
          input.publicationIntent,
          publicationState,
          canonicalize(input.relatedWorkItemIds),
          canonicalize(input.adoption),
          input.at,
          input.at,
        );
        const created = this.statement(`SELECT ${WORK_ITEM_COLUMNS} FROM work_items WHERE work_item_id = ?`).get(
          workItemId,
        );
        if (created === undefined) return err(notFound('Work item', workItemId));
        return ok(toWorkItem(created));
      }),
    );
  }

  get(workItemId: WorkItemId): Result<WorkItemRecord> {
    return this.attempt('read work item', () => {
      const row = this.statement(`SELECT ${WORK_ITEM_COLUMNS} FROM work_items WHERE work_item_id = ?`).get(
        workItemId,
      );
      if (row === undefined) return err(notFound('Work item', workItemId));
      return ok(toWorkItem(row));
    });
  }

  findByExternalIssueId(externalIssueId: string): Result<WorkItemRecord | null> {
    return this.attempt('read work item by external issue', () => {
      const row = this.statement(
        `SELECT ${WORK_ITEM_COLUMNS} FROM work_items WHERE external_issue_id = ?`,
      ).get(externalIssueId);
      return ok(row === undefined ? null : toWorkItem(row));
    });
  }

  listForProject(projectId: ProjectId): Result<readonly WorkItemRecord[]> {
    return this.attempt('list project work items', () => {
      const rows = this.statement(
        `SELECT ${WORK_ITEM_COLUMNS} FROM work_items WHERE project_id = ? ORDER BY created_at ASC, work_item_id ASC`,
      ).all(projectId);
      return ok(rows.map(toWorkItem));
    });
  }

  recordPublication(
    workItemId: WorkItemId,
    state: PublicationState,
    operationId: string | null,
    at: string,
  ): Result<WorkItemRecord> {
    return this.attempt('record publication state', () =>
      this.bounded(() => {
        if (!PUBLICATION_STATES.includes(state)) {
          return err(invalid(`Unknown publication state: ${state}`, [
            { path: 'state', message: `Must be one of ${PUBLICATION_STATES.join(', ')}.` },
          ]));
        }
        const existing = this.statement(
          'SELECT work_item_id, publication_intent FROM work_items WHERE work_item_id = ?',
        ).get(workItemId);
        if (existing === undefined) return err(notFound('Work item', workItemId));
        const previousIntent = requiredText(existing, 'publication_intent');
        this.statement(
          'UPDATE work_items SET publication_state = ?, publication_operation_id = ?, publication_intent = ?, updated_at = ? WHERE work_item_id = ?',
        ).run(
          state,
          operationId,
          state === 'Published' ? 'Published' : previousIntent,
          at,
          workItemId,
        );
        return this.get(workItemId);
      }),
    );
  }

  recordSyncResult(input: RecordSyncResultInput): Result<WorkItemSync> {
    return this.attempt('record external sync result', () =>
      this.bounded(() => {
        const work = this.statement('SELECT work_item_id FROM work_items WHERE work_item_id = ?').get(
          input.workItemId,
        );
        if (work === undefined) return err(notFound('Work item', input.workItemId));
        const existing = this.statement(
          'SELECT work_item_id, state, last_attempt_at, last_success_at, attempt_count, last_error FROM work_item_syncs WHERE work_item_id = ?',
        ).get(input.workItemId);
        const previous = existing === undefined ? null : toWorkItemSync(existing);
        const state = input.succeeded ? 'InSync' : 'PendingSync';
        const attemptCount = previous === null ? 1 : previous.attemptCount + 1;
        const lastSuccessAt = input.succeeded ? input.attemptedAt : previous?.lastSuccessAt ?? null;
        if (previous === null) {
          this.statement(
            'INSERT INTO work_item_syncs (work_item_id, state, last_attempt_at, last_success_at, attempt_count, last_error) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(input.workItemId, state, input.attemptedAt, lastSuccessAt, attemptCount, input.error);
        } else {
          this.statement(
            'UPDATE work_item_syncs SET state = ?, last_attempt_at = ?, last_success_at = ?, attempt_count = ?, last_error = ? WHERE work_item_id = ?',
          ).run(state, input.attemptedAt, lastSuccessAt, attemptCount, input.error, input.workItemId);
        }
        const saved = this.statement(
          'SELECT work_item_id, state, last_attempt_at, last_success_at, attempt_count, last_error FROM work_item_syncs WHERE work_item_id = ?',
        ).get(input.workItemId);
        if (saved === undefined) return err(notFound('Work item sync', input.workItemId));
        return ok(toWorkItemSync(saved));
      }),
    );
  }

  getSync(workItemId: WorkItemId): Result<WorkItemSync | null> {
    return this.attempt('read external sync state', () => {
      const row = this.statement(
        'SELECT work_item_id, state, last_attempt_at, last_success_at, attempt_count, last_error FROM work_item_syncs WHERE work_item_id = ?',
      ).get(workItemId);
      return ok(row === undefined ? null : toWorkItemSync(row));
    });
  }

  /**
   * Appends the scope a run is starting from (F12-AC1).
   *
   * The semantic fingerprint is computed here, once, and stored. Recomputing it
   * later against edited issue content would silently rewrite history, which is
   * the failure F12-AC3 exists to prevent.
   */
  appendScopeSnapshot(input: AppendScopeSnapshotInput): Result<ScopeSnapshotRecord> {
    return this.attempt('append scope snapshot', () =>
      this.bounded(() => {
        const work = this.statement('SELECT work_item_id, project_id FROM work_items WHERE work_item_id = ?').get(
          input.scope.workItemId,
        );
        if (work === undefined) return err(notFound('Work item', input.scope.workItemId));
        const newest = this.statement(
          'SELECT COALESCE(MAX(sequence_number), 0) AS sequence FROM scope_snapshots WHERE work_item_id = ?',
        ).get(input.scope.workItemId);
        const sequenceNumber = (newest === undefined ? 0 : requiredInteger(newest, 'sequence')) + 1;
        const snapshotId = newId<'ScopeSnapshotId'>();
        this.statement(
          `INSERT INTO scope_snapshots (${SNAPSHOT_COLUMNS}, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          snapshotId,
          input.scope.workItemId,
          sequenceNumber,
          input.attemptId,
          input.scope.issueId,
          input.scope.issueIdentifier,
          input.scope.title,
          input.scope.description,
          input.scope.providerRevision,
          input.scope.priority,
          canonicalize(input.scope.dependencyIssueIds),
          canonicalize(input.scope.acceptanceCriteria),
          input.scope.retrievedAt,
          scopeFingerprint(input.scope),
          input.profileVersionId,
          input.procedureVersionId,
          input.capturedAt,
          input.correlationId,
          requiredText(work, 'project_id'),
        );
        const created = this.statement(
          `SELECT ${SNAPSHOT_COLUMNS} FROM scope_snapshots WHERE scope_snapshot_id = ?`,
        ).get(snapshotId);
        if (created === undefined) return err(notFound('Scope snapshot', snapshotId));
        return ok(toScopeSnapshot(created));
      }),
    );
  }

  getScopeSnapshot(scopeSnapshotId: ScopeSnapshotId): Result<ScopeSnapshotRecord> {
    return this.attempt('read scope snapshot', () => {
      const row = this.statement(`SELECT ${SNAPSHOT_COLUMNS} FROM scope_snapshots WHERE scope_snapshot_id = ?`).get(
        scopeSnapshotId,
      );
      if (row === undefined) return err(notFound('Scope snapshot', scopeSnapshotId));
      return ok(toScopeSnapshot(row));
    });
  }

  latestScopeSnapshot(workItemId: WorkItemId): Result<ScopeSnapshotRecord | null> {
    return this.attempt('read the latest scope snapshot', () => {
      const row = this.statement(
        `SELECT ${SNAPSHOT_COLUMNS} FROM scope_snapshots WHERE work_item_id = ? ORDER BY sequence_number DESC LIMIT 1`,
      ).get(workItemId);
      return ok(row === undefined ? null : toScopeSnapshot(row));
    });
  }

  listScopeSnapshots(workItemId: WorkItemId): Result<readonly ScopeSnapshotRecord[]> {
    return this.attempt('list scope snapshots', () => {
      const rows = this.statement(
        `SELECT ${SNAPSHOT_COLUMNS} FROM scope_snapshots WHERE work_item_id = ? ORDER BY sequence_number ASC`,
      ).all(workItemId);
      return ok(rows.map(toScopeSnapshot));
    });
  }
}

function toWorkItemSync(row: SqlRow): WorkItemSync {
  return {
    workItemId: requiredText(row, 'work_item_id') as WorkItemId,
    state: requiredText(row, 'state') as WorkItemSync['state'],
    lastAttemptAt: nullableText(row, 'last_attempt_at'),
    lastSuccessAt: nullableText(row, 'last_success_at'),
    attemptCount: requiredInteger(row, 'attempt_count'),
    lastError: nullableText(row, 'last_error'),
  };
}

const ATTENTION_COLUMNS =
  'attention_item_id, dedup_key, kind, state, project_id, work_item_id, issue_identifier, title, blocker, next_action, created_at, updated_at, acknowledged_at, acknowledged_by, candidate_fingerprint, occurrence_count, first_observed_at';

const ATTENTION_STATES: readonly string[] = ['Open', 'Acknowledged', 'Resolved'];

function toAttentionItem(row: SqlRow): AttentionItemRecord {
  const workItemId = nullableText(row, 'work_item_id');
  const candidateFingerprint = nullableText(row, 'candidate_fingerprint');
  return {
    attentionItemId: requiredText(row, 'attention_item_id') as AttentionItemId,
    dedupKey: requiredText(row, 'dedup_key'),
    kind: requiredText(row, 'kind') as AttentionItemRecord['kind'],
    state: requiredText(row, 'state') as AttentionItemRecord['state'],
    projectId: requiredText(row, 'project_id') as ProjectId,
    workItemId: workItemId === null ? null : (workItemId as WorkItemId),
    issueIdentifier: nullableText(row, 'issue_identifier'),
    title: requiredText(row, 'title'),
    blocker: nullableText(row, 'blocker'),
    nextAction: requiredText(row, 'next_action'),
    createdAt: requiredText(row, 'created_at'),
    updatedAt: requiredText(row, 'updated_at'),
    acknowledgedAt: nullableText(row, 'acknowledged_at'),
    acknowledgedBy: nullableText(row, 'acknowledged_by'),
    candidateFingerprint: candidateFingerprint === null ? null : (candidateFingerprint as Fingerprint),
    occurrenceCount: requiredInteger(row, 'occurrence_count'),
    firstObservedAt: requiredText(row, 'first_observed_at'),
  };
}

/**
 * Attention items (F31-AC3, F31-AC4).
 *
 * `upsert` is keyed by the dedup key, so a webhook that fires three times for
 * one blocked run updates one row instead of creating three. Acknowledgment
 * survives a repeated observation, matching the domain merge rule.
 *
 * `acknowledge` writes one column group on one table. It cannot express a
 * lifecycle transition, which is what makes "the owner looked at this" unable to
 * become "the run moved on" (F31-AC4).
 */
export class AttentionItemRepository extends SqlRepository implements AttentionItemStore {
  upsert(input: UpsertAttentionItemInput): Result<AttentionItemRecord> {
    return this.attempt('record attention item', () =>
      this.bounded(() => {
        const existing = this.statement(`SELECT ${ATTENTION_COLUMNS} FROM attention_items WHERE dedup_key = ?`).get(
          input.dedupKey,
        );
        if (existing === undefined) {
          const attentionItemId = newId<'AttentionItemId'>();
          this.statement(
            `INSERT INTO attention_items (${ATTENTION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            attentionItemId,
            input.dedupKey,
            input.kind,
            input.resolved ? 'Resolved' : 'Open',
            input.projectId,
            input.workItemId,
            input.issueIdentifier,
            input.title,
            input.blocker,
            input.nextAction,
            input.observedAt,
            input.observedAt,
            null,
            null,
            input.candidateFingerprint,
            1,
            input.observedAt,
          );
        } else {
          const previous = toAttentionItem(existing);
          this.statement(
            'UPDATE attention_items SET kind = ?, state = ?, project_id = ?, work_item_id = ?, issue_identifier = ?, title = ?, blocker = ?, next_action = ?, updated_at = ?, acknowledged_at = ?, acknowledged_by = ?, candidate_fingerprint = ?, occurrence_count = ? WHERE attention_item_id = ?',
          ).run(
            input.kind,
            input.resolved ? 'Resolved' : previous.state,
            input.projectId,
            input.workItemId,
            input.issueIdentifier,
            input.title,
            input.blocker,
            input.nextAction,
            input.observedAt,
            input.resolved ? null : previous.acknowledgedAt,
            input.resolved ? null : previous.acknowledgedBy,
            input.candidateFingerprint,
            previous.occurrenceCount + 1,
            previous.attentionItemId,
          );
        }
        const saved = this.statement(`SELECT ${ATTENTION_COLUMNS} FROM attention_items WHERE dedup_key = ?`).get(
          input.dedupKey,
        );
        if (saved === undefined) return err(notFound('Attention item', input.dedupKey));
        return ok(toAttentionItem(saved));
      }),
    );
  }

  acknowledge(attentionItemId: AttentionItemId, actor: string, at: string): Result<AttentionItemRecord> {
    return this.attempt('acknowledge attention item', () =>
      this.bounded(() => {
        const existing = this.statement(
          `SELECT ${ATTENTION_COLUMNS} FROM attention_items WHERE attention_item_id = ?`,
        ).get(attentionItemId);
        if (existing === undefined) return err(notFound('Attention item', attentionItemId));
        const previous = toAttentionItem(existing);
        if (previous.state === 'Resolved') {
          return err(conflict('A resolved attention item cannot be acknowledged.', 'Open', 'Resolved'));
        }
        this.statement(
          "UPDATE attention_items SET state = 'Acknowledged', acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE attention_item_id = ?",
        ).run(at, actor, at, attentionItemId);
        const saved = this.statement(
          `SELECT ${ATTENTION_COLUMNS} FROM attention_items WHERE attention_item_id = ?`,
        ).get(attentionItemId);
        if (saved === undefined) return err(notFound('Attention item', attentionItemId));
        return ok(toAttentionItem(saved));
      }),
    );
  }

  resolve(attentionItemId: AttentionItemId, at: string): Result<AttentionItemRecord> {
    return this.attempt('resolve attention item', () =>
      this.bounded(() => {
        const existing = this.statement(
          `SELECT ${ATTENTION_COLUMNS} FROM attention_items WHERE attention_item_id = ?`,
        ).get(attentionItemId);
        if (existing === undefined) return err(notFound('Attention item', attentionItemId));
        this.statement(
          "UPDATE attention_items SET state = 'Resolved', acknowledged_at = NULL, acknowledged_by = NULL, updated_at = ? WHERE attention_item_id = ?",
        ).run(at, attentionItemId);
        const saved = this.statement(
          `SELECT ${ATTENTION_COLUMNS} FROM attention_items WHERE attention_item_id = ?`,
        ).get(attentionItemId);
        if (saved === undefined) return err(notFound('Attention item', attentionItemId));
        return ok(toAttentionItem(saved));
      }),
    );
  }

  get(attentionItemId: AttentionItemId): Result<AttentionItemRecord> {
    return this.attempt('read attention item', () => {
      const row = this.statement(`SELECT ${ATTENTION_COLUMNS} FROM attention_items WHERE attention_item_id = ?`).get(
        attentionItemId,
      );
      if (row === undefined) return err(notFound('Attention item', attentionItemId));
      return ok(toAttentionItem(row));
    });
  }

  list(state: AttentionItemRecord['state'] | null): Result<readonly AttentionItemRecord[]> {
    return this.attempt('list attention items', () => {
      if (state !== null && !ATTENTION_STATES.includes(state)) {
        return err(invalid(`Unknown attention state: ${state}`, [
          { path: 'state', message: `Must be one of ${ATTENTION_STATES.join(', ')}.` },
        ]));
      }
      const rows =
        state === null
          ? this.statement(
              `SELECT ${ATTENTION_COLUMNS} FROM attention_items ORDER BY created_at ASC, attention_item_id ASC`,
            ).all()
          : this.statement(
              `SELECT ${ATTENTION_COLUMNS} FROM attention_items WHERE state = ? ORDER BY created_at ASC, attention_item_id ASC`,
            ).all(state);
      return ok(rows.map(toAttentionItem));
    });
  }
}

const CANDIDATE_COLUMNS =
  'candidate_id, attempt_id, work_item_id, fingerprint, head_sha, base_sha, scope_fingerprint, environment_fingerprint, policy_fingerprint, profile_version_id, procedure_version_id, project_id, scope_snapshot_id, pull_request_id, target_branch, recorded_at, correlation_id';

/**
 * Rebuilds the domain `CandidateIdentity` from the stored columns.
 *
 * The identity is read back out of the individual columns rather than from a
 * stored JSON blob, so what the caller sees is exactly what the schema CHECKed.
 * That is the point of decomposing it (R4): an abbreviated head SHA cannot
 * reach this point at all, because the column refuses it on the way in.
 *
 * `components` live in `candidate_components` and are read separately by
 * `attachComponents`, so a candidate's component identities are stored against
 * the same candidate row rather than inside an uncheckable document.
 */
function toCandidate(row: SqlRow, components: CandidateRecord['identity']['components']): CandidateRecord {
  const attemptId = nullableText(row, 'attempt_id');
  return {
    candidateId: requiredText(row, 'candidate_id') as CandidateId,
    attemptId: attemptId === null ? null : (attemptId as AttemptId),
    workItemId: requiredText(row, 'work_item_id') as WorkItemId,
    candidateFingerprint: requiredText(row, 'fingerprint') as Fingerprint,
    identity: {
      headSha: requiredText(row, 'head_sha') as CommitSha,
      baseSha: requiredText(row, 'base_sha') as CommitSha,
      scopeFingerprint: requiredText(row, 'scope_fingerprint') as Fingerprint,
      profileVersionId: requiredText(row, 'profile_version_id'),
      procedureVersionId: requiredText(row, 'procedure_version_id'),
      environmentFingerprint: requiredText(row, 'environment_fingerprint') as Fingerprint,
      policyFingerprint: requiredText(row, 'policy_fingerprint') as Fingerprint,
      components,
    },
    pullRequestId: nullableText(row, 'pull_request_id'),
    targetBranch: requiredText(row, 'target_branch'),
    recordedAt: requiredText(row, 'recorded_at'),
    correlationId: nullableText(row, 'correlation_id'),
  };
}

/**
 * Candidates (F20-AC3, F24-AC4).
 *
 * The fingerprint is computed from the stored identity with the domain function,
 * never accepted from the caller, so it cannot disagree with the inputs it
 * summarises.
 */
export class CandidateRepository extends SqlRepository implements CandidateStore {
  record(input: RecordCandidateInput): Result<CandidateRecord> {
    return this.attempt('record candidate', () =>
      this.bounded(() => {
        // The scope snapshot a candidate was built from is what makes the
        // candidate's evidence and staleness checkable at all (F12-AC1, F20-AC3).
        // It is resolved from the work item rather than trusted from the caller,
        // so a candidate cannot claim a snapshot belonging to different work.
        const snapshot = this.statement(
          'SELECT scope_snapshot_id, project_id FROM scope_snapshots WHERE work_item_id = ? ORDER BY created_at DESC, scope_snapshot_id DESC LIMIT 1',
        ).get(input.workItemId);
        if (snapshot === undefined) {
          return err(
            notFound('Scope snapshot', `for work item ${input.workItemId}`),
          );
        }
        const candidateId = newId<'CandidateId'>();
        const computed = candidateFingerprint(input.identity);
        this.statement(
          `INSERT INTO candidates (${CANDIDATE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          candidateId,
          input.attemptId,
          input.workItemId,
          computed,
          input.identity.headSha,
          input.identity.baseSha,
          input.identity.scopeFingerprint,
          input.identity.environmentFingerprint,
          input.identity.policyFingerprint,
          input.identity.profileVersionId,
          input.identity.procedureVersionId,
          requiredText(snapshot, 'project_id'),
          requiredText(snapshot, 'scope_snapshot_id'),
          input.pullRequestId,
          input.targetBranch,
          input.recordedAt,
          input.correlationId,
        );
        for (const component of input.identity.components) {
          this.statement(
            'INSERT INTO candidate_components (candidate_id, component, deployment_id, deployment_url, environment) VALUES (?, ?, ?, ?, ?)',
          ).run(
            candidateId,
            component.component,
            component.deploymentId,
            component.deploymentUrl,
            component.environment,
          );
        }
        const created = this.statement(`SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE candidate_id = ?`).get(
          candidateId,
        );
        if (created === undefined) return err(notFound('Candidate', candidateId));
        return ok(toCandidate(created, input.identity.components));
      }),
    );
  }

  get(candidateId: CandidateId): Result<CandidateRecord> {
    return this.attempt('read candidate', () => {
      const row = this.statement(`SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE candidate_id = ?`).get(
        candidateId,
      );
      if (row === undefined) return err(notFound('Candidate', candidateId));
      return ok(toCandidate(row, this.componentsOf(candidateId)));
    });
  }

  findByFingerprint(candidateFingerprint: Fingerprint): Result<CandidateRecord | null> {
    return this.attempt('read candidate by fingerprint', () => {
      const row = this.statement(
        `SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE fingerprint = ? ORDER BY recorded_at DESC, candidate_id DESC LIMIT 1`,
      ).get(candidateFingerprint);
      if (row === undefined) return ok(null);
      const candidateId = requiredText(row, 'candidate_id') as CandidateId;
      return ok(toCandidate(row, this.componentsOf(candidateId)));
    });
  }

  listForWorkItem(workItemId: WorkItemId): Result<readonly CandidateRecord[]> {
    return this.attempt('list candidates for work', () => {
      const rows = this.statement(
        `SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE work_item_id = ? ORDER BY recorded_at ASC, candidate_id ASC`,
      ).all(workItemId);
      return ok(
        rows.map((row) =>
          toCandidate(row, this.componentsOf(requiredText(row, 'candidate_id') as CandidateId)),
        ),
      );
    });
  }

  /** Component identities, read from the rows the schema stores them in. */
  private componentsOf(candidateId: CandidateId): CandidateRecord['identity']['components'] {
    const rows = this.statement(
      'SELECT component, deployment_id, deployment_url, environment FROM candidate_components WHERE candidate_id = ? ORDER BY component ASC',
    ).all(candidateId);
    return rows.map((row) => ({
      component: requiredText(row, 'component'),
      deploymentId: nullableText(row, 'deployment_id'),
      deploymentUrl: nullableText(row, 'deployment_url'),
      environment: requiredText(row, 'environment'),
    }));
  }
}

const EVIDENCE_COLUMNS =
  'evidence_id, candidate_id, candidate_fingerprint, kind, criterion_id, check_id, check_name, result, observed_at, environment_fingerprint, scope_fingerprint, artifact_ref, detail_redacted, recorded_at, correlation_id';

/**
 * The write order, which adds the NOT NULL columns the schema requires and the
 * ones resolved from the candidate.
 *
 * `status` and `method_kind` are the criterion-facing vocabularies the schema
 * already CHECKs, so a stored result is one the domain recognises; `created_at`
 * and `updated_at` reuse the observation time, which is when the fact became
 * true for the evidence binding (F20-AC3).
 */
const EVIDENCE_WRITE_COLUMNS =
  'evidence_id, candidate_id, work_item_id, project_id, candidate_fingerprint, scope_fingerprint, criterion_id, method_kind, kind, check_id, check_name, status, result, observed_at, environment_fingerprint, artifact_ref, detail_redacted, recorded_at, correlation_id, created_at, updated_at';

/**
 * The domain criterion-evidence method for a stored evidence kind.
 *
 * The schema CHECKs `method_kind`, and a browser, API or live-smoke observation
 * is evidence a check produced, so all four record an automated check; the
 * distinction the owner sees lives in `kind`.
 */
function methodKindFor(_kind: string): string {
  return 'AutomatedCheck';
}

/**
 * The criterion status implied by a check result.
 *
 * `Passed` is the only result that verifies a criterion; every other result
 * leaves it unverified, and saying so is what stops a required check that never
 * ran from being read as a pass (F20-AC2, F23-AC1).
 */
function statusFor(result: CheckResult): string {
  return result === 'Passed' ? 'Verified' : 'Untested';
}

/**
 * Where a check ran.
 *
 * The schema CHECKs this list, and the origin is a fact about the observer
 * rather than about the evidence: a browser or API observation is still a check
 * that ran, and recording it as one is what lets a required check be reasoned
 * about uniformly (F20-AC2).
 */
function checkOriginFor(kind: string): string {
  switch (kind) {
    case 'BrowserEvidence':
      return 'BrowserEvidence';
    case 'ApiEvidence':
      return 'ApiEvidence';
    case 'LiveSmoke':
      return 'LiveSmoke';
    default:
      return 'LocalCheck';
  }
}

const EVIDENCE_KINDS: readonly string[] = ['CheckResult', 'BrowserEvidence', 'ApiEvidence', 'LiveSmoke'];

function toEvidence(row: SqlRow): EvidenceRecord {
  const criterionId = nullableText(row, 'criterion_id');
  const checkId = nullableText(row, 'check_id');
  const observedAt = nullableText(row, 'observed_at');
  const environmentFingerprint = nullableText(row, 'environment_fingerprint');
  const scopeFingerprint = nullableText(row, 'scope_fingerprint');
  const artifactRef = nullableText(row, 'artifact_ref');
  const detail = nullableText(row, 'detail_redacted');
  return {
    evidenceId: requiredText(row, 'evidence_id') as EvidenceId,
    candidateId: requiredText(row, 'candidate_id') as CandidateId,
    candidateFingerprint: requiredText(row, 'candidate_fingerprint') as Fingerprint,
    kind: requiredText(row, 'kind') as EvidenceRecord['kind'],
    criterionId,
    checkId,
    checkName: requiredText(row, 'check_name'),
    result: requiredText(row, 'result') as CheckResult,
    observedAt,
    environmentFingerprint:
      environmentFingerprint === null ? null : (environmentFingerprint as Fingerprint),
    scopeFingerprint: scopeFingerprint === null ? null : (scopeFingerprint as Fingerprint),
    artifactRef,
    detail,
    recordedAt: requiredText(row, 'recorded_at'),
    correlationId: nullableText(row, 'correlation_id'),
  };
}

/**
 * Evidence bound to a candidate fingerprint (F20-AC3, F25-AC3).
 *
 * `record` refuses a fingerprint no candidate carries, and every read filters on
 * the fingerprint. A replacement build therefore starts with no evidence at all
 * rather than inheriting the previous build's green results, even though the
 * pull request number is unchanged.
 *
 * A result outside `CHECK_RESULTS` is refused, so no path can invent a state the
 * domain does not recognise (F20-AC2).
 */
export class EvidenceRepository extends SqlRepository implements EvidenceStore {
  record(input: RecordEvidenceInput): Result<EvidenceRecord> {
    return this.attempt('record evidence', () => {
      if (!EVIDENCE_KINDS.includes(input.kind)) {
        return err(invalid(`Unknown evidence kind: ${input.kind}`, [
          { path: 'kind', message: `Must be one of ${EVIDENCE_KINDS.join(', ')}.` },
        ]));
      }
      if (!(CHECK_RESULTS as readonly string[]).includes(input.result)) {
        return err(invalid(`Unknown check result: ${input.result}`, [
          { path: 'result', message: `Must be one of ${CHECK_RESULTS.join(', ')}.` },
        ]));
      }
      // The work item, project and scope revision are resolved from the candidate
      // rather than taken from the caller, so evidence cannot be filed against a
      // scope the candidate was not built from (F20-AC3, F25-AC3).
      const candidate = this.statement(
        'SELECT candidate_id, work_item_id, project_id, scope_fingerprint FROM candidates WHERE fingerprint = ? ORDER BY recorded_at DESC LIMIT 1',
      ).get(input.candidateFingerprint);
      if (candidate === undefined) {
        return err(notFound('Candidate', input.candidateFingerprint));
      }
      if (input.criterionId === null) {
        return err(
          invalid('Evidence is recorded against an acceptance criterion.', [
            { path: 'criterionId', message: 'Required.' },
          ]),
        );
      }
      // The check is recorded first, in its own right, because the schema binds
      // evidence to a real check row: a result that is not attached to the
      // check that produced it is exactly the claim F20-AC2 exists to refuse.
      // Recording it here keeps that pairing a property of the write rather than
      // of the caller's ordering.
      if (input.checkId !== null) {
        this.statement(
          `INSERT INTO checks (check_id, candidate_id, work_item_id, project_id, candidate_fingerprint, name, origin, required, result, started_at, ended_at, artifact_ref, detail_redacted)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
             ON CONFLICT(check_id) DO NOTHING`,
        ).run(
          input.checkId,
          requiredText(candidate, 'candidate_id'),
          requiredText(candidate, 'work_item_id'),
          requiredText(candidate, 'project_id'),
          input.candidateFingerprint,
          input.checkName,
          checkOriginFor(input.kind),
          input.result,
          input.observedAt ?? input.recordedAt,
          input.observedAt,
          input.artifactRef,
          input.detail,
        );
      }

      const evidenceId = newId<'EvidenceId'>();
      this.statement(
        `INSERT INTO evidence (${EVIDENCE_WRITE_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        evidenceId,
        requiredText(candidate, 'candidate_id'),
        requiredText(candidate, 'work_item_id'),
        requiredText(candidate, 'project_id'),
        input.candidateFingerprint,
        requiredText(candidate, 'scope_fingerprint'),
        input.criterionId,
        methodKindFor(input.kind),
        input.kind,
        input.checkId,
        input.checkName,
        statusFor(input.result),
        input.result,
        input.observedAt,
        input.environmentFingerprint,
        input.artifactRef,
        input.detail,
        input.recordedAt,
        input.correlationId,
        input.observedAt,
        input.observedAt,
      );
      const created = this.statement(`SELECT ${EVIDENCE_COLUMNS} FROM evidence WHERE evidence_id = ?`).get(
        evidenceId,
      );
      if (created === undefined) return err(notFound('Evidence', evidenceId));
      return ok(toEvidence(created));
    });
  }

  get(evidenceId: EvidenceId): Result<EvidenceRecord> {
    return this.attempt('read evidence', () => {
      const row = this.statement(`SELECT ${EVIDENCE_COLUMNS} FROM evidence WHERE evidence_id = ?`).get(
        evidenceId,
      );
      if (row === undefined) return err(notFound('Evidence', evidenceId));
      return ok(toEvidence(row));
    });
  }

  listForCandidate(candidateFingerprint: Fingerprint): Result<readonly EvidenceRecord[]> {
    return this.attempt('list evidence for a candidate', () => {
      const rows = this.statement(
        `SELECT ${EVIDENCE_COLUMNS} FROM evidence WHERE candidate_fingerprint = ? ORDER BY recorded_at ASC, evidence_id ASC`,
      ).all(candidateFingerprint);
      return ok(rows.map(toEvidence));
    });
  }

  listForCriterion(
    candidateFingerprint: Fingerprint,
    criterionId: string,
  ): Result<readonly EvidenceRecord[]> {
    return this.attempt('list criterion evidence for a candidate', () => {
      const rows = this.statement(
        `SELECT ${EVIDENCE_COLUMNS} FROM evidence WHERE candidate_fingerprint = ? AND criterion_id = ? ORDER BY recorded_at ASC, evidence_id ASC`,
      ).all(candidateFingerprint, criterionId);
      return ok(rows.map(toEvidence));
    });
  }
}

const DECISION_COLUMNS =
  'decision_id, work_item_id, candidate_fingerprint, scope_fingerprint, actor_owner_id, decision_type, acceptance_state, subject_json, subject_fingerprint, note, state, consumed_at, invalidated_at, invalidation_reason_redacted, created_at, correlation_id';

/**
 * The decision vocabulary, and with it which of the two columns the schema
 * requires.
 *
 * An acceptance or a change request carries an acceptance state and no subject;
 * an authorization carries a subject fingerprint and no acceptance state. The
 * schema CHECKs that pairing, so the two lists are stated here once and the
 * repository derives which column to write from the type rather than letting a
 * caller pair them wrongly (R3).
 */
const ACCEPTANCE_DECISION_TYPES: readonly OwnerDecisionType[] = ['AcceptProduct', 'RequestChanges'];
const AUTHORIZATION_DECISION_TYPES: readonly OwnerDecisionType[] = [
  'AuthorizeMerge',
  'AuthorizeRelease',
  'AuthorizeMergeAndRelease',
  'AuthorizeRecovery',
  'ResolveScopeChange',
];
const DECISION_TYPES: readonly OwnerDecisionType[] = [
  ...ACCEPTANCE_DECISION_TYPES,
  ...AUTHORIZATION_DECISION_TYPES,
];

/** True for the decision types that authorize an action rather than accept a result. */
function isAuthorizationDecision(decisionType: OwnerDecisionType): boolean {
  return AUTHORIZATION_DECISION_TYPES.includes(decisionType);
}

function toDecision(row: SqlRow): OwnerDecisionRecord {
  const workItemId = nullableText(row, 'work_item_id');
  return {
    decisionId: requiredText(row, 'decision_id') as DecisionId,
    workItemId: workItemId === null ? null : (workItemId as WorkItemId),
    candidateFingerprint: requiredText(row, 'candidate_fingerprint') as Fingerprint,
    scopeFingerprint: requiredText(row, 'scope_fingerprint') as Fingerprint,
    actorOwnerId: requiredText(row, 'actor_owner_id') as OwnerId,
    decisionType: requiredText(row, 'decision_type') as OwnerDecisionType,
    subject: parseJson<AuthorizationSubject | null>(row, 'subject_json'),
    subjectFingerprint: ((): Fingerprint | null => {
      const value = nullableText(row, 'subject_fingerprint');
      return value === null ? null : (value as Fingerprint);
    })(),
    acceptanceState: nullableText(row, 'acceptance_state') as AcceptanceState | null,
    note: nullableText(row, 'note'),
    state: requiredText(row, 'state') as OwnerDecisionState,
    consumedAt: nullableText(row, 'consumed_at'),
    invalidatedAt: nullableText(row, 'invalidated_at'),
    invalidatedReason: nullableText(row, 'invalidation_reason_redacted'),
    createdAt: requiredText(row, 'created_at'),
    correlationId: nullableText(row, 'correlation_id'),
  };
}

interface DecisionInsert {
  readonly workItemId: WorkItemId | null;
  readonly candidateFingerprint: Fingerprint;
  readonly scopeFingerprint: Fingerprint;
  readonly actorOwnerId: OwnerId;
  readonly decisionType: OwnerDecisionType;
  readonly subject: AuthorizationSubject | null;
  readonly subjectFingerprint: Fingerprint | null;
  /** Set only for an acceptance or a change request; null for an authorization. */
  readonly acceptanceState: AcceptanceState | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly correlationId: string | null;
}

/**
 * Owner acceptance and authorization (F25, F26-AC1, F27-AC3).
 *
 * Acceptance and authorization are separate rows because they are separate
 * permissions. An authorization stores the fingerprint of its own subject, so a
 * changed candidate, destination or target leaves the row recorded but no longer
 * usable; the domain check rejects it and reconciliation records why.
 *
 * `consume` is single-use and refuses a second attempt, so a replayed request
 * cannot merge twice (F26-AC3).
 */
export class OwnerDecisionRepository extends SqlRepository implements OwnerDecisionStore {
  recordAcceptance(input: RecordAcceptanceInput): Result<OwnerDecisionRecord> {
    return this.insert({
      workItemId: input.workItemId,
      candidateFingerprint: input.candidateFingerprint,
      scopeFingerprint: input.scopeFingerprint,
      actorOwnerId: input.actorOwnerId,
      decisionType: 'AcceptProduct',
      subject: null,
      subjectFingerprint: null,
      acceptanceState: 'Accepted',
      note: input.note,
      createdAt: input.createdAt,
      correlationId: input.correlationId,
    });
  }

  recordChangesRequested(input: RecordChangesRequestedInput): Result<OwnerDecisionRecord> {
    return this.insert({
      workItemId: input.workItemId,
      candidateFingerprint: input.candidateFingerprint,
      scopeFingerprint: input.scopeFingerprint,
      actorOwnerId: input.actorOwnerId,
      decisionType: 'RequestChanges',
      subject: null,
      subjectFingerprint: null,
      acceptanceState: 'ChangesRequested',
      note: input.feedback,
      createdAt: input.createdAt,
      correlationId: input.correlationId,
    });
  }

  authorize(input: RecordAuthorizationInput): Result<OwnerDecisionRecord> {
    return this.insert({
      workItemId: input.workItemId,
      candidateFingerprint: input.candidateFingerprint,
      scopeFingerprint: input.scopeFingerprint,
      actorOwnerId: input.actorOwnerId,
      decisionType: input.decisionType,
      subject: input.subject,
      subjectFingerprint: subjectFingerprint(input.subject),
      acceptanceState: null,
      note: input.note,
      createdAt: input.createdAt,
      correlationId: input.correlationId,
    });
  }

  private insert(row: DecisionInsert): Result<OwnerDecisionRecord> {
    return this.attempt('record owner decision', () =>
      this.bounded(() => {
        if (!DECISION_TYPES.includes(row.decisionType)) {
          return err(invalid(`Unknown decision type: ${row.decisionType}`, [
            { path: 'decisionType', message: `Must be one of ${DECISION_TYPES.join(', ')}.` },
          ]));
        }
        // The decision is bound to a real candidate row, not to a fingerprint the
        // caller supplied, so the row the schema requires always names the
        // candidate the owner was actually looking at.
        const candidate = this.statement(
          'SELECT candidate_id FROM candidates WHERE fingerprint = ? ORDER BY recorded_at DESC, candidate_id DESC LIMIT 1',
        ).get(row.candidateFingerprint);
        if (candidate === undefined) {
          return err(notFound('Candidate', row.candidateFingerprint));
        }
        const candidateId = requiredText(candidate, 'candidate_id');
        const projectId = this.statement(
          'SELECT project_id FROM candidates WHERE candidate_id = ?',
        ).get(candidateId);
        if (projectId === undefined) return err(notFound('Candidate', candidateId));

        const authorization = isAuthorizationDecision(row.decisionType);
        if (authorization && row.subjectFingerprint === null) {
          return err(
            invalid('An authorization must record the subject fingerprint it authorizes.', [
              { path: 'subjectFingerprint', message: 'Required for an authorization.' },
            ]),
          );
        }
        if (!authorization && row.acceptanceState === null) {
          return err(
            invalid('An acceptance must record the acceptance state it reached.', [
              { path: 'acceptanceState', message: 'Required for an acceptance.' },
            ]),
          );
        }

        const decisionId = newId<'DecisionId'>();
        this.statement(
          `INSERT INTO owner_decisions (${DECISION_COLUMNS}, project_id, candidate_id, single_use, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Recorded', NULL, NULL, NULL, ?, ?, ?, ?, 1, ?)`,
        ).run(
          decisionId,
          row.workItemId,
          row.candidateFingerprint,
          row.scopeFingerprint,
          row.actorOwnerId,
          row.decisionType,
          row.acceptanceState,
          canonicalize(row.subject),
          row.subjectFingerprint,
          row.note,
          row.createdAt,
          row.correlationId,
          requiredText(projectId, 'project_id'),
          candidateId,
          row.createdAt,
        );
        const created = this.statement(`SELECT ${DECISION_COLUMNS} FROM owner_decisions WHERE decision_id = ?`).get(
          decisionId,
        );
        if (created === undefined) return err(notFound('Owner decision', decisionId));
        return ok(toDecision(created));
      }),
    );
  }


  consume(decisionId: DecisionId, consumedAt: string): Result<OwnerDecisionRecord> {
    return this.attempt('consume owner decision', () =>
      this.bounded(() => {
        const existing = this.statement(`SELECT ${DECISION_COLUMNS} FROM owner_decisions WHERE decision_id = ?`).get(
          decisionId,
        );
        if (existing === undefined) return err(notFound('Owner decision', decisionId));
        const decision = toDecision(existing);
        if (decision.state !== 'Recorded') {
          return err(conflict('This decision is no longer usable.', 'Recorded', decision.state));
        }
        this.statement(
          "UPDATE owner_decisions SET state = 'Consumed', consumed_at = ? WHERE decision_id = ?",
        ).run(consumedAt, decisionId);
        const updated = this.statement(`SELECT ${DECISION_COLUMNS} FROM owner_decisions WHERE decision_id = ?`).get(
          decisionId,
        );
        if (updated === undefined) return err(notFound('Owner decision', decisionId));
        return ok(toDecision(updated));
      }),
    );
  }

  invalidate(decisionId: DecisionId, reason: string, at: string): Result<OwnerDecisionRecord> {
    return this.attempt('invalidate owner decision', () =>
      this.bounded(() => {
        const existing = this.statement(`SELECT ${DECISION_COLUMNS} FROM owner_decisions WHERE decision_id = ?`).get(
          decisionId,
        );
        if (existing === undefined) return err(notFound('Owner decision', decisionId));
        const decision = toDecision(existing);
        if (decision.state === 'Consumed') {
          return err(conflict('A consumed decision cannot be invalidated.', 'Recorded', 'Consumed'));
        }
        this.statement(
          "UPDATE owner_decisions SET state = 'Invalidated', invalidated_at = ?, invalidation_reason_redacted = ? WHERE decision_id = ?",
        ).run(at, reason, decisionId);
        const updated = this.statement(`SELECT ${DECISION_COLUMNS} FROM owner_decisions WHERE decision_id = ?`).get(
          decisionId,
        );
        if (updated === undefined) return err(notFound('Owner decision', decisionId));
        return ok(toDecision(updated));
      }),
    );
  }

  get(decisionId: DecisionId): Result<OwnerDecisionRecord> {
    return this.attempt('read owner decision', () => {
      const row = this.statement(`SELECT ${DECISION_COLUMNS} FROM owner_decisions WHERE decision_id = ?`).get(
        decisionId,
      );
      if (row === undefined) return err(notFound('Owner decision', decisionId));
      return ok(toDecision(row));
    });
  }

  listForWorkItem(workItemId: WorkItemId): Result<readonly OwnerDecisionRecord[]> {
    return this.attempt('list owner decisions for work', () => {
      const rows = this.statement(
        `SELECT ${DECISION_COLUMNS} FROM owner_decisions WHERE work_item_id = ? ORDER BY created_at ASC, decision_id ASC`,
      ).all(workItemId);
      return ok(rows.map(toDecision));
    });
  }

  listUnconsumed(candidateFingerprint: Fingerprint): Result<readonly OwnerDecisionRecord[]> {
    return this.attempt('list unconsumed decisions for a candidate', () => {
      const rows = this.statement(
        `SELECT ${DECISION_COLUMNS} FROM owner_decisions WHERE candidate_fingerprint = ? AND state = 'Recorded' ORDER BY created_at ASC, decision_id ASC`,
      ).all(candidateFingerprint);
      return ok(rows.map(toDecision));
    });
  }
}