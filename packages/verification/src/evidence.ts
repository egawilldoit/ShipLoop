import { candidateFingerprint, err, invalid, ok, redactDeep } from '@shiploop/domain';
import type {
  CandidateIdentity,
  CommitSha,
  CriterionEvidence,
  CriterionStatus,
  CriterionVerificationMethod,
  DomainError,
  EvidenceId,
  Fingerprint,
  Result,
} from '@shiploop/domain';
import type { CheckExecutionRecord } from './checks.ts';
import { effectiveCheckResult } from './checks.ts';

/**
 * Criterion-linked evidence packs (F23).
 *
 * A pack answers one question per acceptance criterion: what was actually
 * observed, where, and against which build. A green check run is an observation
 * of that check and of nothing else, so a criterion with no linked observation is
 * Untested or Missing and can never be reported as satisfied (F23-AC1).
 */

/** Where an observation was made. Local is a label, not a weaker kind of Preview (F23-AC4). */
export type EvidenceEnvironment = 'Local' | 'Preview' | 'LiveSmoke' | 'ProviderCi';

/**
 * The outcome of trying to observe a behaviour.
 *
 * CaptureFailed is deliberately its own kind: a screenshot that was never taken
 * says nothing about the flow, and reporting it as a behaviour failure, or worse
 * as a pass, misleads in opposite directions (F23-AC5).
 */
export type BehaviorObservation = 'BehaviorConfirmed' | 'BehaviorFailed' | 'CaptureFailed';

export interface EvidenceArtifact {
  readonly kind: 'Screenshot' | 'ApiExchange' | 'CheckOutput';
  /** Artifact store name only. Content lives in the store, never in the record (F23-AC2). */
  readonly name: string;
  readonly capturedAt: string;
}

export interface SanitizedApiExchange {
  readonly request: string;
  readonly result: string;
}

/** The preview a deployed criterion must be observed against (F22-AC1, F23-AC4). */
export interface EligiblePreview {
  readonly component: string;
  readonly deploymentId: string;
  readonly environment: string;
  readonly candidateFingerprint: Fingerprint;
}

export interface EvidenceRecord {
  readonly evidenceId: EvidenceId | null;
  readonly criterionId: string;
  readonly criterionText: string;
  readonly method: CriterionVerificationMethod;
  readonly status: CriterionStatus;
  readonly observation: BehaviorObservation | null;
  readonly environment: EvidenceEnvironment | null;
  readonly candidateFingerprint: Fingerprint;
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  readonly scopeFingerprint: Fingerprint;
  readonly component: string | null;
  readonly deploymentId: string | null;
  readonly observedAt: string | null;
  readonly artifacts: readonly EvidenceArtifact[];
  readonly apiExchange: SanitizedApiExchange | null;
  readonly detail: string | null;
}

export interface CriterionRequirement {
  readonly criterionId: string;
  readonly text: string;
  /** The assigned verification method. Assigning a method is a scope decision, not evidence (F23-AC1). */
  readonly method: CriterionVerificationMethod;
  /** True when only deployed behaviour can satisfy the criterion (F23-AC4). */
  readonly requiresDeployedObservation: boolean;
}

export interface ObservationInput {
  readonly criterionId: string;
  readonly evidenceId: EvidenceId;
  readonly observation: BehaviorObservation;
  readonly environment: EvidenceEnvironment;
  readonly capturedAt: string;
  readonly component: string | null;
  readonly deploymentId: string | null;
  readonly artifacts: readonly EvidenceArtifact[];
  readonly apiExchange: SanitizedApiExchange | null;
  readonly detail: string | null;
}

export interface EvidencePackInput {
  readonly bundleId: string;
  /** Traces the job through engine, Git, deployment and owner decisions (N06-AC1). */
  readonly correlationId: string;
  readonly identity: CandidateIdentity;
  readonly eligiblePreview: EligiblePreview | null;
  readonly requirements: readonly CriterionRequirement[];
  readonly observations: readonly ObservationInput[];
}

export interface EvidenceBundle {
  readonly bundleId: string;
  readonly correlationId: string;
  readonly candidateFingerprint: Fingerprint;
  readonly records: readonly EvidenceRecord[];
  /** Projection of the records into the domain shape acceptance readiness reads (F23-AC1). */
  readonly criteria: readonly CriterionEvidence[];
  readonly unverifiedCriterionIds: readonly string[];
}

