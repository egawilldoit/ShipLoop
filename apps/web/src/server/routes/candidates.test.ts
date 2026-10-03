/**
 * HTTP boundary tests for the candidate routes.
 *
 * Every request goes through `app.inject()`, so the plugin, hook, guard and error-handling
 * stack the browser will hit are real and nothing is stubbed below the socket. What *is*
 * substituted is the controller: `packages/controller` is developed independently of this
 * server, so these tests bind the port declared in `routes/candidates.ts` to a double and
 * prove the transport against it. The parts that are not substituted are the ones under
 * test — the session gate, CSRF, validation, the error-to-status mapping, and the projection
 * that decides what a response is allowed to claim.
 *
 * The double is not a hand-written paraphrase of the controller. It reuses the domain's own
 * `parseGitHubPullRequestUrl`, `sameGitHubRepository`, `detectCandidateChange`,
 * `projectCandidateChecks`, `candidateChecksReady` and `blockingRequiredChecks`, and it
 * models the controller's two structural behaviours: a refused link reaches no provider
 * read, and a material change appends a new row rather than editing the old one. So the
 * refusal cases below are produced by production code and a change on refresh is a real
 * change detection rather than a scripted answer.
 *
 * What the double does *not* do is defend. `rawChecks` and `readinessOverride` return
 * whatever a fixture says, including a result outside the domain's vocabulary and a
 * readiness its own checks contradict, because refusing those is the transport's job and a
 * double that rescued it would prove nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_COOKIE_NAME,
  blocked,
  blockingRequiredChecks,
  candidateChecksReady,
  deriveCsrfToken,
  detectCandidateChange,
  err,
  hashSessionToken,
  invalid,
  ok,
  parseGitHubPullRequestUrl,
  projectCandidateChecks,
  sameGitHubRepository,
} from '@shiploop/domain';
import type {
  CandidateFacts,
  CheckResult,
  CommitSha,
  DomainError,
  OwnerId,
  ProviderCheckFact,
  PullRequestState,
  Result,
} from '@shiploop/domain';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.ts';
import { CSRF_HEADER } from '../auth-guard.ts';
import { readServerConfig, type ServerConfig } from '../config.ts';
import type { ControllerSurface, StoredSessionRecord } from '../contracts.ts';
import {
  CANDIDATE_METHODS,
  candidateUseCasesOf,
  type CandidateCheckReport,
  type CandidateReport,
  type CandidateUseCases,
  type LinkCandidateCommand,
  type LinkedCandidateReport,
  type ProviderCheckResult,
  type ProviderPullRequestState,
  type ReadCandidateCommand,
  type RecordedCandidateReport,
} from './candidates.ts';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const START = '2026-02-01T09:00:00.000Z';
const CSRF_SECRET = 'candidate-route-test-secret-value-0123456789';
const PROJECT_ID = 'proj-shop';
const OTHER_PROJECT_ID = 'proj-other';
const OWNER_ID = 'owner-1' as OwnerId;
const SESSION_ID = 'ses-candidate-1';
const SESSION_TOKEN = 'candidate-route-session-token-0123456789';
const COOKIE = `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}`;
const CSRF = deriveCsrfToken(SESSION_ID, CSRF_SECRET);

const REPOSITORY = 'octopus/shop';
const REQUEST_ID = 'req-checkout';
const CONTRACT_ID = 'ctr-checkout';
const CONTRACT_REVISION = 1;
const PULL_REQUEST_NUMBER = 7;
const PULL_REQUEST_URL = `https://github.com/${REPOSITORY}/pull/${PULL_REQUEST_NUMBER}`;
const LINKED_CANDIDATE_ID = 'cnd-1';
const MOVED_CANDIDATE_ID = 'cnd-2';
const BINDING_FINGERPRINT = 'fp_0000000000000000000000000000000a';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const BASE_SHA = 'c'.repeat(40);

/** What the provider reports for one pull request, in one read. */
interface ProviderFacts {
  readonly provider: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly headRepository: string | null;
  /** A string rather than the union, because one case feeds a state outside the vocabulary. */
  readonly pullRequestState: string;
  readonly draft: boolean;
  readonly observedAt: string;
}

function providerFacts(overrides: Partial<ProviderFacts> = {}): ProviderFacts {
  return {
    provider: 'github',
    repository: REPOSITORY,
    pullRequestNumber: PULL_REQUEST_NUMBER,
    pullRequestUrl: PULL_REQUEST_URL,
    baseBranch: 'main',
    baseSha: BASE_SHA,
    headBranch: 'feature/checkout-total',
    headSha: HEAD_A,
    headRepository: REPOSITORY,
    pullRequestState: 'Open',
    draft: false,
    observedAt: START,
    ...overrides,
  };
}

/** The row ShipLoop holds for the linked candidate. */
interface StoredCandidate {
  readonly candidateId: string;
  readonly projectId: string;
  readonly recorded: ProviderFacts;
}

/**
 * What the provider read did.
 *
 * A provider the fixture cannot answer is a different fact from a candidate that does not
 * exist, and the owner has to see the two differently (mvp-spec F24-AC5).
 */
type ProviderOutcome =
  | { readonly kind: 'Facts'; readonly facts: ProviderFacts }
  | { readonly kind: 'Refusal'; readonly error: DomainError };

/** A readiness the checks do not support, for the case where the port lies. */
interface ReadinessOverride {
  readonly checksReady?: boolean;
  readonly reviewReady?: boolean;
  readonly reasons?: readonly string[];
}

interface ProviderScript {
  /** Answers the link read. */
  readonly onLink: ProviderOutcome;
  /** Answers the read and the refresh read. */
  readonly onRead: ProviderOutcome;
  readonly stored: StoredCandidate;
  /** Observations for the live head, in the provider's own vocabulary. */
  readonly checks: readonly ProviderCheckFact[];
  /**
   * Check statuses returned verbatim, bypassing the domain projection.
   *
   * Only the cases that break the port's contract use it: a result outside the six states,
   * and a commit that is not a full SHA.
   */
  readonly rawChecks?: readonly CandidateCheckReport[];
  /** What the double claims when it should disagree with its own facts. */
  readonly readinessOverride?: ReadinessOverride;
}

function checkFact(overrides: Partial<ProviderCheckFact> = {}): ProviderCheckFact {
  return {
    name: 'typecheck',
    result: 'Passed',
    required: true,
    observedHeadSha: HEAD_A as CommitSha,
    startedAt: START,
    endedAt: START,
    artifactUrl: null,
    detail: null,
    ...overrides,
  };
}

