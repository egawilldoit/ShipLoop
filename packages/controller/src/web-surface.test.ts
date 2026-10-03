/**
 * The seam between the controller and the HTTP layer (F01-AC1, F01-AC2).
 *
 * Every other file in this package is tested against doubles. That is correct for
 * use cases and it is exactly why the web server and this controller had never run
 * in the same process: each half was green, and `main.ts` still refused to start
 * because the module it loaded did not answer the port it declared. A defect that
 * only exists at a boundary cannot be found by testing either side of it, so this
 * file drives the real composition root through the real adapter and checks its
 * shape.
 *
 * The port is transcribed below rather than imported. `apps/web` depends on
 * `@shiploop/controller`, so importing the package the other way is a cycle, and
 * `scripts/lint.mjs` forbids a `packages/**` file importing from `apps/` at all —
 * a policy this repository enforces rather than a limitation to route around.
 * The transcription is the structural half of the port and nothing else: the method
 * names and their arities. Two consequences are stated rather than papered over:
 *
 *   - the compile-time half of the conformance check cannot live here, because the
 *     port's types cannot be named from this package. `ControllerSurface` in
 *     `web-surface.ts` is the local declaration, and it is what the assignment in
 *     the first test proves;
 *   - the run-time half against the web package's OWN `isControllerSurface` is
 *     proven outside this repository, where the import is allowed: booting
 *     `apps/web/src/server/main.ts` with `SHIPLOOP_CONTROLLER_MODULE` pointed at
 *     this package, and driving a real sign-in and a real authorized request
 *     through it. That evidence lives with the boundary, which neither side owns.
 *
 * What this file does prove, on its own: the surface answers the transcribed port,
 * the specifier `main.ts` writes resolves to a surface from inside `apps/web`, and
 * every use case behind that surface reads and writes the real migrated schema.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  DEFAULT_ABSOLUTE_SESSION_TTL_SECONDS,
  authorizeSession,
  generateSessionToken,
  hashSessionToken,
  type CapabilityKind,
  type ConnectorId,
  type OwnerId,
  type ProjectId,
} from '@shiploop/domain';
import { createCompositionRoot } from './composition.ts';
import type { CompositionRoot } from './composition.ts';
import type { AdapterRegistry, ConnectorProbe } from './connectors.ts';
import type { ControllerClock } from './profiles.ts';
import type { MvpEvidenceProjection } from './mvp-review-card.ts';
import type { ReviewCardCriterion } from './verification.ts';
import type { ControllerSurface, SurfaceReviewCard } from './web-surface.ts';
import { bindControllerSurface, createControllerSurface, resolveSurfaceRoot } from './web-surface.ts';

const NOW = '2026-10-01T09:00:00.000Z';
const PASSWORD = 'correct horse battery staple';
const DISPLAY_NAME = 'Solo Owner';
const PROJECT_ID = '0a5f1c22-0000-4000-8000-000000000a1a' as ProjectId;
const IDLE_SECONDS = 900;
const ABSOLUTE_TTL_SECONDS = 28_800;

const clock: ControllerClock = { now: () => NOW };
const FAST_PASSWORD_COST = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16 };

/**
 * `REQUIRED_METHODS` from `apps/web/src/server/contracts.ts`, transcribed.
 *
 * Kept as data rather than inlined into one assertion so a missing method is named
 * the way the web server's own guard names it.
 */
const REQUIRED_METHODS = {
  owners: ['provision', 'signIn', 'describe', 'selectActiveProject'],
  projects: ['listProjects', 'createProject'],
  contracts: [
    'createRequest',
    'getRequest',
    'listRequests',
    'updateRequest',
    'draftContract',
    'getContract',
    'listContractRevisions',
    'listContractCriteria',
    'editContract',
    'approveRevision',
    'reviseContract',
    'invalidateRevision',
  ],
  handoff: ['buildHandoff'],
  mvpReview: ['getReview', 'decide'],
  sessions: ['loadByToken', 'create', 'revoke', 'touch'],
  profiles: ['saveVersion', 'currentVersion', 'listVersions'],
  connectors: ['register', 'listForProject', 'revoke'],
  // Declared here for the same reason it is declared in `contracts.ts`: a group the port
  // requires and this surface omits would be a use case no transport can reach, which is how
  // generation shipped implemented and invisible (L02-AC2).
  settings: ['readSettings', 'updateSettings'],
  intake: [
    'captureIdea',
    'listIdeas',
    'getIdea',
    'attachFile',
    'recordSummary',
    'archiveIdea',
    'deferIdea',
    'findRelatedWork',
    'recordRelatedWorkChoice',
    'draftBrief',
    'agreeBrief',
    'askClarifyingQuestions',
    'answerClarifyingQuestion',
    'applyOwnerCorrection',
    'exportIdea',
  ],
  runs: ['startRun', 'listRuns', 'getRun', 'pauseRun', 'resumeRun', 'cancelRun', 'grantExtension', 'declineExtension'],
  attention: ['collectAttention', 'acknowledge'],
  reviewCards: ['buildReviewCard'],
  acceptance: ['requestChanges', 'recordAcceptance', 'currentAcceptance', 'acceptanceGate'],
  ownerTests: ['recordOwnerObservation', 'listOwnerObservations'],
  planning: [
    'draftPlan',
    'getPlan',
    'editPlan',
    'listPlansForIdea',
    'assessPlan',
    'publishPlan',
    'reconcilePublication',
    'adoptExistingIssue',
    'linkExistingChange',
    'requestAdoptedEvaluation',
  ],
  generation: ['startBriefGeneration', 'startPlanGeneration', 'getGeneration', 'listGenerations'],
} as const satisfies Record<keyof ControllerSurface, readonly string[]>;

/**
 * The web package's own structural guard, transcribed.
 *
 * Deliberately the same shape and the same order as the original: it answers false
 * on the first missing method, so a partial surface reports the group it is
 * incomplete in rather than a generic failure.
 */
function satisfiesTranscribedPort(value: unknown): value is ControllerSurface {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  for (const group of Object.keys(REQUIRED_METHODS) as (keyof typeof REQUIRED_METHODS)[]) {
    const port = candidate[group];
    if (typeof port !== 'object' || port === null) return false;
    const methods = port as Record<string, unknown>;
    for (const method of REQUIRED_METHODS[group]) {
      if (typeof methods[method] !== 'function') return false;
    }
  }
  return true;
}

