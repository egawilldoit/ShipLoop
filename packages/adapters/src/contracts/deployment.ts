import type { CapabilityKind, CommitSha, OperationId, ProviderId, Result } from '@shiploop/domain';
import type {
  AdapterContext,
  AdapterIdentity,
  ArtifactReference,
  VerificationEnvironment,
} from './index.ts';

export type DeploymentCapability = Extract<CapabilityKind, `Deployment:${string}`>;

/** What an access probe actually observed at the destination. */
export type AccessObservation =
  | { readonly kind: 'PublicResponse'; readonly httpStatus: number }
  | { readonly kind: 'RedirectedToSignIn'; readonly location: string }
  | { readonly kind: 'AuthenticatedProbe'; readonly httpStatus: number; readonly accountLabel: string }
  | { readonly kind: 'AccessDenied'; readonly httpStatus: number }
  | { readonly kind: 'ConnectionFailed'; readonly detail: string };

/** Evidence that the destination served the application rather than a gate (F22-AC3). */
export interface ApplicationProof {
  readonly method: 'ApiProbe' | 'BrowserFlow' | 'AssetFetch';
  readonly observation: AccessObservation;
  readonly evidence: readonly ArtifactReference[];
  readonly detail: string;
}

/**
 * Deployment state as five distinct outcomes.
 *
 * `Protected` and `Usable` are separate variants, and only `Usable` can carry an
 * `ApplicationProof`. A sign-in page is therefore a typed state and cannot be
 * consumed as successful application verification (F22-AC3).
 */
export type DeploymentAvailability =
  | { readonly kind: 'Missing'; readonly detail: string; readonly since: string | null }
  | { readonly kind: 'Building'; readonly startedAt: string; readonly progressNote: string | null; readonly observedAt: string }
  | { readonly kind: 'Failed'; readonly providerMessage: string; readonly detail: string }
  | { readonly kind: 'Protected'; readonly access: AccessObservation; readonly detail: string }
  | { readonly kind: 'Usable'; readonly verifiedAt: string; readonly proof: ApplicationProof };

/** Whether the deployment read still matches the candidate it was found for (F22-AC2, F22-AC5). */
export type DeploymentMatch =
  | { readonly kind: 'Matches'; readonly commitSha: CommitSha; readonly environment: string }
  | { readonly kind: 'MismatchedCommit'; readonly expected: CommitSha; readonly observed: CommitSha }
  | { readonly kind: 'MismatchedEnvironment'; readonly expected: string; readonly observed: string }
  | { readonly kind: 'Unchecked'; readonly detail: string };

/** A provider deployment identity, read live and matched against the expected candidate. */
export interface DeploymentIdentityRead {
  readonly deploymentId: ProviderId;
  readonly provider: string;
  readonly component: string;
  readonly environment: string;
  readonly repositoryFullName: string;
  readonly commitSha: CommitSha;
  readonly url: string;
  readonly availability: DeploymentAvailability;
  readonly access: AccessObservation;
  readonly match: DeploymentMatch;
  readonly providerRevision: string | null;
  readonly observedAt: string;
}

export interface DiscoverDeploymentRequest {
  readonly repositoryFullName: string;
  /** Full commit, never a branch alias: an alias does not establish tested identity (F22-AC2). */
  readonly commitSha: CommitSha;
  readonly component: string;
  readonly environment: string;
}

/** A deployment that was close enough to find but cannot stand in for the request. */
export interface IneligibleDeployment {
  readonly deploymentId: ProviderId;
  readonly commitSha: CommitSha;
  readonly url: string;
  readonly ineligibility:
    | 'DifferentCommit'
    | 'DifferentEnvironment'
    | 'DifferentComponent'
    | 'BranchAliasOnly';
  readonly detail: string;
}

export type DeploymentDiscovery =
  | { readonly kind: 'Found'; readonly deployment: DeploymentIdentityRead }
  | { readonly kind: 'NotFound'; readonly detail: string; readonly ineligible: readonly IneligibleDeployment[] };

export interface ReadDeploymentIdentityRequest {
  readonly deploymentId: ProviderId;
  /** Null when the caller has no candidate to compare, which reads as `Unchecked`. */
  readonly expectedCommitSha: CommitSha | null;
  readonly expectedEnvironment: string;
}

/**
 * The delivery actions a provider may perform on an authorization.
 *
 * `ObserveAuthorizedPipeline` is separate from the redeploy variants because a
 * merge-auto-deploy profile authorizes observing a pipeline the merge triggered,
 * not triggering a second one (F28-AC1). Only `RedeployWithMigrationReversal`
 * may reverse state, and it must carry a stated reversal (F28-AC5).
 */
export type PermittedDeliveryAction =
  | {
      readonly kind: 'ObserveAuthorizedPipeline';
      readonly deploymentId: ProviderId;
      readonly pipelineReference: string;
      readonly authorizationId: string;
    }
  | {
      readonly kind: 'RedeployCode';
      readonly sourceDeploymentId: ProviderId;
      readonly component: string;
      readonly environment: string;
      readonly authorizationId: string;
    }
  | {
      readonly kind: 'RedeployWithMigrationReversal';
      readonly sourceDeploymentId: ProviderId;
      readonly component: string;
      readonly environment: string;
      readonly authorizationId: string;
      readonly reversalStatement: string;
      readonly ownerConfirmedReversal: true;
    };

