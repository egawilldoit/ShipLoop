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

/**
 * A clock that does not move.
 *
 * Two tabs whose reads and whose writes all land in one millisecond is the case a timestamp
 * lock cannot see, and it cannot be reached by waiting for a real clock to be slow: it has to
 * be arranged. `TESTING.md` asks for injected clocks for exactly this reason, so the race is
 * a fact of the fixture rather than a hope about the host (mvp-spec 7).
 */
function frozenClock(at = '2026-10-02T09:00:00.000Z'): ControllerClock {
  return { now: () => at };
}

async function withHarness(
  body: (harness: Harness) => Promise<void> | void,
  clock: ControllerClock = steppedClock(),
): Promise<void> {
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
    const useCases = createContractUseCases({ clock, requests, contracts });

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
      expectError(harness.useCases.editContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CONTENT, expectedContentFingerprint: 'fp_00000000000000000000000000000000' }, CODING_AGENT), 'Forbidden'),
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
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED, expectedContentFingerprint: before.contentFingerprint },
        OWNER,
      ),
    );
    assert.equal(edited.revision, 1);
    assert.equal(edited.outcome, CHANGED.outcome);
    assert.notEqual(edited.contentFingerprint, before.contentFingerprint);
    assert.equal(edited.status, 'draft');
  });
});

test('the edit answer carries the fingerprint the next edit and the approval need', async () => {
  await withHarness((harness) => {
    const before = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    const edited = expectOk(
      harness.useCases.editContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED, expectedContentFingerprint: before.contentFingerprint },
        OWNER,
      ),
    );
    // The value the answer reports is the value the row now holds, so a client that renders
    // this answer can edit or approve without a second round trip - and cannot be holding a
    // lock that already describes replaced text.
    const reread = expectOk(
      harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER),
    );
    assert.equal(edited.contentFingerprint, reread.contentFingerprint);

    const second = expectOk(
      harness.useCases.editContract(
        {
          projectId: PROJECT,
          contractId: harness.contractId,
          revision: 1,
          content: { ...CHANGED, outcome: 'A second edit, sent back with the first answer.' },
          expectedContentFingerprint: edited.contentFingerprint,
        },
        OWNER,
      ),
    );
    assert.notEqual(second.contentFingerprint, edited.contentFingerprint);
    expectOk(
      harness.useCases.approveContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, expectedContentFingerprint: second.contentFingerprint },
        OWNER,
      ),
    );
  });
});

test('an edit that changes nothing is refused rather than reported as a save', async () => {
  await withHarness((harness) => {
    const before = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    expectError(
      harness.useCases.editContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CONTENT, expectedContentFingerprint: before.contentFingerprint },
        OWNER,
      ),
      'Invalid',
    );
  });
});

test('an edit has to name the text it replaces, so a body cannot save over whatever is stored', async () => {
  await withHarness((harness) => {
    const unnamed = expectError(
      harness.useCases.editContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED, expectedContentFingerprint: '' },
        OWNER,
      ),
      'Invalid',
    );
    assert.equal(
      unnamed.code === 'Invalid' ? unnamed.fields[0]?.path : null,
      'expectedContentFingerprint',
      'the refusal names the field the owner has to send',
    );
    const nonsense = expectError(
      harness.useCases.editContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED, expectedContentFingerprint: 'fp_not-a-fingerprint' },
        OWNER,
      ),
      'Invalid',
    );
    assert.equal(nonsense.code === 'Invalid' ? nonsense.fields[0]?.path : null, 'expectedContentFingerprint');
    assert.equal(expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER)).outcome, CONTENT.outcome);
  });
});

