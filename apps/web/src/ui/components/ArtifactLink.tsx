/**
 * One evidence artifact, reachable only through the session-guarded artifact route
 * (F01-AC1, F23-AC3, F24-AC5, N02-AC2).
 *
 * A recorded check carries `artifactRef`, which is a *store-relative* name such as
 * `logs/exit-zero.log` and never a URL. Two rules follow from that, and they are the whole
 * reason this component exists:
 *
 *   - **The only link this app emits for an artifact points at `/artifacts/…`** (F01-AC1).
 *     That prefix is registered behind the session guard, so a signed-out browser receives a
 *     sign-in response rather than the file. Rendering the raw reference as a link to
 *     anything else — an absolute path, a `file:` URL, a host on another origin — would hand
 *     the owner either nothing or a disclosure, and would put a filesystem location in the
 *     DOM where a reviewer reads it as a supported link (N02-AC2).
 *   - **A reference that cannot be addressed safely is shown, not linked** (F24-AC5). A
 *     reference that escapes the store, carries a scheme, or is empty is unopenable; the
 *     owner is told which reference is on record and that it cannot be linked, rather than
 *     being handed a link that silently resolves somewhere else. An empty success panel would
 *     read as "there is no evidence", which is a different and stronger claim than "the
 *     evidence recorded cannot be opened" (F24-AC5).
 *
 * The link opens in a new tab so opening a log does not discard the card the owner was
 * reading, and carries `rel="noopener noreferrer"` so the opened document gets no handle on
 * this window (F01-AC4).
 */

import type { ReactElement } from 'react';
import { artifactHref } from '../api-client.ts';

export interface ArtifactLinkProps {
  /** The store-relative reference the journal recorded, or null when it recorded none. */
  readonly reference: string | null;
  /** What the artifact belongs to, used to name it in the sentence around the link. */
  readonly label: string;
}

/**
 * One artifact line: a link when the reference can be addressed safely, and an explanation
 * of why it cannot when it cannot.
 *
 * The three states are rendered as three different sentences rather than one sentence with an
 * optional link, so "nothing was recorded", "something was recorded and cannot be opened" and
 * "something was recorded and can be opened" never look alike (N03-AC3, F24-AC5).
 */
export function ArtifactLink({ reference, label }: ArtifactLinkProps): ReactElement {
  if (reference === null || reference.trim() === '') {
    return (
      <p className="connector__problem-line" data-testid="artifact-absent">
        {`No artifact reference is recorded for ${label}, so there is no file to open (F23-AC5).`}
      </p>
    );
  }

  const href = artifactHref(reference);
  if (href === null) {
    return (
      <p className="connector__problem-line" data-testid="artifact-unlinkable">
        {`${label} recorded the artifact reference "${reference}", which is not a path inside the artifact store, so it is shown as recorded text and cannot be opened as a link (F01-AC1, F24-AC5).`}
      </p>
    );
  }

  return (
    <p className="connector__problem-line">
      <span data-testid="artifact-recorded">{`${label} recorded artifact ${reference}. `}</span>
      <a href={href} target="_blank" rel="noopener noreferrer" data-testid="artifact-link">
        Open the artifact (opens in a new tab)
      </a>
      <span>{` The link is served under /artifacts/, which requires your current session; a signed-out browser is refused rather than shown the file (F01-AC1).`}</span>
    </p>
  );
}