import { StyleSheet, Text, View } from 'react-native';

import { AppCard } from '@/components/ui/AppCard';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

import type { PublishedTeam } from './demo-data';
import { PlayerRow } from './PlayerRow';
import { StatusTag } from './StatusTag';

export function TeamCard({ team }: { readonly team: PublishedTeam }) {
  const { colors } = useTheme();

  return (
    <AppCard>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text aria-level={2} role="heading" style={[styles.title, { color: colors.text }]}>
            {team.name}
          </Text>
          <Text style={[styles.count, { color: colors.textMuted }]}>
            {pt.racha.teams.teamPlayers(team.players.length)}
          </Text>
        </View>
        <StatusTag label={pt.racha.teams.balance} tone="positive" />
      </View>
      <View style={styles.players}>
        {team.players.map((player, index) => (
          <PlayerRow
            key={player.id}
            leadingLabel={String(index + 1)}
            meta={pt.racha.teams.preferredPosition(player.preferredPosition)}
            name={player.name}
          />
        ))}
      </View>
    </AppCard>
  );
}

const styles = StyleSheet.create({
  count: {
    fontSize: 14,
    lineHeight: 20,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  headerCopy: {
    gap: spacing.xs,
  },
  players: {
    gap: spacing.sm,
  },
  title: {
    fontSize: 26,
    fontWeight: '900',
    lineHeight: 32,
  },
});
