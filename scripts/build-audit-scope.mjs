import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
  existsSync,
  lstatSync,
} from 'node:fs';
import { relative, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';
import { context, scopeFile } from './audit-scope.mjs';
import {
  publishedWebModules,
  installedPackage,
  codeExtension,
  crossCheckPackages,
} from './audit-module-graph.mjs';

export function collectEdge(root, lock) {
  const tree = resolve(root, 'supabase/functions');
  const configs = new Map();
  const configPath = resolve(root, 'supabase/config.toml');
  if (existsSync(configPath)) {
    let current = null;
    for (const line of readFileSync(configPath, 'utf8').split('\n')) {
      if (/^\s*\[/.test(line)) {
        const match = /^\s*\[functions\.([\w-]+)\]\s*(?:#.*)?$/.exec(line);
        if (/^\s*\[functions\./.test(line) && !match)
          throw new Error('Configuração de função não calculável.');
        current = match ? match[1] : null;
        if (current) {
          if (configs.has(current)) throw new Error('Função duplicada na configuração.');
          configs.set(current, {});
        }
        continue;
      }
      if (!current || /^\s*(?:#|$)/.test(line)) continue;
      const match =
        /^\s*(enabled|entrypoint|import_map|verify_jwt)\s*=\s*(true|false|"[^"\\]*"|'[^'\\]*')\s*(?:#.*)?$/.exec(
          line,
        );
      if (!match) throw new Error('Configuração de função não calculável.');
      const [, key, value] = match;
      if (Object.hasOwn(configs.get(current), key)) throw new Error('Chave de função duplicada.');
      configs.get(current)[key] =
        value === 'true' ? true : value === 'false' ? false : value.slice(1, -1);
    }
  }
  const names = new Set(configs.keys());
  for (const entry of readdirSync(tree, { withFileTypes: true })) {
    if (entry.isDirectory() && !/^[_.]/.test(entry.name)) names.add(entry.name);
  }
  const entrypoints = [];
  for (const name of [...names].sort()) {
    const config = configs.get(name) ?? {};
    if (config.enabled === false) continue;
    if (config.enabled !== undefined && config.enabled !== true)
      throw new Error('Estado de função inválido.');
    const directory = resolve(tree, name);
    let path;
    if (config.entrypoint) path = resolve(root, 'supabase', config.entrypoint);
    else {
      if (!existsSync(directory)) throw new Error('Função sem ponto de entrada identificável.');
      const indexes = readdirSync(directory).filter(
        (file) => /^index\./.test(file) && codeExtension.test(file),
      );
      if (indexes.length !== 1) throw new Error('Função sem ponto de entrada identificável.');
      path = resolve(directory, indexes[0]);
    }
    if (!path.startsWith(tree + '/') || !existsSync(path) || !codeExtension.test(path))
      throw new Error('Função sem ponto de entrada identificável.');
    entrypoints.push({ name, path, config });
  }
  if (!entrypoints.length) throw new Error('Nenhuma função publicada identificável.');
  const packages = new Map();
  const visited = new Set();
  const entries = Object.entries(lock.packages)
    .filter(([path]) => path.includes('node_modules/'))
    .map(([path, entry]) => ({
      path,
      entry,
      name: entry.name ?? path.split('node_modules/').at(-1),
    }));
  function edgePackage(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const matches = entries.filter(
      ({ path, name: packageName }) =>
        packageName === name || path.endsWith('node_modules/' + name),
    );
    if (!matches.length) throw new Error(`Dependência Edge desconhecida: ${name}`);
    for (const { path, entry } of matches) {
      const installed = JSON.parse(readFileSync(resolve(root, path, 'package.json')));
      if (!installed.name || installed.version !== entry.version)
        throw new Error('Instalação Edge diverge do lock.');
      packages.set(path, {
        name: installed.name,
        version: installed.version,
        path,
        target: 'edge',
      });
      for (const dependency of Object.keys({
        ...entry.dependencies,
        ...entry.optionalDependencies,
        ...entry.peerDependencies,
      }))
        edgePackage(dependency);
    }
  }

  const inventory = [];
  function inventoryFiles(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) inventoryFiles(path);
      else inventory.push(path);
    }
  }
  inventoryFiles(tree);
  const reached = new Set();
  const traversed = new Set();
  const mapCache = new Map();
  function loadMap(path) {
    if (!path.startsWith(root + '/')) throw new Error('Import map fora do repositório.');
    if (!mapCache.has(path)) {
      const map = JSON.parse(readFileSync(path, 'utf8'));
      if (!map || typeof map !== 'object' || Array.isArray(map) || map.importMap)
        throw new Error('Import map não calculável.');
      for (const entries of [map.imports ?? {}, ...Object.values(map.scopes ?? {})]) {
        if (!entries || typeof entries !== 'object' || Array.isArray(entries))
          throw new Error('Import map inválido.');
      }
      mapCache.set(path, { path, map });
    }
    return mapCache.get(path);
  }
  function mapsFor(entrypoint) {
    const maps = [];
    for (const directory of [root, resolve(root, 'supabase'), tree, dirname(entrypoint.path)]) {
      for (const file of ['deno.json', 'deno.jsonc', 'import_map.json', 'import-map.json']) {
        const path = resolve(directory, file);
        if (existsSync(path)) maps.push(loadMap(path));
      }
    }
    if (entrypoint.config.import_map)
      maps.push(loadMap(resolve(root, 'supabase', entrypoint.config.import_map)));
    return maps;
  }
  function mapped(value, importer, maps) {
    for (const { path, map } of [...maps].reverse()) {
      const scopes = Object.entries(map.scopes ?? {})
        .filter(([scope]) => importer.startsWith(resolve(dirname(path), scope) + '/'))
        .sort((a, b) => b[0].length - a[0].length);
      for (const bindings of [...scopes.map(([, bindings]) => bindings), map.imports ?? {}]) {
        const key = Object.keys(bindings)
          .filter((key) => key === value || (key.endsWith('/') && value.startsWith(key)))
          .sort((a, b) => b.length - a.length)[0];
        if (key) {
          const target = bindings[key];
          if (typeof target !== 'string') throw new Error('Import map não calculável.');
          return { value: target + (key.endsWith('/') ? value.slice(key.length) : ''), base: path };
        }
      }
    }
    return { value, base: importer };
  }
  function importSpecifier(raw, importer, maps) {
    const { value, base } = mapped(raw, importer, maps);
    if (typeof value !== 'string' || !value) throw new Error('Import não literal.');
    if (value.startsWith('.')) {
      const target = resolve(dirname(base), value);
      if (!target.startsWith(tree + '/')) throw new Error('Import relativo não calculável.');
      visit(target, maps);
      return;
    }
    if (value.startsWith('node:')) {
      if (value === 'node:module') throw new Error('Loader Node não calculável.');
      return;
    }
    const match = /^npm:((?:@[^/@\s]+\/)?[^/@\s]+)(?:@[^/\s]+)?(?:\/[^\s]*)?$/.exec(value);
    if (!match) throw new Error('Import externo não calculável.');
    edgePackage(match[1]);
  }
  function visit(path, maps) {
    if (/\.(?:test|spec)\./.test(path)) throw new Error('Código de teste alcançável em produção.');
    if (!codeExtension.test(path))
      throw new Error('Extensão Edge desconhecida em arquivo alcançável.');
    if (
      !existsSync(path) ||
      lstatSync(path).isSymbolicLink() ||
      !lstatSync(path).isFile() ||
      !realpathSync(path).startsWith(realpathSync(tree) + '/')
    )
      throw new Error('Fonte Edge não calculável.');
    const key = JSON.stringify([path, maps.map((map) => map.path)]);
    if (traversed.has(key)) return;
    traversed.add(key);
    reached.add(path);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    if (source.parseDiagnostics.length) throw new Error('Fonte Edge inválida.');
    function inspect(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) {
          if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error('Import não literal.');
          importSpecifier(node.moduleSpecifier.text, path, maps);
        }
      }
      if (ts.isImportEqualsDeclaration(node)) {
        if (
          !ts.isExternalModuleReference(node.moduleReference) ||
          !ts.isStringLiteral(node.moduleReference.expression)
        )
          throw new Error('Import equals não calculável.');
        importSpecifier(node.moduleReference.expression.text, path, maps);
      }
      if (ts.isImportTypeNode(node)) {
        if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal))
          throw new Error('Import type não calculável.');
        importSpecifier(node.argument.literal.text, path, maps);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(source) === 'require')
      ) {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
          throw new Error('Import dinâmico não calculável.');
        importSpecifier(node.arguments[0].text, path, maps);
      }
      // Do not let aliasing require or unsupported loader forms hide imports.
      if (
        ts.isIdentifier(node) &&
        node.text === 'require' &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      )
        throw new Error('Require não calculável.');
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
  for (const entrypoint of entrypoints) visit(entrypoint.path, mapsFor(entrypoint));
  return {
    packages: [...packages.values()],
    entrypoints: entrypoints.map(({ path }) => relative(root, path)),
    reached: [...reached].map((path) => relative(root, path)).sort(),
    notReached: inventory
      .filter((path) => !reached.has(path))
      .map((path) => relative(root, path))
      .sort(),
  };
}
export function collectEdgePackages(root, lock) {
  return collectEdge(root, lock).packages;
}
export function publishedPackages(root, lock, modules, generators) {
  const packages = new Map();
  for (const modulePath of modules) {
    if (!modulePath.includes('/node_modules/')) continue;
    const pkg = installedPackage(root, lock, modulePath);
    packages.set(pkg.path, pkg);
  }
  for (const path of generators) {
    const pkg = installedPackage(root, lock, resolve(root, path, 'generated.js'));
    packages.set(pkg.path, { ...pkg, target: 'generator' });
  }
  return packages;
}
export function collectScope(root, exportId) {
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json')));
  const signatures = JSON.parse(
    readFileSync(new URL('./fixtures/audit-generated-code.json', import.meta.url)),
  );
  const { modules, generated } = publishedWebModules(root, signatures, exportId);
  const graphs = readdirSync(resolve(root, '.expo/audit-graphs')).map((file) =>
    JSON.parse(readFileSync(resolve(root, '.expo/audit-graphs', file))),
  );
  crossCheckPackages(root, lock, modules, generated, graphs, exportId);
  const packages = publishedPackages(root, lock, modules, signatures.generators);
  const edge = collectEdge(root, lock);
  for (const pkg of edge.packages) packages.set('edge:' + pkg.path, pkg);
  if (!packages.size) throw new Error('Conjunto publicado vazio.');
  return {
    schema: 1,
    ...context(root),
    generatedAt: Date.now(),
    modules: [...modules]
      .map((path) => (path.startsWith(root + '/') ? relative(root, path) : path))
      .sort(),
    edge,
    packages: [...packages.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}
export function buildScope(root) {
  const started = performance.now();
  const exportId = randomUUID();
  rmSync(resolve(root, scopeFile), { force: true });
  rmSync(resolve(root, '.expo/audit-graphs'), { recursive: true, force: true });
  rmSync(resolve(root, 'dist'), { recursive: true, force: true });
  const build = spawnSync('npm', ['run', 'build:web'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      COLETE_AUDIT_EXPORT_ID: exportId,
      NODE_ENV: 'production',
      EXPO_PUBLIC_SMOKE_MODE: 'false',
    },
  });
  mkdirSync(resolve(root, '.expo'), { recursive: true });
  writeFileSync(
    resolve(root, '.expo/audit-build.log'),
    (build.stdout ?? '') + (build.stderr ?? ''),
  );
  try {
    if (build.status !== 0)
      throw new Error('Export de produção falhou; conjunto publicado ausente.');
    const scope = collectScope(root, exportId);
    writeFileSync(resolve(root, scopeFile), JSON.stringify(scope, null, 2) + '\n');
    console.log('Pontos de entrada Edge:\n' + scope.edge.entrypoints.join('\n'));
    console.log('Não alcançados Edge:\n' + (scope.edge.notReached.join('\n') || '(nenhum)'));
    console.log(
      `Conjunto publicado: ${scope.modules.length} fontes, ${scope.packages.length} pacotes; ${(performance.now() - started).toFixed(0)} ms.`,
    );
    return scope;
  } finally {
    rmSync(resolve(root, '.expo/audit-graphs'), { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    buildScope(resolve(new URL('..', import.meta.url).pathname));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
