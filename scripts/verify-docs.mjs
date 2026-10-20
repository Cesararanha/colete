import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const manifestPath = path.join(root, 'docs/spec-manifest.sha256');
const manifest = await readFile(manifestPath, 'utf8');
const failures = [];

for (const line of manifest.trim().split('\n')) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!match) {
    failures.push(`Malformed manifest line: ${line}`);
    continue;
  }

  const [, expected, relativePath] = match;
  const contents = await readFile(path.join(root, relativePath));
  const actual = createHash('sha256').update(contents).digest('hex');
  if (actual !== expected) failures.push(`Checksum mismatch: ${relativePath}`);
}

const markdownFiles = manifest
  .trim()
  .split('\n')
  .map((line) => line.slice(66))
  .filter((file) => file.endsWith('.md'));

for (const relativePath of markdownFiles) {
  const absolutePath = path.join(root, relativePath);
  const contents = await readFile(absolutePath, 'utf8');
  const fenceCount = (contents.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 !== 0) failures.push(`Unbalanced code fences: ${relativePath}`);

  for (const link of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = link[1]?.split('#')[0];
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;

    const resolved = path.resolve(path.dirname(absolutePath), decodeURIComponent(target));
    try {
      await stat(resolved);
    } catch {
      failures.push(`Broken local link in ${relativePath}: ${target}`);
    }
  }
}

const decisions = await readFile(path.join(root, 'docs/09-pivo-produto.md'), 'utf8');
const decisionRows = [...decisions.matchAll(/^\| D(\d+) \|/gm)].map((match) => Number(match[1]));
const expectedDecisions = Array.from({ length: 62 }, (_, index) => index + 1);
if (decisionRows.join(',') !== expectedDecisions.join(','))
  failures.push('Decision rows D1-D62 drifted');

const notifications = await readFile(path.join(root, 'docs/12-notificacoes.md'), 'utf8');
const notificationRows = new Set(
  [...notifications.matchAll(/^\| N(\d+)(?: 🔒)? \|/gm)].map((match) => Number(match[1])),
);
for (let id = 1; id <= 28; id += 1) {
  if (!notificationRows.has(id)) failures.push(`Notification row N${id} is missing`);
}

const screens = await readFile(path.join(root, 'docs/11-telas-v1.md'), 'utf8');
const screenHeadings = new Set(
  [...screens.matchAll(/^### (\d+) ·/gm)].map((match) => Number(match[1])),
);
for (let id = 1; id <= 25; id += 1) {
  if (!screenHeadings.has(id)) failures.push(`Screen heading ${id} is missing`);
}

// The operational guard inventory is measured from call sites, not frozen in
// the specification manifest. Keep its thirteen entries accurate (PR #56 P3;
// db:test:matches joined with Rachas v1, db:test:match-players with Racha
// completo, db:test:geocode with Rachas: usabilidade, db:test:group-deletion
// with Apagar grupo, db:test:photos with Fotos, db:test:ratings with Notas).
const guardedHarnesses = [];
for (const file of await readdir(path.join(root, 'scripts'))) {
  if (!file.endsWith('.mjs') || file === 'harness-guard.mjs') continue;
  const source = await readFile(path.join(root, 'scripts', file), 'utf8');
  const installed = source.match(/installHarnessGuard\('([^']+)'/);
  if (installed) guardedHarnesses.push(installed[1]);
}
const operational = await readFile(path.join(root, 'docs/26-operacao-m2.md'), 'utf8');
const guardRow =
  operational.split('\n').find((line) => line.startsWith('| `scripts/harness-guard.mjs` |')) ?? '';
const documentedHarnesses = [...guardRow.matchAll(/`(db:test:[^`]+)`/g)].map((match) => match[1]);
if (
  guardedHarnesses.length !== 13 ||
  !guardRow.includes('guarda de treze harnesses:') ||
  guardedHarnesses.sort().join(',') !== documentedHarnesses.sort().join(',')
)
  failures.push('docs/26 harness-guard inventory must list the thirteen actual guarded harnesses');

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Documentation verified: ${markdownFiles.length} files, D1-D62, N1-N28 and 25 screens.`,
  );
}
