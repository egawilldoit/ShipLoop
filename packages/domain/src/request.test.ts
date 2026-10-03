import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAXIMUM_REQUEST_TITLE_LENGTH,
  createRequest,
  isUntouchedRequest,
  updateRequest,
  type ProjectId,
  type RequestId,
} from './index.ts';

const PROJECT = 'acme' as ProjectId;
const REQUEST = 'req_1' as RequestId;

function draft(overrides: Partial<Parameters<typeof createRequest>[0]> = {}) {
  const created = createRequest({
    requestId: REQUEST,
    projectId: PROJECT,
    title: 'Checkout totals',
    description: 'The order summary shows the pre-tax total.',
    at: '2026-03-01T10:00:00.000Z',
    ...overrides,
  });
  assert.ok(created.ok, created.ok ? '' : created.error.reason);
  return created.value;
}

test('a request carries the project, the title, the description and both instants', () => {
  const request = draft();
  assert.equal(request.requestId, REQUEST);
  assert.equal(request.projectId, PROJECT);
  assert.equal(request.title, 'Checkout totals');
  assert.equal(request.description, 'The order summary shows the pre-tax total.');
  assert.equal(request.createdAt, '2026-03-01T10:00:00.000Z');
  assert.equal(request.updatedAt, request.createdAt);
  assert.equal(request.sourceIdeaId, null);
});

test('a request needs no engine, no provider and no project configuration to exist', () => {
  // The whole function is a value transition over its four inputs. Creating a request
  // must not depend on anything a deployment may have configured (MVP: no AI engine
  // may be required to create or read a request).
  const parameters = createRequest.length;
  assert.equal(parameters, 1);
  assert.ok(draft().requestId);
});

test('a blank title or description is refused and names the field', () => {
  const blank = createRequest({
    requestId: REQUEST,
    projectId: PROJECT,
    title: '   ',
    description: '',
    at: '2026-03-01T10:00:00.000Z',
  });
  assert.ok(!blank.ok);
  const paths = blank.error.code === 'Invalid' ? blank.error.fields.map((field) => field.path) : [];
  assert.deepEqual(paths.sort(), ['description', 'title']);
});

test('a request with no project is refused, because a contract binds to a project', () => {
  const projectless = createRequest({
    requestId: REQUEST,
    projectId: '  ' as ProjectId,
    title: 'Checkout totals',
    description: 'The summary shows the pre-tax total.',
    at: '2026-03-01T10:00:00.000Z',
  });
  assert.ok(!projectless.ok);
  assert.equal(projectless.error.code, 'Invalid');
});

test('an over-long title is refused with the bound it exceeded', () => {
  const long = createRequest({
    requestId: REQUEST,
    projectId: PROJECT,
    title: 'x'.repeat(MAXIMUM_REQUEST_TITLE_LENGTH + 1),
    description: 'Something should change.',
    at: '2026-03-01T10:00:00.000Z',
  });
  assert.ok(!long.ok);
  assert.equal(long.error.code === 'Invalid' && long.error.fields[0]?.path, 'title');
});

test('an edit returns a new value and moves updatedAt without touching createdAt', () => {
  const request = draft();
  const edited = updateRequest(
    request,
    { description: 'The order summary shows the total including tax.' },
    { expectedUpdatedAt: request.updatedAt, at: '2026-03-02T09:00:00.000Z' },
  );
  assert.ok(edited.ok, edited.ok ? '' : edited.error.reason);
  assert.notEqual(edited.value, request);
  assert.equal(edited.value.createdAt, '2026-03-01T10:00:00.000Z');
  assert.equal(edited.value.updatedAt, '2026-03-02T09:00:00.000Z');
  // The prior value is untouched, so a stale client holding it cannot make the stored
  // record describe something the owner did not type.
  assert.equal(request.description, 'The order summary shows the pre-tax total.');
  assert.equal(request.updatedAt, '2026-03-01T10:00:00.000Z');
  assert.equal(isUntouchedRequest(request), true);
  assert.equal(isUntouchedRequest(edited.value), false);
});

test('an edit against a stale read is a conflict carrying both instants', () => {
  const request = draft();
  const conflicted = updateRequest(request, { title: 'Checkout totals v2' }, {
    expectedUpdatedAt: '2026-02-01T00:00:00.000Z',
    at: '2026-03-02T09:00:00.000Z',
  });
  assert.ok(!conflicted.ok);
  assert.equal(conflicted.error.code, 'Conflict');
  if (conflicted.error.code !== 'Conflict') return;
  assert.equal(conflicted.error.expected, '2026-02-01T00:00:00.000Z');
  assert.equal(conflicted.error.actual, request.updatedAt);
});

test('an edit that changes nothing is refused rather than reported as a save', () => {
  const request = draft();
  const noop = updateRequest(request, { title: 'Checkout totals' }, {
    expectedUpdatedAt: request.updatedAt,
    at: '2026-03-02T09:00:00.000Z',
  });
  assert.ok(!noop.ok);
  assert.equal(noop.error.code, 'Invalid');
});

test('an edit that would blank a field is refused before anything is written', () => {
  const request = draft();
  const blanked = updateRequest(request, { description: '   ' }, {
    expectedUpdatedAt: request.updatedAt,
    at: '2026-03-02T09:00:00.000Z',
  });
  assert.ok(!blanked.ok);
  assert.equal(request.description, 'The order summary shows the pre-tax total.');
});

test('a promoted request records the idea it came from as one-way provenance', () => {
  const promoted = draft({ sourceIdeaId: 'idea_7' });
  assert.equal(promoted.sourceIdeaId, 'idea_7');
  // Nothing reads the idea back to answer for the request: the request keeps its own text.
  assert.equal(promoted.description, 'The order summary shows the pre-tax total.');
});