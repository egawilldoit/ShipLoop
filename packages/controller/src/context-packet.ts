/**
 * The bounded, read-only context packet clarification runs on (F07-AC4, F07-AC5).
 *
 * A clarification pass is only useful if it knows what the repository actually says,
 * and it is only honest if it admits what it does not know. This module is the
 * boundary that produces the second property from the first:
 *
 *   - **A fact is recorded only as what was read.** Each captured fact names the
 *     reference it came from and, when it was inspected, the text that was actually
 *     read at a recorded full commit SHA. There is no field for "probably", so a
 *     guess has nowhere to travel (F07-AC4).
 *   - **A fact nobody inspected becomes `Unknown`, not a sentence.** The only input
 *     this module hands the domain's `codeGroundedClaim` for such a fact is an empty
 *     evidence list and a null revision, which is what makes the domain label the
 *     claim `Unknown` with a reason. Nothing here decides that label; it only refuses
 *     to manufacture the inputs that would remove it (F07-AC4).
 *   - **Repository facts must agree on one revision.** Two facts read at different
 *     commits describe two different codebases, so comparing them is refused by name
 *     rather than rendered into a picture of a repository that never existed
 *     (F07-AC4).
 *   - **The packet renders within a character budget.** Truncation names the facts it
 *     dropped, because a silently shortened context reads as a complete one
 *     (F07-AC2, F18-AC2).
 *   - **The capability profile travels with the packet.** `readOnlyCapabilityProfile`
 *     is carried as data so a caller can show what clarification may read, and so a
 *     test can assert that the profile exposes no mutating capability at all
 *     (F07-AC5).
 *
 * Nothing here reads a repository, contacts a provider or writes anything. The
 * inspections happened elsewhere and arrive as observations, which is what keeps this
 * layer testable against real captured data rather than a live checkout.
 */

import {
  codeGroundedClaim,
  err,
  invalid,
  isCommitSha,
  ok,
  readOnlyCapabilityProfile,
  redact,
} from '@shiploop/domain';
import type {
  ClaimEvidence,
  CodeClaim,
  CommitSha,
  DomainError,
  GroundedClaim,
  IdeaId,
  ReadOnlyCapabilityProfile,
  Result,
} from '@shiploop/domain';

/** Where a captured fact came from. */
export type ContextSourceKind =
  /** A versioned project-profile row this deployment captured. */
  | 'ProjectProfile'
  /** An instruction file read out of the repository at a recorded revision. */
  | 'RepositoryGuidance'
  /** A repository fact read at a recorded revision: head, checks, a named path. */
  | 'RepositoryState'
  /** What the owner already said in this conversation. */
  | 'OwnerConversation';

/**
 * Sources whose subject is the code, and which therefore cannot be grounded without
 * the commit they were read at.
 *
 * Naming them here rather than trusting a caller to supply a revision is what makes
 * "at a recorded revision" a rule of this layer rather than a convention of whoever
 * assembled the input (F07-AC4).
 */
export const REPOSITORY_CONTEXT_SOURCES: readonly ContextSourceKind[] = Object.freeze([
  'RepositoryGuidance',
  'RepositoryState',
] as const);

/** How a fact's own claim came out. Set by the domain, read here, never assigned. */
export type ContextAvailability = 'Grounded' | 'Unknown';

/** How much of a packet the engine is shown before the budget stops it. */
export const MAX_PACKET_CHARACTERS = 12_000;

/** The word a rendered packet uses for a fact nobody inspected (F07-AC4). */
export const UNKNOWN_MARKER = 'Unknown';

/** What was actually read, at the revision it was read. */
export interface ContextObservation {
  /** The text read. Never a paraphrase: a paraphrase is an inference. */
  readonly observed: string;
  /**
   * The full commit SHA the read happened at, or null for a source that is not the
   * code and therefore has no revision.
   */
  readonly inspectedRevision: string | null;
  readonly observedAt: string;
}

/**
 * One captured fact about the selected project.
 *
 * `observation` and `unknownReason` are the whole honesty rule in one union: a fact
 * carries either what was read or why nothing was read, never neither.
 */
export interface CapturedFact {
  readonly factId: string;
  readonly kind: ContextSourceKind;
  /** What the fact is about, in the owner's terms. */
  readonly subject: string;
  /** Where it came from: a row identity, a repository path, a turn. Never the content. */
  readonly reference: string;
  readonly observation: ContextObservation | null;
  /** Required exactly when `observation` is null (F07-AC4). */
  readonly unknownReason: string | null;
}

/** One grounded claim, with the reason it is not grounded when it is not. */
export interface ContextClaim {
  readonly claimId: string;
  readonly kind: ContextSourceKind;
  readonly subject: string;
  readonly reference: string;
  readonly availability: ContextAvailability;
  /** The recorded revision, or null when there is none (F07-AC4). */
  readonly revision: CommitSha | null;
  readonly evidence: readonly ClaimEvidence[];
  readonly unknowns: readonly string[];
  /** The domain's verdict on the grounding, verbatim (F07-AC4). */
  readonly reason: string | null;
  /** Why the capture recorded nothing, which is the operator's half of the answer. */
  readonly capturedReason: string | null;
  /** The text read. Null when nothing was read, which is what makes the claim Unknown. */
  readonly observed: string | null;
}

