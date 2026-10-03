/**
 * Candidate routes: link a GitHub pull request, read the candidate, refresh it.
 *
 * The MVP journey is `Request → Delivery Contract → External execution → GitHub
 * Candidate → Verification → Owner Decision`, and this file is the transport for its
 * fourth step. The rules below are not decoration: each one exists because there is a
 * specific wrong answer it makes unreachable.
 *
 *   - **Only a full commit SHA is identity, and the body cannot supply one.**
 *     `linkCandidateBody` has no head-SHA field, no branch field and no pull-request-number
 *     field. Identity is read from the provider and nothing else, so a client cannot
 *     record "PR 7" or `task/x` as the candidate and inherit whatever the provider points
 *     at on the next read (SHARED.md, "Candidate"; mvp-spec 3).
 *   - **A provider state this product cannot read stays unread.**
 *     `narrowProviderState` refuses a state outside `PULL_REQUEST_STATES` instead of
 *     defaulting it, and `reviewReadiness` is re-derived here from the live facts rather
 *     than trusted, so nothing outside the vocabulary can be laundered into `Open`, into a
 *     ready card, or into a persisted candidate. The shipped adapter already maps an
 *     unrecognised `state` to `Closed` and never to `Open`; this layer does not undo that,
 *     and it does not widen it either (mvp-spec F20-AC2).
 *   - **A required check that is missing, skipped or unread blocks.**
 *     `blocking` is computed per check with the domain's own `isBlocking`, and the
 *     transport's `checksReady` is derived from that. A port that claims readiness its own
 *     check results do not support is refused with a `503` rather than answered.
 *   - **A changed head invalidates the previous answer.**
 *     The read and the refresh both report `change` and `evidence`, where
 *     `priorEvidenceStale` comes from the same read and `priorReadinessPreserved` is the
 *     literal `false`. A view cannot carry a ready status across a force push, because
 *     readiness is derived from this read and from nothing stored (mvp-spec F20-AC3, F24-AC4,
 *     F25-AC3).
 *   - **Read-only, structurally.** This file has no method through which the provider could
 *     be merged, closed, approved, retargeted or re-protected. `CANDIDATE_METHODS` is the
 *     whole port, a test asserts the registered surface is exactly these three routes, and
 *     every response carries `providerWritePerformed: false` as a literal, so a renderer
 *     cannot read a merge out of a candidate card (mvp-spec F03-AC5).
 *   - **Project-scoped, with the project proven twice.** The project travels in the path,
 *     the owner comes from the proved session rather than the body, and a report whose
 *     `projectId` disagrees with the path is refused instead of returned (F02-AC2).
 *
 * Reused rather than rewritten: `parseGitHubPullRequestUrl`, `sameGitHubRepository` and
 * the repository comparison live in the domain and are called by the controller;
 * `PULL_REQUEST_STATES` comes from `domain/candidate-link.ts`, `isCommitSha` from
 * `domain/ids.ts`, `isBlocking` and `CHECK_RESULTS` from `domain/evidence.ts`; and the
 * whole provider read happens behind the controller's `CandidateGitPort`. This file parses
 * no URL, validates no SHA of its own accord and speaks to GitHub never.
 *
 * The port below is resolved from the injected controller surface through
 * `candidateUseCasesOf`. A deployment whose controller composes no candidate port answers
 * every route with a stated `503` naming the missing wiring rather than a `404` that would
 * read as "this project has no candidate" — a different and wrong claim about the
 * project's contents (F02-AC4).
 */

import { CHECK_RESULTS, PULL_REQUEST_STATES, isBlocking, isCommitSha } from '@shiploop/domain';
import type { DomainError, OwnerId, Result } from '@shiploop/domain';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  fieldErrorsOf,
  fieldsProblem,
  parseBody,
  problemFor,
  sendProblem,
  signInRequiredProblem,
} from '../http-error.ts';
import type { SessionGuard } from '../auth-guard.ts';
import type { ControllerSurface } from '../contracts.ts';

/* -------------------------------------------------------------------------- */
/* Vocabulary the domain already owns                                           */
/* -------------------------------------------------------------------------- */

