import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth-context';
import { ProtectedRoute } from './ProtectedRoute';
import { getSession, setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = {
  accessToken: 'a', refreshToken: 'r',
  user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' },
};
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

function LoginProbe(): JSX.Element {
  const { user, login, logout } = useAuth();
  return (
    <div>
      <span>user:{user ? user.id : 'none'}</span>
      <button onClick={() => void login('idtok')}>login</button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

describe('AuthProvider', () => {
  it('login persiste sessão e popula user; logout limpa', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'a', refreshToken: 'r', user: sess.user })) // /auth/google
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })); // /auth/logout
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthProvider><LoginProbe /></AuthProvider>);
    expect(screen.getByText('user:none')).toBeInTheDocument();
    await userEvent.click(screen.getByText('login'));
    await waitFor(() => expect(screen.getByText('user:u1')).toBeInTheDocument());
    expect(getSession()?.user.id).toBe('u1');
    await userEvent.click(screen.getByText('logout'));
    await waitFor(() => expect(screen.getByText('user:none')).toBeInTheDocument());
    expect(getSession()).toBeNull();
  });
});

describe('ProtectedRoute', () => {
  it('sem sessão redireciona pra /login', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<div>tela de login</div>} />
            <Route path="/" element={<ProtectedRoute><div>protegido</div></ProtectedRoute>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('tela de login')).toBeInTheDocument();
  });

  it('com sessão renderiza o filho', () => {
    setSession(sess);
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<div>tela de login</div>} />
            <Route path="/" element={<ProtectedRoute><div>protegido</div></ProtectedRoute>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('protegido')).toBeInTheDocument();
  });
});
