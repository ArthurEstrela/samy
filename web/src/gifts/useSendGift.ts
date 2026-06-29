import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';

export function useSendGift(): ReturnType<typeof useMutation<unknown, Error, { modelId: string; giftTypeId: string }>> {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { modelId: string; giftTypeId: string }>({
    mutationFn: (dto) => apiFetch('/gifts', { method: 'POST', body: dto, auth: true }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['balance'] }); },
  });
}
