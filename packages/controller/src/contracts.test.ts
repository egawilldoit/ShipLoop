/**
 * Behavioural proof for the request and delivery-contract use cases (mvp-spec 3).
 *
 * Real migrated SQLite files, real repositories, a stepped clock. No inline fixture
 * schema: the rows read and written here are the production rows, so a trigger or a CHECK
 * the domain relies on is exercised rather than assumed.
 *
 * The cases worth reading first are the ones proving a boundary rather than a flow:
 *
 *   - every use case refuses a non-owner before it reads a project-scoped row, so a
 *     refused caller learns nothing from the shape of the refusal (F01-AC1);
 *   - a request or revision belonging to another project is invisible, and the refusal
 *     is `NotFound` rather than `Forbidden`, so it does not confirm that the identifier
 *     exists elsewhere (F02-AC2, N02-AC3);
 *   - approval takes the approver from the authenticated actor, so no command can
 *     record an approval attributed to somebody else (mvp-spec 3);
 *   - approval also takes the fingerprint of the draft the caller read, so a tab that
 *     missed an edit is refused rather than sealing text its owner never saw, and the
 *     refused call leaves the revision a draft with no approver;
 *   - revising retires the previous approval in the same call, so no window exists in
 *     which revision 1 is approved while revision 2 is the text on screen.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprint } from '@shiploop/domain';
import type { ContractId, DomainError, OwnerId, ProjectId, RequestId, Result } from '@shiploop/domain';
import { ContractRepository, migrate, openDatabase, RequestRepository } from '@shiploop/storage';
import type { Database } from '@shiploop/storage';
import { createContractUseCases } from './contracts.ts';
import type { ContractContentInput, ContractUseCases } from './contracts.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';

const OWNER_ID = 'own_contracts_fixture' as OwnerId;
const OTHER_OWNER_ID = 'own_contracts_other' as OwnerId;
const PROJECT = '5c0a1f22-0000-4000-8000-00000000000a' as ProjectId;
const OTHER_PROJECT = '5c0a1f22-0000-4000-8000-00000000000b' as ProjectId;

const OWNER: OwnerActor = {
  actorId: OWNER_ID,
  role: 'Owner',
  ownerId: OWNER_ID,
  sessionId: 'session-contracts-1',
};

const CODING_AGENT: OwnerActor = {
  actorId: 'coding-agent-contracts',
  role: 'CodingAgent',
  ownerId: null,
  sessionId: null,
};

/** A role claiming Owner with no owner identity to attribute an approval to (F32-AC1). */
const UNATTRIBUTED: OwnerActor = {
  actorId: 'unattributed',
  role: 'Owner',
  ownerId: null,
  sessionId: null,
};

const CONTENT: ContractContentInput = {
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
    },
  ],
};

const CHANGED: ContractContentInput = {
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
  readonly useCases: ContractUseCases;
  readonly requests: RequestRepository;
  readonly contracts: ContractRepository;
  readonly database: Database;
  readonly requestId: RequestId;
  readonly contractId: ContractId;
}

/**
 * A stepped clock.
 *
 * One hour per reading, so two recorded instants in the same case stay ordered and a
 * replay is reproducible (mvp-spec 7). Nothing here reads ambient time.
 */
function steppedClock(): ControllerClock {
  let ticks = 0;
  return {
    now: () => {
      ticks += 1;
      const hour = String(9 + ticks).padStart(2, '0');
      return `2026-10-02T${hour}:00:00.000Z`;
    },
  };
}