/**
 * A pull request state this product has words for.
 *
 * The domain's own three. Deliberately not a wider union: an unrecognised provider state
 * is refused at the boundary below rather than given a fourth name here, because inventing
 * the name is how an unknown becomes a known one (mvp-spec F20-AC2).
 */
export type ProviderPullRequestState = (typeof PULL_REQUEST_STATES)[number];

/**
 * A check result this product has words for: the domain's six states.
 *
 * A result outside them is refused rather than mapped onto `Passed` or onto any other state
 * (mvp-spec F20-AC2).
 */
export type ProviderCheckResult = (typeof CHECK_RESULTS)[number];

/* -------------------------------------------------------------------------- */
/* The port this transport declares                                            */
/* -------------------------------------------------------------------------- */

/**
 * Linking the pull request the owner named.
 *
 * `pullRequestUrl` is the whole of what the owner supplies about the code. There is no head
 * SHA, no branch and no state in this command, because none of them is the owner's to
 * assert: the provider owns them, and a field here would be a second opinion about
 * identity.
 */
export interface LinkCandidateCommand {
  readonly projectId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly pullRequestUrl: string;
  /**
   * The base branch the project expects a candidate to land on, or null for none.
   *
   * The transport always sends null. The expectation is project configuration the
   * composition root resolves from the profile, so a request cannot assert what the project
   * expects — the same reason the repository is never taken from a second parameter that
   * could disagree with the one the profile names.
   */
  readonly expectedBaseBranch: string | null;
  readonly correlationId: string;
  /** The owner the session proved. Never read from the body (F01-AC1). */
  readonly actor: OwnerId;
}

/**
 * Reading one candidate, by its own identity, inside one project.
 *
 * `readCandidate` is the currency read: the implementation answers it by reading the
 * provider rather than by returning the stored row, so a caller is always looking at an
 * observation and never at a cache that happened to agree with the last one
 * (mvp-spec F24-AC4).
 */
export interface ReadCandidateCommand {
  readonly projectId: string;
  readonly candidateId: string;
  readonly correlationId: string;
  readonly actor: OwnerId;
}

/**
 * The recorded candidate, as the transport reports it. Both SHAs at full length.
 *
 * `pullRequestState` is the provider's spelling rather than free text: it arrived from
 * outside, and `narrowProviderState` checks it against `PULL_REQUEST_STATES` before it can
 * reach a response. The type is the narrowed union so a consumer of this file cannot build
 * a card from a state the product has no name for.
 */
export interface RecordedCandidateReport {
  readonly candidateId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly provider: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly pullRequestState: ProviderPullRequestState;
  readonly draft: boolean;
  readonly observedAt: string;
  readonly linkedAt: string;
}

/** What the provider said during this read, alongside the row ShipLoop holds. */
export interface LiveCandidateReport {
  readonly provider: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly headSha: string;
  /** Repository the head branch lives in; a fork's name when the provider reports one. */
  readonly headRepository: string | null;
  readonly pullRequestState: ProviderPullRequestState;
  readonly draft: boolean;
  readonly observedAt: string;
}

/** The `(contract revision, head SHA)` pair every piece of evidence must name. */
export interface CandidateBindingReport {
  readonly contractId: string;
  readonly contractRevision: number;
  readonly headSha: string;
}

/** What this read observed about the difference between the record and the provider. */
export interface CandidateChangeReport {
  readonly kind: string;
  readonly changed: readonly string[];
  readonly changedAnything: boolean;
  readonly previousHeadSha: string | null;
  readonly currentHeadSha: string;
  readonly priorEvidenceStale: boolean;
  readonly detail: string;
}

/**
 * What the verification layer needs in order to treat earlier results as stale.
 *
 * `priorReadinessPreserved` is the literal `false` on every response, including an
 * unchanged one: this transport holds no stored readiness to carry forward, so the field
 * states a property rather than reporting a value that could drift (mvp-spec F24-AC4,
 * F25-AC3).
 */
export interface EvidenceStandingReport {
  readonly status: 'Current' | 'Stale';
  readonly priorReadinessPreserved: false;
  readonly priorCandidateId: string | null;
  readonly priorHeadSha: string | null;
  readonly detail: string;
}

