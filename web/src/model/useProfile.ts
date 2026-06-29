import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { ModelProfile } from '../types/api';

export function useProfile(): ReturnType<typeof useQuery<ModelProfile | null>> {
  return useQuery<ModelProfile | null>({
    queryKey: ['my-profile'],
    queryFn: () => apiFetch<ModelProfile | null>('/me/profile', { auth: true }),
  });
}
