import {
  classifyCheckFailure,
  err,
  invalid,
  isBlocking,
  ok,
  redactDeep,
} from '@shiploop/domain';
import type {
  CheckOrigin,
  CheckRecord,
  CheckResult,
  CommitSha,
  DomainError,
  FailureClassification,
  Fingerprint,
  Result,
} from '@shiploop/domain';

/**
 * Check execution and honest result mapping (F20).
 *
 * The single property this module exists to guarantee: only an observation can
 * produce Passed. A configured check that never ran, a provider run still in
 * flight, a result belonging to a superseded candidate and a check the owner
 * explicitly retired are four different facts, and collapsing any of them into
 * "passed" would let an unreviewed change reach delivery on agent-authored text
 * (F20-AC2). Agent and model text has no input into the mapping at all.
 */

/**
 * Bounds a check may not exceed.
 *
 * The deadline and the retained output are capped so one wedged check cannot hold
 * a coding slot or grow a report without limit.
 */
export const CHECK_TIMEOUT_MIN_MS = 1;
export const CHECK_TIMEOUT_MAX_MS = 3_600_000;
export const MAX_CHECK_OUTPUT_BYTES = 262_144;
export const MAX_CHECK_DETAIL_CHARS = 2_000;

/**
 * A refusal no caller may override.
 *
 * The domain declares ForbiddenError but ships constructors only for the other
 * codes, so the value is built here rather than downgraded to Invalid, which
 * would suggest the request was merely malformed.
 */
function refusal(reason: string): Result<never, DomainError> {
  return err<DomainError>({ code: 'Forbidden', reason });
}

/**
 * Execution status of one spawned command.
 *
 * CouldNotStart, TimedOut and Interrupted are distinct from a nonzero exit:
 * a command that never produced an exit code never produced a result, so it is
 * Missing rather than Passed (F20-AC2).
 */
export type CommandRunStatus = 'Exited' | 'CouldNotStart' | 'TimedOut' | 'Interrupted';

export interface CommandRunOptions {
  readonly timeoutMs: number;
  readonly cwd: string;
  /**
   * Allowlisted environment for the check. This module never reads process.env,
   * so a provider credential cannot reach an offline check by accident (N02-AC2).
   */
  readonly env: Readonly<Record<string, string>>;
}

export interface CommandRunResult {
  readonly status: CommandRunStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly durationMs: number;
  /** Why the command could not start, when the status is CouldNotStart. */
  readonly detail: string | null;
}

/**
 * Injected command runner port.
 *
 * Declared structurally here rather than imported so check execution stays
 * independently mergeable from the concrete process runner that satisfies it.
 */
export type CommandRunnerPort = (
  argv: readonly string[],
  options: CommandRunOptions,
) => Promise<CommandRunResult>;

export interface OutputCaptureRequest {
  readonly checkId: string;
  readonly candidateFingerprint: Fingerprint;
  readonly output: string;
  readonly truncated: boolean;
}

export interface CapturedOutput {
  /** Artifact store name. Content stays in the store; the record keeps a name (F20-AC1). */
  readonly name: string;
  readonly byteLength: number;
}

export type OutputCapturePort = (request: OutputCaptureRequest) => Promise<CapturedOutput | null>;

export interface CheckRunnerDeps {
  readonly run: CommandRunnerPort;
  readonly captureOutput: OutputCapturePort;
  readonly now: () => string;
}

/**
 * The candidate identity a check result belongs to.
 *
 * Every dimension here participates in the candidate fingerprint, so a changed
 * head, base, scope, environment or policy yields a different fingerprint and the
 * recorded result becomes Stale instead of still reading as current (F20-AC3).
 */
export interface RecordedCheckIdentity {
  readonly candidateFingerprint: Fingerprint;
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  readonly scopeFingerprint: Fingerprint;
  readonly environmentFingerprint: Fingerprint;
  readonly policyFingerprint: Fingerprint;
}

/**
 * A recorded owner decision that a check does not apply.
 *
 * Only a profile policy can carry this. The approval names the policy revision it
 * belongs to, so it stops applying the moment the policy changes and cannot be
 * replayed by text (F20-AC2, F20-AC5).
 */
export interface NotApplicableApproval {
  readonly checkId: string;
  readonly policyFingerprint: Fingerprint;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly reason: string;
}