/**
 * `ReviewCardCriterion`'s fields, transcribed from `apps/web/src/server/contracts.ts`.
 *
 * The web server loads this controller as external input and checks it structurally at run time,
 * so nothing in the compiler ties the two declarations together: a criterion field added here
 * and not there, or dropped there and kept here, would reach the browser as a silent mismatch
 * rather than as a failure. `REVIEW_CARD_CRITERION_MATCHES` is the guard, and it is the same
 * shape of guard as `satisfiesTranscribedPort` — the assertion states the rule and the types
 * carry it (F23-AC1, F24-AC3).
 *
 * The three `verification*` fields are the ones this exists for. Without them the card reports a
 * verdict per criterion and no identity for it, which is what lets a passing check read as the
 * verification of a criterion it never observed.
 */
const REVIEW_CARD_CRITERION_FIELDS = [
  'criterionId',
  'text',
  'methodKind',
  'status',
  'evidenceId',
  'observedAt',
  'detail',
  'verificationCheckId',
  'verificationEvidenceId',
  'verificationDetail',
] as const satisfies readonly (keyof SurfaceReviewCard['criteria'][number])[];

/** The two declarations must name the same fields in both directions, or the guard is `never`. */
type ReviewCardCriterionKey = keyof ReviewCardCriterion;
type TranscribedCriterionKey = (typeof REVIEW_CARD_CRITERION_FIELDS)[number];
type ReviewCardCriterionMatch = [Exclude<ReviewCardCriterionKey, TranscribedCriterionKey>] extends [never]
  ? [Exclude<TranscribedCriterionKey, ReviewCardCriterionKey>] extends [never]
    ? true
    : never
  : never;

/** The surface projection carries the same fields as the card it transcribes, by construction. */
type SurfaceCriterionKey = keyof SurfaceReviewCard['criteria'][number];
type SurfaceCriterionMatch = [Exclude<SurfaceCriterionKey, ReviewCardCriterionKey>] extends [never]
  ? [Exclude<ReviewCardCriterionKey, SurfaceCriterionKey>] extends [never]
    ? true
    : never
  : never;

const REVIEW_CARD_CRITERION_MATCHES: ReviewCardCriterionMatch & SurfaceCriterionMatch = true;

/**
 * `ReviewEvidenceView` from `apps/web/src/server/contracts.ts`, transcribed.
 *
 * This list exists for one reason: an evidence row carries two outcomes and only one of
 * them may be shown as this candidate's result. `recordedOutcome` is what the source said
 * and stays `passed` after a push; `currentOutcome` is `stale` once the binding no longer
 * holds; `countsForCurrentCandidate` is the affirmative answer to "may this be shown as
 * this candidate's result?". A bare `outcome` on the wire is the defect this guards,
 * because a client that reaches for it renders a stale pass in green (F20-AC3, F24-AC3).
 */
const REVIEW_EVIDENCE_FIELDS = [
  'evidenceId',
  'source',
  'criterionId',
  'checkId',
  'recordedOutcome',
  'currentOutcome',
  'countsForCurrentCandidate',
  'staleReasons',
  'reason',
  'observedAt',
  'candidateHeadSha',
  'contractRevision',
  'detail',
  'artifactRef',
] as const satisfies readonly (keyof MvpEvidenceProjection)[];

/** The transcription and the projection must name the same fields, in both directions. */
type MvpEvidenceKey = keyof MvpEvidenceProjection;
type TranscribedEvidenceKey = (typeof REVIEW_EVIDENCE_FIELDS)[number];
type ReviewEvidenceMatch = [Exclude<TranscribedEvidenceKey, MvpEvidenceKey>] extends [never]
  ? [Exclude<MvpEvidenceKey, TranscribedEvidenceKey>] extends [never]
    ? true
    : never
  : never;

const REVIEW_EVIDENCE_MATCHES: ReviewEvidenceMatch = true;

const DECLARED: Readonly<Record<'Ticket' | 'Git' | 'Deployment' | 'Engine', readonly CapabilityKind[]>> = {
  Ticket: ['Ticket:ReadScope', 'Ticket:UpdateManagedProgress'],
  Git: ['Git:ReadRepository', 'Git:ReadChecks', 'Git:PushBranch'],
  Deployment: ['Deployment:Discover', 'Deployment:ReadIdentity'],
  Engine: ['Engine:VersionCheck', 'Engine:StartScoped'],
};

function declaration(kind: CapabilityKind): {
  kind: CapabilityKind;
  supported: boolean;
  limitation: string | null;
  privileged: boolean;
  supportsPrecondition: boolean;
} {
  return { kind, supported: true, limitation: null, privileged: false, supportsPrecondition: false };
}

const adapters: AdapterRegistry = {
  declarationsFor(kind): readonly ReturnType<typeof declaration>[] {
    return DECLARED[kind].map(declaration);
  },
  probeFor(): ConnectorProbe | null {
    return null;
  },
};

/**
 * A real root on a real migrated file, plus a surface bound to it.
 *
 * `migrate` runs inside `createCompositionRoot`, so the rows these tests read and
 * write are the production schema's rows and not a fixture that agrees with it by
 * coincidence (F01-AC1).
 */
