import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppIcon } from '@/components/ui/AppIcon';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { GroupGlyph, GroupIcon } from '@/components/ui/GroupIcon';
import {
  GROUP_COLORS,
  GROUP_ICONS,
  groupColors,
  type GroupAppearance,
} from '@/components/ui/group-icon';
import { api, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { groupErrorMessage } from './group-errors';
import { useGroupAdministration } from './useGroupAdministration';

/** The icon tile and the colour swatch of the prévia (icone-do-grupo.html). */
const ICON_TILE = 72;

/**
 * "Ícone do grupo" (prévia aprovada, PR H): the owner picks one of eight
 * icons and one of six colours and saves both at once. The card at the top
 * shows the choice before it is saved. Organizers reach Configurações but not
 * this screen; opened by address, it says who may choose and offers nothing.
 */
export function GroupAppearanceScreen({
  groupId,
  profile,
}: {
  groupId: string;
  profile: OwnProfile;
}) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const administration = useGroupAdministration(groupId, profile);
  const { listing, run, error } = administration;
  const data = listing.isSuccess ? listing.data : undefined;
  const group = data?.group;
  const isOwner = group?.role === 'owner';
  const [draft, setDraft] = useState<GroupAppearance | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const choice = draft ?? group?.appearance;
  const activeMembers = data?.members.filter((member) => member.status === 'active').length ?? 0;
  const pick = (next: GroupAppearance) => {
    setDraft(next);
    setMessage(null);
    administration.discardIntent();
  };
  const save = async () => {
    if (!choice) return;
    setMessage(null);
    const success = await run(`appearance:${choice.icon}:${choice.color}`, () =>
      api.setGroupAppearance(groupId, choice.icon, choice.color),
    );
    if (!success) return;
    setDraft(null);
    // The Agenda's cards carry the group's icon too.
    await queryClient.invalidateQueries({ queryKey: [PRIVATE_QUERY_ROOT, 'matches'] });
    setMessage(pt.groups.appearance.saved);
  };
  const selected = choice ? groupColors(colors, choice.color) : undefined;
  return (
    <AuthenticatedShell
      description={pt.groups.appearance.description}
      title={pt.groups.appearance.title}
      back={{
        label: pt.groups.appearance.back,
        href: `/grupos/${groupId}/configuracoes`,
        testID: 'appearance-back',
      }}
    >
      {administration.pending ? <AppStatus message={pt.common.loading} /> : null}
      <AppStatus message={message ?? ''} testID="appearance-result" />
      {error ? (
        <AppAlert message={groupErrorMessage(error, true)} testID="appearance-error" />
      ) : null}
      {listing.isPending ? <AsyncNotice kind="loading" message={pt.common.loading} /> : null}
      {listing.isError ? <AppAlert message={groupErrorMessage(listing.error, true)} /> : null}
      {data && !isOwner ? (
        <AppAlert message={pt.groups.appearance.ownerOnly} testID="appearance-owner-only" />
      ) : null}
      {group && isOwner && choice && selected ? (
        <>
          <View
            style={[styles.preview, { backgroundColor: colors.surface }]}
            testID="appearance-preview"
          >
            <GroupIcon appearance={choice} size={56} tile />
            <View style={styles.previewText}>
              <Text style={[styles.previewName, { color: colors.text }]}>{group.name}</Text>
              <Text style={[styles.previewCount, { color: colors.textMuted }]}>
                {pt.groups.appearance.members(activeMembers)}
              </Text>
            </View>
          </View>

          <Text aria-level={2} role="heading" style={[styles.section, { color: colors.text }]}>
            {pt.groups.appearance.icon}
          </Text>
          <View style={styles.icons} testID="appearance-icons">
            {GROUP_ICONS.map((icon) => {
              const on = icon === choice.icon;
              return (
                <Pressable
                  accessibilityLabel={pt.groups.appearance.icons[icon]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  aria-pressed={on}
                  key={icon}
                  onPress={() => pick({ ...choice, icon })}
                  style={[
                    styles.iconTile,
                    on
                      ? {
                          backgroundColor: selected.fill,
                          borderColor: selected.glyph,
                        }
                      : { backgroundColor: colors.surface, borderColor: colors.surface },
                  ]}
                  testID={`appearance-icon-${icon}`}
                >
                  <GroupGlyph
                    color={on ? selected.glyph : colors.textMuted}
                    icon={icon}
                    size={GROUP_ICON_GLYPH}
                  />
                </Pressable>
              );
            })}
          </View>

          <Text aria-level={2} role="heading" style={[styles.section, { color: colors.text }]}>
            {pt.groups.appearance.color}
          </Text>
          <View style={styles.swatches} testID="appearance-colors">
            {GROUP_COLORS.map((color) => {
              const on = color === choice.color;
              return (
                <Pressable
                  accessibilityLabel={pt.groups.appearance.colors[color]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  aria-pressed={on}
                  key={color}
                  onPress={() => pick({ ...choice, color })}
                  style={[styles.swatch, { backgroundColor: groupColors(colors, color).glyph }]}
                  testID={`appearance-color-${color}`}
                >
                  {on ? <AppIcon color={colors.background} name="check" size={20} /> : null}
                </Pressable>
              );
            })}
          </View>

          <View style={styles.save}>
            <AppButton
              label={pt.groups.appearance.save}
              onPress={() => void save()}
              testID="appearance-save"
            />
          </View>
        </>
      ) : null}
    </AuthenticatedShell>
  );
}

const GROUP_ICON_GLYPH = 32;

const styles = StyleSheet.create({
  iconTile: {
    alignItems: 'center',
    borderRadius: radius.row,
    borderWidth: 2,
    height: ICON_TILE,
    justifyContent: 'center',
    width: ICON_TILE,
  },
  icons: {
    columnGap: spacing.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 14,
  },
  preview: {
    alignItems: 'center',
    borderRadius: 20,
    flexDirection: 'row',
    gap: 14,
    padding: 14,
  },
  previewCount: { ...typography.support },
  previewName: { ...typography.row },
  previewText: { flex: 1, minWidth: 0 },
  save: { paddingTop: spacing.md },
  section: { ...typography.section, marginTop: spacing.xs },
  swatch: {
    alignItems: 'center',
    borderRadius: size.compact / 2,
    height: size.compact,
    justifyContent: 'center',
    width: size.compact,
  },
  swatches: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
});
