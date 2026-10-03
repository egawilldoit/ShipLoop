/**
 * Settings use cases (mvp-spec 3, L02-AC2, L02-AC3, F02-AC1, F03-AC3).
 *
 * These tests are about the rules this slice owns; the rules Builder 3 already wrote for a
 * T3 launch URL are exercised in `handoff/t3-launch.test.ts` and are deliberately not
 * re-tested here, because a second copy of a refusal test is a second thing to keep in step.
 * What is proved here is that the reuse is real (an unusable URL is refused by *that* rule),
 * what this module adds on top (a well-formed URL that still carries a token), and the three
 * properties that make the settings screen safe to render: absent is a state, a secret never
 * travels out, and a project the caller may not address is invisible rather than empty.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectorId, DomainError, OwnerId, ProfileVersionId, ProjectId, Result } from '@shiploop/domain';
import type { ConnectorRecord, ProjectProfileVersion, ProjectSettingsRecord } from '@shiploop/storage';
import { createSettingsUseCases, validateT3Setting } from './settings.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';

const NOW = '2026-03-01T12:00:00.000Z';
const LATER = '2026-03-02T09:00:00.000Z';
const T3_URL = 'https://t3.example.test/app';
const PROJECT = '0a5f1c22-0000-4000-8000-00000000000a' as ProjectId;
const OTHER_PROJECT = '0a5f1c22-0000-4000-8000-00000000000b' as ProjectId;
const OWNER_ID = 'own_1' as OwnerId;
/** A value that must never appear in a response, an error or a stored row (N02-AC2). */
const SEEDED_TOKEN = ['ghp', '0123456789abcdef0123456789abcdef'].join('_');

const clock: ControllerClock = {
  now: () => {
    instants += 1;
    return instants === 1 ? NOW : LATER;
  },
};
let instants = 0;

function owner(overrides: Partial<OwnerActor> = {}): OwnerActor {
  return { actorId: OWNER_ID, role: 'Owner', ownerId: OWNER_ID, sessionId: 'session-1', ...overrides };
}

interface Stub {
  readonly projects: readonly ProjectId[];
  readonly stored: Map<string, ProjectSettingsRecord>;
  readonly profile: ProjectProfileVersion | null;
  readonly connectors: readonly ConnectorRecord[];
  readonly owner: OwnerActor | null;
  readonly writes: { readonly projectId: string; readonly url: string | null; readonly at: string }[];
}

function stub(overrides: Partial<Stub> = {}): Stub {
  return {
    projects: [PROJECT],
    stored: new Map<string, ProjectSettingsRecord>(),
    profile: null,
    connectors: [],
    owner: owner(),
    writes: [],
    ...overrides,
  };
}

