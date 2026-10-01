/**
 * The attention dashboard and the use cases behind it (F31-AC1, F31-AC2,
 * F31-AC3, F31-AC4, F31-AC5, F24-AC3, F25-AC3, F20-AC2, N04-AC2, N04-AC3).
 *
 * Every item is derived from durable state on each read. No caller supplies a list
 * of things that need attention, because a caller-supplied list is a caller that
 * decides what the owner sees, and the whole product rule is that the owner sees
 * what the store actually says (F31-AC1). The durable job queue, the recorded
 * checks, the owner's own acceptance decisions and the recorded deliveries are the
 * only inputs; there is no policy here about what should be interesting, only a
 * mapping from a recorded state to a bucket, a blocker and one concrete next action
 * (F31-AC2).
 *
 * Five properties are load bearing:
 *
 *   - **A dedup key names the condition, not its wording.** A blocker's text may be
 *     rewritten by a retry; the key names the job, the question or the candidate, so
 *     the repeated condition updates one row instead of appending a duplicate
 *     (F31-AC3).
 *   - **Acknowledgement records owner attention and nothing else.** It touches the
 *     attention row alone, so no run, acceptance or release fact can move because the
 *     owner looked at something (F31-AC4).
 *   - **A resolved condition resolves its item.** An item whose job, question or
 *     candidate condition is genuinely gone from durable state is resolved on the
 *     next read rather than lingering as a permanent warning (F31-AC4).
 *   - **A superseded candidate cannot present as ready for release.** Acceptance is
 *     current only for the candidate it names, so a replacement candidate produces a
 *     fresh owner test and the superseded release decision resolves, naming the
 *     candidate that replaced it (F31-AC5, F24-AC3, F25-AC3).
 *   - **Run progress is derived, never persisted.** `attention_items.kind` accepts no
 *     `RunProgress` value and F31-AC3's own list of durable kinds omits it, so the
 *     working bucket is rebuilt from the queue on every read and is deliberately not
 *     addressable by `acknowledge` (F31-AC1, F31-AC3).
 *
 * Nothing here performs a remote call, waits on a worker or mutates a run, so no
 * owner action on this dashboard can block on a complete coding or deployment job;
 * each use case is a bounded local read or a single-row write (N04-AC3). Every read
 * carries the instant it was collected, so a caller can show how fresh the view is
 * and notice that it has stopped moving (N04-AC2).
 */

import { createHash } from 'node:crypto';
import {
  ATTEMPT_STATES,
  assessStaleness,
  dedupKeyFor,
  deliveryEligible,
  err,
  groupAttention,
  invalid,
  isSatisfied,
  ok,
  upsertAttentionItem,
} from '@shiploop/domain';
import type {
  AcceptanceState,
  AttemptState,
  AttentionGroup,
  AttentionItem,
  AttentionItemId,
  AttentionKind,
  AttentionObservation,
  CandidateIdentity,
  CheckRecord,
  ComponentIdentity,
  DeliveryState,
  DomainError,
  Fingerprint,
  JobId,
  OwnerId,
  WorkItemId,
  ProjectId,
  Result,
} from '@shiploop/domain';
import type {
  AttentionItemRecord,
  AttentionItemStore,
  SqlRow,
  StorageConnection,
} from '@shiploop/storage';
import type { ControllerClock } from './profiles.ts';

/* -------------------------------------------------------------------------- */
/* Ports                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The durable job facts the dashboard groups.
 *
 * A structural subset of the queue's `JobRecord`, so the real queue satisfies this
 * port without an adapter: the dashboard needs a job's identity, the work it belongs
 * to and the state it is in, and nothing about its limits or capability grant
 * (F31-AC1).
 */
export interface AttentionJob {
  readonly jobId: string;
  readonly workItemId: string;
  readonly state: AttemptState;
}

/** Which jobs the dashboard is asking about. */
export interface AttentionJobFilter {
  readonly states: readonly AttemptState[] | null;
  readonly projectId: ProjectId | null;
}

/**
 * The durable job read.
 *
 * Declared here rather than imported from `@shiploop/storage` because the queue
 * module is not exported from that package's root, so the controller depends on the
 * read it needs and the composition root binds the implementation.
 */
export interface AttentionJobQuery {
  listJobs(filter: AttentionJobFilter): Result<readonly AttentionJob[], DomainError>;
}

/** One work item as the dashboard sees it. */
export interface AttentionWorkItem {
  readonly workItemId: string;
  readonly ideaId: string | null;
  readonly issueIdentifier: string | null;
  readonly title: string | null;
}

/** The durable blocker a paused or blocked job recorded at its last checkpoint. */
export interface AttentionCheckpoint {
  readonly jobId: JobId;
  readonly blocker: string | null;
  readonly recordedAt: string;
}

/** A candidate and the inputs that decide whether it is still the current one. */
export interface AttentionCandidate {
  readonly workItemId: string;
  readonly fingerprint: Fingerprint;
  readonly identity: CandidateIdentity;
  readonly supersededAt: string | null;
  readonly recordedAt: string;
}

