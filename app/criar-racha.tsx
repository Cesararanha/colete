import { useLocalSearchParams } from 'expo-router';

import { ShellChromeContext } from '@/components/ui/AuthenticatedShell';
import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { CreateMatchScreen } from '@/features/matches/CreateMatchScreen';
import { pt } from '@/lib/i18n/pt';

// Presented as a modal by the root Stack (app/_layout.tsx): no tab bar, a
// close button instead of a back link.
export default function CreateMatchRoute() {
  const { groupId } = useLocalSearchParams<{ groupId?: string }>();
  return (
    <ShellChromeContext.Provider value>
      <AuthGateScreen
        page={pt.matches.create}
        renderAuthenticated={(profile) => (
          <CreateMatchScreen initialGroupId={groupId} profile={profile} />
        )}
      />
    </ShellChromeContext.Provider>
  );
}
