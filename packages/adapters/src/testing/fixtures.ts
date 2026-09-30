/**
 * Deterministic adapter fixtures, written against the real adapter contracts.
 *
 * Every value here is a fixed string or a pure derivation, so two runs of the
 * contract suite observe byte-identical provider input. Nothing may call
 * `new Date()`, read the clock or generate randomness: a contract case that
 * drifts between runs cannot prove anything about the adapter it exercises.
 *
 * The shapes are the contracts in `../contracts`, not local copies. A fixture
 * that only resembles the contract would let a contract change pass unnoticed,
 * which is the opposite of what this module exists for.
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
  redact,
  scopeFingerprint,
  type CandidateIdentity,
  type CheckResult,
  type CommitSha,
  type ConnectorId,
  type OperationId,
  type ProviderId,
  type ScopeCriterion,
  type ScopeSnapshot,
  type WorkItemId,
} from '@shiploop/domain';
import type {
  AccessObservation,
  AdapterContext,
  ApiExchangeSpec,
  ArtifactReference,
  BrowserFlowSpec,
  CheckExecutionRequest,
  ConfiguredCheck,
  DeclareNoCodeOutcomeRequest,
  DeploymentAvailability,
  DeploymentIdentityRead,
  DiscoverDeploymentRequest,
  DraftBody,
  DraftLinkTarget,
  EngineBounds,
  EngineCheckpoint,
  EngineStartRequest,
  ExecutionBounds,
  ExecutionWorkspace,
  FindDraftsRequest,
  GitRepositoryRef,
  IneligibleDeployment,
  ManagedProgressUpdateRequest,
  MergePullRequestRequest,
  PermittedDeliveryAction,
  ProposalRevision,
  ProviderCheckObservation,
  PublishWorkRequest,
  PushBranchRequest,
  RelatedIssue,
  ResumeEngineSessionRequest,
  TicketIssueRef,
  TicketScopeRead,
  TicketTransitionDescriptor,
  TicketTransitionRequest,
  UpsertDraftRequest,
  VerifyDestinationRequest,
} from '../contracts/index.ts';

/**
 * Brands a fixture string as an identity of the named kind.
 *
 * ShipLoop owns these identities, so a contract fixture can mint one without a
 * database. The cast is the branding the domain already documents: a fixture
 * creates identity, it does not consume a validated one.
 */
export function operationId(value: string): OperationId {
  return value as OperationId;
}

export function providerId(value: string): ProviderId {
  return value as ProviderId;
}

export function connectorId(value: string): ConnectorId {
  return value as ConnectorId;
}

export function workItemId(value: string): WorkItemId {
  return value as WorkItemId;
}

export const FIXED_INSTANT = '2026-09-30T12:00:00.000Z';
export const FIXED_EARLIER_INSTANT = '2026-09-30T11:54:00.000Z';
export const FIXED_LATER_INSTANT = '2026-09-30T12:06:00.000Z';
export const FIXED_FINAL_INSTANT = '2026-09-30T12:09:00.000Z';

export const FIXTURE_TICKET_PROVIDER = 'fixture-ticket';
export const FIXTURE_GIT_PROVIDER = 'fixture-git';
export const FIXTURE_DEPLOYMENT_PROVIDER = 'fixture-deployment';
export const FIXTURE_ENGINE_PROVIDER = 'fixture-engine';
export const FIXTURE_ENGINE_VERSION = 'fixture-engine/1.0.0';
export const FIXTURE_VERIFICATION_PROVIDER = 'fixture-verification';

/** A provider that owns none of the fixture resources, used to prove refusal. */
export const FOREIGN_PROVIDER = 'foreign-git';

export const FIXTURE_TICKET_CONNECTOR = connectorId('connector_fixture_ticket');
export const FIXTURE_GIT_CONNECTOR = connectorId('connector_fixture_git');
export const FIXTURE_DEPLOYMENT_CONNECTOR = connectorId('connector_fixture_deployment');
export const FIXTURE_ENGINE_CONNECTOR = connectorId('connector_fixture_engine');
export const FIXTURE_VERIFICATION_CONNECTOR = connectorId('connector_fixture_verification');

export const FIXTURE_ISSUE_ID = providerId('issue_fixture_01');
export const FIXTURE_DEPENDENCY_ISSUE_ID = providerId('issue_fixture_dependency_01');
export const FIXTURE_WORK_ITEM_ID = workItemId('work_fixture_01');
export const FIXTURE_REPOSITORY_FULL_NAME = 'fixture/repo';
export const FIXTURE_DEPLOYMENT_ID = providerId('dep_fixture_01');