const GREEN_CHECK = checkFact();

function scripted(overrides: Partial<ProviderScript> = {}): ProviderScript {
  const recorded = providerFacts();
  return {
    onLink: { kind: 'Facts', facts: recorded },
    onRead: { kind: 'Facts', facts: recorded },
    stored: { candidateId: LINKED_CANDIDATE_ID, projectId: PROJECT_ID, recorded },
    checks: [GREEN_CHECK],
    ...overrides,
  };
}

function linkBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: REQUEST_ID,
    contractId: CONTRACT_ID,
    contractRevision: CONTRACT_REVISION,
    pullRequestUrl: PULL_REQUEST_URL,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* The controller double                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The candidate port, built over a provider script.
 *
 * The refusals are the domain's own: `parseGitHubPullRequestUrl` decides whether an address
 * is a GitHub pull request and `sameGitHubRepository` decides whether it is this project's,
 * so a route test that expects a 400 for a look-alike host is exercising production parsing
 * rather than a fixture's opinion. `providerReads` counts the reads that actually reached
 * the provider, so a case can prove a refusal happened before anything was read.
 */
class CandidatePortDouble implements CandidateUseCases {
  readonly linkCommands: LinkCandidateCommand[] = [];
  readonly readCommands: ReadCandidateCommand[] = [];
  providerReads = 0;
  private readonly script: ProviderScript;

  constructor(script: ProviderScript) {
    this.script = script;
  }

  async linkCandidate(command: LinkCandidateCommand): Promise<Result<LinkedCandidateReport, DomainError>> {
    this.linkCommands.push(command);

    const parsed = parseGitHubPullRequestUrl(command.pullRequestUrl);
    if (!parsed.ok) return err(parsed.error);
    const configured = this.script.stored.recorded.repository;
    if (!sameGitHubRepository(parsed.value.fullName, configured)) {
      return err(
        invalid('That pull request belongs to a different repository than this project.', [
          {
            path: 'pullRequestUrl',
            message: `The address names ${parsed.value.fullName}, but this project is configured for ${configured}. A repository of the same name elsewhere is not this project.`,
          },
        ]),
      );
    }
    if (parsed.value.number !== this.script.stored.recorded.pullRequestNumber) {
      return err({ code: 'NotFound', reason: `${parsed.value.fullName}#${parsed.value.number} does not exist.` });
    }
    this.providerReads += 1;
    if (this.script.onLink.kind === 'Refusal') return err(this.script.onLink.error);

    const live = this.script.onLink.facts;
    if (live.pullRequestState !== 'Open') {
      return err(
        blocked(`${live.repository}#${live.pullRequestNumber} is ${live.pullRequestState}, so there is no open change to link as a candidate.`, [
          { name: 'PullRequestNotOpen', detail: `state ${live.pullRequestState}`, remedy: 'Reopen it on GitHub. Nothing was linked.' },
        ]),
      );
    }
    if (live.headRepository !== null && !sameGitHubRepository(live.headRepository, live.repository)) {
      return err(
        blocked(`GitHub reports the head of ${live.repository}#${live.pullRequestNumber} in ${live.headRepository}, not in this project.`, [
          { name: 'HeadOutsideProjectRepository', detail: `head repository ${live.headRepository}`, remedy: 'Open the pull request from a branch of the project. Nothing was linked.' },
        ]),
      );
    }
    const recorded = recordedFrom(this.script.stored, this.script.stored.recorded);
    return ok({
      candidate: recorded,
      live: liveOf(live),
      binding: { contractId: CONTRACT_ID, contractRevision: CONTRACT_REVISION, headSha: recorded.headSha },
      bindingFingerprint: BINDING_FINGERPRINT,
      alreadyRecorded: false,
      observedAt: live.observedAt,
      providerWritePerformed: false,
    });
  }

  async readCandidate(command: ReadCandidateCommand): Promise<Result<CandidateReport, DomainError>> {
    this.readCommands.push(command);
    const known = [this.script.stored.candidateId, MOVED_CANDIDATE_ID];
    if (!known.includes(command.candidateId)) {
      return err({ code: 'NotFound', reason: `Candidate ${command.candidateId} does not exist.` });
    }
    if (command.projectId !== this.script.stored.projectId) {
      return err({ code: 'NotFound', reason: `Candidate ${command.candidateId} does not exist in this project.` });
    }
    this.providerReads += 1;
    if (this.script.onRead.kind === 'Refusal') return err(this.script.onRead.error);

    const live = this.script.onRead.facts;
    const change = detectCandidateChange(factsOf(this.script.stored.recorded), factsOf(live));
    const projected = projectCandidateChecks(this.script.checks, live.headSha as CommitSha, ['typecheck']);
    const checks: readonly CandidateCheckReport[] =
      this.script.rawChecks ??
      projected.map((check) => ({
        name: check.name,
        result: check.result,
        required: check.required,
        blocking: check.result !== 'Passed' && !(check.result === 'NotApplicable' && check.notApplicableApprovedByPolicy),
        notApplicableApprovedByPolicy: check.notApplicableApprovedByPolicy,
        observedHeadSha: check.observedHeadSha,
        startedAt: check.startedAt,
        endedAt: check.endedAt,
        artifactUrl: check.artifactUrl,
        detail: check.detail,
      }));
    const blocking = this.script.rawChecks === undefined ? blockingRequiredChecks(projected) : [];
    const checksReady = this.script.rawChecks === undefined ? candidateChecksReady(projected) : false;

    const reasons = [...blocking];
    if (live.pullRequestState !== 'Open') reasons.push(`The pull request is ${live.pullRequestState}, so there is no open change to decide on.`);
    if (live.draft) reasons.push('The pull request is a draft, so its contents are not proposed for review yet.');
    if (live.headRepository !== null && !sameGitHubRepository(live.headRepository, live.repository)) {
      reasons.push(`The head is in ${live.headRepository}, not in ${live.repository}.`);
    }

    // A material change appends a row rather than editing one, which is what keeps evidence
    // for the previous head readable as evidence *about* that head.
    const recorded = change.changedAnything
      ? recordedFrom({ candidateId: MOVED_CANDIDATE_ID, projectId: this.script.stored.projectId, recorded: live }, live)
      : recordedFrom(this.script.stored, this.script.stored.recorded);
    const override = this.script.readinessOverride;
    return ok({
      candidate: recorded,
      live: liveOf(live),
      binding: { contractId: CONTRACT_ID, contractRevision: CONTRACT_REVISION, headSha: recorded.headSha },
      bindingFingerprint: BINDING_FINGERPRINT,
      change: {
        kind: change.kind,
        changed: [...change.changed],
        changedAnything: change.changedAnything,
        previousHeadSha: change.previousHeadSha,
        currentHeadSha: change.currentHeadSha,
        priorEvidenceStale: change.priorEvidenceStale,
        detail: change.detail,
      },
      evidence: {
        status: change.priorEvidenceStale ? 'Stale' : 'Current',
        priorReadinessPreserved: false,
        priorCandidateId: change.changedAnything ? this.script.stored.candidateId : null,
        priorHeadSha: change.changedAnything ? this.script.stored.recorded.headSha : null,
        detail: change.detail,
      },
      supersededCandidateIds: change.changedAnything ? [this.script.stored.candidateId] : [],
      checks,
      checksReady: override?.checksReady ?? checksReady,
      blockingChecks: blocking,
      reviewReadiness: {
        ready: override?.reviewReady ?? reasons.length === 0,
        reasons: override?.reasons ?? reasons,
      },
      observedAt: live.observedAt,
      providerWritePerformed: false,
    });
  }
}

