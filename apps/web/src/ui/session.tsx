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
import {
  readOwnerSession,
  selectActiveProject as selectActiveProjectRequest,
  setMvpCsrfToken,
  type ActiveProject,
  type MvpFailure,
  type OwnerSession,
} from './mvp-client.ts';

/**
 * `unreachable` is separate from `signed-out` on purpose.
 *
 * They ask opposite things of the owner. A refused session is finished and offers sign-in; an
 * unreachable server is not an answer about the session at all, and rendering sign-in there
 * would tell someone with a working session that they had been signed out by a network blip -
 * and invite them to type a password they did not need to type (F01-AC2, N03-AC1).
 */
export type SessionStatus = 'checking' | 'signed-out' | 'signed-in' | 'unreachable';

export interface SessionContextValue {
  readonly status: SessionStatus;
  /**
   * The signed-in owner's identity. Identity only: never a credential or a token (F01-AC1).
   *
   * Kept apart from `activeProject` rather than nested inside it because the two are adopted
   * from different places in one rare case - a sign-in whose follow-up session read failed -
   * and merging them would force that case to invent a project it never read (F02-AC1).
   */
  readonly owner: OwnerIdentity | null;
  /**
   * The project's current selection, or null while it has not been read.
   *
   * A union rather than a nullable string (F02-AC1). The empty string is what this used to be,
   * and every project-scoped page built its request path from it, so an unselected project
   * produced `/api/profiles/undefined` - a request for a project literally named "undefined",
   * whose 404 the page then reported as "that project has no saved profile yet". A distinct
   * null state cannot be interpolated into a path, and the `Selected` variant can only be
   * built by the controller from a project row this deployment holds.
   */
  readonly activeProject: ActiveProject | null;
  /** The selected project's id, or null. A reading of `activeProject` for pages that need one. */
  readonly selectedProjectId: string | null;
  /** The selected project's name, or null. Never derived from the id by this layer. */
  readonly selectedProjectName: string | null;
  /**
   * Chooses the project, on the server, and resolves with the refusal if there was one.
   *
   * A refusal resolves rather than throws and applies nothing, so a selector that asked for a
   * project the server would not grant keeps addressing the one it has. The write is
   * `PUT /api/owner/active-project` because a selection held only in the browser is a
   * selection the next page load does not have (F02-AC4).
   */
  readonly selectProject: (projectId: string) => Promise<MvpFailure | null>;
  readonly projects: readonly ProjectSummary[];
  readonly reloadProjects: () => void;
  /**
   * Why the session could not be read, while `status` is `unreachable`.
   *
   * Kept rather than folded into a boolean so the shell can tell a client that cannot reach the
   * server from one whose session the server would not describe. Both are "not signed in" as
   * far as every private page is concerned, and they ask the owner different things: check the
   * connection, or try again in a moment (N03-AC1).
   */
  readonly sessionFailure: MvpFailure | null;
  readonly connection: ConnectionState;
  /** Bumped by the retry control so every mounted page refetches without prop-drilling. */
  readonly connectionEpoch: number;
  /**
   * Re-reads the session itself, for the signed-out shell's own "try again" control.
   *
   * Separate from `retry` on purpose. `retry` re-reads whatever page is mounted, and a client
   * that cannot read its session has no page mounted to re-read; re-reading the session on
   * every page retry would also mean a single failed request threw the owner off the screen
   * they were working on.
   */
  readonly reloadSession: () => void;
  /** Resolves with null on success, or the failure to render beside the form. */
  readonly signIn: (credentials: SignInRequest) => Promise<ApiFailure | null>;
  readonly signOut: () => Promise<void>;
  readonly retry: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Holds the owner identity, the CSRF token, the current project and transport health.
 *
 * It is the single place private state lives, and the project selection is here rather than in
 * a component because a selection a component holds is a selection a reload does not have -
 * which is the defect this layer was written to close (F02-AC1, F02-AC4). Signing out clears
 * the owner, the project, the projects list and both request tokens together, so a
 * disconnected or signed-out client holds nothing that could authorize anything (F01-AC2,
 * F01-AC5).
 */
export function SessionProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<SessionStatus>('checking');
  const [owner, setOwner] = useState<OwnerIdentity | null>(null);
  const [activeProject, setActiveProject] = useState<ActiveProject | null>(null);
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [projectsEpoch, setProjectsEpoch] = useState(0);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [sessionFailure, setSessionFailure] = useState<MvpFailure | null>(null);
  const connection = useSyncExternalStore(subscribeToConnection, getConnectionState, getConnectionState);

