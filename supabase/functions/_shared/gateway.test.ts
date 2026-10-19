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
const GROUP = '15b00001-0000-4000-8000-000000000000';
const TARGET = '15a00002-0000-4000-8000-000000000000';
const MATCH = '15c00003-0000-4000-8000-000000000000';
// A start one day ahead at minute precision keeps create_match inside its window.
const STARTS = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 86_400_000);
const MATCH_CONFIG = {
  description: '',
  starts_at: STARTS.toISOString(),
  ends_at: new Date(STARTS.getTime() + 5_400_000).toISOString(),
  timezone: 'America/Sao_Paulo',
  location_name: 'Arena',
  location_address: null,
  latitude: -23.55052,
  longitude: -46.63331,
  field_slots: 14,
  field_price: '25',
};

const BODIES: Record<(typeof OPERATIONS)[number], Record<string, unknown>> = {
  accept_policies: { request_id: REQUEST_ID, versions: [{ document_type: 'terms', version: '1' }] },
  complete_profile: { request_id: REQUEST_ID, profile: { name: 'Ana' } },
  delete_account: { request_id: REQUEST_ID },
  request_data_export: { request_id: REQUEST_ID },
  revoke_current_session: { request_id: REQUEST_ID },
  update_profile: { request_id: REQUEST_ID, patch: { nickname: 'Capitã' } },
  approve_member: { request_id: REQUEST_ID, group_id: GROUP, profile_id: TARGET, approve: true },
  remove_member: { request_id: REQUEST_ID, group_id: GROUP, profile_id: TARGET, reason: 'motivo' },
  set_role: { request_id: REQUEST_ID, group_id: GROUP, profile_id: TARGET, role: 'organizer' },
  set_monthly: { request_id: REQUEST_ID, group_id: GROUP, profile_id: TARGET, enabled: true },
  set_ratings_visibility: {
    request_id: REQUEST_ID,
    group_id: GROUP,
    visibility: 'members',
    confirm_members_visibility: true,
  },
  transfer_ownership: { request_id: REQUEST_ID, group_id: GROUP, new_owner_id: TARGET },
  leave_group: { request_id: REQUEST_ID, group_id: GROUP },
  rename_group: { request_id: REQUEST_ID, group_id: GROUP, name: '  Café　da　Turma  ' },
  set_group_appearance: { request_id: REQUEST_ID, group_id: GROUP, icon: 'trophy', color: 'lilac' },
  create_match: { request_id: REQUEST_ID, group_id: GROUP, config: MATCH_CONFIG },
  join_match: { request_id: REQUEST_ID, match_id: MATCH },
  leave_match: { request_id: REQUEST_ID, match_id: MATCH },
  set_match_payment: { request_id: REQUEST_ID, match_id: MATCH, profile_id: TARGET, paid: true },
};

// The exact RPC arguments of each group operation, beyond the common internal
// ones. A renamed or dropped parameter would reach PostgREST as a wrong call.
const GROUP_PARAMETERS: Record<string, Record<string, unknown>> = {
  approve_member: { p_group_id: GROUP, p_profile_id: TARGET, p_approve: true },
  remove_member: { p_group_id: GROUP, p_profile_id: TARGET, p_reason: 'motivo' },
  set_role: { p_group_id: GROUP, p_profile_id: TARGET, p_role: 'organizer' },
  set_monthly: { p_group_id: GROUP, p_profile_id: TARGET, p_enabled: true },
  set_ratings_visibility: {
    p_group_id: GROUP,
    p_visibility: 'members',
    p_confirm_members_visibility: true,
  },
  transfer_ownership: { p_group_id: GROUP, p_new_owner_id: TARGET },
  leave_group: { p_group_id: GROUP },
  rename_group: { p_group_id: GROUP, p_name: 'Café da Turma' },
  set_group_appearance: { p_group_id: GROUP, p_icon: 'trophy', p_color: 'lilac' },
  create_match: {
    p_group_id: GROUP,
    p_config: {
      ...MATCH_CONFIG,
      latitude: '-23.5505',
      longitude: '-46.6333',
      field_price: '25.00',
      description: null,
    },
  },
  join_match: { p_match_id: MATCH },
  leave_match: { p_match_id: MATCH },
  set_match_payment: { p_match_id: MATCH, p_profile_id: TARGET, p_paid: true },
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
    if (op in GROUP_PARAMETERS) {
      expect(Object.keys(params ?? {}).sort()).toEqual(
        [
          'p_actor_auth_user_id',
          'p_actor_session_id',
          'p_canonical_version',
          'p_hash_key_version',
          'p_input_hmac',
          'p_request_id',
          ...Object.keys(GROUP_PARAMETERS[op] ?? {}),
        ].sort(),
      );
      expect(params).toMatchObject(GROUP_PARAMETERS[op] ?? {});
    }
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
