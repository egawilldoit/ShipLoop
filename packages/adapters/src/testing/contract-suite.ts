/**
 * The shared adapter contract suite.
 *
 * A second Git provider, a second ticket provider or a second engine is proven
 * by running this same case list, not by a bespoke test per provider
 * (N05-AC2, L03-AC1). Every case names the criterion it enforces so a failure
 * points at a spec line rather than at a helper.
 *
 * Every case drives the real contracts in `../contracts` through the fakes, so a
 * contract change that the fakes no longer satisfy fails the build rather than
 * quietly passing against a local look-alike.
 *
 * What the suite deliberately does not do: it never asserts a provider's live
 * behaviour. A green run here proves the adapter's translation, refusal and
 * ambiguity handling. Live compatibility is a separate disposable-project
 * exercise (mvp-spec 9).
 *
 * `freshAdapters` supplies an isolated adapter set per case, because cases such
 * as revoked access or an injected rate limit mutate adapter state. Omit it for
 * adapters whose instances are interchangeable.
 */

import {
  CHECK_RESULTS,
  acceptanceReady,
  deliveryEligible,
  scopeFingerprint,
  type CheckOrigin,
  type CheckRecord,
  type DomainError,
  type ProviderId,
  type Result,
} from '@shiploop/domain';
import type {
  CheckExecutionRecord,
  EngineContinuation,
  EngineEvent,
  EngineSessionHandle,
  ManagedProgressOutcome,
  ManagedRegionTarget,
} from '../contracts/index.ts';
import {
  FIXED_LATER_INSTANT,
  FOREIGN_PROVIDER,
  FIXTURE_AVAILABILITIES,
  FIXTURE_BASE_SHA,
  FIXTURE_CANDIDATE_FINGERPRINT,
  FIXTURE_CHECK_CRITERIA,
  FIXTURE_CHECK_OBSERVATIONS,
  FIXTURE_CONFIGURED_CHECKS,
  FIXTURE_DEPLOYMENT_ID,
  FIXTURE_DEPENDENCY_ISSUE_ID,
  FIXTURE_DRAFT_BODY,
  FIXTURE_ENGINE_CHECKPOINT,
  FIXTURE_ENGINE_EVENT_LINES,
  FIXTURE_FOLLOW_UP_EVENT,
  FIXTURE_HEAD_SHA,
  FIXTURE_LATE_EVENT,
  FIXTURE_MERGE_COMMIT_SHA,
  FIXTURE_NEWEST_EVENT,
  FIXTURE_PROTECTED_DEPLOYMENT,
  FIXTURE_PROTECTED_DEPLOYMENT_URL,
  FIXTURE_READ_ONLY_ENGINE_EVENT_LINES,
  FIXTURE_REQUIRED_CHECK_NAMES,
  FIXTURE_REPOSITORY,
  FIXTURE_SCOPE_SNAPSHOT,
  FIXTURE_ISSUE_ID,
  FIXTURE_WORKSPACE,
  FIXTURE_SUPERSEDED_HEAD_SHA,
  FIXTURE_UNREPORTED_REQUIRED_CHECK_NAME,
  FIXTURE_USABLE_DEPLOYMENT,
  FIXTURE_WORK_ITEM_ID,
  adapterContext,
  apiExchangeSpec,
  browserFlowSpec,
  checkExecutionRequest,
  declareNoCodeOutcomeRequest,
  engineStartRequest,
  findDraftsRequest,
  managedProgressUpdateRequest,
  mergePullRequestRequest,
  operationId,
  providerId,
  publishWorkRequest,
  pushBranchRequest,
  redeployAction,
  resumeEngineSessionRequest,
  ticketTransitionRequest,
  upsertDraftRequest,
  verifyDestinationRequest,
} from './fixtures.ts';
import type { AdapterSet } from './fake.ts';

export interface ContractCaseResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

class ContractCaseFailure extends Error {}

