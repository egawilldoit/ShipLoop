/**
 * Executable plan proposals, generated from an agreed brief (F08-AC1, F08-AC2,
 * F08-AC3, F08-AC5, F05-AC2, F05-AC4, F05-AC5, F01-AC1, N02-AC2).
 *
 * A plan is generated, not written. This layer asks the engine a question and then
 * refuses to believe the answer until the domain has read it, which is why the
 * interesting code here is the refusals rather than the request.
 *
 * **The session is read-only by construction.** `PlanEngineRequest` can carry an
 * instruction, a workspace, an engine mode and a set of granted coding capabilities —
 * and nothing else. It has no publication, deployment or merge field, so generation has
 * no path to a delivery action even when the engine's text asks for one. The grants a
 * proposal session holds are the frozen empty list `PLAN_ENGINE_CAPABILITIES`, so a
 * plan-mode session reads and cannot write (F08-AC1, F07-AC5).
 *
 * **The model cannot set the record's identity.** The instant, the brief the plan
 * belongs to, the revision it supersedes and the outcomes the owner asked for come from
 * the agreed brief and the injected clock, never from the engine. A proposal that
 * restates the outcomes differently is refused by name rather than corrected, because a
 * plan that quietly adopted an outcome the owner did not ask for would be a plan of the
 * model's choosing (F08-AC5).
 *
 * **Coverage and split are asked, not assumed.** `coverageCheck` names every requested
 * outcome that neither a proposed task delivers nor an exclusion declares, and that
 * refusal reaches the caller unedited. `shouldSplit` decides whether the change has a
 * unit that justifies more than one task; a change that fails both of its tests must be
 * planned as a single task, which is the over-decomposition F08-AC2 exists to prevent.
 *
 * **Acceptance lives in the task's type.** Generation never calls `editPlan` and never
 * touches a ticket provider, so everything it produces is `Proposed` and
 * `publishableTickets` has nothing to hand publication. A generated plan that published
 * work would need an owner edit this file has no code for (F08-AC3).
 *
 * **Versioning is the generation's identity.** `planIdForGeneration` derives the plan
 * identity from the brief and the brief version, so a correction produces a *new* plan
 * while the earlier proposal stays readable through its own row — which is what makes
 * re-running generation after a correction safe rather than destructive (F07-AC3).
 */

import {
  applyPlanProposal,
  coverageCheck,
  err,
  fingerprint,
  invalid,
  ok,
  redact,
  shouldSplit,
} from '@shiploop/domain';
import type {
  Brief,
  ChangeShape,
  ConnectorId,
  DomainError,
  Fingerprint,
  IdeaId,
  OperationId,
  OutcomeCoverage,
  Plan,
  PlanProposal,
  ProcedureVersionId,
  ProjectId,
  ProviderId,
  RequestedOutcome,
  Result,
  SplitAdvice,
} from '@shiploop/domain';
import type {
  AdapterContext,
  CodingSessionCapability,
  EngineAdapter,
  EngineBounds,
  EngineEvent,
  EngineMode,
  EngineStartRequest,
  ExecutionWorkspace,
} from '@shiploop/adapters';
import type { ProcedureRepository, ProcedureStatus, ProjectProfileRepository } from '@shiploop/storage';
import type { PlanningUseCases } from './composition.ts';
import type { ControllerClock, OwnerActor } from './profiles.ts';
import { readRunInstructions } from './procedures.ts';

/* -------------------------------------------------------------------------- */
/* Plan mode                                                                    */
/* -------------------------------------------------------------------------- */

/** The only engine mode a plan proposal is produced in. */
export const PLAN_ENGINE_MODE: EngineMode = 'Headless';

/**
 * What a proposal session may do: nothing but read.
 *
 * Frozen and empty rather than "whatever the caller passed", because the property that
 * makes generation safe is the absence of a grant, and an absence the caller supplies is
 * an absence a caller can fill (F08-AC1, F03-AC5).
 */
export const PLAN_ENGINE_CAPABILITIES: readonly CodingSessionCapability[] = Object.freeze([]);

/**
 * Bounds every plan-mode session runs under (F18-AC2).
 *
 * Wall clock, retries and events are all named rather than left to the adapter, because
 * an unbounded plan session is a session that can hold a workspace instead of answering a
 * question.
 */
export const PLAN_ENGINE_BOUNDS: EngineBounds = Object.freeze({
  activeWallClockMs: 600_000,
  retryBudget: 1,
  eventCountLimit: 512,
});

