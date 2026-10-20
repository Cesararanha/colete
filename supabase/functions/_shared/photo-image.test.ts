import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { PHOTO_MAX_BYTES, inspectJpeg } from './photo-image.ts';

/** Reads IFD0 of an Exif APP1 and says whether it points to a GPS directory (tag 0x8825). */
function exifGpsPointer(bytes: Uint8Array): boolean {
  for (let index = 2; index + 4 < bytes.length;) {
    if (bytes[index] !== 0xff) return false;
    const marker = bytes[index + 1] as number;
    const length = ((bytes[index + 2] as number) << 8) | (bytes[index + 3] as number);
    const data = index + 4;
    if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(data, data + 6)) === 'Exif\0\0') {
      const tiff = data + 6;
      const little = bytes[tiff] === 0x49;
      const u16 = (at: number) =>
        little
          ? (bytes[at] as number) | ((bytes[at + 1] as number) << 8)
          : ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
      const u32 = (at: number) =>
        little ? u16(at) + u16(at + 2) * 65536 : u16(at) * 65536 + u16(at + 2);
      const ifd0 = tiff + u32(tiff + 4);
      const entries = u16(ifd0);
      for (let entry = 0; entry < entries; entry += 1) {
        if (u16(ifd0 + 2 + entry * 12) === 0x8825) return true;
      }
      return false;
    }
    if (marker === 0xda) return false;
    index += 2 + length;
  }
  return false;
}

async function jpeg(width: number, height: number, withGps = false): Promise<Uint8Array> {
  let image = sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } },
  });
  if (withGps) {
    image = image.withExif({
      IFD0: { Make: 'Colete Test Camera' },
      IFD3: {
        GPSLatitudeRef: 'S',
        GPSLatitude: '23/1 33/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '46/1 38/1 0/1',
      },
    });
  }
  return new Uint8Array(await image.jpeg({ quality: 80 }).toBuffer());
}

