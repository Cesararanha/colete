import { describe, expect, it } from 'vitest';

import { GROUP_COLORS, GROUP_ICONS, GatewayError, normaliseRequest } from './operations.ts';
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

describe('set_group_appearance takes only the listed keys (docs/13 section 5.0.7)', () => {
  const groupId = '15b00001-0000-4000-8000-000000000000';
  it('signs the lowercased group and the exact icon and colour keys', () => {
    const normalised = normaliseRequest('set_group_appearance', {
      request_id: REQUEST_ID,
      group_id: groupId.toUpperCase(),
      icon: 'flame',
      color: 'sand',
    });
    expect(normalised.canonicalInput).toEqual({ group_id: groupId, icon: 'flame', color: 'sand' });
  });
  it('accepts every key of the two lists', () => {
    for (const icon of GROUP_ICONS) {
      for (const color of GROUP_COLORS) {
        expect(() =>
          normaliseRequest('set_group_appearance', {
            request_id: REQUEST_ID,
            group_id: groupId,
            icon,
            color,
          }),
        ).not.toThrow();
      }
    }
    expect(GROUP_ICONS).toHaveLength(8);
    expect(GROUP_COLORS).toHaveLength(6);
  });
  it('refuses labels, other spellings, absence and extra keys before idempotency', () => {
    const bodies: Record<string, unknown>[] = [
      { icon: 'Bola', color: 'blue' },
      { icon: 'BALL', color: 'blue' },
      { icon: 'ball', color: '#9DB6FF' },
      { icon: 'ball', color: 'Azul' },
      { icon: 'rocket', color: 'blue' },
      { icon: null, color: 'blue' },
      { color: 'blue' },
      { icon: 'ball' },
      { icon: 'ball', color: 'blue', name: 'Outro nome' },
      { icon: 'ball', color: 'blue', profile_id: groupId },
    ];
    for (const body of bodies) {
      expect(
        refusal(() =>
          normaliseRequest('set_group_appearance', {
            request_id: REQUEST_ID,
            group_id: groupId,
            ...body,
          }),
        ).code,
      ).toBe('VALIDATION');
    }
  });
});

describe('racha completo operations (docs/25 section 8.1)', () => {
  const matchId = '15c00003-0000-4000-8000-000000000000';
  const target = '15a00002-0000-4000-8000-000000000000';

  it('join_match and leave_match sign only the lowercased match_id', () => {
    for (const operation of ['join_match', 'leave_match'] as const) {
      const normalised = normaliseRequest(operation, {
        request_id: REQUEST_ID,
        match_id: matchId.toUpperCase(),
      });
      expect(normalised.canonicalInput).toEqual({ match_id: matchId });
    }
  });

  it('never accepts an actor, a list kind or a position from the client', () => {
    for (const extra of ['profile_id', 'list_kind', 'status', 'queue_seq']) {
      expect(
        refusal(() =>
          normaliseRequest('join_match', {
            request_id: REQUEST_ID,
            match_id: matchId,
            [extra]: target,
          }),
        ).code,
      ).toBe('VALIDATION');
    }
  });

  it('set_match_payment takes the confirmed target and a boolean, never an amount', () => {
    expect(
      normaliseRequest('set_match_payment', {
        request_id: REQUEST_ID,
        match_id: matchId,
        profile_id: target,
        paid: false,
      }).canonicalInput,
    ).toEqual({ match_id: matchId, profile_id: target, paid: false });
    for (const body of [
      { match_id: matchId, profile_id: target, paid: 'true' },
      { match_id: matchId, profile_id: target },
      { match_id: matchId, profile_id: target, paid: true, amount: '25.00' },
      { match_id: matchId, profile_id: 'nope', paid: true },
    ]) {
      expect(
        refusal(() => normaliseRequest('set_match_payment', { request_id: REQUEST_ID, ...body }))
          .code,
      ).toBe('VALIDATION');
    }
  });
});

