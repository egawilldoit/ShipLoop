import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  fetchProjects,
  fetchSession,
  getConnectionState,
  setCsrfToken,
  signIn as signInRequest,
  signOut as signOutRequest,
  subscribeToConnection,
  type ApiFailure,
  type ConnectionState,
  type OwnerIdentity,
  type ProjectSummary,
  type SignInRequest,
} from './api-client.ts';

export type SessionStatus = 'checking' | 'signed-out' | 'signed-in';

export interface SessionContextValue {
  readonly status: SessionStatus;
  readonly owner: OwnerIdentity | null;
  /**
   * The project the owner selected, or null when none is selected (F02-AC1).
   *
   * Nullable and explicit rather than a string that is empty when nothing is chosen. The
   * empty string is what this used to be, and every project-scoped page built its request path
   * from it, so an unselected project produced `/api/profiles/undefined` — a request for a
   * project literally named "undefined", whose 404 the page then reported as "that project has
   * no saved profile yet". A distinct null state cannot be interpolated into a path (F02-AC1,
   * F02-AC4).
   */
  readonly selectedProjectId: string | null;
  readonly selectProject: (projectId: string | null) => void;
  readonly projects: readonly ProjectSummary[];
  readonly reloadProjects: () => void;
  readonly connection: ConnectionState;
  /** Bumped by the retry control so every mounted page refetches without prop-drilling. */
  readonly connectionEpoch: number;
  /** Resolves with null on success, or the failure to render beside the form. */
  readonly signIn: (credentials: SignInRequest) => Promise<ApiFailure | null>;
  readonly signOut: () => Promise<void>;
  readonly retry: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Holds the owner identity, the CSRF token and the transport health the app shell needs.
 *
 * It is the single place private state lives. Signing out clears the owner, the project
 * context and the CSRF token before the shell returns to sign-in, so a disconnected or
 * signed-out client has nothing cached that could authorize anything (F01-AC5, F01-AC2).
 * Keeping the CSRF token here, rather than in each page, is what makes that clearing
 * complete rather than best-effort.
 */
export function SessionProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<SessionStatus>('checking');
  const [owner, setOwner] = useState<OwnerIdentity | null>(null);
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectsEpoch, setProjectsEpoch] = useState(0);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const connection = useSyncExternalStore(subscribeToConnection, getConnectionState, getConnectionState);

  const adoptSession = useCallback((session: { owner: OwnerIdentity; csrfToken: string }): void => {
    setCsrfToken(session.csrfToken);
    setOwner(session.owner);
    setStatus('signed-in');
    // The project list is fetched after the session is adopted rather than read off it, so
    // what the selector offers is the store's answer at this moment (F02-AC1).
    setProjectsEpoch((previous) => previous + 1);
  }, []);

  useEffect(() => {
    let current = true;
    void fetchSession().then((result) => {
      if (!current) return;
      if (result.ok) {
        adoptSession(result.value);
      } else {
        setStatus('signed-out');
      }
    });
    return () => {
      current = false;
    };
  }, [adoptSession]);

  /**
   * The project list, refetched whenever the owner signs in or creates a project.
   *
   * A selection that names a project the list no longer holds is cleared rather than kept, so
   * a page cannot address a project the owner cannot see selected (F02-AC1).
   */
  useEffect(() => {
    if (status !== 'signed-in') return;
    let current = true;
    void fetchProjects().then((result) => {
      if (!current || !result.ok) return;
      setProjects(result.value.projects);
      setSelectedProjectId((previous) =>
        previous !== null && result.value.projects.some((project) => project.projectId === previous)
          ? previous
          : null,
      );
    });
    return () => {
      current = false;
    };
  }, [status, projectsEpoch]);

  const selectProject = useCallback((projectId: string | null): void => {
    setSelectedProjectId(projectId);
  }, []);

  const reloadProjects = useCallback((): void => {
    setProjectsEpoch((previous) => previous + 1);
  }, []);

  const signIn = useCallback(
    async (credentials: SignInRequest): Promise<ApiFailure | null> => {
      const result = await signInRequest(credentials);
      if (!result.ok) return result.error;
      adoptSession(result.value);
      return null;
    },
    [adoptSession],
  );

  const signOut = useCallback(async (): Promise<void> => {
    await signOutRequest();
    setCsrfToken(null);
    setOwner(null);
    // Projects and the selection are cleared with the session. A signed-out client that kept
    // the project list would be holding one owner's workspace facts in memory after the
    // session that authorized reading them is gone (F01-AC2, F01-AC5).
    setProjects([]);
    setSelectedProjectId(null);
    setStatus('signed-out');
  }, []);

  const retry = useCallback((): void => {
    setConnectionEpoch((previous) => previous + 1);
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      owner,
      selectedProjectId,
      selectProject,
      projects,
      reloadProjects,
      connection,
      connectionEpoch,
      signIn,
      signOut,
      retry,
    }),
    [status, owner, selectedProjectId, selectProject, projects, reloadProjects, connection, connectionEpoch, signIn, signOut, retry],
  );

  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside a SessionProvider.');
  return value;
}