export interface RequiredCheckPolicy {
  readonly policyFingerprint: Fingerprint;
  readonly requiredCheckIds: readonly string[];
  readonly approvals: readonly NotApplicableApproval[];
  readonly decidedBy: string;
  readonly decidedAt: string;
}

/**
 * The owner-approved policy beside the policy under evaluation.
 *
 * The approved set is the baseline a proposed revision may extend but never
 * shrink, which is what stops a coding agent from removing the gate that would
 * have caught its own defect (F20-AC5).
 */
export interface CheckPolicyContext {
  readonly approved: RequiredCheckPolicy;
  readonly proposed: RequiredCheckPolicy;
}

export type StaleDimension = 'CandidateIdentity' | 'Policy';

export interface StalenessVerdict {
  readonly stale: boolean;
  readonly dimensions: readonly StaleDimension[];
}

/**
 * Whether a recorded result still describes the current candidate.
 *
 * The candidate fingerprint is the domain's canonical encoding of head, base,
 * scope, environment, component and deployment identity, so one comparison
 * covers all of them; the policy revision is compared separately because it is
 * also the anchor of every NotApplicable approval.
 */
export function detectStaleness(
  recorded: RecordedCheckIdentity,
  currentCandidateFingerprint: Fingerprint,
  currentPolicyFingerprint: Fingerprint,
): StalenessVerdict {
  const dimensions: StaleDimension[] = [];
  if (recorded.candidateFingerprint !== currentCandidateFingerprint) dimensions.push('CandidateIdentity');
  if (recorded.policyFingerprint !== currentPolicyFingerprint) dimensions.push('Policy');
  return { stale: dimensions.length > 0, dimensions };
}

/**
 * What was actually observed for a check.
 *
 * The union has no text member carrying a claimed result. That is the structural
 * reason a model cannot write itself a pass: there is nowhere to put the claim.
 */
export type CheckObservation =
  | { readonly kind: 'LocalExecution'; readonly status: CommandRunStatus; readonly exitCode: number | null }
  | {
      readonly kind: 'ProviderRun';
      readonly providerStatus: 'Succeeded' | 'Failed' | 'InProgress' | 'NotFound';
    }
  | { readonly kind: 'PrerequisiteAbsent' }
  | { readonly kind: 'PolicyNotApplicable' };

export interface CheckOutcomeMappingInput {
  readonly observation: CheckObservation;
  readonly identity: RecordedCheckIdentity;
  readonly currentCandidateFingerprint: Fingerprint;
  readonly currentPolicyFingerprint: Fingerprint;
  readonly notApplicableRequested: boolean;
  readonly notApplicableApproval: NotApplicableApproval | null;
}

export interface CheckOutcomeMapping {
  readonly result: CheckResult;
  readonly notApplicableApproval: NotApplicableApproval | null;
  readonly staleness: StalenessVerdict;
}

function resultForObservation(observation: CheckObservation): CheckResult {
  switch (observation.kind) {
    case 'LocalExecution':
      if (observation.status === 'Exited') {
        return observation.exitCode === 0 ? 'Passed' : observation.exitCode === null ? 'Missing' : 'Failed';
      }
      if (observation.status === 'TimedOut') return 'Failed';
      return 'Missing';
    case 'ProviderRun':
      if (observation.providerStatus === 'Succeeded') return 'Passed';
      if (observation.providerStatus === 'Failed') return 'Failed';
      if (observation.providerStatus === 'InProgress') return 'Waiting';
      return 'Missing';
    case 'PrerequisiteAbsent':
      return 'Missing';
    case 'PolicyNotApplicable':
      return 'Missing';
  }
}

/**
 * The only path from an observation to a check result.
 *
 * Pure, so the honesty guarantee is provable without spawning anything. Precedence
 * is policy, then freshness, then observation: a retired check is NotApplicable
 * whatever the candidate looks like, a result recorded against a superseded
 * candidate is Stale rather than a claim about the current one, and only a
 * current observation decides Passed or Failed.
 */