function factsOf(facts: ProviderFacts): CandidateFacts {
  return {
    provider: facts.provider,
    repository: facts.repository,
    pullRequestNumber: facts.pullRequestNumber,
    baseBranch: facts.baseBranch,
    baseSha: facts.baseSha as CommitSha,
    headBranch: facts.headBranch,
    headSha: facts.headSha as CommitSha,
    pullRequestState: facts.pullRequestState as PullRequestState,
    draft: facts.draft,
  };
}

/** Projects one row, keeping both SHAs at full length and the state as observed. */
function recordedFrom(stored: StoredCandidate, facts: ProviderFacts): RecordedCandidateReport {
  return {
    candidateId: stored.candidateId,
    projectId: stored.projectId,
    requestId: REQUEST_ID,
    contractId: CONTRACT_ID,
    contractRevision: CONTRACT_REVISION,
    provider: facts.provider,
    repository: facts.repository,
    pullRequestNumber: facts.pullRequestNumber,
    pullRequestUrl: facts.pullRequestUrl,
    baseBranch: facts.baseBranch,
    baseSha: facts.baseSha,
    headBranch: facts.headBranch,
    headSha: facts.headSha,
    pullRequestState: facts.pullRequestState as ProviderPullRequestState,
    draft: facts.draft,
    observedAt: facts.observedAt,
    linkedAt: stored.recorded.observedAt,
  };
}

function liveOf(facts: ProviderFacts) {
  return {
    provider: facts.provider,
    repository: facts.repository,
    pullRequestNumber: facts.pullRequestNumber,
    pullRequestUrl: facts.pullRequestUrl,
    baseBranch: facts.baseBranch,
    baseSha: facts.baseSha,
    headBranch: facts.headBranch,
    headSha: facts.headSha,
    headRepository: facts.headRepository,
    pullRequestState: facts.pullRequestState as ProviderPullRequestState,
    draft: facts.draft,
    observedAt: facts.observedAt,
  };
}

function checkReport(overrides: Partial<CandidateCheckReport> = {}): CandidateCheckReport {
  return {
    name: 'typecheck',
    result: 'Passed',
    required: true,
    blocking: false,
    notApplicableApprovedByPolicy: false,
    observedHeadSha: null,
    startedAt: null,
    endedAt: null,
    artifactUrl: null,
    detail: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: NodeJS.Dict<string | string[] | number | undefined>;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly port: CandidatePortDouble | null;
  readonly close: () => Promise<void>;
}

function testConfig(): ServerConfig {
  const result = readServerConfig({
    SHIPLOOP_NODE_ENV: 'test',
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_LOG_LEVEL: 'silent',
  });
  if (!result.ok) throw new Error(`Test configuration is invalid: ${JSON.stringify(result.errors)}`);
  return result.value;
}

/**
 * The stored session the guard accepts.
 *
 * Its digest comes from the domain's own `hashSessionToken`, so the double cannot
 * accidentally present a session the real guard would refuse for a reason unrelated to these
 * routes.
 */
function storedSession(): StoredSessionRecord {
  return {
    sessionId: SESSION_ID,
    ownerId: OWNER_ID,
    displayName: 'Octopus',
    tokenDigest: hashSessionToken(SESSION_TOKEN),
    issuedAt: START,
    expiresAt: '2026-02-01T10:00:00.000Z',
    revokedAt: null,
    lastActivityAt: null,
  };
}

/**
 * A controller surface carrying only what these routes and the guard touch.
 *
 * Cast once, here, with the reason: the surface has fifteen groups and this suite exercises
 * one of them, so writing fourteen refusals would be noise. The candidate port is attached
 * only when one is supplied, which is how "this deployment composed no candidate port" is
 * expressed.
 */
function controllerWith(port: CandidateUseCases | null): ControllerSurface {
  const record = storedSession();
  const base = {
    sessions: {
      loadByToken: (token: string): Promise<Result<StoredSessionRecord, DomainError>> =>
        Promise.resolve(
          token === SESSION_TOKEN
            ? ok(record)
            : err({ code: 'Forbidden', reason: 'No session matches that token.' }),
        ),
      create: (): Promise<Result<StoredSessionRecord, DomainError>> =>
        Promise.resolve(err({ code: 'Forbidden', reason: 'Sign-in is not exercised here.' })),
      revoke: (): Promise<Result<null, DomainError>> => Promise.resolve(ok(null)),
      touch: (): Promise<Result<null, DomainError>> => Promise.resolve(ok(null)),
    },
    ...(port === null ? {} : { candidates: port }),
  };
  return base as unknown as ControllerSurface;
}

async function harness(script: ProviderScript | null = scripted()): Promise<Harness> {
  const port = script === null ? null : new CandidatePortDouble(script);
  const app = await buildApp({
    config: testConfig(),
    controller: controllerWith(port),
    now: () => new Date(START),
  });
  return { app, port, close: () => app.close() };
}

function parse<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

/** The recorded candidate as a test reads it. */
interface RecordedBody {
  readonly candidateId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly pullRequestState: string;
  readonly draft: boolean;
}

interface LiveBody {
  readonly headSha: string;
  readonly baseSha: string;
  readonly pullRequestState: string;
  readonly headRepository: string | null;
  readonly draft: boolean;
}

interface CheckBody {
  readonly name: string;
  readonly result: string;
  readonly required: boolean;
  readonly blocking: boolean;
  readonly detail: string | null;
}

/** `POST /candidates` answers `{ candidate: <link report> }`. */
interface LinkBodyResponse {
  readonly candidate: {
    readonly candidate: RecordedBody;
    readonly live: LiveBody;
    readonly binding: { readonly headSha: string; readonly contractId: string; readonly contractRevision: number };
    readonly alreadyRecorded: boolean;
    readonly providerWritePerformed: boolean;
    readonly checksReady?: boolean;
    readonly reviewReadiness?: { readonly ready: boolean };
  };
}

/** The read and the refresh both answer `{ candidate: <read report> }`. */
interface ReadBodyResponse {
  readonly candidate: {
    readonly candidate: RecordedBody;
    readonly live: LiveBody;
    readonly binding: { readonly headSha: string };
    readonly supersededCandidateIds: readonly string[];
    readonly change: {
      readonly kind: string;
      readonly changed: readonly string[];
      readonly changedAnything: boolean;
      readonly previousHeadSha: string | null;
      readonly currentHeadSha: string;
      readonly priorEvidenceStale: boolean;
    };
    readonly evidence: {
      readonly status: string;
      readonly priorReadinessPreserved: boolean;
      readonly priorCandidateId: string | null;
      readonly priorHeadSha: string | null;
      readonly detail: string;
    };
    readonly checks: readonly CheckBody[];
    readonly checksReady: boolean;
    readonly blockingChecks: readonly string[];
    readonly reviewReadiness: { readonly ready: boolean; readonly reasons: readonly string[] };
    readonly providerWritePerformed: boolean;
  };
}

interface ProblemResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly fields?: readonly { readonly path: string; readonly message: string }[];
    readonly prerequisites?: readonly { readonly name: string }[];
  };
  readonly signInRequired?: boolean;
}

