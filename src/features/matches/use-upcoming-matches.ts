import { useQuery } from '@tanstack/react-query';

import { api, type OwnProfile } from '@/lib/api';
import { PRIVATE_QUERY_ROOT, withCurrentAccessToken } from '@/lib/private-queries';

export const matchesQueryKey = (profileId: string) => [PRIVATE_QUERY_ROOT, 'matches', profileId];

/**
 * The person's upcoming matches in every active group, with the occupancy of
 * each and whether they organise any group. The Agenda shows them all; the
 * group detail filters its own from the same cached read.
 */
export function useUpcomingMatches(profile: OwnProfile) {
  return useQuery({
    queryKey: matchesQueryKey(profile.id),
    queryFn: () =>
      withCurrentAccessToken(async (token) => {
        const [matches, groups, occupancy] = await Promise.all([
          api.getUpcomingMatches(),
          api.getOwnGroups(profile.id, token),
          api.getMatchesOccupancy(),
        ]);
        return {
          matches,
          occupancy: new Map(occupancy.map((row) => [row.match_id, row])),
          canCreate: groups.some((group) => group.role === 'owner' || group.role === 'organizer'),
        };
      }),
  });
}