/** The owner's latest acceptance decision for a work item (F25-AC3). */
export interface AttentionAcceptance {
  readonly decisionId: string;
  readonly workItemId: string;
  readonly acceptanceState: AcceptanceState;
  readonly candidateFingerprint: Fingerprint;
  readonly decidedAt: string;
}

/** The latest recorded delivery for a work item. */
export interface AttentionDelivery {
  readonly deliveryId: string;
  readonly workItemId: string;
  readonly state: DeliveryState;
  readonly candidateFingerprint: Fingerprint;
  readonly failureDetail: string | null;
  readonly createdAt: string;
}

/** A clarification question the owner has not answered yet. */
export interface AttentionQuestion {
  readonly questionId: string;
  readonly workItemId: string;
  readonly body: string;
  readonly createdAt: string;
}

/**
 * Everything the dashboard derives from, read in one pass.
 *
 * One read per collection rather than one per job: the dashboard answers "what
 * needs me now" for a whole project, so a query per job would make the view's cost
 * grow with the number of jobs the owner is least likely to look at (N04-AC2).
 */
export interface AttentionScopeSnapshot {
  readonly workItems: readonly AttentionWorkItem[];
  readonly checkpoints: readonly AttentionCheckpoint[];
  readonly candidates: readonly AttentionCandidate[];
  /** Required checks, kept as the domain records so the domain judges readiness (F20-AC2). */
  readonly requiredChecks: readonly CheckRecord[];
  readonly acceptances: readonly AttentionAcceptance[];
  readonly deliveries: readonly AttentionDelivery[];
  readonly questions: readonly AttentionQuestion[];
}

/** The durable read the dashboard derives its items from. */
export interface AttentionScopeReader {
  readProject(projectId: ProjectId): Result<AttentionScopeSnapshot, DomainError>;
}

/* -------------------------------------------------------------------------- */
/* Use cases                                                                    */
/* -------------------------------------------------------------------------- */

export interface AttentionUseCaseDeps {
  readonly clock: ControllerClock;
  readonly queue: AttentionJobQuery;
  readonly scope: AttentionScopeReader;
  /**
   * Durable attention items.
   *
   * Optional so a deployment whose store does not carry the table still reports
   * live state instead of an empty dashboard. `acknowledge` and `resolve` then
   * refuse by name rather than pretend to have recorded owner attention, because a
   * silent no-op acknowledgement would be indistinguishable from a recorded one
   * (F31-AC4).
   */
  readonly attentionStore?: AttentionItemStore;
}

/**
 * The board as one read answers it.
 *
 * `items` is every item the project has, including resolved ones, so a caller can
 * show that a condition existed and ended; `groups` is the open view grouped into
 * the four buckets (F31-AC1). Age is the difference between an item's `createdAt`
 * and `collectedAt`, which is why both are present rather than a precomputed age
 * that would be wrong by the time it is rendered (F31-AC1).
 */
export interface AttentionBoard {
  readonly projectId: ProjectId;
  readonly collectedAt: string;
  readonly items: readonly AttentionItem[];
  readonly groups: readonly AttentionGroup[];
  /**
   * The items backed by an `attention_items` row.
   *
   * These are the only identities `acknowledge` and `resolve` address: a derived
   * run-progress item has a stable identity but no row, and acknowledging it would
   * be an acknowledgement of nothing (F31-AC3, F31-AC4).
   */
  readonly persistedItemIds: readonly string[];
}

export interface AttentionUseCases {
  /**
   * Derives the open items for a project and persists them.
   *
   * Filtering by project is a read filter over the same durable items, not a second
   * backlog: nothing here is editable and nothing here owns work, so the project
   * view cannot become a competing source of truth (F31-AC2).
   */
  readonly collectAttention: (projectId: ProjectId) => Result<AttentionBoard, DomainError>;
  readonly acknowledge: (itemId: AttentionItemId, ownerId: OwnerId) => Result<AttentionItemRecord, DomainError>;
  readonly resolve: (itemId: AttentionItemId) => Result<AttentionItemRecord, DomainError>;
}

/**
 * The kinds `attention_items.kind` accepts (the fourth storage migration).
 *
 * F31-AC3 names clarification, blockers, test readiness, delivery and recovery
 * decisions and release results as the durable kinds, and `RunProgress` is absent
 * from both that list and the column's CHECK. Treating the column's vocabulary as
 * the boundary means a kind this code did not expect cannot be silently written to a
 * row the schema would refuse.
 */
const DURABLE_ATTENTION_KINDS: ReadonlySet<AttentionKind> = new Set<AttentionKind>([
  'ClarificationRequested',
  'Blocker',
  'ReadyForYourTest',
  'DeliveryDecision',
  'RecoveryDecision',
  'ReleaseResult',
  'SyncFailure',
  'WorkerStopped',
  'InvalidProfile',
  'LowArtifactCapacity',
]);

