/**
 * Bounded, read-only brief and clarification generation (F07-AC1, F07-AC2, F07-AC3,
 * F07-AC4, F07-AC5, F15-AC2, F18-AC2, F05-AC5, N02-AC3).
 *
 * This is the path the owner reaches by asking for a brief to be written for them:
 * the request goes to the configured engine in one bounded read-only session, the
 * structured output is validated by the domain before anything is stored, and only
 * material ambiguities become questions. Every property worth reading about is
 * structural rather than a convention:
 *
 *   - **The engine is reached through a narrow port.** `ClarificationEngine` takes a
 *     prompt and returns the engine's own structured text. `createEngineClarifier`
 *     is the one implementation, and it drives the real `EngineAdapter` contract: a
 *     headless session, an explicit grant of the read-only capabilities, bounded wall
 *     clock and event count, and only a `Succeeded` outcome treated as output
 *     (F15-AC2, F18-AC2).
 *   - **The grant is the domain's read-only profile.** `readOnlyCapabilityProfile`
 *     supplies the capabilities handed to the engine and travels on the result, so
 *     the profile a caller can read is the profile the engine was given. It contains
 *     no mutating capability, which is why nothing on this path can push a branch,
 *     publish a ticket or deploy (F07-AC5).
 *   - **Nothing on this path can reach a publisher or a deployer.** The dependency
 *     surface is a clock, an engine, a store and the context packet. There is no
 *     ticket adapter, no git adapter and no deployment executor to call, so "does not
 *     publish tickets or deploy" is a property of what the object holds rather than of
 *     what it refrains from doing (F07-AC5).
 *   - **Structured output is validated, not coerced.** The decoded object is handed
 *     to the domain's `applyProposal` with the model's own keys intact, so a missing
 *     section, an unobservable criterion and an unknown field are each a per-field
 *     `Invalid` error the caller can correct and resubmit (F07-AC1).
 *   - **An owner decision is refused outright.** A payload carrying an acceptance,
 *     delivery or release field never becomes a brief with that field dropped; the
 *     whole proposal is refused and the error names the field, because a model
 *     reaching for an owner decision is the thing the caller most needs to see
 *     (F05-AC5, F07-AC5).
 *   - **Only open readings earn a question.** The model's ambiguities are handed to
 *     the domain's `generateClarifyingQuestions` together with the request text as a
 *     statement the owner already made, so an ambiguity the request has settled is
 *     reported as rejected rather than asked (F07-AC2).
 *   - **The raw request is never an output.** The store seam reads the current brief and
 *     writes a brief, a question, a declined candidate or a turn; it exposes no method
 *     that could replace `raw_request`, and the brief's fingerprint is computed by the
 *     domain from the idea this layer was handed (F06-AC1, F07-AC1, F07-AC3).
 *
 * Nothing throws across a public boundary: engine text, JSON decoding and validation
 * all return `Result<T, DomainError>`.
 */

import {
  BRIEF_SECTION_NAMES,
  applyProposal,
  blocked,
  codeGroundedClaim,
  err,
  generateClarifyingQuestions,
  invalid,
  isMutatingCapability,
  ok,
  readOnlyCapabilityProfile,
  redact,
  redactDeep,
} from '@shiploop/domain';
import type {
  Ambiguity,
  AmbiguityImpact,
  AmbiguityKind,
  Brief,
  BriefProposal,
  BriefSections,
  ClaimEvidence,
  ClaimEvidenceKind,
  ClarifyingQuestion,
  CodeClaim,
  ConversationTurn,
  DomainError,
  GroundedClaim,
  IdeaDraft,
  IdeaId,
  ProviderId,
  ReadOnlyCapability,
  ReadOnlyCapabilityProfile,

  Result,
  ValidatedBriefProposal,
} from '@shiploop/domain';
import {
  deniedCodingCapabilities,
  type AdapterContext,
  type EngineAdapter,
  type ExecutionWorkspace,
} from '@shiploop/adapters';
import type { ClarifyingQuestionRecord, RejectedQuestionRecord } from '@shiploop/storage';
import type { ContextPacket } from './context-packet.ts';
import { renderContextPacket } from './context-packet.ts';
import type { ControllerClock } from './profiles.ts';

/**
 * The mode clarification runs in.
 *
 * Named rather than implied, so a recorded run says which mode produced it and a
 * reviewer can tell a clarification session from a coding session by reading the run
 * rather than the prompt (F07-AC5).
 */
export const CLARIFICATION_MODE = 'shipLoop-clarify' as const;

export type ClarificationMode = typeof CLARIFICATION_MODE;

/** Bounds for one clarification session (F18-AC2). */
export interface BriefGenerationBounds {
  readonly activeWallClockMs: number;
  readonly retryBudget: number;
  readonly eventCountLimit: number;
  readonly maxOutputCharacters: number;
}

