import * as DocumentPicker from 'expo-document-picker';
import { Link } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { pt } from '@/lib/i18n/pt';
import { SYNTHETIC_IDENTITY } from '@/lib/runtime';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

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
        <Text style={[styles.eyebrow, { color: colors.primary }]}>{pt.smoke.eyebrow}</Text>
        <Text aria-level={2} role="heading" style={[styles.title, { color: colors.text }]}>
          {pt.smoke.title}
        </Text>
        <Text style={[styles.body, { color: colors.textMuted }]}>{pt.smoke.description}</Text>
      </View>
      <View style={styles.actions}>
        <Link
          href={{ pathname: '/smoke-auth-callback', params: { identity: SYNTHETIC_IDENTITY } }}
          asChild
        >
          <Pressable
            accessibilityLabel={pt.smoke.authAction}
            accessibilityRole="link"
            style={({ pressed }) => [
              styles.authLink,
              {
                backgroundColor: colors.primary,
                borderColor: colors.primary,
                opacity: pressed ? 0.78 : 1,
              },
            ]}
          >
            <Text style={[styles.authLinkText, { color: colors.onPrimary }]}>
              {pt.smoke.authAction}
            </Text>
          </Pressable>
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
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  authLinkText: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
  },
  copy: {
    gap: spacing.sm,
  },
  eyebrow: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
    lineHeight: 18,
    textTransform: 'uppercase',
  },
  result: {
    gap: spacing.xs,
  },
  resultLabel: {
    fontSize: 15,
    fontWeight: '800',
    lineHeight: 21,
  },
  resultText: {
    fontSize: 15,
    lineHeight: 22,
  },
  title: {
    fontSize: 24,
    fontWeight: '900',
    lineHeight: 30,
  },
});
