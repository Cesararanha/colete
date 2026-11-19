import { describe, expect, it, vi } from 'vitest';

import { runOperation } from './gateway.ts';
import type { RpcCaller } from './gateway.ts';
import { dispatchPixRead } from './pix-reads.ts';
import {
  normalisePix,
  normalisePixKey,
  normaliseReceiverText,
  pixKeyFromEnvironment,
  pixOpener,
  pixSealer,
} from './pix.ts';

const REQUEST_ID = '01890f7e-e948-7c53-b13a-4a36e4b7d21e';
const ACTOR = {
  authUserId: '5f0d9f1e-6a2e-4d2b-8c3a-1a2b3c4d5e6f',
  sessionId: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
};
const MATCH = '15c00003-0000-4000-8000-000000000000';
const OTHER_MATCH = '15c00004-0000-4000-8000-000000000000';
const RAW_KEY = Uint8Array.from({ length: 32 }, (_, byte) => byte + 32);
const resolveKey = () => new Uint8Array(32);
// A fixture key with a rare sequence, never a real person's data.
const EMAIL = 'pix.fixture.qzx7@exemplo.com';
const PIX = { type: 'email', key: EMAIL, receiver_name: 'Ana Souza', receiver_city: 'Maceió' };

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function hex(text: string): string {
  return [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

describe('Pix key validation', () => {
  it('accepts a valid CPF with punctuation and refuses a wrong check digit', () => {
    expect(normalisePixKey('cpf', '529.982.247-25')).toBe('52998224725');
    expect(() => normalisePixKey('cpf', '529.982.247-24')).toThrow();
    expect(() => normalisePixKey('cpf', '111.111.111-11')).toThrow();
  });

  it('accepts numeric and alphanumeric CNPJ and refuses a wrong check digit', () => {
    expect(normalisePixKey('cnpj', '11.222.333/0001-81')).toBe('11222333000181');
    expect(() => normalisePixKey('cnpj', '11.222.333/0001-82')).toThrow();
    // Example of the alphanumeric format published by the Receita Federal.
    expect(normalisePixKey('cnpj', '12.ABC.345/01DE-35')).toBe('12ABC34501DE35');
    expect(() => normalisePixKey('cnpj', '12.ABC.345/01DE-36')).toThrow();
  });

  it('normalises mobile phones to +55 and refuses landlines, short or foreign numbers', () => {
    expect(normalisePixKey('phone', '(82) 99876-5432')).toBe('+5582998765432');
    expect(normalisePixKey('phone', '+55 82 99876-5432')).toBe('+5582998765432');
    expect(() => normalisePixKey('phone', '+55 82 3214-5678')).toThrow();
    expect(() => normalisePixKey('phone', '(82) 3214-5678')).toThrow();
    expect(() => normalisePixKey('phone', '99876-5432')).toThrow();
    expect(() => normalisePixKey('phone', '+1 415 555 0100')).toThrow();
  });

  it('lowercases e-mail, limits it to 77 characters and checks the random key', () => {
    expect(normalisePixKey('email', ' Pix.Fixture@Exemplo.COM ')).toBe('pix.fixture@exemplo.com');
    expect(() => normalisePixKey('email', `${'a'.repeat(66)}@exemplo.com`)).toThrow();
    expect(normalisePixKey('email', `${'a'.repeat(65)}@exemplo.com`)).toHaveLength(77);
    expect(normalisePixKey('random', '123E4567-E89B-12D3-A456-426614174000')).toBe(
      '123e4567-e89b-12d3-a456-426614174000',
    );
    expect(() => normalisePixKey('random', 'not-a-uuid')).toThrow();
  });

  it('never echoes the refused value in the validation error', () => {
    try {
      normalisePixKey('cpf', '529.982.247-24');
      throw new Error('accepted');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('52998224724');
      expect(String((error as Error).message)).not.toContain('52998224724');
    }
  });

  it('strips accents and symbols from name and city and cuts after normalising', () => {
    expect(normaliseReceiverText('  José  da Conceição ', 25, 'n')).toBe('JOSE DA CONCEICAO');
    expect(normaliseReceiverText('Maceió', 15, 'c')).toBe('MACEIO');
    expect(normaliseReceiverText('São José dos Campos', 15, 'c')).toBe('SAO JOSE DOS CA');
    expect(normaliseReceiverText('Ana - Pagamentos!!', 25, 'n')).toBe('ANA PAGAMENTOS');
    expect(() => normaliseReceiverText('!!!', 25, 'n')).toThrow();
  });

  it('refuses unknown keys and accepts null as removal', () => {
    expect(normalisePix(null)).toBeNull();
    expect(() => normalisePix({ ...PIX, extra: 'x' })).toThrow();
    expect(() => normalisePix({ ...PIX, type: 'iban' })).toThrow();
  });
});

describe('Pix sealing', () => {
  it('seals with a fresh nonce: same key, different ciphertexts, nonce + text + tag', async () => {
    const pix = normalisePix(PIX)!;
    const first = await pixSealer(RAW_KEY)(pix, MATCH);
    const second = await pixSealer(RAW_KEY)(pix, MATCH);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(fromBase64(first.ciphertext).length).toBe(
      12 + new TextEncoder().encode(EMAIL).length + 16,
    );
    expect(first.last4).toBe('.com');
    expect(first.ciphertext).not.toContain('fixture');
    expect(await pixOpener(RAW_KEY)('email', first.ciphertext, 1, MATCH)).toBe(EMAIL);
  });

  it('refuses a tampered tag, another match and another type', async () => {
    const sealed = await pixSealer(RAW_KEY)(normalisePix(PIX)!, MATCH);
    const bytes = fromBase64(sealed.ciphertext);
    bytes[bytes.length - 1] ^= 1;
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(pixOpener(RAW_KEY)('email', tampered, 1, MATCH)).rejects.toThrow();
    await expect(pixOpener(RAW_KEY)('email', sealed.ciphertext, 1, OTHER_MATCH)).rejects.toThrow();
    await expect(pixOpener(RAW_KEY)('random', sealed.ciphertext, 1, MATCH)).rejects.toThrow();
    await expect(pixOpener(RAW_KEY)('email', sealed.ciphertext, 2, MATCH)).rejects.toThrow();
  });

  it('reads exactly 32 base64url bytes from the environment', () => {
    const encoded = base64Url(RAW_KEY);
    expect(pixKeyFromEnvironment(() => encoded)).toEqual(RAW_KEY);
    expect(() => pixKeyFromEnvironment(() => undefined)).toThrow();
    expect(() => pixKeyFromEnvironment(() => base64Url(new Uint8Array(16)))).toThrow();
  });
});

describe('set_match_pix through the gateway', () => {
  const body = { request_id: REQUEST_ID, match_id: MATCH, pix: PIX };

  it('computes the HMAC over the open form, so a retry keeps the same hash', async () => {
    const callRpc = vi.fn<RpcCaller>(async () => ({ data: { outcome: {} } }));
    const deps = { resolveKey, callRpc, sealPix: () => pixSealer(RAW_KEY) };
    await runOperation(deps, 'set_match_pix', body, ACTOR);
    await runOperation(deps, 'set_match_pix', body, ACTOR);
    const [first, second] = callRpc.mock.calls.map(([, params]) => params);
    expect(first?.['p_input_hmac']).toBe(second?.['p_input_hmac']);
    // The two sealed forms differ: had the HMAC covered them, a retry would conflict.
    expect((first?.['p_pix'] as { ciphertext: string }).ciphertext).not.toBe(
      (second?.['p_pix'] as { ciphertext: string }).ciphertext,
    );
  });

  it('gives another key with the same request a different HMAC', async () => {
    const callRpc = vi.fn<RpcCaller>(async () => ({ data: { outcome: {} } }));
    const deps = { resolveKey, callRpc, sealPix: () => pixSealer(RAW_KEY) };
    await runOperation(deps, 'set_match_pix', body, ACTOR);
    await runOperation(
      deps,
      'set_match_pix',
      { ...body, pix: { ...PIX, key: 'outro.fixture.qzx7@exemplo.com' } },
      ACTOR,
    );
    const [first, second] = callRpc.mock.calls.map(([, params]) => params);
    expect(first?.['p_input_hmac']).not.toBe(second?.['p_input_hmac']);
  });

  it('never sends the open key to the RPC', async () => {
    const callRpc = vi.fn<RpcCaller>(async () => ({ data: { outcome: {} } }));
    await runOperation(
      { resolveKey, callRpc, sealPix: () => pixSealer(RAW_KEY) },
      'set_match_pix',
      body,
      ACTOR,
    );
    const sent = JSON.stringify(callRpc.mock.calls[0]?.[1]);
    expect(sent).not.toContain('fixture');
    expect(sent).not.toContain(hex(EMAIL));
    expect(sent).not.toContain(btoa(EMAIL));
    expect(Object.keys(callRpc.mock.calls[0]?.[1]?.['p_pix'] as object).sort()).toEqual([
      'ciphertext',
      'key_version',
      'last4',
      'receiver_city',
      'receiver_name',
      'type',
    ]);
  });

  it('fails with INTERNAL before the RPC when the secret is missing', async () => {
    const callRpc = vi.fn<RpcCaller>(async () => ({ data: { outcome: {} } }));
    const result = await runOperation(
      { resolveKey, callRpc, sealPix: () => pixSealer(pixKeyFromEnvironment(() => undefined)) },
      'set_match_pix',
      body,
      ACTOR,
    );
    expect(result.status).toBe(500);
    expect(callRpc).not.toHaveBeenCalled();
  });

  it('removes without needing the secret', async () => {
    const callRpc = vi.fn<RpcCaller>(async () => ({ data: { outcome: {} } }));
    const result = await runOperation(
      { resolveKey, callRpc },
      'set_match_pix',
      { ...body, pix: null },
      ACTOR,
    );
    expect(result.status).toBe(200);
    expect(callRpc.mock.calls[0]?.[1]?.['p_pix']).toBeNull();
  });
});

describe('get_payment_instructions through the gateway', () => {
  it('opens the key and returns no ciphertext', async () => {
    const sealed = await pixSealer(RAW_KEY)(normalisePix(PIX)!, MATCH);
    const callRpc = vi.fn(async () => ({
      data: {
        type: 'email',
        ciphertext: sealed.ciphertext,
        key_version: 1,
        receiver_name: 'ANA SOUZA',
        receiver_city: 'MACEIO',
        amount: '25.00',
        set_by_name: 'Ana',
        set_at: '2026-11-07T20:00:00+00:00',
        replaced: false,
      },
    }));
    const result = await dispatchPixRead(
      { actor: ACTOR, callRpc, openPix: () => pixOpener(RAW_KEY) },
      'get_payment_instructions',
      { match_id: MATCH },
    );
    expect(result.status).toBe(200);
    const data = (result.body as { data: Record<string, unknown> }).data;
    expect(data['key']).toBe(EMAIL);
    expect(JSON.stringify(result.body)).not.toContain(sealed.ciphertext);
  });

  it('answers INTERNAL without detail when the ciphertext does not open', async () => {
    const sealed = await pixSealer(RAW_KEY)(normalisePix(PIX)!, OTHER_MATCH);
    const callRpc = vi.fn(async () => ({
      data: {
        type: 'email',
        ciphertext: sealed.ciphertext,
        key_version: 1,
        receiver_name: 'ANA SOUZA',
        receiver_city: 'MACEIO',
        amount: '25.00',
        set_by_name: null,
        set_at: '2026-11-07T20:00:00+00:00',
        replaced: false,
      },
    }));
    const result = await dispatchPixRead(
      { actor: ACTOR, callRpc, openPix: () => pixOpener(RAW_KEY) },
      'get_payment_instructions',
      { match_id: MATCH },
    );
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain(sealed.ciphertext);
  });

  it('maps PIX_NOT_CONFIGURED to 404 and FORBIDDEN to 403', async () => {
    for (const [code, status] of [
      ['PIX_NOT_CONFIGURED', 404],
      ['FORBIDDEN', 403],
    ] as const) {
      const result = await dispatchPixRead(
        {
          actor: ACTOR,
          callRpc: async () => ({ error: { message: code } }),
          openPix: () => pixOpener(RAW_KEY),
        },
        'get_payment_instructions',
        { match_id: MATCH },
      );
      expect(result.status).toBe(status);
    }
  });
});