/**
 * The published bound for a clarification pass.
 *
 * A brief is a few hundred words of scope, so the wall clock is minutes rather than the
 * hour a coding attempt gets, and the output bound is smaller than any real brief by a
 * wide margin: a response past it is truncated output, not a long brief (F18-AC2).
 */
export const DEFAULT_CLARIFICATION_BOUNDS: BriefGenerationBounds = Object.freeze({
  activeWallClockMs: 180_000,
  retryBudget: 0,
  eventCountLimit: 256,
  maxOutputCharacters: 64_000,
});

/** One clarification session's request. */
export interface ClarificationRunRequest {
  /** Stable identity of this attempt, for reconciling a lost engine response. */
  readonly operationId: string;
  readonly mode: ClarificationMode;
  readonly instruction: string;
  readonly workspace: ExecutionWorkspace;
  readonly bounds: BriefGenerationBounds;
  /** The exact read-only grant clarification may hold (F07-AC5). */
  readonly grantedCapabilities: readonly ReadOnlyCapability[];
}

/** What one clarification session produced. */
export interface ClarificationRun {
  readonly mode: ClarificationMode;
  readonly engineVersion: string;
  readonly sessionId: ProviderId;
  /** The engine's structured text, verbatim. Never parsed here. */
  readonly structuredOutput: string;
  /** True when the engine reported the output cut short (F18-AC2). */
  readonly truncated: boolean;
  /** The profile the engine was granted, so the record states what it could do. */
  readonly capability: ReadOnlyCapabilityProfile;
}

/**
 * The seam a configured engine is driven through.
 *
 * Deliberately narrower than `EngineAdapter`: it takes a prompt and returns text, so
 * this layer never learns how the engine reports progress, and the adapter's event
 * union cannot leak into brief validation (F15-AC2).
 */
export interface ClarificationEngine {
  readonly kind: 'ClarificationEngine';
  readonly connectorId: string;
  clarify(request: ClarificationRunRequest): Promise<Result<ClarificationRun>>;
}

export interface EngineClarifierSettings {
  readonly engine: EngineAdapter;
  readonly workspace: ExecutionWorkspace;
  readonly clock: ControllerClock;
  readonly bounds?: BriefGenerationBounds;
  /** Cancellation for one session; absent means the session runs to its own bound. */
  readonly signal?: AbortSignal;
  /** Identity prefix used for the adapter's correlation id. */
  readonly correlationPrefix?: string;
}

function unavailable(reason: string): DomainError {
  return { code: 'Unavailable', reason };
}

/**
 * Builds the clarifier that drives a real `EngineAdapter`.
 *
 * The grant is the domain's read-only capability list, so an engine cannot be started
 * here holding anything that changes code, publishes a ticket or deploys, and the
 * refusals come from the adapter rather than from a prompt asking the model to behave
 * (F07-AC5, F03-AC5).
 *
 * The engine's own account of the run is the structured text: for a single-turn
 * generation request the instruction asks for one JSON object as the whole reply, and
 * `EngineOutcome.Succeeded.summary` is the adapter's translation of exactly that reply.
 * Only `Succeeded` is output; `Incomplete`, `Failed` and `Blocked` are refusals, so a
 * truncated or failed pass can never be stored as a brief (F15-AC2).
 */
