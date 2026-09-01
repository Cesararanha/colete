import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const configPath = path.join(root, 'supabase/config.toml');
const migrationPath = path.join(root, 'supabase/migrations/0002_identity_foundation.sql');

const [config, migration] = await Promise.all([
  readFile(configPath, 'utf8'),
  readFile(migrationPath, 'utf8'),
]);

const configLines = config.split(/\r?\n/);
const sessionStart = configLines.findIndex((line) => line.trim() === '[auth.sessions]');
const sessionEnd = configLines.findIndex(
  (line, index) => index > sessionStart && /^\[[^\]]+\]$/.test(line.trim()),
);
const sessionSection =
  sessionStart === -1
    ? undefined
    : configLines.slice(sessionStart + 1, sessionEnd === -1 ? undefined : sessionEnd).join('\n');
const timebox = sessionSection?.match(/^timebox\s*=\s*"([^"]+)"\s*$/m)?.[1];

if (!timebox) {
  throw new Error('supabase/config.toml must define an active [auth.sessions].timebox');
}

const duration = /^(\d+)(s|m|h|d)$/.exec(timebox);
if (!duration) {
  throw new Error(`Unsupported [auth.sessions].timebox duration: ${timebox}`);
}

const unitSeconds = { s: 1n, m: 60n, h: 3600n, d: 86400n };
const configuredSeconds = BigInt(duration[1]) * unitSeconds[duration[2]];
const seededValue = migration.match(
  /\(\s*'auth_session_max_lifetime_seconds'\s*,\s*(\d+)\s*,\s*'seconds'\s*,/,
)?.[1];

if (!seededValue) {
  throw new Error(
    '0002_identity_foundation.sql must seed auth_session_max_lifetime_seconds in seconds',
  );
}

const seededSeconds = BigInt(seededValue);
if (configuredSeconds !== seededSeconds) {
  throw new Error(
    `Auth session lifetime drift: config timebox ${timebox} is ${configuredSeconds} seconds, ` +
      `but private.app_limits seeds ${seededSeconds} seconds`,
  );
}

console.log(`Auth session lifetime verified: ${timebox} = ${seededSeconds} seconds.`);
