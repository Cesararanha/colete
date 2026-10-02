import { useLocalSearchParams } from 'expo-router';

import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { GroupInvitesScreen } from '@/features/groups/GroupInvitesScreen';
import { pt } from '@/lib/i18n/pt';

export default function GroupInvitesRoute() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  return (
    <AuthGateScreen
      page={pt.groups.invites}
      renderAuthenticated={(profile) => <GroupInvitesScreen groupId={groupId} profile={profile} />}
    />
  );
}
