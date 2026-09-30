/**
 * The shared adapter contract suite.
 *
 * A second Git provider, a second ticket provider or a second engine is proven
 * by running this same case list, not by a bespoke test per provider
 * (N05-AC2, L03-AC1). Every case names the criterion it enforces so a failure
 * points at a spec line rather than at a helper.
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

import { CHECK_RESULTS, scopeFingerprint, type DomainError, type Result } from '@shiploop/domain';
import {
  FOREIGN_PROVIDER,
  FIXTURE_CANDIDATE_FINGERPRINT,
  FIXTURE_CANDIDATE_IDENTITY,
  FIXTURE_CHECK_OBSERVATIONS,
  FIXTURE_DEPLOYMENTS,
  FIXTURE_DEPLOYMENT_REFERENCE,
  FIXTURE_DRAFT_REQUEST,
  FIXTURE_ENGINE_EVENT_LINES,
  FIXTURE_FOLLOW_UP_EVENT,
  FIXTURE_HEAD_SHA,
  FIXTURE_ISSUE_REFERENCE,
  FIXTURE_LATE_EVENT,
  FIXTURE_MERGE_COMMIT_SHA,
  FIXTURE_NEWEST_EVENT,
  FIXTURE_PREVIEW_QUERY,
  FIXTURE_PUBLISH_REQUEST,
  FIXTURE_READ_ONLY_ENGINE_EVENT_LINES,
  FIXTURE_REPOSITORY_REFERENCE,
  FIXTURE_SCOPE_SNAPSHOT,
  FIXTURE_SUPERSEDED_HEAD_SHA,
  FIXTURE_TRANSITION_REQUEST,
  FIXTURE_UNAPPROVED_NOT_APPLICABLE_OBSERVATIONS,
  operationId,
} from './fixtures.ts';
import { DEPLOYMENT_STATES, type AdapterSet, type ManagedProgressUpdate, type DeploymentExecution } from './fake.ts';

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

function okOf<T>(result: Result<T, DomainError>, label: string): T {
  if (!result.ok) throw new ContractCaseFailure(`${label} did not succeed: returned ${result.error.code}`);
  return result.value;
}

function errOf<T>(result: Result<T, DomainError>, label: string): DomainError {
  if (result.ok) throw new ContractCaseFailure(`${label} unexpectedly succeeded`);
  return result.error;
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
function contractCase(name: string, run: () => string): ContractCaseResult {
  try {
    return { name, passed: true, detail: run() };
  } catch (error) {
    return { name, passed: false, detail: describeFailure(error) };
  }
}

const REVOKED_ACCESS_MESSAGE =
  'The stored credential for the Git connector was revoked by the provider and must be reauthorized before any new operation.';

/**
 * F03-AC4, F03-AC2, N05-AC2, F15-AC4: an unsupported capability is reported as
 * unavailable before any work, and a continuation the provider cannot perform
 * falls back to the checkpoint instead of being reported as restored.
 */
function unsupportedCapabilityIsUnavailable(adapters: AdapterSet): ContractCaseResult {
  return contractCase(
    'N05-AC2 an unsupported operation is reported as unavailable, and an unsupported continuation falls back to a checkpoint',
    () => {
      const refused = expectCode(
        errOf(adapters.ticket.requestTransition(FIXTURE_TRANSITION_REQUEST), 'ticket.requestTransition'),
        'Unavailable',
        'an unsupported operation',
      );
      expectTrue(refused.reason.includes('Developer Preview'), 'the refusal does not state the provider limitation');
      expectTrue(adapters.ticket.attempts('requestTransition') === 1, 'the adapter retried an unavailable operation');
      expectTrue(adapters.effects.count() === 0, 'an unavailable operation still performed a side effect');

      expectCode(
        errOf(adapters.engine.ensureSupported('Engine:ResumeSession'), 'engine.ensureSupported(Engine:ResumeSession)'),
        'Unavailable',
        'the Engine:ResumeSession capability declaration',
      );

      const resumed = okOf(
        adapters.engine.resume({ priorSessionId: 'sess_fixture_01', checkpointRef: 'checkpoint_fixture_07' }),
        'engine.resume',
      );
      expectTrue(!resumed.resumed, 'an unsupported continuation was reported as a resumed session');
      expectTrue(resumed.usedCheckpoint, 'the fallback did not use the checkpoint');
      expectTrue(resumed.sessionId !== 'sess_fixture_01', 'the fallback reused the unsupported session identity');
      expectTrue(resumed.reason.includes('not supported'), 'the fallback does not state that continuation is unsupported');

      return `Ticket:RequestTransition refused as Unavailable; Engine:ResumeSession fell back to a fresh session from checkpoint_fixture_07 with no external write.`;
    },
  );
}

