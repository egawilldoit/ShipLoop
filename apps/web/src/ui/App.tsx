/**
 * The owner shell: four primary areas, one project, one transport.
 *
 * ## Why this is four sections and not nine
 *
 * The shell this replaces offered Profiles, Connectors, Intake, Brief, Runs, Review card, Needs
 * you, Plan and Publication. Eight of those nine are surfaces for orchestrating a coding agent:
 * starting runs, watching them, publishing plans. ShipLoop's product contract puts coding
 * execution outside the product, so an owner looking at "Runs" would be looking at a console for a
 * system ShipLoop does not claim to run and cannot report on truthfully. The remaining area —
 * reviewing what came back — is the product.
 *
 * So the primary navigation is exactly four areas, and Home is where it starts. The legacy pages
 * are **not deleted**: they are proven subsystems and the orchestration path still exists behind
 * them. They are simply no longer what the owner is shown by default, because the product decision
 * was that the primary experience should read as a delivery and attention surface rather than an
 * agent console (mvp-spec 3).
 *
 * ## What the shell decides
 *
 * Only two things: which project is active, and which of the four areas is showing. Every product
 * judgement — is this eligible, what does this evidence mean, may this be accepted — belongs to
 * the backend, and each area below reflects those answers rather than recomputing them (F24-AC3).
 */

import { useState, type ReactElement } from 'react';

import { ConnectionBanner } from './components/ConnectionBanner.tsx';
import { DEFAULT_SECTION, PRIMARY_SECTIONS, type PrimarySection } from './navigation.ts';
import { HomeScreen } from './mvp/HomeScreen.tsx';
import type { HomeTarget } from './mvp/home-model.ts';
import { SettingsScreen } from './mvp/SettingsScreen.tsx';
import { NewRequestSlot, ReviewSlot } from './mvp/slots.tsx';
import { SignInPage } from './pages/SignInPage.tsx';
import { SessionProvider, useSession } from './session.tsx';


/**
 * Which project every project-scoped screen addresses.
 *
 * This exists because project identity must be *chosen*, not defaulted. The shell offers the
 * projects this owner actually has, and the "no project selected" state is a real state rather than
 * an invitation to guess: the historical defect was a request to `/api/profiles/undefined`, which
 * answered 404 and was reported as "that project has no saved profile yet" (F02-AC1, F02-AC4).
 */
function ProjectSelector({ onNewProject }: { readonly onNewProject: () => void }): ReactElement {
  const { scope, projects, selectProject } = useSession();

  return (
    <div className="project-selector">
      <label className="project-selector__label" htmlFor="project-select">
        Project
      </label>
      <select
        id="project-select"
        className="project-selector__select"
        value={scope?.kind === 'project' ? scope.projectId : ''}
        onChange={(event) => {
          void selectProject(event.target.value === '' ? null : event.target.value);
        }}
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
      {/* Creation lives in the New Request area, where a request belongs to a project. A create
          form here would be a second place that decides what a project is, and the two would
          disagree the moment one of them validated differently. This button therefore navigates
          rather than opening a second form — a control that changes nothing is worse than no
          control (F02-AC1). */}
      <button className="button button--secondary" type="button" onClick={onNewProject}>
        New project
      </button>
    </div>
  );
}

function Shell(): ReactElement {
  const { status, owner, scope, epoch, connection, signOut, retry, failure } = useSession();
  const [section, setSection] = useState<PrimarySection>(DEFAULT_SECTION);
  const [signingOut, setSigningOut] = useState(false);

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

  // "The server could not be reached" is not "you are signed out". Rendering the sign-in form for
  // an unreachable server tells an owner with a live session to sign in again, which is a false
  // statement about their own state and an action that cannot succeed (N03-AC3).
  if (status === 'unreachable') {
    return (
      <main className="page page--narrow" id="main">
        <h1 className="page__title">ShipLoop</h1>
        <p className="state-line state-line--error" role="alert" data-state="failed">
          {failure?.reason ?? 'The server could not be reached, so ShipLoop cannot tell whether you are signed in.'}
        </p>
        <button className="button" type="button" onClick={retry}>
          Try again
        </button>
      </main>
    );
  }

  if (status === 'signed-out' || owner === null) {
    return <SignInPage />;
  }

  const open = (target: HomeTarget): void => {
    setSection(target);
  };

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="app__header">
        <div className="app__identity">
          <h1 className="app__title">ShipLoop</h1>
          {/* The address is rendered from what the server sent, and its absence is stated rather
              than rendered as an empty pair of parentheses (F01-AC1). */}
          <p className="app__owner">
            Signed in as {owner.displayName}
            {owner.email === null ? ' (this owner has no sign-in address)' : ` (${owner.email})`}
          </p>
        </div>
        <ProjectSelector onNewProject={() => setSection('request')} />
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

      <nav className="app__nav" aria-label="Primary sections">
        <ul className="app__nav-list">
          {PRIMARY_SECTIONS.map((entry) => (
            <li key={entry.id}>
              <button
                className="button button--tab"
                type="button"
                aria-current={section === entry.id ? 'page' : undefined}
                onClick={() => setSection(entry.id)}
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="app__main" id="main">
        {section === 'home' ? (
          <HomeScreen scope={scope} epoch={epoch} onOpen={open} />
        ) : section === 'request' ? (
          <NewRequestSlot scope={scope} epoch={epoch} />
        ) : section === 'review' ? (
          <ReviewSlot scope={scope} epoch={epoch} />
        ) : (
          <SettingsScreen scope={scope} epoch={epoch} />
        )}
      </main>
    </>
  );
}

/**
 * The owner shell.
 *
 * The signed-out branch returns before any private view is created, and signing out clears the
 * owner, the project scope and the CSRF token together, so a client that has lost its session is
 * not left holding the previous owner's cached facts from which it might appear to authorize
 * delivery (F01-AC5).
 */
export function App(): ReactElement {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}