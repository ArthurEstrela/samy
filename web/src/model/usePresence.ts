import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api-client';

const HEARTBEAT_MS = 20000;

export function usePresence(): { online: boolean; toggle: () => void } {
  const [online, setOnline] = useState(false);
  useEffect(() => {
    if (!online) return;
    const beat = (): void => { void apiFetch('/me/heartbeat', { method: 'POST', auth: true }).catch(() => {}); };
    beat();
    const id = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [online]);
  return { online, toggle: () => setOnline((v) => !v) };
}
