/**
 * The wire shapes the MVP owner UI sends and receives.
 *
 * Every type here is an **integration assumption**, not a description of a server that exists.
 * The MVP backend is being built in parallel from the shared domain contract, and this file is
 * the UI's half of that negotiation: it says exactly what the UI needs back and in what shape, so
 * the backend can be written to it rather than the two being reconciled by reading two diffs.
 *
 * Rules that shaped the shapes, all from the shared contract:
 *
 *   - Nothing here is imported from `@shiploop/domain`. That package re-exports modules reaching
 *     for `node:crypto`, which cannot be bundled into a browser build; the same reason
 *     `api-client.ts` declares its own wire types. The duplication is deliberate and one-sided.
 *   - `headSha` is a full 40-character commit SHA everywhere it appears. A pull request number is
 *     carried beside it, never instead of it.
 *   - No shape contains a derived status the UI is expected to reach on its own. The one status a
 *     UI must not re-derive is verification completeness, so the server states it (`verification`)
 *     and the UI only groups by it.
 *   - Optional connectors are `null`, never a placeholder object. A missing Linear configuration
 *     and an empty Linear configuration must not read alike, and a shape with a `configured`
 *     boolean invites the second reading.
 */

/** One acceptance criterion's verification method, as the shared contract names it. */
export type VerificationType = 'automated' | 'owner_test';

/** The Delivery Contract's own state. Approval is the only state that is not editable. */
export type ContractStatus = 'draft' | 'approved' | 'stale';

export const CONTRACT_STATUSES: readonly ContractStatus[] = ['draft', 'approved', 'stale'];

/** One acceptance criterion, read back exactly as the contract records it. */
export interface ContractCriterion {
  readonly id: string;
  readonly description: string;
  readonly verificationType: VerificationType;
}