/** One read-only plan-mode session against the configured engine. */
export interface PlanEngineRequest {
  readonly instruction: string;
  readonly workspace: ExecutionWorkspace;
  readonly mode: EngineMode;
  readonly grantedCapabilities: readonly CodingSessionCapability[];
  readonly bounds: EngineBounds;
}

/**
 * What one plan-mode session produced.
 *
 * The engine's **events** are kept rather than its raw text: the engine's own text never
 * becomes state (mvp-spec 7 "Engine"), and a run is auditable from the structured events
 * alone. The instruction is kept beside them, because a proposal nobody can trace to the
 * question that produced it is not reviewable.
 */
export interface PlanEngineRun {
  readonly connectorId: ConnectorId;
  readonly sessionId: ProviderId;
  readonly engineVersion: string;
  readonly instruction: string;
  readonly events: readonly EngineEvent[];
}

/**
 * The engine seam generation drives.
 *
 * One method, one mode. A process with no configured engine has no implementation of
 * this, and the use case below refuses by name rather than proposing a plan from
 * nothing (F03-AC2).
 */
export interface PlanEngine {
  propose(context: AdapterContext, request: PlanEngineRequest): Promise<Result<PlanEngineRun>>;
}

export interface PlanEngineFromAdapterOptions {
  /** Connector identity the session is attributed to; the adapter's own is used when absent. */
  readonly connectorId?: ConnectorId;
}

/**
 * Drives the real `EngineAdapter` contract in plan mode.
 *
 * This is the production seam: the shipped `CodexEngineAdapter` and the deterministic
 * `FakeEngineAdapter` are the same type here, so the default suite exercises the real
 * contract and a live run exercises the same call path against the real binary
 * (N05-AC2).
 *
 * Only the events are consumed, never the process. The handle is drained to its terminal
 * event, and a non-`Succeeded` outcome is reported as the engine's own refusal, because
 * a plan cannot be built out of a run that failed (F15-AC2).
 */
