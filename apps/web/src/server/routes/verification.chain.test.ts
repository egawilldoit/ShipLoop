/**
 * The automated eligibility chain, end to end, over HTTP against the shipped composition.
 *
 * The tests beside this one each prove one link: that a body cannot state a result, that a
 * stale row cannot be read as current, that a required check is not the same thing as a
 * criterion. None of them proves the chain *closes*, and that is the claim this file exists
 * for. A product can satisfy every one of those independently and still never take a candidate
 * from `unverified` to eligible, because the links can disagree about what "verified" names.
 *
 * So this file walks one candidate the whole way, over the real routes, through the real
 * composition root and a real migrated SQLite file:
 *
 *   project → request → Delivery Contract → an automated criterion bound to a stable check
 *   identity → the owner approves the exact fingerprint of the text they read → a candidate at
 *   SHA A → the provider reports the required verification for SHA A → `POST .../verify` →
 *   evidence materialized in SQLite → criterion `passed` → the card eligible.
 *
 * Every state before the last step is asserted as well, so a chain that passes because it
 * skipped a link cannot pass here: `unverified` before the verify, no evidence row before it,
 * and eligibility false until the write lands. The final `readyForAcceptance` is read back from
 * a second HTTP request rather than from the verify response, so it is the durable state a
 * later reader sees and not the value the write returned.
 *
 * The negatives are the point of the other half of this file. Each drives a real use case
 * through the same routes and each is a separate test, because "the same check on another
 * commit", "the right check name on the wrong commit", "the wrong check" and "a check that did
 * not run" fail for four different reasons and a suite that merged them would pass while any
 * one of the four was reachable.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SESSION_COOKIE_NAME } from '@shiploop/domain';
import type {
  CandidateId,
  CapabilityDeclaration,
  CapabilityKind,
  CheckResult,
  CommitSha,
  DomainError,
  ProjectId,
  Result,
} from '@shiploop/domain';
import type { FastifyInstance } from 'fastify';
import { DeliveryCandidateRepository, SqliteMvpReviewStore } from '@shiploop/storage';
import type { ConnectorKind } from '@shiploop/storage';
import {
  bindControllerSurface,
  createCompositionRoot,
  type AdapterRegistry,
  type CompositionRoot,
} from '@shiploop/controller';
/**
 * The registry's own type, read off the composition configuration that accepts it.
 *
 * Reached the way `verification.test.ts` reaches it: the controller deliberately does not
 * export the provider registry, and widening a published surface so a test could name it would
 * be a change to what consumers can reach. This keeps the fixture honest — it is exactly what
 * the production root accepts.
 */
type ProviderRegistry = NonNullable<Parameters<typeof createCompositionRoot>[0]['providers']>;

import { buildApp } from '../app.ts';
import { CSRF_HEADER } from '../auth-guard.ts';
import { readServerConfig } from '../config.ts';
import type {
  ContractView,
  ControllerSurface,
  MvpReviewCardView,
  MvpVerificationReportView,
  RequestView,
} from '../contracts.ts';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const NOW = '2026-10-03T09:00:00.000Z';
const LATER = '2026-10-03T10:00:00.000Z';
const DISPLAY_NAME = 'Solo Owner';
const PASSWORD = 'correct horse battery staple';
const PROJECT_ID = 'checkout';
const CSRF_SECRET = ['server', 'secret', 'material', '0123456789abcdef'].join('-');
const FAST_PASSWORD_COST = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16 };

/** SHA A: the commit under review. 40 characters, because an abbreviation is not identity. */
const SHA_A = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
/** SHA B: a third distinct full commit, used as "the commit the provider moved to". */
const SHA_B = 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3';
const BASE_SHA = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
const CANDIDATE_ID = 'cand-checkout';

const REQUEST_TITLE = 'Checkout totals';
const REQUEST_DESCRIPTION = 'The order summary shows the pre-tax total.';
const AUTOMATED_CRITERION_ID = 'AC1';
const OWNER_CRITERION_ID = 'AC2';

/**
 * The check identity AC1 is bound to.
 *
 * A check *name*, not a run id and not a display label: the same string for every run of the
 * same check, which is what lets a re-run on a new commit re-verify the criterion rather than
 * invalidate the binding. It is the same vocabulary the project profile's `requiredChecks` uses,
 * and the only identity that exists on both sides of the comparison (F23-AC1).
 */
const REQUIRED_CHECK = 'unit';

/** A second check the contract does not bind, for the wrong-identity case. */
const OTHER_CHECK = 'lint';

const AUTOMATED_CRITERION = {
  id: AUTOMATED_CRITERION_ID,
  description: 'The unit suite passes on the candidate commit.',
  verificationType: 'automated',
  verificationCheckId: REQUIRED_CHECK,
} as const;

const OWNER_CRITERION = {
  id: OWNER_CRITERION_ID,
  description: 'The owner confirms the total matches the invoice they were sent.',
  verificationType: 'owner_test',
  verificationCheckId: null,
} as const;

/**
 * Every capability `requiredCapabilities` in `profiles.ts` asks a profile's providers for.
 *
 * Listed as data so a widening of that requirement fails this fixture loudly rather than
 * silently producing a project whose profile cannot be saved at all (F03-AC2).
 */
const EVERY_CAPABILITY: readonly CapabilityKind[] = [
  'Git:ReadRepository',
  'Git:ReadChecks',
  'Git:PushBranch',
  'Ticket:ReadScope',
  'Ticket:UpdateManagedProgress',
  'Engine:VersionCheck',
  'Engine:StartScoped',
  'Deployment:Discover',
  'Deployment:ReadIdentity',
];

/**
 * An adapter registry that declares every capability a profile requires.
 *
 * The profile gate refuses a saved profile whose capabilities no configured adapter declares,
 * and the candidate read needs a saved profile. The declarations say the capability exists;
 * nothing here is contacted except through `candidateGit`, which is scripted separately, so a
 * case that passes is not evidence that GitHub was reachable (F03-AC2, N05-AC2).
 */
function declaringAdapters(): AdapterRegistry {
  return {
    declarationsFor(kind: ConnectorKind): readonly CapabilityDeclaration[] {
      return EVERY_CAPABILITY.filter((capability) => capability.startsWith(`${kind}:`)).map((capability) => ({
        kind: capability,
        supported: true,
        limitation: null,
        privileged: false,
        supportsPrecondition: false,
      }));
    },
    probeFor() {
      return null;
    },
  };
}

