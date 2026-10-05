/**
 * The candidate routes, driven against the real controller surface (F02-AC4, F11-AC1, F24-AC4).
 *
 * ## Why this file exists
 *
 * `candidates.test.ts` binds the port in `routes/candidates.ts` to a hand-built double and
 * proves the transport against it: validation, the refusal mapping, and the projection that
 * decides what a response is allowed to claim. What it cannot see is whether the *shipped*
 * controller carries the port at all — and it did not. The routes resolved `candidates` at run
 * time through `candidateUseCasesOf`, `CompositionRoot` already had `candidateLinkUseCases`, and
 * nothing connected them, so every candidate request on a real deployment answered
 *
 *     503 This deployment composed no GitHub candidate port, so no candidate can be linked,
 *         read or refreshed.
 *
 * on a deployment that had a git provider configured and a candidate recorded. Both halves were
 * green: the route's double answered, and the controller's use-case suite answered. Only the seam
 * between them was untested, which is the same class of defect this file was written for in
 * `handoff.test.ts` (F01-AC1, F11-AC2).
 *
 * ## What is real here, and what is not
 *
 * Real: `createCompositionRoot` over a real migrated SQLite file, `bindControllerSurface`, the
 * shipped `buildApp`, the session guard, CSRF, `app.inject()`, and every use case behind them.
 * The link is performed over HTTP and the read is answered from a live provider read.
 *
 * Substituted: the git provider. It is a scripted `CandidateGitPort` — the two reads, and
 * nothing else — handed to the composition root through the same `providers` seam an operator
 * configures. No network call is made and no real pull request is read, closed or merged. The
 * port carries no write method, so nothing in this file could mutate a provider even by mistake
 * (F03-AC5, N05-AC2).
 *
 * What is proved, in order of how much it matters:
 *
 *   - `GET /api/projects/:projectId/candidates/:candidateId` answers 200 with real facts when
 *     the composition root has a candidate port — the defect this file exists to close;
 *   - the facts are the provider's: full 40-character SHAs, the pull request number, the base
 *     branch, the provider state, the check results, and a readiness derived from those same
 *     checks rather than asserted (mvp-spec 3, F20-AC2, F24-AC4);
 *   - a deployment composed with no git provider still answers 503 naming the missing wiring,
 *     and still refuses *before* anything claims to have been read (F02-AC4, F03-AC2).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { err, ok, SESSION_COOKIE_NAME } from '@shiploop/domain';
import type { CapabilityDeclaration, CapabilityKind, ConnectorId } from '@shiploop/domain';
import type { FastifyInstance } from 'fastify';
import type { ConnectorKind } from '@shiploop/storage';
import type { ProviderId, Result } from '@shiploop/domain';
import type {
  AdapterCapabilities,
  AdapterCompatibility,
  AdapterContext,
  CandidateGitPort,
  LinkedPullRequestFacts,
  ProviderCheckObservation,
  ReadChecksRequest,
  ReadLinkedPullRequestRequest,
} from '@shiploop/adapters';
import { ADAPTER_CONTRACT_VERSION } from '@shiploop/adapters';
import {
  bindControllerSurface,
  createCompositionRoot,
  type AdapterRegistry,
  type CompositionRoot,
} from '@shiploop/controller';

/**
 * The provider registry the composition root accepts.
 *
 * Taken as the root's own published type rather than imported from `providers.ts`, which the
 * package's entry point does not export: the seam under test is "what an operator's configuration
 * produces", and this is exactly the value shape that seam takes (F03-AC1).
 */
type ProviderRegistry = NonNullable<CompositionRoot['providers']>;
import { buildApp } from '../app.ts';
import { CSRF_HEADER } from '../auth-guard.ts';
import { readServerConfig } from '../config.ts';
import type { ContractView, ControllerSurface, RequestView } from '../contracts.ts';

