import { describe, expect, it } from 'vitest';

import {
  endRule,
  matchConfigFromForm,
  nextDayNotice,
  priceFromField,
  spanMinutes,
  type MatchFormValues,
} from './match-form';

// Human decision of 17/10/2026: field-by-field time rules, on the match's
// clock (HX-005). The match is in São Paulo (UTC-3), where NOW is 14/10/2030
// 12:00, whatever zone the suite runs in.
const NOW = new Date('2030-10-14T15:00:00.000Z');
const ZONE = 'America/Sao_Paulo';
const base: MatchFormValues = {
  date: '15/10/2030',
  startTime: '19:30',
  endTime: '21:00',
  locationName: 'Arena',
  locationAddress: '',
  description: '',
  slots: '14',
  price: 'R$ 25,00',
};
const errorsOf = (changes: Partial<MatchFormValues>) => {
  const result = matchConfigFromForm({ ...base, ...changes }, null, NOW, ZONE);
  return 'errors' in result ? result.errors : {};
};
const configOf = (changes: Partial<MatchFormValues>) => {
  const result = matchConfigFromForm({ ...base, ...changes }, null, NOW, ZONE);
  if (!('config' in result)) throw new Error(JSON.stringify(result.errors));
  return result.config;
};

describe('the time rule of the form', () => {
  it('puts a date before today on the date', () => {
    expect(errorsOf({ date: '13/10/2030' })).toEqual({
      date: 'A data não pode ser anterior a hoje',
    });
  });

  it('puts a start already gone today on the start, not on the date', () => {
    expect(errorsOf({ date: '14/10/2030', startTime: '11:59', endTime: '13:00' })).toEqual({
      startTime: 'O horário de início já passou',
    });
    expect(configOf({ date: '14/10/2030', startTime: '12:01', endTime: '13:00' }).starts_at).toBe(
      '2030-10-14T15:01:00.000Z',
    );
  });

  it('accepts 22:00 to 01:00 as a match that ends the next day, with the notice', () => {
    const config = configOf({ startTime: '22:00', endTime: '01:00' });
    expect(config.starts_at).toBe('2030-10-16T01:00:00.000Z');
    expect(config.ends_at).toBe('2030-10-16T04:00:00.000Z');
    expect(nextDayNotice('22:00', '01:00')).toBe('Termina às 01:00 do dia seguinte');
    expect(endRule('22:00', '01:00')).toEqual({ nextDay: '01:00' });
  });

  it('refuses 10:00 to 08:00 on the end: 22 h is not a next-day finish', () => {
    expect(errorsOf({ startTime: '10:00', endTime: '08:00' })).toEqual({
      endTime: 'O horário final precisa ser depois do início',
    });
    expect(nextDayNotice('10:00', '08:00')).toBeUndefined();
  });

  it('allows exactly 6 h overnight and refuses one minute more', () => {
    expect(endRule('20:00', '02:00')).toEqual({ nextDay: '02:00' });
    expect(endRule('20:00', '02:01')).toEqual({
      error: 'O horário final precisa ser depois do início',
    });
  });

  it('refuses an end equal to the start', () => {
    expect(errorsOf({ startTime: '19:30', endTime: '19:30' })).toEqual({
      endTime: 'O horário final precisa ser depois do início',
    });
  });

  it('refuses a same-day match over 6 h, and accepts exactly 6 h', () => {
    expect(errorsOf({ startTime: '08:00', endTime: '14:01' })).toEqual({
      endTime: 'O racha pode durar no máximo 6 horas.',
    });
    expect(endRule('08:00', '14:00')).toBeUndefined();
  });

  it('shows date and end errors together, each on its own field', () => {
    expect(errorsOf({ date: '01/01/2020', startTime: '10:00', endTime: '08:00' })).toEqual({
      date: 'A data não pode ser anterior a hoje',
      endTime: 'O horário final precisa ser depois do início',
    });
  });

  it('measures spans across midnight', () => {
    expect(spanMinutes(22 * 60, 60)).toBe(180);
    expect(spanMinutes(600, 480)).toBe(22 * 60);
    expect(spanMinutes(600, 600)).toBe(0);
  });
});

describe('the masked price', () => {
  it.each([
    ['R$ 25,00', '25.00'],
    ['R$ 0,05', '0.05'],
    ['R$ 1.234,56', '1234.56'],
    ['25,5', '25.50'],
    ['R$ 25,0', '25.00'],
    ['', undefined],
  ])('%j → %j', (field, price) => {
    expect(priceFromField(field)).toBe(price);
  });
});
