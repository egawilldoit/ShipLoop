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
  blocked,
  err,
  invalid,
  ok,
  planReadiness,
  publishableTickets,
  readOnlyCapabilityProfile,
  redact,
  type AreaObservation,
  type Brief,
  type ChangeShape,
  type DependencyStatus,
  type DomainError,
  type IdeaDraft,
  type IdeaId,
  type OwnerId,
  type ReadOnlyCapabilityProfile,
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
  ProjectRepository,
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
import { validateRecipe, type PreflightDeps, type RecipeVersion, type RequiredCheckPolicy } from '@shiploop/verification';
import type { AdapterRegistry, ConnectorUseCases } from './connectors.ts';
import { createConnectorUseCases } from './connectors.ts';
import type { ProviderRegistry } from './providers.ts';
import type { AcceptanceUseCases } from './acceptance.ts';
import { createAcceptanceUseCases } from './acceptance.ts';
import type { AttentionUseCases } from './attention.ts';
import { SqliteAttentionScope, createAttentionUseCases } from './attention.ts';
import type { IntakeArtifactRoot, IntakeUseCases } from './intake.ts';
import { createIntakeUseCases } from './intake.ts';
import type { JobUseCases } from './jobs.ts';
import { createJobUseCases } from './jobs.ts';
import type {
  ControllerClock,
  OwnerActor,
  OwnerCredentialRecord,
  OwnerCredentialStore,
  ProfileUseCases,
} from './profiles.ts';
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
import type { ExecutionWorkspace } from '@shiploop/adapters';
import type { CapturedFact, ContextPacket } from './context-packet.ts';
import { assembleContextPacket } from './context-packet.ts';
import type { BriefGenerationUseCases } from './brief-generation.ts';
import { createBriefGenerationUseCases, createEngineClarifier } from './brief-generation.ts';
import type { PlanContextRequest, PlanGenerationUseCases } from './plan-generation.ts';
import {
  createPlanContextReader,
  createPlanGenerationUseCases,
  planEngineFromAdapter,
  requirePlanningOwner,
} from './plan-generation.ts';
import { requireIntakeOwner } from './intake.ts';

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
   * The providers this process was configured with (F03-AC1).
   *
   * Absent rather than empty-by-default because publication and adoption read or write a
   * provider, and a use case built over a provider that refuses every call would present
   * as a configured capability that cannot be used (F03-AC2, N05-AC1). `ticket` and `git`
   * are separately null because the two are configured independently: publishing needs a
   * ticket provider alone, while adopting a branch needs both (F10-AC1, F11-AC2).
   *
   * This is the registry, not a pair of adapters, so the transport can also ask whether a
   * stored credential reference resolves before it lets an operation reach a provider
   * (F03-AC1, F03-AC3).
   */
  readonly providers?: ProviderRegistry;
  /** Redaction applied to provider text before it reaches a stored row (N02-AC2). */
  readonly redactProviderText?: (text: string) => string;
  /**
   * The read-only workspace brief and plan generation run in (F07-AC4, F03-AC2).
   *
   * Required to be absent rather than defaulted, for the same reason `artifactRoot` is: a
   * generation pass confined to a directory this configuration did not name would put an
   * uninspected path into the prompt and into the record. A root without one refuses the
   * operation by name, and the engine being configured is not enough to change that (F07-AC4).
   */
  readonly generationWorkspace?: GenerationWorkspaceReader;
}

/**
 * Everything the web/API layer may reach, plus the handle it needs to read and
 * back up the durable store.
 */
export interface CompositionRoot {
  readonly database: Database;
  readonly owners: OwnerRepository;
  readonly projects: ProjectRepository;
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
  /**
   * Brief and plan generation, reached through the engine this process registered.
   *
   * Published rather than kept private because the owner's two actions - "write this brief for
   * me" and "propose a plan" - are exactly this group, and a transport that had to reach the
   * engine itself would be building a second composition (F07-AC1, F08-AC1, N05-AC2).
   */
  readonly generationUseCases: GenerationUseCases;
  /** The durable ledger every generation run is recorded in (N04-AC3). */
  readonly generationLedger: SqliteGenerationLedger;
  /** The providers this process registered, or null when it configured none (F03-AC2). */
  readonly providers: ProviderRegistry | null;
  /** Null when the process was configured with no ticket provider (F03-AC2). */
  readonly publicationUseCases: PublicationUseCases | null;
  /** Also null without a git provider: linking a branch reads one (F11-AC2). */
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
  const projects = new ProjectRepository(database);
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

