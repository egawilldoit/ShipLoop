/**
 * The contract every primary screen in the owner shell is written against.
 *
 * ## Why this module exists
 *
 * The four primary areas — Home, New Request, Review, Settings — are built as three separate
 * pieces of work against one shell. This file is the seam they meet at, so that "what shape is a
 * screen" and "what shape is a project scope" are answered exactly once and cannot drift between
 * three implementations.
 *
 * It is deliberately tiny. It decides how a screen is *addressed* and how a screen *reports a
 * problem*; it decides nothing about what any screen shows. Eligibility, verification policy and
 * every product judgement stay on the server (F23-AC1, F25-AC3).
 *
 * ## The two rules this encodes
 *
 *   1. **A screen never invents a project.** `scope` is `null` when no project is selected, and a
 *      screen handed `null` says it has no project. It must not substitute a default, a
 *      remembered id, or the string `"undefined"` — the historical defect was a request to
 *      `/api/profiles/undefined`, answered 404 and reported as "that project has no saved profile
 *      yet" (F02-AC1, F02-AC4).
 *   2. **A screen never decides readiness.** A screen reads an eligibility flag the backend
 *      computed and reflects it. It does not re-derive eligibility from criteria, checks or
 *      evidence, because two implementations of one rule is how a candidate becomes acceptable
 *      through a surface that was never consulted (F24-AC3).
 */

import type { ReactElement, ReactNode } from 'react';

import type { MvpFailure, ProjectScope } from '../mvp-client/index.ts';

/** What every primary screen receives. */
export interface ScreenProps {
  /**
   * The project this screen addresses, or `null` when the owner has selected none.
   *
   * `null` is a real state to render, not an error and not a licence to guess. The shell renders
   * a shared "no project selected" state before a screen is ever mounted with `null`; a screen
   * still handles it, because a screen must never be the thing that decides a request is
   * well-formed (F02-AC1).
   */
  readonly scope: ProjectScope | null;
  /**
   * Bumped when the connection state changes, so a screen can refetch rather than keep rendering
   * facts it knows are from a dropped connection.
   */
  readonly epoch: number;
}

/**
 * One primary area's page.
 *
 * A component type rather than an element so the shell owns the mount point, the title and the
 * error boundary, and a screen owns only its content.
 */
export type ScreenComponent = (props: ScreenProps) => ReactElement;

/**
 * A refusal, rendered the same way on every screen.
 *
 * One presentation for a failed call, so "the request failed" never looks different on Home than
 * on Review and never looks like content. `role="alert"` because a refusal the owner asked for
 * and did not get is announced, not decoration.
 *
 * The prerequisites are listed when the server sent them: the acceptance gate names its
 * outstanding requirements, and suppressing that would send the owner away without telling them
 * what to do (F24-AC3).
 */
export function ScreenFailure({ failure }: { readonly failure: MvpFailure }): ReactElement {
  return (
    <div className="state-line state-line--error" role="alert" data-state="failed">
      <p>{failure.reason}</p>
      {failure.prerequisites.length > 0 && (
        <ul className="screen-failure__list">
          {failure.prerequisites.map((entry, index) => (
            <li key={`${entry.name}-${index}`}>
              <strong>{entry.name}</strong>: {entry.detail}
              {entry.remedy !== '' && <> — {entry.remedy}</>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A read in progress. Announced, so a screen that is loading says so. */
export function ScreenLoading({ what }: { readonly what: string }): ReactElement {
  return (
    <p className="state-line" role="status" aria-live="polite" data-state="loading">
      {what}
    </p>
  );
}

/**
 * A screen with nothing to show.
 *
 * Its own component rather than an inline empty `<p>`, because "there is genuinely nothing here"
 * and "this has not loaded yet" must never render the same way, and because the third case —
 * a screen that has no project — is a different message again (F02-AC1).
 */
export function ScreenEmpty({ children }: { readonly children: ReactNode }): ReactElement {
  return <p className="state-line" data-state="empty">{children}</p>;
}

/** The shared "no project is selected" state. */
export function NoProjectSelected(): ReactElement {
  return (
    <ScreenEmpty>
      No project is selected. Choose one at the top of this page before this screen can ask
      anything — it will not guess which project you meant.
    </ScreenEmpty>
  );
}