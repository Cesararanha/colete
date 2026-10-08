import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const auditFiles = [
  'package.json',
  'package-lock.json',
  'audit-exceptions.json',
  '.npmrc',
  '.node-version',
  'scripts/audit-high.mjs',
  'scripts/test-audit-high.mjs',
  'scripts/audit-needed.mjs',
];

export function needsAudit({ eventName, base, head, git = spawnSync }) {
  const required = (reason) => ({ required: true, reason });
  if (eventName !== 'pull_request') return required('evento diferente de pull_request');
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? '')))
    return required('base ou head ausente ou inválido');
  try {
    // Disable rename detection so both the old and new path are checked.
    const result = git(
      'git',
      ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`, '--'],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.error || result.status !== 0) return required('erro ao calcular a diferença');
    if (!result.stdout || !result.stdout.endsWith('\0'))
      return required('lista de arquivos vazia ou inválida');
    const files = result.stdout.slice(0, -1).split('\0');
    if (files.some((file) => !file)) return required('lista de arquivos inválida');
    const match = files.find(
      (file) =>
        auditFiles.includes(file) ||
        file.startsWith('scripts/fixtures/audit-') ||
        file.startsWith('.github/workflows/'),
    );
    return match ? required(`arquivo protegido alterado: ${match}`) : { required: false };
  } catch {
    return required('erro ao calcular a diferença');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let decision;
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    decision = needsAudit({
      eventName: process.env.GITHUB_EVENT_NAME,
      base: event.pull_request?.base?.sha,
      head: event.pull_request?.head?.sha,
    });
  } catch {
    decision = { required: true, reason: 'evento ausente ou inválido' };
  }
  console.log(
    decision.required
      ? `auditoria exigida: ${decision.reason}`
      : 'auditoria dispensada: nenhum arquivo de dependência alterado',
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `required=${decision.required}\n`);
}
