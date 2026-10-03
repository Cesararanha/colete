import { useLocalSearchParams } from 'expo-router';

import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { GroupMembersScreen } from '@/features/groups/GroupMembersScreen';
import { pt } from '@/lib/i18n/pt';

export default function GroupAdministrationRoute() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  return (
    <AuthGateScreen
      page={pt.groups.members}
      renderAuthenticated={(profile) => <GroupMembersScreen groupId={groupId} profile={profile} />}
    />
  );
}