async function withSurface(
  body: (surface: ControllerSurface, root: CompositionRoot) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-web-surface-'));
  try {
    const opened = createCompositionRoot({
      databasePath: join(directory, 'shiploop.db'),
      clock,
      adapters,
      passwordParameters: FAST_PASSWORD_COST,
      sessionIdleTimeoutSeconds: IDLE_SECONDS,
    });
    assert.ok(opened.ok, `the root must open: ${opened.ok ? '' : opened.error.reason}`);
    try {
      await body(bindControllerSurface(opened.value), opened.value);
    } finally {
      opened.value.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a real root answers the transcribed port, by type and at run time (F01-AC1)', async () => {
  await withSurface(async (surface) => {
    // The compile-time half: a surface whose methods or fields drifted from
    // `ControllerSurface` would not typecheck here. The run-time half follows.
    const asPort: ControllerSurface = surface;
    assert.ok(satisfiesTranscribedPort(asPort), 'the transcribed port guard must accept the real surface');
  });
});

// F23-AC1, F24-AC3: the criterion the web contract declares and the criterion this projection
// emits must be the same criterion. A field the projection drops is a verification identity the
// browser never sees, and nothing else in the pipeline would notice.
test('the criterion the web contract declares is the criterion this projection emits (F23-AC1, F24-AC3)', () => {
  assert.equal(
    REVIEW_CARD_CRITERION_MATCHES,
    true,
    `the transcription and the projection disagree about a criterion field; ` +
      `transcribed: ${REVIEW_CARD_CRITERION_FIELDS.join(', ')}`,
  );
  assert.deepEqual(
    [...REVIEW_CARD_CRITERION_FIELDS],
    [
      'criterionId',
      'text',
      'methodKind',
      'status',
      'evidenceId',
      'observedAt',
      'detail',
      'verificationCheckId',
      'verificationEvidenceId',
      'verificationDetail',
    ],
    'the verification identity is three fields, and dropping any of them is the defect this guards',
  );
});

// F20-AC3, F24-AC3: the two outcomes an evidence row carries must reach the browser under names
// that cannot be confused, and no bare `outcome` may appear. The transport refuses a card whose
// evidence rows disagree with themselves about staleness; this proves the shape it refuses
// against, so a rename that reintroduces the ambiguous field fails here rather than in a client.
test('the evidence row the web contract declares names both outcomes and no bare outcome (F20-AC3, F24-AC3)', () => {
  assert.equal(
    REVIEW_EVIDENCE_MATCHES,
    true,
    `the transcription and the projection disagree about an evidence field; transcribed: ${REVIEW_EVIDENCE_FIELDS.join(', ')}`,
  );
  assert.ok(
    !REVIEW_EVIDENCE_FIELDS.includes('outcome' as (typeof REVIEW_EVIDENCE_FIELDS)[number]),
    'a bare `outcome` is what a stale pass would be rendered from, so the wire must not carry one',
  );
  assert.deepEqual(
    REVIEW_EVIDENCE_FIELDS.filter((field) => field.endsWith('Outcome') || field === 'countsForCurrentCandidate'),
    ['recordedOutcome', 'currentOutcome', 'countsForCurrentCandidate'],
    'the three fields that decide whether a result may be shown are the three that must travel',
  );
});

test('the module the web server loads passes its own structural check (F01-AC1)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-web-surface-load-'));
  const previousDatabasePath = process.env['SHIPLOOP_DATABASE_PATH'];
  process.env['SHIPLOOP_DATABASE_PATH'] = join(directory, 'shiploop.db');
  try {
    // `main.ts` writes the specifier `@shiploop/controller` and lets Node resolve
    // it from inside `apps/web`. Resolving it the same way, from the same parent,
    // is the only faithful reproduction: a relative import of this package's own
    // entry would skip the very step that failed.
    const fromWebServer = createRequire(new URL('../../../apps/web/src/server/main.ts', import.meta.url));
    const specifier = fromWebServer.resolve('@shiploop/controller');

    // The loader in `main.ts`, reproduced: import the specifier, take the default
    // export when there is one, and check the result. `buildApp` is not reproduced,
    // because the assertion is about the shape that reaches it.
    const loaded: unknown = await import(pathToFileURL(specifier).href);
    const candidate =
      typeof loaded === 'object' && loaded !== null && 'default' in loaded
        ? (loaded as { readonly default?: unknown }).default
        : loaded;
    assert.ok(
      satisfiesTranscribedPort(candidate),
      '@shiploop/controller must load as a controller surface, or apps/web cannot start',
    );
    const surface = candidate as ControllerSurface;
    assert.equal(typeof surface.owners.signIn, 'function');
    assert.equal(typeof surface.sessions.loadByToken, 'function');

    const refused = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(refused.ok, `the loaded surface must reach the real store: ${refused.ok ? '' : refused.error.reason}`);
    assert.equal(refused.value.displayName, DISPLAY_NAME);
  } finally {
    if (previousDatabasePath === undefined) delete process.env['SHIPLOOP_DATABASE_PATH'];
    else process.env['SHIPLOOP_DATABASE_PATH'] = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a missing store is refused by name rather than guessed at (F01-AC1)', () => {
  const previous = process.env['SHIPLOOP_DATABASE_PATH'];
  delete process.env['SHIPLOOP_DATABASE_PATH'];
  try {
    const resolved = resolveSurfaceRoot(process.env);
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.match(resolved.error.reason, /SHIPLOOP_DATABASE_PATH/);
  } finally {
    if (previous !== undefined) process.env['SHIPLOOP_DATABASE_PATH'] = previous;
  }
});

test('a surface built from an unusable resolver refuses every call and throws none (F01-AC1)', async () => {
  const refusal = createControllerSurface(() => ({
    ok: false,
    error: { code: 'Unavailable', reason: 'the store is not open' },
  }));
  const loaded = await refusal.sessions.loadByToken(generateSessionToken());
  assert.equal(loaded.ok, false);
  assert.equal(await refusal.profiles.listVersions(PROJECT_ID).then((value) => value.ok), false);
});

test('a token minted by the web layer authorizes through the real stored row (F01-AC2)', async () => {
  await withSurface(async (surface) => {
    const provisioned = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(provisioned.ok);

    // Exactly what `routes/owner.ts` does: mint here, digest with the domain
    // function, and hand the controller a digest.
    const token = generateSessionToken();
    const granted = await surface.owners.signIn({
      identifier: DISPLAY_NAME,
      password: PASSWORD,
      tokenDigest: hashSessionToken(token),
      issuedAt: NOW,
      absoluteTtlSeconds: ABSOLUTE_TTL_SECONDS,
      idleTimeoutSeconds: IDLE_SECONDS,
    });
    assert.ok(granted.ok, `sign-in must succeed: ${granted.ok ? '' : granted.error.reason}`);
    assert.equal(granted.value.session.tokenDigest, hashSessionToken(token));
    assert.equal(granted.value.session.lastActivityAt, NOW, 'a new session must carry an activity instant');

    const loaded = await surface.sessions.loadByToken(token);
    assert.ok(loaded.ok, 'the minted token must resolve to its row');
    assert.equal(loaded.value.sessionId, granted.value.session.sessionId);

    const authorized = authorizeSession({
      sessionId: loaded.value.sessionId,
      token,
      storedDigest: loaded.value.tokenDigest,
      issuedAt: loaded.value.issuedAt,
      expiresAt: loaded.value.expiresAt,
      revokedAt: loaded.value.revokedAt,
      lastActivityAt: loaded.value.lastActivityAt,
      idleTimeoutSeconds: IDLE_SECONDS,
      now: '2026-10-01T09:00:30.000Z',
    });
    assert.ok(authorized.ok, `the stored row must authorize the real token: ${authorized.ok ? '' : authorized.error}`);

    const wrongToken = authorizeSession({
      sessionId: loaded.value.sessionId,
      token: generateSessionToken(),
      storedDigest: loaded.value.tokenDigest,
      issuedAt: loaded.value.issuedAt,
      expiresAt: loaded.value.expiresAt,
      revokedAt: loaded.value.revokedAt,
      lastActivityAt: loaded.value.lastActivityAt,
      idleTimeoutSeconds: IDLE_SECONDS,
      now: NOW,
    });
    assert.equal(wrongToken.ok, false, 'a digest must not authorize a token that did not produce it (F01-AC2)');
  });
});