  /**
   * Both tokens, from one session read.
   *
   * Two token holders exist because two clients exist: `api-client.ts` is the legacy
   * transport the advanced screens still call, and `mvp-client.ts` is the MVP transport.
   * Setting both here means a sign-out leaves neither able to authorize a request, which is
   * the property that matters (F01-AC5) - rather than whichever client happened to be
   * imported by the page that happened to be mounted.
   *
   * Identity and project are adopted together because the session route carries both, and
   * there is no reading of one that does not come with the other.
   */
  const adoptIdentity = useCallback((session: { readonly owner: OwnerIdentity; readonly csrfToken: string }): void => {
    setCsrfToken(session.csrfToken);
    setMvpCsrfToken(session.csrfToken);
    setOwner(session.owner);
    setStatus('signed-in');
    // The project list is fetched after the session is adopted rather than read off it, so
    // what the selector offers is the store's answer at this moment (F02-AC1).
    setProjectsEpoch((previous) => previous + 1);
  }, []);

  const adoptSession = useCallback(
    (session: OwnerSession): void => {
      adoptIdentity(session);
      setActiveProject(session.owner.activeProject);
    },
    [adoptIdentity],
  );

  /**
   * Adopts a session, or says why it could not.
   *
   * Only a refusal the server attributes to the session ends it. A transport failure and an
   * unreadable response leave the client `unreachable` with nothing adopted, which is a
   * different statement from "you are signed out" and gets different words on screen.
   */
  const adoptOrExplain = useCallback(
    (result: Awaited<ReturnType<typeof readOwnerSession>>): void => {
      if (result.ok) {
        setSessionFailure(null);
        adoptSession(result.value);
        return;
      }
      if (result.error.code === 'Refused' && result.error.serverCode === 'Unauthorized') {
        setSessionFailure(null);
        setStatus('signed-out');
        return;
      }
      // Anything else is the server or the network, not the session, and it is kept so the
      // shell can say which of the two it was instead of printing one generic sentence for
      // a disconnected client and a refusal alike (N03-AC1).
      setSessionFailure(result.error);
      setStatus('unreachable');
    },
    [adoptSession],
  );

  useEffect(() => {
    let current = true;
    void readOwnerSession().then((result) => {
      if (current) adoptOrExplain(result);
    });
    return () => {
      current = false;
    };
  }, [adoptOrExplain, sessionEpoch]);

  useEffect(() => {
    if (status !== 'signed-in') return;
    let current = true;
    void fetchProjects().then((result) => {
      if (!current || !result.ok) return;
      setProjects(result.value.projects);
    });
    return () => {
      current = false;
    };
  }, [status, projectsEpoch]);

  const selectProject = useCallback(async (projectId: string): Promise<MvpFailure | null> => {
    const result = await selectActiveProjectRequest(projectId);
    // Nothing is applied on a refusal. The selection stays what the server last confirmed,
    // so a control that asked for a project it was refused keeps addressing the real one.
    if (!result.ok) return result.error;
    setActiveProject(result.value);
    return null;
  }, []);

  const reloadProjects = useCallback((): void => {
    setProjectsEpoch((previous) => previous + 1);
  }, []);

  const signIn = useCallback(
    async (credentials: SignInRequest): Promise<ApiFailure | null> => {
      const result = await signInRequest(credentials);
      if (!result.ok) return result.error;
      // The credential is answered with an identity, and the identity's own session route is
      // then read for the authoritative project selection. One extra read on sign-in buys a
      // single definition of "the session", rather than a second copy of it in the sign-in
      // response that could disagree with the first (F02-AC1).
      const session = await readOwnerSession();
      if (session.ok) {
        adoptSession(session.value);
        return null;
      }
      // The session exists - it was just issued - so the owner is signed in even when the
      // follow-up read failed, and the project stays null, which the shell states rather than
      // filling in. Reporting sign-in as a failure would send someone who authenticated
      // correctly back to a form they already satisfied (F01-AC1).
      adoptIdentity({ owner: result.value.owner, csrfToken: result.value.csrfToken });
      return null;
    },
    [adoptIdentity, adoptSession],
  );

  const signOut = useCallback(async (): Promise<void> => {
    await signOutRequest();
    setCsrfToken(null);
    setMvpCsrfToken(null);
    setOwner(null);
    // Projects, the selection and the identity go with the session. A signed-out client that
    // kept the project list would hold one owner's workspace facts in memory after the
    // session that authorized reading them is gone (F01-AC2, F01-AC5).
    setProjects([]);
    setActiveProject(null);
    setSessionFailure(null);
    setStatus('signed-out');
  }, []);

  const retry = useCallback((): void => {
    setConnectionEpoch((previous) => previous + 1);
  }, []);

  const reloadSession = useCallback((): void => {
    setSessionEpoch((previous) => previous + 1);
    setStatus('checking');
  }, []);

  const selectedProjectId = activeProject?.state === 'Selected' ? activeProject.activeProjectId : null;
  const selectedProjectName = activeProject?.state === 'Selected' ? activeProject.activeProjectName : null;

  const value = useMemo<SessionContextValue>(
    () => ({
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
      signIn,
      signOut,
      retry,
    }),
    [
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
      signIn,
      signOut,
      retry,
    ],
  );

  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside a SessionProvider.');
  return value;
}