import { AppError, TransportError } from '../../lib/api';
import { pt } from '../../lib/i18n/pt';

export function profileErrorMessage(error: unknown): string {
  if (error instanceof TransportError) return pt.common.networkBody;
  if (error instanceof AppError) {
    switch (error.code) {
      case 'FORBIDDEN':
        return pt.profile.errors.forbidden;
      case 'PROFILE_SUSPENDED':
        return pt.profile.errors.suspended;
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
