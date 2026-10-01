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
  applyPlanProposal,
  assessReadiness,
  conflict,
  draftPlan as domainDraftPlan,
  editPlan as domainEditPlan,
  err,
  ok,
  planReadiness,
  publishableTickets,
  redact,
  type AreaObservation,
  type ChangeShape,
  type DependencyStatus,
  type DomainError,
  type IdeaId,
  type OwnerId,
  type PasswordHash,
  type Plan,
  type PlanEdit,
  type PlanProposal,
  type ProcedureVersionId,
  type ProjectId,
  type PublishableTicket,
  type ReadinessDecision,
  type ReadinessObservation,
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
  PublicationRepository,
  ScopeRepository,
  WorkItemRepository,
} from '@shiploop/storage';
import { withTransaction } from '@shiploop/storage';
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
import type { GitAdapter, TicketAdapter } from '@shiploop/adapters';
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
import type { AdoptionUseCases } from './adoption.ts';
import { createAdoptionUseCases } from './adoption.ts';
import type { PublicationUseCases } from './publication.ts';
import { createPublicationUseCases } from './publication.ts';

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
  /**
   * The working providers, when the process has any.
   *
   * Absent rather than empty-by-default because publication and adoption both read or
   * write a provider, and a use case built over a provider that refuses every call
   * would present as a configured capability that cannot be used. A process with no
   * `providers` gets `null` for both groups, and the transport says so by name
   * (F03-AC2, F10-AC1, F11-AC1, N05-AC1).
   */
  readonly providers?: {
    readonly ticket: TicketAdapter;
    readonly git: GitAdapter;
  };
  /** Redaction applied to provider text before it reaches a stored row (N02-AC2). */
  readonly redactProviderText?: (text: string) => string;
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
  /** Over the same handle, so a compare-and-set is meaningful within a process (F02-AC2). */
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
  readonly plans: SqlitePlanStore;
  readonly publications: PublicationRepository;
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
  readonly planningUseCases: PlanningUseCases;
  /** Null when the process was configured with no ticket provider (F03-AC2). */
  readonly publicationUseCases: PublicationUseCases | null;
  /** Null for the same reason: adoption reads providers, so it cannot exist without one. */
  readonly adoptionUseCases: AdoptionUseCases | null;
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
  'plans',
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

/* -------------------------------------------------------------------------- */
/* Plans (F08, F09, F10)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The decisions that produced a plan, in the order they were taken.
 *
 * The domain `Plan` is a frozen derived value: `draftPlan` and `editPlan` are pure
 * functions over a proposal, a change shape and a list of edits. Storing the
 * *decisions* rather than the derived value means a stored plan is reproduced by
 * replaying them, so a row cannot disagree with the plan it claims to describe, and
 * the durable record is exactly what the owner and the proposing model actually
 * said (F08-AC1, F08-AC3).
 *
 * Every edit is revision-checked on replay, so a body that has been tampered with or
 * truncated fails loudly at read time instead of producing a plan nobody reviewed.
 */
export interface PlanDecisionTrail {
  readonly ideaId: string;
  readonly planId: string;
  /** Who asked for this draft, so a stored plan names the request it came from (F01-AC1). */
  readonly draftedBy: string;
  readonly change: ChangeShape;
  readonly proposal: PlanProposal;
  readonly edits: readonly PlanEdit[];
  /**
   * The work item each accepted task publishes as, fixed when the plan was drafted.
   *
   * Fixed at draft time rather than derived from the task's current position because
   * publication derives its operation identity from the work item, and a reordering
   * that changed it would let the same request address two different issues
   * (F10-AC3).
   */
  readonly taskWorkItemIds: Readonly<Record<string, string>>;
}

const PLAN_BODY_COLUMNS = 'plan_id, revision, body_redacted, state';

/** The lifecycle state a plan row carries alongside its decision trail. */
type PlanRowState = 'Draft' | 'Proposed' | 'Superseded' | 'Withdrawn';

