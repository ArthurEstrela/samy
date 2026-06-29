import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { Call } from '../types/api';

export function useIncomingCall(enabled: boolean): ReturnType<typeof useQuery<{ call: Call | null }>> {
  return useQuery<{ call: Call | null }>({
    queryKey: ['incoming'],
    queryFn: () => apiFetch<{ call: Call | null }>('/calls/incoming', { auth: true }),
    enabled,
    refetchInterval: 3000,
    retry: false,
  });
}
