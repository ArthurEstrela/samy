import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { Payout } from '../types/api';

export function usePayouts(): ReturnType<typeof useQuery<Payout[]>> {
  return useQuery<Payout[]>({
    queryKey: ['payouts'],
    queryFn: () => apiFetch<Payout[]>('/payouts', { auth: true }),
  });
}
