import { useQuery } from '@tanstack/react-query';

import { api, type OwnProfile, type PhotoUrls } from '../../lib/api';
import {
  PRIVATE_QUERY_ROOT,
  privateQueryKeys,
  usableAccessToken,
  useSessionQuery,
} from '../../lib/private-queries';
import { queryClient } from '../../lib/query-client';

export type PhotoKind = 'profile' | 'group';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The gateway's ceiling per kind and per call. */
const BATCH = 100;
// The read URLs live five minutes on the server. A cached one is used for
// four, then asked again on the next screen that shows it.
export const PHOTO_URL_STALE_MS = 4 * 60_000;

/** Under the private root: signing out clears every photo URL with the rest. */
export function photoQueryKey(kind: PhotoKind, id: string) {
  return [PRIVATE_QUERY_ROOT, 'photo', kind, id] as const;
}

type Waiter = { resolve: (url: string | null) => void; reject: (error: unknown) => void };
type Pending = { profiles: Map<string, Waiter[]>; groups: Map<string, Waiter[]> };

/**
 * Every avatar and group icon on a screen asks at once; one call answers all
 * of them. The read goes out on the next tick with the IDs collected so far,
 * so a list of members costs one request instead of one per row. The person's
 * own avatar is asked by the `self` flag instead of their ID: no request body
 * carries the caller's identifiers (docs/22 section 6).
 */
export function createPhotoLoader(
  read: (profileIds: string[], groupIds: string[], self: boolean) => Promise<PhotoUrls>,
  absolute: (relative: string) => string,
  ownId: () => string | undefined,
  schedule: (flush: () => void) => void = (flush) => setTimeout(flush, 0),
) {
  let pending: Pending | null = null;

  async function send(batch: Pending) {
    const own = ownId();
    const self = own !== undefined && batch.profiles.has(own);
    const profiles = [...batch.profiles.keys()].filter((id) => id !== own);
    const groups = [...batch.groups.keys()];
    const rounds = Math.max(1, Math.ceil(Math.max(profiles.length, groups.length) / BATCH));
    for (let round = 0; round < rounds; round += 1) {
      const start = round * BATCH;
      const profileSlice = profiles.slice(start, start + BATCH);
      const groupSlice = groups.slice(start, start + BATCH);
      const withSelf = self && round === 0;
      if (profileSlice.length === 0 && groupSlice.length === 0 && !withSelf) continue;
      try {
        const urls = await read(profileSlice, groupSlice, withSelf);
        if (withSelf) {
          for (const waiter of batch.profiles.get(own) ?? []) {
            waiter.resolve(typeof urls.self === 'string' ? absolute(urls.self) : null);
          }
        }
        for (const id of profileSlice) {
          const url = urls.profiles[id];
          for (const waiter of batch.profiles.get(id) ?? []) {
            waiter.resolve(typeof url === 'string' ? absolute(url) : null);
          }
        }
        for (const id of groupSlice) {
          const url = urls.groups[id];
          for (const waiter of batch.groups.get(id) ?? []) {
            waiter.resolve(typeof url === 'string' ? absolute(url) : null);
          }
        }
      } catch (error) {
        if (withSelf) batch.profiles.get(own)?.forEach((w) => w.reject(error));
        for (const id of profileSlice) batch.profiles.get(id)?.forEach((w) => w.reject(error));
        for (const id of groupSlice) batch.groups.get(id)?.forEach((w) => w.reject(error));
      }
    }
  }

  return function load(kind: PhotoKind, id: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      if (pending === null) {
        const batch: Pending = { profiles: new Map(), groups: new Map() };
        pending = batch;
        schedule(() => {
          pending = null;
          void send(batch);
        });
      }
      const waiters = kind === 'profile' ? pending.profiles : pending.groups;
      waiters.set(id, [...(waiters.get(id) ?? []), { resolve, reject }]);
    });
  };
}

const loadPhoto = createPhotoLoader(
  (profileIds, groupIds, self) => api.getPhotoUrls(profileIds, groupIds, self),
  (relative) => api.supabaseUrl(relative),
  () => queryClient.getQueryData<OwnProfile | null>(privateQueryKeys.ownProfile)?.id,
);

/**
 * The signed URL of a person's or a group's photo, or null: no photo, or a
 * photo this person may not see. The answer is the same for both, so the
 * screen draws the initials or the icon either way.
 */
export function usePhotoUrl(kind: PhotoKind, id: string | null | undefined): string | null {
  const session = useSessionQuery();
  const valid = typeof id === 'string' && UUID.test(id);
  const query = useQuery({
    enabled: valid && usableAccessToken(session.data) !== null,
    queryKey: photoQueryKey(kind, valid ? id : ''),
    queryFn: () => loadPhoto(kind, id as string),
    staleTime: PHOTO_URL_STALE_MS,
    gcTime: PHOTO_URL_STALE_MS,
    // A failed read draws the fallback and waits for the next screen: no
    // retry loop behind an avatar that remounts.
    retry: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
  });
  return valid ? (query.data ?? null) : null;
}
