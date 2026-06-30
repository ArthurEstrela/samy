import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { RankingEntry } from '../types/api';

export function useRankingTop(): ReturnType<typeof useQuery<RankingEntry[]>> {
  return useQuery<RankingEntry[]>({
    queryKey: ['ranking-top'],
    queryFn: () => apiFetch<RankingEntry[]>('/ranking/top', { auth: true }),
  });
}
