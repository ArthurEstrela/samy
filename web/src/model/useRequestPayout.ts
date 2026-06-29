import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { Payout } from '../types/api';

export function useRequestPayout(): ReturnType<typeof useMutation<Payout, Error, { amount: string; pixKey: string }>> {
  const qc = useQueryClient();
  return useMutation<Payout, Error, { amount: string; pixKey: string }>({
    mutationFn: (dto) => apiFetch<Payout>('/payouts', { method: 'POST', body: dto, auth: true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payouts'] });
      void qc.invalidateQueries({ queryKey: ['earnings'] });
    },
  });
}

export function useDevGrant(): ReturnType<typeof useMutation<unknown, Error, void>> {
  const qc = useQueryClient();
  return useMutation<unknown, Error, void>({
    mutationFn: () => apiFetch('/payouts/dev-grant', { method: 'POST', auth: true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payouts'] });
      void qc.invalidateQueries({ queryKey: ['earnings'] });
    },
  });
}
