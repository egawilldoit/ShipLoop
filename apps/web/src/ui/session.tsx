/**
 * The signed-in owner, the session, and which project every project-scoped call addresses.
 *
 * ## What changed and why
 *
 * This layer used to hold its own `api-client.ts` copy of sign-in, the project list and the CSRF
 * token. That was workable while there was one transport and wrong the moment there were two: the
 * owner shell signed in through one module, the MVP screens signed in through another, and nothing
 * in the type system stopped them disagreeing about who is signed in or which project is active.
 *
 * So identity now has exactly one implementation — `apps/web/src/ui/mvp-client` — and this module
 * is only the React state around it. There is no second `signIn`, no second CSRF token, and no
 * second connection state here (F01-AC1, F01-AC4).
 *
 * ## The two facts this refuses to invent
 *
 *   1. **A project.** `activeProject` is a discriminated union the server produced. When it says
 *      `NoProjectSelected` there is no project id to obtain, and `scope` says so rather than
 *      carrying a placeholder. The historical defect this exists to prevent was a request to
 *      `/api/profiles/undefined` — a project literally named "undefined" — which answered 404 and
 *      was reported to the owner as "that project has no saved profile yet" (F02-AC1, F02-AC4).
 *   2. **An executor.** Nothing here reads or derives agent, engine or T3 progress, because
 *      ShipLoop holds no factual integration that could answer it. A field that would have to be
 *      invented is a field this layer does not have (mvp-spec 3).
 */

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
  fetchSession,
  getMvpConnectionState,
  listProjects,
  projectIdOf,
  projectScopeOf,
  selectActiveProject,
  setMvpCsrfToken,
  signIn as signInRequest,
  signOut as signOutRequest,
  subscribeToMvpConnection,
  type MvpConnectionState,
  type MvpFailure,
  type OwnerView,
  type ProjectScope,
  type ProjectView,
  type SessionView,
} from './mvp-client/index.ts';

/**
 * Whether the owner is signed in, and whether we have finished finding out.
 *
 * `checking` is a real state and not a formality: until `GET /api/owner/session` has answered,
 * "signed out" and "signed in" are both unproven, and rendering the sign-in form during `checking`
 * would flash a form at an owner who has a valid session (F01-AC1).
 *
 * A session read that fails resolves to `signed-out`, not to a separate "cannot reach the server"
 * state. The reason is that a failed read cannot distinguish the two: an aborted request looks the
 * same whether the browser holds no session or the network is down, so asserting one of them here
 * would be a claim the product cannot support. The sign-in form is therefore shown, and the
 * *attempt* is the request that can tell them apart — a sign-in that also fails reports that the
 * server could not be reached, which is a fact by then (N03-AC3). The connection banner reports the
 * disconnect throughout.
 */
export type SessionStatus = 'checking' | 'signed-in' | 'signed-out';

export interface SessionContextValue {
  readonly status: SessionStatus;
  readonly owner: OwnerView | null;
  /** Every project this owner may switch to. Never a placeholder and never empty by default. */
  readonly projects: readonly ProjectView[];
  /**
   * The project every project-scoped call addresses, derived from the server's own answer.
   *
   * This is the only place a `ProjectScope` is produced. A screen receives it; a screen never
   * builds one (F02-AC1, F02-AC4).
   */
  readonly scope: ProjectScope | null;
  /**
   * The active project's id, or null when none is selected.
   *
   * A projection of `scope` for the legacy orchestration pages, which take a bare id rather than a
   * scope and are no longer in primary navigation. It is derived here rather than held as a second
   * piece of state, because two independently-set copies of "the active project" is exactly how two
   * surfaces end up addressing different projects (F02-AC2).
   */
  readonly selectedProjectId: string | null;
  /** The last refusal from a session call, or null. Shown, never swallowed. */
  readonly failure: MvpFailure | null;
  /** Bumped when the connection state changes, so screens can refetch rather than go stale. */
  readonly epoch: number;
  readonly connection: MvpConnectionState;
  /**
   * Sign in, reported the way the sign-in screen already expects.
   *
   * `null` means it worked. A refusal comes back as `null` plus a `failure` on the context rather
   * than as a return value, because the sign-in screen is a form: it needs the field-level
   * messages and a summary line, and a form that has to branch on a result union to render those
   * is a form that will eventually render neither (F01-AC1, N03-AC3).
   *
   * The field is named `email` because that is the label the sign-in screen shows and the value
   * the owner provisioned with; the server accepts either the address or the display name and
   * resolves it (routes/owner.ts).
   */
  readonly signIn: (credentials: {
    readonly email: string;
    readonly password: string;
  }) => Promise<MvpFailure | null>;
  readonly signOut: () => Promise<void>;
  readonly selectProject: (projectId: string | null) => Promise<void>;
  readonly retry: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * The signed-in owner, from the server, once.
 *
 * The CSRF token is handed to the transport here rather than held in component state: the cookie
 * it is derived against is `HttpOnly`, so the token is the only half the browser is allowed to see,
 * and it belongs to the module that signs requests rather than to whichever component happened to
 * render first (F01-AC4).
 */
function adoptSession(session: SessionView): void {
  setMvpCsrfToken(session.csrfToken);
}

export function SessionProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<SessionStatus>('checking');
  const [session, setSession] = useState<SessionView | null>(null);
  const [projects, setProjects] = useState<readonly ProjectView[]>([]);
  const [failure, setFailure] = useState<MvpFailure | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [reload, setReload] = useState(0);

