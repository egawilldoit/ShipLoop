import { fingerprint } from '../fingerprint.ts';
import type { Fingerprint, IdeaId } from '../ids.ts';
import type { DomainError, Result } from '../result.ts';
import { err, invalid, ok } from '../result.ts';
import type { IdeaDraft } from './idea.ts';

/**
 * The concise brief (F07-AC1).
 *
 * The brief is the artefact the agent builds from, so it carries exactly the
 * sections the specification names and nothing else: problem, desired outcome,
 * included behaviour, excluded behaviour, assumptions, acceptance criteria and
 * unresolved questions. `BRIEF_SECTION_NAMES` is the single list, and a brief is
 * typed as a complete record of those seven, so a section cannot be quietly
 * dropped or invented.
 *
 * Three properties are structural rather than conventional:
 *
 *   - acceptance criteria are validated as observable statements, because a brief
 *     whose criteria are adjectives gives the agent nothing to build against;
 *   - a brief is versioned, so a correction appends a version and leaves the prior
 *     one readable (F07-AC3);
 *   - structured model output reaches a brief only through `applyProposal`, and a
 *     proposal cannot assert its own provenance: the raw-request fingerprint is
 *     computed from the `IdeaDraft` the domain holds, never from the proposal
 *     (F05-AC5).
 *
 * Nothing here can set product acceptance, delivery or release state. Those are
 * owner decisions on a candidate (mvp-spec 3), and `BriefProposal` has no
 * lifecycle key in which to record them even if a model emits one.
 */

export const BRIEF_SECTION_NAMES = [
  'problem',
  'desiredOutcome',
  'includedBehaviour',
  'excludedBehaviour',
  'assumptions',
  'acceptanceCriteria',
  'unresolvedQuestions',
] as const;

export type BriefSectionName = (typeof BRIEF_SECTION_NAMES)[number];

export interface AcceptanceCriterion {
  readonly id: string;
  readonly text: string;
  /** How the criterion can be observed, or null when that has not been decided yet. */
  readonly verification: string | null;
}

/**
 * The seven sections, as one complete record.
 *
 * Read-only collections: a brief is a recorded proposal, so a consumer cannot
 * edit a criterion in place and leave the record claiming something the owner
 * never saw.
 */
export interface BriefSections {
  readonly problem: string;
  readonly desiredOutcome: string;
  readonly includedBehaviour: readonly string[];
  readonly excludedBehaviour: readonly string[];
  readonly assumptions: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly unresolvedQuestions: readonly string[];
}

/** A partial brief, used by an owner correction that changes only some sections. */
export type BriefSectionPatch = { readonly [K in BriefSectionName]?: BriefSections[K] };

export type BriefAuthor = 'Owner' | 'ClarificationModel' | 'OwnerEdit';

interface BriefRecord {
  readonly briefId: string;
  /** Monotonic per brief. Version 1 is the first draft; a correction appends the next. */
  readonly version: number;
  readonly ideaId: IdeaId;
  readonly sections: BriefSections;
  readonly authoredBy: BriefAuthor;
  readonly authoredAt: string;
  /** Fingerprint of the raw request this brief was derived from (F06-AC1, F07-AC3). */
  readonly rawRequestFingerprint: Fingerprint;
  readonly supersedesVersion: number | null;
}

/**
 * A brief is either a proposal or an agreed record, never a proposal that also
 * carries an agreement.
 *
 * Splitting the union means `agreedBy` cannot exist without the state that gives
 * it meaning, so a brief cannot claim owner agreement it never received
 * (F05-AC5).
 */
export type Brief =
  | (BriefRecord & { readonly state: 'Proposed' })
  | (BriefRecord & { readonly state: 'Agreed'; readonly agreedBy: string; readonly agreedAt: string });

export type ObservabilitySignal = 'MeasuredQuantity' | 'ConcreteStateChange' | 'ExplicitArtifact';

export interface ObservabilityVerdict {
  readonly observable: boolean;
  readonly signals: readonly ObservabilitySignal[];
  /** Evaluative terms found without a measurable or concrete referent. */
  readonly unobservableTerms: readonly string[];
}

/**
 * Words that describe a quality rather than a behaviour.
 *
 * They are reported as the reason a criterion was refused, but they only
 * disqualify a criterion when nothing else in it can be observed: "checkout is
 * fast (<500ms p95)" is measurable and stays observable.
 */
