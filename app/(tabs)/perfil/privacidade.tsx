import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { PrivacyAccountScreen } from '@/features/profile/PrivacyAccountScreen';
import { pt } from '@/lib/i18n/pt';

export default function PrivacyAccountRoute() {
  return (
    <AuthGateScreen
      page={pt.privacy.screen}
      renderAuthenticated={(_profile, session) => <PrivacyAccountScreen session={session} />}
    />
  );
}
