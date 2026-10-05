/**
 * How a `HomeProjection` becomes three labelled groups, decided without a browser.
 *
 * ## What this decides and what it does not
 *
 * It decides only two things: what an entry kind is called in the owner's words, and where an
 * entry leads. It does not decide whether an entry belongs in a group — the backend already did
 * that, and a second grouping here is a second answer to "what needs the owner" waiting to disagree
 * with the first (F23-AC1, F24-AC3).
 *
 * ## Why the vocabulary is closed
 *
 * Every value below is a word ShipLoop can stand behind. There is deliberately no label, phrase or
 * status meaning "the agent is working", because ShipLoop holds no integration that could answer it
 * — coding happens in T3 or another executor, outside the product. A UI string is the easiest place
 * in a codebase to invent such a fact, and once rendered it is something the owner reads as
 * observed (mvp-spec 3).
 */

/** Where an entry takes the owner when followed. */
export type HomeTarget = 'request' | 'review';

const KIND_LABEL: Readonly<Record<string, string>> = {
  ContractNotWritten: 'No contract yet',
  ContractAwaitingApproval: 'Contract needs your approval',
  CandidateNotLinked: 'Approved — no candidate linked',
  VerificationOutstanding: 'Verification outstanding',
  VerificationFailed: 'Verification failed',
  OwnerTestOutstanding: 'Your test is outstanding',
  DecisionAwaiting: 'Ready for your decision',
  CandidateReadyForReview: 'Ready for review',
};

/**
 * What an entry kind is called, or an explicit gap if the backend ever grows a kind.
 *
 * The fallback is a refusal rather than a blank or a guessed label. A new backend kind arriving
 * with no word for it is exactly the case where a UI silently renders something like
 * `CandidateRefreshed`, and the owner reads an internal discriminator as a product state (F23-AC1).
 */
export function entryLabel(kind: string): string {
  const label = KIND_LABEL[kind];
  return label ?? `A state this build has no word for yet (${kind}). Ask for this screen to be updated.`;
}

/**
 * Where an entry leads.
 *
 * Anything naming a candidate is a decision about code, which is the Review area; everything else is
 * about what was asked for, which is the New Request area. Chosen from the row rather than from the
 * group it sits in, because a grouped entry that cannot be opened is a dead end and a dead end in
 * "Needs you" is the most expensive kind.
 */
export function homeTargetOf(entry: { readonly candidateId: string | null }): HomeTarget {
  return entry.candidateId === null ? 'request' : 'review';
}

/**
 * The three groups, in the wording the owner reads.
 *
 * The descriptions exist because the group names alone are ambiguous: "In progress" could mean
 * ShipLoop is working (it is not) or that work is under way (it is). So each group says what it
 * contains in terms the owner can check against their own list of requests (mvp-spec 3).
 *
 * `as const` and one exported value, so this list and the screen's rendering are the same value
 * rather than two copies that can drift.
 */
export const HOME_GROUPS = [
  {
    key: 'needsYou',
    title: 'Needs you',
    description: 'Decisions and actions that are yours to make.',
    empty: 'Nothing is waiting on you.',
  },
  {
    key: 'inProgress',
    title: 'In progress',
    description: 'Requested work that has not reached a candidate yet.',
    empty: 'No request is waiting on a candidate.',
  },
  {
    key: 'readyForReview',
    title: 'Ready for review',
    description: 'Candidates whose evidence is current for their exact commit.',
    empty: 'No candidate is ready to be judged.',
  },
] as const;
