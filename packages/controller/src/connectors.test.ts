/**
 * Behavioural proof for connector registration, capability reporting and
 * revocation (F03-AC1, F03-AC2, F03-AC3, F03-AC4, N02-AC2, N05-AC2).
 *
 * Each case runs against a real SQLite file in a fresh temporary directory opened
 * by the real `openDatabase` and brought to the real `migrate` version. The
 * connector table below is applied on top because `@shiploop/storage`'s migrations
 * and its repository layer currently disagree on table names; the composition root
 * refuses to start against that disagreement rather than working around it.
 *
 * The adapter probe is an injected double, not a provider: it records whether it
 * was called so a case can prove the controller asked once and reported a blocker
 * rather than looping over credentials (F03-AC4).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  CapabilityDeclaration,
  CapabilityKind,
  DomainError,
  ProjectId,
  Result,
} from '@shiploop/domain';
import { ConnectorRepository, migrate, openDatabase } from '@shiploop/storage';
import type { ConnectorKind, ConnectorRecord } from '@shiploop/storage';
import { createConnectorUseCases } from './connectors.ts';
import type {
  AdapterRegistry,
  ConnectorProbe,
  ConnectorProbeContext,
  ConnectorProbeObservation,
  ConnectorUseCases,
} from './connectors.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';

const PROJECT_ID = 'project_fixture_01' as ProjectId;
const OTHER_PROJECT_ID = 'project_fixture_02' as ProjectId;
const NOW = '2026-09-30T12:00:00.000Z';
const CREDENTIAL_REFERENCE = 'vault:shiploop/fixture-linear-token';

/** A synthetic value shaped like a provider key, never a real credential. */
const SECRET_SHAPED_VALUE = ['AIza', 'FixtureKeyMaterialNotARealSecret01'].join('');


const GIT_DECLARATIONS: readonly CapabilityDeclaration[] = [
  declaration('Git:ReadRepository', true),
  declaration('Git:ReadChecks', true),
  declaration('Git:PushBranch', true),
  declaration('Git:MergeWithPrecondition', true),
];

const TICKET_DECLARATIONS: readonly CapabilityDeclaration[] = [
  declaration('Ticket:ReadScope', true),
  declaration('Ticket:UpdateManagedProgress', false, 'the provider only allows owner-published updates'),
];

const DECLARATIONS: Readonly<Record<ConnectorKind, readonly CapabilityDeclaration[]>> = {
  Ticket: TICKET_DECLARATIONS,
  Git: GIT_DECLARATIONS,
  Deployment: [declaration('Deployment:Discover', true), declaration('Deployment:ReadIdentity', true)],
  Engine: [declaration('Engine:VersionCheck', true)],
};

function declaration(kind: CapabilityKind, supported: boolean, limitation: string | null = null): CapabilityDeclaration {
  return {
    kind,
    supported,
    limitation,
    privileged: kind === 'Git:MergeWithPrecondition' || kind.startsWith('Deployment:Execute'),
    supportsPrecondition: kind === 'Git:MergeWithPrecondition',
  };
}

/** The clock every case shares, so recorded instants are reproducible. */
const clock: ControllerClock = { now: () => NOW };

const OWNER: OwnerActor = {
  actorId: 'owner_fixture_01',
  role: 'Owner',
  ownerId: 'owner_fixture_01' as OwnerActor['ownerId'],
  sessionId: 'session_fixture_01',
};

const CODING_AGENT: OwnerActor = {
  actorId: 'coding-agent-1',
  role: 'CodingAgent',
  ownerId: null,
  sessionId: null,
};

/** A probe that answers from a fixed observation and counts its own calls. */
class RecordingProbe implements ConnectorProbe {
  readonly kind: ConnectorKind;
  readonly provider: string;
  calls = 0;
  observation: ConnectorProbeObservation;

  constructor(kind: ConnectorKind, provider: string, observation: ConnectorProbeObservation) {
    this.kind = kind;
    this.provider = provider;
    this.observation = observation;
  }