function expectTrue(condition: boolean, message: string): void {
  if (!condition) throw new ContractCaseFailure(message);
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function okOf<T>(pending: Promise<Result<T, DomainError>>, label: string): Promise<T> {
  const result = await pending;
  if (!result.ok) throw new ContractCaseFailure(`${label} did not succeed: returned ${result.error.code}`);
  return result.value;
}

async function errOf<T>(pending: Promise<Result<T, DomainError>>, label: string): Promise<DomainError> {
  const result = await pending;
  if (result.ok) throw new ContractCaseFailure(`${label} unexpectedly succeeded`);
  return result.error;
}

/** The synchronous refusal path: capability checks answer before any work starts. */
function errOfSync<T>(result: Result<T, DomainError>, label: string): DomainError {
  if (result.ok) throw new ContractCaseFailure(`${label} unexpectedly succeeded`);
  return result.error;
}

/**
 * Narrows a continuation to the variant that reports restoration as impossible.
 *
 * A case cannot assert on the members of a union variant through a boolean
 * helper, so the narrowing happens where the failure is reported.
 */
/** The synchronous success path: the webhook receiver answers in memory. */
async function okOfSync<T>(result: Result<T, DomainError>, label: string): Promise<T> {
  if (!result.ok) throw new ContractCaseFailure(`${label} did not succeed: returned ${result.error.code}`);
  return result.value;
}

/** The managed region as a comment identity, which only a comment target can be. */
function expectCommentTarget(region: ManagedRegionTarget): ProviderId {
  if (region.kind !== 'UpdatableComment') {
    throw new ContractCaseFailure(`the managed region is ${region.kind}, not an updatable comment`);
  }
  return region.commentId;
}

function expectUpdatedProgress(
  outcome: ManagedProgressOutcome,
): Extract<ManagedProgressOutcome, { readonly kind: 'Updated' }> {
  if (outcome.kind !== 'Updated') {
    throw new ContractCaseFailure(`the first progress update was reported as ${outcome.kind}`);
  }
  return outcome;
}

function expectUnchangedProgress(
  outcome: ManagedProgressOutcome,
): Extract<ManagedProgressOutcome, { readonly kind: 'Unchanged' }> {
  if (outcome.kind !== 'Unchanged') {
    throw new ContractCaseFailure(`the repeated progress update was reported as ${outcome.kind}`);
  }
  return outcome;
}

function expectUnsupportedContinuation(
  continuation: EngineContinuation,
): Extract<EngineContinuation, { readonly kind: 'ContinuationUnsupported' }> {
  if (continuation.kind !== 'ContinuationUnsupported') {
    throw new ContractCaseFailure(`an unsupported continuation was reported as ${continuation.kind}`);
  }
  return continuation;
}

type ErrorOfCode<C extends DomainError['code']> = Extract<DomainError, { readonly code: C }>;

/** Narrows a domain error to one code so a case can read that code's own fields. */
function expectCode<C extends DomainError['code']>(
  error: DomainError,
  code: C,
  label: string,
): ErrorOfCode<C> {
  if (error.code !== code) {
    throw new ContractCaseFailure(`${label}: expected ${code}, received ${error.code}`);
  }
  return error as ErrorOfCode<C>;
}

/** Runs one case, turning a thrown assertion into a failed result instead of a crashed run. */
async function contractCase(name: string, run: () => Promise<string>): Promise<ContractCaseResult> {
  try {
    return { name, passed: true, detail: await run() };
  } catch (error) {
    return { name, passed: false, detail: describeFailure(error) };
  }
}

function eventsOf(handle: EngineSessionHandle): Promise<readonly EngineEvent[]> {
  return (async (): Promise<readonly EngineEvent[]> => {
    const collected: EngineEvent[] = [];
    for await (const event of handle.events) collected.push(event);
    return collected;
  })();
}

function progressOf(events: readonly EngineEvent[]): readonly Extract<EngineEvent, { kind: 'Progress' }>[] {
  return events.filter((event): event is Extract<EngineEvent, { kind: 'Progress' }> => event.kind === 'Progress');
}

/**
 * Projects a recorded check onto the domain's own record shape.
 *
 * The verification adapter produces a `CheckExecutionRecord`; the domain decides
 * delivery eligibility from a `CheckRecord`. This is the controller's projection,
 * deliberately kept in the suite rather than in the fake, because the fake must
 * speak the contract and nothing else. `candidateFingerprint` is echoed: the
 * contract binds the record to the candidate the controller named, and a stale
 * result is refused by its result rather than by a second fingerprint (F20-AC3).
 */
function toDomainCheckRecord(record: CheckExecutionRecord, origin: CheckOrigin): CheckRecord {
  const concluded = record.completion.kind === 'Concluded' ? record.completion.result : null;
  const approved =
    record.completion.kind === 'NotApplicable' && record.completion.approvedByPolicy;
  return {
    checkId: record.checkId,
    name: record.name,
    origin,
    required: record.required,
    result: concluded ?? 'Missing',
    candidateFingerprint: record.candidateFingerprint,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    artifactRef: record.artifacts[0]?.uri ?? null,
    detail: record.detail,
    notApplicableApprovedByPolicy: approved,
  };
}

const REVOKED_ACCESS_MESSAGE =
  'The stored credential for the Git connector was revoked by the provider and must be reauthorized before any new operation.';

/**
 * F03-AC4, F03-AC2, N05-AC2, F15-AC4: an unsupported capability is reported as
 * unavailable before any work, and a continuation the provider cannot perform
 * falls back to the checkpoint instead of being reported as restored.
 */
function unsupportedCapabilityIsUnavailable(adapters: AdapterSet): Promise<ContractCaseResult> {
  return contractCase(
    'N05-AC2 an unsupported operation is reported as unavailable, and an unsupported continuation falls back to a checkpoint',
    async () => {
      const refused = expectCode(
        await errOf(
          adapters.ticket.requestTransition(adapterContext('op_transition_01'), ticketTransitionRequest('op_transition_01')),
          'ticket.requestTransition',
        ),
        'Unavailable',
        'an unsupported operation',
      );
      expectTrue(refused.reason.includes('Developer Preview'), 'the refusal does not state the provider limitation');
      expectTrue(adapters.ticket.attempts('requestTransition') === 1, 'the adapter retried an unavailable operation');
      expectTrue(adapters.effects.count() === 0, 'an unavailable operation still performed a side effect');

      // The declaration is what the owner UI rejects on, before any call is made
      // (F03-AC2), so the case reads the contract's own capability surface.
      const declared = adapters.ticket
        .capabilities()
        .declarations.find((entry) => entry.kind === 'Ticket:RequestTransition');
      expectTrue(declared !== undefined && !declared.supported, 'the capability declaration offers a transition the provider does not have');
      expectTrue(
        declared?.limitation !== null && declared?.limitation !== undefined && declared.limitation.includes('Developer Preview'),
        'the declaration does not state the provider limitation the owner would need',
      );

      expectCode(
        errOfSync(adapters.engine.ensureSupported('Engine:ResumeSession'), 'engine.ensureSupported(Engine:ResumeSession)'),
        'Unavailable',
        'the Engine:ResumeSession capability declaration',
      );

      const transitions = await okOf(
        adapters.ticket.describeTransitions(adapterContext('op_transitions_01'), { issueId: FIXTURE_ISSUE_ID }),
        'ticket.describeTransitions',
      );
      expectTrue(transitions.length > 0, 'the provider offers no transition for the owner to apply directly');

      const continuation = expectUnsupportedContinuation(
        await okOf(
          adapters.engine.resumeSession(
            adapterContext('op_resume_01'),
            resumeEngineSessionRequest('op_resume_01', 'sess_fixture_01'),
          ),
          'engine.resumeSession',
        ),
      );
      expectTrue(
        continuation.requiresFreshSessionFromCheckpoint,
        'the fallback did not require a fresh session from the checkpoint',
      );
      expectTrue(continuation.checkpoint.checkpointId === FIXTURE_ENGINE_CHECKPOINT.checkpointId, 'the fallback did not carry the checkpoint');
      expectTrue(continuation.limitation.includes('not supported'), 'the fallback does not state that continuation is unsupported');

      return `Ticket:RequestTransition refused as Unavailable with ${transitions.length} transition offered to the owner instead; Engine:ResumeSession fell back to a fresh session from ${FIXTURE_ENGINE_CHECKPOINT.checkpointId} with no external write.`;
    },
  );
}

/**
 * N05-AC2, F11-AC3: an identity this adapter does not own is rejected, whether
 * the provider name differs or only the resource kind does.
 */
function wrongProviderIdentityIsRejected(adapters: AdapterSet): Promise<ContractCaseResult> {
  return contractCase('N05-AC2 a wrong-provider identity is rejected rather than substituted', async () => {
    const crossProvider = expectCode(
      await errOf(
        adapters.git.readState(adapterContext('op_foreign_read'), {
          repository: { ...FIXTURE_REPOSITORY, provider: FOREIGN_PROVIDER },
          branch: 'develop',
          baseBranch: 'develop',
        }),
        'git.readState for a repository owned by another provider',
      ),
      'Forbidden',
      'a foreign-provider identity',
    );
    expectTrue(crossProvider.reason.includes(FOREIGN_PROVIDER), 'the rejection does not name the owning provider');

    expectCode(
      await errOf(
        adapters.ticket.readScope(adapterContext('op_foreign_scope'), {
          workItemId: FIXTURE_WORK_ITEM_ID,
          issueId: providerId('repo_fixture_01'),
        }),
        'ticket.readScope for a Git identity',
      ),
      'Forbidden',
      'a Git identity offered to the ticket adapter',
    );

    const owned = await okOf(
      adapters.git.readState(adapterContext('op_owned_read'), {
        repository: FIXTURE_REPOSITORY,
        branch: 'develop',
        baseBranch: 'develop',
      }),
      'git.readState for the owned repository',
    );
    expectTrue(owned.repository.fullName === 'fixture/repo', 'the owned repository was not readable, so the refusal may be a blanket refusal');
    expectTrue(adapters.effects.count() === 0, 'reading identity performed a side effect');
    return `Both a foreign-provider Git identity and a wrong-kind identity were Forbidden; the owned repository still reads.`;
  });
}

/** F12-AC1, F11-AC1: a live scope read preserves criteria and dependency identity. */
function liveScopeReadPreservesScope(adapters: AdapterSet): Promise<ContractCaseResult> {
  return contractCase('F12-AC1 a live scope read preserves acceptance criteria and dependencies unchanged', async () => {
    const read = await okOf(
      adapters.ticket.readScope(adapterContext('op_scope_read'), {
        workItemId: FIXTURE_WORK_ITEM_ID,
        issueId: FIXTURE_ISSUE_ID,
      }),
      'ticket.readScope',
    );
    const snapshot = read.snapshot;
    expectTrue(
      scopeFingerprint(snapshot) === scopeFingerprint(FIXTURE_SCOPE_SNAPSHOT),
      'the adapter altered the material scope content it read',
    );
    expectTrue(
      snapshot.acceptanceCriteria.length === FIXTURE_SCOPE_SNAPSHOT.acceptanceCriteria.length,
      'the adapter dropped or invented acceptance criteria',
    );
    expectTrue(
      snapshot.dependencyIssueIds.includes(FIXTURE_DEPENDENCY_ISSUE_ID),
      'the adapter dropped a scope dependency identity',
    );
    expectTrue(
      snapshot.providerRevision === FIXTURE_SCOPE_SNAPSHOT.providerRevision,
      'the provider revision was not retained for later comparison',
    );
    expectTrue(read.issue.identifier === FIXTURE_SCOPE_SNAPSHOT.issueIdentifier, 'the read lost the provider issue identity');
    expectTrue(read.observedAt.length > 0, 'the read carries no observation time');

    const related = await okOf(
      adapters.ticket.findRelatedIssues(adapterContext('op_related'), {
        workItemId: FIXTURE_WORK_ITEM_ID,
        scope: FIXTURE_SCOPE_SNAPSHOT,
        limit: 10,
      }),
      'ticket.findRelatedIssues',
    );
    expectTrue(
      related.some((issue) => issue.issue.issueId === FIXTURE_DEPENDENCY_ISSUE_ID),
      'the dependency was not surfaced as related work',
    );
    expectTrue(
      related.every((issue) => issue.adoption.kind !== 'OwnerSelected'),
      'the adapter adopted related work instead of offering it to the owner',
    );
    return `Scope ${snapshot.issueIdentifier} read with ${snapshot.acceptanceCriteria.length} criteria and ${snapshot.dependencyIssueIds.length} dependency; fingerprint unchanged and ${related.length} related issue offered to the owner.`;
  });
}

/** F30-AC2, F13-AC2, F16-AC3: a repeated write with one operation identity writes once. */
function repeatedWriteProducesOneSideEffect(adapters: AdapterSet): Promise<ContractCaseResult> {
  return contractCase('F30-AC2 a repeated write with the same operation identity produces exactly one side effect', async () => {
    const draftOperation = operationId('contract-case-04-draft');
    const first = await okOf(adapters.git.upsertDraft(adapterContext('contract-case-04-draft'), upsertDraftRequest('contract-case-04-draft')), 'git.upsertDraft');
    expectTrue(first.kind === 'Created', 'the first draft write was not reported as created');
    const repeated = await okOf(adapters.git.upsertDraft(adapterContext('contract-case-04-draft'), upsertDraftRequest('contract-case-04-draft')), 'git.upsertDraft repeated with the same identity');
    expectTrue(repeated.kind === 'Unchanged', 'the repeated write was not reported as unchanged');
    expectTrue(
      repeated.draft.pullRequest.pullRequestId === first.draft.pullRequest.pullRequestId,
      'the repeated write produced a different provider identity',
    );
    expectTrue(repeated.draft.managedMarker === first.draft.managedMarker, 'the repeated write lost the managed marker it recovers by');

    const progressOperation = operationId('contract-case-04-progress');
    const progress = managedProgressUpdateRequest('contract-case-04-progress');
    const firstComment = expectUpdatedProgress(
      await okOf(adapters.ticket.updateManagedProgress(adapterContext('contract-case-04-progress'), progress), 'ticket.updateManagedProgress'),
    );
    const repeatedComment = expectUnchangedProgress(
      await okOf(adapters.ticket.updateManagedProgress(adapterContext('contract-case-04-progress'), progress), 'ticket.updateManagedProgress repeated'),
    );
    const firstCommentId = expectCommentTarget(firstComment.region);
    expectTrue(expectCommentTarget(repeatedComment.region) === firstCommentId, 'the repeated progress update created a second comment');
    expectTrue(repeatedComment.deliveredMilestoneKey === progress.milestoneKey, 'the repeated update lost the milestone it delivered');

    const published = await okOf(adapters.ticket.publishWork(adapterContext('contract-case-04-publish'), publishWorkRequest('contract-case-04-publish')), 'ticket.publishWork');
    expectTrue(published.kind === 'Published', 'the publication was not reported as published');
    expectTrue(published.published.length === 1, 'the publication reported more than one issue');
    const republished = await okOf(adapters.ticket.publishWork(adapterContext('contract-case-04-publish'), publishWorkRequest('contract-case-04-publish')), 'ticket.publishWork repeated');
    expectTrue(republished.published[0]?.issue.issueId === published.published[0]?.issue.issueId, 'the repeated publication created a second issue');
    expectTrue(republished.published[0]?.disposition === 'AlreadyPresent', 'the repeated publication did not report the issue as already present');

    const push = pushBranchRequest('contract-case-04-push');
    const pushed = await okOf(adapters.git.pushBranch(adapterContext('contract-case-04-push'), push), 'git.pushBranch');
    expectTrue(pushed.kind === 'Pushed', 'the first push was not reported as pushed');
    const repushed = await okOf(adapters.git.pushBranch(adapterContext('contract-case-04-push'), push), 'git.pushBranch repeated');
    expectTrue(repushed.kind === 'AlreadyPresent', 'the repeated push was not reported as already present');

    expectTrue(adapters.effects.effectsFor(draftOperation).length === 1, 'the ledger holds more than one draft write');
    expectTrue(adapters.effects.effectsFor(progressOperation).length === 1, 'the ledger holds more than one progress write');
    expectTrue(adapters.effects.effectsFor('contract-case-04-publish').length === 1, 'the ledger holds more than one publication');
    expectTrue(adapters.effects.effectsFor('contract-case-04-push').length === 1, 'the ledger holds more than one push');
    expectTrue(adapters.effects.count() === 4, `expected exactly four side effects in total, saw ${adapters.effects.count()}`);
    return `Draft ${first.draft.pullRequest.pullRequestId}, issue ${published.published[0]?.issue.issueId}, comment ${firstCommentId} and branch ${pushed.branch} were each written once; the ledger holds ${adapters.effects.count()} side effects.`;
  });
}

/** F28-AC4, F30-AC5, F19-AC3: a lost response is unknown, not success, and never repeated. */
function lostResponseYieldsOutcomeUnknown(adapters: AdapterSet): Promise<ContractCaseResult> {
  return contractCase('F28-AC4 a lost external response yields OutcomeUnknown and is reconciled without a second write', async () => {
    adapters.conditions.loseNextWriteResponse(1);
    const lost = expectCode(
      await errOf(adapters.git.upsertDraft(adapterContext('op_fixture_draft_01'), upsertDraftRequest('op_fixture_draft_01')), 'git.upsertDraft with a lost response'),
      'OutcomeUnknown',
      'a lost external response',
    );
    expectTrue(lost.operationId === 'op_fixture_draft_01', 'the lost outcome did not retain the operation identity');
    expectTrue(lost.target.includes(FIXTURE_DRAFT_BODY.managedMarker), 'the lost outcome did not retain the target');

    const effects = adapters.effects.effectsFor('op_fixture_draft_01');
    expectTrue(effects.length === 1, `expected one recorded attempt, saw ${effects.length}`);
    expectTrue(effects[0]?.outcome === 'OutcomeUnknown', 'the recorded attempt does not carry the ambiguous outcome');
    expectTrue((effects[0]?.externalId ?? '').length > 0, 'the recorded attempt kept no provider identity to reconcile against');

    const reconciled = await okOf(
      adapters.git.findDrafts(adapterContext('op_fixture_draft_01'), findDraftsRequest('op_fixture_draft_01')),
      'git.findDrafts',
    );
    expectTrue(reconciled.length === 1, `reconciliation found ${reconciled.length} drafts, expected the one whose write was lost`);
    expectTrue(reconciled[0] !== undefined && reconciled[0].managedMarker.includes('op_fixture_draft_01'), 'the recovered draft does not carry the operation identity it was written under');
    expectTrue((reconciled[0]?.pullRequest.pullRequestId ?? '').length > 0, 'reconciliation returned no provider identity for the recorded write');
    expectTrue(adapters.effects.count() === 1, 'reconciliation created a second side effect');

    expectCode(
      await errOf(adapters.git.upsertDraft(adapterContext('op_fixture_draft_01'), upsertDraftRequest('op_fixture_draft_01')), 'a blind retry after the lost response'),
      'OutcomeUnknown',
      'a blind retry over an unreconciled write',
    );
    expectTrue(adapters.effects.count() === 1, `a blind retry created another side effect; ledger holds ${adapters.effects.count()}`);

    return `Lost response returned OutcomeUnknown for ${lost.operationId}; reconciliation found ${reconciled[0]?.pullRequest.pullRequestId} without repeating the write.`;
  });
}

/** F03-AC4, F03-AC2: revoked access surfaces once, as an actionable error. */
function revokedAccessIsActionableWithoutRetry(adapters: AdapterSet): Promise<ContractCaseResult> {
  return contractCase('F03-AC4 revoked access is an actionable error reported once, not a retry loop', async () => {
    adapters.conditions.revokeAccess(adapters.git.connectorId, REVOKED_ACCESS_MESSAGE);
    const blocked = expectCode(
      await errOf(
        adapters.git.readState(adapterContext('op_revoked_read'), {
          repository: FIXTURE_REPOSITORY,
          branch: 'develop',
          baseBranch: 'develop',
        }),
        'git.readState after access was revoked',
      ),
      'Forbidden',
      'a read after access was revoked',
    );
    expectTrue(blocked.reason.includes('reauthorize'), 'the access error does not tell the owner what to do');
    expectTrue(adapters.git.attempts('readState') === 1, 'the adapter retried a revoked credential');

    const compatibility = await okOf(
      adapters.git.checkCompatibility(adapterContext('op_revoked_compat')),
      'git.checkCompatibility',
    );
    expectTrue(!compatibility.compatible, 'a revoked connector reported itself compatible');
    expectTrue(compatibility.detail.includes('reauthorize'), 'the compatibility check does not tell the owner what to do');

    const health = adapters.git.health();
    expectTrue(health.state === 'Revoked', `connector health reports ${health.state} while access is revoked`);
    expectTrue(health.error !== null && health.error.length > 0, 'connector health carries no actionable error');
    expectTrue(health.lastSuccessAt !== null, 'connector health lost the last successful observation');
    expectTrue(adapters.effects.count() === 0, 'a blocked read performed a side effect');
    return `Revoked Git access returned Forbidden once with an actionable message; compatibility reported incompatible and connector health Revoked with a last success time.`;
  });
}

/** F30-AC4: a rate limit keeps its category and retry hint and is not retried locally. */
function rateLimitIsSurfacedWithRetryHint(adapters: AdapterSet): Promise<ContractCaseResult> {
  return contractCase('F30-AC4 a rate limit is surfaced with its category and retry hint instead of being retried', async () => {
    adapters.conditions.rateLimitNextCall(1, 4500);
    const limited = expectCode(
      await errOf(
        adapters.git.readState(adapterContext('op_rate_limited'), {
          repository: FIXTURE_REPOSITORY,
          branch: 'develop',
          baseBranch: 'develop',
        }),
        'git.readState under a provider rate limit',
      ),
      'RateLimited',
      'a rate-limited call',
    );
    expectTrue(limited.retryAfterMs === 4500, `the retry hint was not surfaced: ${String(limited.retryAfterMs)}`);
    expectTrue(adapters.git.attempts('readState') === 1, 'the adapter retried inside the rate limit instead of surfacing it');

    const after = await okOf(
      adapters.git.readState(adapterContext('op_after_limit'), {
        repository: FIXTURE_REPOSITORY,
        branch: 'develop',
        baseBranch: 'develop',
      }),
      'git.readState after the limited call',
    );
    expectTrue(after.head.kind === 'Branch' && after.head.sha === FIXTURE_HEAD_SHA, 'the call after the rate limit did not return the current head');
    expectTrue(adapters.git.attempts('readState') === 2, 'attempts are not one per call, so a retry loop is hidden');
    return `RateLimited surfaced with retryAfterMs=4500 after one attempt; the following call succeeded without local retrying.`;
  });
}

/** F26-AC3: a merge precondition on head is enforced against current provider state. */
function mergePreconditionRejectsChangedHead(adapters: AdapterSet): Promise<ContractCaseResult> {
  return contractCase('F26-AC3 a merge is refused when the head precondition no longer matches', async () => {
    const created = await okOf(adapters.git.upsertDraft(adapterContext('contract-case-08-draft'), upsertDraftRequest('contract-case-08-draft')), 'git.upsertDraft');
    expectTrue(created.kind === 'Created', 'the draft was not created before the merge');
    const pullRequest = created.draft.pullRequest.pullRequestId;
    const stale = expectCode(
      await errOf(
        adapters.git.mergePullRequest(
          adapterContext('contract-case-08-merge-stale'),
          mergePullRequestRequest('contract-case-08-merge-stale', pullRequest, FIXTURE_SUPERSEDED_HEAD_SHA),
        ),
        'git.mergePullRequest with a stale head precondition',
      ),
      'Conflict',
      'a merge whose head precondition moved',
    );
    expectTrue(stale.actual === FIXTURE_HEAD_SHA, 'the conflict does not report the head the provider actually holds');
    expectTrue(stale.expected === FIXTURE_SUPERSEDED_HEAD_SHA, 'the conflict does not report the head that was pinned');
    expectTrue(adapters.effects.count() === 1, 'the refused merge still performed a side effect');

    const merged = await okOf(
      adapters.git.mergePullRequest(
        adapterContext('contract-case-08-merge-current'),
        mergePullRequestRequest('contract-case-08-merge-current', pullRequest, FIXTURE_HEAD_SHA),
      ),
      'git.mergePullRequest with the current head precondition',
    );
    expectTrue(merged.kind === 'Merged', 'the merge with a matching precondition did not report a merge');
    expectTrue(merged.kind === 'Merged' && merged.mergeCommitSha === FIXTURE_MERGE_COMMIT_SHA, 'the merge did not report the provider merge commit');
    expectTrue(merged.kind === 'Merged' && merged.contentRelation.kind === 'MatchesAuthorizedHead', 'the merge did not state whether the merged content is the authorized head');
    expectTrue(adapters.effects.effectsFor('contract-case-08-merge-current').length === 1, 'the merge was recorded more than once');

    // The provider head has moved to the merge commit, so a caller still holding
    // the earlier authorization merges content it did not authorize, and the
    // outcome has to say so (F26-AC4).
    const moved = await okOf(
      adapters.git.mergePullRequest(
        adapterContext('contract-case-08-merge-moved'),
        mergePullRequestRequest('contract-case-08-merge-moved', pullRequest, FIXTURE_MERGE_COMMIT_SHA, FIXTURE_HEAD_SHA),
      ),
      'git.mergePullRequest after the head moved past the authorization',
    );
    expectTrue(
      moved.kind === 'Merged' && moved.contentRelation.kind === 'DiffersFromAuthorizedHead',
      'a merge that moved past the authorized head did not report the difference',
    );
    expectTrue(
      moved.kind === 'Merged' && moved.contentRelation.kind === 'DiffersFromAuthorizedHead' && moved.contentRelation.detail.includes(FIXTURE_HEAD_SHA.slice(0, 12)),
      'the content difference does not name the authorized head',
    );
    return `Merge refused with Conflict (actual head ${stale.actual.slice(0, 12)}) and performed no write; the matching precondition merged to ${FIXTURE_MERGE_COMMIT_SHA.slice(0, 12)}, and a later merge past the authorization reported DiffersFromAuthorizedHead.`;
  });
}

/** F15-AC2: malformed engine output never becomes a successful completion. */
function malformedEngineOutputIsNotCompletion(adapters: AdapterSet): Promise<ContractCaseResult> {
  return contractCase('F15-AC2 malformed engine output does not become a successful completion', async () => {
    expectTrue(
      FIXTURE_ENGINE_EVENT_LINES.some((line) => line.includes('"status":"success"')),
      'the fixture no longer contains a success claim to refuse',
    );
    const handle = await okOf(
      adapters.engine.startSession(adapterContext('contract-case-09-session'), engineStartRequest('contract-case-09-session', 'Preview the scoped change.')),
      'engine.startSession',
    );
    const events = await eventsOf(handle);

    expectTrue(
      !events.some((event) => event.kind === 'Result' && event.outcome.kind === 'Succeeded'),
      'malformed engine output was reported as a successful completion',
    );
    const diagnostics = events.filter((event) => event.kind === 'Diagnostic');
    expectTrue(diagnostics.length === 1, `expected exactly one diagnostic, saw ${diagnostics.length}`);
    expectTrue(diagnostics[0]?.category === 'MalformedOutput', 'the diagnostic does not name malformed output');
    expectTrue(diagnostics[0]?.retry === 'Terminal', 'a deterministic parse failure was marked retryable');
    expectTrue(diagnostics[0] !== undefined && diagnostics[0].detail.includes('line'), 'the diagnostic does not locate the malformed output');

    const usage = events.filter((event) => event.kind === 'Usage');
    expectTrue(usage.length === 1, 'expected exactly one usage event');
    expectTrue(usage[0]?.usage.kind === 'Unknown', 'a token count was reported from a stream that could not be fully parsed');
    expectTrue(
      usage[0]?.usage.kind === 'Unknown' && usage[0].usage.reason.length > 0,
      'an unknown usage record states no reason',
    );

    const progress = progressOf(events);
    expectTrue(progress.length === 1, 'clean progress events before the malformed line were discarded');
    expectTrue(progress[0]?.detail?.sanitized === true, 'the artifact observed before the bad line was not retained as sanitized evidence');
    expectTrue(adapters.engine.attempts('startSession') === 1, 'the adapter reparsed the malformed stream instead of reporting the failure');
    return `The stream claimed success and contained one malformed line; the adapter reported a MalformedOutput diagnostic, usage Unknown, and the milestone observed before the bad line.`;
  });
}

/** F19-AC5: a read-only job completes with a stated no-code outcome and no draft. */
function readOnlyJobCompletesWithoutDraft(adapters: AdapterSet): Promise<ContractCaseResult> {
  return contractCase('F19-AC5 a read-only job completes with a stated no-code outcome and opens no draft', async () => {
    const handle = await okOf(
      adapters.engine.startSessionFrom(
        adapterContext('contract-case-10-session'),
        engineStartRequest('contract-case-10-session', 'Investigate the reported failure.'),
        FIXTURE_READ_ONLY_ENGINE_EVENT_LINES,
      ),
      'engine.startSession',
    );
    const events = await eventsOf(handle);
    const succeeded = events.some((event) => event.kind === 'Result' && event.outcome.kind === 'Succeeded');
    expectTrue(succeeded, 'a read-only job did not complete');

    const noCode = progressOf(events).find((event) => event.milestoneKey === 'no-code-change');
    expectTrue(noCode !== undefined, 'a read-only job reported that it produced a change');
    expectTrue(
      noCode !== undefined && noCode.summary.includes('no repository change'),
      'the no-code outcome was not stated',
    );

    const usage = events.filter((event) => event.kind === 'Usage');
    expectTrue(usage.length === 0, 'usage was reported although the stream reported none');

    const declaration = await okOf(
      adapters.git.declareNoCodeOutcome(
        adapterContext('contract-case-10-declare'),
        declareNoCodeOutcomeRequest('contract-case-10-declare', 'ReadOnlyJob'),
      ),
      'git.declareNoCodeOutcome',
    );
    expectTrue(declaration.pullRequest === null, 'a no-code outcome still carries a pull request');
    expectTrue(declaration.branchState === 'NeverPushed', 'a read-only job reported a pushed branch');
    expectTrue(declaration.evidence.length > 0 && declaration.evidence.every((entry) => entry.sanitized), 'the no-code declaration carried no sanitized evidence');
    expectTrue(adapters.effects.count() === 0, 'a read-only job performed an external write');

    const drafts = await okOf(
      adapters.git.findDrafts(adapterContext('contract-case-10-declare'), findDraftsRequest('contract-case-10-declare')),
      'git.findDrafts',
    );
    expectTrue(drafts.length === 0, 'a draft change was opened for a read-only job');

    const stopped = await okOf(
      adapters.engine.stopSession(adapterContext('contract-case-10-stop'), {
        operationId: operationId('contract-case-10-stop'),
        sessionId: handle.sessionId,
        reason: 'CancelRequested',
      }),
      'engine.stopSession',
    );
    expectTrue(stopped.kind === 'Stopped', 'the read-only session did not stop gracefully');
    expectTrue(stopped.kind === 'Stopped' && stopped.checkpoint !== null, 'stopping the session left no checkpoint to resume from');
    expectTrue(
      stopped.kind === 'Stopped' && stopped.checkpoint?.dirtyPaths.length === 0,
      'stopping the session left the workspace dirty',
    );
    return `Read-only job completed with ${progressOf(events).length} progress events, codeProduced=false, a NoCodeOutcomeRecord with no pull request, and no draft on the provider.`;
  });
}

/** F22-AC3: missing, building, failed, protected and usable stay distinct. */
function protectedPreviewIsNotUsable(adapters: AdapterSet): Promise<ContractCaseResult> {
  return contractCase('F22-AC3 a protected preview is not reported as a usable application preview', async () => {
    const observed: string[] = [];
    for (const fixture of Object.values(FIXTURE_AVAILABILITIES)) {
      const discovery = await okOf(
        adapters.deployment.discoverDeployment(adapterContext('op_discover'), fixture.discovery),
        'deployment.discoverDeployment',
      );
      if (fixture.discovered === null) {
        expectTrue(discovery.kind === 'NotFound', `discovery returned ${discovery.kind} where no deployment identity exists`);
        expectTrue(
          discovery.kind === 'NotFound' && discovery.ineligible.some((entry) => entry.deploymentId === FIXTURE_DEPLOYMENT_ID && entry.ineligibility === 'DifferentCommit'),
          'discovery did not name the deployment it refused, or named it as a substitute',
        );
        observed.push('Missing');
        continue;
      }
      expectTrue(discovery.kind === 'Found', `discovery did not find the ${fixture.kind} deployment`);
      if (discovery.kind !== 'Found') continue;
      const deployment = discovery.deployment;
      expectTrue(deployment.availability.kind === fixture.kind, `the ${fixture.kind} state was reported as ${deployment.availability.kind}`);
      expectTrue(deployment.match.kind === 'Matches', `the ${fixture.kind} deployment was reported as not matching the requested commit`);
      expectTrue(
        deployment.availability.kind === 'Usable' ? deployment.availability.proof.observation.kind !== 'RedirectedToSignIn' : true,
        `the ${fixture.kind} state carries an application proof`,
      );
      expectTrue(
        deployment.availability.kind !== 'Usable' ? 'proof' in deployment.availability === false : true,
        `a ${fixture.kind} deployment can be read as a verified application`,
      );
      observed.push(deployment.availability.kind);
    }

    const protectedRead = await okOf(
      adapters.deployment.readIdentity(adapterContext('op_protected_read'), {
        deploymentId: FIXTURE_DEPLOYMENT_ID,
        expectedCommitSha: FIXTURE_HEAD_SHA,
        expectedEnvironment: 'preview',
      }),
      'deployment.readIdentity for the protected deployment',
    );
    expectTrue(
      protectedRead.availability.kind === 'Protected' && protectedRead.access.kind === 'RedirectedToSignIn',
      `the protected deployment was read as ${protectedRead.availability.kind}/${protectedRead.access.kind}`,
    );
    expectTrue(
      protectedRead.deploymentId === FIXTURE_PROTECTED_DEPLOYMENT.deploymentId,
      'the protected preview was not the deployment that was read',
    );
    expectTrue('proof' in protectedRead.availability === false, 'a protected sign-in page was read as a verified application');

    const protectedFlow = await okOf(
      adapters.verification.collectEvidence(adapterContext('op_protected_flow'), {
        kind: 'Browser',
        operationId: operationId('op_protected_flow'),
        workspace: FIXTURE_WORKSPACE,
        flow: browserFlowSpec('flow_fixture_protected', FIXTURE_PROTECTED_DEPLOYMENT_URL),
        criterionIds: ['AC2'],
      }),
      'verification.collectEvidence for the protected preview',
    );
    expectTrue(
      protectedFlow.kind === 'Browser' && protectedFlow.evidence.outcome.kind === 'BlockedBySignIn',
      'a protected sign-in page satisfied the browser flow as application verification',
    );

    const usableFlow = await okOf(
      adapters.verification.collectEvidence(adapterContext('op_usable_flow'), {
        kind: 'Browser',
        operationId: operationId('op_usable_flow'),
        workspace: FIXTURE_WORKSPACE,
        flow: browserFlowSpec('flow_fixture_usable', FIXTURE_USABLE_DEPLOYMENT.url),
        criterionIds: ['AC1'],
      }),
      'verification.collectEvidence for the usable preview',
    );
    expectTrue(
      usableFlow.kind === 'Browser' && usableFlow.evidence.outcome.kind === 'ExpectationMet',
      'the usable deployment could not be exercised as an application',
    );

    const protectedExchange = await okOf(
      adapters.verification.collectEvidence(adapterContext('op_protected_exchange'), {
        kind: 'Api',
        operationId: operationId('op_protected_exchange'),
        workspace: FIXTURE_WORKSPACE,
        exchange: apiExchangeSpec('exchange_fixture_protected', FIXTURE_PROTECTED_DEPLOYMENT_URL),
        criterionIds: ['AC2'],
      }),
      'verification.collectEvidence for the protected preview over the API',
    );
    expectTrue(
      protectedExchange.kind === 'Api' && protectedExchange.evidence.outcome.kind === 'FailedAtStep',
      'an API exchange against a sign-in page was reported as expectations met',
    );

    const usableExchange = await okOf(
      adapters.verification.collectEvidence(adapterContext('op_usable_exchange'), {
        kind: 'Api',
        operationId: operationId('op_usable_exchange'),
        workspace: FIXTURE_WORKSPACE,
        exchange: apiExchangeSpec('exchange_fixture_usable', FIXTURE_USABLE_DEPLOYMENT.url),
        criterionIds: ['AC1'],
      }),
      'verification.collectEvidence for the usable preview over the API',
    );
    expectTrue(
      usableExchange.kind === 'Api' && usableExchange.evidence.outcome.kind === 'ExpectationsMet',
      'the usable deployment could not be exercised over the API',
    );

    return `All ${observed.length} preview states were discovered and kept distinct; only the Usable state carries an application proof, so the protected sign-in page is reported as blocked rather than verified by browser or API.`;
  });
}

/** F28-AC3: a partial component failure stays unconfirmed with component-level evidence. */
function partialComponentFailureIsNotReleased(adapters: AdapterSet): Promise<ContractCaseResult> {
  return contractCase('F28-AC3 a partial component failure is not reported as released and keeps component evidence', async () => {
    adapters.conditions.programComponentOutcomes({ web: 'Usable', api: 'Failed' });
    const webOperation = 'contract-case-12-web';
    const apiOperation = 'contract-case-12-api';

    const webExecution = await okOf(
      adapters.deployment.executeDeliveryAction(adapterContext(webOperation), redeployAction('web', 'production')),
      'deployment.executeDeliveryAction for web',
    );
    expectTrue(webExecution.kind === 'Completed', 'the succeeding component produced no completed execution');
    expectTrue(
      webExecution.kind === 'Completed' && webExecution.deployment.availability.kind === 'Usable',
      'the succeeding component lost its state',
    );
    const apiExecution = await okOf(
      adapters.deployment.executeDeliveryAction(adapterContext(apiOperation), redeployAction('api', 'production')),
      'deployment.executeDeliveryAction for api',
    );
    expectTrue(apiExecution.kind === 'Completed', 'the failing component produced no execution record to inspect');
    expectTrue(
      apiExecution.kind === 'Completed' && apiExecution.deployment.availability.kind === 'Failed',
      'the failing component did not report a failed deployment',
    );
    expectTrue(
      apiExecution.kind === 'Completed' && apiExecution.deployment.availability.kind === 'Failed' && apiExecution.deployment.availability.providerMessage.length > 0,
      'the failing component lost its state or reason',
    );
    expectTrue(webExecution.kind === 'Completed' && apiExecution.kind === 'Completed' && webExecution.deployment.deploymentId !== apiExecution.deployment.deploymentId, 'component-level evidence was reduced to a single deployment identity');
    expectTrue(adapters.effects.effectsFor(webOperation).length === 1, 'the web delivery write was recorded more than once');
    expectTrue(adapters.effects.effectsFor(apiOperation).length === 1, 'the api delivery write was recorded more than once');

    const verified = await okOf(
      adapters.deployment.verifyDestination(
        adapterContext(webOperation),
        verifyDestinationRequest(webOperation, ['web', 'api']),
      ),
      'deployment.verifyDestination after the partial failure',
    );
    expectTrue(verified.kind === 'PartiallyConfirmed', `a partial component failure was reported as ${verified.kind}`);
    expectTrue(
      verified.kind === 'PartiallyConfirmed' && verified.components.some((component) => component.component === 'web'),
      'the succeeding component lost its verified identity',
    );
    expectTrue(
      verified.kind === 'PartiallyConfirmed' && verified.failures.some((failure) => failure.component === 'api' && failure.kind === 'SmokeFailed'),
      'the failing component was not reported',
    );
    expectTrue(
      verified.kind === 'PartiallyConfirmed' && verified.failures.some((failure) => failure.detail.includes('api')),
      'the verification reason does not name the failing component',
    );
    expectTrue(verified.smoke.kind === 'Failed', 'the live smoke check passed while a component failed');
    expectTrue(
      verified.kind === 'PartiallyConfirmed' && verified.smoke.kind === 'Failed' && verified.smoke.probes.some((probe) => probe.outcome.kind === 'StatusMismatch'),
      'the live smoke check reported no mismatch for the failing component',
    );

    const mismatch = await okOf(
      adapters.deployment.verifyDestination(
        adapterContext(webOperation),
        verifyDestinationRequest(webOperation, ['web', 'api'], FIXTURE_SUPERSEDED_HEAD_SHA),
      ),
      'deployment.verifyDestination against a different deployment identity',
    );
    expectTrue(mismatch.kind !== 'Confirmed', 'a deployment identity mismatch still confirmed the destination');
    expectTrue(
      mismatch.kind === 'Unverifiable' && mismatch.detail.includes('web'),
      `an identity mismatch was reported as ${mismatch.kind} without naming the component`,
    );
    return `web reported Usable and api Failed, each delivery recorded once, and both the failed component and an identity mismatch left the destination unconfirmed with component-level evidence.`;
  });
}

/** F20-AC2, F20-AC5: every result state survives mapping and no gate is removed silently. */
function checkSetKeepsEveryResultState(adapters: AdapterSet): Promise<ContractCaseResult> {
  return contractCase('F20-AC2 every check result state is preserved and a required gate cannot be removed without policy', async () => {
    const readChecks = {
      repository: FIXTURE_REPOSITORY,
      headSha: FIXTURE_HEAD_SHA,
      baseSha: FIXTURE_BASE_SHA,
      candidateFingerprint: FIXTURE_CANDIDATE_FINGERPRINT,
      requiredCheckNames: [...FIXTURE_REQUIRED_CHECK_NAMES, FIXTURE_UNREPORTED_REQUIRED_CHECK_NAME],
    };
    const observations = await okOf(
      adapters.git.readChecks(adapterContext('op_read_checks'), readChecks),
      'git.readChecks',
    );
    expectTrue(
      observations.length === FIXTURE_CHECK_OBSERVATIONS.length + 1,
      'the provider read did not return every reported check plus the required check it never ran',
    );
    for (const result of CHECK_RESULTS) {
      expectTrue(observations.some((observation) => observation.result === result), `the provider read has no ${result} result`);
    }

    const missing = observations.find((observation) => observation.name === FIXTURE_UNREPORTED_REQUIRED_CHECK_NAME);
    expectTrue(missing?.result === 'Missing', 'a required check that never ran was not retained as Missing');
    expectTrue(missing?.result !== 'Passed', 'a required check that never ran was reported as Passed');
    expectTrue(missing?.requirement === 'ProfileRequired', 'a check the profile requires was not marked as its obligation');

    const stale = observations.find((observation) => observation.name === 'pnpm lint');
    expectTrue(stale?.result === 'Stale', 'the superseded check was not retained as Stale');
    expectTrue(stale?.requirement === 'ProfileRequired', 'a required stale check lost its requirement');

    const unapprovedCheck = FIXTURE_CONFIGURED_CHECKS.find((check) => check.name === 'pnpm test:a11y');
    if (unapprovedCheck === undefined) {
      throw new ContractCaseFailure(
        'the fixture no longer contains a required check reported Not applicable without a policy decision',
      );
    }
    // The profile approves one Not applicable check and refuses to let the coding
    // run drop the other, so the approval is recorded before the checks run.
    adapters.conditions.approveNotApplicable(['pnpm test:visual']);
    const records: CheckExecutionRecord[] = [];
    for (const check of FIXTURE_CONFIGURED_CHECKS) {
      // The unapproved check is refused, so it is asserted separately below.
      if (check.checkId === unapprovedCheck.checkId) continue;
      records.push(
        await okOf(
          adapters.verification.runCheck(adapterContext(`op_check_${check.checkId}`), checkExecutionRequest(`op_check_${check.checkId}`, check)),
          `verification.runCheck for ${check.name}`,
        ),
      );
    }
    for (const record of records) {
      expectTrue(
        record.candidateFingerprint === FIXTURE_CANDIDATE_FINGERPRINT,
        `${record.name} was not bound to the candidate the controller named`,
      );
    }
    expectTrue(
      records.every((record) => record.artifacts.every((artifact) => artifact.sanitized)),
      'a recorded check retained an unsanitized artifact',
    );

    const approved = records.find((record) => record.name === 'pnpm test:visual');
    expectTrue(
      approved !== undefined && approved.completion.kind === 'NotApplicable' && approved.completion.approvedByPolicy,
      'a policy-approved Not applicable check lost its approval marker',
    );
    const neverRan = records.find((record) => record.name === FIXTURE_UNREPORTED_REQUIRED_CHECK_NAME);
    expectTrue(neverRan?.completion.kind === 'NotStarted', 'a required check that never ran was reported as concluded');

    const mapped = await okOf(
      adapters.verification.mapCriteria(adapterContext('op_map_criteria'), {
        operationId: operationId('op_map_criteria'),
        criteria: FIXTURE_CHECK_CRITERIA,
        observations: records.map((record) => ({
          kind: 'Check',
          checkId: record.checkId,
          completion: record.completion,
        })),
        candidateFingerprint: FIXTURE_CANDIDATE_FINGERPRINT,
        scopeFingerprint: scopeFingerprint(FIXTURE_SCOPE_SNAPSHOT),
        observedAt: FIXED_LATER_INSTANT,
      }),
      'verification.mapCriteria',
    );
    expectTrue(
      mapped.find((evidence) => evidence.criterionId === 'check_fixture_failed')?.status === 'Failed',
      'a failed check did not map to a failed criterion',
    );
    expectTrue(
      mapped.find((evidence) => evidence.criterionId === 'check_fixture_stale')?.status === 'Stale',
      'a stale check did not map to a stale criterion',
    );
    expectTrue(
      mapped.find((evidence) => evidence.criterionId === 'check_fixture_unit')?.status === 'Missing',
      'a check that never ran did not map to a missing criterion',
    );
    expectTrue(
      mapped.find((evidence) => evidence.criterionId === 'check_fixture_visual')?.status === 'Untested',
      'a policy-approved Not applicable check was mapped as a verified criterion',
    );
    expectTrue(
      mapped.find((evidence) => evidence.criterionId === 'check_fixture_perf')?.status === 'Untested',
      'a check the coding run marked not applicable was mapped as a verified criterion',
    );
    expectTrue(
      mapped.find((evidence) => evidence.criterionId === 'check_fixture_absent')?.status === 'Untested',
      'a criterion with no observation was mapped as verified',
    );
    expectTrue(!acceptanceReady(mapped), 'criteria backed by a failed or stale check were reported as ready for acceptance');

    const domainChecks = records.map((record) =>
      toDomainCheckRecord(record, record.kind === 'Browser' ? 'BrowserEvidence' : 'LocalCheck'),
    );
    const eligibility = deliveryEligible({
      checks: domainChecks,
      acceptance: 'Accepted',
      acceptanceCandidateFingerprint: FIXTURE_CANDIDATE_FINGERPRINT,
      currentCandidateFingerprint: FIXTURE_CANDIDATE_FINGERPRINT,
    });
    expectTrue(!eligibility.eligible, 'the candidate was reported ready for delivery with blocking checks');
    for (const required of [FIXTURE_UNREPORTED_REQUIRED_CHECK_NAME, 'pnpm typecheck', 'pnpm lint']) {
      expectTrue(
        eligibility.reasons.some((reason) => reason.startsWith(`Required check "${required}"`)),
        `the blocking report does not name ${required}`,
      );
    }

    const unapproved = expectCode(
      await errOf(
        adapters.verification.runCheck(
          adapterContext('op_check_unapproved'),
          checkExecutionRequest('op_check_unapproved', unapprovedCheck),
        ),
        'verification.runCheck for an unapproved Not applicable required gate',
      ),
      'Blocked',
      'an unapproved Not applicable required gate',
    );
    expectTrue(
      unapproved.prerequisites.some((entry) => entry.name === 'RequiredCheckPolicy'),
      'the refusal does not name the policy prerequisite the owner must satisfy',
    );

    return `All ${CHECK_RESULTS.length} result states survived the read; Missing, Failed and Stale block delivery by name; an unapproved Not applicable required gate was Blocked on RequiredCheckPolicy.`;
  });
}

/** F30-AC2, F30-AC3: replayed and late deliveries cannot duplicate or revert facts. */
function outOfOrderEventsCannotRevertNewerFacts(adapters: AdapterSet): Promise<ContractCaseResult> {
  return contractCase('F30-AC2 a replayed or late delivery neither duplicates nor reverts newer provider facts', async () => {
    const newest = await okOfSync(adapters.events.ingest(FIXTURE_NEWEST_EVENT), 'ingest of the newest delivery');
    expectTrue(newest.sequence === FIXTURE_NEWEST_EVENT.sequence, 'the newest delivery was not applied');
    expectTrue(newest.draftHeadSha === FIXTURE_HEAD_SHA, 'the newest delivery did not become the current head');

    const replayed = await okOfSync(adapters.events.ingest(FIXTURE_NEWEST_EVENT), 'replay of the same delivery identity');
    expectTrue(replayed.sequence === newest.sequence, 'a replayed delivery changed the current facts');
    expectTrue(adapters.events.appliedDeliveries().length === 1, 'a replayed delivery was applied twice');

    const late = await okOfSync(adapters.events.ingest(FIXTURE_LATE_EVENT), 'ingest of a late delivery carrying an older head');
    expectTrue(late.draftHeadSha === FIXTURE_HEAD_SHA, 'a late delivery reverted newer candidate facts');
    expectTrue(late.sequence === FIXTURE_NEWEST_EVENT.sequence, 'a late delivery rewound the observed sequence');
    expectTrue(adapters.events.appliedDeliveries().length === 1, 'a late delivery was applied');

    const followed = await okOfSync(adapters.events.ingest(FIXTURE_FOLLOW_UP_EVENT), 'ingest of a later delivery');
    expectTrue(followed.sequence === FIXTURE_FOLLOW_UP_EVENT.sequence, 'a newer delivery was not applied');
    expectTrue(followed.draftHeadSha === FIXTURE_MERGE_COMMIT_SHA, 'the newer delivery did not become the current head');
    expectTrue(adapters.events.appliedDeliveries().length === 2, 'the newer delivery was not recorded exactly once');
    return `Delivery ${FIXTURE_NEWEST_EVENT.deliveryId} applied once, its replay was a no-op, delivery ${FIXTURE_LATE_EVENT.deliveryId} did not revert the head, and ${FIXTURE_FOLLOW_UP_EVENT.deliveryId} applied.`;
  });
}

/**
 * Runs every contract case against one adapter set.
 *
 * `freshAdapters` is used for each case so a case that revokes access, injects a
 * rate limit or programs component outcomes cannot leak into the next one.
 */
export async function runAdapterContractSuite(
  adapters: AdapterSet,
  freshAdapters: () => AdapterSet = () => adapters,
): Promise<readonly ContractCaseResult[]> {
  return Promise.all([
    unsupportedCapabilityIsUnavailable(freshAdapters()),
    wrongProviderIdentityIsRejected(freshAdapters()),
    liveScopeReadPreservesScope(freshAdapters()),
    repeatedWriteProducesOneSideEffect(freshAdapters()),
    lostResponseYieldsOutcomeUnknown(freshAdapters()),
    revokedAccessIsActionableWithoutRetry(freshAdapters()),
    rateLimitIsSurfacedWithRetryHint(freshAdapters()),
    mergePreconditionRejectsChangedHead(freshAdapters()),
    malformedEngineOutputIsNotCompletion(freshAdapters()),
    readOnlyJobCompletesWithoutDraft(freshAdapters()),
    protectedPreviewIsNotUsable(freshAdapters()),
    partialComponentFailureIsNotReleased(freshAdapters()),
    checkSetKeepsEveryResultState(freshAdapters()),
    outOfOrderEventsCannotRevertNewerFacts(freshAdapters()),
  ]);
}