export function createEngineClarifier(settings: EngineClarifierSettings): ClarificationEngine {
  const bounds = settings.bounds ?? DEFAULT_CLARIFICATION_BOUNDS;
  const prefix = settings.correlationPrefix ?? 'clarification';

  return {
    kind: 'ClarificationEngine',
    connectorId: settings.engine.connectorId,
    async clarify(request: ClarificationRunRequest): Promise<Result<ClarificationRun>> {
      const denied = deniedCodingCapabilities([...request.grantedCapabilities]);
      if (denied.length > 0) {
        return err({
          code: 'Forbidden',
          reason: `A clarification session may not hold ${denied.join(', ')}; a delivery action belongs to an authorized delivery executor (F03-AC5, N02-AC3).`,
        });
      }

      const controller = new AbortController();
      const signal = settings.signal;
      if (signal !== undefined) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      const operationId = request.operationId as AdapterContext['operationId'];
      const context: AdapterContext = {
        correlationId: `${prefix}:${request.operationId}`,
        operationId,
        clock: { now: () => settings.clock.now(), elapsedMs: () => 0 },
        logger: { emit: () => undefined },
        signal: controller.signal,
        redact: (value: string): string => redact(value).text,
      };

      const started = await settings.engine.startSession(context, {
        operationId,
        workspace: request.workspace,
        start: { kind: 'Fresh', instruction: request.instruction },
        mode: 'Headless',
        grantedCapabilities: [...request.grantedCapabilities],
        bounds: {
          activeWallClockMs: bounds.activeWallClockMs,
          retryBudget: bounds.retryBudget,
          eventCountLimit: bounds.eventCountLimit,
        },
      });
      if (!started.ok) return err(started.error);

      const session = started.value;
      let output: string | null = null;
      let truncated = false;
      let failure: DomainError | null = null;

      try {
        for await (const event of session.events) {
          if (event.kind !== 'Result') continue;
          const outcome = event.outcome;
          if (outcome.kind === 'Succeeded') {
            output = outcome.summary;
          } else if (outcome.kind === 'Incomplete') {
            truncated = outcome.reason === 'OutputTruncated' || outcome.reason === 'BudgetExhausted';
            failure = blocked(`The clarification session did not finish: ${outcome.summary}`, [
              {
                name: 'clarification output',
                detail: `The engine reported ${outcome.reason}. A partial answer is not stored as a brief (F15-AC2).`,
                remedy: 'Retry the clarification pass; if it truncates again, split the request into one outcome.',
              },
            ]);
          } else if (outcome.kind === 'Blocked') {
            failure = blocked(`The clarification session was blocked: ${outcome.summary}`, [
              {
                name: `engine ${outcome.category.toLowerCase()}`,
                detail: outcome.remedy,
                remedy: 'Address the engine condition the adapter reported, then ask for the brief again.',
              },
            ]);
          } else {
            failure = unavailable(`The clarification session failed: ${outcome.summary}`);
          }
        }
      } catch (error) {
        return err(
          unavailable(
            `The clarification session could not be read to completion: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }

      if (failure !== null) return err(failure);
      if (output === null) {
        return err(
          invalid('The engine produced no structured output for the clarification pass, so no brief was drafted.', [
            { path: 'structuredOutput', message: 'A clarification pass with no result is not a brief (F15-AC2).' },
          ]),
        );
      }

      if (output.length > bounds.maxOutputCharacters) {
        return err(
          blocked(
            `The clarification output was ${String(output.length)} characters, past the ${String(bounds.maxOutputCharacters)} character bound (F18-AC2).`,
            [
              {
                name: 'clarification output bound',
                detail: 'A bounded brief is a small artefact; output this long was not a brief and was not stored.',
                remedy: 'Narrow the request to one outcome, or configure a larger bound deliberately.',
              },
            ],
          ),
        );
      }

      return ok({
        mode: request.mode,
        engineVersion: session.engineVersion,
        sessionId: session.sessionId,
        structuredOutput: output,
        truncated,
        capability: readOnlyCapabilityProfile,
      });
    },
  };
}

/**
 * The narrowest durable store this path needs.
 *
 * Every method writes a brief, a question, a declined candidate or a conversation
 * turn. There is no method that publishes, schedules, merges or deploys, which is how
 * "clarification has no side effect" is enforced rather than promised: the capability
 * to do those things is not reachable from the object that holds the store
 * (F07-AC5). `@shiploop/storage`'s `IntakeRepository` satisfies this interface.
 */
export interface BriefGenerationStore {
  /**
   * The highest-numbered version, so a regeneration can be refused as a correction
   * rather than appended as a second first draft (F07-AC3).
   */
  currentBrief(ideaId: IdeaId): Result<Brief | null>;
  draftAndAppend(briefId: string, idea: IdeaDraft, proposal: ValidatedBriefProposal): Result<Brief>;
  recordQuestion(input: {
    readonly ideaId: IdeaId;
    readonly briefId: string | null;
    readonly briefVersion: number | null;
    readonly question: ClarifyingQuestion;
    readonly at: string;
  }): Result<ClarifyingQuestionRecord>;
  recordRejectedQuestion(input: {
    readonly ideaId: IdeaId;
    readonly briefId: string | null;
    readonly briefVersion: number | null;
    readonly topic: string;
    readonly rejection: string;
    readonly explanation: string;
    readonly at: string;
  }): Result<RejectedQuestionRecord>;
  recordTurn(ideaId: IdeaId, turn: ConversationTurn): Result<ConversationTurn>;
}

/** A question the caller shows the owner (F07-AC2). */
export interface GeneratedQuestionView {
  readonly questionId: string;
  readonly topic: string;
  readonly prompt: string;
  readonly readings: readonly string[];
  readonly whyMaterial: string;
  readonly origin: 'Ambiguity' | 'UnobservableCriterion';
}

/** A candidate that was considered and not asked about (F07-AC2). */
export interface GeneratedRejectedView {
  readonly topic: string;
  readonly rejection: string;
  readonly explanation: string;
}

/** A claim the engine made about the code, and the domain's verdict on it (F07-AC4). */
export interface GeneratedClaimView {
  readonly claimId: string;
  readonly subject: string;
  readonly statement: string;
  readonly inspectedRevision: string | null;
  readonly evidence: readonly ClaimEvidence[];
  readonly grounded: GroundedClaim;
}

/** Everything one clarification pass produced. */
export interface GeneratedBriefView {
  readonly mode: ClarificationMode;
  readonly engineVersion: string;
  readonly sessionId: ProviderId;
  readonly brief: Brief;
  /** The seven sections the specification names, in order (F07-AC1). */
  readonly sectionNames: readonly string[];
  readonly questions: readonly GeneratedQuestionView[];
  readonly rejected: readonly GeneratedRejectedView[];
  readonly claims: readonly GeneratedClaimView[];
  /** The prompt's character length, so a bounded pass is visible in the record. */
  readonly promptCharacters: number;
  readonly bounds: BriefGenerationBounds;
  /** The exact profile the engine was granted (F07-AC5). */
  readonly capability: ReadOnlyCapabilityProfile;
}

export interface GenerateBriefRequest {
  /** The brief identity; the `brief-` prefix is added when a caller omits it. */
  readonly briefId: string;
  readonly idea: IdeaDraft;
  /** The context packet to clarify against, at its recorded revision (F07-AC4). */
  readonly contextPacket: ContextPacket;
  /** A caller that needs a specific run identity supplies one; otherwise it is derived. */
  readonly operationId?: string;
}

export interface BriefGenerationDeps {
  readonly clock: ControllerClock;
  readonly engine: ClarificationEngine;
  readonly store: BriefGenerationStore;
  /** The isolated, read-only workspace the clarification session runs in. */
  readonly workspace: ExecutionWorkspace;
  readonly bounds?: BriefGenerationBounds;
  /** Replaces the derived run identity, so a test records no ambient counter. */
  readonly operationIdFactory?: () => string;
}

/** The prefix that makes every brief for one idea share one identity (F07-AC3). */
const BRIEF_ID_PREFIX = 'brief-';

/**
 * Fields a structured output may not carry, whatever it calls them.
 *
 * Acceptance, delivery and release are owner decisions on a candidate (mvp-spec 3), and
 * a clarification pass has no such decision to make. A payload naming one is refused
 * outright rather than stripped, because "the model tried to accept the work" is
 * information the caller must receive, not noise to discard (F05-AC5, F07-AC5).
 */
const OWNER_DECISION_FIELDS: ReadonlySet<string> = new Set([
  'acceptance',
  'accepted',
  'acceptedby',
  'agreed',
  'agreement',
  'approval',
  'authorized',
  'authorization',
  'decision',
  'delivery',
  'deployed',
  'merged',
  'publication',
  'published',
  'release',
  'released',
  'status',
]);

const AMBIGUITY_KINDS: readonly AmbiguityKind[] = Object.freeze([
  'UnspecifiedSubject',
  'ConflictingStatement',
  'MissingAcceptanceThreshold',
  'UnstatedScopeBoundary',
  'UnresolvedDependency',
]);

const AMBIGUITY_IMPACTS: readonly AmbiguityImpact[] = Object.freeze([
  'ChangesBehaviour',
  'ChangesAcceptance',
  'Cosmetic',
]);

const EVIDENCE_KINDS: readonly ClaimEvidenceKind[] = Object.freeze([
  'CodeLocation',
  'CommandOutput',
  'CheckResult',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeJson(text: string): Result<unknown, DomainError> {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (error) {
    return err(
      invalid(
        `The engine's clarification output is not JSON, so it is not a brief proposal: ${error instanceof Error ? error.message : String(error)}`,
        [
          {
            path: 'structuredOutput',
            message: 'Reply with one JSON object; prose cannot be validated into a brief (F07-AC1).',
          },
        ],
      ),
    );
  }
}

/** Owner-decision keys anywhere in the decoded payload, one error per key. */
function ownerDecisionErrors(record: Record<string, unknown>, path: string): { path: string; message: string }[] {
  const found: { path: string; message: string }[] = [];
  for (const [key, value] of Object.entries(record)) {
    const at = `${path}.${key}`;
    if (OWNER_DECISION_FIELDS.has(key.toLowerCase().replace(/[^a-z]/g, ''))) {
      found.push({
        path: at,
        message: `"${key}" is an owner decision about a candidate. Clarification does not accept, deliver or release anything, so this proposal is refused rather than stored without the field (F05-AC5, F07-AC5).`,
      });
      continue;
    }
    if (isRecord(value)) found.push(...ownerDecisionErrors(value, at));
    else if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (isRecord(entry)) found.push(...ownerDecisionErrors(entry, `${at}[${String(index)}]`));
      });
    }
  }
  return found;
}