function connector(overrides: Partial<ConnectorRecord> = {}): ConnectorRecord {
  return {
    connectorId: 'conn_1' as ConnectorId,
    projectId: PROJECT,
    provider: 'linear',
    kind: 'Ticket',
    resourceScope: 'team/OCT',
    credentialReference: 'credentials/linear/main',
    credentialReferenceDigest: 'digest-1',
    declarations: [],
    state: 'Healthy',
    error: null,
    lastCheckedAt: NOW,
    lastSuccessAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function profileVersion(overrides: Partial<ProjectProfileVersion['content']> = {}): ProjectProfileVersion {
  return {
    profileVersionId: 'profile_1' as ProfileVersionId,
    projectId: PROJECT,
    versionNumber: 3,
    supersedesVersionId: null,
    contentFingerprint: 'fp_0000000000000000000000000000abcd' as ProjectProfileVersion['contentFingerprint'],
    note: null,
    createdAt: NOW,
    createdBy: OWNER_ID,
    content: {
      references: {
        repository: 'github.com/octopus/octopus-web',
        ticketProvider: 'linear',
        ticketTeamKey: 'OCT',
        baseBranch: 'main',
        targetBranch: 'ship/loop-1',
        deploymentProvider: 'vercel',
        engine: 'codex',
        previewComponents: [],
        ...overrides.references,
      },
      policy: {
        requiredChecks: ['typecheck'],
        deliveryBehavior: 'ManualAuthorizationOnly',
        maxFixPasses: 2,
        workspaceIsolation: 'WorktreeAndDataDirectory',
        capabilityVersion: 1,
      },
      recipe: 'pnpm test',
      environment: { runtime: 'node24', ports: [4100], secretReferences: [] },
    },
  };
}

function useCases(state: Stub): ReturnType<typeof createSettingsUseCases> {
  return createSettingsUseCases({
    clock,
    settings: {
      read: (projectId) => ({ ok: true, value: state.stored.get(String(projectId)) ?? null }),
      setT3LaunchUrl: (projectId, url, at): Result<ProjectSettingsRecord> => {
        state.writes.push({ projectId: String(projectId), url, at });
        const record: ProjectSettingsRecord = { projectId, t3LaunchUrl: url, updatedAt: at };
        state.stored.set(String(projectId), record);
        return { ok: true, value: record };
      },
    },
    projects: {
      get: (projectId) => ({
        ok: true,
        value: state.projects.includes(projectId) ? { projectId } : null,
      }),
    },
    profiles: { currentVersion: () => ({ ok: true, value: state.profile }) },
    connectors: { listForProject: () => ({ ok: true, value: state.connectors }) },
    resolveOwner: (): Result<OwnerActor, DomainError> =>
      state.owner === null
        ? { ok: false, error: { code: 'Forbidden', reason: 'No owner is provisioned (F01-AC1).' } }
        : { ok: true, value: state.owner },
  });
}

/* ------------------------------------------------------- the launch URL rules */

test('a valid URL is stored and returned as configured', () => {
  for (const value of [T3_URL, 'http://t3.internal.test', `  ${T3_URL}  `]) {
    const validated = validateT3Setting(value);
    assert.equal(validated.ok, true, `expected ${JSON.stringify(value)} to be accepted`);
    if (!validated.ok) throw new Error('unreachable');
    assert.equal(validated.value.configured, true);
    assert.equal(validated.value.url, value.trim(), 'the configured URL is returned as written, trimmed');
  }
});

test('absent and blank are "not configured", which is a success and not an error (L02-AC3)', () => {
  for (const value of [null, undefined, '', '   ']) {
    const validated = validateT3Setting(value);
    assert.equal(validated.ok, true, `expected ${JSON.stringify(value)} to mean "not configured"`);
    if (!validated.ok) throw new Error('unreachable');
    assert.deepEqual(validated.value, { configured: false, url: null });
  }
});

test('the unusable-URL rules are Builder 3\'s, and this module adds nothing to them', () => {
  // Same cases as `t3-launch.test.ts`, asserted here only to prove the reuse: a divergence
  // between the settings screen and the packet's own launch button is what this guards.
  for (const value of [
    't3.example.test',
    '://missing-scheme',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://t3.example.test',
    'ssh://t3.example.test',
    'https://operator:hunter2@t3.example.test',
  ]) {
    const validated = validateT3Setting(value);
    assert.equal(validated.ok, false, `expected ${JSON.stringify(value)} to be refused`);
    if (validated.ok) throw new Error('unreachable');
    assert.equal(validated.error.code, 'Blocked', 'the refusal keeps Builder 3\'s shape and its status mapping');
  }
});

test('a well-formed URL that carries a token is refused, and the refusal never quotes it (L02-AC2, N02-AC2)', () => {
  const values = [
    `https://t3.example.test/app?token=${SEEDED_TOKEN}`,
    `https://t3.example.test/app?access_token=${SEEDED_TOKEN}`,
    `https://t3.example.test/app#token=${SEEDED_TOKEN}`,
    `https://t3.example.test/${SEEDED_TOKEN}`,
    `https://t3.example.test/app?key=${SEEDED_TOKEN}&thread=abc`,
  ];

  for (const value of values) {
    const validated = validateT3Setting(value);
    assert.equal(validated.ok, false, `expected the credential in ${value.split('?')[0]}… to be refused`);
    if (validated.ok) throw new Error('unreachable');
    const serialised = JSON.stringify(validated.error);
    assert.equal(serialised.includes(SEEDED_TOKEN), false, 'the credential must not appear in the refusal');
    assert.ok(serialised.includes('SHIPLOOP_T3_URL'), 'the refusal must name what to fix');
  }
});

test('a query that locates rather than authenticates is left alone, because Builder 3 accepts it', () => {
  for (const value of [`${T3_URL}?thread=abc`, `${T3_URL}?ref=main#top`]) {
    const validated = validateT3Setting(value);
    assert.equal(validated.ok, true, `expected ${value} to be accepted: a launch URL may carry a location`);
  }
});

/* ------------------------------------------------------------ read and write */

test('a project that configured nothing reads as not configured rather than as an error (L02-AC3)', () => {
  const state = stub();
  const read = useCases(state).readSettings({ projectId: PROJECT, actor: owner() });

  assert.equal(read.ok, true);
  if (!read.ok) throw new Error('unreachable');
  assert.equal(read.value.projectId, PROJECT);
  assert.deepEqual(read.value.t3, { configured: false, url: null });
  assert.equal(read.value.updatedAt, null);
  assert.equal(read.value.repository.configured, false);
  assert.deepEqual(read.value.providers, []);
});

test('saving a URL persists it, and reading it back returns what was stored', () => {
  const state = stub();
  const use = useCases(state);

  const saved = use.updateSettings({ projectId: PROJECT, actor: owner(), t3Url: T3_URL });
  assert.ok(saved.ok);
  if (!saved.ok) throw new Error('unreachable');
  assert.equal(saved.value.t3.configured, true);
  assert.equal(saved.value.t3.url, T3_URL);
  assert.equal(saved.value.updatedAt, NOW);

  const read = use.readSettings({ projectId: PROJECT, actor: owner() });
  assert.ok(read.ok);
  if (!read.ok) throw new Error('unreachable');
  assert.equal(read.value.t3.url, T3_URL);
  assert.deepEqual(state.writes, [{ projectId: PROJECT, url: T3_URL, at: NOW }]);
});

test('clearing the URL is a successful save that leaves the project not configured', () => {
  const state = stub();
  const use = useCases(state);
  use.updateSettings({ projectId: PROJECT, actor: owner(), t3Url: T3_URL });

  const cleared = use.updateSettings({ projectId: PROJECT, actor: owner(), t3Url: null });

  assert.ok(cleared.ok, 'clearing must not be a refusal: no T3 is a normal configuration (L02-AC3)');
  if (!cleared.ok) throw new Error('unreachable');
  assert.deepEqual(cleared.value.t3, { configured: false, url: null });
  assert.equal(cleared.value.updatedAt, LATER);
  assert.equal(state.stored.get(PROJECT)?.t3LaunchUrl, null, 'the stored value is cleared, not left behind');
});

test('a refused URL is never written, and the refusal reaches the caller instead', () => {
  const state = stub();
  const use = useCases(state);
  const refused = use.updateSettings({ projectId: PROJECT, actor: owner(), t3Url: 'javascript:alert(1)' });

  assert.equal(refused.ok, false);
  assert.deepEqual(state.writes, [], 'validation runs before storage, so nothing is written');
});

test('a save naming no URL reads back rather than writing, so a read-then-save is idempotent', () => {
  const state = stub();
  const use = useCases(state);
  use.updateSettings({ projectId: PROJECT, actor: owner(), t3Url: T3_URL });
  const writesBefore = state.writes.length;

  const unchanged = use.updateSettings({ projectId: PROJECT, actor: owner() });

  assert.ok(unchanged.ok);
  if (!unchanged.ok) throw new Error('unreachable');
  assert.equal(unchanged.value.t3.url, T3_URL);
  assert.equal(state.writes.length, writesBefore, 'a body that changes nothing must not write a row');
});

/* ------------------------------------------------------------- no secrets out */

test('no response carries a credential reference or a credential value (F03-AC3, N02-AC2)', () => {
  const state = stub({ connectors: [connector()] });
  const read = useCases(state).readSettings({ projectId: PROJECT, actor: owner() });

  assert.ok(read.ok);
  if (!read.ok) throw new Error('unreachable');
  const serialised = JSON.stringify(read.value);
  assert.equal(serialised.includes('credentials/linear/main'), false, 'the reference is a pointer and does not travel');
  assert.equal(read.value.providers[0]?.credentialReferenceDigest, 'digest-1', 'the digest does travel');
  assert.equal(
    Object.keys(read.value.providers[0] ?? {}).includes('credentialReference'),
    false,
    'the projection has no field a reference could be read out of',
  );
});

test('a URL carrying a credential never reaches a stored row', () => {
  const state = stub();
  const use = useCases(state);
  const refused = use.updateSettings({ projectId: PROJECT, actor: owner(), t3Url: `https://t3.example.test?token=${SEEDED_TOKEN}` });

  assert.equal(refused.ok, false);
  assert.equal(state.stored.size, 0);
  assert.equal(JSON.stringify(state.stored).includes(SEEDED_TOKEN), false);
});

test('a stored value that no longer validates is reported by name, not passed on as openable', () => {
  // The row can be edited by an operator or restored from an older backup, so a value this
  // module would have refused must still not reach a browser as if it worked (N02-AC2).
  const stored = new Map<string, ProjectSettingsRecord>([
    [PROJECT, { projectId: PROJECT, t3LaunchUrl: 'javascript:alert(1)', updatedAt: NOW }],
  ]);
  const read = useCases(stub({ stored })).readSettings({ projectId: PROJECT, actor: owner() });

  assert.equal(read.ok, false);
  if (read.ok) throw new Error('unreachable');
  assert.equal(read.error.code, 'Unavailable');
  assert.equal(read.error.reason.includes('javascript'), false, 'the stored value is not reproduced in the refusal');
});

/* --------------------------------------------------------------- ownership */

test('a project this deployment does not hold is invisible rather than empty (F02-AC2)', () => {
  const use = useCases(stub({ projects: [PROJECT] }));

  const read = use.readSettings({ projectId: OTHER_PROJECT, actor: owner() });
  const written = use.updateSettings({ projectId: OTHER_PROJECT, actor: owner(), t3Url: T3_URL });

  for (const outcome of [read, written]) {
    assert.equal(outcome.ok, false);
    if (outcome.ok) throw new Error('unreachable');
    assert.equal(outcome.error.code, 'NotFound', 'a project that is not here must not read as configured-and-empty');
  }
});

test("one project's settings are never another project's", () => {
  const state = stub({ projects: [PROJECT, OTHER_PROJECT] });
  const use = useCases(state);
  use.updateSettings({ projectId: PROJECT, actor: owner(), t3Url: T3_URL });

  const other = use.readSettings({ projectId: OTHER_PROJECT, actor: owner() });

  assert.ok(other.ok);
  if (!other.ok) throw new Error('unreachable');
  assert.deepEqual(other.value.t3, { configured: false, url: null });
});

test('a caller who is not the owner is refused before anything is read (F01-AC1)', () => {
  const use = useCases(stub());

  const asAgent = use.readSettings({ projectId: PROJECT, actor: owner({ role: 'CodingAgent' }) });
  const unattributed = use.readSettings({ projectId: PROJECT, actor: owner({ ownerId: null }) });
  const notThisOwner = use.readSettings({
    projectId: PROJECT,
    actor: owner({ actorId: 'own_other' as OwnerId, ownerId: 'own_other' as OwnerId }),
  });
  const noOwnerAtAll = useCases(stub({ owner: null })).readSettings({ projectId: PROJECT, actor: owner() });

  for (const [label, outcome] of [
    ['a non-owner role', asAgent],
    ['an unattributable caller', unattributed],
    ['a caller this deployment cannot resolve', notThisOwner],
  ] as const) {
    assert.equal(outcome.ok, false, `${label} must be refused`);
    if (outcome.ok) throw new Error('unreachable');
    assert.equal(outcome.error.code, 'Forbidden');
    assert.equal(outcome.error.reason.includes(T3_URL), false, 'the refusal says nothing about the value');
  }
  assert.equal(noOwnerAtAll.ok, false, 'a deployment with no provisioned owner refuses rather than answering anonymously');
});

/* ------------------------------------------------- the rest of the settings */

test('repository configuration is read from the current profile version, not copied (F02-AC2)', () => {
  const state = stub({ profile: profileVersion() });
  const read = useCases(state).readSettings({ projectId: PROJECT, actor: owner() });

  assert.ok(read.ok);
  if (!read.ok) throw new Error('unreachable');
  assert.equal(read.value.repository.configured, true);
  assert.equal(read.value.repository.profileVersionId, 'profile_1');
  assert.equal(read.value.repository.versionNumber, 3);
  assert.equal(read.value.repository.repository, 'github.com/octopus/octopus-web');
  assert.equal(read.value.repository.baseBranch, 'main');
  assert.equal(read.value.repository.targetBranch, 'ship/loop-1');
});

test('the view has no credential field to render, whatever the store holds', () => {
  const read = useCases(stub({ connectors: [connector({ credentialReference: `token-${SEEDED_TOKEN}` })] })).readSettings({
    projectId: PROJECT,
    actor: owner(),
  });

  assert.ok(read.ok);
  if (!read.ok) throw new Error('unreachable');
  assert.equal(JSON.stringify(read.value).includes(SEEDED_TOKEN), false);
});