const NOW = '2026-10-05T09:00:00.000Z';
const DISPLAY_NAME = 'Solo Owner';
const PASSWORD = 'correct horse battery staple';
const PROJECT_ID = 'checkout';
const CSRF_SECRET = ['server', 'secret', 'material', '0123456789abcdef'].join('-');
const FAST_PASSWORD_COST = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16 };
const IDLE_TIMEOUT_SECONDS = 900;

const REPOSITORY = 'octopus/shop';
const PULL_REQUEST_NUMBER = 7;
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BASE_SHA = 'fedcba98765432100123456789abcdefabcdef01';
const REQUIRED_CHECK = 'typecheck';

/* -------------------------------------------------------------------------- */
/* The scripted provider                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the provider reports for the one pull request under test.
 *
 * Mutable so a case can move the head between two reads, which is what makes a refresh an
 * observation rather than a replay of the first answer (F24-AC4).
 */
interface ProviderFacts {
  readonly state: 'Open' | 'Closed' | 'Merged';
  readonly draft: boolean;
  readonly headSha: string;
  readonly headRepository: string | null;
  readonly checks: readonly ProviderCheckObservation[];
}

function defaultFacts(): ProviderFacts {
  return {
    state: 'Open',
    draft: false,
    headSha: HEAD_SHA,
    headRepository: REPOSITORY,
    checks: [
      {
        checkId: `check_${REQUIRED_CHECK}`,
        name: REQUIRED_CHECK,
        result: 'Passed',
        requirement: 'ProfileRequired',
        startedAt: NOW,
        endedAt: NOW,
        exitCode: 0,
        detail: null,
        artifactUrl: null,
      },
    ],
  };
}

/**
 * The read-only git port, and nothing else.
 *
 * A fresh object literal naming only the two reads plus the identity surface, so a call to a
 * merge or a close from this file would not compile. That is the point of using the narrow
 * `CandidateGitPort` rather than the full `GitAdapter` (F03-AC5).
 */
class ScriptedCandidateGit implements CandidateGitPort {
  readonly kind = 'Git' as const;
  readonly connectorId = 'connector_scripted_github' as ConnectorId;
  /** Every read that actually reached the provider, so a case can count them. */
  readonly reads: string[] = [];
  facts: ProviderFacts = defaultFacts();

  capabilities(): AdapterCapabilities {
    return { kind: 'Git', contractVersion: ADAPTER_CONTRACT_VERSION, declarations: [] };
  }

  async checkCompatibility(context: AdapterContext): Promise<Result<AdapterCompatibility>> {
    return ok({
      kind: 'Git',
      contractVersion: ADAPTER_CONTRACT_VERSION,
      runtimeVersion: null,
      compatible: true,
      detail: 'A scripted provider; it contacts no provider.',
      observedAt: context.clock.now(),
    });
  }

  async readLinkedPullRequest(
    _context: AdapterContext,
    request: ReadLinkedPullRequestRequest,
  ): Promise<Result<LinkedPullRequestFacts>> {
    this.reads.push(`pull-request ${request.pullRequestNumber}`);
    if (request.pullRequestNumber !== PULL_REQUEST_NUMBER) {
      return err({
        code: 'NotFound',
        reason: `GitHub has no pull request ${request.pullRequestNumber} in ${request.repository.fullName}.`,
      });
    }
    return ok({
      repository: { ...request.repository },
      providerPullRequestId: String(PULL_REQUEST_NUMBER) as ProviderId,
      number: PULL_REQUEST_NUMBER,
      url: `https://github.com/${REPOSITORY}/pull/${PULL_REQUEST_NUMBER}`,
      state: this.facts.state,
      draft: this.facts.draft,
      headBranch: 'feature/checkout-total',
      headSha: this.facts.headSha as LinkedPullRequestFacts['headSha'],
      baseBranch: 'main',
      baseSha: BASE_SHA as LinkedPullRequestFacts['baseSha'],
      headRepository: this.facts.headRepository,
      mergedSha: this.facts.state === 'Merged' ? (this.facts.headSha as LinkedPullRequestFacts['headSha']) : null,
      mergedAt: null,
      observedAt: NOW,
    });
  }