test('an approved revision cannot be edited, whichever fingerprint it is sent', async () => {
  await withHarness((harness) => {
    const read = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    const approved = expectOk(approveAsRead(harness));
    // The refusal is about the status and not about the lock, so it is the same whether the
    // fingerprint is current, stale, or invented.
    for (const expectedContentFingerprint of [read.contentFingerprint, fingerprint({ outcome: 'Nothing stored.' })]) {
      const refused = expectError(
        harness.useCases.editContract(
          { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED, expectedContentFingerprint },
          OWNER,
        ),
        'Invalid',
      );
      assert.match(
        refused.code === 'Invalid' ? refused.fields.map((field) => field.message).join(' ') : '',
        /approved revision is frozen/,
      );
    }
    const sealed = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    assert.equal(sealed.outcome, CONTENT.outcome, 'and the approved text is unchanged');
    assert.equal(sealed.contentFingerprint, read.contentFingerprint);
    assert.equal(sealed.approvedAt, approved.approvedAt);
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
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED, expectedContentFingerprint: tabB.contentFingerprint },
        OWNER,
      ),
    );
    assert.notEqual(written.contentFingerprint, tabA.contentFingerprint);

    // Tab A still holds its own read, and its write is refused rather than merged over the
    // text tab B just wrote: two tabs cannot both believe they saved the draft.
    const refused = expectError(
      harness.useCases.editContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CONTENT, expectedContentFingerprint: tabA.contentFingerprint },
        OWNER,
      ),
      'Conflict',
    );
    assert.match(refused.reason, /Reload it before saving again/);
    assert.equal(refused.code === 'Conflict' ? refused.expected : null, tabA.contentFingerprint);
    assert.equal(refused.code === 'Conflict' ? refused.actual : null, written.contentFingerprint);
    const stored = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    assert.equal(stored.outcome, CHANGED.outcome, "tab B's write is what survived");
    assert.equal(stored.scope.length, CHANGED.scope.length);
  });
});

test('F24-AC4: two tabs writing in the same millisecond, the loser is refused and the winner is stored intact', async () => {
  // Every instant in this case is the same one. Two tabs read the draft, the first tab saves,
  // and the second tab saves within the same millisecond - so after the first write the
  // stored `updated_at` is byte-identical to the one the second tab is still holding, and a
  // write locked on the instant has nothing left to notice. Real repositories, real SQLite,
  // a clock that does not move.
  await withHarness(
    (harness) => {
      const instant = '2026-10-02T09:00:00.000Z';
      const tabA = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
      const tabB = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
      assert.equal(tabA.updatedAt, tabB.updatedAt);
      assert.equal(tabA.contentFingerprint, tabB.contentFingerprint);

      const fromA: ContractContentInput = { ...CHANGED, outcome: 'The summary shows the total and the shipping total.' };
      const fromB: ContractContentInput = { ...CHANGED, outcome: 'The summary shows the total and the currency code.' };

      const winner = expectOk(
        harness.useCases.editContract(
          { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: fromA, expectedContentFingerprint: tabA.contentFingerprint },
          OWNER,
        ),
      );
      assert.equal(winner.updatedAt, instant, 'the first write did not move the clock, so the instant cannot be the lock');

      // The defect this closes: before the fingerprint lock, this call succeeded and the
      // draft ended up holding tab B's text with both tabs reporting a save.
      const loser = expectError(
        harness.useCases.editContract(
          { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: fromB, expectedContentFingerprint: tabB.contentFingerprint },
          OWNER,
        ),
        'Conflict',
      );
      assert.match(loser.reason, /changed after it was loaded/);
      assert.equal(loser.code === 'Conflict' ? loser.expected : null, tabB.contentFingerprint, 'the refusal names what the tab read');
      assert.equal(loser.code === 'Conflict' ? loser.actual : null, winner.contentFingerprint, 'and what is stored');

      // Nothing of the losing write landed, and the winner is readable as it was answered.
      const stored = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
      assert.equal(stored.outcome, fromA.outcome);
      assert.deepEqual([...stored.scope], [...fromA.scope]);
      assert.equal(stored.contentFingerprint, winner.contentFingerprint);
      assert.equal(stored.updatedAt, instant, 'no clock moved, so nothing here can be attributed to a later write');
      assert.equal(stored.status, 'draft', 'and the draft was never sealed over either text');
    },
    frozenClock(),
  );
});

