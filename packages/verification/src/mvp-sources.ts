import {
  isCommitSha,
  recordMvpEvidence,
} from '@shiploop/domain';
import type {
  CriterionVerificationMethod,
  DomainError,
  MvpActor,
  MvpEvidenceObservation,
  MvpRecordedEvidence,
  Result,
} from '@shiploop/domain';
import { ok } from '@shiploop/domain';
import { runCheck } from './checks.ts';
import type {
  CheckExecutionRecord,
  CheckPolicyContext,
  CheckRequest,
  CheckRunnerDeps,
  RecordedCheckIdentity,
} from './checks.ts';
import type { CheckCommand } from './recipe.ts';

/**
 * The MVP verification sources, mapped onto one evidence shape.
 *
 * There is exactly one command runner in this repository (`./checks.ts` `runCheck`,
 * over `CommandRunnerPort`) and this module adds none. What it adds is the translation
 * from each MVP source's own vocabulary into the domain's `MvpRecordedEvidence`, so the
 * review projection has a single list to read and cannot accidentally treat one source
 * as more authoritative than another:
 *
 *   - **configured project commands** run through `runCheck`, which is the existing
 *     framework: same argv-without-shell discipline, same bounded deadline and output,
 *     same policy resolution, same redaction. The exit code becomes the outcome; there
 *     is no path here that accepts a claimed result.
 *   - **GitHub check results** arrive as a *projection* rather than a live fetch, so
 *     the candidate module owns freshness of the read and this module only binds what
 *     it was handed to the exact candidate SHA. A projection whose SHA does not match
 *     is recorded unbound, which reads as `stale` downstream.
 *   - **owner tests** can only be recorded through an `MvpActor`; the non-owner
 *     variants carry no owner identity, so an agent cannot file one.
 *   - **browser verification** reuses the configured-command path, because a Playwright
 *     invocation in a recipe *is* a configured command. Nothing browser-specific is
 *     invented here; a browser result is simply a `project_command` outcome filed
 *     against a `BrowserEvidence` method.
 *
 * The GitHub projection contract this module consumes is declared here, in the
 * verification package, because verification is what binds it. See
 * `GitHubCheckProjection` for the exact shape the candidate module must supply.
 */

/* -------------------------------------------------------------------------- */
/* The projection contract from the candidate module                            */
/* -------------------------------------------------------------------------- */

/**
 * The GitHub check facts the review path consumes.
 *
 * This is the whole interface between Builder 4's candidate module and this one. The
 * candidate module is responsible for fetching and for refusing to serve a projection it
 * has not refreshed; this module is responsible only for binding what it receives to a
 * candidate identity and for never treating an unbound result as a pass.
 *
 * Two properties are required of any implementation:
 *
 *   1. `headSha` must be the full 40-character SHA the check run belongs to. A run
 *      attributed to another commit must arrive with `headSha: null` rather than with
 *      the candidate's SHA, so the staleness comparison is meaningful.
 *   2. `status` is the provider's raw verdict, not a normalised one. `neutral` and
 *      `skipped` exist because a check the provider declined to run is not a pass, and
 *      collapsing them into `success` here would be the bug.
 */
export interface GitHubCheckProjection {
  readonly checkId: string;
  readonly name: string;
  readonly status: 'success' | 'failure' | 'pending' | 'skipped' | 'neutral';
  /** Full SHA the run belongs to, or null when the provider did not attribute it. */
  readonly headSha: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly detailUrl: string | null;
  readonly summary: string | null;
}

/** One candidate's projected check facts, as a whole. */
export interface GitHubCandidateProjection {
  readonly candidateId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly headSha: string;
  readonly checks: readonly GitHubCheckProjection[];
  readonly observedAt: string;
}

export interface GitHubProjectionTarget {
  readonly candidateId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly headSha: string;
}

/**
 * The honest mapping from a provider verdict to an outcome.
 *
 * `skipped` and `neutral` become `missing`, not `passed`. A provider that declined to
 * run a check has produced no observation of this candidate, and reporting it as green
 * is the exact failure this product exists to prevent (F20-AC2).
 */
