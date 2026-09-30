/**
 * Deterministic adapter fixtures.
 *
 * Every value here is a fixed string or a pure derivation, so two runs of the
 * contract suite observe byte-identical provider input. Nothing may call
 * `new Date()`, read the clock or generate randomness: a contract case that
 * drifts between runs cannot prove anything about the adapter it exercises.
 *
 * The fixtures cover the states that must stay distinct rather than collapsing
 * into a green result (F15-AC2, F20-AC2, F22-AC3), and one engine stream that
 * contains a single MALFORMED line so that "malformed output is not a successful
 * completion" is proven against real malformed input rather than asserted from a
 * comment.
 */

import {
  asCommitSha,
  candidateFingerprint,
  fingerprint,
  scopeFingerprint,
  type CandidateIdentity,
  type CheckOrigin,
  type CheckResult,
  type CommitSha,
  type OperationId,
  type ScopeSnapshot,
} from '@shiploop/domain';
import type {
  CheckObservationBatch,
  DeploymentIdentity,
  DeploymentQuery,
  DeploymentState,
  DraftRequest,
  ObservableCheck,
  ProviderEvent,
  ProviderReference,
  TicketPublishRequest,
  TransitionRequest,
} from './fake.ts';

/**
 * Brands a fixture string as an operation identity. ShipLoop owns these, so a
 * contract fixture can mint one without a database.
 */
export function operationId(value: string): OperationId {
  return value as OperationId;
}

export const FIXED_INSTANT = '2026-09-30T12:00:00.000Z';
export const FIXED_EARLIER_INSTANT = '2026-09-30T11:54:00.000Z';
export const FIXED_LATER_INSTANT = '2026-09-30T12:06:00.000Z';
export const FIXED_FINAL_INSTANT = '2026-09-30T12:09:00.000Z';

export const FIXTURE_TICKET_PROVIDER = 'fixture-ticket';
export const FIXTURE_GIT_PROVIDER = 'fixture-git';
export const FIXTURE_DEPLOYMENT_PROVIDER = 'fixture-deployment';
export const FIXTURE_ENGINE_PROVIDER = 'fixture-engine';
export const FIXTURE_VERIFICATION_PROVIDER = 'fixture-verification';

/** A provider that owns none of the fixture resources, used to prove refusal. */
export const FOREIGN_PROVIDER = 'foreign-git';

export const FIXTURE_ISSUE_ID = 'issue_fixture_01';
export const FIXTURE_REPOSITORY_ID = 'repo_fixture_01';
export const FIXTURE_DEPLOYMENT_ID = 'dep_fixture_01';

export const FIXTURE_HEAD_SHA = asCommitSha('1f0c2a9d3b6e4c8a7d5f1e3b9c2a6d4e8f0a1b3c');
export const FIXTURE_BASE_SHA = asCommitSha('0b9d8c7b6a5948372615e4d3c2b1a09f8e7d6c5b');
export const FIXTURE_SUPERSEDED_HEAD_SHA = asCommitSha('7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a3');
export const FIXTURE_MERGE_COMMIT_SHA = asCommitSha('5d4c3b2a1908f7e6d5c4b3a29180f7e6d5c4b3a2');

export const FIXTURE_ISSUE_REFERENCE: ProviderReference = {
  provider: FIXTURE_TICKET_PROVIDER,
  kind: 'Ticket',
  id: FIXTURE_ISSUE_ID,
};

export const FIXTURE_REPOSITORY_REFERENCE: ProviderReference = {
  provider: FIXTURE_GIT_PROVIDER,
  kind: 'Git',
  id: FIXTURE_REPOSITORY_ID,
};

export const FIXTURE_DEPLOYMENT_REFERENCE: ProviderReference = {
  provider: FIXTURE_DEPLOYMENT_PROVIDER,
  kind: 'Deployment',
  id: FIXTURE_DEPLOYMENT_ID,
};

