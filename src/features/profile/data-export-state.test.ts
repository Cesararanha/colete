import { describe, expect, it } from 'vitest';

import type { DataExportProjection } from '@/lib/api';

import { presentDataExports } from './data-export-state';

const NOW = new Date('2026-09-20T12:00:00Z');

function projection(overrides: Partial<DataExportProjection>): DataExportProjection {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'queued',
    created_at: '2026-09-20T11:00:00Z',
    ready_at: null,
    expires_at: null,
    downloaded_at: null,
    purged_at: null,
    ...overrides,
  };
}

describe('presentDataExports', () => {
  it('has nothing to show without an export', () => {
    expect(presentDataExports([], NOW)).toEqual({ kind: 'none' });
  });

  it.each(['queued', 'building'] as const)('shows %s as preparing, never as failed', (status) => {
    expect(presentDataExports([projection({ status })], NOW).kind).toBe('preparing');
  });

  it('shows a valid ready export with its absolute deadline', () => {
    const view = presentDataExports(
      [
        projection({
          status: 'ready',
          ready_at: '2026-09-20T11:30:00Z',
          expires_at: '2026-09-21T11:30:00Z',
        }),
      ],
      NOW,
    );
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready')
      expect(view.expiresAt.toISOString()).toBe('2026-09-21T11:30:00.000Z');
  });

  it('shows a ready export past its deadline as expired without a new request slot', () => {
    expect(
      presentDataExports(
        [
          projection({
            status: 'ready',
            ready_at: '2026-09-19T11:30:00Z',
            expires_at: '2026-09-20T11:30:00Z',
          }),
        ],
        NOW,
      ),
    ).toMatchObject({ kind: 'expired', canRequest: false });
  });

  it('offers a new export once the row is expired', () => {
    expect(
      presentDataExports(
        [projection({ status: 'expired', purged_at: '2026-09-20T11:59:00Z' })],
        NOW,
      ),
    ).toMatchObject({ kind: 'expired', canRequest: true });
  });

  it.each(['downloaded', 'cleanup_pending'] as const)(
    'never shows %s as expired: the one-shot was consumed',
    (status) => {
      const awaitingPurge = presentDataExports([projection({ status })], NOW);
      expect(awaitingPurge).toMatchObject({ kind: 'consumed', canRequest: false });
      const purged = presentDataExports(
        [projection({ status, purged_at: '2026-09-20T11:59:00Z' })],
        NOW,
      );
      expect(purged).toMatchObject({ kind: 'consumed', canRequest: true });
    },
  );

  it('never hides failed as preparing and flags a repeated failure', () => {
    const once = presentDataExports([projection({ status: 'failed' })], NOW);
    expect(once).toMatchObject({ kind: 'failed', repeated: false });
    const twice = presentDataExports(
      [
        projection({ status: 'failed', created_at: '2026-09-20T11:00:00Z' }),
        projection({
          id: '22222222-2222-4222-8222-222222222222',
          status: 'failed',
          created_at: '2026-09-19T11:00:00Z',
        }),
      ],
      NOW,
    );
    expect(twice).toMatchObject({ kind: 'failed', repeated: true });
  });

  it('decides from the newest export regardless of input order', () => {
    const view = presentDataExports(
      [
        projection({ status: 'expired', created_at: '2026-09-18T11:00:00Z', purged_at: 'x' }),
        projection({
          id: '22222222-2222-4222-8222-222222222222',
          status: 'building',
          created_at: '2026-09-20T11:00:00Z',
        }),
      ],
      NOW,
    );
    expect(view.kind).toBe('preparing');
  });
});