const PLAN_ROW_STATES: readonly PlanRowState[] = ['Draft', 'Proposed', 'Superseded', 'Withdrawn'];

/**
 * The plan decision trail as a durable row.
 *
 * The same shape `SqliteOwnerCredentialStore` sets for `owners`: `@shiploop/storage`
 * owns the `plans` table and its columns, and it exposes no repository for a plan, so
 * the read and write live here rather than being reached around the controller from a
 * route. A durable `PlanRepository` against the same columns belongs in
 * `@shiploop/storage`; this is the narrowest thing that makes F08 reachable without
 * that change.
 */
export class SqlitePlanStore {
  private readonly connection: StorageConnection;

  constructor(connection: StorageConnection) {
    this.connection = connection;
  }

  /**
   * Replaces the trail for one plan.
   *
   * One row per plan, updated in place rather than appended: F08 requires the current
   * plan and its revision, not a history of plans, so a second row per plan would be
   * a version of the brief (F07) rather than of the plan. The revision travels in the
   * row so a stale read is caught by `UNIQUE (idea_id, revision)` rather than by a
   * caller remembering to compare it.
   */
  record(trail: PlanDecisionTrail, revision: number, at: string): Result<true, DomainError> {
    try {
      const existing = this.connection
        .prepare('SELECT revision FROM plans WHERE plan_id = ?')
        .get(trail.planId);
      if (existing === undefined) {
        this.connection
          .prepare(
            `INSERT INTO plans (plan_id, idea_id, revision, body_redacted, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            trail.planId,
            trail.ideaId,
            revision,
            redact(JSON.stringify(trail)).text,
            'Proposed',
            at,
            at,
          );
        return ok(true);
      }
      const written = this.connection
        .prepare(
          `UPDATE plans SET revision = ?, body_redacted = ?, state = ?, updated_at = ? WHERE plan_id = ?`,
        )
        .run(revision, redact(JSON.stringify(trail)).text, 'Proposed', at, trail.planId);
      if (Number(written.changes) !== 1) {
        return err({ code: 'Unavailable', reason: `Plan ${trail.planId} could not be written.` });
      }
      return ok(true);
    } catch (error) {
      return err({
        code: 'Unavailable',
        reason: `The plan decision trail could not be stored: ${describe(error)}`,
      });
    }
  }

  /** The trail for one plan, or null when the plan has never been drafted. */
  read(planId: string): Result<PlanDecisionTrail | null, DomainError> {
    try {
      const row = this.connection.prepare(`SELECT ${PLAN_BODY_COLUMNS} FROM plans WHERE plan_id = ?`).get(planId);
      if (row === undefined) return ok(null);
      const state = requiredText(row, 'state');
      if (!PLAN_ROW_STATES.includes(state as PlanRowState)) {
        return err({
          code: 'Unavailable',
          reason: `Plan ${planId} is stored in the unknown state "${state}".`,
        });
      }
      return ok(readTrail(requiredText(row, 'body_redacted'), planId));
    } catch (error) {
      return err({
        code: 'Unavailable',
        reason: `The plan decision trail could not be read: ${describe(error)}`,
      });
    }
  }

  /** Every plan drafted for one idea, newest revision first. */
  listForIdea(ideaId: string): Result<readonly PlanDecisionTrail[], DomainError> {
    try {
      const rows = this.connection
        .prepare(`SELECT ${PLAN_BODY_COLUMNS} FROM plans WHERE idea_id = ? ORDER BY revision DESC`)
        .all(ideaId);
      return ok(rows.map((row) => readTrail(requiredText(row, 'body_redacted'), requiredText(row, 'plan_id'))));
    } catch (error) {
      return err({
        code: 'Unavailable',
        reason: `The plans for one idea could not be read: ${describe(error)}`,
      });
    }
  }

  /**
   * The plan a work item address names.
   *
   * The address a publication or a readiness assessment is given is the plan's own
   * identifier, and this is how that identifier is resolved back to the plan. Plans
   * are per idea and a project holds a bounded number of them, so the scan is over
   * `plans` rows only and never touches work items or provider state.
   */
  findByAnyWorkItemId(workItemId: string): Result<PlanDecisionTrail | null, DomainError> {
    try {
      const rows = this.connection.prepare(`SELECT ${PLAN_BODY_COLUMNS} FROM plans`).all();
      for (const row of rows) {
        const trail = readTrail(requiredText(row, 'body_redacted'), requiredText(row, 'plan_id'));
        if (Object.values(trail.taskWorkItemIds).includes(workItemId)) return ok(trail);
      }
      return ok(null);
    } catch (error) {
      return err({
        code: 'Unavailable',
        reason: `The plan for one work item could not be read: ${describe(error)}`,
      });
    }
  }
}

/** The stored body read back as a trail, refusing a body this version cannot replay. */
function readTrail(body: string, planId: string): PlanDecisionTrail {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new Error(`Plan ${planId} has a decision trail that is not readable JSON`);
  }
  const record = decoded !== null && typeof decoded === 'object' ? (decoded as Record<string, unknown>) : null;
  if (record === null) throw new Error(`Plan ${planId} has a decision trail that is not an object`);
  const ideaId = record['ideaId'];
  const change = record['change'];
  const proposal = record['proposal'];
  const edits = record['edits'];
  const taskWorkItemIds = record['taskWorkItemIds'];
  if (typeof ideaId !== 'string' || change === null || typeof change !== 'object') {
    throw new Error(`Plan ${planId} has a decision trail without an idea or a change shape`);
  }
  if (proposal === null || typeof proposal !== 'object') {
    throw new Error(`Plan ${planId} has a decision trail without a proposal`);
  }
  if (!Array.isArray(edits) || taskWorkItemIds === null || typeof taskWorkItemIds !== 'object') {
    throw new Error(`Plan ${planId} has a decision trail without edits or task work items`);
  }
  const draftedBy = record['draftedBy'];
  return {
    ideaId,
    planId,
    draftedBy: typeof draftedBy === 'string' ? draftedBy : '',
    change: change as ChangeShape,
    proposal: proposal as PlanProposal,
    edits: edits as PlanEdit[],
    taskWorkItemIds: taskWorkItemIds as Readonly<Record<string, string>>,
  };
}

/**
 * The identity each proposed task publishes as.
 *
 * Derived from the plan and the task rather than minted, because a publication's
 * operation identity is derived from the work item and F10-AC3 requires a repeat of
 * the same request to address the same operation. A minted id would make a retry
 * after a timeout address a second issue, which is the exact duplicate that criterion
 * exists to prevent.
 */
export function taskWorkItemId(planId: string, taskId: string): string {
  return `wi_${planId}_${taskId}`;
}

/** What `assessReadiness` was asked to judge, assembled from what this process can read. */
export interface PlanReadinessReport {
  readonly decision: ReadinessDecision;
  /** F08-AC4: which tasks can be declared ready, and in which order. */
  readonly order: readonly string[];
  readonly blocked: readonly { readonly taskId: string; readonly reason: string }[];
}

/**
 * Planning use cases: the plan's lifecycle, its readiness, and its publication.
 *
 * Every rule these enforce already exists in `@shiploop/domain`: `draftPlan` refuses
 * an over-decomposed plan and an uncovered outcome, `editPlan` revision-checks every
 * owner action, and `assessReadiness` turns named areas into a verdict. What is added
 * here is the store and the clock, so a decision is recorded against durable state
 * rather than recomputed per request.
 */
export interface PlanningUseCases {
  readonly draftPlan: (
    input: {
      readonly ideaId: string;
      readonly planId: string;
      readonly change: ChangeShape;
      readonly proposal: PlanProposal;
      readonly actor: string;
    },
  ) => Result<Plan, DomainError>;
  readonly getPlan: (planId: string) => Result<Plan, DomainError>;
  readonly editPlan: (input: { readonly planId: string; readonly edit: PlanEdit }) => Result<Plan, DomainError>;
  readonly listPlansForIdea: (ideaId: string) => Result<readonly Plan[], DomainError>;
  readonly assessPlan: (planId: string) => Result<PlanReadinessReport, DomainError>;
  /** The accepted proposals as the tickets publication may act on (F08-AC3, F10-AC1). */
  readonly publishableFor: (planId: string) => Result<readonly PublishableTicket[], DomainError>;
  readonly workItemForTask: (planId: string, taskId: string) => string;
}

export interface PlanningDeps {
  readonly clock: ControllerClock;
  readonly plans: SqlitePlanStore;
  readonly ideas: IdeaRepository;
  readonly profiles: ProjectProfileRepository;
  readonly connectors: ConnectorRepository;
}

/**
 * The `investigationSupported` set: every area whose uncertainty read-only
 * investigation can actually resolve (F09-AC2).
 *
 * Access is the one exclusion. Reading code, a repository, an issue or a check is
 * investigation; obtaining a credential is not, so an open Access area is the case
 * where a build is disabled and investigation is not offered as the way past it.
 */
const INVESTIGATABLE_AREAS = Object.freeze([
  'Scope',
  'Criteria',
  'Repository',
  'Target',
  'Dependencies',
  'Verification',
] as const);

function satisfied(reason: string): AreaObservation {
  return { status: 'Satisfied', reason, remedy: null };
}

function unmet(reason: string, remedy: string): AreaObservation {
  return { status: 'Unmet', reason, remedy };
}

/**
 * Assembles the readiness observation from what this process can genuinely read.
 *
 * Nothing here is invented. Scope and criteria come from the plan, repository and
 * target from the project's saved profile, access from the connectors that profile's
 * project actually has, and verification from the tasks' own stated methods. An area
 * this slice cannot observe is reported `Unknown` with a reason naming the reader that
 * is missing, which is what keeps an unassessed prerequisite from reading as a
 * satisfied one (F09-AC1, F09-AC4).
 */
export function readinessObservationFor(
  plan: Plan,
  profile: { readonly repository: string; readonly targetBranch: string } | null,
  ticketConnectorHealthy: boolean,
  assessedAt: string,
): ReadinessObservation {
  const active = plan.tasks.filter((task) => task.acceptance.state !== 'Removed');
  const withCriteria = active.filter((task) => task.acceptanceCriteria.length > 0);
  const withVerification = active.filter((task) => task.verificationMethod.trim().length > 0);
  const publishedTasks = active.filter((task) => task.acceptance.state === 'Accepted');

  const dependencies = plan.tasks
    .flatMap((task) => task.dependencies)
    .map((dependsOn) => ({
      id: dependsOn,
      // A dependency that has been published exists at the provider; one that has not
      // is still a proposal. Neither is Cancelled, because nothing in a plan can
      // cancel work, and reporting a cancellation nobody recorded would be a blocker
      // with no source (F09-AC3).
      status: (publishedTasks.some((task) => task.taskId === dependsOn) ? 'Done' : 'Todo') as DependencyStatus,
      // No release receipt is recorded against a plan task in this slice, and F09-AC3
      // is precisely the rule that "done" is not a delivery: so a Done dependency that
      // the work consumes is reported as awaiting its receipt rather than as available.
      releaseReceiptRecorded: false,
      requiresRelease: true,
    }));

  return {
    subjectId: plan.planId,
    assessedAt,
    scope:
      active.length === 0
        ? unmet(
            'Every proposed task has been removed, so there is nothing scoped to build.',
            'Restore or re-propose a task before the work can start.',
          )
        : satisfied(`${active.length} active task(s) cover every requested outcome (F08-AC5).`),
    criteria:
      withCriteria.length === active.length
        ? satisfied(`All ${active.length} active task(s) state at least one acceptance criterion (F08-AC1).`)
        : unmet(
            `${active.length - withCriteria.length} active task(s) state no acceptance criterion.`,
            'Add an acceptance criterion to each task, or remove the task.',
          ),
    repository:
      profile === null
        ? unmet(
            'This project has no saved profile, so no repository has been read.',
            'Save a project profile naming the repository, then assess readiness again (F02-AC1, F09-AC1).',
          )
        : satisfied(`The project profile names ${profile.repository}.`),
    target:
      profile === null
        ? unmet(
            'This project has no saved profile, so no delivery target has been read.',
            'Save a project profile naming the target branch, then assess readiness again (F02-AC1, F09-AC1).',
          )
        : satisfied(`Delivery targets ${profile.targetBranch}.`),
    verification:
      withVerification.length === active.length
        ? satisfied(`All ${active.length} active task(s) state how they will be verified (F08-AC1).`)
        : unmet(
            `${active.length - withVerification.length} active task(s) state no verification method.`,
            'Name how each task will be verified; an undecided method blocks completion, not implementation (F09-AC1).',
          ),
    access: ticketConnectorHealthy
      ? satisfied('A ticket connector for this project reports itself healthy.')
      : unmet(
          'No ticket connector for this project is configured and healthy, so the provider cannot be reached.',
          'Register a working ticket connector on the Connectors screen, then assess readiness again (F03-AC2, F09-AC1).',
        ),
    dependencies,
    investigationSupported: INVESTIGATABLE_AREAS,
  };
}

function createPlanningUseCases(deps: PlanningDeps): PlanningUseCases {
  /**
   * Replays a stored trail into the plan it describes.
   *
   * `draftPlan` runs first and each edit follows in order, so a body whose edits do
   * not chain from its draft fails here rather than producing a plan the owner never
   * reviewed (F08-AC3).
   */
  const replay = (trail: PlanDecisionTrail): Result<Plan, DomainError> => {
    const validated = applyPlanProposal(trail.proposal);
    if (!validated.ok) return err(validated.error);
    const drafted = domainDraftPlan({
      planId: trail.planId,
      briefId: trail.proposal.briefId,
      change: trail.change,
      proposal: validated.value,
    });
    if (!drafted.ok) return err(drafted.error);
    let current = drafted.value;
    for (const edit of trail.edits) {
      const next = domainEditPlan(current, edit);
      if (!next.ok) return err(next.error);
      current = next.value;
    }
    return ok(current);
  };

  const load = (planId: string): Result<{ trail: PlanDecisionTrail; plan: Plan }, DomainError> => {
    const read = deps.plans.read(planId);
    if (!read.ok) return err(read.error);
    const trail = read.value;
    if (trail === null) return err({ code: 'NotFound', reason: `Plan ${planId} has never been drafted.` });
    try {
      const plan = replay(trail);
      if (!plan.ok) return err(plan.error);
      return ok({ trail, plan: plan.value });
    } catch (error) {
      return err({
        code: 'Unavailable',
        reason: `Plan ${planId} could not be rebuilt from its stored decisions: ${describe(error)}`,
      });
    }
  };

  const draftPlan = (
    input: {
      readonly ideaId: string;
      readonly planId: string;
      readonly change: ChangeShape;
      readonly proposal: PlanProposal;
      readonly actor: string;
    },
  ): Result<Plan, DomainError> => {
    const idea = deps.ideas.get(input.ideaId as IdeaId);
    if (!idea.ok) return err(idea.error);
    const validated = applyPlanProposal(input.proposal);
    if (!validated.ok) return err(validated.error);
    const drafted = domainDraftPlan({
      planId: input.planId,
      briefId: input.proposal.briefId,
      change: input.change,
      proposal: validated.value,
    });
    if (!drafted.ok) return err(drafted.error);

    const existing = deps.plans.read(input.planId);
    if (!existing.ok) return err(existing.error);
    if (existing.value !== null) {
      return err(
        conflict(
          `Plan ${input.planId} has already been drafted, so drafting it again would discard the owner's edits.`,
          'a plan id that has never been drafted',
          `plan ${input.planId}`,
        ),
      );
    }

