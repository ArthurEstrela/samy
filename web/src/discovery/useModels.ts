import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { ModelCard } from '../types/api';

export function useModels(): ReturnType<typeof useQuery<ModelCard[]>> {
  return useQuery<ModelCard[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch<ModelCard[]>('/models', { auth: true }),
  });
}
