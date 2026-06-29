import { getSession, setSession, clearSession } from './session';
import type { RefreshResult } from '../types/api';

const BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface Options {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

async function raw(path: string, opts: Options, accessToken?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (data && typeof data === 'object' && 'message' in data)
      ? String((data as { message: unknown }).message)
      : res.statusText;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

async function tryRefresh(): Promise<string | null> {
  const session = getSession();
  if (!session) return null;
  const res = await raw('/auth/refresh', { method: 'POST', body: { refreshToken: session.refreshToken } });
  if (!res.ok) {
    clearSession();
    return null;
  }
  const rotated = (await res.json()) as RefreshResult;
  setSession({ ...session, accessToken: rotated.accessToken, refreshToken: rotated.refreshToken });
  return rotated.accessToken;
}

export async function apiFetch<T>(path: string, opts: Options = {}): Promise<T> {
  const useAuth = opts.auth ?? false;
  const token = useAuth ? getSession()?.accessToken : undefined;
  const res = await raw(path, opts, token);
  if (res.status === 401 && useAuth) {
    const newToken = await tryRefresh();
    if (!newToken) {
      throw new ApiError(401, 'not authenticated');
    }
    const retry = await raw(path, opts, newToken);
    return parse<T>(retry);
  }
  return parse<T>(res);
}
