/**
 * Behavioural proof for the owner, profile and capability use cases (F01-AC1,
 * F01-AC2, F02-AC2, F02-AC3, F02-AC4, F03-AC5, N02-AC1, N02-AC2).
 *
 * Every case runs against a real SQLite file in a fresh temporary directory,
 * opened by the real `openDatabase` and brought to the real `migrate` version. The
 * repository-shaped tables below are applied on top because `@shiploop/storage`'s
 * migrations and its repository layer currently disagree on table names, which the
 * composition root refuses to start against rather than working around; a test has
 * to state the same fact. Everything else — the repositories, the domain password
 * and session primitives, the capability boundary — is the production
 * implementation, not a stand-in.
 *
 * The clock is injected and scrypt runs at a reduced cost, so a case is fast and
 * reproducible while still performing real hashing.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  CapabilityDeclaration,
  CapabilityKind,
  ConflictError,
  DomainError,
  InvalidError,
  OwnerId,
  ProcedureVersionId,
  ProjectId,
  Result,
} from '@shiploop/domain';
import {
  ConnectorRepository,
  OwnerRepository,
  ProcedureRepository,
  ProjectProfileRepository,
  migrate,
  openDatabase,
} from '@shiploop/storage';
import type { ConnectorKind, Database, ProjectProfileContent } from '@shiploop/storage';
import type { PreflightDeps, RecipeVersionContent } from '@shiploop/verification';
import { SqliteOwnerCredentialStore, ensureOwnerCredentialSchema } from './composition.ts';
import { createConnectorUseCases } from './connectors.ts';
import type { AdapterRegistry, ConnectorProbe, ConnectorUseCases } from './connectors.ts';
import { createProfileUseCases } from './profiles.ts';
import type { ControllerClock, OwnerActor, ProfileUseCases } from './profiles.ts';

const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'a different long password value';
const WRONG_PASSWORD = 'a wrong long password value';
const EMAIL = 'owner@shiploop.test';
const NOW = '2026-09-30T12:00:00.000Z';
const OWNER_ID = 'owner_fixture_01' as OwnerId;
const PROJECT_ID = 'project_fixture_01' as ProjectId;

/**
 * A synthetic value shaped like a provider key.
 *
 * Assembled from two parts and never a real credential: the point is that the
 * profile form refuses to persist it (F03-AC3), which needs a value the domain's
 * redaction rules actually recognise.
 */
const SECRET_SHAPED_VALUE = ['AIza', 'FixtureKeyMaterialNotARealSecret01'].join('');

const REPOSITORY_SCHEMA = `
CREATE TABLE owner (
  owner_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TABLE owner_session (
  session_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(owner_id),
  token_hash TEXT NOT NULL UNIQUE, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  revoked_at TEXT, rotated_from_session_id TEXT) STRICT;
CREATE TABLE project_profile_version (
  profile_version_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version_number INTEGER NOT NULL,
  supersedes_version_id TEXT, content_json TEXT NOT NULL, content_fingerprint TEXT NOT NULL,
  note TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  UNIQUE (project_id, version_number)) STRICT;
CREATE TABLE connector (
  connector_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, provider TEXT NOT NULL, kind TEXT NOT NULL,
  resource_scope TEXT NOT NULL, credential_reference TEXT NOT NULL,
  credential_reference_digest TEXT NOT NULL, capability_json TEXT NOT NULL, state TEXT NOT NULL,
  error TEXT, last_checked_at TEXT, last_success_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (project_id, kind)) STRICT;
CREATE TABLE procedure_version (
  procedure_version_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, subject_key TEXT NOT NULL,
  version_number INTEGER NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL, source TEXT NOT NULL,
  source_revision TEXT, content TEXT NOT NULL, content_fingerprint TEXT NOT NULL, status TEXT NOT NULL,
  last_verified_revision TEXT, last_verified_at TEXT, accepted_at TEXT, created_at TEXT NOT NULL,
  created_by TEXT NOT NULL, note TEXT, UNIQUE (project_id, subject_key, version_number)) STRICT;
`;