  async readChecks(
    _context: AdapterContext,
    request: ReadChecksRequest,
  ): Promise<Result<readonly ProviderCheckObservation[]>> {
    this.reads.push(`checks ${request.headSha.slice(0, 12)}`);
    return ok(this.facts.checks);
  }
}

/**
 * The adapter registry the composition root reads its capability declarations from.
 *
 * Every capability a project profile needs is declared supported, because the profile save
 * refuses an unsupported one by name and this file is about the candidate port rather than about
 * the profile gate. Nothing here contacts a provider (F03-AC2).
 */
function adapterRegistry(): AdapterRegistry {
  const supported = (kind: CapabilityKind): CapabilityDeclaration => ({
    kind,
    supported: true,
    limitation: null,
    privileged: kind.startsWith('Deployment:') || kind === 'Git:MergeWithPrecondition',
    supportsPrecondition: false,
  });
  const byKind: Readonly<Record<ConnectorKind, readonly CapabilityKind[]>> = {
    Git: ['Git:ReadRepository', 'Git:ReadChecks', 'Git:PushBranch'],
    Ticket: ['Ticket:ReadScope', 'Ticket:UpdateManagedProgress'],
    Deployment: ['Deployment:Discover', 'Deployment:ReadIdentity'],
    Engine: ['Engine:VersionCheck', 'Engine:StartScoped'],
  };
  return {
    declarationsFor: (kind: ConnectorKind) => (byKind[kind] ?? []).map(supported),
    probeFor: () => null,
  };
}

/** The provider registry, with the scripted read-only port as the candidate git provider. */
function providerRegistry(git: ScriptedCandidateGit | null): ProviderRegistry {
  return {
    adapters: adapterRegistry(),
    ticket: null,
    // Null: adoption needs a full git adapter and this file proves the candidate journey, which
    // must not be able to reach a write (F11-AC2, F03-AC5).
    git: null,
    candidateGit: git === null ? null : git,
    engine: null,
    credentialBlocker: () => null,
  };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly app: FastifyInstance;
  readonly git: ScriptedCandidateGit | null;
  readonly close: () => Promise<void>;
}

/**
 * A real app over a real store, with or without a git provider.
 *
 * `git: null` is the deployment that configured none, which is the state the 503 exists for. It
 * still boots: a missing optional provider must produce a stated refusal at the operation rather
 * than a server that will not start (F03-AC2, F02-AC4).
 */
async function harness(git: ScriptedCandidateGit | null): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-candidate-surface-'));
  const opened = createCompositionRoot({
    databasePath: join(directory, 'shiploop.db'),
    clock: { now: () => NOW },
    adapters: adapterRegistry(),
    passwordParameters: FAST_PASSWORD_COST,
    sessionIdleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    providers: providerRegistry(git),
  });
  assert.ok(opened.ok, `the store must open: ${opened.ok ? '' : opened.error.reason}`);
  return serve(opened.value, directory, git);
}