export function planEngineFromAdapter(adapter: EngineAdapter, options: PlanEngineFromAdapterOptions = {}): PlanEngine {
  return {
    async propose(context: AdapterContext, request: PlanEngineRequest): Promise<Result<PlanEngineRun>> {
      const start: EngineStartRequest = {
        operationId: context.operationId,
        workspace: request.workspace,
        start: { kind: 'Fresh', instruction: request.instruction },
        mode: request.mode,
        grantedCapabilities: request.grantedCapabilities,
        bounds: request.bounds,
      };
      const started = await adapter.startSession(context, start);
      if (!started.ok) return err(started.error);

      const events: EngineEvent[] = [];
      for await (const event of started.value.events) {
        events.push(event);
      }

      const terminal = events.findLast((event) => event.kind === 'Result');
      if (terminal === undefined || terminal.kind !== 'Result') {
        return err({
          code: 'Unavailable',
          reason: `The engine session ${started.value.sessionId} reported no terminal outcome, so no plan was proposed (F15-AC2).`,
        });
      }
      if (terminal.outcome.kind !== 'Succeeded') {
        return err({
          code: 'Unavailable',
          reason: `The engine session ${started.value.sessionId} ended as ${terminal.outcome.kind}: ${terminal.outcome.summary}`,
        });
      }

      return ok(
        Object.freeze({
          connectorId: options.connectorId ?? adapter.connectorId,
          sessionId: started.value.sessionId,
          engineVersion: started.value.engineVersion,
          instruction: request.instruction,
          events: Object.freeze(events),
        }),
      );
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The context packet (F05-AC2)                                                 */
/* -------------------------------------------------------------------------- */

/** One accepted procedure a future run already reads. */
export interface PlanContextProcedure {
  readonly subjectKey: string;
  readonly procedureVersionId: ProcedureVersionId;
  readonly versionNumber: number;
  readonly scope: string;
  readonly status: ProcedureStatus;
  readonly content: string;
}

/**
 * What the engine is told about the project beyond the brief.
 *
 * Every member is a fact something actually read: the ticket snapshot and the prior
 * feedback are handed in by the caller that holds those provider reads, and the
 * procedures come from `currentVersion`, which returns `Accepted` rows only. A version
 * that is merely proposed therefore cannot appear here, because it is not yet what a run
 * would read (F05-AC2, F05-AC4).
 */
export interface PlanContextPacket {
  readonly packetId: string;
  readonly briefId: string;
  readonly projectId: ProjectId | null;
  readonly ticketSnapshot: readonly string[];
  readonly procedures: readonly PlanContextProcedure[];
  readonly repositoryGuidance: readonly string[];
  readonly priorFeedback: readonly string[];
  /** Context considered and left out, so the exclusion is inspectable (F05-AC2). */
  readonly excluded: readonly string[];
  readonly fingerprint: Fingerprint;
}

export interface PlanContextRequest {
  readonly packetId: string;
  readonly briefId: string;
  readonly projectId: ProjectId | null;
  /** The procedure subjects this work touches; each is read as an accepted version. */
  readonly subjectKeys: readonly string[];
  /** Subjects that exist for the project but bear on nothing in this brief. */
  readonly unrelatedSubjectKeys: readonly string[];
  /** The current ticket snapshot, as lines the caller read from the ticket provider. */
  readonly ticketSnapshot: readonly string[];
  /** Retained owner feedback on earlier changes to this project. */
  readonly priorFeedback: readonly string[];
}

export interface PlanContextDeps {
  readonly clock: ControllerClock;
  readonly procedures: ProcedureRepository;
  readonly profiles: ProjectProfileRepository;
}

/**
 * Reads the context a plan is generated against (F05-AC2).
 *
 * Three properties are structural rather than conventional:
 *
 *   - procedures are read through `readRunInstructions`, so a `Proposed` version cannot
 *     reach the engine and a run's instructions cannot be changed by generation
 *     (F05-AC4);
 *   - repository guidance comes from the saved profile or is labelled as absent, so a
 *     missing profile reads as an unknown rather than as "nothing to know" (F07-AC4);
 *   - unrelated context is named in `excluded` rather than silently dropped, because a
 *     packet that quietly omits a fact cannot be reviewed against the facts it left out
 *     (F05-AC2).
 */
export function createPlanContextReader(deps: PlanContextDeps) {
  const read = (request: PlanContextRequest): Result<PlanContextPacket, DomainError> => {
    const procedures: PlanContextProcedure[] = [];
    if (request.projectId !== null) {
      for (const subjectKey of request.subjectKeys) {
        const instruction = readRunInstructions(deps.procedures, request.projectId, subjectKey);
        if (!instruction.ok) return err(instruction.error);
        const version = instruction.value;
        if (version === null) {
          return err({
            code: 'NotFound',
            reason: `Subject "${subjectKey}" has no accepted version for project ${request.projectId}, so a run would read nothing about it and this plan may not claim otherwise (F05-AC2).`,
          });
        }
        procedures.push({
          subjectKey: version.subjectKey,
          procedureVersionId: version.procedureVersionId,
          versionNumber: version.versionNumber,
          scope: version.scope,
          status: version.status,
          content: version.content,
        });
      }
    }

    const body = {
      packetId: request.packetId,
      briefId: request.briefId,
      projectId: request.projectId,
      ticketSnapshot: Object.freeze([...request.ticketSnapshot]),
      procedures: Object.freeze(procedures),
      repositoryGuidance: Object.freeze(repositoryGuidance(deps.profiles, request.projectId)),
      priorFeedback: Object.freeze([...request.priorFeedback]),
      excluded: Object.freeze([...request.unrelatedSubjectKeys]),
      observedAt: deps.clock.now(),
    };

    return ok<PlanContextPacket>(Object.freeze({ ...body, fingerprint: fingerprint(body) }));
  };

  return { read };
}

/**
 * The repository and target a saved profile names, or an explicit statement that none
 * was read. Never an empty list, which would read as a project with no repository
 * guidance rather than a project whose profile has not been saved (F07-AC4).
 */
function repositoryGuidance(profiles: ProjectProfileRepository, projectId: ProjectId | null): readonly string[] {
  if (projectId === null) {
    return ['No project is attached to this request, so no repository guidance was read.'];
  }
  const current = profiles.currentVersion(projectId);
  if (!current.ok || current.value === null) {
    return [`Project ${projectId} has no saved profile version, so no repository or target branch was read (F02-AC1).`];
  }
  const references: unknown = current.value.content.references;
  const repository = isRecord(references) ? references['repository'] : undefined;
  const targetBranch = isRecord(references) ? references['targetBranch'] : undefined;
  return [
    `Repository: ${typeof repository === 'string' ? repository : 'not named by the saved profile.'}`,
    `Delivery target: ${typeof targetBranch === 'string' ? targetBranch : 'not named by the saved profile.'}`,
  ];
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                   */
/* -------------------------------------------------------------------------- */

/** The brief's desired outcome as an outcome id, so it is addressable like a criterion. */
export const DESIRED_OUTCOME_ID = 'brief.desiredOutcome';

/**
 * The outcomes an agreed brief asks for.
 *
 * Derived from the brief rather than from the engine: the desired outcome and every
 * acceptance criterion are outcomes the owner asked for, and a plan that fails to cover
 * one of them is refused by name (F08-AC5).
 */
export function requestedOutcomesFor(brief: Brief): readonly RequestedOutcome[] {
  const outcomes: RequestedOutcome[] = [];
  const seen = new Set<string>();
  const add = (id: string, statement: string): void => {
    if (id.trim().length === 0 || statement.trim().length === 0 || seen.has(id)) return;
    seen.add(id);
    outcomes.push({ id, statement });
  };
  add(DESIRED_OUTCOME_ID, brief.sections.desiredOutcome);
  for (const criterion of brief.sections.acceptanceCriteria) add(criterion.id, criterion.text);
  return Object.freeze(outcomes);
}

/**
 * The plan identity one generation writes.
 *
 * Derived from the brief and its version, so a correction produces a new plan while the
 * earlier one stays readable rather than a second draft of one row that would discard the
 * owner's edits (F07-AC3).
 */
export function planIdForGeneration(briefId: string, briefVersion: number): string {
  return `plan_${briefId}_v${String(briefVersion)}`;
}

export interface GeneratePlanProposalInput {
  /** The brief to plan. It must already be agreed (F07-AC1, F08-AC1). */
  readonly brief: Brief;
  /** The project context the engine is told about (F05-AC2). */
  readonly contextPacket: PlanContextPacket;
  readonly engine: PlanEngine;
  readonly planId: string;
  /**
   * The change as it was read, which is what `shouldSplit` judges.
   *
   * A caller that has read no repository passes no surfaces: `shouldSplit` then says the
   * change stays one task, and a proposal asking for more than one is refused rather than
   * split on the model's word (F08-AC2).
   */
  readonly change: ChangeShape;
  /** null for a first plan, or the plan revision this proposal supersedes. */
  readonly basedOnRevision?: number | null;
  readonly workspace: ExecutionWorkspace;
  readonly actor: OwnerActor;
  readonly clock: ControllerClock;
  readonly bounds?: EngineBounds;
  readonly signal?: AbortSignal;
}

/** What one generation produced, before anything is stored. */
export interface GeneratedPlanProposal {
  readonly proposal: PlanProposal;
  readonly requestedOutcomes: readonly RequestedOutcome[];
  readonly split: SplitAdvice;
  readonly coverage: readonly OutcomeCoverage[];
  readonly contextFingerprint: Fingerprint;
  readonly run: PlanEngineRun;
}

/**
 * Asks the engine for an executable plan and refuses the answer until the domain has read
 * it (F08-AC1, F08-AC2, F08-AC5, F05-AC5).
 *
 * The order is the argument: check the owner, require an agreed brief, assemble the
 * question, run the read-only session, read the engine's text, validate the structure,
 * check the outcomes the model may not restate, check coverage, then check the split.
 * Nothing is stored here at all — this function's only effect is the engine session it
 * starts.
 */
export async function generatePlanProposal(input: GeneratePlanProposalInput): Promise<Result<GeneratedPlanProposal, DomainError>> {
  const permitted = requirePlanningOwner(input.actor);
  if (!permitted.ok) return err(permitted.error);

  const brief = input.brief;
  if (brief.state !== 'Agreed') {
    return err(
      invalid('A plan is generated from an agreed brief, and this one is still a proposal (F07-AC1, F08-AC1).', [
        {
          path: 'brief.state',
          message: `Brief ${brief.briefId} is at version ${String(brief.version)} and has not been agreed.`,
        },
      ]),
    );
  }
  if (input.planId.trim().length === 0) {
    return err(invalid('A plan needs an id.', [{ path: 'planId', message: 'A plan must have an id.' }]));
  }
  if (input.contextPacket.briefId !== brief.briefId) {
    return err({
      code: 'Conflict',
      reason: `The context packet was assembled for brief ${input.contextPacket.briefId}, not for ${brief.briefId} (F05-AC2).`,
      expected: brief.briefId,
      actual: input.contextPacket.briefId,
    });
  }

  const requested = requestedOutcomesFor(brief);
  const at = input.clock.now();
  const basedOnRevision = input.basedOnRevision ?? null;
  const instruction = planInstruction({
    brief,
    change: input.change,
    planId: input.planId,
    contextPacket: input.contextPacket,
    requestedOutcomes: requested,
    basedOnRevision,
  });

  const context: AdapterContext = {
    correlationId: `plan-generation:${input.planId}`,
    operationId: `plan-generation:${input.planId}:${at}` as OperationId,
    clock: { now: (): string => input.clock.now(), elapsedMs: (): number => 0 },
    logger: { emit: () => undefined },
    signal: input.signal ?? new AbortController().signal,
    redact: (text: string): string => redact(text).text,
  };

  const run = await input.engine.propose(context, {
    instruction,
    workspace: input.workspace,
    mode: PLAN_ENGINE_MODE,
    grantedCapabilities: PLAN_ENGINE_CAPABILITIES,
    bounds: input.bounds ?? PLAN_ENGINE_BOUNDS,
  });
  if (!run.ok) return err(run.error);

  const decoded = decodePlanProposal(engineTextOf(run.value));
  if (!decoded.ok) return err(decoded.error);

  // A proposal that names another brief is refused rather than restamped: the engine
  // answering for work this is not would be a plan of the model's choosing (F08-AC1).
  const declaredBriefId = isRecord(decoded.value) ? decoded.value['briefId'] : undefined;
  if (typeof declaredBriefId === 'string' && declaredBriefId.trim().length > 0 && declaredBriefId !== brief.briefId) {
    return err({
      code: 'Conflict',
      reason: `The engine proposed a plan for brief ${declaredBriefId}, which is not the brief being planned (F08-AC1).`,
      expected: brief.briefId,
      actual: declaredBriefId,
    });
  }

  // The record's instant and revision are facts of this run and the brief's identity is the
  // owner's; neither is a statement the model gets to make. What stays is what the engine
  // wrote, so the stored proposal replays through `applyPlanProposal` unchanged.
  const proposal = Object.freeze({
    ...(decoded.value as Record<string, unknown>),
    briefId: brief.briefId,
    draftedAt: at,
    basedOnRevision,
  }) as unknown as PlanProposal;

  const validated = applyPlanProposal(proposal);
  if (!validated.ok) return err(validated.error);

  const restated = outcomeDisagreements(requested, validated.value.requestedOutcomes);
  if (restated.length > 0) {
    return err(
      invalid('A plan may not restate the outcomes the owner asked for (F08-AC5).', restated.map((message) => ({ path: 'requestedOutcomes', message }))),
    );
  }

  const coverage = coverageCheck(requested, validated.value.tasks, validated.value.exclusions);
  if (!coverage.ok) {
    return err(
      invalid(
        'The proposed plan leaves a requested outcome covered by neither a proposed task nor an explicit exclusion, so no plan was generated (F08-AC5).',
        coverage.error.code === 'Invalid' ? coverage.error.fields.map((entry) => ({ path: entry.path, message: entry.message })) : [],
      ),
    );
  }

  const split = shouldSplit(input.change);
  if (!split.split && validated.value.tasks.length !== 1) {
    return err(
      invalid('The proposed plan splits a change that is one reviewable task (F08-AC2).', [
        { path: 'tasks', message: `${split.reason} The proposal asks for ${String(validated.value.tasks.length)} tasks.` },
      ]),
    );
  }

  return ok<GeneratedPlanProposal>(
    Object.freeze({
      // The stamped engine proposal, not the validated tasks: a stored trail is replayed
      // through `applyPlanProposal`, and a validated task carries the acceptance this plan
      // deliberately has none of (F08-AC3).
      proposal,
      requestedOutcomes: requested,
      split,
      coverage: coverage.value.coverage,
      contextFingerprint: input.contextPacket.fingerprint,
      run: run.value,
    }),
  );
}

/**
 * The one owner gate this feature area shares (F01-AC1).
 *
 * A proposal session spends engine budget and produces a plan row, so it is the owner's
 * action; nothing here reads a private row before the role is checked.
 */
export function requirePlanningOwner(actor: OwnerActor): Result<true, DomainError> {
  if (actor.role !== 'Owner' || actor.ownerId === null) {
    return err({
      code: 'Forbidden',
      reason: `Only the owner may generate a plan; the ${actor.role} role may not (F01-AC1).`,
    });
  }
  return ok(true);
}

/* -------------------------------------------------------------------------- */
/* Reading and shaping the engine's answer                                     */
/* -------------------------------------------------------------------------- */

/**
 * The engine's own text, assembled from its structured events.
 *
 * Two places hold it, and both are read. A `Progress` summary is where an adapter that
 * reports the engine's message as progress keeps it, and the terminal `Succeeded` summary
 * is the adapter's own definition of the engine's answer; an adapter that keeps only one
 * of them must not read as silent. Text carrying an artifact is skipped and the engine's
 * "no code change" report is skipped, because neither is an answer to the question that
 * was asked (F15-AC2).
 *
 * Each shipped adapter may cap a summary — the Codex adapter truncates one to 400
 * characters — which is why an answer cut off mid-object is refused as incomplete
 * structured output below rather than stored as half a plan.
 */
export function engineTextOf(run: PlanEngineRun): string {
  const parts: string[] = [];
  for (const event of run.events) {
    if (event.kind !== 'Progress') continue;
    if (event.detail !== null) continue;
    if (event.milestoneKey === 'no-code-change') continue;
    parts.push(event.summary);
  }
  const terminal = run.events.findLast((event) => event.kind === 'Result');
  if (terminal !== undefined && terminal.kind === 'Result' && terminal.outcome.kind === 'Succeeded') {
    parts.push(terminal.outcome.summary);
  }
  return parts.join('\n');
}

/**
 * The proposal object inside the engine's text, decoded.
 *
 * Only the outermost braces are read, so a sentence of prose around the object need not
 * be parsed, and the redaction runs here — at the point the text is produced — so a
 * credential the engine echoed cannot reach a stored row, a log or a refusal (N02-AC2).
 * Text that carries no object, or an object that is not JSON, is a recoverable `Invalid`
 * naming the field, because the engine's text is the only input this boundary has to
 * reject (F05-AC5).
 */
export function decodePlanProposal(text: string): Result<unknown, DomainError> {
  const redacted = redact(text).text;
  const start = redacted.indexOf('{');
  const end = redacted.lastIndexOf('}');
  if (start >= 0 && end < start) {
    return err(
      invalid('The engine returned a plan proposal that was cut off before it closed (F05-AC5).', [
        {
          path: 'engineText',
          message:
            `The object the engine returned never closes: an adapter that caps a reported message truncates a plan longer than that cap. ` +
            `Ask for a shorter proposal, or read the engine's output where the adapter keeps it whole. The answer began: ${excerpt(redacted)}`,
        },
      ]),
    );
  }
  if (start < 0) {
    return err(
      invalid('The engine returned no structured plan proposal (F05-AC5).', [
        { path: 'engineText', message: `Expected one JSON object in the engine's answer and found none in: ${excerpt(redacted)}` },
      ]),
    );
  }
  try {
    return ok(JSON.parse(redacted.slice(start, end + 1)) as unknown);
  } catch (error) {
    return err(
      invalid('The engine returned a plan proposal that is not readable JSON (F05-AC5).', [
        {
          path: 'engineText',
          message: `The object the engine returned could not be parsed: ${excerpt(redacted)} (${error instanceof Error ? error.message : String(error)})`,
        },
      ]),
    );
  }
}

/** A bounded excerpt of engine text, for a refusal that must not quote a whole stream. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 200)}...`;
}

/** Where the engine's restatement of the owner's outcomes differs from the brief's. */
function outcomeDisagreements(expected: readonly RequestedOutcome[], proposed: readonly RequestedOutcome[]): readonly string[] {
  const problems: string[] = [];
  for (const outcome of expected) {
    const match = proposed.find((candidate) => candidate.id === outcome.id);
    if (match === undefined) {
      problems.push(`Requested outcome "${outcome.id}" is missing from the proposal.`);
      continue;
    }
    if (match.statement !== outcome.statement) {
      problems.push(`Requested outcome "${outcome.id}" is restated as "${match.statement}" rather than the agreed wording.`);
    }
  }
  for (const outcome of proposed) {
    if (!expected.some((candidate) => candidate.id === outcome.id)) {
      problems.push(`"${outcome.id}" is not an outcome the agreed brief asks for.`);
    }
  }
  return problems;
}

/**
 * The question the engine is asked.
 *
 * It states the field names F08-AC1 names, the change as it was read, the coverage rule
 * F08-AC5 states, and the three things the engine may not do: change the repository,
 * accept anything, or claim a location as a fact. A refusal here is cheaper than a
 * proposal the domain then has to reject field by field (F05-AC5).
 */
export function planInstruction(input: {
  readonly brief: Brief;
  readonly change: ChangeShape;
  readonly planId: string;
  readonly contextPacket: PlanContextPacket;
  readonly requestedOutcomes: readonly RequestedOutcome[];
  readonly basedOnRevision: number | null;
}): string {
  const brief = input.brief;
  return [
    'ShipLoop plan mode. Read only: do not change the repository, publish anything, or run a delivery action.',
    'Answer with exactly one JSON object and no prose.',
    '',
    `brief: ${brief.briefId} (version ${String(brief.version)})`,
    `planId: ${input.planId}`,
    `basedOnRevision: ${input.basedOnRevision === null ? 'null' : String(input.basedOnRevision)}`,
    '',
    'Agreed brief:',
    `- problem: ${brief.sections.problem}`,
    `- desired outcome: ${brief.sections.desiredOutcome}`,
    `- included behaviour: ${listed(brief.sections.includedBehaviour)}`,
    `- excluded behaviour: ${listed(brief.sections.excludedBehaviour)}`,
    `- assumptions: ${listed(brief.sections.assumptions)}`,
    `- acceptance criteria: ${
      brief.sections.acceptanceCriteria
        .map((criterion) => `${criterion.id} = ${criterion.text}${criterion.verification === null ? '' : ` (verify: ${criterion.verification})`}`)
        .join('; ') || 'none'
    }`,
    `- unresolved questions: ${listed(brief.sections.unresolvedQuestions)}`,
    '',
    'Requested outcomes, copied verbatim into "requestedOutcomes":',
    ...(input.requestedOutcomes.length === 0 ? ['- none'] : input.requestedOutcomes.map((outcome) => `- ${outcome.id}: ${outcome.statement}`)),
    '',
    'The change, as it was read:',
    `- summary: ${input.change.summary}`,
    `- surfaces: ${listed(input.change.surfaces.map((surface) => `${surface.surfaceId}: ${surface.description}`))}`,
    `- dependency edges: ${listed(input.change.dependencyEdges.map((edge) => `${edge.surface} depends on ${edge.dependsOn}`))}`,
    '',
    'Project context (context packet):',
    `- packet: ${input.contextPacket.packetId}`,
    `- ticket snapshot: ${listed(input.contextPacket.ticketSnapshot)}`,
    `- procedures: ${listed(
      input.contextPacket.procedures.map((procedure) => `${procedure.subjectKey} v${String(procedure.versionNumber)} (${procedure.status}): ${procedure.content}`),
    )}`,
    `- repository guidance: ${listed(input.contextPacket.repositoryGuidance)}`,
    `- prior feedback: ${listed(input.contextPacket.priorFeedback)}`,
    `- excluded as unrelated: ${listed(input.contextPacket.excluded)}`,
    '',
    'Reply with this exact shape:',
    '{ "kind": "PlanProposal", "briefId": <brief id above>, "basedOnRevision": <as given>,',
    '  "requestedOutcomes": [ { "id": ..., "statement": ... } ],',
    '  "tasks": [ { "taskId": ..., "coversOutcomeIds": [ ... ],',
    '    "outcome": ..., "scope": ..., "acceptanceCriteria": [ ... ], "verificationMethod": ...,',
    '    "dependencies": [ ...task ids... ], "relevantProjectContext": [ ... ],',
    '    "implementationLocation": { "kind": "ProposedLocation", "candidates": [ ... ], "basis": ... } } ],',
    '  "exclusions": [ { "outcomeId": ..., "excluded": ..., "reason": ... } ] }',
    '',
    "Rules: every requested outcome is covered by a task's coversOutcomeIds or by an exclusion.",
    'Every proposed task carries all seven fields; a task may name another task id in "dependencies".',
    'A proposed task stays a proposal: this plan has no field for acceptance, delivery or release,',
    'and an implementation location is a suggestion with its basis, never a certainty (F08-AC5).',
  ].join('\n');
}

function listed(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join('; ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* -------------------------------------------------------------------------- */
/* Storing what was generated                                                   */
/* -------------------------------------------------------------------------- */

export interface PlanGenerationDeps {
  readonly clock: ControllerClock;
  /** The existing planning lifecycle; generation stores through it rather than beside it. */
  readonly planning: PlanningUseCases;
  readonly engine: PlanEngine;
  readonly bounds?: EngineBounds;
  /** Bound when the caller wants this use case to assemble context packets itself (F05-AC2). */
  readonly readContextPacket?: (request: PlanContextRequest) => Result<PlanContextPacket, DomainError>;
}

export interface GenerateAndStoreInput {
  readonly brief: Brief;
  readonly contextPacket: PlanContextPacket;
  readonly ideaId: IdeaId;
  readonly change: ChangeShape;
  readonly workspace: ExecutionWorkspace;
  readonly actor: OwnerActor;
  /** Derived from the brief and its version unless the caller names one (F07-AC3). */
  readonly planId?: string;
  /**
   * The plan revision this proposal supersedes.
   *
   * Absent takes the newest revision this idea already holds, which is what makes a second
   * generation the next revision rather than a duplicate of the first (F07-AC3).
   */
  readonly basedOnRevision?: number | null;
}

/** What a generation produced and stored, with the stored plan beside the proposal. */
export interface StoredPlanProposal extends GeneratedPlanProposal {
  readonly plan: Plan;
  readonly planId: string;
}

export interface PlanGenerationUseCases {
  /** F08-AC1, F08-AC2, F08-AC5, F05-AC5: generate, validate and store a plan proposal. */
  readonly generateAndStorePlanProposal: (input: GenerateAndStoreInput) => Promise<Result<StoredPlanProposal, DomainError>>;
  /** The context a plan would be generated against, for the owner to inspect (F05-AC2). */
  readonly contextPacketFor: (request: PlanContextRequest) => Result<PlanContextPacket, DomainError>;
}

/**
 * Binds generation to the durable planning lifecycle.
 *
 * The stored trail is written by the same `draftPlan` that records an owner-authored plan,
 * so a generated proposal and a hand-written one replay identically and a later owner edit
 * applies to either. Generation adds no acceptance, and it calls nothing that publishes,
 * deploys or merges: the only row it can write is one plan (F08-AC1, F08-AC3).
 */
export function createPlanGenerationUseCases(deps: PlanGenerationDeps): PlanGenerationUseCases {
  const generateAndStorePlanProposal = async (input: GenerateAndStoreInput): Promise<Result<StoredPlanProposal, DomainError>> => {
    const permitted = requirePlanningOwner(input.actor);
    if (!permitted.ok) return err(permitted.error);

    const planId = input.planId ?? planIdForGeneration(input.brief.briefId, input.brief.version);
    const supersedes =
      input.basedOnRevision === undefined ? await newestRevisionFor(deps, input.ideaId) : ok<number | null>(input.basedOnRevision);
    if (!supersedes.ok) return err(supersedes.error);
    const generated = await generatePlanProposal({
      brief: input.brief,
      contextPacket: input.contextPacket,
      engine: deps.engine,
      planId,
      change: input.change,
      basedOnRevision: supersedes.value,
      workspace: input.workspace,
      actor: input.actor,
      clock: deps.clock,
      ...(deps.bounds === undefined ? {} : { bounds: deps.bounds }),
    });
    if (!generated.ok) return err(generated.error);

    const drafted = deps.planning.draftPlan({
      ideaId: input.ideaId,
      planId,
      change: input.change,
      proposal: generated.value.proposal,
      actor: input.actor.actorId,
    });
    if (!drafted.ok) return err(drafted.error);

    return ok<StoredPlanProposal>(Object.freeze({ ...generated.value, plan: drafted.value, planId }));
  };

  const contextPacketFor = (request: PlanContextRequest): Result<PlanContextPacket, DomainError> => {
    const read = deps.readContextPacket;
    if (read === undefined) {
      return err({
        code: 'Unavailable',
        reason: 'No context packet reader was bound, so this use case cannot assemble the project context a plan is generated against (F05-AC2).',
      });
    }
    return read(request);
  };

  return { generateAndStorePlanProposal, contextPacketFor };
}

/**
 * The newest plan revision an idea already holds, or null when it has none.
 *
 * Read from the planning lifecycle rather than assumed, so a second generation of the same
 * idea becomes the next revision of the same decision chain instead of colliding with the
 * first (F07-AC3).
 */
async function newestRevisionFor(deps: PlanGenerationDeps, ideaId: IdeaId): Promise<Result<number | null, DomainError>> {
  const listed = deps.planning.listPlansForIdea(ideaId);
  if (!listed.ok) return err(listed.error);
  const newest = listed.value[0];
  return ok(newest === undefined ? null : newest.revision);
}