const FAST_PASSWORD_COST = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16 };

/** Injected time, so every recorded instant in these cases is reproducible. */
const clock: ControllerClock = { now: () => NOW };

const DECLARED: Readonly<Record<ConnectorKind, readonly CapabilityKind[]>> = {
  Ticket: ['Ticket:ReadScope', 'Ticket:PublishIssue', 'Ticket:UpdateManagedProgress'],
  Git: ['Git:ReadRepository', 'Git:ReadChecks', 'Git:PushBranch', 'Git:MergeWithPrecondition'],
  Deployment: ['Deployment:Discover', 'Deployment:ReadIdentity', 'Deployment:Execute'],
  Engine: ['Engine:VersionCheck', 'Engine:StartScoped'],
};

function declaration(
  kind: CapabilityKind,
  supported: boolean,
  limitation: string | null = null,
): CapabilityDeclaration {
  const privileged = kind === 'Git:MergeWithPrecondition' || kind.startsWith('Deployment:Execute');
  return {
    kind,
    supported,
    limitation,
    privileged,
    supportsPrecondition: kind === 'Git:MergeWithPrecondition',
  };
}

/**
 * An adapter registry with no provider behind it.
 *
 * `unsupported` marks one capability as refused with an owner-visible limitation,
 * which is how a profile is rejected for needing something the provider cannot do.
 */
function registryWith(
  configured: readonly ConnectorKind[] = ['Ticket', 'Git', 'Deployment', 'Engine'],
  unsupported: Partial<Record<ConnectorKind, readonly CapabilityKind[]>> = {},
): AdapterRegistry {
  return {
    declarationsFor(kind: ConnectorKind): readonly CapabilityDeclaration[] {
      if (!configured.includes(kind)) return [];
      const refused = unsupported[kind] ?? [];
      return DECLARED[kind].map((entry) =>
        refused.includes(entry)
          ? declaration(entry, false, `the configured ${kind} provider does not offer ${entry}.`)
          : declaration(entry, true),
      );
    },
    probeFor(): ConnectorProbe | null {
      return null;
    },
  };
}

function profileReferences() {
  return {
    repository: 'fixture/shiploop-web',
    ticketProvider: 'fixture-ticket',
    ticketTeamKey: 'FIX',
    baseBranch: 'main',
    targetBranch: 'main',
    deploymentProvider: 'fixture-deployment',
    engine: 'fixture-engine',
    previewComponents: [] as readonly { readonly component: string; readonly environment: string }[],
  };
}

function profileContent(overrides: Partial<ProjectProfileContent> = {}): ProjectProfileContent {
  return {
    references: profileReferences(),
    policy: {
      requiredChecks: ['pnpm check'],
      deliveryBehavior: 'ManualAuthorizationOnly',
      maxFixPasses: 2,
      workspaceIsolation: 'WorktreeAndDataDirectory',
      capabilityVersion: 1,
    },
    recipe: 'environment.recipe v1',
    environment: {
      runtime: 'node24',
      ports: [4100, 4101],
      secretReferences: ['vault:shiploop/fixture-token'],
    },
    ...overrides,
  };
}

/**
 * Narrows a typed refusal.
 *
 * The domain error union is discriminated by `code`, so a case that asserts a
 * specific refusal has to narrow on it rather than read a property the union does
 * not guarantee.
 */
function refusal<T>(result: Result<T, DomainError>): DomainError {
  if (result.ok) throw new Error('expected a refusal, received a value');
  return result.error;
}

function invalidRefusal<T>(result: Result<T, DomainError>): InvalidError {
  const error = refusal(result);
  if (error.code !== 'Invalid') throw new Error(`expected an Invalid refusal, saw ${error.code}`);
  return error;
}

function conflictRefusal<T>(result: Result<T, DomainError>): ConflictError {
  const error = refusal(result);
  if (error.code !== 'Conflict') throw new Error(`expected a Conflict refusal, saw ${error.code}`);
  return error;
}

