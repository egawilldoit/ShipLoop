/**
 * Regression proof for candidate identity and staleness.
 *
 * A candidate fingerprint is what prevents one approval from being spent on
 * different work (F20-AC3, F22-AC5, F24-AC4, F25-AC3, F26, F27-AC3). These tests
 * fix the seven identity inputs and change exactly one at a time, so a field
 * dropped from the fingerprint fails here rather than silently widening
 * eligibility.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  CandidateIdentity,
  CandidateIdentityInput,
  ComponentIdentity,
  StaleReason,
} from './candidate.ts';
import { assessStaleness, candidateFingerprint } from './candidate.ts';
import { asCommitSha, asFingerprint, isCommitSha } from './ids.ts';
import type { CommitSha, Fingerprint } from './ids.ts';

const HEAD: CommitSha = asCommitSha('0123456789abcdef0123456789abcdef01234567');
const OTHER_HEAD: CommitSha = asCommitSha('fedcba9876543210fedcba9876543210fedcba98');
const BASE: CommitSha = asCommitSha('89abcdef0123456789abcdef0123456789abcdef');
const OTHER_BASE: CommitSha = asCommitSha('00112233445566778899aabbccddeeff00112233');

const SCOPE: Fingerprint = asFingerprint('fp_0123456789abcdef0123456789abcdef');
const OTHER_SCOPE: Fingerprint = asFingerprint('fp_fedcba9876543210fedcba9876543210');
const ENVIRONMENT: Fingerprint = asFingerprint('fp_11112222333344445555666677778888');
const OTHER_ENVIRONMENT: Fingerprint = asFingerprint('fp_9999aaaabbbbccccddddeeeeffff0000');
const POLICY: Fingerprint = asFingerprint('fp_0f0e0d0c0b0a09080706050403020100');
const OTHER_POLICY: Fingerprint = asFingerprint('fp_a1b2c3d4e5f60718293a4b5c6d7e8f90');

const WEB: ComponentIdentity = {
  component: 'web',
  deploymentId: 'dep-web-0001',
  deploymentUrl: 'https://preview.example.test/dep-web-0001',
  environment: 'preview',
};
const API: ComponentIdentity = {
  component: 'api',
  deploymentId: null,
  deploymentUrl: null,
  environment: 'preview',
};
const WORKER: ComponentIdentity = {
  component: 'worker',
  deploymentId: 'dep-worker-0007',
  deploymentUrl: 'https://preview.example.test/dep-worker-0007',
  environment: 'preview',
};

const COMPONENTS: readonly ComponentIdentity[] = [WEB, API];

const IDENTITY: CandidateIdentityInput = {
  headSha: HEAD,
  baseSha: BASE,
  scopeFingerprint: SCOPE,
  profileVersionId: 'profile-version-1',
  procedureVersionId: 'procedure-version-1',
  environmentFingerprint: ENVIRONMENT,
  policyFingerprint: POLICY,
  components: COMPONENTS,
};

const RECORDED: CandidateIdentity = { ...IDENTITY, components: COMPONENTS };

/** One identity input changed in isolation, with the field name and reason for the test title. */
interface IdentityVariant {
  readonly field: string;
  readonly reason: StaleReason;
  readonly identity: CandidateIdentityInput;
}

const SINGLE_INPUT_VARIANTS: readonly IdentityVariant[] = [
  { field: 'headSha', reason: 'HeadChanged', identity: { ...IDENTITY, headSha: OTHER_HEAD } },
  { field: 'baseSha', reason: 'BaseChanged', identity: { ...IDENTITY, baseSha: OTHER_BASE } },
  { field: 'scopeFingerprint', reason: 'ScopeChanged', identity: { ...IDENTITY, scopeFingerprint: OTHER_SCOPE } },
  {
    field: 'profileVersionId',
    reason: 'ProfileVersionChanged',
    identity: { ...IDENTITY, profileVersionId: 'profile-version-2' },
  },
  {
    field: 'procedureVersionId',
    reason: 'ProcedureVersionChanged',
    identity: { ...IDENTITY, procedureVersionId: 'procedure-version-2' },
  },
  {
    field: 'environmentFingerprint',
    reason: 'EnvironmentChanged',
    identity: { ...IDENTITY, environmentFingerprint: OTHER_ENVIRONMENT },
  },
  { field: 'policyFingerprint', reason: 'PolicyChanged', identity: { ...IDENTITY, policyFingerprint: OTHER_POLICY } },
];

