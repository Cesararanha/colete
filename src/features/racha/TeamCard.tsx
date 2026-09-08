import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, View } from 'react-native';

import { AppCard } from '@/components/ui/AppCard';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import type { PublishedTeam } from './demo-data';
import { PlayerRow } from './PlayerRow';
import { StatusTag } from './StatusTag';

export function TeamCard({ team }: { readonly team: PublishedTeam }) {
  const { colors } = useTheme();

  return (
    <AppCard>
      <View style={[styles.header, { backgroundColor: colors.surfaceStrong }]}>
        <View style={styles.identity}>
          <View style={[styles.identityIcon, { backgroundColor: colors.primary }]}>
            <Ionicons
              accessibilityElementsHidden
              accessible={false}
              color={colors.onPrimary}
              importantForAccessibility="no-hide-descendants"
              name="shirt-outline"
              size={24}
            />
          </View>
          <View style={styles.headerCopy}>
            <Text aria-level={2} role="heading" style={[styles.title, { color: colors.text }]}>
              {team.name}
            </Text>
            <Text style={[styles.count, { color: colors.textMuted }]}>
              {pt.racha.teams.teamPlayers(team.players.length)}
            </Text>
          </View>
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
    ...typography.caption,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    justifyContent: 'space-between',
    padding: spacing.md,
    borderRadius: radius.sm,
  },
  headerCopy: {
    gap: spacing.xs,
  },
  identity: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  identityIcon: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  players: {
    gap: spacing.sm,
  },
  title: {
    ...typography.title,
  },
});
