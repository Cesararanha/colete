import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditFiles, needsAudit } from './audit-needed.mjs';

const context = { eventName: 'pull_request', base: 'a'.repeat(40), head: 'b'.repeat(40) };
const decide = (files) =>
  needsAudit({ ...context, git: () => ({ status: 0, stdout: files.join('\0') + '\0' }) });

for (const file of ['app/index.tsx', 'supabase/migrations/test.sql', 'docs/test.md'])
  test(`dispensa ${file}`, () => assert.equal(decide([file]).required, false));
// Keep this list independent of the implementation for counterproofs.
for (const file of [
  'package.json',
  'package-lock.json',
  'audit-exceptions.json',
  '.npmrc',
  '.node-version',
  'scripts/audit-high.mjs',
  'scripts/test-audit-high.mjs',
  'scripts/audit-needed.mjs',
  'scripts/fixtures/audit-example.json',
  '.github/workflows/example.yml',
])
  test(`exige ${file}`, () => assert.equal(decide([file]).required, true));

test('lista exportada inclui lockfile', () => assert.ok(auditFiles.includes('package-lock.json')));
for (const [name, overrides] of [
  ['base ausente', { base: undefined }],
  ['erro git', { git: () => ({ status: 128, stdout: '' }) }],
  [
    'exceção git',
    {
      git: () => {
        throw new Error('git');
      },
    },
  ],
  ['saída vazia', { git: () => ({ status: 0, stdout: '' }) }],
  ['evento desconhecido', { eventName: 'push' }],
])
  test(name, () => assert.equal(needsAudit({ ...context, ...overrides }).required, true));

for (const [from, to] of [
  ['notes.md', 'package.json'],
  ['package.json', 'notes.md'],
]) {
  test(`rename ${from} → ${to} com git real`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-needed-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      git('config', 'user.name', 'Audit Test');
      git('config', 'user.email', 'audit-test@example.invalid');
      writeFileSync(join(dir, from), '{}\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      renameSync(join(dir, from), join(dir, to));
      git('add', '-A');
      git('commit', '-qm', 'rename');
      const head = git('rev-parse', 'HEAD');
      assert.equal(
        needsAudit({
          eventName: 'pull_request',
          base,
          head,
          git: (command, args, options) => ({
            status: 0,
            stdout: execFileSync(command, args, { ...options, cwd: dir }),
          }),
        }).required,
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
