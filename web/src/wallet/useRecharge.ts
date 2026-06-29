import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { Recharge } from '../types/api';

export function useRecharge(id: string | null): ReturnType<typeof useQuery<Recharge>> {
  return useQuery<Recharge>({
    queryKey: ['recharge', id],
    queryFn: () => apiFetch<Recharge>(`/wallet/recharge/${id}`, { auth: true }),
    enabled: !!id,
    refetchInterval: (query) => (query.state.data?.status === 'PAID' ? false : 3000),
  });
}
