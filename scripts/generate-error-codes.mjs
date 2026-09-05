import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const contractPath = path.join(repositoryRoot, 'docs', '13-contratos-funcoes.md');
const outputPath = path.join(repositoryRoot, 'src', 'lib', 'error-codes.ts');
const prettierBinary = path.join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prettier.cmd' : 'prettier',
);
const contract = fs.readFileSync(contractPath, 'utf8');
const section = contract.match(/## 8\. Catálogo de erros estáveis[\s\S]*?`([^`]+)`/u)?.[1];

if (section === undefined) {
  throw new Error('Could not find the stable error catalogue in docs/13-contratos-funcoes.md');
}

const codes = section
  .replaceAll('\n', ' ')
  .split('·')
  .map((code) => code.trim())
  .filter(Boolean);

if (codes.length === 0 || codes.some((code) => !/^[A-Z][A-Z0-9_]+$/u.test(code))) {
  throw new Error('The stable error catalogue has an unexpected shape');
}

const generated =
  `// Generated from docs/13-contratos-funcoes.md section 8. Do not edit by hand.\n` +
  `export const ERROR_CODES = ${JSON.stringify(codes, null, 2)} as const;\n\n` +
  `export type ErrorCode = (typeof ERROR_CODES)[number];\n\n` +
  `const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);\n\n` +
  `export function isErrorCode(value: unknown): value is ErrorCode {\n` +
  `  return typeof value === 'string' && ERROR_CODE_SET.has(value);\n` +
  `}\n`;

fs.writeFileSync(outputPath, generated);
const formatted = spawnSync(prettierBinary, ['--write', outputPath], {
  cwd: repositoryRoot,
  encoding: 'utf8',
});
if (formatted.error !== undefined) throw formatted.error;
if (formatted.status !== 0) {
  process.stderr.write(formatted.stderr);
  process.exit(formatted.status ?? 1);
}
process.stdout.write(
  `Generated and formatted ${path.relative(repositoryRoot, outputPath)} with ${codes.length} codes.\n`,
);
