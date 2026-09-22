import type { DataExportProjection } from '@/lib/api';

// The presentation contract of docs/22 section 6 for "Baixar meus dados". It
// is derived only from the owner projection, never from an optimistic guess:
// `downloaded|cleanup_pending` is a consumed one-shot and is never shown as
// expired, and `failed` is never hidden as preparing.
export type DataExportView =
  | { kind: 'none' }
  | { kind: 'preparing'; export: DataExportProjection }
  | { kind: 'ready'; export: DataExportProjection; expiresAt: Date }
  | { kind: 'expired'; export: DataExportProjection; canRequest: boolean }
  | { kind: 'consumed'; export: DataExportProjection; canRequest: boolean }
  | { kind: 'failed'; export: DataExportProjection; repeated: boolean };

function newestFirst(exports: readonly DataExportProjection[]): DataExportProjection[] {
  return [...exports].sort((left, right) => {
    const byInstant = right.created_at.localeCompare(left.created_at);
    return byInstant !== 0 ? byInstant : right.id.localeCompare(left.id);
  });
}

export function presentDataExports(
  exports: readonly DataExportProjection[],
  now: Date,
): DataExportView {
  const ordered = newestFirst(exports);
  const latest = ordered[0];
  if (latest === undefined) return { kind: 'none' };

  switch (latest.status) {
    case 'queued':
    case 'building':
      return { kind: 'preparing', export: latest };
    case 'ready': {
      const expiresAt = latest.expires_at === null ? null : new Date(latest.expires_at);
      if (expiresAt !== null && expiresAt.getTime() > now.getTime()) {
        return { kind: 'ready', export: latest, expiresAt };
      }
      // Past its deadline but not yet swept: the hourly job will move it to
      // cleanup_pending and then expired. Until then the active slot is taken.
      return { kind: 'expired', export: latest, canRequest: false };
    }
    case 'expired':
      return { kind: 'expired', export: latest, canRequest: true };
    case 'downloaded':
    case 'cleanup_pending':
      return { kind: 'consumed', export: latest, canRequest: latest.purged_at !== null };
    case 'failed':
      return {
        kind: 'failed',
        export: latest,
        repeated: ordered.filter((candidate) => candidate.status === 'failed').length >= 2,
      };
  }
}

export function formatAbsoluteInstant(value: Date | string): string {
  const instant = typeof value === 'string' ? new Date(value) : value;
  return instant.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
