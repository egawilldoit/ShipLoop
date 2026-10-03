/**
 * The review card as the owner reads it, driven through a real browser against the shipped
 * server.
 *
 * Everything here is a measurement, a real request, or a read of the server's own SQLite file.
 * The flow is the owner's: sign in through the form, start a run, open its review card, read
 * the checks and criteria with their evidence, try to record an owner test, request changes,
 * and try to accept while something is unverified (F01-AC1, F24-AC1, F25-AC1).
 *
 * What each test is actually proving, and why it is measured rather than assumed:
 *
 *   - **The shipped entrypoint served this run.** `e2e/fixtures.ts` substitutes a real
 *     in-process server when `main.ts` cannot become ready and announces it on stderr; without
 *     this assertion a completely broken startup would read as a passing gate (F01-AC1).
 *   - **A passing required check is not offered as a criterion's verification.** Seeded with a
 *     `Passed` required check on the card and an automated criterion that nothing observed, and
 *     asserted that the criterion still reads unverified and still appears in the not-ready
 *     list. Reading the card rather than the badge is the point: the card is where a green
 *     result could be mistaken for a satisfied criterion (F23-AC1).
 *   - **An artifact is reachable only through the session.** Asserted three ways: the rendered
 *     href is the session-guarded `/artifacts/` path, the page never prints the filesystem
 *     directory the artifact lives in, and an anonymous request for that exact path is refused.
 *     A second seeded reference that escapes the artifact store is asserted to be shown as text
 *     with no link at all (F01-AC1, F24-AC5, N02-AC2).
 *   - **A missing preview says it is missing.** Asserted as words on the card, because a
 *     preview section that renders without a deployment in it is exactly how an unreachable
 *     preview comes to read as a usable one (F22-AC3).
 *   - **Nothing prefills an owner test.** The outcome control is asserted to start on "Not
 *     recorded yet", and pressing Record with nothing chosen is asserted to record nothing in
 *     the journal. Choosing an outcome and pressing Record is then driven against the
 *     authenticated endpoint this lane does not own; see the note on that test for what the
 *     absence proves and what it does not (F23-AC1, F25-AC4).
 *   - **A refusal names the criterion and keeps the typed reason.** Asserted on the server's own
 *     problem envelope and on the textarea's value afterwards, because a refusal that discards
 *     the reason costs the owner a retype (N03-AC3, F25-AC1, F25-AC2).
 *   - **Neither viewport scrolls sideways.** Measured off `document.documentElement` with the
 *     card fully populated — two full commit SHAs, an artifact path, a criterion text and the
 *     owner-test form on screen — because a CSS class says what was intended and the
 *     measurement says what happened (F01-AC3).
 *   - **Every control is labelled, keyboard reachable and draws focus.** Reached by tabbing,
 *     since `:focus-visible` is what draws the ring and a programmatic focus would measure
 *     nothing (N03-AC1).
 *
 * How the store is seeded is stated rather than hidden. This slice's public surface is the run
 * journey, and nothing in it creates a project profile, an environment recipe, a work item, a
 * candidate or a check observation, so the fixture writes those rows through the same file the
 * server has open. Every seeded identity is computed with the domain's own `canonicalize` and
 * `fingerprint`, because a fingerprint no journal would ever compute would make the card read as
 * stale for that reason alone rather than for the reason under test (F20-AC3).
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalize, fingerprint } from '@shiploop/domain';
import type { Locator, Page } from '@playwright/test';
import { SYNTHETIC_OWNER, SYNTHETIC_PASSWORD, expect, test as base } from './fixtures.ts';

const VIEWS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const PROJECT = 'e2e-review-card-project';
const WORK_ITEM_TITLE = 'E2E review card: one place to judge the work';

/** Full 40-character commit SHAs, because a resume and a diff compare these to a checkout. */
const HEAD_SHA = 'b1c2d3e4f5a60718293a4b5c6d7e8f9012345678';
const BASE_SHA = '9a8b7c6d5e4f30291a2b3c4d5e6f708192a3b4c5';

/** The check the fixture records as passing, with the artifact its run wrote. */
const PASSING_CHECK = 'e2e-review-card-passing';
/** The check the fixture records as failing, whose recorded artifact reference escapes the store. */
const FAILING_CHECK = 'e2e-review-card-failing';
/** The check the profile requires and nothing ever runs. */
const UNRUN_CHECK = 'e2e-review-card-unrun';
const REQUIRED_CHECKS = [PASSING_CHECK, FAILING_CHECK, UNRUN_CHECK] as const;

const OWNER_TEST_CRITERION = 'AC1';
const OWNER_TEST_TEXT = 'The owner can pause the run from the run screen and see the pause take effect.';
const AUTOMATED_CRITERION = 'AC2';
const AUTOMATED_TEXT = 'A durable job row exists for the run and the worker can claim it.';

/** The artifact the passing check wrote, as a path inside the artifact store. */
const ARTIFACT_REFERENCE = 'logs/review-card-check.log';
/** A recorded reference that is not a path inside the artifact store. */
const ESCAPING_REFERENCE = '../../etc/shadow';

const READINESS_LABELS = ['Scope', 'Criteria', 'Repository', 'Target', 'Verification', 'Access'] as const;

let identityCounter = 0;

/** An identity unique to this worker, because the store is shared across every test in the file. */
function uniqueId(prefix: string): string {
  identityCounter += 1;
  return `${prefix}_${String(Date.now())}_${String(identityCounter)}`;
}

function uniqueOperationId(): string {
  return `op-e2e-review-card-${String(Date.now())}-${String(Math.round(Math.random() * 1e6))}`;
}

/* -------------------------------------------------------------------------- */
/* Store access, as a second observer of the file the server has open          */
/* -------------------------------------------------------------------------- */

interface ScopeSnapshotFacts {
  readonly scopeSnapshotId: string;
  readonly scopeFingerprint: string;
}

