import { describe, expect, it } from 'vitest';

import { CanonicalisationError, canonicalise } from './jcs.ts';

describe('RFC 8785 canonicalisation', () => {
  it('orders object members by UTF-16 code units, not by insertion', () => {
    expect(canonicalise({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalise({ z: 1, A: 2, a: 3 })).toBe('{"A":2,"a":3,"z":1}');
    expect(canonicalise({ match_id: 'x', list_kind: 'y' })).toBe(
      canonicalise({ list_kind: 'y', match_id: 'x' }),
    );
  });

  it('orders nested members too', () => {
    expect(canonicalise({ outer: { b: 1, a: 2 } })).toBe('{"outer":{"a":2,"b":1}}');
  });

  it('keeps array order, because arrays are not sets here', () => {
    expect(canonicalise([3, 1, 2])).toBe('[3,1,2]');
  });

  it('escapes exactly what RFC 8785 escapes and leaves the rest literal', () => {
    expect(canonicalise('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(canonicalise('\n\t\r\b\f')).toBe('"\\n\\t\\r\\b\\f"');
    expect(canonicalise('\u0001')).toBe('"\\u0001"');
    expect(canonicalise('Jos\u00e9 \u26bd')).toBe('"Jos\u00e9 \u26bd"');
  });

  it('distinguishes an absent member from an explicit null', () => {
    expect(canonicalise({ patch: {} })).toBe('{"patch":{}}');
    expect(canonicalise({ patch: { nickname: null } })).toBe('{"patch":{"nickname":null}}');
    expect(canonicalise({ patch: {} })).not.toBe(canonicalise({ patch: { nickname: null } }));
  });

  it('refuses floats, NaN and Infinity rather than serialising them', () => {
    expect(() => canonicalise(1.5)).toThrow(CanonicalisationError);
    expect(() => canonicalise(Number.NaN)).toThrow(CanonicalisationError);
    expect(() => canonicalise(Number.POSITIVE_INFINITY)).toThrow(CanonicalisationError);
    expect(() => canonicalise(Number.MAX_SAFE_INTEGER + 2)).toThrow(CanonicalisationError);
  });

  it('serialises the remaining primitives', () => {
    expect(canonicalise(null)).toBe('null');
    expect(canonicalise(true)).toBe('true');
    expect(canonicalise(0)).toBe('0');
    expect(canonicalise(-7)).toBe('-7');
  });
});