    const taskWorkItemIds = workItemsFor(drafted.value);
    const trail: PlanDecisionTrail = {
      ideaId: input.ideaId,
      planId: input.planId,
      draftedBy: input.actor,
      change: input.change,
      proposal: input.proposal,
      edits: [],
      taskWorkItemIds,
    };
    const recorded = deps.plans.record(trail, drafted.value.revision, deps.clock.now());
    if (!recorded.ok) return err(recorded.error);
    return ok(drafted.value);
  };

  const resolve = (planId: string): Result<PlanDecisionTrail, DomainError> => {
    const direct = deps.plans.read(planId);
    if (!direct.ok) return err(direct.error);
    if (direct.value !== null) return ok(direct.value);
    // The address may be a work item the plan publishes as rather than the plan id
    // itself, so a client handed one by a publication report can reach the plan without
    // a second lookup (F10-AC2).
    const byWorkItem = deps.plans.findByAnyWorkItemId(planId);
    if (!byWorkItem.ok) return err(byWorkItem.error);
    if (byWorkItem.value === null) {
      return err({
        code: 'NotFound',
        reason: `No plan has id ${planId} and none publishes it as a work item. Open the plan from its own address (F10-AC2).`,
      });
    }
    return ok(byWorkItem.value);
  };

  const getPlan = (planId: string): Result<Plan, DomainError> => {
    const addressed = resolve(planId);
    if (!addressed.ok) return err(addressed.error);
    const found = load(addressed.value.planId);
    return found.ok ? ok(found.value.plan) : err(found.error);
  };