const THREE_COMPONENTS: readonly ComponentIdentity[] = [WEB, API, WORKER];

const BASE_FINGERPRINT: Fingerprint = candidateFingerprint(IDENTITY);

describe('candidate fingerprint: determinism', () => {
  test('F26/F27-AC3 - identical input always yields the same fingerprint', () => {
    assert.equal(candidateFingerprint(IDENTITY), BASE_FINGERPRINT);
    assert.equal(
      candidateFingerprint({ ...IDENTITY, components: [WEB, API] }),
      BASE_FINGERPRINT,
      'a rebuilt but equal identity must not change identity',
    );
    assert.equal(
      candidateFingerprint(IDENTITY),
      candidateFingerprint(IDENTITY),
      'repeated evaluation must be stable',
    );
  });
});

describe('candidate fingerprint: every identity input participates', () => {
  for (const variant of SINGLE_INPUT_VARIANTS) {
    test(`F20-AC3/F25-AC3/F27-AC3 - changing only ${variant.field} changes the fingerprint`, () => {
      assert.notEqual(candidateFingerprint(variant.identity), BASE_FINGERPRINT);
    });
  }

  test('F20-AC3 - seven single-input changes produce seven distinct identities', () => {
    const fingerprints = new Set(SINGLE_INPUT_VARIANTS.map((variant) => candidateFingerprint(variant.identity)));
    fingerprints.add(BASE_FINGERPRINT);
    assert.equal(fingerprints.size, SINGLE_INPUT_VARIANTS.length + 1);
  });
});

describe('candidate fingerprint: component identity', () => {
  test('F22-AC1 - component discovery order does not change the fingerprint', () => {
    const forward: CandidateIdentityInput = { ...IDENTITY, components: [WEB, API] };
    const reversed: CandidateIdentityInput = { ...IDENTITY, components: [API, WEB] };
    assert.equal(candidateFingerprint(reversed), candidateFingerprint(forward));
    assert.equal(candidateFingerprint(reversed), BASE_FINGERPRINT);
  });

  test('F22-AC5 - a new deployment identity changes the fingerprint', () => {
    const rebuilt: ComponentIdentity = { ...WEB, deploymentId: 'dep-web-0002' };
    assert.notEqual(
      candidateFingerprint({ ...IDENTITY, components: [rebuilt, API] }),
      BASE_FINGERPRINT,
    );
  });

  test('F22-AC1 - a new deployment URL changes the fingerprint', () => {
    const relocated: ComponentIdentity = { ...WEB, deploymentUrl: 'https://preview.example.test/dep-web-0009' };
    assert.notEqual(
      candidateFingerprint({ ...IDENTITY, components: [relocated, API] }),
      BASE_FINGERPRINT,
    );
  });

  test('F22-AC2 - a component moved to another environment changes the fingerprint', () => {
    const moved: ComponentIdentity = { ...WEB, environment: 'staging' };
    assert.notEqual(
      candidateFingerprint({ ...IDENTITY, components: [moved, API] }),
      BASE_FINGERPRINT,
    );
  });

  test('F22-AC4 - adding a component changes the fingerprint', () => {
    assert.notEqual(
      candidateFingerprint({ ...IDENTITY, components: [WEB, API, WORKER] }),
      BASE_FINGERPRINT,
    );
  });
});

describe('candidate staleness: unchanged identity', () => {
  test('F20-AC3 - an identical identity is not stale and has no reasons', () => {
    const assessment = assessStaleness(RECORDED, IDENTITY);
    assert.equal(assessment.stale, false);
    assert.deepEqual(assessment.reasons, []);
    assert.deepEqual(assessment.componentDetail, []);
  });

  test('F22-AC1 - reordering components is not staleness', () => {
    const assessment = assessStaleness(RECORDED, { ...IDENTITY, components: [API, WEB] });
    assert.equal(assessment.stale, false);
    assert.deepEqual(assessment.reasons, []);
  });
});

