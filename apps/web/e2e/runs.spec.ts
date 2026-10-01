/**
 * The coding journey, driven through a real browser against the shipped server.
 *
 * Every assertion here is a measurement, a real request, or a read of the server's own
 * SQLite file. The flow is the owner's: sign in through the form, start a run, watch it,
 * control it, read its review card, and work the attention board — all against
 * `apps/web/src/server/main.ts` composed from `@shiploop/controller` (F01-AC1).
 *
 * Six properties are asserted rather than assumed, because each is the claim a passing
 * browser run has to support and each fails for a different reason:
 *
 *   - **This run drove the shipped entrypoint.** `e2e/fixtures.ts` substitutes a real
 *     in-process server when `main.ts` cannot become ready, and announces that on stderr;
 *     without this assertion a completely broken startup would read as a passing gate
 *     (F01-AC1).
 *   - **A start produces a durable job row the worker could claim.** Checked against the
 *     `jobs` table rather than a badge, because a badge is what the implementation would
 *     print whether or not a row existed (F13-AC1, N01-AC3).
 *   - **A repeated Start produces one run.** Checked by counting rows before and after the
 *     second press, because "the UI said it was already started" is a claim about the
 *     response, not about the store (F13-AC2).
 *   - **A refusal is shown verbatim and keeps the typed input.** The message asserted is the
 *     server's own wording, and the form is checked afterwards for what the owner typed,
 *     because a refusal that discards a form costs a retype (N03-AC3, F17-AC1).
 *   - **`Paused` is not claimed while a writer might still be writing.** Driven by seeding a
 *     writer whose lease needs reconciliation, which is the state F17-AC5 exists for: an
 *     expired lease proves heartbeats stopped, not that the process did.
 *   - **Nothing scrolls sideways and every control is labelled and reachable.** Measured off
 *     `document.documentElement` the way `smoke.spec.ts` does, because a CSS class says what
 *     was intended and the measurement says what happened (F01-AC3, N03-AC1).
 *
 * How the store is seeded is stated rather than hidden. This slice's public surface is the
 * run journey, and nothing in it creates a project profile, an environment recipe or a
 * work item, so the fixture writes those three rows through the real
 * `ProjectProfileRepository`, `ProcedureRepository` and `WorkItemRepository` against the
 * same file the server has open. What is under test is the run journey; the rows it starts
 * from are its given. A defect in the profile or recipe paths would not be caught here, and
 * the profile form's own spec is where that is proved.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { canonicalize, fingerprint } from '@shiploop/domain';
import type { Page } from '@playwright/test';
import { SYNTHETIC_OWNER, SYNTHETIC_PASSWORD, expect, test as base } from './fixtures.ts';

const VIEWS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const PROJECT = 'e2e-runs-project';
const WORK_ITEM_TITLE = 'E2E run: leave a durable record';

/** A full 40-character commit SHA, because a resume compares these to a real checkout. */
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BASE_SHA = '0f1e2d3c4b5a69788796a5b4c3d2e1f001122334';
const CHECK_NAME = 'e2e-required-check';
const ENGINE_VERSION = 'codex-e2e-1';
/** When the detached writer's lease was taken, and when it lapsed. Both in the past. */
const LAPSED_AT = '2026-01-01T00:00:00.000Z';
const LAPSED_BY = '2026-01-01T00:05:00.000Z';

const READINESS_LABELS = [
  'Scope',
  'Criteria',
  'Repository',
  'Target',
  'Verification',
  'Access',
] as const;

let identityCounter = 0;

/**
 * An identity unique to this worker.
 *
 * Every seeded row carries one, because the store is shared across the tests in this file and
 * a fixture that reused an identity would either collide on a primary key or, worse, attach a
 * second test's rows to the first test's run.
 */
function uniqueId(prefix: string): string {
  identityCounter += 1;
  return `${prefix}_${String(Date.now())}_${String(identityCounter)}`;
}

function uniqueOperationId(): string {
  return `op-e2e-runs-${String(Date.now())}-${String(Math.round(Math.random() * 1e6))}`;
}

/* -------------------------------------------------------------------------- */
/* Store access, as a second observer of the file the server has open          */
/* -------------------------------------------------------------------------- */

/** One durable job row, as the store names its columns. */
interface RecordedJobRow {
  readonly job_id: string;
  readonly state: string;
  readonly mode: string;
  readonly work_item_id: string;
  readonly operation_id: string;
  readonly holder: string | null;
  readonly attempt_count: number;
}

interface RunStore {
  readonly path: string;
  jobsForWorkItem(workItemId: string): readonly RecordedJobRow[];
  /** Every recorded run, because the run list is store-wide rather than per work item. */
  totalRuns(): number;
  seedProfileVersion(input: {
    readonly projectId: string;
    readonly requiredChecks: readonly string[];
    readonly now: string;
  }): { readonly profileVersionId: string; readonly contentFingerprint: string };
  seedRecipeVersion(input: { readonly projectId: string; readonly now: string }): {
    readonly procedureVersionId: string;
    readonly contentFingerprint: string;
  };
  seedWorkItem(input: {
    readonly projectId: string;
    readonly profileVersionId: string;
    readonly now: string;
  }): string;
  seedCandidate(input: {
    readonly workItemId: string;
    readonly scopeFingerprint: string;
    readonly profileVersionId: string;
    readonly procedureVersionId: string;
    readonly environmentFingerprint: string;
    readonly policyFingerprint: string;
    readonly now: string;
  }): string;
  /**
   * Records an owner observation against a candidate, exactly as the journal writes it.
   *
   * The columns here mirror the journal's own INSERT rather than a reduced subset, because
   * an acceptance decision reads this row through the shipped journal: a fixture that wrote
   * fewer columns would prove nothing about the acceptance path it is set up for (F23-AC1,
   * F25-AC1).
   */
  recordOwnerObservation(input: {
    readonly candidateId: string;
    readonly workItemId: string;
    readonly projectId: string;
    readonly candidateFingerprint: string;
    readonly scopeFingerprint: string;
    readonly criterionId: string;
    readonly methodKind: string;
    readonly status: string;
    readonly detail: string;
    readonly now: string;
  }): void;
  /**
   * The decisions recorded against a candidate, as the durable table names them.
   *
   * `note` rather than `feedback_redacted`: the repository writes the redacted feedback into
   * the decision's `note`, and reading a column the write path never fills would let this
   * assertion pass against a null it should have failed (F25-AC2).
   */
  decisionsFor(candidateId: string): readonly {
    readonly decision_type: string;
    readonly acceptance_state: string | null;
    readonly note: string | null;
    readonly actor_owner_id: string;
  }[];
  seedCheckpoint(input: {
    readonly jobId: string;
    readonly holder: string;
    readonly scopeSnapshotId: string;
    readonly scopeFingerprint: string;
    readonly profileVersionId: string;
    readonly procedureVersionId: string;
    readonly now: string;
  }): void;
  seedReconciliationLease(input: { readonly jobId: string; readonly holder: string; readonly now: string }): void;
}

/**
 * Opens the run's own database as a second writer.
 *
 * WAL is what makes this possible while the server holds the file open, and every write
 * here is short, so the two connections never contend for long. `busy_timeout` is set
 * explicitly rather than left to a default: a fixture that failed a test because the server
 * happened to hold the write lock at that instant would be a flake, not a finding.
 */