/**
 * A stable identity for a condition that has no durable row.
 *
 * Derived from the dedup key, so collecting the same condition twice produces the
 * same identity and the "no duplicate" property holds even for the kinds that are
 * never persisted (F31-AC3). The prefix marks it as derived, because an
 * acknowledgement of a derived item has nowhere to be recorded.
 */
function derivedItemId(dedupKey: string): string {
  return `attn_derived_${createHash('sha256').update(dedupKey, 'utf8').digest('hex').slice(0, 32)}`;
}

/** Appends the linked issue so an item names the work it belongs to (F31-AC1). */
function withIssue(title: string, issueIdentifier: string | null): string {
  return issueIdentifier === null ? title : `${title} (${issueIdentifier})`;
}

/** The human name for a work item: its linked issue, else whatever it is called. */
function labelFor(workItem: AttentionWorkItem | undefined): string {
  if (workItem === undefined) return 'unknown work item';
  return workItem.issueIdentifier ?? workItem.title ?? workItem.workItemId;
}

function observationFor(input: {
  readonly kind: AttentionKind;
  readonly subject: string;
  readonly projectId: ProjectId;
  readonly workItemId: string | null;
  readonly issueIdentifier: string | null;
  readonly title: string;
  readonly blocker: string | null;
  readonly nextAction: string;
  readonly candidateFingerprint?: Fingerprint | null;
  readonly now: string;
}): AttentionObservation {
  const dedupKey = dedupKeyFor(input.kind, input.subject);
  return {
    attentionItemId: derivedItemId(dedupKey),
    dedupKey,
    kind: input.kind,
    projectId: input.projectId,
    workItemId: input.workItemId,
    issueIdentifier: input.issueIdentifier,
    title: input.title,
    blocker: input.blocker,
    nextAction: input.nextAction,
    now: input.now,
    resolved: false,
    candidateFingerprint: input.candidateFingerprint ?? null,
  };
}

/** The snapshot indexed the way the derivation asks for it. */
interface ScopeIndex {
  readonly workItems: ReadonlyMap<string, AttentionWorkItem>;
  readonly checkpointForJob: ReadonlyMap<string, AttentionCheckpoint>;
  readonly currentCandidateForWorkItem: ReadonlyMap<string, AttentionCandidate>;
  readonly candidateByFingerprint: ReadonlyMap<string, AttentionCandidate>;
  readonly checksForFingerprint: ReadonlyMap<string, readonly CheckRecord[]>;
  readonly acceptanceForWorkItem: ReadonlyMap<string, AttentionAcceptance>;
  readonly deliveryForWorkItem: ReadonlyMap<string, AttentionDelivery>;
}

/** The project, work item and instant every derived item carries. */
interface ItemContext {
  readonly projectId: ProjectId;
  readonly workItemId: string;
  readonly issueIdentifier: string | null;
  readonly now: string;
}

/**
 * Indexes the snapshot, keeping the newest row where more than one exists.
 *
 * "Newest wins" is decided by the recorded instant each table orders by, not by
 * insertion order, so a restored or replayed row cannot become current by being
 * read last (F30-AC3).
 */
function indexSnapshot(snapshot: AttentionScopeSnapshot): ScopeIndex {
  const workItems = new Map<string, AttentionWorkItem>();
  for (const workItem of snapshot.workItems) workItems.set(workItem.workItemId, workItem);

  const checkpointForJob = new Map<string, AttentionCheckpoint>();
  for (const checkpoint of snapshot.checkpoints) checkpointForJob.set(checkpoint.jobId, checkpoint);

    const currentCandidateForWorkItem = new Map<string, AttentionCandidate>();
  const candidateByFingerprint = new Map<string, AttentionCandidate>();
  for (const candidate of snapshot.candidates) {
    currentCandidateForWorkItem.set(candidate.workItemId, candidate);
    candidateByFingerprint.set(candidate.fingerprint, candidate);
  }

  const checksForFingerprint = new Map<string, readonly CheckRecord[]>();
  for (const check of snapshot.requiredChecks) {
    const existing = checksForFingerprint.get(check.candidateFingerprint) ?? [];
    checksForFingerprint.set(check.candidateFingerprint, [...existing, check]);
  }

  const acceptanceForWorkItem = new Map<string, AttentionAcceptance>();
  for (const acceptance of snapshot.acceptances) {
    acceptanceForWorkItem.set(acceptance.workItemId, acceptance);
  }

  const deliveryForWorkItem = new Map<string, AttentionDelivery>();
  for (const delivery of snapshot.deliveries) {
    deliveryForWorkItem.set(delivery.workItemId, delivery);
  }

  return {
    workItems,
    checkpointForJob,
    currentCandidateForWorkItem,
    candidateByFingerprint,
    checksForFingerprint,
    acceptanceForWorkItem,
    deliveryForWorkItem,
  };
}

/**
 * Derives the items a single job produces.
 *
 * Order matters: a job that is running has one bucket, a job that needs the owner
 * has another, and only a finished job's candidate can be ready for the owner's test
 * or for release. A candidate is never judged while its job is still in flight,
 * because an unfinished attempt's checks are not yet an observation of anything
 * (F20-AC2, F31-AC1).
 */