/**
 * The two keys the prompt declares beside `sections`.
 *
 * They are this layer's protocol for the questions and the code claims, not brief
 * sections, so they are read out of the payload and then left out of the proposal the
 * domain validates. Every *other* key the model emitted is carried through, so an
 * unexpected key is still refused by name rather than silently dropped (F07-AC1).
 */
const PROPOSAL_SIDE_CHANNELS: readonly string[] = Object.freeze(['ambiguities', 'claims']);

/**
 * Envelopes the decoded payload as the proposal the domain validates.
 *
 * The model's own keys are carried through rather than rebuilt, so an unexpected key
 * reaches `applyProposal` and is refused by name instead of disappearing. The four
 * provenance fields are this layer's to set: a model cannot claim which request it read,
 * when it ran, or which brief version it replaces (F05-AC5, F07-AC1).
 *
 * The sections cross as `unknown` and are cast once, to the domain's own type. That cast
 * asserts nothing about validity — `applyProposal` is what decides, and it re-reads every
 * section, every key and every criterion. Building a valid-looking `BriefSections` here
 * instead would move the assumption the domain exists to check (F07-AC1).
 */
function toProposal(
  record: Record<string, unknown>,
  idea: IdeaDraft,
  authoredAt: string,
): BriefProposal {
  const carried: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'ideaId' || key === 'authoredBy' || key === 'authoredAt' || key === 'basedOnBriefVersion') continue;
    if (PROPOSAL_SIDE_CHANNELS.includes(key)) continue;
    carried[key] = value;
  }
  return {
    ...carried,
    kind: 'BriefProposal',
    ideaId: idea.ideaId,
    authoredBy: 'ClarificationModel',
    authoredAt,
    basedOnBriefVersion: null,
    sections: carried['sections'] as BriefSections,
  };
}

