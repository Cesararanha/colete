import { AppError } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';

import { groupErrorMessage } from '../groups/group-errors';

/** The match codes first; the rest are the group catalogue's messages. */
export function matchErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    switch (error.code) {
      case 'MATCH_STARTED':
        return pt.matches.detail.errors.started;
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
        return pt.matches.detail.errors.notOrganizer;
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