async function serve(root: CompositionRoot, directory: string, git: ScriptedCandidateGit | null): Promise<Harness> {
  // The assignment the compiler checks: the controller's own surface declaration, proved to
  // satisfy the port `apps/web` composes against (F01-AC1).
  const controller: ControllerSurface = bindControllerSurface(root);
  const config = readServerConfig({
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_NODE_ENV: 'test',
    SHIPLOOP_COOKIE_SECURE: 'false',
    SHIPLOOP_LOG_LEVEL: 'silent',
  });
  assert.ok(config.ok, `the configuration must be accepted: ${config.ok ? '' : JSON.stringify(config.errors)}`);
  const app = await buildApp({ config: config.value, controller, now: () => new Date(NOW) });
  return {
    app,
    git,
    close: async () => {
      await app.close();
      root.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

function parse<T>(response: { readonly body: string }): T {
  return JSON.parse(response.body) as T;
}

function cookieFrom(response: { readonly headers: Record<string, string | string[] | number | undefined> }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  assert.equal(typeof header, 'string', 'sign-in must set exactly one cookie');
  const value = /^[A-Za-z0-9_]+=([^;]*)/.exec(String(header));
  assert.ok(value !== null, `the Set-Cookie header must carry a value: ${String(header)}`);
  return `${SESSION_COOKIE_NAME}=${value?.[1] ?? ''}`;
}

/** Provisions the owner, signs in, and returns the cookie and token every later call needs. */
async function signIn(app: FastifyInstance): Promise<Session> {
  const provisioned = await app.inject({
    method: 'POST',
    url: '/api/owner/provision',
    payload: { displayName: DISPLAY_NAME, password: PASSWORD },
  });
  assert.equal(provisioned.statusCode, 201, `provisioning failed: ${provisioned.body}`);
  const response = await app.inject({
    method: 'POST',
    url: '/api/owner/sign-in',
    payload: { identifier: DISPLAY_NAME, password: PASSWORD },
  });
  assert.equal(response.statusCode, 200, `sign-in failed: ${response.body}`);
  return { cookie: cookieFrom(response), csrfToken: parse<{ csrfToken: string }>(response).csrfToken };
}

/**
 * A project with a saved profile, a request and an approved contract revision.
 *
 * The profile matters: the candidate module compares a pasted address against the repository
 * *this project is configured with*, so a project with no profile has nothing to compare against
 * and every link is refused by name. Saving it over HTTP rather than seeding the row is what
 * proves the journey a browser actually takes (F11-AC2).
 */
async function approvedProject(app: FastifyInstance, session: Session): Promise<{ requestId: string; contractId: string; revision: number }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { projectId: PROJECT_ID, name: 'Checkout' },
  });
  assert.ok(created.statusCode === 200 || created.statusCode === 201, `project creation failed: ${created.body}`);

  const profile = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: {
      projectId: PROJECT_ID,
      note: 'the repository candidates are linked from',
      expectedVersionNumber: null,
      content: {
        references: {
          repository: REPOSITORY,
          ticketProvider: 'linear',
          ticketTeamKey: 'OCTO',
          baseBranch: 'main',
          targetBranch: 'main',
          deploymentProvider: 't3',
          engine: 'codex',
          previewComponents: [{ component: 'web', environment: 'preview' }],
        },
        policy: {
          requiredChecks: [REQUIRED_CHECK],
          deliveryBehavior: 'ManualAuthorizationOnly',
          maxFixPasses: 2,
          workspaceIsolation: 'WorktreeAndDataDirectory',
          capabilityVersion: 1,
        },
        recipe: 'npm ci && npm test',
        environment: { runtime: 'node', ports: [3000], secretReferences: [] },
      },
    },
  });
  assert.equal(profile.statusCode, 201, `the profile must save for a repository to compare against: ${profile.body}`);

  const request = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/requests`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { title: 'Checkout totals', description: 'The order summary shows the pre-tax total.' },
  });
  assert.equal(request.statusCode, 201, `request creation failed: ${request.body}`);
  const requestView = parse<{ request: RequestView }>(request).request;

  const drafted = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/requests/${requestView.requestId}/contracts`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: {
      outcome: 'The order summary shows the total including tax.',
      scope: ['Sum the line items before tax'],
      outOfScope: ['Changing the tax rate'],
      acceptanceCriteria: [
        { id: 'AC1', description: 'The summary returns 200.', verificationType: 'automated', verificationCheckId: REQUIRED_CHECK },
      ],
    },
  });
  assert.equal(drafted.statusCode, 201, `contract drafting failed: ${drafted.body}`);
  const contract = parse<{ contract: ContractView }>(drafted).contract;

  const approved = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/${contract.revision}/approve`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: { expectedContentFingerprint: contract.contentFingerprint },
  });
  assert.equal(approved.statusCode, 200, `approval failed: ${approved.body}`);
  return { requestId: requestView.requestId, contractId: contract.contractId, revision: contract.revision };
}

/** Links the one pull request the scripted provider knows about, over HTTP. */
async function link(app: FastifyInstance, session: Session, contract: { requestId: string; contractId: string; revision: number }): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/candidates`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: {
      requestId: contract.requestId,
      contractId: contract.contractId,
      contractRevision: contract.revision,
      pullRequestUrl: `https://github.com/${REPOSITORY}/pull/${PULL_REQUEST_NUMBER}`,
    },
  });
  assert.equal(response.statusCode, 201, `linking must succeed against a composed candidate port: ${response.body}`);
  return parse<{ candidate: { candidate: { candidateId: string } } }>(response).candidate.candidate.candidateId;
}

