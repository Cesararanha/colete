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
      case 'DELETION_ALREADY_PENDING':
        return pt.privacy.deletion.alreadyPending;
      case 'FINANCIAL_SUBSTITUTE_REQUIRED':
        return pt.privacy.deletion.financialSubstituteRequired;
      case 'EXPORT_ALREADY_PENDING':
        return pt.privacy.export.alreadyPending;
      case 'EXPORT_EXPIRED':
        return pt.privacy.export.states.consumed.body;
      case 'RECENT_REAUTH_REQUIRED':
        return pt.privacy.export.reauth.body;
      default:
        return error.message || pt.auth.errors.generic;
    }
  }
  return pt.auth.errors.generic;
}