function observationsForJob(
  projectId: ProjectId,
  job: AttentionJob,
  index: ScopeIndex,
  now: string,
): readonly AttentionObservation[] {
  const workItem = index.workItems.get(job.workItemId);
  const issueIdentifier = workItem?.issueIdentifier ?? null;
  const context: ItemContext = {
    projectId,
    workItemId: job.workItemId,
    issueIdentifier,
    now,
  };

  if (job.state === 'Preparing' || job.state === 'Running' || job.state === 'Verifying') {
    return [
      observationFor({
        ...context,
        kind: 'RunProgress',
        subject: job.jobId,
        title: withIssue(`Job ${job.jobId} is ${job.state}`, issueIdentifier),
        blocker: null,
        nextAction: `Wait for job ${job.jobId} to leave ${job.state}; no owner action is required until it does.`,
      }),
    ];
  }

  const checkpoint = index.checkpointForJob.get(job.jobId);
  const recordedBlocker = checkpoint?.blocker ?? null;

  if (job.state === 'Blocked') {
    return [
      observationFor({
        ...context,
        kind: 'Blocker',
        subject: job.jobId,
        title: withIssue(`Job ${job.jobId} is blocked`, issueIdentifier),
        blocker: recordedBlocker ?? `no blocker reason is recorded for job ${job.jobId}`,
        nextAction: `Resolve what is blocking job ${job.jobId}, then resume it.`,
      }),
    ];
  }

  if (job.state === 'WaitingForOwner') {
    return [
      observationFor({
        ...context,
        kind: 'Blocker',
        subject: job.jobId,
        title: withIssue(`Job ${job.jobId} is waiting for you`, issueIdentifier),
        blocker:
          recordedBlocker ??
          `job ${job.jobId} is WaitingForOwner and no question or blocker is recorded against it`,
        nextAction: `Answer job ${job.jobId}.`,
      }),
    ];
  }

  if (job.state !== 'Completed') return [];

  const candidate = index.currentCandidateForWorkItem.get(job.workItemId);
  if (candidate === undefined) return [];

  return observationsForCandidate(context, job.workItemId, candidate, index);
}

/** The items one finished job's current candidate produces. */
function observationsForCandidate(
  context: ItemContext,
  workItemId: string,
  candidate: AttentionCandidate,
  index: ScopeIndex,
): readonly AttentionObservation[] {
  const fingerprint = candidate.fingerprint;
  const shared = { ...context, candidateFingerprint: fingerprint };
  const checks = index.checksForFingerprint.get(fingerprint) ?? [];
  const unsatisfied = checks.filter((check) => !isSatisfied(check));
  const acceptance = index.acceptanceForWorkItem.get(workItemId) ?? null;
  const delivery = index.deliveryForWorkItem.get(workItemId) ?? null;

  if (delivery !== null && (delivery.state === 'Failed' || delivery.state === 'OutcomeUnknown')) {
    return [
      observationFor({
        ...shared,
        kind: 'RecoveryDecision',
        subject: delivery.deliveryId,
        title: withIssue(`Delivery ${delivery.deliveryId} is ${delivery.state}`, shared.issueIdentifier),
        blocker: `delivery ${delivery.deliveryId} is ${delivery.state}${
          delivery.failureDetail === null ? ' and no failure detail is recorded' : `: ${delivery.failureDetail}`
        }`,
        nextAction: `Reconcile delivery ${delivery.deliveryId} before authorizing another delivery.`,
      }),
    ];
  }

  if (unsatisfied.length > 0) {
    return [
      observationFor({
        ...shared,
        kind: 'ReadyForYourTest',
        subject: fingerprint,
        title: withIssue(`Candidate ${fingerprint} is waiting on its required checks`, shared.issueIdentifier),
        blocker: unsatisfied
          .map((check) => `required check "${check.name}" is ${check.result}`)
          .join('; '),
        nextAction: `Ask for a fix pass on candidate ${fingerprint}, then test it.`,
      }),
    ];
  }

  if (acceptance === null || acceptance.acceptanceState !== 'Accepted') {
    const awaiting = awaitingOwnerTest(acceptance, fingerprint);
    return [
      observationFor({
        ...shared,
        kind: 'ReadyForYourTest',
        subject: fingerprint,
        title: withIssue(`Candidate ${fingerprint} is ready for your test`, shared.issueIdentifier),
        blocker: awaiting.blocker,
        nextAction: awaiting.nextAction,
      }),
    ];
  }

  if (acceptance.candidateFingerprint !== fingerprint) {
    return [
      observationFor({
        ...shared,
        kind: 'ReadyForYourTest',
        subject: fingerprint,
        title: withIssue(`Candidate ${fingerprint} needs a fresh decision`, shared.issueIdentifier),
        blocker: supersededAcceptance(acceptance.candidateFingerprint, candidate, index),
        nextAction: `Test candidate ${fingerprint}; the acceptance for ${acceptance.candidateFingerprint} no longer applies.`,
      }),
    ];
  }

  const eligibility = deliveryEligible({
    checks,
    acceptance: 'Accepted',
    acceptanceCandidateFingerprint: acceptance.candidateFingerprint,
    currentCandidateFingerprint: fingerprint,
  });
  if (!eligibility.eligible) {
    return [
      observationFor({
        ...shared,
        kind: 'Blocker',
        subject: `${fingerprint}:delivery`,
        title: withIssue(`Candidate ${fingerprint} is not releasable yet`, shared.issueIdentifier),
        blocker: eligibility.reasons.join('; '),
        nextAction: `Resolve what blocks candidate ${fingerprint}, then authorize delivery.`,
      }),
    ];
  }

  return [
    observationFor({
      ...shared,
      kind: 'DeliveryDecision',
      subject: fingerprint,
      title: withIssue(`Candidate ${fingerprint} is accepted and ready for release`, shared.issueIdentifier),
      blocker: null,
      nextAction: `Authorize merge and release for candidate ${fingerprint}.`,
    }),
  ];
}