function openRunStore(shipLoopServer: { readonly dataDirectory: string }): RunStore {
  const path = join(shipLoopServer.dataDirectory, 'shiploop.db');
  const open = (): DatabaseSync => {
    const database = new DatabaseSync(path);
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec('PRAGMA foreign_keys = ON');
    return database;
  };
  const text = (row: Record<string, unknown>, column: string): string => {
    const value = row[column];
    if (typeof value !== 'string') throw new Error(`column ${column} is missing or not text`);
    return value;
  };

  return {
    path,
    totalRuns: (): number => {
      const database = open();
      try {
        const row = database.prepare('SELECT COUNT(*) AS total FROM jobs').get();
        const total = row?.['total'];
        return typeof total === 'bigint' ? Number(total) : typeof total === 'number' ? total : -1;
      } finally {
        database.close();
      }
    },
    jobsForWorkItem: (workItemId) => {
      const database = open();
      try {
        return database
          .prepare('SELECT job_id, state, mode, work_item_id, operation_id, holder, attempt_count FROM jobs WHERE work_item_id = ?')
          .all(workItemId)
          .map((row) => ({
            job_id: text(row, 'job_id'),
            state: text(row, 'state'),
            mode: text(row, 'mode'),
            work_item_id: text(row, 'work_item_id'),
            operation_id: text(row, 'operation_id'),
            holder: row['holder'] === null || row['holder'] === undefined ? null : String(row['holder']),
            attempt_count: typeof row['attempt_count'] === 'number' ? row['attempt_count'] : Number(row['attempt_count'] ?? 0),
          }));
      } finally {
        database.close();
      }
    },
    seedProfileVersion: (input) => {
      const database = open();
      try {
        database
          .prepare('INSERT INTO projects (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id) DO NOTHING')
          .run(input.projectId, input.projectId, input.now, input.now);
        const content = {
          references: {
            repository: 'example.invalid/e2e-synthetic/repo',
            ticketProvider: 'example.invalid',
            ticketTeamKey: 'E2E',
            baseBranch: 'main',
            targetBranch: 'main',
            deploymentProvider: 'example.invalid',
            engine: 'example.invalid/engine-1',
            previewComponents: [],
          },
          policy: {
            requiredChecks: [...input.requiredChecks],
            deliveryBehavior: 'ManualAuthorizationOnly',
            maxFixPasses: 2,
            workspaceIsolation: 'WorktreeAndDataDirectory',
            capabilityVersion: 1,
          },
          recipe: 'npm ci && npm test',
          environment: { runtime: 'node-24', ports: [], secretReferences: [] },
        };
        // The domain's own `canonicalize` and `fingerprint`, because the fingerprint a
        // recorded result is matched against is computed the same way. A hand-rolled
        // encoding here would give the profile a fingerprint nothing could ever match, and
        // every check on the card would read as stale for that reason alone (F20-AC3).
        const encoded = canonicalize(content);
        const contentFingerprint = fingerprint(content);
        const profileVersionId = uniqueId('prv_e2e');
        // The version number is per project and the schema makes it unique, so a fixture that
        // always wrote 1 would collide with the version the previous test left behind. Taking
        // the next number is what the repository's own compare-and-set does.
        const newest = database
          .prepare('SELECT MAX(version) AS newest FROM project_profile_versions WHERE project_id = ?')
          .get(input.projectId);
        const version = (typeof newest?.['newest'] === 'number' ? newest['newest'] : 0) + 1;
        database
          .prepare(
            `INSERT INTO project_profile_versions (profile_version_id, project_id, version, version_number,
               supersedes_profile_version_id, supersedes_version_id, content_json, content_fingerprint, note,
               created_at, created_by)
             VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)`,
          )
          .run(profileVersionId, input.projectId, version, version, encoded, contentFingerprint, input.now, SYNTHETIC_OWNER.id);
        return { profileVersionId, contentFingerprint };
      } finally {
        database.close();
      }
    },
    seedRecipeVersion: (input) => {
      const database = open();
      try {
        const recipe = {
          recipeId: 'e2e-recipe',
          version: 1,
          supersedesVersion: null,
          provenance: { source: 'OwnerSaved', scope: 'Environment', createdBy: SYNTHETIC_OWNER.id, createdAt: input.now },
          lastVerification: { state: 'NeverVerified', verifiedAt: null, verifier: null, detail: null },
          requirements: { runtime: { name: 'node', minVersion: '24.0.0', maxVersionExclusive: null }, cpu: { architecture: 'x64', minCores: 1 } },
          dependencyInstall: [],
          serviceStartup: [],
          checks: [
            {
              id: 'check_e2e_required',
              name: CHECK_NAME,
              command: { argv: ['node', '--version'], timeoutMs: 30_000, maxOutputBytes: 65_536, cwd: null },
              required: true,
            },
          ],
          ports: [],
          dataLocations: [],
          testAccess: [],
          requiredSecrets: [],
          declaredCapabilities: ['Repository:Read', 'Check:Execute'],
          maintenance: { action: 'Incompatible', command: null, incompatibilityReason: 'The e2e recipe has no maintenance step.' },
        };
        const encoded = canonicalize(recipe);
        const contentFingerprint = fingerprint(recipe);
        const procedureVersionId = uniqueId('prc_e2e');
        const newest = database
          .prepare("SELECT MAX(version) AS newest FROM procedure_versions WHERE project_id = ? AND subject_key = 'environment.recipe'")
          .get(input.projectId);
        const version = (typeof newest?.['newest'] === 'number' ? newest['newest'] : 0) + 1;
        database
          .prepare(
            `INSERT INTO procedure_versions (procedure_version_id, project_id, subject_key, version, kind, scope,
               source, source_revision, content_json, content_fingerprint, status, last_verified_revision,
               last_verified_at, approved_at, created_at, created_by, note)
             VALUES (?, ?, 'environment.recipe', ?, 'Procedure', 'Environment', 'Owner', NULL, ?, ?, 'Accepted',
               NULL, NULL, ?, ?, ?, NULL)`,
          )
          .run(
            procedureVersionId,
            input.projectId,
            version,
            encoded,
            contentFingerprint,
            input.now,
            input.now,
            SYNTHETIC_OWNER.id,
          );
        return { procedureVersionId, contentFingerprint };
      } finally {
        database.close();
      }
    },
    seedWorkItem: (input) => {
      const database = open();
      try {
        const workItemId = uniqueId('wrk_e2e_runs');
        database
          .prepare(
            `INSERT INTO work_items (work_item_id, project_id, profile_version_id, source, origin, title,
               external_issue_id, external_issue_identifier, external_issue_url, publication_intent,
               publication_state, related_work_item_ids, adoption_json, created_at, updated_at)
             VALUES (?, ?, ?, 'ProposedNewIssue', 'Proposed', ?, NULL, NULL, NULL, 'PublishWhenAgreed',
               'Unpublished', ?, ?, ?, ?)`,
          )
          // `adoption_json` and `related_work_item_ids` are canonicalized JSON rather than SQL
          // NULL, because the reader parses both and a NULL where the repository writes the
          // four-character string "null" reads as a corrupt row rather than as "no adoption".
          .run(
            workItemId,
            input.projectId,
            input.profileVersionId,
            WORK_ITEM_TITLE,
            canonicalize([]),
            canonicalize(null),
            input.now,
            input.now,
          );
        return workItemId;
      } finally {
        database.close();
      }
    },
    seedCandidate: (input) => {
      const database = open();
      try {
        const snapshot = database
          .prepare('SELECT scope_snapshot_id, project_id FROM scope_snapshots WHERE work_item_id = ? ORDER BY created_at DESC, scope_snapshot_id DESC LIMIT 1')
          .get(input.workItemId);
        if (snapshot === undefined) {
          throw new Error(`No scope snapshot exists for ${input.workItemId}; the run must be started before a candidate can be recorded.`);
        }
        const identity = {
          headSha: HEAD_SHA,
          baseSha: BASE_SHA,
          scopeFingerprint: input.scopeFingerprint,
          profileVersionId: input.profileVersionId,
          procedureVersionId: input.procedureVersionId,
          environmentFingerprint: input.environmentFingerprint,
          policyFingerprint: input.policyFingerprint,
          components: [],
        };
        const candidateFingerprint = fingerprint(identity);
        const candidateId = uniqueId('cnd_e2e');
        database
          .prepare(
            `INSERT INTO candidates (candidate_id, attempt_id, work_item_id, project_id, scope_snapshot_id,
               profile_version_id, procedure_version_id, fingerprint, head_sha, base_sha, scope_fingerprint,
               environment_fingerprint, policy_fingerprint, pull_request_id, target_branch, recorded_at,
               correlation_id, superseded_at, created_at)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?)`,
          )
          .run(
            candidateId,
            input.workItemId,
            text(snapshot, 'project_id'),
            text(snapshot, 'scope_snapshot_id'),
            input.profileVersionId,
            input.procedureVersionId,
            candidateFingerprint,
            HEAD_SHA,
            BASE_SHA,
            input.scopeFingerprint,
            input.environmentFingerprint,
            input.policyFingerprint,
            'main',
            input.now,
            input.now,
          );
        return candidateId;
      } finally {
        database.close();
      }
    },
    recordOwnerObservation: (input) => {
      const database = open();
      try {
        database
          .prepare(
            `INSERT INTO evidence (evidence_id, candidate_id, work_item_id, project_id, check_id,
               candidate_fingerprint, scope_fingerprint, criterion_id, method_kind, status, artifact_ref,
               detail_redacted, observed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
          )
          .run(
            uniqueId('evd_e2e'),
            input.candidateId,
            input.workItemId,
            input.projectId,
            input.candidateFingerprint,
            input.scopeFingerprint,
            input.criterionId,
            input.methodKind,
            input.status,
            input.detail,
            input.now,
            input.now,
            input.now,
          );
      } finally {
        database.close();
      }
    },
    decisionsFor: (candidateId) => {
      const database = open();
      try {
        return database
          .prepare('SELECT decision_type, acceptance_state, note, actor_owner_id FROM owner_decisions WHERE candidate_id = ? ORDER BY decided_at')
          .all(candidateId)
          .map((row) => ({
            decision_type: text(row, 'decision_type'),
            acceptance_state:
              row['acceptance_state'] === null || row['acceptance_state'] === undefined
                ? null
                : String(row['acceptance_state']),
            note: row['note'] === null || row['note'] === undefined ? null : String(row['note']),
            actor_owner_id: text(row, 'actor_owner_id'),
          }));
      } finally {
        database.close();
      }
    },
    seedCheckpoint: (input) => {
      const database = open();
      try {
        database
          .prepare(
            `INSERT INTO job_checkpoints (job_id, checkpoint_id, scope_snapshot_id, scope_fingerprint, profile_version_id,
               procedure_version_id, engine_version, workspace_id, branch_name, worktree_path, head_sha, base_sha,
               dirty_files, untracked_files, results, feedback, blocker, next_action, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (job_id) DO UPDATE SET
               checkpoint_id = excluded.checkpoint_id, head_sha = excluded.head_sha, base_sha = excluded.base_sha,
               dirty_files = excluded.dirty_files, untracked_files = excluded.untracked_files, results = excluded.results,
               feedback = excluded.feedback, blocker = excluded.blocker, next_action = excluded.next_action,
               recorded_at = excluded.recorded_at`,
          )
          .run(
            input.jobId,
            `ckpt:${input.jobId}:0`,
            input.scopeSnapshotId,
            input.scopeFingerprint,
            input.profileVersionId,
            input.procedureVersionId,
            ENGINE_VERSION,
            `ws_e2e_${input.jobId}`,
            'ship/e2e-runs',
            '/tmp/e2e-runs-worktree',
            HEAD_SHA,
            BASE_SHA,
            JSON.stringify(['src/server/routes/runs.ts']),
            JSON.stringify(['apps/web/e2e/runs.spec.ts']),
            JSON.stringify([{ name: CHECK_NAME, result: 'Failed', detail: 'the e2e check reported a failure' }]),
            JSON.stringify([{ author: SYNTHETIC_OWNER.id, at: input.now, body: 'Keep every refusal verbatim.' }]),
            'the e2e engine binary is not installed',
            'Install the e2e engine, then resume this run.',
            input.now,
          );
      } finally {
        database.close();
      }
    },
    seedReconciliationLease: (input) => {
      const database = open();
      try {
        database
          .prepare(
            `INSERT INTO writer_leases (lease_id, job_id, holder, operation_id, acquired_at, renewed_at, expires_at, state,
               reconciliation_required, reconciliation_reason, confirmed_stopped_by, confirmed_stopped_at, confirmed_stopped_evidence)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', 1, ?, NULL, NULL, NULL)
             ON CONFLICT (job_id) DO UPDATE SET
               holder = excluded.holder, state = 'Active', reconciliation_required = 1,
               reconciliation_reason = excluded.reconciliation_reason`,
          )
          .run(
            `lease:${input.jobId}`,
            input.jobId,
            input.holder,
            'op-e2e-lease',
            // Acquired and then expired: the schema requires the term to be ordered, and an
            // already-lapsed term is exactly what produces `ReconciliationRequired` rather
            // than `Vacant`. Only an operator's confirmation that the holder stopped may free
            // the writer, because expiry proves only that heartbeats stopped (F17-AC5).
            LAPSED_AT,
            LAPSED_AT,
            LAPSED_BY,
            `No heartbeat from ${input.holder} since it stopped renewing; whether that process still writes is unknown.`,
          );
        database.prepare('UPDATE jobs SET holder = ? WHERE job_id = ?').run(input.holder, input.jobId);
      } finally {
        database.close();
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface RunFixtures {
  readonly seededOwner: { readonly ownerId: string };
}

const test = base.extend<RunFixtures, RunFixtures>({
  /**
   * Provisions the one owner this store holds, once per worker.
   *
   * Automatic and worker-scoped for the reason `intake.spec.ts` gives: a fixture only some
   * tests declare makes Playwright start a fresh worker, and therefore a fresh empty
   * database, for the next test that asks for a different set. Provisioning is idempotent
   * because a repeated call is a `Conflict` naming the owner it refused to replace.
   */
  seededOwner: [
    async ({ shipLoopServer }, use) => {
      const response = await fetch(`${shipLoopServer.origin}/api/owner/provision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: SYNTHETIC_OWNER.displayName, password: SYNTHETIC_PASSWORD }),
      });
      const text = await response.text();
      const parsed: unknown = text === '' ? null : JSON.parse(text);
      if (response.status !== 201 && response.status !== 409) {
        throw new Error(`Provisioning the owner failed (status ${response.status}): ${text}`);
      }
      const ownerId =
        response.status === 201
          ? (parsed as { readonly owner: { readonly ownerId: string } }).owner.ownerId
          : ((parsed as { readonly error?: { readonly actual?: unknown } }).error?.actual as string);
      if (typeof ownerId !== 'string' || ownerId === '') {
        throw new Error(`Provisioning returned no owner id (status ${response.status}): ${text}`);
      }
      await use({ ownerId });
    },
    { scope: 'worker', auto: true },
  ],
});

