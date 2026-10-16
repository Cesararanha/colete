// Where a refusal of create_match lands in the form: on the field it is
// about, or in the notice at the top when no field owns it. The Edge names the
// field of a VALIDATION by its config key; the database codes name the rule.

import { pt } from '../../lib/i18n/pt';

import type { MatchFormValues } from './match-form';

const FIELD_OF_KEY: Record<string, keyof MatchFormValues> = {
  'config.starts_at': 'startTime',
  'config.ends_at': 'endTime',
  'config.timezone': 'date',
  'config.location_name': 'locationName',
  'config.location_address': 'locationAddress',
  'config.latitude': 'locationAddress',
  'config.longitude': 'locationAddress',
  'config.description': 'description',
  'config.field_slots': 'slots',
  'config.field_price': 'price',
};

const MESSAGE_OF_FIELD: Record<keyof MatchFormValues, string> = {
  date: pt.matches.create.errors.date,
  startTime: pt.matches.create.errors.timeOrder,
  endTime: pt.matches.create.errors.timeOrder,
  locationName: pt.matches.create.errors.place,
  locationAddress: pt.matches.create.errors.address,
  description: pt.matches.create.errors.descriptionControl,
  slots: pt.matches.create.errors.slots,
  price: pt.matches.create.errors.price,
};

/** Read as data: an AppError carries code and fields; anything else has neither. */
function shape(error: unknown): { code?: unknown; fields?: unknown } {
  return typeof error === 'object' && error !== null ? error : {};
}

export function serverErrorTarget(
  error: unknown,
  fallback: (error: unknown) => string,
): { field?: keyof MatchFormValues; message: string } {
  const { code, fields } = shape(error);
  if (code === 'TIME_ORDER') {
    return { field: 'startTime', message: pt.matches.create.errors.timeOrder };
  }
  if (code === 'PRICE_INVALID') {
    return { field: 'price', message: pt.matches.create.errors.priceInvalid };
  }
  if (code === 'VALIDATION' && typeof fields === 'object' && fields !== null) {
    for (const key of Object.keys(fields)) {
      const field = FIELD_OF_KEY[key];
      if (field !== undefined) return { field, message: MESSAGE_OF_FIELD[field] };
    }
  }
  return { message: fallback(error) };
}
