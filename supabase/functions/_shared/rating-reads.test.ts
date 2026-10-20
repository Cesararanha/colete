import { describe, expect, it, vi } from 'vitest';

import { dispatchRatingRead } from './rating-reads.ts';

const ACTOR = {
  authUserId: '5f0d9f1e-6a2e-4d2b-8c3a-1a2b3c4d5e6f',
  sessionId: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
};
const GROUP = '15b00001-0000-4000-8000-000000000000';

describe('rating reads (0031)', () => {
  it.each(['get_group_ratings', 'get_my_rating'] as const)(
    '%s passes the verified actor and the group, nothing from the body',
    async (operation) => {
      const callRpc = vi.fn(async () => ({ data: { group_id: GROUP } }));
      const result = await dispatchRatingRead({ actor: ACTOR, callRpc }, operation, {
        group_id: GROUP,
      });
      expect(result.status).toBe(200);
      expect(callRpc).toHaveBeenCalledWith(operation, {
        p_actor_auth_user_id: ACTOR.authUserId,
        p_actor_session_id: ACTOR.sessionId,
        p_group_id: GROUP,
      });
    },
  );

  it('refuses another profile, an actor override or a malformed group before the RPC', async () => {
    const callRpc = vi.fn(async () => ({ data: null }));
    for (const body of [
      { group_id: GROUP, profile_id: ACTOR.authUserId },
      { group_id: GROUP, p_actor_auth_user_id: ACTOR.authUserId },
      { group_id: GROUP.toUpperCase() },
      {},
      [],
    ]) {
      const result = await dispatchRatingRead({ actor: ACTOR, callRpc }, 'get_my_rating', body);
      expect(result.status).toBe(422);
    }
    expect(callRpc).not.toHaveBeenCalled();
  });

  it('answers NOT_MEMBER as 403 and hides anything unmapped', async () => {
    const answer = (message: string) =>
      dispatchRatingRead(
        { actor: ACTOR, callRpc: async () => ({ error: { message } }) },
        'get_group_ratings',
        { group_id: GROUP },
      );
    expect((await answer('NOT_MEMBER')).status).toBe(403);
    const raw = await answer('relation private.ratings does not exist');
    expect(raw.status).toBe(500);
    expect(JSON.stringify(raw.body)).not.toMatch(/ratings/);
  });
});
