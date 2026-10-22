import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// rev86 (Integração da prova): a spec that no required command runs proves
// nothing for the next change. Every e2e spec has to be reached by a
// `test:*:web` command that the validation workflow runs, either by its file
// name in the command or through the playwright config the command uses.
const root = path.resolve(__dirname, '..', '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
const workflow = read('.github/workflows/validation.yml');

function specsReachedBy(command: string): string[] {
  const named = command.match(/e2e\/[\w.-]+\.spec\.ts/gu) ?? [];
  const config = /--config\s+(\S+)/u.exec(command)?.[1];
  const matched = config ? [...read(config).matchAll(/testMatch:\s*'([^']+)'/gu)] : [];
  return [...named.map((file) => path.basename(file)), ...matched.map((match) => match[1]!)];
}

describe('e2e coverage', () => {
  it('runs every e2e spec through a test:*:web command of the validation workflow', () => {
    const required = Object.keys(scripts).filter(
      (name) => /^test:[\w-]+:web$/u.test(name) && workflow.includes(`npm run ${name}\n`),
    );
    const reached = new Set(required.flatMap((name) => specsReachedBy(scripts[name]!)));
    const specs = readdirSync(path.join(root, 'e2e')).filter((file) => file.endsWith('.spec.ts'));
    expect(specs.filter((spec) => !reached.has(spec))).toEqual([]);
  });
});
