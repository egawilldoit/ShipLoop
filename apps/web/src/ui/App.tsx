/**
 * The owner shell: identity, navigation, and the one place a surface is chosen.
 *
 * Four things this component decides, and the reason each is here rather than on a page:
 *
 *   - **Which project every screen addresses** (F02-AC1). It comes from
 *     `session.owner.activeProject`, read through `mvp-client.ts`, and it is either a project
 *     this deployment holds or the explicit `NoProjectSelected` state. When it is the latter,
 *     the shell renders an onboarding screen *instead of* the requested surface, because all
 *     four primary surfaces are project-scoped: there is nothing truthful to render without a
 *     project, and rendering something anyway is how this product once ended up asking about
 *     a project named `undefined` and reporting the server's honest 404 as "that project has
 *     no saved profile yet" (F02-AC4).
 *   - **The four primary surfaces**: Home, New Request, Review, Settings. Home is the default,
 *     because the first question after signing in is what needs the owner, and that is a
 *     reading rather than a configuration task.
 *   - **Where the advanced screens went.** Profiles, Connectors, Brief, Runs, the old
 *     Needs-you board, Plan and Publication are working screens that the MVP cut takes out of
 *     the primary path. They are *hidden*, not deleted: each keeps its own label and its own
 *     routes, and they stay reachable below the primary row so nothing that works becomes
 *     unreachable. This is the escape hatch the MVP promised them.
 *   - **The states that are not pages.** A signed-out client gets sign-in; a client that
 *     cannot read its session gets the server's own reason and a re-read, which is a different
 *     thing from a session that ended and must not borrow its wording (N03-AC1).
 */

import { useState, type ReactElement } from 'react';
import { ConnectionBanner } from './components/ConnectionBanner.tsx';
import { ProjectSelector } from './components/ProjectSelector.tsx';
import { DEFAULT_SURFACE, LEGACY_SURFACES, PRIMARY_SURFACES, type PrimarySurfaceId, type SurfaceId } from './navigation.ts';
import { BriefPage } from './pages/BriefPage.tsx';
import { ConnectorsPage } from './pages/ConnectorsPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { IntakePage } from './pages/IntakePage.tsx';
import { PlanPage } from './pages/PlanPage.tsx';
import { NoProjectState, SettingsSurface } from './pages/ProjectContext.tsx';
import { ProfilesPage } from './pages/ProfilesPage.tsx';
import { PublicationPage } from './pages/PublicationPage.tsx';
import { ReviewCardPage } from './pages/ReviewCardPage.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { SignInPage } from './pages/SignInPage.tsx';
import { SessionProvider, useSession } from './session.tsx';

const PRIMARY_IDS: ReadonlySet<string> = new Set(PRIMARY_SURFACES.map((surface) => surface.id));

/** Whether a surface is one of the four the MVP path offers. */
function isPrimary(surface: SurfaceId): boolean {
  return PRIMARY_IDS.has(surface);
}

