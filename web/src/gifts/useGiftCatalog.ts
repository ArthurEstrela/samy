import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { GiftType } from '../types/api';

export function useGiftCatalog(): ReturnType<typeof useQuery<GiftType[]>> {
  return useQuery<GiftType[]>({
    queryKey: ['gift-catalog'],
    queryFn: () => apiFetch<GiftType[]>('/gifts/catalog', { auth: true }),
  });
}
