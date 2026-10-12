// Local proof only. No proxy: exported files and the generated security headers.
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { exportHashes, securityHeaders, cacheControl } from './staging-headers.mjs';

const hashes = await exportHashes('dist');
const config = JSON.parse(await readFile('.expo/staging-local.json', 'utf8'));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const assetRequest = /^(?:\/(?:_expo|icons|assets)(?:\/|$))|\.[^/]+$/.test(pathname);
    let missing = false;
    let file = path.resolve('dist', '.' + pathname);
    const root = path.resolve('dist');
    if (!file.startsWith(root + '/') && file !== root) {
      response.writeHead(400);
      response.end();
      return;
    }
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      await stat(file);
    } catch {
      try {
        await stat(file + '.html');
        file += '.html';
      } catch {
        if (assetRequest) missing = true;
        else file = path.join(root, 'index.html');
      }
    }
    // Existing privacy tests load the locked SDK as an external same-origin fixture.
    // This route exists only in this local proof server, never deployment output.
    if (pathname === '/__test__/supabase.js') {
      file = path.resolve('node_modules/@supabase/supabase-js/dist/umd/supabase.js');
      missing = false;
    }
    const directOrigins = [];
    for (const name of await readdir('.expo')) {
      if (!name.startsWith('cors-direct-')) continue;
      try {
        directOrigins.push((await readFile(path.join('.expo', name, 'origin'), 'utf8')).trim());
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const headers = securityHeaders(config.origin, hashes, {
      local: true,
      directOrigins,
      strictStyles: process.env.COLETE_CSP_STRICT_STYLES === 'true',
    });
    if (missing) {
      response.writeHead(404, { ...headers, 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    response.writeHead(200, {
      ...headers,
      'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': cacheControl(pathname),
    });
    response.end(await readFile(file));
  } catch {
    response.writeHead(500);
    response.end('Local staging server failed');
  }
}).listen(4173, '127.0.0.1', () => console.log('Local staging headers server ready'));