describe('editar e cancelar racha (docs/25 section 8.1, 0028)', () => {
  const matchId = '15c00003-0000-4000-8000-000000000000';
  // A start three days ahead at minute precision, inside the 365-day window.
  const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 3 * 86_400_000);
  const config = {
    description: null,
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 5_400_000).toISOString(),
    timezone: 'America/Sao_Paulo',
    location_name: 'Arena Vila',
    location_address: null,
    latitude: null,
    longitude: null,
    field_slots: 14,
    field_price: '25.00',
  };

  it('cancel_match signs only the lowercased match_id, with no reason or note', () => {
    expect(
      normaliseRequest('cancel_match', { request_id: REQUEST_ID, match_id: matchId.toUpperCase() })
        .canonicalInput,
    ).toEqual({ match_id: matchId });
    for (const extra of ['reason_code', 'note', 'group_id', 'profile_id']) {
      expect(
        refusal(() =>
          normaliseRequest('cancel_match', {
            request_id: REQUEST_ID,
            match_id: matchId,
            [extra]: 'x',
          }),
        ).code,
      ).toBe('VALIDATION');
    }
  });

  it('update_match signs the match and the whole config, never the group', () => {
    expect(
      normaliseRequest('update_match', { request_id: REQUEST_ID, match_id: matchId, config })
        .canonicalInput,
    ).toEqual({ match_id: matchId, config });
    for (const body of [
      { match_id: matchId },
      { match_id: matchId, config, group_id: '15b00001-0000-4000-8000-000000000000' },
      { match_id: 'nope', config },
      { match_id: matchId, config: { ...config, field_slots: 0 } },
      { match_id: matchId, config: { ...config, canceled: true } },
    ]) {
      expect(
        refusal(() => normaliseRequest('update_match', { request_id: REQUEST_ID, ...body })).code,
      ).toBe('VALIDATION');
    }
  });

  it('update_match leaves a start already gone to the database, but not the order', () => {
    // A match in progress keeps its start; only the database knows it is unchanged.
    const started = {
      ...config,
      starts_at: '2020-01-02T22:00:00.000Z',
      ends_at: '2020-01-02T23:30:00.000Z',
    };
    expect(
      normaliseRequest('update_match', {
        request_id: REQUEST_ID,
        match_id: matchId,
        config: started,
      }).canonicalInput,
    ).toEqual({ match_id: matchId, config: started });
    expect(
      refusal(() =>
        normaliseRequest('update_match', {
          request_id: REQUEST_ID,
          match_id: matchId,
          config: { ...config, ends_at: config.starts_at },
        }),
      ).code,
    ).toBe('TIME_ORDER');
    expect(
      refusal(() =>
        normaliseRequest('create_match', {
          request_id: REQUEST_ID,
          group_id: '15b00001-0000-4000-8000-000000000000',
          config: started,
        }),
      ).code,
    ).toBe('TIME_ORDER');
  });
});

describe('delete_group (docs/13 section 5.0.8, 0029)', () => {
  const groupId = '15b00001-0000-4000-8000-000000000000';

  it('signs only the lowercased group: the typed name never travels', () => {
    expect(
      normaliseRequest('delete_group', { request_id: REQUEST_ID, group_id: groupId.toUpperCase() })
        .canonicalInput,
    ).toEqual({ group_id: groupId });
    for (const extra of ['name', 'confirmation', 'reason', 'owner_id']) {
      expect(
        refusal(() =>
          normaliseRequest('delete_group', {
            request_id: REQUEST_ID,
            group_id: groupId,
            [extra]: 'x',
          }),
        ).code,
      ).toBe('VALIDATION');
    }
    for (const body of [{}, { group_id: 'nope' }, { group_id: null }]) {
      expect(
        refusal(() => normaliseRequest('delete_group', { request_id: REQUEST_ID, ...body })).code,
      ).toBe('VALIDATION');
    }
  });

  it('refuses an actor supplied by the client, by name', () => {
    for (const internal of ['profile_id', 'actor_auth_user_id', 'input_hmac']) {
      const thrown = refusal(() =>
        normaliseRequest('delete_group', {
          request_id: REQUEST_ID,
          group_id: groupId,
          [internal]: 'x',
        }),
      );
      expect(thrown.fields?.[internal]).toBe(
        'belongs to the internal call and is never accepted from a client',
      );
    }
  });
});

