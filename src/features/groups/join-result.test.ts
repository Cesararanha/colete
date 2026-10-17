import { describe, expect, it } from 'vitest';

import { joinDestination } from './join-result';

const group = '15b00001-0000-4000-8000-000000000000';

describe('after "Pedir para entrar" (Ajustes do teste do César)', () => {
  it('a request sent, new or repeated, goes to Grupos with the notice', () => {
    for (const logical of ['membership_requested', 'membership_request_unchanged']) {
      expect(
        joinDestination({
          outcome: { group_id: group, logical_result: logical },
          current: { group_id: group, status: 'pending' },
        }),
      ).toEqual({ pathname: '/grupos', params: { requested: '1' } });
    }
  });

  it('an active membership stays on the form', () => {
    expect(
      joinDestination({
        outcome: { group_id: group, logical_result: 'membership_already_active' },
        current: { group_id: group, status: 'active' },
      }),
    ).toBeNull();
  });
});
