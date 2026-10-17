import { StyleSheet, Text, View } from 'react-native';
import type { Session } from '@supabase/supabase-js';

import { AppCard } from '@/components/ui/AppCard';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { typography } from '@/theme/typography';

import { DataExportCard } from './DataExportCard';
import { DeleteAccountCard } from './DeleteAccountCard';
import { ProfileBackLink } from './ProfileBackLink';
import { accessMethodSentence, linkedProviders } from './profile-view';

/**
 * "Privacidade e conta" (decisão humana de 14/10/2026): the data export, the
 * sign-in method and account deletion, moved out of the profile unchanged.
 * The two cards keep their own reauthentication, states and contracts; the
 * gate above this screen still swaps it for the deletion shell on success.
 */
export function PrivacyAccountScreen({ session }: { session: Session }) {
  const { colors } = useTheme();

  return (
    <AuthenticatedShell description={pt.privacy.screen.description} title={pt.privacy.screen.title}>
      <ProfileBackLink label={pt.privacy.screen.back} />

      <DataExportCard email={session.user.email ?? null} />

      <AppCard testID="profile-provider-card">
        <SectionHeading
          description={pt.privacy.access.description}
          eyebrow={pt.privacy.access.eyebrow}
          title={pt.privacy.access.title}
        />
        <Text style={[styles.access, { color: colors.text }]} testID="access-method">
          {accessMethodSentence(linkedProviders(session))}
        </Text>
      </AppCard>

      <DeleteAccountCard />
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  access: { ...typography.bodyStrong },
});
