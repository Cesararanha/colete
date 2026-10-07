import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import {
  publishedWebModules,
  writeExportReceipt,
  installedPackage,
  crossCheckPackages,
} from './audit-module-graph.mjs';
import { collectEdge, collectEdgePackages, publishedPackages } from './build-audit-scope.mjs';
import { evaluateAudit } from './audit-high.mjs';
import { digest } from './audit-scope.mjs';
function setup(run) {
  const root = mkdtempSync(resolve(tmpdir(), 'colete-scope-test-'));
  const lock = { packages: {} };
  const put = (path, value) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const pkg = (path, name, version = '1.0.0', deps = {}) => {
    lock.packages[path] = { version, ...deps };
    put(path + '/package.json', { name, version });
    put(path + '/index.js', 'export default 1;');
  };
  pkg('node_modules/expo', 'expo');
  pkg('node_modules/metro', 'metro');
  put('app/index.js', 'export default 1;');
  put('supabase/functions/sample/index.ts', 'export const ok = 1;');
  const inline = '<script type="module">globalThis.hydrate=true;</script>';
  const signatures = {
    inline: [digest(inline)],
    virtualOwners: { __prelude__: 'node_modules/metro' },
    generators: ['node_modules/metro'],
  };
  let map = {
    version: 3,
    sources: ['/node_modules/expo/virtual/rsc.js', '/app/index.js', '__prelude__'],
    names: [],
    mappings: 'AAAA',
    debugId: 'same-export',
  };
  const exportId = 'new-export';
  put('dist/index.html', inline + '<script src="/main.js"></script>');
  put(
    'dist/main.js',
    'globalThis.x=1;\n//# sourceMappingURL=/main.js.map\n//# debugId=same-export\n',
  );
  const save = () => {
    put('dist/main.js.map', map);
    writeExportReceipt(root, exportId);
  };
  save();
  try {
    run({
      root,
      lock,
      put,
      pkg,
      signatures,
      exportId,
      map,
      save,
      read: () => publishedWebModules(root, signatures, exportId),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const high = (name, path) => ({
  auditReportVersion: 2,
  vulnerabilities: {
    [name]: {
      severity: 'high',
      nodes: [path],
      via: [
        {
          name,
          severity: 'high',
          range: '*',
          url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
        },
      ],
    },
  },
});

test('fonte virtual rsc atribuída a expo; origem fora do sourcesContent não reprova; HIGH bloqueia', () =>
  setup(({ root, lock, map, save, read }) => {
    map.sourcesContent = ['', '', ''];
    // Original line 999, column 999, even though the stub is empty.
    map.mappings = 'AAu+Bu+B';
    save();
    const { modules } = read();
    const pkg = installedPackage(
      root,
      lock,
      [...modules].find((p) => p.includes('/expo/virtual/')),
    );
    assert.equal(pkg.name, 'expo');
    assert.equal(pkg.version, '1.0.0');
    assert.match(
      evaluateAudit(high('expo', pkg.path), [], undefined, { packages: [pkg] }, lock).join(' '),
      /não autorizado/,
    );
    delete map.sourcesContent;
    save();
    assert.equal(read().modules.size, modules.size);
  }));
test('fonte fora das três classes reprova', () =>
  setup(({ map, save, read }) => {
    for (const source of [
      '../outside.js',
      'https://example.invalid/x.js',
      '\0unowned:module',
      'missing-app.js',
      '/app',
    ]) {
      map.sources = [source];
      save();
      assert.throws(read, /Fonte/);
    }
  }));
test('JS sem mapa reprova', () =>
  setup(({ root, read }) => {
    rmSync(resolve(root, 'dist/main.js.map'));
    writeExportReceipt(root, 'new-export');
    assert.throws(read, /ENOENT/);
  }));
test('mapa de outro build ou substituído depois do export reprova', () =>
  setup(({ root, map, save, put, read }) => {
    map.debugId = 'another-build';
    save();
    assert.throws(read, /outro build/);
    map.debugId = 'same-export';
    save();
    put('dist/main.js.map', { ...map, sources: ['other.js'] });
    assert.throws(read, /outro export ou alterado/);
    writeExportReceipt(root, 'previous-export');
    assert.throws(read, /outro export/);
  }));
test('JSON inválido, versão inválida, sources vazio e linhas além do JS reprovam', () =>
  setup(({ root, map, save, put, read }) => {
    map.version = 2;
    save();
    assert.throws(read, /inválido/);
    map.version = 3;
    map.sources = [];
    save();
    assert.throws(read, /inválido/);
    map.sources = ['/app/index.js'];
    map.mappings = 'AAAA;;;;AAAA';
    save();
    assert.throws(read, /linhas do JS/);
    put('dist/main.js.map', '{');
    writeExportReceipt(root, 'new-export');
    assert.throws(read, SyntaxError);
  }));
test('script inline novo ou diferente reprova', () =>
  setup(({ root, put, read }) => {
    put('dist/index.html', '<script>globalThis.newCode=true;</script>');
    writeExportReceipt(root, 'new-export');
    assert.throws(read, /inline novo ou diferente/);
  }));
test('nome e versão vêm do package.json mais próximo; lock divergente reprova', () =>
  setup(({ root, lock, pkg, put }) => {
    pkg('node_modules/alias', 'actual-name', '1.1.0-rc.1');
    assert.equal(
      installedPackage(root, lock, resolve(root, 'node_modules/alias/index.js')).name,
      'actual-name',
    );
    put('node_modules/alias/nested/package.json', {
      type: 'module',
      name: 'internal-export',
      version: '9.0.0',
      private: true,
    });
    assert.equal(
      installedPackage(root, lock, resolve(root, 'node_modules/alias/nested/index.js')).name,
      'actual-name',
    );
    put('node_modules/alias/package.json', { name: 'actual-name', version: '2.0.0' });
    assert.throws(
      () => installedPackage(root, lock, resolve(root, 'node_modules/alias/index.js')),
      /não corresponde ao lock/,
    );
  }));
test('conferência Metro↔mapas: divergências nos dois sentidos reprovam; classe c é permitida', () =>
  setup(({ root, lock, read, pkg, exportId }) => {
    const { modules, generated } = read();
    const graph = {
      exportId,
      platform: 'web',
      environment: 'client',
      modules: [resolve(root, 'node_modules/expo/index.js')],
    };
    assert.doesNotThrow(() =>
      crossCheckPackages(root, lock, modules, generated, [graph], exportId),
    );
    pkg('node_modules/extra', 'extra');
    graph.modules.push(resolve(root, 'node_modules/extra/index.js'));
    assert.throws(
      () => crossCheckPackages(root, lock, modules, generated, [graph], exportId),
      /divergentes/,
    );
    graph.modules.pop();
    modules.add(resolve(root, 'node_modules/extra/index.js'));
    assert.throws(
      () => crossCheckPackages(root, lock, modules, generated, [graph], exportId),
      /divergentes/,
    );
  }));
test('HIGH sintético em @expo/cli e @react-native/js-polyfills bloqueia via sources', () =>
  setup(({ root, lock, pkg, map, save, read }) => {
    for (const name of ['@expo/cli', '@react-native/js-polyfills']) {
      const path = 'node_modules/' + name;
      pkg(path, name);
      map.sources = ['/' + path + '/index.js', '/app/index.js'];
      save();
      const packages = [...read().modules]
        .filter((p) => p.includes('/node_modules/'))
        .map((p) => installedPackage(root, lock, p));
      assert.match(
        evaluateAudit(high(name, path), [], undefined, { packages }, lock).join(' '),
        /não autorizado/,
      );
    }
  }));
test('todas as extensões Edge alcançadas entram, qualquer versão importada', () =>
  setup(({ root, lock, pkg, put }) => {
    pkg('node_modules/dep', 'dep');
    for (const extension of ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']) {
      const file = 'supabase/functions/_shared/probe.' + extension;
      put('supabase/functions/sample/index.ts', "import '../_shared/probe." + extension + "';");
      put(file, "import 'npm:dep@99.99.99';");
      assert.ok(
        collectEdgePackages(root, lock).some((p) => p.name === 'dep'),
        extension,
      );
      rmSync(resolve(root, file));
    }
  }));
test('Edge inclui transitivas, opcionais, peers e todas as versões por nome', () =>
  setup(({ root, lock, pkg, put }) => {
    pkg('node_modules/direct', 'direct', '1.0.0', {
      dependencies: { child: '^1' },
      peerDependencies: { peer: '*' },
      optionalDependencies: { optional: '*' },
    });
    pkg('node_modules/child', 'child', '1.0.0', { dependencies: { direct: '*' } });
    pkg('node_modules/peer', 'peer');
    pkg('node_modules/optional', 'optional');
    pkg('node_modules/direct/node_modules/child', 'child', '2.0.0');
    put('supabase/functions/sample/index.ts', "export { default } from 'npm:direct@9.0.0';");
    const packages = collectEdgePackages(root, lock);
    assert.deepEqual([...new Set(packages.map((p) => p.name))].sort(), [
      'child',
      'direct',
      'optional',
      'peer',
    ]);
    assert.deepEqual(
      packages
        .filter((p) => p.name === 'child')
        .map((p) => p.version)
        .sort(),
      ['1.0.0', '2.0.0'],
    );
  }));
test('import map e deno.json acrescentam bloqueio; formas desconhecidas reprovam', () =>
  setup(({ root, lock, pkg, put }) => {
    pkg('node_modules/dep', 'dep');
    put('supabase/functions/sample/index.ts', "import 'dep';");
    put('deno.json', { imports: { dep: 'npm:dep@9' } });
    assert.ok(collectEdgePackages(root, lock).some((p) => p.name === 'dep'));
    rmSync(resolve(root, 'deno.json'));
    put('supabase/config.toml', '[functions.sample]\nimport_map = "../edge-imports.json"');
    put('edge-imports.json', { imports: { dep: 'npm:dep@9' } });
    assert.ok(collectEdgePackages(root, lock).some((p) => p.name === 'dep'));
    rmSync(resolve(root, 'supabase/config.toml'));
    rmSync(resolve(root, 'edge-imports.json'));
    put('supabase/functions/deno.json', { imports: { dep: 'npm:dep@9' } });
    assert.ok(collectEdgePackages(root, lock).some((p) => p.name === 'dep'));
    rmSync(resolve(root, 'supabase/functions/deno.json'));
    put('supabase/functions/import_map.json', { scopes: { './': { dep: 'npm:dep@latest' } } });
    assert.ok(collectEdgePackages(root, lock).some((p) => p.name === 'dep'));
    for (const code of [
      'import(value)',
      "import 'jsr:@x/y'",
      "const alias = require; alias('npm:dep@1');",
      "import 'https://example.invalid/x.js'",
    ]) {
      put('supabase/functions/sample/index.ts', code);
      assert.throws(() => collectEdgePackages(root, lock), /calculável/);
    }
  }));
test('arquivo Edge de extensão desconhecida reprova', () =>
  setup(({ root, lock, put }) => {
    put('supabase/functions/_shared/hidden.vue', "import 'npm:expo@1';");
    put('supabase/functions/sample/index.ts', "import '../_shared/hidden.vue';");
    assert.throws(() => collectEdgePackages(root, lock), /Extensão Edge desconhecida/);
  }));

test('gerador embutido no HTML acrescenta pacote e HIGH bloqueante sem fonte no mapa', () =>
  setup(({ root, lock, pkg }) => {
    pkg('node_modules/renderer', 'renderer');
    const packages = [
      ...publishedPackages(root, lock, new Set([resolve(root, 'app/index.js')]), [
        'node_modules/renderer',
      ]).values(),
    ];
    assert.ok(packages.some((p) => p.name === 'renderer' && p.target === 'generator'));
    assert.match(
      evaluateAudit(
        high('renderer', 'node_modules/renderer'),
        [],
        undefined,
        { packages },
        lock,
      ).join(' '),
      /não autorizado/,
    );
  }));

test('fontes em chunk assíncrono também entram no conjunto', () =>
  setup(({ root, pkg, put, exportId, read }) => {
    pkg('node_modules/lazy', 'lazy');
    put('dist/chunks/lazy.js', 'globalThis.lazy=1;\n');
    put('dist/chunks/lazy.js.map', {
      version: 3,
      sources: ['/node_modules/lazy/index.js'],
      names: [],
      mappings: 'AAAA',
    });
    writeExportReceipt(root, exportId);
    assert.ok([...read().modules].some((p) => p.endsWith('node_modules/lazy/index.js')));
  }));

test('import relativo de código desconhecido ou fora da árvore Edge reprova', () =>
  setup(({ root, lock, put }) => {
    put('supabase/functions/_shared/hidden.txt', 'export default 1;');
    put('supabase/functions/sample/index.ts', "import '../_shared/hidden.txt';");
    assert.throws(() => collectEdgePackages(root, lock), /Extensão Edge desconhecida/);
    put('supabase/functions/sample/index.ts', "import '../../../app/index.js';");
    assert.throws(() => collectEdgePackages(root, lock), /relativo não calculável/);
  }));

test('teste não alcançado com HIGH e import dinâmico não literal apenas avisa', () =>
  setup(({ root, lock, pkg, put }) => {
    pkg('node_modules/dep', 'dep');
    put(
      'supabase/functions/sample/helper.test.ts',
      "import 'npm:dep@99'; import(value); import 'vitest';",
    );
    const edge = collectEdge(root, lock);
    assert.deepEqual(edge.entrypoints, ['supabase/functions/sample/index.ts']);
    assert.ok(edge.notReached.includes('supabase/functions/sample/helper.test.ts'));
    assert.equal(edge.packages.length, 0);
    const output = [];
    const result = evaluateAudit(
      high('dep', 'node_modules/dep'),
      [],
      undefined,
      { packages: edge.packages },
      lock,
      output,
    );
    assert.equal(result.length, 0);
    assert.equal(output.length, 1);
    assert.equal(output[0].blocking, false);
    assert.equal(output[0].published, false);
  }));
test('HIGH alcançado diretamente ou via _shared bloqueia', () =>
  setup(({ root, lock, pkg, put }) => {
    pkg('node_modules/dep', 'dep');
    for (const code of ["import 'npm:dep@99';", "export * from '../_shared/helper.ts';"]) {
      put('supabase/functions/_shared/helper.ts', "import('npm:dep@99');");
      put('supabase/functions/sample/index.ts', code);
      const edge = collectEdge(root, lock);
      assert.ok(edge.packages.some((p) => p.name === 'dep'));
      assert.match(
        evaluateAudit(
          high('dep', 'node_modules/dep'),
          [],
          undefined,
          { packages: edge.packages },
          lock,
        ).join(' '),
        /não autorizado/,
      );
    }
  }));
test('entrada importando teste ou spec reprova', () =>
  setup(({ root, lock, put }) => {
    for (const suffix of ['test', 'spec']) {
      put('supabase/functions/sample/helper.' + suffix + '.ts', 'export const value=1;');
      put('supabase/functions/sample/index.ts', "import './helper." + suffix + ".ts';");
      assert.throws(() => collectEdge(root, lock), /Código de teste alcançável/);
    }
  }));
test('import dinâmico não literal alcançado reprova', () =>
  setup(({ root, lock, put }) => {
    put('supabase/functions/sample/index.ts', 'import(value);');
    assert.throws(() => collectEdge(root, lock), /Import dinâmico não calculável/);
  }));
test('função nova sem index reprova', () =>
  setup(({ root, lock, put }) => {
    put('supabase/functions/new-function/helper.ts', 'export const value=1;');
    assert.throws(() => collectEdge(root, lock), /ponto de entrada/);
  }));
