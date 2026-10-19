/** The longer side every photo is reduced to before it leaves the device (0030). */
export const PHOTO_MAX_SIDE = 512;

/**
 * The size that fits a picture inside PHOTO_MAX_SIDE without changing its
 * proportions, or null when it already fits: a small picture is re-encoded
 * (which drops its metadata) but never enlarged.
 */
export function fitWithin(
  width: number,
  height: number,
  max = PHOTO_MAX_SIDE,
): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  const longer = Math.max(width, height);
  if (longer <= max) return null;
  const scale = max / longer;
  return {
    width: Math.max(1, Math.min(max, Math.round(width * scale))),
    height: Math.max(1, Math.min(max, Math.round(height * scale))),
  };
}
