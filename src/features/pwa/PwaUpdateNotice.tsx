import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { usePwaUpdate } from './usePwaUpdate';

export function PwaUpdateNotice() {
  const { activate, available } = usePwaUpdate();
  const { colors } = useTheme();

  if (!available) {
    return null;
  }

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.notice, { backgroundColor: colors.surfaceRaised }]}
    >
      <View style={styles.copy}>
        <Text aria-level={2} role="heading" style={[styles.title, { color: colors.text }]}>
          {pt.pwa.updateTitle}
        </Text>
        <Text style={[styles.body, { color: colors.textMuted }]}>{pt.pwa.updateBody}</Text>
      </View>
      <AppButton label={pt.pwa.updateAction} onPress={activate} />
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    ...typography.support,
  },
  copy: {
    flex: 1,
    gap: spacing.xs,
  },
  notice: {
    alignItems: 'center',
    borderRadius: radius.row,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    padding: spacing.md,
  },
  title: {
    ...typography.row,
  },
});
