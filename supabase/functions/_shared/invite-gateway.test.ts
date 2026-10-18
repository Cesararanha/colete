import { describe, expect, it } from 'vitest';
import {
  dispatchInvite,
  invitePageProjection,
  inviteShareUrl,
  normaliseGroupName,
} from './invite-gateway.ts';
import type { InviteDependencies } from './invite-gateway.ts';

const page = {
  group_name: 'Teste',
  member_count: 3,
  owner_name: 'Dona',
  viewer_status: null,
  group_id: null,
  refusal: null,
  group_icon: 'trophy',
  group_color: 'sand',
};
const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const actor = {
  authUserId: '17000000-0000-4000-8000-000000000001',
  sessionId: '17400000-0000-4000-8000-000000000001',
};
function fake(call: InviteDependencies['callRpc']): InviteDependencies {
  return {
    actor,
    resolveKey: () => key,
    inviteKey: key,
    callRpc: call,
    profileId: async () => '17100000-0000-4000-8000-000000000001',
    shareUrl: (token) => `https://example.invalid/join#token=${token}`,
  };
}

describe('dispatcher de convites do gateway produtivo', () => {
  it('usa a origem pública HTTPS fora do local e falha fechado sem configuração válida', () => {
    expect(inviteShareUrl('https://colete.example', 'synthetic', false)).toBe(
      'https://colete.example/join#token=synthetic',
    );
    expect(inviteShareUrl('http://127.0.0.1:8081/__invite_fixture__', 'synthetic', true)).toBe(
      'http://127.0.0.1:8081/__invite_fixture__#token=synthetic',
    );
    for (const invalid of [
      undefined,
      'http://colete.example',
      'colete://join',
      'https://colete.example/path',
      'https://colete.example/?q=1',
    ]) {
      expect(() => inviteShareUrl(invalid, 'synthetic', false)).toThrow();
    }
  });

  it('recusa corpo não objeto sem débito e debita código malformado em corpo válido', async () => {
    const calls: string[] = [];
    const deps = fake(async (name) => {
      calls.push(name);
      return {
        data: {
          allowed: true,
          attempt_id: crypto.randomUUID(),
          retry_after: null,
          available_at: null,
        },
      };
    });
    for (const body of [null, [], 'invalid']) {
      const result = await dispatchInvite(deps, 'join_by_code', body);
      expect(result.status).toBe(422);
    }
    expect(calls).toEqual([]);
    const invalidCode = await dispatchInvite(deps, 'join_by_code', {
      code: 'not a code!',
      request_id: '17500000-0000-4000-8000-000000000001',
    });
    expect(invalidCode.status).toBe(400);
    expect(calls).toEqual(['check_and_debit_invite_attempt']);
  });

  it('recusa campos internos depois do débito, sem chamar o domínio', async () => {
    for (const field of ['profile_id', 'p_actor_auth_user_id']) {
      const calls: string[] = [];
      const result = await dispatchInvite(
        fake(async (name) => {
          calls.push(name);
          return {
            data: {
              allowed: true,
              attempt_id: crypto.randomUUID(),
              retry_after: null,
              available_at: null,
            },
          };
        }),
        'join_by_code',
        {
          code: 'BYKTT-8DMAB',
          request_id: '17500000-0000-4000-8000-000000000001',
          [field]: actor.authUserId,
        },
      );
      expect(result.status).toBe(422);
      expect(result.body.error).toMatchObject({ code: 'VALIDATION' });
      expect(calls).toEqual(['check_and_debit_invite_attempt']);
    }
  });

  it('recusa quota antes de examinar código e nunca chama o domínio', async () => {
    const calls: string[] = [];
    const result = await dispatchInvite(
      fake(async (name, parameters) => {
        calls.push(name);
        expect(parameters['profile_id']).toBe('17100000-0000-4000-8000-000000000001');
        expect(parameters['p_actor_auth_user_id']).toBe(actor.authUserId);
        return {
          data: {
            allowed: false,
            attempt_id: crypto.randomUUID(),
            retry_after: 90,
            available_at: '2026-09-30T00:00:00Z',
          },
        };
      }),
      'preview_group_by_code',
      { code: 'invalid' },
    );
    expect(calls).toEqual(['check_and_debit_invite_attempt']);
    expect(result.status).toBe(429);
    expect(result.body.error).toMatchObject({
      code: 'RATE_LIMITED',
      retry_after: 90,
      available_at: '2026-09-30T00:00:00Z',
    });
  });

  it('quota prevalece até sobre request_id e chaves inválidas do resgate', async () => {
    const calls: string[] = [];
    const result = await dispatchInvite(
      fake(async (name) => {
        calls.push(name);
        return {
          data: {
            allowed: false,
            attempt_id: crypto.randomUUID(),
            retry_after: 60,
            available_at: '2026-09-30T00:00:00Z',
          },
        };
      }),
      'join_by_code',
      { code: 'INVALID', request_id: 'INVALID', forbidden_key: true },
    );
    expect(calls).toEqual(['check_and_debit_invite_attempt']);
    expect(result.status).toBe(429);
    expect(result.body.error).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('429 e 503 ecoam o request_id válido do resgate antes do domínio', async () => {
    const requestId = '17500000-0000-4000-8000-000000000001';
    for (const error of [false, true]) {
      const result = await dispatchInvite(
        fake(async () =>
          error
            ? { error: { message: 'counter unavailable' } }
            : {
                data: {
                  allowed: false,
                  attempt_id: crypto.randomUUID(),
                  retry_after: 60,
                  available_at: '2026-09-30T00:00:00Z',
                },
              },
        ),
        'join_by_code',
        { code: 'BYKTT-8DMAB', request_id: requestId },
      );
      expect(result.status).toBe(error ? 503 : 429);
      expect(result.body.request_id).toBe(requestId);
    }
  });

  it('recusa fechado quando o contador falha, sem chegar à RPC de domínio', async () => {
    const calls: string[] = [];
    const result = await dispatchInvite(
      fake(async (name) => {
        calls.push(name);
        return { error: { message: 'unexpected private failure' } };
      }),
      'join_by_code',
      { code: 'BYKTT-8DMAB', request_id: '17500000-0000-4000-8000-000000000001' },
    );
    expect(calls).toEqual(['check_and_debit_invite_attempt']);
    expect(result.status).toBe(503);
    expect(result.body.error).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
  });

  it('recusa fechado quando a resolução do perfil falha antes do débito', async () => {
    const deps = fake(async () => {
      throw new Error('the RPC must not be reached');
    });
    const result = await dispatchInvite(
      {
        ...deps,
        profileId: async () => {
          throw new Error('unavailable');
        },
      },
      'preview_group_by_code',
      { code: 'BYKTT-8DMAB' },
    );
    expect(result.status).toBe(503);
    expect(result.body.error).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
  });

  it('debita código malformado e o classifica como CODE_INVALID', async () => {
    const calls: string[] = [];
    const result = await dispatchInvite(
      fake(async (name) => {
        calls.push(name);
        return {
          data: {
            allowed: true,
            attempt_id: crypto.randomUUID(),
            retry_after: null,
            available_at: null,
          },
        };
      }),
      'preview_group_by_code',
      { code: 'not a code!' },
    );
    expect(calls).toEqual(['check_and_debit_invite_attempt']);
    expect(result.status).toBe(400);
    expect(result.body.error).toMatchObject({ code: 'CODE_INVALID' });
  });

  it('marca sucesso somente depois do preview pela mesma RPC de débito', async () => {
    const calls: string[] = [];
    const result = await dispatchInvite(
      fake(async (name) => {
        calls.push(name);
        if (name === 'check_and_debit_invite_attempt')
          return {
            data: {
              allowed: true,
              attempt_id: '17800000-0000-4000-8000-000000000001',
              retry_after: null,
              available_at: null,
            },
          };
        if (name === 'preview_group_by_code') return { data: page };
        return { data: null };
      }),
      'preview_group_by_code',
      { code: 'BYKTT-8DMAB' },
    );
    expect(calls).toEqual([
      'check_and_debit_invite_attempt',
      'preview_group_by_code',
      'mark_invite_attempt_success',
    ]);
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual(page);
  });

  it('falha da marcação conserva sucesso do domínio sem reexecutá-lo', async () => {
    const calls: string[] = [];
    const result = await dispatchInvite(
      fake(async (name) => {
        calls.push(name);
        if (name === 'check_and_debit_invite_attempt')
          return {
            data: {
              allowed: true,
              attempt_id: crypto.randomUUID(),
              retry_after: null,
              available_at: null,
            },
          };
        if (name === 'preview_group_by_code') return { data: page };
        return { error: { message: 'mark failed' } };
      }),
      'preview_group_by_code',
      { code: 'BYKTT-8DMAB' },
    );
    expect(result.status).toBe(200);
    expect(calls).toEqual([
      'check_and_debit_invite_attempt',
      'preview_group_by_code',
      'mark_invite_attempt_success',
    ]);
  });

  it('normaliza o nome com a mesma identidade de intenção da RPC', () => {
    expect(normaliseGroupName('  Racha　do Bairro  ')).toBe('Racha do Bairro');
    expect(normaliseGroupName('Cafe\u0301')).toBe('Café');
    expect(() => normaliseGroupName('Um\nNome')).toThrow();
    expect(() => normaliseGroupName('A')).toThrow();
    expect(() => normaliseGroupName('x'.repeat(41))).toThrow();
    for (const code of [
      0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061,
      0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
    ]) {
      expect(() => normaliseGroupName(`X${String.fromCodePoint(code)}Y`)).toThrow();
    }
    expect(normaliseGroupName('X\u200cY\u200dZ')).toBe('X\u200cY\u200dZ');
  });

  it('refaz todo o material após colisão real do índice de código', async () => {
    const attempts: Record<string, unknown>[] = [];
    const requestId = '17500000-0000-4000-8000-000000000002';
    const result = await dispatchInvite(
      fake(async (name, parameters) => {
        expect(name).toBe('create_group');
        attempts.push(parameters);
        if (attempts.length === 1) {
          return {
            error: {
              code: '23505',
              message:
                'duplicate key value violates unique constraint "group_invites_code_digest_key"',
            },
          };
        }
        return { data: { outcome: { logical_result: 'group_created' } } };
      }),
      'create_group',
      { name: 'Grupo de colisão', request_id: requestId },
    );
    expect(result.status).toBe(200);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.['p_request_id']).toBe(requestId);
    expect(attempts[1]?.['p_request_id']).toBe(requestId);
    expect(attempts[1]?.['p_input_hmac']).toBe(attempts[0]?.['p_input_hmac']);
    for (const field of ['p_invite_id', 'p_nonce_hex', 'p_token_digest', 'p_code_digest']) {
      expect(attempts[1]?.[field]).not.toBe(attempts[0]?.[field]);
    }
  });

  it('a página do convite deixa sair só os oito campos, e o id só para membro ativo', async () => {
    const groupId = '26200000-0000-4000-8000-000000000001';
    const extra = { ...page, members: [{ profile_id: groupId }], email: 'x@example.invalid' };
    expect(invitePageProjection(extra)).toEqual(page);
    expect(
      invitePageProjection({ ...page, viewer_status: 'active', group_id: groupId }),
    ).toMatchObject({ viewer_status: 'active', group_id: groupId });
    for (const invalid of [
      null,
      { ...page, group_name: 1 },
      { ...page, member_count: -1 },
      { ...page, member_count: 1.5 },
      { ...page, viewer_status: 'removed' },
      { ...page, refusal: 'GROUP_ARCHIVED' },
      { ...page, group_id: groupId },
      { ...page, viewer_status: 'pending', group_id: groupId },
      { ...page, viewer_status: 'active', group_id: null },
      { ...page, group_icon: undefined },
      { ...page, group_icon: 'rocket' },
      { ...page, group_color: '#FF0000' },
      { ...page, group_color: 'Azul' },
    ]) {
      expect(() => invitePageProjection(invalid)).toThrow();
    }
    const calls: string[] = [];
    const result = await dispatchInvite(
      fake(async (name) => {
        calls.push(name);
        if (name === 'check_and_debit_invite_attempt')
          return {
            data: {
              allowed: true,
              attempt_id: crypto.randomUUID(),
              retry_after: null,
              available_at: null,
            },
          };
        if (name === 'preview_group_by_invite') return { data: { ...page, group_id: groupId } };
        return { data: null };
      }),
      'preview_group_by_invite',
      {
        token:
          'AYkPfulIfFOxOko25LfSHgABICEiIyQlJicoKSorLC0uLwBkiD3y3keHZQjrN7V9NVqjT_0DhN72hp1weI75F-Dy',
      },
    );
    // A malformed page is an internal failure: nothing of it is sent and the
    // attempt is not marked as a success.
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain(groupId);
    expect(calls).toEqual(['check_and_debit_invite_attempt', 'preview_group_by_invite']);
  });
});