interface ReviewCardStore {
  readonly path: string;
  seedProfileVersion(input: { readonly projectId: string; readonly now: string }): {
    readonly profileVersionId: string;
    readonly contentFingerprint: string;
  };
  seedRecipeVersion(input: { readonly projectId: string; readonly now: string }): {
    readonly procedureVersionId: string;
    readonly contentFingerprint: string;
  };
  seedWorkItem(input: { readonly projectId: string; readonly profileVersionId: string; readonly now: string }): string;
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
   * Records one check execution exactly as the observation journal writes it.
   *
   * The columns here are the journal's own INSERT rather than a reduced subset, because the
   * review card reads these rows through the shipped journal: a fixture that wrote fewer
   * columns would prove nothing about the check line it is set up for (F20-AC1, F20-AC2).
   */
  seedCheck(input: {
    readonly candidateId: string;
    readonly workItemId: string;
    readonly name: string;
    readonly result: string;
    readonly exitCode: number | null;
    readonly artifactRef: string | null;
    readonly detail: string | null;
    readonly candidateFingerprint: string;
    readonly now: string;
  }): string;
  /**
   * Records one criterion verdict, exactly as `recordCriterion` writes it.
   *
   * `checkId` is filled for an `AutomatedCheck` row and null otherwise, because the schema
   * enforces that correspondence with a CHECK and would refuse anything else. A fixture that
   * guessed would fail loudly rather than quietly write an unattributable verdict (F23-AC1).
   */
  seedCriterion(input: {
    readonly candidateId: string;
    readonly workItemId: string;
    readonly criterionId: string;
    readonly methodKind: string;
    readonly status: string;
    readonly checkId: string | null;
    readonly candidateFingerprint: string;
    readonly scopeFingerprint: string;
    readonly detail: string;
    readonly observedAt: string | null;
    readonly now: string;
  }): void;
  /** The verdict rows on record for a candidate, read back after the browser acted (F23-AC1). */
  criterionStatus(candidateId: string, criterionId: string): string | null;
  decisionsFor(candidateId: string): readonly {
    readonly decision_type: string;
    readonly acceptance_state: string | null;
    readonly note: string | null;
  }[];
}

/**
 * Opens the server's own database as a second writer.
 *
 * WAL is what makes this possible while the server holds the file open, and every write here is
 * short. `busy_timeout` is set explicitly rather than left to a default: a fixture that failed a
 * test because the server happened to hold the write lock at that instant would be a flake, not
 * a finding.
 */
