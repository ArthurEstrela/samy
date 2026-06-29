import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { IncomingCallWatcher } from './IncomingCallWatcher';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'm1', role: 'MODEL', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Routes>
          <Route path="*" element={<IncomingCallWatcher />} />
          <Route path="/call/:id" element={<div>tela de chamada</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

describe('IncomingCallWatcher', () => {
  it('mostra a chamada recebida e Aceitar chama POST accept', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/calls/inc1/accept') && init?.method === 'POST') return Promise.resolve(json(200, { call: { id: 'inc1' }, media: { token: 't', url: 'wss://x' } }));
      if (u.endsWith('/calls/incoming')) return Promise.resolve(json(200, { call: { id: 'inc1', clientUserId: 'c', modelUserId: 'm1', status: 'REQUESTED', endReason: null, pricePerMinuteSnapshot: '5.00', roomName: null, startedAt: null } }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap());
    await waitFor(() => expect(screen.getByText(/chamada recebida/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /aceitar/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/calls/inc1/accept'))).toBe(true));
  });

  it('sem chamada não mostra nada', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { call: null })));
    render(wrap());
    await waitFor(() => expect(screen.queryByText(/chamada recebida/i)).not.toBeInTheDocument());
  });
});
