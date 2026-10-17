import { describe, expect, it } from 'vitest';

import { pt } from './pt';

// Ajustes do teste do César: descriptions under fields that do not prevent a
// real error are gone; those that do (code format, price mask, next-day end,
// password strength) stay.
describe('field descriptions', () => {
  it('removed the hints that only repeated the obvious', () => {
    expect(pt.matches.create).not.toHaveProperty('dateHint');
    expect(pt.matches.create).not.toHaveProperty('timeHint');
    expect(pt.matches.create).not.toHaveProperty('placeHint');
    expect(pt.matches.create).not.toHaveProperty('addressHint');
    expect(pt.matches.create).not.toHaveProperty('descriptionHint');
    expect(pt.groups.create).not.toHaveProperty('hint');
    expect(pt.groups.members).not.toHaveProperty('reasonHint');
    expect(pt.profile.fields).not.toHaveProperty('optionalHint');
    expect(pt.profile.fields).not.toHaveProperty('positionHint');
  });

  it('kept the ones that prevent a real error', () => {
    expect(pt.groups.join.codeHint).toContain('10 símbolos');
    expect(pt.matches.create.priceHint).toContain('2500');
    expect(pt.matches.create.nextDay('00:30')).toContain('dia seguinte');
    expect(pt.auth.signup.strengthLabel).toBe('Força da senha');
  });
});
