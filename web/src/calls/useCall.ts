import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { CallView } from '../types/api';

export function useCall(id: string): ReturnType<typeof useQuery<CallView>> {
  return useQuery<CallView>({
    queryKey: ['call', id],
    queryFn: () => apiFetch<CallView>(`/calls/${id}`, { auth: true }),
    enabled: !!id,
    refetchInterval: (query) => (query.state.data?.call.status === 'ENDED' ? false : 2000),
  });
}
