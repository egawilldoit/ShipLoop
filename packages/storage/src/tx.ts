import { conflict, invalid, type DomainError } from '@shiploop/domain';
import type { Database } from './db.ts';

/**
 * Bounded transactions over one SQLite connection (ARCHITECTURE "Authority and
 * durable state", N01-AC3).
 *
 * A transaction here is always BEGIN IMMEDIATE, so the write lock is taken at the
 * start of the critical section instead of being upgraded halfway through it.
 * That is what lets a repository claim work, write the rows and enqueue an event
 * as one indivisible step: a crash cannot leave an acknowledged job or event
 * absent from the durable store.
 *
 * Callbacks are synchronous by construction. An `await` inside a transaction
 * keeps the write lock while the event loop performs a network call, which is
 * indistinguishable from a hung worker and blocks every other writer, so an async
 * callback is refused rather than awaited.
 *
 * Nesting uses savepoints so a repository method may call another repository
 * method without either of them owning the commit.
 *
 * Two writes are refused rather than queued. One connection cannot have two
 * open write transactions, and one file cannot have two open write
 * transactions; in both cases SQLite's own answer is to wait out the busy
 * timeout and then fail with SQLITE_BUSY, which names the symptom and hides the
 * cause.
 */

/**
 * The failure modes of this layer that a caller must handle differently from an
 * ordinary SQL failure: the callback was asynchronous, the connection is already
 * inside a transaction this call does not own, or another connection already
 * holds the write transaction on the same file.
 *
 * `result` carries the same typed rejection the rest of the product uses, so a
 * caller can map the failure with `err(...)` instead of parsing a message.
 */
export class TransactionError extends Error {
  readonly result: { readonly ok: false; readonly error: DomainError };

  constructor(error: DomainError, message: string) {
    super(message, { cause: error });
    this.name = 'TransactionError';
    this.result = { ok: false, error };
  }
}

/**
 * Deepest savepoint chain allowed. A repository call graph deeper than this is a
 * design problem, and failing loudly beats holding a write lock through an
 * unbounded call stack.
 */
export const MAX_NESTING_DEPTH = 16;

interface TransactionState {
  /** Number of open transactions, counting the outermost. */
  depth: number;
  /** Number of transaction callbacks currently on the call stack. */
  callbackDepth: number;
}

const states = new WeakMap<Database, TransactionState>();

/**
 * Database files this process currently holds a write transaction on.
 *
 * ShipLoop is one owner with one coding writer, so a second connection to the same
 * file that starts a write transaction is a mistake rather than a design. SQLite
 * would answer it by waiting out `busy_timeout` and then failing with
 * SQLITE_BUSY, which names the symptom instead of the cause; refusing it here
 * turns the same mistake into a typed conflict at the call site.
 */
const claimedFiles = new Set<string>();

/** True while a transaction opened through this module is still open. */
export function inTransaction(db: Database): boolean {
  return (states.get(db)?.depth ?? 0) > 0;
}

/** Number of open transactions on this connection; 0 when none is open. */
export function transactionDepth(db: Database): number {
  return states.get(db)?.depth ?? 0;
}

/**
 * Runs `fn` in a write transaction, committing on return and rolling back on
 * throw.
 *
 * The callback's own error is rethrown unchanged after the rollback so the
 * caller can map it to a `Result`; the rollback error is reported separately
 * through `AggregateError`, because a connection that could not roll back is no
 * longer safe to keep using.
 */
export function withTransaction<T>(db: Database, fn: () => T): T {
  if (isAsyncFunction(fn)) throw asyncCallbackError();

  const state = stateFor(db);
  if (state.depth > 0) {
    if (state.callbackDepth === 0) throw leakedTransactionError();
    if (state.depth >= MAX_NESTING_DEPTH) throw nestingLimitError();
    return runSavepoint(db, state, fn);
  }

  const release = claimFile(db);
  if (release === null) throw contendedFileError(db.location() ?? 'this database');
  try {
    return runOutermost(db, state, fn);
  } finally {
    release();
  }
}

function runOutermost<T>(db: Database, state: TransactionState, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  state.depth = 1;
  try {
    const value = invokeCallback(state, fn);
    if (isThenable(value)) throw asyncCallbackError();
    db.exec('COMMIT');
    state.depth = 0;
    return value;
  } catch (error) {
    const rollbackFailure = rollback(db, 'ROLLBACK');
    state.depth = 0;
    if (rollbackFailure !== null) {
      throw new AggregateError(
        [error, rollbackFailure],
        'The transaction could not be rolled back, so the database must be reopened before further use.',
      );
    }
    throw error;
  }
}