export const FIXTURE_HEAD_SHA = asCommitSha('1f0c2a9d3b6e4c8a7d5f1e3b9c2a6d4e8f0a1b3c');
export const FIXTURE_BASE_SHA = asCommitSha('0b9d8c7b6a5948372615e4d3c2b1a09f8e7d6c5b');
export const FIXTURE_SUPERSEDED_HEAD_SHA = asCommitSha('7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a3');
export const FIXTURE_MERGE_COMMIT_SHA = asCommitSha('5d4c3b2a1908f7e6d5c4b3a29180f7e6d5c4b3a2');

export const FIXTURE_RUN_NOTES_ARTIFACT: ArtifactReference = {
  artifactId: 'artifact_fixture_run_notes',
  kind: 'Log',
  uri: 'artifact://fixture/docs/run-notes.md',
  mediaType: 'text/markdown',
  byteLength: null,
  producedAt: FIXED_EARLIER_INSTANT,
  sanitized: true,
};

/* -------------------------------------------------------------------------- */
/* Scope, candidate and identity                                               */
/* -------------------------------------------------------------------------- */

export const FIXTURE_SCOPE_SNAPSHOT: ScopeSnapshot = {
  workItemId: 'work_fixture_01',
  issueId: FIXTURE_ISSUE_ID,
  issueIdentifier: 'FIX-101',
  title: 'Label preview deployment states on the review card',
  description:
    'The review card must show why a preview is not usable, and must not present a protected sign-in page as a verified application.',
  providerRevision: 'fixture-revision-3',
  priority: 'High',
  dependencyIssueIds: [FIXTURE_DEPENDENCY_ISSUE_ID],
  acceptanceCriteria: [
    { id: 'AC1', text: 'Missing, building, failed, protected and usable previews are shown as distinct states.' },
    { id: 'AC2', text: 'A protected preview is labelled Protected and is never offered as a usable application preview.' },
  ],
  retrievedAt: FIXED_INSTANT,
};

export const FIXTURE_TICKET_ISSUE_REF: TicketIssueRef = {
  issueId: FIXTURE_ISSUE_ID,
  identifier: FIXTURE_SCOPE_SNAPSHOT.issueIdentifier,
  url: `https://tickets.fixture.invalid/FIX/${FIXTURE_ISSUE_ID}`,
};

export const FIXTURE_DEPENDENCY_ISSUE_REF: TicketIssueRef = {
  issueId: FIXTURE_DEPENDENCY_ISSUE_ID,
  identifier: 'FIX-099',
  url: `https://tickets.fixture.invalid/FIX/${FIXTURE_DEPENDENCY_ISSUE_ID}`,
};

/** The scope as the ticket provider holds it, beside the snapshot derived from it. */
export const FIXTURE_TICKET_SCOPE_READ: TicketScopeRead = {
  issue: FIXTURE_TICKET_ISSUE_REF,
  snapshot: FIXTURE_SCOPE_SNAPSHOT,
  state: { kind: 'ProviderState', name: 'In Progress', terminal: 'None' },
  relations: [{ kind: 'Related', issue: FIXTURE_DEPENDENCY_ISSUE_REF }],
  managedRegions: [
    {
      target: { kind: 'UpdatableComment', commentId: providerId('comment_fixture_01') },
      lastMilestoneKey: null,
      lastDeliveredAt: null,
      lastDeliveredContentDigest: null,
    },
  ],
  observedAt: FIXED_LATER_INSTANT,
};

/**
 * A candidate with full head and base commits, every fingerprint populated and
 * two component identities. Reading it against `FIXTURE_SUPERSEDED_HEAD_SHA`
 * instead of the head proves identity is more than a pull request number.
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
 * The isolated workspace a bounded operation runs in.
 *
 * `testAccess` is a credential reference, never a credential value (F03-AC3):
 * the protected preview fixture is only observable by an authenticated owner, so
 * a workspace with no test access would make that state untestable rather than
 * safer.
 */
export const FIXTURE_WORKSPACE: ExecutionWorkspace = {
  workspaceId: 'workspace_fixture_01',
  absolutePath: '/srv/shiploop/workspaces/workspace_fixture_01',
  headSha: FIXTURE_HEAD_SHA,
  baseSha: FIXTURE_BASE_SHA,
  environmentFingerprint: FIXTURE_CANDIDATE_IDENTITY.environmentFingerprint,
  scopeFingerprint: scopeFingerprint(FIXTURE_SCOPE_SNAPSHOT),
  isolatedPorts: { app: 41001, api: 41002 },
  serviceEndpoints: [{ name: 'postgres', baseUrl: 'postgresql://127.0.0.1:5433/fixture' }],
  testAccess: { kind: 'DevCredentials', label: 'fixture owner', secretRef: 'secret://fixture/owner' },
};

const FIXTURE_CLOCK = {
  now: (): string => FIXED_INSTANT,
  elapsedMs: (): number => 0,
};

const FIXTURE_LOGGER = {
  emit(_record: Parameters<AdapterContext['logger']['emit']>[0]): void {
    // The fakes record the effects they perform in the side-effect ledger rather
    // than in a log stream, so a case asserts effects instead of log lines.
  },
};

