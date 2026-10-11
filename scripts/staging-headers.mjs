import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export function supabaseOrigin(value, local = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Supabase URL must be an origin');
  if (
    url.protocol !== 'https:' &&
    !(local && url.protocol === 'http:' && url.hostname === '127.0.0.1')
  )
    throw new Error('Supabase URL must be HTTPS');
  return url.origin;
}

export function inlineHashes(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes, content]) => !/\bsrc\s*=/i.test(attributes) && content.trim())
    .map(([, , content]) => `'sha256-${createHash('sha256').update(content).digest('base64')}'`);
}

export async function exportHashes(directory) {
  const hashes = new Set();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) for (const hash of await exportHashes(file)) hashes.add(hash);
    else if (entry.name.endsWith('.html'))
      for (const hash of inlineHashes(await readFile(file, 'utf8'))) hashes.add(hash);
  }
  return [...hashes].sort();
}

export function securityHeaders(
  origin,
  hashes,
  { local = false, directOrigins = [], strictStyles = false } = {},
) {
  const api = supabaseOrigin(origin, local);
  if (!local && directOrigins.length)
    throw new Error('Direct test origins are forbidden in deployment');
  for (const direct of directOrigins) {
    const url = new URL(direct);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== direct)
      throw new Error('Direct test runtime must be an exact loopback origin');
  }
  const socket = api.replace(/^http/, 'ws');
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    `style-src 'self'${strictStyles ? '' : " 'unsafe-inline'"}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${api} ${socket}${directOrigins.length ? ' ' + directOrigins.join(' ') : ''}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
}

export function cacheControl(pathname) {
  return pathname.startsWith('/_expo/static/') ? 'public, max-age=31536000, immutable' : 'no-store';
}

export function deploymentConfiguration(origin, hashes, htmlFiles) {
  const headers = securityHeaders(origin, hashes);
  const overrides = Object.fromEntries(
    htmlFiles
      .filter((name) => name !== 'index.html')
      .map((name) => [
        name,
        {
          path: name.replace(/(?:\/index)?\.html$/, ''),
          contentType: 'text/html; charset=utf-8',
        },
      ]),
  );
  return {
    version: 3,
    overrides,
    routes: [
      { src: '/(.*)', headers: { ...headers, 'Cache-Control': 'no-store' }, continue: true },
      {
        src: '/_expo/static/(.*)',
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
        continue: true,
      },
      { handle: 'filesystem' },
      { src: '/(.*)', dest: '/index.html' },
    ],
  };
}
