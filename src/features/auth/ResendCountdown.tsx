import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/**
 * Ticks once a second and says whether a code may be sent again: never
 * before `availableAt`, with the seconds left and the absolute time (docs/15:
 * the resend says the time, not only a countdown).
 */
export function useResendClock(availableAt: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return {
    canResend: availableAt === null || now >= availableAt,
    seconds: Math.max(0, Math.ceil(((availableAt ?? now) - now) / 1_000)),
    time: new Date(availableAt ?? now).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    }),
  };
}

/** What stands in the place of "Reenviar código" while the wait lasts. */
export function ResendCountdown({ seconds, time }: { seconds: number; time: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.container}>
      <Text
        accessibilityLiveRegion="none"
        style={[styles.status, { color: colors.textMuted }]}
        testID="resend-countdown"
      >
        {pt.auth.otp.resendCountdown(seconds)}
      </Text>
      <Text style={[styles.status, { color: colors.textMuted }]}>{pt.auth.otp.resendAt(time)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  status: { ...typography.support },
});
