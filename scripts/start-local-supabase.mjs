import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { localWorkerCronSecret } from './local-worker-test-config.mjs';

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
    // Synthetic public vector, never used by a remote project.
    INVITE_HMAC_KEY_V1: Buffer.from(Array.from({ length: 32 }, (_, byte) => byte)).toString(
      'base64url',
    ),
    // The local web export serves the real join route on this loopback origin.
    INVITE_SHARE_URL_BASE: 'http://127.0.0.1:4173/join',
    COLETE_LOCAL_STACK: 'true',
    APP_ALLOWED_ORIGINS: 'http://127.0.0.1:4173,http://localhost:8081,http://127.0.0.1:8081',
    WORKER_CRON_SECRET: localWorkerCronSecret(),
    SUPABASE_TELEMETRY_DISABLED: '1',
  },
  stdio: 'inherit',
});

if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