function fieldMessages(problem: ProblemResponse, path: string): string {
  return (problem.error.fields ?? [])
    .filter((entry) => entry.path === path)
    .map((entry) => entry.message)
    .join(' ');
}

function link(h: Harness, body: Record<string, unknown>, projectId = PROJECT_ID): Promise<InjectedResponse> {
  return h.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/candidates`,
    headers: { cookie: COOKIE, [CSRF_HEADER]: CSRF },
    payload: body,
  });
}

function read(
  h: Harness,
  candidateId = LINKED_CANDIDATE_ID,
  projectId = PROJECT_ID,
): Promise<InjectedResponse> {
  return h.app.inject({
    method: 'GET',
    url: `/api/projects/${projectId}/candidates/${candidateId}`,
    headers: { cookie: COOKIE },
  });
}

function refresh(
  h: Harness,
  candidateId = LINKED_CANDIDATE_ID,
  payload: Record<string, unknown> = {},
): Promise<InjectedResponse> {
  return h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/candidates/${candidateId}/refresh`,
    headers: { cookie: COOKIE, [CSRF_HEADER]: CSRF },
    payload,
  });
}

/* -------------------------------------------------------------------------- */
/* Linking                                                                    */
/* -------------------------------------------------------------------------- */

test("mvp-spec F11-AC2: a link records the provider's full commit identity and reports no readiness", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await link(h, linkBody());
  assert.equal(response.statusCode, 201, response.body);
  const link0 = parse<LinkBodyResponse>(response).candidate;
  assert.equal(link0.candidate.candidateId, LINKED_CANDIDATE_ID);
  assert.equal(link0.candidate.projectId, PROJECT_ID);
  assert.equal(link0.candidate.requestId, REQUEST_ID);
  assert.equal(link0.candidate.headSha, HEAD_A);
  assert.equal(link0.candidate.baseSha, BASE_SHA);
  assert.equal(link0.candidate.headBranch, 'feature/checkout-total', 'a branch is a display fact, never identity');
  assert.equal(link0.live.headSha, HEAD_A);
  assert.equal(link0.binding.headSha, HEAD_A);
  assert.equal(link0.binding.contractId, CONTRACT_ID);
  assert.equal(link0.binding.contractRevision, CONTRACT_REVISION);
  assert.equal(link0.alreadyRecorded, false);
  assert.equal(link0.providerWritePerformed, false);

  // A link is a fact about identity. A response that carried a readiness answer could be read
  // as "ready" by a client that never looked at a check.
  assert.equal(link0.checksReady, undefined);
  assert.equal(link0.reviewReadiness, undefined);

  const command = h.port?.linkCommands[0];
  assert.ok(command !== undefined, 'the port must be called exactly once');
  assert.equal(command.pullRequestUrl, PULL_REQUEST_URL, 'the pasted address reaches the controller verbatim');
  assert.equal(command.projectId, PROJECT_ID);
  assert.equal(command.requestId, REQUEST_ID);
  assert.equal(command.contractRevision, CONTRACT_REVISION);
  assert.equal(command.expectedBaseBranch, null, 'a request may not assert what base branch the project expects');
  assert.equal(command.actor, OWNER_ID, 'the actor comes from the proved session');
  assert.match(command.correlationId, /^http-candidate-/);
});

test('mvp-spec 3: the link body cannot name identity, and a body that tries is refused by name', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  for (const field of ['headSha', 'headBranch', 'pullRequestNumber', 'pullRequestState', 'merge']) {
    const response = await link(h, linkBody({ [field]: HEAD_A }));
    assert.equal(response.statusCode, 400, `${field} must be refused: ${response.body}`);
    const problem = parse<ProblemResponse>(response);
    assert.notEqual(
      fieldMessages(problem, field),
      '',
      `the refusal must name ${field}: ${response.body}`,
    );
  }
  assert.deepEqual(h.port?.linkCommands, [], 'a refused body never reaches the controller');
  assert.equal(h.port?.providerReads, 0, 'and certainly never reaches the provider');
});

