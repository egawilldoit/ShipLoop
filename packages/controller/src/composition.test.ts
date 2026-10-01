/**
 * Behavioural proof for the composition root (F01-AC1, F02-AC1, F03-AC1).
 *
 * Each case works on a real SQLite file inside a fresh temporary directory that is
 * removed in a `finally`, and the root is asked to do its real work: open the
 * database, migrate it, verify the schema its repositories need, and bind the use
 * cases. Two refusals are the point of the file — a root must not be handed back
 * when the database cannot be opened, and none may be handed back when migration
 * fails, because a half-built root fails later in a place nobody is watching.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CapabilityDeclaration, CapabilityKind, OwnerId, ProjectId } from '@shiploop/domain';
import {
  ConnectorRepository,
  OwnerRepository,
  ProcedureRepository,
  ProjectProfileRepository,
  closeDatabase,
  migrate,
  openDatabase,
} from '@shiploop/storage';
import type { ConnectorKind } from '@shiploop/storage';
import { createCompositionRoot } from './composition.ts';
import type { AdapterRegistry, ConnectorProbe } from './connectors.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';

const NOW = '2026-09-30T12:00:00.000Z';
const OWNER_ID = 'owner_fixture_01' as OwnerId;
const PROJECT_ID = 'project_fixture_01' as ProjectId;
const PASSWORD = 'correct horse battery staple';

const clock: ControllerClock = { now: () => NOW };

const FAST_PASSWORD_COST = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16 };

/**
 * The tables the bound repositories read and write.
 *
 * `@shiploop/storage`'s migrations install plural table names while its repository
 * layer uses singular ones. The root refuses to start against that disagreement, so
 * a case that wants a working root has to state the same fact rather than have the
 * controller paper over it.
 */

const DECLARED: Readonly<Record<ConnectorKind, readonly CapabilityKind[]>> = {
  Ticket: ['Ticket:ReadScope', 'Ticket:UpdateManagedProgress'],
  Git: ['Git:ReadRepository', 'Git:ReadChecks', 'Git:PushBranch'],
  Deployment: ['Deployment:Discover', 'Deployment:ReadIdentity'],
  Engine: ['Engine:VersionCheck', 'Engine:StartScoped'],
};

function declaration(kind: CapabilityKind): CapabilityDeclaration {
  return { kind, supported: true, limitation: null, privileged: false, supportsPrecondition: false };
}

/** No provider is contacted: declarations only, and no probe for any connector. */
const adapters: AdapterRegistry = {
  declarationsFor(kind: ConnectorKind): readonly CapabilityDeclaration[] {
    return DECLARED[kind].map(declaration);
  },
  probeFor(): ConnectorProbe | null {
    return null;
  },
};

function config(databasePath: string) {
  return { databasePath, clock, adapters, passwordParameters: FAST_PASSWORD_COST };
}

