import { AppError } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';

import { groupErrorMessage } from '../groups/group-errors';

/**
 * The match codes first; the rest are the group catalogue's messages.
 * `manage` is the edit and the cancellation, where NOT_ORGANIZER is about
 * them and not about payments.
 */
export function matchErrorMessage(
  error: unknown,
  context: 'presence' | 'manage' = 'presence',
): string {
  if (error instanceof AppError) {
    switch (error.code) {
      case 'PRICE_LOCKED':
        return pt.refunds.errors.PRICE_LOCKED;
      case 'MATCH_NOT_CANCELED':
        return pt.refunds.errors.MATCH_NOT_CANCELED;
      case 'PAYMENT_ALREADY_RESOLVED':
        return pt.refunds.errors.PAYMENT_ALREADY_RESOLVED;
      case 'PAYMENT_RELATION_NOT_FOUND':
        return pt.refunds.errors.PAYMENT_RELATION_NOT_FOUND;
      case 'REFUND_NOT_FOUND':
        return pt.refunds.errors.REFUND_NOT_FOUND;
      case 'ACTIVE_PAYMENTS_REMAIN':
        return pt.refunds.errors.ACTIVE_PAYMENTS_REMAIN;
      case 'REFUNDS_PENDING':
        return pt.refunds.errors.REFUNDS_PENDING;
      case 'MATCH_STARTED':
        return pt.matches.detail.errors.started;
      case 'MATCH_CANCELED':
        return pt.matches.detail.errors.canceled;
      case 'MATCH_DONE':
        return pt.matches.detail.errors.done;
      // Outside the group, an existing match and an unknown one answer the same
      // NOT_FOUND (review of #71, P1-2); NOT_MEMBER stays for older answers.
      case 'NOT_FOUND':
      case 'NOT_MEMBER':
        return pt.matches.detail.errors.notMember;
      case 'PAYMENT_ALREADY_REAL':
        return pt.matches.detail.errors.paymentReal;
      case 'NOT_STARTER':
        return pt.matches.detail.errors.notStarter;
      case 'NOT_ORGANIZER':
        return context === 'manage'
          ? pt.matches.detail.errors.notOrganizerManage
          : pt.matches.detail.errors.notOrganizer;
      case 'GROUP_SUSPENDED':
        return pt.matches.detail.errors.groupSuspended;
      case 'GROUP_ARCHIVED':
        return pt.matches.detail.errors.archived;
      default:
        break;
    }
  }
  return groupErrorMessage(error);
}
