import Head from 'expo-router/head';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppIcon } from '@/components/ui/AppIcon';
import { AppShell } from '@/components/ui/AppShell';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppTextField } from '@/components/ui/AppTextField';
import { Scoreboard } from '@/components/ui/Scoreboard';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { pt } from '@/lib/i18n/pt';
import { colors as palettes, type ThemeColors } from '@/theme/colors';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

const copy = pt.designSystem;
const noop = () => undefined;

function Section({ children, title }: { children: ReactNode; title: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.section}>
      <Text aria-level={2} role="heading" style={[styles.sectionTitle, { color: colors.text }]}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Palette({ name, palette }: { name: string; palette: ThemeColors }) {
  const { colors } = useTheme();
  return (
    <AppCard>
      <Text aria-level={3} role="heading" style={[styles.subTitle, { color: colors.text }]}>
        {name}
      </Text>
      <View style={styles.swatches}>
        {(Object.entries(palette) as [keyof ThemeColors, string][]).map(([token, value]) => (
          <View key={token} style={styles.swatch}>
            <View
              style={[styles.chip, { backgroundColor: value, borderColor: colors.fieldBorder }]}
            />
            <View style={styles.swatchText}>
              <Text style={[styles.token, { color: colors.text }]}>{token}</Text>
              <Text style={[styles.hex, { color: colors.textMuted }]}>{value}</Text>
            </View>
          </View>
        ))}
      </View>
    </AppCard>
  );
}

const typeSamples = [
  ['display', 'Display 32 · Barlow 700'],
  ['title', 'Título 22 · Barlow 600'],
  ['row', 'Linha 18 · Barlow 600'],
  ['body', 'Corpo 17 · Barlow 400'],
  ['support', 'Apoio 15 · Barlow 400'],
  ['overline', 'Rótulo do placar 13 · caixa alta'],
  ['navigation', 'Navegação 13 · Barlow 600'],
] as const;

/**
 * docs/29 §8: static catalog, no user data, same public access as /foundation.
 */
export function DesignSystemScreen() {
  const { colors } = useTheme();
  return (
    <AppShell>
      <Head>
        <title>{pt.app.pageTitle(copy.title)}</title>
      </Head>
      <SectionHeading description={copy.intro} eyebrow={pt.app.name} title={copy.title} />

      <Section title={copy.scoreboard}>
        <Scoreboard
          accessibilityLabel={copy.scoreboardSample}
          groups={[{ chars: '18' }, { chars: '30', reference: true }]}
        />
        <Text style={[styles.caption, { color: colors.textMuted }]}>{copy.scoreboardXl}</Text>
        <Scoreboard
          decorative
          groups={[{ chars: 'K7M2Q' }, { chars: '9XRT4' }]}
          layout="stacked"
          size="lg"
        />
        <Text selectable style={[styles.code, { color: colors.text }]}>
          K7M2Q-9XRT4
        </Text>
        <Text style={[styles.caption, { color: colors.textMuted }]}>{copy.scoreboardLg}</Text>
      </Section>

      <Section title={copy.colors}>
        <Palette name={copy.lightTheme} palette={palettes.light} />
        <Palette name={copy.darkTheme} palette={palettes.dark} />
      </Section>

      <Section title={copy.typography}>
        <AppCard>
          {typeSamples.map(([key, label]) => (
            <Text key={key} style={[typography[key], { color: colors.text }]}>
              {label}
            </Text>
          ))}
        </AppCard>
      </Section>

      <Section title={copy.spacing}>
        <AppCard>
          <Text style={[styles.subLabel, { color: colors.text }]}>{copy.spacingScale}</Text>
          {Object.entries(spacing).map(([key, value]) => (
            <View key={key} style={styles.measure}>
              <View style={[styles.bar, { backgroundColor: colors.textMuted, width: value * 4 }]} />
              <Text style={[styles.hex, { color: colors.textMuted }]}>
                {key} · {value}
              </Text>
            </View>
          ))}
          <Text style={[styles.subLabel, { color: colors.text }]}>{copy.radii}</Text>
          <View style={styles.radii}>
            {Object.entries(radius)
              .filter(([key]) => key !== 'pill')
              .map(([key, value]) => (
                <View key={key} style={styles.radiusItem}>
                  <View
                    style={[
                      styles.radiusBox,
                      { borderColor: colors.fieldBorder, borderRadius: value },
                    ]}
                  />
                  <Text style={[styles.hex, { color: colors.textMuted }]}>
                    {key} · {value}
                  </Text>
                </View>
              ))}
          </View>
        </AppCard>
      </Section>

      <Section title={copy.buttons}>
        <AppButton icon="plus" label={copy.primary} onPress={noop} />
        <AppButton icon="users" label={copy.secondary} onPress={noop} variant="secondary" />
        <AppButton icon="hash" label={copy.tertiary} onPress={noop} variant="tertiary" />
        <AppButton icon="slash" label={copy.destructive} onPress={noop} variant="destructive" />
        <AppButton label={copy.selected} onPress={noop} pressed variant="secondary" />
      </Section>

      <Section title={copy.field}>
        <AppTextField hint={copy.fieldHint} label={copy.fieldLabel} />
        <View aria-hidden style={styles.focusDemo}>
          <View style={[styles.focusRing, { borderColor: colors.focus }]}>
            <View
              style={[
                styles.focusField,
                { backgroundColor: colors.surfaceRaised, borderColor: colors.fieldBorder },
              ]}
            />
          </View>
        </View>
        <Text style={[styles.caption, { color: colors.textMuted }]}>{copy.fieldFocus}</Text>
        <AppTextField error={copy.fieldError} label={copy.fieldLabel} value="A" />
      </Section>

      <Section title={copy.card}>
        <AppCard>
          <SectionHeading eyebrow={copy.cardEyebrow} title={copy.cardTitle} />
          <AppButton
            icon="chevron-right"
            iconPosition="trailing"
            label={copy.cardAction}
            onPress={noop}
            variant="secondary"
          />
        </AppCard>
      </Section>

      <Section title={copy.states}>
        <AppAlert message={copy.alertSample} />
        <AppStatus message={copy.statusSample} />
        <View style={styles.pending}>
          <AppIcon color={colors.warning} name="clock" />
          <Text style={[styles.pendingText, { color: colors.warning }]}>{copy.pendingSample}</Text>
        </View>
        <Text style={[styles.subLabel, { color: colors.text }]}>{copy.skeleton}</Text>
        <AppSkeleton lines={3} />
      </Section>
    </AppShell>
  );
}

const styles = StyleSheet.create({
  bar: { borderRadius: radius.pill, height: 8 },
  caption: { ...typography.support },
  chip: { borderRadius: radius.field, borderWidth: 1, height: 40, width: 40 },
  code: { ...typography.row, letterSpacing: 2, textAlign: 'center' },
  focusDemo: { alignItems: 'stretch' },
  focusField: { borderRadius: radius.field, borderWidth: 1, height: 56 },
  focusRing: { borderRadius: radius.field + 4, borderWidth: 2, padding: 2 },
  hex: { ...typography.support, fontVariant: ['tabular-nums'] },
  measure: { alignItems: 'center', flexDirection: 'row', gap: spacing.ms },
  pending: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  pendingText: { ...typography.supportStrong },
  radii: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  radiusBox: { borderWidth: 2, height: 56, width: 56 },
  radiusItem: { alignItems: 'center', gap: spacing.xs },
  section: { gap: spacing.md },
  sectionTitle: { ...typography.title },
  subLabel: { ...typography.supportStrong },
  subTitle: { ...typography.row },
  swatch: {
    alignItems: 'center',
    flexDirection: 'row',
    flexBasis: 120,
    flexGrow: 1,
    gap: spacing.ms,
  },
  swatchText: { flexShrink: 1, minWidth: 0 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  token: { ...typography.supportStrong },
});
