import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RechargeHistory } from './RechargeHistory';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function renderHistory(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, body)));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><RechargeHistory /></QueryClientProvider>);
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

describe('RechargeHistory', () => {
  it('lista as recargas com valor e status', async () => {
    renderHistory([
      { id: 'r1', amount: '50.00', status: 'PENDING', createdAt: '2026-06-29T10:00:00.000Z', paidAt: null },
      { id: 'r2', amount: '20.00', status: 'PAID', createdAt: '2026-06-28T10:00:00.000Z', paidAt: '2026-06-28T10:01:00.000Z' },
    ]);
    await waitFor(() => expect(screen.getByText(/50\.00/)).toBeInTheDocument());
    expect(screen.getByText(/20\.00/)).toBeInTheDocument();
    expect(screen.getByText(/paga/i)).toBeInTheDocument();
    expect(screen.getByText(/pendente/i)).toBeInTheDocument();
  });

  it('estado vazio', async () => {
    renderHistory([]);
    await waitFor(() => expect(screen.getByText(/nenhuma recarga ainda/i)).toBeInTheDocument());
  });
});
