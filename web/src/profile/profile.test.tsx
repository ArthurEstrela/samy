import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ModelProfilePage } from './ModelProfilePage';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';
import type { ModelCard } from '../types/api';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
const profile: ModelCard = { userId: 'm1', stageName: 'Lara', bio: 'voz suave', pricePerMinute: '4.00', tags: ['suave'], voicePreviewUrl: null, status: 'ONLINE', isFavorite: false };
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/models/m1']}>
        <Routes><Route path="/models/:id" element={<ModelProfilePage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

it('com modelo ONLINE, "Iniciar chamada" inicia e navega', async () => {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/models/m1') && (!init || init.method === undefined || init.method === 'GET')) return Promise.resolve(jsonResponse(200, { ...profile, status: 'ONLINE' }));
    if (u.endsWith('/calls') && init?.method === 'POST') return Promise.resolve(jsonResponse(201, { id: 'newcall' }));
    return Promise.resolve(jsonResponse(200, {}));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(wrap());
  await waitFor(() => expect(screen.getByText('Lara')).toBeInTheDocument());
  const btn = screen.getByRole('button', { name: /iniciar chamada/i });
  expect(btn).not.toBeDisabled();
  await userEvent.click(btn);
  await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/calls') && (c[1] as RequestInit)?.method === 'POST')).toBe(true));
});

it('favoritar chama POST /favorites/:id', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse(200, profile))       // GET /models/m1
    .mockResolvedValueOnce(jsonResponse(200, { ok: true }))  // POST /favorites/m1
    .mockResolvedValue(jsonResponse(200, { ...profile, isFavorite: true })); // refetch
  vi.stubGlobal('fetch', fetchMock);
  render(wrap());
  await waitFor(() => expect(screen.getByText('Lara')).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: /favoritar/i }));
  await waitFor(() => {
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/favorites/m1'));
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).method).toBe('POST');
  });
});

it('404 mostra "não encontrada"', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { message: 'not found' })));
  render(wrap());
  await waitFor(() => expect(screen.getByText(/não encontrada/i)).toBeInTheDocument());
});
