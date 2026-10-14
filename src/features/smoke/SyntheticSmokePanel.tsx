import * as DocumentPicker from 'expo-document-picker';
import { Link } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { pt } from '@/lib/i18n/pt';
import { SYNTHETIC_IDENTITY } from '@/lib/runtime';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

type SyntheticSmokePanelProps = {
  identity?: string;
};

export function SyntheticSmokePanel({ identity }: SyntheticSmokePanelProps) {
  const { colors } = useTheme();
  const [uploadResult, setUploadResult] = useState<string>(pt.smoke.uploadCanceled);

  const chooseSyntheticFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: false,
      multiple: false,
      type: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    });

    if (result.canceled) {
      setUploadResult(pt.smoke.uploadCanceled);
      return;
    }

    const [asset] = result.assets;
    if (!asset) {
      setUploadResult(pt.smoke.uploadCanceled);
      return;
    }

    setUploadResult(
      pt.smoke.uploadResult(
        asset.name,
        asset.mimeType ?? 'application/octet-stream',
        asset.size ?? 0,
      ),
    );
  };

  return (
    <AppCard testID="synthetic-smoke-panel">
      <View style={styles.copy}>
        <Text style={[styles.eyebrow, { color: colors.textMuted }]}>{pt.smoke.eyebrow}</Text>
        <Text aria-level={2} role="heading" style={[styles.title, { color: colors.text }]}>
          {pt.smoke.title}
        </Text>
        <Text style={[styles.body, { color: colors.textMuted }]}>{pt.smoke.description}</Text>
      </View>
      <View style={styles.actions}>
        <Link
          accessibilityLabel={pt.smoke.authAction}
          href={{ pathname: '/smoke-auth-callback', params: { identity: SYNTHETIC_IDENTITY } }}
          style={[
            styles.authLink,
            {
              backgroundColor: colors.primary,
            },
          ]}
        >
          <Text style={[styles.authLinkText, { color: colors.onPrimary }]}>
            {pt.smoke.authAction}
          </Text>
        </Link>
        <AppButton
          label={pt.smoke.uploadAction}
          onPress={chooseSyntheticFile}
          variant="secondary"
        />
      </View>
      {identity === SYNTHETIC_IDENTITY ? (
        <View accessibilityLiveRegion="polite" style={styles.result} testID="synthetic-auth-result">
          <Text style={[styles.resultLabel, { color: colors.text }]}>
            {pt.smoke.authResultLabel}
          </Text>
          <Text selectable style={[styles.resultText, { color: colors.textMuted }]}>
            {identity}
          </Text>
        </View>
      ) : null}
      <View accessibilityLiveRegion="polite" style={styles.result} testID="synthetic-upload-result">
        <Text style={[styles.resultLabel, { color: colors.text }]}>
          {pt.smoke.uploadResultLabel}
        </Text>
        <Text style={[styles.resultText, { color: colors.textMuted }]}>{uploadResult}</Text>
      </View>
    </AppCard>
  );
}

const styles = StyleSheet.create({
  actions: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  authLink: {
    alignItems: 'center',
    borderRadius: radius.row,
    display: 'flex',
    justifyContent: 'center',
    minHeight: size.button,
    minWidth: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    textDecorationLine: 'none',
  },
  authLinkText: {
    ...typography.bodyStrong,
  },
  body: {
    ...typography.body,
  },
  copy: {
    gap: spacing.sm,
  },
  eyebrow: {
    ...typography.supportStrong,
  },
  result: {
    gap: spacing.xs,
  },
  resultLabel: {
    ...typography.supportStrong,
  },
  resultText: {
    ...typography.support,
  },
  title: {
    ...typography.title,
  },
});
