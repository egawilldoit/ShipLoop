import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approveContract,
  automatedVerificationsOf,
  contractContentFingerprint,
  createContractDraft,
  editContract,
  fingerprint,
  unboundAutomatedCriteria,
  type ContractContent,
  type ContractId,
  type OwnerId,
  type ProjectId,
  type RequestId,
} from './index.ts';

/**
 * The verification binding on a Delivery Contract criterion (mvp-spec 3, F23-AC1, F24-AC3).
 *
 * An `automated` criterion is settled by a check, and the check it is settled by has to be
 * named by the agreement rather than inferred at read time from whichever check happened
 * to pass. These tests pin the three rules that make that naming mean something: the binding
 * is required before approval, an owner test never carries one, and the binding is part of
 * the frozen content because repointing a criterion at a different check changes what may
 * declare it satisfied.
 *
 * They live in their own file because the binding is a separable concern from the revision
 * lifecycle in `contract.test.ts`, and a reviewer looking for "what stops an automated
 * criterion from being unverified forever" should find the answer in one place.
 */

const PROJECT = 'acme' as ProjectId;
const REQUEST = 'req_1' as RequestId;
const OWNER = 'own_1' as OwnerId;
const REQUEST_FINGERPRINT = fingerprint({ title: 'Checkout totals' });

/**
 * Two criteria, bound the way a real profile binds them.
 *
 * AC1 names `unit-tests`, which is the same vocabulary a project profile's
 * `policy.requiredChecks` uses and the same one a provider projection reports a check
 * under. It is a check *name*: the same string for every run, which is what lets a re-run
 * on a new commit re-verify the criterion instead of invalidating the binding.
 */
