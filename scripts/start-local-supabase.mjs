import { spawnSync } from 'node:child_process';
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

// Local and CI use the public 00..1f vector from docs/13 section 0.1. Build it
// as bytes here so the npm command and process logs never print key material.
const publicTestKey = Array.from({ length: 32 }, (_, byte) =>
  byte.toString(16).padStart(2, '0'),
).join('');

const result = spawnSync(supabaseBinary, ['start'], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    IDEMPOTENCY_HMAC_KEY_V1: publicTestKey,
    SUPABASE_TELEMETRY_DISABLED: '1',
  },
  stdio: 'inherit',
});

if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
