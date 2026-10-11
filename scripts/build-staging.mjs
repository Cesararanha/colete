import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { exportHashes, deploymentConfiguration, supabaseOrigin } from './staging-headers.mjs';

supabaseOrigin(process.env.EXPO_PUBLIC_SUPABASE_URL);
if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ''))
  throw new Error('Build requires a publishable key');
if (process.env.EXPO_PUBLIC_SMOKE_MODE === 'true')
  throw new Error('Staging cannot use smoke fixtures');
const result = spawnSync('npm', ['run', 'build:web'], {
  stdio: 'inherit',
  env: { ...process.env, EXPO_PUBLIC_SMOKE_MODE: 'false' },
});
if (result.status !== 0) process.exit(result.status ?? 1);
const hashes = await exportHashes('dist');
const htmlFiles = (await readdir('dist', { recursive: true })).filter((file) =>
  file.endsWith('.html'),
);
const config = deploymentConfiguration(process.env.EXPO_PUBLIC_SUPABASE_URL, hashes, htmlFiles);
await rm('.vercel/output', { recursive: true, force: true });
await mkdir('.vercel/output', { recursive: true });
await cp('dist', '.vercel/output/static', { recursive: true });
await writeFile('.vercel/output/config.json', JSON.stringify(config, null, 2) + '\n');
console.log('Static staging output and CSP generated from the build environment.');
