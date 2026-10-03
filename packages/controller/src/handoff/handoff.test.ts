/**
 * The implementation handoff use case (mvp-spec L02, L02-AC3; N02-AC2).
 *
 * `handoff.test.ts` in the web package proves the same rules through HTTP against a real
 * store. This file proves the ones a store cannot show: that a caller who may not act never
 * reaches a second read, that a missing project row is refused rather than rendered from a
 * guess, and that each of the three T3 states is distinguishable. Those are properties of the
 * order of operations, and order is only observable with fakes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fingerprint, ok } from '@shiploop/domain';
import type { ContractId, OwnerId, ProjectId, Request, RequestId, Result, DomainError } from '@shiploop/domain';
import type { ProjectProfileVersion, ProjectRecord } from '@shiploop/storage';
import type { ContractView } from '../contracts.ts';
import type { OwnerActor } from '../profiles.ts';
import { buildImplementationHandoff, type HandoffReaders } from './handoff.ts';
import { generateImplementationPacket } from './implementation-packet.ts';

const PROJECT_ID = 'checkout' as ProjectId;
const CONTRACT_ID = 'contract-1' as ContractId;
const REQUEST_ID = 'request-1' as RequestId;
const OWNER_ID = 'owner-1' as OwnerId;
const APPROVED_AT = '2026-10-03T09:00:00.000Z';

const OWNER: OwnerActor = { actorId: OWNER_ID, role: 'Owner', ownerId: OWNER_ID, sessionId: null };

const REQUEST: Request = {
  requestId: REQUEST_ID,
  projectId: PROJECT_ID,
  title: 'Checkout totals',
  description: 'The order summary shows the pre-tax total.',
  sourceIdeaId: null,
  createdAt: APPROVED_AT,
  updatedAt: APPROVED_AT,
};

const PROJECT: ProjectRecord = {
  projectId: PROJECT_ID,
  name: 'Checkout',
  createdAt: APPROVED_AT,
  updatedAt: APPROVED_AT,
  archivedAt: null,
};

/** A saved profile naming the repository and the branch a pull request should target. */
const PROFILE = {
  profileVersionId: 'profile-1',
  projectId: PROJECT_ID,
  versionNumber: 1,
  supersedesVersionId: null,
  content: {
    references: {
      repository: 'github.com/octopus/checkout',
      ticketProvider: 'linear',
      ticketTeamKey: null,
      baseBranch: 'main',
      targetBranch: 'release/2026-10',
      deploymentProvider: 'vercel',
      engine: 'codex',
      previewComponents: [],
    },
    policy: {
      requiredChecks: ['build'],
      deliveryBehavior: 'ManualAuthorizationOnly',
      maxFixPasses: 2,
      workspaceIsolation: 'WorktreeAndDataDirectory',
      capabilityVersion: 1,
    },
    recipe: 'pnpm install',
    environment: { runtime: 'node-24', ports: [3000], secretReferences: [] },
  },
  contentFingerprint: 'fp_profile',
  note: null,
  createdAt: APPROVED_AT,
  createdBy: String(OWNER_ID),
} as unknown as ProjectProfileVersion;

/** One revision, approved unless a case says otherwise. */
function contractView(overrides: Partial<ContractView> = {}): ContractView {
  const approved = overrides.status === undefined || overrides.status === 'approved';
  return {
    contractId: CONTRACT_ID,
    revision: 1,
    projectId: PROJECT_ID,
    requestId: REQUEST_ID,
    status: 'approved',
    outcome: 'The order summary shows the total including tax.',
    scope: ['Sum the line items before tax', 'Apply the configured tax rate'],
    outOfScope: ['Changing the tax rate'],
    acceptanceCriteria: [
      {
        id: 'AC1',
        description: 'The summary returns 200.',
        verificationType: 'automated',
        verificationCheckId: 'unit-tests',
      },
      {
        id: 'AC2',
        description: 'The owner confirms the total.',
        verificationType: 'owner_test',
        verificationCheckId: null,
      },
    ],
    contentFingerprint: 'fp_content',
    requestFingerprint: 'fp_request',
    answersCurrentRequest: true,
    approvedAt: APPROVED_AT,
    approvedBy: String(OWNER_ID),
    staleReason: null,
    supersededByRevision: null,
    sourceBriefId: null,
    sourceBriefVersion: null,
    createdBy: String(OWNER_ID),
    createdAt: APPROVED_AT,
    updatedAt: APPROVED_AT,
    blockedBecause: approved ? null : `Contract revision 1 is ${overrides.status}; only an approved revision may be measured against.`,
    ...overrides,
  };
}

