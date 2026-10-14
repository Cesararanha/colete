import { AppError, TransportError } from '../../lib/api';
import { pt } from '../../lib/i18n/pt';

const validationMessages: Record<string, string> = {
  email: pt.validation.email,
  name_length: pt.validation.nameLength,
  name_max: pt.validation.nameMax,
  nickname_max: pt.validation.nicknameMax,
  optional_blank: pt.validation.optionalBlank,
  otp_length: pt.validation.otpLength,
  password_length: pt.validation.passwordLength,
  password_match: pt.validation.passwordMatch,
  required: pt.validation.required,
  shirt_number: pt.validation.shirtNumber,
};

export function fieldMessage(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  return validationMessages[message] ?? pt.auth.errors.validation;
}

export function authErrorMessage(error: unknown): string {
  if (error instanceof TransportError) return pt.common.networkBody;
  if (error instanceof AppError) {
    switch (error.code) {
      case 'UNAUTHENTICATED':
        return pt.auth.errors.unauthenticated;
      case 'VALIDATION':
        return pt.auth.errors.validation;
      case 'IDEMPOTENCY_WAIT_TIMEOUT':
        return pt.auth.errors.wait;
      default:
        return error.message || pt.auth.errors.generic;
    }
  }
  return pt.auth.errors.generic;
}

/**
 * Sign-in failure. Supabase Auth answers a wrong password and an unknown
 * e-mail with the same `invalid_credentials`, and so does this message: it
 * never says which of the two was wrong, so it never reveals that an account
 * exists. Any other Auth refusal keeps the general wording.
 */
export function loginErrorMessage(error: unknown): string {
  if (
    error instanceof AppError &&
    error.code === 'UNAUTHENTICATED' &&
    (error.authCode === undefined || error.authCode === 'invalid_credentials')
  ) {
    return pt.auth.errors.credentials;
  }
  return authErrorMessage(error);
}

/** Password update (recovery): Supabase Auth refuses an unchanged password with `same_password`. */
export function passwordUpdateErrorMessage(error: unknown): string {
  if (error instanceof AppError && error.authCode === 'same_password') {
    return pt.auth.errors.samePassword;
  }
  return authErrorMessage(error);
}