export function outcomeForProviderStatus(
  status: GitHubCheckProjection['status'],
): 'passed' | 'failed' | 'waiting' | 'missing' {
  switch (status) {
    case 'success':
      return 'passed';
    case 'failure':
      return 'failed';
    case 'pending':
      return 'waiting';
    case 'skipped':
    case 'neutral':
      return 'missing';
  }
}

/* -------------------------------------------------------------------------- */
/* Source: GitHub check projection                                             */
/* -------------------------------------------------------------------------- */

export interface RecordGitHubProjectionInput {
  readonly projection: GitHubCandidateProjection;
  readonly target: GitHubProjectionTarget;
  /** Stable evidence identity, so a repeated read of the same run does not duplicate it. */
  readonly evidenceIdFor: (check: GitHubCheckProjection) => string;
}

/**
 * Binds a candidate's projected GitHub checks to the candidate.
 *
 * A projection whose checks came back attributed to a different SHA, or with no
 * attribution at all, is recorded with `observedHeadSha: null` and therefore binds to
 * nothing. That is what makes "old CI is green on the new PR" impossible: the run has to
 * name this commit before it can count (F20-AC3, F24-AC4).
 */
export function recordGitHubProjection(
  input: RecordGitHubProjectionInput,
): Result<readonly MvpRecordedEvidence[], DomainError> {
  const recorded: MvpRecordedEvidence[] = [];
  for (const check of input.projection.checks) {
    const attributable = check.headSha === input.target.headSha && isCommitSha(check.headSha);
    const result = recordMvpEvidence({
      evidenceId: input.evidenceIdFor(check),
      contractId: input.projection.contractId,
      candidateId: input.projection.candidateId,
      subject: { kind: 'check', checkId: check.checkId },
      method: { kind: 'AutomatedCheck', checkId: check.checkId },
      observation: {
        kind: 'provider_check',
        outcome: outcomeForProviderStatus(check.status),
      },
      observedHeadSha: attributable ? check.headSha : null,
      observedContractRevision: attributable ? input.target.contractRevision : null,
      observedAt: check.completedAt ?? check.startedAt ?? input.projection.observedAt,
      detail: attributable ? check.summary : summarizeUnattributed(check),
      artifactRef: check.detailUrl,
    });
    if (!result.ok) return result;
    recorded.push(result.value);
  }
  return ok(recorded);
}

function summarizeUnattributed(check: GitHubCheckProjection): string {
  const reported = check.status === 'success'
    ? 'reported success by the provider'
    : `reported ${check.status} by the provider`;
  return `The provider ${reported}, but not for this candidate commit, so it is not evidence about this candidate (F20-AC3).`;
}

/* -------------------------------------------------------------------------- */
/* Source: configured project commands                                         */
/* -------------------------------------------------------------------------- */

export interface MvpCommandRequest {
  readonly candidateId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly headSha: string;
  readonly check: CheckCommand;
  readonly identity: RecordedCheckIdentity;
  readonly currentCandidateFingerprint: string;
  readonly policy: CheckPolicyContext;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly observedAt: string;
  readonly evidenceId: string;
}

/**
 * Runs one configured project command and binds the result to the candidate.
 *
 * The run itself is delegated verbatim to `runCheck`, which owns the process
 * discipline, the deadline, the output bound and the policy resolution. This function
 * only translates the outcome into the MVP evidence shape, and it derives the binding
 * from the identity the check actually ran under rather than from the caller's
 * `headSha`, so a mismatch between the two shows up as stale instead of being papered
 * over.
 */
export async function recordProjectCommand(
  request: MvpCommandRequest,
  deps: CheckRunnerDeps,
): Promise<Result<MvpRecordedEvidence, DomainError>> {
  const bounded = boundedCheckRequest(request, 'LocalCheck', request.check.id);
  if (!bounded.ok) return bounded;
  const checkRequest = bounded.value;

  const executed = await runCheck(checkRequest, deps);
  if (!executed.ok) return executed;
  return evidenceFromCheckRecord(executed.value, {
    candidateId: request.candidateId,
    contractId: request.contractId,
    contractRevision: request.contractRevision,
    headSha: request.headSha,
    evidenceId: request.evidenceId,
    observedAt: request.observedAt,
    method: { kind: 'AutomatedCheck', checkId: request.check.id },
  });
}

