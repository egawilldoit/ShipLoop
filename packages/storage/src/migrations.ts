import { createHash } from 'node:crypto';
import type { SQLOutputValue } from 'node:sqlite';
import { ATTEMPT_STATES, err, invalid, ok, type DomainError, type Result } from '@shiploop/domain';
import type { Database } from './db.ts';
import { TransactionError, withTransaction } from './tx.ts';
import { JOB_MODES } from './jobs/types.ts';

/**
 * Versioned, forward-only schema for the local SQLite store
 * (ARCHITECTURE "Authority and durable state", mvp-spec 7 "Storage entities").
 *
 * Three rules shape the schema and the runner:
 *
 *   - Identity is opaque. Provider IDs and full 40/64 character commit SHAs are
 *     the keys; issue identifiers, titles, branch names and URLs are display
 *     columns that a repository may render but never key on (mvp-spec 7).
 *   - The three lifecycle dimensions are stored as three separate state
 *     columns with their own value lists. A fused status column would make
 *     "the agent finished, so it shipped" expressible (mvp-spec 3).
 *   - A migration is immutable. Applied versions are recorded, so a migration
 *     cannot be rewritten, reordered or renumbered after the fact: the runner
 *     refuses instead of guessing (N08-AC3).
 *
 * Every state list in a CHECK constraint mirrors a list in `@shiploop/domain`.
 * They are written out literally on purpose: adding a lifecycle state must
 * arrive as a new migration, otherwise an already-created database would keep
 * rejecting it while a fresh one accepted it.
 */

/** One forward-only schema step. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database) => void;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: string;
  readonly checksum: string;
}

export interface MigrationReport {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly { readonly version: number; readonly name: string }[];
}

export interface MigrateOptions {
  /** Clock for the applied-at record, injectable so evidence is reproducible. */
  readonly now?: () => string;
}

const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum   TEXT NOT NULL
)`;

const SELECT_APPLIED = 'SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version';

/** RFC 3339 UTC with milliseconds, which also sorts lexicographically. */
const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/**
 * The attempt lifecycle, taken from the domain rather than restated here.
 *
 * Every state CHECK in this file that guards an attempt or a job is derived from
 * this array, so a new domain state cannot be accepted by a freshly created
 * database and rejected by one that was migrated before the state existed. A
 * second, hand-written copy of this list is exactly the "two vocabularies for one
 * field" defect the project keeps eliminating (R5, ADR 0003).
 */
const ATTEMPT_STATE_VALUES = ATTEMPT_STATES;

const ACCEPTANCE_STATE_VALUES = [
  'NotRequested',
  'Pending',
  'ChangesRequested',
  'Accepted',
  'Stale',
] as const;

const DELIVERY_STATE_VALUES = [
  'NotAuthorized',
  'Authorized',
  'Merging',
  'Merged',
  'Releasing',
  'Released',
  'Failed',
  'OutcomeUnknown',
] as const;

const CHECK_RESULT_VALUES = [
  'Passed',
  'Failed',
  'Missing',
  'Waiting',
  'Stale',
  'NotApplicable',
] as const;

/**
 * The job modes, taken from the jobs slice's own `JOB_MODES` array.
 *
 * The schema previously carried `('PlanInvestigate', 'Build', 'Test', 'Review')`,
 * which merged `Plan` and `Investigate` into one value. They are separate modes
 * with different capability grants, so a single value would make a planning run
 * and an investigation indistinguishable in the durable record (F13-AC3). The
 * list is imported rather than restated so it cannot drift from the code that
 * writes it.
 */
const JOB_MODE_VALUES = JOB_MODES;

const ATTENTION_KIND_VALUES = [
  'ClarificationRequested',
  'Blocker',
  'ReadyForYourTest',
  'DeliveryDecision',
  'RecoveryDecision',
  'ReleaseResult',
  'SyncFailure',
  'WorkerStopped',
  'InvalidProfile',
  'LowArtifactCapacity',
] as const;

const ATTENTION_STATE_VALUES = ['Open', 'Acknowledged', 'Resolved'] as const;

const CHECK_ORIGIN_VALUES = ['LocalCheck', 'ProviderCi', 'BrowserEvidence', 'ApiEvidence', 'LiveSmoke'] as const;

const EVIDENCE_METHOD_VALUES = ['AutomatedCheck', 'OwnerTest', 'BrowserEvidence', 'ApiEvidence', 'Untested'] as const;

const CRITERION_STATUS_VALUES = [
  'Verified',
  'PendingOwnerTest',
  'Failed',
  'Missing',
  'Untested',
  'Stale',
] as const;

const MIGRATION_1_INSTANCE_OWNER_AND_CONFIGURATION = `
CREATE TABLE instance_state (
  singleton         INTEGER PRIMARY KEY CHECK (singleton = 1),
  origin            TEXT NOT NULL CHECK (origin IN ('Created', 'Restored')),
  dispatch_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (dispatch_enabled IN (0, 1)),
  delivery_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (delivery_enabled IN (0, 1)),
  restored_at       TEXT,
  activated_at      TEXT,
  updated_at        TEXT NOT NULL DEFAULT ${NOW},
  CHECK (origin <> 'Restored' OR restored_at IS NOT NULL)
);
INSERT INTO instance_state (singleton, origin) VALUES (1, 'Created');

CREATE TABLE owners (
  owner_id         TEXT PRIMARY KEY,
  identity_subject TEXT NOT NULL UNIQUE,
  display_name     TEXT,
  created_at       TEXT NOT NULL DEFAULT ${NOW},
  CHECK (length(trim(identity_subject)) > 0)
);

CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE CASCADE,
  issued_at    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  last_seen_at TEXT,
  CHECK (expires_at > issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);