export interface ContextPacket {
  readonly packetId: string;
  readonly ideaId: IdeaId;
  readonly projectId: string | null;
  readonly assembledAt: string;
  /** The single revision every inspected repository fact was read at, or null. */
  readonly revision: CommitSha | null;
  readonly facts: readonly CapturedFact[];
  readonly claims: readonly ContextClaim[];
  /** Subjects no fact covers, which is as much a part of the answer as what it does (F07-AC4). */
  readonly unknownSubjects: readonly string[];
  /** The profile clarification runs under, as data (F07-AC5). */
  readonly capability: ReadOnlyCapabilityProfile;
}

export interface AssembleContextPacketInput {
  readonly packetId: string;
  readonly ideaId: IdeaId;
  /** The selected project, or null when the owner captured the request without one. */
  readonly projectId: string | null;
  readonly assembledAt: string;
  readonly facts: readonly CapturedFact[];
}

/** What the engine is shown, and what the budget left out. */
export interface RenderedContext {
  readonly text: string;
  readonly characterCount: number;
  readonly budget: number;
  /** Facts the budget dropped, named so a short packet is never read as a whole one. */
  readonly droppedFactIds: readonly string[];
}

function text(value: string | null | undefined): string {
  return value === null || value === undefined ? '' : value.trim();
}

/**
 * Assembles the packet, refusing every input that would let a guess through.
 *
 * All problems are returned at once because a caller assembling context from several
 * sources should not need one run per mistake (F07-AC4). Nothing here guesses a
 * revision, a summary or a reason: a fact that supplies none becomes `Unknown`
 * through the domain's own `codeGroundedClaim`, which is the only place that decision
 * is made.
 */
export function assembleContextPacket(input: AssembleContextPacketInput): Result<ContextPacket, DomainError> {
  const problems: { readonly path: string; readonly message: string }[] = [];

  if (text(input.packetId).length === 0) {
    problems.push({ path: 'packetId', message: 'A context packet records its own identity.' });
  }
  if (input.facts.length === 0) {
    problems.push({
      path: 'facts',
      message:
        'A clarification packet needs at least one captured fact. Record that nothing is known as a fact with an unknown reason rather than sending an empty packet (F07-AC4).',
    });
  }

  const seen = new Set<string>();
  const repositoryRevisions = new Map<string, string>();
  input.facts.forEach((fact, index) => {
    const at = `facts[${String(index)}]`;
    const factId = text(fact.factId);
    if (factId.length === 0) {
      problems.push({ path: `${at}.factId`, message: 'A captured fact needs an identity.' });
    } else if (seen.has(factId)) {
      problems.push({ path: `${at}.factId`, message: `Captured fact "${factId}" is listed twice.` });
    } else {
      seen.add(factId);
    }

    if (text(fact.subject).length === 0) {
      problems.push({ path: `${at}.subject`, message: 'A captured fact needs to say what it is about.' });
    }
    if (text(fact.reference).length === 0) {
      problems.push({
        path: `${at}.reference`,
        message: 'A captured fact names where it came from; content is never its own reference (F07-AC4).',
      });
    }

    const observation = fact.observation;
    if (observation === null) {
      if (text(fact.unknownReason).length === 0) {
        problems.push({
          path: `${at}.unknownReason`,
          message:
            'A fact nobody inspected must say why. Leaving it blank is how an unexamined guess becomes an answer (F07-AC4).',
        });
      }
      return;
    }

    if (text(observation.observed).length === 0) {
      problems.push({
        path: `${at}.observation.observed`,
        message: 'An inspected fact records what was read; an empty observation was not an inspection (F07-AC4).',
      });
    }
    if (text(observation.observedAt).length === 0) {
      problems.push({ path: `${at}.observation.observedAt`, message: 'An inspected fact records when it was read.' });
    }

    if (!REPOSITORY_CONTEXT_SOURCES.includes(fact.kind)) return;

    // A revision that is not a full commit SHA is not refused here: the domain already
    // encodes that a ref name or an abbreviation identifies no code and labels the claim
    // `Unknown` for it. Refusing the whole packet would duplicate that policy and lose the
    // label the owner needs. Only revisions that do identify a commit join the
    // consistency check below.
    const revision = text(observation.inspectedRevision);
    if (revision.length === 0 || !isCommitSha(revision)) return;
    if (factId.length > 0) repositoryRevisions.set(factId, revision);
  });

  const distinct = new Set(repositoryRevisions.values());
  if (distinct.size > 1) {
    const named = [...repositoryRevisions.entries()]
      .map(([factId, revision]) => `${factId} at ${revision.slice(0, 12)}`)
      .join(', ');
    problems.push({
      path: 'facts',
      message: `Repository facts were read at more than one revision (${named}), so they cannot be compared as one codebase (F07-AC4).`,
    });
  }

  if (problems.length > 0) {
    return err(invalid('The captured context cannot form a read-only context packet.', problems));
  }

  const onlyRevision = distinct.values().next().value;
  const revision = typeof onlyRevision === 'string' && isCommitSha(onlyRevision) ? onlyRevision : null;

  const facts = Object.freeze(input.facts.map((fact) => Object.freeze({ ...fact })));
  const claims = Object.freeze(facts.map((fact) => claimFor(fact)));  const unknownSubjects = Object.freeze(
    claims.filter((claim) => claim.availability === 'Unknown').map((claim) => claim.subject),
  );

  return ok<ContextPacket>(
    Object.freeze({
      packetId: text(input.packetId),
      ideaId: input.ideaId,
      projectId: input.projectId,
      assembledAt: input.assembledAt,
      revision,
      facts,
      claims,
      unknownSubjects,
      capability: readOnlyCapabilityProfile,
    }),
  );
}

