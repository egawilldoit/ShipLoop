import { useState, type ReactElement } from 'react';
import { ConnectionBanner } from './components/ConnectionBanner.tsx';
import { BriefPage } from './pages/BriefPage.tsx';
import { ConnectorsPage } from './pages/ConnectorsPage.tsx';
import { IntakePage } from './pages/IntakePage.tsx';
import { ProfilesPage } from './pages/ProfilesPage.tsx';
import { SignInPage } from './pages/SignInPage.tsx';
import { SessionProvider, useSession } from './session.tsx';

type Section = 'profiles' | 'connectors' | 'intake' | 'brief';

const SECTIONS: readonly { readonly id: Section; readonly label: string }[] = [
  { id: 'profiles', label: 'Profiles' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'intake', label: 'Intake' },
  { id: 'brief', label: 'Brief' },
];

function Shell(): ReactElement {
  const { status, owner, projectId, projectName, connection, connectionEpoch, signOut, retry } = useSession();
  const [section, setSection] = useState<Section>('intake');
  const [activeProfileId, setActiveProfileId] = useState('');
  const [activeProfileLabel, setActiveProfileLabel] = useState('');
  const [activeIdeaId, setActiveIdeaId] = useState('');
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
          <p className="app__owner">
            Signed in as {owner.displayName} ({owner.email}) for {projectName}
          </p>
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
        Intake and the brief share one selected request rather than each holding their
        own copy of it: the two screens are two views of one captured request, and a
        per-page selection would let the brief describe a different request than the
        intake screen is showing.
      */}
      <main className="app__main" id="main">
        {section === 'profiles' ? (
          <ProfilesPage
            projectId={projectId}
            activeProfileId={activeProfileId}
            onSelectProfile={selectProfile}
            epoch={connectionEpoch}
          />
        ) : section === 'connectors' ? (
          <ConnectorsPage
            projectId={projectId}
            profileId={activeProfileId}
            profileName={activeProfileLabel}
            epoch={connectionEpoch}
          />
        ) : section === 'intake' ? (
          <IntakePage
            selectedIdeaId={activeIdeaId}
            onSelectIdea={setActiveIdeaId}
            onOpenBrief={(ideaId) => {
              setActiveIdeaId(ideaId);
              setSection('brief');
            }}
            epoch={connectionEpoch}
          />
        ) : (
          <BriefPage
            ideaId={activeIdeaId}
            onBackToIntake={() => setSection('intake')}
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
