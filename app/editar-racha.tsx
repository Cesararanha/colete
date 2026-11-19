import type { Metadata } from 'expo-router/server';
import { useLocalSearchParams } from 'expo-router';

import { ShellChromeContext } from '@/components/ui/AuthenticatedShell';
import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { CreateMatchScreen } from '@/features/matches/CreateMatchScreen';
import { pt } from '@/lib/i18n/pt';

// "Editar" on the match detail opens the create form filled in, as a modal of
// the root Stack (app/_layout.tsx), like Criar racha.
export default function EditMatchRoute() {
  const { matchId } = useLocalSearchParams<{ matchId?: string }>();
  return (
    <ShellChromeContext.Provider value>
      <AuthGateScreen
        page={{ title: pt.matches.create.editTitle, description: '' }}
        renderAuthenticated={(profile) => (
          <CreateMatchScreen editMatchId={matchId ?? ''} profile={profile} />
        )}
      />
    </ShellChromeContext.Provider>
  );
}

export function generateMetadata(): Metadata {
  return { title: pt.app.pageTitle(pt.matches.create.editTitle) };
}