  const connection = useSyncExternalStore(
    subscribeToMvpConnection,
    getMvpConnectionState,
    getMvpConnectionState,
  );

  // The single read of who this browser is. Re-run on demand only — never on a timer, because a
  // poll that re-announces the same owner is a request the product cannot justify.
  useEffect(() => {
    let current = true;
    setStatus('checking');
    void fetchSession().then((result) => {
      if (!current) return;
      if (!result.ok) {
        // A failed read cannot say whether this browser holds a session, so it does not claim to:
        // the sign-in form is shown and the sign-in attempt is what establishes the answer. The
        // refusal is kept so the banner and the form can report it rather than dropping the only
        // evidence that anything went wrong (N03-AC3).
        setSession(null);
        setMvpCsrfToken(null);
        setStatus('signed-out');
        setFailure(result.failure);
        return;
      }
      adoptSession(result.value);
      setSession(result.value);
      setFailure(null);
      setStatus('signed-in');
      setEpoch((value) => value + 1);
    });
    return () => {
      current = false;
    };
  }, [reload]);

  // The project list is only useful once there is an owner to select one for. Loading it while
  // signed out would be a request no one asked for.
  useEffect(() => {
    if (status !== 'signed-in') {
      setProjects([]);
      return;
    }
    let current = true;
    void listProjects().then((result) => {
      if (!current) return;
      setProjects(result.ok ? result.value : []);
    });
    return () => {
      current = false;
    };
  }, [status, reload]);

  const signIn = useCallback(
    async (credentials: { readonly email: string; readonly password: string }): Promise<MvpFailure | null> => {
      const result = await signInRequest({ identifier: credentials.email, password: credentials.password });
      if (!result.ok) {
        setFailure(result.failure);
        return result.failure;
      }
      adoptSession(result.value);
      setSession(result.value);
      setFailure(null);
      setStatus('signed-in');
      setReload((value) => value + 1);
      return null;
    },
    [],
  );

  const signOut = useCallback(async (): Promise<void> => {
    const result = await signOutRequest();
    // The local identity is dropped whether or not the revocation reached the server: leaving a
    // signed-out owner holding the previous owner's cached project is how a client that has lost
    // its session goes on to look authorised (F01-AC2, F01-AC5).
    setMvpCsrfToken(null);
    setSession(null);
    setProjects([]);
    setStatus('signed-out');
    if (!result.ok) setFailure(result.failure);
  }, []);

  const selectProject = useCallback(async (projectId: string | null): Promise<void> => {
    if (projectId === null) {
      setFailure({
        code: 'Invalid',
        reason:
          'Clear the active project by selecting another project rather than by clearing the field. There is no "no project" a session can be moved to without a project to move it to.',
        status: 0,
        fields: [],
        prerequisites: [],
        expected: null,
        actual: null,
      });
      return;
    }
    const result = await selectActiveProject(projectId);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setFailure(null);
    // Re-read rather than patching local state: the server owns which project a session addresses,
    // and a locally-patched value is how two surfaces end up disagreeing about the active project
    // (F02-AC1, F02-AC2).
    setReload((value) => value + 1);
  }, []);

  const retry = useCallback((): void => {
    setReload((value) => value + 1);
  }, []);

  const scope = session === null ? null : projectScopeOf(session.owner.activeProject);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      owner: session === null ? null : session.owner,
      projects,
      scope,
      selectedProjectId: scope === null ? null : projectIdOf(scope),
      failure,
      epoch,
      connection,
      signIn,
      signOut,
      selectProject,
      retry,
    }),
    [status, session, scope, projects, failure, epoch, connection, signIn, signOut, selectProject, retry],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession was called outside a SessionProvider. The owner shell must wrap every screen in one.');
  }
  return value;
}