export const FIXTURE_SCOPE_SNAPSHOT: ScopeSnapshot = {
  workItemId: 'work_fixture_01',
  issueId: FIXTURE_ISSUE_ID,
  issueIdentifier: 'FIX-101',
  title: 'Label preview deployment states on the review card',
  description:
    'The review card must show why a preview is not usable, and must not present a protected sign-in page as a verified application.',
  providerRevision: 'fixture-revision-3',
  priority: 'High',
  dependencyIssueIds: ['issue_fixture_dependency_01'],
  acceptanceCriteria: [
    { id: 'AC1', text: 'Missing, building, failed, protected and usable previews are shown as distinct states.' },
    { id: 'AC2', text: 'A protected preview is labelled Protected and is never offered as a usable application preview.' },
  ],
  retrievedAt: FIXED_INSTANT,
};

/**
 * A candidate with full head and base commits, every fingerprint populated and
 * two component identities. A replacement build is `FIXTURE_SUPERSEDED_CANDIDATE`,
 * which differs only in head; using it proves identity is more than a PR number.
 */
export const FIXTURE_CANDIDATE_IDENTITY: CandidateIdentity = {
  headSha: FIXTURE_HEAD_SHA,
  baseSha: FIXTURE_BASE_SHA,
  scopeFingerprint: scopeFingerprint(FIXTURE_SCOPE_SNAPSHOT),
  profileVersionId: 'profile_fixture_v3',
  procedureVersionId: 'procedure_fixture_v7',
  environmentFingerprint: fingerprint({ runtime: 'node24', lockDigest: 'fixture_lock_digest_01' }),
  policyFingerprint: fingerprint({ requiredChecks: ['pnpm test', 'pnpm typecheck'], revision: 3 }),
  components: [
    {
      component: 'api',
      deploymentId: 'dep_fixture_api',
      deploymentUrl: 'https://preview.fixture.invalid/api-fixture_01',
      environment: 'preview',
    },
    {
      component: 'web',
      deploymentId: FIXTURE_DEPLOYMENT_ID,
      deploymentUrl: 'https://preview.fixture.invalid/web-fixture_01',
      environment: 'preview',
    },
  ],
};

export const FIXTURE_CANDIDATE_FINGERPRINT = candidateFingerprint(FIXTURE_CANDIDATE_IDENTITY);

/**
 * The provider-reported check set: one observation for every one of Passed,
 * Failed, Missing, Waiting, Stale and NotApplicable.
 *
 * F20-AC2 requires those six to stay distinguishable, so this is the fixture a
 * second Git or CI provider is read against. The Stale observation carries the
 * superseded head, because staleness means the result belongs to a candidate that
 * is no longer the one under review.
 */
export const FIXTURE_CHECK_OBSERVATIONS: CheckObservationBatch = {
  provider: FIXTURE_GIT_PROVIDER,
  headSha: FIXTURE_HEAD_SHA,
  checks: [
    observation('check_fixture_passed', 'pnpm test', 'LocalCheck', 'Passed', {
      required: true,
      endedAt: FIXED_LATER_INSTANT,
      exitCode: 0,
      detail: 'Observed exit code 0 for the candidate head.',
    }),
    observation('check_fixture_failed', 'pnpm typecheck', 'LocalCheck', 'Failed', {
      required: true,
      endedAt: FIXED_LATER_INSTANT,
      exitCode: 2,
      detail: 'Observed exit code 2 for the candidate head.',
    }),
    observation('check_fixture_missing', 'pnpm test:e2e', 'ProviderCi', 'Missing', {
      required: true,
      endedAt: null,
      exitCode: null,
      detail: 'No run was reported for this check on the candidate head.',
    }),
    observation('check_fixture_waiting', 'pnpm build:image', 'ProviderCi', 'Waiting', {
      required: false,
      endedAt: null,
      exitCode: null,
      detail: 'The provider reports the check as still queued.',
    }),
    observation('check_fixture_stale', 'pnpm lint', 'LocalCheck', 'Stale', {
      required: true,
      observedHeadSha: FIXTURE_SUPERSEDED_HEAD_SHA,
      endedAt: FIXED_EARLIER_INSTANT,
      exitCode: 0,
      detail: 'Observed against a superseded head, so it cannot approve this candidate.',
    }),
    observation('check_fixture_not_applicable', 'pnpm test:visual', 'BrowserEvidence', 'NotApplicable', {
      required: false,
      endedAt: null,
      exitCode: null,
      detail: 'Not applicable because this change has no visual surface; approved in the project profile.',
      notApplicableApprovedByPolicy: true,
    }),
  ],
};