describe('set_rating (docs/13 section 4.1.2, 0031)', () => {
  const groupId = '15b00001-0000-4000-8000-000000000000';
  const target = '15a00002-0000-4000-8000-000000000000';

  it('signs the lowercased group, the rated member and the stars', () => {
    for (const stars of [1, 3, 5]) {
      expect(
        normaliseRequest('set_rating', {
          request_id: REQUEST_ID,
          group_id: groupId.toUpperCase(),
          profile_id: target.toUpperCase(),
          stars,
        }).canonicalInput,
      ).toEqual({ group_id: groupId, profile_id: target, stars });
    }
  });

  it('answers an integer outside 1-5 with STARS_RANGE and anything else with VALIDATION', () => {
    for (const stars of [0, 6, -1]) {
      expect(
        refusal(() =>
          normaliseRequest('set_rating', {
            request_id: REQUEST_ID,
            group_id: groupId,
            profile_id: target,
            stars,
          }),
        ).code,
      ).toBe('STARS_RANGE');
    }
    for (const body of [
      { group_id: groupId, profile_id: target, stars: 3.5 },
      { group_id: groupId, profile_id: target, stars: '4' },
      { group_id: groupId, profile_id: target, stars: null },
      { group_id: groupId, profile_id: target },
      { group_id: groupId, stars: 4 },
      { group_id: groupId, profile_id: target, stars: 4, old_stars: 3 },
      { group_id: groupId, profile_id: target, stars: 4, actor_auth_user_id: target },
    ]) {
      expect(
        refusal(() => normaliseRequest('set_rating', { request_id: REQUEST_ID, ...body })).code,
      ).toBe('VALIDATION');
    }
  });
});

describe('draw_teams (docs/13 section 4.4, 0032)', () => {
  const matchId = '15c00003-0000-4000-8000-000000000000';

  it('signs only the lowercased match, the number of teams and the confirmation', () => {
    for (const teamCount of [2, 3, 4]) {
      for (const confirm of [true, false]) {
        expect(
          normaliseRequest('draw_teams', {
            request_id: REQUEST_ID,
            match_id: matchId.toUpperCase(),
            team_count: teamCount,
            confirm_unequal_sizes: confirm,
          }).canonicalInput,
        ).toEqual({ match_id: matchId, team_count: teamCount, confirm_unequal_sizes: confirm });
      }
    }
  });

  it('refuses any other number of teams, a missing confirmation or a list of players', () => {
    const base = { match_id: matchId, team_count: 2, confirm_unequal_sizes: false };
    for (const body of [
      { match_id: matchId, confirm_unequal_sizes: false },
      { ...base, team_count: 1 },
      { ...base, team_count: 5 },
      { ...base, team_count: 2.5 },
      { ...base, team_count: '2' },
      { match_id: matchId, team_count: 2 },
      { ...base, confirm_unequal_sizes: 'yes' },
      { ...base, match_id: 'nope' },
      { ...base, teams: [] },
      { ...base, ratings: {} },
      { ...base, seed: 'x' },
    ]) {
      expect(
        refusal(() => normaliseRequest('draw_teams', { request_id: REQUEST_ID, ...body })).code,
      ).toBe('VALIDATION');
    }
  });

  it('refuses an actor supplied by the client, by name', () => {
    for (const internal of ['profile_id', 'actor_auth_user_id', 'input_hmac']) {
      const thrown = refusal(() =>
        normaliseRequest('draw_teams', {
          request_id: REQUEST_ID,
          match_id: matchId,
          team_count: 2,
          confirm_unequal_sizes: false,
          [internal]: 'x',
        }),
      );
      expect(thrown.fields?.[internal]).toBe(
        'belongs to the internal call and is never accepted from a client',
      );
    }
  });
});

