import { describe, expect, it } from 'vitest';

import { AppError, TransportError } from '../../lib/api';
import { pt } from '../../lib/i18n/pt';

import { authErrorMessage, loginErrorMessage, passwordUpdateErrorMessage } from './messages';

const invalidCredentials = new AppError('UNAUTHENTICATED', 'Invalid login credentials', {
  authCode: 'invalid_credentials',
});

describe('auth messages', () => {
  it('answers a refused sign-in with one message that never tells which field was wrong', () => {
    expect(loginErrorMessage(invalidCredentials)).toBe('E-mail ou senha incorretos.');
    expect(loginErrorMessage(new AppError('UNAUTHENTICATED', 'Invalid login credentials'))).toBe(
      'E-mail ou senha incorretos.',
    );
    expect(pt.auth.errors.credentials).not.toBe(pt.auth.errors.unauthenticated);
  });

  it('keeps the general wording for any other sign-in refusal', () => {
    const unconfirmed = new AppError('UNAUTHENTICATED', 'Email not confirmed', {
      authCode: 'email_not_confirmed',
    });
    expect(loginErrorMessage(unconfirmed)).toBe(pt.auth.errors.unauthenticated);
    expect(loginErrorMessage(new TransportError())).toBe(pt.common.networkBody);
  });

  it('names an unchanged password only for the Auth same_password refusal', () => {
    const samePassword = new AppError('VALIDATION', 'New password should be different', {
      authCode: 'same_password',
    });
    const weakPassword = new AppError('VALIDATION', 'Password is too weak', {
      authCode: 'weak_password',
    });
    expect(passwordUpdateErrorMessage(samePassword)).toBe(
      'A nova senha precisa ser diferente da atual.',
    );
    expect(passwordUpdateErrorMessage(weakPassword)).toBe(pt.auth.errors.validation);
    // The general mapper, used by every other auth form, is unchanged.
    expect(authErrorMessage(samePassword)).toBe(pt.auth.errors.validation);
  });
});