function runSavepoint<T>(db: Database, state: TransactionState, fn: () => T): T {
  const savepoint = `ship_loop_sp_${state.depth}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  state.depth += 1;
  try {
    const value = invokeCallback(state, fn);
    if (isThenable(value)) throw asyncCallbackError();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    state.depth -= 1;
    return value;
  } catch (error) {
    const rollbackFailure = rollbackSavepoint(db, savepoint);
    state.depth -= 1;
    if (rollbackFailure !== null) {
      throw new AggregateError(
        [error, rollbackFailure],
        `Savepoint ${savepoint} could not be rolled back, so the enclosing transaction is no longer safe to use.`,
      );
    }
    throw error;
  }
}

/**
 * Runs the callback while the state records that a transaction callback is on
 * the stack, so a nested call is told apart from a leaked one.
 */
function invokeCallback<T>(state: TransactionState, fn: () => T): T {
  state.callbackDepth += 1;
  try {
    return fn();
  } finally {
    state.callbackDepth -= 1;
  }
}

function stateFor(db: Database): TransactionState {
  const existing = states.get(db);
  if (existing !== undefined) return existing;
  const created: TransactionState = { depth: 0, callbackDepth: 0 };
  states.set(db, created);
  return created;
}

/**
 * Claims the file for a write transaction, or reports that another connection
 * already holds it.
 *
 * An in-memory database is never claimed: every `:memory:` handle is its own
 * private database, so there is nothing to contend with.
 */
function claimFile(db: Database): (() => void) | null {
  const location = db.location();
  if (location === null) return () => {};
  if (claimedFiles.has(location)) return null;
  claimedFiles.add(location);
  return () => {
    claimedFiles.delete(location);
  };
}

function rollback(db: Database, statement: string): Error | null {
  try {
    db.exec(statement);
    return null;
  } catch (error) {
    return toError(error);
  }
}

function rollbackSavepoint(db: Database, savepoint: string): Error | null {
  const failure = rollback(db, `ROLLBACK TO SAVEPOINT ${savepoint}`);
  if (failure !== null) return failure;
  return rollback(db, `RELEASE SAVEPOINT ${savepoint}`);
}

/**
 * Detects an `async` function before it runs, so an awaiting callback cannot
 * observe a transaction that is about to be rolled back underneath it.
 */
function isAsyncFunction(fn: () => unknown): boolean {
  return fn.constructor.name === 'AsyncFunction';
}

/** Catches a non-`async` function that still returns a thenable. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false;
  if (typeof value !== 'object' && typeof value !== 'function') return false;
  return typeof (value as { readonly then?: unknown }).then === 'function';
}

function asyncCallbackError(): TransactionError {
  return new TransactionError(
    invalid('A transaction callback returned a promise.'),
    'withTransaction requires a synchronous callback. An await inside a SQLite transaction holds the write lock across a network call, which blocks every other writer and hides a hung worker; the transaction was rolled back.',
  );
}

function leakedTransactionError(): TransactionError {
  return new TransactionError(
    conflict(
      'A write transaction is already open on this connection.',
      'no open transaction outside this call',
      'a transaction whose callback has already returned',
    ),
    'This connection is inside a transaction that this call did not open, which normally means an async callback slipped past the guard. BEGIN IMMEDIATE would have failed with SQLITE_BUSY; refuse the work instead of stacking a second write transaction.',
  );
}

function contendedFileError(location: string): TransactionError {
  return new TransactionError(
    conflict(
      'Another connection already has a write transaction open on this database file.',
      'no write transaction on this file',
      'a write transaction held by another connection',
    ),
    `${location} is already inside a write transaction on another connection. BEGIN IMMEDIATE would wait out the busy timeout and then fail with SQLITE_BUSY, so the second write is refused here. ShipLoop runs one writer against one file.`,
  );
}

function nestingLimitError(): TransactionError {
  return new TransactionError(
    invalid(`Savepoint nesting exceeded ${MAX_NESTING_DEPTH}.`),
    `Savepoint nesting exceeded ${MAX_NESTING_DEPTH}. A repository call graph this deep is a design problem, and continuing would hold the write lock through an unbounded call stack.`,
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