export function mapCheckOutcome(input: CheckOutcomeMappingInput): Result<CheckOutcomeMapping, DomainError> {
  const staleness = detectStaleness(input.identity, input.currentCandidateFingerprint, input.currentPolicyFingerprint);
  const fresh: StalenessVerdict = { stale: false, dimensions: [] };

  if (input.notApplicableRequested || input.observation.kind === 'PolicyNotApplicable') {
    const approval = input.notApplicableApproval;
    if (approval === null || approval.checkId === '') {
      return refusal(
        'NotApplicable requires a recorded profile policy approval; a check outcome alone cannot retire a required gate (F20-AC2, F20-AC5).',
      );
    }
    if (approval.policyFingerprint !== input.currentPolicyFingerprint) {
      return refusal(
        `The recorded NotApplicable approval for "${approval.checkId}" belongs to a superseded policy revision (F20-AC3).`,
      );
    }
    return ok({ result: 'NotApplicable', notApplicableApproval: approval, staleness: fresh });
  }

  if (staleness.stale) {
    return ok({ result: 'Stale', notApplicableApproval: null, staleness });
  }

  return ok({ result: resultForObservation(input.observation), notApplicableApproval: null, staleness });
}

/** A recorded check result enriched with the freshness and policy facts needed to re-evaluate it. */
export interface CheckExecutionRecord extends CheckRecord {
  readonly runStatus: CommandRunStatus | null;
  readonly identity: RecordedCheckIdentity;
  readonly notApplicableApproval: NotApplicableApproval | null;
  readonly staleness: StalenessVerdict;
}

export interface ResolvedRequiredChecks {
  readonly requiredCheckIds: readonly string[];
  readonly policyFingerprint: Fingerprint;
  readonly approvalsByCheckId: ReadonlyMap<string, NotApplicableApproval>;
}

/**
 * Resolves the effective required set from an approved and a proposed policy.
 *
 * A proposed revision may add required checks but never remove one, and never
 * attach a NotApplicable approval to a check the owner required. Both attempts
 * are refused rather than applied, so a proposal cannot pass its own work by
 * deleting or downgrading a gate (F20-AC5).
 */
export function resolveRequiredChecks(context: CheckPolicyContext): Result<ResolvedRequiredChecks, DomainError> {
  const approved = new Set(context.approved.requiredCheckIds);
  const proposed = new Set(context.proposed.requiredCheckIds);

  const removed = [...approved].filter((checkId) => !proposed.has(checkId));
  if (removed.length > 0) {
    return refusal(
      `The proposed policy removes owner-required checks: ${removed.join(', ')}. Required checks can only be changed by an owner policy revision (F20-AC5).`,
    );
  }

  const approvalsByCheckId = new Map<string, NotApplicableApproval>();
  for (const approval of context.proposed.approvals) {
    if (approval.policyFingerprint !== context.proposed.policyFingerprint) {
      return err(
        invalid(
          `The NotApplicable approval for "${approval.checkId}" names a different policy revision than the policy carrying it (F20-AC5).`,
          [{ path: `approvals.${approval.checkId}.policyFingerprint`, message: 'Approval and policy revisions must match.' }],
        ),
      );
    }
    if (approved.has(approval.checkId)) {
      return refusal(
        `The proposed policy marks owner-required check "${approval.checkId}" NotApplicable. An existing failure does not waive a required check (F20-AC4, F20-AC5).`,
      );
    }
    approvalsByCheckId.set(approval.checkId, approval);
  }

  return ok({
    requiredCheckIds: [...proposed],
    policyFingerprint: context.proposed.policyFingerprint,
    approvalsByCheckId,
  });
}

/**
 * The result a stored record supports right now.
 *
 * A record that no longer matches the current candidate reports Stale, which is
 * blocking, so ready-for-delivery stays closed until the check reruns (F20-AC3).
 */
export function effectiveCheckResult(
  record: CheckExecutionRecord,
  currentCandidateFingerprint: Fingerprint,
  currentPolicyFingerprint: Fingerprint,
): CheckResult {
  return detectStaleness(record.identity, currentCandidateFingerprint, currentPolicyFingerprint).stale
    ? 'Stale'
    : record.result;
}

export interface RequiredCheckOutcome {
  readonly checkId: string;
  readonly name: string;
  readonly result: CheckResult;
  readonly blocking: boolean;
}

export interface NonRequiredCheckOutcome {
  readonly checkId: string;
  readonly name: string;
  readonly result: CheckResult;
}

export interface ReadinessAssessment {
  readonly ready: boolean;
  readonly required: readonly RequiredCheckOutcome[];
  readonly nonRequired: readonly NonRequiredCheckOutcome[];
  readonly blockingReasons: readonly string[];
}