/**
 * The ambient context an adapter call receives.
 *
 * The clock is fixed and the redactor is the real one, so adapter output is
 * reproducible and a case can prove a seeded credential pattern never reaches it
 * (N02-AC2). The operation identity is supplied per call, because the contract
 * takes the identity of an external write from the context rather than the body
 * of the request.
 */
export function adapterContext(operation: string, correlationId = 'corr_fixture_01'): AdapterContext {
  return {
    correlationId,
    operationId: operationId(operation),
    clock: FIXTURE_CLOCK,
    logger: FIXTURE_LOGGER,
    signal: new AbortController().signal,
    redact: (text: string): string => redact(text).text,
  };
}

/* -------------------------------------------------------------------------- */
/* Git provider facts                                                          */
/* -------------------------------------------------------------------------- */

export const FIXTURE_REPOSITORY: GitRepositoryRef = {
  provider: FIXTURE_GIT_PROVIDER,
  fullName: FIXTURE_REPOSITORY_FULL_NAME,
  defaultBranch: 'develop',
  url: `https://git.fixture.invalid/${FIXTURE_REPOSITORY_FULL_NAME}`,
};

/** The same repository reported by a provider that does not own it. */
export const FIXTURE_FOREIGN_REPOSITORY: GitRepositoryRef = {
  ...FIXTURE_REPOSITORY,
  provider: FOREIGN_PROVIDER,
};

export const FIXTURE_LINK: DraftLinkTarget = { kind: 'Ticket', issue: FIXTURE_TICKET_ISSUE_REF };

export const FIXTURE_DRAFT_BODY: DraftBody = {
  managedMarker: '<!-- shiploop:managed:op_fixture_draft_01 -->',
  purpose: 'Preview the scoped change for the owner.',
  scope: FIXTURE_SCOPE_SNAPSHOT.description,
  criteria: [
    {
      criterionId: 'AC1',
      text: FIXTURE_SCOPE_SNAPSHOT.acceptanceCriteria[0]?.text ?? 'The first acceptance criterion.',
      claim: { kind: 'NotRun', reason: 'The provider reported no run for this criterion.' },
    },
    {
      criterionId: 'AC2',
      text: FIXTURE_SCOPE_SNAPSHOT.acceptanceCriteria[1]?.text ?? 'The second acceptance criterion.',
      claim: { kind: 'NotRun', reason: 'The provider reported no run for this criterion.' },
    },
  ],
  knownGaps: ['The end-to-end suite did not run on the candidate head.'],
  verification: { kind: 'NotRun', reason: 'No check result had been observed when the draft was written.' },
  linkedWork: FIXTURE_LINK,
  managedProgressRegion: null,
};

export function upsertDraftRequest(operation: string): UpsertDraftRequest {
  return {
    operationId: operationId(operation),
    repository: FIXTURE_REPOSITORY,
    baseBranch: FIXTURE_REPOSITORY.defaultBranch,
    headSha: FIXTURE_HEAD_SHA,
    existingDraft: null,
    title: 'Preview: label deployment states on the review card',
    body: FIXTURE_DRAFT_BODY,
    link: FIXTURE_LINK,
  };
}

export function findDraftsRequest(operation: string, headSha = FIXTURE_HEAD_SHA): FindDraftsRequest {
  return { repository: FIXTURE_REPOSITORY, headSha, link: FIXTURE_LINK, operationId: operationId(operation) };
}

export function pushBranchRequest(operation: string): PushBranchRequest {
  return {
    operationId: operationId(operation),
    repository: FIXTURE_REPOSITORY,
    branch: 'task/fixture-preview-states',
    headSha: FIXTURE_HEAD_SHA,
    forceStrategy: 'RejectNonFastForward',
  };
}

export function mergePullRequestRequest(
  operation: string,
  pullRequest: ProviderId,
  preconditionHeadSha: typeof FIXTURE_HEAD_SHA,
  authorizedHeadSha: typeof FIXTURE_HEAD_SHA = preconditionHeadSha,
): MergePullRequestRequest {
  return {
    operationId: operationId(operation),
    authorizationId: 'authorization_fixture_01',
    repository: FIXTURE_REPOSITORY,
    pullRequestId: pullRequest,
    // The head the owner authorized, which is not necessarily the head the
    // provider will merge: the outcome has to say which one it merged (F26-AC4).
    expectedHeadSha: authorizedHeadSha,
    targetBranch: FIXTURE_REPOSITORY.defaultBranch,
    method: 'Squash',
    precondition: { kind: 'ProviderExpectedHead', expectedHeadSha: preconditionHeadSha },
  };
}