/**
 * N05-AC2, F11-AC3: an identity this adapter does not own is rejected, whether
 * the provider name differs or only the resource kind does.
 */
function wrongProviderIdentityIsRejected(adapters: AdapterSet): ContractCaseResult {
  return contractCase('N05-AC2 a wrong-provider identity is rejected rather than substituted', () => {
    const crossProvider = expectCode(
      errOf(
        adapters.git.readRepository({
          reference: { provider: FOREIGN_PROVIDER, kind: 'Git', id: FIXTURE_REPOSITORY_REFERENCE.id },
          branch: 'develop',
        }),
        'git.readRepository for a repository owned by another provider',
      ),
      'Forbidden',
      'a foreign-provider identity',
    );
    expectTrue(crossProvider.reason.includes(FOREIGN_PROVIDER), 'the rejection does not name the owning provider');

    expectCode(
      errOf(
        adapters.ticket.readScope({
          provider: FIXTURE_REPOSITORY_REFERENCE.provider,
          kind: 'Ticket',
          id: FIXTURE_REPOSITORY_REFERENCE.id,
        }),
        'ticket.readScope for a Git identity',
      ),
      'Forbidden',
      'a Git identity offered to the ticket adapter',
    );

    const owned = okOf(
      adapters.git.readRepository({ reference: FIXTURE_REPOSITORY_REFERENCE, branch: 'develop' }),
      'git.readRepository for the owned repository',
    );
    expectTrue(owned.fullName === 'fixture/repo', 'the owned repository was not readable, so the refusal may be a blanket refusal');
    expectTrue(adapters.effects.count() === 0, 'reading identity performed a side effect');
    return `Both a foreign-provider Git identity and a wrong-kind identity were Forbidden; the owned repository still reads.`;
  });
}

/** F12-AC1, F11-AC1: a live scope read preserves criteria and dependency identity. */
function liveScopeReadPreservesScope(adapters: AdapterSet): ContractCaseResult {
  return contractCase('F12-AC1 a live scope read preserves acceptance criteria and dependencies unchanged', () => {
    const snapshot = okOf(adapters.ticket.readScope(FIXTURE_ISSUE_REFERENCE), 'ticket.readScope');
    expectTrue(
      scopeFingerprint(snapshot) === scopeFingerprint(FIXTURE_SCOPE_SNAPSHOT),
      'the adapter altered the material scope content it read',
    );
    expectTrue(
      snapshot.acceptanceCriteria.length === FIXTURE_SCOPE_SNAPSHOT.acceptanceCriteria.length,
      'the adapter dropped or invented acceptance criteria',
    );
    expectTrue(
      snapshot.dependencyIssueIds.includes('issue_fixture_dependency_01'),
      'the adapter dropped a scope dependency identity',
    );
    expectTrue(
      snapshot.providerRevision === FIXTURE_SCOPE_SNAPSHOT.providerRevision,
      'the provider revision was not retained for later comparison',
    );
    return `Scope ${snapshot.issueIdentifier} read with ${snapshot.acceptanceCriteria.length} criteria and ${snapshot.dependencyIssueIds.length} dependency; fingerprint unchanged.`;
  });
}

