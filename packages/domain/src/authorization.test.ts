import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  checkAuthorization,
  subjectFingerprint,
  type AuthorizationRejection,
  type AuthorizationSubject,
  type OwnerAuthorization,
} from './authorization.ts';
import { fingerprint } from './fingerprint.ts';
import type { Fingerprint } from './ids.ts';

/**
 * Authorization is permission for one exact external action, so the subject
 * fingerprint is the whole safety property: if any authorized fact changes, the
 * approval stops matching and the write is refused before it happens.
 */

const OWNER = 'owner_1' as OwnerAuthorization['ownerId'];
const OTHER_OWNER = 'owner_2' as OwnerAuthorization['ownerId'];
const NOW = '2026-03-04T12:00:00.000Z';
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BASE_SHA = 'f0e9d8c7b6a5948372615f4e3d2c1b0a99887766';

const CANDIDATE: Fingerprint = fingerprint({ candidate: 'release-2026.03.04' });
const REPLACEMENT_CANDIDATE: Fingerprint = fingerprint({ candidate: 'release-2026.03.05' });

const SUBJECT: AuthorizationSubject = {
  action: { kind: 'Merge', mergeMethod: 'Squash' },
  destination: 'github.com:acme/web',
  pullRequestId: 'pr_101',
  headSha: HEAD_SHA,
  targetBranch: 'main',
  candidateFingerprint: CANDIDATE,
  componentDeployments: [
    { component: 'web', deploymentId: 'dep_web_1' },
    { component: 'api', deploymentId: 'dep_api_1' },
  ],
};

function authorizationFor(subject: AuthorizationSubject, overrides: Partial<OwnerAuthorization> = {}): OwnerAuthorization {
  return {
    authorizationId: 'auth_1',
    ownerId: OWNER,
    issuedAt: '2026-03-04T11:00:00.000Z',
    subject,
    subjectFingerprint: subjectFingerprint(subject),
    state: 'Authorized',
    consumedAt: null,
    invalidatedReason: null,
    singleUse: true,
    ...overrides,
  };
}

function check(
  authorization: OwnerAuthorization,
  proposed: AuthorizationSubject = authorization.subject,
  ownerId: OwnerAuthorization['ownerId'] = OWNER,
): ReturnType<typeof checkAuthorization> {
  return checkAuthorization({ authorization, proposed, ownerId, now: NOW });
}

function rejectionOf(result: ReturnType<typeof checkAuthorization>): AuthorizationRejection {
  assert.equal(result.valid, false, 'expected the authorization to be refused');
  if (result.valid) throw new Error('unreachable: refusal expected');
  return result.rejection;
}

describe('F26-AC1 subjectFingerprint', () => {
  test('is deterministic and produces a well-formed fingerprint', () => {
    const first = subjectFingerprint(SUBJECT);

    assert.equal(first, subjectFingerprint(SUBJECT));
    assert.match(first, /^fp_[0-9a-f]{32}$/);
  });

  test('changes for the action kind', () => {
    const merge = subjectFingerprint(SUBJECT);
    const release = subjectFingerprint({ ...SUBJECT, action: { kind: 'Release', destination: 'github.com:acme/web' } });

    assert.notEqual(merge, release);
  });

  test('changes for the merge method', () => {
    const squash = subjectFingerprint(SUBJECT);
    const rebase = subjectFingerprint({ ...SUBJECT, action: { kind: 'Merge', mergeMethod: 'Rebase' } });
    const commit = subjectFingerprint({ ...SUBJECT, action: { kind: 'Merge', mergeMethod: 'Merge' } });

    assert.notEqual(squash, rebase);
    assert.notEqual(squash, commit);
  });

  test('changes for the destination', () => {
    assert.notEqual(subjectFingerprint(SUBJECT), subjectFingerprint({ ...SUBJECT, destination: 'github.com:acme/api' }));
  });

  test('changes for the pull request identity', () => {
    const bound = subjectFingerprint(SUBJECT);

    assert.notEqual(bound, subjectFingerprint({ ...SUBJECT, pullRequestId: 'pr_102' }));
    assert.notEqual(bound, subjectFingerprint({ ...SUBJECT, pullRequestId: null }));
  });

  test('changes for the head sha and for the target branch', () => {
    const bound = subjectFingerprint(SUBJECT);

    assert.notEqual(bound, subjectFingerprint({ ...SUBJECT, headSha: BASE_SHA }));
    assert.notEqual(bound, subjectFingerprint({ ...SUBJECT, targetBranch: 'release/2026.03' }));
  });

  test('F27-AC3 changes for the candidate fingerprint', () => {
    assert.notEqual(subjectFingerprint(SUBJECT), subjectFingerprint({ ...SUBJECT, candidateFingerprint: REPLACEMENT_CANDIDATE }));
  });

  test('changes for any component deployment id, including removing one', () => {
    const bound = subjectFingerprint(SUBJECT);
    const changedOne = subjectFingerprint({
      ...SUBJECT,
      componentDeployments: [
        { component: 'web', deploymentId: 'dep_web_2' },
        { component: 'api', deploymentId: 'dep_api_1' },
      ],
    });
    const removedOne = subjectFingerprint({
      ...SUBJECT,
      componentDeployments: [{ component: 'web', deploymentId: 'dep_web_1' }],
    });
    const withoutId = subjectFingerprint({
      ...SUBJECT,
      componentDeployments: [
        { component: 'web', deploymentId: null },
        { component: 'api', deploymentId: 'dep_api_1' },
      ],
    });

    assert.notEqual(bound, changedOne);
    assert.notEqual(bound, removedOne);
    assert.notEqual(bound, withoutId);
  });

  test('is independent of the order components are listed in', () => {
    const reversed = {
      ...SUBJECT,
      componentDeployments: [...SUBJECT.componentDeployments].reverse(),
    };

    assert.equal(subjectFingerprint(SUBJECT), subjectFingerprint(reversed));
  });
});