export function declareNoCodeOutcomeRequest(
  operation: string,
  reason: DeclareNoCodeOutcomeRequest['reason'],
): DeclareNoCodeOutcomeRequest {
  return {
    operationId: operationId(operation),
    repository: FIXTURE_REPOSITORY,
    branch: 'task/fixture-preview-states',
    reason,
    evidence: [FIXTURE_RUN_NOTES_ARTIFACT],
    declaredAt: FIXED_LATER_INSTANT,
  };
}

/* -------------------------------------------------------------------------- */
/* Ticket provider facts                                                       */
/* -------------------------------------------------------------------------- */

export const FIXTURE_PROPOSAL_REVISION: ProposalRevision = {
  workItemId: FIXTURE_WORK_ITEM_ID,
  revision: 3,
  title: FIXTURE_SCOPE_SNAPSHOT.title,
  description: FIXTURE_SCOPE_SNAPSHOT.description,
  criteria: FIXTURE_SCOPE_SNAPSHOT.acceptanceCriteria,
  dependencyIssueIds: [...FIXTURE_SCOPE_SNAPSHOT.dependencyIssueIds],
  targetTeamKey: 'FIX',
  acceptedByOwnerAt: FIXED_EARLIER_INSTANT,
};

export function publishWorkRequest(operation: string, adoptExistingIssueId: ProviderId | null = null): PublishWorkRequest {
  return { operationId: operationId(operation), revision: FIXTURE_PROPOSAL_REVISION, adoptExistingIssueId };
}

export function managedProgressUpdateRequest(
  operation: string,
  milestoneKey = 'Draft linked',
): ManagedProgressUpdateRequest {
  return {
    operationId: operationId(operation),
    issueId: FIXTURE_ISSUE_ID,
    region: { kind: 'UpdatableComment', commentId: providerId('comment_fixture_01') },
    milestoneKey,
    body: 'Draft linked and checks running.',
    observedAt: FIXED_LATER_INSTANT,
  };
}

export function ticketTransitionRequest(operation: string): TicketTransitionRequest {
  return {
    operationId: operationId(operation),
    issueId: FIXTURE_ISSUE_ID,
    transitionId: 'complete',
    expectedState: { kind: 'ProviderState', name: 'In Progress', terminal: 'None' },
    reason: 'The owner accepted the candidate and authorized closure.',
  };
}

/**
 * Related work the provider reports, offered to the owner rather than adopted.
 *
 * There is no auto-adopt variant anywhere in the contract: resemblance is
 * surfaced and the owner decides (F06-AC4).
 */
export const FIXTURE_TICKET_RELATED: readonly RelatedIssue[] = [
  {
    issue: FIXTURE_DEPENDENCY_ISSUE_REF,
    relation: 'DependentWork',
    state: { kind: 'ProviderState', name: 'In Progress', terminal: 'None' },
    matchedOn: ['TitleOverlap', 'SharedLabel'],
    similarity: 0.42,
    adoption: {
      kind: 'RequiresOwnerDecision',
      reason: 'The provider reports a dependency; only the owner decides whether ShipLoop adopts it.',
    },
  },
];

/** The transitions the provider offers, so a refusal names what the owner can use instead. */
export const FIXTURE_TICKET_TRANSITIONS: readonly TicketTransitionDescriptor[] = [
  { transitionId: 'complete', fromStates: ['In Progress'], toState: 'Done', terminal: 'Done' },
];

/* -------------------------------------------------------------------------- */
/* Check observations and configured checks                                    */
/* -------------------------------------------------------------------------- */

export const FIXTURE_REQUIRED_CHECK_NAMES: readonly string[] = [
  'pnpm test',
  'pnpm typecheck',
  'pnpm test:e2e',
  'pnpm lint',
  'pnpm test:a11y',
];

/** A required check the profile demands and the provider never reported. */
export const FIXTURE_UNREPORTED_REQUIRED_CHECK_NAME = 'pnpm test:unit';

function observation(
  checkId: string,
  name: string,
  result: CheckResult,
  options: {
    readonly required: boolean;
    readonly endedAt: string | null;
    readonly exitCode: number | null;
    readonly detail: string;
  },
): ProviderCheckObservation {
  return {
    checkId,
    name,
    result,
    requirement: options.required ? 'ProfileRequired' : 'ProviderExtra',
    startedAt: FIXED_EARLIER_INSTANT,
    endedAt: options.endedAt,
    exitCode: options.exitCode,
    detail: options.detail,
    artifactUrl: result === 'Missing' || result === 'Waiting' ? null : `artifact://fixture/${checkId}`,
  };
}

/**
 * The provider-reported check set: one observation for every one of Passed,
 * Failed, Missing, Waiting, Stale and NotApplicable, plus a second
 * NotApplicable the project profile has not approved.
 *
 * F20-AC2 requires those six to stay distinguishable, so this is the fixture a
 * second Git or CI provider is read against. `requirement` is re-derived on every
 * read, because only the controller knows which names the project profile
 * requires (F20-AC5).
 */