/** Why a candidate with no current acceptance is still waiting for the owner. */
function awaitingOwnerTest(
  acceptance: AttentionAcceptance | null,
  fingerprint: Fingerprint,
): { readonly blocker: string | null; readonly nextAction: string } {
  if (acceptance === null) {
    return {
      blocker: null,
      nextAction: `Accept candidate ${fingerprint} or request changes.`,
    };
  }
  switch (acceptance.acceptanceState) {
    case 'NotRequested':
    case 'Pending':
      return { blocker: null, nextAction: `Accept candidate ${fingerprint} or request changes.` };
    case 'ChangesRequested':
      return {
        blocker: `changes were requested on candidate ${acceptance.candidateFingerprint}`,
        nextAction: `Resolve the requested changes, then record a decision on candidate ${fingerprint}.`,
      };
    case 'Stale':
      return {
        blocker: `the acceptance for candidate ${acceptance.candidateFingerprint} is recorded as stale`,
        nextAction: `Record a fresh decision on candidate ${fingerprint}.`,
      };
    case 'Accepted':
      return { blocker: null, nextAction: `Accept candidate ${fingerprint} or request changes.` };
  }
}

/**
 * Why the accepted candidate is no longer current.
 *
 * The superseding candidate is named together with the inputs that changed, because
 * "your approval no longer applies" without a candidate to look at leaves the owner
 * with nothing to test. The assessment is the domain's, so an item cannot claim a
 * candidate is unchanged when the recorded identities differ (F24-AC3, F25-AC3).
 */
function supersededAcceptance(
  acceptedFingerprint: Fingerprint,
  current: AttentionCandidate,
  index: ScopeIndex,
): string {
  const accepted = index.candidateByFingerprint.get(acceptedFingerprint);
  if (accepted === undefined) {
    return `acceptance was recorded for candidate ${acceptedFingerprint}, which is no longer the current candidate ${current.fingerprint}`;
  }
  const assessment = assessStaleness(accepted.identity, current.identity);
  const changed = assessment.reasons.length > 0 ? ` (${assessment.reasons.join(', ')})` : '';
  return `acceptance was recorded for candidate ${acceptedFingerprint}, superseded by ${current.fingerprint}${changed}`;
}

/** One observation per unanswered question, whatever the jobs are doing. */
function clarificationObservation(
  projectId: ProjectId,
  question: AttentionQuestion,
  index: ScopeIndex,
  now: string,
): AttentionObservation {
  const workItem = index.workItems.get(question.workItemId);
  return observationFor({
    kind: 'ClarificationRequested',
    subject: question.questionId,
    projectId,
    workItemId: question.workItemId,
    issueIdentifier: workItem?.issueIdentifier ?? null,
    title: withIssue(`A clarification is unanswered for ${labelFor(workItem)}`, workItem?.issueIdentifier ?? null),
    blocker: question.body,
    nextAction: `Answer the open clarification question about ${labelFor(workItem)}.`,
    candidateFingerprint: null,
    now,
  });
}

function deriveObservations(
  projectId: ProjectId,
  jobs: readonly AttentionJob[],
  snapshot: AttentionScopeSnapshot,
  now: string,
): readonly AttentionObservation[] {
  const index = indexSnapshot(snapshot);
  const derived: AttentionObservation[] = [];
  for (const job of jobs) {
    for (const observation of observationsForJob(projectId, job, index, now)) derived.push(observation);
  }
  for (const question of snapshot.questions) {
    derived.push(clarificationObservation(projectId, question, index, now));
  }
  return derived;
}

/**
 * The store's typed work item identity.
 *
 * The store's write input declares the column with the branded id, and the value
 * came from a row the schema already constrained to a work item, so the conversion
 * records a shape the database checked rather than one this code assumed.
 */
function storedWorkItemId(workItemId: string | null): WorkItemId | null {
  return workItemId === null ? null : (workItemId as WorkItemId);
}

