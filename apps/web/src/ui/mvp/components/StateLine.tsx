/**
 * The five states every MVP surface can be in, rendered as one line of text.
 *
 * Loading, empty, error and disconnected are separate here, and none of them is a blank page:
 *
 *   - **loading** says the surface is asking and has not been answered yet, so an empty region is
 *     not mistaken for "there is nothing here";
 *   - **empty** says the answer arrived and there is genuinely nothing, which is the one state
 *     where silence would have been honest — and it still gets a sentence, because "nothing here"
 *     and "not loaded yet" look identical on a screen;
 *   - **error** carries the server's own words and is announced assertively, because a refusal the
 *     owner cannot see is a refusal they will retry without knowing why;
 *   - **stale** is its own state rather than an error, because the data is readable and the
 *     warning is about what it describes, not about whether it arrived.
 *
 * `data-state` is on every line so a test can assert the state instead of the absence of content,
 * and the same convention the rest of this application already uses.
 */

import type { ReactElement, ReactNode } from 'react';

export type ViewState = 'loading' | 'empty' | 'error' | 'stale' | 'ready';

export interface StateLineProps {
  readonly view: ViewState;
  readonly message: string;
  readonly testId?: string;
}

/** Errors are read out immediately; everything else waits for a pause. */
function liveness(view: ViewState): 'polite' | 'assertive' {
  return view === 'error' ? 'assertive' : 'polite';
}

export function StateLine({ view, message, testId }: StateLineProps): ReactElement {
  return (
    <p
      className={view === 'error' ? 'state-line state-line--error' : 'state-line'}
      role={view === 'error' ? 'alert' : 'status'}
      aria-live={liveness(view)}
      data-state={view}
      data-testid={testId}
    >
      {message}
    </p>
  );
}

export interface PanelProps {
  readonly id: string;
  readonly title: string;
  readonly note?: string;
  /** `ReactNode`, not `ReactElement`: every panel here renders a conditional child, and a narrower
   * type would force a wrapper element around each one for no gain. */
  readonly children?: ReactNode;
}

/** A titled block, with a heading the section can be named by for assistive technology. */
export function Panel({ id, title, note, children }: PanelProps): ReactElement {
  const headingId = `${id}-title`;
  return (
    <section className="panel" aria-labelledby={headingId}>
      <h3 className="panel__title" id={headingId}>
        {title}
      </h3>
      {note === undefined ? null : <p className="panel__note">{note}</p>}
      {children ?? null}
    </section>
  );
}

/** A labelled read-only value, so a fact is never a bare run of text in a paragraph. */
export function Detail({ label, children, testId }: { readonly label: string; readonly children: ReactElement | string; readonly testId?: string }): ReactElement {
  return (
    <div className="detail-list__row">
      <dt>{label}</dt>
      <dd data-testid={testId}>{children}</dd>
    </div>
  );
}

/** A full commit SHA, rendered in a way that wraps instead of pushing the page sideways. */
export function Sha({ value, testId }: { readonly value: string; readonly testId?: string }): ReactElement {
  return (
    <code className="sha" data-testid={testId}>
      {value}
    </code>
  );
}