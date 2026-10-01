import type { CapabilityKind } from '../capability.ts';
import type { CommitSha, IdeaId } from '../ids.ts';
import { isCommitSha } from '../ids.ts';
import type { DomainError, Result } from '../result.ts';
import { err, ok } from '../result.ts';
import { isPrivilegedDelivery } from '../policy/capability-grant.ts';
import type { Brief, BriefProposal, BriefSections } from './brief.ts';
import { applyProposal, assessObservability, bindProposalToRequest } from './brief.ts';

/**
 * Clarification (F07-AC2, F07-AC3, F07-AC4, F07-AC5).
 *
 * Clarification is a conversation with the owner about one request. Four rules
 * are enforced here, and each exists because its absence produces a specific,
 * known failure:
 *
 *   - only material ambiguity earns a question. A request that already answers
 *     the question must yield nothing, because an interview the owner has already
 *     sat through is the "mandatory interview" the specification forbids
 *     (F07-AC2);
 *   - a correction is appended, never applied in place. The raw request and every
 *     prior brief version stay byte-identical and readable, so the owner can see
 *     what they said and what changed in response (F07-AC3);
 *   - a claim about the code carries the revision it was inspected at and the
 *     evidence, and anything unavailable is labelled `unknown`. "I don't know" is
 *     a representable answer, because a confident guess about code is worse than
 *     no answer (F07-AC4);
 *   - the capability profile is read-only and holds no mutating capability at all,
 *     so asking a question cannot change code, publish a ticket or deploy
 *     (F07-AC5).
 */

/**
 * Capabilities that change something outside the clarifying process.
 *
 * A read-only capability is derived by excluding this list from the provider
 * vocabulary, so a newly declared capability has to be classified deliberately
 * before it can appear in a read-only profile (F07-AC5).
 */
export const MUTATING_CAPABILITIES = [
  'Ticket:PublishIssue',
  'Ticket:UpdateManagedProgress',
  'Ticket:RequestTransition',
  'Git:PushBranch',
  'Git:CreateDraft',
  'Git:UpdateDraft',
  'Git:MergeWithPrecondition',
  'Deployment:Execute',
  'Engine:StartScoped',
  'Engine:StopGraceful',
  'Engine:ResumeSession',
] as const;

/** Any capability that is not in `MUTATING_CAPABILITIES` and not privileged delivery. */
export type ReadOnlyCapability = Exclude<CapabilityKind, (typeof MUTATING_CAPABILITIES)[number]>;

/** What clarification reads, and nothing more. */
export const CLARIFICATION_CAPABILITIES: readonly ReadOnlyCapability[] = Object.freeze([
  'Ticket:ReadScope',
  'Git:ReadRepository',
  'Git:ReadChecks',
  'Deployment:ReadIdentity',
] as const);

/**
 * Whether a capability changes external or local state.
 *
 * Delivery privileges are recognised through the policy boundary rather than a
 * second list here, so a newly privileged capability is caught without anyone
 * remembering to add it (mvp-spec 3, F07-AC5).
 */
export function isMutatingCapability(kind: CapabilityKind): boolean {
  return (MUTATING_CAPABILITIES as readonly string[]).includes(kind) || isPrivilegedDelivery(kind);
}

export type ClarificationForbiddenSideEffect =
  | 'ChangeApplicationCode'
  | 'PublishTicket'
  | 'Deploy'
  | 'ConsumeCodingRun';

/**
 * The capability profile clarification runs under, as data (F07-AC5).
 *
 * The four flags are literal `false` and the capability list is narrowed to
 * `ReadOnlyCapability`, so the profile has nowhere to record a mutating
 * capability even if a caller tries.
 */
export interface ReadOnlyCapabilityProfile {
  readonly name: 'Clarification';
  readonly capabilities: readonly ReadOnlyCapability[];
  readonly mayChangeApplicationCode: false;
  readonly mayPublishTickets: false;
  readonly mayDeploy: false;
  readonly mayStartCodingRun: false;
  readonly forbiddenSideEffects: readonly ClarificationForbiddenSideEffect[];
}

export const readOnlyCapabilityProfile: ReadOnlyCapabilityProfile = Object.freeze({
  name: 'Clarification',
  capabilities: CLARIFICATION_CAPABILITIES,
  mayChangeApplicationCode: false,
  mayPublishTickets: false,
  mayDeploy: false,
  mayStartCodingRun: false,
  forbiddenSideEffects: Object.freeze([
    'ChangeApplicationCode',
    'PublishTicket',
    'Deploy',
    'ConsumeCodingRun',
  ] as const),
});

export type AmbiguityKind =
  | 'UnspecifiedSubject'
  | 'ConflictingStatement'
  | 'MissingAcceptanceThreshold'
  | 'UnstatedScopeBoundary'
  | 'UnresolvedDependency';

