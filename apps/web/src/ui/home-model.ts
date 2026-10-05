/**
 * How a home entry is put in front of the owner.
 *
 * `routes/home.ts` decides *which group a recorded fact belongs to* and writes the reason and
 * the next action in its own words. This module decides only how that is laid out and what it
 * is called, and it holds one rule above all the rest:
 *
 *   - **No word here describes an external executor.** ShipLoop has no integration that
 *     proves an agent started, is running, or is 60% through. `routes/home.ts` has no field
 *     for any of them and its tests walk the payload to keep it that way; the labels here
 *     are written against the same limit, so a kind named `VerificationOutstanding` becomes
 *     "Verification outstanding" and never "Build in progress". Every label is a statement
 *     about what ShipLoop holds, and `presentEntry` has no input that could make it another.
 *
 * Two more rules the layout keeps:
 *
 *   - **A group with nothing in it says so in words.** `empty` is a sentence rather than an
 *     illustration, because the sentence is the honest answer and a drawn placeholder would
 *     be an entry the server did not send.
 *   - **A request in two groups is two obligations.** Nothing here merges or hides a
 *     repetition between groups: a candidate with current automated evidence and an unrun
 *     owner test is reviewable *and* has something outstanding of the owner, and collapsing
 *     it into one row would hide the owner test the product exists to prompt (F24-AC3).
 *
 * Pure and free of React so the wording and the mapping can be tested directly.
 */

import type { StatusTone } from './components/StatusBadge.tsx';
import type { PrimarySurfaceId } from './navigation.ts';
import type { HomeEntry, HomeEntryKind, HomeProjection, MvpFailure } from './mvp-client.ts';

export type HomeGroupId = 'needsYou' | 'inProgress' | 'readyForReview';

export interface HomeGroupDescriptor {
  readonly id: HomeGroupId;
  readonly title: string;
  /** What membership of this group means, in the owner's terms. */
  readonly explanation: string;
  /** The sentence an empty group renders. Not a placeholder entry (F20-AC1). */
  readonly empty: string;
}

export const HOME_GROUPS: readonly HomeGroupDescriptor[] = [
  {
    id: 'needsYou',
    title: 'Needs you',
    explanation: 'Requests where the next step is yours to take.',
    empty: 'Nothing is waiting on you. A request appears here when the next step is yours.',
  },
  {
    id: 'inProgress',
    title: 'In progress',
    explanation:
      'Steps ShipLoop has recorded as unfinished. This is not an agent watching an external executor: a request appears here only where ShipLoop holds a recorded fact that a step is outstanding, such as an approved contract with no candidate linked, or a required check with no result recorded against the current commit.',
    empty: 'Nothing is recorded as still moving. A request appears here while a step ShipLoop records is unfinished.',
  },
  {
    id: 'readyForReview',
    title: 'Ready for review',
    explanation: 'Candidates whose recorded verification is current for the commit on screen.',
    empty: 'Nothing is ready to look at yet. A candidate appears here once the verification recorded against its current commit is up to date.',
  },
];

/**
 * The badge tone for a kind.
 *
 * A tone is never the only carrier of the state - `kindLabel` says it in words - so these
 * are reinforcement rather than encoding (N03-AC1). `VerificationOutstanding` is deliberately
 * `pending` and never `healthy`: no result against the current commit is the absence of a
 * pass, and painting it green is the exact substitution this mapping exists to refuse.
 */
const KIND_TONES: Readonly<Record<HomeEntryKind, StatusTone>> = {
  ContractNotWritten: 'pending',
  ContractAwaitingApproval: 'pending',
  CandidateNotLinked: 'pending',
  VerificationOutstanding: 'pending',
  VerificationFailed: 'revoked',
  OwnerTestOutstanding: 'pending',
  DecisionAwaiting: 'degraded',
  CandidateReadyForReview: 'healthy',
};

/**
 * What each kind is, as a sentence fragment about the owner's position.
 *
 * Phrased as the owner's situation rather than as the server's bookkeeping, and never as
 * anything an executor would be doing.
 */
const KIND_LABELS: Readonly<Record<HomeEntryKind, string>> = {
  ContractNotWritten: 'No delivery contract yet',
  ContractAwaitingApproval: 'Contract awaiting your approval',
  CandidateNotLinked: 'No candidate linked',
  VerificationOutstanding: 'Verification outstanding',
  VerificationFailed: 'A recorded result is not a pass',
  OwnerTestOutstanding: 'An owner test is outstanding',
  DecisionAwaiting: 'Ready for your decision',
  CandidateReadyForReview: 'Ready to review',
};

/**
 * Where an entry's next action belongs.
 *
 * Only surfaces that exist in this build are named, and only when the entry names something
 * there to do. `null` means the entry's `nextAction` is shown as a statement with no button
 * beside it, which is the honest rendering for an action whose screen is not part of the MVP
 * cut - a button that navigates somewhere with nothing to show would be a control that
 * promises a step and delivers a blank page.
 */
