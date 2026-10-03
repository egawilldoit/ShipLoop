import { useState, type FormEvent, type ReactElement } from 'react';
import { createProject, type ProjectSummary } from './api-client.ts';
import { ConnectionBanner } from './components/ConnectionBanner.tsx';
import { BriefPage } from './pages/BriefPage.tsx';
import { ConnectorsPage } from './pages/ConnectorsPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { IntakePage } from './pages/IntakePage.tsx';
import { PlanPage } from './pages/PlanPage.tsx';
import { ProfilesPage } from './pages/ProfilesPage.tsx';
import { PublicationPage } from './pages/PublicationPage.tsx';
import { ReviewCardPage } from './pages/ReviewCardPage.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { SignInPage } from './pages/SignInPage.tsx';
import { SessionProvider, useSession } from './session.tsx';

type Section =
  | 'profiles'
  | 'connectors'
  | 'intake'
  | 'brief'
  | 'runs'
  | 'review'
  | 'dashboard'
  | 'plan'
  | 'publication';

const SECTIONS: readonly { readonly id: Section; readonly label: string }[] = [
  { id: 'profiles', label: 'Profiles' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'intake', label: 'Intake' },
  { id: 'brief', label: 'Brief' },
  { id: 'runs', label: 'Runs' },
  { id: 'review', label: 'Review card' },
  { id: 'dashboard', label: 'Needs you' },
  { id: 'plan', label: 'Plan' },
  { id: 'publication', label: 'Publication' },
];

/**
 * Which project every project-scoped screen addresses (F02-AC1).
 *
 * This component exists because project identity was previously absent rather than chosen.
 * The session response carried no project, the pages took an empty string, and every request
 * they built from it went to `/api/profiles/undefined` — a project literally named
 * "undefined" — which answered 404 and was reported as "that project has no saved profile
 * yet". A selector plus an explicit "no project selected" state means a page either has a
 * project to ask about or says it has none, and neither case is a request for a name that
 * does not exist (F02-AC1, F02-AC4).
 *
 * Creation is offered here because it is the only project write that needs no configured
 * provider: a profile save, a connector registration and a procedure append all refuse by
 * name when no adapter declares the capability they need, so an owner who has configured
 * nothing would otherwise have no project to select at all (F03-AC2).
 */
function ProjectSelector({
  projects,
  selectedProjectId,
  onSelect,
  onCreated,
}: {
  readonly projects: readonly ProjectSummary[];
  readonly selectedProjectId: string | null;
  readonly onSelect: (projectId: string | null) => void;
  readonly onCreated: () => void;
}): ReactElement {
  const [creating, setCreating] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (saving) return;
    if (projectId.trim() === '') {
      setError('A project needs an id. It is the name every request for that project uses.');
      return;
    }
    if (name.trim() === '') {
      setError('A project needs a name, so the selector does not offer the owner a bare id.');
      return;
    }
    setSaving(true);
    setError(null);
    void createProject({ projectId: projectId.trim(), name: name.trim() }).then((result) => {
      setSaving(false);
      if (!result.ok) {
        setError(result.error.reason);
        return;
      }
      setProjectId('');
      setName('');
      setCreating(false);
      onCreated();
      onSelect(result.value.project.projectId);
    });
  };

  return (
    <div className="project-selector">
      <label className="project-selector__label" htmlFor="project-select">
        Project
      </label>
      <select
        id="project-select"
        className="project-selector__select"
        value={selectedProjectId ?? ''}
        onChange={(event) => onSelect(event.target.value === '' ? null : event.target.value)}
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
      {creating ? (
        <form className="project-selector__form" onSubmit={submit} noValidate>
          <label className="project-selector__label" htmlFor="project-id">
            Project id
          </label>
          <input
            id="project-id"
            className="project-selector__input"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            placeholder="one-word-id, no slashes"
            disabled={saving}
          />
          <label className="project-selector__label" htmlFor="project-name">
            Project name
          </label>
          <input
            id="project-name"
            className="project-selector__input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="What this project is called"
            disabled={saving}
          />
          {error !== null && (
            <p className="state-line state-line--error" role="alert" data-state="failed">
              {error}
            </p>
          )}
          <div className="project-selector__actions">
            <button className="button" type="submit" disabled={saving}>
              {saving ? 'Creating…' : 'Create project'}
            </button>
            <button
              className="button button--secondary"
              type="button"
              disabled={saving}
              onClick={() => {
                setCreating(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          className="button button--secondary"
          type="button"
          onClick={() => {
            setCreating(true);
            setError(null);
          }}
        >
          New project
        </button>
      )}
    </div>
  );
}

function Shell(): ReactElement {
  const {
    status,
    owner,
    selectedProjectId,
    selectProject,
    projects,
    reloadProjects,
    connection,
    connectionEpoch,
    signOut,
    retry,
  } = useSession();
  const [section, setSection] = useState<Section>('intake');
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
          </p>
        </div>
        <ProjectSelector
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelect={selectProject}
          onCreated={reloadProjects}
        />
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
          {SECTIONS.map((entry) => (
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
        {section === 'profiles' ? (
          <ProfilesPage
            projectId={selectedProjectId}
            activeProfileId={activeProfileId}
            onSelectProfile={selectProfile}
            epoch={connectionEpoch}
          />
        ) : section === 'connectors' ? (
          <ConnectorsPage
            projectId={selectedProjectId}
            profileId={activeProfileId}
            profileName={activeProfileLabel}
            epoch={connectionEpoch}
          />
        ) : section === 'intake' ? (
          <IntakePage
            selectedIdeaId={activeIdeaId}
            selectedProjectId={selectedProjectId}
            onSelectIdea={setActiveIdeaId}
            onOpenBrief={(ideaId) => {
              setActiveIdeaId(ideaId);
              setSection('brief');
            }}
            epoch={connectionEpoch}
          />
        ) : section === 'runs' ? (
          <RunPage
            selectedJobId={activeJobId}
            onSelectJob={setActiveJobId}
            onOpenReviewCard={(jobId) => {
              setActiveJobId(jobId);
              setSection('review');
            }}
            epoch={connectionEpoch}
          />
        ) : section === 'review' ? (
          <ReviewCardPage
            jobId={activeJobId}
            onBackToRuns={() => setSection('runs')}
            epoch={connectionEpoch}
          />
        ) : section === 'dashboard' ? (
          <DashboardPage epoch={connectionEpoch} />
        ) : section === 'brief' ? (
          <BriefPage
            ideaId={activeIdeaId}
            onBackToIntake={() => setSection('intake')}
            epoch={connectionEpoch}
          />
        ) : section === 'plan' ? (
          <PlanPage
            ideaId={activeIdeaId}
            onOpenPublication={(planId) => {
              setActivePlanId(planId);
              setSection('publication');
            }}
            epoch={connectionEpoch}
          />
        ) : (
          <PublicationPage
            planId={activePlanId}
            ideaId={activeIdeaId}
            projectId={selectedProjectId}
            onBackToPlan={() => setSection('plan')}
            epoch={connectionEpoch}
          />
        )}
      </main>
    </>
  );
}

/**
 * The owner shell.
 *
 * The signed-out branch returns before any private view is created, and signing out clears
 * the owner, the project context and the CSRF token together, so a client that has lost its
 * session is not left holding the previous owner's cached facts from which it might appear
 * to authorize delivery (F01-AC5). Nothing about the previous session survives in this
 * component's state: the pages that held it are unmounted, not hidden.
 */
export function App(): ReactElement {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}
