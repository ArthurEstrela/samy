import type { SessionUser } from '../types/api';

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

const KEY = 'samy.session';

export function getSession(): Session | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function setSession(s: Session): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession(): void {
  localStorage.removeItem(KEY);
}
