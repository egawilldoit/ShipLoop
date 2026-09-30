import type {
  CheckResult,
  CriterionEvidence,
  CriterionStatus,
  Fingerprint,
  OperationId,
  ReadinessAssessment,
  Result,
  ScopeCriterion,
} from '@shiploop/domain';
import type {
  AdapterContext,
  AdapterIdentity,
  ArtifactReference,
  ExecutionWorkspace,
  VerificationEnvironment,
} from './index.ts';

export type CheckKind = 'Command' | 'Browser' | 'HttpApi' | 'FileAssertion';

/** A credential reference carried into a check, never a credential value (F03-AC3). */
export type CheckEnvironmentEntry =
  | { readonly kind: 'Literal'; readonly name: string; readonly value: string }
  | { readonly kind: 'SecretRef'; readonly name: string; readonly secretRef: string };

/**
 * A configured check.
 *
 * `command` is an argv array rather than a shell string so the adapter cannot be
 * talked into interpreting operator text, and `required` comes from the project
 * profile, never from the agent (F20-AC5).
 */
export interface ConfiguredCheck {
  readonly checkId: string;
  readonly name: string;
  readonly kind: CheckKind;
  readonly command: readonly string[];
  readonly required: boolean;
  readonly environmentEntries: readonly CheckEnvironmentEntry[];
  readonly timeoutMs: number;
}

/** Bounded resource limits. Output and duration are caps, not targets (N07, F18-AC3). */
export interface ExecutionBounds {
  readonly wallClockMs: number;
  readonly outputBytes: number;
  readonly retryBudget: number;
  readonly networkAttempts: number;
}

/**
 * How an execution ended, separate from the recorded check result.
 *
 * `MalformedOutput` and `OutputTruncated` must never be paired with a `Passed`
 * result: a check whose outcome could not be read has not passed (F15-AC2
 * principle applied to checks, F20-AC2).
 */
export type CheckCompletion =
  | { readonly kind: 'Concluded'; readonly result: CheckResult }
  | { readonly kind: 'TimedOut'; readonly detail: string }
  | { readonly kind: 'OutputTruncated'; readonly detail: string }
  | { readonly kind: 'MalformedOutput'; readonly detail: string }
  | { readonly kind: 'NotStarted'; readonly detail: string }
  | { readonly kind: 'NotApplicable'; readonly approvedByPolicy: true; readonly detail: string };

export interface CheckExecutionRequest {
  readonly operationId: OperationId;
  readonly workspace: ExecutionWorkspace;
  readonly check: ConfiguredCheck;
  readonly bounds: ExecutionBounds;
  /** Bound by the controller, because only it knows the candidate being verified. */
  readonly candidateFingerprint: Fingerprint;
}

export interface CheckExecutionRecord {
  readonly checkId: string;
  readonly name: string;
  readonly kind: CheckKind;
  readonly required: boolean;
  readonly candidateFingerprint: Fingerprint;
  readonly completion: CheckCompletion;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  /** Truncated or retained output, already sanitized before it becomes an artifact. */
  readonly artifacts: readonly ArtifactReference[];
  /** Human-readable detail that contains no secret values. */
  readonly detail: string | null;
}

export interface PreflightRequest {
  readonly operationId: OperationId;
  readonly workspace: ExecutionWorkspace;
  readonly recipeVersionId: string;
  /** Recipe steps to verify, each expected to produce an observable exit result (F04-AC2). */
  readonly probes: readonly PreflightProbe[];
}

export interface PreflightProbe {
  readonly probeId: string;
  readonly description: string;
  readonly command: readonly string[];
  readonly timeoutMs: number;
}

export interface PreflightReport {
  readonly assessment: ReadinessAssessment;
  readonly recipeVersionId: string;
  readonly environmentFingerprint: Fingerprint;
  readonly artifacts: readonly ArtifactReference[];
}

/** A recorded observation that can satisfy a criterion. */
export type CriterionObservation =
  | { readonly kind: 'Check'; readonly checkId: string; readonly completion: CheckCompletion }
  | { readonly kind: 'BrowserFlow'; readonly flowId: string; readonly outcome: BrowserOutcome }
  | { readonly kind: 'ApiExchange'; readonly exchangeId: string; readonly outcome: ApiExchangeOutcome }
  | { readonly kind: 'OwnerTest'; readonly instructions: string; readonly status: CriterionStatus }
  | { readonly kind: 'Untested'; readonly reason: string };

export interface MapCriteriaRequest {
  readonly operationId: OperationId;
  readonly criteria: readonly ScopeCriterion[];
  readonly observations: readonly CriterionObservation[];
  readonly candidateFingerprint: Fingerprint;
  readonly scopeFingerprint: Fingerprint;
  readonly observedAt: string;
}

export type BrowserStep =
  | { readonly kind: 'Navigate'; readonly url: string }
  | { readonly kind: 'Fill'; readonly field: string; readonly value: string }
  | { readonly kind: 'Click'; readonly role: string; readonly name: string }
  | { readonly kind: 'WaitFor'; readonly selector: string; readonly timeoutMs: number };

/**
 * What a browser flow must prove.
 *
 * `NotSignInPage` exists because a protected sign-in page satisfies almost every
 * naive "did the page load" assertion and is not application verification
 * (F22-AC3).
 */
