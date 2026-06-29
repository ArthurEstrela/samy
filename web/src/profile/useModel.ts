import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { ModelCard } from '../types/api';

export function useModel(id: string): ReturnType<typeof useQuery<ModelCard>> {
  return useQuery<ModelCard>({
    queryKey: ['model', id],
    queryFn: () => apiFetch<ModelCard>(`/models/${id}`, { auth: true }),
  });
}
