import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';

export function useBalance(): ReturnType<typeof useQuery<{ balance: string }>> {
  return useQuery<{ balance: string }>({
    queryKey: ['balance'],
    queryFn: () => apiFetch<{ balance: string }>('/wallet/balance', { auth: true }),
  });
}
