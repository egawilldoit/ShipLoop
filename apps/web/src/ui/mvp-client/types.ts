/**
 * The wire shapes the MVP client reads, transcribed from the server handlers.
 *
 * These are local declarations rather than imports from `apps/web/src/server/contracts.ts`
 * for the reason `ui/api-client.ts` records: the server port module belongs to the server
 * bundle, and a UI that imports it couples a browser build to the composition root's types
 * (F02-AC2). Each type below names the handler that produces it, so a drift between this file
 * and that handler is a one-file fix rather than a silent wrong answer.
 *
 * The rule the transcriptions follow: a field is declared because a handler sends it, and a
 * field is *not* declared because the product forbids it. `providerWritePerformed: false` is
 * declared as the literal `false` rather than `boolean` for the same reason `routes/candidates.ts`
 * declares it — a card that could read `true` would let a merge or a deploy be rendered out of a
 * candidate card (mvp-spec F03-AC5). `MvpOwnerDecisionView` has no `merged` member, and
 * `ReviewDecisionKind` has two members and no third, because v0.1 ends at Accept or Request
 * Changes (mvp-spec 3, F25).
 */

/* -------------------------------------------------------------------------- */
/* Identity: session, active project, project listing                          */
/* -------------------------------------------------------------------------- */

/**
 * The project this session addresses, or the state the owner is in when none is.
 *
 * Transcribed from `ActiveProjectView` in `apps/web/src/server/contracts.ts`, as
 * `GET /api/owner/session` and `PUT /api/owner/active-project` return it. A discriminated union
 * rather than a nullable pair, so holding a project id means holding a variant the controller
 * produced from a project row this store holds: there is no placeholder and no default to
 * interpolate when the value is missing (F02-AC1, F02-AC4).
 */
export type ActiveProjectView =
  | {
      readonly state: 'Selected';
      readonly activeProjectId: string;
      readonly activeProjectName: string;
    }
  | {
      readonly state: 'NoProjectSelected';
      readonly selectableProjectCount: number;
    };

/** The signed-in owner as `GET /api/owner/session` describes it (F01-AC1). */
export interface OwnerView {
  readonly ownerId: string;
  readonly displayName: string;
  /** The address the owner provisioned with, or null when the row carries none. */
  readonly email: string | null;
  readonly createdAt: string;
  readonly activeProject: ActiveProjectView;
}

/**
 * The session block `GET /api/owner/session` and `POST /api/owner/sign-in` both answer.
 *
 * `csrfToken` is derived server-side and read back here so a reload does not need a second
 * sign-in; the cookie it belongs to is HttpOnly, so this response is the only way to obtain
 * it (F01-AC4).
 */
export interface SessionView {
  readonly owner: OwnerView;
  readonly session: {
    readonly sessionId: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
  };
  readonly csrfToken: string;
}

