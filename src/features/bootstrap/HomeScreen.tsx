import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppCard } from '@/components/ui/AppCard';
import { AppShell } from '@/components/ui/AppShell';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { pt } from '@/lib/i18n/pt';
import { isSmokeMode } from '@/lib/runtime';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';

import { PwaUpdateNotice } from '../pwa/PwaUpdateNotice';
import { SyntheticSmokePanel } from '../smoke/SyntheticSmokePanel';

export function HomeScreen() {
  const { colors } = useTheme();
  const { smoke_identity: smokeIdentity } = useLocalSearchParams<{ smoke_identity?: string }>();

  return (
    <AppShell activeRoute="home">
      <PwaUpdateNotice />
      <SectionHeading
        description={pt.home.description}
        eyebrow={pt.home.eyebrow}
        title={pt.home.title}
      />
      <View style={[styles.status, { backgroundColor: colors.surfaceStrong }]}>
        <Text style={[styles.statusLabel, { color: colors.positive }]}>{pt.home.statusLabel}</Text>
        <Text aria-level={2} role="heading" style={[styles.statusTitle, { color: colors.text }]}>
          {pt.home.statusTitle}
        </Text>
        <Text style={[styles.body, { color: colors.textMuted }]}>{pt.home.statusBody}</Text>
      </View>
      <View style={styles.grid}>
        <AppCard>
          <Text aria-level={2} role="heading" style={[styles.cardTitle, { color: colors.text }]}>
            {pt.home.principlesTitle}
          </Text>
          <View style={styles.list}>
            {pt.home.principles.map((principle) => (
              <View key={principle} style={styles.listItem}>
                <Text
                  accessibilityElementsHidden
                  style={[styles.bullet, { color: colors.primary }]}
                >
                  •
                </Text>
                <Text style={[styles.body, styles.listCopy, { color: colors.textMuted }]}>
                  {principle}
                </Text>
              </View>
            ))}
          </View>
        </AppCard>
        <AppCard>
          <Text aria-level={2} role="heading" style={[styles.cardTitle, { color: colors.text }]}>
            {pt.home.nextTitle}
          </Text>
          <Text style={[styles.body, { color: colors.textMuted }]}>{pt.home.nextBody}</Text>
        </AppCard>
      </View>
      {isSmokeMode() ? (
        <SyntheticSmokePanel {...(smokeIdentity ? { identity: smokeIdentity } : {})} />
      ) : null}
    </AppShell>
  );
}

const styles = StyleSheet.create({
  body: {
    fontSize: 16,
    lineHeight: 25,
  },
  bullet: {
    fontSize: 22,
    lineHeight: 25,
  },
  cardTitle: {
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 28,
  },
  grid: {
    gap: spacing.md,
  },
  list: {
    gap: spacing.sm,
  },
  listCopy: {
    flex: 1,
  },
  listItem: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  status: {
    borderRadius: radius.md,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  statusLabel: {
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 20,
    textTransform: 'uppercase',
  },
  statusTitle: {
    fontSize: 26,
    fontWeight: '900',
    lineHeight: 32,
  },
});
