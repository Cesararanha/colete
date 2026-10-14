import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { ChangePasswordScreen } from '@/features/profile/ChangePasswordScreen';
import { pt } from '@/lib/i18n/pt';

export default function ChangePasswordRoute() {
  return (
    <AuthGateScreen
      page={pt.profile.passwordChange}
      renderAuthenticated={(_profile, session) => <ChangePasswordScreen session={session} />}
    />
  );
}