export interface ReadinessInput {
  readonly policy: CheckPolicyContext;
  readonly records: readonly CheckExecutionRecord[];
  readonly currentCandidateFingerprint: Fingerprint;
}

/**
 * Whether the current candidate may be offered for delivery.
 *
 * Only required checks gate readiness: a failing check the owner did not require
 * is reported and does not block (F20-AC2). A required check with no record at
 * all is Missing, which blocks exactly as a failure does, because an unexecuted
 * gate is not evidence of anything.
 */
export function evaluateCandidateReadiness(input: ReadinessInput): Result<ReadinessAssessment, DomainError> {
  const resolved = resolveRequiredChecks(input.policy);
  if (!resolved.ok) return resolved;

  const records = new Map(input.records.map((record) => [record.checkId, record]));
  const requiredCheckIds = new Set(resolved.value.requiredCheckIds);
  const required: RequiredCheckOutcome[] = [];
  const nonRequired: NonRequiredCheckOutcome[] = [];
  const blockingReasons: string[] = [];

  for (const checkId of resolved.value.requiredCheckIds) {
    const record = records.get(checkId);
    const result: CheckResult = record === undefined
      ? 'Missing'
      : effectiveCheckResult(record, input.currentCandidateFingerprint, resolved.value.policyFingerprint);
    const blocking = isBlocking(result, record?.notApplicableApprovedByPolicy ?? false);
    required.push({ checkId, name: record?.name ?? checkId, result, blocking });
    if (blocking) {
      blockingReasons.push(
        record === undefined
          ? `Required check "${checkId}" has no recorded result.`
          : `Required check "${record.name}" is ${result}, not Passed.`,
      );
    }
  }

  for (const record of input.records) {
    if (requiredCheckIds.has(record.checkId)) continue;
    nonRequired.push({
      checkId: record.checkId,
      name: record.name,
      result: effectiveCheckResult(record, input.currentCandidateFingerprint, resolved.value.policyFingerprint),
    });
  }

  return ok({ ready: blockingReasons.length === 0, required, nonRequired, blockingReasons });
}

/**
 * Whether a failure is change-introduced or already present on the base commit.
 *
 * Delegates to the domain function so this module holds no second opinion, and
 * records that neither attribution waives a required check (F20-AC4).
 */
export function attributeCheckFailure(input: {
  readonly failedOnCandidate: boolean;
  readonly failedOnBaseSha: boolean | null;
  readonly baseShaObserved: boolean;
}): { readonly classification: FailureClassification; readonly waivesRequiredCheck: false } {
  return { classification: classifyCheckFailure(input), waivesRequiredCheck: false };
}

export interface CheckRequest {
  readonly checkId: string;
  readonly name: string;
  readonly origin: CheckOrigin;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly identity: RecordedCheckIdentity;
  readonly currentCandidateFingerprint: Fingerprint;
  readonly policy: CheckPolicyContext;
}

function boundOutput(output: string): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(output, 'utf8') <= MAX_CHECK_OUTPUT_BYTES) return { text: output, truncated: false };
  return { text: output.slice(0, MAX_CHECK_OUTPUT_BYTES), truncated: true };
}

function statusLine(outcome: CommandRunResult | null): string {
  if (outcome === null) return 'not executed: profile policy marks this check NotApplicable';
  switch (outcome.status) {
    case 'Exited':
      return `exit ${outcome.exitCode ?? 'unknown'} in ${outcome.durationMs} ms`;
    case 'TimedOut':
      return `timed out after ${outcome.durationMs} ms`;
    case 'CouldNotStart':
      return `could not start: ${outcome.detail ?? 'no reason reported'}`;
    case 'Interrupted':
      return `interrupted after ${outcome.durationMs} ms`;
  }
}

function toCheckExecutionRecord(input: {
  readonly request: CheckRequest;
  readonly required: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: CommandRunResult | null;
  readonly artifactRef: string | null;
  readonly mapping: CheckOutcomeMapping;
}): CheckExecutionRecord {
  const outputTail = input.outcome === null ? '' : boundOutput(input.outcome.output).text;
  const detail = [statusLine(input.outcome), outputTail.trim().slice(-MAX_CHECK_DETAIL_CHARS)]
    .filter((part) => part.length > 0)
    .join('\n');

  return redactDeep<CheckExecutionRecord>({
    checkId: input.request.checkId,
    name: input.request.name,
    origin: input.request.origin,
    required: input.required,
    result: input.mapping.result,
    candidateFingerprint: input.request.identity.candidateFingerprint,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    exitCode: input.outcome?.exitCode ?? null,
    artifactRef: input.artifactRef,
    detail,
    notApplicableApprovedByPolicy: input.mapping.notApplicableApproval !== null,
    runStatus: input.outcome?.status ?? null,
    identity: input.request.identity,
    notApplicableApproval: input.mapping.notApplicableApproval,
    staleness: input.mapping.staleness,
  });
}