const EVALUATIVE_TERMS: readonly string[] = Object.freeze([
  'better', 'clean', 'easy', 'efficient', 'elegant', 'fast', 'flexible', 'good', 'great', 'intuitive',
  'modern', 'nice', 'optimal', 'polished', 'powerful', 'quick', 'reliable', 'responsive', 'robust',
  'scalable', 'seamless', 'smooth', 'snappy', 'usable',
]);

const MEASURED_QUANTITY =
  /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|min|mins?|minutes?|%|percent|x|rps|qps|mb|gb|kb|rows?\/s)\b|\bp9[059]\b/i;
const EXPLICIT_ARTIFACT =
  /`[^`]+`|\b[A-Z]{2,}-\d+\b|\b\d{3}\s+(?:status|response code)\b|[A-Za-z0-9_-]+[\\/][A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,4}\b/;
const CONCRETE_STATE_CHANGE =
  /\b(?:adds?|allows?|blocks?|completes?|creates?|deletes?|disables?|displays?|emits?|enables?|fails?|keeps?|leaves?|logs?|marks?|notifies?|persists?|prevents?|records?|redirects?|refuses?|removes?|reports?|requires?|returns?|rejects?|raises?|retries?|shows?|skips?|stops?|starts?|surfaces?|updates?|writes?)\b/i;

/**
 * Whether an acceptance criterion states something that can be observed.
 *
 * A criterion is observable when it names a measured quantity, a concrete state
 * change, or an explicit artifact. That accepts "sign-in completes in under 2s at
 * p95" and refuses "the system is fast", which shares no observable referent and
 * would leave the agent guessing what good means (F07-AC1).
 */
export function assessObservability(criterion: string): ObservabilityVerdict {
  const signals: ObservabilitySignal[] = [];
  if (MEASURED_QUANTITY.test(criterion)) signals.push('MeasuredQuantity');
  if (CONCRETE_STATE_CHANGE.test(criterion)) signals.push('ConcreteStateChange');
  if (EXPLICIT_ARTIFACT.test(criterion)) signals.push('ExplicitArtifact');

  const words = criterion.toLowerCase().match(/[a-z]+/g) ?? [];
  const unobservableTerms = [...new Set(words.filter((word) => EVALUATIVE_TERMS.includes(word)))];

  return { observable: signals.length > 0, signals, unobservableTerms };
}

/** Boolean form of `assessObservability`, for callers that only need the gate. */
export function isObservable(criterion: string): boolean {
  return assessObservability(criterion).observable;
}

interface FieldError {
  readonly path: string;
  readonly message: string;
}

const TEXT_SECTION_NAMES = ['problem', 'desiredOutcome'] as const;
const LIST_SECTION_NAMES = ['includedBehaviour', 'excludedBehaviour', 'assumptions', 'unresolvedQuestions'] as const;

const BRIEF_PROPOSAL_FIELDS: readonly string[] = Object.freeze([
  'kind',
  'ideaId',
  'authoredBy',
  'authoredAt',
  'basedOnBriefVersion',
  'sections',
]);

/**
 * Every reason the proposal does not describe a usable brief.
 *
 * Unknown and missing keys are checked as well as content, because structured
 * output reaches this layer as decoded JSON that may carry fields the type does
 * not describe (F05-AC5). A top-level field such as `acceptance` is refused
 * rather than dropped: a model that tried to set an owner decision is a signal the
 * caller needs to see, not noise to discard. Returning all failures at once is
 * what makes the rejection recoverable rather than a single opaque refusal.
 */
function sectionErrors(sections: BriefSections, pathPrefix: string): readonly FieldError[] {
  const errors: FieldError[] = [];
  const known = new Set<string>(BRIEF_SECTION_NAMES);
  const present = sections === null || typeof sections !== 'object' ? [] : Object.keys(sections);

  for (const name of BRIEF_SECTION_NAMES) {
    if (!present.includes(name)) {
      errors.push({ path: `${pathPrefix}${name}`, message: `A brief must carry the "${name}" section.` });
    }
  }
  for (const name of present) {
    if (!known.has(name)) {
      errors.push({ path: `${pathPrefix}${name}`, message: `A brief has no section named "${name}".` });
    }
  }
  errors.push(...valueShapeErrors(sections, pathPrefix));
  if (errors.length > 0) return errors;

  if (sections.problem.trim().length === 0) {
    errors.push({ path: `${pathPrefix}problem`, message: 'The brief needs the problem it solves.' });
  }
  if (sections.desiredOutcome.trim().length === 0) {
    errors.push({ path: `${pathPrefix}desiredOutcome`, message: 'The brief needs the outcome the owner wants.' });
  }

  const seenIds = new Set<string>();
  for (const [index, criterion] of sections.acceptanceCriteria.entries()) {
    const path = `${pathPrefix}acceptanceCriteria[${index}]`;
    if (criterion.id.trim().length === 0) {
      errors.push({ path: `${path}.id`, message: 'An acceptance criterion needs an id.' });
    } else if (seenIds.has(criterion.id)) {
      errors.push({ path: `${path}.id`, message: `Acceptance criterion id "${criterion.id}" is used twice.` });
    }
    seenIds.add(criterion.id);

    const verdict = assessObservability(criterion.text);
    if (!verdict.observable) {
      errors.push({
        path: `${path}.text`,
        message:
          verdict.unobservableTerms.length > 0
            ? `"${criterion.text}" is not observable: ${verdict.unobservableTerms.join(', ')} states a quality rather than a behaviour.`
            : `"${criterion.text}" is not observable: name a measured quantity, a concrete state change or an explicit artifact.`,
      });
    }
  }

  return errors;
}

/**
 * Whether each section holds the shape its name promises.
 *
 * Checked before any section is read, so a decoded proposal carrying the wrong
 * kind of value is refused with a field error instead of throwing partway through
 * validation (F05-AC5).
 */
function valueShapeErrors(sections: BriefSections, pathPrefix: string): readonly FieldError[] {
  const errors: FieldError[] = [];

  for (const name of TEXT_SECTION_NAMES) {
    if (typeof sections[name] !== 'string') {
      errors.push({ path: `${pathPrefix}${name}`, message: `The "${name}" section must be text.` });
    }
  }
  for (const name of LIST_SECTION_NAMES) {
    if (!Array.isArray(sections[name])) {
      errors.push({ path: `${pathPrefix}${name}`, message: `The "${name}" section must be a list of statements.` });
    }
  }
  if (!Array.isArray(sections.acceptanceCriteria)) {
    errors.push({
      path: `${pathPrefix}acceptanceCriteria`,
      message: 'The "acceptanceCriteria" section must be a list of criteria.',
    });
    return errors;
  }
  for (const [index, criterion] of sections.acceptanceCriteria.entries()) {
    if (typeof criterion?.id !== 'string' || typeof criterion?.text !== 'string') {
      errors.push({
        path: `${pathPrefix}acceptanceCriteria[${index}]`,
        message: 'A criterion must carry string id and text fields.',
      });
    }
  }
  return errors;
}

function freezeSections(sections: BriefSections): BriefSections {
  return Object.freeze({
    problem: sections.problem,
    desiredOutcome: sections.desiredOutcome,
    includedBehaviour: Object.freeze([...sections.includedBehaviour]),
    excludedBehaviour: Object.freeze([...sections.excludedBehaviour]),
    assumptions: Object.freeze([...sections.assumptions]),
    acceptanceCriteria: Object.freeze(
      sections.acceptanceCriteria.map((criterion) => Object.freeze({ ...criterion })),
    ),
    unresolvedQuestions: Object.freeze([...sections.unresolvedQuestions]),
  });
}

/**
 * A structured brief proposal: the only shape a model may emit.
 *
 * It deliberately has no acceptance, delivery, release or status field, so no
 * structured output can set those owner decisions even by naming one (F05-AC5).
 * It also cannot assert `rawRequestFingerprint`: that fact is computed from the
 * idea the domain already holds, so a model cannot attach a brief to a request
 * it never read.
 */
export interface BriefProposal {
  readonly kind: 'BriefProposal';
  readonly ideaId: IdeaId;
  readonly authoredBy: BriefAuthor;
  readonly authoredAt: string;
  /** null for a first version, or the version this proposal supersedes. */
  readonly basedOnBriefVersion: number | null;
  readonly sections: BriefSections;
}

/**
 * A proposal that passed validation.
 *
 * This is the only accepted input to `draftBrief`, so unvalidated structured
 * output cannot reach the brief lifecycle: `applyProposal` is the choke point
 * (F05-AC5).
 */
export interface ValidatedBriefProposal {
  readonly validated: true;
  readonly ideaId: IdeaId;
  readonly authoredBy: BriefAuthor;
  readonly authoredAt: string;
  readonly basedOnBriefVersion: number | null;
  readonly sections: BriefSections;
}

/**
 * Validates a structured proposal before anything downstream can use it.
 *
 * Refusal is recoverable: the error names every failing field, so the caller can
 * correct and resubmit instead of guessing what was wrong (F05-AC5).
 */
export function applyProposal(proposal: BriefProposal): Result<ValidatedBriefProposal, DomainError> {
  if (proposal.kind !== 'BriefProposal') {
    return err<DomainError>(
      invalid('The structured output is not a brief proposal.', [
        { path: 'kind', message: 'A brief proposal must be tagged as a BriefProposal.' },
      ]),
    );
  }

  const errors: FieldError[] = [];
  const present = proposal === null || typeof proposal !== 'object' ? [] : Object.keys(proposal);
  for (const field of present) {
    if (!BRIEF_PROPOSAL_FIELDS.includes(field)) {
      errors.push({
        path: field,
        message: `A brief proposal has no field "${field}"; owner decisions such as acceptance and release are not proposed.`,
      });
    }
  }
  errors.push(...sectionErrors(proposal.sections, 'sections.'));
  if (errors.length > 0) {
    return err<DomainError>(invalid('The proposed brief is not a valid brief.', errors));
  }

  return ok<ValidatedBriefProposal>(
    Object.freeze({
      validated: true,
      ideaId: proposal.ideaId,
      authoredBy: proposal.authoredBy,
      authoredAt: proposal.authoredAt,
      basedOnBriefVersion: proposal.basedOnBriefVersion,
      sections: freezeSections(proposal.sections),
    }),
  );
}

export interface BriefBinding {
  readonly briefId: string;
  readonly ideaId: IdeaId;
  /** The request text this brief was derived from. Never supplied by a model. */
  readonly rawRequest: string;
  readonly proposal: ValidatedBriefProposal;
}

/**
 * Binds a validated proposal to the request text it must have been derived from.
 *
 * The raw-request fingerprint is computed here from the request the domain
 * already holds, so a brief is always traceable to the exact request it describes
 * and a proposal cannot substitute a different one (F06-AC1, F07-AC1).
 *
 * Taking request text rather than only an `IdeaDraft` is deliberate: an entry
 * point that clarifies a published issue has a captured snapshot instead of an
 * idea, and F07 depends on that path.
 */
export function bindProposalToRequest(binding: BriefBinding): Result<Brief, DomainError> {
  const basedOn = binding.proposal.basedOnBriefVersion;
  return ok<Brief>(
    Object.freeze({
      state: 'Proposed',
      briefId: binding.briefId,
      version: basedOn === null ? 1 : basedOn + 1,
      ideaId: binding.ideaId,
      sections: binding.proposal.sections,
      authoredBy: binding.proposal.authoredBy,
      authoredAt: binding.proposal.authoredAt,
      rawRequestFingerprint: fingerprint(binding.rawRequest),
      supersedesVersion: basedOn,
    }),
  );
}

export interface BriefDraftContext {
  readonly briefId: string;
  readonly idea: IdeaDraft;
  readonly proposal: ValidatedBriefProposal;
}

/**
 * Builds the brief for an idea from a validated proposal.
 *
 * A proposal produced for another idea is a Conflict rather than a silent
 * rebinding, and the brief's fingerprint comes from this idea's own raw request
 * (F07-AC1, F06-AC1).
 */
export function draftBrief(context: BriefDraftContext): Result<Brief, DomainError> {
  const { idea, proposal } = context;

  if (proposal.ideaId !== idea.ideaId) {
    return err<DomainError>({
      code: 'Conflict',
      reason: 'The proposal was produced for a different idea.',
      expected: idea.ideaId,
      actual: proposal.ideaId,
    });
  }

  return bindProposalToRequest({
    briefId: context.briefId,
    ideaId: idea.ideaId,
    rawRequest: idea.rawRequest,
    proposal,
  });
}

/**
 * Records owner agreement with a brief.
 *
 * Agreement is an owner decision about a brief, not product acceptance: it says
 * the scope is right, not that code behaves correctly, and it records nothing
 * about delivery or release (mvp-spec 3, F05-AC5).
 */
export function agreeBrief(
  brief: Brief,
  input: { readonly agreedBy: string; readonly at: string },
): Result<Brief, DomainError> {
  if (brief.state === 'Agreed') {
    return err<DomainError>({
      code: 'Conflict',
      reason: 'This brief version is already agreed.',
      expected: 'Proposed',
      actual: 'Agreed',
    });
  }

  return ok<Brief>(Object.freeze({ ...brief, state: 'Agreed', agreedBy: input.agreedBy, agreedAt: input.at }));
}