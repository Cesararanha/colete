import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const serious = (severity) => ['high', 'critical'].includes(severity);
const advisoryId = (advisory) =>
  /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(advisory.url)?.[1];

export function evaluateAudit(report, exceptions, today = new Date().toISOString().slice(0, 10)) {
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
    const active = Object.values(entries).some((entry) =>
      entry.via.some(
        (via) => typeof via === 'object' && advisoryId(via) === id && via.name === packageName,
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
  for (const [name, entry] of Object.entries(entries)) {
    if (!serious(entry.severity)) continue;
    const causes = roots(name);
    if (!causes.length) errors.push(`Alerta ${entry.severity} sem causa identificável: ${name}.`);
    if (!causes.some((cause) => serious(cause.severity))) {
      errors.push(`Alerta ${entry.severity} sem causa alta ou crítica identificável: ${name}.`);
    }
    for (const cause of causes.filter((cause) => serious(cause.severity))) {
      const id = advisoryId(cause);
      const exception = allowed.get(id);
      if (!exception || exception.package !== cause.name || today >= exception.expiresOn) {
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
    const errors = evaluateAudit(report, exceptions);
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
