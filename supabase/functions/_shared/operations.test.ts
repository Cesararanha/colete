import { describe, expect, it } from 'vitest';

import { GatewayError, normaliseRequest } from './operations.ts';
import { canonicalise } from './jcs.ts';

const REQUEST_ID = '01890f7e-e948-7c53-b13a-4a36e4b7d21e';

function refusal(run: () => unknown): GatewayError {
  try {
    run();
  } catch (thrown) {
    return thrown as GatewayError;
  }
  throw new Error('expected a refusal');
}

describe('the external boundary', () => {
  it('refuses what belongs only to the internal call, by name', () => {
    for (const key of [
      'input_hmac',
      'hash_key_version',
      'canonical_version',
      'auth_user_id',
      'actor_auth_user_id',
      'session_id',
      'profile_id',
    ]) {
      const error = refusal(() =>
        normaliseRequest('update_profile', {
          request_id: REQUEST_ID,
          patch: {},
          [key]: 'anything',
        }),
      );
      expect(error.code).toBe('VALIDATION');
      expect(error.fields?.[key]).toContain('internal call');
    }
  });

  it('refuses an unknown key', () => {
    const error = refusal(() =>
      normaliseRequest('update_profile', { request_id: REQUEST_ID, patch: {}, extra: 1 }),
    );
    expect(error.fields?.['extra']).toBe('unknown key');
  });

  it('requires a canonical lowercase request_id', () => {
    expect(refusal(() => normaliseRequest('revoke_current_session', {})).code).toBe('VALIDATION');
    expect(
      refusal(() =>
        normaliseRequest('revoke_current_session', {
          request_id: REQUEST_ID.toUpperCase(),
        }),
      ).code,
    ).toBe('VALIDATION');
  });

  it('never lets request_id into the canonical input', () => {
    const normalised = normaliseRequest('revoke_current_session', {
      request_id: REQUEST_ID,
    });
    // docs/13 section 5.5: the canonical input of a revocation is the empty
    // object. The actor and the request id are not part of what is signed.
    expect(canonicalise(normalised.canonicalInput)).toBe('{}');
  });

  it('accepts deletion with only request_id and signs an empty business input', () => {
    const normalised = normaliseRequest('delete_account', { request_id: REQUEST_ID });
    expect(canonicalise(normalised.canonicalInput)).toBe('{}');
    expect(
      refusal(() =>
        normaliseRequest('delete_account', { request_id: REQUEST_ID, reason: 'private' }),
      ).fields?.['reason'],
    ).toBe('unknown key');
  });
});

describe('profile field normalisation', () => {
  it('normalises to NFC and trims, then measures', () => {
    const decomposed = 'Jose\u0301 Silva';
    const normalised = normaliseRequest('complete_profile', {
      request_id: REQUEST_ID,
      profile: { name: `  ${decomposed}  ` },
    });
    const profile = normalised.canonicalInput['profile'] as Record<string, unknown>;
    expect(profile['name']).toBe('Jos\u00e9 Silva');
    expect((profile['name'] as string).length).toBe(10);
  });

  it('keeps absence and explicit null apart all the way to the canonical form', () => {
    const absent = normaliseRequest('update_profile', {
      request_id: REQUEST_ID,
      patch: { name: 'Ana' },
    });
    const explicit = normaliseRequest('update_profile', {
      request_id: REQUEST_ID,
      patch: { name: 'Ana', nickname: null },
    });
    expect(canonicalise(absent.canonicalInput)).toBe('{"patch":{"name":"Ana"}}');
    expect(canonicalise(explicit.canonicalInput)).toBe('{"patch":{"name":"Ana","nickname":null}}');
  });

  it('refuses a blank optional string instead of turning it into null', () => {
    expect(
      refusal(() =>
        normaliseRequest('update_profile', {
          request_id: REQUEST_ID,
          patch: { nickname: '   ' },
        }),
      ).code,
    ).toBe('VALIDATION');
  });

  it('applies the documented field rules', () => {
    const bad: Array<Record<string, unknown>> = [
      { name: 'A' },
      { name: 'x'.repeat(81) },
      { name: null },
      { position: 'striker' },
      { dominant_foot: 'either' },
      { shirt_number: 100 },
      { shirt_number: -1 },
      { shirt_number: 1.5 },
      { photo_url: 'https://example.test/a.png' },
    ];
    for (const patch of bad) {
      expect(
        refusal(() => normaliseRequest('update_profile', { request_id: REQUEST_ID, patch })).code,
      ).toBe('VALIDATION');
    }
  });

  it('requires a name to create a profile but not to edit one', () => {
    expect(
      refusal(() => normaliseRequest('complete_profile', { request_id: REQUEST_ID, profile: {} }))
        .code,
    ).toBe('VALIDATION');
    expect(() =>
      normaliseRequest('update_profile', { request_id: REQUEST_ID, patch: {} }),
    ).not.toThrow();
  });
});

describe('accept_policies', () => {
  it('orders the set-like array, so either order signs the same', () => {
    const forward = normaliseRequest('accept_policies', {
      request_id: REQUEST_ID,
      versions: [
        { document_type: 'terms', version: '2026-08-01' },
        { document_type: 'privacy', version: '2026-08-01' },
      ],
    });
    const reversed = normaliseRequest('accept_policies', {
      request_id: REQUEST_ID,
      versions: [
        { document_type: 'privacy', version: '2026-08-01' },
        { document_type: 'terms', version: '2026-08-01' },
      ],
    });
    expect(canonicalise(forward.canonicalInput)).toBe(canonicalise(reversed.canonicalInput));
    expect(canonicalise(forward.canonicalInput)).toBe(
      '{"versions":[{"document_type":"privacy","version":"2026-08-01"},' +
        '{"document_type":"terms","version":"2026-08-01"}]}',
    );
  });

  it('refuses an empty list, a repeat and an unknown document type', () => {
    const cases: unknown[] = [
      [],
      [
        { document_type: 'terms', version: '1' },
        { document_type: 'terms', version: '1' },
      ],
      [{ document_type: 'cookies', version: '1' }],
      [{ document_type: 'terms' }],
      [{ document_type: 'terms', version: '1', source: 'signup' }],
    ];
    for (const versions of cases) {
      expect(
        refusal(() => normaliseRequest('accept_policies', { request_id: REQUEST_ID, versions }))
          .code,
      ).toBe('VALIDATION');
    }
  });
});