/**
 * Reads the model's ambiguities into the domain's shape.
 *
 * An entry the model cannot describe as an ambiguity — no topic, no evidence, not one of
 * the declared kinds — is reported as a field error rather than dropped, because a
 * candidate the owner was never shown is a candidate the owner cannot correct (F07-AC2).
 * The request text is added to `answeredBy` unconditionally: it is a statement the owner
 * already made, and leaving it out would let the model present an ambiguity the request
 * has already settled (F07-AC2).
 */
function readAmbiguities(decoded: unknown, rawRequest: string): Result<readonly Ambiguity[], DomainError> {
  if (decoded === undefined || decoded === null) return ok([]);
  if (!Array.isArray(decoded)) {
    return err(
      invalid('The clarification output does not enumerate its ambiguities.', [
        { path: 'ambiguities', message: 'Expected a list of ambiguities, or none at all.' },
      ]),
    );
  }

  const errors: { path: string; message: string }[] = [];
  const ambiguities: Ambiguity[] = [];
  decoded.forEach((entry, index) => {
    const at = `ambiguities[${String(index)}]`;
    if (!isRecord(entry)) {
      errors.push({ path: at, message: 'An ambiguity must be an object.' });
      return;
    }
    const kind = trimmed(entry['kind']);
    const impact = trimmed(entry['impact']);
    const topic = trimmed(entry['topic']);
    const evidence = trimmed(entry['evidence']);
    const readings = Array.isArray(entry['readings'])
      ? entry['readings']
          .filter((reading): reading is string => typeof reading === 'string')
          .map((reading) => reading.trim())
          .filter((reading) => reading.length > 0)
      : null;
    const answeredBy = Array.isArray(entry['answeredBy'])
      ? entry['answeredBy']
          .filter((answer): answer is string => typeof answer === 'string')
          .map((answer) => answer.trim())
          .filter((answer) => answer.length > 0)
      : [];

    if (!AMBIGUITY_KINDS.includes(kind as AmbiguityKind)) {
      errors.push({ path: `${at}.kind`, message: `Expected one of ${AMBIGUITY_KINDS.join(', ')}.` });
      return;
    }
    if (!AMBIGUITY_IMPACTS.includes(impact as AmbiguityImpact)) {
      errors.push({ path: `${at}.impact`, message: `Expected one of ${AMBIGUITY_IMPACTS.join(', ')}.` });
      return;
    }
    if (topic.length === 0) {
      errors.push({ path: `${at}.topic`, message: 'An ambiguity must name what it is about (F07-AC2).' });
      return;
    }
    if (evidence.length === 0) {
      errors.push({
        path: `${at}.evidence`,
        message: 'An ambiguity must quote the request text that shows it exists (F07-AC2).',
      });
      return;
    }
    if (readings === null || readings.length < 2) {
      errors.push({
        path: `${at}.readings`,
        message: 'An ambiguity needs at least two distinct readings; one reading leaves nothing to ask (F07-AC2).',
      });
      return;
    }

    ambiguities.push({
      kind: kind as AmbiguityKind,
      topic,
      readings,
      answeredBy: [...answeredBy, rawRequest],
      impact: impact as AmbiguityImpact,
      evidence,
    });
  });

  if (errors.length > 0) {
    return err(invalid('The clarification output did not describe usable ambiguities.', errors));
  }
  return ok(ambiguities);
}

/**
 * Turns the model's code claims into the domain's claim input, grounded or not (F07-AC4).
 *
 * The text has already been redacted once, where it crossed into this process; nothing
 * here redacts again, so there is one boundary rather than a rule to remember per field.
 */