test('a revoked session is refused on the same real path, and revocation is durable (F01-AC2)', async () => {
  await withSurface(async (surface, root) => {
    const provisioned = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(provisioned.ok);

    const token = generateSessionToken();
    const granted = await surface.owners.signIn({
      identifier: DISPLAY_NAME,
      password: PASSWORD,
      tokenDigest: hashSessionToken(token),
      issuedAt: NOW,
      absoluteTtlSeconds: ABSOLUTE_TTL_SECONDS,
      idleTimeoutSeconds: IDLE_SECONDS,
    });
    assert.ok(granted.ok);

    const revoked = await surface.sessions.revoke({
      sessionId: granted.value.session.sessionId,
      revokedAt: '2026-10-01T09:00:15.000Z',
    });
    assert.ok(revoked.ok, 'revoking an established session must succeed');
    assert.equal(revoked.value.revokedAt, '2026-10-01T09:00:15.000Z');

    const afterRevocation = await surface.sessions.loadByToken(token);
    assert.ok(afterRevocation.ok, 'a revoked session must still resolve, so the domain can refuse it');
    const refused = authorizeSession({
      sessionId: afterRevocation.value.sessionId,
      token,
      storedDigest: afterRevocation.value.tokenDigest,
      issuedAt: afterRevocation.value.issuedAt,
      expiresAt: afterRevocation.value.expiresAt,
      revokedAt: afterRevocation.value.revokedAt,
      lastActivityAt: afterRevocation.value.lastActivityAt,
      idleTimeoutSeconds: IDLE_SECONDS,
      now: '2026-10-01T09:00:20.000Z',
    });
    assert.equal(refused.ok, false, 'a correct token must not restore a revoked session (F01-AC2)');
    if (!refused.ok) assert.equal(refused.error, 'Revoked');

    const stored = root.owners.findSessionByToken(token);
    assert.ok(stored.ok);
    assert.equal(stored.value?.revokedAt, '2026-10-01T09:00:15.000Z', 'the row itself must carry the revocation');
  });
});

test('a configured idle timeout reaches the stored row and can close the session (F01-AC2)', async () => {
  await withSurface(async (surface, root) => {
    const provisioned = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(provisioned.ok);

    const token = generateSessionToken();
    const granted = await surface.owners.signIn({
      identifier: DISPLAY_NAME,
      password: PASSWORD,
      tokenDigest: hashSessionToken(token),
      issuedAt: NOW,
      absoluteTtlSeconds: ABSOLUTE_TTL_SECONDS,
      idleTimeoutSeconds: IDLE_SECONDS,
    });
    assert.ok(granted.ok);
    const session = granted.value.session;

    // The deadline is the earlier of the two limits, so a caller that configures a
    // short idle limit gets that limit in the row rather than the domain's default.
    assert.equal(
      session.expiresAt,
      new Date(Date.parse(NOW) + IDLE_SECONDS * 1000).toISOString(),
      'the caller\'s idle limit must be what the stored deadline says, not the domain default',
    );
    assert.notEqual(
      session.expiresAt,
      new Date(Date.parse(NOW) + DEFAULT_ABSOLUTE_SESSION_TTL_SECONDS * 1000).toISOString(),
      'a deadline equal to the domain default would mean the configured limit was ignored (F01-AC2)',
    );

    const authorize = (now: string, lastActivityAt: string | null): ReturnType<typeof authorizeSession> =>
      authorizeSession({
        sessionId: session.sessionId,
        token,
        storedDigest: session.tokenDigest,
        issuedAt: session.issuedAt,
        expiresAt: session.expiresAt,
        revokedAt: null,
        lastActivityAt,
        idleTimeoutSeconds: IDLE_SECONDS,
        now,
      });

    assert.equal(
      authorize('2026-10-01T09:14:59.000Z', session.lastActivityAt).ok,
      true,
      'a session inside its configured limit must stay usable',
    );
    assert.equal(
      authorize('2026-10-01T09:15:00.000Z', session.lastActivityAt).ok,
      false,
      'the configured limit must actually close the session (F01-AC2)',
    );

    // The write the request guard makes on every authorized request.
    const touched = await surface.sessions.touch({
      sessionId: session.sessionId,
      lastActivityAt: '2026-10-01T09:14:30.000Z',
    });
    assert.deepEqual(touched, { ok: true, value: null });
    const moved = root.owners.findSessionByToken(token);
    assert.ok(moved.ok);
    assert.equal(moved.value?.lastSeenAt, '2026-10-01T09:14:30.000Z', 'the column must move, or the limit is inert');
  });
});

test('reducing the configured idle limit closes a session that was created under a longer one (F01-AC2)', async () => {
  await withSurface(async (surface) => {
    const provisioned = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(provisioned.ok);

    // The session is opened under a long limit, so its stored deadline is long too.
    const token = generateSessionToken();
    const granted = await surface.owners.signIn({
      identifier: DISPLAY_NAME,
      password: PASSWORD,
      tokenDigest: hashSessionToken(token),
      issuedAt: NOW,
      absoluteTtlSeconds: ABSOLUTE_TTL_SECONDS,
      idleTimeoutSeconds: ABSOLUTE_TTL_SECONDS,
    });
    assert.ok(granted.ok);
    const session = granted.value.session;

    // The guard reads the currently configured limit on every request, so an
    // operator who shortens it reaches a point where the stored deadline is still
    // open and the activity comparison is the thing that refuses. That is the one
    // situation the activity column decides, and before it was written the column
    // was never consulted at all.
    const tightened = (now: string, lastActivityAt: string): ReturnType<typeof authorizeSession> =>
      authorizeSession({
        sessionId: session.sessionId,
        token,
        storedDigest: session.tokenDigest,
        issuedAt: session.issuedAt,
        expiresAt: session.expiresAt,
        revokedAt: null,
        lastActivityAt,
        idleTimeoutSeconds: 60,
        now,
      });

    assert.equal(tightened('2026-10-01T09:00:30.000Z', NOW).ok, true);
    assert.equal(tightened('2026-10-01T09:01:00.000Z', NOW).ok, false);
    const expired = tightened('2026-10-01T09:01:00.000Z', NOW);
    if (!expired.ok) assert.equal(expired.error, 'IdleExpired');

    // Recording activity is what lets the same session continue under the new limit.
    const touched = await surface.sessions.touch({
      sessionId: session.sessionId,
      lastActivityAt: '2026-10-01T09:01:00.000Z',
    });
    assert.deepEqual(touched, { ok: true, value: null });
    assert.equal(tightened('2026-10-01T09:01:30.000Z', '2026-10-01T09:01:00.000Z').ok, true);
  });
});