function openReviewCardStore(server: { readonly dataDirectory: string }): ReviewCardStore {
  const path = join(server.dataDirectory, 'shiploop.db');
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
    seedProfileVersion: (input) => {
      const database = open();
      try {
        database
          .prepare('INSERT INTO projects (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id) DO NOTHING')
          .run(input.projectId, input.projectId, input.now, input.now);
        const content = {
          references: {
            repository: 'example.invalid/e2e-synthetic/review-card',
            ticketProvider: 'example.invalid',
            ticketTeamKey: 'E2E',
            baseBranch: 'main',
            targetBranch: 'main',
            deploymentProvider: 'example.invalid',
            engine: 'example.invalid/engine-1',
            previewComponents: [],
          },
          policy: {
            requiredChecks: [...REQUIRED_CHECKS],
            deliveryBehavior: 'ManualAuthorizationOnly',
            maxFixPasses: 2,
            workspaceIsolation: 'WorktreeAndDataDirectory',
            capabilityVersion: 1,
          },
          recipe: 'npm ci && npm test',
          environment: { runtime: 'node-24', ports: [], secretReferences: [] },
        };
        // The domain's own canonicalization and fingerprint, because the fingerprint a recorded
        // result is matched against is computed the same way (F20-AC3).
        const encoded = canonicalize(content);
        const contentFingerprint = fingerprint(content);
        const profileVersionId = uniqueId('prv_e2e_card');
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
          .run(
            profileVersionId,
            input.projectId,
            version,
            version,
            encoded,
            contentFingerprint,
            input.now,
            SYNTHETIC_OWNER.id,
          );
        return { profileVersionId, contentFingerprint };
      } finally {
        database.close();
      }
    },
    seedRecipeVersion: (input) => {
      const database = open();
      try {
        const recipe = {
          recipeId: 'e2e-review-card-recipe',
          version: 1,
          supersedesVersion: null,
          provenance: { source: 'OwnerSaved', scope: 'Environment', createdBy: SYNTHETIC_OWNER.id, createdAt: input.now },
          lastVerification: { state: 'NeverVerified', verifiedAt: null, verifier: null, detail: null },
          requirements: { runtime: { name: 'node', minVersion: '24.0.0', maxVersionExclusive: null }, cpu: { architecture: 'x64', minCores: 1 } },
          dependencyInstall: [],
          serviceStartup: [],
          checks: [],
          ports: [],
          dataLocations: [],
          testAccess: [],
          requiredSecrets: [],
          declaredCapabilities: ['Repository:Read', 'Check:Execute'],
          maintenance: { action: 'Incompatible', command: null, incompatibilityReason: 'The e2e recipe has no maintenance step.' },
        };
        const encoded = canonicalize(recipe);
        const contentFingerprint = fingerprint(recipe);
        const procedureVersionId = uniqueId('prc_e2e_card');
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
        const workItemId = uniqueId('wrk_e2e_card');
        // `adoption_json` and `related_work_item_ids` are canonicalized JSON rather than SQL
        // NULL, because the reader parses both and a NULL where the repository writes the
        // four-character string "null" reads as a corrupt row rather than as "no adoption".
        database
          .prepare(
            `INSERT INTO work_items (work_item_id, project_id, profile_version_id, source, origin, title,
               external_issue_id, external_issue_identifier, external_issue_url, publication_intent,
               publication_state, related_work_item_ids, adoption_json, created_at, updated_at)
             VALUES (?, ?, ?, 'ProposedNewIssue', 'Proposed', ?, NULL, NULL, NULL, 'PublishWhenAgreed',
               'Unpublished', ?, ?, ?, ?)`,
          )
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
        const candidateId = uniqueId('cnd_e2e_card');
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
    seedCheck: (input) => {
      const database = open();
      try {
        // The row identity the journal derives: one execution of one check owns one row, and the
        // same check rerunning for the next candidate gets a new one (F20-AC3).
        const checkId = `chk_e2e_card_${String(identityCounter)}_${input.name}`;
        identityCounter += 1;
        database
          .prepare(
            `INSERT INTO checks (check_id, name, origin, required, result, not_applicable_approved_by_policy,
               candidate_fingerprint, started_at, ended_at, exit_code, artifact_ref, detail_redacted,
               candidate_id, work_item_id, project_id)
             VALUES (?, ?, 'LocalCheck', 1, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            checkId,
            input.name,
            input.result,
            input.candidateFingerprint,
            input.now,
            input.now,
            input.exitCode,
            input.artifactRef,
            input.detail,
            input.candidateId,
            input.workItemId,
            PROJECT,
          );
        return checkId;
      } finally {
        database.close();
      }
    },
    seedCriterion: (input) => {
      const database = open();
      try {
        // Upsert on the journal's own uniqueness key, because `recordCriterion` replaces the
        // verdict for a later observation of the same criterion under the same identity. A
        // fixture that only inserted would collide with the pending verdict the subject already
        // carries, and the second write is exactly the "owner performed the step" transition the
        // accept test needs to stage (F23-AC1).
        database
          .prepare(
            `INSERT INTO evidence (evidence_id, candidate_id, work_item_id, project_id, check_id,
               candidate_fingerprint, scope_fingerprint, criterion_id, method_kind, status, artifact_ref,
               detail_redacted, observed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
             ON CONFLICT (candidate_id, criterion_id, method_kind, candidate_fingerprint) DO UPDATE SET
               status = excluded.status,
               detail_redacted = excluded.detail_redacted,
               observed_at = excluded.observed_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            uniqueId('evd_e2e_card'),
            input.candidateId,
            input.workItemId,
            PROJECT,
            input.checkId,
            input.candidateFingerprint,
            input.scopeFingerprint,
            input.criterionId,
            input.methodKind,
            input.status,
            input.detail,
            input.observedAt,
            input.now,
            input.now,
          );
      } finally {
        database.close();
      }
    },
    criterionStatus: (candidateId, criterionId) => {
      const database = open();
      try {
        const row = database
          .prepare('SELECT status FROM evidence WHERE candidate_id = ? AND criterion_id = ? ORDER BY recorded_at DESC, evidence_id DESC LIMIT 1')
          .get(candidateId, criterionId);
        if (row === undefined) return null;
        const value = row['status'];
        return typeof value === 'string' ? value : null;
      } finally {
        database.close();
      }
    },
    decisionsFor: (candidateId) => {
      const database = open();
      try {
        return database
          .prepare('SELECT decision_type, acceptance_state, note FROM owner_decisions WHERE candidate_id = ? ORDER BY decided_at')
          .all(candidateId)
          .map((row) => ({
            decision_type: text(row, 'decision_type'),
            acceptance_state:
              row['acceptance_state'] === null || row['acceptance_state'] === undefined
                ? null
                : String(row['acceptance_state']),
            note: row['note'] === null || row['note'] === undefined ? null : String(row['note']),
          }));
      } finally {
        database.close();
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface CardFixtures {
  readonly seededOwner: { readonly ownerId: string };
}

const test = base.extend<CardFixtures, CardFixtures>({
  /**
   * Provisions the one owner this store holds, once per worker.
   *
   * Automatic and worker-scoped for the reason the other specs give: a fixture only some tests
   * declare makes Playwright start a fresh worker, and therefore a fresh empty database, for the
   * next test that asks for a different set. Provisioning is idempotent because a repeated call
   * is a `Conflict` naming the owner it refused to replace.
   */
  seededOwner: [
    async ({ shipLoopServer }, use) => {
      const response = await fetch(`${shipLoopServer.origin}/api/owner/provision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: SYNTHETIC_OWNER.displayName, password: SYNTHETIC_PASSWORD }),
      });
      const body = await response.text();
      const parsed: unknown = body === '' ? null : JSON.parse(body);
      if (response.status !== 201 && response.status !== 409) {
        throw new Error(`Provisioning the owner failed (status ${response.status}): ${body}`);
      }
      const ownerId =
        response.status === 201
          ? (parsed as { readonly owner: { readonly ownerId: string } }).owner.ownerId
          : ((parsed as { readonly error?: { readonly actual?: unknown } }).error?.actual as string);
      if (typeof ownerId !== 'string' || ownerId === '') {
        throw new Error(`Provisioning returned no owner id (status ${response.status}): ${body}`);
      }
      await use({ ownerId });
    },
    { scope: 'worker', auto: true },
  ],
});

/** Signs in through the real form, because the claim is that an owner can reach a card by typing. */
async function signInThroughTheForm(page: Page, serverUrl: string): Promise<void> {
  await page.goto(`${serverUrl}/`);
  await page.getByLabel('Email address').fill(SYNTHETIC_OWNER.displayName);
  await page.getByLabel('Password').fill(SYNTHETIC_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Owner sections' })).toBeVisible({ timeout: 15_000 });
}

function readScopeSnapshot(store: ReviewCardStore, workItemId: string): ScopeSnapshotFacts {
  const database = new DatabaseSync(store.path, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT scope_snapshot_id, scope_fingerprint FROM scope_snapshots WHERE work_item_id = ? ORDER BY created_at DESC, scope_snapshot_id DESC LIMIT 1')
      .get(workItemId);
    if (row === undefined) throw new Error(`No scope snapshot exists for ${workItemId}.`);
    const snapshotId = row['scope_snapshot_id'];
    const fingerprintValue = row['scope_fingerprint'];
    if (typeof snapshotId !== 'string' || typeof fingerprintValue !== 'string') {
      throw new Error(`The scope snapshot for ${workItemId} is unreadable.`);
    }
    return { scopeSnapshotId: snapshotId, scopeFingerprint: fingerprintValue };
  } finally {
    database.close();
  }
}

function readCandidateFingerprint(store: ReviewCardStore, candidateId: string): string {
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

interface StartedRun {
  readonly workItemId: string;
  readonly jobId: string;
}

/**
 * Fills the start form the way an owner would, with both acceptance criteria this file needs.
 *
 * The second criterion is added through the page's own control rather than written into the
 * store, so the scope snapshot the card reads is one the shipped start form produced (F12-AC1).
 */
async function fillStartForm(page: Page, values: { readonly workItemId: string; readonly operationId: string }): Promise<void> {
  await page.getByLabel('Work item', { exact: true }).fill(values.workItemId);
  await page.getByLabel('Operation identity').fill(values.operationId);
  await page.getByLabel('Issue id', { exact: true }).fill('issue-e2e-review-card-1');
  await page.getByLabel('Issue identifier', { exact: true }).fill('CARD-1');
  await page.getByLabel('Run title').fill(WORK_ITEM_TITLE);
  await page
    .getByLabel('Scope text')
    .fill('The owner reviews one candidate in one place, and decides about it explicitly.');
  await page.getByLabel('Criterion 1 id').fill(OWNER_TEST_CRITERION);
  await page.getByLabel('Criterion 1 text').fill(OWNER_TEST_TEXT);
  await page.getByRole('button', { name: 'Add a criterion' }).click();
  await page.getByLabel('Criterion 2 id').fill(AUTOMATED_CRITERION);
  await page.getByLabel('Criterion 2 text').fill(AUTOMATED_TEXT);
  for (const label of READINESS_LABELS) {
    await page.getByRole('checkbox', { name: new RegExp(`^${label}:`) }).check();
    await page.getByLabel(`${label} note (optional)`).fill(`Confirmed ${label} for this run.`);
  }
}

/**
 * Starts a run through the form and waits until the page lists it.
 *
 * Waiting for the listed row rather than for the form's state line, because `data-state` leaves
 * `saving` as soon as the response is in while the list is still refetching; a fixture that read
 * the page at that moment would be racing the page it is asserting about (N03-AC3).
 */
async function startRunThroughTheForm(page: Page, store: ReviewCardStore, workItemId: string): Promise<string> {
  await page.getByRole('button', { name: 'Start this run' }).click();
  const listed = page.locator('li').filter({ hasText: workItemId }).first();
  await expect(listed).toBeVisible();
  const database = new DatabaseSync(store.path, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT job_id FROM jobs WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(workItemId);
    const jobId = row?.['job_id'];
    if (typeof jobId !== 'string') {
      throw new Error(`Start listed a run for ${workItemId} but recorded no job row for it.`);
    }
    return jobId;
  } finally {
    database.close();
  }
}

/**
 * Opens one run's review card after the fixture has finished writing to the store.
 *
 * Leaving the section and coming back remounts the page and re-reads, which is what an owner
 * does after a worker reports progress. Asserting against the read the page already made would
 * prove it renders what it fetched rather than what the store holds (N03-AC3).
 */
async function openReviewCard(page: Page, workItemId: string): Promise<void> {
  await page.getByRole('button', { name: 'Needs you', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Needs you', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runs', level: 2 })).toBeVisible();
  await page.locator('li').filter({ hasText: workItemId }).first().getByRole('button').first().click();
  await expect(page.getByTestId('run-job-id')).toBeVisible();
  await page.getByRole('button', { name: 'Open the review card' }).click();
  await expect(page.getByRole('heading', { name: 'Review card', level: 2 })).toBeVisible();
}

interface CandidateSubject {
  readonly workItemId: string;
  readonly jobId: string;
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly scopeSnapshot: ScopeSnapshotFacts;
  /** The row identity of the passing check, which the automated criterion is bound to (F23-AC1). */
  readonly passingCheckRowId: string;
}

/**
 * The candidate this file's tests all read: a run started through the form, a candidate
 * recorded against the scope it captured, one passing check with an artifact, one failing check
 * whose artifact reference escapes the store, one required check nothing ran, and the two
 * criterion verdicts under test.
 *
 * One helper because every test needs the same four facts, and a copy that diverged would let a
 * test pass against a candidate no card could describe (F24-AC2, F25-AC1).
 */
async function subjectWithCandidate(
  page: Page,
  store: ReviewCardStore,
  serverUrl: string,
  artifactDirectory: string,
): Promise<CandidateSubject> {
  const now = new Date().toISOString();
  const profile = store.seedProfileVersion({ projectId: PROJECT, now });
  const recipe = store.seedRecipeVersion({ projectId: PROJECT, now });
  const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

  await signInThroughTheForm(page, serverUrl);
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runs', level: 2 })).toBeVisible();

  await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
  const jobId = await startRunThroughTheForm(page, store, workItemId);
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
  const candidateFingerprint = readCandidateFingerprint(store, candidateId);

  // The artifact the passing check wrote really exists in the store the server serves, so the
  // link under test resolves to a file rather than to a plausible-looking dead reference.
  await mkdir(join(artifactDirectory, 'logs'), { recursive: true });
  await writeFile(join(artifactDirectory, ARTIFACT_REFERENCE), 'e2e review card check log\n', 'utf8');

  const passingCheckRowId = store.seedCheck({
    candidateId,
    workItemId,
    name: PASSING_CHECK,
    result: 'Passed',
    exitCode: 0,
    artifactRef: ARTIFACT_REFERENCE,
    detail: 'the review card e2e check exited zero',
    candidateFingerprint,
    now,
  });
  store.seedCheck({
    candidateId,
    workItemId,
    name: FAILING_CHECK,
    result: 'Failed',
    exitCode: 2,
    artifactRef: ESCAPING_REFERENCE,
    detail: 'the review card e2e check reported a failure',
    candidateFingerprint,
    now,
  });

  store.seedCriterion({
    candidateId,
    workItemId,
    criterionId: OWNER_TEST_CRITERION,
    methodKind: 'OwnerTest',
    status: 'PendingOwnerTest',
    checkId: null,
    candidateFingerprint,
    scopeFingerprint: scopeSnapshot.scopeFingerprint,
    detail: 'The owner has not performed this step yet.',
    observedAt: null,
    now,
  });
  // The automated criterion is bound to the passing check's row and still records no verdict:
  // that is the F23-AC1 case this file exists to prove — a green check is not a criterion.
  store.seedCriterion({
    candidateId,
    workItemId,
    criterionId: AUTOMATED_CRITERION,
    methodKind: 'AutomatedCheck',
    status: 'Untested',
    checkId: passingCheckRowId,
    candidateFingerprint,
    scopeFingerprint: scopeSnapshot.scopeFingerprint,
    detail: 'No observation has been recorded against this criterion.',
    observedAt: null,
    now,
  });

  await openReviewCard(page, workItemId);
  await expect(page.getByTestId('card-head-sha')).toHaveText(HEAD_SHA);
  return { workItemId, jobId, candidateId, candidateFingerprint, scopeSnapshot, passingCheckRowId };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One criterion's row, addressed by its own identity rather than by a substring of its text.
 *
 * A criterion row quotes other criterion ids in its evidence and method text, so a substring
 * match on `AC1` resolves the automated row too and a test would then assert against whichever
 * the DOM answered first. Addressing by the row's own attribute is the only way to name a
 * criterion unambiguously (F24-AC3, N03-AC1).
 */
function criterionRow(page: Page, criterionId: string): Locator {
  return page.locator(`[data-testid="card-criterion"][data-criterion-id="${criterionId}"]`);
}

/** One check's row, addressed the same way (F20-AC2). */
function checkRow(page: Page, checkName: string): Locator {
  return page.locator(`[data-testid="card-check"][data-check-id="${checkName}"]`);
}

test.describe('server under test', () => {
  // F01-AC1: without this assertion the substitution `e2e/fixtures.ts` announces would let a
  // completely broken startup read as a passing browser gate. It is an assertion and not a
  // skip, so the gate stays red for exactly as long as the shipped process cannot serve.
  test('this run drove the shipped server entrypoint, not a substitute', async ({ shipLoopServer }) => {
    expect(
      shipLoopServer.kind,
      'the shipped src/server/main.ts did not serve this run; the substitution reason is printed above. ' +
        'Everything else in this suite is then proof of the browser client and the domain rules only.',
    ).toBe('real-entrypoint');
  });
});

test.describe('what the card shows', () => {
  // F24-AC1, F20-AC1, F20-AC2, F24-AC3: the candidate identity in full, every check the profile
  // requires with its result and origin, every criterion with its method and status, and the
  // explicit not-ready list.
  test('the card names the candidate, every required check with its origin, and why it is not ready (F24-AC1, F20-AC1, F20-AC2, F24-AC3)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openReviewCardStore(shipLoopServer);
    await subjectWithCandidate(page, store, serverUrl, shipLoopServer.artifactDirectory);

    // The identity is in full: two unabbreviated SHAs, the scope fingerprint and the revision.
    // An abbreviated SHA cannot be compared to a checkout, so it cannot go on a card (F20-AC3).
    await expect(page.getByTestId('card-head-sha')).toHaveText(HEAD_SHA);
    await expect(page.getByTestId('card-base-sha')).toHaveText(BASE_SHA);
    expect(HEAD_SHA.length, 'a head SHA must be full, because a diff compares it to a checkout').toBe(40);
    await expect(page.getByTestId('card-scope-fingerprint')).not.toBeEmpty();
    await expect(page.getByTestId('card-scope-revision')).toHaveText('1');
    await expect(page.getByTestId('card-diff')).toContainText(HEAD_SHA);
    await expect(page.getByTestId('card-diff')).toContainText(BASE_SHA);

    // The linked work and the three provider links the card has no address for are stated, so
    // the owner is not handed a link row that opens nothing (F24-AC5).
    await expect(page.getByTestId('card-issue-link')).toContainText('No issue address is reported');
    await expect(page.getByTestId('card-pr-link')).toContainText('No pull request identity is reported');
    await expect(page.getByTestId('card-diff-link')).toContainText('No provider diff URL is reported');

    // All three required checks appear: a pass with its origin, a failure, and one nothing ran.
    // The third is the F20-AC2 case — a gate nobody ran is Missing, not absent and not Passed.
    const checks = page.getByTestId('card-check');
    await expect(checks).toHaveCount(3);
    const passing = checkRow(page, PASSING_CHECK);
    await expect(passing).toContainText('Passed');
    await expect(passing).toContainText('Recorded by LocalCheck');
    await expect(checkRow(page, FAILING_CHECK)).toContainText('Failed');
    const unrun = checkRow(page, UNRUN_CHECK);
    await expect(unrun).toContainText('Missing');
    await expect(unrun).toContainText('No run has reported where this check would run');
    await expect(page.getByText('Not ready for your test')).toBeVisible();

    // Both criteria appear with their method and their status, and the not-ready list names the
    // reasons rather than leaving the reader to infer them (F24-AC3, F23-AC1).
    const criteria = page.getByTestId('card-criterion');
    await expect(criteria).toHaveCount(2);
    await expect(criterionRow(page, OWNER_TEST_CRITERION)).toContainText('PendingOwnerTest');
    await expect(criterionRow(page, OWNER_TEST_CRITERION)).toContainText('Verification method: OwnerTest');
    await expect(criterionRow(page, AUTOMATED_CRITERION)).toContainText('Untested');
    const notReady = page.getByTestId('card-not-ready');
    await expect(notReady).toContainText(`Required check "${FAILING_CHECK}"`);
    await expect(notReady).toContainText(`Required check "${UNRUN_CHECK}"`);
    await expect(notReady).toContainText(`Criterion "${AUTOMATED_CRITERION}"`);
  });

  // F23-AC1: the passing required check is on the card and green, and the automated criterion is
  // still unverified. This is the assertion that green CI does not claim every criterion.
  test('a passing required check is not offered as the verification of an unobserved criterion (F23-AC1)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openReviewCardStore(shipLoopServer);
    const subject = await subjectWithCandidate(page, store, serverUrl, shipLoopServer.artifactDirectory);

    const passing = checkRow(page, PASSING_CHECK);
    await expect(passing).toContainText('Passed');

    // The criterion is bound to that check's row and still records no verdict, so it reads
    // Untested and appears in the not-ready list. Both halves matter: a card that quietly
    // promoted it would show the badge, and a card that dropped it would hide the gap.
    const criterion = criterionRow(page, AUTOMATED_CRITERION);
    await expect(criterion).toContainText('Untested');
    await expect(criterion).toContainText('Verification method: AutomatedCheck');
    // The verdict row exists and records no observation time, so it cannot be read as a fresh
    // verdict for anything; the sentence says so rather than presenting an evidence identity on
    // its own (F23-AC1, F23-AC3).
    await expect(criterion.locator('[data-testid="criterion-evidence"]')).toContainText(
      'with no recorded observation time',
    );
    await expect(page.getByTestId('card-not-ready')).toContainText(`Criterion "${AUTOMATED_CRITERION}" is Untested`);

    // The row states the reason out loud rather than leaving it to be inferred from the badge.
    await expect(
      page.getByTestId('criterion-method').filter({ hasText: 'AutomatedCheck' }),
    ).toContainText('no other check on this card is being offered as its verification');

    // It also names the check it *is* bound to, so the binding is visible rather than inferred,
    // and says in the same breath that this check did not verify it (F23-AC1).
    await expect(criterion).toHaveAttribute('data-verification-check', PASSING_CHECK);
    await expect(criterion.locator('[data-testid="criterion-method"]')).toContainText(
      `bound to check "${PASSING_CHECK}"`,
    );
    await expect(criterion.locator('[data-testid="criterion-verification"]')).toContainText(
      `Check "${PASSING_CHECK}" is bound to this criterion and recorded Untested, so it has not verified it`,
    );

    // The failing check is not offered either, and the criteria panel states how much of the card
    // can name its own verification rather than implying all of it (F23-AC1, F24-AC3).
    const body = await page.locator('body').innerText();
    expect(body, 'the failing check must not be offered as a criterion verification').not.toContain(
      `Check "${FAILING_CHECK}" is bound`,
    );
    await expect(page.getByTestId('card-criteria-coverage')).toContainText('1 of 2 criteria name the check');
    await expect(criterionRow(page, OWNER_TEST_CRITERION)).toHaveAttribute('data-verification-check', '');
    expect(subject.passingCheckRowId.length, 'the fixture bound the criterion to a real check row').toBeGreaterThan(0);
  });

  // F01-AC1, F24-AC5, N02-AC2: an artifact is reachable only through the session-guarded path,
  // never as a filesystem path, and a reference that escapes the store is not linked at all.
  test('an artifact is offered only as a session-guarded path, and an escaping reference is not linked (F01-AC1, F24-AC5, N02-AC2)', async ({
    page,
    request,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openReviewCardStore(shipLoopServer);
    await subjectWithCandidate(page, store, serverUrl, shipLoopServer.artifactDirectory);

    // The passing check's artifact renders as a link into the guarded prefix.
    const link = page.getByTestId('artifact-link');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', `/artifacts/${ARTIFACT_REFERENCE}`);
    await expect(page.getByTestId('artifact-recorded')).toContainText(ARTIFACT_REFERENCE);

    // The filesystem location the artifact lives in never reaches the page: the link is a store
    // path, and printing the host directory would disclose the server's layout (N02-AC2).
    const body = await page.locator('body').innerText();
    expect(body, 'the artifact store directory must not appear on the card').not.toContain(shipLoopServer.artifactDirectory);

    // And the guarded path is genuinely guarded: the same URL from an anonymous context, which
    // holds no cookies at all, is refused rather than served (F01-AC1).
    const anonymous = await request.get(`${serverUrl}/artifacts/${ARTIFACT_REFERENCE}`);
    expect(anonymous.status(), 'an artifact must refuse an anonymous caller').toBe(401);
    expect(await anonymous.text()).not.toContain('e2e review card check log');

    // The failing check recorded a reference that is not inside the store. It is shown as
    // recorded text with an explanation and no href, because a link that escaped the store
    // would either resolve somewhere else or disclose a host path (F24-AC5, N02-AC2).
    const escaping = page.getByTestId('artifact-unlinkable');
    await expect(escaping).toHaveCount(1);
    await expect(escaping).toContainText(ESCAPING_REFERENCE);
    await expect(escaping).toContainText('cannot be opened as a link');
    expect(
      await page.locator(`[href*="${ESCAPING_REFERENCE}"]`).count(),
      'an escaping artifact reference must never become an href',
    ).toBe(0);
  });

  // F22-AC3, F24-AC5: a preview the owner cannot reach says so. A section with a heading and no
  // deployment in it is exactly how a missing preview comes to read as a usable one.
  test('a preview that is not recorded says so rather than reading as usable (F22-AC3, F23-AC4, F24-AC5)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openReviewCardStore(shipLoopServer);
    await subjectWithCandidate(page, store, serverUrl, shipLoopServer.artifactDirectory);

    await expect(page.getByTestId('card-preview-state')).toContainText('Preview: none recorded');
    await expect(page.getByTestId('card-preview-access')).toContainText('No deployment is recorded against this candidate');
    await expect(page.getByTestId('card-preview-link')).toContainText('No preview URL is reported');
    // No anchor is offered for a preview that does not exist, so there is nothing to open by
    // accident and no link that would resolve to the owner's shell instead (F24-AC5).
    expect(
      await page.getByTestId('card-preview-link').locator('a').count(),
      'a missing preview must not be offered as a link',
    ).toBe(0);

    // The owner-test steps reuse the same sentence, so the two cannot disagree about whether
    // there is anything deployed to test against (F23-AC4).
    await expect(page.getByTestId('owner-test-where')).toHaveText(
      await page.getByTestId('card-preview-access').innerText(),
    );
  });
});

test.describe('the owner test control', () => {
  // F23-AC1, F25-AC4, N03-AC3: the control is offered, nothing is prefilled, pressing it with
  // nothing chosen records nothing, and a refused save keeps everything the owner typed.
  //
  // The authenticated owner-test endpoint is owned by another lane and is not on this branch, so
  // this test drives the client through it and records what the server actually answers. What it
  // proves is the half this lane owns: the control exists, is labelled and reachable, starts on
  // "Not recorded yet", refuses to record without a chosen outcome, and preserves the typed
  // outcome, environment and note when the write is refused. What it cannot prove is that a
  // recorded owner test reaches the journal through HTTP, because no such route exists yet; the
  // accept test below therefore records the owner's observation through the journal itself and
  // says so.
  test('the owner test control records nothing by default and keeps typed input when refused (F23-AC1, F25-AC4, N03-AC3)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openReviewCardStore(shipLoopServer);
    const subject = await subjectWithCandidate(page, store, serverUrl, shipLoopServer.artifactDirectory);

    // Exactly one criterion is assigned to the owner's test, and its steps are on the card.
    const blocks = page.getByTestId('owner-test-criterion');
    await expect(blocks).toHaveCount(1);
    await expect(blocks).toContainText(OWNER_TEST_CRITERION);
    await expect(blocks).toContainText('Step 1: what to check');
    await expect(blocks).toContainText(OWNER_TEST_TEXT);
    await expect(page.getByTestId('owner-test-build')).toContainText(HEAD_SHA);
    await expect(page.getByTestId('owner-test-build')).toContainText(subject.candidateFingerprint);

    // Nothing is prefilled: the outcome select starts on the explicit "not recorded" option and
    // the card says nothing has been recorded for this criterion (F23-AC1, F25-AC4).
    const outcome = page.getByTestId('owner-test-observation');
    await expect(outcome).toHaveValue('');
    await expect(outcome.locator('option[value=""]')).toHaveText('Not recorded yet');
    await expect(page.getByTestId('owner-test-status')).toContainText('Nothing has been recorded for AC1');

    // Pressing Record with nothing chosen is refused by the client, writes nothing to the
    // journal, and leaves the criterion exactly as it was (F23-AC1).
    await page.getByTestId('owner-test-record').click();
    await expect(page.getByTestId('owner-test-status')).toContainText('Choose the outcome you observed');
    expect(
      store.criterionStatus(subject.candidateId, OWNER_TEST_CRITERION),
      'an unchosen outcome must not record a verdict (F23-AC1)',
    ).toBe('PendingOwnerTest');

    // With an outcome and a note typed, the write goes to the authenticated endpoint. On this
    // branch no such route exists, so the server refuses it; the typed outcome, environment and
    // note must all survive, and nothing may be recorded (N03-AC3, F23-AC1).
    await outcome.selectOption('BehaviorConfirmed');
    await page.getByTestId('owner-test-environment').selectOption('Local');
    const note = 'I paused the run and the state line changed to Paused.';
    await page.getByTestId('owner-test-note').fill(note);
    await page.getByTestId('owner-test-record').click();
    await expect(page.getByTestId('owner-test-status')).toContainText('Your owner test was not recorded');

    await expect(outcome).toHaveValue('BehaviorConfirmed');
    await expect(page.getByTestId('owner-test-environment')).toHaveValue('Local');
    await expect(page.getByTestId('owner-test-note')).toHaveValue(note);
    expect(
      store.criterionStatus(subject.candidateId, OWNER_TEST_CRITERION),
      'a refused owner test must leave the criterion unverified (F23-AC1, F25-AC1)',
    ).toBe('PendingOwnerTest');
    // And the card still refuses acceptance, which is what a pending owner test means (F24-AC3).
    await expect(criterionRow(page, OWNER_TEST_CRITERION)).toContainText('PendingOwnerTest');
  });

  // F24-AC1, F24-AC3, F23-AC1: a criterion nothing is assigned to the owner for produces an
  // empty state, not a recording control. Offering to record against a criterion whose method is
  // not OwnerTest would let the caller pick the weaker verification for its own work.
  test('a criterion with no owner-test method offers no recording control (F23-AC1)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openReviewCardStore(shipLoopServer);
    const now = new Date().toISOString();
    const profile = store.seedProfileVersion({ projectId: PROJECT, now });
    const recipe = store.seedRecipeVersion({ projectId: PROJECT, now });
    const workItemId = store.seedWorkItem({ projectId: PROJECT, profileVersionId: profile.profileVersionId, now });

    await signInThroughTheForm(page, serverUrl);
    await page.getByRole('button', { name: 'Runs', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Runs', level: 2 })).toBeVisible();
    await fillStartForm(page, { workItemId, operationId: uniqueOperationId() });
    await startRunThroughTheForm(page, store, workItemId);
    await expect(page.getByTestId('run-start-state')).not.toHaveAttribute('data-state', 'refused');
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

    await openReviewCard(page, workItemId);
    await expect(page.getByTestId('owner-test-empty')).toContainText('No criterion on this candidate is assigned the OwnerTest method');
    await expect(page.getByTestId('owner-test-record')).toHaveCount(0);
  });
});

test.describe('the owner decision', () => {
  // F25-AC1, F24-AC3: acceptance is refused while a criterion is outstanding, and the refusal
  // names which criterion rather than reporting a count.
  test('accepting while a criterion is outstanding is refused and names it (F25-AC1, F24-AC3)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openReviewCardStore(shipLoopServer);
    const subject = await subjectWithCandidate(page, store, serverUrl, shipLoopServer.artifactDirectory);

    // The gate is stated before the click, from the server, not computed by the page.
    await expect(page.getByTestId('acceptance-state')).toContainText('No acceptance decision has been recorded');
    await expect(page.getByText(/2 of 2 criteria are still outstanding/)).toBeVisible();

    await page.getByTestId('accept-candidate').click();
    const outcome = page.getByTestId('decision-outcome');
    await expect(outcome).toHaveAttribute('data-decision-state', 'refused');
    await expect(outcome).toContainText('was not recorded');

    // Both outstanding criteria are named, including the one a green check might have suggested
    // was satisfied (F23-AC1, F25-AC1).
    const outstanding = page.getByTestId('decision-outstanding');
    await expect(outstanding).toContainText(`Criterion ${OWNER_TEST_CRITERION}`);
    await expect(outstanding).toContainText(`Criterion ${AUTOMATED_CRITERION}`);
    expect(
      store.decisionsFor(subject.candidateId),
      'a refused acceptance records no decision, so nothing can read as accepted (F25-AC1)',
    ).toHaveLength(0);
  });

  // F25-AC2: the reason is retained against the candidate that was tested and survives a read.
  test('requesting changes retains the reason against the tested candidate (F25-AC2, N03-AC3)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openReviewCardStore(shipLoopServer);
    const subject = await subjectWithCandidate(page, store, serverUrl, shipLoopServer.artifactDirectory);
    const reason = 'The card does not say which check failed, so I cannot tell whether to fix or wait.';

    await page.getByRole('textbox', { name: /what is wrong/i }).fill(reason);
    await page.getByTestId('request-changes').click();
    await expect(page.getByTestId('decision-outcome')).toHaveAttribute('data-decision-state', 'done');
    await expect(page.getByTestId('decision-outcome')).toContainText('Changes requested and retained');

    await expect(page.getByTestId('acceptance-retained')).toContainText(reason);
    await expect(page.getByTestId('acceptance-state')).toContainText('ChangesRequested');
    const decisions = store.decisionsFor(subject.candidateId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision_type).toBe('RequestChanges');
    expect(decisions[0]?.note, 'the feedback is stored against the candidate, not discarded (F25-AC2)').toBe(reason);
  });

  // N03-AC3: a refused decision keeps what the owner typed instead of making them retype it.
  test('a refused reason is refused beside its field and the typed text survives (N03-AC3, F25-AC2)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openReviewCardStore(shipLoopServer);
    await subjectWithCandidate(page, store, serverUrl, shipLoopServer.artifactDirectory);

    const field = page.getByRole('textbox', { name: /what is wrong/i });
    await page.getByTestId('request-changes').click();
    await expect(page.getByText(/Say what is wrong/)).toBeVisible();
    await expect(field).toHaveValue('');
    await field.fill('The review card does not say which check failed.');
    await expect(field).toHaveValue('The review card does not say which check failed.');
    await expect(page.getByTestId('decision-outcome')).toHaveAttribute('data-decision-state', 'idle');
  });

  // F25-AC1, F25-AC2, F25-AC3: once every criterion is verified the candidate is accepted against
  // the head it was tested at, and the earlier feedback is still on record beside it.
  //
  // The owner's observation for AC1 is written through the journal rather than through HTTP,
  // because the owner-test route is owned by another lane and does not exist on this branch. The
  // columns are the journal's own, and AC2 is bound to the passing check's row, so this is the
  // state the recording control would produce rather than a fixture's guess at it (F23-AC1).
  test('a candidate whose criteria are all verified is accepted against the head it was tested at (F25-AC1, F25-AC3)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openReviewCardStore(shipLoopServer);
    const subject = await subjectWithCandidate(page, store, serverUrl, shipLoopServer.artifactDirectory);
    const reason = 'The empty state said nothing needed attention when a criterion was untested.';

    await page.getByRole('textbox', { name: /what is wrong/i }).fill(reason);
    await page.getByTestId('request-changes').click();
    await expect(page.getByTestId('decision-outcome')).toHaveAttribute('data-decision-state', 'done');

    const now = new Date().toISOString();
    store.seedCriterion({
      candidateId: subject.candidateId,
      workItemId: subject.workItemId,
      criterionId: OWNER_TEST_CRITERION,
      methodKind: 'OwnerTest',
      status: 'Verified',
      checkId: null,
      candidateFingerprint: subject.candidateFingerprint,
      scopeFingerprint: subject.scopeSnapshot.scopeFingerprint,
      detail: 'Paused the run from the run screen and saw the state change.',
      observedAt: now,
      now,
    });
    store.seedCriterion({
      candidateId: subject.candidateId,
      workItemId: subject.workItemId,
      criterionId: AUTOMATED_CRITERION,
      methodKind: 'AutomatedCheck',
      status: 'Verified',
      checkId: subject.passingCheckRowId,
      candidateFingerprint: subject.candidateFingerprint,
      scopeFingerprint: subject.scopeSnapshot.scopeFingerprint,
      detail: 'The durable job row was read back after the run started.',
      observedAt: now,
      now,
    });

    await openReviewCard(page, subject.workItemId);
    await expect(page.getByText('Every acceptance criterion is verified')).toBeVisible();
    await expect(criterionRow(page, OWNER_TEST_CRITERION)).toContainText('Verified');
    await expect(criterionRow(page, OWNER_TEST_CRITERION).locator('[data-testid="criterion-evidence"]')).toContainText('Evidence');

    await page.getByTestId('accept-candidate').click();
    const outcome = page.getByTestId('decision-outcome');
    await expect(outcome).toHaveAttribute('data-decision-state', 'done');
    await expect(outcome).toContainText('Accepted as decision');
    // The head is named in full, because an acceptance bound to no identity could not go stale
    // when the work moves (F25-AC3).
    await expect(outcome).toContainText(HEAD_SHA);

    await expect(page.getByTestId('acceptance-state')).toContainText('Accepted');
    await expect(page.getByTestId('decision-observed-deployments')).toContainText(
      'Your acceptance recorded no deployment, so nothing about this acceptance rests on a deployed environment',
    );
    const decisions = store.decisionsFor(subject.candidateId);
    expect(decisions.map((decision) => decision.decision_type)).toEqual(['RequestChanges', 'AcceptProduct']);
    expect(decisions[0]?.note, 'the earlier feedback is retained, not replaced (F25-AC2)').toBe(reason);
  });
});

test.describe('responsive layout', () => {
  for (const viewport of VIEWS) {
    // F01-AC3: measured, not asserted from a class, with the whole card populated — two full
    // commit SHAs, a scope fingerprint, an artifact path, two criterion texts and the owner-test
    // form. Those are the elements that would widen the layout at 375px.
    test(`the review card does not scroll horizontally at ${viewport.name} (${viewport.width}x${viewport.height}) (F01-AC3)`, async ({
      page,
      serverUrl,
      shipLoopServer,
    }) => {
      const store = openReviewCardStore(shipLoopServer);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await subjectWithCandidate(page, store, serverUrl, shipLoopServer.artifactDirectory);
      await expect(page.getByTestId('owner-test-record')).toBeVisible();
      await page.waitForLoadState('networkidle');

      const measurement = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(measurement.clientWidth).toBe(viewport.width);
      expect(measurement.scrollWidth, 'a full commit SHA or an artifact path must not widen the card').toBe(
        measurement.clientWidth,
      );
    });
  }
});

test.describe('accessibility', () => {
  // N03-AC1: the whole owner-test path is labelled, reachable by tabbing and draws focus, and the
  // acceptance controls follow it in document order. Focus is reached by tabbing because
  // `:focus-visible` is what draws the ring; a programmatic focus would measure nothing.
  test('the owner-test and decision controls are labelled, keyboard reachable and draw focus (N03-AC1)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openReviewCardStore(shipLoopServer);
    await subjectWithCandidate(page, store, serverUrl, shipLoopServer.artifactDirectory);

    // Every control carries an accessible name that states what it is for (N03-AC1).
    await expect(page.getByTestId('owner-test-observation')).toHaveAccessibleName(
      `Observation for ${OWNER_TEST_CRITERION}`,
    );
    await expect(page.getByTestId('owner-test-environment')).toHaveAccessibleName(
      `Environment for ${OWNER_TEST_CRITERION}`,
    );
    await expect(page.getByTestId('owner-test-note')).toHaveAccessibleName(
      `What you saw for ${OWNER_TEST_CRITERION} (optional)`,
    );
    await expect(page.getByTestId('owner-test-record')).toHaveAccessibleName(
      `Record my owner test for ${OWNER_TEST_CRITERION}`,
    );

    // Tabbing forward from the outcome select reaches the environment, the note and the record
    // control in that order, so the whole recording path needs no pointer (N03-AC1).
    await page.getByTestId('owner-test-observation').focus();
    for (const testId of ['owner-test-environment', 'owner-test-note', 'owner-test-record']) {
      await page.keyboard.press('Tab');
      const reached = page.getByTestId(testId);
      await expect(reached).toBeFocused();
      const outline = await reached.evaluate((node) => window.getComputedStyle(node).outlineStyle);
      expect(outline, `${testId} must draw focus rather than relying on colour (N03-AC1)`).not.toBe('none');
    }

    // The record control is a real button, so it is activated from the keyboard.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('owner-test-status')).toContainText('Choose the outcome you observed');

    // The decision controls follow the owner-test path and remain reachable, and the outcome
    // region is a live region so a refusal is announced rather than only painted (N03-AC1).
    await page.getByTestId('request-changes').focus();
    await expect(page.getByTestId('request-changes')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('accept-candidate')).toBeFocused();
    await expect(page.getByTestId('decision-outcome')).toHaveAttribute('role', 'status');
  });

  // N03-AC1: status is carried by the word and a drawn mark. The three check states a reviewer
  // must be able to separate — passed, failed, never run — are asserted as text on the card, and
  // the badge's tone is asserted alongside so the colour is a duplicate of the word rather than
  // the carrier of it.
  test('check and criterion status is carried by text and shape, never by colour alone (N03-AC1, F20-AC2)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const store = openReviewCardStore(shipLoopServer);
    await subjectWithCandidate(page, store, serverUrl, shipLoopServer.artifactDirectory);

    for (const [name, result, tone] of [
      [PASSING_CHECK, 'Passed', 'healthy'],
      [FAILING_CHECK, 'Failed', 'revoked'],
      [UNRUN_CHECK, 'Missing', 'degraded'],
    ] as const) {
      const line = checkRow(page, name);
      await expect(line).toContainText(`${name}: ${result}`);
      const badge = line.locator('.badge');
      await expect(badge).toHaveAttribute('data-tone', tone);
      // The mark is a drawn element, not a coloured background alone (N03-AC1).
      expect(await badge.locator('.badge__mark').count()).toBe(1);
    }

    const criterion = criterionRow(page, OWNER_TEST_CRITERION);
    await expect(criterion).toContainText(`${OWNER_TEST_CRITERION}: PendingOwnerTest`);
    await expect(criterion.locator('.badge')).toHaveAttribute('data-tone', 'pending');
  });
});