/**
 * What a stored check result can support as evidence.
 *
 * Passed confirms, Failed disproves, and everything else supports no observation
 * at all: a Waiting, Missing or Stale check is silence, and silence cannot be
 * linked to a criterion (F23-AC1).
 */
export function observationForCheck(
  record: CheckExecutionRecord,
  currentCandidateFingerprint: Fingerprint,
  currentPolicyFingerprint: Fingerprint,
): BehaviorObservation | null {
  const result = effectiveCheckResult(record, currentCandidateFingerprint, currentPolicyFingerprint);
  if (result === 'Passed') return 'BehaviorConfirmed';
  if (result === 'Failed') return 'BehaviorFailed';
  return null;
}

function requiresMatchingEvidenceId(method: CriterionVerificationMethod, evidenceId: string): boolean {
  if (method.kind === 'BrowserEvidence' || method.kind === 'ApiEvidence') {
    return method.evidenceId !== evidenceId;
  }
  return false;
}

function hasArtifact(artifacts: readonly EvidenceArtifact[], kind: EvidenceArtifact['kind']): boolean {
  return artifacts.some((artifact) => artifact.kind === kind && artifact.name !== '');
}

interface DeployedGate {
  readonly status: CriterionStatus;
  readonly reason: string;
}

/**
 * Whether a deployed criterion may be satisfied by this observation.
 *
 * Local and provider output is labelled for what it is, and a preview built from
 * another candidate or another deployment is Stale rather than a substitute for
 * the eligible one (F23-AC4, F22-AC2).
 */
function deployedGateFailure(
  requirement: CriterionRequirement,
  observation: ObservationInput,
  eligiblePreview: EligiblePreview | null,
  currentCandidateFingerprint: Fingerprint,
): DeployedGate | null {
  if (!requirement.requiresDeployedObservation) return null;
  if (observation.environment === 'Local') {
    return {
      status: 'Missing',
      reason: 'Local evidence is labelled local and cannot satisfy a criterion that requires deployed behaviour (F23-AC4).',
    };
  }
  if (observation.environment === 'ProviderCi') {
    return {
      status: 'Missing',
      reason: 'Provider CI output is not an observation of deployed behaviour (F23-AC4).',
    };
  }
  if (observation.environment === 'LiveSmoke') {
    return { status: 'Stale', reason: 'The observation is from the live deployment, not the eligible preview (F22-AC2).' };
  }
  if (eligiblePreview === null) {
    return { status: 'Missing', reason: 'No eligible preview deployment is identified for this candidate (F23-AC4).' };
  }
  if (eligiblePreview.candidateFingerprint !== currentCandidateFingerprint) {
    return { status: 'Stale', reason: 'The eligible preview was built from a different candidate (F22-AC1).' };
  }
  if (observation.deploymentId !== eligiblePreview.deploymentId) {
    return {
      status: 'Stale',
      reason: `Observed deployment ${observation.deploymentId ?? 'unknown'} is not the eligible preview ${eligiblePreview.deploymentId} (F22-AC2).`,
    };
  }
  return null;
}

function statusWithoutObservation(method: CriterionVerificationMethod): CriterionStatus {
  if (method.kind === 'Untested') return 'Untested';
  if (method.kind === 'OwnerTest') return 'PendingOwnerTest';
  return 'Missing';
}

function statusForObservation(
  requirement: CriterionRequirement,
  observation: ObservationInput,
  eligiblePreview: EligiblePreview | null,
  currentCandidateFingerprint: Fingerprint,
): { readonly status: CriterionStatus; readonly reason: string | null } {
  if (observation.observation === 'CaptureFailed') {
    return {
      status: 'Missing',
      reason: 'The capture itself failed, so no behaviour was observed. This is a capture failure, not a behaviour failure (F23-AC5).',
    };
  }
  if (observation.observation === 'BehaviorFailed') {
    return { status: 'Failed', reason: observation.detail };
  }
  const gate = deployedGateFailure(requirement, observation, eligiblePreview, currentCandidateFingerprint);
  if (gate !== null) return { status: gate.status, reason: gate.reason };
  if (requirement.method.kind === 'BrowserEvidence' && !hasArtifact(observation.artifacts, 'Screenshot')) {
    return { status: 'Missing', reason: 'No screenshot reference was retained for this UI flow (F23-AC2).' };
  }
  if (requirement.method.kind === 'ApiEvidence' && observation.apiExchange === null && !hasArtifact(observation.artifacts, 'ApiExchange')) {
    return { status: 'Missing', reason: 'No sanitized request/result reference was retained (F23-AC2).' };
  }
  return { status: 'Verified', reason: observation.detail };
}

