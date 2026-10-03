/**
 * A synthetic server for the MVP API, spoken over real HTTP inside a real browser.
 *
 * **Why this file exists, stated plainly.** The MVP backend is being built in parallel from the
 * shared domain contract, and it does not exist in this worktree. These specs therefore prove the
 * *browser client*: that the four surfaces render the states they claim to distinguish, that the
 * contract's revision rules hold, that a candidate cannot be identified by an abbreviated SHA, and
 * that Accept and Request changes are the only decisions offered. They do **not** prove Builder 1's
 * routes or Builder 3's packet, and a green run must never be read as saying they do.
 *
 * **What is real and what is substituted, precisely.**
 *
 *   - Real: the shipped `src/server/main.ts` process, the real sign-in form, the real session
 *     cookie, the real CSRF token, the real derived `ApiResult` transport, and the whole React
 *     client built by the production Vite build. The stub is installed per request in the browser,
 *     so it is exercised through the same `fetch` the application uses.
 *   - Substituted: only the eleven MVP endpoints below. Everything else — session, health, static
 *     assets — reaches the real server untouched, and the one assertion in this file that the run
 *     drove the shipped entrypoint still lives in `smoke.spec.ts`.
 *
 * It is a substitute and not a mock of the client: the client code is unmodified and receives the
 * answer over a real socket. What it substitutes is the *answer*, which is exactly the part another
 * builder is writing.
 *
 * **What this file is also for.** It is the executable half of the integration contract. Every
 * response shape here is the shape `apps/web/src/ui/mvp/wire.ts` declares, so the backend can be
 * written against this file as a fixture rather than against a prose description, and a disagreement
 * between UI and backend shows up as a failing field rather than as a page that renders blank.
 *
 * Every identity is synthetic. `.invalid` is reserved by RFC 2606, so no address can resolve or
 * reach a real mailbox or host.
 */

import type { Page, Route, Request as PlaywrightRequest } from '@playwright/test';
import { CSRF_HEADER } from './fixtures.ts';

/** Synthetic identifiers. Invented for this suite; none names anything that exists. */
export const MVP = {
  projectId: 'prj_mvp_synthetic',
  projectName: 'MVP Synthetic Project',
  repository: 'example.invalid/mvp-synthetic/repo',
  t3Url: 'https://t3.example.invalid/workspace',
} as const;

/**
 * The path prefixes this stub answers, and therefore the only requests it records.
 *
 * `/api/owner/**` is deliberately absent. Sign-in, sign-out and the session probe are real-server
 * traffic in every run, and treating them as part of the substituted surface would mean this stub
 * was reachable without a session — the one thing it must never be.
 */
const SUBSTITUTED_PATHS: readonly string[] = [
  '/api/projects',
  '/api/home',
  '/api/requests',
  '/api/contracts',
  '/api/candidates',
  '/api/review',
];

/** A full, valid-looking commit SHA. 40 hex characters, which is what the client requires. */
export const HEAD_SHA = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';
export const OTHER_HEAD_SHA = '11223344556677889900112233445566778899aa';
const BASE_SHA = 'aabbccddeeff00112233445566778899aabbccdd';

function now(): string {
  return new Date().toISOString();
}

