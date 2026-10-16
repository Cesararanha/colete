import { describe, expect, it } from 'vitest';

import { serverErrorTarget as target } from './match-server-errors';

class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options: { fields?: Record<string, string> } = {},
  ) {
    super(message);
    Object.assign(this, options);
  }
}
const serverErrorTarget = (error: unknown) => target(error, () => 'aviso no topo');

describe('server refusals land on the right field (human decision of 17/10/2026)', () => {
  it('puts TIME_ORDER on the start and PRICE_INVALID on the price', () => {
    expect(serverErrorTarget(new AppError('TIME_ORDER', 'x'))).toEqual({
      field: 'startTime',
      message: 'O horário do racha não é válido. Confira a data, o início e o fim.',
    });
    expect(serverErrorTarget(new AppError('PRICE_INVALID', 'x')).field).toBe('price');
  });

  it('maps a VALIDATION by its config key', () => {
    const error = new AppError('VALIDATION', 'x', {
      fields: { 'config.location_name': 'must be between 2 and 80 code points' },
    });
    expect(serverErrorTarget(error)).toEqual({
      field: 'locationName',
      message: 'Informe o local com 2 a 80 caracteres.',
    });
    expect(
      serverErrorTarget(new AppError('VALIDATION', 'x', { fields: { 'config.latitude': 'x' } }))
        .field,
    ).toBe('locationAddress');
  });

  it('sends anything without a field to the notice at the top', () => {
    expect(serverErrorTarget(new AppError('NOT_ORGANIZER', 'x')).field).toBeUndefined();
    expect(serverErrorTarget(new Error('rede'))).toEqual({ message: 'aviso no topo' });
    expect(serverErrorTarget(new AppError('VALIDATION', 'x')).field).toBeUndefined();
  });
});
