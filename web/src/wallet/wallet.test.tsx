import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WalletPage } from './WalletPage';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>;
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('WalletPage', () => {
  it('mostra o saldo atual', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/wallet/balance')) return Promise.resolve(json(200, { balance: '15' }));
      return Promise.resolve(json(200, {}));
    }));
    render(wrap(<WalletPage />));
    await waitFor(() => expect(screen.getByText(/15/)).toBeInTheDocument());
  });

  it('criar recarga mostra o QR e o status pendente', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/wallet/balance')) return Promise.resolve(json(200, { balance: '0' }));
      if (u.endsWith('/wallet/recharge') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'r1', amount: '20.00', status: 'PENDING', qrText: '00020126ABC', expiresAt: null }));
      if (u.endsWith('/wallet/recharge/r1')) return Promise.resolve(json(200, { id: 'r1', amount: '20.00', status: 'PENDING', qrText: '00020126ABC', expiresAt: null }));
      return Promise.resolve(json(200, {}));
    }));
    render(wrap(<WalletPage />));
    await screen.findByText(/saldo/i);
    await userEvent.clear(screen.getByLabelText(/valor/i));
    await userEvent.type(screen.getByLabelText(/valor/i), '20');
    await userEvent.click(screen.getByRole('button', { name: /gerar/i }));
    await waitFor(() => expect(screen.getByText(/aguardando pagamento/i)).toBeInTheDocument());
    expect(screen.getByText('00020126ABC')).toBeInTheDocument();
  });

  it('quando a recarga vira PAID mostra confirmação', async () => {
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/wallet/balance')) return Promise.resolve(json(200, { balance: '0' }));
      if (u.endsWith('/wallet/recharge') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'r1', amount: '20.00', status: 'PENDING', qrText: 'x', expiresAt: null }));
      if (u.endsWith('/wallet/recharge/r1')) { polls += 1; return Promise.resolve(json(200, { id: 'r1', amount: '20.00', status: polls > 1 ? 'PAID' : 'PENDING', qrText: 'x', expiresAt: null, paidAt: polls > 1 ? '2026-06-28' : null })); }
      return Promise.resolve(json(200, {}));
    }));
    render(wrap(<WalletPage />));
    await screen.findByText(/saldo/i);
    await userEvent.click(screen.getByRole('button', { name: /gerar/i }));
    await waitFor(() => expect(screen.getByText(/confirmada/i)).toBeInTheDocument(), { timeout: 6000 });
  });

  it('botão dev aparece com VITE_DEV_LOGIN e chama dev-confirm', async () => {
    vi.stubEnv('VITE_DEV_LOGIN', 'true');
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/wallet/balance')) return Promise.resolve(json(200, { balance: '0' }));
      if (u.endsWith('/wallet/recharge') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'r1', amount: '20.00', status: 'PENDING', qrText: 'x', expiresAt: null }));
      if (u.endsWith('/wallet/recharge/r1/dev-confirm')) return Promise.resolve(json(201, { credited: true }));
      if (u.endsWith('/wallet/recharge/r1')) return Promise.resolve(json(200, { id: 'r1', amount: '20.00', status: 'PENDING', qrText: 'x', expiresAt: null }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<WalletPage />));
    await screen.findByText(/saldo/i);
    await userEvent.click(screen.getByRole('button', { name: /gerar/i }));
    await screen.findByRole('button', { name: /já paguei/i });
    await userEvent.click(screen.getByRole('button', { name: /já paguei/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/wallet/recharge/r1/dev-confirm'))).toBe(true));
  });
});
