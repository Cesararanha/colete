import { describe, expect, it } from 'vitest';
import { buildDataExport, validateExportSnapshot } from './data-export.ts';
import type { ExportSnapshot } from './data-export.ts';

const fixture = (): ExportSnapshot => ({
  snapshot_at: '2026-09-14T04:00:00.000000Z',
  profile: {
    id: 'p',
    name: 'Ana',
    nickname: null,
    position: null,
    dominant_foot: null,
    shirt_number: null,
    account_status: 'active',
    created_at: '2026-01-01T00:00:00.000000Z',
  },
  auth: { email: 'ana@example.invalid', providers: ['email'] },
  policy_acceptances: [],
  privacy_requests: [],
  data_exports: [
    {
      id: 'e',
      status: 'building',
      created_at: '2026-09-14T04:00:00.000000Z',
      ready_at: null,
      expires_at: null,
      downloaded_at: null,
      purged_at: null,
    },
  ],
});

describe('colete-export-v1', () => {
  it('is byte-for-byte deterministic with lexical names and a whole-file digest', async () => {
    const first = await buildDataExport(fixture());
    const second = await buildDataExport(fixture());
    expect(first.bytes).toEqual(second.bytes);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.names).toEqual([
      'auth.json',
      'data-exports.json',
      'LEIA-ME.txt',
      'manifest.json',
      'policy-acceptances.json',
      'privacy-requests.json',
      'profile.json',
    ]);
    expect(new TextDecoder().decode(first.bytes)).not.toContain('storage_path');
    expect(new TextDecoder().decode(first.bytes)).not.toContain('content_digest');
  });

  it.each([
    [
      'profile photo URL',
      (bad: ExportSnapshot) => (bad.profile['photo_url'] = 'forbidden'),
      'PROFILE',
    ],
    ['refresh token', (bad: ExportSnapshot) => (bad.auth['refresh_token'] = 'forbidden'), 'AUTH'],
    [
      'Storage path',
      (bad: ExportSnapshot) => (bad.data_exports[0]['storage_path'] = 'forbidden'),
      'DATA_EXPORT',
    ],
    [
      'secret digest',
      (bad: ExportSnapshot) => (bad.data_exports[0]['content_digest'] = 'forbidden'),
      'DATA_EXPORT',
    ],
    [
      'third-party PII',
      (bad: ExportSnapshot) =>
        bad.privacy_requests.push({
          kind: 'access',
          status: 'open',
          response: null,
          opened_at: '2026-09-14T04:00:00.000000Z',
          resolved_at: null,
          third_party_email: 'third-party@example.invalid',
        }),
      'PRIVACY',
    ],
  ])('rejects forbidden %s in the negative allowlist counterproof', (_name, inject, subject) => {
    const bad = fixture();
    inject(bad);
    expect(() => validateExportSnapshot(bad)).toThrow(`${subject}_ALLOWLIST_VIOLATION`);
  });

  it('rejects the privacy-request technical id omitted by the closed allowlist', () => {
    const bad = fixture();
    bad.privacy_requests.push({
      id: 'forbidden',
      kind: 'access',
      status: 'open',
      response: null,
      opened_at: '2026-09-14T04:00:00.000000Z',
      resolved_at: null,
    });
    expect(() => validateExportSnapshot(bad)).toThrow('PRIVACY_ALLOWLIST_VIOLATION');
  });
});