function readClaims(decoded: unknown): Result<readonly CodeClaim[], DomainError> {
  if (decoded === undefined || decoded === null) return ok([]);
  if (!Array.isArray(decoded)) {
    return err(
      invalid('The clarification output does not enumerate its code claims.', [
        { path: 'claims', message: 'Expected a list of code claims, or none at all (F07-AC4).' },
      ]),
    );
  }

  const errors: { path: string; message: string }[] = [];
  const claims: CodeClaim[] = [];
  decoded.forEach((entry, index) => {
    const at = `claims[${String(index)}]`;
    if (!isRecord(entry)) {
      errors.push({ path: at, message: 'A code claim must be an object (F07-AC4).' });
      return;
    }
    const statement = trimmed(entry['statement']);
    if (statement.length === 0) {
      errors.push({ path: `${at}.statement`, message: 'A code claim must state what it claims (F07-AC4).' });
      return;
    }
    const subject = trimmed(entry['subject']);
    const claimId = trimmed(entry['claimId']);
    const inspectedRevision =
      typeof entry['inspectedRevision'] === 'string' ? entry['inspectedRevision'].trim() : null;
    const evidenceEntry = Array.isArray(entry['evidence']) ? entry['evidence'] : [];

    const evidence: ClaimEvidence[] = [];
    evidenceEntry.forEach((item, itemIndex) => {
      const evidenceAt = `${at}.evidence[${String(itemIndex)}]`;
      if (!isRecord(item)) {
        errors.push({ path: evidenceAt, message: 'Evidence must be an object (F07-AC4).' });
        return;
      }
      const reference = trimmed(item['reference']);
      const observedAt = trimmed(item['observedAt']);
      const kind = trimmed(item['kind']);
      if (reference.length === 0) {
        errors.push({
          path: `${evidenceAt}.reference`,
          message: 'Evidence must name what it was read from (F07-AC4).',
        });
        return;
      }
      if (!EVIDENCE_KINDS.includes(kind as ClaimEvidenceKind)) {
        errors.push({
          path: `${evidenceAt}.kind`,
          message: `Expected one of ${EVIDENCE_KINDS.join(', ')} (F07-AC4).`,
        });
        return;
      }
      evidence.push({
        kind: kind as ClaimEvidenceKind,
        reference,
        observedAt: observedAt.length === 0 ? 'not recorded' : observedAt,
      });
    });

    claims.push({
      claimId: claimId.length === 0 ? `${CLARIFICATION_MODE}-claim-${String(index + 1)}` : claimId,
      statement,
      subject: subject.length === 0 ? 'the repository' : subject,
      inspectedRevision,
      evidence,
    });
  });

  if (errors.length > 0) {
    return err(invalid('The clarification output did not describe usable code claims.', errors));
  }
  return ok(claims);
}

/**
 * Refuses any capability that would change code, publish a ticket or deploy.
 *
 * The profile's own type is already narrowed to `ReadOnlyCapability`, so this is the
 * runtime half of the same rule: it reads data that arrived from a boundary, and a
 * profile that had acquired a mutating capability would stop the run before the engine
 * was started rather than after (F07-AC5).
 */
export function assertReadOnlyClarification(profile: ReadOnlyCapabilityProfile): Result<true, DomainError> {
  const problems: { path: string; message: string }[] = [];
  for (const capability of profile.capabilities) {
    if (isMutatingCapability(capability)) {
      problems.push({
        path: `capabilityProfile.capabilities.${capability}`,
        message: `"${capability}" changes something outside clarification (F07-AC5).`,
      });
    }
  }
  if (profile.mayChangeApplicationCode !== false) {
    problems.push({
      path: 'capabilityProfile.mayChangeApplicationCode',
      message: 'Clarification may not change application code (F07-AC5).',
    });
  }
  if (profile.mayPublishTickets !== false) {
    problems.push({
      path: 'capabilityProfile.mayPublishTickets',
      message: 'Clarification may not publish tickets (F07-AC5).',
    });
  }
  if (profile.mayDeploy !== false) {
    problems.push({
      path: 'capabilityProfile.mayDeploy',
      message: 'Clarification may not deploy (F07-AC5).',
    });
  }
  const privileged = deniedCodingCapabilities([...profile.capabilities]);
  if (privileged.length > 0) {
    problems.push({
      path: 'capabilityProfile.capabilities',
      message: `A clarification profile may not hold ${privileged.join(', ')} (F03-AC5, N02-AC3).`,
    });
  }

  if (problems.length > 0) {
    return err(invalid('The capability profile is not read-only, so clarification cannot run under it.', problems));
  }
  return ok(true);
}

const PROMPT_BUDGET_MARKER = 'the remaining context lines were dropped to stay inside the prompt budget';

