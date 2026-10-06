import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readScope } from './audit-scope.mjs';
const semver = createRequire(import.meta.url)('semver');
import { pathToFileURL } from 'node:url';

const serious = (severity) => ['high', 'critical'].includes(severity);
const advisoryId = (advisory) =>
  /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(advisory.url)?.[1];

export function evaluateAudit(
  report,
  exceptions,
  today = new Date().toISOString().slice(0, 10),
  scope = null,
  lock = null,
  output = [],
) {
  const errors = [];
  if (
    report.auditReportVersion !== 2 ||
    report.error ||
    !report.vulnerabilities ||
    !Array.isArray(exceptions)
  ) {
    return ['Saída do audit ou arquivo de exceções inválido.'];
  }
  const entries = report.vulnerabilities;
  const allowed = new Map();
  for (const exception of exceptions) {
    const { id, package: packageName, expiresOn } = exception;
    if (
      !/^GHSA-[a-z0-9-]+$/.test(id) ||
      !packageName ||
      !exception.reason ||
      !exception.evidence ||
      !exception.decidedBy ||
      !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) ||
      Number.isNaN(Date.parse(expiresOn)) ||
      new Date(expiresOn).toISOString().slice(0, 10) !== expiresOn ||
      allowed.has(id)
    ) {
      errors.push(`Exceção inválida: ${id}`);
      continue;
    }
    allowed.set(id, exception);
    if (today >= expiresOn)
      errors.push(
        `Exceção vencida: ${id} (${expiresOn}). Remova a entrada e corrija a dependência.`,
      );
    const active = Object.values(entries).some(
      (entry) =>
        Array.isArray(entry.via) &&
        entry.via.some(
          (via) =>
            typeof via === 'object' &&
            advisoryId(via) === id &&
            via.name === packageName &&
            serious(via.severity) &&
            classify(via).blocking,
        ),
    );
    if (!active)
      errors.push(
        `Exceção órfã: ${id}. Remova a entrada; o alerta não está ativo para ${packageName}.`,
      );
  }
  function roots(name, seen = new Set()) {
    if (seen.has(name)) return [];
    if (!entries[name] || !Array.isArray(entries[name].via)) {
      return [{ name, severity: 'high' }];
    }
    const next = new Set([...seen, name]);
    return entries[name].via.flatMap((via) => (typeof via === 'string' ? roots(via, next) : [via]));
  }
  function classify(cause) {
    const entry = entries[cause.name];
    const versions = (entry?.nodes ?? []).map((path) => ({
      path,
      version: lock?.packages?.[path]?.version,
    }));
    let known = Boolean(
      scope && lock && versions.length && cause.range && semver.validRange(cause.range),
    );
    if (versions.some(({ version }) => !semver.valid(version))) known = false;
    const affected = known
      ? versions.filter(({ version }) => semver.satisfies(version, cause.range))
      : versions;
    if (!affected.length) known = false;
    const published =
      !known ||
      affected.some(({ version }) =>
        scope.packages.some((pkg) => pkg.name === cause.name && pkg.version === version),
      );
    return {
      blocking: cause.severity === 'critical' || published,
      published: known ? published : null,
      versions: affected,
      known,
    };
  }
  for (const [name, entry] of Object.entries(entries)) {
    if (!serious(entry.severity)) continue;
    const causes = roots(name);
    if (!causes.length) errors.push(`Alerta ${entry.severity} sem causa identificável: ${name}.`);
    if (!causes.some((cause) => serious(cause.severity))) {
      errors.push(`Alerta ${entry.severity} sem causa alta ou crítica identificável: ${name}.`);
    }
    for (const cause of causes.filter((cause) => serious(cause.severity))) {
      const id = advisoryId(cause);
      const classification = classify(cause);
      if (entry.severity === 'critical') classification.blocking = true;
      output.push({
        id: id ?? null,
        package: cause.name,
        severity: cause.severity,
        ...classification,
        fixAvailable: entries[cause.name]?.fixAvailable ?? null,
      });
      if (!classification.blocking) continue;
      const exception = allowed.get(id);
      if (
        cause.severity === 'critical' ||
        entry.severity === 'critical' ||
        !exception ||
        exception.package !== cause.name ||
        today >= exception.expiresOn
      ) {
        errors.push(
          `Alerta ${cause.severity} não autorizado: ${id ?? cause.url ?? name} (${cause.name}).`,
        );
      }
    }
  }
  return [...new Set(errors)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const result = spawnSync('npm', ['audit', '--json', '--audit-level=high'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || ![0, 1].includes(result.status))
      throw new Error('Não foi possível executar npm audit.');
    const report = JSON.parse(result.stdout);
    const exceptions = JSON.parse(
      readFileSync(new URL('../audit-exceptions.json', import.meta.url), 'utf8'),
    );
    const root = resolve(new URL('..', import.meta.url).pathname);
    const scope = readScope(root);
    let lock = null;
    try {
      lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json')));
    } catch {
      /* conservative fallback */
    }
    const rows = [];
    const errors = evaluateAudit(report, exceptions, undefined, scope, lock, rows);
    const unique = [...new Map(rows.map((row) => [JSON.stringify(row), row])).values()];
    const lines = [];
    if (!scope) lines.push('Conjunto publicado inválido ou ausente: todos os HIGH bloqueiam.');
    for (const [label, blocking] of [
      ['BLOQUEIA', true],
      ['AVISOS (não publicados)', false],
    ]) {
      lines.push(label);
      const section = unique.filter((row) => row.blocking === blocking);
      for (const row of section)
        lines.push(
          `${row.id ?? 'GHSA desconhecido'} | ${row.package} | ${row.severity} | ${row.versions.map((v) => `${v.version ?? '?'} (${v.path})`).join(', ') || 'versão/caminho desconhecidos'} | publicado: ${row.published === null ? 'incerto' : row.published ? 'sim' : 'não'} | correção: ${row.fixAvailable === true ? 'disponível segundo npm' : row.fixAvailable?.name === row.package ? row.fixAvailable.version : 'não informada para a causa raiz'} (npm: ${JSON.stringify(row.fixAvailable)})`,
        );
      if (!section.length) lines.push('(nenhum)');
    }
    console.log(lines.join('\n'));
    // The CLI always emits the report, including blocking advisories.
    mkdirSync(resolve(root, '.expo'), { recursive: true });
    writeFileSync(
      resolve(root, '.expo/audit-report.json'),
      JSON.stringify({ commit: scope?.commit ?? null, alerts: unique, errors }, null, 2) + '\n',
    );
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(
        `Audit aprovado: nenhum alerta alto ou crítico fora das ${exceptions.length} exceções ativas.`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
