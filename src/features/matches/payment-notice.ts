// Fatia 1.1 do piloto (D63-G; tela 8 do docs/11 no recorte do docs/27): the
// person who plays sees how to pay. The settlement is outside the app; the app
// only says who collects and the price, and shows the organisation's mark.

import type { MatchPresenceStatus } from '@/lib/api';

export type GroupMemberRead = {
  display_name: string;
  role: 'owner' | 'organizer' | 'player';
  status: 'active' | 'pending';
};

export type PaymentNotice = { kind: 'pay'; collectors: string } | { kind: 'paid' } | null;

/**
 * "Ana", "Ana ou Beto", "Ana, Beto ou Caio": the owner first, then the active
 * organizers, in the order get_group_members returns them. No article before
 * the names: a name does not say which one fits.
 */
export function collectorNames(members: readonly GroupMemberRead[] | undefined): string {
  const names = (members ?? [])
    .filter((member) => member.status === 'active' && member.role !== 'player')
    .sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner'))
    .map((member) => member.display_name);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ou ${names[names.length - 1]}`;
}

/**
 * Human decision of 28/10/2026 (P12): the instruction only for who is confirmed
 * and not paid, also once the match started or ended (the debt stays); nothing
 * on the waitlist, nothing in a canceled match for who did not pay, and nothing
 * on the organisation's own line, which sees the summary instead. Who was
 * marked paid sees "Pago", the canceled match included.
 */
export function paymentNotice(viewer: {
  status: MatchPresenceStatus;
  paid: boolean | null;
  canManage: boolean;
  canceled: boolean;
  collectors: string;
}): PaymentNotice {
  if (viewer.canManage || viewer.status !== 'starter') return null;
  if (viewer.paid === true) return { kind: 'paid' };
  if (viewer.canceled) return null;
  return { kind: 'pay', collectors: viewer.collectors };
}