/**
 * Builds the attention use cases.
 *
 * The factory takes its durable readers and its clock, so nothing here reads
 * ambient time and nothing here reaches for a repository the caller did not bind
 * (mvp-spec 7).
 */
export function createAttentionUseCases(deps: AttentionUseCaseDeps): AttentionUseCases {
  const store = deps.attentionStore;

  function collectAttention(projectId: ProjectId): Result<AttentionBoard, DomainError> {
    const listed = deps.queue.listJobs({ states: null, projectId });
    if (!listed.ok) return err(listed.error);

    const read = deps.scope.readProject(projectId);
    if (!read.ok) return err(read.error);

    const now = deps.clock.now();
    const derived = deriveObservations(projectId, listed.value, read.value, now);
    const durable = derived.filter((observation) => DURABLE_ATTENTION_KINDS.has(observation.kind));

    let persisted: readonly AttentionItemRecord[] = [];
    if (store !== undefined) {
      for (const observation of durable) {
        const written = store.upsert({
          dedupKey: observation.dedupKey,
          kind: observation.kind,
          projectId,
          workItemId: storedWorkItemId(observation.workItemId),
          issueIdentifier: observation.issueIdentifier,
          title: observation.title,
          blocker: observation.blocker,
          nextAction: observation.nextAction,
          candidateFingerprint: observation.candidateFingerprint,
          observedAt: now,
          resolved: false,
        });
        if (!written.ok) return err(written.error);
      }

      const beforeResolution = store.list(null);
      if (!beforeResolution.ok) return err(beforeResolution.error);
      const live = new Set(durable.map((observation) => observation.dedupKey));
      for (const item of beforeResolution.value) {
        if (item.projectId !== projectId) continue;
        if (item.state === 'Resolved' || live.has(item.dedupKey)) continue;
        const resolved = store.resolve(item.attentionItemId, now);
        if (!resolved.ok) return err(resolved.error);
      }

      const afterResolution = store.list(null);
      if (!afterResolution.ok) return err(afterResolution.error);
      persisted = afterResolution.value.filter((item) => item.projectId === projectId);
    }

    const items = derived.reduce<readonly AttentionItem[]>(
      (accumulated, observation) => upsertAttentionItem(accumulated, observation),
      persisted,
    );

    return ok({
      projectId,
      collectedAt: now,
      items,
      groups: groupAttention(items),
      persistedItemIds: persisted.map((item) => item.attentionItemId),
    });
  }

  function acknowledge(itemId: AttentionItemId, ownerId: OwnerId): Result<AttentionItemRecord, DomainError> {
    if (store === undefined) return err(missingStore('acknowledged'));
    return store.acknowledge(itemId, ownerId, deps.clock.now());
  }

  function resolve(itemId: AttentionItemId): Result<AttentionItemRecord, DomainError> {
    if (store === undefined) return err(missingStore('resolved'));
    return store.resolve(itemId, deps.clock.now());
  }

  return { collectAttention, acknowledge, resolve };
}

/**
 * The refusal a deployment without the attention table gets.
 *
 * Named rather than silently ignored, because a successful acknowledgement of
 * nothing is the one answer that cannot be told apart from a recorded one
 * (F31-AC4).
 */
function missingStore(action: string): DomainError {
  return {
    code: 'Unavailable',
    reason: `No attention item store is bound, so the item cannot be ${action}. Reporting success would claim owner attention that was recorded nowhere (F31-AC4).`,
  };
}

/* -------------------------------------------------------------------------- */
/* SQLite readers for the two ports above                                      */
/* -------------------------------------------------------------------------- */

const JOB_COLUMNS = 'job_id, work_item_id, state';

function requiredText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`column ${column} is missing or not text`);
  return value;
}

function optionalText(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error(`column ${column} is neither text nor absent`);
  return value;
}

function requiredInteger(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') throw new Error(`column ${column} is missing or not a number`);
  return value;
}