test('mvp-spec F11-AC3: an address that is not a GitHub pull request is refused before anything is read', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const cases: readonly { readonly label: string; readonly url: string }[] = [
    { label: 'a look-alike host', url: 'https://github.com.evil.test/octopus/shop/pull/7' },
    { label: 'another provider', url: 'https://gitlab.com/octopus/shop/-/merge_requests/7' },
    { label: 'a repository address rather than a pull request', url: `https://github.com/${REPOSITORY}` },
    { label: 'a pull request number with no address', url: '7' },
    { label: 'a branch name', url: 'feature/checkout-total' },
    { label: 'a path traversal inside the address', url: 'https://github.com/octopus/../other/pull/7' },
    { label: 'a tree address rather than a pull request', url: 'https://github.com/octopus/shop/tree/main' },
  ];

  for (const testCase of cases) {
    const response = await link(h, linkBody({ pullRequestUrl: testCase.url }));
    assert.equal(response.statusCode, 400, `${testCase.label} must be refused: ${response.body}`);
    const problem = parse<ProblemResponse>(response);
    assert.notEqual(
      fieldMessages(problem, 'pullRequestUrl'),
      '',
      `${testCase.label} must be refused on the address field: ${response.body}`,
    );
  }
  assert.equal(h.port?.providerReads, 0, 'a refused address reaches no provider read');
  assert.equal(h.port?.linkCommands.length, cases.length, 'the controller still saw each address to refuse it');
});

test('mvp-spec F11-AC3: a pull request from another repository is refused with both repositories named', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await link(h, linkBody({ pullRequestUrl: 'https://github.com/octopus/shop-legacy/pull/7' }));
  assert.equal(response.statusCode, 400, response.body);
  const problem = parse<ProblemResponse>(response);
  assert.match(problem.error.message, /different repository/i);
  const detail = fieldMessages(problem, 'pullRequestUrl');
  assert.match(detail, /octopus\/shop-legacy/, 'the repository the address named is named');
  assert.match(detail, /octopus\/shop/, 'the repository this project is configured for is named');
  assert.equal(h.port?.providerReads, 0, 'a foreign repository is refused before the provider is asked');
});

test('mvp-spec F11-AC3: a pull request whose head lives in a fork is refused rather than attributed to this project', async (t) => {
  const h = await harness(
    scripted({ onLink: { kind: 'Facts', facts: providerFacts({ headRepository: 'contributor/shop' }) } }),
  );
  t.after(() => h.close());

  const response = await link(h, linkBody());
  assert.equal(response.statusCode, 422, response.body);
  const problem = parse<ProblemResponse>(response);
  assert.deepEqual(problem.error.prerequisites?.map((entry) => entry.name), ['HeadOutsideProjectRepository']);
  assert.match(problem.error.message, /contributor\/shop/);
});

test('mvp-spec F24-AC5: a pull request that does not exist and one the credential cannot read are different answers', async (t) => {
  const missing = await harness(
    scripted({ onLink: { kind: 'Refusal', error: { code: 'NotFound', reason: 'octopus/shop#7 does not exist.' } } }),
  );
  t.after(() => missing.close());
  const missingResponse = await link(missing, linkBody());
  assert.equal(missingResponse.statusCode, 404, missingResponse.body);
  assert.match(parse<ProblemResponse>(missingResponse).error.message, /does not exist/);

  const forbidden = await harness(
    scripted({ onLink: { kind: 'Refusal', error: { code: 'Forbidden', reason: 'The GitHub credential may not read octopus/shop#7.' } } }),
  );
  t.after(() => forbidden.close());
  const forbiddenResponse = await link(forbidden, linkBody());
  assert.equal(forbiddenResponse.statusCode, 403, forbiddenResponse.body);
  assert.match(parse<ProblemResponse>(forbiddenResponse).error.message, /may not read/);

  const unreachable = await harness(
    scripted({ onLink: { kind: 'Refusal', error: { code: 'Unavailable', reason: 'GitHub did not answer.' } } }),
  );
  t.after(() => unreachable.close());
  const unreachableResponse = await link(unreachable, linkBody());
  assert.equal(unreachableResponse.statusCode, 503, unreachableResponse.body);
  assert.equal(unreachableResponse.body.includes(HEAD_A), false, 'nothing was recorded');
});

test('mvp-spec 3: a provider that reports an abbreviated SHA is refused instead of recorded as identity', async (t) => {
  const h = await harness(
    scripted({ onLink: { kind: 'Facts', facts: providerFacts({ headSha: HEAD_A.slice(0, 12) }) } }),
  );
  t.after(() => h.close());

  const response = await link(h, linkBody());
  assert.equal(response.statusCode, 503, response.body);
  const message = parse<ProblemResponse>(response).error.message;
  assert.match(message, /not a full commit SHA/i);
  assert.equal(message.includes('"headSha"'), false, 'the response must not present an abbreviated commit as identity');
});

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

test("mvp-spec F24-AC1: a read reports the live candidate with both SHAs unabbreviated", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await read(h);
  assert.equal(response.statusCode, 200, response.body);
  const report = parse<ReadBodyResponse>(response).candidate;
  assert.equal(report.candidate.candidateId, LINKED_CANDIDATE_ID);
  assert.equal(report.candidate.headSha, HEAD_A);
  assert.equal(report.candidate.baseSha, BASE_SHA);
  assert.equal(report.live.headSha, HEAD_A);
  assert.equal(report.live.baseSha, BASE_SHA);
  assert.equal(report.binding.headSha, HEAD_A);
  assert.equal(report.providerWritePerformed, false);
  assert.equal(report.change.kind, 'Unchanged');
  assert.equal(report.change.priorEvidenceStale, false);
  assert.equal(report.evidence.status, 'Current');
  assert.deepEqual(report.supersededCandidateIds, []);
  assert.equal(report.checksReady, true);
  assert.equal(report.reviewReadiness.ready, true);

  const command = h.port?.readCommands[0];
  assert.equal(command?.candidateId, LINKED_CANDIDATE_ID);
  assert.equal(command?.projectId, PROJECT_ID);
  assert.equal(command?.actor, OWNER_ID);
});

test("mvp-spec 3: a candidate in another project is not readable through this project's path", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const other = await read(h, LINKED_CANDIDATE_ID, OTHER_PROJECT_ID);
  assert.equal(other.statusCode, 404, other.body);
  assert.equal(parse<ProblemResponse>(other).error.code, 'NotFound');
  // The port is asked with the project from the path, so the refusal is the controller's
  // cross-project answer rather than a filter applied after the fact.
  assert.equal(h.port?.readCommands[0]?.projectId, OTHER_PROJECT_ID);

  const unknown = await read(h, 'cnd-does-not-exist');
  assert.equal(unknown.statusCode, 404, unknown.body);
});