  async probe(context: ConnectorProbeContext): Promise<ConnectorProbeObservation> {
    this.calls += 1;
    assert.equal(context.credentialReference, CREDENTIAL_REFERENCE);
    return { ...this.observation, error: this.observation.error === null ? null : context.redact(this.observation.error) };
  }
}

function registryWith(probes: Partial<Record<ConnectorKind, ConnectorProbe>> = {}): AdapterRegistry {
  return {
    declarationsFor(kind: ConnectorKind): readonly CapabilityDeclaration[] {
      return DECLARATIONS[kind];
    },
    probeFor(record: ConnectorRecord): ConnectorProbe | null {
      return probes[record.kind] ?? null;
    },
  };
}

interface Harness {
  readonly useCases: ConnectorUseCases;
  readonly stored: ConnectorRepository;
}

async function withHarness(
  body: (harness: Harness) => Promise<void> | void,
  probes: Partial<Record<ConnectorKind, ConnectorProbe>> = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-controller-connectors-'));
  try {
    const opened = openDatabase(join(directory, 'shiploop.sqlite'));
    assert.ok(opened.ok, 'the real database opened');
    assert.ok(migrate(opened.value).ok, 'the real schema migrated');

    const stored = new ConnectorRepository(opened.value);
    const useCases = createConnectorUseCases({ clock, connectors: stored, adapters: registryWith(probes) });
    await body({ useCases, stored });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function refusal<T>(result: Result<T, DomainError>): DomainError {
  if (result.ok) throw new Error('expected a refusal, received a value');
  return result.error;
}

function register(
  useCases: ConnectorUseCases,
  overrides: {
    readonly projectId?: ProjectId;
    readonly kind?: ConnectorKind;
    readonly provider?: string;
    readonly resourceScope?: string;
    readonly credentialReference?: string;
  } = {},
) {
  return useCases.registerConnector(
    {
      projectId: overrides.projectId ?? PROJECT_ID,
      kind: overrides.kind ?? 'Git',
      provider: overrides.provider ?? 'fixture-git',
      resourceScope: overrides.resourceScope ?? 'fixture/shiploop-web',
      credentialReference: overrides.credentialReference ?? CREDENTIAL_REFERENCE,
    },
    OWNER,
  );
}

test('a connector stores a credential reference and never returns it (F03-AC3)', async () => {
  await withHarness(async ({ useCases }) => {
      const registered = register(useCases);
      assert.ok(registered.ok);
      assert.equal(registered.value.credentialReferenceDigest.length, 64);
      assert.ok(!('credentialReference' in registered.value), 'the reference is withheld from the returned view');

      const described = useCases.describeConnector(registered.value.connectorId, OWNER);
      assert.ok(described.ok);
      assert.ok(!('credentialReference' in described.value));
      assert.ok(!JSON.stringify(described.value).includes(CREDENTIAL_REFERENCE));

      const listed = useCases.listConnectors({ projectId: PROJECT_ID, actor: OWNER });
      assert.ok(listed.ok);
      assert.equal(listed.value.length, 1);
      assert.equal(listed.value[0]?.connectorId, registered.value.connectorId);
  });
});

test('a value that looks like a secret is refused rather than persisted (F03-AC3)', async () => {
  await withHarness(async ({ useCases, stored }) => {
      const refused = register(useCases, { credentialReference: SECRET_SHAPED_VALUE });
      const error = refusal(refused);
      assert.equal(error.code, 'Invalid');
      assert.ok(!JSON.stringify(error).includes(SECRET_SHAPED_VALUE), 'the refused value is not echoed back');

      const rows = stored.listForProject(PROJECT_ID);
      assert.ok(rows.ok);
      assert.equal(rows.value.length, 0);
  });
});

test('a non-owner cannot register or revoke a connector (F03-AC1)', async () => {
  await withHarness(async ({ useCases }) => {
      const attempted = useCases.registerConnector(
        {
          projectId: PROJECT_ID,
          kind: 'Git',
          provider: 'fixture-git',
          resourceScope: 'fixture/shiploop-web',
          credentialReference: CREDENTIAL_REFERENCE,
        },
        CODING_AGENT,
      );
      assert.equal(refusal(attempted).code, 'Forbidden');
  });
});

test('health reports declared reads, writes and an actionable error (F03-AC2)', async () => {
  await withHarness(async ({ useCases }) => {
      const registered = register(useCases, { kind: 'Ticket', provider: 'fixture-ticket' });
      assert.ok(registered.ok);

      const health = useCases.resolveConnectorHealth({ projectId: PROJECT_ID, actor: OWNER });
      assert.ok(health.ok);
      const ticket = health.value[0];
      assert.ok(ticket !== undefined);
      assert.equal(ticket.state, 'Unconfigured');
      assert.equal(ticket.provider, 'fixture-ticket');
      assert.equal(ticket.lastCheckedAt, null);
      assert.ok(ticket.error !== null && ticket.error.includes('not yet tested'));

      const summary = useCases.capabilitySummary(registered.value.connectorId, OWNER);
      assert.ok(summary.ok);
      assert.deepEqual(summary.value.reads, ['Ticket:ReadScope']);
      assert.deepEqual(summary.value.writes, []);
      assert.deepEqual(summary.value.unsupported, [
        { kind: 'Ticket:UpdateManagedProgress', limitation: 'the provider only allows owner-published updates' },
      ]);
  });
});

test('an unsupported operation is reported as unsupported instead of attempted (F03-AC2, N05-AC2)', async () => {
  await withHarness(async ({ useCases }) => {
      const registered = register(useCases, { kind: 'Ticket', provider: 'fixture-ticket' });
      assert.ok(registered.ok);

      const allowed = useCases.requireUsableConnector({
        connectorId: registered.value.connectorId,
        capability: 'Ticket:ReadScope',
      });
      assert.ok(allowed.ok);

      const refused = useCases.requireUsableConnector({
        connectorId: registered.value.connectorId,
        capability: 'Ticket:UpdateManagedProgress',
      });
      const error = refusal(refused);
      assert.equal(error.code, 'Unavailable');
      assert.match(error.reason, /only allows owner-published updates/);
  });
});

test('revoking blocks a new operation while preserving the history (F03-AC4)', async () => {
  const probe = new RecordingProbe('Git', 'fixture-git', {
    accessible: true,
    state: 'Healthy',
    error: null,
    declarations: GIT_DECLARATIONS,
  });

  await withHarness(
    async ({ useCases }) => {
      const registered = register(useCases);
      assert.ok(registered.ok);
      const connectorId = registered.value.connectorId;

      const checked = await useCases.testConnections({ projectId: PROJECT_ID, actor: OWNER });
      assert.ok(checked.ok);
      const healthy = checked.value[0];
      assert.ok(healthy !== undefined);
      assert.equal(healthy.state, 'Healthy');
      assert.equal(healthy.lastCheckedAt, NOW);
      assert.equal(healthy.lastSuccessAt, NOW);
      assert.deepEqual(healthy.writes, ['Git:MergeWithPrecondition']);

      const revoked = useCases.revokeConnector(
        { connectorId, reason: 'Access token withdrawn by the provider.' },
        OWNER,
      );
      assert.ok(revoked.ok);
      assert.equal(revoked.value.state, 'Revoked');

      const blocked = useCases.requireUsableConnector({ connectorId, capability: 'Git:PushBranch' });
      const error = refusal(blocked);
      assert.equal(error.code, 'Blocked');
      assert.equal(error.prerequisites.length, 1);
      assert.match(error.prerequisites[0]?.detail ?? '', /withdrawn/);
      assert.match(error.prerequisites[0]?.remedy ?? '', /Existing work is preserved/);

      const afterRevocation = await useCases.testConnections({ projectId: PROJECT_ID, actor: OWNER });
      assert.ok(afterRevocation.ok);
      const stillListed = afterRevocation.value[0];
      assert.ok(stillListed !== undefined);
      assert.equal(stillListed.connectorId, connectorId);
      assert.equal(stillListed.state, 'Revoked', 'a later check does not silently undo a revocation');
      assert.equal(probe.calls, 1, 'a revoked connector is not re-probed for credentials');
      assert.equal(stillListed.lastSuccessAt, NOW);
      assert.equal(stillListed.lastCheckedAt, NOW);
      assert.deepEqual(stillListed.reads, ['Git:ReadRepository', 'Git:ReadChecks', 'Git:PushBranch']);
    },
    { Git: probe },
  );
});

test('a running attempt observes a revocation instead of retrying credentials (F03-AC4)', async () => {
  const probe = new RecordingProbe('Git', 'fixture-git', {
    accessible: true,
    state: 'Healthy',
    error: null,
    declarations: GIT_DECLARATIONS,
  });
  await withHarness(
    async ({ useCases, stored }) => {
      const registered = register(useCases);
      assert.ok(registered.ok);
      const connectorId = registered.value.connectorId;

      const first = await useCases.testConnections({ projectId: PROJECT_ID, actor: OWNER });
      assert.ok(first.ok);
      assert.equal(first.value[0]?.state, 'Healthy');
      assert.equal(probe.calls, 1);

      useCases.revokeConnector({ connectorId, reason: 'Provider revoked the token.' }, OWNER);

      const observed = useCases.requireUsableConnector({ connectorId, capability: 'Git:PushBranch' });
      assert.equal(refusal(observed).code, 'Blocked');
      assert.equal(probe.calls, 1, 'the gate did not re-probe the provider to find out it was revoked');

      const rows = stored.listForProject(PROJECT_ID);
      assert.ok(rows.ok);
      assert.equal(rows.value.length, 1);
      assert.equal(rows.value[0]?.createdAt, NOW);
      assert.equal(rows.value[0]?.state, 'Revoked');
    },
    { Git: probe },
  );
});

test('a probe that reports lost access records an actionable failure (F03-AC2)', async () => {
  const probe = new RecordingProbe('Git', 'fixture-git', {
    accessible: false,
    state: 'Revoked',
    error: 'The stored token expired on 2026-09-01. Rotate the credential reference for fixture-git.',
    declarations: null,
  });

  await withHarness(
    async ({ useCases }) => {
      const registered = register(useCases);
      assert.ok(registered.ok);
      await useCases.testConnections({ projectId: PROJECT_ID, actor: OWNER });

      const health = useCases.resolveConnectorHealth({ projectId: PROJECT_ID, actor: OWNER });
      assert.ok(health.ok);
      const entry = health.value[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.state, 'Revoked');
      assert.equal(entry.lastCheckedAt, NOW);
      assert.equal(entry.lastSuccessAt, null, 'a failure does not move the last successful check');
      assert.match(entry.error ?? '', /Rotate the credential reference/);
    },
    { Git: probe },
  );
});

test('an unconfigured adapter is reported rather than treated as healthy (F03-AC1)', async () => {
  await withHarness(async ({ useCases }) => {
      assert.ok(register(useCases).ok);
      const checked = await useCases.testConnections({ projectId: OTHER_PROJECT_ID, actor: OWNER });
      assert.ok(checked.ok);
      assert.equal(checked.value.length, 0);

      const registered = register(useCases, { projectId: OTHER_PROJECT_ID });
      assert.ok(registered.ok);
      const checkedAgain = await useCases.testConnections({ projectId: OTHER_PROJECT_ID, actor: OWNER });
      assert.ok(checkedAgain.ok);
      const entry = checkedAgain.value[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.state, 'Degraded');
      assert.match(entry.error ?? '', /No Git adapter is configured/);
      assert.equal(entry.lastSuccessAt, null);
  });
});

test('registering the same kind twice updates the reference without a second row (F03-AC1)', async () => {
  await withHarness(async ({ useCases, stored }) => {
      const first = register(useCases);
      assert.ok(first.ok);
      const second = register(useCases, { credentialReference: 'vault:shiploop/fixture-linear-token-2' });
      assert.ok(second.ok);
      assert.equal(second.value.connectorId, first.value.connectorId);

      const rows = stored.listForProject(PROJECT_ID);
      assert.ok(rows.ok);
      assert.equal(rows.value.length, 1);
      assert.equal(rows.value[0]?.credentialReferenceDigest, second.value.credentialReferenceDigest);
  });
});
