import { AppError } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';

import { groupErrorMessage } from '../groups/group-errors';

/** The rating codes first; the rest are the group catalogue's messages. */
export function ratingErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    if (error.code === 'STARS_RANGE') return pt.ratings.errors.range;
    if (error.code === 'NOT_ACTIVE_MEMBER') return pt.ratings.errors.notActive;
    if (error.code === 'NOT_ORGANIZER') return pt.ratings.errors.notOrganizer;
  }
  return groupErrorMessage(error);
}