test('mvp-spec F24-AC5: a provider read that fails is not answered from the stored row', async (t) => {
  const h = await harness(
    scripted({
      onRead: { kind: 'Refusal', error: { code: 'Unavailable', reason: 'GitHub did not answer the pull request read.' } },
    }),
  );
  t.after(() => h.close());

  const response = await read(h);
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.body.includes(HEAD_A), false, 'no stale card is dressed as a current one');
});

/* -------------------------------------------------------------------------- */
/* Refresh and staleness                                                      */
/* -------------------------------------------------------------------------- */

test('mvp-spec F20-AC3, F24-AC4: a refresh that sees a new head reports the change and keeps no prior readiness', async (t) => {
  const h = await harness(
    scripted({
      onRead: { kind: 'Facts', facts: providerFacts({ headSha: HEAD_B, observedAt: '2026-02-01T09:30:00.000Z' }) },
      // The old head's green check, still on the record. Nothing was run for the new head.
      checks: [GREEN_CHECK],
    }),
  );
  t.after(() => h.close());

  const response = await refresh(h);
  assert.equal(response.statusCode, 200, response.body);
  const report = parse<ReadBodyResponse>(response).candidate;

  assert.equal(report.candidate.headSha, HEAD_B, 'the candidate is the commit the provider holds now');
  assert.equal(report.live.headSha, HEAD_B);
  assert.notEqual(report.candidate.candidateId, LINKED_CANDIDATE_ID, 'a moved head is a new candidate, not an edited one');
  assert.deepEqual(report.supersededCandidateIds, [LINKED_CANDIDATE_ID]);
  assert.equal(report.change.kind, 'HeadChanged');
  assert.ok(report.change.changed.includes('HeadChanged'));
  assert.equal(report.change.changedAnything, true);
  assert.equal(report.change.previousHeadSha, HEAD_A, 'the response names what prior evidence was about');
  assert.equal(report.change.currentHeadSha, HEAD_B);
  assert.equal(report.change.priorEvidenceStale, true);
  assert.equal(report.evidence.status, 'Stale');
  assert.equal(report.evidence.priorHeadSha, HEAD_A);
  assert.equal(report.evidence.priorCandidateId, LINKED_CANDIDATE_ID);
  assert.equal(report.evidence.priorReadinessPreserved, false);
  assert.ok(report.evidence.detail.length > 0, 'a stale answer explains itself');

  // The old head's green check cannot prove the new head, so nothing is ready.
  assert.equal(report.checksReady, false);
  assert.ok(report.blockingChecks.includes('typecheck is Stale'));
  assert.equal(report.reviewReadiness.ready, false);
  assert.ok(report.reviewReadiness.reasons.some((reason) => reason.includes('typecheck')));
  assert.equal(report.providerWritePerformed, false);
});

test('mvp-spec F20-AC3: a refresh that finds nothing moved reports Current and still claims no prior readiness', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await refresh(h);
  assert.equal(response.statusCode, 200, response.body);
  const report = parse<ReadBodyResponse>(response).candidate;
  assert.equal(report.change.changedAnything, false);
  assert.equal(report.change.previousHeadSha, HEAD_A);
  assert.equal(report.evidence.status, 'Current');
  assert.equal(report.evidence.priorReadinessPreserved, false);
  assert.equal(report.evidence.priorHeadSha, null);
  assert.equal(report.checksReady, true);
  assert.equal(report.reviewReadiness.ready, true);
});

test('mvp-spec F24-AC4: a refresh body cannot claim what changed or which head is there', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await refresh(h, LINKED_CANDIDATE_ID, { headSha: HEAD_B, change: 'HeadChanged', merge: true });
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(h.port?.readCommands, [], 'a refused body never reaches the controller');
  assert.equal(h.port?.providerReads, 0);
});

