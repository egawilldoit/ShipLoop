/**
 * The one derivation the New Request screen makes on the owner's behalf: the request title.
 *
 * It lives here rather than in the page because it is a rule, not a rendering: both the preview
 * line and the submitted value read this function, and a derivation the owner cannot see is a
 * derivation the owner cannot correct. A request whose title was quietly truncated is one they
 * find in a list later rather than in front of them while they are writing.
 *
 * Keeping it out of the component also keeps it testable: `node --test` strips types but has no JSX
 * pipeline, so a rule that lived in a `.tsx` file would have no unit test at all.
 */

/** Longest title derived from the first line before the derivation is reported as shortened. */
export const TITLE_LIMIT = 120;

export interface DerivedTitle {
  readonly title: string;
  /** True when the first line was longer than `TITLE_LIMIT` and its tail was dropped. */
  readonly shortened: boolean;
}

export function deriveTitle(description: string): DerivedTitle {
  const firstLine = description.split('\n').find((line) => line.trim() !== '') ?? '';
  const trimmed = firstLine.trim();
  if (trimmed === '') return { title: '', shortened: false };
  if (trimmed.length <= TITLE_LIMIT) return { title: trimmed, shortened: false };
  return { title: trimmed.slice(0, TITLE_LIMIT).trimEnd(), shortened: true };
}