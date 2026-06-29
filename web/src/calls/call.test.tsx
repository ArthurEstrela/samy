import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../auth/auth-context';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

vi.mock('../lib/call-media', () => ({
  connectCallRoom: vi.fn().mockResolvedValue({ setMuted: vi.fn(), disconnect: vi.fn().mockResolvedValue(undefined) }),
}));
import { connectCallRoom } from '../lib/call-media';
import { CallScreen } from './CallScreen';

function sess(role: 'CLIENT' | 'MODEL'): Session {
  return { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role, status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/call/c1']}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<div>home</div>} />
            <Route path="/call/:id" element={<CallScreen />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
const baseCall = { id: 'c1', clientUserId: 'cli', modelUserId: 'mod', endReason: null, pricePerMinuteSnapshot: '5.00', roomName: 'call:c1', startedAt: null };
beforeEach(() => { localStorage.clear(); setSession(sess('CLIENT')); });
afterEach(() => vi.restoreAllMocks());

describe('CallScreen', () => {
  it('REQUESTED mostra "Chamando" e Desligar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { call: { ...baseCall, status: 'REQUESTED' } })));
    render(wrap());
    await waitFor(() => expect(screen.getByText(/chamando/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /desligar/i })).toBeInTheDocument();
  });

  it('ACTIVE conecta o áudio (connectCallRoom) e mostra Desligar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { call: { ...baseCall, status: 'ACTIVE', startedAt: new Date().toISOString() }, media: { token: 'tk', url: 'wss://x' } })));
    render(wrap());
    await waitFor(() => expect(connectCallRoom).toHaveBeenCalledWith('wss://x', 'tk'));
    expect(screen.getByRole('button', { name: /desligar/i })).toBeInTheDocument();
  });

  it('Desligar chama POST hangup', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/calls/c1/hangup') && init?.method === 'POST') return Promise.resolve(json(200, { ...baseCall, status: 'ENDED' }));
      return Promise.resolve(json(200, { call: { ...baseCall, status: 'ACTIVE', startedAt: new Date().toISOString() }, media: { token: 'tk', url: 'wss://x' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap());
    await screen.findByRole('button', { name: /desligar/i });
    await userEvent.click(screen.getByRole('button', { name: /desligar/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/calls/c1/hangup'))).toBe(true));
  });

  it('ENDED mostra o motivo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { call: { ...baseCall, status: 'ENDED', endReason: 'HANGUP_CLIENT' } })));
    render(wrap());
    await waitFor(() => expect(screen.getByText(/encerrada/i)).toBeInTheDocument());
  });
});
