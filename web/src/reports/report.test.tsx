import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReportButton } from './ReportButton';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

describe('ReportButton', () => {
  it('denuncia com motivo e mostra sucesso', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/reports') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'r1', status: 'OPEN' }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<ReportButton reportedUserId="m1" />));
    await userEvent.click(screen.getByRole('button', { name: /denunciar/i }));
    await userEvent.click(screen.getByRole('button', { name: /conteúdo explícito/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/reports') && (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({ reportedUserId: 'm1', reason: 'EXPLICITO' });
    });
    await waitFor(() => expect(screen.getByText(/denúncia enviada/i)).toBeInTheDocument());
  });
});
