import Ionicons from '@expo/vector-icons/Ionicons';
import Head from 'expo-router/head';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { pt } from '@/lib/i18n/pt';
import { getLayoutMode } from '@/theme/layout';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

import type { AuditEventKind } from './demo-data';
import { findDemoMatch } from './demo-data';
import { PlayerRow } from './PlayerRow';
import { TeamCard } from './TeamCard';

const auditKindLabel = (kind: AuditEventKind) => {
  if (kind === 'draw') return pt.racha.teams.auditKinds.draw;
  if (kind === 'manual_swap') return pt.racha.teams.auditKinds.manualSwap;
  if (kind === 'manual_addition') return pt.racha.teams.auditKinds.manualAddition;
  if (kind === 'star_change') return pt.racha.teams.auditKinds.starChange;
  return pt.racha.teams.auditKinds.republish;
};

export function PublishedTeamsScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const match = findDemoMatch(Array.isArray(id) ? id[0] : id);
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const wide = getLayoutMode(width) === 'wide';
  const [auditExpanded, setAuditExpanded] = useState(false);

  if (!match || match.teams.length === 0) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View role="main" style={styles.missing}>
          <SectionHeading
            description={pt.racha.missing.description}
            eyebrow={pt.racha.teams.eyebrow}
            title={pt.racha.missing.title}
          />
          <AppButton
            label={pt.racha.actions.backToMatches}
            onPress={() => router.replace('/rachas')}
          />
        </View>
      </SafeAreaView>
    );
  }

  const auditToggleLabel = auditExpanded
    ? pt.racha.teams.collapseAudit
    : pt.racha.teams.expandAudit;

  return (
    <>
      <Head>
        <title>{pt.app.pageTitle(pt.racha.teams.title)}</title>
      </Head>
      <SafeAreaView
        edges={['top', 'left', 'right']}
        style={[styles.safeArea, { backgroundColor: colors.background }]}
      >
        <View style={[styles.topBar, { borderColor: colors.border }]}>
          <AppButton
            label={pt.racha.actions.backToMatches}
            onPress={() => router.back()}
            variant="secondary"
          />
        </View>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View role="main" style={[styles.main, wide ? styles.mainWide : styles.mainNarrow]}>
            <View style={styles.intro}>
              <Text style={[styles.eyebrow, { color: colors.primary }]}>
                {pt.racha.teams.eyebrow}
              </Text>
              <Text aria-level={1} role="heading" style={[styles.title, { color: colors.text }]}>
                {pt.racha.teams.title}
              </Text>
              <Text style={[styles.description, { color: colors.textMuted }]}>
                {pt.racha.teams.description}
              </Text>
              <Text style={[styles.matchMeta, { color: colors.text }]}>
                {pt.racha.list.matchMeta(match.dateLabel, match.timeLabel, match.groupName)}
              </Text>
            </View>

            <View style={[styles.teams, wide ? styles.teamsWide : styles.teamsNarrow]}>
              {match.teams.map((team) => (
                <View key={team.id} style={styles.teamColumn}>
                  <TeamCard team={team} />
                </View>
              ))}
            </View>

            <AppCard>
              <SectionHeading
                eyebrow={pt.racha.teams.goalkeepersEyebrow}
                title={pt.racha.teams.goalkeepersTitle}
              />
              <View style={styles.rows}>
                {match.goalkeepers.map((goalkeeper) => (
                  <PlayerRow
                    key={goalkeeper.id}
                    leadingLabel={pt.racha.detail.goalkeeperAbbreviation}
                    meta={
                      goalkeeper.pays && goalkeeper.amount
                        ? pt.racha.detail.goalkeeperPays(goalkeeper.amount)
                        : pt.racha.detail.goalkeeperFree
                    }
                    name={goalkeeper.name}
                  />
                ))}
              </View>
            </AppCard>

            <AppCard>
              <SectionHeading
                description={pt.racha.teams.auditSummary(match.auditTrail.length)}
                eyebrow={pt.racha.teams.auditEyebrow}
                title={pt.racha.teams.auditTitle}
              />
              <Pressable
                accessibilityLabel={auditToggleLabel}
                accessibilityRole="button"
                accessibilityState={{ expanded: auditExpanded }}
                onPress={() => setAuditExpanded((current) => !current)}
                style={[styles.auditToggle, { borderColor: colors.border }]}
              >
                <Text style={[styles.auditToggleLabel, { color: colors.text }]}>
                  {auditToggleLabel}
                </Text>
                <Ionicons
                  accessibilityElementsHidden
                  accessible={false}
                  color={colors.primary}
                  importantForAccessibility="no-hide-descendants"
                  name={auditExpanded ? 'chevron-up' : 'chevron-down'}
                  size={22}
                />
              </Pressable>
              {auditExpanded ? (
                <View style={styles.rows}>
                  {match.auditTrail.map((event) => (
                    <View
                      key={event.id}
                      style={[styles.auditEvent, { borderColor: colors.border }]}
                    >
                      <Text style={[styles.auditKind, { color: colors.text }]}>
                        {auditKindLabel(event.kind)}
                      </Text>
                      <Text style={[styles.auditMeta, { color: colors.textMuted }]}>
                        {pt.racha.teams.auditActorWhen(event.actor, event.when)}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </AppCard>
          </View>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  auditEvent: {
    borderLeftWidth: 3,
    gap: spacing.xs,
    minHeight: 58,
    padding: spacing.sm,
  },
  auditKind: {
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
  },
  auditMeta: {
    fontSize: 14,
    lineHeight: 20,
  },
  auditToggle: {
    alignItems: 'center',
    borderBottomWidth: 1,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingVertical: spacing.sm,
  },
  auditToggleLabel: {
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
  },
  description: {
    fontSize: 17,
    lineHeight: 26,
    maxWidth: 680,
  },
  eyebrow: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.8,
    lineHeight: 20,
    textTransform: 'uppercase',
  },
  intro: {
    gap: spacing.sm,
  },
  main: {
    alignSelf: 'center',
    gap: spacing.lg,
    maxWidth: 1120,
    width: '100%',
  },
  mainNarrow: {
    padding: spacing.md,
  },
  mainWide: {
    padding: spacing.xl,
  },
  matchMeta: {
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 24,
  },
  missing: {
    alignSelf: 'center',
    gap: spacing.lg,
    maxWidth: 680,
    padding: spacing.lg,
    width: '100%',
  },
  rows: {
    gap: spacing.sm,
  },
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: spacing.xxl,
  },
  teamColumn: {
    flex: 1,
    minWidth: 0,
  },
  teams: {
    alignItems: 'stretch',
  },
  teamsNarrow: {
    gap: spacing.md,
  },
  teamsWide: {
    flexDirection: 'row',
    gap: spacing.lg,
  },
  title: {
    fontSize: 38,
    fontWeight: '900',
    letterSpacing: -1,
    lineHeight: 46,
  },
  topBar: {
    alignSelf: 'center',
    borderBottomWidth: 1,
    maxWidth: 1120,
    padding: spacing.md,
    width: '100%',
  },
});
