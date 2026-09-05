import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from './error-codes';

describe('stable error catalogue', () => {
  it('matches docs/13 section 8 exactly', () => {
    const contract = fs.readFileSync(path.resolve('docs/13-contratos-funcoes.md'), 'utf8');
    const catalogue = contract.match(/## 8\. Catálogo de erros estáveis[\s\S]*?`([^`]+)`/u)?.[1];
    expect(catalogue).toBeDefined();
    const documented = catalogue
      ?.replaceAll('\n', ' ')
      .split('·')
      .map((code) => code.trim())
      .filter(Boolean);
    expect(ERROR_CODES).toEqual(documented);
  });
});
