import { useLocalSearchParams } from 'expo-router';

import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { MatchDetailScreen } from '@/features/matches/MatchDetailScreen';
import { pt } from '@/lib/i18n/pt';

export default function MatchDetailRoute() {
  const { matchId } = useLocalSearchParams<{ matchId: string }>();
  return (
    <AuthGateScreen
      page={pt.matches.detail}
      renderAuthenticated={(profile) => <MatchDetailScreen matchId={matchId} profile={profile} />}
    />
  );
}
