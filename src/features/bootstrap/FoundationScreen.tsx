import { StyleSheet, Text, View } from 'react-native';

import { AppCard } from '@/components/ui/AppCard';
import { AppNavLink } from '@/components/ui/AppNavLink';
import { AppShell } from '@/components/ui/AppShell';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

export function FoundationScreen() {
  const { colors } = useTheme();
  const cards = [
    [pt.foundation.architectureTitle, pt.foundation.architectureBody],
    [pt.foundation.accessibilityTitle, pt.foundation.accessibilityBody],
    [pt.foundation.securityTitle, pt.foundation.securityBody],
  ] as const;

  return (
    <AppShell activeRoute="foundation">
      <SectionHeading
        description={pt.foundation.description}
        eyebrow={pt.foundation.eyebrow}
        title={pt.foundation.title}
      />
      <View style={styles.cards}>
        {cards.map(([title, body]) => (
          <AppCard key={title}>
            <Text aria-level={2} role="heading" style={[styles.title, { color: colors.text }]}>
              {title}
            </Text>
            <Text style={[styles.body, { color: colors.textMuted }]}>{body}</Text>
          </AppCard>
        ))}
      </View>
      <View style={styles.catalog}>
        <AppNavLink href="/design-system" label={pt.designSystem.link} />
      </View>
    </AppShell>
  );
}

const styles = StyleSheet.create({
  body: {
    ...typography.body,
  },
  catalog: { alignItems: 'flex-start' },
  cards: {
    gap: spacing.md,
  },
  title: {
    ...typography.title,
  },
});
