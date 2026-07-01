import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { AdminReport } from '../types/api';

export function useAdminReports(): ReturnType<typeof useQuery<AdminReport[]>> {
  return useQuery<AdminReport[]>({
    queryKey: ['admin-reports'],
    queryFn: () => apiFetch<AdminReport[]>('/admin/reports', { auth: true }),
  });
}

export function useResolveReport(): ReturnType<typeof useMutation<unknown, Error, { id: string; status: 'REVIEWED' | 'DISMISSED' }>> {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { id: string; status: 'REVIEWED' | 'DISMISSED' }>({
    mutationFn: ({ id, status }) => apiFetch(`/admin/reports/${id}/resolve`, { method: 'POST', body: { status }, auth: true }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-reports'] }); },
  });
}