function observation(
  checkId: string,
  name: string,
  origin: CheckOrigin,
  state: CheckResult,
  options: {
    readonly required: boolean;
    readonly endedAt: string | null;
    readonly exitCode: number | null;
    readonly detail: string;
    readonly observedHeadSha?: CommitSha;
    readonly notApplicableApprovedByPolicy?: boolean;
  },
): ObservableCheck {
  return {
    checkId,
    name,
    origin,
    required: options.required,
    state,
    observedHeadSha: options.observedHeadSha ?? FIXTURE_HEAD_SHA,
    startedAt: FIXED_EARLIER_INSTANT,
    endedAt: options.endedAt,
    exitCode: options.exitCode,
    artifactRef: `artifact://fixture/${checkId}`,
    detail: options.detail,
    notApplicableApprovedByPolicy: options.notApplicableApprovedByPolicy ?? false,
  };
}


/**
 * The same required check reported NotApplicable without profile policy approval.
 * F20-AC5 forbids a gate being removed to make the candidate pass, so the
 * verification adapter must refuse rather than map it.
 */
export const FIXTURE_UNAPPROVED_NOT_APPLICABLE_OBSERVATIONS: CheckObservationBatch = {
  provider: FIXTURE_GIT_PROVIDER,
  headSha: FIXTURE_HEAD_SHA,
  checks: [
    {
      checkId: 'check_fixture_unapproved',
      name: 'pnpm test:visual',
      origin: 'BrowserEvidence',
      required: true,
      state: 'NotApplicable',
      observedHeadSha: FIXTURE_HEAD_SHA,
      startedAt: FIXED_EARLIER_INSTANT,
      endedAt: null,
      exitCode: null,
      artifactRef: null,
      detail: 'Claimed Not applicable by the coding run without a profile policy decision.',
      notApplicableApprovedByPolicy: false,
    },
  ],
};

export const FIXTURE_PREVIEW_QUERY: DeploymentQuery = {
  project: 'fixture-project',
  component: 'web',
  headSha: FIXTURE_HEAD_SHA,
  environment: 'preview',
};

function deployment(state: DeploymentState, options: { id: string | null; access: 'Open' | 'Protected' | 'Unknown'; detail: string }): DeploymentIdentity {
  return {
    reference: options.id === null ? null : { provider: FIXTURE_DEPLOYMENT_PROVIDER, kind: 'Deployment', id: options.id },
    state,
    url: options.id === null ? null : `https://preview.fixture.invalid/${options.id}`,
    headSha: state === 'Missing' ? null : FIXTURE_HEAD_SHA,
    environment: 'preview',
    component: 'web',
    access: options.access,
    observedAt: FIXED_LATER_INSTANT,
    detail: options.detail,
  };
}

