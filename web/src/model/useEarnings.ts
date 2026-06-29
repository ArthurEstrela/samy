import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';

export function useEarnings(): ReturnType<typeof useQuery<{ balance: string }>> {
  return useQuery<{ balance: string }>({
    queryKey: ['earnings'],
    queryFn: () => apiFetch<{ balance: string }>('/wallet/earnings', { auth: true }),
  });
}
