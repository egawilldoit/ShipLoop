/**
 * Adoption use cases (F11, F12-AC1, F14-AC2, F13-AC5, F30-AC2).
 *
 * Adoption is the opposite of publication and the difference is the whole design. A
 * publication creates something at a provider; an adoption points at something a person
 * already made. So every rule here is about *not* doing what publication does:
 *
 *   - **No replacement is created** (F11-AC1). The issue is read through the adapter's read
 *     operation and bound to a new work item. Nothing here calls a write.
 *   - **Identity is verified, never inferred from a name** (F11-AC3). An issue whose live
 *     team disagrees with the project's configured team is refused; a repository is matched
 *     on provider and full path, so `org/app` is never accepted for `org/app-legacy`; and a
 *     mapping that is already held by another project is refused by name rather than
 *     adopted twice.
 *   - **Existing work is preserved** (F11-AC4, F14-AC2). Linking a branch or pull request
 *     records the head SHA and target branch that were *observed*. This module holds no
 *     push, no force and no reset capability at all, so "adoption reset the work" is not a
 *     behaviour it can have.
 *   - **A review can be requested without starting a Build** (F11-AC5). The request is
 *     recorded as a durable, deduplicated intent; no job is enqueued and no issue is
 *     rewritten. The absence of both is what the tests assert, because a webhook-shaped
 *     provider update must never start coding work either (F13-AC5).
 *   - **The adopted scope is captured as a snapshot** (F11-AC1, F12-AC1) through the
 *     existing append-only repository, with the provider's own revision, so a later change
 *     at the provider is detected as a difference rather than silently adopted.
 *
 * A webhook or provider status can reach this module only through an owner request. There
 * is no path here from a provider event to a job, and the request use case's dependency
 * list contains no job store at all, which is what makes F13-AC5 structural rather than a
 * promise.
 */

import { blocked, conflict, err, invalid, ok, redact } from '@shiploop/domain';
import type {
  CandidateId,
  DomainError,
  Fingerprint,
  OperationId,
  ProjectId,
  ProfileVersionId,
  ProviderId,
  Result,
  ScopeSnapshot,
  WorkItemId,
} from '@shiploop/domain';
import type {
  AdapterContext,
  GitAdapter,
  GitRepositoryRef,
  TicketAdapter,
  TicketIssueRef,
  TicketState,
} from '@shiploop/adapters';
import type { AdoptionReference, ProjectProfileRepository, ScopeRepository, WorkItemRecord } from '@shiploop/storage';
import { PublicationRepository } from '@shiploop/storage';
import type { ControllerClock, OwnerActor } from './profiles.ts';

/* -------------------------------------------------------------------------- */
/* Adoption of an existing issue                                               */
/* -------------------------------------------------------------------------- */

export interface AdoptExistingIssueInput {
  readonly actor: OwnerActor;
  readonly projectId: ProjectId;
  readonly profileVersionId: ProfileVersionId;
  /** The recipe version a captured scope is bound to; the schema requires one (F12-AC1). */
  readonly procedureVersionId: string;
  /**
   * The issue the owner selected.
   *
   * An identity, never a name: the adapter refuses anything that cannot be a provider issue
   * rather than searching for a similarly named one (F11-AC3).
   */
  readonly issueId: string;
  /**
   * The identifier the owner expects this identity to resolve to.
   *
   * Optional, and checked when given: a human who typed `EGA-664` and got back `EGA-665`
   * has been given the wrong issue, and the only honest answer is a refusal naming both
   * (F11-AC3).
   */
  readonly expectedIdentifier: string | null;
  readonly title: string;
  readonly correlationId: string;
}

/** What one adoption established (F11-AC1). */
export interface AdoptedIssue {
  readonly workItem: WorkItemRecord;
  readonly issue: TicketIssueRef;
  readonly snapshot: ScopeSnapshot;
  readonly state: TicketState;
  readonly capturedScopeSnapshotId: string;
}

/* -------------------------------------------------------------------------- */
/* Adoption of an existing branch or pull request                              */
/* -------------------------------------------------------------------------- */

