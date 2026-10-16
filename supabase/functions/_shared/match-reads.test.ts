import { describe, expect, it, vi } from 'vitest';

import { dispatchMatchRead } from './match-reads.ts';

const ACTOR = {
  authUserId: '5f0d9f1e-6a2e-4d2b-8c3a-1a2b3c4d5e6f',
  sessionId: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
};
const MATCH = '15c00003-0000-4000-8000-000000000000';

describe('match read projections', () => {
  it('passes the verified actor and the match, nothing from the body', async () => {
    const callRpc = vi.fn(async () => ({ data: { match_id: MATCH } }));
    const result = await dispatchMatchRead({ actor: ACTOR, callRpc }, 'get_match', {
      match_id: MATCH,
    });
    expect(result.status).toBe(200);
    expect(callRpc).toHaveBeenCalledWith('get_match', {
      p_actor_auth_user_id: ACTOR.authUserId,
      p_actor_session_id: ACTOR.sessionId,
      p_match_id: MATCH,
    });
  });

  it('the list takes no business input', async () => {
    const callRpc = vi.fn(async () => ({ data: [] }));
    await dispatchMatchRead({ actor: ACTOR, callRpc }, 'list_my_matches', {});
    expect(callRpc).toHaveBeenCalledWith('list_my_matches', {
      p_actor_auth_user_id: ACTOR.authUserId,
      p_actor_session_id: ACTOR.sessionId,
    });
  });

  it('refuses an actor override, an unknown key or a malformed match before the RPC', async () => {
    const callRpc = vi.fn(async () => ({ data: null }));
    for (const body of [
      { match_id: MATCH, p_actor_auth_user_id: ACTOR.authUserId },
      { match_id: MATCH, profile_id: ACTOR.authUserId },
      { match_id: MATCH.toUpperCase() },
      {},
      [],
    ]) {
      const result = await dispatchMatchRead({ actor: ACTOR, callRpc }, 'get_match', body);
      expect(result.status).toBe(422);
      expect((result.body['error'] as { code: string }).code).toBe('VALIDATION');
    }
    expect(callRpc).not.toHaveBeenCalled();
  });

  it('maps a stable database code and hides anything else', async () => {
    const member = await dispatchMatchRead(
      { actor: ACTOR, callRpc: async () => ({ error: { message: 'NOT_MEMBER' } }) },
      'get_match',
      { match_id: MATCH },
    );
    expect(member.status).toBe(403);
    const raw = await dispatchMatchRead(
      { actor: ACTOR, callRpc: async () => ({ error: { message: 'relation x does not exist' } }) },
      'get_match',
      { match_id: MATCH },
    );
    expect(raw.status).toBe(500);
    expect(JSON.stringify(raw.body)).not.toContain('relation');
  });

  it('the roster takes the match and the occupancy nothing, both with the actor', async () => {
    const callRpc = vi.fn(async () => ({ data: [] }));
    await dispatchMatchRead({ actor: ACTOR, callRpc }, 'get_match_roster', { match_id: MATCH });
    await dispatchMatchRead({ actor: ACTOR, callRpc }, 'get_matches_occupancy', {});
    expect(callRpc.mock.calls).toEqual([
      [
        'get_match_roster',
        {
          p_actor_auth_user_id: ACTOR.authUserId,
          p_actor_session_id: ACTOR.sessionId,
          p_match_id: MATCH,
        },
      ],
      [
        'get_matches_occupancy',
        { p_actor_auth_user_id: ACTOR.authUserId, p_actor_session_id: ACTOR.sessionId },
      ],
    ]);
    const extra = await dispatchMatchRead({ actor: ACTOR, callRpc }, 'get_matches_occupancy', {
      match_id: MATCH,
    });
    expect(extra.status).toBe(422);
  });
});