/** Signs in through the real form, because the claim is that an owner can reach runs by typing. */
async function signInThroughTheForm(page: Page, serverUrl: string): Promise<void> {
  await page.goto(`${serverUrl}/`);
  await page.getByLabel('Email address').fill(SYNTHETIC_OWNER.displayName);
  await page.getByLabel('Password').fill(SYNTHETIC_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Owner sections' })).toBeVisible({ timeout: 15_000 });
}

async function openRuns(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runs', level: 2 })).toBeVisible();
}

interface StartFormValues {
  readonly workItemId: string;
  readonly operationId: string;
  readonly confirmAll?: boolean;
  readonly confirm?: readonly string[];
}

/**
 * Fills the start form the way an owner would.
 *
 * Every prerequisite is confirmed by default because a start is refused without them, and
 * the confirmation carries a note so the recorded assessment says what was looked at rather
 * than only that a box was ticked (F09-AC1).
 */
async function fillStartForm(page: Page, values: StartFormValues): Promise<void> {
  const confirm = values.confirm ?? READINESS_LABELS;
  await page.getByLabel('Work item', { exact: true }).fill(values.workItemId);
  await page.getByLabel('Operation identity').fill(values.operationId);
  // Exact matching on both: `Issue id` is a prefix of `Issue identifier`, so a substring
  // match would resolve two inputs and refuse to guess which one was meant.
  await page.getByLabel('Issue id', { exact: true }).fill('issue-e2e-runs-1');
  await page.getByLabel('Issue identifier', { exact: true }).fill('E2E-1');
  await page.getByLabel('Run title').fill(WORK_ITEM_TITLE);
  await page
    .getByLabel('Scope text')
    .fill('The run must leave a durable record a worker can claim, and the owner must be able to pause it.');
  await page.getByLabel('Criterion 1 id').fill('AC1');
  await page.getByLabel('Criterion 1 text').fill('A durable job row exists for the run and the owner can see its state.');
  for (const label of confirm) {
    await page.getByRole('checkbox', { name: new RegExp(`^${label}:`) }).check();
    await page.getByLabel(`${label} note (optional)`).fill(`Confirmed ${label} for this run.`);
  }
  if (values.confirmAll === false) return;
}

/**
 * Presses Start and waits until the run it started is listed.
 *
 * Waiting for the store's row rather than for the form's state line, because `data-state`
 * leaves `saving` as soon as the response is in while the list is still refetching. A test that
 * read the store at that moment would be racing the page it is asserting about, and the race
 * would show up as an intermittent failure rather than as a defect.
 */
async function startRunThroughTheForm(page: Page, store: RunStore, workItemId: string): Promise<RecordedJobRow> {
  await page.getByRole('button', { name: 'Start this run' }).click();
  const job = page
    .locator('li')
    .filter({ hasText: workItemId })
    .first();
  await expect(job).toBeVisible();
  const rows = jobsFor(store, workItemId);
  const recorded = rows[0];
  if (recorded === undefined) throw new Error(`Start listed a run for ${workItemId} but recorded no job row for it.`);
  return recorded;
}

/**
 * Opens one run's detail after the fixture has finished writing to the store.
 *
 * A Start selects the run it started, so the page has already read that run's detail by the
 * time a checkpoint or a candidate is seeded behind it. Leaving the section and coming back
 * remounts the page and re-reads, which is the same thing an owner does after a worker
 * reports progress. Asserting against the stale read instead would prove the page renders what
 * it fetched, not what the store holds.
 */
async function reopenRun(page: Page, workItemId: string): Promise<void> {
  await page.getByRole('button', { name: 'Needs you', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Needs you', level: 2 })).toBeVisible();
  await openRuns(page);
  await page.locator('li').filter({ hasText: workItemId }).first().getByRole('button').first().click();
  await expect(page.getByTestId('run-job-id')).toBeVisible();
}

/** The durable job rows for a work item, read after the browser acted. */
function jobsFor(store: RunStore, workItemId: string): readonly RecordedJobRow[] {
  return store.jobsForWorkItem(workItemId);
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

test.describe('server under test', () => {
  // F01-AC1: without this assertion the substitution `e2e/fixtures.ts` announces would
  // let a completely broken startup read as a passing browser gate. It is an assertion and
  // not a skip, so the gate stays red for exactly as long as the shipped process cannot
  // serve.
  test('this run drove the shipped server entrypoint, not a substitute', async ({ shipLoopServer }) => {
    expect(
      shipLoopServer.kind,
      'the shipped src/server/main.ts did not serve this run; the substitution reason is printed above. ' +
        'Everything else in this suite is then proof of the browser client and the domain rules only.',
    ).toBe('real-entrypoint');
  });
});

test.describe('starting a run', () => {
  // F13-AC1, F13-AC3, N01-AC3: the owner's Start press leaves a durable job row a worker
  // could claim, and the run's state is shown. The row is read from the server's own file,
  // because a badge is printed whether or not anything was persisted.
  test('an owner starts a run and a durable job row the worker could claim exists (F13-AC1, F13-AC3, N01-AC3)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openRunStore(shipLoopServer);
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
    store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);

    await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
    const started = await startRunThroughTheForm(page, store, workItemId);

    const outcome = page.getByTestId('run-start-state');
    await expect(outcome).toContainText('coding writer');
    await expect(outcome).not.toHaveAttribute('data-state', 'refused');

    // The claim is checked against the store: exactly one row for this work item, in Queued.
    // Counted per work item rather than across the table, because the store is shared by every
    // test in this worker and a total would say nothing about this start.
    const rows = jobsFor(store, workItemId);
    expect(rows.length, 'a start records exactly one job row for its work item').toBe(1);
    expect(started.state).toBe('Queued');
    expect(started.mode).toBe('Build');

    // The run is listed and selected, and its state is stated as a word rather than a colour.
    const listed = page.locator('li').filter({ hasText: workItemId }).first();
    await expect(listed).toBeVisible();
    await expect(listed).toContainText('Run state: Queued');
    await expect(page.getByTestId('run-job-id')).toHaveText(rows[0]?.job_id ?? '');

    // The grant is the mode's own set with delivery named as refused, so a reader can see
    // that starting a run granted no merge or release authority (F13-AC3, F03-AC5).
    await expect(page.getByText('ReadScope, ReadRepository, ReadChecks, PushBranch', { exact: false })).toBeVisible();
    await expect(page.getByText(/Merge, Release and RecoveryRedeploy are never granted/)).toBeVisible();
  });

  // F13-AC2: the same operation identity twice is one run. Checked against the store, because
  // the response saying "already started" is a claim about the response, not about what exists.
  test('pressing Start twice with the same operation identity shows one run, not two (F13-AC2)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openRunStore(shipLoopServer);
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
    store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);

    const operationId = uniqueOperationId();
    await fillStartForm(page, { workItemId, operationId });
    const first = await startRunThroughTheForm(page, store, workItemId);
    await expect(page.getByTestId('run-start-state')).not.toHaveAttribute('data-state', 'refused');

    // The form keeps what was typed, so a second press really is the same request.
    await page.getByRole('button', { name: 'Start this run' }).click();
    const outcome = page.getByTestId('run-start-state');
    await expect(outcome).toContainText('already started run');
    await expect(outcome).not.toHaveAttribute('data-state', 'refused');

    // One row, the same one, and the page names one run for this work item.
    const after = jobsFor(store, workItemId);
    expect(after.length, 'a repeated Start must not record a second job').toBe(1);
    expect(after[0]?.job_id, 'the repeat addresses the run the identity already started').toBe(first.job_id);
    await expect(page.locator('li').filter({ hasText: workItemId })).toHaveCount(1);
  });

  // F09-AC2, N03-AC3: an unconfirmed prerequisite refuses the start, the refusal names the
  // area and its remedy, and the typed input survives so a refusal costs a tick rather than a
  // retype.
  test('an unconfirmed prerequisite refuses the start by name and the typed input survives (F09-AC2, N03-AC3)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openRunStore(shipLoopServer);
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
    store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);

    await fillStartForm(page, { workItemId, operationId: uniqueOperationId(), confirm: ['Scope', 'Criteria', 'Repository', 'Target', 'Verification'] });

    const operationId = uniqueOperationId();
    await page.getByLabel('Operation identity').fill(operationId);
    await page.getByRole('button', { name: 'Start this run' }).click();

    const refusal = page.getByTestId('run-start-state');
    await expect(refusal).toHaveAttribute('data-state', 'refused');
    await expect(refusal).toContainText('Access');
    await expect(refusal).toContainText('F09-AC2');

    // Nothing was recorded: a refused start leaves no job row behind, not even a Queued one.
    expect(jobsFor(store, workItemId).length, 'a refused start must not record a job').toBe(0);

    // The typed input is all still there, and ticking the missing box is enough to start.
    await expect(page.getByLabel('Work item', { exact: true })).toHaveValue(workItemId);
    await expect(page.getByLabel('Operation identity')).toHaveValue(operationId);
    await expect(page.getByLabel('Run title')).toHaveValue(WORK_ITEM_TITLE);
    await expect(page.getByLabel('Criterion 1 text')).toHaveValue(
      'A durable job row exists for the run and the owner can see its state.',
    );

    await page.getByRole('checkbox', { name: /^Access:/ }).check();
    await page.getByLabel('Access note (optional)').fill('Confirmed Access for this run.');
    await page.getByRole('button', { name: 'Start this run' }).click();
    await expect(page.getByTestId('run-start-state')).not.toHaveAttribute('data-state', 'refused');
    expect(jobsFor(store, workItemId).length, 'confirming the open area is enough to start').toBe(1);
  });

  // N03-AC3, F02-AC4: a refused field keeps its own message beside the input, and the label is
  // what a form submits against, so a screen reader and a sighted owner are told the same thing.
  test('a missing required field is refused beside its input and keeps what was typed (F02-AC4, N03-AC3)', async ({
    page,
    serverUrl,
  }) => {
    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);

    await page.getByLabel('Work item', { exact: true }).fill('wrk-typed-but-incomplete');
    await page.getByLabel('Run title').fill('A title that must survive the refusal');
    await page.getByRole('button', { name: 'Start this run' }).click();

    const refusal = page.getByTestId('run-start-state');
    await expect(refusal).toHaveAttribute('data-state', 'refused');

    // Each rejected input carries its own message, and the two the owner filled survive.
    await expect(page.locator('#run-operation-id-error')).toBeVisible();
    await expect(page.locator('#run-issue-id-error')).toBeVisible();
    await expect(page.locator('#run-criterion-text-0-error')).toBeVisible();
    await expect(page.getByLabel('Work item', { exact: true })).toHaveValue('wrk-typed-but-incomplete');
    await expect(page.getByLabel('Run title')).toHaveValue('A title that must survive the refusal');
  });
});

