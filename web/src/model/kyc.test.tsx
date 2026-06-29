import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KycPanel } from './KycPanel';
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

describe('KycPanel', () => {
  it('mostra status NÃO iniciada e o botão de iniciar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/kyc/me')) return Promise.resolve(json(200, { status: 'NONE' }));
      return Promise.resolve(json(200, {}));
    }));
    render(wrap(<KycPanel />));
    await waitFor(() => expect(screen.getByRole('button', { name: /iniciar verifica/i })).toBeInTheDocument());
  });

  it('status APPROVED renderiza "aprovada"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/kyc/me')) return Promise.resolve(json(200, { status: 'APPROVED' }));
      return Promise.resolve(json(200, {}));
    }));
    render(wrap(<KycPanel />));
    await waitFor(() => expect(screen.getByText(/aprovada/i)).toBeInTheDocument());
  });

  it('botão dev aparece com VITE_DEV_LOGIN e chama /kyc/dev-approve', async () => {
    vi.stubEnv('VITE_DEV_LOGIN', 'true');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith('/kyc/dev-approve')) return Promise.resolve(json(201, { ok: true }));
      if (u.endsWith('/kyc/me')) return Promise.resolve(json(200, { status: 'NONE' }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<KycPanel />));
    await userEvent.click(await screen.findByRole('button', { name: /aprovar kyc/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/kyc/dev-approve'))).toBe(true));
  });
});
