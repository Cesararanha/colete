import type { PaymentInstructions } from '@/lib/api';

import { matchTime } from './match-format';

const DAY = 24 * 60 * 60 * 1000;

/** "Pix alterado às HH:MM" only within a day of a replacement (plan section 4.7). */
export function pixChangedAt(
  pix: Pick<PaymentInstructions, 'replaced' | 'set_at'>,
  timeZone: string,
  now: number = Date.now(),
): string | null {
  if (!pix.replaced) return null;
  const at = new Date(pix.set_at).getTime();
  if (!Number.isFinite(at) || now - at > DAY || at > now + 60_000) return null;
  return matchTime(pix.set_at, timeZone);
}
