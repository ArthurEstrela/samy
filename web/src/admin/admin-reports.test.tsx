import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/auth-context';
import { AdminPage } from './AdminPage';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const admin: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'ADMIN', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><MemoryRouter><AuthProvider>{ui}</AuthProvider></MemoryRouter></QueryClientProvider>;
}
const reports = [{ id: 'r1', reportedUserId: 'm1', reportedName: 'Lara', reason: 'EXPLICITO', details: 'x', status: 'OPEN', createdAt: '2026-06-30T00:00:00.000Z' }];
beforeEach(() => { localStorage.clear(); setSession(admin); });
afterEach(() => vi.restoreAllMocks());

describe('AdminPage denúncias', () => {
  it('lista denúncias e "Revisado" chama resolve', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/admin/users')) return Promise.resolve(json(200, []));
      if (u.endsWith('/admin/reports')) return Promise.resolve(json(200, reports));
      if (u.includes('/admin/reports/r1/resolve') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'r1', status: 'REVIEWED' }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<AdminPage />));
    await waitFor(() => expect(screen.getByText('Lara')).toBeInTheDocument());
    expect(screen.getByText(/explícito/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /revisado/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => String(c[0]).includes('/admin/reports/r1/resolve') && (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
    });
  });
});
