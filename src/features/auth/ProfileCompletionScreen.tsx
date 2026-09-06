import { AppCard } from '@/components/ui/AppCard';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { pt } from '@/lib/i18n/pt';

import { ProfileCompletionForm } from './ProfileCompletionForm';

export function ProfileCompletionScreen({
  defaultName,
  onCompleted,
}: {
  defaultName: string;
  onCompleted: () => void;
}) {
  return (
    <AuthenticatedShell
      description={pt.auth.profile.description}
      eyebrow={pt.auth.profile.eyebrow}
      title={pt.auth.profile.title}
    >
      <AppCard testID="profile-completion-card">
        <ProfileCompletionForm defaultName={defaultName} onCompleted={onCompleted} />
      </AppCard>
    </AuthenticatedShell>
  );
}