/** One check as the candidate view presents it, in the domain's result vocabulary. */
export interface CandidateCheckReport {
  readonly name: string;
  readonly result: ProviderCheckResult;
  readonly required: boolean;
  /** Whether this result blocks. Computed with the domain's own `isBlocking`. */
  readonly blocking: boolean;
  readonly notApplicableApprovedByPolicy: boolean;
  readonly observedHeadSha: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly artifactUrl: string | null;
  readonly detail: string | null;
}

/** Whether this candidate can be decided on, and every reason when it cannot. */
export interface CandidateReadinessReport {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

/** What a successful link established. Carries no readiness answer at all. */
export interface LinkedCandidateReport {
  readonly candidate: RecordedCandidateReport;
  readonly live: LiveCandidateReport;
  readonly binding: CandidateBindingReport;
  readonly bindingFingerprint: string;
  /** True when this exact identity was already recorded, so nothing new was written. */
  readonly alreadyRecorded: boolean;
  readonly observedAt: string;
  /** Always false: linking reads the provider and changes nothing there. */
  readonly providerWritePerformed: false;
}

/** One candidate as the owner reads it, from one live read. */
export interface CandidateReport {
  readonly candidate: RecordedCandidateReport;
  readonly live: LiveCandidateReport;
  readonly binding: CandidateBindingReport;
  readonly bindingFingerprint: string;
  readonly change: CandidateChangeReport;
  readonly evidence: EvidenceStandingReport;
  readonly supersededCandidateIds: readonly string[];
  readonly checks: readonly CandidateCheckReport[];
  /** About checks only, and derived here from `checks` rather than copied. */
  readonly checksReady: boolean;
  readonly blockingChecks: readonly string[];
  readonly reviewReadiness: CandidateReadinessReport;
  readonly observedAt: string;
  /** Always false: no merge, close, approval or protection change happened (mvp-spec F03-AC5). */
  readonly providerWritePerformed: false;
}

/**
 * The whole candidate port this transport depends on.
 *
 * Two members: one writes a ShipLoop row, one reads. There is no `merge`, `close`,
 * `approve`, `retarget` or `setBranchProtection` to call, which is how "this MVP reads the
 * provider and never changes it" is a property of the type rather than of a reviewer's
 * memory (SHARED.md, out of scope).
 */
export interface CandidateUseCases {
  linkCandidate(command: LinkCandidateCommand): Promise<Result<LinkedCandidateReport, DomainError>>;
  readCandidate(command: ReadCandidateCommand): Promise<Result<CandidateReport, DomainError>>;
}

/**
 * Every member the candidate port carries.
 *
 * Listed as data so `candidates.test.ts` can assert the port has not grown a write, the
 * same way the adapter's own member list is asserted. Widening this by one method fails a
 * test rather than shipping a capability nobody reviewed.
 */
export const CANDIDATE_METHODS = ['linkCandidate', 'readCandidate'] as const;

/**
 * The candidate port on an injected controller surface, or null.
 *
 * A runtime check rather than a bare property access, because the controller surface is
 * loaded from a module specifier at startup and is therefore external input: a deployment
 * that composes no candidate port must produce a stated refusal on these routes, not a
 * `TypeError` and not a silent success. It is the one cast in this file, and it happens
 * here rather than at each use site so there is a single place to widen.
 */
export function candidateUseCasesOf(controller: ControllerSurface): CandidateUseCases | null {
  const carrier = controller as { readonly candidates?: unknown };
  const candidate = carrier.candidates;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const port = candidate as Record<string, unknown>;
  return CANDIDATE_METHODS.every((method) => typeof port[method] === 'function')
    ? (candidate as CandidateUseCases)
    : null;
}

/* -------------------------------------------------------------------------- */
/* Request schemas                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A project identity.
 *
 * Identical to `routes/contracts.ts`: the value addresses a workspace and a git checkout
 * downstream, so a traversal here is a traversal there (F06-AC1).
 */
const projectIdentifier = z
  .string()
  .trim()
  .min(1, 'A project id is required.')
  .max(128, 'A project id may be at most 128 characters.')
  .refine(
    (value) => !/[/\\]/.test(value) && !value.includes('..'),
    'A project id may not contain a path separator or "..".',
  );

const projectParams = z.strictObject({ projectId: projectIdentifier });

const candidateParams = z.strictObject({
  projectId: projectIdentifier,
  candidateId: z
    .string()
    .trim()
    .min(1, 'A candidate id is required.')
    .max(128, 'A candidate id may be at most 128 characters.'),
});

/**
 * What a link request may say.
 *
 * Four fields, and the absence of more is the point. There is no `headSha`, no
 * `headBranch`, no `pullRequestNumber`, no `pullRequestState` and no `merge` — a body
 * carrying any of them is refused by name rather than silently ignored, because a client
 * that believes it named the identity should be told that identity is not the client's to
 * name (mvp-spec 3, SHARED.md "Candidate").
 */
const linkCandidateBody = z.strictObject({
  requestId: z
    .string()
    .trim()
    .min(1, 'A candidate answers a request, so name the request it implements.')
    .max(128, 'A request id may be at most 128 characters.'),
  contractId: z
    .string()
    .trim()
    .min(1, 'A candidate is bound to the contract revision it implements, so name the contract.')
    .max(128, 'A contract id may be at most 128 characters.'),
  contractRevision: z
    .number({ error: 'A contract revision is a number.' })
    .int('A contract revision is a whole number.')
    .min(1, 'Contract revisions start at 1.'),
  pullRequestUrl: z
    .string()
    .trim()
    .min(1, 'Paste the pull request address from the browser.')
    .max(2048, 'That address is too long to be a pull request link.'),
});

/**
 * A refresh carries nothing.
 *
 * `strictObject({})` and not an absent schema, matching `approveRevision`: a body that
 * tried to say what changed, or to name a head, is refused rather than dropped. The provider
 * decides what changed and this route reports it. `nullish` accepts an absent body, because a
 * refresh has nothing to submit and refusing a POST that sent nothing would be an obstacle
 * rather than a protection.
 */
const refreshBody = z.strictObject({}).nullish();

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The owner a request proved.
 *
 * Local rather than shared: reads are behind the guard, so a null session is a wiring fault
 * rather than an expected outcome, and substituting an empty identity would hand the use
 * case a caller nobody is (F01-AC1).
 */
function provedOwnerOf(
  request: { readonly session: { readonly ownerId: OwnerId } | null },
  reply: FastifyReply,
): OwnerId | null {
  if (request.session !== null) return request.session.ownerId;
  sendProblem(reply, signInRequiredProblem());
  return null;
}

export interface CandidateRouteOptions {
  readonly controller: ControllerSurface;
  readonly guard: SessionGuard;
  readonly now: () => Date;
}

export function registerCandidateRoutes(app: FastifyInstance, options: CandidateRouteOptions): void {
  /**
   * The correlation identity every provider-touching request carries.
   *
   * Derived from this request's own instant rather than from a counter, so two requests never
   * share one and a trace can be followed from this log entry into the adapter call
   * (mvp-spec 7).
   */
  const correlationId = (): string => `http-candidate-${options.now().toISOString()}`;

  /**
   * The candidate port, or the refusal a deployment without one gets.
   *
   * A `503` naming the missing wiring rather than a `404`: "no candidate here" and "this
   * build cannot read candidates" are different facts, and answering the second with the
   * first would report something about the project's contents that is not true (F02-AC4).
   */
  const portOrRefusal = (reply: FastifyReply): CandidateUseCases | null => {
    const port = candidateUseCasesOf(options.controller);
    if (port === null) {
      refuse(
        reply,
        'This deployment composed no GitHub candidate port, so no candidate can be linked, read or refreshed. Nothing was read from GitHub and nothing was recorded.',
      );
    }
    return port;
  };

  /* -------------------------------------------------------------------- link */

  /**
   * Links the pull request the owner named.
   *
   * 201 with the recorded candidate, because a link this call created and one that was
   * already recorded are different outcomes and `alreadyRecorded` says which. Every refusal
   * the controller produced — a look-alike host, another provider, a fork, a repository that
   * is not this project's, a pull request that does not exist or that the credential cannot
   * read, a closed or merged one — arrives as its own status with its own reason
   * (mvp-spec F11-AC2, F11-AC3).
   */
  app.post('/api/projects/:projectId/candidates', { preHandler: options.guard }, async (request, reply) => {
    const session = request.session;
    if (session === null) return sendProblem(reply, signInRequiredProblem());
    const port = portOrRefusal(reply);
    if (port === null) return reply;
    const params = parseBody(projectParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(linkCandidateBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    const linked = await port.linkCandidate({
      projectId: params.value.projectId,
      requestId: body.value.requestId,
      contractId: body.value.contractId,
      contractRevision: body.value.contractRevision,
      pullRequestUrl: body.value.pullRequestUrl,
      expectedBaseBranch: null,
      correlationId: correlationId(),
      actor: session.ownerId,
    });
    if (!linked.ok) return sendProblem(reply, problemFor(linked.error));

    const report = projectLinked(linked.value, params.value.projectId, reply);
    if (report === null) return reply;
    return reply.status(201).send({ candidate: report.value });
  });

  /* -------------------------------------------------------------------- read */

  /**
   * The candidate this project recorded, read live from the provider.
   *
   * A `GET` that still talks to GitHub on purpose: the card an owner is looking at must be an
   * observation, and a cache that agreed with the last read would present withdrawn work as
   * current. A provider that stops answering produces a refusal here rather than a stale row
   * dressed as a fresh one (mvp-spec F24-AC4).
   */
  app.get('/api/projects/:projectId/candidates/:candidateId', { preHandler: options.guard }, async (request, reply) => {
    const owner = provedOwnerOf(request, reply);
    if (owner === null) return reply;
    const port = portOrRefusal(reply);
    if (port === null) return reply;
    const params = parseBody(candidateParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));

    const read = await port.readCandidate({
      projectId: params.value.projectId,
      candidateId: params.value.candidateId,
      correlationId: correlationId(),
      actor: owner,
    });
    if (!read.ok) return sendProblem(reply, problemFor(read.error));

    const report = projectRead(read.value, params.value.projectId, reply);
    if (report === null) return reply;
    return reply.status(200).send({ candidate: report.value });
  });

  /* ----------------------------------------------------------------- refresh */

  /**
   * Re-reads the provider and reports what moved.
   *
   * `POST` because the owner asked for a fresh observation, and with an empty body: a client
   * cannot say which facts changed or which head it believes is there. The response is the
   * same read as the `GET`, with the change made explicit — when the head moved,
   * `change.previousHeadSha` names the commit prior evidence is about, `evidence.status` is
   * `Stale`, and `evidence.priorReadinessPreserved` is `false`, so a client that kept a
   * ready status across a force push has nothing to keep (mvp-spec F20-AC3, F24-AC4, F25-AC3).
   */
  app.post('/api/projects/:projectId/candidates/:candidateId/refresh', { preHandler: options.guard }, async (request, reply) => {
    const owner = provedOwnerOf(request, reply);
    if (owner === null) return reply;
    const port = portOrRefusal(reply);
    if (port === null) return reply;
    const params = parseBody(candidateParams, request.params);
    if (!params.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(params.problem)));
    const body = parseBody(refreshBody, request.body);
    if (!body.ok) return sendProblem(reply, fieldsProblem(fieldErrorsOf(body.problem)));

    const read = await port.readCandidate({
      projectId: params.value.projectId,
      candidateId: params.value.candidateId,
      correlationId: correlationId(),
      actor: owner,
    });
    if (!read.ok) return sendProblem(reply, problemFor(read.error));

    const report = projectRead(read.value, params.value.projectId, reply);
    if (report === null) return reply;
    return reply.status(200).send({ candidate: report.value });
  });
}

/* -------------------------------------------------------------------------- */
/* Projection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Projects a link result, after checking the facts a card depends on.
 *
 * The project, because a report about another project must not be readable through this
 * project's path; both commit SHAs on both the row and the live facts, because an
 * abbreviated one would be recorded as identity; and both pull request states, because a
 * state outside the vocabulary must not become a candidate. Returns null after answering the
 * reply, so a caller cannot send a partial body by accident.
 */
function projectLinked(
  linked: LinkedCandidateReport,
  projectId: string,
  reply: FastifyReply,
): { readonly value: LinkedCandidateReport } | null {
  const candidate = projectRecorded(linked.candidate, 'The recorded candidate', reply);
  if (candidate === null) return null;
  const live = projectLive(linked.live, 'The linked pull request', reply);
  if (live === null) return null;
  const identities = checkIdentities(candidate, live, 'The link', reply);
  if (identities === null) return null;
  if (candidate.projectId !== projectId) {
    refuse(
      reply,
      `Candidate ${candidate.candidateId} belongs to project ${candidate.projectId}, not ${projectId}, so it is not returned through this project's path (F02-AC2).`,
    );
    return null;
  }
  return {
    value: {
      candidate,
      live,
      binding: {
        contractId: candidate.contractId,
        contractRevision: candidate.contractRevision,
        headSha: identities.recordedHead,
      },
      bindingFingerprint: linked.bindingFingerprint,
      alreadyRecorded: linked.alreadyRecorded,
      observedAt: live.observedAt,
      providerWritePerformed: false,
    },
  };
}

/**
 * Projects one live read.
 *
 * Everything the response asserts is re-derived here rather than copied, so a port cannot
 * hand back a card the live facts do not support:
 *
 *   - `checks[].blocking` comes from the domain's `isBlocking`, and `checksReady` is true
 *     only when no required check blocks. A port claiming otherwise is refused.
 *   - `reviewReadiness.ready` is accepted only when the live pull request is `Open`, is not a
 *     draft, does not have its head in another repository, and has no blocking required
 *     check. Anything less is not ready, whatever the port said.
 *   - `evidence.status` follows `change.priorEvidenceStale`, and `priorReadinessPreserved`
 *     is the literal `false` — there is no stored readiness here to carry forward.
 */
function projectRead(
  report: CandidateReport,
  projectId: string,
  reply: FastifyReply,
): { readonly value: CandidateReport } | null {
  const candidate = projectRecorded(report.candidate, 'The recorded candidate', reply);
  if (candidate === null) return null;
  const live = projectLive(report.live, 'The live pull request', reply);
  if (live === null) return null;
  const identities = checkIdentities(candidate, live, 'The read', reply);
  if (identities === null) return null;
  if (candidate.projectId !== projectId) {
    refuse(
      reply,
      `Candidate ${candidate.candidateId} belongs to project ${candidate.projectId}, not ${projectId}, so it is not returned through this project's path (F02-AC2).`,
    );
    return null;
  }

  const checks = projectChecks(report.checks, identities.liveHead, reply);
  if (checks === null) return null;
  const blockingChecks = checks
    .filter((check) => check.required && check.blocking)
    .map((check) => `${check.name} is ${check.result}`);
  const checksReady = blockingChecks.length === 0;
  if (checksReady !== report.checksReady) {
    const named = blockingChecks.length === 0 ? 'no required check blocks' : blockingChecks.join('; ');
    refuse(
      reply,
      `The candidate read reported checksReady=${String(report.checksReady)} while ${named}. Readiness is computed from the check results, so the two have to agree (mvp-spec F20-AC2).`,
    );
    return null;
  }

  const reasons = [...blockingChecks];
  if (live.pullRequestState !== 'Open') {
    reasons.push(`The pull request is ${live.pullRequestState}, so there is no open change to decide on.`);
  }
  if (live.draft) {
    reasons.push('The pull request is a draft, so its contents are not proposed for review yet.');
  }
  if (live.headRepository !== null && !sameRepository(live.headRepository, live.repository)) {
    reasons.push(`The head is in ${live.headRepository}, not in ${live.repository}.`);
  }
  const ready = reasons.length === 0;
  if (ready !== report.reviewReadiness.ready) {
    refuse(
      reply,
      `The candidate read reported a review ready to decide on while this read's facts say otherwise${reasons.length === 0 ? '' : `: ${reasons.join(' ')}`}. Readiness is derived from this read and from nothing stored (mvp-spec F24-AC4).`,
    );
    return null;
  }
  if (ready && report.reviewReadiness.reasons.length > 0) {
    refuse(
      reply,
      'The candidate read reported a ready candidate together with the reasons it is not ready. The two cannot both be true.',
    );
    return null;
  }

  const previousHeadSha = report.change.previousHeadSha;
  if (previousHeadSha !== null && !isFullSha(previousHeadSha)) {
    refuse(
      reply,
      `The recorded change names previous head "${truncate(String(previousHeadSha))}", which is not a full commit SHA, so nothing is reported about which evidence went stale (mvp-spec 3).`,
    );
    return null;
  }
  const stale = report.change.priorEvidenceStale;

  return {
    value: {
      candidate,
      live,
      binding: {
        contractId: candidate.contractId,
        contractRevision: candidate.contractRevision,
        headSha: identities.recordedHead,
      },
      bindingFingerprint: report.bindingFingerprint,
      change: {
        kind: report.change.kind,
        changed: [...report.change.changed],
        changedAnything: report.change.changedAnything,
        previousHeadSha,
        currentHeadSha: identities.liveHead,
        priorEvidenceStale: stale,
        detail: report.change.detail,
      },
      evidence: {
        status: stale ? 'Stale' : 'Current',
        priorReadinessPreserved: false,
        priorCandidateId: stale ? report.evidence.priorCandidateId : null,
        priorHeadSha: stale ? previousHeadSha : null,
        detail: stale
          ? report.change.detail
          : 'Nothing material moved during this read, so evidence recorded against this head still describes it (mvp-spec F24-AC4).',
      },
      supersededCandidateIds: [...report.supersededCandidateIds],
      checks,
      checksReady,
      blockingChecks,
      reviewReadiness: { ready, reasons },
      observedAt: live.observedAt,
      providerWritePerformed: false,
    },
  };
}

/**
 * Checks the four commit SHAs a response carries, and that the row and the live read agree
 * about the head.
 *
 * Reuses the domain's `isCommitSha` rather than restating the rule, because a second
 * spelling of "full SHA" is a second opinion about what may stand in for identity: a branch
 * name and an abbreviation both fail it, which is the property this route needs.
 *
 * The equality check between the recorded head and the live head is what makes "persist the
 * full SHA that was read" verifiable rather than asserted: a report that names two different
 * heads for one link is refused instead of answered.
 */
function checkIdentities(
  candidate: RecordedCandidateReport,
  live: LiveCandidateReport,
  subject: string,
  reply: FastifyReply,
): { readonly recordedHead: string; readonly liveHead: string } | null {
  const recordedHead = requireFullSha(candidate.headSha, 'head SHA', 'the recorded candidate', reply);
  if (recordedHead === null) return null;
  if (requireFullSha(candidate.baseSha, 'base SHA', 'the recorded candidate', reply) === null) return null;
  const liveHead = requireFullSha(live.headSha, 'head SHA', 'the live pull request', reply);
  if (liveHead === null) return null;
  if (requireFullSha(live.baseSha, 'base SHA', 'the live pull request', reply) === null) return null;
  if (recordedHead !== liveHead) {
    refuse(
      reply,
      `${subject} reported the recorded candidate holding head ${recordedHead} while the provider read ${liveHead} in the same operation, so the identity that would be shown is not the identity that was recorded (mvp-spec F24-AC4).`,
    );
    return null;
  }
  return { recordedHead, liveHead };
}

/** Narrows the recorded row's provider state, refusing anything outside the vocabulary. */
function projectRecorded(
  candidate: RecordedCandidateReport,
  subject: string,
  reply: FastifyReply,
): RecordedCandidateReport | null {
  const state = narrowProviderState(candidate.pullRequestState, subject, reply);
  if (state === null) return null;
  return { ...candidate, pullRequestState: state };
}

/** Narrows the live facts' provider state the same way. */
function projectLive(
  live: LiveCandidateReport,
  subject: string,
  reply: FastifyReply,
): LiveCandidateReport | null {
  const state = narrowProviderState(live.pullRequestState, subject, reply);
  if (state === null) return null;
  return { ...live, pullRequestState: state };
}

/**
 * Projects the check list: narrows every result, computes `blocking` here, and demotes a
 * result the provider attributed to another commit.
 *
 * An unrecognised result is refused rather than mapped onto a state, because the point of the
 * six-state vocabulary is that a result nobody read is not a pass (mvp-spec F20-AC2).
 */
function projectChecks(
  checks: readonly CandidateCheckReport[],
  liveHeadSha: string,
  reply: FastifyReply,
): CandidateCheckReport[] | null {
  const projected: CandidateCheckReport[] = [];
  for (const check of checks) {
    const result = narrowCheckResult(check.result, check.name, reply);
    if (result === null) return null;
    let observedHeadSha: string | null = null;
    if (check.observedHeadSha !== null) {
      if (!isFullSha(check.observedHeadSha)) {
        refuse(
          reply,
          `Check "${check.name}" reported the commit "${truncate(String(check.observedHeadSha))}" it ran against, which is not a full commit SHA, so the result cannot be attributed to a candidate (mvp-spec 3).`,
        );
        return null;
      }
      observedHeadSha = check.observedHeadSha;
    }
    const fromAnotherCommit = observedHeadSha !== null && observedHeadSha !== liveHeadSha;
    projected.push({
      ...check,
      result,
      blocking: isBlocking(result, check.notApplicableApprovedByPolicy),
      observedHeadSha,
      detail: fromAnotherCommit
        ? `${check.detail ?? 'The provider reported this check.'} It was reported against ${truncate(String(observedHeadSha))} rather than candidate head ${truncate(liveHeadSha)}, so it cannot prove this candidate.`
        : check.detail,
    });
  }
  return projected;
}

/* -------------------------------------------------------------------------- */
/* Boundary refusals                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Refuses a pull request state outside the product's vocabulary.
 *
 * The stated rule: the value is reported as unread and nothing is coerced. It is never read
 * as `Open`, which would present withdrawn work as reviewable, and never as `Closed`, which
 * would assert a provider conclusion nobody read. The response names the three states the
 * product has words for, so a client can tell "GitHub says closed" from "ShipLoop could not
 * read what GitHub said" — the distinction this refusal exists to keep. A port that later
 * widens the domain's vocabulary adds its member here and nowhere else.
 */
function narrowProviderState(
  value: ProviderPullRequestState,
  subject: string,
  reply: FastifyReply,
): ProviderPullRequestState | null {
  if (typeof value === 'string' && (PULL_REQUEST_STATES as readonly string[]).includes(value)) {
    return value;
  }
  refuse(
    reply,
    `${subject} reported a pull request state of "${truncate(String(value))}", which is not one of ${PULL_REQUEST_STATES.join(', ')}. ShipLoop has no name for that state, so it is reported as unread rather than read as ${PULL_REQUEST_STATES[0]} or ${PULL_REQUEST_STATES[1]} (mvp-spec F20-AC2). Nothing was recorded and no readiness is claimed.`,
  );
  return null;
}

/** Refuses a check result outside the domain's six states rather than mapping it. */
function narrowCheckResult(
  value: ProviderCheckResult,
  name: string,
  reply: FastifyReply,
): ProviderCheckResult | null {
  if (typeof value === 'string' && (CHECK_RESULTS as readonly string[]).includes(value)) {
    return value;
  }
  refuse(
    reply,
    `Check "${name}" came back as "${truncate(String(value))}", which is not one of ${CHECK_RESULTS.join(', ')}. An unreadable result is not a pass, so this candidate is not reported as ready (mvp-spec F20-AC2).`,
  );
  return null;
}

/** The domain's own rule for what may stand in for a commit identity. */
function isFullSha(value: string): boolean {
  return typeof value === 'string' && isCommitSha(value);
}

/** Refuses a value that is not a full commit SHA, naming what was expected. */
function requireFullSha(value: string, field: string, subject: string, reply: FastifyReply): string | null {
  if (isFullSha(value)) return value;
  refuse(
    reply,
    `${subject} reported ${field} "${truncate(String(value))}", which is not a full commit SHA. A branch name, an abbreviated SHA and a pull request number are routing facts rather than identity, so nothing is returned that would let one stand in for the candidate (mvp-spec 3).`,
  );
  return null;
}

/** GitHub compares repository names case-insensitively, so this comparison does too. */
function sameRepository(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Bounds a value quoted in a refusal, so an unreadable provider string is not echoed whole. */
function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

/** Answers with a 503 and a named reason, for a fact this transport could not verify. */
function refuse(reply: FastifyReply, reason: string): FastifyReply {
  return sendProblem(reply, problemFor({ code: 'Unavailable', reason }));
}