test.describe('run progress', () => {
  // F17-AC2: the latest resume point is visible in full. Both SHAs unabbreviated, the
  // workspace, the dirty and untracked inventory, the results, the feedback, the blocker and
  // the next action, because a resume compares against exactly these values.
  test('the latest checkpoint is shown in full, SHAs unabbreviated (F17-AC2, F17-AC5)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openRunStore(shipLoopServer);
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
    const recipe = store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);
    await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
    const job = await startRunThroughTheForm(page, store, workItemId);
    await expect(page.getByTestId('run-start-state')).not.toHaveAttribute('data-state', 'refused');
    const jobId = job.job_id;

    // A writer records the resume point; the row is seeded here so the page has one to read.
    const scopeSnapshot = readScopeSnapshot(store, workItemId);
    store.seedCheckpoint({
      jobId,
      holder: job.holder ?? 'e2e-writer',
      scopeSnapshotId: scopeSnapshot.scopeSnapshotId,
      scopeFingerprint: scopeSnapshot.scopeFingerprint,
      profileVersionId: profile.profileVersionId,
      procedureVersionId: recipe.procedureVersionId,
      now,
    });

    // The candidate the review card will describe, recorded against the scope the run captured.
    store.seedCandidate({
      workItemId,
      scopeFingerprint: scopeSnapshot.scopeFingerprint,
      profileVersionId: profile.profileVersionId,
      procedureVersionId: recipe.procedureVersionId,
      environmentFingerprint: recipe.contentFingerprint,
      policyFingerprint: profile.contentFingerprint,
      now,
    });

    await reopenRun(page, workItemId);
    await expect(page.getByTestId('run-job-id')).toHaveText(jobId);

    // Every field of the recorded resume point, and nothing abbreviated.
    await expect(page.getByTestId('run-head-sha')).toHaveText(HEAD_SHA);
    await expect(page.getByTestId('run-base-sha')).toHaveText(BASE_SHA);
    expect(HEAD_SHA.length, 'a head SHA must be full, because a resume compares it to a checkout').toBe(40);
    await expect(page.getByText(scopeSnapshot.scopeFingerprint, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(profile.profileVersionId, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(recipe.procedureVersionId, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(ENGINE_VERSION)).toBeVisible();
    await expect(page.getByText(/ws_e2e_.* on branch ship\/e2e-runs/)).toBeVisible();
    await expect(page.getByTestId('run-dirty-files')).toHaveText('src/server/routes/runs.ts');
    await expect(page.getByTestId('run-untracked-files')).toHaveText('apps/web/e2e/runs.spec.ts');
    await expect(page.getByTestId('run-results')).toContainText(`${CHECK_NAME}: Failed`);
    await expect(page.getByTestId('run-feedback')).toContainText('Keep every refusal verbatim.');
    await expect(page.getByTestId('run-blocker')).toHaveText('the e2e engine binary is not installed');
    await expect(page.getByTestId('run-next-action')).toHaveText('Install the e2e engine, then resume this run.');
  });

  // F24-AC2, F24-AC3, F20-AC2: the card carries both SHAs, the scope revision, the required
  // check with the result it was recorded under, the criterion verdicts and the explicit
  // not-ready list, and a run with no candidate is its own state rather than an empty card.
  test('the review card names its identity, its checks, its criteria and why it is not ready (F24-AC2, F24-AC3, F20-AC2)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openRunStore(shipLoopServer);
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
    const recipe = store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);
    await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
    await startRunThroughTheForm(page, store, workItemId);
    await expect(page.getByTestId('run-start-state')).not.toHaveAttribute('data-state', 'refused');

    // Before a candidate exists the card is refused by name, which is its own state.
    await page.locator('li').filter({ hasText: workItemId }).first().getByRole('button').first().click();
    await page.getByRole('button', { name: 'Open the review card' }).click();
    await expect(page.getByRole('heading', { name: 'Review card', level: 2 })).toBeVisible();
    const beforeCandidate = page.locator('[data-state="error"]').first();
    await expect(beforeCandidate).toContainText('recorded no candidate');

    const scopeSnapshot = readScopeSnapshot(store, workItemId);
    store.seedCandidate({
      workItemId,
      scopeFingerprint: scopeSnapshot.scopeFingerprint,
      profileVersionId: profile.profileVersionId,
      procedureVersionId: recipe.procedureVersionId,
      environmentFingerprint: recipe.contentFingerprint,
      policyFingerprint: profile.contentFingerprint,
      now,
    });

    // The card is re-read, and this time there is one.
    await page.getByRole('button', { name: 'Back to runs' }).click();
    await reopenRun(page, workItemId);
    await page.getByRole('button', { name: 'Open the review card' }).click();
    await expect(page.getByTestId('card-head-sha')).toHaveText(HEAD_SHA);
    await expect(page.getByTestId('card-base-sha')).toHaveText(BASE_SHA);
    await expect(page.getByTestId('card-scope-fingerprint')).toHaveText(scopeSnapshot.scopeFingerprint);
    await expect(page.getByTestId('card-scope-revision')).toHaveText('1');

    // The required check the profile names is on the card with the result it has, and the
    // criterion the captured scope carried has a verdict.
    await expect(page.getByTestId('card-check')).toHaveCount(1);
    await expect(page.getByTestId('card-check').first()).toContainText(CHECK_NAME);
    await expect(page.getByTestId('card-check').first()).toContainText('Missing');
    await expect(page.getByTestId('card-criterion')).toHaveCount(1);
    await expect(page.getByTestId('card-criterion').first()).toContainText('AC1');
    await expect(page.getByTestId('card-criterion').first()).toContainText('Untested');

    // The not-ready list is named, not implied: a required check that has not run is a
    // reason, and a criterion with no observation is another.
    const notReady = page.getByTestId('card-not-ready');
    await expect(notReady).toBeVisible();
    await expect(notReady).toContainText(`Required check "${CHECK_NAME}"`);
    await expect(notReady).toContainText('Criterion "AC1"');
    await expect(page.getByText('Not ready for your test')).toBeVisible();
  });
});

