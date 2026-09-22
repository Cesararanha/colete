import { describe, expect, it, vi } from 'vitest';

import { runOperation } from './gateway.ts';
import type { RpcCaller } from './gateway.ts';
import { OPERATIONS } from './operations.ts';

const REQUEST_ID = '01890f7e-e948-7c53-b13a-4a36e4b7d21e';
const ACTOR = {
  authUserId: '5f0d9f1e-6a2e-4d2b-8c3a-1a2b3c4d5e6f',
  sessionId: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
};
const resolveKey = () => new Uint8Array(32);

const BODIES: Record<(typeof OPERATIONS)[number], Record<string, unknown>> = {
  accept_policies: { request_id: REQUEST_ID, versions: [{ document_type: 'terms', version: '1' }] },
  complete_profile: { request_id: REQUEST_ID, profile: { name: 'Ana' } },
  delete_account: { request_id: REQUEST_ID },
  request_data_export: { request_id: REQUEST_ID },
  revoke_current_session: { request_id: REQUEST_ID },
  update_profile: { request_id: REQUEST_ID, patch: { nickname: 'Capitã' } },
};

describe('gateway internal call', () => {
  it.each(OPERATIONS)('%s reaches its RPC with the actor and HMAC, never undefined', async (op) => {
    const callRpc = vi.fn<RpcCaller>(async () => ({ data: { ok: true } }));
    const result = await runOperation({ resolveKey, callRpc }, op, BODIES[op], ACTOR);

    expect(result.status).toBe(200);
    expect(callRpc).toHaveBeenCalledTimes(1);
    const [functionName, params] = callRpc.mock.calls[0] ?? [];
    expect(functionName).toBe(op);
    expect(params).toMatchObject({
      p_actor_auth_user_id: ACTOR.authUserId,
      p_actor_session_id: ACTOR.sessionId,
      p_canonical_version: 1,
      p_hash_key_version: 1,
      p_request_id: REQUEST_ID,
    });
    expect(typeof params?.['p_input_hmac']).toBe('string');
  });

  it('maps a stable database code without leaking the raw message', async () => {
    const callRpc = vi.fn<RpcCaller>(async () => ({
      error: { message: 'EXPORT_ALREADY_PENDING' },
    }));
    const result = await runOperation(
      { resolveKey, callRpc },
      'request_data_export',
      BODIES.request_data_export,
      ACTOR,
    );
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: {
        code: 'EXPORT_ALREADY_PENDING',
        message: 'A data export is already being prepared or awaiting cleanup.',
      },
      request_id: REQUEST_ID,
    });
  });
});
