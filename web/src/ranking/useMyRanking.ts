import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { MyRanking } from '../types/api';

export function useMyRanking(): ReturnType<typeof useQuery<MyRanking>> {
  return useQuery<MyRanking>({
    queryKey: ['ranking-me'],
    queryFn: () => apiFetch<MyRanking>('/ranking/me', { auth: true }),
  });
}