/** F30-AC2, F13-AC2, F16-AC3: a repeated write with one operation identity writes once. */
function repeatedWriteProducesOneSideEffect(adapters: AdapterSet): ContractCaseResult {
  return contractCase('F30-AC2 a repeated write with the same operation identity produces exactly one side effect', () => {
    const first = okOf(adapters.git.createDraft(FIXTURE_DRAFT_REQUEST), 'git.createDraft');
    const repeated = okOf(adapters.git.createDraft(FIXTURE_DRAFT_REQUEST), 'git.createDraft repeated with the same identity');
    expectTrue(first.reference.id === repeated.reference.id, 'the repeated write produced a different provider identity');

    const progress: ManagedProgressUpdate = {
      operationId: operationId('contract-case-03-progress'),
      issue: FIXTURE_ISSUE_REFERENCE,
      body: 'Draft linked and checks running.',
      milestone: 'Draft linked',
    };
    const firstComment = okOf(adapters.ticket.updateManagedProgress(progress), 'ticket.updateManagedProgress');
    const repeatedComment = okOf(adapters.ticket.updateManagedProgress(progress), 'ticket.updateManagedProgress repeated');
    expectTrue(firstComment.commentId === repeatedComment.commentId, 'the repeated progress update created a second comment');

    const published = okOf(adapters.ticket.publishIssue(FIXTURE_PUBLISH_REQUEST), 'ticket.publishIssue');
    const republished = okOf(adapters.ticket.publishIssue(FIXTURE_PUBLISH_REQUEST), 'ticket.publishIssue repeated');
    expectTrue(published.reference.id === republished.reference.id, 'the repeated publication created a second issue');

    expectTrue(adapters.effects.effectsFor(FIXTURE_DRAFT_REQUEST.operationId).length === 1, 'the ledger holds more than one draft write');
    expectTrue(adapters.effects.effectsFor(progress.operationId).length === 1, 'the ledger holds more than one progress write');
    expectTrue(adapters.effects.effectsFor(FIXTURE_PUBLISH_REQUEST.operationId).length === 1, 'the ledger holds more than one publication');
    expectTrue(adapters.effects.count() === 3, `expected exactly three side effects in total, saw ${adapters.effects.count()}`);
    return `Draft ${first.reference.id}, issue ${published.reference.id} and comment ${firstComment.commentId} were each written once; the ledger holds ${adapters.effects.count()} side effects.`;
  });
}

/** F28-AC4, F30-AC5, F19-AC3: a lost response is unknown, not success, and never repeated. */
function lostResponseYieldsOutcomeUnknown(adapters: AdapterSet): ContractCaseResult {
  return contractCase('F28-AC4 a lost external response yields OutcomeUnknown and is reconciled without a second write', () => {
    adapters.conditions.loseNextWriteResponse(1);
    const lost = expectCode(
      errOf(adapters.git.createDraft(FIXTURE_DRAFT_REQUEST), 'git.createDraft with a lost response'),
      'OutcomeUnknown',
      'a lost external response',
    );
    expectTrue(lost.operationId === FIXTURE_DRAFT_REQUEST.operationId, 'the lost outcome did not retain the operation identity');
    expectTrue(lost.target.includes(FIXTURE_DRAFT_REQUEST.branch), 'the lost outcome did not retain the target');

    const effects = adapters.effects.effectsFor(FIXTURE_DRAFT_REQUEST.operationId);
    expectTrue(effects.length === 1, `expected one recorded attempt, saw ${effects.length}`);
    expectTrue(effects[0]?.outcome === 'OutcomeUnknown', 'the recorded attempt does not carry the ambiguous outcome');

    const reconciled = okOf(adapters.git.reconcile(FIXTURE_DRAFT_REQUEST.operationId), 'git.reconcile');
    expectTrue(reconciled.externalId.length > 0, 'reconciliation returned no provider identity for the recorded write');
    expectTrue(adapters.effects.count() === 1, 'reconciliation created a second side effect');

    expectCode(
      errOf(adapters.git.createDraft(FIXTURE_DRAFT_REQUEST), 'a blind retry after the lost response'),
      'OutcomeUnknown',
      'a blind retry over an unreconciled write',
    );
    expectTrue(adapters.effects.count() === 1, `a blind retry created another side effect; ledger holds ${adapters.effects.count()}`);

    return `Lost response returned OutcomeUnknown for ${lost.operationId}; reconciliation found ${reconciled.externalId} without repeating the write.`;
  });
}

