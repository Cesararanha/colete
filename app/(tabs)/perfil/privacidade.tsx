import type { Metadata } from 'expo-router/server';
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

export function generateMetadata(): Metadata {
  return { title: pt.app.pageTitle(pt.privacy.screen.title) };
}
