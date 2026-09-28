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
  groups: [
    {
      group_id: 'g',
      group_name: 'Racha da Firma',
      role: 'organizer',
      status: 'removed',
      is_monthly: false,
      joined_at: '2026-02-01T00:00:00.000000Z',
      removed_at: '2026-09-14T04:00:00.000000Z',
      removal_count: 1,
    },
  ],
});

// Bytes exatos de groups.json para a fixture acima: JCS com chaves em ordem
// lexical e quebra de linha final, como toda entrada JSON do colete-export-v1.
const expectedGroupsJson =
  '[{"group_id":"g","group_name":"Racha da Firma","is_monthly":false,' +
  '"joined_at":"2026-02-01T00:00:00.000000Z","removal_count":1,' +
  '"removed_at":"2026-09-14T04:00:00.000000Z","role":"organizer","status":"removed"}]\n';

function storedEntry(zip: Uint8Array, name: string): string {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const entryName = decoder.decode(zip.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength;
    if (entryName === name) return decoder.decode(zip.subarray(start, start + size));
    offset = start + size;
  }
  throw new Error(`entry ${name} not found`);
}

describe('colete-export-v1', () => {
  it('is byte-for-byte deterministic with lexical names and a whole-file digest', async () => {
    const first = await buildDataExport(fixture());
    const second = await buildDataExport(fixture());
    expect(first.bytes).toEqual(second.bytes);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.names).toEqual([
      'auth.json',
      'data-exports.json',
      'groups.json',
      'LEIA-ME.txt',
      'manifest.json',
      'policy-acceptances.json',
      'privacy-requests.json',
      'profile.json',
    ]);
    expect(new TextDecoder().decode(first.bytes)).not.toContain('storage_path');
    expect(new TextDecoder().decode(first.bytes)).not.toContain('content_digest');
  });

  it('writes groups.json byte for byte and lists it in the v1 manifest', async () => {
    const artifact = await buildDataExport(fixture());
    expect(storedEntry(artifact.bytes, 'groups.json')).toBe(expectedGroupsJson);
    const manifest = JSON.parse(storedEntry(artifact.bytes, 'manifest.json'));
    expect(manifest.version).toBe('colete-export-v1');
    expect(manifest.files.map((file: { name: string }) => file.name)).toContain('groups.json');
  });

  it('writes an empty groups.json for a titular without memberships', async () => {
    const snapshot = fixture();
    snapshot.groups = [];
    const artifact = await buildDataExport(snapshot);
    expect(storedEntry(artifact.bytes, 'groups.json')).toBe('[]\n');
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
    [
      'third-party member',
      (bad: ExportSnapshot) => (bad.groups[0]['members'] = [{ profile_id: 'third-party' }]),
      'GROUP',
    ],
    [
      'third-party profile id',
      (bad: ExportSnapshot) => (bad.groups[0]['profile_id'] = 'third-party'),
      'GROUP',
    ],
    [
      'invite digest',
      (bad: ExportSnapshot) => (bad.groups[0]['token_digest'] = 'forbidden'),
      'GROUP',
    ],
    [
      'invite nonce',
      (bad: ExportSnapshot) => (bad.groups[0]['public_nonce'] = 'forbidden'),
      'GROUP',
    ],
    ['invite token', (bad: ExportSnapshot) => (bad.groups[0]['token'] = 'forbidden'), 'GROUP'],
    [
      'group photo locator',
      (bad: ExportSnapshot) => (bad.groups[0]['photo_url'] = 'forbidden'),
      'GROUP',
    ],
    [
      'group owner id',
      (bad: ExportSnapshot) => (bad.groups[0]['owner_id'] = 'third-party'),
      'GROUP',
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

  it('rejects a group row that omits an allowlisted field', () => {
    const bad = fixture();
    delete bad.groups[0]['removal_count'];
    expect(() => validateExportSnapshot(bad)).toThrow('GROUP_ALLOWLIST_VIOLATION');
  });

  it('rejects an unknown top-level category outside the v1 allowlist', () => {
    const bad = fixture() as unknown as Record<string, unknown>;
    bad['group_invites'] = [];
    expect(() => validateExportSnapshot(bad as unknown as ExportSnapshot)).toThrow(
      'EXPORT_ALLOWLIST_VIOLATION',
    );
  });
});
