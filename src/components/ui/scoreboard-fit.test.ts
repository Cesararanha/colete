import { describe, expect, it } from 'vitest';

import {
  BOARD_PADDING,
  fitTiles,
  MIN_TILE_SCALE,
  SEPARATOR_WIDTH,
  TILE_GAP,
  type BoardRow,
  type TileSize,
} from './scoreboard-fit';

const lg: TileSize = { font: 56, height: 70, width: 44 };
const xl: TileSize = { font: 64, height: 80, width: 50 };
const brand: BoardRow[] = [{ separators: 0, tiles: 6 }];
const invite: BoardRow[] = [
  { separators: 0, tiles: 5 },
  { separators: 0, tiles: 5 },
];
const count: BoardRow[] = [{ separators: 1, tiles: 4 }];

const rowWidth = (row: BoardRow, tile: TileSize, scale: number) =>
  row.tiles * tile.width +
  row.separators * SEPARATOR_WIDTH * scale +
  (row.tiles + row.separators - 1) * TILE_GAP;

describe('scoreboard tile fit', () => {
  // The static web export renders before any width is known (0 / unmeasured).
  // Those sizes stay in the HTML after hydration, so they must be the reference
  // tile, never zero or negative (PR #65 review, P2).
  it.each([0, undefined, Number.NaN, -1])(
    'uses the reference tile while the width is %s',
    (width) => {
      const { scale, tile } = fitTiles(lg, brand, width);
      expect(scale).toBe(1);
      expect(tile).toEqual(lg);
    },
  );

  it('never produces a zero or negative tile, however narrow the board', () => {
    for (const width of [1, 10, 40, 80]) {
      const { scale, tile } = fitTiles(xl, count, width);
      expect(scale).toBeGreaterThanOrEqual(MIN_TILE_SCALE);
      expect(tile.width).toBeGreaterThan(0);
      expect(tile.height).toBeGreaterThan(0);
      expect(tile.font).toBeGreaterThan(0);
    }
  });

  // Fit is measured on the board itself, so a board inside a card at 320 px
  // (224 px wide) keeps its tiles within the padded background (PR #65, P3).
  it.each([
    ['invite in a card at 320 px', lg, invite, 224],
    ['brand at 320 px', lg, brand, 272],
    ['count at 320 px', xl, count, 272],
  ] as const)('keeps every row inside the board: %s', (_, base, rows, boardWidth) => {
    const { scale, tile } = fitTiles(base, rows, boardWidth);
    for (const row of rows) {
      expect(rowWidth(row, tile, scale)).toBeLessThanOrEqual(boardWidth - 2 * BOARD_PADDING);
    }
  });

  it('keeps the reference tile when the board is wide enough', () => {
    expect(fitTiles(lg, invite, 342).tile).toEqual(lg);
  });
});
