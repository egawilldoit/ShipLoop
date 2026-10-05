/**
 * Home — what requires the owner, what is moving, and what is ready to be judged.
 *
 * ## What this screen is allowed to say
 *
 * Every fact here arrives in `HomeProjection` from `GET /api/projects/:projectId/home`, which the
 * backend derives from rows ShipLoop owns: requests, contracts, candidates, evidence and
 * decisions. This screen decides nothing about what any of those mean. It groups, labels and
 * navigates.
 *
 * The thing it must never do is display executor activity. ShipLoop has no factual integration
 * with T3, OpenCode, Codex or Claude — coding happens outside it — so there is no row to read, no
 * API to ask, and no honest way to answer "is the agent working?". An entry saying so would be an
 * invention, and an owner reading it would wait for something that is not being tracked. So the
 * vocabulary here is `needsYou` / `inProgress` / `readyForReview` and nothing else (mvp-spec 3,
 * F23-AC1).
 *
 * ## Why three groups and not one list
 *
 * The three answer three different owner questions — *what needs me*, *what is under way*, *what
 * can I decide* — and a single merged list loses the answer to the first of them. `nextAction` on
 * each entry says who acts; an entry whose next action belongs to ShipLoop rather than the owner
 * would be in the wrong group, and the backend is what places it.
 */

import { useEffect, useState, type ReactElement } from 'react';

import {
  fetchHome,
  type HomeEntry,
  type HomeProjection,
  type MvpFailure,
  type ProjectScope,
} from '../mvp-client/index.ts';
import { CommitSha } from './CommitSha.tsx';
import { HOME_GROUPS, entryLabel, homeTargetOf, type HomeTarget } from './home-model.ts';
import { NoProjectSelected, ScreenFailure, ScreenLoading } from './screen.tsx';

function HomeEntryRow({
  entry,
  onOpen,
}: {
  readonly entry: HomeEntry;
  readonly onOpen: (target: HomeTarget) => void;
}): ReactElement {
  const target = homeTargetOf(entry);
  return (
    <li className="home-entry">
      <button
        className="button button--secondary home-entry__button"
        type="button"
        onClick={() => onOpen(target)}
      >
        <span className="home-entry__kind">{entryLabel(entry.kind)}</span>
        <span className="home-entry__title">{entry.title}</span>
        {entry.headSha !== null && (
          <span className="home-entry__sha">
            candidate <CommitSha sha={entry.headSha} label="the candidate under review" />
          </span>
        )}
        {entry.contractRevision !== null && (
          <span className="home-entry__revision">contract revision {entry.contractRevision}</span>
        )}
      </button>
      {/* Both lines are shown, not one chosen between them. The reason says why the entry is
          here and the next action says who acts; collapsing them to whichever fits is how an
          owner ends up reading "waiting on verification" as though they were the blocker. */}
      <p className="home-entry__reason">{entry.reason}</p>
      <p className="home-entry__next">{entry.nextAction}</p>
      {entry.outstandingCriterionIds.length > 0 && (
        <p className="home-entry__criteria">
          Outstanding: {entry.outstandingCriterionIds.join(', ')}
        </p>
      )}
    </li>
  );
}

function HomeGroup({
  title,
  description,
  entries,
  onOpen,
  emptyMessage,
}: {
  readonly title: string;
  readonly description: string;
  readonly entries: readonly HomeEntry[];
  readonly onOpen: (target: HomeTarget) => void;
  readonly emptyMessage: string;
}): ReactElement {
  return (
    <section className="home-group" aria-label={title}>
      <h2 className="home-group__title">{title}</h2>
      <p className="home-group__description">{description}</p>
      {entries.length === 0 ? (
        <p className="state-line" data-state="empty">{emptyMessage}</p>
      ) : (
        <ul className="home-group__list">
          {entries.map((entry) => (
            <HomeEntryRow
              key={`${entry.requestId}-${entry.kind}-${entry.candidateId ?? 'none'}`}
              entry={entry}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function HomeScreen({
  scope,
  epoch,
  onOpen,
}: {
  readonly scope: ProjectScope | null;
  readonly epoch: number;
  readonly onOpen: (target: HomeTarget) => void;
}): ReactElement {
  const [home, setHome] = useState<HomeProjection | null>(null);
  const [failure, setFailure] = useState<MvpFailure | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (scope === null) {
      setHome(null);
      setLoading(false);
      return;
    }
    let current = true;
    setLoading(true);
    void fetchHome(scope).then((result) => {
      if (!current) return;
      setLoading(false);
      if (!result.ok) {
        setHome(null);
        setFailure(result.failure);
        return;
      }
      setHome(result.value);
      setFailure(null);
    });
    return () => {
      current = false;
    };
  }, [scope, epoch]);

  if (scope === null) return <NoProjectSelected />;
  if (loading && home === null) return <ScreenLoading what="Reading what needs you…" />;
  if (failure !== null) return <ScreenFailure failure={failure} />;
  if (home === null) return <ScreenLoading what="Reading what needs you…" />;

  const nothingAtAll =
    home.needsYou.length === 0 && home.inProgress.length === 0 && home.readyForReview.length === 0;

  return (
    <div className="home">
      <h2 className="page__title">Home</h2>
      {/*
        The project is named from the scope the shell derived from the server's own answer, so
        what is shown and what every button below it addresses cannot drift apart.
      */}
      <p className="home__project">Project: {scope.kind === 'project' ? scope.projectName : 'none selected'}</p>

      {nothingAtAll && (
        <p className="state-line" data-state="empty">
          Nothing is in flight for this project. Start with a new request to define what should
          change.
        </p>
      )}

      {HOME_GROUPS.map((group) => (
        <HomeGroup
          key={group.key}
          title={group.title}
          description={group.description}
          entries={home[group.key]}
          onOpen={onOpen}
          emptyMessage={group.empty}
        />
      ))}

    </div>
  );
}