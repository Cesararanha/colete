import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { useCallback, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import type { OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { privateQueryKeys } from '@/lib/private-queries';
import { radius, size } from '@/theme/spacing';

import { Avatar } from './Avatar';

/**
 * The way to the profile on every authenticated screen (prévia aprovada): the
 * person's initials at the top right, a real link to /perfil. It only reads
 * the own-profile result the auth gate keeps in the cache: no observer, no
 * request. A fetching observer here refetched on every remount of the top
 * bar, and after a failed read the gate's loading and error screens remounted
 * it in a loop of requests (CI of #74). With no profile (loading, an error, a
 * pending deletion) it renders nothing.
 */
export function ProfileAvatarLink() {
  const client = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => client.getQueryCache().subscribe(onChange),
    [client],
  );
  const read = useCallback(
    () => client.getQueryData<OwnProfile | null>(privateQueryKeys.ownProfile),
    [client],
  );
  const own = useSyncExternalStore(subscribe, read, read);
  if (!own) return null;
  return (
    <Link asChild href="/perfil">
      <Pressable
        accessibilityLabel={pt.navigation.openProfile(own.name)}
        accessibilityRole="link"
        style={styles.target}
        testID="profile-avatar-link"
      >
        <Avatar id={own.id} name={own.name} size={44} />
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  target: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: size.compact,
    justifyContent: 'center',
    width: size.compact,
  },
});