test('mvp-spec F24-AC4: a refresh with no body at all is still a refresh', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/candidates/${LINKED_CANDIDATE_ID}/refresh`,
    headers: { cookie: COOKIE, [CSRF_HEADER]: CSRF },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(h.port?.readCommands.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Provider state fidelity                                                    */
/* -------------------------------------------------------------------------- */

test('mvp-spec F20-AC2: a closed pull request stays Closed and stops being reviewable', async (t) => {
  const h = await harness(
    scripted({ onRead: { kind: 'Facts', facts: providerFacts({ pullRequestState: 'Closed' }) } }),
  );
  t.after(() => h.close());

  const response = await read(h);
  assert.equal(response.statusCode, 200, response.body);
  const report = parse<ReadBodyResponse>(response).candidate;
  assert.equal(report.live.pullRequestState, 'Closed', 'the provider state is reported, not normalised');
  assert.equal(report.candidate.pullRequestState, 'Closed', 'the row follows the provider rather than keeping the old state');
  assert.equal(report.checksReady, true, 'green checks and a closed pull request are two questions');
  assert.equal(report.reviewReadiness.ready, false);
  assert.ok(report.reviewReadiness.reasons.some((reason) => reason.includes('Closed')));
  assert.ok(report.change.changed.includes('StateChanged'));
});

test('mvp-spec F20-AC2: a merged pull request stays Merged', async (t) => {
  const h = await harness(
    scripted({ onRead: { kind: 'Facts', facts: providerFacts({ pullRequestState: 'Merged' }) } }),
  );
  t.after(() => h.close());

  const response = await read(h);
  assert.equal(response.statusCode, 200, response.body);
  const report = parse<ReadBodyResponse>(response).candidate;
  assert.equal(report.live.pullRequestState, 'Merged');
  assert.equal(report.reviewReadiness.ready, false);
});

test('mvp-spec F20-AC2: a closed or merged pull request cannot be linked at all', async (t) => {
  for (const state of ['Closed', 'Merged'] as const) {
    const h = await harness(
      scripted({ onLink: { kind: 'Facts', facts: providerFacts({ pullRequestState: state }) } }),
    );
    t.after(() => h.close());
    const response = await link(h, linkBody());
    assert.equal(response.statusCode, 422, `${state} must be refused: ${response.body}`);
    assert.match(parse<ProblemResponse>(response).error.message, new RegExp(state));
  }
});

test('mvp-spec F20-AC2: a draft pull request is readable and never reviewable', async (t) => {
  const h = await harness(
    scripted({ onRead: { kind: 'Facts', facts: providerFacts({ draft: true }) } }),
  );
  t.after(() => h.close());

  const response = await read(h);
  assert.equal(response.statusCode, 200, response.body);
  const report = parse<ReadBodyResponse>(response).candidate;
  assert.equal(report.live.draft, true);
  assert.equal(report.checksReady, true);
  assert.equal(report.reviewReadiness.ready, false);
  assert.ok(report.reviewReadiness.reasons.some((reason) => reason.includes('draft')));
});

test('mvp-spec F20-AC2: an unrecognised provider state is reported as unread, never as Open or Closed', async (t) => {
  const h = await harness(
    scripted({ onRead: { kind: 'Facts', facts: providerFacts({ pullRequestState: 'UnderReview' }) } }),
  );
  t.after(() => h.close());

  const response = await read(h);
  assert.equal(response.statusCode, 503, response.body);
  const message = parse<ProblemResponse>(response).error.message;
  assert.match(message, /UnderReview/, 'the value the provider reported is named, not dropped');
  assert.match(message, /Open, Closed, Merged/, 'the states the product does have words for are named');
  assert.equal(message.includes('"pullRequestState":"Open"'), false);
  assert.equal(message.includes('"pullRequestState":"Closed"'), false);
  assert.equal(message.includes(HEAD_A), false, 'no candidate is presented out of a read nobody understood');
});

test('mvp-spec F20-AC2: a recorded row carrying an unreadable state is refused too', async (t) => {
  const h = await harness(
    scripted({
      stored: {
        candidateId: LINKED_CANDIDATE_ID,
        projectId: PROJECT_ID,
        recorded: providerFacts({ pullRequestState: 'PendingReview' }),
      },
      onRead: { kind: 'Facts', facts: providerFacts({ pullRequestState: 'PendingReview' }) },
    }),
  );
  t.after(() => h.close());

  const response = await read(h);
  assert.equal(response.statusCode, 503, response.body);
  assert.match(parse<ProblemResponse>(response).error.message, /PendingReview/);
});

test('mvp-spec F20-AC2: a port that claims check readiness its own checks contradict is refused', async (t) => {
  const h = await harness(
    scripted({
      checks: [checkFact({ result: 'Missing', startedAt: null, endedAt: null })],
      readinessOverride: { checksReady: true },
    }),
  );
  t.after(() => h.close());

  const response = await read(h);
  assert.equal(response.statusCode, 503, response.body);
  const message = parse<ProblemResponse>(response).error.message;
  assert.match(message, /checksReady=true/);
  assert.match(message, /typecheck/, 'the blocking check is named, so the owner knows what to look at');
});

test('mvp-spec F20-AC2: a port that calls a candidate reviewable when this read says otherwise is refused', async (t) => {
  const h = await harness(
    scripted({
      onRead: { kind: 'Facts', facts: providerFacts({ draft: true }) },
      readinessOverride: { reviewReady: true },
    }),
  );
  t.after(() => h.close());

  const response = await read(h);
  assert.equal(response.statusCode, 503, response.body);
  assert.match(parse<ProblemResponse>(response).error.message, /derived from this read/);
});

test('mvp-spec F20-AC2: a candidate cannot be both ready and carry the reasons it is not ready', async (t) => {
  const h = await harness(scripted({ readinessOverride: { reasons: ['typecheck is Waiting'] } }));
  t.after(() => h.close());

  const response = await read(h);
  assert.equal(response.statusCode, 503, response.body);
  assert.match(parse<ProblemResponse>(response).error.message, /cannot both be true/);
});

test('mvp-spec F20-AC2: a check result outside the six states is refused rather than read as a pass', async (t) => {
  const h = await harness(
    scripted({
      rawChecks: [checkReport({ name: 'lint', result: 'Skipped' as ProviderCheckResult, required: true })],
      readinessOverride: { checksReady: false, reviewReady: false },
    }),
  );
  t.after(() => h.close());

  const response = await read(h);
  assert.equal(response.statusCode, 503, response.body);
  const message = parse<ProblemResponse>(response).error.message;
  assert.match(message, /Skipped/);
  assert.match(message, /not a pass/i);
});

test('mvp-spec 3: a check attributed to something that is not a full commit SHA is refused', async (t) => {
  const h = await harness(
    scripted({
      rawChecks: [checkReport({ name: 'lint', observedHeadSha: 'abc1234' })],
      readinessOverride: { checksReady: false, reviewReady: false },
    }),
  );
  t.after(() => h.close());

  const response = await read(h);
  assert.equal(response.statusCode, 503, response.body);
  assert.match(parse<ProblemResponse>(response).error.message, /not a full commit SHA/);
});

/* -------------------------------------------------------------------------- */
/* Checks are never laundered into a pass                                     */
/* -------------------------------------------------------------------------- */

test('mvp-spec F20-AC2: missing, waiting, failed and stale required checks all block', async (t) => {
  const results: readonly CheckResult[] = ['Missing', 'Waiting', 'Failed', 'Stale'];

  for (const result of results) {
    const h = await harness(scripted({ checks: [checkFact({ result, startedAt: null, endedAt: null })] }));
    t.after(() => h.close());
    const response = await read(h);
    assert.equal(response.statusCode, 200, response.body);
    const report = parse<ReadBodyResponse>(response).candidate;
    assert.equal(report.checksReady, false, `${result} must not read as a pass`);
    assert.ok(report.blockingChecks.includes(`typecheck is ${result}`));
    assert.equal(report.checks.find((check) => check.name === 'typecheck')?.blocking, true);
    assert.equal(report.reviewReadiness.ready, false);
  }
});

test('mvp-spec F20-AC2: a required check the provider never reported appears as Missing', async (t) => {
  const h = await harness(scripted({ checks: [] }));
  t.after(() => h.close());

  const response = await read(h);
  assert.equal(response.statusCode, 200, response.body);
  const report = parse<ReadBodyResponse>(response).candidate;
  const typecheck = report.checks.find((check) => check.name === 'typecheck');
  assert.ok(typecheck !== undefined, 'a required check the provider did not report is still listed');
  assert.equal(typecheck.result, 'Missing');
  assert.equal(typecheck.required, true);
  assert.equal(typecheck.blocking, true);
  assert.equal(report.checksReady, false);
  assert.equal(report.reviewReadiness.ready, false);
});

test('mvp-spec F20-AC2: a check reported against another commit says which commit it proves', async (t) => {
  const h = await harness(
    scripted({
      onRead: { kind: 'Facts', facts: providerFacts({ headSha: HEAD_B }) },
      checks: [GREEN_CHECK],
    }),
  );
  t.after(() => h.close());

  const response = await read(h);
  assert.equal(response.statusCode, 200, response.body);
  const report = parse<ReadBodyResponse>(response).candidate;
  const typecheck = report.checks.find((check) => check.name === 'typecheck');
  // The domain demotes an observation attributed to another commit rather than dropping it,
  // so the owner can see that the check ran and what it was actually about.
  assert.equal(typecheck?.result, 'Stale');
  assert.equal(typecheck?.blocking, true);
  assert.ok(typecheck?.detail?.includes(HEAD_A.slice(0, 12)), 'the commit it was reported against is named');
  assert.ok(typecheck?.detail?.includes(HEAD_B.slice(0, 12)), 'the candidate head it cannot prove is named');
  assert.equal(report.checksReady, false);
});

/* -------------------------------------------------------------------------- */
/* Read-only, scoped, authorized                                              */
/* -------------------------------------------------------------------------- */

test('mvp-spec F03-AC5: the candidate surface has no write to the provider', async () => {
  assert.deepEqual([...CANDIDATE_METHODS], ['linkCandidate', 'readCandidate']);
  const callable = Object.getOwnPropertyNames(CandidatePortDouble.prototype).filter(
    (name) => name !== 'constructor',
  );
  assert.deepEqual(callable.sort(), [...CANDIDATE_METHODS].sort(), 'the port is exactly these two calls');
  for (const forbidden of ['merge', 'close', 'approve', 'push', 'protect', 'deploy', 'release']) {
    assert.equal(
      callable.some((name) => name.toLowerCase().includes(forbidden)),
      false,
      `the candidate port must have no ${forbidden} method`,
    );
  }
});

test('mvp-spec F03-AC5: no verb other than GET and POST addresses a candidate, and none of them writes', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const attempts: readonly { readonly method: 'PUT' | 'PATCH' | 'DELETE' | 'POST'; readonly url: string }[] = [
    { method: 'PUT', url: `/api/projects/${PROJECT_ID}/candidates/${LINKED_CANDIDATE_ID}` },
    { method: 'PATCH', url: `/api/projects/${PROJECT_ID}/candidates/${LINKED_CANDIDATE_ID}` },
    { method: 'DELETE', url: `/api/projects/${PROJECT_ID}/candidates/${LINKED_CANDIDATE_ID}` },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/candidates/${LINKED_CANDIDATE_ID}/merge` },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/candidates/${LINKED_CANDIDATE_ID}/close` },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/candidates/${LINKED_CANDIDATE_ID}/approve` },
    { method: 'POST', url: `/api/projects/${PROJECT_ID}/candidates/${LINKED_CANDIDATE_ID}/decision` },
  ];
  for (const attempt of attempts) {
    const response = await h.app.inject({
      method: attempt.method,
      url: attempt.url,
      headers: { cookie: COOKIE, [CSRF_HEADER]: CSRF },
      payload: {},
    });
    assert.equal(response.statusCode, 404, `${attempt.method} ${attempt.url} must not exist: ${response.body}`);
  }
  assert.deepEqual(h.port?.linkCommands, []);
  assert.deepEqual(h.port?.readCommands, []);
  assert.equal(h.port?.providerReads, 0);
});

