import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const candidateFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .trim()
  .split('\n')
  .filter(Boolean);

const forbiddenNames = [
  /(^|\/)\.env($|\.)/,
  /\.(?:jks|p8|p12|pem)$/i,
  /(^|\/)(?:id_rsa|id_ed25519)$/,
];
const forbiddenContent = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S+/,
  /(?:AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN)\s*=\s*\S+/,
];
const failures = [];

for (const file of candidateFiles) {
  if (forbiddenNames.some((pattern) => pattern.test(file)) && file !== '.env.example') {
    failures.push(`Forbidden secret-bearing filename is tracked: ${file}`);
    continue;
  }

  if (/\.(?:png|jpg|jpeg|webp|pdf)$/i.test(file)) continue;

  const contents = await readFile(file, 'utf8');
  if (forbiddenContent.some((pattern) => pattern.test(contents))) {
    failures.push(`Forbidden secret material pattern found: ${file}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Secret boundaries verified across ${candidateFiles.length} tracked and untracked files.`,
  );
}