/** F03-AC4, F03-AC2: revoked access surfaces once, as an actionable error. */
function revokedAccessIsActionableWithoutRetry(adapters: AdapterSet): ContractCaseResult {
  return contractCase('F03-AC4 revoked access is an actionable error reported once, not a retry loop', () => {
    adapters.conditions.revokeAccess(adapters.git.connectorId, REVOKED_ACCESS_MESSAGE);
    const blocked = expectCode(
      errOf(
        adapters.git.readRepository({ reference: FIXTURE_REPOSITORY_REFERENCE, branch: 'develop' }),
        'git.readRepository after access was revoked',
      ),
      'Forbidden',
      'a read after access was revoked',
    );
    expectTrue(blocked.reason.includes('reauthorize'), 'the access error does not tell the owner what to do');
    expectTrue(adapters.git.attempts('readRepository') === 1, 'the adapter retried a revoked credential');

    const health = adapters.git.health();
    expectTrue(health.state === 'Revoked', `connector health reports ${health.state} while access is revoked`);
    expectTrue(health.error !== null && health.error.length > 0, 'connector health carries no actionable error');
    expectTrue(adapters.effects.count() === 0, 'a blocked read performed a side effect');
    return `Revoked Git access returned Forbidden once with an actionable message; connector health reports Revoked with a last success time.`;
  });
}

/** F30-AC4: a rate limit keeps its category and retry hint and is not retried locally. */
function rateLimitIsSurfacedWithRetryHint(adapters: AdapterSet): ContractCaseResult {
  return contractCase('F30-AC4 a rate limit is surfaced with its category and retry hint instead of being retried', () => {
    adapters.conditions.rateLimitNextCall(1, 4500);
    const limited = expectCode(
      errOf(
        adapters.git.readRepository({ reference: FIXTURE_REPOSITORY_REFERENCE, branch: 'develop' }),
        'git.readRepository under a provider rate limit',
      ),
      'RateLimited',
      'a rate-limited call',
    );
    expectTrue(limited.retryAfterMs === 4500, `the retry hint was not surfaced: ${String(limited.retryAfterMs)}`);
    expectTrue(adapters.git.attempts('readRepository') === 1, 'the adapter retried inside the rate limit instead of surfacing it');

    const after = okOf(
      adapters.git.readRepository({ reference: FIXTURE_REPOSITORY_REFERENCE, branch: 'develop' }),
      'git.readRepository after the limited call',
    );
    expectTrue(after.headSha === FIXTURE_HEAD_SHA, 'the call after the rate limit did not return the current head');
    expectTrue(adapters.git.attempts('readRepository') === 2, 'attempts are not one per call, so a retry loop is hidden');
    return `RateLimited surfaced with retryAfterMs=4500 after one attempt; the following call succeeded without local retrying.`;
  });
}

/** F26-AC3: a merge precondition on head is enforced against current provider state. */
function mergePreconditionRejectsChangedHead(adapters: AdapterSet): ContractCaseResult {
  return contractCase('F26-AC3 a merge is refused when the head precondition no longer matches', () => {
    const draft = okOf(adapters.git.createDraft(FIXTURE_DRAFT_REQUEST), 'git.createDraft');
    const stale = expectCode(
      errOf(
        adapters.git.merge({
          operationId: operationId('contract-case-08-merge-stale'),
          draft: draft.reference,
          expectedHeadSha: FIXTURE_SUPERSEDED_HEAD_SHA,
          mergeMethod: 'Squash',
        }),
        'git.merge with a stale head precondition',
      ),
      'Conflict',
      'a merge whose head precondition moved',
    );
    expectTrue(stale.actual === FIXTURE_HEAD_SHA, 'the conflict does not report the head the provider actually holds');
    expectTrue(adapters.effects.count() === 1, 'the refused merge still performed a side effect');

    const merged = okOf(
      adapters.git.merge({
        operationId: operationId('contract-case-08-merge-current'),
        draft: draft.reference,
        expectedHeadSha: FIXTURE_HEAD_SHA,
        mergeMethod: 'Squash',
      }),
      'git.merge with the current head precondition',
    );
    expectTrue(merged.mergeCommitSha === FIXTURE_MERGE_COMMIT_SHA, 'the merge did not report the provider merge commit');
    expectTrue(adapters.effects.effectsFor('contract-case-08-merge-current').length === 1, 'the merge was recorded more than once');
    return `Merge refused with Conflict (actual head ${stale.actual.slice(0, 12)}) and performed no write; the matching precondition merged to ${merged.mergeCommitSha.slice(0, 12)}.`;
  });
}

