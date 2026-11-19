import type { Metadata } from 'expo-router/server';
import { useLocalSearchParams } from 'expo-router';

import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { GroupRatingsScreen } from '@/features/ratings/GroupRatingsScreen';
import { pt } from '@/lib/i18n/pt';

export default function GroupRatingsRoute() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  return (
    <AuthGateScreen
      page={pt.ratings}
      renderAuthenticated={(profile) => <GroupRatingsScreen groupId={groupId} profile={profile} />}
    />
  );
}

export function generateMetadata(): Metadata {
  return { title: pt.app.pageTitle(pt.ratings.title) };
}
