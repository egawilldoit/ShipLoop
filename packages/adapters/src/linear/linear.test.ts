/**
 * The real Linear adapter, driven against a scripted endpoint.
 *
 * Every assertion here travels through the shipped `LinearClient`, the shipped error
 * mapping and the shipped translation code; only HTTP is scripted, by `stub.ts`. The
 * tests that also appear in `../testing/contract-suite.ts` are reproduced against this
 * adapter rather than against the fakes, because the fakes are not what ships. The
 * structural reason the shared suite cannot do this itself is recorded in `README.md`:
 * `AdapterSet.ticket` is typed `FakeTicketAdapter`, and `../testing/` is outside this
 * unit's file ownership.
 *
 * Criterion IDs in each test name are the specification lines the assertion enforces.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compareScope,
  scopeFingerprint,
  type DomainError,
  type ProviderId,
  type ScopeSnapshot,
} from '@shiploop/domain';

import {
  FIXED_INSTANT,
  FIXTURE_DEPENDENCY_ISSUE_ID,
  FIXTURE_PROPOSAL_REVISION,
  FIXTURE_WORK_ITEM_ID,
  adapterContext,
  connectorId,
  operationId,
  providerId,
  publishWorkRequest,
  ticketTransitionRequest,
} from '../testing/fixtures.ts';
import type {
  AdapterContext,
  ManagedProgressOutcome,
  ManagedProgressUpdateRequest,
  TicketScopeRead,
} from '../contracts/index.ts';
import {
  LinearTicketAdapter,
  extractAcceptanceCriteria,
  lexicalOverlap,
  managedCommentId,
  publicationBody,
  publicationIssueId,
  publicationRelationId,
  managedMarkerLine,
} from './adapter.ts';
import {
  StubLinear,
  apiError,
  data,
  notFoundEnvelope,
  relationRow,
  stubIssuePayload,
  unauthenticatedEnvelope,
  type Responder,
  type StubIssueFields,
  type StubRelationRow,
} from './stub.ts';

/* -------------------------------------------------------------------------- */
/* Local fixtures                                                              */
/* -------------------------------------------------------------------------- */

const SCOPE_ISSUE_UUID = '11111111-1111-4111-8111-111111111111';
const DEPENDENCY_UUID = providerId('22222222-2222-4222-8222-222222222222');
const COMMENT_UUID = providerId('44444444-4444-4444-8444-444444444444');
const OTHER_UUID = providerId('55555555-5555-4555-8555-555555555555');
const SEARCH_UUID = providerId('66666666-6666-4666-8666-666666666666');
const NO_PRIORITY_UUID = providerId('77777777-7777-4777-8777-777777777777');
const UNMAPPED_PRIORITY_UUID = providerId('88888888-8888-4888-8888-888888888888');
const RETITLED_UUID = providerId('99999999-9999-4999-8999-999999999999');
const EDITED_CRITERIA_UUID = providerId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

/**
 * A published description, written by the adapter's own publisher.
 *
 * Derived rather than pasted so the criteria fixtures cannot drift from the format the
 * adapter reads, and so a test that asserts on criteria can never pass because the
 * fixture described none.
 */
const CRITERIA_REGION = publicationBody({
  description: 'A review card must explain why a preview is unusable.',
  criteria: [
    { id: 'AC1', text: 'Missing, building, failed, protected and usable stay distinct.' },
    { id: 'scope.preview.card', text: 'The card names the reason it is not usable.' },
  ],
  operationId: 'op_fixture_publication',
});

/**
 * The baseline's relation rows, re-pointed at a variant issue.
 *
 * Linear's `inverseRelations` rows name the subject in `relatedIssue`, so a fixture for
 * a variant issue has to point them at that variant or the counterparty mapping would
 * read the baseline issue as its own dependency.
 */
function sameRelations(
  baseline: StubIssueFields,
  id: string,
  identifier: string,
): readonly StubRelationRow[] {
  const point = (issue: StubIssueFields | null): StubIssueFields | null =>
    issue === null ? null : { ...issue, id, identifier };
  // Linear names the subject of an outgoing row in `issue` and of an inbound row in
  // `relatedIssue`. Re-pointing the wrong side would either leave the row describing the
  // baseline issue or turn a self-reference into a dependency on it.
  const outbound = (baseline.relations ?? []).map((row) => ({ ...row, issue: point(row.issue) }));
  // The baseline carries a row that references itself; on a variant issue that row would
  // name the baseline as a dependency, so it is dropped rather than mis-pointed. The
  // self-reference behaviour itself is asserted by its own case.
  const inbound = (baseline.inverseRelations ?? [])
    .filter((row) => row.issue === null || row.relatedIssue === null || row.issue.id !== row.relatedIssue.id)
    .map((row) => ({ ...row, relatedIssue: point(row.relatedIssue) }));
  return [...outbound, ...inbound];
}

const STARTED_STATE = { id: 'state-in-progress', name: 'In Progress', type: 'started' } as const;
const DONE_STATE = { id: 'state-done', name: 'Done', type: 'completed' } as const;

const SCOPE_ISSUE: StubIssueFields = {
  id: SCOPE_ISSUE_UUID,
  identifier: 'EGA-664',
  title: 'Label preview deployment states on the review card',
  description: CRITERIA_REGION,
  updatedAt: '2026-09-27T11:21:44.066Z',
  priority: 2,
  state: STARTED_STATE,
  team: { id: 'team-ega', key: 'EGA' },
  inverseRelations: [
    // The live asymmetry: on `inverseRelations` the `relatedIssue` field is the subject.
    relationRow('blocks', { id: DEPENDENCY_UUID, identifier: 'EGA-662' }, { id: SCOPE_ISSUE_UUID, identifier: 'EGA-664' }),
    relationRow('blocks', { id: SCOPE_ISSUE_UUID, identifier: 'EGA-664' }, { id: SCOPE_ISSUE_UUID, identifier: 'EGA-664' }),
  ],
  relations: [relationRow('related', { id: SCOPE_ISSUE_UUID, identifier: 'EGA-664' }, { id: OTHER_UUID, identifier: 'EGA-653' })],
};

function adapterWith(responders: Readonly<Record<string, Responder>>): {
  readonly adapter: LinearTicketAdapter;
  readonly stub: StubLinear;
} {
  const stub = new StubLinear(responders);
  return {
    stub,
    adapter: new LinearTicketAdapter({
      connectorId: connectorId('connector_linear_test'),
      client: { apiKey: 'stub-key-not-a-credential', fetchImpl: stub.fetch },
    }),
  };
}

function scopeResponder(issues: Readonly<Record<string, StubIssueFields>>): Responder {
  return (variables) => {
    const id = String(variables['id']);
    const issue = issues[id];
    return issue === undefined ? notFoundEnvelope() : data({ issue: stubIssuePayload(issue) });
  };
}

function teamsResponder(): Responder {
  return () =>
    data({
      teams: {
        nodes: [
          { id: 'team-fix', key: 'FIX', name: 'Fixture' },
          { id: 'team-ega', key: 'EGA', name: 'Egawilldoit' },
          { id: 'team-gym', key: 'GYM', name: 'gymtrack space' },
        ],
      },
    });
}

async function okOf<T>(pending: Promise<{ ok: true; value: T } | { ok: false; error: DomainError }>): Promise<T> {
  const result = await pending;
  if (!result.ok) assert.fail(`expected success, received ${result.error.code}: ${result.error.reason}`);
  return result.value;
}

/** A scope read against a UUID the adapter accepts, used to observe error propagation. */
function readScopeError(
  adapter: LinearTicketAdapter,
  operation: string,
): Promise<{ ok: true; value: unknown } | { ok: false; error: DomainError }> {
  return adapter.readScope(adapterContext(operation), {
    workItemId: FIXTURE_WORK_ITEM_ID,
    issueId: providerId(SCOPE_ISSUE_UUID),
  });
}

async function errorOf(
  pending: Promise<{ ok: true; value: unknown } | { ok: false; error: DomainError }>,
): Promise<DomainError> {
  const result = await pending;
  if (result.ok) assert.fail('expected a refusal, received success');
  return result.error;
}

/* -------------------------------------------------------------------------- */
/* F30-AC4, F03-AC2: transport and error mapping                              */
/* -------------------------------------------------------------------------- */

