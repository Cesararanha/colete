import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const source = await readFile(new URL('../public/icons/icon.svg', import.meta.url));

await Promise.all(
  [192, 512].map((size) =>
    sharp(source)
      .resize(size, size)
      .png({ compressionLevel: 9, palette: true })
      .toFile(fileURLToPath(new URL(`../public/icons/icon-${size}.png`, import.meta.url))),
  ),
);

console.log('Generated deterministic PWA icons: 192px and 512px.');