test('mvp-spec 3: an unscoped candidate path does not exist', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  for (const url of ['/api/candidates', `/api/candidates/${LINKED_CANDIDATE_ID}`, '/api/projects/candidates']) {
    const response = await h.app.inject({ method: 'GET', url, headers: { cookie: COOKIE } });
    assert.equal(response.statusCode, 404, `${url} must not exist: ${response.body}`);
  }
});

test('mvp-spec F01-AC1: a candidate route needs a session, and a write needs a forgery token', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const anonymousRead = await h.app.inject({
    method: 'GET',
    url: `/api/projects/${PROJECT_ID}/candidates/${LINKED_CANDIDATE_ID}`,
  });
  assert.equal(anonymousRead.statusCode, 401);
  assert.equal(parse<ProblemResponse>(anonymousRead).signInRequired, true);

  const anonymousLink = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/candidates`,
    payload: linkBody(),
  });
  assert.equal(anonymousLink.statusCode, 401);

  const noToken = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/candidates`,
    headers: { cookie: COOKIE },
    payload: linkBody(),
  });
  assert.equal(noToken.statusCode, 403, noToken.body);
  assert.deepEqual(h.port?.linkCommands, []);
});

test('mvp-spec F01-AC1: a link body cannot claim the owner, the project or the instant', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  for (const field of ['actor', 'ownerId', 'projectId', 'observedAt', 'linkedAt']) {
    const response = await link(h, linkBody({ [field]: 'anything' }));
    assert.equal(response.statusCode, 400, `${field} must be refused: ${response.body}`);
  }
  assert.deepEqual(h.port?.linkCommands, []);
});

test('F02-AC4: a deployment that composed no candidate port says so, and does not claim the project has none', async (t) => {
  const h = await harness(null);
  t.after(() => h.close());

  for (const response of [await link(h, linkBody()), await read(h), await refresh(h)]) {
    assert.equal(response.statusCode, 503, response.body);
    const problem = parse<ProblemResponse>(response);
    assert.equal(problem.error.code, 'Unavailable');
    assert.match(problem.error.message, /no GitHub candidate port/i);
    assert.equal(/no linked candidate/i.test(problem.error.message), false);
  }
});

test('F02-AC4: a controller surface carrying something other than the port is not mistaken for one', async () => {
  assert.equal(candidateUseCasesOf(controllerWith(null)), null);
  assert.equal(
    candidateUseCasesOf(controllerWith({ linkCandidate: () => undefined } as unknown as CandidateUseCases)),
    null,
    'a half-implemented port is not a port',
  );
  const port = new CandidatePortDouble(scripted());
  assert.equal(candidateUseCasesOf(controllerWith(port)), port);
});

test('F02-AC4: a project id that is a path is refused rather than addressed', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await h.app.inject({
    method: 'GET',
    url: `/api/projects/${encodeURIComponent('../other')}/candidates/${LINKED_CANDIDATE_ID}`,
    headers: { cookie: COOKIE },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(h.port?.readCommands, []);
});
