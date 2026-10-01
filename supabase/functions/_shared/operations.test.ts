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

describe('group membership operations (docs/13 section 5, docs/25 section 4)', () => {
  const GROUP = '15b00001-0000-4000-8000-000000000000';
  const TARGET = '15a00002-0000-4000-8000-000000000000';

  it('accepts profile_id as the enumerated target, never as the caller', () => {
    const normalised = normaliseRequest('approve_member', {
      request_id: REQUEST_ID,
      group_id: GROUP,
      profile_id: TARGET,
      approve: true,
    });
    expect(canonicalise(normalised.canonicalInput)).toBe(
      `{"approve":true,"group_id":"${GROUP}","profile_id":"${TARGET}"}`,
    );
    // leave_group has no target: profile_id there is still an internal name.
    expect(
      refusal(() =>
        normaliseRequest('leave_group', {
          request_id: REQUEST_ID,
          group_id: GROUP,
          profile_id: TARGET,
        }),
      ).fields?.['profile_id'],
    ).toContain('internal call');
  });

  it('lowercases a business UUID and refuses a malformed one', () => {
    const normalised = normaliseRequest('leave_group', {
      request_id: REQUEST_ID,
      group_id: GROUP.toUpperCase(),
    });
    expect(normalised.canonicalInput).toEqual({ group_id: GROUP });
    expect(
      refusal(() => normaliseRequest('leave_group', { request_id: REQUEST_ID, group_id: 'g1' }))
        .code,
    ).toBe('VALIDATION');
  });

  it('requires every business field and refuses loose types', () => {
    const cases: Array<[Parameters<typeof normaliseRequest>[0], Record<string, unknown>]> = [
      ['approve_member', { group_id: GROUP, profile_id: TARGET }],
      ['approve_member', { group_id: GROUP, profile_id: TARGET, approve: 'true' }],
      ['set_role', { group_id: GROUP, profile_id: TARGET, role: 'owner' }],
      ['set_monthly', { group_id: GROUP, profile_id: TARGET, enabled: 1 }],
      ['set_ratings_visibility', { group_id: GROUP, visibility: 'members' }],
      [
        'set_ratings_visibility',
        { group_id: GROUP, visibility: 'public', confirm_members_visibility: true },
      ],
      ['transfer_ownership', { group_id: GROUP }],
      ['remove_member', { group_id: GROUP, profile_id: TARGET }],
    ];
    for (const [operation, fields] of cases) {
      expect(
        refusal(() => normaliseRequest(operation, { request_id: REQUEST_ID, ...fields })).code,
      ).toBe('VALIDATION');
    }
  });

  it('M2-D18: the reason is required, trimmed, at most 500 characters and never echoed', () => {
    const marker = 'motivo-privado-M2D18';
    const trimmed = normaliseRequest('remove_member', {
      request_id: REQUEST_ID,
      group_id: GROUP,
      profile_id: TARGET,
      reason: `  ${marker}  `,
    });
    expect(trimmed.canonicalInput['reason']).toBe(marker);
    const astral = '\u{1F3C6}'.repeat(500);
    expect(
      normaliseRequest('remove_member', {
        request_id: REQUEST_ID,
        group_id: GROUP,
        profile_id: TARGET,
        reason: astral,
      }).canonicalInput['reason'],
    ).toBe(astral);
    for (const reason of ['', '   ', `${marker}${'x'.repeat(500)}`, null, 7]) {
      const error = refusal(() =>
        normaliseRequest('remove_member', {
          request_id: REQUEST_ID,
          group_id: GROUP,
          profile_id: TARGET,
          reason,
        }),
      );
      expect(error.code).toBe('VALIDATION');
      expect(JSON.stringify({ message: error.message, fields: error.fields })).not.toContain(
        marker,
      );
    }
  });
});

describe('rename_group uses the creation name rule', () => {
  const groupId = '15b00001-0000-4000-8000-000000000000';
  it('fingerprints equivalent NFC and Unicode spacing identically', () => {
    const first = normaliseRequest('rename_group', {
      request_id: REQUEST_ID,
      group_id: groupId,
      name: '  Cafe\u0301　da　Turma  ',
    });
    const second = normaliseRequest('rename_group', {
      request_id: REQUEST_ID,
      group_id: groupId,
      name: 'Café da Turma',
    });
    expect(first.canonicalInput).toEqual(second.canonicalInput);
  });
  it('refuses controls and out-of-range names before idempotency', () => {
    for (const name of ['X\u200bY', 'Um\nNome', 'A', 'x'.repeat(41)]) {
      expect(
        refusal(() =>
          normaliseRequest('rename_group', {
            request_id: REQUEST_ID,
            group_id: groupId,
            name,
          }),
        ).code,
      ).toBe('VALIDATION');
    }
  });
});