/**
 * Readers that answer with the rows above, and count what they were asked for.
 *
 * The counts are the point of this file: an order-of-operations defect - reading a request
 * before the contract read has refused the caller - is invisible in the returned value and
 * obvious in the counters.
 */
function readers(options: {
  readonly contract?: ContractView | null;
  readonly project?: ProjectRecord | null;
  readonly profile?: ProjectProfileVersion | null;
  readonly reads?: { requests: number; profiles: number };
} = {}): HandoffReaders {
  return {
    contracts: {
      getContract: (
        command: { readonly projectId: ProjectId; readonly contractId: ContractId; readonly revision: number },
        actor: OwnerActor,
      ): Result<ContractView, DomainError> => {
        // The same gate the real use case applies, because a fake that answered every caller
        // would make the authorization assertions below meaningless (F01-AC1).
        if (actor.role !== 'Owner' || actor.ownerId === null) {
          return {
            ok: false,
            error: { code: 'Forbidden', reason: 'Only the owner may read a delivery contract.' },
          };
        }
        const contract = options.contract === undefined ? contractView() : options.contract;
        if (contract === null || command.projectId !== contract.projectId) {
          return { ok: false, error: { code: 'NotFound', reason: 'No such contract revision.' } };
        }
        return ok(contract);
      },
    },
    requests: {
      read: (): Result<Request, DomainError> => {
        if (options.reads) options.reads.requests += 1;
        return ok(REQUEST);
      },
    },
    projects: {
      get: (): Result<ProjectRecord | null, DomainError> => {
        const project = options.project === undefined ? PROJECT : options.project;
        return ok(project);
      },
    },
    profiles: {
      currentVersion: (): Result<ProjectProfileVersion | null, DomainError> => {
        if (options.reads) options.reads.profiles += 1;
        const profile = options.profile === undefined ? PROFILE : options.profile;
        return ok(profile);
      },
    },
  };
}

function build(readerSet: HandoffReaders, t3Url: string | null = null, actor: OwnerActor = OWNER) {
  return buildImplementationHandoff(
    readerSet,
    { projectId: PROJECT_ID, contractId: CONTRACT_ID, revision: 1, t3Url },
    actor,
  );
}

test('an approved revision renders the generator\'s bytes for the stored project facts', () => {
  const result = build(readers());
  assert.ok(result.ok, `an approved revision must be handed off: ${result.ok ? '' : result.error.reason}`);
  assert.equal(result.value.contractId, CONTRACT_ID);
  assert.equal(result.value.revision, 1);

  // The same document the generator produces for the same input, compared as bytes. This is
  // the property the whole feature rests on: one approved contract, one packet (L02-AC3).
  const expected = generateImplementationPacket({
    project: {
      id: PROJECT_ID,
      name: PROJECT.name,
      repository: 'github.com/octopus/checkout',
      defaultBranch: 'release/2026-10',
    },
    request: { id: REQUEST_ID, title: REQUEST.title, description: REQUEST.description },
    contract: {
      id: CONTRACT_ID,
      revision: 1,
      status: 'approved',
      approvedAt: APPROVED_AT,
      outcome: 'The order summary shows the total including tax.',
      // The stored scope is a list and the packet states one block: the order the owner
      // wrote is the order the implementer reads (mvp-spec 3).
      scope: 'Sum the line items before tax\nApply the configured tax rate',
      outOfScope: ['Changing the tax rate'],
      acceptanceCriteria: [
        { id: 'AC1', description: 'The summary returns 200.', verificationType: 'automated' },
        { id: 'AC2', description: 'The owner confirms the total.', verificationType: 'owner_test' },
      ],
    },
    procedureReferences: [],
  });
  assert.ok(expected.ok, 'the expected packet must render');
  assert.equal(result.value.packet.markdown, expected.value.markdown);
  assert.equal(result.value.packet.fingerprint, fingerprint(result.value.packet.markdown));
  assert.match(result.value.packet.markdown, /Repository: github\.com\/octopus\/checkout/);
  assert.match(result.value.packet.markdown, /Target branch for the pull request: release\/2026-10/);
});