/** The response shape a reader sees, transcribed from the route's declared envelope. */
interface ReadBody {
  readonly candidate: {
    readonly candidate: {
      readonly candidateId: string;
      readonly projectId: string;
      readonly requestId: string;
      readonly repository: string;
      readonly pullRequestNumber: number;
      readonly baseBranch: string;
      readonly headSha: string;
      readonly baseSha: string;
      readonly pullRequestState: string;
      readonly draft: boolean;
    };
    readonly live: {
      readonly repository: string;
      readonly pullRequestNumber: number;
      readonly baseBranch: string;
      readonly headSha: string;
      readonly baseSha: string;
      readonly pullRequestState: string;
      readonly draft: boolean;
      readonly observedAt: string;
    };
    readonly binding: { readonly contractId: string; readonly contractRevision: number; readonly headSha: string };
    readonly change: {
      readonly kind: string;
      readonly changedAnything: boolean;
      readonly priorEvidenceStale: boolean;
      readonly currentHeadSha: string;
    };
    readonly evidence: { readonly status: string; readonly priorReadinessPreserved: boolean };
    readonly checks: readonly {
      readonly name: string;
      readonly result: string;
      readonly required: boolean;
      readonly blocking: boolean;
    }[];
    readonly checksReady: boolean;
    readonly blockingChecks: readonly string[];
    readonly reviewReadiness: { readonly ready: boolean; readonly reasons: readonly string[] };
    readonly providerWritePerformed: boolean;
  };
}

interface ProblemBody {
  readonly error: { readonly code: string; readonly message: string };
}

/* -------------------------------------------------------------------------- */
/* The defect                                                                  */
/* -------------------------------------------------------------------------- */

