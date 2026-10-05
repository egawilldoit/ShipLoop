/**
 * The public surface of the MVP browser transport.
 *
 * One import for a page: `import { fetchHome, projectScopeOf } from '../mvp-client/index.ts'`.
 * Re-exporting rather than pointing at the three modules individually is deliberate — a page that
 * imports `transport.ts` directly can reach `send()`, and `send()` takes any path, which is the one
 * thing this module exists to prevent (mvp-spec 3, F02-AC2).
 *
 * `send`, `scopedGet`, `scopedSend` and `envelope` are therefore **not** re-exported. The two
 * things the session layer genuinely needs from `transport.ts` are the CSRF token and the
 * connection state, and those two are the only ones exported.
 */

export {
  approveContract,
  createProject,
  createRequest,
  decideCandidate,
  draftContract,
  editContract,
  fetchHandoff,
  fetchHome,
  fetchReview,
  fetchSession,
  fetchSettings,
  getContract,
  getRequest,
  invalidateContract,
  linkCandidate,
  listContractRevisions,
  listProjects,
  listContractCriteria,
  listRequests,
  projectIdOf,
  projectScopeOf,
  readCandidate,
  readVerificationCheckNames,
  recordOwnerTest,
  refreshCandidate,
  reviseContract,
  selectActiveProject,
  signIn,
  signOut,
  updateRequest,
  updateSettings,
  verifyCandidate,
  type ApproveContractOutcome,
  type ContractContentInput,
  type ContractStaleReason,
  type DecideCandidateOutcome,
  type OwnerTestResult,
  type VerificationCheckNames,
  type VerifyCandidateOutcome,
} from './client.ts';

export type {
  ActiveProjectView,
  CandidateBindingReport,
  CandidateChangeReport,
  CandidateCheckReport,
  CandidateReadinessReport,
  CandidateReport,
  ContractCriterionView,
  ContractView,
  CriterionState,
  EvidenceOutcome,
  EvidenceStandingReport,
  HandoffPrerequisite,
  HandoffT3View,
  HandoffView,
  HomeEntry,
  HomeEntryKind,
  HomeProjection,
  LinkedCandidateReport,
  LiveCandidateReport,
  OwnerTestReportView,
  OwnerView,
  ProfileVersionView,
  ProjectScope,
  ProjectSettingsView,
  ProjectView,
  ProviderCheckResult,
  ProviderPullRequestState,
  RecordedCandidateReport,
  RecordedObservationView,
  RequestDetailView,
  RequestView,
  ReviewCardView,
  ReviewCheckResult,
  ReviewCheckView,
  ReviewContractView,
  ReviewCriterionView,
  ReviewDecisionKind,
  ReviewDecisionView,
  ReviewEligibilityView,
  ReviewEvidenceOutcome,
  ReviewEvidenceView,
  ReviewOwnerDecisionView,
  ReviewOwnerTestView,
  ReviewRequestView,
  ReviewStaleDecisionView,
  ReviewStalenessView,
  SessionView,
  VerificationReportView,
} from './types.ts';

export type {
  MvpConnectionState,
  MvpFailure,
  MvpFailureCode,
  MvpFieldError,
  MvpPrerequisite,
  MvpResult,
} from './transport.ts';

export { getMvpConnectionState, getMvpCsrfToken, setMvpCsrfToken, subscribeToMvpConnection } from './transport.ts';