describe('refund transport (0034)', () => {
  const match_id = '01890f7e-e948-4c53-b13a-4a36e4b7d21e';
  const refund_id = '01890f7e-e948-4c53-b13a-4a36e4b7d21f';
  it('omits an absent date from the signed input', () => {
    expect(
      normaliseRequest('mark_refunded', { request_id: REQUEST_ID, match_id, refund_id })
        .canonicalInput,
    ).toEqual({ match_id, refund_id });
  });
  it('signs the exact date and lowercased resource IDs', () => {
    expect(
      normaliseRequest('mark_refunded', {
        request_id: REQUEST_ID,
        match_id: match_id.toUpperCase(),
        refund_id,
        refunded_at: '2026-11-06T12:00:00.123Z',
      }).canonicalInput,
    ).toEqual({ match_id, refund_id, refunded_at: '2026-11-06T12:00:00.123Z' });
  });
  it.each(['2026-11-31T12:00:00.000Z', '2026-11-06', 'invalid', null])(
    'rejects malformed refund instants: %s',
    (refunded_at) => {
      for (const operation of ['mark_refunded', 'correct_refund'] as const) {
        expect(() =>
          normaliseRequest(operation, {
            request_id: REQUEST_ID,
            match_id,
            refund_id,
            [operation === 'mark_refunded' ? 'refunded_at' : 'corrected_at']: refunded_at,
          }),
        ).toThrow();
      }
    },
  );
  it.each(['reference', 'amount', 'actor_id'])('rejects fields outside the cut: %s', (field) => {
    expect(() =>
      normaliseRequest('mark_refunded', {
        request_id: REQUEST_ID,
        match_id,
        refund_id,
        refunded_at: '2026-11-06T12:00:00.123Z',
        [field]: 'private',
      }),
    ).toThrow();
  });
});

describe('refund correction preserves its own signed date', () => {
  const match_id = '01890f7e-e948-4c53-b13a-4a36e4b7d21e';
  const refund_id = '01890f7e-e948-4c53-b13a-4a36e4b7d21f';
  it('omits an absent corrected_at and rejects an attempt to change the amount', () => {
    expect(
      normaliseRequest('correct_refund', { request_id: REQUEST_ID, match_id, refund_id })
        .canonicalInput,
    ).toEqual({ match_id, refund_id });
    expect(() =>
      normaliseRequest('correct_refund', {
        request_id: REQUEST_ID,
        match_id,
        refund_id,
        corrected_at: '2026-11-06T12:00:00.000Z',
        amount: '100.00',
      }),
    ).toThrow();
  });
});

describe('pilot organizer player management', () => {
  for (const operation of ['add_player', 'remove_player'] as const) {
    it(`${operation} signs only the canonical match and target; refuses obsolete or internal fields`, () => {
      const match = '01890f7e-e948-7c53-b13a-4a36e4b7d21e';
      const target = '01890f7e-e948-7c53-b13a-4a36e4b7d21f';
      const body = {
        request_id: REQUEST_ID,
        match_id: match.toUpperCase(),
        profile_id: target.toUpperCase(),
      };
      expect(normaliseRequest(operation, body).canonicalInput).toEqual({
        match_id: match,
        profile_id: target,
      });
      for (const key of ['reason', 'list_kind', 'paid', 'actor_auth_user_id', 'input_hmac']) {
        expect(
          refusal(() => normaliseRequest(operation, { ...body, [key]: 'injected' })).code,
        ).toBe('VALIDATION');
      }
      for (const key of ['match_id', 'profile_id']) {
        expect(refusal(() => normaliseRequest(operation, { ...body, [key]: null })).code).toBe(
          'VALIDATION',
        );
      }
    });
  }
});
