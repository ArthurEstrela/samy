import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { RankingPanel } from './RankingPanel';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'm1', role: 'MODEL', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function renderPanel(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, body)));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><RankingPanel /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

describe('RankingPanel', () => {
  it('mostra o tier e quanto falta pro próximo', async () => {
    renderPanel({ tier: 'PRATA', earned: '800.00', takeRate: '0.25', nextTier: 'OURO', nextThreshold: '2000.00', remaining: '1200.00' });
    await waitFor(() => expect(screen.getByText('PRATA')).toBeInTheDocument());
    expect(screen.getByText(/1200\.00/)).toBeInTheDocument();
    expect(screen.getByText(/OURO/)).toBeInTheDocument();
  });

  it('tier máximo não mostra progresso', async () => {
    renderPanel({ tier: 'DIAMANTE', earned: '12000.00', takeRate: '0.15', nextTier: null, nextThreshold: null, remaining: null });
    await waitFor(() => expect(screen.getByText('DIAMANTE')).toBeInTheDocument());
    expect(screen.getByText(/tier máximo/i)).toBeInTheDocument();
  });
});
