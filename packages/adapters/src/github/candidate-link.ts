/**
 * The shipped GitHub adapter's read-only candidate surface.
 *
 * `GitHubGitAdapter` is a full `GitAdapter`: it can push a branch, upsert a draft, merge a
 * pull request and read branch protection. All of that predates the MVP and none of it is
 * in the MVP's scope — ShipLoop v0.1 links a pull request an external workflow already
 * created, and then reads it.
 *
 * Rather than deleting capabilities another slice still uses, the MVP takes a *narrower
 * view* of the same object. `githubCandidatePort` is that view: it takes the full adapter
 * and returns an object with exactly the two read methods, so the candidate-linking
 * controller holds no reference it could call a write through.
 *
 * The parameter and return types are the contract's own, so `GitHubGitAdapter` stops
 * satisfying `CandidateGitPort` the moment it stops implementing `readLinkedPullRequest`,
 * and the composition root fails to compile rather than discovering a missing read at the
 * moment an owner pastes a link.
 */

import { readOnlyCandidateGit } from '../contracts/candidate-link.ts';
import type {
  CandidateCheckReader,
  CandidateGitPort,
  CandidateLinkReader,
} from '../contracts/candidate-link.ts';
import type { GitHubGitAdapter } from './adapter.ts';

/** The shipped adapter's read-only candidate surface. */
export type GitHubCandidateSource = CandidateLinkReader & CandidateCheckReader;

/** The object handed to the candidate-linking controller. */
export type GitHubCandidatePort = CandidateGitPort;

/**
 * Narrows a shipped GitHub adapter to the reads the MVP candidate journey performs.
 *
 * This is the composition point: wiring candidate linking means calling this with the real
 * adapter, so no caller ever receives the merge or push methods as part of the candidate port.
 * The result is a fresh two-read object rather than the adapter under a read-only type, because
 * a type is erased at runtime — handing the adapter along would leave every write reachable from
 * a value that only claims to be read-only.
 *
 * The parameter and return types are the contract's own, so `GitHubGitAdapter` stops satisfying
 * `CandidateGitPort` the moment it stops implementing `readLinkedPullRequest`, and the
 * composition root fails to compile rather than discovering a missing read at the moment an
 * owner pastes a link.
 */
export function githubCandidatePort(adapter: GitHubGitAdapter): GitHubCandidatePort {
  return readOnlyCandidateGit(adapter as GitHubCandidateSource);
}
