import { Link } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { AppIcon } from '@/components/ui/AppIcon';
import type { MatchOccupancy, MatchSummary } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useReducedMotion } from '@/theme/motion';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { face, typography } from '@/theme/typography';

import { matchSpokenDay, matchTicket, matchTimeRange } from './match-format';

/** The whole name a screen reader hears for the row, in reading order. */
export function matchCardLabel(
  match: MatchSummary,
  occupancy: MatchOccupancy | undefined,
  showGroup: boolean,
): string {
  const parts = [
    `${pt.matches.card.view}: ${match.location_name}`,
    matchSpokenDay(match.starts_at, match.timezone),
    matchTimeRange(match.starts_at, match.ends_at, match.timezone),
  ];
  if (showGroup) parts.push(`${pt.matches.detail.group} ${match.group_name}`);
  if (occupancy) {
    parts.push(pt.matches.card.occupancy(occupancy.confirmed_count, match.field_slots));
    if (occupancy.waitlist_count > 0) {
      parts.push(pt.matches.card.waiting(occupancy.waitlist_count));
    }
    if (occupancy.viewer_status === 'starter') parts.push(pt.matches.card.viewerStarter);
    if (occupancy.viewer_status === 'waitlist') parts.push(pt.matches.card.viewerWaitlist);
  }
  return parts.join(', ');
}

/**
 * One match, Placar premium: a ticket-style date block (big day, month and
 * weekday on the scoreboard), the time, the place, the group on the Agenda,
 * and the occupancy as a bar with the waitlist. The whole row opens the match;
 * its accessible name carries everything the row shows.
 */
export function MatchCard({
  match,
  occupancy,
  showGroup,
}: {
  match: MatchSummary;
  occupancy?: MatchOccupancy | undefined;
  showGroup: boolean;
}) {
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const ticket = matchTicket(match.starts_at, match.timezone);
  const confirmed = occupancy?.confirmed_count ?? 0;
  const ratio = Math.min(1, confirmed / Math.max(1, match.field_slots));
  const full = occupancy !== undefined && confirmed >= match.field_slots;
  return (
    <Link asChild href={`/rachas/${match.id}`}>
      <Pressable
        accessibilityLabel={matchCardLabel(match, occupancy, showGroup)}
        accessibilityRole="link"
        style={styles.target}
        testID="match-list-card"
      >
        {({ pressed }) => (
          <View
            style={[
              styles.card,
              {
                backgroundColor: colors.surfaceRaised,
                opacity: pressed ? 0.86 : 1,
                transform: [{ scale: pressed && !reducedMotion ? 0.99 : 1 }],
              },
              Platform.OS === 'web'
                ? ({
                    transitionDuration: pressed ? '100ms' : '160ms',
                    transitionProperty: 'transform, opacity',
                  } as ViewStyle)
                : null,
            ]}
          >
            <View
              aria-hidden
              style={[styles.ticket, { backgroundColor: colors.scoreboard }]}
              testID="match-card-ticket"
            >
              <Text style={[styles.ticketSmall, { color: colors.digitDim }]}>{ticket.weekday}</Text>
              <Text style={[styles.ticketDay, { color: colors.digit }]}>{ticket.day}</Text>
              <Text style={[styles.ticketSmall, { color: colors.digitDim }]}>{ticket.month}</Text>
            </View>
            <View aria-hidden style={styles.body}>
              <Text style={[styles.time, { color: colors.textMuted }]} testID="match-card-time">
                {matchTimeRange(match.starts_at, match.ends_at, match.timezone)}
              </Text>
              <Text numberOfLines={2} style={[styles.place, { color: colors.text }]}>
                {match.location_name}
              </Text>
              {showGroup ? (
                <View style={styles.meta}>
                  <AppIcon color={colors.textMuted} name="users" size={16} />
                  <Text
                    numberOfLines={2}
                    style={[styles.metaText, { color: colors.textMuted }]}
                    testID="match-card-group"
                  >
                    {match.group_name}
                  </Text>
                </View>
              ) : null}
              <View style={styles.occupancy}>
                <View style={[styles.track, { backgroundColor: colors.surface }]}>
                  <View
                    style={[
                      styles.fill,
                      {
                        backgroundColor: full ? colors.warning : colors.indicator,
                        width: `${ratio * 100}%`,
                      },
                    ]}
                    testID="match-card-bar"
                  />
                </View>
                <Text style={[styles.count, { color: colors.text }]} testID="match-list-occupancy">
                  {occupancy ? `${confirmed}/${match.field_slots}` : `–/${match.field_slots}`}
                </Text>
              </View>
              {occupancy && (occupancy.waitlist_count > 0 || full) ? (
                <View style={styles.meta}>
                  <AppIcon color={colors.warning} name="clock" size={16} />
                  <Text
                    style={[styles.metaText, { color: colors.warning }]}
                    testID="match-card-waitlist"
                  >
                    {occupancy.waitlist_count > 0
                      ? pt.matches.card.waiting(occupancy.waitlist_count)
                      : pt.matches.card.full}
                  </Text>
                </View>
              ) : null}
              {occupancy && occupancy.viewer_status !== 'out' ? (
                <View style={styles.meta}>
                  <AppIcon
                    color={colors.positive}
                    name={occupancy.viewer_status === 'starter' ? 'check-circle' : 'clock'}
                    size={16}
                  />
                  <Text
                    style={[styles.metaText, { color: colors.positive }]}
                    testID="match-list-viewer"
                  >
                    {occupancy.viewer_status === 'starter'
                      ? pt.matches.list.viewerStarter
                      : pt.matches.list.viewerWaitlist}
                  </Text>
                </View>
              ) : null}
            </View>
            <AppIcon color={colors.textMuted} name="chevron-right" size={24} />
          </View>
        )}
      </Pressable>
    </Link>
  );
}

// Review of #72 (P2): at 200% on a phone the ticket left the content a few
// pixels. The content now has a base width and the row wraps: when the usable
// width is below it, the date block sits above the content, which then takes
// the whole line and may shrink to fit it. No measuring, so it holds at any
// zoom or text size.
const BODY_BASIS = 176;

const styles = StyleSheet.create({
  body: { flexBasis: BODY_BASIS, flexGrow: 1, flexShrink: 1, gap: spacing.xs, minWidth: 0 },
  card: {
    alignItems: 'center',
    borderRadius: radius.row,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    minHeight: size.row + spacing.lg,
    padding: spacing.ms,
  },
  count: { ...typography.supportStrong, fontVariant: ['tabular-nums'], minWidth: 44 },
  fill: { borderRadius: radius.pill, height: '100%' },
  meta: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  metaText: { ...typography.support, flexShrink: 1 },
  occupancy: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  place: { ...typography.row },
  target: { borderRadius: radius.row },
  ticket: {
    alignItems: 'center',
    alignSelf: 'stretch',
    borderRadius: radius.tile + 4,
    justifyContent: 'center',
    minWidth: 72,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  ticketDay: { ...face('condensed'), fontSize: 40, fontVariant: ['tabular-nums'], lineHeight: 44 },
  ticketSmall: { ...typography.overline, letterSpacing: 1.2 },
  time: { ...typography.supportStrong, fontVariant: ['tabular-nums'] },
  track: { borderRadius: radius.pill, flex: 1, height: 8, overflow: 'hidden' },
});