export type DeploymentExecutionOutcome =
  | { readonly kind: 'Triggered'; readonly deploymentId: ProviderId; readonly providerOperationReference: string; readonly acceptedAt: string }
  | { readonly kind: 'Completed'; readonly deployment: DeploymentIdentityRead }
  | { readonly kind: 'Observed'; readonly deployment: DeploymentIdentityRead; readonly detail: string }
  | { readonly kind: 'NoActionRequired'; readonly detail: string; readonly evidence: readonly ArtifactReference[] };

export interface SmokeProbeSpec {
  readonly probeId: string;
  readonly component: string;
  readonly url: string;
  readonly expectStatus: number;
  readonly expectBodyContains: string | null;
  readonly environment: VerificationEnvironment;
}

export type LiveSmokeRequirement =
  | { readonly kind: 'None'; readonly reason: string }
  | { readonly kind: 'Required'; readonly probes: readonly SmokeProbeSpec[] };

export type SmokeProbeOutcome =
  | { readonly kind: 'StatusMatched'; readonly httpStatus: number }
  | { readonly kind: 'BodyMatched'; readonly httpStatus: number }
  | { readonly kind: 'SignInIntercepted'; readonly location: string }
  | { readonly kind: 'StatusMismatch'; readonly expected: number; readonly observed: number }
  | { readonly kind: 'ConnectionFailed'; readonly detail: string };

export interface SmokeObservation {
  readonly probeId: string;
  readonly url: string;
  readonly observedAt: string;
  readonly outcome: SmokeProbeOutcome;
  readonly evidence: readonly ArtifactReference[];
}

export type SmokeResult =
  | { readonly kind: 'Passed'; readonly probes: readonly SmokeObservation[] }
  | { readonly kind: 'Failed'; readonly probes: readonly SmokeObservation[]; readonly detail: string }
  | { readonly kind: 'NotRun'; readonly reason: string }
  | { readonly kind: 'Unknown'; readonly detail: string };

export interface VerifiedComponentIdentity {
  readonly component: string;
  readonly deploymentId: ProviderId;
  readonly commitSha: CommitSha;
  readonly url: string;
  readonly environment: string;
}

export type ComponentFailureKind =
  | 'IdentityMismatch'
  | 'EnvironmentMismatch'
  | 'SmokeFailed'
  | 'Unavailable';

export interface ComponentFailure {
  readonly component: string;
  readonly kind: ComponentFailureKind;
  readonly detail: string;
}

export interface VerifyDestinationRequest {
  readonly operationId: OperationId;
  readonly destination: string;
  readonly expectedRepositoryFullName: string;
  readonly expectedCommitSha: CommitSha;
  readonly expectedEnvironment: string;
  readonly requiredComponents: readonly string[];
  readonly liveSmoke: LiveSmokeRequirement;
}

/**
 * Post-delivery confirmation.
 *
 * `Confirmed` requires every required component identity plus a passed live
 * smoke result. Anything short of that is `PartiallyConfirmed` with
 * component-level evidence or `Unverifiable`, so a partial component failure or a
 * deployment that succeeded while its smoke check failed cannot set Released
 * (F28-AC2, F28-AC3).
 */
export type DestinationVerification =
  | {
      readonly kind: 'Confirmed';
      readonly components: readonly VerifiedComponentIdentity[];
      readonly smoke: SmokeResult;
      readonly verifiedAt: string;
    }
  | {
      readonly kind: 'PartiallyConfirmed';
      readonly components: readonly VerifiedComponentIdentity[];
      readonly failures: readonly ComponentFailure[];
      readonly smoke: SmokeResult;
    }
  | { readonly kind: 'Unverifiable'; readonly detail: string; readonly smoke: SmokeResult };

/**
 * Deployment provider contract.
 *
 * Discovery is keyed by repository plus full commit plus component plus
 * environment, and every read states the availability it observed. An action the
 * provider does not offer is returned as `Unavailable`, never as a completed
 * execution (F22-AC1, F22-AC3, L03-AC3).
 */
export interface DeploymentAdapter extends AdapterIdentity {
  readonly kind: 'Deployment';
  discoverDeployment(
    context: AdapterContext,
    request: DiscoverDeploymentRequest,
  ): Promise<Result<DeploymentDiscovery>>;
  readIdentity(
    context: AdapterContext,
    request: ReadDeploymentIdentityRequest,
  ): Promise<Result<DeploymentIdentityRead>>;
  executeDeliveryAction(
    context: AdapterContext,
    action: PermittedDeliveryAction,
  ): Promise<Result<DeploymentExecutionOutcome>>;
  verifyDestination(
    context: AdapterContext,
    request: VerifyDestinationRequest,
  ): Promise<Result<DestinationVerification>>;
}
