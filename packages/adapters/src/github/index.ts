/**
 * The GitHub provider adapter surface.
 *
 * Exported as a subpath so a consumer can import the GitHub adapter without pulling in every
 * adapter. `README.md` beside these files records exactly which behaviour was proven against
 * the live API and which is proven only against constructed payloads, which is the distinction
 * the specification requires a provider claim to make (mvp-spec 9, N05-AC2).
 */

export {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  GitHubClient,
  GITHUB_USER_AGENT,
  createGitTransport,
  type GitCommandResult,
  type GitHubClientOptions,
  type GitHubMethod,
  type GitHubRequest,
  type GitHubSuccess,
  type GitTransport,
  type GitTransportOptions,
} from './client.ts';

export {
  githubRetryAfterMs,
  isAuthenticationFailure,
  isNonFastForwardFailure,
  lostGitHubWriteOutcome,
  mapCheckConclusion,
  mapCommitStatusState,
  mapGitHubFailure,
  parseGitHubError,
  type GitHubApiError,
  type GitHubFailure,
  type GitHubHeaders,
} from './errors.ts';

export {
  GITHUB_PROVIDER,
  GitHubGitAdapter,
  draftBody,
  linkKeyOf,
  managedMarkerLine,
  markerLineOf,
  parseManagedMarker,
  type GitCommitRange,
  type GitHubGitAdapterOptions,
  type ReadCommitRangeRequest,
} from './adapter.ts';