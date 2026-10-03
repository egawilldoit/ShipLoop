/**
 * Commit identity rules the UI enforces at its own input boundary.
 *
 * The full 40-character commit SHA is the identity of a candidate. A branch name, an abbreviated
 * SHA or a pull request number can each be moved after the fact, so evidence recorded against one
 * of them describes work that may no longer exist. The UI therefore refuses an abbreviated SHA at
 * the form, with a sentence that says why, rather than accepting it and letting the server decide.
 *
 * This is *not* the server's validation. It is the browser refusing to send a value it already
 * knows cannot be identity, so the owner is told immediately instead of after a round trip. The
 * server must re-check it regardless: a client check is a courtesy, never a control.
 */

/** Exactly forty hexadecimal characters, either case. */
const FULL_SHA = /^[0-9a-fA-F]{40}$/;

export const FULL_SHA_LENGTH = 40;

export function isFullCommitSha(value: string): boolean {
  return FULL_SHA.test(value.trim());
}

/**
 * The refusal for a SHA that is not a full commit identity, or null when it is one.
 *
 * Three cases are named separately because they are three different mistakes, and an owner who
 * pasted a branch name needs to be told that, not that "the SHA is wrong":
 *
 *   - empty — nothing was entered;
 *   - a short run of hex — an abbreviated SHA, which is the mistake everyone makes;
 *   - anything else — not a commit identity at all, most often a branch name or a URL.
 */
export function shaProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return 'Enter the full commit SHA.';
  if (FULL_SHA.test(trimmed)) return null;
  if (/^[0-9a-fA-F]{4,39}$/.test(trimmed)) {
    return (
      `That is an abbreviated SHA. ShipLoop needs all ${String(FULL_SHA_LENGTH)} characters, because an ` +
      'abbreviated one names a different commit on another branch and cannot be shown to have gone stale.'
    );
  }
  return (
    'That is not a commit SHA. ShipLoop identifies a candidate by its full 40-character commit SHA; ' +
    'a branch name or a pull request URL is not one.'
  );
}

/**
 * The sentence that says why the full SHA is shown beside every candidate.
 *
 * Used on the review surface and the handoff surface, which are the two places an owner reads a
 * candidate identity, so the rule is visible where it is being relied on rather than only in a
 * form's error message.
 */
export const SHA_IDENTITY_NOTE =
  `Every candidate is named by its full ${String(FULL_SHA_LENGTH)}-character commit SHA. That is the only ` +
  'identity that cannot be moved underneath an acceptance: a branch name and a pull request number can both be ' +
  'changed after the fact, and evidence recorded against the wrong one would describe work that no longer exists.';

/** Whether two SHAs name the same commit. Case-insensitive, because git prints them lowercase. */
export function sameCommit(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase() && isFullCommitSha(left) && isFullCommitSha(right);
}