function targetOf(entry: HomeEntry): PrimarySurfaceId | null {
  switch (entry.kind) {
    // Contract text and its approval live with the request.
    case 'ContractNotWritten':
    case 'ContractAwaitingApproval':
      return 'new-request';
    // A candidate is linked from the request it implements.
    case 'CandidateNotLinked':
      return 'new-request';
    // Everything about a candidate - its evidence, its outstanding criteria and the owner's
    // decision - is read on the review surface.
    case 'VerificationOutstanding':
    case 'VerificationFailed':
    case 'OwnerTestOutstanding':
    case 'DecisionAwaiting':
    case 'CandidateReadyForReview':
      return 'review';
  }
}

/** One labelled fact about an entry, in the order it is worth reading. */
export interface EntryFact {
  readonly label: string;
  readonly value: string;
  /** Rendered as code: an identifier or a commit, which must not be paraphrased. */
  readonly mono?: boolean;
}

export interface EntryPresentation {
  readonly kindLabel: string;
  readonly tone: StatusTone;
  readonly facts: readonly EntryFact[];
  readonly target: PrimarySurfaceId | null;
  /** The button text for `target`; null when there is no button. */
  readonly actionLabel: string | null;
}

/**
 * Lays one entry out.
 *
 * Facts are included only when the projection supplied them, so an absent contract revision
 * is not rendered as "revision unknown" - absence is shown by the absence of a row, which is
 * the difference between "the server said nothing here" and "the client filled something in".
 */
export function presentEntry(entry: HomeEntry): EntryPresentation {
  const facts: EntryFact[] = [{ label: 'Request', value: entry.requestId, mono: true }];

  if (entry.contractId !== null) {
    facts.push({
      label: 'Contract',
      value: entry.contractRevision === null ? entry.contractId : `${entry.contractId} revision ${entry.contractRevision}`,
      mono: entry.contractRevision === null,
    });
  }
  if (entry.candidateId !== null) {
    facts.push({ label: 'Candidate', value: entry.candidateId, mono: true });
  }
  if (entry.headSha !== null) {
    // The whole commit. There is no abbreviated form to render here, and `mvp-client.ts`
    // refuses a payload that carries one, because the full SHA is the only identity a
    // candidate has (F17-AC2).
    facts.push({ label: 'Commit', value: entry.headSha, mono: true });
  }
  if (entry.outstandingCriterionIds.length > 0) {
    facts.push({ label: 'Outstanding criteria', value: entry.outstandingCriterionIds.join(', ') });
  }

  const target = targetOf(entry);
  return {
    kindLabel: KIND_LABELS[entry.kind],
    tone: KIND_TONES[entry.kind],
    facts,
    target,
    actionLabel: target === null ? null : actionLabelFor(target),
  };
}

function actionLabelFor(target: PrimarySurfaceId): string {
  return target === 'review' ? 'Go to Review' : 'Go to New Request';
}

/** One group's entries, in the order the projection sent them. Never re-sorted, never merged. */
export function groupEntries(projection: HomeProjection, id: HomeGroupId): readonly HomeEntry[] {
  switch (id) {
    case 'needsYou':
      return projection.needsYou;
    case 'inProgress':
      return projection.inProgress;
    case 'readyForReview':
      return projection.readyForReview;
  }
}

export interface FailurePresentation {
  readonly heading: string;
  readonly detail: string;
  /** Whether the cause is worth telling the owner to retry rather than to correct. */
  readonly retryable: boolean;
}

/**
 * Turns a transport failure into words, keeping the three causes apart.
 *
 * A disconnected client and a refusing server are different situations: one is a question
 * about this browser's connection and the other is an answer from the server, and merging
 * them is how "your view is out of date" turns into "the server said no" (N03-AC1). A
 * response that does not match the handler is a third thing again, and it says so rather
 * than blaming the owner for something they did not do.
 */
export function presentFailure(failure: MvpFailure): FailurePresentation {
  switch (failure.code) {
    case 'Disconnected':
      return {
        heading: 'ShipLoop cannot reach the server',
        detail: `${failure.reason} Nothing on this board has changed, and nothing you have entered anywhere else has been lost.`,
        retryable: true,
      };
    case 'Refused':
      if (failure.serverCode === 'Unauthorized') {
        return {
          heading: 'This session is no longer valid',
          detail: 'The server refused the request because this session has ended. Sign in again to carry on; nothing has been lost.',
          retryable: false,
        };
      }
      return {
        heading: 'The server refused to build this board',
        detail: failure.reason,
        retryable: false,
      };
    case 'MalformedResponse':
      return {
        heading: 'This board is not in a shape ShipLoop can show',
        detail: `${failure.reason} Nothing is displayed rather than part of a board this client cannot vouch for.`,
        retryable: false,
      };
  }
}