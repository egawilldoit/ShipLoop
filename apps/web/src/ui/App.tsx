/**
 * The owner shell.
 *
 * The MVP header is four tabs — **Home**, **New Request**, **Review**, **Settings** — and a project
 * selector. That is the whole navigation. The previous shell offered nine sections, of which five
 * were implementation-oriented surfaces (profiles, connectors, intake, brief, plan, publication,
 * runs, dashboard) and none of which a request-to-decision journey needs to pass through.
 *
 * Those surfaces are not deleted, and that is a deliberate decision rather than an omission. Each
 * has browser evidence behind it, and deleting a page while its spec stayed would turn a green suite
 * into a claim about work nobody ran. They are reachable by address (`#/legacy/intake` and friends)
 * and mounted from `mvp/MvpSurface.tsx`, so every existing spec keeps driving the page it was
 * written for. What changed is that no owner reaches them by clicking.
 *
 * Routing is by `location.hash` (`mvp/navigation.ts`). The previous shell held the current section in
 * component state, which meant a reload after `Request -> Contract` landed on Intake with the
 * contract unreached, and it meant a surface the specs needed could only be reached through the very
 * navigation the MVP is removing.
 *
 * The signed-out branch returns before any private view is created, and signing out clears the
 * owner, the project context and the CSRF token together, so a client that has lost its session is
 * not left holding the previous owner's cached facts from which it might appear to authorize
 * delivery. Nothing about the previous session survives in this component's state: the pages that
 * held it are unmounted, not hidden.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { SignInPage } from './pages/SignInPage.tsx';
import { ConnectionBanner } from './components/ConnectionBanner.tsx';
import { SessionProvider, useSession } from './session.tsx';
import { PRIMARY_SURFACES, isPrimary, parseRoute, routeHash, type Route } from './mvp/navigation.ts';
import { Surface } from './mvp/MvpSurface.tsx';

/**
 * The current address, as state the shell re-renders on.
 *
 * `hashchange` rather than a router package: there are nine possible destinations and no nested
 * layouts, and a dependency that cannot be inspected in twenty lines is not worth the risk of a
 * client that navigates somewhere the owner did not ask for.
 */
function useRoute(): [Route, (hash: string) => void] {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(typeof window === 'undefined' ? '' : window.location.hash),
  );

  useEffect(() => {
    const onHashChange = (): void => {
      setRoute(parseRoute(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((hash: string): void => {
    if (window.location.hash === hash) {
      // Same address, so no `hashchange` fires and the view would not update. Re-setting the route
      // is what makes a repeated navigation a no-op rather than a silent failure.
      setRoute(parseRoute(hash));
      return;
    }
    window.location.hash = hash;
  }, []);

  return [route, navigate];
}

function Shell(): ReactElement {
  const { status, owner, selectedProjectId, selectProject, projects, reloadProjects, connection, connectionEpoch, signOut, retry } =
    useSession();
  const [route, navigate] = useRoute();
  const [signingOut, setSigningOut] = useState(false);

  /**
   * The selections the retired surfaces share.
   *
   * Held here rather than inside any one of them, for the reason it has always been here: intake,
   * brief, plan and publication are four views of one captured request, and a run and its review
   * card are two views of one run. A per-page selection would let publication act on a plan the
   * plan surface is not showing.
   */
  const [legacyIdeaId, setLegacyIdeaId] = useState('');
  const [legacyProfileId, setLegacyProfileId] = useState('');
  const [legacyProfileLabel, setLegacyProfileLabel] = useState('');
  const [legacyJobId, setLegacyJobId] = useState('');
  const [legacyPlanId, setLegacyPlanId] = useState('');

  const selectProfile = useCallback((profileId: string, label: string): void => {
    setLegacyProfileId(profileId);
    setLegacyProfileLabel(label);
  }, []);

  if (status === 'checking') {
    return (
      <main className="page page--narrow" id="main">
        <h1 className="page__title">ShipLoop</h1>
        <p className="state-line" role="status" aria-live="polite" data-state="loading">
          Checking your session…
        </p>
      </main>
    );
  }

  if (status === 'signed-out' || owner === null) {
    return <SignInPage />;
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="app__header">
        <div className="app__identity">
          <h1 className="app__title">ShipLoop</h1>
          <p className="app__owner">
            Signed in as {owner.displayName}
            {owner.email === null ? ' (this owner has no sign-in address)' : ` (${owner.email})`}
          </p>
        </div>
        <div className="project-selector">
          <label className="project-selector__label" htmlFor="project-select">
            Project
          </label>
          <select
            id="project-select"
            className="project-selector__select"
            data-testid="project-select"
            value={selectedProjectId ?? ''}
            onChange={(event) => selectProject(event.target.value === '' ? null : event.target.value)}
          >
            {/* The empty option is a real state, not a placeholder: it is what "no project is
                selected" means, and it is the state a signed-in owner with no project is in. */}
            <option value="">No project selected</option>
            {projects.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {project.name} ({project.projectId})
              </option>
            ))}
          </select>
        </div>
        <button
          className="button button--secondary"
          type="button"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            void signOut().then(() => setSigningOut(false));
          }}
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </header>

      <ConnectionBanner connection={connection} onRetry={retry} />

      <nav className="app__nav" aria-label="Owner sections">
        <ul className="app__nav-list">
          {PRIMARY_SURFACES.map((entry) => (
            <li key={entry.id}>
              <button
                className="button button--tab"
                type="button"
                aria-current={isPrimary(route, entry.id) ? 'page' : undefined}
                data-testid={`nav-${entry.id}`}
                onClick={() => navigate(routeHash(parseRoute(`#/${entry.id}`)))}
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="app__main" id="main">
        <Surface
          route={route}
          projectId={selectedProjectId}
          epoch={connectionEpoch}
          navigate={navigate}
          projects={projects}
          selectProject={selectProject}
          reloadProjects={reloadProjects}
          legacySelection={{
            ideaId: legacyIdeaId,
            profileId: legacyProfileId,
            profileLabel: legacyProfileLabel,
            jobId: legacyJobId,
            planId: legacyPlanId,
            setIdeaId: setLegacyIdeaId,
            setProfile: selectProfile,
            setJobId: setLegacyJobId,
            setPlanId: setLegacyPlanId,
          }}
        />
      </main>
    </>
  );
}

export function App(): ReactElement {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}