export const FIXTURE_CHECK_OBSERVATIONS: readonly ProviderCheckObservation[] = [
  observation('check_fixture_passed', 'pnpm test', 'Passed', {
    required: true,
    endedAt: FIXED_LATER_INSTANT,
    exitCode: 0,
    detail: 'Observed exit code 0 for the candidate head.',
  }),
  observation('check_fixture_failed', 'pnpm typecheck', 'Failed', {
    required: true,
    endedAt: FIXED_LATER_INSTANT,
    exitCode: 2,
    detail: 'Observed exit code 2 for the candidate head.',
  }),
  observation('check_fixture_missing', 'pnpm test:e2e', 'Missing', {
    required: true,
    endedAt: null,
    exitCode: null,
    detail: 'No run was reported for this check on the candidate head.',
  }),
  observation('check_fixture_waiting', 'pnpm build:image', 'Waiting', {
    required: false,
    endedAt: null,
    exitCode: null,
    detail: 'The provider reports the check as still queued.',
  }),
  observation('check_fixture_stale', 'pnpm lint', 'Stale', {
    required: true,
    endedAt: FIXED_EARLIER_INSTANT,
    exitCode: 0,
    detail: 'Observed against a superseded head, so it cannot approve this candidate.',
  }),
  observation('check_fixture_visual', 'pnpm test:visual', 'NotApplicable', {
    required: false,
    endedAt: null,
    exitCode: null,
    detail: 'Not applicable because this change has no visual surface.',
  }),
  observation('check_fixture_perf', 'pnpm test:perf', 'NotApplicable', {
    required: false,
    endedAt: null,
    exitCode: null,
    detail: 'Reported Not applicable by the coding run, with no profile policy decision either way.',
  }),
  observation('check_fixture_a11y', 'pnpm test:a11y', 'NotApplicable', {
    required: true,
    endedAt: null,
    exitCode: null,
    detail: 'Claimed Not applicable by the coding run without a profile policy decision.',
  }),
];

function configuredCheck(
  checkId: string,
  name: string,
  kind: ConfiguredCheck['kind'],
  command: readonly string[],
  required: boolean,
): ConfiguredCheck {
  return { checkId, name, kind, command, required, environmentEntries: [], timeoutMs: 600_000 };
}

/** The project profile's checks. `required` comes from the profile, never from the agent. */
export const FIXTURE_CONFIGURED_CHECKS: readonly ConfiguredCheck[] = [
  configuredCheck('check_fixture_passed', 'pnpm test', 'Command', ['pnpm', 'test'], true),
  configuredCheck('check_fixture_failed', 'pnpm typecheck', 'Command', ['pnpm', 'typecheck'], true),
  configuredCheck('check_fixture_missing', 'pnpm test:e2e', 'Command', ['pnpm', 'test:e2e'], true),
  configuredCheck('check_fixture_stale', 'pnpm lint', 'Command', ['pnpm', 'lint'], true),
  configuredCheck('check_fixture_visual', 'pnpm test:visual', 'Browser', ['pnpm', 'test:visual'], false),
  configuredCheck('check_fixture_perf', 'pnpm test:perf', 'Command', ['pnpm', 'test:perf'], false),
  configuredCheck('check_fixture_a11y', 'pnpm test:a11y', 'Browser', ['pnpm', 'test:a11y'], true),
  configuredCheck('check_fixture_unit', FIXTURE_UNREPORTED_REQUIRED_CHECK_NAME, 'Command', ['pnpm', 'test:unit'], true),
];

/**
 * Criteria named after the checks that can satisfy them.
 *
 * The contract binds a criterion to an observation by identity rather than by
 * prose, so a criterion id is a check id here and the mapping has no inference
 * in it.
 */
export const FIXTURE_CHECK_CRITERIA: readonly ScopeCriterion[] = [
  { id: 'check_fixture_passed', text: 'The unit suite passes on the candidate head.' },
  { id: 'check_fixture_failed', text: 'Type checking passes on the candidate head.' },
  { id: 'check_fixture_missing', text: 'The end-to-end suite reports a result on the candidate head.' },
  { id: 'check_fixture_stale', text: 'Linting reports a result for the candidate head.' },
  { id: 'check_fixture_visual', text: 'The visual suite reports a result for the candidate head.' },
  { id: 'check_fixture_perf', text: 'The performance suite reports a result for the candidate head.' },
  { id: 'check_fixture_absent', text: 'A criterion no observation was ever recorded for.' },
  { id: 'check_fixture_unit', text: 'The unit suite shard reports a result on the candidate head.' },
];

export const FIXTURE_EXECUTION_BOUNDS: ExecutionBounds = {
  wallClockMs: 600_000,
  outputBytes: 1_048_576,
  retryBudget: 1,
  networkAttempts: 2,
};