/**
 * Builds the criterion-linked evidence pack for one candidate.
 *
 * Each criterion gets its assigned method and, at most, one observation's verdict.
 * Without an observation the result is Untested, Missing or PendingOwnerTest, so
 * green CI cannot stand in for a demonstration (F23-AC1). Every string in the
 * bundle is redacted as the record is built, because the pack is exported and
 * quoted into issue comments (N02-AC2).
 */
export function buildEvidencePack(input: EvidencePackInput): Result<EvidenceBundle, DomainError> {
  const fields: { path: string; message: string }[] = [];
  const bundleFingerprint = candidateFingerprint(input.identity);

  const requirementIds = new Set<string>();
  for (const requirement of input.requirements) {
    if (requirement.criterionId === '') {
      fields.push({ path: 'requirements', message: 'A criterion needs an identity.' });
      continue;
    }
    if (requirementIds.has(requirement.criterionId)) {
      fields.push({ path: `requirements.${requirement.criterionId}`, message: 'The criterion is listed more than once.' });
      continue;
    }
    requirementIds.add(requirement.criterionId);
  }
  if (input.correlationId === '') {
    fields.push({ path: 'correlationId', message: 'A pack must be traceable to its job (N06-AC1).' });
  }

  const observations = new Map<string, ObservationInput>();
  const evidenceIds = new Set<string>();
  for (const observation of input.observations) {
    if (!requirementIds.has(observation.criterionId)) {
      fields.push({ path: `observations.${observation.criterionId}`, message: 'No criterion in this scope claims this observation.' });
      continue;
    }
    if (evidenceIds.has(observation.evidenceId)) {
      fields.push({ path: `observations.${observation.evidenceId}`, message: 'The evidence identity is already used.' });
      continue;
    }
    if (observation.environment !== 'Local' && !observation.deploymentId) {
      fields.push({ path: `observations.${observation.evidenceId}.deploymentId`, message: 'A non-local observation must name the deployment it observed (F23-AC3).' });
      continue;
    }
    evidenceIds.add(observation.evidenceId);
    observations.set(observation.criterionId, observation);
  }

  if (fields.length > 0) return err(invalid('The evidence pack cannot be built from this input.', fields));

  const records: EvidenceRecord[] = [];
  for (const requirement of input.requirements) {
    const observation = observations.get(requirement.criterionId) ?? null;
    if (observation !== null && requiresMatchingEvidenceId(requirement.method, observation.evidenceId)) {
      return err(invalid(`The assigned method for "${requirement.criterionId}" does not match the observation supplied.`, [
        { path: `requirements.${requirement.criterionId}.method`, message: 'Method and observation must name the same evidence (F23-AC1).' },
      ]));
    }

    const verdict = observation === null
      ? { status: statusWithoutObservation(requirement.method), reason: null }
      : statusForObservation(requirement, observation, input.eligiblePreview, bundleFingerprint);

    records.push(redactDeep<EvidenceRecord>({
      evidenceId: observation?.evidenceId ?? null,
      criterionId: requirement.criterionId,
      criterionText: requirement.text,
      method: requirement.method,
      status: verdict.status,
      observation: observation?.observation ?? null,
      environment: observation?.environment ?? null,
      candidateFingerprint: bundleFingerprint,
      headSha: input.identity.headSha,
      baseSha: input.identity.baseSha,
      scopeFingerprint: input.identity.scopeFingerprint,
      component: observation?.component ?? null,
      deploymentId: observation?.deploymentId ?? null,
      observedAt: observation?.capturedAt ?? null,
      artifacts: observation?.artifacts ?? [],
      apiExchange: observation?.apiExchange ?? null,
      detail: verdict.reason,
    }));
  }

  const criteria: CriterionEvidence[] = records.map((record) => ({
    criterionId: record.criterionId,
    method: record.method,
    status: record.status,
    evidenceId: record.evidenceId,
    candidateFingerprint: record.candidateFingerprint,
    scopeFingerprint: record.scopeFingerprint,
    observedAt: record.observedAt,
  }));

  return ok({
    bundleId: input.bundleId,
    correlationId: input.correlationId,
    candidateFingerprint: bundleFingerprint,
    records,
    criteria,
    unverifiedCriterionIds: records.filter((record) => record.status !== 'Verified').map((record) => record.criterionId),
  });
}