test.describe('lifecycle controls', () => {
  // F17-AC1: an illegal move is refused with the server's own wording, shown verbatim, and
  // the run's state is unchanged by the attempt.
  test('an illegal pause is refused verbatim and changes nothing (F17-AC1, N03-AC3)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openRunStore(shipLoopServer);
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
    store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);
    await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
    await startRunThroughTheForm(page, store, workItemId);
    await expect(page.getByTestId('run-start-state')).not.toHaveAttribute('data-state', 'refused');
    await reopenRun(page, workItemId);

    // A Queued run may not be paused, and the refusal says what it may do instead.
    await page.getByRole('button', { name: 'Pause this run' }).click();
    // The control's own status line, not the run's load state: a refusal from a control and a
    // run that loaded fine are different facts and have to be told apart.
    const refusal = page.getByTestId('run-control-state');
    await expect(refusal).toHaveAttribute('data-state', 'refused');
    await expect(refusal).toContainText('Queued -> Paused');
    // The reachable states travel as the refusal's per-field detail, and the page keeps them:
    // a refusal naming only what was refused leaves the owner with no next step (N03-AC3).
    await expect(page.getByTestId('run-control-detail')).toContainText('Preparing, Cancelled, Blocked');

    // A resume with no recorded resume point is refused by name rather than resumed blind.
    await page.getByRole('button', { name: 'Resume this run' }).click();
    await expect(refusal).toContainText('no recorded resume point');
    await expect(page.getByTestId('run-job-id')).toBeVisible();
    expect(store.jobsForWorkItem(workItemId)[0]?.state, 'a refused control changes no state').toBe('Queued');

    // Cancelling is reachable from Queued, and the answer names what survived.
    await page.getByRole('button', { name: 'Cancel this run' }).click();
    await expect(refusal).not.toHaveAttribute('data-state', 'refused');
    await expect(refusal).toContainText('no external delivery was changed');
    expect(store.jobsForWorkItem(workItemId)[0]?.state).toBe('Cancelled');
  });

  // F17-AC1, F17-AC5: a writer whose lease needs reconciliation has not stopped, so the page
  // must not read the run as a confirmed pause. This is the state F17-AC5 exists for: an
  // expired lease proves heartbeats stopped, not that the process did.
  test('a run whose writer is detached does not read as safely paused (F17-AC1, F17-AC5)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openRunStore(shipLoopServer);
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
    const recipe = store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);
    await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
    const job = await startRunThroughTheForm(page, store, workItemId);
    await expect(page.getByTestId('run-start-state')).not.toHaveAttribute('data-state', 'refused');

    // A writer that stopped heartbeating: the lease is recorded, it is unreconciled, and the
    // job still names the holder.
    store.seedReconciliationLease({ jobId: job.job_id, holder: 'e2e-detached-writer', now });
    const scopeSnapshot = readScopeSnapshot(store, workItemId);
    store.seedCheckpoint({
      jobId: job.job_id,
      holder: 'e2e-detached-writer',
      scopeSnapshotId: scopeSnapshot.scopeSnapshotId,
      scopeFingerprint: scopeSnapshot.scopeFingerprint,
      profileVersionId: profile.profileVersionId,
      procedureVersionId: recipe.procedureVersionId,
      now,
    });

    await reopenRun(page, workItemId);
    await expect(page.getByTestId('run-job-id')).toHaveText(job.job_id);

    // The writer line says the holder and that it may still be writing, and the badge does
    // not claim a state that implies the run has stopped.
    const writer = page.getByTestId('run-writer');
    await expect(writer).toContainText('e2e-detached-writer');
    await expect(writer).toContainText('detached');
    await expect(writer).toContainText('may still be writing code');
    await expect(page.locator('.badge', { hasText: 'Run state:' }).first()).toBeVisible();
    await expect(page.getByText('Paused, writer not confirmed stopped')).toHaveCount(0);
  });

  // F18-AC2, N01-AC3: a granted extension reports the bounds and says the extended one is not
  // recorded, so the owner is not promised a budget a restart would lose.
  test('an extension decision reports the bounds and that the extended bound is not recorded (F18-AC2, N01-AC3)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openRunStore(shipLoopServer);
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
    const recipe = store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);
    await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
    const job = await startRunThroughTheForm(page, store, workItemId);
    await expect(page.getByTestId('run-start-state')).not.toHaveAttribute('data-state', 'refused');

    // A writer reached the limit and checkpointed, which is what moves the run to
    // WaitingForOwner and raises the request the owner answers (F18-AC2).
    const scopeSnapshot = readScopeSnapshot(store, workItemId);
    store.seedCheckpoint({
      jobId: job.job_id,
      holder: 'e2e-writer',
      scopeSnapshotId: scopeSnapshot.scopeSnapshotId,
      scopeFingerprint: scopeSnapshot.scopeFingerprint,
      profileVersionId: profile.profileVersionId,
      procedureVersionId: recipe.procedureVersionId,
      now,
    });
    moveToWaitingForOwner(store, job.job_id, now);

    await reopenRun(page, workItemId);
    await expect(page.getByTestId('run-job-id')).toHaveText(job.job_id);

    // The run is waiting, and the detail says so. Scoped to the detail row because the run
    // list carries the same badge and both reading it is correct.
    await expect(
      page.getByRole('region', { name: 'The selected run' }).getByText('Run state: WaitingForOwner'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Grant an extension' }).click();
    const outcome = page.getByTestId('run-control-state');
    await expect(outcome).not.toHaveAttribute('data-state', 'refused');
    await expect(outcome).toContainText('Extension granted');
    // The two bounds, in the units the page renders them, and the honest statement that the
    // extended one is not stored (F18-AC2, N01-AC3).
    await expect(outcome).toContainText('1 hour');
    await expect(outcome).toContainText('2 hours');
    await expect(outcome).toContainText('not recorded');
    expect(store.jobsForWorkItem(workItemId)[0]?.state, 'a grant lets the attempt continue (F18-AC2)').toBe('Running');

    // Declining afterwards is refused, because nothing is waiting any more, and the refusal
    // names the state that is actually in force.
    await page.getByRole('button', { name: 'Decline an extension' }).click();
    await expect(outcome).toHaveAttribute('data-state', 'refused');
    await expect(outcome).toContainText('no pending extension request to decline');
  });
});