test('an unknown identifier and a wrong password are one answer (N02-AC1)', async () => {
  await withSurface(async (surface) => {
    const provisioned = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(provisioned.ok);

    const attempt = async (identifier: string, password: string) =>
      surface.owners.signIn({
        identifier,
        password,
        tokenDigest: hashSessionToken(generateSessionToken()),
        issuedAt: NOW,
        absoluteTtlSeconds: ABSOLUTE_TTL_SECONDS,
        idleTimeoutSeconds: IDLE_SECONDS,
      });

    const unknown = await attempt('nobody-with-this-name', PASSWORD);
    const wrongPassword = await attempt(DISPLAY_NAME, 'a different long password value');
    assert.equal(unknown.ok, false);
    assert.equal(wrongPassword.ok, false);
    if (!unknown.ok && !wrongPassword.ok) {
      assert.equal(unknown.error.code, 'Forbidden');
      assert.equal(unknown.error.reason, wrongPassword.error.reason, 'sign-in must not be an existence oracle');
    }
  });
});

test('an owner row with no activity instant is refused rather than read as no limit (F01-AC2)', async () => {
  await withSurface(async (surface, root) => {
    const provisioned = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(provisioned.ok);
    const token = generateSessionToken();
    const granted = await surface.owners.signIn({
      identifier: DISPLAY_NAME,
      password: PASSWORD,
      tokenDigest: hashSessionToken(token),
      issuedAt: NOW,
      absoluteTtlSeconds: ABSOLUTE_TTL_SECONDS,
      idleTimeoutSeconds: IDLE_SECONDS,
    });
    assert.ok(granted.ok);

    root.database
      .prepare('UPDATE sessions SET last_seen_at = NULL WHERE session_id = ?')
      .run(granted.value.session.sessionId);

    const loaded = await surface.sessions.loadByToken(token);
    assert.equal(loaded.ok, false, 'a row the idle rule cannot be applied to must not authorize (F01-AC2)');
    if (!loaded.ok) assert.match(loaded.error.reason, /Malformed/);
  });
});

// F02-AC1, F02-AC4: the session response is the answer to "which project is this session
// addressing", so it is proved against the real store rather than against a double. The
// historical defect was a session response with no project identity in it, which left the
// client to reach for one it did not have - every project-scoped request went out for a
// project literally named "undefined", and the server's honest 404 was reported as "that
// project has no saved profile yet".
test('the owner read carries the selected project, or the onboarding state (F02-AC1, F02-AC4)', async () => {
  await withSurface(async (surface) => {
    const provisioned = await surface.owners.provision({ displayName: DISPLAY_NAME, password: PASSWORD, at: NOW });
    assert.ok(provisioned.ok);
    const ownerId = provisioned.value.ownerId;

    // A brand-new owner has selected nothing, and the answer says so with a count. No
    // placeholder project and no fabricated id: the only way to hold an `activeProjectId` is
    // to hold a `Selected` variant naming a project this store has.
    const fresh = await surface.owners.describe({ ownerId });
    assert.ok(fresh.ok);
    assert.deepEqual(fresh.value.activeProject, { state: 'NoProjectSelected', selectableProjectCount: 0 });

    const created = await surface.projects.createProject({ projectId: PROJECT_ID, name: 'Checkout', at: NOW });
    assert.ok(created.ok, `a project must create: ${created.ok ? '' : created.error.reason}`);

    // Creating does not select. A create that also switched context would silently redirect
    // every other project-scoped page, which is a worse version of the same defect (F02-AC2).
    const afterCreate = await surface.owners.describe({ ownerId });
    assert.ok(afterCreate.ok);
    assert.deepEqual(afterCreate.value.activeProject, { state: 'NoProjectSelected', selectableProjectCount: 1 });

    const selected = await surface.owners.selectActiveProject({ ownerId, projectId: PROJECT_ID, at: NOW });
    assert.ok(selected.ok, `a real project must be selectable: ${selected.ok ? '' : selected.error.reason}`);
    assert.deepEqual(selected.value, {
      state: 'Selected',
      activeProjectId: PROJECT_ID,
      activeProjectName: 'Checkout',
    });

    // And the next read agrees, which is the whole point: the answer is durable, so a
    // re-established session addresses the same project rather than the previous one.
    const reRead = await surface.owners.describe({ ownerId });
    assert.ok(reRead.ok);
    assert.deepEqual(reRead.value.activeProject, selected.value);

    // The address is still read from the row rather than re-derived (F01-AC1).
    assert.equal(reRead.value.email, provisioned.value.email);
    assert.equal(reRead.value.displayName, DISPLAY_NAME);
  });
});

test('selecting a project the store does not hold is refused, so a selection cannot be invented (F02-AC4)', async () => {
  await withSurface(async (surface) => {
    const provisioned = await surface.owners.provision({ displayName: DISPLAY_NAME, password: PASSWORD, at: NOW });
    assert.ok(provisioned.ok);

    const missing = await surface.owners.selectActiveProject({
      ownerId: provisioned.value.ownerId,
      projectId: 'no-such-project',
      at: NOW,
    });
    assert.equal(missing.ok, false, 'selecting a project this store does not hold must be refused');
    if (missing.ok) return;
    assert.equal(missing.error.code, 'NotFound');

    // The refusal changed nothing: the session still reads as the onboarding state rather
    // than as a selection nobody made.
    const described = await surface.owners.describe({ ownerId: provisioned.value.ownerId });
    assert.ok(described.ok);
    assert.equal(described.value.activeProject.state, 'NoProjectSelected');
  });
});