/** F15-AC2: malformed engine output never becomes a successful completion. */
function malformedEngineOutputIsNotCompletion(adapters: AdapterSet): ContractCaseResult {
  return contractCase('F15-AC2 malformed engine output does not become a successful completion', () => {
    const run = okOf(adapters.engine.parseEventStream(FIXTURE_ENGINE_EVENT_LINES), 'engine.parseEventStream');
    expectTrue(run.completionReported && run.completionSucceeded, 'the fixture no longer contains a success claim to refuse');
    expectTrue(run.outcome === 'MalformedOutput', `malformed output produced outcome ${run.outcome}`);
    expectTrue(!run.succeeded, 'malformed engine output was reported as a successful completion');
    expectTrue(run.malformed.length === 1, `expected exactly one malformed line, saw ${run.malformed.length}`);
    expectTrue(run.usage.kind === 'Unknown', 'a token count was reported from a stream that could not be fully parsed');
    expectTrue(run.milestones.length === 1, 'clean progress events before the malformed line were discarded');
    expectTrue(run.failureReason !== null && run.failureReason.includes('line'), 'the failure does not locate the malformed output');
    expectTrue(adapters.engine.attempts('parseEventStream') === 1, 'the adapter reparsed the malformed stream instead of reporting the failure');
    return `The stream claimed success and contained one malformed line; the adapter reported MalformedOutput, usage Unknown, and the milestone observed before the bad line.`;
  });
}

/** F19-AC5: a read-only job completes with a stated no-code outcome and no draft. */
function readOnlyJobCompletesWithoutDraft(adapters: AdapterSet): ContractCaseResult {
  return contractCase('F19-AC5 a read-only job completes with a stated no-code outcome and opens no draft', () => {
    const run = okOf(adapters.engine.parseEventStream(FIXTURE_READ_ONLY_ENGINE_EVENT_LINES), 'engine.parseEventStream');
    expectTrue(run.succeeded, 'a read-only job did not complete');
    expectTrue(!run.codeProduced, 'a read-only job reported that it produced code');
    expectTrue(run.noCodeReason !== null && run.noCodeReason.includes('no repository change'), 'the no-code outcome was not stated');
    expectTrue(run.usage.kind === 'Unknown', 'usage was reported although the stream reported none');
    expectTrue(adapters.effects.count() === 0, 'a read-only job performed an external write');

    const drafts = okOf(adapters.git.listDrafts(FIXTURE_REPOSITORY_REFERENCE), 'git.listDrafts');
    expectTrue(drafts.length === 0, 'a draft change was opened for a read-only job');
    return `Read-only job completed with ${run.milestones.length} milestone, codeProduced=false and no draft on the provider.`;
  });
}

/** F22-AC3: missing, building, failed, protected and usable stay distinct. */
function protectedPreviewIsNotUsable(adapters: AdapterSet): ContractCaseResult {
  return contractCase('F22-AC3 a protected preview is not reported as a usable application preview', () => {
    const discovered = okOf(adapters.deployment.discover(FIXTURE_PREVIEW_QUERY), 'deployment.discover');
    for (const state of DEPLOYMENT_STATES) {
      expectTrue(discovered.some((identity) => identity.state === state), `discovery omitted the ${state} preview state`);
    }
    for (const identity of FIXTURE_DEPLOYMENTS) {
      const preview = adapters.deployment.previewApplication(identity);
      const expectedUsable = identity.state === 'Usable' && identity.access === 'Open';
      expectTrue(preview.state === identity.state, `the ${identity.state} state was reported as ${preview.state}`);
      expectTrue(preview.usable === expectedUsable, `the ${identity.state} state reported usable=${preview.usable}`);
      if (!preview.usable) expectTrue(preview.detail.length > 0, `the ${identity.state} state carries no reason`);
    }

    const protectedIdentity = okOf(
      adapters.deployment.readIdentity({ query: FIXTURE_PREVIEW_QUERY, reference: FIXTURE_DEPLOYMENT_REFERENCE }),
      'deployment.readIdentity for the protected deployment',
    );
    expectTrue(
      protectedIdentity.state === 'Protected' && protectedIdentity.access === 'Protected',
      `the protected deployment was read as ${protectedIdentity.state}/${protectedIdentity.access}`,
    );
    expectTrue(
      !adapters.deployment.previewApplication(protectedIdentity).usable,
      'a protected sign-in page was reported as a usable application preview',
    );

    const absent = okOf(
      adapters.deployment.readIdentity({ query: FIXTURE_PREVIEW_QUERY, reference: null }),
      'deployment.readIdentity with no deployment identity',
    );
    expectTrue(absent.state === 'Missing' && absent.reference === null, 'no established deployment identity produced something other than Missing');
    return `All ${DEPLOYMENT_STATES.length} preview states were discovered and kept distinct; only Usable+Open is usable, so the protected sign-in page is not offered for testing.`;
  });
}