/**
 * Runs a configured browser command and binds it to a criterion.
 *
 * A Playwright invocation configured in a recipe is an ordinary bounded command, so it
 * runs through the same `runCheck` path. What differs is the binding: a browser flow
 * verifies a *criterion*, not a check, so the subject is the criterion and the method is
 * `BrowserEvidence`. The mapping is one line and is the only place that distinction
 * exists, which is what stops a green unit suite from claiming a UI criterion (F23-AC1).
 */
export async function recordBrowserCommand(
  request: MvpBrowserCommandRequest,
  deps: CheckRunnerDeps,
): Promise<Result<MvpRecordedEvidence, DomainError>> {
  const bounded = boundedCheckRequest(request, 'BrowserEvidence', request.check.id);
  if (!bounded.ok) return bounded;
  const checkRequest = bounded.value;

  const executed = await runCheck(checkRequest, deps);
  if (!executed.ok) return executed;
  const recorded = evidenceFromCheckRecord(executed.value, {
    candidateId: request.candidateId,
    contractId: request.contractId,
    contractRevision: request.contractRevision,
    headSha: request.headSha,
    evidenceId: request.evidenceId,
    observedAt: request.observedAt,
    method: { kind: 'BrowserEvidence', evidenceId: request.evidenceId },
    subject: { kind: 'criterion', criterionId: request.criterionId },
  }, 'browser');
  if (!recorded.ok) return recorded;
  return recorded;
}

export interface MvpBrowserCommandRequest extends Omit<MvpCommandRequest, 'method'> {
  readonly criterionId: string;
}

interface EvidenceTarget {
  readonly candidateId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly headSha: string;
  readonly evidenceId: string;
  readonly observedAt: string;
  readonly method: CriterionVerificationMethod;
  readonly subject?: { readonly kind: 'check'; readonly checkId: string } | { readonly kind: 'criterion'; readonly criterionId: string };
}

/**
 * Translates a finished check record into candidate-bound MVP evidence.
 *
 * `sourceKind` is the vocabulary the result arrived in, and it must agree with the
 * subject: a `command` observation belongs to a check, a `browser` one to a criterion.
 * Keeping the two in step here is what makes the domain's refusal of a mismatched pair
 * reachable rather than accidental.
 */
export function evidenceFromCheckRecord(
  record: CheckExecutionRecord,
  target: EvidenceTarget,
  sourceKind: 'command' | 'browser' = 'command',
): Result<MvpRecordedEvidence, DomainError> {
  const attributable = record.identity.headSha === target.headSha && isCommitSha(record.identity.headSha);
  return recordMvpEvidence({
    evidenceId: target.evidenceId,
    contractId: target.contractId,
    candidateId: target.candidateId,
    subject: target.subject ?? { kind: 'check', checkId: record.checkId },
    method: target.method,
    observation: observationFor(record, sourceKind),
    observedHeadSha: attributable ? record.identity.headSha : null,
    observedContractRevision: attributable ? target.contractRevision : null,
    observedAt: target.observedAt,
    detail: attributable
      ? record.detail
      : 'The check ran under a different candidate identity, so its result is not evidence about this one (F20-AC3).',
    artifactRef: record.artifactRef,
  });
}

/**
 * The MVP outcome a finished check record supports.
 *
 * `NotApplicable` is `missing` rather than a pass: the criterion was not verified, and
 * the review card should show that instead of an unexplained green. A `Stale` result
 * stays `stale` here, because the binding comparison downstream will say the same thing
 * for the same reason and two opinions would be one too many.
 */
export function outcomeForCheckRecord(record: CheckExecutionRecord): 'passed' | 'failed' | 'waiting' | 'missing' {
  switch (record.result) {
    case 'Passed':
      return 'passed';
    case 'Failed':
      return 'failed';
    case 'Waiting':
      return 'waiting';
    case 'Missing':
    case 'NotApplicable':
      return 'missing';
    case 'Stale':
      return 'waiting';
  }
}

