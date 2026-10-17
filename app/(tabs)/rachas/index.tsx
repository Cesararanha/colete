import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { MatchesListScreen } from '@/features/matches/MatchesListScreen';
import { pt } from '@/lib/i18n/pt';

export default function MatchesRoute() {
  return (
    <AuthGateScreen
      page={{ description: '', title: pt.matches.list.title }}
      renderAuthenticated={(profile) => <MatchesListScreen profile={profile} />}
    />
  );
}