/** What the scripted provider reports, and the commit its pull request holds. */
interface ProviderScript {
  /** The checks the provider's suite reports, in its own vocabulary. */
  readonly checks: readonly { readonly name: string; readonly result: CheckResult }[];
  /**
   * The commit the provider says the pull request holds.
   *
   * Mutable, so a case can verify SHA A and then move the pull request to SHA B and verify
   * again — which is the state a push leaves behind and the one the negatives turn on.
   */
  headSha: string;
}

/**
 * A registry publishing a scripted read-only candidate port.
 *
 * Built through the shape the production root narrows to — two reads and no write — so the
 * port the verification path reaches is the read-only one. It answers the pull request and the
 * check list and nothing else, which means every verdict asserted below was produced by the
 * provider facts going through `readCandidate`, `projectCandidateChecks` and
 * `recordGitHubProjection` rather than asserted by this file (F20-AC2, F03-AC5).
 */
function providerRegistry(script: ProviderScript): ProviderRegistry {
  return {
    adapters: declaringAdapters(),
    ticket: null,
    git: null,
    engine: null,
    candidateGit: {
      kind: 'Git',
      async readLinkedPullRequest(
        _context: unknown,
        request: { readonly pullRequestNumber: number },
      ): Promise<Result<unknown, DomainError>> {
        return {
          ok: true,
          value: {
            repository: { provider: 'github', fullName: 'octopus/shop', defaultBranch: 'main' },
            providerPullRequestId: `pr_${request.pullRequestNumber}`,
            number: request.pullRequestNumber,
            url: `https://github.com/octopus/shop/pull/${request.pullRequestNumber}`,
            state: 'Open',
            draft: false,
            headBranch: 'feature/checkout-total',
            headSha: script.headSha,
            baseBranch: 'main',
            baseSha: BASE_SHA,
            headRepository: 'octopus/shop',
            mergedSha: null,
            mergedAt: null,
            observedAt: LATER,
          },
        };
      },
      async readChecks(): Promise<Result<unknown[], DomainError>> {
        return {
          ok: true,
          value: script.checks.map((entry) => ({
            // A stable per-check identity distinct from the name, so a case that confused the
            // two would be caught rather than accidentally agreeing.
            checkId: `check_${entry.name}`,
            name: entry.name,
            result: entry.result,
            requirement: 'ProviderExtra',
            startedAt: LATER,
            endedAt: LATER,
            exitCode: entry.result === 'Passed' ? 0 : 1,
            detail: `${entry.name} reported ${entry.result}`,
            artifactUrl: null,
          })),
        };
      },
    },
    credentialBlocker: () => null,
  } as unknown as ProviderRegistry;
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

interface Seed {
  readonly requestId: string;
  readonly contractId: string;
  readonly revision: number;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly root: CompositionRoot;
  readonly session: Session;
  readonly seed: Seed;
  /** The provider script, so a case can move the pull request mid-test. */
  readonly script: ProviderScript;
  readonly verify: () => Promise<{ readonly status: number; readonly body: string }>;
  readonly ownerTest: (
    criterionId: string,
    payload: Record<string, unknown>,
  ) => Promise<{ readonly status: number; readonly body: string }>;
  readonly accept: () => Promise<{ readonly status: number; readonly body: string }>;
  /** A second read of the card, so a claim about durable state is not the verify response. */
  readonly review: () => Promise<{ readonly status: number; readonly card: MvpReviewCardView | null; readonly raw: string }>;
  /** The evidence rows as the store rebuilds them, with no projection in the way. */
  readonly storedEvidence: () => { readonly count: number; readonly headShas: readonly (string | null)[] };
  readonly close: () => Promise<void>;
}

/**
 * The whole journey, over HTTP, on a real store.
 *
 * The owner, the project, the request, the contract draft and its approval are all produced by
 * the shipped routes rather than written into the database, so every fact the card reads is one
 * the product would have recorded for an owner who walked the journey. Only the candidate row is
 * written through the delivery candidate store, because linking one needs a GitHub credential
 * the MVP is not allowed to require — the same seam `routes/verification.test.ts` uses, and for
 * the same stated reason.
 */
async function harness(
  script: ProviderScript,
  options: { readonly requiredChecks?: readonly string[] } = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-eligibility-chain-'));
  const instant = Date.parse(NOW);
  const at = (): string => new Date(instant).toISOString();

  const opened = createCompositionRoot({
    databasePath: join(directory, 'shiploop.db'),
    clock: { now: at },
    adapters: declaringAdapters(),
    providers: providerRegistry(script),
    passwordParameters: FAST_PASSWORD_COST,
    sessionIdleTimeoutSeconds: 900,
  });
  assert.ok(opened.ok, `the store must open: ${opened.ok ? '' : opened.error.reason}`);
  const root = opened.value;

  const config = readServerConfig({
    SHIPLOOP_CSRF_SECRET: CSRF_SECRET,
    SHIPLOOP_NODE_ENV: 'test',
    SHIPLOOP_COOKIE_SECURE: 'false',
    SHIPLOOP_LOG_LEVEL: 'silent',
  });
  assert.ok(config.ok, `the configuration must be accepted: ${config.ok ? '' : JSON.stringify(config.errors)}`);

  const controller: ControllerSurface = bindControllerSurface(root);
  const app = await buildApp({ config: config.value, controller, now: () => new Date(instant) });

  const session = await signIn(app);
  const seed = await approvedContract(app, session);
  // The candidate read resolves the repository and the required check names from the project's
  // *saved profile*, never from the request. Saved over HTTP for the same reason the request and
  // the contract are: a profile written straight into the store would prove the transport while
  // disagreeing with the product about what a real owner's project holds.
  await saveProfile(app, session, options.requiredChecks ?? [REQUIRED_CHECK]);

  const recorded = new DeliveryCandidateRepository(root.database).record({
    candidateId: CANDIDATE_ID as CandidateId,
    projectId: PROJECT_ID as ProjectId,
    requestId: seed.requestId,
    contractId: seed.contractId,
    contractRevision: seed.revision,
    provider: 'github',
    repository: 'octopus/shop',
    pullRequestNumber: 42,
    pullRequestUrl: 'https://github.com/octopus/shop/pull/42',
    baseBranch: 'main',
    baseSha: BASE_SHA as CommitSha,
    headBranch: 'feature/checkout-total',
    headSha: SHA_A as CommitSha,
    headRepository: 'octopus/shop',
    pullRequestState: 'Open',
    draft: false,
    observedAt: NOW,
    correlationId: 'seed-candidate',
  });
  assert.ok(recorded.ok, `the candidate row must be recorded: ${recorded.ok ? '' : recorded.error.reason}`);

  const authenticated = { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken };

  return {
    app,
    root,
    session,
    seed,
    script,
    verify: async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/verify`,
        headers: authenticated,
      });
      return { status: response.statusCode, body: response.body };
    },
    ownerTest: async (criterionId, payload) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/criteria/${criterionId}/owner-test`,
        headers: authenticated,
        payload,
      });
      return { status: response.statusCode, body: response.body };
    },
    accept: async () => {
      // Names the commit and revision the card was rendered against, which is what a real
      // owner's page holds: the two values the submission must carry for the guard to accept it.
      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/decision`,
        headers: authenticated,
        payload: { decision: 'accepted', expectedHeadSha: SHA_A, expectedContractRevision: seed.revision, feedback: null },
      });
      return { status: response.statusCode, body: response.body };
    },
    review: async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJECT_ID}/candidates/${CANDIDATE_ID}/review`,
        headers: { cookie: session.cookie },
      });
      return {
        status: response.statusCode,
        card: (JSON.parse(response.body) as { review?: MvpReviewCardView }).review ?? null,
        raw: response.body,
      };
    },
    storedEvidence: () => {
      // Read through the store rather than through the card, so "evidence was materialized"
      // is a statement about SQLite rather than about a projection of it.
      const projection = new SqliteMvpReviewStore(root.database).readProjection({
        candidateId: CANDIDATE_ID,
        candidateHeadSha: SHA_A as CommitSha,
        contractId: seed.contractId,
        contractRevision: seed.revision,
      });
      assert.ok(projection.ok, `the projection must be readable: ${projection.ok ? '' : projection.error.reason}`);
      return {
        count: projection.value.evidence.length,
        headShas: projection.value.evidence.map((row) => row.observedHeadSha),
      };
    },
    close: async () => {
      await app.close();
      root.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function parse<T>(body: string): T {
  return JSON.parse(body) as T;
}

function cookieFrom(response: { readonly headers: Record<string, string | string[] | number | undefined> }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  assert.equal(typeof header, 'string', 'sign-in must set exactly one cookie');
  const value = /^[A-Za-z0-9_]+=([^;]*)/.exec(String(header));
  assert.ok(value !== null, `the Set-Cookie header must carry a value: ${String(header)}`);
  return `${SESSION_COOKIE_NAME}=${value?.[1] ?? ''}`;
}

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
  return { cookie: cookieFrom(response), csrfToken: parse<{ csrfToken: string }>(response.body).csrfToken };
}