function optionalInteger(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') throw new Error(`column ${column} is neither a number nor absent`);
  return value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toAttentionJob(row: SqlRow): AttentionJob {
  const state = requiredText(row, 'state');
  if (!(ATTEMPT_STATES as readonly string[]).includes(state)) {
    throw new Error(`job state "${state}" is not a domain attempt state, so the row is not trusted`);
  }
  return {
    jobId: requiredText(row, 'job_id'),
    workItemId: requiredText(row, 'work_item_id'),
    state: state as AttemptState,
  };
}

/**
 * The durable job read over the migrated schema.
 *
 * A duplication of the queue's `listJobs` projection, and reported as one: the queue
 * module is not exported from `@shiploop/storage`, so the controller cannot depend
 * on it by package name and this reader states only the three columns the dashboard
 * groups. A composition root that can reach the real queue should bind that instead.
 */
export class SqliteAttentionJobQuery implements AttentionJobQuery {
  private readonly connection: StorageConnection;

  constructor(connection: StorageConnection) {
    this.connection = connection;
  }

  listJobs(filter: AttentionJobFilter): Result<readonly AttentionJob[], DomainError> {
    try {
      const clauses: string[] = [];
      const parameters: string[] = [];
      if (filter.states !== null && filter.states.length > 0) {
        for (const state of filter.states) {
          if (!(ATTEMPT_STATES as readonly string[]).includes(state)) {
            return err(
              invalid(`"${state}" is not a domain attempt state.`, [
                { path: 'states', message: 'Filter with values from ATTEMPT_STATES.' },
              ]),
            );
          }
        }
        clauses.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
        parameters.push(...filter.states);
      }
      if (filter.projectId !== null) {
        clauses.push('project_id = ?');
        parameters.push(filter.projectId);
      }
      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
      const rows = this.connection
        .prepare(`SELECT ${JOB_COLUMNS} FROM jobs${where} ORDER BY created_at ASC, job_id ASC`)
        .all(...parameters);
      return ok(rows.map(toAttentionJob));
    } catch (error) {
      return err({
        code: 'Unavailable',
        reason: `The dashboard's durable job read failed: ${describe(error)}`,
      });
    }
  }
}

const CANDIDATE_COLUMNS =
  'candidate_id, work_item_id, fingerprint, head_sha, base_sha, scope_fingerprint, profile_version_id, procedure_version_id, environment_fingerprint, policy_fingerprint, superseded_at, COALESCE(recorded_at, created_at) AS observed_at';

/**
 * The durable read the dashboard derives from.
 *
 * A duplication, and reported as one: `@shiploop/storage` exposes repositories for
 * candidates, acceptance decisions, evidence and attention items, but no reader that
 * answers "what does this project currently need from the owner", and no reader for
 * the recorded deliveries or a candidate's supersession at all. The statements below
 * read the migrated schema and nothing else, so replacing this with a storage-side
 * reader is a change of class rather than a change of schema.
 */
export class SqliteAttentionScope implements AttentionScopeReader {
  private readonly connection: StorageConnection;

  constructor(connection: StorageConnection) {
    this.connection = connection;
  }

  readProject(projectId: ProjectId): Result<AttentionScopeSnapshot, DomainError> {
    try {
      return ok({
        workItems: this.readWorkItems(projectId),
        checkpoints: this.readCheckpoints(projectId),
        candidates: this.readCandidates(projectId),
        requiredChecks: this.readRequiredChecks(projectId),
        acceptances: this.readAcceptances(projectId),
        deliveries: this.readDeliveries(projectId),
        questions: this.readOpenQuestions(projectId),
      });
    } catch (error) {
      return err({
        code: 'Unavailable',
        reason: `The dashboard's durable scope read for project ${projectId} failed: ${describe(error)}`,
      });
    }
  }

  private readWorkItems(projectId: ProjectId): readonly AttentionWorkItem[] {
    return this.connection
      .prepare(
        `SELECT work_item_id, idea_id, COALESCE(external_issue_identifier, issue_identifier) AS issue_identifier, title
           FROM work_items WHERE project_id = ? ORDER BY created_at ASC, work_item_id ASC`,
      )
      .all(projectId)
      .map((row) => ({
        workItemId: requiredText(row, 'work_item_id'),
        ideaId: optionalText(row, 'idea_id'),
        issueIdentifier: optionalText(row, 'issue_identifier'),
        title: optionalText(row, 'title'),
      }));
  }

  private readCheckpoints(projectId: ProjectId): readonly AttentionCheckpoint[] {
    return this.connection
      .prepare(
        `SELECT c.job_id, c.blocker, c.recorded_at
           FROM job_checkpoints c JOIN jobs j ON j.job_id = c.job_id
          WHERE j.project_id = ?
          ORDER BY c.recorded_at ASC, c.job_id ASC`,
      )
      .all(projectId)
      .map((row) => ({
        jobId: requiredText(row, 'job_id') as JobId,
        blocker: optionalText(row, 'blocker'),
        recordedAt: requiredText(row, 'recorded_at'),
      }));
  }

  private readCandidates(projectId: ProjectId): readonly AttentionCandidate[] {
    const componentRows = this.connection
      .prepare(
        `SELECT cc.candidate_id, cc.component, cc.deployment_id, cc.deployment_url, cc.environment
           FROM candidate_components cc JOIN candidates c ON c.candidate_id = cc.candidate_id
          WHERE c.project_id = ?
          ORDER BY cc.candidate_id ASC, cc.component ASC`,
      )
      .all(projectId);

    const componentsByCandidate = new Map<string, ComponentIdentity[]>();
    for (const row of componentRows) {
      const candidateId = requiredText(row, 'candidate_id');
      const existing = componentsByCandidate.get(candidateId) ?? [];
      existing.push({
        component: requiredText(row, 'component'),
        deploymentId: optionalText(row, 'deployment_id'),
        deploymentUrl: optionalText(row, 'deployment_url'),
        environment: requiredText(row, 'environment'),
      });
      componentsByCandidate.set(candidateId, existing);
    }

    return this.connection
      .prepare(`SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE project_id = ? ORDER BY observed_at ASC, candidate_id ASC`)
      .all(projectId)
      .map((row) => {
        const candidateId = requiredText(row, 'candidate_id');
        return {
          workItemId: requiredText(row, 'work_item_id'),
          fingerprint: requiredText(row, 'fingerprint') as Fingerprint,
          identity: {
            headSha: requiredText(row, 'head_sha') as CandidateIdentity['headSha'],
            baseSha: requiredText(row, 'base_sha') as CandidateIdentity['baseSha'],
            scopeFingerprint: requiredText(row, 'scope_fingerprint') as Fingerprint,
            profileVersionId: requiredText(row, 'profile_version_id'),
            procedureVersionId: requiredText(row, 'procedure_version_id'),
            environmentFingerprint: requiredText(row, 'environment_fingerprint') as Fingerprint,
            policyFingerprint: requiredText(row, 'policy_fingerprint') as Fingerprint,
            components: componentsByCandidate.get(candidateId) ?? [],
          },
          supersededAt: optionalText(row, 'superseded_at'),
          recordedAt: requiredText(row, 'observed_at'),
        };
      });
  }

  private readRequiredChecks(projectId: ProjectId): readonly CheckRecord[] {
    return this.connection
      .prepare(
        `SELECT check_id, name, origin, required, result, not_applicable_approved_by_policy,
                candidate_fingerprint, started_at, ended_at, exit_code, artifact_ref, detail_redacted
           FROM checks WHERE project_id = ? AND required = 1
          ORDER BY started_at ASC, check_id ASC`,
      )
      .all(projectId)
      .map((row) => ({
        checkId: requiredText(row, 'check_id'),
        name: requiredText(row, 'name'),
        origin: requiredText(row, 'origin') as CheckRecord['origin'],
        required: true,
        result: requiredText(row, 'result') as CheckRecord['result'],
        candidateFingerprint: requiredText(row, 'candidate_fingerprint') as Fingerprint,
        startedAt: requiredText(row, 'started_at'),
        endedAt: optionalText(row, 'ended_at'),
        exitCode: optionalInteger(row, 'exit_code'),
        artifactRef: optionalText(row, 'artifact_ref'),
        detail: optionalText(row, 'detail_redacted'),
        notApplicableApprovedByPolicy: requiredInteger(row, 'not_applicable_approved_by_policy') === 1,
      }));
  }

  private readAcceptances(projectId: ProjectId): readonly AttentionAcceptance[] {
    return this.connection
      .prepare(
        `SELECT decision_id, work_item_id, acceptance_state, candidate_fingerprint, decided_at
           FROM owner_decisions
          WHERE project_id = ?
            AND decision_type IN ('AcceptProduct', 'RequestChanges')
            AND state IN ('Recorded', 'Consumed')
          ORDER BY decided_at ASC, decision_id ASC`,
      )
      .all(projectId)
      .flatMap((row) => {
        const workItemId = optionalText(row, 'work_item_id');
        const acceptanceState = optionalText(row, 'acceptance_state');
        if (workItemId === null || acceptanceState === null) return [];
        return [
          {
            decisionId: requiredText(row, 'decision_id'),
            workItemId,
            acceptanceState: acceptanceState as AcceptanceState,
            candidateFingerprint: requiredText(row, 'candidate_fingerprint') as Fingerprint,
            decidedAt: requiredText(row, 'decided_at'),
          },
        ];
      });
  }

  private readDeliveries(projectId: ProjectId): readonly AttentionDelivery[] {
    return this.connection
      .prepare(
        `SELECT d.delivery_id, d.work_item_id, d.state, c.fingerprint AS candidate_fingerprint,
                d.failure_detail_redacted, d.created_at
           FROM deliveries d JOIN candidates c ON c.candidate_id = d.candidate_id
          WHERE d.project_id = ?
          ORDER BY d.created_at ASC, d.delivery_id ASC`,
      )
      .all(projectId)
      .map((row) => ({
        deliveryId: requiredText(row, 'delivery_id'),
        workItemId: requiredText(row, 'work_item_id'),
        state: requiredText(row, 'state') as DeliveryState,
        candidateFingerprint: requiredText(row, 'candidate_fingerprint') as Fingerprint,
        failureDetail: optionalText(row, 'failure_detail_redacted'),
        createdAt: requiredText(row, 'created_at'),
      }));
  }

  private readOpenQuestions(projectId: ProjectId): readonly AttentionQuestion[] {
    return this.connection
      .prepare(
        `SELECT q.question_id, w.work_item_id, q.body, q.created_at
           FROM idea_questions q JOIN work_items w ON w.idea_id = q.idea_id
          WHERE q.state = 'Open' AND w.project_id = ?
          ORDER BY q.created_at ASC, q.question_id ASC`,
      )
      .all(projectId)
      .map((row) => ({
        questionId: requiredText(row, 'question_id'),
        workItemId: requiredText(row, 'work_item_id'),
        body: requiredText(row, 'body'),
        createdAt: requiredText(row, 'created_at'),
      }));
  }
}