export function checkExecutionRequest(operation: string, check: ConfiguredCheck): CheckExecutionRequest {
  return {
    operationId: operationId(operation),
    workspace: FIXTURE_WORKSPACE,
    check,
    bounds: FIXTURE_EXECUTION_BOUNDS,
    candidateFingerprint: FIXTURE_CANDIDATE_FINGERPRINT,
  };
}

/* -------------------------------------------------------------------------- */
/* Deployment provider facts                                                   */
/* -------------------------------------------------------------------------- */

/** Every availability variant the contract declares, derived rather than restated. */
export type DeploymentAvailabilityKind = DeploymentAvailability['kind'];

/** The state a provider reports for one availability variant, with a stated reason. */
export function availabilityStateFor(kind: DeploymentAvailabilityKind, detail: string): DeploymentAvailability {
  switch (kind) {
    case 'Missing':
      return missingState(detail);
    case 'Building':
      return buildingState(detail);
    case 'Failed':
      return failedState(detail);
    case 'Protected':
      return protectedState(detail);
    case 'Usable':
      return usableState(detail);
  }
}

function missingState(detail: string): DeploymentAvailability {
  return { kind: 'Missing', detail, since: null };
}

function buildingState(detail: string): DeploymentAvailability {
  return { kind: 'Building', startedAt: FIXED_EARLIER_INSTANT, progressNote: detail, observedAt: FIXED_LATER_INSTANT };
}

function failedState(detail: string): DeploymentAvailability {
  return { kind: 'Failed', providerMessage: 'The provider reported a failed build.', detail };
}

function protectedState(detail: string): DeploymentAvailability {
  return { kind: 'Protected', access: { kind: 'RedirectedToSignIn', location: 'https://preview.fixture.invalid/sign_in' }, detail };
}

function usableState(detail: string): DeploymentAvailability {
  return {
    kind: 'Usable',
    verifiedAt: FIXED_LATER_INSTANT,
    proof: {
      method: 'BrowserFlow',
      observation: { kind: 'AuthenticatedProbe', httpStatus: 200, accountLabel: 'fixture owner' },
      evidence: [FIXTURE_RUN_NOTES_ARTIFACT],
      detail,
    },
  };
}

/** What an access probe observed at a destination in each availability state. */
export function accessObservationFor(kind: DeploymentAvailabilityKind, url: string): AccessObservation {
  switch (kind) {
    case 'Missing':
      return { kind: 'ConnectionFailed', detail: `No deployment is serving ${url}.` };
    case 'Building':
      return { kind: 'PublicResponse', httpStatus: 404 };
    case 'Failed':
      return { kind: 'PublicResponse', httpStatus: 500 };
    case 'Protected':
      return { kind: 'RedirectedToSignIn', location: `${url}/sign_in` };
    case 'Usable':
      return { kind: 'AuthenticatedProbe', httpStatus: 200, accountLabel: 'fixture owner' };
  }
}

function deploymentIdentity(
  deployment: ProviderId,
  component: string,
  environment: string,
  state: DeploymentAvailability,
): DeploymentIdentityRead {
  const url = `https://preview.fixture.invalid/${environment}/${component}/${deployment}`;
  return {
    deploymentId: deployment,
    provider: FIXTURE_DEPLOYMENT_PROVIDER,
    component,
    environment,
    repositoryFullName: FIXTURE_REPOSITORY_FULL_NAME,
    commitSha: FIXTURE_HEAD_SHA,
    url,
    availability: state,
    access: accessObservationFor(state.kind, url),
    match: { kind: 'Matches', commitSha: FIXTURE_HEAD_SHA, environment },
    providerRevision: `revision_fixture_${component}_${environment}`,
    observedAt: FIXED_LATER_INSTANT,
  };
}

/** One discovery request plus the read it must produce, for one availability state. */
export interface AvailabilityFixture {
  readonly kind: DeploymentAvailabilityKind;
  readonly discovery: DiscoverDeploymentRequest;
  /** The read discovery must produce. Null means it must answer `NotFound`. */
  readonly discovered: DeploymentIdentityRead | null;
  readonly ineligible: readonly IneligibleDeployment[];
}

/** A state the provider does serve, so its read is known rather than optional. */
interface FoundAvailabilityFixture extends AvailabilityFixture {
  readonly discovered: DeploymentIdentityRead;
  readonly ineligible: readonly [];
}

function foundFixture(
  deployment: ProviderId,
  component: string,
  environment: string,
  kind: Exclude<DeploymentAvailabilityKind, 'Missing'>,
  detail: string,
): FoundAvailabilityFixture {
  return {
    kind,
    discovery: {
      repositoryFullName: FIXTURE_REPOSITORY_FULL_NAME,
      commitSha: FIXTURE_HEAD_SHA,
      component,
      environment,
    },
    discovered: deploymentIdentity(deployment, component, environment, availabilityStateFor(kind, detail)),
    ineligible: [],
  };
}