/**
 * Runs one configured check and records the result its observation supports.
 *
 * The command runs only when policy has not retired the check, with a validated
 * bounded deadline, and its output is written to the artifact store rather than
 * kept in the record. Every string in the returned record has passed through the
 * domain redaction, because the record is quoted into issue comments and exports
 * (N02-AC2, F23-AC2).
 */
export async function runCheck(
  request: CheckRequest,
  deps: CheckRunnerDeps,
): Promise<Result<CheckExecutionRecord, DomainError>> {
  if (request.checkId === '' || request.name === '') {
    return err(invalid('A check needs an identity and a display name.', [
      { path: 'checkId', message: 'Check identity is required.' },
      { path: 'name', message: 'Check name is required.' },
    ]));
  }
  if (request.argv.length === 0 || request.argv[0] === undefined) {
    return err(invalid(`Check "${request.checkId}" has no command.`, [
      { path: 'argv', message: 'An argument array without a shell is required.' },
    ]));
  }
  if (
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs < CHECK_TIMEOUT_MIN_MS ||
    request.timeoutMs > CHECK_TIMEOUT_MAX_MS
  ) {
    return err(invalid(`Check "${request.checkId}" has an unusable deadline.`, [
      { path: 'timeoutMs', message: `Must be an integer between ${CHECK_TIMEOUT_MIN_MS} and ${CHECK_TIMEOUT_MAX_MS}.` },
    ]));
  }

  const resolved = resolveRequiredChecks(request.policy);
  if (!resolved.ok) return resolved;

  const required = resolved.value.requiredCheckIds.includes(request.checkId);
  const approval = resolved.value.approvalsByCheckId.get(request.checkId) ?? null;
  const currentPolicyFingerprint = resolved.value.policyFingerprint;
  const startedAt = deps.now();

  const approvalMapping = approval === null
    ? null
    : mapCheckOutcome({
        observation: { kind: 'PolicyNotApplicable' },
        identity: request.identity,
        currentCandidateFingerprint: request.currentCandidateFingerprint,
        currentPolicyFingerprint,
        notApplicableRequested: true,
        notApplicableApproval: approval,
      });
  if (approvalMapping !== null && !approvalMapping.ok) return approvalMapping;

  let outcome: CommandRunResult | null = null;
  if (approval === null) {
    try {
      outcome = await deps.run(request.argv, {
        timeoutMs: request.timeoutMs,
        cwd: request.cwd,
        env: request.env,
      });
    } catch (error) {
      outcome = {
        status: 'CouldNotStart',
        exitCode: null,
        signal: null,
        output: '',
        outputTruncated: false,
        durationMs: 0,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const observation: CheckObservation = outcome === null
    ? { kind: 'PolicyNotApplicable' }
    : outcome.status === 'Exited' || outcome.status === 'TimedOut'
      ? { kind: 'LocalExecution', status: outcome.status, exitCode: outcome.exitCode }
      : { kind: 'PrerequisiteAbsent' };

  const mapping = approvalMapping ?? mapCheckOutcome({
    observation,
    identity: request.identity,
    currentCandidateFingerprint: request.currentCandidateFingerprint,
    currentPolicyFingerprint,
    notApplicableRequested: false,
    notApplicableApproval: null,
  });
  if (!mapping.ok) return mapping;

  const bounded = outcome === null ? { text: '', truncated: false } : boundOutput(outcome.output);
  const captured = outcome === null ? null : await deps.captureOutput({
    checkId: request.checkId,
    candidateFingerprint: request.identity.candidateFingerprint,
    output: bounded.text,
    truncated: bounded.truncated || outcome.outputTruncated,
  });

  return ok(toCheckExecutionRecord({
    request,
    required,
    startedAt,
    endedAt: deps.now(),
    outcome,
    artifactRef: captured?.name ?? null,
    mapping: mapping.value,
  }));
}