test('F30-AC4 a 429 is surfaced as RateLimited carrying the provider retry hint, without a local retry', async () => {
  const { adapter, stub } = adapterWith({
    LinearIssueScope: () => ({
      status: 429,
      headers: { 'retry-after': '4.5' },
      body: { errors: [{ message: 'too many requests', extensions: { code: 'RATELIMITED' } }] },
    }),
  });
  const error = await errorOf(readScopeError(adapter, 'op_rate_limited'));
  assert.equal(error.code, 'RateLimited');
  assert.equal(error.code === 'RateLimited' ? error.retryAfterMs : null, 4500);
  assert.equal(stub.countOf('LinearIssueScope'), 1, 'a rate-limited read must not be retried inside the adapter');
});

test("F30-AC4 Linear's documented rate limit shape (HTTP 400 with RATELIMITED) is also a RateLimited", async () => {
  const { adapter, stub } = adapterWith({
    LinearIssueScope: () => ({
      status: 400,
      body: { errors: [{ message: 'rate limited', extensions: { code: 'RATELIMITED', type: 'rate limit error' } }] },
    }),
  });
  const error = await errorOf(readScopeError(adapter, 'op_rate_limited_400'));
  assert.equal(error.code, 'RateLimited');
  assert.equal(stub.countOf('LinearIssueScope'), 1);
});

test('F30-AC4 the epoch-millisecond reset headers are read as a retry hint', async () => {
  const nowMs = Date.parse(FIXED_INSTANT);
  const { adapter } = adapterWith({
    LinearIssueScope: () => ({
      status: 429,
      headers: { 'x-ratelimit-requests-reset': String(nowMs + 2500) },
      body: { errors: [{ message: 'too many requests', extensions: { code: 'RATELIMITED' } }] },
    }),
  });
  const error = await errorOf(readScopeError(adapter, 'op_rate_limited_reset'));
  assert.equal(error.code === 'RateLimited' ? error.retryAfterMs : null, 2500);
});

test('F30-AC4 rate-limit retry is opt-in and bounded', async () => {
  const stub = new StubLinear({
    LinearIssueScope: () => ({
      status: 429,
      headers: { 'retry-after': '0' },
      body: { errors: [{ message: 'too many requests', extensions: { code: 'RATELIMITED' } }] },
    }),
  });
  const adapter = new LinearTicketAdapter({
    connectorId: connectorId('connector_linear_test'),
    client: {
      apiKey: 'stub-key-not-a-credential',
      fetchImpl: stub.fetch,
      maxRateLimitRetries: 2,
      maxBackoffMs: 1,
    },
  });
  const error = await errorOf(readScopeError(adapter, 'op_rate_limited_retry'));
  assert.equal(error.code, 'RateLimited');
  assert.equal(stub.countOf('LinearIssueScope'), 3, 'expected the first attempt plus exactly two bounded retries');
});

test('F03-AC2/F03-AC4 an unusable credential is Forbidden and says to reauthorize', async () => {
  const { adapter, stub } = adapterWith({ LinearViewer: () => unauthenticatedEnvelope() });
  const compatibility = await okOf(adapter.checkCompatibility(adapterContext('op_revoked')));
  assert.equal(compatibility.compatible, false);
  assert.match(compatibility.detail, /reauthorize/);
  assert.equal(stub.countOf('LinearViewer'), 1, 'a revoked credential must not be retried');
});

