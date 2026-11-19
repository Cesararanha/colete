import type { Metadata } from 'expo-router/server';
import { useLocalSearchParams } from 'expo-router';

import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { GroupSettingsScreen } from '@/features/groups/GroupSettingsScreen';
import { pt } from '@/lib/i18n/pt';

export default function GroupAdministrationRoute() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  return (
    <AuthGateScreen
      page={pt.groups.settings}
      renderAuthenticated={(profile) => <GroupSettingsScreen groupId={groupId} profile={profile} />}
    />
  );
}

export function generateMetadata(): Metadata {
  return { title: pt.app.pageTitle(pt.groups.settings.title) };
}
