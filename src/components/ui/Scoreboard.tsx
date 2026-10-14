import { useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { BOARD_PADDING, fitTiles, SEPARATOR_WIDTH, TILE_GAP } from './scoreboard-fit';

export type ScoreboardGroup = {
  chars: string;
  /** Reference value (a limit): drawn in digitDim instead of the amber digit. */
  reference?: boolean;
};

type ScoreboardProps = {
  groups: ScoreboardGroup[];
  /** `inline` puts a "/" between groups; `stacked` gives each group its own row. */
  layout?: 'inline' | 'stacked';
  size?: 'xl' | 'lg';
  testID?: string;
} & (
  | { accessibilityLabel: string; decorative?: false }
  | { accessibilityLabel?: undefined; decorative: true }
);

const tiles = {
  xl: { height: 80, width: 50, font: typography.scoreboard.fontSize },
  lg: { height: 70, width: 44, font: typography.inviteCode.fontSize },
} as const;
const tileGap = TILE_GAP;
const separatorWidth = SEPARATOR_WIDTH;
const boardPadding = BOARD_PADDING;
const maxBoardWidth = 420;

/**
 * Static split-flap scoreboard (docs/29 §6). The tiles are hidden from
 * assistive technology: a real count is announced once through the board's
 * label, and a decorative board (brand, invite code) is hidden entirely while
 * the real text stays on screen beside it.
 */
export function Scoreboard({
  accessibilityLabel,
  decorative,
  groups,
  layout = 'inline',
  size = 'xl',
  testID,
}: ScoreboardProps) {
  const { colors } = useTheme();
  // Measured on the board itself, so a board inside a card fits that card.
  const [boardWidth, setBoardWidth] = useState<number | undefined>();
  const onLayout = (event: LayoutChangeEvent) => setBoardWidth(event.nativeEvent.layout.width);
  const rows = layout === 'stacked' ? groups.map((group) => [group]) : [groups];
  const { scale, tile } = fitTiles(
    tiles[size],
    rows.map((row) => ({
      separators: layout === 'inline' ? row.length - 1 : 0,
      tiles: row.reduce((total, group) => total + group.chars.length, 0),
    })),
    boardWidth,
  );

  const board = rows.map((row, rowIndex) => (
    <View key={rowIndex} style={styles.row}>
      {row.map((group, groupIndex) => (
        <View key={groupIndex} style={styles.group}>
          {groupIndex > 0 ? (
            <Text
              allowFontScaling={false}
              style={[
                styles.separator,
                {
                  color: colors.digitDim,
                  fontSize: tile.font * 0.6,
                  width: separatorWidth * scale,
                },
              ]}
            >
              /
            </Text>
          ) : null}
          {[...group.chars].map((char, charIndex) => (
            <View key={charIndex} style={[styles.tile, { height: tile.height, width: tile.width }]}>
              <View style={[styles.half, { backgroundColor: colors.scoreTileTop }]} />
              <View style={[styles.split, { backgroundColor: colors.scoreboard }]} />
              <View style={[styles.half, { backgroundColor: colors.scoreTileBottom }]} />
              <Text
                allowFontScaling={false}
                style={[
                  styles.char,
                  {
                    color: group.reference ? colors.digitDim : colors.digit,
                    fontSize: tile.font,
                    lineHeight: tile.height,
                  },
                ]}
              >
                {char}
              </Text>
              <View
                style={[
                  styles.splitOverlay,
                  { backgroundColor: colors.scoreboard, top: tile.height / 2 - 1 },
                ]}
              />
            </View>
          ))}
        </View>
      ))}
    </View>
  ));

  if (decorative) {
    return (
      <View
        accessibilityElementsHidden
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        onLayout={onLayout}
        style={[styles.board, { backgroundColor: colors.scoreboard }]}
        testID={testID}
      >
        <View style={styles.rows}>{board}</View>
      </View>
    );
  }

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessible
      onLayout={onLayout}
      role="img"
      style={[styles.board, { backgroundColor: colors.scoreboard }]}
      testID={testID}
    >
      <View
        accessibilityElementsHidden
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        style={styles.rows}
      >
        {board}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  board: {
    alignItems: 'center',
    alignSelf: 'stretch',
    borderRadius: radius.scoreboard,
    maxWidth: maxBoardWidth,
    overflow: 'hidden',
    paddingHorizontal: boardPadding,
    paddingVertical: spacing.md + spacing.xs,
    width: '100%',
  },
  char: {
    ...typography.scoreboard,
    left: 0,
    position: 'absolute',
    right: 0,
    textAlign: 'center',
    top: 0,
  },
  group: { alignItems: 'center', flexDirection: 'row', gap: tileGap },
  half: { flex: 1 },
  row: { flexDirection: 'row', gap: tileGap, justifyContent: 'center' },
  rows: { gap: spacing.ms },
  separator: { ...typography.scoreboard, textAlign: 'center' },
  split: { height: 2 },
  splitOverlay: { height: 2, left: 0, opacity: 0.85, position: 'absolute', right: 0 },
  tile: { borderRadius: radius.tile, overflow: 'hidden' },
});