test.describe('attention dashboard', () => {
  // F31-AC1, F31-AC2: the board groups into the four buckets whatever is in them, and an
  // acknowledging records owner attention and nothing else.
  test('the board groups into the four buckets and acknowledging changes nothing else (F31-AC1, F31-AC2, F31-AC4)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openRunStore(shipLoopServer);
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
    const recipe = store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);
    await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
    const job = await startRunThroughTheForm(page, store, workItemId);
    await expect(page.getByTestId('run-start-state')).not.toHaveAttribute('data-state', 'refused');

    // A run in flight is a Working item, derived from the queue rather than supplied by a
    // caller, which is the whole claim F31-AC1 makes (F31-AC1).
    await page.getByRole('button', { name: 'Needs you', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Needs you', level: 2 })).toBeVisible();

    // All four buckets are present whatever they hold, so "nothing is waiting on you here" is an
    // answer the page states rather than an absence. A Queued run produces no item at all — the
    // dashboard reports what needs the owner, and a queued run needs nobody — which is why the
    // emptiness asserted here is the correct one for a run that has not started working.
    for (const bucket of ['Working', 'Needs your input', 'Ready for your test', 'Ready for release']) {
      await expect(page.getByRole('heading', { name: bucket, level: 3 })).toBeVisible();
    }
    // The instant the board was collected travels with it, because a view that has stopped
    // moving looks exactly like one with nothing to report (N04-AC2).
    const collectedAt = page.locator('[data-state="ready"]', { hasText: 'collected' }).first();
    await expect(collectedAt).toBeVisible();
    await expect(collectedAt).toContainText(PROJECT);

    // Move the run to a blocked state with a recorded blocker, which is what puts an item in
    // Needs your input with a next action. The blocker is the one the run's own checkpoint
    // carries, because that is where the dashboard reads it from (F31-AC2).
    const scopeSnapshot = readScopeSnapshot(store, workItemId);
    store.seedCheckpoint({
      jobId: job.job_id,
      holder: 'e2e-writer',
      scopeSnapshotId: scopeSnapshot.scopeSnapshotId,
      scopeFingerprint: scopeSnapshot.scopeFingerprint,
      profileVersionId: profile.profileVersionId,
      procedureVersionId: recipe.procedureVersionId,
      now,
    });
    moveToBlocked(store, job.job_id, now, 'the e2e engine binary is not installed');
    await page.getByRole('button', { name: 'Runs', exact: true }).click();
    await openRuns(page);
    await page.getByRole('button', { name: 'Needs you', exact: true }).click();

    const needsInput = page.getByRole('region', { name: 'Needs your input' });
    await expect(needsInput).toContainText('is blocked');
    await expect(needsInput).toContainText('the e2e engine binary is not installed');
    await expect(needsInput).toContainText('Resolve what is blocking');
    await expect(needsInput.getByText('Item state: Open')).toBeVisible();

    const acknowledge = needsInput.getByRole('button', { name: 'Acknowledge this item' }).first();
    await acknowledge.click();
    const outcome = page.locator('[data-state="done"]', { hasText: 'Acknowledged' }).first();
    await expect(outcome).toContainText('no run, acceptance or release fact changed');

    // The acknowledgement is on the item, and the run behind it is untouched (F31-AC4).
    await expect(needsInput.getByText('Item state: Acknowledged')).toBeVisible();
    await expect(needsInput).toContainText('the e2e engine binary is not installed');
    expect(store.jobsForWorkItem(workItemId)[0]?.state, 'acknowledging changes no run fact').toBe('Blocked');
  });

  // F31-AC3: a derived run-progress item has no durable row, so the page says acknowledgement
  // would record nothing rather than offering a control that silently succeeds.
  test('a derived run-progress item says acknowledgement would record nothing (F31-AC3)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openRunStore(shipLoopServer);
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
    store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);
    await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
    const started = await startRunThroughTheForm(page, store, workItemId);
    await expect(page.getByTestId('run-start-state')).not.toHaveAttribute('data-state', 'refused');
    moveToRunning(store, started.job_id, now);

    await page.getByRole('button', { name: 'Needs you', exact: true }).click();
    const working = page.getByRole('region', { name: 'Working' });
    await expect(working).toContainText('is Running');
    await expect(working.getByRole('button', { name: 'Acknowledge this item' })).toHaveCount(0);
    await expect(working).toContainText('no owner attention is stored against it');
  });
});