// The regression this file exists for. Before the surface carried a `candidates` group, this
// exact request answered 503 on a deployment with a git provider configured and a candidate
// recorded — and nothing in the controller's own suite could see it, because the routes were
// proven against a double that had the port by construction (F02-AC4, F11-AC1).
test('a candidate read answers 200 with the provider\'s own facts when the surface carries the port (F11-AC1, F24-AC4)', async (t) => {
  const git = new ScriptedCandidateGit();
  const h = await harness(git);
  t.after(() => h.close());
  const session = await signIn(h.app);
  const contract = await approvedProject(h.app, session);
  const candidateId = await link(h.app, session, contract);

  const readsBefore = git.reads.length;
  const response = await h.app.inject({
    method: 'GET',
    url: `/api/projects/${PROJECT_ID}/candidates/${candidateId}`,
    headers: { cookie: session.cookie },
  });

  assert.equal(
    response.statusCode,
    200,
    `a candidate read on a deployment with a composed candidate port must not answer 503: ${response.body}`,
  );
  const report = parse<ReadBody>(response).candidate;

  // The identity, at full length, on both the record and the live read. A route that returned a
  // stored row instead of a provider read would pass the candidate assertions below and fail
  // this one, because the provider is what put the head there (mvp-spec 3, F24-AC4).
  assert.equal(report.candidate.headSha, HEAD_SHA);
  assert.equal(report.live.headSha, HEAD_SHA);
  assert.equal(report.binding.headSha, HEAD_SHA);
  assert.equal(report.change.currentHeadSha, HEAD_SHA);
  assert.match(report.candidate.headSha, /^[0-9a-f]{40}$/, 'a full commit SHA is the only identity');
  assert.match(report.candidate.baseSha, /^[0-9a-f]{40}$/, 'the base is a commit too, not a branch');
  assert.equal(report.candidate.baseSha, BASE_SHA);

  // What the owner recognises: the repository, the pull request number, the base branch, and the
  // provider's own spelling of the state (mvp-spec 3, F24-AC5).
  assert.equal(report.candidate.repository, REPOSITORY);
  assert.equal(report.live.repository, REPOSITORY);
  assert.equal(report.candidate.pullRequestNumber, PULL_REQUEST_NUMBER);
  assert.equal(report.candidate.baseBranch, 'main');
  assert.equal(report.candidate.pullRequestState, 'Open');
  assert.equal(report.live.pullRequestState, 'Open');
  assert.equal(report.candidate.draft, false);
  assert.equal(report.candidate.candidateId, candidateId);
  assert.equal(report.candidate.projectId, PROJECT_ID);

  // The checks the provider reported, with the profile's required one named and satisfied. The
  // readiness answers are the route's own projection of these rows, so agreeing with them is the
  // assertion: a fabricated "ready" would disagree with the checks above it (F20-AC2, F24-AC3).
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0]?.name, REQUIRED_CHECK);
  assert.equal(report.checks[0]?.result, 'Passed');
  assert.equal(report.checks[0]?.required, true);
  assert.equal(report.checks[0]?.blocking, false);
  assert.equal(report.checksReady, true);
  assert.deepEqual(report.blockingChecks, []);
  assert.equal(report.reviewReadiness.ready, true);
  assert.deepEqual(report.reviewReadiness.reasons, []);

  // Nothing material moved during this read, and no readiness survived a push because none was
  // stored to begin with (F24-AC4, F25-AC3).
  assert.equal(report.change.changedAnything, false);
  assert.equal(report.change.priorEvidenceStale, false);
  assert.equal(report.evidence.status, 'Current');
  assert.equal(report.evidence.priorReadinessPreserved, false);

  // The read reached the provider rather than replaying the link. Two reads in total: the link's
  // pull-request read, then this one's pull-request read and check read (F24-AC4).
  assert.deepEqual(git.reads.slice(readsBefore), [
    `pull-request ${PULL_REQUEST_NUMBER}`,
    `checks ${HEAD_SHA.slice(0, 12)}`,
  ]);

  // Read-only towards the provider, as the type says (F03-AC5).
  assert.equal(report.providerWritePerformed, false);
  assert.equal(
    Object.keys(git).includes('mergePullRequest'),
    false,
    'the scripted port must hold no provider write for this journey to reach',
  );
});

