import { createRequire } from 'node:module';
const semver = createRequire(import.meta.url)('semver');
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const scopeFile = '.expo/audit-shipped.json';
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function context(root) {
  const lockPath = resolve(root, 'package-lock.json');
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
    .sort();
  const sourceSha256 = digest(
    files.map((file) => `${file}\0${digest(readFileSync(resolve(root, file)))}`).join('\0'),
  );
  return {
    sourceSha256,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    lockSha256: digest(readFileSync(lockPath)),
    lockMtime: statSync(lockPath).mtimeMs,
  };
}
export function readScope(root) {
  try {
    const current = context(root);
    const path = resolve(root, scopeFile);
    const scope = JSON.parse(readFileSync(path));
    if (
      scope.schema !== 1 ||
      scope.commit !== current.commit ||
      scope.lockSha256 !== current.lockSha256 ||
      scope.sourceSha256 !== current.sourceSha256 ||
      statSync(path).mtimeMs < current.lockMtime ||
      !Number.isFinite(scope.generatedAt) ||
      scope.generatedAt < current.lockMtime ||
      !Array.isArray(scope.packages) ||
      !scope.packages.length ||
      scope.packages.some((entry) => !entry.name || !semver.valid(entry.version) || !entry.path)
    ) {
      return null;
    }
    return scope;
  } catch {
    return null;
  }
}
