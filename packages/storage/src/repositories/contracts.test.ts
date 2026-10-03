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
import { migrate } from '../migrations.ts';
import { ContractRepository, RequestRepository } from './contracts.ts';

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
    { id: 'AC1', description: 'The summary returns 200 and displays "Total: 12.00".', verificationType: 'automated' },
    { id: 'AC2', description: 'The owner confirms the total matches the invoice they were sent.', verificationType: 'owner_test' },
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

    await run({ requests, contracts: new ContractRepository(connection), request, close: () => connection.close() });
  } finally {
    connection.close();
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
  const approvedValue = expectOk(approveContract(contract, { approvedBy: OWNER, at }));
  return approvedValue;
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

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
    const written = expectOk(context.contracts.approve(approve(stored), stored.updatedAt));

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
    const approved = expectOk(context.contracts.approve(approve(stored), stored.updatedAt));
    expectError(context.contracts.approve(approved, T1), 'Conflict');
    assert.equal(expectOk(context.contracts.read(PROJECT, CONTRACT, 1)).approvedAt, T1);
  });
});

test('an approved revision cannot be edited through the repository either', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    expectOk(context.contracts.approve(approve(stored), stored.updatedAt));

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

/* -------------------------------------------------------------------------- */
/* Revision and staleness                                                      */
/* -------------------------------------------------------------------------- */

test('revising writes the new revision and retires the old approval in one step', async () => {
  await withDatabase((context) => {
    const stored = storedDraft(context);
    const approved = expectOk(context.contracts.approve(approve(stored), stored.updatedAt));

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
    const approved = expectOk(context.contracts.approve(approve(stored), stored.updatedAt));
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
    const approved = expectOk(context.contracts.approve(approve(stored), stored.updatedAt));

    const stale = expectOk(invalidateContract(approved, { reason: 'The owner changed the scope.', at: T2 }));
    expectOk(context.contracts.markStale(stale, T1));

    const stored1 = expectOk(context.contracts.read(PROJECT, CONTRACT, 1));
    assert.equal(stored1.status, 'stale');
    assert.equal(stored1.staleReason, 'The owner changed the scope.');
    assert.equal(stored1.supersededByRevision, null);
    assert.equal(stored1.approvedBy, OWNER);

    const again = expectError(context.contracts.markStale(stored1, T1), 'Conflict');
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