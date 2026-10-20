import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';

/** Both rating reads live under one key per person and group, so a change re-reads them together. */
export const ratingsKey = (profileId: string, groupId: string) =>
  [PRIVATE_QUERY_ROOT, 'ratings', profileId, groupId] as const;

export function useGroupRatings(profileId: string, groupId: string | undefined, enabled = true) {
  return useQuery({
    enabled: enabled && groupId !== undefined,
    queryKey: [...ratingsKey(profileId, groupId ?? ''), 'group'],
    queryFn: ({ signal }) => api.getGroupRatings(groupId ?? '', signal),
  });
}

export function useMyRating(profileId: string, groupId: string) {
  return useQuery({
    queryKey: [...ratingsKey(profileId, groupId), 'mine'],
    queryFn: ({ signal }) => api.getMyRating(groupId, signal),
  });
}