async function withHarness(body: (harness: Harness) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-controller-contracts-'));
  const opened = openDatabase(join(directory, 'shiploop.sqlite'));
  assert.ok(opened.ok, `the database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
  try {
    assert.ok(migrate(opened.value).ok, 'the real schema migrated');
    opened.value.prepare('INSERT INTO owners (owner_id, display_name) VALUES (?, ?)').run(OWNER_ID, 'Solo owner');
    opened.value.prepare('INSERT INTO owners (owner_id, display_name) VALUES (?, ?)').run(OTHER_OWNER_ID, 'Other owner');
    opened.value.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(PROJECT, 'Checkout');
    opened.value.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(OTHER_PROJECT, 'Other');

    const requests = new RequestRepository(opened.value);
    const contracts = new ContractRepository(opened.value);
    const useCases = createContractUseCases({ clock: steppedClock(), requests, contracts });

    const request = expectOk(
      useCases.createRequest(
        {
          projectId: PROJECT,
          title: 'Checkout totals',
          description: 'The order summary shows the pre-tax total.',
        },
        OWNER,
      ),
    );
    const drafted = expectOk(
      useCases.draftContract(
        { projectId: PROJECT, requestId: request.requestId, content: CONTENT },
        OWNER,
      ),
    );

    await body({
      useCases,
      requests,
      contracts,
      database: opened.value,
      requestId: request.requestId,
      contractId: drafted.contractId as ContractId,
    });
  } finally {
    opened.value.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The fingerprint an owner's page would hold: whatever the revision says now.
 *
 * Read through the use case rather than computed here, so a case cannot approve against a
 * fingerprint the transport would never have been given.
 */
function reviewedDraft(harness: Harness): string {
  return expectOk(
    harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER),
  ).contentFingerprint;
}

/**
 * Approves revision 1 as an owner who has just read it.
 *
 * Every approval case goes through this, so none of them can accidentally approve by
 * naming a fingerprint nothing ever returned.
 */
function approveAsRead(harness: Harness, actor: OwnerActor = OWNER) {
  return harness.useCases.approveContract(
    {
      projectId: PROJECT,
      contractId: harness.contractId,
      revision: 1,
      expectedContentFingerprint: reviewedDraft(harness),
    },
    actor,
  );
}

/* -------------------------------------------------------------------------- */
/* Authorization                                                               */
/* -------------------------------------------------------------------------- */

test('every use case refuses a coding agent before it reads a project-scoped row (F01-AC1)', async () => {
  await withHarness((harness) => {
    const refusals: DomainError[] = [
      expectError(harness.useCases.createRequest({ projectId: PROJECT, title: 'x', description: 'y' }, CODING_AGENT), 'Forbidden'),
      expectError(harness.useCases.getRequest({ projectId: PROJECT, requestId: harness.requestId, expectedUpdatedAt: '' }, CODING_AGENT), 'Forbidden'),
      expectError(harness.useCases.listRequests(PROJECT, CODING_AGENT), 'Forbidden'),
      expectError(harness.useCases.updateRequest({ projectId: PROJECT, requestId: harness.requestId, expectedUpdatedAt: 'x' }, CODING_AGENT), 'Forbidden'),
      expectError(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, CODING_AGENT), 'Forbidden'),
      expectError(harness.useCases.listContractCriteria({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, CODING_AGENT), 'Forbidden'),
      expectError(harness.useCases.editContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CONTENT, expectedUpdatedAt: 'x' }, CODING_AGENT), 'Forbidden'),
      expectError(
        harness.useCases.approveContract(
          { projectId: PROJECT, contractId: harness.contractId, revision: 1, expectedContentFingerprint: 'fp_00000000000000000000000000000000' },
          CODING_AGENT,
        ),
        'Forbidden',
      ),
      expectError(harness.useCases.reviseContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CONTENT }, CODING_AGENT), 'Forbidden'),
      expectError(harness.useCases.invalidateContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1, reason: 'WithdrawnByOwner' }, CODING_AGENT), 'Forbidden'),
    ];
    for (const refusal of refusals) {
      assert.match(refusal.reason, /Only the owner may act on a request or its delivery contract/);
    }
  });
});

test('an unattributable Owner role cannot approve, because an approval needs an owner (F32-AC1)', async () => {
  await withHarness((harness) => {
    const refusal = expectError(
      harness.useCases.approveContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, expectedContentFingerprint: 'fp_00000000000000000000000000000000' },
        UNATTRIBUTED,
      ),
      'Forbidden',
    );
    assert.match(refusal.reason, /Only the owner/);
    assert.equal(expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER)).status, 'draft');
  });
});

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

test('a request needs no engine and no configured provider to be created and read', async () => {
  await withHarness((harness) => {
    const detail = expectOk(
      harness.useCases.getRequest({ projectId: PROJECT, requestId: harness.requestId, expectedUpdatedAt: '' }, OWNER),
    );
    assert.equal(detail.request.title, 'Checkout totals');
    assert.equal(detail.request.description, 'The order summary shows the pre-tax total.');
    assert.equal(detail.latestRevision?.revision, 1);
    assert.equal(detail.approvedRevision, null);
    assert.equal(detail.revisions.length, 1);
  });
});

test('the project is required, so a request can never have an unanswered "which project"', async () => {
  await withHarness((harness) => {
    expectError(
      harness.useCases.createRequest({ projectId: '  ' as ProjectId, title: 'Title', description: 'Something.' }, OWNER),
      'Invalid',
    );
  });
});

test('a draft request is editable, and the edit is a compare-and-set', async () => {
  await withHarness((harness) => {
    const before = expectOk(harness.useCases.getRequest({ projectId: PROJECT, requestId: harness.requestId, expectedUpdatedAt: '' }, OWNER)).request;

    const edited = expectOk(
      harness.useCases.updateRequest(
        {
          projectId: PROJECT,
          requestId: harness.requestId,
          description: 'The order summary shows the total including tax.',
          expectedUpdatedAt: before.updatedAt,
        },
        OWNER,
      ),
    );
    assert.match(edited.updatedAt, /^2026-10-02T/);
    assert.notEqual(edited.updatedAt, before.updatedAt);

    const conflict = expectError(
      harness.useCases.updateRequest(
        { projectId: PROJECT, requestId: harness.requestId, title: 'Retitled', expectedUpdatedAt: before.updatedAt },
        OWNER,
      ),
      'Conflict',
    );
    assert.equal(conflict.code === 'Conflict' ? conflict.expected : null, before.updatedAt);
  });
});

test('a request from another project is a NotFound, not a Forbidden that confirms it exists', async () => {
  await withHarness((harness) => {
    const refusal = expectError(
      harness.useCases.getRequest({ projectId: OTHER_PROJECT, requestId: harness.requestId, expectedUpdatedAt: '' }, OWNER),
      'NotFound',
    );
    assert.match(refusal.reason, /does not exist/);
    assert.deepEqual(expectOk(harness.useCases.listRequests(OTHER_PROJECT, OWNER)), []);
    assert.equal(expectOk(harness.useCases.listRequests(PROJECT, OWNER)).length, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* Drafting and editing                                                        */
/* -------------------------------------------------------------------------- */

test('a draft revision carries the content, the criteria and no approval', async () => {
  await withHarness((harness) => {
    const draft = expectOk(
      harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER),
    );
    assert.equal(draft.status, 'draft');
    assert.equal(draft.approvedBy, null);
    assert.equal(draft.approvedAt, null);
    assert.equal(draft.outcome, CONTENT.outcome);
    assert.deepEqual(draft.scope, CONTENT.scope);
    assert.deepEqual(draft.outOfScope, CONTENT.outOfScope);
    assert.deepEqual(
      draft.acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        description: criterion.description,
        verificationType: criterion.verificationType,
        submitted: (criterion as { verificationCheckId?: string | null }).verificationCheckId ?? null,
      })),
      CONTENT.acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        description: criterion.description,
        verificationType: criterion.verificationType,
        submitted: criterion.verificationCheckId ?? null,
      })),
    );
    assert.deepEqual(
      draft.acceptanceCriteria.map((criterion) => criterion.verificationCheckId),
      ['unit-tests', null],
      'a read-back always states each binding explicitly, so an omitted one reads as unbound rather than as a hole',
    );
    // A draft may not be measured against a candidate, and says why.
    assert.match(draft.blockedBecause ?? '', /only an approved revision/);
    assert.equal(draft.answersCurrentRequest, true);
  });
});

test('a second first revision is refused, so "the contract I am editing" stays one thing', async () => {
  await withHarness((harness) => {
    const conflict = expectError(
      harness.useCases.draftContract({ projectId: PROJECT, requestId: harness.requestId, content: CONTENT }, OWNER),
      'Conflict',
    );
    assert.match(conflict.reason, /already has 1 contract revision/);
    assert.equal(expectOk(harness.useCases.getRequest({ projectId: PROJECT, requestId: harness.requestId, expectedUpdatedAt: '' }, OWNER)).revisions.length, 1);
  });
});

test('editing a draft moves its content and keeps its revision number', async () => {
  await withHarness((harness) => {
    const before = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    const edited = expectOk(
      harness.useCases.editContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED, expectedUpdatedAt: before.updatedAt },
        OWNER,
      ),
    );
    assert.equal(edited.revision, 1);
    assert.equal(edited.outcome, CHANGED.outcome);
    assert.notEqual(edited.contentFingerprint, before.contentFingerprint);
    assert.equal(edited.status, 'draft');
  });
});

test('an edit that changes nothing is refused rather than reported as a save', async () => {
  await withHarness((harness) => {
    const before = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    expectError(
      harness.useCases.editContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CONTENT, expectedUpdatedAt: before.updatedAt },
        OWNER,
      ),
      'Invalid',
    );
  });
});

test('a contract with no acceptance criterion is refused: success would be undefined', async () => {
  await withHarness((harness) => {
    const second = expectOk(
      harness.useCases.createRequest({ projectId: PROJECT, title: 'Refunds', description: 'A refund is issued.' }, OWNER),
    );
    const refusal = expectError(
      harness.useCases.draftContract(
        { projectId: PROJECT, requestId: second.requestId, content: { ...CONTENT, acceptanceCriteria: [] } },
        OWNER,
      ),
      'Invalid',
    );
    // The field message names the criterion list, because that is what a form must fix.
    assert.match(
      refusal.code === 'Invalid' ? refusal.fields.map((entry) => entry.message).join(' ') : '',
      /at least one acceptance criterion/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Approval                                                                    */
/* -------------------------------------------------------------------------- */

test('approval records the authenticated owner, not one the command names', async () => {
  await withHarness((harness) => {
    const before = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    const approved = expectOk(approveAsRead(harness));
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedBy, String(OWNER_ID));
    assert.match(approved.approvedAt ?? '', /^2026-10-02T/);
    assert.notEqual(approved.updatedAt, before.updatedAt);
    assert.equal(approved.blockedBecause, null);
    assert.equal(
      expectOk(harness.useCases.getRequest({ projectId: PROJECT, requestId: harness.requestId, expectedUpdatedAt: '' }, OWNER)).approvedRevision?.revision,
      1,
    );
  });
});

test('approving twice is refused, and the first approval stands', async () => {
  await withHarness((harness) => {
    expectOk(approveAsRead(harness));
    expectError(approveAsRead(harness), 'Conflict');
    const read = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    assert.equal(read.status, 'approved');
  });
});

test('an approved revision cannot be re-approved as a different payload', async () => {
  await withHarness((harness) => {
    const tabRead = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    const firstApproval = expectOk(approveAsRead(harness));
    // Same revision, same status, and an approval that names text this revision does not
    // hold: an approval is not a second write over a frozen agreement, whatever it claims.
    const refused = expectError(
      harness.useCases.approveContract(
        {
          projectId: PROJECT,
          contractId: harness.contractId,
          revision: 1,
          expectedContentFingerprint: fingerprint({ outcome: 'A scope nobody agreed to.' }),
        },
        OWNER,
      ),
      'Conflict',
    );
    assert.match(refused.reason, /already approved/);

    const sealed = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    assert.equal(sealed.status, 'approved');
    assert.equal(sealed.outcome, CONTENT.outcome, 'the frozen text is untouched');
    assert.equal(sealed.contentFingerprint, tabRead.contentFingerprint, 'and the sealed fingerprint is still the reviewed one');
    assert.equal(sealed.approvedBy, String(OWNER_ID));
    assert.equal(sealed.approvedAt, firstApproval.approvedAt, 'the recorded instant is the first approval, not a later one');
  });
});

test('two tabs: the second edit is refused against a stale read, and the owner is told to reload', async () => {
  await withHarness((harness) => {
    const tabA = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    const tabB = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));

    const written = expectOk(
      harness.useCases.editContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED, expectedUpdatedAt: tabB.updatedAt },
        OWNER,
      ),
    );
    assert.notEqual(written.contentFingerprint, tabA.contentFingerprint);

    // Tab A still holds its own read, and its write is refused rather than merged over the
    // text tab B just wrote: two tabs cannot both believe they saved the draft.
    const refused = expectError(
      harness.useCases.editContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CONTENT, expectedUpdatedAt: tabA.updatedAt },
        OWNER,
      ),
      'Conflict',
    );
    assert.match(refused.reason, /Reload it before saving again/);
    const stored = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    assert.equal(stored.outcome, CHANGED.outcome, "tab B's write is what survived");
    assert.equal(stored.scope.length, CHANGED.scope.length);
  });
});

test('two tabs: the first approval is refused because it names text the owner never saw', async () => {
  await withHarness((harness) => {
    // Tab A opens the draft.
    const tabA = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    assert.equal(tabA.status, 'draft');

    // Tab B edits it, which is legitimate: it read the same instant tab A did.
    const edited = expectOk(
      harness.useCases.editContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED, expectedUpdatedAt: tabA.updatedAt },
        OWNER,
      ),
    );
    assert.notEqual(edited.contentFingerprint, tabA.contentFingerprint);

    // Tab A presses approve on the text it is still showing. The defect this closes: before
    // the compare-and-set, this call succeeded and sealed tab B's scope as though tab A had
    // read it.
    const refused = expectError(
      harness.useCases.approveContract(
        {
          projectId: PROJECT,
          contractId: harness.contractId,
          revision: 1,
          expectedContentFingerprint: tabA.contentFingerprint,
        },
        OWNER,
      ),
      'Conflict',
    );
    assert.equal(refused.code === 'Conflict' ? refused.expected : null, tabA.contentFingerprint);
    assert.equal(refused.code === 'Conflict' ? refused.actual : null, edited.contentFingerprint);
    assert.match(refused.reason, /text you did not review/);

    // The refusal moved nothing: no approval, no approver, and tab B's text intact.
    const afterRefusal = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    assert.equal(afterRefusal.status, 'draft', 'nothing was sealed');
    assert.equal(afterRefusal.approvedBy, null);
    assert.equal(afterRefusal.approvedAt, null);
    assert.equal(afterRefusal.outcome, CHANGED.outcome);
    assert.equal(
      expectOk(harness.useCases.getRequest({ projectId: PROJECT, requestId: harness.requestId, expectedUpdatedAt: '' }, OWNER)).approvedRevision,
      null,
      'no revision reads as approved, so no candidate may be measured against this request',
    );

    // Step 4: the owner reloads and reads the revised text.
    const reloaded = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    assert.equal(reloaded.contentFingerprint, edited.contentFingerprint);
    assert.equal(reloaded.outcome, CHANGED.outcome, 'the owner now sees what will be agreed');

    // Step 5: approving what the reload showed works, and it seals that text.
    const approved = expectOk(
      harness.useCases.approveContract(
        {
          projectId: PROJECT,
          contractId: harness.contractId,
          revision: 1,
          expectedContentFingerprint: reloaded.contentFingerprint,
        },
        OWNER,
      ),
    );
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedBy, String(OWNER_ID));
    assert.equal(approved.outcome, CHANGED.outcome);
    assert.equal(approved.contentFingerprint, edited.contentFingerprint);
    assert.equal(approved.blockedBecause, null);
  });
});

test('an approval naming a value that is not a fingerprint is refused as a bad request, not a conflict', async () => {
  await withHarness((harness) => {
    for (const value of ['', 'not-a-fingerprint', 'fp_short', 'fp_0000000000000000000000000000000G']) {
      const refused = expectError(
        harness.useCases.approveContract(
          { projectId: PROJECT, contractId: harness.contractId, revision: 1, expectedContentFingerprint: value },
          OWNER,
        ),
        'Invalid',
      );
      assert.match(
        refused.code === 'Invalid' ? refused.fields.map((field) => `${field.path}: ${field.message}`).join(' ') : '',
        /expectedContentFingerprint/,
      );
    }
    assert.equal(
      expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER)).status,
      'draft',
    );
  });
});

test('a refused no-op edit does not invalidate the page that read the draft', async () => {
  await withHarness((harness) => {
    const read = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));

    // Another tab saves without changing anything. The domain refuses it as a no-op, so
    // nothing was written and the fingerprint this page holds is still current - which is
    // why approval below is not refused. An implementation that bumped a counter on every
    // save attempt would refuse an owner who had not been lied to.
    expectError(
      harness.useCases.editContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CONTENT, expectedUpdatedAt: read.updatedAt },
        OWNER,
      ),
      'Invalid',
    );

    const approved = expectOk(approveAsRead(harness));
    assert.equal(approved.status, 'approved');
    assert.equal(approved.contentFingerprint, read.contentFingerprint);
  });
});

test('an approved revision cannot be edited: a new revision is the way forward', async () => {
  await withHarness((harness) => {
    const approved = expectOk(approveAsRead(harness));
    const refusal = expectError(
      harness.useCases.editContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED, expectedUpdatedAt: approved.updatedAt },
        OWNER,
      ),
      'Invalid',
    );
    assert.match(refusal.code === 'Invalid' ? refusal.reason : '', /cannot be edited/);
    assert.match(
      refusal.code === 'Invalid' ? refusal.fields.map((entry) => entry.message).join(' ') : '',
      /frozen/,
    );
    assert.equal(
      expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER)).outcome,
      CONTENT.outcome,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Revision and staleness                                                      */
/* -------------------------------------------------------------------------- */

test('revising retires the previous approval in the same call', async () => {
  await withHarness((harness) => {
    const approved = expectOk(approveAsRead(harness));

    const revision2 = expectOk(
      harness.useCases.reviseContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED },
        OWNER,
      ),
    );
    assert.equal(revision2.revision, 2);
    assert.equal(revision2.status, 'draft');
    assert.notEqual(revision2.contractId, harness.contractId, 'a revision is a different agreement, not a renamed one');
    assert.equal(revision2.approvedBy, null);

    const detail = expectOk(harness.useCases.getRequest({ projectId: PROJECT, requestId: harness.requestId, expectedUpdatedAt: '' }, OWNER));
    assert.equal(detail.approvedRevision, null, 'revision 1 no longer reads as current');
    assert.equal(detail.latestRevision?.revision, 2);
    assert.deepEqual(
      detail.revisions.map((revision) => [revision.revision, revision.status]),
      [
        [1, 'stale'],
        [2, 'draft'],
      ],
    );
    const previous = detail.revisions[0];
    assert.equal(previous?.supersededByRevision, 2);
    assert.match(previous?.staleReason ?? '', /revision 2/);
    // History, not a deletion: revision 1 kept the text and the approval it carried.
    assert.equal(previous?.outcome, CONTENT.outcome);
    assert.equal(previous?.approvedBy, String(OWNER_ID));
    assert.notEqual(previous?.updatedAt, approved.updatedAt);
  });
});

test('a request edit makes the approval stop answering the request, without demoting it', async () => {
  await withHarness((harness) => {
    expectOk(approveAsRead(harness));
    const request = expectOk(harness.useCases.getRequest({ projectId: PROJECT, requestId: harness.requestId, expectedUpdatedAt: '' }, OWNER)).request;

    expectOk(
      harness.useCases.updateRequest(
        {
          projectId: PROJECT,
          requestId: harness.requestId,
          description: 'The order summary shows the total including tax, and shipping.',
          expectedUpdatedAt: request.updatedAt,
        },
        OWNER,
      ),
    );

    const contract = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    // Reported, not acted on: whether a request edit invalidates an agreement about the
    // request is the owner's call, so the layer reports and does not decide.
    assert.equal(contract.answersCurrentRequest, false);
    assert.equal(contract.status, 'approved');
    assert.equal(
      expectOk(harness.useCases.getRequest({ projectId: PROJECT, requestId: harness.requestId, expectedUpdatedAt: '' }, OWNER)).approvedRevision?.answersCurrentRequest,
      false,
    );
  });
});

test('retiring an approval records the reason, and the vocabulary is closed', async () => {
  await withHarness((harness) => {
    expectOk(approveAsRead(harness));
    const stale = expectOk(
      harness.useCases.invalidateContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1, reason: 'RequestChanged' }, OWNER),
    );
    assert.equal(stale.status, 'stale');
    assert.match(stale.staleReason ?? '', /request this revision answers has changed/);
    assert.equal(stale.supersededByRevision, null);
    assert.match(stale.blockedBecause ?? '', /only an approved revision/);

    // The vocabulary is closed, so a reason a client cannot act on is refused by name
    // rather than stored as a sentence nobody reads.
    const unlisted = expectError(
      harness.useCases.invalidateContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, reason: 'because' as 'RequestChanged' },
        OWNER,
      ),
      'Invalid',
    );
    assert.match(unlisted.reason, /is not a reason a delivery contract can be made stale for/);

    // And a revision that is already stale cannot be given a second, different reason,
    // so the first explanation survives.
    const again = expectError(
      harness.useCases.invalidateContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1, reason: 'WithdrawnByOwner' }, OWNER),
      'Conflict',
    );
    assert.match(again.reason, /already stale/);
    assert.equal(
      expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER)).staleReason,
      stale.staleReason,
      'the first reason is the one that was stored',
    );
  });
});

test('retiring a draft is refused: a draft has no approval to retire', async () => {
  await withHarness((harness) => {
    expectError(
      harness.useCases.invalidateContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1, reason: 'WithdrawnByOwner' }, OWNER),
      'Conflict',
    );
  });
});

test('superseding without a replacement says which revision replaced it', async () => {
  await withHarness((harness) => {
    expectOk(approveAsRead(harness));
    const stale = expectOk(
      harness.useCases.supersedeContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, supersededByRevision: 2 },
        OWNER,
      ),
    );
    assert.equal(stale.status, 'stale');
    assert.equal(stale.supersededByRevision, 2);
    assert.match(stale.staleReason ?? '', /revision 2/);
  });
});

test('superseding by an earlier revision is refused', async () => {
  await withHarness((harness) => {
    expectOk(approveAsRead(harness));
    expectError(
      harness.useCases.supersedeContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1, supersededByRevision: 1 }, OWNER),
      'Invalid',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Criteria                                                                    */
/* -------------------------------------------------------------------------- */

test('the criteria of a revision are listed in the order they were written', async () => {
  await withHarness((harness) => {
    const criteria = expectOk(
      harness.useCases.listContractCriteria({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER),
    );
    assert.deepEqual(
      criteria.map((criterion) => [criterion.id, criterion.verificationType]),
      [
        ['AC1', 'automated'],
        ['AC2', 'owner_test'],
      ],
    );
  });
});

test('an approved revision lists the criteria its approval covered', async () => {
  await withHarness((harness) => {
    expectOk(approveAsRead(harness));
    const criteria = expectOk(
      harness.useCases.listContractCriteria({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER),
    );
    assert.equal(criteria.length, 2);
  });
});

/* -------------------------------------------------------------------------- */
/* Cross-project isolation                                                     */
/* -------------------------------------------------------------------------- */

test('a revision addressed at another project is invisible', async () => {
  await withHarness((harness) => {
    expectError(harness.useCases.getContract({ projectId: OTHER_PROJECT, contractId: harness.contractId, revision: 1 }, OWNER), 'NotFound');
    expectError(
      harness.useCases.listContractCriteria({ projectId: OTHER_PROJECT, contractId: harness.contractId, revision: 1 }, OWNER),
      'NotFound',
    );
    expectError(
      harness.useCases.approveContract(
        { projectId: OTHER_PROJECT, contractId: harness.contractId, revision: 1, expectedContentFingerprint: reviewedDraft(harness) },
        OWNER,
      ),
      'NotFound',
    );
    // The write that would have changed something was refused, so nothing changed.
    assert.equal(
      expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER)).status,
      'draft',
    );
  });
});

test('a request in another project cannot be given a contract addressed at this one', async () => {
  await withHarness((harness) => {
    const elsewhere = expectOk(
      harness.useCases.createRequest(
        { projectId: OTHER_PROJECT, title: 'Refunds', description: 'A refund is issued for a cancelled order.' },
        OWNER,
      ),
    );
    // The contract is drafted against this request, addressed at the other project: the
    // request is not visible there, so nothing is written.
    expectError(
      harness.useCases.draftContract(
        { projectId: OTHER_PROJECT, requestId: harness.requestId, content: CONTENT },
        OWNER,
      ),
      'NotFound',
    );
    // The right pairing works, and lands in its own project.
    expectOk(
      harness.useCases.draftContract(
        { projectId: OTHER_PROJECT, requestId: elsewhere.requestId, content: CONTENT },
        OWNER,
      ),
    );
    assert.equal(expectOk(harness.useCases.getRequest({ projectId: OTHER_PROJECT, requestId: elsewhere.requestId, expectedUpdatedAt: '' }, OWNER)).revisions.length, 1);
    assert.equal(expectOk(harness.useCases.getRequest({ projectId: PROJECT, requestId: harness.requestId, expectedUpdatedAt: '' }, OWNER)).revisions.length, 1);
  });
});

test('an unknown revision of a known contract is a NotFound naming the revision', async () => {
  await withHarness((harness) => {
    const refusal = expectError(
      harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 7 }, OWNER),
      'NotFound',
    );
    assert.match(refusal.reason, /#7/);
  });
});
/* -------------------------------------------------------------------------- */
/* The verification binding, refused server-side at approval                   */
/* -------------------------------------------------------------------------- */

const UNBOUND_AUTOMATED: ContractContentInput = {
  ...CONTENT,
  acceptanceCriteria: [
    { id: 'AC1', description: 'The summary returns 200.', verificationType: 'automated' },
    { id: 'AC2', description: 'The owner confirms the total.', verificationType: 'owner_test' },
  ],
};

test('a draft whose automated criterion names no check may be written, because authoring is not agreeing', async () => {
  await withHarness((harness) => {
    const second = expectOk(
      harness.useCases.createRequest({ projectId: PROJECT, title: 'Refunds', description: 'A refund is issued.' }, OWNER),
    );
    const draft = expectOk(
      harness.useCases.draftContract(
        { projectId: PROJECT, requestId: second.requestId, content: UNBOUND_AUTOMATED },
        OWNER,
      ),
    );
    assert.deepEqual(
      draft.acceptanceCriteria.map((criterion) => criterion.verificationCheckId),
      [null, null],
      'an omitted binding is read back as unbound, which is the state the gate will refuse',
    );
  });
});

test('approving a revision whose automated criterion names no check is refused', async () => {
  await withHarness((harness) => {
    const second = expectOk(
      harness.useCases.createRequest({ projectId: PROJECT, title: 'Refunds', description: 'A refund is issued.' }, OWNER),
    );
    const draft = expectOk(
      harness.useCases.draftContract(
        { projectId: PROJECT, requestId: second.requestId, content: UNBOUND_AUTOMATED },
        OWNER,
      ),
    );

    const refusal = expectError(
      harness.useCases.approveContract(
        {
          projectId: PROJECT,
          contractId: draft.contractId as ContractId,
          revision: 1,
          // The approval names the draft it reviewed; omitting it is refused by the CAS guard
          // before the binding rule below is ever consulted, so this fixture would otherwise be
          // proving the wrong refusal.
          expectedContentFingerprint: draft.contentFingerprint,
        },
        OWNER,
      ),
      'Invalid',
    );
    assert.match(refusal.reason, /automated criterion\(s\) name no check/);
    assert.match(
      refusal.code === 'Invalid' ? (refusal.fields ?? []).map((field) => field.path).join(' ') : '',
      /acceptanceCriteria\.AC1\.verificationCheckId/,
      'the refusal names the criterion the owner has to bind',
    );
    assert.equal(
      expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: draft.contractId as ContractId, revision: 1 }, OWNER)).status,
      'draft',
      'and nothing was approved on the way to the refusal',
    );
  });
});

test('binding the check makes the same revision approvable', async () => {
  await withHarness((harness) => {
    const second = expectOk(
      harness.useCases.createRequest({ projectId: PROJECT, title: 'Refunds', description: 'A refund is issued.' }, OWNER),
    );
    const draft = expectOk(
      harness.useCases.draftContract(
        { projectId: PROJECT, requestId: second.requestId, content: UNBOUND_AUTOMATED },
        OWNER,
      ),
    );
    const edited = expectOk(
      harness.useCases.editContract(
        {
          projectId: PROJECT,
          contractId: draft.contractId as ContractId,
          revision: 1,
          content: CONTENT,
          expectedUpdatedAt: draft.updatedAt,
        },
        OWNER,
      ),
    );
    const approved = expectOk(
      harness.useCases.approveContract(
        {
          projectId: PROJECT,
          contractId: draft.contractId as ContractId,
          revision: 1,
          // The fingerprint of the text being approved, which after the edit above is `edited`,
          // not `draft`. Naming the pre-edit fingerprint would be refused by the CAS guard — the
          // guard working: the owner approved the bound text, not the text they first drafted.
          expectedContentFingerprint: edited.contentFingerprint,
        },
        OWNER,
      ),
    );
    assert.equal(approved.status, 'approved');
    assert.deepEqual(
      approved.acceptanceCriteria.map((criterion) => criterion.verificationCheckId),
      ['unit-tests', null],
    );
    assert.notEqual(edited.contentFingerprint, draft.contentFingerprint, 'the binding is part of the frozen content');
  });
});

test('an owner test needs no binding, and one that names a check is refused by name', async () => {
  await withHarness((harness) => {
    // The seeded revision is approved with an automated criterion bound to `unit-tests` and an
    // owner test left unbound, which is the shape an owner agrees to.
    const criteria = expectOk(
      harness.useCases.listContractCriteria(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1 },
        OWNER,
      ),
    );
    assert.deepEqual(
      criteria.map((criterion) => criterion.verificationCheckId),
      ['unit-tests', null],
    );

    const refusal = expectError(
      harness.useCases.editContract(
        {
          projectId: PROJECT,
          contractId: harness.contractId,
          revision: 1,
          content: {
            ...CONTENT,
            acceptanceCriteria: [
              { id: 'AC1', description: 'The summary returns 200.', verificationType: 'automated', verificationCheckId: 'unit-tests' },
              { id: 'AC2', description: 'The owner confirms the total.', verificationType: 'owner_test', verificationCheckId: 'unit-tests' },
            ],
          },
          expectedUpdatedAt: expectOk(
            harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER),
          ).updatedAt,
        },
        OWNER,
      ),
      'Invalid',
    );
    assert.match(
      refusal.code === 'Invalid' ? (refusal.fields ?? []).map((field) => field.message).join(' ') : '',
      /only the owner can judge/,
    );
  });
});

test('a binding that is not text is refused rather than dropped', async () => {
  await withHarness((harness) => {
    const second = expectOk(
      harness.useCases.createRequest({ projectId: PROJECT, title: 'Refunds', description: 'A refund is issued.' }, OWNER),
    );
    const refusal = expectError(
      harness.useCases.draftContract(
        {
          projectId: PROJECT,
          requestId: second.requestId,
          content: {
            ...CONTENT,
            acceptanceCriteria: [
              // The transport boundary is where untrusted JSON meets the domain's types, so a
              // binding that is neither text nor null is refused here rather than coerced.
              { id: 'AC1', description: 'It works.', verificationType: 'automated', verificationCheckId: 7 } as unknown as {
                id: string;
                description: string;
                verificationType: 'automated';
                verificationCheckId: string | null;
              },
            ],
          },
        },
        OWNER,
      ),
      'Invalid',
    );
    assert.match(refusal.reason, /check name or absent/);
  });
});