  const listPlansForIdea = (ideaId: string): Result<readonly Plan[], DomainError> => {
    const trails = deps.plans.listForIdea(ideaId);
    if (!trails.ok) return err(trails.error);
    const plans: Plan[] = [];
    for (const trail of trails.value) {
      try {
        const replayed = replay(trail);
        if (!replayed.ok) return err(replayed.error);
        plans.push(replayed.value);
      } catch (error) {
        return err({
          code: 'Unavailable',
          reason: `Plan ${trail.planId} could not be rebuilt from its stored decisions: ${describe(error)}`,
        });
      }
    }
    return ok(plans);
  };

  const editPlan = (input: { readonly planId: string; readonly edit: PlanEdit }): Result<Plan, DomainError> => {
    const addressed = resolve(input.planId);
    if (!addressed.ok) return err(addressed.error);
    const found = load(addressed.value.planId);
    if (!found.ok) return err(found.error);
    const edited = domainEditPlan(found.value.plan, input.edit);
    if (!edited.ok) return err(edited.error);
    const trail: PlanDecisionTrail = {
      ...found.value.trail,
      edits: [...found.value.trail.edits, input.edit],
      taskWorkItemIds: workItemsFor(edited.value),
    };
    const recorded = deps.plans.record(trail, edited.value.revision, deps.clock.now());
    if (!recorded.ok) return err(recorded.error);
    return ok(edited.value);
  };

