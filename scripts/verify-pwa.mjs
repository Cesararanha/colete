import { readFile, stat } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('public/manifest.webmanifest', 'utf8'));
const worker = await readFile('public/sw.js', 'utf8');
const failures = [];

if (manifest.display !== 'standalone') failures.push('Manifest display must be standalone');
if (manifest.lang !== 'pt-BR') failures.push('Manifest language must be pt-BR');
if (manifest.start_url !== '/' || manifest.scope !== '/') failures.push('Manifest scope drifted');

for (const size of [192, 512]) {
  const icon = manifest.icons.find((entry) => entry.sizes === `${size}x${size}`);
  if (!icon) {
    failures.push(`Missing ${size}px PWA icon declaration`);
    continue;
  }
  try {
    await stat(`public${icon.src}`);
  } catch {
    failures.push(`Missing generated PWA icon: public${icon.src}`);
  }
}

for (const forbiddenStrategy of [
  'navigate',
  "request.destination === 'document'",
  'caches.addAll',
]) {
  if (worker.includes(forbiddenStrategy)) {
    failures.push(`Service worker contains forbidden cache strategy marker: ${forbiddenStrategy}`);
  }
}

for (const exclusion of ['/auth/', '/storage/', '/proof', '/pix', '/payment']) {
  if (!worker.includes(exclusion))
    failures.push(`Service worker misses sensitive exclusion: ${exclusion}`);
}

if (!worker.includes("request.headers.has('authorization')")) {
  failures.push('Service worker does not reject Authorization-bearing requests');
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('PWA manifest and conservative cache policy verified.');
}
