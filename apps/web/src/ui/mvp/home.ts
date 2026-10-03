/**
 * The Home board's grouping rules, as pure functions.
 *
 * The MVP journey is `Request -> Delivery Contract -> External execution -> GitHub Candidate ->
 * Verification -> Owner Decision`, and external execution happens **outside** ShipLoop. That fact
 * governs this file: there is no truthful statement to make about whether an external agent is
 * working, so nothing here is derived from one. Every group below is a statement about durable
 * state this product owns — a contract revision, a linked candidate, a recorded verification, a
 * recorded decision — and an owner who disagrees with a placement can be told which of those four
 * facts produced it.
 *
 * The failure this file exists to prevent is a bucket labelled "In progress" whose contents are
 * ShipLoop's own silence. A request whose contract was approved an hour ago and which has no
 * linked candidate looks identical to a request whose external agent is mid-edit; putting it in a
 * progress bucket would report a fact nobody observed. So it sits in **Needs you**, because the
 * only action that moves it is one the owner takes.
 */

import type { HomeItem } from './wire.ts';

export type HomeGroupId = 'needs_you' | 'in_progress' | 'ready_for_review' | 'settled';

export interface HomeGroup {
  readonly id: HomeGroupId;
  readonly label: string;
  /**
   * Why an item can be in this group, in one sentence the owner can check.
   *
   * Rendered under every group heading. "In progress" with no explanation is the label that
   * invites the owner to assume something is running.
   */
  readonly meaning: string;
  readonly items: readonly HomeItem[];
}

/** The three groups the MVP Home shows, in the order a request passes through them. */
export const HOME_GROUPS: readonly { readonly id: HomeGroupId; readonly label: string; readonly meaning: string }[] = [
  {
    id: 'needs_you',
    label: 'Needs you',
    meaning:
      'The next step is one only you can take: write the contract, approve it, or tell ShipLoop which pull request implements it.',
  },
  {
    id: 'in_progress',
    label: 'In progress',
    meaning:
      'A pull request is linked and its verification is not finished. ShipLoop is not running anything: the implementation happened elsewhere, and these requests are waiting on evidence that has not arrived yet.',
  },
  {
    id: 'ready_for_review',
    label: 'Ready for review',
    meaning:
      'Verification is recorded for the exact commit linked here. That is evidence, not a decision — nothing is accepted until you accept it.',
  },
];

/**
 * Which group one request belongs to.
 *
 * Ordered by how much the answer depends on, because a decision ends the question: an accepted or
 * changes-requested candidate is not waiting on ShipLoop for anything, and a request that has been
 * decided must not also appear as outstanding work.
 */
export function homeGroupFor(item: HomeItem): HomeGroupId {
  const decision = item.decision;
  if (decision !== null && decision.kind === 'accepted') return 'settled';
  // Changes requested puts the request back with the owner: the next move is to take the
  // feedback into an external coding environment and link the result, and ShipLoop cannot do
  // either. It is not "in progress" because nothing is running that ShipLoop can see.
  if (decision !== null) return 'needs_you';

  const contract = item.contract;
  if (contract === null) return 'needs_you';
  if (contract.status !== 'approved') return 'needs_you';

  // An approved contract with no linked candidate is the handoff state. The owner has approved
  // the agreement and not yet named the implementation, so the next action is theirs.
  if (item.candidate === null) return 'needs_you';

  // `verification === null` means the server reported no verification at all for this candidate.
  // That is not the same as a reported incomplete one, and it is not complete either, so it lands
  // in progress with the absence stated rather than being read as ready.
  return item.verification !== null && item.verification.complete ? 'ready_for_review' : 'in_progress';
}

/** Why one item is in its group, named from the facts that decided it. */
export function homeGroupReason(item: HomeItem): string {
  switch (homeGroupFor(item)) {
    case 'needs_you':
      if (item.contract === null) return 'No Delivery Contract has been written for this request yet.';
      if (item.contract.status === 'stale') {
        return `Revision ${String(item.contract.revision)} is stale, so its approval no longer describes this work.`;
      }
      if (item.contract.status === 'draft') {
        return `Revision ${String(item.contract.revision)} is a draft and has not been approved.`;
      }
      if (item.candidate === null) {
        return `Revision ${String(item.contract.revision)} is approved and no pull request implements it yet.`;
      }
      return 'You asked for changes on the last candidate. Link the pull request that addresses them.';
    case 'in_progress':
      return (item.verification?.outstanding ?? []).join(' ') || 'No verification has been recorded for this candidate yet.';
    case 'ready_for_review':
      return 'Verification is recorded against the linked commit and nothing is outstanding.';
    case 'settled':
      return 'Accepted. Accepted work is not listed because it is no longer waiting on anything.';
  }
}

export interface GroupedHome {
  readonly groups: readonly HomeGroup[];
  /**
   * How many requests were left out because they are settled.
   *
   * Counted rather than hidden: a request that vanishes from the board is indistinguishable from
   * one that was never captured, and the count is what tells those two apart.
   */
  readonly settledCount: number;
}

/** Buckets every item, always returning all three groups even when a group is empty. */
export function groupHomeItems(items: readonly HomeItem[]): GroupedHome {
  const groups = HOME_GROUPS.map<HomeGroup>((group) => ({
    id: group.id,
    label: group.label,
    meaning: group.meaning,
    items: items.filter((item) => homeGroupFor(item) === group.id),
  }));
  return {
    groups,
    settledCount: items.filter((item) => homeGroupFor(item) === 'settled').length,
  };
}

