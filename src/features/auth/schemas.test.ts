import { describe, expect, it } from 'vitest';

import {
  emailSchema,
  newPasswordSchema,
  otpSchema,
  passwordSchema,
  profileSchema,
  signUpSchema,
} from './schemas';

describe('authentication schemas', () => {
  it('normalises a valid e-mail and rejects incomplete addresses', () => {
    expect(emailSchema.parse('  PESSOA@EXEMPLO.COM ')).toBe('pessoa@exemplo.com');
    expect(emailSchema.safeParse('pessoa@').success).toBe(false);
  });

  it('applies the exact name and password boundaries from screen 2', () => {
    expect(passwordSchema.safeParse('1234567').success).toBe(false);
    expect(passwordSchema.safeParse('12345678').success).toBe(true);
    expect(
      signUpSchema.safeParse({
        name: 'A',
        email: 'ana@example.test',
        password: '12345678',
        confirmPassword: '12345678',
      }).success,
    ).toBe(false);
    expect(
      signUpSchema.parse({
        name: '  Jose\u0301  ',
        email: 'ANA@EXAMPLE.TEST',
        password: 'uma-senha-segura',
        confirmPassword: 'uma-senha-segura',
      }),
    ).toMatchObject({ name: 'Jos\u00e9', email: 'ana@example.test' });
    expect(
      signUpSchema.safeParse({
        name: 'A'.repeat(81),
        email: 'ana@example.test',
        password: '12345678',
        confirmPassword: '12345678',
      }).success,
    ).toBe(false);
  });

  it('requires password confirmation to match', () => {
    expect(
      newPasswordSchema.safeParse({ password: 'uma-senha', confirmPassword: 'outra-senha' })
        .success,
    ).toBe(false);
  });

  it('accepts exactly six numeric OTP characters', () => {
    expect(otpSchema.safeParse({ code: '123456' }).success).toBe(true);
    expect(otpSchema.safeParse({ code: '12345' }).success).toBe(false);
    expect(otpSchema.safeParse({ code: '12345a' }).success).toBe(false);
  });

  it('shares the complete_profile field boundaries with the payload', () => {
    expect(profileSchema.safeParse({ name: 'Ana' }).success).toBe(true);
    expect(profileSchema.safeParse({ name: 'A' }).success).toBe(false);
    expect(profileSchema.safeParse({ name: 'Ana', shirt_number: 100 }).success).toBe(false);
    expect(profileSchema.safeParse({ name: 'Ana', nickname: '' }).success).toBe(false);
    expect(profileSchema.parse({ name: '  Jose\u0301  ' }).name).toBe('Jos\u00e9');
  });
});