interface Harness {
  readonly useCases: ProfileUseCases & ConnectorUseCases;
  readonly ownerActor: OwnerActor;
  readonly codingAgent: OwnerActor;
  readonly database: Database;
  /** Builds another use-case set over the same store, with different bindings. */
  readonly withOptions: (options?: {
    readonly adapters?: AdapterRegistry;
    readonly preflight?: PreflightDeps;
  }) => ProfileUseCases & ConnectorUseCases;
}

async function withHarness(body: (harness: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-controller-profiles-'));
  try {
    const opened = openDatabase(join(directory, 'shiploop.sqlite'));
    assert.ok(opened.ok, 'the real database opened');
    migrate(opened.value);
    opened.value.exec(REPOSITORY_SCHEMA);
    assert.ok(ensureOwnerCredentialSchema(opened.value).ok, 'the credential schema was installed');

    const build = (
      options: { readonly adapters?: AdapterRegistry; readonly preflight?: PreflightDeps } = {},
    ): ProfileUseCases & ConnectorUseCases => {
      const adapters = options.adapters ?? registryWith();
      const profileUseCases = createProfileUseCases({
        clock,
        owners: new OwnerRepository(opened.value),
        profiles: new ProjectProfileRepository(opened.value),
        procedures: new ProcedureRepository(opened.value),
        credentials: new SqliteOwnerCredentialStore(opened.value),
        adapters,
        passwordParameters: FAST_PASSWORD_COST,
        ...(options.preflight === undefined ? {} : { preflight: options.preflight }),
      });
      const connectorUseCases = createConnectorUseCases({
        clock,
        connectors: new ConnectorRepository(opened.value),
        adapters,
      });
      return { ...profileUseCases, ...connectorUseCases };
    };

    const useCases = build();
    const provisioned = useCases.provisionOwner({ ownerId: OWNER_ID, email: EMAIL, password: PASSWORD });
    assert.ok(provisioned.ok, 'the owner was provisioned');
    const signedIn = useCases.authenticateOwner({ email: EMAIL, password: PASSWORD });
    assert.ok(signedIn.ok, 'the owner signed in');
    const authorized = useCases.authorizeRequest({ token: signedIn.value.sessionToken });
    assert.ok(authorized.ok, 'the session authorized');

    await body({
      useCases,
      ownerActor: authorized.value,
      codingAgent: { actorId: 'coding-agent-1', role: 'CodingAgent', ownerId: null, sessionId: null },
      database: opened.value,
      withOptions: build,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('an unauthenticated or unauthorised caller cannot read a profile (F01-AC1)', async () => {
  await withHarness(async ({ useCases, codingAgent }) => {
    const anonymous = useCases.authorizeRequest({ token: '' });
    assert.equal(anonymous.ok, false);
    assert.equal(anonymous.ok === false ? anonymous.error.code : '', 'Forbidden');

    const inventedToken = useCases.authorizeRequest({ token: 'not-a-real-session-token' });
    assert.equal(inventedToken.ok, false);
    assert.deepEqual(inventedToken, anonymous);

    const asAgent = useCases.currentProfile({ projectId: PROJECT_ID, actor: codingAgent });
    assert.equal(refusal(asAgent).code, 'Forbidden');
    assert.match(refusal(asAgent).reason, /CodingAgent/);

    const written = useCases.saveProfile(
      { projectId: PROJECT_ID, content: profileContent(), note: null, expectedVersionNumber: null },
      codingAgent,
    );
    assert.equal(written.ok, false);
    assert.equal(written.ok === false ? written.error.code : '', 'Forbidden');
  });
});

test('a wrong password and an unknown owner produce the same answer (N02-AC1)', async () => {
  await withHarness(async ({ useCases }) => {
    const wrongPassword = useCases.authenticateOwner({ email: EMAIL, password: WRONG_PASSWORD });
    const unknownOwner = useCases.authenticateOwner({ email: 'nobody@shiploop.test', password: WRONG_PASSWORD });

    assert.deepEqual(wrongPassword, unknownOwner);
    assert.equal(refusal(wrongPassword).code, 'Forbidden');
  });
});

test('provisioning twice is a conflict and never overwrites the credential (F01-AC1)', async () => {
  await withHarness(async ({ useCases }) => {
    const again = useCases.provisionOwner({ ownerId: OWNER_ID, email: EMAIL, password: OTHER_PASSWORD });
    assert.equal(conflictRefusal(again).code, 'Conflict');

    assert.equal(useCases.authenticateOwner({ email: EMAIL, password: PASSWORD }).ok, true);
    assert.equal(useCases.authenticateOwner({ email: EMAIL, password: OTHER_PASSWORD }).ok, false);
  });
});

test('signing out prevents later privileged requests with that session (F01-AC2)', async () => {
  await withHarness(async ({ useCases }) => {
    const signedIn = useCases.authenticateOwner({ email: EMAIL, password: PASSWORD });
    assert.ok(signedIn.ok);
    const token = signedIn.value.sessionToken;
    assert.equal(typeof signedIn.value.sessionTokenDigest, 'string');
    assert.equal(signedIn.value.sessionTokenDigest.length, 64);

    assert.equal(useCases.authorizeRequest({ token }).ok, true);
    assert.equal(useCases.signOut({ token }).ok, true);

    assert.equal(refusal(useCases.authorizeRequest({ token })).code, 'Forbidden');
  });
});

test('saving a profile returns a new version and keeps the previous one readable (F02-AC3)', async () => {
  await withHarness(async ({ useCases, ownerActor }) => {
    const first = useCases.saveProfile(
      { projectId: PROJECT_ID, content: profileContent(), note: 'first', expectedVersionNumber: null },
      ownerActor,
    );
    assert.ok(first.ok);
    assert.equal(first.value.versionNumber, 1);

    const second = useCases.saveProfile(
      {
        projectId: PROJECT_ID,
        content: profileContent({ environment: { runtime: 'node24', ports: [4200], secretReferences: [] } }),
        note: 'second',
        expectedVersionNumber: 1,
      },
      ownerActor,
    );
    assert.ok(second.ok);
    assert.equal(second.value.versionNumber, 2);
    assert.notEqual(second.value.profileVersionId, first.value.profileVersionId);

    const history = useCases.listProfileVersions({ projectId: PROJECT_ID, actor: ownerActor });
    assert.ok(history.ok);
    assert.deepEqual(
      history.value.map((version) => version.profileVersionId),
      [first.value.profileVersionId, second.value.profileVersionId],
    );
    assert.deepEqual(history.value[0]?.content.environment.ports, [4100, 4101]);

    const current = useCases.currentProfile({ projectId: PROJECT_ID, actor: ownerActor });
    assert.ok(current.ok);
    assert.equal(current.value.profileVersionId, second.value.profileVersionId);

    const firstVersion = useCases.getProfile({
      projectId: PROJECT_ID,
      actor: ownerActor,
      profileVersionId: first.value.profileVersionId,
    });
    assert.ok(firstVersion.ok);
    assert.deepEqual(firstVersion.value.content.environment.ports, [4100, 4101]);

    const foreignProject = useCases.getProfile({
      projectId: 'project_fixture_99' as ProjectId,
      actor: ownerActor,
      profileVersionId: first.value.profileVersionId,
    });
    assert.equal(refusal(foreignProject).code, 'NotFound');

    const changes = useCases.changesSinceSelectedVersion({
      projectId: PROJECT_ID,
      actor: ownerActor,
      selectedVersionId: first.value.profileVersionId,
    });
    assert.ok(changes.ok);
    assert.equal(changes.value.changed, true);
    assert.equal(changes.value.selectedVersionNumber, 1);
    assert.equal(changes.value.currentVersionNumber, 2);
    assert.equal(changes.value.laterVersions[0]?.profileVersionId, second.value.profileVersionId);
  });
});

test('a stale editor cannot overwrite a newer profile version (F02-AC2)', async () => {
  await withHarness(async ({ useCases, ownerActor }) => {
    const first = useCases.saveProfile(
      { projectId: PROJECT_ID, content: profileContent(), note: null, expectedVersionNumber: null },
      ownerActor,
    );
    assert.ok(first.ok);
    const second = useCases.saveProfile(
      {
        projectId: PROJECT_ID,
        content: profileContent({ environment: { runtime: 'node24', ports: [4300], secretReferences: [] } }),
        note: null,
        expectedVersionNumber: 1,
      },
      ownerActor,
    );
    assert.ok(second.ok);

    const stale = useCases.saveProfile(
      { projectId: PROJECT_ID, content: profileContent(), note: null, expectedVersionNumber: 1 },
      ownerActor,
    );
    const conflict = conflictRefusal(stale);
    assert.equal(conflict.expected, '1');
    assert.equal(conflict.actual, '2');
  });
});

test('every missing required field is reported under its own path (F02-AC4)', async () => {
  await withHarness(async ({ useCases, ownerActor }) => {
    const saved = useCases.saveProfile(
      {
        projectId: PROJECT_ID,
        content: profileContent({
          references: {
            ...profileReferences(),
            repository: '',
            baseBranch: '',
            engine: '',
            previewComponents: [{ component: '', environment: 'preview' }],
          },
          environment: { runtime: '', ports: [80, 80], secretReferences: [] },
        }),
        note: null,
        expectedVersionNumber: null,
      },
      ownerActor,
    );

    const paths = invalidRefusal(saved).fields.map((field) => field.path);
    for (const expected of [
      'references.repository',
      'references.baseBranch',
      'references.engine',
      'references.previewComponents[0].component',
      'environment.runtime',
      'environment.ports[0]',
    ]) {
      assert.ok(paths.includes(expected), `expected a field error for ${expected}, saw ${paths.join(', ')}`);
    }
    assert.ok(paths.filter((path) => path === 'environment.ports').length === 1);

    const listed = useCases.listProfileVersions({ projectId: PROJECT_ID, actor: ownerActor });
    assert.ok(listed.ok);
    assert.equal(listed.value.length, 0);
  });
});

test('a profile requiring an undeclared capability is refused (F02-AC4, F03-AC2)', async () => {
  await withHarness(async ({ ownerActor, withOptions }) => {
    const withPreview = profileContent({
      references: { ...profileReferences(), previewComponents: [{ component: 'web', environment: 'preview' }] },
    });

    const withoutDeployment = withOptions({ adapters: registryWith(['Ticket', 'Git', 'Engine']) });
    const refused = withoutDeployment.saveProfile(
      { projectId: PROJECT_ID, content: withPreview, note: null, expectedVersionNumber: null },
      ownerActor,
    );
    const messages = invalidRefusal(refused).fields.map((field) => field.message).join(' ');
    assert.match(messages, /Deployment:Discover/);
    assert.match(messages, /Deployment:ReadIdentity/);

    const withoutProgress = withOptions({
      adapters: registryWith(undefined, { Ticket: ['Ticket:UpdateManagedProgress'] }),
    });
    const refusedProgress = withoutProgress.saveProfile(
      { projectId: PROJECT_ID, content: profileContent(), note: null, expectedVersionNumber: null },
      ownerActor,
    );
    assert.deepEqual(invalidRefusal(refusedProgress).fields, [
      {
        path: 'connectors',
        message:
          'Ticket:UpdateManagedProgress is unavailable: the configured Ticket provider does not offer Ticket:UpdateManagedProgress.',
      },
    ]);

    const fully = withOptions();
    const accepted = fully.saveProfile(
      { projectId: PROJECT_ID, content: withPreview, note: null, expectedVersionNumber: null },
      ownerActor,
    );
    assert.ok(accepted.ok);
  });
});

test('a profile secret in the environment list is refused (F03-AC3)', async () => {
  await withHarness(async ({ useCases, ownerActor }) => {
    const saved = useCases.saveProfile(
      {
        projectId: PROJECT_ID,
        content: profileContent({
          environment: {
            runtime: 'node24',
            ports: [4400],
            secretReferences: [SECRET_SHAPED_VALUE],
          },
        }),
        note: null,
        expectedVersionNumber: null,
      },
      ownerActor,
    );
    assert.deepEqual(invalidRefusal(saved).fields, [
      {
        path: 'environment.secretReferences[0]',
        message:
          'Looks like a secret value (google-api-key). Store a reference into the credential store instead (F03-AC3).',
      },
    ]);
  });
});

test('a non-owner role cannot obtain delivery authority through the controller (F03-AC5, N02-AC3)', async () => {
  await withHarness(async ({ useCases, codingAgent, ownerActor }) => {
    for (const requested of ['Git:MergeWithPrecondition', 'Deployment:Execute'] as const) {
      const refused = useCases.authorizeCapability({
        mode: 'Build',
        requestedCapability: requested,
        grantedCapabilities: [requested, 'Git:PushBranch', 'Git:ReadRepository'],
        actor: codingAgent,
      });
      assert.equal(refusal(refused).code, 'Forbidden');
      assert.match(refusal(refused).reason, /privileged delivery action/);
    }

    const acceptance = useCases.authorizeCapability({
      mode: 'Build',
      requestedCapability: 'Acceptance:Decide',
      grantedCapabilities: ['Git:PushBranch'],
      actor: codingAgent,
    });
    assert.equal(acceptance.ok, false);
    assert.match(refusal(acceptance).reason, /owner decision/);

    const ungranted = useCases.authorizeCapability({
      mode: 'Build',
      requestedCapability: 'Git:ReadChecks',
      grantedCapabilities: ['Git:PushBranch'],
      actor: codingAgent,
    });
    assert.equal(ungranted.ok, false);
    assert.match(refusal(ungranted).reason, /not granted/);

    const allowed = useCases.authorizeCapability({
      mode: 'Build',
      requestedCapability: 'Git:PushBranch',
      grantedCapabilities: ['Git:PushBranch'],
      actor: codingAgent,
    });
    assert.equal(allowed.ok, true);

    const ownerMerge = useCases.authorizeCapability({
      mode: 'Build',
      requestedCapability: 'Git:MergeWithPrecondition',
      grantedCapabilities: ['Git:MergeWithPrecondition'],
      actor: ownerActor,
    });
    assert.equal(ownerMerge.ok, false);
    assert.match(refusal(ownerMerge).reason, /does not declare Git:MergeWithPrecondition/);
  });
});

test('the plaintext password never appears in a returned reason or string (N02-AC2)', async () => {
  await withHarness(async ({ useCases }) => {
    const attempts = [
      useCases.authenticateOwner({ email: EMAIL, password: WRONG_PASSWORD }),
      useCases.authenticateOwner({ email: 'nobody@shiploop.test', password: WRONG_PASSWORD }),
      useCases.provisionOwner({
        ownerId: 'owner_fixture_02' as OwnerId,
        email: 'not-an-email',
        password: PASSWORD,
      }),
      useCases.provisionOwner({ ownerId: OWNER_ID, email: EMAIL, password: PASSWORD }),
      useCases.provisionOwner({
        ownerId: OWNER_ID,
        email: EMAIL,
        password: 'short',
      }),
    ];
    for (const attempt of attempts) {
      assert.equal(attempt.ok, false);
      const serialized = JSON.stringify(attempt);
      assert.ok(!serialized.includes(WRONG_PASSWORD), 'the submitted password is absent');
      assert.ok(!serialized.includes(PASSWORD), 'the plaintext password is absent');
      assert.ok(!serialized.includes('"short"'), 'a rejected password is absent');
    }
  });
});
function recipeContent(overrides: Partial<RecipeVersionContent> = {}): RecipeVersionContent {
  return {
    requirements: {
      runtime: { name: 'node', minVersion: '24.0.0', maxVersionExclusive: null },
      cpu: { architecture: 'x64', minCores: 1 },
    },
    dependencyInstall: [],
    serviceStartup: [],
    checks: [
      {
        id: 'check_project',
        name: 'pnpm check',
        command: { argv: ['pnpm', 'check'], timeoutMs: 120_000, maxOutputBytes: 65_536, cwd: null },
        required: true,
      },
    ],
    ports: [{ serviceId: 'app', port: 4100, purpose: 'Application', required: true }],
    dataLocations: [{ id: 'test-data', path: 'data/test', purpose: 'TestData' }],
    testAccess: [
      {
        id: 'app-endpoint',
        description: 'Local application health endpoint.',
        kind: 'ServiceEndpoint',
        target: 'http://127.0.0.1:4100/health',
      },
    ],
    requiredSecrets: ['fixture-app-token'],
    declaredCapabilities: [
      'Repository:Read',
      'Runtime:Inspect',
      'Dependencies:Inspect',
      'Service:Probe',
      'Secret:InspectPresence',
      'Check:Execute',
    ],
    maintenance: {
      action: 'Incompatible',
      command: null,
      incompatibilityReason: 'No maintenance step is recorded, so changed dependencies are reported instead.',
    },
    ...overrides,
  };
}

const PROBE_COMMAND = { argv: ['git', 'rev-parse', 'HEAD'], timeoutMs: 30_000, maxOutputBytes: 4_096, cwd: null };

function preflightDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    runCommand: {
      async run() {
        return {
          exitCode: 0,
          signal: null,
          output: 'fixture output',
          outputTruncated: false,
          timedOut: false,
          durationMs: 3,
          spawnError: null,
          groupId: 4242,
        };
      },
    },
    readRuntime: () => ({ version: '24.2.0', architecture: 'x64' }),
    probePort: async () => true,
    hasSecret: () => true,
    now: () => NOW,
    ...overrides,
  };
}

test('a recipe is versioned and its first version stays readable (F04-AC1)', async () => {
  await withHarness(async ({ ownerActor, withOptions }) => {
    const useCases = withOptions({ preflight: preflightDeps() });
    const first = useCases.saveRecipe({
      projectId: PROJECT_ID,
      recipeId: 'recipe_fixture_web',
      content: recipeContent(),
      provenance: { source: 'OwnerSaved', scope: 'Environment', createdBy: 'owner', createdAt: NOW },
      expectedVersionNumber: null,
      actor: ownerActor,
    });
    assert.ok(first.ok);
    assert.equal(first.value.recipe.version, 1);
    assert.equal(first.value.procedureVersion.versionNumber, 1);

    const second = useCases.saveRecipe({
      projectId: PROJECT_ID,
      recipeId: 'recipe_fixture_web',
      content: recipeContent({ ports: [{ serviceId: 'app', port: 4200, purpose: 'Application', required: true }] }),
      provenance: { source: 'OwnerSaved', scope: 'Environment', createdBy: 'owner', createdAt: NOW },
      expectedVersionNumber: 1,
      actor: ownerActor,
    });
    assert.ok(second.ok);
    assert.equal(second.value.recipe.version, 2);
    assert.notEqual(second.value.environmentFingerprint, first.value.environmentFingerprint);

    const earlier = await useCases.preflightEnvironment({
      projectId: PROJECT_ID,
      procedureVersionId: first.value.procedureVersion.procedureVersionId,
      attemptId: 'attempt_fixture_01',
      workingDirectory: '/shiploop-attempt/worktree',
      evidenceDirectory: '/shiploop-attempt/evidence',
      repositoryProbe: PROBE_COMMAND,
      dependencyProbe: PROBE_COMMAND,
    });
    assert.ok(earlier.ok, 'the superseded recipe version is still usable');
    assert.equal(earlier.ok === true ? earlier.value.report.recipeVersion : 0, 1);
  });
});

test('an incomplete recipe is refused with field paths (F04-AC1)', async () => {
  await withHarness(async ({ ownerActor, withOptions }) => {
    const useCases = withOptions({ preflight: preflightDeps() });
    const saved = useCases.saveRecipe({
      projectId: PROJECT_ID,
      recipeId: 'recipe_fixture_web',
      content: recipeContent({
        requirements: { runtime: null, cpu: null },
        requiredSecrets: ['ok-secret', 'ok-secret'],
      }),
      provenance: { source: 'OwnerSaved', scope: 'Environment', createdBy: 'owner', createdAt: NOW },
      expectedVersionNumber: null,
      actor: ownerActor,
    });

    const paths = invalidRefusal(saved).fields.map((field) => field.path);
    assert.ok(paths.includes('requirements.runtime'));
    assert.ok(paths.includes('requirements.cpu'));
    assert.ok(paths.includes('requiredSecrets[1]'));
  });
});

test('a missing runtime blocks implementation with the failed prerequisite (F04-AC3)', async () => {
  await withHarness(async ({ ownerActor, withOptions }) => {
    const withNoRuntime = withOptions({ preflight: preflightDeps({ readRuntime: () => null }) });
    const saved = withNoRuntime.saveRecipe({
      projectId: PROJECT_ID,
      recipeId: 'recipe_fixture_web',
      content: recipeContent(),
      provenance: { source: 'OwnerSaved', scope: 'Environment', createdBy: 'owner', createdAt: NOW },
      expectedVersionNumber: null,
      actor: ownerActor,
    });
    assert.ok(saved.ok);

    const outcome = await withNoRuntime.preflightEnvironment({
      projectId: PROJECT_ID,
      procedureVersionId: saved.value.procedureVersion.procedureVersionId,
      attemptId: 'attempt_fixture_02',
      workingDirectory: '/shiploop-attempt/worktree',
      evidenceDirectory: '/shiploop-attempt/evidence',
      repositoryProbe: PROBE_COMMAND,
      dependencyProbe: PROBE_COMMAND,
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error.error.code, 'Blocked');
    assert.equal(outcome.error.report.outcome, 'Blocked');
    assert.match(outcome.error.error.prerequisites[0]?.name ?? '', /Runtime node/);
    assert.match(outcome.error.error.prerequisites[0]?.remedy ?? '', /Install node 24.0.0/);
    assert.ok(outcome.error.report.probes.some((probe) => probe.output.includes('fixture output')));
  });
});

test('a passing preflight records the verification it observed (F04-AC2)', async () => {
  await withHarness(async ({ ownerActor, withOptions }) => {
    const useCases = withOptions({ preflight: preflightDeps() });
    const saved = useCases.saveRecipe({
      projectId: PROJECT_ID,
      recipeId: 'recipe_fixture_web',
      content: recipeContent(),
      provenance: { source: 'OwnerSaved', scope: 'Environment', createdBy: 'owner', createdAt: NOW },
      expectedVersionNumber: null,
      actor: ownerActor,
    });
    assert.ok(saved.ok);

    const outcome = await useCases.preflightEnvironment({
      projectId: PROJECT_ID,
      procedureVersionId: saved.value.procedureVersion.procedureVersionId,
      attemptId: 'attempt_fixture_03',
      workingDirectory: '/shiploop-attempt/worktree',
      evidenceDirectory: '/shiploop-attempt/evidence',
      repositoryProbe: PROBE_COMMAND,
      dependencyProbe: PROBE_COMMAND,
    });

    assert.ok(outcome.ok, 'preflight completed');
    if (!outcome.ok) return;
    assert.equal(outcome.value.report.outcome, 'PreflightPassed');
    assert.equal(outcome.value.mayStartImplementation, true);
    assert.equal(outcome.value.verifiedRecipe?.lastVerification.result, 'Verified');
    assert.equal(outcome.value.report.environmentFingerprint, saved.value.environmentFingerprint);
  });
});

test('preflight without an injected runner refuses rather than reporting a start (F04-AC2)', async () => {
  await withHarness(async ({ useCases }) => {
    const outcome = await useCases.preflightEnvironment({
      projectId: PROJECT_ID,
      procedureVersionId: 'procedure_fixture_01' as ProcedureVersionId,
      attemptId: 'attempt_fixture_04',
      workingDirectory: '/shiploop-attempt/worktree',
      evidenceDirectory: '/shiploop-attempt/evidence',
      repositoryProbe: PROBE_COMMAND,
      dependencyProbe: PROBE_COMMAND,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error.error.code, 'Unavailable');
    assert.match(outcome.error.error.reason, /No preflight runner/);
    assert.equal(outcome.error.report.outcome, 'Blocked');
  });
});
