import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { evaluateAudit } from './audit-high.mjs';
import { digest } from './audit-scope.mjs';

// Independent copies: production exceptions can expire or be removed without
// changing the mechanism tests.
const exceptions = [
  { id: 'GHSA-86w9-cpqp-85rv', package: 'node-forge' },
  { id: 'GHSA-vfj7-8cjw-p6xm', package: 'braces' },
].map((entry) => ({
  ...entry,
  reason: 'Synthetic mechanism fixture',
  evidence: 'Versioned audit reports',
  decidedBy: 'Test fixture',
  expiresOn: '2099-01-01',
}));
const [exception] = exceptions;
const today = '2026-10-02';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/audit-high.json', import.meta.url)));

// Executa o mesmo CLI da CI. Somente o processo npm é substituído pelo fixture;
// não há flag ou variável de bypass no código produtivo.
function runCli(
  report,
  exceptions,
  date = today,
  published = undefined,
  lock = undefined,
  invalid = undefined,
) {
  const root = mkdtempSync(join(tmpdir(), 'colete-audit-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'bin'));
    symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'));
    copyFileSync(
      new URL('./audit-scope.mjs', import.meta.url),
      join(root, 'scripts/audit-scope.mjs'),
    );
    writeFileSync(
      join(root, 'bin/git'),
      '#!/usr/bin/env node\nprocess.stdout.write(process.argv.includes("ls-files") ? "package-lock.json\\0" : "fixture-commit\\n");\n',
      {
        mode: 0o755,
      },
    );
    if (lock) {
      writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
      utimesSync(join(root, 'package-lock.json'), 1, 1);
    }
    if (published !== undefined) {
      mkdirSync(join(root, '.expo'));
      const manifest = {
        schema: 1,
        sourceSha256: digest(`package-lock.json\0${digest(JSON.stringify(lock))}`),
        commit: 'fixture-commit',
        lockSha256: digest(JSON.stringify(lock)),
        generatedAt: 2000,
        packages: published,
      };
      if (invalid === 'commit') manifest.commit = 'different';
      if (invalid === 'old') manifest.generatedAt = 0;
      if (invalid === 'hash') manifest.lockSha256 = 'different';
      if (invalid === 'sources') manifest.sourceSha256 = 'different';
      writeFileSync(join(root, '.expo/audit-shipped.json'), JSON.stringify(manifest));
    }
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
    // Only the disposable subprocess clock is controlled. The CLI source is
    // copied unchanged; evaluateAudit receives explicit dates below as well.
    writeFileSync(
      join(root, 'clock.cjs'),
      `
      const RealDate = Date;
      const fixed = ${JSON.stringify(date)} + 'T12:00:00Z';
      global.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [fixed])); }
        static now() { return RealDate.parse(fixed); }
      };
    `,
    );
    return spawnSync(
      process.execPath,
      ['--require', join(root, 'clock.cjs'), join(root, 'scripts/audit-high.mjs')],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}` },
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('alerta listado dentro do prazo passa; sem exceção reprova', () => {
  assert.deepEqual(evaluateAudit(fixture, [exception], today), []);
  assert.equal(runCli(fixture, [exception]).status, 0);
  assert.equal(runCli(fixture, []).status, 1);
});
test('mesma entrada vencida reprova no início da data limite', () => {
  assert.match(
    evaluateAudit(fixture, [{ ...exception, expiresOn: '2026-10-16' }], '2026-10-16').join(' '),
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
  assert.equal(runCli(report, exceptions).status, 0);
  const result = runCli(report, [exception]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /não autorizado: GHSA-vfj7-8cjw-p6xm/);
});

const rootCause = {
  name: 'vulnerable',
  severity: 'high',
  range: '<2.0.0',
  url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
};
const versioned = {
  auditReportVersion: 2,
  vulnerabilities: {
    top: { severity: 'high', via: ['vulnerable'] },
    vulnerable: {
      severity: 'high',
      via: [rootCause],
      nodes: ['node_modules/vulnerable', 'node_modules/top/node_modules/vulnerable'],
      fixAvailable: true,
    },
  },
};
const versionLock = {
  packages: {
    'node_modules/vulnerable': { version: '1.0.0' },
    'node_modules/top/node_modules/vulnerable': { version: '2.0.0' },
  },
};
const shipped = (name, version) => [{ name, version, path: `node_modules/${name}` }];
const rootException = { ...exception, id: 'GHSA-aaaa-bbbb-cccc', package: 'vulnerable' };
test('HIGH publicado: sem exceção reprova, válida passa, vencida reprova', () => {
  const args = [today, shipped('vulnerable', '1.0.0'), versionLock];
  assert.equal(runCli(versioned, [], ...args).status, 1);
  assert.equal(runCli(versioned, [rootException], ...args).status, 0);
  assert.equal(
    runCli(versioned, [{ ...rootException, expiresOn: '2000-01-01' }], ...args).status,
    1,
  );
});
test('HIGH não publicado passa e lista aviso, GHSA, versão, caminho e correção', () => {
  const result = runCli(versioned, [], today, shipped('other', '1.0.0'), versionLock);
  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /AVISOS \(não publicados\)[\s\S]*GHSA-aaaa-bbbb-cccc.*vulnerable.*1.0.0.*node_modules\/vulnerable.*correção: disponível segundo npm/,
  );
});
test('CRITICAL não publicado reprova', () => {
  const report = structuredClone(versioned);
  report.vulnerabilities.vulnerable.via[0].severity = 'critical';
  assert.equal(runCli(report, [], today, shipped('other', '1.0.0'), versionLock).status, 1);
});
test('conjunto ausente, vazio, antigo, commit ou lock divergente mantém HIGH bloqueante', () => {
  assert.equal(runCli(versioned, [], today, undefined, versionLock).status, 1);
  assert.equal(runCli(versioned, [], today, [], versionLock).status, 1);
  for (const invalid of ['old', 'commit', 'hash', 'sources']) {
    const result = runCli(versioned, [], today, shipped('other', '1.0.0'), versionLock, invalid);
    assert.equal(result.status, 1, invalid);
    assert.match(result.stdout, /todos os HIGH bloqueiam/);
  }
});
test('duas versões: somente a vulnerável publicada bloqueia; somente a corrigida avisa', () => {
  assert.equal(runCli(versioned, [], today, shipped('vulnerable', '1.0.0'), versionLock).status, 1);
  assert.equal(runCli(versioned, [], today, shipped('vulnerable', '2.0.0'), versionLock).status, 0);
});
test('causa publicada atrás de cadeia e ciclo bloqueia mesmo com topo ausente', () => {
  const report = structuredClone(versioned);
  report.vulnerabilities.vulnerable.via.push('top');
  assert.equal(runCli(report, [], today, shipped('vulnerable', '1.0.0'), versionLock).status, 1);
});
test('exceção de pacote não publicado é órfã', () => {
  const result = runCli(versioned, [rootException], today, shipped('other', '1.0.0'), versionLock);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Exceção órfã/);
});
test('versão ou range incerto bloqueia', () => {
  const report = structuredClone(versioned);
  delete report.vulnerabilities.vulnerable.via[0].range;
  assert.equal(runCli(report, [], today, shipped('other', '1.0.0'), versionLock).status, 1);
  assert.equal(runCli(versioned, [], today, shipped('other', '1.0.0'), { packages: {} }).status, 1);
});

test('CRITICAL propagado no topo também bloqueia causa HIGH não publicada', () => {
  const report = structuredClone(versioned);
  report.vulnerabilities.top.severity = 'critical';
  assert.equal(runCli(report, [], today, shipped('other', '1.0.0'), versionLock).status, 1);
});

test('export estático inclui somente módulos client e deduplica snapshots', async () => {
  const { publishedWebModules } = await import('./audit-module-graph.mjs');
  const graphs = [
    { platform: 'web', environment: 'node', modules: ['/build-only.js'] },
    { platform: 'web', environment: 'client', modules: ['/published.js'] },
    { platform: 'web', environment: 'client', modules: ['/published.js', '/other.js'] },
  ];
  assert.deepEqual([...publishedWebModules(graphs, 'static')], ['/published.js', '/other.js']);
});
test('grafo ou modo de publicação incerto impede gerar conjunto', async () => {
  const { publishedWebModules } = await import('./audit-module-graph.mjs');
  const client = { platform: 'web', environment: 'client', modules: ['/published.js'] };
  for (const graphs of [
    [],
    [{ ...client, environment: 'node' }],
    [{ ...client, environment: 'unknown' }],
    [{ ...client, platform: 'ios' }],
    [{ ...client, modules: [] }],
    [{ ...client, modules: [null] }],
  ])
    assert.throws(() => publishedWebModules(graphs, 'static'));
  assert.throws(() => publishedWebModules([client], 'server'));
});
