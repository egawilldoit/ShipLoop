import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyContractProposal,
  approveContract,
  contractAnswersRequest,
  contractContentFingerprint,
  contractGate,
  createContractDraft,
  editContract,
  fingerprint,
  invalidateContract,
  nextRevisionNumber,
  reviseContract,
  supersedeContract,
  type ContractContent,
  type ContractId,
  type OwnerId,
  type ProjectId,
  type RequestId,
} from './index.ts';

const PROJECT = 'acme' as ProjectId;
const OTHER_PROJECT = 'globex' as ProjectId;
const REQUEST = 'req_1' as RequestId;
const OWNER = 'own_1' as OwnerId;
const REQUEST_FINGERPRINT = fingerprint({ title: 'Checkout totals' });

/**
 * The fixture every other test in this file builds on.
 *
 * AC1 is bound to `unit-tests`, a check name rather than a check run: the binding has to
 * survive every re-run of that check, or a criterion would need rebinding each time the
 * candidate changed. AC2 is the owner's own step and carries no binding at all, because
 * naming a check for it would let that check discharge work only the owner can judge.
 */
const BASE: ContractContent = {
  outcome: 'The order summary shows the total including tax.',
  scope: ['Sum line items before tax', 'Apply the configured tax rate'],
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

function draftAt(overrides: Partial<Parameters<typeof createContractDraft>[0]> = {}) {
  const created = createContractDraft({
    contractId: 'dc_1' as ContractId,
    projectId: PROJECT,
    requestId: REQUEST,
    revision: 1,
    content: BASE,
    requestFingerprint: REQUEST_FINGERPRINT,
    createdBy: OWNER,
    at: '2026-03-01T10:00:00.000Z',
    ...overrides,
  });
  assert.ok(created.ok, created.ok ? '' : created.error.reason);
  return created.value;
}

function approved(content = BASE) {
  const draft = draftAt({ content });
  const approvedValue = approveContract(draft, {
    approvedBy: OWNER,
    at: '2026-03-01T11:00:00.000Z',
    expectedContentFingerprint: draft.contentFingerprint,
    newestRevisionForRequest: draft.revision,
  });
  assert.ok(approvedValue.ok, approvedValue.ok ? '' : approvedValue.error.reason);
  return approvedValue.value;
}

test('a draft revision is created as a draft with no approver and no approval instant', () => {
  const draft = draftAt();
  assert.equal(draft.status, 'draft');
  assert.equal(draft.approvedAt, null);
  assert.equal(draft.approvedBy, null);
  assert.equal(draft.revision, 1);
  assert.equal(draft.projectId, PROJECT);
  assert.equal(draft.requestId, REQUEST);
  assert.equal(draft.contentFingerprint, contractContentFingerprint(BASE));
  assert.equal(draft.requestFingerprint, REQUEST_FINGERPRINT);
});

test('a draft revision with no acceptance criterion is refused: success would be undefined', () => {
  const created = createContractDraft({
    contractId: 'dc_1' as ContractId,
    projectId: PROJECT,
    requestId: REQUEST,
    revision: 1,
    content: { ...BASE, acceptanceCriteria: [] },
    requestFingerprint: REQUEST_FINGERPRINT,
    createdBy: OWNER,
    at: '2026-03-01T10:00:00.000Z',
  });
  assert.ok(!created.ok);
  assert.equal(created.error.code === 'Invalid' && created.error.fields[0]?.path, 'acceptanceCriteria');
});

test('a criterion with an unknown verification type is refused', () => {
  const created = createContractDraft({
    contractId: 'dc_1' as ContractId,
    projectId: PROJECT,
    requestId: REQUEST,
    revision: 1,
    content: {
      ...BASE,
      acceptanceCriteria: [{ id: 'AC1', description: 'It works.', verificationType: 'vibes' as 'automated', verificationCheckId: null }],
    },
    requestFingerprint: REQUEST_FINGERPRINT,
    createdBy: OWNER,
    at: '2026-03-01T10:00:00.000Z',
  });
  assert.ok(!created.ok);
  assert.match(
    created.error.code === 'Invalid' ? created.error.fields.map((f) => f.message).join(' ') : '',
    /verification type/,
  );
});

test('a duplicate criterion id is refused, because evidence binds to that id', () => {
  const created = createContractDraft({
    contractId: 'dc_1' as ContractId,
    projectId: PROJECT,
    requestId: REQUEST,
    revision: 1,
    content: {
      ...BASE,
      acceptanceCriteria: [
        { id: 'AC1', description: 'One.', verificationType: 'automated', verificationCheckId: 'unit-tests' },
        { id: 'AC1', description: 'Two.', verificationType: 'automated', verificationCheckId: 'unit-tests' },
      ],
    },
    requestFingerprint: REQUEST_FINGERPRINT,
    createdBy: OWNER,
    at: '2026-03-01T10:00:00.000Z',
  });
  assert.ok(!created.ok);
  assert.match(created.error.code === 'Invalid' ? created.error.fields.map((f) => f.message).join(' ') : '', /used twice/);
});

test('revision 0 is refused', () => {
  const created = createContractDraft({
    contractId: 'dc_1' as ContractId,
    projectId: PROJECT,
    requestId: REQUEST,
    revision: 0,
    content: BASE,
    requestFingerprint: REQUEST_FINGERPRINT,
    createdBy: OWNER,
    at: '2026-03-01T10:00:00.000Z',
  });
  assert.ok(!created.ok);
});

test('editing a draft keeps its revision number and moves updatedAt', () => {
  const draft = draftAt();
  const edited = editContract(
    draft,
    { ...BASE, scope: [...BASE.scope, 'Show the currency code'] },
    { expectedUpdatedAt: draft.updatedAt, at: '2026-03-01T10:30:00.000Z', editedBy: OWNER },
  );
  assert.ok(edited.ok, edited.ok ? '' : edited.error.reason);
  assert.equal(edited.value.revision, 1);
  assert.equal(edited.value.createdAt, draft.createdAt);
  assert.equal(edited.value.updatedAt, '2026-03-01T10:30:00.000Z');
  assert.notEqual(edited.value.contentFingerprint, draft.contentFingerprint);
  assert.equal(draft.scope.length, 2, 'the prior value is untouched');
});

test('editing against a stale read is a conflict carrying both instants', () => {
  const draft = draftAt();
  const conflicted = editContract(draft, { ...BASE, outcome: 'Changed.' }, {
    expectedUpdatedAt: '2026-02-01T00:00:00.000Z',
    at: '2026-03-01T10:30:00.000Z',
    editedBy: OWNER,
  });
  assert.ok(!conflicted.ok);
  assert.equal(conflicted.error.code, 'Conflict');
  if (conflicted.error.code !== 'Conflict') return;
  assert.equal(conflicted.error.actual, draft.updatedAt);
});

test('an edit that changes nothing is refused rather than reported as a save', () => {
  const draft = draftAt();
  const noop = editContract(draft, BASE, {
    expectedUpdatedAt: draft.updatedAt,
    at: '2026-03-01T10:30:00.000Z',
    editedBy: OWNER,
  });
  assert.ok(!noop.ok);
  assert.equal(noop.error.code, 'Invalid');
});

test('approval records the owner and the instant, and reseals the fingerprint', () => {
  const approvedContract = approved();
  assert.equal(approvedContract.status, 'approved');
  assert.equal(approvedContract.approvedBy, OWNER);
  assert.equal(approvedContract.approvedAt, '2026-03-01T11:00:00.000Z');
  assert.equal(approvedContract.updatedAt, '2026-03-01T11:00:00.000Z');
  assert.equal(approvedContract.contentFingerprint, contractContentFingerprint(BASE));
});

test('an approved revision cannot be edited: the way forward is a new revision', () => {
  const sealed = approved();
  const edited = editContract(sealed, { ...BASE, outcome: 'Something else entirely.' }, {
    expectedUpdatedAt: sealed.updatedAt,
    at: '2026-03-02T10:00:00.000Z',
    editedBy: OWNER,
  });
  assert.ok(!edited.ok);
  assert.match(edited.error.code === 'Invalid' ? edited.error.fields.map((f) => f.message).join(' ') : '', /approved revision is frozen/);
  assert.equal(sealed.outcome, BASE.outcome, 'the sealed text is unchanged');
});

test('a stale revision cannot be edited either', () => {
  const sealed = approved();
  const stale = invalidateContract(sealed, { reason: 'The owner changed the scope.', at: '2026-03-02T10:00:00.000Z' });
  assert.ok(stale.ok, stale.ok ? '' : stale.error.reason);
  const edited = editContract(stale.value, { ...BASE, outcome: 'Rewritten.' }, {
    expectedUpdatedAt: stale.value.updatedAt,
    at: '2026-03-02T11:00:00.000Z',
    editedBy: OWNER,
  });
  assert.ok(!edited.ok);
  assert.match(edited.error.code === 'Invalid' ? edited.error.fields.map((f) => f.message).join(' ') : '', /stale/);
});

test('approving twice is a conflict naming the state it found', () => {
  const sealed = approved();
  const again = approveContract(sealed, {
    approvedBy: OWNER,
    at: '2026-03-02T10:00:00.000Z',
    expectedContentFingerprint: sealed.contentFingerprint,
    newestRevisionForRequest: sealed.revision,
  });
  assert.ok(!again.ok);
  assert.equal(again.error.code, 'Conflict');
  if (again.error.code !== 'Conflict') return;
  assert.equal(again.error.expected, 'draft');
  assert.equal(again.error.actual, 'approved');
});

test('a stale revision cannot be approved', () => {
  const sealed = approved();
  const stale = invalidateContract(sealed, { reason: 'Scope moved.', at: '2026-03-02T10:00:00.000Z' });
  assert.ok(stale.ok);
  const late = approveContract(stale.value, {
    approvedBy: OWNER,
    at: '2026-03-02T11:00:00.000Z',
    expectedContentFingerprint: stale.value.contentFingerprint,
    newestRevisionForRequest: stale.value.revision,
  });
  assert.ok(!late.ok);
  assert.equal(late.error.code, 'Conflict');
});

/* -------------------------------------------------------------------------- */
/* The approval lock                                                           */
/* -------------------------------------------------------------------------- */

test('an approval naming text the caller did not review is refused, and nothing is sealed', () => {
  const draft = draftAt();
  // What the stale tab holds: the fingerprint of the text as it read before an edit.
  const reviewed = draft.contentFingerprint;
  const edited = editContract(draft, { ...BASE, outcome: 'The summary shows the total with shipping.' }, {
    expectedUpdatedAt: draft.updatedAt,
    at: '2026-03-01T10:30:00.000Z',
    editedBy: OWNER,
  });
  assert.ok(edited.ok, edited.ok ? '' : edited.error.reason);
  assert.notEqual(edited.value.contentFingerprint, reviewed, 'a material edit moves the lock');

  const refused = approveContract(edited.value, {
    approvedBy: OWNER,
    at: '2026-03-01T11:00:00.000Z',
    expectedContentFingerprint: reviewed,
    newestRevisionForRequest: edited.value.revision,
  });
  assert.ok(!refused.ok);
  assert.equal(refused.error.code, 'Conflict');
  if (refused.error.code !== 'Conflict') return;
  assert.equal(refused.error.expected, reviewed, 'the refusal names what the caller reviewed');
  assert.equal(refused.error.actual, edited.value.contentFingerprint, 'and what the revision holds');
  assert.match(refused.error.reason, /text you did not review/);

  // Nothing about the draft moved, so the owner can read it again and approve it as it now
  // reads. A refusal that mutated state would be a second defect, not a safe answer.
  assert.equal(edited.value.status, 'draft');
  assert.equal(edited.value.approvedBy, null);
  assert.equal(edited.value.approvedAt, null);
});

test('the fingerprint of some other text is refused as firmly as an old one', () => {
  const draft = draftAt();
  const neverReviewed = fingerprint({ outcome: 'Something nobody ever showed this owner.' });
  const refused = approveContract(draft, {
    approvedBy: OWNER,
    at: '2026-03-01T11:00:00.000Z',
    expectedContentFingerprint: neverReviewed,
    newestRevisionForRequest: draft.revision,
  });
  assert.ok(!refused.ok);
  assert.equal(refused.error.code, 'Conflict');
});

test('an approval is accepted when the named fingerprint is the text now stored', () => {
  const draft = draftAt();
  const approvedValue = approveContract(draft, {
    approvedBy: OWNER,
    at: '2026-03-01T11:00:00.000Z',
    expectedContentFingerprint: draft.contentFingerprint,
    newestRevisionForRequest: draft.revision,
  });
  assert.ok(approvedValue.ok, approvedValue.ok ? '' : approvedValue.error.reason);
  assert.equal(approvedValue.value.status, 'approved');
});

test('approval re-derives the fingerprint it seals, so a drifted draft cannot be approved', () => {
  const draft = draftAt();
  // A stored revision whose fingerprint does not describe its text: reachable only from a
  // row written outside this function, and the reason the seal re-derives rather than
  // copying.
  const drifted = { ...draft, contentFingerprint: fingerprint({ nothing: 'like this text' }) };
  const refused = approveContract(drifted, {
    approvedBy: OWNER,
    at: '2026-03-01T11:00:00.000Z',
    expectedContentFingerprint: contractContentFingerprint(BASE),
    newestRevisionForRequest: drifted.revision,
  });
  assert.ok(refused.ok, 'the caller naming the real text is the one whose read was honest');
  assert.equal(
    refused.value.contentFingerprint,
    contractContentFingerprint(BASE),
    'and what is sealed is the fingerprint of the text, not the drifted one',
  );
});

test('a no-op edit does not move the lock, so it cannot invalidate a page that read the draft', () => {
  const draft = draftAt();
  const noop = editContract(draft, { ...BASE }, {
    expectedUpdatedAt: draft.updatedAt,
    at: '2026-03-01T10:30:00.000Z',
    editedBy: OWNER,
  });
  assert.ok(!noop.ok, 'a write that changes nothing is refused by the domain');
  assert.equal(noop.error.code, 'Invalid');

  // Nothing was written, so the fingerprint the owner's page holds is still current.
  const sealed = approveContract(draft, {
    approvedBy: OWNER,
    at: '2026-03-01T11:00:00.000Z',
    expectedContentFingerprint: draft.contentFingerprint,
    newestRevisionForRequest: draft.revision,
  });
  assert.ok(sealed.ok, sealed.ok ? '' : sealed.error.reason);
});

test('a reordering of the same criteria is not material, and leaves the lock alone', () => {
  const draft = draftAt();
  const reordered = editContract(draft, { ...BASE, acceptanceCriteria: [...BASE.acceptanceCriteria].reverse() }, {
    expectedUpdatedAt: draft.updatedAt,
    at: '2026-03-01T10:30:00.000Z',
    editedBy: OWNER,
  });
  assert.ok(!reordered.ok, 'criteria are a set keyed by identity, so a reorder changes nothing');
  assert.equal(reordered.error.code, 'Invalid');
});

test('invalidation requires a reason, so a stale revision always explains itself', () => {
  const sealed = approved();
  const silent = invalidateContract(sealed, { reason: '  ', at: '2026-03-02T10:00:00.000Z' });
  assert.ok(!silent.ok);
  assert.equal(silent.error.code, 'Invalid');
});

test('invalidation refuses a draft, because a draft has no approval to invalidate', () => {
  const draft = draftAt();
  const refused = invalidateContract(draft, { reason: 'Not applicable.', at: '2026-03-02T10:00:00.000Z' });
  assert.ok(!refused.ok);
  assert.equal(refused.error.code, 'Conflict');
  if (refused.error.code !== 'Conflict') return;
  assert.equal(refused.error.expected, 'approved');
  assert.equal(refused.error.actual, 'draft');
});

test('invalidation refuses a revision that is already stale, so the first reason survives', () => {
  const sealed = approved();
  const first = invalidateContract(sealed, { reason: 'Scope moved.', at: '2026-03-02T10:00:00.000Z' });
  assert.ok(first.ok);
  const second = invalidateContract(first.value, { reason: 'A different explanation.', at: '2026-03-02T11:00:00.000Z' });
  assert.ok(!second.ok);
  assert.equal(second.error.code, 'Conflict');
  assert.equal(first.value.staleReason, 'Scope moved.');
});

test('an invalidated approval keeps its text and its approver, because it is history', () => {
  const sealed = approved();
  const stale = invalidateContract(sealed, { reason: 'The owner changed the scope.', at: '2026-03-02T10:00:00.000Z' });
  assert.ok(stale.ok);
  assert.equal(stale.value.status, 'stale');
  assert.equal(stale.value.staleReason, 'The owner changed the scope.');
  assert.equal(stale.value.approvedBy, OWNER);
  assert.equal(stale.value.approvedAt, '2026-03-01T11:00:00.000Z');
  assert.equal(stale.value.contentFingerprint, sealed.contentFingerprint);
  assert.deepEqual(stale.value.acceptanceCriteria, sealed.acceptanceCriteria);
});

test('supersede names the revision that replaced it and refuses an earlier number', () => {
  const sealed = approved();
  const superseded = supersedeContract(sealed, { supersededByRevision: 2, at: '2026-03-02T10:00:00.000Z' });
  assert.ok(superseded.ok);
  assert.equal(superseded.value.status, 'stale');
  assert.equal(superseded.value.supersededByRevision, 2);
  assert.match(superseded.value.staleReason, /revision 2/);

  const backwards = supersedeContract(sealed, { supersededByRevision: 1, at: '2026-03-02T10:00:00.000Z' });
  assert.ok(!backwards.ok);
  assert.equal(backwards.error.code, 'Invalid');
});

test('an approval that is superseded keeps its approver and its text, because it is history', () => {
  // Not regressed by a draft being supersedable too: the two cases are the same transition
  // with different provenance, and the approver is part of what history is.
  const sealed = approved();
  const superseded = supersedeContract(sealed, { supersededByRevision: 2, at: '2026-03-02T10:00:00.000Z' });
  assert.ok(superseded.ok, superseded.ok ? '' : superseded.error.reason);
  assert.equal(superseded.value.status, 'stale');
  assert.equal(superseded.value.approvedBy, OWNER);
  assert.equal(superseded.value.approvedAt, '2026-03-01T11:00:00.000Z');
  assert.equal(superseded.value.contentFingerprint, sealed.contentFingerprint);
  assert.deepEqual(superseded.value.acceptanceCriteria, sealed.acceptanceCriteria);
});

test('revising an approved revision supersedes it in the same step as the new draft', () => {
  const sealed = approved();
  const revised = reviseContract(sealed, {
    contractId: 'dc_2' as ContractId,
    content: { ...BASE, outcome: 'The order summary shows the total including tax and shipping.' },
    requestFingerprint: REQUEST_FINGERPRINT,
    revisedBy: OWNER,
    at: '2026-03-02T10:00:00.000Z',
  });
  assert.ok(revised.ok, revised.ok ? '' : revised.error.reason);
  // The point of the single step: a new revision must never exist while the old
  // approval still reads as current.
  assert.equal(revised.value.superseded?.status, 'stale');
  assert.equal(revised.value.superseded?.supersededByRevision, 2);
  assert.equal(revised.value.draft.revision, 2);
  assert.equal(revised.value.draft.status, 'draft');
  assert.equal(revised.value.draft.approvedBy, null);
  assert.notEqual(revised.value.draft.contentFingerprint, sealed.contentFingerprint);
});

test('revising a draft supersedes that draft, because two approvable drafts are two contract futures', () => {
  const draft = draftAt();
  const revised = reviseContract(draft, {
    contractId: 'dc_2' as ContractId,
    content: { ...BASE, outcome: 'Something a little different.' },
    requestFingerprint: REQUEST_FINGERPRINT,
    revisedBy: OWNER,
    at: '2026-03-02T10:00:00.000Z',
  });
  assert.ok(revised.ok, revised.ok ? '' : revised.error.reason);
  assert.equal(revised.value.draft.revision, 2);

  // The half that used to be missing: revision 1 is superseded, in the same step, by the
  // revision written from it. `stale` already means "kept, no longer current", so this needed
  // no new status - only the existing `supersededByRevision` on a row that never held an
  // approval.
  const superseded = revised.value.superseded;
  assert.ok(superseded !== null, 'a revision the new one was written from is not left approvable');
  assert.equal(superseded.status, 'stale');
  assert.equal(superseded.supersededByRevision, 2);
  assert.equal(superseded.staleReason, 'Superseded by revision 2.');
  assert.equal(superseded.approvedBy, null, 'it was never agreed, and the record says so');
  assert.equal(superseded.approvedAt, null);
  assert.equal(superseded.contentFingerprint, draft.contentFingerprint, 'history, not a deletion');
});

test('revision 1 is refused once revision 2 answers the request, and revision 2 is not (mvp-spec 3)', () => {
  const draft = draftAt();
  const revised = reviseContract(draft, {
    contractId: 'dc_2' as ContractId,
    content: { ...BASE, outcome: 'The order summary shows the total including tax and shipping.' },
    requestFingerprint: REQUEST_FINGERPRINT,
    revisedBy: OWNER,
    at: '2026-03-02T10:00:00.000Z',
  });
  assert.ok(revised.ok, revised.ok ? '' : revised.error.reason);
  const superseded = revised.value.superseded;
  assert.ok(superseded !== null);

  // The superseded revision is refused for what it now is.
  const onSuperseded = approveContract(superseded, {
    approvedBy: OWNER,
    at: '2026-03-02T11:00:00.000Z',
    expectedContentFingerprint: superseded.contentFingerprint,
    newestRevisionForRequest: 2,
  });
  assert.ok(!onSuperseded.ok);
  assert.equal(onSuperseded.error.code, 'Conflict');
  assert.equal(onSuperseded.error.actual, 'stale');

  // And the record a stale tab is holding - still a draft, still holding exactly the text its
  // owner reviewed - is refused too, because revision 2 exists. This is the case no
  // fingerprint can catch, and the reason the newest revision is part of the approval.
  const onStaleRead = approveContract(draft, {
    approvedBy: OWNER,
    at: '2026-03-02T11:00:00.000Z',
    expectedContentFingerprint: draft.contentFingerprint,
    newestRevisionForRequest: 2,
  });
  assert.ok(!onStaleRead.ok, 'the agreement revision 2 replaced cannot be sealed after it');
  assert.equal(onStaleRead.error.code, 'Conflict');
  if (onStaleRead.error.code !== 'Conflict') return;
  assert.equal(onStaleRead.error.expected, '1');
  assert.equal(onStaleRead.error.actual, '2');
  assert.match(onStaleRead.error.reason, /already answers it/);

  // The revision that does answer the request is approvable, so the refusal above is a fact
  // about revision 1 rather than a broken gate.
  const onNewest = approveContract(revised.value.draft, {
    approvedBy: OWNER,
    at: '2026-03-02T12:00:00.000Z',
    expectedContentFingerprint: revised.value.draft.contentFingerprint,
    newestRevisionForRequest: 2,
  });
  assert.ok(onNewest.ok, onNewest.ok ? '' : onNewest.error.reason);
  assert.equal(onNewest.value.status, 'approved');
  assert.equal(onNewest.value.revision, 2);
});

test('an approval that names an older revision than the request holds is refused (mvp-spec 3)', () => {
  const draft = draftAt();
  // The caller asserting something impossible rather than something stale: it cannot happen
  // through the controller, which reads the history, and the domain refuses it anyway because
  // a guard whose failure mode is "passed the wrong number" is a guard with no answer.
  const refused = approveContract(draft, {
    approvedBy: OWNER,
    at: '2026-03-02T11:00:00.000Z',
    expectedContentFingerprint: draft.contentFingerprint,
    newestRevisionForRequest: 0,
  });
  assert.ok(!refused.ok);
  assert.equal(refused.error.code, 'Conflict');
  assert.match(refused.error.reason, /Reload the request/);
});

test('revising a revision that is already stale keeps the explanation it was given (mvp-spec 3)', () => {
  const sealed = approved();
  const first = supersedeContract(sealed, { supersededByRevision: 2, at: '2026-03-02T10:00:00.000Z' });
  assert.ok(first.ok);

  const revised = reviseContract(first.value, {
    contractId: 'dc_3' as ContractId,
    content: { ...BASE, outcome: 'A third statement of the outcome.' },
    requestFingerprint: REQUEST_FINGERPRINT,
    revisedBy: OWNER,
    at: '2026-03-03T10:00:00.000Z',
  });
  assert.ok(revised.ok, revised.ok ? '' : revised.error.reason);
  // A revision that is already history has nothing to supersede, and saying otherwise would
  // replace its explanation with a second one.
  assert.equal(revised.value.superseded, null);
  assert.equal(revised.value.draft.revision, 2, 'the number comes from the record this call was given');
  assert.equal(first.value.staleReason, 'Superseded by revision 2.', 'and the first explanation survives');

  const again = supersedeContract(first.value, { supersededByRevision: 3, at: '2026-03-03T11:00:00.000Z' });
  assert.ok(!again.ok);
  assert.equal(again.error.code, 'Conflict');
  assert.equal(again.error.actual, 'stale');
});

test('a superseded draft is history: its text cannot be edited afterwards', () => {
  const draft = draftAt();
  const revised = reviseContract(draft, {
    contractId: 'dc_2' as ContractId,
    content: { ...BASE, outcome: 'A different outcome.' },
    requestFingerprint: REQUEST_FINGERPRINT,
    revisedBy: OWNER,
    at: '2026-03-02T10:00:00.000Z',
  });
  assert.ok(revised.ok, revised.ok ? '' : revised.error.reason);
  const superseded = revised.value.superseded;
  assert.ok(superseded !== null);

  const edited = editContract(superseded, { ...BASE, outcome: 'Rewritten after the fact.' }, {
    expectedUpdatedAt: superseded.updatedAt,
    at: '2026-03-02T11:00:00.000Z',
    editedBy: OWNER,
  });
  assert.ok(!edited.ok, 'a superseded draft is frozen exactly as a superseded approval is');
  assert.match(edited.error.code === 'Invalid' ? edited.error.fields.map((f) => f.message).join(' ') : '', /stale/);
  assert.equal(contractGate(superseded).satisfied, false, 'and it may never be measured against a candidate');
});

test('revising keeps the brief provenance, so revision 2 does not look unwritten', () => {
  const seeded = draftAt({ sourceBriefId: 'brief_9', sourceBriefVersion: 3 });
  const revised = reviseContract(seeded, {
    contractId: 'dc_2' as ContractId,
    content: { ...BASE, outcome: 'Different.' },
    requestFingerprint: REQUEST_FINGERPRINT,
    revisedBy: OWNER,
    at: '2026-03-02T10:00:00.000Z',
  });
  assert.ok(revised.ok);
  assert.equal(revised.value.draft.sourceBriefId, 'brief_9');
  assert.equal(revised.value.draft.sourceBriefVersion, 3);
});

test('revision numbering is one rule: 1 for a request with none, otherwise the last plus one', () => {
  assert.equal(nextRevisionNumber(null), 1);
  assert.equal(nextRevisionNumber(draftAt()), 2);
  assert.equal(nextRevisionNumber(approved()), 2);
});

test('a contract reports whether it still answers the request as it now reads', () => {
  const sealed = approved();
  assert.equal(contractAnswersRequest(sealed, REQUEST_FINGERPRINT), true);
  assert.equal(contractAnswersRequest(sealed, fingerprint({ title: 'Checkout totals (revised)' })), false);
});

test('only an approved revision may be measured against a candidate', () => {
  assert.equal(contractGate(approved()).satisfied, true);
  assert.equal(contractGate(draftAt()).satisfied, false);
  const sealed = approved();
  const stale = invalidateContract(sealed, { reason: 'Moved.', at: '2026-03-02T10:00:00.000Z' });
  assert.ok(stale.ok);
  assert.equal(contractGate(stale.value).satisfied, false);
  assert.match(contractGate(stale.value).reason, /only an approved revision/);
});

test('the content fingerprint ignores criterion order but not criterion text', () => {
  const reordered: ContractContent = { ...BASE, acceptanceCriteria: [...BASE.acceptanceCriteria].reverse() };
  assert.equal(contractContentFingerprint(reordered), contractContentFingerprint(BASE));
  const reworded: ContractContent = {
    ...BASE,
    acceptanceCriteria: [BASE.acceptanceCriteria[0]!, { ...BASE.acceptanceCriteria[1]!, description: 'Different.' }],
  };
  assert.notEqual(contractContentFingerprint(reworded), contractContentFingerprint(BASE));
});

test('a cross-project revision keeps its own project identity', () => {
  const elsewhere = draftAt({ projectId: OTHER_PROJECT });
  assert.equal(elsewhere.projectId, OTHER_PROJECT);
  assert.equal(draftAt().projectId, PROJECT);
});

/* -------------------------------------------------------------------------- */
/* Structured output cannot assert agreement                                    */
/* -------------------------------------------------------------------------- */

test('a structured proposal reaches a contract draft with no status of its own', () => {
  const applied = applyContractProposal({
    kind: 'ContractProposal',
    requestId: REQUEST,
    outcome: BASE.outcome,
    scope: BASE.scope,
    outOfScope: BASE.outOfScope,
    acceptanceCriteria: BASE.acceptanceCriteria,
  });
  assert.ok(applied.ok, applied.ok ? '' : applied.error.reason);
  assert.equal(applied.value.outcome, BASE.outcome);

  // The proposal carries content and nothing else, so the draft it produces is a draft.
  const drafted = createContractDraft({
    contractId: 'dc_1' as ContractId,
    projectId: PROJECT,
    requestId: REQUEST,
    revision: 1,
    content: applied.value,
    requestFingerprint: REQUEST_FINGERPRINT,
    createdBy: OWNER,
    at: '2026-03-01T10:00:00.000Z',
  });
  assert.ok(drafted.ok);
  assert.equal(drafted.value.status, 'draft');
  assert.equal(drafted.value.approvedBy, null);
});

test('a proposal carrying status or approvedAt is refused rather than silently dropped', () => {
  const smuggled = {
    kind: 'ContractProposal',
    requestId: REQUEST,
    outcome: BASE.outcome,
    scope: BASE.scope,
    outOfScope: BASE.outOfScope,
    acceptanceCriteria: BASE.acceptanceCriteria,
    status: 'approved',
    approvedAt: '2026-03-01T10:00:00.000Z',
    approvedBy: OWNER,
  };
  const applied = applyContractProposal(smuggled as unknown as Parameters<typeof applyContractProposal>[0]);
  assert.ok(!applied.ok);
  assert.equal(applied.error.code, 'Invalid');
  const fields = applied.error.code === 'Invalid' ? applied.error.fields.map((field) => field.path) : [];
  assert.ok(fields.includes('status'), `expected the refusal to name status, got ${fields.join(', ')}`);
  assert.ok(fields.includes('approvedAt'));
  assert.ok(fields.includes('approvedBy'));
});

test('an untagged proposal is refused', () => {
  const applied = applyContractProposal({
    outcome: BASE.outcome,
    scope: BASE.scope,
    outOfScope: BASE.outOfScope,
    acceptanceCriteria: BASE.acceptanceCriteria,
  } as unknown as Parameters<typeof applyContractProposal>[0]);
  assert.ok(!applied.ok);
});

test('the request a proposal names never becomes the request a revision binds to', () => {
  // `applyContractProposal` returns content only. A proposal may name any request it
  // likes, and the revision it becomes is bound to the request the caller read from
  // storage, so a proposal cannot attach a contract to a request it never read.
  const applied = applyContractProposal({
    kind: 'ContractProposal',
    requestId: 'req_other' as RequestId,
    outcome: BASE.outcome,
    scope: BASE.scope,
    outOfScope: BASE.outOfScope,
    acceptanceCriteria: BASE.acceptanceCriteria,
  });
  assert.ok(applied.ok);
  assert.ok(!('requestId' in applied.value), 'the validated content carries no request identity');

  const drafted = createContractDraft({
    contractId: 'dc_1' as ContractId,
    projectId: PROJECT,
    requestId: REQUEST,
    revision: 1,
    content: applied.value,
    requestFingerprint: REQUEST_FINGERPRINT,
    createdBy: OWNER,
    at: '2026-03-01T10:00:00.000Z',
  });
  assert.ok(drafted.ok);
  assert.equal(drafted.value.requestId, REQUEST);
});