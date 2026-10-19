import { Link } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { Chip } from '@/components/ui/Chip';
import { groupAppearance } from '@/components/ui/group-icon';
import { OccupancyBar } from '@/components/ui/OccupancyBar';
import type { MatchOccupancy, MatchSummary } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useReducedMotion } from '@/theme/motion';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { face, typography } from '@/theme/typography';

import { endsNextDay, matchCardState, type MatchCardTone } from './match-card-state';
import { GroupPhotoIcon } from '../photos/PhotoAvatar';
import { matchSpokenDay, matchTicket, matchTime, matchTimeRange } from './match-format';

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
  if (match.canceled) parts.push(pt.matches.card.canceled);
  if (occupancy) {
    parts.push(pt.matches.card.occupancy(occupancy.confirmed_count, match.field_slots));
    if (occupancy.waitlist_count > 0) {
      parts.push(pt.matches.card.waiting(occupancy.waitlist_count));
    }
    if (!match.canceled && occupancy.viewer_status === 'starter') {
      parts.push(pt.matches.card.viewerStarter);
    }
    if (!match.canceled && occupancy.viewer_status === 'waitlist') {
      parts.push(pt.matches.card.viewerWaitlist);
    }
  }
  return parts.join(', ');
}

/**
 * One match (prévia aprovada): the date block, amber when the viewer is
 * confirmed; on the Agenda the group with its icon, the place and the time;
 * in a group, the place and the start on one line. Then the state chip, the
 * count and the bar in the state's colour. The whole card opens the match;
 * its accessible name carries everything the card shows.
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
  const state = matchCardState(occupancy, match.field_slots, match.canceled);
  // A canceled match never lights the ticket: nobody plays it.
  const highlight = !match.canceled && occupancy?.viewer_status === 'starter';
  const confirmed = occupancy?.confirmed_count;
  const tone = (name: MatchCardTone | null) => (name === null ? colors.track : colors[name]);
  const ticketText = highlight ? colors.onPrimary : colors.textMuted;
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
                backgroundColor: colors.surface,
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
              style={[
                styles.ticket,
                showGroup ? styles.ticketWide : styles.ticketNarrow,
                { backgroundColor: highlight ? colors.primary : colors.surfaceRaised },
              ]}
              testID="match-card-ticket"
            >
              <Text style={[styles.ticketSmall, { color: ticketText }]}>{ticket.weekday}</Text>
              <Text
                style={[
                  showGroup ? styles.ticketDay : styles.ticketDayNarrow,
                  { color: highlight ? colors.onPrimary : colors.text },
                ]}
              >
                {ticket.day}
              </Text>
              {showGroup ? (
                <Text style={[styles.ticketSmall, { color: ticketText }]}>{ticket.month}</Text>
              ) : null}
            </View>
            <View aria-hidden style={styles.body}>
              {showGroup ? (
                <View style={styles.meta}>
                  <GroupPhotoIcon
                    appearance={groupAppearance(match.group_icon, match.group_color)}
                    groupId={match.group_id}
                    size={16}
                  />
                  <Text
                    style={[styles.metaText, { color: colors.textMuted }]}
                    testID="match-card-group"
                  >
                    {match.group_name}
                  </Text>
                </View>
              ) : null}
              <Text style={[styles.place, { color: colors.text }]}>
                {showGroup
                  ? match.location_name
                  : `${match.location_name} · ${matchTime(match.starts_at, match.timezone)}`}
              </Text>
              {showGroup ? (
                <Text style={[styles.time, { color: colors.textSoft }]} testID="match-card-time">
                  {matchTimeRange(match.starts_at, match.ends_at, match.timezone)}
                  {endsNextDay(match.starts_at, match.ends_at, match.timezone) ? (
                    <Text style={{ color: colors.textMuted }}> {pt.matches.card.nextDay}</Text>
                  ) : null}
                </Text>
              ) : null}
              <View style={styles.status}>
                {state.chip ? (
                  <Chip
                    {...(state.chip.icon ? { icon: state.chip.icon } : {})}
                    label={state.chip.label}
                    testID="match-card-state"
                    tone={state.chip.tone}
                  />
                ) : (
                  <View />
                )}
                <Text style={[styles.count, { color: colors.text }]}>
                  {state.full && !match.canceled ? `${pt.matches.card.full} ` : ''}
                  <Text testID="match-list-occupancy">
                    {confirmed === undefined
                      ? `–/${match.field_slots}`
                      : `${confirmed}/${match.field_slots}`}
                  </Text>
                </Text>
              </View>
              <OccupancyBar
                color={tone(state.bar)}
                ratio={state.ratio}
                testID="match-card-bar"
                track={colors.track}
              />
            </View>
          </View>
        )}
      </Pressable>
    </Link>
  );
}

// Review of #72 (P2): at 200% on a phone the ticket left the content a few
// pixels. The content has a base width and the row wraps: when the usable
// width is below it, the date block sits above the content, which then takes
// the whole line and may shrink to fit it. No measuring, so it holds at any
// zoom or text size. Long names and places wrap inside the card.
const BODY_BASIS = 176;

const styles = StyleSheet.create({
  body: { flexBasis: BODY_BASIS, flexGrow: 1, flexShrink: 1, gap: 6, minWidth: 0 },
  card: {
    alignItems: 'stretch',
    borderRadius: radius.scoreboard - 2,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    padding: 14,
  },
  count: { ...typography.supportStrong, fontVariant: ['tabular-nums'], fontSize: 14 },
  meta: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  metaText: { ...typography.caption, flexShrink: 1 },
  place: { ...typography.cardTitle },
  status: {
    alignItems: 'center',
    columnGap: spacing.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginTop: 2,
    rowGap: spacing.xs,
  },
  target: { borderRadius: radius.scoreboard - 2 },
  ticket: {
    alignItems: 'center',
    borderRadius: 14,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
  },
  ticketDay: { ...face('condensed'), fontSize: 34, fontVariant: ['tabular-nums'], lineHeight: 36 },
  ticketDayNarrow: {
    ...face('condensed'),
    fontSize: 30,
    fontVariant: ['tabular-nums'],
    lineHeight: 32,
  },
  ticketNarrow: { minWidth: 56 },
  ticketSmall: { ...face('bold'), fontSize: 12, letterSpacing: 1, lineHeight: 16 },
  ticketWide: { minWidth: 64 },
  time: { ...typography.support },
});