/** The branch or pull request the owner selected, verified before adoption (F11-AC2). */
export interface LinkExistingChangeInput {
  readonly actor: OwnerActor;
  readonly workItemId: WorkItemId;
  /** Provider identity of the repository, not its display name (F11-AC3). */
  readonly repository: GitRepositoryRef;
  readonly branch: string;
  readonly baseBranch: string;
  /** When given, the head the owner believes is there; a different head is a conflict. */
  readonly expectedHeadSha: string | null;
  /** When given, the pull request the owner selected; a different one is a conflict. */
  readonly pullRequestId: string | null;
  readonly correlationId: string;
}

/** What the provider reported about the linked change (F11-AC2). */
export interface LinkedChange {
  readonly workItem: WorkItemRecord;
  readonly adoption: AdoptionReference;
  readonly headSha: string;
  readonly pullRequestId: string | null;
  readonly baseBranch: string;
}

/* -------------------------------------------------------------------------- */
/* Review of an adopted candidate                                              */
/* -------------------------------------------------------------------------- */

/** The modes an adopted candidate may be asked for (F11-AC5). */
export type AdoptedEvaluationMode = 'Test' | 'Review';

/** Build is deliberately absent: it is not expressible for an adopted candidate. */
export type RequestedEvaluationMode = AdoptedEvaluationMode | 'Build';

export interface RequestAdoptedEvaluationInput {
  readonly actor: OwnerActor;
  readonly workItemId: WorkItemId;
  readonly candidateId: CandidateId | null;
  /** The candidate fingerprint the request is bound to, when one was selected. */
  readonly candidateFingerprint: Fingerprint | null;
  readonly mode: RequestedEvaluationMode;
  readonly correlationId: string;
}

/** A recorded request to evaluate an adopted candidate (F11-AC5). */
export interface AdoptedEvaluationRequest {
  readonly workItemId: WorkItemId;
  readonly mode: AdoptedEvaluationMode;
  readonly dedupKey: string;
  /** False when the same request was already recorded; a repeat is one row (F30-AC2). */
  readonly created: boolean;
}

export interface AdoptionUseCaseDeps {
  readonly clock: ControllerClock;
  readonly publications: PublicationRepository;
  readonly scope: ScopeRepository;
  readonly profiles: ProjectProfileRepository;
  readonly ticket: TicketAdapter;
  /** Injected so a test observes which writes a call made; this module issues none. */
  readonly git: GitAdapter;
  /** Redaction applied to provider text before it reaches a stored row (N02-AC2). */
  readonly redactProviderText?: (text: string) => string;
}