/**
 * A project, a request and an approved revision, built entirely over HTTP.
 *
 * The approval names the fingerprint the draft read returned. An approval that did not would be
 * refused by the compare-and-set guard, so this is the same token a real owner's page holds
 * rather than a value invented here.
 */
async function approvedContract(app: FastifyInstance, session: Session): Promise<Seed> {
  const headers = { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken };

  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers,
    payload: { projectId: PROJECT_ID, name: 'Checkout' },
  });
  assert.ok(created.statusCode === 200 || created.statusCode === 201, `project creation failed: ${created.body}`);

  const requested = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/requests`,
    headers,
    payload: { title: REQUEST_TITLE, description: REQUEST_DESCRIPTION },
  });
  assert.equal(requested.statusCode, 201, `request creation failed: ${requested.body}`);
  const request = parse<{ request: RequestView }>(requested.body).request;

  const drafted = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/requests/${request.requestId}/contracts`,
    headers,
    payload: {
      outcome: 'The order summary shows the total including tax.',
      scope: ['Sum the line items before tax'],
      outOfScope: ['Changing the tax rate'],
      acceptanceCriteria: [AUTOMATED_CRITERION, OWNER_CRITERION],
    },
  });
  assert.equal(drafted.statusCode, 201, `contract drafting failed: ${drafted.body}`);
  const contract = parse<{ contract: ContractView }>(drafted.body).contract;

  // The binding is part of the material content, so the fingerprint below covers the check the
  // automated criterion names. Asserted rather than assumed, because the whole chain turns on it.
  assert.equal(
    contract.acceptanceCriteria[0]?.verificationCheckId,
    REQUIRED_CHECK,
    'the draft carries the check identity the criterion is bound to',
  );

  const approved = await app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/contracts/${contract.contractId}/${contract.revision}/approve`,
    headers,
    payload: { expectedContentFingerprint: contract.contentFingerprint },
  });
  assert.equal(approved.statusCode, 200, `approval failed: ${approved.body}`);
  return { requestId: request.requestId, contractId: contract.contractId, revision: contract.revision };
}

/** The saved profile a project needs before a candidate can be compared to a repository. */
async function saveProfile(app: FastifyInstance, session: Session, requiredChecks: readonly string[]): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    payload: {
      projectId: PROJECT_ID,
      content: {
        references: {
          repository: 'octopus/shop',
          ticketProvider: 'linear',
          ticketTeamKey: null,
          baseBranch: 'main',
          targetBranch: 'main',
          deploymentProvider: 'none',
          engine: 'none',
          previewComponents: [{ component: 'web', environment: 'preview' }],
        },
        policy: {
          requiredChecks: [...requiredChecks],
          deliveryBehavior: 'ManualAuthorizationOnly',
          maxFixPasses: 2,
          workspaceIsolation: 'WorktreeAndDataDirectory',
          capabilityVersion: 1,
        },
        recipe: 'pnpm test',
        environment: { runtime: 'node24', ports: [4100], secretReferences: [] },
      },
      note: null,
      expectedVersionNumber: null,
    },
  });
  assert.equal(response.statusCode, 201, `the profile must save: ${response.body}`);
}

/** The criterion AC1 as the card states it, or a failure naming what is there instead. */
function criterionOf(card: MvpReviewCardView | null): NonNullable<MvpReviewCardView['criteria'][number]> {
  assert.ok(card !== null, 'the card must be readable');
  const criterion = card.criteria.find((entry) => entry.criterionId === AUTOMATED_CRITERION_ID);
  assert.ok(criterion !== undefined, `AC1 must be on the card: ${JSON.stringify(card.criteria)}`);
  return criterion;
}

/* -------------------------------------------------------------------------- */
/* The chain                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The chain, every link of it, from a project to an eligible review.
 *
 * Each step asserts the state it produced as well as the transition, because a chain that
 * skipped a link could otherwise reach the last assertion by accident: a criterion that was
 * never `unverified` was never verified either.
 *
 * The final readiness is read from a second HTTP request rather than from the verify response,
 * so the claim is about the durable state a later reader sees — not about a value the write
 * happened to return (F24-AC2, F24-AC3).
 */
test('F20-AC2, F23-AC1, F24-AC3: an approved contract, a bound criterion and a provider pass on SHA A make the candidate eligible', async (t) => {
  const h = await harness({ checks: [{ name: REQUIRED_CHECK, result: 'Passed' }], headSha: SHA_A });
  t.after(() => h.close());

  /* Link 1-4: project, request, contract, automated criterion bound to a stable check id. */
  assert.equal(h.seed.revision, 1);
  const before = await h.review();
  assert.equal(before.status, 200, before.raw);
  assert.ok(before.card !== null, before.raw);

  assert.equal(before.card.request.projectId, PROJECT_ID);
  assert.equal(before.card.contract.contractId, h.seed.contractId);
  assert.equal(before.card.contract.revision, 1);
  assert.equal(before.card.contract.status, 'approved', 'the revision was approved, by an owner, over a fingerprint');
  assert.ok(before.card.contract.approval.approvedAt !== null);
  assert.ok(before.card.contract.approval.approvedBy !== null);

  const bound = before.card.contract.acceptanceCriteria.find((entry) => entry.id === AUTOMATED_CRITERION_ID);
  assert.equal(
    bound?.verificationCheckId,
    REQUIRED_CHECK,
    'the approved revision names the check that verifies the criterion, so the binding is in the fingerprint it was sealed over',
  );

  /* Link 5: the candidate is at SHA A, and nothing has been verified against it yet. */
  assert.equal(before.card.candidate.headSha, SHA_A);
  assert.equal(before.card.candidate.contractRevision, 1);
  assert.deepEqual(before.card.evidence, [], 'no observation exists before the verify');
  assert.equal(h.storedEvidence().count, 0, 'and none is in the database either');

  const criterionBefore = criterionOf(before.card);
  assert.equal(criterionBefore.state, 'unverified', 'nothing observed the criterion, so nothing verified it');
  assert.notEqual(criterionBefore.state, 'passed');
  assert.equal(criterionBefore.verificationCheckId, REQUIRED_CHECK, 'reported from the binding, not inferred');
  assert.equal(criterionBefore.evidenceId, null);

  /* Link 6-7: the provider reports the required verification for SHA A; the owner asks. */
  const verified = await h.verify();
  assert.equal(verified.status, 200, `the verify must succeed: ${verified.body}`);
  const report = parse<{ verification: MvpVerificationReportView }>(verified.body).verification;

  assert.equal(report.method, 'github_checks', 'the source is named, and it is the provider read');
  assert.equal(report.candidateHeadSha, SHA_A, 'the report is bound to the candidate on screen');
  assert.equal(report.providerHeadSha, SHA_A, 'and the provider still holds that commit');
  assert.equal(report.contractRevision, 1);
  assert.equal(report.recorded.length, 1, 'one provider check produced one observation');

  const observation = report.recorded[0];
  assert.ok(observation !== undefined);
  assert.equal(
    observation.checkId,
    REQUIRED_CHECK,
    'the observation speaks for the check identity the criterion is bound to, compared by name and not by position',
  );
  assert.equal(observation.recordedOutcome, 'passed');
  assert.equal(observation.currentOutcome, 'passed');
  assert.equal(observation.countsForCurrentCandidate, true);
  assert.equal(
    observation.observedHeadSha,
    SHA_A,
    'the run is attributed to the full SHA, so the binding comparison downstream is meaningful',
  );
  assert.equal(observation.observedContractRevision, 1);

  /* Link 8: the evidence was materialized, not merely returned. */
  const stored = h.storedEvidence();
  assert.equal(stored.count, 1, 'exactly one row was written for one check');
  assert.deepEqual(
    stored.headShas,
    [SHA_A],
    'and the durable row carries the observed commit rather than a null (F20-AC3)',
  );

  /* Link 9: the criterion reads passed, on a second read of the card. */
  const after = await h.review();
  assert.equal(after.status, 200, after.raw);
  assert.ok(after.card !== null, after.raw);

  const criterionAfter = criterionOf(after.card);
  assert.equal(criterionAfter.state, 'passed', 'the criterion its bound check verifies now reads passed');
  assert.equal(criterionAfter.methodKind, 'AutomatedCheck');
  assert.equal(criterionAfter.methodDetail, REQUIRED_CHECK);
  assert.equal(criterionAfter.evidenceId, observation.evidenceId, 'and it names the observation that did it');
  assert.ok(criterionAfter.observedAt !== null, 'with the instant the run reported');

  // The card and the durable row agree about the same observation, which is what makes the card
  // self-consistent rather than two reads that could disagree (F24-AC2).
  const row = after.card.evidence.find((entry) => entry.evidenceId === observation.evidenceId);
  assert.ok(row !== undefined, 'the recorded observation is on the card');
  assert.equal(row.source, 'github_check');
  assert.equal(row.checkId, REQUIRED_CHECK);
  assert.equal(row.criterionId, null, 'a check result speaks for the check, and the criterion reads it');
  assert.equal(row.candidateHeadSha, SHA_A);
  assert.equal(row.countsForCurrentCandidate, true);
  assert.equal(row.currentOutcome, 'passed');

  const check = after.card.checks.find((entry) => entry.checkId === REQUIRED_CHECK);
  assert.equal(check?.result, 'passed');
  assert.equal(check?.required, true, 'the project profile requires this check, and the card says so');
  assert.equal(check?.blocking, false);

  /* Link 10: the review is eligible — and only the automated criterion stands in the way. */
  assert.equal(
    after.card.eligibility.readyForOwnerReview,
    true,
    'the automated criterion is satisfied and no required check is outstanding, so the review offer is made',
  );
  assert.deepEqual(after.card.eligibility.blockingReasons, []);
  assert.equal(
    after.card.eligibility.readyForAcceptance,
    false,
    'acceptance is the stricter gate: the owner has not run their own test yet (F24-AC3)',
  );
  assert.ok(
    after.card.eligibility.acceptanceBlockers.some((reason) => reason.includes(OWNER_CRITERION_ID)),
    `the owner test is named as the outstanding item: ${JSON.stringify(after.card.eligibility.acceptanceBlockers)}`,
  );
  // Matched on the criterion-id form rather than the bare id: every reason this card emits cites
  // a spec line, and `F23-AC1` contains `AC1`, so a bare substring would match the owner test's
  // own citation and pass for the wrong reason.
  assert.ok(
    !after.card.eligibility.acceptanceBlockers.some((reason) => reason.includes(`"${AUTOMATED_CRITERION_ID}"`)),
    `and the automated criterion is not among them: ${JSON.stringify(after.card.eligibility.acceptanceBlockers)}`,
  );

  /* The owner runs their own test, and the whole contract is satisfied. */
  const ownerTest = await h.ownerTest(OWNER_CRITERION_ID, { result: 'passed', note: 'The total matches the invoice.' });
  assert.equal(ownerTest.status, 200, `the owner test must record: ${ownerTest.body}`);

  const complete = await h.review();
  assert.equal(complete.status, 200, complete.raw);
  assert.ok(complete.card !== null, complete.raw);
  assert.equal(
    complete.card.criteria.find((entry) => entry.criterionId === OWNER_CRITERION_ID)?.state,
    'passed',
  );
  assert.equal(
    complete.card.eligibility.readyForAcceptance,
    true,
    'every criterion is satisfied against this commit, so acceptance is ready',
  );
  assert.deepEqual(complete.card.eligibility.acceptanceBlockers, []);
  assert.equal(
    complete.card.eligibility.readyForDelivery,
    false,
    'and delivery is still shut, because verified is not accepted and accepted is not merged (F25-AC1)',
  );

  /* The gate the owner submits against accepts, which is the chain's last link. */
  const accepted = await h.accept();
  assert.equal(accepted.status, 200, `the acceptance must be recorded: ${accepted.body}`);
  const decided = parse<{ review: MvpReviewCardView }>(accepted.body).review;
  assert.equal(decided.decision.outcome, 'accepted');
  assert.equal(decided.decision.decision?.candidateHeadSha, SHA_A, 'bound to the exact commit it was made against');
  assert.equal(decided.decision.authorizesCurrentCandidate, true);
  assert.equal(
    decided.eligibility.readyForDelivery,
    true,
    'and only now does the delivery gate open, on an acceptance that describes this candidate (F27-AC3)',
  );
});

/* -------------------------------------------------------------------------- */
/* Negative 1: the same check, on another commit                               */
/* -------------------------------------------------------------------------- */

/**
 * F20-AC3: the required check passing on SHA B proves nothing about SHA A.
 *
 * This is the state a push leaves behind and the one the whole F20-AC3 criterion is about: the
 * pull request has moved on, its CI is green, and the candidate on record has not been re-run at
 * all. The card must keep naming SHA A, must not let the newer green verify the criterion, and
 * must say why.
 *
 * Driven as a sequence rather than as one submission, because the interesting assertion is about
 * the card *after* the second verify: a card that reported the criterion `passed` and only later
 * corrected itself would still have rendered a newer build's green against the older commit for
 * as long as the owner looked at it.
 */
test('F20-AC3: the required check passing on SHA B does not verify the criterion on SHA A', async (t) => {
  const h = await harness({ checks: [{ name: REQUIRED_CHECK, result: 'Passed' }], headSha: SHA_A });
  t.after(() => h.close());

  // SHA A verifies, so the criterion is genuinely passed before anything moves.
  const first = await h.verify();
  assert.equal(first.status, 200, first.body);
  assert.equal(criterionOf((await h.review()).card).state, 'passed');

  // The push lands: the pull request now holds SHA B, and its checks are SHA B's.
  h.script.headSha = SHA_B;
  const second = await h.verify();
  assert.equal(second.status, 200, second.body);
  const report = parse<{ verification: MvpVerificationReportView }>(second.body).verification;

  assert.equal(report.candidateHeadSha, SHA_A, 'the evidence is still bound to the candidate the path named');
  assert.equal(
    report.providerHeadSha,
    SHA_B,
    'and the report names the commit the provider holds, so the difference is visible rather than hidden',
  );

  const observation = report.recorded[0];
  assert.ok(observation !== undefined);
  assert.equal(
    observation.recordedOutcome,
    'passed',
    'what the provider said is history and is reported as such',
  );
  assert.equal(observation.currentOutcome, 'stale', "but it is not SHA A's result");
  assert.equal(observation.countsForCurrentCandidate, false, "SHA B's green cannot prove SHA A");
  assert.equal(
    observation.observedHeadSha,
    null,
    'the row names no commit, so it is bound to nothing rather than half-claiming one (F20-AC3)',
  );

  const after = await h.review();
  assert.ok(after.card !== null, after.raw);
  assert.equal(after.card.candidate.headSha, SHA_A, 'the card still names the commit under review');

  // The criterion is still passed — by SHA A's own run, which is still the newest run *about
  // SHA A*. The newer run is a separate row that reads stale, and the card says so.
  const criterion = criterionOf(after.card);
  assert.equal(criterion.state, 'passed', 'SHA A still has its own passing run, which nothing retracted');
  assert.equal(
    criterion.evidenceId !== observation.evidenceId,
    true,
    'and the criterion names SHA A\'s row rather than the newer one',
  );

  const staleRow = after.card.evidence.find((entry) => entry.evidenceId === observation.evidenceId);
  assert.ok(staleRow !== undefined, 'the newer observation is shown rather than dropped');
  assert.equal(staleRow.recordedOutcome, 'passed');
  assert.equal(staleRow.currentOutcome, 'stale');
  assert.equal(staleRow.countsForCurrentCandidate, false);
  assert.ok(staleRow.staleReasons.length > 0, 'and why it no longer counts is named, not implied');

  assert.equal(after.card.staleness.stale, true, 'the card says plainly that it holds a stale observation');

  // No row on the card may expose a bare `outcome`, because that is the field a client renders
  // a stale pass from (F20-AC3, F24-AC3).
  for (const row of after.card.evidence) {
    assert.equal('outcome' in row, false, `evidence ${row.evidenceId} carries a bare outcome`);
  }
});

/**
 * F20-AC3: a candidate whose head moved is a different candidate, and it verifies from nothing.
 *
 * The other half of the previous case, and the one that would matter if a stale verdict could
 * persist: the push appends a *new* candidate row rather than editing the old one, so the
 * newer build has to start from `unverified` with no evidence of its own. A projection that
 * reached across candidate identities would report the old commit's green against the new
 * commit and this is where that would show up.
 */
test('F20-AC3, F24-AC4: after a push the new candidate carries no verdict from the old commit', async (t) => {
  const h = await harness({ checks: [{ name: REQUIRED_CHECK, result: 'Passed' }], headSha: SHA_A });
  t.after(() => h.close());

  const first = await h.verify();
  assert.equal(first.status, 200, first.body);
  assert.equal(criterionOf((await h.review()).card).state, 'passed');

  // The pull request moves. The verify route names SHA A's candidate, and its live read notices
  // the move and appends a candidate row for SHA B — the shipped behaviour, not a fixture's.
  h.script.headSha = SHA_B;
  const second = await h.verify();
  assert.equal(second.status, 200, second.body);

  // SHA A's card is unchanged by the push: its own run still describes it, and the newer run
  // reads stale beside it.
  const original = await h.review();
  assert.ok(original.card !== null, original.raw);
  assert.equal(original.card.candidate.headSha, SHA_A);
  assert.equal(criterionOf(original.card).state, 'passed');

  // The push appended a candidate for SHA B rather than editing SHA A's row. Read from the store
  // the composition itself uses, because no route lists a request's candidates: the fact under
  // test is which rows the live read left behind, and that is a question about durable state.
  const history = new DeliveryCandidateRepository(h.root.database).historyForRequest(h.seed.requestId);
  assert.ok(history.ok, `the candidate history must be readable: ${history.ok ? '' : history.error.reason}`);
  const heads = history.value.map((entry) => String(entry.headSha));
  assert.ok(heads.includes(SHA_B), `the push must append a candidate for SHA B: ${JSON.stringify(heads)}`);
  assert.ok(heads.includes(SHA_A), 'and SHA A\'s row is kept rather than rewritten, so its evidence stays meaningful');
  const pushed = history.value.find((entry) => entry.headSha === SHA_B);
  assert.ok(pushed !== undefined);

  // SHA B's card names its own commit, and has nothing verified against it.
  const pushedCard = await h.app.inject({
    method: 'GET',
    url: `/api/projects/${PROJECT_ID}/candidates/${pushed.candidateId}/review`,
    headers: { cookie: h.session.cookie },
  });
  assert.equal(pushedCard.statusCode, 200, pushedCard.body);
  const card = parse<{ review: MvpReviewCardView }>(pushedCard.body).review;

  assert.equal(card.candidate.headSha, SHA_B, 'the new candidate is at SHA B');
  const criterion = criterionOf(card);
  assert.equal(
    criterion.state,
    'unverified',
    'and SHA A\'s passing run verifies nothing about it: the criterion recomputes against the current candidate',
  );
  assert.notEqual(criterion.state, 'passed');
  assert.equal(criterion.evidenceId, null, 'and it names no evidence at all');
  assert.deepEqual(card.evidence, [], 'SHA B has no observation of its own yet');
  assert.equal(
    card.eligibility.readyForAcceptance,
    false,
    'so it is not eligible, even though the pull request\'s checks are green',
  );
});

/* -------------------------------------------------------------------------- */
/* Negative 2: the right check, on the wrong commit                            */
/* -------------------------------------------------------------------------- */

/**
 * F20-AC3: a result whose commit is not the candidate's cannot verify the criterion.
 *
 * The provider resolved the required check to `Stale` — the verdict the shipped adapter produces
 * when GitHub reports a run for a commit other than the one the read was addressed to. That is
 * the only signal the shipped contract carries for a per-check attribution, and it is the one
 * the candidate module already acts on.
 *
 * Distinct from the previous case in what produced it: there the pull request had moved, here
 * the pull request is still at SHA A and it is the *check run* that belongs to another commit.
 * The result is the same refusal, and it is reached through a different comparison, so a suite
 * that only drove the first would not have shown this one closed.
 */
test('F20-AC3: the required check reported for another commit does not verify SHA A', async (t) => {
  const h = await harness({ checks: [{ name: REQUIRED_CHECK, result: 'Stale' }], headSha: SHA_A });
  t.after(() => h.close());

  const verified = await h.verify();
  assert.equal(verified.status, 200, verified.body);
  const report = parse<{ verification: MvpVerificationReportView }>(verified.body).verification;

  const observation = report.recorded[0];
  assert.ok(observation !== undefined);
  assert.equal(
    observation.recordedOutcome,
    'missing',
    'the provider produced no result about this commit, so it is recorded as an observation of nothing rather than as a green that merely happens to be unbound (F20-AC3)',
  );
  assert.notEqual(observation.recordedOutcome, 'passed');
  assert.equal(observation.currentOutcome, 'stale');
  assert.equal(observation.countsForCurrentCandidate, false);
  assert.equal(observation.observedHeadSha, null, 'the row names no commit, so it binds to nothing');
  assert.equal(observation.observedContractRevision, null, 'and no revision either');

  const after = await h.review();
  assert.ok(after.card !== null, after.raw);
  const criterion = criterionOf(after.card);
  assert.equal(
    criterion.state,
    'stale',
    'the criterion the run spoke for does not read as verified by it',
  );
  assert.notEqual(criterion.state, 'passed');
  assert.equal(after.card.eligibility.readyForAcceptance, false);
});

/* -------------------------------------------------------------------------- */
/* Negative 3: the wrong check identity                                        */
/* -------------------------------------------------------------------------- */

/**
 * F23-AC1: a green check the criterion is not bound to does not verify it.
 *
 * The provider's suite is green — `lint` passed on SHA A, attributed to SHA A, with a durable
 * row behind it — and the criterion still cannot be verified, because the agreement bound it to
 * a different check. Treating any green automated result as interchangeable is exactly how a
 * criterion ends up "verified" by a check nobody connected it to.
 *
 * The project profile requires `lint` here, so the card also has to report the required gate as
 * satisfied while refusing to let it discharge a criterion bound elsewhere. Those are two
 * different questions and the test needs both answered to show the distinction holds.
 */
test('F23-AC1: a green check the criterion is not bound to does not verify it', async (t) => {
  const h = await harness(
    { checks: [{ name: OTHER_CHECK, result: 'Passed' }], headSha: SHA_A },
    { requiredChecks: [OTHER_CHECK] },
  );
  t.after(() => h.close());

  const verified = await h.verify();
  assert.equal(verified.status, 200, verified.body);
  const report = parse<{ verification: MvpVerificationReportView }>(verified.body).verification;
  const observation = report.recorded[0];
  assert.ok(observation !== undefined);
  assert.equal(observation.checkId, OTHER_CHECK, 'the observation is about the check that ran');
  assert.equal(observation.countsForCurrentCandidate, true, 'and it is a real pass against this commit');

  const after = await h.review();
  assert.ok(after.card !== null, after.raw);

  const requiredCheck = after.card.checks.find((entry) => entry.checkId === OTHER_CHECK);
  assert.equal(requiredCheck?.result, 'passed');
  assert.equal(requiredCheck?.required, true, "the project's own gate is satisfied");

  const criterion = criterionOf(after.card);
  assert.equal(
    criterion.state,
    'unverified',
    'and it still verifies nothing, because the agreement bound this criterion to a different check',
  );
  assert.notEqual(criterion.state, 'passed');
  assert.equal(
    criterion.verificationCheckId,
    REQUIRED_CHECK,
    'the criterion reports the identity its contract bound to it, not the one that happened to pass',
  );
  assert.equal(criterion.evidenceId, null);
  assert.ok(
    !after.card.checks.some((entry) => entry.checkId === REQUIRED_CHECK),
    'and the bound check is not even listed, because nothing has ever reported it',
  );
  assert.equal(
    after.card.eligibility.readyForAcceptance,
    false,
    'so the candidate is not eligible despite a green required check',
  );
});

/* -------------------------------------------------------------------------- */
/* Negative 4: missing, skipped and never run                                   */
/* -------------------------------------------------------------------------- */

/**
 * F20-AC2: a check the provider never ran is `missing`, which is not a pass.
 *
 * Its own test rather than a case inside another one, because `missing` is the outcome most
 * likely to be mistaken for a pass: the check is present in the card, it has a durable row, and
 * the row is bound to this exact commit — every property a pass has except the verdict.
 */
test('F20-AC2: a check the provider reports as missing does not verify the criterion', async (t) => {
  const h = await harness({ checks: [{ name: REQUIRED_CHECK, result: 'Missing' }], headSha: SHA_A });
  t.after(() => h.close());

  const verified = await h.verify();
  assert.equal(verified.status, 200, verified.body);
  const report = parse<{ verification: MvpVerificationReportView }>(verified.body).verification;

  const observation = report.recorded[0];
  assert.ok(observation !== undefined);
  assert.equal(observation.recordedOutcome, 'missing', 'a check that never ran reads missing');
  assert.notEqual(observation.recordedOutcome, 'passed');
  // It *is* attributed to this commit: the read asked about this head and the answer was
  // "nothing". Binding it is what makes the card say `missing` rather than `stale`, and neither
  // state is a pass (F20-AC2).
  assert.equal(observation.observedHeadSha, SHA_A);
  assert.equal(observation.currentOutcome, 'missing');
  assert.equal(observation.countsForCurrentCandidate, true);

  const after = await h.review();
  assert.ok(after.card !== null, after.raw);
  assert.equal(after.card.checks.find((entry) => entry.checkId === REQUIRED_CHECK)?.result, 'missing');
  const criterion = criterionOf(after.card);
  assert.equal(criterion.state, 'unverified', 'a check that did not run is not a pass (F20-AC2)');
  assert.notEqual(criterion.state, 'passed');
  assert.equal(criterion.evidenceId, observation.evidenceId, 'and the observation is still shown, so the owner sees it');
  assert.equal(after.card.eligibility.readyForAcceptance, false);
});

/**
 * F20-AC2: `NotApplicable` — a check the provider declined to run — is `missing`, not a pass.
 *
 * Separate from the `Missing` case because it is the one that reaches the card through a
 * different branch: a skipped check looks green in most CI surfaces, and a mapping that folded
 * `NotApplicable` into a pass would report it as satisfied. It also does not satisfy the
 * project's own gate, which is asserted here rather than assumed from the criterion state.
 */
test('F20-AC2: a check the provider reports as not applicable does not verify the criterion', async (t) => {
  const h = await harness({ checks: [{ name: REQUIRED_CHECK, result: 'NotApplicable' }], headSha: SHA_A });
  t.after(() => h.close());

  const verified = await h.verify();
  assert.equal(verified.status, 200, verified.body);
  const report = parse<{ verification: MvpVerificationReportView }>(verified.body).verification;

  const observation = report.recorded[0];
  assert.ok(observation !== undefined);
  assert.equal(
    observation.recordedOutcome,
    'missing',
    'a provider that declined to run the check produced no observation, and reports it as missing',
  );
  assert.notEqual(observation.recordedOutcome, 'passed');

  const after = await h.review();
  assert.ok(after.card !== null, after.raw);
  assert.equal(after.card.checks.find((entry) => entry.checkId === REQUIRED_CHECK)?.result, 'missing');
  assert.notEqual(after.card.checks.find((entry) => entry.checkId === REQUIRED_CHECK)?.result, 'passed');
  assert.equal(criterionOf(after.card).state, 'unverified');
  assert.equal(after.card.eligibility.readyForAcceptance, false, 'and a skipped required gate does not accept');
});

/**
 * F20-AC2: a required check the provider never reported at all is `not_run`, which is not a pass.
 *
 * The third member of the negative set, and the only one with no observation row behind it: the
 * provider's suite says nothing about the check, so there is no evidence to record and the
 * card's own gate has to hold it shut. `not_run` is a member of the check vocabulary rather than
 * an absence, so the gate is visible on the card instead of invisible by omission.
 */
test('F20-AC2: a required check the provider never reports is not_run, and does not accept', async (t) => {
  // The provider's suite reports only an unrelated check, so the required one is never run.
  const h = await harness(
    { checks: [{ name: OTHER_CHECK, result: 'Passed' }], headSha: SHA_A },
    { requiredChecks: [REQUIRED_CHECK] },
  );
  t.after(() => h.close());

  // Before any verify there is no row for the required check at all, and the card says
  // `not_run` — a member of the check vocabulary rather than an absence, so a dropped gate is
  // visible on the card instead of invisible by omission (F20-AC2).
  const neverRun = await h.review();
  assert.equal(neverRun.status, 200, neverRun.raw);
  assert.ok(neverRun.card !== null, neverRun.raw);
  const before = neverRun.card.checks.find((entry) => entry.checkId === REQUIRED_CHECK);
  assert.ok(before !== undefined, 'the required check is on the card even before anything ran it');
  assert.equal(before.result, 'not_run');
  assert.notEqual(before.result, 'passed');
  assert.equal(before.required, true);
  assert.equal(before.blocking, true);
  assert.equal(before.evidenceId, null);
  assert.equal(
    neverRun.card.eligibility.readyForOwnerReview,
    false,
    'the review offer is withheld before anything runs, which is F24-AC3\'s rule for missing required evidence',
  );

  // The verify records what the provider reported, and the required check the provider never
  // mentioned comes back as `missing`: observed as unmet rather than left absent, which is the
  // same rule stated from the other direction.
  const verified = await h.verify();
  assert.equal(verified.status, 200, verified.body);
  const report = parse<{ verification: MvpVerificationReportView }>(verified.body).verification;
  assert.deepEqual(
    report.recorded.map((entry) => [entry.checkId, entry.recordedOutcome]),
    [[OTHER_CHECK, 'passed'], [REQUIRED_CHECK, 'missing']],
    'the required check is recorded as never run, and no other verdict is invented for it',
  );

  const after = await h.review();
  assert.ok(after.card !== null, after.raw);
  const required = after.card.checks.find((entry) => entry.checkId === REQUIRED_CHECK);
  assert.equal(required?.result, 'missing', 'and it still does not read as passed after the verify');
  assert.equal(required?.required, true);
  assert.equal(required?.blocking, true, 'and it still blocks');

  assert.equal(criterionOf(after.card).state, 'unverified');
  assert.equal(
    after.card.eligibility.readyForAcceptance,
    false,
    'a required check that never ran cannot be accepted over (F20-AC2, F24-AC3)',
  );
  assert.ok(
    after.card.eligibility.acceptanceBlockers.some((reason) => reason.includes(REQUIRED_CHECK)),
    `and the outstanding gate is named: ${JSON.stringify(after.card.eligibility.acceptanceBlockers)}`,
  );

  // The gate the owner submits against refuses it, with the unmet requirement named.
  const refused = await h.accept();
  assert.equal(refused.status, 422, `an acceptance over a check that never ran must be refused: ${refused.body}`);
  const problem = parse<{ error: { code: string; prerequisites?: readonly { detail: string }[] } }>(refused.body).error;
  assert.equal(problem.code, 'Blocked');
  assert.ok(
    (problem.prerequisites ?? []).some((entry) => entry.detail.includes(REQUIRED_CHECK)),
    `the refusal names the gate that is unmet: ${refused.body}`,
  );
});

/* -------------------------------------------------------------------------- */
/* The policy the gate is judged under                                         */
/* -------------------------------------------------------------------------- */

/**
 * F20-AC5, F24-AC3: a red required check blocks even when every criterion is satisfied.
 *
 * The regression this file was written to catch, so it is worth stating plainly. The card used
 * to be projected under `MvpDefaultVerificationPolicy`, whose required-check list is empty, so
 * a project's declared gate was advisory: the card listed a red required check with
 * `required: false, blocking: false` and reported the candidate as eligible for acceptance. The
 * criterion was passed and the gate was red, and only the criterion was consulted.
 *
 * Both halves are asserted because either alone would pass a broken gate: the criterion being
 * passed shows the automated work really did verify, and the red `lint` shows the project's own
 * requirement still was not met. The acceptance attempt at the end is the whole point — it must
 * be refused with the failing gate named, because an acceptance recorded here would be the
 * defect.
 */
test('F20-AC5, F24-AC3: a red required check blocks acceptance even when every criterion has passed', async (t) => {
  const h = await harness(
    {
      checks: [
        { name: REQUIRED_CHECK, result: 'Passed' },
        { name: OTHER_CHECK, result: 'Failed' },
      ],
      headSha: SHA_A,
    },
    { requiredChecks: [REQUIRED_CHECK, OTHER_CHECK] },
  );
  t.after(() => h.close());

  const verified = await h.verify();
  assert.equal(verified.status, 200, verified.body);

  const after = await h.review();
  assert.ok(after.card !== null, after.raw);

  // The criterion is genuinely satisfied. This is what makes the case about the policy rather
  // than about verification: nothing is wrong with the work that bound criterion's check proves.
  const criterion = criterionOf(after.card);
  assert.equal(criterion.state, 'passed', 'the criterion its bound check verifies has passed');

  // The project's own gate is red, and the card says so.
  const lint = after.card.checks.find((entry) => entry.checkId === OTHER_CHECK);
  assert.equal(lint?.result, 'failed');
  assert.equal(lint?.required, true, 'the profile requires it, so the card must say it is required');
  assert.equal(lint?.blocking, true, 'and that it blocks');

  assert.deepEqual(
    after.card.policy.requiredAutomatedCheckIds.slice().sort(),
    [OTHER_CHECK, REQUIRED_CHECK].sort(),
    'the card carries the policy it was judged under, so a client can tell an empty list from a missing one',
  );

  assert.equal(after.card.eligibility.readyForOwnerReview, false, 'the review offer is withheld');
  assert.equal(after.card.eligibility.readyForAcceptance, false, 'and acceptance is gated too');
  assert.ok(
    after.card.eligibility.acceptanceBlockers.some((reason) => reason.includes(OTHER_CHECK) && reason.includes('failed')),
    `the failing required check is named as a blocker: ${JSON.stringify(after.card.eligibility.acceptanceBlockers)}`,
  );
  // Matched on the quoted criterion id: every reason cites a spec line, and `F23-AC1` contains
  // `AC1`, so a bare substring would match the owner test's citation and pass for the wrong reason.
  assert.ok(
    !after.card.eligibility.acceptanceBlockers.some((reason) => reason.includes(`"${AUTOMATED_CRITERION_ID}"`)),
    `and the satisfied criterion is not among them, so the refusal is about the gate and not the work: ${JSON.stringify(after.card.eligibility.acceptanceBlockers)}`,
  );

  // The gate itself, driven through the route the owner submits to.
  const refused = await h.accept();
  assert.equal(refused.status, 422, `an acceptance over a red required check must be refused: ${refused.body}`);
  const problem = parse<{ error: { code: string; prerequisites?: readonly { detail: string }[] } }>(refused.body).error;
  assert.equal(problem.code, 'Blocked');
  assert.ok(
    (problem.prerequisites ?? []).some((entry) => entry.detail.includes(OTHER_CHECK)),
    `the refusal names the failing gate: ${refused.body}`,
  );

  const unchanged = await h.review();
  assert.ok(unchanged.card !== null, unchanged.raw);
  assert.equal(unchanged.card.decision.outcome, 'none', 'a refused acceptance records nothing');
  assert.equal(unchanged.card.decision.authorizesCurrentCandidate, false);
});