const BUILDING_FIXTURE = foundFixture(
  providerId('dep_fixture_building'),
  'worker',
  'preview',
  'Building',
  'The provider reports the deployment as still building.',
);

const FAILED_FIXTURE = foundFixture(
  providerId('dep_fixture_failed'),
  'billing',
  'preview',
  'Failed',
  'The provider reported a failed build for this deployment.',
);

const PROTECTED_FIXTURE = foundFixture(
  FIXTURE_DEPLOYMENT_ID,
  'web',
  'preview',
  'Protected',
  'The deployment is behind provider protection and returns a sign-in page.',
);

const USABLE_FIXTURE = foundFixture(
  providerId('dep_fixture_usable'),
  'storefront',
  'preview',
  'Usable',
  'The deployment serves the candidate application to an authenticated owner.',
);


/** The protected preview, read live. Its sign-in page is what F22-AC3 is about. */
export const FIXTURE_PROTECTED_DEPLOYMENT: DeploymentIdentityRead = PROTECTED_FIXTURE.discovered;

export const FIXTURE_PROTECTED_DEPLOYMENT_URL = FIXTURE_PROTECTED_DEPLOYMENT.url;

export const FIXTURE_USABLE_DEPLOYMENT: DeploymentIdentityRead = USABLE_FIXTURE.discovered;

/**
 * One entry per availability variant, keyed so that a contract variant with no
 * fixture is a type error rather than a silently untested state (F22-AC3).
 *
 * The `Missing` entry asks for a superseded commit, so discovery must answer
 * `NotFound` and name the deployment it refused: a full commit is what
 * establishes tested identity and a branch alias is not a substitute (F22-AC2).
 */
export const FIXTURE_AVAILABILITIES: Readonly<Record<DeploymentAvailabilityKind, AvailabilityFixture>> = {
  Missing: {
    kind: 'Missing',
    discovery: {
      repositoryFullName: FIXTURE_REPOSITORY_FULL_NAME,
      commitSha: FIXTURE_SUPERSEDED_HEAD_SHA,
      component: 'web',
      environment: 'preview',
    },
    discovered: null,
    ineligible: [
      {
        deploymentId: FIXTURE_PROTECTED_DEPLOYMENT.deploymentId,
        commitSha: FIXTURE_PROTECTED_DEPLOYMENT.commitSha,
        url: FIXTURE_PROTECTED_DEPLOYMENT.url,
        ineligibility: 'DifferentCommit',
        detail: 'The only preview deployment for web is at another commit, so it cannot stand in.',
      },
    ],
  },
  Building: BUILDING_FIXTURE,
  Failed: FAILED_FIXTURE,
  Protected: PROTECTED_FIXTURE,
  Usable: USABLE_FIXTURE,
};

/** Every availability fixture, one per contract variant. */
export function fixtureAvailabilities(): readonly AvailabilityFixture[] {
  return Object.values(FIXTURE_AVAILABILITIES);
}

/** The provider reads the fakes know, one identity per discoverable availability state. */
export function fixtureAvailabilityIdentities(): readonly DeploymentIdentityRead[] {
  return fixtureAvailabilities()
    .map((fixture) => fixture.discovered)
    .filter((discovered): discovered is DeploymentIdentityRead => discovered !== null);
}

/** The delivery action a merge-auto-deploy profile authorizes for one component. */
export function redeployAction(
  component: string,
  environment: string,
  sourceDeploymentId: ProviderId = FIXTURE_USABLE_DEPLOYMENT.deploymentId,
): PermittedDeliveryAction {
  return {
    kind: 'RedeployCode',
    sourceDeploymentId,
    component,
    environment,
    authorizationId: 'authorization_fixture_01',
  };
}

export function verifyDestinationRequest(
  operation: string,
  requiredComponents: readonly string[],
  expectedCommitSha = FIXTURE_HEAD_SHA,
  withSmoke = true,
): VerifyDestinationRequest {
  return {
    operationId: operationId(operation),
    destination: 'production-fixture',
    expectedRepositoryFullName: FIXTURE_REPOSITORY_FULL_NAME,
    expectedCommitSha,
    expectedEnvironment: 'production',
    requiredComponents,
    liveSmoke: withSmoke
      ? {
          kind: 'Required',
          probes: requiredComponents.map((component) => ({
            probeId: `probe_fixture_${component}`,
            component,
            url: `https://production.fixture.invalid/${component}`,
            expectStatus: 200,
            expectBodyContains: `${component} is serving`,
            environment: 'Production' as const,
          })),
        }
      : { kind: 'None', reason: 'No live smoke requirement applies to this destination.' },
  };
}