test('a project with no saved profile states the absence rather than inventing a repository', () => {
  const result = build(readers({ profile: null }));
  assert.ok(result.ok, result.ok ? '' : result.error.reason);
  assert.match(result.value.packet.markdown, /- Repository: Not recorded in ShipLoop\./);
  assert.match(result.value.packet.markdown, /- Target branch for the pull request: Not recorded in ShipLoop\./);
});

test('a draft and a retired approval are both refused, and neither renders a document', () => {
  for (const status of ['draft', 'stale'] as const) {
    const result = build(readers({ contract: contractView({ status }) }));
    assert.equal(result.ok, false, `a ${status} revision must not be handed off`);
    if (result.ok) continue;
    assert.equal(result.error.code, 'Blocked', `${status} is a missing prerequisite, not a permission failure`);
    if (result.error.code !== 'Blocked') continue;
    assert.equal(result.error.prerequisites[0]?.name, 'contractApproval');
    assert.match(result.error.prerequisites[0]?.remedy ?? '', /approve revision 1/i);
    assert.match(result.error.reason, new RegExp(status, 'i'), 'the refusal names the state the owner must change');
  }
});

test('an approved revision with no approval instant is refused rather than rendered', () => {
  const result = build(readers({ contract: contractView({ approvedAt: null }) }));
  assert.equal(result.ok, false, 'a packet must be able to name the approval it came from');
  if (!result.ok) assert.equal(result.error.code, 'Blocked');
});

test('a caller who may not act learns nothing, and no second read happens (F01-AC1)', () => {
  const reads = { requests: 0, profiles: 0 };
  const result = build(readers({ reads }), null, {
    actorId: 'agent-1' as OwnerId,
    // An agent role, which is the actor this product must never let write or read a
    // contract on its own: an agent's own output may not become an owner decision (F01-AC1).
    role: 'CodingAgent',
    ownerId: null,
    sessionId: null,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'Forbidden');
  assert.deepEqual(reads, { requests: 0, profiles: 0 }, 'authorization is decided before any row is read');
});

test('a revision in another project is refused by the project-scoped read (F02-AC2)', () => {
  const elsewhere = contractView({ projectId: 'checkout-other' as ProjectId });
  const result = build(readers({ contract: elsewhere }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'NotFound');
});

test('a project row this store does not hold is refused rather than rendered without a name', () => {
  const result = build(readers({ project: null }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'NotFound');
});

test('the three T3 states are distinguishable, and a refused value is never reproduced (N02-AC2)', () => {
  const absent = build(readers(), null);
  assert.ok(absent.ok, 'no T3 is not an error for a handoff');
  assert.equal(absent.value.t3.state, 'NotConfigured');
  assert.equal('url' in absent.value.t3, false);

  const blank = build(readers(), '   ');
  assert.ok(blank.ok, 'a blank configuration is still "not configured"');
  assert.equal(blank.value.t3.state, 'NotConfigured');

  const configured = build(readers(), 'https://t3.example.test');
  assert.ok(configured.ok, 'a usable configuration resolves');
  assert.equal(configured.value.t3.state, 'Configured');
  assert.equal(configured.value.t3.state === 'Configured' ? configured.value.t3.url : '', 'https://t3.example.test');

  for (const unusable of ['not a url', 'ftp://t3.example.test', 'https://user:hunter2@t3.example.test']) {
    const result = build(readers(), unusable);
    assert.ok(result.ok, 'an unusable configuration does not break the handoff');
    assert.equal(result.value.t3.state, 'Unusable', `${unusable} must be reported as unusable, not as configured`);
    assert.equal(JSON.stringify(result.value).includes('hunter2'), false, 'a refused value is never reproduced');
    if (result.value.t3.state === 'Unusable') {
      assert.ok(result.value.t3.prerequisites.length > 0, 'an operator error arrives with its remedy');
    }
  }
});

test('the packet states that no procedure references are stored, rather than omitting the section', () => {
  const result = build(readers());
  assert.ok(result.ok, result.ok ? '' : result.error.reason);
  assert.match(result.value.packet.markdown, /No project procedure references are stored for this project\./);
});