describe('candidate staleness: one specific reason per changed input', () => {
  for (const variant of SINGLE_INPUT_VARIANTS) {
    test(`F20-AC3/F25-AC3 - a changed ${variant.field} reports ${variant.reason}`, () => {
      const assessment = assessStaleness(RECORDED, variant.identity);
      assert.equal(assessment.stale, true);
      assert.deepEqual(assessment.reasons, [variant.reason]);
      assert.deepEqual(assessment.componentDetail, []);
    });
  }

  test('F22-AC5 - a replaced deployment reports DeploymentReplaced and names the component', () => {
    const rebuilt: ComponentIdentity = { ...WEB, deploymentId: 'dep-web-0002' };
    const assessment = assessStaleness(RECORDED, { ...IDENTITY, components: [rebuilt, API] });
    assert.equal(assessment.stale, true);
    assert.deepEqual(assessment.reasons, ['DeploymentReplaced']);
    assert.deepEqual(assessment.componentDetail, [{ component: 'web', reason: 'DeploymentReplaced' }]);
  });

  test('F22-AC5 - a deployment removed from a component is a replacement too', () => {
    const undeployed: ComponentIdentity = { ...WEB, deploymentId: null, deploymentUrl: null };
    const assessment = assessStaleness(RECORDED, { ...IDENTITY, components: [undeployed, API] });
    assert.deepEqual(assessment.reasons, ['DeploymentReplaced']);
    assert.deepEqual(assessment.componentDetail, [{ component: 'web', reason: 'DeploymentReplaced' }]);
  });

  test('F22-AC4 - an added component reports ComponentChanged and names the component', () => {
    const assessment = assessStaleness(RECORDED, { ...IDENTITY, components: [WEB, API, WORKER] });
    assert.equal(assessment.stale, true);
    assert.deepEqual(assessment.reasons, ['ComponentChanged']);
    assert.deepEqual(assessment.componentDetail, [{ component: 'worker', reason: 'ComponentChanged' }]);
  });

  test('F25-AC3 - a removed component reports ComponentChanged and names the component', () => {
    const assessment = assessStaleness(RECORDED, { ...IDENTITY, components: [WEB] });
    assert.equal(assessment.stale, true);
    assert.deepEqual(assessment.reasons, ['ComponentChanged']);
    assert.deepEqual(assessment.componentDetail, [{ component: 'api', reason: 'ComponentChanged' }]);
  });
});

