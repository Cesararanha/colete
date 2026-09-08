import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

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
      tone: 'neutral' as const,
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

export function MatchCard({ match, onAction }: MatchCardProps) {
  const { colors } = useTheme();
  const presentation = matchPresentation(match);

  return (
    <AppCard testID={`match-card-${match.id}`}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={[styles.date, { color: colors.primary }]}>
            {pt.racha.list.cardDate(match.dateLabel, match.timeLabel)}
          </Text>
          <Text aria-level={2} role="heading" style={[styles.group, { color: colors.text }]}>
            {match.groupName}
          </Text>
          <Text style={[styles.location, { color: colors.textMuted }]}>{match.location}</Text>
        </View>
        <StatusTag label={presentation.status} tone={presentation.tone} />
      </View>
      <OccupancyBar capacity={match.capacity} filled={match.starters.length} />
      <AppButton label={presentation.action} onPress={onAction} variant="secondary" />
    </AppCard>
  );
}

const styles = StyleSheet.create({
  date: {
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.4,
    lineHeight: 22,
    textTransform: 'uppercase',
  },
  group: {
    fontSize: 24,
    fontWeight: '900',
    lineHeight: 30,
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
    fontSize: 15,
    lineHeight: 22,
  },
});
