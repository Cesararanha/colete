import type { Metadata } from 'expo-router/server';
import { useLocalSearchParams } from 'expo-router';

import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { GroupDetailScreen } from '@/features/groups/GroupDetailScreen';
import { pt } from '@/lib/i18n/pt';

export default function GroupDetailRoute() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  return (
    <AuthGateScreen
      page={pt.groups.detail}
      renderAuthenticated={(profile) => <GroupDetailScreen groupId={groupId} profile={profile} />}
    />
  );
}

export function generateMetadata(): Metadata {
  return { title: pt.app.pageTitle(pt.groups.detail.title) };
}
