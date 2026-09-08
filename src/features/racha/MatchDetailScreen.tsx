import Head from 'expo-router/head';
import { router, useLocalSearchParams } from 'expo-router';
import { Linking, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { pt } from '@/lib/i18n/pt';
import { getLayoutMode } from '@/theme/layout';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

import type { DemoMatch, PaymentStatus } from './demo-data';
import { findDemoMatch } from './demo-data';
import { OccupancyBar } from './OccupancyBar';
import { PlayerRow } from './PlayerRow';
import { StatusTag } from './StatusTag';

const paymentLabel = (status: PaymentStatus) => {
  if (status === 'paid') return pt.racha.detail.paymentPaid;
  if (status === 'review') return pt.racha.detail.paymentReview;
  return pt.racha.detail.paymentPending;
};

const paymentTone = (status: PaymentStatus) => {
  if (status === 'paid') return 'positive' as const;
  if (status === 'review') return 'primary' as const;
  return 'neutral' as const;
};

const actionLabel = (match: DemoMatch) => {
  if (match.situation === 'open') return pt.racha.actions.joinList;
  if (match.situation === 'payment_due') return pt.racha.actions.pay;
  if (match.situation === 'reserve') return pt.racha.actions.leaveQueue;
  return pt.racha.actions.viewTeams;
};

const statusLabel = (match: DemoMatch) => {
  if (match.situation === 'open') {
    return pt.racha.status.open(match.capacity - match.starters.length);
  }
  if (match.situation === 'payment_due') {
    return pt.racha.status.paymentDue(match.paymentDeadlineMinutes ?? 0);
  }
  if (match.situation === 'reserve') {
    return pt.racha.status.reserve(
      match.reserves.find((reserve) => reserve.isCurrentUser)?.position ?? 1,
    );
  }
  return pt.racha.status.teamsPublished(match.publishedTeamNumber ?? 1);
};

export function MatchDetailScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const match = findDemoMatch(Array.isArray(id) ? id[0] : id);
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const wide = getLayoutMode(width) === 'wide';

  if (!match) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View role="main" style={styles.missing}>
          <SectionHeading
            description={pt.racha.missing.description}
            eyebrow={pt.racha.detail.eyebrow}
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

  const primaryAction = () => {
    if (match.situation === 'teams_published') {
      router.push({ pathname: '/rachas/[id]/times', params: { id: match.id } });
    }
  };

  const openMap = () => {
    void Linking.openURL(
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(match.mapQuery)}`,
    );
  };

  return (
    <>
      <Head>
        <title>{pt.app.pageTitle(match.groupName)}</title>
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
                {pt.racha.detail.eyebrow}
              </Text>
              <Text aria-level={1} role="heading" style={[styles.title, { color: colors.text }]}>
                {pt.racha.list.cardDate(match.dateLabel, match.timeLabel)}
              </Text>
              <Text style={[styles.group, { color: colors.textMuted }]}>{match.groupName}</Text>
            </View>

            <AppCard>
              <SectionHeading eyebrow={pt.racha.detail.locationEyebrow} title={match.location} />
              <AppButton label={pt.racha.actions.openMap} onPress={openMap} variant="secondary" />
            </AppCard>

            <AppCard>
              <SectionHeading
                eyebrow={pt.racha.detail.occupancyEyebrow}
                title={pt.racha.list.occupancy(match.starters.length, match.capacity)}
              />
              <StatusTag label={statusLabel(match)} tone="primary" />
              <OccupancyBar capacity={match.capacity} filled={match.starters.length} />
            </AppCard>

            <AppCard>
              <SectionHeading
                eyebrow={pt.racha.detail.startersEyebrow}
                title={pt.racha.detail.startersTitle}
              />
              <View style={styles.rows}>
                {match.starters.map((player, index) => (
                  <PlayerRow
                    key={player.id}
                    leadingLabel={player.name.slice(0, 1)}
                    meta={pt.racha.detail.playerNumber(index + 1)}
                    name={player.name}
                    statusLabel={paymentLabel(player.paymentStatus)}
                    statusTone={paymentTone(player.paymentStatus)}
                  />
                ))}
              </View>
            </AppCard>

            <AppCard>
              <SectionHeading
                eyebrow={pt.racha.detail.reservesEyebrow}
                title={pt.racha.detail.reservesTitle}
              />
              {match.reserves.length === 0 ? (
                <Text style={[styles.body, { color: colors.textMuted }]}>
                  {pt.racha.detail.noReserves}
                </Text>
              ) : (
                <View style={styles.rows}>
                  {match.reserves.map((reserve) => (
                    <PlayerRow
                      key={reserve.id}
                      highlighted={reserve.isCurrentUser}
                      leadingLabel={String(reserve.position)}
                      meta={pt.racha.detail.reservePosition(reserve.position)}
                      name={reserve.name}
                      statusTone="primary"
                      {...(reserve.isCurrentUser
                        ? { statusLabel: pt.racha.detail.currentUser }
                        : {})}
                    />
                  ))}
                </View>
              )}
            </AppCard>

            <AppCard>
              <SectionHeading
                eyebrow={pt.racha.detail.goalkeepersEyebrow}
                title={pt.racha.detail.goalkeepersTitle}
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
                eyebrow={pt.racha.detail.valueEyebrow}
                title={pt.racha.detail.valueTitle}
              />
              <Text style={[styles.amount, { color: colors.text }]}>{match.amount}</Text>
            </AppCard>
          </View>
        </ScrollView>
        <View
          accessibilityLabel={pt.racha.detail.fixedActionLabel}
          style={[
            styles.footer,
            wide ? styles.footerWide : styles.footerNarrow,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <AppButton label={actionLabel(match)} onPress={primaryAction} />
        </View>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  amount: {
    fontSize: 30,
    fontWeight: '900',
    lineHeight: 38,
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
  },
  eyebrow: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.8,
    lineHeight: 20,
    textTransform: 'uppercase',
  },
  footer: {
    borderTopWidth: 1,
    padding: spacing.md,
  },
  footerNarrow: {
    alignSelf: 'stretch',
  },
  footerWide: {
    alignSelf: 'center',
    maxWidth: 820,
    width: '100%',
  },
  group: {
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 26,
  },
  intro: {
    gap: spacing.sm,
  },
  main: {
    alignSelf: 'center',
    gap: spacing.lg,
    maxWidth: 820,
    width: '100%',
  },
  mainNarrow: {
    padding: spacing.md,
  },
  mainWide: {
    padding: spacing.xl,
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
  title: {
    fontSize: 38,
    fontWeight: '900',
    letterSpacing: -1,
    lineHeight: 46,
  },
  topBar: {
    alignSelf: 'center',
    borderBottomWidth: 1,
    maxWidth: 980,
    padding: spacing.md,
    width: '100%',
  },
});
