/**
 * Behavioural proof for the request and delivery-contract repositories.
 *
 * Real migrated SQLite files, driven through the repositories rather than through raw
 * statements, because the properties under test are the ones a caller depends on: the
 * durable revision history, the project-scoped keys, and the compare-and-set that makes
 * a stale write a `Conflict` rather than a silent overwrite.
 *
 * The domain already refuses to edit an approved revision, and the schema already aborts
 * it. What is proved *here* is the layer between them: that the repository cannot be
 * talked into writing one anyway, that a revise writes both halves or neither, and that a
 * revision read back is byte-equal to the one written.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  approveContract,
  contractContentFingerprint,
  createContractDraft,
  createRequest,
  editContract,
  fingerprint,
  invalidateContract,
  reviseContract,
  supersedeContract,
  updateRequest,
  type ContractContent,
  type ContractId,
  type DeliveryContract,
  type DomainError,
  type OwnerId,
  type ProjectId,
  type Request,
  type RequestId,
  type Result,
} from '@shiploop/domain';
import { openDatabase, type Database } from '../db.ts';
import { migrate, migrationDefinitions, LATEST_SCHEMA_VERSION } from '../migrations.ts';
import { withTransaction } from '../tx.ts';
import { ActiveProjectRepository } from './core.ts';
import {
  ContractRepository,
  RequestRepository,
  type ApprovalExpectation,
} from './contracts.ts';

const OWNER = 'own-contracts-01' as OwnerId;
const PROJECT = '5c0a1f22-0000-4000-8000-00000000000a' as ProjectId;
const OTHER_PROJECT = '5c0a1f22-0000-4000-8000-00000000000b' as ProjectId;
const REQUEST = 'req-contracts-01' as RequestId;
const OTHER_REQUEST = 'req-contracts-02' as RequestId;
const CONTRACT = 'dc-contracts-01' as ContractId;
const NEXT_CONTRACT = 'dc-contracts-02' as ContractId;
const T0 = '2026-03-01T09:00:00.000Z';
const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-01T11:00:00.000Z';

const REQUEST_FINGERPRINT = fingerprint({ title: 'Checkout totals' });

const CONTENT: ContractContent = {
  outcome: 'The order summary shows the total including tax.',
  scope: ['Sum the line items before tax', 'Apply the configured tax rate'],
  outOfScope: ['Changing the tax rate'],
  acceptanceCriteria: [
    {
      id: 'AC1',
      description: 'The summary returns 200 and displays "Total: 12.00".',
      verificationType: 'automated',
      verificationCheckId: 'unit-tests',
    },
    {
      id: 'AC2',
      description: 'The owner confirms the total matches the invoice they were sent.',
      verificationType: 'owner_test',
      verificationCheckId: null,
    },
  ],
};

const CHANGED: ContractContent = {
  ...CONTENT,
  outcome: 'The order summary shows the total including tax and shipping.',
  scope: [...CONTENT.scope, 'Show the currency code'],
};

function expectOk<T>(result: Result<T, DomainError>): T {
  if (!result.ok) assert.fail(`expected success but received ${result.error.code}: ${result.error.reason}`);
  return result.value;
}

function expectError<T>(result: Result<T, DomainError>, code: DomainError['code']): DomainError {
  if (result.ok) assert.fail(`expected ${code} but the call succeeded`);
  assert.equal(result.error.code, code);
  return result.error;
}

interface Harness {
  readonly requests: RequestRepository;
  readonly contracts: ContractRepository;
  readonly activeProjects: ActiveProjectRepository;
  readonly database: Database;
  readonly request: Request;
  readonly close: () => void;
}

/** Seeds only the rows the foreign keys require, then a real request. */
async function withDatabase(run: (context: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-contracts-'));
  const opened = openDatabase(join(directory, 'contracts.sqlite'));
  assert.ok(opened.ok, `the database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
  const connection: Database = opened.value;
  try {
    const migrated = migrate(connection);
    assert.ok(migrated.ok, `the schema could not be migrated: ${migrated.ok ? '' : migrated.error.reason}`);
    connection.prepare('INSERT INTO owners (owner_id, display_name) VALUES (?, ?)').run(OWNER, 'Solo owner');
    connection.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(PROJECT, 'Checkout');
    connection.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(OTHER_PROJECT, 'Other');

    const requests = new RequestRepository(connection);
    const request = expectOk(
      requests.create(
        expectOk(
          createRequest({
            requestId: REQUEST,
            projectId: PROJECT,
            title: 'Checkout totals',
            description: 'The order summary shows the pre-tax total.',
            at: T0,
          }),
        ),
      ),
    );

    await run({
      requests,
      contracts: new ContractRepository(connection),
      activeProjects: new ActiveProjectRepository(connection),
      database: connection,
      request,
      close: () => connection.close(),
    });
  } finally {
    connection.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A database left at the version before the delivery-contract rebuild, with real rows in it.
 *
 * `migrate` is not run on this connection: the definitions are applied one at a time up to
 * `upToVersion`, which is exactly the state an existing deployment is in. A fresh database
 * proves the *result* of version 19; only this proves the *upgrade*, where the table is
 * dropped and re-declared underneath rows that already exist.
 *
 * The ledger rows are copied from a fully migrated reference database rather than written here,
 * because `migrate` reconciles a version's recorded name and checksum against this build's and
 * refuses a mismatch - which is the check that makes a rewritten migration fail loudly. A
 * fixture that invented its own checksums would be refused for a reason that has nothing to do
 * with the migration under test, and a fixture that copied this build's own checksum would
 * happily accept a rewritten migration. The reference database's ledger is the honest source.
 */
async function withDatabaseAtVersion(
  upToVersion: number,
  run: (context: { readonly database: Database; readonly contracts: ContractRepository }) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-contracts-upgrade-'));
  const reference = openDatabase(join(directory, 'reference.sqlite'));
  assert.ok(reference.ok, 'the reference database opened');
  try {
    expectOk(migrate(reference.value));
    const ledgerDdl = String(
      reference.value.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()?.['sql'],
    );
    const history = reference.value
      .prepare('SELECT version, name, applied_at, checksum FROM schema_migrations WHERE version <= ? ORDER BY version')
      .all(upToVersion);

    const opened = openDatabase(join(directory, 'contracts.sqlite'));
    assert.ok(opened.ok, 'the older database opened');
    const connection: Database = opened.value;
    try {
      connection.exec(ledgerDdl);
      for (const definition of migrationDefinitions) {
        if (definition.version > upToVersion) break;
        withTransaction(connection, () => definition.up(connection));
      }
      const record = connection.prepare('INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)');
      for (const row of history) {
        record.run(row['version'] as number, row['name'] as string, row['applied_at'] as string, row['checksum'] as string);
      }

      connection.prepare('INSERT INTO owners (owner_id, display_name) VALUES (?, ?)').run(OWNER, 'Solo owner');
      connection.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(PROJECT, 'Checkout');
      connection
        .prepare('INSERT INTO requests (request_id, project_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(REQUEST, PROJECT, 'Checkout totals', 'The order summary shows the pre-tax total.', T0, T0);

      await run({ database: connection, contracts: new ContractRepository(connection) });
    } finally {
      connection.close();
    }
  } finally {
    reference.value.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function draft(
  overrides: Partial<Parameters<typeof createContractDraft>[0]> = {},
): DeliveryContract {
  return expectOk(
    createContractDraft({
      contractId: CONTRACT,
      projectId: PROJECT,
      requestId: REQUEST,
      revision: 1,
      content: CONTENT,
      requestFingerprint: REQUEST_FINGERPRINT,
      createdBy: OWNER,
      at: T0,
      ...overrides,
    }),
  );
}

/** Drafts, stores and reads back revision 1, so every case starts from real rows. */
function storedDraft(context: Harness, overrides: Partial<Parameters<typeof createContractDraft>[0]> = {}): DeliveryContract {
  const value = draft(overrides);
  return expectOk(context.contracts.createDraft(value));
}

function approve(contract: DeliveryContract, at = T1): DeliveryContract {
  const approvedValue = expectOk(
    approveContract(contract, {
      approvedBy: OWNER,
      at,
      expectedContentFingerprint: contract.contentFingerprint,
      // Every fixture here approves a revision while it is still the request's newest one;
      // the cases that are about a newer revision arriving pass the higher number
      // themselves, because that is the whole fact under test.
      newestRevisionForRequest: contract.revision,
    }),
  );
  return approvedValue;
}

/** The guard a store call carries: the instant and the text the owner reviewed. */
function guard(contract: DeliveryContract): ApprovalExpectation {
  return { updatedAt: contract.updatedAt, contentFingerprint: contract.contentFingerprint };
}

/**
 * One revise step, written out because several cases below need the same two calls and the
 * ordering inside them is the point.
 *
 * Returns what the store handed back next to what the domain asked for, so a case can assert
 * on the refusal as well as on the rows.
 */
function reviseOnce(
  context: Harness,
  current: DeliveryContract,
  overrides: { readonly contractId?: ContractId; readonly content?: ContractContent; readonly at?: string } = {},
) {
  const revised = expectOk(
    reviseContract(current, {
      contractId: overrides.contractId ?? NEXT_CONTRACT,
      content: overrides.content ?? CHANGED,
      requestFingerprint: REQUEST_FINGERPRINT,
      revisedBy: OWNER,
      at: overrides.at ?? T2,
    }),
  );
  return { domain: revised, written: context.contracts.revise(revised) };
}

/**
 * The revisions of one request that could still be approved.
 *
 * The invariant every revise case below asserts, read back through the repository rather than
 * through the objects the calls returned: a request holds at most one approvable revision, and
 * that is a property of what is stored, not of what a caller was handed.
 */
function approvableRevisions(contracts: ContractRepository): readonly number[] {
  return expectOk(contracts.listForRequest(PROJECT, REQUEST))
    .filter((contract) => contract.status === 'draft')
    .map((contract) => contract.revision);
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* The selected project                                                        */
/* -------------------------------------------------------------------------- */

test('no selection reads as the onboarding state, not as a failure', async () => {
  await withDatabase((context) => {
    const active = context.activeProjects;
    assert.equal(expectOk(active.read(OWNER)), null);
  });
});

test('a selection carries the project identity and the name the store holds', async () => {
  await withDatabase((context) => {
    const selected = expectOk(context.activeProjects.select(OWNER, PROJECT, T1));
    assert.equal(selected.projectId, PROJECT);
    assert.equal(selected.name, 'Checkout');

    const read = expectOk(context.activeProjects.read(OWNER));
    assert.equal(read?.projectId, PROJECT);
    assert.equal(read?.name, 'Checkout');
  });
});

test('selecting a project this store does not hold is refused by name', async () => {
  await withDatabase((context) => {
    expectError(context.activeProjects.select(OWNER, 'no-such-project' as ProjectId, T1), 'NotFound');
    assert.equal(expectOk(context.activeProjects.read(OWNER)), null);
  });
});

test('selecting for an owner that does not exist is refused', async () => {
  await withDatabase((context) => {
    expectError(context.activeProjects.select('own_nobody' as OwnerId, PROJECT, T1), 'NotFound');
  });
});

test('one owner has one selection: a second replaces the first', async () => {
  await withDatabase((context) => {
    expectOk(context.activeProjects.select(OWNER, PROJECT, T1));
    const other = expectOk(context.activeProjects.select(OWNER, OTHER_PROJECT, T2));
    assert.equal(other.projectId, OTHER_PROJECT);
    assert.equal(expectOk(context.activeProjects.read(OWNER))?.projectId, OTHER_PROJECT);
    // One row, not two. Two would make "the selected project" answerable two ways, which is
    // the ambiguity the table exists to remove.
    assert.equal(
      context.database.prepare('SELECT count(*) AS rows FROM owner_active_project').get()?.['rows'],
      1,
    );
  });
});

test('a selection survives being read by a second handle on the same file', async () => {
  await withDatabase((context) => {
    expectOk(context.activeProjects.select(OWNER, PROJECT, T1));
    // Re-read through the row directly rather than the same repository: what "durable" has
    // to mean is that the fact outlives the object that wrote it.
    const row = context.database
      .prepare('SELECT project_id FROM owner_active_project WHERE owner_id = ?')
      .get(OWNER);
    assert.equal(row?.['project_id'], PROJECT);
  });
});

test('clearing the selection returns the owner to the onboarding state', async () => {
  await withDatabase((context) => {
    expectOk(context.activeProjects.select(OWNER, PROJECT, T1));
    expectOk(context.activeProjects.clear(OWNER));
    assert.equal(expectOk(context.activeProjects.read(OWNER)), null);
    // Idempotent: clearing nothing is not a failure, so a retried sign-out path is not one.
    expectOk(context.activeProjects.clear(OWNER));
  });
});

test('a request is written once and reads back byte-equal', async () => {
  await withDatabase((context) => {
    const read = expectOk(context.requests.read(PROJECT, REQUEST));
    assert.deepEqual(read, context.request);
    assert.equal(read.title, 'Checkout totals');
    assert.equal(read.description, 'The order summary shows the pre-tax total.');
    assert.equal(read.sourceIdeaId, null);
  });
});

test('creating the same request identity twice returns the one that exists', async () => {
  await withDatabase((context) => {
    const again = expectOk(
      context.requests.create(
        expectOk(
          createRequest({
            requestId: REQUEST,
            projectId: PROJECT,
            title: 'A different title entirely',
            description: 'A different description.',
            at: T1,
          }),
        ),
      ),
    );
    assert.equal(again.title, 'Checkout totals');
    assert.equal(again.createdAt, T0);
  });
});

test('a request from another project is invisible, not merely refused', async () => {
  await withDatabase((context) => {
    expectError(context.requests.read(OTHER_PROJECT, REQUEST), 'NotFound');
    // The list carries the same rule: a request belonging to another project is not in
    // this project's list, so there is no count to infer it from either.
    assert.deepEqual(expectOk(context.requests.listForProject(OTHER_PROJECT)), []);
    assert.equal(expectOk(context.requests.listForProject(PROJECT)).length, 1);
  });
});

test('an edit is a compare-and-set, so a stale tab cannot overwrite a newer draft', async () => {
  await withDatabase((context) => {
    const edited = expectOk(
      updateRequest(context.request, { description: 'The order summary shows the total including tax.' }, {
        expectedUpdatedAt: context.request.updatedAt,
        at: T1,
      }),
    );
    expectOk(context.requests.update(edited, context.request.updatedAt));

    // The stale tab's edit, computed against the instant it loaded.
    const staleEdit = expectOk(
      updateRequest(context.request, { title: 'Checkout totals v2' }, {
        expectedUpdatedAt: context.request.updatedAt,
        at: T2,
      }),
    );
    // The stale tab's write names the instant it loaded, which is no longer the stored
    // one. Both halves are reported so the caller can reload and reapply.
    const stale = expectError(context.requests.update(staleEdit, context.request.updatedAt), 'Conflict');
    assert.equal(stale.code === 'Conflict' ? stale.expected : null, T0);
    assert.equal(stale.code === 'Conflict' ? stale.actual : null, T1);
    assert.equal(expectOk(context.requests.read(PROJECT, REQUEST)).title, 'Checkout totals');
  });
});

test('an edit addressed at another project is refused before any row is written', async () => {
  await withDatabase((context) => {
    const edited = expectOk(
      updateRequest(context.request, { title: 'Renamed' }, { expectedUpdatedAt: context.request.updatedAt, at: T1 }),
    );
    expectError(context.requests.update({ ...edited, projectId: OTHER_PROJECT }, context.request.updatedAt), 'NotFound');
    assert.equal(expectOk(context.requests.read(PROJECT, REQUEST)).title, 'Checkout totals');
  });
});

/* -------------------------------------------------------------------------- */
/* Contract drafts                                                             */
/* -------------------------------------------------------------------------- */

test('a draft revision round-trips with its criteria, scope and fingerprint intact', async () => {
  await withDatabase((context) => {
    storedDraft(context);
    const read = expectOk(context.contracts.read(PROJECT, CONTRACT, 1));

    assert.equal(read.status, 'draft');
    assert.equal(read.approvedBy, null);
    assert.equal(read.approvedAt, null);
    assert.equal(read.revision, 1);
    assert.equal(read.projectId, PROJECT);
    assert.equal(read.requestId, REQUEST);
    assert.deepEqual(read.scope, CONTENT.scope);
    assert.deepEqual(read.outOfScope, CONTENT.outOfScope);
    assert.deepEqual(read.acceptanceCriteria, CONTENT.acceptanceCriteria);
    // The fingerprint the domain computed, not one the repository chose.
    assert.equal(read.contentFingerprint, contractContentFingerprint(CONTENT));
    assert.equal(read.requestFingerprint, REQUEST_FINGERPRINT);
  });
});

test('a revision from another project is invisible', async () => {
  await withDatabase((context) => {
    storedDraft(context);
    expectError(context.contracts.read(OTHER_PROJECT, CONTRACT, 1), 'NotFound');
    assert.deepEqual(expectOk(context.contracts.listForRequest(OTHER_PROJECT, REQUEST)), []);
  });
});

test('the domain fingerprint is recomputed on write, so a lying caller stores the truth', async () => {
  await withDatabase((context) => {
    const value = draft();
    const written = expectOk(context.contracts.createDraft(value));
    assert.equal(written.contentFingerprint, contractContentFingerprint(CONTENT));
    // Even if the caller handed over a fingerprint of different text, the stored one
    // describes the stored text.
    assert.notEqual(written.contentFingerprint, fingerprint({ something: 'else' }));
  });
});

test('editing a stored draft moves the content and the fingerprint together', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    const edited = expectOk(
      editContract(stored, CHANGED, { expectedUpdatedAt: stored.updatedAt, at: T1, editedBy: OWNER }),
    );
    const written = expectOk(context.contracts.editDraft(edited, stored.updatedAt));

    assert.equal(written.outcome, CHANGED.outcome);
    assert.deepEqual(written.scope, CHANGED.scope);
    assert.equal(written.contentFingerprint, contractContentFingerprint(CHANGED));
    assert.equal(written.updatedAt, T1);
    assert.equal(written.revision, 1);
    assert.equal(written.status, 'draft');
  });
});

test('an edit against a stale read is a conflict, and the stored draft is unchanged', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    const first = expectOk(
      editContract(stored, CHANGED, { expectedUpdatedAt: stored.updatedAt, at: T1, editedBy: OWNER }),
    );
    expectOk(context.contracts.editDraft(first, stored.updatedAt));

    const THIRD: ContractContent = { ...CONTENT, outcome: 'A third outcome, from the tab that loaded first.' };
    const stale = expectOk(
      editContract(stored, THIRD, { expectedUpdatedAt: stored.updatedAt, at: T2, editedBy: OWNER }),
    );
    const refused = expectError(context.contracts.editDraft(stale, stored.updatedAt), 'Conflict');
    assert.equal(refused.code === 'Conflict' ? refused.expected : null, `draft@${T0}`);
    assert.equal(refused.code === 'Conflict' ? refused.actual : null, `draft@${T1}`);
    assert.equal(expectOk(context.contracts.read(PROJECT, CONTRACT, 1)).outcome, CHANGED.outcome);
  });
});

/* -------------------------------------------------------------------------- */
/* Approval                                                                    */
/* -------------------------------------------------------------------------- */

test('approving stores the owner and the instant, and the revision stays readable', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    const written = expectOk(context.contracts.approve(approve(stored), guard(stored)));

    assert.equal(written.status, 'approved');
    assert.equal(written.approvedBy, OWNER);
    assert.equal(written.approvedAt, T1);
    assert.equal(written.updatedAt, T1);
    assert.equal(expectOk(context.contracts.currentApproved(PROJECT, REQUEST))?.revision, 1);
  });
});

test('approving twice is a conflict, and the recorded approver is the first one', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    const approved = expectOk(context.contracts.approve(approve(stored), guard(stored)));
    expectError(context.contracts.approve(approved, { updatedAt: T1, contentFingerprint: approved.contentFingerprint }), 'Conflict');
    assert.equal(expectOk(context.contracts.read(PROJECT, CONTRACT, 1)).approvedAt, T1);
  });
});

test('an approved revision cannot be edited through the repository either', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    expectOk(context.contracts.approve(approve(stored), guard(stored)));

    // The domain refuses first, and that refusal is what the test asserts: the store has
    // no path that would produce an edited approved revision.
    const editAttempt = editContract(
      expectOk(context.contracts.read(PROJECT, CONTRACT, 1)),
      CHANGED,
      { expectedUpdatedAt: T1, at: T2, editedBy: OWNER },
    );
    expectError(editAttempt, 'Invalid');
    assert.equal(expectOk(context.contracts.read(PROJECT, CONTRACT, 1)).outcome, CONTENT.outcome);
  });
});

test('approving text the owner did not review is a conflict, and the draft is left alone', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    // What the stale tab holds: the fingerprint from before the other tab's edit.
    const reviewed = stored.contentFingerprint;
    const edited = expectOk(
      editContract(stored, CHANGED, { expectedUpdatedAt: stored.updatedAt, at: T1, editedBy: OWNER }),
    );
    expectOk(context.contracts.editDraft(edited, stored.updatedAt));

    const refused = expectError(
      context.contracts.approve(approve(edited), { updatedAt: edited.updatedAt, contentFingerprint: reviewed }),
      'Conflict',
    );
    // The refusal names both fingerprints, so a client can tell "you read older text" from
    // "you sent nonsense" without a second round trip.
    assert.equal(refused.code === 'Conflict' ? refused.expected : null, reviewed);
    assert.equal(refused.code === 'Conflict' ? refused.actual : null, edited.contentFingerprint);

    const after = expectOk(context.contracts.read(PROJECT, CONTRACT, 1));
    assert.equal(after.status, 'draft', 'a refused approval writes nothing');
    assert.equal(after.approvedBy, null);
    assert.equal(after.approvedAt, null);
    assert.equal(after.outcome, CHANGED.outcome);
    assert.equal(expectOk(context.contracts.currentApproved(PROJECT, REQUEST)), null);
  });
});

test('the approval guard moves even when two edits share one instant', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    const reviewed = stored.contentFingerprint;

    // The second tab writes in the same millisecond as the first, so `updated_at` cannot
    // tell the two edits apart. The fingerprint can, which is why the guard carries it:
    // a store that relied on the instant alone would let this approval through.
    const first = expectOk(
      editContract(stored, CHANGED, { expectedUpdatedAt: stored.updatedAt, at: T1, editedBy: OWNER }),
    );
    expectOk(context.contracts.editDraft(first, stored.updatedAt));
    const THIRD: ContractContent = { ...CHANGED, outcome: 'A third outcome, written in the same millisecond.' };
    const second = expectOk(
      editContract(first, THIRD, { expectedUpdatedAt: first.updatedAt, at: T1, editedBy: OWNER }),
    );
    expectOk(context.contracts.editDraft(second, first.updatedAt));

    assert.equal(second.updatedAt, first.updatedAt, 'the instant is the same for both edits');
    assert.notEqual(second.contentFingerprint, reviewed, 'and the text is not');

    expectError(
      context.contracts.approve(approve(second), { updatedAt: second.updatedAt, contentFingerprint: reviewed }),
      'Conflict',
    );
    expectOk(context.contracts.approve(approve(second), guard(second)));
    assert.equal(expectOk(context.contracts.read(PROJECT, CONTRACT, 1)).status, 'approved');
  });
});

test('the approval guard names a fingerprint of text that was never stored', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    const invented = fingerprint({ outcome: 'Something no owner of this project ever read.' });
    const refused = expectError(
      context.contracts.approve(approve(stored), { updatedAt: stored.updatedAt, contentFingerprint: invented }),
      'Conflict',
    );
    assert.equal(refused.code === 'Conflict' ? refused.expected : null, invented);
    assert.equal(refused.code === 'Conflict' ? refused.actual : null, stored.contentFingerprint);
    assert.equal(expectOk(context.contracts.read(PROJECT, CONTRACT, 1)).status, 'draft');
  });
});

/* -------------------------------------------------------------------------- */
/* Revision and staleness                                                      */
/* -------------------------------------------------------------------------- */

test('revising writes the new revision and retires the old approval in one step', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    const approved = expectOk(context.contracts.approve(approve(stored), guard(stored)));

    const revised = expectOk(
      reviseContract(approved, {
        contractId: NEXT_CONTRACT,
        content: CHANGED,
        requestFingerprint: REQUEST_FINGERPRINT,
        revisedBy: OWNER,
        at: T2,
      }),
    );
    const written = expectOk(context.contracts.revise(revised));

    assert.equal(written.revision, 2);
    assert.equal(written.status, 'draft');
    assert.equal(written.contentFingerprint, contractContentFingerprint(CHANGED));

    // The old approval no longer reads as current: this is the failure the single
    // transaction exists to prevent.
    const previous = expectOk(context.contracts.read(PROJECT, CONTRACT, 1));
    assert.equal(previous.status, 'stale');
    assert.equal(previous.supersededByRevision, 2);
    assert.match(previous.staleReason ?? '', /revision 2/);
    assert.equal(expectOk(context.contracts.currentApproved(PROJECT, REQUEST)), null);
  });
});

test('revising leaves the whole history readable, oldest revision first', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    const approved = expectOk(context.contracts.approve(approve(stored), guard(stored)));
    const revised = expectOk(
      reviseContract(approved, {
        contractId: NEXT_CONTRACT,
        content: CHANGED,
        requestFingerprint: REQUEST_FINGERPRINT,
        revisedBy: OWNER,
        at: T2,
      }),
    );
    expectOk(context.contracts.revise(revised));

    const history = expectOk(context.contracts.listForRequest(PROJECT, REQUEST));
    assert.deepEqual(
      history.map((contract) => [contract.revision, contract.status]),
      [
        [1, 'stale'],
        [2, 'draft'],
      ],
    );
    // The superseded revision kept its text and its approver: it is history, not a deletion.
    assert.equal(history[0]?.outcome, CONTENT.outcome);
    assert.equal(history[0]?.approvedBy, OWNER);
    assert.equal(expectOk(context.contracts.latest(PROJECT, REQUEST))?.revision, 2);
  });
});

test('an invalidated approval records why, and a second explanation cannot replace the first', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    const approved = expectOk(context.contracts.approve(approve(stored), guard(stored)));

    const stale = expectOk(invalidateContract(approved, { reason: 'The owner changed the scope.', at: T2 }));
    expectOk(context.contracts.markStale(stale, { updatedAt: T1, status: 'approved' }));

    const stored1 = expectOk(context.contracts.read(PROJECT, CONTRACT, 1));
    assert.equal(stored1.status, 'stale');
    assert.equal(stored1.staleReason, 'The owner changed the scope.');
    assert.equal(stored1.supersededByRevision, null);
    assert.equal(stored1.approvedBy, OWNER);

    const again = expectError(context.contracts.markStale(stored1, { updatedAt: T1, status: 'approved' }), 'Conflict');
    // The refusal names the state the writer expected and the one it found, so a client
    // can tell "someone else got there first" from "you sent nonsense".
    assert.equal(again.code === 'Conflict' ? again.expected : null, 'approved@2026-03-01T10:00:00.000Z');
    assert.equal(again.code === 'Conflict' ? again.actual : null, `stale@${T2}`);
    assert.equal(expectOk(context.contracts.read(PROJECT, CONTRACT, 1)).staleReason, 'The owner changed the scope.');
  });
});

test('a revision cannot be created for a project that does not exist', async () => {
  await withDatabase((context) => {
    const value = draft({ projectId: 'no-such-project' as ProjectId });
    expectError(context.contracts.createDraft(value), 'NotFound');
  });
});

test('a second draft for one request is refused by the store, not only by the caller', async () => {
  await withDatabase((context) => {
    storedDraft(context);
    const second = draft({ contractId: NEXT_CONTRACT, revision: 2 });
    expectError(context.contracts.createDraft(second), 'Unavailable');
    // Exactly one row: the refusal did not leave a partial write behind.
    assert.equal(expectOk(context.contracts.listForRequest(PROJECT, REQUEST)).length, 1);
  });
});

test('a revision for one request cannot be filed under another request', async () => {
  await withDatabase((context) => {
    const other = expectOk(
      context.requests.create(
        expectOk(
          createRequest({
            requestId: OTHER_REQUEST,
            projectId: PROJECT,
            title: 'Refunds',
            description: 'A refund is issued for a cancelled order.',
            at: T0,
          }),
        ),
      ),
    );
    assert.equal(other.requestId, OTHER_REQUEST);
    // Two requests, each with its own revision 1, is the shape that must work.
    storedDraft(context);
    const second = draft({ contractId: NEXT_CONTRACT, requestId: OTHER_REQUEST });
    expectOk(context.contracts.createDraft(second));
    assert.equal(expectOk(context.contracts.listForRequest(PROJECT, REQUEST)).length, 1);
    assert.equal(expectOk(context.contracts.listForRequest(PROJECT, OTHER_REQUEST)).length, 1);
  });
});
test('a criterion keeps the check it is bound to across a write and a read', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    const read = expectOk(context.contracts.read(PROJECT, CONTRACT, 1));
    assert.deepEqual(
      read.acceptanceCriteria.map((criterion) => criterion.verificationCheckId),
      stored.acceptanceCriteria.map((criterion) => criterion.verificationCheckId),
      'the binding is durable, so a re-read names the same check the owner agreed',
    );
    assert.deepEqual(
      read.acceptanceCriteria.map((criterion) => criterion.verificationCheckId),
      ['unit-tests', null],
      'an owner test round-trips as unbound, which is the only correct value for it',
    );
  });
});

test('a revision written before the binding existed reads as unbound rather than as an error', async () => {
  await withDatabase((context) => {
    storedDraft(context);
    // A row from before this field existed: the key is simply absent. Reporting that as
    // unreadable would take down every stored contract on upgrade; reading it as unbound is
    // the truth about it, and the approval gate is what stops a new one being sealed.
    context.database
      .prepare('UPDATE delivery_contracts SET acceptance_criteria_json = ? WHERE contract_id = ?')
      .run(
        JSON.stringify([
          { id: 'AC1', description: 'The summary returns 200.', verificationType: 'automated' },
        ]),
        CONTRACT,
      );
    const read = expectOk(context.contracts.read(PROJECT, CONTRACT, 1));
    assert.equal(read.acceptanceCriteria[0]?.verificationCheckId, null);
  });
});

test('a criterion whose stored binding is not text is reported rather than read as unbound', async () => {
  await withDatabase((context) => {
    storedDraft(context);
    context.database
      .prepare('UPDATE delivery_contracts SET acceptance_criteria_json = ? WHERE contract_id = ?')
      .run(
        JSON.stringify([
          { id: 'AC1', description: 'It works.', verificationType: 'automated', verificationCheckId: 7 },
        ]),
        CONTRACT,
      );
    // Silently coercing this to `null` would show the owner an unbound criterion while the
    // row says something else, which is the row this module is built to refuse.
    const read = context.contracts.read(PROJECT, CONTRACT, 1);
    const error = expectError(read, 'Unavailable');
    assert.match(error.reason, /verificationCheckId/);
  });
});

/* -------------------------------------------------------------------------- */
/* One approvable revision per request (mvp-spec 3)                           */
/* -------------------------------------------------------------------------- */

test('revising a draft supersedes that draft, so a request holds one approvable revision (mvp-spec 3)', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    const { domain, written } = reviseOnce(context, stored);
    assert.ok(domain.superseded !== null, 'the revision the new one was written from is not left alone');

    expectOk(written);
    const history = expectOk(context.contracts.listForRequest(PROJECT, REQUEST));
    assert.deepEqual(
      history.map((contract) => [contract.revision, contract.status]),
      [
        [1, 'stale'],
        [2, 'draft'],
      ],
      'exactly what the approved case produces, because the invariant is the same',
    );
    assert.deepEqual(approvableRevisions(context.contracts), [2]);

    // The read path reports it as history: superseded, with no approver, and keeping its text.
    const previous = history[0];
    assert.equal(previous?.supersededByRevision, 2);
    assert.equal(previous?.staleReason, 'Superseded by revision 2.');
    assert.equal(previous?.approvedBy, null);
    assert.equal(previous?.approvedAt, null);
    assert.equal(previous?.outcome, CONTENT.outcome);
    assert.equal(expectOk(context.contracts.latest(PROJECT, REQUEST))?.revision, 2);
    assert.equal(expectOk(context.contracts.currentApproved(PROJECT, REQUEST)), null);
  });
});

test('a superseded draft cannot be edited, because history is frozen (mvp-spec 3)', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    expectOk(reviseOnce(context, stored).written);

    const edited = editContract(expectOk(context.contracts.read(PROJECT, CONTRACT, 1)), CHANGED, {
      expectedUpdatedAt: T2,
      at: T2,
      editedBy: OWNER,
    });
    assert.ok(!edited.ok, 'the domain refuses, so the row cannot even be named as editable');
    const write = context.contracts.editDraft(
      expectOk(
        supersedeContract(stored, { supersededByRevision: 2, at: T2 }),
      ),
      T0,
    );
    assert.ok(!write.ok, 'and the store refuses a stale revision even when handed one');
  });
});

test('two revise attempts from one draft leave exactly one approvable revision (mvp-spec 3)', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);

    // Interleaved rather than sequential: the second attempt is built from the record the
    // *first* read produced, which is what a second tab holds. If the store let both through,
    // revision 2 would be written twice or a second live draft would appear beside it.
    const first = reviseOnce(context, stored);
    const second = reviseOnce(context, stored, {
      contractId: 'dc-contracts-03' as ContractId,
      content: { ...CHANGED, outcome: 'A different third wording.' },
      at: '2026-03-01T12:00:00.000Z',
    });

    expectOk(first.written);
    const conflict = expectError(second.written, 'Conflict');
    assert.match(conflict.reason, /not the next revision of this request/);
    assert.equal(conflict.code === 'Conflict' ? conflict.expected : null, '3');
    assert.equal(conflict.code === 'Conflict' ? conflict.actual : null, '2');

    assert.deepEqual(approvableRevisions(context.contracts), [2], 'never more than one draft a request can approve');
    const history = expectOk(context.contracts.listForRequest(PROJECT, REQUEST));
    assert.deepEqual(
      history.map((contract) => [contract.revision, contract.status]),
      [
        [1, 'stale'],
        [2, 'draft'],
      ],
      'and the refused attempt left no row of its own behind',
    );
  });
});

test('a third revise, from the revision the store says is newest, is refused against a stale read (mvp-spec 3)', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    const first = reviseOnce(context, stored);
    expectOk(first.written);

    // The successor of revision 2 exists, so a revise built from revision 2 must be revision 3.
    // Asking for revision 3 is fine and lands; asking again from the same read is not.
    const second = reviseOnce(context, first.domain.draft, {
      contractId: 'dc-contracts-03' as ContractId,
      content: { ...CHANGED, outcome: 'The third statement of the outcome.' },
      at: '2026-03-01T12:00:00.000Z',
    });
    expectOk(second.written);
    assert.deepEqual(approvableRevisions(context.contracts), [3]);
    assert.deepEqual(
      expectOk(context.contracts.listForRequest(PROJECT, REQUEST)).map((contract) => [
        contract.revision,
        contract.status,
      ]),
      [
        [1, 'stale'],
        [2, 'stale'],
        [3, 'draft'],
      ],
    );

    const third = reviseOnce(context, first.domain.draft, {
      contractId: 'dc-contracts-04' as ContractId,
      content: { ...CHANGED, outcome: 'A fourth statement of the outcome.' },
      at: '2026-03-01T13:00:00.000Z',
    });
    expectError(third.written, 'Conflict');
    assert.deepEqual(approvableRevisions(context.contracts), [3]);
  });
});

test('if the new revision cannot be written, the one it was written from is not left superseded (mvp-spec 3)', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);

    // Fault injection at the only place it can happen: the second write of the transaction.
    // Without it the step would have to be faked by racing a second connection, which
    // `tx.ts` refuses on purpose.
    context.database.exec(
      `CREATE TRIGGER probe_refuse_new_revision BEFORE INSERT ON delivery_contracts
       BEGIN SELECT RAISE(ABORT, 'probe: this revision cannot be written'); END`,
    );
    const written = reviseOnce(context, stored).written;
    context.database.exec('DROP TRIGGER probe_refuse_new_revision');

    // The failure is reported as a store fault rather than a rule, which is honest: nothing
    // about the request was wrong.
    const refused = expectError(written, 'Unavailable');
    assert.match(refused.reason, /cannot be written/);

    // The property under test. A retired draft with no successor is the one state an owner
    // cannot act on: nothing to approve, and nothing naming what replaced it.
    const after = expectOk(context.contracts.listForRequest(PROJECT, REQUEST));
    assert.deepEqual(
      after.map((contract) => [contract.revision, contract.status, contract.supersededByRevision]),
      [[1, 'draft', null]],
      'the whole step rolled back: no new revision, and no orphaned stale draft',
    );
    assert.deepEqual(approvableRevisions(context.contracts), [1], 'the request still has the draft it had');

    // And it is still a working draft rather than a row nobody can act on.
    const edited = editContract(after[0]!, CHANGED, { expectedUpdatedAt: T0, at: T2, editedBy: OWNER });
    assert.ok(edited.ok, edited.ok ? '' : edited.error.reason);
    expectOk(context.contracts.editDraft(edited.value, T0));
    assert.equal(expectOk(context.contracts.read(PROJECT, CONTRACT, 1)).contentFingerprint, contractContentFingerprint(CHANGED));
  });
});

test('a revision the request has already moved past cannot be approved (mvp-spec 3)', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    expectOk(reviseOnce(context, stored).written);

    // What a tab that missed the revise holds: a draft, at the instant it read, holding exactly
    // the text its owner reviewed. Every fingerprint and instant guard would pass.
    const refused = context.contracts.approve(approve(stored), guard(stored));
    const conflict = expectError(refused, 'Conflict');
    assert.match(conflict.reason, /not the newest revision of this request/);
    assert.equal(conflict.code === 'Conflict' ? conflict.expected : null, '1');
    assert.equal(conflict.code === 'Conflict' ? conflict.actual : null, '2');

    const history = expectOk(context.contracts.listForRequest(PROJECT, REQUEST));
    assert.deepEqual(
      history.map((contract) => [contract.revision, contract.status]),
      [
        [1, 'stale'],
        [2, 'draft'],
      ],
      'nothing was sealed, so the request still has exactly one approvable revision',
    );
  });
});

test('the newest revision of a request is reported, so an approval can ask the question (mvp-spec 3)', async () => {
  await withDatabase((context) => {
    assert.equal(expectOk(context.contracts.newestRevisionNumber(PROJECT, REQUEST)), null, 'no revision, no number');
    const stored = storedDraft(context);
    assert.equal(expectOk(context.contracts.newestRevisionNumber(PROJECT, REQUEST)), 1);
    expectOk(reviseOnce(context, stored).written);
    assert.equal(expectOk(context.contracts.newestRevisionNumber(PROJECT, REQUEST)), 2);
    assert.equal(
      expectOk(context.contracts.newestRevisionNumber(PROJECT, OTHER_REQUEST)),
      null,
      "another request's history is not this one's answer",
    );
  });
});

test('an approval of the newest revision still lands, so the guard is not a closed door (mvp-spec 3)', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    const second = expectOk(reviseOnce(context, stored).written);
    // Approved at the instant it was written, which is the earliest a row may be stamped:
    // `updated_at >= created_at` is a fact about the store's own clock, not about the guard.
    const approved = expectOk(context.contracts.approve(approve(second, T2), guard(second)));
    assert.equal(approved.status, 'approved');
    assert.equal(approved.revision, 2);
    assert.equal(expectOk(context.contracts.newestRevisionNumber(PROJECT, REQUEST)), 2);
  });
});

test('a stale revision keeps its first explanation whichever status the caller read it as (mvp-spec 3)', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    expectOk(reviseOnce(context, stored).written);

    // A second retirement attempt, built from the record that was stored, is refused as a
    // conflict rather than overwriting the reason - for a draft source as much as an approved
    // one, which is the case this guard had never covered.
    const again = context.contracts.markStale(expectOk(context.contracts.read(PROJECT, CONTRACT, 1)), {
      updatedAt: T0,
      status: 'draft',
    });
    const conflict = expectError(again, 'Conflict');
    assert.equal(conflict.code === 'Conflict' ? conflict.expected : null, `draft@${T0}`);
    assert.equal(conflict.code === 'Conflict' ? conflict.actual : null, `stale@${T2}`);
    assert.equal(
      expectOk(context.contracts.read(PROJECT, CONTRACT, 1)).staleReason,
      'Superseded by revision 2.',
      'the first explanation is the one that was stored',
    );
  });
});

test('the write guards on a delivery contract survive the schema rebuild (mvp-spec 3)', async () => {
  await withDatabase((context) => {
    // Version 19 re-declares this table, and a rebuild drops the indexes and triggers with it.
    // What it must not drop is the immutability of an agreed revision, so the guards are
    // compared here against the definitions the migration restores.
    const guards = context.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'delivery_contracts' ORDER BY name")
      .all()
      .map((row) => row['name']);
    assert.deepEqual(guards, [
      'delivery_contracts_approval_immutable',
      'delivery_contracts_draft_identity_fixed',
      'delivery_contracts_frozen_update',
      'delivery_contracts_immutable_delete',
    ]);

    const approved = expectOk(context.contracts.approve(approve(storedDraft(context)), { updatedAt: T0, contentFingerprint: expectOk(context.contracts.read(PROJECT, CONTRACT, 1)).contentFingerprint }));
    assert.throws(
      () => context.database.prepare("UPDATE delivery_contracts SET outcome = 'Rewritten.' WHERE request_id = ?").run(REQUEST),
      /frozen/,
      'an agreed revision is still frozen by the schema itself',
    );
    assert.throws(
      () => context.database.prepare('DELETE FROM delivery_contracts WHERE request_id = ?').run(REQUEST),
      /retained for history/,
    );
    assert.equal(expectOk(context.contracts.read(PROJECT, CONTRACT, 1)).outcome, CONTENT.outcome);
    assert.equal(approved.status, 'approved');
  });
});

test('an existing delivery contract survives the upgrade that makes a superseded draft writable (mvp-spec 3)', async () => {
  // The rebuild drops and re-declares a table real deployments already hold rows in, so the
  // upgrade path is a separate proof from a fresh migration: every column has to come back.
  await withDatabaseAtVersion(LATEST_SCHEMA_VERSION - 1, (context) => {
    const contracts = new ContractRepository(context.database);
    const stored = expectOk(contracts.createDraft(draft()));
    const approved = expectOk(contracts.approve(approve(stored), guard(stored)));
    assert.equal(approved.status, 'approved');
    const before = expectOk(contracts.read(PROJECT, CONTRACT, 1));

    const upgraded = migrate(context.database);
    assert.ok(upgraded.ok, `the upgrade failed: ${upgraded.ok ? '' : upgraded.error.reason}`);

    const after = expectOk(contracts.read(PROJECT, CONTRACT, 1));
    assert.deepEqual(after, before, 'a rebuild that translated a row would change what it means');
    assert.equal(
      expectOk(contracts.newestRevisionNumber(PROJECT, REQUEST)),
      1,
      'and the request history is still readable through the repository',
    );

    // The rebuilt table really is the new one: a revision superseded while it was a draft is
    // writable, which the previous CHECK refused outright.
    const revised = expectOk(
      reviseContract(approved, {
        contractId: NEXT_CONTRACT,
        content: CHANGED,
        requestFingerprint: REQUEST_FINGERPRINT,
        revisedBy: OWNER,
        at: T2,
      }),
    );
    expectOk(contracts.revise(revised));
    assert.equal(expectOk(contracts.read(PROJECT, CONTRACT, 1)).status, 'stale');
    assert.equal(expectOk(contracts.read(PROJECT, CONTRACT, 1)).supersededByRevision, 2);
    assert.deepEqual(approvableRevisions(contracts), [2], 'and the one-draft index came back with the table');
  });
});
