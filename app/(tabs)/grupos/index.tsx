import { useLocalSearchParams } from 'expo-router';

import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { GroupsListScreen } from '@/features/groups/GroupsListScreen';
import { pt } from '@/lib/i18n/pt';

export default function GroupsRoute() {
  const { left, requested } = useLocalSearchParams<{ left?: string; requested?: string }>();
  return (
    <AuthGateScreen
      // Grupos shows only its title and scoreboard: no description.
      page={{ description: '', title: pt.groups.list.title }}
      renderAuthenticated={(profile) => (
        <GroupsListScreen left={left === '1'} profile={profile} requested={requested === '1'} />
      )}
    />
  );
}