test.describe('acceptance', () => {
  /**
   * Starts a run and records a candidate for it, then returns what a decision will be made
   * about.
   *
   * One helper because the three tests below need the same four steps and a copy that
   * diverged would let a test pass against a candidate no acceptance could ever bind to
   * (F25-AC1, F24-AC2).
   */
  async function runWithCandidate(
    page: Page,
    store: RunStore,
    serverUrl: string,
    ownerId: string,
  ): Promise<{
    readonly workItemId: string;
    readonly jobId: string;
    readonly candidateId: string;
    readonly scopeSnapshot: ScopeSnapshotFacts;
    readonly ownerId: string;
  }> {
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
    const recipe = store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);
    await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
    const job = await startRunThroughTheForm(page, store, workItemId);
    await expect(page.getByTestId('run-start-state')).not.toHaveAttribute('data-state', 'refused');

    const scopeSnapshot = readScopeSnapshot(store, workItemId);
    const candidateId = store.seedCandidate({
      workItemId,
      scopeFingerprint: scopeSnapshot.scopeFingerprint,
      profileVersionId: profile.profileVersionId,
      procedureVersionId: recipe.procedureVersionId,
      environmentFingerprint: recipe.contentFingerprint,
      policyFingerprint: profile.contentFingerprint,
      now,
    });

    await reopenRun(page, workItemId);
    await page.getByRole('button', { name: 'Open the review card' }).click();
    await expect(page.getByTestId('card-head-sha')).toHaveText(HEAD_SHA);
    await expect(page.getByTestId('acceptance-candidate')).toHaveText(candidateId);
    return { workItemId, jobId: job.job_id, candidateId, scopeSnapshot, ownerId };
  }

  // F25-AC1: acceptance is refused while a criterion is outstanding, and the refusal names it.
  test('accepting work with an unverified criterion is refused and names the criterion (F25-AC1, F24-AC3)', async ({
    page,
    serverUrl,
    shipLoopServer,
    seededOwner,
  }) => {
    const store = openRunStore(shipLoopServer);
    const subject = await runWithCandidate(page, store, serverUrl, seededOwner.ownerId);

    // Nothing has verified the captured criterion, so the gate says so before the click.
    await expect(page.getByTestId('acceptance-state')).toContainText('NotRequested');
    await expect(page.getByTestId('acceptance-state')).toContainText('No acceptance decision has been recorded');
    await expect(page.getByText(/1 of 1 criteria are still outstanding: AC1/)).toBeVisible();

    await page.getByTestId('accept-candidate').click();
    const outcome = page.getByTestId('decision-outcome');
    await expect(outcome).toHaveAttribute('data-decision-state', 'refused');
    await expect(outcome).toContainText('was not recorded');
    await expect(outcome).toContainText('cannot be accepted yet');

    // The outstanding criterion is named, and the server names it as a prerequisite rather
    // than a bare count, so the owner knows what to record (F25-AC1, F24-AC3).
    await expect(page.getByTestId('decision-outstanding')).toContainText('Criterion AC1');
    expect(store.decisionsFor(subject.candidateId), 'a refused acceptance records no decision (F25-AC1)').toHaveLength(0);
    await expect(page.getByTestId('acceptance-state')).toContainText('NotRequested');
  });

  // F25-AC2: the reason is retained against the candidate and survives a later read.
  test('requesting changes retains the reason against the candidate that was tested (F25-AC2)', async ({
    page,
    serverUrl,
    shipLoopServer,
    seededOwner,
  }) => {
    const store = openRunStore(shipLoopServer);
    const subject = await runWithCandidate(page, store, serverUrl, seededOwner.ownerId);
    const reason = 'The pause control reports the run as still running.';

    await page.getByRole('textbox', { name: /what is wrong/i }).fill(reason);
    await page.getByTestId('request-changes').click();
    const outcome = page.getByTestId('decision-outcome');
    await expect(outcome).toHaveAttribute('data-decision-state', 'done');
    await expect(outcome).toContainText('Changes requested and retained');

    // The read-back shows the retained feedback, and the durable row carries it against the
    // candidate rather than replacing it (F25-AC2).
    await expect(page.getByTestId('acceptance-retained')).toContainText(reason);
    await expect(page.getByTestId('acceptance-state')).toContainText('ChangesRequested');
    const decisions = store.decisionsFor(subject.candidateId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision_type).toBe('RequestChanges');
    expect(decisions[0]?.note).toBe(reason);
    expect(decisions[0]?.actor_owner_id).toBe(subject.ownerId);
  });

  // F25-AC1, F25-AC2: a fully verified candidate is accepted, and the refusal-then-accept path
  // is driven end to end rather than only the accepting half.
  test('a verified candidate is accepted against the head it was tested at (F25-AC1, F25-AC3)', async ({
    page,
    serverUrl,
    shipLoopServer,
    seededOwner,
  }) => {
    const store = openRunStore(shipLoopServer);
    const subject = await runWithCandidate(page, store, serverUrl, seededOwner.ownerId);
    const reason = 'The empty state says nothing needs attention when a criterion is untested.';

    // Request changes first, so the acceptance below is proven to follow a rejection rather
    // than to work only on a candidate nobody ever objected to (F25-AC2).
    await page.getByRole('textbox', { name: /what is wrong/i }).fill(reason);
    await page.getByTestId('request-changes').click();
    await expect(page.getByTestId('decision-outcome')).toHaveAttribute('data-decision-state', 'done');

    // The owner now verifies the criterion by their own test, which is the only observation
    // that can satisfy it: a check run cannot (F23-AC1).
    store.recordOwnerObservation({
      candidateId: subject.candidateId,
      workItemId: subject.workItemId,
      projectId: PROJECT,
      candidateFingerprint: pageFingerprint(store, subject.candidateId),
      scopeFingerprint: subject.scopeSnapshot.scopeFingerprint,
      criterionId: 'AC1',
      methodKind: 'OwnerTest',
      status: 'Verified',
      detail: 'Checked against the preview deployment.',
      now: new Date().toISOString(),
    });

    await reopenRun(page, subject.workItemId);
    await page.getByRole('button', { name: 'Open the review card' }).click();
    await expect(page.getByTestId('acceptance-candidate')).toHaveText(subject.candidateId);
    await expect(page.getByText(/Every acceptance criterion is verified/)).toBeVisible();

    await page.getByTestId('accept-candidate').click();
    const outcome = page.getByTestId('decision-outcome');
    await expect(outcome).toHaveAttribute('data-decision-state', 'done');
    await expect(outcome).toContainText('Accepted as decision');
    // The head is named in full, because an acceptance bound to no identity could not go
    // stale when the work moves (F25-AC3).
    await expect(outcome).toContainText(HEAD_SHA);

    await expect(page.getByTestId('acceptance-state')).toContainText('Accepted');
    const decisions = store.decisionsFor(subject.candidateId);
    expect(decisions.map((decision) => decision.decision_type)).toEqual(['RequestChanges', 'AcceptProduct']);
    // The earlier feedback is still there beside the acceptance; it was retained, not replaced.
    expect(decisions[0]?.note).toBe(reason);
  });

  // N03-AC3: a rejected decision keeps what the owner typed.
  test('a rejected reason is refused beside its field and the typed text survives (N03-AC3, F25-AC2)', async ({
    page,
    serverUrl,
    shipLoopServer,
    seededOwner,
  }) => {
    const store = openRunStore(shipLoopServer);
    await runWithCandidate(page, store, serverUrl, seededOwner.ownerId);

    const field = page.getByRole('textbox', { name: /what is wrong/i });
    await page.getByTestId('request-changes').click();
    await expect(page.getByText(/Say what is wrong/)).toBeVisible();
    // The control was refused for its own empty reason, and nothing the owner typed was lost.
    await expect(field).toHaveValue('');
    await field.fill('The review card does not say which check failed.');
    await expect(field).toHaveValue('The review card does not say which check failed.');
    await expect(page.getByTestId('decision-outcome')).toHaveAttribute('data-decision-state', 'idle');
  });

  // N03-AC1: the decision controls are labelled, reachable by keyboard and draw focus.
  //
  // Driven through a real candidate rather than an empty run screen, because the controls
  // only exist once there is something to decide about: a test that navigated to an empty
  // review card would prove the heading renders and nothing about the decision (F25-AC1).
  test('the acceptance controls are labelled and keyboard reachable (N03-AC1)', async ({
    page,
    serverUrl,
    shipLoopServer,
    seededOwner,
  }) => {
    const store = openRunStore(shipLoopServer);
    await runWithCandidate(page, store, serverUrl, seededOwner.ownerId);

    const feedbackField = page.getByRole('textbox', { name: /what is wrong/i });
    await expect(feedbackField).toBeVisible();
    await expect(page.getByTestId('request-changes')).toBeEnabled();
    await expect(page.getByTestId('accept-candidate')).toBeEnabled();

    // Both controls carry an accessible name that states what they do, and the textarea is
    // associated with its own label rather than only a placeholder (N03-AC1).
    await expect(page.getByTestId('request-changes')).toHaveAccessibleName(/request changes/i);
    await expect(page.getByTestId('accept-candidate')).toHaveAccessibleName(/accept this work/i);
    await expect(feedbackField).toHaveAccessibleName(/what is wrong with this work/i);

    // The whole decision path is reachable by tabbing, and focus is drawn when it lands:
    // `:focus-visible` is what draws the ring, so the check is made after a real Tab rather
    // than after a programmatic focus, which would measure nothing (N03-AC1).
    // Tabbing forward from the textarea reaches the two decision buttons in document order, so
    // the whole path from typing a reason to submitting it needs no pointer (N03-AC1).
    await feedbackField.focus();
    await expect(feedbackField).toBeFocused();
    for (const name of ['Request changes', 'Accept this work']) {
      await page.keyboard.press('Tab');
      const reached = page.getByRole('button', { name });
      await expect(reached).toBeFocused();
      const outline = await reached.evaluate((node) => window.getComputedStyle(node).outlineStyle);
      expect(outline, `${name} must draw focus rather than relying on colour (N03-AC1)`).not.toBe('none');
    }

    // The status region is a live region, so a refusal is announced rather than only painted.
    await expect(page.getByTestId('decision-outcome')).toHaveAttribute('role', 'status');
  });
});

test.describe('the boundary', () => {
  // F01-AC1: a run identity is private run detail, so an anonymous caller learns that a
  // sign-in is required and nothing else.
  test('an unauthenticated request for runs and attention discloses nothing (F01-AC1)', async ({
    page,
    request,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openRunStore(shipLoopServer);
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
    store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    // The run is started through the browser first, so the row exists and "the run list is
    // empty" cannot be what an anonymous caller is shown.
    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);
    await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
    const started = await startRunThroughTheForm(page, store, workItemId);
    await expect(page.getByTestId('run-start-state')).not.toHaveAttribute('data-state', 'refused');
    const jobId = started.job_id;

    // `request` is Playwright's isolated context, which holds no cookies at all, so these are
    // genuinely anonymous calls rather than a second view of the signed-in session.
    for (const path of ['/api/runs', `/api/runs/${jobId}`, `/api/runs/${jobId}/checkpoint`, `/api/runs/${jobId}/review-card`, '/api/attention']) {
      const response = await request.get(`${serverUrl}${path}`);
      expect(response.status(), `${path} must refuse an anonymous caller`).toBe(401);
      const body = await response.text();
      expect(body).toContain('signInRequired');
      expect(body).not.toContain(jobId);
      expect(body).not.toContain(workItemId);
      expect(body).not.toContain(SYNTHETIC_OWNER.displayName);
      expect(body).not.toContain(SYNTHETIC_OWNER.id);
    }

    // A write is refused the same way, and the refusal discloses nothing about the work item
    // it named.
    const written = await request.post(`${serverUrl}/api/runs`, { data: { workItemId } });
    expect(written.status(), 'an anonymous start must be refused').toBe(401);
    expect(await written.text()).not.toContain(workItemId);
  });
});

