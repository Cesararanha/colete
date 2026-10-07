import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { digest } from './audit-scope.mjs';
const { decode } = createRequire(import.meta.url)('@jridgewell/sourcemap-codec');
export const codeExtension = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
export function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlink não calculável.');
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}
const inside = (root, path) =>
  !relative(root, path).startsWith('..') && !isAbsolute(relative(root, path));
// Receipt made at the end of the SAME clean export. Its nonce is owned by the
// collector process; an existing receipt cannot be used in another invocation.
export function writeExportReceipt(root, exportId) {
  const dist = resolve(root, 'dist');
  const files = Object.fromEntries(
    filesUnder(dist).map((path) => [relative(dist, path), digest(readFileSync(path))]),
  );
  mkdirSync(resolve(root, '.expo'), { recursive: true });
  writeFileSync(resolve(root, '.expo/audit-export.json'), JSON.stringify({ exportId, files }));
}
export function publishedWebModules(root, signatures, exportId) {
  const dist = resolve(root, 'dist');
  const receipt = JSON.parse(readFileSync(resolve(root, '.expo/audit-export.json')));
  if (!exportId || receipt.exportId !== exportId) throw new Error('Mapa de outro export.');
  const files = filesUnder(dist);
  if (
    files.length !== Object.keys(receipt.files).length ||
    files.some((path) => receipt.files[relative(dist, path)] !== digest(readFileSync(path)))
  )
    throw new Error('Artefato de outro export ou alterado.');
  const modules = new Set();
  const generated = new Set();
  const inlineSeen = new Set();
  const mapsSeen = new Set();
  for (const path of files) {
    if (!path.endsWith('.html') && !codeExtension.test(path)) continue;
    const code = readFileSync(path, 'utf8');
    if (path.endsWith('.html')) {
      for (const match of code.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        if (/\bsrc\s*=/i.test(match[1])) {
          const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
          const target = src?.startsWith('/') ? resolve(dist, '.' + src) : null;
          if (
            !target ||
            !inside(dist, target) ||
            !existsSync(target) ||
            !codeExtension.test(target)
          )
            throw new Error('Script externo ou não calculável.');
          if (match[2].trim()) throw new Error('Script externo com corpo inline.');
        } else {
          const hash = digest(match[0]);
          if (!signatures.inline.includes(hash))
            throw new Error('Script inline novo ou diferente.');
          inlineSeen.add(hash);
        }
      }
      if (
        (code.match(/<script\b/gi) ?? []).length !==
        [...code.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)].length
      )
        throw new Error('Script HTML não calculável.');
      continue;
    }
    const annotation = /\/\/# sourceMappingURL=([^\s]+)/.exec(code)?.[1];
    const mapPath = annotation
      ? annotation.startsWith('/')
        ? resolve(dist, '.' + annotation)
        : resolve(dirname(path), annotation)
      : path + '.map';
    if (!inside(dist, mapPath)) throw new Error('Mapa fora do export.');
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    mapsSeen.add(mapPath);
    const debugId = /\/\/# debugId=([^\s]+)/.exec(code)?.[1];
    if ((debugId || map.debugId) && debugId !== map.debugId)
      throw new Error('Mapa de outro build.');
    if (
      map.version !== 3 ||
      !Array.isArray(map.sources) ||
      !map.sources.length ||
      typeof map.mappings !== 'string'
    )
      throw new Error('Source map inválido.');
    // Only generated line bounds matter for scope. Original positions/content
    // are deliberately not checked (planner, 07/10/2026, expo/virtual/rsc.js).
    const mappings = decode(map.mappings);
    if (mappings.length > code.split('\n').length)
      throw new Error('Mapping ultrapassa linhas do JS gerado.');
    for (const segments of mappings)
      for (const segment of segments) {
        if (
          ![1, 4, 5].includes(segment.length) ||
          (segment.length > 1 && (segment[1] < 0 || segment[1] >= map.sources.length))
        )
          throw new Error('Mapping inválido.');
      }
    for (const source of map.sources) {
      if (typeof source !== 'string' || !source) throw new Error('Fonte inválida.');
      if (Object.hasOwn(signatures.virtualOwners, source)) {
        modules.add(resolve(root, signatures.virtualOwners[source], '__generated__.js'));
        generated.add(resolve(root, signatures.virtualOwners[source]));
        continue;
      }
      const contextual = /^\/(.+)\?ctx=[a-f0-9]{40}$/.exec(source);
      if (contextual) {
        const directory = resolve(root, contextual[1]);
        if (
          !inside(root, directory) ||
          !existsSync(directory) ||
          !signatures.generators.includes('node_modules/metro')
        )
          throw new Error('Contexto virtual sem dono.');
        modules.add(resolve(root, 'node_modules/metro/__generated__.js'));
        generated.add(resolve(root, 'node_modules/metro'));
        continue;
      }
      if (source.includes('\0') || /^[a-z]+:/i.test(source))
        throw new Error('Fonte sem classe atribuível.');
      const sourcePath = resolve(root, (map.sourceRoot ?? '') + source.replace(/^\//, ''));
      if (!inside(root, sourcePath)) throw new Error('Fonte fora das três classes.');
      if (sourcePath.includes('/node_modules/')) {
        // Virtual sources such as expo/virtual/rsc.js have a package owner,
        // even when their original content is a stub or the file is synthetic.
        modules.add(sourcePath);
        if (
          sourcePath.includes('/virtual/') ||
          /\/node_modules\/@react-native\/js-polyfills\//.test(sourcePath) ||
          /\/@expo\/cli\/build\/metro-require\//.test(sourcePath)
        )
          generated.add(sourcePath);
      } else {
        if (!existsSync(sourcePath) || !statSync(sourcePath).isFile())
          throw new Error('Fonte do app inexistente ou não é arquivo.');
        modules.add(sourcePath);
      }
    }
  }
  if (files.some((path) => path.endsWith('.map') && !mapsSeen.has(path)))
    throw new Error('Source map sem código correspondente.');
  if (!modules.size || inlineSeen.size !== signatures.inline.length)
    throw new Error('Export vazio ou assinaturas inline divergentes.');
  return { modules, generated };
}
export function installedPackage(root, lock, modulePath) {
  let directory = dirname(modulePath);
  for (;;) {
    const location = relative(root, directory);
    // Identity always comes from the nearest package.json, never path spelling.
    if (existsSync(resolve(directory, 'package.json'))) {
      const installed = JSON.parse(readFileSync(resolve(directory, 'package.json')));
      // Internal package.json files describe subpath exports (zod, resolvers),
      // not separately installed npm packages. Read the nearest installed root.
      if (lock.packages[location] || /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/.test(location)) {
        const entry = lock.packages[location];
        if (!entry || !installed.name || installed.version !== entry.version)
          throw new Error(`Módulo não corresponde ao lock: ${location}`);
        return {
          name: installed.name,
          version: installed.version,
          path: location,
          target: 'metro',
        };
      }
    }
    if (directory === root || directory === dirname(directory))
      throw new Error('Módulo sem pacote identificável.');
    directory = dirname(directory);
  }
}
export function crossCheckPackages(root, lock, modules, generated, graphs, exportId) {
  const identity = (pkg) => JSON.stringify([pkg.name, pkg.version]);
  const mapped = new Set(
    [...modules]
      .filter((p) => p.includes('/node_modules/'))
      .map((p) => identity(installedPackage(root, lock, p))),
  );
  const virtual = new Set(
    [...generated].map((p) =>
      identity(
        installedPackage(root, lock, p.endsWith('.js') ? p : resolve(p, '__generated__.js')),
      ),
    ),
  );
  const graphed = new Set();
  let clients = 0;
  for (const graph of graphs) {
    if (
      graph.exportId !== exportId ||
      graph.platform !== 'web' ||
      !['client', 'node'].includes(graph.environment) ||
      !Array.isArray(graph.modules) ||
      !graph.modules.length
    )
      throw new Error('Grafo Metro inválido ou de outro export.');
    if (graph.environment !== 'client') continue;
    clients++;
    for (const p of graph.modules) {
      if (typeof p !== 'string' || !p) throw new Error('Módulo Metro inválido.');
      if (p.includes('/node_modules/')) graphed.add(identity(installedPackage(root, lock, p)));
    }
  }
  if (
    !clients ||
    [...graphed].some((p) => !mapped.has(p)) ||
    [...mapped].some((p) => !graphed.has(p) && !virtual.has(p))
  )
    throw new Error('Pacotes Metro e source maps divergentes.');
}