  const assessPlan = (planId: string): Result<PlanReadinessReport, DomainError> => {
    const addressed = resolve(planId);
    if (!addressed.ok) return err(addressed.error);
    const found = load(addressed.value.planId);
    if (!found.ok) return err(found.error);
    const plan = found.value.plan;
    const idea = deps.ideas.get(found.value.trail.ideaId as IdeaId);
    const projectId = idea.ok ? idea.value.projectId : null;
    const profile = projectId === null ? null : readProfileReferences(deps.profiles, projectId);
    const connectors = projectId === null ? null : deps.connectors.listForProject(projectId);
    const ticketConnectorHealthy =
      connectors !== null &&
      connectors.ok &&
      connectors.value.some((connector) => connector.kind === 'Ticket' && connector.state === 'Healthy');

    const decision = assessReadiness(
      readinessObservationFor(plan, profile, ticketConnectorHealthy, deps.clock.now()),
    );
    if (!decision.ok) return err(decision.error);

    const readiness = planReadiness(plan);
    return ok({
      decision: decision.value,
      order: readiness.order,
      blocked: readiness.tasks
        .filter((entry) => !entry.ready)
        .map((entry) => ({
          taskId: entry.taskId,
          reason:
            entry.blockedBy
              .map((blocker) =>
                blocker.kind === 'Cycle'
                  ? `it is part of the dependency cycle ${blocker.cycle.join(' -> ')}`
                  : `it depends on "${blocker.dependsOn}", which the plan no longer has`,
              )
              .join('; ') + ' (F08-AC4)',
        })),
    });
  };

