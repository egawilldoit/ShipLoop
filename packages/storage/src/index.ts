export * from './db.ts';
export * from './jobs/queue.ts';
export * from './jobs/lease.ts';
export * from './migrations.ts';
export * from './tx.ts';
export * from './repositories/types.ts';
export * from './repositories/core.ts';
export * from './repositories/scope.ts';
export * from './repositories/intake.ts';
export * from './repositories/publication.ts';
export * from './repositories/candidate-link.ts';
export * from './events/inbox.ts';
export * from './events/outbox.ts';
export * from './events/operations.ts';
export * from './reconciliation/pending.ts';

/*
 * The repositories, jobs and events modules were authored independently and each
 * declared its own narrow SQLite port. The ports are NOT the same shape: the jobs
 * transaction runner takes `(connection, work)` while the events runner takes
 * `(work)`, so unifying them is a design change rather than a rename.
 *
 * The durable job queue and its writer-lease manager are published here because a
 * process that has to claim and renew a coding writer (F13-AC2, F17-AC5) cannot
 * construct one without this package's own entry point: the subpath is not in the
 * `exports` map, and a second writer owner would be the failure F17-AC5 exists to
 * prevent.
 *
 * Only the non-overlapping names are re-exported here. The three ports stay
 * private to their own modules, and the jobs/event transaction runners are
 * published under distinct names so a caller cannot pass one where the other is
 * required. Consolidating the three ports onto a single
 * `StorageConnection`/`withTransaction` pair is recorded as follow-up work.
 */
export type {
  SqlConnection,
  TransactionConflict,
  JobMode,
  JobOperation,
  JobLimits,
  JobRecord,
  EnqueueRequest,
  ClaimedJob,
  ClaimCandidate,
  CodingSlot,
  LeaseState,
  WriterLease,
  ReclaimOutcome,
  CheckpointResult,
  FeedbackNote,
  WorkspaceIdentity,
  JobCheckpoint,
} from './jobs/types.ts';

export type {
  Instant,
  ExternalRef,
  InboxEvent,
  FailureCategory,
  OutboxStatus,
  OutboxEffect,
  OperationStatus,
  ExternalOperation,
  StorageResult,
} from './events/types.ts';