const BASE: ContractContent = {
  outcome: 'The order summary shows the total including tax.',
  scope: ['Sum line items before tax'],
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

const UNBOUND: ContractContent = {
  ...BASE,
  acceptanceCriteria: [
    { id: 'AC1', description: 'The summary returns 200.', verificationType: 'automated', verificationCheckId: null },
    { id: 'AC2', description: 'The owner confirms the total.', verificationType: 'owner_test', verificationCheckId: null },
  ],
};

function draftOf(content: ContractContent) {
  const created = createContractDraft({
    contractId: 'dc_1' as ContractId,
    projectId: PROJECT,
    requestId: REQUEST,
    revision: 1,
    content,
    requestFingerprint: REQUEST_FINGERPRINT,
    createdBy: OWNER,
    at: '2026-03-01T10:00:00.000Z',
  });
  assert.ok(created.ok, created.ok ? '' : created.error.reason);
  return created.value;
}

function approve(draft: ReturnType<typeof draftOf>) {
  // Names the fingerprint the draft carries, because an approval that does not is refused by the
  // CAS guard. A fixture that wanted to reach the binding rule instead would pass a deliberately
  // wrong fingerprint, not omit the argument.
  return approveContract(draft, {
    approvedBy: OWNER,
    at: '2026-03-01T11:00:00.000Z',
    expectedContentFingerprint: draft.contentFingerprint,
  });
}

test('an automated criterion may be drafted unbound, because the owner is still writing it', () => {
  const draft = draftOf(UNBOUND);
  assert.equal(draft.acceptanceCriteria[0]?.verificationCheckId, null);
  assert.deepEqual(
    unboundAutomatedCriteria(draft).map((criterion) => criterion.id),
    ['AC1'],
    'the unbound automated criteria are named, not merely absent',
  );
});

test('an automated criterion that names no check cannot be approved', () => {
  // Without this gate, the owner could agree a contract whose AC1 nothing can ever verify.
  // AC1 would then read `unverified` for the life of the product and every acceptance of
  // that contract would be refused with nothing the owner could act on.
  const approvedValue = approve(draftOf(UNBOUND));
  assert.ok(!approvedValue.ok, 'approval is refused rather than sealing an unverifiable criterion');
  assert.equal(approvedValue.error.code, 'Invalid');
  const fields = approvedValue.error.code === 'Invalid' ? approvedValue.error.fields : [];
  assert.deepEqual(
    fields.map((field) => field.path),
    ['acceptanceCriteria.AC1.verificationCheckId'],
    'the refusal names the criterion that is unbound and nothing else',
  );
  assert.match(fields[0]?.message ?? '', /name the check that verifies it/);
});

test('an automated criterion that names a check is approved, and the owner test is left to the owner', () => {
  const approvedValue = approve(draftOf(BASE));
  assert.ok(approvedValue.ok, approvedValue.ok ? '' : approvedValue.error.reason);
  assert.deepEqual(
    approvedValue.value.acceptanceCriteria.map((criterion) => criterion.verificationCheckId),
    ['unit-tests', null],
    'the owner test is approved with no binding, which is the only correct value for it',
  );
  assert.deepEqual([...automatedVerificationsOf(approvedValue.value).entries()], [['AC1', 'unit-tests']]);
});

test('an owner test that names a check is refused, because a check must not discharge the owner\'s own step', () => {
  const created = createContractDraft({
    contractId: 'dc_1' as ContractId,
    projectId: PROJECT,
    requestId: REQUEST,
    revision: 1,
    content: {
      ...BASE,
      acceptanceCriteria: [
        {
          id: 'AC2',
          description: 'The owner confirms the total.',
          verificationType: 'owner_test',
          verificationCheckId: 'unit-tests',
        },
      ],
    },
    requestFingerprint: REQUEST_FINGERPRINT,
    createdBy: OWNER,
    at: '2026-03-01T10:00:00.000Z',
  });
  assert.ok(!created.ok);
  assert.match(
    created.error.code === 'Invalid' ? created.error.fields.map((field) => field.message).join(' ') : '',
    /only the owner can judge/,
  );
});

test('a blank check name binds nothing and is refused rather than stored', () => {
  // " " would otherwise be a binding to a check that does not exist, and it would read on
  // the card as a bound criterion nobody can verify.
  const created = createContractDraft({
    contractId: 'dc_1' as ContractId,
    projectId: PROJECT,
    requestId: REQUEST,
    revision: 1,
    content: {
      ...BASE,
      acceptanceCriteria: [{ id: 'AC1', description: 'It works.', verificationType: 'automated', verificationCheckId: '   ' }],
    },
    requestFingerprint: REQUEST_FINGERPRINT,
    createdBy: OWNER,
    at: '2026-03-01T10:00:00.000Z',
  });
  assert.ok(!created.ok);
  assert.match(
    created.error.code === 'Invalid' ? created.error.fields.map((field) => field.message).join(' ') : '',
    /binds nothing/,
  );
});

test('repointing a criterion at a different check is a material change to the agreement', () => {
  // The binding decides what may declare a criterion satisfied, so changing it changes the
  // agreement. It has to move the content fingerprint, or an approval could be sealed over
  // one check while the revision on disk names another.
  const repointed: ContractContent = {
    ...BASE,
    acceptanceCriteria: [
      { ...BASE.acceptanceCriteria[0]!, verificationCheckId: 'browser-e2e' },
      BASE.acceptanceCriteria[1]!,
    ],
  };
  assert.notEqual(contractContentFingerprint(BASE), contractContentFingerprint(repointed));

  const draft = draftOf(BASE);
  const edited = editContract(draft, repointed, {
    expectedContentFingerprint: draft.contentFingerprint,
    at: '2026-03-01T10:30:00.000Z',
    editedBy: OWNER,
  });
  assert.ok(edited.ok, edited.ok ? '' : edited.error.reason);
  assert.notEqual(edited.value.contentFingerprint, draft.contentFingerprint);
  assert.equal(edited.value.acceptanceCriteria[0]?.verificationCheckId, 'browser-e2e');
});

test('the binding names a check rather than a run, so it is stable across re-approvals', () => {
  // This is the property that lets the binding be a *selector*. A run-scoped identity would
  // differ on every re-run and would leave the criterion permanently unbound in practice.
  const first = approve(draftOf(BASE));
  const second = approve(draftOf(BASE));
  assert.ok(first.ok && second.ok);
  assert.equal(first.value.contentFingerprint, second.value.contentFingerprint);
  assert.deepEqual(
    first.value.acceptanceCriteria.map((criterion) => criterion.verificationCheckId),
    second.value.acceptanceCriteria.map((criterion) => criterion.verificationCheckId),
  );
});