test('a profile and a connector round-trip through the surface (F02-AC3, F03-AC2)', async () => {
  await withSurface(async (surface) => {
    const provisioned = await surface.owners.provision({
      displayName: DISPLAY_NAME,
      password: PASSWORD,
      at: NOW,
    });
    assert.ok(provisioned.ok);
    const actor = provisioned.value.ownerId as OwnerId;

    const empty = await surface.profiles.currentVersion(PROJECT_ID);
    assert.ok(empty.ok);
    assert.equal(empty.value, null, 'a project with no profile must read as null, not as a refusal');

    const saved = await surface.profiles.saveVersion({
      projectId: PROJECT_ID,
      content: profileContent(),
      note: 'first version',
      expectedVersionNumber: null,
      at: NOW,
      actor,
    });
    assert.ok(saved.ok, `a valid profile must save: ${saved.ok ? '' : saved.error.reason}`);
    assert.equal(saved.value.versionNumber, 1);
    assert.equal(saved.value.note, 'first version');
    assert.equal(saved.value.supersedesVersionId, null);

    const stale = await surface.profiles.saveVersion({
      projectId: PROJECT_ID,
      content: { ...profileContent(), recipe: 'a different recipe' },
      note: 'from a stale editor',
      expectedVersionNumber: 99,
      at: NOW,
      actor,
    });
    assert.equal(stale.ok, false, 'a stale expected version must be refused (F02-AC2)');
    if (!stale.ok) assert.equal(stale.error.code, 'Conflict');

    const versions = await surface.profiles.listVersions(PROJECT_ID);
    assert.ok(versions.ok);
    assert.equal(versions.value.length, 1);

    const registered = await surface.connectors.register({
      projectId: PROJECT_ID,
      provider: 'linear',
      kind: 'Ticket',
      resourceScope: 'team ENG',
      credentialReference: 'shiploop://credentials/linear-team-eng',
      at: NOW,
      actor,
    });
    assert.ok(registered.ok, `a valid connector must register: ${registered.ok ? '' : registered.error.reason}`);
    assert.equal(registered.value.credentialReference, 'shiploop://credentials/linear-team-eng');
    assert.equal(registered.value.state, 'Unconfigured');
    assert.deepEqual(registered.value.reads, ['Ticket:ReadScope', 'Ticket:UpdateManagedProgress']);
    assert.deepEqual(registered.value.writes, [], 'nothing privileged is declared, so nothing is writable');
    assert.ok(registered.value.credentialReferenceDigest.length > 0);

    const listed = await surface.connectors.listForProject(PROJECT_ID);
    assert.ok(listed.ok);
    assert.equal(listed.value.length, 1);
    assert.equal(listed.value[0]?.connectorId, registered.value.connectorId);

    const revoked = await surface.connectors.revoke({
      connectorId: registered.value.connectorId as ConnectorId,
      at: NOW,
      reason: 'the owner withdrew access',
      actor,
    });
    assert.ok(revoked.ok);
    assert.equal(revoked.value.state, 'Revoked');
  });
});

test('reads are refused when no owner is provisioned (F01-AC1)', async () => {
  await withSurface(async (surface) => {
    const versions = await surface.profiles.listVersions(PROJECT_ID);
    assert.equal(versions.ok, false, 'a database with no owner must not answer a read anonymously (F01-AC1)');
    const connectors = await surface.connectors.listForProject(PROJECT_ID);
    assert.equal(connectors.ok, false);
  });
});

function profileContent(): {
  references: {
    repository: string;
    ticketProvider: string;
    ticketTeamKey: string | null;
    baseBranch: string;
    targetBranch: string;
    deploymentProvider: string;
    engine: string;
    previewComponents: readonly { component: string; environment: string }[];
  };
  policy: {
    requiredChecks: readonly string[];
    deliveryBehavior: 'ManualAuthorizationOnly';
    maxFixPasses: number;
    workspaceIsolation: 'WorktreeAndDataDirectory';
    capabilityVersion: number;
  };
  recipe: string;
  environment: { runtime: string; ports: readonly number[]; secretReferences: readonly string[] };
} {
  return {
    references: {
      repository: 'github.com/example/project',
      ticketProvider: 'linear',
      ticketTeamKey: 'ENG',
      baseBranch: 'main',
      targetBranch: 'main',
      deploymentProvider: 'vercel',
      engine: 'node-24',
      previewComponents: [{ component: 'web', environment: 'preview' }],
    },
    policy: {
      requiredChecks: ['pnpm check', 'pnpm test'],
      deliveryBehavior: 'ManualAuthorizationOnly',
      maxFixPasses: 2,
      workspaceIsolation: 'WorktreeAndDataDirectory',
      capabilityVersion: 1,
    },
    recipe: 'corepack enable && pnpm install --frozen-lockfile',
    environment: { runtime: 'node-24', ports: [4100], secretReferences: ['shiploop://credentials/linear-team-eng'] },
  };
}

/* -------------------------------------------------------------------------- */
/* Planning, readiness, publication and adoption through the seam               */
/* -------------------------------------------------------------------------- */

/**
 * A plan proposal over two independently reviewable surfaces.
 *
 * Two surfaces, because a one-surface change is refused by the domain as an
 * over-decomposed plan, and a test that seeded one task would be testing the refusal
 * rather than the surface (F08-AC2).
 */
function planProposal(planId: string): Record<string, unknown> {
  const task = (taskId: string, outcome: string, dependencies: readonly string[]): Record<string, unknown> => ({
    taskId,
    outcome,
    scope: `Scope for ${taskId}.`,
    acceptanceCriteria: [`${taskId} is observable.`],
    verificationMethod: 'The seam test reads the stored plan.',
    dependencies: [...dependencies],
    relevantProjectContext: ['apps/web'],
    implementationLocation: {
      kind: 'ProposedLocation',
      candidates: [`apps/web/src/${taskId}.ts`],
      basis: 'The seam reads the plan.',
    },
    coversOutcomeIds: ['out_1'],
  });
  return {
    kind: 'PlanProposal',
    briefId: 'brief_1',
    draftedAt: NOW,
    basedOnRevision: null,
    requestedOutcomes: [{ id: 'out_1', statement: 'The owner can see why a build may not start.' }],
    tasks: [
      task('task_1', 'Show the readiness assessment.', []),
      task('task_2', 'Gate publication on acceptance.', ['task_1']),
    ],
    exclusions: [],
    ...(planId === '' ? {} : {}),
  };
}

