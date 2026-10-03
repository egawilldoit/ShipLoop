/**
 * The GitHub git adapter (F19, F20-AC1, F20-AC2, F22-AC1, F24-AC4, F26-AC3, F30-AC5).
 *
 * Four measured facts about GitHub shape this file, and every one is quoted with its
 * output in `README.md` rather than asserted from documentation:
 *
 * 1. **GitHub offers no client-supplied pull-request identity.** `POST
 *    /repos/{owner}/{repo}/pulls` accepts `title`, `head`, `head_repo`, `base`, `body`,
 *    `maintainer_can_modify`, `draft` and `issue` — no `id`. This is the single most
 *    important difference from the Linear adapter, where `IssueCreateInput.id` is
 *    client-supplied and therefore makes a repeated create collide on one identity. Here
 *    the provider offers no such uniqueness constraint, so **exactly-once is not
 *    provider-guaranteed** and this adapter does not claim it (F30-AC2).
 * 2. **Reconciliation is therefore done by reading the marker.** The managed marker is
 *    written into the pull request body, which is queryable, so `upsertDraft` performs a
 *    reconciliation read **before** any create and again on every retry. A create whose
 *    response is lost is reported `OutcomeUnknown`, and the next call finds the pull
 *    request that exists and returns `RecoveredAfterLostResponse` instead of creating a
 *    second one (F19-AC1, F19-AC3, F28-AC4).
 * 3. **`PUT /repos/{owner}/{repo}/pulls/{n}/merge` accepts `sha`, described by GitHub as
 *    "SHA that pull request head must match to allow merge".** So a genuine compare-and-set
 *    head precondition exists and is used whenever the caller pins one (F26-AC3).
 * 4. **Branch protection is off and no rulesets exist on this repository**
 *    (`main` is `protected: false`, `GET /branches/main/protection` returned HTTP 404
 *    `{"message":"Branch not protected",…}`, and `GET /rulesets?includes_parents=true`
 *    returned `[]`), so nothing at the provider would have refused a merge. That is exactly why
 *    the capability declaration must not be read as a boundary, and `README.md` states which
 *    token permissions were verified rather than assumed.
 *
 * **The policy read is for the MERGE TARGET, and it distinguishes four answers.**
 * `approvalRules` used to read `branches/{request.branch}/protection` — the *feature* branch,
 * which is the one branch a repository is least likely to protect, so the read was guaranteed to
 * report nothing exactly when the target's rule was the one that mattered (F26-AC5). It now reads
 * the target branch the request names and folds in the repository's rulesets, because a ruleset
 * can require reviews and status checks with no branch protection in existence at all.
 *
 * The four answers are kept apart, and collapsing any two of them is the failure mode this
 * replaced:
 *
 * - **confirmed absent** — HTTP 404 `Branch not protected` on the target and no applicable active
 *   ruleset. Nothing is added to `reviews`.
 * - **confirmed present** — a requirement is unmet, so an `ApprovalRulePending` names the target,
 *   every source that contributed the requirement and the strictest count.
 * - **not permitted** — HTTP 403. Reading protection and rulesets needs administration this
 *   credential may not hold, and *that is not evidence of absence*. It is `Blocked` with the
 *   provider's own message, so a merge cannot be authorized on a policy nobody read.
 * - **not known** — a timeout, a 5xx or a rate limit. `Unavailable`/`RateLimited` becomes the same
 *   `Blocked`, because a policy that was never read is not an unprotected branch (F26-AC5).
 *
 * **An approval is counted the way the provider would count it.** GitHub returns one record per
 * review *event*, so the same reviewer appears repeatedly — measured live on
 * `egawilldoit/token-observatory#20`, where `MORTAKI0` submitted six `COMMENTED` records for one
 * `commit_id` — and an approval carries the `commit_id` it approved. Counting records would let a
 * single reviewer satisfy a two-review rule and would treat an approval of an older commit as
 * current, so `countCurrentApprovals` keeps the **last** record per reviewer, counts it only when
 * its `commit_id` is the head being merged, and names what it excluded.
 *
 * `Stale` is derived, never guessed. A required check name reported on the base commit but
 * not on the candidate head has not been rerun for this candidate, so it is `Stale`; a
 * required name reported on neither is `Missing`. Neither is ever `Passed` (F20-AC2).
 */

import {
  blocked,
  err,
  fingerprint,
  invalid,
  isCommitSha,
  ok,
  type CapabilityDeclaration,
  type CheckResult,
  type CommitSha,
  type ConnectorId,
  type DomainError,
  type ProviderId,
  type PullRequestState,
  type Result,
} from '@shiploop/domain';

import {
  ADAPTER_CONTRACT_VERSION,
  type AdapterCapabilities,
  type AdapterCompatibility,
  type AdapterContext,
  type ContentRelation,
  type DeclareNoCodeOutcomeRequest,
  type DraftBody,
  type DraftLinkTarget,
  type DraftRef,
  type FindDraftsRequest,
  type GitAdapter,
  type GitRefState,
  type GitRepositoryRef,
  type GitReviewState,
  type GitStateRead,
  type ManagedRegionTarget,
  type MergeOutcome,
  type MergePrecondition,
  type MergePullRequestRequest,
  type NoCodeOutcomeRecord,
  type ProviderCheckObservation,
  type PullRequestRef,
  type PushBranchOutcome,
  type PushBranchRequest,
  type ReadChecksRequest,
  type ReadGitStateRequest,
  type ReadLinkedPullRequestRequest,
  type LinkedPullRequestFacts,
  type TicketIssueRef,
  type UpsertDraftOutcome,
  type UpsertDraftRequest,
} from '../contracts/index.ts';

import {
  GitHubClient,
  type GitHubClientOptions,
  type GitHubRequest,
  type GitTransport,
} from './client.ts';
import {
  isAuthenticationFailure,
  isNonFastForwardFailure,
  mapCheckConclusion,
  mapCommitStatusState,
} from './errors.ts';

export const GITHUB_PROVIDER = 'github';

/**
 * Markers that delimit the region ShipLoop owns inside a draft body.
 *
 * A delimited block rather than the whole body is what keeps a human's own notes from
 * being rewritten: the adapter replaces only what is between the markers, so an edit made
 * on GitHub outside the region survives the next managed update (F16-AC2).
 */
const MANAGED_START = '<!--shiploop:managed:start-->';
const MANAGED_END = '<!--shiploop:managed:end-->';
const MANAGED_MARKER_PREFIX = '<!--shiploop:managed:v1';

/** Ref components GitHub accepts, and the bounded page size for every list call. */
const REF_SEGMENT = /^[A-Za-z0-9._\-/]+$/;
const MAX_PULL_REQUESTS = 100;
const MAX_CHECK_RUNS = 100;
const MAX_REVIEWS = 100;
/** Bound on the rulesets one repository or organisation listing can contribute. */
const MAX_RULESETS = 100;
/**
 * Bound on the commits a range read returns.
 *
 * The range exists to name what changed between two revisions, not to be a complete log, so
 * a repository with a longer range reports the bound in its detail rather than silently
 * truncating an answer that would then look complete (F24-AC1).
 */
const MAX_COMMIT_RANGE = 250;

/** Names of the sections the managed region is built from, used to report what changed. */
const MANAGED_SECTIONS = ['purpose', 'scope', 'criteria', 'known gaps', 'verification', 'linked work'] as const;

export interface ReadCommitRangeRequest {
  readonly repository: GitRepositoryRef;
  /** The revision the change is measured against. */
  readonly baseSha: CommitSha;
  /** The revision the candidate proposes. */
  readonly headSha: CommitSha;
}

/**
 * What changed between two revisions.
 *
 * `mergeBaseSha` is separate from `baseSha` because they are different facts: the base branch
 * tip may have advanced since the branch was cut, and a diff taken against the merge base is
 * not the same set of changes as one taken against the tip. F24-AC4 needs the current facts,
 * so both are reported rather than one standing in for the other.
 */
export interface GitCommitRange {
  readonly baseSha: CommitSha;
  readonly headSha: CommitSha;
  readonly mergeBaseSha: CommitSha | null;
  readonly aheadBy: number | null;
  readonly behindBy: number | null;
  readonly totalCommits: number | null;
  readonly commits: readonly RangeCommit[];
  readonly files: readonly RangeFile[];
  /** True when the provider's answer was longer than the bound this adapter reads. */
  readonly truncated: boolean;
  readonly observedAt: string;
}

export interface GitHubGitAdapterOptions {
  readonly connectorId: ConnectorId;
  readonly client: GitHubClientOptions;
  /** Local checkout used for `git push`, and the remote name within it. */
  readonly git: GitTransport;
  /** Git remote name, e.g. `origin`. Its URL is verified against the repository. */
  readonly gitRemoteName?: string;
  /** Bounded pages when listing a repository's pull requests. */
  readonly maxPullRequestPages?: number;
}

/* -------------------------------------------------------------------------- */
/* Boundary readers                                                            */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A provider identity, which GitHub reports as a JSON number as often as a string.
 *
 * `id` on a pull request, a check run, a commit status and a review are all integers on the
 * wire — the live capture of `GET /commits/{sha}/check-runs` read `"id": 110043771706`
 * unquoted. Reading them as strings only would reject every real payload, and stringifying
 * them without accepting numbers would reject them for the opposite reason. The result is a
 * string because `ProviderId` is one, and it is what the provider's own paths are built from.
 */
function providerIdentity(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  return null;
}