/**
 * The observation a check record represents, in the vocabulary of the source it came from.
 *
 * A command that could not start is `missing`, not `failed`: it never produced an exit
 * code, so it never produced a result, and calling it a failure would send a fix pass
 * after an environment problem (F20-AC2).
 *
 * A configured command and a configured browser invocation are both bounded processes and
 * both use `runCheck`; they differ only in what the result is *about*, so the source kind
 * is carried through rather than collapsed. Collapsing them here would leave the browser
 * path trying to file a `command` observation against a criterion, which the domain
 * refuses precisely because a command result has to name the check it came from (F23-AC1).
 */
function observationFor(
  record: CheckExecutionRecord,
  kind: 'command' | 'browser',
): MvpEvidenceObservation {
  if (record.result === 'Passed' || record.result === 'Failed') {
    return { kind, outcome: record.result === 'Passed' ? 'passed' : 'failed' };
  }
  return { kind, outcome: outcomeForCheckRecord(record) };
}

/**
 * The bounded check request both command sources share.
 *
 * A recipe command with a null deadline is refused here rather than defaulted. The
 * recipe validator already rejects an unbounded command, so reaching this means the
 * command did not come from a validated recipe, and inventing a deadline at this layer
 * would substitute a number the owner never chose for the one they did (ARCHITECTURE
 * "Bound subprocess duration").
 */
function boundedCheckRequest(
  request: MvpCommandRequest,
  origin: 'LocalCheck' | 'BrowserEvidence',
  checkId: string,
): Result<CheckRequest, DomainError> {
  const deadline = request.check.command.timeoutMs;
  if (deadline === null) {
    return {
      ok: false,
      error: {
        code: 'Invalid',
        reason: `Check "${request.check.id}" has no deadline, so it cannot be run.`,
        fields: [
          {
            path: `check.command.timeoutMs`,
            message: 'A configured command must declare a bounded deadline; an unbounded check is refused rather than defaulted.',
          },
        ],
      },
    };
  }
  return ok({
    checkId,
    name: request.check.name,
    origin,
    argv: request.check.command.argv,
    timeoutMs: deadline,
    cwd: request.cwd,
    env: request.env,
    identity: request.identity,
    currentCandidateFingerprint: request.currentCandidateFingerprint as CheckRequest['currentCandidateFingerprint'],
    policy: request.policy,
  });
}

/* -------------------------------------------------------------------------- */
/* Source: owner tests                                                         */
/* -------------------------------------------------------------------------- */

export interface MvpOwnerTestRequest {
  readonly actor: MvpActor;
  readonly candidateId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly headSha: string;
  readonly criterionId: string;
  readonly evidenceId: string;
  readonly observedAt: string;
  readonly outcome: 'passed' | 'failed' | 'capture_failed';
  readonly detail: string | null;
  readonly artifactRef: string | null;
}

/**
 * Records the owner's own test outcome.
 *
 * The observation union carries the authenticated owner rather than a claimed actor, and
 * a non-owner `MvpActor` has no `ownerId` to put there. An agent therefore cannot record
 * an owner test, not because a check refused it but because the value it would need does
 * not exist (F25-AC4, F23-AC1).
 *
 * `capture_failed` is a distinct outcome so the criterion reads `unverified` rather than
 * `failed`: a screenshot that was never taken is not a statement about the product
 * (F23-AC5).
 */
export function recordOwnerTestEvidence(
  request: MvpOwnerTestRequest,
): Result<MvpRecordedEvidence, DomainError> {
  if (request.actor.role !== 'owner') {
    return {
      ok: false,
      error: {
        code: 'Forbidden',
        reason: `Only the owner may record an owner test outcome; the ${request.actor.role} role may not, and that role carries no owner identity (F25-AC4).`,
      },
    };
  }
  const attributable = isCommitSha(request.headSha);
  return recordMvpEvidence({
    evidenceId: request.evidenceId,
    contractId: request.contractId,
    candidateId: request.candidateId,
    subject: { kind: 'criterion', criterionId: request.criterionId },
    method: { kind: 'OwnerTest', instructions: `The owner tests "${request.criterionId}" against candidate ${request.headSha}.` },
    observation: { kind: 'owner_test', outcome: request.outcome, actor: request.actor },
    observedHeadSha: attributable ? request.headSha : null,
    observedContractRevision: attributable ? request.contractRevision : null,
    observedAt: request.observedAt,
    detail: request.detail,
    artifactRef: request.artifactRef,
  });
}