const planChange: Record<string, unknown> = {
  summary: 'Show readiness and refuse an unpublishable proposal.',
  surfaces: [
    {
      surfaceId: 'readiness_panel',
      description: 'The readiness panel.',
      observableBehaviour: 'Every area and its reason are readable.',
      independentlyReviewable: true,
    },
    {
      surfaceId: 'publish_gate',
      description: 'The publish control.',
      observableBehaviour: 'Publication is offered only when a proposal is accepted.',
      independentlyReviewable: true,
    },
  ],
  dependencyEdges: [{ surface: 'publish_gate', dependsOn: 'readiness_panel' }],
};

/**
 * The owner id this store already holds, or a refusal naming why there is none.
 *
 * A store is single-owner, so a second `provision` is refused as a conflict. The tests
 * read the owner the store already has rather than provisioning per test: the read is
 * the path a running process takes, and provisioning again would make every test's
 * setup depend on whether an earlier test had already run (F01-AC1).
 */
async function ownerFor(surface: ControllerSurface, root: CompositionRoot): Promise<OwnerId> {
  const provisioned = await surface.owners.provision({ displayName: DISPLAY_NAME, password: PASSWORD, at: NOW });
  if (provisioned.ok) return provisioned.value.ownerId;
  const stored = root.owners.current();
  assert.ok(stored.ok && stored.value !== null, 'the test needs exactly one provisioned owner');
  return (stored.value as { readonly ownerId: OwnerId }).ownerId;
}

/** An idea to plan, created through the same surface the transport uses (F06-AC1). */
async function ideaFor(surface: ControllerSurface, root: CompositionRoot): Promise<string> {
  const actor = await ownerFor(surface, root);
  const captured = await surface.intake.captureIdea({
    rawRequest: 'The owner wants to see why a build was refused.',
    kind: 'FeatureRequest',
    projectId: null,
    notes: null,
    detail: null,
    actor,
  });
  assert.ok(captured.ok, `capturing the request must succeed: ${captured.ok ? '' : captured.error.reason}`);
  return captured.value.ideaId;
}

test('a drafted plan reaches the durable store and every F08-AC1 field survives the round trip (F08-AC1, F02-AC3)', async () => {
  await withSurface(async (surface, root) => {
    const actor = await ownerFor(surface, root);
    const ideaId = await ideaFor(surface, root);

    const drafted = await surface.planning.draftPlan({
      ideaId,
      planId: 'plan_seam_1',
      change: planChange,
      proposal: planProposal('plan_seam_1'),
      actor,
    });
    assert.ok(drafted.ok, `drafting must succeed: ${drafted.ok ? '' : drafted.error.reason}`);
    const plan = drafted.value;

    assert.equal(plan.revision, 1);
    assert.equal(plan.split.split, true, 'two reviewable surfaces justify a split (F08-AC2)');
    assert.match(plan.split.reason, /F08-AC2/);
    assert.equal(plan.tasks.length, 2);

    for (const task of plan.tasks) {
      assert.notEqual(task.outcome, '');
      assert.notEqual(task.scope, '');
      assert.ok(task.acceptanceCriteria.length > 0);
      assert.notEqual(task.verificationMethod, '');
      assert.ok(Array.isArray(task.dependencies));
      assert.ok(task.relevantProjectContext.length > 0);
      assert.equal(task.implementationLocation.kind, 'ProposedLocation', 'F08-AC5: a location is a proposal');
      assert.ok(task.implementationLocation.candidates.length > 0);
      assert.notEqual(task.implementationLocation.basis, '');
      assert.equal(task.publishable, false, 'F08-AC3: nothing is publishable before acceptance');
    }

    // F08-AC4: the order the dependencies permit puts the prerequisite first.
    assert.deepEqual(plan.proposedOrder, ['task_1', 'task_2']);
    assert.deepEqual(plan.agreedSequence, ['task_1', 'task_2']);
    assert.equal(plan.taskReadiness.find((entry) => entry.taskId === 'task_2')?.readyAfter[0], 'task_1');

    // F08-AC5: the recorded coverage accounts for the one requested outcome.
    assert.equal(plan.coverage.length, 1);
    assert.equal(plan.coverage[0]?.outcomeId, 'out_1');

    // The row is durable: read through a second call and through the repository itself,
    // so a plan that only existed in the response would fail here.
    const readBack = await surface.planning.getPlan('plan_seam_1');
    assert.ok(readBack.ok);
    assert.equal(readBack.value.digest, plan.digest, 'the stored plan must rebuild to the same content');
    assert.equal(root.plans.read('plan_seam_1').ok, true);
  });
});

test('an owner edit is revision-checked, and an unaccepted proposal never becomes publishable (F08-AC3)', async () => {
  await withSurface(async (surface, root) => {
    const actor = await ownerFor(surface, root);
    const ideaId = await ideaFor(surface, root);
    const drafted = await surface.planning.draftPlan({
      ideaId,
      planId: 'plan_seam_2',
      change: planChange,
      proposal: planProposal('plan_seam_2'),
      actor,
    });
    assert.ok(drafted.ok);

    const accepted = await surface.planning.editPlan({
      planId: 'plan_seam_2',
      edit: { kind: 'Accept', taskId: 'task_1', expectedRevision: 1 },
      actor,
    });
    assert.ok(accepted.ok, `accepting must succeed: ${accepted.ok ? '' : accepted.error.reason}`);
    assert.equal(accepted.value.revision, 2, 'an edit appends the next revision (F08-AC3)');
    assert.equal(accepted.value.lastEditedBy, actor, 'the edit records the owner the transport proved (F01-AC1)');
    assert.equal(accepted.value.tasks.find((task) => task.taskId === 'task_1')?.publishable, true);
    assert.equal(
      accepted.value.tasks.find((task) => task.taskId === 'task_2')?.publishable,
      false,
      'accepting one task must not publish the other (F08-AC3)',
    );

    // F08-AC3: an edit made against the revision the owner no longer sees is refused
    // rather than merged into the newer plan.
    const stale = await surface.planning.editPlan({
      planId: 'plan_seam_2',
      edit: { kind: 'Accept', taskId: 'task_2', expectedRevision: 1 },
      actor,
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.error.code, 'Conflict');
      assert.equal(stale.error.expected, 'revision 2');
    }

    // F08-AC5: a lifecycle field cannot reach the domain through this seam either.
    const lifecycle = await surface.planning.editPlan({
      planId: 'plan_seam_2',
      edit: { kind: 'Edit', taskId: 'task_1', expectedRevision: 2, changes: { acceptance: 'Accepted' } },
      actor,
    });
    assert.equal(lifecycle.ok, false, 'an edit carrying a lifecycle field must be refused (F05-AC5, F08-AC3)');
    if (!lifecycle.ok) assert.equal(lifecycle.error.code, 'Invalid');
  });
});