export interface AdoptionUseCases {
  readonly adoptExistingIssue: (
    input: AdoptExistingIssueInput,
  ) => Promise<Result<AdoptedIssue, DomainError>>;
  readonly linkExistingChange: (input: LinkExistingChangeInput) => Promise<Result<LinkedChange, DomainError>>;
  readonly requestAdoptedEvaluation: (
    input: RequestAdoptedEvaluationInput,
  ) => Result<AdoptedEvaluationRequest, DomainError>;
  /**
   * F11-AC4: reads what a human did to the provider and records it as a difference, never
   * as a replacement. Used to show that a sync writes back a difference (F12-AC2).
   */
  readonly readAdoptedScope: (
    workItemId: WorkItemId,
  ) => Promise<Result<{ readonly snapshot: ScopeSnapshot; readonly state: TicketState }, DomainError>>;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Builds the adoption use cases.
 *
 * Every dependency is injected, so a case contacts no provider it was not given and records
 * no ambient time.
 */
export function createAdoptionUseCases(deps: AdoptionUseCaseDeps): AdoptionUseCases {
  const providerText = deps.redactProviderText ?? ((text: string): string => redact(text).text);
  const publications = deps.publications;

  const contextFor = (operationId: OperationId, correlationId: string): AdapterContext => ({
    correlationId,
    operationId,
    clock: { now: () => deps.clock.now(), elapsedMs: () => 0 },
    logger: { emit: () => undefined },
    signal: new AbortController().signal,
    redact: providerText,
  });

  const requireOwner = (actor: OwnerActor): Result<true, DomainError> =>
    actor.role === 'Owner'
      ? ok(true)
      : err({
          code: 'Forbidden',
          reason: `Only the owner may adopt existing work; the ${actor.role} role may not (F11-AC1).`,
        });

  /**
   * F11-AC1, F11-AC3, F11-AC4: binds an existing provider issue to a new work item.
   *
   * The order is the safety property. The live read happens *first*, so nothing local
   * exists until the provider has confirmed the issue is readable and belongs where the
   * owner says it does. Only then is a work item created, a scope snapshot appended, and the
   * provider identity bound. An issue already mapped anywhere is refused first, so a wrong
   * -project mapping never creates the local row it would have corrupted (F11-AC3).
   */
  const adoptExistingIssue = async (
    input: AdoptExistingIssueInput,
  ): Promise<Result<AdoptedIssue, DomainError>> => {
    const permitted = requireOwner(input.actor);
    if (!permitted.ok) return err(permitted.error);

    const profile = deps.profiles.currentVersion(input.projectId);
    if (!profile.ok) return profile;
    if (profile.value === null) {
      return err(
        blocked(
          `Project ${input.projectId} has no saved profile, so the ticket team an adoption must match is not configured (F11-AC3, F02-AC1).`,
          [
            {
              name: 'project profile',
              detail: 'A saved project profile names the ticket provider and team this project works in.',
              remedy: 'Save a project profile for this project, then select the issue again (F02-AC1).',
            },
          ],
        ),
      );
    }
    const configuredTeam = profile.value.content.references.ticketTeamKey;

    const held = publications.findByProviderIssue(input.issueId);
    if (held !== null && held.projectId !== input.projectId) {
      return err(
        conflict(
          `Issue ${input.issueId} is already adopted by project ${held.projectId}; it cannot also be adopted by ${input.projectId}`,
          'an issue this project has not adopted',
          `an issue already adopted by project ${held.projectId}`,
        ),
      );
    }

    const read = await deps.ticket.readScope(contextFor(adoptionReadOperation(input.issueId), input.correlationId), {
      workItemId: held?.workItemId ?? readOnlyWorkItemId(input.issueId),
      issueId: input.issueId as ProviderId,
    });
    if (!read.ok) return read;

    const team = teamOf(read.value.issue.identifier);
    if (configuredTeam !== null && team !== null && team !== configuredTeam) {
      return err(
        conflict(
          `Issue ${read.value.issue.identifier} belongs to team ${team}, but this project is configured for ${configuredTeam}`,
          `an issue in team ${configuredTeam}`,
          `an issue in team ${team}`,
        ),
      );
    }
    if (input.expectedIdentifier !== null && input.expectedIdentifier !== read.value.issue.identifier) {
      return err(
        conflict(
          `Issue ${input.issueId} resolves to ${read.value.issue.identifier}, not the ${input.expectedIdentifier} that was selected`,
          input.expectedIdentifier,
          read.value.issue.identifier,
        ),
      );
    }

    const created = publications.createAdoptedWorkItem({
      projectId: input.projectId,
      profileVersionId: input.profileVersionId,
      title: input.title.trim().length === 0 ? read.value.issue.identifier : input.title,
      externalIssueIdentifier: null,
      externalIssueUrl: null,
      publicationIntent: 'Published',
      relatedWorkItemIds: [],
      adoption: null,
      at: deps.clock.now(),
    });
    if (!created.ok) return created;

    // The scope's `workItemId` is a ShipLoop-side fact, not a provider one: the read
    // reports it against whatever identity the read was made under, which for an adoption
    // is the "not adopted yet" placeholder. Rebinding it here is what makes the captured
    // snapshot belong to the row that now holds the issue, and it is why the read happens
    // before the row is created (F11-AC1, F12-AC1).
    const captured = deps.scope.capture({
      scope: { ...read.value.snapshot, workItemId: created.value.workItemId },
      attemptId: null,
      profileVersionId: input.profileVersionId,
      procedureVersionId: input.procedureVersionId,
      capturedAt: deps.clock.now(),
      correlationId: input.correlationId,
    });
    if (!captured.ok) return captured;

    const bound = publications.recordAdoption({
      workItemId: created.value.workItemId,
      operationId: null,
      providerIssueId: read.value.issue.issueId,
      providerIssueIdentifier: read.value.issue.identifier,
      providerIssueUrl: read.value.issue.url,
      adoption: null,
      observedAt: read.value.observedAt,
      correlationId: input.correlationId,
    });
    if (!bound.ok) return bound;

    return ok({
      workItem: bound.value,
      issue: read.value.issue,
      snapshot: read.value.snapshot,
      state: read.value.state,
      capturedScopeSnapshotId: captured.value.scopeSnapshotId,
    });
  };

  /**
   * F11-AC2, F11-AC3, F11-AC4: links an existing branch or pull request, verified first.
   *
   * Three identities are verified before anything is recorded, and each names both sides of
   * the disagreement so the owner is told what to correct rather than that something is
   * wrong:
   *
   *   - the repository, against the project profile's configured reference and against the
   *     identity the provider itself reported, so `org/app` is never accepted for
   *     `org/app-legacy` and a similarly named repository is never picked silently;
   *   - the head, against the branch and the SHA the owner selected;
   *   - the target, against the profile's configured target branch.
   *
   * What is then recorded is what was *observed*. No push, no force and no reset exists in
   * this module, so adoption cannot reset a human's branch (F11-AC4, F14-AC2).
   */
  const linkExistingChange = async (input: LinkExistingChangeInput): Promise<Result<LinkedChange, DomainError>> => {
    const permitted = requireOwner(input.actor);
    if (!permitted.ok) return err(permitted.error);

    const workItem = publications.requirePublishable(input.workItemId);
    if (!workItem.ok) return workItem;
    if (workItem.value.externalIssueId === null) {
      return err(
        invalid('This work item has no adopted issue, so there is no change to link.', [
          { path: 'externalIssueId', message: 'Adopt the issue before linking a branch or pull request (F11-AC1).' },
        ]),
      );
    }

    const profile = deps.profiles.currentVersion(workItem.value.projectId);
    if (!profile.ok) return profile;
    if (profile.value === null) {
      return err({
        code: 'Blocked',
        reason: `Project ${workItem.value.projectId} has no saved profile, so the repository and target branch an adoption must match are not configured (F11-AC2, F02-AC1).`,
        prerequisites: [],
      });
    }

    const configuredRepository = profile.value.content.references.repository;
    if (!repositoryMatches(configuredRepository, input.repository)) {
      return err(
        conflict(
          `Repository ${input.repository.provider}/${input.repository.fullName} is not the one this project is configured for (${configuredRepository})`,
          configuredRepository,
          `${input.repository.provider}/${input.repository.fullName}`,
        ),
      );
    }
    const configuredTarget = profile.value.content.references.targetBranch;
    if (input.baseBranch !== configuredTarget) {
      return err(
        conflict(
          `Branch ${input.branch} targets ${input.baseBranch}, but this project delivers into ${configuredTarget}`,
          configuredTarget,
          input.baseBranch,
        ),
      );
    }

    const read = await deps.git.readState(contextFor(adoptionReadOperation(input.branch), input.correlationId), {
      repository: input.repository,
      branch: input.branch,
      baseBranch: input.baseBranch,
    });
    if (!read.ok) return read;

    const observed = read.value;
    if (observed.repository.provider !== input.repository.provider || observed.repository.fullName !== input.repository.fullName) {
      return err(
        conflict(
          `The provider reported ${observed.repository.provider}/${observed.repository.fullName} for a request that named ${input.repository.provider}/${input.repository.fullName}`,
          `${input.repository.provider}/${input.repository.fullName}`,
          `${observed.repository.provider}/${observed.repository.fullName}`,
        ),
      );
    }
    if (observed.head.kind !== 'Branch') {
      return err(
        conflict(
          `Branch ${input.branch} does not exist in ${input.repository.fullName}`,
          `a branch named ${input.branch}`,
          observed.head.kind === 'Missing' ? observed.head.detail : `a ${observed.head.kind}`,
        ),
      );
    }
    if (observed.head.name !== input.branch) {
      return err(
        conflict(
          `The provider reported branch ${observed.head.name} where ${input.branch} was selected`,
          input.branch,
          observed.head.name,
        ),
      );
    }
    if (input.expectedHeadSha !== null && observed.head.sha !== input.expectedHeadSha) {
      return err(
        conflict(
          `Branch ${input.branch} is at ${observed.head.sha}, not the ${input.expectedHeadSha} that was selected`,
          input.expectedHeadSha,
          observed.head.sha,
        ),
      );
    }
    if (observed.base.kind !== 'Branch' || observed.base.name !== input.baseBranch) {
      const actual =
        observed.base.kind === 'Branch'
          ? `branch ${observed.base.name}`
          : observed.base.kind === 'Missing'
            ? observed.base.detail
            : `commit ${observed.base.sha}`;
      return err(
        conflict(
          `Branch ${input.branch} targets ${actual}, not ${input.baseBranch}`,
          input.baseBranch,
          actual,
        ),
      );
    }
    const pullRequestId = observed.pullRequest?.pullRequestId ?? null;
    if (input.pullRequestId !== null && pullRequestId !== input.pullRequestId) {
      return err(
        conflict(
          `Branch ${input.branch} has pull request ${pullRequestId ?? 'none'}, not the ${input.pullRequestId} that was selected`,
          input.pullRequestId,
          pullRequestId ?? 'none',
        ),
      );
    }

    const adoption: AdoptionReference = {
      repository: `${observed.repository.provider}/${observed.repository.fullName}`,
      headSha: observed.head.sha,
      targetBranch: input.baseBranch,
      pullRequestId,
    };
    const bound = publications.recordAdoptionReference({
      workItemId: input.workItemId,
      adoption,
      observedAt: observed.observedAt,
      correlationId: input.correlationId,
    });
    if (!bound.ok) return bound;

    return ok({
      workItem: bound.value,
      adoption,
      headSha: observed.head.sha,
      pullRequestId,
      baseBranch: input.baseBranch,
    });
  };

  /**
   * F11-AC5, F13-AC5: records a request to Test or Review an adopted candidate without
   * launching a Build job and without rewriting the issue.
   *
   * `Build` is not expressible: the mode check refuses it before anything else happens,
   * because a build against adopted work is the reset F11-AC4 and F14-AC2 exist to prevent.
   * The request is recorded as an outbound effect with a deduplication key, so a repeated
   * request is one durable row rather than a growing list (F30-AC2), and dispatch remains
   * the job queue's business under the recorded owner start action (F13-AC1). No job is
   * enqueued here and no provider write is issued: this module holds no capability that
   * could do either.
   */
  const requestAdoptedEvaluation = (
    input: RequestAdoptedEvaluationInput,
  ): Result<AdoptedEvaluationRequest, DomainError> => {
    const permitted = requireOwner(input.actor);
    if (!permitted.ok) return err(permitted.error);
    if (input.mode === 'Build') {
      return err(
        invalid('An adopted candidate cannot be sent to Build.', [
          {
            path: 'mode',
            message:
              'A build would start from a generated working point and reset what the person already wrote. Request Test or Review for adopted work instead (F11-AC5, F11-AC4, F14-AC2).',
          },
        ]),
      );
    }

    const workItem = publications.requirePublishable(input.workItemId);
    if (!workItem.ok) return workItem;
    if (workItem.value.externalIssueId === null) {
      return err(
        invalid('This work item has no adopted issue, so there is nothing to request a review of.', [
          { path: 'externalIssueId', message: 'Adopt the existing issue before requesting a review (F11-AC1).' },
        ]),
      );
    }

    const dedupKey = `adopted-evaluation:${input.workItemId}:${input.candidateId ?? 'unselected'}:${input.mode}`;
    const enqueued = publications.enqueueExternalEffect({
      kind: 'AdoptedEvaluationRequest',
      dedupKey,
      target: providerIssueOf(workItem.value) ?? '',
      operationId: `adopted-evaluation:${input.workItemId}:${input.candidateId ?? 'unselected'}`,
      workItemId: input.workItemId,
      correlationId: input.correlationId,
      payload: {
        mode: input.mode,
        candidateId: input.candidateId,
        candidateFingerprint: input.candidateFingerprint,
        requestedBy: input.actor.actorId,
      },
      expectedRefs: [],
      at: deps.clock.now(),
    });
    if (!enqueued.ok) return enqueued;

    return ok({
      workItemId: input.workItemId,
      mode: input.mode,
      dedupKey,
      created: enqueued.value.created,
    });
  };

  /**
   * F12-AC2: reads what the provider holds now, for comparison against the recorded snapshot.
   *
   * A read only. It returns the live snapshot so a caller can record the difference; nothing
   * here pushes the local belief back over the provider's content, which is the other half
   * of F12-AC5 and the reason the local row is a snapshot (F10-AC4).
   */
  const readAdoptedScope = async (
    workItemId: WorkItemId,
  ): Promise<Result<{ readonly snapshot: ScopeSnapshot; readonly state: TicketState }, DomainError>> => {
    const workItem = publications.requirePublishable(workItemId);
    if (!workItem.ok) return workItem;
    const issueId = workItem.value.externalIssueId;
    if (issueId === null) {
      return err({ code: 'NotFound', reason: `Work item ${workItemId} has no adopted issue to read (F11-AC1).` });
    }
    const read = await deps.ticket.readScope(contextFor(adoptionReadOperation(issueId), 'adopt-read'), {
      workItemId,
      issueId: issueId as ProviderId,
    });
    if (!read.ok) return read;
    return ok({ snapshot: read.value.snapshot, state: read.value.state });
  };

  return { adoptExistingIssue, linkExistingChange, requestAdoptedEvaluation, readAdoptedScope };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The team prefix a provider identifier carries, when it carries one.
 *
 * Linear identifiers are `TEAM-123`, and the adapter's own identity classifier accepts
 * exactly that shape. Null is the honest answer for a provider that numbers its issues
 * without a team prefix, and a null team skips the team check rather than failing an
 * adoption that is otherwise sound (F11-AC3).
 */
export function teamOf(identifier: string): string | null {
  const separator = identifier.lastIndexOf('-');
  if (separator <= 0) return null;
  const prefix = identifier.slice(0, separator);
  return /^[A-Za-z][A-Za-z0-9]*$/.test(prefix) ? prefix : null;
}

/**
 * Whether a configured repository reference names this repository (F11-AC3).
 *
 * Matched on the full owner-and-name path, optionally preceded by a host segment, and
 * never on a name alone. A host is recognised by its dot, so `github.com/org/app` and
 * `org/app` both name `org/app` while `github.com/org/app-legacy` does not: the whole point
 * of F11-AC3 is that a similarly named repository is never picked silently, and matching on
 * the last path segment alone is exactly that mistake.
 */
export function repositoryMatches(reference: string, repository: GitRepositoryRef): boolean {
  const trimmed = reference.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed.length === 0) return false;
  if (trimmed === repository.fullName) return true;
  const separator = trimmed.indexOf('/');
  if (separator <= 0) return false;
  const first = trimmed.slice(0, separator);
  if (!first.includes('.')) return false;
  return trimmed.slice(separator + 1) === repository.fullName;
}

/**
 * The read identity an adoption uses, derived so a read never borrows a write identity.
 *
 * A read and a write must not share an operation id: the ledger brackets the write, and a
 * read that reused the identity would look like the write had already happened (F30-AC5).
 */
function adoptionReadOperation(subject: string): OperationId {
  return `adopt-read:${subject}` as OperationId;
}

/**
 * The work-item identity an adoption read reports itself against.
 *
 * An unadopted issue has no local row yet, which is exactly why the read happens before
 * the row is created (F11-AC1). The value is derived from the provider identity so it is
 * stable across the retry of one selection and cannot collide with a real work item.
 */
function readOnlyWorkItemId(issueId: string): WorkItemId {
  return `unadopted:${issueId}` as WorkItemId;
}

/** The provider issue an adopted work item is bound to, or null when it is not adopted. */
function providerIssueOf(workItem: WorkItemRecord): string | null {
  return workItem.externalIssueId;
}