function Shell(): ReactElement {
  const {
    status,
    owner,
    activeProject,
    selectedProjectId,
    selectedProjectName,
    selectProject,
    projects,
    reloadProjects,
    sessionFailure,
    connection,
    connectionEpoch,
    reloadSession,
    signOut,
    retry,
  } = useSession();
  const [surface, setSurface] = useState<SurfaceId>(DEFAULT_SURFACE);
  const [activeProfileId, setActiveProfileId] = useState('');
  const [activeProfileLabel, setActiveProfileLabel] = useState('');
  const [activeIdeaId, setActiveIdeaId] = useState('');
  const [activeJobId, setActiveJobId] = useState('');
  /**
   * The plan the plan and publication screens are looking at.
   *
   * Held here rather than in either page because the two are two views of one plan, in
   * the same way the intake and brief screens are two views of one captured request: a
   * per-page selection would let publication act on a plan the plan screen is not
   * showing, which is exactly the case where an owner creates an issue at a provider
   * for work they were not reviewing (F10-AC1).
   */
  const [activePlanId, setActivePlanId] = useState('');
  const [signingOut, setSigningOut] = useState(false);

  const selectProfile = (profileId: string, label: string): void => {
    setActiveProfileId(profileId);
    setActiveProfileLabel(label);
  };

  /**
   * Navigate to a primary surface, from anywhere in the shell.
   *
   * A single function so a page's own call to action ("Go to Review") and the navigation row
   * move the same state, and so the destination is one value rather than a set of booleans a
   * page has to keep in step with the nav.
   */
  const goTo = (destination: PrimarySurfaceId): void => {
    setSurface(destination);
  };

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

  // Deliberately not the sign-in screen and not a blank page. A client that cannot read its
  // session is signed in or signed out so far as every private page is concerned, and it does
  // not know which; answering with the sign-in form would ask for a password the owner may not
  // need, and answering with a board would be a claim about a project this client cannot name
  // (F01-AC2).
  if (status === 'unreachable') {
    return (
      <main className="page page--narrow" id="main">
        <h1 className="page__title">ShipLoop</h1>
        <p className="state-line state-line--warn" role="alert" data-state="disconnected">
          {sessionFailure?.reason ?? 'This browser has not been able to read your session.'} No request has been sent
          for a project this client cannot name, and nothing you entered has been lost.
        </p>
        <div className="form__actions">
          <button className="button" type="button" onClick={reloadSession}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  // Every primary surface is project-scoped, so "no project" is answered by the onboarding
  // screen rather than by each surface inventing an answer for itself. The legacy screens are
  // left alone: they were written to receive a null project and to say they have none, which is
  // the same statement without a second implementation of it.
  const blockedByProject = isPrimary(surface) && activeProject === null;

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="app__header">
        <div className="app__identity">
          <h1 className="app__title">ShipLoop</h1>
          {/*
            The address is rendered from what the server sent, and its absence is stated
            rather than rendered as an empty pair of parentheses. The header used to show
            `Signed in as <name> () for ` because the session response carried no address and
            this template interpolated one anyway, so a missing fact read as a rendering fault
            in a field the owner had never filled in (F01-AC1).
          */}
          <p className="app__owner">
            Signed in as {owner.displayName}
            {owner.email === null ? ' (this owner has no sign-in address)' : ` (${owner.email})`}
            {selectedProjectName === null
              ? ' (this session has no project selected)'
              : ` · in project ${selectedProjectName} (${selectedProjectId ?? ''})`}
          </p>
        </div>
        {/*
          Rendered only when a project is actually selected. With none selected the onboarding
          screen owns the choice, and two selectors offering the same choice would be one too
          many controls answering one question.
        */}
        {activeProject !== null && activeProject.state === 'Selected' ? (
          <ProjectSelector
            projects={projects}
            activeProject={activeProject}
            onSelect={selectProject}
            onCreated={reloadProjects}
            idPrefix="header"
          />
        ) : null}
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

      <nav className="app__nav" aria-label="Primary">
        <ul className="app__nav-list">
          {PRIMARY_SURFACES.map((entry) => (
            <li key={entry.id}>
              <button
                className="button button--tab"
                type="button"
                aria-current={surface === entry.id ? 'page' : undefined}
                onClick={() => setSurface(entry.id)}
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/*
        The advanced screens, kept reachable and kept out of the primary path. Each label is the
        one the screen's own heading uses, so a browser test or a runbook that names them still
        finds them; the row says plainly that it is not part of the MVP so nobody reads it as
        one of the four.
      */}
      <nav className="app__nav app__nav--legacy" aria-label="Advanced, outside the MVP path">
        <p className="panel__note">Advanced screens, outside the MVP path. They still work and still read the same server routes.</p>
        <ul className="app__nav-list">
          {LEGACY_SURFACES.map((entry) => (
            <li key={entry.id}>
              <button
                className="button button--tab button--secondary"
                type="button"
                aria-current={surface === entry.id ? 'page' : undefined}
                onClick={() => setSurface(entry.id)}
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/*
        Intake, brief, plan and publication share one selected request and one selected
        plan rather than each holding their own copies: they are four views of one
        captured request moving towards a ticket, and a per-page selection would let the
        publication screen act on a plan the plan screen is not showing (F10-AC1).
        The run and its review card share one selected run for the same reason: a card is
        evidence about a run, and a card for a different run than the one on screen would
        be a card about nothing (F24-AC2).
      */}
      <main className="app__main" id="main">
        {blockedByProject ? (
          <NoProjectState
            activeProject={activeProject}
            projects={projects}
            onSelect={selectProject}
            onCreated={reloadProjects}
            onReload={reloadSession}
          />
        ) : surface === 'home' && activeProject?.state === 'Selected' ? (
          <HomePage
            projectId={activeProject.activeProjectId}
            projectName={activeProject.activeProjectName}
            epoch={connectionEpoch}
            onReload={retry}
            onNavigate={goTo}
          />
        ) : surface === 'new-request' ? (
          <IntakePage
            selectedIdeaId={activeIdeaId}
            selectedProjectId={selectedProjectId}
            onSelectIdea={setActiveIdeaId}
            onOpenBrief={(ideaId) => {
              setActiveIdeaId(ideaId);
              setSurface('brief');
            }}
            epoch={connectionEpoch}
          />
        ) : surface === 'review' ? (
          <ReviewCardPage jobId={activeJobId} onBackToRuns={() => setSurface('runs')} epoch={connectionEpoch} />
        ) : surface === 'settings' && activeProject?.state === 'Selected' ? (
          <SettingsSurface
            activeProject={activeProject}
            projects={projects}
            onSelect={selectProject}
            onCreated={reloadProjects}
          />
        ) : surface === 'profiles' ? (
          <ProfilesPage
            projectId={selectedProjectId}
            activeProfileId={activeProfileId}
            onSelectProfile={selectProfile}
            epoch={connectionEpoch}
          />
        ) : surface === 'connectors' ? (
          <ConnectorsPage
            projectId={selectedProjectId}
            profileId={activeProfileId}
            profileName={activeProfileLabel}
            epoch={connectionEpoch}
          />
        ) : surface === 'brief' ? (
          <BriefPage
            ideaId={activeIdeaId}
            onBackToIntake={() => setSurface('new-request')}
            epoch={connectionEpoch}
          />
        ) : surface === 'runs' ? (
          <RunPage
            selectedJobId={activeJobId}
            onSelectJob={setActiveJobId}
            onOpenReviewCard={(jobId) => {
              setActiveJobId(jobId);
              setSurface('review');
            }}
            epoch={connectionEpoch}
          />
        ) : surface === 'dashboard' ? (
          <DashboardPage epoch={connectionEpoch} />
        ) : surface === 'plan' ? (
          <PlanPage
            ideaId={activeIdeaId}
            onOpenPublication={(planId) => {
              setActivePlanId(planId);
              setSurface('publication');
            }}
            epoch={connectionEpoch}
          />
        ) : surface === 'publication' ? (
          <PublicationPage
            planId={activePlanId}
            ideaId={activeIdeaId}
            projectId={selectedProjectId}
            onBackToPlan={() => setSurface('plan')}
            epoch={connectionEpoch}
          />
        ) : (
          <section className="page page--narrow" aria-labelledby="no-surface-title">
            <h2 className="page__title" id="no-surface-title">
              This screen is not written yet
            </h2>
            <p className="state-line state-line--warn" role="status" data-state="unwritten">
              Nothing is shown for this screen because it has no page in this build. Nothing has been sent to the
              server and nothing has been recorded.
            </p>
          </section>
        )}
      </main>
    </>
  );
}

/**
 * The owner shell.
 *
 * The signed-out branch returns before any private view is created, and signing out clears the
 * owner, the project context and the CSRF token together, so a client that has lost its session
 * is not left holding the previous owner's cached facts from which it might appear to
 * authorize delivery (F01-AC5). Nothing about the previous session survives in this component's
 * state: the pages that held it are unmounted, not hidden.
 *
 * The final branch states that a surface has no screen, rather than falling back to another
 * screen. Every `SurfaceId` is named above, so it is unreachable in practice; it exists because
 * a surface added to `navigation.ts` without a branch here would otherwise leave the owner
 * staring at an empty main region, which reads as a page that failed to load rather than as one
 * that was never written. Answering with the sign-in form would be worse than an empty region:
 * it would tell a signed-in owner that their session ended.
 */
export function App(): ReactElement {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}