/** F28-AC3: a partial component failure stays unconfirmed with component-level evidence. */
function partialComponentFailureIsNotReleased(adapters: AdapterSet): ContractCaseResult {
  return contractCase('F28-AC3 a partial component failure is not reported as released and keeps component evidence', () => {
    adapters.conditions.programComponentOutcomes({ web: 'Usable', api: 'Failed' });
    const execution: DeploymentExecution = {
      operationId: operationId('contract-case-12-release'),
      destination: 'production-fixture',
      environment: 'production',
      components: ['web', 'api'],
      expectedHeadSha: FIXTURE_HEAD_SHA,
      action: 'Promote',
    };
    const outcome = okOf(adapters.deployment.applyExecution(execution), 'deployment.applyExecution');
    expectTrue(!outcome.released, 'a partial component failure was reported as released');
    expectTrue(outcome.components.length === 2, 'component-level evidence was reduced to a single result');

    const web = outcome.components.find((component) => component.component === 'web');
    const api = outcome.components.find((component) => component.component === 'api');
    expectTrue(web?.state === 'Usable', 'the succeeding component lost its state');
    expectTrue(api?.state === 'Failed' && api.detail.length > 0, 'the failing component lost its state or reason');
    expectTrue(adapters.effects.effectsFor(execution.operationId).length === 1, 'the delivery write was recorded more than once');

    const verified = okOf(
      adapters.deployment.verifyDestination({
        operationId: execution.operationId,
        destination: 'production-fixture',
        components: [
          { component: 'web', expectedDeploymentId: web?.deploymentId ?? null },
          { component: 'api', expectedDeploymentId: api?.deploymentId ?? null },
        ],
      }),
      'deployment.verifyDestination after the partial failure',
    );
    expectTrue(!verified.verified, 'the destination was verified while a component failed');
    expectTrue(verified.components.some((component) => component.component === 'api' && component.result === 'Failed'), 'the failing component was not reported');
    expectTrue(verified.reason !== null && verified.reason.includes('api'), 'the verification reason does not name the failing component');

    const mismatch = okOf(
      adapters.deployment.verifyDestination({
        operationId: execution.operationId,
        destination: 'production-fixture',
        components: [{ component: 'web', expectedDeploymentId: 'dep_not_the_deployed_identity' }],
      }),
      'deployment.verifyDestination against a different deployment identity',
    );
    expectTrue(
      mismatch.components.some((component) => component.result === 'Failed'),
      'a deployment identity mismatch still verified the destination',
    );
    return `web reported Usable and api Failed, released=false, the write was recorded once, and both the smoke check and an identity mismatch were reported as unverified.`;
  });
}