CREATE INDEX sessions_by_owner ON sessions(owner_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE projects (
  project_id  TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT ${NOW},
  updated_at  TEXT NOT NULL DEFAULT ${NOW},
  archived_at TEXT,
  CHECK (archived_at IS NULL OR archived_at >= created_at)
);

CREATE TABLE project_profile_versions (
  profile_version_id            TEXT PRIMARY KEY,
  project_id                    TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  version                       INTEGER NOT NULL CHECK (version > 0),
  provider_project_id           TEXT,
  repository_display_url        TEXT,
  default_branch                TEXT,
  recipe_ref                    TEXT,
  environment_json              TEXT NOT NULL DEFAULT '{}',
  policy_json                   TEXT NOT NULL DEFAULT '{}',
  capability_version            TEXT,
  supersedes_profile_version_id TEXT REFERENCES project_profile_versions(profile_version_id),
  approved_at                   TEXT,
  created_at                    TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (project_id, version),
  CHECK (supersedes_profile_version_id IS NULL OR supersedes_profile_version_id <> profile_version_id)
);
CREATE INDEX project_profile_versions_by_project ON project_profile_versions(project_id, version DESC);

CREATE TABLE connectors (
  connector_id       TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  kind               TEXT NOT NULL CHECK (kind IN ('Ticket', 'Git', 'Deployment', 'Engine')),
  provider           TEXT NOT NULL,
  resource_scope     TEXT,
  credential_ref     TEXT NOT NULL,
  capability_state   TEXT NOT NULL DEFAULT 'Untested'
                       CHECK (capability_state IN ('Untested', 'Supported', 'Unsupported', 'Failed')),
  capability_version TEXT,
  capability_detail  TEXT,
  health_state       TEXT NOT NULL DEFAULT 'Unknown'
                       CHECK (health_state IN ('Unknown', 'Healthy', 'Degraded', 'Revoked', 'Unconfigured')),
  last_health_check_at TEXT,
  disabled_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT ${NOW},
  updated_at         TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (project_id, kind, provider),
  CHECK (length(trim(credential_ref)) > 0)
);
CREATE INDEX connectors_by_project ON connectors(project_id, kind);

CREATE TABLE procedure_versions (
  procedure_version_id TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  version               INTEGER NOT NULL CHECK (version > 0),
  kind                  TEXT NOT NULL CHECK (kind IN ('Procedure', 'Fact')),
  source                TEXT NOT NULL CHECK (source IN ('Owner', 'Repository', 'Provider')),
  provider_revision     TEXT,
  content_json          TEXT NOT NULL,
  content_fingerprint   TEXT NOT NULL,
  approval_state        TEXT NOT NULL DEFAULT 'Draft'
                          CHECK (approval_state IN ('Draft', 'Approved', 'Superseded')),
  approved_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (project_id, version),
  UNIQUE (project_id, kind, content_fingerprint),
  CHECK (approval_state = 'Draft' OR approved_at IS NOT NULL)
);
CREATE INDEX procedure_versions_by_project ON procedure_versions(project_id, kind, version DESC);
`;

const MIGRATION_2_INTAKE_SCOPE_AND_WORK_MAPPING = `
CREATE TABLE ideas (
  idea_id      TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  raw_request  TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'Received'
                 CHECK (state IN ('Received', 'Clarifying', 'Planned', 'Published', 'Abandoned')),
  created_at   TEXT NOT NULL DEFAULT ${NOW},
  updated_at   TEXT NOT NULL DEFAULT ${NOW},
  CHECK (length(trim(raw_request)) > 0)
);
CREATE INDEX ideas_by_project ON ideas(project_id, state, created_at);

CREATE TABLE idea_messages (
  message_id    TEXT PRIMARY KEY,
  idea_id       TEXT NOT NULL REFERENCES ideas(idea_id) ON DELETE CASCADE,
  author_role   TEXT NOT NULL CHECK (author_role IN ('Owner', 'Agent', 'System')),
  body_redacted TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idea_messages_by_idea ON idea_messages(idea_id, created_at);

CREATE TABLE idea_attachments (
  attachment_id TEXT PRIMARY KEY,
  idea_id       TEXT NOT NULL REFERENCES ideas(idea_id) ON DELETE CASCADE,
  artifact_ref  TEXT NOT NULL,
  file_name     TEXT,
  byte_size     INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (idea_id, artifact_ref)
);

CREATE TABLE briefs (
  brief_id    TEXT PRIMARY KEY,
  idea_id     TEXT NOT NULL REFERENCES ideas(idea_id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL CHECK (revision > 0),
  agreed_body TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'Draft' CHECK (state IN ('Draft', 'Agreed', 'Superseded')),
  created_at  TEXT NOT NULL DEFAULT ${NOW},
  updated_at  TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (idea_id, revision),
  CHECK (state <> 'Agreed' OR length(trim(agreed_body)) > 0)
);

CREATE TABLE idea_questions (
  question_id     TEXT PRIMARY KEY,
  idea_id         TEXT NOT NULL REFERENCES ideas(idea_id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'Open' CHECK (state IN ('Open', 'Answered', 'Superseded')),
  answer_redacted TEXT,
  created_at      TEXT NOT NULL DEFAULT ${NOW},
  answered_at     TEXT,
  CHECK (state <> 'Answered' OR answered_at IS NOT NULL)
);
CREATE INDEX idea_questions_by_idea ON idea_questions(idea_id) WHERE state = 'Open';

CREATE TABLE plans (
  plan_id       TEXT PRIMARY KEY,
  idea_id       TEXT NOT NULL REFERENCES ideas(idea_id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL CHECK (revision > 0),
  body_redacted TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'Draft'
                  CHECK (state IN ('Draft', 'Proposed', 'Superseded', 'Withdrawn')),
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  updated_at    TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (idea_id, revision)
);
CREATE INDEX plans_by_idea ON plans(idea_id, revision DESC);

CREATE TABLE plan_items (
  plan_item_id  TEXT PRIMARY KEY,
  plan_id       TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
  sequence      INTEGER NOT NULL CHECK (sequence > 0),
  title         TEXT NOT NULL,
  criterion_ref TEXT,
  proposed_mode TEXT ${nullableEnum('proposed_mode', JOB_MODE_VALUES)},
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (plan_id, sequence)
);

CREATE TABLE work_items (
  work_item_id       TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  idea_id            TEXT REFERENCES ideas(idea_id) ON DELETE SET NULL,
  issue_id           TEXT NOT NULL,
  issue_identifier   TEXT,
  title              TEXT,
  publication_intent TEXT NOT NULL
                       CHECK (publication_intent IN ('Unpublished', 'DraftPublish', 'Published', 'Adopted')),
  origin             TEXT NOT NULL CHECK (origin IN ('Proposed', 'Published', 'Adopted')),
  created_at         TEXT NOT NULL DEFAULT ${NOW},
  updated_at         TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (project_id, issue_id),
  CHECK (length(trim(issue_id)) > 0)
);
CREATE INDEX work_items_by_project ON work_items(project_id, publication_intent, created_at);
CREATE INDEX work_items_by_idea ON work_items(idea_id);

CREATE TABLE work_item_relations (
  work_item_id      TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,
  relation_kind     TEXT NOT NULL
                      CHECK (relation_kind IN ('Blocks', 'BlockedBy', 'Related', 'Parent', 'Duplicate')),
  related_issue_id TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (work_item_id, relation_kind, related_issue_id)
);

CREATE TABLE scope_snapshots (
  scope_snapshot_id TEXT PRIMARY KEY,
  work_item_id       TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  project_id         TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  issue_id           TEXT NOT NULL,
  issue_identifier   TEXT,
  title              TEXT,
  description        TEXT NOT NULL,
  provider_revision  TEXT,
  priority           TEXT,
  scope_fingerprint  TEXT NOT NULL,
  retrieved_at       TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT ${NOW},
  CHECK (length(trim(scope_fingerprint)) > 0)
);
CREATE INDEX scope_snapshots_by_work_item ON scope_snapshots(work_item_id, retrieved_at DESC);

CREATE TABLE scope_snapshot_criteria (
  scope_snapshot_id TEXT NOT NULL REFERENCES scope_snapshots(scope_snapshot_id) ON DELETE RESTRICT,
  criterion_id      TEXT NOT NULL,
  text              TEXT NOT NULL,
  PRIMARY KEY (scope_snapshot_id, criterion_id)
);

CREATE TABLE scope_snapshot_dependencies (
  scope_snapshot_id  TEXT NOT NULL REFERENCES scope_snapshots(scope_snapshot_id) ON DELETE RESTRICT,
  dependency_issue_id TEXT NOT NULL,
  PRIMARY KEY (scope_snapshot_id, dependency_issue_id)
);

CREATE TRIGGER scope_snapshots_immutable_update
BEFORE UPDATE ON scope_snapshots
BEGIN
  SELECT RAISE(ABORT, 'scope_snapshots are immutable: record a new snapshot instead');
END;

CREATE TRIGGER scope_snapshots_immutable_delete
BEFORE DELETE ON scope_snapshots
BEGIN
  SELECT RAISE(ABORT, 'scope_snapshots are immutable and retained for history');
END;
`;

const MIGRATION_3_EXECUTION_CANDIDATES_AND_EVIDENCE = `
CREATE TABLE jobs (
  job_id                  TEXT PRIMARY KEY,
  work_item_id            TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  project_id              TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  scope_snapshot_id       TEXT NOT NULL REFERENCES scope_snapshots(scope_snapshot_id) ON DELETE RESTRICT,
  profile_version_id      TEXT NOT NULL REFERENCES project_profile_versions(profile_version_id) ON DELETE RESTRICT,
  procedure_version_id    TEXT NOT NULL REFERENCES procedure_versions(procedure_version_id) ON DELETE RESTRICT,
  mode                    TEXT NOT NULL ${sqlEnum('mode', JOB_MODE_VALUES)},
  state                   TEXT NOT NULL DEFAULT 'Queued' ${sqlEnum('state', ATTEMPT_STATE_VALUES)},
  operation_id            TEXT NOT NULL UNIQUE,
  correlation_id          TEXT NOT NULL,
  permitted_operations    TEXT NOT NULL DEFAULT '[]',
  active_budget_ms        INTEGER CHECK (active_budget_ms IS NULL OR active_budget_ms > 0),
  max_attempts            INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts >= 0),
  attempt_count           INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  queued_at               TEXT NOT NULL,
  started_at              TEXT,
  finished_at             TEXT,
  heartbeat_at            TEXT,
  created_at              TEXT NOT NULL DEFAULT ${NOW},
  updated_at              TEXT NOT NULL DEFAULT ${NOW},
  CHECK (state NOT IN ('Preparing', 'Running', 'Verifying') OR started_at IS NOT NULL),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX jobs_by_state ON jobs(state, queued_at);
CREATE INDEX jobs_by_work_item ON jobs(work_item_id, created_at DESC);

CREATE TABLE attempts (
  attempt_id               TEXT PRIMARY KEY,
  job_id                   TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE RESTRICT,
  sequence                 INTEGER NOT NULL CHECK (sequence > 0),
  state                    TEXT NOT NULL ${sqlEnum('state', ATTEMPT_STATE_VALUES)},
  lease_holder_id          TEXT,
  lease_expires_at         TEXT,
  heartbeat_at             TEXT,
  process_pid              INTEGER CHECK (process_pid IS NULL OR process_pid > 0),
  process_registry_ref     TEXT,
  worktree_ref             TEXT,
  data_dir_ref             TEXT,
  checkpoint_json          TEXT,
  reconciliation_state     TEXT NOT NULL DEFAULT 'NotRequired'
                             CHECK (reconciliation_state IN ('NotRequired', 'Pending', 'Reconciled', 'Failed')),
  reconciled_at            TEXT,
  failure_category         TEXT,
  failure_detail_redacted  TEXT,
  started_at               TEXT,
  finished_at              TEXT,
  created_at               TEXT NOT NULL DEFAULT ${NOW},
  updated_at               TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (job_id, sequence),
  CHECK (state NOT IN ('Preparing', 'Running', 'Verifying') OR started_at IS NOT NULL),
  CHECK (state NOT IN ('Completed', 'Cancelled') OR finished_at IS NOT NULL),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX attempts_by_job ON attempts(job_id, sequence);
CREATE INDEX attempts_by_state ON attempts(state, heartbeat_at);

CREATE TABLE workspace_leases (
  lease_id              TEXT PRIMARY KEY,
  attempt_id            TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  slot                  TEXT NOT NULL DEFAULT 'GlobalCodingSlot',
  holder_id              TEXT NOT NULL,
  workspace_ref          TEXT NOT NULL,
  acquired_at            TEXT NOT NULL,
  heartbeat_at           TEXT,
  expires_at             TEXT NOT NULL,
  released_at            TEXT,
  reconciliation_state   TEXT NOT NULL DEFAULT 'NotRequired'
                           CHECK (reconciliation_state IN ('NotRequired', 'Pending', 'Reconciled', 'Failed')),
  reconciled_at          TEXT,
  created_at             TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (attempt_id, slot),
  CHECK (released_at IS NULL OR expires_at > acquired_at)
);
CREATE UNIQUE INDEX workspace_leases_single_coding_slot
  ON workspace_leases(slot) WHERE released_at IS NULL;

CREATE TABLE attempt_resources (
  resource_id   TEXT PRIMARY KEY,
  attempt_id    TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL
                  CHECK (kind IN ('Worktree', 'DataDirectory', 'Port', 'BrowserStorage', 'ProcessRegistry', 'CredentialBroker')),
  resource_ref  TEXT NOT NULL,
  port          INTEGER CHECK (port IS NULL OR (port > 0 AND port < 65536)),
  released_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (attempt_id, kind, resource_ref),
  CHECK (kind <> 'Port' OR port IS NOT NULL)
);
CREATE UNIQUE INDEX attempt_resources_single_owner_port
  ON attempt_resources(port) WHERE kind = 'Port' AND released_at IS NULL;

CREATE TABLE external_operations (
  operation_id     TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  work_item_id     TEXT REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  attempt_id       TEXT REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  kind             TEXT NOT NULL
                     CHECK (kind IN ('PublishIssue', 'CreateBranch', 'CreateDraft', 'UpdateIssue',
                                     'Merge', 'Deploy', 'Release', 'Redeploy')),
  target_identity  TEXT NOT NULL,
  expected_refs    TEXT,
  state            TEXT NOT NULL DEFAULT 'Planned'
                     CHECK (state IN ('Planned', 'InFlight', 'Succeeded', 'Failed', 'OutcomeUnknown')),
  correlation_id   TEXT NOT NULL,
  requested_at     TEXT NOT NULL,
  settled_at       TEXT,
  unknown_since    TEXT,
  result_json      TEXT,
  created_at       TEXT NOT NULL DEFAULT ${NOW},
  updated_at       TEXT NOT NULL DEFAULT ${NOW},
  CHECK (state <> 'OutcomeUnknown' OR unknown_since IS NOT NULL),
  CHECK (state NOT IN ('Succeeded', 'Failed') OR settled_at IS NOT NULL)
);

CREATE TABLE candidates (
  candidate_id          TEXT PRIMARY KEY,
  work_item_id          TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  project_id            TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  attempt_id            TEXT REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  scope_snapshot_id     TEXT NOT NULL REFERENCES scope_snapshots(scope_snapshot_id) ON DELETE RESTRICT,
  profile_version_id    TEXT NOT NULL REFERENCES project_profile_versions(profile_version_id) ON DELETE RESTRICT,
  procedure_version_id  TEXT NOT NULL REFERENCES procedure_versions(procedure_version_id) ON DELETE RESTRICT,
  fingerprint           TEXT NOT NULL UNIQUE,
  head_sha              TEXT NOT NULL ${commitShaCheck('head_sha')},
  base_sha              TEXT NOT NULL ${commitShaCheck('base_sha')},
  scope_fingerprint     TEXT NOT NULL ${fingerprintCheck('scope_fingerprint')},
  environment_fingerprint TEXT NOT NULL ${fingerprintCheck('environment_fingerprint')},
  policy_fingerprint    TEXT NOT NULL ${fingerprintCheck('policy_fingerprint')},
  pull_request_id       TEXT,
  created_at            TEXT NOT NULL DEFAULT ${NOW},
  superseded_at         TEXT
);
CREATE INDEX candidates_by_work_item ON candidates(work_item_id, created_at DESC);
CREATE INDEX candidates_by_fingerprint ON candidates(fingerprint);

CREATE TABLE candidate_components (
  candidate_id   TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  component      TEXT NOT NULL,
  deployment_id  TEXT,
  deployment_url TEXT,
  environment    TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (candidate_id, component)
);

CREATE TABLE candidate_artifacts (
  artifact_id  TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  kind         TEXT NOT NULL
                 CHECK (kind IN ('WorktreeDiff', 'BuildLog', 'CheckOutput', 'BrowserEvidence', 'ApiEvidence', 'SmokeEvidence', 'Bundle')),
  artifact_ref TEXT NOT NULL,
  byte_size    INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  created_at   TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (candidate_id, kind, artifact_ref)
);

CREATE TABLE checks (
  check_id                          TEXT PRIMARY KEY,
  candidate_id                      TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  work_item_id                      TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  project_id                        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  candidate_fingerprint             TEXT NOT NULL ${fingerprintCheck('candidate_fingerprint')},
  name                              TEXT NOT NULL,
  origin                            TEXT NOT NULL ${sqlEnum('origin', CHECK_ORIGIN_VALUES)},
  required                          INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  result                            TEXT NOT NULL ${sqlEnum('result', CHECK_RESULT_VALUES)},
  not_applicable_approved_by_policy INTEGER NOT NULL DEFAULT 0 CHECK (not_applicable_approved_by_policy IN (0, 1)),
  started_at                        TEXT NOT NULL,
  ended_at                          TEXT,
  exit_code                         INTEGER,
  artifact_ref                      TEXT,
  detail_redacted                   TEXT,
  created_at                        TEXT NOT NULL DEFAULT ${NOW},
  updated_at                        TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (candidate_id, name, started_at),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (result <> 'NotApplicable' OR not_applicable_approved_by_policy = 1),
  CHECK (result = 'NotApplicable' OR not_applicable_approved_by_policy = 0)
);
CREATE INDEX checks_by_candidate_fingerprint ON checks(candidate_fingerprint, name);
CREATE INDEX checks_by_candidate ON checks(candidate_id, name);
CREATE INDEX checks_required_by_candidate ON checks(candidate_id, result) WHERE required = 1;

CREATE TABLE evidence (
  evidence_id           TEXT PRIMARY KEY,
  candidate_id          TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  work_item_id          TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  project_id            TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  check_id              TEXT REFERENCES checks(check_id) ON DELETE RESTRICT,
  candidate_fingerprint TEXT NOT NULL ${fingerprintCheck('candidate_fingerprint')},
  scope_fingerprint     TEXT NOT NULL ${fingerprintCheck('scope_fingerprint')},
  criterion_id          TEXT NOT NULL,
  method_kind           TEXT NOT NULL ${sqlEnum('method_kind', EVIDENCE_METHOD_VALUES)},
  status                TEXT NOT NULL ${sqlEnum('status', CRITERION_STATUS_VALUES)},
  artifact_ref          TEXT,
  detail_redacted       TEXT,
  observed_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT ${NOW},
  updated_at            TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (candidate_id, criterion_id, method_kind, candidate_fingerprint),
  CHECK (status <> 'Verified' OR observed_at IS NOT NULL),
  CHECK ((method_kind = 'AutomatedCheck') = (check_id IS NOT NULL))
);
CREATE INDEX evidence_by_candidate_fingerprint ON evidence(candidate_fingerprint, status);
CREATE INDEX evidence_by_work_item ON evidence(work_item_id, status);
`;

const MIGRATION_4_DELIVERY_ATTENTION_AND_EVENTS = `
CREATE TABLE owner_decisions (
  decision_id                  TEXT PRIMARY KEY,
  project_id                   TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  work_item_id                 TEXT REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  candidate_id                 TEXT REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  scope_snapshot_id            TEXT REFERENCES scope_snapshots(scope_snapshot_id) ON DELETE RESTRICT,
  actor_owner_id               TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE RESTRICT,
  decision_type                TEXT NOT NULL
                                CHECK (decision_type IN ('AcceptProduct', 'RequestChanges', 'AuthorizeMerge', 'AuthorizeRelease', 'AuthorizeMergeAndRelease', 'AuthorizeRecovery', 'ResolveScopeChange')),
  acceptance_state             TEXT ${nullableEnum('acceptance_state', ACCEPTANCE_STATE_VALUES)},
  subject_fingerprint          TEXT NOT NULL ${fingerprintCheck('subject_fingerprint')},
  subject_json                 TEXT NOT NULL,
  feedback_redacted            TEXT,
  correlation_id               TEXT NOT NULL,
  state                        TEXT NOT NULL DEFAULT 'Recorded'
                                CHECK (state IN ('Recorded', 'Consumed', 'Invalidated', 'Superseded')),
  single_use                   INTEGER NOT NULL DEFAULT 1 CHECK (single_use = 1),
  decided_at                   TEXT NOT NULL,
  consumed_at                  TEXT,
  invalidated_at               TEXT,
  invalidation_reason_redacted TEXT,
  expires_at                   TEXT,
  created_at                   TEXT NOT NULL DEFAULT ${NOW},
  CHECK (candidate_id IS NOT NULL OR scope_snapshot_id IS NOT NULL),
  CHECK (decision_type IN ('AcceptProduct', 'RequestChanges') OR acceptance_state IS NULL),
  CHECK (decision_type NOT IN ('AcceptProduct', 'RequestChanges') OR acceptance_state IS NOT NULL),
  CHECK (state <> 'Consumed' OR consumed_at IS NOT NULL),
  CHECK (state <> 'Invalidated' OR (invalidated_at IS NOT NULL AND invalidation_reason_redacted IS NOT NULL))
);
CREATE INDEX owner_decisions_by_candidate ON owner_decisions(candidate_id, decided_at DESC);
CREATE INDEX owner_decisions_by_work_item ON owner_decisions(work_item_id, decided_at DESC);
CREATE INDEX owner_decisions_unconsumed ON owner_decisions(candidate_id) WHERE state = 'Recorded';

CREATE TABLE deliveries (
  delivery_id             TEXT PRIMARY KEY,
  work_item_id            TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  project_id              TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  candidate_id            TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  decision_id             TEXT NOT NULL UNIQUE REFERENCES owner_decisions(decision_id) ON DELETE RESTRICT,
  operation_id            TEXT REFERENCES external_operations(operation_id) ON DELETE RESTRICT,
  state                   TEXT NOT NULL DEFAULT 'NotAuthorized' ${sqlEnum('state', DELIVERY_STATE_VALUES)},
  correlation_id          TEXT NOT NULL,
  manifest_json           TEXT NOT NULL,
  pull_request_id         TEXT,
  head_sha                TEXT NOT NULL ${commitShaCheck('head_sha')},
  target_branch           TEXT NOT NULL,
  unknown_since           TEXT,
  merged_at               TEXT,
  released_at             TEXT,
  failed_at               TEXT,
  failure_detail_redacted TEXT,
  created_at              TEXT NOT NULL DEFAULT ${NOW},
  updated_at              TEXT NOT NULL DEFAULT ${NOW},
  CHECK (state <> 'OutcomeUnknown' OR unknown_since IS NOT NULL),
  CHECK (state <> 'Failed' OR failed_at IS NOT NULL)
);
CREATE INDEX deliveries_by_state ON deliveries(state, created_at);
CREATE INDEX deliveries_by_work_item ON deliveries(work_item_id, created_at DESC);

CREATE TABLE delivery_components (
  delivery_id    TEXT NOT NULL REFERENCES deliveries(delivery_id) ON DELETE RESTRICT,
  component      TEXT NOT NULL,
  deployment_id  TEXT,
  deployment_url TEXT,
  environment    TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'NotAuthorized' ${sqlEnum('state', DELIVERY_STATE_VALUES)},
  created_at     TEXT NOT NULL DEFAULT ${NOW},
  updated_at     TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (delivery_id, component)
);

CREATE TABLE live_smoke_results (
  smoke_id              TEXT PRIMARY KEY,
  delivery_id           TEXT NOT NULL REFERENCES deliveries(delivery_id) ON DELETE RESTRICT,
  component             TEXT NOT NULL,
  candidate_fingerprint TEXT NOT NULL ${fingerprintCheck('candidate_fingerprint')},
  result                TEXT NOT NULL ${sqlEnum('result', CHECK_RESULT_VALUES)},
  artifact_ref         TEXT,
  detail_redacted      TEXT,
  observed_at          TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (delivery_id, component, observed_at)
);
CREATE INDEX live_smoke_results_by_delivery ON live_smoke_results(delivery_id);

CREATE TABLE release_receipts (
  receipt_id              TEXT PRIMARY KEY,
  delivery_id               TEXT NOT NULL UNIQUE REFERENCES deliveries(delivery_id) ON DELETE RESTRICT,
  project_id                TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  work_item_id              TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  candidate_id              TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  merge_sha                 TEXT CHECK (merge_sha IS NULL OR length(merge_sha) IN (40, 64)),
  provider_release_id       TEXT,
  provider_deployment_ids   TEXT,
  issue_closed_at           TEXT,
  receipt_json              TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  finalized_at              TEXT,
  CHECK (finalized_at IS NULL OR finalized_at >= created_at)
);
CREATE INDEX release_receipts_by_work_item ON release_receipts(work_item_id, created_at DESC);

CREATE TABLE history_links (
  history_link_id TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  work_item_id    TEXT REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  subject_kind    TEXT NOT NULL
                    CHECK (subject_kind IN ('ScopeRevision', 'Job', 'Attempt', 'InboxEvent', 'OutboxEvent', 'Evidence', 'OwnerFeedback', 'Authorization', 'Merge', 'Release', 'Restore')),
  subject_id      TEXT NOT NULL,
  actor           TEXT NOT NULL,
  correlation_id  TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  detail_redacted TEXT,
  UNIQUE (subject_kind, subject_id, occurred_at)
);
CREATE INDEX history_links_by_work_item ON history_links(work_item_id, occurred_at DESC);
CREATE INDEX history_links_by_project ON history_links(project_id, occurred_at DESC);

CREATE TABLE attention_items (
  attention_item_id     TEXT PRIMARY KEY,
  dedup_key             TEXT NOT NULL UNIQUE,
  project_id            TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  work_item_id          TEXT REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  kind                  TEXT NOT NULL ${sqlEnum('kind', ATTENTION_KIND_VALUES)},
  state                 TEXT NOT NULL DEFAULT 'Open' ${sqlEnum('state', ATTENTION_STATE_VALUES)},
  issue_identifier      TEXT,
  title                 TEXT NOT NULL,
  blocker               TEXT,
  next_action           TEXT NOT NULL,
  candidate_fingerprint TEXT CHECK (candidate_fingerprint IS NULL OR ${fingerprintCondition('candidate_fingerprint')}),
  created_at            TEXT NOT NULL DEFAULT ${NOW},
  updated_at            TEXT NOT NULL DEFAULT ${NOW},
  acknowledged_at       TEXT,
  acknowledged_by       TEXT,
  CHECK (length(trim(next_action)) > 0),
  CHECK (state <> 'Acknowledged' OR (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)),
  CHECK (state <> 'Resolved' OR acknowledged_at IS NULL)
);
CREATE INDEX attention_items_open ON attention_items(state, created_at) WHERE state <> 'Resolved';
CREATE INDEX attention_items_open_by_project ON attention_items(project_id, created_at) WHERE state <> 'Resolved';

CREATE TABLE inbox_events (
  inbox_event_id   TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  delivery_id      TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  dedup_key        TEXT NOT NULL UNIQUE,
  payload_digest   TEXT NOT NULL,
  payload_redacted TEXT,
  correlation_id   TEXT NOT NULL,
  received_at      TEXT NOT NULL,
  processing_state TEXT NOT NULL DEFAULT 'Received'
                     CHECK (processing_state IN ('Received', 'Processing', 'Processed', 'Ignored', 'Failed')),
  attempt_count    INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  processed_at     TEXT,
  reconciled_at    TEXT,
  last_error_redacted TEXT,
  created_at       TEXT NOT NULL DEFAULT ${NOW},
  updated_at       TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (provider, delivery_id, event_type),
  CHECK (processing_state NOT IN ('Processed', 'Ignored') OR processed_at IS NOT NULL)
);
CREATE INDEX inbox_events_by_delivery ON inbox_events(provider, delivery_id);
CREATE INDEX inbox_events_unprocessed ON inbox_events(received_at) WHERE processing_state IN ('Received', 'Failed');

CREATE TABLE outbox_events (
  outbox_event_id      TEXT PRIMARY KEY,
  project_id           TEXT REFERENCES projects(project_id) ON DELETE RESTRICT,
  work_item_id         TEXT REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  event_kind           TEXT NOT NULL,
  dedup_key            TEXT NOT NULL UNIQUE,
  payload_json         TEXT NOT NULL,
  state                TEXT NOT NULL DEFAULT 'Pending'
                        CHECK (state IN ('Pending', 'Publishing', 'Published', 'Failed', 'Abandoned')),
  correlation_id       TEXT NOT NULL,
  attempt_count        INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at      TEXT,
  published_at         TEXT,
  last_error_redacted  TEXT,
  created_at           TEXT NOT NULL DEFAULT ${NOW},
  updated_at           TEXT NOT NULL DEFAULT ${NOW},
  CHECK (state <> 'Published' OR published_at IS NOT NULL)
);
CREATE INDEX outbox_events_by_state ON outbox_events(state, next_attempt_at);

CREATE TABLE audit_log (
  audit_id       TEXT PRIMARY KEY,
  project_id     TEXT REFERENCES projects(project_id) ON DELETE RESTRICT,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL,
  subject_kind   TEXT,
  subject_id     TEXT,
  correlation_id TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  detail_json    TEXT,
  created_at     TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX audit_log_by_project ON audit_log(project_id, occurred_at DESC);
CREATE INDEX audit_log_by_subject ON audit_log(subject_kind, subject_id);
`;

/**
 * Repository alignment.
 *
 * `migrations.ts` and `repositories/core.ts` were authored independently and
 * disagreed on every table name: the schema created plural tables (`owners`,
 * `connectors`, ...) while the repositories read and wrote singular ones
 * (`owner`, `connector`, ...). Every application use case therefore failed with
 * "no such table", and the repository suite passed only because it created its
 * own inline fixture schema instead of calling `migrate`.
 *
 * This migration resolves the disagreement in ONE direction. `migrations.ts` is
 * the schema authority, so the plural table names stay and the repositories were
 * rewritten against them; this migration supplies the columns those repositories
 * read and write which the earlier migrations did not yet carry.
 *
 * Nothing here weakens an existing invariant. Every CHECK, trigger, foreign key
 * and unique index from versions 1-4 is untouched: the new columns are added
 * beside them, and the tables that do not exist yet are created with the same
 * constraints the corresponding code already relied on. The singular tables the
 * old fixture schema invented (`job`, `coding_slot`, `writer_lease`, ...) were
 * never part of the migrated schema, so they are added here under the plural
 * convention rather than left as per-test fiction.
 *
 * `ALTER TABLE ADD COLUMN` is used throughout because it is the only schema
 * change that keeps existing foreign keys pointing at the rebuilt definition.
 * A `CREATE`/`INSERT`/`DROP`/`RENAME` rebuild cannot be used here: SQLite
 * re-validates every referencing row against the dropped table, so a rebuild of
 * a referenced table such as `candidates` or `evidence` fails inside the
 * transaction this runner wraps each migration in. Added columns carry the same
 * CHECK constraints the original definitions did, so an abbreviated commit SHA
 * or a malformed fingerprint is still refused.
 */
const MIGRATION_5_REPOSITORY_ALIGNMENT = `
-- Owner credentials (F01-AC1). Only the domain's self-describing digest is
-- stored, never the password, and the address is unique because it is the
-- sign-in identity. The session table below keeps a digest of the session token
-- for the same reason (F01-AC2).
ALTER TABLE owners ADD COLUMN email TEXT;
ALTER TABLE owners ADD COLUMN password_digest TEXT;
CREATE UNIQUE INDEX owners_by_email ON owners(email) WHERE email IS NOT NULL;

-- Sessions (F01-AC2). 'token_hash' holds a SHA-256 digest, never the token, and
-- 'rotated_from_session_id' preserves the rotation chain so a rotation can be
-- audited instead of looking like two unrelated sessions (F32-AC1).
ALTER TABLE sessions ADD COLUMN token_hash TEXT;
ALTER TABLE sessions ADD COLUMN rotated_from_session_id TEXT;
CREATE UNIQUE INDEX sessions_by_token_hash ON sessions(token_hash) WHERE token_hash IS NOT NULL;

-- Project profile versions (F02-AC3). The content is the canonical document the
-- repository hashes, so 'content_fingerprint' carries the same fingerprint CHECK
-- as a candidate identity and a truncated value is refused at the column.
ALTER TABLE project_profile_versions ADD COLUMN version_number INTEGER;
ALTER TABLE project_profile_versions ADD COLUMN supersedes_version_id TEXT REFERENCES project_profile_versions(profile_version_id);
ALTER TABLE project_profile_versions ADD COLUMN content_json TEXT;
ALTER TABLE project_profile_versions ADD COLUMN content_fingerprint TEXT ${fingerprintCheck('content_fingerprint')};
ALTER TABLE project_profile_versions ADD COLUMN note TEXT;
ALTER TABLE project_profile_versions ADD COLUMN created_by TEXT;

-- Connectors (F03-AC3). The credential column holds a reference and its digest
-- only; the CHECK on 'credential_ref' is unchanged and the new digest column is
-- what an export uses to prove which reference a row used.
ALTER TABLE connectors ADD COLUMN credential_reference TEXT;
ALTER TABLE connectors ADD COLUMN credential_reference_digest TEXT;
ALTER TABLE connectors ADD COLUMN capability_json TEXT;
ALTER TABLE connectors ADD COLUMN state TEXT CHECK (state IN ('Unconfigured', 'Healthy', 'Degraded', 'Revoked', 'Unreachable'));
ALTER TABLE connectors ADD COLUMN error TEXT;
ALTER TABLE connectors ADD COLUMN last_checked_at TEXT;
ALTER TABLE connectors ADD COLUMN last_success_at TEXT;

-- Procedure and fact versions (F05-AC1, F05-AC4). 'status' keeps the CHECK so a
-- proposed improvement stays visible to the owner while remaining invisible to a
-- run; 'content' carries the document the repository fingerprints, and the
-- approval timestamp column already exists as 'approved_at', which the
-- repository writes for both an approval and an acceptance.
ALTER TABLE procedure_versions ADD COLUMN subject_key TEXT;
ALTER TABLE procedure_versions ADD COLUMN version_number INTEGER;
ALTER TABLE procedure_versions ADD COLUMN scope TEXT;
ALTER TABLE procedure_versions ADD COLUMN source_revision TEXT;
ALTER TABLE procedure_versions ADD COLUMN content TEXT;
ALTER TABLE procedure_versions ADD COLUMN status TEXT CHECK (status IN ('Proposed', 'Accepted', 'Superseded', 'Retired'));
ALTER TABLE procedure_versions ADD COLUMN last_verified_revision TEXT;
ALTER TABLE procedure_versions ADD COLUMN last_verified_at TEXT;
ALTER TABLE procedure_versions ADD COLUMN created_by TEXT;
ALTER TABLE procedure_versions ADD COLUMN note TEXT;

-- Raw intake (F06-AC1). 'open_questions' holds canonical JSON; 'raw_request'
-- keeps its own CHECK and is never written by any repository method. The state
-- column already exists, so the repository adopts this vocabulary rather than
-- adding a second one: Received -> Clarifying -> Planned -> Published, with
-- Abandoned for intake the owner deferred (F06-AC5).
ALTER TABLE ideas ADD COLUMN kind TEXT;
ALTER TABLE ideas ADD COLUMN notes TEXT;
ALTER TABLE ideas ADD COLUMN bug_expected TEXT;
ALTER TABLE ideas ADD COLUMN bug_actual TEXT;
ALTER TABLE ideas ADD COLUMN bug_reproduction TEXT;
ALTER TABLE ideas ADD COLUMN generated_summary TEXT;
ALTER TABLE ideas ADD COLUMN agreed_brief TEXT;
ALTER TABLE ideas ADD COLUMN open_questions TEXT;
ALTER TABLE ideas ADD COLUMN published_work_item_id TEXT REFERENCES work_items(work_item_id);
ALTER TABLE ideas ADD COLUMN archived_at TEXT;
ALTER TABLE ideas ADD COLUMN archived_reason TEXT;

-- Attachments (F06-AC1). The row carries a name, a size and a digest; the bytes
-- live in the artifact directory under 'relative_path'.
ALTER TABLE idea_attachments ADD COLUMN media_type TEXT;
ALTER TABLE idea_attachments ADD COLUMN content_digest TEXT;
ALTER TABLE idea_attachments ADD COLUMN relative_path TEXT;

-- Work mapping (F10). 'publication_state' is the provider OBSERVATION and is a
-- separate column from 'publication_intent', which records the owner's DECISION,
-- so an intent to publish can never be read as a confirmed ticket (R1, F10-AC1,
-- F12-AC5). 'profile_version_id' records the inputs a run was started from, and
-- 'title' already exists so the repository writes that column directly. The
-- intent column's own vocabulary is corrected by the rebuild below.
ALTER TABLE work_items ADD COLUMN profile_version_id TEXT REFERENCES project_profile_versions(profile_version_id);
ALTER TABLE work_items ADD COLUMN source TEXT;
ALTER TABLE work_items ADD COLUMN external_issue_id TEXT;
ALTER TABLE work_items ADD COLUMN external_issue_identifier TEXT;
ALTER TABLE work_items ADD COLUMN external_issue_url TEXT;
ALTER TABLE work_items ADD COLUMN publication_state TEXT CHECK (publication_state IN ('Unpublished', 'Publishing', 'Published', 'OutcomeUnknown', 'NotPublishing'));
ALTER TABLE work_items ADD COLUMN publication_operation_id TEXT;
ALTER TABLE work_items ADD COLUMN related_work_item_ids TEXT;
ALTER TABLE work_items ADD COLUMN adoption_json TEXT;
CREATE UNIQUE INDEX work_items_by_external_issue ON work_items(external_issue_id) WHERE external_issue_id IS NOT NULL;

-- External sync state (F16-AC4). A failed update is a labelled pending state
-- with its last success time, not a silent retry.
CREATE TABLE work_item_syncs (
  work_item_id     TEXT PRIMARY KEY REFERENCES work_items(work_item_id) ON DELETE CASCADE,
  state            TEXT NOT NULL CHECK (state IN ('NeverAttempted', 'InSync', 'PendingSync', 'Failed')),
  last_attempt_at  TEXT,
  last_success_at  TEXT,
  attempt_count    INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error       TEXT
);

-- Scope snapshots (F12-AC1). The immutability triggers installed in version 2
-- still abort UPDATE and DELETE; the added columns carry the run context the
-- repository stores alongside the fingerprint.
ALTER TABLE scope_snapshots ADD COLUMN sequence_number INTEGER;
ALTER TABLE scope_snapshots ADD COLUMN attempt_id TEXT REFERENCES attempts(attempt_id);
ALTER TABLE scope_snapshots ADD COLUMN dependency_issue_ids TEXT;
ALTER TABLE scope_snapshots ADD COLUMN acceptance_criteria TEXT;
ALTER TABLE scope_snapshots ADD COLUMN profile_version_id TEXT REFERENCES project_profile_versions(profile_version_id);
ALTER TABLE scope_snapshots ADD COLUMN procedure_version_id TEXT REFERENCES procedure_versions(procedure_version_id);
ALTER TABLE scope_snapshots ADD COLUMN captured_at TEXT;
ALTER TABLE scope_snapshots ADD COLUMN correlation_id TEXT;
CREATE UNIQUE INDEX scope_snapshots_by_work_item_sequence ON scope_snapshots(work_item_id, sequence_number)
  WHERE sequence_number IS NOT NULL;

-- Attention items (F31-AC3). 'occurrence_count' and 'first_observed_at' are
-- storage-only bookkeeping so a repeated event can be counted without changing
-- what the dashboard reads.
ALTER TABLE attention_items ADD COLUMN occurrence_count INTEGER;
ALTER TABLE attention_items ADD COLUMN first_observed_at TEXT;

-- Candidates (F20-AC3, F24-AC4). The identity stays decomposed into the
-- schema's own CHECK-constrained columns, so the commit-SHA length CHECK is
-- what actually refuses an abbreviated head (R4). The repository reads those
-- columns back into the domain CandidateIdentity and computes the fingerprint
-- from them, never accepting one from the caller.
ALTER TABLE candidates ADD COLUMN target_branch TEXT;
ALTER TABLE candidates ADD COLUMN recorded_at TEXT;
ALTER TABLE candidates ADD COLUMN correlation_id TEXT;

-- Evidence (F20-AC3, F25-AC3). 'candidate_fingerprint' already exists with its
-- fingerprint CHECK and stays the binding: every read filters on it, so a
-- changed candidate cannot inherit the previous build's results. The result
-- vocabulary is the domain CHECK_RESULTS, so a check outcome recorded here is
-- one the domain recognises.
ALTER TABLE evidence ADD COLUMN kind TEXT;
ALTER TABLE evidence ADD COLUMN check_name TEXT;
ALTER TABLE evidence ADD COLUMN result TEXT ${sqlEnum('result', CHECK_RESULT_VALUES)};
ALTER TABLE evidence ADD COLUMN environment_fingerprint TEXT;
ALTER TABLE evidence ADD COLUMN recorded_at TEXT;
ALTER TABLE evidence ADD COLUMN correlation_id TEXT;

-- Owner decisions (F25, F26-AC1, F27-AC3). 'single_use' stays fixed at 1 and
-- 'consume' still refuses a second use, so a replayed request cannot merge
-- twice. Attribution and the subject-binding CHECK are added by the rebuild
-- below: a decision names a real owner, and only an authorization carries a
-- subject fingerprint (R3).
ALTER TABLE owner_decisions ADD COLUMN candidate_fingerprint TEXT ${fingerprintCheck('candidate_fingerprint')};
ALTER TABLE owner_decisions ADD COLUMN scope_fingerprint TEXT ${fingerprintCheck('scope_fingerprint')};
ALTER TABLE owner_decisions ADD COLUMN note TEXT;
ALTER TABLE owner_decisions ADD COLUMN invalidated_reason TEXT;

-- The durable job queue (F13, F17). 'jobs.operation_id' is already UNIQUE, so a
-- repeated start with one operation identity cannot create a second job, and the
-- state CHECK from version 3 is unchanged.
ALTER TABLE jobs ADD COLUMN limits TEXT;
ALTER TABLE jobs ADD COLUMN holder TEXT;
ALTER TABLE jobs ADD COLUMN last_heartbeat_at TEXT;

-- The durable resume point (F17-AC2). Head and base are full commit SHAs, so
-- both columns keep a length CHECK: an abbreviation cannot be compared to a
-- checkout, and the dirty plus untracked inventory is part of the resume point.
CREATE TABLE job_checkpoints (
  job_id               TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
  checkpoint_id        TEXT NOT NULL,
  scope_snapshot_id    TEXT NOT NULL,
  scope_fingerprint    TEXT NOT NULL ${fingerprintCheck('scope_fingerprint')},
  profile_version_id   TEXT NOT NULL,
  procedure_version_id TEXT NOT NULL,
  engine_version       TEXT,
  workspace_id         TEXT NOT NULL,
  branch_name          TEXT NOT NULL,
  worktree_path        TEXT NOT NULL,
  head_sha             TEXT NOT NULL ${commitShaCheck('head_sha')},
  base_sha             TEXT NOT NULL ${commitShaCheck('base_sha')},
  dirty_files          TEXT NOT NULL,
  untracked_files      TEXT NOT NULL,
  results              TEXT NOT NULL,
  feedback             TEXT NOT NULL,
  blocker              TEXT,
  next_action          TEXT NOT NULL,
  recorded_at          TEXT NOT NULL,
  CHECK (length(trim(next_action)) > 0)
);

-- The single global coding writer (F13-AC2, F17-AC5). The slot row is a
-- singleton, so exactly one writer exists; a claim that loses the conditional
-- UPDATE stays queued rather than failing.
CREATE TABLE coding_slots (
  slot_id      INTEGER PRIMARY KEY CHECK (slot_id = 1),
  job_id       TEXT,
  holder       TEXT,
  operation_id TEXT,
  acquired_at  TEXT,
  expires_at   TEXT,
  generation   INTEGER NOT NULL DEFAULT 0
);
INSERT INTO coding_slots (slot_id, generation) VALUES (1, 0);

-- Writer ownership per job (F17-AC5). An expired lease is 'ReconciliationRequired'
-- and grants nothing: expiry proves only that heartbeats stopped.
CREATE TABLE writer_leases (
  lease_id                    TEXT PRIMARY KEY,
  job_id                      TEXT NOT NULL UNIQUE REFERENCES jobs(job_id) ON DELETE CASCADE,
  holder                      TEXT NOT NULL,
  operation_id                TEXT NOT NULL,
  acquired_at                 TEXT NOT NULL,
  renewed_at                  TEXT NOT NULL,
  expires_at                  TEXT NOT NULL,
  state                       TEXT NOT NULL
                                 CHECK (state IN ('Active', 'Released', 'ReconciliationRequired', 'HolderStoppedConfirmed')),
  reconciliation_required     INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_required IN (0, 1)),
  reconciliation_reason       TEXT,
  confirmed_stopped_by        TEXT,
  confirmed_stopped_at        TEXT,
  confirmed_stopped_evidence  TEXT,
  CHECK (expires_at > acquired_at),
  CHECK (state <> 'HolderStoppedConfirmed' OR confirmed_stopped_by IS NOT NULL)
);

-- Workspace isolation (F14-AC1, F14-AC3). A workspace belongs to one job, and a
-- port belongs to exactly one workspace, so a collision surfaces as a blocker
-- instead of silently attaching to an unrelated service.
CREATE TABLE workspace_locks (
  workspace_id  TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL,
  holder        TEXT NOT NULL,
  branch_name   TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  acquired_at   TEXT NOT NULL
);

CREATE TABLE workspace_ports (
  workspace_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  port         INTEGER NOT NULL CHECK (port > 0 AND port < 65536),
  job_id       TEXT NOT NULL,
  holder       TEXT NOT NULL,
  reserved_at  TEXT NOT NULL,
  PRIMARY KEY (workspace_id, service_name)
);
CREATE UNIQUE INDEX workspace_ports_unique_port ON workspace_ports(port);
`;
/**
 * Durable provider event ingest (F30-AC1, F30-AC2, F30-AC3).
 *
 * The payload bytes are stored as a BLOB, not a redacted copy: a recorded
 * delivery must be re-verifiable later over the exact bytes the signature was
 * checked against, which is the whole anti-forgery property of the ledger. The
 * 'occurred_at_ms' column exists beside 'occurred_at' so the newest-fact
 * comparison orders on an integer rather than on a re-parsed timestamp, and
 * 'sequence' breaks a tie on identical timestamps so exactly one event wins.
 *
 * 'correlation_id' already exists, so the ingest module writes that column
 * rather than adding a second one. The event identity is likewise the existing
 * 'inbox_event_id' rather than a new 'event_id' column, and an outbox effect is
 * an 'outbox_event_id'; the modules were updated to the schema's names instead.
 */
const MIGRATION_6_EVENT_LEDGER_ALIGNMENT = `
ALTER TABLE inbox_events ADD COLUMN type TEXT;
ALTER TABLE inbox_events ADD COLUMN occurred_at TEXT;
ALTER TABLE inbox_events ADD COLUMN occurred_at_ms INTEGER;
ALTER TABLE inbox_events ADD COLUMN recorded_at TEXT;
ALTER TABLE inbox_events ADD COLUMN sequence INTEGER;
ALTER TABLE inbox_events ADD COLUMN payload_bytes BLOB;
ALTER TABLE inbox_events ADD COLUMN processed_by TEXT;
CREATE UNIQUE INDEX inbox_events_by_event ON inbox_events(inbox_event_id, provider, delivery_id);
CREATE INDEX inbox_events_by_correlation ON inbox_events(provider, correlation_id, occurred_at_ms, sequence);

-- The transactional outbox (N01-AC3, F29-AC4). 'dedup_key' is UNIQUE, so
-- re-enqueueing the same intent returns the original effect instead of a second
-- one, and a published effect must carry its publish time. 'next_attempt_at'
-- already exists and is what the due set orders on.
ALTER TABLE outbox_events ADD COLUMN kind TEXT;
ALTER TABLE outbox_events ADD COLUMN target TEXT;
ALTER TABLE outbox_events ADD COLUMN payload TEXT;
ALTER TABLE outbox_events ADD COLUMN operation_id TEXT;
ALTER TABLE outbox_events ADD COLUMN status TEXT;
ALTER TABLE outbox_events ADD COLUMN last_success_at TEXT;
ALTER TABLE outbox_events ADD COLUMN last_failure_category TEXT;
ALTER TABLE outbox_events ADD COLUMN last_failure_detail TEXT;
ALTER TABLE outbox_events ADD COLUMN last_attempt_at TEXT;
ALTER TABLE outbox_events ADD COLUMN expected_refs TEXT;
ALTER TABLE outbox_events ADD COLUMN succeeded_refs TEXT;
CREATE INDEX outbox_events_by_operation ON outbox_events(operation_id);

-- The external side-effect ledger (F30-AC5, F28-AC4). Every external write is
-- bracketed by an intent row written before the call and an outcome row written
-- after it, so a lost response becomes 'OutcomeUnknown' and the next attempt
-- reconciles rather than writing again. 'expected_refs' already exists.
ALTER TABLE external_operations ADD COLUMN target TEXT;
ALTER TABLE external_operations ADD COLUMN status TEXT;
ALTER TABLE external_operations ADD COLUMN recorded_at TEXT;
ALTER TABLE external_operations ADD COLUMN outcome_at TEXT;
ALTER TABLE external_operations ADD COLUMN outcome_detail TEXT;
ALTER TABLE external_operations ADD COLUMN operation_ref TEXT;
`;

/**
 * Nullable project and issue identity.
 *
 * Two columns in versions 1 and 2 are `NOT NULL` where the product requires a
 * null: `ideas.project_id` because F06-AC1 captures intake with an *optional*
 * project, and `work_items.issue_id` because F10 separates the intent to publish
 * from a confirmed ticket, so a work item legitimately exists before any
 * provider issue does. A repository that could not write either state was
 * storing something other than the product.
 *
 * Relaxing a NOT NULL is not something `ALTER TABLE ADD COLUMN` can express,
 * and the obvious `CREATE`/`INSERT`/`DROP`/`RENAME` rebuild cannot be used
 * naively: SQLite re-validates every referencing row against the dropped table,
 * so the rebuild fails inside the transaction this runner wraps each migration
 * in. The sequence below therefore stashes the affected rows, empties the child
 * tables, rebuilds the parent, and restores everything, which is lossless and
 * leaves `PRAGMA foreign_key_check` empty.
 *
 * The child tables are discovered from `PRAGMA foreign_key_list` rather than
 * named by hand, because a hand-written list would silently miss a table added
 * later and a rebuild that drops rows is worse than one that refuses.
 *
 * The UNIQUE constraints and every CHECK are carried across unchanged; only the
 * `NOT NULL` markers on those two columns are removed, and the existing
 * `CHECK (length(trim(issue_id)) > 0)` is kept as a nullable variant so an empty
 * string is still refused while a genuinely absent issue is allowed.
 */
const MIGRATION_7_CONTRACT_ALIGNMENT = `
-- F06-AC1 captures intake with an OPTIONAL project, and F10 requires a work item
-- to exist before the provider has an issue for it, so 'ideas.project_id' and
-- 'work_items.issue_id' are nullable here. The 'length(trim(...)) > 0' CHECKs are
-- kept as nullable variants, so an empty string is still refused while a
-- genuinely absent project or issue is allowed.
CREATE TABLE ideas_nullable (
  idea_id              TEXT PRIMARY KEY,
  project_id           TEXT REFERENCES projects(project_id) ON DELETE RESTRICT,
  raw_request          TEXT NOT NULL,
  state                TEXT NOT NULL DEFAULT 'Received'
                         CHECK (state IN ('Received', 'Clarifying', 'Planned', 'Published', 'Abandoned')),
  created_at           TEXT NOT NULL DEFAULT ${NOW},
  updated_at           TEXT NOT NULL DEFAULT ${NOW},
  kind                 TEXT,
  notes                TEXT,
  bug_expected         TEXT,
  bug_actual           TEXT,
  bug_reproduction     TEXT,
  generated_summary    TEXT,
  agreed_brief         TEXT,
  open_questions       TEXT,
  published_work_item_id TEXT REFERENCES work_items(work_item_id),
  archived_at          TEXT,
  archived_reason      TEXT,
  CHECK (length(trim(raw_request)) > 0)
);

-- R2: the owner is provisioned locally and signs in with a password (F01-AC1), so
-- there is no identity-provider subject to record. The column stays, and stays
-- unique, because a future external identity must not be attached twice, but
-- 'provision' writes NULL rather than substituting the owner id: a column that
-- holds a value it does not mean is worse than an empty one (R2, ADR 0003).
CREATE TABLE owners_aligned (
  owner_id         TEXT PRIMARY KEY,
  identity_subject TEXT UNIQUE,
  display_name     TEXT,
  email            TEXT,
  password_digest  TEXT,
  created_at       TEXT NOT NULL DEFAULT ${NOW},
  CHECK (identity_subject IS NULL OR length(trim(identity_subject)) > 0)
);
CREATE UNIQUE INDEX owners_by_identity_subject ON owners_aligned(identity_subject)
  WHERE identity_subject IS NOT NULL;

-- R1: 'publication_intent' is the owner's DECISION and 'publication_state' is the
-- provider OBSERVATION. Keeping one column for each is what makes "we meant to
-- publish" impossible to read as "the ticket exists" (F10-AC1, F12-AC5). The
-- 'DraftPublish' and 'Adopted' values are dropped: 'Adopted' is an origin, and
-- 'origin' already carries it, so keeping it here would have been the second
-- vocabulary for one concept.
CREATE TABLE work_items_aligned (
  work_item_id           TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  idea_id                TEXT REFERENCES ideas(idea_id) ON DELETE SET NULL,
  issue_id               TEXT,
  issue_identifier       TEXT,
  title                  TEXT,
  publication_intent     TEXT NOT NULL
                           CHECK (publication_intent IN ('DoNotPublish', 'PublishWhenAgreed', 'Published')),
  origin                 TEXT NOT NULL CHECK (origin IN ('Proposed', 'Published', 'Adopted')),
  created_at             TEXT NOT NULL DEFAULT ${NOW},
  updated_at             TEXT NOT NULL DEFAULT ${NOW},
  profile_version_id     TEXT REFERENCES project_profile_versions(profile_version_id),
  source                 TEXT,
  external_issue_id      TEXT,
  external_issue_identifier TEXT,
  external_issue_url     TEXT,
  publication_state      TEXT
                           CHECK (publication_state IN ('Unpublished', 'Publishing', 'Published', 'OutcomeUnknown', 'NotPublishing')),
  publication_operation_id TEXT,
  related_work_item_ids  TEXT,
  adoption_json          TEXT,
  UNIQUE (project_id, issue_id),
  CHECK (issue_id IS NULL OR length(trim(issue_id)) > 0)
);

-- R3: an acceptance says the product behaviour is right and has no authorized
-- action to fingerprint; only an authorization does. The CHECK below makes that
-- exact: a subject fingerprint is required precisely for the authorization
-- decision types. This is stricter than the previous NOT NULL, which forced an
-- acceptance to invent a subject, while still refusing an authorization that
-- cannot be bound to one (F26-AC1, F27-AC3).
--
-- 'actor_owner_id' is a real foreign key, so a decision is always attributable
-- and an un-attributable decision is not representable (F32-AC1).
CREATE TABLE owner_decisions_aligned (
  decision_id                  TEXT PRIMARY KEY,
  project_id                   TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  work_item_id                 TEXT REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  candidate_id                 TEXT REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  scope_snapshot_id            TEXT REFERENCES scope_snapshots(scope_snapshot_id) ON DELETE RESTRICT,
  actor_owner_id               TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE RESTRICT,
  decision_type                TEXT NOT NULL
                                CHECK (decision_type IN ('AcceptProduct', 'RequestChanges', 'AuthorizeMerge', 'AuthorizeRelease', 'AuthorizeMergeAndRelease', 'AuthorizeRecovery', 'ResolveScopeChange')),
  acceptance_state             TEXT ${nullableEnum('acceptance_state', ACCEPTANCE_STATE_VALUES)},
  subject_fingerprint          TEXT ${nullableFingerprintCheck('subject_fingerprint')},
  subject_json                 TEXT NOT NULL,
  feedback_redacted            TEXT,
  correlation_id               TEXT NOT NULL,
  state                        TEXT NOT NULL DEFAULT 'Recorded'
                                CHECK (state IN ('Recorded', 'Consumed', 'Invalidated', 'Superseded')),
  single_use                   INTEGER NOT NULL DEFAULT 1 CHECK (single_use = 1),
  decided_at                   TEXT NOT NULL,
  consumed_at                  TEXT,
  invalidated_at               TEXT,
  invalidation_reason_redacted TEXT,
  expires_at                   TEXT,
  created_at                   TEXT NOT NULL DEFAULT ${NOW},
  candidate_fingerprint        TEXT ${nullableFingerprintCheck('candidate_fingerprint')},
  scope_fingerprint            TEXT ${nullableFingerprintCheck('scope_fingerprint')},
  note                         TEXT,
  invalidated_reason           TEXT,
  CHECK (candidate_id IS NOT NULL OR scope_snapshot_id IS NOT NULL),
  CHECK (decision_type IN ('AcceptProduct', 'RequestChanges') OR acceptance_state IS NULL),
  CHECK (decision_type NOT IN ('AcceptProduct', 'RequestChanges') OR acceptance_state IS NOT NULL),
  CHECK (state <> 'Consumed' OR consumed_at IS NOT NULL),
  CHECK (state <> 'Invalidated' OR (invalidated_at IS NOT NULL AND invalidation_reason_redacted IS NOT NULL)),
  CHECK (decision_type NOT IN ('AcceptProduct', 'RequestChanges') = (subject_fingerprint IS NOT NULL))
);

-- R4: the schema's own foreign keys stay. F13-AC1 requires a job to record the
-- work item, the scope snapshot, the profile version and the procedure version
-- before it is reported as accepted, so 'EnqueueRequest' was extended to carry
-- them rather than these constraints being relaxed (R4, ADR 0003).
CREATE TABLE jobs_aligned (
  job_id                  TEXT PRIMARY KEY,
  work_item_id            TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  project_id              TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  scope_snapshot_id       TEXT NOT NULL REFERENCES scope_snapshots(scope_snapshot_id) ON DELETE RESTRICT,
  profile_version_id      TEXT NOT NULL REFERENCES project_profile_versions(profile_version_id) ON DELETE RESTRICT,
  procedure_version_id    TEXT NOT NULL REFERENCES procedure_versions(procedure_version_id) ON DELETE RESTRICT,
  mode                    TEXT NOT NULL ${sqlEnum('mode', JOB_MODE_VALUES)},
  state                   TEXT NOT NULL DEFAULT 'Queued' ${sqlEnum('state', ATTEMPT_STATE_VALUES)},
  operation_id            TEXT NOT NULL UNIQUE,
  correlation_id          TEXT NOT NULL,
  permitted_operations    TEXT NOT NULL DEFAULT '[]',
  active_budget_ms        INTEGER CHECK (active_budget_ms IS NULL OR active_budget_ms > 0),
  max_attempts            INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts >= 0),
  attempt_count           INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  queued_at               TEXT NOT NULL,
  started_at              TEXT,
  finished_at             TEXT,
  heartbeat_at            TEXT,
  created_at              TEXT NOT NULL DEFAULT ${NOW},
  updated_at              TEXT NOT NULL DEFAULT ${NOW},
  limits                  TEXT,
  holder                  TEXT,
  last_heartbeat_at       TEXT,
  CHECK (state NOT IN ('Preparing', 'Running', 'Verifying') OR started_at IS NOT NULL),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);

-- The publication outbox (F16-AC4, F28-AC4, F29-AC4). 'OutcomeUnknown' belongs
-- in this vocabulary: a provider call whose response was lost must not stay
-- 'Pending', because the next attempt would then look like a first attempt and
-- publish a second receipt for work that may already be published. Migration 4
-- is already applied everywhere, so the widened state list is a rebuild here
-- rather than an edit to that migration.
CREATE TABLE outbox_events_aligned (
  outbox_event_id      TEXT PRIMARY KEY,
  project_id           TEXT REFERENCES projects(project_id) ON DELETE RESTRICT,
  work_item_id         TEXT REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  event_kind           TEXT NOT NULL,
  dedup_key            TEXT NOT NULL UNIQUE,
  payload_json         TEXT NOT NULL,
  state                TEXT NOT NULL DEFAULT 'Pending'
                          CHECK (state IN ('Pending', 'Publishing', 'Published', 'Failed', 'Abandoned',
                                           'OutcomeUnknown')),
  correlation_id       TEXT NOT NULL,
  attempt_count        INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at      TEXT,
  published_at         TEXT,
  last_error_redacted  TEXT,
  created_at           TEXT NOT NULL DEFAULT ${NOW},
  updated_at           TEXT NOT NULL DEFAULT ${NOW},
  kind                 TEXT,
  target               TEXT,
  payload              TEXT,
  operation_id         TEXT,
  status               TEXT,
  last_success_at      TEXT,
  last_failure_category TEXT,
  last_failure_detail  TEXT,
  last_attempt_at      TEXT,
  expected_refs        TEXT,
  succeeded_refs       TEXT,
  -- Table constraints come last: SQLite stops reading column definitions once a
  -- table-level constraint appears, so a CHECK in the middle silently turns the
  -- columns after it into a syntax error rather than a schema.
  CHECK (state <> 'Published' OR published_at IS NOT NULL)
);
CREATE INDEX outbox_events_aligned_by_state ON outbox_events_aligned(state, next_attempt_at);
CREATE INDEX outbox_events_aligned_by_operation ON outbox_events_aligned(operation_id);

-- The external side-effect ledger (F30-AC5, F28-AC4, F10-AC3, F19-AC3, F26-AC3,
-- F29-AC4). Every external write is bracketed by an intent row written before
-- the call and an outcome row written after it, so a lost response becomes
-- 'OutcomeUnknown' and the next attempt with the same operation identity finds
-- that row instead of issuing a second write.
--
-- The kind vocabulary covers the external writes the product actually performs:
-- a receipt publish and a managed progress comment are both 'UpdateIssue' to the
-- provider, but they are different intents and the ledger has to tell them
-- apart when reconciling (F16-AC4).
CREATE TABLE external_operations_aligned (
  operation_id     TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  work_item_id     TEXT REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  attempt_id       TEXT REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  kind             TEXT NOT NULL
                     CHECK (kind IN ('PublishIssue', 'CreateBranch', 'CreateDraft', 'UpdateIssue',
                                     'Merge', 'Deploy', 'Release', 'Redeploy',
                                     'PublishProposal', 'PullRequestCreate', 'CommentCreate',
                                     'ProgressComment', 'ReceiptPublish')),
  target_identity  TEXT NOT NULL,
  expected_refs    TEXT,
  state            TEXT NOT NULL DEFAULT 'Planned'
                     CHECK (state IN ('Planned', 'InFlight', 'Succeeded', 'Failed', 'OutcomeUnknown')),
  correlation_id   TEXT NOT NULL,
  requested_at     TEXT NOT NULL,
  settled_at       TEXT,
  unknown_since    TEXT,
  result_json      TEXT,
  created_at       TEXT NOT NULL DEFAULT ${NOW},
  updated_at       TEXT NOT NULL DEFAULT ${NOW},
  target           TEXT,
  status           TEXT,
  recorded_at      TEXT,
  outcome_at       TEXT,
  outcome_detail   TEXT,
  operation_ref    TEXT,
  CHECK (state <> 'OutcomeUnknown' OR unknown_since IS NOT NULL),
  CHECK (state NOT IN ('Succeeded', 'Failed') OR settled_at IS NOT NULL)
);

-- R4: the candidate identity is decomposed into the schema's CHECK-constrained
-- columns. 'identity_json' is gone, so an abbreviated head SHA is refused by the
-- column rather than merely being recorded and never checked (F17-AC2, F20-AC3).
CREATE TABLE candidates_aligned (
  candidate_id            TEXT PRIMARY KEY,
  work_item_id            TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  project_id              TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  attempt_id              TEXT REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  scope_snapshot_id       TEXT NOT NULL REFERENCES scope_snapshots(scope_snapshot_id) ON DELETE RESTRICT,
  profile_version_id      TEXT NOT NULL REFERENCES project_profile_versions(profile_version_id) ON DELETE RESTRICT,
  procedure_version_id    TEXT NOT NULL REFERENCES procedure_versions(procedure_version_id) ON DELETE RESTRICT,
  fingerprint             TEXT NOT NULL UNIQUE ${fingerprintCheck('fingerprint')},
  head_sha                TEXT NOT NULL ${commitShaCheck('head_sha')},
  base_sha                TEXT NOT NULL ${commitShaCheck('base_sha')},
  scope_fingerprint       TEXT NOT NULL ${fingerprintCheck('scope_fingerprint')},
  environment_fingerprint TEXT NOT NULL ${fingerprintCheck('environment_fingerprint')},
  policy_fingerprint      TEXT NOT NULL ${fingerprintCheck('policy_fingerprint')},
  pull_request_id         TEXT,
  created_at              TEXT NOT NULL DEFAULT ${NOW},
  superseded_at           TEXT,
  target_branch           TEXT,
  recorded_at             TEXT,
  correlation_id          TEXT
);
`;

/**
 * One column per concept in a project procedure or fact version (F05-AC1).
 *
 * This arrives as version 8 rather than as an edit to the migration that created
 * `procedure_versions`. An applied migration is recorded and never re-run, so
 * rewriting one would leave every database that already applied it on the old
 * shape while a freshly created one got the new shape - the two-vocabularies
 * defect the project keeps eliminating, produced by the migration process itself
 * (N08-AC3, ADR 0003).
 *
 * Versions 1 to 7 left this table carrying two names for one idea and one name
 * for two ideas, which is what made the repository and the schema disagree:
 *
 *   - `approval_state` ('Draft' | 'Approved' | 'Superseded') versus `status`
 *     ('Proposed' | 'Accepted' | 'Superseded' | 'Retired'). `Draft` cannot
 *     express "the agent proposed this and the owner has not saved it", and
 *     F05-AC4 requires exactly that distinction: a proposed improvement must be
 *     visible to the owner while remaining invisible to the next run. Only
 *     `status` separates "awaiting an owner save action" from "accepted", so
 *     `approval_state` goes and its vocabulary is mapped below.
 *   - `provider_revision` versus `source_revision`, one column written twice.
 *     F05-AC1 records the source revision of a fact, so the name the repository
 *     uses stays and the older column is folded into it.
 *   - `content` versus `content_json`, the same document stored twice. One
 *     column remains, named `content_json`, because that is the name every
 *     other versioned document in this schema uses.
 *   - `version_number`, which nothing read once the repository settled on
 *     `version`.
 *
 * Every constraint from version 1 is carried across unchanged: the positive
 * `version` CHECK, the `kind` and `source` vocabularies, `UNIQUE (project_id,
 * version)`, `UNIQUE (project_id, kind, content_fingerprint)`, and the approval
 * invariant in its new spelling, `status <> 'Accepted' OR approved_at IS NOT
 * NULL`. Nothing is relaxed here. `content_fingerprint` gains the same
 * fingerprint CHECK as a candidate identity, so a truncated value is refused by
 * the column rather than recorded and never checked.
 *
 * `subject_key`, `scope` and `created_by` are NOT NULL because the repository
 * binds all three on every write. Each carries an empty default so a direct
 * INSERT that omits one - a fixture or an operator statement - is still refused
 * a NULL rather than failing on the NOT NULL alone; the repository never omits
 * them. `source_revision`, `note` and the two `last_verified_*` columns stay
 * nullable because a fact may have no source revision and a version is
 * unverified until something verifies it.
 */
const MIGRATION_8_PROCEDURE_VERSION_ALIGNMENT = `
CREATE TABLE procedure_versions_aligned (
  procedure_version_id   TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  subject_key            TEXT NOT NULL DEFAULT '',
  version                INTEGER NOT NULL CHECK (version > 0),
  kind                   TEXT NOT NULL CHECK (kind IN ('Procedure', 'Fact')),
  scope                  TEXT NOT NULL DEFAULT '',
  source                 TEXT NOT NULL CHECK (source IN ('Owner', 'Repository', 'Provider')),
  source_revision        TEXT,
  content_json           TEXT NOT NULL,
  content_fingerprint    TEXT NOT NULL ${fingerprintCheck('content_fingerprint')},
  status                 TEXT NOT NULL DEFAULT 'Proposed'
                           CHECK (status IN ('Proposed', 'Accepted', 'Superseded', 'Retired')),
  last_verified_revision TEXT,
  last_verified_at       TEXT,
  approved_at            TEXT,
  created_at             TEXT NOT NULL DEFAULT ${NOW},
  created_by             TEXT NOT NULL DEFAULT '',
  note                   TEXT,
  UNIQUE (project_id, version),
  UNIQUE (project_id, kind, content_fingerprint),
  CHECK (status <> 'Accepted' OR approved_at IS NOT NULL)
);
`;

/**
 * The copy that replaces a rebuild's column-for-column restore.
 *
 * Written out rather than derived from `PRAGMA table_info` because the shapes
 * differ on purpose: four columns are dropped, two are renamed and every column
 * the repository always binds becomes NOT NULL. The three mappings that carry
 * meaning are:
 *
 *   - `status` wins when a row already has one, because a row written after
 *     version 5 already states its approval state; before that the only signal
 *     was `approval_state`, whose 'Draft' and 'Approved' become 'Proposed' and
 *     'Accepted'. A 'Superseded' row keeps its meaning either way. Nothing is
 *     invented here: a 'Draft' row becomes a proposal, which is what a draft
 *     was - content nobody accepted, so `currentVersion` cannot return it
 *     (F05-AC4).
 *   - `source_revision` falls back to the older `provider_revision`, so the
 *     revision of a fact recorded before the rename is not lost.
 *   - `content_json` prefers a populated, valid `content`, because a row the
 *     repository wrote before this alignment stored the document there and a
 *     JSON-encoded string of it in `content_json`. Keeping the encoded string
 *     would hand a reader a quoted document that no longer parses into one.
 */
const COPY_PROCEDURE_VERSIONS = `
INSERT INTO procedure_versions (
  procedure_version_id,
  project_id,
  subject_key,
  version,
  kind,
  scope,
  source,
  source_revision,
  content_json,
  content_fingerprint,
  status,
  last_verified_revision,
  last_verified_at,
  approved_at,
  created_at,
  created_by,
  note
)
SELECT
  procedure_version_id,
  project_id,
  coalesce(subject_key, ''),
  version,
  kind,
  coalesce(scope, ''),
  source,
  coalesce(source_revision, provider_revision),
  CASE WHEN content IS NOT NULL AND json_valid(content) THEN content ELSE content_json END,
  content_fingerprint,
  CASE
    WHEN status IS NOT NULL THEN status
    WHEN approval_state = 'Approved' THEN 'Accepted'
    WHEN approval_state = 'Superseded' THEN 'Superseded'
    ELSE 'Proposed'
  END,
  last_verified_revision,
  last_verified_at,
  approved_at,
  created_at,
  coalesce(created_by, ''),
  note
FROM stash_procedure_versions`;

/**
 * Child tables that reference `table`, read from the live schema.
 *
 * Discovered rather than hard-coded so a future table cannot be missed: a
 * rebuild that silently dropped rows would be a far worse failure than one that
 * refused to run.
 */
function referencingTables(db: Database, table: string): string[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row['name'])
    .filter((name): name is string => typeof name === 'string');

  const referencing: string[] = [];
  for (const name of tables) {
    if (name === table) continue;
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all();
    for (const key of foreignKeys) {
      if (key['table'] === table) {
        referencing.push(name);
        break;
      }
    }
  }
  return referencing;
}

function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to quote a non-identifier table name: ${name}`);
  }
  return `"${name}"`;
}

function columnNames(db: Database, table: string): string {
  return db
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((row) => quoteIdentifier(String(row['name'])))
    .join(', ');
}

/**
 * One table rebuilt in place, keeping the rows it already had.
 *
 * `copy` is the full INSERT that restores the stashed rows. It defaults to a
 * column-for-column restore, which is only correct when the replacement has the
 * same shape as the table it replaces; a rebuild that reshapes the table supplies
 * its own projection so no column is dropped silently and no column is invented.
 */
interface TableRebuild {
  readonly table: string;
  readonly replacement: string;
  readonly copy?: string;
  /**
   * Triggers dropped for the duration of the swap and recreated before the
   * transaction ends.
   *
   * A referencing table has to be emptied while the parent is replaced, and a
   * table whose rows are append-only refuses a DELETE. The trigger is therefore
   * suspended for exactly the swap and restored immediately afterwards, inside
   * the same transaction: the rows are copied back unchanged, so the immutability
   * the trigger exists to provide (F12-AC1) is never actually exercised - it is
   * only unavailable for the few statements this migration makes.
   */
  readonly suspended?: readonly SuspendedTrigger[];
}

interface SuspendedTrigger {
  readonly name: string;
  readonly create: string;
}

/**
 * The append-only guards on `scope_snapshots` (F12-AC1).
 *
 * Written once here and reused rather than restated per call site: two copies of
 * a trigger definition is exactly how a rebuilt table ends up with one guard and
 * not the other.
 */
const SCOPE_SNAPSHOT_IMMUTABILITY_TRIGGERS: readonly SuspendedTrigger[] = [
  {
    name: 'scope_snapshots_immutable_update',
    create: `CREATE TRIGGER IF NOT EXISTS scope_snapshots_immutable_update
     BEFORE UPDATE ON scope_snapshots
     BEGIN
       SELECT RAISE(ABORT, 'scope_snapshots are immutable: record a new snapshot instead');
     END`,
  },
  {
    name: 'scope_snapshots_immutable_delete',
    create: `CREATE TRIGGER IF NOT EXISTS scope_snapshots_immutable_delete
     BEFORE DELETE ON scope_snapshots
     BEGIN
       SELECT RAISE(ABORT, 'scope_snapshots are immutable and retained for history');
     END`,
  },
];

/**
 * Rebuilds `ideas` and `work_items` with the nullable identity columns.
 *
 * Each table is rebuilt in dependency order and its referencing tables are
 * stashed around it, so no row is lost and no foreign key is left dangling. The
 * whole sequence runs inside the migration's own transaction: if any step
 * throws, the rollback restores the original schema and rows together.
 */
function alignContracts(db: Database): void {
  rebuildTables(db, [
    { table: 'ideas', replacement: 'ideas_nullable' },
    { table: 'owners', replacement: 'owners_aligned' },
    { table: 'work_items', replacement: 'work_items_aligned' },
    { table: 'outbox_events', replacement: 'outbox_events_aligned' },
    { table: 'external_operations', replacement: 'external_operations_aligned' },
    { table: 'owner_decisions', replacement: 'owner_decisions_aligned' },
    { table: 'jobs', replacement: 'jobs_aligned' },
    { table: 'candidates', replacement: 'candidates_aligned' },
  ]);

  // SQLite drops an index and a trigger with the table it belongs to, so every
  // one defined in versions 1 to 6 that lives on a rebuilt table is recreated
  // here. The list is explicit rather than derived: a rebuild that silently lost
  // an index would turn a filtered query into a full scan, and a rebuild that
  // silently lost the append-only triggers would make a scope snapshot editable
  // (F12-AC1).
  const restores: readonly string[] = [
    'CREATE INDEX IF NOT EXISTS ideas_by_project ON ideas(project_id, state, created_at)',
    'CREATE INDEX IF NOT EXISTS work_items_by_project ON work_items(project_id, publication_intent, created_at)',
    'CREATE INDEX IF NOT EXISTS work_items_by_idea ON work_items(idea_id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS owners_by_email ON owners(email) WHERE email IS NOT NULL',
    'CREATE UNIQUE INDEX IF NOT EXISTS work_items_by_external_issue ON work_items(external_issue_id) WHERE external_issue_id IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS outbox_events_by_state ON outbox_events(state, next_attempt_at)',
    'CREATE INDEX IF NOT EXISTS outbox_events_by_operation ON outbox_events(operation_id)',
    'CREATE INDEX IF NOT EXISTS external_operations_by_state ON external_operations(state, requested_at)',
    'CREATE INDEX IF NOT EXISTS external_operations_by_work_item ON external_operations(work_item_id, requested_at DESC)',
    'CREATE INDEX IF NOT EXISTS jobs_by_state ON jobs(state, queued_at)',
    'CREATE INDEX IF NOT EXISTS jobs_by_work_item ON jobs(work_item_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS candidates_by_work_item ON candidates(work_item_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS candidates_by_fingerprint ON candidates(fingerprint)',
    'CREATE INDEX IF NOT EXISTS owner_decisions_by_candidate ON owner_decisions(candidate_id, decided_at DESC)',
    'CREATE INDEX IF NOT EXISTS owner_decisions_by_work_item ON owner_decisions(work_item_id, decided_at DESC)',
'CREATE INDEX IF NOT EXISTS owner_decisions_unconsumed ON owner_decisions(candidate_id) WHERE state = \'Recorded\'',
    // The append-only guards come from the single definition above, so this list
    // cannot end up restoring one trigger and not the other.
    ...SCOPE_SNAPSHOT_IMMUTABILITY_TRIGGERS.map((trigger) => trigger.create),
  ];
  for (const statement of restores) {
    db.exec(statement);
  }
}

/**
 * Replaces each named table with its prepared replacement, keeping every row.
 *
 * The sequence is the one migrations 5 to 7 established, and the only one proven
 * to work inside this runner: SQLite re-validates referencing rows against a
 * dropped table, so a naive `CREATE`/`INSERT`/`DROP`/`RENAME` fails the moment a
 * child row exists. Stashing the referencing tables, emptying them, swapping the
 * parent and restoring in order keeps `PRAGMA foreign_key_check` empty and loses
 * no row. A rebuild that throws leaves the caller's transaction to roll the
 * original schema back with the data intact.
 *
 * `PRAGMA defer_foreign_keys` moves the child checks to the end of the
 * transaction, which is what lets the parent be dropped and recreated under the
 * children instead of after them.
 */
function rebuildTables(db: Database, rebuilds: readonly TableRebuild[]): void {
  for (const { table, replacement, copy, suspended } of rebuilds) {
    const children = referencingTables(db, table);
    const restore = copy ?? identityCopy(db, table);

    db.exec('PRAGMA defer_foreign_keys = ON');
    for (const trigger of suspended ?? []) {
      db.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)}`);
    }
    for (const child of children) {
      db.exec(`CREATE TEMP TABLE stash_${child} AS SELECT * FROM ${quoteIdentifier(child)}`);
    }
    db.exec(`CREATE TEMP TABLE stash_${table} AS SELECT * FROM ${quoteIdentifier(table)}`);
    for (const child of children) {
      db.exec(`DELETE FROM ${quoteIdentifier(child)}`);
    }
    db.exec(`DROP TABLE ${quoteIdentifier(table)}`);
    db.exec(`ALTER TABLE ${quoteIdentifier(replacement)} RENAME TO ${quoteIdentifier(table)}`);
    db.exec(restore);
    for (const child of children) {
      const childColumns = columnNames(db, child);
      db.exec(
        `INSERT INTO ${quoteIdentifier(child)} (${childColumns}) SELECT ${childColumns} FROM stash_${child}`,
      );
    }
    db.exec(`DROP TABLE stash_${table}`);
    for (const child of children) {
      db.exec(`DROP TABLE stash_${child}`);
    }
    for (const trigger of suspended ?? []) {
      db.exec(trigger.create);
    }
  }
}

/** The column-for-column restore used when a replacement has the same shape. */
function identityCopy(db: Database, table: string): string {
  const columns = columnNames(db, table);
  return `INSERT INTO ${quoteIdentifier(table)} (${columns}) SELECT ${columns} FROM stash_${table}`;
}

/**
 * Rebuilds `procedure_versions` so the schema carries one column per concept.
 *
 * The referencing tables (`evidence`, `scope_snapshots`, `jobs` and
 * `candidates`, discovered rather than named) are stashed around the swap, so the
 * rows that point at a run's procedure version survive the rebuild with their
 * foreign keys intact.
 *
 * The indexes are recreated afterwards rather than carried across, because SQLite
 * drops an index with the table that owns it. The subject-key index exists for a
 * reason the version-1 index cannot serve: `currentVersion` and `appendVersion`
 * both address one subject key, and the partial index over proposed versions is
 * what makes `listProposed` read only the owner's outstanding proposals rather
 * than the project's whole history.
 */
function alignProcedureVersions(db: Database): void {
  rebuildTables(db, [
    {
      table: 'procedure_versions',
      replacement: 'procedure_versions_aligned',
      copy: COPY_PROCEDURE_VERSIONS,
      // `scope_snapshots` references a procedure version and refuses to be
      // emptied, so its append-only guards are suspended for the swap only.
      suspended: SCOPE_SNAPSHOT_IMMUTABILITY_TRIGGERS,
    },
  ]);

  db.exec(
    'CREATE INDEX procedure_versions_by_project ON procedure_versions(project_id, kind, version DESC)',
  );
  db.exec(
    'CREATE INDEX procedure_versions_by_subject ON procedure_versions(project_id, subject_key, status, version DESC)',
  );
  db.exec(
    `CREATE INDEX procedure_versions_proposed ON procedure_versions(project_id, created_at, version)
     WHERE status = 'Proposed'`,
  );
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'instance_owner_and_configuration',
    up: (db) => {
      db.exec(MIGRATION_1_INSTANCE_OWNER_AND_CONFIGURATION);
    },
  },
  {
    version: 2,
    name: 'intake_scope_and_work_mapping',
    up: (db) => {
      db.exec(MIGRATION_2_INTAKE_SCOPE_AND_WORK_MAPPING);
    },
  },
  {
    version: 3,
    name: 'execution_candidates_and_evidence',
    up: (db) => {
      db.exec(MIGRATION_3_EXECUTION_CANDIDATES_AND_EVIDENCE);
    },
  },
  {
    version: 4,
    name: 'delivery_attention_and_events',
    up: (db) => {
      db.exec(MIGRATION_4_DELIVERY_ATTENTION_AND_EVENTS);
    },
  },
  {
    version: 5,
    name: 'repository_alignment',
    up: (db) => {
      db.exec(MIGRATION_5_REPOSITORY_ALIGNMENT);
    },
  },
  {
    version: 6,
    name: 'event_ledger_alignment',
    up: (db) => {
      db.exec(MIGRATION_6_EVENT_LEDGER_ALIGNMENT);
    },
  },
  {
    version: 7,
    name: 'contract_alignment',
    up: (db) => {
      db.exec(MIGRATION_7_CONTRACT_ALIGNMENT);
      alignContracts(db);
    },
  },
  {
    version: 8,
    name: 'procedure_version_alignment',
    up: (db) => {
      db.exec(MIGRATION_8_PROCEDURE_VERSION_ALIGNMENT);
      alignProcedureVersions(db);
    },
  },
];

/** The ordered migration set, exposed so tooling can report what a build expects. */
export const migrationDefinitions: readonly Migration[] = MIGRATIONS;

/** Highest schema version this build knows how to produce. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * The applied schema version, or 0 when nothing has been applied yet.
 *
 * A missing bookkeeping table means an untouched database, not a failure: the
 * first call to `migrate` creates it.
 */
export function currentVersion(db: Database): Result<number, DomainError> {
  const applied = appliedMigrations(db);
  if (!applied.ok) return err(applied.error);
  const last = applied.value[applied.value.length - 1];
  return ok(last?.version ?? 0);
}

/** Every recorded migration, ordered by version. */
export function appliedMigrations(db: Database): Result<readonly AppliedMigration[], DomainError> {
  const present = tableExists(db, 'schema_migrations');
  if (!present.ok) return err(present.error);
  if (!present.value) return ok([]);

  let rows: Record<string, SQLOutputValue>[];
  try {
    rows = db.prepare(SELECT_APPLIED).all();
  } catch (error) {
    return err({
      code: 'Unavailable',
      reason: `schema_migrations could not be read: ${describeError(error)}`,
    });
  }

  const applied: AppliedMigration[] = [];
  for (const row of rows) {
    const version = row['version'];
    const name = row['name'];
    const appliedAt = row['applied_at'];
    const checksum = row['checksum'];
    if (
      typeof version !== 'number' ||
      typeof name !== 'string' ||
      typeof appliedAt !== 'string' ||
      typeof checksum !== 'string'
    ) {
      return err(
        invalid('schema_migrations holds a record this build cannot interpret.', [
          { path: 'schema_migrations', message: 'Version, name, applied_at and checksum are required.' },
        ]),
      );
    }
    applied.push({ version, name, appliedAt, checksum });
  }
  return ok(applied);
}

/**
 * Applies every migration this build defines that the database has not recorded.
 *
 * Idempotent: a second run applies nothing and reports the same version. Each
 * migration runs in its own transaction together with the record of its version,
 * so an interrupted or failing run leaves no partial schema and no version that
 * claims work which did not happen (N01-AC3).
 *
 * The runner refuses rather than guesses when the database and this build
 * disagree: an unknown applied version, a gap below the recorded maximum, a
 * renamed migration, or definitions that do not ascend from 1. Silently skipping
 * such a mismatch is how a database ends up half-upgraded and never diagnosed.
 */
export function migrate(db: Database, options: MigrateOptions = {}): Result<MigrationReport, DomainError> {
  const definitions = validateDefinitions();
  if (!definitions.ok) return err(definitions.error);

  const bootstrapped = runBounded(db, () => {
    db.exec(CREATE_MIGRATIONS_TABLE);
  });
  if (!bootstrapped.ok) return err(bootstrapped.error);

  const applied = appliedMigrations(db);
  if (!applied.ok) return err(applied.error);

  const reconciled = reconcile(applied.value);
  if (!reconciled.ok) return err(reconciled.error);

  const fromVersion = applied.value[applied.value.length - 1]?.version ?? 0;
  const pending = MIGRATIONS.filter((migration) => migration.version > fromVersion);
  const now = options.now ?? (() => new Date().toISOString());
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
  );

  for (const migration of pending) {
    const appliedAt = now();
    const outcome = runBounded(db, () => {
      migration.up(db);
      record.run(migration.version, migration.name, appliedAt, migrationChecksum(migration));
    });
    if (!outcome.ok) return err(outcome.error);
  }

  return ok({
    fromVersion,
    toVersion: pending[pending.length - 1]?.version ?? fromVersion,
    applied: pending.map((migration) => ({ version: migration.version, name: migration.name })),
  });
}

/** Runs one migration step in a transaction and converts a failure to a typed rejection. */
function runBounded(db: Database, step: () => void): Result<true, DomainError> {
  try {
    withTransaction(db, step);
  } catch (error) {
    if (error instanceof TransactionError) return err(error.result.error);
    return err({
      code: 'Unavailable',
      reason: `The schema change was rolled back: ${describeError(error)}`,
    });
  }
  return ok(true);
}

/**
 * Confirms the recorded history matches this build's definitions.
 *
 * Applied versions must be exactly 1..max: a gap means a migration was inserted
 * out of order after later versions had already run, which is not something the
 * runner can apply safely in either direction.
 */
function reconcile(applied: readonly AppliedMigration[]): Result<true, DomainError> {
  const byVersion = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));
  const recorded = new Set<number>();

  for (const record of applied) {
    const definition = byVersion.get(record.version);
    if (definition === undefined) {
      return err(
        invalid('This database was migrated by a newer or different build.', [
          {
            path: 'schema_migrations.version',
            message: `Version ${record.version} ("${record.name}") is not defined by this build, whose highest version is ${LATEST_SCHEMA_VERSION}.`,
          },
        ]),
      );
    }
    const expected = migrationChecksum(definition);
    if (record.checksum !== expected) {
      return err(
        invalid('An applied migration was renamed after the fact.', [
          {
            path: 'schema_migrations.name',
            message: `Version ${record.version} is recorded as "${record.name}" but this build calls it "${definition.name}". Forward-only migrations cannot be rewritten.`,
          },
        ]),
      );
    }
    recorded.add(record.version);
  }

  const highest = applied[applied.length - 1]?.version ?? 0;
  const missing: number[] = [];
  for (let version = 1; version <= highest; version += 1) {
    if (!recorded.has(version)) missing.push(version);
  }
  if (missing.length > 0) {
    return err(
      invalid('Applied migrations contain a gap below the recorded maximum.', [
        {
          path: 'schema_migrations.version',
          message: `Version${missing.length === 1 ? '' : 's'} ${missing.join(', ')} missing while version ${highest} is applied. A migration cannot be inserted out of order; add a new migration with the next version.`,
        },
      ]),
    );
  }
  return ok(true);
}

function validateDefinitions(): Result<true, DomainError> {
  const fields: { path: string; message: string }[] = [];
  let previous = 0;
  for (const migration of MIGRATIONS) {
    if (!Number.isInteger(migration.version) || migration.version !== previous + 1) {
      fields.push({
        path: 'migrations.version',
        message: `"${migration.name}" is version ${migration.version}; versions must ascend from 1 with no gaps.`,
      });
    }
    if (migration.name.trim().length === 0) {
      fields.push({ path: 'migrations.name', message: `Version ${migration.version} has no name.` });
    }
    previous = migration.version;
  }
  return fields.length > 0 ? err(invalid('The migration set is not forward-only.', fields)) : ok(true);
}

/**
 * Detects a renamed or renumbered migration.
 *
 * Only the version and name are hashed, not the SQL body: the body is deliberately
 * not part of the record because a compiled build must not be able to disagree
 * with the build that created the schema.
 */
function migrationChecksum(migration: Migration): string {
  return createHash('sha256')
    .update(`${migration.version}:${migration.name}`)
    .digest('hex')
    .slice(0, 32);
}

function tableExists(db: Database, table: string): Result<boolean, DomainError> {
  try {
    const rows = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .all(table);
    return ok(rows.length > 0);
  } catch (error) {
    return err({ code: 'Unavailable', reason: `sqlite_master could not be read: ${describeError(error)}` });
  }
}

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${sqlLiteral(value)}'`).join(', ');
}

/** A required column restricted to the states a slice defined. */
function sqlEnum(column: string, values: readonly string[]): string {
  return `CHECK (${column} IN (${sqlList(values)}))`;
}

/** The same restriction, for a column that is absent when the state does not apply. */
function nullableEnum(column: string, values: readonly string[]): string {
  return `CHECK (${column} IS NULL OR ${column} IN (${sqlList(values)}))`;
}

function sqlLiteral(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(value)) {
    throw new Error(`Refusing to interpolate a non-literal SQL value: ${value}`);
  }
  return value;
}

function commitShaCheck(column: string): string {
  return `CHECK (length(${column}) IN (40, 64) AND ${column} NOT GLOB '*[^0-9a-f]*')`;
}

function fingerprintCheck(column: string): string {
  return `CHECK (${fingerprintCondition(column)})`;
}

/**
 * The same restriction for a column that is absent when the concept does not
 * apply: an acceptance has no authorization subject, so `subject_fingerprint`
 * is null there and a well-formed fingerprint everywhere else (R3).
 */
function nullableFingerprintCheck(column: string): string {
  return `CHECK (${column} IS NULL OR ${fingerprintCondition(column)})`;
}

/**
 * A fingerprint is `fp_` plus 32 lowercase hex characters (35 characters total),
 * matching `isFingerprint` in `@shiploop/domain`. Rejecting a malformed value here
 * keeps a truncated or hand-written fingerprint from silently producing a
 * different candidate identity.
 */
function fingerprintCondition(column: string): string {
  return `length(${column}) = 35 AND substr(${column}, 1, 3) = 'fp_' AND substr(${column}, 4) NOT GLOB '*[^0-9a-f]*'`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
