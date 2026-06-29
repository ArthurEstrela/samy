import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { Recharge } from '../types/api';

export function useCreateRecharge(): ReturnType<typeof useMutation<Recharge, Error, string>> {
  return useMutation<Recharge, Error, string>({
    mutationFn: (amount: string) => apiFetch<Recharge>('/wallet/recharge', { method: 'POST', body: { amount }, auth: true }),
  });
}
