import { describe, expect, it } from 'vitest';

import { collectorNames, paymentNotice, type GroupMemberRead } from './payment-notice';

const member = (
  display_name: string,
  role: GroupMemberRead['role'],
  status: GroupMemberRead['status'] = 'active',
): GroupMemberRead => ({ display_name, role, status });

describe('who collects the payment (P11)', () => {
  it('lists the owner first, then the active organizers', () => {
    expect(collectorNames([member('Ana', 'owner')])).toBe('Ana');
    expect(collectorNames([member('Beto', 'organizer'), member('Ana', 'owner')])).toBe(
      'Ana ou Beto',
    );
    expect(
      collectorNames([
        member('Ana', 'owner'),
        member('Beto', 'organizer'),
        member('Dani', 'player'),
        member('Caio', 'organizer'),
        member('Eva', 'organizer', 'pending'),
      ]),
    ).toBe('Ana, Beto ou Caio');
  });

  it('puts the owner first even when a name comes before it in the alphabet (rev91 P2-2)', () => {
    expect(collectorNames([member('Ana', 'organizer'), member('Zeca', 'owner')])).toBe(
      'Zeca ou Ana',
    );
    expect(
      collectorNames([
        member('Ana', 'organizer'),
        member('Bruno', 'organizer'),
        member('Zeca', 'owner'),
      ]),
    ).toBe('Zeca, Ana ou Bruno');
  });

  it('says nothing about names it does not have yet', () => {
    expect(collectorNames(undefined)).toBe('');
    expect(collectorNames([member('Dani', 'player')])).toBe('');
  });
});

describe('when the instruction shows (P12)', () => {
  const base = {
    status: 'starter' as const,
    paid: false,
    canManage: false,
    canceled: false,
    collectors: 'Ana ou Beto',
  };

  // The match's start and end do not enter the rule at all: the debt stays (P12).
  it('shows the instruction to who is confirmed and not paid', () => {
    expect(paymentNotice(base)).toEqual({ kind: 'pay', collectors: 'Ana ou Beto' });
  });

  it('shows "Pago" once marked, the canceled match included', () => {
    expect(paymentNotice({ ...base, paid: true })).toEqual({ kind: 'paid' });
    expect(paymentNotice({ ...base, paid: true, canceled: true })).toEqual({ kind: 'paid' });
  });

  it('shows nothing on the waitlist, out of the list or unpaid in a canceled match', () => {
    expect(paymentNotice({ ...base, status: 'waitlist' })).toBeNull();
    expect(paymentNotice({ ...base, status: 'out' })).toBeNull();
    expect(paymentNotice({ ...base, canceled: true })).toBeNull();
  });

  it('never tells the organisation to pay itself', () => {
    expect(paymentNotice({ ...base, canManage: true })).toBeNull();
    expect(paymentNotice({ ...base, canManage: true, paid: true })).toBeNull();
  });
});
