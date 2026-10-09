import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

export const auditFiles = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'deno.json',
  'deno.jsonc',
  'import_map.json',
  'deno.lock',
  'audit-exceptions.json',
  'scripts/audit-high.mjs',
  'scripts/test-audit-high.mjs',
  'scripts/audit-needed.mjs',
  'scripts/test-audit-needed.mjs',
];

export function isAuditFile(file) {
  file = file.toLowerCase();
  const rooted = `/${file}`;
  return (
    auditFiles.some((item) => posix.basename(item) === posix.basename(file)) ||
    ['/patches/', '/.github/workflows/', '/.github/actions/', '/scripts/fixtures/audit-'].some(
      (prefix) => rooted.includes(prefix),
    )
  );
}

export function needsAudit({ eventName, base, head, git = spawnSync }) {
  const required = (reason) => ({ required: true, reason });
  if (eventName !== 'pull_request') return required('evento diferente de pull_request');
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? '')))
    return required('base ou head ausente ou inválido');
  try {
    const options = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
    // Disable rename detection so both the old and new path are checked.
    const result = git(
      'git',
      ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`, '--'],
      options,
    );
    if (result.error || result.status !== 0) return required('erro ao calcular a diferença');
    if (!result.stdout || !result.stdout.endsWith('\0'))
      return required('lista de arquivos vazia ou inválida');
    const files = result.stdout.slice(0, -1).split('\0');
    if (files.some((file) => !file)) return required('lista de arquivos inválida');

    // Read the entire head tree, including links inherited from the base.
    // Never follow an untrusted link or read its target outside the repository.
    const tree = git('git', ['ls-tree', '-r', '-z', '--full-tree', head], options);
    if (tree.error || tree.status !== 0 || !tree.stdout || !tree.stdout.endsWith('\0'))
      return required('árvore do head indisponível ou inválida');
    for (const entry of tree.stdout.slice(0, -1).split('\0')) {
      const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
      if (!match || match[4].startsWith('/') || match[4].split('/').includes('..'))
        return required('árvore do head inválida');
      const [, mode, , , file] = match;
      const ancestor =
        /(^|\/)(patches|scripts(?:\/fixtures)?|\.github(?:\/(?:actions|workflows))?)$/.test(
          file.toLowerCase(),
        );
      if (mode === '120000' && (isAuditFile(file) || ancestor))
        return required(`arquivo protegido no head é link simbólico: ${file}`);
    }
    const match = files.find(isAuditFile);
    return match ? required(`arquivo protegido alterado: ${match}`) : { required: false };
  } catch {
    return required('erro ao calcular a diferença ou ler o head');
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
  if (!process.env.GITHUB_OUTPUT)
    decision = {
      required: true,
      reason:
        'GITHUB_OUTPUT ausente; nenhuma saída gravada, a condição do workflow exige auditoria',
    };
  console.log(
    decision.required
      ? `auditoria exigida: ${decision.reason}`
      : 'auditoria dispensada: nenhum arquivo de dependência alterado',
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `required=${decision.required}\n`);
}