interface ContractRow {
  id: string;
  requestId: string;
  revision: number;
  outcome: string;
  scope: string;
  outOfScope: string[];
  acceptanceCriteria: { id: string; description: string; verificationType: 'automated' | 'owner_test' }[];
  status: 'draft' | 'approved' | 'stale';
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RequestRow {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

interface CandidateRow {
  id: string;
  requestId: string;
  contractId: string;
  contractRevision: number;
  repository: string;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  baseBranch: string;
  headSha: string;
  observedAt: string;
  verification: { complete: boolean; outstanding: string[] };
  criteria: {
    id: string;
    description: string;
    verificationType: 'automated' | 'owner_test';
    evidence: { evidenceId: string; method: string; result: string; observedAt: string; candidateHeadSha: string } | null;
  }[];
  staleReasons: string[];
}

interface DecisionRow {
  decisionId: string;
  kind: 'accepted' | 'changes_requested';
  decidedAt: string;
  headSha: string;
  contractRevision: number;
  feedback: string | null;
}

interface SettingsRow {
  projectId: string;
  name: string;
  repositoryUrl: string;
  fullName: string;
  baseBranch: string;
  githubReference: string | null;
  githubState: 'Configured' | 'NotConfigured' | 'Error';
  linearTeamKey: string | null;
  linearState: 'Configured' | 'NotConfigured' | 'Error';
  t3Url: string | null;
}

export interface MvpServerOptions {
  /**
   * Whether a candidate linked during this run comes back with verification already complete.
   *
   * The two states are the whole difference between the Review surface offering Accept and
   * refusing it, so the specs drive both rather than only the pleasant one.
   */
  readonly verificationComplete?: boolean;
  /** Whether GitHub reports itself configured. */
  readonly githubConfigured?: boolean;
  readonly linearTeamKey?: string | null;
  readonly t3Url?: string | null;
  /** Whether a linked candidate reports its review as stale. */
  readonly staleCandidate?: boolean;
  /**
   * Whether an owner observation recorded for a criterion also completes verification.
   *
   * False by default, so the two-step journey is drivable: verification stays incomplete until the
   * owner records something for the criterion only they can judge. Which is the point — a criterion
   * marked as the owner's own is not verified by any check, and a stub that silently completed it
   * would make the product look like it verifies what only a person can judge.
   */
  readonly observationCompletesVerification?: boolean;
  /**
   * How the Home endpoint misbehaves, so the surface's error and disconnected states are driven
   * rather than assumed.
   *
   * The two failures are different on purpose. A transport failure means the server was never
   * reached, which is the one that must mark the view no longer current. A refusal means the
   * server answered and declined, which must not.
   */
  readonly homeFault?: 'transport' | 'server';
  /** Holds the Home response, so the loading state can be observed rather than assumed. */
  readonly homeDelayMs?: number;
}

export interface MvpServer {
  /** Everything the stub recorded, so a spec can assert what was actually sent. */
  readonly calls: { method: string; path: string; body: unknown }[];
  /** The CSRF header on every write, so a spec can prove the client sent one. */
  readonly csrfHeaders: (string | undefined)[];
  /** Stops a fault from being produced, so a retry control can be shown to recover. */
  heal(): void;
  readonly state: {
    contracts(): readonly ContractRow[];
    candidates(): readonly CandidateRow[];
    decisions(): readonly DecisionRow[];
    settings(): SettingsRow;
  };
}

/** The arguments `route.fulfill` takes, named so a refusal reads as a refusal at the call site. */
interface Fulfilled {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/**
 * A refusal in the envelope the client's transport reads.
 *
 * The same shape the real server sends, so the client's refusal parsing is genuinely exercised:
 * a stub that answered `{ reason }` would let a broken envelope pass.
 */
function refusal(
  status: number,
  code: string,
  message: string,
  fields: readonly { path: string; message: string }[] = [],
): Fulfilled {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code, message, fields, prerequisites: [] } }),
  };
}