export function browserFlowSpec(flowId: string, baseUrl: string): BrowserFlowSpec {
  return {
    flowId,
    baseUrl,
    environment: 'Preview',
    steps: [{ kind: 'Navigate', url: baseUrl }],
    expectation: { kind: 'NotSignInPage' },
    timeoutMs: 30_000,
  };
}

export function apiExchangeSpec(exchangeId: string, baseUrl: string): ApiExchangeSpec {
  return {
    exchangeId,
    baseUrl,
    environment: 'Preview',
    steps: [
      { kind: 'Request', method: 'GET', path: '/health', headers: [], body: null, timeoutMs: 30_000 },
      { kind: 'ExpectStatus', status: 200 },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Engine provider facts                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A structured engine stream containing exactly one MALFORMED line, positioned
 * after a `completion status=success` line. That ordering is deliberate: the
 * stream literally claims success, so the adapter has to refuse the claim rather
 * than inherit it (F15-AC2).
 *
 * The usage reported before the bad line must also be discarded. A stream
 * containing an unparseable line cannot be trusted to carry a complete usage
 * record, and reporting a partial token count as fact is the kind of invention
 * F18-AC4 forbids.
 */
export const FIXTURE_ENGINE_EVENT_LINES: readonly string[] = [
  '{"type":"session.started","session_id":"sess_fixture_01"}',
  '{"type":"milestone","stage":"ReadingInstructions","message":"Read the repository instructions"}',
  '{"type":"artifact","path":"docs/run-notes.md"}',
  '{"type":"usage","input_tokens":1840,"output_tokens":512}',
  '{"type":"completion","status":"success"}',
  'MALFORMED {"type":"completion","status":"succe',
  '{"type":"usage","input_tokens":7,"output_tokens":1}',
];

/** A read-only engine stream that reports no repository change (F19-AC5). */
export const FIXTURE_READ_ONLY_ENGINE_EVENT_LINES: readonly string[] = [
  '{"type":"session.started","session_id":"sess_fixture_readonly"}',
  '{"type":"milestone","stage":"ReadingInstructions","message":"Read the recipe and reported the failing check"}',
  '{"type":"no-code-change","stage":"SummingUp","reason":"Investigation mode produced no repository change."}',
  '{"type":"completion","status":"success"}',
];

export const FIXTURE_ENGINE_BOUNDS: EngineBounds = {
  activeWallClockMs: 1_800_000,
  retryBudget: 1,
  eventCountLimit: 512,
};

/** A coding-stage grant. Delivery capability kinds are not assignable here (F03-AC5). */
export const FIXTURE_CODING_CAPABILITIES = ['Git:ReadRepository', 'Git:ReadChecks', 'Engine:ReportUsage'] as const;

export function engineStartRequest(operation: string, instruction: string): EngineStartRequest {
  return {
    operationId: operationId(operation),
    workspace: FIXTURE_WORKSPACE,
    start: { kind: 'Fresh', instruction },
    mode: 'Headless',
    grantedCapabilities: [...FIXTURE_CODING_CAPABILITIES],
    bounds: FIXTURE_ENGINE_BOUNDS,
  };
}

export const FIXTURE_ENGINE_CHECKPOINT: EngineCheckpoint = {
  checkpointId: 'checkpoint_fixture_07',
  capturedAt: FIXED_INSTANT,
  scopeFingerprint: FIXTURE_WORKSPACE.scopeFingerprint,
  headSha: FIXTURE_HEAD_SHA,
  baseSha: FIXTURE_BASE_SHA,
  dirtyPaths: [],
  untrackedPaths: [],
  blocker: null,
  nextAction: 'Hand the candidate to the owner for acceptance.',
  resumeInstructions: 'Continue from the recorded scope fingerprint and open no new work.',
};

export function resumeEngineSessionRequest(operation: string, sessionId: string): ResumeEngineSessionRequest {
  return {
    operationId: operationId(operation),
    workspace: FIXTURE_WORKSPACE,
    priorSession: {
      sessionId: providerId(sessionId),
      engineVersion: FIXTURE_ENGINE_VERSION,
      lastEventAt: FIXED_EARLIER_INSTANT,
    },
    checkpoint: FIXTURE_ENGINE_CHECKPOINT,
    instruction: 'Continue from the checkpoint without widening the scope.',
    grantedCapabilities: [...FIXTURE_CODING_CAPABILITIES],
    bounds: FIXTURE_ENGINE_BOUNDS,
  };
}

/* -------------------------------------------------------------------------- */
/* Provider deliveries                                                         */
/* -------------------------------------------------------------------------- */

/** A provider delivery as the webhook reports it (F30-AC2, F30-AC3). */
export interface ProviderEvent {
  readonly deliveryId: string;
  readonly sequence: number;
  /** A full commit: a delivery that carries only a branch name cannot be ordered against head state. */
  readonly draftHeadSha: CommitSha;
  readonly observedAt: string;
}

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
