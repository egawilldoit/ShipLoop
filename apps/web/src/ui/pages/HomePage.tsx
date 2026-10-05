/**
 * Home: what needs the owner, what ShipLoop has recorded as still moving, and what is ready
 * to be looked at (mvp-spec 3, F20-AC1, F24-AC3, F02-AC1, N03-AC1, N03-AC3, F01-AC3).
 *
 * This page is a rendering of `GET /api/projects/:projectId/home` and nothing else. Every
 * judgement - which group a request belongs to, why it is there, what the owner does next,
 * which criteria are outstanding - was made by `routes/home.ts` from recorded facts, and the
 * page's job is to show that without adding, softening or completing any of it. That is why
 * there is a page here and no projection: a second opinion about readiness would be a second
 * opinion that could drift from the one the domain owns (F20-AC3).
 *
 * Five properties the rendering keeps, each because the alternative was a wrong answer:
 *
 *   - **An empty group is empty, in words.** All three headings are always rendered. A
 *     section that disappeared when it had nothing in it would leave the owner unable to tell
 *     "nothing needs you" from a board that never loaded (F20-AC1). There is no placeholder
 *     entry and no filler row: the sentence is the answer.
 *   - **A request may appear twice, and both rows stay.** A candidate with current automated
 *     evidence and an unrun owner test is reviewable *and* still has something outstanding of
 *     the owner. Collapsing the two rows into one would hide the owner test the product
 *     exists to prompt (F24-AC3), so no deduplication happens anywhere in this page.
 *   - **Nothing here describes an executor.** There is no spinner over a build, no
 *     percentage, no elapsed time and no "started" anywhere, because ShipLoop has no
 *     integration that would prove any of them. `In progress` means steps ShipLoop has
 *     recorded as unfinished, and the group says so underneath its title.
 *   - **The five states are five states.** Loading, empty, refused, disconnected and stale
 *     are visibly and differently worded, because they ask different things of the owner: wait,
 *     act, sign in again, check the connection, or read again (N03-AC1, N03-AC3).
 *   - **A commit is shown whole.** The 40 characters are the candidate's only identity
 *     (F17-AC2, F25-AC3), and `mvp-client.ts` refuses a payload carrying an abbreviation, so
 *     there is nothing shorter on this page to render by accident.
 *
 * The project arrives as a required prop and is never defaulted, derived or faked. When no
 * project is selected the shell renders its onboarding state instead of this page, so a
 * project-scoped read is unreachable without a real project id (F02-AC1, F02-AC4).
 */

import { useEffect, useState, type ReactElement } from 'react';
import { formatRelativeTime, formatTimestamp } from '../api-client.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { HOME_GROUPS, groupEntries, presentEntry, presentFailure, type HomeGroupDescriptor } from '../home-model.ts';
import type { PrimarySurfaceId } from '../navigation.ts';
import { fetchHome, type HomeEntry, type HomeProjection, type MvpFailure } from '../mvp-client.ts';

export interface HomePageProps {
  /** The project the session addresses. Never a placeholder and never empty (F02-AC1). */
  readonly projectId: string;
  readonly projectName: string;
  /** Bumped by the shell's retry control so a re-read happens without a page reload. */
  readonly epoch: number;
  readonly onReload: () => void;
  readonly onNavigate: (surface: PrimarySurfaceId) => void;
}

/** Why the board is one of two things, or neither. `failure` is null while it is a board. */
interface View {
  readonly phase: 'loading' | 'ready' | 'failed';
  readonly board: HomeProjection | null;
  readonly failure: MvpFailure | null;
}

const LOADING: View = { phase: 'loading', board: null, failure: null };

/**
 * How old a board may be before the page says so.
 *
 * Two minutes, because `collectedAt` is when the server read its own records and the page has
 * no way to learn that anything changed since. A board older than this is not wrong - it is a
 * reading - so it is labelled rather than hidden, and the owner is given the control that
 * refreshes it (N04-AC2).
 */
const STALE_AFTER_MS = 120_000;

/** How often the "read N minutes ago" wording is recalculated while the page is open. */
const AGE_TICK_MS = 30_000;

