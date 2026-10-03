/**
 * Read-only Git port for linking and re-reading an MVP candidate.
 *
 * ShipLoop v0.1 does not create, merge, close, approve, deploy or re-protect a pull
 * request. The external execution environment does that; ShipLoop's job starts once the
 * owner pastes the address of a pull request that already exists. That is a claim about
 * the product's scope, so it is expressed in the type rather than in a UI convention:
 *
 * - the port below has **two methods, and both are reads**. It is not `GitAdapter`
 *   narrowed by `Pick`, because a `Pick` of the wrong key would compile again the moment
 *   someone reached for `mergePullRequest`. A separate interface means a caller that
 *   depends on it *cannot* call a write: there is no such member to call.
 * - the read verbs are listed as data in `CANDIDATE_READ_METHODS`, and
 *   `readOnlyCandidateGit` is the function that hands a caller exactly those two methods.
 *   A test asserts against that list, so widening the port by one write method fails a
 *   test rather than shipping a capability nobody reviewed.
 * - the "do not write" property is additionally asserted against the shipped
 *   `GitHubGitAdapter`, which *does* hold `mergePullRequest`: the guarantee is that this
 *   module cannot reach it, not that the underlying adapter lacks it.
 *
 * Reusing `ReadChecksRequest` and `ProviderCheckObservation` from `./git.ts` is
 * deliberate. Check retrieval, the six-state result vocabulary and the "a required check
 * the provider did not report is `Missing`, never `Passed`" rule were already implemented
 * and proved against the live GitHub API; a second spelling of them here would be a second
 * opinion about which results count.
 */

import type { AdapterContext, AdapterIdentity, ProviderCheckObservation } from './index.ts';
import type { GitRepositoryRef, ReadChecksRequest } from './git.ts';
import type { CommitSha, ProviderId, PullRequestState, Result } from '@shiploop/domain';

/**
 * Which pull request to read, in the project's own repository.
 *
 * `repository` is the project's configured repository rather than the one parsed out of the
 * pasted URL, so the comparison "is this the project's repository?" is a decision this
 * adapter makes and reports, not one the URL parser made on its behalf.
 */
export interface ReadLinkedPullRequestRequest {
  readonly repository: GitRepositoryRef;
  /** GitHub's display number, as it appears in the URL. */
  readonly pullRequestNumber: number;
}

/**
 * What the provider says about one pull request, as of one read.
 *
 * Every field here was read from the provider in the same call, so a caller cannot
 * compare facts observed at different instants (mvp-spec F26-AC2). `headSha` is narrowed
 * to a full `CommitSha` by the adapter: a payload GitHub reported with an abbreviated head
 * produces a stated refusal rather than a revision that resolves to whatever it names
 * tomorrow.
 */
export interface LinkedPullRequestFacts {
  readonly repository: GitRepositoryRef;
  /** GitHub's own identity for the pull request, as an opaque provider id. */
  readonly providerPullRequestId: ProviderId;
  readonly number: number;
  readonly url: string;
  readonly state: PullRequestState;
  readonly draft: boolean;
  readonly headBranch: string;
  /** Full 40-character commit SHA. The candidate's identity. */
  readonly headSha: CommitSha;
  readonly baseBranch: string;
  /** Full 40-character commit SHA the change is measured against. */
  readonly baseSha: CommitSha;
  /**
   * The repository the head branch lives in, when GitHub reported it.
   *
   * Null for a pull request whose head repository GitHub does not expose. It exists so a
   * pull request opened from a fork can be told apart from one opened inside the project:
   * the code in a fork was never in the project's repository, and linking it as if it
   * were would attribute a stranger's commits to this project.
   */
  readonly headRepository: string | null;
  /** The merge commit, present only when GitHub reports the pull request as merged. */
  readonly mergedSha: CommitSha | null;
  readonly mergedAt: string | null;
  readonly observedAt: string;
}

/**
 * Reads one pull request by number.
 *
 * The whole surface for reading a candidate's identity. It fails rather than guessing:
 * a repository at another provider, a repository name that is not `owner/repository`, a
 * number that is not positive and a pull request GitHub does not have each produce their
 * own refusal, because "wrong repository" and "no such pull request" are different facts
 * an owner needs to see differently.
 */
export interface CandidateLinkReader extends AdapterIdentity {
  readonly kind: 'Git';
  readLinkedPullRequest(
    context: AdapterContext,
    request: ReadLinkedPullRequestRequest,
  ): Promise<Result<LinkedPullRequestFacts>>;
}

/**
 * Reads the check results reported for a candidate head.
 *
 * Declared as its own narrow interface rather than reusing `GitAdapter`, and satisfied
 * structurally by any adapter that already implements `readChecks` — including the shipped
 * `GitHubGitAdapter` and the fake the rest of the test suite drives. `ReadChecksRequest`
 * is the existing request type, so `requiredCheckNames` keeps its meaning: the profile
 * decides what is required and a name the provider did not report comes back `Missing`.
 */
export interface CandidateCheckReader extends AdapterIdentity {
  readonly kind: 'Git';
  readChecks(
    context: AdapterContext,
    request: ReadChecksRequest,
  ): Promise<Result<readonly ProviderCheckObservation[]>>;
}

/**
 * The complete port the candidate-linking controller depends on.
 *
 * Both halves are reads. The intersection is what makes "the MVP GitHub integration is
 * read-oriented" a compile-time property of the controller rather than a reviewer's
 * memory.
 */
export type CandidateGitPort = CandidateLinkReader & CandidateCheckReader;

/** Every method name the port exposes. Asserted against in `candidate-link.test.ts`. */
export const CANDIDATE_READ_METHODS = ['readLinkedPullRequest', 'readChecks'] as const;

/**
 * Hands a caller exactly the read surface of an adapter.
 *
 * The returned object is a fresh literal naming two methods, so the caller holds no
 * reference to the underlying adapter and cannot reach a write through it. It is the
 * function the composition root calls: wiring a candidate journey means passing the result
 * of this call, and the type of that result has no write member to call.
 */
export function readOnlyCandidateGit(
  adapter: CandidateGitPort,
): {
  readLinkedPullRequest: CandidateLinkReader['readLinkedPullRequest'];
  readChecks: CandidateCheckReader['readChecks'];
} {
  return {
    readLinkedPullRequest: (context, request) => adapter.readLinkedPullRequest(context, request),
    readChecks: (context, request) => adapter.readChecks(context, request),
  };
}
