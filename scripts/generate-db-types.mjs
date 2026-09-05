import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const executable = (name) =>
  path.join(
    repositoryRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? `${name}.cmd` : name,
  );
const outputPath = path.join(repositoryRoot, 'src', 'lib', 'database.types.ts');

const generated = spawnSync(executable('supabase'), ['gen', 'types', 'typescript', '--local'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
});

if (generated.error !== undefined) throw generated.error;
if (generated.status !== 0) {
  process.stderr.write(generated.stderr);
  process.exit(generated.status ?? 1);
}
fs.writeFileSync(outputPath, generated.stdout);

const formatted = spawnSync(executable('prettier'), ['--write', outputPath], {
  cwd: repositoryRoot,
  encoding: 'utf8',
});
if (formatted.error !== undefined) throw formatted.error;
if (formatted.status !== 0) {
  process.stderr.write(formatted.stderr);
  process.exit(formatted.status ?? 1);
}
process.stdout.write(
  'Generated and formatted src/lib/database.types.ts from the local database.\n',
);