  // Publication needs a ticket provider and adoption needs one plus a git provider.
  // Neither is constructed here: `config.providers` carries whatever the process was
  // configured with, and each group is absent unless the provider it reads was configured,
  // rather than built over a provider that would refuse every call with a fabricated
  // reason (F03-AC2, F10-AC1, F11-AC2, N05-AC1).
  const providers = config.providers ?? null;
  const ticketProvider = providers?.ticket ?? null;
  const gitProvider = providers?.git ?? null;
  const publications = new PublicationRepository(database);
  const publicationUseCases =
    ticketProvider === null
      ? null
      : createPublicationUseCases({
          clock: config.clock,
          publications,
          ticket: ticketProvider,
          ...(config.redactProviderText === undefined ? {} : { redactProviderText: config.redactProviderText }),
        });
  const adoptionUseCases =
    ticketProvider === null || gitProvider === null
      ? null
      : createAdoptionUseCases({
          clock: config.clock,
          publications,
          scope,
          profiles,
          ticket: ticketProvider,
          git: gitProvider,
          ...(config.redactProviderText === undefined ? {} : { redactProviderText: config.redactProviderText }),
        });

  /**
   * Generation, reached through the engine this process registered.
   *
   * The adapter comes from `config.providers`, which parsed the operator's configuration, so
   * the engine generation runs against is the configured one rather than a second engine chosen
   * here. Both passes are built over the same adapter, and neither is constructed at all when no
   * engine was configured: the use cases below then refuse the operation by name, which is a
   * different answer from a use case built over an engine that refuses every call (F03-AC2,
   * N05-AC2, F07-AC1).
   */
  const generationLedger = new SqliteGenerationLedger(database);
  const configuredEngine = providers?.engine ?? null;
  const briefGenerationFor =
    configuredEngine === null
      ? null
      : (workspace: ExecutionWorkspace): BriefGenerationUseCases =>
          createBriefGenerationUseCases({
            clock: config.clock,
            engine: createEngineClarifier({ engine: configuredEngine, workspace, clock: config.clock }),
            store: intake,
            workspace,
          });
  const planGeneration =
    configuredEngine === null
      ? null
      : createPlanGenerationUseCases({
          clock: config.clock,
          planning: planningUseCases,
          engine: planEngineFromAdapter(configuredEngine),
          readContextPacket: createPlanContextReader({ clock: config.clock, procedures, profiles }).read,
        });
  const generationUseCases = createGenerationUseCases({
    clock: config.clock,
    ledger: generationLedger,
    intake,
    profiles,
    briefGenerationFor,
    planGeneration,
    readWorkspace: config.generationWorkspace ?? null,
    engine: configuredEngine === null ? null : { connectorId: String(configuredEngine.connectorId) },
  });


  let closed = false;