export type AmbiguityImpact = 'ChangesBehaviour' | 'ChangesAcceptance' | 'Cosmetic';

/**
 * A candidate ambiguity in a request.
 *
 * `readings` are the distinct things the request could mean, and `answeredBy`
 * holds the request text that already settles some of them. Both are required so
 * "this is ambiguous" is a claim with a shape, rather than a string a model can
 * assert to justify an interview (F07-AC2).
 */
export interface Ambiguity {
  readonly kind: AmbiguityKind;
  readonly topic: string;
  readonly readings: readonly string[];
  readonly answeredBy: readonly string[];
  readonly impact: AmbiguityImpact;
  /** The request text that shows the ambiguity exists. */
  readonly evidence: string;
}

export type QuestionRejection =
  | 'AlreadyAnswered'
  | 'SingleReading'
  | 'CosmeticOnly'
  | 'NoEvidence'
  | 'NoTopic';

export type MaterialityVerdict =
  | { readonly material: true; readonly openReadings: readonly string[] }
  | { readonly material: false; readonly rejection: QuestionRejection; readonly explanation: string };

function significantWords(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/**
 * The readings the request has not already settled.
 *
 * A reading counts as settled when every significant word of it appears in a
 * statement the owner already made, which is what distinguishes "the request
 * never says" from "the request already says it" (F07-AC2).
 */
function openReadings(ambiguity: Ambiguity): readonly string[] {
  const answers = ambiguity.answeredBy.map(significantWords);
  return ambiguity.readings.filter((reading) => {
    const words = [...significantWords(reading)];
    if (words.length === 0) return false;
    return !answers.some((answer) => words.every((word) => answer.has(word)));
  });
}

/**
 * Decides whether an ambiguity is worth the owner's time.
 *
 * A question is material only when two distinct readings remain open and the
 * answer changes behaviour or acceptance. A cosmetic ambiguity is not asked
 * about, and an ambiguity the request has already answered is refused outright
 * (F07-AC2).
 */
export function assessMateriality(ambiguity: Ambiguity): MaterialityVerdict {
  if (ambiguity.topic.trim().length === 0) {
    return { material: false, rejection: 'NoTopic', explanation: 'An ambiguity must name what it is about.' };
  }
  if (ambiguity.evidence.trim().length === 0) {
    return {
      material: false,
      rejection: 'NoEvidence',
      explanation: 'An ambiguity must quote the request text that shows it exists.',
    };
  }
  if (ambiguity.impact === 'Cosmetic') {
    return {
      material: false,
      rejection: 'CosmeticOnly',
      explanation: `The ambiguity affects ${ambiguity.topic} cosmetically, so an answer would not change the work.`,
    };
  }

  const readings = ambiguity.readings.filter((reading) => reading.trim().length > 0);
  if (readings.length < 2) {
    return {
      material: false,
      rejection: 'SingleReading',
      explanation: `The request admits ${readings.length === 0 ? 'no' : 'only one'} reading of ${ambiguity.topic}, so there is nothing to ask.`,
    };
  }

  const open = openReadings({ ...ambiguity, readings });
  if (open.length < 2) {
    return {
      material: false,
      rejection: 'AlreadyAnswered',
      explanation: `The request already answers what could be asked about ${ambiguity.topic}.`,
    };
  }

  return { material: true, openReadings: open };
}

/** Boolean form of `assessMateriality`, for callers that only need the gate. */
export function isMaterial(ambiguity: Ambiguity): boolean {
  return assessMateriality(ambiguity).material;
}

export interface ClarifyingQuestion {
  readonly id: string;
  readonly topic: string;
  readonly prompt: string;
  /** The open readings this question separates. Empty when the question asks for a threshold. */
  readonly readings: readonly string[];
  readonly whyMaterial: string;
  readonly origin: 'Ambiguity' | 'UnobservableCriterion';
}

export interface RejectedQuestion {
  readonly topic: string;
  readonly rejection: QuestionRejection;
  readonly explanation: string;
}

/**
 * One round of questions.
 *
 * Rejected candidates are reported rather than dropped, so the owner can see
 * that a question was considered and why it was not asked (F07-AC2).
 */
export interface ClarificationRound {
  readonly questions: readonly ClarifyingQuestion[];
  readonly rejected: readonly RejectedQuestion[];
}

/**
 * What to generate questions about.
 *
 * The sections are the *proposed* ones, not a validated brief. Clarification runs
 * before `applyProposal` accepts the structure, which is the only point at which a
 * vague acceptance criterion can still be caught and asked about; a brief that had
 * passed validation could not contain one (F07-AC2).
 */
export interface ClarificationInput {
  readonly briefId: string;
  readonly ideaId: IdeaId;
  readonly sections: BriefSections;
  readonly ambiguities: readonly Ambiguity[];
}

/**
 * Produces the questions worth asking about one proposed brief.
 *
 * Two sources, both material by construction: ambiguities the caller enumerated
 * that survive `isMaterial`, and acceptance criteria that are not observable,
 * because an unobservable criterion is a material ambiguity about how the outcome
 * will be judged. A complete request produces none (F07-AC2).
 */
export function generateClarifyingQuestions(input: ClarificationInput): ClarificationRound {
  const questions: ClarifyingQuestion[] = [];
  const rejected: RejectedQuestion[] = [];

  for (const ambiguity of input.ambiguities) {
    const verdict = assessMateriality(ambiguity);
    if (!verdict.material) {
      rejected.push({ topic: ambiguity.topic, rejection: verdict.rejection, explanation: verdict.explanation });
      continue;
    }
    if (questions.some((question) => question.topic === ambiguity.topic)) continue;
    questions.push({
      id: `q-${input.briefId}-ambiguity-${questions.length + 1}`,
      topic: ambiguity.topic,
      prompt: `About ${ambiguity.topic}: which is intended, ${verdict.openReadings.join(' or ')}?`,
      readings: verdict.openReadings,
      whyMaterial: `Each reading changes what is built: ${ambiguity.evidence}`,
      origin: 'Ambiguity',
    });
  }

  for (const criterion of Array.isArray(input.sections.acceptanceCriteria) ? input.sections.acceptanceCriteria : []) {
    const verdict = assessObservability(criterion.text);
    if (verdict.observable) continue;
    const topic = `acceptanceCriteria.${criterion.id}`;
    if (questions.some((question) => question.topic === topic)) continue;
    questions.push({
      id: `q-${input.briefId}-${criterion.id}`,
      topic,
      prompt: `"${criterion.text}" cannot be checked. What quantity or behaviour shows it is met?`,
      readings: [],
      whyMaterial: 'An unobservable criterion leaves the agent without a target to build against.',
      origin: 'UnobservableCriterion',
    });
  }

  return { questions, rejected };
}

export type ConversationTurn =
  | { readonly kind: 'RawRequest'; readonly at: string; readonly text: string }
  | { readonly kind: 'Question'; readonly at: string; readonly questionId: string; readonly prompt: string }
  | { readonly kind: 'Answer'; readonly at: string; readonly questionId: string; readonly text: string }
  | {
      readonly kind: 'Correction';
      readonly at: string;
      readonly correctionId: string;
      readonly text: string;
      readonly briefVersion: number;
    };

/**
 * The clarification record.
 *
 * Turns are append-only: a correction adds a turn and never edits or removes one,
 * so the owner's original words and every later decision stay readable in order
 * (F07-AC3).
 */
export interface ClarificationConversation {
  readonly conversationId: string;
  readonly ideaId: IdeaId;
  readonly turns: readonly ConversationTurn[];
}

/** The raw request as first captured, or null when the conversation has none. */
export function rawRequestOf(conversation: ClarificationConversation): string | null {
  for (const turn of conversation.turns) {
    if (turn.kind === 'RawRequest') return turn.text;
  }
  return null;
}

export interface OwnerCorrection {
  readonly correctionId: string;
  readonly text: string;
  readonly at: string;
  /** The complete corrected brief, proposed as the next version. */
  readonly proposal: BriefProposal;
}

/**
 * What one correction produced.
 *
 * `priorBrief` is returned unchanged rather than replaced, and the new version
 * records only what it supersedes, so the previous state of the brief remains
 * inspectable after any number of corrections (F07-AC3).
 */
export interface CorrectionApplication {
  readonly conversation: ClarificationConversation;
  readonly brief: Brief;
  readonly priorBrief: Brief;
  /** Criterion ids the correction dropped, named so the change is reviewable. */
  readonly withdrawnCriteria: readonly string[];
}

/**
 * Appends an owner correction and the brief version it produces (F07-AC3).
 *
 * The correction goes through the same validation as every other proposal, so an
 * edit cannot introduce an unobservable criterion, and it is matched against the
 * current version: a correction built on a stale brief is a Conflict rather than
 * a silent overwrite of someone else's reasoning.
 */
export function applyCorrection(
  conversation: ClarificationConversation,
  brief: Brief,
  correction: OwnerCorrection,
): Result<CorrectionApplication, DomainError> {
  if (correction.text.trim().length === 0) {
    return err<DomainError>({
      code: 'Invalid',
      reason: 'A correction must record the owner\'s own words.',
      fields: [{ path: 'correction.text', message: 'The correction text is required.' }],
    });
  }
  if (correction.proposal.ideaId !== conversation.ideaId || correction.proposal.ideaId !== brief.ideaId) {
    return err<DomainError>({
      code: 'Conflict',
      reason: 'The correction was produced for a different idea.',
      expected: conversation.ideaId,
      actual: correction.proposal.ideaId,
    });
  }
  if (correction.proposal.basedOnBriefVersion !== brief.version) {
    return err<DomainError>({
      code: 'Conflict',
      reason: 'The correction was made against a different brief version.',
      expected: String(brief.version),
      actual: String(correction.proposal.basedOnBriefVersion),
    });
  }

  const validated = applyProposal(correction.proposal);
  if (!validated.ok) return validated;

  const rawRequest = rawRequestOf(conversation);
  if (rawRequest === null) {
    return err<DomainError>({
      code: 'Blocked',
      reason: 'The conversation has no raw request turn, so the corrected brief cannot be traced to it.',
      prerequisites: [
        {
          name: 'rawRequestTurn',
          detail: 'A clarification conversation records the request text it is clarifying.',
          remedy: 'Start the conversation with the raw request turn before applying corrections.',
        },
      ],
    });
  }

  const next = bindProposalToRequest({
    briefId: brief.briefId,
    ideaId: brief.ideaId,
    rawRequest,
    proposal: validated.value,
  });
  if (!next.ok) return next;

  const priorIds = new Set(brief.sections.acceptanceCriteria.map((criterion) => criterion.id));
  const nextIds = new Set(next.value.sections.acceptanceCriteria.map((criterion) => criterion.id));

  return ok<CorrectionApplication>({
    conversation: Object.freeze({
      ...conversation,
      turns: Object.freeze([
        ...conversation.turns,
        Object.freeze({
          kind: 'Correction',
          at: correction.at,
          correctionId: correction.correctionId,
          text: correction.text,
          briefVersion: next.value.version,
        }),
      ]),
    }),
    brief: next.value,
    priorBrief: brief,
    withdrawnCriteria: Object.freeze([...priorIds].filter((id) => !nextIds.has(id))),
  });
}

export type ClaimEvidenceKind = 'CodeLocation' | 'CommandOutput' | 'CheckResult';

export interface ClaimEvidence {
  readonly kind: ClaimEvidenceKind;
  readonly reference: string;
  readonly observedAt: string;
}

export interface CodeClaim {
  readonly claimId: string;
  readonly statement: string;
  readonly subject: string;
  /** The revision claimed to have been inspected. Unvalidated: may be a branch name. */
  readonly inspectedRevision: string | null;
  readonly evidence: readonly ClaimEvidence[];
}

/** The context a claim could not supply. */
export type ClaimGroundingUnknown = 'Revision' | 'Evidence';

/**
 * A claim about the code, either grounded or explicitly unknown.
 *
 * `state: 'Unknown'` is a first-class answer. `unknowns` names what was missing
 * and `revision` is null, so a claim that guessed has no shape to travel in
 * (F07-AC4).
 */
export interface GroundedClaim {
  readonly claimId: string;
  readonly state: 'Grounded' | 'Unknown';
  readonly statement: string;
  readonly subject: string;
  /** The full commit SHA, or null when the inspected revision was unavailable. */
  readonly revision: CommitSha | null;
  readonly evidence: readonly ClaimEvidence[];
  readonly unknowns: readonly ClaimGroundingUnknown[];
  readonly reason: string | null;
}

/**
 * Grounds a code claim in the revision it was inspected at and its evidence
 * (F07-AC4).
 *
 * Anything short of a full commit SHA is treated as no revision, because a branch
 * name or an abbreviation does not identify the code that was read and would make
 * the claim unfalsifiable later. Missing evidence has the same effect. Neither
 * case throws and neither is silently filled in: the claim is labelled Unknown
 * with the reason, which is what lets the owner ask again instead of trusting a
 * guess.
 */
export function codeGroundedClaim(claim: CodeClaim): GroundedClaim {
  const evidence = (Array.isArray(claim.evidence) ? claim.evidence : []).filter(
    (entry) => typeof entry.reference === 'string' && entry.reference.trim().length > 0,
  );
  const revision =
    typeof claim.inspectedRevision === 'string' && isCommitSha(claim.inspectedRevision)
      ? claim.inspectedRevision
      : null;

  const unknowns: ClaimGroundingUnknown[] = [];
  if (revision === null) unknowns.push('Revision');
  if (evidence.length === 0) unknowns.push('Evidence');

  if (unknowns.length === 0) {
    return {
      claimId: claim.claimId,
      state: 'Grounded',
      statement: claim.statement,
      subject: claim.subject,
      revision,
      evidence,
      unknowns: [],
      reason: null,
    };
  }

  return {
    claimId: claim.claimId,
    state: 'Unknown',
    statement: claim.statement,
    subject: claim.subject,
    revision,
    evidence,
    unknowns,
    reason:
      unknowns.length === 2
        ? 'The claim names no inspectable repository revision and no evidence.'
        : `The claim is missing ${unknowns.join(' and ').toLowerCase()}.`,
  };
}