function readJson(request: PlaywrightRequest): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(request.postData() ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Installs the stub for the MVP endpoints and leaves every other request alone.
 *
 * Scoped to `/api/` so the browser still loads the real application from the real server. A route
 * on `**` would also intercept the document and the bundle, and a spec that proves nothing about
 * the client is worse than no spec.
 */
export async function installMvpServer(page: Page, options: MvpServerOptions = {}): Promise<MvpServer> {
  const verificationComplete = options.verificationComplete ?? false;
  // Mutable so a spec can stop answering after arranging a state, which is how the retry control
  // is driven: a retry that always fails proves the control renders, not that it recovers.
  const state = { ...options };
  const calls: { method: string; path: string; body: unknown }[] = [];
  // Recorded separately from `calls` because a write with no CSRF token is refused by the real
  // transport before it reaches a route, so a missing one would show up as an absent call rather
  // than as a rejected request.
  const csrfHeaders: (string | undefined)[] = [];

  const requests: RequestRow[] = [];
  const contracts: ContractRow[] = [];
  const candidates: CandidateRow[] = [];
  const decisions: DecisionRow[] = [];
  const settings: SettingsRow = {
    projectId: MVP.projectId,
    name: MVP.projectName,
    repositoryUrl: `https://${MVP.repository}`,
    fullName: MVP.repository,
    baseBranch: 'main',
    githubReference: options.githubConfigured === false ? null : 'env:E2E_SYNTHETIC_REPO_TOKEN',
    githubState: options.githubConfigured === false ? 'NotConfigured' : 'Configured',
    linearTeamKey: options.linearTeamKey ?? null,
    linearState: options.linearTeamKey == null ? 'NotConfigured' : 'Configured',
    t3Url: options.t3Url === undefined ? MVP.t3Url : options.t3Url,
  };

  let requestCounter = 0;
  let contractCounter = 0;
  let candidateCounter = 0;
  let decisionCounter = 0;

  const nextRequestId = (): string => {
    requestCounter += 1;
    return `req_synthetic_${String(requestCounter).padStart(4, '0')}`;
  };
  const nextContractId = (): string => {
    contractCounter += 1;
    return `ctc_synthetic_${String(contractCounter).padStart(4, '0')}`;
  };

  const contractView = (row: ContractRow): Record<string, unknown> => ({
    ...row,
    projectId: MVP.projectId,
  });

  const projectView = (): Record<string, unknown> => ({
    projectId: MVP.projectId,
    name: settings.name,
    createdAt: now(),
    updatedAt: now(),
    archivedAt: null,
  });

  /**
   * The whole settings shape, for both the read and the save.
   *
   * A save that answered a partial object would leave the client re-deriving from fields it no
   * longer had, so the stub answers with the same view the read does.
   */
  const settingsView = (): Record<string, unknown> => ({
    projectId: MVP.projectId,
    name: settings.name,
    github: {
      repositoryUrl: settings.repositoryUrl,
      fullName: settings.fullName,
      baseBranch: settings.baseBranch,
      connector: {
        configured: settings.githubReference !== null,
        credentialReference: settings.githubReference,
        state: settings.githubState,
        detail: null,
      },
    },
    linear:
      settings.linearTeamKey === null
        ? null
        : {
            teamKey: settings.linearTeamKey,
            connector: {
              configured: true,
              credentialReference: 'env:E2E_SYNTHETIC_LINEAR_TOKEN',
              state: settings.linearState,
              detail: null,
            },
          },
    t3Url: settings.t3Url,
  });

  const candidateView = (row: CandidateRow): Record<string, unknown> => ({
    id: row.id,
    projectId: MVP.projectId,
    requestId: row.requestId,
    contractId: row.contractId,
    contractRevision: row.contractRevision,
    repository: row.repository,
    pullRequestNumber: row.pullRequestNumber,
    pullRequestUrl: row.pullRequestUrl,
    baseBranch: row.baseBranch,
    headSha: row.headSha,
    observedAt: row.observedAt,
  });

  const decisionFor = (candidateId: string): DecisionRow | null => {
    const found = decisions.find((entry) => entry.headSha === candidates.find((c) => c.id === candidateId)?.headSha);
    return found ?? null;
  };

  const reviewView = (row: CandidateRow): Record<string, unknown> => {
    const request = requests.find((entry) => entry.id === row.requestId);
    const contract = contracts.find((entry) => entry.id === row.contractId);
    return {
      candidateId: row.id,
      requestId: row.requestId,
      requestTitle: request?.title ?? 'A request',
      contractId: row.contractId,
      contractRevision: row.contractRevision,
      repository: row.repository,
      pullRequestNumber: row.pullRequestNumber,
      pullRequestUrl: row.pullRequestUrl,
      baseBranch: row.baseBranch,
      headSha: row.headSha,
      observedAt: row.observedAt,
      verification: row.verification,
      decision: decisionFor(row.id),
      staleReasons: row.staleReasons,
      checks: [
        {
          checkId: 'check_build',
          name: 'build',
          required: true,
          result: verificationComplete ? 'Passed' : 'Waiting',
          detail: null,
          observedAt: now(),
        },
        {
          checkId: 'check_test',
          name: 'test',
          required: true,
          result: verificationComplete ? 'Passed' : 'Missing',
          detail: null,
          observedAt: verificationComplete ? now() : null,
        },
      ],
      criteria: row.criteria.map((criterion) => ({
        id: criterion.id,
        description: criterion.description,
        verificationType: criterion.verificationType,
        status: criterion.evidence === null ? 'Pending' : 'Met',
        detail: null,
        evidence:
          criterion.evidence === null
            ? null
            : { ...criterion.evidence, contractRevision: row.contractRevision },
        pendingOwnerTest: criterion.verificationType === 'owner_test' && criterion.evidence === null,
      })),
      pendingOwnerTestCriterionIds: row.criteria
        .filter((criterion) => criterion.verificationType === 'owner_test' && criterion.evidence === null)
        .map((criterion) => criterion.id),
    };
  };

  const homeItem = (request: RequestRow): Record<string, unknown> | null => {
    const contract = contracts.find((entry) => entry.requestId === request.id) ?? null;
    const candidate = candidates.find((entry) => entry.requestId === request.id) ?? null;
    const decision = decisionFor(candidate?.id ?? '');
    if (contract === null) return null;
    let nextAction = 'Approve the contract.';
    if (contract.status === 'approved') nextAction = candidate === null ? 'Link the pull request that implements it.' : 'Decide on the candidate.';
    if (decision !== null) nextAction = decision.kind === 'accepted' ? 'Nothing is waiting on this.' : 'Link the pull request that addresses the feedback.';
    return {
      requestId: request.id,
      title: request.title,
      updatedAt: contract.updatedAt,
      contract: { id: contract.id, revision: contract.revision, status: contract.status },
      candidate:
        candidate === null
          ? null
          : {
              id: candidate.id,
              headSha: candidate.headSha,
              pullRequestNumber: candidate.pullRequestNumber,
              pullRequestUrl: candidate.pullRequestUrl,
            },
      verification: candidate === null ? null : candidate.verification,
      decision,
      nextAction,
    };
  };

  const handle = async (route: Route, method: string, path: string, query: URLSearchParams): Promise<boolean> => {
    const body = readJson(route.request());
    // Only the substituted endpoints are recorded. Sign-in and sign-out are real-server writes that
    // pass through, and counting them here would make `calls` a mixture of the stub's business and
    // the harness's, so a spec asserting "these are the writes the client made" could not tell which
    // is which. Sign-in carries no CSRF token by design, so including it would also make the token
    // assertion below fail for a request that was never supposed to carry one.
    if (SUBSTITUTED_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      if (method === 'POST') csrfHeaders.push(route.request().headers()[CSRF_HEADER]);
      calls.push({ method, path, body });
    }

    // Projects. The header selector and Settings both read this list, and creating a project is a
    // Settings action in the MVP, so both endpoints are part of the substituted surface.
    if (path === '/api/projects' && method === 'GET') {
      // The project list is served only when the session is real, so this stub never becomes a
      // second way to sign in: an intercepted owner call continues to the real server untouched,
      // and the session cookie stays the only thing that authorizes anything here.
      void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: [projectView()] }) });
      return true;
    }
    if (path === '/api/projects' && method === 'POST') {
      settings.name = text(body['name']) || settings.name;
      void route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ project: projectView() }),
      });
      return true;
    }

    if (path === '/api/home' && method === 'GET') {
      if (state.homeFault === 'transport') {
        // The request never reaches a server, which is the failure that must mark the view as no
        // longer current. A refusal would not: the server answered.
        await route.abort('failed');
        return true;
      }
      if (state.homeFault === 'server') {
        void route.fulfill(refusal(503, 'Unavailable', 'The board could not be collected right now.'));
        return true;
      }
      if (state.homeDelayMs !== undefined && state.homeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.homeDelayMs));
      }
      const items = requests.map(homeItem).filter((item): item is Record<string, unknown> => item !== null);
      // The project the board was collected for is echoed back from the query, and is null when no
      // project was named. A stub that always answered with a project id would make the client's
      // "no project selected" state unreachable, which is the state a first-time owner meets.
      const requested = query.get('projectId');
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ home: { projectId: requested, collectedAt: now(), items } }),
      });
      return true;
    }

    if (path === '/api/requests' && method === 'POST') {
      const description = text(body['description']);
      if (description.trim() === '') {
        void route.fulfill(refusal(400, 'Invalid', 'A request needs a description.'));
        return true;
      }
      const at = now();
      const requestRow: RequestRow = {
        id: nextRequestId(),
        title: text(body['title']) || description.slice(0, 60),
        description,
        createdAt: at,
        updatedAt: at,
      };
      requests.push(requestRow);
      const contractRow: ContractRow = {
        id: nextContractId(),
        requestId: requestRow.id,
        revision: 1,
        outcome: '',
        scope: '',
        outOfScope: [],
        acceptanceCriteria: [],
        status: 'draft',
        approvedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      contracts.push(contractRow);
      void route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          request: { ...requestRow, projectId: MVP.projectId },
          contract: contractView(contractRow),
        }),
      });
      return true;
    }

    const contractMatch = /^\/api\/contracts\/([^/]+)(\/[a-z-]+)?$/.exec(path);
    if (contractMatch !== null) {
      const contractId = decodeURIComponent(contractMatch[1] ?? '');
      const action = contractMatch[2] ?? '';
      const row = contracts.find((entry) => entry.id === contractId);
      if (row === undefined) {
        void route.fulfill(refusal(404, 'NotFound', `No contract is recorded at ${contractId}.`));
        return true;
      }
      const requestRow = requests.find((entry) => entry.id === row.requestId);

      if (action === '' && method === 'GET') {
        void route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            contract: contractView(row),
            request: { ...(requestRow ?? { id: row.requestId, title: '', description: '' }), projectId: MVP.projectId },
          }),
        });
        return true;
      }

      if (action === '' && method === 'POST') {
        const criteria = Array.isArray(body['acceptanceCriteria']) ? body['acceptanceCriteria'] : [];
        const next = {
          outcome: text(body['outcome']),
          scope: text(body['scope']),
          outOfScope: Array.isArray(body['outOfScope']) ? (body['outOfScope'] as unknown[]).map(text) : [],
          acceptanceCriteria: criteria.map((entry, index) => {
            const criterion = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
            const previous = row.acceptanceCriteria.find((existing) => existing.id === text(criterion['id']));
            return {
              id: previous?.id ?? `criterion_synthetic_${String(index + 1)}`,
              description: text(criterion['description']),
              verificationType: text(criterion['verificationType']) === 'owner_test' ? 'owner_test' : 'automated',
            };
          }),
        };
        // The revision rule this stub exists to exercise: changed content on an approved revision
        // records a new revision, and the approval does not follow the text.
        if (row.status === 'approved') {
          row.revision += 1;
          row.status = 'draft';
          row.approvedAt = null;
          row.outcome = next.outcome;
          row.scope = next.scope;
          row.outOfScope = next.outOfScope;
          row.acceptanceCriteria = next.acceptanceCriteria;
        } else {
          Object.assign(row, next);
        }
        row.updatedAt = now();
        void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ contract: contractView(row) }) });
        return true;
      }

      if (action === '/approve' && method === 'POST') {
        if (row.status === 'approved') {
          void route.fulfill(refusal(409, 'Conflict', 'This revision is already approved.'));
          return true;
        }
        if (row.outcome.trim() === '' || row.scope.trim() === '' || row.acceptanceCriteria.length === 0) {
          void route.fulfill(
            refusal(400, 'Invalid', 'A contract needs an outcome, a scope and at least one acceptance criterion before it can be approved.', [
              ...(row.outcome.trim() === '' ? [{ path: 'outcome', message: 'An outcome is required.' }] : []),
              ...(row.scope.trim() === '' ? [{ path: 'scope', message: 'Scope is required.' }] : []),
              ...(row.acceptanceCriteria.length === 0
                ? [{ path: 'acceptanceCriteria', message: 'At least one acceptance criterion is required.' }]
                : []),
            ]),
          );
          return true;
        }
        row.status = 'approved';
        row.approvedAt = now();
        row.updatedAt = now();
        void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ contract: contractView(row) }) });
        return true;
      }

      if (action === '/handoff' && method === 'POST') {
        if (row.status !== 'approved') {
          void route.fulfill(refusal(409, 'Conflict', 'Only an approved revision can be prepared for implementation.'));
          return true;
        }
        const requestTitle = requestRow?.title ?? 'a request';
        const content = [
          `# Implementation packet`,
          ``,
          `Project: ${MVP.projectName}`,
          `Request: ${requestTitle}`,
          `Contract revision: ${String(row.revision)}`,
          `Approved at: ${row.approvedAt ?? 'unknown'}`,
          ``,
          `## Outcome`,
          row.outcome,
          ``,
          `## Scope`,
          row.scope,
          ``,
          `## Out of scope`,
          row.outOfScope.length === 0 ? '(nothing excluded)' : row.outOfScope.map((entry) => `- ${entry}`).join('\n'),
          ``,
          `## Acceptance criteria`,
          ...row.acceptanceCriteria.map((entry) => `- [ ] ${entry.description} (${entry.verificationType})`),
          ``,
          `Produce a pull request and paste its full 40-character head commit SHA into ShipLoop.`,
        ].join('\n');
        void route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            packet: { contractId: row.id, revision: row.revision, generatedAt: now(), content, t3Url: settings.t3Url },
          }),
        });
        return true;
      }
    }

    if (path === '/api/candidates' && method === 'POST') {
      const contractId = text(body['contractId']);
      const row = contracts.find((entry) => entry.id === contractId);
      if (row === undefined) {
        void route.fulfill(refusal(404, 'NotFound', `No contract is recorded at ${contractId}.`));
        return true;
      }
      const headSha = text(body['headSha']);
      if (!/^[0-9a-fA-F]{40}$/.test(headSha)) {
        void route.fulfill(
          refusal(400, 'Invalid', 'A candidate must be identified by a full 40-character commit SHA.', [
            { path: 'headSha', message: 'The full 40-character commit SHA is required.' },
          ]),
        );
        return true;
      }
      candidateCounter += 1;
      const criteria = row.acceptanceCriteria.map((criterion, index) => ({
        id: criterion.id,
        description: criterion.description,
        verificationType: criterion.verificationType,
        // An owner-test criterion never receives automated evidence, which is what leaves the
        // Review surface with something genuinely waiting on the owner.
        evidence:
          verificationComplete && criterion.verificationType === 'automated'
            ? {
                evidenceId: `ev_synthetic_${String(index + 1)}`,
                method: 'check:build',
                result: 'passed',
                observedAt: now(),
                candidateHeadSha: headSha,
              }
            : null,
      }));
      const candidateRow: CandidateRow = {
        id: `cnd_synthetic_${String(candidateCounter).padStart(4, '0')}`,
        requestId: row.requestId,
        contractId: row.id,
        contractRevision: row.revision,
        repository: text(body['repository']) || MVP.repository,
        pullRequestNumber: typeof body['pullRequestNumber'] === 'number' ? body['pullRequestNumber'] : null,
        pullRequestUrl: text(body['pullRequestUrl']) || null,
        baseBranch: text(body['baseBranch']) || 'main',
        headSha,
        observedAt: now(),
        verification: {
          complete: verificationComplete && criteria.every((criterion) => criterion.evidence !== null),
          outstanding: criteria.filter((criterion) => criterion.evidence === null).map((criterion) => criterion.description),
        },
        criteria,
        // Staleness is a statement about the candidate, not about verification, so it is set when
        // the candidate is recorded rather than when evidence arrives. A stub that made it depend
        // on verification would make "stale" and "unverified" the same state, which is exactly the
        // confusion the Review surface has to keep apart.
        staleReasons: state.staleCandidate === true ? ['the head commit moved after this review was collected'] : [],
      };
      candidates.push(candidateRow);
      void route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ candidate: candidateView(candidateRow) }),
      });
      return true;
    }

    if (path === '/api/review' && method === 'GET') {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          queue: { projectId: query.get('projectId'), collectedAt: now(), items: candidates.map(reviewView) },
        }),
      });
      return true;
    }

    const reviewMatch = /^\/api\/review\/([^/]+)(\/decision|\/observations)?$/.exec(path);
    if (reviewMatch !== null) {
      const candidateId = decodeURIComponent(reviewMatch[1] ?? '');
      const isDecision = reviewMatch[2] === '/decision';
      const row = candidates.find((entry) => entry.id === candidateId);
      if (row === undefined) {
        void route.fulfill(refusal(404, 'NotFound', `No candidate is recorded at ${candidateId}.`));
        return true;
      }
      if (reviewMatch[2] === '/observations' && method === 'POST') {
        const criterionId = text(body['criterionId']);
        const criterion = row.criteria.find((entry) => entry.id === criterionId);
        if (criterion === undefined) {
          void route.fulfill(refusal(404, 'NotFound', `No criterion is recorded at ${criterionId}.`));
          return true;
        }
        // The full SHA is sent and checked so an observation recorded against a moved commit is
        // refused rather than silently re-attributed to the commit now on screen.
        if (text(body['expectedHeadSha']) !== row.headSha) {
          void route.fulfill(
            refusal(409, 'Conflict', 'The candidate has moved since this review was collected. Re-read it before recording an observation.'),
          );
          return true;
        }
        criterion.evidence = {
          evidenceId: `ev_owner_${String(criterion.evidence === null ? 1 : 2).padStart(4, '0')}`,
          method: `owner_test:${text(body['environment']) || 'Local'}`,
          result: text(body['observation']) === 'BehaviorFailed' ? 'not confirmed' : 'confirmed',
          observedAt: now(),
          candidateHeadSha: row.headSha,
        };
        row.verification = {
          complete:
            (state.observationCompletesVerification ?? true) && row.criteria.every((entry) => entry.evidence !== null),
          outstanding: row.criteria.filter((entry) => entry.evidence === null).map((entry) => entry.description),
        };
        void route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ criterion: { id: criterion.id, status: 'Met' } }),
        });
        return true;
      }

      if (!isDecision && method === 'GET') {
        void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ review: reviewView(row) }) });
        return true;
      }
      if (isDecision && method === 'POST') {
        const kind = text(body['decision']);
        const feedback = text(body['feedback']);
        if (kind !== 'accepted' && kind !== 'changes_requested') {
          void route.fulfill(refusal(400, 'Invalid', 'The only decisions are accepted and changes_requested.'));
          return true;
        }
        if (kind === 'changes_requested' && feedback.trim() === '') {
          void route.fulfill(refusal(400, 'Invalid', 'Requesting changes needs feedback.'));
          return true;
        }
        if (kind === 'accepted' && !row.verification.complete) {
          void route.fulfill(
            refusal(409, 'Blocked', 'Verification of this candidate has not finished.', [
              { path: 'verification', message: `Outstanding: ${row.verification.outstanding.join(', ')}` },
            ]),
          );
          return true;
        }
        decisionCounter += 1;
        const decisionRow: DecisionRow = {
          decisionId: `dec_synthetic_${String(decisionCounter).padStart(4, '0')}`,
          kind,
          decidedAt: now(),
          headSha: row.headSha,
          contractRevision: row.contractRevision,
          feedback: feedback === '' ? null : feedback,
        };
        decisions.push(decisionRow);
        void route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ decision: decisionRow }) });
        return true;
      }
    }

    const settingsMatch = /^\/api\/projects\/([^/]+)\/settings$/.exec(path);
    if (settingsMatch !== null && method === 'GET') {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ settings: settingsView() }),
      });
      return true;
    }
    if (settingsMatch !== null && method === 'POST') {
      settings.name = text(body['name']) || settings.name;
      settings.repositoryUrl = text(body['repositoryUrl']) || settings.repositoryUrl;
      settings.baseBranch = text(body['baseBranch']) || settings.baseBranch;
      const reference = body['githubCredentialReference'];
      settings.githubReference = typeof reference === 'string' && reference !== '' ? reference : null;
      settings.githubState = settings.githubReference === null ? 'NotConfigured' : 'Configured';
      const team = body['linearTeamKey'];
      settings.linearTeamKey = typeof team === 'string' && team !== '' ? team : null;
      settings.linearState = settings.linearTeamKey === null ? 'NotConfigured' : 'Configured';
      const t3 = body['t3Url'];
      if (typeof t3 === 'string' && t3 !== '') {
        if (!/^https:\/\/[^\s]+$/.test(t3)) {
          void route.fulfill(
            refusal(400, 'Invalid', 'The T3 address must be an https URL.', [
              { path: 't3Url', message: 'The T3 address must be an https URL.' },
            ]),
          );
          return true;
        }
        settings.t3Url = t3;
      } else {
        settings.t3Url = null;
      }
      void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ settings: settingsView() }) });
      return true;
    }

    return false;
  };

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const handled = await handle(route, route.request().method(), url.pathname, url.searchParams);
    if (!handled) await route.continue();
  });

  return {
    calls,
    csrfHeaders,
    heal(): void {
      state.homeFault = undefined;
      state.homeDelayMs = 0;
    },
    state: {
      contracts: () => contracts,
      candidates: () => candidates,
      decisions: () => decisions,
      settings: () => settings,
    },
  };
}

export { BASE_SHA };