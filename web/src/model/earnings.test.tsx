import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EarningsPanel } from './EarningsPanel';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'MODEL', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('EarningsPanel', () => {
  it('mostra os ganhos e o histórico', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith('/wallet/earnings')) return Promise.resolve(json(200, { balance: '250' }));
      if (u.endsWith('/payouts')) return Promise.resolve(json(200, [{ id: 'p1', amount: '200.00', status: 'PENDING', pixKey: 'k', createdAt: '2026-06-29' }]));
      return Promise.resolve(json(200, {}));
    }));
    render(wrap(<EarningsPanel />));
    await waitFor(() => expect(screen.getByText(/250/)).toBeInTheDocument());
    expect(screen.getByText(/PENDING/i)).toBeInTheDocument();
  });

  it('solicitar saque chama POST /payouts', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/wallet/earnings')) return Promise.resolve(json(200, { balance: '250' }));
      if (u.endsWith('/payouts') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'p1', amount: '200.00', status: 'PENDING', pixKey: 'k', createdAt: 'x' }));
      if (u.endsWith('/payouts')) return Promise.resolve(json(200, []));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<EarningsPanel />));
    await screen.findByText(/250/);
    await userEvent.clear(screen.getByLabelText(/valor/i));
    await userEvent.type(screen.getByLabelText(/valor/i), '200');
    await userEvent.type(screen.getByLabelText(/chave pix/i), 'k');
    await userEvent.click(screen.getByRole('button', { name: /solicitar saque/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/payouts') && (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ amount: '200', pixKey: 'k' });
    });
  });

  it('erro 403 no saque mostra aviso de KYC', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/wallet/earnings')) return Promise.resolve(json(200, { balance: '250' }));
      if (u.endsWith('/payouts') && init?.method === 'POST') return Promise.resolve(json(403, { message: 'KYC not approved' }));
      if (u.endsWith('/payouts')) return Promise.resolve(json(200, []));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<EarningsPanel />));
    await screen.findByText(/250/);
    await userEvent.type(screen.getByLabelText(/valor/i), '200');
    await userEvent.type(screen.getByLabelText(/chave pix/i), 'k');
    await userEvent.click(screen.getByRole('button', { name: /solicitar saque/i }));
    await waitFor(() => expect(screen.getByText(/kyc/i)).toBeInTheDocument());
  });

  it('botão dev aparece com VITE_DEV_LOGIN e chama dev-grant', async () => {
    vi.stubEnv('VITE_DEV_LOGIN', 'true');
    const fetchMock = vi.fn().mockImplementation((url: string, _init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/wallet/earnings')) return Promise.resolve(json(200, { balance: '0' }));
      if (u.endsWith('/payouts/dev-grant')) return Promise.resolve(json(201, { ok: true }));
      if (u.endsWith('/payouts')) return Promise.resolve(json(200, []));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<EarningsPanel />));
    await screen.findByText(/0/);
    await userEvent.click(screen.getByRole('button', { name: /creditar ganhos/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/payouts/dev-grant'))).toBe(true));
  });
});
