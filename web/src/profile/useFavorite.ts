import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';

export function useFavorite(id: string): { toggle: (isFavorite: boolean) => void; pending: boolean } {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (isFavorite: boolean) =>
      apiFetch(`/favorites/${id}`, { method: isFavorite ? 'DELETE' : 'POST', auth: true }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['model', id] }); },
  });
  return { toggle: (isFavorite: boolean) => mutation.mutate(isFavorite), pending: mutation.isPending };
}