test('two tabs: the first approval is refused because it names text the owner never saw', async () => {
  await withHarness((harness) => {
    // Tab A opens the draft.
    const tabA = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    assert.equal(tabA.status, 'draft');

    // Tab B edits it, which is legitimate: it read the same draft tab A did.
    const edited = expectOk(
      harness.useCases.editContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED, expectedContentFingerprint: tabA.contentFingerprint },
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
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CONTENT, expectedContentFingerprint: read.contentFingerprint },
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
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED, expectedContentFingerprint: approved.contentFingerprint },
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

test('retiring a draft supersedes it, so the owner can leave a request with nothing to approve', async () => {
  await withHarness((harness) => {
    const stale = expectOk(
      harness.useCases.supersedeContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, supersededByRevision: 2 },
        OWNER,
      ),
    );
    assert.equal(stale.status, 'stale');
    assert.equal(stale.supersededByRevision, 2);
    assert.equal(stale.approvedBy, null, 'a draft is retired without inventing an approval');
    assert.equal(stale.approvedAt, null);
    assert.match(stale.blockedBecause ?? '', /only an approved revision/);

    // And it really is no longer approvable, through the read a client would make.
    const detail = expectOk(harness.useCases.getRequest({ projectId: PROJECT, requestId: harness.requestId, expectedUpdatedAt: '' }, OWNER));
    assert.equal(detail.approvedRevision, null);
    assert.equal(detail.latestRevision?.status, 'stale');
    assert.equal(detail.latestRevision?.supersededByRevision, 2);
  });
});

/* -------------------------------------------------------------------------- */
/* One approvable revision per request (mvp-spec 3)                           */
/* -------------------------------------------------------------------------- */

/** The revisions of the harness request that could still be approved. */
function approvableRevisions(harness: Harness): readonly number[] {
  return expectOk(harness.useCases.listContractRevisions({ projectId: PROJECT, requestId: harness.requestId }, OWNER))
    .filter((revision) => revision.status === 'draft')
    .map((revision) => revision.revision);
}

test('revising a draft supersedes it, so a request never holds two approvable revisions (mvp-spec 3)', async () => {
  await withHarness((harness) => {
    const revision2 = expectOk(
      harness.useCases.reviseContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED },
        OWNER,
      ),
    );
    assert.equal(revision2.revision, 2);
    assert.equal(revision2.status, 'draft');
    assert.deepEqual(approvableRevisions(harness), [2], 'the draft it was written from is no longer approvable');

    // The read a client makes reports it as history, with the revision that replaced it, so a
    // card can tell "there is something newer" from "there is nothing left".
    const detail = expectOk(harness.useCases.getRequest({ projectId: PROJECT, requestId: harness.requestId, expectedUpdatedAt: '' }, OWNER));
    assert.deepEqual(
      detail.revisions.map((revision) => [revision.revision, revision.status]),
      [
        [1, 'stale'],
        [2, 'draft'],
      ],
    );
    assert.equal(detail.revisions[0]?.supersededByRevision, 2);
    assert.match(detail.revisions[0]?.staleReason ?? '', /revision 2/);
    assert.equal(detail.revisions[0]?.approvedBy, null, 'revision 1 was never agreed, and the view says so');
    assert.match(detail.revisions[0]?.blockedBecause ?? '', /only an approved revision/);
    assert.equal(detail.revisions[0]?.outcome, CONTENT.outcome, 'history keeps the text it carried');
  });
});