/**
 * Grounds one fact's claim in the revision and evidence it actually has.
 *
 * The inputs are exactly two: evidence when something was read, and the recorded
 * revision when there is one. A fact with no observation therefore arrives with an
 * empty evidence list, which is what the domain turns into `state: 'Unknown'` with a
 * reason. Passing anything else here — a subject restated as a finding, a revision
 * borrowed from a neighbouring fact — would be inventing the answer this layer exists
 * to prevent (F07-AC4).
 */
function claimFor(fact: CapturedFact): ContextClaim {
  const observation = fact.observation;
  const evidence: readonly ClaimEvidence[] =
    observation === null
      ? []
      : [
          Object.freeze({
            kind: 'CodeLocation' as const,
            reference: text(fact.reference),
            observedAt: text(observation.observedAt),
          }),
        ];

  const claim: CodeClaim = {
    claimId: text(fact.factId),
    statement: observation === null ? '' : redact(text(observation.observed)).text,
    subject: text(fact.subject),
    inspectedRevision: observation?.inspectedRevision ?? null,
    evidence,
  };

  return describe(codeGroundedClaim(claim), fact);
}

/** Projects the domain's verdict onto the packet's own view of the same claim. */
function describe(grounded: GroundedClaim, fact: CapturedFact): ContextClaim {
  return Object.freeze({
    claimId: grounded.claimId,
    kind: fact.kind,
    subject: grounded.subject,
    reference: text(fact.reference),
    availability: grounded.state,
    revision: grounded.revision,
    evidence: Object.freeze([...grounded.evidence]),
    unknowns: Object.freeze([...grounded.unknowns]),
    reason: grounded.reason,
    capturedReason: fact.observation === null ? text(fact.unknownReason) : null,
    observed: grounded.state === 'Grounded' ? grounded.statement : null,
  });
}

/**
 * Renders the packet for a prompt, within the character budget.
 *
 * Every fact contributes a line, and a fact nobody inspected contributes a line that
 * says so rather than contributing nothing: an absent line is indistinguishable from a
 * fact that was never captured, which is exactly the inference this module refuses.
 * Facts the budget drops are named in a trailing line so a short render is never read
 * as a whole one (F07-AC4).
 */
export function renderContextPacket(packet: ContextPacket, budget: number = MAX_PACKET_CHARACTERS): RenderedContext {
  const limit = Math.max(0, budget);
  const header = [
    `context packet ${packet.packetId}`,
    `project: ${packet.projectId ?? 'none selected'}`,
    `recorded revision: ${packet.revision ?? 'none recorded'}`,
    `assembled at: ${packet.assembledAt}`,
  ];

  const lines: string[] = [];
  const dropped: string[] = [];
  let used = header.join('\n').length;
  for (const claim of packet.claims) {
    const line =
      claim.availability === 'Grounded'
        ? `- ${claim.subject} [${claim.kind} @ ${claim.revision ?? UNKNOWN_MARKER}, evidence: ${claim.evidence
            .map((entry) => entry.reference)
            .join(', ')}]: ${claim.observed ?? UNKNOWN_MARKER}`
        : `- ${claim.subject} [${claim.kind}]: ${UNKNOWN_MARKER} (${claim.reason ?? 'not inspected'}${
            claim.capturedReason === null ? '' : `; captured: ${claim.capturedReason}`
          })`;
    if (used + line.length + 1 > limit) {
      dropped.push(claim.claimId);
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }

  const rendered = [...header, ...lines];
  if (dropped.length > 0) {
    rendered.push(
      `- ${String(dropped.length)} further captured fact(s) were not rendered because of the ${String(limit)} character budget: ${dropped.join(', ')}`,
    );
  }
  const output = rendered.join('\n');
  return { text: output, characterCount: output.length, budget: limit, droppedFactIds: Object.freeze(dropped) };
}