export function HomePage({ projectId, projectName, epoch, onReload, onNavigate }: HomePageProps): ReactElement {
  const [view, setView] = useState<View>(LOADING);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let current = true;
    setView(LOADING);
    void fetchHome(projectId).then((result) => {
      // A response that arrives after the owner moved on, or changed project, is not this
      // page's to render: it would put one project's board under another project's name.
      if (!current) return;
      setView(result.ok ? { phase: 'ready', board: result.value, failure: null } : { phase: 'failed', board: null, failure: result.error });
      setNowMs(Date.now());
    });
    return () => {
      current = false;
    };
  }, [projectId, epoch]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), AGE_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const board = view.board;
  const failure = view.failure;
  const collectedAgeMs = board === null ? 0 : nowMs - Date.parse(board.collectedAt);
  const stale = board !== null && collectedAgeMs > STALE_AFTER_MS;

  return (
    <section className="page" aria-labelledby="home-title">
      <div className="page__header">
        <h2 className="page__title" id="home-title">
          Home
        </h2>
        <button className="button button--secondary" type="button" onClick={onReload}>
          Read again
        </button>
      </div>
      <p className="panel__note">
        Everything below is what ShipLoop has recorded for <strong>{projectName}</strong>. Nothing here is an agent
        running somewhere: ShipLoop watches no external executor, so a request appears only where ShipLoop holds a
        fact about it.
      </p>

      {/* The state line is always rendered and always says which of the five states this is,
          so a board that never loaded cannot be mistaken for a board with nothing on it. */}
      {view.phase === 'loading' ? (
        <p className="state-line" role="status" aria-live="polite" data-state="loading">
          Reading what needs you for {projectName}…
        </p>
      ) : null}

      {view.phase === 'failed' && failure !== null ? (
        <FailurePanel failure={failure} onReload={onReload} />
      ) : null}

      {board !== null ? (
        <p
          className={stale ? 'state-line state-line--warn' : 'state-line'}
          role="status"
          aria-live="polite"
          data-state={stale ? 'stale' : 'ready'}
        >
          {stale
            ? `This board was read ${formatRelativeTime(board.collectedAt, nowMs)} and has not been re-read since. ` +
              `It was read at ${formatTimestamp(board.collectedAt)}. Press Read again for a current answer.`
            : `Read from project ${board.projectId} at ${formatTimestamp(board.collectedAt)}.`}
        </p>
      ) : null}

      {board === null
        ? null
        : HOME_GROUPS.map((group) => (
            <HomeGroup key={group.id} group={group} board={board} onNavigate={onNavigate} />
          ))}
    </section>
  );
}

function FailurePanel({ failure, onReload }: { readonly failure: MvpFailure; readonly onReload: () => void }): ReactElement {
  const shown = presentFailure(failure);
  return (
    <div className="state-line state-line--error" role="alert" data-state={failure.code === 'Disconnected' ? 'disconnected' : 'failed'}>
      <p>
        <strong>{shown.heading}.</strong> {shown.detail}
      </p>
      {shown.retryable ? (
        <div className="form__actions">
          <button className="button" type="button" onClick={onReload}>
            Read again
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One group: its title, what membership means, and either its rows or the sentence that
 * stands for having none.
 */
function HomeGroup({
  group,
  board,
  onNavigate,
}: {
  readonly group: HomeGroupDescriptor;
  readonly board: HomeProjection;
  readonly onNavigate: (surface: PrimarySurfaceId) => void;
}): ReactElement {
  const entries = groupEntries(board, group.id);
  const headingId = `home-group-${group.id}`;
  return (
    <section className="panel" aria-labelledby={headingId}>
      <h3 className="panel__title" id={headingId}>
        {group.title}
      </h3>
      <p className="panel__note">{group.explanation}</p>
      {entries.length === 0 ? (
        <p className="state-line" role="status" data-state="empty">
          {group.empty}
        </p>
      ) : (
        <ul className="profile-list">
          {entries.map((entry) => (
            <HomeEntryRow key={`${entry.requestId}:${entry.kind}`} entry={entry} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One request as it appears in one group. */
function HomeEntryRow({
  entry,
  onNavigate,
}: {
  readonly entry: HomeEntry;
  readonly onNavigate: (surface: PrimarySurfaceId) => void;
}): ReactElement {
  // Destructured rather than read off the object, so the narrowed type survives into the
  // click handler below and no cast is needed to pass a target that is already known.
  const { kindLabel, tone, facts, target, actionLabel } = presentEntry(entry);
  return (
    <li className="profile-list__item">
      <h4 className="profile-list__name">{entry.title}</h4>
      <StatusBadge tone={tone} label={kindLabel} />
      {/*
        The reason and the next action are the server's own sentences, quoted rather than
        summarised. Rewording them here is how a projection stops being traceable to the fact
        it was derived from, and the owner can no longer find the record a group membership
        came from.
      */}
      <p className="profile-list__detail">{entry.reason}</p>
      <div className="detail-list">
        {facts.map((fact) => (
          <div className="detail-list__row" key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.mono === true ? <code>{fact.value}</code> : fact.value}</dd>
          </div>
        ))}
        <div className="detail-list__row">
          <dt>Next action</dt>
          <dd>{entry.nextAction}</dd>
        </div>
      </div>
      {target === null || actionLabel === null ? null : (
        <div className="form__actions">
          <button className="button button--secondary" type="button" onClick={() => onNavigate(target)}>
            {actionLabel}
          </button>
        </div>
      )}
    </li>
  );
}