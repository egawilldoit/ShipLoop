import { createHash } from 'node:crypto';
import type { SQLOutputValue } from 'node:sqlite';
import { err, invalid, ok, type DomainError, type Result } from '@shiploop/domain';
import type { Database } from './db.ts';
import { TransactionError, withTransaction } from './tx.ts';

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

const ATTEMPT_STATE_VALUES = [
  'Queued',
  'Preparing',
  'Running',
  'Verifying',
  'WaitingForOwner',
  'Paused',
  'Blocked',
  'Completed',
  'Cancelled',
] as const;

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

const JOB_STATE_VALUES = [
  'Queued',
  'Claimed',
  'Running',
  'Paused',
  'Verifying',
  'WaitingForOwner',
  'Completed',
  'Failed',
  'Cancelled',
] as const;

const JOB_MODE_VALUES = ['PlanInvestigate', 'Build', 'Test', 'Review'] as const;

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
  state                   TEXT NOT NULL DEFAULT 'Queued' ${sqlEnum('state', JOB_STATE_VALUES)},
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
  CHECK (state NOT IN ('Claimed', 'Running', 'Verifying') OR started_at IS NOT NULL),
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
CREATE INDEX external_operations_by_state ON external_operations(state, requested_at);
CREATE INDEX external_operations_by_work_item ON external_operations(work_item_id, requested_at DESC);

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
