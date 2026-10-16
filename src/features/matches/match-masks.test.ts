import { describe, expect, it } from 'vitest';

import { maskDate, maskMoney, maskTime } from './match-masks';

describe('masks while typing (human decision of 17/10/2026)', () => {
  it.each([
    ['', ''],
    ['1', '1'],
    ['18', '18'],
    ['181', '18/1'],
    ['1810', '18/10'],
    ['18102', '18/10/2'],
    ['18102026', '18/10/2026'],
    ['181020269', '18/10/2026'],
    ['18/10/2026', '18/10/2026'],
    ['18/', '18'],
    ['ab18-10x2026', '18/10/2026'],
  ])('date %j → %j', (typed, shown) => {
    expect(maskDate(typed)).toBe(shown);
  });

  it.each([
    ['', ''],
    ['1', '1'],
    ['19', '19'],
    ['193', '19:3'],
    ['1930', '19:30'],
    ['19305', '19:30'],
    ['19:30', '19:30'],
    ['19:', '19'],
  ])('time %j → %j', (typed, shown) => {
    expect(maskTime(typed)).toBe(shown);
  });

  it.each([
    ['', ''],
    ['0', ''],
    ['5', 'R$ 0,05'],
    ['25', 'R$ 0,25'],
    ['2500', 'R$ 25,00'],
    ['2550', 'R$ 25,50'],
    ['00250', 'R$ 2,50'],
    ['123456', 'R$ 1.234,56'],
    ['999999', 'R$ 9.999,99'],
    ['9999999', 'R$ 9.999,99'],
    ['R$ 25,00', 'R$ 25,00'],
    // Backspace over the formatted text drops the last digit.
    ['R$ 25,0', 'R$ 2,50'],
  ])('money %j → %j', (typed, shown) => {
    expect(maskMoney(typed)).toBe(shown);
  });

  it('keeps a plain space after R$', () => {
    expect(maskMoney('2500')).not.toContain('\u00a0');
  });
});
