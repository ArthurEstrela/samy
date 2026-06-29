import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { GiftPicker } from './GiftPicker';
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
const catalog = [{ id: 'gift-rosa', name: 'Rosa', priceCredits: '5.00', active: true }, { id: 'gift-coroa', name: 'Coroa', priceCredits: '50.00', active: true }];
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

describe('GiftPicker', () => {
  it('lista o catálogo e enviar chama POST /gifts', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/gifts/catalog')) return Promise.resolve(json(200, catalog));
      if (u.endsWith('/gifts') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'g1' }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<GiftPicker modelId="m1" />));
    await waitFor(() => expect(screen.getByText('Rosa')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /rosa/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/gifts') && (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ modelId: 'm1', giftTypeId: 'gift-rosa' });
    });
    await waitFor(() => expect(screen.getByText(/enviado/i)).toBeInTheDocument());
  });

  it('402 mostra saldo insuficiente', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/gifts/catalog')) return Promise.resolve(json(200, catalog));
      if (u.endsWith('/gifts') && init?.method === 'POST') return Promise.resolve(json(402, { message: 'insufficient balance' }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<GiftPicker modelId="m1" />));
    await waitFor(() => expect(screen.getByText('Rosa')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /rosa/i }));
    await waitFor(() => expect(screen.getByText(/saldo insuficiente/i)).toBeInTheDocument());
  });
});
