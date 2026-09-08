import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { pt } from '@/lib/i18n/pt';
import type { ThemeColors } from '@/theme/colors';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import type { DemoMatch } from './demo-data';
import { OccupancyBar } from './OccupancyBar';
import { StatusTag } from './StatusTag';

type MatchCardProps = {
  readonly match: DemoMatch;
  readonly onAction: () => void;
};

const matchPresentation = (match: DemoMatch) => {
  if (match.situation === 'open') {
    return {
      action: pt.racha.actions.joinList,
      status: pt.racha.status.open(match.capacity - match.starters.length),
      tone: 'primary' as const,
    };
  }
  if (match.situation === 'payment_due') {
    return {
      action: pt.racha.actions.pay,
      status: pt.racha.status.paymentDue(match.paymentDeadlineMinutes ?? 0),
      tone: 'critical' as const,
    };
  }
  if (match.situation === 'reserve') {
    const currentReserve = match.reserves.find((reserve) => reserve.isCurrentUser);
    return {
      action: pt.racha.actions.leaveQueue,
      status: pt.racha.status.reserve(currentReserve?.position ?? 1),
      tone: 'neutral' as const,
    };
  }
  return {
    action: pt.racha.actions.viewTeams,
    status: pt.racha.status.teamsPublished(match.publishedTeamNumber ?? 1),
    tone: 'positive' as const,
  };
};

const matchAccent = (match: DemoMatch, colors: ThemeColors) => {
  if (match.situation === 'payment_due') return colors.critical;
  if (match.situation === 'teams_published') return colors.positive;
  if (match.situation === 'reserve') return colors.focus;
  return colors.primary;
};

export function MatchCard({ match, onAction }: MatchCardProps) {
  const { colors } = useTheme();
  const presentation = matchPresentation(match);

  return (
    <View style={[styles.frame, { shadowColor: colors.text }]}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.accent, { backgroundColor: matchAccent(match, colors) }]}
      />
      <AppCard testID={`match-card-${match.id}`}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text aria-level={2} role="heading" style={[styles.date, { color: colors.text }]}>
              {match.dateLabel}
            </Text>
            <Text style={[styles.time, { color: colors.primary }]}>{match.timeLabel}</Text>
          </View>
          <StatusTag label={presentation.status} tone={presentation.tone} />
        </View>
        <View style={styles.secondaryCopy}>
          <Text style={[styles.group, { color: colors.text }]}>{match.groupName}</Text>
          <Text style={[styles.location, { color: colors.textMuted }]}>{match.location}</Text>
        </View>
        <OccupancyBar capacity={match.capacity} filled={match.starters.length} />
        <AppButton label={presentation.action} onPress={onAction} />
      </AppCard>
    </View>
  );
}

const styles = StyleSheet.create({
  accent: {
    borderBottomLeftRadius: radius.md,
    borderTopLeftRadius: radius.md,
    bottom: 4,
    left: 0,
    position: 'absolute',
    top: 4,
    width: 6,
    zIndex: 1,
  },
  date: {
    ...typography.title,
    letterSpacing: -0.5,
  },
  frame: {
    borderRadius: radius.md,
    elevation: 2,
    paddingLeft: 5,
    shadowOffset: { height: 4, width: 0 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
  },
  group: {
    ...typography.section,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  headerCopy: {
    flex: 1,
    gap: spacing.xs,
    minWidth: 210,
  },
  location: {
    ...typography.body,
  },
  secondaryCopy: {
    gap: spacing.xs,
  },
  time: {
    ...typography.section,
  },
});
