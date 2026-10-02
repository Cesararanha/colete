import { useLocalSearchParams } from 'expo-router';

import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { GroupsListScreen } from '@/features/groups/GroupsListScreen';
import { pt } from '@/lib/i18n/pt';

export default function GroupsRoute() {
  const { left } = useLocalSearchParams<{ left?: string }>();
  return (
    <AuthGateScreen
      page={pt.groups.list}
      renderAuthenticated={(profile) => <GroupsListScreen left={left === '1'} profile={profile} />}
    />
  );
}