async function withDirectory(body: (path: string) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-controller-root-'));
  try {
    await body(join(directory, 'shiploop.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Migrates and completes the schema so a later root can start. */
function prepareFile(databasePath: string): void {
  const opened = openDatabase(databasePath);
  assert.ok(opened.ok, 'the real database opened');
  const migrated = migrate(opened.value);
  assert.ok(migrated.ok, 'the real migration ran');
  assert.ok(closeDatabase(opened.value).ok, 'the database closed cleanly');
}

test('the root binds one repository of each kind and exposes the use cases (F02-AC1)', async () => {
  await withDirectory(async (databasePath) => {
    prepareFile(databasePath);
    const root = createCompositionRoot(config(databasePath));
    assert.ok(root.ok, 'the root was returned');
    if (!root.ok) return;

    try {
      assert.ok(root.value.owners instanceof OwnerRepository);
      assert.ok(root.value.profiles instanceof ProjectProfileRepository);
      assert.ok(root.value.connectors instanceof ConnectorRepository);
      assert.ok(root.value.procedures instanceof ProcedureRepository);
      for (const useCase of [
        'provisionOwner',
        'authenticateOwner',
        'authorizeRequest',
        'saveProfile',
        'getProfile',
        'currentProfile',
        'listProfileVersions',
        'changesSinceSelectedVersion',
        'authorizeCapability',
        'saveRecipe',
        'preflightEnvironment',
        'registerConnector',
        'revokeConnector',
        'resolveConnectorHealth',
        'testConnections',
        'capabilitySummary',
        'requireUsableConnector',
      ] as const) {
        assert.equal(typeof root.value.useCases[useCase], 'function', `${useCase} is exposed`);
      }

      const provisioned = root.value.useCases.provisionOwner({
        ownerId: OWNER_ID,
        email: 'owner@shiploop.test',
        password: PASSWORD,
      });
      assert.ok(provisioned.ok, 'the bound credential store works end to end');

      const signedIn = root.value.useCases.authenticateOwner({
        email: 'owner@shiploop.test',
        password: PASSWORD,
      });
      assert.ok(signedIn.ok);
      const authorized = root.value.useCases.authorizeRequest({ token: signedIn.value.sessionToken });
      assert.ok(authorized.ok, 'the session authorized through the bound repositories');
      const actor: OwnerActor = authorized.value;
      assert.equal(actor.role, 'Owner');

      const saved = root.value.useCases.saveProfile(
        {
          projectId: PROJECT_ID,
          content: {
            references: {
              repository: 'fixture/shiploop-web',
              ticketProvider: 'fixture-ticket',
              ticketTeamKey: 'FIX',
              baseBranch: 'main',
              targetBranch: 'main',
              deploymentProvider: 'fixture-deployment',
              engine: 'fixture-engine',
              previewComponents: [],
            },
            policy: {
              requiredChecks: ['pnpm check'],
              deliveryBehavior: 'ManualAuthorizationOnly',
              maxFixPasses: 2,
              workspaceIsolation: 'WorktreeAndDataDirectory',
              capabilityVersion: 1,
            },
            recipe: 'environment.recipe v1',
            environment: { runtime: 'node24', ports: [4100], secretReferences: [] },
          },
          note: null,
          expectedVersionNumber: null,
        },
        actor,
      );
      assert.ok(saved.ok, 'a profile saved through the bound repositories');
      assert.equal(saved.value.versionNumber, 1);
    } finally {
      assert.ok(root.value.close().ok, 'the root closed the database it opened');
      assert.ok(root.value.close().ok, 'closing twice is not an error');
    }
  });
});

test('no root is returned when the database cannot be opened', async () => {
  await withDirectory(async (databasePath) => {
    await mkdir(databasePath);
    const opened = createCompositionRoot(config(databasePath));
    assert.equal(opened.ok, false);
    if (opened.ok) return;
    assert.equal(opened.error.code, 'Unavailable');
  });
});

test('no root is returned when migration fails', async () => {
  await withDirectory(async (databasePath) => {
    const prepared = openDatabase(databasePath);
    assert.ok(prepared.ok);
    prepared.value.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, checksum TEXT NOT NULL);
      INSERT INTO schema_migrations (version, name, applied_at, checksum)
        VALUES (99, 'from_a_newer_build', '2026-09-30T12:00:00.000Z', 'deadbeef');
    `);
    assert.ok(closeDatabase(prepared.value).ok);

    const root = createCompositionRoot(config(databasePath));
    assert.equal(root.ok, false);
    if (root.ok) return;
    assert.equal(root.error.code, 'Invalid');
    assert.match(root.error.reason, /newer or different build|renamed after the fact/);
  });
});

test('no root is returned when a repository table is absent after migrating', async () => {
  await withDirectory(async (databasePath) => {
    // A migrated database now HAS its tables, so the refusal can no longer be
    // produced by an empty file. Removing one required table is the real failure
    // this guard exists for: a schema that migrated partially, or one that an
    // operator rolled back by hand.
    const prepared = openDatabase(databasePath);
    assert.ok(prepared.ok);
    const migrated = migrate(prepared.value);
    assert.ok(migrated.ok);
    prepared.value.exec('DROP TABLE connectors');
    assert.ok(closeDatabase(prepared.value).ok);

    const root = createCompositionRoot(config(databasePath));
    assert.equal(root.ok, false);
    if (root.ok) return;
    assert.equal(root.error.code, 'Unavailable');
    assert.match(root.error.reason, /"connectors"/);
    assert.match(root.error.reason, /refuses to start/);
  });
});