/** The prompt's context block, truncated with a sentence saying so. */
function budgetText(text: string, budget: number, marker: string): string {
  const limit = Math.max(0, budget);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[${String(text.length - limit)} characters of context were dropped: ${marker}]`;
}

/**
 * The instruction the engine receives.
 *
 * Read-only in its first line, provenance-bound in its second, and explicit that
 * `Unknown` means exactly that: the packet says which repository revision was read and
 * which subjects nobody inspected, so the model is told to ask rather than to guess
 * (F07-AC4). Every interpolated value is redacted, because this text crosses into an
 * external process (N02-AC3).
 */
export function buildClarificationPrompt(idea: IdeaDraft, packet: ContextPacket, budget = 24_000): string {
  const rendered = renderContextPacket(packet);
  const context = budgetText(rendered.text, budget, PROMPT_BUDGET_MARKER);
  const seven = BRIEF_SECTION_NAMES.join(', ');

  return redact(
    [
      `ShipLoop ${CLARIFICATION_MODE}. You are clarifying one captured request into a brief.`,
      'This session is read-only: do not write, edit, publish, commit, push or deploy anything. Produce text only.',
      `Answer only from the request and the context below. The context was read at revision ${packet.revision ?? 'none recorded'}.`,
      'Where the context says Unknown, you did not inspect it. Say so in the brief rather than inventing a fact, and raise it as an unresolved question if it would change the work.',
      '',
      "## Raw request (the owner's own words; never rewrite them)",
      idea.rawRequest,
      '',
      '## Owner notes',
      idea.notes ?? 'none recorded',
      '',
      `## Repository context (${String(packet.claims.length)} fact(s), ${String(packet.unknownSubjects.length)} unknown)`,
      context,
      '',
      '## What to produce',
      'Reply with one JSON object and nothing else. Its shape is:',
      '{',
      `  "sections": { ${BRIEF_SECTION_NAMES.map((name) => `"${name}"`).join(', ')} },`,
      '  "ambiguities": [ { "kind", "topic", "readings", "answeredBy", "impact", "evidence" } ],',
      '  "claims": [ { "claimId", "subject", "statement", "inspectedRevision", "evidence": [ { "kind", "reference", "observedAt" } ] } ]',
      '}',
      '',
      `All seven section keys must be present: ${seven}.`,
      '"problem" and "desiredOutcome" are text. "includedBehaviour", "excludedBehaviour", "assumptions" and "unresolvedQuestions" are lists of statements.',
      '"acceptanceCriteria" is a list of { "id", "text", "verification" }, where every "text" names a measured quantity, a concrete state change or an explicit artifact.',
      'Put only genuinely open ambiguities in "ambiguities": each needs at least two distinct readings, and "evidence" must quote the request.',
      'Never emit an acceptance, delivery, release or status field. Those are owner decisions and this session has none (F05-AC5).',
    ].join('\n'),
  ).text;
}

/**
 * Builds the brief and clarification use cases.
 *
 * Everything they touch is injected — clock, engine, store, workspace — so a test
 * contacts no provider, records no ambient instant and can prove the grant each run
 * made. `generateBrief` is the only entry point: it drives the engine, validates the
 * structured output, stores the brief, and records the questions and the declined
 * candidates (F07-AC1, F07-AC2, F07-AC5).
 */
