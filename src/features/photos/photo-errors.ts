import { AppError, TransportError } from '../../lib/api';
import { pt } from '../../lib/i18n/pt';

/** What went wrong with a photo change, in the screen's words. */
export function photoErrorMessage(error: unknown): string {
  if (error instanceof TransportError) return pt.photos.errors.network;
  if (error instanceof AppError) {
    switch (error.code) {
      case 'VALIDATION':
        return pt.photos.errors.invalid;
      case 'RATE_LIMITED':
        return pt.photos.errors.rateLimited;
      case 'OWNER_ONLY':
        return pt.photos.errors.ownerOnly;
      default:
        return pt.photos.errors.failed;
    }
  }
  return pt.photos.errors.failed;
}
