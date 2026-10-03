import { err, invalid, ok } from '../result.ts';
import { redact } from '../redaction.ts';
import type { DomainError, Result } from '../result.ts';
import { isCommitSha } from '../ids.ts';
import type { CommitSha } from '../ids.ts';
import type { CriterionVerificationMethod } from '../evidence.ts';
import type { MvpOwnerActor } from './actor.ts';

/**
 * Evidence binding for the minimal MVP (mvp-spec F23-AC3, F20-AC3, F24-AC4).
 *
 * Every candidate-specific automated result must say five things: the contract
 * revision it was judged against, the *full* candidate commit SHA, the criterion or
 * check it speaks for, the method that observed it, and when it was observed. This
 * module is the only place those five are assembled, so a caller cannot produce a
 * result that is missing one of them: there is no other exported constructor.
 *
 * The load-bearing rule is `appliesTo`. A binding compares as current only when the
 * contract revision *and* the 40-character SHA both match, so evidence collected for
 * SHA A can never establish anything about SHA B. That comparison is what the review
 * projection asks instead of trusting a stored "passed" flag, and it is why pushing a
 * new commit silently drops the previous candidate's readiness.
 */

/** Where an MVP observation was produced. */
export type MvpEvidenceSource = 'project_command' | 'github_check' | 'browser' | 'owner_test';

/** What was actually observed. `capture_failed` is deliberately not a behaviour failure. */
export type MvpEvidenceOutcome = 'passed' | 'failed' | 'waiting' | 'missing' | 'capture_failed';

/** The criterion or the check a piece of evidence speaks for. Exactly one. */
export type MvpEvidenceSubject =
  | { readonly kind: 'criterion'; readonly criterionId: string }
  | { readonly kind: 'check'; readonly checkId: string };

/**
 * The observation a source produced.
 *
 * No member carries a free-text verdict. A source reports what it saw in its own
 * vocabulary and this module maps it, so agent or provider prose has nowhere to be
 * read as a pass.
 */
export type MvpEvidenceObservation =
  | { readonly kind: 'command'; readonly outcome: 'passed' | 'failed' | 'waiting' | 'missing' }
  | { readonly kind: 'provider_check'; readonly outcome: 'passed' | 'failed' | 'waiting' | 'missing' }
  | { readonly kind: 'browser'; readonly outcome: 'passed' | 'failed' | 'waiting' | 'missing' }
  | {
      readonly kind: 'owner_test';
      readonly outcome: 'passed' | 'failed' | 'capture_failed';
      /** The authenticated owner who ran the test. Absent on every non-owner variant. */
      readonly actor: MvpOwnerActor;
    };

/** The five facts every candidate-specific result carries (F23-AC3). */
export interface MvpEvidenceBinding {
  readonly contractId: string;
  readonly contractRevision: number;
  readonly candidateId: string;
  /** Full 40/64 character commit SHA. An abbreviation or a branch name cannot be one. */
  readonly candidateHeadSha: CommitSha;
  readonly subject: MvpEvidenceSubject;
  readonly method: CriterionVerificationMethod;
  readonly observedAt: string;
}

/** Why a binding no longer describes the current candidate. */
export type MvpStaleReason = 'CandidateShaChanged' | 'ContractRevisionChanged' | 'Unattributed';