/** F20-AC2, F20-AC5: every result state survives mapping and no gate is removed silently. */
function checkSetKeepsEveryResultState(adapters: AdapterSet): ContractCaseResult {
  return contractCase('F20-AC2 every check result state is preserved and a required gate cannot be removed without policy', () => {
    const batch = okOf(
      adapters.git.readChecks({ reference: FIXTURE_REPOSITORY_REFERENCE, headSha: FIXTURE_HEAD_SHA }),
      'git.readChecks',
    );
    expectTrue(batch.checks.length === FIXTURE_CHECK_OBSERVATIONS.checks.length, 'the provider read did not return every reported check');

    const report = okOf(
      adapters.verification.mapObservations({ candidate: FIXTURE_CANDIDATE_IDENTITY, batch }),
      'verification.mapObservations',
    );
    expectTrue(
      report.candidateFingerprint === FIXTURE_CANDIDATE_FINGERPRINT,
      'the mapped report is not bound to the candidate identity it was given',
    );
    for (const result of CHECK_RESULTS) {
      expectTrue(report.checks.some((check) => check.result === result), `the mapped check set has no ${result} result`);
    }

    const missing = report.checks.find((check) => check.name === 'pnpm test:e2e');
    expectTrue(missing?.result === 'Missing', 'a required check that never ran was not retained as Missing');
    expectTrue(missing?.result !== 'Passed', 'a required check that never ran was reported as Passed');

    const stale = report.checks.find((check) => check.name === 'pnpm lint');
    expectTrue(stale?.result === 'Stale', 'the superseded check was not retained as Stale');
    expectTrue(
      stale?.candidateFingerprint !== FIXTURE_CANDIDATE_FINGERPRINT,
      'a Stale check was bound to the current candidate fingerprint, so it could approve the current candidate',
    );

    const notApplicable = report.checks.find((check) => check.name === 'pnpm test:visual');
    expectTrue(
      notApplicable?.notApplicableApprovedByPolicy === true,
      'a policy-approved Not applicable check lost its approval marker',
    );

    expectTrue(!report.readyForDelivery, 'the candidate was reported ready for delivery with blocking checks');
    for (const required of ['pnpm test:e2e', 'pnpm typecheck', 'pnpm lint']) {
      expectTrue(
        report.blocking.some((reason) => reason.startsWith(required)),
        `the blocking report does not name ${required}`,
      );
    }

    const unapproved = expectCode(
      errOf(
        adapters.verification.mapObservations({
          candidate: FIXTURE_CANDIDATE_IDENTITY,
          batch: FIXTURE_UNAPPROVED_NOT_APPLICABLE_OBSERVATIONS,
        }),
        'verification.mapObservations for an unapproved Not applicable check',
      ),
      'Blocked',
      'an unapproved Not applicable required gate',
    );
    expectTrue(
      unapproved.prerequisites.some((entry) => entry.name === 'RequiredCheckPolicy'),
      'the refusal does not name the policy prerequisite the owner must satisfy',
    );

    return `All ${CHECK_RESULTS.length} result states survived mapping; Missing, Failed and Stale block; an unapproved Not applicable required gate was Blocked on RequiredCheckPolicy.`;
  });
}

/** F30-AC2, F30-AC3: replayed and late deliveries cannot duplicate or revert facts. */
function outOfOrderEventsCannotRevertNewerFacts(adapters: AdapterSet): ContractCaseResult {
  return contractCase('F30-AC2 a replayed or late delivery neither duplicates nor reverts newer provider facts', () => {
    const newest = okOf(adapters.events.ingest(FIXTURE_NEWEST_EVENT), 'ingest of the newest delivery');
    expectTrue(newest.sequence === FIXTURE_NEWEST_EVENT.sequence, 'the newest delivery was not applied');
    expectTrue(newest.draftHeadSha === FIXTURE_HEAD_SHA, 'the newest delivery did not become the current head');

    const replayed = okOf(adapters.events.ingest(FIXTURE_NEWEST_EVENT), 'replay of the same delivery identity');
    expectTrue(replayed.sequence === newest.sequence, 'a replayed delivery changed the current facts');
    expectTrue(adapters.events.appliedDeliveries().length === 1, 'a replayed delivery was applied twice');

    const late = okOf(adapters.events.ingest(FIXTURE_LATE_EVENT), 'ingest of a late delivery carrying an older head');
    expectTrue(late.draftHeadSha === FIXTURE_HEAD_SHA, 'a late delivery reverted newer candidate facts');
    expectTrue(late.sequence === FIXTURE_NEWEST_EVENT.sequence, 'a late delivery rewound the observed sequence');
    expectTrue(adapters.events.appliedDeliveries().length === 1, 'a late delivery was applied');

    const followed = okOf(adapters.events.ingest(FIXTURE_FOLLOW_UP_EVENT), 'ingest of a later delivery');
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
export function runAdapterContractSuite(
  adapters: AdapterSet,
  freshAdapters: () => AdapterSet = () => adapters,
): readonly ContractCaseResult[] {
  return [
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
  ];
}