  return ok({
    database,
    owners,
    projects,
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
    generationUseCases,
    generationLedger,
    providers,
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

/* -------------------------------------------------------------------------- */
/* Generation (F07-AC1, F08-AC1, N04-AC3)                                       */
/* -------------------------------------------------------------------------- */

/**
 * Which read-only pass a generation run performs.
 *
 * Named on the record because the two passes have different inputs, different outputs and
 * different refusals, and a record that could not say which one ran would answer questions
 * about a brief with facts about a plan (F07-AC1, F08-AC1).
 */
export type GenerationPass = 'Brief' | 'Plan';

/**
 * Where a generation run is, as a tracked identity rather than a promise (N04-AC3).
 *
 * `Queued` and `Running` are the two states a caller has to poll, and both are durable before
 * the first model call: an owner who closes the browser between the two still finds the run
 * and its outcome when they come back, because the state was written to the store rather than
 * held in the request (N04-AC3, F01-AC5).
 */
export type GenerationState = 'Queued' | 'Running' | 'Succeeded' | 'Failed';

/** The brief a successful clarification pass produced, as the owner reads it. */
export interface GeneratedBriefSummary {
  readonly briefId: string;
  readonly version: number;
  readonly state: 'Proposed' | 'Agreed';
  readonly authoredBy: string;
  readonly questionCount: number;
  readonly rejectedCandidateCount: number;
}

/** The plan a successful plan pass proposed, as the owner reads it. */
export interface GeneratedPlanSummary {
  readonly planId: string;
  readonly revision: number;
  readonly taskCount: number;
  readonly coveredOutcomeIds: readonly string[];
  readonly splitJustifications: readonly string[];
}

/** A refusal as the run record carries it: the code, the sentence and the fields to correct. */
export interface GenerationFailure {
  readonly code: string;
  readonly reason: string;
  readonly fields: readonly { readonly path: string; readonly message: string }[];
}

/**
 * One generation run, read from the ledger.
 *
 * Every field is a fact the run recorded: the engine it reached and the session it was given,
 * what the domain validated, and - when it refused - the refusal verbatim rather than a
 * paraphrase, because the field paths are how the owner corrects the answer (F05-AC5, F07-AC1).
 */
export interface GenerationRunView {
  readonly generationId: string;
  readonly pass: GenerationPass;
  readonly ideaId: string;
  readonly state: GenerationState;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** The engine this process registered; null before the session started (F03-AC2). */
  readonly connectorId: string | null;
  readonly engineVersion: string | null;
  readonly sessionId: string | null;
  readonly brief: GeneratedBriefSummary | null;
  readonly plan: GeneratedPlanSummary | null;
  readonly failure: GenerationFailure | null;
  /**
   * The exact capability profile the engine was granted, so a record states what the pass
   * could do rather than what it was asked to do (F07-AC5).
   */
  readonly capability: ReadOnlyCapabilityProfile;
}

/** The `audit_log` subject every generation run is recorded under. */
const GENERATION_SUBJECT_KIND = 'GenerationRun';

/**
 * Generation runs as rows in the durable audit ledger.
 *
 * The store has no generation table, and adding one would mean a second schema authority
 * beside `@shiploop/storage`. `audit_log` is the one append-only ledger this schema already
 * owns, it is indexed on `(subject_kind, subject_id)` which is exactly how a run is read back,
 * and nothing in the product reads it for any other purpose, so a run recorded here is a fact
 * about an operation that happened rather than a repurposed row of something else.
 *
 * One row per transition, never an update: `Queued`, then `Running`, then a terminal row. A
 * run's state is therefore the newest row for its identity, which means a reader that arrives
 * late, after a restart, or from another process reads the same answer the writer recorded
 * rather than a value that only ever lived in memory (N04-AC3, N01-AC3).
 */
export class SqliteGenerationLedger {
  private readonly connection: StorageConnection;
  private counter = 0;

  constructor(connection: StorageConnection) {
    this.connection = connection;
  }

  /** A run identity no other row can carry, minted from the injected clock and a counter. */
  nextId(at: string): string {
    this.counter += 1;
    return `gen_${at.replace(/[^0-9]/g, '')}_${String(this.counter)}`;
  }

  /** Appends one transition. Redacted before it is written: the text came from an engine. */
  append(input: {
    readonly run: GenerationRunView;
    readonly actor: string;
    readonly projectId: string | null;
    readonly at: string;
  }): Result<true, DomainError> {
    try {
      this.connection
        .prepare(
          `INSERT INTO audit_log
             (audit_id, project_id, actor, action, subject_kind, subject_id, correlation_id, occurred_at, detail_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `${input.run.generationId}-${input.at}-${String(this.counter)}`,
          input.projectId,
          input.actor,
          `Generation:${input.run.pass}:${input.run.state}`,
          GENERATION_SUBJECT_KIND,
          input.run.generationId,
          input.run.generationId,
          input.at,
          redact(JSON.stringify(input.run)).text,
        );
      this.counter += 1;
      return ok(true);
    } catch (error) {
      return err({
        code: 'Unavailable',
        reason: `The generation run could not be recorded: ${describe(error)}`,
      });
    }
  }

  /** One run, as its newest transition recorded it, or null when nothing recorded it. */
  read(generationId: string): Result<GenerationRunView | null, DomainError> {
    try {
      const row = this.connection
        .prepare(
          `SELECT detail_json FROM audit_log
           WHERE subject_kind = ? AND subject_id = ? ORDER BY occurred_at DESC, rowid DESC LIMIT 1`,
        )
        .get(GENERATION_SUBJECT_KIND, generationId);
      if (row === undefined) return ok(null);
      return ok(readRun(requiredText(row, 'detail_json')));
    } catch (error) {
      return err({ code: 'Unavailable', reason: `The generation run could not be read: ${describe(error)}` });
    }
  }

  /**
   * Every run recorded against one request, newest first.
   *
   * Filtered by the recorded document rather than by a column because the ledger's own columns
   * name the run, not the request it was started for; the number of rows is bounded by the
   * number of generations an owner has asked for, and each read is one indexed range.
   */
  listForIdea(ideaId: string): Result<readonly GenerationRunView[], DomainError> {
    try {
      const rows = this.connection
        .prepare(
          `SELECT detail_json FROM audit_log
           WHERE subject_kind = ? ORDER BY occurred_at DESC, rowid DESC`,
        )
        .all(GENERATION_SUBJECT_KIND);
      const seen = new Set<string>();
      const runs: GenerationRunView[] = [];
      for (const row of rows) {
        const run = readRun(requiredText(row, 'detail_json'));
        if (run.ideaId !== ideaId || seen.has(run.generationId)) continue;
        seen.add(run.generationId);
        runs.push(run);
      }
      return ok(runs);
    } catch (error) {
      return err({ code: 'Unavailable', reason: `The generation runs could not be read: ${describe(error)}` });
    }
  }
}

/**
 * One recorded run, read back from its document.
 *
 * A document this version cannot interpret is an error rather than a record with blanks in it:
 * a run reported as "queued" because its outcome could not be read is the failure N04-AC3
 * exists to prevent, and a silently empty status is exactly how that happens.
 */
function readRun(body: string): GenerationRunView {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body) as unknown;
  } catch {
    throw new Error(`Generation run ${body.slice(0, 32)}... has a record that is not readable JSON`);
  }
  const record = decoded !== null && typeof decoded === 'object' ? (decoded as Record<string, unknown>) : null;
  const generationId = record === null ? '' : String(record['generationId'] ?? '');
  if (record === null || generationId === '') {
    throw new Error('A generation record carries no identity');
  }
  const pass = String(record['pass']);
  const state = String(record['state']);
  const capability = record['capability'];
  if ((pass !== 'Brief' && pass !== 'Plan') || !GENERATION_STATES.includes(state as GenerationState)) {
    throw new Error(`Generation run ${generationId} is recorded in an unknown state: ${pass}/${state}`);
  }
  if (capability === null || typeof capability !== 'object') {
    throw new Error(`Generation run ${generationId} records no capability profile`);
  }
  return {
    generationId,
    pass,
    ideaId: String(record['ideaId'] ?? ''),
    state: state as GenerationState,
    startedAt: String(record['startedAt'] ?? ''),
    finishedAt: record['finishedAt'] === null ? null : String(record['finishedAt']),
    connectorId: record['connectorId'] === null ? null : String(record['connectorId']),
    engineVersion: record['engineVersion'] === null ? null : String(record['engineVersion']),
    sessionId: record['sessionId'] === null ? null : String(record['sessionId']),
    brief: (record['brief'] ?? null) as GeneratedBriefSummary | null,
    plan: (record['plan'] ?? null) as GeneratedPlanSummary | null,
    failure: (record['failure'] ?? null) as GenerationFailure | null,
    capability: capability as ReadOnlyCapabilityProfile,
  };
}

const GENERATION_STATES: readonly GenerationState[] = ['Queued', 'Running', 'Succeeded', 'Failed'];

/**
 * The read-only workspace a generation pass runs in.
 *
 * Injected rather than invented here because it is a fact about the deployment, not about this
 * process: a generation pass that claims a checkout nobody read would put an uninspected commit
 * into the prompt and the record (F07-AC4). A process with none configured refuses by name at the
 * operation rather than running against a directory it made up (F03-AC2).
 */
export type GenerationWorkspaceReader = (input: {
  readonly generationId: string;
  readonly pass: GenerationPass;
  readonly at: string;
}) => Promise<Result<ExecutionWorkspace, DomainError>>;

export interface GenerationDeps {
  readonly clock: ControllerClock;
  readonly ledger: SqliteGenerationLedger;
  readonly intake: IntakeRepository;
  readonly profiles: ProjectProfileRepository;
  /**
   * The clarification use cases for one workspace, built per run.
   *
   * A factory rather than an instance because the workspace is read when the pass starts, and a
   * use case built at boot would have to be given a workspace before one existed (F07-AC4).
   */
  readonly briefGenerationFor: ((workspace: ExecutionWorkspace) => BriefGenerationUseCases) | null;
  readonly planGeneration: PlanGenerationUseCases | null;
  /**
   * The read-only workspace a pass runs in, or null when the deployment configured none.
   *
   * Null is a named refusal at the operation rather than a default directory: a pass that ran
   * somewhere this configuration did not name would put an uninspected path into the prompt and
   * the record (F07-AC4, F03-AC2).
   */
  readonly readWorkspace: GenerationWorkspaceReader | null;
  /**
   * The engine this process registered, or null when it configured none.
   *
   * Only its identity is read here. The adapter itself was already bound into the two use cases
   * this root built, so a second reference could only be used to reach an engine the composition
   * did not choose (F03-AC2, N05-AC2).
   */
  readonly engine: { readonly connectorId: string } | null;
}

/**
 * Starting a generation and reading it back (N04-AC3).
 *
 * The two shapes are deliberately different: a start is synchronous and returns a tracked
 * identity immediately, and everything after that is a read. Nothing here waits for a model
 * turn, so an owner action never holds an HTTP request open while an engine reasons
 * (N04-AC3, N04-AC2).
 */
export interface GenerationUseCases {
  /** F07-AC1: draft this request's brief in one bounded read-only pass. */
  readonly startBriefGeneration: (command: {
    readonly ideaId: IdeaId;
    readonly actor: OwnerActor;
  }) => Result<GenerationRunView, DomainError>;
  /** F08-AC1: propose a plan for this request's agreed brief in one read-only pass. */
  readonly startPlanGeneration: (command: {
    readonly ideaId: IdeaId;
    readonly actor: OwnerActor;
  }) => Result<GenerationRunView, DomainError>;
  /** The run's current state and whatever it produced or refused (N04-AC3). */
  readonly getGeneration: (generationId: string) => Result<GenerationRunView, DomainError>;
  /** Every run recorded against one request, newest first. */
  readonly listGenerations: (ideaId: IdeaId) => Result<readonly GenerationRunView[], DomainError>;
  /**
   * Resolves once nothing is in flight.
   *
   * Used by shutdown and by tests that assert an outcome without polling for it. It is a drain,
   * not a cancel: a run in flight finishes and records its outcome.
   */
  readonly drained: () => Promise<true>;
}

/** How many passes one process runs at once. One, because a recorded run has no queue to wait in. */
const MAXIMUM_CONCURRENT_GENERATIONS = 1;

function noEngineConfigured(pass: GenerationPass): DomainError {
  return blocked(
    `This deployment configured no coding engine, so a ${pass.toLowerCase()} cannot be generated (F03-AC2).`,
    [
      {
        name: 'coding engine',
        detail:
          'Brief and plan generation run a read-only session against the engine this process was configured with, and this process was started without one.',
        remedy: 'Configure a coding engine for this deployment, restart it, then ask again (F03-AC1).',
      },
    ],
  );
}

function noWorkspaceConfigured(pass: GenerationPass): DomainError {
  return blocked(
    `This deployment configured no read-only generation workspace, so a ${pass.toLowerCase()} pass has nowhere to run (F03-AC2).`,
    [
      {
        name: 'generation workspace',
        detail:
          'A generation pass is confined to one named workspace, and this process was started without one. Running it anywhere else would put an uninspected path into the prompt and the record.',
        remedy: 'Configure a read-only workspace for this deployment, restart it, then ask again (F07-AC4).',
      },
    ],
  );
}

function generationFailure(error: DomainError): GenerationFailure {
  const fields = error.code === 'Invalid' && Array.isArray((error as { readonly fields?: unknown }).fields)
    ? ((error as { readonly fields: readonly { path: string; message: string }[] }).fields ?? [])
    : [];
  return { code: error.code, reason: error.reason, fields };
}

/**
 * The context a clarification pass is given, assembled from what this process actually read.
 *
 * Every fact carries either the text that was read or why nothing was read, and the repository
 * is always present as an explicit unknown: this process reads no checkout, so a packet that
 * omitted it would let the model believe the repository had nothing to say about the request
 * (F07-AC4). The saved profile is included only when there is one, and it says what it names
 * rather than what it implies (F02-AC1).
 */
function contextPacketFor(
  deps: GenerationDeps,
  idea: IdeaDraft,
  brief: Brief | null,
  at: string,
): Result<ContextPacket, DomainError> {
  const facts: CapturedFact[] = [
    {
      factId: `conversation:${idea.ideaId}`,
      kind: 'OwnerConversation',
      subject: 'the request the owner captured',
      reference: `idea:${String(idea.ideaId)}`,
      observation: { observed: idea.rawRequest, inspectedRevision: null, observedAt: idea.capturedAt },
      unknownReason: null,
    },
    {
      factId: 'repository:uninspected',
      kind: 'RepositoryState',
      subject: 'the repository this request is about',
      reference: 'the project profile',
      observation: null,
      unknownReason:
        'No checkout was read for this clarification pass: this process reads no repository, so nothing is known about the code (F07-AC4).',
    },
  ];

  const projectId = idea.projectId as ProjectId | null;
  const profile = projectId === null ? null : deps.profiles.currentVersion(projectId);
  if (idea.projectId !== null && profile !== null && profile.ok && profile.value !== null) {
    const references = profile.value.content.references;
    facts.push({
      factId: `profile:${String(profile.value.profileVersionId)}`,
      kind: 'ProjectProfile',
      subject: 'the project profile',
      reference: `profile:${String(profile.value.profileVersionId)}`,
      observation: {
        observed: `Repository ${references.repository}; delivery target ${references.targetBranch}.`,
        inspectedRevision: null,
        observedAt: profile.value.createdAt,
      },
      unknownReason: null,
    });
  }

  if (brief !== null) {
    facts.push({
      factId: `brief:${String(brief.briefId)}`,
      kind: 'OwnerConversation',
      subject: 'the brief already agreed for this request',
      reference: `brief:${String(brief.briefId)}`,
      observation: {
        observed: `Desired outcome: ${brief.sections.desiredOutcome}`,
        inspectedRevision: null,
        observedAt: brief.authoredAt,
      },
      unknownReason: null,
    });
  }

  return assembleContextPacket({
    packetId: `packet_${String(idea.ideaId)}_${at.replace(/[^0-9]/g, '')}`,
    ideaId: idea.ideaId,
    projectId: idea.projectId,
    assembledAt: at,
    facts,
  });
}

/**
 * The change a plan is generated against, read from the brief it delivers.
 *
 * No repository was inspected for this pass, so the change is the brief's own desired outcome
 * as a single reviewable surface. Deriving it rather than inventing one is what keeps the split
 * decision honest: `shouldSplit` sees one independently reviewable unit, so a proposal that
 * asks for more than one task is refused by name instead of being split on the model's word
 * (F08-AC2, F08-AC5).
 */
function changeShapeFor(brief: Brief): ChangeShape {
  const observable = brief.sections.acceptanceCriteria.map((criterion) => criterion.text);
  return {
    summary: brief.sections.desiredOutcome,
    surfaces: [
      {
        surfaceId: `brief:${brief.briefId}`,
        description: brief.sections.desiredOutcome,
        observableBehaviour: observable.length === 0 ? brief.sections.desiredOutcome : observable.join(' '),
        independentlyReviewable: true,
      },
    ],
    dependencyEdges: [],
  };
}

/**
 * Binds both generation paths to durable state, an engine and a workspace.
 *
 * The order inside one pass is the argument: the owner and the engine are checked before
 * anything is scheduled, `Queued` is written before the engine is contacted so the identity
 * exists even if the process dies mid-turn, and the terminal row carries the outcome verbatim
 * (N04-AC3, F05-AC5).
 */
function createGenerationUseCases(deps: GenerationDeps): GenerationUseCases {
  let active = 0;
  const queue: (() => Promise<void>)[] = [];
  let idle: (() => void) | null = null;

  const drain = (): void => {
    while (active < MAXIMUM_CONCURRENT_GENERATIONS && queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      active += 1;
      void Promise.resolve()
        .then(next)
        .catch(() => undefined)
        .then(() => {
          active -= 1;
          if (active === 0 && queue.length === 0 && idle !== null) {
            const resolve = idle;
            idle = null;
            resolve();
          } else {
            drain();
          }
        });
    }
  };

  const record = (run: GenerationRunView, actor: OwnerActor, projectId: string | null): Result<true, DomainError> =>
    deps.ledger.append({ run, actor: actor.actorId, projectId, at: deps.clock.now() });

  /** A refusal becomes the run's terminal state; nothing throws across the background task. */
  const settleFailure = (run: GenerationRunView, error: DomainError, actor: OwnerActor, projectId: string | null): void => {
    record({ ...run, state: 'Failed', finishedAt: deps.clock.now(), failure: generationFailure(error) }, actor, projectId);
  };

  const startBriefGeneration: GenerationUseCases['startBriefGeneration'] = (command) => {
    const permitted = requireIntakeOwner(command.actor);
    if (!permitted.ok) return err(permitted.error);
    const readWorkspace = deps.readWorkspace;
    const buildBriefGeneration = deps.briefGenerationFor;
    if (deps.engine === null || buildBriefGeneration === null) return err(noEngineConfigured('Brief'));
    if (readWorkspace === null) return err(noWorkspaceConfigured('Brief'));

    const idea = deps.intake.read(command.ideaId);
    if (!idea.ok) return err(idea.error);
    const current = deps.intake.currentBrief(command.ideaId);
    if (!current.ok) return err(current.error);
    if (current.value !== null) {
      return err(
        conflict(
          `This request already has a brief at version ${String(current.value.version)}.`,
          'no brief yet',
          `version ${String(current.value.version)}`,
        ),
      );
    }

    const at = deps.clock.now();
    const queued: GenerationRunView = {
      generationId: deps.ledger.nextId(at),
      pass: 'Brief',
      ideaId: String(command.ideaId),
      state: 'Queued',
      startedAt: at,
      finishedAt: null,
      connectorId: deps.engine?.connectorId ?? null,
      engineVersion: null,
      sessionId: null,
      brief: null,
      plan: null,
      failure: null,
      capability: readOnlyCapabilityProfile,
    };
    const recorded = record(queued, command.actor, idea.value.projectId);
    if (!recorded.ok) return err(recorded.error);

    queue.push(async () => {
      const running = record({ ...queued, state: 'Running' }, command.actor, idea.value.projectId);
      if (!running.ok) return;
      const workspace = await readWorkspace({ generationId: queued.generationId, pass: 'Brief', at });
      if (!workspace.ok) {
        settleFailure(queued, workspace.error, command.actor, idea.value.projectId);
        return;
      }
      const packet = contextPacketFor(deps, idea.value, null, deps.clock.now());
      if (!packet.ok) {
        settleFailure(queued, packet.error, command.actor, idea.value.projectId);
        return;
      }
      const generated = await buildBriefGeneration(workspace.value).generateBrief({
        briefId: `brief-${String(command.ideaId)}`,
        idea: idea.value,
        contextPacket: packet.value,
        operationId: queued.generationId,
      });
      const at2 = deps.clock.now();
      if (!generated.ok) {
        settleFailure(queued, generated.error, command.actor, idea.value.projectId);
        return;
      }
      record(
        {
          ...queued,
          state: 'Succeeded',
          finishedAt: at2,
          engineVersion: generated.value.engineVersion,
          sessionId: String(generated.value.sessionId),
          brief: {
            briefId: generated.value.brief.briefId,
            version: generated.value.brief.version,
            state: generated.value.brief.state,
            authoredBy: generated.value.brief.authoredBy,
            questionCount: generated.value.questions.length,
            rejectedCandidateCount: generated.value.rejected.length,
          },
        },
        command.actor,
        idea.value.projectId,
      );
    });
    drain();
    return ok(queued);
  };

  const startPlanGeneration: GenerationUseCases['startPlanGeneration'] = (command) => {
    const permitted = requirePlanningOwner(command.actor);
    if (!permitted.ok) return err(permitted.error);
    const readWorkspace = deps.readWorkspace;
    const planGeneration = deps.planGeneration;
    if (deps.engine === null || planGeneration === null) return err(noEngineConfigured('Plan'));
    if (readWorkspace === null) return err(noWorkspaceConfigured('Plan'));

    const idea = deps.intake.read(command.ideaId);
    if (!idea.ok) return err(idea.error);
    const briefs = deps.intake.listBriefs(command.ideaId);
    if (!briefs.ok) return err(briefs.error);
    const agreed = briefs.value.find((brief) => brief.state === 'Agreed');
    if (agreed === undefined) {
      return err(
        invalid('A plan is generated from an agreed brief, and this request has none (F07-AC1, F08-AC1).', [
          {
            path: 'brief.state',
            message:
              briefs.value.length === 0
                ? 'No brief has been drafted for this request. Generate or record one, then agree it.'
                : `The newest brief is at version ${String(briefs.value[briefs.value.length - 1]?.version ?? 0)} and has not been agreed.`,
          },
        ]),
      );
    }

    const at = deps.clock.now();
    const queued: GenerationRunView = {
      generationId: deps.ledger.nextId(at),
      pass: 'Plan',
      ideaId: String(command.ideaId),
      state: 'Queued',
      startedAt: at,
      finishedAt: null,
      connectorId: deps.engine?.connectorId ?? null,
      engineVersion: null,
      sessionId: null,
      brief: null,
      plan: null,
      failure: null,
      capability: readOnlyCapabilityProfile,
    };
    const recorded = record(queued, command.actor, idea.value.projectId);
    if (!recorded.ok) return err(recorded.error);

    queue.push(async () => {
      const running = record({ ...queued, state: 'Running' }, command.actor, idea.value.projectId);
      if (!running.ok) return;
      const workspace = await readWorkspace({ generationId: queued.generationId, pass: 'Plan', at });
      if (!workspace.ok) {
        settleFailure(queued, workspace.error, command.actor, idea.value.projectId);
        return;
      }
      const request: PlanContextRequest = {
        packetId: `packet_${agreed.briefId}_v${String(agreed.version)}`,
        briefId: agreed.briefId,
        projectId: idea.value.projectId as ProjectId | null,
        subjectKeys: [],
        unrelatedSubjectKeys: [],
        ticketSnapshot: ['No ticket provider is configured for this project, so no ticket was read (F05-AC2).'],
        priorFeedback: [],
      };
      const packet = planGeneration.contextPacketFor(request);
      if (!packet.ok) {
        settleFailure(queued, packet.error, command.actor, idea.value.projectId);
        return;
      }
      const generated = await planGeneration.generateAndStorePlanProposal({
        brief: agreed,
        contextPacket: packet.value,
        ideaId: command.ideaId,
        change: changeShapeFor(agreed),
        workspace: workspace.value,
        actor: command.actor,
      });
      const at2 = deps.clock.now();
      if (!generated.ok) {
        settleFailure(queued, generated.error, command.actor, idea.value.projectId);
        return;
      }
      record(
        {
          ...queued,
          state: 'Succeeded',
          finishedAt: at2,
          engineVersion: generated.value.run.engineVersion,
          sessionId: String(generated.value.run.sessionId),
          plan: {
            planId: generated.value.planId,
            revision: generated.value.plan.revision,
            taskCount: generated.value.plan.tasks.length,
            coveredOutcomeIds: generated.value.coverage.map((entry) => entry.outcomeId),
            splitJustifications: generated.value.split.split ? [...generated.value.split.justifications] : [],
          },
        },
        command.actor,
        idea.value.projectId,
      );
    });
    drain();
    return ok(queued);
  };

  const getGeneration: GenerationUseCases['getGeneration'] = (generationId) => {
    if (generationId.trim().length === 0) {
      return err(invalid('A generation run is addressed by its identity.', [{ path: 'generationId', message: 'Must not be blank.' }]));
    }
    const found = deps.ledger.read(generationId);
    if (!found.ok) return err(found.error);
    if (found.value === null) {
      return err({ code: 'NotFound', reason: `No generation run ${generationId} has been recorded.` });
    }
    return ok(found.value);
  };

  const listGenerations: GenerationUseCases['listGenerations'] = (ideaId) => deps.ledger.listForIdea(ideaId);

  const drained: GenerationUseCases['drained'] = async () => {
    if (active > 0 || queue.length > 0) {
      await new Promise<void>((resolve) => {
        idle = resolve;
      });
    }
    return true;
  };

  return { startBriefGeneration, startPlanGeneration, getGeneration, listGenerations, drained };
}

