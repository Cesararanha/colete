import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';

import { AppButton } from './AppButton';
import { AppSkeleton } from './AppSkeleton';

type AsyncNoticeProps =
  | { kind: 'loading'; message: string }
  | {
      action: () => void;
      actionLabel: string;
      kind: 'empty' | 'network';
      message: string;
      title: string;
    };

export function AsyncNotice(props: AsyncNoticeProps) {
  const { colors } = useTheme();
  if (props.kind === 'loading') {
    return (
      <View accessibilityLiveRegion="polite" style={styles.loading}>
        <Text style={[styles.message, { color: colors.textMuted }]}>{props.message}</Text>
        <AppSkeleton />
      </View>
    );
  }

  return (
    <View
      accessibilityLiveRegion={props.kind === 'network' ? 'assertive' : 'polite'}
      role={props.kind === 'network' ? 'alert' : undefined}
      style={[styles.notice, { backgroundColor: colors.surfaceStrong, borderColor: colors.border }]}
    >
      <Text style={[styles.title, { color: colors.text }]}>{props.title}</Text>
      <Text style={[styles.message, { color: colors.textMuted }]}>{props.message}</Text>
      <AppButton label={props.actionLabel} onPress={props.action} variant="secondary" />
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { gap: spacing.sm },
  message: { fontSize: 15, lineHeight: 22 },
  notice: { borderRadius: radius.md, borderWidth: 1, gap: spacing.sm, padding: spacing.md },
  title: { fontSize: 18, fontWeight: '800', lineHeight: 24 },
});
