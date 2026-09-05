import { AppError, TransportError } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';

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
