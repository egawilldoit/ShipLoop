import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { err, invalid, ok, type DomainError, type Result } from '@shiploop/domain';

/**
 * Database connection for the local SQLite file (ARCHITECTURE "Authority and
 * durable state", N01-AC3).
 *
 * `node:sqlite` is used rather than a native driver because Node 24 strips
 * TypeScript directly: no native build step can fail on the VM, and the SQLite
 * file stays the one authoritative store that backup/restore copies.
 *
 * Nothing here writes to the console. A storage layer that logs makes it
 * impossible for a caller to know whether a write happened, and N06 requires
 * truthful diagnostics produced by the caller, not by the driver.
 */

/** The SQLite handle every other storage module accepts. */
export type Database = DatabaseSync;

/** Path that opens a private in-memory database, used by tests. */
export const MEMORY_PATH = ':memory:';

/**
 * Five seconds is long enough to outlast a checkpoint fsync and short enough that
 * a genuine second writer fails while the owner is still watching (F13-AC2).
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * Durability levels, matching the SQLite `synchronous` pragma.
 *
 * `Full` is the default because a crash between an acknowledged write and the
 * next backup must not lose an accepted job or event (N01-AC3, F32-AC3).
 */
export const SYNCHRONOUS_MODES = ['Off', 'Normal', 'Full', 'Extra'] as const;
export type SynchronousMode = (typeof SYNCHRONOUS_MODES)[number];

const SYNCHRONOUS_CODES: Readonly<Record<SynchronousMode, number>> = {
  Off: 0,
  Normal: 1,
  Full: 2,
  Extra: 3,
};

export interface OpenDatabaseOptions {
  /** Wait for a competing writer this long before failing. Defaults to 5000ms. */
  readonly busyTimeoutMs?: number;
  /** Durability level. Defaults to `Full`. */
  readonly synchronous?: SynchronousMode;
}

/**
 * Opens the database and proves the pragmas that make a bounded write safe.
 *
 * Each pragma is applied and then read back. `journal_mode=WAL` is what lets a
 * long read coexist with a short write, `foreign_keys=ON` is what stops a
 * deleted project from leaving orphaned evidence, and `busy_timeout` is what
 * turns a competing writer into a wait rather than an immediate failure. The
 * values are verified rather than assumed because a pragma silently ignored
 * (a read-only file, an unsupported level) would leave the caller believing in
 * durability guarantees that do not hold.
 *
 * `:memory:` cannot use WAL, so an in-memory database is asserted to report
 * `memory` instead; every other assertion is identical.
 */
export function openDatabase(
  path: string,
  options: OpenDatabaseOptions = {},
): Result<Database, DomainError> {
  const validated = validateOpenArguments(path, options);
  if (!validated.ok) return err(validated.error);

  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const synchronous = options.synchronous ?? 'Full';

  let db: Database;
  try {
    db = new DatabaseSync(path, { timeout: busyTimeoutMs });
  } catch (error) {
    return err({
      code: 'Unavailable',
      reason: `SQLite could not open ${describePath(path)}: ${describeError(error)}`,
    });
  }

  const configured = configureAndVerify(db, path, busyTimeoutMs, synchronous);
  if (!configured.ok) {
    closeQuietly(db);
    return err(configured.error);
  }
  return ok(db);
}

/**
 * Closes the database and reports a refusal instead of throwing, so a failed
 * shutdown cannot mask the error that triggered it.
 */
export function closeDatabase(db: Database): Result<true, DomainError> {
  try {
    db.close();
  } catch (error) {
    return err({ code: 'Unavailable', reason: `SQLite could not close cleanly: ${describeError(error)}` });
  }
  return ok(true);
}

/** True when the path selects an in-memory database rather than a file. */
export function isMemoryPath(path: string): boolean {
  return path === MEMORY_PATH;
}

function validateOpenArguments(
  path: string,
  options: OpenDatabaseOptions,
): Result<true, DomainError> {
  const fields: { path: string; message: string }[] = [];
  if (path.trim().length === 0) {
    fields.push({ path: 'path', message: 'A file path or :memory: is required.' });
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    fields.push({ path: 'busyTimeoutMs', message: 'Must be a non-negative integer.' });
  }
  if (options.synchronous !== undefined && !SYNCHRONOUS_MODES.includes(options.synchronous)) {
    fields.push({
      path: 'synchronous',
      message: `Must be one of: ${SYNCHRONOUS_MODES.join(', ')}.`,
    });
  }
  return fields.length > 0 ? err(invalid('Invalid database open options.', fields)) : ok(true);
}

function configureAndVerify(
  db: Database,
  path: string,
  busyTimeoutMs: number,
  synchronous: SynchronousMode,
): Result<true, DomainError> {
  const expectedJournalMode = isMemoryPath(path) ? 'memory' : 'wal';
  const statements = [
    `PRAGMA journal_mode = ${expectedJournalMode.toUpperCase()}`,
    'PRAGMA foreign_keys = ON',
    `PRAGMA busy_timeout = ${busyTimeoutMs}`,
    `PRAGMA synchronous = ${synchronous.toUpperCase()}`,
  ];
  for (const statement of statements) {
    const executed = exec(db, statement);
    if (!executed.ok) return err(executed.error);
  }

  const expectedSynchronous = SYNCHRONOUS_CODES[synchronous];
  const assertions: readonly { readonly pragma: string; readonly expected: number | string }[] = [
    { pragma: 'journal_mode', expected: expectedJournalMode },
    { pragma: 'foreign_keys', expected: 1 },
    { pragma: 'busy_timeout', expected: busyTimeoutMs },
    { pragma: 'synchronous', expected: expectedSynchronous },
  ];
  for (const assertion of assertions) {
    const observed = readPragma(db, assertion.pragma);
    if (!observed.ok) return err(observed.error);
    if (observed.value !== assertion.expected) {
      return err(
        invalid(`SQLite refused to honour ${assertion.pragma}.`, [
          {
            path: assertion.pragma,
            message: `Expected ${assertion.expected}, observed ${String(observed.value)}.`,
          },
        ]),
      );
    }
  }
  return ok(true);
}

function exec(db: Database, sql: string): Result<true, DomainError> {
  try {
    db.exec(sql);
  } catch (error) {
    return err({ code: 'Unavailable', reason: `SQLite rejected a statement: ${describeError(error)}` });
  }
  return ok(true);
}

/**
 * Reads a pragma back.
 *
 * The value is taken positionally rather than by column name because SQLite does
 * not always name the column after the pragma: `PRAGMA busy_timeout` returns a
 * single column called `timeout`.
 */
function readPragma(db: Database, pragma: string): Result<number | string, DomainError> {
  let row: Record<string, SQLOutputValue> | undefined;
  try {
    row = db.prepare(`PRAGMA ${pragma}`).get();
  } catch (error) {
    return err({ code: 'Unavailable', reason: `${pragma} could not be read: ${describeError(error)}` });
  }
  const value = Object.values(row ?? {})[0];
  if (typeof value === 'number' || typeof value === 'string') return ok(value);
  return err({
    code: 'Unavailable',
    reason: `${pragma} returned ${String(value ?? 'nothing')}, which is not a readable pragma value.`,
  });
}

function closeQuietly(db: Database): void {
  try {
    db.close();
  } catch {
    void 0;
  }
}

function describePath(path: string): string {
  return isMemoryPath(path) ? MEMORY_PATH : path;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
