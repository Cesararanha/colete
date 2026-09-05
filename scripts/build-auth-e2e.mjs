import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const supabaseBinary = path.join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
);
const expoBinary = path.join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'expo.cmd' : 'expo',
);

let status;
try {
  status = execFileSync(supabaseBinary, ['status', '-o', 'env'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch {
  throw new Error('The local Supabase stack is unavailable. Run npm run db:start first.');
}

const read = (name) => {
  const value = status.match(new RegExp(`^${name}="([^"]+)"$`, 'm'))?.[1];
  if (value === undefined) throw new Error(`supabase status did not expose ${name}`);
  return value;
};

const result = spawnSync(expoBinary, ['export', '--platform', 'web', '--clear'], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    EXPO_NO_TELEMETRY: '1',
    EXPO_PUBLIC_SMOKE_MODE: 'false',
    EXPO_PUBLIC_SUPABASE_URL: read('API_URL'),
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: read('PUBLISHABLE_KEY'),
  },
  stdio: 'inherit',
});

if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