test('the superseded revision is refused an approval, and the revision that replaced it is not (mvp-spec 3)', async () => {
  await withHarness((harness) => {
    // What the tab that missed the revise holds: revision 1's fingerprint, read before the
    // write. Nothing about the text is wrong - it is exactly what its owner reviewed - which
    // is why the refusal cannot come from the fingerprint.
    const reviewedBeforeTheRevise = reviewedDraft(harness);
    const revision2 = expectOk(
      harness.useCases.reviseContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED },
        OWNER,
      ),
    );

    // The use case re-reads the revision rather than trusting the caller's copy, so it is told
    // what revision 1 now is. The refusal therefore names the state the row holds; the newest-
    // revision check underneath it is what closes the window where the re-read is still a draft
    // but revision 2 has landed, which is proved at the store boundary, where it can be
    // reached with a stale in-memory record.
    const refused = expectError(
      harness.useCases.approveContract(
        {
          projectId: PROJECT,
          contractId: harness.contractId,
          revision: 1,
          expectedContentFingerprint: reviewedBeforeTheRevise,
        },
        OWNER,
      ),
      'Conflict',
    );
    assert.match(refused.reason, /Revision 1 is stale and cannot be approved/);
    assert.deepEqual(approvableRevisions(harness), [2], 'nothing was sealed, so there is still one approvable revision');

    // The revision that does answer the request is approvable, which is what makes the
    // refusal above a fact about revision 1 rather than a closed door.
    const approved = expectOk(
      harness.useCases.approveContract(
        {
          projectId: PROJECT,
          contractId: revision2.contractId as ContractId,
          revision: revision2.revision,
          expectedContentFingerprint: revision2.contentFingerprint,
        },
        OWNER,
      ),
    );
    assert.equal(approved.status, 'approved');
    assert.equal(approved.revision, 2);
    assert.deepEqual(approvableRevisions(harness), []);
  });
});

test('two revise attempts from one draft leave exactly one approvable revision (mvp-spec 3)', async () => {
  await withHarness((harness) => {
    const reviewedBefore = reviewedDraft(harness);

    const first = harness.useCases.reviseContract(
      { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED },
      OWNER,
    );
    // The second call is built from the same read the first used, which is what a second tab
    // holds: same contract id, same revision number, a stepped clock so the two attempts are
    // not the same instant either.
    const second = harness.useCases.reviseContract(
      { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED },
      OWNER,
    );

    expectOk(first);
    const conflict = expectError(second, 'Conflict');
    assert.match(conflict.reason, /not the next revision of this request/);
    assert.deepEqual(approvableRevisions(harness), [2], 'never more than one draft a request can approve');

    const detail = expectOk(harness.useCases.getRequest({ projectId: PROJECT, requestId: harness.requestId, expectedUpdatedAt: '' }, OWNER));
    assert.deepEqual(
      detail.revisions.map((revision) => [revision.revision, revision.status]),
      [
        [1, 'stale'],
        [2, 'draft'],
      ],
      'and the refused attempt left no revision of its own behind',
    );
    assert.ok(
      detail.revisions.every((revision) => revision.contentFingerprint !== reviewedBefore || revision.revision === 1),
      'the second attempt wrote nothing, so revision 1 kept the text the first read reviewed',
    );
  });
});

test('an approved revision stays frozen when a newer one is written from it (mvp-spec 3)', async () => {
  await withHarness((harness) => {
    const approved = expectOk(approveAsRead(harness));
    expectOk(
      harness.useCases.reviseContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED },
        OWNER,
      ),
    );

    // History, not a deletion: the agreement it sealed, its approver and its instant survive.
    const previous = expectOk(harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER));
    assert.equal(previous.status, 'stale');
    assert.equal(previous.supersededByRevision, 2);
    assert.equal(previous.approvedBy, String(OWNER_ID));
    assert.equal(previous.approvedAt, approved.approvedAt);
    assert.equal(previous.outcome, CONTENT.outcome);
    assert.equal(previous.contentFingerprint, approved.contentFingerprint);

    // And the text cannot be edited afterwards, by either path.
    expectError(
      harness.useCases.editContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, content: CHANGED, expectedContentFingerprint: previous.contentFingerprint },
        OWNER,
      ),
      'Invalid',
    );
    expectError(
      harness.useCases.approveContract(
        { projectId: PROJECT, contractId: harness.contractId, revision: 1, expectedContentFingerprint: previous.contentFingerprint },
        OWNER,
      ),
      'Conflict',
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
          expectedContentFingerprint: draft.contentFingerprint,
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
          expectedContentFingerprint: expectOk(
            harness.useCases.getContract({ projectId: PROJECT, contractId: harness.contractId, revision: 1 }, OWNER),
          ).contentFingerprint,
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