describe('inspectJpeg', () => {
  it('accepts a clean JPEG within 512 px and reads its size', async () => {
    expect(inspectJpeg(await jpeg(512, 384))).toEqual({ ok: true, width: 512, height: 384 });
  });

  it('refuses a JPEG whose Exif carries GPS, and the fixture really carries it', async () => {
    const bytes = await jpeg(400, 300, true);
    expect(exifGpsPointer(bytes)).toBe(true);
    expect(inspectJpeg(bytes)).toEqual({ ok: false, reason: 'metadata' });
    // Re-encoded without metadata, the same picture passes: the refusal is
    // about the APP1 segment, not the pixels.
    const clean = new Uint8Array(await sharp(bytes).jpeg({ quality: 80 }).toBuffer());
    expect(exifGpsPointer(clean)).toBe(false);
    expect(inspectJpeg(clean).ok).toBe(true);
  });

  it('refuses XMP and IPTC as well as Exif', async () => {
    const base = await jpeg(64, 64);
    const segment = (marker: number, text: string) => {
      const payload = new TextEncoder().encode(text);
      const length = payload.length + 2;
      return Uint8Array.of(0xff, marker, length >> 8, length & 255, ...payload);
    };
    const inject = (extra: Uint8Array) =>
      Uint8Array.of(...base.subarray(0, 2), ...extra, ...base.subarray(2));
    expect(inspectJpeg(inject(segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x/>')))).toEqual({
      ok: false,
      reason: 'metadata',
    });
    expect(inspectJpeg(inject(segment(0xed, 'Photoshop 3.0\0')))).toEqual({
      ok: false,
      reason: 'metadata',
    });
    expect(inspectJpeg(inject(segment(0xe2, 'MPF\0')))).toEqual({ ok: false, reason: 'metadata' });
    // An ICC profile and a comment carry no place or device.
    expect(inspectJpeg(inject(segment(0xe2, 'ICC_PROFILE\0\x01\x01'))).ok).toBe(true);
    expect(inspectJpeg(inject(segment(0xfe, 'colete'))).ok).toBe(true);
  });

  it('refuses metadata hidden after the first scan', async () => {
    const base = await jpeg(64, 64);
    const end = base.length - 2;
    const app1 = Uint8Array.of(0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00);
    const smuggled = Uint8Array.of(...base.subarray(0, end), ...app1, 0xff, 0xd9);
    expect(inspectJpeg(smuggled)).toEqual({ ok: false, reason: 'metadata' });
  });

  it('refuses a longer side above 512 px', async () => {
    expect(inspectJpeg(await jpeg(513, 200))).toEqual({ ok: false, reason: 'dimensions' });
    expect(inspectJpeg(await jpeg(200, 600))).toEqual({ ok: false, reason: 'dimensions' });
  });

  it('refuses other types, truncation, trailing data, empty and oversized files', async () => {
    const png = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
        .png()
        .toBuffer(),
    );
    expect(inspectJpeg(png)).toEqual({ ok: false, reason: 'not_jpeg' });
    const base = await jpeg(64, 64);
    expect(inspectJpeg(base.subarray(0, base.length - 40)).ok).toBe(false);
    expect(inspectJpeg(Uint8Array.of(...base, 0x00, 0x01))).toEqual({
      ok: false,
      reason: 'trailing_data',
    });
    expect(inspectJpeg(new Uint8Array())).toEqual({ ok: false, reason: 'empty' });
    expect(inspectJpeg(new Uint8Array(PHOTO_MAX_BYTES + 1))).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });
  it('refuses a JPEG with no image in it, as the decoder does (bugbash BB-007)', async () => {
    const decodes = async (bytes: Uint8Array) =>
      sharp(bytes)
        .raw()
        .toBuffer()
        .then(() => true)
        .catch(() => false);
    // rev81: the 13-byte header that the Edge used to accept as a 1x1 photo.
    const header = Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 0, 1, 0, 1, 0xff, 0xd9);
    expect(inspectJpeg(header).ok).toBe(false);
    expect(await decodes(header)).toBe(false);
    const base = await jpeg(64, 64);
    // Each segment of a real file, one at a time, cut out.
    const segments: { marker: number; start: number; end: number }[] = [];
    for (let index = 2; index < base.length;) {
      const marker = base[index + 1] as number;
      const length = ((base[index + 2] as number) << 8) | (base[index + 3] as number);
      segments.push({ marker, start: index, end: index + 2 + length });
      if (marker === 0xda) break;
      index += 2 + length;
    }
    const scanEnd = (segments.at(-1) as { end: number }).end;
    for (const marker of [0xdb, 0xc4, 0xc0]) {
      const kept = segments.filter((segment) => segment.marker !== marker);
      const cut = Uint8Array.of(
        ...base.subarray(0, 2),
        ...kept.flatMap((segment) => [...base.subarray(segment.start, segment.end)]),
        ...base.subarray(scanEnd),
      );
      expect(inspectJpeg(cut).ok, marker.toString(16)).toBe(false);
      expect(await decodes(cut), marker.toString(16)).toBe(false);
    }
    // The scan header with no coded data after it.
    const scan = segments.find((segment) => segment.marker === 0xda)!;
    const empty = Uint8Array.of(...base.subarray(0, scan.end), 0xff, 0xd9);
    expect(inspectJpeg(empty)).toEqual({ ok: false, reason: 'truncated' });
    expect(await decodes(empty)).toBe(false);
    // What the decoder reads, the Edge accepts: baseline, grey and progressive.
    const grey = new Uint8Array(
      await sharp({ create: { width: 32, height: 16, channels: 3, background: '#888' } })
        .greyscale()
        .jpeg()
        .toBuffer(),
    );
    const progressive = new Uint8Array(
      await sharp({ create: { width: 48, height: 48, channels: 3, background: '#a33' } })
        .jpeg({ progressive: true })
        .toBuffer(),
    );
    for (const bytes of [base, grey, progressive]) {
      expect(await decodes(bytes)).toBe(true);
      expect(inspectJpeg(bytes).ok).toBe(true);
    }
  });
});
