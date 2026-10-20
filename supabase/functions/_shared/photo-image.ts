// The server half of the photo rule (0030, docs/13 section 5.0.9). The app
// shrinks every photo to at most 512 px on its longer side and re-encodes it
// as JPEG, which drops the camera metadata, GPS included. The bucket already
// refuses another declared type and more than 1 MB, but it trusts the
// declared type. Before a photo replaces anything, the Edge reads the stored
// bytes and holds them to the same rule, so a client that skipped the
// re-encoding cannot publish its metadata to the group.

export const PHOTO_MAX_BYTES = 1_048_576;
export const PHOTO_MAX_SIDE = 512;
export const PHOTO_CONTENT_TYPE = 'image/jpeg';

export type PhotoRefusal =
  'empty' | 'too_large' | 'not_jpeg' | 'truncated' | 'metadata' | 'dimensions' | 'trailing_data';

export type PhotoInspection =
  { ok: true; width: number; height: number } | { ok: false; reason: PhotoRefusal };

// Start-of-frame markers carry the dimensions. C4 (DHT), C8 (JPG) and CC
// (DAC) share the range and are not frames. C0–C7 are Huffman-coded and need
// their tables (DHT); C9–CF are arithmetic-coded.
const FRAMES = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const HUFFMAN_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7]);

function startsWith(bytes: Uint8Array, offset: number, ascii: string): boolean {
  if (offset + ascii.length > bytes.length) return false;
  for (let index = 0; index < ascii.length; index += 1) {
    if (bytes[offset + index] !== ascii.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * Walks every marker of the file, scans included, and refuses:
 * - APP1, which holds Exif (and its GPS directory) or XMP;
 * - APP13, which holds IPTC;
 * - APP2 holding MPF, whose secondary images carry their own Exif;
 * - any byte after the end-of-image marker, where some cameras append more;
 * - a file with no image in it (bugbash BB-007, rev81): it needs its
 *   quantisation tables, one frame header whose length matches its
 *   components, the Huffman tables of a Huffman frame and a scan with its
 *   header and coded data before the end. A 13-byte header with none of them
 *   is refused, so it can never replace a photo that renders.
 * JFIF (APP0), an ICC profile (APP2), Adobe (APP14) and comments pass: none
 * of them is written by a camera with a place or a device in it.
 */
export function inspectJpeg(bytes: Uint8Array): PhotoInspection {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > PHOTO_MAX_BYTES) return { ok: false, reason: 'too_large' };
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return { ok: false, reason: 'not_jpeg' };
  }
  let width = 0;
  let height = 0;
  let frame = 0;
  let quantisation = false;
  let huffman = false;
  let scans = 0;
  let index = 2;
  for (;;) {
    if (index >= bytes.length) return { ok: false, reason: 'truncated' };
    if (bytes[index] !== 0xff) return { ok: false, reason: 'not_jpeg' };
    // Any number of fill bytes may precede a marker.
    while (index < bytes.length && bytes[index] === 0xff) index += 1;
    if (index >= bytes.length) return { ok: false, reason: 'truncated' };
    const marker = bytes[index] as number;
    index += 1;
    if (marker === 0xd9) {
      if (index !== bytes.length) return { ok: false, reason: 'trailing_data' };
      break;
    }
    if (marker === 0xdb) quantisation = true;
    if (marker === 0xc4) huffman = true;
    // Standalone markers have no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0x00 || marker === 0xd8) return { ok: false, reason: 'not_jpeg' };
    if (index + 2 > bytes.length) return { ok: false, reason: 'truncated' };
    const length = ((bytes[index] as number) << 8) | (bytes[index + 1] as number);
    if (length < 2 || index + length > bytes.length) return { ok: false, reason: 'truncated' };
    const data = index + 2;
    if (marker === 0xe1 || marker === 0xed) return { ok: false, reason: 'metadata' };
    if (marker === 0xe2 && startsWith(bytes, data, 'MPF\0')) {
      return { ok: false, reason: 'metadata' };
    }
    if (FRAMES.has(marker)) {
      if (frame !== 0 || length < 8) return { ok: false, reason: 'not_jpeg' };
      const components = bytes[data + 5] as number;
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components)
        return { ok: false, reason: 'not_jpeg' };
      frame = marker;
      height = ((bytes[data + 1] as number) << 8) | (bytes[data + 2] as number);
      width = ((bytes[data + 3] as number) << 8) | (bytes[data + 4] as number);
    }
    index += length;
    if (marker === 0xda) {
      if (width === 0 || height === 0) return { ok: false, reason: 'not_jpeg' };
      const components = bytes[data] as number;
      if (components < 1 || components > 4 || length !== 6 + 2 * components)
        return { ok: false, reason: 'not_jpeg' };
      if (!quantisation || (HUFFMAN_FRAMES.has(frame) && !huffman))
        return { ok: false, reason: 'not_jpeg' };
      const coded = index;
      // Entropy-coded data: a 0xFF is a marker only when the next byte is
      // neither a stuffed zero nor a restart marker.
      while (index < bytes.length) {
        if (bytes[index] !== 0xff) {
          index += 1;
          continue;
        }
        const next = bytes[index + 1];
        if (next === undefined) return { ok: false, reason: 'truncated' };
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
          index += next === 0xff ? 1 : 2;
          continue;
        }
        break;
      }
      if (index === coded) return { ok: false, reason: 'truncated' };
      scans += 1;
    }
  }
  if (width === 0 || height === 0 || scans === 0) return { ok: false, reason: 'not_jpeg' };
  if (Math.max(width, height) > PHOTO_MAX_SIDE) return { ok: false, reason: 'dimensions' };
  return { ok: true, width, height };
}
