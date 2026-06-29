import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { apiFetch } from '../lib/api-client';
import { getSession, setSession, clearSession } from '../lib/session';
import type { AuthResult, SessionUser } from '../types/api';

interface AuthValue {
  user: SessionUser | null;
  login: (idToken: string) => Promise<void>;
  devLogin: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<SessionUser | null>(() => getSession()?.user ?? null);

  const value = useMemo<AuthValue>(() => ({
    user,
    login: async (idToken: string) => {
      const result = await apiFetch<AuthResult>('/auth/google', {
        method: 'POST',
        body: { idToken, role: 'CLIENT' },
      });
      setSession({ accessToken: result.accessToken, refreshToken: result.refreshToken, user: result.user });
      setUser(result.user);
    },
    devLogin: async () => {
      const result = await apiFetch<AuthResult>('/auth/dev-login', { method: 'POST' });
      setSession({ accessToken: result.accessToken, refreshToken: result.refreshToken, user: result.user });
      setUser(result.user);
    },
    logout: async () => {
      const session = getSession();
      if (session) {
        try {
          await apiFetch('/auth/logout', { method: 'POST', body: { refreshToken: session.refreshToken } });
        } catch {
          // logout é best-effort; limpa local de qualquer forma
        }
      }
      clearSession();
      setUser(null);
    },
  }), [user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