/** One identity per preview state, because F22-AC3 requires them to stay distinct. */
export const FIXTURE_DEPLOYMENTS: readonly DeploymentIdentity[] = [
  deployment('Missing', {
    id: null,
    access: 'Unknown',
    detail: 'No deployment exists for this commit, component and environment.',
  }),
  deployment('Building', {
    id: 'dep_fixture_building',
    access: 'Open',
    detail: 'The provider reports the deployment as still building.',
  }),
  deployment('Failed', {
    id: 'dep_fixture_failed',
    access: 'Open',
    detail: 'The provider reported a failed build for this deployment.',
  }),
  deployment('Protected', {
    id: FIXTURE_DEPLOYMENT_ID,
    access: 'Protected',
    detail: 'The deployment is behind provider protection and returns a sign-in page.',
  }),
  deployment('Usable', {
    id: 'dep_fixture_usable',
    access: 'Open',
    detail: 'The deployment serves the candidate application to an authenticated owner.',
  }),
];

/**
 * A structured engine stream containing exactly one MALFORMED line, positioned
 * after a `completion status=success` line. That ordering is deliberate: the
 * stream literally claims success, so the adapter has to refuse the claim rather
 * than inherit it (F15-AC2).
 */
export const FIXTURE_ENGINE_EVENT_LINES: readonly string[] = [
  '{"type":"session.started","session_id":"sess_fixture_01"}',
  '{"type":"milestone","message":"Read the repository instructions"}',
  '{"type":"artifact","path":"docs/run-notes.md"}',
  '{"type":"usage","input_tokens":1840,"output_tokens":512}',
  '{"type":"completion","status":"success"}',
  'MALFORMED {"type":"completion","status":"succe',
  '{"type":"usage","input_tokens":7,"output_tokens":1}',
];

/** A read-only engine stream that reports no repository change (F19-AC5). */
export const FIXTURE_READ_ONLY_ENGINE_EVENT_LINES: readonly string[] = [
  '{"type":"session.started","session_id":"sess_fixture_readonly"}',
  '{"type":"milestone","message":"Read the recipe and reported the failing check"}',
  '{"type":"no-code-change","reason":"Investigation mode produced no repository change."}',
  '{"type":"completion","status":"success"}',
];

export const FIXTURE_DRAFT_REQUEST: DraftRequest = {
  operationId: operationId('op_fixture_draft_01'),
  repository: FIXTURE_REPOSITORY_REFERENCE,
  branch: 'task/fixture-preview-states',
  baseBranch: 'develop',
  headSha: FIXTURE_HEAD_SHA,
  body: 'Draft body describing the scope, criteria and known gaps.',
};

export const FIXTURE_PUBLISH_REQUEST: TicketPublishRequest = {
  operationId: operationId('op_fixture_publish_01'),
  teamKey: 'FIX',
  title: FIXTURE_SCOPE_SNAPSHOT.title,
  description: FIXTURE_SCOPE_SNAPSHOT.description,
  acceptanceCriteria: FIXTURE_SCOPE_SNAPSHOT.acceptanceCriteria,
  dependsOnIssueIds: FIXTURE_SCOPE_SNAPSHOT.dependencyIssueIds,
};

export const FIXTURE_TRANSITION_REQUEST: TransitionRequest = {
  operationId: operationId('op_fixture_transition_01'),
  issue: FIXTURE_ISSUE_REFERENCE,
  toState: 'Done',
};

/** Provider events used to prove that a replayed or late delivery cannot revert newer facts. */
export const FIXTURE_NEWEST_EVENT: ProviderEvent = {
  deliveryId: 'delivery_fixture_07',
  sequence: 7,
  draftHeadSha: FIXTURE_HEAD_SHA,
  observedAt: FIXED_LATER_INSTANT,
};

export const FIXTURE_LATE_EVENT: ProviderEvent = {
  deliveryId: 'delivery_fixture_03',
  sequence: 3,
  draftHeadSha: FIXTURE_SUPERSEDED_HEAD_SHA,
  observedAt: FIXED_EARLIER_INSTANT,
};

export const FIXTURE_FOLLOW_UP_EVENT: ProviderEvent = {
  deliveryId: 'delivery_fixture_09',
  sequence: 9,
  draftHeadSha: FIXTURE_MERGE_COMMIT_SHA,
  observedAt: FIXED_FINAL_INSTANT,
};