// The refresh answers the same read, so the port serves all three candidate routes. Proved here
// because a wiring gap that fixed only `readCandidate` would leave the refresh broken, and this
// is the same assertion reached through a different verb (F20-AC3, F24-AC4).
test('a refresh answers the same read and reports a moved head as stale (F20-AC3, F24-AC4)', async (t) => {
  const git = new ScriptedCandidateGit();
  const h = await harness(git);
  t.after(() => h.close());
  const session = await signIn(h.app);
  const contract = await approvedProject(h.app, session);
  const candidateId = await link(h.app, session, contract);

  const moved = 'b'.repeat(40);
  // The provider has been pushed to and has not finished re-running: the required check is still
  // in progress for the new head. That is the state a refresh lands in, and it is the state that
  // matters — a green check from the previous head must not carry across (F20-AC3, F24-AC4).
  git.facts = {
    ...git.facts,
    headSha: moved,
    checks: [
      {
        checkId: `check_${REQUIRED_CHECK}`,
        name: REQUIRED_CHECK,
        result: 'Waiting',
        requirement: 'ProfileRequired',
        startedAt: NOW,
        endedAt: null,
        exitCode: null,
        detail: 'The run for this commit has not finished.',
        artifactUrl: null,
      },
    ],
  };

  const response = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/candidates/${candidateId}/refresh`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: {},
  });
  assert.equal(response.statusCode, 200, `the refresh must reach the composed port: ${response.body}`);
  const report = parse<ReadBody>(response).candidate;

  assert.equal(report.candidate.headSha, moved, 'the candidate follows the provider, not the earlier record');
  assert.equal(report.change.priorEvidenceStale, true, 'a moved head makes earlier evidence stale');
  assert.equal(report.evidence.status, 'Stale');
  assert.equal(report.evidence.priorReadinessPreserved, false, 'nothing carried forward survives a force push');
  // The new head's required check has not concluded, so the candidate is not reviewable. The
  // earlier head's `Passed` is history: it is not carried across, and a check still running is
  // never read as a pass (F20-AC2, F20-AC3).
  assert.equal(report.checks[0]?.result, 'Waiting');
  assert.equal(report.checksReady, false, 'a check that has not concluded is not a pass');
  assert.equal(report.reviewReadiness.ready, false);
  assert.deepEqual(
    [...report.blockingChecks],
    [`${REQUIRED_CHECK} is Waiting`],
    'the blocking required check is named, so the owner knows what is outstanding',
  );
  assert.equal(report.providerWritePerformed, false);
});

/* -------------------------------------------------------------------------- */
/* The refusal that must survive the fix                                       */
/* -------------------------------------------------------------------------- */

// The 503 is not a defect to be removed: it is how a deployment with no git provider says so. A
// port that answered 200 with an empty candidate instead would read as "nothing needs doing",
// which is the one answer this route must never give (F02-AC4, F03-AC2).
test('a deployment composed with no git provider still answers 503 and names the missing wiring (F02-AC4, F03-AC2)', async (t) => {
  const h = await harness(null);
  t.after(() => h.close());
  const session = await signIn(h.app);

  const read = await h.app.inject({
    method: 'GET',
    url: `/api/projects/${PROJECT_ID}/candidates/whatever`,
    headers: { cookie: session.cookie },
  });
  assert.equal(read.statusCode, 503, `a provider-less deployment must be told so by name: ${read.body}`);
  const problem = parse<ProblemBody>(read);
  assert.equal(problem.error.code, 'Unavailable');
  assert.match(problem.error.message, /no GitHub candidate port/i, 'the refusal names the missing wiring');
  assert.match(problem.error.message, /nothing was recorded/i, 'and says plainly that nothing happened');
  assert.equal(
    read.body.includes(HEAD_SHA),
    false,
    'a refused read must not carry a candidate, because no candidate was read',
  );

  // The link is refused the same way, so a deployment cannot half-work: an owner cannot link on
  // a deployment that cannot read (F02-AC4).
  const linked = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/candidates`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: {
      requestId: 'req-1',
      contractId: 'ctr-1',
      contractRevision: 1,
      pullRequestUrl: `https://github.com/${REPOSITORY}/pull/${PULL_REQUEST_NUMBER}`,
    },
  });
  assert.equal(linked.statusCode, 503, `the link must be refused the same way: ${linked.body}`);
  assert.match(parse<ProblemBody>(linked).error.message, /no GitHub candidate port/i);
});

// The refusal is not a substitute for the session gate: an anonymous caller is refused before the
// missing wiring is discussed, so a deployment's configuration is not public information (F01-AC1).
test('an anonymous caller is refused before the missing wiring is named (F01-AC1, F02-AC4)', async (t) => {
  const h = await harness(null);
  t.after(() => h.close());

  const response = await h.app.inject({
    method: 'GET',
    url: `/api/projects/${PROJECT_ID}/candidates/whatever`,
  });
  assert.equal(response.statusCode, 401, `a private read needs a session: ${response.body}`);
  assert.equal(response.body.includes('candidate port'), false, 'the refusal must not discuss the deployment');
});