describe('F26-AC2 authorization acceptance', () => {
  test('accepts a matching, unconsumed authorization issued by the right owner', () => {
    const authorization = authorizationFor(SUBJECT);
    const result = check(authorization);

    assert.equal(result.valid, true);
    if (!result.valid) throw new Error('unreachable: acceptance expected');
    assert.equal(result.authorization.authorizationId, 'auth_1');
    assert.equal(result.authorization.singleUse, true);
  });

  test('F26-AC2 refuses an authorization belonging to a different owner', () => {
    const authorization = authorizationFor(SUBJECT);
    const result = check(authorization, SUBJECT, OTHER_OWNER);

    assert.equal(rejectionOf(result), 'OwnerMismatch');
    assert.match(rejection(result), /different owner/);
  });

  test('F26-AC3 refuses an authorization that has already been consumed', () => {
    const consumed = authorizationFor(SUBJECT, { state: 'Consumed', consumedAt: NOW });

    assert.equal(rejectionOf(check(consumed)), 'AlreadyConsumed');
  });

  test('F27-AC3 refuses an invalidated authorization and surfaces the recorded reason', () => {
    const invalidated = authorizationFor(SUBJECT, { state: 'Invalidated', invalidatedReason: 'The base branch moved.' });
    const result = check(invalidated);

    assert.equal(rejectionOf(result), 'SubjectChanged');
    assert.match(rejection(result), /base branch moved/);
  });

  test('refuses an expired authorization', () => {
    const expired = authorizationFor(SUBJECT, { state: 'Expired' });

    assert.equal(rejectionOf(check(expired)), 'Expired');
  });

  test('F27-AC3 refuses a proposed subject whose fingerprint differs', () => {
    const authorization = authorizationFor(SUBJECT);
    const result = check(authorization, { ...SUBJECT, headSha: BASE_SHA });

    assert.equal(rejectionOf(result), 'SubjectChanged');
    assert.match(rejection(result), /candidate, destination, target or components changed/);
  });

  test('mvp-spec section 3 the decision has no acceptance field, so acceptance alone can never authorize', () => {
    const input = {
      authorization: authorizationFor(SUBJECT),
      ownerId: OWNER,
      proposed: SUBJECT,
      now: NOW,
    };

    assert.deepEqual(Object.keys(input).sort(), ['authorization', 'now', 'ownerId', 'proposed']);
  });
});

describe('F26-AC3 and F27-AC3 single use', () => {
  test('an authorization is single use: a second check of the consumed record is refused', () => {
    const authorized = authorizationFor(SUBJECT);
    const first = check(authorized);
    assert.equal(first.valid, true);

    const consumed: OwnerAuthorization = { ...authorized, state: 'Consumed', consumedAt: NOW };
    assert.equal(rejectionOf(check(consumed)), 'AlreadyConsumed');
  });

  test('F27-AC3 changing the candidate fingerprint after authorization invalidates the old decision', () => {
    const authorization = authorizationFor(SUBJECT);
    const replacement: AuthorizationSubject = { ...SUBJECT, candidateFingerprint: REPLACEMENT_CANDIDATE };
    const result = check(authorization, replacement);

    assert.equal(rejectionOf(result), 'SubjectChanged');
  });

  test('F27-AC3 changing the destination after authorization invalidates the old decision', () => {
    const authorization = authorizationFor(SUBJECT);
    const moved: AuthorizationSubject = { ...SUBJECT, destination: 'github.com:acme/api' };

    assert.equal(rejectionOf(check(authorization, moved)), 'SubjectChanged');
  });
});

function rejection(result: ReturnType<typeof checkAuthorization>): string {
  assert.equal(result.valid, false, 'expected the authorization to be refused');
  if (result.valid) throw new Error('unreachable: refusal expected');
  return result.reason;
}