/** The versioned agreement describing successful implementation. */
export interface DeliveryContract {
  readonly id: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly revision: number;
  readonly outcome: string;
  readonly scope: string;
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly ContractCriterion[];
  readonly status: ContractStatus;
  readonly approvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What the owner asked for. Carried beside a contract so the contract page can name it. */
export interface RequestRecord {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The exact implementation under review. The full SHA is mandatory and is never abbreviated. */
export interface Candidate {
  readonly id: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly repository: string;
  readonly pullRequestNumber: number | null;
  readonly pullRequestUrl: string | null;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly observedAt: string;
}

/**
 * Whether the candidate's verification is complete, as the server states it.
 *
 * `complete: false` with an empty `outstanding` list is legal and means "not finished, and the
 * server has not broken it down". The UI renders both fields rather than deriving either.
 */
export interface VerificationSummary {
  readonly complete: boolean;
  readonly outstanding: readonly string[];
}

/** An owner decision. Only these two exist in the MVP; neither is reachable without an action. */
export type OwnerDecisionKind = 'accepted' | 'changes_requested';

export interface OwnerDecision {
  readonly decisionId: string;
  readonly kind: OwnerDecisionKind;
  readonly decidedAt: string;
  readonly headSha: string;
  readonly contractRevision: number;
  readonly feedback: string | null;
}

/**
 * One row on the Home board.
 *
 * Facts only. There is deliberately no `group` field: the grouping rules are the UI's, so that
 * "which bucket does this request belong to" is one testable function rather than a value that
 * arrives pre-bucketed and is never checked against the states it claims to summarise.
 */
export interface HomeItem {
  readonly requestId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly contract: { readonly id: string; readonly revision: number; readonly status: ContractStatus } | null;
  readonly candidate: {
    readonly id: string;
    readonly headSha: string;
    readonly pullRequestNumber: number | null;
    readonly pullRequestUrl: string | null;
  } | null;
  readonly verification: VerificationSummary | null;
  readonly decision: OwnerDecision | null;
  /** One sentence naming the owner's next step, written by whoever owns the rule. */
  readonly nextAction: string;
}

export interface HomeBoard {
  readonly projectId: string | null;
  readonly collectedAt: string;
  readonly items: readonly HomeItem[];
}

/**
 * The T3 handoff packet.
 *
 * `content` is produced by the server, not assembled by this client. The packet is the artefact an
 * external coding environment is given, so its wording is a product decision that belongs beside
 * the other product decisions; a browser that generated its own packet would let the packet drift
 * from what the backend will later hand to an auditor.
 */
export interface HandoffPacket {
  readonly contractId: string;
  readonly revision: number;
  readonly generatedAt: string;
  readonly content: string;
  /**
   * The configured T3 address, or null when none is configured.
   *
   * Validated by the server before it is sent. The client does not re-validate it: an address the
   * owner saved has already been through the boundary check, and a second, weaker check in the
   * browser would only ever disagree with it.
   */
  readonly t3Url: string | null;
}

/** One check line on the review surface. `result` is the server's word, rendered not mapped. */
export interface ReviewCheck {
  readonly checkId: string;
  readonly name: string;
  readonly required: boolean;
  readonly result: string;
  readonly detail: string | null;
  readonly observedAt: string | null;
}

/** One piece of evidence, which always names the exact candidate and revision it observed. */
export interface ReviewEvidence {
  readonly evidenceId: string;
  readonly method: string;
  readonly result: string;
  readonly observedAt: string;
  readonly contractRevision: number;
  readonly candidateHeadSha: string;
}

/** One acceptance criterion and everything recorded against it for this candidate. */
export interface ReviewCriterion {
  readonly id: string;
  readonly description: string;
  readonly verificationType: VerificationType;
  readonly status: string;
  readonly detail: string | null;
  readonly evidence: ReviewEvidence | null;
  /** The criterion waits on the owner's own test rather than on any automated check. */
  readonly pendingOwnerTest: boolean;
}

/** One queue row: the identity an owner decides about, without its detail. */
export interface ReviewQueueItem {
  readonly candidateId: string;
  readonly requestId: string;
  readonly requestTitle: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly repository: string;
  readonly pullRequestNumber: number | null;
  readonly pullRequestUrl: string | null;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly observedAt: string;
  readonly verification: VerificationSummary | null;
  readonly decision: OwnerDecision | null;
  readonly staleReasons: readonly string[];
}

export interface ReviewQueue {
  readonly projectId: string | null;
  readonly collectedAt: string;
  readonly items: readonly ReviewQueueItem[];
}

/** Everything the Review surface shows for one candidate, in one read. */
export interface ReviewDetail extends ReviewQueueItem {
  readonly checks: readonly ReviewCheck[];
  readonly criteria: readonly ReviewCriterion[];
  readonly pendingOwnerTestCriterionIds: readonly string[];
}

/** A connector as the Settings surface is allowed to see it: state and remedy, never a secret. */
export interface ConnectorSetting {
  readonly configured: boolean;
  /** A reference naming where the credential lives, such as `env:REPO_TOKEN`. Never the secret. */
  readonly credentialReference: string | null;
  readonly state: 'Configured' | 'NotConfigured' | 'Error';
  readonly detail: string | null;
}

/**
 * Everything Settings owns.
 *
 * Linear and the T3 address are optional, and `null` is how "the owner chose not to configure
 * this" is expressed. GitHub is required for the journey to finish: without it there is no PR to
 * link and therefore nothing to verify, which Settings states rather than leaving to be
 * discovered at the handoff.
 */
export interface ProjectSettings {
  readonly projectId: string;
  readonly name: string;
  readonly github: {
    readonly repositoryUrl: string;
    readonly fullName: string;
    readonly baseBranch: string;
    readonly connector: ConnectorSetting;
  };
  readonly linear: {
    readonly teamKey: string;
    readonly connector: ConnectorSetting;
  } | null;
  readonly t3Url: string | null;
}

/** The editable form of `ProjectSettings`, as the Settings surface submits it. */
export interface ProjectSettingsInput {
  readonly name: string;
  readonly repositoryUrl: string;
  readonly baseBranch: string;
  readonly githubCredentialReference: string | null;
  readonly linearTeamKey: string | null;
  readonly t3Url: string | null;
}

/** One field's refusal, carrying the form path it belongs beside. */
export interface WireFieldError {
  readonly path: string;
  readonly message: string;
}