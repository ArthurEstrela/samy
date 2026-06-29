import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { UpsertProfileInput } from '../types/api';

export function useUpsertProfile(): ReturnType<typeof useMutation<unknown, Error, UpsertProfileInput>> {
  const qc = useQueryClient();
  return useMutation<unknown, Error, UpsertProfileInput>({
    mutationFn: (dto: UpsertProfileInput) => apiFetch('/me/profile', { method: 'PUT', body: dto, auth: true }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['my-profile'] }); },
  });
}
