import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';

type Action = 'activate' | 'suspend';

export function useSetUserStatus(): ReturnType<typeof useMutation<unknown, Error, { id: string; action: Action }>> {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { id: string; action: Action }>({
    mutationFn: ({ id, action }) => apiFetch(`/admin/users/${id}/${action}`, { method: 'POST', auth: true }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-users'] }); },
  });
}
