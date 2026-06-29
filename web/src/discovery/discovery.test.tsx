import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/auth-context';
import { DiscoveryPage } from './DiscoveryPage';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';
import type { ModelCard } from '../types/api';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
const cards: ModelCard[] = [
  { userId: 'm1', stageName: 'Lara', bio: null, pricePerMinute: '4.00', tags: ['suave'], voicePreviewUrl: null, status: 'ONLINE', isFavorite: false },
  { userId: 'm2', stageName: 'Bia', bio: null, pricePerMinute: '6.00', tags: [], voicePreviewUrl: null, status: 'OFFLINE', isFavorite: false },
];
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><MemoryRouter><AuthProvider>{ui}</AuthProvider></MemoryRouter></QueryClientProvider>;
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

it('renderiza os cards da lista (stageName, nunca nome real)', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, cards)));
  render(wrap(<DiscoveryPage />));
  await waitFor(() => expect(screen.getByText('Lara')).toBeInTheDocument());
  expect(screen.getByText('Bia')).toBeInTheDocument();
  expect(screen.queryByText('A')).not.toBeInTheDocument();
});

it('mostra estado vazio quando não há modelos', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, [])));
  render(wrap(<DiscoveryPage />));
  await waitFor(() => expect(screen.getByText(/nenhuma voz/i)).toBeInTheDocument());
});

it('mostra estado de erro quando a API falha', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { message: 'boom' })));
  render(wrap(<DiscoveryPage />));
  await waitFor(() => expect(screen.getByText(/tentar de novo/i)).toBeInTheDocument());
});
