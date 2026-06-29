import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { KycStatusView } from '../types/api';

export function useKyc(): {
  status: ReturnType<typeof useQuery<KycStatusView>>;
  start: ReturnType<typeof useMutation<unknown, Error, void>>;
  devApprove: ReturnType<typeof useMutation<unknown, Error, void>>;
} {
  const qc = useQueryClient();
  const status = useQuery<KycStatusView>({
    queryKey: ['kyc'],
    queryFn: () => apiFetch<KycStatusView>('/kyc/me', { auth: true }),
  });
  const start = useMutation<unknown, Error, void>({
    mutationFn: () => apiFetch('/kyc/start', { method: 'POST', auth: true }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['kyc'] }); },
  });
  const devApprove = useMutation<unknown, Error, void>({
    mutationFn: () => apiFetch('/kyc/dev-approve', { method: 'POST', auth: true }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['kyc'] }); },
  });
  return { status, start, devApprove };
}
