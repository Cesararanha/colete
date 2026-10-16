import { describe, expect, it } from 'vitest';

import {
  DESCRIPTION_MAX,
  descriptionLength,
  normaliseDescription,
} from '../../../src/features/matches/match-description.ts';
import { normaliseMatchDescription } from './match-config.ts';

// Same cases for the form and the Edge copy: equal results, equal refusals.
const CASES: [string, string | null | 'refused'][] = [
  ['', null],
  ['Traga colete', 'Traga colete'],
  ['  Traga   colete  ', 'Traga colete'],
  ['Linha 1 \r\n  Linha 2', 'Linha 1\nLinha 2'],
  ['Um\n\n\n\nDois', 'Um\n\nDois'],
  ['Um\u2028Dois', 'Um\nDois'],
  ['Cafe\u0301\u3000bar', 'Café bar'],
  ['   ', 'refused'],
  ['\n \n', 'refused'],
  ['Tab\taqui', 'refused'],
  ['Zero\u200bwidth', 'refused'],
  ['Bidi\u202eoverride', 'refused'],
  ['x'.repeat(DESCRIPTION_MAX), 'x'.repeat(DESCRIPTION_MAX)],
  ['x'.repeat(DESCRIPTION_MAX + 1), 'refused'],
  [`  ${'é'.repeat(DESCRIPTION_MAX)}  `, 'é'.repeat(DESCRIPTION_MAX)],
  ['<b>sem HTML</b> https://exemplo.test', '<b>sem HTML</b> https://exemplo.test'],
];

function edge(value: string): string | null | 'refused' {
  try {
    return normaliseMatchDescription(value, 'config.description');
  } catch {
    return 'refused';
  }
}
function form(value: string): string | null | 'refused' {
  const result = normaliseDescription(value);
  return result.ok ? result.value : 'refused';
}

describe('the match description rule (human decision of 16/10/2026)', () => {
  it.each(CASES)('form and Edge agree on %j', (input, expected) => {
    expect(form(input)).toEqual(expected);
    expect(edge(input)).toEqual(expected);
  });

  it('counts the normalised code points, so the counter matches the limit', () => {
    expect(descriptionLength('  Traga   colete ')).toBe(12);
    expect(descriptionLength('')).toBe(0);
    expect(descriptionLength('x'.repeat(DESCRIPTION_MAX + 3))).toBe(DESCRIPTION_MAX + 3);
  });

  it('keeps null as the only spelling of no description at the Edge', () => {
    expect(normaliseMatchDescription(null, 'config.description')).toBeNull();
    expect(edge('')).toBeNull();
    expect(() => normaliseMatchDescription(12, 'config.description')).toThrow();
  });
});