export function createBriefGenerationUseCases(deps: BriefGenerationDeps) {
  const bounds = deps.bounds ?? DEFAULT_CLARIFICATION_BOUNDS;
  let counter = 0;

  /**
   * The capability profile this path runs under, checked before any session starts.
   *
   * The check runs first rather than last so a profile that had acquired a mutating
   * capability stops the run before an engine process exists (F07-AC5).
   */
  const capability = (): Result<ReadOnlyCapabilityProfile, DomainError> => {
    const permitted = assertReadOnlyClarification(readOnlyCapabilityProfile);
    if (!permitted.ok) return err(permitted.error);
    return ok(readOnlyCapabilityProfile);
  };

  /**
   * Drives one bounded, read-only clarification pass and stores what it validated.
   *
   * The order is the guarantee: capability, then the bounded session, then decoding,
   * then the domain's `applyProposal`, and only then a write. A refusal at any step
   * leaves the idea's raw request and conversation exactly as they were, because nothing
   * before the last step touches the store (F07-AC1, F07-AC3, F05-AC5).
   *
   * Every session proposes a first version. A regeneration is stored as the next version
   * only when the caller already holds an agreed or proposed brief and says so through
   * `briefId`; the prior version is never replaced, so the owner's earlier reasoning stays
   * readable (F07-AC3).
   */
  const generateBrief = async (request: GenerateBriefRequest): Promise<Result<GeneratedBriefView, DomainError>> => {
    const permitted = capability();
    if (!permitted.ok) return err(permitted.error);
    const profile = permitted.value;

    if (request.contextPacket.ideaId !== request.idea.ideaId) {
      return err(
        invalid('The context packet was assembled for a different request.', [
          {
            path: 'contextPacket.ideaId',
            message: `The packet describes ${request.contextPacket.ideaId}, not ${request.idea.ideaId} (F07-AC4).`,
          },
        ]),
      );
    }

    counter += 1;
    const operationId =
      request.operationId ??
      (deps.operationIdFactory === undefined
        ? `${CLARIFICATION_MODE}-${request.idea.ideaId}-${String(counter)}`
        : `${CLARIFICATION_MODE}-${deps.operationIdFactory()}`);

    const authoredAt = deps.clock.now();

    // Refused before the engine is contacted, because a second first draft would be a
    // rewrite with no record of what it replaced. The owner changes a brief by recording
    // a correction, which appends a version (F07-AC3).
    const existing = deps.store.currentBrief(request.idea.ideaId);
    if (!existing.ok) return err(existing.error);
    if (existing.value !== null) {
      return err({
        code: 'Conflict',
        reason: `This request already has a brief at version ${String(existing.value.version)}. Record a correction so the new version states what it changed (F07-AC3).`,
        expected: 'no brief yet',
        actual: `version ${String(existing.value.version)}`,
      });
    }

    const instruction = buildClarificationPrompt(request.idea, request.contextPacket);

    const run = await deps.engine.clarify({
      operationId,
      mode: CLARIFICATION_MODE,
      instruction,
      workspace: deps.workspace,
      bounds,
      grantedCapabilities: profile.capabilities,
    });
    if (!run.ok) return err(run.error);

    const decoded = decodeJson(run.value.structuredOutput);
    if (!decoded.ok) return err(decoded.error);
    if (!isRecord(decoded.value)) {
      return err(
        invalid("The engine's clarification output is not a JSON object, so it is not a brief proposal.", [
          { path: 'structuredOutput', message: 'Expected one JSON object with a "sections" key (F07-AC1).' },
        ]),
      );
    }
    // Engine text is external text. Every string in it is redacted once, here, before it
    // can reach a stored row or an error message; the structure is untouched, so the
    // validation below still sees exactly the shape the model produced (N02-AC3).
    const payload = redactDeep(decoded.value);

    const decisions = ownerDecisionErrors(payload, 'proposal');
    if (decisions.length > 0) {
      return err(
        invalid(
          'The clarification output tried to set an owner decision, so the whole proposal is refused (F05-AC5, F07-AC5).',
          decisions,
        ),
      );
    }

    const ambiguities = readAmbiguities(payload['ambiguities'], request.idea.rawRequest);
    if (!ambiguities.ok) return err(ambiguities.error);
    const claims = readClaims(payload['claims']);
    if (!claims.ok) return err(claims.error);

    const validated = applyProposal(toProposal(payload, request.idea, authoredAt));
    if (!validated.ok) return err(validated.error);

    const round = generateClarifyingQuestions({
      briefId: request.briefId,
      ideaId: request.idea.ideaId,
      sections: validated.value.sections,
      ambiguities: ambiguities.value,
    });

    const briefId = request.briefId.startsWith(BRIEF_ID_PREFIX)
      ? request.briefId
      : `${BRIEF_ID_PREFIX}${request.idea.ideaId}`;
    const appended = deps.store.draftAndAppend(briefId, request.idea, validated.value);
    if (!appended.ok) return err(appended.error);
    const brief = appended.value;

    const questions: GeneratedQuestionView[] = [];
    for (const question of round.questions) {
      const recorded = deps.store.recordQuestion({
        ideaId: request.idea.ideaId,
        briefId: brief.briefId,
        briefVersion: brief.version,
        question,
        at: authoredAt,
      });
      if (!recorded.ok) return err(recorded.error);
      const turn = deps.store.recordTurn(request.idea.ideaId, {
        kind: 'Question',
        at: authoredAt,
        questionId: recorded.value.questionId,
        prompt: question.prompt,
      });
      if (!turn.ok) return err(turn.error);
      questions.push({
        questionId: recorded.value.questionId,
        topic: recorded.value.topic,
        prompt: recorded.value.prompt,
        readings: [...recorded.value.readings],
        whyMaterial: recorded.value.whyMaterial,
        origin: recorded.value.origin,
      });
    }

    const rejected: GeneratedRejectedView[] = [];
    for (const declined of round.rejected) {
      const recorded = deps.store.recordRejectedQuestion({
        ideaId: request.idea.ideaId,
        briefId: brief.briefId,
        briefVersion: brief.version,
        topic: declined.topic,
        rejection: declined.rejection,
        explanation: declined.explanation,
        at: authoredAt,
      });
      if (!recorded.ok) return err(recorded.error);
      rejected.push({
        topic: declined.topic,
        rejection: declined.rejection,
        explanation: declined.explanation,
      });
    }

    return ok({
      mode: CLARIFICATION_MODE,
      engineVersion: run.value.engineVersion,
      sessionId: run.value.sessionId,
      brief,
      sectionNames: Object.freeze(BRIEF_SECTION_NAMES.map((name) => name as string)),
      questions,
      rejected,
      claims: claims.value.map((claim) => ({
        claimId: claim.claimId,
        subject: claim.subject,
        statement: claim.statement,
        inspectedRevision: claim.inspectedRevision,
        evidence: Object.freeze([...claim.evidence]),
        grounded: codeGroundedClaim(claim),
      })),
      promptCharacters: instruction.length,
      bounds,
      capability: profile,
    });
  };

  return { generateBrief };
}

export type BriefGenerationUseCases = ReturnType<typeof createBriefGenerationUseCases>;


/** The questions a brief still carries, which planning must not resolve by guessing. */
export function unresolvedQuestionsFor(brief: Brief): readonly string[] {
  return Object.freeze([...brief.sections.unresolvedQuestions]);
}
