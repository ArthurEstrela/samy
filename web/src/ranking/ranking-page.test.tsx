import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RankingPage } from './RankingPage';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function renderPage(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, body)));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><RankingPage /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

describe('RankingPage', () => {
  it('lista o top com posição, tier e stageName', async () => {
    renderPage([
      { rank: 1, modelId: 'a', stageName: 'Lara', tier: 'OURO' },
      { rank: 2, modelId: 'b', stageName: 'Bianca', tier: 'PRATA' },
    ]);
    await waitFor(() => expect(screen.getByText('Lara')).toBeInTheDocument());
    expect(screen.getByText('Bianca')).toBeInTheDocument();
    expect(screen.getByText('OURO')).toBeInTheDocument();
  });

  it('lista vazia mostra estado vazio', async () => {
    renderPage([]);
    await waitFor(() => expect(screen.getByText(/ranking ainda vazio/i)).toBeInTheDocument());
  });
});
