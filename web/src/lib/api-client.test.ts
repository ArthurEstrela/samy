import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError } from './api-client';
import { getSession, setSession, clearSession } from './session';
import type { Session } from './session';

const sess: Session = {
  accessToken: 'acc1',
  refreshToken: 'ref1',
  user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('apiFetch', () => {
  it('injeta Authorization quando há sessão', async () => {
    setSession(sess);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, [{ userId: 'm1' }]));
    vi.stubGlobal('fetch', fetchMock);
    const out = await apiFetch<{ userId: string }[]>('/models', { auth: true });
    expect(out[0].userId).toBe('m1');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer acc1');
  });

  it('no 401 faz refresh (rotação), persiste novos tokens e retenta uma vez', async () => {
    setSession(sess);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: 'expired' }))            // request original
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'acc2', refreshToken: 'ref2' })) // refresh
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));                     // retry
    vi.stubGlobal('fetch', fetchMock);
    const out = await apiFetch<{ ok: boolean }>('/models', { auth: true });
    expect(out.ok).toBe(true);
    expect(getSession()?.accessToken).toBe('acc2');
    expect(getSession()?.refreshToken).toBe('ref2');
    // o retry usa o novo token
    const retryHeaders = (fetchMock.mock.calls[2][1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer acc2');
  });

  it('se o refresh falhar, limpa a sessão e lança ApiError 401', async () => {
    setSession(sess);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: 'expired' }))  // original
      .mockResolvedValueOnce(jsonResponse(401, { message: 'bad refresh' })); // refresh falha
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/models', { auth: true })).rejects.toMatchObject({ status: 401 });
    expect(getSession()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // não entra em loop
  });

  it('propaga ApiError em erro não-401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { message: 'boom' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/models')).rejects.toBeInstanceOf(ApiError);
  });
});
