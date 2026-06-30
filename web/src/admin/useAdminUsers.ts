import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { AdminUser } from '../types/api';

export function useAdminUsers(): ReturnType<typeof useQuery<AdminUser[]>> {
  return useQuery<AdminUser[]>({
    queryKey: ['admin-users'],
    queryFn: () => apiFetch<AdminUser[]>('/admin/users', { auth: true }),
  });
}