export interface MvpBindingMatch {
  readonly applies: boolean;
  readonly staleReasons: readonly MvpStaleReason[];
  readonly reason: string;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Whether a value is a usable ISO-8601 instant. */
export function isMvpInstant(value: string): boolean {
  return INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

function safe(text: string): string {
  return redact(text).text;
}

/**
 * Whether one binding still describes the candidate under review.
 *
 * Both comparisons are required, and both are named. Reporting them separately is
 * what lets the review card say *why* old evidence stopped counting instead of only
 * that it did.
 */
export function bindingAppliesTo(
  binding: MvpEvidenceBinding | null,
  current: { readonly contractId: string; readonly contractRevision: number; readonly candidateHeadSha: CommitSha },
): MvpBindingMatch {
  if (binding === null) {
    return {
      applies: false,
      staleReasons: ['Unattributed'],
      reason: 'The source did not attribute this observation to a full candidate commit SHA, so it proves nothing about this candidate (F23-AC3).',
    };
  }
  const staleReasons: MvpStaleReason[] = [];
  if (binding.candidateHeadSha !== current.candidateHeadSha) staleReasons.push('CandidateShaChanged');
  if (binding.contractRevision !== current.contractRevision) staleReasons.push('ContractRevisionChanged');
  if (binding.contractId !== current.contractId) staleReasons.push('ContractRevisionChanged');
  if (staleReasons.length === 0) {
    return { applies: true, staleReasons: [], reason: `Recorded against contract revision ${binding.contractRevision} at candidate ${binding.candidateHeadSha}.` };
  }
  const named = staleReasons.includes('CandidateShaChanged')
    ? `the candidate SHA is now ${current.candidateHeadSha}`
    : `the contract revision is now ${current.contractRevision}`;
  return {
    applies: false,
    staleReasons,
    reason: `This result was recorded for a different candidate: ${named} (F20-AC3, F23-AC3).`,
  };
}

/** A recorded observation, bound when the source could attribute it and unlabelled when it could not. */
export interface MvpRecordedEvidence {
  readonly evidenceId: string;
  readonly subject: MvpEvidenceSubject;
  readonly method: CriterionVerificationMethod;
  readonly source: MvpEvidenceSource;
  readonly outcome: MvpEvidenceOutcome;
  /** Null when the source could not attribute the run to a full commit SHA. */
  readonly binding: MvpEvidenceBinding | null;
  /** The raw facts, kept so a stale row can still say what it observed. */
  readonly observedHeadSha: CommitSha | null;
  readonly observedContractRevision: number | null;
  readonly observedAt: string | null;
  readonly detail: string | null;
  readonly artifactRef: string | null;
}

export interface RecordMvpEvidenceInput {
  readonly evidenceId: string;
  readonly contractId: string;
  readonly candidateId: string;
  readonly subject: MvpEvidenceSubject;
  readonly method: CriterionVerificationMethod;
  readonly observation: MvpEvidenceObservation;
  /** The full SHA the run actually belongs to; null when the source could not attribute it. */
  readonly observedHeadSha: string | null;
  readonly observedContractRevision: number | null;
  readonly observedAt: string | null;
  readonly detail: string | null;
  readonly artifactRef: string | null;
}

const SUBJECT_FOR_OBSERVATION: Readonly<Record<MvpEvidenceObservation['kind'], MvpEvidenceSubject['kind']>> = {
  command: 'check',
  provider_check: 'check',
  browser: 'criterion',
  owner_test: 'criterion',
};

function subjectKey(subject: MvpEvidenceSubject): string {
  return subject.kind === 'criterion' ? `criterion:${subject.criterionId}` : `check:${subject.checkId}`;
}

function outcomeFor(observation: MvpEvidenceObservation): MvpEvidenceOutcome {
  return observation.outcome;
}

function sourceFor(observation: MvpEvidenceObservation): MvpEvidenceSource {
  switch (observation.kind) {
    case 'command':
      return 'project_command';
    case 'provider_check':
      return 'github_check';
    case 'browser':
      return 'browser';
    case 'owner_test':
      return 'owner_test';
  }
}

/**
 * Records one observation with the five facts an MVP result must carry.
 *
 * An observation the source could not attribute to a full SHA is still recordable, but
 * it lands with `binding: null`, which every reader treats as `stale`. That is the
 * difference between "we ran a check" and "we ran a check on this candidate": only the
 * second is evidence, and the type keeps them apart.
 *
 * A skipped or never-run check is `missing`, not `passed`. A provider's `skipped` and
 * `neutral` verdicts land here too, so green-looking CI cannot claim a criterion it
 * did not observe.
 */
export function recordMvpEvidence(input: RecordMvpEvidenceInput): Result<MvpRecordedEvidence, DomainError> {
  const fields: { path: string; message: string }[] = [];
  if (input.evidenceId.trim() === '') fields.push({ path: 'evidenceId', message: 'A recorded result needs an identity.' });
  if (input.contractId.trim() === '') fields.push({ path: 'contractId', message: 'A result must name the contract revision it was judged against.' });
  if (input.candidateId.trim() === '') fields.push({ path: 'candidateId', message: 'A result must name the candidate it belongs to.' });

  const subjectId = input.subject.kind === 'criterion' ? input.subject.criterionId : input.subject.checkId;
  if (subjectId.trim() === '') {
    fields.push({
      path: input.subject.kind === 'criterion' ? 'subject.criterionId' : 'subject.checkId',
      message: 'A result must name the criterion or check it speaks for.',
    });
  }

  // Which subject a kind of observation may speak for. A check result describes a
  // check; a browser capture and an owner test describe a criterion directly. Making
  // the pairing illegal rather than merely discouraged is what stops an automated
  // result from being filed straight onto a criterion and skipping the check it came
  // from (F23-AC1).
  const expectedSubject = SUBJECT_FOR_OBSERVATION[input.observation.kind];
  if (input.subject.kind !== expectedSubject) {
    fields.push({
      path: 'subject.kind',
      message:
        expectedSubject === 'check'
          ? 'A command or provider result describes a check. Bind it to the check and let the criterion read that check\'s result (F23-AC1).'
          : 'A browser capture or an owner test describes a criterion, not a check (F23-AC1).',
    });
  }
  if (input.observedAt !== null && !isMvpInstant(input.observedAt)) {
    fields.push({ path: 'observedAt', message: 'An observation must say when it happened, as an ISO-8601 instant.' });
  }

  let observedHeadSha: CommitSha | null = null;
  if (input.observedHeadSha !== null) {
    if (!isCommitSha(input.observedHeadSha)) {
      fields.push({
        path: 'observedHeadSha',
        message: 'A candidate-bound result needs the full 40-character commit SHA. A branch name, an abbreviation or a PR number is not candidate identity.',
      });
    } else {
      observedHeadSha = input.observedHeadSha;
    }
  }

  let observedContractRevision: number | null = null;
  if (input.observedContractRevision !== null) {
    if (!Number.isInteger(input.observedContractRevision) || input.observedContractRevision < 1) {
      fields.push({ path: 'observedContractRevision', message: 'A contract revision is a positive integer.' });
    } else {
      observedContractRevision = input.observedContractRevision;
    }
  }

  const attributable = observedHeadSha !== null && observedContractRevision !== null && input.observedAt !== null;
  if (observedHeadSha !== null && !attributable) {
    fields.push({
      path: 'observedAt',
      message: 'A candidate-bound result must say when it was observed; an undated result cannot be shown as current.',
    });
  }

  if (fields.length > 0) {
    return err(invalid('This observation cannot be recorded as candidate evidence.', fields));
  }

  const binding: MvpEvidenceBinding | null = attributable
    ? {
        contractId: input.contractId,
        contractRevision: observedContractRevision as number,
        candidateId: input.candidateId,
        candidateHeadSha: observedHeadSha as CommitSha,
        subject: input.subject,
        method: input.method,
        observedAt: input.observedAt as string,
      }
    : null;

  return ok({
    evidenceId: input.evidenceId,
    subject: input.subject,
    method: input.method,
    source: sourceFor(input.observation),
    outcome: outcomeFor(input.observation),
    binding,
    observedHeadSha,
    observedContractRevision,
    observedAt: input.observedAt === null ? null : safe(input.observedAt),
    detail: input.detail === null ? null : safe(input.detail),
    artifactRef: input.artifactRef === null ? null : safe(input.artifactRef),
  });
}

/**
 * Whether this result says anything about the candidate currently under review.
 *
 * `applies` alone is the honest answer; `currentOutcome` is the outcome *only* when the
 * binding holds, and is `stale` otherwise, so a caller that forgets to check `applies`
 * still cannot read an old pass as a current one.
 */
export interface MvpEvidenceVerdict {
  readonly evidence: MvpRecordedEvidence;
  readonly subjectKey: string;
  readonly match: MvpBindingMatch;
  readonly currentOutcome: MvpEvidenceOutcome | 'stale';
}

export function assessMvpEvidence(
  evidence: MvpRecordedEvidence,
  current: { readonly contractId: string; readonly contractRevision: number; readonly candidateHeadSha: CommitSha },
): MvpEvidenceVerdict {
  const match = bindingAppliesTo(evidence.binding, current);
  return {
    evidence,
    subjectKey: subjectKey(evidence.subject),
    match,
    currentOutcome: match.applies ? evidence.outcome : 'stale',
  };
}