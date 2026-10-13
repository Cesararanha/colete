export type TileSize = { font: number; height: number; width: number };
/** One board row: how many tiles and how many "/" separators it holds. */
export type BoardRow = { separators: number; tiles: number };

export const TILE_GAP = 6;
export const SEPARATOR_WIDTH = 28;
export const BOARD_PADDING = 16;
/** Tiles never shrink below this share of the reference size, nor reach zero. */
export const MIN_TILE_SCALE = 0.4;

/**
 * Fits the tiles to the board's own measured width. Until the board has been
 * measured (the static web export renders with no width at all) it returns
 * the reference tile: that first render must be valid, because hydration keeps
 * the server's inline sizes, and identical on server and client.
 */
export function fitTiles(base: TileSize, rows: BoardRow[], boardWidth: number | undefined) {
  if (boardWidth === undefined || !(boardWidth > 0)) return { scale: 1, tile: base };
  const inner = boardWidth - 2 * BOARD_PADDING;
  const fit = Math.min(
    ...rows.map((row) => {
      const gaps = (row.tiles + row.separators - 1) * TILE_GAP;
      const scalable = row.tiles * base.width + row.separators * SEPARATOR_WIDTH;
      return (inner - gaps) / scalable;
    }),
  );
  const scale = Math.min(1, Math.max(MIN_TILE_SCALE, Number.isFinite(fit) ? fit : 1));
  return {
    scale,
    tile: {
      font: Math.max(1, Math.floor(base.font * scale)),
      height: Math.max(1, Math.floor(base.height * scale)),
      width: Math.max(1, Math.floor(base.width * scale)),
    },
  };
}
