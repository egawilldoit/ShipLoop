/**
 * A commit, rendered as a commit.
 *
 * The full SHA is the only identity this product has for the code under review. A branch name is a
 * routing fact — it can be repointed between the owner's last visit and this one — an abbreviated
 * SHA is a prefix that several commits share, and a pull request number names a conversation rather
 * than a state of the repository. None of the three identifies what a check ran against or what an
 * approval covers, so none of them is ever rendered here as though it did (mvp-spec 3, SHARED.md
 * "Candidate", F24-AC4).
 *
 * Three properties make that structural rather than a matter of care:
 *
 *   - **The check is here.** `isFullCommitSha` runs before anything is printed, and a value that is
 *     not full length is refused rather than rendered. A seven-character SHA in a box labelled
 *     "commit" reads as a commit to everyone except the person who has to act on it, so the
 *     component states the refusal instead of printing the value.
 *   - **The full length is shown, never truncated.** Wrapping handles the layout, because an ellipsis
 *     on a SHA is indistinguishable from an abbreviation and therefore reproduces the exact
 *     confusion this component exists to remove.
 *   - **It is selectable and reachable by keyboard.** The owner copies a SHA out of this to compare
 *     it against `git rev-parse HEAD`, and a value that cannot be selected cannot be checked.
 *
 * Nothing here decides whether a commit is current, safe, or verified. Those are facts the server
 * reports, and a component that inferred them would be the second opinion this product is built to
 * avoid.
 */

import type { ReactElement } from 'react';

/**
 * Whether a value is a commit SHA at full length.
 *
 * 40 hex characters, or 64 for the SHA-256 repositories GitHub supports. Deliberately strict and
 * lower-case only, matching the domain's own `isCommitSha`: a branch name, an abbreviation and a
 * differently-cased SHA all fail it, and the last of those matters because an upper-case SHA is not
 * an identity this product recognises (mvp-spec 3).
 */
export function isFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value) || /^[0-9a-f]{64}$/.test(value);
}

export interface CommitShaProps {
  /** The commit. Expected at full length; anything else is refused rather than rendered. */
  readonly sha: string;
  /** What this commit is the identity of, e.g. "the code under review". */
  readonly label: string;
  /**
   * When false the SHA describes something other than the code under review — a previous head, or
   * the commit a provider attributed a check to. The component then says so, so the number cannot
   * speak for itself.
   */
  readonly current?: boolean;
}

/**
 * One commit identity, in full, with what it identifies and whether it is the one on screen.
 *
 * `data-current` is on the element so a reader, a test or a browser extension can tell the two apart
 * without parsing the prose, and so a stale SHA cannot be mistaken for the live one by styling alone
 * (N03-AC1, F24-AC3).
 */
export function CommitSha({ sha, label, current = true }: CommitShaProps): ReactElement {
  if (!isFullCommitSha(sha)) {
    // The value is not echoed. A malformed commit string here is untrusted input that reached the
    // document through a path the transport believed it had checked, and printing it would put a
    // value shaped like a commit into the DOM where every reader and every test would resolve it as
    // one (N02-AC2, mvp-spec 3).
    return (
      <p className="connector__problem-line" data-testid="commit-sha-refused" data-current={String(current)}>
        {`The ${label} was reported as a value that is not a full commit SHA, so it is not shown as one. A ` +
          `branch name, an abbreviated SHA and a pull request number are routing facts rather than identity, and ` +
          `nothing here may stand in for the code under review (mvp-spec 3, N02-AC2).`}
      </p>
    );
  }

  return (
    <div className="detail-list__row" data-testid="commit-sha" data-current={String(current)}>
      <dt>{`${label} (full commit SHA)`}</dt>
      <dd>
        <code
          className="version-list__id"
          // Wrapped rather than truncated: an ellipsis on a SHA is indistinguishable from an
          // abbreviation, so it reproduces the confusion rather than solving it (mvp-spec 3).
          style={{ overflowWrap: 'anywhere' }}
        >
          {sha}
        </code>
        {current ? null : (
          <span data-testid="commit-sha-not-current">
            {' — this is not the commit now on screen, so it does not describe the code under review.'}
          </span>
        )}
      </dd>
    </div>
  );
}