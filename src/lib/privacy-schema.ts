import { z } from './zod';

// The two owner projections published by 0012 and 0013. They are the only
// privacy reads the client has; neither carries a Storage path, a digest, an
// Auth identifier, an attempt counter or an internal error code, and a row that
// tried to would be refused here before it reached a screen.

export const dataExportStatuses = [
  'queued',
  'building',
  'ready',
  'downloaded',
  'cleanup_pending',
  'expired',
  'failed',
] as const;

export type DataExportStatus = (typeof dataExportStatuses)[number];

export const dataExportProjectionSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(dataExportStatuses),
    created_at: z.string(),
    ready_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    downloaded_at: z.string().nullable(),
    purged_at: z.string().nullable(),
  })
  .strict();

export type DataExportProjection = z.output<typeof dataExportProjectionSchema>;

export const deletionRequestStatuses = [
  'requested',
  'cleaning_storage',
  'deleting_auth',
  'finalizing',
  'failed_retryable',
  'completed',
] as const;

export type DeletionRequestStatus = (typeof deletionRequestStatuses)[number];

export const deletionRequestProjectionSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(deletionRequestStatuses),
    requested_at: z.string(),
    completed_at: z.string().nullable(),
    has_operational_failure: z.boolean(),
  })
  .strict();

export type DeletionRequestProjection = z.output<typeof deletionRequestProjectionSchema>;
