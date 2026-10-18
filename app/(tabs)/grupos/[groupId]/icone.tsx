import { useLocalSearchParams } from 'expo-router';

import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { GroupAppearanceScreen } from '@/features/groups/GroupAppearanceScreen';
import { pt } from '@/lib/i18n/pt';

export default function GroupAppearanceRoute() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  return (
    <AuthGateScreen
      page={pt.groups.appearance}
      renderAuthenticated={(profile) => (
        <GroupAppearanceScreen groupId={groupId} profile={profile} />
      )}
    />
  );
}
