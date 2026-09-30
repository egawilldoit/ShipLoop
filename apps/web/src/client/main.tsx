/**
 * The client entry point Vite builds.
 *
 * `src/ui/**` is owned by another agent and may not exist on the branch this file is
 * built from, so the real UI is loaded through `import.meta.glob`. A glob that
 * matches nothing compiles to an empty object rather than a build error, which is
 * what makes this entry resilient: when the owner UI is present it is loaded and it
 * owns mounting, and when it is absent this file mounts a minimal placeholder shell
 * that still speaks to the real API over the same origin.
 *
 * The placeholder is deliberately not a UI. It exists so the shell, the responsive
 * layout and the disconnected state are demonstrable on a branch where the product
 * screens have not landed yet, and it exposes the same `role`/`data-connected`
 * contract the real banner exposes so a test written against one holds against the
 * other.
 */

import { StrictMode, useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

/** The subset of Vite's `import.meta.glob` this entry uses, without `vite/client` types. */
type GlobModules = (pattern: string) => Record<string, () => Promise<unknown>>;

const uiEntryModules = (import.meta as ImportMeta & { glob: GlobModules }).glob('../ui/main.tsx');

/** Probed so the shell has a real round trip whose failure is visible. */
const HEALTH_ENDPOINT = '/api/health';

type ConnectionState = 'checking' | 'connected' | 'disconnected';

const STATE_LABEL: Record<ConnectionState, string> = {
  checking: 'Checking',
  connected: 'Connected',
  disconnected: 'Disconnected',
};

function PlaceholderShell(): ReactElement {
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const check = async (): Promise<void> => {
      try {
        const response = await fetch(HEALTH_ENDPOINT, {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (!current) return;
        // Only a successful round trip advances the timestamp: claiming a recent update
        // after a failure is the exact lie this state exists to avoid.
        if (response.ok) setCheckedAt(new Date().toISOString());
        setConnection(response.ok ? 'connected' : 'disconnected');
      } catch {
        if (!current) return;
        setConnection('disconnected');
      }
    };
    void check();
    return () => {
      current = false;
    };
  }, []);

  return (
    <StrictMode>
      <section
        className="shiploop-shell"
        role="status"
        aria-live="polite"
        data-connected={connection === 'disconnected' ? 'false' : 'true'}
      >
        <h1>ShipLoop</h1>
        <p>
          <strong className="shiploop-shell__state">{STATE_LABEL[connection]}</strong>
          {connection === 'connected' ? '. The server responded.' : connection === 'disconnected' ? '. A request failed.' : '.'}
        </p>
        <p>The owner screens in src/ui are not built on this branch; this is the placeholder shell.</p>
        <p>
          Last check:{' '}
          {checkedAt === null ? (
            'no successful update has been received yet.'
          ) : (
            <time dateTime={checkedAt}>{checkedAt}</time>
          )}
        </p>
      </section>
    </StrictMode>
  );
}

async function start(): Promise<void> {
  const container = document.getElementById('root');
  if (container === null) {
    throw new Error('ShipLoop client could not start: index.html has no element with id "root" to mount into.');
  }
  const loadRealUi = Object.values(uiEntryModules)[0];
  if (loadRealUi !== undefined) {
    await loadRealUi();
    return;
  }
  createRoot(container).render(<PlaceholderShell />);
}

void start();