describe('candidate staleness: every differing input, not just the first', () => {
  test('F24-AC4/F25-AC3 - a new head plus a new base plus a new policy reports all three', () => {
    const assessment = assessStaleness(RECORDED, {
      ...IDENTITY,
      headSha: OTHER_HEAD,
      baseSha: OTHER_BASE,
      policyFingerprint: OTHER_POLICY,
    });
    assert.equal(assessment.stale, true);
    assert.deepEqual(assessment.reasons, ['HeadChanged', 'BaseChanged', 'PolicyChanged']);
  });

  test('F20-AC3/F27-AC3 - every identity input can differ at once', () => {
    const assessment = assessStaleness(RECORDED, {
      ...IDENTITY,
      headSha: OTHER_HEAD,
      baseSha: OTHER_BASE,
      scopeFingerprint: OTHER_SCOPE,
      profileVersionId: 'profile-version-2',
      procedureVersionId: 'procedure-version-2',
      environmentFingerprint: OTHER_ENVIRONMENT,
      policyFingerprint: OTHER_POLICY,
    });
    assert.equal(assessment.stale, true);
    assert.deepEqual(assessment.reasons, [
      'HeadChanged',
      'BaseChanged',
      'ScopeChanged',
      'ProfileVersionChanged',
      'ProcedureVersionChanged',
      'EnvironmentChanged',
      'PolicyChanged',
    ]);
  });

  test('F22-AC5 - a replaced deployment is reported alongside a changed head', () => {
    const rebuilt: ComponentIdentity = { ...WEB, deploymentId: 'dep-web-0002' };
    const assessment = assessStaleness(RECORDED, {
      ...IDENTITY,
      headSha: OTHER_HEAD,
      components: [rebuilt, API],
    });
    assert.equal(assessment.stale, true);
    assert.deepEqual(assessment.reasons, ['HeadChanged', 'DeploymentReplaced']);
    assert.deepEqual(assessment.componentDetail, [{ component: 'web', reason: 'DeploymentReplaced' }]);
  });

  test('F22-AC4 - a replaced deployment is reported once however many components are replaced', () => {
    const rebuiltWeb: ComponentIdentity = { ...WEB, deploymentId: 'dep-web-0002' };
    const rebuiltWorker: ComponentIdentity = { ...WORKER, environment: 'staging' };
    const assessment = assessStaleness(
      { ...RECORDED, components: THREE_COMPONENTS },
      { ...IDENTITY, components: [rebuiltWeb, API, rebuiltWorker] },
    );
    assert.deepEqual(assessment.reasons, ['DeploymentReplaced']);
    assert.deepEqual(assessment.componentDetail, [
      { component: 'web', reason: 'DeploymentReplaced' },
      { component: 'worker', reason: 'DeploymentReplaced' },
    ]);
  });

  test('F22-AC4 - two added components report one ComponentChanged reason and name both', () => {
    // ComponentChanged used to be pushed without the dedup guard DeploymentReplaced
    // used, so one reason appeared twice and the reason list stopped being a set.
    const docs: ComponentIdentity = {
      component: 'docs',
      deploymentId: 'dep-docs-0002',
      deploymentUrl: 'https://preview.example.test/dep-docs-0002',
      environment: 'preview',
    };

    const assessment = assessStaleness(RECORDED, { ...IDENTITY, components: [WEB, API, WORKER, docs] });

    assert.equal(assessment.stale, true);
    assert.deepEqual(assessment.reasons, ['ComponentChanged']);
    assert.equal(assessment.reasons.filter((reason) => reason === 'ComponentChanged').length, 1);
    assert.deepEqual(assessment.componentDetail, [
      { component: 'worker', reason: 'ComponentChanged' },
      { component: 'docs', reason: 'ComponentChanged' },
    ]);
  });

  test('F25-AC3 - two removed components report one ComponentChanged reason and name both', () => {
    const assessment = assessStaleness(
      { ...RECORDED, components: THREE_COMPONENTS },
      { ...IDENTITY, components: [WEB] },
    );

    assert.deepEqual(assessment.reasons, ['ComponentChanged']);
    assert.deepEqual(assessment.componentDetail, [
      { component: 'api', reason: 'ComponentChanged' },
      { component: 'worker', reason: 'ComponentChanged' },
    ]);
  });

  test('F22-AC4 - one added and one removed component still report a single ComponentChanged', () => {
    const docs: ComponentIdentity = {
      component: 'docs',
      deploymentId: null,
      deploymentUrl: null,
      environment: 'preview',
    };
    const assessment = assessStaleness(RECORDED, { ...IDENTITY, components: [WEB, docs] });

    assert.deepEqual(assessment.reasons, ['ComponentChanged']);
    // The added component is noted from the current list, then the removed one
    // from the recorded list, so detail follows that order and still names both.
    assert.deepEqual(assessment.componentDetail, [
      { component: 'docs', reason: 'ComponentChanged' },
      { component: 'api', reason: 'ComponentChanged' },
    ]);
  });

  test('F22-AC4 - a removed and a replaced component are reported as distinct reasons', () => {
    const rebuiltWeb: ComponentIdentity = { ...WEB, deploymentId: 'dep-web-0002' };
    const assessment = assessStaleness(
      { ...RECORDED, components: THREE_COMPONENTS },
      { ...IDENTITY, components: [rebuiltWeb, API] },
    );
    assert.equal(assessment.stale, true);
    assert.deepEqual(assessment.reasons, ['DeploymentReplaced', 'ComponentChanged']);
    assert.deepEqual(assessment.componentDetail, [
      { component: 'web', reason: 'DeploymentReplaced' },
      { component: 'worker', reason: 'ComponentChanged' },
    ]);
  });
});

describe('candidate identity: commit SHAs are never abbreviated', () => {
  test('F26-AC2 - an abbreviated SHA is rejected instead of being used as identity', () => {
    assert.equal(isCommitSha('abc1234'), false);
    assert.throws(() => asCommitSha('abc1234'), /Not a full commit SHA/);
  });

  test('F26-AC2 - a full 40 character SHA is accepted', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    assert.equal(sha.length, 40);
    assert.equal(isCommitSha(sha), true);
    assert.equal(asCommitSha(sha), sha);
  });

  test('F26-AC2 - a full 64 character SHA is accepted', () => {
    const sha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    assert.equal(sha.length, 64);
    assert.equal(isCommitSha(sha), true);
    assert.equal(asCommitSha(sha), sha);
  });

  test('F26-AC2 - uppercase hex is not a valid SHA', () => {
    const uppercase = '0123456789ABCDEF0123456789ABCDEF01234567';
    assert.equal(uppercase.length, 40);
    assert.equal(isCommitSha(uppercase), false);
    assert.throws(() => asCommitSha(uppercase), /Not a full commit SHA/);
  });

  test('F26-AC2 - a branch name is not a SHA', () => {
    for (const value of ['HEAD', 'main', 'origin/main', '0123456789abcdef']) {
      assert.equal(isCommitSha(value), false, value);
      assert.throws(() => asCommitSha(value), /Not a full commit SHA/);
    }
  });
});
