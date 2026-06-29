import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { Call } from '../types/api';

export function useCallActions(): {
  initiate: ReturnType<typeof useMutation<Call, Error, string>>;
  accept: ReturnType<typeof useMutation<unknown, Error, string>>;
  reject: ReturnType<typeof useMutation<unknown, Error, string>>;
  hangup: ReturnType<typeof useMutation<unknown, Error, string>>;
  panic: ReturnType<typeof useMutation<unknown, Error, string>>;
} {
  const initiate = useMutation<Call, Error, string>({ mutationFn: (modelId) => apiFetch<Call>('/calls', { method: 'POST', body: { modelId }, auth: true }) });
  const accept = useMutation<unknown, Error, string>({ mutationFn: (id) => apiFetch(`/calls/${id}/accept`, { method: 'POST', auth: true }) });
  const reject = useMutation<unknown, Error, string>({ mutationFn: (id) => apiFetch(`/calls/${id}/reject`, { method: 'POST', auth: true }) });
  const hangup = useMutation<unknown, Error, string>({ mutationFn: (id) => apiFetch(`/calls/${id}/hangup`, { method: 'POST', auth: true }) });
  const panic = useMutation<unknown, Error, string>({ mutationFn: (id) => apiFetch(`/calls/${id}/panic`, { method: 'POST', auth: true }) });
  return { initiate, accept, reject, hangup, panic };
}
