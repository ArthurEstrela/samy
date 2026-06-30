import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/auth-context';
import { AdminPage } from './AdminPage';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

function sessFor(role: string): Session {
  return { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role, status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><MemoryRouter><AuthProvider>{ui}</AuthProvider></MemoryRouter></QueryClientProvider>;
}
const users = [
  { id: 'm1', role: 'MODEL', status: 'PENDING_VERIFICATION', email: 'm@x.com', displayName: 'Mod', createdAt: '2026-06-29T00:00:00.000Z' },
  { id: 'c1', role: 'CLIENT', status: 'ACTIVE', email: 'c@x.com', displayName: 'Cli', createdAt: '2026-06-28T00:00:00.000Z' },
];
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('AdminPage', () => {
  it('lista usuários e ativar chama POST activate', async () => {
    setSession(sessFor('ADMIN'));
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/admin/users')) return Promise.resolve(json(200, users));
      if (u.includes('/activate') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'm1', status: 'ACTIVE' }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<AdminPage />));
    await waitFor(() => expect(screen.getByText('Mod')).toBeInTheDocument());
    expect(screen.getByText('m@x.com')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /ativar/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => String(c[0]).includes('/admin/users/m1/activate') && (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
    });
  });

  it('não-admin é redirecionado (não mostra lista)', async () => {
    setSession(sessFor('CLIENT'));
    vi.stubGlobal('fetch', vi.fn(async () => json(200, users)));
    render(wrap(<AdminPage />));
    // Navigate to "/" → o conteúdo do painel não renderiza
    await waitFor(() => expect(screen.queryByText('Mod')).not.toBeInTheDocument());
  });
});