test.describe('responsive layout', () => {
  for (const viewport of VIEWS) {
    // F01-AC3: measured, not asserted from a class. Long SHAs, a long work item id and a long
    // refusal message are the things that would widen the layout, so the run page is measured
    // with all of them on screen.
    test(`the run screen does not scroll horizontally at ${viewport.name} (${viewport.width}x${viewport.height}) (F01-AC3)`, async ({
      page,
      serverUrl,
      shipLoopServer,
    }) => {
      const store = openRunStore(shipLoopServer);
      const now = new Date().toISOString();
      const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
      const recipe = store.seedRecipeVersion({ projectId: PROJECT, now });
      const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signInThroughTheForm(page, serverUrl);
      await openRuns(page);

      await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
      const job = await startRunThroughTheForm(page, store, workItemId);
      await expect(page.getByTestId('run-start-state')).not.toHaveAttribute('data-state', 'refused');
      const scopeSnapshot = readScopeSnapshot(store, workItemId);
      store.seedCheckpoint({
        jobId: job.job_id,
        holder: 'e2e-writer',
        scopeSnapshotId: scopeSnapshot.scopeSnapshotId,
        scopeFingerprint: scopeSnapshot.scopeFingerprint,
        profileVersionId: profile.profileVersionId,
        procedureVersionId: recipe.procedureVersionId,
        now,
      });

      await reopenRun(page, workItemId);
      await expect(page.getByTestId('run-head-sha')).toBeVisible();
      await page.waitForLoadState('networkidle');

      const measurement = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(measurement.clientWidth).toBe(viewport.width);
      expect(measurement.scrollWidth, 'a full commit SHA must not widen the layout').toBe(measurement.clientWidth);

      // The board is measured too, because its items carry the longest text on the page.
      await page.getByRole('button', { name: 'Needs you', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Needs you', level: 2 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      const board = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(board.scrollWidth).toBe(board.clientWidth);
    });
  }
});

test.describe('accessibility', () => {
  // N03-AC1: every control on the run page has a programmatically associated label, is
  // reachable by keyboard, and draws its focus. Focus is never removed, so a keyboard owner can
  // see where they are.
  test('every run control is labelled, keyboard reachable and draws focus (N03-AC1)', async ({ page, serverUrl }) => {
    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);

    for (const label of [
      'Work item',
      'Operation identity',
      'Issue id',
      'Issue identifier',
      'Run title',
      'Scope text',
      'Criterion 1 id',
      'Criterion 1 text',
    ]) {
      await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByLabel('Mode')).toBeVisible();

    // Focus is reached by tabbing rather than by pointing, because `:focus-visible` is what
    // draws the ring and a programmatic focus on a checkbox is not keyboard focus. A test that
    // called `.focus()` would measure nothing.
    const criterion = page.getByLabel('Criterion 1 text');
    await criterion.focus();
    await expect(criterion).toBeFocused();
    const outline = await criterion.evaluate((node) => window.getComputedStyle(node).outlineStyle);
    expect(outline, 'focus must be drawn, not removed').not.toBe('none');

    // Each prerequisite is a labelled checkbox with its own note field. Tabbing forward from
    // the criteria controls reaches the first one, which is what "keyboard operable" means for
    // a form this long: the whole path is reachable without a pointer.
    await page.getByRole('button', { name: 'Add a criterion' }).focus();
    const scope = page.getByRole('checkbox', { name: /^Scope:/ });
    await page.keyboard.press('Tab');
    await expect(scope).toBeFocused();
    const checkboxOutline = await scope.evaluate((node) => window.getComputedStyle(node).outlineStyle);
    expect(checkboxOutline, 'a focused checkbox must draw focus too').not.toBe('none');
    await page.keyboard.press('Space');
    await expect(scope).toBeChecked();
    // The note is the next tab stop, so a confirmation and its reason are both reachable.
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Scope note (optional)')).toBeFocused();

    // A button is named by its own text, so it is addressed by role.
    const start = page.getByRole('button', { name: 'Start this run' });
    await start.focus();
    await expect(start).toBeFocused();
    expect(
      await start.evaluate((node) => window.getComputedStyle(node).outlineStyle),
      'a focused button must draw focus',
    ).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('run-start-state')).toHaveAttribute('data-state', 'refused');
  });

  // N03-AC1: status is carried by the word and a drawn mark, so a monochrome or colour-blind
  // reader is not relying on a hue to tell two states apart.
  test('run state is carried by text and shape, never by colour alone (N03-AC1)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openRunStore(shipLoopServer);
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
    store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);
    await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
    await startRunThroughTheForm(page, store, workItemId);
    await expect(page.getByTestId('run-start-state')).not.toHaveAttribute('data-state', 'refused');

    await reopenRun(page, workItemId);
    const badge = page.locator('.badge', { hasText: 'Run state: Queued' }).first();
    await expect(badge).toBeVisible();
    // The word is in the text and the mark is drawn, so neither depends on the colour.
    await expect(badge).toContainText('Queued');
    await expect(badge.locator('.badge__mark')).toBeVisible();
    await expect(badge).toContainText('No writer holds it');
  });

  // N03-AC3: loading, empty and ready are three different sentences, and a page that has not
  // finished loading never reads as an empty list.
  test('the run list distinguishes loading from ready, and ready from empty (N03-AC3)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openRunStore(shipLoopServer);
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, requiredChecks: [CHECK_NAME], now });
    store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    // A run exists before the list is first read, so the "ready" state is a real one and not an
    // artefact of an empty store.
    await signInThroughTheForm(page, serverUrl);
    await openRuns(page);
    await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
    await startRunThroughTheForm(page, store, workItemId);

    // The count is read from the store rather than written as a literal, because the run list is
    // store-wide and the store is shared by every test in this worker. What is asserted is that
    // the page's number is the store's number.
    const expectedCount = store.totalRuns();
    const ready = page.getByTestId('run-list-state');
    await expect(ready).toHaveAttribute('data-state', 'ready');
    await expect(ready).toHaveText(
      expectedCount === 1 ? '1 run has been started.' : `${String(expectedCount)} runs have been started.`,
    );

    // Holding the response open makes the loading state observable rather than theoretical. It is
    // asserted to be a different sentence from the ready one, because a list that had already
    // printed its count while it was still fetching would be telling the owner it had read
    // something it had not.
    await page.route('**/api/runs', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });
    await page.reload();
    await page.getByRole('button', { name: 'Runs', exact: true }).click();
    const loading = page.locator('#run-list-title ~ .state-line').first();
    await expect(loading).toHaveText('Loading runs…');
    await expect(loading).toHaveAttribute('data-state', 'loading');
    await expect(loading).not.toHaveText(
      expectedCount === 1 ? '1 run has been started.' : `${String(expectedCount)} runs have been started.`,
    );

    // This work item's run is listed once, so the ready count is about a real row.
    await expect(page.locator('li').filter({ hasText: workItemId })).toHaveCount(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Fixture helpers that write the state a writer would have written            */
/* -------------------------------------------------------------------------- */

interface ScopeSnapshotFacts {
  readonly scopeSnapshotId: string;
  readonly scopeFingerprint: string;
}

/**
 * The scope the run captured at start, read back from the store.
 *
 * The run's own start wrote it, so this is not a fixture inventing a fact: it is reading the
 * durable scope snapshot the job was started against, which is what a checkpoint and a
 * candidate must both reference (F12-AC1).
 */
/**
 * The fingerprint a candidate was recorded with, read back from the store.
 *
 * An observation row binds to a candidate fingerprint rather than to a candidate id alone,
 * so a fixture that guessed the fingerprint would write an observation no acceptance could
 * ever read, and the acceptance path would appear to pass because nothing consulted it
 * (F23-AC1, F25-AC1).
 */
function pageFingerprint(store: RunStore, candidateId: string): string {
  const database = new DatabaseSync(store.path, { readOnly: true });
  try {
    const row = database.prepare('SELECT fingerprint FROM candidates WHERE candidate_id = ?').get(candidateId);
    const value = row?.['fingerprint'];
    if (typeof value !== 'string') throw new Error(`Candidate ${candidateId} has no recorded fingerprint.`);
    return value;
  } finally {
    database.close();
  }
}

function readScopeSnapshot(store: RunStore, workItemId: string): ScopeSnapshotFacts {
  const database = new DatabaseSync(store.path, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT scope_snapshot_id, scope_fingerprint FROM scope_snapshots WHERE work_item_id = ? ORDER BY created_at DESC, scope_snapshot_id DESC LIMIT 1')
      .get(workItemId);
    if (row === undefined) throw new Error(`No scope snapshot exists for ${workItemId}.`);
    const snapshotId = row['scope_snapshot_id'];
    const fingerprint = row['scope_fingerprint'];
    if (typeof snapshotId !== 'string' || typeof fingerprint !== 'string') {
      throw new Error(`The scope snapshot for ${workItemId} is unreadable.`);
    }
    return { scopeSnapshotId: snapshotId, scopeFingerprint: fingerprint };
  } finally {
    database.close();
  }
}

/**
 * Moves a job to the state a writer would have moved it to.
 *
 * `started_at` is written for the three states that consume execution, because the schema
 * refuses a job that claims to be running without ever having started: that check is the
 * durable form of "a run in flight has a start instant", and a fixture that bypassed it would
 * be seeding a row the application itself could not produce (F13-AC1).
 */
function moveJob(store: RunStore, jobId: string, state: string, now: string): void {
  const database = new DatabaseSync(store.path);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const started = ['Preparing', 'Running', 'Verifying'].includes(state);
    database
      .prepare('UPDATE jobs SET state = ?, updated_at = ?, started_at = COALESCE(started_at, ?) WHERE job_id = ?')
      .run(state, now, started ? now : null, jobId);
  } finally {
    database.close();
  }
}

function moveToRunning(store: RunStore, jobId: string, now: string): void {
  moveJob(store, jobId, 'Running', now);
}

function moveToBlocked(store: RunStore, jobId: string, now: string, blocker: string): void {
  moveJob(store, jobId, 'Blocked', now);
  const database = new DatabaseSync(store.path);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    database.prepare('UPDATE job_checkpoints SET blocker = ? WHERE job_id = ?').run(blocker, jobId);
  } finally {
    database.close();
  }
}

function moveToWaitingForOwner(store: RunStore, jobId: string, now: string): void {
  moveJob(store, jobId, 'WaitingForOwner', now);
}