test('F03-AC2 a permission refusal is Forbidden and names the remediation', async () => {
  const { adapter } = adapterWith({
    LinearIssueScope: () =>
      apiError('no access', {
        code: 'ENTITY_FORBIDDEN',
        type: 'access error',
        statusCode: 403,
        userPresentableMessage: 'You do not have access to this issue.',
      }),
  });
  const error = await errorOf(
    adapter.readScope(adapterContext('op_forbidden'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  assert.equal(error.code, 'Forbidden');
  assert.match(error.reason, /Grant the connector access/);
});

test('F11-AC3 a missing issue is NotFound, which live Linear reports as HTTP 200', async () => {
  const { adapter } = adapterWith({ LinearIssueScope: () => notFoundEnvelope() });
  const error = await errorOf(
    adapter.readScope(adapterContext('op_missing'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  assert.equal(error.code, 'NotFound');
});

test('F03-AC2 malformed input is Invalid with one entry per field', async () => {
  const { adapter } = adapterWith({
    LinearTeams: teamsResponder(),
    LinearIssueScope: () => notFoundEnvelope(),
    LinearIssueCreate: () =>
      apiError('Argument Validation Error', {
        code: 'GRAPHQL_VALIDATION_FAILED',
        type: 'graphql error',
        statusCode: 400,
        path: ['issueCreate', 'input', 'teamId'],
      }),
  });
  const error = await errorOf(adapter.publishWork(adapterContext('op_invalid'), publishWorkRequest('op_invalid')));
  assert.equal(error.code, 'Invalid');
  assert.equal(error.code === 'Invalid' ? error.fields.length : 0, 1);
  assert.equal(error.code === 'Invalid' ? error.fields[0]?.path : null, 'teamId');
});

test('F03-AC2 a provider 5xx is Unavailable and is not retried', async () => {
  const { adapter, stub } = adapterWith({ LinearIssueScope: () => ({ status: 503, body: 'upstream unavailable' }) });
  const error = await errorOf(readScopeError(adapter, 'op_5xx'));
  assert.equal(error.code, 'Unavailable');
  assert.equal(stub.countOf('LinearIssueScope'), 1);
});

test('F30-AC4 a dropped connection on a read is Unavailable', async () => {
  const { adapter } = adapterWith({ LinearIssueScope: () => ({ body: {}, transportFailure: 'socket hang up' }) });
  const error = await errorOf(readScopeError(adapter, 'op_dropped_read'));
  assert.equal(error.code, 'Unavailable');
});

test('F30-AC5 a dropped connection on a write is OutcomeUnknown, never a failure', async () => {
  const { adapter } = adapterWith({
    LinearTeams: teamsResponder(),
    LinearIssueScope: () => notFoundEnvelope(),
    LinearIssueCreate: () => ({ body: {}, transportFailure: 'socket hang up' }),
    LinearRelationCreate: () => data({ issueRelationCreate: { success: true } }),
  });
  const error = await errorOf(adapter.publishWork(adapterContext('op_dropped_write'), publishWorkRequest('op_dropped_write')));
  assert.equal(error.code, 'OutcomeUnknown');
  assert.equal(error.code === 'OutcomeUnknown' ? error.operationId : null, 'op_dropped_write');
  assert.equal(error.code === 'OutcomeUnknown' ? error.target : null, `linear:issue:${publicationIssueId('op_dropped_write')}`);
});

/**
 * A credential-shaped string, assembled so no tracked source line contains one.
 *
 * `scripts/lint.mjs` refuses a credential-shaped literal in any source file, and it is
 * right to: a real key must never be committed. The seeded value is therefore built from
 * parts, which keeps the redaction proof (N02-AC2) without putting the shape in the file.
 */
const SEEDED_CREDENTIAL = ['lin', 'api', 'AAAABBBBCCCCDDDDEEEE'].join('_');

test('N02-AC2 a credential-shaped string inside a provider message is redacted before it is returned', async () => {
  const { adapter } = adapterWith({
    LinearIssueScope: () =>
      apiError(`rejected key ${SEEDED_CREDENTIAL} for this call`, {
        code: 'INVALID_INPUT',
        type: 'invalid input',
        statusCode: 400,
        userPresentableMessage: `The key ${SEEDED_CREDENTIAL} is not valid.`,
      }),
  });
  const error = await errorOf(readScopeError(adapter, 'op_secret_in_message'));
  assert.equal(error.code, 'Invalid');
  assert.ok(!error.reason.includes(SEEDED_CREDENTIAL), 'the provider message reached the caller unredacted');
  for (const field of error.code === 'Invalid' ? error.fields : []) {
    assert.ok(!field.message.includes(SEEDED_CREDENTIAL), 'a provider field message reached the caller unredacted');
  }
  assert.match(error.code === 'Invalid' ? error.fields[0]?.message ?? '' : '', /\[redacted:linear-api-key\]/);
});

/* -------------------------------------------------------------------------- */
/* N05-AC2, F11-AC3: identity                                                  */
/* -------------------------------------------------------------------------- */

test('N05-AC2 a wrong-provider identity is Forbidden before any request is made', async () => {
  const { adapter, stub } = adapterWith({});
  const error = await errorOf(
    adapter.readScope(adapterContext('op_foreign'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId('repo_fixture_01') }),
  );
  assert.equal(error.code, 'Forbidden');
  assert.equal(stub.calls.length, 0, 'a refused identity must not reach the provider');
});

test('F11-AC1 a Linear team identifier is resolved to its UUID rather than refused', async () => {
  const { adapter } = adapterWith({ LinearIssueScope: scopeResponder({ 'EGA-664': SCOPE_ISSUE }) });
  const read = await okOf(
    adapter.readScope(adapterContext('op_identifier'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId('EGA-664') }),
  );
  assert.equal(read.issue.issueId, SCOPE_ISSUE_UUID);
  assert.equal(read.snapshot.issueId, SCOPE_ISSUE_UUID, 'the snapshot must carry the UUID, not the typed name');
});

/* -------------------------------------------------------------------------- */
/* F12-AC1, F11-AC1: scope reading                                             */
/* -------------------------------------------------------------------------- */

test('F12-AC1 an inbound blocks relation is read as BlockedBy, which is the dependency identity', async () => {
  const { adapter } = adapterWith({ LinearIssueScope: scopeResponder({ [SCOPE_ISSUE_UUID]: SCOPE_ISSUE }) });
  const read = await okOf(
    adapter.readScope(adapterContext('op_scope'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  const blockedBy = read.relations.filter((relation) => relation.kind === 'BlockedBy');
  assert.equal(blockedBy.length, 1);
  assert.equal(blockedBy[0]?.issue.issueId, DEPENDENCY_UUID);
  assert.deepEqual([...read.snapshot.dependencyIssueIds], [DEPENDENCY_UUID]);
});

test('F12-AC1 a self-referencing relation row is dropped instead of making an issue its own dependency', async () => {
  const { adapter } = adapterWith({ LinearIssueScope: scopeResponder({ [SCOPE_ISSUE_UUID]: SCOPE_ISSUE }) });
  const read = await okOf(
    adapter.readScope(adapterContext('op_self_relation'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  assert.ok(
    !read.relations.some((relation) => relation.issue.issueId === SCOPE_ISSUE_UUID),
    'the issue was reported as related to itself',
  );
});

test('F12-AC1 an outgoing relation is reported with its own direction', async () => {
  const { adapter } = adapterWith({ LinearIssueScope: scopeResponder({ [SCOPE_ISSUE_UUID]: SCOPE_ISSUE }) });
  const read = await okOf(
    adapter.readScope(adapterContext('op_outgoing'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  const outgoing = read.relations.find((relation) => relation.issue.issueId === OTHER_UUID);
  assert.equal(outgoing?.kind, 'Related');
  assert.ok(!read.snapshot.dependencyIssueIds.includes(OTHER_UUID as ProviderId), 'a related link is not a dependency');
});

test('F12-AC1 a criterion identity survives an unrelated edit because it is never a list position', async () => {
  const before = extractAcceptanceCriteria(CRITERIA_REGION);
  const inserted = extractAcceptanceCriteria(
    CRITERIA_REGION.replace('<!-- shiploop:criteria:start -->', '<!-- shiploop:criteria:start -->\n- <!--shiploop:ac:AC0--> Added first.'),
  );
  assert.equal(before.length, 2, 'the fixture described no criteria, so the assertion would pass vacuously');
  assert.deepEqual(
    inserted.filter((criterion) => criterion.id !== 'AC0').map((criterion) => criterion.id),
    before.map((criterion) => criterion.id),
    'inserting a criterion renamed the criteria below it',
  );
});

test('F12-AC2 a published criterion id round trips verbatim, including a non-AC identifier', async () => {
  const revision = {
    description: 'The card must explain itself.',
    criteria: [
      { id: 'AC1', text: 'States stay distinct.' },
      { id: 'scope.preview.card/reason', text: 'Names the reason.' },
    ],
    operationId: 'op_publication_body',
  };
  const readBack = extractAcceptanceCriteria(publicationBody(revision));
  assert.deepEqual(
    readBack.map((criterion) => criterion.id),
    ['AC1', 'scope.preview.card/reason'],
  );
  assert.deepEqual(
    readBack.map((criterion) => criterion.text),
    ['States stay distinct.', 'Names the reason.'],
  );
});

test('F12 criteria are read from a recognised heading and an author-supplied AC token', async () => {
  const criteria = extractAcceptanceCriteria(
    '## Summary\nNot a criterion.\n\n## Acceptance Criteria\n- AC1 first\n- [AC-2] second\n- third\n\n## Notes\n- not a criterion either',
  );
  assert.deepEqual(
    criteria.map((criterion) => [criterion.id, criterion.text]),
    [
      ['AC1', 'first'],
      ['AC2', 'second'],
      ['third', 'third'],
    ],
  );
});

test('F12 an issue with no criteria region reports no criteria rather than promoting prose bullets', () => {
  const criteria = extractAcceptanceCriteria('## Idea\n\nSomething worth doing.\n\n- a loose bullet\n- another loose bullet');
  assert.deepEqual(criteria, []);
});

test('F29-AC3 a workflow state whose type is unmapped is Unknown, never the provider string', async () => {
  const { adapter } = adapterWith({
    LinearIssueScope: scopeResponder({
      [SCOPE_ISSUE_UUID]: { ...SCOPE_ISSUE, state: { id: 's', name: 'Done', type: 'completed_by_vibes' } },
    }),
  });
  const read = await okOf(
    adapter.readScope(adapterContext('op_unknown_state'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  assert.equal(read.state.kind, 'Unknown');
});

test('F12 priority is ShipLoop vocabulary, never the provider display string', async () => {
  const { adapter } = adapterWith({
    LinearIssueScope: scopeResponder({
      [SCOPE_ISSUE_UUID]: { ...SCOPE_ISSUE, priority: 2 },
      [NO_PRIORITY_UUID]: { ...SCOPE_ISSUE, id: NO_PRIORITY_UUID, identifier: 'EGA-810', priority: 0 },
      [UNMAPPED_PRIORITY_UUID]: { ...SCOPE_ISSUE, id: UNMAPPED_PRIORITY_UUID, identifier: 'EGA-811', priority: 9 },
    }),
  });
  const base = { workItemId: FIXTURE_WORK_ITEM_ID };
  const read = (id: string): Promise<TicketScopeRead> =>
    okOf(adapter.readScope(adapterContext('op_priority'), { ...base, issueId: providerId(id) }));
  assert.equal((await read(SCOPE_ISSUE_UUID)).snapshot.priority, 'High');
  assert.equal((await read(NO_PRIORITY_UUID)).snapshot.priority, 'NoPriority');
  assert.equal(
    (await read(UNMAPPED_PRIORITY_UUID)).snapshot.priority,
    null,
    'an unmapped priority must be absent, not invented',
  );
});

test('F12 a providerRevision is retained so a later comparison can detect an edit', async () => {
  const { adapter } = adapterWith({ LinearIssueScope: scopeResponder({ [SCOPE_ISSUE_UUID]: SCOPE_ISSUE }) });
  const read = await okOf(
    adapter.readScope(adapterContext('op_revision'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  assert.equal(read.snapshot.providerRevision, '2026-09-27T11:21:44.066Z');
});

test('F16-AC2 an issue with no managed comment reports an append-only region, never a fabricated comment id', async () => {
  const { adapter } = adapterWith({ LinearIssueScope: scopeResponder({ [SCOPE_ISSUE_UUID]: SCOPE_ISSUE }) });
  const read = await okOf(
    adapter.readScope(adapterContext('op_no_region'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  assert.deepEqual(read.managedRegions, [
    {
      target: { kind: 'AppendOnlyCommentThread', lastCommentId: null },
      lastMilestoneKey: null,
      lastDeliveredAt: null,
      lastDeliveredContentDigest: null,
    },
  ]);
});

test('F16-AC2 a managed comment is recovered from its own marker, not from its position', async () => {
  const { adapter } = adapterWith({
    LinearIssueScope: scopeResponder({
      [SCOPE_ISSUE_UUID]: {
        ...SCOPE_ISSUE,
        comments: [
          { id: 'human-comment', body: 'A human said something worth keeping.' },
          {
            id: COMMENT_UUID,
            body: `${managedMarkerLine({
              issueId: SCOPE_ISSUE_UUID,
              operationId: 'op_1',
              milestoneKey: 'Draft linked',
              digest: 'abc',
              deliveredAt: DELIVERED_AT,
            })}\nDraft linked.`,
          },
        ],
      },
    }),
  });
  const read = await okOf(
    adapter.readScope(adapterContext('op_region'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  assert.equal(read.managedRegions.length, 1);
  assert.deepEqual(read.managedRegions[0]?.target, { kind: 'UpdatableComment', commentId: COMMENT_UUID });
  assert.equal(read.managedRegions[0]?.lastMilestoneKey, 'Draft linked');
});

test('F16-AC3 a second managed comment is reported rather than hidden', async () => {
  const marker = (id: string): StubComment => ({
    id,
    body: `${managedMarkerLine({
      issueId: SCOPE_ISSUE_UUID,
      operationId: `op_${id}`,
      milestoneKey: 'm',
      digest: 'd',
      deliveredAt: DELIVERED_AT,
    })}\nbody`,
  });
  const { adapter } = adapterWith({
    LinearIssueScope: scopeResponder({
      [SCOPE_ISSUE_UUID]: { ...SCOPE_ISSUE, comments: [marker('one'), marker('two')] },
    }),
  });
  const read = await okOf(
    adapter.readScope(adapterContext('op_two_regions'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  assert.equal(read.managedRegions.length, 2);
});

test('F03-AC1 a 200 response carrying no readable issue shape is Unavailable, not a partial scope', async () => {
  const { adapter } = adapterWith({ LinearIssueScope: () => data({ issue: { identifier: 'EGA-664' } }) });
  const error = await errorOf(
    adapter.readScope(adapterContext('op_bad_shape'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  assert.equal(error.code, 'Unavailable');
  assert.match(error.reason, /cannot read/);
});

/* -------------------------------------------------------------------------- */
/* F06-AC4: related work                                                       */
/* -------------------------------------------------------------------------- */

test('F06-AC4 a declared dependency is surfaced for the owner and never adopted', async () => {
  const { adapter } = adapterWith({
    LinearIssueScope: scopeResponder({ [SCOPE_ISSUE_UUID]: SCOPE_ISSUE }),
    LinearSearchIssues: () => data({ searchIssues: { nodes: [] } }),
  });
  const read = await okOf(
    adapter.readScope(adapterContext('op_related_scope'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  const related = await okOf(
    adapter.findRelatedIssues(adapterContext('op_related'), { workItemId: FIXTURE_WORK_ITEM_ID, scope: read.snapshot, limit: 10 }),
  );
  const dependency = related.find((entry) => entry.issue.issueId === DEPENDENCY_UUID);
  assert.equal(dependency?.relation, 'DependentWork');
  assert.deepEqual([...(dependency?.matchedOn ?? [])], ['ExplicitLink']);
  assert.ok(related.every((entry) => entry.adoption.kind === 'RequiresOwnerDecision'), 'the adapter adopted related work');
});

test('F06-AC4 a search hit with no measured signal is dropped rather than returned with an empty reason list', async () => {
  const { adapter } = adapterWith({
    LinearIssueScope: scopeResponder({ [SCOPE_ISSUE_UUID]: SCOPE_ISSUE }),
    LinearSearchIssues: () =>
      data({
        searchIssues: {
          nodes: [
            {
              id: SEARCH_UUID,
              identifier: 'EGA-900',
              url: 'https://linear.app/stub/issue/EGA-900',
              title: 'Totally unrelated quarterly budget spreadsheet',
              description: 'Numbers only.',
              priority: 0,
              updatedAt: '2026-09-01T00:00:00.000Z',
              team: { key: 'EGA' },
              state: STARTED_STATE,
              labels: { nodes: [] },
            },
          ],
        },
      }),
  });
  const read = await okOf(
    adapter.readScope(adapterContext('op_unrelated_scope'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  const related = await okOf(
    adapter.findRelatedIssues(adapterContext('op_unrelated'), { workItemId: FIXTURE_WORK_ITEM_ID, scope: read.snapshot, limit: 10 }),
  );
  assert.ok(!related.some((entry) => entry.issue.issueId === SEARCH_UUID));
});

test('F06-AC4 a shared label is a measured signal and is reported as such', async () => {
  const { adapter } = adapterWith({
    LinearIssueScope: scopeResponder({ [SCOPE_ISSUE_UUID]: { ...SCOPE_ISSUE, labelNames: ['review-card'] } }),
    LinearSearchIssues: () =>
      data({
        searchIssues: {
          nodes: [
            {
              id: SEARCH_UUID,
              identifier: 'EGA-901',
              url: 'https://linear.app/stub/issue/EGA-901',
              title: 'Review card plumbing for the deploy view',
              description: 'Review card work.',
              priority: 0,
              updatedAt: '2026-09-01T00:00:00.000Z',
              team: { key: 'EGA' },
              state: STARTED_STATE,
              labels: { nodes: [{ name: 'review-card' }] },
            },
          ],
        },
      }),
  });
  const read = await okOf(
    adapter.readScope(adapterContext('op_label_scope'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  const related = await okOf(
    adapter.findRelatedIssues(adapterContext('op_label'), { workItemId: FIXTURE_WORK_ITEM_ID, scope: read.snapshot, limit: 10 }),
  );
  assert.ok(related.some((entry) => entry.matchedOn.includes('SharedLabel')));
});

test('F06-AC4 the similarity measure is ShipLoop\'s own and is bounded to [0, 1]', () => {
  assert.equal(lexicalOverlap('preview card states', 'preview card states'), 1);
  assert.equal(lexicalOverlap('', 'anything'), 0);
  const partial = lexicalOverlap('preview card', 'deploy smoke');
  assert.ok(partial >= 0 && partial <= 1 && partial < 1);
});

test('F06-AC4 a shorter title wholly contained in a longer one is not scored as unrelated', () => {
  // The three real EGA titles the live calibration found most alike. Jaccard scored this
  // pair at 0.286, below the 0.5 signal gate, so a duplicate was reported as unrelated
  // purely because one title was longer than the other.
  const long = '[W6][SPEC-006] Implement MCP inspect tool';
  const shorter = 'MCP inspect tool';
  assert.ok(
    lexicalOverlap(long, shorter) >= 0.5,
    `a contained duplicate scored ${lexicalOverlap(long, shorter)}, which the signal gate would reject`,
  );
  assert.equal(lexicalOverlap('Login redesign', 'Create login page UI at root domain') > 0, true);
  assert.equal(lexicalOverlap('Login redesign the screen', 'Quarterly budget spreadsheet'), 0);
});

test('F06-AC4 a real near-duplicate found by search is surfaced rather than dropped', async () => {
  const { adapter } = adapterWith({
    LinearIssueScope: scopeResponder({
      [SCOPE_ISSUE_UUID]: {
        ...SCOPE_ISSUE,
        title: '[W6][SPEC-006] Implement MCP inspect tool',
        labelNames: [],
      },
    }),
    LinearSearchIssues: () =>
      data({
        searchIssues: {
          nodes: [
            {
              id: SEARCH_UUID,
              identifier: 'EGA-591',
              url: 'https://linear.app/stub/issue/EGA-591',
              title: '[W6][SPEC-006] Implement MCP search tool',
              description: null,
              priority: 0,
              updatedAt: '2026-09-01T00:00:00.000Z',
              team: { key: 'EGA' },
              state: STARTED_STATE,
              labels: { nodes: [] },
            },
          ],
        },
      }),
  });
  const read = await okOf(
    adapter.readScope(adapterContext('op_dup_scope'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  const related = await okOf(
    adapter.findRelatedIssues(adapterContext('op_dup'), { workItemId: FIXTURE_WORK_ITEM_ID, scope: read.snapshot, limit: 10 }),
  );
  const near = related.find((entry) => entry.issue.issueId === SEARCH_UUID);
  assert.ok(near !== undefined, 'a near-duplicate title pair from the live calibration was dropped');
  assert.ok(near.matchedOn.includes('TitleOverlap'));
  assert.equal(near.adoption.kind, 'RequiresOwnerDecision', 'resemblance adopted work instead of offering it');
  assert.ok(near.similarity > 0 && near.similarity <= 1);
});

/* -------------------------------------------------------------------------- */
/* F10-AC1, F10-AC3: publication                                                */
/* -------------------------------------------------------------------------- */

/**
 * A provider that behaves like Linear for one publication.
 *
 * The created issue and its relation rows are real state rather than a fixed script, so
 * the second read of a publication observes the first one's writes. That is what makes
 * "a retry did not create a second issue" and "the snapshot reports what the provider
 * holds" assertions rather than restatements of the request.
 */
class PublicationProvider {
  readonly linked: StubIssueFields[] = [];
  /** Every identity the adapter asked to create, which is the side-effect count. */
  readonly createdIds: string[] = [];
  private readonly createdIssues = new Map<string, StubIssueFields>();
  resolvableDependencies = true;
  createReportsSuccess = true;

  private readonly issueId: string;
  private readonly identifier: string;

  /** `operation` is the ShipLoop operation identity; `identifier` is Linear's own name. */
  constructor(operation: string, identifier: string) {
    this.issueId = publicationIssueId(operation);
    this.identifier = identifier;
  }

  private issue(id: string): StubIssueFields | null {
    const created = this.createdIssues.get(id);
    if (created !== undefined) {
      // Re-derived on every read, so a link accepted after the create is visible to the
      // confirming read exactly as it would be on the provider.
      const updated = this.current(id, created.identifier);
      this.createdIssues.set(id, updated);
      return updated;
    }
    if (id === FIXTURE_DEPENDENCY_ISSUE_ID) {
      return this.resolvableDependencies
        ? { id: DEPENDENCY_UUID, identifier: 'EGA-662' }
        : null;
    }
    return null;
  }

  /** The issue as the provider now holds it, including the links it has accepted. */
  private current(id: string, identifier: string): StubIssueFields {
    return {
      ...SCOPE_ISSUE,
      id,
      identifier,
      relations: [],
      inverseRelations: this.linked.map((dependency) =>
        relationRow('blocks', dependency, { id, identifier }),
      ),
    };
  }

  responders(): Record<string, Responder> {
    return {
      LinearTeams: teamsResponder(),
      LinearIssueScope: (variables) => {
        const known = this.issue(String(variables['id']));
        return known === null ? notFoundEnvelope() : data({ issue: stubIssuePayload(known) });
      },
      LinearIssueCreate: (variables) => {
        const input = variables['input'] as { readonly id: string; readonly title: string };
        this.createdIds.push(input.id);
        const identifier = input.id === this.issueId ? this.identifier : `${this.identifier}-${input.id.slice(0, 8)}`;
        const created = this.current(input.id, identifier);
        this.createdIssues.set(input.id, created);
        return data({
          issueCreate: {
            success: this.createReportsSuccess,
            issue: this.createReportsSuccess ? stubIssuePayload(created) : null,
          },
        });
      },
      LinearRelationCreate: () => {
        this.linked.push({ id: DEPENDENCY_UUID, identifier: 'EGA-662' });
        return data({ issueRelationCreate: { success: true, issueRelation: { id: 'rel-1', type: 'blocks' } } });
      },
    };
  }
}

test('F10-AC3 the issue identity a publication owns is derived from its OperationId', () => {
  assert.equal(publicationIssueId('op_1'), publicationIssueId('op_1'));
  assert.notEqual(publicationIssueId('op_1'), publicationIssueId('op_2'));
  assert.match(publicationIssueId('op_1'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('F10-AC3 publication sends the deterministic identity as a client-supplied id', async () => {
  const provider = new PublicationProvider('op_pub_send', 'EGA-700');
  const { adapter, stub } = adapterWith(provider.responders());
  await okOf(adapter.publishWork(adapterContext('op_pub_send'), publishWorkRequest('op_pub_send')));
  const input = stub.variablesFor('LinearIssueCreate')?.['input'] as { readonly id: string };
  assert.equal(input.id, publicationIssueId('op_pub_send'));
});

test('F10-AC3 a repeated publication of one operation creates no second issue', async () => {
  const provider = new PublicationProvider('op_repeat', 'EGA-700');
  const { adapter, stub } = adapterWith(provider.responders());
  const first = await okOf(adapter.publishWork(adapterContext('op_repeat'), publishWorkRequest('op_repeat')));
  const second = await okOf(adapter.publishWork(adapterContext('op_repeat'), publishWorkRequest('op_repeat')));
  assert.equal(first.kind, 'Published');
  assert.equal(first.published[0]?.disposition, 'CreatedNew');
  assert.equal(second.published[0]?.disposition, 'AlreadyPresent');
  assert.equal(second.published[0]?.issue.issueId, first.published[0]?.issue.issueId);
  assert.equal(stub.countOf('LinearIssueCreate'), 1, 'a repeated publication issued a second create');
});

test('F10-AC3 two different operations never share an issue identity', async () => {
  const provider = new PublicationProvider('op_alpha', 'EGA-700');
  const { adapter } = adapterWith(provider.responders());
  const first = await okOf(adapter.publishWork(adapterContext('op_alpha'), publishWorkRequest('op_alpha')));
  const second = await okOf(adapter.publishWork(adapterContext('op_beta'), publishWorkRequest('op_beta')));
  assert.deepEqual(provider.createdIds, [publicationIssueId('op_alpha'), publicationIssueId('op_beta')]);
  assert.notEqual(second.published[0]?.issue.issueId, first.published[0]?.issue.issueId);
});

test('F10-AC3 a relation identity is derived from the operation and the dependency', () => {
  assert.equal(publicationRelationId('op_1', 'dep_a'), publicationRelationId('op_1', 'dep_a'));
  assert.notEqual(publicationRelationId('op_1', 'dep_a'), publicationRelationId('op_1', 'dep_b'));
});

test('F10-AC2 a dependency that cannot be resolved is reported and the rest stays published', async () => {
  const provider = new PublicationProvider('op_partial', 'EGA-700');
  provider.resolvableDependencies = false;
  const { adapter, stub } = adapterWith(provider.responders());
  const outcome = await okOf(adapter.publishWork(adapterContext('op_partial'), publishWorkRequest('op_partial')));
  assert.equal(outcome.kind, 'PartiallyPublished');
  if (outcome.kind !== 'PartiallyPublished') return;
  assert.equal(outcome.recoverable, true);
  assert.equal(outcome.failed.length, FIXTURE_PROPOSAL_REVISION.dependencyIssueIds.length);
  assert.match(outcome.failed[0]?.target ?? '', /^linear:issueRelation:/);
  assert.equal(outcome.failed[0]?.error.code, 'NotFound');
  assert.equal(outcome.published[0]?.disposition, 'CreatedNew');
  assert.equal(stub.countOf('LinearIssueCreate'), 1);
});

test('F10-AC2 a retry of the same operation finishes what a partial publication left unlinked', async () => {
  const provider = new PublicationProvider('op_recover', 'EGA-701');
  provider.resolvableDependencies = false;
  const { adapter, stub } = adapterWith(provider.responders());
  const partial = await okOf(adapter.publishWork(adapterContext('op_recover'), publishWorkRequest('op_recover')));
  assert.equal(partial.kind, 'PartiallyPublished');
  assert.equal(stub.countOf('LinearIssueCreate'), 1);
  assert.equal(stub.countOf('LinearRelationCreate'), 0);

  provider.resolvableDependencies = true;
  const recovered = await okOf(adapter.publishWork(adapterContext('op_recover'), publishWorkRequest('op_recover')));
  assert.equal(recovered.kind, 'Published', 'the retry did not finish the remaining work');
  assert.equal(stub.countOf('LinearIssueCreate'), 1, 'the retry created a second issue');
  assert.equal(stub.countOf('LinearRelationCreate'), 1, 'the failed link was never retried');
});

test('F10-AC4 the snapshot a publication reports comes from the provider, not from the proposal', async () => {
  const provider = new PublicationProvider('op_snapshot', 'EGA-702');
  const { adapter } = adapterWith(provider.responders());
  const outcome = await okOf(adapter.publishWork(adapterContext('op_snapshot'), publishWorkRequest('op_snapshot')));
  assert.equal(outcome.kind, 'Published');
  assert.deepEqual(
    [...(outcome.published[0]?.snapshot.dependencyIssueIds ?? [])],
    [DEPENDENCY_UUID],
    'the snapshot did not report the link the provider accepted',
  );
  assert.equal(
    outcome.published[0]?.snapshot.acceptanceCriteria.length,
    FIXTURE_PROPOSAL_REVISION.criteria.length,
    'the published criteria did not survive the round trip through the provider',
  );
});

test('F29-AC5 a create the provider reports as unsuccessful is not reported as published', async () => {
  const provider = new PublicationProvider('op_not_created', 'EGA-703');
  provider.createReportsSuccess = false;
  const { adapter } = adapterWith(provider.responders());
  const error = await errorOf(adapter.publishWork(adapterContext('op_not_created'), publishWorkRequest('op_not_created')));
  assert.notEqual(error.code, 'Published');
});

test('F11-AC3 adoption verifies the live issue and reports the provider snapshot', async () => {
  const { adapter } = adapterWith({ LinearIssueScope: scopeResponder({ [OTHER_UUID]: SCOPE_ISSUE }) });
  const outcome = await okOf(
    adapter.publishWork(adapterContext('op_adopt'), {
      ...publishWorkRequest('op_adopt'),
      adoptExistingIssueId: OTHER_UUID as ProviderId,
    }),
  );
  assert.equal(outcome.kind, 'AdoptedExisting');
  assert.equal(outcome.published[0]?.disposition, 'AlreadyPresent');
  assert.equal(outcome.published[0]?.issue.issueId, SCOPE_ISSUE_UUID);
  assert.equal(outcome.published[0]?.snapshot.description, CRITERIA_REGION);
});

test('F11-AC3 adoption refuses a wrong-provider identity rather than looking for a namesake', async () => {
  const { adapter, stub } = adapterWith({});
  const error = await errorOf(
    adapter.publishWork(adapterContext('op_adopt_foreign'), {
      ...publishWorkRequest('op_adopt_foreign'),
      adoptExistingIssueId: providerId('repo_fixture_01'),
    }),
  );
  assert.equal(error.code, 'Forbidden');
  assert.equal(stub.calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* F16-AC2, F16-AC3: managed progress                                          */
/* -------------------------------------------------------------------------- */

const DELIVERED_AT = '2026-09-30T12:00:00.000Z';

/**
 * A managed comment as a previous delivery left it.
 *
 * Written through the adapter's own marker writer rather than a literal, so this
 * fixture cannot drift away from the format the adapter reads back.
 */
const MANAGED_BODY = `${managedMarkerLine({
  issueId: SCOPE_ISSUE_UUID,
  operationId: 'op_first',
  milestoneKey: 'first',
  digest: 'd',
  deliveredAt: DELIVERED_AT,
})}\nDraft linked.`;

/** A managed-progress request against a real Linear identity, with no region pinned yet. */
function firstDelivery(operation: string, milestoneKey = 'Draft linked'): ManagedProgressUpdateRequest {
  return {
    operationId: operationId(operation),
    issueId: providerId(SCOPE_ISSUE_UUID),
    region: { kind: 'AppendOnlyCommentThread', lastCommentId: null },
    milestoneKey,
    body: 'Draft linked and checks running.',
    observedAt: DELIVERED_AT,
  };
}

interface StubComment {
  id: string;
  body: string;
}

function progressProvider(options: {
  readonly existing: readonly StubComment[];
}): { readonly responders: Record<string, Responder>; readonly comments: StubComment[] } {
  const comments: StubComment[] = options.existing.map((entry) => ({ ...entry }));
  const issue = (): StubIssueFields => ({ ...SCOPE_ISSUE, comments });
  return {
    comments,
    responders: {
      LinearIssueScope: () => data({ issue: stubIssuePayload(issue()) }),
      LinearCommentCreate: (variables) => {
        const input = variables['input'] as { readonly id: string; readonly body: string };
        comments.push({ id: input.id, body: input.body });
        return data({ commentCreate: { success: true, comment: { id: input.id, body: input.body } } });
      },
      LinearCommentUpdate: (variables) => {
        const id = String(variables['id']);
        const input = variables['input'] as { readonly body: string };
        const found = comments.find((entry) => entry.id === id);
        if (found !== undefined) found.body = input.body;
        return data({ commentUpdate: { success: true, comment: { id, body: input.body } } });
      },
    },
  };
}

test('F16-AC3 the comment identity one delivery owns is derived from its operation', () => {
  assert.equal(managedCommentId('op_1'), managedCommentId('op_1'));
  assert.notEqual(managedCommentId('op_1'), managedCommentId('op_2'));
});

test('F16-AC2 the first delivery creates one dedicated comment with a client-supplied identity', async () => {
  const provider = progressProvider({ existing: [] });
  const { adapter, stub } = adapterWith(provider.responders);
  const request = firstDelivery('op_first');
  const outcome: ManagedProgressOutcome = await okOf(adapter.updateManagedProgress(adapterContext('op_first'), request));
  assert.equal(outcome.kind, 'Updated');
  assert.equal(outcome.kind, 'Updated');
  assert.equal(outcome.previousMilestoneKey, null);
  const create = stub.variablesFor('LinearCommentCreate')?.['input'] as { readonly id: string; readonly body: string };
  assert.equal(create.id, managedCommentId('op_first'), 'the comment identity was chosen at random rather than derived');
  assert.match(create.body, /<!--shiploop:managed:v1 /);
});

test('F16-AC3 a repeated milestone produces no second comment and no second write', async () => {
  const provider = progressProvider({ existing: [] });
  const { adapter, stub } = adapterWith(provider.responders);
  const request = firstDelivery('op_milestone');
  const first = await okOf(adapter.updateManagedProgress(adapterContext('op_milestone'), request));
  const second = await okOf(adapter.updateManagedProgress(adapterContext('op_milestone'), request));
  assert.equal(first.kind, 'Updated');
  assert.equal(second.kind, 'Unchanged');
  assert.equal(second.deliveredMilestoneKey, request.milestoneKey);
  assert.equal(provider.comments.length, 1, 'a repeated milestone produced a second comment');
  assert.equal(stub.countOf('LinearCommentCreate'), 1);
});

test('F30-AC2 a replayed delivery identity is not delivered again, whatever milestone it now carries', async () => {
  const provider = progressProvider({ existing: [] });
  const { adapter, stub } = adapterWith(provider.responders);
  const first = firstDelivery('op_replay', 'Draft linked');
  await okOf(adapter.updateManagedProgress(adapterContext('op_replay'), first));
  const replayed = await okOf(
    adapter.updateManagedProgress(adapterContext('op_replay'), { ...first, milestoneKey: 'Checks running', body: 'different' }),
  );
  assert.equal(replayed.kind, 'Unchanged');
  assert.equal(replayed.deliveredMilestoneKey, 'Draft linked', 'a replay claimed a milestone that was never delivered');
  assert.equal(stub.countOf('LinearCommentUpdate'), 0);
});

test('F16-AC3 an unchanged body is not republished under a new milestone key', async () => {
  const provider = progressProvider({ existing: [] });
  const { adapter, stub } = adapterWith(provider.responders);
  const request = firstDelivery('op_digest', 'Draft linked');
  await okOf(adapter.updateManagedProgress(adapterContext('op_digest'), request));

  const outcome = await okOf(
    adapter.updateManagedProgress(adapterContext('op_digest'), {
      ...request,
      operationId: operationId('op_digest_retry'),
      milestoneKey: 'Checks running',
    }),
  );
  assert.equal(outcome.kind, 'Unchanged');
  assert.equal(outcome.deliveredMilestoneKey, 'Draft linked', 'the unchanged republish claimed a milestone it never delivered');
  assert.equal(stub.countOf('LinearCommentUpdate'), 0, 'an unchanged republish still wrote');
});

test('F16-AC2 a human comment is never the managed region and is left untouched', async () => {
  const human = { id: 'human-1', body: 'Please review the wording.' };
  const provider = progressProvider({ existing: [human, { id: COMMENT_UUID, body: MANAGED_BODY }] });
  const { adapter, stub } = adapterWith(provider.responders);
  const request = {
    ...firstDelivery('op_human', 'Checks running'),
    region: { kind: 'AppendOnlyCommentThread' as const, lastCommentId: null },
  };
  const outcome = await okOf(adapter.updateManagedProgress(adapterContext('op_human'), request));
  assert.equal(outcome.kind, 'Updated');
  assert.equal(outcome.region.kind, 'UpdatableComment');
  assert.notEqual(outcome.region.kind === 'UpdatableComment' ? outcome.region.commentId : null, 'human-1');
  assert.equal(provider.comments.find((entry) => entry.id === 'human-1')?.body, human.body);
  assert.equal(stub.countOf('LinearCommentUpdate'), 1, 'more than one comment was rewritten');
});

test('F16-AC2 a description-block region is refused, because Linear cannot update part of a description', async () => {
  const { adapter, stub } = adapterWith({});
  const error = await errorOf(
    adapter.updateManagedProgress(adapterContext('op_block'), {
      ...firstDelivery('op_block'),
      region: { kind: 'ManagedBodyBlock', blockId: 'criteria' },
    }),
  );
  assert.equal(error.code, 'Unavailable');
  assert.match(error.reason, /F16-AC2/);
  assert.equal(stub.calls.length, 0);
});

test('F16-AC3 a managed comment the read did not observe is reported, not replaced by a second comment', async () => {
  const provider = progressProvider({ existing: [{ id: COMMENT_UUID, body: MANAGED_BODY }] });
  const { adapter, stub } = adapterWith(provider.responders);
  const error = await errorOf(
    adapter.updateManagedProgress(adapterContext('op_unobserved'), {
      ...firstDelivery('op_unobserved'),
      region: { kind: 'UpdatableComment', commentId: providerId('comment-not-in-page') },
    }),
  );
  assert.equal(error.code, 'Unavailable');
  assert.equal(stub.countOf('LinearCommentCreate'), 0, 'an unreadable comment was worked around by creating another');
});

test('F16-AC3 a thread region that names a comment the read did not observe is refused, not grown into a second comment', async () => {
  // A previous read saw a populated thread and recorded its newest comment. If this
  // read's page no longer contains the managed comment, creating one here is how a
  // second managed region appears on the issue.
  const provider = progressProvider({ existing: [{ id: 'human-2', body: 'A later human comment.' }] });
  const { adapter, stub } = adapterWith(provider.responders);
  const error = await errorOf(
    adapter.updateManagedProgress(adapterContext('op_thread_unobserved'), {
      ...firstDelivery('op_thread_unobserved'),
      region: { kind: 'AppendOnlyCommentThread', lastCommentId: providerId('human-2') },
    }),
  );
  assert.equal(error.code, 'Unavailable');
  assert.match(error.reason, /was not observed/);
  assert.equal(stub.countOf('LinearCommentCreate'), 0, 'an unreadable thread was worked around by creating a comment');
});

test('F16-AC2 an empty thread region is the shape that may create the first managed comment', async () => {
  const provider = progressProvider({ existing: [] });
  const { adapter, stub } = adapterWith(provider.responders);
  const outcome = await okOf(
    adapter.updateManagedProgress(adapterContext('op_empty_thread'), {
      ...firstDelivery('op_empty_thread'),
      region: { kind: 'AppendOnlyCommentThread', lastCommentId: null },
    }),
  );
  assert.equal(outcome.kind, 'Updated');
  assert.equal(stub.countOf('LinearCommentCreate'), 1);
});

/* -------------------------------------------------------------------------- */
/* F29-AC3: transitions                                                         */
/* -------------------------------------------------------------------------- */

const TRANSITION_STATES = [
  { id: 'state-todo', name: 'Todo', type: 'unstarted' },
  { id: 'state-progress', name: 'In Progress', type: 'started' },
  { id: 'state-done', name: 'Done', type: 'completed' },
];

function transitionResponders(overrides: Readonly<Record<string, Responder>> = {}): Record<string, Responder> {
  return {
    LinearIssueTeam: () => data({ issue: { id: SCOPE_ISSUE_UUID, identifier: 'EGA-664', team: { id: 'team-ega', key: 'EGA' } } }),
    LinearWorkflowStates: () => data({ workflowStates: { nodes: TRANSITION_STATES } }),
    ...overrides,
  };
}

test('F29-AC3 the declared transitions are workflow states, not free-form state text', async () => {
  const { adapter } = adapterWith(transitionResponders());
  const transitions = await okOf(adapter.describeTransitions(adapterContext('op_transitions'), { issueId: providerId(SCOPE_ISSUE_UUID) }));
  const done = transitions.find((entry) => entry.toState === 'Done');
  assert.equal(done?.transitionId, 'state-done');
  assert.equal(done?.terminal, 'Done');
  assert.ok(!(done?.fromStates ?? []).includes('Done'));
  assert.deepEqual(transitions.map((entry) => entry.terminal), ['None', 'None', 'Done']);
});

test('F29-AC3 a duplicate state type is mapped as closed without delivery, never as Done', async () => {
  const { adapter } = adapterWith(
    transitionResponders({
      LinearWorkflowStates: () =>
        data({ workflowStates: { nodes: [{ id: 'state-dup', name: 'Duplicate', type: 'duplicate' }] } }),
    }),
  );
  const transitions = await okOf(adapter.describeTransitions(adapterContext('op_dup'), { issueId: providerId(SCOPE_ISSUE_UUID) }));
  assert.equal(transitions[0]?.terminal, 'Cancelled');
});

test('F29-AC3 a transition identity the adapter never offered is Invalid, not applied', async () => {
  const { adapter, stub } = adapterWith(transitionResponders());
  const error = await errorOf(
    adapter.requestTransition(adapterContext('op_unknown_transition'), {
      ...ticketTransitionRequest('op_unknown_transition'),
      issueId: providerId(SCOPE_ISSUE_UUID),
      transitionId: 'state-made-up',
    }),
  );
  assert.equal(error.code, 'Invalid');
  assert.equal(error.code === 'Invalid' ? error.fields[0]?.path : null, 'transitionId');
  assert.equal(stub.countOf('LinearIssueUpdate'), 0);
});

test('F12-AC2 a transition is refused as Conflict when the issue moved before the write', async () => {
  let state = { id: 'state-review', name: 'In Review', type: 'started' };
  const { adapter, stub } = adapterWith(
    transitionResponders({
      LinearIssueScope: () => data({ issue: stubIssuePayload({ ...SCOPE_ISSUE, state }) }),
    }),
  );
  state = { id: 'state-review', name: 'In Review', type: 'started' };
  const error = await errorOf(
    adapter.requestTransition(adapterContext('op_moved'), {
      ...ticketTransitionRequest('op_moved'),
      issueId: providerId(SCOPE_ISSUE_UUID),
      transitionId: 'state-done',
      expectedState: { kind: 'ProviderState', name: 'In Progress', terminal: 'None' },
    }),
  );
  assert.equal(error.code, 'Conflict');
  assert.equal(error.code === 'Conflict' ? error.expected : null, 'In Progress');
  assert.equal(error.code === 'Conflict' ? error.actual : null, 'In Review');
  assert.equal(stub.countOf('LinearIssueUpdate'), 0);
});

test('F29-AC3 an issue already in the requested state reports AlreadyInState and performs no write', async () => {
  const { adapter, stub } = adapterWith(
    transitionResponders({
      LinearIssueScope: () => data({ issue: stubIssuePayload({ ...SCOPE_ISSUE, state: DONE_STATE }) }),
    }),
  );
  const outcome = await okOf(
    adapter.requestTransition(adapterContext('op_already'), {
      ...ticketTransitionRequest('op_already'),
      issueId: providerId(SCOPE_ISSUE_UUID),
      transitionId: 'state-done',
      expectedState: null,
    }),
  );
  assert.equal(outcome.kind, 'AlreadyInState');
  assert.equal(stub.countOf('LinearIssueUpdate'), 0);
});

test('F29-AC3 a landing state the provider does not hold is a Conflict, not a success', async () => {
  const { adapter } = adapterWith(
    transitionResponders({
      LinearIssueScope: (_variables, index) =>
        index === 0
          ? data({ issue: stubIssuePayload({ ...SCOPE_ISSUE, state: STARTED_STATE }) })
          : data({ issue: stubIssuePayload({ ...SCOPE_ISSUE, state: STARTED_STATE }) }),
      LinearIssueUpdate: () => data({ issueUpdate: { success: true, issue: { id: SCOPE_ISSUE_UUID, identifier: 'EGA-664' } } }),
    }),
  );
  const error = await errorOf(
    adapter.requestTransition(adapterContext('op_landing'), {
      ...ticketTransitionRequest('op_landing'),
      issueId: providerId(SCOPE_ISSUE_UUID),
      transitionId: 'state-done',
      expectedState: null,
    }),
  );
  assert.equal(error.code, 'Conflict');
  assert.match(error.reason, /no expected-state precondition/);
});

test('F30-AC5 a state change the provider reports as unsuccessful is OutcomeUnknown', async () => {
  const { adapter } = adapterWith(
    transitionResponders({
      LinearIssueScope: () => data({ issue: stubIssuePayload({ ...SCOPE_ISSUE, state: STARTED_STATE }) }),
      LinearIssueUpdate: () => data({ issueUpdate: { success: false, issue: null } }),
    }),
  );
  const error = await errorOf(
    adapter.requestTransition(adapterContext('op_not_applied'), {
      ...ticketTransitionRequest('op_not_applied'),
      issueId: providerId(SCOPE_ISSUE_UUID),
      transitionId: 'state-done',
      expectedState: null,
    }),
  );
  assert.equal(error.code, 'OutcomeUnknown');
  assert.equal(error.code === 'OutcomeUnknown' ? error.operationId : null, 'op_not_applied');
});

test('F29-AC3 a transition that lands is confirmed by re-reading the provider', async () => {
  let state: StubIssueFields['state'] = STARTED_STATE;
  const { adapter, stub } = adapterWith(
    transitionResponders({
      LinearIssueScope: () => data({ issue: stubIssuePayload({ ...SCOPE_ISSUE, state }) }),
      LinearIssueUpdate: () => {
        state = DONE_STATE;
        return data({ issueUpdate: { success: true, issue: { id: SCOPE_ISSUE_UUID, identifier: 'EGA-664' } } });
      },
    }),
  );
  const outcome = await okOf(
    adapter.requestTransition(adapterContext('op_landed'), {
      ...ticketTransitionRequest('op_landed'),
      issueId: providerId(SCOPE_ISSUE_UUID),
      transitionId: 'state-done',
      expectedState: { kind: 'ProviderState', name: 'In Progress', terminal: 'None' },
    }),
  );
  assert.equal(outcome.kind, 'Applied');
  assert.equal(outcome.kind === 'Applied' && outcome.from.kind === 'ProviderState' ? outcome.from.name : null, 'In Progress');
  assert.equal(outcome.kind === 'Applied' && outcome.to.kind === 'ProviderState' ? outcome.to.terminal : null, 'Done');
  assert.equal(stub.countOf('LinearIssueUpdate'), 1);
});

test('F03-AC2 the capability declaration says the operations Linear actually offers', async () => {
  const { adapter } = adapterWith({});
  const declarations = adapter.capabilities().declarations;
  const kinds = declarations.map((entry) => entry.kind);
  assert.deepEqual(kinds, [
    'Ticket:ReadScope',
    'Ticket:PublishIssue',
    'Ticket:UpdateManagedProgress',
    'Ticket:RequestTransition',
  ]);
  assert.ok(declarations.every((entry) => entry.supported), 'Linear offers all four and none should be declared unsupported');
  assert.ok(declarations.every((entry) => entry.limitation === null));
});

/* -------------------------------------------------------------------------- */
/* The contract suite's own ticket assertions, against this adapter             */
/* -------------------------------------------------------------------------- */

test('F12-AC1 a live scope read preserves criteria and dependency identity unchanged', async () => {
  const { adapter } = adapterWith({ LinearIssueScope: scopeResponder({ [SCOPE_ISSUE_UUID]: SCOPE_ISSUE }) });
  const read = await okOf(
    adapter.readScope(adapterContext('contract_scope'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }),
  );
  assert.equal(
    read.snapshot.acceptanceCriteria.length,
    2,
    'the published criteria were not read back out of the provider description',
  );
  assert.deepEqual(
    read.snapshot.acceptanceCriteria.map((criterion) => criterion.id),
    ['AC1', 'scope.preview.card'],
  );
  assert.ok(read.snapshot.dependencyIssueIds.includes(DEPENDENCY_UUID));
  assert.equal(read.observedAt.length > 0, true);
});

test('F12-AC3 re-reading an unchanged issue produces the same material fingerprint', async () => {
  const { adapter } = adapterWith({ LinearIssueScope: scopeResponder({ [SCOPE_ISSUE_UUID]: SCOPE_ISSUE }) });
  const read = async (): Promise<TicketScopeRead> =>
    okOf(adapter.readScope(adapterContext('contract_fingerprint'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(SCOPE_ISSUE_UUID) }));
  const first = await read();
  const second = await read();
  assert.equal(scopeFingerprint(first.snapshot), scopeFingerprint(second.snapshot));
  assert.equal(
    compareScope(first.snapshot, second.snapshot).kind,
    'Unchanged',
    'a re-read of untouched scope reported a change',
  );
});

test('F12-AC2 an edited criterion is material, a retitled issue is cosmetic', async () => {
  const { adapter } = adapterWith({
    LinearIssueScope: scopeResponder({
      [SCOPE_ISSUE_UUID]: SCOPE_ISSUE,
      // The retitled and re-criteried issues differ from the baseline in exactly one
      // respect each, so a comparison can attribute the change to that one field.
      [RETITLED_UUID]: {
        ...SCOPE_ISSUE,
        id: RETITLED_UUID,
        identifier: 'EGA-812',
        title: 'A completely different title',
        relations: SCOPE_ISSUE.relations ?? [],
        inverseRelations: sameRelations(SCOPE_ISSUE, RETITLED_UUID, 'EGA-812'),
      },
      [EDITED_CRITERIA_UUID]: {
        ...SCOPE_ISSUE,
        id: EDITED_CRITERIA_UUID,
        identifier: 'EGA-813',
        description: CRITERIA_REGION.replace('usable stay distinct.', 'usable states are collapsed.'),
        inverseRelations: sameRelations(SCOPE_ISSUE, EDITED_CRITERIA_UUID, 'EGA-813'),
      },
    }),
  });
  const read = (id: string): Promise<ScopeSnapshot> =>
    okOf(
      adapter.readScope(adapterContext('contract_compare'), { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(id) }),
    ).then((read) => read.snapshot);

  const recorded = await read(SCOPE_ISSUE_UUID);
  const retitled = await read(RETITLED_UUID);
  const cosmetic = compareScope(recorded, retitled);
  assert.deepEqual(cosmetic.materialDifferences, []);
  assert.deepEqual(cosmetic.cosmeticDifferences, ['title']);

  // A criterion lives inside the description in Linear, so editing one necessarily edits
  // the description too. Both differences are therefore material and both are reported:
  // collapsing them to `criteria.changed.AC1` would hide that the scope text moved.
  const edited = await read(EDITED_CRITERIA_UUID);
  const material = compareScope(recorded, edited);
  assert.equal(material.kind, 'Material');
  assert.ok(
    material.materialDifferences.includes('criteria.changed.AC1'),
    `the edited criterion was not reported as changed: ${material.materialDifferences.join(', ')}`,
  );
  assert.ok(
    material.materialDifferences.includes('description'),
    `the description that carries the criterion was not reported as changed: ${material.materialDifferences.join(', ')}`,
  );
  assert.deepEqual(material.cosmeticDifferences, []);
});

test('F03-AC1 a compatible credential reports compatibility observed from the provider, not assumed', async () => {
  const { adapter } = adapterWith({ LinearViewer: () => data({ viewer: { id: 'viewer-1', name: 'Probe' } }) });
  const compatibility = await okOf(adapter.checkCompatibility(adapterContext('contract_compat')));
  assert.equal(compatibility.compatible, true);
  assert.equal(compatibility.runtimeVersion, null, 'Linear reports no API version; one must not be invented');
  assert.equal(compatibility.contractVersion, 1);
});

test('F03-AC1 an identity answer this adapter cannot read is incompatible, not compatible by default', async () => {
  const { adapter } = adapterWith({ LinearViewer: () => data({ viewer: { name: 'Probe' } }) });
  const compatibility = await okOf(adapter.checkCompatibility(adapterContext('contract_unreadable')));
  assert.equal(compatibility.compatible, false);
  assert.match(compatibility.detail, /unproven/);
});

/* -------------------------------------------------------------------------- */
/* Opt-in live exercise                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A read-only exercise against a real workspace.
 *
 * Opt-in because it needs `LINEAR_API_KEY` and spends the workspace's request budget.
 * It creates, updates and deletes nothing, and `README.md` records the run that
 * happened. The skip reason names the missing prerequisite rather than hiding behind a
 * boolean.
 */
test('N05-AC2 a live read-only pass reads identity, one issue and its related work', async (t) => {
  const apiKey = process.env['LINEAR_API_KEY'];
  const issueRef = process.env['SHIPLOOP_LINEAR_LIVE_ISSUE'];
  if (apiKey === undefined || apiKey.length === 0) {
    t.skip('no LINEAR_API_KEY in the environment; the live pass needs a real credential');
    return;
  }
  if (issueRef === undefined || issueRef.length === 0) {
    t.skip('no SHIPLOOP_LINEAR_LIVE_ISSUE; name a Linear issue identifier, such as a team-relative one, to read');
    return;
  }

  const adapter = new LinearTicketAdapter({ connectorId: connectorId('connector_linear_live'), client: { apiKey } });
  const context: AdapterContext = { ...adapterContext('op_linear_live'), signal: AbortSignal.timeout(30_000) };
  const compatibility = await okOf(adapter.checkCompatibility(context));
  assert.equal(compatibility.compatible, true);

  const read = await okOf(
    adapter.readScope(context, { workItemId: FIXTURE_WORK_ITEM_ID, issueId: providerId(issueRef) }),
  );
  assert.match(read.issue.issueId, /^[0-9a-f-]{36}$/);
  const related = await okOf(
    adapter.findRelatedIssues(context, { workItemId: FIXTURE_WORK_ITEM_ID, scope: read.snapshot, limit: 5 }),
  );
  assert.ok(related.every((entry) => entry.adoption.kind === 'RequiresOwnerDecision'));
  assert.ok(!related.some((entry) => entry.issue.issueId === read.issue.issueId), 'the scope issue was offered as its own related work');
});