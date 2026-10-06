import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { createRequire } from 'node:module';
const semver = createRequire(import.meta.url)('semver');
import { context, scopeFile } from './audit-scope.mjs';
import { publishedWebModules } from './audit-module-graph.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const graphDirectory = resolve(root, '.expo/audit-graphs');
rmSync(resolve(root, scopeFile), { force: true });
rmSync(graphDirectory, { recursive: true, force: true });
const started = performance.now();
const build = spawnSync('npm', ['run', 'build:web'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, NODE_ENV: 'production', EXPO_PUBLIC_SMOKE_MODE: 'false' },
});
mkdirSync(resolve(root, '.expo'), { recursive: true });
writeFileSync(resolve(root, '.expo/audit-build.log'), (build.stdout ?? '') + (build.stderr ?? ''));
if (build.status !== 0) throw new Error('Export de produção falhou; conjunto publicado ausente.');
const packages = new Map();
process.env.NODE_ENV = 'production';
process.env.EXPO_PUBLIC_SMOKE_MODE = 'false';
const { getConfig } = createRequire(import.meta.url)('expo/config');
const modules = publishedWebModules(
  readdirSync(graphDirectory).map((file) =>
    JSON.parse(readFileSync(resolve(graphDirectory, file))),
  ),
  getConfig(root).exp.web?.output,
);
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json')));
for (const modulePath of modules) {
  if (!modulePath.includes('/node_modules/')) continue;
  let directory = dirname(modulePath);
  for (;;) {
    const location = relative(root, directory);
    const entry = lock.packages[location];
    if (entry) {
      const installed = JSON.parse(readFileSync(resolve(directory, 'package.json')));
      if (!installed.name || installed.version !== entry.version)
        throw new Error(`Módulo não corresponde ao lock: ${location}`);
      packages.set(location, {
        name: installed.name,
        version: entry.version,
        path: location,
        target: 'metro',
      });
      break;
    }
    if (directory === root || directory === dirname(directory))
      throw new Error(`Módulo sem pacote identificável: ${modulePath}`);
    directory = dirname(directory);
  }
}
// Parse syntax rather than strings/comments. Traverse every deployed TS source,
// including shared modules. Unknown external or computed imports fail closed.
function edgeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? edgeFiles(path)
      : /\.(ts|js)$/.test(entry.name) && !/\.test\./.test(entry.name)
        ? [path]
        : [];
  });
}
function edgePackage(name, range, importer = '') {
  // Resolve against the actual locked installation, with Node's ancestor
  // lookup order. If the Edge version/graph is not installed, fail closed.
  let directory = importer;
  let location;
  for (;;) {
    const candidate = `${directory ? directory + '/' : ''}node_modules/${name}`;
    if (lock.packages[candidate]) {
      location = candidate;
      break;
    }
    if (!directory) throw new Error(`Pacote Edge não resolvido no lock: ${name}@${range}`);
    directory = dirname(directory);
    if (directory === '.') directory = '';
  }
  const entry = lock.packages[location];
  if (!semver.validRange(range) || !semver.satisfies(entry.version, range))
    throw new Error(`Versão Edge não corresponde ao lock: ${name}@${range}`);
  const installed = JSON.parse(readFileSync(resolve(root, location, 'package.json')));
  if (installed.name !== name || installed.version !== entry.version)
    throw new Error(`Pacote Edge não corresponde à instalação: ${location}`);
  const key = `edge:${location}`;
  if (packages.has(key)) return;
  packages.set(key, { name, version: entry.version, path: location, target: 'edge' });
  for (const [dependency, version] of Object.entries({
    ...entry.dependencies,
    ...entry.optionalDependencies,
  }))
    edgePackage(dependency, version, location);
}
for (const path of edgeFiles(resolve(root, 'supabase/functions'))) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  if (source.parseDiagnostics.length)
    throw new Error(`Fonte Edge inválida: ${relative(root, path)}`);
  function inspect(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier;
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(source) === 'require')
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
        throw new Error(`Import dinâmico não calculável: ${relative(root, path)}`);
      specifier = node.arguments[0];
    }
    if (specifier) {
      const value = specifier.text;
      if (!value) throw new Error('Import não literal.');
      if (!value.startsWith('.') && !value.startsWith('node:')) {
        const match = /^npm:((?:@[^/]+\/)?[^@/]+)@(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\/.*)?$/.exec(
          value,
        );
        if (!match) throw new Error(`Import externo sem versão exata calculável: ${value}`);
        const [, name, version] = match;
        edgePackage(name, version);
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
}
if (!modules.size || !packages.size) throw new Error('Conjunto publicado vazio.');
mkdirSync(resolve(root, '.expo'), { recursive: true });
const scope = {
  schema: 1,
  ...context(root),
  generatedAt: Date.now(),
  modules: [...modules].map((path) => relative(root, path)).sort(),
  packages: [...packages.values()].sort((a, b) => a.path.localeCompare(b.path)),
};
writeFileSync(resolve(root, scopeFile), `${JSON.stringify(scope, null, 2)}\n`);
console.log(
  `Conjunto publicado: ${modules.size} módulos, ${packages.size} pacotes; ${(performance.now() - started).toFixed(0)} ms.`,
);