function requiredStr(value: unknown): string | null {
  return str(value);
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

interface RepositoryShape {
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly htmlUrl: string;
  readonly sshUrl: string | null;
  readonly cloneUrl: string | null;
  readonly archived: boolean;
  /** GitHub's own per-actor permission flags for the authenticated credential. */
  readonly permissions: Readonly<Record<string, boolean>>;
}

function readRepository(value: unknown): RepositoryShape | null {
  const fullName = requiredStr(field(value, 'full_name'));
  const defaultBranch = requiredStr(field(value, 'default_branch'));
  const htmlUrl = requiredStr(field(value, 'html_url'));
  if (fullName === null || defaultBranch === null || htmlUrl === null) return null;
  const permissions: Record<string, boolean> = {};
  const reported = field(value, 'permissions');
  if (isRecord(reported)) {
    for (const [key, flag] of Object.entries(reported)) {
      if (typeof flag === 'boolean') permissions[key] = flag;
    }
  }
  return {
    fullName,
    defaultBranch,
    htmlUrl,
    sshUrl: str(field(value, 'ssh_url')),
    cloneUrl: str(field(value, 'clone_url')),
    archived: boolOrNull(field(value, 'archived')) ?? false,
    permissions,
  };
}

interface PullRequestShape {
  /**
   * The provider identity, which for GitHub is the pull request number.
   *
   * GitHub also reports a global numeric `id`, but every path under
   * `/repos/{owner}/{repo}/pulls/` is keyed by the **number**, so using the global id would
   * build a path the API rejects. The number is the identity GitHub's own API, UI URLs and
   * webhooks all use, so it is the identity the contract's `pullRequestId` carries.
   */
  readonly id: string;
  readonly number: number;
  readonly htmlUrl: string;
  readonly body: string | null;
  readonly title: string;
  readonly draft: boolean;
  readonly state: string;
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly mergeCommitSha: string | null;
  readonly headRef: string;
  /** Narrowed to a full SHA by `readPullRequest`, so a `DraftRef` can carry it. */
  readonly headSha: CommitSha;
  readonly baseRef: string;
  readonly baseSha: CommitSha;
  readonly userLogin: string | null;
  /**
   * `owner/repository` the head branch lives in, or null when GitHub did not report one.
   *
   * A pull request opened from a fork has its head in another repository entirely. GitHub
   * still reports the code as a diff against this repository, so a reader that only looked
   * at the base would attribute a stranger's commits to this project. Captured here so the
   * decision to refuse that is made from the payload rather than from an assumption.
   */
  readonly headRepository: string | null;
}

function readPullRequest(value: unknown): PullRequestShape | null {
  const id = providerIdentity(field(value, 'id'));
  const number = intOrNull(field(value, 'number'));
  const htmlUrl = requiredStr(field(value, 'html_url'));
  const headRef = requiredStr(field(field(value, 'head'), 'ref'));
  const headSha = requiredStr(field(field(value, 'head'), 'sha'));
  const baseRef = requiredStr(field(field(value, 'base'), 'ref'));
  const baseSha = requiredStr(field(field(value, 'base'), 'sha'));
  if (id === null || number === null || htmlUrl === null) return null;
  if (headRef === null || headSha === null || baseRef === null || baseSha === null) return null;
  // A pull request whose head or base is not a full commit SHA cannot be represented as a
  // `DraftRef`, whose `headSha` is a `CommitSha`. Dropping the shape here makes an
  // abbreviated payload one honest "this adapter cannot read it" for the whole call, rather
  // than a `DraftRef` carrying a revision that is not the one GitHub means.
  if (!isCommitSha(headSha) || !isCommitSha(baseSha)) return null;
  const head: CommitSha = headSha;
  const base: CommitSha = baseSha;
  return {
    id: String(number),
    number,
    htmlUrl,
    body: str(field(value, 'body')),
    title: str(field(value, 'title')) ?? '',
    draft: boolOrNull(field(value, 'draft')) ?? false,
    state: str(field(value, 'state')) ?? 'unknown',
    merged: boolOrNull(field(value, 'merged')) ?? false,
    mergedAt: str(field(value, 'merged_at')),
    mergeCommitSha: str(field(value, 'merge_commit_sha')),
    headRef,
    headSha: head,
    baseRef,
    baseSha: base,
    userLogin: str(field(field(value, 'user'), 'login')),
    headRepository: str(field(field(field(value, 'head'), 'repo'), 'full_name')),
  };
}

/** The `owner/repo` pair every GitHub path this adapter builds is made of. */
interface RepositoryNames {
  readonly owner: string;
  readonly repo: string;
}

interface RefShape {
  readonly ref: string;
  readonly sha: string;
}

function readRef(value: unknown): RefShape | null {
  const ref = requiredStr(field(value, 'ref'));
  const sha = requiredStr(field(field(value, 'object'), 'sha'));
  return ref === null || sha === null ? null : { ref, sha };
}

interface CheckRunShape {
  readonly id: string;
  readonly name: string;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly detailsUrl: string | null;
  readonly summary: string | null;
  readonly title: string | null;
}

function readCheckRun(value: unknown): CheckRunShape | null {
  const id = providerIdentity(field(value, 'id'));
  const name = requiredStr(field(value, 'name'));
  const status = requiredStr(field(value, 'status'));
  if (id === null || name === null || status === null) return null;
  return {
    id,
    name,
    headSha: str(field(value, 'head_sha')) ?? '',
    status,
    conclusion: str(field(value, 'conclusion')),
    startedAt: str(field(value, 'started_at')),
    completedAt: str(field(value, 'completed_at')),
    detailsUrl: str(field(value, 'details_url')),
    summary: str(field(field(value, 'output'), 'summary')),
    title: str(field(field(value, 'output'), 'title')),
  };
}

interface CommitStatusShape {
  readonly id: string;
  readonly context: string;
  readonly state: string;
  readonly description: string | null;
  readonly targetUrl: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

function readCommitStatus(value: unknown): CommitStatusShape | null {
  const id = providerIdentity(field(value, 'id'));
  const context = requiredStr(field(value, 'context'));
  const state = requiredStr(field(value, 'state'));
  if (id === null || context === null || state === null) return null;
  return {
    id,
    context,
    state,
    description: str(field(value, 'description')),
    targetUrl: str(field(value, 'target_url')),
    createdAt: str(field(value, 'created_at')),
    updatedAt: str(field(value, 'updated_at')),
  };
}

interface RangeCommit {
  readonly sha: string;
  readonly summary: string;
}

function readRangeCommit(value: unknown): RangeCommit | null {
  const sha = requiredStr(field(value, 'sha'));
  if (sha === null) return null;
  const message = field(field(value, 'commit'), 'message');
  return { sha, summary: str(message) ?? '' };
}

interface RangeFile {
  readonly path: string;
  readonly status: string;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly changes: number | null;
}

function readRangeFile(value: unknown): RangeFile | null {
  const path = requiredStr(field(value, 'filename'));
  if (path === null) return null;
  return {
    path,
    status: str(field(value, 'status')) ?? 'modified',
    additions: intOrNull(field(value, 'additions')),
    deletions: intOrNull(field(value, 'deletions')),
    changes: intOrNull(field(value, 'changes')),
  };
}

/** A SHA narrowed at the read boundary, or null when GitHub reported an abbreviation. */
function readRangeSha(value: unknown): CommitSha | null {
  const sha = str(value);
  return sha !== null && isCommitSha(sha) ? sha : null;
}

interface ReviewShape {
  readonly id: string;
  readonly state: string;
  readonly reviewer: string;
  readonly submittedAt: string | null;
  /**
   * The commit this review was submitted against, which is how freshness is decided.
   *
   * Measured live on `egawilldoit/token-observatory#20`: every record carries the full `commit_id`
   * it approved. It is null only when the provider omitted it, and an approval that cannot be tied
   * to a commit is not counted — a guess in that direction would be an approval of nothing.
   */
  readonly commitId: string | null;
}

function readReview(value: unknown): ReviewShape | null {
  const id = providerIdentity(field(value, 'id'));
  const state = requiredStr(field(value, 'state'));
  if (id === null || state === null) return null;
  return {
    id,
    state,
    reviewer: str(field(field(value, 'user'), 'login')) ?? 'unknown',
    submittedAt: str(field(value, 'submitted_at')),
    commitId: str(field(value, 'commit_id')),
  };
}

/* -------------------------------------------------------------------------- */
/* Branch policy on the merge target (F26-AC5)                                  */
/* -------------------------------------------------------------------------- */

/** What branch protection alone requires of a review on one branch. */
interface BranchProtectionReviewRules {
  readonly requiredApprovals: number;
  readonly dismissStaleReviews: boolean;
  readonly requireCodeOwnerReviews: boolean;
  readonly requireLastPushApproval: boolean;
  /** Users, teams and apps only a maintainer may dismiss a review on behalf of. */
  readonly dismissalRestrictions: readonly string[];
  /** Status-check contexts the provider will not merge without. */
  readonly statusChecks: readonly string[];
}

function emptyReviewRules(): BranchProtectionReviewRules {
  return {
    requiredApprovals: 0,
    dismissStaleReviews: false,
    requireCodeOwnerReviews: false,
    requireLastPushApproval: false,
    dismissalRestrictions: [],
    statusChecks: [],
  };
}

/** One ruleset that is enforced on the merge target. */
interface ApplicableRuleset {
  readonly name: string;
  readonly requiredApprovals: number;
  readonly statusChecks: readonly string[];
  readonly dismissStaleReviews: boolean;
  readonly requireCodeOwnerReviews: boolean;
  readonly requireLastPushApproval: boolean;
  readonly bypassActors: readonly string[];
}

/** The effective policy on the merge target, with every source that contributed to it. */
interface MergePolicy {
  /** The strictest single requirement: GitHub enforces every source, so the largest binds. */
  readonly requiredApprovals: number;
  readonly approvalSources: readonly string[];
  readonly requiredChecks: readonly string[];
  readonly bypassActors: readonly string[];
  readonly dismissalRestrictions: readonly string[];
  readonly dismissesStaleReviews: readonly string[];
  readonly requireCodeOwnerReviews: readonly string[];
  readonly requireLastPushApproval: readonly string[];
  readonly sources: readonly string[];
}

/** Who a dismissal restriction or bypass allowance names, read through the boundary readers. */
function actorNames(value: unknown): readonly string[] {
  const names: string[] = [];
  for (const [key, loginKey] of [
    ['users', 'login'],
    ['teams', 'slug'],
    ['apps', 'slug'],
  ] as const) {
    for (const actor of arrayOf(field(value, key))) {
      const name = str(field(actor, loginKey));
      if (name !== null) names.push(`${key.slice(0, -1)} ${name}`);
    }
  }
  return names;
}

/**
 * Who may merge without satisfying a ruleset.
 *
 * `bypass_actors` is what makes an authorization worth nothing if the holder is one of these, so
 * it is read rather than left out of the report.
 */
function bypassActorNames(value: unknown): readonly string[] {
  const names: string[] = [];
  for (const actor of arrayOf(value)) {
    const mode = str(field(actor, 'bypass_mode'));
    const id = providerIdentity(field(actor, 'actor_id'));
    if (mode === 'always' && id !== null) names.push(`actor ${id} (bypass mode always)`);
  }
  return names;
}

/**
 * The status-check contexts a protection or ruleset requires.
 *
 * `contexts` and `checks` are both read because GitHub reports the same requirement twice: the
 * live capture of `egawilldoit/Ega-House-Platform/branches/main/protection` carried all fifteen
 * names in `contexts` and again in `checks[].context`.
 */
function requiredCheckContexts(value: unknown): readonly string[] {
  const contexts: string[] = [];
  for (const context of arrayOf(field(value, 'contexts'))) {
    const name = str(context);
    if (name !== null) contexts.push(name);
  }
  for (const check of arrayOf(field(value, 'checks'))) {
    const name = str(field(check, 'context'));
    if (name !== null) contexts.push(name);
  }
  return [...new Set(contexts)];
}

/**
 * Whether a ruleset's `ref_name` condition covers this branch.
 *
 * GitHub expresses the condition as minimatch patterns over `refs/heads/<name>` plus two
 * shorthands, both observed live: the ruleset on `egawilldoit/Ega-House-Platform` carries
 * `{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}}`. A condition with no `include` list
 * matches every ref, which is how a repository-wide ruleset is expressed.
 */
export function rulesetCoversRef(ruleset: unknown, target: string, defaultBranch: string): boolean {
  const conditions = field(ruleset, 'conditions');
  if (conditions === undefined) return true;
  const refName = field(conditions, 'ref_name');
  if (refName === undefined) return true;
  const include = arrayOf(field(refName, 'include'));
  if (include.length === 0) return true;
  const exclude = arrayOf(field(refName, 'exclude'));
  const ref = `refs/heads/${target}`;
  if (exclude.some((pattern) => refPatternMatches(str(pattern), ref, defaultBranch))) return false;
  return include.some((pattern) => refPatternMatches(str(pattern), ref, defaultBranch));
}

/** One `ref_name` pattern, with GitHub's two shorthands. Never a general glob engine. */
function refPatternMatches(pattern: string | null, ref: string, defaultBranch: string): boolean {
  if (pattern === null) return false;
  if (pattern === '~ALL') return true;
  if (pattern === '~DEFAULT_BRANCH') return ref === `refs/heads/${defaultBranch}`;
  // A pattern may be written with or without the `refs/heads/` prefix; both name the same branch.
  const candidates = pattern.startsWith('refs/') ? [pattern] : [pattern, `refs/heads/${pattern}`];
  return candidates.some((candidate) => minimatch(candidate, ref));
}

/**
 * The subset of minimatch a `ref_name` condition uses: `*` within a segment, `**` across them,
 * `?` for one character. Anything else is a literal, because a permissive glob is how a
 * repository-wide rule would be reported as applying to one branch by accident.
 */
function minimatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * A policy read that never happened, reported as the blocker it is.
 *
 * `Blocked` rather than `Unavailable` because the thing missing is a fact — whether the merge
 * target is protected — and no retry inside the adapter can supply it. Reporting a 403 as an
 * unprotected branch is the failure F26-AC5 exists to prevent: the owner would authorize a merge
 * against a rule nobody read.
 */
function unreadablePolicy(
  context: AdapterContext,
  cause: DomainError,
  target: string,
  what: string,
): DomainError {
  return blocked(
    context.redact(
      `The ${what} of ${target} could not be read, so the provider's approval requirement for that branch is unknown rather than absent: ${cause.reason}`,
    ),
    [
      {
        name: 'MergePolicyUnreadable',
        detail: `Reading ${what} for ${target} failed with ${cause.code}. GitHub answers 404 "Branch not protected" when a branch is genuinely unprotected, so a ${cause.code} here is a refusal or a fault and never evidence of absence.`,
        remedy: 'Grant the connector credential read access to administration on this repository (a token with `repo` and repository administration, or a GitHub App installation with the relevant read permission), then re-read provider state. Merges must not be authorized while the policy is unread.',
      },
    ],
  );
}

/** What the adapter counted, and what it refused to count and why. */
interface ApprovalTally {
  readonly counted: readonly string[];
  readonly stale: readonly string[];
  readonly withoutCommit: readonly string[];
  readonly superseded: readonly string[];
  readonly withdrawn: readonly string[];
}

/**
 * Current approvals, deduplicated by reviewer and tied to the head being merged.
 *
 * GitHub returns one record per review *event*, not per reviewer: the live capture of
 * `egawilldoit/token-observatory#20` holds six `COMMENTED` records from one `MORTAKI0` for one
 * `commit_id`, and `#19` holds records against two different `commit_id`s. Counting records would
 * let one person satisfy a two-review rule, and counting every record would let an approval of an
 * earlier commit pass as an approval of this one. The last record per reviewer is that person's
 * current decision — the list is chronological — and it counts only when it approved the head.
 */
function countCurrentApprovals(reviews: readonly ReviewShape[], headSha: string | null): ApprovalTally {
  const latest = new Map<string, ReviewShape>();
  const duplicates = new Set<string>();
  for (const review of reviews) {
    if (latest.has(review.reviewer)) duplicates.add(review.reviewer);
    latest.set(review.reviewer, review);
  }
  const counted: string[] = [];
  const stale: string[] = [];
  const withoutCommit: string[] = [];
  const withdrawn: string[] = [];
  for (const review of latest.values()) {
    if (review.state.toUpperCase() !== 'APPROVED') {
      withdrawn.push(`${review.reviewer} (${review.state.toLowerCase()})`);
      continue;
    }
    if (headSha === null) {
      withoutCommit.push(review.reviewer);
      continue;
    }
    if (review.commitId === null) {
      withoutCommit.push(review.reviewer);
      continue;
    }
    if (review.commitId !== headSha) {
      stale.push(`${review.reviewer} (approved ${review.commitId.slice(0, 12)}, head is ${headSha.slice(0, 12)})`);
      continue;
    }
    counted.push(review.reviewer);
  }
  return {
    counted: counted.sort(),
    stale: stale.sort(),
    withoutCommit: withoutCommit.sort(),
    superseded: [...duplicates].sort(),
    withdrawn: withdrawn.sort(),
  };
}

/** The one sentence an owner reads, naming the target, every source and every exclusion. */
function approvalRuleDetail(target: string, policy: MergePolicy, tally: ApprovalTally): string {
  const parts: string[] = [
    `The provider requires ${String(policy.requiredApprovals)} approving review(s) on ${target} and ${String(tally.counted.length)} current approval(s) count towards it (${policy.approvalSources.join('; ') || 'an unnamed rule'}).`,
    'The provider, not ShipLoop, is the authority on whether this is satisfied (F26-AC5).',
  ];
  if (policy.dismissesStaleReviews.length > 0) {
    parts.push(`${policy.dismissesStaleReviews.join('; ')} dismisses reviews when the head moves.`);
  }
  if (policy.requireCodeOwnerReviews.length > 0) {
    parts.push(`${policy.requireCodeOwnerReviews.join('; ')} additionally requires an approving review from a code owner, which this read cannot evaluate.`);
  }
  if (policy.requireLastPushApproval.length > 0) {
    parts.push(`${policy.requireLastPushApproval.join('; ')} requires the last pusher to approve, so an author who pushes cannot satisfy its own rule.`);
  }
  if (policy.dismissalRestrictions.length > 0) {
    parts.push(`Only ${policy.dismissalRestrictions.join(', ')} may dismiss a review on this branch.`);
  }
  if (tally.superseded.length > 0) {
    parts.push(`Repeated review records from ${tally.superseded.join(', ')} were reduced to their latest decision, so one reviewer counts once.`);
  }
  if (tally.stale.length > 0) {
    parts.push(`Not counted as current: ${tally.stale.join(', ')}.`);
  }
  if (tally.withoutCommit.length > 0) {
    parts.push(`Not counted because GitHub reported no commit for them: ${tally.withoutCommit.join(', ')}.`);
  }
  if (tally.withdrawn.length > 0) {
    parts.push(`Latest decision is not an approval: ${tally.withdrawn.join(', ')}.`);
  }
  return parts.join(' ');
}

/* -------------------------------------------------------------------------- */
/* Input validation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A full commit SHA or a refusal.
 *
 * `CommitSha` is a compile-time brand, and a caller that casts a literal can put a seven
 * character abbreviation into a request. Every provider call in this adapter addresses a
 * commit by SHA, so an abbreviation would resolve to whatever that prefix uniquely names
 * at the moment of the call — which is not the revision the caller authorized. The check
 * runs at the boundary so the answer is a refusal with the offending value named, never a
 * silent resolution (F26-AC1, F26-AC4).
 */
function requireFullSha(value: string, field: string): Result<CommitSha> {
  if (!isCommitSha(value)) {
    return err(
      invalid(`GitHub operations address a full 40 or 64 character commit SHA.`, [
        {
          path: field,
          message: `"${value.slice(0, 12)}" is not a full commit SHA. An abbreviation is refused rather than resolved, because the revision it names can change between the check and the write.`,
        },
      ]),
    );
  }
  return ok(value);
}

/**
 * A repository name this adapter may address.
 *
 * `owner/repo` is the only shape GitHub accepts in every path this adapter builds, and the
 * value reaches a URL path and a `git push` argv. The shape is checked here rather than
 * encoded at each use, so a repository identity from configuration cannot become a path
 * segment such as `../other/repo` (N02-AC1).
 */
function parseRepositoryName(fullName: string): Result<RepositoryNames> {
  const segments = fullName.split('/');
  const owner = segments[0];
  const repo = segments[1];
  if (segments.length !== 2 || owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    return err(
      invalid(`A GitHub repository must be named "owner/repository".`, [
        { path: 'repository.fullName', message: `"${fullName.slice(0, 64)}" is not an owner/repository name.` },
      ]),
    );
  }
  if (!REF_SEGMENT.test(owner) || !REF_SEGMENT.test(repo)) {
    return err(
      invalid(`A GitHub repository name must contain only letters, digits, dots, underscores and hyphens.`, [
        { path: 'repository.fullName', message: `"${fullName.slice(0, 64)}" contains a character GitHub does not accept in a repository name.` },
      ]),
    );
  }
  return ok({ owner, repo });
}

/**
 * A ref name this adapter may read or write.
 *
 * GitHub's own rules are narrower than "any string without a slash": a ref may not contain
 * `..`, `~`, `^`, `:`, `?`, `*`, `[`, `\`, whitespace or a control character, may not
 * begin or end with `/`, may not end with `.lock` and may not contain `@{`. A branch is
 * also passed to `git push` as an argv element, so this is the single place where a
 * caller-supplied name is checked before it becomes a provider argument.
 */
function requireRefName(name: string, field: string): Result<string> {
  const unusable =
    name.length === 0 ||
    name.length > 255 ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.lock') ||
    name.includes('..') ||
    name.includes('@{') ||
    /[\s~^:?*[\\\u0000-\u001f\u007f]/.test(name) ||
    name.endsWith('.');
  if (unusable) {
    return err(
      invalid(`GitHub refused the supplied ref name.`, [
        {
          path: field,
          message: `"${name.slice(0, 64)}" is not a ref name GitHub accepts. A ref may not contain whitespace, ~ ^ : ? * [ \\, .., @{ or a control character, may not begin or end with "/", and may not end with ".lock".`,
        },
      ]),
    );
  }
  return ok(name);
}

/**
 * Refuses a repository identity this provider does not own.
 *
 * A same-named resource at another provider is not the same repository, and acting on it
 * would push or merge code somewhere the owner never configured. This is the git-side
 * statement of F11-AC3 and N05-AC2.
 */
function refuseForeignRepository(repository: GitRepositoryRef, redact: (text: string) => string): DomainError | null {
  if (repository.provider === GITHUB_PROVIDER) return null;
  return {
    code: 'Forbidden',
    reason: redact(
      `"${repository.fullName}" is presented as provider "${repository.provider}", not "${GITHUB_PROVIDER}". Refused rather than acted on, because a repository of the same name at another provider is a different repository.`,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Draft body rendering                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The provenance of a managed delivery, written into the body it belongs to.
 *
 * It lives in the provider, not in ShipLoop, so "was this draft already written?" survives
 * a restart, a lost response and a second process. That is what makes the reconciliation
 * read possible at all given that GitHub has no client-supplied pull-request identity.
 * Every field is URL-encoded because the caller supplies free text.
 */
export function managedMarkerLine(input: {
  readonly operationId: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly link: string;
  readonly digest: string;
  readonly writtenAt: string;
}): string {
  const fields = [
    `op=${encodeURIComponent(input.operationId)}`,
    `head=${encodeURIComponent(input.headSha)}`,
    `base=${encodeURIComponent(input.baseBranch)}`,
    `link=${encodeURIComponent(input.link)}`,
    `digest=${encodeURIComponent(input.digest)}`,
    `at=${encodeURIComponent(input.writtenAt)}`,
  ];
  return `${MANAGED_MARKER_PREFIX} ${fields.join(' ')} -->`;
}

interface ManagedMarker {
  readonly operationId: string | null;
  readonly headSha: string | null;
  readonly baseBranch: string | null;
  readonly link: string | null;
  readonly digest: string | null;
  readonly writtenAt: string | null;
}

function decodeField(value: string | null): string | null {
  if (value === null) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The managed marker line as the provider carries it, or an empty string when absent. */
export function markerLineOf(body: string): string {
  const start = body.indexOf(MANAGED_MARKER_PREFIX);
  if (start < 0) return '';
  const end = body.indexOf('-->', start);
  return end < 0 ? '' : body.slice(start, end + 3);
}

export function parseManagedMarker(body: string): ManagedMarker | null {
  const start = body.indexOf(MANAGED_MARKER_PREFIX);
  if (start < 0) return null;
  const end = body.indexOf('-->', start);
  if (end < 0) return null;
  const fields = body.slice(start + MANAGED_MARKER_PREFIX.length, end).trim().split(/\s+/);
  const read = (name: string): string | null => {
    const found = fields.find((entry) => entry.startsWith(`${name}=`));
    return found === undefined ? null : found.slice(name.length + 1);
  };
  return {
    operationId: decodeField(read('op')),
    headSha: decodeField(read('head')),
    baseBranch: decodeField(read('base')),
    link: decodeField(read('link')),
    digest: decodeField(read('digest')),
    writtenAt: decodeField(read('at')),
  };
}

/** The digest of the content ShipLoop manages, so an unchanged rewrite is detectable. */
function contentDigest(body: DraftBody): string {
  return fingerprint({ body: managedContentOf(body) }).slice(3, 19);
}

/**
 * The rendered managed content.
 *
 * A verification claim can only name a check that actually reported a result, because
 * `VerificationClaim` has no "passed" variant that does not carry a check id. So a claim of
 * a pass is unreachable for a check that did not report one, and a rendered draft cannot
 * say a check passed without naming it (F19-AC2).
 */
function managedContentOf(body: DraftBody): string {
  const lines: string[] = [];
  lines.push(`### Purpose`, '', body.purpose.trim(), '');
  lines.push(`### Scope`, '', body.scope.trim(), '');
  lines.push(`### Acceptance criteria`, '');
  if (body.criteria.length === 0) {
    lines.push('- No acceptance criteria were supplied with this draft.');
  }
  for (const line of body.criteria) {
    lines.push(`- ${checkboxFor(line.claim)} **${line.criterionId}** ${line.text.trim()} — ${claimText(line.claim)}`);
  }
  lines.push('');
  lines.push(`### Known gaps`, '');
  if (body.knownGaps.length === 0) {
    lines.push('- None were recorded for this change.');
  }
  for (const gap of body.knownGaps) {
    lines.push(`- ${gap.trim()}`);
  }
  lines.push('');
  lines.push(`### Verification`, '');
  if (body.verification.kind === 'NotRun') {
    lines.push(`- Not run: ${body.verification.reason.trim()}`);
  } else if (body.verification.checks.length === 0) {
    lines.push('- The provider reported no check result for this candidate head.');
  } else {
    for (const check of body.verification.checks) {
      lines.push(`- ${checkboxFor(check.claim)} ${check.name.trim()} — ${claimText(check.claim)}`);
    }
  }
  lines.push('');
  lines.push(`### Linked work`, '');
  lines.push(
    body.linkedWork.kind === 'Ticket'
      ? `- ${body.linkedWork.issue.identifier} (${body.linkedWork.issue.url})`
      : `- None: ${body.linkedWork.reason.trim()}`,
  );
  return lines.join('\n');
}

/**
 * The checkmark a claim earns.
 *
 * `ReportedPassed` is the only claim that ticks the box. `NotRun`, `ReportedPending` and
 * `ReportedFailed` all leave it open, so a draft body cannot present an unexecuted check as
 * satisfied (F19-AC2).
 */
function checkboxFor(claim: DraftBody['criteria'][number]['claim']): string {
  return claim.kind === 'ReportedPassed' ? '[x]' : '[ ]';
}

/** The words a claim is rendered with, so the claim kind is legible to a reader. */
function claimText(claim: DraftBody['criteria'][number]['claim']): string {
  switch (claim.kind) {
    case 'NotRun':
      return `not run (${claim.reason})`;
    case 'ReportedPassed':
      return `reported passed by check ${claim.checkId}`;
    case 'ReportedFailed':
      return `reported failed by check ${claim.checkId}`;
    case 'ReportedPending':
      return `still running on check ${claim.checkId}`;
  }
}

/**
 * The whole draft body: the caller's own text, then the delimited managed region.
 *
 * Anything the caller wrote outside the region is preserved verbatim, so a human's context
 * above the marker survives every managed update. `existingBody` is the body currently on
 * the provider, which is how a human's edits made between the markers' last write and now
 * are kept (F16-AC2).
 */
export function draftBody(
  body: DraftBody,
  existingBody: string | null,
): string {
  const marker = body.managedMarker.trim();
  const region = [
    MANAGED_START,
    marker,
    managedContentOf(body),
    MANAGED_END,
  ].join('\n');
  const existing = existingBody ?? '';
  const existingStart = existing.indexOf(MANAGED_START);
  const existingEnd = existing.indexOf(MANAGED_END);
  if (existingStart >= 0 && existingEnd > existingStart) {
    const before = existing.slice(0, existingStart);
    const after = existing.slice(existingEnd + MANAGED_END.length);
    return `${before}${region}${after}`;
  }
  return existing.length === 0 ? region : `${existing.replace(/\s+$/, '')}\n\n${region}`;
}

/** The managed region's own text, for a section-by-section change comparison. */
function managedRegionOf(body: string): string | null {
  const start = body.indexOf(MANAGED_START);
  const end = body.indexOf(MANAGED_END);
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + MANAGED_END.length);
}

/**
 * Which managed sections differ between the provider's body and the one to be written.
 *
 * Reported so the owner UI can say what an update changed rather than only that something
 * did. Only the managed region is compared, so a human's edit outside it is never reported
 * as a ShipLoop change.
 */
function changedSectionsOf(existing: string | null, next: string): readonly string[] {
  const before = existing === null ? null : managedRegionOf(existing);
  const after = managedRegionOf(next);
  if (before === null || after === null) {
    return before === after ? [] : [...MANAGED_SECTIONS];
  }
  const beforeSections = splitSections(before);
  const afterSections = splitSections(after);
  const changed: string[] = [];
  for (const section of MANAGED_SECTIONS) {
    if (beforeSections[section] !== afterSections[section]) changed.push(section);
  }
  return changed;
}

/** The `### heading` blocks of a managed region, keyed by lowercased heading text. */
function splitSections(region: string): Readonly<Record<string, string>> {
  const sections: Record<string, string> = {};
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current !== null) sections[current] = buffer.join('\n').trim();
  };
  for (const line of region.split('\n')) {
    const heading = /^###\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      current = (heading[1] ?? '').trim().toLowerCase();
      buffer = [];
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  return sections;
}

/** The region identity a GitHub draft owns. */
function managedTarget(body: DraftBody, context: string): Result<ManagedRegionTarget> {
  if (body.managedProgressRegion === null) {
    return ok({ kind: 'ManagedBodyBlock', blockId: MANAGED_START });
  }
  if (body.managedProgressRegion.kind === 'AppendOnlyCommentThread') {
    return err({
      code: 'Unavailable',
      reason: context,
    });
  }
  return ok(body.managedProgressRegion);
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The capability declaration for GitHub, stated as observed on 1 October 2026.
 *
 * `Git:MergeWithPrecondition` is genuinely supported and genuinely privileged: GitHub's
 * merge endpoint takes the pinned head, and merging is a delivery action a coding stage must
 * never hold (F03-AC5, N02-AC3). What this declaration cannot express — and what `README.md`
 * states instead — is that **the same `repo`-scoped credential can also push**, so the
 * push/merge boundary is a property of the orchestrator's credential broker and not of this
 * token. `mergeSupportNote` records the measured permissions so a caller can see what the
 * declaration rests on.
 */
const DECLARATIONS: readonly CapabilityDeclaration[] = [
  { kind: 'Git:ReadRepository', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  { kind: 'Git:ReadChecks', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  { kind: 'Git:PushBranch', supported: true, limitation: null, privileged: false, supportsPrecondition: true },
  { kind: 'Git:CreateDraft', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  { kind: 'Git:UpdateDraft', supported: true, limitation: null, privileged: false, supportsPrecondition: true },
  { kind: 'Git:MergeWithPrecondition', supported: true, limitation: null, privileged: true, supportsPrecondition: true },
];

export class GitHubGitAdapter implements GitAdapter {
  readonly kind = 'Git' as const;
  readonly connectorId: ConnectorId;
  private readonly client: GitHubClient;
  private readonly git: GitTransport;
  private readonly remoteName: string;
  private readonly maxPullRequestPages: number;

  constructor(options: GitHubGitAdapterOptions) {
    this.connectorId = options.connectorId;
    this.client = new GitHubClient(options.client);
    this.git = options.git;
    this.remoteName = options.gitRemoteName ?? 'origin';
    this.maxPullRequestPages = Math.max(1, options.maxPullRequestPages ?? 3);
  }

  capabilities(): AdapterCapabilities {
    return { kind: 'Git', contractVersion: ADAPTER_CONTRACT_VERSION, declarations: DECLARATIONS };
  }

  /**
   * Probes the credential rather than assuming it (F03-AC2, F03-AC4).
   *
   * The probe reads the repository, which is the call that proves the credential can reach
   * the configured repository at all. GitHub reports no connector-level API version, so
   * `runtimeVersion` is the `x-github-api-version-selected` response header, verified live
   * as `2022-11-28`. A revoked credential yields `compatible: false` carrying the
   * reauthorization instruction, so the owner UI can show an actionable error before work
   * starts (F03-AC4).
   */
  async checkCompatibility(
    context: AdapterContext,
    repository?: GitRepositoryRef,
  ): Promise<Result<AdapterCompatibility>> {
    const observedAt = context.clock.now();
    if (repository === undefined) {
      return ok({
        kind: 'Git',
        contractVersion: ADAPTER_CONTRACT_VERSION,
        runtimeVersion: null,
        compatible: false,
        detail:
          'No repository was supplied, so the credential was not probed. A GitHub connector is only compatible once it can read the configured repository.',
        observedAt,
      });
    }
    const read = await this.repositoryRead(context, repository);
    if (!read.ok) {
      return ok({
        kind: 'Git',
        contractVersion: ADAPTER_CONTRACT_VERSION,
        runtimeVersion: null,
        compatible: false,
        detail: read.error.reason,
        observedAt,
      });
    }
    return ok({
      kind: 'Git',
      contractVersion: ADAPTER_CONTRACT_VERSION,
      runtimeVersion: this.observedApiVersion,
      compatible: true,
      detail: compatibilityDetail(read.value, this.remoteName),
      observedAt,
    });
  }

  private observedApiVersion: string | null = null;

  /**
   * F19-AC3, F24-AC4: one read of the live facts a review card and a stale-decision check
   * both need.
   *
   * The head, base, pull request and reviews are read together because a decision that
   * compares facts read at different instants cannot tell whether they were ever
   * consistent (F26-AC2).
   */
  async readState(context: AdapterContext, request: ReadGitStateRequest): Promise<Result<GitStateRead>> {
    const foreign = refuseForeignRepository(request.repository, context.redact);
    if (foreign !== null) return err(foreign);
    const names = parseRepositoryName(request.repository.fullName);
    if (!names.ok) return names;
    const branch = requireRefName(request.branch, 'branch');
    if (!branch.ok) return branch;
    const baseBranch = requireRefName(request.baseBranch, 'baseBranch');
    if (!baseBranch.ok) return baseBranch;

    const repository = await this.repositoryRead(context, request.repository);
    if (!repository.ok) return repository;
    if (repository.value.archived) {
      return err(
        blocked(`${request.repository.fullName} is archived on GitHub, so its refs are read-only.`, [
          {
            name: 'ArchivedRepository',
            detail: `GitHub reports ${request.repository.fullName} with archived: true.`,
            remedy: 'Unarchive the repository on GitHub, or configure a repository that still accepts changes. Nothing was read as current.',
          },
        ]),
      );
    }

    const head = await this.refRead(context, names.value, branch.value, request.repository);
    if (!head.ok) return head;
    const base = await this.refRead(context, names.value, baseBranch.value, request.repository);
    if (!base.ok) return base;

    const pullRequest = await this.latestPullRequest(context, names.value, branch.value);
    if (!pullRequest.ok) return pullRequest;
    let submittedReviews: readonly GitReviewState[] = [];
    let reviewShapes: readonly ReviewShape[] = [];
    if (pullRequest.value !== null) {
      const reviews = await this.reviewsRead(context, names.value, pullRequest.value);
      if (!reviews.ok) return reviews;
      reviewShapes = reviews.value.shapes;
      submittedReviews = reviews.value.states;
    }

    // The policy is read for the branch the change would land on, not the branch it came from.
    // F26-AC5 asks what the provider will require at the merge, and a repository protects its
    // default branch rather than the feature branches it opens.
    const policyRules = await this.approvalRules(
      context,
      names.value,
      baseBranch.value,
      repository.value.defaultBranch,
      submittedReviews,
      reviewShapes,
      // Freshness is measured against the head the pull request currently holds. With no pull
      // request there is nothing to approve, so no head is passed and nothing can count.
      pullRequest.value?.headSha ?? null,
    );
    if (!policyRules.ok) return policyRules;

    return ok({
      repository: {
        provider: GITHUB_PROVIDER,
        fullName: repository.value.fullName,
        defaultBranch: repository.value.defaultBranch,
        url: repository.value.htmlUrl,
      },
      head: head.value,
      base: base.value,
      pullRequest: pullRequest.value === null ? null : pullRequestRefOf(pullRequest.value),
      reviews: policyRules.value,
      observedAt: context.clock.now(),
    });
  }

  /**
   * Reads one pull request the owner named, by number.
   *
   * This is the read side of manual candidate linking, and it is deliberately narrow: no
   * branch here can push, merge, close, approve, deploy or change a protection rule. The
   * MVP's external workflow creates the pull request; ShipLoop's job begins once its
   * address exists, and everything below only *reads*.
   *
   * The order of the checks is the order of the questions an owner is asking, and each
   * refusal answers a different one:
   *
   *   1. is this repository one this provider owns? A same-named repository at another
   *      provider is a different repository, so acting on it would read the wrong code;
   *   2. is the repository name one GitHub paths can be built from?
   *   3. does the number name a pull request at all?
   *   4. can this credential read the repository? This is also the accessibility check:
   *      a repository the credential cannot open produces GitHub's own refusal, and
   *      "you cannot see this" is not reported as "it does not exist";
   *   5. is the repository archived? An archived repository's pull requests are read-only,
   *      so linking one as new work would promise something nobody can do;
   *   6. does the pull request exist, and does it carry two full commit SHAs?
   *
   * The head and base SHAs come from one payload in one call, so the identity the caller
   * records is internally consistent rather than a composite of two reads that could
   * straddle a push.
   */
  async readLinkedPullRequest(
    context: AdapterContext,
    request: ReadLinkedPullRequestRequest,
  ): Promise<Result<LinkedPullRequestFacts>> {
    const foreign = refuseForeignRepository(request.repository, context.redact);
    if (foreign !== null) return err(foreign);
    const names = parseRepositoryName(request.repository.fullName);
    if (!names.ok) return names;
    const number = request.pullRequestNumber;
    if (!Number.isSafeInteger(number) || number <= 0) {
      return err(
        invalid(`GitHub addresses a pull request by its display number.`, [
          {
            path: 'pullRequestNumber',
            message: `"${String(number)}" is not a positive pull request number. A number alone is also not candidate identity: the full head commit is read from the pull request itself.`,
          },
        ]),
      );
    }

    const repository = await this.repositoryRead(context, request.repository);
    if (!repository.ok) return repository;
    if (repository.value.archived) {
      return err(
        blocked(`${request.repository.fullName} is archived on GitHub, so its pull requests are read-only.`, [
          {
            name: 'ArchivedRepository',
            detail: `GitHub reports ${request.repository.fullName} with archived: true.`,
            remedy:
              'Link a pull request in a repository that still accepts changes. Nothing was written and no state changed.',
          },
        ]),
      );
    }

    // GitHub keys every pull-request path by the display number, so the number is the
    // provider identity here and the global numeric `id` would build a path the API rejects.
    const pull = await this.pullRequestRead(context, names.value, String(number) as ProviderId);
    if (!pull.ok) return pull;
    const observed = pull.value;
    const head = requireFullSha(observed.headSha, 'headSha');
    if (!head.ok) return head;
    const base = requireFullSha(observed.baseSha, 'baseSha');
    if (!base.ok) return base;

    return ok({
      repository: {
        provider: GITHUB_PROVIDER,
        fullName: repository.value.fullName,
        defaultBranch: repository.value.defaultBranch,
        url: repository.value.htmlUrl,
      },
      providerPullRequestId: observed.id as ProviderId,
      number: observed.number,
      url: observed.htmlUrl,
      state: pullRequestStateOf(observed),
      draft: observed.draft,
      headBranch: observed.headRef,
      headSha: head.value,
      baseBranch: observed.baseRef,
      baseSha: base.value,
      headRepository: observed.headRepository,
      mergedSha: observed.mergeCommitSha !== null && isCommitSha(observed.mergeCommitSha)
        ? (observed.mergeCommitSha as CommitSha)
        : null,
      mergedAt: observed.mergedAt,
      observedAt: context.clock.now(),
    });
  }

  /**
   * F20-AC1, F20-AC2: every check the provider reported, plus every required check it did
   * not.
   *
   * Three sources are read, in the order a check should win. Check runs are GitHub's current
   * mechanism. Commit statuses are still reported by GitHub alongside check runs, and a
   * project whose CI posts statuses would otherwise appear to have no results. A check name
   * required by the profile but reported on neither is `Missing`, never `Passed`.
   */
  async readChecks(
    context: AdapterContext,
    request: ReadChecksRequest,
  ): Promise<Result<readonly ProviderCheckObservation[]>> {
    const foreign = refuseForeignRepository(request.repository, context.redact);
    if (foreign !== null) return err(foreign);
    const names = parseRepositoryName(request.repository.fullName);
    if (!names.ok) return names;
    const head = requireFullSha(request.headSha, 'headSha');
    if (!head.ok) return head;
    const base = requireFullSha(request.baseSha, 'baseSha');
    if (!base.ok) return base;

    const reported = await this.observedChecks(context, names.value, head.value);
    if (!reported.ok) return reported;
    const required = new Set(request.requiredCheckNames);
    const observations: ProviderCheckObservation[] = reported.value.map((check) =>
      toObservation(check, head.value, required.has(check.name) ? 'ProfileRequired' : 'ProviderExtra', context.redact),
    );
    const seen = new Set(observations.map((observation) => observation.name));
    const missingOnHead = request.requiredCheckNames.filter((name) => !seen.has(name));
    if (missingOnHead.length === 0) {
      return ok(observations);
    }

    const onBase = await this.baseObservations(context, names.value, base.value, missingOnHead, context.redact);
    if (!onBase.ok) return onBase;
    return ok([...observations, ...onBase.value]);
  }

  /**
   * The required checks the candidate head did not report, distinguished by whether the base
   * commit ran them.
   *
   * A required check the base ran and the candidate did not was not rerun for this
   * candidate, so it is `Stale`: a green result exists, but it belongs to a different
   * revision and cannot approve this one (F20-AC3, F24-AC4). A required check neither commit
   * ran is `Missing`. This is the only place `Stale` is produced, and it is produced from
   * two live reads rather than from a caller-supplied guess.
   */
  private async baseObservations(
    context: AdapterContext,
    names: RepositoryNames,
    baseSha: CommitSha,
    requiredNames: readonly string[],
    redact: (text: string) => string,
  ): Promise<Result<readonly ProviderCheckObservation[]>> {
    const observed = await this.observedChecks(context, names, baseSha);
    if (!observed.ok) return observed;
    const byName = new Map(observed.value.map((check) => [check.name, check]));
    return ok(
      requiredNames.map((name): ProviderCheckObservation => {
        const onBase = byName.get(name);
        if (onBase === undefined) {
          return {
            checkId: `check_missing_${name}`,
            name,
            result: 'Missing',
            requirement: 'ProfileRequired',
            startedAt: null,
            endedAt: null,
            exitCode: null,
            detail: redact(
              `The project profile requires "${name}". Neither the candidate head nor the base commit ${baseSha.slice(0, 12)} reported a run for it, so there is no result to report.`,
            ),
            artifactUrl: null,
          };
        }
        return {
          checkId: `check_stale_${name}`,
          name,
          result: 'Stale',
          requirement: 'ProfileRequired',
          startedAt: onBase.startedAt,
          endedAt: onBase.endedAt,
          exitCode: null,
          detail: redact(
            `The project profile requires "${name}". It reported on the base commit ${baseSha.slice(0, 12)} but not on this candidate head, so its result belongs to a superseded revision and cannot approve this candidate (F20-AC3).`,
          ),
          artifactUrl: onBase.artifactUrl,
        };
      }),
    );
  }

  /**
   * F20-AC1, F24-AC1: the commit range between two revisions.
   *
   * GitHub's compare endpoint returns ahead/behind counts, the merge base, the commits and
   * the changed files in one response, so the range a review card shows and the range a diff
   * is taken from are the same facts read together rather than two calls that can disagree.
   *
   * The commits list is bounded. A range longer than the bound is reported with
   * `totalCommits` intact and `truncated: true`, because a silently shortened list of the
   * commits behind a candidate is worse than an explicitly incomplete one (F24-AC1).
   */
  async readCommitRange(
    context: AdapterContext,
    request: ReadCommitRangeRequest,
  ): Promise<Result<GitCommitRange>> {
    const foreign = refuseForeignRepository(request.repository, context.redact);
    if (foreign !== null) return err(foreign);
    const names = parseRepositoryName(request.repository.fullName);
    if (!names.ok) return names;
    const base = requireFullSha(request.baseSha, 'baseSha');
    if (!base.ok) return base;
    const head = requireFullSha(request.headSha, 'headSha');
    if (!head.ok) return head;

    const read = await this.client.execute(context, {
      operationName: 'GitHubCommitRangeRead',
      method: 'GET',
      path: `/repos/${names.value.owner}/${names.value.repo}/compare/${base.value}...${head.value}`,
    });
    if (!read.ok) {
      if (read.error.code === 'NotFound') {
        return err({
          code: 'NotFound',
          reason: context.redact(
            `GitHub cannot compare ${base.value.slice(0, 12)}...${head.value.slice(0, 12)} in ${request.repository.fullName}. One of the two commits is unknown to the provider, so no range can be reported.`,
          ),
        });
      }
      return read;
    }
    const payload = read.value.data;
    const commits = arrayOf(field(payload, 'commits')).map(readRangeCommit).filter((entry): entry is RangeCommit => entry !== null);
    const files = arrayOf(field(payload, 'files')).map(readRangeFile).filter((entry): entry is RangeFile => entry !== null);
    const total = intOrNull(field(payload, 'total_commits'));
    return ok({
      baseSha: base.value,
      headSha: head.value,
      mergeBaseSha: readRangeSha(field(field(payload, 'merge_base_commit'), 'sha')),
      aheadBy: intOrNull(field(payload, 'ahead_by')),
      behindBy: intOrNull(field(payload, 'behind_by')),
      totalCommits: total,
      commits: commits.slice(0, MAX_COMMIT_RANGE),
      files,
      truncated: commits.length > MAX_COMMIT_RANGE || files.length > MAX_COMMIT_RANGE,
      observedAt: context.clock.now(),
    });
  }

  /**
   * F19-AC1: publishes a working branch.
   *
   * Three checks happen before the push. The head must be a full SHA, so an abbreviation
   * cannot be resolved to whatever it happens to name. The local checkout must hold that
   * exact commit, because GitHub has never seen these objects. And the configured remote's
   * URL must be the configured repository, because `git push origin` against a remote that
   * points somewhere else would publish code the owner never reviewed.
   *
   * `ForceWithLease` pins the remote's current ref, read from the API first, so a branch
   * that advanced after the read is refused rather than overwritten (F30-AC2).
   */
  async pushBranch(context: AdapterContext, request: PushBranchRequest): Promise<Result<PushBranchOutcome>> {
    const foreign = refuseForeignRepository(request.repository, context.redact);
    if (foreign !== null) return err(foreign);
    const names = parseRepositoryName(request.repository.fullName);
    if (!names.ok) return names;
    const branch = requireRefName(request.branch, 'branch');
    if (!branch.ok) return branch;
    const head = requireFullSha(request.headSha, 'headSha');
    if (!head.ok) return head;

    const remote = await this.remoteRefRead(context, names.value, branch.value);
    if (!remote.ok) return remote;
    if (remote.value === request.headSha) {
      return ok({ kind: 'AlreadyPresent', branch: request.branch, sha: request.headSha });
    }

    const local = await this.git.run(context, ['rev-parse', '--verify', '--quiet', `${request.headSha}^{commit}`]);
    if (!local.ok) return local;
    if (local.value.exitCode !== 0 || local.value.stdout.trim() !== request.headSha) {
      return err(
        blocked(`The local checkout at ${this.git.workingDirectory} does not hold the commit the request names.`, [
          {
            name: 'LocalCommitAbsent',
            detail: `git rev-parse reported "${local.value.stdout.trim().slice(0, 64)}" for ${request.headSha.slice(0, 12)}, so the objects to publish are not present locally.`,
            remedy:
              'Run the push from the workspace that built this candidate, or fetch the commit into the workspace first. Nothing was sent to GitHub.',
          },
        ]),
      );
    }

    const guard = await this.remoteGuard(context, request.repository);
    if (!guard.ok) return guard;

    const argv = ['push', '--porcelain'];
    if (request.forceStrategy === 'ForceWithLease') {
      argv.push(`--force-with-lease=refs/heads/${branch.value}:${remote.value ?? ''}`);
    }
    argv.push(this.remoteName, `${request.headSha}:refs/heads/${branch.value}`);

    const pushed = await this.git.run(context, argv);
    if (!pushed.ok) {
      return err(pushed.error);
    }
    if (pushed.value.exitCode !== 0) {
      return err(pushFailure(pushed.value.stderr, context.redact, request.branch));
    }

    const settled = await this.remoteRefRead(context, names.value, branch.value);
    if (!settled.ok) {
      return err(
        {
          code: 'OutcomeUnknown',
          reason: context.redact(
            `git push reported success for ${request.branch}, but the remote ref could not be read back, so the published head is unconfirmed. Read refs/heads/${branch.value} before any retry.`,
          ),
          operationId: context.operationId,
          target: `${request.repository.fullName}:refs/heads/${request.branch}`,
        },
      );
    }
    if (settled.value !== request.headSha) {
      return err(
        {
          code: 'OutcomeUnknown',
          reason: context.redact(
            `git push reported success for ${request.branch}, but refs/heads/${branch.value} now reads ${(settled.value ?? '(absent)').slice(0, 12)} rather than ${request.headSha.slice(0, 12)}. The published head is unconfirmed, so read the ref before any retry.`,
          ),
          operationId: context.operationId,
          target: `${request.repository.fullName}:refs/heads/${request.branch}`,
        },
      );
    }
    return ok({
      kind: 'Pushed',
      branch: request.branch,
      sha: request.headSha,
      remoteUrl: `${request.repository.url}/tree/${encodeRef(request.branch)}`,
    });
  }

  /**
   * F19-AC3: the reconciliation read.
   *
   * A draft is found by the operation identity its managed marker carries, or by the head
   * and link the request names. The marker is the reliable key because GitHub offers no
   * client-supplied pull-request identity to key on instead.
   */
  async findDrafts(
    context: AdapterContext,
    request: FindDraftsRequest,
  ): Promise<Result<readonly DraftRef[]>> {
    const foreign = refuseForeignRepository(request.repository, context.redact);
    if (foreign !== null) return err(foreign);
    const names = parseRepositoryName(request.repository.fullName);
    if (!names.ok) return names;
    const head = requireFullSha(request.headSha, 'headSha');
    if (!head.ok) return head;

    const found = await this.managedPullRequests(context, names.value, request.repository);
    if (!found.ok) return found;
    const matching = found.value.filter((pull) => isMatchFor(pull, request, names.value.owner));
    return ok(matching.map((pull) => this.draftRefOf(pull, request.link)));
  }

  /**
   * F19-AC1, F19-AC3, F19-AC5: create or update exactly one linked draft.
   *
   * The order is the whole design. When the caller reports no existing draft, the adapter
   * **reads before it writes**. An open draft whose body carries this operation's managed
   * marker is adopted, and its return value is `RecoveredAfterLostResponse` rather than a
   * second create. A create whose response is lost is reported `OutcomeUnknown` and never
   * retried inside the adapter, so the retry arrives here, finds the pull request the lost
   * create produced, and finishes the job without a duplicate.
   *
   * What this cannot promise is stated in `README.md`: GitHub supplies no uniqueness
   * constraint on pull-request creation, so two processes that both read before either has
   * written can both create. That race is narrowed, not eliminated, and the contract's
   * `OutcomeUnknown` is what makes it recoverable (F30-AC2, F30-AC5).
   */
  async upsertDraft(
    context: AdapterContext,
    request: UpsertDraftRequest,
  ): Promise<Result<UpsertDraftOutcome>> {
    const foreign = refuseForeignRepository(request.repository, context.redact);
    if (foreign !== null) return err(foreign);
    const names = parseRepositoryName(request.repository.fullName);
    if (!names.ok) return names;
    const head = requireFullSha(request.headSha, 'headSha');
    if (!head.ok) return head;
    const base = requireRefName(request.baseBranch, 'baseBranch');
    if (!base.ok) return base;
    const target = await managedTarget(
      request.body,
      'A GitHub draft owns a delimited region of its own body, which this adapter writes in place. An append-only comment thread was refused because appending on every delivery would duplicate the managed text (F16-AC3).',
    );
    if (!target.ok) return target;
    void target;

    const supplied = request.existingDraft;
    if (supplied !== null) {
      return this.updateDraft(context, names.value, request, supplied);
    }

    const reconciled = await this.reconcile(context, names.value, request);
    if (!reconciled.ok) return reconciled;
    const adopted = reconciled.value;
    if (adopted !== null) {
      return this.updateDraft(context, names.value, request, adopted, true);
    }

    const headRef = requireRefName(await this.branchOfSha(context, names.value, request.headSha), 'headSha.branch');
    if (!headRef.ok) return headRef;

    const digest = contentDigest(request.body);
    const marker = managedMarkerLine({
      operationId: request.operationId,
      headSha: request.headSha,
      baseBranch: request.baseBranch,
      link: linkKeyOf(request.link),
      digest,
      writtenAt: context.clock.now(),
    });
    const written: DraftBody = { ...request.body, managedMarker: marker };
    const rendered = draftBody(written, null);

    const created = await this.client.execute(context, {
      operationName: 'GitHubPullRequestCreate',
      method: 'POST',
      path: `/repos/${names.value.owner}/${names.value.repo}/pulls`,
      body: {
        title: request.title,
        head: headRef.value,
        base: request.baseBranch,
        body: rendered,
        draft: true,
        maintainer_can_modify: false,
      },
      mutating: true,
      target: `${request.repository.fullName}#${request.body.managedMarker.slice(0, 64)}`,
    });
    if (!created.ok) return created;
    const pull = readPullRequest(created.value.data);
    if (pull === null) {
      return err({
        code: 'OutcomeUnknown',
        reason: context.redact(
          `GitHub accepted the draft creation but returned a payload this adapter cannot read, so the pull request identity is unknown. Read the open pull requests for this branch instead of creating another (F19-AC3).`,
        ),
        operationId: context.operationId,
        target: `${request.repository.fullName}:head/${headRef.value}`,
      });
    }
    return ok({ kind: 'Created', draft: this.draftRefOf(pull, request.link) });
  }

  /**
   * The draft to write to: the one the caller reconciled, or one this adapter found itself.
   *
   * The read-back is unconditional. The caller-supplied `existingDraft` may name a pull
   * request whose body has since been edited, and writing without reading would discard
   * whatever a human changed. When the reconciliation came from this adapter's own read,
   * the outcome is `RecoveredAfterLostResponse` so the owner can see the write was recovered
   * rather than performed.
   */
  private async updateDraft(
    context: AdapterContext,
    names: RepositoryNames,
    request: UpsertDraftRequest,
    existing: DraftRef,
    recovered = false,
  ): Promise<Result<UpsertDraftOutcome>> {
    const current = await this.client.execute(context, {
      operationName: 'GitHubPullRequestRead',
      method: 'GET',
      path: `/repos/${names.owner}/${names.repo}/pulls/${numberOf(existing)}`,
    });
    if (!current.ok) return current;
    const pull = readPullRequest(current.value.data);
    if (pull === null) {
      return err({
        code: 'Unavailable',
        reason: context.redact(
          `GitHub returned a payload this adapter cannot read for pull request ${numberOf(existing)}, so the current body is unknown and rewriting it could discard a human's text. Nothing was written.`,
        ),
      });
    }

    const digest = contentDigest(request.body);
    const marker = managedMarkerLine({
      operationId: request.operationId,
      headSha: request.headSha,
      baseBranch: request.baseBranch,
      link: linkKeyOf(request.link),
      digest,
      writtenAt: context.clock.now(),
    });
    const written: DraftBody = { ...request.body, managedMarker: marker };
    const rendered = draftBody(written, pull.body);
    const changed = changedSectionsOf(pull.body, rendered);

    if (changed.length === 0) {
      const unchanged = this.draftRefOf(pull, request.link);
      if (!recovered) return ok({ kind: 'Unchanged', draft: unchanged });
      return ok({
        kind: 'RecoveredAfterLostResponse',
        draft: unchanged,
        detail: `The draft this operation created (${unchanged.pullRequest.pullRequestId}) was found by reading the open pull requests for this branch, and its managed content already matches, so nothing was written and no second draft was created (F19-AC3).`,
      });
    }

    const updated = await this.client.execute(context, {
      operationName: 'GitHubPullRequestUpdate',
      method: 'PATCH',
      path: `/repos/${names.owner}/${names.repo}/pulls/${pull.number}`,
      body: { body: rendered },
      mutating: true,
      target: `${request.repository.fullName}#${pull.number}`,
    });
    if (!updated.ok) return updated;

    const observed = readPullRequest(updated.value.data) ?? pull;
    const draft = this.draftRefOf(observed, request.link);
    if (!recovered) return ok({ kind: 'Updated', draft, changedSections: changed });
    return ok({
      kind: 'RecoveredAfterLostResponse',
      draft,
      detail: `The draft this operation created (${draft.pullRequest.pullRequestId}) was found by reading the open pull requests for this branch, so the retry updated that draft instead of creating a second one. Sections changed: ${changed.join(', ')} (F19-AC1, F19-AC3).`,
    });
  }

  /**
   * The reconciliation read that precedes any create.
   *
   * Returns the draft this operation already owns, if any. A draft matches when its body
   * carries this operation's managed marker — which is how a lost create is found — or when
   * it is on the same head and carries the same link, which is how a draft created before a
   * restart under a new operation identity is still adopted rather than duplicated.
   */
  private async reconcile(
    context: AdapterContext,
    names: RepositoryNames,
    request: UpsertDraftRequest,
  ): Promise<Result<DraftRef | null>> {
    const found = await this.managedPullRequests(context, names, request.repository);
    if (!found.ok) return found;
    const byMarker = found.value.find((pull) => {
      const marker = parseManagedMarker(pull.body ?? '');
      return marker !== null && marker.operationId === request.operationId;
    });
    const target = byMarker ?? found.value.find((pull) => pull.headSha === request.headSha && linksMatch(linkOf(pull), request.link));
    return ok(target === undefined ? null : this.draftRefOf(target, request.link));
  }

  /**
   * F19-AC5: a read-only job completes with a stated no-code outcome and no draft.
   *
   * Nothing is written. The only provider call reads whether the branch exists, because
   * "never pushed" and "pushed without a draft" are different facts and reporting the wrong
   * one would tell the owner a change exists when none does (F19-AC5, F29-AC5). The record's
   * `pullRequest` is pinned to `null` by the contract, so opening an empty change to have
   * something to link is not expressible here.
   */
  async declareNoCodeOutcome(
    context: AdapterContext,
    request: DeclareNoCodeOutcomeRequest,
  ): Promise<Result<NoCodeOutcomeRecord>> {
    const foreign = refuseForeignRepository(request.repository, context.redact);
    if (foreign !== null) return err(foreign);
    const names = parseRepositoryName(request.repository.fullName);
    if (!names.ok) return names;
    const branch = requireRefName(request.branch, 'branch');
    if (!branch.ok) return branch;

    const remote = await this.remoteRefRead(context, names.value, branch.value);
    if (!remote.ok) return remote;
    const record: NoCodeOutcomeRecord = {
      reason: request.reason,
      branchState: remote.value === null ? 'NeverPushed' : 'PushedWithoutDraft',
      pullRequest: null,
      evidence: request.evidence,
      declaredAt: request.declaredAt,
    };
    return ok(record);
  }

  /**
   * F26-AC3: merges with the provider's own head precondition, and verifies the result.
   *
   * GitHub's merge endpoint compares `sha` against the pull request head itself, so a
   * precondition failure is the provider refusing a stale decision rather than a check this
   * adapter performs afterwards. The endpoint's own contract is `Conflict if sha was
   * provided and pull request head did not match`, which arrives as HTTP 409 and is mapped
   * to `Conflict` rather than swallowed (F26-AC3).
   *
   * A caller that declines the provider precondition is refused, because GitHub does offer
   * one and the contract requires using it where it exists. Accepting `NoProviderPrecondition`
   * here would mean performing a merge with a weaker guarantee than the provider is willing
   * to give, which is the opposite of what F26-AC3 asks for.
   *
   * A lost merge response is `OutcomeUnknown` and is distinguishable from a failed merge: a
   * failure is `Conflict`, `Blocked` or `NotFound` with a provider reason, while an unknown
   * outcome retains the operation identity and names the pull request to read. The read at
   * the top of this method is that reconciliation, and an already-merged pull request is
   * reported `AlreadyMerged` rather than merged again (F28-AC4, F30-AC5).
   */
  async mergePullRequest(
    context: AdapterContext,
    request: MergePullRequestRequest,
  ): Promise<Result<MergeOutcome>> {
    const foreign = refuseForeignRepository(request.repository, context.redact);
    if (foreign !== null) return err(foreign);
    const names = parseRepositoryName(request.repository.fullName);
    if (!names.ok) return names;
    const authorized = requireFullSha(request.expectedHeadSha, 'expectedHeadSha');
    if (!authorized.ok) return authorized;
    const target = requireRefName(request.targetBranch, 'targetBranch');
    if (!target.ok) return target;

    const precondition = this.preconditionFor(request.precondition, context.redact);
    if (!precondition.ok) return precondition;

    const pull = await this.pullRequestRead(context, names.value, request.pullRequestId);
    if (!pull.ok) return pull;
    const current = pull.value;

    if (current.merged) {
      return ok(this.alreadyMergedOf(current, context.clock.now()));
    }
    if (current.draft) {
      return err(
        blocked(`${request.repository.fullName}#${current.number} is still a draft.`, [
          {
            name: 'DraftPullRequest',
            detail: `GitHub reports pull request ${current.number} with draft: true, and a draft cannot be merged.`,
            remedy:
              'Mark the pull request ready for review on GitHub, or on the owner\'s behalf in ShipLoop, then retry the authorized merge. Nothing was merged.',
          },
        ]),
      );
    }

    const merged = await this.client.execute(context, {
      operationName: 'GitHubPullRequestMerge',
      method: 'PUT',
      path: `/repos/${names.value.owner}/${names.value.repo}/pulls/${current.number}/merge`,
      body: { sha: precondition.value, merge_method: mergeMethod(request.method) },
      mutating: true,
      target: `${request.repository.fullName}#${current.number}`,
    });
    if (!merged.ok) return merged;
    const reported = field(merged.value.data, 'merged');
    if (reported === false) {
      return err({
        code: 'Conflict',
        reason: context.redact(
          `GitHub answered the merge request without merging: ${String(field(merged.value.data, 'message') ?? 'no reason given')}. Nothing was merged; read the pull request before any retry.`,
        ),
        expected: precondition.value,
        actual: current.headSha,
      });
    }

    const settled = await this.pullRequestRead(context, names.value, request.pullRequestId);
    if (!settled.ok) {
      return err({
        code: 'OutcomeUnknown',
        reason: context.redact(
          `GitHub accepted the merge of pull request ${current.number} but the result could not be read back, so the merge commit is unconfirmed. Read pull request ${current.number} before any retry.`,
        ),
        operationId: context.operationId,
        target: `${request.repository.fullName}#${current.number}`,
      });
    }
    const after = settled.value;
    const mergeCommit = after.mergeCommitSha;
    if (!after.merged || mergeCommit === null || !isCommitSha(mergeCommit)) {
      return err({
        code: 'OutcomeUnknown',
        reason: context.redact(
          `GitHub accepted the merge of pull request ${current.number}, but reading it back reports merged=${String(after.merged)} and merge commit ${(mergeCommit ?? 'none').slice(0, 12)}. The merge's outcome is unknown, so read the pull request before any retry (F26-AC3).`,
        ),
        operationId: context.operationId,
        target: `${request.repository.fullName}#${current.number}`,
      });
    }

    const mergedHead = current.headSha;
    return ok({
      kind: 'Merged',
      mergeCommitSha: mergeCommit,
      headSha: mergedHead,
      targetBranch: request.targetBranch,
      mergedAt: after.mergedAt ?? context.clock.now(),
      contentRelation: contentRelationOf(mergeCommit, mergedHead, authorized.value),
    });
  }

  /**
   * The SHA the merge must pin.
   *
   * `ProviderExpectedHead` is GitHub's own compare-and-set and is passed through
   * unchanged. `NoProviderPrecondition` is refused: the provider offers the precondition, so
   * choosing the weaker contract variant would deliver less than the provider is prepared to
   * guarantee, and F26-AC3 requires the provider's own precondition where one exists.
   */
  private preconditionFor(
    precondition: MergePrecondition,
    redact: (text: string) => string,
  ): Result<string> {
    if (precondition.kind === 'ProviderExpectedHead') {
      const pinned: string = precondition.expectedHeadSha;
      if (!isCommitSha(pinned)) {
        return err(
          invalid(`A provider head precondition must name a full commit SHA.`, [
            {
              path: 'precondition.expectedHeadSha',
              message: `"${pinned.slice(0, 12)}" is not a full commit SHA. GitHub compares this value against the pull request head, so an abbreviation would pin nothing.`,
            },
          ]),
        );
      }
      return ok(pinned);
    }
    return err({
      code: 'Unavailable',
      reason: redact(
        `This merge was requested without a provider head precondition. GitHub's merge endpoint accepts a pinned head SHA and refuses the merge when it does not match, so the precondition is available and this adapter will not proceed without it (F26-AC3). Ask for a ProviderExpectedHead precondition. Nothing was merged.`,
      ),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Provider reads                                                       */
  /* ------------------------------------------------------------------ */

  private async repositoryRead(
    context: AdapterContext,
    repository: GitRepositoryRef,
  ): Promise<Result<RepositoryShape>> {
    const names = parseRepositoryName(repository.fullName);
    if (!names.ok) return names;
    const read = await this.client.execute(context, {
      operationName: 'GitHubRepositoryRead',
      method: 'GET',
      path: `/repos/${names.value.owner}/${names.value.repo}`,
    });
    if (!read.ok) return read;
    if (read.value.runtimeVersion !== null) {
      this.observedApiVersion = read.value.runtimeVersion;
    }
    const shape = readRepository(read.value.data);
    if (shape === null) {
      return err({
        code: 'Unavailable',
        reason:
          'GitHub answered the repository read with a payload this adapter cannot read, so the repository identity is unproven rather than assumed.',
      });
    }
    return ok(shape);
  }

  /**
   * One ref read, as a domain ref state.
   *
   * A branch that does not exist is `Missing` with the reason, not a failure: the owner
   * needs to see that the branch has not been pushed yet, which is a different fact from
   * the provider being unavailable.
   */
  private async refRead(
    context: AdapterContext,
    names: RepositoryNames,
    branch: string,
    repository: GitRepositoryRef,
  ): Promise<Result<GitRefState>> {
    const read = await this.client.execute(context, {
      operationName: 'GitHubRefRead',
      method: 'GET',
      path: `/repos/${names.owner}/${names.repo}/git/ref/heads/${encodeRef(branch)}`,
    });
    if (!read.ok) {
      if (read.error.code === 'NotFound') {
        return ok({
          kind: 'Missing',
          name: branch,
          detail: context.redact(
            `GitHub has no branch "${branch}" in ${repository.fullName}. It has not been pushed, or it was deleted.`,
          ),
        });
      }
      return read;
    }
    const shape = readRef(read.value.data);
    const sha = shape?.sha ?? null;
    if (sha === null || !isCommitSha(sha)) {
      return err({
        code: 'Unavailable',
        reason: context.redact(
          `GitHub reported refs/heads/${branch} with ${(sha ?? 'no').slice(0, 12)}, which is not a full commit SHA. Refusing to continue, because an abbreviation is not the revision the caller asked about.`,
        ),
      });
    }
    return ok({ kind: 'Branch', name: branch, sha });
  }

  /** The remote's current ref, or null when the branch does not exist there. */
  private async remoteRefRead(
    context: AdapterContext,
    names: RepositoryNames,
    branch: string,
  ): Promise<Result<string | null>> {
    const read = await this.client.execute(context, {
      operationName: 'GitHubRefRead',
      method: 'GET',
      path: `/repos/${names.owner}/${names.repo}/git/ref/heads/${encodeRef(branch)}`,
    });
    if (!read.ok) {
      if (read.error.code === 'NotFound') return ok(null);
      return read;
    }
    const sha = readRef(read.value.data)?.sha ?? null;
    if (sha === null || !isCommitSha(sha)) {
      return err({
        code: 'Unavailable',
        reason: context.redact(
          `GitHub reported refs/heads/${branch} with ${(sha ?? 'no').slice(0, 12)}, which is not a full commit SHA. A force-with-lease push cannot be pinned to it, so nothing was pushed.`,
        ),
      });
    }
    return ok(sha);
  }

  /**
   * Confirms the configured remote is the configured repository.
   *
   * `git push origin` publishes to whatever `origin` points at. Checking the URL first turns
   * a misconfigured remote into a refusal naming both repositories, rather than a successful
   * push of reviewed code somewhere the owner never looked.
   */
  private async remoteGuard(
    context: AdapterContext,
    repository: GitRepositoryRef,
  ): Promise<Result<true>> {
    const read = await this.repositoryRead(context, repository);
    if (!read.ok) return read;
    const remote = await this.git.run(context, ['remote', 'get-url', this.remoteName]);
    if (!remote.ok) return remote;
    if (remote.value.exitCode !== 0) {
      return err(
        blocked(`The workspace at ${this.git.workingDirectory} has no usable "${this.remoteName}" remote.`, [
          {
            name: 'GitRemoteAbsent',
            detail: `git remote get-url ${this.remoteName} exited ${remote.value.exitCode}: ${context.redact(remote.value.stderr.trim().slice(0, 200))}`,
            remedy: `Add the remote in the workspace, or configure the connector's remote name. Nothing was pushed.`,
          },
        ]),
      );
    }
    const url = remote.value.stdout.trim();
    const expected = [read.value.sshUrl, read.value.cloneUrl, read.value.htmlUrl].filter(
      (candidate): candidate is string => candidate !== null,
    );
    const matches = expected.some((candidate) => normaliseRemoteUrl(candidate) === normaliseRemoteUrl(url));
    if (!matches) {
      return err(
        blocked(`The workspace remote "${this.remoteName}" does not point at ${read.value.fullName}.`, [
          {
            name: 'GitRemoteMismatch',
            detail: `git remote get-url ${this.remoteName} reported "${url.slice(0, 160)}" while the configured repository is ${read.value.fullName} at ${read.value.sshUrl ?? read.value.cloneUrl ?? read.value.htmlUrl}.`,
            remedy:
              'Point the workspace remote at the configured repository, or configure the repository this connector publishes to. Nothing was pushed.',
          },
        ]),
      );
    }
    return ok(true);
  }

  /** The newest open draft for a branch, or null when the branch has none. */
  private async latestPullRequest(
    context: AdapterContext,
    names: RepositoryNames,
    branch: string,
  ): Promise<Result<PullRequestShape | null>> {
    const listed = await this.pullRequestList(context, names, { state: 'open', head: `${names.owner}:${branch}` });
    if (!listed.ok) return listed;
    return ok(listed.value.at(-1) ?? null);
  }

  /**
   * Every open pull request that carries a ShipLoop managed marker.
   *
   * A pull request with no marker is not a ShipLoop draft and is not reported, because
   * `findDrafts` answers "what did this operation write?" and an unrelated human pull request
   * is not part of that answer. The pages read are bounded, and a repository with more open
   * pull requests than the bound reports `Unavailable` rather than silently searching only a
   * prefix and reporting it as complete.
   */
  private async managedPullRequests(
    context: AdapterContext,
    names: RepositoryNames,
    repository: GitRepositoryRef,
  ): Promise<Result<readonly PullRequestShape[]>> {
    const listed = await this.pullRequestList(context, names, { state: 'open' });
    if (!listed.ok) return listed;
    const managed = listed.value.filter((pull) => parseManagedMarker(pull.body ?? '') !== null);
    const saturated = listed.value.length >= this.maxPullRequestPages * MAX_PULL_REQUESTS;
    if (saturated && managed.length === 0) {
      return err({
        code: 'Unavailable',
        reason: context.redact(
          `${repository.fullName} has at least ${listed.value.length} open pull requests and none of the ${this.maxPullRequestPages} pages read carried a ShipLoop marker. Reporting none found would be a guess, so this is reported instead. No pull request was created or changed.`,
        ),
      });
    }
    return ok(managed);
  }

  private async pullRequestList(
    context: AdapterContext,
    names: RepositoryNames,
    filter: Readonly<Record<string, string>>,
  ): Promise<Result<readonly PullRequestShape[]>> {
    const collected: PullRequestShape[] = [];
    for (let page = 1; page <= this.maxPullRequestPages; page += 1) {
      const read: GitHubRequest = {
        operationName: 'GitHubPullRequestList',
        method: 'GET',
        path: `/repos/${names.owner}/${names.repo}/pulls`,
        query: { per_page: MAX_PULL_REQUESTS, page, ...filter },
      };
      const listed = await this.client.execute(context, read);
      if (!listed.ok) return listed;
      const page_items = arrayOf(listed.value.data).map(readPullRequest).filter((pull): pull is PullRequestShape => pull !== null);
      collected.push(...page_items);
      if (page_items.length < MAX_PULL_REQUESTS) break;
    }
    return ok(collected);
  }

  private async pullRequestRead(
    context: AdapterContext,
    names: RepositoryNames,
    pullRequestId: ProviderId,
  ): Promise<Result<PullRequestShape>> {
    const read = await this.client.execute(context, {
      operationName: 'GitHubPullRequestRead',
      method: 'GET',
      path: `/repos/${names.owner}/${names.repo}/pulls/${encodeRef(pullRequestId)}`,
    });
    if (!read.ok) return read;
    const shape = readPullRequest(read.value.data);
    if (shape === null) {
      return err({
        code: 'Unavailable',
        reason: context.redact(
          `GitHub returned a payload this adapter cannot read for pull request ${pullRequestId.slice(0, 24)}, so its current state is unknown and no delivery action was taken.`,
        ),
      });
    }
    return ok(shape);
  }

  /** Every check run and commit status GitHub reports for one commit. */
  private async observedChecks(
    context: AdapterContext,
    names: RepositoryNames,
    sha: CommitSha,
  ): Promise<Result<readonly CheckObservation[]>> {
    const runs = await this.client.execute(context, {
      operationName: 'GitHubCheckRunsRead',
      method: 'GET',
      path: `/repos/${names.owner}/${names.repo}/commits/${sha}/check-runs`,
      query: { per_page: MAX_CHECK_RUNS },
    });
    if (!runs.ok) return runs;
    const statuses = await this.client.execute(context, {
      operationName: 'GitHubCommitStatusesRead',
      method: 'GET',
      path: `/repos/${names.owner}/${names.repo}/commits/${sha}/status`,
      query: { per_page: MAX_CHECK_RUNS },
    });
    if (!statuses.ok) return statuses;

    const observed: CheckObservation[] = [];
    for (const run of arrayOf(field(runs.value.data, 'check_runs')).map(readCheckRun)) {
      if (run === null) continue;
      observed.push({
        kind: 'CheckRun',
        id: String(run.id),
        name: run.name,
        headSha: run.headSha,
        result: mapCheckConclusion({ status: run.status, conclusion: run.conclusion }),
        startedAt: run.startedAt,
        endedAt: run.completedAt,
        artifactUrl: run.detailsUrl,
        detail: detailOfCheck(run.title, run.summary, run.status, run.conclusion),
      });
    }
    for (const status of arrayOf(field(statuses.value.data, 'statuses')).map(readCommitStatus)) {
      if (status === null) continue;
      observed.push({
        kind: 'CommitStatus',
        id: String(status.id),
        name: status.context,
        headSha: sha,
        result: mapCommitStatusState(status.state),
        startedAt: status.updatedAt,
        endedAt: status.updatedAt,
        artifactUrl: status.targetUrl,
        detail: detailOfStatus(status.state, status.description),
      });
    }
    return ok(observed);
  }

  private async reviewsRead(
    context: AdapterContext,
    names: RepositoryNames,
    pull: PullRequestShape,
  ): Promise<Result<{ readonly states: readonly GitReviewState[]; readonly shapes: readonly ReviewShape[] }>> {
    const read = await this.client.execute(context, {
      operationName: 'GitHubPullRequestReviewsRead',
      method: 'GET',
      path: `/repos/${names.owner}/${names.repo}/pulls/${pull.number}/reviews`,
      query: { per_page: MAX_REVIEWS },
    });
    if (!read.ok) return read;
    const shapes = arrayOf(read.value.data)
      .map(readReview)
      .filter((review): review is ReviewShape => review !== null);
    // Both views are returned: the states are the contract, the shapes carry the `commit_id` the
    // approval tally needs, which the contract has nowhere to put.
    return ok({ states: shapes.map(mapReview), shapes });
  }

  /**
   * The provider's requirements on the branch a merge would land on.
   *
   * `sources` is kept so a report can say *where* each requirement came from: a count read off
   * branch protection and a count read off a ruleset are different obligations, and folding them
   * into one number without saying so would let an owner lower one and believe the other moved.
   */
  private async mergePolicy(
    context: AdapterContext,
    names: RepositoryNames,
    target: string,
    defaultBranch: string,
  ): Promise<Result<MergePolicy>> {
    const protection = await this.branchProtection(context, names, target);
    if (!protection.ok) return protection;

    const rulesets = await this.applicableRulesets(context, names, target, defaultBranch);
    if (!rulesets.ok) return rulesets;

    const approvalSources: string[] = [];
    const requiredChecks: string[] = [];
    const bypassActors: string[] = [];
    const dismissalRestrictions: string[] = [];
    const dismissesStaleReviews: string[] = [];
    const requireCodeOwnerReviews: string[] = [];
    const requireLastPushApproval: string[] = [];
    let requiredApprovals = 0;
    const raiseApprovals = (count: number, source: string): void => {
      if (count <= 0) return;
      approvalSources.push(`${source} requires ${count}`);
      requiredApprovals = Math.max(requiredApprovals, count);
    };

    if (protection.value.present) {
      const reviews = protection.value.reviews;
      raiseApprovals(reviews.requiredApprovals, `branch protection on ${target}`);
      requiredChecks.push(...reviews.statusChecks);
      dismissalRestrictions.push(...reviews.dismissalRestrictions);
      if (reviews.dismissStaleReviews) dismissesStaleReviews.push(`branch protection on ${target}`);
      if (reviews.requireCodeOwnerReviews) requireCodeOwnerReviews.push(`branch protection on ${target}`);
      if (reviews.requireLastPushApproval) requireLastPushApproval.push(`branch protection on ${target}`);
    }
    for (const ruleset of rulesets.value.applicable) {
      raiseApprovals(ruleset.requiredApprovals, `ruleset "${ruleset.name}"`);
      requiredChecks.push(...ruleset.statusChecks);
      bypassActors.push(...ruleset.bypassActors);
      if (ruleset.dismissStaleReviews) dismissesStaleReviews.push(`ruleset "${ruleset.name}"`);
      if (ruleset.requireCodeOwnerReviews) requireCodeOwnerReviews.push(`ruleset "${ruleset.name}"`);
      if (ruleset.requireLastPushApproval) requireLastPushApproval.push(`ruleset "${ruleset.name}"`);
    }
    return ok({
      requiredApprovals,
      approvalSources,
      requiredChecks: [...new Set(requiredChecks)].sort(),
      bypassActors,
      dismissalRestrictions,
      dismissesStaleReviews,
      requireCodeOwnerReviews,
      requireLastPushApproval,
      sources: [...protection.value.sources, ...rulesets.value.sources],
    });
  }

  /**
   * The full protection object for one branch.
   *
   * `required_pull_request_reviews` alone is not enough: F26-AC5 asks for the provider's *actual*
   * approval requirement, and the count is only half of it — `dismiss_stale_reviews`,
   * `require_code_owner_reviews`, `require_last_push_approval`, the dismissal restrictions and
   * the required status-check contexts all change what "approved" means. A `404` is the provider
   * stating the branch is unprotected, which is the one answer that may be read as absence;
   * anything else is the policy being unreadable, and it is returned rather than swallowed.
   */
  private async branchProtection(
    context: AdapterContext,
    names: RepositoryNames,
    target: string,
  ): Promise<Result<{ readonly present: boolean; readonly reviews: BranchProtectionReviewRules; readonly sources: readonly string[] }>> {
    const read = await this.client.execute(context, {
      operationName: 'GitHubBranchProtectionRead',
      method: 'GET',
      path: `/repos/${names.owner}/${names.repo}/branches/${encodeRef(target)}/protection`,
    });
    if (!read.ok) {
      if (read.error.code === 'NotFound') {
        return ok({ present: false, reviews: emptyReviewRules(), sources: [] });
      }
      return err(unreadablePolicy(context, read.error, target, 'branch protection'));
    }
    const reviews = field(read.value.data, 'required_pull_request_reviews');
    return ok({
      present: true,
      reviews: {
        requiredApprovals: intOrNull(field(reviews, 'required_approving_review_count')) ?? 0,
        dismissStaleReviews: boolOrNull(field(reviews, 'dismiss_stale_reviews')) ?? false,
        requireCodeOwnerReviews: boolOrNull(field(reviews, 'require_code_owner_reviews')) ?? false,
        requireLastPushApproval: boolOrNull(field(reviews, 'require_last_push_approval')) ?? false,
        dismissalRestrictions: actorNames(field(reviews, 'dismissal_restrictions')),
        statusChecks: requiredCheckContexts(field(read.value.data, 'required_status_checks')),
      },
      sources: [`branch protection on ${target}`],
    });
  }

  /**
   * The repository's rulesets that are enforced on this branch right now.
   *
   * `includes_parents=true` is asked for explicitly: an organisation-level ruleset is a real
   * requirement on a merge and it is invisible to the repository-scoped listing. A ruleset that is
   * `disabled` or `evaluate`, or whose `target` is a tag rather than a branch, or whose
   * `ref_name` does not include the target, is not folded in — a ruleset that does not apply is
   * not a requirement.
   */
  private async applicableRulesets(
    context: AdapterContext,
    names: RepositoryNames,
    target: string,
    defaultBranch: string,
  ): Promise<Result<{ readonly applicable: readonly ApplicableRuleset[]; readonly sources: readonly string[] }>> {
    const read = await this.client.execute(context, {
      operationName: 'GitHubRulesetRead',
      method: 'GET',
      path: `/repos/${names.owner}/${names.repo}/rulesets`,
      query: { includes_parents: 'true', per_page: MAX_RULESETS },
    });
    if (!read.ok) {
      // A repository with no rulesets answers 200 `[]`. Anything else means the listing could not
      // be read, and an unread listing is not an empty one.
      if (read.error.code === 'NotFound') return ok({ applicable: [], sources: [] });
      return err(unreadablePolicy(context, read.error, target, 'repository rulesets'));
    }

    const applicable: ApplicableRuleset[] = [];
    const sources: string[] = [];
    for (const entry of arrayOf(read.value.data)) {
      if (str(field(entry, 'target')) !== 'branch') continue;
      if (str(field(entry, 'enforcement')) !== 'active') continue;
      const name = str(field(entry, 'name')) ?? 'unnamed ruleset';
      if (!rulesetCoversRef(entry, target, defaultBranch)) continue;

      let requiredApprovals = 0;
      const statusChecks: string[] = [];
      let dismissStaleReviews = false;
      let requireCodeOwnerReviews = false;
      let requireLastPushApproval = false;
      for (const rule of arrayOf(field(entry, 'rules'))) {
        const parameters = field(rule, 'parameters');
        switch (str(field(rule, 'type'))) {
          case 'pull_request':
            requiredApprovals = Math.max(requiredApprovals, intOrNull(field(parameters, 'required_approving_review_count')) ?? 0);
            dismissStaleReviews = dismissStaleReviews || (boolOrNull(field(parameters, 'dismiss_stale_reviews_on_push')) ?? false);
            requireCodeOwnerReviews = requireCodeOwnerReviews || (boolOrNull(field(parameters, 'require_code_owner_review')) ?? false);
            requireLastPushApproval = requireLastPushApproval || (boolOrNull(field(parameters, 'require_last_push_approval')) ?? false);
            break;
          case 'required_status_checks':
            for (const required of arrayOf(field(parameters, 'required_status_checks'))) {
              const context = str(field(required, 'context'));
              if (context !== null) statusChecks.push(context);
            }
            break;
          default:
            break;
        }
      }

      applicable.push({
        name,
        requiredApprovals,
        statusChecks,
        dismissStaleReviews,
        requireCodeOwnerReviews,
        requireLastPushApproval,
        bypassActors: bypassActorNames(field(entry, 'bypass_actors')),
      });
      sources.push(`ruleset "${name}"`);
    }
    return ok({ applicable, sources });
  }

  /**
   * Folds the provider's policy on the merge target into the review state.
   *
   * A review that has not been submitted is not an approval, and saying so is the whole point:
   * GitHub reports a pending review in the same list as a submitted one. What this no longer does
   * is treat an unreadable policy as an absent one — a 403 on protection needs administration this
   * credential may not hold, and it is `Blocked` rather than a branch reported as unprotected
   * (F26-AC5).
   */
  private async approvalRules(
    context: AdapterContext,
    names: RepositoryNames,
    target: string,
    defaultBranch: string,
    reviews: readonly GitReviewState[],
    shapes: readonly ReviewShape[],
    headSha: string | null,
  ): Promise<Result<readonly GitReviewState[]>> {
    const policy = await this.mergePolicy(context, names, target, defaultBranch);
    if (!policy.ok) return policy;
    const effective = policy.value;
    const rules: GitReviewState[] = [];

    if (effective.requiredApprovals > 0) {
      const tally = countCurrentApprovals(shapes, headSha);
      if (tally.counted.length < effective.requiredApprovals) {
        rules.push({
          kind: 'ApprovalRulePending',
          rule: 'required_approving_review_count',
          detail: approvalRuleDetail(target, effective, tally),
        });
      }
    }

    // The provider's required status-check contexts are reported rather than enforced here: this
    // read does not evaluate checks, and a rule the adapter cannot evaluate must not be invented
    // into a pending one that would block every merge.
    if (effective.requiredChecks.length > 0) {
      rules.push({
        kind: 'Unknown',
        detail: `The provider requires status check(s) ${effective.requiredChecks.join(', ')} on ${target} (from ${effective.sources.join('; ')}). This read reports live refs, reviews and policy only; readChecks is what evaluates those contexts, so their state here is not known (F26-AC5).`,
      });
    }

    // A ruleset can name who merges without satisfying its rules at all. That is a bypass, so it
    // is stated wherever the rules are reported rather than left for an owner to discover.
    if (effective.bypassActors.length > 0 && rules.length > 0) {
      rules.push({
        kind: 'Unknown',
        detail: `${effective.bypassActors.join('; ')} may merge to ${target} without satisfying these rules. A bypass is the provider's own escape hatch, so any authorization ShipLoop issues is worthless against it (F26-AC5).`,
      });
    }
    return ok([...reviews, ...rules]);
  }

  /**
   * The branch that currently holds a commit.
   *
   * GitHub's create-pull-request endpoint takes a branch, not a SHA, and the contract's
   * `upsertDraft` names only the head commit. The commit-to-branches endpoint resolves it.
   * A commit that is no longer any branch's head has no branch to open a draft from, which is
   * reported rather than guessed.
   */
  private async branchOfSha(
    context: AdapterContext,
    names: RepositoryNames,
    sha: string,
  ): Promise<string> {
    const read = await this.client.execute(context, {
      operationName: 'GitHubCommitBranchesRead',
      method: 'GET',
      path: `/repos/${names.owner}/${names.repo}/commits/${sha}/branches-where-head`,
      query: { per_page: MAX_PULL_REQUESTS },
    });
    if (!read.ok) return '';
    for (const entry of arrayOf(read.value.data)) {
      const name = str(field(field(entry, 'commit'), 'ref')) ?? str(field(field(entry, 'branch'), 'name'));
      if (name !== null) return name;
      const ref = str(field(field(entry, 'name'), 'ref')) ?? str(field(entry, 'name'));
      if (ref !== null) return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
    return '';
  }

  /* ------------------------------------------------------------------ */
  /* Shape mapping                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * A `DraftRef` from what GitHub actually holds.
   *
   * The head is read from the pull request's own `head.sha` rather than copied from the
   * request, so a draft whose head advanced is reported at the head the provider holds — the
   * fact F24-AC4 needs to invalidate an outdated card. A head that is not a full SHA cannot
   * be represented, so it becomes the null ref state rather than a fabricated `CommitSha`.
   *
   * The marker is the raw line, not a re-derived one: reconciliation must key on what the
   * provider carries, and re-rendering it here would make a lost write look like a
   * different operation than the one that made it.
   */
  private draftRefOf(pull: PullRequestShape, link: DraftLinkTarget): DraftRef {
    const body = pull.body ?? '';
    const marker = parseManagedMarker(body);
    return {
      pullRequest: pullRequestRefOf(pull),
      headSha: pull.headSha,
      baseBranch: pull.baseRef,
      link: linksMatch(linkOf(pull), link) ? link : linkOf(pull),
      managedMarker: markerLineOf(body),
      bodyDigest: marker?.digest ?? '',
    };
  }

  private alreadyMergedOf(pull: PullRequestShape, observedAt: string): MergeOutcome {
    const mergeCommit = pull.mergeCommitSha;
    if (mergeCommit === null || !isCommitSha(mergeCommit)) {
      return { kind: 'AlreadyMerged', mergeCommitSha: '' as CommitSha, mergedAt: pull.mergedAt ?? observedAt };
    }
    return { kind: 'AlreadyMerged', mergeCommitSha: mergeCommit, mergedAt: pull.mergedAt ?? observedAt };
  }
}

/* -------------------------------------------------------------------------- */
/* Module helpers                                                              */
/* -------------------------------------------------------------------------- */

/** One observed check, whichever of GitHub's two mechanisms reported it. */
interface CheckObservation {
  readonly kind: 'CheckRun' | 'CommitStatus';
  readonly id: string;
  readonly name: string;
  readonly headSha: string;
  readonly result: CheckResult;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly artifactUrl: string | null;
  readonly detail: string;
}

function toObservation(
  check: CheckObservation,
  headSha: CommitSha,
  requirement: ProviderCheckObservation['requirement'],
  redact: (text: string) => string,
): ProviderCheckObservation {
  const isStale = check.headSha !== headSha;
  return {
    checkId: check.id,
    name: check.name,
    result: isStale ? 'Stale' : check.result,
    requirement,
    startedAt: check.startedAt,
    endedAt: check.endedAt,
    exitCode: null,
    detail: redact(isStale ? `${check.detail} It was reported against ${check.headSha.slice(0, 12)} rather than this candidate head, so it cannot approve this candidate (F20-AC3).` : check.detail),
    artifactUrl: check.artifactUrl,
  };
}

function detailOfCheck(
  title: string | null,
  summary: string | null,
  status: string,
  conclusion: string | null,
): string {
  const providerState = conclusion === null ? `status ${status}` : `status ${status}, conclusion ${conclusion}`;
  const text = [title, summary].filter((part): part is string => part !== null && part.trim().length > 0).join(' — ');
  if (text.length === 0) return `GitHub reported ${providerState} and no output text.`;
  return `GitHub reported ${providerState}. ${text}`;
}

function detailOfStatus(state: string, description: string | null): string {
  return description === null || description.trim().length === 0
    ? `GitHub commit status reported ${state} with no description.`
    : `GitHub commit status reported ${state}: ${description}`;
}

function pullRequestRefOf(pull: PullRequestShape): PullRequestRef {
  return {
    pullRequestId: pull.id as ProviderId,
    number: pull.number,
    url: pull.htmlUrl,
    draft: pull.draft,
    state: pullRequestStateOf(pull),
  };
}

/**
 * GitHub's `state` flag plus its `merged` flag mapped onto the three states an owner acts on.
 *
 * `merged` is read first because GitHub reports a merged pull request as `state: "closed"`;
 * a merged candidate and a withdrawn one are different facts, and collapsing them would tell
 * the owner their change landed when it was abandoned.
 *
 * A `state` this adapter does not recognise becomes `Closed`, never `Open`. An unknown state
 * is no evidence that the pull request is still open, and defaulting it to open would present
 * withdrawn work as reviewable — the pull-request-side instance of the rule that a result the
 * adapter cannot read is never a pass (mvp-spec F20-AC2).
 */
function pullRequestStateOf(pull: PullRequestShape): PullRequestState {
  if (pull.merged) return 'Merged';
  return pull.state === 'open' ? 'Open' : 'Closed';
}

function mapReview(review: ReviewShape): GitReviewState {
  switch (review.state.toUpperCase()) {
    case 'APPROVED':
      return { kind: 'Review', decision: 'Approved', reviewer: review.reviewer, submittedAt: review.submittedAt };
    case 'CHANGES_REQUESTED':
      return { kind: 'Review', decision: 'ChangesRequested', reviewer: review.reviewer, submittedAt: review.submittedAt };
    case 'COMMENTED':
      return { kind: 'Review', decision: 'Commented', reviewer: review.reviewer, submittedAt: review.submittedAt };
    case 'DISMISSED':
      return { kind: 'Unknown', detail: `GitHub reports review ${review.id} as ${review.state}, which is not a current decision.` };
    default:
      return {
        kind: 'Unknown',
        detail: `GitHub reports review ${review.id} from ${review.reviewer} with state "${review.state}", which this adapter does not recognise. It is reported as unknown rather than read as an approval (F26-AC5).`,
      };
  }
}

/**
 * Whether a pull request is the one this request is about.
 *
 * The marker is the primary key because it survives a head change: a draft whose head moved
 * is still the draft this operation created. The head-and-link clause is the fallback for a
 * draft written before a restart under a new operation identity.
 */
function isMatchFor(pull: PullRequestShape, request: FindDraftsRequest, owner: string): boolean {
  const marker = parseManagedMarker(pull.body ?? '');
  if (marker !== null && marker.operationId === request.operationId) return true;
  const headMatches = pull.headSha === request.headSha && (owner.length === 0 || pull.userLogin === owner);
  return headMatches && linksMatch(linkOf(pull), request.link);
}

/** The link identity a managed marker records, read back from the provider. */
function linkOf(pull: PullRequestShape): DraftLinkTarget {
  const marker = parseManagedMarker(pull.body ?? '');
  const recorded = marker?.link ?? null;
  if (recorded === null || recorded === 'none') return { kind: 'None', reason: 'No linked work was recorded for this draft.' };
  const parsed = parseLinkKey(recorded);
  return parsed ?? { kind: 'None', reason: 'The recorded link identity could not be read.' };
}

/**
 * The marker form of a link target.
 *
 * The issue identifier and URL are encoded into one opaque token rather than written as
 * prose, because a link target is a value the next call compares, and prose cannot be
 * compared without guessing at formatting.
 */
export function linkKeyOf(link: DraftLinkTarget): string {
  if (link.kind === 'None') return 'none';
  return `issue:${encodeURIComponent(link.issue.issueId)}:${encodeURIComponent(link.issue.identifier)}:${encodeURIComponent(link.issue.url)}`;
}

function parseLinkKey(key: string): DraftLinkTarget | null {
  const parts = key.split(':');
  if (parts.length !== 4 || parts[0] !== 'issue') return null;
  const issueId = decodeField(parts[1] ?? null);
  const identifier = decodeField(parts[2] ?? null);
  const url = decodeField(parts[3] ?? null);
  if (issueId === null || identifier === null || url === null) return null;
  const issue: TicketIssueRef = {
    issueId: issueId as ProviderId,
    identifier,
    url,
  };
  return { kind: 'Ticket', issue };
}

function linksMatch(left: DraftLinkTarget, right: DraftLinkTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'None' && right.kind === 'None') return true;
  if (left.kind === 'None' || right.kind === 'None') return false;
  return left.issue.issueId === right.issue.issueId;
}

/**
 * The path segment for a draft.
 *
 * GitHub's pull request identity is its number, and `pullRequestId` carries exactly that, so
 * the path is built from the provider identity rather than from a second interpretation of it.
 */
function numberOf(existing: DraftRef): string {
  return existing.pullRequest.pullRequestId;
}

/** A ref name as a single URL path segment. */
function encodeRef(name: string): string {
  return encodeURIComponent(name).replace(/%2F/g, '/');
}

/** Remote URLs compared without scheme, `.git` suffix or a trailing slash. */
function normaliseRemoteUrl(url: string): string {
  return url.trim().replace(/\.git$/, '').replace(/\/+$/, '').replace(/^(https?|ssh|git):\/\//, '').replace(/^git@/, '');
}

function mergeMethod(method: MergePullRequestRequest['method']): 'merge' | 'squash' | 'rebase' {
  switch (method) {
    case 'Squash':
      return 'squash';
    case 'Merge':
      return 'merge';
    case 'Rebase':
      return 'rebase';
  }
}

/**
 * Whether the merged content is the content the owner authorized.
 *
 * The merge commit is a new commit, so it can never equal the authorized head. What F26-AC4
 * asks is whether the *content* that landed is the content that was reviewed, and the
 * provider reports the head it merged as the pull request's head at the moment of the merge.
 * That is the comparison, and a difference is reported with both SHAs named rather than
 * summarised.
 */
function contentRelationOf(mergeCommitSha: string, mergedHeadSha: string, authorizedHeadSha: string): ContentRelation {
  if (mergedHeadSha === authorizedHeadSha) return { kind: 'MatchesAuthorizedHead' };
  return {
    kind: 'DiffersFromAuthorizedHead',
    detail: `Merge commit ${mergeCommitSha.slice(0, 12)} carries the pull request head ${mergedHeadSha.slice(0, 12)}, which is not the authorized head ${authorizedHeadSha.slice(0, 12)}.`,
  };
}

/**
 * A failed push, classified by git's own wording.
 *
 * `git push` exits 1 for a rejected non-fast-forward, an unusable credential and a remote
 * outage alike, so the exit code alone cannot distinguish "the branch moved" from "the
 * credential is wrong". Reporting all three as `Conflict` would send the owner to rebase a
 * branch that was never pushed (F18-AC1).
 */
function pushFailure(stderr: string, redact: (text: string) => string, branch: string): DomainError {
  const detail = redact(stderr.trim().slice(0, 400));
  if (isNonFastForwardFailure(stderr)) {
    return {
      code: 'Conflict',
      reason: redact(
        `git refused to update ${branch} because the remote ref is not an ancestor of the commit being pushed: ${detail}. Fetch and rebase, or retry with ForceWithLease once the remote ref has been read, rather than forcing over whatever is there now (F30-AC2).`,
      ),
      expected: 'a remote ref that is an ancestor of the pushed commit',
      actual: `a remote ref that has diverged (${branch})`,
    };
  }
  if (isAuthenticationFailure(stderr)) {
    return {
      code: 'Forbidden',
      reason: redact(
        `git could not publish ${branch}: ${detail}. The remote rejected the credential, so repeated attempts with the same credential cannot succeed. Reauthorize the Git connector credential before any new operation (F03-AC4).`,
      ),
    };
  }
  return {
    code: 'Unavailable',
    reason: redact(
      `git could not publish ${branch}: ${detail}. The remote gave no category this adapter recognises, so the push is reported as unavailable rather than as a conflict. Read the remote ref before any retry.`,
    ),
  };
}

/**
 * What the capability declaration rests on.
 *
 * `permissions` is GitHub's own report of what this credential may do to this repository,
 * read live. It is stated rather than summarised because the merge capability and the push
 * capability come from the same flag: a credential that may push may also merge, so nothing
 * at the provider separates a coding stage from a delivery executor (F03-AC5, N02-AC3).
 */
function compatibilityDetail(repository: RepositoryShape, remoteName: string): string {
  const flags = Object.entries(repository.permissions)
    .filter(([, granted]) => granted)
    .map(([name]) => name)
    .sort();
  return `GitHub accepted the connector credential for ${repository.fullName} and reported these permissions for the authenticated account: ${flags.join(', ') || 'none'}. The default branch is ${repository.defaultBranch}. Pushes are published through the git remote "${remoteName}". Merge uses the endpoint's own pinned-head precondition, so a stale head is refused by the provider; note that GitHub derives merge rights from the same permission that grants push, so the push/merge boundary is enforced by ShipLoop's credential broker and not by this token.`;
}