import { describe, expect, it } from 'vitest';

import { crc16, pixBrCode } from './pix-brcode';

describe('crc16', () => {
  it('is CRC-16/CCITT-FALSE', () => {
    expect(crc16('123456789')).toBe('29B1');
    expect(crc16('')).toBe('FFFF');
  });
});

describe('pixBrCode', () => {
  it('reproduces the static example of the Banco Central manual', () => {
    expect(
      pixBrCode({
        key: '123e4567-e12b-12d1-a456-426655440000',
        receiverName: 'Fulano de Tal',
        receiverCity: 'BRASILIA',
        amount: null,
      }),
    ).toBe(
      '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D',
    );
  });

  it('carries the amount in field 54 and a valid CRC', () => {
    const code = pixBrCode({
      key: '52998224725',
      receiverName: 'DONA DO RACHA',
      receiverCity: 'SAO PAULO',
      amount: '17.50',
    });
    expect(code).toContain('540517.50');
    expect(code).toContain('0111' + '52998224725');
    expect(code.slice(-4)).toBe(crc16(code.slice(0, -4)));
  });

  it('omits a zero amount, so the payer types it', () => {
    const code = pixBrCode({
      key: '+5511999998888',
      receiverName: 'ORG',
      receiverCity: 'RECIFE',
      amount: '0.00',
    });
    expect(code).not.toContain('5404');
    expect(code).toContain('0114+5511999998888');
  });

  it('refuses text that would break the layout', () => {
    const base = { key: 'a@b.co', receiverName: 'ORG', receiverCity: 'RECIFE', amount: null };
    expect(() => pixBrCode({ ...base, receiverName: 'JOSÉ' })).toThrow();
    expect(() => pixBrCode({ ...base, receiverCity: 'A'.repeat(16) })).toThrow();
    expect(() => pixBrCode({ ...base, amount: '17,50' })).toThrow();
    expect(() => pixBrCode({ ...base, key: 'chaveç' })).toThrow();
  });
});