  const publishableFor = (planId: string): Result<readonly PublishableTicket[], DomainError> => {
    const addressed = resolve(planId);
    if (!addressed.ok) return err(addressed.error);
    const found = load(addressed.value.planId);
    if (!found.ok) return err(found.error);
    return ok(publishableTickets(found.value.plan));
  };

  const workItemForTask = (planId: string, taskId: string): string => taskWorkItemId(planId, taskId);

  return {
    draftPlan,
    getPlan,
    editPlan,
    listPlansForIdea,
    assessPlan,
    publishableFor,
    workItemForTask,
  };
}

/**
 * Carries the work item of an absorbed task onto the task that absorbed it.
 *
 * A combine removes the absorbed tasks, so their identities would stop naming
 * anything the plan holds. Each remaining task's identity is recomputed from the
 * current task set, which keeps exactly one work item per live task and none for a
 * task that no longer exists (F08-AC3, F10-AC3).
 */
function workItemsFor(plan: Plan): Readonly<Record<string, string>> {
  const assigned: Record<string, string> = {};
  for (const task of plan.tasks) assigned[task.taskId] = taskWorkItemId(plan.planId, task.taskId);
  return assigned;
}

/** The repository and target a saved profile names, or null when it has none. */
function readProfileReferences(
  profiles: ProjectProfileRepository,
  projectId: ProjectId,
): { readonly repository: string; readonly targetBranch: string } | null {
  const current = profiles.currentVersion(projectId);
  if (!current.ok || current.value === null) return null;
  const { repository, targetBranch } = current.value.content.references;
  if (typeof repository !== 'string' || typeof targetBranch !== 'string') return null;
  return { repository, targetBranch };
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

  const planStore = new SqlitePlanStore(database);
  const planningUseCases = createPlanningUseCases({
    clock: config.clock,
    plans: planStore,
    ideas,
    profiles,
    connectors,
  });

  // Publication and adoption need a ticket provider and a git provider. Neither is
  // constructed here: `config.providers` carries whatever the process was configured
  // with, and a process configured with none gets `null` for both groups rather than a
  // use case that would refuse every call with a fabricated reason (F03-AC2, N05-AC1).
  const providers = config.providers ?? null;
  const publications = new PublicationRepository(database);
  const publicationUseCases =
    providers === null
      ? null
      : createPublicationUseCases({
          clock: config.clock,
          publications,
          ticket: providers.ticket,
          ...(config.redactProviderText === undefined ? {} : { redactProviderText: config.redactProviderText }),
        });
  const adoptionUseCases =
    providers === null
      ? null
      : createAdoptionUseCases({
          clock: config.clock,
          publications,
          scope,
          profiles,
          ticket: providers.ticket,
          git: providers.git,
          ...(config.redactProviderText === undefined ? {} : { redactProviderText: config.redactProviderText }),
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
    candidates,
    jobs,
    leases,
    credentials,
    plans: planStore,
    /** Over the same handle, so a compare-and-set is meaningful within a process (F02-AC2). */
    workItems: new WorkItemRepository(database, { transaction: (body) => withTransaction(database, body) }),
    publications,
    scope,
    useCases: { ...profileUseCases, ...connectorUseCases },
    intakeUseCases,
    sessionUseCases,
    jobUseCases,
    attentionUseCases,
    verificationUseCases,
    acceptanceUseCases,
    planningUseCases,
    publicationUseCases,
    adoptionUseCases,
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