test('readiness is recorded over every area F09-AC1 names, and a dependency needing a receipt is not available (F09-AC1, F09-AC3)', async () => {
  await withSurface(async (surface, root) => {
    const actor = await ownerFor(surface, root);
    const ideaId = await ideaFor(surface, root);
    const drafted = await surface.planning.draftPlan({
      ideaId,
      planId: 'plan_seam_3',
      change: planChange,
      proposal: planProposal('plan_seam_3'),
      actor,
    });
    assert.ok(drafted.ok);

    const assessed = await surface.planning.assessPlan('plan_seam_3');
    assert.ok(assessed.ok, `assessment must succeed: ${assessed.ok ? '' : assessed.error.reason}`);
    const assessment = assessed.value;

    assert.deepEqual(
      assessment.areas.map((area) => area.area),
      ['Scope', 'Criteria', 'Repository', 'Target', 'Dependencies', 'Verification', 'Access'],
      'every area is present, in the order the specification lists them (F09-AC1)',
    );
    for (const area of assessment.areas) {
      assert.notEqual(area.reason, '', `the ${area.area} area must carry a reason (F09-AC1)`);
      if (area.status !== 'Satisfied') {
        assert.notEqual(area.remedy, null, `an open ${area.area} area must name a remedy (F09-AC1)`);
      }
    }

    // F09-AC3: the second task depends on the first, which is proposed rather than
    // delivered, so the Dependencies area is unmet and says why.
    const dependencies = assessment.areas.find((area) => area.area === 'Dependencies');
    assert.equal(dependencies?.status, 'Unmet', 'a dependency that is not delivered is not available (F09-AC3)');

    // F09-AC4: it is a recorded assessment with an instant, not a percentage.
    assert.equal(assessment.assessedAt, NOW);
    assert.ok(['Ready', 'NeedsInformation', 'Blocked'].includes(assessment.verdict));

    // F09-AC2: `mayStartBuild` and `buildBlockingAreas` are two readings of one decision
    // and cannot disagree. This plan has no project, so Repository and Target are unmet
    // and the build is disabled.
    assert.equal(assessment.mayStartBuild, false, 'an unmet required area disables the build (F09-AC2)');
    assert.ok(assessment.buildBlockingAreas.includes('Repository'), 'the blocking areas are named (F09-AC2)');
    assert.ok(!assessment.buildBlockingAreas.includes('Verification'), 'an undecided verification method does not block a build (F09-AC2)');
  });
});

test('publication and adoption refuse by name when this deployment configured no provider (F03-AC2, F10-AC1, F11-AC1)', async () => {
  await withSurface(async (surface, root) => {
    const actor = await ownerFor(surface, root);
    const ideaId = await ideaFor(surface, root);
    const drafted = await surface.planning.draftPlan({
      ideaId,
      planId: 'plan_seam_4',
      change: planChange,
      proposal: planProposal('plan_seam_4'),
      actor,
    });
    assert.ok(drafted.ok);
    await surface.planning.editPlan({
      planId: 'plan_seam_4',
      edit: { kind: 'Accept', taskId: 'task_1', expectedRevision: 1 },
      actor,
    });

    // F08-AC3, F10-AC1: a plan with no accepted proposal is refused by name rather than
    // published as nothing, because those are different answers.
    const nothing = await surface.planning.publishPlan({
      planId: 'plan_seam_3',
      requestId: 'req_seam_1',
      correlationId: 'corr_seam_1',
      actor,
    });
    assert.equal(nothing.ok, false);

    // F03-AC2: the provider refusal names the missing capability rather than reporting a
    // generic publication failure, because configuration and a fault need different fixes.
    const published = await surface.planning.publishPlan({
      planId: 'plan_seam_4',
      requestId: 'req_seam_2',
      correlationId: 'corr_seam_2',
      actor,
    });
    assert.equal(published.ok, false);
    if (!published.ok) {
      assert.equal(published.error.code, 'Blocked');
      assert.match(published.error.reason, /no ticket provider configured/);
      assert.ok(published.error.prerequisites.some((entry) => entry.name === 'ticket provider'));
    }

    const adopted = await surface.planning.adoptExistingIssue({
      projectId: PROJECT_ID,
      profileVersionId: 'pv_1' as never,
      procedureVersionId: 'proc_1',
      issueId: 'issue_1',
      expectedIdentifier: null,
      title: '',
      correlationId: 'corr_seam_3',
      actor,
    });
    assert.equal(adopted.ok, false);
    if (!adopted.ok) assert.equal(adopted.error.code, 'Blocked');

    // F11-AC5: `Build` is refused by the use case with its own reason, because a build
    // against adopted work is the reset F11-AC4 and F14-AC2 exist to prevent.
    const build = await surface.planning.requestAdoptedEvaluation({
      workItemId: 'wi_1',
      candidateId: null,
      candidateFingerprint: null,
      mode: 'Build',
      correlationId: 'corr_seam_4',
      actor,
    });
    assert.equal(build.ok, false);
  });
});

test('a plan address is a plan id or any work item it publishes as (F10-AC2)', async () => {
  await withSurface(async (surface, root) => {
    const actor = await ownerFor(surface, root);
    const ideaId = await ideaFor(surface, root);
    const drafted = await surface.planning.draftPlan({
      ideaId,
      planId: 'plan_seam_5',
      change: planChange,
      proposal: planProposal('plan_seam_5'),
      actor,
    });
    assert.ok(drafted.ok);

    // F10-AC3: the work item a task publishes as is fixed at draft time, so a
    // publication retry addresses one operation rather than two.
    const workItemId = drafted.value.workItemIdByTaskId['task_1'];
    assert.equal(typeof workItemId, 'string');
    assert.notEqual(workItemId, '');

    // F10-AC2: a client handed a work item id by a publication report can come back to
    // the plan without a second lookup.
    const byWorkItem = await surface.planning.getPlan(workItemId ?? '');
    assert.ok(byWorkItem.ok, `a work item address must resolve to its plan: ${byWorkItem.ok ? '' : byWorkItem.error.reason}`);
    assert.equal(byWorkItem.value.planId, 'plan_seam_5');

    const unknown = await surface.planning.getPlan('wi_nothing_publishes_this');
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error.code, 'NotFound');
  });
});
