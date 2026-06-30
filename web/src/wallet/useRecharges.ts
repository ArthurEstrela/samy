import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { RechargeSummary } from '../types/api';

export function useRecharges(): ReturnType<typeof useQuery<RechargeSummary[]>> {
  return useQuery<RechargeSummary[]>({
    queryKey: ['recharges'],
    queryFn: () => apiFetch<RechargeSummary[]>('/wallet/recharge/history', { auth: true }),
  });
}
