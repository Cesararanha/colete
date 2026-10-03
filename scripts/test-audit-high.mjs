import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { evaluateAudit } from './audit-high.mjs';

const exception = JSON.parse(readFileSync(new URL('../audit-exceptions.json', import.meta.url)))[0];
const fixture = JSON.parse(readFileSync(new URL('./fixtures/audit-high.json', import.meta.url)));

// Executa o mesmo CLI da CI. Somente o processo npm é substituído pelo fixture;
// não há flag ou variável de bypass no código produtivo.
function runCli(report, exceptions) {
  const root = mkdtempSync(join(tmpdir(), 'colete-audit-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'bin'));
    copyFileSync(
      new URL('./audit-high.mjs', import.meta.url),
      join(root, 'scripts/audit-high.mjs'),
    );
    writeFileSync(join(root, 'audit-exceptions.json'), JSON.stringify(exceptions));
    writeFileSync(
      join(root, 'bin/npm'),
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(report))}); process.exit(1);\n`,
      { mode: 0o755 },
    );
    return spawnSync(process.execPath, [join(root, 'scripts/audit-high.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}` },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('alerta listado dentro do prazo passa; sem exceção reprova', () => {
  assert.deepEqual(evaluateAudit(fixture, [exception], '2026-10-02'), []);
  assert.equal(runCli(fixture, [exception]).status, 0);
  assert.equal(runCli(fixture, []).status, 1);
});
test('mesma entrada vencida reprova no início da data limite', () => {
  assert.match(
    evaluateAudit(fixture, [exception], '2026-10-16').join(' '),
    /Exceção vencida: GHSA-86w9-cpqp-85rv/,
  );
  const result = runCli(fixture, [{ ...exception, expiresOn: '2000-01-01' }]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Exceção vencida: GHSA-86w9-cpqp-85rv/);
});
test('alerta alto não listado reprova mesmo no pacote permitido', () => {
  const report = structuredClone(fixture);
  report.vulnerabilities['node-forge'].via.push({
    name: 'node-forge',
    severity: 'high',
    url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
  });
  const result = runCli(report, [exception]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /não autorizado: GHSA-aaaa-bbbb-cccc/);
});
test('exceção órfã reprova', () => {
  const result = runCli({ auditReportVersion: 2, vulnerabilities: {} }, [exception]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Exceção órfã: GHSA-86w9-cpqp-85rv/);
});
test('alerta crítico não listado, erro de audit e pacote divergente reprovam', () => {
  const report = structuredClone(fixture);
  report.vulnerabilities['node-forge'].via[0].severity = 'critical';
  assert.equal(runCli(report, []).status, 1);
  assert.equal(runCli({ error: {} }, []).status, 1);
  assert.equal(runCli(fixture, [{ ...exception, package: 'outro' }]).status, 1);
});
test('causa desconhecida não desaparece ao lado da causa permitida', () => {
  const report = structuredClone(fixture);
  report.vulnerabilities['@expo/cli'].via.push('pacote-ausente');
  assert.equal(runCli(report, [exception]).status, 1);
});

function cyclicReport(advisory = true) {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      A: { severity: 'high', via: ['B'] },
      B: {
        severity: 'high',
        via: ['A', ...(advisory ? [fixture.vulnerabilities['node-forge'].via[0]] : [])],
      },
    },
  };
}

test('ciclo A↔B com advisory real coberto por exceção passa', () => {
  assert.equal(runCli(cyclicReport(), [exception]).status, 0);
});
test('mesmo ciclo sem exceção reprova citando o GHSA', () => {
  const result = runCli(cyclicReport(), []);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /não autorizado: GHSA-86w9-cpqp-85rv/);
});
test('ciclo puro sem advisory reprova por falta de causa identificável', () => {
  for (const severity of ['high', 'critical']) {
    const report = cyclicReport(false);
    report.vulnerabilities.A.severity = severity;
    const result = runCli(report, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Alerta ${severity} sem causa identificável: A`));
  }
});
test('ciclo ao lado de pacote ausente reprova', () => {
  const report = cyclicReport();
  report.vulnerabilities.B.via.push('pacote-ausente');
  const result = runCli(report, [exception]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /não autorizado: A \(pacote-ausente\)/);
});
test('ciclo ao lado de pacote com via inválido reprova', () => {
  const report = cyclicReport();
  report.vulnerabilities.B.via.push('pacote-invalido');
  report.vulnerabilities['pacote-invalido'] = { severity: 'moderate', via: null };
  const result = runCli(report, [exception]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /não autorizado: A \(pacote-invalido\)/);
});
test('relatório real de 03/10 passa somente com as duas exceções', () => {
  const report = JSON.parse(
    readFileSync(new URL('./fixtures/audit-high-2026-10-03.json', import.meta.url)),
  );
  const exceptions = JSON.parse(readFileSync(new URL('../audit-exceptions.json', import.meta.url)));
  assert.equal(runCli(report, exceptions).status, 0);
  const result = runCli(report, [exception]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /não autorizado: GHSA-vfj7-8cjw-p6xm/);
});
