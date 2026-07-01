import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { ReportReason } from '../types/api';

export function useReport(): ReturnType<typeof useMutation<unknown, Error, { reportedUserId: string; reason: ReportReason; details?: string }>> {
  return useMutation<unknown, Error, { reportedUserId: string; reason: ReportReason; details?: string }>({
    mutationFn: (body) => apiFetch('/reports', { method: 'POST', body, auth: true }),
  });
}
