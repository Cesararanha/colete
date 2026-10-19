import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Platform } from 'react-native';

import { fitWithin } from './photo-size';

/** JPEG quality of the re-encoded photo: a 512 px picture stays far below 1 MB. */
const JPEG_QUALITY = 0.82;

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Turns the picked picture into what may leave the device: at most 512 px on
 * its longer side and re-encoded as JPEG. Re-encoding writes new pixels and no
 * metadata, so the camera's Exif, GPS included, stays behind (0030). The
 * result is the upload body: raw bytes on the web, a file part on native,
 * where fetch has no reliable way to send bytes built in JavaScript.
 */
export async function preparePhoto(asset: {
  uri: string;
  width?: number;
  height?: number;
}): Promise<BodyInit> {
  const width = asset.width ?? 0;
  const height = asset.height ?? 0;
  // The picker measures every picture it returns; no size means the device
  // could not decode it, and nothing is sent.
  if (!(width > 0 && height > 0)) throw new Error('photo could not be decoded');
  const context = ImageManipulator.manipulate(asset.uri);
  const size = fitWithin(width, height);
  if (size !== null) context.resize(size);
  const image = await context.renderAsync();
  const saved = await image.saveAsync({
    format: SaveFormat.JPEG,
    compress: JPEG_QUALITY,
    base64: Platform.OS === 'web',
  });
  if (Platform.OS === 'web') {
    if (saved.base64 === undefined) throw new Error('photo was not encoded');
    // The bytes come from the encoder output itself, not from a fetch of its
    // blob: URL, which the app's connect-src does not allow.
    const bytes = bytesFromBase64(saved.base64);
    return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' });
  }
  const body = new FormData();
  body.append('', { uri: saved.uri, name: 'photo.jpg', type: 'image/jpeg' } as unknown as Blob);
  return body;
}