export type BrowserExpectation =
  | { readonly kind: 'VisibleText'; readonly text: string }
  | { readonly kind: 'ElementPresent'; readonly selector: string }
  | { readonly kind: 'ElementAbsent'; readonly selector: string }
  | { readonly kind: 'NotSignInPage' };

export interface BrowserFlowSpec {
  readonly flowId: string;
  readonly baseUrl: string;
  readonly environment: VerificationEnvironment;
  readonly steps: readonly BrowserStep[];
  readonly expectation: BrowserExpectation;
  readonly timeoutMs: number;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** A header value is either literal test text or a reference to stored test access (F03-AC3). */
export type ApiHeader =
  | { readonly kind: 'Literal'; readonly name: string; readonly value: string }
  | { readonly kind: 'SecretRef'; readonly name: string; readonly secretRef: string };

export type ApiStep =
  | {
      readonly kind: 'Request';
      readonly method: HttpMethod;
      readonly path: string;
      readonly headers: readonly ApiHeader[];
      readonly body: string | null;
      readonly timeoutMs: number;
    }
  | { readonly kind: 'ExpectStatus'; readonly status: number }
  | { readonly kind: 'ExpectBodyContains'; readonly fragment: string }
  | { readonly kind: 'ExpectBodyJsonEquals'; readonly canonicalJson: string }
  | { readonly kind: 'ExpectHeader'; readonly name: string };

export interface ApiExchangeSpec {
  readonly exchangeId: string;
  readonly baseUrl: string;
  readonly environment: VerificationEnvironment;
  readonly steps: readonly ApiStep[];
}

export type BrowserOutcome =
  | { readonly kind: 'ExpectationMet'; readonly expectation: BrowserExpectation; readonly detail: string }
  | { readonly kind: 'BlockedBySignIn'; readonly observedAt: string; readonly detail: string }
  | { readonly kind: 'FailedAtStep'; readonly stepIndex: number; readonly detail: string }
  | { readonly kind: 'Inconclusive'; readonly reason: string };

export interface BrowserEvidence {
  readonly kind: 'Browser';
  readonly flowId: string;
  readonly baseUrl: string;
  readonly environment: VerificationEnvironment;
  readonly outcome: BrowserOutcome;
  readonly observedAt: string;
  /** Screenshots, traces and console logs, all sanitized before capture retention. */
  readonly artifacts: readonly ArtifactReference[];
}

export type ApiStepOutcome =
  | { readonly kind: 'StatusMatched'; readonly status: number }
  | { readonly kind: 'BodyMatched'; readonly status: number }
  | { readonly kind: 'StatusMismatch'; readonly expected: number; readonly observed: number }
  | { readonly kind: 'BodyMismatch'; readonly detail: string }
  | { readonly kind: 'ConnectionFailed'; readonly detail: string };

export type ApiExchangeOutcome =
  | { readonly kind: 'ExpectationsMet'; readonly steps: readonly ApiStepOutcome[]; readonly detail: string }
  | { readonly kind: 'FailedAtStep'; readonly stepIndex: number; readonly outcome: ApiStepOutcome }
  | { readonly kind: 'Inconclusive'; readonly reason: string };

export interface ApiEvidence {
  readonly kind: 'Api';
  readonly exchangeId: string;
  readonly baseUrl: string;
  readonly environment: VerificationEnvironment;
  readonly outcome: ApiExchangeOutcome;
  readonly observedAt: string;
  /** Request/response transcript with credential headers removed. */
  readonly artifacts: readonly ArtifactReference[];
}

export type CollectEvidenceRequest =
  | {
      readonly kind: 'Browser';
      readonly operationId: OperationId;
      readonly workspace: ExecutionWorkspace;
      readonly flow: BrowserFlowSpec;
      readonly criterionIds: readonly string[];
    }
  | {
      readonly kind: 'Api';
      readonly operationId: OperationId;
      readonly workspace: ExecutionWorkspace;
      readonly exchange: ApiExchangeSpec;
      readonly criterionIds: readonly string[];
    };

/** Artifact-specific evidence: a browser flow and an API exchange are not interchangeable. */
export type EvidenceBundle =
  | { readonly kind: 'Browser'; readonly evidence: BrowserEvidence; readonly criterionIds: readonly string[] }
  | { readonly kind: 'Api'; readonly evidence: ApiEvidence; readonly criterionIds: readonly string[] };

/**
 * Verification contract.
 *
 * Runs configured checks under explicit time and output bounds, records an
 * observation rather than an opinion, and produces artifact-specific evidence
 * for web and API work (mvp-spec 7 "Verification"). It declares no provider
 * capabilities in v0.1: `CapabilityKind` has no verification members, and the
 * adapter must not claim capability it does not have. When provider-backed
 * verification is added, the domain kinds come first.
 */
export interface VerificationAdapter extends AdapterIdentity {
  readonly kind: 'Verification';
  runPreflight(
    context: AdapterContext,
    request: PreflightRequest,
  ): Promise<Result<PreflightReport>>;
  runCheck(
    context: AdapterContext,
    request: CheckExecutionRequest,
  ): Promise<Result<CheckExecutionRecord>>;
  mapCriteria(
    context: AdapterContext,
    request: MapCriteriaRequest,
  ): Promise<Result<readonly CriterionEvidence[]>>;
  collectEvidence(
    context: AdapterContext,
    request: CollectEvidenceRequest,
  ): Promise<Result<EvidenceBundle>>;
}
