import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Session } from '@supabase/supabase-js';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { AppError, api, TransportError, type MutationIntent, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';

import { ProfileDataForm } from './ProfileDataForm';
import { profileErrorMessage } from './profile-errors';
import { ProfilePasswordForm } from './ProfilePasswordForm';

export function linkedProviderLabels(session: Session): string[] {
  const identityProviders = (session.user.identities ?? []).map((identity) => identity.provider);
  const metadataProviders = Array.isArray(session.user.app_metadata['providers'])
    ? session.user.app_metadata['providers'].filter(
        (provider): provider is string => typeof provider === 'string',
      )
    : [];
  const providers = [...new Set([...identityProviders, ...metadataProviders])];
  if (providers.length === 0 && typeof session.user.app_metadata['provider'] === 'string') {
    providers.push(session.user.app_metadata['provider']);
  }
  return providers.map((provider) => {
    if (provider === 'email') return pt.profile.provider.email;
    if (provider === 'google') return pt.profile.provider.google;
    return pt.profile.provider.other(provider);
  });
}

function ProfileSectionToggle({
  expanded,
  label,
  onPress,
}: {
  expanded: boolean;
  label: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      aria-expanded={expanded}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toggle,
        {
          backgroundColor: expanded ? colors.surfaceStrong : colors.surface,
          borderColor: expanded ? colors.primary : colors.border,
          opacity: pressed ? 0.78 : 1,
        },
      ]}
    >
      <Text style={[styles.toggleLabel, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

export function ProfileScreen({ profile, session }: { profile: OwnProfile; session: Session }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const [dataEditing, setDataEditing] = useState(false);
  const [dataSaved, setDataSaved] = useState(false);
  const [passwordEditing, setPasswordEditing] = useState(false);
  const logoutIntent = useRef<MutationIntent<unknown> | null>(null);
  const logout = useMutation({
    mutationFn: async () => {
      logoutIntent.current ??= api.revokeCurrentSession();
      await logoutIntent.current.execute();
      await api.signOutLocally();
    },
    onSuccess: async () => {
      logoutIntent.current = null;
      await queryClient.resetQueries();
      router.replace('/entrar');
    },
  });
  const canRetry =
    logout.error instanceof TransportError ||
    (logout.error instanceof AppError && logout.error.retryable);
  const providers = linkedProviderLabels(session);
  const missingValue = pt.profile.data.notInformed;
  const position =
    pt.profile.positionOptions.find((option) => option.value === profile.position)?.label ??
    missingValue;
  const dominantFoot =
    pt.profile.footOptions.find((option) => option.value === profile.dominant_foot)?.label ??
    missingValue;
  const details = [
    { label: pt.profile.fields.name, value: profile.name.trim() || missingValue },
    { label: pt.profile.fields.nickname, value: profile.nickname?.trim() || missingValue },
    { label: pt.profile.fields.position, value: position },
    { label: pt.profile.fields.dominantFoot, value: dominantFoot },
    {
      label: pt.profile.fields.shirtNumber,
      value: profile.shirt_number === null ? missingValue : String(profile.shirt_number),
    },
  ];

  return (
    <AuthenticatedShell
      description={pt.profile.description}
      eyebrow={pt.profile.eyebrow}
      title={pt.profile.title}
    >
      <AppCard testID="profile-data-card">
        <SectionHeading
          description={pt.profile.data.description}
          eyebrow={pt.profile.data.eyebrow}
          title={pt.profile.data.title}
        />
        {dataSaved ? <AppStatus message={pt.profile.data.saved} /> : null}
        {dataEditing ? (
          <>
            <ProfileSectionToggle
              expanded
              label={pt.profile.actions.editPersonalInformation}
              onPress={() => setDataEditing(false)}
            />
            <ProfileDataForm
              onSaved={() => {
                setDataEditing(false);
                setDataSaved(true);
              }}
              profile={profile}
            />
            <AppButton
              label={pt.profile.actions.cancel}
              onPress={() => setDataEditing(false)}
              variant="secondary"
            />
          </>
        ) : (
          <>
            <View style={styles.details}>
              {details.map((detail) => (
                <View
                  key={detail.label}
                  style={[styles.detail, { borderBottomColor: colors.border }]}
                >
                  <Text style={[styles.detailLabel, { color: colors.textMuted }]}>
                    {detail.label}
                  </Text>
                  <Text style={[styles.detailValue, { color: colors.text }]}>{detail.value}</Text>
                </View>
              ))}
            </View>
            <ProfileSectionToggle
              expanded={false}
              label={pt.profile.actions.editPersonalInformation}
              onPress={() => {
                setDataSaved(false);
                setDataEditing(true);
              }}
            />
          </>
        )}
      </AppCard>

      <AppCard testID="profile-provider-card">
        <SectionHeading
          description={pt.profile.provider.description}
          eyebrow={pt.profile.provider.eyebrow}
          title={pt.profile.provider.title}
        />
        <View style={styles.providers}>
          {(providers.length === 0 ? [pt.profile.provider.unavailable] : providers).map(
            (provider) => (
              <Text key={provider} style={[styles.provider, { color: colors.text }]}>
                {provider}
              </Text>
            ),
          )}
        </View>
      </AppCard>

      <AppCard testID="profile-password-card">
        <SectionHeading
          description={pt.profile.password.description}
          eyebrow={pt.profile.password.eyebrow}
          title={pt.profile.password.title}
        />
        <ProfileSectionToggle
          expanded={passwordEditing}
          label={pt.profile.actions.changePassword}
          onPress={() => setPasswordEditing((current) => !current)}
        />
        {passwordEditing ? (
          <>
            <ProfilePasswordForm />
            <AppButton
              label={pt.profile.actions.cancel}
              onPress={() => setPasswordEditing(false)}
              variant="secondary"
            />
          </>
        ) : null}
      </AppCard>

      <AppCard testID="profile-session-card">
        <SectionHeading
          description={pt.profile.session.description}
          eyebrow={pt.profile.session.eyebrow}
          title={pt.profile.session.title}
        />
        {logout.error === null ? null : <AppAlert message={profileErrorMessage(logout.error)} />}
        <AppButton
          label={logout.isPending ? pt.common.sending : pt.profile.session.logout}
          onPress={() => {
            if (!logout.isPending) logout.mutate();
          }}
          variant="secondary"
        />
        {canRetry ? (
          <AppButton label={pt.common.retry} onPress={() => logout.mutate()} variant="secondary" />
        ) : null}
      </AppCard>
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  detail: {
    alignItems: 'baseline',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
    minHeight: 40,
    paddingVertical: spacing.sm,
  },
  detailLabel: { fontSize: 14, fontWeight: '700', lineHeight: 20 },
  details: { gap: spacing.xs },
  detailValue: { fontSize: 16, fontWeight: '800', lineHeight: 22 },
  provider: { fontSize: 16, fontWeight: '700', lineHeight: 24 },
  providers: { gap: spacing.sm },
  toggle: {
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  toggleLabel: { fontSize: 16, fontWeight: '700', lineHeight: 22 },
});
