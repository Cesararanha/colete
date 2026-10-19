import { StyleSheet, Text, View } from 'react-native';

import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { typography } from '@/theme/typography';

import { PhotoAvatar } from '../photos/PhotoAvatar';

const SHOWN = 4;

/** The first members as overlapping avatars and "+N" for the rest: decoration, the count is said elsewhere. */
export function MemberStack({
  members,
}: {
  members: readonly { profile_id: string; display_name: string }[];
}) {
  const { colors } = useTheme();
  const rest = members.length - SHOWN;
  return (
    <View aria-hidden style={styles.stack}>
      {members.slice(0, SHOWN).map((member, index) => (
        <View key={member.profile_id} style={index === 0 ? undefined : styles.overlap}>
          <PhotoAvatar
            id={member.profile_id}
            name={member.display_name}
            ring={colors.surface}
            size={36}
          />
        </View>
      ))}
      {rest > 0 ? (
        <Text style={[styles.more, { color: colors.textSoft }]}>{pt.groups.detail.more(rest)}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  more: { ...typography.support, marginLeft: 10 },
  overlap: { marginLeft: -10 },
  stack: { alignItems: 'center', flexDirection: 'row', flexShrink: 1 },
});
