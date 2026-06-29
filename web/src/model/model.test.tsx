import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ModelDashboard } from './ModelDashboard';
import { AuthProvider } from '../auth/auth-context';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

function sess(role: 'CLIENT' | 'MODEL'): Session {
  return { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role, status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(initial = '/painel'): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<div>vitrine</div>} />
            <Route path="/painel" element={<ModelDashboard />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('ModelDashboard', () => {
  it('carrega o perfil no formulário e salvar chama PUT /me/profile', async () => {
    setSession(sess('MODEL'));
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/me/profile') && (!init || init.method === undefined || init.method === 'GET')) {
        return Promise.resolve(json(200, { userId: 'u1', stageName: 'Lara', bio: null, pricePerMinute: '5.00', tags: ['suave'], voicePreviewUrl: null }));
      }
      if (u.endsWith('/me/profile') && init?.method === 'PUT') return Promise.resolve(json(200, {}));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap());
    await waitFor(() => expect((screen.getByLabelText(/nome art/i) as HTMLInputElement).value).toBe('Lara'));
    await userEvent.click(screen.getByRole('button', { name: /salvar/i }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/me/profile') && (c[1] as RequestInit)?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put![1] as RequestInit).body)).stageName).toBe('Lara');
    });
  });

  it('toggle de presença liga e chama POST /me/heartbeat', async () => {
    setSession(sess('MODEL'));
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith('/me/profile')) return Promise.resolve(json(200, null));
      if (u.endsWith('/me/heartbeat')) return Promise.resolve(json(200, { status: 'ONLINE', ttl: 30 }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap());
    await userEvent.click(await screen.findByRole('button', { name: /ficar online/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/me/heartbeat'))).toBe(true));
  });

  it('CLIENT em /painel é redirecionado pra vitrine', async () => {
    setSession(sess('CLIENT'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, null)));
    render(wrap());
    await waitFor(() => expect(screen.getByText('vitrine')).toBeInTheDocument());
  });
});
