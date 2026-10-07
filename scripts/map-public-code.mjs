import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { filesUnder, codeExtension, writeExportReceipt } from './audit-module-graph.mjs';
import { digest } from './audit-scope.mjs';
// Identity maps for first-party files copied verbatim by Expo, in the same build.
const root = resolve(new URL('..', import.meta.url).pathname);
for (const source of filesUnder(resolve(root, 'public')).filter((path) =>
  codeExtension.test(path),
)) {
  const output = resolve(root, 'dist', relative(resolve(root, 'public'), source));
  const content = readFileSync(source, 'utf8');
  if (!existsSync(output) || readFileSync(output, 'utf8') !== content)
    throw new Error('Código público não corresponde ao export.');
  const debugId = digest(content);
  const url = '/' + relative(resolve(root, 'dist'), output) + '.map';
  const map = {
    version: 3,
    sources: [relative(root, source)],
    sourcesContent: [content],
    names: [],
    mappings: content
      .split('\n')
      .map((_, index) => (index ? 'AACA' : 'AAAA'))
      .join(';'),
    debugId,
  };
  writeFileSync(output + '.map', JSON.stringify(map));
  writeFileSync(output, content + `\n//# sourceMappingURL=${url}\n//# debugId=${debugId}\n`);
}

if (process.env.COLETE_AUDIT_EXPORT_ID)
  writeExportReceipt(root, process.env.COLETE_AUDIT_EXPORT_ID);
