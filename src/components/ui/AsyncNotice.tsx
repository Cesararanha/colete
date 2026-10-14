import { StyleSheet, Text, View } from 'react-native';

import { raisedShadow } from '@/theme/elevation';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { AppButton } from './AppButton';
import { AppIcon } from './AppIcon';
import { AppSkeleton } from './AppSkeleton';
import { SurfaceContext } from './SurfaceContext';

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
  const { colors, mode } = useTheme();
  if (props.kind === 'loading') {
    return (
      <View accessibilityLiveRegion="polite" style={styles.loading}>
        <Text style={[styles.message, { color: colors.textMuted }]}>{props.message}</Text>
        <AppSkeleton />
      </View>
    );
  }

  const network = props.kind === 'network';
  return (
    <View style={[styles.notice, { backgroundColor: colors.surfaceRaised }, raisedShadow(mode)]}>
      <AppIcon
        color={network ? colors.critical : colors.textMuted}
        name={network ? 'wifi-off' : 'inbox'}
        size={24}
      />
      <View
        accessibilityLiveRegion={network ? 'assertive' : 'polite'}
        role={network ? 'alert' : undefined}
        style={styles.body}
      >
        <Text style={[styles.title, { color: colors.text }]}>{props.title}</Text>
        <Text style={[styles.message, { color: colors.textMuted }]}>{props.message}</Text>
        <SurfaceContext.Provider value="raised">
          <AppButton label={props.actionLabel} onPress={props.action} variant="secondary" />
        </SurfaceContext.Provider>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.sm, minWidth: 0 },
  loading: { gap: spacing.sm },
  message: { ...typography.support },
  notice: { borderRadius: radius.row, gap: spacing.ms, padding: spacing.lg },
  title: { ...typography.row },
});
