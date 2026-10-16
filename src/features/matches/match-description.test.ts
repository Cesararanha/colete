import { describe, expect, it } from 'vitest';

import { matchConfigFromForm } from './match-form';

describe('the description in the form (human decision of 16/10/2026)', () => {
  it('puts the normalised description, or null, in the form config', () => {
    const values = {
      date: '15/10/2030',
      startTime: '19:30',
      endTime: '21:00',
      locationName: 'Arena',
      locationAddress: '',
      slots: '14',
      price: '25',
    };
    const now = new Date(2030, 9, 14, 12, 0);
    const empty = matchConfigFromForm({ ...values, description: '' }, null, now, 'UTC');
    const text = matchConfigFromForm({ ...values, description: ' Leve  água ' }, null, now, 'UTC');
    expect('config' in empty && empty.config.description).toBeNull();
    expect('config' in text && text.config.description).toBe('Leve água');
    const blank = matchConfigFromForm({ ...values, description: '  ' }, null, now, 'UTC');
    expect('errors' in blank && blank.errors.description).toBe(
      'Escreva a descrição ou deixe o campo vazio; só espaços não valem.',
    );
  });
});