/** One project as the selector offers it, from `GET /api/projects` (F02-AC1). */
export interface ProjectView {
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Project scope                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The project a project-scoped call addresses, or an explicit statement that none is selected.
 *
 * Every function in this module that touches a project-scoped route takes one of these rather
 * than a bare `projectId: string`, so a project id can only be obtained from
 * `session.owner.activeProject`. There is no overload accepting a string: the call sites that
 * would otherwise pass an empty or `undefined` id cannot type-check, which is the structural
 * version of the historical defect where an unselected project produced a request for a project
 * literally named `undefined` and its honest 404 was reported as a claim about a project's
 * contents (F02-AC1, F02-AC4).
 */
export type ProjectScope =
  | {
      readonly kind: 'project';
      readonly projectId: string;
      readonly projectName: string;
    }
  | {
      readonly kind: 'no-project-selected';
      readonly selectableProjectCount: number;
    };

/* -------------------------------------------------------------------------- */
/* Requests and contracts                                                      */
/* -------------------------------------------------------------------------- */

/** One request as `GET /api/projects/:projectId/requests` reports it, newest first (mvp-spec 3). */
export interface RequestView {
  readonly requestId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly sourceIdeaId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One acceptance criterion as the contract routes carry it in both directions.
 *
 * `verificationCheckId` is the binding Stage 1 added: an `automated` criterion must name a
 * check name from the project's profile, and approval refuses with 400 naming
 * `acceptanceCriteria.<id>.verificationCheckId` when it does not; an `owner_test` criterion
 * must carry `null`. It is `string | null` rather than optional here because
 * `explicitBindings()` in `routes/contracts.ts` normalises an omitted binding to `null` before
 * it leaves the transport, so no caller has to ask whether the key was absent (F23-AC1, F24-AC3).
 */
export interface ContractCriterionView {
  readonly id: string;
  readonly description: string;
  readonly verificationType: 'automated' | 'owner_test';
  readonly verificationCheckId: string | null;
}

/** One contract revision, as `routes/contracts.ts` reports it (mvp-spec 3, F24-AC4). */
export interface ContractView {
  readonly contractId: string;
  readonly revision: number;
  readonly projectId: string;
  readonly requestId: string;
  readonly status: 'draft' | 'approved' | 'stale';
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly ContractCriterionView[];
  /**
   * The fingerprint of this revision's text, and the value an approval sends back.
   *
   * This is the compare-and-set token for `POST .../approve`. It must be read from a read and
   * sent unchanged; the server compares it against the fingerprint it derives from the stored
   * text, so a client cannot describe text of its own choosing, and a mismatch is a 409 rather
   * than an approval of somebody else's words (mvp-spec 3, mvp-spec 7, F24-AC4).
   */
  readonly contentFingerprint: string;
  readonly requestFingerprint: string;
  readonly answersCurrentRequest: boolean;
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
  readonly staleReason: string | null;
  readonly supersededByRevision: number | null;
  readonly sourceBriefId: string | null;
  readonly sourceBriefVersion: number | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Why this revision may not be measured against a candidate, or null when it may. */
  readonly blockedBecause: string | null;
}

/**
 * One request with the contract state answering it.
 *
 * `routes/contracts.ts` answers this one **unwrapped** — `reply.send(detail.value)` with no
 * `{ request: … }` wrapper — unlike every other response in that file. Transcribed to match,
 * and noted because it is the one place a client guessing at the envelope would be wrong
 * (mvp-spec 3).
 */
export interface RequestDetailView {
  readonly request: RequestView;
  readonly latestRevision: ContractView | null;
  readonly approvedRevision: ContractView | null;
  /** Every revision, oldest first. */
  readonly revisions: readonly ContractView[];
}

/* -------------------------------------------------------------------------- */
/* Handoff                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where the external executor may be opened, if anywhere.
 *
 * Three states because a nullable URL cannot tell them apart and the remedy differs: nothing
 * configured is normal and the packet works anyway (mvp-spec L02-AC3). There is no execution
 * status here and no field could hold one — ShipLoop has no supported integration that would
 * make such a claim true (mvp-spec L02).
 */
export type HandoffT3View =
  | { readonly state: 'Configured'; readonly url: string }
  | {
      readonly state: 'NotConfigured';
      readonly reason: string;
      readonly prerequisites: readonly HandoffPrerequisite[];
    }
  | {
      readonly state: 'Unusable';
      readonly reason: string;
      readonly prerequisites: readonly HandoffPrerequisite[];
    };

/** One missing prerequisite with the remedy an operator can act on (F04-AC3). */
export interface HandoffPrerequisite {
  readonly name: string;
  readonly detail: string;
  readonly remedy: string;
}

/**
 * One approved revision rendered into the text an implementer outside ShipLoop is handed.
 *
 * `markdown` and `fingerprint` travel exactly as the controller rendered them; this client does
 * not reformat, trim or re-escape either, because the property that makes a handoff trustworthy
 * is that one approved contract produces one document (N02-AC2).
 */
export interface HandoffView {
  readonly contractId: string;
  readonly revision: number;
  readonly packet: {
    readonly markdown: string;
    readonly fingerprint: string;
  };
  readonly t3: HandoffT3View;
}

/* -------------------------------------------------------------------------- */
/* Candidate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A pull request state this product has words for.
 *
 * The domain's own `PULL_REQUEST_STATES` (`Open`, `Closed`, `Merged`, `Unknown`), case included,
 * because `routes/candidates.ts` narrows with `narrowProviderState` against that exact list and
 * refuses anything outside it. `Unknown` is a member rather than an error: a state this product
 * cannot read stays unread and must never be mapped onto `Open` — that would present withdrawn
 * work as reviewable (mvp-spec F20-AC2).
 */
export type ProviderPullRequestState = 'Open' | 'Closed' | 'Merged' | 'Unknown';

/**
 * A provider check result this product has words for.
 *
 * The domain's own `CHECK_RESULTS`, case included, for the same reason: `narrowCheckResult`
 * refuses a result outside them, and an unreadable result is never coerced to `Passed`
 * (mvp-spec F20-AC2).
 */
export type ProviderCheckResult = 'Passed' | 'Failed' | 'Missing' | 'Waiting' | 'Stale' | 'NotApplicable';

/** The candidate row ShipLoop recorded, with both SHAs at full length (mvp-spec 3). */
export interface RecordedCandidateReport {
  readonly candidateId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly provider: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly pullRequestState: ProviderPullRequestState;
  readonly draft: boolean;
  readonly observedAt: string;
  readonly linkedAt: string;
}

/** What the provider said during a read, alongside the row ShipLoop holds. */
export interface LiveCandidateReport {
  readonly provider: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly headSha: string;
  /** A fork's name when the provider reports one; the reason this candidate may not be ready. */
  readonly headRepository: string | null;
  readonly pullRequestState: ProviderPullRequestState;
  readonly draft: boolean;
  readonly observedAt: string;
}

/** The `(contract revision, head SHA)` pair every piece of evidence must name (F20-AC3). */
export interface CandidateBindingReport {
  readonly contractId: string;
  readonly contractRevision: number;
  readonly headSha: string;
}

/**
 * What a read observed about the difference between the record and the provider.
 *
 * `priorEvidenceStale` is the load-bearing member: evidence recorded for SHA A describes no
 * later build, and a view that carries a ready status across a force push is the defect this
 * transport exists to prevent (mvp-spec F20-AC3, F24-AC4, F25-AC3).
 */
export interface CandidateChangeReport {
  readonly kind: string;
  readonly changed: readonly string[];
  readonly changedAnything: boolean;
  readonly previousHeadSha: string | null;
  readonly currentHeadSha: string;
  readonly priorEvidenceStale: boolean;
  readonly detail: string;
}

/** What the verification layer needs in order to treat earlier results as stale (F24-AC4). */
export interface EvidenceStandingReport {
  readonly status: 'Current' | 'Stale';
  /** Always false: this transport holds no stored readiness to carry forward. */
  readonly priorReadinessPreserved: false;
  readonly priorCandidateId: string | null;
  readonly priorHeadSha: string | null;
  readonly detail: string;
}

/** One check as the candidate view presents it, with `blocking` derived by the transport. */
export interface CandidateCheckReport {
  readonly name: string;
  readonly result: ProviderCheckResult;
  readonly required: boolean;
  readonly blocking: boolean;
  readonly notApplicableApprovedByPolicy: boolean;
  readonly observedHeadSha: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly artifactUrl: string | null;
  readonly detail: string | null;
}

/** Whether this candidate can be decided on, and every reason when it cannot (F24-AC3). */
export interface CandidateReadinessReport {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

/** What a successful link established. Carries no readiness answer at all. */
export interface LinkedCandidateReport {
  readonly candidate: RecordedCandidateReport;
  readonly live: LiveCandidateReport;
  readonly binding: CandidateBindingReport;
  readonly bindingFingerprint: string;
  /** True when this exact identity was already recorded, so nothing new was written. */
  readonly alreadyRecorded: boolean;
  readonly observedAt: string;
  /** Always false: linking reads the provider and changes nothing there (mvp-spec F03-AC5). */
  readonly providerWritePerformed: false;
}

/** One candidate as the owner reads it, from one live read (F20-AC3, F24-AC4). */
export interface CandidateReport {
  readonly candidate: RecordedCandidateReport;
  readonly live: LiveCandidateReport;
  readonly binding: CandidateBindingReport;
  readonly bindingFingerprint: string;
  readonly change: CandidateChangeReport;
  readonly evidence: EvidenceStandingReport;
  readonly supersededCandidateIds: readonly string[];
  readonly checks: readonly CandidateCheckReport[];
  /** About checks only, derived by the transport from `checks` rather than copied. */
  readonly checksReady: boolean;
  readonly blockingChecks: readonly string[];
  readonly reviewReadiness: CandidateReadinessReport;
  readonly observedAt: string;
  /** Always false: no merge, close, approval or protection change happened (mvp-spec F03-AC5). */
  readonly providerWritePerformed: false;
}

/* -------------------------------------------------------------------------- */
/* Review card and decision                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The states a criterion may read on the card — the domain's own five.
 *
 * `unverified` and `pending` are members rather than absences, so "no automated observation yet"
 * and "nobody has run the owner's own test" are both displayable states rather than gaps in a
 * table. `stale` means an observation exists but no longer describes this commit (mvp-spec 3,
 * F23-AC1, F24-AC3).
 */
export type CriterionState = 'passed' | 'failed' | 'pending' | 'stale' | 'unverified';

/**
 * What a check may read on the review card, including the two that are explicitly not a pass.
 *
 * `not_run` and `stale` are members rather than absences, so a check nobody reported and a check
 * bound to another commit are both displayed rather than dropped from the table (F20-AC2).
 */
export type ReviewCheckResult =
  | 'passed'
  | 'failed'
  | 'waiting'
  | 'missing'
  | 'capture_failed'
  | 'stale'
  | 'not_run';

/** What an observation recorded, in the evidence vocabulary. */
export type EvidenceOutcome = 'passed' | 'failed' | 'waiting' | 'missing' | 'capture_failed';

/** The two decisions v0.1 ends at, and no third (mvp-spec 3, F25). */
export type ReviewDecisionKind = 'accepted' | 'changes_requested';

/** What an observation recorded, and what it means now (F20-AC3, F24-AC3). */
export type ReviewEvidenceOutcome = EvidenceOutcome;

export interface ReviewRequestView {
  readonly requestId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewContractView {
  readonly contractId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly revision: number;
  readonly status: string;
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly approval: { readonly approvedAt: string | null; readonly approvedBy: string | null };
  readonly acceptanceCriteria: readonly {
    readonly id: string;
    readonly verificationType: 'automated' | 'owner_test';
    readonly verificationCheckId: string | null;
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewCandidateView {
  readonly candidateId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly pullRequestState: string;
  readonly draft: boolean;
  readonly baseBranch: string;
  /** The full 40-character commit. Never an abbreviation, a branch or a PR number. */
  readonly headSha: string;
  readonly observedAt: string;
}

export interface ReviewPolicyView {
  readonly policyId: string;
  readonly requiredAutomatedCheckIds: readonly string[];
  readonly ownerTestBlocksReview: boolean;
  readonly ownerTestBlocksDelivery: boolean;
}

export interface ReviewCheckView {
  readonly checkId: string;
  readonly required: boolean;
  readonly blocking: boolean;
  readonly result: string;
  readonly evidenceId: string | null;
  readonly source: string | null;
  readonly reason: string;
}

export interface ReviewCriterionView {
  readonly criterionId: string;
  readonly description: string;
  readonly verificationType: 'automated' | 'owner_test';
  /** Null when the contract assigned no verifier; such a criterion reads `unverified` (F23-AC1). */
  readonly verificationCheckId: string | null;
  readonly state: CriterionState;
  readonly methodKind: string;
  readonly methodDetail: string | null;
  readonly evidenceId: string | null;
  readonly observedAt: string | null;
  readonly reason: string;
}

export interface ReviewOwnerTestView {
  readonly criterionId: string;
  readonly description: string;
  readonly instructions: string | null;
  /** `pending` until the owner records a result; nothing on this card may move it (F23-AC1). */
  readonly state: CriterionState;
  readonly evidenceId: string | null;
  readonly observedAt: string | null;
  readonly reason: string;
}

/**
 * One recorded observation, with its staleness stated rather than implied.
 *
 * There is deliberately **no `outcome` member**, transcribed from
 * `ReviewEvidenceView` in the server contracts: a client reaching for `outcome` finds nothing,
 * which is the only way this boundary can refuse to hand out the field that makes a stale pass
 * render green. `recordedOutcome` is history; `currentOutcome` is what the observation means
 * now; `countsForCurrentCandidate` is the affirmative answer to "may this be shown as this
 * candidate's result?" (F20-AC3, F24-AC3).
 */
export interface ReviewEvidenceView {
  readonly evidenceId: string;
  readonly source: 'project_command' | 'github_check' | 'browser' | 'owner_test';
  readonly criterionId: string | null;
  readonly checkId: string | null;
  readonly recordedOutcome: ReviewEvidenceOutcome;
  readonly currentOutcome: ReviewEvidenceOutcome | 'stale';
  readonly countsForCurrentCandidate: boolean;
  readonly staleReasons: readonly string[];
  readonly reason: string;
  readonly observedAt: string | null;
  /** The full commit the source said it observed, or null when it attributed none. */
  readonly candidateHeadSha: string | null;
  readonly contractRevision: number | null;
  readonly detail: string | null;
  readonly artifactRef: string | null;
}

export interface ReviewStalenessView {
  readonly stale: boolean;
  readonly reasons: readonly string[];
  readonly staleEvidenceIds: readonly string[];
  readonly staleDecisionIds: readonly string[];
}

/** One owner decision that no longer describes the candidate on screen — shown, not hidden (F25-AC3). */
export interface ReviewStaleDecisionView {
  readonly decisionId: string;
  readonly kind: ReviewDecisionKind;
  readonly candidateHeadSha: string;
  readonly contractRevision: number;
  readonly reason: string;
}

export interface ReviewOwnerDecisionView {
  readonly decisionId: string;
  readonly kind: ReviewDecisionKind;
  /** The authenticated owner. Never read from a request body (F01-AC1, F25-AC4). */
  readonly ownerId: string;
  readonly decidedAt: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly candidateId: string;
  /** The full 40-character commit the decision was made against. */
  readonly candidateHeadSha: string;
  readonly feedback: string | null;
}

export interface ReviewDecisionView {
  readonly outcome: 'none' | ReviewDecisionKind;
  readonly decision: ReviewOwnerDecisionView | null;
  readonly staleDecisions: readonly ReviewStaleDecisionView[];
  /** False after a push: an acceptance of SHA A authorises nothing about SHA B (F27-AC3). */
  readonly authorizesCurrentCandidate: boolean;
}

/** The three gates, kept apart because the product keeps them apart (F24-AC3, F25-AC1). */
export interface ReviewEligibilityView {
  readonly readyForOwnerReview: boolean;
  readonly readyForAcceptance: boolean;
  readonly readyForDelivery: boolean;
  readonly blockingReasons: readonly string[];
  readonly ownerActions: readonly string[];
  readonly acceptanceBlockers: readonly string[];
  readonly deliveryBlockers: readonly string[];
}

/** The whole review card, computed in one pass and answered by one read (F24-AC2). */
export interface ReviewCardView {
  readonly collectedAt: string;
  readonly request: ReviewRequestView;
  readonly contract: ReviewContractView;
  readonly candidate: ReviewCandidateView;
  readonly policy: ReviewPolicyView;
  readonly checks: readonly ReviewCheckView[];
  readonly criteria: readonly ReviewCriterionView[];
  readonly ownerTests: readonly ReviewOwnerTestView[];
  readonly evidence: readonly ReviewEvidenceView[];
  readonly staleness: ReviewStalenessView;
  readonly decision: ReviewDecisionView;
  readonly eligibility: ReviewEligibilityView;
}

/** One automated observation, as `POST .../verify` reads it back (F20-AC2, F23-AC1). */
export interface RecordedObservationView {
  readonly evidenceId: string;
  readonly checkId: string;
  readonly recordedOutcome: ReviewEvidenceOutcome;
  readonly currentOutcome: ReviewEvidenceOutcome | 'stale';
  readonly countsForCurrentCandidate: boolean;
  readonly observedHeadSha: string | null;
  readonly observedContractRevision: number | null;
  readonly observedAt: string | null;
  readonly reason: string;
}

/**
 * What one automated verification pass observed, and the card it produced.
 *
 * `candidateHeadSha` and `providerHeadSha` are both carried and are allowed to differ, because
 * that difference *is* the finding: after a push, every check the provider attributed to the
 * newer commit proves nothing about the candidate under review (F20-AC3, F24-AC4).
 */
export interface VerificationReportView {
  readonly projectId: string;
  readonly candidateId: string;
  readonly candidateHeadSha: string;
  readonly providerHeadSha: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly method: 'github_checks';
  readonly observedAt: string;
  readonly recorded: readonly RecordedObservationView[];
  readonly review: ReviewCardView;
}

/** What the owner recorded, and the card it produced (F23-AC1, F25-AC4). */
export interface OwnerTestReportView {
  readonly projectId: string;
  readonly candidateId: string;
  readonly candidateHeadSha: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly criterionId: string;
  readonly outcome: 'passed' | 'failed';
  readonly evidenceId: string;
  readonly observedAt: string;
  readonly note: string | null;
  readonly review: ReviewCardView;
}

/* -------------------------------------------------------------------------- */
/* Home                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Why an entry is on the board, as the closed vocabulary `routes/home.ts` names it.
 *
 * A closed set rather than free text because each member is a state the projection proves from
 * recorded facts, and no member ever names an external executor (mvp-spec 3).
 */
export type HomeEntryKind =
  | 'ContractNotWritten'
  | 'ContractAwaitingApproval'
  | 'CandidateNotLinked'
  | 'VerificationOutstanding'
  | 'VerificationFailed'
  | 'OwnerTestOutstanding'
  | 'DecisionAwaiting'
  | 'CandidateReadyForReview';

/**
 * One thing on the board.
 *
 * No progress field, no percentage, no executor identifier, no elapsed time — the route has no
 * value it could fill in truthfully, so there is no field to expect one in. `headSha` is the
 * full 40-character commit or null, never an abbreviation and never a branch name (mvp-spec 3,
 * F17-AC2, F25-AC3).
 */
export interface HomeEntry {
  readonly kind: HomeEntryKind;
  readonly requestId: string;
  readonly title: string;
  readonly contractId: string | null;
  readonly contractRevision: number | null;
  readonly candidateId: string | null;
  readonly headSha: string | null;
  /** Why this entry is here, quoted from the projection that decided it. */
  readonly reason: string;
  /** What the owner does next. Never an executor's action. */
  readonly nextAction: string;
  readonly outstandingCriterionIds: readonly string[];
}

/**
 * The three groups, with the instant they were read.
 *
 * The lists are independent rather than a partition: a candidate with current automated evidence
 * *and* an unrun owner test is truthfully both ready to look at and waiting on the owner, and
 * deduplicating it away would drop a true statement to keep the board tidy (F24-AC3). An empty
 * group is empty — there is no placeholder and no filler (mvp-spec 3).
 */
export interface HomeProjection {
  readonly projectId: string;
  readonly collectedAt: string;
  readonly needsYou: readonly HomeEntry[];
  readonly inProgress: readonly HomeEntry[];
  readonly readyForReview: readonly HomeEntry[];
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export type ProfileConnectorState = 'Unconfigured' | 'Healthy' | 'Degraded' | 'Revoked' | 'Unreachable';

export type ProfileConnectorKind = 'Ticket' | 'Git' | 'Deployment' | 'Engine';

/**
 * The optional external-execution target, as settings reports it.
 *
 * `configured` is carried rather than inferred from `url`, so "this project has no T3
 * deployment" is a state a page can render rather than something it deduces from a null — and
 * so an absent value is never mistaken for a failed read (mvp-spec L02-AC3).
 */
export interface T3LaunchSettingView {
  readonly configured: boolean;
  /** The configured base URL, or null. Never a credential (mvp-spec L02-AC2). */
  readonly url: string | null;
}

/** The repository configuration this project already has, read from its current profile (F02-AC1). */
export interface RepositorySettingView {
  readonly configured: boolean;
  readonly profileVersionId: string | null;
  readonly versionNumber: number | null;
  readonly repository: string | null;
  readonly baseBranch: string | null;
  readonly targetBranch: string | null;
  readonly ticketProvider: string | null;
  readonly deploymentProvider: string | null;
  readonly engine: string | null;
}

/**
 * One configured provider. There is no credential reference here, only its stored digest, so a
 * settings response cannot be where a credential pointer leaks (mvp-spec L02-AC2, F32-AC2).
 */
export interface ProviderSettingView {
  readonly connectorId: string;
  readonly kind: ProfileConnectorKind;
  readonly provider: string;
  readonly resourceScope: string;
  readonly credentialReferenceDigest: string;
  readonly state: ProfileConnectorState;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
}

/** Everything one project's settings currently hold (mvp-spec 3). */
export interface ProjectSettingsView {
  readonly projectId: string;
  readonly t3: T3LaunchSettingView;
  readonly repository: RepositorySettingView;
  readonly providers: readonly ProviderSettingView[];
  /** When these settings were last written, or null when they never were. */
  readonly updatedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Project profile: the source of configured verification check names           */
/* -------------------------------------------------------------------------- */

/**
 * One immutable profile version, as `GET /api/profiles/:projectId` returns it.
 *
 * Declared for one reason and no other: `content.policy.requiredChecks` is the only place the
 * configured check *names* can be read from in this tree. Stage 1 requires an automated
 * criterion's `verificationCheckId` to be one of them, and `routes/settings.ts` does not carry
 * them, so a page that offers free text there would bind a criterion to a check nobody runs
 * (F23-AC1, F24-AC3).
 */
export interface ProfileVersionView {
  readonly profileVersionId: string;
  readonly projectId: string;
  readonly versionNumber: number;
  readonly supersedesVersionId: string | null;
  readonly content: {
    readonly references: {
      readonly repository: string;
      readonly ticketProvider: string;
      readonly ticketTeamKey: string | null;
      readonly baseBranch: string;
      readonly targetBranch: string;
      readonly deploymentProvider: string;
      readonly engine: string;
      readonly previewComponents: readonly { readonly component: string; readonly environment: string }[];
    };
    readonly policy: {
      readonly requiredChecks: readonly string[];
      /** Always `ManualAuthorizationOnly`: a profile may not grant delivery (mvp-spec F03-AC5). */
      readonly deliveryBehavior: 'ManualAuthorizationOnly';
      readonly maxFixPasses: number;
      readonly workspaceIsolation: 'WorktreeAndDataDirectory';
      readonly capabilityVersion: number;
    };
    readonly recipe: string;
    readonly environment: {
      readonly runtime: string;
      readonly ports: readonly number[];
      readonly secretReferences: readonly string[];
    };
  };
  readonly contentFingerprint: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}