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
  getConnectionState,
  setCsrfToken,
  signIn as signInRequest,
  signOut as signOutRequest,
  subscribeToConnection,
  type ApiFailure,
  type ConnectionState,
  type OwnerIdentity,
  type SignInRequest,
} from './api-client.ts';

export type SessionStatus = 'checking' | 'signed-out' | 'signed-in';

export interface SessionContextValue {
  readonly status: SessionStatus;
  readonly owner: OwnerIdentity | null;
  readonly projectId: string;
  readonly projectName: string;
  readonly connection: ConnectionState;
  /** Bumped by the retry control so every mounted page refetches without prop-drilling. */
  readonly connectionEpoch: number;
  /** Resolves with null on success, or the failure to render beside the form. */
  readonly signIn: (credentials: SignInRequest) => Promise<ApiFailure | null>;
  readonly signOut: () => Promise<void>;
  readonly retry: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const NO_PROJECT: Readonly<{ projectId: string; projectName: string }> = { projectId: '', projectName: '' };

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
  const [project, setProject] = useState(NO_PROJECT);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const connection = useSyncExternalStore(subscribeToConnection, getConnectionState, getConnectionState);

  useEffect(() => {
    let current = true;
    void fetchSession().then((result) => {
      if (!current) return;
      if (result.ok) {
        setCsrfToken(result.value.csrfToken);
        setOwner(result.value.owner);
        setProject({ projectId: result.value.projectId, projectName: result.value.projectName });
        setStatus('signed-in');
      } else {
        setStatus('signed-out');
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const signIn = useCallback(async (credentials: SignInRequest): Promise<ApiFailure | null> => {
    const result = await signInRequest(credentials);
    if (!result.ok) return result.error;
    setCsrfToken(result.value.csrfToken);
    setOwner(result.value.owner);
    setProject({ projectId: result.value.projectId, projectName: result.value.projectName });
    setStatus('signed-in');
    return null;
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    await signOutRequest();
    setCsrfToken(null);
    setOwner(null);
    setProject(NO_PROJECT);
    setStatus('signed-out');
  }, []);

  const retry = useCallback((): void => {
    setConnectionEpoch((previous) => previous + 1);
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ status, owner, projectId: project.projectId, projectName: project.projectName, connection, connectionEpoch, signIn, signOut, retry }),
    [status, owner, project, connection, connectionEpoch, signIn, signOut, retry],
  );

  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside a SessionProvider.');
  return value;
}
